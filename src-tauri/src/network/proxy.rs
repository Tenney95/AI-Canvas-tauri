//! 原生 HTTP 代理的传输、大小限额、上传诊断与取消。

use base64::Engine;
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use url::Url;

#[cfg(target_os = "macos")]
use crate::uguu_system_proxy;

static PROXY_FETCH_REQUEST_ID: AtomicU64 = AtomicU64::new(0);

const PROXY_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROXY_HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const PROXY_HTTP_MAX_IDLE_PER_HOST: usize = 8;
const PROXY_RESPONSE_MAX_BYTES: usize = 64 * 1024 * 1024;
// 兼容既有 64 MiB 视频素材，并给 multipart 头部留出空间。
const PROXY_REQUEST_MAX_BYTES: usize = 65 * 1024 * 1024;
const REMOTE_IMAGE_MAX_BYTES: usize = 25 * 1024 * 1024;

/// 通用 HTTP 代理：前端通过 invoke 调用，由 Rust 端发起 HTTP 请求，彻底绕过浏览器 CORS 限制。
/// 文本请求直接传 UTF-8，二进制请求和响应分块仍兼容 base64。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProxyFetchRequest {
    request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    upload_diagnostic_id: Option<String>,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>, // base64 编码的请求体
    text_body: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct UploadProxyEnvironment {
    name: String,
    value: String,
}

#[derive(Clone)]
struct UploadProxySnapshot {
    environment: Vec<UploadProxyEnvironment>,
    no_proxy_present: bool,
    time_ms: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadDiagnostics {
    http_version: String,
    remote_address: Option<String>,
    final_url: String,
    proxy_environment: Vec<UploadProxyEnvironment>,
    no_proxy_present: bool,
    proxy_snapshot_time_ms: u64,
    user_agent: String,
    proxy_policy: &'static str,
}

fn sanitized_upload_proxy(value: &str) -> String {
    let raw = value.trim();
    if raw.len() > 4096 || raw.chars().any(char::is_control) {
        return "configured".into();
    }
    let parsed = if raw.contains("://") {
        Url::parse(raw)
    } else {
        Url::parse(&format!("http://{raw}"))
    };
    let Ok(proxy) = parsed else { return "configured".into(); };
    let default_port = match proxy.scheme() {
        "http" => 80,
        "https" => 443,
        "socks4" | "socks4a" | "socks5" | "socks5h" => 1080,
        _ => return "configured".into(),
    };
    let Some(host) = proxy.host() else { return "configured".into(); };
    let host = match host {
        url::Host::Ipv6(address) => format!("[{address}]"),
        host => host.to_string(),
    };
    format!("{}://{}:{}", proxy.scheme(), host, proxy.port().unwrap_or(default_port))
}

impl UploadProxySnapshot {
    fn capture() -> Self {
        let mut environment = Vec::new();
        let mut no_proxy_present = false;
        for (name, value) in std::env::vars_os() {
            let Some(name) = name.to_str() else { continue; };
            let matches = |expected: &str| name == expected || cfg!(windows) && name.eq_ignore_ascii_case(expected);
            if ["NO_PROXY", "no_proxy"].into_iter().any(matches) {
                no_proxy_present = true;
            } else if ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].into_iter().any(matches) {
                environment.push(UploadProxyEnvironment {
                    name: name.into(),
                    value: value.to_str().map(sanitized_upload_proxy).unwrap_or_else(|| "configured".into()),
                });
            }
        }
        environment.sort_by(|left, right| left.name.cmp(&right.name));
        Self {
            environment,
            no_proxy_present,
            time_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64).unwrap_or(0),
        }
    }
}

fn upload_diagnostic_user_agent(req: &ProxyFetchRequest) -> Option<String> {
    let id = req.upload_diagnostic_id.as_deref()?;
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|value| value.is_ascii_alphanumeric() || b"._:-".contains(&value)) {
        return None;
    }
    Some(req.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
        .map(|(_, value)| value.clone()).unwrap_or_else(|| "AI-Canvas/0.1".into()))
}

fn sanitized_upload_response_url(url: &Url) -> String {
    let mut final_url = url.clone();
    let _ = final_url.set_username("");
    let _ = final_url.set_password(None);
    final_url.set_query(None);
    final_url.set_fragment(None);
    final_url.to_string()
}

