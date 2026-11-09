//! 窗口绑定的 ComfyUI 分段媒体读取。URL 与授权只在原生内存中保存。
use serde::Serialize;
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder, Webview, Window, WindowEvent,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_GRANTS: usize = 64;
const MAX_REQUESTS: usize = 16;
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, PartialEq, Eq)]
struct Owner { label: String, page: String, origin: String }

#[derive(Clone, PartialEq, Eq)]
struct Representation { total: u64, mime: String, etag: Option<String>, modified: Option<String> }

struct Grant {
    owner: Owner,
    url: Url,
    cancel: CancellationToken,
    representation: Mutex<Option<Representation>>,
}

impl Grant {
    fn remember(&self, value: Representation) -> Result<(), Failure> {
        let mut stored = self.representation.lock().map_err(|_| Failure::unavailable())?;
        if stored.as_ref().is_some_and(|previous| *previous != value) {
            self.cancel.cancel();
            return Err(Failure::new(StatusCode::CONFLICT, "媒体内容已变化，请重新打开预览"));
        }
        *stored = Some(value);
        Ok(())
    }
}

pub struct ComfyMediaState { grants: Mutex<HashMap<String, Arc<Grant>>>, slots: Arc<Semaphore> }

impl Default for ComfyMediaState {
    fn default() -> Self { Self { grants: Mutex::new(HashMap::new()), slots: Arc::new(Semaphore::new(MAX_REQUESTS)) } }
}

impl ComfyMediaState {
    fn revoke(&self, id: &str, owner: &Owner) -> Result<(), String> {
        let mut grants = self.grants.lock().map_err(|_| "媒体读取授权不可用")?;
        if grants.get(id).is_some_and(|grant| grant.owner != *owner) {
            return Err("不能关闭其他窗口的媒体读取".into());
        }
        if let Some(grant) = grants.remove(id) { grant.cancel.cancel(); }
        Ok(())
    }

    fn revoke_owner(&self, owner: Option<&str>) {
        let mut grants = self.grants.lock().unwrap_or_else(|error| error.into_inner());
        grants.retain(|_, grant| {
            if owner.is_none_or(|owner| owner == grant.owner.label) { grant.cancel.cancel(); false } else { true }
        });
    }
}

fn frontend_owner<R: Runtime>(webview: &Webview<R>) -> Result<Owner, String> {
    // 视频编辑器仅在这个只读通道中额外放行，不扩大通用文件命令的可信窗口集合。
    let editor = webview.label() == "video-editor";
    if !editor { crate::path_policy::ensure_trusted_caller(webview)?; }
    let mut page = webview.url().map_err(|_| "无法确认媒体读取窗口来源")?;
    let dev = if cfg!(debug_assertions) { webview.app_handle().config().build.dev_url.as_ref() } else { None };
    let bundled = (page.scheme() == "tauri" && page.host_str() == Some("localhost"))
        || (matches!(page.scheme(), "http" | "https") && page.host_str() == Some("tauri.localhost") && page.port().is_none());
    let views: Vec<_> = page.query_pairs().filter(|(name, _)| name == "view").collect();
    if !page.username().is_empty() || page.password().is_some()
        || !matches!(page.path(), "/" | "/index.html")
        || (editor && (views.len() != 1 || views[0].1 != "video-editor"))
        || !(bundled || dev.is_some_and(|expected| expected.origin() == page.origin()))
    { return Err("媒体读取仅允许本地主应用窗口使用".into()); }
    let origin = if page.scheme() == "tauri" { "tauri://localhost".into() } else { page.origin().ascii_serialization() };
    page.set_fragment(None);
    Ok(Owner { label: webview.label().into(), page: page.to_string(), origin })
}

fn media_url(value: &str) -> Result<Url, String> {
    if value.is_empty() || value.len() > 8192 || value.trim() != value || value.chars().any(char::is_control) {
        return Err("ComfyUI 媒体地址无效".into());
    }
    let url = Url::parse(value).map_err(|_| "ComfyUI 媒体地址无效")?;
    let names: Vec<_> = url.query_pairs().filter(|(name, _)| name == "filename").collect();
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || !url.path().ends_with("/view") || names.len() != 1 || names[0].1.trim().is_empty()
    { return Err("仅支持不含内嵌凭据的 ComfyUI 媒体取件地址".into()); }
    Ok(url)
}

