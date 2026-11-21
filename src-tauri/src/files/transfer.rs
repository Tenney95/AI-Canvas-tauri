//! 支持取消、进度事件、磁盘空间检查和临时文件原子落盘的长时间文件传输服务。

use reqwest::blocking::Response;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    future::Future,
    io::{self, BufWriter, Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Webview};

use crate::path_policy::{authorize_path, ensure_trusted_caller, PathAccess};

const BUFFER_SIZE: usize = 1024 * 1024;
const MIN_FREE_SPACE_RESERVE: u64 = 64 * 1024 * 1024;
const PROGRESS_EVENT: &str = "file-transfer-progress";
const MEDIA_DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(180);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const GENERATED_IMAGE_MAX_BYTES: u64 = 32 * 1024 * 1024;
const GENERATED_IMAGE_MAX_PIXELS: u64 = 64 * 1024 * 1024;

static CANCELLED_TRANSFERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_transfers() -> &'static Mutex<HashSet<String>> {
    CANCELLED_TRANSFERS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTransferProgress {
    task_id: String,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferResult {
    pub(crate) path: String,
    pub(crate) total_bytes: u64,
    pub(crate) content_type: Option<String>,
}

pub(crate) struct DownloadMetadata {
    pub(crate) content_length: Option<u64>,
    pub(crate) content_type: Option<String>,
}

/// 仅用于本次下载；不得持久化或写入日志。初始请求必须与绑定来源同源。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaDownloadAccess {
    origin: String,
    headers: HashMap<String, String>,
    query_auth_name: Option<String>,
}

pub(crate) fn is_cancelled(task_id: &str) -> Result<bool, String> {
    cancelled_transfers()
        .lock()
        .map(|items| items.contains(task_id))
        .map_err(|_| "读取文件传输取消状态失败".to_string())
}

pub(crate) fn clear_cancelled(task_id: &str) {
    if let Ok(mut items) = cancelled_transfers().lock() {
        items.remove(task_id);
    }
}

fn required_free_space(total_bytes: u64) -> u64 {
    total_bytes.saturating_add((total_bytes / 20).max(MIN_FREE_SPACE_RESERVE))
}

pub(crate) fn ensure_disk_space(parent: &Path, total_bytes: Option<u64>) -> Result<(), String> {
    let available =
        fs2::available_space(parent).map_err(|e| format!("无法读取目标磁盘可用空间: {e}"))?;
    let required = total_bytes
        .map(required_free_space)
        .unwrap_or(MIN_FREE_SPACE_RESERVE);
    if available < required {
        return Err(format!(
            "目标磁盘空间不足，需要至少 {required} 字节，当前可用 {available} 字节"
        ));
    }
    Ok(())
}

fn temporary_path(destination: &Path, task_id: &str) -> Result<PathBuf, String> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "目标文件名无效".to_string())?;
    Ok(destination.with_file_name(format!(".{file_name}.{task_id}.part")))
}

fn validate_transfer_size(
    transferred_bytes: u64,
    expected_bytes: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    if let Some(max_bytes) = max_bytes {
        if transferred_bytes > max_bytes {
            return Err(format!("下载文件超过允许的体积上限 {max_bytes} 字节"));
        }
    }
    if let Some(expected_bytes) = expected_bytes {
        if transferred_bytes != expected_bytes {
            return Err(format!(
                "下载不完整: 期望 {expected_bytes} 字节，实际 {transferred_bytes} 字节"
            ));
        }
    }
    Ok(())
}

/// 流式暂存、校验及独占发布；内部调用方必须先完成目标路径授权。
pub(crate) fn stream_to_file<R, C, P, V>(
    task_id: &str,
    reader: &mut R,
    destination: &Path,
    expected_bytes: Option<u64>,
    disk_space_bytes: Option<u64>,
    max_bytes: Option<u64>,
    mut cancelled: C,
    mut on_progress: P,
    validate_temp: V,
) -> Result<u64, String>
where
    R: Read,
    C: FnMut() -> Result<bool, String>,
    P: FnMut(u64),
    V: FnOnce(&Path) -> Result<(), String>,
{
    let parent = destination
        .parent()
        .ok_or_else(|| "目标文件没有父目录".to_string())?;
    ensure_disk_space(parent, disk_space_bytes)?;

    let temp_path = temporary_path(destination, task_id)?;
    let mut temporary_created = false;
    let transfer_result = (|| {
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        let output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| format!("创建临时文件失败（禁止覆盖）: {e}"))?;
        temporary_created = true;
        let buffer_size = expected_bytes.map_or(BUFFER_SIZE, |bytes| bytes.clamp(1, BUFFER_SIZE as u64) as usize);
        let mut output = BufWriter::with_capacity(buffer_size, output);
        let mut buffer = vec![0_u8; buffer_size];
        let mut transferred_bytes = 0_u64;
        let mut last_progress: Option<(u64, Instant)> = None;

        let write_result = (|| {
            loop {
                if cancelled()? {
                    return Err("文件传输已取消".to_string());
                }
                let read = reader
                    .read(&mut buffer)
                    .map_err(|e| format!("读取传输数据失败: {e}"))?;
                if read == 0 {
                    break;
                }
                let next_total = transferred_bytes.saturating_add(read as u64);
                validate_transfer_size(next_total, None, max_bytes)?;
                if expected_bytes.is_some_and(|expected| next_total > expected) {
                    // 小缓冲不能把已增长的源文件逐字节读到 EOF 才发现长度不符。
                    validate_transfer_size(next_total, expected_bytes, max_bytes)?;
                }
                output
                    .write_all(&buffer[..read])
                    .map_err(|e| format!("写入目标文件失败: {e}"))?;
                transferred_bytes = next_total;
                if last_progress.is_none_or(|(_, reported_at)| reported_at.elapsed() >= PROGRESS_INTERVAL) {
                    on_progress(transferred_bytes);
                    last_progress = Some((transferred_bytes, Instant::now()));
                }
            }

            validate_transfer_size(transferred_bytes, expected_bytes, max_bytes)?;
            if cancelled()? {
                return Err("文件传输已取消".to_string());
            }
            output.flush().map_err(|e| format!("写入目标文件失败: {e}"))?;
            output.get_ref()
                .sync_all()
                .map_err(|e| format!("同步目标文件失败: {e}"))?;
            Ok::<(), String>(())
        })();
        // 失败时丢弃未写缓冲，避免 BufWriter::drop 在取消后继续刷盘；先关句柄再清理临时文件。
        let (output, _) = output.into_parts();
        drop(output);
        write_result?;
        validate_temp(&temp_path)?;
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        // Never replace another generation/grouping result that won this destination.
        // Hard-link publication is atomic; filesystems without links use exclusive creation.
        match fs::hard_link(&temp_path, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err("目标文件已存在，已拒绝覆盖".to_string());
            }
            Err(_) => {
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(destination)
                    .map_err(|e| format!("创建目标文件失败（禁止覆盖）: {e}"))?;
                let write_result = (|| {
                    let mut source = File::open(&temp_path)?;
                    std::io::copy(&mut source, &mut target)?;
                    target.sync_all()
                })();
                drop(target);
                if let Err(error) = write_result {
                    let _ = fs::remove_file(destination);
                    return Err(format!("完成目标文件写入失败: {error}"));
                }
            }
        }
        let _ = fs::remove_file(&temp_path);
        if last_progress.is_none_or(|(bytes, _)| bytes != transferred_bytes) {
            on_progress(transferred_bytes);
        }
        Ok(transferred_bytes)
    })();

    if transfer_result.is_err() && temporary_created {
        let _ = fs::remove_file(&temp_path);
    }
    transfer_result
}