fn upload_response_diagnostics(
    response: &reqwest::Response,
    snapshot: &UploadProxySnapshot,
    user_agent: String,
    proxy_policy: &'static str,
) -> UploadDiagnostics {
    UploadDiagnostics {
        http_version: format!("{:?}", response.version()),
        remote_address: response.remote_addr().map(|address| address.to_string()),
        final_url: sanitized_upload_response_url(response.url()),
        proxy_environment: snapshot.environment.clone(),
        no_proxy_present: snapshot.no_proxy_present,
        proxy_snapshot_time_ms: snapshot.time_ms,
        user_agent,
        proxy_policy,
    }
}

// 分别限制在途请求和提前到达的取消；128 项远高于正常模型与工具并发。
const PROXY_MAX_ACTIVE_REQUESTS: usize = 128;
const PROXY_MAX_EARLY_CANCELLATIONS: usize = 128;
const PROXY_MAX_REQUEST_ID_BYTES: usize = 256;
const PROXY_CANCELLATIONS_OVERFLOWED: &str =
    "HTTP 取消登记已满；为避免已停止的请求重新发送，已暂停新请求，请重启应用后重试";

#[derive(Default)]
struct ProxyCancellationRegistry {
    active: HashMap<String, Option<tokio::sync::oneshot::Sender<()>>>,
    early_cancelled: HashSet<String>,
    overflowed: bool,
}

type ProxyFetchCancellations = Mutex<ProxyCancellationRegistry>;

fn is_public_proxy_download(req: &ProxyFetchRequest) -> bool {
    if !matches!(req.method.as_str(), "GET" | "HEAD")
        || req.body.is_some()
        || req.text_body.is_some()
        || !req.headers.is_empty()
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&req.url) else {
        return false;
    };
    // 查询参数也可能承载任意名称的 Key，不能靠参数名猜测是否公开。
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
}

fn proxy_redirect_rejection(
    target: &reqwest::Url,
    previous: &[reqwest::Url],
    same_origin_only: bool,
) -> Option<&'static str> {
    // previous 的第一项是初始地址，和 reqwest 默认行为一样允许 10 次跳转。
    if previous.len() > 10 {
        return Some("HTTP 重定向次数超过上限");
    }
    if !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Some("HTTP 重定向地址不安全");
    }
    let (Some(origin), Some(source)) = (previous.first(), previous.last()) else {
        return Some("HTTP 重定向缺少来源信息");
    };
    if source.scheme() == "https" && target.scheme() != "https" {
        return Some("HTTP 重定向不能降低传输安全级别");
    }
    if same_origin_only && target.origin() != origin.origin() {
        return Some("带凭据或非公开的 HTTP 请求不能跨来源重定向");
    }
    None
}

fn build_proxy_http_client(
    same_origin_only: bool,
    proxy: Option<reqwest::Proxy>,
) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .user_agent("AI-Canvas/0.1")
        .connect_timeout(PROXY_HTTP_CONNECT_TIMEOUT)
        .pool_idle_timeout(PROXY_HTTP_POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(PROXY_HTTP_MAX_IDLE_PER_HOST)
        // 自动 Referer 会夹带上一跳的查询参数，公共下载也不应自动暴露它们。
        .referer(false)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if let Some(reason) = proxy_redirect_rejection(
                attempt.url(), attempt.previous(), same_origin_only,
            ) {
                attempt.error(reason)
            } else {
                attempt.follow()
            }
        }));
    let builder = match proxy {
        Some(proxy) => builder.proxy(proxy),
        None => builder,
    };
    builder.build().map_err(|error| format!("创建 HTTP 客户端失败: {error}"))
}

#[cfg(any(target_os = "macos", test))]
fn is_uguu_upload(req: &ProxyFetchRequest) -> bool {
    req.method == "POST" && req.url == "https://uguu.se/upload"
}

#[cfg(target_os = "macos")]
fn system_uguu_proxy(req: &ProxyFetchRequest) -> Option<reqwest::Proxy> {
    // 保留进程对 HTTPS 的显式代理配置。仅为固定 Uguu 上传入口补系统代理。
    if !is_uguu_upload(req)
        || ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
            .into_iter()
            .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        return None;
    }
    let proxy_url = uguu_system_proxy::https_proxy_url(&req.url)?;
    Some(reqwest::Proxy::https(proxy_url).ok()?.no_proxy(reqwest::NoProxy::from_env()))
}

pub(super) struct ProxyHttpState {
    pub(super) client: reqwest::Client,
    download_client: reqwest::Client,
    cancellations: ProxyFetchCancellations,
    body_slots: tokio::sync::Semaphore,
    upload_proxy_snapshot: UploadProxySnapshot,
}

