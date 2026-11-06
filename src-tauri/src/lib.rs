//! AI Canvas Tauri 库入口，装配插件、窗口、命令、事件与原生服务状态。

use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::{path::PathBuf, time::Duration};
use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{
    ipc::Channel, Listener, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_fs::FsExt;
use url::Url;

#[path = "agent/package.rs"]
mod agent_package;
#[path = "agent/codex_contract.rs"]
mod codex_contract;
#[path = "agent/codex_process.rs"]
mod codex_process;
#[path = "agent/codex_protocol.rs"]
mod codex_protocol;
#[path = "agent/codex_runtime.rs"]
mod codex_runtime;
#[path = "agent/web.rs"]
mod assistant_web;
#[cfg_attr(not(windows), allow(dead_code, unused_imports))]
#[path = "director/blender_runtime/mod.rs"]
mod blender_runtime;
mod canvas_input;
mod billing;
mod native_rendering;
#[path = "files/clipboard.rs"]
mod clipboard;
#[path = "files/clipboard_read.rs"]
mod clipboard_read;
#[path = "media/comfyui/mod.rs"]
mod comfyui;
#[path = "director/desk_runtime.rs"]
mod director_desk_runtime;
#[path = "media/dreamina.rs"]
mod dreamina;
#[path = "files/transfer.rs"]
mod file_transfer;
#[path = "files/object_storage/mod.rs"]
mod project_asset_storage;
#[path = "files/github_fallback.rs"]
mod github_fallback;
mod app_update;
#[path = "files/thumbnail_cache.rs"]
mod thumbnail_cache;
#[path = "files/theme_assets.rs"]
mod theme_assets;
#[path = "media/local_fonts.rs"]
mod local_fonts;
#[path = "media/reference_image_upload.rs"]
mod reference_image_upload;
#[path = "mcp/bridge.rs"]
mod mcp_bridge;
#[path = "mcp/client.rs"]
mod mcp_client;
#[cfg(feature = "local-onnx")]
#[path = "media/model_mirror.rs"]
mod model_mirror;
#[cfg(feature = "local-onnx")]
#[path = "media/onnx/mod.rs"]
pub mod onnx;
#[cfg(not(feature = "local-onnx"))]
pub mod onnx {
    const UNSUPPORTED_MESSAGE: &str =
        "x64-legacy 版本为兼容不支持 AVX 的 CPU，未包含本地 ONNX Runtime";

    fn unsupported<T>() -> Result<T, String> {
        Err(UNSUPPORTED_MESSAGE.to_string())
    }

    #[tauri::command]
    pub fn get_models_dir() -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub fn check_model_exists(_model_name: String) -> Result<bool, String> {
        unsupported()
    }

    #[tauri::command]
    pub fn list_onnx_models(_webview: tauri::Webview) -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub fn remove_onnx_model(_webview: tauri::Webview, _model_name: String) -> Result<(), String> {
        unsupported()
    }

    #[tauri::command]
    pub async fn download_onnx_model(
        _app: tauri::AppHandle,
        _model_name: String,
        _url: String,
        _task_id: String,
    ) -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub fn get_onnx_gpu_status() -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub async fn image_upscale(
        _app: tauri::AppHandle,
        _webview: tauri::Webview,
        _input_path: String,
        _output_path: String,
        _model_name: String,
        _task_id: String,
    ) -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub async fn subject_matting(
        _app: tauri::AppHandle,
        _webview: tauri::Webview,
        _input_path: String,
        _output_path: String,
        _model_name: String,
        _task_id: String,
    ) -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub async fn character_direction_grid(
        _app: tauri::AppHandle,
        _webview: tauri::Webview,
        _input_path: String,
    ) -> Result<String, String> {
        unsupported()
    }

    #[tauri::command]
    pub async fn speech_to_text(
        _app: tauri::AppHandle,
        _webview: tauri::Webview,
        _input_path: String,
        _model_name: String,
        _vocab_name: String,
        _task_id: String,
        _language: Option<String>,
    ) -> Result<String, String> {
        unsupported()
    }
}
mod path_policy;
// 源文件按领域归类；crate 根模块名保持稳定，避免改变 IPC、测试与安全调用路径。
#[path = "plugins/registry.rs"]
mod plugin_registry;
#[path = "plugins/install_permissions.rs"]
pub mod plugin_install_permissions;
#[path = "plugins/runtime.rs"]
mod plugin_runtime;
#[path = "plugins/host_effects.rs"]
mod plugin_host_effects;
#[path = "plugins/artifacts.rs"]
mod plugin_artifacts;
#[path = "plugins/ui.rs"]
mod plugin_ui;
#[path = "plugins/window.rs"]
mod plugin_window;
#[path = "files/project_archive.rs"]
mod project_archive;
#[path = "files/skill_archive.rs"]
mod skill_archive;
#[path = "agent/provider_docs.rs"]
mod provider_docs;
mod secret_store;
#[path = "media/sprite_export.rs"]
mod sprite_export;
#[path = "media/sprite_processing.rs"]
mod sprite_processing;

static CHAT_WINDOW_LOCKED: AtomicBool = AtomicBool::new(false);
static CHAT_WINDOW_LOCK_OFFSET: Mutex<(i32, i32)> = Mutex::new((0, 0));
static CHAT_WINDOW_SIZE_SAVE_VERSION: AtomicU64 = AtomicU64::new(0);
static CHAT_WINDOW_LIFECYCLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PROXY_FETCH_REQUEST_ID: AtomicU64 = AtomicU64::new(0);

const CHAT_WINDOW_DEFAULT_SIZE: (f64, f64) = (480.0, 720.0);
const CHAT_WINDOW_MIN_SIZE: (f64, f64) = (360.0, 480.0);
const CHAT_WINDOW_SIZE_FILE: &str = "chat-window-size.json";
const PROXY_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROXY_HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const PROXY_HTTP_MAX_IDLE_PER_HOST: usize = 8;
const PROXY_RESPONSE_MAX_BYTES: usize = 64 * 1024 * 1024;
// 兼容既有 64 MiB 视频素材，并给 multipart 头部留出空间。
const PROXY_REQUEST_MAX_BYTES: usize = 65 * 1024 * 1024;
const REMOTE_IMAGE_MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
struct ChatWindowSizeState {
    width: f64,
    height: f64,
}

fn chat_window_size_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CHAT_WINDOW_SIZE_FILE))
        .map_err(|e| format!("读取应用数据目录失败: {e}"))
}

fn persist_chat_window_size(
    app: &tauri::AppHandle,
    physical_size: PhysicalSize<u32>,
    scale_factor: f64,
) -> Result<(), String> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Ok(());
    }
    let state = ChatWindowSizeState {
        width: physical_size.width as f64 / scale_factor,
        height: physical_size.height as f64 / scale_factor,
    };
    if state.width < CHAT_WINDOW_MIN_SIZE.0 || state.height < CHAT_WINDOW_MIN_SIZE.1 {
        return Ok(());
    }

    let path = chat_window_size_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建窗口状态目录失败: {e}"))?;
    }
    let json = serde_json::to_string(&state).map_err(|e| format!("序列化窗口尺寸失败: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("保存窗口尺寸失败: {e}"))
}

fn persist_current_chat_window_size(window: &WebviewWindow) {
    if let (Ok(size), Ok(scale_factor)) = (window.inner_size(), window.scale_factor()) {
        let _ = persist_chat_window_size(window.app_handle(), size, scale_factor);
    }
}

fn load_chat_window_size(
    app: &tauri::AppHandle,
    main_window: Option<&WebviewWindow>,
) -> (f64, f64) {
    let saved = chat_window_size_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<ChatWindowSizeState>(&json).ok())
        .filter(|state| {
            state.width.is_finite()
                && state.height.is_finite()
                && state.width >= CHAT_WINDOW_MIN_SIZE.0
                && state.height >= CHAT_WINDOW_MIN_SIZE.1
        });
    let mut width = saved
        .as_ref()
        .map(|state| state.width)
        .unwrap_or(CHAT_WINDOW_DEFAULT_SIZE.0);
    let mut height = saved
        .as_ref()
        .map(|state| state.height)
        .unwrap_or(CHAT_WINDOW_DEFAULT_SIZE.1);

    if let Some(monitor) = main_window.and_then(|window| window.current_monitor().ok().flatten()) {
        let scale_factor = monitor.scale_factor();
        if scale_factor.is_finite() && scale_factor > 0.0 {
            let monitor_size = monitor.size();
            let max_width = monitor_size.width as f64 / scale_factor * 0.95;
            let max_height = monitor_size.height as f64 / scale_factor * 0.95;
            width = width.min(max_width.max(CHAT_WINDOW_MIN_SIZE.0));
            height = height.min(max_height.max(CHAT_WINDOW_MIN_SIZE.1));
        }
    }

    (width, height)
}

