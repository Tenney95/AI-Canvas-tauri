//! Fixed Muse WebView adapter. Remote pages receive no application capability or IPC.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::{collections::BTreeMap, path::PathBuf, sync::{LazyLock, Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use tauri::{webview::{Cookie, NewWindowResponse, PageLoadEvent}, AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

const ORIGIN: &str = "https://muse.ai";
const NEW_THREAD: &str = "https://muse.ai/thread/new";
const LOGIN_LABEL: &str = "muse-login";
const SESSION_LABEL: &str = "muse-session";
const SECRET_KEY: &str = "muse/session";
const PAGE_ADAPTER: &str = include_str!("muse/page.js");
#[path = "muse/cookies.rs"]
mod cookies;
#[path = "muse/evaluation.rs"]
mod evaluation;
#[cfg(windows)]
#[path = "muse/windows_navigation.rs"]
mod windows_navigation;
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static AUTH_EPOCH: AtomicU64 = AtomicU64::new(1);
static NEXT_WINDOW_INSTANCE: AtomicU64 = AtomicU64::new(1);
static AUTH_CACHE: Mutex<AuthCache> = Mutex::new(AuthCache { state: SessionState::Unverified, checking_epoch: None, last_check: None, message: None });
static WINDOW_LOADS: LazyLock<Mutex<BTreeMap<String, WindowLoad>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
// Text is intentionally process-local; task metadata never stores prompt or answer.
static TEXT_RESULTS: LazyLock<Mutex<BTreeMap<String, String>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
const MAX_TEXT_BYTES: usize = 256 * 1024;
const DELIVERY_UNCONFIRMED: &str = "Muse 尚未确认新对话已送达，原任务已保留；不会自动重发";
const TASK_CONFLICT: &str = "Muse 会话出现额外轮次或文本超过 256 KiB，请在官网查看原回复；不会重新发送";

#[derive(Clone, Copy)]
enum SessionState { Verified, Invalid, Unverified, Missing }
impl SessionState {
    fn name(self) -> &'static str { match self { Self::Verified => "verified", Self::Invalid => "invalid", Self::Unverified => "unverified", Self::Missing => "missing" } }
}
struct AuthCache { state: SessionState, checking_epoch: Option<u64>, last_check: Option<Instant>, message: Option<&'static str> }
struct WindowLoad {
    state: &'static str, started: Instant, epoch: u64, instance: u64, native_ready: bool,
    local_policy: Option<&'static str>, blocked_host: Option<String>, download_blocked: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    task_id: String,
    kind: String,
    status: String,
    thread: Option<String>,
    #[serde(default)] abandoned: bool,
    #[serde(default)] ready: bool,
    #[serde(default)] input_hashes: Vec<String>,
    #[serde(default)] mime: Option<String>,
    session_hash: String,
    #[serde(default)] refusal_observations: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIdentity { task_id: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    logged_in: bool, login_open: bool,
    credential_stored: bool,
    session_state: String,
    login_state: String,
    checking: bool,
    #[cfg(windows)]
    #[serde(skip_serializing_if = "Option::is_none")]
    native_navigation: Option<windows_navigation::Snapshot>,
    #[serde(skip_serializing_if = "Option::is_none")] active_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] message: Option<String>,
}

#[derive(Serialize)]
pub struct TaskStatus {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")] url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] error: Option<String>,
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    #[cfg(windows)] {
        #[link(name = "advapi32")]
        unsafe extern "system" { #[link_name = "SystemFunction036"] fn rtl_gen_random(buffer: *mut std::ffi::c_void, length: u32) -> u8; }
        if unsafe { rtl_gen_random(bytes.as_mut_ptr().cast(), bytes.len() as u32) } == 0 { return Err("Muse 随机身份不可用".into()); }
    }
    #[cfg(unix)] {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).map_err(|_| "Muse 随机身份不可用")?;
    }
    #[cfg(not(any(windows, unix)))] return Err("当前平台不支持 Muse".into());
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn new_task_id() -> Result<String, String> {
    let hex = random_id()?;
    let variant = u8::from_str_radix(&hex[16..18], 16).map_err(|_| "Muse 随机身份不可用")?;
    Ok(format!("{}-{}-4{}-{:x}{}-{}", &hex[..8], &hex[8..12], &hex[13..16], (variant >> 4 & 3) | 8, &hex[17..20], &hex[20..32]))
}
fn valid_task_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-', 14 => byte == b'4', 19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
        _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
    })
}
fn muse_url(url: &Url) -> bool { url.scheme() == "https" && url.host_str() == Some("muse.ai") && url.port_or_known_default() == Some(443) && url.username().is_empty() && url.password().is_none() }
fn login_url(url: &Url) -> bool {
    // Interactive authentication may redirect to any HTTPS host; Muse keeps its
    // own adapter/verification branch and remote pages receive no application IPC.
    url.scheme() == "https" && url.port_or_known_default() == Some(443) && url.username().is_empty() && url.password().is_none()
        && !muse_url(url)
}
fn waiting_for_login(epoch: u64) -> bool {
    WINDOW_LOADS.lock().ok().is_some_and(|loads| loads.get(LOGIN_LABEL)
        .is_some_and(|load| load.epoch == epoch && load.local_policy == Some("allow-login")))
}
fn blocked_https_host(url: &Url) -> Option<String> {
    if url.scheme() != "https" { return None; }
    let host = url.host_str()?.trim_end_matches('.');
    if host.is_empty() || host.len() > 253 || !host.split('.').all(|label| !label.is_empty() && label.len() <= 63
        && !label.starts_with('-') && !label.ends_with('-') && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')) { return None; }
    Some(host.to_ascii_lowercase())
}
fn valid_thread(thread: &str) -> bool {
    thread.starts_with("/thread/") && thread != "/thread/new" && thread.len() > 8 && thread.len() <= 256
        && thread[8..].bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn confirmed_send_thread(result: &Value) -> Option<&str> {
    if result.get("sent") != Some(&Value::Bool(true)) { return None; }
    result.get("thread").and_then(Value::as_str).filter(|thread| valid_thread(thread))
}
fn private_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = crate::secret_store::secret_dir(app)?.join("muse");
    std::fs::create_dir_all(path.join("tasks")).map_err(|_| "Muse 私有目录不可用")?;
    Ok(path)
}
fn task_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_task_id(id) { return Err("Muse 任务身份无效".into()); }
    Ok(private_dir(app)?.join("tasks").join(format!("{id}.json")))
}
fn load(app: &AppHandle, id: &str) -> Result<Task, String> {
    let bytes = std::fs::read(task_file(app, id)?).map_err(|_| "Muse 任务记录不可用")?;
    if bytes.len() > 8192 { return Err("Muse 任务记录无效".into()); }
    let task: Task = serde_json::from_slice(&bytes).map_err(|_| "Muse 任务记录无效")?;
    if task.task_id != id || !matches!(task.kind.as_str(), "image" | "video" | "text")
        || !matches!(task.status.as_str(), "prepared" | "running" | "completed" | "failed" | "unknown")
        || task.thread.as_ref().is_some_and(|thread| !valid_thread(thread)) || task.input_hashes.len() > 4
        || task.session_hash.len() != 64 || !task.session_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Muse 任务记录无效".into());
    }
    Ok(task)
}
fn save(app: &AppHandle, task: &Task) -> Result<(), String> {
    let path = task_file(app, &task.task_id)?;
    let temp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&temp).map_err(|_| "Muse 任务保存失败")?;
    file.write_all(&serde_json::to_vec(task).map_err(|_| "Muse 任务保存失败")?).map_err(|_| "Muse 任务保存失败")?;
    file.sync_all().map_err(|_| "Muse 任务保存失败")?;
    drop(file);
    std::fs::rename(temp, path).map_err(|_| "Muse 任务保存失败".into())
}
fn active_task(app: &AppHandle, except: Option<&str>) -> Result<Option<String>, String> {
    for entry in std::fs::read_dir(private_dir(app)?.join("tasks")).map_err(|_| "Muse 任务目录不可用")? {
        let entry = entry.map_err(|_| "Muse 任务目录不可用")?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else { continue; };
        let task = load(app, id)?;
        if Some(id) != except && !task.abandoned && matches!(task.status.as_str(), "running" | "unknown") { return Ok(Some(id.to_string())); }
    }
    Ok(None)
}
fn task_label(id: &str) -> String { format!("muse-task-{id}") }

