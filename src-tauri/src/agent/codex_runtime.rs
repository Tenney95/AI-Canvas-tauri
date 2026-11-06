//! Main-window-only registration, leases and receipts for the fixed Codex adviser.
use super::{codex_contract as contract, codex_process, codex_protocol};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use tauri::{ipc::Channel, AppHandle, Manager, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const MAX_RUNS: usize = 128;
const MAX_CONCURRENT_RUNS: usize = 2;
const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(windows)]
const SNAPSHOT_EXECUTABLE: &str = "codex.exe";
#[cfg(not(windows))]
const SNAPSHOT_EXECUTABLE: &str = "codex";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration { version: String, executable: PathBuf, digest: String, enabled: bool }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexRequest {
    provider_id: String,
    pub invocation_id: String,
    project_id: String,
    conversation_id: String,
    task_id: String,
    stage_id: String,
    run_revision: u64,
    pub model_id: String,
    expected_fingerprint: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_output_chars: usize,
    pub output_schema: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    pub usage_known: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProgress { pub invocation_id: String, pub phase: String, pub elapsed_ms: u64, pub output_chars: usize }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    provider_id: &'static str, registered: bool, enabled: bool, configured: bool,
    compatible: bool, available: bool, version: Option<String>, execution_fingerprint: Option<String>,
    active_runs: usize, capabilities: Value, models: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    invocation_id: String, status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_submitted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<CodexResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

struct RunRecord { cancellation: Arc<AtomicBool>, turn_submitted: Arc<AtomicBool>, collection: Collection, created: Instant }
#[derive(Default)]
struct RuntimeData { generation: u64, runs: HashMap<String, RunRecord> }
#[derive(Default)]
pub struct CodexRuntimeState { data: Mutex<RuntimeData>, registration: Mutex<()> }

fn caller(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview).map_err(|_| "CODEX_CALLER_REJECTED")?;
    if webview.label() != "main" { return Err("CODEX_CALLER_REJECTED".into()); }
    Ok(())
}

fn link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { false }
}

fn plain_directory(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_dir() || link(&metadata) { return Err("CODEX_PRIVATE_PATH_INVALID".into()); }
    } else { fs::create_dir(path).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?; }
    Ok(())
}

fn private_root(app: &AppHandle) -> Result<PathBuf, String> {
    let parent = crate::agent_package::agent_private_dir(app).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
    if let Some(app_data) = parent.parent() {
        fs::create_dir_all(app_data).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
    }
    plain_directory(&parent)?;
    let root = parent.join("external-codex"); plain_directory(&root)?;
    Ok(root)
}

fn checked_file(path: &Path, max_bytes: u64) -> Result<File, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "CODEX_FILE_UNAVAILABLE")?;
    if !metadata.is_file() || link(&metadata) || metadata.len() > max_bytes { return Err("CODEX_FILE_REJECTED".into()); }
    File::open(path).map_err(|_| "CODEX_FILE_UNAVAILABLE".into())
}

fn registration(app: &AppHandle) -> Result<Option<Registration>, String> {
    let root = private_root(app)?;
    let path = root.join("registration.json");
    let backup = root.join("registration.backup");
    let recovering = !path.exists();
    let source = if path.exists() { path } else if backup.exists() { backup } else { return Ok(None); };
    let mut text = String::new(); checked_file(&source, 32 * 1024)?.read_to_string(&mut text).map_err(|_| "CODEX_REGISTRATION_CORRUPT")?;
    let mut value: Registration = serde_json::from_str(&text).map_err(|_| "CODEX_REGISTRATION_CORRUPT")?;
    if value.version != contract::VERSION || value.digest.len() != 64 || !value.digest.bytes().all(|c| c.is_ascii_hexdigit()) || !value.executable.is_absolute() {
        return Err("CODEX_REGISTRATION_CORRUPT".into());
    }
    if recovering { value.enabled=false; }
    Ok(Some(value))
}

