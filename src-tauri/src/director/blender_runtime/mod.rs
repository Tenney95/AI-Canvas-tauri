//! Blender 原生运行时的受限安装候选发现。
//!
//! Windows 端只读取固定的应用注册位置、PATH、Steam 元数据和 Program Files 标准层级；
//! macOS 端只读取 Applications 标准层级、固定 Steam 路径与 PATH 中的应用包入口；
//! 不执行候选、不扫描整块磁盘，也不向前端暴露绝对路径。

mod job;
#[cfg(any(target_os = "macos", test))]
mod macos;
pub mod project_grant;
mod resources;
mod result;
mod runner;

pub use job::{BlenderJobCore, BlenderJobStartRequest, BlenderJobStatus};
pub use project_grant::ProjectGrantState;
pub use result::BlenderCollectedResult;

use crate::path_policy::is_link_or_reparse;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Runtime, State, Webview};

const BLENDER_VENDOR_DIRECTORY: &str = "Blender Foundation";
#[cfg(not(target_os = "macos"))]
const BLENDER_EXECUTABLE_NAME: &str = "blender.exe";
#[cfg(target_os = "macos")]
const BLENDER_EXECUTABLE_NAME: &str = "Blender";
const STEAM_BLENDER_APP_ID: &str = "365670";
const INSTALLATION_ID_DOMAIN: &[u8] = b"ai-canvas/blender-installation/v1\0";
const MAX_DISCOVERY_ROOTS: usize = 3;
const MAX_DIRECT_DISCOVERY_HINTS: usize = 64;
const MAX_PATH_ENTRIES: usize = 256;
const MAX_STEAM_LIBRARY_ROOTS: usize = 32;
const MAX_STEAM_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 128;
const MAX_RETURNED_CANDIDATES: usize = 16;
const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_VERSION_HINT_CHARS: usize = 32;
const BLENDER_PRIVATE_DIRECTORY: &str = "blender-native-private";
const BLENDER_SELECTION_FILE: &str = "selected-installation.json";
const BLENDER_SELECTION_SCHEMA_VERSION: u32 = 1;
const MAX_BLENDER_SELECTION_BYTES: u64 = 4 * 1024;

/// 候选来源只描述本轮扫描入口，不代表候选已通过版本或架构验证。
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum BlenderInstallationSource {
    #[serde(rename = "program-files-64")]
    ProgramFiles64,
    #[serde(rename = "program-files")]
    ProgramFiles,
    #[serde(rename = "program-files-x86")]
    ProgramFilesX86,
    #[serde(rename = "windows-app-paths")]
    WindowsAppPaths,
    #[serde(rename = "windows-uninstall")]
    WindowsUninstall,
    #[serde(rename = "environment-path")]
    EnvironmentPath,
    #[serde(rename = "steam")]
    Steam,
    #[cfg(any(target_os = "macos", test))]
    #[serde(rename = "macos-applications")]
    MacApplications,
    #[cfg(any(target_os = "macos", test))]
    #[serde(rename = "macos-user-applications")]
    MacUserApplications,
    #[serde(rename = "user-selected")]
    UserSelected,
}

/// 返回给前端的只读候选摘要，不包含可执行文件或安装目录路径。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderInstallationCandidate {
    installation_id: String,
    display_name: String,
    source: BlenderInstallationSource,
    version_hint: Option<String>,
    version_hint_is_verified: bool,
}

