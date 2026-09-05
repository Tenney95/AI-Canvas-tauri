//! 无 iframe 插件窗口的原生会话边界。主窗口保留 effect、资源及画布写入权威。
//! 锁顺序固定为 registry -> SESSIONS；不得持有 SESSIONS 再读取注册表。

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    ipc::Channel,
    webview::NewWindowResponse,
    AppHandle, Manager, Runtime, UriSchemeContext, Webview, WebviewUrl, WebviewWindowBuilder,
    Window, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;
use url::Url;

use crate::plugin_registry::{plugin_private_dir, with_active_window_ui, PluginUiIdentity};

const MAX_SESSIONS: usize = 4;
const MAX_REQUESTS: usize = 192;
const MAX_PENDING: usize = 8;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_REPLY_BYTES: usize = 32 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const HOST_HTML: &str = include_str!("window-host.html");
const BOOTSTRAP: &str = include_str!("window-bootstrap.js");
// 只放行 Tauri IPC 传输来源，不放行任何业务网络、asset 或 file 来源。
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src ipc: http://ipc.localhost; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CLOSED_ERROR: &str = "插件窗口会话已失效，请重新打开";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginWindowBinding {
    pub session_id: String,
    pub identity: PluginUiIdentity,
    pub project_id: String,
    pub node_id: String,
    pub canvas_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenPluginWindow {
    pub binding: PluginWindowBinding,
    pub export_name: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPluginWindowResult {
    binding: PluginWindowBinding,
    reused: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestKind {
    Context,
    Effect,
    SetParameters,
    Submit,
    Close,
    Toast,
}

impl RequestKind {
    fn exclusive(self) -> bool {
        matches!(self, Self::Effect | Self::SetParameters | Self::Submit)
    }

    fn timeout(self) -> Duration {
        Duration::from_secs(if matches!(self, Self::Effect | Self::Submit) {
            180
        } else {
            30
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginWindowRequest {
    binding: PluginWindowBinding,
    request_id: String,
    kind: RequestKind,
    #[serde(default)]
    payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginWindowReply {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CloseReason {
    HostClosed,
    PluginChanged,
    WindowClosed,
    HostExited,
    RequestTimedOut,
    HostDisconnected,
    CreationFailed,
}

/// 只能通过创建命令从真实 main 绑定的 Channel 投递，不接受通用事件回包。
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PluginWindowEvent {
    Request {
        binding: PluginWindowBinding,
        request_id: String,
        kind: RequestKind,
        payload: Value,
    },
    Closed {
        binding: PluginWindowBinding,
        reason: String,
    },
}

struct PendingRequest {
    exclusive: bool,
    sender: oneshot::Sender<Result<String, String>>,
}

struct Session {
    options: OpenPluginWindow,
    label: String,
    url: Url,
    channel: Channel<PluginWindowEvent>,
    close_native: Arc<dyn Fn() + Send + Sync>,
    pending: BTreeMap<String, PendingRequest>,
    seen_requests: BTreeSet<String>,
    close_requested: bool,
    confirming_close: bool,
}

#[derive(Default)]
struct WindowSessions {
    sessions: BTreeMap<String, Session>,
    next_label: u64,
}

static SESSIONS: LazyLock<Mutex<WindowSessions>> =
    LazyLock::new(|| Mutex::new(WindowSessions::default()));

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
}

fn validate_open(options: &OpenPluginWindow) -> Result<(), String> {
    let binding = &options.binding;
    if !valid_uuid(&binding.session_id)
        || !valid_id(&binding.project_id)
        || !valid_id(&binding.node_id)
        || binding.canvas_revision > MAX_SAFE_INTEGER
        || options.title.is_empty()
        || options.title.len() > 240
        || options.title.chars().any(char::is_control)
        || options.export_name.is_empty()
        || options.export_name.len() > 128
        || !options
            .export_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
    {
        return Err("插件窗口参数无效".into());
    }
    Ok(())
}

fn is_main_surface(label: &str, window_label: &str) -> bool {
    label == "main" && window_label == "main"
}

fn ensure_main<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if !is_main_surface(webview.label(), webview.window().label()) {
        return Err("仅主窗口可以管理插件窗口".into());
    }
    Ok(())
}

fn session_url(session_id: &str) -> Url {
    let origin = if cfg!(any(windows, target_os = "android")) {
        "http://plugin-window.localhost"
    } else {
        "plugin-window://localhost"
    };
    Url::parse(&format!("{origin}/{session_id}/index.html")).expect("固定协议与已校验 UUID")
}

fn navigation_allowed(expected: &Url, requested: &Url) -> bool {
    expected == requested
}

fn caller_matches(session: &Session, label: &str, window_label: &str, url: &Url) -> bool {
    // 标签只由 Rust 分配且进程内不复用；不使用 Webview 的 label-only PartialEq。
    session.label == label && session.label == window_label && session.url == *url
}

impl WindowSessions {
    fn next_label(&mut self) -> Result<String, String> {
        self.next_label = self.next_label.checked_add(1).ok_or("插件窗口编号已耗尽")?;
        Ok(format!("plugin-window-{}", self.next_label))
    }

    fn bound_mut(&mut self, binding: &PluginWindowBinding) -> Result<&mut Session, String> {
        self.sessions
            .get_mut(&binding.session_id)
            .filter(|session| session.options.binding == *binding)
            .ok_or_else(|| CLOSED_ERROR.into())
    }

    fn remove_matching(&mut self, predicate: impl Fn(&Session) -> bool) -> Vec<Session> {
        let ids = self
            .sessions
            .iter()
            .filter_map(|(id, session)| predicate(session).then_some(id.clone()))
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| self.sessions.remove(&id))
            .collect()
    }
}

fn enqueue(
    session: &mut Session,
    request: &PluginWindowRequest,
) -> Result<oneshot::Receiver<Result<String, String>>, String> {
    if !valid_uuid(&request.request_id)
        || session.seen_requests.contains(&request.request_id)
        || serde_json::to_vec(&request.payload)
            .map_err(|_| "请求序列化失败")?
            .len()
            > MAX_REQUEST_BYTES
    {
        return Err("插件请求无效、重复或超过大小限制".into());
    }
    if session.pending.len() >= MAX_PENDING
        || (request.kind != RequestKind::Close && session.seen_requests.len() >= MAX_REQUESTS)
        || (request.kind == RequestKind::Close && session.close_requested)
        || (request.kind.exclusive() && session.pending.values().any(|pending| pending.exclusive))
    {
        return Err("插件请求达到会话上限或已有操作正在执行".into());
    }
    let (sender, receiver) = oneshot::channel();
    session.seen_requests.insert(request.request_id.clone());
    session.close_requested |= request.kind == RequestKind::Close;
    session.pending.insert(
        request.request_id.clone(),
        PendingRequest {
            exclusive: request.kind.exclusive(),
            sender,
        },
    );
    Ok(receiver)
}

fn dispose_sessions(sessions: Vec<Session>, reason: CloseReason) {
    for session in sessions {
        for (_, pending) in session.pending {
            let _ = pending.sender.send(Err(CLOSED_ERROR.into()));
        }
        let _ = session.channel.send(PluginWindowEvent::Closed {
            binding: session.options.binding,
            reason: serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "closed".into()),
        });
        // 注册表事务可调用此函数；窗口销毁不得反向同步等待 registry 锁。
        tauri::async_runtime::spawn(async move {
            (session.close_native)();
        });
    }
}

fn revoke_session(binding: &PluginWindowBinding, reason: CloseReason) {
    let removed = SESSIONS
        .lock()
        .map(|mut sessions| sessions.remove_matching(|session| session.options.binding == *binding))
        .unwrap_or_default();
    dispose_sessions(removed, reason);
}

pub(crate) fn revoke_plugin_sessions(plugin_id: &str) {
    let removed = SESSIONS
        .lock()
        .map(|mut sessions| {
            sessions
                .remove_matching(|session| session.options.binding.identity.plugin_id == plugin_id)
        })
        .unwrap_or_default();
    dispose_sessions(removed, CloseReason::PluginChanged);
}

pub(crate) fn revoke_all_sessions() {
    let removed = SESSIONS
        .lock()
        .map(|mut sessions| sessions.remove_matching(|_| true))
        .unwrap_or_default();
    dispose_sessions(removed, CloseReason::HostExited);
}

fn ensure_profile_directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("无法准备插件窗口独立存储".into()),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "插件窗口独立存储不可用")?;
    #[cfg(windows)]
    let is_redirect = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let is_redirect = metadata.file_type().is_symlink();
    if !metadata.is_dir() || is_redirect {
        return Err("插件窗口独立存储路径不安全".into());
    }
    Ok(())
}

fn create_profile(private_dir: &Path, label: &str, session_id: &str) -> Result<PathBuf, String> {
    ensure_profile_directory(private_dir)?;
    let base = private_dir.join("window-profiles");
    ensure_profile_directory(&base)?;
    let profile = base.join(format!("{session_id}-{label}"));
    // 绝不复用关闭或上次运行留下的 profile。
    fs::create_dir(&profile).map_err(|_| "插件窗口存储已存在或无法创建，请重新打开")?;
    ensure_profile_directory(&profile)?;
    let canonical_root = private_dir
        .canonicalize()
        .map_err(|_| "无法校验插件私有目录")?;
    let canonical_profile = profile.canonicalize().map_err(|_| "无法校验插件窗口存储")?;
    if !canonical_profile.starts_with(canonical_root) {
        return Err("插件窗口存储超出私有目录".into());
    }
    Ok(profile)
}

#[tauri::command]
pub async fn open_plugin_ui_window<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    options: OpenPluginWindow,
    channel: Channel<PluginWindowEvent>,
) -> Result<OpenPluginWindowResult, String> {
    ensure_main(&webview)?;
    validate_open(&options)?;
    let private_dir = plugin_private_dir(&app)?;
    let (binding, label, reused) =
        with_active_window_ui(&private_dir, &options.binding.identity, |_| {
            let mut sessions = SESSIONS.lock().map_err(|_| "插件窗口登记不可用")?;
            if let Some(existing) = sessions.sessions.values().find(|session| {
                let current = &session.options.binding;
                current.identity == options.binding.identity
                    && current.project_id == options.binding.project_id
                    && current.node_id == options.binding.node_id
            }) {
                if existing.options.binding.canvas_revision != options.binding.canvas_revision {
                    return Err("画布已变化，请先关闭旧插件会话".into());
                }
                return Ok((
                    existing.options.binding.clone(),
                    existing.label.clone(),
                    true,
                ));
            }
            if sessions.sessions.len() >= MAX_SESSIONS
                || sessions.sessions.contains_key(&options.binding.session_id)
            {
                return Err("插件窗口达到数量上限或会话 ID 重复".into());
            }
            let label = sessions.next_label()?;
            let close_app = app.clone();
            let close_label = label.clone();
            sessions.sessions.insert(
                options.binding.session_id.clone(),
                Session {
                    options: options.clone(),
                    label: label.clone(),
                    url: session_url(&options.binding.session_id),
                    channel,
                    close_native: Arc::new(move || {
                        if let Some(window) = close_app.get_webview_window(&close_label) {
                            let _ = window.destroy();
                        }
                    }),
                    pending: BTreeMap::new(),
                    seen_requests: BTreeSet::new(),
                    close_requested: false,
                    confirming_close: false,
                },
            );
            Ok((options.binding.clone(), label, false))
        })?;
    if reused {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(OpenPluginWindowResult { binding, reused });
    }
    let build_result = (|| {
        let profile = create_profile(&private_dir, &label, &binding.session_id)?;
        let expected_url = session_url(&binding.session_id);
        let navigation_url = expected_url.clone();
        let window =
            WebviewWindowBuilder::new(&app, &label, WebviewUrl::CustomProtocol(expected_url))
                .title(format!("{} — 插件", options.title))
                .inner_size(1280.0, 860.0)
                .min_inner_size(760.0, 540.0)
                .resizable(true)
                .decorations(true)
                .center()
                .visible(false)
                .data_directory(profile)
                .incognito(true)
                .devtools(false)
                .on_navigation(move |url| navigation_allowed(&navigation_url, url))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .build()
                .map_err(|_| "无法创建插件独立窗口")?;
        // build 期间可能已经停用插件或关闭主窗口，不能重新显示已撤销会话。
        let live = with_active_window_ui(&private_dir, &binding.identity, |_| {
            SESSIONS
                .lock()
                .map_err(|_| "插件窗口登记不可用")?
                .bound_mut(&binding)
                .map(|_| ())
        });
        if let Err(error) = live {
            let _ = window.destroy();
            return Err(error);
        }
        window.show().map_err(|_| "无法显示插件窗口")?;
        let _ = window.set_focus();
        Ok(())
    })();
    if let Err(error) = build_result {
        revoke_session(&binding, CloseReason::CreationFailed);
        return Err(error);
    }
    Ok(OpenPluginWindowResult {
        binding,
        reused: false,
    })
}

#[tauri::command]
pub fn close_plugin_ui_window<R: Runtime>(
    webview: Webview<R>,
    binding: PluginWindowBinding,
) -> Result<(), String> {
    ensure_main(&webview)?;
    // 关闭不要求活动 revision 仍有效；它也是项目/节点失效后的撤销入口。
    revoke_session(&binding, CloseReason::HostClosed);
    Ok(())
}

#[tauri::command]
pub async fn plugin_ui_window_request<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    request: PluginWindowRequest,
) -> Result<String, String> {
    let url = webview.url().map_err(|_| CLOSED_ERROR)?;
    // 先拒绝未知窗口/伪造绑定，不能让插件探测其他插件的注册状态或触发其快照读取。
    {
        let mut sessions = SESSIONS.lock().map_err(|_| CLOSED_ERROR)?;
        let session = sessions.bound_mut(&request.binding)?;
        if !caller_matches(session, webview.label(), webview.window().label(), &url) {
            return Err("插件窗口调用方不匹配".into());
        }
    }
    let private_dir = plugin_private_dir(&app)?;
    let (receiver, channel) =
        with_active_window_ui(&private_dir, &request.binding.identity, |_| {
            let mut sessions = SESSIONS.lock().map_err(|_| CLOSED_ERROR)?;
            let session = sessions.bound_mut(&request.binding)?;
            if !caller_matches(session, webview.label(), webview.window().label(), &url) {
                return Err("插件窗口调用方不匹配".into());
            }
            Ok((enqueue(session, &request)?, session.channel.clone()))
        })?;
    if channel
        .send(PluginWindowEvent::Request {
            binding: request.binding.clone(),
            request_id: request.request_id,
            kind: request.kind,
            payload: request.payload,
        })
        .is_err()
    {
        revoke_session(&request.binding, CloseReason::HostDisconnected);
        return Err("主窗口桥接已断开".into());
    }
    match tokio::time::timeout(request.kind.timeout(), receiver).await {
        Ok(Ok(result)) => {
            let serialized = result?;
            // 主窗口发送回包与本任务恢复之间也可能发生撤销，不能返回已过期的数据。
            with_active_window_ui(&private_dir, &request.binding.identity, |_| {
                SESSIONS
                    .lock()
                    .map_err(|_| CLOSED_ERROR)?
                    .bound_mut(&request.binding)
                    .map(|_| serialized)
            })
        }
        Ok(Err(_)) => Err(CLOSED_ERROR.into()),
        Err(_) => {
            revoke_session(&request.binding, CloseReason::RequestTimedOut);
            Err("宿主请求超时，会话已撤销".into())
        }
    }
}

