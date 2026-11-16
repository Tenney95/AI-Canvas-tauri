//! 方舟素材：原生流式上传到北京私有 TOS，分别签发推理内网或素材入库公网 GET URL。
//! 只允许固定 TOS 主机、受授权的普通文件和独立 TOS 凭据；不记录签名或原始错误。

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    net::{SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Webview};
use url::{Host, Url};

const REGION: &str = "cn-beijing";
const EXPIRES: u64 = 6 * 60 * 60;
const SMALL_LIMIT: u64 = 32 * 1024 * 1024;
const VIDEO_LIMIT: u64 = 200_000_000;
const CHUNK_SIZE: usize = 256 * 1024;
const INVALID: &str = "火山 TOS 上传参数或素材无效";
const CANCELLED: &str = "火山 TOS 上传已取消";
const CHANGED: &str = "参考素材在上传期间发生变化，请重新发起";
const NETWORK: &str = "火山 TOS 上传失败，请检查网络、桶权限与凭据";
const CREDENTIALS: &str = "无法读取火山 TOS 凭据，请在火山连接中重新保存 AK/SK";
const REMOTE_SOURCE: &str = "火山 TOS 无法读取远端参考素材，请检查公共 HTTP(S) 文件地址与文件限制";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind { Image, Video, Audio }

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum UploadPurpose { #[default] Reference, AssetIngestion }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadSource { path: Option<String>, data_url: Option<String>, remote_url: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedSource { digest: String, bytes: u64 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    request_id: String,
    bucket: String,
    credential_ref: String,
    kind: MediaKind,
    #[serde(default)]
    purpose: UploadPurpose,
    source: UploadSource,
    expected_source: Option<ExpectedSource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult { url: String, expires_at: u64 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials { access_key_id: String, secret_access_key: String }

#[derive(Default)]
struct Tasks { active: HashMap<String, Arc<AtomicBool>>, cancelled: HashSet<String> }
static TASKS: LazyLock<Mutex<Tasks>> = LazyLock::new(|| Mutex::new(Tasks::default()));

struct Task { id: String, cancelled: Arc<AtomicBool> }
impl Task {
    fn start(id: String) -> Result<Self, String> {
        validate_request_id(&id)?;
        let mut tasks = TASKS.lock().map_err(|_| INVALID)?;
        if tasks.cancelled.remove(&id) { return Err(CANCELLED.into()); }
        if tasks.active.contains_key(&id) || tasks.active.len() >= 3 { return Err("火山 TOS 上传繁忙，请稍后重试".into()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        tasks.active.insert(id.clone(), cancelled.clone());
        Ok(Self { id, cancelled })
    }
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) { Err(CANCELLED.into()) } else { Ok(()) }
    }
}
impl Drop for Task {
    fn drop(&mut self) { if let Ok(mut tasks) = TASKS.lock() { tasks.active.remove(&self.id); } }
}

fn ensure_main(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview).map_err(|_| "仅主窗口可上传火山 TOS 素材")?;
    if webview.label() != "main" { return Err("仅主窗口可上传火山 TOS 素材".into()); }
    Ok(())
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err(INVALID.into());
    }
    Ok(())
}

fn validate_bucket(bucket: &str) -> Result<(), String> {
    if !(3..=63).contains(&bucket.len()) || !bucket.as_bytes()[0].is_ascii_lowercase()
        && !bucket.as_bytes()[0].is_ascii_digit()
        || !bucket.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
        || !bucket.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
        return Err("请填写有效的北京 TOS 桶名称".into());
    }
    Ok(())
}

fn credential_key(reference: &str) -> Result<&str, String> {
    let key = reference.strip_prefix("secret:provider/volcengine/tos/").ok_or(CREDENTIALS)?;
    if key.len() != 36 || !key.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' }
        else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
    }) { return Err(CREDENTIALS.into()); }
    Ok(&reference["secret:".len()..])
}

fn credentials(app: &AppHandle, reference: &str) -> Result<Credentials, String> {
    let raw = crate::secret_store::read_internal_secret_sync(app, credential_key(reference)?)
        .map_err(|_| CREDENTIALS)?.ok_or(CREDENTIALS)?;
    let value: Credentials = serde_json::from_str(&raw).map_err(|_| CREDENTIALS)?;
    if value.access_key_id.is_empty() || value.access_key_id.len() > 256
        || !value.access_key_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || value.secret_access_key.is_empty() || value.secret_access_key.len() > 2048
        || value.secret_access_key.chars().any(char::is_control) { return Err(CREDENTIALS.into()); }
    Ok(value)
}

fn sha256(bytes: &[u8]) -> [u8; 32] { Sha256::digest(bytes).into() }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

// HMAC-SHA256 uses only the already installed SHA-256 implementation.
fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    if key.len() > block.len() { block[..32].copy_from_slice(&sha256(key)); }
    else { block[..key.len()].copy_from_slice(key); }
    let inner_pad = block.map(|byte| byte ^ 0x36);
    let outer_pad = block.map(|byte| byte ^ 0x5c);
    let mut inner = Sha256::new(); inner.update(inner_pad); inner.update(message);
    let mut outer = Sha256::new(); outer.update(outer_pad); outer.update(inner.finalize());
    outer.finalize().into()
}

