/// ONNX Runtime + DirectML 模块
/// 负责模型目录解析、Session 懒加载、图像超分 / 抠图推理
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use ort::session::Session;
use tauri::Emitter;

// ── 模型目录解析 ──

/// 模型目录解析策略：
///  1. `current_exe()/models` 目录 — 安装目录下，与 exe 同级（NSIS currentUser 可写）
///  2. 回退到 `%LOCALAPPDATA%/com.aicanvas.app/models`
///
/// 两处均通过写探针验证可写性后再选定。
pub fn models_dir() -> Result<PathBuf, String> {
    // 1. 安装目录优先
    let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {e}"))?;
    let parent = exe.parent().ok_or("无法解析安装目录".to_string())?;
    let install_models = parent.join("models");

    if is_dir_writable(&install_models) {
        return Ok(install_models);
    }

    // 2. 回退到 APPDATA
    let app_data = app_data_models_dir()?;
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("创建 AppData 模型目录失败: {e}"))?;
    Ok(app_data)
}

/// AppData 下的模型目录（回退路径）
fn app_data_models_dir() -> Result<PathBuf, String> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .unwrap_or_default();
    if local_app_data.is_empty() {
        return Err("无法获取系统 APPDATA 路径".to_string());
    }
    Ok(PathBuf::from(local_app_data)
        .join("com.aicanvas.app")
        .join("models"))
}

/// 写探针：在目录中创建临时文件后立即删除，判断目录是否可写
fn is_dir_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write_probe");
    match std::fs::write(&probe, b"1") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// ── Session 懒加载 ──

/// 全局 Session：（模型路径, Session）对，串行推理（Mutex），首次调用或换模型时触发加载
static SESSION: Mutex<Option<(PathBuf, Session)>> = Mutex::new(None);

/// 获取或懒加载 ONNX Session。若已缓存且路径匹配则直接复用，否则重新加载。
///
/// **关键**：使用两阶段锁模式——Session 创建（DirectML 初始化可能很慢/卡死）
/// 在锁外执行，避免长时间持锁导致后续调用全部死锁。
fn get_or_load_session(model_path: &Path) -> Result<(), String> {
    // 阶段 1：快速检查是否已加载（短暂持锁）
    {
        let guard = SESSION.lock().map_err(|e| format!("Session 锁失败: {e}"))?;
        if let Some((cached_path, _)) = guard.as_ref() {
            if cached_path == model_path {
                return Ok(());
            }
        }
    } // 锁在此释放

    // 阶段 2：创建 Session（不持锁，允许其他调用失败/重试）
    // commit_from_file 会触发 DirectML 模型编译，首次调用可能耗时 10-60 秒
    // 仅 CPU EP（DirectML 版 onnxruntime 环境初始化即驱动级死锁，已弃用）
    println!("[onnx] 开始加载 Session（CPU EP）: {}", model_path.display());
    let t0 = std::time::Instant::now();

    let mut builder = Session::builder()
        .map_err(|e| format!("创建 SessionBuilder 失败: {e}"))?
        // 关闭图优化：ORT 的常量折叠/shape 推理在某些模型上会卡死 commit，原样加载最稳
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable)
        .map_err(|e| format!("配置优化级别失败: {e}"))?;

    println!("[onnx] builder 配置完成（CPU, opt=Disable），开始 commit_from_file 加载模型…");
    let session = builder
        .commit_from_file(model_path)
        .map_err(|e| format!("加载 ONNX 模型失败: {e}"))?;
    println!("[onnx] Session 加载完成，耗时 {:?}", t0.elapsed());

    // 阶段 3：存储 Session（短暂持锁，double-check 避免重复加载）
    {
        let mut guard = SESSION.lock().map_err(|e| format!("Session 锁失败: {e}"))?;
        // 双重检查：并发调用可能已经加载了同一个模型
        if let Some((cached_path, _)) = guard.as_ref() {
            if cached_path == model_path {
                return Ok(());
            }
        }
        *guard = Some((model_path.to_path_buf(), session));
    }
    Ok(())
}



// ── 图像推理核心（分块 tiling） ──