#[tauri::command]
pub fn respond_plugin_ui_window_request<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    binding: PluginWindowBinding,
    request_id: String,
    reply: PluginWindowReply,
) -> Result<(), String> {
    ensure_main(&webview)?;
    let serialized = serialize_reply(&reply)?;
    with_active_window_ui(&plugin_private_dir(&app)?, &binding.identity, |_| {
        let mut sessions = SESSIONS.lock().map_err(|_| CLOSED_ERROR)?;
        settle(sessions.bound_mut(&binding)?, &request_id, serialized)
    })
}

fn serialize_reply(reply: &PluginWindowReply) -> Result<String, String> {
    if reply.ok == reply.error.is_some()
        || (!reply.ok && reply.value.is_some())
        || reply.error.as_ref().is_some_and(|error| error.len() > 1024)
    {
        return Err("插件回包格式无效".into());
    }
    // String 回包不会触发 Tauri 的对象 -> Channel fetch 回退；插件无需 core:channel。
    let serialized = serde_json::to_string(&reply).map_err(|_| "插件回包序列化失败")?;
    if serialized.len() > MAX_REPLY_BYTES {
        return Err("插件回包超过大小限制".into());
    }
    Ok(serialized)
}

fn settle(session: &mut Session, request_id: &str, serialized: String) -> Result<(), String> {
    let pending = session
        .pending
        .remove(request_id)
        .ok_or("插件请求已结束或不属于本会话")?;
    pending
        .sender
        .send(Ok(serialized))
        .map_err(|_| "插件请求已取消".into())
}