fn encode(value: &str, keep_slashes: bool) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') || keep_slashes && byte == b'/' {
            output.push(char::from(byte));
        } else { output.push_str(&format!("%{byte:02X}")); }
    }
    output
}

// UTC civil date conversion, independent of the desktop's local timezone.
fn timestamp(seconds: u64) -> Result<String, String> {
    let days = i64::try_from(seconds / 86_400).map_err(|_| INVALID)?;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    if !(1970..=9999).contains(&year) { return Err(INVALID.into()); }
    let daytime = seconds % 86_400;
    Ok(format!("{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z", daytime / 3600, daytime / 60 % 60, daytime % 60))
}

fn signed_url(method: &str, host: &str, path: &str, credentials: &Credentials, region: &str, date: &str, expires: u64) -> String {
    let scope = format!("{}/{region}/tos/request", &date[..8]);
    let query = [
        ("X-Tos-Algorithm", "TOS4-HMAC-SHA256".to_string()),
        ("X-Tos-Credential", format!("{}/{}", credentials.access_key_id, scope)),
        ("X-Tos-Date", date.to_string()),
        ("X-Tos-Expires", expires.to_string()),
        ("X-Tos-SignedHeaders", "host".to_string()),
    ].iter().map(|(name, value)| format!("{}={}", encode(name, false), encode(value, false))).collect::<Vec<_>>().join("&");
    let path = encode(path, true);
    let canonical = format!("{method}\n{path}\n{query}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD");
    let to_sign = format!("TOS4-HMAC-SHA256\n{date}\n{scope}\n{}", hex(&sha256(canonical.as_bytes())));
    let date_key = hmac(credentials.secret_access_key.as_bytes(), date[..8].as_bytes());
    let region_key = hmac(&date_key, region.as_bytes());
    let service_key = hmac(&region_key, b"tos");
    let signing_key = hmac(&service_key, b"request");
    format!("https://{host}{path}?{query}&X-Tos-Signature={}", hex(&hmac(&signing_key, to_sign.as_bytes())))
}

fn random_key() -> Result<String, String> {
    let bytes = crate::secure_random::random_bytes::<24>().map_err(|_| INVALID)?;
    Ok(hex(&bytes))
}

fn media_limit(kind: MediaKind, purpose: UploadPurpose) -> u64 {
    match (kind, purpose) {
        (MediaKind::Image, UploadPurpose::AssetIngestion) => 29_999_999,
        (MediaKind::Audio, UploadPurpose::AssetIngestion) => 15_000_000,
        (MediaKind::Video, _) => VIDEO_LIMIT,
        _ => SMALL_LIMIT,
    }
}

fn validate_source(source: &UploadSource, expected: Option<&ExpectedSource>) -> Result<(), String> {
    let sources = [source.path.is_some(), source.data_url.is_some(), source.remote_url.is_some()];
    if sources.iter().filter(|present| **present).count() != 1 || source.remote_url.is_some() && expected.is_some() {
        return Err(INVALID.into());
    }
    Ok(())
}

fn validate_media_size(total: u64, kind: MediaKind, purpose: UploadPurpose) -> Result<(), String> {
    if total == 0 || total > media_limit(kind, purpose) {
        return Err(if purpose == UploadPurpose::AssetIngestion {
            "火山 TOS 人像库素材须非空，图片小于 30 MB、音频不超过 15 MB、视频不超过 200 MB"
        } else { "火山参考素材超过应用上传上限（图片/音频 32 MiB，视频 200 MB）" }.into());
    }
    Ok(())
}

fn remote_source_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 16_384 || raw.chars().any(|value| value.is_whitespace() || value.is_control()) {
        return Err(REMOTE_SOURCE.into());
    }
    let url = Url::parse(raw).map_err(|_| REMOTE_SOURCE)?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some()
        || url.fragment().is_some() || url.port().is_some() { return Err(REMOTE_SOURCE.into()); }
    let host = url.host().ok_or(REMOTE_SOURCE)?;
    match host {
        Host::Ipv4(ip) if crate::assistant_web::is_disallowed_ip(ip.into()) => return Err(REMOTE_SOURCE.into()),
        Host::Ipv6(ip) if crate::assistant_web::is_disallowed_ip(ip.into()) => return Err(REMOTE_SOURCE.into()),
        Host::Domain(domain) => {
            let host = domain.trim_end_matches('.').to_ascii_lowercase();
            if host == "localhost" || [".localhost", ".local", ".internal", ".lan", ".home.arpa"].iter().any(|suffix| host.ends_with(suffix)) {
                return Err(REMOTE_SOURCE.into());
            }
        },
        _ => {},
    }
    Ok(url)
}

fn public_source_addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let port = url.port_or_known_default().ok_or(REMOTE_SOURCE)?;
    let addresses = match url.host().ok_or(REMOTE_SOURCE)? {
        Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Domain(host) => (host, port).to_socket_addrs().map_err(|_| REMOTE_SOURCE)?.collect(),
    };
    if addresses.is_empty() || addresses.iter().any(|address| crate::assistant_web::is_disallowed_ip(address.ip())) {
        return Err(REMOTE_SOURCE.into());
    }
    Ok(addresses)
}

fn object_get_host(bucket: &str, purpose: UploadPurpose) -> String {
    format!("{bucket}.tos-cn-beijing.{}", if purpose == UploadPurpose::Reference { "ivolces.com" } else { "volces.com" })
}