#[cfg(target_os = "windows")]
fn apply_native_window_corners(window: &WebviewWindow, rounded: bool) {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT, DWMWCP_ROUND,
        },
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);
    let preference = if rounded {
        DWMWCP_ROUND
    } else {
        DWMWCP_DEFAULT
    };
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_native_window_corners(_window: &WebviewWindow, _rounded: bool) {}

#[tauri::command]
fn set_main_window_native_corners(app: tauri::AppHandle, rounded: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口".to_string())?;
    apply_native_window_corners(&window, rounded);
    Ok(())
}

/// 将用户明确选择的保存目录和素材目录加入本次进程的文件与 asset 协议 scope。
/// ComfyUI 安装目录不经过此命令，仍由专用启动命令独立校验。
///
/// `base_data_dir` 另外会被记为原生侧的用户存储根：需要落到用户目录的派生数据
/// （例如智能体压缩包解压目录）由它定位，从而不必占用系统盘。
#[tauri::command]
fn sync_authorized_directories(
    app: tauri::AppHandle,
    directories: Vec<String>,
    base_data_dir: Option<String>,
) -> Result<Vec<String>, String> {
    path_policy::set_user_storage_root(&app, base_data_dir.as_deref());

    let fs_scope = app.fs_scope();
    let asset_scope = app.state::<tauri::scope::Scopes>();
    let mut rejected = Vec::new();

    for directory in directories {
        let trimmed = directory.trim();
        if trimmed.is_empty() {
            continue;
        }

        let path = std::path::PathBuf::from(trimmed);
        if !path.is_absolute() {
            rejected.push(trimmed.to_string());
            continue;
        }

        let Ok(canonical) = path.canonicalize() else {
            rejected.push(trimmed.to_string());
            continue;
        };
        if !canonical.is_dir() {
            rejected.push(trimmed.to_string());
            continue;
        }

        fs_scope
            .allow_directory(&canonical, true)
            .map_err(|e| format!("文件权限授权失败 {}: {e}", canonical.display()))?;
        asset_scope
            .allow_directory(&canonical, true)
            .map_err(|e| format!("asset 协议授权失败 {}: {e}", canonical.display()))?;
    }

    Ok(rejected)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct DreaminaLoginPayload {
    cookie: String,
}

/// 注入到即梦登录窗口的 JS：轮询 Cookie + DOM 观察，登录成功后通过 event.emit 回传凭证
const DREAMINA_LOGIN_WATCHER: &str = r#"
(function(){
  if (window.__dreaminaWatcher) return;
  window.__dreaminaWatcher = true;

  function sendCookie() {
    var c = document.cookie || '';
    // 登录成功的 Cookie 通常较长，包含 session/token 等关键字段
    if (c.length > 80) {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('dreamina-cookie', { cookie: c });
      }
    }
  }

  // 1. 每 2 秒轮询 Cookie
  var pollTimer = setInterval(sendCookie, 2000);

  // 2. 观察 DOM 变化（登录模态框关闭时触发）
  var obsTimer;
  var observer = new MutationObserver(function() {
    clearTimeout(obsTimer);
    obsTimer = setTimeout(sendCookie, 600);
  });

  setTimeout(function() {
    observer.observe(document.body, { childList: true, subtree: true, attributes: false, characterData: false });
  }, 3000);

  // 3. 兜底：120 秒后强制检查
  setTimeout(function() {
    clearInterval(pollTimer);
    sendCookie();
  }, 120000);
})();
"#;

/// 通用 HTTP 代理：前端通过 invoke 调用，由 Rust 端发起 HTTP 请求，彻底绕过浏览器 CORS 限制。
/// 文本请求直接传 UTF-8，二进制请求和响应分块仍兼容 base64。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyFetchRequest {
    request_id: Option<String>,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>, // base64 编码的请求体
    text_body: Option<String>,
}

// 分别限制在途请求和提前到达的取消；128 项远高于正常模型与工具并发。
const PROXY_MAX_ACTIVE_REQUESTS: usize = 128;
const PROXY_MAX_EARLY_CANCELLATIONS: usize = 128;
const PROXY_MAX_REQUEST_ID_BYTES: usize = 256;
const PROXY_CANCELLATIONS_OVERFLOWED: &str =
    "HTTP 取消登记已满；为避免已停止的请求重新发送，已暂停新请求，请重启应用后重试";

#[derive(Default)]
struct ProxyCancellationRegistry {
    active: HashMap<String, Option<tokio::sync::oneshot::Sender<()>>>,
    early_cancelled: HashSet<String>,
    overflowed: bool,
}

type ProxyFetchCancellations = Mutex<ProxyCancellationRegistry>;

fn is_public_proxy_download(req: &ProxyFetchRequest) -> bool {
    if !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.body.is_some()
        || req.text_body.is_some()
        || !req.headers.is_empty()
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&req.url) else {
        return false;
    };
    // 查询参数也可能承载任意名称的 Key，不能靠参数名猜测是否公开。
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
}

fn proxy_redirect_rejection(
    target: &reqwest::Url,
    previous: &[reqwest::Url],
    same_origin_only: bool,
) -> Option<&'static str> {
    // previous 的第一项是初始地址，和 reqwest 默认行为一样允许 10 次跳转。
    if previous.len() > 10 {
        return Some("HTTP 重定向次数超过上限");
    }
    if !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Some("HTTP 重定向地址不安全");
    }
    let (Some(origin), Some(source)) = (previous.first(), previous.last()) else {
        return Some("HTTP 重定向缺少来源信息");
    };
    if source.scheme() == "https" && target.scheme() != "https" {
        return Some("HTTP 重定向不能降低传输安全级别");
    }
    if same_origin_only && target.origin() != origin.origin() {
        return Some("带凭据或非公开的 HTTP 请求不能跨来源重定向");
    }
    None
}

fn build_proxy_http_client(same_origin_only: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("AI-Canvas/0.1")
        .connect_timeout(PROXY_HTTP_CONNECT_TIMEOUT)
        .pool_idle_timeout(PROXY_HTTP_POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(PROXY_HTTP_MAX_IDLE_PER_HOST)
        // 自动 Referer 会夹带上一跳的查询参数，公共下载也不应自动暴露它们。
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if let Some(reason) = proxy_redirect_rejection(
                attempt.url(), attempt.previous(), same_origin_only,
            ) {
                attempt.error(reason)
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败: {error}"))
}

struct ProxyHttpState {
    client: reqwest::Client,
    download_client: reqwest::Client,
    cancellations: ProxyFetchCancellations,
    body_slots: tokio::sync::Semaphore,
}

impl ProxyHttpState {
    fn new() -> Result<Self, String> {
        Ok(Self {
            client: build_proxy_http_client(true)?,
            download_client: build_proxy_http_client(false)?,
            cancellations: Mutex::default(),
            body_slots: tokio::sync::Semaphore::new(2),
        })
    }
}

fn lock_proxy_fetch_cancellations(
    cancellations: &ProxyFetchCancellations,
) -> std::sync::MutexGuard<'_, ProxyCancellationRegistry> {
    cancellations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn validate_proxy_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > PROXY_MAX_REQUEST_ID_BYTES {
        return Err("HTTP 请求 ID 无效，长度必须为 1–256 个 UTF-8 字节".into());
    }
    Ok(())
}

struct ProxyFetchCancellationRegistration<'a> {
    request_id: String,
    cancellations: &'a ProxyFetchCancellations,
}

impl<'a> ProxyFetchCancellationRegistration<'a> {
    fn register(
        cancellations: &'a ProxyFetchCancellations,
        request_id: String,
        sender: tokio::sync::oneshot::Sender<()>,
    ) -> Result<Self, String> {
        validate_proxy_request_id(&request_id)?;
        let mut items = lock_proxy_fetch_cancellations(cancellations);
        if items.active.contains_key(&request_id) {
            return Err("HTTP 请求 ID 重复，请等待原请求结束后重试".into());
        }
        if items.early_cancelled.remove(&request_id) {
            return Err("请求已取消".into());
        }
        if items.overflowed {
            return Err(PROXY_CANCELLATIONS_OVERFLOWED.into());
        }
        if items.active.len() >= PROXY_MAX_ACTIVE_REQUESTS {
            return Err("同时进行的 HTTP 请求已达 128 个，请等待已有请求结束后重试".into());
        }
        items.active.insert(request_id.clone(), Some(sender));
        drop(items);

        Ok(Self {
            request_id,
            cancellations,
        })
    }
}