impl ProxyHttpState {
    pub(super) fn new() -> Result<Self, String> {
        // 在本进程创建 HTTP 客户端时仅保留脱敏代理摘要，不读取其他进程环境。
        let upload_proxy_snapshot = UploadProxySnapshot::capture();
        Ok(Self {
            client: build_proxy_http_client(true, None)?,
            download_client: build_proxy_http_client(false, None)?,
            cancellations: Mutex::default(),
            body_slots: tokio::sync::Semaphore::new(2),
            upload_proxy_snapshot,
        })
    }
}

fn lock_proxy_fetch_cancellations(
    cancellations: &ProxyFetchCancellations,
) -> std::sync::MutexGuard<'_, ProxyCancellationRegistry> {
    cancellations
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn validate_proxy_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > PROXY_MAX_REQUEST_ID_BYTES {
        return Err("HTTP 请求 ID 无效，长度必须为 1–256 个 UTF-8 字节".into());
    }
    Ok(())
}

struct ProxyFetchCancellationRegistration<'a> {
    request_id: String,
    cancellations: &'a ProxyFetchCancellations,
}

impl<'a> ProxyFetchCancellationRegistration<'a> {
    fn register(
        cancellations: &'a ProxyFetchCancellations,
        request_id: String,
        sender: tokio::sync::oneshot::Sender<()>,
    ) -> Result<Self, String> {
        validate_proxy_request_id(&request_id)?;
        let mut items = lock_proxy_fetch_cancellations(cancellations);
        if items.active.contains_key(&request_id) {
            return Err("HTTP 请求 ID 重复，请等待原请求结束后重试".into());
        }
        if items.early_cancelled.remove(&request_id) {
            return Err("请求已取消".into());
        }
        if items.overflowed {
            return Err(PROXY_CANCELLATIONS_OVERFLOWED.into());
        }
        if items.active.len() >= PROXY_MAX_ACTIVE_REQUESTS {
            return Err("同时进行的 HTTP 请求已达 128 个，请等待已有请求结束后重试".into());
        }
        items.active.insert(request_id.clone(), Some(sender));
        drop(items);

        Ok(Self {
            request_id,
            cancellations,
        })
    }
}

impl Drop for ProxyFetchCancellationRegistration<'_> {
    fn drop(&mut self) {
        lock_proxy_fetch_cancellations(self.cancellations)
            .active
            .remove(&self.request_id);
    }
}

fn cancel_proxy_request(cancellations: &ProxyFetchCancellations, request_id: &str) -> Result<(), String> {
    validate_proxy_request_id(request_id)?;
    let cancellation = {
        let mut items = lock_proxy_fetch_cancellations(cancellations);
        if let Some(sender) = items.active.get_mut(request_id) {
            // 取消后仍保留占位，旧请求清理前不能让同 ID 的新请求注册进来。
            sender.take()
        } else {
            if items.early_cancelled.contains(request_id) {
                return Ok(());
            }
            if items.overflowed || items.early_cancelled.len() >= PROXY_MAX_EARLY_CANCELLATIONS {
                // 丢过的取消 ID 已无法还原，不能靠等待或清空 Map 重新放行。
                items.overflowed = true;
                return Err(PROXY_CANCELLATIONS_OVERFLOWED.into());
            }
            items.early_cancelled.insert(request_id.to_string());
            return Ok(());
        }
    };
    if let Some(sender) = cancellation {
        let _ = sender.send(());
    }
    Ok(())
}

pub(super) fn cancel_proxy_fetch(
    state: tauri::State<'_, ProxyHttpState>,
    request_id: String,
) -> Result<(), String> {
    cancel_proxy_request(&state.cancellations, &request_id)
}

async fn run_cancellable_proxy_request<T>(
    cancel_receiver: tokio::sync::oneshot::Receiver<()>,
    request: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancel_receiver => Err("请求已取消".to_string()),
        result = request => result,
    }
}

#[derive(Clone, serde::Serialize)]
pub(super) struct ProxyFetchResponse {
    status: u16,
    body: String, // base64 编码的响应体
    headers: Vec<(String, String)>,
    #[serde(rename = "uploadDiagnostics", skip_serializing_if = "Option::is_none")]
    upload_diagnostics: Option<UploadDiagnostics>,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub(super) enum ProxyFetchStreamEvent {
    Meta {
        status: u16,
        headers: Vec<(String, String)>,
        #[serde(rename = "uploadDiagnostics", skip_serializing_if = "Option::is_none")]
        upload_diagnostics: Option<UploadDiagnostics>,
    },
    Chunk {
        body: String,
    },
    Done,
}

fn proxy_transport_error(error: reqwest::Error) -> String {
    if error.is_redirect() {
        return "请求失败：HTTP 重定向被安全策略拒绝，请使用同源地址或最终资源地址。若这是生成提交，请先核对服务商任务记录，不要直接重发。".into();
    }
    let kind = if error.is_timeout() {
        "网络请求超时"
    } else if error.is_connect() {
        "无法建立网络连接"
    } else if error.is_body() {
        "请求体传输失败"
    } else {
        "发送请求或等待响应时连接失败"
    };
    // 只提取系统错误类别和错误码，不把 URL、查询参数或凭据写入历史。
    let mut source = std::error::Error::source(&error);
    let mut detail = String::new();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            detail = format!("（{:?}，系统错误码 {:?}）", io.kind(), io.raw_os_error());
            break;
        }
        source = cause.source();
    }
    format!("请求失败：{kind}{detail}。未收到有效 HTTP 响应，提交结果尚未确认，请先检查服务商任务记录。")
}

