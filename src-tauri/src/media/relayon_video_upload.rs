//! 万象视频的本机文件上传。先冻结参考素材，再按原表单顺序发送同一份字节。
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{File, OpenOptions},
    io,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Webview};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const INVALID: &str = "万象视频上传参数或参考文件无效";
const SOURCE: &str = "无法读取万象参考素材，请检查文件和访问权限";
const TEMP: &str = "无法暂存万象参考素材，请检查磁盘可用空间和权限";
const STALE: &str = "万象视频上传准备已失效";
const CANCELLED: &str = "万象视频上传已取消";
const NETWORK: &str = "万象视频提交连接中断，请先核对平台任务记录";
const CHUNK: usize = 256 * 1024;
const IDLE: Duration = Duration::from_secs(600);
const MAX_RESPONSE: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Image, Video, Audio }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    kind: Kind,
    path: Option<String>,
    remote_url: Option<String>,
    mime_type: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo { sha256: String, bytes: u64, mime_type: String }

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Part {
    Text { name: String, value: String },
    File { name: String, #[serde(rename = "fileIndex")] file_index: usize, filename: String },
}

#[derive(Serialize)]
pub struct Response { status: u16, body: String, headers: Vec<(String, String)> }

struct Snapshot {
    file: tokio::fs::File,
    hash: Sha256,
    bytes: u64,
    prefix: Vec<u8>,
    kind: Kind,
    mime_hint: Option<String>,
    accepts_chunks: bool,
    byte_limit: u64,
}

fn random_token() -> Result<String, String> {
    let bytes = crate::secure_random::random_bytes::<24>().map_err(|_| TEMP)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn anonymous_file() -> Result<File, String> {
    let path = std::env::temp_dir().join(format!("ai-canvas-relayon-{}", random_token()?));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(0x80000000 | 0x40000000 | 0x00010000)
            .custom_flags(0x04000000 | 0x00200000).share_mode(0);
    }
    let file = options.open(&path).map_err(|_| TEMP)?;
    // Unix 上打开后就移除名字；Windows 由最后一个句柄关闭时删除，进程退出也会清理。
    #[cfg(unix)]
    std::fs::remove_file(path).map_err(|_| TEMP)?;
    Ok(file)
}

fn media_mime(kind: Kind, prefix: &[u8], hint: Option<&str>) -> Result<String, String> {
    let is = |s: &[u8]| prefix.starts_with(s);
    let riff = |s: &[u8]| is(b"RIFF") && prefix.get(8..12) == Some(s);
    let is_mp4 = prefix.get(4..8) == Some(b"ftyp");
    let brand = prefix.get(8..12).unwrap_or_default();
    let hint = hint.unwrap_or("").split(';').next().unwrap_or("").trim();
    let asf = is(&[0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
    let mime = match kind {
        Kind::Image if is(b"\x89PNG\r\n\x1a\n") => "image/png",
        Kind::Image if is(&[0xff, 0xd8, 0xff]) => "image/jpeg",
        Kind::Image if is(b"GIF87a") || is(b"GIF89a") => "image/gif",
        Kind::Image if riff(b"WEBP") => "image/webp",
        Kind::Image if is(b"BM") => "image/bmp",
        Kind::Image if is(&[0, 0, 1, 0]) && prefix.get(4..6).is_some_and(|count| count != [0, 0]) => "image/x-icon",
        Kind::Image if is(b"II*\0") || is(b"MM\0*") => "image/tiff",
        Kind::Image if is_mp4 && matches!(brand, b"avif" | b"avis") => "image/avif",
        Kind::Image if is_mp4 && matches!(brand, b"heic" | b"heix" | b"mif1" | b"hevc" | b"msf1") => "image/heic",
        Kind::Image if String::from_utf8_lossy(prefix).trim_start_matches('\u{feff}').trim_start().starts_with('<')
            && prefix.windows(4).any(|w| w == b"<svg") => "image/svg+xml",
        Kind::Video if is_mp4 && brand == b"qt  " => "video/quicktime",
        Kind::Video if is_mp4 && (brand.starts_with(b"M4V") || hint == "video/x-m4v") => "video/x-m4v",
        Kind::Video if is_mp4 => "video/mp4",
        Kind::Video if legacy_quicktime(prefix) => "video/quicktime",
        Kind::Video if is(b"FLV\x01") => "video/x-flv",
        Kind::Video if asf => "video/x-ms-wmv",
        Kind::Video if riff(b"AVI ") => "video/x-msvideo",
        Kind::Video if is(&[0x1a, 0x45, 0xdf, 0xa3]) =>
            if hint == "video/x-matroska" || prefix.windows(8).any(|w| w == b"matroska") { "video/x-matroska" } else { "video/webm" },
        Kind::Video if is(b"OggS") => "video/ogg",
        Kind::Audio if riff(b"WAVE") => "audio/wav",
        Kind::Audio if asf => "audio/x-ms-wma",
        Kind::Audio if is(b"fLaC") => "audio/flac",
        Kind::Audio if is(b"OggS") && prefix.windows(8).any(|w| w == b"OpusHead") => "audio/opus",
        Kind::Audio if is(b"OggS") => "audio/ogg",
        Kind::Audio if is_mp4 => "audio/mp4",
        Kind::Audio if is(&[0x1a, 0x45, 0xdf, 0xa3]) => "audio/webm",
        Kind::Audio if is(&[0xff, 0xf1]) || is(&[0xff, 0xf9]) => "audio/aac",
        Kind::Audio if is(b"ID3") || prefix.len() >= 2 && prefix[0] == 0xff && prefix[1] & 0xe0 == 0xe0 => "audio/mpeg",
        _ => return Err("万象参考素材的内容与媒体类型不符".into()),
    };
    Ok(mime.into())
}

fn legacy_quicktime(mut prefix: &[u8]) -> bool {
    // 早期 MOV 没有 ftyp，可能先放一个空的 wide/free atom，再开始视频数据。
    while let Some(header) = prefix.get(..8) {
        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        if matches!(&header[4..8], b"moov" | b"mdat") {
            return size == 0 || size >= 8 || size == 1 && prefix.get(8..16)
                .is_some_and(|s| u64::from_be_bytes(s.try_into().expect("eight-byte atom size")) >= 16);
        }
        if !matches!(&header[4..8], b"wide" | b"free" | b"skip") || size < 8 { return false; }
        let Some(next) = prefix.get(size..) else { return false; };
        prefix = next;
    }
    false
}

impl Snapshot {
    fn new(source: &Source) -> Result<Self, String> {
        Ok(Self { file: tokio::fs::File::from_std(anonymous_file()?), hash: Sha256::new(), bytes: 0,
            prefix: Vec::new(), kind: source.kind, mime_hint: source.mime_type.clone(),
            accepts_chunks: source.path.is_none() && source.remote_url.is_none(), byte_limit: u64::MAX })
    }

    async fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        let total = self.bytes.checked_add(bytes.len() as u64).ok_or(TEMP)?;
        if total > self.byte_limit { return Err("Sand AI 参考素材超过该媒体类型的文件大小上限".into()); }
        self.file.write_all(bytes).await.map_err(|_| TEMP)?;
        self.hash.update(bytes);
        self.bytes = total;
        let n = bytes.len().min(4096 - self.prefix.len());
        self.prefix.extend_from_slice(&bytes[..n]);
        Ok(())
    }

    fn info(&self) -> Result<FileInfo, String> {
        Ok(FileInfo { sha256: format!("{:x}", self.hash.clone().finalize()), bytes: self.bytes,
            mime_type: media_mime(self.kind, &self.prefix, self.mime_hint.as_deref())? })
    }
}

enum Phase {
    Preparing,
    Open(Vec<Snapshot>),
    Sealed(Vec<Snapshot>, Vec<FileInfo>),
    Sending,
}

struct Session {
    phase: tokio::sync::Mutex<Phase>,
    last_active: Mutex<Instant>,
    cancel: CancellationToken,
    sand_origin: Option<String>,
}
impl Session {
    fn touch(&self) {
        if let Ok(mut value) = self.last_active.lock() { *value = Instant::now(); }
    }
}
#[derive(Default)]
struct Registry {
    active: HashMap<String, Arc<Session>>,
    early_cancels: HashMap<String, Instant>,
}
static SESSIONS: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn ensure_main(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview)?;
    if webview.label() != "main" { return Err("仅主窗口可提交万象视频".into()); }
    Ok(())
}

fn session(id: &str) -> Result<Arc<Session>, String> {
    let map = SESSIONS.lock().map_err(|_| STALE)?;
    let session = map.active.get(id).ok_or(STALE)?.clone();
    session.touch();
    Ok(session)
}

fn remove(id: &str, expected: &Arc<Session>) {
    if let Ok(mut map) = SESSIONS.lock() {
        if map.active.get(id).is_some_and(|session| Arc::ptr_eq(session, expected)) {
            map.active.remove(id);
            expected.cancel.cancel();
        }
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)) {
        return Err(INVALID.into());
    }
    Ok(())
}

