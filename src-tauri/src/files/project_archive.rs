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
    publish_archive_exclusive(&temporary, path)
}
fn publish_archive_exclusive(temporary: &Path, output: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH}};
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = output.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_WRITE_THROUGH) }.map_err(|_| PUBLICATION_ERROR)?;
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(temporary, output).map_err(|_| PUBLICATION_ERROR)?;
        sync_publication_directory(output.parent().ok_or(PUBLICATION_ERROR)?)?;
        fs::remove_file(temporary).map_err(|_| PUBLICATION_ERROR)?;
    }
    sync_publication_directory(output.parent().ok_or(PUBLICATION_ERROR)?)
}

/// std::fs::rename 在 Unix 可替换已有空目录；导入发布必须使用平台的 no-replace 合同。
fn publish_import_directory_exclusive(temporary: &Path, output: &Path) -> Result<(), String> {
    #[cfg(windows)]
    { return publish_archive_exclusive(temporary, output); }
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
    if !publication_id(operation_id) || output.exists() { return Err("归档发布需要新的操作身份和未占用的输出文件".into()); }
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
        let source = selected_asset_file(root, &path)?.ok_or("源素材已缺失")?;
        for value in &check.aliases {
            let alias = normalize_archive_path(Path::new(value))?;
            if to_archive_text(&path).to_lowercase() != to_archive_text(&alias).to_lowercase()
                || selected_asset_file(root, &alias)?.ok_or("素材别名已缺失")? != source {
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

/// 根已由宿主授权；逐组件拒绝链接，缺失项留给上层依引用位置报告。
fn selected_asset_file(root: &Path, relative: &Path) -> Result<Option<PathBuf>, String> {
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
    fn add_file(&mut self, relative: &Path) -> Result<(), String> {
        let Some(file) = selected_asset_file(&self.root, relative)? else { return Ok(()); };
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

    fn walk(&mut self, relative: &Path, exclude_imports: bool) -> Result<(), String> {
        if relative.components().count() > 64 { return Err("项目素材目录过深".into()); }
        for item in fs::read_dir(self.root.join(relative)).map_err(|_| "无法读取项目目录")? {
            let entry = item.map_err(|_| "无法读取素材目录项")?;
            let name = entry.file_name();
            let imports_directory = name.to_string_lossy().eq_ignore_ascii_case("imports");
            if relative.as_os_str().is_empty() && exclude_imports && imports_directory { continue; }
            let child = relative.join(&name);
            let Some(metadata) = plain_asset_metadata(&entry.path())? else { return Err("项目素材在扫描时发生变化".into()); };
            if metadata.is_dir() {
                if excluded_asset_directory(&name.to_string_lossy(), relative.as_os_str().is_empty()) { continue; }
                self.walk(&child, exclude_imports)?;
            } else if metadata.is_file() {
                let portable = child.to_str().ok_or("项目素材文件名不是有效 UTF-8")?.replace(std::path::MAIN_SEPARATOR, "/");
                self.add_file(&normalize_archive_path(Path::new(&portable))?)?;
            } else { return Err("不支持的素材类型".into()); }
        }
        Ok(())
    }
}

fn inspect_assets_scoped(root: &Path, include_import_paths: Option<&[String]>, selected_paths: Option<&[String]>,
    max_files: usize, max_bytes: u64) -> Result<Vec<ArchiveAssetDigest>, String> {
    if include_import_paths.is_some() && selected_paths.is_some() { return Err("项目素材扫描范围无效".into()); }
    let selected = selected_paths.map(|paths| selected_asset_paths(paths, false)).transpose()?;
    let imports = include_import_paths.map(|paths| selected_asset_paths(paths, true)).transpose()?;
    let mut scan = AssetScan { root: root.canonicalize().map_err(|_| "无法解析项目素材目录")?, rows: Vec::new(),
        real_files: HashSet::new(), bytes: 0, max_files, max_bytes, buffer: Vec::new() };
    if let Some(paths) = selected {
        for path in paths { scan.add_file(&path)?; }
    } else {
        scan.walk(Path::new(""), imports.is_some())?;
        for path in imports.unwrap_or_default() { scan.add_file(&path)?; }
    }
    scan.rows.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(scan.rows)
}

// 只有逐个经过原生路径校验且解析到同一真实路径的写法才能合并；相同摘要不能证明身份。
fn resolve_import_path_aliases(paths: &[String], mut resolve: impl FnMut(&Path) -> Result<PathBuf, String>)
    -> Result<(Vec<String>, HashMap<String, Vec<String>>), String> {
    if paths.len() > MAX_ARCHIVE_ENTRIES { return Err("项目素材清单超过上限".into()); }
    let mut unique = Vec::new(); let mut groups: HashMap<String, String> = HashMap::new();
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    for value in paths {
        let path = selected_asset_paths(std::slice::from_ref(value), true)?.pop().ok_or("项目素材路径无效")?;
        let name = to_archive_text(&path); let folded = name.to_lowercase();
        if let Some(first) = groups.get(&folded) {
            if resolve(&path)? != resolve(Path::new(first))? { return Err("项目素材清单存在重复路径".into()); }
            aliases.entry(first.clone()).or_default().push(name);
        } else {
            groups.insert(folded, name.clone()); unique.push(name);
        }
    }
    Ok((unique, aliases))
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
    resolve_import_aliases: Option<bool>, reference_paths: Option<Vec<String>>) -> Result<Vec<ArchiveAssetInspection>, String> {
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
            let (unique, mapped) = resolve_import_path_aliases(paths, |path| selected_asset_file(&canonical_root, path)?
                .ok_or_else(|| "项目素材引用缺失".to_string()))?;
            aliases = mapped; Some(unique)
        } else { include_import_paths };
        let rows = inspect_assets_scoped(&root, imports.as_deref(), selected_paths.as_deref(), MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES)?;
        if let Some(references) = reference_paths {
            if !resolve_import_aliases.unwrap_or(false) || selected_paths.is_some() || references.len() > MAX_ARCHIVE_ENTRIES {
                return Err("项目素材扫描范围无效".into());
            }
            let canonical_root = root.canonicalize().map_err(|_| "无法解析项目素材目录")?;
            let by_name: HashMap<String, &str> = rows.iter().map(|row| (row.path.to_lowercase(), row.path.as_str())).collect();
            for value in references {
                let path = normalize_archive_path(Path::new(&value))?; let name = to_archive_text(&path);
                if name.is_empty() { return Err("项目素材路径无效".into()); }
                if let Some(first) = by_name.get(&name.to_lowercase()) {
                    if *first == name { continue; }
                    let first_file = selected_asset_file(&canonical_root, Path::new(first))?.ok_or("项目素材引用缺失")?;
                    let alias_file = selected_asset_file(&canonical_root, &path)?.ok_or("项目素材引用缺失")?;
                    if first_file != alias_file { return Err("项目素材清单存在重复路径".into()); }
                    let list = aliases.entry((*first).to_string()).or_default();
                    if !list.contains(&name) { list.push(name); }
                }
            }
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
    project_dir: String, operation_id: String, assets: Vec<ProjectImportAsset>, source_roots: Option<Vec<ProjectArchiveSourceRoot>>) -> Result<(), String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" || operation_id.len() > 128 || operation_id.is_empty()
        || !operation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("导入操作身份无效".into()); }
    let staging = authorize_path(&app, &staging_dir, PathAccess::Read)?;
    let root = authorize_path(&app, &project_dir, PathAccess::Write)?;
    let sources = authorize_source_roots(&app, source_roots.unwrap_or_default())?;
    let cancellation_id = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = ARCHIVE_PUBLICATION_LOCK.lock().map_err(|_| PUBLICATION_ERROR)?;
        reauthorize_archive_path(&app, &staging, PathAccess::Read)?;
        reauthorize_archive_path(&app, &root, PathAccess::Write)?;
        for source in sources.values() { reauthorize_archive_path(&app, source, PathAccess::Read)?; }
        let total_bytes = assets.iter().try_fold(0_u64, |total, asset| total.checked_add(asset.bytes)).ok_or("素材体积无效")?;
        if assets.len() > MAX_ARCHIVE_ENTRIES || total_bytes > MAX_EXPANDED_BYTES { return Err("导入素材超过上限".into()); }
        crate::file_transfer::ensure_disk_space(&root, Some(total_bytes))?;
        if crate::file_transfer::is_cancelled(&operation_id)? { return Err("项目导入已取消".into()); }
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
                if crate::file_transfer::is_cancelled(&operation_id)? { return Err("项目导入已取消".into()); }
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
                    if crate::file_transfer::is_cancelled(&operation_id)? { return Err("项目导入已取消".into()); }
                    let count = input.read(&mut buffer).map_err(|_| "素材发布读取失败")?; if count == 0 { break; }
                    bytes += count as u64;
                    if bytes > asset.bytes { return Err("暂存素材大小已变化".into()); }
                    output.write_all(&buffer[..count]).map_err(|_| "素材写入失败，原项目未改变")?; digest.update(&buffer[..count]);
                    transferred += count as u64;
                    let _ = app.emit_to("main", "file-transfer-progress", ImportProgress { task_id: operation_id.clone(), transferred_bytes: transferred, total_bytes });
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
        let file = selected_asset_file(&root, relative)?.ok_or("导出素材已缺失，请重新导出")?;
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
        let source = selected_asset_file(root, &relative)?.ok_or("源素材已缺失")?;
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
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取项目素材类型失败: {error}"))?;
        let name = entry.file_name();
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
            let source = selected_asset_file(root, source_path)?.ok_or("导出素材已缺失")?;
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
        publish_archive_exclusive(&temporary, &output)?;
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
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[cfg(all(windows, debug_assertions, feature = "project-model-fixture-host"))]
    #[test]
    fn fixture_archive_container_probe_uses_only_an_empty_isolated_root() {
        let fixture = Fixture::new();
        run_fixture_archive_container_probe(&fixture.0).unwrap();
        // 已有结果不能复用或覆盖；失败时材料保留供人工核对。
        assert!(run_fixture_archive_container_probe(&fixture.0).is_err());
        assert!(fixture.0.join("v4/synthetic.aicanvas").is_file());
    }

    #[test]
    fn publication_recovery_binds_original_operation_receipt_and_file() {
        let fixture = Fixture::new();
        let operation_id = "recovery-example";
        let output = fixture.0.join("project.aicanvas");
        let receipt = ArchivePublicationReceipt { operation_id: operation_id.into(), publication_ref: "a".repeat(64),
            output_path: output.to_str().unwrap().into(), result: None };
        write_publication_receipt(&publication_path(&fixture.0, operation_id, "prepared"), &receipt).unwrap();
        let original = pack_archive_with_publication(
            vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
            None, output.clone(), Some(vec![]), MAX_ARCHIVE_ENTRIES,
            Some(ArchivePublicationPlan { directory: fixture.0.clone(), receipt, recheck: None }), &HashMap::new(),
        ).unwrap();
        let published = publication_path(&fixture.0, operation_id, "published");
        fs::rename(&published, fixture.0.join("published-preserved.json")).unwrap();
        let authorize = |path: &str| {
            if Path::new(path) != output.as_path() { return Err(PUBLICATION_ERROR.into()); }
            Ok(output.clone())
        };
        assert_eq!(reconcile_publication(&fixture.0, operation_id, Some("wrong"), authorize).unwrap().status, "unknown");
        assert!(!published.exists());
        let authorizations = std::cell::Cell::new(0);
        let revoked = |path: &str| {
            authorizations.set(authorizations.get() + 1);
            if authorizations.get() != 1 || Path::new(path) != output.as_path() { return Err(PUBLICATION_ERROR.into()); }
            Ok(output.clone())
        };
        assert_eq!(reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), revoked).unwrap().status, "unknown");
        assert!(!published.exists());
        let recovered = reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), authorize).unwrap();
        assert_eq!(recovered.status, "published");
        assert_eq!(recovered.archive_sha256, original.archive_sha256);
        assert!(published.is_file());
        assert_eq!(reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), authorize).unwrap().status, "published");
        fs::write(&output, b"changed synthetic file").unwrap();
        assert_eq!(reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), authorize).unwrap().status, "unknown");
        assert!(fixture.0.join("published-preserved.json").is_file());
    }

    #[test]
    fn import_aliases_require_same_verified_path_and_preserve_first_spelling() {
        let paths = vec!["imports/op/asset.png".to_owned(), "Imports/op/asset.png".to_owned()];
        let (unique, aliases) = resolve_import_path_aliases(&paths, |_| Ok(PathBuf::from("same-canonical-file"))).unwrap();
        assert_eq!(unique, vec![paths[0].clone()]);
        assert_eq!(aliases.get(&paths[0]).unwrap(), &vec![paths[1].clone()]);
        assert!(resolve_import_path_aliases(&paths, |path| Ok(path.to_path_buf())).is_err());
        assert!(resolve_import_path_aliases(&paths, |_| Err("missing".into())).is_err());
        assert!(selected_asset_paths(&paths, true).is_err()); // 旧调用仍严格拒绝大小写冲突。
    }

    #[cfg(windows)]
    #[test]
    fn import_aliases_are_verified_on_actual_windows_filesystem() {
        let fixture = Fixture::new(); fixture.write("imports/op/asset.png", b"fixture");
        let paths = vec!["imports/op/asset.png".to_owned(), "Imports/op/asset.png".to_owned()];
        let (unique, aliases) = resolve_import_path_aliases(&paths, |path| selected_asset_file(&fixture.0, path)?
            .ok_or_else(|| "missing".to_string())).unwrap();
        assert_eq!(unique, vec![paths[0].clone()]); assert_eq!(aliases.get(&paths[0]).unwrap(), &vec![paths[1].clone()]);
        let rows = inspect_assets_scoped(&fixture.0, Some(&unique), None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
        assert_eq!(rows.len(), 1); assert_eq!(rows[0].path, paths[0]);
        let (bytes, sha256) = hash_file(&fixture.0.join(&paths[0]), &mut Vec::new()).unwrap();
        let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: paths[0].clone(), aliases: vec![paths[1].clone()], bytes, sha256 }];
        let roots = HashMap::from([("root".to_string(), fixture.0.clone())]);
        verify_export_aliases(&checks, &roots).unwrap();
        fs::write(fixture.0.join(&paths[0]), b"changed").unwrap();
        assert!(verify_export_aliases(&checks, &roots).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn alias_change_at_publication_keeps_output_unpublished() {
        let fixture = Fixture::new(); fixture.write("imports/op/asset.png", b"original");
        let root = fixture.0.clone(); let source = root.join("imports/op/asset.png");
        let (bytes, sha256) = hash_file(&source, &mut Vec::new()).unwrap();
        let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: "imports/op/asset.png".into(),
            aliases: vec!["Imports/op/asset.png".into()], bytes, sha256 }];
        let roots = HashMap::from([("root".to_string(), root.clone())]);
        verify_export_aliases(&checks, &roots).unwrap();
        let output = root.join("result.aicanvas");
        let receipt = ArchivePublicationReceipt { operation_id: "alias-change".into(), publication_ref: "a".repeat(64),
            output_path: output.to_str().unwrap().into(), result: None };
        let plan = ArchivePublicationPlan { directory: root, receipt, recheck: Some(Box::new(move || {
            fs::write(&source, b"changed").map_err(|_| "fixture write failed")?;
            verify_export_aliases(&checks, &roots)
        })) };
        assert!(pack_archive_with_publication(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
            None, output.clone(), None, MAX_ARCHIVE_ENTRIES, Some(plan), &HashMap::new()).is_err());
        assert!(!output.exists());
    }

    #[test]
    fn v4_text_allowlist_does_not_expand_the_legacy_archive_contract() {
        let valid = [("manifest.json", "{\"formatVersion\":4}"), ("project.json", "{}"), ("episodes.json", "[]"),
            ("canvases.json", "[]"), ("contents.json", "{}"), ("exchange.json", "{}")];
        let mut with_editor = valid.to_vec(); with_editor.push(("video-editor.json", "{}"));
        validate_v4_entry_names(with_editor).unwrap();
        let mut with_metadata = valid.to_vec(); with_metadata.push(("asset-metadata.json", "{}"));
        validate_v4_entry_names(with_metadata).unwrap();
        validate_v4_entry_names(valid).unwrap();
        let mut unknown = valid.to_vec(); unknown.push(("chat.json", "{}"));
        assert!(validate_v4_entry_names(unknown).is_err());
        assert!(validate_v4_entry_names(valid.into_iter().filter(|(name, _)| *name != "canvases.json")).is_err());
        validate_v4_entry_names([("manifest.json", "{\"formatVersion\":3}"), ("legacy-extension.json", "{}")]).unwrap();
    }

    #[test]
    fn publication_is_exclusive_and_keeps_a_durable_ready_receipt_before_output() {
        let fixture = Fixture::new();
        let output = fixture.0.join("result.aicanvas");
        let operation_id = "archive-operation-1";
        let receipt = ArchivePublicationReceipt { operation_id: operation_id.into(), publication_ref: "a".repeat(64),
            output_path: output.to_str().unwrap().into(), result: None };
        let prepared = publication_path(&fixture.0, operation_id, "prepared");
        write_publication_receipt(&prepared, &receipt).unwrap();
        assert!(write_publication_receipt(&prepared, &receipt).is_err());
        let result = pack_archive_with_publication(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
            None, output.clone(), None, MAX_ARCHIVE_ENTRIES, Some(ArchivePublicationPlan { directory: fixture.0.clone(), receipt, recheck: None }), &HashMap::new()).unwrap();
        let ready = read_publication_receipt(&publication_path(&fixture.0, operation_id, "ready")).unwrap();
        assert_eq!(ready.result.as_ref().unwrap().archive_sha256, result.archive_sha256);
        assert!(publication_path(&fixture.0, operation_id, "published").exists());
        let before = fs::read(&output).unwrap();
        let other = fixture.0.join("other.tmp"); fs::write(&other, b"different").unwrap();
        assert!(publish_archive_exclusive(&other, &output).is_err());
        assert_eq!(fs::read(output).unwrap(), before);
        assert_eq!(hash_file_with_limit(&fixture.0.join("result.aicanvas"), &mut Vec::new(), MAX_EXPANDED_BYTES + MAX_TEXT_BYTES).unwrap().1,
            result.archive_sha256.unwrap());
    }

    #[test]
    fn multi_root_sources_keep_equal_relative_names_separate_and_never_serialize_source_locations() {
        let fixture = Fixture::new();
        fixture.write("left/same.txt", b"left"); fixture.write("right/same.txt", b"right");
        let roots = HashMap::from([("left".to_string(), fixture.0.join("left")), ("right".to_string(), fixture.0.join("right"))]);
        let descriptor = |root: &str, path: &str| {
            let (bytes, sha256) = hash_file(&roots[root].join("same.txt"), &mut Vec::new()).unwrap();
            ArchiveAssetDigest { path: path.into(), bytes, sha256, source_root_ref: Some(root.into()), source_relative_path: Some("same.txt".into()) }
        };
        let assets = vec![descriptor("left", "one.txt"), descriptor("right", "two.txt")];
        let output = fixture.0.join("multi.aicanvas");
        pack_archive_with_publication(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
            None, output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES, None, &roots).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert_eq!(fs::read(target.join("one.txt")).unwrap(), b"left");
        assert_eq!(fs::read(target.join("two.txt")).unwrap(), b"right");
        assert!(unpacked.assets.iter().all(|asset| asset.source_root_ref.is_none() && asset.source_relative_path.is_none()));
        let mut invalid = assets.clone(); invalid[0].source_relative_path = Some("../right/same.txt".into());
        assert!(multi_root_asset_sources(&invalid, &roots, None).is_err());
        invalid[0].source_relative_path = None;
        assert!(multi_root_asset_sources(&invalid, &roots, None).is_err());
        fixture.write("left/same.txt", b"changed");
        assert!(multi_root_asset_sources(&assets, &roots, None).is_err());
    }

    #[test]
    fn import_directory_publication_does_not_replace_even_an_existing_empty_directory() {
        let fixture = Fixture::new();
        fixture.write("staged/note.txt", b"complete-content");
        let staged = fixture.0.join("staged");
        let occupied = fixture.0.join("occupied");
        fs::create_dir(&occupied).unwrap();
        assert!(publish_import_directory_exclusive(&staged, &occupied).is_err());
        assert!(staged.join("note.txt").exists());
        assert!(fs::read_dir(&occupied).unwrap().next().is_none());
        let published = fixture.0.join("published");
        publish_import_directory_exclusive(&staged, &published).unwrap();
        assert!(!staged.exists());
        assert_eq!(fs::read(published.join("note.txt")).unwrap(), b"complete-content");
    }

    #[test]
    fn effective_entry_size_is_budgeted_before_reading_content() {
        let mut builder = Builder::new(Vec::new());
        let metadata = b"10 size=8\n";
        let mut extension = Header::new_gnu();
        extension.set_entry_type(tar::EntryType::XHeader); extension.set_size(metadata.len() as u64); extension.set_cksum();
        builder.append_data(&mut extension, "metadata", metadata.as_slice()).unwrap();
        let mut header = Header::new_gnu(); header.set_size(8); header.set_cksum();
        builder.append_data(&mut header, "note.txt", [0_u8; 8].as_slice()).unwrap();
        let mut bytes = builder.into_inner().unwrap();
        let offset = {
            let mut raw = Archive::new(bytes.as_slice());
            let position = raw.entries().unwrap().raw(true).map(Result::unwrap).find(|entry| entry.header().entry_type().is_file())
                .unwrap().raw_header_position() as usize;
            position
        };
        let mut raw_header = Header::new_gnu(); raw_header.set_path("note.txt").unwrap();
        raw_header.set_size(0); raw_header.set_cksum(); bytes[offset..offset + 512].copy_from_slice(raw_header.as_bytes());
        validate_archive_stream(bytes.as_slice()).unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let mut entry = archive.entries().unwrap().next().unwrap().unwrap();
        assert_eq!(entry.size(), 8); assert_eq!(entry.header().entry_size().unwrap(), 0);
        let mut budget = 0;
        assert!(archive_entry_path(&entry, &mut HashSet::new(), &mut budget, 4).unwrap_err().contains("超过上限"));
        assert_eq!(budget, 8);
        let mut accepted = 0;
        assert_eq!(archive_entry_path(&entry, &mut HashSet::new(), &mut accepted, 8).unwrap(), Path::new("note.txt"));
        let mut body = Vec::new(); entry.read_to_end(&mut body).unwrap(); assert_eq!(body, [0_u8; 8]);
    }

    #[test]
    fn rejects_content_on_skipped_directory_and_root_entries() {
        for (path, kind) in [("folder/", tar::EntryType::Directory), (".", tar::EntryType::Regular), ("assets", tar::EntryType::Regular)] {
            let mut builder = Builder::new(Vec::new());
            let mut header = Header::new_gnu(); header.set_entry_type(kind); header.set_size(1); header.set_cksum();
            builder.append_data(&mut header, path, b"x".as_slice()).unwrap();
            let bytes = builder.into_inner().unwrap();
            let mut archive = Archive::new(bytes.as_slice());
            let entry = archive.entries().unwrap().next().unwrap().unwrap();
            let mut budget = 0;
            assert!(archive_entry_path(&entry, &mut HashSet::new(), &mut budget, 8).unwrap_err().contains("不能携带"));
            assert_eq!(budget, 1);
        }
    }

    #[test]
    fn effective_budget_is_accumulated_across_entries() {
        let mut builder = Builder::new(Vec::new());
        for name in ["a.txt", "b.txt"] {
            let mut header = Header::new_gnu(); header.set_size(2); header.set_cksum();
            builder.append_data(&mut header, name, b"ab".as_slice()).unwrap();
        }
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice()); let mut budget = 0; let mut seen = HashSet::new();
        let mut entries = archive.entries().unwrap();
        archive_entry_path(&entries.next().unwrap().unwrap(), &mut seen, &mut budget, 3).unwrap();
        assert!(archive_entry_path(&entries.next().unwrap().unwrap(), &mut seen, &mut budget, 3).unwrap_err().contains("超过上限"));
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ai-canvas-archive-regression-{}-{}-{}", std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&root).unwrap();
            Self(canonicalize_simplified(&root).unwrap())
        }
        fn write(&self, relative: &str, bytes: &[u8]) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let temporary = canonicalize_simplified(&std::env::temp_dir()).unwrap();
            assert!(self.0.starts_with(&temporary) && self.0 != temporary);
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn reused_hash_buffer_preserves_large_short_and_empty_file_digests() {
        let fixture = Fixture::new();
        let large: Vec<u8> = (0..IO_BUFFER_BYTES + 17).map(|index| (index % 251) as u8).collect();
        let files = [("large.bin", large.as_slice()), ("short.bin", b"short tail".as_slice()), ("empty.bin", b"".as_slice())];
        let mut buffer = Vec::new();
        for (path, contents) in files {
            fixture.write(path, contents);
            let actual = hash_file(&fixture.0.join(path), &mut buffer).unwrap();
            assert_eq!(actual, (contents.len() as u64, format!("{:x}", Sha256::digest(contents))));
        }
    }

    #[test]
    fn round_trips_multiple_assets_across_reused_buffer_boundaries() {
        let fixture = Fixture::new();
        let large: Vec<u8> = (0..IO_BUFFER_BYTES + 17).map(|index| (index % 251) as u8).collect();
        let files = [("large.bin", large.as_slice()), ("short.bin", b"short tail".as_slice()), ("empty.bin", b"".as_slice())];
        for (path, contents) in files { fixture.write(&format!("source/{path}"), contents); }
        let source = fixture.0.join("source");
        let expected = inspect_assets_scoped(&source, Some(&[]), None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
        let archive = fixture.0.join("project.aicanvas");
        pack_archive(vec![], Some(source), archive.clone(), Some(expected.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let mut actual = unpack_archive(&archive, &target).unwrap().assets;
        actual.sort_by(|left, right| left.path.cmp(&right.path));
        assert!(actual == expected);
        for (path, contents) in files { assert_eq!(fs::read(target.join(path)).unwrap(), contents); }
    }

    // 只替换 AppHandle 授权入口；路径解析、父链存在性、目录和链接检查均操作真实文件系统。
    fn filesystem_authorize(path: &Path, existing_plain: bool) -> Result<PathBuf, String> {
        if existing_plain {
            let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let reparse = false;
            if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse {
                return Err("必须为普通目录".into());
            }
        }
        match canonicalize_simplified(path) {
            Ok(resolved) => Ok(resolved),
            Err(error) if !existing_plain && error.kind() == std::io::ErrorKind::NotFound => {
                let parent = canonicalize_simplified(path.parent().ok_or("缺少父目录")?).map_err(|error| error.to_string())?;
                Ok(parent.join(path.file_name().ok_or("缺少目录名")?))
            },
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(windows)]
    #[test]
    fn selected_media_source_matches_production_authorization_without_verbatim_prefix() {
        let fixture = Fixture::new();
        let name = "原媒体产物_1.png";
        let contents = b"synthetic image publication bytes";
        fixture.write(name, contents);
        // 生产 authorize_path 使用简化根；std::canonicalize 的文件路径仍带 verbatim 前缀。
        let root = filesystem_authorize(&fixture.0, true).unwrap();
        let verbatim_root = root.canonicalize().unwrap();
        let verbatim_file = root.join(name).canonicalize().unwrap();
        assert!(!root.to_string_lossy().starts_with(r"\\?\"));
        assert!(verbatim_file.to_string_lossy().starts_with(r"\\?\"));
        assert!(!verbatim_file.starts_with(&root));

        let selected = selected_asset_file(&root, Path::new(name)).unwrap().unwrap();
        assert_eq!(selected, root.join(name));
        assert!(selected.starts_with(&root));
        // 覆盖 publish_project_import_assets 随后的再次授权相等检查，而非只通过 containment。
        assert_eq!(filesystem_authorize(&selected, false).unwrap(), selected);
        assert_eq!(filesystem_authorize(&verbatim_file, false).unwrap(), selected);
        assert_eq!(selected_asset_file(&verbatim_root, Path::new(name)).unwrap().unwrap(), selected);
        let (bytes, sha256) = hash_file(&selected, &mut Vec::new()).unwrap();
        assert_eq!(bytes, contents.len() as u64);
        assert_eq!(sha256, format!("{:x}", Sha256::digest(contents)));

        let asset = ArchiveAssetDigest { path: name.into(), bytes, sha256, source_root_ref: Some("source".into()),
            source_relative_path: Some(name.into()) };
        let sources = multi_root_asset_sources(&[asset], &HashMap::from([("source".into(), root.clone())]), None).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(selected_asset_file(&sources[0].0, &sources[0].1).unwrap().unwrap(), selected);
        assert_eq!(fs::read(root.join(name)).unwrap(), contents); // 规范化不移动、覆盖或删除原文件。
    }

    #[test]
    fn selected_media_source_keeps_plain_root_and_relative_component_checks() {
        let fixture = Fixture::new(); fixture.write("image.png", b"synthetic");
        assert!(selected_asset_file(&fixture.0.join("image.png"), Path::new("other.png")).is_err());
        assert!(selected_asset_file(&fixture.0, Path::new("../image.png")).is_err());
        assert!(selected_asset_file(&fixture.0, fixture.0.join("image.png").as_path()).is_err());
        assert!(selected_asset_file(&fixture.0, Path::new("missing.png")).unwrap().is_none());
        assert_eq!(fs::read(fixture.0.join("image.png")).unwrap(), b"synthetic");
    }

    #[test]
    fn scoped_scan_counts_current_files_without_historical_imports() {
        let fixture = Fixture::new();
        fixture.write("current.txt", b"now");
        fixture.write("imports/old-a.txt", b"history a");
        fixture.write("imports/old-b.txt", b"history b");
        fixture.write("imports/live/current.txt", b"live");
        assert!(inspect_assets_scoped(&fixture.0, None, None, 1, 3).is_err());
        let current = inspect_assets_scoped(&fixture.0, Some(&[]), None, 1, 3).unwrap();
        assert_eq!(current.len(), 1); assert_eq!(current[0].path, "current.txt");
        let include = vec!["imports/live/current.txt".to_owned()];
        let current = inspect_assets_scoped(&fixture.0, Some(&include), None, 2, 7).unwrap();
        assert_eq!(current.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(), ["current.txt", "imports/live/current.txt"]);
        assert!(inspect_assets_scoped(&fixture.0, Some(&include), None, 2, 6).is_err());
    }

    #[test]
    fn scoped_scan_preserves_imports_spelling_and_skips_history_case_insensitively() {
        for directory in ["Imports", "IMPORTS"] {
            let fixture = Fixture::new();
            fixture.write("current.txt", b"now");
            let current = format!("{directory}/live/current.txt");
            fixture.write(&current, b"live");
            fixture.write(&format!("{directory}/recovery/old.txt"), b"unrelated historical bytes");
            let regular = inspect_assets_scoped(&fixture.0, Some(&[]), None, 1, 3).unwrap();
            assert_eq!(regular.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(), ["current.txt"]);
            let include = vec![current.clone()];
            let selected = inspect_assets_scoped(&fixture.0, Some(&include), None, 2, 7).unwrap();
            assert_eq!(selected.len(), 2);
            assert!(selected.iter().any(|row| row.path == current));
            let output = fixture.0.with_extension("aicanvas");
            pack_archive(vec![], Some(fixture.0.clone()), output.clone(), Some(selected.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
            let target = Fixture::new();
            assert!(unpack_archive(&output, &target.0).unwrap().assets == selected);
            fs::remove_file(output).unwrap();
        }
    }

    #[test]
    fn explicit_scans_and_pack_reject_excluded_directories() {
        for path in [".trash/current.png", "imports/op/.trash/current.png", ".thumbnail/current.png"] {
            let fixture = Fixture::new(); fixture.write(path, b"img");
            let selected = vec![path.to_owned()];
            assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 3).err().unwrap().contains("回收站或派生缓存"));
            if path.starts_with("imports/") {
                assert!(inspect_assets_scoped(&fixture.0, Some(&selected), None, 1, 3).err().unwrap().contains("回收站或派生缓存"));
            }
            let (bytes, sha256) = hash_file(&fixture.0.join(path), &mut Vec::new()).unwrap();
            let output = fixture.0.with_extension("aicanvas");
            assert!(pack_archive(vec![], Some(fixture.0.clone()), output.clone(),
                Some(vec![ArchiveAssetDigest { path: path.to_owned(), bytes, sha256, source_root_ref: None, source_relative_path: None }]), MAX_ARCHIVE_ENTRIES)
                .err().unwrap().contains("回收站或派生缓存"));
            assert!(!output.exists());
            assert_eq!(fs::read(fixture.0.join(path)).unwrap(), b"img");
        }
    }

    #[cfg(windows)]
    #[test]
    fn explicit_scans_reject_windows_excluded_directory_case_aliases() {
        for path in [".trash/current.png", "imports/op/.trash/current.png", ".thumbnail/current.png"] {
            let fixture = Fixture::new(); fixture.write(path, b"img");
            let alias = path.to_ascii_uppercase(); let selected = vec![alias.clone()];
            assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 3).is_err());
            if path.starts_with("imports/") {
                assert!(inspect_assets_scoped(&fixture.0, Some(&selected), None, 1, 3).is_err());
            }
            let (bytes, sha256) = hash_file(&fixture.0.join(path), &mut Vec::new()).unwrap();
            assert!(pack_archive(vec![], Some(fixture.0.clone()), fixture.0.with_extension("aicanvas"),
                Some(vec![ArchiveAssetDigest { path: alias, bytes, sha256, source_root_ref: None, source_relative_path: None }]), MAX_ARCHIVE_ENTRIES).is_err());
        }
    }

    #[test]
    fn explicit_scans_keep_nested_thumbnail_directories_and_same_named_plain_files() {
        let fixture = Fixture::new();
        let selected = ["user/.thumbnail/current.png", "imports/op/.thumbnail/current.png", ".trash", ".thumbnail"]
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        for path in &selected { fixture.write(path, b"img"); }
        let assets = inspect_assets_scoped(&fixture.0, None, Some(&selected), 4, 12).unwrap();
        let include = vec!["imports/op/.thumbnail/current.png".to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, Some(&include), None, 4, 12).unwrap() == assets);
        let output = fixture.0.with_extension("aicanvas");
        pack_archive(vec![], Some(fixture.0.clone()), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
        let target = Fixture::new();
        assert!(unpack_archive(&output, &target.0).unwrap().assets == assets);
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn selected_recovery_scan_reports_missing_or_changed_files_by_digest() {
        let fixture = Fixture::new();
        fixture.write("current.txt", b"current content outside recovery budget");
        fixture.write("imports/recovery/keep.txt", b"keep");
        fixture.write("imports/other/history.txt", b"unrelated history outside recovery budget");
        let selected = vec!["imports/recovery/keep.txt".to_owned(), "imports/recovery/missing.txt".to_owned()];
        let before = inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 4).unwrap();
        assert_eq!(before.len(), 1); assert_eq!(before[0].path, selected[0]);
        fixture.write("imports/recovery/keep.txt", b"edit");
        let after = inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 4).unwrap();
        assert_ne!(before[0].sha256, after[0].sha256);
        fs::remove_file(fixture.0.join("imports/recovery/keep.txt")).unwrap();
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 4).unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_scope_paths_and_duplicate_aliases() {
        let fixture = Fixture::new(); fixture.write("current.txt", b"current");
        for selected in [vec!["../outside.txt"], vec!["/outside.txt"], vec!["imports\\outside.txt"],
            vec!["current.txt", "./current.txt"], vec!["current.txt", "CURRENT.txt"], vec![""]] {
            let selected = selected.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
        }
        let selected = vec!["current.txt".to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, Some(&selected), None, 10, 100).is_err());
        assert!(inspect_assets_scoped(&fixture.0, Some(&[]), Some(&[]), 10, 100).is_err());
        let directory = vec!["imports".to_owned()]; fs::create_dir(fixture.0.join("imports")).unwrap();
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&directory), 10, 100).is_err());
        assert_eq!(fs::read(fixture.0.join("current.txt")).unwrap(), b"current");
    }

    #[test]
    fn packs_only_selected_current_files_despite_other_project_history() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        fixture.write("source/current.txt", b"now");
        fixture.write("source/imports/old-a.txt", b"history a");
        fixture.write("source/imports/old-b.txt", b"history b");
        let assets = inspect_assets_scoped(&source, Some(&[]), None, 1, 3).unwrap();
        let output = fixture.0.join("project.aicanvas");
        pack_archive(vec![], Some(source.clone()), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert!(unpacked.assets == assets);
        assert_eq!(fs::read(target.join("current.txt")).unwrap(), b"now");
        assert!(!target.join("imports").exists());
        fs::write(source.join("current.txt"), b"changed").unwrap();
        assert!(pack_archive(vec![], Some(source), output, Some(assets), MAX_ARCHIVE_ENTRIES).is_err());
    }

    #[test]
    fn creates_first_import_parent_and_reuses_it_without_overwriting_operations() {
        let fixture = Fixture::new();
        assert!(!fixture.0.join("imports").exists());
        let first = create_import_destination(&fixture.0, "first", filesystem_authorize).unwrap();
        fs::write(first.join("keep.txt"), b"original").unwrap();
        let second = create_import_destination(&fixture.0, "second", filesystem_authorize).unwrap();
        assert!(second.is_dir());
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
    }

    #[test]
    fn rejects_import_parent_files_and_existing_operation_files() {
        let fixture = Fixture::new();
        fixture.write("imports", b"keep parent");
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(fixture.0.join("imports")).unwrap(), b"keep parent");
        fs::remove_file(fixture.0.join("imports")).unwrap();
        fixture.write("imports/first", b"keep operation");
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(fixture.0.join("imports/first")).unwrap(), b"keep operation");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_import_parent_and_operation_links_without_touching_targets() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let other = Fixture::new();
        other.write("keep.txt", b"outside");
        symlink(&other.0, fixture.0.join("imports")).unwrap();
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        let selected = vec!["imports/keep.txt".to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
        assert!(inspect_assets_scoped(&fixture.0, Some(&[]), None, 10, 100).unwrap().is_empty());
        fs::remove_file(fixture.0.join("imports")).unwrap();
        fs::create_dir(fixture.0.join("imports")).unwrap();
        symlink(&other.0, fixture.0.join("imports/first")).unwrap();
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        let selected = vec!["imports/first/keep.txt".to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
        assert_eq!(fs::read(other.0.join("keep.txt")).unwrap(), b"outside");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_import_junctions_without_touching_targets() {
        struct Junction(PathBuf);
        impl Junction {
            fn new(link: PathBuf, target: &Path) -> Self {
                let shell_path = |path: &Path| {
                    let text = path.to_str().unwrap();
                    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
                    assert!(!text.chars().any(|character| "\"&|<>^%!()\r\n".contains(character)), "测试路径含 shell 特殊字符");
                    text.to_owned()
                };
                let output = std::process::Command::new("cmd.exe")
                    .args(["/d", "/v:off", "/c", "mklink", "/J"])
                    .arg(shell_path(&link)).arg(shell_path(target)).output().unwrap();
                assert!(output.status.success(), "创建测试目录联接失败：{}", String::from_utf8_lossy(&output.stderr));
                Self(link)
            }
        }
        impl Drop for Junction {
            fn drop(&mut self) {
                // remove_dir 只解除联接；目标及其文件由独立 Fixture 管理。
                fs::remove_dir(&self.0).unwrap();
            }
        }
        let fixture = Fixture::new();
        let other = Fixture::new();
        other.write("keep.txt", b"outside");
        {
            let _link = Junction::new(fixture.0.join("imports"), &other.0);
            assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
            let selected = vec!["imports/keep.txt".to_owned()];
            assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
            assert!(inspect_assets_scoped(&fixture.0, Some(&[]), None, 10, 100).unwrap().is_empty());
        }
        fs::create_dir(fixture.0.join("imports")).unwrap();
        {
            let _link = Junction::new(fixture.0.join("imports/first"), &other.0);
            assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
            let selected = vec!["imports/first/keep.txt".to_owned()];
            assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
        }
        assert_eq!(fs::read(other.0.join("keep.txt")).unwrap(), b"outside");
    }

    #[test]
    fn round_trips_long_chinese_paths_and_preserves_bytes() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        let relative = format!("{}/制作总览.md", vec!["汉".repeat(20); 8].join("/"));
        assert!(relative.len() > 255);
        let file = source.join(&relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# 中文原稿\n连续性待核对").unwrap();
        let mut assets = Vec::new(); inspect_assets(&source, Path::new(""), &mut assets).unwrap();
        let output = fixture.0.join("project.aicanvas");
        pack_archive(vec![], Some(source), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert!(unpacked.assets == assets);
        assert_eq!(fs::read(target.join(relative)).unwrap(), "# 中文原稿\n连续性待核对".as_bytes());
    }

    #[test]
    fn round_trips_an_archive_without_assets_and_creates_empty_import_destination() {
        let fixture = Fixture::new();
        let output = fixture.0.join("project.aicanvas");
        let result = pack_archive(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
            None, output.clone(), Some(vec![]), MAX_ARCHIVE_ENTRIES).unwrap();
        assert_eq!(result.asset_count, 0);
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert!(unpacked.assets.is_empty());
        assert_eq!(unpacked.texts["manifest.json"], "{}");
        let destination = create_import_destination(&fixture.0, "empty", filesystem_authorize).unwrap();
        assert!(destination.is_dir() && fs::read_dir(destination).unwrap().next().is_none());
    }

    #[test]
    fn rejects_complete_asset_path_byte_overflow_before_replacing_export() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        let relative = format!("{}/{}.md", vec!["汉".repeat(40); 8].join("/"), "文".repeat(16));
        assert!(relative.len() <= 1024 && format!("assets/{relative}").len() > 1024);
        // 用多根映射保留超长归档名，避免先撞上本机文件系统的路径上限。
        fixture.write("source/note.md", b"text");
        let (bytes, sha256) = hash_file(&source.join("note.md"), &mut Vec::new()).unwrap();
        let assets = vec![ArchiveAssetDigest { path: relative, bytes, sha256,
            source_root_ref: Some("root".into()), source_relative_path: Some("note.md".into()) }];
        let roots = HashMap::from([("root".to_string(), source)]);
        let output = fixture.0.join("project.aicanvas"); fs::write(&output, b"existing export").unwrap();
        let error = pack_archive_with_publication(vec![], None, output.clone(), Some(assets),
            MAX_ARCHIVE_ENTRIES, None, &roots).err().unwrap();
        assert!(error.contains("不安全路径"));
        assert_eq!(fs::read(output).unwrap(), b"existing export");
        assert!(!fs::read_dir(&fixture.0).unwrap().any(|item| item.unwrap().path().extension().is_some_and(|value| value == "part")));
    }

    #[test]
    fn complete_asset_depth_limit_matches_import_and_rejects_before_publish() {
        for components in [63, 64] {
            let fixture = Fixture::new();
            let source = fixture.0.join("source");
            let relative = format!("{}/note.md", vec!["a"; components - 1].join("/"));
            let file = source.join(&relative); fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(file, b"note").unwrap();
            let output = fixture.0.join("project.aicanvas");
            let result = pack_archive(vec![], Some(source), output.clone(), None, MAX_ARCHIVE_ENTRIES);
            if components == 63 {
                assert!(result.is_ok());
                let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
                unpack_archive(&output, &target).unwrap();
                assert_eq!(fs::read(target.join(relative)).unwrap(), b"note");
            } else {
                assert!(result.err().unwrap().contains("不安全路径"));
                assert!(!output.exists());
            }
        }
    }

    #[test]
    fn counts_gnu_name_extensions_and_json_entries_before_export_publish() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source"); fs::create_dir(&source).unwrap();
        let name = format!("{}.txt", "长".repeat(40)); fs::write(source.join(&name), b"asset").unwrap();
        let entries = || vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }];
        let output = fixture.0.join("project.aicanvas"); fs::write(&output, b"existing export").unwrap();
        let error = pack_archive(entries(), Some(source.clone()), output.clone(), None, 2).err().unwrap();
        assert!(error.contains("条目超过上限"));
        assert_eq!(fs::read(&output).unwrap(), b"existing export");
        pack_archive(entries(), Some(source), output.clone(), None, 3).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert_eq!(unpacked.texts["manifest.json"], "{}");
        assert_eq!(fs::read(target.join(name)).unwrap(), b"asset");
    }

    #[test]
    fn rejects_oversized_extensions_before_tar_allocates_them() {
        for kind in [tar::EntryType::GNULongName, tar::EntryType::XHeader, tar::EntryType::XGlobalHeader] {
            let mut header = Header::new_gnu();
            header.set_path("metadata").unwrap(); header.set_entry_type(kind);
            header.set_size(MAX_EXTENSION_BYTES + 1); header.set_cksum();
            assert!(validate_archive_stream(header.as_bytes().as_slice()).unwrap_err().contains("扩展"));
        }
    }

    #[test]
    fn selected_export_omits_recovery_files_and_keeps_active_imports() {
        let directory = std::env::temp_dir().join(format!("ai-canvas-selected-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(directory.join("imports/active")).unwrap();
        fs::create_dir_all(directory.join("imports/recovery")).unwrap();
        fs::write(directory.join("imports/active/a.png"), b"current").unwrap();
        fs::write(directory.join("imports/recovery/a.png"), b"private-old-content").unwrap();
        let selected = HashSet::from(["imports/active/a.png".to_string()]);
        let mut builder = Builder::new(Vec::new()); let mut stats = AssetStats { count: 0, bytes: 0 };
        append_assets_dir(&mut builder, &directory, Path::new(ASSETS_PREFIX), &mut stats, Some(&selected)).unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let paths: Vec<_> = archive.entries().unwrap().map(|item| to_archive_text(&item.unwrap().path().unwrap())).collect();
        let resolved = directory.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(&resolved).unwrap();
        assert_eq!(paths, ["assets/imports/active/a.png"]); assert_eq!(stats.bytes, 7);
    }

    #[test]
    fn rejects_paths_escaping_the_archive_root() {
        assert!(normalize_archive_path(Path::new("../secret.json")).is_err());
        assert!(normalize_archive_path(Path::new("/etc/passwd")).is_err());
        assert!(normalize_archive_path(Path::new("assets\\a.png")).is_err());
    }

    #[test]
    fn keeps_normal_relative_paths() {
        let normalized =
            normalize_archive_path(Path::new("./assets/分组/a.png")).expect("路径可归一化");
        assert_eq!(to_archive_text(&normalized), "assets/分组/a.png");
    }

    #[test]
    fn inspects_and_packs_nested_assets_with_portable_paths() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-archive-paths-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let files = [
            ("EP000｜剧本、视觉与制作说明/EP000 制作总览与连续性待核对.md", "# 制作总览\n连续性待核对"),
            ("EP000｜剧本、视觉与制作说明/参考/人物.md", "# 人物\n中文正文"),
        ];
        for (path, content) in files {
            let target = directory.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, content.as_bytes()).unwrap();
        }

        let mut assets = Vec::new();
        inspect_assets(&directory, Path::new(""), &mut assets).unwrap();
        assets.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(assets.len(), files.len());
        for (asset, (path, content)) in assets.iter().zip(files) {
            assert_eq!(asset.path, path);
            assert_eq!(asset.bytes, content.len() as u64);
            assert_eq!(asset.sha256, format!("{:x}", Sha256::digest(content.as_bytes())));
            assert!(normalize_archive_path(Path::new(&asset.path)).is_ok());
        }

        let selected = assets.iter().map(|asset| asset.path.clone()).collect::<HashSet<_>>();
        let mut builder = Builder::new(Vec::new());
        let mut stats = AssetStats { count: 0, bytes: 0 };
        append_assets_dir(&mut builder, &directory, Path::new(ASSETS_PREFIX), &mut stats, Some(&selected)).unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let mut packed = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = normalize_archive_path(&entry.path().unwrap()).unwrap();
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            packed.push((to_archive_text(&path), content));
        }
        packed.sort();

        let resolved = directory.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(&resolved).unwrap();
        assert_eq!(packed, files.map(|(path, content)| (format!("assets/{path}"), content.to_string())));
        assert_eq!(stats.count, files.len());
    }

    #[test]
    fn omits_root_thumbnail_cache_but_preserves_nested_user_directory() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-archive-thumbnail-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(directory.join(".thumbnail")).unwrap();
        fs::create_dir_all(directory.join("group/.thumbnail")).unwrap();
        fs::write(directory.join(".thumbnail/cache.webp"), b"cache").unwrap();
        fs::write(directory.join("group/.thumbnail/user.png"), b"user").unwrap();
        fs::write(directory.join("original.png"), b"original").unwrap();

        let mut builder = Builder::new(Vec::new());
        let mut stats = AssetStats { count: 0, bytes: 0 };
        append_assets_dir(
            &mut builder,
            &directory,
            Path::new(ASSETS_PREFIX),
            &mut stats,
            None,
        )
        .unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let mut paths: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|entry| to_archive_text(&entry.unwrap().path().unwrap()))
            .collect();
        paths.sort();

        // The only recursive removal belongs to this test's newly created temporary directory.
        let resolved = directory.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(&resolved).unwrap();

        assert_eq!(
            paths,
            ["assets/group/.thumbnail/user.png", "assets/original.png"]
        );
        assert_eq!(stats.count, 2);
        assert_eq!(stats.bytes, 12);
    }
}