/** 已有本桶随机对象只重新签名，不尝试从桌面访问内网 URL，也不转用传入查询参数。 */
fn reusable_object_path(raw: &str, url: &Url, bucket: &str, kind: MediaKind) -> Result<Option<String>, String> {
    let public = Some(object_get_host(bucket, UploadPurpose::AssetIngestion).as_str()) == url.host_str();
    let internal = Some(object_get_host(bucket, UploadPurpose::Reference).as_str()) == url.host_str();
    if !public && !internal { return Ok(None); }
    let raw_path = raw.split_once("://").and_then(|(_, rest)| rest.find('/').map(|index| &rest[index..]))
        .map(|rest| rest.split(['?', '#']).next().unwrap_or_default()).ok_or(INVALID)?;
    if raw_path != url.path() { return Err(INVALID.into()); }
    let generated = url.path().strip_prefix("/ai-canvas/ark-reference/").and_then(|object| object.rsplit_once('.'))
        .filter(|(key, extension)| key.len() == 48 && key.bytes().all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
            && ["png", "jpg", "webp", "gif", "tiff", "heif", "mp4", "mov", "wav", "mp3"].contains(extension));
    // A user-supplied public URL elsewhere in the bucket may be imported normally using only its own source query.
    let Some((_, extension)) = generated else { return if public { Ok(None) } else { Err(INVALID.into()) }; };
    let supported = match kind {
        MediaKind::Image => ["png", "jpg", "webp", "gif", "tiff", "heif"].contains(&extension),
        MediaKind::Video => ["mp4", "mov"].contains(&extension),
        MediaKind::Audio => ["wav", "mp3"].contains(&extension),
    };
    if url.scheme() != "https" || !supported
        || url.query_pairs().any(|(key, _)| !["X-Tos-Algorithm", "X-Tos-Credential", "X-Tos-Date", "X-Tos-Expires", "X-Tos-SignedHeaders", "X-Tos-Signature"].contains(&key.as_ref())) {
        return Err(INVALID.into());
    }
    Ok(Some(url.path().to_string()))
}

fn private_download_file(app: &AppHandle) -> Result<(File, Vec<File>), String> {
    let configured = crate::agent_package::agent_private_dir(app).map_err(|_| INVALID)?;
    let base = configured.parent().ok_or(INVALID)?;
    fs::create_dir_all(base).map_err(|_| INVALID)?;
    let parent = base.canonicalize().map_err(|_| INVALID)?.join(configured.file_name().ok_or(INVALID)?);
    let root = parent.join("tos-imports");
    for directory in [&parent, &root] {
        #[cfg(unix)]
        let created = { use std::os::unix::fs::DirBuilderExt; fs::DirBuilder::new().mode(0o700).create(directory) };
        #[cfg(not(unix))]
        let created = fs::create_dir(directory);
        match created {
            Ok(()) => {},
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
            Err(_) => return Err(INVALID.into()),
        }
        let metadata = fs::symlink_metadata(directory).map_err(|_| INVALID)?;
        if !metadata.is_dir() || crate::path_policy::is_link_or_reparse(&metadata) { return Err(INVALID.into()); }
    }
    let root = root.canonicalize().map_err(|_| INVALID)?;
    let leases = directory_leases(&root.join("source.tmp"))?;
    let path = root.join(format!("{}.tmp", random_key()?));
    let mut options = OpenOptions::new(); options.read(true).write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        // Delete on the last handle close, including worker cancellation or process exit.
        options.access_mode(0x80000000 | 0x40000000 | 0x00010000)
            .custom_flags(0x04000000 | 0x00200000).share_mode(1 | 4);
    }
    let file = options.open(&path).map_err(|_| INVALID)?;
    #[cfg(unix)] fs::remove_file(&path).map_err(|_| INVALID)?;
    #[cfg(not(any(windows, unix)))] { drop(file); let _ = fs::remove_file(&path); return Err(INVALID.into()); }
    Ok((file, leases))
}

fn copy_remote_media(source: &mut impl Read, output: &mut impl Write, limit: u64, task: &Task) -> Result<u64, String> {
    let mut buffer = vec![0_u8; CHUNK_SIZE]; let mut total = 0_u64;
    loop {
        task.check()?;
        let maximum = buffer.len().min((limit - total + 1) as usize);
        let count = source.read(&mut buffer[..maximum]).map_err(|_| REMOTE_SOURCE)?;
        if count == 0 { break; }
        total += count as u64;
        if total > limit { return Err(REMOTE_SOURCE.into()); }
        output.write_all(&buffer[..count]).map_err(|_| INVALID)?;
    }
    task.check()?;
    Ok(total)
}

fn download_remote_source(app: &AppHandle, raw: &str, kind: MediaKind, purpose: UploadPurpose, task: &Task) -> Result<(File, Vec<File>, u64), String> {
    let url = remote_source_url(raw)?;
    let addresses = public_source_addresses(&url)?;
    let mut addresses = addresses; addresses.sort_by_key(|address| address.is_ipv6());
    let address = addresses[0];
    let http = reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(300))
        .resolve(url.host_str().ok_or(REMOTE_SOURCE)?, address).build().map_err(|_| REMOTE_SOURCE)?;
    task.check()?;
    // No TOS/Ark authorization, cookies, proxy credentials, redirects, or source URL logging.
    let mut response = http.get(url).send().map_err(|_| REMOTE_SOURCE)?;
    task.check()?;
    if response.status() != reqwest::StatusCode::OK { return Err(REMOTE_SOURCE.into()); }
    let expected = response.content_length();
    if let Some(total) = expected { validate_media_size(total, kind, purpose)?; }
    let (mut file, leases) = private_download_file(app)?;
    let total = copy_remote_media(&mut response, &mut file, media_limit(kind, purpose), task)?;
    validate_media_size(total, kind, purpose)?;
    if expected.is_some_and(|expected| expected != total) { return Err(REMOTE_SOURCE.into()); }
    file.seek(SeekFrom::Start(0)).map_err(|_| INVALID)?;
    Ok((file, leases, total))
}