fn register(id: &str, sand_origin: Option<String>) -> Result<Arc<Session>, String> {
    validate_id(id)?;
    let mut map = SESSIONS.lock().map_err(|_| STALE)?;
    map.early_cancels.retain(|_, time| time.elapsed() < Duration::from_secs(30));
    if map.early_cancels.remove(id).is_some() { return Err(CANCELLED.into()); }
    if map.active.len() >= 32 || map.active.contains_key(id) { return Err("万象视频上传准备繁忙或请求重复".into()); }
    if sand_origin.is_some() && map.active.values().filter(|session| session.sand_origin.is_some()).count() >= 2 {
        return Err("视频素材上传繁忙，请等待当前上传完成".into());
    }
    let session = Arc::new(Session { phase: tokio::sync::Mutex::new(Phase::Preparing),
        last_active: Mutex::new(Instant::now()), cancel: CancellationToken::new(), sand_origin });
    map.active.insert(id.to_owned(), session.clone());
    let id = id.to_owned();
    let active = session.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = active.cancel.cancelled() => return,
                _ = tokio::time::sleep(IDLE) => {}
            }
            if active.last_active.lock().map_or(true, |value| value.elapsed() >= IDLE) {
                remove(&id, &active);
                return;
            }
        }
    });
    Ok(session)
}

