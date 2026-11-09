//! Fixed Muse WebView adapter. Remote pages receive no application capability or IPC.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::{collections::BTreeMap, path::PathBuf, sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{webview::{Cookie, NewWindowResponse}, AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use url::Url;

const ORIGIN: &str = "https://muse.ai";
const NEW_THREAD: &str = "https://muse.ai/thread/new";
const LOGIN_LABEL: &str = "muse-login";
const SESSION_LABEL: &str = "muse-session";
const SECRET_KEY: &str = "muse/session";
const PAGE_ADAPTER: &str = include_str!("muse/page.js");
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PENDING: LazyLock<Mutex<BTreeMap<String, Pending>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
// Text is intentionally process-local; task metadata never stores prompt or answer.
static TEXT_RESULTS: LazyLock<Mutex<BTreeMap<String, String>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
const MAX_TEXT_BYTES: usize = 256 * 1024;

struct Pending { label: String, sender: oneshot::Sender<Value> }

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

fn valid_id(id: &str) -> bool { id.len() == 48 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) }
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
fn valid_thread(thread: &str) -> bool {
    thread.starts_with("/thread/") && thread != "/thread/new" && thread.len() > 8 && thread.len() <= 256
        && thread[8..].bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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

fn callback(label: &str, url: &Url) {
    if url.host_str() != Some("report") || url.as_str().len() > 100_000 { return; }
    let id = url.path().trim_start_matches('/');
    if !valid_id(id) { return; }
    let Some(payload) = url.query_pairs().find(|(key, _)| key == "payload").map(|(_, value)| value.into_owned()) else { return; };
    let Ok(value) = serde_json::from_str::<Value>(&payload) else { return; };
    if let Ok(mut pending) = PENDING.lock() {
        if pending.get(id).is_some_and(|request| request.label == label) {
            if let Some(request) = pending.remove(id) { let _ = request.sender.send(value); }
        }
    }
}

async fn evaluate(window: &WebviewWindow, expression: &str) -> Result<Value, String> {
    if !window.url().is_ok_and(|url| muse_url(&url)) { return Err("Muse 网页尚未就绪".into()); }
    let id = random_id()?;
    let (sender, receiver) = oneshot::channel();
    PENDING.lock().map_err(|_| "Muse 页面通道不可用")?.insert(id.clone(), Pending { label: window.label().to_string(), sender });
    let script = format!(r#"(async()=>{{if(location.origin!=="https://muse.ai")return;let value;try{{value={{ok:true,value:await({expression})}}}}catch(_){{value={{ok:false}}}}location.href="aicanvas-muse://report/{id}?payload="+encodeURIComponent(JSON.stringify(value));}})();"#);
    if window.eval(&script).is_err() {
        if let Ok(mut pending) = PENDING.lock() { pending.remove(&id); }
        return Err("Muse 页面执行失败".into());
    }
    let result = tokio::time::timeout(Duration::from_secs(85), receiver).await;
    if let Ok(mut pending) = PENDING.lock() { pending.remove(&id); }
    let result = result.map_err(|_| "Muse 页面响应超时，原任务已保留")?.map_err(|_| "Muse 页面响应中断")?;
    if result.get("ok") != Some(&Value::Bool(true)) { return Err("Muse 页面操作未确认，未自动重新发送".into()); }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}

async fn wait_for_adapter(window: &WebviewWindow) -> Result<(), String> {
    for _ in 0..90 {
        if window.url().is_ok_and(|url| muse_url(&url))
            && evaluate(window, "!!window.__aiCanvasMuseAdapter").await.unwrap_or(Value::Bool(false)) == Value::Bool(true) { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Muse 页面加载超时，尚未发送生成请求".into())
}

fn build_window(app: &AppHandle, label: &str, login: bool) -> Result<WebviewWindow, String> {
    let profile = private_dir(app)?.join(if login { "login-profile".into() } else { format!("profiles/{label}") });
    std::fs::create_dir_all(&profile).map_err(|_| "Muse 浏览器目录不可用")?;
    let navigation_label = label.to_string();
    let muse_origin = Arc::new(AtomicBool::new(false));
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(Url::parse("about:blank").map_err(|_| "Muse 地址无效")?))
        .title(if login { "Muse — 登录" } else { "Muse — 生成任务" })
        .inner_size(1100.0, 800.0).visible(login).devtools(false).data_directory(profile).incognito(true)
        .initialization_script(format!("if(location.origin==='https://muse.ai'){{{PAGE_ADAPTER}}}"))
        .on_navigation(move |url| {
            if url.scheme() == "aicanvas-muse" {
                if muse_origin.load(Ordering::SeqCst) { callback(&navigation_label, url); }
                return false;
            }
            if url.as_str() == "about:blank" { muse_origin.store(false, Ordering::SeqCst); return true; }
            if muse_url(url) { muse_origin.store(true, Ordering::SeqCst); return true; }
            // Login providers may navigate within this isolated profile, never to local/app protocols.
            let allowed = login && url.scheme() == "https" && url.port_or_known_default() == Some(443)
                && matches!(url.host_str(), Some("accounts.google.com" | "appleid.apple.com"));
            if allowed { muse_origin.store(false, Ordering::SeqCst); }
            allowed
        })
        .on_new_window(|_, _| NewWindowResponse::Deny).on_download(|_, _| false)
        .build().map_err(|_| "无法创建 Muse 独立窗口".into())
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
    let serialized = serde_json::to_string(&values).map_err(|_| "Muse 凭据保存失败")?;
    let previous = crate::secret_store::read_internal_secret_sync(app, SECRET_KEY).map_err(|_| "Muse 凭据读取失败")?;
    crate::secret_store::set_internal_secret_sync(app, SECRET_KEY, &serialized).map_err(|_| "Muse 凭据保存失败")?;
    if previous.as_deref() != Some(serialized.as_str()) {
        for label in [LOGIN_LABEL, SESSION_LABEL] {
            if label != window.label() { if let Some(stale) = app.get_webview_window(label) { let _ = stale.destroy(); } }
        }
    }
    Ok(())
}
fn capture_cookies(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LOGIN_LABEL) else { return Ok(()); };
    persist_window_cookies(app, &window)
}

async fn session_valid(app: &AppHandle) -> Result<bool, String> {
    if read_cookies(app)?.is_empty() { return Ok(false); }
    let active_id = active_task(app, None)?;
    let active = active_id.as_ref().and_then(|id| app.get_webview_window(&task_label(id)));
    let window = if let Some(window) = active.or_else(|| app.get_webview_window(LOGIN_LABEL)).or_else(|| app.get_webview_window(SESSION_LABEL)) { window }
    else {
        let window = build_window(app, SESSION_LABEL, false)?;
        let ready = restore_cookies(app, &window).and_then(|_| window.navigate(Url::parse(NEW_THREAD).map_err(|_| "Muse 地址无效")?).map_err(|_| "Muse 会话检查页面不可用".to_string()));
        if let Err(error) = ready { let _ = window.destroy(); return Err(error); }
        window
    };
    if window.label() == LOGIN_LABEL && !window.url().is_ok_and(|url| muse_url(&url)) { return Ok(false); }
    wait_for_adapter(&window).await?;
    // Fetch in the actual browser profile: its UA, HttpOnly cookies and Set-Cookie
    // expiry handling remain authoritative, and no cookie crosses the page bridge.
    let result = evaluate(&window, r#"(async()=>{
      const response = await fetch('/api/session', { credentials:'include', redirect:'error', signal:AbortSignal.timeout(12000) });
      if(response.status===401)return {authenticated:false};
      if(response.status!==200)throw new Error('session-unconfirmed');
      const reader=response.body.getReader();let total=0;const chunks=[];
      while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;
        if(total>1048576){await reader.cancel();throw new Error('session-size');}chunks.push(part.value);}
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const session=JSON.parse(new TextDecoder().decode(bytes));return {authenticated:session.status==='assigned'};
    })()"#).await?;
    persist_window_cookies(app, &window)?;
    if let Some(id) = active_id {
        // Only the exact task profile may advance the fingerprint on cookie renewal.
        if window.label() == task_label(&id) {
            let mut task = load(app, &id)?;
            task.session_hash = session_hash(app)?;
            save(app, &task)?;
        }
    }
    result.get("authenticated").and_then(Value::as_bool).ok_or_else(|| "Muse 会话状态未确认，已保留凭据".into())
}