/// 模型输入分块边长（像素）。本模型(AXERA realesrgan-x4)输入固定为 64×64 → 输出 256×256。
/// 每块固定 TILE×TILE，与模型固定输入尺寸严格一致。
const TILE: u32 = 64;
/// 每块四周的重叠外扩量。块内中心 STEP 区域用于回写，PAD 提供邻域上下文以消除拼接缝。
const PAD: u32 = 8;
/// 有效步进 = 中心区域边长
const STEP: u32 = TILE - 2 * PAD; // 224

/// 将一块 TILE×TILE 的 RGB 图块转成 planar NCHW f32 [1,3,TILE,TILE]，值域 [0,1]
fn tile_to_nchw(tile: &image::RgbImage) -> (Vec<usize>, Vec<f32>) {
    let (w, h) = tile.dimensions();
    let (wu, hu) = (w as usize, h as usize);
    let plane = wu * hu;
    let mut data = vec![0f32; plane * 3];
    for (i, px) in tile.pixels().enumerate() {
        data[i] = px[0] as f32 / 255.0;             // R 平面
        data[plane + i] = px[1] as f32 / 255.0;     // G 平面
        data[2 * plane + i] = px[2] as f32 / 255.0; // B 平面
    }
    (vec![1, 3, hu, wu], data)
}

/// 钳取采样：越界坐标 clamp 到图像边缘
#[inline]
fn sample_clamped(src: &image::RgbImage, x: i64, y: i64, w: u32, h: u32) -> image::Rgb<u8> {
    let cx = x.clamp(0, w as i64 - 1) as u32;
    let cy = y.clamp(0, h as i64 - 1) as u32;
    *src.get_pixel(cx, cy)
}

/// 分块超分（重叠 PAD）：以 STEP 步进遍历，每块输入固定 TILE×TILE（含四周 PAD 上下文），
/// 仅回写中心 STEP×STEP 区域放大后的像素，从而消除拼接缝。放大倍率由首块推断。
/// 持有 SESSION 锁贯穿整个循环（本就串行推理）。
fn run_upscale_tiled(
    session: &mut Session,
    src: &image::RgbImage,
    in_name: &str,
    out_name: &str,
    on_progress: &dyn Fn(u32, u32),
) -> Result<image::RgbImage, String> {
    let (w, h) = src.dimensions();
    let mut scale: u32 = 0;
    let mut dst: Option<image::RgbImage> = None;
    let cols = (w + STEP - 1) / STEP;
    let rows = (h + STEP - 1) / STEP;
    let total = cols * rows;
    // 日志降噪：仅在约每 10% 进度处打印一次
    let log_every = (total / 10).max(1);
    let mut done = 0u32;

    let mut y = 0u32;
    while y < h {
        let mut x = 0u32;
        while x < w {
            // 输入窗口左上角（向外扩 PAD），用 clamp 采样填满 TILE×TILE
            let ix = x as i64 - PAD as i64;
            let iy = y as i64 - PAD as i64;
            let mut tile = image::RgbImage::new(TILE, TILE);
            for ty in 0..TILE {
                for tx in 0..TILE {
                    let px = sample_clamped(src, ix + tx as i64, iy + ty as i64, w, h);
                    tile.put_pixel(tx, ty, px);
                }
            }

            let (shape, data) = tile_to_nchw(&tile);
            let tensor = ort::value::Tensor::from_array((shape, data))
                .map_err(|e| format!("创建输入 Tensor 失败: {e}"))?;
            let outputs = session
                .run(ort::inputs![in_name.to_string() => tensor])
                .map_err(|e| format!("推理执行失败: {e}"))?;
            let val = outputs
                .get(out_name)
                .ok_or_else(|| format!("推理结果缺少输出 '{out_name}'"))?;
            let (oshape, odata) = val
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("提取输出张量失败: {e}"))?;
            if oshape.len() != 4 || oshape[1] != 3 {
                return Err(format!("输出张量形状异常: {oshape:?}"));
            }
            let ow = oshape[3] as u32;

            if scale == 0 {
                scale = ow / TILE;
                if scale == 0 {
                    return Err(format!("无法推断放大倍率（输出宽 {ow} < 分块 {TILE}）"));
                }
                println!("[onnx] 放大倍率={scale}x 分块={TILE}px 步进={STEP}px 网格={cols}x{rows}（共 {total} 块）");
                dst = Some(image::RgbImage::new(w * scale, h * scale));
            }

            let out = dst.as_mut().unwrap();
            let plane = (oshape[2] as usize) * (ow as usize);
            // 中心有效区域：输入坐标 [x, y, vw, vh]，对应输出块内偏移 PAD*scale
            let vw = STEP.min(w - x);
            let vh = STEP.min(h - y);
            let off = PAD * scale;
            for ry in 0..vh * scale {
                for rx in 0..vw * scale {
                    let idx = ((off + ry) * ow + (off + rx)) as usize;
                    let r = (odata[idx].clamp(0.0, 1.0) * 255.0).round() as u8;
                    let g = (odata[plane + idx].clamp(0.0, 1.0) * 255.0).round() as u8;
                    let b = (odata[2 * plane + idx].clamp(0.0, 1.0) * 255.0).round() as u8;
                    out.put_pixel(x * scale + rx, y * scale + ry, image::Rgb([r, g, b]));
                }
            }

            done += 1;
            on_progress(done, total);
            if done == 1 || done == total || done % log_every == 0 {
                println!("[onnx] 分块进度 {done}/{total}（{}%）", done * 100 / total);
            }
            x += STEP;
        }
        y += STEP;
    }

    dst.ok_or_else(|| "无输出（空图像）".to_string())
}

