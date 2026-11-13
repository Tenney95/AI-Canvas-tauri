//! A guest browser has no app bridge. The host imports one explicitly requested photo.
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};

use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    http::{Method, Request, Response as HttpResponse, StatusCode},
    ipc::Response,
    webview::{NewWindowResponse, WebviewBuilder},
    window::WindowBuilder,
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Runtime,
    UriSchemeContext, Webview, WebviewUrl, Window, WindowEvent,
};
use tokio::sync::oneshot;
use url::Url;

const HOME: &str = "https://www.xiaohongshu.com/explore";
const PREFIX: &str = "xiaohongshu-reference-";
const TOOLBAR_PREFIX: &str = "xiaohongshu-reference-toolbar-";
const TOOLBAR_SCHEME: &str = "xhs-reference-toolbar";
const TOOLBAR_HOST: &str = "localhost";
#[cfg(windows)]
const TOOLBAR_WINDOWS_HOST: &str = "xhs-reference-toolbar.localhost";
const TOOLBAR_HEIGHT: f64 = 36.0;
const TOOLBAR_PAGE: &str = include_str!("xiaohongshu_reference/toolbar.html");
const TOOLBAR_SCRIPT: &str = include_str!("xiaohongshu_reference/toolbar.js");
const TOOLBAR_STYLE: &str = include_str!("xiaohongshu_reference/toolbar.css");
const BASE_STYLE: &str = include_str!("../../../src/styles/base.css");
const UI_KIT_STYLE: &str = include_str!("../../../src/styles/ui-kit.css");
const IMPORT_REQUESTED: &str = "xiaohongshu-reference-import-requested";
const CLOSED: &str = "xiaohongshu-reference-closed";
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_URL_BYTES: usize = 4096;
const MAX_PAGE_REPLY_BYTES: usize = 12 * 1024;
const PHOTO_QUERY: &str = include_str!("xiaohongshu_reference/photo.js");
const GUEST_RESTRICTIONS: &str = include_str!("xiaohongshu_reference/guest.js");

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct Session {
    owner: String,
    navigation: Arc<AtomicU64>,
    import_requested: bool,
    importing: bool,
    import_label: String,
    importing_label: String,
    toolbar_theme: ToolbarTheme,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolbarTheme {
    #[default]
    Light,
    Dark,
}

impl ToolbarTheme {
    fn css_name(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    fn window_theme(self) -> tauri::Theme {
        match self {
            Self::Light => tauri::Theme::Light,
            Self::Dark => tauri::Theme::Dark,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent<'a> {
    session_id: &'a str,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolbarStatus {
    Ready,
    Importing,
    Imported,
    Failed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PagePhoto {
    page_url: String,
    image_url: String,
}

fn session_key(webview: &Webview, id: &str) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(webview)?;
    if !matches!(webview.label(), "main" | "asset-search")
        || id.len() != 32
        || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("小红书参考会话不可用".into());
    }
    Ok(format!("{PREFIX}{id}"))
}

fn toolbar_label(id: &str) -> String {
    format!("{TOOLBAR_PREFIX}{id}")
}

fn toolbar_path(url: &Url) -> Option<&str> {
    let origin_matches = match (url.scheme(), url.host_str()) {
        #[cfg(not(windows))]
        (TOOLBAR_SCHEME, Some(TOOLBAR_HOST)) => true,
        #[cfg(windows)]
        ("http", Some(TOOLBAR_WINDOWS_HOST)) => true,
        _ => false,
    };
    (origin_matches && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.query().is_none() && url.fragment().is_none()).then(|| url.path())
}

fn display_text(value: Option<String>, fallback: &str, limit: usize) -> String {
    let text: String = value.unwrap_or_default().trim().chars()
        .filter(|character| !character.is_control()).take(limit).collect();
    if text.is_empty() { fallback.to_owned() } else { text }
}

fn html_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&#39;")
}

pub fn toolbar_protocol<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> HttpResponse<Vec<u8>> {
    let origin_allowed = match (request.uri().scheme_str(), request.uri().authority().map(|authority| authority.as_str())) {
        (Some(TOOLBAR_SCHEME), Some(TOOLBAR_HOST)) => true,
        #[cfg(windows)]
        (Some("http"), Some(TOOLBAR_WINDOWS_HOST)) => true,
        _ => false,
    };
    let live = || {
        let id = context.webview_label().strip_prefix(TOOLBAR_PREFIX)?;
        let sessions = SESSIONS.lock().ok()?;
        sessions.get(&format!("{PREFIX}{id}")).cloned()
    };
    let platform_class = if cfg!(target_os = "macos") { "macos" } else { "desktop" };
    let page = if request.method() == Method::GET && origin_allowed && request.uri().query().is_none() {
        live().and_then(|session| match request.uri().path() {
            "/" => Some(("text/html; charset=utf-8", TOOLBAR_PAGE.replace("__PLATFORM__", platform_class)
                .replace("__THEME__", session.toolbar_theme.css_name())
                .replace("__IMPORT_LABEL__", &html_text(&session.import_label)).into_bytes())),
            "/toolbar.js" => Some(("text/javascript; charset=utf-8", TOOLBAR_SCRIPT.as_bytes().to_vec())),
            "/toolbar.css" => Some(("text/css; charset=utf-8", TOOLBAR_STYLE.as_bytes().to_vec())),
            "/base.css" => Some(("text/css; charset=utf-8", BASE_STYLE.as_bytes().to_vec())),
            "/ui-kit.css" => Some(("text/css; charset=utf-8", UI_KIT_STYLE.as_bytes().to_vec())),
            _ => None,
        })
    } else { None };
    let (status, content_type, body) = match page {
        Some((mime, bytes)) => (StatusCode::OK, mime, bytes),
        None => (StatusCode::FORBIDDEN, "text/plain; charset=utf-8", Vec::new()),
    };
    HttpResponse::builder().status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        .header("X-Content-Type-Options", "nosniff")
        .body(body).unwrap_or_else(|_| HttpResponse::new(Vec::new()))
}

fn toolbar_status(app: &AppHandle, id: &str, session: &Session, status: ToolbarStatus, message: &str) -> Result<(), String> {
    let toolbar = app.get_webview(&toolbar_label(id)).ok_or("小红书参考窗口已关闭")?;
    let label = if matches!(status, ToolbarStatus::Importing) { &session.importing_label } else { &session.import_label };
    let args = serde_json::json!({ "status": status, "label": label, "message": message });
    toolbar.eval(format!("window.setXhsToolbarStatus({args})"))
        .map_err(|_| "小红书参考窗口不可用".into())
}

fn request_import(app: &AppHandle, id: &str) {
    let label = format!("{PREFIX}{id}");
    let Some(current) = SESSIONS.lock().ok().and_then(|mut sessions| {
        let current = sessions.get_mut(&label)?;
        if current.import_requested || current.importing { return None; }
        current.import_requested = true;
        Some(current.clone())
    }) else { return; };
    let _ = toolbar_status(app, id, &current, ToolbarStatus::Importing, "");
    if app.emit_to(EventTarget::webview(current.owner.as_str()), IMPORT_REQUESTED, SessionEvent { session_id: id }).is_err() {
        if let Ok(mut sessions) = SESSIONS.lock() {
            if let Some(session) = sessions.get_mut(&label) { session.import_requested = false; }
        }
        let _ = toolbar_status(app, id, &current, ToolbarStatus::Failed, "无法通知角色工作台，请重试");
    }
}

#[cfg(windows)]
fn restrict_native_permissions(platform: tauri::webview::PlatformWebview) -> windows_core::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY,
        PermissionRequestedEventHandler,
    };
    let webview = unsafe { platform.controller().CoreWebView2()? };
    let mut token = 0;
    unsafe {
        webview.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        })), &mut token)
    }
}

