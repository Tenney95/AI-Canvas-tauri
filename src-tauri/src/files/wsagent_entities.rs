//! 主窗口通过既有作品配对同步角色、场景和道具的公共字段。
use super::{main_storage, WsagentSharedState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntityKind {
    Character,
    Scene,
    Prop,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum EntityImageChange {
    Shared { id: String },
    Clear,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityUpdate {
    id: String,
    kind: EntityKind,
    name: String,
    description: String,
    expected_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<EntityImageChange>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entity {
    id: String,
    kind: EntityKind,
    name: String,
    description: String,
    revision: String,
    #[serde(deserialize_with = "nullable_string")]
    image_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_digest: Option<String>,
}

fn nullable_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EntityList {
    entities: Vec<Entity>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EntityReceipt {
    entity: Entity,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum EntityErrorCode {
    #[cfg(target_os = "macos")]
    Conflict,
    #[cfg(target_os = "macos")]
    Unavailable,
    Pairing,
    #[cfg(target_os = "macos")]
    Invalid,
    Unsupported,
}

#[derive(Serialize)]
pub struct EntitySyncError {
    code: EntityErrorCode,
    message: &'static str,
}

impl EntitySyncError {
    fn new(code: EntityErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    #[cfg(target_os = "macos")]
    fn invalid() -> Self {
        Self::new(
            EntityErrorCode::Invalid,
            "WSAGENT 资产同步数据无效或超过大小限制",
        )
    }

    fn pairing() -> Self {
        Self::new(
            EntityErrorCode::Pairing,
            "当前作品的 WSAGENT 配对已变化，请重新连接",
        )
    }

    fn unsupported() -> Self {
        Self::new(
            EntityErrorCode::Unsupported,
            "当前 WSAGENT 作品无法同步资产，请核对项目和桌面版本",
        )
    }
}

#[tauri::command]
pub async fn wsagent_shared_entities_list(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
) -> Result<EntityList, EntitySyncError> {
    let storage =
        main_storage(&webview, &app, &state, &owner_id).map_err(|_| EntitySyncError::pairing())?;
    #[cfg(target_os = "macos")]
    return native::list(app, storage, owner_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = storage;
        Err(EntitySyncError::unsupported())
    }
}

#[tauri::command]
pub async fn wsagent_shared_entities_apply(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    entity: EntityUpdate,
) -> Result<EntityReceipt, EntitySyncError> {
    let storage =
        main_storage(&webview, &app, &state, &owner_id).map_err(|_| EntitySyncError::pairing())?;
    #[cfg(target_os = "macos")]
    return native::apply(app, storage, owner_id, entity).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, entity);
        Err(EntitySyncError::unsupported())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{
        Entity, EntityErrorCode, EntityImageChange, EntityList, EntityReceipt, EntitySyncError,
        EntityUpdate,
    };
    use crate::wsagent_shared::{
        is_digest,
        peer::{exchange_json, JsonPeerError},
        SharedStorage,
    };
    use reqwest::StatusCode;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};
    use std::{collections::HashSet, sync::Arc};
    use tauri::AppHandle;
    use tokio::sync::Semaphore;

    const MAX_REPLY_BYTES: u64 = 2 * 1024 * 1024;
    const MAX_RECEIPT_BYTES: u64 = 32 * 1024;
    const MAX_ENTITY_COUNT: usize = 512;
    const MAX_ID_BYTES: usize = 180;
    const MAX_NAME_CHARS: usize = 120;
    const MAX_DESCRIPTION_BYTES: usize = 12_000;
    static REQUESTS: Semaphore = Semaphore::const_new(2);

    #[derive(Clone, Copy)]
    enum Operation {
        List,
        Apply,
    }

    impl Operation {
        fn endpoint(self) -> &'static str {
            match self {
                Self::List => "/v1/entities/list",
                Self::Apply => "/v1/entities/apply",
            }
        }

        fn max_reply_bytes(self) -> u64 {
            match self {
                Self::List => MAX_REPLY_BYTES,
                Self::Apply => MAX_RECEIPT_BYTES,
            }
        }

        fn invalid_status(self, status: StatusCode) -> EntitySyncError {
            match status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => EntitySyncError::pairing(),
                StatusCode::CONFLICT if matches!(self, Self::Apply) => EntitySyncError::new(
                    EntityErrorCode::Conflict,
                    "WSAGENT 资产已修改，请重新同步",
                ),
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => {
                    EntitySyncError::unsupported()
                }
                StatusCode::BAD_REQUEST
                | StatusCode::PAYLOAD_TOO_LARGE
                | StatusCode::UNPROCESSABLE_ENTITY => EntitySyncError::invalid(),
                _ => unavailable(),
            }
        }
    }

    fn unavailable() -> EntitySyncError {
        EntitySyncError::new(
            EntityErrorCode::Unavailable,
            "暂时无法同步 WSAGENT 项目资产，请确认两端已打开",
        )
    }

    fn valid_id(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= MAX_ID_BYTES
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    }

    fn valid_section_id(value: &str) -> bool {
        value.starts_with("section_") && value.len() > "section_".len() && valid_id(value)
    }

    fn valid_text(name: &str, description: &str) -> bool {
        !name.trim().is_empty()
            && name.len() <= MAX_NAME_CHARS * 4
            && name.chars().count() <= MAX_NAME_CHARS
            && !name.chars().any(char::is_control)
            && description.len() <= MAX_DESCRIPTION_BYTES
            && !description
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }

    fn valid_entity(entity: &Entity) -> bool {
        valid_section_id(&entity.id)
            && valid_text(&entity.name, &entity.description)
            && is_digest(&entity.revision)
            && entity.image_id.as_deref().is_none_or(valid_id)
            && entity
                .image_digest
                .as_deref()
                .is_none_or(|digest| entity.image_id.is_some() && is_digest(digest))
    }

    async fn exchange<T: DeserializeOwned + Send + 'static>(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        operation: Operation,
        payload: Value,
    ) -> Result<T, EntitySyncError> {
        exchange_json(
            app,
            storage,
            owner_id,
            operation.endpoint(),
            payload,
            operation.max_reply_bytes(),
            &REQUESTS,
        )
        .await
        .map_err(|error| match error {
            JsonPeerError::Pairing => EntitySyncError::pairing(),
            JsonPeerError::Unavailable => unavailable(),
            JsonPeerError::Invalid => EntitySyncError::invalid(),
            JsonPeerError::Status(status) => operation.invalid_status(status),
        })
    }

    pub(super) async fn list(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
    ) -> Result<EntityList, EntitySyncError> {
        let reply: EntityList =
            exchange(app, storage, owner_id, Operation::List, json!({})).await?;
        let mut ids = HashSet::with_capacity(reply.entities.len().min(MAX_ENTITY_COUNT));
        if reply.entities.len() > MAX_ENTITY_COUNT
            || reply
                .entities
                .iter()
                .any(|entity| !valid_entity(entity) || !ids.insert(&entity.id))
        {
            return Err(EntitySyncError::invalid());
        }
        Ok(reply)
    }

    pub(super) async fn apply(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        entity: EntityUpdate,
    ) -> Result<EntityReceipt, EntitySyncError> {
        let valid_revision = match entity.expected_revision.as_deref() {
            Some(revision) => is_digest(revision),
            None => entity
                .id
                .strip_prefix("section_canvas_")
                .is_some_and(is_digest),
        };
        if !valid_section_id(&entity.id)
            || !valid_text(&entity.name, &entity.description)
            || !valid_revision
            || matches!(&entity.image, Some(EntityImageChange::Shared { id }) if !is_digest(id))
        {
            return Err(EntitySyncError::invalid());
        }
        let reply: EntityReceipt = exchange(
            app,
            storage,
            owner_id,
            Operation::Apply,
            json!({ "entity": &entity }),
        )
        .await?;
        if !valid_entity(&reply.entity)
            || reply.entity.id != entity.id
            || reply.entity.kind != entity.kind
        {
            return Err(EntitySyncError::invalid());
        }
        Ok(reply)
    }
}
