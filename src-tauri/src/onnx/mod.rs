/// ONNX Runtime 模块（主进程侧）
///
/// # v2 架构：子进程隔离
/// - 所有 ONNX 推理在独立的 `--onnx-worker` 子进程中执行
/// - 主进程永不触碰 DirectML / Session 初始化
/// - 首次使用自动探测 GPU 能力（探针推理），结果缓存到 `onnx_gpu_config.json`
/// - DirectML 失败自动回退 CPU，对前端透明
///
/// 子模块：
/// - `worker` — Worker 子进程（probe / upscale / matting 三种推理）
/// - `gpu`   — DXGI 适配器枚举 + DirectML 探针
/// - `config` — GPU 配置缓存（ep / device_id / device_name）

pub mod worker;
mod gpu;
mod config;

use config::OnnxGpuConfig;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use tauri::Emitter;

// ── 模型目录解析 ──

/// 模型目录解析策略：
///  1. `current_exe()/models` 目录 — 安装目录下，与 exe 同级
///  2. 回退到 `%LOCALAPPDATA%/com.aicanvas.app/models`
pub fn models_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {e}"))?;
    let parent = exe.parent().ok_or("无法解析安装目录".to_string())?;
    let install_models = parent.join("models");

    if is_dir_writable(&install_models) {
        return Ok(install_models);
    }

    let app_data = app_data_models_dir()?;
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("创建 AppData 模型目录失败: {e}"))?;
    Ok(app_data)
}

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

// ── Tauri 命令：查询 / 下载 ──

#[tauri::command]
pub fn check_model_exists(model_name: String) -> Result<bool, String> {
    let models = models_dir()?;
    Ok(models.join(&model_name).is_file())
}

#[tauri::command]
pub fn get_models_dir() -> Result<String, String> {
    let dir = models_dir()?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn download_onnx_model(model_name: String, url: String) -> Result<String, String> {
    let models = models_dir()?;
    std::fs::create_dir_all(&models)
        .map_err(|e| format!("创建模型目录失败: {e}"))?;

    let dest = models.join(&model_name);

    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.len() > 0 {
            let j = json!({
                "path": dest.to_string_lossy(),
                "size_bytes": meta.len(),
                "cached": true,
            });
            return Ok(j.to_string());
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

    if content_length > 0 && bytes.len() as u64 != content_length {
        return Err(format!(
            "下载不完整: 期望 {} 字节，实际 {} 字节",
            content_length,
            bytes.len()
        ));
    }

    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("保存模型文件失败: {e}"))?;

    let j = json!({
        "path": dest.to_string_lossy(),
        "size_bytes": bytes.len(),
        "cached": false,
    });
    Ok(j.to_string())
}

// ── Tauri 命令：GPU 状态查询 ──

#[tauri::command]
pub fn get_onnx_gpu_status() -> Result<String, String> {
    let config = OnnxGpuConfig::get_or_default();
    let j = json!({
        "ep": config.ep,
        "device_name": config.device_name,
        "probed_at": config.probed_at,
    });
    Ok(j.to_string())
}

// ════════════════════════════════════════════════
// Worker 进程管理
// ════════════════════════════════════════════════

struct WorkerSession {
    child: Child,
    stdin: std::process::ChildStdin,
    rx: mpsc::Receiver<Value>,
    timeout: Duration,
}

impl WorkerSession {
    fn start(request: &Value, timeout_secs: u64) -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {e}"))?;

        let mut child = Command::new(&exe)
            .arg("--onnx-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("启动 ONNX worker 失败: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or("无法获取 worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or("无法获取 worker stdout".to_string())?;

        let (tx, rx) = mpsc::channel::<Value>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });

        let mut session = Self {
            child,
            stdin,
            rx,
            timeout: Duration::from_secs(timeout_secs),
        };

        session.send(request)?;
        Ok(session)
    }

    fn send(&mut self, request: &Value) -> Result<(), String> {
        let s = serde_json::to_string(request).map_err(|e| format!("JSON 序列化失败: {e}"))?;
        writeln!(self.stdin, "{}", s).map_err(|e| format!("写入 worker stdin 失败: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush worker stdin 失败: {e}"))?;
        Ok(())
    }

    fn read_one_skip_ready(&self) -> Result<Value, String> {
        loop {
            let v = self
                .rx
                .recv_timeout(self.timeout)
                .map_err(|_| {
                    let _ = kill_child(&self.child);
                    format!(
                        "ONNX worker 无响应（{} 秒超时），进程可能已崩溃",
                        self.timeout.as_secs()
                    )
                })?;

            if v.get("type").and_then(|t| t.as_str()) == Some("ready") {
                continue;
            }
            return Ok(v);
        }
    }

    fn read_until_done(
        &self,
        mut on_progress: impl FnMut(u32, u32),
    ) -> Result<Value, String> {
        loop {
            let v = self.read_one_skip_ready()?;
            let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match t {
                "ok" | "error" => return Ok(v),
                "progress" => {
                    let done = v.get("done").and_then(|d| d.as_u64()).unwrap_or(0) as u32;
                    let total = v.get("total").and_then(|d| d.as_u64()).unwrap_or(0) as u32;
                    on_progress(done, total);
                }
                _ => {}
            }
        }
    }
}

