//! 新项目素材根的原生绑定。根目录来自已同步的用户设置，不接收 Renderer 路径。
use std::{collections::HashSet, fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
#[cfg(windows)]
use std::fs::File;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, Webview};
use crate::path_policy::{authorize_path, canonicalize_simplified, ensure_local_frontend_caller, ensure_trusted_caller, is_link_or_reparse as is_link, verified_user_storage_root, PathAccess};

const ERROR: &str = "新项目素材目录不可用或归属未能确认，原有文件已保留";
const RECYCLE_ERROR: &str = "项目素材目录未能确认已移入系统回收站";
const REGISTRY_DIR: &str = "native-project-media-roots";
const MAX_PROJECT_NAME_BYTES: usize = 160;
const MAX_RECYCLE_ASSET_ROOTS: usize = 4096;

/// 由主窗口的已核验联合目录提供；独立搜索窗口不能自行登记作品。
#[derive(Default)]
pub struct AssetSearchNativeRoots(Mutex<HashSet<String>>);

#[derive(Default)]
pub struct VideoEditorNativeRoot(Mutex<Option<VideoEditorLease>>);

/// 来自既有目录设置同步。仅用于保护显式登记的素材引用，不授予文件权限。
#[derive(Default)]
pub struct NativeProjectRecycleRoots(Mutex<Option<Vec<PathBuf>>>);

pub(crate) fn sync_project_recycle_roots<R: Runtime>(app: &tauri::AppHandle<R>, directories: &[String], base: Option<&str>) {
    let state = app.try_state::<NativeProjectRecycleRoots>();
    let protected = state.as_ref().and_then(|state| state.0.lock().ok());
    // 核对及回收持有相同锁，防止素材根配置在两步之间生效。
    crate::path_policy::set_user_storage_root(app, base);
    if let Some(mut roots) = protected {
        *roots = (directories.len() <= MAX_RECYCLE_ASSET_ROOTS).then(|| directories.iter().map(|path| path.trim())
            .filter(|path| !path.is_empty() && Some(*path) != base.map(str::trim)).map(PathBuf::from).collect());
    }
}

struct VideoEditorLease { project_id: String, canvas_id: String, session_id: String }

fn editor_root_allowed(label: &str, project_id: &str, canvas_id: &str, session_id: &str, lease: Option<&VideoEditorLease>) -> bool {
    label == "video-editor" && lease.is_some_and(|entry| entry.project_id == project_id
        && entry.canvas_id == canvas_id && entry.session_id == session_id)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMediaReference {
    relative_path: String,
    sha256: String,
    bytes: u64,
    mime_type: String,
}

fn media_format(mime: &str) -> Option<(&'static str, u64)> {
    const IMAGE: u64 = 32 * 1024 * 1024;
    const VIDEO: u64 = 64 * 1024 * 1024;
    match mime {
        "image/png" => Some(("png", IMAGE)), "image/jpeg" => Some(("jpg", IMAGE)),
        "image/webp" => Some(("webp", IMAGE)), "image/gif" => Some(("gif", IMAGE)),
        "image/svg+xml" => Some(("svg", IMAGE)),
        "video/mp4" => Some(("mp4", VIDEO)), "video/webm" => Some(("webm", VIDEO)),
        "video/quicktime" => Some(("mov", VIDEO)), "audio/mpeg" => Some(("mp3", IMAGE)),
        "audio/wav" => Some(("wav", IMAGE)), "audio/ogg" => Some(("ogg", IMAGE)),
        "audio/opus" => Some(("opus", IMAGE)), "audio/aac" => Some(("aac", IMAGE)),
        "audio/flac" => Some(("flac", IMAGE)), "audio/pcm" => Some(("pcm", IMAGE)),
        "application/json" => Some(("json", 256 * 1024)), _ => None,
    }
}

fn validate_media_reference(reference: &NativeMediaReference) -> Result<String, String> {
    let (extension, limit) = media_format(&reference.mime_type).ok_or(ERROR)?;
    if reference.sha256.len() != 64 || !reference.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || reference.bytes == 0 || reference.bytes > limit { return Err(ERROR.into()); }
    let name = format!("{}.{extension}", reference.sha256);
    if reference.relative_path != format!("media/{name}") { return Err(ERROR.into()); }
    Ok(name)
}

#[cfg(any(windows, target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
fn resume_media_staging_file(file: &mut fs::File, reference: &NativeMediaReference, data: &[u8],
    regular_metadata: impl Fn(&fs::File, u64) -> Result<fs::Metadata, String>) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    let before = regular_metadata(file, reference.bytes)?;
    file.rewind().map_err(|_| ERROR)?;
    let mut prefix = Vec::new();
    (&mut *file).take(reference.bytes + 1).read_to_end(&mut prefix).map_err(|_| ERROR)?;
    if prefix.len() as u64 != before.len() || regular_metadata(file, reference.bytes)?.len() != before.len()
        || !data.starts_with(&prefix) { return Err(ERROR.into()); }
    // Never truncate or replace recovery material: only append a verified missing suffix.
    file.seek(SeekFrom::Start(prefix.len() as u64)).map_err(|_| ERROR)?;
    file.write_all(&data[prefix.len()..]).and_then(|_| file.sync_all()).map_err(|_| ERROR)?;
    if regular_metadata(file, reference.bytes)?.len() != reference.bytes { return Err(ERROR.into()); }
    file.rewind().map_err(|_| ERROR.into())
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u8, project_id: String, folder: String, base_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    creation_nonce: Option<String>,
}

fn valid_id(id: &str, prefix: &str) -> bool {
    let parts: Vec<_> = id.split('-').collect();
    parts.len() == 6 && parts[0] == prefix && [8, 4, 4, 4, 12].iter().zip(&parts[1..])
        .all(|(length, part)| part.len() == *length && part.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        && parts[3].starts_with('4') && matches!(parts[4].as_bytes()[0], b'8' | b'9' | b'a' | b'b')
}

fn plain_dir(path: &Path) -> Result<(), String> {
    let info = fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if is_link(&info) || !info.is_dir() { return Err(ERROR.into()); }
    Ok(())
}

fn plain_chain(path: &Path) -> Result<(), String> {
    for entry in path.ancestors().collect::<Vec<_>>().into_iter().rev().filter(|p| !p.as_os_str().is_empty()) {
        plain_dir(entry)?;
    }
    Ok(())
}

fn directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err(ERROR.into()),
    }
    plain_dir(path)
}

fn private_directory(path: &Path) -> Result<(), String> {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let mut builder = builder;
    #[cfg(unix)]
    { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    match builder.create(path) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err(ERROR.into()),
    }
    plain_dir(path)
}