pub(crate) fn download_to_file<V>(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    destination: &Path,
    max_bytes: Option<u64>,
    validate_temp: V,
) -> Result<FileTransferResult, String>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
{
    download_to_file_with_access(app, task_id, url, destination, max_bytes, None, validate_temp)
}

fn download_to_file_with_access<V>(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    destination: &Path,
    max_bytes: Option<u64>,
    access: Option<&MediaDownloadAccess>,
    validate_temp: V,
) -> Result<FileTransferResult, String>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
{
    let result = (|| {
        if is_cancelled(task_id)? {
            return Err("文件传输已取消".to_string());
        }
        if access.is_none() && crate::github_fallback::mirror_url(url).is_some() {
            let mut validate = Some(validate_temp);
            return crate::github_fallback::retry(url, |source| {
                use crate::github_fallback::Failure;
                if is_cancelled(task_id).map_err(Failure::terminal)? {
                    return Err(Failure::terminal("文件传输已取消"));
                }
                let mut reader = crate::github_fallback::get(source)?;
                let metadata = DownloadMetadata {
                    content_length: reader.response.content_length(),
                    content_type: reader.response.headers().get(reqwest::header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok()).and_then(|value| value.split(';').next()).map(str::trim).map(str::to_string),
                };
                if let (Some(size), Some(limit)) = (metadata.content_length, max_bytes) {
                    validate_transfer_size(size, None, Some(limit)).map_err(Failure::terminal)?;
                }
                let progress = |transferred_bytes| { let _ = app.emit(PROGRESS_EVENT, FileTransferProgress {
                    task_id: task_id.to_owned(), transferred_bytes, total_bytes: metadata.content_length,
                }); };
                progress(0);
                let result = stream_to_file(task_id, &mut reader, destination, metadata.content_length,
                    metadata.content_length.or(max_bytes), max_bytes, || is_cancelled(task_id), progress,
                    |path| validate.take().expect("download validator consumed once")(path, &metadata));
                result.map(|total_bytes| FileTransferResult { path: destination.to_string_lossy().into_owned(), total_bytes,
                    content_type: metadata.content_type }).map_err(|message| Failure { message, retryable: reader.network_failed })
            });
        }
        let response = fetch_media_download(url, access, || is_cancelled(task_id), MEDIA_DOWNLOAD_IDLE_TIMEOUT)?;
        download_media_response_to_file(
            task_id,
            response,
            destination,
            max_bytes,
            MEDIA_DOWNLOAD_IDLE_TIMEOUT,
            validate_temp,
            |transferred_bytes, total_bytes| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: task_id.to_string(),
                        transferred_bytes,
                        total_bytes,
                    },
                );
            },
        )
    })();
    clear_cancelled(task_id);
    result
}

fn validate_media_download_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err("媒体下载地址不安全".into());
    }
    Ok(())
}

fn media_download_headers(access: &MediaDownloadAccess) -> Result<reqwest::header::HeaderMap, String> {
    if access.headers.len() > 64 || access.headers.iter().map(|(key, value)| key.len() + value.len()).sum::<usize>() > 32 * 1024 {
        return Err("媒体下载请求头超过上限".into());
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &access.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| "媒体下载请求头无效")?;
        if matches!(name.as_str(), "host" | "content-length" | "connection" | "transfer-encoding" | "cookie" | "cookie2" | "proxy-authorization" | "proxy-connection") {
            return Err("媒体下载请求头不允许覆盖连接身份".into());
        }
        let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| "媒体下载请求头无效")?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn media_download_redirect_target(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let target = current.join(location).map_err(|_| "媒体下载重定向地址无效")?;
    validate_media_download_url(&target)?;
    if current.scheme() == "https" && target.scheme() != "https" {
        return Err("媒体下载重定向不能降低传输安全级别".into());
    }
    Ok(target)
}

fn strip_media_query_auth(url: &mut reqwest::Url, name: &str) {
    let Some(query) = url.query() else { return; };
    // 仅移除准确的鉴权字段；保留其余签名参数的原始编码、顺序与重复项。
    let parts: Vec<&str> = query.split('&').filter(|part| {
        url::form_urlencoded::parse(part.as_bytes()).next().is_none_or(|(key, _)| key != name)
    }).collect();
    let retained = parts.join("&");
    if retained != query { url.set_query(if retained.is_empty() { None } else { Some(&retained) }); }
}

