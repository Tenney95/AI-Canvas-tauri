#[path = "tests/storage.rs"]
mod storage;

use super::activation::activation_requires_cancel;
use super::manifest::{is_valid_digest, parse_revision, source_digest};
use super::persistence::validate_stored_revision;
use super::snapshots::{resource_snapshot_path, revision_file, ui_snapshot_path};
use sha2::{Digest, Sha256};
use super::*;
use serde_json::json;

fn protocol_manifest() -> Value {
    let mut value = manifest("javascript");
    value["apiVersion"] = json!(2);
    value["requiredCapabilities"] = json!(["model.protocolPresets"]);
    value["permissions"] = json!([]);
    value["contributes"] = json!({"nodeTools": [], "modelProtocols": [
        {"id": "responses", "name": "OpenAI Responses", "category": "text", "adapter": "openai-responses"}
    ]});
    value
}

#[test]
fn protocol_only_packages_require_capability_and_bind_metadata_to_revision() {
    let value = protocol_manifest();
    let (_, revision) = parse_revision(&value, "definePlugin({ tools: {} });", None).unwrap();
    assert!(revision.declared_tool_ids.is_empty());
    assert_eq!(revision.model_protocols[0].adapter, "openai-responses");
    validate_stored_revision(&revision).unwrap();
    let mut changed = value.clone();
    changed["contributes"]["modelProtocols"][0]["adapter"] = json!("openai-compatible");
    let (_, next) = parse_revision(&changed, "definePlugin({ tools: {} });", None).unwrap();
    assert_eq!(revision.source_digest, next.source_digest);
    assert_ne!(revision.revision_digest, next.revision_digest);
    assert!(!revision_security_manifest_matches(&revision, &next));
    changed["requiredCapabilities"] = json!([]);
    assert!(parse_revision(&changed, "source", None).is_err());
    changed = value.clone(); changed["apiVersion"] = json!(1);
    assert!(parse_revision(&changed, "source", None).is_err());
    for field in ["category", "adapter", "id", "extra"] {
        changed = value.clone();
        changed["contributes"]["modelProtocols"][0][field] = json!("invalid/field");
        assert!(parse_revision(&changed, "source", None).is_err());
    }
    changed = value.clone();
    changed["contributes"]["modelProtocols"] = json!([value["contributes"]["modelProtocols"][0], value["contributes"]["modelProtocols"][0]]);
    assert!(parse_revision(&changed, "source", None).is_err());
}

