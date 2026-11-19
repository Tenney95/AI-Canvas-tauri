//! 同机项目互联。配对凭据只授权固定的项目素材操作。
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State as HttpState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder},
    io::{self, Cursor},
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, Webview};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinHandle};

#[path = "wsagent_media.rs"]
pub(crate) mod media;
#[cfg(target_os = "macos")]
#[path = "wsagent_peer.rs"]
mod peer;
#[path = "wsagent_entities.rs"]
pub(crate) mod entities;
#[path = "wsagent_scripts.rs"]
pub(crate) mod scripts;

const PORT: u16 = 49381;
const DIRECTORY: &str = "wsagent-shared";
pub(crate) const RENDEZVOUS_DIRECTORY: &str = "AI Canvas WSAGENT";
const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_BASE64: usize = MAX_BYTES.div_ceil(3) * 4;
const MAX_REQUEST: usize = MAX_BASE64 + 4096;
const MAX_PROJECT_BYTES: i64 = 4 * 1024 * 1024 * 1024;
const MAX_PROJECT_ASSETS: i64 = 8192;
const MAX_PREVIEW_CHARS: usize = 240_000;
const PAGE_SIZE: u32 = 80;
const BODY_TIMEOUT: Duration = Duration::from_secs(30);

type SharedResult<T> = Result<T, SharedError>;

#[derive(Debug)]
struct SharedError(StatusCode, &'static str);

impl SharedError {
    fn invalid() -> Self {
        Self(StatusCode::BAD_REQUEST, "项目互联请求无效")
    }

    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "配对令牌无效或已撤销")
    }

    fn storage() -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, "项目互联存储不可用")
    }

    fn busy() -> Self {
        Self(
            StatusCode::TOO_MANY_REQUESTS,
            "项目互联请求过多，请稍后重试",
        )
    }
}

impl From<rusqlite::Error> for SharedError {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}

impl From<io::Error> for SharedError {
    fn from(_: io::Error) -> Self {
        Self::storage()
    }
}

impl IntoResponse for SharedError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

#[derive(Default)]
pub struct WsagentSharedState {
    storage: Mutex<Option<Arc<SharedStorage>>>,
    listener: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    pairing: tokio::sync::Mutex<()>,
}

pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
        let state = window.app_handle().state::<WsagentSharedState>();
        if let Ok(storage) = state.storage.lock() {
            if let Some(storage) = storage.as_ref() {
                let _ = storage.activate(None);
            }
        };
    }
}

impl WsagentSharedState {
    fn storage(&self, app: &AppHandle) -> SharedResult<Arc<SharedStorage>> {
        let mut storage = self.storage.lock().map_err(|_| SharedError::storage())?;
        if let Some(storage) = storage.as_ref() {
            return Ok(storage.clone());
        }
        let root = crate::agent_package::agent_private_dir(app)
            .map_err(|_| SharedError::storage())?
            .join(DIRECTORY);
        let initialized = Arc::new(SharedStorage::new(root));
        *storage = Some(initialized.clone());
        Ok(initialized)
    }

    async fn ensure_listener(&self, storage: Arc<SharedStorage>) -> SharedResult<()> {
        let mut listener = self.listener.lock().await;
        if listener.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PORT);
        let server = TcpListener::bind(address)
            .await
            .map_err(|_| SharedError(StatusCode::SERVICE_UNAVAILABLE, "项目互联本机端口不可用"))?;
        *listener = Some(tokio::spawn(async move {
            let _ = axum::serve(server, router(storage, PORT)).await;
        }));
        Ok(())
    }
}

