//! WSAGENT 原生回环请求共用当前作品与配对租约。
use super::{ipc, read_pairing_discovery, ActiveOwner, SharedStorage};
use reqwest::{
    blocking::{Client, Response},
    header,
    redirect::Policy,
    StatusCode,
};
use rusqlite::OptionalExtension;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{Arc, MutexGuard},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

pub(super) const UNAVAILABLE: &str = "未能连接 WSAGENT，请确认应用已打开后重试";
pub(super) const PAIRING_CHANGED: &str = "WSAGENT 项目连接已变化，请重新连接";

pub(super) struct PairedProject {
    scope: ActiveOwner,
    peer: String,
    binding: String,
}

impl PairedProject {
    pub(super) fn open(storage: &SharedStorage, scope: ActiveOwner) -> Result<Self, String> {
        let _active = ipc(storage.lock_scope(&scope))?;
        let (peer, binding) = Self::binding(storage, &scope)?;
        Ok(Self {
            scope,
            peer,
            binding,
        })
    }

    fn binding(storage: &SharedStorage, scope: &ActiveOwner) -> Result<(String, String), String> {
        ipc(storage.db())?
            .query_row(
                "SELECT peer_project_id, token_digest FROM project WHERE owner_id = ?1 AND peer_project_id IS NOT NULL AND token_digest IS NOT NULL",
                [scope.id.as_deref().ok_or(PAIRING_CHANGED)?],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "未能读取 WSAGENT 项目连接状态")?
            .ok_or_else(|| "请先连接此作品的 WSAGENT 项目".into())
    }

    pub(super) fn current<'a>(
        &self,
        storage: &'a SharedStorage,
    ) -> Result<MutexGuard<'a, ActiveOwner>, String> {
        let lease = ipc(storage.lock_scope(&self.scope))?;
        let (peer, binding) = Self::binding(storage, &self.scope)?;
        if self.peer != peer || self.binding != binding {
            return Err(PAIRING_CHANGED.into());
        }
        Ok(lease)
    }

    pub(super) fn request(
        &self,
        app: &AppHandle,
        endpoint: &'static str,
        mut fields: Value,
    ) -> Result<Response, String> {
        fields["ownerId"] = json!(self.scope.id.as_deref().ok_or(PAIRING_CHANGED)?);
        fields["peerProjectId"] = json!(&self.peer);
        let base = app.path().data_dir().map_err(|_| UNAVAILABLE)?;
        let discovery = ipc(read_pairing_discovery(&base))?;
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| UNAVAILABLE)?;
        client
            .post(format!("http://127.0.0.1:{}{endpoint}", discovery.port))
            .bearer_auth(discovery.token)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT_ENCODING, "identity")
            .body(fields.to_string())
            .send()
            .map_err(|_| UNAVAILABLE.into())
    }
}

pub(super) enum JsonPeerError {
    Pairing,
    Unavailable,
    Invalid,
    Status(StatusCode),
}

/// 用固定路由交换有界 JSON。校验活动作品及原配对后才允许返回数据。
pub(super) async fn exchange_json<T: DeserializeOwned + Send + 'static>(
    app: AppHandle,
    storage: Arc<SharedStorage>,
    owner_id: String,
    endpoint: &'static str,
    fields: Value,
    max_bytes: u64,
    requests: &'static Semaphore,
) -> Result<T, JsonPeerError> {
    let scope = storage
        .active_scope(&owner_id)
        .map_err(|_| JsonPeerError::Pairing)?;
    let permit = requests
        .try_acquire()
        .map_err(|_| JsonPeerError::Unavailable)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let pair = PairedProject::open(&storage, scope).map_err(|_| JsonPeerError::Pairing)?;
        drop(pair.current(&storage).map_err(|_| JsonPeerError::Pairing)?);
        let response = pair
            .request(&app, endpoint, fields)
            .map_err(|_| JsonPeerError::Unavailable)?;
        if response.status() != StatusCode::OK {
            return Err(JsonPeerError::Status(response.status()));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next());
        if content_type != Some("application/json")
            || response
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_some_and(|value| value != "identity")
            || response
                .content_length()
                .is_some_and(|length| length > max_bytes)
        {
            return Err(JsonPeerError::Invalid);
        }
        let mut bytes = Vec::new();
        response
            .take(max_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| JsonPeerError::Unavailable)?;
        if bytes.len() as u64 > max_bytes {
            return Err(JsonPeerError::Invalid);
        }
        let result = serde_json::from_slice(&bytes).map_err(|_| JsonPeerError::Invalid)?;
        let _lease = pair.current(&storage).map_err(|_| JsonPeerError::Pairing)?;
        Ok(result)
    })
    .await
    .map_err(|_| JsonPeerError::Unavailable)?
}
