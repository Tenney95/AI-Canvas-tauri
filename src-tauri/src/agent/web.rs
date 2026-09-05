//! Agent 网页搜索与公开页面读取的原生安全边界。
//! 仅允许固定搜索端点和通过 DNS/IP、重定向及体积检查的公开 HTTP(S) 地址。

use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::{Host, Url};

const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const BOCHA_SEARCH_URL: &str = "https://api.bocha.cn/v1/web-search";
const ZHIPU_SEARCH_URL: &str = "https://open.bigmodel.cn/api/paas/v4/web_search";
const EXA_SEARCH_URL: &str = "https://api.exa.ai/search";
const CLOUDFLARE_DOH_URL: &str = "https://cloudflare-dns.com/dns-query";
const MAX_RESPONSE_BYTES: usize = 1_000_000;
const MAX_REDIRECTS: usize = 5;
const MAX_URL_CHARS: usize = 2_048;
// 中转站文档这类 SPA 的 load 事件常卡在 15s 边缘（实测成功时耗时 15.5~16.3s），
// 卡在阈值上会时成时败；放宽到 25s，与下方 HTTP 读取的超时保持一致。
const RENDER_LOAD_TIMEOUT: Duration = Duration::from_secs(25);
const RENDER_EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const RENDER_SETTLE_INTERVAL: Duration = Duration::from_millis(500);
const RENDER_SETTLE_SAMPLES: usize = 20;
const RENDER_MIN_TEXT_LENGTH: usize = 200;
// 网络静默判定：连续 N 个采样周期内没有新增网络请求，视为页面已停止加载数据。
const RENDER_NETWORK_QUIET_SAMPLES: usize = 3;
// 受控交互与页内遍历的预算上限。
const RENDER_INTERACT_TIMEOUT: Duration = Duration::from_secs(180);
const RENDER_SCROLL_STEPS: usize = 10;
const RENDER_SCROLL_INTERVAL: Duration = Duration::from_millis(300);
const RENDER_EXPAND_MAX_CLICKS: usize = 20;
const RENDER_TRAVERSE_MAX_PAGES: usize = 5;
const RENDER_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src https:; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const RENDER_INIT_SCRIPT: &str = r#"
(() => {
  const blocked = () => Promise.reject(new TypeError('Blocked by AI Canvas read-only renderer'));
  const isReadOnlyHttpsGet = (input, init = {}) => {
    try {
      const request = input instanceof Request ? input : null;
      const method = String(init.method || request?.method || 'GET').toUpperCase();
      if (method !== 'GET') return false;
      if (init.body != null) return false;
      const rawUrl = request?.url || String(input);
      const parsed = new URL(rawUrl, window.location.href);
      // 只允许公开 HTTPS 读取，不携带任何凭据；仍禁止 http/data/blob 等协议。
      return parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  try {
    const nativeFetch = window.fetch.bind(window);
    Object.defineProperty(window, 'fetch', {
      configurable: false,
      writable: false,
      value: (input, init = {}) => isReadOnlyHttpsGet(input, init)
        ? nativeFetch(input, { ...init, method: 'GET', credentials: 'omit' })
        : blocked(),
    });
  } catch {}

  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      const allowed = String(method).toUpperCase() === 'GET'
        && (() => { try { return new URL(String(url), window.location.href).protocol === 'https:'; } catch { return false; } })();
      Object.defineProperty(this, '__aiCanvasReadAllowed', { value: allowed });
      return nativeOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (!this.__aiCanvasReadAllowed || body != null) {
        this.abort();
        throw new TypeError('Blocked by AI Canvas read-only renderer');
      }
      this.withCredentials = false;
      return nativeSend.call(this, null);
    };
  } catch {}

  for (const key of ['WebSocket', 'EventSource']) {
    try {
      Object.defineProperty(window, key, {
        configurable: false,
        writable: false,
        value: function() { throw new TypeError('Blocked by AI Canvas read-only renderer'); },
      });
    } catch {}
  }
  try { navigator.sendBeacon = () => false; } catch {}
  try { navigator.serviceWorker.register = blocked; } catch {}
  window.addEventListener('submit', (event) => event.preventDefault(), true);
})();
"#;

static RENDER_WINDOW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WebSearchProvider {
    Tavily,
    Bocha,
    ZhipuSearch,
    Exa,
}

impl WebSearchProvider {
    fn label(self) -> &'static str {
        match self {
            Self::Tavily => "Tavily",
            Self::Bocha => "博查",
            Self::ZhipuSearch => "智谱",
            Self::Exa => "Exa",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Tavily => TAVILY_SEARCH_URL,
            Self::Bocha => BOCHA_SEARCH_URL,
            Self::ZhipuSearch => ZHIPU_SEARCH_URL,
            Self::Exa => EXA_SEARCH_URL,
        }
    }
}

