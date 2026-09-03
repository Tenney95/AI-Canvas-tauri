//! 用户插件的原生信任注册表。
//!
//! Renderer 只能提交待暂存内容或不透明的插件 ID / 源码摘要；真正用于执行的源码快照、
//! runtime 与工具清单保存在 Rust 私有目录中。激活版本和上一版本采用原子注册表切换，
//! 插件执行前必须重新核对私有快照的 SHA-256。

use crate::path_policy::ensure_trusted_caller;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;

const REGISTRY_SCHEMA_VERSION: u32 = 1;
const PRIVATE_DIR_NAME: &str = "plugin-private";
const REGISTRY_FILE_NAME: &str = "registry.json";
const REGISTRY_TEMP_FILE_NAME: &str = "registry.json.tmp";
const REGISTRY_BACKUP_FILE_NAME: &str = "registry.json.bak";
const REVISIONS_DIR_NAME: &str = "revisions";
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
const SUPPORTED_PERMISSIONS: [&str; 8] = [
    "node.read",
    "node.write",
    "models.read",
    "models.invoke",
    "files.connected.read",
    "files.output.create",
    "plugin.resources.read",
    "ui.custom",
];

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginRevision {
    revision_digest: String,
    source_digest: String,
    version: String,
    runtime: String,
    entry: String,
    permissions: Vec<String>,
    declared_tool_ids: Vec<String>,
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
}

pub(crate) struct PluginExecutionSource {
    pub runtime: String,
    pub source: String,
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

fn source_digest(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

fn is_valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_scoped_id(value: &str, max_bytes: usize) -> bool {
    if value.is_empty() || value.len() > max_bytes || !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    bytes
        .first()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if !is_valid_scoped_id(plugin_id, MAX_PLUGIN_ID_BYTES) {
        return Err("插件 ID 无效".to_string());
    }
    Ok(())
}

fn validate_tool_id(tool_id: &str) -> Result<(), String> {
    if !is_valid_scoped_id(tool_id, MAX_TOOL_ID_BYTES) {
        return Err("插件工具 ID 无效".to_string());
    }
    Ok(())
}

fn validate_source_digest(value: &str) -> Result<(), String> {
    if !is_valid_digest(value) {
        return Err("插件源码摘要无效".to_string());
    }
    Ok(())
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} 必须是对象"))
}

fn required_string(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= max_bytes)
        .ok_or_else(|| format!("{label} 无效"))?;
    if value
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err(format!("{label} 包含非法字符"));
    }
    Ok(value.to_string())
}

fn string_list(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
    max_items: usize,
    max_bytes: usize,
) -> Result<Vec<String>, String> {
    let values = object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} 必须是数组"))?;
    if values.len() > max_items {
        return Err(format!("{label} 项目过多"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        let item = value
            .as_str()
            .map(str::trim)
            .filter(|item| !item.is_empty() && item.len() <= max_bytes)
            .ok_or_else(|| format!("{label} 包含无效项目"))?;
        if !item.is_ascii()
            || !item.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            })
        {
            return Err(format!("{label} 包含非法字符"));
        }
        unique.insert(item.to_string());
    }
    Ok(unique.into_iter().collect())
}

fn declared_tool_ids(contributes: &Map<String, Value>) -> Result<Vec<String>, String> {
    let mut ids = BTreeSet::new();
    for key in ["nodeTools", "nodes"] {
        let Some(value) = contributes.get(key) else {
            continue;
        };
        let items = value
            .as_array()
            .ok_or_else(|| format!("contributes.{key} 必须是数组"))?;
        for item in items {
            let entry = object(item, &format!("contributes.{key}[]"))?;
            let id = required_string(entry, "id", "插件工具 ID", MAX_TOOL_ID_BYTES)?;
            validate_tool_id(&id)?;
            ids.insert(id);
            if ids.len() > MAX_DECLARED_TOOL_IDS {
                return Err(format!("插件声明的工具不能超过 {MAX_DECLARED_TOOL_IDS} 个"));
            }
        }
    }
    if ids.is_empty() {
        return Err("插件至少需要声明一个工具或自定义节点".to_string());
    }
    Ok(ids.into_iter().collect())
}

/// 界面产物文件名只能是版本目录内的相对 .js 路径，杜绝 `..`、绝对路径与分隔符穿越。
fn validate_ui_entry(entry: &str) -> Result<(), String> {
    if entry.is_empty() || entry.len() > MAX_UI_ENTRY_BYTES {
        return Err("ui.entry 长度无效".to_string());
    }
    if !entry.ends_with(".js") {
        return Err("ui.entry 必须是 .js 文件".to_string());
    }
    if entry.starts_with('/') || entry.starts_with('\\') {
        return Err("ui.entry 不能是绝对路径".to_string());
    }
    let mut segments = entry.split('/').peekable();
    while let Some(segment) = segments.next() {
        if segment.is_empty() && segments.peek().is_some() {
            return Err("ui.entry 包含空路径段".to_string());
        }
        if segment == "." || segment == ".." {
            return Err("ui.entry 不能包含 . 或 .. 路径段".to_string());
        }
        if !segment.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        }) {
            return Err("ui.entry 包含非法字符".to_string());
        }
    }
    Ok(())
}

fn validate_ui_export_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_UI_EXPORT_KEY_BYTES {
        return Err("ui.exports 的键长度无效".to_string());
    }
    let mut characters = key.chars();
    let first = characters
        .next()
        .ok_or_else(|| "ui.exports 的键不能为空".to_string())?;
    if !first.is_ascii_alphabetic() {
        return Err("ui.exports 的键必须以字母开头".to_string());
    }
    if !characters.all(|character| character.is_ascii_alphanumeric() || character == '_') {
        return Err("ui.exports 的键只能包含字母、数字和下划线".to_string());
    }
    Ok(())
}

fn normalize_ui_integrity(value: &str) -> Option<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let hex = trimmed.strip_prefix("sha256-").unwrap_or(&trimmed);
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex.to_string())
}

fn validate_package_resource_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 255 || path.starts_with('/') || path.starts_with('\\') {
        return Err("插件包资源路径无效".to_string());
    }
    for segment in path.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || !segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
        {
            return Err("插件包资源路径不安全".to_string());
        }
    }
    Ok(())
}

fn parse_package_resources(
    root: &Map<String, Value>,
    permissions: &[String],
    payloads: &[PluginPackageResourcePayload],
) -> Result<Vec<PluginPackageResource>, String> {
    let declarations = match root.get("resources") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| "resources 必须是数组".to_string())?,
        None => {
            if !payloads.is_empty() {
                return Err("插件未声明 resources 却提交了资源字节".to_string());
            }
            return Ok(Vec::new());
        }
    };
    if declarations.is_empty() || declarations.len() > MAX_PACKAGE_RESOURCES {
        return Err(format!("resources 需要 1-{MAX_PACKAGE_RESOURCES} 项"));
    }
    if !permissions
        .iter()
        .any(|item| item == "plugin.resources.read")
    {
        return Err("声明 resources 必须包含 plugin.resources.read 权限".to_string());
    }
    if payloads.len() != declarations.len() {
        return Err("插件包资源声明与提交字节数量不一致".to_string());
    }
    let payload_by_id: BTreeMap<&str, &[u8]> = payloads
        .iter()
        .map(|payload| (payload.id.as_str(), payload.bytes.as_slice()))
        .collect();
    if payload_by_id.len() != payloads.len() {
        return Err("插件包资源字节包含重复 ID".to_string());
    }

    let mut seen_ids = BTreeSet::new();
    let mut seen_paths = BTreeSet::new();
    let mut total_bytes = 0usize;
    let mut resources = Vec::with_capacity(declarations.len());
    for value in declarations {
        let declaration = object(value, "resources[]")?;
        let id = required_string(declaration, "id", "资源 ID", MAX_TOOL_ID_BYTES)?;
        validate_tool_id(&id)?;
        if !seen_ids.insert(id.clone()) {
            return Err("resources 包含重复 ID".to_string());
        }
        let path = required_string(declaration, "path", "资源路径", 255)?;
        validate_package_resource_path(&path)?;
        if !seen_paths.insert(path.clone()) {
            return Err("resources 包含重复路径".to_string());
        }
        let digest = normalize_ui_integrity(&required_string(
            declaration,
            "integrity",
            "资源 integrity",
            128,
        )?)
        .ok_or_else(|| "资源 integrity 必须是 sha256 摘要".to_string())?;
        let media_type = required_string(declaration, "mediaType", "资源 mediaType", 128)?;
        if !media_type.is_ascii() || !media_type.contains('/') {
            return Err("资源 mediaType 无效".to_string());
        }
        let bytes = declaration
            .get("bytes")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0 && *value <= MAX_PACKAGE_RESOURCE_BYTES)
            .ok_or_else(|| "插件包资源大小无效或超过 16 MiB".to_string())?;
        total_bytes = total_bytes
            .checked_add(bytes)
            .filter(|value| *value <= MAX_PACKAGE_TOTAL_BYTES)
            .ok_or_else(|| "插件包资源总大小超过 64 MiB".to_string())?;
        let payload = payload_by_id
            .get(id.as_str())
            .ok_or_else(|| format!("插件包资源 {id} 缺少字节"))?;
        if payload.len() != bytes {
            return Err(format!("插件包资源 {id} 字节数不匹配"));
        }
        if format!("{:x}", Sha256::digest(payload)) != digest {
            return Err(format!("插件包资源 {id} 摘要不匹配"));
        }
        resources.push(PluginPackageResource {
            id,
            path,
            digest,
            media_type,
            bytes,
        });
    }
    resources.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(resources)
}

