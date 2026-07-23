use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::{Host, Url};

const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const BOCHA_SEARCH_URL: &str = "https://api.bocha.cn/v1/web-search";
const ZHIPU_SEARCH_URL: &str = "https://open.bigmodel.cn/api/paas/v4/web_search";
const EXA_SEARCH_URL: &str = "https://api.exa.ai/search";
const CLOUDFLARE_DOH_URL: &str = "https://cloudflare-dns.com/dns-query";
const MAX_RESPONSE_BYTES: usize = 1_000_000;
const MAX_REDIRECTS: usize = 5;
const MAX_URL_CHARS: usize = 2_048;

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
        });
    }
    Err("网页读取失败".to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

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
