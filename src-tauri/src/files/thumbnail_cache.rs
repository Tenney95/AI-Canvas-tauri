//! 项目内可重建的缩略图缓存；原图读取授权与派生文件写入始终在原生侧复核。

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime, Webview};
use tauri::ipc::{InvokeBody, Request};

use crate::path_policy::{
    authorize_existing_plain_directory, authorize_existing_plain_file, ensure_trusted_caller,
};

const CACHE_DIRECTORY: &str = ".thumbnail";
const CACHE_MAGIC: &[u8; 8] = b"ACTHMB01";
const CACHE_HEADER_BYTES: usize = 8 + 32 + 4 + 4 + 32;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const WRITE_METADATA_HEADER: &str = "x-aic-thumbnail-meta";
const MAX_WRITE_METADATA_BYTES: usize = 1024 * 1024;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThumbnailWriteMetadata {
    project_dir: String,
    source_path: String,
    max_edge: u32,
    source_version: String,
}

fn thumbnail_write_input<'a>(
    body: &'a InvokeBody,
    headers: &tauri::http::HeaderMap,
) -> Result<(ThumbnailWriteMetadata, &'a [u8]), String> {
    let bytes = match body {
        InvokeBody::Raw(bytes) if !bytes.is_empty() && bytes.len() <= MAX_PREVIEW_BYTES => bytes.as_slice(),
        _ => return Err("缩略图写入格式无效或超过 4 MiB".into()),
    };
    let values = headers.get_all(WRITE_METADATA_HEADER);
    let mut values = values.iter();
    let encoded = values.next().ok_or("缩略图写入元数据无效")?;
    if values.next().is_some() || encoded.as_bytes().is_empty() || encoded.as_bytes().len() > MAX_WRITE_METADATA_BYTES {
        return Err("缩略图写入元数据无效".into());
    }
    let decoded = BASE64_STANDARD.decode(encoded.as_bytes()).map_err(|_| "缩略图写入元数据无效")?;
    let metadata: ThumbnailWriteMetadata = serde_json::from_slice(&decoded).map_err(|_| "缩略图写入元数据无效")?;
    validate_edge(metadata.max_edge)?;
    if metadata.source_version.len() != 64 || !metadata.source_version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("缩略图写入参数无效".into());
    }
    Ok((metadata, bytes))
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

