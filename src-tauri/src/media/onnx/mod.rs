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
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, OnceLock};
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
const MANAGED_MODEL_FILES: [&str; 4] = [
    "realesrgan-x4.onnx",
    "rmbg-1.4.onnx",
    "sensevoice-small-int8.onnx",
    "sensevoice-vocab.txt",
];

#[derive(Deserialize)]
struct SpeechModelAsset {
    name: String,
    url: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
struct SpeechModelManifest {
    assets: Vec<SpeechModelAsset>,
}

fn speech_model_asset(model_name: &str) -> Option<&'static SpeechModelAsset> {
    static MANIFEST: OnceLock<SpeechModelManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../src/constants/localSpeechModels.json"))
            .expect("invalid embedded speech model manifest")
    }).assets.iter().find(|asset| asset.name == model_name)
}

fn model_storage_error(error: &std::io::Error, action: &str) -> String {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        format!("{action}失败：没有模型目录的读写权限，请检查安装目录或用户数据目录权限")
    } else if matches!(error.raw_os_error(), Some(28 | 112)) {
        format!("{action}失败：磁盘空间不足，请清理空间后重试")
    } else {
        format!("{action}失败：请检查磁盘空间、文件占用和模型目录权限")
    }
}

fn validate_speech_model_url(asset: &SpeechModelAsset, url: &str) -> Result<(), String> {
    if url != asset.url {
        return Err("语音模型下载地址与应用内置固定版本不一致，请更新应用后重试".into());
    }
    Ok(())
}

/// 缓存和新下载都验证完整大小及 SHA-256；错误页、LFS 指针和截断文件不能视为已安装。
/// None 表示文件缺失或内容不匹配；读取/取消错误保留为错误，不能当损坏文件直接删除。
fn verified_speech_model_size(
    path: &Path,
    asset: &SpeechModelAsset,
    content_type: Option<&str>,
    task_id: Option<&str>,
) -> Result<Option<u64>, String> {
    if content_type.is_some_and(|value| {
        matches!(value.split(';').next().unwrap_or_default().trim(),
            "text/html" | "application/json" | "application/xml" | "text/xml")
    }) {
        return Ok(None);
    }
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(model_storage_error(&error, "读取语音模型")),
    };
    if !metadata.file_type().is_file() || metadata.len() != asset.bytes {
        return Ok(None);
    }
    let mut file = std::fs::File::open(path)
        .map_err(|error| model_storage_error(&error, "读取语音模型"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    loop {
        if task_id.map(crate::file_transfer::is_cancelled).transpose()?.unwrap_or(false) {
            return Err("文件传输已取消".into());
        }
        let read = file.read(&mut buffer)
            .map_err(|error| model_storage_error(&error, "读取语音模型"))?;
        if read == 0 { break; }
        bytes += read as u64;
        if bytes > asset.bytes { return Ok(None); }
        hasher.update(&buffer[..read]);
    }
    Ok((bytes == asset.bytes && format!("{:x}", hasher.finalize()) == asset.sha256)
        .then_some(bytes))
}

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
pub async fn check_model_exists(model_name: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_model_name(&model_name)?;
        let asset = speech_model_asset(&model_name);
        let models = models_dir().map_err(|error| {
            if asset.is_some() { "无法准备语音模型目录，请检查目录权限和磁盘空间".into() } else { error }
        })?;
        let model_path = models.join(&model_name);
        if let Some(asset) = asset {
            return verified_speech_model_size(&model_path, asset, None, None)
                .map(|size| size.is_some());
        }
        Ok(model_path.is_file() && validate_onnx_file(&model_path, None).is_ok())
    }).await.map_err(|_| "模型检查任务执行失败，请重试".to_string())?
}

#[tauri::command]
pub fn get_models_dir() -> Result<String, String> {
    let dir = models_dir()?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_onnx_models(webview: tauri::Webview) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let models = models_dir()?;
    let mut entries = Vec::new();
    for name in MANAGED_MODEL_FILES {
        let path = models.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                entries.push(json!({ "name": name, "size_bytes": metadata.len() }));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("读取 ONNX 模型信息失败: {error}")),
        }
    }
    Ok(json!(entries).to_string())
}