#[tauri::command]
pub async fn muse_auth_status(app: AppHandle, webview: Webview) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let active_task_id = active_task(&app, None)?;
    if active_task_id.is_none() { capture_cookies(&app)?; }
    let (logged_in, message) = match session_valid(&app).await { Ok(valid) => (valid, None), Err(_) => (false, Some("暂无法确认 Muse 会话，凭据与原任务已保留；请检查网络或登录页".into())) };
    Ok(AuthStatus { logged_in, login_open: app.get_webview_window(LOGIN_LABEL).is_some(), active_task_id, message })
}

#[tauri::command]
pub async fn muse_login_open(app: AppHandle, webview: Webview) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    if active_task(&app, None)?.is_some() { return Err("请先核对并释放当前 Muse 任务后重新登录".into()); }
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) { let _ = window.show(); let _ = window.set_focus(); }
    else {
        let window = build_window(&app, LOGIN_LABEL, true)?;
        let ready = restore_cookies(&app, &window).and_then(|_| window.navigate(Url::parse(NEW_THREAD).map_err(|_| "Muse 地址无效")?).map_err(|_| "Muse 登录页不可用".to_string()));
        if let Err(error) = ready { let _ = window.destroy(); return Err(error); }
    }
    Ok(AuthStatus { logged_in: false, login_open: true, active_task_id: active_task(&app, None)?, message: None })
}

