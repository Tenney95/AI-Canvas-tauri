use base64::Engine;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::{path::PathBuf, time::Duration};
use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{
    ipc::Channel, Listener, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_fs::FsExt;
use url::Url;

mod assistant_web;
mod clipboard;
mod comfyui;
mod director_desk_runtime;
mod dreamina;
mod file_transfer;
pub mod onnx;
mod provider_docs;

static CHAT_WINDOW_LOCKED: AtomicBool = AtomicBool::new(false);
static CHAT_WINDOW_LOCK_OFFSET: Mutex<(i32, i32)> = Mutex::new((0, 0));
static CHAT_WINDOW_SIZE_SAVE_VERSION: AtomicU64 = AtomicU64::new(0);
static PROXY_FETCH_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static PROXY_FETCH_CANCELLATIONS: OnceLock<
    Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
> = OnceLock::new();

const CHAT_WINDOW_DEFAULT_SIZE: (f64, f64) = (480.0, 720.0);
const CHAT_WINDOW_MIN_SIZE: (f64, f64) = (360.0, 480.0);
const CHAT_WINDOW_SIZE_FILE: &str = "chat-window-size.json";

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
fn apply_chat_window_rounded_corners(window: &WebviewWindow) {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND},
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);
    let preference = DWMWCP_ROUND;
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
fn apply_chat_window_rounded_corners(_window: &WebviewWindow) {}

/// 将用户明确选择的保存目录和素材目录加入本次进程的文件与 asset 协议 scope。
/// ComfyUI 安装目录不经过此命令，仍由专用启动命令独立校验。
#[tauri::command]
fn sync_authorized_directories(
    app: tauri::AppHandle,
    directories: Vec<String>,
) -> Result<Vec<String>, String> {
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
/// 请求体和响应体均使用 base64 编码传输，支持 GET/POST 等任意方法。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyFetchRequest {
    request_id: Option<String>,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>, // base64 编码的请求体
}

fn proxy_fetch_cancellations() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>
{
    PROXY_FETCH_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn cancel_proxy_fetch(request_id: String) -> Result<(), String> {
    let cancellation = proxy_fetch_cancellations()
        .lock()
        .map_err(|_| "读取 HTTP 请求取消状态失败".to_string())?
        .remove(&request_id);
    if let Some(sender) = cancellation {
        let _ = sender.send(());
    }
    Ok(())
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

async fn send_proxy_request(req: &ProxyFetchRequest) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("无效的 HTTP 方法: {e}"))?;
    let mut request = client.request(method, &req.url);
    for (key, value) in &req.headers {
        request = request.header(key.as_str(), value.as_str());
    }
    if let Some(body) = &req.body {
        if !body.is_empty() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(body)
                .map_err(|e| format!("请求体 base64 解码失败: {e}"))?;
            request = request.body(bytes);
        }
    }

    request.send().await.map_err(|e| format!("请求失败: {e}"))
}