fn valid_id(value: &str) -> bool { value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) }

pub(crate) fn new_id() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    #[cfg(windows)]
    {
        // RtlGenRandom 是 Windows 系统密码学随机源，不接收 Renderer 提供的种子。
        #[link(name = "advapi32")]
        unsafe extern "system" {
            #[link_name = "SystemFunction036"]
            fn rtl_gen_random(buffer: *mut std::ffi::c_void, length: u32) -> u8;
        }
        if unsafe { rtl_gen_random(bytes.as_mut_ptr().cast(), bytes.len() as u32) } == 0 {
            return Err("系统随机源不可用，未创建媒体读取授权".into());
        }
    }
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes))
            .map_err(|_| "系统随机源不可用，未创建媒体读取授权")?;
    }
    #[cfg(not(any(windows, unix)))]
    return Err("当前平台不支持安全的媒体读取授权".into());
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Serialize)]
pub struct MediaSource { id: String }

#[tauri::command]
pub fn open_comfy_media_source(webview: Webview, app: AppHandle, url: String) -> Result<MediaSource, String> {
    let owner = frontend_owner(&webview)?;
    let url = media_url(&url)?;
    let state = app.state::<ComfyMediaState>();
    let mut grants = state.grants.lock().map_err(|_| "媒体读取授权不可用")?;
    if grants.len() >= MAX_GRANTS { return Err("同时打开的 ComfyUI 媒体过多，请先关闭其他预览".into()); }
    for _ in 0..4 {
        let id = new_id()?;
        if grants.contains_key(&id) { continue; }
        grants.insert(id.clone(), Arc::new(Grant { owner, url, cancel: CancellationToken::new(), representation: Mutex::new(None) }));
        return Ok(MediaSource { id });
    }
    Err("无法分配媒体读取授权".into())
}

#[tauri::command]
pub fn close_comfy_media_source(webview: Webview, app: AppHandle, id: String) -> Result<(), String> {
    let owner = frontend_owner(&webview)?;
    if !valid_id(&id) { return Err("媒体读取标识无效".into()); }
    app.state::<ComfyMediaState>().revoke(&id, &owner)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ByteRange { Initial, From(u64, Option<u64>), Suffix(u64) }

fn parse_range(value: Option<&str>) -> Result<ByteRange, Failure> {
    let Some(value) = value else { return Ok(ByteRange::Initial); };
    if value.len() > 100 || value.contains(',') { return Err(Failure::range(None)); }
    let (start, end) = value.strip_prefix("bytes=").and_then(|value| value.split_once('-')).ok_or_else(|| Failure::range(None))?;
    let number = |part: &str| -> Result<u64, Failure> {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) { return Err(Failure::range(None)); }
        part.parse().map_err(|_| Failure::range(None))
    };
    if start.is_empty() {
        let count = number(end)?;
        if count == 0 { return Err(Failure::range(None)); }
        return Ok(ByteRange::Suffix(count));
    }
    let start = number(start)?;
    let end = if end.is_empty() { None } else { Some(number(end)?) };
    if end.is_some_and(|end| end < start) { return Err(Failure::range(None)); }
    Ok(ByteRange::From(start, end))
}

fn bounded_range(range: ByteRange, total: Option<u64>) -> Result<(u64, u64), Failure> {
    let (start, end) = match range {
        ByteRange::Initial => (0, None),
        ByteRange::From(start, end) => (start, end),
        ByteRange::Suffix(count) => {
            let total = total.ok_or_else(Failure::unavailable)?;
            (total.saturating_sub(count), Some(total.saturating_sub(1)))
        }
    };
    if total.is_some_and(|total| total == 0 || start >= total) { return Err(Failure::range(total)); }
    let end = end.unwrap_or(u64::MAX).min(start.saturating_add(CHUNK_BYTES - 1));
    let end = total.map_or(end, |total| end.min(total - 1));
    Ok((start, end))
}