/// 每次响应头或正文读取分别计时；取消会丢弃正在等待的网络 Future，不限制整个大文件的耗时。
async fn wait_media_download<T, C>(
    future: impl Future<Output = Result<T, reqwest::Error>>,
    idle_timeout: Duration,
    cancelled: &mut C,
) -> Result<T, String>
where C: FnMut() -> Result<bool, String> {
    if cancelled()? { return Err("文件传输已取消".into()); }
    tokio::pin!(future);
    let deadline = tokio::time::sleep(idle_timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result = &mut future => {
                if cancelled()? { return Err("文件传输已取消".into()); }
                return result.map_err(|error| if error.is_timeout() {
                    "媒体下载等待超时，请继续取回原结果".into()
                } else {
                    "媒体下载连接失败，请检查网络后继续取回原结果".into()
                });
            },
            _ = &mut deadline => {
                if cancelled()? { return Err("文件传输已取消".into()); }
                return Err("媒体下载等待超时，请继续取回原结果".into());
            },
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancelled()? { return Err("文件传输已取消".into()); }
            },
        }
    }
}

/// 受鉴权结果可跳到公开 CDN；离开初始来源后永久去掉全部显式请求头。
fn fetch_media_download<C>(
    url: &str,
    access: Option<&MediaDownloadAccess>,
    mut cancelled: C,
    idle_timeout: Duration,
) -> Result<reqwest::Response, String>
where C: FnMut() -> Result<bool, String> {
    let mut current = reqwest::Url::parse(url).map_err(|_| "媒体下载地址无效")?;
    validate_media_download_url(&current)?;
    let origin = current.origin();
    let headers = if let Some(access) = access {
        let bound_origin = reqwest::Url::parse(&access.origin).map_err(|_| "媒体下载来源无效")?;
        validate_media_download_url(&bound_origin)?;
        if bound_origin.origin().ascii_serialization() != access.origin || origin != bound_origin.origin() {
            return Err("媒体下载地址与厂商连接不同源".into());
        }
        if access.query_auth_name.as_ref().is_some_and(|name| name.is_empty() || name.len() > 256 || name.chars().any(char::is_control)) {
            return Err("媒体下载查询鉴权字段无效".into());
        }
        media_download_headers(access)?
    } else {
        reqwest::header::HeaderMap::new()
    };
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder().user_agent(if access.is_some() { "AI-Canvas/media-download" } else { "AI-Canvas/0.4" })
            .referer(false).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15))
            .build().map_err(|_| "创建媒体下载客户端失败")?;
        let mut include_headers = access.is_some();
        for redirect_count in 0..=10 {
            let request = client.get(current.clone());
            let response = wait_media_download(
                (if include_headers { request.headers(headers.clone()) } else { request }).send(),
                idle_timeout,
                &mut cancelled,
            ).await?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) { return Ok(response); }
            if redirect_count == 10 { return Err("媒体下载重定向次数超过上限".into()); }
            let location = response.headers().get(reqwest::header::LOCATION).and_then(|value| value.to_str().ok())
                .ok_or("媒体下载重定向缺少有效地址")?;
            let mut target = media_download_redirect_target(&current, location)?;
            include_headers &= target.origin() == origin;
            if !include_headers {
                if let Some(name) = access.and_then(|access| access.query_auth_name.as_ref()) { strip_media_query_auth(&mut target, name); }
            }
            current = target;
        }
        Err("媒体下载重定向次数超过上限".into())
    })
}

struct MediaDownloadReader<C> {
    response: reqwest::Response,
    pending: Cursor<Vec<u8>>,
    idle_timeout: Duration,
    cancelled: C,
}

impl<C> Read for MediaDownloadReader<C>
where C: FnMut() -> Result<bool, String> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() { return Ok(0); }
        if self.pending.position() < self.pending.get_ref().len() as u64 { return self.pending.read(buffer); }
        self.pending.set_position(0);
        self.pending.get_mut().clear();
        let response = &mut self.response;
        // 空 DATA 帧没有真实下载进展，跳过它们时仍沿用同一次等待期限。
        let next_bytes = async {
            loop {
                match response.chunk().await? {
                    Some(bytes) if bytes.is_empty() => continue,
                    chunk => return Ok(chunk),
                }
            }
        };
        match tauri::async_runtime::block_on(wait_media_download(next_bytes, self.idle_timeout, &mut self.cancelled)) {
            Ok(Some(bytes)) => {
                let count = buffer.len().min(bytes.len());
                buffer[..count].copy_from_slice(&bytes[..count]);
                self.pending.get_mut().extend_from_slice(&bytes[count..]);
                Ok(count)
            }
            Ok(None) => Ok(0),
            Err(error) => Err(io::Error::other(error)),
        }
    }
}

/// 模型下载一次尝试的失败类别；本地 I/O、取消与校验失败不能通过换源重试。
#[derive(Debug)]
pub(crate) struct DownloadFailure {
    pub(crate) message: String,
    pub(crate) retryable: bool,
}

impl DownloadFailure {
    fn terminal(message: impl Into<String>) -> Self {
        Self { message: message.into(), retryable: false }
    }
}

fn model_download_status(status: reqwest::StatusCode) -> Result<(), DownloadFailure> {
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(DownloadFailure::terminal("模型下载返回不完整的分段内容"));
    }
    if !status.is_success() {
        return Err(DownloadFailure {
            message: format!("模型下载返回 HTTP {}", status.as_u16()),
            // 公开模型的来源/CDN 拒绝或镜像未同步可切源；最终仍须完整内容校验。
            retryable: matches!(status.as_u16(), 403 | 404 | 410)
                || crate::github_fallback::transient_status(status.as_u16()),
        });
    }
    Ok(())
}

fn model_transfer_failure(
    network_failed: bool,
    cancelled: bool,
    validation_failed: bool,
) -> DownloadFailure {
    if cancelled {
        return DownloadFailure::terminal("文件传输已取消");
    }
    if network_failed {
        return DownloadFailure {
            message: "模型下载连接或读取中断，请检查网络连接".into(),
            retryable: true,
        };
    }
    DownloadFailure::terminal(if validation_failed {
        "模型文件大小或 SHA-256 校验失败，文件未安装；请重试或检查下载源"
    } else {
        "模型文件保存失败，请检查磁盘空间和模型目录写入权限"
    })
}

struct ModelResponseReader {
    response: Response,
    network_failed: bool,
}

impl Read for ModelResponseReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.response.read(buffer).inspect_err(|_| self.network_failed = true)
    }
}