#[derive(Clone)]
struct ChainDigest { previous: [u8; 32], pending: Vec<u8>, total: u64 }
impl ChainDigest {
    fn new() -> Self { Self { previous: sha256(b"asset-image-sha256-chain-v1"), pending: Vec::with_capacity(CHUNK_SIZE), total: 0 } }
    fn update(&mut self, mut input: &[u8]) {
        self.total += input.len() as u64;
        while !input.is_empty() {
            let count = (CHUNK_SIZE - self.pending.len()).min(input.len());
            self.pending.extend_from_slice(&input[..count]); input = &input[count..];
            if self.pending.len() == CHUNK_SIZE { self.flush(); }
        }
    }
    fn flush(&mut self) {
        let mut hash = Sha256::new(); hash.update(self.previous); hash.update(&self.pending);
        self.previous = hash.finalize().into(); self.pending.clear();
    }
    fn finish(mut self) -> String {
        if !self.pending.is_empty() { self.flush(); }
        hex(&sha256(format!("{}:{}", hex(&self.previous), self.total).as_bytes()))
    }
}

fn mime(prefix: &[u8], kind: MediaKind) -> Result<(&'static str, &'static str), String> {
    let image = if prefix.starts_with(b"\x89PNG\r\n\x1a\n") { Some(("image/png", "png")) }
        else if prefix.starts_with(b"\xff\xd8\xff") { Some(("image/jpeg", "jpg")) }
        else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") { Some(("image/gif", "gif")) }
        else if prefix.starts_with(b"II*\0") || prefix.starts_with(b"MM\0*") { Some(("image/tiff", "tiff")) }
        else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") { Some(("image/webp", "webp")) }
        else if prefix.get(4..8) == Some(b"ftyp") && prefix.get(8..12).is_some_and(|brand| matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1" | b"heim" | b"heis")) { Some(("image/heif", "heif")) }
        else { None };
    match kind {
        MediaKind::Image => image.ok_or_else(|| "火山参考图片格式无效或不受支持".into()),
        MediaKind::Video if image.is_none() && prefix.get(4..8) == Some(b"ftyp")
            && prefix.get(8..12).is_some_and(|brand| matches!(brand,
                b"isom" | b"iso2" | b"iso3" | b"iso4" | b"iso5" | b"iso6" | b"iso7" | b"iso8" | b"iso9"
                | b"mp41" | b"mp42" | b"avc1" | b"hvc1" | b"hev1" | b"qt  " | b"M4V " | b"MSNV" | b"dash")) => {
            Ok(if prefix.get(8..12) == Some(b"qt  ") { ("video/quicktime", "mov") } else { ("video/mp4", "mp4") })
        },
        MediaKind::Video if prefix.get(4..8).is_some_and(|atom| matches!(atom, b"wide" | b"moov" | b"mdat" | b"free")) => Ok(("video/quicktime", "mov")),
        MediaKind::Audio if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WAVE") => Ok(("audio/wav", "wav")),
        MediaKind::Audio if prefix.starts_with(b"ID3") || prefix.len() > 1 && prefix[0] == 0xff && prefix[1] & 0xe0 == 0xe0 => Ok(("audio/mpeg", "mp3")),
        _ => Err("火山参考音视频格式无效或不受支持".into()),
    }
}

#[cfg(windows)]
fn directory_leases(path: &Path) -> Result<Vec<File>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut files = Vec::new();
    for parent in path.parent().ok_or(INVALID)?.ancestors().collect::<Vec<_>>().into_iter().rev() {
        if parent.as_os_str().is_empty() { continue; }
        let file = OpenOptions::new().read(true).custom_flags(0x02000000 | 0x00200000).share_mode(1).open(parent).map_err(|_| INVALID)?;
        let metadata = file.metadata().map_err(|_| INVALID)?;
        if !metadata.is_dir() || crate::path_policy::is_link_or_reparse(&metadata) { return Err(INVALID.into()); }
        files.push(file);
    }
    Ok(files)
}
#[cfg(not(windows))]
fn directory_leases(_path: &Path) -> Result<Vec<File>, String> { Ok(Vec::new()) }

fn open_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(1);
    }
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")] options.custom_flags(0x100 | 0x4);
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))] options.custom_flags(0x20000 | 0x800);
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))] options.custom_flags(0x8000 | 0x800);
    }
    let file = options.open(path).map_err(|_| INVALID)?;
    let metadata = file.metadata().map_err(|_| INVALID)?;
    if !metadata.is_file() || crate::path_policy::is_link_or_reparse(&metadata) { return Err(INVALID.into()); }
    Ok(file)
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    if left.len() != right.len() || left.modified().ok() != right.modified().ok() { return false; }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if left.dev() != right.dev() || left.ino() != right.ino() { return false; }
    }
    true
}

