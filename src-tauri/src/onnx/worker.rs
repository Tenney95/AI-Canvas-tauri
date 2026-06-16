/// ONNX Worker 进程（通过 `--onnx-worker` CLI 参数进入）
///
/// # 职责
/// - 对主进程完全隔离：即使 DirectML 初始化驱动级死锁，也只杀死本进程
/// - stdin/stdout JSON lines 协议与主进程通信
/// - 处理四类请求：probe（GPU 探测）、upscale（超分）、matting（主体识别）、quit（退出）

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

mod gpu {
    pub use super::super::gpu::*;
}

/// Worker 入口
pub fn run() {
    println!(
        "{}",
        json!({"type":"ready","version":env!("CARGO_PKG_VERSION")})
    );

    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l.trim().to_string(),
            Err(e) => {
                eprintln!("[onnx-worker] stdin 错误: {e}");
                break;
            }
        };
        if line.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(&json!({"type":"error","error":format!("无效 JSON: {e}")}));
                continue;
            }
        };

        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let req_type = request.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match req_type {
            "probe" => handle_probe(&request, &id),
            "upscale" => handle_upscale(&request, &id),
            "matting" => handle_matting(&request, &id),
            "quit" => {
                emit(&json!({"type":"ok","id":id,"result":"bye"}));
                break;
            }
            _ => {
                emit(&json!({"id":id,"type":"error","error":format!("未知请求类型: {req_type}")}));
            }
        }
        let _ = std::io::stdout().flush();
    }
}

fn emit(v: &Value) {
    println!("{}", v);
}

// ════════════════════════════════════════════════
// Probe handler
// ════════════════════════════════════════════════

fn handle_probe(request: &Value, id: &Value) {
    let model_path = request
        .get("model_path")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mp = Path::new(model_path);

    if !mp.is_file() {
        emit(&json!({"id":id,"type":"error","error":format!("模型文件不存在: {model_path}")}));
        return;
    }

    // 1. 枚举 GPU
    let adapters = gpu::enumerate_adapters();
    eprintln!("[onnx-worker] 探测到 {} 个 DXGI 适配器", adapters.len());
    for a in &adapters {
        eprintln!(
            "[onnx-worker]   [{}] {} (VRAM: {} MB, software: {})",
            a.device_id, a.name, a.dedicated_vram_mb, a.is_software
        );
    }

    // 2. 选最佳候选
    let best = match gpu::select_best(&adapters) {
        Some(b) => b.clone(),
        None => {
            eprintln!("[onnx-worker] 未找到合适 GPU，回退 CPU");
            emit(&json!({"id":id,"type":"ok","result":{"gpu_supported":false}}));
            return;
        }
    };

    eprintln!(
        "[onnx-worker] 选中适配器: {} (device_id={})，开始探针推理...",
        best.name, best.device_id
    );

    // 3. 探针推理
    match gpu::probe_directml(mp, best.device_id as i32) {
        Ok(()) => {
            emit(&json!({
                "id": id,
                "type": "ok",
                "result": {
                    "gpu_supported": true,
                    "device_id": best.device_id,
                    "device_name": best.name,
                    "vram_mb": best.dedicated_vram_mb
                }
            }));
            eprintln!(
                "[onnx-worker] DirectML 探针成功！{} (id={})",
                best.name, best.device_id
            );
        }
        Err(e) => {
            eprintln!("[onnx-worker] DirectML 探针失败: {e} → 回退 CPU");
            emit(&json!({
                "id": id,
                "type": "ok",
                "result": {
                    "gpu_supported": false,
                    "error": e
                }
            }));
        }
    }
}

// ════════════════════════════════════════════════
// Upscale handler（分块超分）
// ════════════════════════════════════════════════

const TILE: u32 = 64;
const PAD: u32 = 8;
const STEP: u32 = TILE - 2 * PAD;

