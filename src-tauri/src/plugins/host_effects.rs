//! 插件的受控联网和私有偏好。调用方只提交身份与 JSON，不接收路径或执行源码。
use crate::{
    path_policy::ensure_trusted_caller,
    plugin_registry::{self, PluginHostGrant},
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use tokio_util::sync::CancellationToken;
use url::Url;

#[path = "ui_slice.rs"]
mod ui_slice;
#[path = "ui_slice_pixels.rs"]
mod ui_slice_pixels;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_SETTINGS_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
static UI_SLICE_PICKER_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginHostIdentity {
    pub plugin_id: String,
    pub source_digest: String,
    pub revision_digest: String,
    pub tool_id: String,
    pub invocation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UiSlicePicker {
    OpenDraft,
    SaveDraft,
    Export,
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub(crate) enum HostEffect {
    #[serde(rename = "network.request")]
    Network {
        url: String,
        #[serde(default = "get_method")]
        method: String,
        #[serde(default)]
        headers: HashMap<String, String>,
        body: Option<String>,
    },
    #[serde(rename = "settings.get")]
    Get { key: String },
    #[serde(rename = "settings.set")]
    Set { key: String, value: Value },
    #[serde(rename = "settings.delete")]
    Delete { key: String },
    #[serde(rename = "image.uiSlice.inspect", rename_all = "camelCase")]
    UiSliceInspect { source_path: String, assume_srgb: bool },
    #[serde(rename = "image.uiSlice.pick", rename_all = "camelCase")]
    UiSlicePick { purpose: UiSlicePicker, native_window: bool },
    #[serde(rename = "image.uiSlice.openDraft", rename_all = "camelCase")]
    UiSliceOpenDraft { source_path: String, archive_path: String, assume_srgb: bool },
    #[serde(rename = "image.uiSlice.publish", rename_all = "camelCase")]
    UiSlicePublish {
        source_path: String,
        directory: Option<String>,
        source_sha256: String,
        assume_srgb: bool,
        items: Vec<ui_slice_pixels::Item>,
        #[serde(default)]
        missing: Vec<ui_slice::Missing>,
        #[serde(default)]
        include_source: bool,
        #[serde(default)]
        new_draft: bool,
        overwrite_draft: Option<ui_slice::DraftFile>,
    },
}

fn get_method() -> String {
    "GET".to_string()
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

struct PendingRequest {
    token: CancellationToken,
    active: bool,
    created: Instant,
}
type RequestMap = HashMap<(String, String), PendingRequest>;
static REQUESTS: OnceLock<Mutex<RequestMap>> = OnceLock::new();
fn requests() -> &'static Mutex<RequestMap> {
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RequestLease {
    key: (String, String),
    token: CancellationToken,
}
impl RequestLease {
    fn register(plugin_id: &str, request_id: &str) -> Result<Self, String> {
        if !valid_id(plugin_id) || !valid_id(request_id) {
            return Err("插件请求身份无效".into());
        }
        let key = (plugin_id.to_string(), request_id.to_string());
        let mut map = requests().lock().map_err(|_| "插件请求锁异常")?;
        map.retain(|_, entry| entry.active || entry.created.elapsed() < Duration::from_secs(60));
        if let Some(entry) = map.get(&key) {
            if entry.active {
                return Err("插件请求 ID 正在使用".into());
            }
            map.remove(&key);
            return Err("插件操作已取消".into());
        }
        if map.len() >= 64
            || map.values().filter(|entry| entry.active).count() >= 16
            || map
                .iter()
                .filter(|((id, _), entry)| id == plugin_id && entry.active)
                .count()
                >= 4
        {
            return Err("插件宿主请求并发已达上限".into());
        }
        let token = CancellationToken::new();
        map.insert(
            key.clone(),
            PendingRequest {
                token: token.clone(),
                active: true,
                created: Instant::now(),
            },
        );
        Ok(Self { key, token })
    }
}
impl Drop for RequestLease {
    fn drop(&mut self) {
        if let Ok(mut map) = requests().lock() {
            map.remove(&self.key);
        }
    }
}

pub(crate) fn cancel_plugin_requests(plugin_id: Option<&str>) {
    if let Ok(map) = requests().lock() {
        for ((id, _), entry) in map.iter() {
            if plugin_id.is_none_or(|expected| expected == id) {
                entry.token.cancel();
            }
        }
    }
}

fn cancel_request(plugin_id: &str, request_id: &str) -> Result<(), String> {
    if !valid_id(plugin_id) || !valid_id(request_id) {
        return Err("插件请求身份无效".into());
    }
    let mut map = requests().lock().map_err(|_| "插件请求锁异常")?;
    map.retain(|_, entry| entry.active || entry.created.elapsed() < Duration::from_secs(60));
    let key = (plugin_id.to_string(), request_id.to_string());
    if !map.contains_key(&key) {
        if map.len() >= 64 {
            return Err("插件取消记录已达上限".into());
        }
        // 取消可能比执行命令先到，短期标记让后到的请求也能立即停止。
        map.insert(
            key.clone(),
            PendingRequest {
                token: CancellationToken::new(),
                active: false,
                created: Instant::now(),
            },
        );
    }
    map.get(&key).expect("request inserted").token.cancel();
    Ok(())
}

fn ensure_host_caller(webview: &Webview) -> Result<(), String> {
    ensure_trusted_caller(webview)?;
    if webview.label() != "main" {
        return Err("插件宿主能力只能由主窗口调用".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_plugin_host_effect(
    webview: Webview,
    plugin_id: String,
    request_id: String,
) -> Result<(), String> {
    ensure_host_caller(&webview)?;
    cancel_request(&plugin_id, &request_id)
}

fn require_permission(grant: &PluginHostGrant, permission: &str) -> Result<(), String> {
    if !grant.permissions.iter().any(|value| value == permission) {
        return Err(format!("插件未声明 {permission} 权限"));
    }
    Ok(())
}

pub(crate) fn validate_origin(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|_| "网络授权必须是精确的公共 HTTPS 来源")?;
    let host = url.host_str().unwrap_or("");
    if raw.len() > 512
        || url.scheme() != "https"
        || url.origin().ascii_serialization() != raw
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.host(), Some(url::Host::Domain(_)))
        || !host.contains('.')
        || host.len() > 253
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err("网络授权必须是精确的公共 HTTPS 来源，不能包含路径、端口或 IP".into());
    }
    Ok(())
}

fn validate_request(
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    origins: &[String],
) -> Result<Url, String> {
    if url.len() > 4096 {
        return Err("网络请求 URL 过长".into());
    }
    let parsed = Url::parse(url).map_err(|_| "网络请求 URL 无效")?;
    let origin = parsed.origin().ascii_serialization();
    validate_origin(&origin)?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || !origins.contains(&origin)
    {
        return Err("网络请求来源未获授权".into());
    }
    if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method)
        || (method == "GET" && body.is_some())
    {
        return Err("网络请求方法或正文无效".into());
    }
    if body.is_some_and(|value| value.len() > MAX_REQUEST_BYTES) {
        return Err("网络请求正文超过 64 KiB".into());
    }
    if headers.len() > 16 {
        return Err("网络请求 header 过多".into());
    }
    for (name, value) in headers {
        if !["accept", "content-type", "authorization", "x-api-key"]
            .contains(&name.to_ascii_lowercase().as_str())
            || value.len() > 4096
            || value.contains(['\r', '\n'])
            || reqwest::header::HeaderValue::from_str(value).is_err()
        {
            return Err("网络请求 header 无效或未获支持".into());
        }
    }
    Ok(parsed)
}

fn validate_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty()
        || addresses.len() > 64
        || addresses
            .iter()
            .any(|address| crate::assistant_web::is_disallowed_ip(address.ip()))
    {
        return Err("网络请求目标不是公共地址".into());
    }
    Ok(())
}

async fn request_network(
    url: Url,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<Value, String> {
    let host = url.host_str().ok_or("网络请求缺少域名")?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "网络请求域名解析失败")?
        .take(65)
        .collect();
    validate_addresses(&addresses)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "无法创建插件网络请求")?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "网络请求方法无效")?;
    let mut request = client.request(method, url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|_| "插件网络请求失败")?;
    read_network_response(response).await
}