impl Drop for WorkerSession {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, r#"{{"type":"quit"}}"#);
        let _ = self.stdin.flush();
        std::thread::sleep(Duration::from_millis(500));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn kill_child(child: &Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID"])
            .arg(child.id().to_string())
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let pid = child.id();
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

// ════════════════════════════════════════════════
// GPU 探针
// ════════════════════════════════════════════════

async fn probe_gpu(model_path: &Path) -> Result<OnnxGpuConfig, String> {
    let request = json!({
        "id": "probe-1",
        "type": "probe",
        "model_path": model_path.to_string_lossy()
    });

    let session = WorkerSession::start(&request, 60)?;
    let resp = match session.read_one_skip_ready() {
        Ok(v) => v,
        Err(e) => {
            // 保存 CPU 配置避免下次再探
            let config = OnnxGpuConfig {
                ep: "cpu".to_string(),
                device_id: None,
                device_name: None,
                probed_at: Some(chrono_now()),
            };
            let _ = config.save();
            return Err(e);
        }
    };

    let resp_type = resp
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match resp_type {
        "ok" => {
            let result = resp.get("result").ok_or("探针响应缺少 result 字段")?;
            let gpu_supported = result
                .get("gpu_supported")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if gpu_supported {
                let device_id = result
                    .get("device_id")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as i32);
                let device_name = result
                    .get("device_name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let vram_mb = result
                    .get("vram_mb")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                eprintln!(
                    "[onnxrt] GPU 探针成功: {} (device_id={:?}, VRAM={} MB)",
                    device_name.as_deref().unwrap_or("?"),
                    device_id,
                    vram_mb
                );

                Ok(OnnxGpuConfig {
                    ep: "directml".to_string(),
                    device_id,
                    device_name,
                    probed_at: Some(chrono_now()),
                })
            } else {
                eprintln!("[onnxrt] GPU 探针: 无可用的 DirectML GPU");
                Ok(OnnxGpuConfig {
                    ep: "cpu".to_string(),
                    device_id: None,
                    device_name: None,
                    probed_at: Some(chrono_now()),
                })
            }
        }
        "error" => {
            let err = resp
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            eprintln!("[onnxrt] GPU 探针失败: {err}");
            let config = OnnxGpuConfig {
                ep: "cpu".to_string(),
                device_id: None,
                device_name: None,
                probed_at: Some(chrono_now()),
            };
            let _ = config.save();
            Ok(config)
        }
        _ => Err(format!("探针 Worker 返回意外响应类型: {resp_type}")),
    }
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("t:{secs}")
}

// ════════════════════════════════════════════════
// 获取或初始化 GPU 配置（供多个命令复用）
// ════════════════════════════════════════════════

async fn get_or_probe_gpu_config(model_path: &Path) -> OnnxGpuConfig {
    let mut config = OnnxGpuConfig::get_or_default();
    if config.probed_at.is_none() {
        eprintln!("[onnxrt] 首次使用，开始 GPU 能力探测...");
        match probe_gpu(model_path).await {
            Ok(cfg) => {
                let _ = cfg.save();
                config = cfg;
            }
            Err(e) => {
                eprintln!("[onnxrt] GPU 探针异常: {e} → 回退 CPU");
                config = OnnxGpuConfig {
                    ep: "cpu".to_string(),
                    device_id: None,
                    device_name: None,
                    probed_at: Some(chrono_now()),
                };
                let _ = config.save();
            }
        }
    }
    config
}

// ════════════════════════════════════════════════
// 通用 Worker 推理执行
// ════════════════════════════════════════════════

/// 在 Worker 中执行推理，返回 (result_json, success)。success=false 表示需回退重试
async fn run_in_worker(
    app: &tauri::AppHandle,
    config: &OnnxGpuConfig,
    request_type: &str,
    model_path: &Path,
    extra: &Value,
    task_id: &str,
    progress_event: Option<&str>,
    timeout_secs: u64,
) -> Result<Value, (bool, String)> {
    let mut request = json!({
        "id": task_id,
        "type": request_type,
        "ep": config.ep,
        "model_path": model_path.to_string_lossy(),
    });

    // 合并额外参数
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            request[k] = v.clone();
        }
    }

