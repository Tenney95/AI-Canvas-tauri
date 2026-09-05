//! ONNX Runtime 模块（主进程侧）。
//!
//! # v2 架构：子进程隔离
//! - 所有 ONNX 推理在独立的 `--onnx-worker` 子进程中执行
//! - 主进程永不触碰 DirectML / Session 初始化
//! - 首次使用自动探测 GPU 能力（探针推理），结果缓存到 `onnx_gpu_config.json`
//! - DirectML 失败自动回退 CPU，对前端透明
//!
//! 子模块：
//! - `worker` — Worker 子进程（probe / upscale / matting 三种推理）
//! - `gpu`   — DXGI 适配器枚举 + DirectML 探针
//! - `config` — GPU 配置缓存（ep / device_id / device_name）

mod config;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
mod gpu;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub mod worker;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
mod asr;

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub mod worker {
    use serde_json::{json, Value};
    use std::io::{BufRead, Write};

    const UNSUPPORTED_MESSAGE: &str = "Intel macOS 版本不支持本地 ONNX Runtime";

    pub fn run() {
        println!(
            "{}",
            json!({"type":"ready","version":env!("CARGO_PKG_VERSION")})
        );

        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                println!("{}", json!({"type":"error","error":"无效 JSON"}));
                continue;
            };
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            if request.get("type").and_then(Value::as_str) == Some("quit") {
                println!("{}", json!({"id":id,"type":"ok","result":"bye"}));
                break;
            }
            println!(
                "{}",
                json!({"id":id,"type":"error","error":UNSUPPORTED_MESSAGE})
            );
            let _ = std::io::stdout().flush();
        }
    }
}

use config::OnnxGpuConfig;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;

const MAX_ONNX_MODEL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const WORKER_EXIT_GRACE: Duration = Duration::from_millis(500);
const WORKER_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

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
    std::fs::create_dir_all(&app_data).map_err(|e| format!("创建 AppData 模型目录失败: {e}"))?;
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

/// 除 `.onnx` 之外允许下载的模型附带文件。
///
/// 语音识别除了权重还需要词表才能把 token id 还原成文字，这里按文件名逐个登记，
/// 不开放任意扩展名，避免把模型目录变成任意文件落盘点。
const AUX_MODEL_ASSETS: [&str; 1] = ["sensevoice-vocab.txt"];

fn validate_model_name(model_name: &str) -> Result<(), String> {
    let mut components = Path::new(model_name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err("模型文件名必须是单个文件名，不能包含路径".to_string());
    }
    if model_name.to_ascii_lowercase().ends_with(".onnx") {
        return Ok(());
    }
    if AUX_MODEL_ASSETS.contains(&model_name) {
        return Ok(());
    }
    Err("模型文件名必须是单个 .onnx 文件，或已登记的辅助文件".to_string())
}

fn validate_onnx_file(path: &Path, content_type: Option<&str>) -> Result<u64, String> {
    if content_type.is_some_and(|value| value.eq_ignore_ascii_case("text/html")) {
        return Err("下载失败: 服务器返回 HTML 页面而非 ONNX 模型".to_string());
    }

    let size = std::fs::metadata(path)
        .map_err(|e| format!("读取模型文件信息失败: {e}"))?
        .len();
    if size == 0 {
        return Err("ONNX 模型文件为空".to_string());
    }
    if size > MAX_ONNX_MODEL_BYTES {
        return Err(format!(
            "ONNX 模型超过允许的体积上限 {MAX_ONNX_MODEL_BYTES} 字节"
        ));
    }

    let mut prefix = [0_u8; 256];
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开模型文件失败: {e}"))?;
    let read = file
        .read(&mut prefix)
        .map_err(|e| format!("读取模型文件头失败: {e}"))?;
    let trimmed = String::from_utf8_lossy(&prefix[..read])
        .trim_start()
        .to_ascii_lowercase();
    if trimmed.starts_with("<!doctype html") || trimmed.starts_with("<html") {
        return Err("下载失败: 文件内容是 HTML 页面而非 ONNX 模型".to_string());
    }
    Ok(size)
}