fn persist_registration(app: &AppHandle, value: &Registration) -> Result<(), String> {
    let root = private_root(app)?;
    let target = root.join("registration.json");
    let staging = root.join("registration.staging");
    let backup = root.join("registration.backup");
    if staging.exists() { checked_file(&staging, 32 * 1024)?; fs::remove_file(&staging).map_err(|_| "CODEX_REGISTRATION_SAVE_FAILED")?; }
    let bytes = serde_json::to_vec(value).map_err(|_| "CODEX_REGISTRATION_SAVE_FAILED")?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&staging).map_err(|_| "CODEX_REGISTRATION_SAVE_FAILED")?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "CODEX_REGISTRATION_SAVE_FAILED")?;
    if backup.exists() { checked_file(&backup, 32 * 1024)?; fs::remove_file(&backup).map_err(|_| "CODEX_REGISTRATION_SAVE_FAILED")?; }
    if target.exists() { checked_file(&target, 32 * 1024)?; fs::rename(&target, &backup).map_err(|_| "CODEX_REGISTRATION_SAVE_FAILED")?; }
    if fs::rename(&staging, &target).is_err() {
        if backup.exists() { let _ = fs::rename(&backup, &target); }
        return Err("CODEX_REGISTRATION_SAVE_FAILED".into());
    }
    if backup.exists() { let _ = fs::remove_file(backup); }
    Ok(())
}