/// 明确声明发现范围非穷尽，避免空列表被误读为“本机未安装”。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlenderDiscoveryScope {
    WindowsKnownInstallLocations,
    #[cfg(target_os = "macos")]
    MacKnownInstallLocations,
    #[cfg(not(any(windows, target_os = "macos")))]
    UnsupportedPlatform,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderDiscoveryResult {
    candidates: Vec<BlenderInstallationCandidate>,
    supports_saved_scene: bool,
    scope: BlenderDiscoveryScope,
    exhaustive: bool,
    partial: bool,
    truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedBlenderSelection {
    schema_version: u32,
    executable_path: String,
}

/// 发现记录只存在于当前 Rust 进程内；后续 Job 启动仍必须重新校验路径和兼容性。
#[derive(Default)]
pub struct BlenderRuntimeState {
    installations: Mutex<HashMap<String, InstallationRecord>>,
}

#[derive(Clone, Debug)]
struct InstallationRecord {
    candidate: BlenderInstallationCandidate,
    canonical_root: PathBuf,
    canonical_executable: PathBuf,
}

#[derive(Clone, Debug)]
struct DiscoveryRoot {
    source: BlenderInstallationSource,
    path: PathBuf,
}

#[derive(Clone, Debug)]
struct DirectDiscoveryHint {
    source: BlenderInstallationSource,
    executable_path: PathBuf,
    display_name: String,
    version_hint: Option<String>,
}

#[derive(Default)]
struct DirectDiscoveryHints {
    hints: Vec<DirectDiscoveryHint>,
    partial: bool,
    truncated: bool,
}

#[derive(Clone, Debug)]
struct DiscoveredInstallation {
    candidate: BlenderInstallationCandidate,
    canonical_root: PathBuf,
    canonical_executable: PathBuf,
    identity_key: Vec<u8>,
}

#[derive(Default)]
struct RootDiscovery {
    installations: Vec<DiscoveredInstallation>,
    partial: bool,
    truncated: bool,
}

#[derive(Default)]
struct DiscoverySnapshot {
    installations: Vec<DiscoveredInstallation>,
    partial: bool,
    truncated: bool,
}

enum DirectoryEntriesError {
    Unavailable,
    LimitExceeded,
}

impl BlenderRuntimeState {
    fn replace_installations(
        &self,
        installations: &[DiscoveredInstallation],
    ) -> Result<(), String> {
        let next: HashMap<_, _> = installations
            .iter()
            .map(|installation| {
                (
                    installation.candidate.installation_id.clone(),
                    InstallationRecord {
                        candidate: installation.candidate.clone(),
                        canonical_root: installation.canonical_root.clone(),
                        canonical_executable: installation.canonical_executable.clone(),
                    },
                )
            })
            .collect();

        let mut current = self
            .installations
            .lock()
            .map_err(|_| "Blender 安装候选状态不可用".to_string())?;
        current
            .retain(|_, record| record.candidate.source == BlenderInstallationSource::UserSelected);
        current.extend(next);
        Ok(())
    }

    fn register_manual(
        &self,
        record: InstallationRecord,
    ) -> Result<BlenderInstallationCandidate, String> {
        let candidate = record.candidate.clone();
        self.installations
            .lock()
            .map_err(|_| "Blender 安装候选状态不可用".to_string())?
            .insert(candidate.installation_id.clone(), record);
        Ok(candidate)
    }

    fn resolve_installation(&self, installation_id: &str) -> Result<InstallationRecord, String> {
        let installations = self
            .installations
            .lock()
            .map_err(|_| "Blender 安装候选状态不可用".to_string())?;
        installations
            .get(installation_id)
            .cloned()
            .ok_or_else(|| "Blender 安装候选不存在或已失效".to_string())
    }

    #[cfg(test)]
    fn installation_count(&self) -> usize {
        self.installations.lock().expect("测试状态锁不应中毒").len()
    }
}

pub(crate) fn blender_private_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(BLENDER_PRIVATE_DIRECTORY))
        .map_err(|_| "无法定位 Blender 私有运行目录".to_string())
}

pub(crate) fn is_blender_private_path_overlap<R: Runtime>(
    app: &AppHandle<R>,
    resolved: &Path,
) -> bool {
    blender_private_dir(app)
        .map(|directory| {
            let private = directory.components().collect::<PathBuf>();
            resolved == private || resolved.starts_with(&private) || private.starts_with(resolved)
        })
        .unwrap_or(false)
}

pub fn prepare_blender_private_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    use tauri_plugin_fs::FsExt;
    let directory = blender_private_dir(app)?;
    fs::create_dir_all(&directory).map_err(|_| "无法创建 Blender 私有运行目录".to_string())?;
    let metadata =
        fs::symlink_metadata(&directory).map_err(|_| "Blender 私有运行目录不可用".to_string())?;
    if !is_plain_directory(&metadata) {
        return Err("Blender 私有运行目录不安全".to_string());
    }
    let canonical = directory
        .canonicalize()
        .map_err(|_| "Blender 私有运行目录不可用".to_string())?;
    app.fs_scope()
        .forbid_directory(&canonical, true)
        .map_err(|_| "无法隔离 Blender 私有运行目录".to_string())?;
    let _ = app.state::<tauri::scope::Scopes>().forbid_file(&canonical);
    Ok(canonical)
}

pub fn production_blender_job_core() -> BlenderJobCore {
    use job::{DefaultBlenderJobIdGenerator, NoopBlenderJobEventSink, SystemBlenderJobClock};
    use std::sync::Arc;
    BlenderJobCore::with_dependencies(
        Arc::new(runner::NativeBlenderJobRunner::default()),
        Arc::new(SystemBlenderJobClock),
        Arc::new(DefaultBlenderJobIdGenerator::default()),
        Arc::new(NoopBlenderJobEventSink),
    )
}