#[tauri::command]
pub fn check_model_exists(model_name: String) -> Result<bool, String> {
    validate_model_name(&model_name)?;
    let models = models_dir()?;
    let model_path = models.join(&model_name);
    Ok(model_path.is_file() && validate_onnx_file(&model_path, None).is_ok())
}

#[tauri::command]
pub fn get_models_dir() -> Result<String, String> {
    let dir = models_dir()?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn download_onnx_model(
    app: tauri::AppHandle,
    model_name: String,
    url: String,
    task_id: String,
) -> Result<String, String> {
    validate_model_name(&model_name)?;
    let models = models_dir()?;
    std::fs::create_dir_all(&models).map_err(|e| format!("创建模型目录失败: {e}"))?;

    let dest = models.join(&model_name);

    if dest.is_file() {
        match validate_onnx_file(&dest, None) {
            Ok(size) => {
                let j = json!({
                    "path": dest.to_string_lossy(),
                    "size_bytes": size,
                    "cached": true,
                });
                return Ok(j.to_string());
            }
            Err(_) => {
                std::fs::remove_file(&dest).map_err(|e| format!("清理无效模型缓存失败: {e}"))?
            }
        }
    }

    // 国内直连 HuggingFace 时好时坏，先选一个源；失败就翻到另一个源重试一次
    let resolved = crate::model_mirror::resolve(&url, None).await;
    let first = download_to_models_dir(
        app.clone(),
        task_id.clone(),
        resolved.url.clone(),
        dest.clone(),
    )
    .await;

    let download = match first {
        Ok(result) => result,
        Err(error) => {
            let Some(flipped) = crate::model_mirror::alternate(resolved.source) else {
                return Err(error);
            };
            let retry = crate::model_mirror::resolve(&url, Some(flipped)).await;
            eprintln!(
                "[onnxrt] {} 下载失败（{}），改用 {} 重试",
                resolved.source.label(),
                error,
                retry.source.label()
            );
            download_to_models_dir(app, task_id, retry.url, dest).await?
        }
    };

    let j = json!({
        "path": download.path,
        "size_bytes": download.total_bytes,
        "cached": false,
    });
    Ok(j.to_string())
}

/// 下载到模型目录，过程中用 `validate_onnx_file` 逐块校验，防止下到 HTML 错误页。
async fn download_to_models_dir(
    app: tauri::AppHandle,
    task_id: String,
    url: String,
    dest: std::path::PathBuf,
) -> Result<crate::file_transfer::FileTransferResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_transfer::download_to_file(
            &app,
            &task_id,
            &url,
            &dest,
            Some(MAX_ONNX_MODEL_BYTES),
            |temp_path, metadata| {
                validate_onnx_file(temp_path, metadata.content_type.as_deref()).map(|_| ())
            },
        )
    })
    .await
    .map_err(|e| format!("模型下载任务执行失败: {e}"))?
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
    stdin: Option<std::process::ChildStdin>,
    rx: mpsc::Receiver<Value>,
    timeout: Duration,
    stdout_thread: Option<std::thread::JoinHandle<()>>,
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

        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                reap_child(&mut child, Duration::ZERO);
                return Err("无法获取 worker stdin".to_string());
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                drop(stdin);
                reap_child(&mut child, Duration::ZERO);
                return Err("无法获取 worker stdout".to_string());
            }
        };

        let (tx, rx) = mpsc::channel::<Value>();
        let stdout_thread = std::thread::spawn(move || {
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
            stdin: Some(stdin),
            rx,
            timeout: Duration::from_secs(timeout_secs),
            stdout_thread: Some(stdout_thread),
        };

        session.send(request)?;
        Ok(session)
    }

    fn send(&mut self, request: &Value) -> Result<(), String> {
        let s = serde_json::to_string(request).map_err(|e| format!("JSON 序列化失败: {e}"))?;
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "worker stdin 已关闭".to_string())?;
        writeln!(stdin, "{}", s).map_err(|e| format!("写入 worker stdin 失败: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("flush worker stdin 失败: {e}"))?;
        Ok(())
    }

    fn read_one_skip_ready(&self) -> Result<Value, String> {
        loop {
            let v = self
                .rx
                .recv_timeout(self.timeout)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => format!(
                        "ONNX worker 无响应（{} 秒超时），进程可能已崩溃",
                        self.timeout.as_secs()
                    ),
                    mpsc::RecvTimeoutError::Disconnected => {
                        "ONNX worker 输出通道已关闭，进程可能已退出".to_string()
                    }
                })?;

            if v.get("type").and_then(|t| t.as_str()) == Some("ready") {
                continue;
            }
            return Ok(v);
        }
    }

    fn read_until_done(&self, mut on_progress: impl FnMut(u32, u32)) -> Result<Value, String> {
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
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = writeln!(stdin, r#"{{"type":"quit"}}"#);
            let _ = stdin.flush();
        }
        self.stdin.take();
        reap_child(&mut self.child, WORKER_EXIT_GRACE);
        if let Some(stdout_thread) = self.stdout_thread.take() {
            let _ = stdout_thread.join();
        }
    }
}