fn base_hash(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or(ERROR)?.replace('\\', "/");
    let canonical = if cfg!(windows) { text.to_lowercase() } else { text };
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn read_binding(path: &Path) -> Result<Option<Binding>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERROR.into()),
    };
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > 4096 { return Err(ERROR.into()); }
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000).share_mode(1); }
    let file = options.open(path).map_err(|_| ERROR)?;
    let opened = file.metadata().map_err(|_| ERROR)?;
    if is_link(&opened) || !opened.is_file() || opened.len() != metadata.len() { return Err(ERROR.into()); }
    let mut bytes = Vec::new(); (&file).take(4097).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() > 4096 || bytes.len() as u64 != opened.len() || file.metadata().map_err(|_| ERROR)?.len() != opened.len() { return Err(ERROR.into()); }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ERROR.into())
}

fn write_binding(path: &Path, binding: &Binding) -> Result<(), String> {
    let bytes = serde_json::to_vec(binding).map_err(|_| ERROR)?;
    let mut options = OpenOptions::new(); options.create_new(true).write(true);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000 | 0x80000000).share_mode(0); }
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|_| ERROR)?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| ERROR)?;
    Ok(())
}

fn matches_binding(binding: &Binding, project_id: &str, folder: &str, expected_hash: &str) -> bool {
    binding.version == 1 && binding.project_id == project_id && binding.folder == folder && binding.base_sha256 == expected_hash
        && binding.creation_nonce.is_none()
}

fn reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|&prefix| stem.strip_prefix(prefix).is_some_and(|suffix|
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")))
}

/// 名称只是显示片段，不是路径；截断按 UTF-8 字符边界，跨平台保留设备名也不能成为目录。
fn sanitize_project_name(name: &str) -> String {
    let mut cleaned: String = name.chars().filter(|ch| !ch.is_control()).map(|ch|
        if "<>:\"|?*/\\".contains(ch) { '_' } else { ch }).collect();
    cleaned = cleaned.trim_matches(|ch: char| ch == '.' || ch.is_whitespace()).to_owned();
    if reserved_device_name(&cleaned) { cleaned.insert(0, '_'); }
    let mut end = cleaned.len().min(MAX_PROJECT_NAME_BYTES);
    while !cleaned.is_char_boundary(end) { end -= 1; }
    cleaned.truncate(end);
    let mut cleaned = cleaned.trim_end_matches(|ch: char| ch == '.' || ch.is_whitespace()).to_owned();
    // 截断后去掉尾部空白也可能形成设备名，结果必须仍满足自身校验。
    if reserved_device_name(&cleaned) {
        cleaned.insert(0, '_');
        while cleaned.len() > MAX_PROJECT_NAME_BYTES { let _ = cleaned.pop(); }
        cleaned = cleaned.trim_end_matches(|ch: char| ch == '.' || ch.is_whitespace()).to_owned();
    }
    if cleaned.is_empty() { "project".into() } else { cleaned }
}

fn named_folder(project_id: &str, project_name: &str) -> String {
    format!("{}-{}", sanitize_project_name(project_name), &project_id[3..11])
}

fn valid_binding(binding: &Binding, project_id: &str, expected_hash: &str) -> bool {
    if !valid_id(project_id, "p2") { return false; }
    if binding.version == 1 { return matches_binding(binding, project_id, &format!("project-{project_id}"), expected_hash); }
    if binding.version != 2 || binding.project_id != project_id || binding.base_sha256 != expected_hash
        || !binding.creation_nonce.as_ref().is_some_and(|nonce| nonce.len() == 64
            && nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))) { return false; }
    let suffix = format!("-{}", &project_id[3..11]);
    let Some(name) = binding.folder.strip_suffix(&suffix) else { return false; };
    let mut components = Path::new(&binding.folder).components();
    !name.is_empty() && name.len() <= MAX_PROJECT_NAME_BYTES && sanitize_project_name(name) == name
        && matches!(components.next(), Some(std::path::Component::Normal(_))) && components.next().is_none()
}

fn read_creation_intent(lock: &fs::File) -> Result<Option<Binding>, String> {
    let length = lock.metadata().map_err(|_| ERROR)?.len();
    if length == 0 { return Ok(None); }
    if length > 4096 { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    lock.take(4097).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 != length || lock.metadata().map_err(|_| ERROR)?.len() != length { return Err(ERROR.into()); }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ERROR.into())
}

/// 根来自原生配置；已有绑定的目录不可随显示名改变，未知目录不会被接管。
fn bind_root(base: &Path, registry: &Path, project_id: &str, create: bool, project_name: Option<&str>) -> Result<PathBuf, String> {
    with_bound_root(base, registry, project_id, create, project_name, Ok)
}

fn with_bound_root<T>(base: &Path, registry: &Path, project_id: &str, create: bool, project_name: Option<&str>,
    use_root: impl FnOnce(PathBuf) -> Result<T, String>) -> Result<T, String> {
    if !valid_id(project_id, "p2") { return Err(ERROR.into()); }
    plain_chain(base)?; plain_chain(registry)?;
    let marker = registry.join(format!("{project_id}.json"));
    let lock_path = registry.join(format!("{project_id}.lock"));
    if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
        if is_link(&metadata) || !metadata.is_file() { return Err(ERROR.into()); }
    }
    let mut lock_options = OpenOptions::new(); lock_options.create(create).read(true).write(true).truncate(false);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; lock_options.custom_flags(0x00200000).share_mode(0); }
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; lock_options.mode(0o600); }
    let lock = lock_options.open(&lock_path).map_err(|_| ERROR)?;
    let metadata = lock.metadata().map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_file() { return Err(ERROR.into()); }
    FileExt::try_lock_exclusive(&lock).map_err(|_| ERROR)?;
    let expected_hash = base_hash(base)?;
    let target = match read_binding(&marker)? {
        Some(binding) => {
            if !valid_binding(&binding, project_id, &expected_hash) { return Err(ERROR.into()); }
            let target = base.join(&binding.folder);
            plain_dir(&target)?;
            if read_binding(&target.join(".ai-canvas-native-project.json"))?.as_ref() != Some(&binding) { return Err(ERROR.into()); }
            target
        },
        None if create => {
            // 锁文件保存首次名称；重启只能续建这个目标，部分写失败不能换名称绕过现场。
            let intent = read_creation_intent(&lock)?;
            let resuming = intent.is_some();
            let binding = match intent {
                Some(binding) => binding,
                None => Binding {
                    version: if project_name.is_some() { 2 } else { 1 }, project_id: project_id.into(),
                    folder: project_name.map(|name| named_folder(project_id, name)).unwrap_or_else(|| format!("project-{project_id}")),
                    base_sha256: expected_hash.clone(),
                    creation_nonce: if project_name.is_some() {
                        Some(crate::comfyui::media_source::new_id().map_err(|_| ERROR)?)
                    } else { None },
                },
            };
            if !valid_binding(&binding, project_id, &expected_hash) { return Err(ERROR.into()); }
            let target = base.join(&binding.folder);
            let root_marker = target.join(".ai-canvas-native-project.json");
            if binding.version == 2 {
                // 仅检查已知旧候选，不扫描目录，也不把残留 UUID 根旁的新目录当作恢复。
                match fs::symlink_metadata(base.join(format!("project-{project_id}"))) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                    _ => return Err(ERROR.into()),
                }
            }
            let target_exists = match fs::symlink_metadata(&target) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(_) => return Err(ERROR.into()),
            };
            // v1 没有不可预测创建身份，已有目标仍按原规则拒绝；v2 三份凭据必须同 nonce。
            if target_exists {
                if !resuming || binding.version != 2 { return Err(ERROR.into()); }
                plain_dir(&target)?;
                if read_binding(&root_marker)?.as_ref() != Some(&binding) { return Err(ERROR.into()); }
            } else {
                if !resuming {
                    let bytes = serde_json::to_vec(&binding).map_err(|_| ERROR)?;
                    (&lock).write_all(&bytes).and_then(|_| lock.sync_all()).map_err(|_| ERROR)?;
                }
                fs::create_dir(&target).map_err(|_| ERROR)?;
                plain_dir(&target)?;
                write_binding(&root_marker, &binding)?;
            }
            write_binding(&marker, &binding)?;
            let verified = read_binding(&marker)?.ok_or(ERROR)?;
            if verified != binding || read_binding(&root_marker)?.as_ref() != Some(&binding) { return Err(ERROR.into()); }
            target
        },
        None => return Err(ERROR.into()),
    };
    plain_chain(&target)?;
    // 调用方可在原生归属锁尚未释放时使用已核对的根。
    use_root(target)
}

