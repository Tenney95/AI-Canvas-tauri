//! ComfyUI 模型重复扫描。文件内容散列复用 Czkawka Core；授权、会话和结果租约由宿主管理。
//! 只读取原生安装授权或本窗口显式选择的模型目录，不启用 Czkawka 的配置、缓存、日志或删除工具。
use czkawka_core::{
    common::model::HashType,
    tools::duplicate::{hash_calculation, DuplicateEntry},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::RandomState, BTreeMap, HashMap, HashSet},
    fs::{self, File, Metadata},
    hash::{BuildHasher, Hasher},
    path::{Component, Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{ipc::Channel, Manager, Webview};
use tauri_plugin_dialog::DialogExt;

const MIN_MODEL_SIZE: u64 = 1024 * 1024;
const MAX_CANDIDATES: usize = 20_000;
const MAX_VISITED_ENTRIES: usize = 5_000_000;
const MAX_DIRECTORIES: usize = 250_000;
pub(super) const MAX_MODEL_SCAN_DEPTH: usize = 64;
const MAX_SELECTED_ROOTS: usize = 16;
const MAX_RESULT_GROUPS: usize = 2_000;
const MAX_TARGETS: usize = 256;
const MAX_SKIPPED_DETAILS: usize = 200;
const ENGINE: &str = "Czkawka Core 10.0.0 · BLAKE3";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelScanScope {
    Models,
    #[default]
    ModelsAndPlugins,
    Folder,
    Disk,
}

#[derive(Clone)]
pub(super) struct ModelScanRoot {
    pub id: String,
    pub root: PathBuf,
    pub session_id: String,
    pub scope: ModelScanScope,
    root_identity: file_id::FileId,
}

impl ModelScanRoot {
    pub(super) fn traversal_roots(&self) -> Vec<PathBuf> {
        match self.scope {
            ModelScanScope::Models => vec![self.root.join("models")],
            ModelScanScope::ModelsAndPlugins => vec![self.root.join("models"), self.root.join("custom_nodes")],
            ModelScanScope::Folder | ModelScanScope::Disk => vec![self.root.clone()],
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModelScanRoot { root_id: String, display_path: String, kind: ModelScanScope }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateModelFile {
    id: String,
    relative_path: String,
    already_shared: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateModelGroup {
    id: String,
    size: u64,
    hash: String,
    reclaimable_bytes: u64,
    files: Vec<DuplicateModelFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateModelScan {
    scan_id: String,
    engine: &'static str,
    groups: Vec<DuplicateModelGroup>,
    scanned_files: usize,
    skipped_files: usize,
    skipped_entries: Vec<SkippedModelEntry>,
    omitted_skipped_entries: usize,
    warnings: Vec<String>,
}

/// 扫描结果只显示授权根下的相对名称，不携带链接目标或原生错误正文。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedModelEntry {
    relative_path: String,
    reason: String,
}

#[derive(Default)]
struct SkippedModels {
    total: usize,
    entries: Vec<SkippedModelEntry>,
}

impl SkippedModels {
    fn record(&mut self, root: &Path, path: &Path, reason: &'static str) {
        self.total = self.total.saturating_add(1);
        if self.entries.len() >= MAX_SKIPPED_DETAILS { return; }
        // 无法安全显示的文件名或根以外路径只能显示占位，不将原始路径放入结果。
        let relative_path = path.strip_prefix(root).ok().filter(|relative| relative.components().all(|part| matches!(part, Component::Normal(_))))
            .and_then(Path::to_str).filter(|value| value.len() <= 4096 && !value.chars().any(char::is_control))
            .map(|value| if value.is_empty() { ".".into() } else { value.replace('\\', "/") })
            .unwrap_or_else(|| "（无法安全显示的条目）".into());
        self.entries.push(SkippedModelEntry { relative_path, reason: reason.into() });
    }

    fn omitted(&self) -> usize { self.total.saturating_sub(self.entries.len()) }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FileIdentitySnapshot {
    pub identity: file_id::FileId,
    pub modified: SystemTime,
    pub size: u64,
    pub link_count: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ScannedModelFile {
    pub id: String,
    pub path: PathBuf,
    pub relative_path: String,
    pub identity: file_id::FileId,
    pub modified: SystemTime,
    pub size: u64,
    pub link_count: u64,
}

impl ScannedModelFile {
    fn fingerprint(&self) -> FileIdentitySnapshot {
        FileIdentitySnapshot {
            identity: self.identity, modified: self.modified, size: self.size,
            link_count: self.link_count,
        }
    }
}

struct NativeGroup { hash: String, size: u64, files: Vec<ScannedModelFile> }
struct NativeSnapshot { scan_id: String, scan_root: ModelScanRoot, groups: HashMap<String, NativeGroup> }
struct ActiveScan { scan_id: String, source_root: PathBuf, stop: Arc<AtomicBool> }

#[derive(Default)]
struct ScanRuntime { active: Option<ActiveScan>, snapshot: Option<NativeSnapshot>, selected_roots: HashMap<String, ModelScanRoot> }

/// 原生内存保存路径和真实文件身份。Renderer 只拿到不透明 ID 与相对路径，不是授权来源。
#[derive(Default)]
pub struct ModelDedupeState(Mutex<ScanRuntime>);

pub(super) struct ResolvedDuplicateSelection {
    pub scan_root: ModelScanRoot,
    pub keeper: ScannedModelFile,
    pub targets: Vec<ScannedModelFile>,
    pub hash: String,
    pub size: u64,
}

/// 只接收原生扫描结果 ID；链接类型由写入层单独解释。
pub(super) struct DuplicateSelectionRequest {
    pub group_id: String,
    pub keeper_id: String,
    pub target_ids: Vec<String>,
}

/// 不作为权限令牌；真正权限始终由窗口、当前管理会话、安装授权及文件身份共同确定。
pub(super) fn opaque_id(prefix: &str) -> String {
    let mut left = RandomState::new().build_hasher();
    let mut right = RandomState::new().build_hasher();
    left.write(prefix.as_bytes());
    right.write(prefix.as_bytes());
    format!("{prefix}-{:016x}{:016x}", left.finish(), right.finish())
}

pub(super) fn invalidate_model_scans(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ModelDedupeState>() {
        if let Ok(mut runtime) = state.0.lock() {
            if let Some(active) = runtime.active.take() { active.stop.store(true, Ordering::Release); }
            runtime.snapshot = None;
        }
    }
}

/// 仅管理窗口生命周期撤销目录用途授权；普通扫描取消不撤销，避免隐藏待恢复记录。
pub(super) fn revoke_model_scan_roots(app: &tauri::AppHandle) {
    invalidate_model_scans(app);
    if let Some(state) = app.try_state::<ModelDedupeState>() {
        if let Ok(mut runtime) = state.0.lock() { runtime.selected_roots.clear(); }
    }
}

fn new_scan_root(app: &tauri::AppHandle, root: PathBuf, scope: ModelScanScope, id: String) -> Result<ModelScanRoot, String> {
    let root = crate::path_policy::authorize_model_scan_directory_with_roots(app, &root, &[root.clone()])?;
    let root_identity = file_id::get_file_id(&root).map_err(|_| "无法确认扫描目录身份")?;
    Ok(ModelScanRoot { id, root, session_id: super::management::management_session_id(app)?, scope, root_identity })
}

pub(super) fn verify_model_scan_root(app: &tauri::AppHandle, context: &ModelScanRoot) -> Result<(), String> {
    if super::management::management_session_id(app)? != context.session_id {
        return Err("扫描目录授权已随管理窗口失效，请重新选择".into());
    }
    match context.scope {
        ModelScanScope::Models | ModelScanScope::ModelsAndPlugins => {
            if super::management::management_source_root(app)? != context.root { return Err("ComfyUI 安装目录已变化".into()); }
        }
        ModelScanScope::Folder | ModelScanScope::Disk => {
            let state = app.state::<ModelDedupeState>();
            let runtime = state.0.lock().map_err(|_| "扫描目录授权不可用")?;
            if !runtime.selected_roots.get(&context.id).is_some_and(|saved| saved.root == context.root
                && saved.session_id == context.session_id && saved.scope == context.scope && saved.root_identity == context.root_identity)
            { return Err("扫描目录未获当前原生会话授权，请重新选择".into()); }
        }
    }
    authorize_plain_model_directory(app, &context.root, &context.root)?;
    if file_id::get_file_id(&context.root).ok() != Some(context.root_identity) {
        return Err("扫描目录身份已变化，请重新选择目录并扫描".into());
    }
    Ok(())
}

pub(super) fn authorized_model_scan_roots(app: &tauri::AppHandle) -> Result<Vec<ModelScanRoot>, String> {
    let installation = super::management::management_source_root(app)?;
    let mut roots = vec![new_scan_root(app, installation, ModelScanScope::ModelsAndPlugins, "installation".into())?];
    let selected = {
        let state = app.state::<ModelDedupeState>();
        let runtime = state.0.lock().map_err(|_| "扫描目录授权不可用")?;
        runtime.selected_roots.values().cloned().collect::<Vec<_>>()
    };
    for root in selected {
        verify_model_scan_root(app, &root)?;
        roots.push(root);
    }
    Ok(roots)
}

fn resolve_model_scan_root(webview: &Webview, app: &tauri::AppHandle, scope: ModelScanScope, root_id: Option<&str>) -> Result<ModelScanRoot, String> {
    let installation = super::management::management_root(webview, app)?;
    match scope {
        ModelScanScope::Models | ModelScanScope::ModelsAndPlugins => {
            if root_id.is_some() { return Err("安装目录扫描不接受外部目录标识".into()); }
            new_scan_root(app, installation, scope, "installation".into())
        }
        ModelScanScope::Folder | ModelScanScope::Disk => {
            let root_id = root_id.filter(|id| id.len() <= 96).ok_or("请先选择扫描目录或磁盘")?;
            let context = {
                let state = app.state::<ModelDedupeState>();
                let runtime = state.0.lock().map_err(|_| "扫描目录授权不可用")?;
                runtime.selected_roots.get(root_id).cloned().ok_or("扫描目录授权已失效，请重新选择")?
            };
            if context.scope != scope { return Err("扫描范围与已选择目录不一致，请重新选择".into()); }
            verify_model_scan_root(app, &context)?;
            Ok(context)
        }
    }
}

#[cfg(windows)]
fn is_disk_root(path: &Path) -> bool {
    use std::path::Prefix;
    let mut parts = path.components();
    matches!(parts.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        && matches!(parts.next(), Some(Component::RootDir)) && parts.next().is_none()
}
#[cfg(not(windows))]
fn is_disk_root(path: &Path) -> bool { path == Path::new("/") }

#[tauri::command]
pub async fn choose_comfyui_model_scan_root(webview: Webview, app: tauri::AppHandle, kind: ModelScanScope) -> Result<Option<SelectedModelScanRoot>, String> {
    super::management::management_root(&webview, &app)?;
    if !matches!(kind, ModelScanScope::Folder | ModelScanScope::Disk) { return Err("请选择文件夹或磁盘扫描范围".into()); }
    let _guard = super::management::lock_operations().await;
    let session_id = super::management::management_session_id(&app)?;
    let window = app.get_webview_window("comfyui-settings").ok_or("ComfyUI 管理窗口已关闭")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let title = if kind == ModelScanScope::Disk { "选择磁盘根目录（如 D:\\）" } else { "选择要扫描模型的文件夹" };
    // Rust picker 结果直接登记为用途授权，不扩展通用 fs / asset scope。
    app.dialog().file().set_parent(&window).set_title(title).pick_folder(move |selected| { let _ = tx.send(selected); });
    let Some(selected) = rx.await.map_err(|_| "模型扫描目录选择已中断")? else { return Ok(None); };
    super::management::management_root(&webview, &app)?;
    if super::management::management_session_id(&app)? != session_id { return Err("管理窗口已变化，请重新选择扫描目录".into()); }
    let path = selected.into_path().map_err(|_| "请选择本机目录")?;
    let path_text = path.to_str().filter(|value| !value.is_empty() && value.len() <= 32_768 && !value.chars().any(char::is_control))
        .ok_or("目录名称无法安全显示")?;
    if kind == ModelScanScope::Disk && !is_disk_root(&path) { return Err("整盘扫描需要选择磁盘根目录（如 D:\\），子目录请使用指定文件夹扫描".into()); }
    let mut context = new_scan_root(&app, PathBuf::from(path_text), kind, opaque_id("model-root"))?;
    let state = app.state::<ModelDedupeState>();
    let mut runtime = state.0.lock().map_err(|_| "扫描目录授权不可用")?;
    runtime.selected_roots.retain(|_, previous| previous.root != context.root || previous.scope != context.scope
        || (previous.session_id == session_id && previous.root_identity == context.root_identity));
    if let Some(previous) = runtime.selected_roots.values().find(|previous| previous.root == context.root
        && previous.scope == context.scope && previous.session_id == session_id && previous.root_identity == context.root_identity)
    { context.id = previous.id.clone(); }
    else if runtime.selected_roots.len() >= MAX_SELECTED_ROOTS { return Err("本窗口最多授权 16 个扫描目录，请关闭管理窗口后重新选择".into()); }
    let response = SelectedModelScanRoot { root_id: context.id.clone(), display_path: context.root.to_string_lossy().into_owned(), kind };
    runtime.selected_roots.insert(context.id.clone(), context);
    if let Some(active) = runtime.active.take() { active.stop.store(true, Ordering::Release); }
    runtime.snapshot = None;
    Ok(Some(response))
}

fn ensure_active(app: &tauri::AppHandle, scan_id: &str, root: &Path, stop: &AtomicBool) -> Result<(), String> {
    if stop.load(Ordering::Acquire) { return Err("模型扫描已取消".into()); }
    let state = app.state::<ModelDedupeState>();
    let runtime = state.0.lock().map_err(|_| "模型扫描会话不可用".to_string())?;
    if !runtime.active.as_ref().is_some_and(|active| active.scan_id == scan_id && active.source_root == root) {
        return Err("模型扫描已失效，请重新扫描".into());
    }
    Ok(())
}

#[cfg(windows)]
fn is_link(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_link(metadata: &Metadata) -> bool { metadata.file_type().is_symlink() }

/// 每次读取都逐层拒绝链接/目录联接，再复用 path_policy 的真实路径和私有目录保护。
pub(super) fn authorize_plain_model_file(app: &tauri::AppHandle, root: &Path, path: &Path) -> Result<PathBuf, String> {
    authorize_plain_chain(app, root, path, false)
}

pub(super) fn authorize_plain_model_directory(app: &tauri::AppHandle, root: &Path, path: &Path) -> Result<PathBuf, String> {
    authorize_plain_chain(app, root, path, true)
}

fn authorize_plain_chain(app: &tauri::AppHandle, root: &Path, path: &Path, directory: bool) -> Result<PathBuf, String> {
    let relative = path.strip_prefix(root).map_err(|_| "模型路径超出当前扫描授权".to_string())?;
    if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("模型路径格式无效".into());
    }
    let mut current = root.to_path_buf();
    let root_meta = fs::symlink_metadata(root).map_err(|_| "模型目录不可访问".to_string())?;
    if !root_meta.is_dir() || is_link(&root_meta) { return Err("模型授权根已变化".into()); }
    for part in relative.components() {
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|_| "模型路径不可访问".to_string())?;
        if is_link(&metadata) || (current != path && !metadata.is_dir()) {
            return Err("模型路径含链接或目录联接，已拒绝访问".into());
        }
    }
    let resolved = if directory {
        crate::path_policy::authorize_model_scan_directory_with_roots(app, path, &[root.to_path_buf()])?
    } else {
        crate::path_policy::authorize_existing_plain_file_with_roots(app, &path.to_string_lossy(), &[root.to_path_buf()])?
    };
    if resolved != path || !resolved.starts_with(root) { return Err("模型真实路径已变化".into()); }
    Ok(resolved)
}

#[cfg(windows)]
fn number_of_links(file: &File, _metadata: &Metadata) -> Result<u64, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION}};
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }
        .map_err(|_| "无法读取模型硬链接计数".to_string())?;
    Ok(information.nNumberOfLinks as u64)
}
#[cfg(unix)]
fn number_of_links(_file: &File, metadata: &Metadata) -> Result<u64, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(metadata.nlink())
}
#[cfg(not(any(windows, unix)))]
fn number_of_links(_file: &File, _metadata: &Metadata) -> Result<u64, String> {
    Err("当前平台不支持确认模型硬链接身份".into())
}

#[cfg(windows)]
fn opened_file_identity(file: &File, _metadata: &Metadata) -> Result<file_id::FileId, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{
        GetFileInformationByHandle, GetFileInformationByHandleEx, FileIdInfo,
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
    }};
    let handle = HANDLE(file.as_raw_handle());
    let mut high = FILE_ID_INFO::default();
    if unsafe { GetFileInformationByHandleEx(handle, FileIdInfo, &mut high as *mut _ as *mut _, std::mem::size_of::<FILE_ID_INFO>() as u32) }.is_ok() {
        return Ok(file_id::FileId::new_high_res(high.VolumeSerialNumber, u128::from_le_bytes(high.FileId.Identifier)));
    }
    let mut low = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle, &mut low) }.map_err(|_| "无法读取模型句柄身份".to_string())?;
    Ok(file_id::FileId::new_low_res(low.dwVolumeSerialNumber, ((low.nFileIndexHigh as u64) << 32) | low.nFileIndexLow as u64))
}
#[cfg(unix)]
fn opened_file_identity(_file: &File, metadata: &Metadata) -> Result<file_id::FileId, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(file_id::FileId::new_inode(metadata.dev(), metadata.ino()))
}
#[cfg(not(any(windows, unix)))]
fn opened_file_identity(_file: &File, _metadata: &Metadata) -> Result<file_id::FileId, String> {
    Err("当前平台不支持确认模型磁盘身份".into())
}

