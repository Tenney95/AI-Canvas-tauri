//! 插件清单、贡献声明与快照摘要的解析及兼容性校验。

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use super::{
    unix_now_millis, validate_dependencies, PluginDependency, PluginModelProtocol, PluginPackageResource,
    PluginPackageResourcePayload, PluginPythonExecution, PluginRevision, MAX_DECLARED_TOOL_IDS,
    MAX_MANIFEST_BYTES, MAX_PACKAGE_RESOURCES, MAX_PACKAGE_RESOURCE_BYTES, MAX_PACKAGE_TOTAL_BYTES,
    MAX_PERMISSION_BYTES, MAX_PERMISSION_COUNT, MAX_PLUGIN_ID_BYTES, MAX_SOURCE_BYTES, MAX_TOOL_ID_BYTES,
    MAX_UI_ENTRY_BYTES, MAX_UI_EXPORTS, MAX_UI_EXPORT_KEY_BYTES, MAX_UI_SOURCE_BYTES, MAX_VERSION_BYTES,
    SUPPORTED_PERMISSIONS,
};

pub(super) fn validate_model_protocols(items: &[PluginModelProtocol]) -> Result<(), String> {
    if items.len() > 16 { return Err("modelProtocols 最多 16 项".into()); }
    let mut ids = BTreeSet::new();
    for item in items {
        validate_tool_id(&item.id)?;
        if !ids.insert(&item.id) || item.name.trim() != item.name || item.name.is_empty()
            || item.name.chars().count() > 80 || item.name.chars().any(char::is_control)
            || item.category != "text"
            || !["openai-compatible", "openai-responses", "anthropic-compatible", "gemini-native"].contains(&item.adapter.as_str())
        { return Err("modelProtocols 声明无效或 ID 重复".into()); }
    }
    Ok(())
}

fn parse_model_protocols(contributes: &Map<String, Value>, api_version: u64, capabilities: &[String]) -> Result<Vec<PluginModelProtocol>, String> {
    let Some(raw) = contributes.get("modelProtocols") else { return Ok(Vec::new()); };
    if api_version != 2 || !capabilities.iter().any(|item| item == "model.protocolPresets") {
        return Err("modelProtocols 要求 API 2 与 model.protocolPresets 能力".into());
    }
    let mut items: Vec<PluginModelProtocol> = serde_json::from_value(raw.clone()).map_err(|_| "modelProtocols 格式无效")?;
    validate_model_protocols(&items)?;
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(items)
}

fn parse_python_execution(
    contributes: &Map<String, Value>,
    runtime: &str,
    api_version: u64,
    permissions: &[String],
    capabilities: &[String],
) -> Result<BTreeMap<String, PluginPythonExecution>, String> {
    let mut declarations = BTreeMap::new();
    if let Some(tools) = contributes.get("nodeTools").and_then(Value::as_array) {
        for tool in tools {
            let Some(raw) = tool.get("pythonExecution") else {
                continue;
            };
            if runtime != "python" || api_version != 2 {
                return Err("pythonExecution 仅允许 API 2 可信 Python 节点工具".into());
            }
            let declaration: PluginPythonExecution = serde_json::from_value(raw.clone())
                .map_err(|_| "可信 Python 执行声明无效".to_string())?;
            if !(30..=120).contains(&declaration.timeout_seconds)
                || !capabilities
                    .iter()
                    .any(|item| item == "python.executionTimeout")
            {
                return Err("Python 执行时限必须为 30–120 秒并声明 python.executionTimeout".into());
            }
            if declaration.media_workspace
                && (!capabilities
                    .iter()
                    .any(|item| item == "python.mediaWorkspace")
                    || !permissions
                        .iter()
                        .any(|item| item == "files.connected.read")
                    || !permissions.iter().any(|item| item == "files.output.create")
                    || tool
                        .pointer("/resourceAccess/self")
                        .and_then(Value::as_bool)
                        != Some(true)
                    || tool.pointer("/output/mode").and_then(Value::as_str)
                        != Some("create-node-set"))
            {
                return Err(
                    "Python 媒体工作区需要明确能力、读写权限、self 资源及节点集输出".into(),
                );
            }
            let id = tool
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Python 工具 ID 无效")?;
            validate_tool_id(id)?;
            declarations.insert(id.to_string(), declaration);
        }
    }
    Ok(declarations)
}