impl Drop for ProxyFetchCancellationRegistration<'_> {
    fn drop(&mut self) {
        lock_proxy_fetch_cancellations(self.cancellations)
            .active
            .remove(&self.request_id);
    }
}

fn cancel_proxy_request(cancellations: &ProxyFetchCancellations, request_id: &str) -> Result<(), String> {
    validate_proxy_request_id(request_id)?;
    let cancellation = {
        let mut items = lock_proxy_fetch_cancellations(cancellations);
        if let Some(sender) = items.active.get_mut(request_id) {
            // 取消后仍保留占位，旧请求清理前不能让同 ID 的新请求注册进来。
            sender.take()
        } else {
            if items.early_cancelled.contains(request_id) {
                return Ok(());
            }
            if items.overflowed || items.early_cancelled.len() >= PROXY_MAX_EARLY_CANCELLATIONS {
                // 丢过的取消 ID 已无法还原，不能靠等待或清空 Map 重新放行。
                items.overflowed = true;
                return Err(PROXY_CANCELLATIONS_OVERFLOWED.into());
            }
            items.early_cancelled.insert(request_id.to_string());
            return Ok(());
        }
    };
    if let Some(sender) = cancellation {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
fn cancel_proxy_fetch(
    state: tauri::State<'_, ProxyHttpState>,
    request_id: String,
) -> Result<(), String> {
    cancel_proxy_request(&state.cancellations, &request_id)
}

async fn run_cancellable_proxy_request<T>(
    cancel_receiver: tokio::sync::oneshot::Receiver<()>,
    request: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancel_receiver => Err("请求已取消".to_string()),
        result = request => result,
    }
}

#[derive(Clone, serde::Serialize)]
struct ProxyFetchResponse {
    status: u16,
    body: String, // base64 编码的响应体
    headers: Vec<(String, String)>,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum ProxyFetchStreamEvent {
    Meta {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        body: String,
    },
    Done,
}

fn proxy_transport_error(error: reqwest::Error) -> String {
    if error.is_redirect() {
        return "请求失败：HTTP 重定向被安全策略拒绝，请使用同源地址或最终资源地址。若这是生成提交，请先核对服务商任务记录，不要直接重发。".into();
    }
    let kind = if error.is_timeout() {
        "网络请求超时"
    } else if error.is_connect() {
        "无法建立网络连接"
    } else if error.is_body() {
        "请求体传输失败"
    } else {
        "发送请求或等待响应时连接失败"
    };
    // 只提取系统错误类别和错误码，不把 URL、查询参数或凭据写入历史。
    let mut source = std::error::Error::source(&error);
    let mut detail = String::new();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            detail = format!("（{:?}，系统错误码 {:?}）", io.kind(), io.raw_os_error());
            break;
        }
        source = cause.source();
    }
    format!("请求失败：{kind}{detail}。未收到有效 HTTP 响应，提交结果尚未确认，请先检查服务商任务记录。")
}

async fn send_proxy_request(
    state: &ProxyHttpState,
    req: ProxyFetchRequest,
) -> Result<reqwest::Response, String> {
    if req.body.is_some() && req.text_body.is_some() {
        return Err("请求体格式重复".into());
    }
    let has_body = req.body.is_some() || req.text_body.is_some();
    if req.text_body.as_ref().is_some_and(|body| body.len() > PROXY_REQUEST_MAX_BYTES)
        || req.body.as_ref().is_some_and(|body| {
            body.len() > PROXY_REQUEST_MAX_BYTES.div_ceil(3) * 4
        })
    {
        return Err("请求内容超过 65 MiB，请减少参考素材后重试".into());
    }
    let _body_slot = if has_body {
        Some(state.body_slots.acquire().await.map_err(|_| "请求队列已关闭")?)
    } else {
        None
    };
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("无效的 HTTP 方法: {e}"))?;
    // Key 可以放进任意合法请求头，只有明确无调用方请求头的下载才允许跨来源。
    let client = if is_public_proxy_download(&req) {
        &state.download_client
    } else {
        &state.client
    };
    let mut request = client.request(method, &req.url);
    for (key, value) in req.headers {
        request = request.header(key, value);
    }
    if let Some(body) = req.text_body {
        request = request.body(body);
    } else if let Some(body) = req.body {
        if !body.is_empty() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&body)
                .map_err(|e| format!("请求体 base64 解码失败: {e}"))?;
            if bytes.len() > PROXY_REQUEST_MAX_BYTES {
                return Err("请求内容超过 65 MiB，请减少参考素材后重试".into());
            }
            request = request.body(bytes);
        }
    }

    request.send().await.map_err(proxy_transport_error)
}

fn ensure_content_length_within_limit(
    response: &reqwest::Response,
    max_bytes: usize,
    resource_name: &str,
) -> Result<(), String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!(
            "{resource_name}超过 Rust 端大小限制（最大 {} MiB）",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(())
}