async fn send_proxy_request(
    state: &ProxyHttpState,
    req: ProxyFetchRequest,
) -> Result<(reqwest::Response, &'static str), String> {
    if req.body.is_some() && req.text_body.is_some() {
        return Err("请求体格式重复".into());
    }
    let has_body = req.body.is_some() || req.text_body.is_some();
    if req.text_body.as_ref().is_some_and(|body| body.len() > PROXY_REQUEST_MAX_BYTES)
        || req.body.as_ref().is_some_and(|body| {
            body.len() > PROXY_REQUEST_MAX_BYTES.div_ceil(3) * 4
        })
    {
        return Err("请求内容超过 65 MiB，请减少参考素材后重试".into());
    }
    let _body_slot = if has_body {
        Some(state.body_slots.acquire().await.map_err(|_| "请求队列已关闭")?)
    } else {
        None
    };
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("无效的 HTTP 方法: {e}"))?;
    #[cfg(target_os = "macos")]
    let system_proxy = system_uguu_proxy(&req);
    #[cfg(not(target_os = "macos"))]
    let system_proxy: Option<reqwest::Proxy> = None;
    let system_client = system_proxy
        .map(|proxy| build_proxy_http_client(true, Some(proxy)))
        .transpose()?;
    // Key 可以放进任意合法请求头，只有明确无调用方请求头的下载才允许跨来源。
    let (client, proxy_policy) = if let Some(client) = &system_client {
        (client, "macOS system proxy for Uguu; respects NO_PROXY")
    } else {
        let client = if is_public_proxy_download(&req) {
            &state.download_client
        } else {
            &state.client
        };
        (client, "reqwest automatic; actual route not exposed")
    };
    let mut request = client.request(method, &req.url);
    for (key, value) in req.headers {
        request = request.header(key, value);
    }
    if let Some(body) = req.text_body {
        request = request.body(body);
    } else if let Some(body) = req.body {
        if !body.is_empty() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&body)
                .map_err(|e| format!("请求体 base64 解码失败: {e}"))?;
            if bytes.len() > PROXY_REQUEST_MAX_BYTES {
                return Err("请求内容超过 65 MiB，请减少参考素材后重试".into());
            }
            request = request.body(bytes);
        }
    }

    let response = request.send().await.map_err(proxy_transport_error)?;
    Ok((response, proxy_policy))
}

fn ensure_content_length_within_limit(
    response: &reqwest::Response,
    max_bytes: usize,
    resource_name: &str,
) -> Result<(), String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!(
            "{resource_name}超过 Rust 端大小限制（最大 {} MiB）",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(())
}