/// 只允许主窗口发起候选发现；其他首方窗口也不能扩大这一入口。
fn ensure_main_window_label(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err("仅主窗口可以发现 Blender 安装候选".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn platform_discovery_roots() -> Vec<DiscoveryRoot> {
    [
        (BlenderInstallationSource::ProgramFiles64, "ProgramW6432"),
        (BlenderInstallationSource::ProgramFiles, "ProgramFiles"),
        (
            BlenderInstallationSource::ProgramFilesX86,
            "ProgramFiles(x86)",
        ),
    ]
    .into_iter()
    .filter_map(|(source, variable)| {
        std::env::var_os(variable).map(|path| DiscoveryRoot {
            source,
            path: PathBuf::from(path),
        })
    })
    .collect()
}

#[cfg(not(windows))]
fn platform_discovery_roots() -> Vec<DiscoveryRoot> {
    Vec::new()
}

#[cfg(windows)]
fn platform_discovery_scope() -> BlenderDiscoveryScope {
    BlenderDiscoveryScope::WindowsKnownInstallLocations
}

#[cfg(target_os = "macos")]
fn platform_discovery_scope() -> BlenderDiscoveryScope {
    BlenderDiscoveryScope::MacKnownInstallLocations
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_discovery_scope() -> BlenderDiscoveryScope {
    BlenderDiscoveryScope::UnsupportedPlatform
}

#[cfg(windows)]
fn platform_direct_discovery_hints() -> DirectDiscoveryHints {
    windows_discovery::collect_direct_hints()
}

#[cfg(target_os = "macos")]
fn platform_direct_discovery_hints() -> DirectDiscoveryHints {
    macos::collect_direct_hints()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_direct_discovery_hints() -> DirectDiscoveryHints {
    DirectDiscoveryHints::default()
}

#[cfg(windows)]
mod windows_discovery;

#[cfg(windows)]
fn root_hint_is_allowed(path: &Path) -> bool {
    use std::path::{Component, Prefix};

    path.has_root()
        && matches!(
            path.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
        )
}

#[cfg(not(windows))]
fn root_hint_is_allowed(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(windows)]
fn canonical_root_is_allowed(path: &Path) -> bool {
    use std::path::{Component, Prefix};

    path.has_root()
        && matches!(
            path.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
}

#[cfg(not(windows))]
fn canonical_root_is_allowed(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(windows)]
fn path_identity(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(unix)]
fn path_identity(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(any(unix, windows)))]
fn path_identity(path: &Path) -> Vec<u8> {
    path.to_string_lossy().as_bytes().to_vec()
}

fn installation_id(identity_key: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(INSTALLATION_ID_DOMAIN);
    hasher.update(identity_key);
    let digest = hasher.finalize();
    format!("blender-installation-v1-{digest:x}")
}

fn is_within(path: &Path, root: &Path) -> bool {
    path != root && path.starts_with(root)
}

fn candidate_location_is_allowed(
    candidate: &Path,
    root: &Path,
    vendor: &Path,
    version_directory: &Path,
) -> bool {
    is_within(candidate, root)
        && is_within(candidate, vendor)
        && candidate.parent() == Some(version_directory)
}

fn is_plain_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !is_link_or_reparse(metadata)
}

fn is_plain_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && !is_link_or_reparse(metadata)
}

fn safe_directory_name(name: &OsStr) -> Option<String> {
    let name = name.to_str()?.trim();
    let count = name.chars().count();
    if count == 0 || count > MAX_DISPLAY_NAME_CHARS || name.chars().any(char::is_control) {
        return None;
    }
    Some(name.to_string())
}

fn version_hint(display_name: &str) -> Option<String> {
    const PREFIX: &str = "Blender ";
    let prefix = display_name.get(..PREFIX.len())?;
    if !prefix.eq_ignore_ascii_case(PREFIX) {
        return None;
    }

    normalize_numeric_version_hint(display_name.get(PREFIX.len()..)?)
}

fn normalize_numeric_version_hint(value: &str) -> Option<String> {
    let value = value.trim();
    if value.chars().count() > MAX_VERSION_HINT_CHARS {
        return None;
    }

    let segments: Vec<_> = value.split('.').collect();
    if !(2..=4).contains(&segments.len())
        || segments.iter().any(|segment| {
            segment.is_empty() || !segment.chars().all(|value| value.is_ascii_digit())
        })
    {
        return None;
    }

    Some(value.to_string())
}

fn display_summary(directory_name: &OsStr) -> (String, Option<String>) {
    let Some(directory_name) = safe_directory_name(directory_name) else {
        return ("Blender candidate".to_string(), None);
    };
    let hint = version_hint(&directory_name);
    if hint.is_some() {
        (directory_name, hint)
    } else {
        ("Blender candidate".to_string(), None)
    }
}

fn is_blender_product_display_name(value: &str) -> bool {
    const PREFIX: &str = "Blender ";
    let value = value.trim();
    if value.eq_ignore_ascii_case("Blender") {
        return true;
    }
    value
        .get(..PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(PREFIX))
        && value
            .get(PREFIX.len()..)
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|value| value.is_ascii_digit())
        && value.chars().count() <= MAX_DISPLAY_NAME_CHARS
        && !value.chars().any(char::is_control)
}

fn vdf_quoted_fields(line: &str) -> Option<Vec<String>> {
    let mut fields = Vec::new();
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '"' {
            continue;
        }
        let mut field = String::new();
        let mut terminated = false;
        while let Some(value) = characters.next() {
            match value {
                '"' => {
                    terminated = true;
                    break;
                }
                '\\' => match characters.next() {
                    Some('\\') => field.push('\\'),
                    Some('"') => field.push('"'),
                    Some(next) => {
                        field.push('\\');
                        field.push(next);
                    }
                    None => return None,
                },
                value => field.push(value),
            }
        }
        if !terminated {
            return None;
        }
        fields.push(field);
    }
    Some(fields)
}