fn handle_upscale(request: &Value, id: &Value) {
    let model_path = request.get("model_path").and_then(|v| v.as_str()).unwrap_or("");
    let input_path = request.get("input_path").and_then(|v| v.as_str()).unwrap_or("");
    let output_path = request.get("output_path").and_then(|v| v.as_str()).unwrap_or("");
    let ep = request.get("ep").and_then(|v| v.as_str()).unwrap_or("cpu");
    let device_id: Option<i32> = request.get("device_id").and_then(|v| v.as_i64()).map(|v| v as i32);

    let mp = Path::new(model_path);
    let input = Path::new(input_path);
    let output = Path::new(output_path);

    if !mp.is_file() {
        emit(&json!({"id":id,"type":"error","error":format!("模型文件不存在: {model_path}")}));
        return;
    }
    if !input.is_file() {
        emit(&json!({"id":id,"type":"error","error":format!("输入文件不存在: {input_path}")}));
        return;
    }

    let src_img = match image::open(input) {
        Ok(im) => im.to_rgb8(),
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":format!("读取输入图像失败: {e}")}));
            return;
        }
    };
    let input_dims = src_img.dimensions();

    let session_result = if ep == "directml" {
        create_dml_session(mp, device_id)
    } else {
        create_cpu_session(mp)
    };

    let mut session = match session_result {
        Ok(s) => s,
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":e}));
            return;
        }
    };

    let out_img = match run_upscale_tiled(&mut session, &src_img, id) {
        Ok(im) => im,
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":e}));
            return;
        }
    };

    if let Some(parent) = output.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            emit(&json!({"id":id,"type":"error","error":format!("创建输出目录失败: {e}")}));
            return;
        }
    }
    if let Err(e) = out_img.save(output) {
        emit(&json!({"id":id,"type":"error","error":format!("保存输出图像失败: {e}")}));
        return;
    }

    let out_dims = out_img.dimensions();
    eprintln!(
        "[onnx-worker] 输出已保存: {} ({}x{})",
        output.display(),
        out_dims.0,
        out_dims.1
    );

    emit(&json!({
        "id": id,
        "type": "ok",
        "result": {
            "input_size": format!("{}x{}", input_dims.0, input_dims.1),
            "output_size": format!("{}x{}", out_dims.0, out_dims.1)
        }
    }));
}

fn create_cpu_session(model_path: &Path) -> Result<ort::session::Session, String> {
    let t0 = std::time::Instant::now();
    eprintln!("[onnx-worker] 创建 CPU Session: {}", model_path.display());
    let session = ort::session::Session::builder()
        .map_err(|e| format!("创建 SessionBuilder 失败: {e}"))?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable)
        .map_err(|e| format!("配置优化级别失败: {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("加载 ONNX 模型失败 (CPU): {e}"))?;
    eprintln!("[onnx-worker] CPU Session 创建完成，耗时 {:?}", t0.elapsed());
    Ok(session)
}

fn create_dml_session(
    model_path: &Path,
    device_id: Option<i32>,
) -> Result<ort::session::Session, String> {
    let t0 = std::time::Instant::now();
    let did = device_id.unwrap_or(0);
    eprintln!(
        "[onnx-worker] 创建 DirectML Session (device_id={}): {}",
        did,
        model_path.display()
    );
    let session = ort::session::Session::builder()
        .map_err(|e| format!("创建 SessionBuilder 失败: {e}"))?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Disable)
        .map_err(|e| format!("配置优化级别失败: {e}"))?
        .with_execution_providers([ort::execution_providers::DirectMLExecutionProvider::default()
            .with_device_id(did)
            .build()])
        .map_err(|e| format!("配置 DirectML EP 失败 (device_id={did}): {e}"))?
        .commit_from_file(model_path)
        .map_err(|e| format!("DirectML Session 创建失败 (device_id={did}): {e}"))?;
    eprintln!(
        "[onnx-worker] DirectML Session 创建完成，耗时 {:?}",
        t0.elapsed()
    );
    Ok(session)
}

// ════════════════════════════════════════════════
// Matting handler（主体识别 / 背景移除）
// ════════════════════════════════════════════════

/// RMBG-1.4 模型固定输入尺寸
const MATTING_INPUT_SIZE: u32 = 1024;