fn protocol_body(
    session: &Session,
    path: &str,
    ui_source: &str,
) -> Result<(&'static str, Vec<u8>), String> {
    let prefix = format!("/{}/", session.options.binding.session_id);
    let asset = path.strip_prefix(&prefix).ok_or("forbidden")?;
    match asset {
        "index.html" => Ok(("text/html; charset=utf-8", HOST_HTML.as_bytes().to_vec())),
        "bootstrap.js" => {
            let config = serde_json::json!({
                "binding": session.options.binding,
                "exportName": session.options.export_name,
                "url": session.url,
            });
            Ok((
                "application/javascript; charset=utf-8",
                BOOTSTRAP
                    .replace("__PLUGIN_WINDOW_CONFIG__", &config.to_string())
                    .into_bytes(),
            ))
        }
        "bundle.js" => Ok((
            "application/javascript; charset=utf-8",
            ui_source.as_bytes().to_vec(),
        )),
        _ => Err("forbidden".into()),
    }
}

pub fn handle_protocol<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let result = (|| {
        if request.method() != Method::GET || request.uri().query().is_some() {
            return Err("forbidden".to_string());
        }
        let binding = SESSIONS
            .lock()
            .map_err(|_| "forbidden")?
            .sessions
            .values()
            .find(|session| session.label == context.webview_label())
            .map(|session| session.options.binding.clone())
            .ok_or("forbidden")?;
        with_active_window_ui(
            &plugin_private_dir(context.app_handle())?,
            &binding.identity,
            |source| {
                let mut sessions = SESSIONS.lock().map_err(|_| "forbidden")?;
                let session = sessions.bound_mut(&binding)?;
                protocol_body(session, request.uri().path(), source)
            },
        )
    })();
    let (status, content_type, body) = match result {
        Ok((content_type, body)) => (StatusCode::OK, content_type, body),
        Err(_) => (
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            b"forbidden".to_vec(),
        ),
    };
    Response::builder().status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=(), usb=(), serial=()")
        .body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