#[tauri::command]
pub async fn muse_logout(app: AppHandle, webview: Webview) -> Result<AuthStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    if active_task(&app, None)?.is_some() { return Err("请先核对并释放当前 Muse 任务后退出登录".into()); }
    for (label, window) in app.webview_windows() {
        if label != LOGIN_LABEL && label != SESSION_LABEL && !label.starts_with("muse-task-") { continue; }
        for cookie in window.cookies_for_url(Url::parse(ORIGIN).map_err(|_| "Muse 地址无效")?).map_err(|_| "Muse 退出失败")? {
            window.delete_cookie(cookie).map_err(|_| "Muse 退出失败")?;
        }
        let _ = window.destroy();
    }
    crate::secret_store::delete_internal_secret_sync(&app, SECRET_KEY).map_err(|_| "Muse 凭据删除失败")?;
    TEXT_RESULTS.lock().map_err(|_| "Muse 文本缓存不可用")?.clear();
    Ok(AuthStatus { logged_in: false, login_open: false, active_task_id: None, message: None })
}

#[tauri::command]
pub async fn muse_prepare(app: AppHandle, webview: Webview, kind: String) -> Result<TaskIdentity, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if !matches!(kind.as_str(), "image" | "video" | "text") { return Err("Muse 请求类型无效".into()); }
    let _gate = GATE.lock().await;
    if active_task(&app, None)?.is_some() { return Err("Muse 已有未完成任务，请先继续查询或在核对后释放".into()); }
    capture_cookies(&app)?;
    if !session_valid(&app).await? { return Err("请先在 API Key 设置中登录 Muse".into()); }
    let id = new_task_id()?;
    let mut task = Task { task_id: id.clone(), kind, status: "prepared".into(), thread: None, abandoned: false, ready: false, input_hashes: vec![], mime: None, session_hash: session_hash(&app)?, refusal_observations: 0 };
    save(&app, &task)?;
    let creation = (|| {
        let window = build_window(&app, &task_label(&id), false)?;
        restore_cookies(&app, &window)?;
        window.navigate(Url::parse(NEW_THREAD).map_err(|_| "Muse 地址无效")?).map_err(|_| "Muse 生成页面不可用".to_string())
    })();
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
    wait_for_adapter(&window).await?;
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
    evaluate(&window, "window.__aiCanvasMuseAdapter.send()").await?;
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
    let (logged_in, message) = match session_valid(&app).await { Ok(valid) => (valid, None), Err(_) => (false, Some("任务占用已释放，暂无法确认 Muse 登录状态".into())) };
    Ok(AuthStatus { logged_in, login_open: app.get_webview_window(LOGIN_LABEL).is_some(), active_task_id: active_task(&app, None)?, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_identity_is_uuid_v4_and_not_a_callback_nonce() {
        let id = new_task_id().unwrap();
        assert!(valid_task_id(&id));
        assert!(!valid_id(&id));
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
    if matches!(task.status.as_str(), "prepared" | "failed") { return Ok(TaskStatus { status: task.status, url: None, text: None, error: None }); }
    if task.session_hash != session_hash(&app)? { return Err("Muse 原登录会话已变化，请到官网核对并手动取回原结果；不会更换会话查询".into()); }
    let label = task_label(&task_id);
    let window = match app.get_webview_window(&label) {
        Some(window) => window,
        None => {
            let Some(thread) = task.thread.as_ref().filter(|thread| valid_thread(thread)) else {
                task.status = "unknown".into(); save(&app, &task)?;
                return Ok(TaskStatus { status: task.status, url: None, text: None, error: Some("未取得 Muse 会话地址，请在官网核对原任务后决定是否释放".into()) });
            };
            let window = build_window(&app, &label, false)?;
            restore_cookies(&app, &window)?;
            window.navigate(Url::parse(&format!("{ORIGIN}{thread}")).map_err(|_| "Muse 会话地址无效")?).map_err(|_| "Muse 原会话读取失败")?;
            return Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None });
        }
    };
    if !window.url().is_ok_and(|url| muse_url(&url)) {
        return Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None });
    }
    let expression = if task.kind == "text" { "window.__aiCanvasMuseAdapter ? window.__aiCanvasMuseAdapter.textSnapshot() : ({loading:true})" }
        else { "window.__aiCanvasMuseAdapter ? window.__aiCanvasMuseAdapter.snapshot() : ({loading:true})" };
    let snapshot = match evaluate(&window, expression).await {
        Ok(snapshot) => snapshot,
        Err(_) => return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some("Muse 原会话暂不可读，原任务已保留".into()) }),
    };
    if snapshot.get("loading") == Some(&Value::Bool(true)) { return Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None }); }
    if let Some(thread) = snapshot.get("thread").and_then(Value::as_str).filter(|thread| valid_thread(thread)) {
        if task.thread.as_ref().is_some_and(|expected| expected != thread) {
            return Ok(TaskStatus { status: "unknown".into(), url: None, text: None, error: Some("Muse 页面已切到其他会话，未接收其结果".into()) });
        }
        if task.thread.is_none() { task.thread = Some(thread.into()); save(&app, &task)?; }
    }
    if task.kind == "text" {
        if snapshot.get("textConflict") == Some(&Value::Bool(true)) || snapshot.get("textOverflow") == Some(&Value::Bool(true)) {
            return Ok(TaskStatus { status: "unknown".into(), url: None, text: None,
                error: Some("Muse 会话出现额外轮次或文本超过 256 KiB，请在官网查看原回复；不会重新发送".into()) });
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
        task.status = "failed".into(); save(&app, &task)?;
        return Ok(TaskStatus { status: "failed".into(), url: None, text: None, error: Some("Muse 未生成媒体或账号额度不足，请在官网查看原会话".into()) });
    }
    Ok(TaskStatus { status: "running".into(), url: None, text: None, error: None })
}

#[tauri::command]
pub async fn muse_task_open(app: AppHandle, webview: Webview, task_id: String) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let _gate = GATE.lock().await;
    let task = load(&app, &task_id)?;
    let label = task_label(&task_id);
    let window = if let Some(window) = app.get_webview_window(&label) { window } else {
        if task.session_hash != session_hash(&app)? { return Err("Muse 原登录会话已变化，请到官网核对并手动取回原结果".into()); }
        let thread = task.thread.as_ref().filter(|thread| valid_thread(thread)).ok_or("未取得 Muse 原会话地址，请在 Muse 官网核对任务")?;
        let window = build_window(&app, &label, false)?;
        restore_cookies(&app, &window)?;
        window.navigate(Url::parse(&format!("{ORIGIN}{thread}")).map_err(|_| "Muse 会话地址无效")?).map_err(|_| "Muse 原会话读取失败")?;
        window
    };
    window.show().map_err(|_| "Muse 原任务窗口不可用")?;
    window.set_focus().map_err(|_| "Muse 原任务窗口不可用".into())
}