struct SharedStorage {
    root: PathBuf,
    active_owner: Mutex<ActiveOwner>,
    pending_pairing: Mutex<Option<PendingPairing>>,
    operations: Arc<Semaphore>,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct ActiveOwner {
    id: Option<String>,
    epoch: u64,
}

impl ActiveOwner {
    fn require(&self, owner_id: &str) -> SharedResult<()> {
        if self.id.as_deref() == Some(owner_id) {
            Ok(())
        } else {
            Err(SharedError(
                StatusCode::CONFLICT,
                "请在 AI Canvas 打开已配对的项目",
            ))
        }
    }
}

struct PendingPairing {
    scope: ActiveOwner,
    token_digest: String,
    expected_peer: Option<String>,
    observed_peer: Option<String>,
}

/// Staging only lasts for this command, including cancellation before the peer responds.
#[cfg(target_os = "macos")]
struct PendingPairingLease {
    storage: Arc<SharedStorage>,
    token_digest: String,
}

#[cfg(target_os = "macos")]
impl Drop for PendingPairingLease {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.storage.pending_pairing.lock() {
            if pending
                .as_ref()
                .is_some_and(|pairing| pairing.token_digest == self.token_digest)
            {
                *pending = None;
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedStatus {
    owner_id: String,
    peer_project_id: Option<String>,
    port: u16,
    enabled: bool,
}

#[cfg(test)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedStart {
    #[serde(flatten)]
    status: SharedStatus,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedPair {
    owner_id: String,
    peer_project_id: String,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutoPairReceipt {
    owner_id: String,
    peer_project_id: String,
    #[serde(default)]
    reused: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    id: String,
    sha256: String,
    name: String,
    mime: String,
    bytes: u64,
    source: String,
    created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedAssets {
    assets: Vec<Asset>,
    next_offset: Option<u32>,
}

#[derive(Serialize)]
pub struct SharedRead {
    asset: Asset,
    base64: String,
}

#[derive(Serialize)]
pub struct SharedPublish {
    asset: Asset,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPreview {
    data_url: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PeerRequest {
    Pair {
        peer_project_id: String,
    },
    List {
        peer_project_id: String,
        #[serde(default)]
        offset: u32,
    },
    Read {
        peer_project_id: String,
        asset_id: String,
    },
    Publish {
        peer_project_id: String,
        name: String,
        mime: String,
        base64: String,
    },
}

impl PeerRequest {
    fn project(&self) -> &str {
        match self {
            Self::Pair { peer_project_id }
            | Self::List {
                peer_project_id, ..
            }
            | Self::Read {
                peer_project_id, ..
            }
            | Self::Publish {
                peer_project_id, ..
            } => peer_project_id,
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum PeerReply {
    Pair(SharedPair),
    List(SharedAssets),
    Read(SharedRead),
    Publish(SharedPublish),
}

fn plain_directory(path: &Path) -> SharedResult<()> {
    let builder = DirBuilder::new();
    #[cfg(unix)]
    let mut builder = builder;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::symlink_metadata(path)?.is_dir() {
                Ok(())
            } else {
                Err(SharedError::storage())
            }
        }
        Err(error) => Err(error.into()),
    }
}

impl SharedStorage {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            active_owner: Mutex::default(),
            pending_pairing: Mutex::default(),
            operations: Arc::new(Semaphore::new(2)),
        }
    }

    fn activate(&self, id: Option<String>) -> SharedResult<()> {
        let mut active = self
            .active_owner
            .lock()
            .map_err(|_| SharedError::storage())?;
        if active.id != id {
            active.id = id;
            active.epoch = active.epoch.wrapping_add(1);
        }
        Ok(())
    }

    fn peer_scope(&self, token: &str) -> SharedResult<(ActiveOwner, bool)> {
        let pending_scope = self
            .pending_pairing
            .lock()
            .map_err(|_| SharedError::storage())?
            .as_ref()
            .filter(|pending| pending.token_digest == token)
            .map(|pending| pending.scope.clone());
        if let Some(scope) = pending_scope {
            let _active = self.lock_scope(&scope)?;
            return Ok((scope, true));
        }
        let owner_id: String = self
            .db()?
            .query_row(
                "SELECT owner_id FROM project WHERE token_digest = ?1",
                [token],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(SharedError::unauthorized)?;
        Ok((self.active_scope(&owner_id)?, false))
    }

    fn active_scope(&self, owner_id: &str) -> SharedResult<ActiveOwner> {
        let active = self
            .active_owner
            .lock()
            .map_err(|_| SharedError::storage())?;
        active.require(owner_id)?;
        Ok(active.clone())
    }

    fn lock_scope(&self, scope: &ActiveOwner) -> SharedResult<MutexGuard<'_, ActiveOwner>> {
        let active = self
            .active_owner
            .lock()
            .map_err(|_| SharedError::storage())?;
        if *active != *scope {
            return Err(SharedError(
                StatusCode::CONFLICT,
                "AI Canvas 中的项目已切换",
            ));
        }
        Ok(active)
    }

    fn db(&self) -> SharedResult<Connection> {
        let parent = self.root.parent().ok_or_else(SharedError::storage)?;
        fs::create_dir_all(parent.parent().ok_or_else(SharedError::storage)?)?;
        plain_directory(parent)?;
        plain_directory(&self.root)?;
        let connection = Connection::open_with_flags(
            crate::path_policy::canonicalize_simplified(&self.root)?.join("shared-v1.sqlite3"),
            OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS project (
                owner_id TEXT PRIMARY KEY, peer_project_id TEXT, token_digest TEXT UNIQUE
             );
             CREATE TABLE IF NOT EXISTS asset (
                owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, name TEXT NOT NULL,
                mime TEXT NOT NULL, bytes INTEGER NOT NULL, source TEXT NOT NULL,
                created_at INTEGER NOT NULL, content BLOB NOT NULL,
                PRIMARY KEY (owner_id, sha256)
             );
             CREATE INDEX IF NOT EXISTS asset_list ON asset(owner_id, created_at DESC, sha256);",
        )?;
        Ok(connection)
    }

    fn status(&self, owner_id: &str) -> SharedResult<SharedStatus> {
        project_status(&self.db()?, owner_id)
    }

    #[cfg(any(target_os = "macos", test))]
    fn stage_pairing(
        &self,
        scope: &ActiveOwner,
        token_digest: &str,
    ) -> SharedResult<Option<String>> {
        let owner_id = scope.id.as_deref().ok_or_else(SharedError::invalid)?;
        let expected_peer = self.status(owner_id)?.peer_project_id;
        let _active = self.lock_scope(scope)?;
        let mut pending = self
            .pending_pairing
            .lock()
            .map_err(|_| SharedError::storage())?;
        if pending.is_some() {
            return Err(SharedError::busy());
        }
        *pending = Some(PendingPairing {
            scope: scope.clone(),
            token_digest: token_digest.to_owned(),
            expected_peer: expected_peer.clone(),
            observed_peer: None,
        });
        Ok(expected_peer)
    }

    fn staged_peer_request(
        &self,
        token: &str,
        scope: &ActiveOwner,
        request: &PeerRequest,
        peer_project_id: &str,
    ) -> SharedResult<Option<PeerReply>> {
        let _active = self.lock_scope(scope)?;
        let mut pending = self
            .pending_pairing
            .lock()
            .map_err(|_| SharedError::storage())?;
        let Some(pending) = pending
            .as_mut()
            .filter(|pending| pending.token_digest == token)
        else {
            return Ok(None);
        };
        let owner_id = scope.id.as_ref().ok_or_else(SharedError::unauthorized)?;
        if pending.scope != *scope || !matches!(request, PeerRequest::Pair { .. }) {
            return Err(SharedError::unauthorized());
        }
        if pending
            .expected_peer
            .as_deref()
            .is_some_and(|expected| expected != peer_project_id)
            || pending
                .observed_peer
                .as_deref()
                .is_some_and(|observed| observed != peer_project_id)
        {
            return Err(SharedError(
                StatusCode::CONFLICT,
                "配对项目不匹配，请重新连接",
            ));
        }
        pending.observed_peer = Some(peer_project_id.to_owned());
        Ok(Some(PeerReply::Pair(SharedPair {
            owner_id: owner_id.clone(),
            peer_project_id: peer_project_id.to_owned(),
        })))
    }

    #[cfg(any(target_os = "macos", test))]
    fn commit_pairing(
        &self,
        scope: &ActiveOwner,
        token_digest: &str,
        receipt: AutoPairReceipt,
    ) -> SharedResult<SharedStatus> {
        let owner_id = scope.id.as_deref().ok_or_else(SharedError::unauthorized)?;
        let peer_project_id = project_id(&receipt.peer_project_id)?;
        if receipt.owner_id != owner_id {
            return Err(SharedError::invalid());
        }

        let mut db = self.db()?;
        let _active = self.lock_scope(scope)?;
        let pending = self
            .pending_pairing
            .lock()
            .map_err(|_| SharedError::storage())?;
        let pending = pending
            .as_ref()
            .filter(|pending| pending.scope == *scope && pending.token_digest == token_digest)
            .ok_or_else(SharedError::unauthorized)?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = project_status(&transaction, owner_id)?;
        if pending.expected_peer != previous.peer_project_id
            || pending
                .expected_peer
                .as_deref()
                .is_some_and(|expected| expected != peer_project_id)
        {
            return Err(SharedError(
                StatusCode::CONFLICT,
                "配对项目不匹配，请重新连接",
            ));
        }
        if receipt.reused {
            return if previous.enabled
                && previous.peer_project_id.as_deref() == Some(peer_project_id)
            {
                Ok(previous)
            } else {
                Err(SharedError::unauthorized())
            };
        }
        if pending.observed_peer.as_deref() != Some(peer_project_id) {
            return Err(SharedError::unauthorized());
        }
        let taken: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM project WHERE peer_project_id = ?1 AND owner_id != ?2 AND token_digest IS NOT NULL)",
            params![peer_project_id, owner_id],
            |row| row.get(0),
        )?;
        if taken {
            return Err(SharedError(
                StatusCode::CONFLICT,
                "该 WSAGENT 项目已连接其他作品",
            ));
        }
        transaction.execute(
            "INSERT INTO project (owner_id, peer_project_id, token_digest) VALUES (?1, ?2, ?3)
             ON CONFLICT(owner_id) DO UPDATE SET peer_project_id = excluded.peer_project_id, token_digest = excluded.token_digest",
            params![owner_id, peer_project_id, token_digest],
        )?;
        let status = project_status(&transaction, owner_id)?;
        transaction.commit()?;
        Ok(status)
    }

    #[cfg(test)]
    fn authorize(&self, owner_id: &str) -> SharedResult<SharedStart> {
        let mut db = self.db()?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let random: [u8; 32] =
            crate::secure_random::random_bytes().map_err(|_| SharedError::storage())?;
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        transaction.execute(
            "INSERT INTO project (owner_id, token_digest) VALUES (?1, ?2)
             ON CONFLICT(owner_id) DO UPDATE SET token_digest = excluded.token_digest",
            params![owner_id, digest(token.as_bytes())],
        )?;
        let status = project_status(&transaction, owner_id)?;
        transaction.commit()?;
        Ok(SharedStart { status, token })
    }

    fn revoke(&self, owner_id: &str) -> SharedResult<SharedStatus> {
        let mut db = self.db()?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE project SET token_digest = NULL, peer_project_id = NULL WHERE owner_id = ?1",
            [owner_id],
        )?;
        let status = project_status(&transaction, owner_id)?;
        transaction.commit()?;
        Ok(status)
    }

    fn peer_request(
        &self,
        token: &str,
        scope: ActiveOwner,
        request: PeerRequest,
    ) -> SharedResult<PeerReply> {
        let peer_project_id = project_id(request.project())?.to_owned();
        if let Some(reply) = self.staged_peer_request(token, &scope, &request, &peer_project_id)? {
            return Ok(reply);
        }
        let mut db = self.db()?;
        // Decode before taking the SQLite write lock, then recheck the token and binding at commit.
        let validated = if let PeerRequest::Publish {
            name, mime, base64, ..
        } = &request
        {
            bound_owner(&db, token, &peer_project_id, false)?;
            Some(Upload::new(name, mime, base64)?)
        } else {
            None
        };
        let mode = if matches!(
            &request,
            PeerRequest::Pair { .. } | PeerRequest::Publish { .. }
        ) {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        };
        let active = self.lock_scope(&scope)?;
        let transaction = db.transaction_with_behavior(mode)?;
        let pairing = matches!(&request, PeerRequest::Pair { .. });
        let owner_id = bound_owner(&transaction, token, &peer_project_id, pairing)?;
        active.require(&owner_id)?;
        let result = match request {
            PeerRequest::Pair { .. } => {
                transaction.execute(
                    "UPDATE project SET peer_project_id = ?2 WHERE owner_id = ?1 AND peer_project_id IS NULL",
                    params![owner_id, peer_project_id],
                )?;
                PeerReply::Pair(SharedPair {
                    owner_id,
                    peer_project_id,
                })
            }
            PeerRequest::List { offset, .. } => {
                PeerReply::List(list(&transaction, &owner_id, offset)?)
            }
            PeerRequest::Read { asset_id, .. } => {
                PeerReply::Read(read(&transaction, &owner_id, &asset_id)?)
            }
            PeerRequest::Publish { .. } => PeerReply::Publish(publish(
                &transaction,
                &owner_id,
                validated.ok_or_else(SharedError::invalid)?,
                "wsagent",
            )?),
        };
        transaction.commit()?;
        Ok(result)
    }
}

fn project_id(value: &str) -> SharedResult<&str> {
    if !value.is_empty()
        && value.len() <= 180
        && value.trim() == value
        && !value.chars().any(char::is_control)
    {
        Ok(value)
    } else {
        Err(SharedError::invalid())
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn project_status(db: &Connection, owner_id: &str) -> SharedResult<SharedStatus> {
    let (peer_project_id, enabled) = db
        .query_row(
            "SELECT peer_project_id, token_digest IS NOT NULL FROM project WHERE owner_id = ?1",
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_default();
    Ok(SharedStatus {
        owner_id: owner_id.to_owned(),
        peer_project_id,
        port: PORT,
        enabled,
    })
}

fn bound_owner(
    db: &Connection,
    token: &str,
    peer_project_id: &str,
    pairing: bool,
) -> SharedResult<String> {
    let (owner_id, bound): (String, Option<String>) = db
        .query_row(
            "SELECT owner_id, peer_project_id FROM project WHERE token_digest = ?1",
            [token],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(SharedError::unauthorized)?;
    match bound {
        Some(bound) if bound == peer_project_id => Ok(owner_id),
        None if pairing => Ok(owner_id),
        _ => Err(SharedError(
            StatusCode::CONFLICT,
            "配对项目不匹配，请重新确认项目连接",
        )),
    }
}

fn row_asset(row: &Row<'_>) -> rusqlite::Result<Asset> {
    let sha256: String = row.get(0)?;
    Ok(Asset {
        id: sha256.clone(),
        sha256,
        name: row.get(1)?,
        mime: row.get(2)?,
        bytes: row.get(3)?,
        source: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn list(db: &Connection, owner_id: &str, offset: u32) -> SharedResult<SharedAssets> {
    let mut query = db.prepare(
        "SELECT sha256, name, mime, bytes, source, created_at FROM asset
         WHERE owner_id = ?1 ORDER BY created_at DESC, sha256 LIMIT ?2 OFFSET ?3",
    )?;
    let mut assets = query
        .query_map(params![owner_id, PAGE_SIZE + 1, offset], row_asset)?
        .collect::<Result<Vec<_>, _>>()?;
    let next_offset = if assets.len() > PAGE_SIZE as usize {
        assets.pop();
        offset.checked_add(PAGE_SIZE)
    } else {
        None
    };
    Ok(SharedAssets {
        assets,
        next_offset,
    })
}

fn read_bytes(db: &Connection, owner_id: &str, asset_id: &str) -> SharedResult<(Asset, Vec<u8>)> {
    if !is_digest(asset_id) {
        return Err(SharedError::invalid());
    }
    let (asset, bytes): (Asset, Vec<u8>) = db
        .query_row(
            "SELECT sha256, name, mime, bytes, source, created_at, content FROM asset
         WHERE owner_id = ?1 AND sha256 = ?2 AND length(content) BETWEEN 1 AND ?3",
            params![owner_id, asset_id, MAX_BYTES as u64],
            |row| Ok((row_asset(row)?, row.get(6)?)),
        )
        .optional()?
        .ok_or(SharedError(StatusCode::NOT_FOUND, "未找到该项目素材"))?;
    if asset.bytes != bytes.len() as u64 || digest(&bytes) != asset.sha256 {
        return Err(SharedError::storage());
    }
    Ok((asset, bytes))
}

fn read(db: &Connection, owner_id: &str, asset_id: &str) -> SharedResult<SharedRead> {
    let (asset, bytes) = read_bytes(db, owner_id, asset_id)?;
    Ok(SharedRead {
        asset,
        base64: STANDARD.encode(bytes),
    })
}

fn normalize_name(name: &str) -> String {
    let safe = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let normalized = safe.split_whitespace().collect::<Vec<_>>().join(" ");
    let shortened = normalized.chars().take(120).collect::<String>();
    let cleaned = shortened.trim_matches(|char: char| char.is_whitespace() || char == '.');
    if cleaned.is_empty() {
        "共享图片".into()
    } else {
        cleaned.into()
    }
}

fn decode(mime: &str, content: &[u8]) -> SharedResult<DynamicImage> {
    let invalid = || {
        SharedError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "图片编码、尺寸或格式不受支持",
        )
    };
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(invalid()),
    };
    if image::guess_format(content).ok() != Some(format) {
        return Err(invalid());
    }
    let mut reader = ImageReader::with_format(Cursor::new(content), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(|_| invalid())?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 24 * 1024 * 1024 {
        return Err(invalid());
    }
    DynamicImage::from_decoder(decoder).map_err(|_| invalid())
}

struct Upload {
    name: String,
    mime: String,
    bytes: Vec<u8>,
}

impl Upload {
    fn new(name: &str, mime: &str, base64: &str) -> SharedResult<Self> {
        if name.len() > 4096 || base64.is_empty() || base64.len() > MAX_BASE64 {
            return Err(SharedError::invalid());
        }
        let bytes = STANDARD
            .decode(base64)
            .map_err(|_| SharedError::invalid())?;
        if bytes.len() > MAX_BYTES {
            return Err(SharedError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "共享图片不能超过 20 MiB",
            ));
        }
        decode(mime, &bytes)?;
        Ok(Self {
            name: normalize_name(name),
            mime: mime.into(),
            bytes,
        })
    }
}

// Only called inside an immediate transaction so the quota and dedup checks are atomic.
fn publish(
    db: &Connection,
    owner_id: &str,
    upload: Upload,
    source: &str,
) -> SharedResult<SharedPublish> {
    let sha256 = digest(&upload.bytes);
    let existing = db
        .query_row(
            "SELECT sha256, name, mime, bytes, source, created_at FROM asset
         WHERE owner_id = ?1 AND sha256 = ?2",
            params![owner_id, sha256],
            row_asset,
        )
        .optional()?;
    if let Some(asset) = existing {
        return Ok(SharedPublish { asset });
    }
    let (count, total): (i64, i64) = db.query_row(
        "SELECT count(*), coalesce(sum(bytes), 0) FROM asset WHERE owner_id = ?1",
        [owner_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let bytes = upload.bytes.len() as u64;
    if count >= MAX_PROJECT_ASSETS || total.saturating_add(bytes as i64) > MAX_PROJECT_BYTES {
        return Err(SharedError(
            StatusCode::INSUFFICIENT_STORAGE,
            "该项目的互联素材存储已达上限",
        ));
    }
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SharedError::storage())?
        .as_millis() as u64;
    let asset = Asset {
        id: sha256.clone(),
        sha256,
        name: upload.name,
        mime: upload.mime,
        bytes,
        source: source.into(),
        created_at,
    };
    db.execute(
        "INSERT INTO asset (owner_id, sha256, name, mime, bytes, source, created_at, content)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            owner_id,
            asset.sha256,
            asset.name,
            asset.mime,
            asset.bytes,
            asset.source,
            created_at,
            upload.bytes
        ],
    )?;
    Ok(SharedPublish { asset })
}

fn preview(db: &Connection, owner_id: &str, asset_id: &str) -> SharedResult<SharedPreview> {
    let (asset, bytes) = read_bytes(db, owner_id, asset_id)?;
    let image = decode(&asset.mime, &bytes)?;
    let prefix = "data:image/jpeg;base64,";
    for size in [640, 480, 320, 160] {
        let resized = image.thumbnail(size, size).into_rgb8();
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, 78)
            .encode_image(&resized)
            .map_err(|_| SharedError::storage())?;
        if output.len().div_ceil(3) * 4 + prefix.len() <= MAX_PREVIEW_CHARS {
            return Ok(SharedPreview {
                data_url: format!("{prefix}{}", STANDARD.encode(output)),
            });
        }
    }
    Err(SharedError::storage())
}

#[derive(Clone)]
struct HttpService {
    storage: Arc<SharedStorage>,
    authority: String,
}

fn router(storage: Arc<SharedStorage>, port: u16) -> Router {
    Router::new()
        .route("/v1", post(handle_http).fallback(method_not_allowed))
        .fallback(not_found)
        .with_state(HttpService {
            storage,
            authority: format!("127.0.0.1:{port}"),
        })
}

async fn method_not_allowed() -> SharedError {
    SharedError(StatusCode::METHOD_NOT_ALLOWED, "项目互联仅接受 POST 请求")
}

async fn not_found() -> SharedError {
    SharedError(StatusCode::NOT_FOUND, "项目互联端点不存在")
}

fn peer_token(headers: &HeaderMap, authority: &str) -> SharedResult<String> {
    if headers.contains_key(header::ORIGIN)
        || headers.get_all(header::HOST).iter().count() != 1
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(authority)
    {
        return Err(SharedError(
            StatusCode::FORBIDDEN,
            "项目互联只接受本机原生客户端请求",
        ));
    }
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return Err(SharedError::unauthorized());
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| is_digest(token))
        .ok_or_else(SharedError::unauthorized)?;
    Ok(digest(token.as_bytes()))
}

async fn handle_http(
    HttpState(state): HttpState<HttpService>,
    request: Request,
) -> SharedResult<Response> {
    let token = peer_token(request.headers(), &state.authority)?;
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next());
    if content_type != Some("application/json") || request.uri().query().is_some() {
        return Err(SharedError::invalid());
    }
    let permit = state
        .storage
        .operations
        .clone()
        .try_acquire_owned()
        .map_err(|_| SharedError::busy())?;
    let storage = state.storage;
    // Reject stale credentials before reading a potentially large body. Rechecked in the transaction.
    let (storage, token, permit, scope, staging) = blocking(move || {
        let (scope, staging) = storage.peer_scope(&token)?;
        Ok((storage, token, permit, scope, staging))
    })
    .await?;
    let body = tokio::time::timeout(
        BODY_TIMEOUT,
        to_bytes(
            request.into_body(),
            if staging { 4096 } else { MAX_REQUEST },
        ),
    )
    .await
    .map_err(|_| SharedError(StatusCode::REQUEST_TIMEOUT, "读取项目互联请求超时"))?
    .map_err(|_| SharedError(StatusCode::PAYLOAD_TOO_LARGE, "项目互联请求过大或读取中断"))?;
    let (bytes, permit) = blocking(move || {
        let request = serde_json::from_slice(&body).map_err(|_| SharedError::invalid())?;
        let reply = storage.peer_request(&token, scope, request)?;
        let encoded = serde_json::to_vec(&reply).map_err(|_| SharedError::storage())?;
        Ok((Bytes::from(encoded), permit))
    })
    .await?;
    // Keep the transfer slot until the body has been sent or dropped.
    let length = bytes.len();
    let stream = futures_util::stream::unfold((bytes, permit), |(mut bytes, permit)| async move {
        if bytes.is_empty() {
            return None;
        }
        let chunk = bytes.split_to(bytes.len().min(64 * 1024));
        Some((Ok::<_, std::convert::Infallible>(chunk), (bytes, permit)))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(|_| SharedError::storage())
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> SharedResult<T> + Send + 'static,
) -> SharedResult<T> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| SharedError::storage())?
}

fn main_storage(
    webview: &Webview,
    app: &AppHandle,
    state: &WsagentSharedState,
    owner_id: &str,
) -> Result<Arc<SharedStorage>, String> {
    if webview.label() != "main" {
        return Err("项目互联只允许主窗口调用".into());
    }
    crate::path_policy::ensure_local_frontend_caller(webview)?;
    ipc(project_id(owner_id))?;
    ipc(state.storage(app))
}

fn ipc<T>(result: SharedResult<T>) -> Result<T, String> {
    result.map_err(|error| error.1.into())
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairingDiscovery {
    version: u8,
    port: u16,
    token: String,
}

#[cfg(target_os = "macos")]
fn read_pairing_discovery(base: &Path) -> SharedResult<PairingDiscovery> {
    use std::{
        ffi::CString,
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            raw::{c_char, c_int},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };

    // Darwin fcntl.h, same leases as native_project_media's Unix file boundary.
    const NOFOLLOW: c_int = 0x100;
    const DIRECTORY: c_int = 0x100000;
    const CLOEXEC: c_int = 0x1000000;
    const NONBLOCK: c_int = 0x4;
    const LIMIT: u64 = 4096;
    extern "C" {
        fn openat(directory: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        fn geteuid() -> u32;
    }
    let unavailable = || {
        SharedError(
            StatusCode::SERVICE_UNAVAILABLE,
            "请先打开支持自动连接的 WSAGENT 桌面版",
        )
    };
    let unsafe_discovery = || {
        SharedError(
            StatusCode::FORBIDDEN,
            "WSAGENT 本机连接凭据无效，请重新打开 WSAGENT",
        )
    };
    let open = |dir: &fs::File, name: &str, extra| -> SharedResult<fs::File> {
        let component = CString::new(name).map_err(|_| unsafe_discovery())?;
        // Both names are fixed path components; openat pins the already-open parent.
        let descriptor = unsafe {
            openat(
                dir.as_raw_fd(),
                component.as_ptr(),
                NOFOLLOW | CLOEXEC | NONBLOCK | extra,
            )
        };
        if descriptor < 0 {
            return Err(
                if io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
                    unavailable()
                } else {
                    unsafe_discovery()
                },
            );
        }
        // The successful descriptor is transferred to a single owning File.
        Ok(unsafe { fs::File::from_raw_fd(descriptor) })
    };

    let uid = unsafe { geteuid() };
    let base = fs::OpenOptions::new()
        .read(true)
        .custom_flags(NOFOLLOW | CLOEXEC | DIRECTORY)
        .open(base)
        .map_err(|_| unavailable())?;
    let base_metadata = base.metadata().map_err(|_| unsafe_discovery())?;
    if !base_metadata.is_dir() || base_metadata.uid() != uid || base_metadata.mode() & 0o022 != 0 {
        return Err(unsafe_discovery());
    }
    let directory = open(&base, RENDEZVOUS_DIRECTORY, DIRECTORY)?;
    let metadata = directory.metadata().map_err(|_| unsafe_discovery())?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o777 != 0o700 {
        return Err(unsafe_discovery());
    }
    let descriptor = open(&directory, "wsagent-v1.json", 0)?;
    let metadata = descriptor.metadata().map_err(|_| unsafe_discovery())?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o777 != 0o600
        || !(1..=LIMIT).contains(&metadata.len())
    {
        return Err(unsafe_discovery());
    }
    let mut bytes = Vec::new();
    descriptor
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unsafe_discovery())?;
    if bytes.len() as u64 != metadata.len() {
        return Err(unsafe_discovery());
    }
    let value: PairingDiscovery = serde_json::from_slice(&bytes).map_err(|_| unsafe_discovery())?;
    if value.version != 1 || value.port == 0 || value.port == PORT || !is_digest(&value.token) {
        return Err(unsafe_discovery());
    }
    Ok(value)
}

#[cfg(target_os = "macos")]
async fn request_auto_pairing(
    discovery: PairingDiscovery,
    owner_id: &str,
    name: &str,
    peer_project_id: Option<&str>,
    token: &str,
) -> SharedResult<AutoPairReceipt> {
    let unavailable = || {
        SharedError(
            StatusCode::SERVICE_UNAVAILABLE,
            "未能连接 WSAGENT，请确认应用已打开后重试",
        )
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|_| unavailable())?;
    let body = serde_json::json!({
        "ownerId": owner_id, "name": name, "peerProjectId": peer_project_id, "token": token,
    });
    let mut response = client
        .post(format!("http://127.0.0.1:{}/v1/connect", discovery.port))
        .bearer_auth(discovery.token)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            409 => SharedError(StatusCode::CONFLICT, "WSAGENT 项目绑定冲突或不可用"),
            429 => SharedError::busy(),
            _ => unavailable(),
        });
    }
    const LIMIT: usize = 4096;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if chunk.len() > LIMIT - bytes.len() {
            return Err(SharedError::invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| SharedError::invalid())
}

#[tauri::command]
pub async fn wsagent_shared_activate(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: Option<String>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("项目互联只允许主窗口调用".into());
    }
    crate::path_policy::ensure_local_frontend_caller(&webview)?;
    if let Some(owner_id) = &owner_id {
        ipc(project_id(owner_id))?;
    }
    let storage = ipc(state.storage(&app))?;
    ipc(storage.activate(owner_id.clone()))?;
    if let Some(owner_id) = owner_id {
        let reader = storage.clone();
        let status = ipc(blocking(move || reader.status(&owner_id)).await)?;
        if status.enabled {
            ipc(state.ensure_listener(storage).await)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn wsagent_shared_status(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
) -> Result<SharedStatus, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    ipc(blocking(move || storage.status(&owner_id)).await)
}

#[tauri::command]
pub async fn wsagent_shared_connect(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    name: String,
) -> Result<SharedStatus, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    #[cfg(target_os = "macos")]
    {
        if !owner_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || name.len() > 4096
            || name.trim().is_empty()
        {
            return Err(SharedError::invalid().1.into());
        }
        let title: String = name
            .trim()
            .chars()
            .filter(|character| !character.is_control())
            .take(120)
            .collect();
        if title.trim().is_empty() {
            return Err(SharedError::invalid().1.into());
        }
        let _pairing = state
            .pairing
            .try_lock()
            .map_err(|_| SharedError::busy().1.to_string())?;
        let scope = ipc(storage.active_scope(&owner_id))?;
        let base = app
            .path()
            .data_dir()
            .map_err(|_| SharedError::storage().1.to_string())?;
        let discovery = ipc(blocking(move || read_pairing_discovery(&base)).await)?;
        ipc(state.ensure_listener(storage.clone()).await)?;
        let token = crate::secure_random::random_bytes::<32>()
            .map_err(|_| SharedError::storage().1.to_string())?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let token_digest = digest(token.as_bytes());
        let stage = storage.clone();
        let staged_scope = scope.clone();
        let staged_digest = token_digest.clone();
        let (previous, lease) = ipc(blocking(move || {
            let previous = stage.stage_pairing(&staged_scope, &staged_digest)?;
            Ok((
                previous,
                PendingPairingLease {
                    storage: stage,
                    token_digest: staged_digest,
                },
            ))
        })
        .await)?;
        let receipt =
            ipc(
                request_auto_pairing(discovery, &owner_id, &title, previous.as_deref(), &token)
                    .await,
            )?;
        let status =
            ipc(blocking(move || storage.commit_pairing(&scope, &token_digest, receipt)).await);
        drop(lease);
        status
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, name);
        Err("WSAGENT 自动连接目前仅支持 macOS".into())
    }
}

#[tauri::command]
pub async fn wsagent_shared_revoke(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
) -> Result<SharedStatus, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    let _pairing = state
        .pairing
        .try_lock()
        .map_err(|_| SharedError::busy().1.to_string())?;
    let scope = ipc(storage.active_scope(&owner_id))?;
    ipc(blocking(move || {
        let _active = storage.lock_scope(&scope)?;
        storage.revoke(&owner_id)
    })
    .await)
}

#[tauri::command]
pub async fn wsagent_shared_list(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    offset: Option<u32>,
) -> Result<SharedAssets, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    ipc(blocking(move || list(&storage.db()?, &owner_id, offset.unwrap_or(0))).await)
}

#[tauri::command]
pub async fn wsagent_shared_read(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    asset_id: String,
) -> Result<SharedRead, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    ipc(blocking(move || {
        let _permit = storage
            .operations
            .try_acquire()
            .map_err(|_| SharedError::busy())?;
        read(&storage.db()?, &owner_id, &asset_id)
    })
    .await)
}

