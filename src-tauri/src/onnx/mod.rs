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