fn build_search_payload(
    provider: WebSearchProvider,
    query: &str,
    max_results: u8,
    topic: &str,
) -> serde_json::Value {
    match provider {
        WebSearchProvider::Tavily => serde_json::json!({
            "query": query,
            "search_depth": "basic",
            "topic": topic,
            "max_results": max_results,
            "include_answer": false,
            "include_raw_content": false,
            "include_images": false
        }),
        WebSearchProvider::Bocha => serde_json::json!({
            "query": query,
            "summary": true,
            "freshness": if topic == "news" { "oneWeek" } else { "noLimit" },
            "count": max_results
        }),
        WebSearchProvider::ZhipuSearch => serde_json::json!({
            "search_query": query,
            "search_engine": "search_std",
            "search_intent": false,
            "count": max_results,
            "search_recency_filter": if topic == "news" { "oneWeek" } else { "noLimit" },
            "content_size": "medium"
        }),
        WebSearchProvider::Exa => serde_json::json!({
            "query": query,
            "type": "auto",
            "numResults": max_results,
            "contents": { "highlights": true }
        }),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantWebSearchRequest {
    provider: Option<WebSearchProvider>,
    api_key: String,
    query: String,
    max_results: Option<u8>,
    topic: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantWebSearchResponse {
    body: String,
    fetched_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantWebReadResponse {
    url: String,
    content_type: String,
    body: String,
    fetched_at: u64,
    read_method: &'static str,
    complete: bool,
    issues: Vec<WebReadIssue>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pages: Vec<CapturedWebPage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum WebReadIssue {
    PageLimit,
    BodyLimit,
    Timeout,
    NavigationFailed,
    DuplicatePage,
    EmptyPage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedWebPage {
    url: String,
    title: Option<String>,
    content_type: &'static str,
    body: String,
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderedPagePayload {
    url: String,
    html: String,
    error: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    truncated: bool,
}

/// 放在超时 future 之外，后续页失败或取消 future 时仍保留已完成的页面。
#[derive(Default)]
struct RenderedPageCapture {
    pages: Vec<CapturedWebPage>,
    body_bytes: usize,
    issues: Vec<WebReadIssue>,
}

impl RenderedPageCapture {
    fn note(&mut self, issue: WebReadIssue) {
        if !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }

    fn push(&mut self, page: RenderedPagePayload, origin: &Url) -> Result<(), WebReadIssue> {
        if self.pages.len() >= RENDER_TRAVERSE_MAX_PAGES {
            return Err(WebReadIssue::PageLimit);
        }
        if page
            .error
            .as_deref()
            .is_some_and(|error| !error.trim().is_empty())
        {
            return Err(WebReadIssue::NavigationFailed);
        }
        let url = validate_url_shape(&page.url).map_err(|_| WebReadIssue::NavigationFailed)?;
        if !same_origin(origin, &url) {
            return Err(WebReadIssue::NavigationFailed);
        }
        if page.html.trim().is_empty() {
            return Err(WebReadIssue::EmptyPage);
        }
        if self
            .pages
            .iter()
            .any(|saved| saved.url == url.as_str() && saved.body == page.html)
        {
            return Err(WebReadIssue::DuplicatePage);
        }
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(self.body_bytes);
        let truncated = page.truncated || page.html.len() > remaining;
        let body = truncate_utf8_bytes(page.html, remaining);
        if body.trim().is_empty() {
            return Err(WebReadIssue::BodyLimit);
        }
        self.body_bytes += body.len();
        self.pages.push(CapturedWebPage {
            url: url.to_string(),
            title: page.title.map(|title| title.chars().take(300).collect()),
            content_type: "text/html; charset=utf-8",
            body,
            truncated,
        });
        if truncated {
            self.note(WebReadIssue::BodyLimit);
        }
        Ok(())
    }

    fn into_response(self) -> Result<AssistantWebReadResponse, String> {
        let first = self.pages.first().ok_or("动态网页渲染后没有可读取的正文")?;
        Ok(AssistantWebReadResponse {
            url: first.url.clone(),
            content_type: "text/html; charset=utf-8".to_string(),
            // 新响应只在 pages 中携带正文，不重复拼接以免突破总量预算或错配来源。
            body: String::new(),
            fetched_at: now_millis(),
            read_method: "rendered",
            complete: self.issues.is_empty(),
            issues: self.issues,
            pages: self.pages,
        })
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_disallowed_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.is_unspecified()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240
}

fn is_proxy_fake_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            let octets = value.octets();
            octets[0] == 198 && (18..=19).contains(&octets[1])
        }
        IpAddr::V6(_) => false,
    }
}

fn is_disallowed_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_disallowed_ipv4(mapped);
    }
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] & 0xe000) != 0x2000
}

fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => is_disallowed_ipv4(value),
        IpAddr::V6(value) => is_disallowed_ipv6(value),
    }
}

