use super::super::{
    persistence::{read_registry_file, registry_backup_file, registry_file, registry_temp_file},
    private_storage::{
        copy_legacy_plugin_entry, finish_prepared_plugin_directory_at, migrate_legacy_plugin_directory_at,
        migration_entry_limit, probe_plugin_storage_writable, publish_prepared_entry, source_storage_error,
        storage_io_error, storage_permission_denied,
    },
    snapshots::revision_directory,
};
use super::*;
use std::io;

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
        network_origins: Vec::new(),
        min_host_version: None,
        required_capabilities: Vec::new(),
        dependencies: Vec::new(),
        declared_tool_ids,
        model_protocols: Vec::new(),
        python_execution: BTreeMap::new(),
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
fn repairs_corrupt_registry_and_removes_private_snapshots() {
    let directory = temporary_directory("repair-corrupt-registry");
    fs::create_dir_all(directory.join(REVISIONS_DIR_NAME).join("stale.plugin")).unwrap();
    fs::create_dir_all(directory.join(UI_REVISIONS_DIR_NAME).join("stale.plugin")).unwrap();
    fs::write(registry_file(&directory), b"not-json").unwrap();

    assert!(repair_corrupt_registry_at(&directory).unwrap());
    assert!(read_registry_at(&directory).unwrap().plugins.is_empty());
    assert!(!directory.join(REVISIONS_DIR_NAME).exists());
    assert!(!directory.join(UI_REVISIONS_DIR_NAME).exists());
    assert!(!repair_corrupt_registry_at(&directory).unwrap());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn repair_does_not_treat_unsafe_registry_path_as_corruption() {
    let directory = temporary_directory("repair-unsafe-registry");
    fs::create_dir_all(registry_file(&directory)).unwrap();

    assert_eq!(
        repair_corrupt_registry_at(&directory).unwrap_err(),
        "插件信任注册表不安全或超过大小限制"
    );
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
    let root = PathBuf::from(PRIVATE_DIR_NAME);
    assert!(is_under_plugin_private_dir(
        &root,
        &root.join("revisions/example.plugin")
    ));
    assert!(!is_under_plugin_private_dir(
        &root,
        &PathBuf::from("plugin-public")
    ));
}

#[test]
fn plugin_storage_migration_preserves_registration_and_persistent_files() {
    let directory = temporary_directory("storage-migration");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    let source = "definePlugin({ tools: {} }); // 中文源码\n";
    let ui_source = "globalThis.FrameReview = () => '界面';";
    let resource_bytes = vec![0, 128, 255];
    let payloads = vec![PluginPackageResourcePayload {
        id: "image".into(),
        bytes: resource_bytes.clone(),
    }];
    let mut value = manifest("javascript");
    value["permissions"] = json!(["node.read", "node.write", "ui.custom", "plugin.resources.read"]);
    value["ui"] = json!({
        "entry": "ui.js", "integrity": source_digest(ui_source),
        "exports": { "frameReview": "FrameReview" }
    });
    value["resources"] = json!([{
        "id": "image", "path": "resources/image.bin",
        "integrity": format!("{:x}", Sha256::digest(&resource_bytes)),
        "mediaType": "application/octet-stream", "bytes": resource_bytes.len()
    }]);
    let (id, mut revision) =
        parse_revision_with_resources(&value, source, Some(ui_source), &payloads).unwrap();
    assert!(apply_native_stage_approval(&mut revision, Some(true)));
    stage_revision_with_resources_at(
        &legacy, id.clone(), revision.clone(), source, Some(ui_source), &payloads,
    ).unwrap();
    let mut registry = read_registry_at(&legacy).unwrap();
    let record = registry.plugins.get_mut(&id).unwrap();
    record.active = record.staged.take();
    record.enabled = true;
    write_registry_at(&legacy, &registry).unwrap();
    ensure_private_directory(&legacy.join("settings")).unwrap();
    fs::write(
        legacy.join("settings/example.plugin.json"),
        br#"{"language":"zh-CN"}"#,
    ).unwrap();
    ensure_private_directory(&legacy.join("window-profiles")).unwrap();
    ensure_private_directory(&legacy.join("media-jobs")).unwrap();

    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).unwrap());
    let migrated = read_registry_at(&target).unwrap();
    assert_eq!(migrated.plugins, registry.plugins);
    assert_eq!(
        read_verified_source_at(&target, &id, &revision).unwrap(),
        source,
    );
    assert_eq!(
        fs::read(target.join("settings/example.plugin.json")).unwrap().as_slice(),
        br#"{"language":"zh-CN"}"#,
    );
    assert_eq!(
        read_verified_resource_at(&target, &id, &revision, "image").unwrap(),
        resource_bytes,
    );
    assert_eq!(
        read_verified_ui_source_at(&target, &id, &revision).unwrap().as_deref(),
        Some(ui_source),
    );
    assert!(!target.join("window-profiles").exists());
    assert!(!target.join("media-jobs").exists());
    assert!(legacy.exists());
    assert!(plugin_private_paths_overlap(&target, &directory));
    assert!(!plugin_private_paths_overlap(&target, &directory.join("theme")));
    fs::remove_dir_all(directory).ok();
}

