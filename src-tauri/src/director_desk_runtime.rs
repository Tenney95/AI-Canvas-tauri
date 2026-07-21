use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
use tar::Archive;
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Emitter, Manager, Runtime, UriSchemeContext,
};
use url::Url;

const RELEASE_MANIFEST_JSON: &str = include_str!("../../scripts/director-desk-release.json");
const RUNTIME_DIRECTORY: &str = "director-desk";
const RELEASE_METADATA_FILE: &str = "director-desk-release.json";
const INSTALL_MARKER_FILE: &str = ".ai-canvas-director-desk.json";
const PROGRESS_EVENT: &str = "director-desk:install-progress";
const MAX_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 300 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const FREE_SPACE_RESERVE: u64 = 64 * 1024 * 1024;
const DOWNLOAD_BUFFER_SIZE: usize = 1024 * 1024;

static INSTALLING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectorDeskReleaseManifest {
    schema_version: u32,
    repository: String,
    version: String,
    artifact: String,
    url: String,
    sha256: String,
    protocol: String,
    download_bytes: u64,
    expanded_bytes: u64,
}

#[derive(Deserialize)]
struct DirectorDeskReleaseMetadata {
    name: String,
    version: String,
    protocol: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorDeskRuntimeStatus {
    installed: bool,
    installing: bool,
    version: String,
    download_bytes: u64,
    installed_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectorDeskInstallProgress {
    stage: &'static str,
    transferred_bytes: u64,
    total_bytes: u64,
}

fn release_manifest() -> Result<DirectorDeskReleaseManifest, String> {
    let manifest: DirectorDeskReleaseManifest = serde_json::from_str(RELEASE_MANIFEST_JSON)
        .map_err(|error| format!("解析导演台发布清单失败: {error}"))?;
    if manifest.schema_version != 1
        || manifest.repository != "Tenney95/3d-director-desk"
        || manifest.version.trim().is_empty()
        || manifest.protocol != "tauri-event-v1"
        || manifest.sha256.len() != 64
        || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || manifest.download_bytes > MAX_ARCHIVE_BYTES
        || manifest.expanded_bytes > MAX_EXPANDED_BYTES
    {
        return Err("导演台发布清单字段无效".to_string());
    }
    let url = Url::parse(&manifest.url).map_err(|error| format!("导演台下载地址无效: {error}"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.path_segments().and_then(Iterator::last) != Some(manifest.artifact.as_str())
    {
        return Err("导演台下载地址必须指向固定 GitHub Release 产物".to_string());
    }
    Ok(manifest)
}

fn runtime_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(RUNTIME_DIRECTORY))
        .map_err(|error| format!("读取应用本地数据目录失败: {error}"))
}

fn version_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let manifest = release_manifest()?;
    Ok(runtime_root(app)?.join(manifest.version))
}

fn validate_installed_directory(directory: &Path, manifest: &DirectorDeskReleaseManifest) -> bool {
    if !directory.join("index.html").is_file() {
        return false;
    }
    let Ok(metadata_text) = fs::read_to_string(directory.join(RELEASE_METADATA_FILE)) else {
        return false;
    };
    let Ok(metadata) = serde_json::from_str::<DirectorDeskReleaseMetadata>(&metadata_text) else {
        return false;
    };
    metadata.name == "3d-director-desk"
        && metadata.version == manifest.version
        && metadata.protocol == manifest.protocol
}

fn runtime_status<R: Runtime>(app: &AppHandle<R>) -> Result<DirectorDeskRuntimeStatus, String> {
    let manifest = release_manifest()?;
    let directory = runtime_root(app)?.join(&manifest.version);
    let installed = validate_installed_directory(&directory, &manifest);
    Ok(DirectorDeskRuntimeStatus {
        installed,
        installing: INSTALLING.load(Ordering::Acquire),
        version: manifest.version,
        download_bytes: manifest.download_bytes,
        installed_bytes: if installed {
            manifest.expanded_bytes
        } else {
            0
        },
    })
}

#[tauri::command]
pub fn director_desk_runtime_status(app: AppHandle) -> Result<DirectorDeskRuntimeStatus, String> {
    runtime_status(&app)
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    stage: &'static str,
    transferred_bytes: u64,
    total_bytes: u64,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        DirectorDeskInstallProgress {
            stage,
            transferred_bytes,
            total_bytes,
        },
    );
}

fn ensure_not_cancelled() -> Result<(), String> {
    if CANCELLED.load(Ordering::Acquire) {
        Err("导演台下载已取消".to_string())
    } else {
        Ok(())
    }
}