async fn evaluate(window: &WebviewWindow, expression: &str) -> Result<Value, String> {
    evaluate_with_timeout(window, expression, Duration::from_secs(85)).await
}

async fn evaluate_with_timeout(window: &WebviewWindow, expression: &str, timeout: Duration) -> Result<Value, String> {
    evaluation::evaluate(window, expression, timeout).await
}

// false means a login window is waiting on an allowed authentication origin.
async fn wait_for_adapter(window: &WebviewWindow) -> Result<bool, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    while tokio::time::Instant::now() < deadline {
        if window.label() == LOGIN_LABEL && waiting_for_login(AUTH_EPOCH.load(Ordering::SeqCst)) { return Ok(false); }
        if evaluate_with_timeout(window, "!!(window.__aiCanvasMuseAdapter && document.body && document.querySelector('textarea,input,button'))", Duration::from_secs(2)).await.unwrap_or(Value::Bool(false)) == Value::Bool(true) { return Ok(true); }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Muse 页面加载超时，尚未发送生成请求".into())
}

fn build_window(app: &AppHandle, label: &str, login: bool) -> Result<WebviewWindow, String> {
    let profile = private_dir(app)?.join(format!("profiles/{label}-{}", random_id()?));
    std::fs::create_dir_all(&profile).map_err(|_| "Muse 浏览器目录不可用")?;
    let navigation_label = label.to_string();
    let page_app = app.clone();
    let page_label = label.to_string();
    let download_label = label.to_string();
    let window_epoch = AUTH_EPOCH.load(Ordering::SeqCst);
    let window_instance = NEXT_WINDOW_INSTANCE.fetch_add(1, Ordering::Relaxed);
    WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?.insert(label.into(), WindowLoad { state: "loading", started: Instant::now(), epoch: window_epoch, instance: window_instance, native_ready: false, local_policy: None, blocked_host: None, download_blocked: false });
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(Url::parse("about:blank").map_err(|_| "Muse 地址无效")?))
        .title(if login { "Muse — 正在初始化登录浏览器" } else { "Muse — 正在初始化任务浏览器" })
        .inner_size(1100.0, 800.0).visible(login).devtools(login && cfg!(debug_assertions)).data_directory(profile).incognito(true)
        .initialization_script(format!("if(location.origin==='https://muse.ai'){{{PAGE_ADAPTER}}}"))
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" { return true; }
            if muse_url(url) {
                if let Ok(mut loads) = WINDOW_LOADS.lock() { if let Some(load) = loads.get_mut(&navigation_label).filter(|load| load.epoch == window_epoch && load.instance == window_instance) {
                    load.state = "loading"; load.started = Instant::now(); load.local_policy = Some("allow-muse"); load.blocked_host = None; load.download_blocked = false;
                } }
                return true;
            }
            // Login providers may navigate within this isolated profile, never to local/app protocols.
            let allowed = login && login_url(url);
            if let Ok(mut loads) = WINDOW_LOADS.lock() { if let Some(load) = loads.get_mut(&navigation_label).filter(|load| load.epoch == window_epoch && load.instance == window_instance) {
                load.local_policy = Some(if allowed { "allow-login" } else { "deny-redirect" });
                load.blocked_host = if allowed { None } else { blocked_https_host(url) };
                load.download_blocked = false;
                load.state = if allowed { "waiting-login" } else { "blocked" };
            } }
            allowed
        })
        .on_page_load(move |page_window, payload| {
            // WebView2 event callbacks only update memory and schedule work. They never
            // synchronously read cookies, navigate, or wait for a WebView response.
            if login && login_url(payload.url()) {
                let mut current = false;
                if let Ok(mut loads) = WINDOW_LOADS.lock() { if let Some(load) = loads.get_mut(&page_label).filter(|load| load.epoch == window_epoch && load.instance == window_instance && load.native_ready) {
                    load.state = "waiting-login"; current = true;
                } }
                if current {
                    tauri::async_runtime::spawn(async move {
                        if AUTH_EPOCH.load(Ordering::SeqCst) != window_epoch { return; }
                        let current = WINDOW_LOADS.lock().ok().is_some_and(|loads| loads.get(page_window.label())
                            .is_some_and(|load| load.epoch == window_epoch && load.instance == window_instance && load.state == "waiting-login"));
                        if current { let _ = page_window.set_title("Muse — 请完成登录认证"); }
                    });
                }
                return;
            }
            if !muse_url(payload.url()) { return; }
            let mut schedule_auth = false;
            if let Ok(mut loads) = WINDOW_LOADS.lock() { if let Some(load) = loads.get_mut(&page_label).filter(|load| load.epoch == window_epoch && load.instance == window_instance && load.native_ready) {
                if load.state != "blocked" { load.state = if payload.event() == PageLoadEvent::Started { "loading" } else { "loaded" }; }
                schedule_auth = payload.event() == PageLoadEvent::Finished;
            } }
            if page_label == LOGIN_LABEL && schedule_auth && AUTH_EPOCH.load(Ordering::SeqCst) == window_epoch {
                let auth_app = page_app.clone();
                tauri::async_runtime::spawn(async move {
                    // A new document needs a fresh readiness check even when the prior
                    // page was verified; otherwise its load state would stay "loaded".
                    if AUTH_EPOCH.load(Ordering::SeqCst) == window_epoch { start_auth_check_at_epoch(auth_app, true, window_epoch); }
                });
            }
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(move |_, event| {
            if matches!(event, tauri::webview::DownloadEvent::Requested { .. }) {
                if let Ok(mut loads) = WINDOW_LOADS.lock() {
                    if let Some(load) = loads.get_mut(&download_label).filter(|load| load.epoch == window_epoch && load.instance == window_instance) { load.download_blocked = true; }
                }
                #[cfg(windows)]
                windows_navigation::download_blocked(&download_label, window_epoch, window_instance);
            }
            false
        })
        ;
    let window = builder.build().map_err(|_| "无法创建 Muse 独立窗口")?;
    let close_label = label.to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut loads) = WINDOW_LOADS.lock() {
                if loads.get(&close_label).is_some_and(|load| load.epoch == window_epoch && load.instance == window_instance) { loads.remove(&close_label); }
            }
            #[cfg(windows)]
            windows_navigation::forget(&close_label, window_epoch, window_instance);
        }
    });
    Ok(window)
}