fn content_range(value: &str) -> Result<(u64, u64, u64), Failure> {
    let (span, total) = value.strip_prefix("bytes ").and_then(|value| value.split_once('/')).ok_or_else(Failure::unavailable)?;
    let (start, end) = span.split_once('-').ok_or_else(Failure::unavailable)?;
    let number = |value: &str| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(Failure::unavailable()); }
        value.parse::<u64>().map_err(|_| Failure::unavailable())
    };
    let (start, end, total) = (number(start)?, number(end)?, number(total)?);
    if start > end || end >= total || total > MAX_MEDIA_BYTES || end - start >= CHUNK_BYTES { return Err(Failure::unavailable()); }
    Ok((start, end, total))
}

fn safe_header(headers: &reqwest::header::HeaderMap, name: &str) -> Result<Option<String>, Failure> {
    if headers.get_all(name).iter().count() > 1 { return Err(Failure::unavailable()); }
    match headers.get(name) {
        None => Ok(None),
        Some(value) => value.to_str().ok().filter(|value| value.len() <= 1024 && !value.chars().any(char::is_control))
            .map(|value| Some(value.to_string())).ok_or_else(Failure::unavailable),
    }
}

fn declared_length(headers: &reqwest::header::HeaderMap) -> Result<Option<u64>, Failure> {
    safe_header(headers, "content-length")?.map(|value| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) { return Err(Failure::unavailable()); }
        value.parse().map_err(|_| Failure::unavailable())
    }).transpose()
}

fn metadata(headers: &reqwest::header::HeaderMap, total: u64) -> Result<Representation, Failure> {
    if total == 0 || total > MAX_MEDIA_BYTES { return Err(Failure::unavailable()); }
    if safe_header(headers, "content-encoding")?.is_some_and(|encoding| !encoding.eq_ignore_ascii_case("identity")) {
        return Err(Failure::unavailable());
    }
    let mime = safe_header(headers, "content-type")?.unwrap_or_else(|| "application/octet-stream".into());
    let kind = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !(kind.starts_with("video/") || kind.starts_with("audio/") || kind.starts_with("image/")
        || matches!(kind.as_str(), "application/octet-stream" | "application/ogg"))
    { return Err(Failure::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "ComfyUI 返回了不支持的媒体类型")); }
    Ok(Representation { total, mime, etag: safe_header(headers, "etag")?, modified: safe_header(headers, "last-modified")? })
}

struct MediaReply { status: StatusCode, metadata: Representation, start: Option<u64>, end: Option<u64>, body: Vec<u8> }

async fn serve_upstream(client: reqwest::Client, grant: Arc<Grant>, method: Method, range: ByteRange) -> Result<MediaReply, Failure> {
    let head = method == Method::HEAD || matches!(range, ByteRange::Suffix(_));
    let mut known_total = None;
    if head {
        let response = client.head(grant.url.clone()).header("accept-encoding", "identity").timeout(REQUEST_TIMEOUT)
            .send().await.map_err(|_| Failure::unavailable())?;
        if response.status() != reqwest::StatusCode::OK { return Err(Failure::upstream(response.status().as_u16())); }
        // HEAD 的响应体为空；读取原始长度头，不能把解码器的空体长度当成媒体总长。
        let total = declared_length(response.headers())?.ok_or_else(Failure::unavailable)?;
        let information = metadata(response.headers(), total)?;
        grant.remember(information.clone())?;
        known_total = Some(total);
        if method == Method::HEAD { return Ok(MediaReply { status: StatusCode::OK, metadata: information, start: None, end: None, body: Vec::new() }); }
    }
    let (start, end) = bounded_range(range, known_total)?;
    let mut response = client.get(grant.url.clone()).header("accept-encoding", "identity")
        .header("range", format!("bytes={start}-{end}")).timeout(REQUEST_TIMEOUT)
        .send().await.map_err(|_| Failure::unavailable())?;
    let partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !partial && response.status() != reqwest::StatusCode::OK { return Err(Failure::upstream(response.status().as_u16())); }
    if !partial && response.headers().contains_key("content-range") { return Err(Failure::unavailable()); }
    let span = if partial {
        let span = content_range(&safe_header(response.headers(), "content-range")?.ok_or_else(Failure::unavailable)?)?;
        if span.0 != start || span.1 > end || known_total.is_some_and(|total| total != span.2) { return Err(Failure::unavailable()); }
        Some(span)
    } else { None };
    let expected = span.map(|(start, end, _)| end - start + 1);
    let declared = declared_length(response.headers())?;
    if declared.is_some_and(|length| length > CHUNK_BYTES || expected.is_some_and(|expected| length != expected)) {
        return Err(Failure::new(StatusCode::BAD_GATEWAY, "上游未提供受限媒体分段，未读取完整大文件"));
    }
    let headers = response.headers().clone();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::unavailable())? {
        if (body.len() as u64).saturating_add(chunk.len() as u64) > CHUNK_BYTES { return Err(Failure::unavailable()); }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() || expected.is_some_and(|expected| body.len() as u64 != expected)
        || declared.is_some_and(|length| length != body.len() as u64)
    { return Err(Failure::unavailable()); }
    let total = span.map_or(body.len() as u64, |(_, _, total)| total);
    if known_total.is_some_and(|known| known != total) { return Err(Failure::unavailable()); }
    let information = metadata(&headers, total)?;
    grant.remember(information.clone())?;
    if let Some((start, end, _)) = span {
        Ok(MediaReply { status: StatusCode::PARTIAL_CONTENT, metadata: information, start: Some(start), end: Some(end), body })
    } else if range != ByteRange::Initial {
        // 上游忽略 Range 时只接收完整的小文件，再按其真实总长提供片段；不截断大 200 响应。
        let (start, end) = bounded_range(range, Some(total))?;
        let body = body[start as usize..=end as usize].to_vec();
        Ok(MediaReply { status: StatusCode::PARTIAL_CONTENT, metadata: information, start: Some(start), end: Some(end), body })
    } else {
        Ok(MediaReply { status: StatusCode::OK, metadata: information, start: None, end: None, body })
    }
}

