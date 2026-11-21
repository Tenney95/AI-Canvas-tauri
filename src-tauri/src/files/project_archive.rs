//! 项目整体导出 / 导入所用的 tar.gz 归档打包与解包。
//!
//! 归档内的文本条目（清单、项目记录、对话记录）由前端组装后原样写入，
//! 素材文件统一放在 `assets/` 前缀下，与项目数据目录一一对应。
//! 解包只把 `assets/` 下的内容落到调用方指定的目标目录，其余条目按文本返回，
//! 由前端决定如何写入 IndexedDB。

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tar::{Archive, Builder, Header};
use tauri::{AppHandle, Emitter, Runtime, Webview};
use sha2::{Digest, Sha256};

use crate::path_policy::{authorize_path, canonicalize_simplified, ensure_trusted_caller, reauthorize_existing_plain_directory, simplify_verbatim, PathAccess};

/// 归档内素材统一前缀；解包时只有该前缀下的条目会写入项目数据目录。
const ASSETS_PREFIX: &str = "assets";
/// 项目回收站是本地撤销缓存，不随项目导出。
const EXCLUDED_DIR_NAMES: [&str; 1] = [".trash"];
const AGENT_WORKSPACE_DIRECTORY: &str = ".agent-workspace";
const MAX_ARCHIVE_ENTRIES: usize = 200_000;
const MAX_EXPANDED_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// 文本条目（项目 JSON、对话 JSON）解包时的总量上限，避免异常归档撑爆内存。
const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTENSION_BYTES: u64 = 64 * 1024;
const IO_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct ProjectArchiveTextEntry {
    /// 归档内相对路径，例如 `manifest.json`
    path: String,
    content: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchivePackResult {
    asset_count: usize,
    asset_bytes: u64,
    archive_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publication_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_sha256: Option<String>,
}

static ARCHIVE_PUBLICATION_LOCK: Mutex<()> = Mutex::new(());
const PUBLICATION_ERROR: &str = "归档发布结果尚未确认，请核对原导出操作；未重复打包或覆盖文件";
const ARCHIVE_OUTPUT_OCCUPIED: &str = "project-archive-output-occupied";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchivePublicationReceipt {
    operation_id: String, publication_ref: String, output_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<ProjectArchivePackResult>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePublicationStatus {
    status: &'static str, operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    publication_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_bytes: Option<u64>,
}
struct ArchivePublicationPlan { directory: PathBuf, receipt: ArchivePublicationReceipt,
    recheck: Option<Box<dyn Fn() -> Result<(), String> + Send>> }

fn publication_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
fn publication_path(directory: &Path, id: &str, phase: &str) -> PathBuf { directory.join(format!("{id}.{phase}.json")) }
fn sync_publication_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(directory).and_then(|file| file.sync_all()).map_err(|_| PUBLICATION_ERROR)?;
    #[cfg(not(unix))]
    let _ = directory; // Windows uses MOVEFILE_WRITE_THROUGH at publication, below.
    Ok(())
}
fn sync_asset_parents(root: &Path, parent: &Path) -> Result<(), String> {
    if !parent.starts_with(root) { return Err(PUBLICATION_ERROR.into()); }
    let mut current = parent;
    loop {
        sync_publication_directory(current)?;
        if current == root { return Ok(()); }
        current = current.parent().ok_or(PUBLICATION_ERROR)?;
    }
}
fn write_publication_receipt(path: &Path, receipt: &ArchivePublicationReceipt) -> Result<(), String> {
    let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x80000000 | 0x00200000).share_mode(0); }
    let bytes = serde_json::to_vec(receipt).map_err(|_| PUBLICATION_ERROR)?;
    let temporary = path.with_extension("publishing");
    let mut file = options.open(&temporary).map_err(|_| PUBLICATION_ERROR)?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| PUBLICATION_ERROR)?;
    drop(file);
    publish_archive_exclusive(&temporary, path).map_err(|_| PUBLICATION_ERROR.into())
}

enum ExclusiveArchivePublishError {
    DestinationOccupied,
    Unconfirmed,
}

fn publish_archive_exclusive(temporary: &Path, output: &Path) -> Result<(), ExclusiveArchivePublishError> {
    use ExclusiveArchivePublishError::{DestinationOccupied, Unconfirmed};
    let parent = output.parent().ok_or(Unconfirmed)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::{HRESULT, PCWSTR}, Win32::{Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS}, Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH}}};
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = output.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_WRITE_THROUGH) }.map_err(|error| {
            let code = error.code();
            if code == HRESULT::from_win32(ERROR_ALREADY_EXISTS.0) || code == HRESULT::from_win32(ERROR_FILE_EXISTS.0) {
                DestinationOccupied
            } else {
                Unconfirmed
            }
        })?;
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(temporary, output).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists { DestinationOccupied } else { Unconfirmed }
        })?;
        sync_publication_directory(parent).map_err(|_| Unconfirmed)?;
        fs::remove_file(temporary).map_err(|_| Unconfirmed)?;
    }
    sync_publication_directory(parent).map_err(|_| Unconfirmed)
}