pub(super) fn read_file_identity(path: &Path) -> Result<FileIdentitySnapshot, String> {
    let before = fs::symlink_metadata(path).map_err(|_| "模型文件不可访问".to_string())?;
    if !before.is_file() || is_link(&before) { return Err("模型已不是普通文件".into()); }
    let file = File::open(path).map_err(|_| "无法读取模型文件身份".to_string())?;
    let metadata = file.metadata().map_err(|_| "无法读取模型文件信息".to_string())?;
    let identity = opened_file_identity(&file, &metadata)?;
    let link_count = number_of_links(&file, &metadata)?;
    if link_count == 0 { return Err("模型硬链接计数无效".into()); }
    let after = fs::symlink_metadata(path).map_err(|_| "模型文件已变化".to_string())?;
    if is_link(&after) || before.len() != metadata.len() || after.len() != metadata.len()
        || before.modified().ok() != metadata.modified().ok() || after.modified().ok() != metadata.modified().ok()
        || file_id::get_file_id(path).ok() != Some(identity)
    { return Err("读取期间模型文件已变化，请重新扫描".into()); }
    Ok(FileIdentitySnapshot { identity, modified: metadata.modified().map_err(|_| "无法读取模型修改时间".to_string())?, size: metadata.len(), link_count })
}