#[tauri::command]
pub fn remove_onnx_model(webview: tauri::Webview, model_name: String) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    remove_managed_model(&models_dir()?, &model_name)
}

fn remove_managed_model(models: &Path, model_name: &str) -> Result<(), String> {
    if !MANAGED_MODEL_FILES.contains(&model_name) {
        return Err("只能删除已登记的 ONNX 模型文件".to_string());
    }
    let path = models.join(model_name);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            std::fs::remove_file(path).map_err(|error| format!("删除 ONNX 模型失败: {error}"))
        }
        Ok(_) => Err("目标不是普通模型文件".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("读取 ONNX 模型信息失败: {error}")),
    }
}

#[tauri::command]
pub async fn download_onnx_model(
    app: tauri::AppHandle,
    model_name: String,
    url: String,
    task_id: String,
) -> Result<String, String> {
    let speech = speech_model_asset(&model_name).is_some();
    let result = download_onnx_model_inner(app, model_name, url, task_id.clone()).await;
    crate::file_transfer::clear_cancelled(&task_id);
    result.map_err(|error| {
        if speech && error != "文件传输已取消" { format!("语音模型下载失败：{error}") } else { error }
    })
}

async fn download_onnx_model_inner(
    app: tauri::AppHandle,
    model_name: String,
    url: String,
    task_id: String,
) -> Result<String, String> {
    validate_model_name(&model_name)?;
    let asset = speech_model_asset(&model_name);
    if let Some(asset) = asset { validate_speech_model_url(asset, &url)?; }
    if crate::file_transfer::is_cancelled(&task_id)? { return Err("文件传输已取消".into()); }
    let models = models_dir().map_err(|error| {
        if asset.is_some() { "无法准备模型目录，请检查目录权限和磁盘空间".into() } else { error }
    })?;
    std::fs::create_dir_all(&models).map_err(|error| model_storage_error(&error, "创建模型目录"))?;

    let dest = models.join(&model_name);
    let cached_dest = dest.clone();
    let cached_task = task_id.clone();
    let cached_size = tauri::async_runtime::spawn_blocking(move || {
        if let Some(asset) = asset {
            verified_speech_model_size(&cached_dest, asset, None, Some(&cached_task))
        } else {
            Ok(cached_dest.is_file().then(|| validate_onnx_file(&cached_dest, None).ok()).flatten())
        }
    }).await.map_err(|_| "模型缓存检查任务执行失败，请重试".to_string())??;
    if let Some(size) = cached_size {
        return Ok(json!({ "path": dest.to_string_lossy(), "size_bytes": size, "cached": true }).to_string());
    }
    match std::fs::symlink_metadata(&dest) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err("模型目标不是普通文件，请检查模型目录后重试".into());
            }
            std::fs::remove_file(&dest).map_err(|error| model_storage_error(&error, "清理无效模型缓存"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(model_storage_error(&error, "读取模型缓存")),
    }

    // 只对网络/临时 HTTP 失败翻源一次；取消、权限、磁盘与内容校验失败不重新下载。
    let resolved = crate::model_mirror::resolve(&url, None).await;
    let first = download_to_models_dir(
        app.clone(),
        task_id.clone(),
        resolved.url.clone(),
        dest.clone(),
        asset,
    )
    .await;

    let download = match first {
        Ok(result) => {
            crate::model_mirror::record_success(resolved.source);
            result
        }
        Err(error) => {
            if crate::file_transfer::is_cancelled(&task_id)? {
                return Err("文件传输已取消".into());
            }
            if !error.retryable {
                return Err(error.message);
            }
            let Some(flipped) = crate::model_mirror::alternate(resolved.source) else {
                return Err(error.message);
            };
            let retry = crate::model_mirror::resolve(&url, Some(flipped)).await;
            eprintln!(
                "[onnxrt] {} 下载连接失败，改用 {} 重试",
                resolved.source.label(),
                retry.source.label()
            );
            let result = match download_to_models_dir(app, task_id.clone(), retry.url, dest, asset).await {
                Ok(result) => result,
                Err(retry_error) => {
                    if crate::file_transfer::is_cancelled(&task_id)? || retry_error.message == "文件传输已取消" {
                        return Err("文件传输已取消".into());
                    }
                    return Err(model_source_failures(
                        resolved.source, &error.message, retry.source, &retry_error.message,
                    ));
                }
            };
            crate::model_mirror::record_success(retry.source);
            result
        }
    };

    let j = json!({
        "path": download.path,
        "size_bytes": download.total_bytes,
        "cached": false,
    });
    Ok(j.to_string())
}

