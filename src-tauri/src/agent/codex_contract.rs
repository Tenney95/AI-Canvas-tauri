//! Fixed upstream contract, not an auto-updating compatibility range.
//! Source: openai/codex rust-v0.167.0, commit 086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a.
//! ModelInfo: codex-rs/protocol/src/openai_models.rs; API support and metadata:
//! codex-rs/models-manager/models.json (both listed slugs have supported_in_api=true).
//! model_catalog_json is startup-only: core/config.schema.json. The configured
//! provider uses StaticModelsManager: model-provider/src/provider.rs:549.
use serde_json::{json, Value};
use std::path::Path;

pub const VERSION: &str = "0.167.0";
pub const PROVIDER_ID: &str = "codex-app-server";
pub const MODEL_PROVIDER: &str = "ai_canvas_openai";
pub const SECRET_KEY: &str = "external-agent/codex";
pub const MODELS: [&str; 2] = ["gpt-6.1-sol", "gpt-6-astra"];
pub const MAX_PROMPT_BYTES: usize = 256 * 1024;
pub const MAX_SCHEMA_BYTES: usize = 32 * 1024;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
pub const TIMEOUT_SECONDS: u64 = 180;
pub const DISABLED_FEATURES: &[&str] = &[
    "shell_tool", "shell_snapshot", "apps", "plugins", "remote_plugin", "hooks",
    "multi_agent", "multi_agent_v2", "memories", "goals", "view_image", "image_generation",
    "browser_use", "computer_use", "in_app_browser", "code_mode", "code_mode_only",
    "code_mode_host", "workspace_dependencies", "deferred_executor", "request_permissions_tool",
    "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "skill_search",
    "standalone_web_search", "api_key_model_discovery",
];

pub fn capabilities() -> Value {
    json!({"oneShot":true,"cancel":true,"progress":true,"text":true,"structuredResult":true,
        "resume":false,"fork":false,"inheritsParentContext":false,"hostTools":false})
}

pub fn model_list() -> Value {
    json!([{"id":MODELS[0],"name":"GPT-6.1 Sol"},{"id":MODELS[1],"name":"GPT-6 Astra"}])
}

/// A complete bounded ModelInfo per the fixed upstream serde contract. No remote
/// catalog, tool-description overrides, model-owned auto-review, or multimodal input.
pub fn model_catalog(model: &str) -> Result<Value, String> {
    if !MODELS.contains(&model) { return Err("CODEX_MODEL_UNSUPPORTED".into()); }
    let mut metadata:Value=serde_json::from_str(r#"{
        "slug":"","display_name":"","description":"AI Canvas bounded text adviser",
        "default_reasoning_level":"low", "supported_reasoning_levels":[
            {"effort":"low","description":"Low"},{"effort":"medium","description":"Medium"}],
        "shell_type":"disabled","visibility":"list","supported_in_api":true,"priority":1,
        "availability_nux":null,"upgrade":null,"model_messages":null,
        "support_verbosity":true,"default_verbosity":"low","apply_patch_tool_type":null,
        "web_search_tool_type":"text","truncation_policy":{"mode":"tokens","limit":10000},
        "context_window":272000,"max_context_window":872000,"auto_compact_token_limit":null,
        "comp_hash":null,"experimental_supported_tools":[],"input_modalities":["text"],
        "tool_mode":"direct","prefer_websockets":false,"use_responses_lite":false,
        "supports_search_tool":false,"supports_experimental_context":false,
        "supports_parallel_tool_calls":false,"supports_image_detail_original":false,
        "include_skills_usage_instructions":false,"include_apps_usage_instructions":false,
        "include_plugin_usage_instructions":false,"node_repl_disabled":true,
        "node_repl_auto_review_required":false,"guardian":null,"requires_sandboxed_review":false,
        "auto_review_model_override":null,"model_specialty":null,"default_reasoning_summary":"none",
        "supports_reasoning_summary_parameter":true,"supports_reasoning_summaries":false,
        "supports_reasoning_effort_updates":false,"default_service_tier":null,
        "service_tiers":[],"additional_speed_tiers":[],"available_in_plans":[]
    }"#).map_err(|_|"CODEX_MODEL_CONTRACT_INVALID")?;
    metadata["slug"]=json!(model);
    metadata["display_name"]=json!(model);
    Ok(json!({"models":[metadata]}))
}

pub fn configuration(catalog: &Path) -> Result<String, String> {
    // JSON string escaping is valid TOML basic-string escaping; no shell is involved.
    let path = serde_json::to_string(catalog.to_str().ok_or("CODEX_PRIVATE_PATH_INVALID")?)
        .map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
    let mut config = format!(r#"model_provider = "ai_canvas_openai"
model_catalog_json = {path}
sandbox_mode = "read-only"
approval_policy = "never"
allow_login_shell = false
web_search = "disabled"
notify = []
project_root_markers = []
project_doc_max_bytes = 0
check_for_update_on_startup = false
[mcp_servers]
[history]
persistence = "none"
[skills]
include_instructions = false
config = []
[skills.bundled]
enabled = false
[features]
skip_host_skill_discovery = true
"#);
    for name in DISABLED_FEATURES { config.push_str(&format!("{name} = false\n")); }
    config.push_str(r#"[model_providers.ai_canvas_openai]
name = "AI Canvas OpenAI"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
env_key = "AI_CANVAS_CODEX_API_KEY"
request_max_retries = 0
stream_max_retries = 0
"#);
    Ok(config)
}

pub fn validate_version(text: &str) -> Result<(), String> {
    if text.trim() == format!("codex-cli {VERSION}") { Ok(()) }
    else { Err("CODEX_VERSION_UNSUPPORTED".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_and_config_are_fixed_and_have_no_host_tool_authority() {
        for model in MODELS {
            let catalog = model_catalog(model).unwrap();
            let metadata = &catalog["models"][0];
            assert_eq!(metadata["slug"], model);
            assert_eq!(metadata["shell_type"], "disabled");
            assert!(metadata["apply_patch_tool_type"].is_null());
            assert_eq!(metadata["experimental_supported_tools"], json!([]));
            assert_eq!(metadata["tool_mode"], "direct");
        }
        assert!(model_catalog("unknown-model").is_err());
        assert!(validate_version("codex-cli 0.168.0").is_err());
        assert!(validate_version("codex-cli 0.167.0").is_ok());
        let config = configuration(Path::new("private-models.json")).unwrap();
        for feature in DISABLED_FEATURES { assert!(config.contains(&format!("{feature} = false"))); }
        assert!(!config.contains("API_KEY="));
    }
}