/// 固定模型下载入口使用；取消标记由外层整个选源/重试生命周期统一清理。
pub(crate) fn download_model_to_file_attempt<V>(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    destination: &Path,
    max_bytes: Option<u64>,
    validate_temp: V,
) -> Result<FileTransferResult, DownloadFailure>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
{
    let cancelled = || is_cancelled(task_id).map_err(|_| DownloadFailure::terminal("读取文件传输取消状态失败"));
    if cancelled()? {
        return Err(DownloadFailure::terminal("文件传输已取消"));
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("AI-Canvas/model-download")
        .connect_timeout(Duration::from_secs(10))
        // blocking Response 每次 Read 单独计时；不限制整个大模型的下载用时。
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| DownloadFailure::terminal("创建模型下载客户端失败"))?;
    let response = client.get(url).send().map_err(|error| {
        if cancelled().unwrap_or(true) {
            return DownloadFailure::terminal("文件传输已取消");
        }
        DownloadFailure {
            message: "模型下载连接失败，请检查网络连接".into(),
            retryable: error.is_timeout() || error.is_connect() || error.is_body(),
        }
    })?;
    if cancelled()? {
        return Err(DownloadFailure::terminal("文件传输已取消"));
    }
    model_download_status(response.status())?;
    let metadata = DownloadMetadata {
        content_length: response.content_length(),
        content_type: response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim).map(str::to_string),
    };
    if let (Some(size), Some(limit)) = (metadata.content_length, max_bytes) {
        if size > limit {
            return Err(DownloadFailure::terminal("模型文件超过允许的体积上限"));
        }
    }
    let mut reader = ModelResponseReader { response, network_failed: false };
    let mut validation_failed = false;
    let _ = app.emit(PROGRESS_EVENT, FileTransferProgress {
        task_id: task_id.to_owned(), transferred_bytes: 0, total_bytes: metadata.content_length,
    });
    let result = stream_to_file(
        task_id, &mut reader, destination, metadata.content_length,
        metadata.content_length.or(max_bytes), max_bytes,
        || is_cancelled(task_id),
        |transferred_bytes| { let _ = app.emit(PROGRESS_EVENT, FileTransferProgress {
            task_id: task_id.to_owned(), transferred_bytes, total_bytes: metadata.content_length,
        }); },
        |path| validate_temp(path, &metadata).inspect_err(|_| validation_failed = true),
    );
    result.map(|total_bytes| FileTransferResult {
        path: destination.to_string_lossy().into_owned(), total_bytes,
        content_type: metadata.content_type,
    }).map_err(|_| model_transfer_failure(reader.network_failed, cancelled().unwrap_or(true), validation_failed))
}

/// 复用流式落盘边界，允许固定下载入口保留各自的 HTTP 超时和进度协议。
pub(crate) fn download_response_to_file<V, P>(
    task_id: &str,
    mut response: Response,
    destination: &Path,
    max_bytes: Option<u64>,
    validate_temp: V,
    mut on_progress: P,
) -> Result<FileTransferResult, String>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
    P: FnMut(u64, Option<u64>),
{
    let metadata = download_response_metadata(response.status(), response.content_length(), response.headers())?;
    download_reader_to_file(task_id, &mut response, destination, max_bytes, metadata, validate_temp, &mut on_progress)
}

fn download_media_response_to_file<V, P>(
    task_id: &str,
    response: reqwest::Response,
    destination: &Path,
    max_bytes: Option<u64>,
    idle_timeout: Duration,
    validate_temp: V,
    mut on_progress: P,
) -> Result<FileTransferResult, String>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
    P: FnMut(u64, Option<u64>),
{
    let metadata = download_response_metadata(response.status(), response.content_length(), response.headers())?;
    let mut reader = MediaDownloadReader {
        response, pending: Cursor::new(Vec::new()), idle_timeout, cancelled: || is_cancelled(task_id),
    };
    download_reader_to_file(task_id, &mut reader, destination, max_bytes, metadata, validate_temp, &mut on_progress)
}

fn download_response_metadata(
    status: reqwest::StatusCode,
    content_length: Option<u64>,
    headers: &reqwest::header::HeaderMap,
) -> Result<DownloadMetadata, String> {
    if !status.is_success() {
        return Err(format!("下载请求失败: HTTP {status}"));
    }
    // 本入口未请求 Range；不能把服务端返回的局部分段当作完整文件发布。
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err("下载返回不完整的分段内容".into());
    }
    Ok(DownloadMetadata {
        content_length,
        content_type: headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .map(str::to_string),
    })
}

fn download_reader_to_file<R, V, P>(
    task_id: &str,
    reader: &mut R,
    destination: &Path,
    max_bytes: Option<u64>,
    metadata: DownloadMetadata,
    validate_temp: V,
    on_progress: &mut P,
) -> Result<FileTransferResult, String>
where
    R: Read,
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
    P: FnMut(u64, Option<u64>),
{
    if let (Some(content_length), Some(max_bytes)) = (metadata.content_length, max_bytes) {
        validate_transfer_size(content_length, None, Some(max_bytes))?;
    }
    on_progress(0, metadata.content_length);
    let transferred = stream_to_file(
        task_id,
        reader,
        destination,
        metadata.content_length,
        metadata.content_length.or(max_bytes),
        max_bytes,
        || is_cancelled(task_id),
        |transferred_bytes| on_progress(transferred_bytes, metadata.content_length),
        |temp_path| validate_temp(temp_path, &metadata),
    )?;
    Ok(FileTransferResult {
        path: destination.to_string_lossy().into_owned(),
        total_bytes: transferred,
        content_type: metadata.content_type,
    })
}

// 调用方已对源、目标和根目录完成真实路径授权；只复用根目录内同一普通文件。
fn reusable_project_media(
    source: &Path,
    destination: &Path,
    root: &Path,
) -> Result<FileTransferResult, String> {
    if source != destination || !root.is_dir() || source == root || !source.starts_with(root) {
        return Err("只能复用当前项目素材目录内的原文件".to_string());
    }
    let metadata = fs::metadata(source).map_err(|_| "项目素材不存在或无法读取".to_string())?;
    if !metadata.is_file() {
        return Err("项目素材必须是普通文件".to_string());
    }
    Ok(FileTransferResult {
        path: source.to_string_lossy().into_owned(),
        total_bytes: metadata.len(),
        content_type: None,
    })
}

