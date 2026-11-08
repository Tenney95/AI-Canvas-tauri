//! P2 冷维护与耐久材料。正式迁移始终关闭；不接受 profile/文件系统绝对路径。
//! Windows 由 WebView2 exclusive environment 排除旧浏览器实例；新 fs2 锁仅串行 fixture 维护。
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
};
#[cfg(windows)]
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Webview};

const WINDOW: &str = "project-model-maintenance";
const DIRECTORY: &str = "project-model-maintenance";
const MAX_FILE: u64 = 128 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
const MAX_MANIFEST: u64 = 2 * 1024 * 1024;
const MAX_IPC: u64 = 8 * 1024 * 1024;
const ERROR: &str = "项目模型维护条件不满足，已停止且保留原材料";
const PAGE: &str = "<!doctype html><html lang=zh-CN><head><meta charset=utf-8><title>项目模型隔离维护</title></head><body><p>隔离维护环境已启动。正式迁移关闭，本页不加载画布、队列或业务脚本。</p></body></html>";

#[derive(Clone)]
pub enum ColdMaintenanceRequest {
    // 各平台都解析启动参数，但只有 Windows 会读取 fixture ID。
    #[cfg_attr(not(windows), allow(dead_code))]
    Fixture(String),
    ProductionProofOnly,
}

/// 仅命令行冷启动可选择；release 永远拒绝。普通启动不创建目录、不访问用户资料。
pub fn cold_request() -> Result<Option<ColdMaintenanceRequest>, &'static str> {
    let mut request = None;
    for arg in std::env::args().skip(1) {
        let candidate = if let Some(id) = arg.strip_prefix("--project-model-maintenance-fixture=") {
            if !safe_id(id) || id.len() > 64 { return Err(ERROR); }
            Some(ColdMaintenanceRequest::Fixture(id.to_owned()))
        } else if arg == "--project-model-maintenance-production-proof" {
            Some(ColdMaintenanceRequest::ProductionProofOnly)
        } else if arg.starts_with("--project-model-maintenance") {
            return Err(ERROR);
        } else { None };
        if let Some(candidate) = candidate {
            if !cfg!(debug_assertions) || request.is_some() { return Err(ERROR); }
            request = Some(candidate);
        }
    }
    Ok(request)
}

