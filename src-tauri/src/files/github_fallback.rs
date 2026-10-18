//! 仅公开 GitHub 读取允许一次国内加速；校验、写盘和安装不进入重试边界。
use serde::Deserialize;
use std::{io::{self, Cursor, Read}, sync::OnceLock, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    pub mirror_base: String,
    official_hosts: Vec<String>,
    pub connect_timeout_ms: u64,
    pub read_timeout_ms: u64,
}

pub(crate) fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(include_str!("../../../src/constants/githubDownload.json"))
        .expect("invalid embedded GitHub download policy"))
}

pub(crate) fn mirror_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some() || url.fragment().is_some()
        || !policy().official_hosts.iter().any(|host| Some(host.as_str()) == url.host_str())
        || url.query().is_some_and(|query| query != "service=git-upload-pack") { return None; }
    Some(format!("{}{url}", policy().mirror_base))
}

pub(crate) struct Failure { pub message: String, pub retryable: bool }
impl Failure {
    pub fn terminal(message: impl Into<String>) -> Self { Self { message: message.into(), retryable: false } }
    pub fn network(error: reqwest::Error) -> Self {
        Self { retryable: error.is_timeout() || error.is_connect() || error.is_body(), message: "GitHub 下载连接或读取失败".into() }
    }
}
pub(crate) fn transient_status(status: u16) -> bool { matches!(status, 408 | 429 | 500..=599) }

pub(crate) fn retry<T>(url: &str, mut attempt: impl FnMut(&str) -> Result<T, Failure>) -> Result<T, String> {
    match attempt(url) {
        Ok(value) => Ok(value),
        Err(error) if error.retryable => match mirror_url(url) {
            Some(mirror) => attempt(&mirror).map_err(|error| error.message),
            None => Err(error.message),
        },
        Err(error) => Err(error.message),
    }
}

/// 阻塞文件循环通过异步 reqwest 分块读取，超时按每次读取计，不限制整个大包耗时。
pub(crate) struct ResponseReader {
    pub response: reqwest::Response,
    pending: Cursor<Vec<u8>>,
    pub network_failed: bool,
}
pub(crate) fn get(url: &str) -> Result<ResponseReader, Failure> {
    let response = tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
        .user_agent("AI-Canvas/GitHub-download")
        .connect_timeout(Duration::from_millis(policy().connect_timeout_ms))
        .read_timeout(Duration::from_millis(policy().read_timeout_ms))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let allowed = url.host_str().is_some_and(|host| policy().official_hosts.iter().any(|official| official == host)
                || host.ends_with(".githubusercontent.com") || host == "gh-proxy.com" || host.ends_with(".gh-proxy.com"));
            if attempt.previous().len() >= 8 || url.scheme() != "https" || !allowed
                || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
                attempt.error("GitHub 下载跳转离开受信任地址")
            } else { attempt.follow() }
        }))
        .build()?;
        client.get(url).send().await
    }).map_err(Failure::network)?;
    if !response.status().is_success() {
        return Err(Failure { message: format!("GitHub 下载返回 HTTP {}", response.status().as_u16()),
            retryable: transient_status(response.status().as_u16()) });
    }
    Ok(ResponseReader { response, pending: Cursor::new(Vec::new()), network_failed: false })
}
impl Read for ResponseReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() { return Ok(0); }
        loop {
            if self.pending.position() < self.pending.get_ref().len() as u64 { return self.pending.read(buffer); }
            match tauri::async_runtime::block_on(async { self.response.chunk().await }) {
                Ok(Some(bytes)) => self.pending = Cursor::new(bytes.to_vec()),
                Ok(None) => return Ok(0),
                Err(error) => {
                    self.network_failed = error.is_timeout() || error.is_body() || error.is_connect();
                    return Err(io::Error::other("GitHub 下载读取中断"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_public_official_urls_can_fall_back_once() {
        for url in ["https://github.com/a/b/releases/download/v1/a.zip", "https://raw.githubusercontent.com/a/b/main/a.json"] {
            let mut seen = Vec::new();
            let result = retry(url, |url| { seen.push(url.to_owned()); Err::<(), _>(Failure { message: "offline".into(), retryable: true }) });
            assert!(result.is_err()); assert_eq!(seen.len(), 2);
            assert_eq!(seen[1], format!("{}{url}", policy().mirror_base));
        }
        for url in ["https://github.com/a/b?token=secret", "https://user@github.com/a/b", "http://github.com/a/b", "https://other.test/a", "https://gh-proxy.com/https://github.com/a/b"] {
            assert!(mirror_url(url).is_none());
        }
    }
    #[test]
    fn validation_and_disk_errors_never_retry() {
        let mut count = 0;
        let _ = retry("https://github.com/a/b", |_| { count += 1; Err::<(), _>(Failure::terminal("SHA-256 mismatch")) });
        assert_eq!(count, 1);
        assert!(!transient_status(404)); assert!(!transient_status(403)); assert!(transient_status(504));
    }
    #[test]
    fn blocking_adapter_reads_a_complete_response_without_a_webview() {
        use std::{net::TcpListener, io::Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut request = [0_u8; 4096];
                    let _ = stream.read(&mut request).unwrap();
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndone").unwrap();
                    return;
                }
                assert!(std::time::Instant::now() < deadline, "local request did not arrive");
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let mut response = get(&format!("http://{address}/file")).unwrap_or_else(|error| panic!("{}", error.message));
        let mut bytes = Vec::new();
        response.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"done");
        assert!(!response.network_failed);
        server.join().unwrap();
    }
}