#[tauri::command]
pub async fn copy_file_streamed(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    source_path: String,
    destination_path: String,
    reuse_root: Option<String>,
) -> Result<FileTransferResult, String> {
    ensure_trusted_caller(&webview)?;
    // 源文件必须是用户显式给过的（对话框选中、拖入、已登记的素材目录），
    // 否则本命令等于把任意文件搬进项目目录，再经 asset 协议读走。
    let source = authorize_path(&app, &source_path, PathAccess::Read)?;
    let destination = authorize_path(&app, &destination_path, PathAccess::Write)?;

    if let Some(root) = reuse_root {
        let root = authorize_path(&app, &root, PathAccess::Read)?;
        let result = is_cancelled(&task_id).and_then(|cancelled| {
            if cancelled {
                return Err("素材引用已取消".to_string());
            }
            reusable_project_media(&source, &destination, &root)
        });
        clear_cancelled(&task_id);
        return result;
    }

    let task_id_for_worker = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let total_bytes = fs::metadata(&source)
            .map_err(|e| format!("读取源文件信息失败: {e}"))?
            .len();
        let mut input = File::open(&source).map_err(|e| format!("打开源文件失败: {e}"))?;
        let transferred = stream_to_file(
            &task_id_for_worker,
            &mut input,
            &destination,
            Some(total_bytes),
            Some(total_bytes),
            None,
            || is_cancelled(&task_id_for_worker),
            |transferred_bytes| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: task_id_for_worker.clone(),
                        transferred_bytes,
                        total_bytes: Some(total_bytes),
                    },
                );
            },
            |_| Ok(()),
        )?;
        Ok(FileTransferResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: transferred,
            content_type: None,
        })
    })
    .await
    .map_err(|e| format!("文件复制任务执行失败: {e}"))?;
    clear_cancelled(&task_id);
    result
}

/// 只读取容器头；完整性仍由传输长度校验负责，不以本机解码器支持与否判断下载成败。
fn validate_downloaded_video(path: &Path, _metadata: &DownloadMetadata) -> Result<(), String> {
    let mut file = File::open(path).map_err(|_| "无法读取下载视频".to_string())?;
    let len = file.metadata().map_err(|_| "无法读取下载视频大小".to_string())?.len();
    if len == 0 {
        return Err("视频下载返回空文件".into());
    }
    let mut header = [0_u8; 64];
    let count = len.min(header.len() as u64) as usize;
    file.read_exact(&mut header[..count]).map_err(|_| "无法读取下载视频文件头".to_string())?;
    let header = &header[..count];
    let iso_video = header.len() >= 16
        && matches!(&header[4..8], b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide")
        && {
            let atom_len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
            if atom_len == 1 {
                let extended = u64::from_be_bytes(header[8..16].try_into().unwrap());
                extended >= 16 && extended <= len
            } else {
                atom_len == 0 || (atom_len >= 8 && u64::from(atom_len) <= len)
            }
        };
    let matroska = header.len() >= 8 && header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]);
    let avi = header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"AVI ";
    if iso_video || matroska || avi { Ok(()) } else { Err("下载结果不是有效视频".into()) }
}

/// SVG 原件只按图片上下文检查根、尺寸和预算，不执行、净化或重写 XML。
pub(crate) fn validate_svg_image_bytes(bytes: &[u8]) -> Result<(u32, u32), String> {
    let invalid = || "下载结果不是受支持的图片或超出尺寸限制".to_string();
    if bytes.is_empty() || bytes.len() as u64 > GENERATED_IMAGE_MAX_BYTES { return Err(invalid()); }
    let source = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let lower = source.to_ascii_lowercase();
    if lower.contains("<!doctype") || lower.contains("<!entity") || lower.contains("<html") || lower.contains("</html") {
        return Err(invalid());
    }
    let mut root = source.trim_start_matches('\u{feff}').trim();
    // 只跳过文档前后的声明/注释，不接受 HTML 外壳；其余 XML 语法由图片加载器处理。
    loop {
        if root.starts_with("<?xml") {
            root = root.split_once("?>").ok_or_else(invalid)?.1.trim_start();
        } else if root.starts_with("<!--") {
            root = root.split_once("-->").ok_or_else(invalid)?.1.trim_start();
        } else { break; }
    }
    while root.ends_with("-->") {
        let start = root.rfind("<!--").ok_or_else(invalid)?;
        root = root[..start].trim_end();
    }
    let rest = root.strip_prefix("<svg").ok_or_else(invalid)?;
    if !rest.starts_with(|character: char| character.is_ascii_whitespace() || matches!(character, '>' | '/')) {
        return Err(invalid());
    }
    let mut quote = None;
    let mut head_end = None;
    for (index, byte) in rest.bytes().enumerate() {
        match (quote, byte) {
            (Some(delimiter), value) if value == delimiter => quote = None,
            (None, b'\'' | b'"') => quote = Some(byte),
            (None, b'>') => { head_end = Some(index); break; }
            _ => {}
        }
        if index >= 256 * 1024 { return Err(invalid()); }
    }
    let head_end = head_end.ok_or_else(invalid)?;
    let mut attributes = rest[..head_end].trim();
    let self_closing = attributes.ends_with('/');
    if self_closing { attributes = attributes[..attributes.len() - 1].trim_end(); }
    if (self_closing && !rest[head_end + 1..].trim().is_empty()) || (!self_closing && !root.ends_with("</svg>")) {
        return Err(invalid());
    }
    let mut values = HashMap::new();
    while !attributes.is_empty() {
        let name_end = attributes.find(|character: char| !(character.is_ascii_alphanumeric() || matches!(character, ':' | '_' | '-' | '.')))
            .ok_or_else(invalid)?;
        if name_end == 0 { return Err(invalid()); }
        let name = &attributes[..name_end];
        let value = attributes[name_end..].trim_start().strip_prefix('=').ok_or_else(invalid)?.trim_start();
        let delimiter = value.as_bytes().first().copied().filter(|value| matches!(*value, b'\'' | b'"')).ok_or_else(invalid)?;
        let value_end = value[1..].find(char::from(delimiter)).ok_or_else(invalid)? + 1;
        if values.insert(name, &value[1..value_end]).is_some() { return Err(invalid()); }
        attributes = &value[value_end + 1..];
        if !attributes.is_empty() && !attributes.starts_with(|character: char| character.is_ascii_whitespace()) { return Err(invalid()); }
        attributes = attributes.trim_start();
    }
    let length = |name: &str| values.get(name).and_then(|raw: &&str| {
        raw.trim().strip_suffix("px").unwrap_or(raw.trim()).trim().parse::<f64>().ok()
    });
    let (width, height) = match (length("width"), length("height")) {
        (Some(width), Some(height)) => (width, height),
        _ => {
            let view_box = values.get("viewBox").ok_or_else(invalid)?.split(|character: char| character.is_ascii_whitespace() || character == ',')
                .filter(|part| !part.is_empty()).map(str::parse::<f64>).collect::<Result<Vec<_>, _>>().map_err(|_| invalid())?;
            if view_box.len() != 4 || view_box.iter().any(|value| !value.is_finite()) { return Err(invalid()); }
            (view_box[2], view_box[3])
        }
    };
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0
        || width.ceil() > f64::from(u32::MAX) || height.ceil() > f64::from(u32::MAX) { return Err(invalid()); }
    let dimensions = (width.ceil() as u32, height.ceil() as u32);
    if u64::from(dimensions.0) * u64::from(dimensions.1) > GENERATED_IMAGE_MAX_PIXELS { return Err(invalid()); }
    Ok(dimensions)
}