pub(crate) fn derived_source_version(
    root: &Path,
    source: &Path,
    max_source_bytes: u64,
) -> Result<(String, [u8; 32]), String> {
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
    if metadata.len() == 0 || metadata.len() > max_source_bytes {
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
    Ok((relative_text, version.finalize().into()))
}

fn source_identity(root: &Path, source: &Path, max_edge: u32) -> Result<SourceIdentity, String> {
    validate_edge(max_edge)?;
    let (relative_text, version) = derived_source_version(root, source, MAX_SOURCE_BYTES)?;
    let mut name = Sha256::new();
    name.update(b"canvas-thumbnail-webp85-v1\0");
    name.update(relative_text.as_bytes());
    name.update([0]);
    name.update(max_edge.to_le_bytes());
    Ok(SourceIdentity {
        version,
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

fn cache_header(identity: &SourceIdentity, width: u32, height: u32, bytes: &[u8]) -> [u8; CACHE_HEADER_BYTES] {
    let mut header = [0_u8; CACHE_HEADER_BYTES];
    header[..8].copy_from_slice(CACHE_MAGIC);
    header[8..40].copy_from_slice(&identity.version);
    header[40..44].copy_from_slice(&width.to_le_bytes());
    header[44..48].copy_from_slice(&height.to_le_bytes());
    header[48..80].copy_from_slice(&Sha256::digest(bytes));
    header
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
    let mut header = [0_u8; CACHE_HEADER_BYTES];
    file.read_exact(&mut header).ok()?;
    if &header[..8] != CACHE_MAGIC || header[8..40] != identity.version {
        return None;
    }
    let payload_size = size as usize - CACHE_HEADER_BYTES;
    let mut bytes = Vec::with_capacity(payload_size);
    Read::by_ref(&mut file)
        .take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() != payload_size {
        return None;
    }
    let width = u32::from_le_bytes(header[40..44].try_into().ok()?);
    let height = u32::from_le_bytes(header[44..48].try_into().ok()?);
    if header[48..80] != Sha256::digest(&bytes)[..]
        || validate_image(&bytes, max_edge).ok()? != (width, height)
    {
        return None;
    }
    Some((bytes, width, height))
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

fn validate_cache_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        return Err("派生缓存文件名无效".into());
    }
    Ok(())
}

pub(crate) fn read_cache_file(root: &Path, name: &str, max_bytes: usize) -> Option<Vec<u8>> {
    validate_cache_name(name).ok()?;
    let path = root.join(CACHE_DIRECTORY).join(name);
    validate_descendant(root, &path, false).ok()?;
    #[cfg(windows)]
    windows_files::hide(&root.join(CACHE_DIRECTORY)).ok()?;
    let file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 || size > max_bytes as u64 {
        return None;
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() == size as usize).then_some(bytes)
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
    let header = cache_header(&identity, width, height, bytes);
    publish_cache_parts(
        root,
        &identity.cache_name,
        &[header.as_slice(), bytes],
        || Ok(source_identity(root, source, max_edge)?.version == identity.version),
    )
}

/// 仅供原生派生服务调用；调用方复核源版本，目录与目标仍在这里逐层拒绝链接。
pub(crate) fn publish_cache_file(
    root: &Path,
    name: &str,
    bytes: &[u8],
    still_current: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    publish_cache_parts(root, name, &[bytes], still_current)
}

fn publish_cache_parts(
    root: &Path,
    name: &str,
    parts: &[&[u8]],
    still_current: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    validate_cache_name(name)?;
    let directory = ensure_cache_directory(root)?;
    let destination = directory.join(name);
    if destination.symlink_metadata().is_ok() {
        validate_descendant(root, &destination, false)?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(".{name}-{nonce}-{sequence}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建缩略图临时文件")?;
    let result = (|| {
        for bytes in parts {
            file.write_all(bytes).map_err(|_| "缩略图写入失败")?;
        }
        file.sync_all().map_err(|_| "缩略图写入失败")?;
        drop(file);
        // 编码或落盘期间原图可能已被编辑，旧结果不可取代当前版本。
        if !still_current()? {
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
    request: Request<'_>,
) -> Result<bool, String> {
    ensure_main(&webview)?;
    let (metadata, bytes) = thumbnail_write_input(request.body(), request.headers())?;
    let bytes = bytes.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let (root, source) = authorized_source(&app, &metadata.project_dir, &metadata.source_path)?;
        write_cache(&root, &source, metadata.max_edge, &metadata.source_version, &bytes)
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

    fn legacy_cache(identity: &SourceIdentity, width: u32, height: u32, bytes: &[u8]) -> Vec<u8> {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(b"ACTHMB01");
        encoded.extend_from_slice(&identity.version);
        encoded.extend_from_slice(&width.to_le_bytes());
        encoded.extend_from_slice(&height.to_le_bytes());
        encoded.extend_from_slice(&Sha256::digest(bytes));
        encoded.extend_from_slice(bytes);
        encoded
    }

    fn write_metadata() -> serde_json::Value {
        serde_json::json!({ "projectDir": "G:/项目/中文 #1", "sourcePath": "G:/项目/中文 #1/源图.png",
            "maxEdge": 512, "sourceVersion": "a".repeat(64) })
    }

    fn metadata_headers(metadata: &serde_json::Value) -> tauri::http::HeaderMap {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(WRITE_METADATA_HEADER,
            BASE64_STANDARD.encode(serde_json::to_vec(metadata).unwrap()).parse().unwrap());
        headers
    }

    #[test]
    fn raw_write_metadata_preserves_unicode_paths_and_binary_bytes() {
        let metadata = write_metadata();
        let mut headers = metadata_headers(&metadata);
        headers.insert("origin", "tauri://localhost".parse().unwrap());
        let expected = png(32, 32);
        let body = InvokeBody::Raw(expected.clone());
        let (input, bytes) = thumbnail_write_input(&body, &headers).unwrap();
        assert_eq!(input.project_dir, "G:/项目/中文 #1");
        assert_eq!(input.source_path, "G:/项目/中文 #1/源图.png");
        assert_eq!(input.max_edge, 512);
        assert_eq!(input.source_version, "a".repeat(64));
        assert_eq!(bytes, expected);
    }

    #[test]
    fn raw_write_rejects_json_empty_and_oversized_bodies_before_metadata() {
        let headers = metadata_headers(&write_metadata());
        for body in [InvokeBody::Json(serde_json::json!({ "bytes": [1, 2, 3] })), InvokeBody::Raw(Vec::new())] {
            assert!(thumbnail_write_input(&body, &headers).is_err());
        }
        let mut oversized = InvokeBody::Raw(vec![0; MAX_PREVIEW_BYTES + 1]);
        assert!(thumbnail_write_input(&oversized, &tauri::http::HeaderMap::new()).err().unwrap().contains("4 MiB"));
        if let InvokeBody::Raw(bytes) = &mut oversized { bytes.pop(); }
        assert!(thumbnail_write_input(&oversized, &headers).is_ok());
    }

    #[test]
    fn raw_write_rejects_missing_duplicate_and_invalid_metadata() {
        let body = InvokeBody::Raw(vec![1]);
        assert!(thumbnail_write_input(&body, &tauri::http::HeaderMap::new()).is_err());
        let mut duplicate = metadata_headers(&write_metadata());
        let encoded = duplicate[WRITE_METADATA_HEADER].clone();
        duplicate.append(WRITE_METADATA_HEADER, encoded);
        assert!(thumbnail_write_input(&body, &duplicate).is_err());
        for encoded in ["".to_owned(), "%%%".to_owned(), BASE64_STANDARD.encode(b"not json"),
            BASE64_STANDARD.encode(b"\xff\xfe")] {
            let mut headers = tauri::http::HeaderMap::new();
            headers.insert(WRITE_METADATA_HEADER, encoded.parse().unwrap());
            assert!(thumbnail_write_input(&body, &headers).is_err());
        }
        let mut unknown = write_metadata(); unknown["extra"] = serde_json::json!(true);
        let mut missing = write_metadata(); missing.as_object_mut().unwrap().remove("projectDir");
        let mut edge = write_metadata(); edge["maxEdge"] = serde_json::json!(128);
        let mut version = write_metadata(); version["sourceVersion"] = serde_json::json!("g".repeat(64));
        let mut short_version = write_metadata(); short_version["sourceVersion"] = serde_json::json!("a".repeat(63));
        for metadata in [unknown, missing, edge, version, short_version] {
            assert!(thumbnail_write_input(&body, &metadata_headers(&metadata)).is_err());
        }
    }

    #[test]
    fn raw_write_limits_the_encoded_metadata_header_separately_from_image_bytes() {
        let body = InvokeBody::Raw(vec![1]);
        let mut json = serde_json::to_vec(&write_metadata()).unwrap();
        json.resize(MAX_WRITE_METADATA_BYTES / 4 * 3, b' ');
        let mut encoded = BASE64_STANDARD.encode(json);
        assert_eq!(encoded.len(), MAX_WRITE_METADATA_BYTES);
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(WRITE_METADATA_HEADER, encoded.parse().unwrap());
        assert!(thumbnail_write_input(&body, &headers).is_ok());
        encoded.push('A');
        headers.insert(WRITE_METADATA_HEADER, encoded.parse().unwrap());
        assert!(thumbnail_write_input(&body, &headers).is_err());
    }

    #[test]
    fn writes_header_and_payload_with_the_unchanged_v1_format() {
        let project = Fixture::new();
        let identity = source_identity(&project.0, &project.source(), 256).unwrap();
        let bytes = png(32, 32);
        assert!(write_cache(&project.0, &project.source(), 256, &hex(&identity.version), &bytes).unwrap());
        let path = project.0.join(CACHE_DIRECTORY).join(&identity.cache_name);
        assert_eq!(fs::read(path).unwrap(), legacy_cache(&identity, 32, 32, &bytes));
        assert_eq!(read_cache(&project.0, &identity, 256).unwrap(), (bytes, 32, 32));
    }

    #[test]
    fn publishes_all_parts_and_keeps_the_previous_file_when_stale() {
        let project = Fixture::new();
        assert!(publish_cache_parts(&project.0, "parts.cache", &[b"header".as_slice(), b"".as_slice(), b"payload".as_slice()], || Ok(true)).unwrap());
        let directory = project.0.join(CACHE_DIRECTORY);
        assert_eq!(fs::read(directory.join("parts.cache")).unwrap(), b"headerpayload");
        assert!(!publish_cache_parts(&project.0, "parts.cache", &[b"old".as_slice(), b"result".as_slice()], || Ok(false)).unwrap());
        assert_eq!(fs::read(directory.join("parts.cache")).unwrap(), b"headerpayload");
        assert!(publish_cache_file(&project.0, "sprite.json", b"single part", || Ok(true)).unwrap());
        assert_eq!(fs::read(directory.join("sprite.json")).unwrap(), b"single part");
        assert!(fs::read_dir(directory).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
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
    fn cache_payload_rejects_truncated_trailing_and_oversized_content() {
        let project = Fixture::new();
        let identity = source_identity(&project.0, &project.source(), 256).unwrap();
        let bytes = png(32, 32);
        let encoded = legacy_cache(&identity, 32, 32, &bytes);
        let directory = ensure_cache_directory(&project.0).unwrap();
        let path = directory.join(&identity.cache_name);
        for length in [7, CACHE_HEADER_BYTES - 1, encoded.len() - 1] {
            fs::write(&path, &encoded[..length]).unwrap();
            assert!(read_cache(&project.0, &identity, 256).is_none());
        }
        let mut trailing = encoded.clone();
        trailing.push(0);
        fs::write(&path, trailing).unwrap();
        assert!(read_cache(&project.0, &identity, 256).is_none());
        File::create(&path).unwrap().set_len((CACHE_HEADER_BYTES + MAX_PREVIEW_BYTES + 1) as u64).unwrap();
        assert!(read_cache(&project.0, &identity, 256).is_none());
        fs::write(&path, encoded).unwrap();
        let (cached, width, height) = read_cache(&project.0, &identity, 256).unwrap();
        assert_eq!(cached, bytes);
        assert_eq!((width, height), (32, 32));
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