#[derive(Debug)]
struct Failure { status: StatusCode, message: String, total: Option<u64> }
impl Failure {
    fn new(status: StatusCode, message: &str) -> Self { Self { status, message: message.into(), total: None } }
    fn unavailable() -> Self { Self::new(StatusCode::BAD_GATEWAY, "ComfyUI 媒体分段读取失败，请检查服务后重新打开预览") }
    fn range(total: Option<u64>) -> Self { Self { status: StatusCode::RANGE_NOT_SATISFIABLE, message: "媒体读取范围无效".into(), total } }
    fn upstream(status: u16) -> Self {
        let status = StatusCode::from_u16(status).ok().filter(|status| status.is_client_error() || status.is_server_error())
            .unwrap_or(StatusCode::BAD_GATEWAY);
        Self::new(status, "ComfyUI 拒绝了媒体分段读取")
    }
}

fn response_headers(status: StatusCode, owner: Option<&Owner>) -> tauri::http::response::Builder {
    let mut response = Response::builder().status(status)
        .header(header::CACHE_CONTROL, "no-store").header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox; default-src 'none'");
    if let Some(owner) = owner {
        response = response.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, owner.origin.as_str())
            .header(header::VARY, "Origin")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range, Content-Type, Accept-Ranges");
    }
    response
}

fn failure_response(error: Failure, owner: Option<&Owner>, head: bool) -> Response<Vec<u8>> {
    let mut response = response_headers(error.status, owner).header(header::CONTENT_TYPE, "text/plain; charset=utf-8");
    if let Some(total) = error.total { response = response.header(header::CONTENT_RANGE, format!("bytes */{total}")); }
    response.body(if head { Vec::new() } else { error.message.into_bytes() }).unwrap_or_else(|_| empty_failure_response())
}

fn empty_failure_response() -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = StatusCode::BAD_GATEWAY;
    response
}

fn media_response(reply: MediaReply, owner: &Owner, head: bool) -> Response<Vec<u8>> {
    let mut response = response_headers(reply.status, Some(owner)).header(header::CONTENT_TYPE, reply.metadata.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, if head { reply.metadata.total } else { reply.body.len() as u64 });
    if let (Some(start), Some(end)) = (reply.start, reply.end) {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{}", reply.metadata.total));
    }
    response.body(reply.body).unwrap_or_else(|_| empty_failure_response())
}