fn normalized_query_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| !matches!(character, ' ' | '\t' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_sensitive_query_key(value: &str) -> bool {
    matches!(
        normalized_query_key(value).as_str(),
        "apikey"
            | "authorization"
            | "auth"
            | "credential"
            | "key"
            | "password"
            | "secret"
            | "sig"
            | "signature"
            | "token"
            | "accesstoken"
    )
}

fn validate_url_shape(raw_url: &str) -> Result<Url, String> {
    if raw_url.chars().count() > MAX_URL_CHARS {
        return Err("网页 URL 过长".to_string());
    }
    let url = Url::parse(raw_url).map_err(|_| "网页 URL 无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许读取 HTTP(S) 网页".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网页 URL 不允许包含用户名或密码".to_string());
    }
    if url
        .query_pairs()
        .any(|(key, _)| is_sensitive_query_key(&key))
    {
        return Err("网页 URL 不允许包含凭据或签名查询参数".to_string());
    }
    let host = url
        .host()
        .ok_or_else(|| "网页 URL 缺少主机名".to_string())?;
    if let Host::Domain(domain) = host {
        let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
        if normalized == "localhost"
            || normalized.ends_with(".localhost")
            || normalized.ends_with(".local")
            || normalized.ends_with(".internal")
            || normalized.ends_with(".home.arpa")
        {
            return Err("不允许读取本机或内部域名".to_string());
        }
    }
    if let Host::Ipv4(ip) = host {
        if is_disallowed_ipv4(ip) {
            return Err("不允许读取非公网 IPv4 地址".to_string());
        }
    }
    if let Host::Ipv6(ip) = host {
        if is_disallowed_ipv6(ip) {
            return Err("不允许读取非公网 IPv6 地址".to_string());
        }
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "网页 URL 端口无效".to_string())?;
    if !matches!(port, 80 | 443) {
        return Err("网页读取只允许标准 HTTP/HTTPS 端口".to_string());
    }
    Ok(url)
}

fn same_origin(expected: &Url, candidate: &Url) -> bool {
    expected.scheme() == candidate.scheme()
        && expected.host_str().map(str::to_ascii_lowercase)
            == candidate.host_str().map(str::to_ascii_lowercase)
        && expected.port_or_known_default() == candidate.port_or_known_default()
}

fn truncate_utf8_bytes(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionRoute {
    Pinned(SocketAddr),
    SystemResolverAfterDoh,
}

#[derive(Deserialize)]
struct DohResponse {
    #[serde(rename = "Status")]
    status: u16,
    #[serde(rename = "Answer", default)]
    answers: Vec<DohAnswer>,
}

#[derive(Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    record_type: u16,
    data: String,
}

fn classify_resolved_addresses(
    url: &Url,
    addresses: &[SocketAddr],
) -> Result<ConnectionRoute, String> {
    if addresses.is_empty() {
        return Err("网页域名没有可用地址".to_string());
    }
    if addresses
        .iter()
        .all(|address| is_proxy_fake_ip(address.ip()))
    {
        if url.scheme() != "https" {
            return Err("代理 fake-IP 网页只允许通过 HTTPS 读取".to_string());
        }
        return Ok(ConnectionRoute::SystemResolverAfterDoh);
    }
    if addresses
        .iter()
        .any(|address| is_disallowed_ip(address.ip()))
    {
        return Err("网页域名解析到了非公网地址".to_string());
    }
    Ok(ConnectionRoute::Pinned(addresses[0]))
}

fn validate_doh_response(response: DohResponse) -> Result<(), String> {
    if response.status != 0 {
        return Err(format!("公网 DNS 校验失败（状态码 {}）", response.status));
    }
    let mut found_address = false;
    for answer in response
        .answers
        .into_iter()
        .filter(|answer| answer.record_type == 1)
    {
        let address = answer
            .data
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| "公网 DNS 返回了无效 IPv4 地址".to_string())?;
        found_address = true;
        if is_disallowed_ipv4(address) {
            return Err("公网 DNS 将网页域名解析到了非公网地址".to_string());
        }
    }
    if !found_address {
        return Err("公网 DNS 没有返回可用 IPv4 地址".to_string());
    }
    Ok(())
}

fn validate_host_with_doh(host: &str) -> Result<(), String> {
    let client = ClientBuilder::new()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("创建公网 DNS 校验客户端失败: {error}"))?;
    let response = client
        .get(CLOUDFLARE_DOH_URL)
        .query(&[("name", host), ("type", "A")])
        .header(ACCEPT, "application/dns-json")
        .header(USER_AGENT, "AI-Canvas-Agent/0.6")
        .send()
        .map_err(|error| format!("公网 DNS 校验请求失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "公网 DNS 校验返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let payload = read_limited(response)?;
    let response = serde_json::from_slice::<DohResponse>(&payload)
        .map_err(|error| format!("解析公网 DNS 校验响应失败: {error}"))?;
    validate_doh_response(response)
}

fn resolve_connection_route(url: &Url) -> Result<ConnectionRoute, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "网页 URL 缺少主机名".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "网页 URL 端口无效".to_string())?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| "网页域名解析失败".to_string())?
        .collect::<Vec<_>>();
    let route = classify_resolved_addresses(url, &addresses)?;
    if route == ConnectionRoute::SystemResolverAfterDoh {
        validate_host_with_doh(host)?;
    }
    Ok(route)
}

fn page_client(host: &str, route: ConnectionRoute) -> Result<Client, String> {
    let builder = ClientBuilder::new()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25));
    let builder = match route {
        ConnectionRoute::Pinned(address) => builder.resolve(host, address),
        ConnectionRoute::SystemResolverAfterDoh => builder,
    };
    builder
        .build()
        .map_err(|error| format!("创建安全网页客户端失败: {error}"))
}

fn read_limited(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("网页响应超过 1 MB 限制".to_string());
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取网页响应失败: {error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("网页响应超过 1 MB 限制".to_string());
    }
    Ok(bytes)
}