#[tauri::command]
async fn proxy_fetch(req: ProxyFetchRequest) -> Result<ProxyFetchResponse, String> {
    let request_id = req.request_id.clone().unwrap_or_else(|| {
        format!(
            "legacy-proxy-{}",
            PROXY_FETCH_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    proxy_fetch_cancellations()
        .lock()
        .map_err(|_| "注册 HTTP 请求取消状态失败".to_string())?
        .insert(request_id.clone(), cancel_sender);

    let request = async move {
        let response = send_proxy_request(&req).await?;

        let status = response.status().as_u16();
        let res_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let res_bytes = response
            .bytes()
            .await
            .map_err(|e| format!("读取响应失败: {e}"))?;
        let body_b64 = base64::engine::general_purpose::STANDARD.encode(&res_bytes);

        Ok(ProxyFetchResponse {
            status,
            body: body_b64,
            headers: res_headers,
        })
    };

    let result = tokio::select! {
        result = request => result,
        _ = cancel_receiver => Err("请求已取消".to_string()),
    };
    if let Ok(mut cancellations) = proxy_fetch_cancellations().lock() {
        cancellations.remove(&request_id);
    }
    result
}

#[tauri::command]
async fn proxy_stream_fetch(
    req: ProxyFetchRequest,
    on_event: Channel<ProxyFetchStreamEvent>,
) -> Result<(), String> {
    let request_id = req
        .request_id
        .clone()
        .ok_or_else(|| "流式 HTTP 请求缺少 requestId".to_string())?;
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    proxy_fetch_cancellations()
        .lock()
        .map_err(|_| "注册 HTTP 请求取消状态失败".to_string())?
        .insert(request_id.clone(), cancel_sender);

    let request = async move {
        let mut response = send_proxy_request(&req).await?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_str().unwrap_or("").to_string()))
            .collect();
        on_event
            .send(ProxyFetchStreamEvent::Meta { status, headers })
            .map_err(|e| format!("发送 HTTP 响应状态失败: {e}"))?;

        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|error| format!("读取响应失败: {error}"))?
        {
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

    let result = tokio::select! {
        result = request => result,
        _ = cancel_receiver => Err("请求已取消".to_string()),
    };
    if let Ok(mut cancellations) = proxy_fetch_cancellations().lock() {
        cancellations.remove(&request_id);
    }
    result
}

/// 使用原生 HTTP 客户端下载远程图片并返回 base64 data URL（绕过 WebView CORS 限制）
#[tauri::command]
async fn fetch_image_data_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("AI-Canvas/0.1")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

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

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 将文件或目录移动到系统回收站/废纸篓
#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(std::path::Path::new(&path)).map_err(|e| format!("移动文件到回收站失败: {}", e))
}

/// 使用指定应用打开文件（直接调用系统进程 API，绕过 shell 插件权限限制）
#[tauri::command]
async fn open_with_app(app_path: String, file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&app_path)
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("启动应用失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", &app_path, &file_path])
            .spawn()
            .map_err(|e| format!("启动应用失败: {e}"))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app_path, file_path);
        return Err("不支持的操作系统".to_string());
    }
    Ok(())
}

/// 在系统文件管理器中打开目录，或定位并选中文件。
/// 路径会先规范化，避免系统文件管理器在参数无效时回退到默认目录。
#[tauri::command]
async fn reveal_in_file_manager(path: String, select: bool) -> Result<(), String> {
    let canonical_path = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("目标路径不存在或无法访问（{path}）: {e}"))?;

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
    CHAT_WINDOW_LOCKED.store(false, Ordering::Release);

    // 先关闭可能残留的历史窗口
    if let Some(old) = app.get_webview_window("chat-assistant") {
        persist_current_chat_window_size(&old);
        let _ = old.close();
    }

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
    apply_chat_window_rounded_corners(&chat_window);

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

    Ok(())
}

/// 关闭独立的 AI 对话助手窗口
#[tauri::command]
async fn close_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    CHAT_WINDOW_LOCKED.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window("chat-assistant") {
        persist_current_chat_window_size(&window);
        window
            .close()
            .map_err(|e| format!("关闭对话窗口失败: {e}"))?;
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
    // Windows WebView2/Chromium 渲染优化：
    // - CalculateNativeWinOcclusion：原生窗口遮挡检测。在虚拟显示适配器 / 远程桌面
    //   工具（MuMu、向日葵、Virtual Display 等）环境下常误判窗口被遮挡，从而节流甚至
    // - 其余 flag 强制 GPU 光栅化 / 忽略黑名单 / 解除帧率上限。
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=CalculateNativeWinOcclusion --enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy --disable-frame-rate-limit",
    );

    tauri::Builder::default()
        .register_uri_scheme_protocol("director-desk", director_desk_runtime::handle_protocol)
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            fetch_image_data_url,
            proxy_fetch,
            proxy_stream_fetch,
            cancel_proxy_fetch,
            assistant_web::assistant_web_search,
            assistant_web::assistant_web_extract,
            provider_docs::provider_docs_read,
            file_transfer::copy_file_streamed,
            file_transfer::download_file_streamed,
            file_transfer::cancel_file_transfer,
            director_desk_runtime::director_desk_runtime_status,
            director_desk_runtime::install_director_desk_runtime,
            director_desk_runtime::cancel_director_desk_install,
            director_desk_runtime::remove_director_desk_runtime,
            move_to_trash,
            clipboard::copy_files_to_clipboard,
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
            sync_authorized_directories,
            comfyui::launch_comfyui,
            onnx::get_models_dir,
            onnx::check_model_exists,
            onnx::image_upscale,
            onnx::subject_matting,
            onnx::character_direction_grid,
            onnx::download_onnx_model,
            onnx::get_onnx_gpu_status,
        ])
        .on_window_event(|window, event| {
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
        .setup(|_app| {
            // 调试构建自动打开 DevTools（方便排查打包后白屏等问题）
            #[cfg(debug_assertions)]
            {
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
