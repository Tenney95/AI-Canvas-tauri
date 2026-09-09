//! 项目内可重建的缩略图缓存；原图读取授权与派生文件写入始终在原生侧复核。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime, Webview};

use crate::path_policy::{
    authorize_existing_plain_directory, authorize_existing_plain_file, ensure_trusted_caller,
};

const CACHE_DIRECTORY: &str = ".thumbnail";
const CACHE_MAGIC: &[u8; 8] = b"ACTHMB01";
const CACHE_HEADER_BYTES: usize = 8 + 32 + 4 + 4 + 32;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedThumbnail {
    source_version: String,
    cached_bytes: Option<Vec<u8>>,
    width: Option<u32>,
    height: Option<u32>,
}

struct SourceIdentity {
    version: [u8; 32],
    cache_name: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_edge(max_edge: u32) -> Result<(), String> {
    if matches!(max_edge, 256 | 512 | 1024) {
        Ok(())
    } else {
        Err("缩略图尺寸无效".into())
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// 每个后代路径组件均须是普通目录/文件，避免中间目录被链接替换。
fn validate_descendant(root: &Path, path: &Path, directory: bool) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "缩略图路径超出项目目录")?;
    if relative.as_os_str().is_empty() {
        return Err("缩略图源文件无效".into());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("缩略图路径无效".into());
        }
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| "缩略图路径不可访问")?;
        if is_link(&metadata) || (current != path && !metadata.is_dir()) {
            return Err("缩略图路径不允许符号链接或重解析点".into());
        }
        if current == path
            && (directory != metadata.is_dir() || (!directory && !metadata.is_file()))
        {
            return Err("缩略图路径类型无效".into());
        }
    }
    Ok(())
}

fn source_identity(root: &Path, source: &Path, max_edge: u32) -> Result<SourceIdentity, String> {
    validate_edge(max_edge)?;
    validate_descendant(root, source, false)?;
    let relative = source.strip_prefix(root).map_err(|_| "原图不属于该项目")?;
    if relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == CACHE_DIRECTORY)
    {
        return Err("缓存文件不能作为缩略图原图".into());
    }
    let relative_text = relative
        .components()
        .map(|component| component.as_os_str().to_str().ok_or("原图名称编码无效"))
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    let metadata = fs::metadata(source).map_err(|_| "无法读取原图状态")?;
    if metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
        return Err("原图体积超过缩略图处理范围".into());
    }
    let modified = metadata
        .modified()
        .map_err(|_| "无法读取原图修改时间")?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "原图修改时间无效")?;
    let mut version = Sha256::new();
    version.update(b"canvas-thumbnail-source-v1\0");
    version.update(relative_text.as_bytes());
    version.update([0]);
    version.update(metadata.len().to_le_bytes());
    version.update(modified.as_nanos().to_le_bytes());
    let mut name = Sha256::new();
    name.update(b"canvas-thumbnail-webp85-v1\0");
    name.update(relative_text.as_bytes());
    name.update([0]);
    name.update(max_edge.to_le_bytes());
    Ok(SourceIdentity {
        version: version.finalize().into(),
        cache_name: format!("v1-{}.cache", hex(&name.finalize())),
    })
}