struct MuseWindowStartup {
    window: Option<WebviewWindow>,
    target: Url,
    epoch: u64,
    instance: u64,
    login: bool,
}

impl Drop for MuseWindowStartup {
    fn drop(&mut self) {
        // Capture the exact native identity; never look up a potentially reused label.
        if let Some(window) = self.window.take() { let _ = window.destroy(); }
    }
}

fn begin_muse_window(app: &AppHandle, label: &str, login: bool, target: &str) -> Result<MuseWindowStartup, String> {
    let target = Url::parse(target).map_err(|_| "Muse 目标地址无效")?;
    let allowed_path = if login || label == SESSION_LABEL { target.path() == "/" }
        else { target.path() == "/thread/new" || valid_thread(target.path()) };
    if !muse_url(&target) || !allowed_path || target.query().is_some() || target.fragment().is_some() {
        return Err("Muse 目标地址超出固定登录与任务范围".into());
    }
    let epoch = AUTH_EPOCH.load(Ordering::SeqCst);
    let window = build_window(app, label, login)?;
    let instance = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?.get(label).map(|load| load.instance).ok_or("Muse 浏览器初始化已取消")?;
    Ok(MuseWindowStartup { window: Some(window), target, epoch, instance, login })
}

async fn wait_muse_window(startup: MuseWindowStartup) -> Result<MuseWindowStartup, String> {
    let window = startup.window.as_ref().ok_or("Muse 浏览器初始化已取消")?.clone();
    let (sender, receiver) = oneshot::channel();
    let late_window = window.clone();
    window.with_webview(move |_| {
        // The runtime invokes this only after the physical WebView has been installed.
        // No cookies, navigation or waiting takes place inside this UI callback.
        if sender.send(()).is_err() {
            tauri::async_runtime::spawn(async move { let _ = late_window.destroy(); });
        }
    }).map_err(|_| "muse_webview_init_failed")?;
    tokio::time::timeout(Duration::from_secs(45), receiver).await
        .map_err(|_| "muse_webview_init_timeout")?
        .map_err(|_| "muse_webview_init_failed")?;
    Ok(startup)
}

async fn finish_muse_window(app: &AppHandle, mut startup: MuseWindowStartup) -> Result<WebviewWindow, String> {
    if AUTH_EPOCH.load(Ordering::SeqCst) != startup.epoch { return Err("Muse 登录操作已更新，旧窗口已取消".into()); }
    let window = startup.window.as_ref().ok_or("Muse 浏览器初始化已取消")?.clone();
    let current = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?.get(window.label())
        .is_some_and(|load| load.epoch == startup.epoch && load.instance == startup.instance);
    if !current { return Err("Muse 浏览器实例已变化，旧窗口已取消".into()); }
    restore_cookies(app, &window)?;
    if startup.login { let _ = window.set_title("Muse — 正在加载登录页"); }
    {
        let mut loads = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?;
        let load = loads.get_mut(window.label()).filter(|load| load.epoch == startup.epoch && load.instance == startup.instance).ok_or("Muse 浏览器实例已变化")?;
        load.native_ready = true;
    }
    #[cfg(windows)]
    windows_navigation::navigate(&window, &startup.target, startup.epoch, startup.instance).await?;
    #[cfg(not(windows))]
    window.navigate(startup.target.clone()).map_err(|_| "Muse 官网导航未能提交")?;
    let _ = startup.window.take();
    Ok(window)
}

async fn create_muse_window(app: &AppHandle, label: &str, login: bool, target: &str) -> Result<WebviewWindow, String> {
    let startup = begin_muse_window(app, label, login, target)?;
    let startup = wait_muse_window(startup).await?;
    finish_muse_window(app, startup).await
}

fn read_cookies(app: &AppHandle) -> Result<Vec<String>, String> {
    let value = crate::secret_store::read_internal_secret_sync(app, SECRET_KEY).map_err(|_| "Muse 凭据读取失败")?;
    match value { Some(value) => serde_json::from_str(&value).map_err(|_| "Muse 凭据无效".into()), None => Ok(vec![]) }
}
fn session_hash(app: &AppHandle) -> Result<String, String> {
    for text in read_cookies(app)? {
        let cookie = Cookie::parse(text).map_err(|_| "Muse 凭据无效")?;
        if cookie.name() == "hatch_sess" { return Ok(format!("{:x}", Sha256::digest(cookie.value().as_bytes()))); }
    }
    Err("Muse 登录会话不可用".into())
}
fn restore_cookies(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    for text in read_cookies(app)? {
        let cookie = Cookie::parse(text).map_err(|_| "Muse 凭据无效")?.into_owned();
        if !matches!(cookie.name(), "hatch_sess" | "hatch_vml" | "hatch_gw")
            || !matches!(cookie.domain(), Some("muse.ai" | ".muse.ai")) { return Err("Muse 凭据无效".into()); }
        window.set_cookie(cookie).map_err(|_| "Muse 会话恢复失败")?;
    }
    Ok(())
}
fn persist_window_cookies(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let cookies: Vec<_> = window.cookies_for_url(Url::parse(ORIGIN).map_err(|_| "Muse 地址无效")?)
        .map_err(|_| "Muse 登录状态读取失败")?.into_iter()
        .filter(|cookie| matches!(cookie.name(), "hatch_sess" | "hatch_vml" | "hatch_gw") && !cookie.value().is_empty()).collect();
    if !cookies.iter().any(|cookie| cookie.name() == "hatch_sess") { return Ok(()); }
    let values: Vec<String> = cookies.into_iter().map(|cookie| cookie.to_string()).collect();
    persist_cookie_values(app, window.label(), &values)
}
fn persist_cookie_values(app: &AppHandle, source_label: &str, values: &[String]) -> Result<(), String> {
    let serialized = serde_json::to_string(&values).map_err(|_| "Muse 凭据保存失败")?;
    let previous = crate::secret_store::read_internal_secret_sync(app, SECRET_KEY).map_err(|_| "Muse 凭据读取失败")?;
    crate::secret_store::set_internal_secret_sync(app, SECRET_KEY, &serialized).map_err(|_| "Muse 凭据保存失败")?;
    if previous.as_deref() != Some(serialized.as_str()) {
        for label in [LOGIN_LABEL, SESSION_LABEL] {
            if label != source_label { if let Some(stale) = app.get_webview_window(label) { let _ = stale.destroy(); } }
        }
    }
    Ok(())
}

fn auth_snapshot(app: &AppHandle) -> Result<AuthStatus, String> {
    let credential_stored = !read_cookies(app)?.is_empty();
    let epoch = AUTH_EPOCH.load(Ordering::SeqCst);
    let cache = AUTH_CACHE.lock().map_err(|_| "Muse 登录状态不可用")?;
    let login_open = auth_window(app, LOGIN_LABEL, false).is_some();
    let login_state = if !login_open { "closed" } else {
        let loads = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?;
        match loads.get(LOGIN_LABEL) {
            Some(load) if load.local_policy == Some("allow-login") => "waiting-login",
            Some(load) if matches!(load.state, "loading" | "loaded") && load.started.elapsed() >= Duration::from_secs(45) => "timeout",
            Some(load) if load.state == "loaded" => "loading",
            Some(load) => load.state,
            None => "loading",
        }
    };
    let state = if login_state == "waiting-login" { SessionState::Unverified } else if credential_stored { cache.state } else { SessionState::Missing };
    Ok(AuthStatus { logged_in: matches!(state, SessionState::Verified), login_open, credential_stored,
        session_state: state.name().into(), login_state: login_state.into(), checking: cache.checking_epoch == Some(epoch) && login_state != "waiting-login",
        #[cfg(windows)]
        native_navigation: windows_navigation::snapshot(epoch),
        active_task_id: active_task(app, None)?, message: if login_state == "waiting-login" {
            Some("请在 Muse 登录窗口完成认证，返回 Muse 后会自动检查登录状态".into())
        } else { cache.message.map(str::to_string).or_else(|| match login_state {
            "blocked" => Some("Muse 登录页跳转被拦截，请重试窗口或手动导入 Cookie".into()),
            "timeout" | "failed" => Some("Muse 登录页未能加载，请重试窗口或手动导入 Cookie；已保存凭据不会丢失".into()),
            "loading" => Some("正在加载 Muse 官网，可重试窗口或手动导入 Cookie".into()),
            _ => None,
        }) } })
}