fn ensure_free_space(
    directory: &Path,
    manifest: &DirectorDeskReleaseManifest,
) -> Result<(), String> {
    let available = fs2::available_space(directory)
        .map_err(|error| format!("读取导演台目标磁盘空间失败: {error}"))?;
    let required = manifest
        .download_bytes
        .saturating_add(manifest.expanded_bytes)
        .saturating_add(FREE_SPACE_RESERVE);
    if available < required {
        return Err(format!(
            "磁盘空间不足，导演台安装至少需要 {required} 字节，当前可用 {available} 字节"
        ));
    }
    Ok(())
}

fn download_archive<R: Runtime>(
    app: &AppHandle<R>,
    manifest: &DirectorDeskReleaseManifest,
    destination: &Path,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("AI-Canvas/director-desk-runtime")
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建导演台下载客户端失败: {error}"))?;
    let mut response = client
        .get(&manifest.url)
        .send()
        .map_err(|error| format!("下载导演台失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载导演台失败: HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ARCHIVE_BYTES)
    {
        return Err("导演台下载包超过 100 MB 限制".to_string());
    }

    let mut output = File::create(destination)
        .map_err(|error| format!("创建导演台临时下载文件失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_SIZE];
    let mut downloaded = 0_u64;
    loop {
        ensure_not_cancelled()?;
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("读取导演台下载数据失败: {error}"))?;
        if read == 0 {
            break;
        }
        downloaded = downloaded.saturating_add(read as u64);
        if downloaded > MAX_ARCHIVE_BYTES {
            return Err("导演台下载包超过 100 MB 限制".to_string());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入导演台下载文件失败: {error}"))?;
        hasher.update(&buffer[..read]);
        emit_progress(app, "downloading", downloaded, manifest.download_bytes);
    }
    output
        .sync_all()
        .map_err(|error| format!("同步导演台下载文件失败: {error}"))?;

    ensure_not_cancelled()?;
    emit_progress(app, "verifying", downloaded, downloaded.max(1));
    let digest = format!("{:x}", hasher.finalize());
    if digest != manifest.sha256.to_ascii_lowercase() {
        return Err("导演台下载包 SHA-256 校验失败".to_string());
    }
    Ok(())
}

fn normalize_archive_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    if text.contains('\\') {
        return Err(format!("导演台归档包含不安全路径: {text}"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("导演台归档包含不安全路径: {text}"));
            }
        }
    }
    Ok(normalized)
}

fn extract_archive<R: Runtime>(
    app: &AppHandle<R>,
    manifest: &DirectorDeskReleaseManifest,
    archive_path: &Path,
    staging_directory: &Path,
) -> Result<(), String> {
    let archive_file =
        File::open(archive_path).map_err(|error| format!("打开导演台下载包失败: {error}"))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("读取导演台归档失败: {error}"))?;
    let mut entry_count = 0_usize;
    let mut expanded_bytes = 0_u64;

    for item in entries {
        ensure_not_cancelled()?;
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err("导演台归档文件数量超过限制".to_string());
        }
        let mut entry = item.map_err(|error| format!("读取导演台归档项失败: {error}"))?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("导演台归档包含不允许的链接或设备文件".to_string());
        }
        let raw_path = entry
            .path()
            .map_err(|error| format!("读取导演台归档路径失败: {error}"))?;
        let relative_path = normalize_archive_path(&raw_path)?;
        if relative_path.as_os_str().is_empty() {
            continue;
        }
        if entry_type.is_file() {
            expanded_bytes = expanded_bytes.saturating_add(entry.header().size().unwrap_or(0));
            if expanded_bytes > MAX_EXPANDED_BYTES {
                return Err("导演台归档展开后超过 300 MB 限制".to_string());
            }
        }
        let destination = staging_directory.join(relative_path);
        entry
            .unpack(&destination)
            .map_err(|error| format!("解压导演台资源失败: {error}"))?;
        emit_progress(app, "extracting", expanded_bytes, manifest.expanded_bytes);
    }
    Ok(())
}

fn rename_directory_with_retry(source: &Path, destination: &Path) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..8 {
        match fs::rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(80 * (attempt + 1)));
            }
        }
    }
    Err(format!(
        "切换导演台版本目录失败: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_default()
    ))
}

fn write_install_marker(
    staging_directory: &Path,
    manifest: &DirectorDeskReleaseManifest,
) -> Result<(), String> {
    let marker = serde_json::json!({
        "version": manifest.version,
        "sha256": manifest.sha256,
        "repository": manifest.repository,
        "protocol": manifest.protocol,
    });
    fs::write(
        staging_directory.join(INSTALL_MARKER_FILE),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&marker).unwrap_or_default()
        ),
    )
    .map_err(|error| format!("写入导演台安装标记失败: {error}"))
}