enum Source { File(File), Memory(Cursor<Vec<u8>>) }
impl Read for Source {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> { match self { Self::File(file) => file.read(target), Self::Memory(bytes) => bytes.read(target) } }
}
impl Seek for Source {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> { match self { Self::File(file) => file.seek(position), Self::Memory(bytes) => bytes.seek(position) } }
}

struct Prepared {
    source: Source, total: u64, content_type: &'static str, extension: &'static str, digest: String,
    file: Option<(PathBuf, File, Metadata)>, _directory_leases: Vec<File>,
}
impl Prepared {
    fn verify(&self, app: &AppHandle) -> Result<(), String> {
        if let Some((path, file, original)) = &self.file {
            let current = crate::path_policy::authorize_existing_plain_file(app, path.to_str().ok_or(CHANGED)?).map_err(|_| CHANGED)?;
            if &current != path || !same_file(original, &file.metadata().map_err(|_| CHANGED)?)
                || !same_file(original, &std::fs::metadata(&current).map_err(|_| CHANGED)?) { return Err(CHANGED.into()); }
        }
        Ok(())
    }
}

fn prepare(app: &AppHandle, req: &UploadRequest, task: &Task) -> Result<Prepared, String> {
    let (mut source, file, leases, total) = match (&req.source.path, &req.source.data_url, &req.source.remote_url) {
        (Some(path), None, None) => {
            let path = crate::path_policy::authorize_existing_plain_file(app, path).map_err(|_| INVALID)?;
            let leases = directory_leases(&path)?;
            if crate::path_policy::authorize_existing_plain_file(app, path.to_str().ok_or(INVALID)?).map_err(|_| INVALID)? != path { return Err(INVALID.into()); }
            let file = open_file(&path)?;
            let metadata = file.metadata().map_err(|_| INVALID)?;
            let cloned = file.try_clone().map_err(|_| INVALID)?;
            let total = metadata.len();
            (Source::File(file), Some((path, cloned, metadata)), leases, total)
        },
        (None, Some(data_url), None) => {
            let (header, encoded) = data_url.split_once(',').ok_or(INVALID)?;
            let content_type = header.strip_prefix("data:").and_then(|header| header.strip_suffix(";base64")).ok_or(INVALID)?;
            let allowed = match req.kind {
                MediaKind::Image => ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/tiff", "image/gif", "image/heic", "image/heif"].contains(&content_type),
                MediaKind::Video => ["video/mp4", "video/quicktime"].contains(&content_type),
                MediaKind::Audio => ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"].contains(&content_type),
            };
            if !allowed || encoded.len() > ((SMALL_LIMIT as usize + 2) / 3) * 4 { return Err(INVALID.into()); }
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| INVALID)?;
            if bytes.len() as u64 > SMALL_LIMIT { return Err(INVALID.into()); }
            let total = bytes.len() as u64;
            (Source::Memory(Cursor::new(bytes)), None, Vec::new(), total)
        },
        (None, None, Some(remote_url)) => {
            let (file, leases, total) = download_remote_source(app, remote_url, req.kind, req.purpose, task)?;
            (Source::File(file), None, leases, total)
        },
        _ => return Err(INVALID.into()),
    };
    validate_media_size(total, req.kind, req.purpose)?;
    let mut prefix = [0_u8; 64];
    let prefix_length = source.read(&mut prefix).map_err(|_| INVALID)?;
    let (content_type, extension) = mime(&prefix[..prefix_length], req.kind)?;
    source.seek(SeekFrom::Start(0)).map_err(|_| INVALID)?;
    let mut hash = ChainDigest::new(); let mut buffer = vec![0_u8; CHUNK_SIZE]; let mut read = 0_u64;
    loop {
        task.check()?;
        let count = source.read(&mut buffer).map_err(|_| INVALID)?;
        if count == 0 { break; }
        read = read.checked_add(count as u64).ok_or(INVALID)?;
        if read > total { return Err(CHANGED.into()); }
        hash.update(&buffer[..count]);
    }
    if read != total { return Err(CHANGED.into()); }
    let digest = hash.finish();
    if let Some(expected) = &req.expected_source {
        if expected.bytes != total || expected.digest != digest { return Err(CHANGED.into()); }
    }
    source.seek(SeekFrom::Start(0)).map_err(|_| INVALID)?;
    let prepared = Prepared { source, total, content_type, extension, digest, file, _directory_leases: leases };
    prepared.verify(app)?; task.check()?;
    Ok(prepared)
}

struct UploadReader { source: Source, remaining: u64, hash: ChainDigest, complete: Arc<Mutex<Option<String>>>, cancelled: Arc<AtomicBool> }
impl Read for UploadReader {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        // Interrupted is retryable by standard Read consumers; cancellation must end the body.
        if self.cancelled.load(Ordering::Acquire) { return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "cancelled")); }
        if self.remaining == 0 { return Ok(0); }
        let maximum = target.len().min(self.remaining.min(CHUNK_SIZE as u64) as usize);
        let count = self.source.read(&mut target[..maximum])?;
        if count == 0 && maximum != 0 { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "source changed")); }
        self.remaining -= count as u64; self.hash.update(&target[..count]);
        if self.remaining == 0 {
            *self.complete.lock().map_err(|_| io::Error::other("unavailable"))? = Some(self.hash.clone().finish());
        }
        Ok(count)
    }
}