fn revision_digest(
    manifest: &Value,
    source: &str,
    ui_source: Option<&str>,
    resources: &[PluginPackageResource],
    payloads: &[PluginPackageResourcePayload],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(b"ai-canvas-plugin-revision-v1\0");
    hasher
        .update(serde_json::to_vec(manifest).map_err(|_| "插件 Manifest 无法序列化".to_string())?);
    hasher.update(b"\0source\0");
    hasher.update(source.as_bytes());
    hasher.update(b"\0ui\0");
    hasher.update(ui_source.unwrap_or_default().as_bytes());
    let payload_by_id: BTreeMap<&str, &[u8]> = payloads
        .iter()
        .map(|payload| (payload.id.as_str(), payload.bytes.as_slice()))
        .collect();
    for resource in resources {
        hasher.update(b"\0resource\0");
        hasher.update(resource.id.as_bytes());
        hasher.update(b"\0");
        hasher.update(resource.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(
            payload_by_id
                .get(resource.id.as_str())
                .ok_or_else(|| format!("插件包资源 {} 缺少字节", resource.id))?,
        );
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 解析 manifest.ui，并当场核对产物摘要。
///
/// 界面代码虽然跑在主窗口内的 sandboxed iframe 中，却仍属于本应用，因此这里比入口源码更严格：
/// 必须显式声明 ui.custom，且产物必须与 integrity 逐字节一致。
fn parse_ui_declaration(
    root: &Map<String, Value>,
    permissions: &[String],
    ui_source: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let Some(ui) = root.get("ui") else {
        if ui_source.is_some() {
            return Err("插件未提供 manifest.ui 却上传了界面产物".to_string());
        }
        return Ok((None, None));
    };
    if !permissions.iter().any(|item| item == "ui.custom") {
        return Err("声明 manifest.ui 的插件必须声明 ui.custom 权限".to_string());
    }
    let ui_object = object(ui, "ui")?;
    let entry = required_string(ui_object, "entry", "ui.entry", MAX_UI_ENTRY_BYTES)?;
    validate_ui_entry(&entry)?;
    let declared = required_string(ui_object, "integrity", "ui.integrity", 128)?;
    let expected = normalize_ui_integrity(&declared)
        .ok_or_else(|| "ui.integrity 必须是 sha256 摘要".to_string())?;
    let exports = object(
        ui_object
            .get("exports")
            .ok_or_else(|| "插件缺少 ui.exports".to_string())?,
        "ui.exports",
    )?;
    if exports.is_empty() || exports.len() > MAX_UI_EXPORTS {
        return Err(format!("ui.exports 需要 1-{MAX_UI_EXPORTS} 项"));
    }
    for key in exports.keys() {
        validate_ui_export_key(key)?;
    }
    let source = ui_source.ok_or_else(|| "插件声明了 manifest.ui 但缺少界面产物".to_string())?;
    if source.is_empty() || source.len() > MAX_UI_SOURCE_BYTES {
        return Err("插件界面产物为空或超过 2 MiB 上限".to_string());
    }
    let actual = format!("{:x}", Sha256::digest(source.as_bytes()));
    if actual != expected {
        return Err("插件界面产物与 ui.integrity 不一致".to_string());
    }
    Ok((Some(expected), Some(entry)))
}

fn parse_revision_with_resources(
    manifest: &Value,
    source: &str,
    ui_source: Option<&str>,
    resource_payloads: &[PluginPackageResourcePayload],
) -> Result<(String, PluginRevision), String> {
    let manifest_size = serde_json::to_vec(manifest)
        .map_err(|_| "插件 Manifest 无法序列化".to_string())?
        .len();
    if manifest_size > MAX_MANIFEST_BYTES {
        return Err("插件 Manifest 超过 64 KiB 上限".to_string());
    }
    if source.is_empty() || source.len() > MAX_SOURCE_BYTES {
        return Err("插件源码为空或超过 512 KiB 上限".to_string());
    }
    let root = object(manifest, "manifest")?;
    let plugin_id = required_string(root, "id", "插件 ID", MAX_PLUGIN_ID_BYTES)?;
    validate_plugin_id(&plugin_id)?;
    let version = required_string(root, "version", "插件版本", MAX_VERSION_BYTES)?;
    root.get("apiVersion")
        .and_then(Value::as_u64)
        .filter(|value| *value == 1)
        .ok_or_else(|| "插件 apiVersion 无效".to_string())?;
    let runtime = root
        .get("runtime")
        .and_then(Value::as_str)
        .unwrap_or("javascript")
        .trim()
        .to_string();
    if runtime != "javascript" && runtime != "python" {
        return Err("插件 runtime 仅支持 javascript 或 python".to_string());
    }
    let entry = required_string(root, "entry", "插件入口", 32)?;
    match (runtime.as_str(), entry.as_str()) {
        ("javascript", "main.js") | ("python", "main.py") => {}
        _ => return Err("插件 apiVersion、runtime 与 entry 不匹配".to_string()),
    }
    let permissions = string_list(
        root,
        "permissions",
        "插件权限",
        MAX_PERMISSION_COUNT,
        MAX_PERMISSION_BYTES,
    )?;
    if permissions
        .iter()
        .any(|permission| !SUPPORTED_PERMISSIONS.contains(&permission.as_str()))
    {
        return Err("插件声明了不支持的权限".to_string());
    }
    if permissions
        .binary_search(&"models.invoke".to_string())
        .is_ok()
        && permissions
            .binary_search(&"models.read".to_string())
            .is_err()
    {
        return Err("models.invoke 必须与 models.read 一起声明".to_string());
    }
    let contributes = object(
        root.get("contributes")
            .ok_or_else(|| "插件缺少 contributes".to_string())?,
        "contributes",
    )?;
    let declared_tool_ids = declared_tool_ids(contributes)?;
    let (ui_digest, ui_entry) = parse_ui_declaration(root, &permissions, ui_source)?;
    let resources = parse_package_resources(root, &permissions, resource_payloads)?;
    let revision_digest =
        revision_digest(manifest, source, ui_source, &resources, resource_payloads)?;
    Ok((
        plugin_id,
        PluginRevision {
            revision_digest,
            source_digest: source_digest(source),
            version,
            runtime,
            entry,
            permissions,
            declared_tool_ids,
            native_approved: false,
            ui_digest,
            ui_entry,
            resources,
            staged_at: unix_now_millis(),
        },
    ))
}

#[cfg(test)]
fn parse_revision(
    manifest: &Value,
    source: &str,
    ui_source: Option<&str>,
) -> Result<(String, PluginRevision), String> {
    parse_revision_with_resources(manifest, source, ui_source, &[])
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
    NativeApprovalPrompt {
        title,
        message: format!(
            "{action_text}。\n\n\
插件 ID：{plugin_id}\n\
版本：{}\n\
运行时：{}\n\
代码 SHA-256：{}\n\
声明的宿主权限：{permissions}{python_risk}{ui_risk}\n\n\
只有在你已经审阅并信任上述完整 64 位 SHA-256 对应的源码时，才{final_action}。",
            revision.version, revision.runtime, revision.source_digest
        ),
        approve_label,
        cancel_label: "取消".to_string(),
    }
}

/// 需要原生确认的高风险特征：可信 Python（本机权限）或自定义界面（在应用内运行界面代码）。
fn revision_requests_native_approval(revision: &PluginRevision) -> bool {
    revision.runtime == "python" || revision.permissions.iter().any(|item| item == "ui.custom")
}

fn native_stage_decision(revision: &PluginRevision, approval: Option<bool>) -> bool {
    if revision_requests_native_approval(revision) {
        return approval == Some(true);
    }
    revision.runtime == "javascript"
}

async fn request_python_revision_approval(
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
    .map_err(|_| "无法显示 Python 插件原生授权确认".to_string())?;
    Ok(approved)
}

pub(crate) fn plugin_private_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(PRIVATE_DIR_NAME))
        .map_err(|_| "无法定位插件私有数据目录".to_string())
}

fn simplify_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().into_owned();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(
                rest.strip_prefix(r"UNC\")
                    .map_or_else(|| rest.to_string(), |unc| format!(r"\\{unc}")),
            );
        }
    }
    path
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
    plugin_private_dir(app)
        .map(|directory| is_under_plugin_private_dir(&directory, resolved))
        .unwrap_or(false)
}