#[test]
fn protocol_catalog_only_exposes_verified_enabled_native_snapshot() {
    let directory = temporary_directory("protocol-preset-health");
    let source = "definePlugin({ tools: {} });";
    let (id, revision) = parse_revision(&protocol_manifest(), source, None).unwrap();
    stage_revision_at(&directory, id.clone(), revision.clone(), source, None).unwrap();
    let mut registry = read_registry_at(&directory).unwrap();
    commit_activation_at(&directory, &mut registry, &id, &revision.revision_digest, true, false).unwrap();
    let status = health_status_at(&directory, &registry, &id);
    assert_eq!(status.health_code, "ready");
    assert_eq!(status.model_protocols, revision.model_protocols);
    registry.plugins.get_mut(&id).unwrap().enabled = false;
    assert!(health_status_at(&directory, &registry, &id).model_protocols.is_empty());
    let mut changed = revision.clone();
    changed.model_protocols[0].adapter = "openai-compatible".into();
    assert!(stage_revision_at(&directory, id.clone(), changed, source, None).is_err());
    registry = read_registry_at(&directory).unwrap();
    assert_eq!(health_status_at(&directory, &registry, &id).model_protocols, revision.model_protocols);
    fs::write(revision_file(&directory, &id, &revision), "changed").unwrap();
    let damaged = health_status_at(&directory, &registry, &id);
    assert_eq!(damaged.health_code, "invalid");
    assert!(damaged.model_protocols.is_empty());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn dependency_metadata_requires_capability_and_rejects_unknown_or_self_references() {
    let mut value = manifest("javascript");
    value["dependencies"] = json!([{ "pluginId": "example.base", "minVersion": "1.0.0" }]);
    assert!(parse_revision(&value, "source", None).is_err());
    value["apiVersion"] = json!(2);
    value["requiredCapabilities"] = json!(["plugin.dependencies"]);
    let (_, revision) = parse_revision(&value, "source", None).unwrap();
    assert_eq!(revision.dependencies[0].plugin_id, "example.base");
    value["dependencies"][0]["service"] = json!("internal");
    assert!(parse_revision(&value, "source", None).is_err());
    value["dependencies"] = json!([{ "pluginId": "example.plugin" }]);
    assert!(parse_revision(&value, "source", None).is_err());
}

#[test]
fn dependency_graph_blocks_missing_versions_cycles_and_changes_fingerprint() {
    let mut value = manifest("javascript");
    value["apiVersion"] = json!(2);
    value["requiredCapabilities"] = json!(["plugin.dependencies"]);
    value["dependencies"] = json!([{ "pluginId": "example.base", "minVersion": "1.0.0" }]);
    let (_, revision) = parse_revision(&value, "source", None).unwrap();
    let mut registry = PluginRegistry::default();
    let record = |id: &str, active: PluginRevision| PluginRegistration { plugin_id: id.into(), enabled: true,
        active: Some(active), previous: None, staged: None, installed_at: 1, updated_at: 1 };
    registry.plugins.insert("example.plugin".into(), record("example.plugin", revision));
    assert!(dependency_fingerprint(&registry, "example.plugin").is_err());
    let (_, base) = parse_revision(&manifest("javascript"), "base", None).unwrap();
    registry.plugins.insert("example.base".into(), record("example.base", base));
    let before = dependency_fingerprint(&registry, "example.plugin").unwrap();
    let base = registry.plugins.get_mut("example.base").unwrap().active.as_mut().unwrap();
    base.revision_digest = "d".repeat(64);
    assert_ne!(before, dependency_fingerprint(&registry, "example.plugin").unwrap());
    registry.plugins.get_mut("example.base").unwrap().active.as_mut().unwrap().dependencies = vec![PluginDependency {
        plugin_id: "example.plugin".into(), min_version: None, optional: true,
    }];
    assert!(dependency_fingerprint(&registry, "example.plugin").is_err());
}

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
fn plugin_prompt_references_require_explicit_compatible_declaration() {
    let mut value = manifest("javascript");
    value["permissions"] = json!(["node.read", "node.write", "prompt.references.read"]);
    assert!(parse_revision(&value, "source", None).is_err());
    value["apiVersion"] = json!(2);
    assert!(parse_revision(&value, "source", None).is_err());
    value["requiredCapabilities"] = json!(["prompt.mentions"]);
    let (_, revision) = parse_revision(&value, "source", None).unwrap();
    assert!(revision.permissions.iter().any(|item| item == "prompt.references.read"));
    let mut forged = revision.clone();
    forged.required_capabilities.clear();
    assert!(validate_stored_revision(&forged).is_err());
}

#[test]
fn wsagent_shared_plugin_permission_requires_the_designated_api2_bundle() {
    let mut value = manifest("javascript");
    value["apiVersion"] = json!(2);
    value["permissions"] = json!(["node.read", "node.write", "wsagent.shared-images"]);
    value["requiredCapabilities"] = json!(["wsagent.sharedImages"]);
    assert!(parse_revision(&value, "source", None).is_err());
    value["id"] = json!("ai-canvas.wsagent");
    let (_, revision) = parse_revision(&value, "source", None).unwrap();
    assert!(revision_requests_native_approval(&revision));
    value["requiredCapabilities"] = json!([]);
    assert!(parse_revision(&value, "source", None).is_err());
}

#[test]
fn plugin_python_media_declarations_require_native_manifest_authority() {
    let source = "define_plugin({'tools': {}})";
    let mut value = manifest("python");
    value["apiVersion"] = json!(2);
    value["permissions"] = json!([
        "node.read",
        "node.write",
        "files.connected.read",
        "files.output.create"
    ]);
    value["requiredCapabilities"] = json!(["python.executionTimeout", "python.mediaWorkspace"]);
    value["contributes"]["nodeTools"][0]["resourceAccess"] = json!({"self": true});
    value["contributes"]["nodeTools"][0]["output"] = json!({"mode": "create-node-set"});
    value["contributes"]["nodeTools"][0]["pythonExecution"] =
        json!({"timeoutSeconds": 120, "mediaWorkspace": true});
    let (_, revision) = parse_revision(&value, source, None).unwrap();
    assert_eq!(revision.python_execution["upper"].timeout_seconds, 120);
    assert!(revision.python_execution["upper"].media_workspace);
    let mut changed = revision.clone();
    changed
        .python_execution
        .get_mut("upper")
        .unwrap()
        .timeout_seconds = 30;
    assert!(!revision_security_manifest_matches(&revision, &changed));
    for raw in [
        json!({"timeoutSeconds": 121}),
        json!({"timeoutSeconds": 29}),
        json!({"timeoutSeconds": 90.5}),
        json!({"unknown": true}),
    ] {
        let mut bad = value.clone();
        bad["contributes"]["nodeTools"][0]["pythonExecution"] = raw;
        assert!(parse_revision(&bad, source, None).is_err());
    }
    for capabilities in [
        json!([]),
        json!(["python.executionTimeout"]),
        json!(["python.mediaWorkspace"]),
    ] {
        let mut bad = value.clone();
        bad["requiredCapabilities"] = capabilities;
        assert!(parse_revision(&bad, source, None).is_err());
    }
    let mut bad = value.clone();
    bad["contributes"]["nodeTools"][0]["resourceAccess"]["self"] = json!(false);
    assert!(parse_revision(&bad, source, None).is_err());
    bad = value.clone();
    bad["runtime"] = json!("javascript");
    bad["entry"] = json!("main.js");
    assert!(parse_revision(&bad, "definePlugin({});", None).is_err());
    bad = value.clone();
    bad["apiVersion"] = json!(1);
    assert!(parse_revision(&bad, source, None).is_err());
    value["contributes"]["nodeTools"][0]
        .as_object_mut()
        .unwrap()
        .remove("pythonExecution");
    assert!(parse_revision(&value, source, None)
        .unwrap()
        .1
        .python_execution
        .is_empty());
}

#[test]
fn api_two_requirements_are_checked_natively_and_retained_for_future_execution() {
    let mut value = manifest("javascript");
    value["apiVersion"] = json!(2);
    value["minHostVersion"] = json!(env!("CARGO_PKG_VERSION"));
    value["requiredCapabilities"] = json!(["javascript.async", "invocation.cancel"]);
    let (_, revision) = parse_revision(&value, "definePlugin({});", None).unwrap();
    assert_eq!(
        revision.min_host_version.as_deref(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    ensure_native_execution_approved(&revision).unwrap();
    let directory = temporary_directory("compatibility-schema");
    let mut registry = PluginRegistry::default();
    registry.plugins.insert(
        "plugin.compatibility".into(),
        PluginRegistration {
            plugin_id: "plugin.compatibility".into(),
            enabled: true,
            active: Some(revision.clone()),
            previous: None,
            staged: None,
            installed_at: 1,
            updated_at: 1,
        },
    );
    write_registry_at(&directory, &registry).unwrap();
    let persisted = read_registry_at(&directory).unwrap();
    assert_eq!(persisted.schema_version, 2);
    assert_eq!(
        persisted.plugins["plugin.compatibility"]
            .active
            .as_ref()
            .unwrap(),
        &revision
    );
    let record = registry.plugins.get_mut("plugin.compatibility").unwrap();
    record.active.as_mut().unwrap().min_host_version = None;
    record
        .active
        .as_mut()
        .unwrap()
        .required_capabilities
        .clear();
    write_registry_at(&directory, &registry).unwrap();
    assert_eq!(read_registry_at(&directory).unwrap().schema_version, 1);
    fs::remove_dir_all(directory).unwrap();
    let mut unsupported = revision.clone();
    unsupported.required_capabilities = vec!["unknown.feature".into()];
    // 不兼容的单个插件不能把整个注册表判成损坏，但任何执行都必须拒绝。
    validate_stored_revision(&unsupported).unwrap();
    assert!(ensure_native_execution_approved(&unsupported).is_err());
    for requirement in [
        json!("999.0.0"),
        json!("0.09.23"),
        json!("0.9.23-beta"),
        Value::Null,
    ] {
        value["minHostVersion"] = requirement;
        assert!(parse_revision(&value, "definePlugin({});", None).is_err());
    }
    value["minHostVersion"] = json!(env!("CARGO_PKG_VERSION"));
    value["apiVersion"] = json!(1);
    assert!(parse_revision(&value, "definePlugin({});", None).is_err());
    value["apiVersion"] = json!(2);
    value["requiredCapabilities"] = json!(["unknown.feature"]);
    assert!(parse_revision(&value, "definePlugin({});", None).is_err());
}

#[test]
fn network_grants_require_native_approval_and_exact_active_revision() {
    let directory = temporary_directory("host-authority");
    let source = "definePlugin({ tools: {} });";
    let mut value = manifest("javascript");
    value["permissions"] = json!([
        "node.read",
        "node.write",
        "network.request",
        "settings.read",
        "settings.write"
    ]);
    value["network"] = json!({ "allowedOrigins": ["https://api.example.com"] });
    let (plugin_id, mut revision) = parse_revision(&value, source, None).unwrap();
    assert!(!native_stage_decision(&revision, None));
    assert!(apply_native_stage_approval(&mut revision, Some(true)));
    assert!(
        build_python_approval_prompt(NativeApprovalAction::Stage, &plugin_id, &revision)
            .message
            .contains("https://api.example.com")
    );
    stage_revision_at(
        &directory,
        plugin_id.clone(),
        revision.clone(),
        source,
        None,
    )
    .unwrap();
    let mut registry = read_registry_at(&directory).unwrap();
    commit_activation_at(
        &directory,
        &mut registry,
        &plugin_id,
        &revision.revision_digest,
        true,
        false,
    )
    .unwrap();
    let identity = crate::plugin_host_effects::PluginHostIdentity {
        plugin_id: plugin_id.clone(),
        source_digest: revision.source_digest.clone(),
        revision_digest: revision.revision_digest.clone(),
        tool_id: "upper".into(),
        invocation_id: "test-request".into(),
    };
    assert_eq!(
        with_plugin_host_authority_at(&directory, &identity, |_, grant| Ok(grant
            .network_origins
            .clone()))
        .unwrap(),
        ["https://api.example.com"]
    );
    let mut stale = identity.clone();
    stale.revision_digest = "f".repeat(64);
    assert!(with_plugin_host_authority_at(&directory, &stale, |_, _| Ok(())).is_err());
    stale = identity.clone();
    stale.tool_id = "undeclared".into();
    assert!(with_plugin_host_authority_at(&directory, &stale, |_, _| Ok(())).is_err());
    value["network"] = json!({ "allowedOrigins": ["https://other.example.com"] });
    let (_, changed) = parse_revision(&value, source, None).unwrap();
    assert_ne!(revision.revision_digest, changed.revision_digest);
    registry.plugins.get_mut(&plugin_id).unwrap().enabled = false;
    write_registry_at(&directory, &registry).unwrap();
    assert!(with_plugin_host_authority_at(&directory, &identity, |_, _| Ok(())).is_err());
    fs::remove_dir_all(directory).unwrap();
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
fn cached_resources_reuse_verified_bytes_and_reject_changed_or_missing_files() {
    let directory = temporary_directory("cached-resources");
    let bytes = b"ABC".to_vec();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let mut value = manifest("javascript");
    value["permissions"] = json!(["plugin.resources.read"]);
    value["resources"] = json!([{
        "id": "template", "path": "resources/template.txt",
        "integrity": digest, "mediaType": "text/plain", "bytes": bytes.len()
    }]);
    let payloads = vec![PluginPackageResourcePayload {
        id: "template".into(),
        bytes: bytes.clone(),
    }];
    let (id, revision) =
        parse_revision_with_resources(&value, "definePlugin({ tools: {} });", None, &payloads)
            .unwrap();
    write_resource_snapshots_at(&directory, &id, &revision, &payloads).unwrap();
    let mut cache = VerifiedResourceCache::default();
    let first =
        read_cached_resource_at(&directory, &id, &revision, "template", &mut cache).unwrap();
    for _ in 0..64 {
        let next = read_cached_resource_at(&directory, &id, &revision, "template", &mut cache)
            .unwrap();
        assert!(Arc::ptr_eq(&first, &next));
    }
    assert_eq!(cache.bytes, bytes.len());
    let path = resource_snapshot_path(&directory, &id, &revision, "template");
    fs::write(&path, b"ABD").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(SystemTime::now() + std::time::Duration::from_secs(2))
        .unwrap();
    assert!(
        read_cached_resource_at(&directory, &id, &revision, "template", &mut cache)
            .unwrap_err()
            .contains("摘要不匹配")
    );
    fs::remove_file(&path).unwrap();
    assert!(
        read_cached_resource_at(&directory, &id, &revision, "template", &mut cache).is_err()
    );
    // 缓存持有的是先前已验证的不可变内容，磁盘篡改不会改变它。
    assert_eq!(first.as_ref(), bytes.as_slice());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn cached_resources_evict_lru_at_byte_budget() {
    let directory = temporary_directory("resource-cache-byte-budget");
    let payloads: Vec<_> = (0..3)
        .map(|index| PluginPackageResourcePayload {
            id: format!("resource-{index}"),
            bytes: vec![index as u8; MAX_PACKAGE_RESOURCE_BYTES],
        })
        .collect();
    let resources: Vec<_> = payloads
        .iter()
        .map(|payload| {
            json!({
                "id": payload.id, "path": format!("resources/{}.bin", payload.id),
                "integrity": format!("{:x}", Sha256::digest(&payload.bytes)),
                "mediaType": "application/octet-stream", "bytes": payload.bytes.len()
            })
        })
        .collect();
    let mut value = manifest("javascript");
    value["permissions"] = json!(["plugin.resources.read"]);
    value["resources"] = json!(resources);
    let (id, revision) =
        parse_revision_with_resources(&value, "definePlugin({ tools: {} });", None, &payloads)
            .unwrap();
    write_resource_snapshots_at(&directory, &id, &revision, &payloads).unwrap();
    let mut cache = VerifiedResourceCache::default();
    let first =
        read_cached_resource_at(&directory, &id, &revision, "resource-0", &mut cache).unwrap();
    read_cached_resource_at(&directory, &id, &revision, "resource-1", &mut cache).unwrap();
    assert_eq!(cache.bytes, MAX_VERIFIED_RESOURCE_CACHE_BYTES);
    assert_eq!(cache.entries.len(), 2);
    let reused =
        read_cached_resource_at(&directory, &id, &revision, "resource-0", &mut cache).unwrap();
    assert!(Arc::ptr_eq(&first, &reused));
    // 命中 0 后应淘汰更久没读的 1；这次触及的是字节上限，而非条目上限。
    read_cached_resource_at(&directory, &id, &revision, "resource-2", &mut cache).unwrap();
    assert_eq!(cache.bytes, MAX_VERIFIED_RESOURCE_CACHE_BYTES);
    assert_eq!(cache.entries.len(), 2);
    assert_eq!(
        cache
            .entries
            .iter()
            .map(|entry| entry.path.file_name().unwrap().to_str().unwrap())
            .collect::<Vec<_>>(),
        ["resource-0.bin", "resource-2.bin"]
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn cached_resources_are_bounded_and_plugin_revocation_releases_them() {
    let directory = temporary_directory("bounded-resource-cache");
    let payloads: Vec<_> = (0..17)
        .map(|index| PluginPackageResourcePayload {
            id: format!("resource-{index}"),
            bytes: vec![index as u8; 64],
        })
        .collect();
    let resources: Vec<_> = payloads
        .iter()
        .map(|payload| {
            json!({
                "id": payload.id, "path": format!("resources/{}.bin", payload.id),
                "integrity": format!("{:x}", Sha256::digest(&payload.bytes)),
                "mediaType": "application/octet-stream", "bytes": payload.bytes.len()
            })
        })
        .collect();
    let mut value = manifest("javascript");
    value["permissions"] = json!(["plugin.resources.read"]);
    value["resources"] = json!(resources);
    let (id, revision) =
        parse_revision_with_resources(&value, "definePlugin({ tools: {} });", None, &payloads)
            .unwrap();
    write_resource_snapshots_at(&directory, &id, &revision, &payloads).unwrap();
    let mut cache = VerifiedResourceCache::default();
    for payload in &payloads {
        read_cached_resource_at(&directory, &id, &revision, &payload.id, &mut cache).unwrap();
    }
    assert_eq!(cache.entries.len(), MAX_VERIFIED_RESOURCE_CACHE_ENTRIES);
    assert_eq!(cache.bytes, 16 * 64);
    assert!(cache.bytes <= MAX_VERIFIED_RESOURCE_CACHE_BYTES);
    assert!(cache
        .entries
        .iter()
        .all(|entry| !entry.path.ends_with("resource-0.bin")));
    // 使用独立插件 ID，不影响并行执行的其他测试缓存。
    let revoked_id = format!(
        "cached-{}",
        directory.file_name().unwrap().to_string_lossy()
    );
    for entry in &mut cache.entries {
        entry.plugin_id = revoked_id.clone();
    }
    {
        let mut shared = verified_resource_cache().lock().unwrap();
        shared.bytes += cache.bytes;
        shared.entries.extend(cache.entries);
    }
    revoke_verified_resources(Some(&revoked_id));
    let shared = verified_resource_cache().lock().unwrap();
    assert!(shared
        .entries
        .iter()
        .all(|entry| entry.plugin_id != revoked_id));
    assert_eq!(
        shared.bytes,
        shared
            .entries
            .iter()
            .map(|entry| entry.bytes.len())
            .sum::<usize>()
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
fn native_stage_gate_records_approval_for_python_and_custom_ui() {
    let (_, mut javascript) = parse_revision(&manifest("javascript"), "source", None).unwrap();
    let (_, python) = parse_revision(&manifest("python"), "source", None).unwrap();
    assert!(native_stage_decision(&javascript, None));
    assert!(native_stage_decision(&javascript, Some(false)));
    assert!(!native_stage_decision(&python, None));
    assert!(!native_stage_decision(&python, Some(false)));
    assert!(native_stage_decision(&python, Some(true)));

    javascript.permissions.push("ui.custom".to_string());
    javascript.permissions.sort();
    assert!(!apply_native_stage_approval(&mut javascript, None));
    assert!(!apply_native_stage_approval(&mut javascript, Some(false)));
    assert!(apply_native_stage_approval(&mut javascript, Some(true)));
    assert!(javascript.native_approved);
}

#[test]
fn approved_javascript_custom_ui_revision_can_be_staged_and_reloaded() {
    let directory = temporary_directory("javascript-custom-ui-approval");
    let source = "definePlugin({ tools: {} });";
    let ui_source = "globalThis.VideoFrameReview = () => null;";
    let ui_digest = format!("{:x}", Sha256::digest(ui_source.as_bytes()));
    let mut value = manifest("javascript");
    value["permissions"] = json!(["node.read", "node.write", "ui.custom"]);
    value["ui"] = json!({
        "entry": "ui.js",
        "integrity": format!("sha256-{ui_digest}"),
        "exports": { "frameReview": "VideoFrameReview" }
    });
    let (plugin_id, mut revision) = parse_revision(&value, source, Some(ui_source)).unwrap();

    assert!(apply_native_stage_approval(&mut revision, Some(true)));
    stage_revision_at(
        &directory,
        plugin_id.clone(),
        revision.clone(),
        source,
        Some(ui_source),
    )
    .unwrap();

    let loaded = read_registry_at(&directory).unwrap();
    assert_eq!(
        loaded
            .plugins
            .get(&plugin_id)
            .and_then(|record| record.staged.as_ref()),
        Some(&revision),
    );
    fs::remove_dir_all(directory).ok();
}

fn activate_window_fixture(directory: &Path, source: &str) -> PluginUiIdentity {
    let ui_source = "globalThis.Review = () => null;";
    let ui_digest = format!("{:x}", Sha256::digest(ui_source.as_bytes()));
    let mut value = manifest("javascript");
    value["permissions"] = json!(["node.read", "node.write", "ui.custom"]);
    value["ui"] = json!({ "entry": "ui.js", "integrity": format!("sha256-{ui_digest}"),
        "exports": { "review": "Review" } });
    let (plugin_id, mut revision) = parse_revision(&value, source, Some(ui_source)).unwrap();
    assert!(apply_native_stage_approval(&mut revision, Some(true)));
    stage_revision_at(
        directory,
        plugin_id.clone(),
        revision.clone(),
        source,
        Some(ui_source),
    )
    .unwrap();
    let mut registry = read_registry_at(directory).unwrap();
    commit_activation_at(
        directory,
        &mut registry,
        &plugin_id,
        &revision.revision_digest,
        true,
        false,
    )
    .unwrap();
    PluginUiIdentity {
        plugin_id,
        source_digest: revision.source_digest,
        revision_digest: revision.revision_digest,
        ui_digest,
        tool_id: "upper".into(),
    }
}

#[test]
fn window_ui_requires_all_active_digests_tool_ownership_and_approval() {
    let directory = temporary_directory("window-ui-identity");
    let identity = activate_window_fixture(&directory, "first source");
    assert!(with_active_window_ui(&directory, &identity, |source| {
        assert_eq!(source, "globalThis.Review = () => null;");
        Ok(())
    })
    .is_ok());
    let mut encoded = serde_json::to_value(&identity).unwrap();
    for key in [
        "pluginId",
        "sourceDigest",
        "revisionDigest",
        "uiDigest",
        "toolId",
    ] {
        let old = encoded[key].clone();
        encoded[key] = if key.ends_with("Digest") {
            json!("0".repeat(64))
        } else {
            json!("unknown")
        };
        let forged = serde_json::from_value(encoded.clone()).unwrap();
        assert!(with_active_window_ui::<()>(&directory, &forged, |_| panic!(
            "invalid identity reached operation"
        ))
        .is_err());
        encoded[key] = old;
    }
    let mut registry = read_registry_at(&directory).unwrap();
    registry
        .plugins
        .get_mut(&identity.plugin_id)
        .unwrap()
        .active
        .as_mut()
        .unwrap()
        .native_approved = false;
    write_registry_at(&directory, &registry).unwrap();
    assert!(with_active_window_ui(&directory, &identity, |_| Ok(())).is_err());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn unchanged_ui_bundle_cannot_keep_a_stale_source_revision_alive() {
    let directory = temporary_directory("window-ui-source-revision");
    let previous = activate_window_fixture(&directory, "first source");
    let current = activate_window_fixture(&directory, "second source");
    assert_eq!(previous.ui_digest, current.ui_digest);
    assert_ne!(previous.revision_digest, current.revision_digest);
    assert!(with_active_window_ui(&directory, &previous, |_| Ok(())).is_err());
    assert!(with_active_window_ui(&directory, &current, |_| Ok(())).is_ok());
    let mut registry = read_registry_at(&directory).unwrap();
    registry
        .plugins
        .get_mut(&current.plugin_id)
        .unwrap()
        .enabled = false;
    write_registry_at(&directory, &registry).unwrap();
    assert!(with_active_window_ui(&directory, &current, |_| Ok(())).is_err());
    registry.plugins.clear();
    write_registry_at(&directory, &registry).unwrap();
    assert!(with_active_window_ui(&directory, &current, |_| Ok(())).is_err());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn window_ui_rehashes_both_private_sources_before_each_operation() {
    let directory = temporary_directory("window-ui-tamper");
    let identity = activate_window_fixture(&directory, "first source");
    let registry = read_registry_at(&directory).unwrap();
    let revision = registry.plugins[&identity.plugin_id]
        .active
        .as_ref()
        .unwrap();
    let source_path = revision_file(&directory, &identity.plugin_id, revision);
    fs::write(&source_path, "changed source").unwrap();
    assert!(with_active_window_ui(&directory, &identity, |_| Ok(())).is_err());
    fs::write(source_path, "first source").unwrap();
    let ui_path = ui_snapshot_path(&directory, &identity.plugin_id, revision).unwrap();
    fs::write(ui_path, "changed ui").unwrap();
    assert!(with_active_window_ui(&directory, &identity, |_| Ok(())).is_err());
    fs::remove_dir_all(directory).ok();
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