fn prune_old_versions(root: &Path, current_version: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut old_versions = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| {
            let name = entry.file_name();
            let text = name.to_string_lossy();
            text != current_version && !text.starts_with('.')
        })
        .collect::<Vec<_>>();
    old_versions.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok(),
        )
    });
    for entry in old_versions.into_iter().skip(1) {
        let _ = fs::remove_dir_all(entry.path());
    }
}

fn install_runtime<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let manifest = release_manifest()?;
    let root = runtime_root(app)?;
    fs::create_dir_all(&root).map_err(|error| format!("创建导演台运行目录失败: {error}"))?;
    ensure_free_space(&root, &manifest)?;
    let target_directory = root.join(&manifest.version);
    if validate_installed_directory(&target_directory, &manifest) {
        return Ok(());
    }

    let archive_path = root.join(format!(".{}.download", manifest.artifact));
    let staging_directory = root.join(format!(
        ".install-{}-{}",
        manifest.version,
        std::process::id()
    ));
    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir_all(&staging_directory);
    fs::create_dir_all(&staging_directory)
        .map_err(|error| format!("创建导演台安装临时目录失败: {error}"))?;

    let result = (|| {
        download_archive(app, &manifest, &archive_path)?;
        extract_archive(app, &manifest, &archive_path, &staging_directory)?;
        ensure_not_cancelled()?;
        if !validate_installed_directory(&staging_directory, &manifest) {
            return Err("导演台发布包缺少匹配的入口或协议元数据".to_string());
        }
        write_install_marker(&staging_directory, &manifest)?;
        if target_directory.exists() {
            fs::remove_dir_all(&target_directory)
                .map_err(|error| format!("清理无效导演台版本失败: {error}"))?;
        }
        rename_directory_with_retry(&staging_directory, &target_directory)?;
        prune_old_versions(&root, &manifest.version);
        emit_progress(
            app,
            "complete",
            manifest.expanded_bytes,
            manifest.expanded_bytes,
        );
        Ok(())
    })();

    let _ = fs::remove_file(&archive_path);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging_directory);
    }
    result
}

#[tauri::command]
pub async fn install_director_desk_runtime(
    app: AppHandle,
) -> Result<DirectorDeskRuntimeStatus, String> {
    if INSTALLING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("导演台正在下载，请勿重复启动".to_string());
    }
    CANCELLED.store(false, Ordering::Release);
    let worker_app = app.clone();
    let worker_result =
        tauri::async_runtime::spawn_blocking(move || install_runtime(&worker_app)).await;
    INSTALLING.store(false, Ordering::Release);
    CANCELLED.store(false, Ordering::Release);
    let result = worker_result.map_err(|error| format!("导演台安装任务执行失败: {error}"))?;
    result?;
    runtime_status(&app)
}

#[tauri::command]
pub fn cancel_director_desk_install() -> Result<(), String> {
    if INSTALLING.load(Ordering::Acquire) {
        CANCELLED.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn remove_director_desk_runtime(app: AppHandle) -> Result<DirectorDeskRuntimeStatus, String> {
    if INSTALLING.load(Ordering::Acquire) {
        return Err("导演台正在下载，取消完成后才能删除".to_string());
    }
    let root = runtime_root(&app)?;
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|error| format!("删除导演台本地资源失败: {error}"))?;
    }
    runtime_status(&app)
}

fn percent_decode_path(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("导演台资源路径包含无效转义".to_string());
            }
            let high = (bytes[index + 1] as char)
                .to_digit(16)
                .ok_or_else(|| "导演台资源路径包含无效转义".to_string())?;
            let low = (bytes[index + 2] as char)
                .to_digit(16)
                .ok_or_else(|| "导演台资源路径包含无效转义".to_string())?;
            decoded.push(((high << 4) | low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "导演台资源路径不是 UTF-8".to_string())
}

fn normalize_request_path(value: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode_path(value)?;
    if decoded.contains('\\') || decoded.contains('\0') {
        return Err("导演台资源路径无效".to_string());
    }
    let trimmed = decoded.trim_start_matches('/');
    let source = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };
    let mut normalized = PathBuf::new();
    for component in Path::new(source).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("导演台资源路径越界".to_string());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("导演台资源路径为空".to_string());
    }
    Ok(normalized)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "txt" | "obj" | "mtl" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn parse_byte_range(value: &str, total: u64) -> Result<Option<(u64, u64)>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    let range = value
        .strip_prefix("bytes=")
        .ok_or_else(|| "导演台资源 Range 格式无效".to_string())?;
    if range.contains(',') || total == 0 {
        return Err("导演台资源只支持单段 Range".to_string());
    }
    let (start_text, end_text) = range
        .split_once('-')
        .ok_or_else(|| "导演台资源 Range 格式无效".to_string())?;
    if start_text.is_empty() {
        return Err("导演台资源不支持后缀 Range".to_string());
    }
    let start = start_text
        .parse::<u64>()
        .map_err(|_| "导演台资源 Range 起点无效".to_string())?;
    let end = if end_text.is_empty() {
        total - 1
    } else {
        end_text
            .parse::<u64>()
            .map_err(|_| "导演台资源 Range 终点无效".to_string())?
            .min(total - 1)
    };
    if start >= total || start > end {
        return Err("导演台资源 Range 超出文件范围".to_string());
    }
    Ok(Some((start, end)))
}