    if config.ep == "directml" {
        if let Some(did) = config.device_id {
            request["device_id"] = json!(did);
        }
    }

    eprintln!(
        "[onnxrt] 启动 Worker {request_type} (EP={}, device_id={:?})",
        config.ep, config.device_id
    );

    let session = match WorkerSession::start(&request, timeout_secs) {
        Ok(s) => s,
        Err(e) => return Err((false, e)),
    };

    let app_handle = app.clone();
    let tid = task_id.to_string();
    let evt = progress_event.map(|s| s.to_string());

    let resp = session.read_until_done(move |done, total| {
        let percent = if total > 0 { done * 100 / total } else { 0 };
        if let Some(ref evt_name) = evt {
            let _ = app_handle.emit(
                evt_name,
                json!({"taskId": tid, "done": done, "total": total, "percent": percent}),
            );
        }
    });

    match resp {
        Ok(v) => {
            let t = v.get("type").and_then(|s| s.as_str()).unwrap_or("");
            match t {
                "ok" => Ok(v),
                "error" => {
                    let err = v.get("error").and_then(|s| s.as_str()).unwrap_or("Worker 返回未知错误");
                    Err((true, format!("{request_type} 推理失败: {err}")))
                }
                _ => Err((false, format!("Worker 返回意外响应类型: {t}"))),
            }
        }
        Err(e) => Err((true, e)),
    }
}

// ════════════════════════════════════════════════
// Tauri 命令：图像超分
// ════════════════════════════════════════════════

#[tauri::command]
pub async fn image_upscale(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    model_name: String,
    task_id: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.is_file() {
        return Err(format!("输入文件不存在: {input_path}"));
    }

    let models = models_dir()?;
    let model_path = models.join(&model_name);
    if !model_path.is_file() {
        return Err(format!(
            "模型文件不存在: {}\n请将 .onnx 模型放入: {}",
            model_name,
            models.display()
        ));
    }

    let mut config = get_or_probe_gpu_config(&model_path).await;

    let extra = json!({
        "input_path": input_path,
        "output_path": output_path,
    });

    match run_in_worker(
        &app, &config, "upscale", &model_path, &extra, &task_id,
        Some("image-upscale-progress"), 300,
    ).await {
        Ok(v) => {
            let result = v.get("result").ok_or("超分响应缺少 result 字段")?;
            let input_size = result.get("input_size").and_then(|s| s.as_str()).unwrap_or("?x?");
            let output_size = result.get("output_size").and_then(|s| s.as_str()).unwrap_or("?x?");
            let j = json!({
                "output_path": output_path,
                "input_size": input_size,
                "output_size": output_size,
            });
            Ok(j.to_string())
        }
        Err((is_worker_err, e)) => {
            if is_worker_err && config.ep == "directml" {
                eprintln!("[onnxrt] DirectML Worker 失败: {e} → 标记 CPU 并重试");
                config.ep = "cpu".to_string();
                config.device_id = None;
                config.device_name = None;
                let _ = config.save();

                match run_in_worker(
                    &app, &config, "upscale", &model_path, &extra, &task_id,
                    Some("image-upscale-progress"), 300,
                ).await {
                    Ok(v) => {
                        let result = v.get("result").ok_or("超分响应缺少 result 字段")?;
                        let j = json!({
                            "output_path": output_path,
                            "input_size": result.get("input_size").and_then(|s| s.as_str()).unwrap_or("?x?"),
                            "output_size": result.get("output_size").and_then(|s| s.as_str()).unwrap_or("?x?"),
                        });
                        Ok(j.to_string())
                    }
                    Err((_, e2)) => Err(e2),
                }
            } else {
                Err(e)
            }
        }
    }
}