fn read_public_page(raw_url: String) -> Result<AssistantWebReadResponse, String> {
    let mut current_url = validate_url_shape(&raw_url)?;
    current_url.set_fragment(None);

    for redirect_count in 0..=MAX_REDIRECTS {
        let route = resolve_connection_route(&current_url)?;
        let host = current_url
            .host_str()
            .ok_or_else(|| "网页 URL 缺少主机名".to_string())?;
        let client = page_client(host, route)?;
        let response = client
            .get(current_url.as_str())
            .header(USER_AGENT, "AI-Canvas-Agent/0.6")
            .send()
            .map_err(|error| format!("网页请求失败: {error}"))?;
        let status = response.status();

        if status.is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("网页重定向次数超过限制".to_string());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "网页重定向缺少 Location".to_string())?;
            current_url = validate_url_shape(
                current_url
                    .join(location)
                    .map_err(|_| "网页重定向地址无效".to_string())?
                    .as_str(),
            )?;
            current_url.set_fragment(None);
            continue;
        }

        if !status.is_success() {
            return Err(format!("网页返回 HTTP {}", status.as_u16()));
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("text/plain")
            .to_ascii_lowercase();
        if !content_type.starts_with("text/")
            && !content_type.starts_with("application/xhtml+xml")
            && !content_type.starts_with("application/json")
            && !content_type.starts_with("application/xml")
            && !content_type.starts_with("application/rss+xml")
            && !content_type.starts_with("application/atom+xml")
        {
            return Err("网页内容类型不受支持".to_string());
        }
        let body = String::from_utf8_lossy(&read_limited(response)?).into_owned();
        return Ok(AssistantWebReadResponse {
            url: current_url.to_string(),
            content_type,
            body,
            fetched_at: now_millis(),
            read_method: "static",
            complete: true,
            issues: Vec::new(),
            pages: Vec::new(),
        });
    }
    Err("网页读取失败".to_string())
}

async fn evaluate_webview_json<T: DeserializeOwned>(
    webview: &WebviewWindow,
    script: &str,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    webview
        .eval_with_callback(script, move |value| {
            if let Ok(mut sender) = callback_sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(value);
                }
            }
        })
        .map_err(|error| format!("执行网页渲染脚本失败: {error}"))?;
    let raw = tokio::time::timeout(RENDER_EVAL_TIMEOUT, receiver)
        .await
        .map_err(|_| "读取网页渲染结果超时".to_string())?
        .map_err(|_| "网页渲染结果通道已关闭".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("解析网页渲染结果失败: {error}"))
}

async fn collect_rendered_page(webview: &WebviewWindow) -> Result<RenderedPagePayload, String> {
    let mut previous_length = None;
    let mut stable_samples = 0usize;
    let mut quiet_samples = 0usize;

    for sample_index in 0..RENDER_SETTLE_SAMPLES {
        tokio::time::sleep(RENDER_SETTLE_INTERVAL).await;
        // 正文长度 + 网络资源计数一起看：既等正文出现，也等不再有新的网络请求。
        // 资源计数在下方 network_quiet 判断处单独获取，这里仅取正文长度用于稳定判定。
        let (text_length, _resource_count) = evaluate_webview_json::<(usize, usize)>(
            webview,
            r#"(() => {
              const len = document.body ? document.body.innerText.length : 0;
              let count = 0;
              try { count = performance.getEntriesByType('resource').length; } catch {}
              return [len, count];
            })()"#,
        )
        .await?;
        if previous_length == Some(text_length) {
            stable_samples += 1;
        } else {
            previous_length = Some(text_length);
            stable_samples = 0;
        }

        let network_quiet = evaluate_webview_json::<bool>(
            webview,
            r#"(() => {
              try {
                const now = performance.now();
                const pending = performance.getEntriesByType('resource')
                  .filter((entry) => entry.responseEnd === 0 || entry.responseEnd >= now)
                  .length;
                return pending === 0;
              } catch { return true; }
            })()"#,
        )
        .await?;
        quiet_samples = if network_quiet { quiet_samples + 1 } else { 0 };

        // 正文达到一定规模、长度已稳定、且网络已静默多轮 → 认为渲染完成。
        let has_content = text_length >= RENDER_MIN_TEXT_LENGTH;
        if sample_index >= 3
            && stable_samples >= 2
            && has_content
            && quiet_samples >= RENDER_NETWORK_QUIET_SAMPLES
        {
            break;
        }
    }

    extract_rendered_payload(webview).await
}

/// 从当前 webview 页面提取净化后的正文负载（优先主内容区、剔除导航/页脚等噪声）。
async fn extract_rendered_payload(webview: &WebviewWindow) -> Result<RenderedPagePayload, String> {
    evaluate_webview_json(
        webview,
        r#"(() => {
          try {
            if (!document.documentElement) {
              return { url: location.href, html: '', error: '页面没有可读取的文档节点' };
            }
            // 优先取主内容区，去掉侧边导航、页脚等噪声。
            const root = document.querySelector('main, article, [role="main"]')
              || document.querySelector('#content, #app, .content, .markdown-body')
              || document.body;
            const clone = root.cloneNode(true);
            clone.querySelectorAll('script, style, noscript, iframe, object, embed, form, nav, aside, footer, header')
              .forEach((node) => node.remove());
            clone.querySelectorAll('*').forEach((node) => {
              for (const attribute of [...node.attributes]) {
                const name = attribute.name.toLowerCase();
                if (name.startsWith('on') || ['src', 'srcset', 'poster', 'style', 'value'].includes(name)) {
                  node.removeAttribute(attribute.name);
                }
              }
            });
            const html = `<!doctype html>${clone.outerHTML}`;
            return {
              url: location.href,
              title: (document.title || '').slice(0, 300),
              html: html.slice(0, 1000000),
              truncated: html.length > 1000000,
              error: null,
            };
          } catch (error) {
            return { url: location.href, html: '', error: String(error) };
          }
        })()"#,
    )
    .await
}

