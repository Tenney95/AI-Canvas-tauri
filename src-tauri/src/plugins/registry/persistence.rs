//! 插件信任注册表的格式校验、原子读写与损坏恢复。

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::registry_write::{write_registry_file, RegistryWriteErrors, RegistryWriteMode};

use super::{
    ensure_private_directory, prepared_plugin_directory, revision_requests_native_approval,
    validate_compatibility_shape, validate_dependencies, validate_model_protocols,
    validate_package_resource_path, validate_plugin_id, validate_source_digest, validate_tool_id,
    PluginRegistry, PluginRevision, MAX_DECLARED_TOOL_IDS, MAX_PACKAGE_RESOURCES,
    MAX_PACKAGE_RESOURCE_BYTES, MAX_PACKAGE_TOTAL_BYTES, MAX_PERMISSION_BYTES, MAX_PERMISSION_COUNT,
    MAX_PLUGIN_REGISTRATIONS, MAX_REGISTRY_BYTES, MAX_VERSION_BYTES, REGISTRY_BACKUP_FILE_NAME,
    REGISTRY_FILE_NAME, REGISTRY_SCHEMA_VERSION, REGISTRY_TEMP_FILE_NAME, REVISIONS_DIR_NAME,
    SUPPORTED_PERMISSIONS, UI_REVISIONS_DIR_NAME,
};

pub(super) fn registry_file(private_dir: &Path) -> PathBuf {
    private_dir.join(REGISTRY_FILE_NAME)
}

pub(super) fn registry_temp_file(private_dir: &Path) -> PathBuf {
    private_dir.join(REGISTRY_TEMP_FILE_NAME)
}

pub(super) fn registry_backup_file(private_dir: &Path) -> PathBuf {
    private_dir.join(REGISTRY_BACKUP_FILE_NAME)
}