fn reap_child(child: &mut Child, grace: Duration) {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(WORKER_EXIT_POLL_INTERVAL);
            }
            Ok(None) | Err(_) => break,
        }
    }

    kill_child(child);
    let _ = child.kill();
    let _ = child.wait();
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

    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        let session = WorkerSession::start(&request, 60)?;
        session.read_one_skip_ready()
    })
    .await
    .map_err(|e| format!("GPU 探针任务执行失败: {e}"))?;
    let resp = match worker_result {
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

    let resp_type = resp.get("type").and_then(|v| v.as_str()).unwrap_or("");

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
                let vram_mb = result.get("vram_mb").and_then(|v| v.as_u64()).unwrap_or(0);

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

    let app_handle = app.clone();
    let tid = task_id.to_string();
    let evt = progress_event.map(|s| s.to_string());
    let request_type_for_worker = request_type.to_string();

    let resp = tauri::async_runtime::spawn_blocking(move || {
        let session =
            WorkerSession::start(&request, timeout_secs).map_err(|error| (false, error))?;
        session
            .read_until_done(move |done, total| {
                let percent = if total > 0 { done * 100 / total } else { 0 };
                if let Some(ref evt_name) = evt {
                    let _ = app_handle.emit(
                        evt_name,
                        json!({"taskId": tid, "done": done, "total": total, "percent": percent}),
                    );
                }
            })
            .map_err(|error| (true, error))
    })
    .await
    .map_err(|error| {
        (
            false,
            format!("{request_type_for_worker} Worker 任务执行失败: {error}"),
        )
    })?;

    match resp {
        Ok(v) => {
            let t = v.get("type").and_then(|s| s.as_str()).unwrap_or("");
            match t {
                "ok" => Ok(v),
                "error" => {
                    let err = v
                        .get("error")
                        .and_then(|s| s.as_str())
                        .unwrap_or("Worker 返回未知错误");
                    Err((true, format!("{request_type} 推理失败: {err}")))
                }
                _ => Err((false, format!("Worker 返回意外响应类型: {t}"))),
            }
        }
        Err(e) => Err(e),
    }
}

// ════════════════════════════════════════════════
// Tauri 命令：图像超分
// ════════════════════════════════════════════════