fn handle_matting(request: &Value, id: &Value) {
    let model_path = request.get("model_path").and_then(|v| v.as_str()).unwrap_or("");
    let input_path = request.get("input_path").and_then(|v| v.as_str()).unwrap_or("");
    let output_path = request.get("output_path").and_then(|v| v.as_str()).unwrap_or("");
    let ep = request.get("ep").and_then(|v| v.as_str()).unwrap_or("cpu");
    let device_id: Option<i32> = request.get("device_id").and_then(|v| v.as_i64()).map(|v| v as i32);

    let mp = Path::new(model_path);
    let input = Path::new(input_path);
    let output = Path::new(output_path);

    if !mp.is_file() {
        emit(&json!({"id":id,"type":"error","error":format!("模型文件不存在: {model_path}")}));
        return;
    }
    if !input.is_file() {
        emit(&json!({"id":id,"type":"error","error":format!("输入文件不存在: {input_path}")}));
        return;
    }

    // 1. 读取并记录原图尺寸
    let src_img = match image::open(input) {
        Ok(im) => im.to_rgb8(),
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":format!("读取输入图像失败: {e}")}));
            return;
        }
    };
    let (orig_w, orig_h) = src_img.dimensions();
    eprintln!(
        "[onnx-worker] 主体识别: 原图 {}x{}, 缩放到 {}x{}",
        orig_w, orig_h, MATTING_INPUT_SIZE, MATTING_INPUT_SIZE
    );

    // 2. 缩放到模型输入尺寸 1024×1024
    let resized = image::imageops::resize(
        &src_img,
        MATTING_INPUT_SIZE,
        MATTING_INPUT_SIZE,
        image::imageops::FilterType::Lanczos3,
    );

    // 3. 创建 Session
    let session_result = if ep == "directml" {
        create_dml_session(mp, device_id)
    } else {
        create_cpu_session(mp)
    };
    let mut session = match session_result {
        Ok(s) => s,
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":e}));
            return;
        }
    };

    // 4. 转 NCHW [0,1]
    let in_name = match session.inputs().first() {
        Some(i) => i.name().to_string(),
        None => {
            emit(&json!({"id":id,"type":"error","error":"模型没有输入节点"}));
            return;
        }
    };
    let out_name = match session.outputs().first() {
        Some(o) => o.name().to_string(),
        None => {
            emit(&json!({"id":id,"type":"error","error":"模型没有输出节点"}));
            return;
        }
    };

    let plane = (MATTING_INPUT_SIZE * MATTING_INPUT_SIZE) as usize;
    let mut data = vec![0f32; plane * 3];
    for (i, px) in resized.pixels().enumerate() {
        data[i] = px[0] as f32 / 255.0;
        data[plane + i] = px[1] as f32 / 255.0;
        data[2 * plane + i] = px[2] as f32 / 255.0;
    }
    let shape = vec![1i64, 3, MATTING_INPUT_SIZE as i64, MATTING_INPUT_SIZE as i64];

    let tensor = match ort::value::Tensor::from_array((shape, data)) {
        Ok(t) => t,
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":format!("创建输入 Tensor 失败: {e}")}));
            return;
        }
    };

    // 5. 推理
    let outputs = match session.run(ort::inputs![in_name => tensor]) {
        Ok(o) => o,
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":format!("主体识别推理失败: {e}")}));
            return;
        }
    };

    let val = match outputs.get(&*out_name) {
        Some(v) => v,
        None => {
            emit(&json!({"id":id,"type":"error","error":format!("推理结果缺少输出 '{out_name}'")}));
            return;
        }
    };

    let (oshape, odata) = match val.try_extract_tensor::<f32>() {
        Ok(v) => v,
        Err(e) => {
            emit(&json!({"id":id,"type":"error","error":format!("提取输出 Tensor 失败: {e}")}));
            return;
        }
    };

    // 输出形状: [1, 1, 1024, 1024] — 单通道 alpha mask
    if oshape.len() < 4 {
        emit(&json!({"id":id,"type":"error","error":format!("输出形状异常: {oshape:?}")}));
        return;
    }
    let mask_w = oshape[3] as u32;
    let mask_h = oshape[2] as u32;
    eprintln!(
        "[onnx-worker] 推理完成，mask 尺寸: {}x{}",
        mask_w, mask_h
    );

    // 6. 将 mask 转为灰度图 → 缩放回原图尺寸
    let mut mask_img = image::GrayImage::new(mask_w, mask_h);
    for y in 0..mask_h {
        for x in 0..mask_w {
            let idx = (y * mask_w + x) as usize;
            let v = (odata[idx].clamp(0.0, 1.0) * 255.0).round() as u8;
            mask_img.put_pixel(x, y, image::Luma([v]));
        }
    }

    // 缩放回原图尺寸
    let mask_resized = image::imageops::resize(
        &mask_img,
        orig_w,
        orig_h,
        image::imageops::FilterType::Lanczos3,
    );

    // 7. 合成主体图：原图 × mask → RGBA 透明 PNG
    let mut subject = image::RgbaImage::new(orig_w, orig_h);
    for y in 0..orig_h {
        for x in 0..orig_w {
            let op = src_img.get_pixel(x, y);
            let mp = mask_resized.get_pixel(x, y);
            // mask 灰度值即 alpha，> 128 视为前景
            let alpha = if mp[0] > 128 { 255u8 } else { 0u8 };
            subject.put_pixel(x, y, image::Rgba([op[0], op[1], op[2], alpha]));
        }
    }

    if let Some(parent) = output.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            emit(&json!({"id":id,"type":"error","error":format!("创建输出目录失败: {e}")}));
            return;
        }
    }
    if let Err(e) = subject.save(output) {
        emit(&json!({"id":id,"type":"error","error":format!("保存主体图失败: {e}")}));
        return;
    }

    eprintln!(
        "[onnx-worker] 主体识别完成，主体图已保存: {} ({}x{})",
        output.display(),
        orig_w,
        orig_h
    );

    emit(&json!({
        "id": id,
        "type": "ok",
        "result": {
            "input_size": format!("{}x{}", orig_w, orig_h),
            "output_size": format!("{}x{}", orig_w, orig_h),
            "subject_path": output_path
        }
    }));
}

