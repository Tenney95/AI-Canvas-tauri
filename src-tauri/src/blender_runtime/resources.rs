//! AI Canvas Blender 固定运行资源的信任根与私有目录安装器。
//!
//! 本模块不接收外部脚本、资源路径或清单内容。所有可安装字节均在编译期内嵌，
//! 并在写入前同时核对固定清单字段、固定资源集合、字节数和 SHA-256。

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    fmt, fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const RUNTIME_MANIFEST_BYTES: &[u8] =
    include_bytes!("../../resources/blender-runtime/v1/runtime-manifest.json");
const TEMPLATE_INIT_BYTES: &[u8] = include_bytes!(
    "../../resources/blender-runtime/v1/scripts/startup/bl_app_templates_user/ai_canvas_director/__init__.py"
);
const TEMPLATE_STARTUP_BLEND_BYTES: &[u8] = include_bytes!(
    "../../resources/blender-runtime/v1/scripts/startup/bl_app_templates_user/ai_canvas_director/startup.blend"
);
const JOB_SCRIPT_BYTES: &[u8] =
    include_bytes!("../../resources/blender-runtime/v1/jobs/ai_canvas_director_job_v1.py");

const SCHEMA_VERSION: u32 = 1;
const PACKAGE_ID: &str = "ai-canvas-blender-runtime";
const PACKAGE_VERSION: &str = "1.2.0";
const TEMPLATE_ID: &str = "ai_canvas_director";
const TEMPLATE_VERSION: u32 = 1;
const JOB_PROTOCOL: &str = "ai-canvas-blender-job-v1";
const REQUEST_SCHEMA_VERSION: u32 = 1;
const RESULT_MANIFEST_SCHEMA_VERSION: u32 = 1;
const CREATED_WITH_BLENDER_VERSION: &str = "5.2.1 LTS";
const SUPPORTED_BLENDER_VERSION: &str = "5.2.1";
const COMPATIBILITY_PLATFORM: &str = "windows";
const COMPATIBILITY_ARCHITECTURE: &str = "x86_64";

const INSTALL_VENDOR_DIRECTORY: &str = "blender-runtime";
const INSTALL_VERSION_DIRECTORY: &str = PACKAGE_VERSION;
const INSTALLED_MANIFEST_PATH: &str = "runtime-manifest.json";
const TEMPLATE_INIT_PATH: &str =
    "scripts/startup/bl_app_templates_system/ai_canvas_director/__init__.py";
const TEMPLATE_STARTUP_BLEND_PATH: &str =
    "scripts/startup/bl_app_templates_system/ai_canvas_director/startup.blend";
const JOB_SCRIPT_PATH: &str = "jobs/ai_canvas_director_job_v1.py";

const TEMPLATE_INIT_SHA256: &str =
    "a1586bd43ee9398a341e130a38f24c1b80b31ff863a836f77604100209edd372";
const TEMPLATE_STARTUP_BLEND_SHA256: &str =
    "a3e806fc2b910598b5f24c90127d02494fcbaf79a53f7e2eb7aee95f7f85e340";
const JOB_SCRIPT_SHA256: &str = "3173845adb71ab01f718864353c8cfa92abd5d2aba6440f4fa1a1c5d782dbb19";

const TEMPLATE_INIT_SIZE: u64 = 73_713;
const TEMPLATE_STARTUP_BLEND_SIZE: u64 = 91_348;
const JOB_SCRIPT_SIZE: u64 = 40_364;

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
enum EmbeddedResourceEncoding {
    CanonicalLfText,
    Binary,
}

#[derive(Debug, Clone, Copy)]
struct EmbeddedResource {
    id: &'static str,
    relative_path: &'static str,
    bytes: u64,
    sha256: &'static str,
    content: &'static [u8],
    encoding: EmbeddedResourceEncoding,
}

