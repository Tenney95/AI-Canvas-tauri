use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;
use serde::Serialize;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::{Host, Url};

const MAX_PAGE_BYTES: usize = 1_000_000;
const MAX_REDIRECTS: usize = 5;
const MAX_URL_CHARS: usize = 2_048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDocsReadResponse {
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
    if raw_url.chars().count() > MAX_URL_CHARS {
        return Err("厂商文档 URL 过长".to_string());
    }
    let url = Url::parse(raw_url).map_err(|_| "厂商文档 URL 无效".to_string())?;
    if url.scheme() != "https" {
        return Err("厂商文档只允许使用 HTTPS".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("厂商文档 URL 不允许包含用户名或密码".to_string());
    }
    let host = url
        .host()
        .ok_or_else(|| "厂商文档 URL 缺少主机名".to_string())?;
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
    if url.port_or_known_default() != Some(443) {
        return Err("厂商文档只允许标准 HTTPS 端口".to_string());
    }
    Ok(url)
}

fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "厂商文档 URL 缺少主机名".to_string())?;
    let addresses = (host, 443)
        .to_socket_addrs()
        .map_err(|_| "厂商文档域名解析失败".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("厂商文档域名没有可用地址".to_string());
    }
    if addresses
        .iter()
        .any(|address| is_disallowed_ip(address.ip()))
    {
        return Err("厂商文档域名解析到了非公网地址".to_string());
    }
    Ok(addresses)
}

fn pinned_client(host: &str, address: SocketAddr) -> Result<Client, String> {
    ClientBuilder::new()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .resolve(host, address)
        .build()
        .map_err(|error| format!("创建安全文档客户端失败: {error}"))
}

fn read_limited(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_PAGE_BYTES)
    {
        return Err("厂商文档响应超过 1 MB 限制".to_string());
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_PAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取厂商文档失败: {error}"))?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err("厂商文档响应超过 1 MB 限制".to_string());
    }
    Ok(bytes)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default()
}

fn read_public_document(raw_url: String) -> Result<ProviderDocsReadResponse, String> {
    let initial_url = validate_url_shape(&raw_url)?;
    let mut current_url = initial_url.clone();

    for redirect_count in 0..=MAX_REDIRECTS {
        let addresses = resolve_public_addresses(&current_url)?;
        let host = current_url
            .host_str()
            .ok_or_else(|| "厂商文档 URL 缺少主机名".to_string())?;
        let client = pinned_client(host, addresses[0])?;
        let response = client
            .get(current_url.as_str())
            .header(USER_AGENT, "AI-Canvas-ProviderDocs/0.5")
            .send()
            .map_err(|error| format!("厂商文档请求失败: {error}"))?;
        let status = response.status();

        if status.is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("厂商文档重定向次数超过限制".to_string());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "厂商文档重定向缺少 Location".to_string())?;
            let next_url = validate_url_shape(
                current_url
                    .join(location)
                    .map_err(|_| "厂商文档重定向地址无效".to_string())?
                    .as_str(),
            )?;
            if !same_origin(&initial_url, &next_url) {
                return Err("厂商文档不允许跨站重定向".to_string());
            }
            current_url = next_url;
            continue;
        }

        if !status.is_success() {
            return Err(format!("厂商文档返回 HTTP {}", status.as_u16()));
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
            return Err("厂商文档内容类型不受支持".to_string());
        }
        let bytes = read_limited(response)?;
        return Ok(ProviderDocsReadResponse {
            url: current_url.to_string(),
            status: status.as_u16(),
            content_type,
            body: String::from_utf8_lossy(&bytes).into_owned(),
            fetched_at: now_millis(),
        });
    }
    Err("厂商文档读取失败".to_string())
}

#[tauri::command]
pub async fn provider_docs_read(url: String) -> Result<ProviderDocsReadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || read_public_document(url))
        .await
        .map_err(|error| format!("厂商文档读取任务执行失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_https_private_and_custom_port_urls() {
        assert!(validate_url_shape("http://example.com/docs").is_err());
        assert!(validate_url_shape("https://127.0.0.1/docs").is_err());
        assert!(validate_url_shape("https://10.0.0.1/docs").is_err());
        assert!(validate_url_shape("https://[::1]/docs").is_err());
        assert!(validate_url_shape("https://example.local/docs").is_err());
        assert!(validate_url_shape("https://example.com:8443/docs").is_err());
        assert!(validate_url_shape("file:///tmp/docs").is_err());
    }

    #[test]
    fn accepts_public_https_shape_and_same_origin_redirects() {
        let start = validate_url_shape("https://docs.example.com/api").unwrap();
        let same_site = validate_url_shape("https://docs.example.com/models").unwrap();
        let other_site = validate_url_shape("https://example.com/models").unwrap();
        assert!(same_origin(&start, &same_site));
        assert!(!same_origin(&start, &other_site));
    }
}