pub(super) fn source_digest(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

pub(super) fn is_valid_digest(value: &str) -> bool {
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

pub(crate) fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if !is_valid_scoped_id(plugin_id, MAX_PLUGIN_ID_BYTES) {
        return Err("插件 ID 无效".to_string());
    }
    Ok(())
}

pub(super) fn validate_tool_id(tool_id: &str) -> Result<(), String> {
    if !is_valid_scoped_id(tool_id, MAX_TOOL_ID_BYTES) {
        return Err("插件工具 ID 无效".to_string());
    }
    Ok(())
}

pub(super) fn validate_source_digest(value: &str) -> Result<(), String> {
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
                    || (key == "requiredCapabilities" && byte.is_ascii_uppercase())
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

pub(super) fn validate_package_resource_path(path: &str) -> Result<(), String> {
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

pub(super) fn host_version_parts(value: &str) -> Result<Vec<u32>, String> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 9
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || part.len() > 1 && part.starts_with('0')
        })
    {
        return Err("minHostVersion 必须是稳定版本号，例如 0.9.23".into());
    }
    parts
        .into_iter()
        .map(|part| part.parse::<u32>().map_err(|_| "最低宿主版本无效".into()))
        .collect()
}

pub(super) fn validate_compatibility_shape(
    minimum: Option<&str>,
    capabilities: &[String],
) -> Result<(), String> {
    if let Some(minimum) = minimum {
        host_version_parts(minimum)?;
    }
    if capabilities.len() > 16
        || capabilities.windows(2).any(|pair| pair[0] >= pair[1])
        || capabilities.iter().any(|name| {
            name.len() > 64
                || name.split('.').any(|part| {
                    !part.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                        || !part.bytes().all(|byte| byte.is_ascii_alphanumeric())
                })
        })
    {
        return Err("所需宿主能力清单无效".into());
    }
    Ok(())
}

pub(super) fn ensure_host_compatibility(minimum: Option<&str>, capabilities: &[String]) -> Result<(), String> {
    if let Some(minimum) = minimum {
        if host_version_parts(minimum)? > host_version_parts(env!("CARGO_PKG_VERSION"))? {
            return Err(format!(
                "插件需要宿主 {minimum} 或更高版本，当前为 {}",
                env!("CARGO_PKG_VERSION")
            ));
        }
    }
    let host = crate::plugin_runtime::host_info();
    let supported = host["capabilities"]
        .as_array()
        .expect("内置能力清单必须是数组");
    for capability in capabilities {
        if !supported
            .iter()
            .any(|name| name.as_str() == Some(capability))
        {
            return Err(format!("宿主不支持插件所需能力: {capability}"));
        }
    }
    Ok(())
}