#[cfg(windows)]
fn hold_parent_dirs(path: &std::path::Path) -> Result<Vec<File>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut held = Vec::new();
    for dir in path.parent().ok_or(SOURCE)?.ancestors().collect::<Vec<_>>().into_iter().rev() {
        if dir.as_os_str().is_empty() { continue; }
        let file = OpenOptions::new().read(true).custom_flags(0x02000000 | 0x00200000)
            .share_mode(1).open(dir).map_err(|_| SOURCE)?;
        let meta = file.metadata().map_err(|_| SOURCE)?;
        if !meta.is_dir() || crate::path_policy::is_link_or_reparse(&meta) { return Err(SOURCE.into()); }
        held.push(file);
    }
    Ok(held)
}

async fn copy_local(app: &AppHandle, raw: &str, dest: &mut Snapshot, session: &Session) -> Result<(), String> {
    let authorize = || crate::path_policy::authorize_existing_plain_file(app, raw).map_err(|_| SOURCE);
    let path = authorize()?;
    #[cfg(windows)]
    let _parents = hold_parent_dirs(&path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000).share_mode(1); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")] options.custom_flags(0x100 | 0x4);
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))] options.custom_flags(0x20000 | 0x800);
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))] options.custom_flags(0x8000 | 0x800);
    }
    let input = options.open(&path).map_err(|_| SOURCE)?;
    let original = input.metadata().map_err(|_| SOURCE)?;
    if original.len() > dest.byte_limit { return Err("Sand AI 参考素材超过该媒体类型的文件大小上限".into()); }
    let verify = || -> Result<(), String> {
        if authorize()? != path { return Err(SOURCE.into()); }
        let current = std::fs::symlink_metadata(&path).map_err(|_| SOURCE)?;
        if !current.is_file() || crate::path_policy::is_link_or_reparse(&current)
            || current.len() != original.len() || current.modified().ok() != original.modified().ok() { return Err(SOURCE.into()); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if current.dev() != original.dev() || current.ino() != original.ino() { return Err(SOURCE.into()); }
        }
        Ok(())
    };
    verify()?;
    let mut file = tokio::fs::File::from_std(input);
    let mut buf = vec![0_u8; CHUNK];
    loop {
        let n = file.read(&mut buf).await.map_err(|_| SOURCE)?;
        if n == 0 { break; }
        dest.append(&buf[..n]).await?;
        session.touch();
    }
    verify()?;
    if original.len() != dest.bytes { return Err(SOURCE.into()); }
    Ok(())
}