async fn read_network_response(mut response: reqwest::Response) -> Result<Value, String> {
    if response.status().is_redirection() {
        return Err("插件网络请求不允许重定向，请使用获准的最终地址".into());
    }
    if response
        .content_length()
        .is_some_and(|bytes| bytes > MAX_RESPONSE_BYTES as u64)
    {
        return Err("网络响应超过 256 KiB".into());
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if content_type.len() > 1024 {
        return Err("网络响应 Content-Type 过长".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "无法读取插件网络响应")? {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|size| size > MAX_RESPONSE_BYTES)
        {
            return Err("网络响应超过 256 KiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|_| "网络响应必须是 UTF-8 文本")?;
    if text.encode_utf16().count() > 256_000 {
        return Err("网络响应字符串超过 256000 个字符".into());
    }
    Ok(json!({ "status": status, "contentType": content_type, "body": text }))
}

fn sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "apikey"
            | "password"
            | "secret"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "authorization"
            | "credential"
            | "credentials"
            | "filepath"
            | "absolutepath"
            | "filecontent"
            | "webpagebody"
    )
}
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 64
        || !key.as_bytes()[0].is_ascii_alphabetic()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        || sensitive_key(key)
    {
        return Err("插件设置 key 无效或包含敏感字段".into());
    }
    Ok(())
}
fn validate_setting(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 8 {
        return Err("插件设置嵌套深度不能超过 8 层".into());
    }
    match value {
        Value::String(text)
            if text.starts_with('/')
                || text.starts_with("\\\\")
                || text.starts_with("file:")
                || text.starts_with("asset:")
                || (text.as_bytes().get(1) == Some(&b':')
                    && text
                        .as_bytes()
                        .get(2)
                        .is_some_and(|byte| matches!(byte, b'/' | b'\\'))) =>
        {
            return Err("插件设置不能保存本地绝对路径".into())
        }
        Value::Array(values) => {
            if values.len() > 256 {
                return Err("插件设置数组不能超过 256 项".into());
            }
            for value in values {
                validate_setting(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            if values.len() > 128 {
                return Err("插件设置对象不能超过 128 个键".into());
            }
            for (key, value) in values {
                if sensitive_key(key)
                    || matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                {
                    return Err("插件设置不能保存凭据、路径或正文等敏感字段".into());
                }
                validate_setting(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn plain_path(path: &Path, directory: bool) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("插件设置文件不可用".into()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("插件设置路径不能是重解析点".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !directory && metadata.nlink() != 1 {
            return Err("插件设置文件不能有多个硬链接".into());
        }
    }
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("插件设置路径不安全".into());
    }
    Ok(true)
}
fn settings_path(private_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    if !valid_id(plugin_id) || plugin_id == "." || plugin_id == ".." {
        return Err("插件设置身份无效".into());
    }
    if !plain_path(private_dir, true)? {
        return Err("插件私有目录不存在".into());
    }
    let directory = private_dir.join("settings");
    if !plain_path(&directory, true)? {
        fs::create_dir(&directory).map_err(|_| "无法创建插件设置目录")?;
    }
    Ok(directory.join(format!("{plugin_id}.json")))
}
fn read_settings(path: &Path) -> Result<Map<String, Value>, String> {
    let backup = path.with_extension("json.bak");
    if !plain_path(path, false)? {
        if !plain_path(&backup, false)? {
            return Ok(Map::new());
        }
        fs::rename(&backup, path).map_err(|_| "无法恢复插件设置")?;
    }
    if fs::metadata(path).map_err(|_| "插件设置文件不可用")?.len() > MAX_SETTINGS_BYTES as u64
    {
        return Err("插件设置文件超过大小限制".into());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取插件设置")?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("插件设置文件超过大小限制".into());
    }
    let values: Map<String, Value> =
        serde_json::from_slice(&bytes).map_err(|_| "插件设置文件损坏")?;
    if values.len() > 128 {
        return Err("插件设置最多保存 128 个键".into());
    }
    for (key, value) in &values {
        validate_key(key)?;
        validate_setting(value, 1)?;
    }
    Ok(values)
}
fn write_settings(
    path: &Path,
    values: &Map<String, Value>,
    token: &CancellationToken,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(values).map_err(|_| "插件设置无法序列化")?;
    if values.len() > 128 || bytes.len() > MAX_SETTINGS_BYTES {
        return Err("插件设置总大小超过 256 KiB 或 128 个键".into());
    }
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let has_file = plain_path(path, false)?;
    for stale in [&temporary, &backup] {
        if plain_path(stale, false)? {
            fs::remove_file(stale).map_err(|_| "无法清理插件设置暂存")?;
        }
    }
    fs::write(&temporary, bytes).map_err(|_| "无法暂存插件设置")?;
    if token.is_cancelled() {
        let _ = fs::remove_file(&temporary);
        return Err("插件操作已取消".into());
    }
    if has_file {
        fs::rename(path, &backup).map_err(|_| "无法准备插件设置更新")?;
    }
    if fs::rename(&temporary, path).is_err() {
        if has_file {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err("无法提交插件设置".into());
    }
    if has_file {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}
pub(crate) fn remove_settings_at(private_dir: &Path, plugin_id: &str) -> Result<(), String> {
    let directory = private_dir.join("settings");
    if !plain_path(&directory, true)? {
        return Ok(());
    }
    let path = settings_path(private_dir, plugin_id)?;
    for path in [
        path.clone(),
        path.with_extension("json.bak"),
        path.with_extension("json.tmp"),
    ] {
        if plain_path(&path, false)? {
            fs::remove_file(&path).map_err(|_| "无法清理插件设置")?;
        }
    }
    Ok(())
}

fn execute_settings(
    private_dir: &Path,
    plugin_id: &str,
    grant: &PluginHostGrant,
    effect: &HostEffect,
    token: &CancellationToken,
) -> Result<Value, String> {
    let (key, permission) = match effect {
        HostEffect::Get { key } => (key, "settings.read"),
        HostEffect::Set { key, .. } | HostEffect::Delete { key } => (key, "settings.write"),
        _ => return Err("插件设置操作无效".into()),
    };
    require_permission(grant, permission)?;
    validate_key(key)?;
    if token.is_cancelled() {
        return Err("插件操作已取消".into());
    }
    let path = settings_path(private_dir, plugin_id)?;
    let mut values = read_settings(&path)?;
    match effect {
        HostEffect::Get { .. } => {
            Ok(json!({ "value": values.get(key), "found": values.contains_key(key) }))
        }
        HostEffect::Set { value, .. } => {
            validate_setting(value, 1)?;
            if serde_json::to_vec(value)
                .map_err(|_| "插件设置无法序列化")?
                .len()
                > MAX_REQUEST_BYTES
            {
                return Err("单个插件设置超过 64 KiB".into());
            }
            values.insert(key.clone(), value.clone());
            write_settings(&path, &values, token)?;
            Ok(json!({ "saved": true }))
        }
        HostEffect::Delete { .. } => {
            let removed = values.remove(key).is_some();
            if removed {
                write_settings(&path, &values, token)?;
            }
            Ok(json!({ "removed": removed }))
        }
        _ => unreachable!(),
    }
}

async fn pick_ui_slice_path(
    app: &AppHandle,
    identity: &PluginHostIdentity,
    purpose: UiSlicePicker,
    native_window: bool,
    token: &CancellationToken,
) -> Result<Value, String> {
    let _picker = tokio::select! {
        biased;
        _ = token.cancelled() => return Err("切图操作已取消".into()),
        slot = UI_SLICE_PICKER_SLOT.acquire() => slot.map_err(|_| "文件选择器不可用")?,
    };
    let owner_label = plugin_registry::with_plugin_host_authority(app, identity, |_, grant| {
        require_permission(grant, "ui.custom")?;
        require_permission(grant, "files.connected.read")?;
        require_permission(grant, "files.output.create")?;
        ui_slice_pixels::check_cancelled(token)?;
        crate::plugin_window::dialog_owner_label(identity, native_window)
    })?;
    let owner = app.get_webview_window(&owner_label).ok_or("切图窗口已关闭")?;
    let dialog = app.dialog().file().set_parent(&owner);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let done = move |selected| { let _ = sender.send(selected); };
    match purpose {
        UiSlicePicker::OpenDraft => dialog.set_title("选择切图工作稿")
            .add_filter("切图工作稿", &["zip"]).pick_file(done),
        UiSlicePicker::SaveDraft => dialog.set_title("选择识别草稿保存目录").pick_folder(done),
        UiSlicePicker::Export => dialog.set_title("选择切图 ZIP 保存目录").pick_folder(done),
    }
    // The desktop dialog outlives the IPC wait and has no cancellation handle.
    // Hold the slot until the system closes it, then reject any cancelled selection.
    let selected = receiver.await.map_err(|_| "文件选择器已关闭")?;
    ui_slice_pixels::check_cancelled(token)?;
    let Some(selected) = selected else { return Ok(Value::Null); };
    let path = selected.simplified().into_path().map_err(|_| "请选择本机路径")?;
    let root = crate::path_policy::canonicalize_simplified(&path).map_err(|_| "所选路径不可用")?;
    let roots = std::slice::from_ref(&root);
    let opening_file = matches!(purpose, UiSlicePicker::OpenDraft);
    let verified = if opening_file {
        crate::path_policy::authorize_existing_plain_file_with_roots(
            app, path.to_str().ok_or("工作稿文件名无效")?, roots,
        )?
    } else {
        crate::path_policy::reauthorize_existing_plain_directory_with_roots(app, &path, roots)?
    };
    let path_text = verified.to_str().ok_or("所选路径名称无效")?;
    let scope = app.fs_scope();
    plugin_registry::with_plugin_host_authority(app, identity, |_, _| {
        ui_slice_pixels::check_cancelled(token)?;
        if crate::plugin_window::dialog_owner_label(identity, native_window)? != owner_label {
            return Err("切图窗口已关闭".into());
        }
        if opening_file {
            scope.allow_file(&verified).map_err(|_| "工作稿文件未获授权")?;
        } else {
            scope.allow_directory(&verified, false).map_err(|_| "保存目录未获授权")?;
        }
        Ok(Value::String(path_text.to_owned()))
    })
}

#[tauri::command]
pub async fn execute_plugin_host_effect(
    app: AppHandle,
    webview: Webview,
    identity: PluginHostIdentity,
    request_id: String,
    effect: HostEffect,
) -> Result<Value, String> {
    ensure_host_caller(&webview)?;
    if !valid_id(&identity.invocation_id) {
        return Err("插件调用 ID 无效".into());
    }
    let lease = RequestLease::register(&identity.plugin_id, &request_id)?;
    if matches!(&effect, HostEffect::UiSliceInspect { .. } | HostEffect::UiSlicePick { .. } | HostEffect::UiSliceOpenDraft { .. } | HostEffect::UiSlicePublish { .. }) {
        if identity.plugin_id != "ai-canvas.ui-slice" || identity.tool_id != "slice-image" {
            return Err("当前插件工具不能使用切图能力".into());
        }
        if let HostEffect::UiSlicePick { purpose, native_window } = effect {
            return pick_ui_slice_path(&app, &identity, purpose, native_window, &lease.token).await;
        }
        let slot = tokio::select! {
            biased;
            _ = lease.token.cancelled() => return Err("切图操作已取消".into()),
            slot = ui_slice::SLOT.acquire() => slot.map_err(|_| "切图工作队列已关闭")?,
        };
        return tauri::async_runtime::spawn_blocking(move || {
            let _slot = slot;
            let authorize = |operation: &mut dyn FnMut() -> Result<(), String>| {
                plugin_registry::with_plugin_host_authority(&app, &identity, |_, grant| {
                    require_permission(grant, "files.connected.read")?;
                    require_permission(grant, "files.output.create")?;
                    require_permission(grant, "ui.custom")?;
                    ui_slice_pixels::check_cancelled(&lease.token)?;
                    operation()
                })
            };
            authorize(&mut || Ok(()))?;
            match effect {
                HostEffect::UiSliceInspect { source_path, assume_srgb } => {
                    let result = ui_slice::inspect(&app, &source_path, assume_srgb, &lease.token)?;
                    authorize(&mut || Ok(()))?;
                    Ok(result)
                }
                HostEffect::UiSliceOpenDraft { source_path, archive_path, assume_srgb } => {
                    let result = ui_slice::open_draft(&app, &archive_path, &source_path, assume_srgb, &lease.token)?;
                    authorize(&mut || Ok(()))?;
                    Ok(result)
                }
                HostEffect::UiSlicePublish {
                    source_path, directory, source_sha256, assume_srgb, items, missing, include_source,
                    new_draft, overwrite_draft,
                } => {
                    let destination = match (directory.as_deref(), new_draft, overwrite_draft.as_ref()) {
                        (Some(path), false, None) => ui_slice::Destination::Directory(path),
                        (Some(path), true, None) if include_source => ui_slice::Destination::NewDraft(path),
                        (None, false, Some(draft)) if include_source => ui_slice::Destination::OverwriteDraft(draft),
                        _ => return Err("切图保存目标无效".into()),
                    };
                    ui_slice::publish(&app, ui_slice::Publish {
                        source: &source_path, destination, source_sha256: &source_sha256,
                        assume_srgb, items: &items, missing: &missing, include_source,
                    }, &request_id, &lease.token, authorize)
                }
                _ => unreachable!("slice effects matched above"),
            }
        }).await.map_err(|_| "切图工作线程异常")?;
    }
    if let HostEffect::Network {
        url,
        method,
        headers,
        body,
    } = effect
    {
        let url = plugin_registry::with_plugin_host_authority(&app, &identity, |_, grant| {
            require_permission(grant, "network.request")?;
            validate_request(
                &url,
                &method,
                &headers,
                body.as_deref(),
                &grant.network_origins,
            )
        })?;
        let result = tokio::select! {
            biased;
            _ = lease.token.cancelled() => return Err("插件操作已取消".into()),
            result = tokio::time::timeout(REQUEST_TIMEOUT, request_network(url, method, headers, body)) => result.map_err(|_| "插件网络请求超时")??,
        };
        if lease.token.is_cancelled() {
            return Err("插件操作已取消".into());
        }
        plugin_registry::with_plugin_host_authority(&app, &identity, |_, grant| {
            require_permission(grant, "network.request")?;
            Ok(result)
        })
    } else {
        plugin_registry::with_plugin_host_authority(&app, &identity, |directory, grant| {
            execute_settings(directory, &identity.plugin_id, grant, &effect, &lease.token)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_id() -> String {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }
    fn directory() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("ai-canvas-plugin-settings-{}", test_id()));
        fs::create_dir(&directory).unwrap();
        directory
    }
    fn grant() -> PluginHostGrant {
        PluginHostGrant {
            permissions: vec!["settings.read".into(), "settings.write".into()],
            network_origins: vec![],
        }
    }

    #[test]
    fn network_contract_rejects_unapproved_origins_and_transport_overrides() {
        let origins = vec!["https://api.example.com".to_string()];
        for origin in [
            "http://api.example.com",
            "https://localhost",
            "https://127.0.0.1",
            "https://[::1]",
            "https://api.example.com/",
            "https://api.example.com:443",
            "https://api.example.com:8443",
            "https://*.example.com",
            "https://api.example.com/path",
            "https://name:secret@api.example.com",
            "https://a.local",
        ] {
            assert!(validate_origin(origin).is_err(), "{origin}");
        }
        assert!(validate_origin(&origins[0]).is_ok());
        assert!(validate_request(
            "https://api.example.com/items?q=hello",
            "POST",
            &HashMap::new(),
            Some("{}"),
            &origins
        )
        .is_ok());
        assert!(validate_request(
            "https://sub.api.example.com/items",
            "GET",
            &HashMap::new(),
            None,
            &origins
        )
        .is_err());
        assert!(validate_request(
            "https://api.example.com",
            "GET",
            &HashMap::from([("Host".into(), "other.example.com".into())]),
            None,
            &origins
        )
        .is_err());
        assert!(validate_request(
            "https://api.example.com",
            "POST",
            &HashMap::new(),
            Some(&"a".repeat(MAX_REQUEST_BYTES + 1)),
            &origins
        )
        .is_err());
        assert!(validate_request(
            "https://api.example.com",
            "GET",
            &HashMap::new(),
            Some("{}"),
            &origins
        )
        .is_err());
    }
    #[test]
    fn rejects_private_mixed_and_empty_dns_answers() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "100.64.0.1",
            "198.18.0.1",
            "::1",
            "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                validate_addresses(&[SocketAddr::new(ip.parse().unwrap(), 443)]).is_err(),
                "{ip}"
            );
        }
        let public = SocketAddr::new("8.8.8.8".parse().unwrap(), 443);
        assert!(validate_addresses(&[public]).is_ok());
        assert!(validate_addresses(&[]).is_err());
        assert!(
            validate_addresses(&[public, SocketAddr::new("10.0.0.1".parse().unwrap(), 443)])
                .is_err()
        );
    }
    #[test]
    fn settings_are_isolated_bounded_and_reject_sensitive_fields() {
        let directory = directory();
        let token = CancellationToken::new();
        let set = HostEffect::Set {
            key: "preferences".into(),
            value: json!({"language": "zh-CN", "frameCount": 12}),
        };
        execute_settings(&directory, "plugin.a", &grant(), &set, &token).unwrap();
        let get = HostEffect::Get {
            key: "preferences".into(),
        };
        assert_eq!(
            execute_settings(&directory, "plugin.a", &grant(), &get, &token).unwrap()["value"]
                ["frameCount"],
            12
        );
        assert_eq!(
            execute_settings(&directory, "plugin.b", &grant(), &get, &token).unwrap()["found"],
            false
        );
        for value in [
            json!({"api_key": "secret"}),
            json!({"nested": {"accessToken": "secret"}}),
            json!("/private/example"),
            json!({"x": "a".repeat(MAX_REQUEST_BYTES)}),
        ] {
            assert!(execute_settings(
                &directory,
                "plugin.a",
                &grant(),
                &HostEffect::Set {
                    key: "invalid".into(),
                    value
                },
                &token
            )
            .is_err());
        }
        assert!(execute_settings(
            &directory,
            "plugin.a",
            &PluginHostGrant {
                permissions: vec![],
                network_origins: vec![]
            },
            &get,
            &token
        )
        .is_err());
        token.cancel();
        assert!(execute_settings(
            &directory,
            "plugin.a",
            &grant(),
            &HostEffect::Set {
                key: "preferences".into(),
                value: json!(false)
            },
            &token
        )
        .is_err());
        assert_eq!(
            read_settings(&settings_path(&directory, "plugin.a").unwrap()).unwrap()["preferences"]
                ["frameCount"],
            12
        );
        remove_settings_at(&directory, "plugin.a").unwrap();
        assert!(
            read_settings(&settings_path(&directory, "plugin.a").unwrap())
                .unwrap()
                .is_empty()
        );
        fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn network_responses_reject_redirects_oversized_bodies_and_invalid_utf8() {
        async fn response(status: u16, body: Vec<u8>, length: Option<usize>) -> reqwest::Response {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            // 回环服务只用来检查响应读取；生产请求仍必须先通过公共 DNS 校验。
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).await.unwrap();
                let length_header = length
                    .map(|length| format!("Content-Length: {length}\r\n"))
                    .unwrap_or_default();
                let headers =
                    format!("HTTP/1.1 {status} Result\r\nConnection: close\r\n{length_header}\r\n");
                let _ = stream.write_all(headers.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            });
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap()
        }
        assert!(read_network_response(response(302, vec![], None).await)
            .await
            .is_err());
        assert!(
            read_network_response(response(200, vec![], Some(MAX_RESPONSE_BYTES + 1)).await)
                .await
                .is_err()
        );
        assert!(read_network_response(
            response(200, vec![b'a'; MAX_RESPONSE_BYTES + 1], None).await
        )
        .await
        .is_err());
        assert!(read_network_response(response(200, vec![0xff], None).await)
            .await
            .is_err());
        assert!(
            read_network_response(response(200, vec![b'a'; 256_001], None).await)
                .await
                .is_err()
        );
        let result =
            read_network_response(response(429, "请求过多".as_bytes().to_vec(), None).await)
                .await
                .unwrap();
        assert_eq!(result["status"], 429);
        assert_eq!(result["body"], "请求过多");
    }
    #[test]
    fn settings_keep_existing_values_when_depth_or_total_quota_is_exceeded() {
        let directory = directory();
        let token = CancellationToken::new();
        let mut value = json!(true);
        for _ in 0..7 {
            value = json!({"child": value});
        }
        execute_settings(
            &directory,
            "plugin.depth",
            &grant(),
            &HostEffect::Set {
                key: "preferences".into(),
                value: value.clone(),
            },
            &token,
        )
        .unwrap();
        let result = execute_settings(
            &directory,
            "plugin.depth",
            &grant(),
            &HostEffect::Get {
                key: "preferences".into(),
            },
            &token,
        )
        .unwrap();
        assert_eq!(result["value"], value);
        assert!(execute_settings(
            &directory,
            "plugin.depth",
            &grant(),
            &HostEffect::Set {
                key: "preferences".into(),
                value: json!({"child": value})
            },
            &token
        )
        .is_err());
        let path = settings_path(&directory, "plugin.quota").unwrap();
        for index in 0..4 {
            execute_settings(
                &directory,
                "plugin.quota",
                &grant(),
                &HostEffect::Set {
                    key: format!("item{index}"),
                    value: json!("a".repeat(64_000)),
                },
                &token,
            )
            .unwrap();
        }
        let before = fs::read(&path).unwrap();
        assert!(execute_settings(
            &directory,
            "plugin.quota",
            &grant(),
            &HostEffect::Set {
                key: "extra".into(),
                value: json!("a".repeat(64_000))
            },
            &token
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let values: Map<_, _> = (0..128)
            .map(|index| (format!("item{index}"), json!(null)))
            .collect();
        fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
        assert!(execute_settings(
            &directory,
            "plugin.quota",
            &grant(),
            &HostEffect::Set {
                key: "extra".into(),
                value: json!(false)
            },
            &token
        )
        .is_err());
        assert_eq!(read_settings(&path).unwrap(), values);
        let result = execute_settings(
            &directory,
            "plugin.quota",
            &grant(),
            &HostEffect::Get {
                key: "item0".into(),
            },
            &token,
        )
        .unwrap();
        assert_eq!(result, json!({"value": null, "found": true}));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn settings_recover_a_backup_and_refuse_corrupt_content() {
        let directory = directory();
        let path = settings_path(&directory, "plugin.a").unwrap();
        fs::write(path.with_extension("json.bak"), br#"{"language":"zh-CN"}"#).unwrap();
        assert_eq!(read_settings(&path).unwrap()["language"], "zh-CN");
        fs::write(&path, b"invalid JSON").unwrap();
        assert!(read_settings(&path).is_err());
        fs::write(&path, vec![b'a'; MAX_SETTINGS_BYTES + 1]).unwrap();
        assert!(read_settings(&path).is_err());
        // 文件超限仍可卸载；清理只删除自己目录中的普通文件，不读取正文。
        remove_settings_at(&directory, "plugin.a").unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(directory).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn settings_refuse_symlinked_directories_and_files() {
        use std::os::unix::fs::symlink;
        let directory = directory();
        let target = directory.join("target");
        fs::create_dir(&target).unwrap();
        symlink(&target, directory.join("settings")).unwrap();
        assert!(settings_path(&directory, "plugin.a").is_err());
        fs::remove_file(directory.join("settings")).unwrap();
        let path = settings_path(&directory, "plugin.a").unwrap();
        let source = directory.join("source.json");
        fs::write(&source, b"{}").unwrap();
        symlink(&source, &path).unwrap();
        assert!(read_settings(&path).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn early_cancellation_and_revision_revocation_stop_requests() {
        let id = format!("test-{}", test_id());
        cancel_request(&id, "early").unwrap();
        assert!(RequestLease::register(&id, "early").is_err());
        let lease = RequestLease::register(&id, "active").unwrap();
        assert!(RequestLease::register(&id, "active").is_err());
        cancel_plugin_requests(Some(&id));
        assert!(lease.token.is_cancelled());
    }
}