fn vdf_values(body: &str, expected_key: &str) -> Vec<String> {
    body.lines()
        .filter_map(vdf_quoted_fields)
        .filter(|fields| fields.len() >= 2 && fields[0].eq_ignore_ascii_case(expected_key))
        .map(|fields| fields[1].clone())
        .collect()
}

fn is_safe_single_path_component(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().count() <= MAX_DISPLAY_NAME_CHARS
        && !matches!(value, "." | "..")
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
}

fn read_bounded_utf8_file(path: &Path, max_bytes: u64) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !is_plain_file(&metadata) || metadata.len() > max_bytes {
        return None;
    }
    String::from_utf8(fs::read(path).ok()?).ok()
}

fn validate_pe_x64(path: &Path) -> Result<(), String> {
    const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
    let mut file = fs::File::open(path).map_err(|_| "Blender 可执行文件不可用".to_string())?;
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)
        .map_err(|_| "Blender 可执行文件格式无效".to_string())?;
    if &dos[..2] != b"MZ" {
        return Err("Blender 可执行文件格式无效".to_string());
    }
    let pe_offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if !(64..=1024 * 1024).contains(&pe_offset) {
        return Err("Blender 可执行文件格式无效".to_string());
    }
    file.seek(SeekFrom::Start(pe_offset))
        .map_err(|_| "Blender 可执行文件格式无效".to_string())?;
    let mut header = [0u8; 6];
    file.read_exact(&mut header)
        .map_err(|_| "Blender 可执行文件格式无效".to_string())?;
    if &header[..4] != b"PE\0\0"
        || u16::from_le_bytes([header[4], header[5]]) != IMAGE_FILE_MACHINE_AMD64
    {
        return Err("只支持 Windows x64 Blender".to_string());
    }
    Ok(())
}

/// `path_policy` 为前端路径语义移除了 Windows verbatim 前缀；安装记录内部则必须
/// 保留 `std::fs::canonicalize` 的稳定表示，才能在每次 Job 启动时做严格身份复核。
fn canonicalize_registered_executable(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|_| "Blender 可执行文件不可用".to_string())
}

fn manual_installation_record(path: &Path) -> Result<InstallationRecord, String> {
    #[cfg(target_os = "macos")]
    let selected_executable = macos::resolve_executable(path, std::env::consts::ARCH)?;
    #[cfg(target_os = "macos")]
    let path = selected_executable.as_path();
    if path
        .file_name()
        .and_then(OsStr::to_str)
        .is_none_or(|name| !name.eq_ignore_ascii_case(BLENDER_EXECUTABLE_NAME))
    {
        return Err("请选择当前系统的 Blender 应用".to_string());
    }
    let executable = canonicalize_registered_executable(path)?;
    validate_platform_executable(&executable)?;
    let canonical_root = executable
        .parent()
        .ok_or_else(|| "Blender 安装目录无效".to_string())?
        .to_path_buf();
    Ok(InstallationRecord {
        candidate: BlenderInstallationCandidate {
            installation_id: installation_id(&path_identity(&executable)),
            display_name: "Blender（手动选择）".to_string(),
            source: BlenderInstallationSource::UserSelected,
            version_hint: None,
            version_hint_is_verified: false,
        },
        canonical_root,
        canonical_executable: executable,
    })
}

