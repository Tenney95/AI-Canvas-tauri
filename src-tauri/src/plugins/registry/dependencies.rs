//! 插件候选依赖的校验、活动依赖指纹与反向依赖撤销。

use std::collections::BTreeSet;

use sha2::{Digest, Sha256};

use super::{
    cancel_committed_plugin_invocations, ensure_native_execution_approved, host_version_parts,
    revision_requests_native_approval, switch_active_revision, validate_plugin_id, PluginDependency,
    PluginRegistry,
};

pub(super) fn validate_dependencies(dependencies: &[PluginDependency], plugin_id: Option<&str>) -> Result<(), String> {
    if dependencies.len() > 16 { return Err("插件依赖最多 16 项".into()); }
    let mut seen = BTreeSet::new();
    for dependency in dependencies {
        validate_plugin_id(&dependency.plugin_id)?;
        if plugin_id == Some(dependency.plugin_id.as_str()) || !seen.insert(&dependency.plugin_id) {
            return Err("插件依赖重复或引用自身".into());
        }
        if let Some(version) = &dependency.min_version { host_version_parts(version)?; }
    }
    Ok(())
}

/// 每次原生授权都从活动注册表重算；不是 Renderer 提交的授权证明。
pub(super) fn dependency_fingerprint(registry: &PluginRegistry, plugin_id: &str) -> Result<String, String> {
    fn visit(registry: &PluginRegistry, id: &str, soft: bool, stack: &mut Vec<String>,
        visited: &mut BTreeSet<(String, bool)>, identities: &mut BTreeSet<String>) -> Result<(), String> {
        if stack.iter().any(|item| item == id) || stack.len() >= 32 { return Err("插件依赖存在循环或深度超限".into()); }
        if !visited.insert((id.to_string(), soft)) { return Ok(()); }
        let active = registry.plugins.get(id).filter(|item| item.enabled).and_then(|item| item.active.as_ref());
        let Some(active) = active else { return if soft { Ok(()) } else { Err("必需插件依赖不可用".into()) }; };
        if ensure_native_execution_approved(active).is_err() {
            return if soft { Ok(()) } else { Err("必需插件依赖不兼容或未授权".into()) };
        }
        identities.insert(format!("{id}:{}:{}", active.source_digest, active.revision_digest));
        stack.push(id.to_string());
        for dependency in &active.dependencies {
            let optional = soft || dependency.optional;
            if let Some(minimum) = &dependency.min_version {
                if let Some(candidate) = registry.plugins.get(&dependency.plugin_id).and_then(|item| item.active.as_ref()) {
                    let valid = host_version_parts(&candidate.version).and_then(|current| Ok(current >= host_version_parts(minimum)?));
                    if !valid.unwrap_or(false) {
                        if optional { continue; }
                        return Err("必需插件依赖版本不足或无效".into());
                    }
                }
            }
            visit(registry, &dependency.plugin_id, optional, stack, visited, identities)?;
        }
        stack.pop();
        Ok(())
    }
    let mut identities = BTreeSet::new();
    visit(registry, plugin_id, false, &mut Vec::new(), &mut BTreeSet::new(), &mut identities)?;
    Ok(format!("{:x}", Sha256::digest(identities.into_iter().collect::<Vec<_>>().join("|").as_bytes())))
}

pub(super) fn cancel_dependency_tree(registry: &PluginRegistry, changed_id: &str) {
    let mut affected = BTreeSet::from([changed_id.to_string()]);
    loop {
        let before = affected.len();
        for (id, registration) in &registry.plugins {
            if registration.active.as_ref().is_some_and(|revision| revision.dependencies.iter().any(|dependency| affected.contains(&dependency.plugin_id))) {
                affected.insert(id.clone());
            }
        }
        if before == affected.len() { break; }
    }
    for id in affected { cancel_committed_plugin_invocations(&id); }
}

pub(super) fn ensure_candidate_dependencies(registry: &PluginRegistry, plugin_id: &str, digest: &str, enabled: bool) -> Result<(), String> {
    if !enabled { return Ok(()); }
    let mut candidate = registry.clone();
    let record = candidate.plugins.get_mut(plugin_id).ok_or("插件未注册")?;
    switch_active_revision(record, digest)?;
    record.enabled = true;
    // 宿主批准由后面的原生授权流程处理；这里仅避免尚待批准的自身误判。
    if let Some(revision) = record.active.as_mut() { revision.native_approved = revision_requests_native_approval(revision); }
    dependency_fingerprint(&candidate, plugin_id)?;
    Ok(())
}