/// std::fs::rename 在 Unix 可替换已有空目录；导入发布必须使用平台的 no-replace 合同。
fn publish_import_directory_exclusive(temporary: &Path, output: &Path) -> Result<(), String> {
    #[cfg(windows)]
    { return publish_archive_exclusive(temporary, output).map_err(|_| PUBLICATION_ERROR.into()); }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, os::raw::{c_char, c_int, c_uint}};
        let from = CString::new(temporary.as_os_str().as_bytes()).map_err(|_| PUBLICATION_ERROR)?;
        let to = CString::new(output.as_os_str().as_bytes()).map_err(|_| PUBLICATION_ERROR)?;
        #[cfg(target_os = "linux")]
        let status = {
            extern "C" { fn renameat2(old_dir: c_int, old: *const c_char, new_dir: c_int, new: *const c_char, flags: c_uint) -> c_int; }
            // Linux uapi/linux/fs.h: RENAME_NOREPLACE=1; uapi/linux/fcntl.h: AT_FDCWD=-100.
            unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) }
        };
        #[cfg(target_os = "macos")]
        let status = {
            extern "C" { fn renamex_np(old: *const c_char, new: *const c_char, flags: c_uint) -> c_int; }
            // Apple xnu/bsd/sys/stdio.h: RENAME_EXCL=0x00000004 (macOS 10.12+).
            unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) }
        };
        if status != 0 { return Err("导入目录已存在或文件系统不能安全发布，原素材未被覆盖".into()); }
        sync_publication_directory(output.parent().ok_or(PUBLICATION_ERROR)?)?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    { let _ = (temporary, output); Err("当前系统不支持安全发布导入目录".into()) }
}
fn validate_v4_entry_names<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str)>) -> Result<(), String> {
    let entries: HashMap<&str, &str> = entries.into_iter().collect();
    let Some(manifest) = entries.get("manifest.json") else { return Ok(()); };
    let value: serde_json::Value = match serde_json::from_str(manifest) { Ok(value) => value, Err(_) => return Ok(()) };
    if value.get("formatVersion").and_then(serde_json::Value::as_u64) != Some(4) { return Ok(()); }
    const REQUIRED: [&str; 6] = ["manifest.json", "project.json", "episodes.json", "canvases.json", "contents.json", "exchange.json"];
    if REQUIRED.iter().any(|name| !entries.contains_key(name))
        || entries.keys().any(|name| !REQUIRED.contains(name) && *name != "history.json" && *name != "video-editor.json" && *name != "asset-metadata.json") {
        return Err("项目 v4 归档 JSON 条目缺失或包含未知正文".into());
    }
    Ok(())
}
fn publication_directory<R: Runtime>(app: &AppHandle<R>, create: bool) -> Result<PathBuf, String> {
    // 复用已在 fs/asset scope 与 path_policy 中禁止公开访问的维护私有根。
    let root = crate::project_model_safety::private_root(app)?;
    let directory = root.join("archive-publications");
    let chain: Vec<_> = directory.ancestors().collect();
    for path in chain.into_iter().rev().filter(|path| !path.as_os_str().is_empty()) {
        if !path.exists() {
            if !create || path != root.as_path() && path != directory.as_path() { return Err(PUBLICATION_ERROR.into()); }
            fs::create_dir(path).map_err(|_| PUBLICATION_ERROR)?;
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| PUBLICATION_ERROR)?; }
        }
        if !plain_asset_metadata(path)?.is_some_and(|metadata| metadata.is_dir()) { return Err(PUBLICATION_ERROR.into()); }
    }
    Ok(directory)
}
fn read_publication_receipt(path: &Path) -> Result<ArchivePublicationReceipt, String> {
    if !plain_asset_metadata(path)?.is_some_and(|metadata| metadata.is_file() && metadata.len() <= 64 * 1024) { return Err(PUBLICATION_ERROR.into()); }
    let bytes = fs::read(path).map_err(|_| PUBLICATION_ERROR)?;
    serde_json::from_slice(&bytes).map_err(|_| PUBLICATION_ERROR.into())
}
fn begin_publication<R: Runtime>(app: &AppHandle<R>, operation_id: &str, output: &Path) -> Result<ArchivePublicationPlan, String> {
    if !publication_id(operation_id) { return Err(PUBLICATION_ERROR.into()); }
    if output.exists() { return Err(ARCHIVE_OUTPUT_OCCUPIED.into()); }
    let directory = publication_directory(app, true)?;
    let path = publication_path(&directory, operation_id, "prepared");
    let output_path = output.to_str().ok_or(PUBLICATION_ERROR)?.to_owned();
    let publication_ref = format!("{:x}", Sha256::digest(format!("{operation_id}\0{output_path}\0{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| PUBLICATION_ERROR)?.as_nanos()).as_bytes()));
    let receipt = ArchivePublicationReceipt { operation_id: operation_id.into(), publication_ref, output_path, result: None };
    write_publication_receipt(&path, &receipt)?;
    let handle = app.clone(); let output = output.to_path_buf();
    Ok(ArchivePublicationPlan { directory, receipt, recheck: Some(Box::new(move || reauthorize_archive_path(&handle, &output, PathAccess::Write))) })
}

// 核对 prepared、ready 与实际输出的共同实现。调用方负责确定私有回执目录、持锁并提供路径授权。
fn reconcile_publication<F>(directory: &Path, operation_id: &str, publication_ref: Option<&str>, authorize: F)
    -> Result<ArchivePublicationStatus, String>
where F: Fn(&str) -> Result<PathBuf, String> {
    let unknown = |status| ArchivePublicationStatus { status, operation_id: operation_id.to_owned(), publication_ref: None,
        archive_sha256: None, archive_bytes: None };
    let prepared_path = publication_path(directory, operation_id, "prepared");
    if !prepared_path.exists() { return Ok(unknown("missing")); }
    let prepared = match read_publication_receipt(&prepared_path) { Ok(value) => value, Err(_) => return Ok(unknown("unknown")) };
    if prepared.operation_id != operation_id || publication_ref.is_some_and(|reference| reference != prepared.publication_ref.as_str()) { return Ok(unknown("unknown")); }
    let ready = match read_publication_receipt(&publication_path(directory, operation_id, "ready")) { Ok(value) => value, Err(_) => return Ok(unknown("unknown")) };
    if ready.operation_id != operation_id || ready.publication_ref != prepared.publication_ref || ready.output_path != prepared.output_path { return Ok(unknown("unknown")); }
    let Some(result) = &ready.result else { return Ok(unknown("unknown")); };
    if result.operation_id.as_deref() != Some(operation_id) || result.publication_ref.as_deref() != Some(ready.publication_ref.as_str()) { return Ok(unknown("unknown")); }
    let output = match authorize(&ready.output_path) { Ok(path) => path, Err(_) => return Ok(unknown("unknown")) };
    if !plain_asset_metadata(&output)?.is_some_and(|metadata| metadata.is_file()) { return Ok(unknown("unknown")); }
    let (bytes, digest) = match hash_file_with_limit(&output, &mut Vec::new(), MAX_EXPANDED_BYTES + MAX_TEXT_BYTES) { Ok(value) => value, Err(_) => return Ok(unknown("unknown")) };
    if result.archive_sha256.as_ref() != Some(&digest) || result.archive_bytes != bytes { return Ok(unknown("unknown")); }
    if authorize(&ready.output_path).ok().as_ref() != Some(&output) { return Ok(unknown("unknown")); }
    let completed_path = publication_path(directory, operation_id, "published");
    if !completed_path.exists() { write_publication_receipt(&completed_path, &ready)?; }
    Ok(ArchivePublicationStatus { status: "published", operation_id: operation_id.to_owned(), publication_ref: Some(ready.publication_ref),
        archive_sha256: Some(digest), archive_bytes: Some(bytes) })
}

/** 仅核对本操作私有回执绑定的原文件；不接受 Renderer 提交的新路径或重新发布。 */
#[tauri::command]
pub async fn verify_project_archive_publication<R: Runtime>(webview: Webview<R>, app: AppHandle<R>,
    operation_id: String, publication_ref: Option<String>) -> Result<ArchivePublicationStatus, String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" || !publication_id(&operation_id) { return Err(PUBLICATION_ERROR.into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ARCHIVE_PUBLICATION_LOCK.lock().map_err(|_| PUBLICATION_ERROR)?;
        let directory = match publication_directory(&app, false) { Ok(value) => value, Err(_) => return Ok(ArchivePublicationStatus {
            status: "unknown", operation_id, publication_ref: None, archive_sha256: None, archive_bytes: None }) };
        reconcile_publication(&directory, &operation_id, publication_ref.as_deref(), |path| authorize_path(&app, path, PathAccess::Read))
    }).await.map_err(|_| PUBLICATION_ERROR.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveUnpackResult {
    /// 归档内非 `assets/` 条目的原文，键为归档内相对路径。
    texts: HashMap<String, String>,
    /// 已写入目标目录的素材相对路径（正斜杠分隔）。
    asset_paths: Vec<String>,
    asset_bytes: u64,
    assets: Vec<ArchiveAssetDigest>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveAssetDigest {
    path: String, bytes: u64, sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_root_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_relative_path: Option<String>,
}
impl ArchiveAssetDigest {
    fn portable(&self) -> Self { Self { path: self.path.clone(), bytes: self.bytes, sha256: self.sha256.clone(), source_root_ref: None, source_relative_path: None } }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectArchiveSourceRoot { root_ref: String, directory: String }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectArchiveAliasCheck { root_ref: String, path: String, aliases: Vec<String>, bytes: u64, sha256: String }

fn verify_export_aliases(checks: &[ProjectArchiveAliasCheck], roots: &HashMap<String, PathBuf>) -> Result<(), String> {
    if checks.len() > MAX_ARCHIVE_ENTRIES { return Err("项目素材清单超过上限".into()); }
    let mut count = 0usize;
    for check in checks {
        count = count.checked_add(check.aliases.len()).ok_or("项目素材清单超过上限")?;
        if count > MAX_ARCHIVE_ENTRIES || check.aliases.is_empty() { return Err("项目素材清单无效".into()); }
        let root = roots.get(&check.root_ref).ok_or("素材来源根缺失")?;
        let path = normalize_archive_path(Path::new(&check.path))?;
        let source = packable_asset_file(root, &path)?.ok_or("源素材已缺失")?;
        for value in &check.aliases {
            let alias = normalize_archive_path(Path::new(value))?;
            if (!cfg!(target_os = "macos") && to_archive_text(&path).to_lowercase() != to_archive_text(&alias).to_lowercase())
                || !same_verified_asset_file(&packable_asset_file(root, &alias)?.ok_or("素材别名已缺失")?, &source)? {
                return Err("素材别名已变化，请重新捕获导出内容".into());
            }
        }
        let (bytes, digest) = hash_file(&source, &mut Vec::new())?;
        if bytes != check.bytes || digest != check.sha256 { return Err("素材已变化，请重新捕获导出内容".into()); }
    }
    Ok(())
}
fn authorize_source_roots<R: Runtime>(app: &AppHandle<R>, roots: Vec<ProjectArchiveSourceRoot>) -> Result<HashMap<String, PathBuf>, String> {
    if roots.len() > MAX_ARCHIVE_ENTRIES { return Err("素材来源根数量超过上限".into()); }
    let mut result = HashMap::new();
    for root in roots {
        if !(1..=128).contains(&root.root_ref.len())
            || !root.root_ref.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
            return Err("素材来源根身份无效".into());
        }
        let path = authorize_path(app, &root.directory, PathAccess::Read)?;
        if !plain_asset_metadata(&path)?.is_some_and(|metadata| metadata.is_dir()) || result.insert(root.root_ref, path).is_some() {
            return Err("素材来源根重复或不是普通目录".into());
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectImportAsset { path: String, destination_path: String, bytes: u64, sha256: String,
    #[serde(default)] source_root_ref: Option<String> }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress { task_id: String, transferred_bytes: u64, total_bytes: u64 }

/// 后台任务排队期间目录可能变化，开始读写前复核入口捕获的真实路径。
fn reauthorize_archive_path<R: Runtime>(app: &AppHandle<R>, path: &Path, access: PathAccess) -> Result<(), String> {
    if authorize_path(app, &path.to_string_lossy(), access)? != path {
        return Err("项目归档路径已变化，请重新操作".into());
    }
    Ok(())
}

fn hash_file(path: &Path, buffer: &mut Vec<u8>) -> Result<(u64, String), String> {
    hash_file_with_limit(path, buffer, MAX_EXPANDED_BYTES)
}
fn hash_file_with_limit(path: &Path, buffer: &mut Vec<u8>, limit: u64) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|_| "无法读取项目素材")?;
    let mut digest = Sha256::new(); let mut bytes = 0_u64;
    buffer.resize(IO_BUFFER_BYTES, 0);
    loop { let count = file.read(buffer).map_err(|_| "读取素材失败")?; if count == 0 { break; }
        digest.update(&buffer[..count]); bytes += count as u64;
        if bytes > limit { return Err("素材超过体积限制".into()); }
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn plain_asset_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取项目素材类型".into()),
    };
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse { return Err("项目素材包含链接，请先移入普通文件".into()); }
    Ok(Some(metadata))
}

fn excluded_asset_directory(name: &str, project_root: bool) -> bool {
    let matches = |expected: &str| name == expected || cfg!(windows) && name.eq_ignore_ascii_case(expected);
    EXCLUDED_DIR_NAMES.iter().any(|expected| matches(expected)) || project_root && matches(".thumbnail")
}

fn is_agent_workspace_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| name.eq_ignore_ascii_case(AGENT_WORKSPACE_DIRECTORY))
}

fn is_agent_workspace_path(path: &Path) -> bool {
    path.components().any(|component| matches!(component, Component::Normal(name) if is_agent_workspace_name(name)))
}

fn require_packable_asset_path(path: &Path) -> Result<(), String> {
    if is_agent_workspace_path(path) {
        return Err("Agent 工作目录中的文件不能作为项目素材归档".into());
    }
    Ok(())
}

/// 原生发布器的恢复材料不是附件；仅识别 media 直接子项的旧随机名与新内容摘要暂存名。
fn native_media_staging_path(relative: &Path) -> bool {
    let mut parts = relative.components();
    let (Some(Component::Normal(parent)), Some(Component::Normal(file)), None) = (parts.next(), parts.next(), parts.next()) else { return false; };
    let (Some(parent), Some(file)) = (parent.to_str(), file.to_str()) else { return false; };
    let case_aliases = cfg!(windows) || cfg!(target_os = "macos");
    if parent != "media" && !(case_aliases && parent.eq_ignore_ascii_case("media")) { return false; }
    let name = if case_aliases { file.to_ascii_lowercase() } else { file.to_string() };
    let Some(identity) = name.strip_prefix(".native-media-").and_then(|name| name.strip_suffix(".pending")) else { return false; };
    let id = match identity.split_once('.') {
        Some((id, extension)) if matches!(extension, "png" | "jpg" | "webp" | "gif" | "mp4" | "webm" | "mov"
            | "mp3" | "wav" | "ogg" | "opus" | "aac" | "flac" | "pcm" | "json") => id,
        Some(_) => return false,
        None => identity,
    };
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// 根已由宿主授权；逐组件拒绝链接，缺失项留给上层依引用位置报告。
fn selected_asset_file(root: &Path, relative: &Path) -> Result<Option<PathBuf>, String> {
    if native_media_staging_path(relative) { return Err("项目素材属于未发布的媒体暂存文件，不能归档".into()); }
    let metadata = plain_asset_metadata(root)?.ok_or("项目素材目录已缺失")?;
    if !metadata.is_dir() { return Err("项目素材根不是普通目录".into()); }
    // 与宿主授权返回值保持同一表示；Windows canonicalize 的 verbatim 前缀不改变真实归属。
    let expected_root = simplify_verbatim(root.to_path_buf());
    let root = canonicalize_simplified(root).map_err(|_| "无法解析项目素材目录")?;
    if root != expected_root { return Err("项目素材目录真实路径已变化".into()); }
    let target = root.join(relative);
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) { return Err("素材相对路径无效".into()); }
        current.push(component);
        let Some(metadata) = plain_asset_metadata(&current)? else { return Ok(None); };
        if current == target {
            if !metadata.is_file() { return Err("项目素材不是普通文件".into()); }
        } else {
            if !metadata.is_dir() { return Err("项目素材父路径不是普通目录".into()); }
            let name = component.as_os_str();
            if excluded_asset_directory(&name.to_string_lossy(), current.parent() == Some(root.as_path())) {
                return Err("项目素材位于回收站或派生缓存目录".into());
            }
        }
    }
    let resolved = canonicalize_simplified(&current).map_err(|_| "无法解析项目素材真实路径")?;
    if !resolved.starts_with(&root) { return Err("项目素材超出项目目录".into()); }
    Ok(Some(resolved))
}

fn packable_asset_file(root: &Path, relative: &Path) -> Result<Option<PathBuf>, String> {
    require_packable_asset_path(root)?;
    require_packable_asset_path(relative)?;
    let file = selected_asset_file(root, relative)?;
    if let Some(path) = &file { require_packable_asset_path(path)?; }
    Ok(file)
}

fn selected_asset_paths(paths: &[String], imports_only: bool) -> Result<Vec<PathBuf>, String> {
    if paths.len() > MAX_ARCHIVE_ENTRIES { return Err("项目素材清单超过上限".into()); }
    let mut seen = HashSet::new();
    paths.iter().map(|path| {
        let relative = normalize_archive_path(Path::new(path))?;
        let name = to_archive_text(&relative);
        if name.is_empty() || !seen.insert(name.to_lowercase()) { return Err("项目素材清单存在重复路径".into()); }
        if imports_only && !name.split_once('/').is_some_and(|(first, _)| first.eq_ignore_ascii_case("imports")) {
            return Err("导入素材清单必须属于 imports 目录".into());
        }
        Ok(relative)
    }).collect()
}

struct AssetScan {
    root: PathBuf,
    rows: Vec<ArchiveAssetDigest>,
    real_files: HashSet<PathBuf>,
    bytes: u64,
    max_files: usize,
    max_bytes: u64,
    buffer: Vec<u8>,
}
impl AssetScan {
    fn add_file(&mut self, relative: &Path, include_agent_workspace: bool) -> Result<(), String> {
        let file = if include_agent_workspace { selected_asset_file(&self.root, relative)? }
            else { packable_asset_file(&self.root, relative)? };
        let Some(file) = file else { return Ok(()); };
        // canonicalize 也展开 Windows 短文件名；同一真实路径不能以多个别名进入清单。
        if !self.real_files.insert(PathBuf::from(file.to_string_lossy().to_lowercase())) { return Err("项目素材清单存在重复路径".into()); }
        if self.rows.len() >= self.max_files { return Err("项目素材数量超过上限".into()); }
        let metadata = fs::metadata(&file).map_err(|_| "无法读取项目素材信息")?;
        if metadata.len() > self.max_bytes.saturating_sub(self.bytes) { return Err("项目素材体积超过上限".into()); }
        let (bytes, sha256) = hash_file(&file, &mut self.buffer)?;
        self.bytes = self.bytes.checked_add(bytes).ok_or("项目素材体积无效")?;
        if self.bytes > self.max_bytes { return Err("项目素材体积超过上限".into()); }
        self.rows.push(ArchiveAssetDigest { path: to_archive_text(relative), bytes, sha256, source_root_ref: None, source_relative_path: None });
        Ok(())
    }

    fn walk(&mut self, relative: &Path, exclude_imports: bool, exclude_shared_sync: bool) -> Result<(), String> {
        if relative.components().count() > 64 { return Err("项目素材目录过深".into()); }
        for item in fs::read_dir(self.root.join(relative)).map_err(|_| "无法读取项目目录")? {
            let entry = item.map_err(|_| "无法读取素材目录项")?;
            let name = entry.file_name();
            if is_agent_workspace_name(&name) { continue; }
            if exclude_shared_sync && name.to_string_lossy().eq_ignore_ascii_case(".shared-sync") { continue; }
            let imports_directory = name.to_string_lossy().eq_ignore_ascii_case("imports");
            if relative.as_os_str().is_empty() && exclude_imports && imports_directory { continue; }
            let child = relative.join(&name);
            let Some(metadata) = plain_asset_metadata(&entry.path())? else { return Err("项目素材在扫描时发生变化".into()); };
            if metadata.is_dir() {
                if excluded_asset_directory(&name.to_string_lossy(), relative.as_os_str().is_empty()) { continue; }
                self.walk(&child, exclude_imports, exclude_shared_sync)?;
            } else if metadata.is_file() {
                if native_media_staging_path(&child) { continue; }
                let portable = child.to_str().ok_or("项目素材文件名不是有效 UTF-8")?.replace(std::path::MAIN_SEPARATOR, "/");
                self.add_file(&normalize_archive_path(Path::new(&portable))?, false)?;
            } else { return Err("不支持的素材类型".into()); }
        }
        Ok(())
    }
}

fn inspect_assets_scoped(root: &Path, include_import_paths: Option<&[String]>, selected_paths: Option<&[String]>,
    max_files: usize, max_bytes: u64) -> Result<Vec<ArchiveAssetDigest>, String> {
    inspect_assets_with_shared_scope(root, include_import_paths, selected_paths, None, max_files, max_bytes)
}

/// 共享素材缓存只允许以实际媒体文件路径进入原生项目的扫描闭包。
fn shared_sync_media_path(path: &str) -> bool {
    let parts: Vec<_> = path.splitn(6, '/').collect();
    let [directory, files, asset, revision, name] = parts.as_slice() else { return false; };
    let valid_id = |id: &str| !id.is_empty() && id.len() <= 128 && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    directory.eq_ignore_ascii_case(".shared-sync") && files.eq_ignore_ascii_case("files")
        && valid_id(asset) && valid_id(revision) && name.split_once('.').is_some_and(|(id, extension)| valid_id(id)
            && !extension.is_empty() && extension.len() <= 8 && extension.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn inspect_assets_with_shared_scope(root: &Path, include_import_paths: Option<&[String]>, selected_paths: Option<&[String]>,
    include_shared_paths: Option<&[String]>, max_files: usize, max_bytes: u64) -> Result<Vec<ArchiveAssetDigest>, String> {
    if (include_import_paths.is_some() || include_shared_paths.is_some()) && selected_paths.is_some() {
        return Err("项目素材扫描范围无效".into());
    }
    let selected = selected_paths.map(|paths| selected_asset_paths(paths, false)).transpose()?;
    let imports = include_import_paths.map(|paths| selected_asset_paths(paths, true)).transpose()?;
    let shared = include_shared_paths.map(|paths| {
        if paths.iter().any(|path| !shared_sync_media_path(path)) { return Err("共享素材扫描范围无效".into()); }
        selected_asset_paths(paths, false)
    }).transpose()?;
    let mut scan = AssetScan { root: root.canonicalize().map_err(|_| "无法解析项目素材目录")?, rows: Vec::new(),
        real_files: HashSet::new(), bytes: 0, max_files, max_bytes, buffer: Vec::new() };
    if let Some(paths) = selected {
        // 精确素材快照继续读取冻结清单中的原始文件，不能套用新打包的目录排除规则。
        for path in paths { scan.add_file(&path, true)?; }
    } else {
        require_packable_asset_path(&scan.root)?;
        scan.walk(Path::new(""), imports.is_some(), shared.is_some())?;
        for path in imports.unwrap_or_default().into_iter().chain(shared.unwrap_or_default()) {
            scan.add_file(&path, false)?;
        }
    }
    scan.rows.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(scan.rows)
}

// 只有逐个经过原生路径校验且解析到同一真实路径的写法才能合并；相同摘要不能证明身份。
#[cfg(target_os = "macos")]
fn asset_file_identity(path: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = plain_asset_metadata(path)?.ok_or("项目素材引用缺失")?;
    if !metadata.is_file() { return Err("项目素材不是普通文件".into()); }
    Ok((metadata.dev(), metadata.ino()))
}

fn same_verified_asset_file(left: &Path, right: &Path) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    { Ok(asset_file_identity(left)? == asset_file_identity(right)?) }
    #[cfg(not(target_os = "macos"))]
    { Ok(left == right) }
}

fn resolve_selected_path_aliases(paths: &[String], imports_only: bool, mut resolve: impl FnMut(&Path) -> Result<Option<PathBuf>, String>)
    -> Result<(Vec<String>, HashMap<String, Vec<String>>), String> {
    if paths.len() > MAX_ARCHIVE_ENTRIES { return Err("项目素材清单超过上限".into()); }
    let mut unique = Vec::new(); let mut groups: HashMap<String, String> = HashMap::new();
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    #[cfg(target_os = "macos")]
    let mut files: HashMap<(u64, u64), String> = HashMap::new();
    for value in paths {
        let path = selected_asset_paths(std::slice::from_ref(value), imports_only)?.pop().ok_or("项目素材路径无效")?;
        let name = to_archive_text(&path); let folded = name.to_lowercase();
        if let Some(first) = groups.get(&folded) {
            let source = resolve(&path)?.ok_or("项目素材引用缺失")?;
            let original = resolve(Path::new(first))?.ok_or("项目素材引用缺失")?;
            if !same_verified_asset_file(&source, &original)? { return Err("项目素材清单存在重复路径".into()); }
            aliases.entry(first.clone()).or_default().push(name);
        } else {
            #[cfg(target_os = "macos")]
            if let Some(source) = resolve(&path)? {
                let identity = asset_file_identity(&source)?;
                if let Some(first) = files.get(&identity) {
                    groups.insert(folded, first.clone());
                    aliases.entry(first.clone()).or_default().push(name);
                    continue;
                }
                files.insert(identity, name.clone());
            }
            groups.insert(folded, name.clone()); unique.push(name);
        }
    }
    Ok((unique, aliases))
}

/** Unicode 或大小写写法只在受权真实文件身份一致时登记，缺失引用仍留给上层闭包阻断。 */
fn resolve_reference_path_aliases(root: &Path, rows: &[ArchiveAssetDigest], references: &[String],
    aliases: &mut HashMap<String, Vec<String>>) -> Result<(), String> {
    if references.len() > MAX_ARCHIVE_ENTRIES { return Err("项目素材扫描范围无效".into()); }
    let by_name: HashMap<String, &str> = rows.iter().map(|row| (row.path.to_lowercase(), row.path.as_str())).collect();
    #[cfg(target_os = "macos")]
    let mut by_file: Option<HashMap<(u64, u64), &str>> = None;
    for value in references {
        let path = normalize_archive_path(Path::new(value))?; let name = to_archive_text(&path);
        if name.is_empty() { return Err("项目素材路径无效".into()); }
        if is_agent_workspace_path(&path) { continue; }
        let first = if let Some(first) = by_name.get(&name.to_lowercase()) { Some(*first) } else {
            #[cfg(target_os = "macos")]
            {
                let Some(file) = selected_asset_file(root, &path)? else { continue; };
                let identity = asset_file_identity(&file)?;
                if by_file.is_none() {
                    let mut index = HashMap::new();
                    for row in rows {
                        let source = selected_asset_file(root, Path::new(&row.path))?.ok_or("项目素材在扫描时发生变化")?;
                        index.entry(asset_file_identity(&source)?).or_insert(row.path.as_str());
                    }
                    by_file = Some(index);
                }
                by_file.as_ref().and_then(|index| index.get(&identity).copied())
            }
            #[cfg(not(target_os = "macos"))]
            { None }
        };
        if let Some(first) = first {
            if first == name { continue; }
            let first_file = selected_asset_file(root, Path::new(first))?.ok_or("项目素材引用缺失")?;
            let alias_file = selected_asset_file(root, &path)?.ok_or("项目素材引用缺失")?;
            if !same_verified_asset_file(&first_file, &alias_file)? { return Err("项目素材清单存在重复路径".into()); }
            let list = aliases.entry(first.to_string()).or_default();
            if !list.contains(&name) { list.push(name); }
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveAssetInspection {
    #[serde(flatten)] asset: ArchiveAssetDigest,
    #[serde(skip_serializing_if = "Vec::is_empty")] aliases: Vec<String>,
}

#[cfg(test)]
fn inspect_assets(root: &Path, relative: &Path, rows: &mut Vec<ArchiveAssetDigest>) -> Result<(), String> {
    if !relative.as_os_str().is_empty() { return Err("测试扫描入口只接受项目根".into()); }
    rows.extend(inspect_assets_scoped(root, None, None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES)?);
    Ok(())
}

#[tauri::command]
pub async fn inspect_project_archive_assets<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, assets_dir: String,
    include_import_paths: Option<Vec<String>>, selected_paths: Option<Vec<String>>,
    resolve_import_aliases: Option<bool>, reference_paths: Option<Vec<String>>,
    exclude_unreferenced_shared_sync: Option<bool>) -> Result<Vec<ArchiveAssetInspection>, String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("仅主窗口可以准备项目归档".into()); }
    let root = authorize_path(&app, &assets_dir, PathAccess::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        reauthorize_archive_path(&app, &root, PathAccess::Read)?;
        let mut aliases = HashMap::new();
        let imports = if resolve_import_aliases.unwrap_or(false) {
            if selected_paths.is_some() { return Err("项目素材扫描范围无效".into()); }
            let paths = include_import_paths.as_ref().ok_or("项目素材扫描范围无效")?;
            let canonical_root = root.canonicalize().map_err(|_| "无法解析项目素材目录")?;
            let (unique, mapped) = resolve_selected_path_aliases(paths, true, |path| selected_asset_file(&canonical_root, path))?;
            aliases = mapped; Some(unique)
        } else { include_import_paths };
        let shared = if exclude_unreferenced_shared_sync.unwrap_or(false) {
            let references = reference_paths.as_ref().ok_or("项目素材扫描范围无效")?;
            if references.len() > MAX_ARCHIVE_ENTRIES { return Err("项目素材扫描范围无效".into()); }
            let paths = references.iter().filter(|path| shared_sync_media_path(path)).cloned().collect::<Vec<_>>();
            let canonical_root = root.canonicalize().map_err(|_| "无法解析项目素材目录")?;
            let (unique, mapped) = resolve_selected_path_aliases(&paths, false, |path| selected_asset_file(&canonical_root, path))?;
            aliases.extend(mapped);
            Some(unique)
        } else { None };
        let rows = inspect_assets_with_shared_scope(&root, imports.as_deref(), selected_paths.as_deref(),
            shared.as_deref(), MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES)?;
        if let Some(references) = reference_paths {
            if !resolve_import_aliases.unwrap_or(false) || selected_paths.is_some() || references.len() > MAX_ARCHIVE_ENTRIES {
                return Err("项目素材扫描范围无效".into());
            }
            let canonical_root = root.canonicalize().map_err(|_| "无法解析项目素材目录")?;
            resolve_reference_path_aliases(&canonical_root, &rows, &references, &mut aliases)?;
        }
        Ok(rows.into_iter().map(|asset| ArchiveAssetInspection { aliases: aliases.remove(&asset.path).unwrap_or_default(), asset }).collect())
    }).await.map_err(|_| "项目素材扫描任务失败".to_string())?
}

/// 授权回调仍使用宿主路径策略；目录按层创建，不能依赖尚不存在的直接父目录。
fn create_import_destination(
    root: &Path,
    operation_id: &str,
    authorize: impl Fn(&Path, bool) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let imports = root.join("imports");
    if authorize(&imports, false)? != imports {
        return Err("导入父目录不能指向项目外或其他目录".into());
    }
    match fs::create_dir(&imports) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err("无法创建导入父目录".into()),
    }
    if authorize(&imports, true)? != imports {
        return Err("导入父目录真实路径已变化，请重新预览".into());
    }
    let destination = imports.join(operation_id);
    if authorize(&destination, false)? != destination {
        return Err("导入目录真实路径已变化，请重新预览".into());
    }
    fs::create_dir(&destination).map_err(|_| "导入目录已存在或无法创建，请重新预览")?;
    Ok(destination)
}

/// 只向全新子目录发布；逐文件复核已预览的字节，不覆盖目标的任何已有素材。
#[tauri::command]
pub async fn publish_project_import_assets<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, staging_dir: String,
    project_dir: String, operation_id: String, assets: Vec<ProjectImportAsset>, source_roots: Option<Vec<ProjectArchiveSourceRoot>>,
    transfer_id: Option<String>) -> Result<(), String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" || operation_id.len() > 128 || operation_id.is_empty()
        || !operation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("导入操作身份无效".into()); }
    let staging = authorize_path(&app, &staging_dir, PathAccess::Read)?;
    let root = authorize_path(&app, &project_dir, PathAccess::Write)?;
    let sources = authorize_source_roots(&app, source_roots.unwrap_or_default())?;
    // 重试复用发布目录身份，取消标记只归当前传输。
    let task_id = transfer_id.unwrap_or_else(|| operation_id.clone());
    if !publication_id(&task_id) { return Err("导入传输身份无效".into()); }
    let cancellation_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = ARCHIVE_PUBLICATION_LOCK.lock().map_err(|_| PUBLICATION_ERROR)?;
        reauthorize_archive_path(&app, &staging, PathAccess::Read)?;
        reauthorize_archive_path(&app, &root, PathAccess::Write)?;
        for source in sources.values() { reauthorize_archive_path(&app, source, PathAccess::Read)?; }
        let total_bytes = assets.iter().try_fold(0_u64, |total, asset| total.checked_add(asset.bytes)).ok_or("素材体积无效")?;
        if assets.len() > MAX_ARCHIVE_ENTRIES || total_bytes > MAX_EXPANDED_BYTES { return Err("导入素材超过上限".into()); }
        crate::file_transfer::ensure_disk_space(&root, Some(total_bytes))?;
        if crate::file_transfer::is_cancelled(&task_id)? { return Err("项目导入已取消".into()); }
        let final_destination = root.join("imports").join(&operation_id);
        if final_destination.exists() { return Err("导入目录已存在，请核对原操作，未重复发布".into()); }
        let destination = create_import_destination(&root, &format!("{operation_id}-publishing"), |path, existing_plain| {
            if existing_plain { reauthorize_existing_plain_directory(&app, path) }
            else { authorize_path(&app, &path.to_string_lossy(), PathAccess::Write) }
        })?;
        let mut seen = HashSet::new(); let mut total = 0_u64; let mut transferred = 0_u64;
        let mut buffer = Vec::new();
        let result = (|| {
            for asset in assets {
                if crate::file_transfer::is_cancelled(&task_id)? { return Err("项目导入已取消".into()); }
                let relative = normalize_archive_path(Path::new(&asset.path))?;
                let published = normalize_archive_path(Path::new(&asset.destination_path))?;
                if !seen.insert(to_archive_text(&published).to_lowercase()) || relative.as_os_str().is_empty() || published.as_os_str().is_empty() { return Err("导入素材路径重复".into()); }
                total = total.saturating_add(asset.bytes);
                if seen.len() > MAX_ARCHIVE_ENTRIES || total > MAX_EXPANDED_BYTES { return Err("导入素材超过上限".into()); }
                let source_root = match &asset.source_root_ref { Some(reference) => sources.get(reference).ok_or("导入素材来源根缺失")?, None => &staging };
                reauthorize_archive_path(&app, source_root, PathAccess::Read)?;
                let source = selected_asset_file(source_root, &relative)?.ok_or("导入素材已缺失")?;
                if authorize_path(&app, &source.to_string_lossy(), PathAccess::Read)? != source { return Err("素材来源已变化".into()); }
                let target = destination.join(&published);
                fs::create_dir_all(target.parent().ok_or("素材目录无效")?).map_err(|_| "无法创建素材目录")?;
                let mut input = File::open(&source).map_err(|_| "无法打开暂存素材")?;
                let mut output = fs::OpenOptions::new().create_new(true).write(true).open(&target).map_err(|_| "无法创建目标素材")?;
                buffer.resize(IO_BUFFER_BYTES, 0);
                let mut bytes = 0_u64; let mut digest = Sha256::new();
                loop {
                    if crate::file_transfer::is_cancelled(&task_id)? { return Err("项目导入已取消".into()); }
                    let count = input.read(&mut buffer).map_err(|_| "素材发布读取失败")?; if count == 0 { break; }
                    bytes += count as u64;
                    if bytes > asset.bytes { return Err("暂存素材大小已变化".into()); }
                    output.write_all(&buffer[..count]).map_err(|_| "素材写入失败，原项目未改变")?; digest.update(&buffer[..count]);
                    transferred += count as u64;
                    let _ = app.emit_to("main", "file-transfer-progress", ImportProgress { task_id: task_id.clone(), transferred_bytes: transferred, total_bytes });
                }
                output.sync_all().map_err(|_| "素材落盘失败")?; drop(output);
                sync_asset_parents(&destination, target.parent().ok_or(PUBLICATION_ERROR)?)?;
                let sha256 = format!("{:x}", digest.finalize());
                if bytes != asset.bytes || sha256 != asset.sha256 { return Err("素材内容已变化，请重新导入".into()); }
            }
            reauthorize_archive_path(&app, &root, PathAccess::Write)?;
            let imports = reauthorize_existing_plain_directory(&app, &root.join("imports"))?;
            if imports != root.join("imports") || final_destination.exists()
                || authorize_path(&app, &final_destination.to_string_lossy(), PathAccess::Write)? != final_destination {
                return Err("导入发布位置已变化，未覆盖已有素材".into());
            }
            if crate::file_transfer::is_cancelled(&task_id)? { return Err("项目导入已取消".into()); }
            publish_import_directory_exclusive(&destination, &final_destination)?;
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_dir_all(&destination); }
        result
    }).await.map_err(|_| "项目素材发布任务失败".to_string());
    crate::file_transfer::clear_cancelled(&cancellation_id);
    result?
}

