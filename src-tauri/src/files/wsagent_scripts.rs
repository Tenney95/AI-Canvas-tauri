//! 主窗口通过既有作品配对同步已保存的剧本文稿。
use super::{main_storage, WsagentSharedState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Webview};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    id: String,
    title: String,
    revision: String,
    content_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptUpdate {
    id: String,
    title: String,
    content: String,
    expected_revision: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptList {
    scripts: Vec<Script>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptReply {
    script: Script,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ScriptErrorCode {
    Conflict,
    Unavailable,
    Pairing,
    Invalid,
    Unsupported,
}

#[derive(Serialize)]
pub struct ScriptSyncError {
    code: ScriptErrorCode,
    message: &'static str,
}

impl ScriptSyncError {
    fn new(code: ScriptErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    fn pairing() -> Self {
        Self::new(
            ScriptErrorCode::Pairing,
            "当前作品的 WSAGENT 配对已变化，请重新连接",
        )
    }

    fn unsupported() -> Self {
        Self::new(
            ScriptErrorCode::Unsupported,
            "当前 WSAGENT 作品无法同步剧本，请核对项目和桌面版本",
        )
    }
}

#[tauri::command]
pub async fn wsagent_shared_scripts_list(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
) -> Result<ScriptList, ScriptSyncError> {
    let storage =
        main_storage(&webview, &app, &state, &owner_id).map_err(|_| ScriptSyncError::pairing())?;
    #[cfg(target_os = "macos")]
    return native::list(app, storage, owner_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = storage;
        Err(ScriptSyncError::unsupported())
    }
}

#[tauri::command]
pub async fn wsagent_shared_scripts_read(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    id: String,
    expected_revision: String,
) -> Result<ScriptReply, ScriptSyncError> {
    let storage =
        main_storage(&webview, &app, &state, &owner_id).map_err(|_| ScriptSyncError::pairing())?;
    #[cfg(target_os = "macos")]
    return native::read(app, storage, owner_id, id, expected_revision).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, id, expected_revision);
        Err(ScriptSyncError::unsupported())
    }
}

#[tauri::command]
pub async fn wsagent_shared_scripts_apply(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WsagentSharedState>,
    owner_id: String,
    script: ScriptUpdate,
) -> Result<ScriptReply, ScriptSyncError> {
    let storage =
        main_storage(&webview, &app, &state, &owner_id).map_err(|_| ScriptSyncError::pairing())?;
    #[cfg(target_os = "macos")]
    return native::apply(app, storage, owner_id, script).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (storage, script);
        Err(ScriptSyncError::unsupported())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{Script, ScriptErrorCode, ScriptList, ScriptReply, ScriptSyncError, ScriptUpdate};
    use crate::wsagent_shared::{
        digest, is_digest,
        peer::{exchange_json, JsonPeerError},
        SharedStorage,
    };
    use reqwest::StatusCode;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};
    use std::{collections::HashSet, sync::Arc};
    use tauri::AppHandle;
    use tokio::sync::Semaphore;

    const MAX_SCRIPT_COUNT: usize = 512;
    const MAX_ID_BYTES: usize = 180;
    const MAX_TITLE_CHARS: usize = 180;
    const MAX_CONTENT_BYTES: usize = 1_000_000;
    const MAX_INDEX_BYTES: u64 = 2 * 1024 * 1024;
    const MAX_CONTENT_REPLY_BYTES: u64 = 7 * 1024 * 1024;
    const MAX_RECEIPT_BYTES: u64 = 4096;
    static REQUESTS: Semaphore = Semaphore::const_new(2);

    #[derive(Clone, Copy)]
    enum Operation {
        List,
        Read,
        Apply,
    }

    impl Operation {
        fn endpoint(self) -> &'static str {
            match self {
                Self::List => "/v1/scripts/list",
                Self::Read => "/v1/scripts/read",
                Self::Apply => "/v1/scripts/apply",
            }
        }

        fn max_reply_bytes(self) -> u64 {
            match self {
                Self::List => MAX_INDEX_BYTES,
                Self::Read => MAX_CONTENT_REPLY_BYTES,
                Self::Apply => MAX_RECEIPT_BYTES,
            }
        }
    }

    fn invalid() -> ScriptSyncError {
        ScriptSyncError::new(
            ScriptErrorCode::Invalid,
            "WSAGENT 剧本数据无效或超过大小限制",
        )
    }

    fn request_error(error: JsonPeerError) -> ScriptSyncError {
        match error {
            JsonPeerError::Pairing
            | JsonPeerError::Status(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
                ScriptSyncError::pairing()
            }
            JsonPeerError::Status(StatusCode::CONFLICT) => {
                ScriptSyncError::new(ScriptErrorCode::Conflict, "WSAGENT 剧本已修改，请重新同步")
            }
            JsonPeerError::Status(StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) => {
                ScriptSyncError::unsupported()
            }
            JsonPeerError::Invalid
            | JsonPeerError::Status(
                StatusCode::BAD_REQUEST
                | StatusCode::PAYLOAD_TOO_LARGE
                | StatusCode::UNPROCESSABLE_ENTITY,
            ) => invalid(),
            _ => ScriptSyncError::new(
                ScriptErrorCode::Unavailable,
                "暂时无法同步 WSAGENT 剧本，请确认两端已打开",
            ),
        }
    }

    fn valid_id(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= MAX_ID_BYTES
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    }

    fn valid_title(value: &str) -> bool {
        !value.trim().is_empty()
            && value.len() <= MAX_TITLE_CHARS * 4
            && value.chars().count() <= MAX_TITLE_CHARS
            && !value.chars().any(char::is_control)
    }

    fn valid_content(value: &str) -> bool {
        value.len() <= MAX_CONTENT_BYTES
            && !value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }

    fn valid_metadata(script: &Script) -> bool {
        valid_id(&script.id)
            && valid_title(&script.title)
            && is_digest(&script.revision)
            && is_digest(&script.content_digest)
    }

    async fn exchange<T: DeserializeOwned + Send + 'static>(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        operation: Operation,
        payload: Value,
    ) -> Result<T, ScriptSyncError> {
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
        .map_err(request_error)
    }

    pub(super) async fn list(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
    ) -> Result<ScriptList, ScriptSyncError> {
        let reply: ScriptList =
            exchange(app, storage, owner_id, Operation::List, json!({})).await?;
        let mut ids = HashSet::with_capacity(reply.scripts.len().min(MAX_SCRIPT_COUNT));
        if reply.scripts.len() > MAX_SCRIPT_COUNT
            || reply.scripts.iter().any(|script| {
                !valid_metadata(script) || script.content.is_some() || !ids.insert(&script.id)
            })
        {
            return Err(invalid());
        }
        Ok(reply)
    }

    pub(super) async fn read(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        id: String,
        expected_revision: String,
    ) -> Result<ScriptReply, ScriptSyncError> {
        if !valid_id(&id) || !is_digest(&expected_revision) {
            return Err(invalid());
        }
        let reply: ScriptReply = exchange(
            app,
            storage,
            owner_id,
            Operation::Read,
            json!({ "id": &id, "expectedRevision": &expected_revision }),
        )
        .await?;
        let script = &reply.script;
        if script.id != id
            || script.revision != expected_revision
            || !valid_metadata(script)
            || !script.content.as_deref().is_some_and(|text| {
                valid_content(text) && digest(text.as_bytes()) == script.content_digest
            })
        {
            return Err(invalid());
        }
        Ok(reply)
    }

    pub(super) async fn apply(
        app: AppHandle,
        storage: Arc<SharedStorage>,
        owner_id: String,
        script: ScriptUpdate,
    ) -> Result<ScriptReply, ScriptSyncError> {
        let valid_revision = match script.expected_revision.as_deref() {
            Some(revision) => is_digest(revision),
            None => script
                .id
                .strip_prefix("screenplay_canvas_")
                .is_some_and(is_digest),
        };
        if !valid_id(&script.id)
            || !valid_title(&script.title)
            || !valid_content(&script.content)
            || !valid_revision
        {
            return Err(invalid());
        }
        let reply: ScriptReply = exchange(
            app,
            storage,
            owner_id,
            Operation::Apply,
            json!({ "script": &script }),
        )
        .await?;
        if reply.script.id != script.id
            || !valid_metadata(&reply.script)
            || reply.script.content.is_some()
        {
            return Err(invalid());
        }
        Ok(reply)
    }
}