const REMOTE: &str = "无法读取万象参考素材，请检查公开 HTTPS 地址";
async fn copy_remote(raw: &str, dest: &mut Snapshot, session: &Session) -> Result<(), String> {
    let mut url = url::Url::parse(raw).map_err(|_| REMOTE)?;
    for _ in 0..=8 {
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(REMOTE.into());
        }
        let host = url.host_str().ok_or(REMOTE)?;
        let port = url.port_or_known_default().ok_or(REMOTE)?;
        let addresses: Vec<std::net::SocketAddr> = match url.host().ok_or(REMOTE)? {
            url::Host::Ipv4(ip) => vec![(ip, port).into()],
            url::Host::Ipv6(ip) => vec![(ip, port).into()],
            url::Host::Domain(_) => tokio::net::lookup_host((host, port)).await.map_err(|_| REMOTE)?.collect(),
        };
        if addresses.is_empty() || addresses.iter().any(|a| crate::assistant_web::is_disallowed_ip(a.ip())) { return Err(REMOTE.into()); }
        // 每一跳都固定刚核实的地址，下载端不接收模型连接的鉴权或代理设置。
        let client = reqwest::Client::builder().https_only(true).no_proxy()
            .redirect(reqwest::redirect::Policy::none()).resolve_to_addrs(host, &addresses)
            .connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(180))
            .build().map_err(|_| REMOTE)?;
        let mut reply = client.get(url.clone()).send().await.map_err(|_| REMOTE)?;
        if reply.status().is_redirection() {
            let next = reply.headers().get(reqwest::header::LOCATION).and_then(|s| s.to_str().ok()).ok_or(REMOTE)?;
            url = url.join(next).map_err(|_| REMOTE)?;
            continue;
        }
        if reply.status() != reqwest::StatusCode::OK { return Err(REMOTE.into()); }
        let expected = reply.content_length();
        while let Some(chunk) = reply.chunk().await.map_err(|_| REMOTE)? {
            dest.append(&chunk).await?;
            session.touch();
        }
        if expected.is_some_and(|length| dest.bytes != length) { return Err(REMOTE.into()); }
        return Ok(());
    }
    Err(REMOTE.into())
}