/// 在页面内做受控交互：逐段滚动触发懒加载，并点击展开/折叠类元素以显形隐藏正文。
/// 交互仍限定在当前页面内，不触发跳转、不提交表单。
async fn interact_and_expand(webview: &WebviewWindow) -> Result<(), String> {
    // 逐段滚动，触发懒加载内容。
    for _ in 0..RENDER_SCROLL_STEPS {
        let scrolled = evaluate_webview_json::<bool>(
            webview,
            r#"(() => {
              try {
                window.scrollBy(0, window.innerHeight);
                return true;
              } catch { return false; }
            })()"#,
        )
        .await?;
        if !scrolled {
            break;
        }
        tokio::time::sleep(RENDER_SCROLL_INTERVAL).await;
    }
    // 回到顶部，避免滚动位置影响后续抓取。
    let _ = evaluate_webview_json::<bool>(
        webview,
        "(() => { try { window.scrollTo(0, 0); return true; } catch { return false; } })()",
    )
    .await;

    // 点击展开/折叠类元素，最多 RENDER_EXPAND_MAX_CLICKS 次。
    for _ in 0..RENDER_EXPAND_MAX_CLICKS {
        let clicked = evaluate_webview_json::<usize>(
            webview,
            r#"(() => {
              try {
                const candidates = [];
                document.querySelectorAll('[aria-expanded="false"], summary, button, [role="button"]')
                  .forEach((node) => {
                    if (candidates.length >= 20) return;
                    const text = (node.textContent || '').trim();
                    const tag = node.tagName.toLowerCase();
                    const isExpand = tag === 'summary'
                      || node.getAttribute('aria-expanded') === 'false'
                      || /展开|更多|收起|查看|详情|expand|more|show|read\s*more/i.test(text);
                    if (isExpand && node.offsetParent !== null) {
                      candidates.push(node);
                    }
                  });
                const target = candidates[0];
                if (!target) return 0;
                target.click();
                return 1;
              } catch { return 0; }
            })()"#,
        )
        .await?;
        if clicked == 0 {
            break;
        }
        tokio::time::sleep(RENDER_SCROLL_INTERVAL).await;
    }

    Ok(())
}

/// 尝试点击同源的“下一页”链接并等待内容变化，返回是否成功翻页。
/// 仅跟随同源链接；SPA 内部切换会直接更新 DOM，真跳转则由 on_navigation 的同源约束兜底。
async fn click_next_page(webview: &WebviewWindow, follow: bool) -> Result<bool, String> {
    // 达到页数上限时只检查是否还有下一页，不导航到未经读取的第六页。
    let script = r#"(() => {
          try {
            const anchors = [...document.querySelectorAll('a[href]')];
            const next = anchors.find((a) => {
              const text = (a.textContent || '').trim();
              const rel = (a.getAttribute('rel') || '').toLowerCase().split(/\s+/);
              return (rel.includes('next') || /^(下一页|下一頁|next|›|»|>)$/i.test(text))
                && a.getAttribute('aria-disabled') !== 'true';
            });
            if (!next) return false;
            const url = new URL(next.getAttribute('href'), location.href);
            if (url.origin !== location.origin) return null;
            if (__FOLLOW_NEXT_PAGE__) next.click();
            return true;
          } catch { return null; }
        })()"#
        .replace(
            "__FOLLOW_NEXT_PAGE__",
            if follow { "true" } else { "false" },
        );
    let clicked = evaluate_webview_json::<bool>(webview, &script).await?;
    if !clicked {
        return Ok(false);
    }
    // 等新页内容加载。
    if follow {
        tokio::time::sleep(RENDER_SETTLE_INTERVAL).await;
    }
    Ok(true)
}

async fn render_public_page(
    app: AppHandle,
    raw_url: String,
) -> Result<AssistantWebReadResponse, String> {
    let initial_url = tauri::async_runtime::spawn_blocking(move || {
        let mut url = validate_url_shape(&raw_url)?;
        if url.scheme() != "https" {
            return Err("动态网页渲染只允许公开 HTTPS 页面".to_string());
        }
        url.set_fragment(None);
        resolve_connection_route(&url)?;
        Ok::<Url, String>(url)
    })
    .await
    .map_err(|error| format!("网页渲染地址校验失败: {error}"))??;

    let sequence = RENDER_WINDOW_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let label = format!("assistant-web-render-{}-{sequence}", now_millis());
    let navigation_origin = initial_url.clone();
    let resource_origin = initial_url.clone();
    let load_origin = initial_url.clone();
    let (load_sender, load_receiver) = tokio::sync::oneshot::channel::<()>();
    let load_sender = Arc::new(Mutex::new(Some(load_sender)));
    let page_load_sender = Arc::clone(&load_sender);

    let webview = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(initial_url.clone()))
        .title("AI Canvas 受控网页渲染")
        .inner_size(960.0, 720.0)
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        .incognito(true)
        .initialization_script(RENDER_INIT_SCRIPT)
        .on_navigation(move |candidate| same_origin(&navigation_origin, candidate))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_web_resource_request(move |request, response| {
            let Ok(request_url) = Url::parse(&request.uri().to_string()) else {
                return;
            };
            if !same_origin(&resource_origin, &request_url) {
                return;
            }
            let is_html = response
                .headers()
                .get(tauri::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"));
            if is_html {
                response.headers_mut().insert(
                    tauri::http::header::CONTENT_SECURITY_POLICY,
                    tauri::http::HeaderValue::from_static(RENDER_CSP),
                );
            }
        })
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && same_origin(&load_origin, payload.url())
            {
                if let Ok(mut sender) = page_load_sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(());
                    }
                }
            }
        })
        .build()
        .map_err(|error| format!("创建受控网页渲染器失败: {error}"))?;

    let result = async {
        tokio::time::timeout(RENDER_LOAD_TIMEOUT, load_receiver)
            .await
            .map_err(|_| "动态网页加载超时".to_string())?
            .map_err(|_| "动态网页加载监听已关闭".to_string())?;

        // 受控交互（滚动 + 展开折叠）与同源页内遍历，统一受 180 秒硬超时约束。
        // 该步骤失败不致命：保留每一份已抓到的正文，并准确报告部分读取。
        let mut capture = RenderedPageCapture::default();
        let enriched = tokio::time::timeout(RENDER_INTERACT_TIMEOUT, async {
            loop {
                interact_and_expand(&webview)
                    .await
                    .map_err(|_| WebReadIssue::NavigationFailed)?;
                let page = collect_rendered_page(&webview)
                    .await
                    .map_err(|_| WebReadIssue::NavigationFailed)?;
                capture.push(page, &initial_url)?;
                if capture.issues.contains(&WebReadIssue::BodyLimit) {
                    break;
                }
                let at_page_limit = capture.pages.len() >= RENDER_TRAVERSE_MAX_PAGES;
                let has_next = click_next_page(&webview, !at_page_limit)
                    .await
                    .map_err(|_| WebReadIssue::NavigationFailed)?;
                if !has_next {
                    break;
                }
                if at_page_limit {
                    capture.note(WebReadIssue::PageLimit);
                    break;
                }
            }
            Ok::<(), WebReadIssue>(())
        })
        .await;

        match enriched {
            Ok(Ok(())) => {}
            Ok(Err(issue)) => capture.note(issue),
            Err(_) => capture.note(WebReadIssue::Timeout),
        }
        // 只有一页都没取到时才尝试一次受限提取；不再用末页覆盖此前成功页。
        if capture.pages.is_empty() {
            let page = extract_rendered_payload(&webview).await?;
            capture
                .push(page, &initial_url)
                .map_err(|_| "动态网页渲染后没有可读取的安全正文".to_string())?;
        }
        capture.into_response()
    }
    .await;

    let _ = webview.close();
    result
}