fn media_base<R: Runtime>(app: &tauri::AppHandle<R>, create: bool) -> Result<PathBuf, String> {
    let base = if let Some(root) = verified_user_storage_root(app)? { root }
    else {
        let app_data = app.path().app_data_dir().map_err(|_| ERROR)?;
        plain_chain(&app_data)?;
        let root = app_data.join("data");
        if create { directory(&root)?; } else { plain_dir(&root)?; }
        root
    };
    plain_chain(&base)?;
    authorize_path(app, base.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR.into())
}

fn root_caller_allowed(label: &str, create: bool, allow_search: bool) -> bool {
    label == "main" || allow_search && !create && matches!(label, "asset-search" | "video-editor")
}

fn search_root_allowed(label: &str, project_id: &str, allowed: &HashSet<String>) -> bool {
    label == "asset-search" && valid_id(project_id, "p2") && allowed.contains(project_id)
}

fn media_root<R: Runtime>(webview: &Webview<R>, project_id: &str, create: bool, allow_search: bool, project_name: Option<&str>) -> Result<String, String> {
    if !root_caller_allowed(webview.label(), create, allow_search) { return Err(ERROR.into()); }
    if webview.label() == "video-editor" { ensure_local_frontend_caller(webview).map_err(|_| ERROR)?; }
    else { ensure_trusted_caller(webview).map_err(|_| ERROR)?; }
    let app = webview.app_handle();
    let base = media_base(app, create)?;
    let private = crate::project_model_safety::private_root(app)?;
    if create { private_directory(&private)?; }
    plain_chain(&private)?;
    let registry = private.join(REGISTRY_DIR);
    if create { private_directory(&registry)?; }
    plain_chain(&registry)?;
    let target = bind_root(&base, &registry, project_id, create, project_name)?;
    // 配置可能在准备期间改变，不能把旧根当成当前授权。
    if media_base(app, false)? != base { return Err(ERROR.into()); }
    let authorized = authorize_path(app, target.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR)?;
    if authorized.parent() != Some(base.as_path()) { return Err(ERROR.into()); }
    authorized.to_str().map(str::to_owned).ok_or_else(|| ERROR.into())
}

#[tauri::command]
pub fn claim_native_project_media_root<R: Runtime>(webview: Webview<R>, project_id: String, project_name: Option<String>) -> Result<String, String> {
    media_root(&webview, &project_id, true, false, project_name.as_deref())
}

/// 可重新选择已有绑定的物理根。预检只读原生登记与原目录标记。
#[tauri::command]
pub fn verify_native_project_storage_root<R: Runtime>(webview: Webview<R>, base_data_dir: Option<String>, project_ids: Vec<String>) -> Result<(), String> {
    if webview.label() != "main" || project_ids.len() > 200_000 { return Err(ERROR.into()); }
    ensure_trusted_caller(&webview).map_err(|_| ERROR)?;
    if project_ids.is_empty() { return Ok(()); }
    let app = webview.app_handle();
    let base = match base_data_dir.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => crate::path_policy::resolve_user_storage_root(app, path).ok_or(ERROR)?,
        None => app.path().app_data_dir().map_err(|_| ERROR)?.join("data"),
    };
    plain_chain(&base)?;
    let base = canonicalize_simplified(&base).map_err(|_| ERROR)?;
    let registry = crate::project_model_safety::private_root(app)?.join(REGISTRY_DIR);
    plain_chain(&registry)?;
    for id in project_ids { bind_root(&base, &registry, &id, false, None)?; }
    Ok(())
}