pub fn handle_protocol<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = context.app_handle().clone();
    let label = context.webview_label().to_string();
    let head = request.method() == Method::HEAD;
    let prepared = (|| -> Result<_, Failure> {
        if request.method() != Method::GET && !head { return Err(Failure::new(StatusCode::METHOD_NOT_ALLOWED, "仅允许读取媒体")); }
        let view = app.get_webview_window(&label).ok_or_else(|| Failure::new(StatusCode::FORBIDDEN, "媒体读取窗口不可用"))?;
        let owner = frontend_owner(view.as_ref()).map_err(|_| Failure::new(StatusCode::FORBIDDEN, "媒体读取来源未获授权"))?;
        let id = request.uri().path().strip_prefix('/').filter(|id| valid_id(id)).ok_or_else(|| Failure::new(StatusCode::NOT_FOUND, "媒体读取标识无效"))?;
        if !request.body().is_empty() || request.uri().query().is_some()
            || request.headers().get_all(header::RANGE).iter().count() > 1
            || request.headers().get_all(header::ORIGIN).iter().count() > 1
            || request.headers().get(header::ORIGIN).is_some_and(|value| value.to_str().ok() != Some(owner.origin.as_str()))
        { return Err(Failure::new(StatusCode::FORBIDDEN, "媒体读取请求未获授权")); }
        let state = app.state::<ComfyMediaState>();
        let grant = state.grants.lock().map_err(|_| Failure::unavailable())?.get(id).cloned()
            .filter(|grant| grant.owner == owner && !grant.cancel.is_cancelled())
            .ok_or_else(|| Failure::new(StatusCode::GONE, "媒体读取授权已失效"))?;
        let range = parse_range(request.headers().get(header::RANGE).map(|value| value.to_str().map_err(|_| Failure::range(None))).transpose()?)?;
        let permit = state.slots.clone().try_acquire_owned().map_err(|_| Failure::new(StatusCode::TOO_MANY_REQUESTS, "媒体并发读取过多，请稍后重试"))?;
        let client = app.state::<crate::ProxyHttpState>().client.clone();
        Ok((owner, grant, range, permit, client))
    })();
    let (owner, grant, range, permit, client) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => { responder.respond(failure_response(error, None, head)); return; }
    };
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let result = tokio::select! {
            biased;
            _ = grant.cancel.cancelled() => Err(Failure::new(StatusCode::GONE, "媒体读取已取消")),
            result = tokio::time::timeout(REQUEST_TIMEOUT, serve_upstream(client, grant.clone(), request.method().clone(), range)) =>
                result.unwrap_or_else(|_| Err(Failure::new(StatusCode::GATEWAY_TIMEOUT, "媒体分段读取超时"))),
        };
        let current = app.get_webview_window(&label).and_then(|view| frontend_owner(view.as_ref()).ok());
        let result = if grant.cancel.is_cancelled() || current.as_ref() != Some(&owner) {
            Err(Failure::new(StatusCode::GONE, "媒体读取授权已失效"))
        } else { result };
        responder.respond(match result { Ok(reply) => media_response(reply, &owner, head), Err(error) => failure_response(error, Some(&owner), head) });
    });
}

pub(crate) fn on_page_load(webview: &Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
        if let Some(state) = webview.app_handle().try_state::<ComfyMediaState>() { state.revoke_owner(Some(webview.label())); }
    }
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        if let Some(state) = window.app_handle().try_state::<ComfyMediaState>() { state.revoke_owner(Some(window.label())); }
    }
}