fn checked_response_size(
    current_bytes: usize,
    chunk_bytes: usize,
    max_bytes: usize,
    resource_name: &str,
) -> Result<usize, String> {
    let next_bytes = current_bytes
        .checked_add(chunk_bytes)
        .ok_or_else(|| format!("{resource_name}大小计算溢出"))?;
    if next_bytes > max_bytes {
        return Err(format!(
            "{resource_name}超过 Rust 端大小限制（最大 {} MiB）",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(next_bytes)
}

async fn read_response_bytes_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
    resource_name: &str,
) -> Result<Vec<u8>, String> {
    ensure_content_length_within_limit(&response, max_bytes, resource_name)?;
    let initial_capacity = response.content_length().unwrap_or(0).min(max_bytes as u64) as usize;
    let mut body = Vec::with_capacity(initial_capacity);
    let mut total_bytes = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?
    {
        total_bytes = checked_response_size(total_bytes, chunk.len(), max_bytes, resource_name)?;
        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

#[tauri::command]
async fn proxy_fetch(
    state: tauri::State<'_, ProxyHttpState>,
    req: ProxyFetchRequest,
) -> Result<ProxyFetchResponse, String> {
    let request_id = req.request_id.clone().unwrap_or_else(|| {
        format!(
            "legacy-proxy-{}",
            PROXY_FETCH_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let _cancellation = ProxyFetchCancellationRegistration::register(
        &state.cancellations,
        request_id,
        cancel_sender,
    )?;

    let request = async {
        let response = send_proxy_request(&state, req).await?;

        let status = response.status().as_u16();
        let res_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let res_bytes =
            read_response_bytes_limited(response, PROXY_RESPONSE_MAX_BYTES, "代理响应体").await?;
        let body_b64 = base64::engine::general_purpose::STANDARD.encode(&res_bytes);

        Ok(ProxyFetchResponse {
            status,
            body: body_b64,
            headers: res_headers,
        })
    };

    run_cancellable_proxy_request(cancel_receiver, request).await
}

#[tauri::command]
async fn proxy_stream_fetch(
    state: tauri::State<'_, ProxyHttpState>,
    req: ProxyFetchRequest,
    on_event: Channel<ProxyFetchStreamEvent>,
) -> Result<(), String> {
    let request_id = req
        .request_id
        .clone()
        .ok_or_else(|| "流式 HTTP 请求缺少 requestId".to_string())?;
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let _cancellation = ProxyFetchCancellationRegistration::register(
        &state.cancellations,
        request_id,
        cancel_sender,
    )?;

    let request = async {
        let mut response = send_proxy_request(&state, req).await?;
        ensure_content_length_within_limit(&response, PROXY_RESPONSE_MAX_BYTES, "代理响应体")?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_str().unwrap_or("").to_string()))
            .collect();
        on_event
            .send(ProxyFetchStreamEvent::Meta { status, headers })
            .map_err(|e| format!("发送 HTTP 响应状态失败: {e}"))?;

        let mut total_bytes = 0;
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|error| format!("读取响应失败: {error}"))?
        {
            total_bytes = checked_response_size(
                total_bytes,
                bytes.len(),
                PROXY_RESPONSE_MAX_BYTES,
                "代理响应体",
            )?;
            let body = base64::engine::general_purpose::STANDARD.encode(bytes);
            on_event
                .send(ProxyFetchStreamEvent::Chunk { body })
                .map_err(|e| format!("发送 HTTP 响应数据失败: {e}"))?;
        }
        on_event
            .send(ProxyFetchStreamEvent::Done)
            .map_err(|e| format!("结束 HTTP 响应流失败: {e}"))?;
        Ok(())
    };

    run_cancellable_proxy_request(cancel_receiver, request).await
}

/// 使用原生 HTTP 客户端下载远程图片并返回 base64 data URL（绕过 WebView CORS 限制）
#[tauri::command]
async fn fetch_image_data_url(
    state: tauri::State<'_, ProxyHttpState>,
    url: String,
) -> Result<String, String> {
    let response = send_proxy_request(&state, ProxyFetchRequest {
        request_id: None,
        url: url.clone(),
        method: "GET".into(),
        headers: Vec::new(),
        body: None,
        text_body: None,
    }).await?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    // 从 Content-Type 头推导 MIME（提前提取为 String，避免借用冲突）
    let mime = {
        let ct = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            .unwrap_or("image/png")
            .trim();
        if ct.starts_with("image/") {
            ct.to_string()
        } else {
            // 从 URL 后缀推导
            let lower = url.to_lowercase();
            let guess = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
                "image/jpeg"
            } else if lower.ends_with(".gif") {
                "image/gif"
            } else if lower.ends_with(".webp") {
                "image/webp"
            } else if lower.ends_with(".bmp") {
                "image/bmp"
            } else if lower.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "image/png"
            };
            guess.to_string()
        }
    };

    let bytes = read_response_bytes_limited(response, REMOTE_IMAGE_MAX_BYTES, "远程图片").await?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[cfg(test)]
mod proxy_http_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn test_request(url: String, method: &str) -> ProxyFetchRequest {
        ProxyFetchRequest {
            request_id: None, url, method: method.into(), headers: Vec::new(),
            body: None, text_body: None,
        }
    }

    fn read_test_request(listener: &TcpListener) -> (TcpStream, String) {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "未收到预期测试请求");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("接收测试请求失败: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
            assert!(bytes.len() < 16 * 1024, "测试请求头超过上限");
        }
        let headers = String::from_utf8(bytes.clone()).unwrap();
        let body_len = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        }).unwrap_or(0);
        assert!(body_len < 1024, "测试请求体超过上限");
        let mut body = vec![0; body_len];
        stream.read_exact(&mut body).unwrap();
        bytes.extend_from_slice(&body);
        (stream, String::from_utf8(bytes).unwrap())
    }

    fn serve_test_responses(
        listener: TcpListener,
        responses: Vec<String>,
    ) -> std::thread::JoinHandle<Vec<String>> {
        std::thread::spawn(move || responses.into_iter().map(|response| {
            let (mut stream, request) = read_test_request(&listener);
            stream.write_all(response.as_bytes()).unwrap();
            request
        }).collect())
    }

    #[test]
    fn only_headerless_and_queryless_get_or_head_downloads_are_public() {
        for method in ["GET", "HEAD"] {
            let request = test_request("https://cdn.example/image.png".into(), method);
            assert!(is_public_proxy_download(&request));
        }
        for url in [
            "https://cdn.example/image.png?arbitrary-name=private-key",
            "https://cdn.example/image.png?",
            "https://user:secret@cdn.example/image.png",
            "ftp://cdn.example/image.png",
            "not a URL",
        ] {
            assert!(!is_public_proxy_download(&test_request(url.into(), "GET")));
        }
        for header in ["Authorization", "X-API-Key", "X-Goog-Api-Key", "X-Private-Token", "Accept", "Range"] {
            let mut request = test_request("https://cdn.example/image.png".into(), "GET");
            request.headers.push((header.into(), "private-key".into()));
            assert!(!is_public_proxy_download(&request));
        }
        let mut request = test_request("https://api.example/generate".into(), "POST");
        assert!(!is_public_proxy_download(&request));
        request.method = "GET".into();
        request.text_body = Some(String::new());
        assert!(!is_public_proxy_download(&request));
        request.text_body = None;
        request.body = Some(String::new());
        assert!(!is_public_proxy_download(&request));
    }

    #[test]
    fn redirect_policy_checks_origins_downgrades_target_credentials_and_hop_limit() {
        let origin = reqwest::Url::parse("https://api.example/start").unwrap();
        for strict in [true, false] {
            for target in [
                "http://api.example/final", "file:///private/resource",
                "https://user:secret@api.example/final",
            ] {
                let target = reqwest::Url::parse(target).unwrap();
                assert!(proxy_redirect_rejection(&target, &[origin.clone()], strict).is_some());
            }
            let target = reqwest::Url::parse("https://api.example/final").unwrap();
            assert!(proxy_redirect_rejection(&target, &[], strict).is_some());
            assert!(proxy_redirect_rejection(&target, &vec![origin.clone(); 11], strict).is_some());
            assert!(proxy_redirect_rejection(&target, &vec![origin.clone(); 10], strict).is_none());
        }
        for target in ["https://other.example/final", "https://api.example:444/final"] {
            let target = reqwest::Url::parse(target).unwrap();
            assert!(proxy_redirect_rejection(&target, &[origin.clone()], true).is_some());
            assert!(proxy_redirect_rejection(&target, &[origin.clone()], false).is_none());
        }
        let default_port = reqwest::Url::parse("https://api.example:443/final").unwrap();
        assert!(proxy_redirect_rejection(&default_port, &[origin], true).is_none());
        let upgraded = reqwest::Url::parse("https://cdn.example/final").unwrap();
        let insecure = reqwest::Url::parse("http://download.example/start").unwrap();
        assert!(proxy_redirect_rejection(&upgraded, &[insecure], false).is_none());
    }

    #[tokio::test]
    async fn explicit_headers_queries_and_post_bodies_never_reach_a_redirected_origin() {
        let state = ProxyHttpState::new().unwrap();
        let mut cases = Vec::new();
        for header in ["Authorization", "X-API-Key", "X-Goog-Api-Key", "X-Private-Token", "aCcEpT", "Range"] {
            for status in ["302 Found", "307 Temporary Redirect"] {
                cases.push((Some(header), "GET", status, false));
            }
        }
        cases.extend([(None, "GET", "302 Found", true), (None, "POST", "307 Temporary Redirect", false)]);
        for (header, method, status, query) in cases {
            let target = TcpListener::bind("127.0.0.1:0").unwrap();
            target.set_nonblocking(true).unwrap();
            let source = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut request = test_request(format!("http://{}/start", source.local_addr().unwrap()), method);
            if let Some(header) = header { request.headers.push((header.into(), "private-key".into())); }
            if query { request.url.push_str("?arbitrary-name=private-key"); }
            if method == "POST" { request.text_body = Some("private request body".into()); }
            let server = serve_test_responses(source, vec![format!(
                "HTTP/1.1 {status}\r\nLocation: http://{}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                target.local_addr().unwrap(),
            )]);
            let message = send_proxy_request(&state, request).await.unwrap_err();
            assert!(message.contains("请求失败"));
            assert!(message.contains("重定向被安全策略拒绝"));
            assert!(!message.contains("private-key"));
            assert!(!message.contains("127.0.0.1"));
            assert_eq!(server.join().unwrap().len(), 1);
            assert!(matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
        }
    }

    #[tokio::test]
    async fn public_downloads_follow_cross_origin_redirects_without_automatic_referer() {
        let state = ProxyHttpState::new().unwrap();
        for method in ["GET", "HEAD"] {
            let target = TcpListener::bind("127.0.0.1:0").unwrap();
            let source = TcpListener::bind("127.0.0.1:0").unwrap();
            let request = test_request(format!("http://{}/start", source.local_addr().unwrap()), method);
            let source_server = serve_test_responses(source, vec![format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{}/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                target.local_addr().unwrap(),
            )]);
            let target_server = serve_test_responses(target, vec![
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
            ]);
            let response = send_proxy_request(&state, request).await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            assert_eq!(source_server.join().unwrap().len(), 1);
            let requests = target_server.join().unwrap();
            assert!(requests[0].starts_with(&format!("{method} /final ")));
            assert!(!requests[0].to_ascii_lowercase().contains("\r\nreferer:"));
        }
    }

    #[tokio::test]
    async fn same_origin_307_preserves_headers_and_post_body() {
        let state = ProxyHttpState::new().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut request = test_request(format!("http://{}/start", listener.local_addr().unwrap()), "POST");
        request.headers.push(("X-Private-Token".into(), "private-key".into()));
        request.text_body = Some("private request body".into());
        let server = serve_test_responses(listener, vec![
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
        ]);
        assert_eq!(send_proxy_request(&state, request).await.unwrap().status(), reqwest::StatusCode::OK);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("POST /final "));
        assert!(requests[1].to_ascii_lowercase().contains("\r\nx-private-token: private-key\r\n"));
        assert!(requests[1].ends_with("private request body"));
        assert!(!requests[1].to_ascii_lowercase().contains("\r\nreferer:"));
    }

    #[tokio::test]
    async fn duplicate_bodies_are_rejected_before_waiting_for_a_slot() {
        let req: ProxyFetchRequest = serde_json::from_value(serde_json::json!({
            "url": "http://127.0.0.1:1/", "method": "POST", "headers": [],
            "body": "YQ==", "textBody": "文本"
        })).unwrap();
        let state = ProxyHttpState { body_slots: tokio::sync::Semaphore::new(0), ..ProxyHttpState::new().unwrap() };
        let result = tokio::time::timeout(
            Duration::from_millis(200), send_proxy_request(&state, req),
        ).await.expect("格式错误不应排队或发送");
        assert!(result.unwrap_err().contains("格式重复"));
    }

    #[tokio::test]
    async fn invalid_legacy_base64_releases_its_slot_without_sending() {
        let req: ProxyFetchRequest = serde_json::from_value(serde_json::json!({
            "url": "http://127.0.0.1:1/", "method": "POST", "headers": [], "body": "invalid!"
        })).unwrap();
        assert!(req.text_body.is_none());
        let state = ProxyHttpState { body_slots: tokio::sync::Semaphore::new(1), ..ProxyHttpState::new().unwrap() };
        let result = send_proxy_request(&state, req).await;
        assert!(result.unwrap_err().contains("base64"));
        assert_eq!(state.body_slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn transport_errors_do_not_expose_request_url_or_credentials() {
        let error = reqwest::Client::new()
            .get("http://user:secret@127.0.0.1:1/?api_key=private-key")
            .header("invalid header", "value")
            .send()
            .await
            .unwrap_err();
        let message = proxy_transport_error(error);
        assert!(message.contains("提交结果尚未确认"));
        assert!(!message.contains("secret"));
        assert!(!message.contains("private-key"));
        assert!(!message.contains("127.0.0.1"));
    }

    #[test]
    fn response_size_limit_accepts_exact_limit_and_rejects_overflow() {
        assert_eq!(checked_response_size(60, 4, 64, "测试响应"), Ok(64));
        assert!(checked_response_size(60, 5, 64, "测试响应").is_err());
        assert!(checked_response_size(usize::MAX, 1, usize::MAX, "测试响应").is_err());
    }

    #[test]
    fn cancellation_registration_cleans_up_when_dropped() {
        let cancellations = Mutex::default();
        let (sender, _receiver) = tokio::sync::oneshot::channel();

        {
            let _registration = ProxyFetchCancellationRegistration::register(
                &cancellations,
                "request-1".to_string(),
                sender,
            )
            .expect("应成功注册取消句柄");
            assert!(lock_proxy_fetch_cancellations(&cancellations)
                .active
                .contains_key("request-1"));
        }

        assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
    }

    #[test]
    fn early_cancellation_waits_for_registration_without_expiring_or_growing_on_duplicates() {
        let cancellations = Mutex::default();
        cancel_proxy_request(&cancellations, "delayed-request").unwrap();
        cancel_proxy_request(&cancellations, "delayed-request").unwrap();
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let other = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "other-request".into(),
            sender,
        )
        .unwrap();
        drop(other);
        assert_eq!(
            lock_proxy_fetch_cancellations(&cancellations).early_cancelled.len(),
            1
        );

        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let error = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "delayed-request".into(),
            sender,
        )
        .err()
        .expect("提前取消的请求不能开始发送");
        assert_eq!(error, "请求已取消");
        let registry = lock_proxy_fetch_cancellations(&cancellations);
        assert!(registry.active.is_empty());
        assert!(registry.early_cancelled.is_empty());
        assert!(!registry.overflowed);
    }

    #[test]
    fn cancelled_active_id_remains_reserved_until_its_registration_drops() {
        let cancellations = Mutex::default();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        let registration = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "active-request".into(),
            sender,
        )
        .unwrap();
        cancel_proxy_request(&cancellations, "active-request").unwrap();
        assert_eq!(receiver.try_recv(), Ok(()));
        cancel_proxy_request(&cancellations, "active-request").unwrap();
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let error = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "active-request".into(),
            sender,
        )
        .err()
        .expect("旧请求结束前不能复用 ID");
        assert!(error.contains("重复"));
        assert!(lock_proxy_fetch_cancellations(&cancellations)
            .early_cancelled
            .is_empty());
        drop(registration);
        assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let replacement = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "active-request".into(),
            sender,
        )
        .unwrap();
        drop(replacement);
        assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
    }

    #[test]
    fn early_cancellation_overflow_fails_closed_even_after_known_ids_are_consumed() {
        let cancellations = Mutex::default();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        let active = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "active-request".into(),
            sender,
        )
        .unwrap();
        for index in 0..PROXY_MAX_EARLY_CANCELLATIONS {
            cancel_proxy_request(&cancellations, &format!("early-{index}")).unwrap();
        }
        cancel_proxy_request(&cancellations, "early-0").unwrap();
        assert!(cancel_proxy_request(&cancellations, "unrecorded-cancellation")
            .unwrap_err()
            .contains("重启"));
        // 饱和后仍要接收已有请求的取消，不能因保护状态锁住停止入口。
        cancel_proxy_request(&cancellations, "active-request").unwrap();
        assert_eq!(receiver.try_recv(), Ok(()));
        drop(active);
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let consumed = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "early-0".into(),
            sender,
        )
        .err()
        .expect("已记录的提前取消仍应消费");
        assert_eq!(consumed, "请求已取消");
        for index in 0..1024 {
            assert!(cancel_proxy_request(&cancellations, &format!("overflow-{index}")).is_err());
        }
        for id in ["new-request", "unrecorded-cancellation"] {
            let (sender, _receiver) = tokio::sync::oneshot::channel();
            let error =
                ProxyFetchCancellationRegistration::register(&cancellations, id.into(), sender)
                    .err()
                    .expect("无法还原的取消必须让后续注册保持关闭");
            assert!(error.contains("重启"));
        }
        let registry = lock_proxy_fetch_cancellations(&cancellations);
        assert!(registry.active.is_empty());
        assert_eq!(
            registry.early_cancelled.len(),
            PROXY_MAX_EARLY_CANCELLATIONS - 1
        );
        assert!(registry.overflowed);
    }

    #[test]
    fn active_request_limit_recovers_when_an_existing_registration_drops() {
        let cancellations = Mutex::default();
        let mut registrations = Vec::new();
        for index in 0..PROXY_MAX_ACTIVE_REQUESTS {
            let (sender, _receiver) = tokio::sync::oneshot::channel();
            registrations.push(
                ProxyFetchCancellationRegistration::register(
                    &cancellations,
                    format!("active-{index}"),
                    sender,
                )
                .unwrap(),
            );
        }
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let error = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "over-capacity".into(),
            sender,
        )
        .err()
        .expect("在途请求必须有界");
        assert!(error.contains("等待已有请求"));
        drop(registrations.pop());
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        registrations.push(
            ProxyFetchCancellationRegistration::register(
                &cancellations,
                "after-capacity-released".into(),
                sender,
            )
            .unwrap(),
        );
        drop(registrations);
        let registry = lock_proxy_fetch_cancellations(&cancellations);
        assert!(registry.active.is_empty());
        assert!(!registry.overflowed);
    }

    #[test]
    fn invalid_request_ids_never_allocate_cancellation_state() {
        let cancellations = Mutex::default();
        for id in [
            String::new(),
            "a".repeat(PROXY_MAX_REQUEST_ID_BYTES + 1),
            "中".repeat(86),
        ] {
            assert!(cancel_proxy_request(&cancellations, &id).is_err());
            let (sender, _receiver) = tokio::sync::oneshot::channel();
            assert!(
                ProxyFetchCancellationRegistration::register(&cancellations, id, sender).is_err()
            );
        }
        let boundary = format!("{}a", "中".repeat(85));
        assert_eq!(boundary.len(), PROXY_MAX_REQUEST_ID_BYTES);
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        let valid =
            ProxyFetchCancellationRegistration::register(&cancellations, boundary, sender).unwrap();
        drop(valid);
        let registry = lock_proxy_fetch_cancellations(&cancellations);
        assert!(registry.active.is_empty());
        assert!(registry.early_cancelled.is_empty());
        assert!(!registry.overflowed);
    }

    #[tokio::test]
    async fn registered_cancellation_is_checked_before_polling_the_network_request() {
        let cancellations = Mutex::default();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let registration = ProxyFetchCancellationRegistration::register(
            &cancellations,
            "not-started".into(),
            sender,
        )
        .unwrap();
        cancel_proxy_request(&cancellations, "not-started").unwrap();
        let mut polled = false;
        let request = async {
            polled = true;
            Ok(())
        };
        let result = run_cancellable_proxy_request(receiver, request).await;
        assert_eq!(result.unwrap_err(), "请求已取消");
        assert!(!polled);
        drop(registration);
        assert!(lock_proxy_fetch_cancellations(&cancellations).active.is_empty());
    }
}