fn checked_binary_file(path: &Path) -> Result<File, String> {
    // Reject every selected path component before canonicalization; no script or shell wrapper.
    let mut cursor = Some(path);
    while let Some(current) = cursor {
        let metadata = fs::symlink_metadata(current).map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
        if link(&metadata) { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
        cursor = current.parent();
    }
    let name = path.file_name().and_then(|v| v.to_str()).unwrap_or_default();
    #[cfg(windows)]
    if !name.eq_ignore_ascii_case("codex.exe") { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
    #[cfg(not(windows))]
    if name != "codex" { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
    let mut options = OpenOptions::new(); options.read(true);
    // Retain the opened identity while copying. Windows refuses concurrent
    // writers/replacement and opens a reparse point itself rather than its target.
    #[cfg(windows)]
    options.share_mode(0x00000001).custom_flags(0x00200000);
    let mut file = options.open(path).map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
    let metadata = file.metadata().map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
    if !metadata.is_file() || link(&metadata) || metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err("CODEX_EXECUTABLE_REJECTED".into());
    }
    let mut magic = [0_u8; 4]; file.read_exact(&mut magic).map_err(|_| "CODEX_EXECUTABLE_REJECTED")?;
    #[cfg(windows)] let native = magic.starts_with(b"MZ");
    #[cfg(target_os = "linux")] let native = magic == [0x7f, b'E', b'L', b'F'];
    #[cfg(target_os = "macos")] let native = matches!(magic, [0xcf,0xfa,0xed,0xfe] | [0xfe,0xed,0xfa,0xcf] | [0xca,0xfe,0xba,0xbe] | [0xca,0xfe,0xba,0xbf]);
    #[cfg(not(any(windows, target_os="linux", target_os="macos")))] let native = false;
    if !native { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
    Ok(file)
}

fn copy_executable(source: &mut impl Read, target: &mut impl Write, cancellation: &AtomicBool, max_bytes: u64) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        if cancellation.load(Ordering::Acquire) { return Err("CODEX_CANCELLED".into()); }
        let count = source.read(&mut buffer).map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
        if cancellation.load(Ordering::Acquire) { return Err("CODEX_CANCELLED".into()); }
        if count == 0 { break; }
        total = total.checked_add(count as u64).ok_or("CODEX_EXECUTABLE_REJECTED")?;
        if total > max_bytes { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
        target.write_all(&buffer[..count]).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn binary_digest(path: &Path) -> Result<String, String> {
    let mut file = checked_binary_file(path)?;
    copy_executable(&mut file, &mut std::io::sink(), &AtomicBool::new(false), MAX_EXECUTABLE_BYTES)
}

fn fingerprint(registration: &Registration, key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(contract::VERSION); digest.update([0]); digest.update(&registration.digest); digest.update([0]); digest.update(key);
    format!("{:x}", digest.finalize())
}

fn secret(app: &AppHandle) -> Result<Option<String>, String> {
    crate::secret_store::read_internal_secret_sync(app, contract::SECRET_KEY).map_err(|_| "CODEX_SECRET_UNAVAILABLE".into())
}

fn status(app: &AppHandle) -> RuntimeStatus {
    let mut result = RuntimeStatus { provider_id: contract::PROVIDER_ID, registered:false, enabled:false, configured:false,
        compatible:false, available:false, version:None, execution_fingerprint:None, active_runs:0,
        capabilities:contract::capabilities(), models:contract::model_list(), error_code:None };
    if let Ok(data) = app.state::<CodexRuntimeState>().data.lock() {
        result.active_runs = data.runs.values().filter(|run| run.collection.status == "running").count();
    }
    let key = match secret(app) { Ok(value) => value.filter(|v| !v.trim().is_empty()), Err(error) => { result.error_code=Some(error); None } };
    result.configured = key.is_some();
    match registration(app) {
        Ok(Some(value)) => {
            result.registered=true; result.enabled=value.enabled; result.version=Some(value.version.clone());
            result.compatible = binary_digest(&value.executable).is_ok_and(|digest| digest == value.digest);
            if !result.compatible { result.error_code=Some("CODEX_IDENTITY_CHANGED".into()); }
            if let Some(key) = key { result.execution_fingerprint=Some(fingerprint(&value, &key)); }
        }
        Ok(None) => { result.error_code.get_or_insert("CODEX_NOT_REGISTERED".into()); },
        Err(error) => { result.error_code=Some(error); },
    }
    if result.error_code.is_none() && !result.configured { result.error_code=Some("CODEX_KEY_NOT_CONFIGURED".into()); }
    if result.error_code.is_none() && !result.enabled { result.error_code=Some("CODEX_DISABLED".into()); }
    result.available=result.registered && result.enabled && result.configured && result.compatible && result.error_code.is_none();
    result
}

fn cancel_all(app: &AppHandle) {
    if let Ok(mut data) = app.state::<CodexRuntimeState>().data.lock() {
        data.generation=data.generation.wrapping_add(1);
        for run in data.runs.values() { run.cancellation.store(true, Ordering::Release); }
    }
}

pub fn shutdown(app: &AppHandle) {
    cancel_all(app);
    let deadline=Instant::now()+Duration::from_secs(2);
    while Instant::now()<deadline {
        let active=app.state::<CodexRuntimeState>().data.lock().map(|data|
            data.runs.values().any(|run|run.collection.status=="running")).unwrap_or(false);
        if !active {break;}
        std::thread::sleep(Duration::from_millis(10));
    }
}

struct ExecutableSnapshot { executable: PathBuf, _identity: File }

struct Workspace { root: PathBuf, parent: PathBuf, home: PathBuf, cwd: PathBuf }
impl Workspace {
    fn create(app: &AppHandle) -> Result<Self,String> {
        let parent=private_root(app)?.join("runs"); plain_directory(&parent)?;
        let nonce=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?.as_nanos();
        let parent=parent.canonicalize().map_err(|_|"CODEX_PRIVATE_PATH_INVALID")?;
        let root=parent.join(format!("run-{}-{nonce}",std::process::id()));
        #[cfg(not(unix))]
        fs::create_dir(&root).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        #[cfg(unix)]
        fs::DirBuilder::new().mode(0o700).create(&root).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        let workspace=Self {home:root.join("home"),cwd:root.join("work"),root,parent};
        plain_directory(&workspace.home)?;plain_directory(&workspace.cwd)?;
        #[cfg(unix)]
        for directory in [&workspace.root, &workspace.home, &workspace.cwd] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        }
        Ok(workspace)
    }
    fn snapshot_executable(&self, source: &mut File, digest: &str, cancellation: &AtomicBool) -> Result<ExecutableSnapshot, String> {
        if cancellation.load(Ordering::Acquire) { return Err("CODEX_CANCELLED".into()); }
        if self.root.parent() != Some(self.parent.as_path())
            || !self.parent.canonicalize().is_ok_and(|path| path == self.parent)
            || !self.root.canonicalize().is_ok_and(|path| path == self.root)
            || !fs::symlink_metadata(&self.root).is_ok_and(|metadata| metadata.is_dir() && !link(&metadata)) {
            return Err("CODEX_PRIVATE_PATH_INVALID".into());
        }
        let executable = self.root.join(SNAPSHOT_EXECUTABLE);
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(windows)]
        options.share_mode(0);
        #[cfg(unix)]
        options.mode(0o600);
        let mut snapshot = options.open(&executable).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        source.seek(SeekFrom::Start(0)).map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
        if copy_executable(source, &mut snapshot, cancellation, MAX_EXECUTABLE_BYTES)? != digest {
            return Err("CODEX_IDENTITY_CHANGED".into());
        }
        snapshot.sync_all().map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        #[cfg(unix)]
        snapshot.set_permissions(fs::Permissions::from_mode(0o500)).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        // Close the writable handle before loading an executable image. The new
        // Windows read lease denies writes and deletion through process exit.
        drop(snapshot);
        let mut identity = checked_binary_file(&executable)?;
        // Verify bytes read back from the actual private snapshot, never reopen
        // the installed program by path to decide which bytes are executed.
        if copy_executable(&mut identity, &mut std::io::sink(), cancellation, MAX_EXECUTABLE_BYTES)? != digest {
            return Err("CODEX_IDENTITY_CHANGED".into());
        }
        Ok(ExecutableSnapshot { executable, _identity: identity })
    }
    fn prepare(&self, model: &str) -> Result<(),String> {
        let catalog=self.home.join("models.json");
        let bytes=serde_json::to_vec(&contract::model_catalog(model)?).map_err(|_| "CODEX_CONFIGURATION_REJECTED")?;
        for (path,bytes) in [(catalog.clone(),bytes),(self.home.join("config.toml"),contract::configuration(&catalog)?.into_bytes())] {
            let mut file=OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
            file.write_all(&bytes).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        }
        Ok(())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        // This path is created above, never supplied by Renderer. Validate before recursive cleanup.
        if self.root.parent()==Some(self.parent.as_path())
            && self.parent.file_name().is_some_and(|name|name=="runs")
            && self.parent.canonicalize().is_ok_and(|path|path==self.parent)
            && self.root.canonicalize().is_ok_and(|path|path.parent()==Some(self.parent.as_path())&&path==self.root)
            && fs::symlink_metadata(&self.root).is_ok_and(|m|m.is_dir()&&!link(&m)) {
            let _=fs::remove_dir_all(&self.root);
        }
    }
}

fn valid_id(value:&str)->bool { !value.is_empty()&&value.len()<=200&&value.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'-'|b'_'|b'.'|b':')) }
fn validate_request(request:&CodexRequest)->Result<(),String> {
    if request.provider_id!=contract::PROVIDER_ID || ![&request.invocation_id,&request.project_id,&request.conversation_id,&request.task_id,&request.stage_id].iter().all(|v|valid_id(v))
        || request.run_revision==0 || request.run_revision>9_007_199_254_740_991 || !contract::MODELS.contains(&request.model_id.as_str())
        || !(2000..=64000).contains(&request.max_output_chars) || request.expected_fingerprint.len()!=64
        || request.system_prompt.len()+request.user_prompt.len()>contract::MAX_PROMPT_BYTES || request.user_prompt.trim().is_empty()
    {return Err("CODEX_INPUT_REJECTED".into());}
    if let Some(schema)=&request.output_schema {
        if !schema.is_object()||serde_json::to_vec(schema).map_err(|_|"CODEX_SCHEMA_REJECTED")?.len()>contract::MAX_SCHEMA_BYTES||!safe_schema(schema,0) {return Err("CODEX_SCHEMA_REJECTED".into());}
    }
    Ok(())
}

