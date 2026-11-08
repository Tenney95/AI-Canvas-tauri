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
        "audio/wav" => Some(("wav", IMAGE)), "audio/ogg" => Some(("ogg", IMAGE)), _ => None,
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding { version: u8, project_id: String, folder: String, base_sha256: String }

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
}

/// 所有参数均由调用方从原生配置推导；已有未知目录不会被接管。
fn bind_root(base: &Path, registry: &Path, project_id: &str, create: bool) -> Result<PathBuf, String> {
    if !valid_id(project_id, "p2") { return Err(ERROR.into()); }
    plain_chain(base)?; plain_chain(registry)?;
    let folder = format!("project-{project_id}");
    let target = base.join(&folder);
    let marker = registry.join(format!("{project_id}.json"));
    let root_marker = target.join(".ai-canvas-native-project.json");
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
    match read_binding(&marker)? {
        Some(binding) => {
            if !matches_binding(&binding, project_id, &folder, &expected_hash) {
                return Err(ERROR.into());
            }
            plain_dir(&target)?;
            if !read_binding(&root_marker)?.is_some_and(|entry| matches_binding(&entry, project_id, &folder, &expected_hash)) { return Err(ERROR.into()); }
        },
        None if create => {
            // create_dir 是独占的；中断后目录留存而凭据缺失时拒绝猜测或覆盖。
            fs::create_dir(&target).map_err(|_| ERROR)?;
            plain_dir(&target)?;
            let binding = Binding { version: 1, project_id: project_id.into(), folder: folder.clone(), base_sha256: expected_hash.clone() };
            write_binding(&root_marker, &binding)?;
            write_binding(&marker, &binding)?;
            let verified = read_binding(&marker)?.ok_or(ERROR)?;
            if !matches_binding(&verified, project_id, &folder, &expected_hash)
                || !read_binding(&root_marker)?.is_some_and(|entry| matches_binding(&entry, project_id, &folder, &expected_hash)) { return Err(ERROR.into()); }
        },
        None => return Err(ERROR.into()),
    }
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

fn media_root<R: Runtime>(webview: &Webview<R>, project_id: &str, create: bool, allow_search: bool) -> Result<String, String> {
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
    let target = bind_root(&base, &registry, project_id, create)?;
    // 配置可能在准备期间改变，不能把旧根当成当前授权。
    if media_base(app, false)? != base { return Err(ERROR.into()); }
    let authorized = authorize_path(app, target.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR)?;
    if authorized.parent() != Some(base.as_path()) { return Err(ERROR.into()); }
    authorized.to_str().map(str::to_owned).ok_or_else(|| ERROR.into())
}

#[tauri::command]
pub fn claim_native_project_media_root<R: Runtime>(webview: Webview<R>, project_id: String) -> Result<String, String> {
    media_root(&webview, &project_id, true, false)
}

#[tauri::command]
pub fn resolve_native_project_media_root<R: Runtime>(webview: Webview<R>, project_id: String) -> Result<String, String> {
    media_root(&webview, &project_id, false, false)
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
    let result = media_root(&webview, &project_id, false, true);
    drop(allowed);
    result
}

/// 只接受主窗口为已核验画布创建的会话；替换会撤销旧会话。
#[tauri::command]
pub fn bind_video_editor_native_root<R: Runtime>(webview: Webview<R>, project_id: String, canvas_id: String, session_id: String) -> Result<(), String> {
    if webview.label() != "main" || !valid_id(&project_id, "p2") || !valid_id(&canvas_id, "c2")
        || session_id.len() != 36 || !session_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') { return Err(ERROR.into()); }
    ensure_trusted_caller(&webview).map_err(|_| ERROR)?;
    media_root(&webview, &project_id, false, false)?;
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
    media_root(&webview, &project_id, false, true)
}

#[tauri::command]
pub fn resolve_native_project_media_subroot<R: Runtime>(webview: Webview<R>, project_id: String, root_ref: String, create: bool) -> Result<String, String> {
    if !valid_id(&root_ref, "r2") { return Err(ERROR.into()); }
    let root = PathBuf::from(media_root(&webview, &project_id, false, false)?);
    let parent = root.join("roots");
    if create { directory(&parent)?; }
    plain_dir(&parent)?;
    let child = parent.join(root_ref);
    if create { fs::create_dir(&child).map_err(|_| ERROR)?; }
    plain_chain(&child)?;
    let authorized = authorize_path(webview.app_handle(), child.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR)?;
    let actual_parent = authorize_path(webview.app_handle(), parent.to_str().ok_or(ERROR)?, PathAccess::Write).map_err(|_| ERROR)?;
    if authorized.parent() != Some(actual_parent.as_path()) || actual_parent.parent() != Some(root.as_path()) { return Err(ERROR.into()); }
    if media_root(&webview, &project_id, false, false)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
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
    let root = PathBuf::from(media_root(webview, project_id, false, false)?);
    let mut leases = Vec::new();
    for ancestor in root.ancestors().collect::<Vec<_>>().into_iter().rev().filter(|p| !p.as_os_str().is_empty()) {
        leases.push(lease_directory(ancestor)?);
    }
    // Once all ancestors are leased, the ownership marker is rechecked against the
    // current native configuration before any project content is touched.
    if media_root(webview, project_id, false, false)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
    let media = root.join("media");
    if create { directory(&media)?; }
    leases.push(lease_directory(&media)?);
    plain_chain(&media)?;
    if media_root(webview, project_id, false, false)? != root.to_str().ok_or(ERROR)? { return Err(ERROR.into()); }
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
        media_root(&webview, &project_id, false, false)?;
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
        media_root(&webview, &project_id, false, false)?;
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
        assert!(bind_root(&base, &registry, PROJECT, true).is_err());
        assert!(fs::read_dir(base.join(format!("project-{PROJECT}"))).unwrap().next().is_none());
        let owned = bind_root(&other, &registry, PROJECT, true).unwrap();
        assert_eq!(bind_root(&other, &registry, PROJECT, false).unwrap(), owned);
        assert!(bind_root(&base, &registry, PROJECT, false).is_err());
        fs::remove_file(owned.join(".ai-canvas-native-project.json")).unwrap();
        assert!(bind_root(&other, &registry, PROJECT, false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_identity_or_unbound_root_is_rejected() {
        let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        assert!(bind_root(&base, &registry, "../elsewhere", true).is_err());
        assert!(bind_root(&base, &registry, PROJECT, false).is_err());
        assert!(!valid_id("r2-12345678-1234-1123-8123-123456789abc", "r2"));
        assert!(valid_id("r2-12345678-1234-4123-8123-123456789abc", "r2"));
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