fn persist_manual_installation(private_directory: &Path, executable: &Path) -> Result<(), String> {
    let executable_path = executable
        .to_str()
        .ok_or_else(|| "Blender 路径无法保存".to_string())?;
    let body = serde_json::to_vec(&PersistedBlenderSelection {
        schema_version: BLENDER_SELECTION_SCHEMA_VERSION,
        executable_path: executable_path.to_string(),
    })
    .map_err(|_| "Blender 设置无法保存".to_string())?;
    if body.len() as u64 > MAX_BLENDER_SELECTION_BYTES {
        return Err("Blender 路径过长，无法保存".to_string());
    }

    let target = private_directory.join(BLENDER_SELECTION_FILE);
    let temporary = private_directory.join(format!("{BLENDER_SELECTION_FILE}.tmp"));
    if temporary.exists() {
        let metadata = fs::symlink_metadata(&temporary)
            .map_err(|_| "Blender 设置临时文件不可用".to_string())?;
        if !is_plain_file(&metadata) {
            return Err("Blender 设置临时文件不安全".to_string());
        }
        fs::remove_file(&temporary).map_err(|_| "Blender 设置临时文件无法清理".to_string())?;
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "Blender 设置无法写入".to_string())?;
    if let Err(error) = file.write_all(&body).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Blender 设置无法写入: {error}"));
    }
    drop(file);

    if target.exists() {
        let metadata =
            fs::symlink_metadata(&target).map_err(|_| "Blender 设置文件不可用".to_string())?;
        if !is_plain_file(&metadata) {
            let _ = fs::remove_file(&temporary);
            return Err("Blender 设置文件不安全".to_string());
        }
        fs::remove_file(&target).map_err(|_| "Blender 设置无法更新".to_string())?;
    }
    fs::rename(&temporary, &target).map_err(|_| "Blender 设置无法提交".to_string())
}

fn restore_manual_installation(
    private_directory: &Path,
) -> Result<Option<InstallationRecord>, String> {
    let file = private_directory.join(BLENDER_SELECTION_FILE);
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("已保存的 Blender 设置不可用".to_string()),
    };
    if !is_plain_file(&metadata) || metadata.len() > MAX_BLENDER_SELECTION_BYTES {
        return Err("已保存的 Blender 设置无效".to_string());
    }
    let body = fs::read(&file).map_err(|_| "已保存的 Blender 设置无法读取".to_string())?;
    let saved: PersistedBlenderSelection = serde_json::from_slice(&body)
        .map_err(|_| "已保存的 Blender 设置已损坏，请重新选择".to_string())?;
    if saved.schema_version != BLENDER_SELECTION_SCHEMA_VERSION {
        return Err("已保存的 Blender 设置版本不受支持，请重新选择".to_string());
    }
    manual_installation_record(Path::new(&saved.executable_path))
        .map(Some)
        .map_err(|_| "已保存的 Blender 已失效，请重新选择".to_string())
}

fn validate_installation_record(record: &InstallationRecord) -> Result<PathBuf, String> {
    let root_metadata = fs::symlink_metadata(&record.canonical_root)
        .map_err(|_| "Blender 安装候选不存在或已失效".to_string())?;
    let executable_metadata = fs::symlink_metadata(&record.canonical_executable)
        .map_err(|_| "Blender 安装候选不存在或已失效".to_string())?;
    if !is_plain_directory(&root_metadata) || !is_plain_file(&executable_metadata) {
        return Err("Blender 安装候选不存在或已失效".to_string());
    }
    let root = record
        .canonical_root
        .canonicalize()
        .map_err(|_| "Blender 安装候选不存在或已失效".to_string())?;
    let executable = record
        .canonical_executable
        .canonicalize()
        .map_err(|_| "Blender 安装候选不存在或已失效".to_string())?;
    if root != record.canonical_root
        || executable != record.canonical_executable
        || !executable.starts_with(&root)
        || executable
            .file_name()
            .and_then(OsStr::to_str)
            .is_none_or(|name| !name.eq_ignore_ascii_case(BLENDER_EXECUTABLE_NAME))
        || !canonical_root_is_allowed(&root)
    {
        return Err("Blender 安装候选不存在或已失效".to_string());
    }
    validate_platform_executable(&executable)?;
    Ok(executable)
}