#[tauri::command]
pub fn resolve_native_project_media_root<R: Runtime>(webview: Webview<R>, project_id: String) -> Result<String, String> {
    media_root(&webview, &project_id, false, false, None)
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_project_media_import_root<R: Runtime>(webview: &Webview<R>, owner_id: &str, raw: &str) -> Result<PathBuf, String> {
    let app = webview.app_handle();
    let target = crate::path_policy::authorize_existing_plain_directory(app, raw)?;
    if target.parent() != Some(media_base(app, false)?.as_path()) { return Err(ERROR.into()); }
    if owner_id.starts_with("p2-") {
        if target != PathBuf::from(media_root(webview, owner_id, false, false, None)?) { return Err(ERROR.into()); }
    } else if !matches!(fs::symlink_metadata(target.join(".ai-canvas-native-project.json")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
        return Err(ERROR.into());
    }
    Ok(target)
}

#[cfg(target_os = "macos")]
pub(crate) use unix_io::publish_project_media_stream;

fn check_recycle_root(target: &Path, authorized: &Path, expected_path: &str) -> Result<(), String> {
    if target != authorized || target.to_str() != Some(expected_path) { return Err(ERROR.into()); }
    plain_chain(target)
}

fn recycle_roots_overlap(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    let (left, right) = (PathBuf::from(left.to_string_lossy().to_lowercase()), PathBuf::from(right.to_string_lossy().to_lowercase()));
    left.starts_with(&right) || right.starts_with(&left)
}

fn check_protected_recycle_roots(target: &Path, protected_roots: &[PathBuf]) -> Result<(), String> {
    for path in protected_roots {
        if !path.is_absolute() { return Err(ERROR.into()); }
        // 再解析一次，避免目录登记之后新增或改指的文件夹链接绕过保护。
        let resolved = canonicalize_simplified(path).map_err(|_| ERROR)?;
        if recycle_roots_overlap(target, &resolved) { return Err("项目目录仍被资源库引用，原有文件已保留".into()); }
    }
    Ok(())
}

/// 实际回收前仍须使用主窗口、当前储存根及同一份原生目录登记。
pub(crate) fn recycle_native_project_media_root<R: Runtime>(webview: &Webview<R>, project_id: &str, expected_path: &str) -> Result<(), String> {
    if !root_caller_allowed(webview.label(), false, false) { return Err(ERROR.into()); }
    ensure_trusted_caller(webview).map_err(|_| ERROR)?;
    let app = webview.app_handle();
    let base = media_base(app, false)?;
    let registry = crate::project_model_safety::private_root(app)?.join(REGISTRY_DIR);
    with_bound_root(&base, &registry, project_id, false, None, |target| {
        let roots = app.try_state::<NativeProjectRecycleRoots>().ok_or(ERROR)?;
        let protected = roots.0.lock().map_err(|_| ERROR)?;
        check_protected_recycle_roots(&target, protected.as_deref().ok_or(ERROR)?)?;
        if media_base(app, false)? != base || target.parent() != Some(base.as_path()) { return Err(ERROR.into()); }
        let authorized = authorize_path(app, expected_path, PathAccess::Write).map_err(|_| ERROR)?;
        check_recycle_root(&target, &authorized, expected_path)?;
        move_owned_root_to_recycle_bin(&target)?;
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(RECYCLE_ERROR.into()),
        }
    })
}

#[cfg(windows)]
fn move_owned_root_to_recycle_bin(target: &Path) -> Result<(), String> {
    use std::{os::windows::ffi::OsStrExt, path::{Component, Prefix}};
    use windows::{core::PCWSTR, Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED},
        UI::Shell::{FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
            FOF_NOERRORUI, FOF_SILENT, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE},
    }};
    if !matches!(target.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))) {
        return Err(RECYCLE_ERROR.into());
    }
    let wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // 仅在本次初始化成功时平衡 COM 引用，已经初始化的异线程模型保持原状。
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.is_err() && initialized != RPC_E_CHANGED_MODE { return Err(RECYCLE_ERROR.into()); }
    // FOFX_RECYCLEONDELETE 要求回收；不给 Shell 确认永久删除，也不作永久删除兜底。
    let aborted = (|| -> windows::core::Result<bool> {
        // SAFETY: COM 已初始化，wide 在 Shell 解析路径期间保持有效且以 NUL 结尾。
        unsafe {
            let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
            operation.SetOperationFlags(FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE | FOF_NOERRORUI | FOF_SILENT)?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
            operation.DeleteItem(&item, None)?;
            operation.PerformOperations()?;
            Ok(operation.GetAnyOperationsAborted()?.as_bool())
        }
    })();
    if initialized.is_ok() { unsafe { CoUninitialize() }; }
    if matches!(aborted, Ok(false)) { Ok(()) } else { Err(RECYCLE_ERROR.into()) }
}

#[cfg(not(windows))]
fn move_owned_root_to_recycle_bin(target: &Path) -> Result<(), String> {
    trash::delete(target).map_err(|_| RECYCLE_ERROR.into())
}

#[tauri::command]
pub fn sync_native_asset_search_roots<R: Runtime>(webview: Webview<R>, project_ids: Vec<String>) -> Result<(), String> {
    if webview.label() != "main" { return Err(ERROR.into()); }
    ensure_trusted_caller(&webview).map_err(|_| ERROR)?;
    let state = webview.app_handle().state::<AssetSearchNativeRoots>();
    let mut allowed = state.0.lock().map_err(|_| ERROR)?;
    if project_ids.len() > 200_000 || project_ids.iter().any(|id| !valid_id(id, "p2")) { allowed.clear(); return Err(ERROR.into()); }
    *allowed = project_ids.into_iter().collect();
    Ok(())
}

#[tauri::command]
pub fn resolve_asset_search_native_project_root<R: Runtime>(webview: Webview<R>, project_id: String) -> Result<String, String> {
    ensure_trusted_caller(&webview).map_err(|_| ERROR)?;
    let state = webview.app_handle().state::<AssetSearchNativeRoots>();
    let allowed = state.0.lock().map_err(|_| ERROR)?;
    if !search_root_allowed(webview.label(), &project_id, &allowed) { return Err(ERROR.into()); }
    let result = media_root(&webview, &project_id, false, true, None);
    drop(allowed);
    result
}

/// 只接受主窗口为已核验画布创建的会话；替换会撤销旧会话。
#[tauri::command]
pub fn bind_video_editor_native_root<R: Runtime>(webview: Webview<R>, project_id: String, canvas_id: String, session_id: String) -> Result<(), String> {
    if webview.label() != "main" || !valid_id(&project_id, "p2") || !valid_id(&canvas_id, "c2")
        || session_id.len() != 36 || !session_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') { return Err(ERROR.into()); }
    ensure_trusted_caller(&webview).map_err(|_| ERROR)?;
    media_root(&webview, &project_id, false, false, None)?;
    let state = webview.app_handle().state::<VideoEditorNativeRoot>();
    *state.0.lock().map_err(|_| ERROR)? = Some(VideoEditorLease { project_id, canvas_id, session_id });
    Ok(())
}

#[tauri::command]
pub fn revoke_video_editor_native_root<R: Runtime>(webview: Webview<R>, session_id: String) -> Result<(), String> {
    if webview.label() != "main" { return Err(ERROR.into()); }
    ensure_trusted_caller(&webview).map_err(|_| ERROR)?;
    let state = webview.app_handle().state::<VideoEditorNativeRoot>();
    let mut lease = state.0.lock().map_err(|_| ERROR)?;
    if lease.as_ref().is_some_and(|entry| entry.session_id == session_id) { *lease = None; }
    Ok(())
}

#[tauri::command]
pub fn resolve_video_editor_native_root<R: Runtime>(webview: Webview<R>, project_id: String, canvas_id: String, session_id: String) -> Result<String, String> {
    if webview.label() != "video-editor" { return Err(ERROR.into()); }
    ensure_local_frontend_caller(&webview).map_err(|_| ERROR)?;
    let state = webview.app_handle().state::<VideoEditorNativeRoot>();
    let lease = state.0.lock().map_err(|_| ERROR)?;
    if !editor_root_allowed(webview.label(), &project_id, &canvas_id, &session_id, lease.as_ref()) {
        return Err(ERROR.into());
    }
    media_root(&webview, &project_id, false, true, None)
}