#[tauri::command]
pub async fn prepare_relayon_video_upload(app: AppHandle, webview: Webview, request_id: String,
    sources: Vec<Source>, sand_origin: Option<String>) -> Result<(), String> {
    ensure_main(&webview)?;
    if sources.is_empty() { return Err(INVALID.into()); }
    let asset_upload = sand_origin.is_some();
    let beatapi = sand_origin.as_deref() == Some("https://api.beatapi.io");
    if asset_upload && (!matches!(sand_origin.as_deref(), Some("https://api.sand.ai" | "https://api.sandai.cn" | "https://api.beatapi.io"))
        || sources.len() != 1 || sources[0].remote_url.is_some()) {
        return Err("视频素材上传参数无效".into());
    }
    let session = register(&request_id, sand_origin)?;
    let prepare = async {
        let mut files = Vec::with_capacity(sources.len());
        for source in sources {
            let mut snapshot = Snapshot::new(&source)?;
            if beatapi {
                snapshot.byte_limit = match source.kind {
                    Kind::Video => 100_000_000,
                    Kind::Image | Kind::Audio => 50_000_000,
                };
            } else if asset_upload {
                snapshot.byte_limit = match source.kind {
                    Kind::Image => 29_999_999,
                    Kind::Video => 200_000_000,
                    Kind::Audio => 15_000_000,
                };
            }
            match (source.path.as_deref(), source.remote_url.as_deref()) {
                (Some(path), None) => copy_local(&app, path, &mut snapshot, &session).await?,
                (None, Some(url)) => copy_remote(url, &mut snapshot, &session).await?,
                (None, None) => {},
                _ => return Err(INVALID.to_string()),
            }
            files.push(snapshot);
        }
        *session.phase.lock().await = Phase::Open(files);
        Ok(())
    };
    let result = tokio::select! {
        biased;
        _ = session.cancel.cancelled() => Err(CANCELLED.into()),
        result = prepare => result,
    };
    if result.is_err() { remove(&request_id, &session); }
    result
}

#[tauri::command]
pub async fn append_relayon_video_upload(webview: Webview, request_id: String, index: usize, chunk: String) -> Result<(), String> {
    ensure_main(&webview)?;
    let session = session(&request_id)?;
    let append = async {
        // 限制单次 IPC 的内存占用，总量随块数增长。
        if chunk.is_empty() || chunk.len() > (1024usize * 1024).div_ceil(3) * 4 { return Err(INVALID.to_string()); }
        let data = STANDARD.decode(chunk).map_err(|_| INVALID)?;
        let mut phase = session.phase.lock().await;
        let Phase::Open(files) = &mut *phase else { return Err(STALE.into()); };
        let file = files.get_mut(index).filter(|f| f.accepts_chunks).ok_or(INVALID)?;
        file.append(&data).await
    };
    let result = tokio::select! {
        biased;
        _ = session.cancel.cancelled() => Err(CANCELLED.into()),
        result = append => result,
    };
    if result.is_err() { remove(&request_id, &session); }
    result
}

#[tauri::command]
pub async fn seal_relayon_video_upload(webview: Webview, request_id: String) -> Result<Vec<FileInfo>, String> {
    ensure_main(&webview)?;
    let session = session(&request_id)?;
    let mut phase = session.phase.lock().await;
    let Phase::Open(files) = &mut *phase else { return Err(STALE.into()); };
    let infos = files.iter().map(Snapshot::info).collect::<Result<Vec<_>, _>>()?;
    for file in files.iter_mut() {
        file.file.flush().await.map_err(|_| TEMP)?;
        file.file.rewind().await.map_err(|_| TEMP)?;
    }
    *phase = Phase::Sealed(std::mem::take(files), infos.clone());
    Ok(infos)
}

fn endpoint(url: &str) -> bool {
    matches!(url, "https://api.relayonapi.com/v1/videos" | "https://relayonapi.com/v1/videos")
}

enum Segment { Text(Vec<u8>), File(usize) }
struct Multipart {
    segments: VecDeque<Segment>,
    length: u64,
}