fn safe_schema(value:&Value,depth:usize)->bool {
    if depth>16{return false;}
    match value {
        Value::Object(fields)=>fields.len()<=128&&fields.iter().all(|(key,value)|
            (key!="$ref"||value.as_str().is_some_and(|v|v.starts_with('#')))&&safe_schema(value,depth+1)),
        Value::Array(items)=>items.len()<=128&&items.iter().all(|v|safe_schema(v,depth+1)),
        _=>true,
    }
}

#[tauri::command]
pub async fn codex_runtime_status(app:AppHandle,webview:Webview)->Result<RuntimeStatus,String> {
    caller(&webview)?;
    tauri::async_runtime::spawn_blocking(move||status(&app)).await.map_err(|_|"CODEX_STATE_UNAVAILABLE".into())
}

#[tauri::command]
pub async fn codex_runtime_register(app:AppHandle,webview:Webview)->Result<RuntimeStatus,String> {
    caller(&webview)?;
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<CodexRuntimeState>();let _lock=state.registration.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
        let selected=app.dialog().file().set_title("登记本机 Codex 0.167.0").blocking_pick_file().ok_or("CODEX_REGISTRATION_CANCELLED")?;
        let selected=selected.into_path().map_err(|_|"CODEX_EXECUTABLE_REJECTED")?;
        let digest=binary_digest(&selected)?;
        let executable=selected.canonicalize().map_err(|_|"CODEX_EXECUTABLE_UNAVAILABLE")?;
        let prompt=format!("程序：{}\nSHA-256：{}\n\n仅登记你信任的 Codex 原生程序。它拥有当前用户的进程权限；摘要登记不构成系统沙箱。\n\n登记后将执行固定版本查询。启用后，所选任务材料会发往 OpenAI API 并可能计费；不复用现有 Codex 登录或 ChatGPT 订阅额度。",executable.display(),digest);
        let approved=app.dialog().message(prompt)
            .title("信任并登记此本机程序？").kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("信任并查询版本".into(),"取消".into())).blocking_show();
        if !approved{return Err("CODEX_REGISTRATION_CANCELLED".into());}
        let workspace=Workspace::create(&app)?;
        let mut source=checked_binary_file(&executable)?;
        let snapshot=workspace.snapshot_executable(&mut source,&digest,&AtomicBool::new(false))?;
        drop(source);
        codex_process::probe_version(&snapshot.executable,&workspace.home,&workspace.cwd)?;
        if binary_digest(&executable)?!=digest{return Err("CODEX_IDENTITY_CHANGED".into());}
        cancel_all(&app);
        persist_registration(&app,&Registration {version:contract::VERSION.into(),executable,digest,enabled:false})?;
        Ok(status(&app))
    }).await.map_err(|_|"CODEX_STATE_UNAVAILABLE".to_string())?
}