const EMBEDDED_RESOURCES: [EmbeddedResource; 3] = [
    EmbeddedResource {
        id: "template-init",
        relative_path: TEMPLATE_INIT_PATH,
        bytes: TEMPLATE_INIT_SIZE,
        sha256: TEMPLATE_INIT_SHA256,
        content: TEMPLATE_INIT_BYTES,
        encoding: EmbeddedResourceEncoding::CanonicalLfText,
    },
    EmbeddedResource {
        id: "template-startup-blend",
        relative_path: TEMPLATE_STARTUP_BLEND_PATH,
        bytes: TEMPLATE_STARTUP_BLEND_SIZE,
        sha256: TEMPLATE_STARTUP_BLEND_SHA256,
        content: TEMPLATE_STARTUP_BLEND_BYTES,
        encoding: EmbeddedResourceEncoding::Binary,
    },
    EmbeddedResource {
        id: "job-script",
        relative_path: JOB_SCRIPT_PATH,
        bytes: JOB_SCRIPT_SIZE,
        sha256: JOB_SCRIPT_SHA256,
        content: JOB_SCRIPT_BYTES,
        encoding: EmbeddedResourceEncoding::CanonicalLfText,
    },
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    schema_version: u32,
    package_id: String,
    package_version: String,
    template_id: String,
    template_version: u32,
    job_protocol: String,
    request_schema_version: u32,
    result_manifest_schema_version: u32,
    created_with_blender_version: String,
    compatibility: RuntimeCompatibility,
    resources: Vec<ManifestResource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCompatibility {
    platform: String,
    architecture: String,
    supported_versions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestResource {
    id: String,
    relative_path: String,
    bytes: u64,
    sha256: String,
}

/// 安装完成后可交给固定 Blender runner 的受信路径。
///
/// 这些路径只由本模块在已校验的应用私有根目录下构造，不包含调用方提供的脚本路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedBlenderResourcePaths {
    pub runtime_root: PathBuf,
    pub runtime_manifest: PathBuf,
    /// 固定资源脚本根。字段名是既有内部契约，不代表启动时会覆盖用户脚本目录。
    pub blender_user_scripts_root: PathBuf,
    pub application_templates_root: PathBuf,
    pub application_template_root: PathBuf,
    pub jobs_root: PathBuf,
    pub job_script: PathBuf,
}

/// 固定资源校验或安装失败。
///
/// `Display` 文本有意不保存底层 I/O 错误和绝对路径，避免错误进入日志后泄露本机目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlenderResourceError {
    InvalidEmbeddedManifest,
    EmbeddedResourceMismatch,
    InvalidPrivateRoot,
    UnsafeInstallTree,
    ExistingResourceConflict,
    InstallFailed,
}

impl fmt::Display for BlenderResourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidEmbeddedManifest => "Blender 固定资源清单无效",
            Self::EmbeddedResourceMismatch => "Blender 固定资源完整性校验失败",
            Self::InvalidPrivateRoot => "Blender 资源私有安装根目录无效",
            Self::UnsafeInstallTree => "Blender 资源安装目录不安全",
            Self::ExistingResourceConflict => "Blender 资源目录存在内容冲突",
            Self::InstallFailed => "Blender 固定资源安装失败",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for BlenderResourceError {}

fn sha256_hex(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

/// 将受信文本确定性规范化为清单使用的 LF 字节。
///
/// Git 的 `eol=lf` 不会主动重写既有工作树，而 `include_bytes!` 会读取工作树原始
/// 字节。这里只接受 UTF-8、LF 或 CRLF；孤立 CR 继续作为资源损坏拒绝，避免把任意
/// 字节变化掩盖成合法资源。
fn canonicalize_lf_text(content: &[u8]) -> Result<Cow<'_, [u8]>, BlenderResourceError> {
    if std::str::from_utf8(content).is_err() {
        return Err(BlenderResourceError::EmbeddedResourceMismatch);
    }
    if !content.contains(&b'\r') {
        return Ok(Cow::Borrowed(content));
    }

    let mut normalized = Vec::with_capacity(content.len());
    let mut index = 0;
    while index < content.len() {
        match content[index] {
            b'\r' if content.get(index + 1) == Some(&b'\n') => {
                normalized.push(b'\n');
                index += 2;
            }
            b'\r' => return Err(BlenderResourceError::EmbeddedResourceMismatch),
            byte => {
                normalized.push(byte);
                index += 1;
            }
        }
    }
    Ok(Cow::Owned(normalized))
}