fn current_auth_window(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    auth_window(app, label, true)
}
fn auth_window(app: &AppHandle, label: &str, require_ready: bool) -> Option<WebviewWindow> {
    let current = WINDOW_LOADS.lock().ok().and_then(|loads| loads.get(label).map(|load| load.epoch == AUTH_EPOCH.load(Ordering::SeqCst) && (!require_ready || load.native_ready))).unwrap_or(false);
    if current { app.get_webview_window(label) } else { None }
}

fn physically_ready_window(app: &AppHandle, label: &str) -> Result<Option<WebviewWindow>, String> {
    let Some(window) = app.get_webview_window(label) else { return Ok(None); };
    let ready = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?.get(label).is_some_and(|load| load.native_ready);
    if !ready { return Err("Muse 浏览器正在初始化，请稍后重试".into()); }
    Ok(Some(window))
}

fn advance_auth_epoch(state: SessionState, message: Option<&'static str>) {
    AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut cache) = AUTH_CACHE.lock() { cache.state = state; cache.checking_epoch = None; cache.last_check = None; cache.message = message; }
    #[cfg(windows)]
    windows_navigation::clear();
}

async fn cookie_snapshot(window: &WebviewWindow) -> Result<Vec<String>, String> {
    let window = window.clone();
    let operation = tauri::async_runtime::spawn_blocking(move || {
        let values = window.cookies_for_url(Url::parse(ORIGIN).map_err(|_| "Muse 地址无效")?).map_err(|_| "Muse 登录状态读取失败")?;
        Ok::<Vec<String>, String>(values.into_iter().filter(|cookie| matches!(cookie.name(), "hatch_sess" | "hatch_vml" | "hatch_gw") && !cookie.value().is_empty()).map(|cookie| cookie.to_string()).collect())
    });
    tokio::time::timeout(Duration::from_secs(5), operation).await.map_err(|_| "Muse 登录状态读取超时")?.map_err(|_| "Muse 登录状态读取失败")?
}

async fn commit_cookie_snapshot(app: &AppHandle, window: &WebviewWindow, values: &[String], epoch: u64) -> Result<(), String> {
    if !values.iter().any(|text| Cookie::parse(text.as_str()).is_ok_and(|cookie| cookie.name() == "hatch_sess")) { return Ok(()); }
    let _gate = GATE.lock().await;
    if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return Err("Muse 登录操作已更新".into()); }
    if current_auth_window(app, window.label()).is_none() { return Err("Muse 旧登录窗口已失效".into()); }
    persist_cookie_values(app, window.label(), values)
}

async fn fetch_session_state(window: &WebviewWindow) -> Result<SessionState, String> {
    let result = evaluate_with_timeout(window, r#"(async()=>{
      const response = await fetch('/api/session', { credentials:'include', redirect:'error', signal:AbortSignal.timeout(12000) });
      if(response.status===401)return {state:'invalid'};
      if(response.status!==200)throw new Error('session-unconfirmed');
      const reader=response.body.getReader();let total=0;const chunks=[];
      while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;
        if(total>1048576){await reader.cancel();throw new Error('session-size');}chunks.push(part.value);}
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const session=JSON.parse(new TextDecoder().decode(bytes));return {state:session.status==='assigned'?'verified':'unverified'};
    })()"#, Duration::from_secs(15)).await?;
    match result.get("state").and_then(Value::as_str) {
        Some("verified") => Ok(SessionState::Verified), Some("invalid") => Ok(SessionState::Invalid),
        Some("unverified") => Ok(SessionState::Unverified), _ => Err("Muse 会话状态未确认".into()),
    }
}

async fn background_auth_window(app: &AppHandle, epoch: u64) -> Result<Option<WebviewWindow>, String> {
    loop {
        // Serialize local window identity/teardown/creation and credential installation.
        // Hydration, browser-cookie capture, network requests and the wait for a
        // destroyed label never hold this gate.
        let gate = GATE.lock().await;
        if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return Err("Muse 登录操作已更新".into()); }
        if let Some(window) = current_auth_window(app, LOGIN_LABEL).or_else(|| current_auth_window(app, SESSION_LABEL)) { return Ok(Some(window)); }
        if read_cookies(app)?.is_empty() { return Ok(None); }
        if let Some(stale) = app.get_webview_window(SESSION_LABEL) {
            let initializing = WINDOW_LOADS.lock().map_err(|_| "Muse 加载状态不可用")?.get(SESSION_LABEL).is_some_and(|load| load.epoch == epoch && !load.native_ready);
            if initializing { return Err("Muse 浏览器正在初始化，请稍后重试".into()); }
            // Under GATE this handle is known to predate the current epoch. Destroy
            // the captured handle, not a later lookup that could name a new window.
            stale.destroy().map_err(|_| "Muse 旧会话窗口关闭失败，请稍后重试")?;
            drop(gate);
            for _ in 0..40 {
                if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return Err("Muse 登录操作已更新".into()); }
                if app.get_webview_window(SESSION_LABEL).is_none() { break; }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return Err("Muse 登录操作已更新".into()); }
            if app.get_webview_window(SESSION_LABEL).is_some() { return Err("Muse 旧会话窗口尚未关闭，请稍后重试".into()); }
            continue;
        }
        let startup = begin_muse_window(app, SESSION_LABEL, false, ORIGIN)?;
        drop(gate);
        let startup = wait_muse_window(startup).await?;
        let _gate = GATE.lock().await;
        return finish_muse_window(app, startup).await.map(Some);
    }
}

async fn check_auth_background(app: &AppHandle, epoch: u64) -> Result<Option<SessionState>, String> {
    if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return Err("Muse 登录操作已更新".into()); }
    if active_task(app, None)?.is_some() { return AUTH_CACHE.lock().map(|cache| Some(cache.state)).map_err(|_| "Muse 登录状态不可用".into()); }
    let Some(window) = background_auth_window(app, epoch).await? else { return Ok(Some(SessionState::Missing)); };
    if !wait_for_adapter(&window).await? { return Ok(None); }
    {
        let _gate = GATE.lock().await;
        if AUTH_EPOCH.load(Ordering::SeqCst) != epoch || current_auth_window(app, window.label()).is_none() { return Err("Muse 登录操作已更新".into()); }
        if window.label() == LOGIN_LABEL && waiting_for_login(epoch) { return Ok(None); }
        if let Ok(mut loads) = WINDOW_LOADS.lock() { if let Some(load) = loads.get_mut(window.label()).filter(|load| load.epoch == epoch) { load.state = "ready"; } }
        if window.label() == LOGIN_LABEL { let _ = window.set_title("Muse — 登录"); }
    }
    let before = cookie_snapshot(&window).await?;
    commit_cookie_snapshot(app, &window, &before, epoch).await?;
    if window.label() == LOGIN_LABEL && waiting_for_login(epoch) { return Ok(None); }
    if before.is_empty() && read_cookies(app)?.is_empty() { return Ok(Some(SessionState::Missing)); }
    let state = fetch_session_state(&window).await?;
    let after = cookie_snapshot(&window).await?;
    commit_cookie_snapshot(app, &window, &after, epoch).await?;
    Ok(Some(state))
}