// ════════════════════════════════════════════════
// Tauri 命令：主体识别（背景移除 / Matting）
// ════════════════════════════════════════════════

/// 主体识别：使用 RMBG-1.4 ONNX 模型识别图像主体，生成 alpha mask
///
/// 流程与超分完全一致：探测 → 缓存 → Worker 推理 → DirectML 失败回退 CPU
#[tauri::command]
pub async fn subject_matting(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    model_name: String,
    task_id: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.is_file() {
        return Err(format!("输入文件不存在: {input_path}"));
    }

    let models = models_dir()?;
    let model_path = models.join(&model_name);
    if !model_path.is_file() {
        return Err(format!(
            "模型文件不存在: {}\n请将 .onnx 模型放入: {}",
            model_name,
            models.display()
        ));
    }

    let mut config = get_or_probe_gpu_config(&model_path).await;

    let extra = json!({
        "input_path": input_path,
        "output_path": output_path,
    });

    match run_in_worker(
        &app, &config, "matting", &model_path, &extra, &task_id,
        None, // matting 无需进度（单次推理，很快）
        120,
    ).await {
        Ok(v) => {
            let result = v.get("result").ok_or("主体识别响应缺少 result 字段")?;
            let subject_path = result.get("subject_path").and_then(|s| s.as_str()).unwrap_or(&output_path);
            let input_size = result.get("input_size").and_then(|s| s.as_str()).unwrap_or("?x?");
            let j = json!({
                "subject_path": subject_path,
                "input_size": input_size,
            });
            Ok(j.to_string())
        }
        Err((is_worker_err, e)) => {
            if is_worker_err && config.ep == "directml" {
                eprintln!("[onnxrt] DirectML Matting Worker 失败: {e} → 标记 CPU 并重试");
                config.ep = "cpu".to_string();
                config.device_id = None;
                config.device_name = None;
                let _ = config.save();

                match run_in_worker(
                    &app, &config, "matting", &model_path, &extra, &task_id,
                    None, 120,
                ).await {
                    Ok(v) => {
                        let result = v.get("result").ok_or("主体识别响应缺少 result 字段")?;
                        let subject_path = result.get("subject_path").and_then(|s| s.as_str()).unwrap_or(&output_path);
                        let j = json!({
                            "subject_path": subject_path,
                            "input_size": result.get("input_size").and_then(|s| s.as_str()).unwrap_or("?x?"),
                        });
                        Ok(j.to_string())
                    }
                    Err((_, e2)) => Err(e2),
                }
            } else {
                Err(e)
            }
        }
    }
}

// ════════════════════════════════════════════════
// Tauri 命令：角色 8 向图自动拆分
// ════════════════════════════════════════════════

const DIRECTION_CELL_SIZE: u32 = 512;
const DIRECTION_SUBJECT_MAX_SIZE: u32 = 448;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectionPlacement {
    source_index: usize,
    target_row: u32,
    target_col: u32,
    mirror: bool,
}