fn validate_downloaded_image(path: &Path) -> Result<&'static str, String> {
    let invalid = || "下载结果不是受支持的图片或超出尺寸限制".to_string();
    // 不从目标文件名预设格式：受控下载可能没有后缀，或尚以 PNG 名称暂存 SVG。
    let reader = image::ImageReader::new(io::BufReader::new(File::open(path).map_err(|_| invalid())?))
        .with_guessed_format().map_err(|_| invalid())?;
    let mime = match reader.format() {
        Some(image::ImageFormat::Png) => "image/png",
        Some(image::ImageFormat::Jpeg) => "image/jpeg",
        Some(image::ImageFormat::WebP) => "image/webp",
        Some(image::ImageFormat::Gif) => "image/gif",
        _ => {
            let mut bytes = Vec::new();
            File::open(path).map_err(|_| invalid())?.take(GENERATED_IMAGE_MAX_BYTES + 1)
                .read_to_end(&mut bytes).map_err(|_| invalid())?;
            validate_svg_image_bytes(&bytes)?;
            return Ok("image/svg+xml");
        }
    };
    let (width, height) = reader.into_dimensions().map_err(|_| invalid())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > GENERATED_IMAGE_MAX_PIXELS {
        return Err(invalid());
    }
    Ok(mime)
}

#[tauri::command]
pub async fn download_file_streamed(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    url: String,
    destination_path: String,
    expected_media_kind: Option<String>,
    download_access: Option<MediaDownloadAccess>,
) -> Result<FileTransferResult, String> {
    ensure_trusted_caller(&webview)?;
    let destination = authorize_path(&app, &destination_path, PathAccess::Write)?;
    if expected_media_kind.as_deref().is_some_and(|kind| !matches!(kind, "video" | "image")) {
        return Err("不支持的下载媒体校验类型".into());
    }

    let task_id_for_worker = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut detected_image_type = None;
        let mut result = download_to_file_with_access(
            &app,
            &task_id_for_worker,
            &url,
            &destination,
            (expected_media_kind.as_deref() == Some("image")).then_some(GENERATED_IMAGE_MAX_BYTES),
            download_access.as_ref(),
            |path, metadata| {
                match expected_media_kind.as_deref() {
                    Some("video") => validate_downloaded_video(path, metadata),
                    Some("image") => { detected_image_type = Some(validate_downloaded_image(path)?); Ok(()) },
                    _ => Ok(()),
                }
            },
        )?;
        // 生成图片的类型来自临时文件真实容器，而不是响应头或 URL 后缀。
        if let Some(mime) = detected_image_type { result.content_type = Some(mime.to_string()); }
        Ok(result)
    })
    .await
    .map_err(|e| format!("文件下载任务执行失败: {e}"))?;
    result
}

fn plain_copy_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "复制源不可访问")?;
    #[cfg(target_os = "windows")]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(target_os = "windows"))]
    let reparse = false;
    if reparse || metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        return Err("文件夹包含链接或特殊文件，已停止复制".into());
    }
    Ok(metadata)
}

struct FolderCopyPlan {
    directories: Vec<PathBuf>,
    files: Vec<(PathBuf, u64)>,
    bytes: u64,
}

fn plan_folder_copy<C, V>(
    source: &Path,
    mut cancelled: C,
    mut validate: V,
) -> Result<FolderCopyPlan, String>
where
    C: FnMut() -> Result<bool, String>,
    V: FnMut(&Path, bool) -> Result<(), String>,
{
    if !plain_copy_metadata(source)?.is_dir() {
        return Err("复制源必须是文件夹".into());
    }
    let mut plan = FolderCopyPlan {
        directories: vec![PathBuf::new()],
        files: Vec::new(),
        bytes: 0,
    };
    let mut stack = vec![(PathBuf::new(), 0_usize)];
    while let Some((relative, depth)) = stack.pop() {
        if cancelled()? {
            return Err("文件夹复制已取消".into());
        }
        let directory = source.join(&relative);
        validate(&directory, true)?;
        for entry in fs::read_dir(&directory).map_err(|_| "无法读取复制源目录")? {
            if cancelled()? {
                return Err("文件夹复制已取消".into());
            }
            let entry = entry.map_err(|_| "无法读取复制源条目")?;
            let child = relative.join(entry.file_name());
            let metadata = plain_copy_metadata(&source.join(&child))?;
            validate(&source.join(&child), metadata.is_dir())?;
            if plan.files.len() + plan.directories.len() >= 100_000 || depth >= 128 {
                return Err("目录条目或深度超过复制上限，未开始写入".into());
            }
            if metadata.is_dir() {
                plan.directories.push(child.clone());
                stack.push((child, depth + 1));
            } else {
                plan.bytes = plan
                    .bytes
                    .checked_add(metadata.len())
                    .ok_or("目录体积超过上限")?;
                plan.files.push((child, metadata.len()));
            }
        }
    }
    plan.directories
        .sort_by_key(|path| path.components().count());
    Ok(plan)
}