pub(super) fn validate_stored_revision(revision: &PluginRevision) -> Result<(), String> {
    validate_dependencies(&revision.dependencies, None)?;
    if !revision.dependencies.is_empty() && !revision.required_capabilities.iter().any(|item| item == "plugin.dependencies") {
        return Err("插件依赖缺少宿主能力声明".into());
    }
    validate_compatibility_shape(
        revision.min_host_version.as_deref(),
        &revision.required_capabilities,
    )?;
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
    if revision.native_approved && !revision_requests_native_approval(revision) {
        return Err("不需要原生高风险授权的插件不能携带授权标记".to_string());
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
    if revision.permissions.iter().any(|item| item == "prompt.references.read")
        && !revision.required_capabilities.iter().any(|item| item == "prompt.mentions")
    {
        return Err("提示词引用权限缺少 prompt.mentions 能力声明".to_string());
    }
    if revision.permissions.iter().any(|item| item == "wsagent.shared-images")
        && (revision.runtime != "javascript" || !revision.required_capabilities.iter().any(|item| item == "wsagent.sharedImages"))
    {
        return Err("WSAGENT 互联权限缺少宿主能力声明".to_string());
    }
    validate_model_protocols(&revision.model_protocols)?;
    if revision.model_protocols.windows(2).any(|pair| pair[0].id >= pair[1].id) {
        return Err("协议预设必须按 ID 排序且不能重复".into());
    }
    if !revision.model_protocols.is_empty() && !revision.required_capabilities.iter().any(|item| item == "model.protocolPresets") {
        return Err("协议预设缺少 model.protocolPresets 能力声明".into());
    }
    if (revision.declared_tool_ids.is_empty() && revision.model_protocols.is_empty())
        || revision.declared_tool_ids.len() > MAX_DECLARED_TOOL_IDS
        || revision
            .declared_tool_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err("插件信任注册表包含无效工具清单".to_string());
    }
    let has_network = revision
        .permissions
        .iter()
        .any(|value| value == "network.request");
    if has_network == revision.network_origins.is_empty()
        || revision.network_origins.len() > 16
        || revision
            .network_origins
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err("插件信任注册表包含无效网络授权".to_string());
    }
    for origin in &revision.network_origins {
        crate::plugin_host_effects::validate_origin(origin)?;
    }
    for tool_id in &revision.declared_tool_ids {
        validate_tool_id(tool_id)?;
    }
    for (tool_id, declaration) in &revision.python_execution {
        if revision.runtime != "python"
            || !revision.declared_tool_ids.contains(tool_id)
            || !(30..=120).contains(&declaration.timeout_seconds)
            || !revision
                .required_capabilities
                .iter()
                .any(|item| item == "python.executionTimeout")
            || (declaration.media_workspace
                && (!revision
                    .required_capabilities
                    .iter()
                    .any(|item| item == "python.mediaWorkspace")
                    || !revision
                        .permissions
                        .iter()
                        .any(|item| item == "files.connected.read")
                    || !revision
                        .permissions
                        .iter()
                        .any(|item| item == "files.output.create")))
        {
            return Err("插件信任注册表包含无效 Python 执行声明".into());
        }
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
    if registry.schema_version != REGISTRY_SCHEMA_VERSION && registry.schema_version != 2 {
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

pub(super) fn read_registry_file(path: &Path) -> Result<Option<PluginRegistry>, String> {
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

pub(super) fn read_registry_at(private_dir: &Path) -> Result<PluginRegistry, String> {
    if prepared_plugin_directory(private_dir)? {
        return Err("插件目录初始化尚未完成，未读取或执行插件；请重新安装以继续初始化".into());
    }
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

pub(super) fn is_repairable_registry_error(error: &str) -> bool {
    matches!(error, "插件信任注册表损坏" | "插件信任注册表及备份均损坏")
}

/// 只修复确认属于 JSON 内容损坏的注册表。权限、路径或普通 I/O 错误必须原样失败，
/// 避免把环境故障误判为可以清空的信任状态。
pub(super) fn repair_corrupt_registry_at(private_dir: &Path) -> Result<bool, String> {
    match read_registry_at(private_dir) {
        Ok(_) => return Ok(false),
        Err(error) if is_repairable_registry_error(&error) => {}
        Err(error) => return Err(error),
    }
    write_registry_at(private_dir, &PluginRegistry::default())?;
    for directory in [
        private_dir.join(REVISIONS_DIR_NAME),
        private_dir.join(UI_REVISIONS_DIR_NAME),
    ] {
        if directory.exists() {
            // 注册表已清空后残留快照不再可执行；清理失败不能阻止后续全局调用撤销。
            let _ = fs::remove_dir_all(directory);
        }
    }
    Ok(true)
}

pub(super) fn write_registry_at(private_dir: &Path, registry: &PluginRegistry) -> Result<(), String> {
    ensure_private_directory(private_dir)?;
    validate_registry(registry)?;
    let mut persisted = registry.clone();
    // 旧宿主会忽略新字段；有兼容声明时必须升级表版本，让旧读取器明确拒绝。
    persisted.schema_version = if registry.plugins.values().any(|record| {
        [&record.active, &record.previous, &record.staged]
            .into_iter()
            .flatten()
            .any(|revision| {
                revision.min_host_version.is_some() || !revision.required_capabilities.is_empty()
            })
    }) {
        2
    } else {
        REGISTRY_SCHEMA_VERSION
    };
    let file = registry_file(private_dir);
    let temporary = registry_temp_file(private_dir);
    let backup = registry_backup_file(private_dir);
    let body =
        serde_json::to_vec(&persisted).map_err(|_| "无法序列化插件信任注册表".to_string())?;
    if body.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("插件信任注册表超过大小限制".to_string());
    }
    write_registry_file(
        &file,
        &temporary,
        &backup,
        &body,
        RegistryWriteMode::FixedTemporary,
        RegistryWriteErrors {
            write: "无法写入插件信任注册表",
            prepare: "无法准备插件信任注册表更新",
            commit: "无法提交插件信任注册表",
        },
    )
}