#[tauri::command]
pub fn resolve_native_project_media_subroot<R: Runtime>(webview: Webview<R>, project_id: String, root_ref: String, create: bool) -> Result<String, String> {
    if !valid_id(&root_ref, "r2") { return Err(ERROR.into()); }
    let root = PathBuf::from(media_root(&webview, &project_id, false, false, None)?);
    let parent = root.join("roots");
    if create { directory(&parent)?; }
    plain_dir(&parent)?;
    let child = parent.join(root_ref);
    if create { fs::create_dir(&child).map_err(|_| ERROR)?; }
    plain_chain(&child)?;
    let authorized = authorize_path(webview.app_handle(), child.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR)?;
    let actual_parent = authorize_path(webview.app_handle(), parent.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR)?;
    if authorized.parent() != Some(actual_parent.as_path()) || actual_parent.parent() != Some(root.as_path()) { return Err(ERROR.into()); }
    if media_root(&webview, &project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
    authorized.to_str().map(str::to_owned).ok_or_else(|| ERROR.into())
}

// Windows: keep every ancestor open without FILE_SHARE_WRITE or FILE_SHARE_DELETE.
// The media directory may share writes only while a no-share staging file pins it
// nonempty for publication; it never shares DELETE. OPEN_REPARSE_POINT inspects
// the entry itself; conflicting existing handles fail closed.
#[cfg(windows)]
pub(crate) fn lease_directory(path: &Path, share_write: bool) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let sharing = FILE_SHARE_READ.0 | if share_write { FILE_SHARE_WRITE.0 } else { 0 };
    let file = OpenOptions::new().read(true).custom_flags(0x02000000 | 0x00200000)
        .share_mode(sharing).open(path).map_err(|_| ERROR)?;
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_dir() { return Err(ERROR.into()); }
    Ok(file)
}

#[cfg(windows)]
fn lease_media_directory<R: Runtime>(webview: &Webview<R>, project_id: &str, create: bool) -> Result<(PathBuf, Vec<File>), String> {
    let root = PathBuf::from(media_root(webview, project_id, false, false, None)?);
    let mut leases = Vec::new();
    for ancestor in root.ancestors().collect::<Vec<_>>().into_iter().rev().filter(|p| !p.as_os_str().is_empty()) {
        leases.push(lease_directory(ancestor, false)?);
    }
    // Once all ancestors are leased, the ownership marker is rechecked against the
    // current native configuration before any project content is touched.
    if media_root(webview, project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
    let media = root.join("media");
    if create { directory(&media)?; }
    leases.push(lease_directory(&media, false)?);
    plain_chain(&media)?;
    if media_root(webview, project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
    Ok((media, leases))
}

#[cfg(windows)]
fn read_media_file(path: &Path, reference: &NativeMediaReference) -> Result<Vec<u8>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = OpenOptions::new().read(true).custom_flags(0x00200000).share_mode(0x00000001)
        .open(path).map_err(|_| ERROR)?;
    verify_windows_media_file(&file, reference)
}

#[cfg(windows)]
fn verify_windows_media_file(file: &File, reference: &NativeMediaReference) -> Result<Vec<u8>, String> {
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len() != reference.bytes { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    file.take(reference.bytes + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 != reference.bytes || file.metadata().map_err(|_| ERROR)?.len() != reference.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != reference.sha256 { return Err(ERROR.into()); }
    Ok(bytes)
}

#[cfg(windows)]
fn windows_staging_metadata(file: &File, limit: u64) -> Result<fs::Metadata, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION}};
    let metadata = file.metadata().map_err(|_| ERROR)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }.map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > limit || information.nNumberOfLinks != 1 {
        return Err(ERROR.into());
    }
    Ok(metadata)
}

#[cfg(windows)]
pub(crate) fn rename_windows_media_file(file: &File, destination: &Path) -> Result<(), String> {
    use std::{mem::{offset_of, size_of}, os::windows::{ffi::OsStrExt, io::AsRawHandle}, ptr};
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{
        FILE_RENAME_INFO, FileRenameInfo, SetFileInformationByHandle,
    }};
    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    if !destination.is_absolute() || name.contains(&0) { return Err(ERROR.into()); }
    let name_bytes = name.len().checked_mul(size_of::<u16>()).ok_or(ERROR)?;
    let total = offset_of!(FILE_RENAME_INFO, FileName).checked_add(name_bytes)
        .and_then(|size| size.checked_add(size_of::<u16>())).ok_or(ERROR)?;
    let total_bytes = u32::try_from(total).map_err(|_| ERROR)?;
    let name_bytes = u32::try_from(name_bytes).map_err(|_| ERROR)?;
    let mut storage = vec![0_usize; total.max(size_of::<FILE_RENAME_INFO>()).div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: an aligned, zeroed rename record leaves ReplaceIfExists false. The tail
    // holds the wide path and a zero terminator. The open DELETE handle identifies the
    // exact source, and the caller keeps the common parent path leased.
    unsafe {
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = name_bytes;
        ptr::copy_nonoverlapping(name.as_ptr(), ptr::addr_of_mut!((*info).FileName).cast(), name.len());
        SetFileInformationByHandle(HANDLE(file.as_raw_handle()), FileRenameInfo, info.cast(), total_bytes)
    }.map_err(|_| ERROR.into())
}

/// Old builds could leave a short write under the final digest. Preserve only a verified
/// strict byte prefix as a recoverable side file. Every ambiguous destination stays put.
#[cfg(windows)]
fn isolate_windows_media_partial(target: &Path, data: &[u8]) -> Result<bool, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_READ};
    let file = match OpenOptions::new().read(true).access_mode(FILE_GENERIC_READ.0 | DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).share_mode(FILE_SHARE_READ.0).open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(ERROR.into()),
    };
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len() > data.len() as u64 { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    (&file).take(data.len() as u64 + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 != metadata.len() || !data.starts_with(&bytes) { return Err(ERROR.into()); }
    if bytes.len() == data.len() { return Ok(true); }
    let recovered = format!(".native-media-{}.pending", crate::comfyui::media_source::new_id().map_err(|_| ERROR)?);
    rename_windows_media_file(&file, &target.with_file_name(recovered))?;
    Ok(false)
}

#[cfg(windows)]
fn write_windows_media_file(media: &Path, media_lease: &mut File, name: &str, reference: &NativeMediaReference, data: &[u8],
    verify_binding: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    let target = media.join(name);
    if read_media_file(&target, reference).is_ok_and(|bytes| bytes == data) { return Ok(()); }
    let temporary = media.join(format!(".native-media-{}.pending", validate_media_reference(reference)?));
    let open_staging = |create_new| OpenOptions::new().read(true).write(true).create_new(create_new)
        .access_mode(FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_WRITE_THROUGH.0)
        .share_mode(0).open(&temporary);
    let mut file = match open_staging(true) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open_staging(false).map_err(|_| ERROR)?,
        Err(_) => return Err(ERROR.into()),
    };
    resume_media_staging_file(&mut file, reference, data, windows_staging_metadata)?;
    if verify_windows_media_file(&file, reference)? != data { return Err(ERROR.into()); }
    verify_binding()?;

    // Rename opens its target directory with FILE_WRITE_DATA. A read-only share
    // lease would block our own publication. The no-share staging handle keeps
    // media nonempty (so it cannot become a reparse point) throughout this phase.
    // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
    // https://learn.microsoft.com/windows/win32/fileio/reparse-points
    // Open each replacement before dropping the previous directory lease.
    *media_lease = lease_directory(media, true)?;
    let publication = (|| {
        // A different writer can publish valid identical bytes while this stage is open.
        let existing = match isolate_windows_media_partial(&target, data) {
            Ok(existing) => existing,
            Err(_) if read_media_file(&target, reference).is_ok_and(|bytes| bytes == data) => true,
            Err(error) => return Err(error),
        };
        let published = !existing && rename_windows_media_file(&file, &target).is_ok();
        if published { file.sync_all().map_err(|_| ERROR)?; }
        Ok(())
    })();
    // Restore the strong lease even after publication fails, before releasing
    // the pinned file or doing another path-based read. Failure stops all I/O.
    *media_lease = lease_directory(media, false)?;
    publication?;
    drop(file);
    if read_media_file(&target, reference)? == data { Ok(()) } else { Err(ERROR.into()) }
}