fn validate_platform_executable(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::resolve_executable(path, std::env::consts::ARCH).map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        validate_pe_x64(path)
    }
}

fn bounded_directory_entries(directory: &Path) -> Result<Vec<fs::DirEntry>, DirectoryEntriesError> {
    let mut entries = Vec::new();
    let directory = fs::read_dir(directory).map_err(|_| DirectoryEntriesError::Unavailable)?;
    for entry in directory {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            return Err(DirectoryEntriesError::LimitExceeded);
        }
        entries.push(entry.map_err(|_| DirectoryEntriesError::Unavailable)?);
    }
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    Ok(entries)
}

fn discover_in_root(root: DiscoveryRoot) -> RootDiscovery {
    let mut discovery = RootDiscovery::default();
    if !root_hint_is_allowed(&root.path) {
        discovery.partial = true;
        return discovery;
    }

    match fs::symlink_metadata(&root.path) {
        Ok(metadata) if is_plain_directory(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return discovery,
        _ => {
            discovery.partial = true;
            return discovery;
        }
    }

    let canonical_root = match root.path.canonicalize() {
        Ok(path) if canonical_root_is_allowed(&path) => path,
        _ => {
            discovery.partial = true;
            return discovery;
        }
    };
    let vendor_path = root.path.join(BLENDER_VENDOR_DIRECTORY);
    match fs::symlink_metadata(&vendor_path) {
        Ok(metadata) if is_plain_directory(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return discovery,
        _ => {
            discovery.partial = true;
            return discovery;
        }
    }

    let canonical_vendor = match vendor_path.canonicalize() {
        Ok(path)
            if is_within(&path, &canonical_root)
                && path.parent() == Some(canonical_root.as_path()) =>
        {
            path
        }
        _ => {
            discovery.partial = true;
            return discovery;
        }
    };
    let entries = match bounded_directory_entries(&vendor_path) {
        Ok(entries) => entries,
        Err(DirectoryEntriesError::LimitExceeded) => {
            discovery.partial = true;
            discovery.truncated = true;
            return discovery;
        }
        Err(DirectoryEntriesError::Unavailable) => {
            discovery.partial = true;
            return discovery;
        }
    };

    for entry in entries {
        let directory_metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(_) => {
                discovery.partial = true;
                continue;
            }
        };
        if !is_plain_directory(&directory_metadata) {
            continue;
        }

        let canonical_version_directory = match entry.path().canonicalize() {
            Ok(path) if path.parent() == Some(canonical_vendor.as_path()) => path,
            _ => {
                discovery.partial = true;
                continue;
            }
        };

        let candidate_path = entry.path().join(BLENDER_EXECUTABLE_NAME);
        let candidate_metadata = match fs::symlink_metadata(&candidate_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                discovery.partial = true;
                continue;
            }
        };
        if !is_plain_file(&candidate_metadata) {
            continue;
        }

        let canonical_candidate = match candidate_path.canonicalize() {
            Ok(path) => path,
            Err(_) => {
                discovery.partial = true;
                continue;
            }
        };
        if !candidate_location_is_allowed(
            &canonical_candidate,
            &canonical_root,
            &canonical_vendor,
            &canonical_version_directory,
        ) {
            continue;
        }

        let identity_key = path_identity(&canonical_candidate);
        let (display_name, version_hint) = display_summary(&entry.file_name());
        discovery.installations.push(DiscoveredInstallation {
            candidate: BlenderInstallationCandidate {
                installation_id: installation_id(&identity_key),
                display_name,
                source: root.source,
                version_hint,
                version_hint_is_verified: false,
            },
            canonical_root: canonical_root.clone(),
            canonical_executable: canonical_candidate,
            identity_key,
        });
    }
    discovery
}