#[derive(Default)]
pub struct ProjectModelMaintenanceState {
    session: Mutex<Option<Session>>,
    revoked: AtomicBool,
}
struct Session {
    lease: MaintenanceLease,
    root: Option<PathBuf>,
    _lock: Option<File>,
    created_operations: HashMap<String, WriteBudget>,
    environment_revoked: Arc<AtomicBool>,
}
#[derive(Default)]
struct WriteBudget { paths: HashSet<String>, bytes: u64 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceLease {
    lease_id: String,
    profile_id: String,
    mode: &'static str,
    cold_start: bool,
    production_allowed: bool,
}
#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableSeal {
    format: String,
    operation_id: String,
    profile_id: String,
    manifest_sha256: String,
    complete_sha256: String,
    durability: String,
    can_activate: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Complete { format: String, operation_id: String, manifest_sha256: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String, operation_id: String, created_at: u64,
    database_name: String, schema_version: u64,
    database_store_names: Vec<String>, stores: Vec<serde_json::Value>,
    local_storage: Vec<serde_json::Value>, files: Vec<ManifestFile>, total_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile { path: String, kind: String, bytes: u64, sha256: String }

fn safe_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn safe_path(value: &str) -> bool {
    value.len() <= 512 && !value.is_empty() && value.split('/').count() <= 8
        && value.split('/').all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            !part.is_empty() && part.len() <= 128 && part.as_bytes()[0].is_ascii_alphanumeric()
                && !part.ends_with('.') && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                && !matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                && !(stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn plain(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(ERROR.into()); }
    }
    if metadata.file_type().is_symlink() || if directory { !metadata.is_dir() } else { !metadata.is_file() } {
        return Err(ERROR.into());
    }
    Ok(())
}
fn directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::create_dir(path).map_err(|_| ERROR)?;
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| ERROR)?; }
    }
    plain(path, true)
}
fn plain_chain(path: &Path) -> Result<(), String> {
    let ancestors: Vec<_> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev().filter(|value| !value.as_os_str().is_empty()) { plain(ancestor, true)?; }
    Ok(())
}
fn child(root: &Path, relative: &str, create: bool) -> Result<PathBuf, String> {
    if !safe_path(relative) { return Err(ERROR.into()); }
    plain(root, true)?;
    let parts: Vec<_> = relative.split('/').collect();
    let mut result = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        result.push(part);
        if index + 1 < parts.len() {
            if create { directory(&result)?; } else { plain(&result, true)?; }
        }
    }
    Ok(result)
}
fn read_bounded(root: &Path, path: &str, max: u64) -> Result<Vec<u8>, String> {
    if max > MAX_FILE { return Err(ERROR.into()); }
    let path = child(root, path, false)?;
    plain(&path, false)?;
    let file = open_plain(&path, false)?;
    let size = file.metadata().map_err(|_| ERROR)?.len();
    if size > max { return Err(ERROR.into()); }
    let mut result = Vec::with_capacity(size as usize);
    (&file).take(max + 1).read_to_end(&mut result).map_err(|_| ERROR)?;
    if result.len() as u64 != size || file.metadata().map_err(|_| ERROR)?.len() != size { return Err(ERROR.into()); }
    plain(&path, false)?;
    Ok(result)
}
fn open_plain(path: &Path, write: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Reparse points must remain visible to metadata; no shared writer during this handle.
        options.custom_flags(0x00200000).share_mode(1);
    }
    let file = options.open(path).map_err(|_| ERROR)?;
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if !metadata.is_file() { return Err(ERROR.into()); }
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err(ERROR.into()); } }
    Ok(file)
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path).and_then(|file| file.sync_all()).map_err(|_| ERROR.to_string())?;
    #[cfg(not(unix))]
    let _ = path; // Windows publication uses MoveFileExW(MOVEFILE_WRITE_THROUGH), below.
    Ok(())
}
fn durable_filesystem(root: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW, GetVolumePathNameW}};
        let path: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut volume = [0u16; 1024];
        unsafe { GetVolumePathNameW(PCWSTR(path.as_ptr()), &mut volume) }.map_err(|_| ERROR)?;
        if unsafe { GetDriveTypeW(PCWSTR(volume.as_ptr())) } != 3 { return Err(ERROR.into()); }
        let mut filesystem = [0u16; 64];
        unsafe { GetVolumeInformationW(PCWSTR(volume.as_ptr()), None, None, None, None, Some(&mut filesystem)) }.map_err(|_| ERROR)?;
        let end = filesystem.iter().position(|unit| *unit == 0).ok_or(ERROR)?;
        if !matches!(String::from_utf16_lossy(&filesystem[..end]).as_str(), "NTFS" | "ReFS") { return Err(ERROR.into()); }
    }
    #[cfg(not(windows))]
    { let _ = root; return Err(ERROR.into()); }
    #[cfg(windows)]
    Ok(())
}
fn create_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new(); options.create_new(true).write(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x80000000 | 0x00200000).share_mode(0); }
    let mut file = options.open(path).map_err(|_| ERROR)?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| ERROR)?;
    plain(path, false)?;
    Ok(())
}
fn publish_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or(ERROR)?;
    plain(parent, true)?;
    if path.exists() { return Err(ERROR.into()); }
    let temp = path.with_extension("publishing");
    create_synced(&temp, bytes)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH}};
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_WRITE_THROUGH) }.map_err(|_| ERROR)?;
    }
    #[cfg(not(windows))]
    {
        // link is exclusive (rename would replace an existing completed marker on Unix).
        fs::hard_link(&temp, path).map_err(|_| ERROR)?;
        sync_directory(parent)?;
        fs::remove_file(&temp).map_err(|_| ERROR)?;
    }
    sync_directory(parent)?;
    Ok(())
}