/// 将文件或目录移动到系统回收站/废纸篓。
/// 只接受应用自有数据目录或用户已授权目录内的路径，避免被注入的 Renderer 删除任意文件。
#[tauri::command]
async fn move_to_trash(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    path: String,
) -> Result<(), String> {
    path_policy::ensure_trusted_caller(&webview)?;
    let target = path_policy::authorize_path(&app, &path, path_policy::PathAccess::Read)?;
    trash::delete(&target).map_err(|e| format!("移动文件到回收站失败: {}", e))
}

/// 使用指定应用打开文件（直接调用系统进程 API，绕过 shell 插件权限限制）。
/// 待打开文件必须已授权，被启动的程序必须是系统已安装应用且不在应用可写目录内。
#[tauri::command]
async fn open_with_app(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    app_path: String,
    file_path: String,
) -> Result<(), String> {
    path_policy::ensure_trusted_caller(&webview)?;
    let target = path_policy::authorize_path(&app, &file_path, path_policy::PathAccess::Read)?;
    let launch_target = path_policy::authorize_launch_target(&app, &app_path)?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&launch_target)
            .arg(&target)
            .spawn()
            .map_err(|e| format!("启动应用失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        // open 能启动不代表找到了应用；等它确认后，前端才停止尝试下一个候选。
        let status = tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(launch_target)
                .arg(target)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        })
        .await
        .map_err(|_| "启动应用任务失败，请重试".to_string())?
        .map_err(|_| "无法启动应用，请检查应用安装状态".to_string())?;
        if !status.success() {
            return Err("应用未能打开文件，请检查应用安装状态与文件类型".to_string());
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (launch_target, target);
        return Err("不支持的操作系统".to_string());
    }
    Ok(())
}