/// 两次尝试只合并传输层已脱敏的分类提示；限长给前端安全错误展示保留空间。
fn model_source_failures(
    first: crate::model_mirror::Source,
    first_message: &str,
    second: crate::model_mirror::Source,
    second_message: &str,
) -> String {
    let label = |source| match source {
        crate::model_mirror::Source::Official => "官方源",
        crate::model_mirror::Source::Mirror => "国内镜像",
        crate::model_mirror::Source::Passthrough => "原始源",
    };
    let first_message: String = first_message.chars().take(80).collect();
    let second_message: String = second_message.chars().take(80).collect();
    format!("{}失败：{}；{}失败：{}", label(first), first_message, label(second), second_message)
}

/// 沿用原子落盘；语音资源必须通过固定版本的完整 SHA-256 才可发布。
async fn download_to_models_dir(
    app: tauri::AppHandle,
    task_id: String,
    url: String,
    dest: std::path::PathBuf,
    asset: Option<&'static SpeechModelAsset>,
) -> Result<crate::file_transfer::FileTransferResult, crate::file_transfer::DownloadFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        // 普通 ONNX 的 GitHub 地址保留既有公开下载兜底；语音固定资产只走下方校验入口。
        if asset.is_none() && crate::github_fallback::mirror_url(&url).is_some() {
            return crate::file_transfer::download_to_file(
                &app, &task_id, &url, &dest, Some(MAX_ONNX_MODEL_BYTES),
                |temp_path, metadata| validate_onnx_file(temp_path, metadata.content_type.as_deref()).map(|_| ()),
            ).map_err(|message| crate::file_transfer::DownloadFailure { message, retryable: false });
        }
        crate::file_transfer::download_model_to_file_attempt(
            &app,
            &task_id,
            &url,
            &dest,
            Some(asset.map_or(MAX_ONNX_MODEL_BYTES, |asset| asset.bytes)),
            |temp_path, metadata| {
                if let Some(asset) = asset {
                    verified_speech_model_size(temp_path, asset, metadata.content_type.as_deref(), Some(&task_id))?
                        .ok_or_else(|| "语音模型大小或 SHA-256 校验不符，文件未安装；请重试或检查下载源".to_string())
                        .map(|_| ())
                } else {
                    validate_onnx_file(temp_path, metadata.content_type.as_deref()).map(|_| ())
                }
            },
        )
    })
    .await
    .map_err(|_| crate::file_transfer::DownloadFailure {
        message: "模型下载任务执行失败，请重试".into(), retryable: false,
    })?
}

// ════════════════════════════════════════════════
// Worker 进程管理
// ════════════════════════════════════════════════

#[derive(Debug)]
enum WorkerFailure {
    #[cfg(windows)]
    UpdateShutdown,
    Failed(String),
}

impl WorkerFailure {
    fn into_message(self) -> String {
        match self {
            #[cfg(windows)]
            Self::UpdateShutdown => "应用正在更新，本地推理已停止".to_string(),
            Self::Failed(error) => error,
        }
    }
}

