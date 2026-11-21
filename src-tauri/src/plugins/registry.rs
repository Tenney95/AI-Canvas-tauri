//! 用户插件的原生信任注册表。
//!
//! Renderer 只能提交待暂存内容或不透明的插件 ID / 源码摘要；真正用于执行的源码快照、
//! runtime 与工具清单保存在 Rust 私有目录中。激活版本和上一版本采用原子注册表切换，
//! 插件执行前必须重新核对私有快照的 SHA-256。

#[path = "registry/activation.rs"]
mod activation;
#[path = "registry/dependencies.rs"]
mod dependencies;
#[path = "registry/manifest.rs"]
mod manifest;
#[path = "registry/persistence.rs"]
mod persistence;
#[path = "registry/private_storage.rs"]
mod private_storage;
#[path = "registry/snapshots.rs"]
mod snapshots;

use activation::{
    activation_approval_snapshot_matches, activation_candidate, activation_requires_native_approval,
    commit_activation_at, commit_enabled_at, enable_approval_snapshot_matches, matching_revision,
    revision_security_manifest_matches, set_enabled_requires_native_approval, switch_active_revision,
};
use dependencies::{
    cancel_dependency_tree, dependency_fingerprint, ensure_candidate_dependencies, validate_dependencies,
};
pub(crate) use manifest::validate_plugin_id;
use manifest::{
    ensure_host_compatibility, host_version_parts, parse_revision_with_resources,
    validate_compatibility_shape, validate_model_protocols, validate_package_resource_path,
    validate_source_digest, validate_tool_id,
};
use persistence::{
    is_repairable_registry_error, read_registry_at, repair_corrupt_registry_at, write_registry_at,
};

pub(crate) use private_storage::plugin_private_dir;
use private_storage::{
    ensure_private_directory, plugin_private_roots, prepare_plugin_storage_for_mutation,
    prepared_plugin_directory,
};

pub(crate) use snapshots::read_active_ui_source;
use snapshots::{
    read_cached_resource_at, read_verified_resource_at, read_verified_source_at, read_verified_ui_source_at,
    remove_revision_snapshot, write_resource_snapshots_at, write_source_snapshot_at, write_ui_snapshot_at,
};

use crate::path_policy::{ensure_trusted_caller, simplify_verbatim};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;

const REGISTRY_SCHEMA_VERSION: u32 = 1;
const PRIVATE_DIR_NAME: &str = crate::plugin_install_permissions::DIRECTORY_NAME;
const LEGACY_PRIVATE_DIR_NAME: &str = "plugin-private";
const MIGRATION_DIR_NAME: &str = crate::plugin_install_permissions::STAGING_DIRECTORY_NAME;
const PREPARED_MIGRATION_DIR_NAME: &str = ".permissions-migration";
const STORAGE_PERMISSION_ERROR: &str = "插件目录权限不足：";
const REGISTRY_FILE_NAME: &str = "registry.json";
const REGISTRY_TEMP_FILE_NAME: &str = "registry.json.tmp";
const REGISTRY_BACKUP_FILE_NAME: &str = "registry.json.bak";
const REVISIONS_DIR_NAME: &str = "revisions";
const UI_REVISIONS_DIR_NAME: &str = "ui-revisions";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_SOURCE_BYTES: usize = 512 * 1024;
const MAX_PLUGIN_ID_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 32;
const MAX_PERMISSION_COUNT: usize = 32;
const MAX_PERMISSION_BYTES: usize = 64;
const MAX_DECLARED_TOOL_IDS: usize = 96;
const MAX_TOOL_ID_BYTES: usize = 64;
const MAX_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PLUGIN_REGISTRATIONS: usize = 512;
/// 自定义界面产物上限。产物是打包后的 JS，通常比入口源码大，但不该无节制。
const MAX_UI_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_UI_ENTRY_BYTES: usize = 128;
const MAX_UI_EXPORT_KEY_BYTES: usize = 64;
const MAX_UI_EXPORTS: usize = 32;
const MAX_PACKAGE_RESOURCES: usize = 64;
const MAX_PACKAGE_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const SUPPORTED_PERMISSIONS: [&str; 13] = [
    "node.read",
    "node.write",
    "models.read",
    "models.invoke",
    "prompt.references.read",
    "wsagent.shared-images",
    "network.request",
    "settings.read",
    "settings.write",
    "files.connected.read",
    "files.output.create",
    "plugin.resources.read",
    "ui.custom",
];

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

// 这里只缓存校验过的不可变字节，不缓存权限；每次分段读取仍先检查活动 revision。
const MAX_VERIFIED_RESOURCE_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_VERIFIED_RESOURCE_CACHE_ENTRIES: usize = 16;
#[derive(Default)]
struct VerifiedResourceCache {
    entries: VecDeque<VerifiedResourceEntry>,
    bytes: usize,
}
struct VerifiedResourceEntry {
    plugin_id: String,
    path: PathBuf,
    revision_digest: String,
    resource_digest: String,
    modified: SystemTime,
    created: Option<SystemTime>,
    bytes: Arc<[u8]>,
}
static VERIFIED_RESOURCE_CACHE: OnceLock<Mutex<VerifiedResourceCache>> = OnceLock::new();