#[tauri::command]
pub async fn codex_runtime_configure(app:AppHandle,webview:Webview,enabled:bool)->Result<RuntimeStatus,String> {
    caller(&webview)?;
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<CodexRuntimeState>();let _lock=state.registration.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
        let mut value=registration(&app)?.ok_or("CODEX_NOT_REGISTERED")?;
        if enabled && (binary_digest(&value.executable)?!=value.digest || secret(&app)?.is_none_or(|v|v.trim().is_empty())) {return Err("CODEX_NOT_AVAILABLE".into());}
        cancel_all(&app);value.enabled=enabled;persist_registration(&app,&value)?;Ok(status(&app))
    }).await.map_err(|_|"CODEX_STATE_UNAVAILABLE".to_string())?
}

#[tauri::command]
pub async fn codex_runtime_remove(app:AppHandle,webview:Webview)->Result<RuntimeStatus,String> {
    caller(&webview)?;
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<CodexRuntimeState>();let _lock=state.registration.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
        cancel_all(&app);
        for name in ["registration.json","registration.backup","registration.staging"] {
            let path=private_root(&app)?.join(name);if path.exists(){checked_file(&path,32*1024)?;fs::remove_file(path).map_err(|_|"CODEX_REGISTRATION_SAVE_FAILED")?;}
        }
        Ok(status(&app))
    }).await.map_err(|_|"CODEX_STATE_UNAVAILABLE".to_string())?
}