#[tauri::command]
pub async fn assistant_web_search(
    request: AssistantWebSearchRequest,
) -> Result<AssistantWebSearchResponse, String> {
    let api_key = request.api_key.trim().to_string();
    let query = request.query.trim().to_string();
    let provider = request.provider.unwrap_or(WebSearchProvider::Tavily);
    if api_key.is_empty() {
        return Err(format!("未配置 {} API Key", provider.label()));
    }
    if query.is_empty() || query.chars().count() > 500 {
        return Err("搜索词长度必须为 1-500 个字符".to_string());
    }
    if matches!(provider, WebSearchProvider::ZhipuSearch) && query.chars().count() > 70 {
        return Err("智谱联网搜索的搜索词不能超过 70 个字符".to_string());
    }
    let max_results = request.max_results.unwrap_or(5).clamp(1, 10);
    let topic = match request.topic.as_deref() {
        Some("news") => "news",
        Some("finance") => "finance",
        _ => "general",
    };

    tauri::async_runtime::spawn_blocking(move || {
        let payload = build_search_payload(provider, &query, max_results, topic);
        let body =
            serde_json::to_vec(&payload).map_err(|error| format!("构建搜索请求失败: {error}"))?;
        let client = ClientBuilder::new()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|error| format!("创建搜索客户端失败: {error}"))?;
        let request = client
            .post(provider.endpoint())
            .header(USER_AGENT, "AI-Canvas-Agent/0.6")
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        let request = match provider {
            WebSearchProvider::Exa => request.header("x-api-key", api_key),
            _ => request.header(AUTHORIZATION, format!("Bearer {api_key}")),
        };
        let response = request
            .send()
            .map_err(|error| format!("搜索请求失败: {error}"))?;
        let status = response.status().as_u16();
        let response_body = String::from_utf8_lossy(&read_limited(response)?).into_owned();
        if !(200..300).contains(&status) {
            return Err(format!("{} 搜索失败（HTTP {status}）", provider.label()));
        }
        Ok(AssistantWebSearchResponse {
            body: response_body,
            fetched_at: now_millis(),
        })
    })
    .await
    .map_err(|error| format!("搜索任务执行失败: {error}"))?
}

#[tauri::command]
pub async fn assistant_web_extract(url: String) -> Result<AssistantWebReadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || read_public_page(url))
        .await
        .map_err(|error| format!("网页读取任务执行失败: {error}"))?
}

