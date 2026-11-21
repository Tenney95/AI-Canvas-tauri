//! 私有源码、界面及资源快照的读写与摘要核验。

use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use super::{
    dependency_fingerprint, ensure_private_directory, read_registry_at, validate_plugin_id,
    validate_source_digest, PluginPackageResourcePayload, PluginRevision, VerifiedResourceCache,
    VerifiedResourceEntry, MAX_SOURCE_BYTES, MAX_UI_SOURCE_BYTES, MAX_VERIFIED_RESOURCE_CACHE_BYTES,
    MAX_VERIFIED_RESOURCE_CACHE_ENTRIES, REVISIONS_DIR_NAME, UI_REVISIONS_DIR_NAME,
};

pub(super) fn revision_directory(private_dir: &Path, plugin_id: &str, digest: &str) -> PathBuf {
    private_dir
        .join(REVISIONS_DIR_NAME)
        .join(plugin_id)
        .join(digest)
}

pub(super) fn revision_file(private_dir: &Path, plugin_id: &str, revision: &PluginRevision) -> PathBuf {
    revision_directory(private_dir, plugin_id, &revision.revision_digest).join(&revision.entry)
}

pub(super) fn read_verified_source_at(
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

pub(super) fn write_source_snapshot_at(
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

pub(super) fn resource_snapshot_path(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    resource_id: &str,
) -> PathBuf {
    revision_directory(private_dir, plugin_id, &revision.revision_digest)
        .join("resources")
        .join(format!("{resource_id}.bin"))
}

pub(super) fn write_resource_snapshots_at(
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

pub(super) fn read_verified_resource_at(
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

// 命中也核对文件类型、大小和版本；磁盘变化后重新读取并验证 SHA-256。
pub(super) fn read_cached_resource_at(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
    resource_id: &str,
    cache: &mut VerifiedResourceCache,
) -> Result<Arc<[u8]>, String> {
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
    let modified = metadata.modified().ok();
    let created = metadata.created().ok();
    if let Some(index) = cache.entries.iter().position(|entry| {
        entry.path == path
            && entry.revision_digest == revision.revision_digest
            && entry.resource_digest == resource.digest
    }) {
        let entry = cache.entries.remove(index).expect("cached resource index");
        if modified == Some(entry.modified)
            && created == entry.created
            && entry.bytes.len() == resource.bytes
        {
            let bytes = Arc::clone(&entry.bytes);
            cache.entries.push_back(entry);
            return Ok(bytes);
        }
        cache.bytes -= entry.bytes.len();
    }
    let bytes: Arc<[u8]> =
        read_verified_resource_at(private_dir, plugin_id, revision, resource_id)?.into();
    // 时间戳不可用或读取过程中有变化时，仅返回已验证内容，不缓存不稳定的文件版本。
    let after = fs::symlink_metadata(&path).map_err(|_| "插件包资源快照不存在".to_string())?;
    if let Some(modified) = modified.filter(|modified| {
        after.modified().ok() == Some(*modified)
            && after.created().ok() == created
            && after.len() == metadata.len()
            && after.file_type().is_file()
            && !after.file_type().is_symlink()
    }) {
        while cache.entries.len() >= MAX_VERIFIED_RESOURCE_CACHE_ENTRIES
            || cache.bytes + bytes.len() > MAX_VERIFIED_RESOURCE_CACHE_BYTES
        {
            if let Some(entry) = cache.entries.pop_front() {
                cache.bytes -= entry.bytes.len();
            } else {
                break;
            }
        }
        cache.bytes += bytes.len();
        cache.entries.push_back(VerifiedResourceEntry {
            plugin_id: plugin_id.to_string(),
            path,
            revision_digest: revision.revision_digest.clone(),
            resource_digest: resource.digest.clone(),
            modified,
            created,
            bytes: Arc::clone(&bytes),
        });
    }
    Ok(bytes)
}

/// UI 产物按摘要内容寻址，与入口源码目录彻底分离。
/// 这样「仅更新 UI、主源码不变」时不会覆盖活动版本的 UI 文件，也不会让
/// active/previous/staged 因共享 source_digest 而产生回滚歧义。
fn ui_directory(private_dir: &Path, plugin_id: &str) -> PathBuf {
    private_dir.join(UI_REVISIONS_DIR_NAME).join(plugin_id)
}

pub(super) fn ui_snapshot_path(
    private_dir: &Path,
    plugin_id: &str,
    revision: &PluginRevision,
) -> Option<PathBuf> {
    let digest = revision.ui_digest.as_deref()?;
    Some(ui_directory(private_dir, plugin_id).join(format!("{digest}.js")))
}

pub(super) fn write_ui_snapshot_at(
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
pub(super) fn read_verified_ui_source_at(
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
    dependency_fingerprint(&registry, plugin_id)?;
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

pub(super) fn remove_revision_snapshot(private_dir: &Path, plugin_id: &str, revision: &PluginRevision) {
    let directory = revision_directory(private_dir, plugin_id, &revision.revision_digest);
    let _ = fs::remove_dir_all(directory);
}