fn allowed_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= MAX_URL_BYTES
}

fn allowed_site(url: &Url) -> bool {
    allowed_https(url) && matches!(url.host_str(), Some("www.xiaohongshu.com" | "xiaohongshu.com"))
}

fn note_id(url: &Url) -> Option<String> {
    if !allowed_site(url) {
        return None;
    }
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let id = ["/explore/", "/discovery/item/", "/search_result/"]
        .into_iter()
        .find_map(|prefix| path.strip_prefix(prefix))?;
    (id.len() == 24 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| id.to_ascii_lowercase())
}

fn image_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "当前照片地址不可用")?;
    let host_allowed = url.host_str().is_some_and(|host| {
        if host == "ci.xhscdn.com" {
            return true;
        }
        host.strip_prefix("sns-")
            .and_then(|name| name.strip_suffix(".xhscdn.com"))
            .is_some_and(|name| {
                !name.is_empty()
                    && name.len() <= 59
                    && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
    });
    if !allowed_https(&url) || !host_allowed {
        return Err("当前照片不在支持的小红书图片域名内".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn session(app: &AppHandle, label: &str, owner: &str) -> Result<(Session, Webview), String> {
    let session = SESSIONS
        .lock()
        .map_err(|_| "小红书参考会话不可用")?
        .get(label)
        .filter(|session| session.owner == owner)
        .cloned()
        .ok_or("小红书参考窗口已关闭")?;
    let guest = app
        .get_webview(label)
        .ok_or("小红书参考窗口已关闭")?;
    Ok((session, guest))
}

fn take_session(label: &str, owner: &str) -> Option<Session> {
    SESSIONS.lock().ok().and_then(|mut sessions| {
        if !sessions.get(label).is_some_and(|session| session.owner == owner) {
            return None;
        }
        sessions.remove(label)
    })
}

fn notify_closed(app: &AppHandle, label: &str, owner: &str) {
    if let Some(session_id) = label.strip_prefix(PREFIX) {
        let _ = app.emit_to(EventTarget::webview(owner), CLOSED, SessionEvent { session_id });
    }
}

fn revoke_session(app: &AppHandle, label: &str, owner: &str) -> Result<(), String> {
    let owns = SESSIONS.lock().map_err(|_| "小红书参考会话不可用")?.get(label)
        .is_some_and(|session| session.owner == owner);
    if !owns { return Ok(()); }
    if let Some(window) = app.get_window(label) {
        let focused = window.is_focused().unwrap_or(false);
        window.destroy().map_err(|_| "无法关闭小红书参考窗口")?;
        if focused {
            if let Some(owner_window) = app.get_window(owner) { let _ = owner_window.set_focus(); }
        }
    }
    if take_session(label, owner).is_some() { notify_closed(app, label, owner); }
    Ok(())
}

pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if !matches!(event, tauri::WindowEvent::Destroyed)
        || !matches!(window.label(), "main" | "asset-search")
    {
        return;
    }
    let labels: Vec<String> = SESSIONS.lock().ok().map(|sessions| {
        sessions.iter().filter(|(_, session)| session.owner == window.label())
            .map(|(label, _)| label.clone()).collect()
    }).unwrap_or_default();
    for label in labels {
        let _ = revoke_session(window.app_handle(), &label, window.label());
    }
}

struct OpenWindow {
    label: String,
    window: Option<Window>,
    temporary_profile: Option<PathBuf>,
    completed: bool,
}

fn ensure_profile_directory(path: &Path) -> Result<(), String> {
    const UNAVAILABLE: &str = "小红书独立浏览器目录不可用";
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    if let Err(error) = builder.create(path) {
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(UNAVAILABLE.into());
        }
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !metadata.is_dir() || crate::path_policy::is_link_or_reparse(&metadata) {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

fn profile_root(app: &AppHandle) -> Result<PathBuf, String> {
    let secrets = crate::secret_store::secret_dir(app)?;
    let base = secrets.parent().ok_or("小红书独立浏览器目录不可用")?;
    std::fs::create_dir_all(base).map_err(|_| "小红书独立浏览器目录不可用")?;
    ensure_profile_directory(&secrets)?;
    let root = secrets.join("xiaohongshu-reference");
    ensure_profile_directory(&root)?;
    Ok(root)
}

fn guest_profile(
    app: &AppHandle, guest: WebviewBuilder<tauri::Wry>, root: &Path, temporary_profile: &Path,
) -> Result<WebviewBuilder<tauri::Wry>, String> {
    #[cfg(target_os = "macos")]
    {
        // WebKit's named store starts at macOS 14. Wry uses the shared default store on older
        // releases if given an identifier without incognito, so keep those sessions ephemeral.
        use objc2_foundation::NSProcessInfo;
        if NSProcessInfo::processInfo().operatingSystemVersion().majorVersion < 14 {
            return Ok(guest.data_directory(temporary_profile.join("guest")).incognito(true));
        }
    }
    let profile = root.join("profile");
    ensure_profile_directory(&profile)?;
    let guest = guest.data_directory(profile);
    #[cfg(target_os = "macos")]
    let guest = {
        // The same app identity opens the same isolated WebKit store after restart.
        let mut hash = Sha256::new();
        hash.update(b"ai-canvas/xiaohongshu-reference/profile/v1\0");
        hash.update(app.config().identifier.as_bytes());
        let mut identifier = [0; 16];
        identifier.copy_from_slice(&hash.finalize()[..16]);
        identifier[6] = (identifier[6] & 0x0f) | 0x80;
        identifier[8] = (identifier[8] & 0x3f) | 0x80;
        guest.data_store_identifier(identifier)
    };
    #[cfg(not(target_os = "macos"))]
    let _ = (app, temporary_profile);
    Ok(guest)
}

fn toolbar_bounds(width: f64) -> Rect {
    let toolbar_width = if cfg!(target_os = "macos") { 306.0 } else { width };
    Rect {
        position: LogicalPosition::new(width - toolbar_width, 0.0).into(),
        size: LogicalSize::new(toolbar_width, TOOLBAR_HEIGHT).into(),
    }
}

fn guest_bounds(size: LogicalSize<f64>) -> Rect {
    Rect {
        position: LogicalPosition::new(0.0, TOOLBAR_HEIGHT).into(),
        size: LogicalSize::new(size.width, (size.height - TOOLBAR_HEIGHT).max(1.0)).into(),
    }
}

#[cfg(target_os = "linux")]
fn constrain_linux_toolbar(toolbar: &Webview) -> Result<oneshot::Receiver<bool>, String> {
    let (sender, receiver) = oneshot::channel();
    toolbar.with_webview(move |platform| {
        use gtk::prelude::*;
        let view: gtk::Widget = platform.inner().upcast();
        let packed = view.parent().and_then(|parent| parent.downcast::<gtk::Box>().ok()).is_some_and(|parent| {
            parent.set_child_packing(&view, false, false, 0, gtk::PackType::Start);
            view.set_size_request(-1, TOOLBAR_HEIGHT as i32);
            true
        });
        let _ = sender.send(packed);
    }).map_err(|_| "小红书窗口工具栏初始化失败")?;
    Ok(receiver)
}

impl Drop for OpenWindow {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(mut sessions) = SESSIONS.lock() {
            sessions.remove(&self.label);
        }
        if let Some(window) = self.window.take() {
            let _ = window.destroy();
        } else if let Some(profile) = &self.temporary_profile {
            let _ = std::fs::remove_dir_all(profile);
        }
    }
}

#[tauri::command]
pub async fn xiaohongshu_reference_open(
    app: AppHandle,
    webview: Webview,
    session_id: String,
    title: Option<String>,
    import_label: Option<String>,
    importing_label: Option<String>,
    theme: Option<ToolbarTheme>,
) -> Result<(), String> {
    let label = session_key(&webview, &session_id)?;
    let owner = webview.label().to_owned();
    let navigation = Arc::new(AtomicU64::new(0));
    let toolbar_theme = theme.unwrap_or_default();
    {
        let mut sessions = SESSIONS.lock().map_err(|_| "小红书参考会话不可用")?;
        if sessions.contains_key(&label) || sessions.values().any(|session| session.owner == owner) {
            return Err("当前窗口已有打开的小红书参考会话".into());
        }
        sessions.insert(label.clone(), Session {
            owner: owner.clone(),
            navigation: navigation.clone(),
            import_requested: false,
            importing: false,
            import_label: display_text(import_label, "导入当前图片", 64),
            importing_label: display_text(importing_label, "正在导入…", 64),
            toolbar_theme,
        });
    }
    let mut startup = OpenWindow { label: label.clone(), window: None, temporary_profile: None, completed: false };
    let root = profile_root(&app)?;
    let temporary_profile = root.join(&session_id);
    ensure_profile_directory(&temporary_profile)?;
    startup.temporary_profile = Some(temporary_profile.clone());
    let builder = WindowBuilder::new(&app, &label)
        .title(display_text(title, "小红书参考 · AI Canvas", 100))
        .theme(Some(toolbar_theme.window_theme()))
        .inner_size(1120.0, 810.0)
        .min_inner_size(760.0, 560.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    let window = builder.build().map_err(|_| "无法创建小红书独立浏览器")?;
    startup.window = Some(window.clone());
    let cleanup_label = label.clone();
    let cleanup_owner = owner.clone();
    let cleanup_app = app.clone();
    let cleanup_profile = temporary_profile.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if take_session(&cleanup_label, &cleanup_owner).is_some() {
                notify_closed(&cleanup_app, &cleanup_label, &cleanup_owner);
            }
            let profile = cleanup_profile.clone();
            tauri::async_runtime::spawn_blocking(move || { let _ = std::fs::remove_dir_all(profile); });
        }
    });

    let scale_factor = window.scale_factor().map_err(|_| "小红书窗口尺寸不可用")?;
    let initial_size = window.inner_size().map_err(|_| "小红书窗口尺寸不可用")?.to_logical::<f64>(scale_factor);
    let toolbar_id = toolbar_label(&session_id);
    let toolbar_home = Url::parse("xhs-reference-toolbar://localhost/").map_err(|_| "小红书窗口工具栏地址不可用")?;
    let toolbar_app = app.clone();
    let toolbar_session = session_id.clone();
    let toolbar = WebviewBuilder::new(toolbar_id, WebviewUrl::CustomProtocol(toolbar_home))
        .use_https_scheme(false)
        .transparent(cfg!(target_os = "macos"))
        .incognito(true)
        .data_directory(temporary_profile.join("toolbar"))
        .devtools(false)
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(false)
        .on_navigation(move |url| match toolbar_path(url) {
            Some("/") => true,
            Some("/import") => { request_import(&toolbar_app, &toolbar_session); false }
            _ => false,
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    let bounds = toolbar_bounds(initial_size.width);
    let toolbar = window.add_child(toolbar, bounds.position, bounds.size)
        .map_err(|_| "无法创建小红书窗口工具栏")?;
    #[cfg(target_os = "linux")]
    let linux_toolbar = constrain_linux_toolbar(&toolbar)?;

    let blank = Url::parse("about:blank").map_err(|_| "小红书参考地址不可用")?;
    let guest = guest_profile(&app, WebviewBuilder::new(&label, WebviewUrl::External(blank)), &root, &temporary_profile)?
        .devtools(false)
        .initialization_script_for_all_frames(GUEST_RESTRICTIONS)
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" || allowed_site(url) {
                navigation.fetch_add(1, Ordering::Relaxed);
                return true;
            }
            false
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    let bounds = guest_bounds(initial_size);
    let guest = window.add_child(guest, bounds.position, bounds.size)
        .map_err(|_| "无法创建小红书网页")?;
    #[cfg(not(target_os = "linux"))]
    {
        let layout_window = window.clone();
        let layout_guest = guest.clone();
        window.on_window_event(move |event| {
            let (size, scale) = match event {
                WindowEvent::Resized(size) => (*size, layout_window.scale_factor().unwrap_or(1.0)),
                WindowEvent::ScaleFactorChanged { scale_factor, new_inner_size, .. } => (*new_inner_size, *scale_factor),
                _ => return,
            };
            let logical = size.to_logical::<f64>(scale);
            let _ = toolbar.set_bounds(toolbar_bounds(logical.width));
            let _ = layout_guest.set_bounds(guest_bounds(logical));
        });
    }
    #[cfg(target_os = "linux")]
    if !tokio::time::timeout(Duration::from_secs(15), linux_toolbar).await
        .ok().and_then(Result::ok).unwrap_or(false) {
        return Err("小红书窗口工具栏初始化失败".into());
    }
    let (sender, receiver) = oneshot::channel();
    guest.with_webview(move |_platform| {
        #[cfg(windows)]
        let ready = restrict_native_permissions(_platform).is_ok();
        #[cfg(not(windows))]
        let ready = true;
        let _ = sender.send(ready);
    })
        .map_err(|_| "小红书浏览器初始化失败")?;
    let ready = tokio::time::timeout(Duration::from_secs(15), receiver).await
        .map_err(|_| "小红书浏览器初始化超时")?
        .map_err(|_| "小红书浏览器初始化失败")?;
    if !ready {
        return Err("小红书浏览器权限隔离初始化失败".into());
    }
    session(&app, &label, &owner)?;
    let home = Url::parse(HOME).map_err(|_| "小红书参考地址不可用")?;
    guest.navigate(home).map_err(|_| "无法打开小红书")?;
    window.show().map_err(|_| "无法显示小红书参考窗口")?;
    let _ = window.set_focus();
    let _ = guest.set_focus();
    startup.completed = true;
    Ok(())
}

#[tauri::command]
pub fn xiaohongshu_reference_focus(app: AppHandle, webview: Webview, session_id: String) -> Result<(), String> {
    let label = session_key(&webview, &session_id)?;
    let (_, guest) = session(&app, &label, webview.label())?;
    let window = guest.window();
    window.unminimize().map_err(|_| "小红书参考窗口不可用")?;
    window.set_focus().map_err(|_| "小红书参考窗口不可用")?;
    guest.set_focus().map_err(|_| "小红书参考窗口不可用".into())
}

#[tauri::command]
pub fn xiaohongshu_reference_close(app: AppHandle, webview: Webview, session_id: String) -> Result<(), String> {
    let label = session_key(&webview, &session_id)?;
    revoke_session(&app, &label, webview.label())
}

#[tauri::command]
pub fn xiaohongshu_reference_set_status(
    app: AppHandle,
    webview: Webview,
    session_id: String,
    status: ToolbarStatus,
    message: Option<String>,
) -> Result<(), String> {
    let label = session_key(&webview, &session_id)?;
    let current = {
        let mut sessions = SESSIONS.lock().map_err(|_| "小红书参考会话不可用")?;
        let session = sessions.get_mut(&label).filter(|session| session.owner == webview.label())
            .ok_or("小红书参考窗口已关闭")?;
        if !matches!(status, ToolbarStatus::Importing) { session.import_requested = false; }
        session.clone()
    };
    toolbar_status(&app, &session_id, &current, status, &display_text(message, "", 240))
}

struct ImportGuard {
    label: String,
    navigation: Arc<AtomicU64>,
}
impl Drop for ImportGuard {
    fn drop(&mut self) {
        if let Ok(mut sessions) = SESSIONS.lock() {
            if let Some(session) = sessions.get_mut(&self.label)
                .filter(|session| Arc::ptr_eq(&session.navigation, &self.navigation)) {
                session.importing = false;
            }
        }
    }
}

async fn visible_photo(window: &Webview) -> Result<PagePhoto, String> {
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window.eval_with_callback(PHOTO_QUERY, move |body| {
        let payload = (body.len() <= MAX_PAGE_REPLY_BYTES).then_some(body);
        if let Ok(mut sender) = sender.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(payload);
            }
        }
    }).map_err(|_| "无法读取小红书当前照片")?;
    let payload = tokio::time::timeout(Duration::from_secs(5), receiver).await
        .map_err(|_| "读取当前照片超时，请重新打开笔记")?
        .map_err(|_| "小红书页面已关闭")?
        .ok_or("当前照片信息超出限制")?;
    serde_json::from_str(&payload)
        .map_err(|_| "未找到唯一的当前照片，请打开图文笔记并等待图片加载".into())
}

async fn download_image(url: Url, note: String) -> Result<Vec<u8>, String> {
    let host = url.host_str().ok_or("当前照片地址不可用")?.to_owned();
    let addresses: Vec<_> = tokio::time::timeout(Duration::from_secs(6), tokio::net::lookup_host((host.as_str(), 443)))
        .await.map_err(|_| "小红书图片域名解析超时")?
        .map_err(|_| "无法解析小红书图片域名")?
        .collect();
    if addresses.is_empty() || addresses.len() > 64
        || addresses.iter().any(|addr| crate::assistant_web::is_disallowed_ip(addr.ip()))
    {
        return Err("小红书图片地址未通过公网校验".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .resolve_to_addrs(&host, &addresses)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(22))
            .build()
            .map_err(|_| "小红书图片连接不可用")?;
        let response = client.get(url)
            .header(reqwest::header::REFERER, "https://www.xiaohongshu.com/")
            .header(reqwest::header::ACCEPT, "image/webp,image/png,image/jpeg")
            .send().map_err(|_| "无法下载当前照片，请在笔记中重新选择")?;
        if !response.status().is_success() {
            return Err("无法下载当前照片，请在笔记中重新选择".into());
        }
        if response.content_length().is_some_and(|len| len > MAX_IMAGE_BYTES as u64) {
            return Err("小红书参考图超过 25 MiB".into());
        }
        let mut bytes = Vec::new();
        response.take((MAX_IMAGE_BYTES + 1) as u64).read_to_end(&mut bytes)
            .map_err(|_| "小红书照片下载中断")?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err("小红书照片大小不可用，单张上限为 25 MiB".into());
        }
        encode_photo(note, bytes)
    }).await.map_err(|_| "小红书照片处理失败")?
}