fn canonical_resource_content(
    resource: EmbeddedResource,
) -> Result<Cow<'static, [u8]>, BlenderResourceError> {
    match resource.encoding {
        EmbeddedResourceEncoding::CanonicalLfText => canonicalize_lf_text(resource.content),
        EmbeddedResourceEncoding::Binary => Ok(Cow::Borrowed(resource.content)),
    }
}

fn validate_manifest_resource(
    manifest: &RuntimeManifest,
    expected: EmbeddedResource,
) -> Result<(), BlenderResourceError> {
    let mut matching = manifest
        .resources
        .iter()
        .filter(|resource| resource.id == expected.id);
    let Some(resource) = matching.next() else {
        return Err(BlenderResourceError::InvalidEmbeddedManifest);
    };
    if matching.next().is_some()
        || resource.relative_path != expected.relative_path
        || resource.bytes != expected.bytes
        || resource.sha256 != expected.sha256
    {
        return Err(BlenderResourceError::InvalidEmbeddedManifest);
    }

    let canonical_content = canonical_resource_content(expected)?;
    if canonical_content.len() as u64 != expected.bytes
        || sha256_hex(canonical_content.as_ref()) != expected.sha256
    {
        return Err(BlenderResourceError::EmbeddedResourceMismatch);
    }
    Ok(())
}

/// 严格验证编译内嵌的 runtime manifest 与全部固定资源。
pub fn validate_embedded_blender_runtime() -> Result<(), BlenderResourceError> {
    let manifest_bytes = canonicalize_lf_text(RUNTIME_MANIFEST_BYTES)
        .map_err(|_| BlenderResourceError::InvalidEmbeddedManifest)?;
    let manifest: RuntimeManifest = serde_json::from_slice(manifest_bytes.as_ref())
        .map_err(|_| BlenderResourceError::InvalidEmbeddedManifest)?;

    let has_fixed_header = manifest.schema_version == SCHEMA_VERSION
        && manifest.package_id == PACKAGE_ID
        && manifest.package_version == PACKAGE_VERSION
        && manifest.template_id == TEMPLATE_ID
        && manifest.template_version == TEMPLATE_VERSION
        && manifest.job_protocol == JOB_PROTOCOL
        && manifest.request_schema_version == REQUEST_SCHEMA_VERSION
        && manifest.result_manifest_schema_version == RESULT_MANIFEST_SCHEMA_VERSION
        && manifest.created_with_blender_version == CREATED_WITH_BLENDER_VERSION
        && manifest.compatibility.platform == COMPATIBILITY_PLATFORM
        && manifest.compatibility.architecture == COMPATIBILITY_ARCHITECTURE
        && manifest.compatibility.supported_versions.len() == 1
        && manifest.compatibility.supported_versions[0] == SUPPORTED_BLENDER_VERSION
        && manifest.resources.len() == EMBEDDED_RESOURCES.len();
    if !has_fixed_header {
        return Err(BlenderResourceError::InvalidEmbeddedManifest);
    }

    for resource in EMBEDDED_RESOURCES {
        validate_manifest_resource(&manifest, resource)?;
    }
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn contains_unsafe_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
}

fn ensure_existing_plain_directory_chain(path: &Path) -> Result<(), BlenderResourceError> {
    let mut ancestors: Vec<&Path> = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .collect();
    ancestors.reverse();

    for ancestor in ancestors {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| BlenderResourceError::UnsafeInstallTree)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(BlenderResourceError::UnsafeInstallTree);
        }
    }
    Ok(())
}