// macOS and the two supported Linux desktop ABIs have distinct fcntl constants.
// Keep this boundary dependency-free, as with project_archive's exclusive Unix publication.
#[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
pub(crate) use unix_io::AnchoredDirectory;

#[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
mod unix_io {
    use super::*;
    use std::{ffi::{CString, OsStr}, fs::File, io::{Seek, SeekFrom}, os::{fd::{AsRawFd, FromRawFd},
        raw::{c_char, c_int, c_uint}, unix::{ffi::OsStrExt, fs::{MetadataExt, OpenOptionsExt}}}, path::Component};

    // Constants follow Apple xnu bsd/sys/fcntl.h and Linux arch/{x86,arm64}/...
    // fcntl.h; arm64 deliberately differs from x86_64 for directory/no-follow.
    #[cfg(target_os = "macos")]
    const FLAGS: (c_int, c_int, c_int, c_int, c_int, c_int) = (0x100, 0x100000, 0x1000000, 0x200, 0x800, 0x4);
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    const FLAGS: (c_int, c_int, c_int, c_int, c_int, c_int) = (0x20000, 0x10000, 0x80000, 0x40, 0x80, 0x800);
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    const FLAGS: (c_int, c_int, c_int, c_int, c_int, c_int) = (0x8000, 0x4000, 0x80000, 0x40, 0x80, 0x800);
    const NOFOLLOW: c_int = FLAGS.0;
    const DIRECTORY: c_int = FLAGS.1;
    const CLOEXEC: c_int = FLAGS.2;
    const CREATE: c_int = FLAGS.3;
    const EXCLUSIVE: c_int = FLAGS.4;
    const NONBLOCK: c_int = FLAGS.5;
    #[cfg(target_os = "macos")]
    type Mode = u16;
    #[cfg(target_os = "linux")]
    type Mode = u32;