fn signed_object_result(bucket: &str, path: &str, purpose: UploadPurpose, credentials: &Credentials) -> Result<UploadResult, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| INVALID)?.as_secs();
    let host = object_get_host(bucket, purpose);
    Ok(UploadResult { url: signed_url("GET", &host, path, credentials, REGION, &timestamp(now)?, EXPIRES), expires_at: (now + EXPIRES) * 1000 })
}

fn tos_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder().https_only(true).no_proxy()
        .redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(300))
        .build().map_err(|_| NETWORK.into())
}

fn validate_existing_object(bucket: &str, path: &str, req: &UploadRequest, credentials: &Credentials, task: &Task) -> Result<(), String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| INVALID)?.as_secs();
    let head = signed_url("HEAD", &object_get_host(bucket, UploadPurpose::AssetIngestion), path, credentials, REGION, &timestamp(now)?, EXPIRES);
    task.check()?;
    let response = tos_client()?.head(head).send().map_err(|_| NETWORK)?;
    task.check()?;
    if response.status() != reqwest::StatusCode::OK { return Err(NETWORK.into()); }
    let total = response.headers().get(reqwest::header::CONTENT_LENGTH).and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok()).ok_or(INVALID)?;
    validate_media_size(total, req.kind, req.purpose)
}

fn upload(app: AppHandle, req: UploadRequest, task: Task) -> Result<UploadResult, String> {
    task.check()?; validate_bucket(&req.bucket)?;
    validate_source(&req.source, req.expected_source.as_ref())?;
    let credentials = credentials(&app, &req.credential_ref)?;
    if let Some(raw) = &req.source.remote_url {
        let url = remote_source_url(raw)?;
        if let Some(path) = reusable_object_path(raw, &url, &req.bucket, req.kind)? {
            // Only this fixed bucket is contacted. HEAD enforces the purpose's byte limit without copying the object.
            validate_existing_object(&req.bucket, &path, &req, &credentials, &task)?;
            return signed_object_result(&req.bucket, &path, req.purpose, &credentials);
        }
    }
    let mut prepared = prepare(&app, &req, &task)?;
    let key = format!("/ai-canvas/ark-reference/{}.{}", random_key()?, prepared.extension);
    let host = format!("{}.tos-cn-beijing.volces.com", req.bucket);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| INVALID)?.as_secs();
    let put = signed_url("PUT", &host, &key, &credentials, REGION, &timestamp(now)?, EXPIRES);
    let complete = Arc::new(Mutex::new(None));
    let reader = UploadReader { source: std::mem::replace(&mut prepared.source, Source::Memory(Cursor::new(Vec::new()))), remaining: prepared.total,
        hash: ChainDigest::new(), complete: complete.clone(), cancelled: task.cancelled.clone() };
    let http = tos_client()?;
    task.check()?; prepared.verify(&app)?;
    // No public-read ACL, redirects, write retry, or remote-response logging.
    let response = http.put(put).header(reqwest::header::CONTENT_TYPE, prepared.content_type)
        .body(reqwest::blocking::Body::sized(reader, prepared.total)).send();
    task.check()?;
    let response = response.map_err(|_| NETWORK)?;
    if !response.status().is_success() { return Err(NETWORK.into()); }
    drop(response);
    if complete.lock().map_err(|_| CHANGED)?.as_deref() != Some(prepared.digest.as_str()) { return Err(CHANGED.into()); }
    prepared.verify(&app)?; task.check()?;
    signed_object_result(&req.bucket, &key, req.purpose, &credentials)
}

#[tauri::command]
pub async fn upload_volcengine_tos_reference(app: AppHandle, webview: Webview, req: UploadRequest) -> Result<UploadResult, String> {
    ensure_main(&webview)?;
    let task = Task::start(req.request_id.clone())?;
    // Keep the task and all source leases until the actual blocking transport has ended.
    tauri::async_runtime::spawn_blocking(move || upload(app, req, task)).await.map_err(|_| NETWORK.to_string())?
}