pub fn private_root<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|root| root.join(DIRECTORY)).map_err(|_| ERROR.into())
}
pub fn is_private_path<R: tauri::Runtime>(app: &AppHandle<R>, path: &Path, overlap: bool) -> bool {
    let Ok(root) = private_root(app) else { return true; };
    fn contains(root: &Path, candidate: &Path, overlap: bool) -> bool {
        let root = root.to_string_lossy().replace('\\', "/").to_lowercase();
        let candidate = candidate.to_string_lossy().replace('\\', "/").to_lowercase();
        let root = root.trim_start_matches("//?/").trim_end_matches('/');
        let candidate = candidate.trim_start_matches("//?/").trim_end_matches('/');
        candidate == root || candidate.starts_with(&format!("{root}/"))
            || overlap && root.starts_with(&format!("{candidate}/"))
    }
    contains(&root, path, overlap) || root.canonicalize().is_ok_and(|real| contains(&real, path, overlap))
}
pub fn deny_private_access<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let root = private_root(app)?;
    app.fs_scope().forbid_directory(&root, true).map_err(|_| ERROR)?;
    app.asset_protocol_scope().forbid_directory(&root, true).map_err(|_| ERROR)?;
    if let Ok(real) = root.canonicalize() {
        app.fs_scope().forbid_directory(&real, true).map_err(|_| ERROR)?;
        app.asset_protocol_scope().forbid_directory(&real, true).map_err(|_| ERROR)?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn start_maintenance(app: &mut tauri::App, request: ColdMaintenanceRequest) -> Result<(), String> {
    if !cfg!(debug_assertions) || app.managed_surface_counts() != (0, 0) { return Err(ERROR.into()); }
    let (root, lock, profile, profile_id, mode) = match request {
        ColdMaintenanceRequest::Fixture(id) => {
            let local = app.path().app_local_data_dir().map_err(|_| ERROR)?;
            plain_chain(&local)?;
            let base = private_root(app.handle())?; directory(&base)?;
            let root = base.join(&id); directory(&root)?;
            let lock_path = root.join("maintenance.lock");
            if lock_path.exists() { plain(&lock_path, false)?; }
            let mut options = OpenOptions::new(); options.create(true).read(true).write(true).truncate(false);
            { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000).share_mode(0); }
            let lock = options.open(lock_path).map_err(|_| ERROR)?;
            { use std::os::windows::fs::MetadataExt; if lock.metadata().map_err(|_| ERROR)?.file_attributes() & 0x400 != 0 { return Err(ERROR.into()); } }
            FileExt::try_lock_exclusive(&lock).map_err(|_| ERROR)?;
            let profile = root.join("profile"); directory(&profile)?;
            (Some(root), Some(lock), profile, id, "isolated-fixture")
        }
        ColdMaintenanceRequest::ProductionProofOnly => {
            if app.config().app.windows.iter().any(|window| window.data_directory.is_some()) { return Err(ERROR.into()); }
            let profile = app.path().app_local_data_dir().map_err(|_| ERROR)?;
            plain_chain(&profile)?;
            // Tauri's Windows default is LocalData/config.identifier, not appDataDir.
            // A missing established WebView2 profile is not evidence that an old one stopped.
            plain(&profile.join("EBWebView"), true)?;
            (None, None, profile, "production-proof".into(), "production-proof-only")
        }
    };
    // This SDK option fences the actual browser profile, including old applications
    // which do not know our new lock. Unsupported/busy environments fail closed.
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok().map_err(|_| ERROR)?;
    let (environment, environment_revoked) = tauri::webview::create_exclusive_webview2_environment(&profile).map_err(|_| ERROR)?;
    let lease_id = digest(format!("{}-{:?}", std::process::id(), std::time::SystemTime::now()).as_bytes());
    let state = app.state::<ProjectModelMaintenanceState>();
    *state.session.lock().map_err(|_| ERROR)? = Some(Session {
        lease: MaintenanceLease { lease_id, profile_id, mode, cold_start: true, production_allowed: false },
        root, _lock: lock, created_operations: HashMap::new(), environment_revoked,
    });
    let navigation_app = app.handle().clone();
    tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::CustomProtocol(
        "project-model-maintenance://localhost/index.html".parse().map_err(|_| ERROR)?))
        .with_environment(environment)
        .data_directory(profile)
        .use_https_scheme(false)
        .title("项目模型隔离维护 · 正式迁移关闭")
        .inner_size(700.0, 300.0)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            let allowed = maintenance_url(url);
            if !allowed { navigation_app.state::<ProjectModelMaintenanceState>().revoked.store(true, Ordering::Release); }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|_| ERROR)?;
    Ok(())
}
#[cfg(not(windows))]
pub fn start_maintenance(_app: &mut tauri::App, _request: ColdMaintenanceRequest) -> Result<(), String> {
    Err("此平台尚无可验证的 profile 排他环境，已拒绝项目模型维护".into())
}
fn maintenance_url(url: &url::Url) -> bool {
    url.path() == "/index.html" && url.query().is_none() && url.fragment().is_none()
        && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && (url.scheme() == "project-model-maintenance" && url.host_str() == Some("localhost")
            || url.scheme() == "http" && url.host_str() == Some("project-model-maintenance.localhost"))
}
pub fn handle_protocol(context: tauri::UriSchemeContext<'_, tauri::Wry>, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let accepted = context.webview_label() == WINDOW && request.uri().path() == "/index.html"
        && request.uri().query().is_none()
        && matches!(request.uri().authority().map(|authority| authority.as_str()), Some("localhost" | "project-model-maintenance.localhost"));
    tauri::http::Response::builder()
        .status(if accepted { 200 } else { 403 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src ipc: http://ipc.localhost")
        .body(if accepted { PAGE.as_bytes().to_vec() } else { Vec::new() })
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == WINDOW && matches!(event, tauri::WindowEvent::Destroyed) {
        window.app_handle().state::<ProjectModelMaintenanceState>().revoked.store(true, Ordering::Release);
    }
}
fn only_maintenance_surface(webview: &Webview) -> bool {
    // 不能用 webview_windows() 推断全量：它会过滤纯窗口和带子 WebView 的宿主。
    if webview.app_handle().managed_surface_counts() != (1, 1) { return false; }
    let window = webview.window();
    let views = window.webviews();
    window.label() == WINDOW && views.len() == 1 && views[0].label() == WINDOW
}
async fn checked_session(webview: &Webview, lease_id: Option<&str>, fixture: bool) -> Result<(MaintenanceLease, Option<PathBuf>), String> {
    if !cfg!(debug_assertions) || webview.label() != WINDOW || !maintenance_url(&webview.url().map_err(|_| ERROR)?)
        || !only_maintenance_surface(webview) { return Err(ERROR.into()); }
    let state = webview.app_handle().state::<ProjectModelMaintenanceState>();
    if state.revoked.load(Ordering::Acquire) { return Err(ERROR.into()); }
    let _result = {
        let guard = state.session.lock().map_err(|_| ERROR)?;
        let session = guard.as_ref().ok_or(ERROR)?;
        if session.environment_revoked.load(Ordering::Acquire) || lease_id.is_some_and(|value| value != session.lease.lease_id)
            || fixture && session.lease.mode != "isolated-fixture" { return Err(ERROR.into()); }
        (session.lease.clone(), session.root.clone())
    };
    #[cfg(windows)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        webview.with_webview(move |platform| {
            let mut pid = 0;
            let alive = unsafe { platform.controller().CoreWebView2() }
                .is_ok_and(|core| unsafe { core.BrowserProcessId(&mut pid) }.is_ok() && pid > 0);
            let _ = tx.send(alive);
        }).map_err(|_| ERROR)?;
        if !tokio::time::timeout(std::time::Duration::from_secs(10), rx).await.map_err(|_| ERROR)?.map_err(|_| ERROR)? {
            state.revoked.store(true, Ordering::Release); return Err(ERROR.into());
        }
    }
    #[cfg(not(windows))]
    return Err(ERROR.into());
    #[cfg(windows)]
    {
        if state.revoked.load(Ordering::Acquire)
            || state.session.lock().map_err(|_| ERROR)?.as_ref().ok_or(ERROR)?.environment_revoked.load(Ordering::Acquire)
            || !only_maintenance_surface(webview) { return Err(ERROR.into()); }
        Ok(_result)
    }
}
async fn operation_root(webview: &Webview, lease_id: &str, operation_id: &str) -> Result<(MaintenanceLease, PathBuf), String> {
    if !safe_id(operation_id) { return Err(ERROR.into()); }
    let (lease, root) = checked_session(webview, Some(lease_id), true).await?;
    let root = root.ok_or(ERROR)?.join("backups");
    plain_chain(&root)?;
    durable_filesystem(&root)?;
    let operation = root.join(operation_id); plain(&operation, true)?;
    Ok((lease, operation))
}