// ── Tauri 命令 ──

/// 检查指定模型文件是否存在于 models_dir 中
#[tauri::command]
pub fn check_model_exists(model_name: String) -> Result<bool, String> {
    let models = models_dir()?;
    Ok(models.join(&model_name).is_file())
}

/// 查询当前模型目录路径（调试 / UI 展示用）
#[tauri::command]
pub fn get_models_dir() -> Result<String, String> {
    let dir = models_dir()?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 图像超分：加载图像 → ONNX DirectML 推理 → 输出保存
///
/// 参数：
/// - `input_path`:  输入图像路径（支持常见格式：png/jpg/webp/bmp）
/// - `output_path`: 输出图像路径（自动创建父目录）
/// - `model_name`:  模型文件名（如 "realesrgan-x4.onnx"），需放置在 models_dir() 下
///
/// 返回：JSON 字符串 `{"output_path":"...","input_size":"WxH","output_size":"W'xH'"}`
///
/// 推理过程中向前端发送 `image-upscale-progress` 事件：
/// `{ taskId, done, total, percent }`，供节点显示真实进度。
#[tauri::command]
pub async fn image_upscale(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    model_name: String,
    task_id: String,
) -> Result<String, String> {
    // 1. 验证输入文件存在
    let input = PathBuf::from(&input_path);
    if !input.is_file() {
        return Err(format!("输入文件不存在: {input_path}"));
    }

    // 2. 解析模型路径
    let models = models_dir()?;
    let model_path = models.join(&model_name);
    if !model_path.is_file() {
        return Err(format!(
            "模型文件不存在: {}\n请将 .onnx 模型放入: {}",
            model_name,
            models.display()
        ));
    }

    // 3. 预处理：读取输入图像尺寸（在 spawn_blocking 外做轻量操作）
    let input_img = image::open(&input)
        .map_err(|e| format!("无法读取输入图像: {e}"))?;
    let input_dims = (input_img.width(), input_img.height());

    let output = PathBuf::from(&output_path);
    let mp = model_path.clone();

    // 4. 在 spawn_blocking 中执行完整推理管线（避免阻塞 async runtime）
    //    外层加 5 分钟超时，防止 DirectML 无响应时前端永久挂起
    println!("[onnx] image_upscale 调用，输入 {}x{}", input_dims.0, input_dims.1);
    let handle = tokio::task::spawn_blocking(move || -> Result<(u32, u32), String> {
        // 进度回调：向前端发送 image-upscale-progress 事件（节流由前端按整数百分比处理）
        let on_progress = move |done: u32, total: u32| {
            let percent = if total > 0 { done * 100 / total } else { 0 };
            let _ = app.emit(
                "image-upscale-progress",
                serde_json::json!({ "taskId": task_id, "done": done, "total": total, "percent": percent }),
            );
        };

        // 4a. 加载模型（两阶段锁，不会阻塞其他调用）
        get_or_load_session(&mp)?;

        // 4b. 读图为 RGB
        let src = image::open(&input)
            .map_err(|e| format!("无法读取输入图像: {e}"))?
            .to_rgb8();

        // 4c. 锁定 Session，分块推理（持锁贯穿循环，本就串行）
        let out_img = {
            let mut guard = SESSION.lock().map_err(|e| format!("Session 锁失败: {e}"))?;
            let session = guard
                .as_mut()
                .map(|(_, s)| s)
                .ok_or("模型尚未加载".to_string())?;

            let in_name = session
                .inputs()
                .first()
                .map(|i| i.name().to_string())
                .ok_or("模型没有输入节点".to_string())?;
            let out_name = session
                .outputs()
                .first()
                .map(|o| o.name().to_string())
                .ok_or("模型没有输出节点".to_string())?;

            run_upscale_tiled(session, &src, &in_name, &out_name, &on_progress)?
        }; // guard 在此释放

        // 4d. 保存输出
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建输出目录失败: {e}"))?;
        }
        out_img
            .save(&output)
            .map_err(|e| format!("保存输出图像失败: {e}"))?;
        let dims = out_img.dimensions();
        println!("[onnx] 输出已保存: {} ({}x{})", output.display(), dims.0, dims.1);
        Ok(dims)
    });

    let result = tokio::time::timeout(std::time::Duration::from_secs(300), handle)
        .await
        .map_err(|_| "超分推理超时（5 分钟），DirectML 可能不兼容当前 GPU 或模型".to_string())?
        .map_err(|e| format!("推理线程异常: {e}"))??;

    let output_dims = result;

    // 5. 返回结果
    let json = serde_json::json!({
        "output_path": output_path,
        "input_size": format!("{}x{}", input_dims.0, input_dims.1),
        "output_size": format!("{}x{}", output_dims.0, output_dims.1),
    });

    Ok(json.to_string())
}