fn mark_permission_prepared(directory: &Path) {
    ensure_private_directory(directory).unwrap();
    fs::write(
        directory.join(crate::plugin_install_permissions::PREPARED_MARKER),
        crate::plugin_install_permissions::PREPARED_MARKER_CONTENT,
    ).unwrap();
}

#[test]
fn prepared_storage_keeps_registry_closed_until_ordinary_user_migration_finishes() {
    let directory = temporary_directory("permission-migration");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    let source = "definePlugin({ tools: {} }); // 权限迁移\n";
    let (id, revision) = parse_revision(&manifest("javascript"), source, None).unwrap();
    stage_revision_at(&legacy, id.clone(), revision.clone(), source, None).unwrap();
    ensure_private_directory(&legacy.join("settings")).unwrap();
    fs::write(legacy.join("settings/example.plugin.json"), br#"{"ready":true}"#).unwrap();
    ensure_private_directory(&legacy.join("window-profiles")).unwrap();
    mark_permission_prepared(&target);

    assert!(read_registry_at(&target).unwrap_err().contains("初始化尚未完成"));
    finish_prepared_plugin_directory_at(&legacy, &target).unwrap();
    assert!(!prepared_plugin_directory(&target).unwrap());
    assert_eq!(read_registry_at(&target).unwrap().plugins, read_registry_at(&legacy).unwrap().plugins);
    assert_eq!(read_verified_source_at(&target, &id, &revision).unwrap(), source);
    assert_eq!(fs::read(target.join("settings/example.plugin.json")).unwrap(), br#"{"ready":true}"#);
    assert!(!target.join("window-profiles").exists());
    assert!(legacy.exists());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn prepared_storage_without_legacy_becomes_writable_without_extra_data() {
    let directory = temporary_directory("permission-fresh");
    let target = directory.join(PRIVATE_DIR_NAME);
    mark_permission_prepared(&target);
    finish_prepared_plugin_directory_at(&directory.join(LEGACY_PRIVATE_DIR_NAME), &target).unwrap();
    probe_plugin_storage_writable(&target, "example.plugin", None).unwrap();
    assert!(fs::read_dir(&target).unwrap().next().is_none());
    assert!(read_registry_at(&target).unwrap().plugins.is_empty());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn storage_probe_checks_the_current_plugin_ancestors_without_modifying_conflicting_files() {
    let directory = temporary_directory("permission-plugin-ancestor");
    ensure_private_directory(&directory.join(REVISIONS_DIR_NAME)).unwrap();
    let conflict = directory.join(REVISIONS_DIR_NAME).join("example.plugin");
    fs::write(&conflict, "keep this file").unwrap();
    assert!(probe_plugin_storage_writable(&directory, "example.plugin", Some("revision"))
        .unwrap_err().contains("必须是普通目录"));
    assert_eq!(fs::read_to_string(&conflict).unwrap(), "keep this file");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn prepared_storage_resumes_equal_published_entries_without_reimporting_after_completion() {
    let directory = temporary_directory("permission-resume");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    ensure_private_directory(&legacy.join("settings")).unwrap();
    fs::write(legacy.join("settings/example.plugin.json"), "original").unwrap();
    mark_permission_prepared(&target);
    let mut remaining = migration_entry_limit();
    copy_legacy_plugin_entry(&legacy.join("settings"), &target.join("settings"), 0, &mut remaining).unwrap();
    finish_prepared_plugin_directory_at(&legacy, &target).unwrap();
    fs::write(legacy.join("settings/example.plugin.json"), "stale source changed").unwrap();
    finish_prepared_plugin_directory_at(&legacy, &target).unwrap();
    assert_eq!(fs::read_to_string(target.join("settings/example.plugin.json")).unwrap(), "original");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn prepared_storage_conflict_preserves_both_versions_and_blocks_execution() {
    let directory = temporary_directory("permission-conflict");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    ensure_private_directory(&legacy.join("settings")).unwrap();
    fs::write(legacy.join("settings/example.plugin.json"), "legacy").unwrap();
    mark_permission_prepared(&target);
    ensure_private_directory(&target.join("settings")).unwrap();
    fs::write(target.join("settings/example.plugin.json"), "different").unwrap();
    assert!(finish_prepared_plugin_directory_at(&legacy, &target).unwrap_err().contains("内容冲突"));
    assert!(prepared_plugin_directory(&target).unwrap());
    assert!(read_registry_at(&target).is_err());
    assert_eq!(fs::read_to_string(target.join("settings/example.plugin.json")).unwrap(), "different");
    assert_eq!(fs::read_to_string(legacy.join("settings/example.plugin.json")).unwrap(), "legacy");
    // 冲突不会自动覆盖；用户明确恢复一致内容后，同一初始化可以继续。
    fs::write(target.join("settings/example.plugin.json"), "legacy").unwrap();
    finish_prepared_plugin_directory_at(&legacy, &target).unwrap();
    assert!(!prepared_plugin_directory(&target).unwrap());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn prepared_storage_rejects_invalid_marker_or_disappearing_source() {
    let directory = temporary_directory("permission-invalid-state");
    let target = directory.join(PRIVATE_DIR_NAME);
    mark_permission_prepared(&target);
    let marker = target.join(crate::plugin_install_permissions::PREPARED_MARKER);
    fs::write(&marker, "invalid").unwrap();
    assert!(prepared_plugin_directory(&target).is_err());
    mark_permission_prepared(&target);
    ensure_private_directory(&target.join("settings")).unwrap();
    assert!(finish_prepared_plugin_directory_at(&directory.join("missing"), &target).is_err());
    assert!(prepared_plugin_directory(&target).unwrap());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn permission_classification_only_requests_elevation_for_target_access_denied() {
    let denied = storage_io_error("无法创建插件目录", &io::Error::new(io::ErrorKind::PermissionDenied, "private/local/path"));
    assert!(storage_permission_denied(&denied));
    assert!(!denied.contains("private/local/path"));
    assert!(!storage_permission_denied(&source_storage_error(denied)));
    assert!(!storage_permission_denied(&storage_io_error("无法创建插件目录", &io::Error::from(io::ErrorKind::AlreadyExists))));
    assert!(!storage_permission_denied(&storage_io_error("无法创建插件目录", &io::Error::from(io::ErrorKind::NotFound))));
    assert!(!storage_permission_denied("插件私有目录必须是普通目录，不能使用符号链接或目录联接"));
}

#[test]
fn prepared_publish_never_replaces_existing_file() {
    let directory = temporary_directory("permission-publish");
    ensure_private_directory(&directory).unwrap();
    let source = directory.join("source");
    let target = directory.join("target");
    fs::write(&source, "new").unwrap();
    fs::write(&target, "existing").unwrap();
    assert!(publish_prepared_entry(&source, &target).is_err());
    assert_eq!(fs::read_to_string(&source).unwrap(), "new");
    assert_eq!(fs::read_to_string(&target).unwrap(), "existing");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn plugin_storage_migration_never_overwrites_or_reimports_existing_storage() {
    let directory = temporary_directory("storage-existing");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    ensure_private_directory(&legacy).unwrap();
    ensure_private_directory(&target).unwrap();
    fs::write(registry_file(&legacy), "legacy").unwrap();
    fs::write(registry_file(&target), "current").unwrap();
    assert!(!migrate_legacy_plugin_directory_at(&legacy, &target).unwrap());
    assert_eq!(fs::read_to_string(registry_file(&target)).unwrap(), "current");
    fs::remove_file(registry_file(&target)).unwrap();
    assert!(!migrate_legacy_plugin_directory_at(&legacy, &target).unwrap());
    assert!(!registry_file(&target).exists());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn plugin_storage_migration_retains_corrupt_registry_for_explicit_repair() {
    let directory = temporary_directory("storage-corrupt");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    ensure_private_directory(&legacy).unwrap();
    fs::write(registry_file(&legacy), "corrupt registry").unwrap();
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).unwrap());
    assert!(is_repairable_registry_error(
        &read_registry_at(&target).unwrap_err(),
    ));
    assert_eq!(
        fs::read_to_string(registry_file(&legacy)).unwrap(),
        "corrupt registry",
    );
    fs::remove_dir_all(directory).ok();
}

#[test]
fn plugin_storage_migration_keeps_legacy_data_after_failure_and_can_retry() {
    let directory = temporary_directory("storage-retry");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    ensure_private_directory(&legacy).unwrap();
    fs::write(registry_file(&legacy), "legacy registry").unwrap();
    let oversized = fs::File::create(legacy.join(REGISTRY_BACKUP_FILE_NAME)).unwrap();
    oversized.set_len(MAX_PACKAGE_RESOURCE_BYTES as u64 + 1).unwrap();
    drop(oversized);
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).is_err());
    assert!(!target.exists());
    assert!(registry_file(&legacy).exists());
    assert!(!directory.join(MIGRATION_DIR_NAME).exists());
    fs::remove_file(legacy.join(REGISTRY_BACKUP_FILE_NAME)).unwrap();
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).unwrap());
    fs::remove_dir_all(directory).ok();
}

#[test]
fn plugin_storage_migration_requires_plain_directories() {
    let directory = temporary_directory("storage-path-type");
    ensure_private_directory(&directory).unwrap();
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    assert!(!migrate_legacy_plugin_directory_at(&legacy, &target).unwrap());
    assert!(!target.exists());
    fs::write(&target, "occupied").unwrap();
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "occupied");
    fs::remove_file(&target).unwrap();
    fs::write(&legacy, "occupied").unwrap();
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).is_err());
    assert!(!target.exists());
    fs::remove_dir_all(directory).ok();
}

#[cfg(unix)]
#[test]
fn plugin_storage_migration_rejects_links_and_preserves_their_targets() {
    use std::os::unix::fs::symlink;
    let directory = temporary_directory("storage-links");
    let legacy = directory.join(LEGACY_PRIVATE_DIR_NAME);
    let target = directory.join(PRIVATE_DIR_NAME);
    let external = directory.join("external");
    ensure_private_directory(&legacy).unwrap();
    ensure_private_directory(&external).unwrap();
    fs::write(external.join("keep.txt"), "keep").unwrap();
    symlink(&external, &target).unwrap();
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).is_err());
    fs::remove_file(&target).unwrap();
    symlink(&external, legacy.join(REVISIONS_DIR_NAME)).unwrap();
    assert!(migrate_legacy_plugin_directory_at(&legacy, &target).is_err());
    assert!(!target.exists());
    assert_eq!(fs::read_to_string(external.join("keep.txt")).unwrap(), "keep");
    fs::remove_dir_all(directory).ok();
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