fn validate_private_root(root: &Path) -> Result<PathBuf, BlenderResourceError> {
    if !root.is_absolute() || contains_unsafe_component(root) {
        return Err(BlenderResourceError::InvalidPrivateRoot);
    }
    ensure_existing_plain_directory_chain(root)
        .map_err(|_| BlenderResourceError::InvalidPrivateRoot)?;

    let canonical = fs::canonicalize(root).map_err(|_| BlenderResourceError::InvalidPrivateRoot)?;
    ensure_existing_plain_directory_chain(&canonical)
        .map_err(|_| BlenderResourceError::InvalidPrivateRoot)?;
    Ok(canonical)
}

fn parse_fixed_relative_path(relative: &str) -> Result<PathBuf, BlenderResourceError> {
    let path = PathBuf::from(relative);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(BlenderResourceError::UnsafeInstallTree);
    }
    Ok(path)
}

fn inspect_directory_prefix(
    private_root: &Path,
    relative_directory: &Path,
) -> Result<bool, BlenderResourceError> {
    let mut current = private_root.to_path_buf();
    for component in relative_directory.components() {
        let Component::Normal(name) = component else {
            return Err(BlenderResourceError::UnsafeInstallTree);
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                    return Err(BlenderResourceError::UnsafeInstallTree);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(BlenderResourceError::InstallFailed),
        }
    }
    Ok(true)
}

fn file_matches(path: &Path, expected: &[u8]) -> Result<bool, BlenderResourceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| BlenderResourceError::InstallFailed)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(BlenderResourceError::UnsafeInstallTree);
    }
    if metadata.len() != expected.len() as u64 {
        return Ok(false);
    }
    let actual = fs::read(path).map_err(|_| BlenderResourceError::InstallFailed)?;
    Ok(actual == expected)
}

fn preflight_file(
    private_root: &Path,
    relative: &Path,
    expected: &[u8],
) -> Result<(), BlenderResourceError> {
    let parent = relative
        .parent()
        .ok_or(BlenderResourceError::UnsafeInstallTree)?;
    if !inspect_directory_prefix(private_root, parent)? {
        return Ok(());
    }

    let target = private_root.join(relative);
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            if !file_matches(&target, expected)? {
                return Err(BlenderResourceError::ExistingResourceConflict);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(BlenderResourceError::InstallFailed),
    }
    Ok(())
}

fn ensure_directory_tree(
    private_root: &Path,
    relative_directory: &Path,
) -> Result<PathBuf, BlenderResourceError> {
    let mut current = private_root.to_path_buf();
    for component in relative_directory.components() {
        let Component::Normal(name) = component else {
            return Err(BlenderResourceError::UnsafeInstallTree);
        };
        current.push(name);

        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                    return Err(BlenderResourceError::UnsafeInstallTree);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| BlenderResourceError::InstallFailed)?;
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|_| BlenderResourceError::InstallFailed)?;
                if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                    return Err(BlenderResourceError::UnsafeInstallTree);
                }
            }
            Err(_) => return Err(BlenderResourceError::InstallFailed),
        }

        ensure_existing_plain_directory_chain(&current)?;
        let canonical =
            fs::canonicalize(&current).map_err(|_| BlenderResourceError::InstallFailed)?;
        if !canonical.starts_with(private_root) {
            return Err(BlenderResourceError::UnsafeInstallTree);
        }
        current = canonical;
    }
    Ok(current)
}

fn create_temporary_file(parent: &Path, content: &[u8]) -> Result<PathBuf, BlenderResourceError> {
    for _ in 0..64 {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".ai-canvas-blender-install-{}-{sequence}.tmp",
            std::process::id()
        ));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(BlenderResourceError::InstallFailed),
        };

        let write_result = file.write_all(content).and_then(|_| file.sync_all());
        drop(file);
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(BlenderResourceError::InstallFailed);
        }

        let metadata =
            fs::symlink_metadata(&temporary).map_err(|_| BlenderResourceError::InstallFailed)?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) {
            let _ = fs::remove_file(&temporary);
            return Err(BlenderResourceError::UnsafeInstallTree);
        }
        return Ok(temporary);
    }
    Err(BlenderResourceError::InstallFailed)
}