fn validate_image(bytes: &[u8], max_edge: u32) -> Result<(u32, u32), String> {
    if bytes.is_empty() || bytes.len() > MAX_PREVIEW_BYTES {
        return Err("缩略图体积超过 4 MiB".into());
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "缩略图格式无效")?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::WebP)
    ) {
        return Err("缩略图仅接受 PNG 或 WebP".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(max_edge);
    limits.max_image_height = Some(max_edge);
    limits.max_alloc = Some(16 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| "缩略图损坏或尺寸超过上限")?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 || width > max_edge || height > max_edge {
        return Err("缩略图尺寸无效".into());
    }
    Ok((width, height))
}

fn encode_cache(identity: &SourceIdentity, width: u32, height: u32, bytes: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(CACHE_HEADER_BYTES + bytes.len());
    encoded.extend_from_slice(CACHE_MAGIC);
    encoded.extend_from_slice(&identity.version);
    encoded.extend_from_slice(&width.to_le_bytes());
    encoded.extend_from_slice(&height.to_le_bytes());
    encoded.extend_from_slice(&Sha256::digest(bytes));
    encoded.extend_from_slice(bytes);
    encoded
}

fn read_cache(
    root: &Path,
    identity: &SourceIdentity,
    max_edge: u32,
) -> Option<(Vec<u8>, u32, u32)> {
    let path = root.join(CACHE_DIRECTORY).join(&identity.cache_name);
    validate_descendant(root, &path, false).ok()?;
    // 从 macOS/Linux 移来的点目录，在 Windows 上首次命中时也补齐隐藏属性。
    #[cfg(windows)]
    windows_files::hide(&root.join(CACHE_DIRECTORY)).ok()?;
    let mut file = File::open(&path).ok()?;
    let size = file.metadata().ok()?.len();
    if size <= CACHE_HEADER_BYTES as u64 || size > (CACHE_HEADER_BYTES + MAX_PREVIEW_BYTES) as u64 {
        return None;
    }
    let mut encoded = Vec::with_capacity(size as usize);
    Read::by_ref(&mut file)
        .take((CACHE_HEADER_BYTES + MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut encoded)
        .ok()?;
    if encoded.len() != size as usize
        || &encoded[..8] != CACHE_MAGIC
        || encoded[8..40] != identity.version
    {
        return None;
    }
    let width = u32::from_le_bytes(encoded[40..44].try_into().ok()?);
    let height = u32::from_le_bytes(encoded[44..48].try_into().ok()?);
    let bytes = &encoded[CACHE_HEADER_BYTES..];
    if encoded[48..80] != Sha256::digest(bytes)[..]
        || validate_image(bytes, max_edge).ok()? != (width, height)
    {
        return None;
    }
    Some((bytes.to_vec(), width, height))
}

#[cfg(windows)]
mod windows_files {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileAttributesW(path: *const u16) -> u32;
        fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    pub fn hide(path: &Path) -> Result<(), String> {
        let path = wide(path);
        // SAFETY: 两个调用只使用存活且以 NUL 终止的 UTF-16 路径，不持有指针。
        let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
        if attributes == u32::MAX {
            return Err("无法隐藏缩略图缓存目录".into());
        }
        if attributes & 0x2 == 0
            && unsafe { SetFileAttributesW(path.as_ptr(), attributes | 0x2) } == 0
        {
            return Err("无法隐藏缩略图缓存目录".into());
        }
        Ok(())
    }

    pub fn replace(source: &Path, destination: &Path) -> Result<(), String> {
        let source = wide(source);
        let destination = wide(destination);
        // SAFETY: 路径均来自已验证的同一缓存目录，UTF-16 缓冲区存活至调用返回。
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) } == 0 {
            return Err("缩略图缓存原子写入失败".into());
        }
        Ok(())
    }
}

fn ensure_cache_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(CACHE_DIRECTORY);
    match fs::create_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("无法创建缩略图缓存目录".into()),
    }
    validate_descendant(root, &directory, true)?;
    #[cfg(windows)]
    windows_files::hide(&directory)?;
    Ok(directory)
}