/// 校验归档内相对路径：拒绝绝对路径、`..`、盘符和反斜杠，避免解包写到目标目录之外。
fn normalize_archive_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    if text.len() > 1024 || path.components().count() > 64
        || text.contains('\\') || text.contains(':') || text.chars().any(|c| c.is_control()) {
        return Err(format!("项目归档包含不安全路径: {text}"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => {
                let part = value.to_string_lossy();
                let stem = part.split('.').next().unwrap_or("").to_uppercase();
                if part.ends_with('.') || part.ends_with(' ') || part.chars().any(|c| ['<', '>', '"', '|', '?', '*'].contains(&c))
                    || ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
                        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&stem.as_str()) { return Err("项目归档路径不受支持".into()); }
                normalized.push(value);
            },
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("项目归档包含不安全路径: {text}"));
            }
        }
    }
    Ok(normalized)
}

fn to_archive_text(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

struct AssetStats {
    count: usize,
    bytes: u64,
}

fn append_asset_file<W: Write>(builder: &mut Builder<W>, source: &Path, archive_path: &Path,
    stats: &mut AssetStats) -> Result<(), String> {
    stats.count += 1;
    if stats.count > MAX_ARCHIVE_ENTRIES { return Err("项目素材文件数量超过导出上限".into()); }
    let mut file = File::open(source).map_err(|error| format!("打开项目素材失败: {error}"))?;
    let size = file.metadata().map_err(|_| "无法读取项目素材大小")?.len();
    stats.bytes = stats.bytes.checked_add(size).ok_or("项目素材体积无效")?;
    if stats.bytes > MAX_EXPANDED_BYTES { return Err("项目素材总体积超过 20 GB 导出上限".into()); }
    builder.append_file(archive_path, &mut file).map_err(|error| format!("写入项目素材失败: {error}"))
}

fn append_selected_assets<W: Write>(builder: &mut Builder<W>, root: &Path, paths: &[PathBuf],
    stats: &mut AssetStats) -> Result<(), String> {
    let root = root.canonicalize().map_err(|_| "无法解析项目素材目录")?;
    for relative in paths {
        let file = packable_asset_file(&root, relative)?.ok_or("导出素材已缺失，请重新导出")?;
        append_asset_file(builder, &file, &Path::new(ASSETS_PREFIX).join(relative), stats)?;
    }
    Ok(())
}

fn multi_root_asset_sources(assets: &[ArchiveAssetDigest], roots: &HashMap<String, PathBuf>, default_root: Option<&Path>) -> Result<Vec<(PathBuf, PathBuf, PathBuf)>, String> {
    let total = assets.iter().try_fold(0_u64, |bytes, asset| bytes.checked_add(asset.bytes)).ok_or("素材体积无效")?;
    if assets.len() > MAX_ARCHIVE_ENTRIES || total > MAX_EXPANDED_BYTES { return Err("素材数量或体积超过限制".into()); }
    let mut result = Vec::new(); let mut seen = HashSet::new();
    for asset in assets {
        let archive = normalize_archive_path(Path::new(&asset.path))?;
        if archive.as_os_str().is_empty() || !seen.insert(to_archive_text(&archive).to_lowercase()) { return Err("归档素材路径重复".into()); }
        let (root, relative) = match (&asset.source_root_ref, &asset.source_relative_path) {
            (Some(root), Some(path)) => (roots.get(root).ok_or("素材来源根缺失")?.as_path(), normalize_archive_path(Path::new(path))?),
            (None, None) => (default_root.ok_or("素材来源根缺失")?, archive.clone()),
            _ => return Err("素材来源根与源相对路径必须同时提供".into()),
        };
        if relative.as_os_str().is_empty() { return Err("源素材路径为空".into()); }
        let source = packable_asset_file(root, &relative)?.ok_or("源素材已缺失")?;
        let (bytes, digest) = hash_file(&source, &mut Vec::new())?;
        if bytes != asset.bytes || digest != asset.sha256 { return Err("素材已变化，请重新捕获导出内容".into()); }
        result.push((root.to_path_buf(), relative, archive));
    }
    Ok(result)
}

/// 递归打包项目数据目录。符号链接既不是文件也不是目录，会被跳过，
/// 避免把项目目录之外的内容打进归档。
fn append_assets_dir<W: Write>(
    builder: &mut Builder<W>,
    source: &Path,
    archive_dir: &Path,
    stats: &mut AssetStats,
    selected: Option<&HashSet<String>>,
) -> Result<(), String> {
    if archive_dir.components().count() > 65 { return Err("项目素材目录过深".into()); }
    let read_dir =
        fs::read_dir(source).map_err(|error| format!("读取项目素材目录失败: {error}"))?;
    for item in read_dir {
        let entry = item.map_err(|error| format!("读取项目素材目录项失败: {error}"))?;
        let name = entry.file_name();
        if is_agent_workspace_name(&name) { continue; }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取项目素材类型失败: {error}"))?;
        let archive_path = archive_dir.join(&name);

        if file_type.is_dir() {
            if EXCLUDED_DIR_NAMES.contains(&name.to_string_lossy().as_ref()) {
                continue;
            }
            // 只排除项目根的派生缓存，分组中的同名目录仍属于用户素材。
            if archive_dir == Path::new(ASSETS_PREFIX) && name == ".thumbnail" {
                continue;
            }
            append_assets_dir(builder, &entry.path(), &archive_path, stats, selected)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = archive_path.strip_prefix(ASSETS_PREFIX).map_err(|_| "素材路径无效")?;
        if selected.is_some_and(|paths| !paths.contains(&to_archive_text(relative))) { continue; }

        append_asset_file(builder, &entry.path(), &archive_path, stats)?;
    }
    Ok(())
}

/// 把项目文本记录与素材目录打包为单个 tar.gz 归档。
#[tauri::command]
pub async fn pack_project_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    entries: Vec<ProjectArchiveTextEntry>,
    assets_dir: Option<String>,
    output_path: String,
    expected_assets: Option<Vec<ArchiveAssetDigest>>,
    operation_id: Option<String>,
    source_roots: Option<Vec<ProjectArchiveSourceRoot>>,
    alias_checks: Option<Vec<ProjectArchiveAliasCheck>>,
) -> Result<ProjectArchivePackResult, String> {
    ensure_trusted_caller(&webview)?;
    if (operation_id.is_some() || source_roots.is_some()) && webview.label() != "main" { return Err(PUBLICATION_ERROR.into()); }
    let output = authorize_path(&app, &output_path, PathAccess::Write)?;
    let assets_root = match assets_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => Some(authorize_path(&app, raw, PathAccess::Read)?),
        None => None,
    };
    let sources = authorize_source_roots(&app, source_roots.unwrap_or_default())?;
    let checks = alias_checks.unwrap_or_default();
    if !checks.is_empty() && operation_id.is_none() { return Err(PUBLICATION_ERROR.into()); }
    if assets_root.as_ref().is_some_and(|root| output.starts_with(root)) { return Err("项目包不能导出到被打包的素材目录内".into()); }
    if sources.values().any(|root| output.starts_with(root)) { return Err("项目包不能导出到被打包的素材目录内".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ARCHIVE_PUBLICATION_LOCK.lock().map_err(|_| PUBLICATION_ERROR)?;
        reauthorize_archive_path(&app, &output, PathAccess::Write)?;
        if let Some(root) = &assets_root { reauthorize_archive_path(&app, root, PathAccess::Read)?; }
        for root in sources.values() { reauthorize_archive_path(&app, root, PathAccess::Read)?; }
        verify_export_aliases(&checks, &sources)?;
        let mut publication = operation_id.as_deref().map(|id| begin_publication(&app, id, &output)).transpose()?;
        if let Some(plan) = publication.as_mut() {
            let handle = app.clone(); let output = output.clone(); let source_roots = sources.clone(); let assets = assets_root.clone(); let checks = checks.clone();
            plan.recheck = Some(Box::new(move || {
                reauthorize_archive_path(&handle, &output, PathAccess::Write)?;
                if let Some(root) = &assets { reauthorize_archive_path(&handle, root, PathAccess::Read)?; }
                for root in source_roots.values() { reauthorize_archive_path(&handle, root, PathAccess::Read)?; }
                verify_export_aliases(&checks, &source_roots)?;
                Ok(())
            }));
        }
        pack_archive_with_publication(entries, assets_root, output, expected_assets, MAX_ARCHIVE_ENTRIES, publication, &sources)
    }).await.map_err(|_| "项目归档打包任务失败".to_string())?
}