pub(crate) fn is_plugin_private_path_overlap<R: Runtime>(
    app: &AppHandle<R>,
    resolved: &Path,
) -> bool {
    plugin_private_dir(app)
        .map(|directory| plugin_private_paths_overlap(&directory, resolved))
        .unwrap_or(false)
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "无法创建插件私有数据目录".to_string())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "插件私有数据目录不可用".to_string())?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("插件私有数据目录不安全".to_string());
    }
    Ok(())
}

fn registry_file(private_dir: &Path) -> PathBuf {
    private_dir.join(REGISTRY_FILE_NAME)
}

fn registry_temp_file(private_dir: &Path) -> PathBuf {
    private_dir.join(REGISTRY_TEMP_FILE_NAME)
}

fn registry_backup_file(private_dir: &Path) -> PathBuf {
    private_dir.join(REGISTRY_BACKUP_FILE_NAME)
}

fn validate_stored_revision(revision: &PluginRevision) -> Result<(), String> {
    validate_source_digest(&revision.revision_digest)?;
    validate_source_digest(&revision.source_digest)?;
    if revision.version.is_empty()
        || revision.version.len() > MAX_VERSION_BYTES
        || revision
            .version
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err("插件信任注册表包含无效版本".to_string());
    }
    match (revision.runtime.as_str(), revision.entry.as_str()) {
        ("javascript", "main.js") | ("python", "main.py") => {}
        _ => return Err("插件信任注册表包含无效运行时".to_string()),
    }
    if revision.runtime == "javascript" && revision.native_approved {
        return Err("JavaScript 插件不能携带 Python 原生授权标记".to_string());
    }
    if revision.permissions.len() > MAX_PERMISSION_COUNT
        || revision
            .permissions
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || revision.permissions.iter().any(|permission| {
            permission.len() > MAX_PERMISSION_BYTES
                || !SUPPORTED_PERMISSIONS.contains(&permission.as_str())
        })
    {
        return Err("插件信任注册表包含无效权限".to_string());
    }
    if revision
        .permissions
        .binary_search(&"models.invoke".to_string())
        .is_ok()
        && revision
            .permissions
            .binary_search(&"models.read".to_string())
            .is_err()
    {
        return Err("插件信任注册表包含无效权限组合".to_string());
    }
    if revision.declared_tool_ids.is_empty()
        || revision.declared_tool_ids.len() > MAX_DECLARED_TOOL_IDS
        || revision
            .declared_tool_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err("插件信任注册表包含无效工具清单".to_string());
    }
    for tool_id in &revision.declared_tool_ids {
        validate_tool_id(tool_id)?;
    }
    if revision.resources.len() > MAX_PACKAGE_RESOURCES
        || revision
            .resources
            .windows(2)
            .any(|pair| pair[0].id >= pair[1].id)
    {
        return Err("插件信任注册表包含无效资源清单".to_string());
    }
    let mut total_bytes = 0usize;
    for resource in &revision.resources {
        validate_tool_id(&resource.id)?;
        validate_package_resource_path(&resource.path)?;
        validate_source_digest(&resource.digest)?;
        if resource.media_type.is_empty()
            || !resource.media_type.is_ascii()
            || !resource.media_type.contains('/')
            || resource.bytes == 0
            || resource.bytes > MAX_PACKAGE_RESOURCE_BYTES
        {
            return Err("插件信任注册表包含无效资源声明".to_string());
        }
        total_bytes = total_bytes
            .checked_add(resource.bytes)
            .filter(|value| *value <= MAX_PACKAGE_TOTAL_BYTES)
            .ok_or_else(|| "插件信任注册表资源总大小无效".to_string())?;
    }
    Ok(())
}

fn validate_registry(registry: &PluginRegistry) -> Result<(), String> {
    if registry.schema_version != REGISTRY_SCHEMA_VERSION {
        return Err("插件信任注册表版本不受支持".to_string());
    }
    if registry.plugins.len() > MAX_PLUGIN_REGISTRATIONS {
        return Err("插件信任注册表项目过多".to_string());
    }
    for (plugin_id, registration) in &registry.plugins {
        validate_plugin_id(plugin_id)?;
        if registration.plugin_id != *plugin_id {
            return Err("插件信任注册表身份不一致".to_string());
        }
        if registration.enabled && registration.active.is_none() {
            return Err("插件信任注册表启用状态无效".to_string());
        }
        for revision in [
            &registration.active,
            &registration.previous,
            &registration.staged,
        ]
        .into_iter()
        .flatten()
        {
            validate_stored_revision(revision)?;
        }
    }
    Ok(())
}

fn read_registry_file(path: &Path) -> Result<Option<PluginRegistry>, String> {
    match fs::symlink_metadata(&path) {
        Ok(metadata)
            if !metadata.file_type().is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_REGISTRY_BYTES =>
        {
            return Err("插件信任注册表不安全或超过大小限制".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(_) => return Err("无法读取插件信任注册表".to_string()),
    }
    match fs::read(path) {
        Ok(bytes) => {
            let registry = serde_json::from_slice::<PluginRegistry>(&bytes)
                .map_err(|_| "插件信任注册表损坏".to_string())?;
            validate_registry(&registry)?;
            Ok(Some(registry))
        }
        Err(_) => Err("无法读取插件信任注册表".to_string()),
    }
}

fn discard_uncommitted_file(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        let _ = fs::remove_file(path);
    }
}

fn restore_registry_backup(
    private_dir: &Path,
    registry: PluginRegistry,
) -> Result<PluginRegistry, String> {
    let primary = registry_file(private_dir);
    let backup = registry_backup_file(private_dir);
    match fs::symlink_metadata(&primary) {
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(&primary).map_err(|_| "无法移除损坏的插件信任注册表".to_string())?;
        }
        Ok(_) => return Err("插件信任注册表路径不安全".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法恢复插件信任注册表".to_string()),
    }
    fs::rename(&backup, &primary).map_err(|_| "无法恢复插件信任注册表备份".to_string())?;
    discard_uncommitted_file(&registry_temp_file(private_dir));
    Ok(registry)
}

fn read_registry_at(private_dir: &Path) -> Result<PluginRegistry, String> {
    let primary = registry_file(private_dir);
    let backup = registry_backup_file(private_dir);
    let temporary = registry_temp_file(private_dir);
    match read_registry_file(&primary) {
        Ok(Some(registry)) => {
            // primary 已完成原子提交；残留 backup/tmp 都属于上一次已结束或未提交事务。
            discard_uncommitted_file(&backup);
            discard_uncommitted_file(&temporary);
            Ok(registry)
        }
        Ok(None) => match read_registry_file(&backup) {
            Ok(Some(registry)) => restore_registry_backup(private_dir, registry),
            Ok(None) => {
                // 首次写入在 rename 前崩溃时只有 tmp；tmp 从不视作已提交状态。
                discard_uncommitted_file(&temporary);
                Ok(PluginRegistry::default())
            }
            Err(error) => Err(error),
        },
        Err(primary_error) => match read_registry_file(&backup) {
            Ok(Some(registry)) => restore_registry_backup(private_dir, registry),
            Ok(None) => Err(primary_error),
            Err(_) => Err("插件信任注册表及备份均损坏".to_string()),
        },
    }
}

fn write_registry_at(private_dir: &Path, registry: &PluginRegistry) -> Result<(), String> {
    ensure_private_directory(private_dir)?;
    validate_registry(registry)?;
    let file = registry_file(private_dir);
    let temporary = registry_temp_file(private_dir);
    let backup = registry_backup_file(private_dir);
    let body = serde_json::to_vec(registry).map_err(|_| "无法序列化插件信任注册表".to_string())?;
    if body.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("插件信任注册表超过大小限制".to_string());
    }
    fs::write(&temporary, body).map_err(|_| "无法写入插件信任注册表".to_string())?;

    if !file.exists() {
        return fs::rename(&temporary, &file).map_err(|_| "无法提交插件信任注册表".to_string());
    }

    let _ = fs::remove_file(&backup);
    fs::rename(&file, &backup).map_err(|_| "无法准备插件信任注册表更新".to_string())?;
    if fs::rename(&temporary, &file).is_err() {
        let _ = fs::rename(&backup, &file);
        let _ = fs::remove_file(&temporary);
        return Err("无法提交插件信任注册表".to_string());
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn revision_directory(private_dir: &Path, plugin_id: &str, digest: &str) -> PathBuf {
    private_dir
        .join(REVISIONS_DIR_NAME)
        .join(plugin_id)
        .join(digest)
}

fn revision_file(private_dir: &Path, plugin_id: &str, revision: &PluginRevision) -> PathBuf {
    revision_directory(private_dir, plugin_id, &revision.revision_digest).join(&revision.entry)
}

fn read_verified_source_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
) -> Result<String, String> {
    let path = revision_file(private_dir, plugin_id, revision);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "插件源码快照不存在".to_string())?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_SOURCE_BYTES
    {
        return Err("插件源码快照不安全或超过大小限制".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取插件源码快照".to_string())?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != revision.source_digest {
        return Err("插件源码快照摘要不匹配".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "插件源码快照不是 UTF-8".to_string())
}

fn write_source_snapshot_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    source: &str,
) -> Result<bool, String> {
    let directory = revision_directory(private_dir, plugin_id, &revision.revision_digest);
    ensure_private_directory(&directory)?;
    let target = directory.join(&revision.entry);
    if target.exists() {
        let existing = read_verified_source_at(private_dir, plugin_id, revision)?;
        if existing != source {
            return Err("插件源码摘要冲突".to_string());
        }
        return Ok(false);
    }
    let temporary = directory.join(format!("{}.tmp", revision.entry));
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, source.as_bytes()).map_err(|_| "无法写入插件源码快照".to_string())?;
    fs::rename(&temporary, &target).map_err(|_| "无法提交插件源码快照".to_string())?;
    let _ = read_verified_source_at(private_dir, plugin_id, revision)?;
    Ok(true)
}