pub(super) fn parse_revision_with_resources(
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
    let api_version = root
        .get("apiVersion")
        .and_then(Value::as_u64)
        .filter(|value| matches!(value, 1 | 2))
        .ok_or_else(|| "插件 apiVersion 无效".to_string())?;
    if api_version == 1
        && (root.contains_key("minHostVersion") || root.contains_key("requiredCapabilities"))
    {
        return Err("兼容声明需要 apiVersion: 2，避免旧宿主忽略声明".into());
    }
    let min_host_version = if root.contains_key("minHostVersion") {
        Some(required_string(root, "minHostVersion", "最低宿主版本", 32)?)
    } else {
        None
    };
    let required_capabilities = if root.contains_key("requiredCapabilities") {
        string_list(root, "requiredCapabilities", "所需宿主能力", 16, 64)?
    } else {
        Vec::new()
    };
    validate_compatibility_shape(min_host_version.as_deref(), &required_capabilities)?;
    ensure_host_compatibility(min_host_version.as_deref(), &required_capabilities)?;
    let dependencies = match root.get("dependencies") {
        None => Vec::new(),
        Some(value) => {
            if api_version != 2 || !required_capabilities.iter().any(|item| item == "plugin.dependencies") {
                return Err("dependencies 要求 API 2 与 plugin.dependencies 能力声明".into());
            }
            let dependencies: Vec<PluginDependency> = serde_json::from_value(value.clone())
                .map_err(|_| "插件依赖声明无效".to_string())?;
            validate_dependencies(&dependencies, Some(&plugin_id))?;
            dependencies
        }
    };
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
    if permissions.iter().any(|item| item == "prompt.references.read")
        && (api_version != 2 || !required_capabilities.iter().any(|item| item == "prompt.mentions"))
    {
        return Err("prompt.references.read 要求 API 2 与 prompt.mentions 能力声明".to_string());
    }
    if permissions.iter().any(|item| item == "wsagent.shared-images")
        && (plugin_id != "ai-canvas.wsagent" || api_version != 2 || runtime != "javascript"
            || !required_capabilities.iter().any(|item| item == "wsagent.sharedImages"))
    {
        return Err("WSAGENT 互联权限要求专用 API 2 插件".to_string());
    }
    let contributes = object(
        root.get("contributes")
            .ok_or_else(|| "插件缺少 contributes".to_string())?,
        "contributes",
    )?;
    let declared_tool_ids = declared_tool_ids(contributes)?;
    let model_protocols = parse_model_protocols(contributes, api_version, &required_capabilities)?;
    if declared_tool_ids.is_empty() && model_protocols.is_empty() {
        return Err("插件至少需要声明一个工具或自定义节点或协议预设".into());
    }
    let python_execution = parse_python_execution(
        contributes,
        &runtime,
        api_version,
        &permissions,
        &required_capabilities,
    )?;
    let (ui_digest, ui_entry) = parse_ui_declaration(root, &permissions, ui_source)?;
    let resources = parse_package_resources(root, &permissions, resource_payloads)?;
    let network_origins = parse_network_origins(root, &permissions)?;
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
            network_origins,
            min_host_version,
            required_capabilities,
            dependencies,
            declared_tool_ids,
            model_protocols,
            python_execution,
            native_approved: false,
            ui_digest,
            ui_entry,
            resources,
            staged_at: unix_now_millis(),
        },
    ))
}

fn parse_network_origins(
    root: &Map<String, Value>,
    permissions: &[String],
) -> Result<Vec<String>, String> {
    let has_permission = permissions.iter().any(|value| value == "network.request");
    match root.get("network") {
        None if !has_permission => Ok(Vec::new()),
        None => Err("network.request 必须声明 network.allowedOrigins".to_string()),
        Some(_) if !has_permission => Err("声明 network 必须包含 network.request 权限".to_string()),
        Some(value) => {
            let network = object(value, "network")?;
            let raw = network
                .get("allowedOrigins")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty() && items.len() <= 16)
                .ok_or("network.allowedOrigins 必须包含 1-16 个来源")?;
            let mut origins = BTreeSet::new();
            for value in raw {
                let origin = value
                    .as_str()
                    .ok_or("network.allowedOrigins 必须是字符串数组")?;
                crate::plugin_host_effects::validate_origin(origin)?;
                origins.insert(origin.to_string());
            }
            Ok(origins.into_iter().collect())
        }
    }
}

#[cfg(test)]
pub(super) fn parse_revision(
    manifest: &Value,
    source: &str,
    ui_source: Option<&str>,
) -> Result<(String, PluginRevision), String> {
    parse_revision_with_resources(manifest, source, ui_source, &[])
}