pub(super) fn inspect_model_file(app: &tauri::AppHandle, root: &Path, path: &Path, id: String) -> Result<ScannedModelFile, String> {
    let path = authorize_plain_model_file(app, root, path)?;
    let relative_path = path.strip_prefix(root).map_err(|_| "模型路径不属于当前扫描范围".to_string())?.to_str()
        .filter(|value| value.len() <= 4096 && !value.chars().any(char::is_control))
        .ok_or_else(|| "模型文件名无法安全显示".to_string())?.replace('\\', "/");
    let fingerprint = read_file_identity(&path)?;
    Ok(ScannedModelFile { id, path, relative_path, identity: fingerprint.identity, modified: fingerprint.modified, size: fingerprint.size, link_count: fingerprint.link_count })
}

/// 在 Czkawka 每次打开文件前后重新授权并比较身份；取消标志在其每个读取块后检查。
pub(super) fn hash_model_file(app: &tauri::AppHandle, root: &Path, file: &ScannedModelFile, stop: &Arc<AtomicBool>) -> Result<String, String> {
    let counter = Arc::new(AtomicU64::new(0));
    hash_model_file_with_counter(app, root, file, stop, &counter)
}

fn hash_model_file_with_counter(app: &tauri::AppHandle, root: &Path, file: &ScannedModelFile, stop: &Arc<AtomicBool>, counter: &Arc<AtomicU64>) -> Result<String, String> {
    if stop.load(Ordering::Acquire) { return Err("模型扫描已取消".into()); }
    authorize_plain_model_file(app, root, &file.path)?;
    if read_file_identity(&file.path)? != file.fingerprint() { return Err("模型已变化，请重新扫描".into()); }
    let entry = DuplicateEntry { path: file.path.clone(), size: file.size, ..Default::default() };
    let mut buffer = vec![0_u8; 2 * 1024 * 1024];
    let hash = hash_calculation(&mut buffer, &entry, HashType::Blake3, counter, stop)
        .map_err(|_| "模型内容读取失败，未纳入重复结果".to_string())?
        .ok_or_else(|| "模型扫描已取消".to_string())?;
    authorize_plain_model_file(app, root, &file.path)?;
    if read_file_identity(&file.path)? != file.fingerprint() { return Err("扫描期间模型已变化，请重新扫描".into()); }
    Ok(hash)
}