fn resource_snapshot_path(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    resource_id: &str,
) -> PathBuf {
    revision_directory(private_dir, plugin_id, &revision.revision_digest)
        .join("resources")
        .join(format!("{resource_id}.bin"))
}

fn write_resource_snapshots_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    payloads: &[PluginPackageResourcePayload],
) -> Result<(), String> {
    if revision.resources.is_empty() {
        return Ok(());
    }
    let directory =
        revision_directory(private_dir, plugin_id, &revision.revision_digest).join("resources");
    ensure_private_directory(&directory)?;
    let payload_by_id: BTreeMap<&str, &[u8]> = payloads
        .iter()
        .map(|payload| (payload.id.as_str(), payload.bytes.as_slice()))
        .collect();
    for resource in &revision.resources {
        let bytes = payload_by_id
            .get(resource.id.as_str())
            .ok_or_else(|| format!("插件包资源 {} 缺少字节", resource.id))?;
        let target = resource_snapshot_path(private_dir, plugin_id, revision, &resource.id);
        if target.exists() {
            let existing = fs::read(&target).map_err(|_| "无法读取插件包资源快照".to_string())?;
            if existing.as_slice() != *bytes {
                return Err("插件包资源摘要目录发生内容冲突".to_string());
            }
            continue;
        }
        let temporary = target.with_extension("bin.tmp");
        let _ = fs::remove_file(&temporary);
        fs::write(&temporary, bytes).map_err(|_| "无法写入插件包资源快照".to_string())?;
        fs::rename(&temporary, &target).map_err(|_| "无法提交插件包资源快照".to_string())?;
    }
    Ok(())
}

fn read_verified_resource_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    resource_id: &str,
) -> Result<Vec<u8>, String> {
    let resource = revision
        .resources
        .iter()
        .find(|resource| resource.id == resource_id)
        .ok_or_else(|| "插件包资源未在当前 revision 声明".to_string())?;
    let path = resource_snapshot_path(private_dir, plugin_id, revision, resource_id);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "插件包资源快照不存在".to_string())?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize != resource.bytes
    {
        return Err("插件包资源快照不安全或大小不匹配".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取插件包资源快照".to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != resource.digest {
        return Err("插件包资源快照摘要不匹配".to_string());
    }
    Ok(bytes)
}

/// UI 产物按摘要内容寻址，与入口源码目录彻底分离。
/// 这样「仅更新 UI、主源码不变」时不会覆盖活动版本的 UI 文件，也不会让
/// active/previous/staged 因共享 source_digest 而产生回滚歧义。
fn ui_directory(private_dir: &Path, plugin_id: &str) -> PathBuf {
    private_dir.join("ui-revisions").join(plugin_id)
}

fn ui_snapshot_path(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
) -> Option<PathBuf> {
    let digest = revision.ui_digest.as_deref()?;
    Some(ui_directory(private_dir, plugin_id).join(format!("{digest}.js")))
}

fn write_ui_snapshot_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    ui_source: &str,
) -> Result<(), String> {
    let Some(digest) = revision.ui_digest.as_deref() else {
        return Ok(());
    };
    let directory = ui_directory(private_dir, plugin_id);
    ensure_private_directory(&directory)?;
    let target = directory.join(format!("{digest}.js"));
    if target.exists() {
        // 内容寻址：同一摘要的字节必然一致，直接复用，绝不覆盖其它版本。
        return Ok(());
    }
    let temporary = directory.join(format!("{digest}.js.tmp"));
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, ui_source.as_bytes()).map_err(|_| "无法写入插件界面产物".to_string())?;
    fs::rename(&temporary, &target).map_err(|_| "无法提交插件界面产物".to_string())?;
    Ok(())
}

/// 读取界面产物时重新核对摘要：磁盘上的文件可能被用户或其他程序改动过。
fn read_verified_ui_source_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
) -> Result<Option<String>, String> {
    let Some(expected) = revision.ui_digest.as_deref() else {
        return Ok(None);
    };
    let Some(path) = ui_snapshot_path(private_dir, plugin_id, revision) else {
        return Ok(None);
    };
    let metadata = fs::symlink_metadata(&path).map_err(|_| "插件界面产物不存在".to_string())?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() as usize > MAX_UI_SOURCE_BYTES
    {
        return Err("插件界面产物不安全或超过大小限制".to_string());
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取插件界面产物".to_string())?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err("插件界面产物摘要不匹配".to_string());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "插件界面产物不是 UTF-8".to_string())
}

/// 供 plugin-ui 协议使用：取出已启用插件当前版本的界面产物。
///
/// 校验链与执行入口源码一致——必须已启用、活动版本的 ui_digest 与请求一致、
/// 确实声明了 ui.custom，且磁盘字节摘要逐字匹配。
pub(crate) fn read_active_ui_source(
    private_dir: &Path,
    plugin_id: &str,
    ui_digest: &str,
) -> Result<String, String> {
    validate_plugin_id(plugin_id)?;
    validate_source_digest(ui_digest)?;
    let registry = read_registry_at(private_dir)?;
    let record = registry
        .plugins
        .get(plugin_id)
        .ok_or_else(|| "插件未安装".to_string())?;
    if !record.enabled {
        return Err("插件已停用".to_string());
    }
    let active = record
        .active
        .as_ref()
        .ok_or_else(|| "插件没有已激活版本".to_string())?;
    if active.ui_digest.as_deref() != Some(ui_digest) {
        return Err("插件界面摘要与活动版本不一致".to_string());
    }
    if !active.permissions.iter().any(|item| item == "ui.custom") {
        return Err("插件未声明 ui.custom 权限".to_string());
    }
    read_verified_ui_source_at(private_dir, plugin_id, active)?
        .ok_or_else(|| "插件界面产物缺失".to_string())
}

fn remove_revision_snapshot(private_dir: &Path, plugin_id: &str, revision: &PluginRevision) {
    let directory = revision_directory(private_dir, plugin_id, &revision.revision_digest);
    let _ = fs::remove_dir_all(directory);
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
    }
}

fn matching_revision<'a>(
    record: &'a PluginRegistration,
    digest: &str,
) -> Option<&'a PluginRevision> {
    [&record.active, &record.previous, &record.staged]
        .into_iter()
        .flatten()
        .find(|revision| revision.revision_digest == digest)
}