#[tauri::command]
pub async fn project_model_get_maintenance_lease(webview: Webview) -> Result<MaintenanceLease, String> {
    checked_session(&webview, None, true).await.map(|value| value.0)
}
#[tauri::command]
pub async fn project_model_verify_maintenance_lease(webview: Webview, lease_id: String) -> Result<MaintenanceLease, String> {
    checked_session(&webview, Some(&lease_id), true).await.map(|value| value.0)
}
#[tauri::command]
pub async fn project_model_get_production_stop_evidence(webview: Webview) -> Result<serde_json::Value, String> {
    let (lease, _) = checked_session(&webview, None, false).await?;
    if lease.mode != "production-proof-only" { return Err(ERROR.into()); }
    Ok(serde_json::json!({"mode":"production-proof-only", "exclusiveEnvironment":true, "coldStart":true, "productionAllowed":false}))
}
#[tauri::command]
pub async fn project_model_open_backup(webview: Webview, lease_id: String, operation_id: String, create: bool) -> Result<(), String> {
    if !safe_id(&operation_id) { return Err(ERROR.into()); }
    let (_, root) = checked_session(&webview, Some(&lease_id), true).await?;
    let root = root.ok_or(ERROR)?.join("backups");
    if create { directory(&root)?; } else { plain(&root, true)?; }
    plain_chain(&root)?;
    durable_filesystem(&root)?;
    let operation = root.join(&operation_id);
    if create {
        fs::create_dir(&operation).map_err(|_| ERROR)?; sync_directory(&root)?;
        let state = webview.app_handle().state::<ProjectModelMaintenanceState>();
        state.session.lock().map_err(|_| ERROR)?.as_mut().ok_or(ERROR)?
            .created_operations.insert(operation_id, WriteBudget::default());
    }
    plain(&operation, true)
}
#[tauri::command]
pub async fn project_model_write_backup_entry(webview: Webview, lease_id: String, operation_id: String, path: String,
    bytes: Vec<u8>, complete: bool) -> Result<(), String> {
    let (lease, root) = operation_root(&webview, &lease_id, &operation_id).await?;
    if bytes.len() as u64 > MAX_IPC || path == "durable.json" || root.join("durable.json").exists()
        || root.join("complete.json").exists() || complete != (path == "complete.json") { return Err(ERROR.into()); }
    let state = webview.app_handle().state::<ProjectModelMaintenanceState>();
    let mut guard = state.session.lock().map_err(|_| ERROR)?;
    let environment_revoked = guard.as_ref().ok_or(ERROR)?.environment_revoked.clone();
    let budget = guard.as_mut().ok_or(ERROR)?.created_operations.get_mut(&operation_id).ok_or(ERROR)?;
    let total = budget.bytes.checked_add(bytes.len() as u64).ok_or(ERROR)?;
    if total > MAX_TOTAL || budget.paths.len() >= 20_002 || budget.paths.contains(&path)
        || fs2::available_space(&root).map_err(|_| ERROR)? < bytes.len() as u64 + 16 * 1024 * 1024 { return Err(ERROR.into()); }
    let target = child(&root, &path, true)?;
    if complete {
        verify_materials(&root, &lease, &operation_id, &bytes)?;
        if state.revoked.load(Ordering::Acquire) || environment_revoked.load(Ordering::Acquire) { return Err(ERROR.into()); }
        publish_synced(&target, &bytes)?;
    } else {
        // Publish every material via a write-through directory operation too.
        publish_synced(&target, &bytes)?;
    }
    budget.bytes = total; budget.paths.insert(path);
    if state.revoked.load(Ordering::Acquire) || environment_revoked.load(Ordering::Acquire) { return Err(ERROR.into()); }
    Ok(())
}
#[tauri::command]
pub async fn project_model_read_backup_entry(webview: Webview, lease_id: String, operation_id: String, path: String, max_bytes: u64) -> Result<Vec<u8>, String> {
    if max_bytes > MAX_IPC { return Err(ERROR.into()); }
    let (_, root) = operation_root(&webview, &lease_id, &operation_id).await?;
    read_bounded(&root, &path, max_bytes)
}
fn verify_materials(root: &Path, lease: &MaintenanceLease, operation_id: &str, complete_bytes: &[u8]) -> Result<DurableSeal, String> {
    if complete_bytes.len() > 4096 { return Err(ERROR.into()); }
    let complete: Complete = serde_json::from_slice(complete_bytes).map_err(|_| ERROR)?;
    let manifest_bytes = read_bounded(root, "manifest.json", MAX_MANIFEST)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|_| ERROR)?;
    let supported_format = match complete.format.as_str() {
        "project-model-backup-v1" => manifest.schema_version > 0 && manifest.schema_version <= 27,
        "project-model-fixture-backup-v2" => manifest.schema_version == 28,
        _ => false,
    };
    if !supported_format || complete.operation_id != operation_id
        || manifest.format != complete.format || manifest.operation_id != operation_id
        || complete.manifest_sha256 != digest(&manifest_bytes)
        || manifest.database_name != format!("ai-canvas-model-fixture-{}", lease.profile_id)
        || manifest.files.len() > 20_000 || manifest.total_bytes > MAX_TOTAL
        || manifest.created_at > 9_007_199_254_740_991
        || manifest.database_store_names.len() > 128 || manifest.stores.len() > 128 || manifest.local_storage.len() != 1 {
        return Err(ERROR.into());
    }
    let mut chunks = HashSet::new();
    let mut chunk_locations = HashSet::new();
    let mut store_names = HashSet::new();
    for store in &manifest.stores {
        let name = store.get("name").and_then(serde_json::Value::as_str).ok_or(ERROR)?;
        if !store_names.insert(name) { return Err(ERROR.into()); }
        for path in store.get("chunks").and_then(serde_json::Value::as_array).ok_or(ERROR)? {
            let path = path.as_str().ok_or(ERROR)?;
            if !chunks.insert(path.to_owned()) || !chunk_locations.insert(path.to_ascii_lowercase()) { return Err(ERROR.into()); }
        }
    }
    let local_path = manifest.local_storage[0].get("path").and_then(serde_json::Value::as_str).ok_or(ERROR)?;
    let mut seen = HashSet::new();
    let mut locations = HashSet::new();
    let mut total = 0u64;
    for entry in manifest.files {
        if !safe_path(&entry.path) || matches!(entry.path.as_str(), "manifest.json" | "complete.json" | "durable.json")
            || !seen.insert(entry.path.clone()) || !locations.insert(entry.path.to_ascii_lowercase())
            || !matches!(entry.kind.as_str(), "records" | "binary" | "localStorage")
            || entry.bytes > MAX_FILE || !valid_digest(&entry.sha256) { return Err(ERROR.into()); }
        if entry.kind == "records" && !chunks.remove(&entry.path)
            || entry.kind == "localStorage" && entry.path != local_path { return Err(ERROR.into()); }
        total = total.checked_add(entry.bytes).ok_or(ERROR)?;
        if total > MAX_TOTAL { return Err(ERROR.into()); }
        let bytes = read_bounded(root, &entry.path, entry.bytes)?;
        if bytes.len() as u64 != entry.bytes || digest(&bytes) != entry.sha256 { return Err(ERROR.into()); }
        open_plain(&child(root, &entry.path, false)?, true)?.sync_all().map_err(|_| ERROR)?;
    }
    if total != manifest.total_bytes || !chunks.is_empty() || !seen.contains(local_path) { return Err(ERROR.into()); }
    seen.insert("manifest.json".into()); seen.insert("complete.json".into()); seen.insert("durable.json".into());
    fn check_entries(root: &Path, directory: &Path, seen: &HashSet<String>, depth: usize, count: &mut usize) -> Result<(), String> {
        if depth > 8 { return Err(ERROR.into()); }
        for entry in fs::read_dir(directory).map_err(|_| ERROR)? {
            let path = entry.map_err(|_| ERROR)?.path();
            *count += 1; if *count > 40_000 { return Err(ERROR.into()); }
            let metadata = fs::symlink_metadata(&path).map_err(|_| ERROR)?;
            if metadata.is_dir() {
                plain(&path, true)?; check_entries(root, &path, seen, depth + 1, count)?;
            } else {
                plain(&path, false)?;
                let relative = path.strip_prefix(root).map_err(|_| ERROR)?.to_str().ok_or(ERROR)?.replace('\\', "/");
                if !seen.contains(&relative) { return Err(ERROR.into()); }
            }
        }
        Ok(())
    }
    check_entries(root, root, &seen, 0, &mut 0)?;
    open_plain(&root.join("manifest.json"), true)?.sync_all().map_err(|_| ERROR)?;
    sync_directory(root)?;
    Ok(DurableSeal { format: "project-model-durable-seal-v1".into(), operation_id: operation_id.into(),
        profile_id: lease.profile_id.clone(), manifest_sha256: digest(&manifest_bytes), complete_sha256: digest(complete_bytes),
        durability: "fsync-and-directory-barrier".into(), can_activate: false })
}
#[tauri::command]
pub async fn project_model_seal_backup(webview: Webview, lease_id: String, operation_id: String) -> Result<DurableSeal, String> {
    let (lease, root) = operation_root(&webview, &lease_id, &operation_id).await?;
    let complete = read_bounded(&root, "complete.json", 4096)?;
    open_plain(&root.join("complete.json"), true)?.sync_all().map_err(|_| ERROR)?;
    let seal = verify_materials(&root, &lease, &operation_id, &complete)?;
    checked_session(&webview, Some(&lease_id), true).await?;
    let target = root.join("durable.json");
    if target.exists() {
        let existing: DurableSeal = serde_json::from_slice(&read_bounded(&root, "durable.json", 4096)?).map_err(|_| ERROR)?;
        if seal != existing { return Err(ERROR.into()); }
    } else {
        publish_synced(&target, &serde_json::to_vec(&seal).map_err(|_| ERROR)?)?;
    }
    checked_session(&webview, Some(&lease_id), true).await?;
    Ok(seal)
}
#[tauri::command]
pub async fn project_model_verify_backup_seal(webview: Webview, lease_id: String, operation_id: String) -> Result<DurableSeal, String> {
    let (lease, root) = operation_root(&webview, &lease_id, &operation_id).await?;
    let complete = read_bounded(&root, "complete.json", 4096)?;
    open_plain(&root.join("complete.json"), true)?.sync_all().map_err(|_| ERROR)?;
    let expected = verify_materials(&root, &lease, &operation_id, &complete)?;
    let actual: DurableSeal = serde_json::from_slice(&read_bounded(&root, "durable.json", 4096)?).map_err(|_| ERROR)?;
    if actual != expected { return Err(ERROR.into()); }
    checked_session(&webview, Some(&lease_id), true).await?;
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_and_reserved_device_names() {
        for path in ["../x", "/x", "a\\b", "a/./b", "CON.txt", "a/lpt1.json", "a/..", "a."] { assert!(!safe_path(path)); }
        for path in ["manifest.json", "records/projects-000001.json", "binary/1.bin"] { assert!(safe_path(path)); }
    }
    #[test]
    fn maintenance_page_cannot_navigate_to_business_or_remote_urls() {
        assert!(maintenance_url(&"http://project-model-maintenance.localhost/index.html".parse().unwrap()));
        for url in ["http://localhost:1420/", "tauri://localhost/index.html", "https://example.test/index.html",
            "http://project-model-maintenance.localhost/index.html?run=true",
            "http://project-model-maintenance.localhost:1234/index.html",
            "http://user@project-model-maintenance.localhost/index.html"] {
            assert!(!maintenance_url(&url.parse().unwrap()));
        }
    }
    #[test]
    fn marker_publication_is_exclusive_and_materials_remain_after_failure() {
        let root = std::env::temp_dir().join(format!("project-model-native-fixture-{}-{:?}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let target = root.join("complete.json");
        publish_synced(&target, b"first").unwrap();
        assert!(publish_synced(&target, b"second").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"first");
        // Tests intentionally retain fixture material on assertion failure.
        fs::remove_file(target).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test]
    fn seal_checks_actual_material_bytes_and_database_profile_identity() {
        let root = std::env::temp_dir().join(format!("project-model-seal-fixture-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let records = b"[]"; let pending = b"null";
        create_synced(&root.join("records.json"), records).unwrap();
        create_synced(&root.join("pending.json"), pending).unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "format":"project-model-backup-v1", "operationId":"fixture-operation", "createdAt":1,
            "databaseName":"ai-canvas-model-fixture-safe", "schemaVersion":27, "databaseStoreNames":["projects"],
            "stores":[{"name":"projects", "chunks":["records.json"]}],
            "localStorage":[{"key":"ai_canvas_pending_tasks","path":"pending.json"}],
            "files":[{"path":"records.json","kind":"records","bytes":records.len(),"sha256":digest(records)},
                {"path":"pending.json","kind":"localStorage","bytes":pending.len(),"sha256":digest(pending)}],
            "totalBytes":records.len()+pending.len()
        })).unwrap();
        create_synced(&root.join("manifest.json"), &manifest).unwrap();
        let complete = serde_json::to_vec(&serde_json::json!({"format":"project-model-backup-v1", "operationId":"fixture-operation", "manifestSha256":digest(&manifest)})).unwrap();
        let mut lease = MaintenanceLease { lease_id:"test".into(), profile_id:"safe".into(), mode:"isolated-fixture", cold_start:true, production_allowed:false };
        assert!(verify_materials(&root, &lease, "fixture-operation", &complete).is_ok());
        lease.profile_id = "different".into();
        assert!(verify_materials(&root, &lease, "fixture-operation", &complete).is_err());
        lease.profile_id = "safe".into();
        // v2 仅为同一隔离 profile 的真实 schema28；v1 和正式库不能借格式升级越界。
        for (format, schema, database, accepted) in [
            ("project-model-fixture-backup-v2", 28, "ai-canvas-model-fixture-safe", true),
            ("project-model-backup-v1", 28, "ai-canvas-model-fixture-safe", false),
            ("project-model-fixture-backup-v2", 27, "ai-canvas-model-fixture-safe", false),
            ("project-model-fixture-backup-v2", 28, "ai-canvas-db", false),
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
            value["format"] = serde_json::json!(format);
            value["schemaVersion"] = serde_json::json!(schema);
            value["databaseName"] = serde_json::json!(database);
            let bytes = serde_json::to_vec(&value).unwrap();
            fs::write(root.join("manifest.json"), &bytes).unwrap();
            let marker = serde_json::to_vec(&serde_json::json!({"format":format,
                "operationId":"fixture-operation", "manifestSha256":digest(&bytes)})).unwrap();
            assert_eq!(verify_materials(&root, &lease, "fixture-operation", &marker).is_ok(), accepted);
        }
        fs::write(root.join("manifest.json"), &manifest).unwrap();
        fs::write(root.join("records.json"), b"{}").unwrap();
        assert!(verify_materials(&root, &lease, "fixture-operation", &complete).is_err());
        for name in ["records.json", "pending.json", "manifest.json"] { fs::remove_file(root.join(name)).unwrap(); }
        fs::remove_dir(root).unwrap();
    }
}