#[cfg(test)]
fn pack_archive(
    entries: Vec<ProjectArchiveTextEntry>,
    assets_root: Option<PathBuf>,
    output: PathBuf,
    expected_assets: Option<Vec<ArchiveAssetDigest>>,
    entry_limit: usize,
) -> Result<ProjectArchivePackResult, String> {
    pack_archive_with_publication(entries, assets_root, output, expected_assets, entry_limit, None, &HashMap::new())
}

fn pack_archive_with_publication(entries: Vec<ProjectArchiveTextEntry>, assets_root: Option<PathBuf>, output: PathBuf,
    expected_assets: Option<Vec<ArchiveAssetDigest>>, entry_limit: usize, publication: Option<ArchivePublicationPlan>, source_roots: &HashMap<String, PathBuf>,
) -> Result<ProjectArchivePackResult, String> {
    validate_v4_entry_names(entries.iter().map(|entry| (entry.path.as_str(), entry.content.as_str())))?;
    let selected_names = expected_assets.as_ref().map(|assets| assets.iter().map(|asset| asset.path.clone()).collect::<Vec<_>>());
    let selected = selected_names.as_deref().map(|paths| selected_asset_paths(paths, false)).transpose()?;
    if let Some(root) = &assets_root { require_packable_asset_path(root)?; }
    for relative in selected.iter().flatten() { require_packable_asset_path(relative)?; }
    let multiple_roots = expected_assets.as_ref().is_some_and(|assets| assets.iter().any(|asset| asset.source_root_ref.is_some() || asset.source_relative_path.is_some()));
    let multi_sources = if multiple_roots { Some(multi_root_asset_sources(expected_assets.as_ref().unwrap(), source_roots, assets_root.as_deref())?) } else { None };
    if !multiple_roots { if let (Some(root), Some(expected)) = (&assets_root, &expected_assets) {
        let mut actual = inspect_assets_scoped(root, None, selected_names.as_deref(), MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES)?;
        let mut expected = expected.clone(); expected.sort_by(|a, b| a.path.cmp(&b.path)); actual.sort_by(|a, b| a.path.cmp(&b.path));
        if actual != expected { return Err("素材在导出前已变化，请重新导出".into()); }
    } }
    let temporary = output.with_extension(format!("{}.part", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时间无效")?.as_nanos()));
    let file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| format!("创建导出文件失败: {error}"))?;
    let result = (|| {
    let encoder = GzEncoder::new(BufWriter::new(file), Compression::default());
    let mut builder = Builder::new(encoder);
    let mtime = unix_now();

    let mut text_bytes = 0_u64; let mut paths = HashSet::new();
    for entry in &entries {
        let relative = normalize_archive_path(Path::new(&entry.path))?;
        if relative.as_os_str().is_empty() {
            return Err("项目归档条目路径为空".to_string());
        }
        if relative.starts_with(ASSETS_PREFIX) || !paths.insert(to_archive_text(&relative).to_lowercase()) { return Err("项目记录路径冲突".into()); }
        text_bytes = text_bytes.saturating_add(entry.content.len() as u64);
        if text_bytes > MAX_TEXT_BYTES { return Err("项目记录超过 512 MB 上限".into()); }
        let bytes = entry.content.as_bytes();
        let mut header = Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(mtime);
        builder
            .append_data(&mut header, &relative, bytes)
            .map_err(|error| format!("写入项目记录失败: {error}"))?;
    }

    let mut stats = AssetStats { count: 0, bytes: 0 };
    if let Some(sources) = &multi_sources {
        for (root, source_path, relative) in sources {
            let source = packable_asset_file(root, source_path)?.ok_or("导出素材已缺失")?;
            append_asset_file(&mut builder, &source, &Path::new(ASSETS_PREFIX).join(relative), &mut stats)?;
        }
    } else if let Some(root) = &assets_root {
        if let Some(paths) = &selected { append_selected_assets(&mut builder, root, paths, &mut stats)?; }
        else { append_assets_dir(&mut builder, root, Path::new(ASSETS_PREFIX), &mut stats, None)?; }
    }

    let encoder = builder
        .into_inner()
        .map_err(|error| format!("完成项目归档失败: {error}"))?;
    let mut writer = encoder
        .finish()
        .map_err(|error| format!("压缩项目归档失败: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("写入项目归档失败: {error}"))?;
    writer.get_ref().sync_all().map_err(|_| PUBLICATION_ERROR)?;
    drop(writer);

    {
        // 发布前与导入共用 raw 条目预算和完整路径校验，GNU 长名称扩展也计入条目数。
        let mut file = File::open(&temporary).map_err(|_| "无法复核归档")?;
        validate_archive_stream_with_limit(GzDecoder::new(BufReader::new(&mut file)), entry_limit)?;
        file.seek(SeekFrom::Start(0)).map_err(|_| "无法重新读取待发布归档")?;
        let mut archive = Archive::new(GzDecoder::new(BufReader::new(file)));
        let mut actual = Vec::new();
        let mut seen = HashSet::new();
        let mut expanded_bytes = 0_u64;
        let mut buffer = Vec::new();
        for entry in archive.entries().map_err(|_| "无法复核归档")? {
            let mut entry = entry.map_err(|_| "无法复核归档条目")?;
            let path = to_archive_text(&archive_entry_path(&entry, &mut seen, &mut expanded_bytes, MAX_EXPANDED_BYTES + MAX_TEXT_BYTES)?);
            if let Some(path) = path.strip_prefix("assets/").filter(|_| entry.header().entry_type().is_file()) {
                buffer.resize(IO_BUFFER_BYTES, 0);
                let mut digest = Sha256::new(); let mut bytes = 0_u64;
                loop { let count = entry.read(&mut buffer).map_err(|_| "归档素材读取失败")?; if count == 0 { break; } digest.update(&buffer[..count]); bytes += count as u64; }
                actual.push(ArchiveAssetDigest { path: path.into(), bytes, sha256: format!("{:x}", digest.finalize()), source_root_ref: None, source_relative_path: None });
            }
        }
        if let Some(expected) = &expected_assets {
            let mut expected: Vec<_> = expected.iter().map(ArchiveAssetDigest::portable).collect(); actual.sort_by(|a, b| a.path.cmp(&b.path)); expected.sort_by(|a, b| a.path.cmp(&b.path));
            if actual != expected { return Err("素材在导出中发生变化，未发布归档".into()); }
        }
    }
    let (archive_bytes, archive_sha256) = if publication.is_some() {
        hash_file_with_limit(&temporary, &mut Vec::new(), MAX_EXPANDED_BYTES + MAX_TEXT_BYTES)?
    } else { (fs::metadata(&temporary).map_err(|_| "无法读取归档大小")?.len(), String::new()) };
    let mut result = ProjectArchivePackResult {
        asset_count: stats.count,
        asset_bytes: stats.bytes,
        archive_bytes,
        operation_id: None, publication_ref: None, archive_sha256: None,
    };
    if let Some(plan) = &publication {
        result.operation_id = Some(plan.receipt.operation_id.clone());
        result.publication_ref = Some(plan.receipt.publication_ref.clone());
        result.archive_sha256 = Some(archive_sha256);
        let mut receipt = plan.receipt.clone(); receipt.result = Some(result.clone());
        // 发布之前先耐久保留最终字节摘要；发布后响应丢失时只核同一文件。
        write_publication_receipt(&publication_path(&plan.directory, &receipt.operation_id, "ready"), &receipt)?;
        if let Some(recheck) = &plan.recheck { recheck()?; }
        publish_archive_exclusive(&temporary, &output).map_err(|error| match error {
            ExclusiveArchivePublishError::DestinationOccupied => ARCHIVE_OUTPUT_OCCUPIED,
            ExclusiveArchivePublishError::Unconfirmed => PUBLICATION_ERROR,
        })?;
        write_publication_receipt(&publication_path(&plan.directory, &receipt.operation_id, "published"), &receipt)?;
    } else {
        fs::rename(&temporary, &output).map_err(|_| "无法发布归档，目标可能正被占用")?;
    }
    Ok(result)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

/// 解包项目归档：`assets/` 下的素材写入 `assets_dir`，其余条目按文本返回。
// tar 会在暴露普通条目前把 GNU/PAX 扩展读入内存；必须先以 raw 模式限制它们。
fn validate_archive_stream<R: Read>(reader: R) -> Result<(), String> {
    validate_archive_stream_with_limit(reader, MAX_ARCHIVE_ENTRIES)
}

fn validate_archive_stream_with_limit<R: Read>(reader: R, entry_limit: usize) -> Result<(), String> {
    let mut archive = Archive::new(reader);
    let mut total = 0_u64;
    for (index, item) in archive.entries().map_err(|_| "归档头无效")?.raw(true).enumerate() {
        if index >= entry_limit { return Err("项目归档条目超过上限".into()); }
        let entry = item.map_err(|_| "归档条目无效")?;
        let kind = entry.header().entry_type();
        let size = entry.size();
        if kind.is_gnu_longname() || kind.is_gnu_longlink() || kind.is_pax_local_extensions() || kind.is_pax_global_extensions() {
            if size > MAX_EXTENSION_BYTES { return Err("归档扩展元数据超过上限".into()); }
        } else if !kind.is_file() && !kind.is_dir() { return Err("项目归档包含不允许的链接或设备文件".into()); }
        total = total.checked_add(size).ok_or("归档体积无效")?;
        if total > MAX_EXPANDED_BYTES + MAX_TEXT_BYTES { return Err("归档展开体积超过上限".into()); }
    }
    Ok(())
}

/// 导出复核和解包必须针对带 assets/ 前缀的完整名称执行同一套校验。
fn archive_entry_path<R: Read>(entry: &tar::Entry<'_, R>, seen: &mut HashSet<String>,
    expanded_bytes: &mut u64, byte_limit: u64) -> Result<PathBuf, String> {
    let kind = entry.header().entry_type();
    if !kind.is_file() && !kind.is_dir() {
        return Err("项目归档包含不允许的链接或设备文件".into());
    }
    // 普通解析会应用扩展元数据中的有效大小；必须在任何跳过条目前计入预算。
    *expanded_bytes = expanded_bytes.checked_add(entry.size()).ok_or("归档体积无效")?;
    if *expanded_bytes > byte_limit { return Err("归档展开体积超过上限".into()); }
    if kind.is_dir() && entry.size() != 0 { return Err("项目归档目录不能携带文件内容".into()); }
    let path = normalize_archive_path(&entry.path().map_err(|_| "读取项目归档路径失败")?)?;
    if (path.as_os_str().is_empty() || path == Path::new(ASSETS_PREFIX)) && entry.size() != 0 {
        return Err("项目归档根条目不能携带文件内容".into());
    }
    if !path.as_os_str().is_empty() && !seen.insert(to_archive_text(&path).to_lowercase()) {
        return Err("项目归档含重复或大小写冲突路径".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn unpack_project_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    archive_path: String,
    assets_dir: String,
) -> Result<ProjectArchiveUnpackResult, String> {
    ensure_trusted_caller(&webview)?;
    let archive_file = authorize_path(&app, &archive_path, PathAccess::Read)?;
    let target_dir = authorize_path(&app, &assets_dir, PathAccess::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        reauthorize_archive_path(&app, &archive_file, PathAccess::Read)?;
        reauthorize_archive_path(&app, &target_dir, PathAccess::Write)?;
        unpack_archive(&archive_file, &target_dir)
    }).await.map_err(|_| "项目归档解包任务失败".to_string())?
}

fn unpack_archive(archive_file: &Path, target_dir: &Path) -> Result<ProjectArchiveUnpackResult, String> {
    if !target_dir.is_dir() {
        return Err("导入目标目录不存在".to_string());
    }
    if fs::read_dir(&target_dir).map_err(|_| "无法读取导入暂存目录")?.next().is_some() { return Err("项目包只能解压至空目录".into()); }

    let mut file =
        File::open(&archive_file).map_err(|error| format!("打开项目归档失败: {error}"))?;
    validate_archive_stream(GzDecoder::new(BufReader::new(&mut file)))?;
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法重新读取已校验的归档")?;
    let decoder = GzDecoder::new(BufReader::new(file));
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("读取项目归档失败: {error}"))?;

    let mut texts: HashMap<String, String> = HashMap::new();
    let mut asset_paths: Vec<String> = Vec::new();
    let mut entry_count = 0_usize;
    let mut asset_bytes = 0_u64;
    let mut text_bytes = 0_u64;
    let mut expanded_bytes = 0_u64;
    let mut seen = HashSet::new(); let mut assets = Vec::new();
    let mut buffer = Vec::new();

    for item in entries {
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err("项目归档文件数量超过限制".to_string());
        }
        let mut entry = item.map_err(|error| format!("读取项目归档项失败: {error}"))?;
        let entry_type = entry.header().entry_type();
        let relative = archive_entry_path(&entry, &mut seen, &mut expanded_bytes, MAX_EXPANDED_BYTES + MAX_TEXT_BYTES)?;
        if relative.as_os_str().is_empty() {
            continue;
        }

        let mut components = relative.components();
        let is_asset = matches!(components.next(), Some(Component::Normal(first)) if first == ASSETS_PREFIX);
        if !is_asset {
            if entry_type.is_dir() {
                continue;
            }
            let size = entry.size();
            text_bytes = text_bytes.saturating_add(size);
            if text_bytes > MAX_TEXT_BYTES {
                return Err("项目归档中的记录数据超过 512 MB 限制".to_string());
            }
            let mut content = String::new();
            entry
                .read_to_string(&mut content)
                .map_err(|error| format!("读取项目记录失败: {error}"))?;
            texts.insert(to_archive_text(&relative), content);
            continue;
        }

        let inner: PathBuf = components.collect();
        if inner.as_os_str().is_empty() {
            continue;
        }
        let destination = target_dir.join(&inner);
        if entry_type.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("创建素材目录失败: {error}"))?;
            continue;
        }

        asset_bytes = asset_bytes.saturating_add(entry.size());
        if asset_bytes > MAX_EXPANDED_BYTES {
            return Err("项目归档展开后超过 20 GB 限制".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;
        }
        let mut target = fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|_| "无法创建暂存素材")?;
        std::io::copy(&mut entry, &mut target).map_err(|_| "解压素材失败")?; target.sync_all().map_err(|_| "暂存素材写入失败")?; drop(target);
        sync_asset_parents(target_dir, destination.parent().ok_or(PUBLICATION_ERROR)?)?;
        let path = to_archive_text(&inner); let (bytes, sha256) = hash_file(&destination, &mut buffer)?;
        asset_paths.push(path.clone()); assets.push(ArchiveAssetDigest { path, bytes, sha256, source_root_ref: None, source_relative_path: None });
    }

    sync_publication_directory(target_dir)?;
    if let Some(parent) = target_dir.parent() { sync_publication_directory(parent)?; }
    validate_v4_entry_names(texts.iter().map(|(path, content)| (path.as_str(), content.as_str())))?;
    Ok(ProjectArchiveUnpackResult {
        texts,
        asset_paths,
        asset_bytes,
        assets,
    })
}

/// 固定合成材料的原生容器演练。调用方必须先独占创建空的私有 fixture 目录；不接收 Renderer 数据。
/// 这里验证 tar/素材与发布回执，不把占位 JSON 冒充各版本业务格式验收。
#[cfg(all(windows, debug_assertions, feature = "project-model-fixture-host"))]
pub(crate) fn run_fixture_archive_container_probe(root: &Path) -> Result<(), String> {
    if fs::read_dir(root).map_err(|_| PUBLICATION_ERROR)?.next().is_some() { return Err(PUBLICATION_ERROR.into()); }
    for version in 1..=4 {
        let run = root.join(format!("v{version}"));
        let left = run.join("left"); let right = run.join("right"); let imported = run.join("imported");
        fs::create_dir(&run).map_err(|_| PUBLICATION_ERROR)?;
        for dir in [&left, &right, &imported] { fs::create_dir(dir).map_err(|_| PUBLICATION_ERROR)?; }
        for (dir, bytes) in [(&left, b"left synthetic".as_slice()), (&right, b"right synthetic".as_slice())] {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(dir.join("same.txt")).map_err(|_| PUBLICATION_ERROR)?;
            file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| PUBLICATION_ERROR)?;
        }
        let roots = HashMap::from([("left".to_string(), left), ("right".to_string(), right)]);
        let assets = [("left", b"left synthetic".as_slice()), ("right", b"right synthetic".as_slice())]
            .into_iter().map(|(name, bytes)| ArchiveAssetDigest { path: format!("{name}/same.txt"), bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)), source_root_ref: Some(name.into()), source_relative_path: Some("same.txt".into()) })
            .collect::<Vec<_>>();
        let mut expected = HashMap::from([("manifest.json".to_string(), format!("{{\"formatVersion\":{version}}}")),
            ("project.json".to_string(), "{\"synthetic\":true}".to_string())]);
        if version == 4 {
            for name in ["episodes.json", "canvases.json", "contents.json", "exchange.json"] { expected.insert(name.into(), "{}".into()); }
        }
        let entries = expected.iter().map(|(path, content)| ProjectArchiveTextEntry { path: path.clone(), content: content.clone() }).collect();
        let output = run.join("synthetic.aicanvas"); let operation_id = format!("fixture-v{version}");
        let publication_ref = "a".repeat(64);
        let receipt = ArchivePublicationReceipt { operation_id: operation_id.clone(), publication_ref: publication_ref.clone(),
            output_path: output.to_str().ok_or(PUBLICATION_ERROR)?.to_owned(), result: None };
        write_publication_receipt(&publication_path(&run, &operation_id, "prepared"), &receipt)?;
        let result = pack_archive_with_publication(entries, None, output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES,
            Some(ArchivePublicationPlan { directory: run.clone(), receipt, recheck: None }), &roots)?;
        // 模拟发布完成但回执未确认；保留原回执，再用正式恢复核心核同一文件，不重复打包。
        let ready = read_publication_receipt(&publication_path(&run, &operation_id, "ready"))?;
        let published_path = publication_path(&run, &operation_id, "published");
        fs::rename(&published_path, run.join("published-captured.json")).map_err(|_| PUBLICATION_ERROR)?;
        let recovered = reconcile_publication(&run, &operation_id, Some(&publication_ref), |path| {
            if Path::new(path) != output.as_path() { return Err(PUBLICATION_ERROR.into()); }
            Ok(output.clone())
        })?;
        let published = read_publication_receipt(&published_path)?;
        let (_, actual_digest) = hash_file_with_limit(&output, &mut Vec::new(), MAX_EXPANDED_BYTES + MAX_TEXT_BYTES)?;
        if recovered.status != "published" || recovered.operation_id != operation_id
            || recovered.publication_ref.as_deref() != Some(publication_ref.as_str())
            || recovered.archive_sha256.as_ref() != Some(&actual_digest)
            || ready.result.as_ref().and_then(|value| value.archive_sha256.as_ref()) != Some(&actual_digest)
            || published.result.as_ref().and_then(|value| value.archive_sha256.as_ref()) != Some(&actual_digest)
            || result.archive_sha256.as_ref() != Some(&actual_digest) { return Err(PUBLICATION_ERROR.into()); }
        let unpacked = unpack_archive(&output, &imported)?;
        let mut actual_assets = unpacked.assets; actual_assets.sort_by(|a, b| a.path.cmp(&b.path));
        let mut portable = assets.iter().map(ArchiveAssetDigest::portable).collect::<Vec<_>>(); portable.sort_by(|a, b| a.path.cmp(&b.path));
        if unpacked.texts != expected || actual_assets != portable
            || fs::read(imported.join("left/same.txt")).map_err(|_| PUBLICATION_ERROR)? != b"left synthetic"
            || fs::read(imported.join("right/same.txt")).map_err(|_| PUBLICATION_ERROR)? != b"right synthetic" { return Err(PUBLICATION_ERROR.into()); }
    }
    Ok(())
}

#[cfg(test)]
#[path = "project_archive/tests.rs"]
mod tests;