fn start_auth_check(app: AppHandle) {
    start_auth_check_with_force(app, false);
}
fn start_auth_check_with_force(app: AppHandle, force: bool) {
    let epoch = AUTH_EPOCH.load(Ordering::SeqCst);
    start_auth_check_at_epoch(app, force, epoch);
}
fn start_auth_check_at_epoch(app: AppHandle, force: bool, epoch: u64) {
    if waiting_for_login(epoch) { return; }
    if let Ok(mut cache) = AUTH_CACHE.lock() {
        if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return; }
        if cache.checking_epoch == Some(epoch) { return; }
        if !force && (matches!(cache.state, SessionState::Verified) || cache.last_check.is_some_and(|last| last.elapsed() < Duration::from_secs(2))) { return; }
        cache.checking_epoch = Some(epoch); cache.message = None;
        cache.last_check = Some(Instant::now());
    } else { return; }
    tauri::async_runtime::spawn(async move {
        let result = check_auth_background(&app, epoch).await;
        let _gate = GATE.lock().await;
        if AUTH_EPOCH.load(Ordering::SeqCst) != epoch { return; }
        let waiting_login = matches!(&result, Ok(None)) || waiting_for_login(epoch);
        let check_failed = result.is_err() && !waiting_login;
        if let Ok(mut cache) = AUTH_CACHE.lock() {
            if cache.checking_epoch != Some(epoch) { return; }
            cache.checking_epoch = None;
            match result {
                _ if waiting_login => { cache.state = SessionState::Unverified; cache.message = None; }
                Ok(Some(state)) => { cache.state = state; cache.message = if matches!(state, SessionState::Invalid) { Some("Muse 会话已被官网明确拒绝，请重新登录或更新 Cookie") } else { None }; }
                Ok(None) => {}
                Err(_) => { cache.state = SessionState::Unverified; cache.message = Some("暂无法在线确认 Muse 会话，已保存凭据不会丢失；可重试窗口或手动导入 Cookie"); }
            }
        }
        if let Some(window) = current_auth_window(&app, LOGIN_LABEL) {
            let failed = if let Ok(mut loads) = WINDOW_LOADS.lock() {
                if let Some(load) = loads.get_mut(LOGIN_LABEL).filter(|load| load.epoch == epoch) {
                    if !waiting_login && (check_failed || load.state != "ready") { load.state = "failed"; true } else { false }
                } else { false }
            } else { false };
            if failed { let _ = window.set_title("Muse — 页面加载失败，请重试或导入 Cookie"); }
        }
    });
}
fn capture_cookies(app: &AppHandle) -> Result<(), String> {
    let Some(window) = physically_ready_window(app, LOGIN_LABEL)? else { return Ok(()); };
    persist_window_cookies(app, &window)
}

async fn session_valid(app: &AppHandle) -> Result<bool, String> {
    if read_cookies(app)?.is_empty() { return Ok(false); }
    let active_id = active_task(app, None)?;
    let active = match active_id.as_ref() { Some(id) => physically_ready_window(app, &task_label(id))?, None => None };
    let window = if let Some(window) = active { window }
    else if let Some(window) = physically_ready_window(app, LOGIN_LABEL)? { window }
    else if let Some(window) = physically_ready_window(app, SESSION_LABEL)? { window }
    else {
        create_muse_window(app, SESSION_LABEL, false, ORIGIN).await?
    };
    if window.label() == LOGIN_LABEL && !window.url().is_ok_and(|url| muse_url(&url)) { return Ok(false); }
    if !wait_for_adapter(&window).await? { return Ok(false); }
    let state = fetch_session_state(&window).await?;
    persist_window_cookies(app, &window)?;
    if let Some(id) = active_id {
        // Only the exact task profile may advance the fingerprint on cookie renewal.
        if window.label() == task_label(&id) {
            let mut task = load(app, &id)?;
            task.session_hash = session_hash(app)?;
            save(app, &task)?;
        }
    }
    if let Ok(mut cache) = AUTH_CACHE.lock() { cache.state = state; cache.message = None; }
    Ok(matches!(state, SessionState::Verified))
}

#[tauri::command]
pub async fn muse_auth_status(app: AppHandle, webview: Webview, verify: Option<bool>) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if verify.unwrap_or(false) { start_auth_check_with_force(app.clone(), true); }
    else if current_auth_window(&app, LOGIN_LABEL).is_some() {
        let retryable = WINDOW_LOADS.lock().ok().and_then(|loads| loads.get(LOGIN_LABEL).map(|load|
            !matches!(load.state, "failed" | "blocked") && load.started.elapsed() < Duration::from_secs(45) || load.state == "ready")).unwrap_or(true);
        if retryable { start_auth_check(app.clone()); }
    }
    // Status reads never hold GATE or wait for page/cookie/network work.
    auth_snapshot(&app)
}

#[tauri::command]
pub async fn muse_login_open(app: AppHandle, webview: Webview, retry: Option<bool>) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.try_lock().map_err(|_| "Muse 正在处理另一项操作，请稍后重试")?;
    if active_task(&app, None)?.is_some() { return Err("请先核对并释放当前 Muse 任务后重新登录".into()); }
    if retry.unwrap_or(false) || app.get_webview_window(LOGIN_LABEL).is_some() && current_auth_window(&app, LOGIN_LABEL).is_none() {
        advance_auth_epoch(SessionState::Unverified, None);
        if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
            let _ = window.clear_all_browsing_data();
            window.destroy().map_err(|_| "Muse 旧登录窗口关闭失败，请关闭后重试")?;
            for _ in 0..40 {
                if app.get_webview_window(LOGIN_LABEL).is_none() { break; }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if app.get_webview_window(LOGIN_LABEL).is_some() { return Err("Muse 旧登录窗口尚未关闭，请稍后重试".into()); }
        }
    }
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) { let _ = window.show(); let _ = window.set_focus(); }
    else {
        advance_auth_epoch(SessionState::Unverified, None);
        create_muse_window(&app, LOGIN_LABEL, true, ORIGIN).await?;
    }
    auth_snapshot(&app)
}