    extern "C" {
        fn openat(directory: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        fn mkdirat(directory: c_int, path: *const c_char, mode: Mode) -> c_int;
        #[cfg(target_os = "macos")]
        fn renameatx_np(from_dir: c_int, from: *const c_char, to_dir: c_int, to: *const c_char, flags: c_uint) -> c_int;
        fn unlinkat(directory: c_int, path: *const c_char, flags: c_int) -> c_int;
        #[cfg(target_os = "linux")]
        fn renameat2(from_dir: c_int, from: *const c_char, to_dir: c_int, to: *const c_char, flags: c_uint) -> c_int;
    }

    fn component(name: &OsStr) -> Result<CString, String> {
        let bytes = name.as_bytes();
        if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') { return Err(ERROR.into()); }
        CString::new(bytes).map_err(|_| ERROR.into())
    }

    fn open_at(directory: &File, name: &OsStr, extra: c_int, create: bool) -> std::io::Result<File> {
        let name = component(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let flags = NOFOLLOW | CLOEXEC | NONBLOCK | extra;
        // SAFETY: the descriptor is borrowed for this call; the component is NUL-terminated.
        // A successful descriptor is immediately transferred to exactly one owning File.
        let descriptor = unsafe {
            if create { openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o600 as c_uint) }
            else { openat(directory.as_raw_fd(), name.as_ptr(), flags) }
        };
        if descriptor < 0 { return Err(std::io::Error::last_os_error()); }
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    fn same_file(left: &File, right: &File) -> Result<bool, String> {
        let left = left.metadata().map_err(|_| ERROR)?;
        let right = right.metadata().map_err(|_| ERROR)?;
        Ok(left.dev() == right.dev() && left.ino() == right.ino())
    }

    fn open_chain(path: &Path) -> Result<Vec<File>, String> {
        let mut parts = path.components();
        if parts.next() != Some(Component::RootDir) { return Err(ERROR.into()); }
        let root = OpenOptions::new().read(true).custom_flags(NOFOLLOW | CLOEXEC | DIRECTORY).open("/").map_err(|_| ERROR)?;
        let mut chain = vec![root];
        for part in parts {
            let Component::Normal(name) = part else { return Err(ERROR.into()); };
            let file = open_at(chain.last().ok_or(ERROR)?, name, DIRECTORY, false).map_err(|_| ERROR)?;
            if !file.metadata().map_err(|_| ERROR)?.is_dir() { return Err(ERROR.into()); }
            chain.push(file);
        }
        Ok(chain)
    }

    fn verify_chain(path: &Path, original: &[File]) -> Result<(), String> {
        let current = open_chain(path)?;
        if current.len() != original.len() { return Err(ERROR.into()); }
        for (expected, actual) in original.iter().zip(&current) {
            if !same_file(expected, actual)? { return Err(ERROR.into()); }
        }
        Ok(())
    }

    pub(crate) struct AnchoredDirectory {
        path: PathBuf,
        chain: Vec<File>,
    }

    impl AnchoredDirectory {
        pub(crate) fn open(path: &Path) -> Result<Self, String> {
            Ok(Self { path: path.to_owned(), chain: open_chain(path)? })
        }

        fn directory(&self) -> &File {
            self.chain.last().expect("open_chain always retains the root directory")
        }

        pub(crate) fn verify(&self) -> Result<(), String> {
            verify_chain(&self.path, &self.chain)
        }

        pub(crate) fn identity(&self) -> std::io::Result<file_id::FileId> {
            let metadata = self.directory().metadata()?;
            Ok(file_id::FileId::new_inode(metadata.dev(), metadata.ino()))
        }

        pub(crate) fn open_file(&self, name: &OsStr) -> std::io::Result<File> {
            open_at(self.directory(), name, 0, false)
        }

        pub(crate) fn create_file(&self, name: &OsStr) -> std::io::Result<File> {
            open_at(self.directory(), name, 2 | CREATE | EXCLUSIVE, true)
        }

        pub(crate) fn remove_file(&self, name: &OsStr) -> Result<(), String> {
            let name = component(name)?;
            // SAFETY: The descriptor stays open and the name is one validated component.
            if unsafe { unlinkat(self.directory().as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(ERROR.into());
            }
            Ok(())
        }

        pub(crate) fn rename_file(&self, from: &OsStr, to: &OsStr, exchange: bool) -> Result<(), String> {
            let from = component(from)?;
            let to = component(to)?;
            let directory = self.directory().as_raw_fd();
            // SAFETY: Both names are validated and relative to the same live directory.
            #[cfg(target_os = "macos")]
            let result = unsafe { renameatx_np(directory, from.as_ptr(), directory, to.as_ptr(), if exchange { 0x2 } else { 0x4 }) };
            #[cfg(target_os = "linux")]
            let result = unsafe { renameat2(directory, from.as_ptr(), directory, to.as_ptr(), if exchange { 2 } else { 1 }) };
            if result != 0 { return Err(ERROR.into()); }
            Ok(())
        }

        pub(crate) fn sync(&self) -> std::io::Result<()> {
            self.directory().sync_all()
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn publish_project_media_stream<G>(root: &Path, reader: &mut impl Read, bytes: u64,
        stem: &str, extension: &str, mut check_current: impl FnMut() -> Result<(), String>,
        acquire_commit: impl FnOnce() -> Result<G, String>) -> Result<String, String> {
        use std::time::{Duration, Instant};

        let failure = "未能写入作品素材，原有文件已保留";
        let random = crate::secure_random::random_bytes::<32>().map_err(|_| failure)?;
        let temporary = format!(".native-media-{:x}.pending", Sha256::digest(random));
        let temporary = OsStr::new(&temporary);
        let chain = open_chain(root)?;
        let directory = chain.last().ok_or(failure)?;
        crate::file_transfer::ensure_disk_space(root, Some(bytes))?;
        check_current()?;
        let mut file = open_at(directory, temporary, 2 | CREATE | EXCLUSIVE, true).map_err(|_| failure)?;
        let mut owned_name = Some(temporary.to_owned());
        let result = (|| {
            let mut digest = Sha256::new();
            let mut copied = 0_u64;
            let mut buffer = vec![0; 256 * 1024];
            let mut checked_at = Instant::now();
            loop {
                let read = reader.read(&mut buffer).map_err(|_| "WSAGENT 媒体下载中断，请重试")?;
                if read == 0 { break; }
                copied = copied.checked_add(read as u64).filter(|size| *size <= bytes).ok_or("WSAGENT 媒体大小不匹配")?;
                if checked_at.elapsed() >= Duration::from_millis(250) {
                    check_current()?;
                    checked_at = Instant::now();
                }
                file.write_all(&buffer[..read]).map_err(|_| failure)?;
                digest.update(&buffer[..read]);
            }
            if copied != bytes { return Err("WSAGENT 媒体下载不完整，请重试".into()); }
            file.sync_all().map_err(|_| failure)?;
            let digest = format!("{:x}", digest.finalize());
            let file_name = format!("{stem}-{}.{extension}", &digest[..16]);
            let target_name = OsStr::new(&file_name);

            let existing = match open_at(directory, target_name, 0, false) {
                Ok(mut target) => {
                    if regular_metadata(&target, bytes)?.len() != bytes { return Err(failure.into()); }
                    let mut target_digest = Sha256::new();
                    let count = std::io::copy(&mut (&mut target).take(bytes + 1), &mut target_digest).map_err(|_| failure)?;
                    if count != bytes || format!("{:x}", target_digest.finalize()) != digest { return Err(failure.into()); }
                    Some(target)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err(failure.into()),
            };

            let _lease = acquire_commit()?;
            verify_chain(root, &chain)?;
            if let Some(existing) = existing {
                let current = open_at(directory, target_name, 0, false).map_err(|_| failure)?;
                if !same_file(&existing, &current)? { return Err(failure.into()); }
                return Ok(file_name);
            }
            let staged = open_at(directory, temporary, 0, false).map_err(|_| failure)?;
            if !same_file(&file, &staged)? || regular_metadata(&staged, bytes)?.len() != bytes { return Err(failure.into()); }
            let from = component(temporary)?;
            let to = component(target_name)?;
            // SAFETY: both names are validated components anchored to the same live directory.
            if unsafe { renameatx_np(directory.as_raw_fd(), from.as_ptr(), directory.as_raw_fd(), to.as_ptr(), 0x4) } != 0 {
                return Err(failure.into());
            }
            owned_name = Some(target_name.to_owned());
            directory.sync_all().map_err(|_| failure)?;
            let published = open_at(directory, target_name, 0, false).map_err(|_| failure)?;
            if !same_file(&file, &published)? { return Err(failure.into()); }
            verify_chain(root, &chain)?;
            owned_name = None;
            Ok(file_name)
        })();

        if let Some(name) = owned_name {
            if open_at(directory, &name, 0, false).ok().and_then(|current| same_file(&file, &current).ok()) == Some(true) {
                let name = component(&name)?;
                // SAFETY: name is one component and the descriptor belongs to the anchored directory.
                let _ = unsafe { unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
            }
        }
        result
    }

    fn regular_metadata(file: &File, limit: u64) -> Result<fs::Metadata, String> {
        let metadata = file.metadata().map_err(|_| ERROR)?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > limit { return Err(ERROR.into()); }
        Ok(metadata)
    }

    fn read_binding_file(file: &mut File) -> Result<Binding, String> {
        let before = regular_metadata(file, 4096)?;
        file.seek(SeekFrom::Start(0)).map_err(|_| ERROR)?;
        let mut bytes = Vec::new();
        (&mut *file).take(4097).read_to_end(&mut bytes).map_err(|_| ERROR)?;
        if bytes.len() as u64 != before.len() || regular_metadata(file, 4096)?.len() != before.len() { return Err(ERROR.into()); }
        serde_json::from_slice(&bytes).map_err(|_| ERROR.into())
    }

    pub(super) struct Directory {
        path: PathBuf,
        chain: Vec<File>,
        media: File,
        marker: File,
        binding: Binding,
    }

    impl Directory {
        pub(super) fn open(path: &Path, create: bool) -> Result<Self, String> {
            let chain = open_chain(path)?;
            let root = chain.last().ok_or(ERROR)?;
            let mut marker = open_at(root, OsStr::new(".ai-canvas-native-project.json"), 0, false).map_err(|_| ERROR)?;
            let binding = read_binding_file(&mut marker)?;
            if create {
                let name = component(OsStr::new("media"))?;
                // SAFETY: root remains owned by chain and name is one validated component.
                if unsafe { mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists { return Err(ERROR.into()); }
            }
            let media = open_at(root, OsStr::new("media"), DIRECTORY, false).map_err(|_| ERROR)?;
            let directory = Self { path: path.to_owned(), chain, media, marker, binding };
            directory.verify()?;
            if create { directory.chain.last().ok_or(ERROR)?.sync_all().map_err(|_| ERROR)?; }
            Ok(directory)
        }

        pub(super) fn verify(&self) -> Result<(), String> {
            // Unix directory descriptors do not lock names in place. Reopen every component
            // and fail closed if the authorized pathname no longer denotes the anchored objects.
            verify_chain(&self.path, &self.chain)?;
            let root = self.chain.last().ok_or(ERROR)?;
            let current_media = open_at(root, OsStr::new("media"), DIRECTORY, false).map_err(|_| ERROR)?;
            if !same_file(&self.media, &current_media)? { return Err(ERROR.into()); }
            let mut marker = open_at(root, OsStr::new(".ai-canvas-native-project.json"), 0, false).map_err(|_| ERROR)?;
            if !same_file(&self.marker, &marker)? || read_binding_file(&mut marker)? != self.binding { return Err(ERROR.into()); }
            Ok(())
        }

        fn read_opened(&self, name: &OsStr, file: &mut File, reference: &NativeMediaReference) -> Result<Vec<u8>, String> {
            let before = regular_metadata(file, reference.bytes)?;
            if before.len() != reference.bytes { return Err(ERROR.into()); }
            file.seek(SeekFrom::Start(0)).map_err(|_| ERROR)?;
            let mut bytes = Vec::new();
            (&mut *file).take(reference.bytes + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
            if bytes.len() as u64 != reference.bytes || regular_metadata(file, reference.bytes)?.len() != reference.bytes
                || format!("{:x}", Sha256::digest(&bytes)) != reference.sha256 { return Err(ERROR.into()); }
            let current = open_at(&self.media, name, 0, false).map_err(|_| ERROR)?;
            if !same_file(file, &current)? { return Err(ERROR.into()); }
            self.verify()?;
            Ok(bytes)
        }

        pub(super) fn read(&self, name: &str, reference: &NativeMediaReference) -> Result<Vec<u8>, String> {
            self.verify()?;
            let name = OsStr::new(name);
            let mut file = open_at(&self.media, name, 0, false).map_err(|_| ERROR)?;
            self.read_opened(name, &mut file, reference)
        }

        pub(super) fn write(&self, name: &str, reference: &NativeMediaReference, data: &[u8]) -> Result<(), String> {
            self.verify()?;
            match open_at(&self.media, OsStr::new(name), 0, false) {
                Ok(mut file) => return if self.read_opened(OsStr::new(name), &mut file, reference)? == data { Ok(()) } else { Err(ERROR.into()) },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(_) => return Err(ERROR.into()),
            }
            // One stage per content identity survives failures and is resumed without
            // allocating another file. Old random stages remain untouched.
            let temporary = format!(".native-media-{}.pending", validate_media_reference(reference)?);
            let temporary_name = OsStr::new(&temporary);
            let mut file = match open_at(&self.media, temporary_name, 2 | CREATE | EXCLUSIVE, true) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open_at(&self.media, temporary_name, 2, false).map_err(|_| ERROR)?,
                Err(_) => return Err(ERROR.into()),
            };
            regular_metadata(&file, reference.bytes)?;
            FileExt::try_lock_exclusive(&file).map_err(|_| ERROR)?;
            let current = open_at(&self.media, temporary_name, 0, false).map_err(|_| ERROR)?;
            if !same_file(&file, &current)? { return Err(ERROR.into()); }
            self.verify()?;
            resume_media_staging_file(&mut file, reference, data, regular_metadata)?;
            if self.read_opened(temporary_name, &mut file, reference)? != data { return Err(ERROR.into()); }
            let from = component(temporary_name)?;
            let to = component(OsStr::new(name))?;
            // SAFETY: both names are validated single components relative to the same live
            // directory descriptor. These flags never replace an existing destination.
            #[cfg(target_os = "macos")]
            let published = unsafe { renameatx_np(self.media.as_raw_fd(), from.as_ptr(), self.media.as_raw_fd(), to.as_ptr(), 0x4) };
            #[cfg(target_os = "linux")]
            let published = unsafe { renameat2(self.media.as_raw_fd(), from.as_ptr(), self.media.as_raw_fd(), to.as_ptr(), 1) };
            if published != 0 {
                if std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists { return Err(ERROR.into()); }
                return if self.read(name, reference)? == data { Ok(()) } else { Err(ERROR.into()) };
            }
            self.media.sync_all().map_err(|_| ERROR)?;
            let current = open_at(&self.media, OsStr::new(name), 0, false).map_err(|_| ERROR)?;
            if !same_file(&file, &current)? || self.read(name, reference)? != data { return Err(ERROR.into()); }
            self.verify()
        }
    }

    pub(super) fn with_directory<R: Runtime, T>(webview: &Webview<R>, project_id: &str, create: bool,
        work: impl FnOnce(&Directory) -> Result<T, String>) -> Result<T, String> {
        let root = PathBuf::from(media_root(webview, project_id, false, false, None)?);
        let directory = Directory::open(&root, create)?;
        if media_root(webview, project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
        directory.verify()?;
        let result = work(&directory)?;
        directory.verify()?;
        if media_root(webview, project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
        directory.verify()?;
        Ok(result)
    }
}

#[tauri::command]
pub fn write_native_project_media<R: Runtime>(webview: Webview<R>, project_id: String, mime_type: String, data: Vec<u8>) -> Result<NativeMediaReference, String> {
    let (extension, limit) = media_format(&mime_type).ok_or(ERROR)?;
    if data.is_empty() || data.len() as u64 > limit { return Err(ERROR.into()); }
    if mime_type == "application/json" { serde_json::from_slice::<serde_json::Value>(&data).map_err(|_| ERROR)?; }
    if mime_type == "image/svg+xml" { crate::file_transfer::validate_svg_image_bytes(&data).map_err(|_| ERROR)?; }
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let reference = NativeMediaReference { relative_path: format!("media/{sha256}.{extension}"), sha256, bytes: data.len() as u64, mime_type };
    let name = validate_media_reference(&reference)?;
    #[cfg(windows)]
    {
        let (media, mut leases) = lease_media_directory(&webview, &project_id, true)?;
        let verify_binding = || {
            let root = media_root(&webview, &project_id, false, false, None)?;
            if media.parent() != Some(Path::new(&root)) { return Err(ERROR.into()); }
            Ok(())
        };
        write_windows_media_file(&media, leases.last_mut().ok_or(ERROR)?, &name, &reference, &data, &verify_binding)?;
        verify_binding()?;
        Ok(reference)
    }
    #[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
    { unix_io::with_directory(&webview, &project_id, true, |directory| { directory.write(&name, &reference, &data)?; Ok(reference) }) }
    #[cfg(not(any(windows, target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))))]
    { let _ = (webview, project_id, name, reference); Err(ERROR.into()) }
}

#[tauri::command]
pub fn read_native_project_media<R: Runtime>(webview: Webview<R>, project_id: String, reference: NativeMediaReference) -> Result<Vec<u8>, String> {
    let name = validate_media_reference(&reference)?;
    #[cfg(windows)]
    {
        let (media, _leases) = lease_media_directory(&webview, &project_id, false)?;
        let bytes = read_media_file(&media.join(name), &reference)?;
        media_root(&webview, &project_id, false, false, None)?;
        Ok(bytes)
    }
    #[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
    { unix_io::with_directory(&webview, &project_id, false, |directory| directory.read(&name, &reference)) }
    #[cfg(not(any(windows, target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))))]
    { let _ = (webview, project_id, name, reference); Err(ERROR.into()) }
}

#[cfg(test)]
#[path = "native_project_media/tests.rs"]
mod tests;