#[tauri::command]
pub async fn codex_runtime_start(app:AppHandle,webview:Webview,request:CodexRequest,on_progress:Channel<CodexProgress>)->Result<CodexResult,String> {
    caller(&webview)?;validate_request(&request)?;
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<CodexRuntimeState>();
        let (registration,mut source,key,cancellation,turn_submitted,generation)={
            let _lock=state.registration.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
            let registration=registration(&app)?.filter(|v|v.enabled).ok_or("CODEX_NOT_AVAILABLE")?;
            let key=secret(&app)?.filter(|v|!v.trim().is_empty()).ok_or("CODEX_KEY_NOT_CONFIGURED")?;
            if fingerprint(&registration,&key)!=request.expected_fingerprint {return Err("CODEX_IDENTITY_CHANGED".into());}
            let source=checked_binary_file(&registration.executable)?;
            let mut data=state.data.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
            if data.runs.contains_key(&request.invocation_id){return Err("CODEX_INVOCATION_ALREADY_STARTED".into());}
            if data.runs.len()>=MAX_RUNS{return Err("CODEX_SESSION_LIMIT".into());}
            if data.runs.values().filter(|v|v.collection.status=="running").count()>=MAX_CONCURRENT_RUNS {return Err("CODEX_CONCURRENCY_LIMIT".into());}
            let cancellation=Arc::new(AtomicBool::new(false));let turn_submitted=Arc::new(AtomicBool::new(false));let generation=data.generation;
            data.runs.insert(request.invocation_id.clone(),RunRecord {cancellation:Arc::clone(&cancellation),turn_submitted:Arc::clone(&turn_submitted),created:Instant::now(),collection:Collection {
                invocation_id:request.invocation_id.clone(),status:"running".into(),turn_submitted:Some(false),result:None,error_code:None}});
            (registration,source,key,cancellation,turn_submitted,generation)
        };
        let mut outcome:Result<CodexResult,String>=(||{
            let workspace=Workspace::create(&app)?;
            let snapshot=workspace.snapshot_executable(&mut source,&registration.digest,&cancellation)?;
            drop(source);
            workspace.prepare(&request.model_id)?;
            let outcome=codex_protocol::execute(&snapshot.executable,&workspace.home,&workspace.cwd,&request,&key,Arc::clone(&cancellation),Arc::clone(&turn_submitted),&on_progress);
            // Keep the checked snapshot handle through execution. CodexProcess
            // keeps its own lease if child reaping has to finish asynchronously.
            // Workspace owns cleanup of the per-invocation snapshot.
            drop(snapshot);
            outcome
        })();
        let _registration_lock=state.registration.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
        if outcome.is_ok() && registration_from_lease(&app,&request.expected_fingerprint,generation).is_err() {
            outcome=Err("CODEX_IDENTITY_CHANGED".into());
        }
        let mut data=state.data.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
        if cancellation.load(Ordering::Acquire) {outcome=Err("CODEX_CANCELLED".into());}
        if let Some(run)=data.runs.get_mut(&request.invocation_id){
            run.collection.turn_submitted=Some(turn_submitted.load(Ordering::Acquire));
            match &outcome {
                Ok(result)=>{run.collection.status="completed".into();run.collection.result=Some(result.clone());},
                Err(error)=>{run.collection.status=if error=="CODEX_CANCELLED"{"cancelled"}else{"failed"}.into();run.collection.error_code=Some(error.clone());}
            }
            let _=on_progress.send(CodexProgress {invocation_id:request.invocation_id.clone(),phase:run.collection.status.clone(),
                elapsed_ms:run.created.elapsed().as_millis().min(u64::MAX as u128)as u64,
                output_chars:run.collection.result.as_ref().map_or(0,|v|v.text.encode_utf16().count())});
        }
        outcome
    }).await.map_err(|_|"CODEX_RESULT_UNKNOWN".to_string())?
}

fn registration_from_lease(app:&AppHandle,expected:&str,generation:u64)->Result<String,String> {
    // Caller holds the registration lock until the final receipt has been committed.
    let state=app.state::<CodexRuntimeState>();
    let value=registration(app)?.filter(|v|v.enabled).ok_or("CODEX_IDENTITY_CHANGED")?;
    let key=secret(app)?.ok_or("CODEX_IDENTITY_CHANGED")?;
    if fingerprint(&value,&key)!=expected||binary_digest(&value.executable)?!=value.digest
        ||state.data.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?.generation!=generation{return Err("CODEX_IDENTITY_CHANGED".into());}
    Ok(value.digest)
}