fn close_idle_muse_windows(app: &AppHandle) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label != LOGIN_LABEL && label != SESSION_LABEL && !label.starts_with("muse-task-") { continue; }
        if let Some(id) = label.strip_prefix("muse-task-").filter(|id| valid_task_id(id)) {
            let mut task = load(app, id)?;
            if task.status == "prepared" { task.status = "failed".into(); task.ready = false; save(app, &task)?; }
        }
        // A fresh exclusive profile is used for every new window. Clearing and closing
        // the old profile cannot revive its cookies after manual import.
        let _ = window.clear_all_browsing_data();
        window.destroy().map_err(|_| "Muse 旧窗口关闭失败，请关闭窗口后重试")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn muse_import_cookies(app: AppHandle, webview: Webview, cookie: String) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let parsed = cookies::parse_manual_cookies(&cookie)?;
    let values: Vec<String> = parsed.into_iter().map(|cookie| cookie.to_string()).collect();
    let _gate = GATE.try_lock().map_err(|_| "Muse 正在处理另一项操作，请稍后重试导入")?;
    if active_task(&app, None)?.is_some() { return Err("请先核对并释放当前 Muse 任务，再导入新的 Cookie".into()); }
    advance_auth_epoch(SessionState::Unverified, None);
    close_idle_muse_windows(&app)?;
    persist_cookie_values(&app, "manual-import", &values)?;
    if let Ok(mut cache) = AUTH_CACHE.lock() { cache.message = Some("Muse Cookie 已安全保存到本机，尚未在线验证；可点击刷新状态验证"); }
    // Local persistence is the result of this action. Do not wait for a WebView or network.
    auth_snapshot(&app)
}

#[tauri::command]
pub async fn muse_logout(app: AppHandle, webview: Webview) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.try_lock().map_err(|_| "Muse 正在处理另一项操作，请稍后重试")?;
    if active_task(&app, None)?.is_some() { return Err("请先核对并释放当前 Muse 任务后退出登录".into()); }
    advance_auth_epoch(SessionState::Missing, None);
    close_idle_muse_windows(&app)?;
    crate::secret_store::delete_internal_secret_sync(&app, SECRET_KEY).map_err(|_| "Muse 凭据删除失败")?;
    TEXT_RESULTS.lock().map_err(|_| "Muse 文本缓存不可用")?.clear();
    auth_snapshot(&app)
}

#[tauri::command]
pub async fn muse_prepare(app: AppHandle, webview: Webview, kind: String) -> Result<TaskIdentity, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if !matches!(kind.as_str(), "image" | "video" | "text") { return Err("Muse 请求类型无效".into()); }
    let _gate = GATE.lock().await;
    if active_task(&app, None)?.is_some() { return Err("Muse 已有未完成任务，请先继续查询或在核对后释放".into()); }
    advance_auth_epoch(SessionState::Unverified, None);
    capture_cookies(&app)?;
    if !session_valid(&app).await? { return Err("请先在 API Key 设置中登录 Muse".into()); }
    let id = new_task_id()?;
    let mut task = Task { task_id: id.clone(), kind, status: "prepared".into(), thread: None, abandoned: false, ready: false, input_hashes: vec![], mime: None, session_hash: session_hash(&app)?, refusal_observations: 0 };
    save(&app, &task)?;
    let creation = create_muse_window(&app, &task_label(&id), false, NEW_THREAD).await;
    if let Err(error) = creation {
        task.status = "failed".into(); let _ = save(&app, &task);
        if let Some(window) = app.get_webview_window(&task_label(&id)) { let _ = window.destroy(); }
        return Err(error);
    }
    Ok(TaskIdentity { task_id: id })
}

fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("image/png") }
    else if bytes.starts_with(b"\xff\xd8\xff") { Some("image/jpeg") }
    else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { Some("image/gif") }
    else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { Some("image/webp") }
    else if bytes.get(4..8) == Some(b"ftyp") { Some("video/mp4") }
    else if bytes.starts_with(b"\x1a\x45\xdf\xa3") { Some("video/webm") }
    else { None }
}

#[tauri::command]
pub async fn muse_submit(app: AppHandle, webview: Webview, task_id: String, prompt: String, images: Vec<String>) -> Result<TaskIdentity, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let mut task = load(&app, &task_id)?;
    if task.status != "prepared" || task.ready || task.abandoned { return Err("Muse 原任务不能再次准备或发送".into()); }
    if prompt.trim().is_empty() || prompt.len() > 100_000 || images.len() > 4 { return Err("Muse 提示词或参考图数量无效".into()); }
    let mut total = 0usize;
    for image in &images {
        let Some((prefix, data)) = image.split_once(',') else { return Err("Muse 参考图必须是图片数据".into()); };
        if !matches!(prefix, "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64" | "data:image/gif;base64") || data.len() > 12 * 1024 * 1024 { return Err("Muse 参考图格式或体积无效".into()); }
        let bytes = STANDARD.decode(data).map_err(|_| "Muse 参考图数据无效")?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 || !sniff(&bytes).is_some_and(|mime| prefix == format!("data:{mime};base64")) { return Err("Muse 参考图格式或体积无效".into()); }
        total += bytes.len();
        if total > 24 * 1024 * 1024 { return Err("Muse 参考图合计不能超过 24 MiB".into()); }
        task.input_hashes.push(format!("{:x}", Sha256::digest(&bytes)));
    }
    let window = app.get_webview_window(&task_label(&task_id)).ok_or("Muse 准备窗口已关闭，尚未发送")?;
    if !wait_for_adapter(&window).await? { return Err("Muse 登录尚未完成，尚未发送生成请求".into()); }
    let expression = format!("window.__aiCanvasMuseAdapter.prepare({},{},{})", json!(prompt), json!(images), json!(task.kind));
    evaluate(&window, &expression).await?;
    // A concurrent cancellation must win even when upload completed afterwards.
    if load(&app, &task_id)?.status != "prepared" { return Err("Muse 任务已取消，尚未发送".into()); }
    task.ready = true;
    save(&app, &task)?;
    Ok(TaskIdentity { task_id })
}

#[tauri::command]
pub async fn muse_send(app: AppHandle, webview: Webview, task_id: String) -> Result<TaskIdentity, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let mut task = load(&app, &task_id)?;
    if task.status != "prepared" || !task.ready || task.abandoned { return Err("Muse 原任务不能再次发送".into()); }
    if task.session_hash != session_hash(&app)? { return Err("Muse 登录会话已变化，尚未发送原任务".into()); }
    if active_task(&app, Some(&task_id))?.is_some() { return Err("Muse 账号正有其他任务运行".into()); }
    let window = app.get_webview_window(&task_label(&task_id)).ok_or("Muse 准备窗口已关闭，尚未发送")?;
    task.status = "running".into(); task.ready = false;
    save(&app, &task)?;
    // Durable running identity precedes the only click. Timeout is uncertain, never a retry.
    let result = evaluate(&window, "window.__aiCanvasMuseAdapter.send()").await?;
    let thread = confirmed_send_thread(&result).ok_or(DELIVERY_UNCONFIRMED)?;
    task.thread = Some(thread.into());
    save(&app, &task)?;
    Ok(TaskIdentity { task_id })
}

#[tauri::command]
pub async fn muse_cancel_prepared(app: AppHandle, webview: Webview, task_id: String) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let mut task = load(&app, &task_id)?;
    if task.status == "prepared" {
        task.status = "failed".into(); task.ready = false;
        save(&app, &task)?;
        if let Some(window) = app.get_webview_window(&task_label(&task_id)) { let _ = window.destroy(); }
    }
    Ok(())
}