impl From<String> for WorkerFailure {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

#[cfg(windows)]
mod windows_worker_lifecycle;

#[cfg(windows)]
pub use windows_worker_lifecycle::{prepare_update_worker_shutdown, UpdateWorkerShutdownGuard};

struct WorkerSession {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
    rx: mpsc::Receiver<Value>,
    timeout: Duration,
    stdout_thread: Option<std::thread::JoinHandle<()>>,
    #[cfg(windows)]
    owned_process: std::sync::Arc<windows_worker_lifecycle::OwnedWorker>,
}

impl WorkerSession {
    fn start(request: &Value, timeout_secs: u64) -> Result<Self, WorkerFailure> {
        let exe = std::env::current_exe().map_err(|_| "无法定位本地推理程序".to_string())?;

        let mut command = Command::new(&exe);
        command.arg("--onnx-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        let (mut child, owned_process) = windows_worker_lifecycle::spawn_registered(&mut command)?;
        #[cfg(not(windows))]
        let mut child = command.spawn().map_err(|_| "无法启动本地推理进程".to_string())?;

        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                reap_child(&mut child, Duration::ZERO);
                return Err("无法获取 worker stdin".to_string().into());
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                drop(stdin);
                reap_child(&mut child, Duration::ZERO);
                return Err("无法获取 worker stdout".to_string().into());
            }
        };