/// 在系统文件管理器中打开目录，或定位并选中文件。
/// 路径会先校验授权并规范化：既避免暴露任意目录，也避免系统文件管理器在参数无效时回退到默认目录。
#[tauri::command]
async fn reveal_in_file_manager(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    path: String,
    select: bool,
) -> Result<(), String> {
    path_policy::ensure_trusted_caller(&webview)?;
    // 设置面板里可以定位应用安装目录，因此这里额外允许自身安装/资源目录。
    let canonical_path = path_policy::authorize_path_with_roots(
        &app,
        &path,
        path_policy::PathAccess::Read,
        &path_policy::app_install_roots(&app),
    )?;

    if !select && !canonical_path.is_dir() {
        return Err(format!(
            "要打开的路径不是文件夹: {}",
            canonical_path.display()
        ));
    }

    #[cfg(target_os = "windows")]
    {
        // `canonicalize` 在 Windows 上通常返回 `\\?\` 扩展路径；Explorer 对该前缀支持不稳定。
        let canonical_text = canonical_path.to_string_lossy();
        let explorer_path = if let Some(path) = canonical_text.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{path}")
        } else if let Some(path) = canonical_text.strip_prefix(r"\\?\") {
            path.to_string()
        } else {
            canonical_text.into_owned()
        };
        let mut command = std::process::Command::new("explorer.exe");
        if select {
            command.arg("/select,");
        }
        command
            .arg(explorer_path)
            .spawn()
            .map_err(|e| format!("启动 Windows 资源管理器失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if select {
            command.arg("-R");
        }
        command
            .arg(&canonical_path)
            .spawn()
            .map_err(|e| format!("启动 Finder 失败: {e}"))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let target_path = if select && canonical_path.is_file() {
            canonical_path
                .parent()
                .ok_or_else(|| format!("无法确定文件所在目录: {}", canonical_path.display()))?
        } else {
            canonical_path.as_path()
        };
        std::process::Command::new("xdg-open")
            .arg(target_path)
            .spawn()
            .map_err(|e| format!("启动文件管理器失败: {e}"))?;
    }

    Ok(())
}

/// 切换当前 WebView 的开发者工具（先关闭再打开实现 toggle 效果）
#[tauri::command]
async fn toggle_devtools(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("未找到主窗口".to_string())?;
    window.close_devtools();
    window.open_devtools();
    Ok(())
}

/// 打开独立的 AI 对话助手窗口
#[tauri::command]
async fn open_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = CHAT_WINDOW_LIFECYCLE_LOCK.lock().await;
    // 复用当前窗口，保留输入、同步握手及位置锁；close 是异步事件，不能同名立即重建。
    if let Some(window) = app.get_webview_window("chat-assistant") {
        window
            .unminimize()
            .map_err(|e| format!("恢复对话窗口失败: {e}"))?;
        window
            .show()
            .map_err(|e| format!("显示对话窗口失败: {e}"))?;
        window
            .set_focus()
            .map_err(|e| format!("聚焦对话窗口失败: {e}"))?;
        return Ok(());
    }
    CHAT_WINDOW_LOCKED.store(false, Ordering::Release);

    #[cfg(debug_assertions)]
    let url = WebviewUrl::External(
        Url::parse("http://localhost:1420/?view=chat").map_err(|e| e.to_string())?,
    );
    #[cfg(not(debug_assertions))]
    let url = WebviewUrl::App("index.html?view=chat".into());

    let main_window = app.get_webview_window("main");
    let (chat_width, chat_height) = load_chat_window_size(&app, main_window.as_ref());
    let chat_window_effects = EffectsBuilder::new()
        .effects([Effect::HudWindow, Effect::Acrylic])
        .state(EffectState::FollowsWindowActiveState)
        .radius(16.0)
        .color(Color(10, 10, 15, 178))
        .build();
    let mut chat_window_builder = WebviewWindowBuilder::new(&app, "chat-assistant", url)
        .title("AI 对话助手")
        .inner_size(chat_width, chat_height)
        .min_inner_size(360.0, 480.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .effects(chat_window_effects)
        .visible(false);

    if let Some(parent) = main_window.as_ref() {
        chat_window_builder = chat_window_builder
            .parent(parent)
            .map_err(|e| format!("绑定对话窗口到主窗口失败: {e}"))?;
    }

    let chat_window = chat_window_builder
        .build()
        .map_err(|e| format!("创建对话窗口失败: {e}"))?;
    apply_native_window_corners(&chat_window, true);

    // 与主窗口内的助手面板保持一致：显示在主窗口右侧，并留出相同的边距。
    let positioned = if let Some(main_window) = main_window {
        match (
            main_window.outer_position(),
            main_window.outer_size(),
            main_window.scale_factor(),
            chat_window.outer_size(),
        ) {
            (Ok(main_position), Ok(main_size), Ok(scale_factor), Ok(chat_size)) => {
                let right_margin = (10.0 * scale_factor).round() as i32;
                let top_margin = (30.0 * scale_factor).round() as i32;
                let x = main_position.x + main_size.width as i32
                    - chat_size.width as i32
                    - right_margin;
                let y = main_position.y + top_margin;
                chat_window
                    .set_position(PhysicalPosition::new(x, y))
                    .is_ok()
            }
            _ => false,
        }
    } else {
        false
    };

    if !positioned {
        let _ = chat_window.center();
    }
    chat_window
        .show()
        .map_err(|e| format!("显示对话窗口失败: {e}"))?;
    chat_window
        .set_focus()
        .map_err(|e| format!("聚焦对话窗口失败: {e}"))?;

    Ok(())
}