#[cfg(windows)]
fn commit_temporary_file(temporary: &Path, target: &Path) -> io::Result<()> {
    // Windows rename 不会替换已存在的目标，因此并发安装也不会覆盖资源。
    fs::rename(temporary, target)
}

#[cfg(not(windows))]
fn commit_temporary_file(temporary: &Path, target: &Path) -> io::Result<()> {
    // 非目标平台上的 std::fs::rename 可能替换目标；hard_link 保留同样的原子
    // create-new 语义，避免开发机测试意外覆盖既有文件。
    fs::hard_link(temporary, target)?;
    fs::remove_file(temporary)
}

fn install_file(
    private_root: &Path,
    relative: &Path,
    content: &[u8],
) -> Result<PathBuf, BlenderResourceError> {
    let parent_relative = relative
        .parent()
        .ok_or(BlenderResourceError::UnsafeInstallTree)?;
    let parent = ensure_directory_tree(private_root, parent_relative)?;
    let target = private_root.join(relative);

    match fs::symlink_metadata(&target) {
        Ok(_) => {
            if file_matches(&target, content)? {
                return Ok(target);
            }
            return Err(BlenderResourceError::ExistingResourceConflict);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(BlenderResourceError::InstallFailed),
    }

    ensure_existing_plain_directory_chain(&parent)?;
    let temporary = create_temporary_file(&parent, content)?;
    ensure_existing_plain_directory_chain(&parent)?;

    if commit_temporary_file(&temporary, &target).is_err() {
        let _ = fs::remove_file(&temporary);
        return match fs::symlink_metadata(&target) {
            Ok(_) if file_matches(&target, content)? => Ok(target),
            Ok(_) => Err(BlenderResourceError::ExistingResourceConflict),
            Err(_) => Err(BlenderResourceError::InstallFailed),
        };
    }

    if !file_matches(&target, content)? {
        return Err(BlenderResourceError::InstallFailed);
    }
    Ok(target)
}

fn runtime_relative_path(relative: &str) -> Result<PathBuf, BlenderResourceError> {
    let mut path = PathBuf::from(INSTALL_VENDOR_DIRECTORY);
    path.push(INSTALL_VERSION_DIRECTORY);
    path.push(parse_fixed_relative_path(relative)?);
    Ok(path)
}

/// 将编译内嵌的固定资源安装到调用方提供的应用私有根目录。
///
/// 根目录必须已经存在并且是绝对普通目录。安装器逐级拒绝符号链接和 Windows
/// reparse point；同内容文件幂等复用，异内容文件一律拒绝覆盖。
pub fn install_embedded_blender_runtime(
    app_private_root: &Path,
) -> Result<TrustedBlenderResourcePaths, BlenderResourceError> {
    validate_embedded_blender_runtime()?;
    let private_root = validate_private_root(app_private_root)?;

    let manifest_relative = runtime_relative_path(INSTALLED_MANIFEST_PATH)?;
    let mut install_entries = Vec::with_capacity(EMBEDDED_RESOURCES.len() + 1);
    let manifest_content = canonicalize_lf_text(RUNTIME_MANIFEST_BYTES)
        .map_err(|_| BlenderResourceError::InvalidEmbeddedManifest)?;
    install_entries.push((manifest_relative.clone(), manifest_content));
    for resource in EMBEDDED_RESOURCES {
        install_entries.push((
            runtime_relative_path(resource.relative_path)?,
            canonical_resource_content(resource)?,
        ));
    }

    // 在第一次写入前检查所有已存在目标，避免发现冲突时留下新的部分安装。
    for (relative, content) in &install_entries {
        preflight_file(&private_root, relative, content.as_ref())?;
    }
    for (relative, content) in &install_entries {
        install_file(&private_root, relative, content.as_ref())?;
    }

    let runtime_root = ensure_directory_tree(
        &private_root,
        &PathBuf::from(INSTALL_VENDOR_DIRECTORY).join(INSTALL_VERSION_DIRECTORY),
    )?;
    let blender_system_scripts_root = runtime_root.join("scripts");
    let application_templates_root =
        blender_system_scripts_root.join("startup/bl_app_templates_system");
    let application_template_root = application_templates_root.join(TEMPLATE_ID);
    let jobs_root = runtime_root.join("jobs");

    Ok(TrustedBlenderResourcePaths {
        runtime_manifest: runtime_root.join(INSTALLED_MANIFEST_PATH),
        job_script: jobs_root.join("ai_canvas_director_job_v1.py"),
        runtime_root,
        blender_user_scripts_root: blender_system_scripts_root,
        application_templates_root,
        application_template_root,
        jobs_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be available")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "ai-canvas-blender-resources-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("test root should be created");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn embedded_runtime_matches_the_pinned_manifest() {
        validate_embedded_blender_runtime().expect("embedded runtime should be valid");
    }

    #[test]
    fn trusted_text_is_canonicalized_without_weakening_the_pinned_hash() {
        assert_eq!(
            canonicalize_lf_text(b"first\r\nsecond\r\n")
                .expect("CRLF text should be canonicalized")
                .as_ref(),
            b"first\nsecond\n"
        );
        assert_eq!(
            canonicalize_lf_text(b"first\nsecond\n")
                .expect("LF text should remain valid")
                .as_ref(),
            b"first\nsecond\n"
        );
        assert_eq!(
            canonicalize_lf_text(b"first\rsecond").expect_err("bare CR must be rejected"),
            BlenderResourceError::EmbeddedResourceMismatch
        );
    }

    #[test]
    fn install_is_idempotent_and_returns_trusted_paths() {
        let root = TestDirectory::create();
        let previous_runtime_root = root.0.join(INSTALL_VENDOR_DIRECTORY).join("1.1.0");
        fs::create_dir_all(&previous_runtime_root)
            .expect("previous runtime directory should be created");
        let previous_marker = previous_runtime_root.join("preserved.txt");
        fs::write(&previous_marker, b"previous runtime")
            .expect("previous runtime marker should be written");
        let first = install_embedded_blender_runtime(&root.0)
            .expect("first resource install should succeed");
        let second = install_embedded_blender_runtime(&root.0)
            .expect("second resource install should be idempotent");

        assert_eq!(first, second);
        assert!(first.runtime_root.ends_with("blender-runtime/1.2.0"));
        assert_eq!(
            fs::read(previous_marker).expect("previous runtime should remain readable"),
            b"previous runtime"
        );
        assert!(first
            .application_templates_root
            .ends_with("scripts/startup/bl_app_templates_system"));
        let expected_job_script =
            canonicalize_lf_text(JOB_SCRIPT_BYTES).expect("job script fixture should normalize");
        assert_eq!(
            fs::read(&first.job_script).expect("job script should be readable"),
            expected_job_script.as_ref()
        );
        assert_eq!(
            fs::read(first.application_template_root.join("startup.blend"))
                .expect("startup blend should be readable"),
            TEMPLATE_STARTUP_BLEND_BYTES
        );
    }

    #[test]
    fn install_rejects_different_existing_content_without_overwriting_it() {
        let root = TestDirectory::create();
        let installed = install_embedded_blender_runtime(&root.0)
            .expect("initial resource install should succeed");
        let different = b"not the trusted job script";
        fs::write(&installed.job_script, different).expect("test should replace installed fixture");

        let error = install_embedded_blender_runtime(&root.0)
            .expect_err("different existing content must be rejected");
        assert_eq!(error, BlenderResourceError::ExistingResourceConflict);
        assert_eq!(
            fs::read(&installed.job_script).expect("conflicting file should remain readable"),
            different
        );
        assert!(!error
            .to_string()
            .contains(root.0.to_string_lossy().as_ref()));
    }
}
