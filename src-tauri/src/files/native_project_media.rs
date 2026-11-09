//! 新项目素材根的原生绑定。根目录来自已同步的用户设置，不接收 Renderer 路径。
use std::{collections::HashSet, fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
#[cfg(windows)]
use std::fs::File;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, Webview};
use crate::path_policy::{authorize_path, ensure_local_frontend_caller, ensure_trusted_caller, verified_user_storage_root, PathAccess};

const ERROR: &str = "新项目素材目录不可用或归属未能确认，原有文件已保留";
const REGISTRY_DIR: &str = "native-project-media-roots";
const MAX_PROJECT_NAME_BYTES: usize = 160;

/// 由主窗口的已核验联合目录提供；独立搜索窗口不能自行登记作品。
#[derive(Default)]
pub struct AssetSearchNativeRoots(Mutex<HashSet<String>>);

#[derive(Default)]
pub struct VideoEditorNativeRoot(Mutex<Option<VideoEditorLease>>);

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

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return true; } }
    metadata.file_type().is_symlink()
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
    let mut builder = fs::DirBuilder::new();
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
    Ok(target)
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

#[tauri::command]
pub fn resolve_native_project_media_root<R: Runtime>(webview: Webview<R>, project_id: String) -> Result<String, String> {
    media_root(&webview, &project_id, false, false, None)
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

// Windows: keep every directory open without FILE_SHARE_WRITE or FILE_SHARE_DELETE, from the filesystem
// root to the final directory. OPEN_REPARSE_POINT inspects the entry itself; if an
// existing DELETE handle prevents acquiring the lease, fail closed.
#[cfg(windows)]
fn lease_directory(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = OpenOptions::new().read(true).custom_flags(0x02000000 | 0x00200000)
        .share_mode(0x00000001).open(path).map_err(|_| ERROR)?;
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_dir() { return Err(ERROR.into()); }
    Ok(file)
}

#[cfg(windows)]
fn lease_media_directory<R: Runtime>(webview: &Webview<R>, project_id: &str, create: bool) -> Result<(PathBuf, Vec<File>), String> {
    let root = PathBuf::from(media_root(webview, project_id, false, false, None)?);
    let mut leases = Vec::new();
    for ancestor in root.ancestors().collect::<Vec<_>>().into_iter().rev().filter(|p| !p.as_os_str().is_empty()) {
        leases.push(lease_directory(ancestor)?);
    }
    // Once all ancestors are leased, the ownership marker is rechecked against the
    // current native configuration before any project content is touched.
    if media_root(webview, project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
    let media = root.join("media");
    if create { directory(&media)?; }
    leases.push(lease_directory(&media)?);
    plain_chain(&media)?;
    if media_root(webview, project_id, false, false, None)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
    Ok((media, leases))
}

#[cfg(windows)]
fn read_media_file(path: &Path, reference: &NativeMediaReference) -> Result<Vec<u8>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = OpenOptions::new().read(true).custom_flags(0x00200000).share_mode(0x00000001)
        .open(path).map_err(|_| ERROR)?;
    let metadata = file.metadata().map_err(|_| ERROR)?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len() != reference.bytes { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    (&file).take(reference.bytes + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 != reference.bytes || file.metadata().map_err(|_| ERROR)?.len() != reference.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != reference.sha256 { return Err(ERROR.into()); }
    Ok(bytes)
}

#[tauri::command]
pub fn write_native_project_media<R: Runtime>(webview: Webview<R>, project_id: String, mime_type: String, data: Vec<u8>) -> Result<NativeMediaReference, String> {
    let (extension, limit) = media_format(&mime_type).ok_or(ERROR)?;
    if data.is_empty() || data.len() as u64 > limit { return Err(ERROR.into()); }
    if mime_type == "application/json" { serde_json::from_slice::<serde_json::Value>(&data).map_err(|_| ERROR)?; }
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let reference = NativeMediaReference { relative_path: format!("media/{sha256}.{extension}"), sha256, bytes: data.len() as u64, mime_type };
    let name = validate_media_reference(&reference)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let (media, _leases) = lease_media_directory(&webview, &project_id, true)?;
        let target = media.join(name);
        match OpenOptions::new().read(true).write(true).create_new(true).custom_flags(0x00200000).share_mode(0x00000001).open(&target) {
            Ok(mut file) => {
                let info = file.metadata().map_err(|_| ERROR)?;
                if is_link(&info) || !info.is_file() { return Err(ERROR.into()); }
                file.write_all(&data).and_then(|_| file.sync_all()).map_err(|_| ERROR)?;
                drop(file);
            },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(_) => return Err(ERROR.into()),
        }
        if read_media_file(&target, &reference)? != data { return Err(ERROR.into()); }
        media_root(&webview, &project_id, false, false, None)?;
        Ok(reference)
    }
    #[cfg(not(windows))]
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
    #[cfg(not(windows))]
    { let _ = (webview, project_id, name, reference); Err(ERROR.into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PROJECT: &str = "p2-12345678-1234-4123-8123-123456789abc";

    #[test]
    fn search_roots_require_main_registration_and_exact_window() {
        let allowed = HashSet::from([PROJECT.to_string()]);
        assert!(search_root_allowed("asset-search", PROJECT, &allowed));
        assert!(!search_root_allowed("main", PROJECT, &allowed));
        assert!(!search_root_allowed("asset-search", PROJECT, &HashSet::new()));
        assert!(!search_root_allowed("asset-search", "../outside", &allowed));
        assert!(!root_caller_allowed("asset-search", true, true));
        assert!(!root_caller_allowed("asset-search", false, false));
        assert!(!root_caller_allowed("chat-assistant", false, true));
    }

    #[test]
    fn editor_root_requires_the_current_exact_lease() {
        let lease = VideoEditorLease { project_id: PROJECT.into(), canvas_id: "canvas".into(), session_id: "session".into() };
        assert!(editor_root_allowed("video-editor", PROJECT, "canvas", "session", Some(&lease)));
        assert!(!editor_root_allowed("main", PROJECT, "canvas", "session", Some(&lease)));
        assert!(!editor_root_allowed("video-editor", PROJECT, "other", "session", Some(&lease)));
        assert!(!editor_root_allowed("video-editor", PROJECT, "canvas", "old", Some(&lease)));
        assert!(!editor_root_allowed("video-editor", PROJECT, "canvas", "session", None));
        assert!(!root_caller_allowed("video-editor", true, true));
        assert!(!root_caller_allowed("video-editor", false, false));
    }

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("native-media-{}-{:?}", std::process::id(), std::thread::current().id()));
        fs::create_dir(&root).unwrap(); root.canonicalize().unwrap()
    }

    #[test]
    fn existing_unbound_directory_and_changed_root_are_never_claimed() {
        let root = fixture(); let base = root.join("base"); let other = root.join("other"); let registry = root.join("registry");
        for dir in [&base, &other, &registry] { fs::create_dir(dir).unwrap(); }
        fs::create_dir(base.join(format!("project-{PROJECT}"))).unwrap();
        assert!(bind_root(&base, &registry, PROJECT, true, None).is_err());
        assert!(fs::read_dir(base.join(format!("project-{PROJECT}"))).unwrap().next().is_none());
        let owned = bind_root(&other, &registry, PROJECT, true, None).unwrap();
        assert_eq!(bind_root(&other, &registry, PROJECT, false, None).unwrap(), owned);
        assert_eq!(bind_root(&other, &registry, PROJECT, true, Some("改名不会搬走旧目录")).unwrap(), owned);
        assert!(bind_root(&base, &registry, PROJECT, false, None).is_err());
        fs::remove_file(owned.join(".ai-canvas-native-project.json")).unwrap();
        assert!(bind_root(&other, &registry, PROJECT, false, None).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_identity_or_unbound_root_is_rejected() {
        let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        assert!(bind_root(&base, &registry, "../elsewhere", true, Some("项目")).is_err());
        assert!(bind_root(&base, &registry, PROJECT, false, None).is_err());
        assert!(!valid_id("r2-12345678-1234-1123-8123-123456789abc", "r2"));
        assert!(valid_id("r2-12345678-1234-4123-8123-123456789abc", "r2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readable_names_are_safe_bounded_utf8_components_with_the_original_uuid_suffix() {
        assert_eq!(named_folder(PROJECT, " .. 新项目结构测试 .. "), "新项目结构测试-12345678");
        assert_eq!(sanitize_project_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_project_name("\0\r\n . \t"), "project");
        for name in ["CON", "con.txt", "PRN.data", "AUX", "NUL", "COM9", "LPT¹.txt", "CONIN$"] {
            assert!(sanitize_project_name(name).starts_with('_'));
        }
        let truncated_device = format!("CON{}X", " ".repeat(MAX_PROJECT_NAME_BYTES));
        assert_eq!(sanitize_project_name(&truncated_device), "_CON");
        assert_eq!(sanitize_project_name(&sanitize_project_name(&truncated_device)), "_CON");
        let name = "新🎬".repeat(100);
        let cleaned = sanitize_project_name(&name);
        assert!(cleaned.len() <= MAX_PROJECT_NAME_BYTES);
        assert!(name.starts_with(&cleaned));
        assert!(cleaned.len() + name[cleaned.len()..].chars().next().unwrap().len_utf8() > MAX_PROJECT_NAME_BYTES);
        let binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, &name),
            base_sha256: "hash".into(), creation_nonce: Some("a".repeat(64)) };
        assert!(valid_binding(&binding, PROJECT, "hash"));
        assert_eq!(binding.folder.len(), cleaned.len() + 9);
        assert!(!matches_binding(&binding, PROJECT, &format!("project-{PROJECT}"), "hash"));
    }

    #[test]
    fn readable_binding_rejects_paths_wrong_suffixes_unsafe_names_and_unknown_versions() {
        let mut binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "项目"),
            base_sha256: "hash".into(), creation_nonce: Some("a".repeat(64)) };
        for folder in ["../项目-12345678", "/项目-12345678", "C:项目-12345678", "a/b-12345678", "a\\b-12345678",
            "CON.txt-12345678", ".项目-12345678", "项目 -12345678", "项目-87654321", "-12345678"] {
            binding.folder = folder.into(); assert!(!valid_binding(&binding, PROJECT, "hash"), "{folder}");
        }
        binding.folder = named_folder(PROJECT, "项目");
        binding.version = 3; assert!(!valid_binding(&binding, PROJECT, "hash"));
        binding.version = 1; assert!(!valid_binding(&binding, PROJECT, "hash"));
        binding.version = 2; assert!(!valid_binding(&binding, PROJECT, "other-base"));
        assert!(!valid_binding(&binding, "../project", "hash"));
        binding.folder = format!("{}-12345678", "a".repeat(MAX_PROJECT_NAME_BYTES + 1));
        assert!(!valid_binding(&binding, PROJECT, "hash"));
        binding.folder = named_folder(PROJECT, "项目");
        for nonce in [None, Some("a".repeat(63)), Some("A".repeat(64)), Some("g".repeat(64))] {
            binding.creation_nonce = nonce; assert!(!valid_binding(&binding, PROJECT, "hash"));
        }
        binding.version = 1; binding.folder = format!("project-{PROJECT}");
        binding.creation_nonce = Some("a".repeat(64)); assert!(!valid_binding(&binding, PROJECT, "hash"));
        binding.creation_nonce = None; assert!(valid_binding(&binding, PROJECT, "hash"));
        assert!(serde_json::to_value(&binding).unwrap().get("creationNonce").is_none());
    }

    #[test]
    fn new_named_roots_keep_their_binding_across_restarts_and_display_renames() {
        const SECOND: &str = "p2-87654321-1234-4123-8123-123456789abc";
        const SAME_SHORT_ID: &str = "p2-12345678-4321-4321-8321-abcdef123456";
        let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        let first = bind_root(&base, &registry, PROJECT, true, Some("新项目结构测试")).unwrap();
        assert_eq!(first, base.join("新项目结构测试-12345678"));
        fs::write(first.join("keep.txt"), b"original").unwrap();
        assert_eq!(bind_root(&base, &registry, PROJECT, false, None).unwrap(), first);
        assert_eq!(bind_root(&base, &registry, PROJECT, true, None).unwrap(), first);
        assert_eq!(bind_root(&base, &registry, PROJECT, true, Some("显示名称已变化")).unwrap(), first);
        assert!(!base.join(named_folder(PROJECT, "显示名称已变化")).exists());
        assert!(!base.join(format!("project-{PROJECT}")).exists());
        assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
        let entry = read_binding(&registry.join(format!("{PROJECT}.json"))).unwrap().unwrap();
        assert_eq!(entry.version, 2);
        assert_eq!(entry.creation_nonce.as_ref().unwrap().len(), 64);
        assert_eq!(read_binding(&registry.join(format!("{PROJECT}.lock"))).unwrap().as_ref(), Some(&entry));
        assert!(!matches_binding(&entry, PROJECT, &format!("project-{PROJECT}"), &base_hash(&base).unwrap()));
        assert_eq!(read_binding(&first.join(".ai-canvas-native-project.json")).unwrap(), Some(entry));
        let second = bind_root(&base, &registry, SECOND, true, Some("新项目结构测试")).unwrap();
        assert_eq!(second, base.join("新项目结构测试-87654321"));
        assert_ne!(first, second);
        assert!(bind_root(&base, &registry, SAME_SHORT_ID, true, Some("新项目结构测试")).is_err());
        assert!(!registry.join(format!("{SAME_SHORT_ID}.json")).exists());
        assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn occupied_named_roots_and_unbound_legacy_roots_are_not_taken_over() {
        let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        let occupied = base.join(named_folder(PROJECT, "同名项目"));
        fs::create_dir(&occupied).unwrap(); fs::write(occupied.join("keep.txt"), b"unowned").unwrap();
        assert!(bind_root(&base, &registry, PROJECT, true, Some("同名项目")).is_err());
        assert_eq!(fs::read(occupied.join("keep.txt")).unwrap(), b"unowned");
        assert!(!occupied.join(".ai-canvas-native-project.json").exists());
        assert!(!registry.join(format!("{PROJECT}.json")).exists());
        assert!(fs::read(registry.join(format!("{PROJECT}.lock"))).unwrap().is_empty());
        let old = base.join(format!("project-{PROJECT}")); fs::create_dir(&old).unwrap();
        fs::write(old.join("keep.txt"), b"legacy-failure-evidence").unwrap();
        assert!(bind_root(&base, &registry, PROJECT, true, Some("另一名称")).is_err());
        assert!(!base.join(named_folder(PROJECT, "另一名称")).exists());
        assert_eq!(fs::read(old.join("keep.txt")).unwrap(), b"legacy-failure-evidence");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_profiles_same_project_and_folder_cannot_publish_its_private_binding_over_the_original_root() {
        let root = fixture(); let base = root.join("base");
        let first_registry = root.join("profile-a"); let other_registry = root.join("profile-b");
        for directory in [&base, &first_registry, &other_registry] { fs::create_dir(directory).unwrap(); }
        let first_intent = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "同一个项目"),
            base_sha256: base_hash(&base).unwrap(), creation_nonce: Some("a".repeat(64)) };
        let other_intent = Binding { version: 2, project_id: PROJECT.into(), folder: first_intent.folder.clone(),
            base_sha256: first_intent.base_sha256.clone(), creation_nonce: Some("b".repeat(64)) };
        write_binding(&first_registry.join(format!("{PROJECT}.lock")), &first_intent).unwrap();
        write_binding(&other_registry.join(format!("{PROJECT}.lock")), &other_intent).unwrap();
        let target = bind_root(&base, &first_registry, PROJECT, true, Some("后续名称无权改变意图")).unwrap();
        fs::write(target.join("keep.txt"), b"original-profile").unwrap();
        assert!(bind_root(&base, &other_registry, PROJECT, true, Some("同一个项目")).is_err());
        assert!(!other_registry.join(format!("{PROJECT}.json")).exists());
        assert_eq!(read_binding(&other_registry.join(format!("{PROJECT}.lock"))).unwrap(), Some(other_intent));
        assert_eq!(read_binding(&target.join(".ai-canvas-native-project.json")).unwrap(), Some(first_intent));
        assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"original-profile");
        assert_eq!(bind_root(&base, &first_registry, PROJECT, false, None).unwrap(), target);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_intent_without_creation_nonce_never_adopts_an_existing_directory() {
        let root = fixture();
        for exists in [false, true] {
            let stage = root.join(if exists { "occupied" } else { "uncreated" }); fs::create_dir(&stage).unwrap();
            let base = stage.join("base"); let registry = stage.join("registry");
            fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
            let binding = Binding { version: 1, project_id: PROJECT.into(), folder: format!("project-{PROJECT}"),
                base_sha256: base_hash(&base).unwrap(), creation_nonce: None };
            write_binding(&registry.join(format!("{PROJECT}.lock")), &binding).unwrap();
            let target = base.join(&binding.folder);
            if exists {
                fs::create_dir(&target).unwrap(); write_binding(&target.join(".ai-canvas-native-project.json"), &binding).unwrap();
                assert!(bind_root(&base, &registry, PROJECT, true, Some("不能绕过旧目录")).is_err());
                assert!(!registry.join(format!("{PROJECT}.json")).exists());
            } else {
                assert_eq!(bind_root(&base, &registry, PROJECT, true, Some("旧意图仍使用原目录")).unwrap(), target);
                assert_eq!(read_binding(&registry.join(format!("{PROJECT}.json"))).unwrap(), Some(binding));
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_creation_intent_recovers_only_the_original_folder_before_or_after_root_marker() {
        let root = fixture();
        for ready in [false, true] {
            let stage = root.join(if ready { "root-ready" } else { "intent-only" });
            fs::create_dir(&stage).unwrap();
            let base = stage.join("base"); let registry = stage.join("registry");
            fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
            let binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "冻结的原始项目名"),
                base_sha256: base_hash(&base).unwrap(), creation_nonce: Some("a".repeat(64)) };
            write_binding(&registry.join(format!("{PROJECT}.lock")), &binding).unwrap();
            let target = base.join(&binding.folder);
            if ready {
                fs::create_dir(&target).unwrap(); write_binding(&target.join(".ai-canvas-native-project.json"), &binding).unwrap();
                fs::write(target.join("keep.txt"), b"original").unwrap();
            }
            assert_eq!(bind_root(&base, &registry, PROJECT, true, Some("重启后改名")).unwrap(), target);
            assert!(!base.join(named_folder(PROJECT, "重启后改名")).exists());
            assert_eq!(read_binding(&registry.join(format!("{PROJECT}.json"))).unwrap(), Some(binding));
            assert_eq!(bind_root(&base, &registry, PROJECT, false, None).unwrap(), target);
            if ready { assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"original"); }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_or_mismatched_creation_evidence_cannot_be_bypassed_by_another_name() {
        let root = fixture();
        for failure in ["partial-intent", "wrong-intent", "missing-marker", "wrong-marker"] {
            let stage = root.join(failure); fs::create_dir(&stage).unwrap();
            let base = stage.join("base"); let registry = stage.join("registry");
            fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
            let binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "首次名称"),
                base_sha256: base_hash(&base).unwrap(), creation_nonce: Some("a".repeat(64)) };
            let lock = registry.join(format!("{PROJECT}.lock"));
            if failure == "partial-intent" { fs::write(&lock, b"{\"version\":2,").unwrap(); }
            else if failure == "wrong-intent" {
                write_binding(&lock, &Binding { base_sha256: "other-base".into(), ..binding }).unwrap();
            } else {
                write_binding(&lock, &binding).unwrap();
                let target = base.join(&binding.folder); fs::create_dir(&target).unwrap();
                fs::write(target.join("keep.txt"), b"failure-evidence").unwrap();
                if failure == "wrong-marker" { write_binding(&target.join(".ai-canvas-native-project.json"),
                    &Binding { version: 1, ..binding }).unwrap(); }
            }
            let original_intent = fs::read(&lock).unwrap();
            assert!(bind_root(&base, &registry, PROJECT, true, Some("改名也不能另建")).is_err());
            assert!(!registry.join(format!("{PROJECT}.json")).exists());
            assert!(!base.join(named_folder(PROJECT, "改名也不能另建")).exists());
            assert_eq!(fs::read(lock).unwrap(), original_intent);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn media_references_never_accept_paths_or_unmapped_formats() {
        let hash = "a".repeat(64);
        let mut reference = NativeMediaReference { relative_path: format!("media/{hash}.png"), sha256: hash, bytes: 1, mime_type: "image/png".into() };
        assert!(validate_media_reference(&reference).is_ok());
        reference.relative_path = "../elsewhere.png".into();
        assert!(validate_media_reference(&reference).is_err());
        reference.relative_path = format!("media/{}.png", reference.sha256);
        reference.mime_type = "image/unknown".into();
        assert!(validate_media_reference(&reference).is_err());
        reference.mime_type = "image/png".into();
        reference.bytes = 32 * 1024 * 1024 + 1;
        assert!(validate_media_reference(&reference).is_err());
    }
}