fn verified_resource_cache() -> &'static Mutex<VerifiedResourceCache> {
    VERIFIED_RESOURCE_CACHE.get_or_init(|| Mutex::new(VerifiedResourceCache::default()))
}

fn revoke_verified_resources(plugin_id: Option<&str>) {
    let mut cache = verified_resource_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache
        .entries
        .retain(|entry| plugin_id.is_some_and(|id| entry.plugin_id != id));
    cache.bytes = cache.entries.iter().map(|entry| entry.bytes.len()).sum();
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginRevision {
    revision_digest: String,
    source_digest: String,
    version: String,
    runtime: String,
    entry: String,
    permissions: Vec<String>,
    #[serde(default)]
    network_origins: Vec<String>,
    #[serde(default)]
    min_host_version: Option<String>,
    #[serde(default)]
    required_capabilities: Vec<String>,
    #[serde(default)]
    dependencies: Vec<PluginDependency>,
    declared_tool_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    model_protocols: Vec<PluginModelProtocol>,
    #[serde(default)]
    python_execution: BTreeMap<String, PluginPythonExecution>,
    #[serde(default)]
    native_approved: bool,
    /// 自定义界面产物的 SHA-256（manifest.ui.integrity 归一化后的 hex）；未声明 ui 时为 None。
    #[serde(default)]
    ui_digest: Option<String>,
    /// 自定义界面产物在版本目录内的相对文件名。
    #[serde(default)]
    ui_entry: Option<String>,
    #[serde(default)]
    resources: Vec<PluginPackageResource>,
    staged_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginPackageResource {
    id: String,
    path: String,
    digest: String,
    media_type: String,
    bytes: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginDependency {
    plugin_id: String,
    #[serde(default)]
    min_version: Option<String>,
    #[serde(default)]
    optional: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackageResourcePayload {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginRegistration {
    plugin_id: String,
    enabled: bool,
    active: Option<PluginRevision>,
    previous: Option<PluginRevision>,
    staged: Option<PluginRevision>,
    installed_at: u64,
    updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginRegistry {
    schema_version: u32,
    plugins: BTreeMap<String, PluginRegistration>,
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            plugins: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedPluginRevision {
    plugin_id: String,
    source_digest: String,
    revision_digest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistrationStatus {
    plugin_id: String,
    exists: bool,
    enabled: bool,
    active_source_digest: Option<String>,
    active_revision_digest: Option<String>,
    previous_source_digest: Option<String>,
    staged_source_digest: Option<String>,
    version: Option<String>,
    runtime: Option<String>,
    entry: Option<String>,
    permissions: Vec<String>,
    declared_tool_ids: Vec<String>,
    snapshot_verified: bool,
    health_code: String,
    dependency_fingerprint: Option<String>,
    model_protocols: Vec<PluginModelProtocol>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginModelProtocol {
    id: String,
    name: String,
    category: String,
    adapter: String,
}

pub(crate) struct PluginExecutionSource {
    pub runtime: String,
    pub source: String,
    pub python_execution: Option<PluginPythonExecution>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginPythonExecution {
    #[serde(default = "default_python_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub media_workspace: bool,
}

fn default_python_timeout() -> u64 {
    30
}

pub(crate) struct PluginHostGrant {
    pub permissions: Vec<String>,
    pub network_origins: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct NativeApprovalPrompt {
    title: String,
    message: String,
    approve_label: String,
    cancel_label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeApprovalAction {
    Stage,
    EnableOrSwitch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RevisionSlot {
    Active,
    Previous,
    Staged,
}

fn unix_now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn build_python_approval_prompt(
    action: NativeApprovalAction,
    plugin_id: &str,
    revision: &PluginRevision,
) -> NativeApprovalPrompt {
    let has_ui = revision.permissions.iter().any(|item| item == "ui.custom");
    let is_python = revision.runtime == "python";
    let kind = match (is_python, has_ui) {
        (true, true) => "可信 Python + 自定义界面插件",
        (true, false) => "可信 Python 插件",
        (false, true) => "带自定义界面的插件",
        (false, false)
            if revision
                .permissions
                .iter()
                .any(|value| value == "network.request") =>
        {
            "联网插件"
        }
        (false, false) => "插件",
    };
    let (title, action_text, approve_label, final_action) = match action {
        NativeApprovalAction::Stage => (
            format!("高风险：安装{kind}"),
            format!("即将安装{kind}"),
            "继续安装".to_string(),
            "继续安装".to_string(),
        ),
        NativeApprovalAction::EnableOrSwitch => (
            format!("高风险：授权{kind}版本"),
            format!("即将授权并启用或切换{kind}版本"),
            "授权并继续".to_string(),
            if is_python && !has_ui {
                "授权并启用或切换此 Python 版本".to_string()
            } else {
                "授权并启用或切换此版本".to_string()
            },
        ),
    };
    let permissions = if revision.permissions.is_empty() {
        "无".to_string()
    } else {
        revision.permissions.join("、")
    };
    let python_risk = if is_python {
        "\n\n该 Python 代码将以当前登录用户的完整系统权限运行，可以读取或修改本机文件、访问网络、读取环境变量并启动其他程序。"
    } else {
        ""
    };
    let ui_digest = revision
        .ui_digest
        .clone()
        .unwrap_or_else(|| "缺失".to_string());
    let ui_risk = if has_ui {
        format!(
            "\n\n该插件带有自定义界面代码（界面产物 SHA-256：{ui_digest}），会在主窗口的隔离弹窗中运行。\
界面不能直接访问宿主 DOM、文件系统、Shell、网络或 API Key，只能请求宿主执行已声明能力，并看到本次授权的不透明资源信息。"
        )
    } else {
        String::new()
    };
    let host_risk = format!(
        "\n\n完整 revision SHA-256：{}{}{}{}",
        revision.revision_digest,
        if revision.network_origins.is_empty() {
            String::new()
        } else {
            format!(
                "\n获准请求的 HTTPS 来源：{}。插件可以把本次授权的输入发送到这些来源。",
                revision.network_origins.join("、")
            )
        },
        if revision
            .permissions
            .iter()
            .any(|value| value.starts_with("settings."))
        {
            "\n插件可按声明权限读取或保存自己的非敏感偏好；设置不用于保存凭据。".to_string()
        } else {
            String::new()
        },
        if revision.permissions.iter().any(|value| value == "wsagent.shared-images") {
            "\n插件可浏览当前作品的 WSAGENT 共享图片、插入画布或发布指定的连线图片。"
        } else {
            ""
        },
    );
    NativeApprovalPrompt {
        title,
        message: format!(
            "{action_text}。\n\n\
插件 ID：{plugin_id}\n\
版本：{}\n\
运行时：{}\n\
代码 SHA-256：{}\n\
声明的宿主权限：{permissions}{python_risk}{ui_risk}{host_risk}\n\n\
只有在你已经审阅并信任上述完整 64 位 SHA-256 对应的源码时，才{final_action}。",
            revision.version, revision.runtime, revision.source_digest
        ),
        approve_label,
        cancel_label: "取消".to_string(),
    }
}

/// 联网、设置及项目互联授权绑定到当前版本。
fn revision_requests_native_approval(revision: &PluginRevision) -> bool {
    revision.runtime == "python"
        || revision.permissions.iter().any(|item| {
            matches!(
                item.as_str(),
                "ui.custom" | "network.request" | "settings.read" | "settings.write" | "wsagent.shared-images"
            )
        })
}

fn native_stage_decision(revision: &PluginRevision, approval: Option<bool>) -> bool {
    if revision_requests_native_approval(revision) {
        return approval == Some(true);
    }
    revision.runtime == "javascript"
}

fn apply_native_stage_approval(revision: &mut PluginRevision, approval: Option<bool>) -> bool {
    if !native_stage_decision(revision, approval) {
        return false;
    }
    revision.native_approved = revision_requests_native_approval(revision);
    true
}

async fn request_native_revision_approval(
    app: &AppHandle,
    action: NativeApprovalAction,
    plugin_id: &str,
    revision: &PluginRevision,
) -> Result<bool, String> {
    if !revision_requests_native_approval(revision) {
        return Err("该插件不需要原生高风险确认".to_string());
    }
    let prompt = build_python_approval_prompt(action, plugin_id, revision);
    let dialog_app = app.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(prompt.message)
            .title(prompt.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                prompt.approve_label,
                prompt.cancel_label,
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "无法显示插件原生高风险授权确认".to_string())?;
    Ok(approved)
}

async fn request_registry_repair_approval(app: &AppHandle) -> Result<bool, String> {
    let dialog_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(
                "插件信任注册表已经损坏。修复会重建空注册表、停止全部插件调用并删除原生私有插件快照。\n\n应用内的插件安装记录会保留但全部停用；修复后可逐个卸载或重新安装。此操作无法撤销。",
            )
            .title("修复插件信任注册表？")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "修复并停用全部插件".into(),
                "取消".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "无法显示插件信任注册表修复确认".to_string())
}

fn normalized_for_compare(path: &Path) -> PathBuf {
    simplify_verbatim(
        path.canonicalize()
            .unwrap_or_else(|_| path.components().collect()),
    )
}

fn is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

pub(crate) fn is_under_plugin_private_dir(private_dir: &Path, resolved: &Path) -> bool {
    let private = normalized_for_compare(private_dir);
    let target = normalized_for_compare(resolved);
    is_within(&target, &private)
}

fn plugin_private_paths_overlap(private_dir: &Path, resolved: &Path) -> bool {
    let private = normalized_for_compare(private_dir);
    let target = normalized_for_compare(resolved);
    is_within(&target, &private) || is_within(&private, &target)
}

pub fn is_plugin_private_path<R: Runtime>(app: &AppHandle<R>, resolved: &Path) -> bool {
    plugin_private_roots(app)
        .iter()
        .any(|directory| is_under_plugin_private_dir(directory, resolved))
}

pub(crate) fn is_plugin_private_path_overlap<R: Runtime>(
    app: &AppHandle<R>,
    resolved: &Path,
) -> bool {
    plugin_private_roots(app)
        .iter()
        .any(|directory| plugin_private_paths_overlap(directory, resolved))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginUiIdentity {
    pub plugin_id: String,
    pub source_digest: String,
    pub revision_digest: String,
    pub ui_digest: String,
    pub tool_id: String,
}

/// UI 产物不变也不能跨主源码/manifest revision 继续使用旧会话。
/// operation 在 registry 锁内执行，只允许短暂操作原生会话表，不执行宿主 effect。
pub(crate) fn with_active_window_ui<T>(
    private_dir: &Path,
    identity: &PluginUiIdentity,
    operation: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    validate_plugin_id(&identity.plugin_id)?;
    validate_source_digest(&identity.source_digest)?;
    validate_source_digest(&identity.revision_digest)?;
    validate_source_digest(&identity.ui_digest)?;
    validate_tool_id(&identity.tool_id)?;
    let _lock = REGISTRY_LOCK.lock().map_err(|_| "插件信任注册表不可用")?;
    let registry = read_registry_at(private_dir)?;
    dependency_fingerprint(&registry, &identity.plugin_id)?;
    let record = registry
        .plugins
        .get(&identity.plugin_id)
        .ok_or("插件未安装")?;
    if !record.enabled {
        return Err("插件已停用".into());
    }
    let active = record.active.as_ref().ok_or("插件没有活动版本")?;
    if active.source_digest != identity.source_digest
        || active.revision_digest != identity.revision_digest
        || active.ui_digest.as_deref() != Some(identity.ui_digest.as_str())
        || active
            .declared_tool_ids
            .binary_search(&identity.tool_id)
            .is_err()
        || !active
            .permissions
            .iter()
            .any(|permission| permission == "ui.custom")
    {
        return Err("插件窗口版本或工具归属已失效".into());
    }
    ensure_native_execution_approved(active)?;
    let _ = read_verified_source_at(private_dir, &identity.plugin_id, active)?;
    let source = read_verified_ui_source_at(private_dir, &identity.plugin_id, active)?
        .ok_or("插件没有自定义界面产物")?;
    operation(&source)
}

fn revision_is_referenced(record: &PluginRegistration, digest: &str) -> bool {
    [&record.active, &record.previous, &record.staged]
        .into_iter()
        .flatten()
        .any(|revision| revision.revision_digest == digest)
}

fn status_for(plugin_id: &str, record: Option<&PluginRegistration>) -> PluginRegistrationStatus {
    let active = record.and_then(|item| item.active.as_ref());
    PluginRegistrationStatus {
        plugin_id: plugin_id.to_string(),
        exists: record.is_some(),
        enabled: record.is_some_and(|item| item.enabled),
        active_source_digest: active.map(|item| item.source_digest.clone()),
        active_revision_digest: active.map(|item| item.revision_digest.clone()),
        previous_source_digest: record
            .and_then(|item| item.previous.as_ref())
            .map(|item| item.source_digest.clone()),
        staged_source_digest: record
            .and_then(|item| item.staged.as_ref())
            .map(|item| item.source_digest.clone()),
        version: active.map(|item| item.version.clone()),
        runtime: active.map(|item| item.runtime.clone()),
        entry: active.map(|item| item.entry.clone()),
        permissions: active
            .map(|item| item.permissions.clone())
            .unwrap_or_default(),
        declared_tool_ids: active
            .map(|item| item.declared_tool_ids.clone())
            .unwrap_or_default(),
        snapshot_verified: false,
        health_code: "unavailable".into(),
        dependency_fingerprint: None,
        model_protocols: Vec::new(),
    }
}

/// 调用方必须已经成功提交注册表，并且仍持有 `REGISTRY_LOCK`。
///
/// 取消动作也在线性化区间内完成，防止锁释放后同 ID 新版本先启动、再被旧事务误取消。
/// `cancel_plugin_invocations` 只短暂持有 invocation map；Python 注册流程释放该 map 后才会
/// 再读取注册表，因此这里采用 registry -> invocation 的锁顺序不会形成反向等待。
fn cancel_committed_plugin_invocations(plugin_id: &str) {
    revoke_verified_resources(Some(plugin_id));
    crate::plugin_runtime::cancel_plugin_invocations(plugin_id);
    crate::plugin_host_effects::cancel_plugin_requests(Some(plugin_id));
    crate::plugin_window::revoke_plugin_sessions(plugin_id);
}

fn ensure_native_execution_approved(revision: &PluginRevision) -> Result<(), String> {
    ensure_host_compatibility(
        revision.min_host_version.as_deref(),
        &revision.required_capabilities,
    )?;
    if revision_requests_native_approval(revision) && !revision.native_approved {
        return Err("插件尚未完成原生高风险授权，请停用后重新启用".to_string());
    }
    Ok(())
}

fn stage_revision_with_resources_at(
    private_dir: &Path,
    plugin_id: String,
    revision: PluginRevision,
    source: &str,
    ui_source: Option<&str>,
    resource_payloads: &[PluginPackageResourcePayload],
) -> Result<StagedPluginRevision, String> {
    ensure_native_execution_approved(&revision)?;
    let mut registry = read_registry_at(private_dir)?;
    let now = unix_now_millis();
    let record = registry
        .plugins
        .entry(plugin_id.clone())
        .or_insert_with(|| PluginRegistration {
            plugin_id: plugin_id.clone(),
            enabled: false,
            active: None,
            previous: None,
            staged: None,
            installed_at: now,
            updated_at: now,
        });

    if let Some(existing) = matching_revision(record, &revision.revision_digest) {
        // native_approved 是本机授权状态、staged_at 是事务元数据；两者都不属于 Manifest。
        if !revision_security_manifest_matches(existing, &revision) {
            return Err("同一源码摘要对应了不同 Manifest；请修改源码后重新暂存".to_string());
        }
    }

    let created_snapshot = write_source_snapshot_at(private_dir, &plugin_id, &revision, source)?;
    if let Err(error) =
        write_resource_snapshots_at(private_dir, &plugin_id, &revision, resource_payloads)
    {
        if created_snapshot {
            remove_revision_snapshot(private_dir, &plugin_id, &revision);
        }
        return Err(error);
    }
    // 界面产物与入口源码同属一个版本目录；写失败时把刚建的快照整体回收，避免留下半截版本。
    if let Some(ui) = ui_source {
        if let Err(error) = write_ui_snapshot_at(private_dir, &plugin_id, &revision, ui) {
            if created_snapshot {
                remove_revision_snapshot(private_dir, &plugin_id, &revision);
            }
            return Err(error);
        }
    }
    let replaced_staged = record.staged.replace(revision.clone());
    record.updated_at = now;
    if let Err(error) = write_registry_at(private_dir, &registry) {
        if created_snapshot {
            remove_revision_snapshot(private_dir, &plugin_id, &revision);
        }
        return Err(error);
    }
    if let Some(replaced) = replaced_staged {
        let current = registry.plugins.get(&plugin_id).expect("插件记录刚写入");
        if !revision_is_referenced(current, &replaced.revision_digest) {
            remove_revision_snapshot(private_dir, &plugin_id, &replaced);
        }
    }
    Ok(StagedPluginRevision {
        plugin_id,
        source_digest: revision.source_digest,
        revision_digest: revision.revision_digest,
    })
}

#[cfg(test)]
fn stage_revision_at(
    private_dir: &Path,
    plugin_id: String,
    revision: PluginRevision,
    source: &str,
    ui_source: Option<&str>,
) -> Result<StagedPluginRevision, String> {
    stage_revision_with_resources_at(private_dir, plugin_id, revision, source, ui_source, &[])
}

/// 把插件注册表和源码快照从 Renderer 的 fs / asset scope 中移除。
pub fn deny_plugin_private_dir_access<R: Runtime>(app: &AppHandle<R>) {
    for directory in plugin_private_roots(app) {
        let normalized = normalized_for_compare(&directory);
        for path in [&directory, &normalized] {
            if app.fs_scope().forbid_directory(path, true).is_err() {
                eprintln!("[plugin-registry] 无法从 fs scope 拒绝插件私有目录");
            }
            if app.asset_protocol_scope().forbid_directory(path, true).is_err() {
                eprintln!("[plugin-registry] 无法从 asset scope 拒绝插件私有目录");
            }
        }
    }
}

#[tauri::command]
pub async fn stage_plugin_revision(
    app: AppHandle,
    webview: Webview,
    manifest: Value,
    source: String,
    ui_source: Option<String>,
    resource_payloads: Vec<PluginPackageResourcePayload>,
) -> Result<StagedPluginRevision, String> {
    ensure_trusted_caller(&webview)?;
    let (plugin_id, mut revision) = parse_revision_with_resources(
        &manifest,
        &source,
        ui_source.as_deref(),
        &resource_payloads,
    )?;
    let native_approval = if revision_requests_native_approval(&revision) {
        Some(
            request_native_revision_approval(
                &app,
                NativeApprovalAction::Stage,
                &plugin_id,
                &revision,
            )
            .await?,
        )
    } else {
        None
    };
    if !apply_native_stage_approval(&mut revision, native_approval) {
        return Err("用户已取消插件原生高风险授权，未写入任何插件数据".to_string());
    }
    prepare_plugin_storage_for_mutation(&app, &plugin_id, Some(&revision.revision_digest)).await?;
    let private_dir = plugin_private_dir(&app)?;
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    stage_revision_with_resources_at(
        &private_dir,
        plugin_id,
        revision,
        &source,
        ui_source.as_deref(),
        &resource_payloads,
    )
}

#[tauri::command]
pub async fn activate_plugin_revision(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
    source_digest: String,
    revision_digest: String,
    enabled: bool,
    request_directory_access: Option<bool>,
) -> Result<PluginRegistrationStatus, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    validate_source_digest(&source_digest)?;
    validate_source_digest(&revision_digest)?;
    // 自动激活和补偿调用默认不申请授权，只有设置页显式“启用”传入 true。
    if enabled && request_directory_access == Some(true) {
        prepare_plugin_storage_for_mutation(&app, &plugin_id, Some(&revision_digest)).await?;
    }
    let private_dir = plugin_private_dir(&app)?;
    let (expected_record, expected_slot, candidate) = {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "插件信任注册表锁异常".to_string())?;
        let mut registry = read_registry_at(&private_dir)?;
        let record = registry
            .plugins
            .get(&plugin_id)
            .ok_or_else(|| "插件尚未暂存或已移除".to_string())?;
        let (slot, candidate) = activation_candidate(record, &revision_digest)
            .ok_or_else(|| "指定插件版本未暂存，也不是可回滚版本".to_string())?;
        if candidate.source_digest != source_digest {
            return Err("指定插件源码摘要与 revision 不匹配".to_string());
        }
        let _ = read_verified_source_at(&private_dir, &plugin_id, candidate)?;
        if !activation_requires_native_approval(record, slot, candidate, enabled) {
            return commit_activation_at(
                &private_dir,
                &mut registry,
                &plugin_id,
                &revision_digest,
                enabled,
                false,
            );
        }
        (record.clone(), slot, candidate.clone())
    };

    let approved = request_native_revision_approval(
        &app,
        NativeApprovalAction::EnableOrSwitch,
        &plugin_id,
        &candidate,
    )
    .await?;
    if !approved {
        return Err("用户已取消 Python 插件原生授权，插件状态未改变".to_string());
    }

    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    let mut registry = read_registry_at(&private_dir)?;
    let current = registry
        .plugins
        .get(&plugin_id)
        .ok_or_else(|| "插件状态已变化，请重新操作".to_string())?;
    if !activation_approval_snapshot_matches(
        current,
        &expected_record,
        expected_slot,
        &revision_digest,
        &candidate,
    ) {
        return Err("插件状态、候选角色或摘要已变化，请重新确认原生授权".to_string());
    }
    commit_activation_at(
        &private_dir,
        &mut registry,
        &plugin_id,
        &revision_digest,
        enabled,
        true,
    )
}

#[tauri::command]
pub async fn ensure_plugin_registration(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
    source_digest: String,
    revision_digest: String,
    enabled: bool,
) -> Result<PluginRegistrationStatus, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    validate_source_digest(&source_digest)?;
    validate_source_digest(&revision_digest)?;
    let private_dir = plugin_private_dir(&app)?;
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    let registry = read_registry_at(&private_dir)?;
    let record = registry
        .plugins
        .get(&plugin_id)
        .ok_or_else(|| "插件未注册".to_string())?;
    if record.enabled != enabled {
        return Err("插件原生启用状态与请求不一致".to_string());
    }
    let active = record
        .active
        .as_ref()
        .filter(|revision| {
            revision.source_digest == source_digest && revision.revision_digest == revision_digest
        })
        .ok_or_else(|| "插件活动版本与请求摘要不一致".to_string())?;
    let _ = read_verified_source_at(&private_dir, &plugin_id, active)?;
    ensure_native_execution_approved(active)?;
    Ok(status_for(&plugin_id, Some(record)))
}

#[tauri::command]
pub async fn set_plugin_registration_enabled(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginRegistrationStatus, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    if enabled {
        prepare_plugin_storage_for_mutation(&app, &plugin_id, None).await?;
    }
    let private_dir = plugin_private_dir(&app)?;
    let (expected_record, candidate) = {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "插件信任注册表锁异常".to_string())?;
        let mut registry = read_registry_at(&private_dir)?;
        let record = registry
            .plugins
            .get(&plugin_id)
            .ok_or_else(|| "插件未注册".to_string())?;
        if !set_enabled_requires_native_approval(record, enabled) {
            return commit_enabled_at(&private_dir, &mut registry, &plugin_id, enabled, false);
        }
        let active = record
            .active
            .as_ref()
            .ok_or_else(|| "插件没有可启用的活动版本".to_string())?;
        let _ = read_verified_source_at(&private_dir, &plugin_id, active)?;
        (record.clone(), active.clone())
    };

    let approved = request_native_revision_approval(
        &app,
        NativeApprovalAction::EnableOrSwitch,
        &plugin_id,
        &candidate,
    )
    .await?;
    if !approved {
        return Err("用户已取消 Python 插件原生授权，插件仍保持停用".to_string());
    }

    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    let mut registry = read_registry_at(&private_dir)?;
    let current = registry
        .plugins
        .get(&plugin_id)
        .ok_or_else(|| "插件状态已变化，请重新操作".to_string())?;
    if !enable_approval_snapshot_matches(current, &expected_record, &candidate, enabled) {
        return Err("插件活动版本或启用状态已变化，请重新确认原生授权".to_string());
    }
    commit_enabled_at(&private_dir, &mut registry, &plugin_id, enabled, true)
}

#[tauri::command]
pub async fn remove_plugin_registration(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
) -> Result<bool, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    let private_dir = plugin_private_dir(&app)?;
    {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "插件信任注册表锁异常".to_string())?;
        let mut registry = read_registry_at(&private_dir)?;
        let Some(record) = registry.plugins.remove(&plugin_id) else {
            crate::plugin_host_effects::remove_settings_at(&private_dir, &plugin_id)?;
            return Ok(false);
        };
        if let Err(error) = write_registry_at(&private_dir, &registry) {
            registry.plugins.insert(plugin_id.clone(), record);
            return Err(error);
        }
        cancel_dependency_tree(&registry, &plugin_id);
        // 快照删除也受注册表锁保护，避免卸载与同 ID 的重新安装互相穿插。
        let directory = private_dir.join(REVISIONS_DIR_NAME).join(&record.plugin_id);
        let _ = fs::remove_dir_all(directory);
        let ui_directory = private_dir
            .join(UI_REVISIONS_DIR_NAME)
            .join(&record.plugin_id);
        let _ = fs::remove_dir_all(ui_directory);
        crate::plugin_host_effects::remove_settings_at(&private_dir, &plugin_id)?;
    }
    Ok(true)
}

#[tauri::command]
pub async fn repair_plugin_registry(app: AppHandle, webview: Webview) -> Result<bool, String> {
    ensure_trusted_caller(&webview)?;
    let private_dir = plugin_private_dir(&app)?;
    {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "插件信任注册表锁异常".to_string())?;
        match read_registry_at(&private_dir) {
            Ok(_) => return Ok(false),
            Err(error) if is_repairable_registry_error(&error) => {}
            Err(error) => return Err(error),
        }
    }
    if !request_registry_repair_approval(&app).await? {
        return Err("用户已取消插件信任注册表修复".to_string());
    }
    let repaired = {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "插件信任注册表锁异常".to_string())?;
        repair_corrupt_registry_at(&private_dir)?
    };
    if repaired {
        revoke_verified_resources(None);
        crate::plugin_runtime::cancel_all_plugin_invocations();
        crate::plugin_host_effects::cancel_plugin_requests(None);
        crate::plugin_window::revoke_all_sessions_for_registry_repair();
    }
    Ok(repaired)
}

#[tauri::command]
pub async fn get_plugin_registration_status(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
) -> Result<PluginRegistrationStatus, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    let private_dir = plugin_private_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REGISTRY_LOCK.lock().map_err(|_| "插件信任注册表锁异常".to_string())?;
        let registry = read_registry_at(&private_dir)?;
        Ok(health_status_at(&private_dir, &registry, &plugin_id))
    }).await.map_err(|_| "插件诊断未完成".to_string())?
}

fn health_status_at(private_dir: &Path, registry: &PluginRegistry, plugin_id: &str) -> PluginRegistrationStatus {
    let record = registry.plugins.get(plugin_id);
    let mut status = status_for(plugin_id, record);
    let Some(record) = record else { status.health_code = "missing".into(); return status; };
    let Some(active) = record.active.as_ref() else { status.health_code = "invalid".into(); return status; };
    status.snapshot_verified = read_verified_source_at(private_dir, plugin_id, active).is_ok()
        && read_verified_ui_source_at(private_dir, plugin_id, active).is_ok()
        && active.resources.iter().all(|resource| read_verified_resource_at(private_dir, plugin_id, active, &resource.id).is_ok());
    status.dependency_fingerprint = dependency_fingerprint(registry, plugin_id).ok();
    status.health_code = if !status.snapshot_verified || ensure_native_execution_approved(active).is_err() { "invalid" }
        else if !record.enabled { "disabled" }
        else if status.dependency_fingerprint.is_none() { "blocked" }
        else { "ready" }.into();
    if status.health_code == "ready" { status.model_protocols = active.model_protocols.clone(); }
    status
}

pub(crate) fn load_plugin_for_execution<R: Runtime>(
    app: &AppHandle<R>,
    plugin_id: &str,
    source_digest: &str,
    revision_digest: &str,
    tool_id: &str,
) -> Result<PluginExecutionSource, String> {
    validate_plugin_id(plugin_id)?;
    validate_source_digest(source_digest)?;
    validate_source_digest(revision_digest)?;
    validate_tool_id(tool_id)?;
    let private_dir = plugin_private_dir(app)?;
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    let registry = read_registry_at(&private_dir)?;
    dependency_fingerprint(&registry, plugin_id)?;
    let record = registry
        .plugins
        .get(plugin_id)
        .ok_or_else(|| "插件未注册或已移除".to_string())?;
    if !record.enabled {
        return Err("插件已停用".to_string());
    }
    let revision = record
        .active
        .as_ref()
        .filter(|revision| {
            revision.source_digest == source_digest && revision.revision_digest == revision_digest
        })
        .ok_or_else(|| "插件活动版本摘要不匹配".to_string())?;
    ensure_native_execution_approved(revision)?;
    if revision
        .declared_tool_ids
        .binary_search_by(|candidate| candidate.as_str().cmp(tool_id))
        .is_err()
    {
        return Err("插件未声明该工具".to_string());
    }
    let source = read_verified_source_at(&private_dir, plugin_id, revision)?;
    Ok(PluginExecutionSource {
        runtime: revision.runtime.clone(),
        source,
        python_execution: revision.python_execution.get(tool_id).cloned(),
    })
}

/// 读写设置时一直持有注册表锁，让旧版本不能在切换之后落盘。
pub(crate) fn with_plugin_host_authority<R: Runtime, T>(
    app: &AppHandle<R>,
    identity: &crate::plugin_host_effects::PluginHostIdentity,
    operation: impl FnOnce(&Path, &PluginHostGrant) -> Result<T, String>,
) -> Result<T, String> {
    let private_dir = plugin_private_dir(app)?;
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    with_plugin_host_authority_at(&private_dir, identity, operation)
}

fn with_plugin_host_authority_at<T>(
    private_dir: &Path,
    identity: &crate::plugin_host_effects::PluginHostIdentity,
    operation: impl FnOnce(&Path, &PluginHostGrant) -> Result<T, String>,
) -> Result<T, String> {
    validate_plugin_id(&identity.plugin_id)?;
    validate_source_digest(&identity.source_digest)?;
    validate_source_digest(&identity.revision_digest)?;
    validate_tool_id(&identity.tool_id)?;
    let registry = read_registry_at(private_dir)?;
    dependency_fingerprint(&registry, &identity.plugin_id)?;
    let record = registry
        .plugins
        .get(&identity.plugin_id)
        .filter(|record| record.enabled)
        .ok_or_else(|| "插件未注册、已停用或已移除".to_string())?;
    let revision = record
        .active
        .as_ref()
        .filter(|revision| {
            revision.source_digest == identity.source_digest
                && revision.revision_digest == identity.revision_digest
        })
        .ok_or_else(|| "插件活动版本摘要不匹配".to_string())?;
    ensure_native_execution_approved(revision)?;
    if !revision.declared_tool_ids.contains(&identity.tool_id) {
        return Err("插件未声明该工具".to_string());
    }
    read_verified_source_at(private_dir, &identity.plugin_id, revision)?;
    operation(
        private_dir,
        &PluginHostGrant {
            permissions: revision.permissions.clone(),
            network_origins: revision.network_origins.clone(),
        },
    )
}

#[tauri::command]
pub async fn read_plugin_package_resource(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
    source_digest: String,
    revision_digest: String,
    resource_id: String,
    invocation_id: String,
    offset: usize,
    length: usize,
) -> Result<Vec<u8>, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    validate_source_digest(&source_digest)?;
    validate_source_digest(&revision_digest)?;
    validate_tool_id(&resource_id)?;
    if invocation_id.is_empty() || invocation_id.len() > 160 {
        return Err("插件调用 ID 无效".to_string());
    }
    if length == 0 || length > 256 * 1024 {
        return Err("插件包资源单次读取不能超过 256 KiB".to_string());
    }
    let private_dir = plugin_private_dir(&app)?;
    // 锁等待、磁盘读取和哈希都放到阻塞池，避免占住异步运行线程。
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = REGISTRY_LOCK
            .lock()
            .map_err(|_| "插件信任注册表锁异常".to_string())?;
        let registry = read_registry_at(&private_dir)?;
        dependency_fingerprint(&registry, &plugin_id)?;
        let record = registry
            .plugins
            .get(&plugin_id)
            .ok_or_else(|| "插件未注册或已移除".to_string())?;
        if !record.enabled {
            return Err("插件已停用".to_string());
        }
        let revision = record
            .active
            .as_ref()
            .filter(|revision| {
                revision.source_digest == source_digest
                    && revision.revision_digest == revision_digest
            })
            .ok_or_else(|| "插件活动 revision 摘要不匹配".to_string())?;
        if !revision
            .permissions
            .iter()
            .any(|permission| permission == "plugin.resources.read")
        {
            return Err("插件未声明 plugin.resources.read 权限".to_string());
        }
        let mut cache = verified_resource_cache()
            .lock()
            .map_err(|_| "插件资源缓存锁异常".to_string())?;
        let bytes =
            read_cached_resource_at(&private_dir, &plugin_id, revision, &resource_id, &mut cache)?;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "插件包资源读取范围无效".to_string())?;
        Ok(bytes[offset..end].to_vec())
    })
    .await
    .map_err(|_| "插件包资源读取任务失败".to_string())?
}

#[cfg(test)]
#[path = "registry/tests.rs"]
mod tests;