#[tauri::command]
pub async fn assistant_web_render(
    app: AppHandle,
    url: String,
) -> Result<AssistantWebReadResponse, String> {
    render_public_page(app, url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered_fixture(index: usize, html: String) -> RenderedPagePayload {
        RenderedPagePayload {
            url: format!("https://example.com/chapter-{index}/page"),
            title: Some(format!("Chapter {index}")),
            html,
            error: None,
            truncated: false,
        }
    }

    #[test]
    fn rendered_pages_keep_independent_bodies_urls_and_titles_without_duplicate_body() {
        let origin = Url::parse("https://example.com/start").unwrap();
        for count in 2..=RENDER_TRAVERSE_MAX_PAGES {
            let mut capture = RenderedPageCapture::default();
            for index in 1..=count {
                capture
                    .push(
                        rendered_fixture(index, format!("<main>PAGE_{index}</main>")),
                        &origin,
                    )
                    .unwrap();
            }
            let response = capture.into_response().unwrap();
            assert!(response.complete);
            assert!(response.body.is_empty());
            assert_eq!(response.url, "https://example.com/chapter-1/page");
            let serialized = serde_json::to_value(response).unwrap();
            assert_eq!(serialized["readMethod"], "rendered");
            assert_eq!(serialized["pages"].as_array().unwrap().len(), count);
            for index in 1..=count {
                assert_eq!(
                    serialized["pages"][index - 1]["url"],
                    format!("https://example.com/chapter-{index}/page")
                );
                assert_eq!(
                    serialized["pages"][index - 1]["body"],
                    format!("<main>PAGE_{index}</main>")
                );
                assert_eq!(
                    serialized["pages"][index - 1]["title"],
                    format!("Chapter {index}")
                );
            }
        }
    }

    #[test]
    fn rendered_body_budget_is_shared_across_pages_and_utf8_safe() {
        let origin = Url::parse("https://example.com/start").unwrap();
        let mut capture = RenderedPageCapture::default();
        capture
            .push(rendered_fixture(1, "文".repeat(200_000)), &origin)
            .unwrap();
        capture
            .push(rendered_fixture(2, "字".repeat(200_000)), &origin)
            .unwrap();
        let response = capture.into_response().unwrap();
        assert!(!response.complete);
        assert_eq!(response.issues, vec![WebReadIssue::BodyLimit]);
        assert!(
            response
                .pages
                .iter()
                .map(|page| page.body.len())
                .sum::<usize>()
                <= MAX_RESPONSE_BYTES
        );
        assert!(!response.pages[0].truncated);
        assert!(response.pages[1].truncated);
        assert!(response
            .pages
            .iter()
            .all(|page| std::str::from_utf8(page.body.as_bytes()).is_ok()));
    }

    #[test]
    fn javascript_clipping_is_not_reported_as_complete_even_under_rust_byte_limit() {
        let origin = Url::parse("https://example.com/start").unwrap();
        let mut page = rendered_fixture(1, "CLIPPED".to_string());
        page.truncated = true;
        let mut capture = RenderedPageCapture::default();
        capture.push(page, &origin).unwrap();
        let response = capture.into_response().unwrap();
        assert!(!response.complete);
        assert!(response.pages[0].truncated);
        assert_eq!(response.issues, vec![WebReadIssue::BodyLimit]);
    }

    #[test]
    fn failed_unsafe_or_empty_later_pages_never_replace_successful_pages() {
        let origin = Url::parse("https://example.com/start").unwrap();
        for url in [
            "http://127.0.0.1/private",
            "https://other.example.com/page",
            "https://example.com/page?token=secret",
        ] {
            let mut capture = RenderedPageCapture::default();
            capture
                .push(rendered_fixture(1, "SAVED".to_string()), &origin)
                .unwrap();
            let mut later = rendered_fixture(2, "UNSAFE".to_string());
            later.url = url.to_string();
            let issue = capture.push(later, &origin).unwrap_err();
            capture.note(issue);
            let response = capture.into_response().unwrap();
            assert!(!response.complete);
            assert_eq!(response.pages.len(), 1);
            assert_eq!(response.pages[0].body, "SAVED");
            assert_eq!(response.issues, vec![WebReadIssue::NavigationFailed]);
        }
        let mut capture = RenderedPageCapture::default();
        assert_eq!(
            capture.push(rendered_fixture(1, String::new()), &origin),
            Err(WebReadIssue::EmptyPage)
        );
        assert!(capture.into_response().is_err());
    }

    #[test]
    fn duplicate_and_page_limit_results_remain_bounded_and_explicitly_partial() {
        let origin = Url::parse("https://example.com/start").unwrap();
        let mut capture = RenderedPageCapture::default();
        capture
            .push(rendered_fixture(1, "SAVED".to_string()), &origin)
            .unwrap();
        assert_eq!(
            capture.push(rendered_fixture(1, "SAVED".to_string()), &origin),
            Err(WebReadIssue::DuplicatePage)
        );
        for index in 2..=5 {
            capture
                .push(rendered_fixture(index, format!("PAGE_{index}")), &origin)
                .unwrap();
        }
        let issue = capture
            .push(rendered_fixture(6, "NOT_READ".to_string()), &origin)
            .unwrap_err();
        capture.note(issue);
        let response = capture.into_response().unwrap();
        assert_eq!(response.pages.len(), 5);
        assert_eq!(response.issues, vec![WebReadIssue::PageLimit]);
        assert!(!response.complete);
    }

    #[tokio::test]
    async fn timeout_drops_only_inflight_work_and_keeps_captured_pages() {
        let origin = Url::parse("https://example.com/start").unwrap();
        let mut capture = RenderedPageCapture::default();
        let timeout = tokio::time::timeout(Duration::from_millis(1), async {
            capture
                .push(
                    rendered_fixture(1, "SAVED_BEFORE_TIMEOUT".to_string()),
                    &origin,
                )
                .unwrap();
            std::future::pending::<()>().await;
        })
        .await;
        assert!(timeout.is_err());
        capture.note(WebReadIssue::Timeout);
        let response = capture.into_response().unwrap();
        assert_eq!(response.pages[0].body, "SAVED_BEFORE_TIMEOUT");
        assert_eq!(response.issues, vec![WebReadIssue::Timeout]);
        assert!(!response.complete);
    }

    #[test]
    fn rejects_private_non_http_custom_port_and_sensitive_urls() {
        for url in [
            "file:///tmp/test",
            "http://127.0.0.1/test",
            "http://10.0.0.1/test",
            "http://100.64.0.1/test",
            "http://198.18.0.1/test",
            "http://192.88.99.1/test",
            "http://224.0.0.1/test",
            "http://[::1]/test",
            "http://[fc00::1]/test",
            "http://[2001:db8::1]/test",
            "https://example.com:8443/test",
            "https://user:pass@example.com/test",
            "https://example.com/test?api_key=secret",
            "https://example.com/test?access-token=secret",
        ] {
            assert!(
                validate_url_shape(url).is_err(),
                "URL should be rejected: {url}"
            );
        }
    }

    #[test]
    fn accepts_public_standard_port_urls_without_sensitive_queries() {
        assert!(validate_url_shape("https://example.com/path?q=1").is_ok());
        assert!(validate_url_shape("http://example.com/path").is_ok());
    }

    #[test]
    fn redirect_targets_are_revalidated() {
        let public = Url::parse("https://example.com/start").unwrap();
        let private = public.join("http://192.168.1.8/admin").unwrap();
        let credential = public.join("/next?token=secret").unwrap();
        assert!(validate_url_shape(private.as_str()).is_err());
        assert!(validate_url_shape(credential.as_str()).is_err());
    }

    #[test]
    fn browser_rendering_requires_same_https_origin() {
        let expected = Url::parse("https://docs.example.com/reference").unwrap();
        assert!(same_origin(
            &expected,
            &Url::parse("https://docs.example.com/other?q=1").unwrap()
        ));
        assert!(!same_origin(
            &expected,
            &Url::parse("http://docs.example.com/reference").unwrap()
        ));
        assert!(!same_origin(
            &expected,
            &Url::parse("https://cdn.example.com/app.js").unwrap()
        ));
        assert!(!same_origin(
            &expected,
            &Url::parse("https://docs.example.com:8443/reference").unwrap()
        ));
    }

    #[test]
    fn rendered_html_is_truncated_on_a_utf8_boundary() {
        let value = "接口文档".repeat(300_000);
        let truncated = truncate_utf8_bytes(value, MAX_RESPONSE_BYTES);
        assert!(truncated.len() <= MAX_RESPONSE_BYTES);
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }

    #[test]
    fn recognizes_only_the_proxy_fake_ipv4_range() {
        assert!(is_proxy_fake_ip("198.18.0.1".parse().unwrap()));
        assert!(is_proxy_fake_ip("198.19.255.254".parse().unwrap()));
        assert!(!is_proxy_fake_ip("198.20.0.1".parse().unwrap()));
        assert!(!is_proxy_fake_ip("192.168.1.8".parse().unwrap()));
        assert!(!is_proxy_fake_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn fake_ip_resolution_requires_https_and_rejects_mixed_or_private_answers() {
        let https = Url::parse("https://example.com/path").unwrap();
        let http = Url::parse("http://example.com/path").unwrap();
        let fake = "198.18.0.11:443".parse().unwrap();
        let second_fake = "198.19.0.12:443".parse().unwrap();
        let public = "93.184.216.34:443".parse().unwrap();
        let private = "192.168.1.8:443".parse().unwrap();

        assert_eq!(
            classify_resolved_addresses(&https, &[fake, second_fake]).unwrap(),
            ConnectionRoute::SystemResolverAfterDoh
        );
        assert!(classify_resolved_addresses(&http, &[fake]).is_err());
        assert!(classify_resolved_addresses(&https, &[fake, public]).is_err());
        assert!(classify_resolved_addresses(&https, &[private]).is_err());
        assert_eq!(
            classify_resolved_addresses(&https, &[public]).unwrap(),
            ConnectionRoute::Pinned(public)
        );
    }

    #[test]
    fn doh_validation_requires_at_least_one_public_a_record() {
        let public = DohResponse {
            status: 0,
            answers: vec![DohAnswer {
                record_type: 1,
                data: "93.184.216.34".to_string(),
            }],
        };
        assert!(validate_doh_response(public).is_ok());

        for response in [
            DohResponse {
                status: 2,
                answers: vec![],
            },
            DohResponse {
                status: 0,
                answers: vec![],
            },
            DohResponse {
                status: 0,
                answers: vec![DohAnswer {
                    record_type: 1,
                    data: "192.168.1.8".to_string(),
                }],
            },
        ] {
            assert!(validate_doh_response(response).is_err());
        }
    }

    #[test]
    fn search_providers_use_fixed_endpoints_and_expected_payload_shapes() {
        assert_eq!(WebSearchProvider::Tavily.endpoint(), TAVILY_SEARCH_URL);
        assert_eq!(WebSearchProvider::Bocha.endpoint(), BOCHA_SEARCH_URL);
        assert_eq!(WebSearchProvider::ZhipuSearch.endpoint(), ZHIPU_SEARCH_URL);
        assert_eq!(WebSearchProvider::Exa.endpoint(), EXA_SEARCH_URL);

        let bocha = build_search_payload(WebSearchProvider::Bocha, "最新动态", 4, "news");
        assert_eq!(bocha["freshness"], "oneWeek");
        assert_eq!(bocha["count"], 4);

        let zhipu = build_search_payload(WebSearchProvider::ZhipuSearch, "测试", 5, "general");
        assert_eq!(zhipu["search_engine"], "search_std");
        assert_eq!(zhipu["search_intent"], false);

        let exa = build_search_payload(WebSearchProvider::Exa, "test", 3, "general");
        assert_eq!(exa["numResults"], 3);
        assert_eq!(exa["contents"]["highlights"], true);
    }
}