fn discover_direct_hint(hint: DirectDiscoveryHint) -> Option<DiscoveredInstallation> {
    if !root_hint_is_allowed(&hint.executable_path)
        || hint
            .executable_path
            .file_name()
            .and_then(OsStr::to_str)
            .is_none_or(|name| !name.eq_ignore_ascii_case(BLENDER_EXECUTABLE_NAME))
    {
        return None;
    }
    let root_path = hint.executable_path.parent()?;
    let root_metadata = fs::symlink_metadata(root_path).ok()?;
    let executable_metadata = fs::symlink_metadata(&hint.executable_path).ok()?;
    if !is_plain_directory(&root_metadata) || !is_plain_file(&executable_metadata) {
        return None;
    }
    let canonical_root = root_path.canonicalize().ok()?;
    let canonical_executable = hint.executable_path.canonicalize().ok()?;
    if !canonical_root_is_allowed(&canonical_root)
        || canonical_executable.parent() != Some(canonical_root.as_path())
        || validate_platform_executable(&canonical_executable).is_err()
    {
        return None;
    }

    let identity_key = path_identity(&canonical_executable);
    let display_name = safe_directory_name(OsStr::new(&hint.display_name))
        .unwrap_or_else(|| "Blender candidate".to_string());
    let version_hint = hint
        .version_hint
        .as_deref()
        .and_then(normalize_numeric_version_hint)
        .or_else(|| version_hint(&display_name));
    Some(DiscoveredInstallation {
        candidate: BlenderInstallationCandidate {
            installation_id: installation_id(&identity_key),
            display_name,
            source: hint.source,
            version_hint,
            version_hint_is_verified: false,
        },
        canonical_root,
        canonical_executable,
        identity_key,
    })
}

fn finalize_discovery_snapshot(mut snapshot: DiscoverySnapshot) -> DiscoverySnapshot {
    snapshot.installations.sort_by(|left, right| {
        left.candidate
            .display_name
            .to_lowercase()
            .cmp(&right.candidate.display_name.to_lowercase())
            .then(left.candidate.source.cmp(&right.candidate.source))
            .then(
                left.candidate
                    .installation_id
                    .cmp(&right.candidate.installation_id),
            )
    });
    if snapshot.installations.len() > MAX_RETURNED_CANDIDATES {
        snapshot.truncated = true;
        snapshot.installations.truncate(MAX_RETURNED_CANDIDATES);
    }
    snapshot
}

fn scan_from_roots(roots: Vec<DiscoveryRoot>) -> DiscoverySnapshot {
    let mut snapshot = DiscoverySnapshot {
        truncated: roots.len() > MAX_DISCOVERY_ROOTS,
        ..DiscoverySnapshot::default()
    };
    let mut unique = BTreeMap::new();
    for root in roots.into_iter().take(MAX_DISCOVERY_ROOTS) {
        let root_discovery = discover_in_root(root);
        snapshot.partial |= root_discovery.partial;
        snapshot.truncated |= root_discovery.truncated;
        for installation in root_discovery.installations {
            unique
                .entry(installation.identity_key.clone())
                .or_insert(installation);
        }
    }

    snapshot.installations = unique.into_values().collect();
    finalize_discovery_snapshot(snapshot)
}

fn merge_direct_hints(
    mut snapshot: DiscoverySnapshot,
    direct: DirectDiscoveryHints,
) -> DiscoverySnapshot {
    snapshot.partial |= direct.partial;
    snapshot.truncated |= direct.truncated || direct.hints.len() > MAX_DIRECT_DISCOVERY_HINTS;
    let mut unique: BTreeMap<Vec<u8>, DiscoveredInstallation> = snapshot
        .installations
        .into_iter()
        .map(|installation| (installation.identity_key.clone(), installation))
        .collect();
    for hint in direct.hints.into_iter().take(MAX_DIRECT_DISCOVERY_HINTS) {
        if let Some(installation) = discover_direct_hint(hint) {
            unique
                .entry(installation.identity_key.clone())
                .or_insert(installation);
        }
    }
    snapshot.installations = unique.into_values().collect();
    finalize_discovery_snapshot(snapshot)
}

#[cfg(test)]
fn discover_from_roots(roots: Vec<DiscoveryRoot>) -> Vec<DiscoveredInstallation> {
    scan_from_roots(roots).installations
}

fn public_discovery_result(
    snapshot: DiscoverySnapshot,
    scope: BlenderDiscoveryScope,
    selected_candidate: Option<BlenderInstallationCandidate>,
) -> BlenderDiscoveryResult {
    let mut candidates: Vec<_> = snapshot
        .installations
        .into_iter()
        .map(|installation| installation.candidate)
        .collect();
    if let Some(candidate) = selected_candidate {
        candidates.retain(|current| current.installation_id != candidate.installation_id);
        candidates.insert(0, candidate);
    }
    BlenderDiscoveryResult {
        candidates,
        supports_saved_scene: true,
        scope,
        exhaustive: false,
        partial: snapshot.partial,
        truncated: snapshot.truncated,
    }
}