#[tauri::command]
pub async fn muse_release(app: AppHandle, webview: Webview, task_id: String) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let mut task = load(&app, &task_id)?;
    if let Some(window) = app.get_webview_window(&task_label(&task_id)) {
        if let Ok(snapshot) = evaluate(&window, "window.__aiCanvasMuseAdapter ? window.__aiCanvasMuseAdapter.snapshot() : ({})").await {
            if let Some(thread) = snapshot.get("thread").and_then(Value::as_str).filter(|thread| valid_thread(thread)) {
                if task.thread.is_none() { task.thread = Some(thread.into()); }
            }
        }
        // Release stops only local observation. It never clicks Stop or submits a replacement.
        let _ = window.destroy();
    }
    task.abandoned = true;
    save(&app, &task)?;
    TEXT_RESULTS.lock().map_err(|_| "Muse 文本缓存不可用")?.remove(&task_id);
    auth_snapshot(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_identity_is_uuid_v4() {
        let id = new_task_id().unwrap();
        assert!(valid_task_id(&id));
        assert!(!valid_task_id("../../private"));
        assert!(!valid_task_id("00000000-0000-0000-8000-000000000000"));
    }

    #[test]
    fn page_and_thread_boundaries_reject_external_and_traversal_inputs() {
        assert!(muse_url(&Url::parse("https://muse.ai/thread/new").unwrap()));
        for address in ["https://muse.ai.evil.invalid/", "https://user@muse.ai/", "http://muse.ai/", "https://muse.ai:444/"] {
            assert!(!muse_url(&Url::parse(address).unwrap()));
        }
        assert!(valid_thread("/thread/abc_123-456"));
        for thread in ["/thread/new", "/thread/", "/thread/../secrets", "/thread/a?token=secret", "https://muse.ai/thread/a"] {
            assert!(!valid_thread(thread));
        }
    }

    #[test]
    fn send_receipt_requires_delivery_and_a_real_thread() {
        assert_eq!(confirmed_send_thread(&json!({ "sent": true, "thread": "/thread/confirmed_123" })), Some("/thread/confirmed_123"));
        for result in [json!({ "sent": true }), json!({ "sent": false, "thread": "/thread/confirmed_123" }),
            json!({ "sent": true, "thread": "/thread/new" }), json!({ "sent": true, "thread": "https://muse.ai/thread/confirmed_123" })] {
            assert!(confirmed_send_thread(&result).is_none());
        }
    }

    #[test]
    fn interactive_login_allows_https_redirects_without_expanding_muse_origin() {
        for host in ["auth.muse.ai", "accounts.google.com", "appleid.apple.com", "www.facebook.com", "facebook.com", "www.instagram.com", "example.org"] {
            for address in [format!("https://{host}/"), format!("https://{host}:443/login?next=muse")] {
                let url = Url::parse(&address).unwrap();
                assert!(login_url(&url));
                assert!(!muse_url(&url));
            }
            for address in [format!("http://{host}/"), format!("https://{host}:444/"),
                format!("https://user@{host}/"), format!("https://user:secret@{host}/"), format!("https://:secret@{host}/")] {
                assert!(!login_url(&Url::parse(&address).unwrap()));
            }
        }
        assert!(!login_url(&Url::parse("https://muse.ai/").unwrap()));
        for address in ["file:///C:/secret.txt", "asset://localhost/private", "tauri://localhost/", "ipc://localhost/",
            "aicanvas-muse://report/private", "javascript:alert(1)", "data:text/html,private", "about:blank"] {
            assert!(!login_url(&Url::parse(address).unwrap()));
        }
    }

    #[test]
    fn media_headers_are_detected_without_accepting_html_or_svg() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nmore"), Some("image/png"));
        assert_eq!(sniff(b"\0\0\0\x18ftypmp42"), Some("video/mp4"));
        assert_eq!(sniff(b"<html>unauthorized</html>"), None);
        assert_eq!(sniff(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None);
    }

    #[test]
    fn text_cache_rejects_answers_over_the_utf8_byte_limit() {
        assert!(retain_text("oversize-ascii", &"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(retain_text("oversize-chinese", &"文".repeat(MAX_TEXT_BYTES / 3 + 1)).is_err());
    }
}

async fn collect(app: &AppHandle, window: &WebviewWindow, task: &mut Task, src: &str) -> Result<String, String> {
    let metadata = evaluate(window, &format!("window.__aiCanvasMuseAdapter.extract({},{})", json!(src), json!(task.kind))).await?;
    let size = metadata.get("size").and_then(Value::as_u64).ok_or("Muse 结果体积无效")? as usize;
    if size < 12 || size > if task.kind == "video" { 128 * 1024 * 1024 } else { 32 * 1024 * 1024 } { return Err("Muse 结果体积超出限制".into()); }
    let mut bytes = Vec::with_capacity(size);
    for offset in (0..size).step_by(32768) {
        let value = evaluate(window, &format!("window.__aiCanvasMuseAdapter.chunk({offset},32768)")).await?;
        let chunk = value.get("chunk").and_then(Value::as_str).ok_or("Muse 结果数据无效")?;
        let chunk = STANDARD.decode(chunk).map_err(|_| "Muse 结果数据无效")?;
        if chunk.len() != (size - offset).min(32768) { return Err("Muse 结果数据不完整".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let mime = sniff(&bytes).filter(|mime| mime.starts_with(&format!("{}/", task.kind))).ok_or("Muse 返回的媒体文件头不匹配")?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if task.input_hashes.contains(&digest) { return Err("Muse 返回了上传参考图，原任务已保留".into()); }
    let file = task_file(app, &task.task_id)?.with_extension("media");
    let mut artifact = std::fs::File::create(file).map_err(|_| "Muse 结果私有保存失败")?;
    artifact.write_all(&bytes).map_err(|_| "Muse 结果私有保存失败")?;
    artifact.sync_all().map_err(|_| "Muse 结果私有保存失败")?;
    drop(artifact);
    persist_window_cookies(app, window)?;
    task.session_hash = session_hash(app)?;
    // A dormant login page must not overwrite a newer session issued to the task page.
    if let Some(login) = app.get_webview_window(LOGIN_LABEL) { let _ = login.destroy(); }
    if let Some(session) = app.get_webview_window(SESSION_LABEL) { let _ = session.destroy(); }
    task.mime = Some(mime.into()); task.status = "completed".into();
    save(app, task)?;
    let _ = window.destroy();
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

async fn collect_text(window: &WebviewWindow, snapshot: &Value) -> Result<String, String> {
    let size = snapshot.get("textSize").and_then(Value::as_u64).filter(|size| *size <= MAX_TEXT_BYTES as u64).ok_or("Muse 文本长度无效")? as usize;
    let revision = snapshot.get("textRevision").and_then(Value::as_u64).filter(|revision| *revision <= u32::MAX as u64).ok_or("Muse 文本快照无效")?;
    let mut bytes = Vec::with_capacity(size);
    for offset in (0..size).step_by(32768) {
        let value = evaluate(window, &format!("window.__aiCanvasMuseAdapter.textChunk({revision},{offset},32768)")).await?;
        let chunk = value.get("chunk").and_then(Value::as_str).filter(|chunk| chunk.len() <= 44_000).ok_or("Muse 文本分块无效")?;
        let chunk = STANDARD.decode(chunk).map_err(|_| "Muse 文本分块无效")?;
        if chunk.len() != (size - offset).min(32768) { return Err("Muse 文本快照不完整".into()); }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Muse 文本不是有效 UTF-8".into())
}

fn retain_text(task_id: &str, text: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES { return Err("Muse 文本超出采集上限".into()); }
    let mut results = TEXT_RESULTS.lock().map_err(|_| "Muse 文本缓存不可用")?;
    // Bounded process-only delivery cache; evicted answers can be read from their original thread.
    if results.len() >= 16 && !results.contains_key(task_id) {
        if let Some(oldest) = results.keys().next().cloned() { results.remove(&oldest); }
    }
    results.insert(task_id.into(), text.into());
    Ok(())
}

#[tauri::command]
pub async fn muse_query(app: AppHandle, webview: Webview, task_id: String) -> Result<TaskStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let mut task = load(&app, &task_id)?;
    if task.status == "completed" && task.kind == "text" {
        if let Some(text) = TEXT_RESULTS.lock().map_err(|_| "Muse 文本缓存不可用")?.get(&task_id).cloned() {
            return Ok(TaskStatus { status: "completed".into(), url: None, text: Some(text), error: None });
        }
    }
    if task.status == "completed" && task.kind != "text" {
        let file = task_file(&app, &task_id)?.with_extension("media");
        let size = std::fs::metadata(&file).map_err(|_| "Muse 已完成结果读取失败")?.len();
        if size > if task.kind == "video" { 128 * 1024 * 1024 } else { 32 * 1024 * 1024 } { return Err("Muse 结果文件过大".into()); }
        let bytes = std::fs::read(file).map_err(|_| "Muse 已完成结果读取失败")?;
        let mime = sniff(&bytes).filter(|mime| mime.starts_with(&format!("{}/", task.kind))).ok_or("Muse 结果文件无效")?;
        return Ok(TaskStatus { status: task.status, url: Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))), text: None, error: None });
    }
    if task.status == "failed" {
        let error = if task.thread.is_none() { "Muse 原任务在网页发送前已结束，尚未发送生成请求" }
            else { "Muse 旧任务已被本机标记为失败，请核对原网页；该记录未保存官网失败原因" };
        return Ok(TaskStatus { status: task.status, url: None, text: None, error: Some(error.into()) });
    }
    if task.status == "prepared" { return Ok(TaskStatus { status: task.status, url: None, text: None, error: None }); }
    if task.session_hash != session_hash(&app)? { return Err("Muse 原登录会话已变化，请到官网核对并手动取回原结果；不会更换会话查询".into()); }
    let label = task_label(&task_id);
    let window = match physically_ready_window(&app, &label)? {
        Some(window) => window,
        None => {
            let Some(thread) = task.thread.as_ref().filter(|thread| valid_thread(thread)) else {
                task.status = "unknown".into(); save(&app, &task)?;
                return Ok(TaskStatus { status: task.status, url: None, text: None, error: Some(DELIVERY_UNCONFIRMED.into()) });
            };
            create_muse_window(&app, &label, false, &format!("{ORIGIN}{thread}")).await?;
            return Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None });
        }
    };
    if !window.url().is_ok_and(|url| muse_url(&url)) {
        if task.thread.is_none() { return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some(DELIVERY_UNCONFIRMED.into()) }); }
        return Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None });
    }
    let expression = if task.kind == "text" { format!("window.__aiCanvasMuseAdapter ? window.__aiCanvasMuseAdapter.textSnapshot({}) : ({{loading:true}})", json!(&task.thread)) }
        else { "window.__aiCanvasMuseAdapter ? window.__aiCanvasMuseAdapter.snapshot() : ({loading:true})".into() };
    let snapshot = match evaluate(&window, &expression).await {
        Ok(snapshot) => snapshot,
        Err(_) => return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some("Muse 原会话暂不可读，原任务已保留".into()) }),
    };
    if snapshot.get("loading") == Some(&Value::Bool(true)) { return Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None }); }
    if snapshot.get("textConflict") == Some(&Value::Bool(true)) {
        return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some(TASK_CONFLICT.into()) });
    }
    if task.kind == "text" && snapshot.get("textUnavailable") == Some(&Value::Bool(true)) {
        return Ok(TaskStatus { status: "unknown".into(), url: None, text: None,
            error: Some("Muse 原回复暂未显示在页面中，已保留当前文本；请查看原任务后继续查询".into()) });
    }
    let thread = snapshot.get("thread").and_then(Value::as_str).filter(|thread| valid_thread(thread));
    if snapshot.get("deliveryPending") == Some(&Value::Bool(true)) || thread.is_none()
        || task.thread.is_none() && snapshot.get("deliveryConfirmed") != Some(&Value::Bool(true)) {
        return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some(DELIVERY_UNCONFIRMED.into()) });
    }
    if let Some(thread) = thread {
        if task.thread.as_ref().is_some_and(|expected| expected != thread) {
            return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some("Muse 页面已切到其他会话，未接收其结果".into()) });
        }
        if task.thread.is_none() { task.thread = Some(thread.into()); save(&app, &task)?; }
    }
    if task.kind == "text" {
        if snapshot.get("textOverflow") == Some(&Value::Bool(true)) {
            return Ok(TaskStatus { status: "unknown".into(), url: None, text: None,
                error: Some(TASK_CONFLICT.into()) });
        }
        let text = collect_text(&window, &snapshot).await?;
        let completed = task.thread.is_some() && snapshot.get("textComplete") == Some(&Value::Bool(true))
            && snapshot.get("stop") == Some(&Value::Bool(false)) && !text.trim().is_empty();
        if completed {
            persist_window_cookies(&app, &window)?;
            task.session_hash = session_hash(&app)?;
            for label in [LOGIN_LABEL, SESSION_LABEL] {
                if let Some(stale) = app.get_webview_window(label) { let _ = stale.destroy(); }
            }
            task.status = "completed".into();
            retain_text(&task_id, &text)?;
            save(&app, &task)?;
            let _ = window.destroy();
        }
        return Ok(TaskStatus { status: if completed { "completed" } else { "running" }.into(), url: None, text: Some(text), error: None });
    }
    let src = snapshot.get("src").and_then(Value::as_str).unwrap_or("");
    let kind = snapshot.get("kind").and_then(Value::as_str).unwrap_or("");
    if !src.is_empty() && src.len() < 16_384 && kind == task.kind && task.thread.is_some() {
        let url = collect(&app, &window, &mut task, src).await?;
        return Ok(TaskStatus { status: "completed".into(), url: Some(url), text: None, error: None });
    }
    if snapshot.get("refused") == Some(&Value::Bool(true)) && task.thread.is_some() {
        task.refusal_observations = task.refusal_observations.saturating_add(1);
        save(&app, &task)?;
    } else if task.refusal_observations > 0 { task.refusal_observations = 0; save(&app, &task)?; }
    if task.refusal_observations >= 3 {
        return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some("Muse 网页返回了拒绝生成说明，尚未取得媒体；请查看原任务，可继续查询".into()) });
    }
    Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None })
}

#[tauri::command]
pub async fn muse_task_open(app: AppHandle, webview: Webview, task_id: String) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let task = load(&app, &task_id)?;
    let label = task_label(&task_id);
    let window = if let Some(window) = physically_ready_window(&app, &label)? { window } else {
        if task.session_hash != session_hash(&app)? { return Err("Muse 原登录会话已变化，请到官网核对并手动取回原结果".into()); }
        let thread = task.thread.as_ref().filter(|thread| valid_thread(thread)).ok_or("未取得 Muse 原会话地址，请在 Muse 官网核对任务")?;
        create_muse_window(&app, &label, false, &format!("{ORIGIN}{thread}")).await?
    };
    window.show().map_err(|_| "Muse 原任务窗口不可用")?;
    window.set_focus().map_err(|_| "Muse 原任务窗口不可用".into())
}
