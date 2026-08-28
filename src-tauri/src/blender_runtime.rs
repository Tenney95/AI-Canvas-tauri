//! Blender 原生运行时的受限安装候选发现。
//!
//! 本阶段只读取固定 Program Files 层级，不执行候选，也不向前端暴露绝对路径。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{State, Webview};

const BLENDER_VENDOR_DIRECTORY: &str = "Blender Foundation";
const BLENDER_EXECUTABLE_NAME: &str = "blender.exe";
const INSTALLATION_ID_DOMAIN: &[u8] = b"ai-canvas/blender-installation/v1\0";
const MAX_DISCOVERY_ROOTS: usize = 3;
const MAX_DIRECTORY_ENTRIES: usize = 128;
const MAX_RETURNED_CANDIDATES: usize = 16;
const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_VERSION_HINT_CHARS: usize = 32;

/// 候选来源只描述本轮扫描入口，不代表候选已通过版本或架构验证。
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum BlenderInstallationSource {
    #[serde(rename = "program-files-64")]
    ProgramFiles64,
    #[serde(rename = "program-files")]
    ProgramFiles,
    #[serde(rename = "program-files-x86")]
    ProgramFilesX86,
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
    WindowsProgramFilesStandardLayout,
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

/// 发现记录只存在于当前 Rust 进程内；后续 Job 启动仍必须重新校验路径和兼容性。
#[derive(Default)]
pub struct BlenderRuntimeState {
    installations: Mutex<HashMap<String, (PathBuf, PathBuf)>>,
}

#[derive(Clone, Debug)]
struct DiscoveryRoot {
    source: BlenderInstallationSource,
    path: PathBuf,
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
        let next = installations
            .iter()
            .map(|installation| {
                (
                    installation.candidate.installation_id.clone(),
                    (
                        installation.canonical_root.clone(),
                        installation.canonical_executable.clone(),
                    ),
                )
            })
            .collect();

        let mut current = self
            .installations
            .lock()
            .map_err(|_| "Blender 安装候选状态不可用".to_string())?;
        *current = next;
        Ok(())
    }

    #[cfg(test)]
    fn installation_count(&self) -> usize {
        self.installations.lock().expect("测试状态锁不应中毒").len()
    }
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
    BlenderDiscoveryScope::WindowsProgramFilesStandardLayout
}

#[cfg(not(windows))]
fn platform_discovery_scope() -> BlenderDiscoveryScope {
    BlenderDiscoveryScope::UnsupportedPlatform
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

    let hint = display_name.get(PREFIX.len()..)?;
    if hint.chars().count() > MAX_VERSION_HINT_CHARS {
        return None;
    }

    let segments: Vec<_> = hint.split('.').collect();
    if !(2..=4).contains(&segments.len())
        || segments.iter().any(|segment| {
            segment.is_empty() || !segment.chars().all(|value| value.is_ascii_digit())
        })
    {
        return None;
    }

    Some(hint.to_string())
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

    let mut installations: Vec<_> = unique.into_values().collect();
    installations.sort_by(|left, right| {
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
    if installations.len() > MAX_RETURNED_CANDIDATES {
        snapshot.truncated = true;
        installations.truncate(MAX_RETURNED_CANDIDATES);
    }
    snapshot.installations = installations;
    snapshot
}

#[cfg(test)]
fn discover_from_roots(roots: Vec<DiscoveryRoot>) -> Vec<DiscoveredInstallation> {
    scan_from_roots(roots).installations
}

fn public_discovery_result(
    snapshot: DiscoverySnapshot,
    scope: BlenderDiscoveryScope,
) -> BlenderDiscoveryResult {
    BlenderDiscoveryResult {
        candidates: snapshot
            .installations
            .into_iter()
            .map(|installation| installation.candidate)
            .collect(),
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

    let snapshot = scan_from_roots(platform_discovery_roots());
    state.replace_installations(&snapshot.installations)?;
    Ok(public_discovery_result(
        snapshot,
        platform_discovery_scope(),
    ))
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
            BlenderDiscoveryScope::WindowsProgramFilesStandardLayout,
        );

        assert!(result.candidates.is_empty());
        assert!(!result.exhaustive);
        assert!(!result.partial);
        assert!(!result.truncated);
        let serialized = serde_json::to_string(&result).expect("结果应可序列化");
        assert!(serialized.contains("\"scope\":\"windows-program-files-standard-layout\""));
        assert!(serialized.contains("\"exhaustive\":false"));
    }
}