#[tauri::command]
pub fn discover_blender_installations(
    webview: Webview,
    state: State<'_, BlenderRuntimeState>,
) -> Result<BlenderDiscoveryResult, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window_label(webview.label())?;

    let mut snapshot = merge_direct_hints(
        scan_from_roots(platform_discovery_roots()),
        platform_direct_discovery_hints(),
    );
    state.replace_installations(&snapshot.installations)?;
    let private_directory = prepare_blender_private_runtime(webview.app_handle())?;
    // 安装迁移、应用包重命名或旧记录损坏不能阻断其余安装的发现及重新选择。
    let selected = match restore_manual_installation(&private_directory) {
        Ok(selected) => selected,
        Err(_) => {
            snapshot.partial = true;
            None
        }
    };
    let selected_candidate = selected
        .map(|record| state.register_manual(record))
        .transpose()?;
    Ok(public_discovery_result(
        snapshot,
        platform_discovery_scope(),
        selected_candidate,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterBlenderInstallationRequest {
    executable_path: String,
}

#[tauri::command]
pub fn register_blender_installation(
    webview: Webview,
    state: State<'_, BlenderRuntimeState>,
    request: RegisterBlenderInstallationRequest,
) -> Result<BlenderInstallationCandidate, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window_label(webview.label())?;
    #[cfg(not(target_os = "macos"))]
    let executable = crate::path_policy::authorize_existing_plain_file(
        webview.app_handle(),
        &request.executable_path,
    )?;
    // .app 在系统选择器中是文件项，原生文件系统中是目录；仅授权被选中的包根，
    // 固定的 Contents/MacOS/Blender 由原生解析，不递归扩大通用文件权限。
    #[cfg(target_os = "macos")]
    let executable = crate::path_policy::authorize_existing_plain_directory(
        webview.app_handle(),
        &request.executable_path,
    )?;
    let record = manual_installation_record(&executable)?;
    let private_directory = prepare_blender_private_runtime(webview.app_handle())?;
    persist_manual_installation(&private_directory, &record.canonical_executable)?;
    state.register_manual(record)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlenderJobIdRequest {
    job_id: String,
}

#[tauri::command]
pub fn start_blender_job(
    webview: Webview,
    runtime_state: State<'_, BlenderRuntimeState>,
    project_grants: State<'_, ProjectGrantState>,
    jobs: State<'_, BlenderJobCore>,
    request: BlenderJobStartRequest,
) -> Result<BlenderJobStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window_label(webview.label())?;
    let installation = runtime_state.resolve_installation(&request.installation_id)?;
    let executable = validate_installation_record(&installation)?;
    let private_root = prepare_blender_private_runtime(webview.app_handle())?;
    let resources = resources::install_embedded_blender_runtime(&private_root)
        .map_err(|error| error.to_string())?;
    let project_id = request.project_id.clone();
    let project_grant_id = request.project_grant_id.clone();
    let expected_context = request.expected_context.clone();
    project_grants.with_revalidated_project_root(
        webview.app_handle(),
        &project_id,
        &project_grant_id,
        expected_context.as_ref(),
        |project_root| {
            jobs.start(
                request,
                job::BlenderJobTrustedContext {
                    executable,
                    project_root: project_root.to_path_buf(),
                    private_root,
                    resources,
                },
            )
            .map_err(|error| error.public_message().to_string())
        },
    )
}

#[tauri::command]
pub fn get_blender_job_status(
    webview: Webview,
    jobs: State<'_, BlenderJobCore>,
    request: BlenderJobIdRequest,
) -> Result<BlenderJobStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window_label(webview.label())?;
    jobs.get_status(&request.job_id)
        .map_err(|error| error.public_message().to_string())
}

#[tauri::command]
pub fn cancel_blender_job(
    webview: Webview,
    jobs: State<'_, BlenderJobCore>,
    request: BlenderJobIdRequest,
) -> Result<BlenderJobStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window_label(webview.label())?;
    jobs.cancel(&request.job_id)
        .map_err(|error| error.public_message().to_string())
}

#[tauri::command]
pub fn collect_blender_job_result(
    webview: Webview,
    jobs: State<'_, BlenderJobCore>,
    request: BlenderJobIdRequest,
) -> Result<BlenderCollectedResult, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_window_label(webview.label())?;
    jobs.collect(&request.job_id)
        .map_err(|error| error.public_message().to_string())
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