/// 关闭独立的 AI 对话助手窗口
#[tauri::command]
async fn close_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = CHAT_WINDOW_LIFECYCLE_LOCK.lock().await;
    CHAT_WINDOW_LOCKED.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window("chat-assistant") {
        persist_current_chat_window_size(&window);
        window
            .close()
            .map_err(|e| format!("关闭对话窗口失败: {e}"))?;
        // 等注册表释放标签后再允许下一次打开，防止快速收回/重开命中旧窗口。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while app.get_webview_window("chat-assistant").is_some() {
            if tokio::time::Instant::now() >= deadline {
                return Err("对话窗口尚未完成关闭，请稍后重试".to_string());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    Ok(())
}

/// 锁定或解锁对话窗口与主窗口的相对位置。
#[tauri::command]
async fn set_chat_window_locked(app: tauri::AppHandle, locked: bool) -> Result<(), String> {
    if locked {
        let main_window = app
            .get_webview_window("main")
            .ok_or("未找到主窗口".to_string())?;
        let chat_window = app
            .get_webview_window("chat-assistant")
            .ok_or("未找到对话窗口".to_string())?;
        let main_position = main_window
            .outer_position()
            .map_err(|e| format!("读取主窗口位置失败: {e}"))?;
        let chat_position = chat_window
            .outer_position()
            .map_err(|e| format!("读取对话窗口位置失败: {e}"))?;

        let mut offset = CHAT_WINDOW_LOCK_OFFSET
            .lock()
            .map_err(|_| "保存对话窗口锁定位置失败".to_string())?;
        *offset = (
            chat_position.x - main_position.x,
            chat_position.y - main_position.y,
        );
    }

    CHAT_WINDOW_LOCKED.store(locked, Ordering::Release);
    Ok(())
}

#[tauri::command]
async fn dreamina_login(app: tauri::AppHandle) -> Result<DreaminaLoginPayload, String> {
    let login_url = "https://jimeng.jianying.com/";

    // 先关闭可能残留的历史登录窗口
    if let Some(old) = app.get_webview_window("dreamina-login") {
        let _ = old.close();
    }

    let webview = WebviewWindowBuilder::new(
        &app,
        "dreamina-login",
        WebviewUrl::External(Url::parse(login_url).map_err(|e| e.to_string())?),
    )
    .title("即梦登录 — 登录后自动关闭")
    .inner_size(800.0, 660.0)
    .center()
    .resizable(true)
    .visible(true)
    .build()
    .map_err(|e| format!("创建登录窗口失败: {e}"))?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));

    // 监听 webview 发来的 cookie 事件
    let event_id = app.listen("dreamina-cookie", move |event: tauri::Event| {
        if let Ok(payload) = serde_json::from_str::<DreaminaLoginPayload>(event.payload()) {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(payload.cookie);
            }
        }
    });

    // 等页面加载完成后注入 Cookie 轮询脚本
    let webview_clone = webview.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let _ = webview_clone.eval(DREAMINA_LOGIN_WATCHER);
    });

    // 等待 cookie（最多 180 秒）
    let cookie = tokio::time::timeout(std::time::Duration::from_secs(180), rx)
        .await
        .map_err(|_| "登录超时，请重试".to_string())?
        .map_err(|_| "登录已取消".to_string())?;

    app.unlisten(event_id);

    // 关闭登录窗口
    let _ = webview.close();

    if cookie.is_empty() {
        return Err("未获取到登录凭证，请确认登录成功".to_string());
    }

    Ok(DreaminaLoginPayload { cookie })
}