fn folder_copy_destination(source: &Path, parent: &Path) -> Result<PathBuf, String> {
    if parent.starts_with(source) {
        return Err("不能将文件夹粘贴到自身或其子目录".into());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无法复制磁盘根目录")?;
    for index in 0..10_000 {
        let candidate = parent.join(if index == 0 {
            name.to_string()
        } else {
            format!("{name} - 副本 ({index})")
        });
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("创建粘贴目标失败".into()),
        }
    }
    Err("同名文件夹过多，请更换目标目录".into())
}

#[tauri::command]
pub async fn copy_asset_folder(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    source_path: String,
    destination_directory: String,
) -> Result<FileTransferResult, String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("文件夹粘贴仅允许主窗口调用".into());
    }
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("传输标识无效".into());
    }
    let source = crate::path_policy::authorize_existing_plain_directory(&app, &source_path)?;
    let parent =
        crate::path_policy::authorize_existing_plain_directory(&app, &destination_directory)?;
    if parent.starts_with(&source) {
        return Err("不能将文件夹粘贴到自身或其子目录".into());
    }
    let worker_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let validate_source = |path: &Path, directory: bool| -> Result<(), String> {
            let raw = path.to_string_lossy();
            let authorized = if directory {
                crate::path_policy::authorize_existing_plain_directory(&app, &raw)?
            } else {
                crate::path_policy::authorize_existing_plain_file(&app, &raw)?
            };
            if !authorized.starts_with(&source) {
                return Err("复制源已变化，已停止复制".into());
            }
            Ok(())
        };
        let plan = plan_folder_copy(&source, || is_cancelled(&worker_id), validate_source)?;
        ensure_disk_space(&parent, Some(plan.bytes))?;
        crate::path_policy::reauthorize_existing_plain_directory(&app, &parent)?;
        if is_cancelled(&worker_id)? {
            return Err("文件夹复制已取消".into());
        }
        let destination = folder_copy_destination(&source, &parent)?;
        // 取消/失败保留已经完成的副本；从不删除原目录或覆盖既有目标。
        let copy_result = (|| {
            let mut completed_bytes = 0;
            for relative in plan.directories.iter().skip(1) {
                if is_cancelled(&worker_id)? {
                    return Err("文件夹复制已取消".to_string());
                }
                let target = destination.join(relative);
                let authorized =
                    authorize_path(&app, &target.to_string_lossy(), PathAccess::Write)?;
                if !authorized.starts_with(&destination) {
                    return Err("粘贴目标已变化".into());
                }
                fs::create_dir(&target).map_err(|_| "创建子文件夹失败")?;
            }
            for (relative, expected) in &plan.files {
                if is_cancelled(&worker_id)? {
                    return Err("文件夹复制已取消".into());
                }
                let path = source.join(relative);
                validate_source(&path, false)?;
                if plain_copy_metadata(&path)?.len() != *expected {
                    return Err("复制源文件已变化".into());
                }
                let target = destination.join(relative);
                let authorized =
                    authorize_path(&app, &target.to_string_lossy(), PathAccess::Write)?;
                if !authorized.starts_with(&destination) {
                    return Err("粘贴目标已变化".into());
                }
                let mut input = File::open(path).map_err(|_| "无法打开复制源文件")?;
                stream_to_file(
                    &worker_id,
                    &mut input,
                    &target,
                    Some(*expected),
                    Some(*expected),
                    None,
                    || is_cancelled(&worker_id),
                    |current| {
                        let _ = app.emit(
                            PROGRESS_EVENT,
                            FileTransferProgress {
                                task_id: worker_id.clone(),
                                transferred_bytes: completed_bytes + current,
                                total_bytes: Some(plan.bytes),
                            },
                        );
                    },
                    |_| Ok(()),
                )?;
                completed_bytes += expected;
            }
            let _ = app.emit(
                PROGRESS_EVENT,
                FileTransferProgress {
                    task_id: worker_id.clone(),
                    transferred_bytes: plan.bytes,
                    total_bytes: Some(plan.bytes),
                },
            );
            Ok(FileTransferResult {
                path: destination.to_string_lossy().into_owned(),
                total_bytes: plan.bytes,
                content_type: None,
            })
        })();
        copy_result.map_err(|error: String| format!("{error}；已复制内容保留在目标目录"))
    })
    .await
    .map_err(|_| "文件夹复制任务失败".to_string());
    clear_cancelled(&task_id);
    result?
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetFileCopyResult {
    path: String,
    total_bytes: u64,
    digest: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum AssetMoveCopy {
    Plan { reserved_names: Vec<String> },
    Publish { copy: AssetFileCopyResult, resume: bool },
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum AssetCopyDestination {
    Folder(String),
    Move { directory: String, plan: AssetMoveCopy },
}

pub(crate) fn file_digest(
    path: &Path,
    cancelled: impl Fn() -> Result<bool, String>,
) -> Result<String, String> {
    let mut input = File::open(path).map_err(|_| "无法读取文件内容")?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; BUFFER_SIZE];
    loop {
        if cancelled()? {
            return Err("文件操作已取消".into());
        }
        let read = input.read(&mut buffer).map_err(|_| "读取文件内容失败")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn asset_file_destination(
    source: &Path,
    parent: &Path,
    reserved_names: &[String],
) -> Result<PathBuf, String> {
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("文件名无效")?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("文件名无效")?;
    let extension = source.extension().and_then(|value| value.to_str());
    for index in 0..10_000 {
        let file_name = if index == 0 {
            name.to_string()
        } else {
            match extension {
                Some(ext) => format!("{stem} ({index}).{ext}"),
                None => format!("{stem} ({index})"),
            }
        };
        if reserved_names.iter().any(|reserved| reserved.eq_ignore_ascii_case(&file_name)) {
            continue;
        }
        let candidate = parent.join(file_name);
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(_) => return Err("无法检查目标文件".into()),
            Ok(_) => {}
        }
    }
    Err("同名文件过多，请更换目标目录".into())
}

fn valid_asset_move_name(source: &Path, name: &Path) -> bool {
    if source.file_name() == name.file_name() {
        return true;
    }
    if source.extension() != name.extension() {
        return false;
    }
    let Some(stem) = source.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    name.file_stem()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_prefix(stem)?.strip_prefix(" (")?.strip_suffix(')'))
        .is_some_and(|suffix| (1..=4).contains(&suffix.len())
            && !suffix.starts_with('0') && suffix.bytes().all(|byte| byte.is_ascii_digit()))
}

#[tauri::command]
pub async fn copy_asset_file_to_folder(
    app: AppHandle,
    webview: Webview,
    task_id: String,
    source_path: String,
    destination_directory: AssetCopyDestination,
) -> Result<AssetFileCopyResult, String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("文件拖放仅允许主窗口调用".into());
    }
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("传输标识无效".into());
    }
    let (directory, move_plan) = match destination_directory {
        AssetCopyDestination::Folder(directory) => (directory, None),
        AssetCopyDestination::Move { directory, plan } => (directory, Some(plan)),
    };
    let source = crate::path_policy::authorize_existing_plain_file(&app, &source_path)?;
    let parent = crate::path_policy::authorize_existing_plain_directory(&app, &directory)?;
    let worker_id = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bytes = plain_copy_metadata(&source)?.len();
        let digest = file_digest(&source, || is_cancelled(&worker_id))?;
        let (destination, plan_only, resume) = match move_plan {
            Some(AssetMoveCopy::Publish { copy: plan, resume }) => {
                if bytes != plan.total_bytes || digest != plan.digest {
                    return Err("源文件内容已变化，请重新移动".into());
                }
                let name = Path::new(&plan.path).file_name().ok_or("移动目标名称无效")?;
                let exact = parent.join(name);
                if exact != Path::new(&plan.path) || !valid_asset_move_name(&source, &exact) {
                    return Err("移动目标目录已变化".into());
                }
                (exact, false, resume)
            }
            Some(AssetMoveCopy::Plan { reserved_names }) => {
                (asset_file_destination(&source, &parent, &reserved_names)?, true, false)
            }
            None => (asset_file_destination(&source, &parent, &[])?, false, false),
        };
        let authorized = authorize_path(&app, &destination.to_string_lossy(), PathAccess::Write)?;
        if authorized.parent() != Some(parent.as_path()) || authorized == source {
            return Err("目标目录已变化".into());
        }
        let receipt = AssetFileCopyResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: bytes,
            digest: digest.clone(),
        };
        if plan_only {
            return Ok(receipt);
        }
        if resume && destination.try_exists().map_err(|_| "无法检查移动目标")? {
            let existing = crate::path_policy::authorize_existing_plain_file(&app, &receipt.path)?;
            if existing != authorized
                || plain_copy_metadata(&existing)?.len() != bytes
                || file_digest(&existing, || is_cancelled(&worker_id))? != digest
                || file_digest(&source, || is_cancelled(&worker_id))? != digest
            {
                return Err("asset-move-target-occupied".into());
            }
            return Ok(receipt);
        }
        let mut input = File::open(&source).map_err(|_| "无法打开源文件")?;
        stream_to_file(
            &worker_id,
            &mut input,
            &destination,
            Some(bytes),
            Some(bytes),
            Some(bytes),
            || is_cancelled(&worker_id),
            |current| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: worker_id.clone(),
                        transferred_bytes: current,
                        total_bytes: Some(bytes),
                    },
                );
            },
            |temporary| {
                crate::path_policy::reauthorize_existing_plain_directory(&app, &parent)?;
                let current_source =
                    crate::path_policy::authorize_existing_plain_file(&app, &source_path)?;
                if current_source != source
                    || plain_copy_metadata(&source)?.len() != bytes
                    || file_digest(temporary, || is_cancelled(&worker_id))? != digest
                    || file_digest(&source, || is_cancelled(&worker_id))? != digest
                {
                    return Err("源文件已变化，原文件已保留".into());
                }
                Ok(())
            },
        )?;
        Ok(receipt)
    })
    .await
    .map_err(|_| "文件复制任务失败".to_string());
    clear_cancelled(&task_id);
    result?
}