#[tauri::command]
pub fn codex_runtime_cancel(app:AppHandle,webview:Webview,invocation_id:String)->Result<bool,String> {
    caller(&webview)?;if !valid_id(&invocation_id){return Err("CODEX_INPUT_REJECTED".into());}
    let state=app.state::<CodexRuntimeState>();let mut data=state.data.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
    if let Some(run)=data.runs.get(&invocation_id){run.cancellation.store(true,Ordering::Release);return Ok(true);}
    // Cancellation may reach native before the async start command is scheduled.
    if data.runs.len()>=MAX_RUNS{return Err("CODEX_SESSION_LIMIT".into());}
    data.runs.insert(invocation_id.clone(),RunRecord {cancellation:Arc::new(AtomicBool::new(true)),turn_submitted:Arc::new(AtomicBool::new(false)),created:Instant::now(),collection:Collection {
        invocation_id,status:"cancelled".into(),turn_submitted:Some(false),result:None,error_code:Some("CODEX_CANCELLED".into())}});
    Ok(true)
}

#[tauri::command]
pub fn codex_runtime_collect(app:AppHandle,webview:Webview,invocation_id:String)->Result<Collection,String> {
    caller(&webview)?;if !valid_id(&invocation_id){return Err("CODEX_INPUT_REJECTED".into());}
    let state=app.state::<CodexRuntimeState>();let mut data=state.data.lock().map_err(|_|"CODEX_STATE_UNAVAILABLE")?;
    if let Some(run)=data.runs.get_mut(&invocation_id){
        run.collection.turn_submitted=Some(run.turn_submitted.load(Ordering::Acquire));
        if run.created.elapsed()>Duration::from_secs(600)&&run.collection.status!="running" {
            run.collection.result=None;run.collection.status="unknown".into();run.collection.error_code=Some("CODEX_RECEIPT_EXPIRED".into());
        }
        return Ok(run.collection.clone());
    }
    Ok(Collection {invocation_id,status:"unknown".into(),turn_submitted:None,result:None,error_code:Some("CODEX_RESULT_UNKNOWN".into())})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn executable_copy_hashes_the_written_bytes_and_obeys_cancel_and_limit() {
        let bytes = b"native executable snapshot";
        let expected = format!("{:x}", Sha256::digest(bytes));
        let mut copied = Vec::new();
        let active = AtomicBool::new(false);
        assert_eq!(copy_executable(&mut &bytes[..], &mut copied, &active, bytes.len() as u64).unwrap(), expected);
        assert_eq!(copied.as_slice(), bytes.as_slice());
        assert_eq!(copy_executable(&mut &copied[..], &mut std::io::sink(), &active, bytes.len() as u64).unwrap(), expected);
        let mut rejected = Vec::new();
        assert_eq!(copy_executable(&mut &bytes[..], &mut rejected, &active, 3).unwrap_err(), "CODEX_EXECUTABLE_REJECTED");
        assert!(rejected.is_empty());
        assert_eq!(copy_executable(&mut &bytes[..], &mut rejected, &AtomicBool::new(true), bytes.len() as u64).unwrap_err(), "CODEX_CANCELLED");
        assert!(rejected.is_empty());
    }

    #[test]
    fn requests_cannot_add_process_parameters() {
        let request=serde_json::json!({"providerId":"codex-app-server","invocationId":"run1","projectId":"p","conversationId":"c","taskId":"t","stageId":"s",
            "runRevision":1,"modelId":"gpt-6.1-sol","expectedFingerprint":"a".repeat(64),"systemPrompt":"role","userPrompt":"task","maxOutputChars":2000});
        assert!(validate_request(&serde_json::from_value(request.clone()).unwrap()).is_ok());
        let mut unsafe_request=request;unsafe_request["executable"]=Value::String("other".into());
        assert!(serde_json::from_value::<CodexRequest>(unsafe_request).is_err());
        assert!(!valid_id("../other"));
    }

    #[test]
    fn missing_receipt_does_not_claim_that_a_turn_was_not_submitted() {
        let unknown=Collection {invocation_id:"unknown".into(),status:"unknown".into(),turn_submitted:None,result:None,error_code:None};
        assert!(serde_json::to_value(unknown).unwrap().get("turnSubmitted").is_none());
        let checked=Collection {invocation_id:"checked".into(),status:"failed".into(),turn_submitted:Some(false),result:None,error_code:None};
        assert_eq!(serde_json::to_value(checked).unwrap()["turnSubmitted"],false);
    }
}