pub fn run() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(windows)]
    let main_window_config = native_rendering::defer_main_window(context.config_mut());
    // Windows WebView2/Chromium 渲染优化：
    // - CalculateNativeWinOcclusion：原生窗口遮挡检测。在虚拟显示适配器 / 远程桌面
    //   工具（MuMu、向日葵、Virtual Display 等）环境下常误判窗口被遮挡，从而错误节流。
    // - 其余生产参数强制 GPU 光栅化并忽略黑名单，但保留 Chromium 默认帧率限制。
    // - 仅诊断时可设置 AI_CANVAS_DISABLE_FRAME_RATE_LIMIT=1 临时解除帧率限制。
    #[cfg(target_os = "windows")]
    {
        let mut browser_arguments = String::from(
            "--disable-features=CalculateNativeWinOcclusion --enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy",
        );
        if std::env::var("AI_CANVAS_DISABLE_FRAME_RATE_LIMIT").as_deref() == Ok("1") {
            browser_arguments.push_str(" --disable-frame-rate-limit");
        }
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", browser_arguments);
    }

    let proxy_http_state = ProxyHttpState::new().expect("初始化代理 HTTP 客户端失败");

    let builder = tauri::Builder::default().on_page_load(|webview, payload| {
        #[cfg(target_os = "macos")]
        native_rendering::record_main_page_load(webview, payload);
        comfyui::media_source::on_page_load(webview, payload);
    });
    #[cfg(target_os = "macos")]
    let builder = builder
        .on_web_content_process_terminate(native_rendering::recover_web_content);

    builder
        .manage(native_rendering::NativeRenderingState::default())
        .manage(proxy_http_state)
        .manage(comfyui::management::ManagementState::default())
        .manage(comfyui::runtime_console::ComfyUIRuntimeState::default())
        .manage(comfyui::progress::ComfyProgressState::default())
        .manage(comfyui::media_source::ComfyMediaState::default())
        .manage(comfyui::installer::ComfyUIInstallerState::default())
        .manage(comfyui::model_dedupe::ModelDedupeState::default())
        .manage(blender_runtime::BlenderRuntimeState::default())
        .manage(blender_runtime::ProjectGrantState::default())
        .manage(blender_runtime::production_blender_job_core())
        .manage(mcp_bridge::McpBridgeState::default())
        .manage(mcp_client::McpClientState::default())
        .manage(codex_runtime::CodexRuntimeState::default())
        .manage(project_asset_storage::ObjectStorageState::default())
        .manage(path_policy::UserStorageRoot::default())
        .manage(billing::BillingStoragePath::default())
        .register_uri_scheme_protocol("director-desk", director_desk_runtime::handle_protocol)
        .register_uri_scheme_protocol("plugin-ui", plugin_ui::handle_protocol)
        .register_uri_scheme_protocol("plugin-window", plugin_window::handle_protocol)
        .register_uri_scheme_protocol("theme-image", theme_assets::handle_protocol)
        .register_asynchronous_uri_scheme_protocol("comfy-media", comfyui::media_source::handle_protocol)
        .plugin(tauri_plugin_fs::init())
        .plugin(comfyui::installation::privacy_plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(canvas_input::init())
        .invoke_handler(tauri::generate_handler![
            theme_assets::store_theme_image,
            reference_image_upload::optimize_reference_png,
            reference_image_upload::optimize_reference_jpeg,
            billing::billing_upsert,
            billing::billing_query,
            billing::billing_get_by_task,
            billing::billing_clear_preview,
            billing::billing_clear,
            billing::billing_export,
            billing::billing_set_storage_path,
            billing::billing_get_storage_path,
            fetch_image_data_url,
            comfyui::media_source::open_comfy_media_source,
            comfyui::media_source::close_comfy_media_source,
            proxy_fetch,
            proxy_stream_fetch,
            cancel_proxy_fetch,
            assistant_web::assistant_web_search,
            assistant_web::assistant_web_extract,
            assistant_web::assistant_web_render,
            provider_docs::provider_docs_read,
            blender_runtime::discover_blender_installations,
            blender_runtime::register_blender_installation,
            blender_runtime::project_grant::create_blender_project_grant,
            blender_runtime::project_grant::revoke_blender_project_grant,
            blender_runtime::start_blender_job,
            blender_runtime::get_blender_job_status,
            blender_runtime::cancel_blender_job,
            blender_runtime::collect_blender_job_result,
            agent_package::agent_source_link,
            agent_package::agent_package_import_archive,
            agent_package::agent_source_probe,
            agent_package::agent_source_remove,
            agent_package::agent_source_read_text,
            project_archive::pack_project_archive,
            project_archive::unpack_project_archive,
            project_archive::inspect_project_archive_assets,
            project_archive::publish_project_import_assets,
            skill_archive::read_skill_archive,
            thumbnail_cache::prepare_project_thumbnail,
            thumbnail_cache::write_project_thumbnail,
            file_transfer::copy_file_streamed,
            file_transfer::copy_asset_folder,
            file_transfer::copy_asset_file_to_folder,
            file_transfer::finish_asset_file_move,
            file_transfer::download_file_streamed,
            app_update::download_app_update,
            file_transfer::cancel_file_transfer,
            project_asset_storage::project_asset_storage_snapshot,
            project_asset_storage::project_asset_storage_save_connection,
            project_asset_storage::project_asset_storage_remove_connection,
            project_asset_storage::project_asset_storage_bind_project,
            project_asset_storage::project_asset_storage_probe_project,
            project_asset_storage::project_asset_storage_unbind_project,
            project_asset_storage::project_asset_storage_cancel,
            project_asset_storage::project_asset_storage_preview_cleanup,
            project_asset_storage::project_asset_storage_apply_cleanup,
            project_asset_storage::project_asset_storage_preview_asset_delete,
            project_asset_storage::project_asset_storage_apply_asset_delete,
            project_asset_storage::project_asset_storage_list_heads,
            project_asset_storage::project_asset_storage_prepare_publish,
            project_asset_storage::project_asset_storage_publish_revision,
            project_asset_storage::project_asset_storage_download_revision,
            project_asset_storage::project_asset_storage_recover_operation,
            project_asset_storage::project_asset_storage_acknowledge_apply,
            director_desk_runtime::director_desk_runtime_status,
            director_desk_runtime::install_director_desk_runtime,
            director_desk_runtime::cancel_director_desk_install,
            director_desk_runtime::remove_director_desk_runtime,
            move_to_trash,
            clipboard::copy_files_to_clipboard,
            clipboard_read::read_canvas_clipboard,
            clipboard_read::read_asset_folder_clipboard,
            dreamina_login,
            dreamina::dreamina_login_start,
            dreamina::dreamina_login_runtime,
            dreamina::dreamina_logout,
            dreamina::dreamina_status,
            dreamina::dreamina_generate,
            dreamina::dreamina_query_result,
            open_chat_window,
            close_chat_window,
            set_chat_window_locked,
            open_with_app,
            reveal_in_file_manager,
            toggle_devtools,
            set_main_window_native_corners,
            native_rendering::sync_native_performance_mode,
            native_rendering::consume_webview_recovery,
            sync_authorized_directories,
            comfyui::launch_comfyui,
            comfyui::progress::stream_comfyui_progress,
            comfyui::progress::cancel_comfyui_progress,
            comfyui::runtime_console::get_comfyui_runtime_status,
            comfyui::installation::select_comfyui_installation,
            comfyui::installation::get_comfyui_installation,
            comfyui::installer::get_comfyui_install_info,
            comfyui::installer::choose_comfyui_install_target,
            comfyui::installer::install_comfyui_portable,
            comfyui::installer::cancel_comfyui_install,
            comfyui::open_comfyui_window,
            comfyui::complete_comfyui_workflow_save,
            comfyui::management::open_comfyui_settings_window,
            comfyui::management::get_comfyui_management_snapshot,
            comfyui::management::list_comfyui_versions,
            comfyui::management::apply_comfyui_repository_action,
            comfyui::management::list_comfyui_catalog,
            comfyui::management::install_comfyui_extension,
            comfyui::management::install_comfyui_dependencies,
            comfyui::management::cancel_comfyui_dependencies,
            comfyui::model_dedupe::scan_comfyui_duplicate_models,
            comfyui::model_dedupe::choose_comfyui_model_scan_root,
            comfyui::model_dedupe::cancel_comfyui_model_scan,
            comfyui::model_dedupe_links::apply_comfyui_model_deduplication,
            comfyui::model_dedupe_links::apply_comfyui_model_deduplication_batch,
            comfyui::model_dedupe_history::list_comfyui_model_dedupe_history,
            comfyui::model_dedupe_links::list_comfyui_model_dedupe_recoveries,
            comfyui::model_dedupe_links::recover_comfyui_model_dedupe,
            comfyui::launch_settings::get_comfyui_launch_settings,
            comfyui::launch_settings::save_comfyui_launch_settings,
            comfyui::runtime_console::start_comfyui_managed,
            comfyui::runtime_console::stop_comfyui_managed,
            comfyui::runtime_console::get_comfyui_runtime_snapshot,
            onnx::get_models_dir,
            onnx::check_model_exists,
            onnx::list_onnx_models,
            onnx::remove_onnx_model,
            onnx::image_upscale,
            onnx::subject_matting,
            onnx::speech_to_text,
            onnx::character_direction_grid,
            sprite_export::export_sprite_frames,
            sprite_processing::preview_sprite_sheet,
            onnx::download_onnx_model,
            onnx::get_onnx_gpu_status,
            mcp_bridge::mcp_bridge_start,
            mcp_bridge::mcp_bridge_stop,
            mcp_bridge::mcp_bridge_status,
            mcp_bridge::mcp_bridge_respond,
            mcp_client::mcp_client_configure,
            mcp_client::mcp_client_fetch,
            mcp_client::mcp_client_cancel,
            secret_store::secret_set,
            secret_store::secret_get,
            secret_store::secret_delete,
            secret_store::secret_store_available,
            codex_runtime::codex_runtime_status,
            codex_runtime::codex_runtime_register,
            codex_runtime::codex_runtime_configure,
            codex_runtime::codex_runtime_remove,
            codex_runtime::codex_runtime_start,
            codex_runtime::codex_runtime_cancel,
            codex_runtime::codex_runtime_collect,
            local_fonts::list_local_fonts,
            plugin_registry::stage_plugin_revision,
            plugin_registry::activate_plugin_revision,
            plugin_registry::ensure_plugin_registration,
            plugin_registry::set_plugin_registration_enabled,
            plugin_registry::remove_plugin_registration,
            plugin_registry::repair_plugin_registry,
            plugin_registry::get_plugin_registration_status,
            plugin_registry::read_plugin_package_resource,
            plugin_window::open_plugin_ui_window,
            plugin_window::close_plugin_ui_window,
            plugin_window::respond_plugin_ui_window_request,
            plugin_window::plugin_ui_window_request,
            plugin_runtime::execute_node_plugin_tool,
            plugin_runtime::cancel_node_plugin_tool,
            plugin_artifacts::prepare_plugin_media_workspace,
            plugin_artifacts::read_plugin_media_artifact,
            plugin_artifacts::release_plugin_media_workspace,
            plugin_host_effects::execute_plugin_host_effect,
            plugin_host_effects::cancel_plugin_host_effect,
            plugin_runtime::get_python_plugin_runtime_status,
        ])
        .on_window_event(|window, event| {
            plugin_window::on_window_event(window, event);
            comfyui::progress::on_window_event(window, event);
            comfyui::media_source::on_window_event(window, event);
            // 用户把文件拖进自有窗口 = 一次显式授权，登记后复制/读取命令才放行。
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if window.label() == "main" || window.label() == "chat-assistant" {
                    path_policy::grant_dropped_paths(window.app_handle(), paths);
                }
            }
            if window.label() == "chat-assistant" {
                if let tauri::WindowEvent::Resized(size) = event {
                    let Ok(scale_factor) = window.scale_factor() else {
                        return;
                    };
                    let app = window.app_handle().clone();
                    let size = *size;
                    let save_version =
                        CHAT_WINDOW_SIZE_SAVE_VERSION.fetch_add(1, Ordering::AcqRel) + 1;
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(350)).await;
                        if CHAT_WINDOW_SIZE_SAVE_VERSION.load(Ordering::Acquire) == save_version {
                            let _ = persist_chat_window_size(&app, size, scale_factor);
                        }
                    });
                }
                return;
            }
            if window.label() != "main" || !CHAT_WINDOW_LOCKED.load(Ordering::Acquire) {
                return;
            }
            let tauri::WindowEvent::Moved(main_position) = event else {
                return;
            };
            let Ok(offset) = CHAT_WINDOW_LOCK_OFFSET.lock() else {
                return;
            };
            if let Some(chat_window) = window.app_handle().get_webview_window("chat-assistant") {
                let _ = chat_window.set_position(PhysicalPosition::new(
                    main_position.x + offset.0,
                    main_position.y + offset.1,
                ));
            }
        })
        .setup(move |_app| {
            #[cfg(target_os = "macos")]
            native_rendering::record_app_started(_app.handle());
            // 凭据目录只允许本进程的 secret_* 命令访问：从 fs 与 asset scope 中拒掉，
            // 否则 Renderer 能绕过命令直接读走整份凭据文件
            secret_store::deny_secret_dir_access(_app.handle());
            // Agent 外部来源的真实路径只保存在 Rust 私有注册表中，Renderer 仅持有 sourceId。
            // 拒绝失败只影响 Agent 子系统的诊断，不得阻断普通功能启动。
            agent_package::deny_agent_private_dir_access(_app.handle());
            // 插件入口源码与活动/回滚版本只保存在 Rust 私有注册表中。
            plugin_registry::deny_plugin_private_dir_access(_app.handle());
            if let Err(error) = blender_runtime::prepare_blender_private_runtime(_app.handle()) {
                eprintln!("[blender-runtime] {error}");
            }

            #[cfg(windows)]
            native_rendering::create_main_window(_app, main_window_config)?;
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                codex_runtime::shutdown(app_handle);
                comfyui::progress::shutdown_progress(app_handle);
                comfyui::installer::shutdown_installation(app_handle);
                comfyui::runtime_console::shutdown_runtime(app_handle);
                comfyui::media_source::shutdown(app_handle);
                plugin_window::revoke_all_sessions();
                app_handle
                    .state::<blender_runtime::BlenderJobCore>()
                    .shutdown();
            }
        });
}