fn is_model_name(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()).is_some_and(|extension| [
        "safetensors", "ckpt", "pt", "pt2", "pth", "bin", "onnx", "gguf", "sft", "pkl", "pickle", "tflite", "pb", "h5", "weights",
    ].iter().any(|allowed| extension.eq_ignore_ascii_case(allowed)))
}

pub(super) fn excluded_directory(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with('.') || ["venv", "env", "python", "python_embeded", "python_embedded", "node_modules", "__pycache__", "site-packages", "cache", "caches", "input", "output", "temp", "tmp",
        "windows", "program files", "program files (x86)", "programdata", "system volume information", "$recycle.bin", "$windows.~bt", "$windows.~ws", "$getcurrent", "recovery", "appdata",
        "system", "library", "applications", "volumes", "proc", "sys", "dev", "run", "lost+found",
    ].contains(&name.as_str())
}

fn send_progress(channel: &Channel<String>, stage: &'static str, completed: u64, total: Option<u64>, unit: &'static str) {
    let _ = channel.send(serde_json::json!({ "stage":stage, "completed":completed, "total":total, "unit":unit }).to_string());
}

struct HashProgressMonitor { finished: Arc<AtomicBool>, thread: Option<std::thread::JoinHandle<()>> }
impl Drop for HashProgressMonitor {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

fn collect_models(app: &tauri::AppHandle, context: &ModelScanRoot, scan_id: &str, stop: &Arc<AtomicBool>, channel: &Channel<String>) -> Result<(Vec<ScannedModelFile>, SkippedModels), String> {
    let root = &context.root;
    let mut queue: Vec<_> = context.traversal_roots().into_iter().map(|path| (path, 0_usize)).collect();
    let mut files = Vec::new();
    let mut skipped = SkippedModels::default();
    let mut visited = 0;
    let mut directories = 0;
    let mut recoveries = 0;
    while let Some((directory, depth)) = queue.pop() {
        ensure_active(app, scan_id, root, stop)?;
        verify_model_scan_root(app, context)?;
        // 安装中没有 models/custom_nodes 是普通空范围；枚举过的目录消失则属于扫描期间变化。
        match fs::symlink_metadata(&directory) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && depth == 0 => continue,
            Err(_) => { skipped.record(root, &directory, "目录不可访问或扫描期间已变化，未进入"); continue; }
        }
        if authorize_plain_model_directory(app, root, &directory).is_err() {
            // 未获访问授权的目录可能属于应用私有子树，只显示已授权的父级，不暴露其名称。
            let parent = directory.parent().filter(|parent| parent.starts_with(root)).unwrap_or(root);
            skipped.record(root, parent, "此目录下有子目录不可访问、未获授权或已变化，未进入");
            continue;
        }
        directories += 1;
        if directories > MAX_DIRECTORIES { return Err("模型扫描目录数量超过上限，请缩小扫描范围".into()); }
        let entries = match fs::read_dir(&directory) { Ok(entries) => entries, Err(_) => { skipped.record(root, &directory, "无法枚举目录内容，未进入"); continue; } };
        for entry in entries {
            ensure_active(app, scan_id, root, stop)?;
            visited += 1;
            if visited > MAX_VISITED_ENTRIES { return Err("模型扫描文件数量超过上限，请缩小扫描范围".into()); }
            let Ok(entry) = entry else { skipped.record(root, &directory, "目录中有条目无法读取，未纳入比较"); continue; };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else { skipped.record(root, &path, "条目不可访问或扫描期间已变化，未纳入比较"); continue; };
            if is_link(&metadata) { skipped.record(root, &path, "软链接、目录联接或其他重解析点，未跟随链接"); continue; }
            if metadata.is_dir() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { skipped.record(root, &path, "目录名称无法安全显示，未进入"); continue; };
                if name.starts_with(".ai-canvas-model-dedupe-") { recoveries += 1; continue; }
                if !excluded_directory(name) {
                    if depth >= MAX_MODEL_SCAN_DEPTH { skipped.record(root, &path, "目录深度达到扫描上限，未继续进入"); continue; }
                    if queue.len().saturating_add(directories) >= MAX_DIRECTORIES { return Err("模型扫描目录数量超过上限，请缩小扫描范围".into()); }
                    queue.push((path, depth + 1));
                }
            } else if metadata.is_file() && metadata.len() >= MIN_MODEL_SIZE && is_model_name(&path) {
                match inspect_model_file(app, root, &path, opaque_id("file")) {
                    Ok(file) => files.push(file),
                    Err(_) => {
                        // 文件授权失败时不披露拒绝项名称（可能处于私有目录）；其父目录已完成浅层授权。
                        skipped.record(root, &directory, "此目录下有模型不可访问、未获授权或身份已变化，未纳入比较");
                    }
                }
                if files.len() > MAX_CANDIDATES { return Err("待比较模型超过 20000 个，请缩小扫描范围".into()); }
            }
            if visited % 128 == 0 { send_progress(channel, "collecting", files.len() as u64, None, "files"); }
        }
    }
    if recoveries > 0 { return Err(format!("发现 {recoveries} 个去重恢复目录，请先处理恢复记录后再扫描")); }
    Ok((files, skipped))
}