#[tauri::command]
pub async fn image_upscale(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input_path: String,
    output_path: String,
    model_name: String,
    task_id: String,
) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    // 输入输出都来自 Renderer；不校验等于任意文件读取与任意位置覆盖写
    let input = crate::path_policy::authorize_path(
        &app,
        &input_path,
        crate::path_policy::PathAccess::Read,
    )?;
    let output_path = crate::path_policy::authorize_path(
        &app,
        &output_path,
        crate::path_policy::PathAccess::Write,
    )?
    .to_string_lossy()
    .into_owned();
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
        &app,
        &config,
        "upscale",
        &model_path,
        &extra,
        &task_id,
        Some("image-upscale-progress"),
        300,
    )
    .await
    {
        Ok(v) => {
            let result = v.get("result").ok_or("超分响应缺少 result 字段")?;
            let input_size = result
                .get("input_size")
                .and_then(|s| s.as_str())
                .unwrap_or("?x?");
            let output_size = result
                .get("output_size")
                .and_then(|s| s.as_str())
                .unwrap_or("?x?");
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
                    &app,
                    &config,
                    "upscale",
                    &model_path,
                    &extra,
                    &task_id,
                    Some("image-upscale-progress"),
                    300,
                )
                .await
                {
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
    webview: tauri::Webview,
    input_path: String,
    output_path: String,
    model_name: String,
    task_id: String,
) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let input = crate::path_policy::authorize_path(
        &app,
        &input_path,
        crate::path_policy::PathAccess::Read,
    )?;
    let output_path = crate::path_policy::authorize_path(
        &app,
        &output_path,
        crate::path_policy::PathAccess::Write,
    )?
    .to_string_lossy()
    .into_owned();
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
        &app,
        &config,
        "matting",
        &model_path,
        &extra,
        &task_id,
        None, // matting 无需进度（单次推理，很快）
        120,
    )
    .await
    {
        Ok(v) => {
            let result = v.get("result").ok_or("主体识别响应缺少 result 字段")?;
            let subject_path = result
                .get("subject_path")
                .and_then(|s| s.as_str())
                .unwrap_or(&output_path);
            let input_size = result
                .get("input_size")
                .and_then(|s| s.as_str())
                .unwrap_or("?x?");
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
                    &app,
                    &config,
                    "matting",
                    &model_path,
                    &extra,
                    &task_id,
                    None,
                    120,
                )
                .await
                {
                    Ok(v) => {
                        let result = v.get("result").ok_or("主体识别响应缺少 result 字段")?;
                        let subject_path = result
                            .get("subject_path")
                            .and_then(|s| s.as_str())
                            .unwrap_or(&output_path);
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
// Tauri 命令：本地语音转文本（SenseVoice）
// ════════════════════════════════════════════════

/// 语音转文本的 Worker 超时：20 分钟音频按 25 秒切片是 48 段，还要留出模型加载时间。
const ASR_TIMEOUT_SECS: u64 = 900;

fn parse_asr_result(value: &Value) -> Result<String, String> {
    let result = value
        .get("result")
        .ok_or("语音转文本响应缺少 result 字段")?;
    let text = result.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let duration_seconds = result
        .get("duration_seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    Ok(json!({
        "text": text,
        "duration_seconds": duration_seconds,
    })
    .to_string())
}

/// 本地语音转文本：用 SenseVoice Small 把音频文件识别成文字，全程离线。
#[tauri::command]
pub async fn speech_to_text(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input_path: String,
    model_name: String,
    vocab_name: String,
    task_id: String,
    language: Option<String>,
) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let input = crate::path_policy::authorize_path(
        &app,
        &input_path,
        crate::path_policy::PathAccess::Read,
    )?;
    if !input.is_file() {
        return Err(format!("输入文件不存在: {input_path}"));
    }

    validate_model_name(&model_name)?;
    validate_model_name(&vocab_name)?;

    let models = models_dir()?;
    let model_path = models.join(&model_name);
    let vocab_path = models.join(&vocab_name);
    for (label, path) in [("模型", &model_path), ("词表", &vocab_path)] {
        if !path.is_file() {
            return Err(format!(
                "{label}文件不存在: {}\n请重新下载模型组件",
                path.display()
            ));
        }
    }

    let mut config = get_or_probe_gpu_config(&model_path).await;

    let extra = json!({
        "input_path": input_path,
        "vocab_path": vocab_path.to_string_lossy(),
        "language": language.unwrap_or_default(),
    });

    match run_in_worker(
        &app,
        &config,
        "asr",
        &model_path,
        &extra,
        &task_id,
        Some("speech-to-text-progress"),
        ASR_TIMEOUT_SECS,
    )
    .await
    {
        Ok(value) => parse_asr_result(&value),
        Err((is_worker_err, error)) => {
            if is_worker_err && config.ep == "directml" {
                eprintln!("[onnxrt] DirectML ASR Worker 失败: {error} → 标记 CPU 并重试");
                config.ep = "cpu".to_string();
                config.device_id = None;
                config.device_name = None;
                let _ = config.save();

                match run_in_worker(
                    &app,
                    &config,
                    "asr",
                    &model_path,
                    &extra,
                    &task_id,
                    Some("speech-to-text-progress"),
                    ASR_TIMEOUT_SECS,
                )
                .await
                {
                    Ok(value) => parse_asr_result(&value),
                    Err((_, retry_error)) => Err(retry_error),
                }
            } else {
                Err(error)
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

/// 键控底色：必须与 8 向图提示词里钉死的纯色背景一致（影视标准绿 #00B140）。
/// 角色本身是绿色系时改用蓝幕：这里换 [0x00, 0x00, 0xFF]、SPILL_CHANNEL 换 2，
/// 提示词里的色号同步换掉。品红这类双主通道的底色这套去反光不适用。
const CHROMA_KEY_COLOR: [u8; 3] = [0x00, 0xB1, 0x40];
/// 键控色的主通道下标，用于压掉溅在角色轮廓上的底色反光；#00B140 的主通道是 G。
const CHROMA_KEY_SPILL_CHANNEL: usize = 1;
/// 到键控色的 RGB 距离：≤SOLID 判定为纯背景，≥EDGE 判定为角色，中间线性羽化边缘。
/// 模型出图有色偏、背景有布光渐变、再过一道压缩，所以不能按精确色值匹配。
const CHROMA_KEY_SOLID_DISTANCE: f32 = 60.0;
const CHROMA_KEY_EDGE_DISTANCE: f32 = 110.0;

fn chroma_key_distance(pixel: &image::Rgba<u8>) -> f32 {
    let dr = f32::from(pixel[0]) - f32::from(CHROMA_KEY_COLOR[0]);
    let dg = f32::from(pixel[1]) - f32::from(CHROMA_KEY_COLOR[1]);
    let db = f32::from(pixel[2]) - f32::from(CHROMA_KEY_COLOR[2]);
    (dr * dr + dg * dg + db * db).sqrt()
}

/// 从四边 flood fill 抠掉键控底色。
/// 只吃与边框连通的那片背景，角色身上的同色图案是孤岛，不会被一起抠掉。
/// 源图不是键控底（老图、照片）时边框种子为空，整格原样保留。
fn key_out_chroma_background(cell: &mut image::RgbaImage) {
    let (width, height) = cell.dimensions();
    if width == 0 || height == 0 {
        return;
    }

    let distances: Vec<f32> = cell.pixels().map(chroma_key_distance).collect();
    let mut keyed = vec![false; distances.len()];
    let mut stack: Vec<usize> = Vec::new();

    for y in 0..height {
        for x in 0..width {
            if x != 0 && y != 0 && x != width - 1 && y != height - 1 {
                continue;
            }
            let index = (y * width + x) as usize;
            if !keyed[index] && distances[index] < CHROMA_KEY_EDGE_DISTANCE {
                keyed[index] = true;
                stack.push(index);
            }
        }
    }

    while let Some(index) = stack.pop() {
        let x = index as u32 % width;
        let y = index as u32 / width;
        // 减到 0 以下会绕成 u32::MAX，正好被下面的越界判断拦掉
        for (neighbour_x, neighbour_y) in [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ] {
            if neighbour_x >= width || neighbour_y >= height {
                continue;
            }
            let neighbour = (neighbour_y * width + neighbour_x) as usize;
            if keyed[neighbour] || distances[neighbour] >= CHROMA_KEY_EDGE_DISTANCE {
                continue;
            }
            keyed[neighbour] = true;
            stack.push(neighbour);
        }
    }

    let feather = (CHROMA_KEY_EDGE_DISTANCE - CHROMA_KEY_SOLID_DISTANCE).max(1.0);
    for (index, pixel) in cell.pixels_mut().enumerate() {
        if !keyed[index] {
            continue;
        }
        let distance = distances[index];
        if distance <= CHROMA_KEY_SOLID_DISTANCE {
            pixel[3] = 0;
            continue;
        }
        // 半透明的过渡像素：按色距羽化，并把底色反光压回另外两个通道的量级
        let ratio = ((distance - CHROMA_KEY_SOLID_DISTANCE) / feather).clamp(0.0, 1.0);
        pixel[3] = (f32::from(pixel[3]) * ratio).round() as u8;
        let other_a = pixel[(CHROMA_KEY_SPILL_CHANNEL + 1) % 3];
        let other_b = pixel[(CHROMA_KEY_SPILL_CHANNEL + 2) % 3];
        pixel[CHROMA_KEY_SPILL_CHANNEL] = pixel[CHROMA_KEY_SPILL_CHANNEL].min(other_a.max(other_b));
    }
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

    let mut cell = image::imageops::crop_imm(
        subject,
        x0 + inset,
        y0 + inset,
        cell_width - inset * 2,
        cell_height - inset * 2,
    )
    .to_image();
    key_out_chroma_background(&mut cell);
    let (trim_x, trim_y, trim_width, trim_height) = alpha_bounds(&cell)
        .ok_or_else(|| format!("源图第 {} 块抠底后没剩下主体", source_index + 1))?;
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

fn compose_character_direction_grid(source_path: &Path, output_path: &Path) -> Result<(), String> {
    let subject = image::open(source_path)
        .map_err(|error| format!("读取 8 向图源图片失败: {error}"))?
        .to_rgba8();
    let grid = compose_character_direction_grid_image(&subject)?;
    grid.save(output_path)
        .map_err(|error| format!("保存角色 8 向宫格失败: {error}"))
}

/// 把 2×3 角色视图直接切图，生成由 9 个 512×512 单元组成的宫格图。
/// 源图带透明通道时按主体裁掉留白，不带则整格铺满。
#[tauri::command]
pub async fn character_direction_grid(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input_path: String,
) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    // 宫格图写在输入文件旁边，因此只需校验输入路径
    let input = crate::path_policy::authorize_path(
        &app,
        &input_path,
        crate::path_policy::PathAccess::Read,
    )?;
    if !input.is_file() {
        return Err(format!("输入文件不存在: {input_path}"));
    }

    let output_path = unique_sibling_png(&input, "8dir_grid")?;
    compose_character_direction_grid(&input, &output_path)?;

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

    fn test_directory(name: &str) -> PathBuf {
        let unique = format!(
            "ai-canvas-onnx-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时间应晚于 UNIX epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&directory).expect("应创建测试目录");
        directory
    }

    #[cfg(windows)]
    fn spawn_exit_process(exit_code: i32) -> Child {
        Command::new("cmd")
            .args(["/C", &format!("exit {exit_code}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("应启动退出测试进程")
    }

    #[cfg(not(windows))]
    fn spawn_exit_process(exit_code: i32) -> Child {
        Command::new("sh")
            .args(["-c", &format!("exit {exit_code}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("应启动退出测试进程")
    }

    #[cfg(windows)]
    fn spawn_stalled_process() -> Child {
        Command::new("cmd")
            .args(["/C", "ping 127.0.0.1 -n 30 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("应启动超时测试进程")
    }

    #[cfg(not(windows))]
    fn spawn_stalled_process() -> Child {
        Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("应启动超时测试进程")
    }

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
    fn validates_model_name_and_rejects_html_payload() {
        assert!(validate_model_name("rmbg-1.4.onnx").is_ok());
        assert!(validate_model_name("../rmbg-1.4.onnx").is_err());
        assert!(validate_model_name("rmbg-1.4.bin").is_err());
        assert!(validate_model_name("nested/model.onnx").is_err());

        // 辅助文件只允许逐个登记过的名字
        assert!(validate_model_name("sensevoice-vocab.txt").is_ok());
        assert!(validate_model_name("sensevoice-tokens.txt").is_err());
        assert!(validate_model_name("../../secrets/mcp/token").is_err());

        let directory = test_directory("validation");
        let model_path = directory.join("model.onnx");
        std::fs::write(&model_path, b"<!doctype html><html>not a model</html>")
            .expect("应写入测试文件");
        assert!(validate_onnx_file(&model_path, None)
            .expect_err("HTML 内容应被拒绝")
            .contains("HTML"));
        std::fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn reaps_normal_failed_and_timed_out_children_twenty_times_each() {
        for exit_code in [0, 7] {
            for _ in 0..20 {
                let mut child = spawn_exit_process(exit_code);
                reap_child(&mut child, WORKER_EXIT_GRACE);
                assert!(child.try_wait().expect("应读取退出状态").is_some());
            }
        }

        for _ in 0..20 {
            let mut child = spawn_stalled_process();
            reap_child(&mut child, Duration::from_millis(20));
            assert!(child.try_wait().expect("应读取退出状态").is_some());
        }
    }

    #[test]
    fn worker_cleanup_does_not_block_async_runtime() {
        tauri::async_runtime::block_on(async {
            let cleanup = tauri::async_runtime::spawn_blocking(|| {
                let mut child = spawn_stalled_process();
                reap_child(&mut child, Duration::from_millis(500));
            });

            let started = Instant::now();
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(
                started.elapsed() < Duration::from_millis(300),
                "阻塞回收不应占用 async runtime"
            );
            cleanup.await.expect("阻塞回收任务应完成");
        });
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

    /// 不做主体识别后源图整张不透明，仍应按 2×3 切图落到正确的 9 个格子
    #[test]
    fn composition_slices_opaque_source_without_matting() {
        let mut subject = image::RgbaImage::new(200, 300);
        // 都远离键控色，避免被抠底逻辑碰到，这里只验证切格
        let colors = [
            [220, 20, 20, 255],
            [120, 20, 220, 255],
            [20, 20, 220, 255],
            [220, 220, 20, 255],
            [220, 20, 220, 255],
            [20, 220, 220, 255],
        ];

        for (x, y, pixel) in subject.enumerate_pixels_mut() {
            let source_index = (y / 100 * 2 + x / 100) as usize;
            *pixel = image::Rgba(colors[source_index]);
        }

        let grid = compose_character_direction_grid_image(&subject).expect("应成功合成宫格");
        assert_eq!(grid.dimensions(), (1536, 1536));
        // 单元格 512、主体最长边 448，四角留白仍是透明的
        assert_eq!(grid.get_pixel(0, 0)[3], 0);

        let expected_sources = [5usize, 3, 5, 1, 0, 1, 4, 2, 4];
        for (target_index, source_index) in expected_sources.into_iter().enumerate() {
            let row = target_index / 3;
            let col = target_index % 3;
            let pixel = grid.get_pixel(col as u32 * 512 + 256, row as u32 * 512 + 256);
            assert_eq!(pixel.0, colors[source_index]);
        }
    }

    /// 键控底色被抠掉、主体被裁到边界；角色身上同为键控色的图案不连通边框，必须活下来
    #[test]
    fn chroma_key_removes_background_but_keeps_key_colored_island() {
        let key = [
            CHROMA_KEY_COLOR[0],
            CHROMA_KEY_COLOR[1],
            CHROMA_KEY_COLOR[2],
            255,
        ];
        let colors = [
            [220, 20, 20, 255],
            [120, 20, 220, 255],
            [20, 20, 220, 255],
            [220, 220, 20, 255],
            [220, 20, 220, 255],
            [20, 220, 220, 255],
        ];

        let mut subject = image::RgbaImage::from_pixel(200, 300, image::Rgba(key));
        for (source_index, subject_color) in colors.into_iter().enumerate() {
            let cell_x = (source_index as u32 % 2) * 100;
            let cell_y = (source_index as u32 / 2) * 100;
            // 30×30 主体，正中挖一块 10×10 的键控色图案（角色身上的绿）
            for y in 35..65u32 {
                for x in 35..65u32 {
                    let inside_island = (45..55).contains(&x) && (45..55).contains(&y);
                    let color = if inside_island { key } else { subject_color };
                    subject.put_pixel(cell_x + x, cell_y + y, image::Rgba(color));
                }
            }
        }

        let grid = compose_character_direction_grid_image(&subject).expect("应成功合成宫格");
        let expected_sources = [5usize, 3, 5, 1, 0, 1, 4, 2, 4];
        for (target_index, source_index) in expected_sources.into_iter().enumerate() {
            let center_x = (target_index as u32 % 3) * 512 + 256;
            let center_y = (target_index as u32 / 3) * 512 + 256;

            // 主体中心那块键控色图案没被抠掉
            assert_eq!(grid.get_pixel(center_x, center_y).0, key);
            // 背景抠干净后主体被裁到 30×30 再放大，中心 +150 仍落在主体上
            // （取图案与主体边缘的中点，避开 Lanczos 放大在两侧边界的过渡带）
            assert_eq!(
                grid.get_pixel(center_x + 150, center_y).0,
                colors[source_index]
            );
            // 抠掉的背景不该跟着主体一起放大进格子
            assert_eq!(grid.get_pixel(center_x + 240, center_y)[3], 0);
        }
    }
}