pub(crate) fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
        revoke_all_sessions();
        return;
    }
    let mut guard = match SESSIONS.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let Some(session) = guard
        .sessions
        .values_mut()
        .find(|session| session.label == window.label())
    else {
        return;
    };
    let binding = session.options.binding.clone();
    match event {
        WindowEvent::Destroyed => {
            drop(guard);
            revoke_session(&binding, CloseReason::WindowClosed);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if session.pending.is_empty() {
                drop(guard);
                revoke_session(&binding, CloseReason::WindowClosed);
                return;
            }
            if session.confirming_close {
                return;
            }
            session.confirming_close = true;
            drop(guard);
            window
                .app_handle()
                .dialog()
                .message("插件仍有操作正在执行。关闭将取消当前会话，未输出内容不会保存。")
                .title("关闭插件窗口？")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "停止并关闭".into(),
                    "继续编辑".into(),
                ))
                .parent(window)
                .show(move |confirmed| {
                    if confirmed {
                        revoke_session(&binding, CloseReason::WindowClosed);
                    } else if let Ok(mut sessions) = SESSIONS.lock() {
                        if let Ok(session) = sessions.bound_mut(&binding) {
                            session.confirming_close = false;
                        }
                    }
                });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn options() -> OpenPluginWindow {
        OpenPluginWindow {
            binding: PluginWindowBinding {
                session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                identity: PluginUiIdentity {
                    plugin_id: "test.plugin".into(),
                    source_digest: "a".repeat(64),
                    revision_digest: "b".repeat(64),
                    ui_digest: "c".repeat(64),
                    tool_id: "review".into(),
                },
                project_id: "project-1".into(),
                node_id: "node-1".into(),
                canvas_revision: 7,
            },
            export_name: "Review".into(),
            title: "逐帧拉片".into(),
        }
    }

    fn session() -> Session {
        let options = options();
        Session {
            url: session_url(&options.binding.session_id),
            options,
            label: "plugin-window-1".into(),
            channel: Channel::new(|_| Ok(())),
            close_native: Arc::new(|| {}),
            pending: BTreeMap::new(),
            seen_requests: BTreeSet::new(),
            close_requested: false,
            confirming_close: false,
        }
    }

    fn request(kind: RequestKind, number: usize) -> PluginWindowRequest {
        PluginWindowRequest {
            binding: options().binding,
            request_id: format!("00000000-0000-4000-8000-{number:012x}"),
            kind,
            payload: Value::Null,
        }
    }

    #[test]
    fn only_top_level_main_can_manage_windows() {
        assert!(is_main_surface("main", "main"));
        for (label, window) in [
            ("chat-assistant", "chat-assistant"),
            ("plugin-window-1", "plugin-window-1"),
            ("main", "other"),
            ("child", "main"),
        ] {
            assert!(!is_main_surface(label, window));
        }
    }

    #[test]
    fn validates_uuid_bounds_and_disallows_renderer_paths_and_urls() {
        assert!(validate_open(&options()).is_ok());
        for invalid in [
            "",
            "../main",
            "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
            "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
        ] {
            let mut options = options();
            options.binding.session_id = invalid.into();
            assert!(validate_open(&options).is_err());
        }
        let mut value = serde_json::to_value(options()).unwrap();
        value["url"] = json!("https://example.com");
        assert!(serde_json::from_value::<OpenPluginWindow>(value).is_err());
        let mut options = options();
        options.binding.canvas_revision = MAX_SAFE_INTEGER + 1;
        assert!(validate_open(&options).is_err());
    }

    #[test]
    fn profile_directories_are_private_unique_and_never_reused() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "plugin-window-profile-test-{}-{unique}",
                std::process::id()
            ));
        fs::create_dir(&directory).unwrap();
        let first =
            create_profile(&directory, "plugin-window-1", &options().binding.session_id).unwrap();
        let second =
            create_profile(&directory, "plugin-window-2", &options().binding.session_id).unwrap();
        assert_ne!(first, second);
        assert!(first
            .canonicalize()
            .unwrap()
            .starts_with(directory.canonicalize().unwrap()));
        assert!(
            create_profile(&directory, "plugin-window-1", &options().binding.session_id).is_err()
        );
        let not_a_directory = directory.join("not-a-directory");
        fs::write(&not_a_directory, b"fixture").unwrap();
        assert!(ensure_profile_directory(&not_a_directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn actual_caller_must_match_registered_webview_window_and_url() {
        let session = session();
        assert!(caller_matches(
            &session,
            &session.label,
            &session.label,
            &session.url
        ));
        assert!(!caller_matches(
            &session,
            "plugin-window-forged",
            "plugin-window-forged",
            &session.url
        ));
        assert!(!caller_matches(
            &session,
            &session.label,
            "main",
            &session.url
        ));
        assert!(!caller_matches(
            &session,
            &session.label,
            &session.label,
            &Url::parse("https://tauri.localhost/").unwrap()
        ));
    }

    #[test]
    fn binding_checks_every_field_and_labels_are_never_reused() {
        let mut sessions = WindowSessions::default();
        sessions
            .sessions
            .insert(options().binding.session_id.clone(), session());
        let binding = options().binding;
        assert!(sessions.bound_mut(&binding).is_ok());
        let mut serialized = serde_json::to_value(&binding).unwrap();
        for key in ["projectId", "nodeId", "sessionId"] {
            let previous = serialized[key].clone();
            serialized[key] = json!("forged");
            assert!(sessions
                .bound_mut(&serde_json::from_value(serialized.clone()).unwrap())
                .is_err());
            serialized[key] = previous;
        }
        for key in [
            "pluginId",
            "sourceDigest",
            "revisionDigest",
            "uiDigest",
            "toolId",
        ] {
            let previous = serialized["identity"][key].clone();
            serialized["identity"][key] = json!("forged");
            assert!(sessions
                .bound_mut(&serde_json::from_value(serialized.clone()).unwrap())
                .is_err());
            serialized["identity"][key] = previous;
        }
        serialized["canvasRevision"] = json!(8);
        assert!(sessions
            .bound_mut(&serde_json::from_value(serialized).unwrap())
            .is_err());
        let first_label = sessions.next_label().unwrap();
        drop(sessions.remove_matching(|_| true));
        assert!(sessions.bound_mut(&binding).is_err());
        assert_ne!(first_label, sessions.next_label().unwrap());
    }

    #[test]
    fn navigation_and_resource_routes_fail_closed() {
        let session = session();
        assert!(navigation_allowed(&session.url, &session.url));
        for target in [
            "https://example.com/",
            "http://tauri.localhost/",
            "file:///tmp/test",
            "about:blank",
        ] {
            assert!(!navigation_allowed(
                &session.url,
                &Url::parse(target).unwrap()
            ));
        }
        for suffix in ["index.html", "bootstrap.js", "bundle.js"] {
            let path = format!("/{}/{suffix}", session.options.binding.session_id);
            let (_, body) = protocol_body(&session, &path, "registered bundle").unwrap();
            if suffix == "bundle.js" {
                assert_eq!(body, b"registered bundle");
            }
            if suffix == "bootstrap.js" {
                let source = String::from_utf8(body).unwrap();
                assert!(!source.contains("__PLUGIN_WINDOW_CONFIG__"));
                assert!(source.contains(&session.options.binding.identity.revision_digest));
            }
        }
        for path in [
            "/index.html",
            "/other/bundle.js",
            "/../bundle.js",
            "/%2e%2e/bundle.js",
            "/src/main.tsx",
        ] {
            assert!(protocol_body(&session, path, "secret").is_err());
        }
    }

    #[test]
    fn duplicate_requests_and_overlapping_effects_are_denied() {
        let mut session = session();
        let effect = request(RequestKind::Effect, 1);
        let _receiver = enqueue(&mut session, &effect).unwrap();
        assert!(enqueue(&mut session, &effect).is_err());
        assert!(enqueue(&mut session, &request(RequestKind::Submit, 2)).is_err());
        assert!(enqueue(&mut session, &request(RequestKind::SetParameters, 3)).is_err());
        assert!(enqueue(&mut session, &request(RequestKind::Context, 4)).is_ok());
    }

    #[test]
    fn count_concurrency_and_payload_limits_include_close_escape_hatch() {
        let mut session = session();
        for number in 0..MAX_PENDING {
            let _ = enqueue(&mut session, &request(RequestKind::Context, number)).unwrap();
        }
        assert!(enqueue(&mut session, &request(RequestKind::Context, 99)).is_err());
        session.pending.clear();
        session.seen_requests.clear();
        let mut large = request(RequestKind::Effect, 100);
        large.payload = json!("x".repeat(MAX_REQUEST_BYTES));
        assert!(enqueue(&mut session, &large).is_err());
        for number in 0..MAX_REQUESTS {
            let _ = enqueue(&mut session, &request(RequestKind::Context, number)).unwrap();
            session.pending.clear();
        }
        assert!(enqueue(&mut session, &request(RequestKind::Context, 999)).is_err());
        assert!(enqueue(&mut session, &request(RequestKind::Close, 1000)).is_ok());
        assert!(enqueue(&mut session, &request(RequestKind::Close, 1001)).is_err());
    }

    #[tokio::test]
    async fn only_matching_reply_consumes_pending_and_revocation_cancels_waiters() {
        let mut session = session();
        let request = request(RequestKind::Effect, 1);
        let receiver = enqueue(&mut session, &request).unwrap();
        assert!(settle(&mut session, "wrong-id", "wrong".into()).is_err());
        assert_eq!(session.pending.len(), 1);
        settle(&mut session, &request.request_id, "correct".into()).unwrap();
        assert_eq!(receiver.await.unwrap().unwrap(), "correct");
        assert!(settle(&mut session, &request.request_id, "late".into()).is_err());
        let receiver =
            enqueue(&mut session, &super::tests::request(RequestKind::Effect, 2)).unwrap();
        let mut sessions = WindowSessions::default();
        sessions
            .sessions
            .insert(session.options.binding.session_id.clone(), session);
        let removed = sessions.remove_matching(|_| true);
        dispose_sessions(removed, CloseReason::PluginChanged);
        assert_eq!(receiver.await.unwrap().unwrap_err(), CLOSED_ERROR);
        assert!(sessions.bound_mut(&options().binding).is_err());
    }

    #[test]
    fn reply_is_a_bounded_json_string_not_a_raw_channel_response() {
        let reply = PluginWindowReply {
            ok: true,
            value: Some(json!({"frames": ["data:image/png;base64,example"]})),
            error: None,
        };
        let encoded = serialize_reply(&reply).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap()["ok"], true);
        // Tauri 序列化 String 后首字符是引号，不触发对象/数组回包的 Channel 路径。
        assert!(serde_json::to_string(&encoded).unwrap().starts_with('"'));
        for bad in [
            PluginWindowReply {
                ok: false,
                value: None,
                error: None,
            },
            PluginWindowReply {
                ok: true,
                value: None,
                error: Some("bad".into()),
            },
            PluginWindowReply {
                ok: false,
                value: Some(json!(1)),
                error: Some("bad".into()),
            },
        ] {
            assert!(serialize_reply(&bad).is_err());
        }
    }

    #[test]
    fn dedicated_page_has_no_app_entry_or_iframe_and_csp_has_no_business_network() {
        assert!(!HOST_HTML.contains("iframe"));
        assert!(!HOST_HTML.contains("/src/"));
        assert!(!HOST_HTML.contains("IndexedDB"));
        assert!(CSP.contains("connect-src ipc: http://ipc.localhost;"));
        for rule in [
            "frame-ancestors 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "object-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ] {
            assert!(CSP.contains(rule));
        }
        for forbidden in ["unsafe-eval", "https:", "asset:", "file:", "*"] {
            assert!(!CSP.contains(forbidden));
        }
        assert_eq!(RequestKind::Effect.timeout(), Duration::from_secs(180));
        assert_eq!(RequestKind::Context.timeout(), Duration::from_secs(30));
    }

    #[cfg(feature = "tauri-channel-tests")]
    #[test]
    fn real_application_acl_and_command_guards_reject_unregistered_plugin_callers() {
        use tauri::{
            ipc::{CallbackFn, InvokeBody, RuntimeAuthority},
            test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
            utils::{
                acl::{capability::Capability, manifest::Manifest, resolved::Resolved},
                platform::Target,
            },
            webview::InvokeRequest,
        };
        let manifests: BTreeMap<String, Manifest> =
            serde_json::from_str(include_str!("../../gen/schemas/acl-manifests.json")).unwrap();
        let capabilities = [
            include_str!("../../capabilities/default.json"),
            include_str!("../../capabilities/plugin-ui-window.json"),
        ]
        .into_iter()
        .map(|json| {
            let capability: Capability = serde_json::from_str(json).unwrap();
            (capability.identifier.clone(), capability)
        })
        .collect();
        let resolved = Resolved::resolve(&manifests, capabilities, Target::current()).unwrap();
        let mut context = mock_context(noop_assets());
        *context.runtime_authority_mut() = RuntimeAuthority::new(manifests, resolved);
        let app = mock_builder()
            .register_uri_scheme_protocol("plugin-window", handle_protocol)
            .invoke_handler(tauri::generate_handler![
                open_plugin_ui_window,
                close_plugin_ui_window,
                respond_plugin_ui_window_request,
                plugin_ui_window_request
            ])
            .build(context)
            .unwrap();
        for label in [
            "main",
            "chat-assistant",
            "plugin-window-unregistered",
            "ungranted",
        ] {
            let window = WebviewWindowBuilder::new(
                &app,
                label,
                if label.starts_with("plugin-window") {
                    WebviewUrl::CustomProtocol(session_url(&options().binding.session_id))
                } else {
                    WebviewUrl::default()
                },
            )
            .build()
            .unwrap();
            let invoke = |command: &str, body: Value| {
                get_ipc_response(
                    &window,
                    InvokeRequest {
                        cmd: command.into(),
                        callback: CallbackFn(1),
                        error: CallbackFn(2),
                        url: window.url().unwrap(),
                        body: InvokeBody::Json(body),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.into(),
                    },
                )
            };
            let close = invoke(
                "close_plugin_ui_window",
                json!({ "binding": options().binding }),
            );
            match label {
                "main" => assert!(close.is_ok()),
                "chat-assistant" => {
                    assert!(close.unwrap_err().as_str().unwrap().contains("仅主窗口"))
                }
                _ => assert!(close.unwrap_err().as_str().unwrap().contains("not allowed")),
            }
            let bridge = invoke(
                "plugin_ui_window_request",
                json!({ "request": {
                    "binding": options().binding, "requestId": request(RequestKind::Context, 1).request_id,
                    "kind": "context", "payload": null,
                }}),
            );
            if label == "plugin-window-unregistered" {
                assert_eq!(bridge.unwrap_err().as_str(), Some(CLOSED_ERROR));
                // 即使命中 label capability，也没有管理、文件、Shell、通用事件或 Channel 取数权限。
                for command in [
                    "open_plugin_ui_window",
                    "respond_plugin_ui_window_request",
                    "plugin:fs|stat",
                    "plugin:shell|execute",
                    "plugin:event|emit",
                    "plugin:__TAURI_CHANNEL__|fetch",
                ] {
                    assert!(
                        invoke(command, json!({}))
                            .unwrap_err()
                            .as_str()
                            .unwrap()
                            .contains("not allowed"),
                        "{command}"
                    );
                }
            } else {
                assert!(bridge
                    .unwrap_err()
                    .as_str()
                    .unwrap()
                    .contains("not allowed"));
            }
        }
    }
}