fn reclaimable_bytes(files: &[ScannedModelFile], size: u64) -> u64 {
    let has_shared_keeper = files.iter().any(|file| file.link_count > 1);
    let ordinary = files.iter().filter(|file| file.link_count == 1).map(|file| file.identity).collect::<HashSet<_>>().len();
    size.saturating_mul(ordinary.saturating_sub(usize::from(!has_shared_keeper)) as u64)
}

fn scan_models(app: &tauri::AppHandle, context: &ModelScanRoot, scan_id: &str, stop: &Arc<AtomicBool>, channel: &Channel<String>) -> Result<(DuplicateModelScan, NativeSnapshot), String> {
    let root = &context.root;
    send_progress(channel, "collecting", 0, None, "files");
    let (files, mut skipped) = collect_models(app, context, scan_id, stop, channel)?;
    let scanned_files = files.len();
    let mut by_size: BTreeMap<u64, Vec<ScannedModelFile>> = BTreeMap::new();
    for file in files { by_size.entry(file.size).or_default().push(file); }
    let candidates: Vec<_> = by_size.into_iter().filter(|(_, files)| files.len() > 1).collect();
    let total = candidates.iter().flat_map(|(_, files)| files).fold(0_u64, |total, file| total.saturating_add(file.size));
    let counter = Arc::new(AtomicU64::new(0));
    let progress_finished = Arc::new(AtomicBool::new(false));
    let progress_thread = {
        let counter = counter.clone(); let finished = progress_finished.clone(); let channel = channel.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::Acquire) {
                send_progress(&channel, "hashing", counter.load(Ordering::Relaxed), Some(total), "bytes");
                std::thread::sleep(Duration::from_millis(150));
            }
        })
    };
    let progress_monitor = HashProgressMonitor { finished: progress_finished, thread: Some(progress_thread) };
    let result = (|| {
        let mut groups = Vec::new();
        let mut native_groups = HashMap::new();
        for (size, files) in candidates {
            let mut by_hash: BTreeMap<String, Vec<ScannedModelFile>> = BTreeMap::new();
            for file in files {
                ensure_active(app, scan_id, root, stop)?;
                verify_model_scan_root(app, context)?;
                match hash_model_file_with_counter(app, root, &file, stop, &counter) {
                    Ok(hash) => by_hash.entry(hash).or_default().push(file),
                    Err(error) if stop.load(Ordering::Acquire) => return Err(error),
                    Err(_) => { skipped.record(root, &file.path, "模型内容读取失败或身份已变化，未纳入重复结果"); }
                }
            }
            for (hash, mut files) in by_hash.into_iter().filter(|(_, files)| files.len() > 1) {
                files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
                let reclaimable_bytes = reclaimable_bytes(&files, size);
                if reclaimable_bytes == 0 { continue; }
                if groups.len() >= MAX_RESULT_GROUPS { return Err("重复模型分组超过上限，请缩小扫描范围".to_string()); }
                let id = opaque_id("group");
                groups.push(DuplicateModelGroup { id: id.clone(), size, hash: hash.clone(), reclaimable_bytes, files: files.iter().map(|file| DuplicateModelFile {
                    id: file.id.clone(), relative_path: file.relative_path.clone(), already_shared: file.link_count > 1,
                }).collect() });
                native_groups.insert(id, NativeGroup { hash, size, files });
            }
        }
        let warnings = if skipped.total > 0 { vec![format!("已跳过 {} 个链接、不可访问或扫描期间变化的条目；其占用未计入可回收空间。正常排除的系统、环境目录和非模型小文件不计入跳过数量", skipped.total)] } else { Vec::new() };
        let omitted_skipped_entries = skipped.omitted();
        groups.sort_by(|left, right| right.reclaimable_bytes.cmp(&left.reclaimable_bytes));
        Ok((DuplicateModelScan { scan_id: scan_id.to_string(), engine: ENGINE, groups, scanned_files, skipped_files: skipped.total,
                skipped_entries: skipped.entries, omitted_skipped_entries, warnings },
            NativeSnapshot { scan_id: scan_id.to_string(), scan_root: context.clone(), groups: native_groups }))
    })();
    drop(progress_monitor);
    send_progress(channel, "hashing", counter.load(Ordering::Relaxed).min(total), Some(total), "bytes");
    result
}