pub(crate) fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<ComfyMediaState>() { state.revoke_owner(None); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_requires_fixed_view_route_without_embedded_credentials() {
        assert!(media_url("http://localhost:8288/comfy/view?filename=movie.mp4&type=output").is_ok());
        for url in ["file:///private/video.mp4", "https://user:pass@host/view?filename=a", "https://host/view#private", "https://host/other?filename=a", "https://host/view?filename=a&filename=b"] {
            assert!(media_url(url).is_err());
        }
    }

    #[test]
    fn ranges_are_single_bounded_and_preserve_suffix_start() {
        assert_eq!(parse_range(None).unwrap_or(ByteRange::Suffix(0)), ByteRange::Initial);
        assert_eq!(bounded_range(ByteRange::From(7, None), None).ok(), Some((7, 7 + CHUNK_BYTES - 1)));
        assert_eq!(bounded_range(ByteRange::Suffix(20), Some(100)).ok(), Some((80, 99)));
        assert_eq!(bounded_range(ByteRange::Suffix(CHUNK_BYTES * 3), Some(CHUNK_BYTES * 4)).ok(), Some((CHUNK_BYTES, CHUNK_BYTES * 2 - 1)));
        for invalid in ["bytes=0-1,4-5", "bytes=-0", "bytes=4-3", "bytes=1 -3", "bytes=18446744073709551616-"] { assert!(parse_range(Some(invalid)).is_err()); }
        assert!(bounded_range(ByteRange::From(100, None), Some(100)).is_err());
    }

    #[test]
    fn rejects_unknown_totals_oversized_or_inconsistent_partial_content() {
        assert_eq!(content_range("bytes 0-9/100").ok(), Some((0, 9, 100)));
        for value in ["bytes 0-9/*", "bytes 10-9/100", "bytes 0-100/100", "bytes +0-9/100", "items 0-9/100"] { assert!(content_range(value).is_err()); }
        assert!(content_range(&format!("bytes 0-{CHUNK_BYTES}/{}", CHUNK_BYTES * 2)).is_err());
    }

    #[test]
    fn lengths_require_a_single_canonical_header_and_errors_never_look_successful() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("content-length", "100".parse().unwrap());
        assert_eq!(declared_length(&headers).unwrap(), Some(100));
        headers.append("content-length", "100".parse().unwrap());
        assert!(declared_length(&headers).is_err());
        headers.remove("content-length");
        headers.insert("content-length", "+100".parse().unwrap());
        assert!(declared_length(&headers).is_err());
        assert_eq!(Failure::upstream(206).status, StatusCode::BAD_GATEWAY);
        assert_eq!(Failure::upstream(403).status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn changed_media_metadata_revokes_the_whole_source() {
        let grant = Grant { owner: Owner { label: "main".into(), page: "tauri://localhost/".into(), origin: "tauri://localhost".into() },
            url: media_url("http://localhost/view?filename=a.mp4").unwrap(), cancel: CancellationToken::new(), representation: Mutex::new(None) };
        let information = Representation { total: 100, mime: "video/mp4".into(), etag: Some("first".into()), modified: None };
        grant.remember(information.clone()).unwrap();
        grant.remember(information.clone()).unwrap();
        assert!(grant.remember(Representation { etag: Some("second".into()), ..information }).is_err());
        assert!(grant.cancel.is_cancelled());
    }

    #[test]
    fn close_is_window_bound_and_cancels_active_reads() {
        let owner = Owner { label: "main".into(), page: "tauri://localhost/".into(), origin: "tauri://localhost".into() };
        let grant = Arc::new(Grant { owner: owner.clone(), url: media_url("http://localhost/view?filename=a.mp4").unwrap(), cancel: CancellationToken::new(), representation: Mutex::new(None) });
        let state = ComfyMediaState::default();
        state.grants.lock().unwrap().insert("a".repeat(64), grant.clone());
        let other = Owner { label: "asset-search".into(), ..owner.clone() };
        assert!(state.revoke(&"a".repeat(64), &other).is_err());
        assert!(!grant.cancel.is_cancelled());
        state.revoke(&"a".repeat(64), &owner).unwrap();
        assert!(grant.cancel.is_cancelled());
    }

    #[test]
    fn replies_expose_only_media_metadata_and_exact_owner_cors() {
        let owner = Owner { label: "main".into(), page: "http://localhost:1420/".into(), origin: "http://localhost:1420".into() };
        let reply = media_response(MediaReply { status: StatusCode::PARTIAL_CONTENT,
            metadata: Representation { total: 100, mime: "video/mp4".into(), etag: None, modified: None },
            start: Some(10), end: Some(12), body: vec![1, 2, 3] }, &owner, false);
        assert_eq!(reply.headers()[header::CONTENT_RANGE], "bytes 10-12/100");
        assert_eq!(reply.headers()[header::CONTENT_LENGTH], "3");
        assert_eq!(reply.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://localhost:1420");
        for name in ["set-cookie", "cookie", "authorization", "location", "referer"] { assert!(!reply.headers().contains_key(name)); }
    }
}