fn revision_security_manifest_matches(left: &PluginRevision, right: &PluginRevision) -> bool {
    left.revision_digest == right.revision_digest
        && left.source_digest == right.source_digest
        && left.version == right.version
        && left.runtime == right.runtime
        && left.entry == right.entry
        && left.permissions == right.permissions
        && left.declared_tool_ids == right.declared_tool_ids
        && left.ui_digest == right.ui_digest
        && left.ui_entry == right.ui_entry
        && left.resources == right.resources
}

fn activation_candidate<'a>(
    record: &'a PluginRegistration,
    digest: &str,
) -> Option<(RevisionSlot, &'a PluginRevision)> {
    // staged 优先：同摘要重新 stage 已经过本轮原生确认，激活时不应被 active 抢先匹配。
    [
        (RevisionSlot::Staged, &record.staged),
        (RevisionSlot::Active, &record.active),
        (RevisionSlot::Previous, &record.previous),
    ]
    .into_iter()
    .find_map(|(slot, revision)| {
        revision
            .as_ref()
            .filter(|item| item.revision_digest == digest)
            .map(|item| (slot, item))
    })
}

fn revision_in_slot_mut(
    record: &mut PluginRegistration,
    slot: RevisionSlot,
) -> Option<&mut PluginRevision> {
    match slot {
        RevisionSlot::Active => record.active.as_mut(),
        RevisionSlot::Previous => record.previous.as_mut(),
        RevisionSlot::Staged => record.staged.as_mut(),
    }
}

fn activation_requires_native_approval(
    record: &PluginRegistration,
    slot: RevisionSlot,
    candidate: &PluginRevision,
    enabled: bool,
) -> bool {
    if !enabled || !revision_requests_native_approval(candidate) {
        return false;
    }
    match slot {
        // staged 只有带原生批准标记才免重复；未批准或异常记录仍需确认。
        RevisionSlot::Staged => !candidate.native_approved,
        // 回滚会改变真实执行代码，即使插件当前已启用也必须重新确认。
        RevisionSlot::Previous => true,
        // active + enabled 是 no-op；从 disabled 重新启用则必须确认。
        RevisionSlot::Active => !record.enabled,
    }
}

fn set_enabled_requires_native_approval(record: &PluginRegistration, enabled: bool) -> bool {
    enabled
        && !record.enabled
        && record
            .active
            .as_ref()
            .is_some_and(revision_requests_native_approval)
}

fn activation_approval_snapshot_matches(
    current: &PluginRegistration,
    expected: &PluginRegistration,
    expected_slot: RevisionSlot,
    digest: &str,
    candidate: &PluginRevision,
) -> bool {
    current == expected
        && activation_candidate(current, digest)
            .is_some_and(|(slot, revision)| slot == expected_slot && revision == candidate)
}

fn enable_approval_snapshot_matches(
    current: &PluginRegistration,
    expected: &PluginRegistration,
    candidate: &PluginRevision,
    enabled: bool,
) -> bool {
    current == expected
        && current.active.as_ref() == Some(candidate)
        && set_enabled_requires_native_approval(current, enabled)
}

fn switch_active_revision(
    record: &mut PluginRegistration,
    digest: &str,
) -> Result<Vec<PluginRevision>, String> {
    let mut discarded = Vec::new();
    if record
        .active
        .as_ref()
        .is_some_and(|revision| revision.revision_digest == digest)
    {
        if record
            .staged
            .as_ref()
            .is_some_and(|revision| revision.revision_digest == digest)
        {
            // 同摘要重新 stage 可能刚建立 native approval；用 staged 覆盖 active 以保留该标记。
            record.active = record.staged.take();
        } else if let Some(staged) = record.staged.take() {
            // Store 用当前 active 摘要做补偿回滚时，未激活的另一版本不应继续残留。
            // 返回 discarded 交给提交后的既有快照清理流程处理。
            discarded.push(staged);
        }
    } else if record
        .staged
        .as_ref()
        .is_some_and(|revision| revision.revision_digest == digest)
    {
        let next = record.staged.take().expect("已确认暂存版本存在");
        if let Some(old_previous) = record.previous.take() {
            discarded.push(old_previous);
        }
        record.previous = record.active.take();
        record.active = Some(next);
    } else if record
        .previous
        .as_ref()
        .is_some_and(|revision| revision.revision_digest == digest)
    {
        let previous = record.previous.take().expect("已确认上一版本存在");
        let active = record.active.replace(previous);
        record.previous = active;
        if let Some(staged) = record.staged.take() {
            discarded.push(staged);
        }
    } else {
        return Err("指定插件版本未暂存，也不是可回滚版本".to_string());
    }
    Ok(discarded)
}

fn activation_requires_cancel(
    active_digest_before: Option<&str>,
    next_digest: &str,
    enabled: bool,
) -> bool {
    !enabled || active_digest_before.is_some_and(|digest| digest != next_digest)
}

/// 调用方必须已经成功提交注册表，并且仍持有 `REGISTRY_LOCK`。
///
/// 取消动作也在线性化区间内完成，防止锁释放后同 ID 新版本先启动、再被旧事务误取消。
/// `cancel_plugin_invocations` 只短暂持有 invocation map；Python 注册流程释放该 map 后才会
/// 再读取注册表，因此这里采用 registry -> invocation 的锁顺序不会形成反向等待。
fn cancel_committed_plugin_invocations(plugin_id: &str) {
    crate::plugin_runtime::cancel_plugin_invocations(plugin_id);
}

fn ensure_native_execution_approved(revision: &PluginRevision) -> Result<(), String> {
    if revision_requests_native_approval(revision) && !revision.native_approved {
        return Err("插件尚未完成原生高风险授权，请停用后重新启用".to_string());
    }
    Ok(())
}

fn commit_activation_at(
    private_dir: &Path,
    registry: &mut PluginRegistry,
    plugin_id: &str,
    revision_digest: &str,
    enabled: bool,
    native_approval_granted: bool,
) -> Result<PluginRegistrationStatus, String> {
    let record = registry
        .plugins
        .get_mut(plugin_id)
        .ok_or_else(|| "插件尚未暂存或已移除".to_string())?;
    let cancel_after_activation = activation_requires_cancel(
        record
            .active
            .as_ref()
            .map(|revision| revision.revision_digest.as_str()),
        revision_digest,
        enabled,
    );
    let (slot, approval_required) = {
        let (slot, candidate) = activation_candidate(record, revision_digest)
            .ok_or_else(|| "指定插件版本未暂存，也不是可回滚版本".to_string())?;
        let _ = read_verified_source_at(private_dir, plugin_id, candidate)?;
        (
            slot,
            activation_requires_native_approval(record, slot, candidate, enabled),
        )
    };
    if approval_required && !native_approval_granted {
        return Err("启用该 Python 插件版本前必须完成原生高风险授权".to_string());
    }
    if native_approval_granted {
        let candidate = revision_in_slot_mut(record, slot)
            .filter(|revision| revision.revision_digest == revision_digest)
            .ok_or_else(|| "插件候选版本已变化，请重新操作".to_string())?;
        if !revision_requests_native_approval(candidate) {
            return Err("该插件不需要原生高风险授权".to_string());
        }
        candidate.native_approved = true;
    }
    let discarded = switch_active_revision(record, revision_digest)?;
    record.enabled = enabled;
    record.updated_at = unix_now_millis();
    write_registry_at(private_dir, registry)?;
    let current = registry.plugins.get(plugin_id).expect("插件记录刚写入");
    for revision in discarded {
        if !revision_is_referenced(current, &revision.revision_digest) {
            remove_revision_snapshot(private_dir, plugin_id, &revision);
        }
    }
    let status = status_for(plugin_id, Some(current));
    if cancel_after_activation {
        cancel_committed_plugin_invocations(plugin_id);
    }
    Ok(status)
}