fn checked_response_size(
    current_bytes: usize,
    chunk_bytes: usize,
    max_bytes: usize,
    resource_name: &str,
) -> Result<usize, String> {
    let next_bytes = current_bytes
        .checked_add(chunk_bytes)
        .ok_or_else(|| format!("{resource_name}大小计算溢出"))?;
    if next_bytes > max_bytes {
        return Err(format!(
            "{resource_name}超过 Rust 端大小限制（最大 {} MiB）",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(next_bytes)
}

async fn read_response_bytes_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
    resource_name: &str,
) -> Result<Vec<u8>, String> {
    ensure_content_length_within_limit(&response, max_bytes, resource_name)?;
    let initial_capacity = response.content_length().unwrap_or(0).min(max_bytes as u64) as usize;
    let mut body = Vec::with_capacity(initial_capacity);
    let mut total_bytes = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?
    {
        total_bytes = checked_response_size(total_bytes, chunk.len(), max_bytes, resource_name)?;
        body.extend_from_slice(&chunk);
    }

    Ok(body)
}

pub(super) async fn proxy_fetch(
    state: tauri::State<'_, ProxyHttpState>,
    req: ProxyFetchRequest,
) -> Result<ProxyFetchResponse, String> {
    let upload_user_agent = upload_diagnostic_user_agent(&req);
    let request_id = req.request_id.clone().unwrap_or_else(|| {
        format!(
            "legacy-proxy-{}",
            PROXY_FETCH_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let _cancellation = ProxyFetchCancellationRegistration::register(
        &state.cancellations,
        request_id,
        cancel_sender,
    )?;

    let request = async {
        let (response, proxy_policy) = send_proxy_request(&state, req).await?;
        let upload_diagnostics = upload_user_agent.map(|user_agent| {
            upload_response_diagnostics(&response, &state.upload_proxy_snapshot, user_agent, proxy_policy)
        });

        let status = response.status().as_u16();
        let res_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let res_bytes =
            read_response_bytes_limited(response, PROXY_RESPONSE_MAX_BYTES, "代理响应体").await?;
        let body_b64 = base64::engine::general_purpose::STANDARD.encode(&res_bytes);

        Ok(ProxyFetchResponse {
            status,
            body: body_b64,
            headers: res_headers,
            upload_diagnostics,
        })
    };

    run_cancellable_proxy_request(cancel_receiver, request).await
}

pub(super) async fn proxy_stream_fetch(
    state: tauri::State<'_, ProxyHttpState>,
    req: ProxyFetchRequest,
    on_event: Channel<ProxyFetchStreamEvent>,
) -> Result<(), String> {
    let upload_user_agent = upload_diagnostic_user_agent(&req);
    let request_id = req
        .request_id
        .clone()
        .ok_or_else(|| "流式 HTTP 请求缺少 requestId".to_string())?;
    let (cancel_sender, cancel_receiver) = tokio::sync::oneshot::channel();
    let _cancellation = ProxyFetchCancellationRegistration::register(
        &state.cancellations,
        request_id,
        cancel_sender,
    )?;

    let request = async {
        let (mut response, proxy_policy) = send_proxy_request(&state, req).await?;
        let upload_diagnostics = upload_user_agent.map(|user_agent| {
            upload_response_diagnostics(&response, &state.upload_proxy_snapshot, user_agent, proxy_policy)
        });
        ensure_content_length_within_limit(&response, PROXY_RESPONSE_MAX_BYTES, "代理响应体")?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_str().unwrap_or("").to_string()))
            .collect();
        on_event
            .send(ProxyFetchStreamEvent::Meta { status, headers, upload_diagnostics })
            .map_err(|e| format!("发送 HTTP 响应状态失败: {e}"))?;

        let mut total_bytes = 0;
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|error| format!("读取响应失败: {error}"))?
        {
            total_bytes = checked_response_size(
                total_bytes,
                bytes.len(),
                PROXY_RESPONSE_MAX_BYTES,
                "代理响应体",
            )?;
            let body = base64::engine::general_purpose::STANDARD.encode(bytes);
            on_event
                .send(ProxyFetchStreamEvent::Chunk { body })
                .map_err(|e| format!("发送 HTTP 响应数据失败: {e}"))?;
        }
        on_event
            .send(ProxyFetchStreamEvent::Done)
            .map_err(|e| format!("结束 HTTP 响应流失败: {e}"))?;
        Ok(())
    };

    run_cancellable_proxy_request(cancel_receiver, request).await
}

/// 使用原生 HTTP 客户端下载远程图片并返回 base64 data URL（绕过 WebView CORS 限制）
pub(super) async fn fetch_image_data_url(
    state: tauri::State<'_, ProxyHttpState>,
    url: String,
) -> Result<String, String> {
    let (response, _) = send_proxy_request(&state, ProxyFetchRequest {
        request_id: None,
        upload_diagnostic_id: None,
        url: url.clone(),
        method: "GET".into(),
        headers: Vec::new(),
        body: None,
        text_body: None,
    }).await?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    // 从 Content-Type 头推导 MIME（提前提取为 String，避免借用冲突）
    let mime = {
        let ct = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            .unwrap_or("image/png")
            .trim();
        if ct.starts_with("image/") {
            ct.to_string()
        } else {
            // 从 URL 后缀推导
            let lower = url.to_lowercase();
            let guess = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
                "image/jpeg"
            } else if lower.ends_with(".gif") {
                "image/gif"
            } else if lower.ends_with(".webp") {
                "image/webp"
            } else if lower.ends_with(".bmp") {
                "image/bmp"
            } else if lower.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "image/png"
            };
            guess.to_string()
        }
    };

    let bytes = read_response_bytes_limited(response, REMOTE_IMAGE_MAX_BYTES, "远程图片").await?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod proxy_http_tests;