// A fixed binary envelope avoids serializing the image as JSON or transferring browser credentials.
fn encode_photo(note: String, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(&bytes)).with_guessed_format()
        .map_err(|_| "小红书照片格式无效")?;
    let (format, mime) = match reader.format() {
        Some(ImageFormat::Png) => (ImageFormat::Png, 1),
        Some(ImageFormat::Jpeg) => (ImageFormat::Jpeg, 2),
        Some(ImageFormat::WebP) => (ImageFormat::WebP, 3),
        _ => return Err("仅支持导入 PNG、JPEG 或 WebP 照片".into()),
    };
    let (width, height) = reader.into_dimensions().map_err(|_| "小红书照片无法解码")?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("小红书照片尺寸超过限制".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| "小红书照片无法解码")?;
    let mut output = Vec::with_capacity(57 + bytes.len());
    output.push(mime);
    output.extend_from_slice(note.as_bytes());
    output.extend_from_slice(&Sha256::digest(&bytes));
    output.extend(bytes);
    Ok(output)
}

#[tauri::command]
pub async fn xiaohongshu_reference_import(
    app: AppHandle,
    webview: Webview,
    session_id: String,
) -> Result<Response, String> {
    let label = session_key(&webview, &session_id)?;
    let owner = webview.label().to_owned();
    let (session, guest) = session(&app, &label, &owner)?;
    {
        let mut sessions = SESSIONS.lock().map_err(|_| "小红书参考会话不可用")?;
        let current = sessions.get_mut(&label).filter(|current| Arc::ptr_eq(&current.navigation, &session.navigation))
            .ok_or("小红书参考会话不可用")?;
        if current.importing {
            return Err("正在导入小红书照片".into());
        }
        if !current.import_requested {
            return Err("请在小红书窗口点击导入当前图片".into());
        }
        current.import_requested = false;
        current.importing = true;
    }
    let _import = ImportGuard { label: label.clone(), navigation: session.navigation.clone() };
    let revision = session.navigation.load(Ordering::Relaxed);
    let current_note = || guest.url().ok().as_ref().and_then(note_id);
    let note = current_note().ok_or("请在小红书窗口打开一篇图文笔记")?;
    let selected = visible_photo(&guest).await?;
    if Url::parse(&selected.page_url).ok().as_ref().and_then(note_id).as_ref() != Some(&note)
        || current_note().as_ref() != Some(&note)
        || session.navigation.load(Ordering::Relaxed) != revision
    {
        return Err("小红书笔记已切换，请重新选择照片".into());
    }
    let selected_url = image_url(&selected.image_url)?;
    let bytes = download_image(selected_url.clone(), note.clone()).await?;
    let (live, _) = self::session(&app, &label, &owner)?;
    if !Arc::ptr_eq(&live.navigation, &session.navigation)
        || current_note().as_ref() != Some(&note)
        || session.navigation.load(Ordering::Relaxed) != revision
    {
        return Err("小红书笔记已切换，请重新选择照片".into());
    }
    let after = visible_photo(&guest).await?;
    if Url::parse(&after.page_url).ok().as_ref().and_then(note_id).as_ref() != Some(&note)
        || current_note().as_ref() != Some(&note)
        || session.navigation.load(Ordering::Relaxed) != revision
        || image_url(&after.image_url)? != selected_url
    {
        return Err("小红书当前照片已切换，请重新导入".into());
    }
    let (live, _) = self::session(&app, &label, &owner)?;
    if !Arc::ptr_eq(&live.navigation, &session.navigation) {
        return Err("小红书参考窗口已切换，请重新导入".into());
    }
    Ok(Response::new(bytes))
}