impl Multipart {
    fn build(parts: Vec<Part>, files: &[FileInfo], boundary: &str, sand: bool) -> Result<Self, String> {
        let mut form = Self { segments: VecDeque::new(), length: 0 };
        let mut used = vec![false; files.len()];
        for part in parts {
            let name = match &part { Part::Text { name, .. } | Part::File { name, .. } => name };
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._[]-".contains(&b)) { return Err(INVALID.into()); }
            let disposition = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"");
            match part {
                Part::Text { value, .. } => {
                    form.text(format!("{disposition}\r\n\r\n"))?;
                    form.text(value)?;
                }
                Part::File { name, file_index, filename } => {
                    let info = files.get(file_index).ok_or(INVALID)?;
                    let kind = info.mime_type.split('/').next().ok_or(INVALID)?;
                    if !(if sand { name == "file" } else { name == kind || name == format!("{kind}s") }) || filename.is_empty()
                        || !filename.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
                        return Err(INVALID.into());
                    }
                    form.text(format!("{disposition}; filename=\"{filename}\"\r\nContent-Type: {}\r\n\r\n", info.mime_type))?;
                    form.length = form.length.checked_add(info.bytes).ok_or(INVALID)?;
                    form.segments.push_back(Segment::File(file_index));
                    used[file_index] = true;
                }
            }
            form.text("\r\n".into())?;
        }
        if used.is_empty() || used.contains(&false) { return Err(INVALID.into()); }
        form.text(format!("--{boundary}--\r\n"))?;
        Ok(form)
    }
    fn text(&mut self, text: String) -> Result<(), String> {
        self.length = self.length.checked_add(text.len() as u64).ok_or(INVALID)?;
        if !text.is_empty() { self.segments.push_back(Segment::Text(text.into_bytes())); }
        Ok(())
    }
}

struct UploadBody { segments: VecDeque<Segment>, files: Vec<Snapshot> }
impl UploadBody {
    async fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        while let Some(segment) = self.segments.pop_front() {
            match segment {
                Segment::Text(bytes) => return Ok(Some(bytes)),
                Segment::File(index) => {
                    let source = &mut self.files[index].file;
                    let mut bytes = vec![0; CHUNK];
                    let n = source.read(&mut bytes).await?;
                    if n > 0 {
                        bytes.truncate(n);
                        self.segments.push_front(Segment::File(index));
                        return Ok(Some(bytes));
                    }
                    // 允许同一份素材在表单中被引用多次。
                    source.rewind().await?;
                }
            }
        }
        Ok(None)
    }
}