#[tauri::command]
pub async fn scan_comfyui_duplicate_models(webview: Webview, app: tauri::AppHandle, scope: Option<ModelScanScope>, root_id: Option<String>, on_progress: Channel<String>) -> Result<DuplicateModelScan, String> {
    let context = resolve_model_scan_root(&webview, &app, scope.unwrap_or_default(), root_id.as_deref())?;
    let root = context.root.clone();
    let scan_id = opaque_id("scan");
    let stop = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<ModelDedupeState>();
        let mut runtime = state.0.lock().map_err(|_| "模型扫描会话不可用".to_string())?;
        if let Some(active) = runtime.active.take() { active.stop.store(true, Ordering::Release); }
        runtime.snapshot = None;
        runtime.active = Some(ActiveScan { scan_id: scan_id.clone(), source_root: root.clone(), stop: stop.clone() });
    }
    let _guard = super::management::lock_operations().await;
    let worker_app = app.clone(); let worker_context = context.clone(); let worker_id = scan_id.clone(); let worker_stop = stop.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        verify_model_scan_root(&worker_app, &worker_context)?;
        scan_models(&worker_app, &worker_context, &worker_id, &worker_stop, &on_progress)
    }).await
        .map_err(|_| "模型扫描工作线程异常，未保留结果".to_string()).and_then(|result| result);
    let root_is_current = super::management::ensure_management_caller(&webview, &app).is_ok()
        && verify_model_scan_root(&app, &context).is_ok();
    let state = app.state::<ModelDedupeState>();
    let mut runtime = state.0.lock().map_err(|_| "模型扫描会话不可用".to_string())?;
    let current = root_is_current && !stop.load(Ordering::Acquire) && runtime.active.as_ref().is_some_and(|active| active.scan_id == scan_id);
    if !current {
        if runtime.active.as_ref().is_some_and(|active| active.scan_id == scan_id) { runtime.active = None; }
        return Err("模型扫描已取消或扫描目录授权已变化，请重新选择并扫描".into());
    }
    runtime.active = None;
    let (response, snapshot) = result?;
    runtime.snapshot = Some(snapshot);
    Ok(response)
}

#[tauri::command]
pub fn cancel_comfyui_model_scan(webview: Webview, app: tauri::AppHandle) -> Result<(), String> {
    super::management::ensure_management_caller(&webview, &app)?;
    invalidate_model_scans(&app);
    Ok(())
}

fn resolve_duplicate_selections(snapshot: &NativeSnapshot, requests: &[DuplicateSelectionRequest]) -> Result<Vec<ResolvedDuplicateSelection>, String> {
    if requests.is_empty() || requests.len() > MAX_TARGETS { return Err("请选择 1 至 256 个有效重复分组".into()); }
    let mut group_ids = HashSet::new();
    let mut file_ids = HashSet::new();
    let mut file_paths = HashSet::new();
    let mut physical_objects = HashSet::new();
    let mut total_targets = 0_usize;
    let mut selections = Vec::with_capacity(requests.len());
    for request in requests {
        total_targets = total_targets.saturating_add(request.target_ids.len());
        if request.target_ids.is_empty() || total_targets > MAX_TARGETS { return Err("单次操作请选择 1 至 256 个待替换模型".into()); }
        if !group_ids.insert(request.group_id.as_str()) { return Err("批量请求中存在重复分组".into()); }
        let selected: HashSet<_> = request.target_ids.iter().map(String::as_str).collect();
        if selected.len() != request.target_ids.len() || selected.contains(request.keeper_id.as_str()) {
            return Err("待替换模型标识重复或与保留项冲突".into());
        }
        let group = snapshot.groups.get(&request.group_id).ok_or_else(|| "重复分组已失效，请重新扫描".to_string())?;
        let keeper = group.files.iter().find(|file| file.id == request.keeper_id).cloned().ok_or_else(|| "保留模型标识无效".to_string())?;
        let targets: Vec<_> = group.files.iter().filter(|file| selected.contains(file.id.as_str())).cloned().collect();
        if targets.len() != request.target_ids.len() || targets.iter().any(|file| file.link_count != 1 || file.identity == keeper.identity) {
            return Err("待替换项不存在或已经是共享硬链接，请重新扫描".into());
        }
        for file in std::iter::once(&keeper).chain(targets.iter()) {
            if !file_ids.insert(file.id.clone()) || !file_paths.insert(file.path.clone()) || !physical_objects.insert(file.identity) {
                return Err("批量请求中的保留项或替换项有路径、标识或磁盘身份冲突，请重新扫描".into());
            }
        }
        selections.push(ResolvedDuplicateSelection { scan_root: snapshot.scan_root.clone(), keeper, targets, hash: group.hash.clone(), size: group.size });
    }
    Ok(selections)
}

