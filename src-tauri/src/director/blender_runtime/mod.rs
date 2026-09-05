//! Blender 原生运行时的受限安装候选发现。
//!
//! Windows 端只读取固定的应用注册位置、PATH、Steam 元数据和 Program Files 标准层级；
//! 不执行候选、不扫描整块磁盘，也不向前端暴露绝对路径。

mod job;
pub mod project_grant;
mod resources;
mod result;
mod runner;

pub use job::{BlenderJobCore, BlenderJobStartRequest, BlenderJobStatus};
pub use project_grant::ProjectGrantState;
pub use result::BlenderCollectedResult;

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
const BLENDER_EXECUTABLE_NAME: &str = "blender.exe";
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
    #[cfg(not(windows))]
    UnsupportedPlatform,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderDiscoveryResult {
    candidates: Vec<BlenderInstallationCandidate>,
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

#[cfg(not(windows))]
fn platform_discovery_scope() -> BlenderDiscoveryScope {
    BlenderDiscoveryScope::UnsupportedPlatform
}

#[cfg(windows)]
fn platform_direct_discovery_hints() -> DirectDiscoveryHints {
    windows_discovery::collect_direct_hints()
}

#[cfg(not(windows))]
fn platform_direct_discovery_hints() -> DirectDiscoveryHints {
    DirectDiscoveryHints::default()
}

#[cfg(windows)]
mod windows_discovery {
    use super::*;
    use std::{
        ffi::{OsStr, OsString},
        os::windows::ffi::{OsStrExt, OsStringExt},
    };
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{
                ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS,
            },
            System::Registry::{
                RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
                HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SAM_FLAGS,
                RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RRF_ZEROONFAILURE,
            },
        },
    };

    const APP_PATHS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths\blender.exe";
    const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const STEAM_KEY: &str = r"Software\Valve\Steam";
    const MAX_REGISTRY_VALUE_BYTES: u32 = 32 * 1024;
    const MAX_UNINSTALL_SUBKEYS: u32 = 4096;
    const MAX_REGISTRY_SUBKEY_CHARS: usize = 256;

    #[derive(Clone, Copy)]
    struct RegistryLocation {
        hive: HKEY,
        view: REG_SAM_FLAGS,
    }

    struct OwnedRegistryKey(HKEY);

    impl Drop for OwnedRegistryKey {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    fn registry_locations() -> [RegistryLocation; 4] {
        [
            RegistryLocation {
                hive: HKEY_CURRENT_USER,
                view: KEY_WOW64_64KEY,
            },
            RegistryLocation {
                hive: HKEY_CURRENT_USER,
                view: KEY_WOW64_32KEY,
            },
            RegistryLocation {
                hive: HKEY_LOCAL_MACHINE,
                view: KEY_WOW64_64KEY,
            },
            RegistryLocation {
                hive: HKEY_LOCAL_MACHINE,
                view: KEY_WOW64_32KEY,
            },
        ]
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn open_key(location: RegistryLocation, subkey: &str) -> Result<Option<OwnedRegistryKey>, ()> {
        let subkey = wide_null(OsStr::new(subkey));
        let mut opened = HKEY(std::ptr::null_mut());
        let status = unsafe {
            RegOpenKeyExW(
                location.hive,
                PCWSTR(subkey.as_ptr()),
                0,
                KEY_READ | location.view,
                &mut opened,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(Some(OwnedRegistryKey(opened)))
        } else if status == ERROR_FILE_NOT_FOUND {
            Ok(None)
        } else {
            Err(())
        }
    }

    fn query_string(
        key: &OwnedRegistryKey,
        subkey: Option<&str>,
        value_name: Option<&str>,
    ) -> Result<Option<OsString>, ()> {
        let subkey_wide = subkey.map(|value| wide_null(OsStr::new(value)));
        let value_wide = value_name.map(|value| wide_null(OsStr::new(value)));
        let subkey_pointer = subkey_wide
            .as_ref()
            .map_or(PCWSTR(std::ptr::null()), |value| PCWSTR(value.as_ptr()));
        let value_pointer = value_wide
            .as_ref()
            .map_or(PCWSTR(std::ptr::null()), |value| PCWSTR(value.as_ptr()));
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_ZEROONFAILURE;
        let mut byte_count = 0u32;
        let first_status = unsafe {
            RegGetValueW(
                key.0,
                subkey_pointer,
                value_pointer,
                flags,
                None,
                None,
                Some(&mut byte_count),
            )
        };
        if first_status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if first_status != ERROR_SUCCESS
            || byte_count == 0
            || byte_count > MAX_REGISTRY_VALUE_BYTES
            || byte_count % 2 != 0
        {
            return Err(());
        }

        let mut buffer = vec![0u16; (byte_count / 2) as usize];
        let second_status = unsafe {
            RegGetValueW(
                key.0,
                subkey_pointer,
                value_pointer,
                flags,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut byte_count),
            )
        };
        if second_status != ERROR_SUCCESS || byte_count % 2 != 0 {
            return Err(());
        }
        let written = (byte_count / 2) as usize;
        if written > buffer.len() {
            return Err(());
        }
        buffer.truncate(written);
        while buffer.last() == Some(&0) {
            buffer.pop();
        }
        if buffer.is_empty() {
            return Ok(None);
        }
        Ok(Some(OsString::from_wide(&buffer)))
    }

    fn enumerate_subkeys(key: &OwnedRegistryKey) -> (Vec<String>, bool, bool) {
        let mut names = Vec::new();
        let mut partial = false;
        let mut truncated = false;
        for index in 0..MAX_UNINSTALL_SUBKEYS {
            let mut buffer = [0u16; MAX_REGISTRY_SUBKEY_CHARS];
            let mut length = (buffer.len() - 1) as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    key.0,
                    index,
                    PWSTR(buffer.as_mut_ptr()),
                    &mut length,
                    None,
                    PWSTR(std::ptr::null_mut()),
                    None,
                    None,
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                return (names, partial, truncated);
            }
            if status == ERROR_MORE_DATA {
                partial = true;
                continue;
            }
            if status != ERROR_SUCCESS {
                partial = true;
                return (names, partial, truncated);
            }
            let Ok(name) = String::from_utf16(&buffer[..length as usize]) else {
                partial = true;
                continue;
            };
            names.push(name);
        }
        truncated = true;
        (names, partial, truncated)
    }

    fn push_hint(result: &mut DirectDiscoveryHints, hint: DirectDiscoveryHint) {
        if result.hints.len() >= MAX_DIRECT_DISCOVERY_HINTS {
            result.truncated = true;
            return;
        }
        result.hints.push(hint);
    }

    fn collect_app_paths(result: &mut DirectDiscoveryHints) {
        for location in registry_locations() {
            let key = match open_key(location, APP_PATHS_KEY) {
                Ok(Some(key)) => key,
                Ok(None) => continue,
                Err(()) => {
                    result.partial = true;
                    continue;
                }
            };
            match query_string(&key, None, None) {
                Ok(Some(path)) => push_hint(
                    result,
                    DirectDiscoveryHint {
                        source: BlenderInstallationSource::WindowsAppPaths,
                        executable_path: PathBuf::from(path),
                        display_name: "Blender（Windows 应用注册）".to_string(),
                        version_hint: None,
                    },
                ),
                Ok(None) => {}
                Err(()) => result.partial = true,
            }
        }
    }

    fn collect_uninstall_entries(result: &mut DirectDiscoveryHints) {
        for location in registry_locations() {
            let key = match open_key(location, UNINSTALL_KEY) {
                Ok(Some(key)) => key,
                Ok(None) => continue,
                Err(()) => {
                    result.partial = true;
                    continue;
                }
            };
            let (subkeys, partial, truncated) = enumerate_subkeys(&key);
            result.partial |= partial;
            result.truncated |= truncated;
            for subkey in subkeys {
                let display_name = match query_string(&key, Some(&subkey), Some("DisplayName")) {
                    Ok(Some(value)) => match value.into_string() {
                        Ok(value) if is_blender_product_display_name(&value) => value,
                        _ => continue,
                    },
                    Ok(None) => continue,
                    Err(()) => {
                        result.partial = true;
                        continue;
                    }
                };
                let install_location =
                    match query_string(&key, Some(&subkey), Some("InstallLocation")) {
                        Ok(Some(value)) => value,
                        Ok(None) => continue,
                        Err(()) => {
                            result.partial = true;
                            continue;
                        }
                    };
                let version_hint = query_string(&key, Some(&subkey), Some("DisplayVersion"))
                    .ok()
                    .flatten()
                    .and_then(|value| value.into_string().ok())
                    .and_then(|value| normalize_numeric_version_hint(&value));
                push_hint(
                    result,
                    DirectDiscoveryHint {
                        source: BlenderInstallationSource::WindowsUninstall,
                        executable_path: PathBuf::from(install_location)
                            .join(BLENDER_EXECUTABLE_NAME),
                        display_name,
                        version_hint,
                    },
                );
            }
        }
    }

    fn collect_path_entries(result: &mut DirectDiscoveryHints) {
        let Some(path) = std::env::var_os("PATH") else {
            return;
        };
        let mut paths = std::env::split_paths(&path);
        for directory in paths.by_ref().take(MAX_PATH_ENTRIES) {
            push_hint(
                result,
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::EnvironmentPath,
                    executable_path: directory.join(BLENDER_EXECUTABLE_NAME),
                    display_name: "Blender（PATH）".to_string(),
                    version_hint: None,
                },
            );
        }
        if paths.next().is_some() {
            result.truncated = true;
        }
    }

    fn collect_steam_roots(result: &mut DirectDiscoveryHints) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        for location in registry_locations() {
            let key = match open_key(location, STEAM_KEY) {
                Ok(Some(key)) => key,
                Ok(None) => continue,
                Err(()) => {
                    result.partial = true;
                    continue;
                }
            };
            for value_name in ["InstallPath", "SteamPath"] {
                match query_string(&key, None, Some(value_name)) {
                    Ok(Some(path)) => roots.push(PathBuf::from(path)),
                    Ok(None) => {}
                    Err(()) => result.partial = true,
                }
            }
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            roots.push(PathBuf::from(program_files_x86).join("Steam"));
        }
        roots.sort_by_key(|path| path.to_string_lossy().to_lowercase());
        roots.dedup_by(|left, right| left.as_os_str().eq_ignore_ascii_case(right.as_os_str()));
        roots
    }

    fn collect_steam_entries(result: &mut DirectDiscoveryHints) {
        let steam_roots = collect_steam_roots(result);
        for steam_root in steam_roots {
            let mut library_roots = vec![steam_root.clone()];
            let library_file = steam_root.join("steamapps").join("libraryfolders.vdf");
            if let Some(body) = read_bounded_utf8_file(&library_file, MAX_STEAM_METADATA_BYTES) {
                for value in vdf_values(&body, "path") {
                    if library_roots.len() >= MAX_STEAM_LIBRARY_ROOTS {
                        result.truncated = true;
                        break;
                    }
                    library_roots.push(PathBuf::from(value));
                }
            }
            library_roots.sort_by_key(|path| path.to_string_lossy().to_lowercase());
            library_roots
                .dedup_by(|left, right| left.as_os_str().eq_ignore_ascii_case(right.as_os_str()));

            for library_root in library_roots {
                let steamapps = library_root.join("steamapps");
                let manifest = steamapps.join(format!("appmanifest_{STEAM_BLENDER_APP_ID}.acf"));
                let Some(body) = read_bounded_utf8_file(&manifest, MAX_STEAM_METADATA_BYTES) else {
                    continue;
                };
                if vdf_values(&body, "appid")
                    .first()
                    .is_none_or(|value| value != STEAM_BLENDER_APP_ID)
                {
                    continue;
                }
                let Some(install_directory) = vdf_values(&body, "installdir")
                    .into_iter()
                    .next()
                    .filter(|value| is_safe_single_path_component(value))
                else {
                    result.partial = true;
                    continue;
                };
                push_hint(
                    result,
                    DirectDiscoveryHint {
                        source: BlenderInstallationSource::Steam,
                        executable_path: steamapps
                            .join("common")
                            .join(install_directory)
                            .join(BLENDER_EXECUTABLE_NAME),
                        display_name: "Blender（Steam）".to_string(),
                        version_hint: None,
                    },
                );
            }
        }
    }

    pub(super) fn collect_direct_hints() -> DirectDiscoveryHints {
        let mut result = DirectDiscoveryHints::default();
        collect_app_paths(&mut result);
        collect_uninstall_entries(&mut result);
        collect_path_entries(&mut result);
        collect_steam_entries(&mut result);
        result
    }
}

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

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_type().is_symlink() || has_windows_reparse_attribute(metadata.file_attributes())
}