// ════════════════════════════════════════════════
// 分块超分推理核心
// ════════════════════════════════════════════════

fn tile_to_nchw(tile: &image::RgbImage) -> (Vec<i64>, Vec<f32>) {
    let (w, h) = tile.dimensions();
    let (wu, hu) = (w as usize, h as usize);
    let plane = wu * hu;
    let mut data = vec![0f32; plane * 3];
    for (i, px) in tile.pixels().enumerate() {
        data[i] = px[0] as f32 / 255.0;
        data[plane + i] = px[1] as f32 / 255.0;
        data[2 * plane + i] = px[2] as f32 / 255.0;
    }
    (vec![1, 3, hu as i64, wu as i64], data)
}

#[inline]
fn sample_clamped(src: &image::RgbImage, x: i64, y: i64, w: u32, h: u32) -> image::Rgb<u8> {
    let cx = x.clamp(0, w as i64 - 1) as u32;
    let cy = y.clamp(0, h as i64 - 1) as u32;
    *src.get_pixel(cx, cy)
}

fn run_upscale_tiled(
    session: &mut ort::session::Session,
    src: &image::RgbImage,
    req_id: &Value,
) -> Result<image::RgbImage, String> {
    let (w, h) = src.dimensions();

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

    let mut scale: u32 = 0;
    let mut dst: Option<image::RgbImage> = None;
    let cols = (w + STEP - 1) / STEP;
    let rows = (h + STEP - 1) / STEP;
    let total = cols * rows;
    let log_every = (total / 10).max(1);
    let mut done: u32 = 0;

    let mut y: u32 = 0;
    while y < h {
        let mut x: u32 = 0;
        while x < w {
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
                .run(ort::inputs![in_name.clone() => tensor])
                .map_err(|e| format!("推理执行失败: {e}"))?;

            let val = outputs
                .get(&*out_name)
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
                eprintln!(
                    "[onnx-worker] 放大倍率={scale}x 分块={TILE}px 步进={STEP}px 网格={cols}x{rows}（共 {total} 块）"
                );
                dst = Some(image::RgbImage::new(w * scale, h * scale));
            }

            let out = dst.as_mut().unwrap();
            let plane = (oshape[2] as usize) * (ow as usize);

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
            let percent = if total > 0 { done * 100 / total } else { 0 };
            emit(&json!({
                "id": req_id,
                "type": "progress",
                "done": done,
                "total": total,
                "percent": percent
            }));

            if done == 1 || done == total || done % log_every == 0 {
                eprintln!(
                    "[onnx-worker] 分块进度 {done}/{total}（{}%）",
                    done * 100 / total
                );
            }

            x += STEP;
        }
        y += STEP;
    }

    dst.ok_or_else(|| "无输出（空图像）".to_string())
}