fn verify_move_copy(
    source: &Path,
    destination: &Path,
    expected_digest: &str,
    expected_bytes: u64,
) -> Result<(), String> {
    if source == destination {
        return Err("源文件与目标文件相同".into());
    }
    if expected_digest.len() != 64 || !expected_digest.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("文件校验信息无效".into());
    }
    for path in [destination, source] {
        if path == source
            && fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            // 原件已被回收而日志提交失败：目标仍通过校验时允许完成清理日志。
            continue;
        }
        if plain_copy_metadata(path)?.len() != expected_bytes
            || file_digest(path, || Ok(false))? != expected_digest
        {
            return Err("文件内容已变化，原文件已保留".into());
        }
    }
    Ok(())
}

/** 仅在数据库引用迁移后调用；验证成功的副本存在才回收源文件。 */
#[tauri::command]
pub async fn finish_asset_file_move(
    app: AppHandle,
    webview: Webview,
    source_path: String,
    destination_path: String,
    expected_digest: String,
    expected_bytes: u64,
) -> Result<(), String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("资产移动仅允许主窗口调用".into());
    }
    let source = authorize_path(&app, &source_path, PathAccess::Write)?;
    let destination = crate::path_policy::authorize_existing_plain_file(&app, &destination_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        verify_move_copy(&source, &destination, &expected_digest, expected_bytes)?;
        if fs::symlink_metadata(&source)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(());
        }
        if crate::path_policy::authorize_existing_plain_file(&app, &source_path)? != source
            || crate::path_policy::authorize_existing_plain_file(&app, &destination_path)?
                != destination
        {
            return Err("文件位置已变化，原文件已保留".into());
        }
        authorize_path(&app, &source_path, PathAccess::Write)?;
        trash::delete(&source)
            .map_err(|_| "源文件无法放入回收站，目标副本和原文件均已保留".to_string())
    })
    .await
    .map_err(|_| "资产移动任务失败，原文件已保留".to_string())?
}

#[tauri::command]
pub fn cancel_file_transfer(task_id: String) -> Result<(), String> {
    cancelled_transfers()
        .lock()
        .map_err(|_| "更新文件传输取消状态失败".to_string())?
        .insert(task_id);
    Ok(())
}

#[cfg(test)]
#[path = "transfer/tests.rs"]
mod tests;