#[cfg(windows)]
fn has_windows_reparse_attribute(attributes: u32) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
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
    if path
        .file_name()
        .and_then(OsStr::to_str)
        .is_none_or(|name| !name.eq_ignore_ascii_case(BLENDER_EXECUTABLE_NAME))
    {
        return Err("请选择 blender.exe".to_string());
    }
    let executable = canonicalize_registered_executable(path)?;
    validate_pe_x64(&executable)?;
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
    validate_pe_x64(&executable)?;
    Ok(executable)
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
        || validate_pe_x64(&canonical_executable).is_err()
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

    let snapshot = merge_direct_hints(
        scan_from_roots(platform_discovery_roots()),
        platform_direct_discovery_hints(),
    );
    state.replace_installations(&snapshot.installations)?;
    let private_directory = prepare_blender_private_runtime(webview.app_handle())?;
    let selected_candidate = restore_manual_installation(&private_directory)?
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
    let executable = crate::path_policy::authorize_existing_plain_file(
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
    project_grants.with_revalidated_project_root(
        webview.app_handle(),
        &project_id,
        &project_grant_id,
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
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("系统时间应晚于 Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "ai-canvas-blender-runtime-{name}-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("应能创建测试目录");
            Self { path }
        }

        fn discovery_root(&self, source: BlenderInstallationSource) -> DiscoveryRoot {
            DiscoveryRoot {
                source,
                path: self.path.clone(),
            }
        }

        fn create_candidate(&self, directory_name: &str) -> PathBuf {
            let directory = self
                .path
                .join(BLENDER_VENDOR_DIRECTORY)
                .join(directory_name);
            fs::create_dir_all(&directory).expect("应能创建候选目录");
            let executable = directory.join(BLENDER_EXECUTABLE_NAME);
            fs::write(&executable, b"test-only placeholder").expect("应能创建候选文件");
            executable
        }

        fn create_manual_x64_candidate(&self) -> PathBuf {
            let directory = self
                .path
                .join("Program Files (x86)")
                .join("Steam")
                .join("steamapps")
                .join("common")
                .join("Blender");
            fs::create_dir_all(&directory).expect("应能创建手选候选目录");
            let executable = directory.join(BLENDER_EXECUTABLE_NAME);
            let mut bytes = vec![0u8; 126];
            bytes[0..2].copy_from_slice(b"MZ");
            bytes[60..64].copy_from_slice(&120u32.to_le_bytes());
            bytes[120..124].copy_from_slice(b"PE\0\0");
            bytes[124..126].copy_from_slice(&0x8664u16.to_le_bytes());
            fs::write(&executable, bytes).expect("应能创建最小 x64 PE 候选");
            executable
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn discovers_only_fixed_standard_level_without_exposing_paths() {
        let root = TestDirectory::new("fixed-level");
        root.create_candidate("Blender 4.5");

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles64)
        ]);

        assert_eq!(installations.len(), 1);
        let candidate = &installations[0].candidate;
        assert_eq!(candidate.display_name, "Blender 4.5");
        assert_eq!(candidate.version_hint.as_deref(), Some("4.5"));
        assert!(!candidate.version_hint_is_verified);

        let serialized = serde_json::to_string(candidate).expect("候选应可序列化");
        assert!(!serialized.contains(&root.path.to_string_lossy().to_string()));
        assert!(!serialized.contains(BLENDER_EXECUTABLE_NAME));
        assert!(serialized.contains("\"source\":\"program-files-64\""));
    }

    #[test]
    fn ignores_wrong_filename_overdeep_and_non_file_candidates() {
        let root = TestDirectory::new("invalid-shapes");
        let vendor = root.path.join(BLENDER_VENDOR_DIRECTORY);
        let wrong_name = vendor.join("Blender 4.1");
        fs::create_dir_all(&wrong_name).expect("应能创建错误文件名目录");
        fs::write(wrong_name.join("blender.bin"), b"not blender.exe").expect("应能创建错误文件名");

        let overdeep = vendor.join("Blender 4.2").join("extra");
        fs::create_dir_all(&overdeep).expect("应能创建过深目录");
        fs::write(overdeep.join(BLENDER_EXECUTABLE_NAME), b"too deep").expect("应能创建过深候选");

        let directory_candidate = vendor.join("Blender 4.3").join(BLENDER_EXECUTABLE_NAME);
        fs::create_dir_all(&directory_candidate).expect("应能创建同名目录");

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(installations.is_empty());
    }

    #[test]
    fn deduplicates_roots_and_keeps_stable_opaque_id() {
        let root = TestDirectory::new("deduplicate");
        root.create_candidate("Blender 4.4");
        let roots = vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles64),
            root.discovery_root(BlenderInstallationSource::ProgramFiles),
        ];

        let first = discover_from_roots(roots.clone());
        let second = discover_from_roots(roots);

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].candidate, second[0].candidate);
        assert_eq!(
            first[0].candidate.source,
            BlenderInstallationSource::ProgramFiles64
        );
        assert!(first[0]
            .candidate
            .installation_id
            .starts_with("blender-installation-v1-"));
        assert!(!first[0]
            .candidate
            .installation_id
            .contains(&root.path.to_string_lossy().to_string()));
    }

    #[test]
    fn returns_stably_sorted_bounded_candidates() {
        let root = TestDirectory::new("candidate-limit");
        for index in 0..(MAX_RETURNED_CANDIDATES + 4) {
            root.create_candidate(&format!("Blender 4.{index:02}"));
        }

        let first_snapshot = scan_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(first_snapshot.truncated);
        let first = first_snapshot.installations;
        let second = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);

        assert_eq!(first.len(), MAX_RETURNED_CANDIDATES);
        assert_eq!(
            first
                .iter()
                .map(|installation| &installation.candidate)
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|installation| &installation.candidate)
                .collect::<Vec<_>>()
        );
        assert!(first.windows(2).all(|pair| {
            pair[0].candidate.display_name.to_lowercase()
                <= pair[1].candidate.display_name.to_lowercase()
        }));
    }

    #[test]
    fn candidate_limit_boundary_is_exact() {
        let accepted_root = TestDirectory::new("candidate-limit-accepted");
        for index in 0..MAX_RETURNED_CANDIDATES {
            accepted_root.create_candidate(&format!("Blender 4.{index:02}"));
        }
        let accepted = scan_from_roots(vec![
            accepted_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert_eq!(accepted.installations.len(), MAX_RETURNED_CANDIDATES);
        assert!(!accepted.truncated);

        let truncated_root = TestDirectory::new("candidate-limit-truncated");
        for index in 0..=MAX_RETURNED_CANDIDATES {
            truncated_root.create_candidate(&format!("Blender 4.{index:02}"));
        }
        let truncated = scan_from_roots(vec![
            truncated_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert_eq!(truncated.installations.len(), MAX_RETURNED_CANDIDATES);
        assert!(truncated.truncated);
    }

    #[test]
    fn accepts_entry_limit_and_rejects_the_next_entry_deterministically() {
        let accepted_root = TestDirectory::new("entry-limit-accepted");
        accepted_root.create_candidate("Blender 4.5");
        let accepted_vendor = accepted_root.path.join(BLENDER_VENDOR_DIRECTORY);
        for index in 0..(MAX_DIRECTORY_ENTRIES - 1) {
            fs::create_dir_all(accepted_vendor.join(format!("entry-{index:03}")))
                .expect("应能创建边界测试目录");
        }
        let accepted = scan_from_roots(vec![
            accepted_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert_eq!(accepted.installations.len(), 1);
        assert!(!accepted.partial);
        assert!(!accepted.truncated);

        let rejected_root = TestDirectory::new("entry-limit-rejected");
        let rejected_vendor = rejected_root.path.join(BLENDER_VENDOR_DIRECTORY);
        for index in 0..=MAX_DIRECTORY_ENTRIES {
            fs::create_dir_all(rejected_vendor.join(format!("entry-{index:03}")))
                .expect("应能创建限额测试目录");
        }

        let rejected = scan_from_roots(vec![
            rejected_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(rejected.installations.is_empty());
        assert!(rejected.partial);
        assert!(rejected.truncated);
    }

    #[test]
    fn limits_number_of_scanned_roots() {
        let roots: Vec<_> = (0..(MAX_DISCOVERY_ROOTS + 1))
            .map(|index| {
                let root = TestDirectory::new(&format!("root-limit-{index}"));
                root.create_candidate(&format!("Blender 4.{index}"));
                root
            })
            .collect();
        let discovery_roots = roots
            .iter()
            .map(|root| root.discovery_root(BlenderInstallationSource::ProgramFiles))
            .collect();

        let snapshot = scan_from_roots(discovery_roots);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.installations.len(), MAX_DISCOVERY_ROOTS);
        assert!(snapshot
            .installations
            .iter()
            .all(|installation| installation.candidate.display_name != "Blender 4.3"));
    }

    #[test]
    fn treats_directory_version_as_non_verified_hint_only() {
        let root = TestDirectory::new("version-hint");
        root.create_candidate("Blender 4.2");
        root.create_candidate("Blender nightly");

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        let verified_shape = installations
            .iter()
            .find(|installation| installation.candidate.display_name == "Blender 4.2")
            .expect("应发现规范目录名");
        assert_eq!(
            verified_shape.candidate.version_hint.as_deref(),
            Some("4.2")
        );
        assert!(!verified_shape.candidate.version_hint_is_verified);
        assert!(installations.iter().any(|installation| {
            installation.candidate.display_name == "Blender candidate"
                && installation.candidate.version_hint.is_none()
        }));
    }

    #[test]
    fn accepts_blender_products_but_rejects_similarly_named_plugins() {
        assert!(is_blender_product_display_name("Blender"));
        assert!(is_blender_product_display_name("Blender 5.2"));
        assert!(is_blender_product_display_name("blender 4.5 LTS"));
        assert!(!is_blender_product_display_name(
            "Blender Pipeline Plug-in v2.2 for Character Creator 4"
        ));
        assert!(!is_blender_product_display_name("Blender Launcher"));
    }

    #[test]
    fn parses_bounded_steam_vdf_fields_without_accepting_path_escape() {
        let body = r#"
"libraryfolders"
{
    "0"
    {
        "path"      "F:\\Program Files (x86)\\Steam"
        "apps"
        {
            "365670"    "944579836"
        }
    }
}
"appid"        "365670"
"installdir"   "Blender"
"#;
        assert_eq!(
            vdf_values(body, "path"),
            vec![r"F:\Program Files (x86)\Steam"]
        );
        assert_eq!(vdf_values(body, "appid"), vec![STEAM_BLENDER_APP_ID]);
        assert_eq!(vdf_values(body, "installdir"), vec!["Blender"]);
        assert!(is_safe_single_path_component("Blender"));
        assert!(!is_safe_single_path_component("../Blender"));
        assert!(!is_safe_single_path_component(r"..\Blender"));
        assert!(!is_safe_single_path_component(r"C:\Blender"));
    }

    #[cfg(windows)]
    #[test]
    fn discovers_and_deduplicates_direct_registered_candidate() {
        let root = TestDirectory::new("direct-registered");
        let executable = root.create_manual_x64_candidate();
        let direct = DirectDiscoveryHints {
            hints: vec![
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::WindowsUninstall,
                    executable_path: executable.clone(),
                    display_name: "Blender 5.2".to_string(),
                    version_hint: Some("5.2.1".to_string()),
                },
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::Steam,
                    executable_path: executable,
                    display_name: "Blender（Steam）".to_string(),
                    version_hint: None,
                },
            ],
            ..DirectDiscoveryHints::default()
        };

        let snapshot = merge_direct_hints(DiscoverySnapshot::default(), direct);
        assert_eq!(snapshot.installations.len(), 1);
        let candidate = &snapshot.installations[0].candidate;
        assert_eq!(
            candidate.source,
            BlenderInstallationSource::WindowsUninstall
        );
        assert_eq!(candidate.display_name, "Blender 5.2");
        assert_eq!(candidate.version_hint.as_deref(), Some("5.2.1"));
        let serialized = serde_json::to_string(candidate).expect("候选应可序列化");
        assert!(!serialized.contains(&root.path.to_string_lossy().to_string()));
        assert!(!serialized.contains(BLENDER_EXECUTABLE_NAME));
    }

    #[cfg(windows)]
    #[test]
    fn platform_direct_discovery_returns_only_revalidated_opaque_candidates() {
        let snapshot = merge_direct_hints(
            DiscoverySnapshot::default(),
            platform_direct_discovery_hints(),
        );
        for installation in &snapshot.installations {
            assert_eq!(
                validate_installation_record(&InstallationRecord {
                    candidate: installation.candidate.clone(),
                    canonical_root: installation.canonical_root.clone(),
                    canonical_executable: installation.canonical_executable.clone(),
                })
                .expect("平台自动发现的候选必须通过启动前复核"),
                installation.canonical_executable
            );
        }
        let public_candidates: Vec<_> = snapshot
            .installations
            .iter()
            .map(|installation| &installation.candidate)
            .collect();
        println!(
            "platform_blender_candidates={}",
            serde_json::to_string(&public_candidates).expect("公开候选应可序列化")
        );
    }

    #[test]
    fn rejects_symbolic_link_escape_when_supported() {
        let root = TestDirectory::new("link-root");
        let outside = TestDirectory::new("link-outside");
        let outside_directory = outside.path.join("Blender 4.6");
        fs::create_dir_all(&outside_directory).expect("应能创建外部目录");
        fs::write(outside_directory.join(BLENDER_EXECUTABLE_NAME), b"outside")
            .expect("应能创建外部候选");

        let vendor = root.path.join(BLENDER_VENDOR_DIRECTORY);
        fs::create_dir_all(&vendor).expect("应能创建供应商目录");
        let link = vendor.join("Blender 4.6");

        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside_directory, &link);
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_dir(&outside_directory, &link);
        if link_result.is_err() {
            return;
        }

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(installations.is_empty());
    }

    #[test]
    fn rejects_canonical_target_outside_allowed_root_without_symlink_privileges() {
        let root = TestDirectory::new("canonical-root");
        let outside = TestDirectory::new("canonical-outside");
        let vendor = root.path.join(BLENDER_VENDOR_DIRECTORY);
        let version_directory = vendor.join("Blender 4.6");
        fs::create_dir_all(&version_directory).expect("应能创建版本目录");
        let outside_candidate = outside.path.join(BLENDER_EXECUTABLE_NAME);
        fs::write(&outside_candidate, b"outside").expect("应能创建外部候选");

        let canonical_root = root.path.canonicalize().expect("根目录应可解析");
        let canonical_vendor = vendor.canonicalize().expect("供应商目录应可解析");
        let canonical_version = version_directory.canonicalize().expect("版本目录应可解析");
        let canonical_outside = outside_candidate.canonicalize().expect("外部候选应可解析");

        assert!(!candidate_location_is_allowed(
            &canonical_outside,
            &canonical_root,
            &canonical_vendor,
            &canonical_version,
        ));
    }

    #[test]
    fn discovery_replaces_process_local_records() {
        let root = TestDirectory::new("state");
        root.create_candidate("Blender 4.5");
        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        let state = BlenderRuntimeState::default();

        state
            .replace_installations(&installations)
            .expect("应能保存候选");
        assert_eq!(state.installation_count(), 1);
        state.replace_installations(&[]).expect("应能清空旧候选");
        assert_eq!(state.installation_count(), 0);
    }

    #[test]
    fn main_window_label_is_required() {
        assert!(ensure_main_window_label("main").is_ok());
        assert!(ensure_main_window_label("chat-assistant").is_err());
        assert!(ensure_main_window_label("asset-search").is_err());
        assert!(ensure_main_window_label("director-desk").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn manually_selected_windows_path_keeps_stable_canonical_identity() {
        let root = TestDirectory::new("manual-steam-path");
        let selected = root.create_manual_x64_candidate();
        let executable =
            canonicalize_registered_executable(&selected).expect("手选路径应能转换为内部稳定表示");
        let canonical_root = executable.parent().expect("候选应有安装目录").to_path_buf();
        let record = InstallationRecord {
            candidate: BlenderInstallationCandidate {
                installation_id: installation_id(&path_identity(&executable)),
                display_name: "Blender（手动选择）".to_string(),
                source: BlenderInstallationSource::UserSelected,
                version_hint: None,
                version_hint_is_verified: false,
            },
            canonical_root,
            canonical_executable: executable.clone(),
        };

        assert_eq!(
            validate_installation_record(&record).expect("启动前复核应接受同一手选候选"),
            executable
        );
    }

    #[cfg(windows)]
    #[test]
    fn manually_selected_windows_path_persists_and_restores_from_private_directory() {
        let root = TestDirectory::new("manual-persistence");
        let selected = root.create_manual_x64_candidate();
        let record = manual_installation_record(&selected).expect("手选候选应可登记");
        let private_directory = root.path.join("private");
        fs::create_dir_all(&private_directory).expect("应能创建私有设置目录");

        persist_manual_installation(&private_directory, &record.canonical_executable)
            .expect("手选候选应可保存");
        let restored = restore_manual_installation(&private_directory)
            .expect("已保存候选应可读取")
            .expect("已保存候选应存在");

        assert_eq!(restored.candidate, record.candidate);
        assert_eq!(restored.canonical_executable, record.canonical_executable);
        assert_eq!(
            validate_installation_record(&restored).expect("恢复后仍应通过启动前复核"),
            record.canonical_executable
        );
    }

    #[cfg(windows)]
    #[test]
    fn accepts_only_local_drive_root_hints() {
        assert!(root_hint_is_allowed(Path::new(r"C:\Program Files")));
        assert!(!root_hint_is_allowed(Path::new(r"\\server\share")));
        assert!(!root_hint_is_allowed(Path::new(r"\\?\UNC\server\share")));
        assert!(!root_hint_is_allowed(Path::new(r"\\.\C:\Program Files")));
        assert!(!root_hint_is_allowed(Path::new("relative")));
        assert!(canonical_root_is_allowed(Path::new(
            r"\\?\C:\Program Files"
        )));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_reparse_attribute_deterministically() {
        assert!(!has_windows_reparse_attribute(0));
        assert!(has_windows_reparse_attribute(0x0400));
        assert!(has_windows_reparse_attribute(0x0420));
    }

    #[test]
    fn empty_result_explicitly_reports_non_exhaustive_scope() {
        let result = public_discovery_result(
            DiscoverySnapshot::default(),
            BlenderDiscoveryScope::WindowsKnownInstallLocations,
            None,
        );

        assert!(result.candidates.is_empty());
        assert!(!result.exhaustive);
        assert!(!result.partial);
        assert!(!result.truncated);
        let serialized = serde_json::to_string(&result).expect("结果应可序列化");
        assert!(serialized.contains("\"scope\":\"windows-known-install-locations\""));
        assert!(serialized.contains("\"exhaustive\":false"));
    }
}