fn write_cache(
    root: &Path,
    source: &Path,
    max_edge: u32,
    source_version: &str,
    bytes: &[u8],
) -> Result<bool, String> {
    let identity = source_identity(root, source, max_edge)?;
    if hex(&identity.version) != source_version {
        return Ok(false);
    }
    let (width, height) = validate_image(bytes, max_edge)?;
    let directory = ensure_cache_directory(root)?;
    let destination = directory.join(&identity.cache_name);
    if destination.symlink_metadata().is_ok() {
        validate_descendant(root, &destination, false)?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(".{}-{nonce}-{sequence}.tmp", identity.cache_name));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建缩略图临时文件")?;
    let result = (|| {
        file.write_all(&encode_cache(&identity, width, height, bytes))
            .map_err(|_| "缩略图写入失败")?;
        file.sync_all().map_err(|_| "缩略图写入失败")?;
        drop(file);
        // 编码或落盘期间原图可能已被编辑，旧结果不可取代当前版本。
        if source_identity(root, source, max_edge)?.version != identity.version {
            return Ok(false);
        }
        validate_descendant(root, &directory, true)?;
        if destination.symlink_metadata().is_ok() {
            validate_descendant(root, &destination, false)?;
        }
        #[cfg(windows)]
        windows_files::replace(&temporary, &destination)?;
        #[cfg(not(windows))]
        fs::rename(&temporary, &destination).map_err(|_| "缩略图缓存原子写入失败")?;
        Ok(true)
    })();
    // 只清理本次 create_new 创建的临时文件，从不遍历或删除缓存目录里的用户文件。
    if validate_descendant(root, &temporary, false).is_ok() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn authorized_source<R: Runtime>(
    app: &AppHandle<R>,
    project_dir: &str,
    source_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = authorize_existing_plain_directory(app, project_dir)?;
    let source = authorize_existing_plain_file(app, source_path)?;
    validate_descendant(&root, &source, false)?;
    Ok((root, source))
}

fn ensure_main<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    ensure_trusted_caller(webview)?;
    if webview.label() != "main" {
        return Err("缩略图缓存仅允许主窗口调用".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_project_thumbnail<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    project_dir: String,
    source_path: String,
    max_edge: u32,
) -> Result<PreparedThumbnail, String> {
    ensure_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (root, source) = authorized_source(&app, &project_dir, &source_path)?;
        let identity = source_identity(&root, &source, max_edge)?;
        let cached = read_cache(&root, &identity, max_edge);
        // 读取缓存时原图同样可能改变；此时返回新版本的 miss，前端重新派生。
        let current = source_identity(&root, &source, max_edge)?;
        let cached = cached.filter(|_| identity.version == current.version);
        Ok(PreparedThumbnail {
            source_version: hex(&current.version),
            width: cached.as_ref().map(|(_, width, _)| *width),
            height: cached.as_ref().map(|(_, _, height)| *height),
            cached_bytes: cached.map(|(bytes, _, _)| bytes),
        })
    })
    .await
    .map_err(|_| "缩略图缓存读取任务失败")?
}