fn protocol_error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle_protocol<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if context.webview_label() != "director-desk" {
        return protocol_error(StatusCode::FORBIDDEN, "forbidden");
    }
    let relative_path = match normalize_request_path(request.uri().path()) {
        Ok(path) => path,
        Err(error) => return protocol_error(StatusCode::BAD_REQUEST, &error),
    };
    let root = match version_directory(context.app_handle()) {
        Ok(path) => path,
        Err(error) => return protocol_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    let canonical_root = match root.canonicalize() {
        Ok(path) => path,
        Err(_) => return protocol_error(StatusCode::NOT_FOUND, "director desk is not installed"),
    };
    let candidate = root.join(&relative_path);
    let canonical_candidate = match candidate.canonicalize() {
        Ok(path) if path.starts_with(&canonical_root) && path.is_file() => path,
        _ => return protocol_error(StatusCode::NOT_FOUND, "asset not found"),
    };
    let mut file = match File::open(&canonical_candidate) {
        Ok(file) => file,
        Err(_) => return protocol_error(StatusCode::NOT_FOUND, "asset not found"),
    };
    let total = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => {
            return protocol_error(StatusCode::INTERNAL_SERVER_ERROR, "asset metadata failed")
        }
    };
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let requested_range = match parse_byte_range(range_header, total) {
        Ok(range) => range,
        Err(error) => return protocol_error(StatusCode::RANGE_NOT_SATISFIABLE, &error),
    };
    let (status, start, end) = requested_range
        .map(|(start, end)| (StatusCode::PARTIAL_CONTENT, start, end))
        .unwrap_or((StatusCode::OK, 0, total.saturating_sub(1)));
    let length = if total == 0 { 0 } else { end - start + 1 };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return protocol_error(StatusCode::INTERNAL_SERVER_ERROR, "asset seek failed");
    }
    let mut body = Vec::with_capacity(length.min(usize::MAX as u64) as usize);
    if file.take(length).read_to_end(&mut body).is_err() {
        return protocol_error(StatusCode::INTERNAL_SERVER_ERROR, "asset read failed");
    }

    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type_for_path(&relative_path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(
            header::CACHE_CONTROL,
            if relative_path == Path::new("index.html") {
                "no-cache"
            } else {
                "public, max-age=31536000, immutable"
            },
        );
    if requested_range.is_some() {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    response
        .body(body)
        .unwrap_or_else(|_| protocol_error(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_safe_protocol_paths() {
        assert_eq!(
            normalize_request_path("/assets/main%20bundle.js").unwrap(),
            PathBuf::from("assets/main bundle.js")
        );
    }

    #[test]
    fn rejects_protocol_path_traversal() {
        assert!(normalize_request_path("/../config.json").is_err());
        assert!(normalize_request_path("/%2e%2e/config.json").is_err());
        assert!(normalize_request_path("/assets\\..\\config.json").is_err());
    }

    #[test]
    fn maps_runtime_content_types() {
        assert_eq!(
            content_type_for_path(Path::new("index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for_path(Path::new("main.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type_for_path(Path::new("scene.glb")),
            "model/gltf-binary"
        );
    }

    #[test]
    fn parses_bounded_byte_ranges() {
        assert_eq!(
            parse_byte_range("bytes=10-19", 100).unwrap(),
            Some((10, 19))
        );
        assert_eq!(parse_byte_range("bytes=90-", 100).unwrap(), Some((90, 99)));
        assert!(parse_byte_range("bytes=100-101", 100).is_err());
        assert!(parse_byte_range("items=0-1", 100).is_err());
    }

    #[test]
    fn validates_the_pinned_release_manifest() {
        let manifest = release_manifest().unwrap();
        assert_eq!(manifest.version, "0.3.1");
        assert_eq!(manifest.protocol, "tauri-event-v1");
        assert!(manifest.download_bytes < MAX_ARCHIVE_BYTES);
    }
}