/// 全部组解析通过后才一次消费快照；禁止 Renderer 逐组重放或跨组覆盖保留副本。
pub(super) fn take_groups_for_replacement(app: &tauri::AppHandle, scan_id: &str, requests: &[DuplicateSelectionRequest]) -> Result<Vec<ResolvedDuplicateSelection>, String> {
    let scan_root = {
        let state = app.state::<ModelDedupeState>();
        let runtime = state.0.lock().map_err(|_| "模型扫描会话不可用".to_string())?;
        if runtime.active.is_some() { return Err("请等待模型扫描完成".into()); }
        let snapshot = runtime.snapshot.as_ref().filter(|snapshot| snapshot.scan_id == scan_id).ok_or_else(|| "扫描结果已失效，请重新扫描".to_string())?;
        snapshot.scan_root.clone()
    };
    // 外部目录授权也访问 ModelDedupeState，不能持有 runtime 锁时复核。
    verify_model_scan_root(app, &scan_root)?;
    let state = app.state::<ModelDedupeState>();
    let mut runtime = state.0.lock().map_err(|_| "模型扫描会话不可用".to_string())?;
    if runtime.active.is_some() { return Err("请等待模型扫描完成".into()); }
    let snapshot = runtime.snapshot.as_ref().ok_or_else(|| "扫描结果已失效，请重新扫描".to_string())?;
    if snapshot.scan_id != scan_id { return Err("扫描结果已变化，请重新扫描".into()); }
    let selections = resolve_duplicate_selections(snapshot, requests)?;
    runtime.snapshot = None;
    Ok(selections)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, inode: u64, links: u64) -> ScannedModelFile {
        ScannedModelFile { id: name.into(), path: PathBuf::from(name), relative_path: name.into(), identity: file_id::FileId::new_inode(1, inode), modified: SystemTime::UNIX_EPOCH, size: MIN_MODEL_SIZE, link_count: links }
    }

    fn snapshot(groups: Vec<(&str, Vec<ScannedModelFile>)>) -> NativeSnapshot {
        NativeSnapshot { scan_id: "scan".into(), scan_root: ModelScanRoot { id: "root".into(), root: PathBuf::from("models"),
            session_id: "session".into(), scope: ModelScanScope::Folder, root_identity: file_id::FileId::new_inode(1, 1) },
            groups: groups.into_iter().map(|(id, files)| (id.into(), NativeGroup { hash: id.into(), size: MIN_MODEL_SIZE, files })).collect() }
    }

    fn selection(group: &str, keeper: &str, targets: &[&str]) -> DuplicateSelectionRequest {
        DuplicateSelectionRequest { group_id: group.into(), keeper_id: keeper.into(), target_ids: targets.iter().map(|id| (*id).into()).collect() }
    }

    #[test]
    fn skipped_details_are_bounded_root_relative_and_exclude_unsafe_names() {
        let root = PathBuf::from("scan-root");
        let mut skipped = SkippedModels::default();
        skipped.record(&root, &root.join("linked-model.pt"), "链接未跟随");
        skipped.record(&root, &root.join("model\nname.pt"), "名称无法显示");
        skipped.record(&root, Path::new("outside/private.pt"), "路径无法显示");
        for _ in 0..MAX_SKIPPED_DETAILS { skipped.record(&root, &root, "目录无法读取"); }
        assert_eq!(skipped.total, MAX_SKIPPED_DETAILS + 3);
        assert_eq!(skipped.entries.len(), MAX_SKIPPED_DETAILS);
        assert_eq!(skipped.omitted(), 3);
        assert_eq!(skipped.entries[0].relative_path, "linked-model.pt");
        assert!(!skipped.entries[1].relative_path.contains('\n'));
        assert!(!skipped.entries[2].relative_path.contains("private.pt"));
        assert_eq!(skipped.entries[3].relative_path, ".");
    }

    #[test]
    fn batch_resolver_keeps_all_renamed_paths_and_request_order() {
        let snapshot = snapshot(vec![("first", vec![file("a.pt", 2, 1), file("renamed.pth", 3, 1)]),
            ("second", vec![file("other.pt", 4, 1), file("plugin-name.pt", 5, 1)])]);
        let resolved = resolve_duplicate_selections(&snapshot, &[selection("second", "other.pt", &["plugin-name.pt"]),
            selection("first", "a.pt", &["renamed.pth"])]).unwrap();
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].targets[0].relative_path, "plugin-name.pt");
        assert_eq!(resolved[1].targets[0].relative_path, "renamed.pth");
        assert!(resolve_duplicate_selections(&snapshot, &[selection("first", "a.pt", &["renamed.pth"]),
            selection("second", "other.pt", &["missing.pt"])]).is_err());
        assert_eq!(snapshot.groups.len(), 2);
    }

    #[test]
    fn batch_resolver_rejects_duplicate_groups_shared_targets_and_cross_group_aliases() {
        let snapshot = snapshot(vec![("first", vec![file("a.pt", 2, 1), file("b.pt", 3, 1), file("shared.pt", 4, 2)]),
            ("second", vec![file("alias.pt", 3, 1), file("c.pt", 5, 1)])]);
        assert!(resolve_duplicate_selections(&snapshot, &[selection("first", "a.pt", &["b.pt"]), selection("first", "a.pt", &["b.pt"])]).is_err());
        assert!(resolve_duplicate_selections(&snapshot, &[selection("first", "a.pt", &["shared.pt"])]).is_err());
        assert!(resolve_duplicate_selections(&snapshot, &[selection("first", "a.pt", &["b.pt"]), selection("second", "alias.pt", &["c.pt"])]).is_err());
        assert!(resolve_duplicate_selections(&snapshot, &[selection("first", "a.pt", &["a.pt"])]).is_err());
        assert!(resolve_duplicate_selections(&snapshot, &[selection("first", "a.pt", &["b.pt", "b.pt"])]).is_err());
    }

    #[test]
    fn batch_resolver_bounds_total_targets_across_groups() {
        let mut first = vec![file("keeper.pt", 1, 1)];
        let target_ids: Vec<_> = (0..MAX_TARGETS).map(|index| format!("target-{index}.pt")).collect();
        first.extend(target_ids.iter().enumerate().map(|(index, name)| file(name, index as u64 + 2, 1)));
        let snapshot = snapshot(vec![("first", first), ("second", vec![file("extra-keeper.pt", 500, 1), file("extra-target.pt", 501, 1)])]);
        let first_request = DuplicateSelectionRequest { group_id: "first".into(), keeper_id: "keeper.pt".into(), target_ids };
        assert!(resolve_duplicate_selections(&snapshot, &[first_request, selection("second", "extra-keeper.pt", &["extra-target.pt"])]).is_err());
    }

    #[test]
    fn model_filter_does_not_depend_on_same_basename() {
        assert!(is_model_name(Path::new("models/a.safetensors")));
        assert!(is_model_name(Path::new("custom_nodes/other/renamed.SAFETENSORS")));
        assert!(!is_model_name(Path::new("custom_nodes/code.py")));
    }

    #[test]
    fn shared_objects_are_not_counted_twice() {
        let shared = [file("a.pt", 1, 2), file("renamed.pt", 1, 2)];
        assert_eq!(reclaimable_bytes(&shared, MIN_MODEL_SIZE), 0);
        let mut with_duplicate = shared.to_vec();
        with_duplicate.push(file("third.pt", 2, 1));
        assert_eq!(reclaimable_bytes(&with_duplicate, MIN_MODEL_SIZE), MIN_MODEL_SIZE);
        assert_eq!(reclaimable_bytes(&[file("a.pt", 1, 1), file("b.pt", 2, 1)], MIN_MODEL_SIZE), MIN_MODEL_SIZE);
    }

    #[test]
    fn cache_runtime_and_recovery_directories_are_excluded() {
        for name in [".git", ".ai-canvas-model-dedupe-id.recovery", "venv", "__pycache__", "node_modules", "output", "Windows", "System Volume Information", "$RECYCLE.BIN", "AppData"] { assert!(excluded_directory(name)); }
        assert!(!excluded_directory("checkpoints"));
    }

    #[cfg(windows)]
    #[test]
    fn disk_scope_accepts_only_local_volume_roots() {
        assert!(is_disk_root(Path::new("D:\\")));
        assert!(!is_disk_root(Path::new("D:\\models")));
        assert!(!is_disk_root(Path::new("D:")));
        assert!(!is_disk_root(Path::new("\\\\server\\share\\")));
    }

    #[test]
    fn folder_and_disk_scope_start_at_the_chosen_root() {
        let root = ModelScanRoot { id: "scope".into(), root: PathBuf::from("chosen"), session_id: "session".into(),
            scope: ModelScanScope::Folder, root_identity: file_id::FileId::new_inode(1, 1) };
        assert_eq!(root.traversal_roots(), vec![PathBuf::from("chosen")]);
        assert_eq!(ModelScanRoot { scope: ModelScanScope::Disk, ..root.clone() }.traversal_roots(), vec![PathBuf::from("chosen")]);
        assert_eq!(ModelScanRoot { scope: ModelScanScope::Models, ..root.clone() }.traversal_roots(), vec![PathBuf::from("chosen/models")]);
    }

    #[test]
    fn czkawka_full_hash_matches_different_names_but_rejects_different_content() {
        let directory = std::env::temp_dir().join(opaque_id("canvas-model-hash-test"));
        fs::create_dir(&directory).unwrap();
        let paths = [directory.join("original.safetensors"), directory.join("plugin-name.pth"), directory.join("other.safetensors")];
        fs::write(&paths[0], b"complete model content").unwrap();
        fs::write(&paths[1], b"complete model content").unwrap();
        fs::write(&paths[2], b"different model content").unwrap();
        let hashes: Vec<_> = paths.iter().map(|path| {
            hash_calculation(&mut [0; 7], &DuplicateEntry { path: path.clone(), ..Default::default() }, HashType::Blake3,
                &Arc::new(AtomicU64::new(0)), &Arc::new(AtomicBool::new(false))).unwrap().unwrap()
        }).collect();
        assert_eq!(hashes[0], hashes[1]);
        assert_ne!(hashes[0], hashes[2]);
        let stopped = hash_calculation(&mut [0; 7], &DuplicateEntry { path: paths[0].clone(), ..Default::default() }, HashType::Blake3,
            &Arc::new(AtomicU64::new(0)), &Arc::new(AtomicBool::new(true))).unwrap();
        assert!(stopped.is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