// 源图按 2 列 × 3 行、行优先编号：
// 0=参考图，1=右侧，2=正面，3=背面，4=右下，5=左上。
// 中心格保留参考图；其余三个缺失方向由水平镜像补齐。
const DIRECTION_PLACEMENTS: [DirectionPlacement; 9] = [
    DirectionPlacement {
        source_index: 5,
        target_row: 0,
        target_col: 0,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 3,
        target_row: 0,
        target_col: 1,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 5,
        target_row: 0,
        target_col: 2,
        mirror: true,
    },
    DirectionPlacement {
        source_index: 1,
        target_row: 1,
        target_col: 0,
        mirror: true,
    },
    DirectionPlacement {
        source_index: 0,
        target_row: 1,
        target_col: 1,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 1,
        target_row: 1,
        target_col: 2,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 4,
        target_row: 2,
        target_col: 0,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 2,
        target_row: 2,
        target_col: 1,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 4,
        target_row: 2,
        target_col: 2,
        mirror: true,
    },
];

fn unique_sibling_png(input: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = input.parent().ok_or("无法解析输入图片目录".to_string())?;
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");

    for index in 0..10_000u32 {
        let numbered = if index == 0 {
            format!("{stem}_{suffix}.png")
        } else {
            format!("{stem}_{suffix}_{index}.png")
        };
        let candidate = parent.join(numbered);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("无法为 8 向图生成不冲突的输出文件名".to_string())
}

fn alpha_bounds(image: &image::RgbaImage) -> Option<(u32, u32, u32, u32)> {
    let mut min_x = image.width();
    let mut min_y = image.height();
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;

    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] == 0 {
            continue;
        }
        found = true;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }

    found.then_some((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
}

fn normalize_direction_cell(
    subject: &image::RgbaImage,
    source_index: usize,
) -> Result<image::RgbaImage, String> {
    let source_row = source_index / 2;
    let source_col = source_index % 2;
    let x0 = source_col as u32 * subject.width() / 2;
    let x1 = (source_col as u32 + 1) * subject.width() / 2;
    let y0 = source_row as u32 * subject.height() / 3;
    let y1 = (source_row as u32 + 1) * subject.height() / 3;
    let cell_width = x1.saturating_sub(x0);
    let cell_height = y1.saturating_sub(y0);
    let inset = (cell_width.min(cell_height) / 128).max(2);

    if cell_width <= inset * 2 || cell_height <= inset * 2 {
        return Err(format!("源图第 {} 块尺寸过小", source_index + 1));
    }

    let cell = image::imageops::crop_imm(
        subject,
        x0 + inset,
        y0 + inset,
        cell_width - inset * 2,
        cell_height - inset * 2,
    )
    .to_image();
    let (trim_x, trim_y, trim_width, trim_height) =
        alpha_bounds(&cell).ok_or_else(|| format!("源图第 {} 块未识别到主体", source_index + 1))?;
    let trimmed =
        image::imageops::crop_imm(&cell, trim_x, trim_y, trim_width, trim_height).to_image();

    let longest = trim_width.max(trim_height) as f64;
    let scale = DIRECTION_SUBJECT_MAX_SIZE as f64 / longest;
    let target_width = ((trim_width as f64 * scale).round() as u32).max(1);
    let target_height = ((trim_height as f64 * scale).round() as u32).max(1);
    Ok(image::imageops::resize(
        &trimmed,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    ))
}

fn compose_character_direction_grid_image(
    subject: &image::RgbaImage,
) -> Result<image::RgbaImage, String> {
    if subject.width() < 4 || subject.height() < 6 {
        return Err("8 向图源图片尺寸不足，无法按 2×3 拆分".to_string());
    }

    let sprites = (0..6)
        .map(|source_index| normalize_direction_cell(subject, source_index))
        .collect::<Result<Vec<_>, _>>()?;
    let grid_size = DIRECTION_CELL_SIZE * 3;
    let mut grid = image::RgbaImage::new(grid_size, grid_size);

    for placement in DIRECTION_PLACEMENTS {
        let source = &sprites[placement.source_index];
        let mirrored;
        let sprite = if placement.mirror {
            mirrored = image::imageops::flip_horizontal(source);
            &mirrored
        } else {
            source
        };
        let cell_x = placement.target_col * DIRECTION_CELL_SIZE;
        let cell_y = placement.target_row * DIRECTION_CELL_SIZE;
        let x = cell_x + (DIRECTION_CELL_SIZE - sprite.width()) / 2;
        let y = cell_y + (DIRECTION_CELL_SIZE - sprite.height()) / 2;
        image::imageops::overlay(&mut grid, sprite, i64::from(x), i64::from(y));
    }

    Ok(grid)
}

fn compose_character_direction_grid(subject_path: &Path, output_path: &Path) -> Result<(), String> {
    let subject = image::open(subject_path)
        .map_err(|error| format!("读取主体识别结果失败: {error}"))?
        .to_rgba8();
    let grid = compose_character_direction_grid_image(&subject)?;
    grid.save(output_path)
        .map_err(|error| format!("保存角色 8 向宫格失败: {error}"))
}

/// 对 2×3 角色视图执行主体识别，生成由 9 个 512×512 单元组成的透明宫格图。
#[tauri::command]
pub async fn character_direction_grid(
    app: tauri::AppHandle,
    input_path: String,
    model_name: String,
    task_id: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.is_file() {
        return Err(format!("输入文件不存在: {input_path}"));
    }

    let subject_path = unique_sibling_png(&input, "8dir_subject_temp")?;
    let output_path = unique_sibling_png(&input, "8dir_grid")?;
    let subject_path_string = subject_path.to_string_lossy().into_owned();
    let matting_task_id = format!("{task_id}-matting");

    if let Err(error) = subject_matting(
        app,
        input_path,
        subject_path_string,
        model_name,
        matting_task_id,
    )
    .await
    {
        let _ = std::fs::remove_file(&subject_path);
        return Err(error);
    }

    let compose_result = compose_character_direction_grid(&subject_path, &output_path);
    let _ = std::fs::remove_file(&subject_path);
    compose_result?;

    Ok(json!({
        "grid_path": output_path.to_string_lossy(),
        "cell_size": DIRECTION_CELL_SIZE,
        "grid_size": DIRECTION_CELL_SIZE * 3,
    })
    .to_string())
}

#[cfg(test)]
mod direction_grid_tests {
    use super::*;

    #[test]
    fn direction_mapping_matches_confirmed_layout() {
        let source_indices = DIRECTION_PLACEMENTS.map(|placement| placement.source_index);
        let mirror_flags = DIRECTION_PLACEMENTS.map(|placement| placement.mirror);

        assert_eq!(source_indices, [5, 3, 5, 1, 0, 1, 4, 2, 4]);
        assert_eq!(
            mirror_flags,
            [false, false, true, true, false, false, false, false, true]
        );
    }

    #[test]
    fn composition_creates_three_by_three_transparent_grid() {
        let mut subject = image::RgbaImage::new(200, 300);
        let colors = [
            [220, 20, 20, 255],
            [20, 220, 20, 255],
            [20, 20, 220, 255],
            [220, 220, 20, 255],
            [220, 20, 220, 255],
            [20, 220, 220, 255],
        ];

        for (source_index, color) in colors.into_iter().enumerate() {
            let row = source_index / 2;
            let col = source_index % 2;
            for y in (row as u32 * 100 + 20)..(row as u32 * 100 + 80) {
                for x in (col as u32 * 100 + 20)..(col as u32 * 100 + 80) {
                    subject.put_pixel(x, y, image::Rgba(color));
                }
            }
        }

        let grid = compose_character_direction_grid_image(&subject).expect("应成功合成宫格");
        assert_eq!(grid.dimensions(), (1536, 1536));
        assert_eq!(grid.get_pixel(0, 0)[3], 0);

        let expected_sources = [5usize, 3, 5, 1, 0, 1, 4, 2, 4];
        for (target_index, source_index) in expected_sources.into_iter().enumerate() {
            let row = target_index / 3;
            let col = target_index % 3;
            let pixel = grid.get_pixel(col as u32 * 512 + 256, row as u32 * 512 + 256);
            assert_eq!(pixel.0, colors[source_index]);
        }
    }
}