#[tauri::command]
pub async fn wsagent_shared_preview(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    asset_id: String,
) -> Result<SharedPreview, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    ipc(blocking(move || {
        let _permit = storage
            .operations
            .try_acquire()
            .map_err(|_| SharedError::busy())?;
        preview(&storage.db()?, &owner_id, &asset_id)
    })
    .await)
}

#[tauri::command]
pub async fn wsagent_shared_publish(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    name: String,
    mime: String,
    base64: String,
) -> Result<SharedPublish, String> {
    let storage = main_storage(&webview, &app, &state, &owner_id)?;
    let scope = ipc(storage.active_scope(&owner_id))?;
    ipc(blocking(move || {
        let _permit = storage
            .operations
            .try_acquire()
            .map_err(|_| SharedError::busy())?;
        let upload = Upload::new(&name, &mime, &base64)?;
        let mut db = storage.db()?;
        let _active = storage.lock_scope(&scope)?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = publish(&transaction, &owner_id, upload, "canvas")?;
        transaction.commit()?;
        Ok(result)
    })
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use serde_json::{json, Value};

    struct TestStorage {
        root: PathBuf,
        storage: Arc<SharedStorage>,
    }

    impl TestStorage {
        fn new() -> Self {
            let nonce: [u8; 16] = crate::secure_random::random_bytes().unwrap();
            let root = std::env::temp_dir().join(format!("canvas-wsagent-{}", digest(&nonce)));
            let storage = Arc::new(SharedStorage::new(
                root.join("agent-private").join(DIRECTORY),
            ));
            Self { root, storage }
        }
    }

    impl Drop for TestStorage {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn image_fixture(color: u8, format: ImageFormat) -> String {
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(12, 10, Rgb([color, 44, 99])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        STANDARD.encode(bytes.into_inner())
    }

    async fn send(
        client: &reqwest::Client,
        endpoint: &str,
        token: &str,
        request: Value,
        origin: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = client
            .post(endpoint)
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(request.to_string());
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let body = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        (status, body)
    }

    #[tokio::test]
    async fn http_pair_publish_read_switch_rotate_and_revoke() {
        let test = TestStorage::new();
        let storage = test.storage.clone();
        let first = storage.authorize("canvas-a").unwrap();
        let server = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let router = router(storage.clone(), port);
        let task = tokio::spawn(async move { axum::serve(server, router).await.unwrap() });
        let endpoint = format!("http://127.0.0.1:{port}/v1");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let pair = json!({"action":"pair","peerProjectId":"ws-a"});
        let list = json!({"action":"list","peerProjectId":"ws-a","offset":0});
        assert_eq!(
            send(&client, &endpoint, &first.token, pair.clone(), None)
                .await
                .0,
            StatusCode::CONFLICT
        );
        storage.activate(Some("canvas-a".into())).unwrap();
        assert_eq!(
            send(&client, &endpoint, &"a".repeat(64), pair.clone(), None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(&client, &endpoint, &first.token, pair.clone(), Some("null"))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send(&client, &endpoint, &first.token, list.clone(), None)
                .await
                .0,
            StatusCode::CONFLICT
        );
        let (status, reply) = send(&client, &endpoint, &first.token, pair.clone(), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply, json!({"ownerId":"canvas-a","peerProjectId":"ws-a"}));
        assert_eq!(
            send(
                &client,
                &endpoint,
                &first.token,
                json!({"action":"pair","peerProjectId":"ws-b"}),
                None
            )
            .await
            .0,
            StatusCode::CONFLICT
        );

        let original = image_fixture(42, ImageFormat::Png);
        let malformed = STANDARD.encode(b"\x89PNG\r\n\x1a\nnot-an-image");
        let publish_request = |mime: &str, bytes: &str| json!({"action":"publish","peerProjectId":"ws-a","name":".. 雨夜\n/ 入口", "mime":mime, "base64":bytes });
        for bad in [
            publish_request("image/jpeg", &original),
            publish_request("image/png", &malformed),
        ] {
            assert_eq!(
                send(&client, &endpoint, &first.token, bad, None).await.0,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        let (status, published) = send(
            &client,
            &endpoint,
            &first.token,
            publish_request("image/png", &original),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let asset = &published["asset"];
        let id = asset["id"].as_str().unwrap();
        assert_eq!(id, digest(&STANDARD.decode(&original).unwrap()));
        assert_eq!(asset["name"], "雨夜 入口");
        assert_eq!(asset["source"], "wsagent");
        assert_eq!(asset["id"], asset["sha256"]);
        let read_remote =
            |asset_id: &str| json!({"action":"read","peerProjectId":"ws-a","assetId":asset_id});
        assert_eq!(
            send(&client, &endpoint, &first.token, read_remote(id), None)
                .await
                .1["base64"],
            original
        );
        assert_eq!(
            read(&storage.db().unwrap(), "canvas-a", id).unwrap().base64,
            original
        );
        assert_eq!(
            read(&storage.db().unwrap(), "canvas-b", id)
                .err()
                .unwrap()
                .0,
            StatusCode::NOT_FOUND
        );
        let thumbnail = preview(&storage.db().unwrap(), "canvas-a", id)
            .unwrap()
            .data_url;
        let thumbnail = thumbnail.strip_prefix("data:image/jpeg;base64,").unwrap();
        assert!(thumbnail.len() <= MAX_PREVIEW_CHARS);
        let thumbnail = decode("image/jpeg", &STANDARD.decode(thumbnail).unwrap()).unwrap();
        assert!(thumbnail.width() <= 640 && thumbnail.height() <= 640);

        let mut db = storage.db().unwrap();
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let duplicate = publish(
            &transaction,
            "canvas-a",
            Upload::new("别名", "image/png", &original).unwrap(),
            "canvas",
        )
        .unwrap();
        assert_eq!(duplicate.asset.id, id);
        assert_eq!(duplicate.asset.source, "wsagent");
        let local = image_fixture(89, ImageFormat::Jpeg);
        let local_asset = publish(
            &transaction,
            "canvas-a",
            Upload::new("本地图片", "image/jpeg", &local).unwrap(),
            "canvas",
        )
        .unwrap();
        transaction.commit().unwrap();
        let readback = send(
            &client,
            &endpoint,
            &first.token,
            read_remote(&local_asset.asset.id),
            None,
        )
        .await
        .1;
        assert_eq!(readback["asset"]["source"], "canvas");
        assert_eq!(readback["base64"], local);
        let assets = send(&client, &endpoint, &first.token, list.clone(), None)
            .await
            .1;
        assert_eq!(assets["assets"].as_array().unwrap().len(), 2);
        assert_eq!(assets["nextOffset"], Value::Null);

        let (snapshot, _) = storage.peer_scope(&digest(first.token.as_bytes())).unwrap();
        storage.activate(Some("canvas-b".into())).unwrap();
        assert_eq!(
            send(&client, &endpoint, &first.token, list.clone(), None)
                .await
                .0,
            StatusCode::CONFLICT
        );
        storage.activate(Some("canvas-a".into())).unwrap();
        let stale = storage.peer_request(
            &digest(first.token.as_bytes()),
            snapshot,
            PeerRequest::List {
                peer_project_id: "ws-a".into(),
                offset: 0,
            },
        );
        assert_eq!(stale.err().unwrap().0, StatusCode::CONFLICT);

        let reopened = SharedStorage::new(storage.root.clone());
        let saved = reopened.status("canvas-a").unwrap();
        assert_eq!(saved.peer_project_id.as_deref(), Some("ws-a"));
        assert!(saved.enabled);
        assert_eq!(
            reopened
                .peer_scope(&digest(first.token.as_bytes()))
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        let second = reopened.authorize("canvas-a").unwrap();
        assert_eq!(second.status.peer_project_id.as_deref(), Some("ws-a"));
        assert_ne!(second.token, first.token);
        assert_eq!(
            send(&client, &endpoint, &first.token, list.clone(), None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(&client, &endpoint, &second.token, pair, None).await.0,
            StatusCode::OK
        );
        let revoked = reopened.revoke("canvas-a").unwrap();
        assert!(!revoked.enabled);
        assert_eq!(revoked.peer_project_id, None);
        assert_eq!(
            send(&client, &endpoint, &second.token, list, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            read(&reopened.db().unwrap(), "canvas-a", id)
                .unwrap()
                .base64,
            original
        );
        task.abort();
    }

    #[test]
    fn auto_pair_is_read_only_until_confirmed_and_never_replaces_a_working_link_on_failure() {
        let test = TestStorage::new();
        let storage = &test.storage;
        storage.activate(Some("canvas-a".into())).unwrap();
        let scope = storage.active_scope("canvas-a").unwrap();
        let old_token = digest(storage.authorize("canvas-a").unwrap().token.as_bytes());
        let pair = |peer: &str| PeerRequest::Pair {
            peer_project_id: peer.to_owned(),
        };
        let list = || PeerRequest::List {
            peer_project_id: "ws-a".into(),
            offset: 0,
        };
        let receipt = |peer: &str, reused| AutoPairReceipt {
            owner_id: "canvas-a".into(),
            peer_project_id: peer.to_owned(),
            reused,
        };
        storage
            .peer_request(&old_token, scope.clone(), pair("ws-a"))
            .unwrap();

        let pending_token = digest(b"staged token");
        assert_eq!(
            storage
                .stage_pairing(&scope, &pending_token)
                .unwrap()
                .as_deref(),
            Some("ws-a")
        );
        assert!(storage.peer_scope(&pending_token).unwrap().1);
        assert_eq!(
            storage
                .peer_request(&pending_token, scope.clone(), list())
                .err()
                .unwrap()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            storage
                .peer_request(&pending_token, scope.clone(), pair("ws-b"))
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            storage
                .commit_pairing(&scope, &pending_token, receipt("ws-a", false))
                .err()
                .unwrap()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert!(
            storage
                .commit_pairing(&scope, &pending_token, receipt("ws-a", true))
                .unwrap()
                .enabled
        );
        storage
            .peer_request(&old_token, scope.clone(), list())
            .unwrap();

        storage
            .peer_request(&pending_token, scope.clone(), pair("ws-a"))
            .unwrap();
        storage.activate(Some("other".into())).unwrap();
        storage.activate(Some("canvas-a".into())).unwrap();
        assert_eq!(
            storage
                .commit_pairing(&scope, &pending_token, receipt("ws-a", false))
                .err()
                .unwrap()
                .0,
            StatusCode::CONFLICT
        );
        let latest = storage.active_scope("canvas-a").unwrap();
        storage
            .peer_request(&old_token, latest.clone(), list())
            .unwrap();

        *storage.pending_pairing.lock().unwrap() = None;
        let retry = digest(b"retried token");
        storage.stage_pairing(&latest, &retry).unwrap();
        storage
            .peer_request(&retry, latest.clone(), pair("ws-a"))
            .unwrap();
        assert!(
            storage
                .commit_pairing(&latest, &retry, receipt("ws-a", false))
                .unwrap()
                .enabled
        );
        *storage.pending_pairing.lock().unwrap() = None;
        storage.peer_request(&retry, latest, list()).unwrap();
        assert_eq!(
            storage.peer_scope(&old_token).err().unwrap().0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn auto_pair_discovery_rejects_shared_files_and_symlinks() {
        use std::{
            io::Write,
            os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
        };

        let test = TestStorage::new();
        plain_directory(&test.root).unwrap();
        let private = test.root.join(RENDEZVOUS_DIRECTORY);
        plain_directory(&private).unwrap();
        let descriptor = private.join("wsagent-v1.json");
        let token = "a".repeat(64);
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&descriptor)
            .unwrap()
            .write_all(
                json!({ "version": 1, "port": 43123, "token": token })
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        assert_eq!(read_pairing_discovery(&test.root).unwrap().port, 43123);
        fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_pairing_discovery(&test.root).is_err());
        fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600)).unwrap();
        let moved = private.join("other.json");
        fs::rename(&descriptor, &moved).unwrap();
        symlink(&moved, &descriptor).unwrap();
        assert!(read_pairing_discovery(&test.root).is_err());
    }

    #[test]
    fn stored_assets_paginate_by_timestamp_and_digest() {
        let test = TestStorage::new();
        let mut db = test.storage.db().unwrap();
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        for n in 0..83u8 {
            let original = image_fixture(n, ImageFormat::Png);
            let upload = Upload::new("图片", "image/png", &original).unwrap();
            publish(&transaction, "canvas-a", upload, "canvas").unwrap();
        }
        transaction.commit().unwrap();
        db.execute("UPDATE asset SET created_at = 1", []).unwrap();
        let first = list(&db, "canvas-a", 0).unwrap();
        assert_eq!(first.assets.len(), 80);
        assert_eq!(first.next_offset, Some(80));
        assert!(first.assets.windows(2).all(|pair| pair[0].id < pair[1].id));
        let final_page = list(&db, "canvas-a", first.next_offset.unwrap()).unwrap();
        assert_eq!(final_page.assets.len(), 3);
        assert_eq!(final_page.next_offset, None);
        assert!(first.assets.last().unwrap().id < final_page.assets[0].id);
    }
}