fn commit_enabled_at(
    private_dir: &Path,
    registry: &mut PluginRegistry,
    plugin_id: &str,
    enabled: bool,
    native_approval_granted: bool,
) -> Result<PluginRegistrationStatus, String> {
    let record = registry
        .plugins
        .get_mut(plugin_id)
        .ok_or_else(|| "插件未注册".to_string())?;
    let approval_required = set_enabled_requires_native_approval(record, enabled);
    if enabled {
        let active = record
            .active
            .as_ref()
            .ok_or_else(|| "插件没有可启用的活动版本".to_string())?;
        let _ = read_verified_source_at(private_dir, plugin_id, active)?;
    }
    if approval_required && !native_approval_granted {
        return Err("重新启用 Python 插件前必须完成原生高风险授权".to_string());
    }
    if native_approval_granted {
        let active = record
            .active
            .as_mut()
            .ok_or_else(|| "插件没有可授权的活动版本".to_string())?;
        if !revision_requests_native_approval(active) {
            return Err("该插件不需要原生高风险授权".to_string());
        }
        active.native_approved = true;
    }
    record.enabled = enabled;
    record.updated_at = unix_now_millis();
    write_registry_at(private_dir, registry)?;
    if !enabled {
        cancel_committed_plugin_invocations(plugin_id);
    }
    Ok(status_for(plugin_id, registry.plugins.get(plugin_id)))
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
    let Ok(directory) = plugin_private_dir(app) else {
        return;
    };
    if let Err(error) = app.fs_scope().forbid_directory(&directory, true) {
        eprintln!("[plugin-registry] 无法从 fs scope 拒绝插件私有目录: {error}");
    }
    if let Err(error) = app
        .asset_protocol_scope()
        .forbid_directory(&directory, true)
    {
        eprintln!("[plugin-registry] 无法从 asset scope 拒绝插件私有目录: {error}");
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
            request_python_revision_approval(
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
    if !native_stage_decision(&revision, native_approval) {
        return Err("用户已取消 Python 插件原生授权，未写入任何插件数据".to_string());
    }
    revision.native_approved = revision.runtime == "python";
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
) -> Result<PluginRegistrationStatus, String> {
    ensure_trusted_caller(&webview)?;
    validate_plugin_id(&plugin_id)?;
    validate_source_digest(&source_digest)?;
    validate_source_digest(&revision_digest)?;
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

    let approved = request_python_revision_approval(
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

    let approved = request_python_revision_approval(
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
            return Ok(false);
        };
        if let Err(error) = write_registry_at(&private_dir, &registry) {
            registry.plugins.insert(plugin_id.clone(), record);
            return Err(error);
        }
        cancel_committed_plugin_invocations(&plugin_id);
        // 快照删除也受注册表锁保护，避免卸载与同 ID 的重新安装互相穿插。
        let directory = private_dir.join(REVISIONS_DIR_NAME).join(&record.plugin_id);
        let _ = fs::remove_dir_all(directory);
        let ui_directory = private_dir.join("ui-revisions").join(&record.plugin_id);
        let _ = fs::remove_dir_all(ui_directory);
    }
    Ok(true)
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
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    let registry = read_registry_at(&private_dir)?;
    Ok(status_for(&plugin_id, registry.plugins.get(&plugin_id)))
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
    })
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
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "插件信任注册表锁异常".to_string())?;
    let registry = read_registry_at(&private_dir)?;
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
            revision.source_digest == source_digest && revision.revision_digest == revision_digest
        })
        .ok_or_else(|| "插件活动 revision 摘要不匹配".to_string())?;
    if !revision
        .permissions
        .iter()
        .any(|permission| permission == "plugin.resources.read")
    {
        return Err("插件未声明 plugin.resources.read 权限".to_string());
    }
    let bytes = read_verified_resource_at(&private_dir, &plugin_id, revision, &resource_id)?;
    let end = offset
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| "插件包资源读取范围无效".to_string())?;
    Ok(bytes[offset..end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temporary_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-plugin-registry-{name}-{}-{}",
            std::process::id(),
            unix_now_millis()
        ));
        fs::remove_dir_all(&directory).ok();
        directory
    }

    fn manifest(runtime: &str) -> Value {
        json!({
            "apiVersion": 1,
            "runtime": runtime,
            "id": "example.plugin",
            "name": "Example",
            "version": "1.0.0",
            "entry": if runtime == "python" { "main.py" } else { "main.js" },
            "permissions": ["node.read", "node.write"],
            "contributes": {
                "nodeTools": [{ "id": "upper" }],
                "nodes": [{ "id": "custom-node" }]
            }
        })
    }

    #[test]
    fn parses_manifest_and_hashes_exact_utf8_source() {
        let source = "definePlugin({ tools: {} });\n";
        let (plugin_id, revision) = parse_revision(&manifest("javascript"), source, None).unwrap();
        assert_eq!(plugin_id, "example.plugin");
        assert_eq!(revision.source_digest, source_digest(source));
        assert!(is_valid_digest(&revision.source_digest));
        assert_eq!(revision.declared_tool_ids, ["custom-node", "upper"]);
        assert!(!revision.native_approved);
    }

    #[test]
    fn package_resources_are_part_of_revision_and_verified_on_read() {
        let directory = temporary_directory("package-resources");
        let source = "definePlugin({ tools: {} });";
        let bytes = b"ABC".to_vec();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let mut value = manifest("javascript");
        value["permissions"] = json!(["node.read", "node.write", "plugin.resources.read"]);
        value["resources"] = json!([{
            "id": "template",
            "path": "resources/template.txt",
            "integrity": format!("sha256-{digest}"),
            "mediaType": "text/plain",
            "bytes": bytes.len()
        }]);
        let payloads = vec![PluginPackageResourcePayload {
            id: "template".to_string(),
            bytes: bytes.clone(),
        }];
        let (plugin_id, revision) =
            parse_revision_with_resources(&value, source, None, &payloads).unwrap();

        write_resource_snapshots_at(&directory, &plugin_id, &revision, &payloads).unwrap();
        assert_eq!(
            read_verified_resource_at(&directory, &plugin_id, &revision, "template").unwrap(),
            bytes
        );

        let changed_bytes = b"ABD".to_vec();
        let changed_digest = format!("{:x}", Sha256::digest(&changed_bytes));
        value["resources"][0]["integrity"] = json!(format!("sha256-{changed_digest}"));
        let changed_payloads = vec![PluginPackageResourcePayload {
            id: "template".to_string(),
            bytes: changed_bytes,
        }];
        let (_, changed_revision) =
            parse_revision_with_resources(&value, source, None, &changed_payloads).unwrap();
        assert_ne!(revision.revision_digest, changed_revision.revision_digest);

        fs::write(
            resource_snapshot_path(&directory, &plugin_id, &revision, "template"),
            b"ABE",
        )
        .unwrap();
        assert!(
            read_verified_resource_at(&directory, &plugin_id, &revision, "template")
                .unwrap_err()
                .contains("摘要不匹配")
        );
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn native_prompt_binds_exact_python_revision_and_action() {
        let (plugin_id, revision) =
            parse_revision(&manifest("python"), "define_plugin({'tools': {}})", None).unwrap();
        let stage =
            build_python_approval_prompt(NativeApprovalAction::Stage, &plugin_id, &revision);
        assert_eq!(stage.title, "高风险：安装可信 Python 插件");
        assert_eq!(stage.approve_label, "继续安装");
        assert_eq!(stage.cancel_label, "取消");
        assert!(stage.message.contains("插件 ID：example.plugin"));
        assert!(stage.message.contains("版本：1.0.0"));
        assert!(stage.message.contains("运行时：python"));
        assert!(stage
            .message
            .contains("声明的宿主权限：node.read、node.write"));
        assert_eq!(revision.source_digest.len(), 64);
        assert_eq!(stage.message.matches(&revision.source_digest).count(), 1);
        assert!(stage.message.contains("当前登录用户的完整系统权限"));
        assert!(stage.message.contains("读取或修改本机文件、访问网络"));
        assert!(stage.message.contains("启动其他程序"));
        assert!(stage.message.ends_with("才继续安装。"));

        let enable = build_python_approval_prompt(
            NativeApprovalAction::EnableOrSwitch,
            &plugin_id,
            &revision,
        );
        assert_eq!(enable.title, "高风险：授权可信 Python 插件版本");
        assert_eq!(enable.approve_label, "授权并继续");
        assert!(enable.message.contains("启用或切换可信 Python 插件版本"));
        assert!(enable
            .message
            .ends_with("才授权并启用或切换此 Python 版本。"));
    }

    #[test]
    fn native_stage_gate_requires_positive_python_approval_only() {
        let (_, javascript) = parse_revision(&manifest("javascript"), "source", None).unwrap();
        let (_, python) = parse_revision(&manifest("python"), "source", None).unwrap();
        assert!(native_stage_decision(&javascript, None));
        assert!(native_stage_decision(&javascript, Some(false)));
        assert!(!native_stage_decision(&python, None));
        assert!(!native_stage_decision(&python, Some(false)));
        assert!(native_stage_decision(&python, Some(true)));
    }

    #[test]
    fn native_enable_gate_covers_reenable_and_previous_but_not_approved_staged() {
        let (_, mut active) = parse_revision(&manifest("python"), "active", None).unwrap();
        let (_, mut previous) = parse_revision(&manifest("python"), "previous", None).unwrap();
        let (_, mut staged) = parse_revision(&manifest("python"), "staged", None).unwrap();
        active.native_approved = true;
        previous.native_approved = true;
        staged.native_approved = true;
        let mut record = PluginRegistration {
            plugin_id: "example.plugin".to_string(),
            enabled: true,
            active: Some(active.clone()),
            previous: Some(previous.clone()),
            staged: Some(staged.clone()),
            installed_at: 1,
            updated_at: 1,
        };
        assert!(!activation_requires_native_approval(
            &record,
            RevisionSlot::Active,
            &active,
            true
        ));
        assert!(activation_requires_native_approval(
            &record,
            RevisionSlot::Previous,
            &previous,
            true
        ));
        assert!(!activation_requires_native_approval(
            &record,
            RevisionSlot::Staged,
            &staged,
            true
        ));

        record.enabled = false;
        assert!(set_enabled_requires_native_approval(&record, true));
        assert!(activation_requires_native_approval(
            &record,
            RevisionSlot::Active,
            &active,
            true
        ));
        assert!(activation_requires_native_approval(
            &record,
            RevisionSlot::Previous,
            &previous,
            true
        ));
        assert!(!activation_requires_native_approval(
            &record,
            RevisionSlot::Staged,
            &staged,
            true
        ));
        staged.native_approved = false;
        assert!(activation_requires_native_approval(
            &record,
            RevisionSlot::Staged,
            &staged,
            true
        ));
    }

    #[test]
    fn native_approval_snapshot_rejects_role_digest_or_status_changes() {
        let (_, mut active) = parse_revision(&manifest("python"), "active", None).unwrap();
        let (_, mut previous) = parse_revision(&manifest("python"), "previous", None).unwrap();
        let (_, mut staged) = parse_revision(&manifest("python"), "staged", None).unwrap();
        active.native_approved = true;
        previous.native_approved = true;
        staged.native_approved = true;

        let record = PluginRegistration {
            plugin_id: "example.plugin".to_string(),
            enabled: true,
            active: Some(active.clone()),
            previous: Some(previous.clone()),
            staged: Some(staged),
            installed_at: 1,
            updated_at: 1,
        };
        assert!(activation_approval_snapshot_matches(
            &record,
            &record,
            RevisionSlot::Previous,
            &previous.revision_digest,
            &previous,
        ));
        assert!(!activation_approval_snapshot_matches(
            &record,
            &record,
            RevisionSlot::Active,
            &previous.revision_digest,
            &previous,
        ));
        assert!(!activation_approval_snapshot_matches(
            &record,
            &record,
            RevisionSlot::Previous,
            &active.revision_digest,
            &previous,
        ));

        let mut status_changed = record.clone();
        status_changed.enabled = false;
        assert!(!activation_approval_snapshot_matches(
            &status_changed,
            &record,
            RevisionSlot::Previous,
            &previous.revision_digest,
            &previous,
        ));

        let mut disabled = record.clone();
        disabled.enabled = false;
        disabled.previous = None;
        disabled.staged = None;
        let disabled_expected = disabled.clone();
        assert!(enable_approval_snapshot_matches(
            &disabled,
            &disabled_expected,
            &active,
            true,
        ));
        disabled.enabled = true;
        assert!(!enable_approval_snapshot_matches(
            &disabled,
            &disabled_expected,
            &active,
            true,
        ));
    }

    #[test]
    fn restaged_same_digest_preserves_native_approval() {
        let (_, mut active) = parse_revision(&manifest("python"), "same source", None).unwrap();
        let mut staged = active.clone();
        staged.native_approved = true;
        staged.staged_at = staged.staged_at.saturating_add(1);
        let mut record = PluginRegistration {
            plugin_id: "example.plugin".to_string(),
            enabled: false,
            active: Some(active.clone()),
            previous: None,
            staged: Some(staged.clone()),
            installed_at: 1,
            updated_at: 1,
        };
        let (slot, candidate) = activation_candidate(&record, &active.revision_digest).unwrap();
        assert_eq!(slot, RevisionSlot::Staged);
        assert!(candidate.native_approved);
        switch_active_revision(&mut record, &active.revision_digest).unwrap();
        active.native_approved = true;
        active.staged_at = staged.staged_at;
        assert_eq!(record.active, Some(active));
        assert!(record.staged.is_none());
    }

    #[test]
    fn switching_to_current_active_discards_different_staged_revision() {
        let (_, active) = parse_revision(&manifest("javascript"), "active-a", None).unwrap();
        let (_, staged) = parse_revision(&manifest("javascript"), "staged-b", None).unwrap();
        let mut record = PluginRegistration {
            plugin_id: "example.plugin".to_string(),
            enabled: true,
            active: Some(active.clone()),
            previous: None,
            staged: Some(staged.clone()),
            installed_at: 1,
            updated_at: 1,
        };

        let discarded = switch_active_revision(&mut record, &active.revision_digest).unwrap();

        assert_eq!(record.active.as_ref(), Some(&active));
        assert!(record.staged.is_none());
        assert_eq!(discarded, [staged]);
    }

    #[test]
    fn same_digest_native_reapproval_updates_unapproved_revision_without_manifest_conflict() {
        let directory = temporary_directory("native-reapproval");
        let source = "define_plugin({'tools': {'upper': lambda value: value}})";
        let (_, unapproved) = parse_revision(&manifest("python"), source, None).unwrap();
        write_source_snapshot_at(&directory, "example.plugin", &unapproved, source).unwrap();
        let mut registry = PluginRegistry::default();
        registry.plugins.insert(
            "example.plugin".to_string(),
            PluginRegistration {
                plugin_id: "example.plugin".to_string(),
                enabled: false,
                active: Some(unapproved.clone()),
                previous: None,
                staged: None,
                installed_at: 1,
                updated_at: 1,
            },
        );
        write_registry_at(&directory, &registry).unwrap();

        let mut approved = unapproved.clone();
        approved.native_approved = true;
        approved.staged_at = approved.staged_at.saturating_add(1);
        stage_revision_at(
            &directory,
            "example.plugin".to_string(),
            approved.clone(),
            source,
            None,
        )
        .unwrap();

        let loaded = read_registry_at(&directory).unwrap();
        let record = loaded.plugins.get("example.plugin").unwrap();
        assert!(!record.active.as_ref().unwrap().native_approved);
        assert_eq!(record.staged.as_ref(), Some(&approved));
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn rejects_runtime_entry_mismatch_and_excessive_source() {
        let mut value = manifest("javascript");
        value["entry"] = json!("main.py");
        assert!(parse_revision(&value, "print('x')", None).is_err());
        assert!(parse_revision(
            &manifest("javascript"),
            &"x".repeat(MAX_SOURCE_BYTES + 1),
            None
        )
        .is_err());
    }

    #[test]
    fn registry_write_is_atomic_and_keeps_schema() {
        let directory = temporary_directory("atomic");
        let mut registry = PluginRegistry::default();
        registry.plugins.insert(
            "example.plugin".to_string(),
            PluginRegistration {
                plugin_id: "example.plugin".to_string(),
                enabled: false,
                active: None,
                previous: None,
                staged: None,
                installed_at: 1,
                updated_at: 1,
            },
        );
        write_registry_at(&directory, &registry).unwrap();
        let loaded = read_registry_at(&directory).unwrap();
        assert_eq!(loaded.schema_version, REGISTRY_SCHEMA_VERSION);
        assert!(loaded.plugins.contains_key("example.plugin"));
        assert!(!directory.join(REGISTRY_TEMP_FILE_NAME).exists());
        assert!(!directory.join(REGISTRY_BACKUP_FILE_NAME).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn stage_over_registration_limit_keeps_registry_and_removes_new_snapshot() {
        let directory = temporary_directory("registration-limit");
        let mut registry = PluginRegistry::default();
        for index in 0..MAX_PLUGIN_REGISTRATIONS {
            let plugin_id = format!("plugin.{index:03}");
            registry.plugins.insert(
                plugin_id.clone(),
                PluginRegistration {
                    plugin_id,
                    enabled: false,
                    active: None,
                    previous: None,
                    staged: None,
                    installed_at: 1,
                    updated_at: 1,
                },
            );
        }
        write_registry_at(&directory, &registry).unwrap();

        let mut overflow_manifest = manifest("javascript");
        overflow_manifest["id"] = json!("overflow.plugin");
        let (plugin_id, revision) =
            parse_revision(&overflow_manifest, "overflow source", None).unwrap();
        assert!(stage_revision_at(
            &directory,
            plugin_id.clone(),
            revision.clone(),
            "overflow source",
            None
        )
        .is_err());

        let loaded = read_registry_at(&directory).unwrap();
        assert_eq!(loaded.plugins.len(), MAX_PLUGIN_REGISTRATIONS);
        assert!(!loaded.plugins.contains_key(&plugin_id));
        assert!(!revision_directory(&directory, &plugin_id, &revision.revision_digest).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn oversized_registry_body_does_not_replace_committed_primary() {
        let directory = temporary_directory("registry-byte-limit");
        let mut committed = PluginRegistry::default();
        committed.plugins.insert(
            "committed.plugin".to_string(),
            PluginRegistration {
                plugin_id: "committed.plugin".to_string(),
                enabled: false,
                active: None,
                previous: None,
                staged: None,
                installed_at: 1,
                updated_at: 1,
            },
        );
        write_registry_at(&directory, &committed).unwrap();

        let declared_tool_ids = (0..MAX_DECLARED_TOOL_IDS)
            .map(|index| format!("tool-{index:03}-{}", "x".repeat(48)))
            .collect::<Vec<_>>();
        let large_revision = PluginRevision {
            revision_digest: "b".repeat(64),
            source_digest: "a".repeat(64),
            version: "1.0.0".to_string(),
            runtime: "javascript".to_string(),
            entry: "main.js".to_string(),
            permissions: vec!["node.read".to_string(), "node.write".to_string()],
            declared_tool_ids,
            native_approved: false,
            ui_digest: None,
            ui_entry: None,
            resources: Vec::new(),
            staged_at: 1,
        };
        let mut oversized = PluginRegistry::default();
        for index in 0..256 {
            let plugin_id = format!("large.{index:03}");
            oversized.plugins.insert(
                plugin_id.clone(),
                PluginRegistration {
                    plugin_id,
                    enabled: true,
                    active: Some(large_revision.clone()),
                    previous: Some(large_revision.clone()),
                    staged: Some(large_revision.clone()),
                    installed_at: 1,
                    updated_at: 1,
                },
            );
        }
        assert!(serde_json::to_vec(&oversized).unwrap().len() as u64 > MAX_REGISTRY_BYTES);
        assert!(write_registry_at(&directory, &oversized).is_err());

        let loaded = read_registry_at(&directory).unwrap();
        assert_eq!(loaded.plugins.len(), 1);
        assert!(loaded.plugins.contains_key("committed.plugin"));
        assert!(!registry_temp_file(&directory).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn restores_backup_and_discards_tmp_after_interrupted_commit() {
        let directory = temporary_directory("recover-backup");
        let mut committed = PluginRegistry::default();
        committed.plugins.insert(
            "committed.plugin".to_string(),
            PluginRegistration {
                plugin_id: "committed.plugin".to_string(),
                enabled: false,
                active: None,
                previous: None,
                staged: None,
                installed_at: 1,
                updated_at: 1,
            },
        );
        write_registry_at(&directory, &committed).unwrap();

        let mut uncommitted = PluginRegistry::default();
        uncommitted.plugins.insert(
            "uncommitted.plugin".to_string(),
            PluginRegistration {
                plugin_id: "uncommitted.plugin".to_string(),
                enabled: false,
                active: None,
                previous: None,
                staged: None,
                installed_at: 2,
                updated_at: 2,
            },
        );
        fs::write(
            registry_temp_file(&directory),
            serde_json::to_vec(&uncommitted).unwrap(),
        )
        .unwrap();
        fs::rename(registry_file(&directory), registry_backup_file(&directory)).unwrap();

        let recovered = read_registry_at(&directory).unwrap();
        assert!(recovered.plugins.contains_key("committed.plugin"));
        assert!(!recovered.plugins.contains_key("uncommitted.plugin"));
        assert!(registry_file(&directory).is_file());
        assert!(!registry_backup_file(&directory).exists());
        assert!(!registry_temp_file(&directory).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn restores_valid_backup_when_primary_is_corrupt() {
        let directory = temporary_directory("recover-corrupt-primary");
        let mut committed = PluginRegistry::default();
        committed.plugins.insert(
            "committed.plugin".to_string(),
            PluginRegistration {
                plugin_id: "committed.plugin".to_string(),
                enabled: false,
                active: None,
                previous: None,
                staged: None,
                installed_at: 1,
                updated_at: 1,
            },
        );
        write_registry_at(&directory, &committed).unwrap();
        fs::copy(registry_file(&directory), registry_backup_file(&directory)).unwrap();
        fs::write(registry_file(&directory), b"{broken").unwrap();

        let recovered = read_registry_at(&directory).unwrap();
        assert!(recovered.plugins.contains_key("committed.plugin"));
        assert!(read_registry_file(&registry_file(&directory))
            .unwrap()
            .is_some());
        assert!(!registry_backup_file(&directory).exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn source_snapshot_detects_tampering() {
        let directory = temporary_directory("tamper");
        let source = "definePlugin({ tools: {} });";
        let (_, revision) = parse_revision(&manifest("javascript"), source, None).unwrap();
        write_source_snapshot_at(&directory, "example.plugin", &revision, source).unwrap();
        assert_eq!(
            read_verified_source_at(&directory, "example.plugin", &revision).unwrap(),
            source
        );
        fs::write(
            revision_file(&directory, "example.plugin", &revision),
            "changed",
        )
        .unwrap();
        assert!(read_verified_source_at(&directory, "example.plugin", &revision).is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn activation_keeps_current_previous_and_supports_rollback() {
        let (_, first) = parse_revision(&manifest("javascript"), "first", None).unwrap();
        let (_, old_previous) = parse_revision(&manifest("javascript"), "old", None).unwrap();
        let (_, next) = parse_revision(&manifest("javascript"), "next", None).unwrap();
        let mut record = PluginRegistration {
            plugin_id: "example.plugin".to_string(),
            enabled: true,
            active: Some(first.clone()),
            previous: Some(old_previous.clone()),
            staged: Some(next.clone()),
            installed_at: 1,
            updated_at: 1,
        };

        let discarded = switch_active_revision(&mut record, &next.revision_digest).unwrap();
        assert_eq!(discarded, [old_previous]);
        assert_eq!(record.active.as_ref(), Some(&next));
        assert_eq!(record.previous.as_ref(), Some(&first));
        assert!(record.staged.is_none());

        let discarded = switch_active_revision(&mut record, &first.revision_digest).unwrap();
        assert!(discarded.is_empty());
        assert_eq!(record.active.as_ref(), Some(&first));
        assert_eq!(record.previous.as_ref(), Some(&next));
        assert!(record.staged.is_none());
    }

    #[test]
    fn activation_cancels_only_disable_or_digest_change() {
        assert!(!activation_requires_cancel(None, "digest-a", true));
        assert!(!activation_requires_cancel(
            Some("digest-a"),
            "digest-a",
            true
        ));
        assert!(activation_requires_cancel(
            Some("digest-a"),
            "digest-b",
            true
        ));
        assert!(activation_requires_cancel(None, "digest-a", false));
    }

    #[test]
    fn private_path_helper_rejects_only_its_subtree() {
        let root = PathBuf::from("plugin-private");
        assert!(is_under_plugin_private_dir(
            &root,
            &root.join("revisions/example.plugin")
        ));
        assert!(!is_under_plugin_private_dir(
            &root,
            &PathBuf::from("plugin-public")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn private_path_helpers_treat_verbatim_and_plain_paths_as_equivalent() {
        let directory = temporary_directory("verbatim-path");
        let private = directory.join(PRIVATE_DIR_NAME);
        let child = private.join(REVISIONS_DIR_NAME).join("example.plugin");
        fs::create_dir_all(&child).unwrap();

        let verbatim_private = private.canonicalize().unwrap();
        let verbatim_child = child.canonicalize().unwrap();
        let plain_private = simplify_verbatim(verbatim_private.clone());
        let plain_child = simplify_verbatim(verbatim_child.clone());
        let plain_ancestor = simplify_verbatim(directory.canonicalize().unwrap());
        assert!(verbatim_private.to_string_lossy().starts_with(r"\\?\"));
        assert!(is_under_plugin_private_dir(&verbatim_private, &plain_child));
        assert!(is_under_plugin_private_dir(&plain_private, &verbatim_child));
        assert!(plugin_private_paths_overlap(
            &verbatim_private,
            &plain_ancestor
        ));
        assert!(plugin_private_paths_overlap(
            &plain_private,
            &verbatim_child
        ));
        fs::remove_dir_all(directory).ok();
    }
}
