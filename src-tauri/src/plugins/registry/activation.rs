//! 候选版本切换、启停授权快照及注册表提交。

use std::path::Path;

use super::{
    cancel_dependency_tree, ensure_candidate_dependencies, ensure_host_compatibility,
    read_verified_source_at, remove_revision_snapshot, revision_is_referenced, revision_requests_native_approval,
    status_for, unix_now_millis, write_registry_at, PluginRegistration, PluginRegistrationStatus,
    PluginRegistry, PluginRevision, RevisionSlot,
};

pub(super) fn matching_revision<'a>(
    record: &'a PluginRegistration,
    digest: &str,
) -> Option<&'a PluginRevision> {
    [&record.active, &record.previous, &record.staged]
        .into_iter()
        .flatten()
        .find(|revision| revision.revision_digest == digest)
}

pub(super) fn revision_security_manifest_matches(left: &PluginRevision, right: &PluginRevision) -> bool {
    left.revision_digest == right.revision_digest
        && left.source_digest == right.source_digest
        && left.version == right.version
        && left.runtime == right.runtime
        && left.entry == right.entry
        && left.permissions == right.permissions
        && left.network_origins == right.network_origins
        && left.min_host_version == right.min_host_version
        && left.required_capabilities == right.required_capabilities
        && left.dependencies == right.dependencies
        && left.declared_tool_ids == right.declared_tool_ids
        && left.model_protocols == right.model_protocols
        && left.python_execution == right.python_execution
        && left.ui_digest == right.ui_digest
        && left.ui_entry == right.ui_entry
        && left.resources == right.resources
}

pub(super) fn activation_candidate<'a>(
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

pub(super) fn activation_requires_native_approval(
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

pub(super) fn set_enabled_requires_native_approval(record: &PluginRegistration, enabled: bool) -> bool {
    enabled
        && !record.enabled
        && record
            .active
            .as_ref()
            .is_some_and(revision_requests_native_approval)
}

pub(super) fn activation_approval_snapshot_matches(
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

pub(super) fn enable_approval_snapshot_matches(
    current: &PluginRegistration,
    expected: &PluginRegistration,
    candidate: &PluginRevision,
    enabled: bool,
) -> bool {
    current == expected
        && current.active.as_ref() == Some(candidate)
        && set_enabled_requires_native_approval(current, enabled)
}

pub(super) fn switch_active_revision(
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

pub(super) fn activation_requires_cancel(
    active_digest_before: Option<&str>,
    next_digest: &str,
    enabled: bool,
) -> bool {
    !enabled || active_digest_before.is_some_and(|digest| digest != next_digest)
}

pub(super) fn commit_activation_at(
    private_dir: &Path,
    registry: &mut PluginRegistry,
    plugin_id: &str,
    revision_digest: &str,
    enabled: bool,
    native_approval_granted: bool,
) -> Result<PluginRegistrationStatus, String> {
    ensure_candidate_dependencies(registry, plugin_id, revision_digest, enabled)?;
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
        if enabled {
            ensure_host_compatibility(
                candidate.min_host_version.as_deref(),
                &candidate.required_capabilities,
            )?;
        }
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
        cancel_dependency_tree(registry, plugin_id);
    }
    Ok(status)
}

pub(super) fn commit_enabled_at(
    private_dir: &Path,
    registry: &mut PluginRegistry,
    plugin_id: &str,
    enabled: bool,
    native_approval_granted: bool,
) -> Result<PluginRegistrationStatus, String> {
    if enabled {
        let digest = registry.plugins.get(plugin_id).and_then(|record| record.active.as_ref()).ok_or("插件没有活动版本")?.revision_digest.clone();
        ensure_candidate_dependencies(registry, plugin_id, &digest, true)?;
    }
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
        ensure_host_compatibility(
            active.min_host_version.as_deref(),
            &active.required_capabilities,
        )?;
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
        cancel_dependency_tree(registry, plugin_id);
    }
    Ok(status_for(plugin_id, registry.plugins.get(plugin_id)))
}