#[tauri::command]
pub fn cancel_volcengine_tos_upload(webview: Webview, request_id: String) -> Result<(), String> {
    ensure_main(&webview)?; validate_request_id(&request_id)?;
    let mut tasks = TASKS.lock().map_err(|_| INVALID)?;
    if let Some(cancelled) = tasks.active.get(&request_id) { cancelled.store(true, Ordering::Release); }
    else if tasks.cancelled.len() < 256 { tasks.cancelled.insert(request_id); }
    else { return Err("火山 TOS 取消队列繁忙".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_json() -> serde_json::Value {
        serde_json::json!({ "requestId": "fixture-request", "bucket": "fixture-bucket",
            "credentialRef": "secret:provider/volcengine/tos/01234567-0123-4123-8123-0123456789ab",
            "kind": "image", "source": { "remoteUrl": "https://cdn.example/reference.png" } })
    }

    #[test]
    fn purposes_are_explicit_and_legacy_requests_remain_internal() {
        let legacy: UploadRequest = serde_json::from_value(request_json()).unwrap();
        assert_eq!(legacy.purpose, UploadPurpose::Reference);
        let mut value = request_json(); value["purpose"] = "asset-ingestion".into();
        let asset: UploadRequest = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(asset.purpose, UploadPurpose::AssetIngestion);
        for purpose in ["public", "arbitrary-host", "", "Reference"] {
            value["purpose"] = purpose.into();
            assert!(serde_json::from_value::<UploadRequest>(value.clone()).is_err());
        }
        let mut value = request_json(); value["source"]["uploadUrl"] = "https://other.example".into();
        assert!(serde_json::from_value::<UploadRequest>(value).is_err());
    }

    #[test]
    fn exactly_one_source_and_no_unverified_remote_fingerprint() {
        let remote: UploadRequest = serde_json::from_value(request_json()).unwrap();
        assert!(validate_source(&remote.source, None).is_ok());
        assert!(validate_source(&remote.source, Some(&ExpectedSource { digest: "a".repeat(64), bytes: 10 })).is_err());
        for source in [serde_json::json!({}), serde_json::json!({ "path": "/fixture", "remoteUrl": "https://cdn.example/ref.png" }),
            serde_json::json!({ "dataUrl": "data:image/png;base64,AA==", "remoteUrl": "https://cdn.example/ref.png" })] {
            assert!(validate_source(&serde_json::from_value::<UploadSource>(source).unwrap(), None).is_err());
        }
    }

    #[test]
    fn remote_urls_reject_private_endpoints_credentials_ports_and_fragments() {
        for source in ["file:///fixture/ref.png", "ftp://cdn.example/ref.png", "http://127.0.0.1/ref.png",
            "http://2130706433/ref.png", "https://[::1]/ref.png", "https://[::ffff:127.0.0.1]/ref.png",
            "https://10.0.0.1/ref.png", "http://169.254.169.254/latest", "https://192.0.2.1/ref.png",
            "https://localhost/ref.png", "https://asset.localhost/ref.png", "https://machine.local/ref.png",
            "https://machine.internal/ref.png", "https://user:password@cdn.example/ref.png",
            "https://cdn.example:8443/ref.png", "https://cdn.example/ref.png#fragment", "https://cdn.example/ref image.png"] {
            assert!(remote_source_url(source).is_err(), "{source}");
        }
        assert!(remote_source_url("https://cdn.example/ref.png?signature=opaque%2Fsource").is_ok());
        assert!(remote_source_url("http://cdn.example/ref.mp4").is_ok());
    }

    #[test]
    fn own_objects_are_reused_only_for_exact_generated_keys_and_matching_media() {
        let path = format!("/ai-canvas/ark-reference/{}.png", "a".repeat(48));
        for host in ["fixture-bucket.tos-cn-beijing.ivolces.com", "fixture-bucket.tos-cn-beijing.volces.com"] {
            let raw = format!("https://{host}{path}?X-Tos-Signature=old&X-Tos-Credential=old%2Fscope");
            assert_eq!(reusable_object_path(&raw, &remote_source_url(&raw).unwrap(), "fixture-bucket", MediaKind::Image).unwrap(), Some(path.clone()));
            assert!(reusable_object_path(&raw, &remote_source_url(&raw).unwrap(), "fixture-bucket", MediaKind::Audio).is_err());
        }
        for suffix in [format!("/other/{}.png", "a".repeat(48)), format!("/ai-canvas/ark-reference/{}.png?token=secret", "a".repeat(48)),
            format!("/ai-canvas/ark-reference/../ark-reference/{}.png", "a".repeat(48)),
            format!("/ai-canvas/ark-reference/%2e%2e/ark-reference/{}.png", "a".repeat(48)),
            format!("/ai-canvas/ark-reference/{}.png", "A".repeat(48)), "/ai-canvas/ark-reference/short.png".into()] {
            let raw = format!("https://fixture-bucket.tos-cn-beijing.ivolces.com{suffix}");
            assert!(reusable_object_path(&raw, &remote_source_url(&raw).unwrap(), "fixture-bucket", MediaKind::Image).is_err());
        }
        let raw = format!("https://other-bucket.tos-cn-beijing.volces.com{path}");
        assert!(reusable_object_path(&raw, &remote_source_url(&raw).unwrap(), "fixture-bucket", MediaKind::Image).unwrap().is_none());
        let raw = "https://fixture-bucket.tos-cn-beijing.volces.com/user-folder/reference.png?X-Tos-Signature=user-provided";
        assert!(reusable_object_path(raw, &remote_source_url(raw).unwrap(), "fixture-bucket", MediaKind::Image).unwrap().is_none());
        let raw = "https://fixture-bucket.tos-cn-beijing.volces.com/ai-canvas/ark-reference/user-file.png?X-Tos-Signature=user-provided";
        assert!(reusable_object_path(raw, &remote_source_url(raw).unwrap(), "fixture-bucket", MediaKind::Image).unwrap().is_none());
    }

    #[test]
    fn public_ingestion_and_internal_inference_use_distinct_get_signatures() {
        let credentials = Credentials { access_key_id: "testAK".into(), secret_access_key: "testSK".into() };
        let path = format!("/ai-canvas/ark-reference/{}.png", "a".repeat(48));
        let internal = signed_url("GET", &object_get_host("fixture-bucket", UploadPurpose::Reference), &path, &credentials, REGION, "20260101T000000Z", EXPIRES);
        let public = signed_url("GET", &object_get_host("fixture-bucket", UploadPurpose::AssetIngestion), &path, &credentials, REGION, "20260101T000000Z", EXPIRES);
        let internal = Url::parse(&internal).unwrap(); let public = Url::parse(&public).unwrap();
        assert_eq!(internal.host_str(), Some("fixture-bucket.tos-cn-beijing.ivolces.com"));
        assert_eq!(public.host_str(), Some("fixture-bucket.tos-cn-beijing.volces.com"));
        let signature = |url: &Url| url.query_pairs().find(|(key, _)| key == "X-Tos-Signature").unwrap().1.into_owned();
        assert_ne!(signature(&internal), signature(&public));
    }

    #[test]
    fn ingestion_byte_limits_are_distinct_and_stream_copy_is_bounded_and_cancellable() {
        assert!(validate_media_size(30_000_000, MediaKind::Image, UploadPurpose::AssetIngestion).is_err());
        assert!(validate_media_size(29_999_999, MediaKind::Image, UploadPurpose::AssetIngestion).is_ok());
        assert!(validate_media_size(15_000_000, MediaKind::Audio, UploadPurpose::AssetIngestion).is_ok());
        assert!(validate_media_size(15_000_001, MediaKind::Audio, UploadPurpose::AssetIngestion).is_err());
        assert!(validate_media_size(SMALL_LIMIT, MediaKind::Audio, UploadPurpose::Reference).is_ok());
        assert!(validate_media_size(VIDEO_LIMIT, MediaKind::Video, UploadPurpose::AssetIngestion).is_ok());
        assert!(validate_media_size(VIDEO_LIMIT + 1, MediaKind::Video, UploadPurpose::Reference).is_err());
        let task = Task { id: "fixture-copy".into(), cancelled: Arc::new(AtomicBool::new(false)) };
        let mut output = Vec::new();
        assert_eq!(copy_remote_media(&mut Cursor::new(vec![1, 2, 3]), &mut output, 3, &task).unwrap(), 3);
        assert_eq!(output, vec![1, 2, 3]);
        output.clear();
        assert!(copy_remote_media(&mut Cursor::new(vec![1, 2, 3, 4]), &mut output, 3, &task).is_err());
        assert!(output.len() <= 3);
        task.cancelled.store(true, Ordering::Release);
        assert!(copy_remote_media(&mut Cursor::new(vec![1]), &mut output, 3, &task).is_err());
    }

    #[test]
    fn object_keys_keep_24_random_bytes_as_lowercase_hex() {
        let key = random_key().unwrap();
        assert_eq!(key.len(), 48);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn signature_matches_official_tos_get_example() {
        // Official TOS URL-signature example, not an AWS S3 signature.
        let credentials = Credentials { access_key_id: "testAK".into(), secret_access_key: "testSK".into() };
        let url = signed_url("GET", "examplebucket.tos-ap-southeast-1.bytepluses.com", "/exampleobject", &credentials,
            "ap-southeast-1", "20220101T000000Z", 86_400);
        assert!(url.ends_with("X-Tos-Signature=353aa55583eceb222aad4bdcb70d4045a202a4af9a3096f25a656b82c8ec2f56"));
        assert!(url.contains("X-Tos-Credential=testAK%2F20220101%2Fap-southeast-1%2Ftos%2Frequest"));
        assert_eq!(timestamp(1_640_995_200).unwrap(), "20220101T000000Z");
        assert_eq!(timestamp(0).unwrap(), "19700101T000000Z");
    }

    #[test]
    fn restricted_credentials_bucket_and_encoding() {
        assert!(credential_key("secret:provider/volcengine/tos/01234567-0123-4123-8123-0123456789ab").is_ok());
        for value in ["secret:provider/volcengine", "secret:provider/volcengine/asset-library/access-key", "secret:object-storage/x", "provider/volcengine/tos/x"] {
            assert!(credential_key(value).is_err());
        }
        for value in ["abc", "bucket-123", "123"] { assert!(validate_bucket(value).is_ok()); }
        for value in ["", "x", "-bucket", "bucket-", "bucket.example", "Bucket", "foo/../bar", "foo?query=x"] { assert!(validate_bucket(value).is_err()); }
        assert_eq!(encode("/素材/a b+%.png", true), "/%E7%B4%A0%E6%9D%90/a%20b%2B%25.png");
    }

    #[test]
    fn content_digest_matches_independently_chunked_source_and_reader_rejects_cancellation() {
        let bytes = vec![17; CHUNK_SIZE + 37];
        let mut whole = ChainDigest::new(); whole.update(&bytes);
        let expected = whole.finish();
        let mut fragmented = ChainDigest::new();
        for chunk in bytes.chunks(31) { fragmented.update(chunk); }
        assert_eq!(fragmented.finish(), expected);
        let complete = Arc::new(Mutex::new(None)); let cancelled = Arc::new(AtomicBool::new(false));
        let mut reader = UploadReader { source: Source::Memory(Cursor::new(bytes.clone())), remaining: bytes.len() as u64,
            hash: ChainDigest::new(), complete: complete.clone(), cancelled: cancelled.clone() };
        let mut output = Vec::new(); reader.read_to_end(&mut output).unwrap();
        assert_eq!(output, bytes); assert_eq!(complete.lock().unwrap().as_deref(), Some(expected.as_str()));
        cancelled.store(true, Ordering::Release);
        assert_eq!(reader.read(&mut [0]).unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
    }
}