#[tauri::command]
pub async fn write_project_thumbnail<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    project_dir: String,
    source_path: String,
    max_edge: u32,
    source_version: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    ensure_main(&webview)?;
    if bytes.len() > MAX_PREVIEW_BYTES
        || source_version.len() != 64
        || !source_version.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("缩略图写入参数无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (root, source) = authorized_source(&app, &project_dir, &source_path)?;
        write_cache(&root, &source, max_edge, &source_version, &bytes)
    })
    .await
    .map_err(|_| "缩略图缓存写入任务失败")?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("ai-canvas-thumbnail-test-{nonce}-{sequence}"));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("source.png"), b"original-image").unwrap();
            Self(path)
        }
        fn source(&self) -> PathBuf {
            self.0.join("source.png")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let resolved = self.0.canonicalize().unwrap();
            let temporary_root = std::env::temp_dir().canonicalize().unwrap();
            assert!(resolved.starts_with(temporary_root));
            assert!(resolved
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ai-canvas-thumbnail-test-"));
            let _ = fs::remove_dir_all(resolved);
        }
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::DynamicImage::new_rgba8(width, height);
        let mut output = Cursor::new(Vec::new());
        image
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }

    #[test]
    fn persists_reopens_and_reuses_after_project_move() {
        let project = Fixture::new();
        let identity = source_identity(&project.0, &project.source(), 256).unwrap();
        let bytes = png(128, 64);
        assert!(read_cache(&project.0, &identity, 256).is_none());
        assert!(write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&identity.version),
            &bytes
        )
        .unwrap());
        assert_eq!(
            read_cache(&project.0, &identity, 256).unwrap(),
            (bytes.clone(), 128, 64)
        );
        let moved = project.0.join("moved");
        fs::create_dir(&moved).unwrap();
        fs::rename(project.source(), moved.join("source.png")).unwrap();
        fs::rename(project.0.join(CACHE_DIRECTORY), moved.join(CACHE_DIRECTORY)).unwrap();
        let moved_identity = source_identity(&moved, &moved.join("source.png"), 256).unwrap();
        assert_eq!(identity.version, moved_identity.version);
        assert_eq!(read_cache(&moved, &moved_identity, 256).unwrap().0, bytes);
    }

    #[test]
    fn changed_source_misses_and_stale_write_cannot_replace() {
        let project = Fixture::new();
        let first = source_identity(&project.0, &project.source(), 256).unwrap();
        let bytes = png(32, 32);
        write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&first.version),
            &bytes,
        )
        .unwrap();
        fs::write(project.source(), b"changed-source-image").unwrap();
        let current = source_identity(&project.0, &project.source(), 256).unwrap();
        assert_eq!(first.cache_name, current.cache_name);
        assert_ne!(first.version, current.version);
        assert!(read_cache(&project.0, &current, 256).is_none());
        assert!(!write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&first.version),
            &bytes
        )
        .unwrap());
        assert!(write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&current.version),
            &bytes
        )
        .unwrap());
        assert!(read_cache(&project.0, &current, 256).is_some());
        assert_eq!(
            fs::read_dir(project.0.join(CACHE_DIRECTORY))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn same_size_edit_changes_version_and_each_tier_has_its_own_entry() {
        let project = Fixture::new();
        let first = source_identity(&project.0, &project.source(), 256).unwrap();
        let larger = source_identity(&project.0, &project.source(), 512).unwrap();
        assert_eq!(first.version, larger.version);
        assert_ne!(first.cache_name, larger.cache_name);
        let modified = fs::metadata(project.source()).unwrap().modified().unwrap();
        File::options()
            .write(true)
            .open(project.source())
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(modified + std::time::Duration::from_secs(1)),
            )
            .unwrap();
        let current = source_identity(&project.0, &project.source(), 256).unwrap();
        assert_ne!(first.version, current.version);
        assert_eq!(first.cache_name, current.cache_name);
    }

    #[test]
    fn corrupt_and_deleted_cache_can_be_rebuilt() {
        let project = Fixture::new();
        let identity = source_identity(&project.0, &project.source(), 256).unwrap();
        let bytes = png(32, 32);
        write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&identity.version),
            &bytes,
        )
        .unwrap();
        let path = project.0.join(CACHE_DIRECTORY).join(&identity.cache_name);
        let mut damaged = fs::read(&path).unwrap();
        *damaged.last_mut().unwrap() ^= 1;
        fs::write(&path, damaged).unwrap();
        assert!(read_cache(&project.0, &identity, 256).is_none());
        assert!(write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&identity.version),
            &bytes
        )
        .unwrap());
        fs::remove_file(&path).unwrap();
        fs::remove_dir(project.0.join(CACHE_DIRECTORY)).unwrap();
        assert!(read_cache(&project.0, &identity, 256).is_none());
        assert!(write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&identity.version),
            &bytes
        )
        .unwrap());
    }

    #[test]
    fn bounds_payload_format_dimensions_and_source_scope() {
        let project = Fixture::new();
        let other = Fixture::new();
        assert!(source_identity(&project.0, &other.source(), 256).is_err());
        assert!(source_identity(&project.0, &project.source(), 128).is_err());
        assert!(validate_image(&vec![0; MAX_PREVIEW_BYTES + 1], 256).is_err());
        assert!(validate_image(b"GIF89a", 256).is_err());
        assert!(validate_image(&png(512, 1), 256).is_err());
        let directory = ensure_cache_directory(&project.0).unwrap();
        fs::write(directory.join("source.png"), b"not-original").unwrap();
        assert!(source_identity(&project.0, &directory.join("source.png"), 256).is_err());
    }

    #[test]
    fn cache_folder_preserves_existing_files_and_is_hidden_on_windows() {
        let project = Fixture::new();
        let directory = ensure_cache_directory(&project.0).unwrap();
        assert_eq!(directory.file_name().unwrap(), ".thumbnail");
        fs::write(directory.join("keep.txt"), b"user-file").unwrap();
        let identity = source_identity(&project.0, &project.source(), 256).unwrap();
        write_cache(
            &project.0,
            &project.source(),
            256,
            &hex(&identity.version),
            &png(32, 32),
        )
        .unwrap();
        assert_eq!(fs::read(directory.join("keep.txt")).unwrap(), b"user-file");
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_ne!(fs::metadata(directory).unwrap().file_attributes() & 0x2, 0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_sources_cache_directories_and_cache_entries() {
        use std::os::unix::fs::symlink;
        let project = Fixture::new();
        let other = Fixture::new();
        symlink(other.source(), project.0.join("link.png")).unwrap();
        assert!(source_identity(&project.0, &project.0.join("link.png"), 256).is_err());
        symlink(&other.0, project.0.join(CACHE_DIRECTORY)).unwrap();
        assert!(ensure_cache_directory(&project.0).is_err());
    }
}