async fn submit(url: String, headers: Vec<(String, String)>, parts: Vec<Part>, files: Vec<Snapshot>,
    infos: &[FileInfo], session: Arc<Session>) -> Result<Response, String> {
    let asset_upload = session.sand_origin.is_some();
    let beatapi = session.sand_origin.as_deref() == Some("https://api.beatapi.io");
    if let Some(origin) = &session.sand_origin {
        let path = if beatapi { "/v1/files" } else { "/v1/assets" };
        if url != format!("{origin}{path}") || parts.len() != 1 || infos.len() != 1
            || !matches!(&parts[0], Part::File { name, file_index: 0, .. } if name == "file")
            || !matches!(infos[0].mime_type.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/bmp"
                | "image/tiff" | "image/gif" | "image/heic" | "video/mp4" | "video/quicktime" | "audio/wav" | "audio/mpeg") {
            return Err("视频素材上传地址或媒体格式无效".into());
        }
        if beatapi && !matches!(infos[0].mime_type.as_str(), "image/jpeg" | "image/png" | "image/webp"
            | "video/mp4" | "video/quicktime" | "audio/wav" | "audio/mpeg") {
            return Err("BeatAPI MAGI-2 素材格式无效".into());
        }
    } else if !endpoint(&url) { return Err("万象文件上传地址无效".into()); }
    let boundary = format!("ai-canvas-{}", random_token()?);
    let form = Multipart::build(parts, infos, &boundary, asset_upload)?;
    if asset_upload && form.length > 201_048_576 { return Err("视频素材上传请求超过上限".into()); }
    let network = if asset_upload { "素材上传连接中断，请核对素材上传状态后再试" } else { NETWORK };
    // 使用单次不可重放的请求。服务商若要求跳转，由调用方核对这次的任务状态。
    let builder = reqwest::Client::builder().https_only(true).user_agent("AI-Canvas/0.1").redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never()).connect_timeout(Duration::from_secs(20));
    let client = if asset_upload { builder.timeout(Duration::from_secs(600)) } else { builder }
        .build().map_err(|_| network)?;
    let mut request = client.post(url);
    for (name, value) in headers {
        match name.to_ascii_lowercase().as_str() {
            "authorization" | "accept" => { request = request.header(name, value); }
            "idempotency-key" if !asset_upload => { request = request.header(name, value); }
            "content-type" => {}, // 包含本次随机 boundary 的 Content-Type 由原生端填写。
            _ => return Err("万象视频请求头无效".into()),
        }
    }
    let wire = UploadBody { segments: form.segments, files };
    let stream = futures_util::stream::try_unfold((wire, session.clone()), |(mut wire, session)| async move {
        session.touch();
        Ok::<_, io::Error>(wire.next().await?.map(|bytes| (bytes, (wire, session))))
    });
    let mut response = request.header(reqwest::header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
        .header(reqwest::header::CONTENT_LENGTH, form.length)
        .body(reqwest::Body::wrap_stream(stream)).send().await.map_err(|_| network)?;
    let status = response.status().as_u16();
    let headers = ["content-type", "retry-after"].iter().filter_map(|&key| response.headers().get(key)
        .and_then(|value| value.to_str().ok()).map(|value| (key.to_owned(), value.to_owned()))).collect();
    let mut bytes = Vec::new();
    let limit = if asset_upload { 32 * 1024 } else { MAX_RESPONSE };
    while let Some(chunk) = response.chunk().await.map_err(|_| network)? {
        if chunk.len() > limit - bytes.len() { return Err("上传响应超过安全上限，请核对平台记录".into()); }
        bytes.extend_from_slice(&chunk);
        session.touch();
    }
    let body = if beatapi {
        if (200..300).contains(&status) {
            let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "BeatAPI 上传未返回有效 JSON")?;
            let url = payload.pointer("/data/url").and_then(serde_json::Value::as_str)
                .filter(|url| url.len() <= 8192 && url.starts_with("https://"))
                .ok_or("BeatAPI 上传未返回有效素材地址")?;
            serde_json::json!({ "data": { "url": url } }).to_string()
        } else { String::new() }
    } else if asset_upload {
        if status == 200 {
            let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Sand AI 上传未返回有效 JSON")?;
            let id = payload.get("id").and_then(serde_json::Value::as_i64).filter(|id| *id > 0)
                .ok_or("Sand AI 上传未返回有效素材 ID")?;
            serde_json::json!({ "id": id.to_string() }).to_string()
        } else { String::new() }
    } else { String::from_utf8_lossy(&bytes).into_owned() };
    Ok(Response { status, headers, body })
}

#[tauri::command]
pub async fn submit_relayon_video_upload(webview: Webview, request_id: String, url: String,
    headers: Vec<(String, String)>, parts: Vec<Part>) -> Result<Response, String> {
    ensure_main(&webview)?;
    let session = session(&request_id)?;
    let (files, infos) = {
        let mut phase = session.phase.lock().await;
        if !matches!(&*phase, Phase::Sealed(_, _)) { return Err(STALE.into()); }
        let Phase::Sealed(files, infos) = std::mem::replace(&mut *phase, Phase::Sending) else { return Err(STALE.into()); };
        (files, infos)
    };
    let result = tokio::select! {
        biased;
        _ = session.cancel.cancelled() => Err(CANCELLED.into()),
        result = submit(url, headers, parts, files, &infos, session.clone()) => result,
    };
    remove(&request_id, &session);
    result
}

