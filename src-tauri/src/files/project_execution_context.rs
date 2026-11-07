//! 画布原生会话的并发绑定合同；不授予文件/模型权限，也不解释owner为旧canvas身份。
use serde::{Deserialize, Deserializer, Serialize};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn nullable_episode<'de, D: Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(input)
}
/// 缺省沿用旧协议；显式null/损坏对象不能降级为旧授权。
pub fn optional_canvas_context<'de, D: Deserializer<'de>>(input: D) -> Result<Option<CanvasExecutionContext>, D::Error> {
    CanvasExecutionContext::deserialize(input).map(Some)
}
fn optional_runtime_epoch<'de, D: Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    String::deserialize(input).map(Some)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasExecutionContext {
    pub kind: String,
    pub schema_version: u8,
    pub model_generation: u64,
    pub project_id: String,
    pub project_epoch: u64,
    pub canvas_id: String,
    #[serde(deserialize_with = "nullable_episode")]
    pub episode_id: Option<String>,
    pub canvas_epoch: u64,
    pub canvas_revision: u64,
    #[serde(default, deserialize_with = "optional_runtime_epoch", skip_serializing_if = "Option::is_none")]
    pub runtime_epoch: Option<String>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 256 && value.trim() == value && !value.chars().any(char::is_control)
}

impl CanvasExecutionContext {
    /// legacy_project_id始终是旧画布域；并发上下文的owner不得替代它。
    pub fn matches_canvas(&self, legacy_project_id: &str, revision: Option<u64>) -> bool {
        self.kind == "canvas" && self.schema_version == 2
            && self.canvas_id == legacy_project_id
            && valid_id(&self.project_id) && valid_id(&self.canvas_id)
            && self.episode_id.as_deref().is_none_or(valid_id)
            && self.runtime_epoch.as_deref().is_none_or(|value| !value.is_empty()
                && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
            && [self.model_generation, self.project_epoch, self.canvas_epoch, self.canvas_revision]
                .into_iter().all(|value| value <= MAX_SAFE_INTEGER)
            && revision.is_none_or(|value| value == self.canvas_revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> serde_json::Value {
        serde_json::json!({"kind":"canvas","schemaVersion":2,"modelGeneration":0,
            "projectId":"owner","projectEpoch":2,"canvasId":"legacy-episode",
            "episodeId":"legacy-episode","canvasEpoch":3,"canvasRevision":4})
    }

    #[test]
    fn preserves_canvas_alias_and_rejects_owner_or_future_context() {
        let value: CanvasExecutionContext = serde_json::from_value(context()).unwrap();
        assert!(value.matches_canvas("legacy-episode", Some(4)));
        assert!(!value.matches_canvas("owner", Some(4)));
        assert!(!value.matches_canvas("legacy-episode", Some(5)));
        let mut future = context(); future["schemaVersion"] = 3.into();
        assert!(!serde_json::from_value::<CanvasExecutionContext>(future).unwrap().matches_canvas("legacy-episode", None));
    }

    #[test]
    fn requires_nullable_episode_and_rejects_unknown_or_unsafe_values() {
        let mut missing = context(); missing.as_object_mut().unwrap().remove("episodeId");
        assert!(serde_json::from_value::<CanvasExecutionContext>(missing).is_err());
        let mut unknown = context(); unknown["contextToken"] = "not-an-authorization".into();
        assert!(serde_json::from_value::<CanvasExecutionContext>(unknown).is_err());
        let mut unsafe_value = context(); unsafe_value["modelGeneration"] = (MAX_SAFE_INTEGER + 1).into();
        assert!(!serde_json::from_value::<CanvasExecutionContext>(unsafe_value).unwrap().matches_canvas("legacy-episode", None));
        let mut null_epoch = context(); null_epoch["runtimeEpoch"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<CanvasExecutionContext>(null_epoch).is_err());
    }
}
