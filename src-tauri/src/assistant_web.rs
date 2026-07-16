use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::{Host, Url};

const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const MAX_SEARCH_BYTES: usize = 1_000_000;
const MAX_PAGE_BYTES: usize = 1_000_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantWebSearchRequest {
    api_key: String,
    query: String,
    max_results: Option<u8>,
    topic: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantWebSearchResponse {
    status: u16,
    body: String,
    fetched_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantWebReadResponse {
    url: String,
    status: u16,
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

fn validate_url_shape(raw_url: &str) -> Result<Url, String> {
    let url = Url::parse(raw_url).map_err(|_| "网页 URL 无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只允许读取 HTTP(S) 网页".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网页 URL 不允许包含用户名或密码".to_string());
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

fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
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
    if addresses.is_empty() {
        return Err("网页域名没有可用地址".to_string());
    }
    if addresses
        .iter()
        .any(|address| is_disallowed_ip(address.ip()))
    {
        return Err("网页域名解析到了非公网地址".to_string());
    }
    Ok(addresses)
}

fn pinned_client(host: &str, address: SocketAddr) -> Result<Client, String> {
    ClientBuilder::new()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .resolve(host, address)
        .build()
        .map_err(|error| format!("创建安全网页客户端失败: {error}"))
}

fn read_limited(
    response: reqwest::blocking::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > max_bytes)
    {
        return Err("网页响应超过 1 MB 限制".to_string());
    }

    let mut bytes = Vec::new();
    response
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取网页响应失败: {error}"))?;
    if bytes.len() > max_bytes {
        return Err("网页响应超过 1 MB 限制".to_string());
    }
    Ok(bytes)
}

fn read_public_page(raw_url: String) -> Result<AssistantWebReadResponse, String> {
    let mut current_url = validate_url_shape(&raw_url)?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let addresses = resolve_public_addresses(&current_url)?;
        let host = current_url
            .host_str()
            .ok_or_else(|| "网页 URL 缺少主机名".to_string())?;
        let client = pinned_client(host, addresses[0])?;
        let response = client
            .get(current_url.as_str())
            .header(USER_AGENT, "AI-Canvas-Agent/0.4")
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
        {
            return Err("网页内容类型不受支持".to_string());
        }
        let bytes = read_limited(response, MAX_PAGE_BYTES)?;
        let body = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(AssistantWebReadResponse {
            url: current_url.to_string(),
            status: status.as_u16(),
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
    if api_key.is_empty() {
        return Err("未配置 Tavily API Key".to_string());
    }
    if query.is_empty() || query.chars().count() > 500 {
        return Err("搜索词长度必须为 1-500 个字符".to_string());
    }
    let max_results = request.max_results.unwrap_or(5).clamp(1, 10);
    let topic = match request.topic.as_deref() {
        Some("news") => "news",
        Some("finance") => "finance",
        _ => "general",
    };

    tauri::async_runtime::spawn_blocking(move || {
        let body = serde_json::to_vec(&serde_json::json!({
            "query": query,
            "search_depth": "basic",
            "topic": topic,
            "max_results": max_results,
            "include_answer": false,
            "include_raw_content": false,
            "include_images": false
        }))
        .map_err(|error| format!("构建搜索请求失败: {error}"))?;
        let client = ClientBuilder::new()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|error| format!("创建搜索客户端失败: {error}"))?;
        let response = client
            .post(TAVILY_SEARCH_URL)
            .header(USER_AGENT, "AI-Canvas-Agent/0.4")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {api_key}"))
            .body(body)
            .send()
            .map_err(|error| format!("搜索请求失败: {error}"))?;
        let status = response.status().as_u16();
        let bytes = read_limited(response, MAX_SEARCH_BYTES)?;
        let body = String::from_utf8_lossy(&bytes).into_owned();
        if !(200..300).contains(&status) {
            return Err(format!("Tavily 搜索失败（HTTP {status}）"));
        }
        Ok(AssistantWebSearchResponse {
            status,
            body,
            fetched_at: now_millis(),
        })
    })
    .await
    .map_err(|error| format!("搜索任务执行失败: {error}"))?
}

#[tauri::command]
pub async fn assistant_web_read(url: String) -> Result<AssistantWebReadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || read_public_page(url))
        .await
        .map_err(|error| format!("网页读取任务执行失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_non_http_urls() {
        assert!(validate_url_shape("http://127.0.0.1/test").is_err());
        assert!(validate_url_shape("http://10.0.0.1/test").is_err());
        assert!(validate_url_shape("http://100.64.0.1/test").is_err());
        assert!(validate_url_shape("http://198.18.0.1/test").is_err());
        assert!(validate_url_shape("http://192.0.0.8/test").is_err());
        assert!(validate_url_shape("http://192.88.99.1/test").is_err());
        assert!(validate_url_shape("http://224.0.0.1/test").is_err());
        assert!(validate_url_shape("http://[::1]/test").is_err());
        assert!(validate_url_shape("http://[fc00::1]/test").is_err());
        assert!(validate_url_shape("http://[fe80::1]/test").is_err());
        assert!(validate_url_shape("http://[2001:db8::1]/test").is_err());
        assert!(validate_url_shape("http://[::ffff:127.0.0.1]/test").is_err());
        assert!(validate_url_shape("file:///tmp/test").is_err());
        assert!(validate_url_shape("http://example.com:8080/test").is_err());
    }

    #[test]
    fn rejects_redirect_target_to_private_network() {
        let public = Url::parse("https://example.com/start").unwrap();
        let redirect = public.join("http://192.168.1.8/admin").unwrap();
        assert!(validate_url_shape(redirect.as_str()).is_err());
    }

    #[test]
    fn accepts_public_https_shape() {
        assert!(validate_url_shape("https://example.com/path?q=1").is_ok());
    }
}