#[tauri::command]
pub fn cancel_relayon_video_upload(webview: Webview, request_id: String) -> Result<(), String> {
    ensure_main(&webview)?;
    validate_id(&request_id)?;
    let mut map = SESSIONS.lock().map_err(|_| STALE)?;
    if let Some(session) = map.active.remove(&request_id) {
        session.cancel.cancel();
    } else {
        // 两个 IPC 可以先收到取消，再收到准备。短期记下编号，避免那次准备又开始读文件。
        map.early_cancels.retain(|_, time| time.elapsed() < Duration::from_secs(30));
        if map.early_cancels.len() >= 256 { return Err("万象视频取消队列繁忙".into()); }
        map.early_cancels.insert(request_id, Instant::now());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submission_stays_on_official_video_endpoints() {
        assert!(endpoint("https://api.relayonapi.com/v1/videos"));
        assert!(endpoint("https://relayonapi.com/v1/videos"));
        for url in ["http://api.relayonapi.com/v1/videos", "https://api.relayonapi.com.example/v1/videos",
            "https://api.relayonapi.com/v1/videos?q=1", "https://api.relayonapi.com/v1/other"] { assert!(!endpoint(url)); }
    }

    #[test]
    fn recognizes_reference_containers_including_older_quicktime() {
        let asf = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0, 0xaa, 0, 0x62, 0xce, 0x6c];
        for (kind, header, expected) in [
            (Kind::Video, &asf[..], "video/x-ms-wmv"), (Kind::Audio, &asf[..], "audio/x-ms-wma"),
            (Kind::Video, &b"FLV\x01"[..], "video/x-flv"), (Kind::Audio, &b"OggS\0OpusHead"[..], "audio/opus"),
            (Kind::Video, &b"\0\0\0\x14ftypM4V "[..], "video/x-m4v"),
            (Kind::Video, &b"\0\0\0\x08wide\0\0\0\x10mdat"[..], "video/quicktime"),
        ] {
            assert_eq!(media_mime(kind, header, None).unwrap(), expected);
        }
        assert!(media_mime(Kind::Video, b"abcdwide", Some("video/quicktime")).is_err());
    }

    #[tokio::test]
    async fn sealed_bytes_drive_hash_length_and_repeated_file_parts() {
        let mut file = Snapshot::new(&Source { kind: Kind::Image, path: None, remote_url: None, mime_type: None }).unwrap();
        file.append(b"GIF89a").await.unwrap();
        file.append(b"test").await.unwrap();
        file.file.rewind().await.unwrap();
        let info = file.info().unwrap();
        assert_eq!(info.sha256, format!("{:x}", Sha256::digest(b"GIF89atest")));
        assert_eq!(info.mime_type, "image/gif");
        let picture = || Part::File { name: "images".into(), file_index: 0, filename: "one.gif".into() };
        let form = Multipart::build(vec![Part::Text { name: "prompt".into(), value: "test".into() },
            picture(), picture()], &[info], "fixture", false).unwrap();
        let mut wire = UploadBody { segments: form.segments, files: vec![file] };
        let mut received = Vec::new();
        while let Some(bytes) = wire.next().await.unwrap() { received.extend(bytes); }
        assert_eq!(received.len() as u64, form.length);
        let text = String::from_utf8(received).unwrap();
        assert_eq!(text.matches("GIF89atest").count(), 2);
        assert!(text.starts_with("--fixture\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\ntest\r\n"));
        assert!(text.ends_with("--fixture--\r\n"));
    }

    #[test]
    fn file_parts_bind_to_media_kinds_and_fit_beyond_old_proxy_budget() {
        let info = FileInfo { mime_type: "video/mp4".into(), bytes: 5_000_000_000, sha256: "a".repeat(64) };
        let part = |name: &str, filename: &str| Part::File { name: name.into(), file_index: 0, filename: filename.into() };
        assert!(Multipart::build(vec![part("video", "ref.mp4")], std::slice::from_ref(&info), "fixture", false).unwrap().length > info.bytes);
        assert!(Multipart::build(vec![part("audio", "wrong.mp4")], std::slice::from_ref(&info), "fixture", false).is_err());
        assert!(Multipart::build(vec![part("video", "bad\r\nx.mp4")], &[info], "fixture", false).is_err());
        assert!(media_mime(Kind::Image, b"arbitrary contents", Some("image/png")).is_err());
    }
}