        let (tx, rx) = mpsc::channel::<Value>();
        let stdout_thread = std::thread::Builder::new().name("onnx-worker-stdout".into()).spawn(move || {
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
        let stdout_thread = match stdout_thread {
            Ok(thread) => thread,
            Err(_) => {
                drop(stdin);
                #[cfg(windows)]
                owned_process.terminate();
                reap_child(&mut child, Duration::ZERO);
                return Err("无法读取本地推理进程输出".to_string().into());
            }
        };

        let mut session = Self {
            child,
            stdin: Some(stdin),
            rx,
            timeout: Duration::from_secs(timeout_secs),
            stdout_thread: Some(stdout_thread),
            #[cfg(windows)]
            owned_process,
        };

        let sent = session.send(request);
        session.classify_result(sent)?;
        Ok(session)
    }

    fn classify_result<T>(&self, result: Result<T, String>) -> Result<T, WorkerFailure> {
        #[cfg(windows)]
        if self.owned_process.was_cancelled_for_update() {
            return Err(WorkerFailure::UpdateShutdown);
        }
        result.map_err(WorkerFailure::Failed)
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
        // 更新快照也可能持有 Arc，不能依赖字段析构才关闭 Job；先释放子孙的输出管道。
        #[cfg(windows)]
        self.owned_process.terminate();
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

    #[cfg(not(windows))]
    kill_child(child);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_child(child: &Child) {
    let pid = child.id();
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
}

// ════════════════════════════════════════════════
// GPU 探针
// ════════════════════════════════════════════════

async fn probe_gpu(model_path: &Path) -> Result<OnnxGpuConfig, WorkerFailure> {
    let request = json!({
        "id": "probe-1",
        "type": "probe",
        "model_path": model_path.to_string_lossy()
    });

    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        let session = WorkerSession::start(&request, 60)?;
        session.classify_result(session.read_one_skip_ready())
    })
    .await
    .map_err(|e| format!("GPU 探针任务执行失败: {e}"))?;
    let resp = match worker_result {
        Ok(v) => v,
        #[cfg(windows)]
        Err(WorkerFailure::UpdateShutdown) => return Err(WorkerFailure::UpdateShutdown),
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
            let result = resp.get("result").ok_or_else(|| {
                WorkerFailure::Failed("探针响应缺少 result 字段".to_string())
            })?;
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
        _ => Err(format!("探针 Worker 返回意外响应类型: {resp_type}").into()),
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

async fn get_or_probe_gpu_config(model_path: &Path) -> Result<OnnxGpuConfig, String> {
    let mut config = OnnxGpuConfig::get_or_default();
    if config.probed_at.is_none() {
        eprintln!("[onnxrt] 首次使用，开始 GPU 能力探测...");
        match probe_gpu(model_path).await {
            Ok(cfg) => {
                let _ = cfg.save();
                config = cfg;
            }
            #[cfg(windows)]
            Err(WorkerFailure::UpdateShutdown) => {
                return Err(WorkerFailure::UpdateShutdown.into_message());
            }
            Err(WorkerFailure::Failed(e)) => {
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
    Ok(config)
}

// ════════════════════════════════════════════════
// 通用 Worker 推理执行
// ════════════════════════════════════════════════

/// 错误元组首项表示 Worker 故障可触发 GPU 回退；更新取消与启动失败均不重试。
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
        let session = WorkerSession::start(&request, timeout_secs)
            .map_err(|error| (false, error.into_message()))?;
        let result = session.read_until_done(move |done, total| {
            let percent = if total > 0 { done * 100 / total } else { 0 };
            if let Some(ref evt_name) = evt {
                let _ = app_handle.emit(
                    evt_name,
                    json!({"taskId": tid, "done": done, "total": total, "percent": percent}),
                );
            }
        });
        session.classify_result(result).map_err(|error| match error {
            #[cfg(windows)]
            WorkerFailure::UpdateShutdown => (false, WorkerFailure::UpdateShutdown.into_message()),
            WorkerFailure::Failed(error) => (true, error),
        })
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

async fn run_in_worker_with_cpu_fallback(
    app: &tauri::AppHandle,
    mut config: OnnxGpuConfig,
    request_type: &str,
    model_path: &Path,
    extra: &Value,
    task_id: &str,
    progress_event: Option<&str>,
    timeout_secs: u64,
) -> Result<Value, String> {
    loop {
        let result = run_in_worker(
            app,
            &config,
            request_type,
            model_path,
            extra,
            task_id,
            progress_event,
            timeout_secs,
        )
        .await;
        match result {
            Err((true, error)) if config.ep == "directml" => {
                let worker = match request_type {
                    "matting" => "Matting Worker",
                    "asr" => "ASR Worker",
                    _ => "Worker",
                };
                eprintln!("[onnxrt] DirectML {worker} 失败: {error} → 标记 CPU 并重试");
                // 切到 CPU 后，下一次的结果直接返回。
                config.ep = "cpu".to_string();
                config.device_id = None;
                config.device_name = None;
                let _ = config.save();
            }
            result => return result.map_err(|(_, error)| error),
        }
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

    let config = get_or_probe_gpu_config(&model_path).await?;

    let extra = json!({
        "input_path": input_path,
        "output_path": output_path,
    });

    let value = run_in_worker_with_cpu_fallback(
        &app,
        config,
        "upscale",
        &model_path,
        &extra,
        &task_id,
        Some("image-upscale-progress"),
        300,
    )
    .await?;
    let result = value.get("result").ok_or("超分响应缺少 result 字段")?;
    let input_size = result
        .get("input_size")
        .and_then(|s| s.as_str())
        .unwrap_or("?x?");
    let output_size = result
        .get("output_size")
        .and_then(|s| s.as_str())
        .unwrap_or("?x?");
    Ok(json!({
        "output_path": output_path,
        "input_size": input_size,
        "output_size": output_size,
    })
    .to_string())
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

    let config = get_or_probe_gpu_config(&model_path).await?;

    let extra = json!({
        "input_path": input_path,
        "output_path": output_path,
    });

    let value = run_in_worker_with_cpu_fallback(
        &app,
        config,
        "matting",
        &model_path,
        &extra,
        &task_id,
        None, // matting 无需进度（单次推理，很快）
        120,
    )
    .await?;
    let result = value.get("result").ok_or("主体识别响应缺少 result 字段")?;
    let subject_path = result
        .get("subject_path")
        .and_then(|s| s.as_str())
        .unwrap_or(&output_path);
    let input_size = result
        .get("input_size")
        .and_then(|s| s.as_str())
        .unwrap_or("?x?");
    Ok(json!({
        "subject_path": subject_path,
        "input_size": input_size,
    })
    .to_string())
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

    let config = get_or_probe_gpu_config(&model_path).await?;

    let extra = json!({
        "input_path": input_path,
        "vocab_path": vocab_path.to_string_lossy(),
        "language": language.unwrap_or_default(),
    });

    let value = run_in_worker_with_cpu_fallback(
        &app,
        config,
        "asr",
        &model_path,
        &extra,
        &task_id,
        Some("speech-to-text-progress"),
        ASR_TIMEOUT_SECS,
    )
    .await?;
    parse_asr_result(&value)
}

// ════════════════════════════════════════════════
// Tauri 命令：角色 8 向图自动拆分
// ════════════════════════════════════════════════

mod direction_grid;
use direction_grid::{compose_character_direction_grid, unique_sibling_png, DIRECTION_CELL_SIZE};

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
mod direction_grid_tests;