/// 从指定 URL 下载 ONNX 模型文件到 models_dir
///
/// 参数：
/// - `model_name`: 模型文件名（如 "realesrgan-x4.onnx"）
/// - `url`:        下载地址
///
/// 返回：JSON `{"path":"...","size_bytes":...}`
#[tauri::command]
pub async fn download_onnx_model(model_name: String, url: String) -> Result<String, String> {
    let models = models_dir()?;
    std::fs::create_dir_all(&models)
        .map_err(|e| format!("创建模型目录失败: {e}"))?;

    let dest = models.join(&model_name);

    // 若文件已存在且大小 > 0，跳过下载
    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.len() > 0 {
            let json = serde_json::json!({
                "path": dest.to_string_lossy(),
                "size_bytes": meta.len(),
                "cached": true,
            });
            return Ok(json.to_string());
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("AI-Canvas/0.1")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败: HTTP {status}"));
    }

    // 校验 Content-Type，防止将 HTML 错误页当作模型文件保存
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if content_type.contains("text/html") {
        return Err(format!(
            "下载失败: 服务器返回 HTML 页面而非模型文件（URL 可能已失效）\nURL: {url}"
        ));
    }

    let content_length = response.content_length().unwrap_or(0);

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取下载数据失败: {e}"))?;

    // 校验文件大小（防止下载不完整）
    if content_length > 0 && bytes.len() as u64 != content_length {
        return Err(format!(
            "下载不完整: 期望 {} 字节，实际 {} 字节",
            content_length,
            bytes.len()
        ));
    }

    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("保存模型文件失败: {e}"))?;

    let json = serde_json::json!({
        "path": dest.to_string_lossy(),
        "size_bytes": bytes.len(),
        "cached": false,
    });
    Ok(json.to_string())
}
