use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(all(windows, debug_assertions, feature = "project-model-fixture-host"))]
#[test]
fn fixture_archive_container_probe_uses_only_an_empty_isolated_root() {
    let fixture = Fixture::new();
    run_fixture_archive_container_probe(&fixture.0).unwrap();
    // 已有结果不能复用或覆盖；失败时材料保留供人工核对。
    assert!(run_fixture_archive_container_probe(&fixture.0).is_err());
    assert!(fixture.0.join("v4/synthetic.aicanvas").is_file());
}

#[test]
fn publication_recovery_binds_original_operation_receipt_and_file() {
    let fixture = Fixture::new();
    let operation_id = "recovery-example";
    let output = fixture.0.join("project.aicanvas");
    let receipt = ArchivePublicationReceipt { operation_id: operation_id.into(), publication_ref: "a".repeat(64),
        output_path: output.to_str().unwrap().into(), result: None };
    write_publication_receipt(&publication_path(&fixture.0, operation_id, "prepared"), &receipt).unwrap();
    let original = pack_archive_with_publication(
        vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
        None, output.clone(), Some(vec![]), MAX_ARCHIVE_ENTRIES,
        Some(ArchivePublicationPlan { directory: fixture.0.clone(), receipt, recheck: None }), &HashMap::new(),
    ).unwrap();
    let published = publication_path(&fixture.0, operation_id, "published");
    fs::rename(&published, fixture.0.join("published-preserved.json")).unwrap();
    let authorize = |path: &str| {
        if Path::new(path) != output.as_path() { return Err(PUBLICATION_ERROR.into()); }
        Ok(output.clone())
    };
    assert_eq!(reconcile_publication(&fixture.0, operation_id, Some("wrong"), authorize).unwrap().status, "unknown");
    assert!(!published.exists());
    let authorizations = std::cell::Cell::new(0);
    let revoked = |path: &str| {
        authorizations.set(authorizations.get() + 1);
        if authorizations.get() != 1 || Path::new(path) != output.as_path() { return Err(PUBLICATION_ERROR.into()); }
        Ok(output.clone())
    };
    assert_eq!(reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), revoked).unwrap().status, "unknown");
    assert!(!published.exists());
    let recovered = reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), authorize).unwrap();
    assert_eq!(recovered.status, "published");
    assert_eq!(recovered.archive_sha256, original.archive_sha256);
    assert!(published.is_file());
    assert_eq!(reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), authorize).unwrap().status, "published");
    fs::write(&output, b"changed synthetic file").unwrap();
    assert_eq!(reconcile_publication(&fixture.0, operation_id, original.publication_ref.as_deref(), authorize).unwrap().status, "unknown");
    assert!(fixture.0.join("published-preserved.json").is_file());
}

#[test]
fn import_aliases_require_same_verified_path_and_preserve_first_spelling() {
    let fixture = Fixture::new(); fixture.write("verified.png", b"fixture");
    let paths = vec!["imports/op/asset.png".to_owned(), "Imports/op/asset.png".to_owned()];
    let (unique, aliases) = resolve_selected_path_aliases(&paths, true, |_| Ok(Some(fixture.0.join("verified.png")))).unwrap();
    assert_eq!(unique, vec![paths[0].clone()]);
    assert_eq!(aliases.get(&paths[0]).unwrap(), &vec![paths[1].clone()]);
    assert!(resolve_selected_path_aliases(&paths, true, |path| Ok(Some(path.to_path_buf()))).is_err());
    assert!(resolve_selected_path_aliases(&paths, true, |_| Err("missing".into())).is_err());
    assert!(selected_asset_paths(&paths, true).is_err()); // 旧调用仍严格拒绝大小写冲突。
}

#[cfg(windows)]
#[test]
fn import_aliases_are_verified_on_actual_windows_filesystem() {
    let fixture = Fixture::new(); fixture.write("imports/op/asset.png", b"fixture");
    let paths = vec!["imports/op/asset.png".to_owned(), "Imports/op/asset.png".to_owned()];
    let (unique, aliases) = resolve_selected_path_aliases(&paths, true, |path| selected_asset_file(&fixture.0, path)).unwrap();
    assert_eq!(unique, vec![paths[0].clone()]); assert_eq!(aliases.get(&paths[0]).unwrap(), &vec![paths[1].clone()]);
    let rows = inspect_assets_scoped(&fixture.0, Some(&unique), None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
    assert_eq!(rows.len(), 1); assert_eq!(rows[0].path, paths[0]);
    let (bytes, sha256) = hash_file(&fixture.0.join(&paths[0]), &mut Vec::new()).unwrap();
    let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: paths[0].clone(), aliases: vec![paths[1].clone()], bytes, sha256 }];
    let roots = HashMap::from([("root".to_string(), fixture.0.clone())]);
    verify_export_aliases(&checks, &roots).unwrap();
    fs::write(fixture.0.join(&paths[0]), b"changed").unwrap();
    assert!(verify_export_aliases(&checks, &roots).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_unicode_aliases_use_verified_file_identity_for_scan_and_publication() {
    let fixture = Fixture::new();
    let composed = "imports/op/caf\u{e9}.png".to_string();
    let decomposed = "imports/op/cafe\u{301}.png".to_string();
    fixture.write(&composed, b"unicode-fixture");
    // 非归一化卷也以同一 inode 的普通文件验证身份分支，不按字符串或摘要推测别名。
    if !fixture.0.join(&decomposed).exists() {
        fs::hard_link(fixture.0.join(&composed), fixture.0.join(&decomposed)).unwrap();
    }
    let paths = vec![composed.clone(), decomposed.clone()];
    let (unique, mut aliases) = resolve_selected_path_aliases(&paths, true, |path| selected_asset_file(&fixture.0, path)).unwrap();
    assert_eq!(unique, vec![composed.clone()]);
    assert_eq!(aliases.get(&composed), Some(&vec![decomposed.clone()]));
    let rows = inspect_assets_scoped(&fixture.0, Some(&unique), None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
    assert_eq!(rows.len(), 1);
    aliases.clear();
    resolve_reference_path_aliases(&fixture.0, &rows, &[decomposed.clone()], &mut aliases).unwrap();
    assert_eq!(aliases.get(&composed), Some(&vec![decomposed.clone()]));
    let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: composed,
        aliases: vec![decomposed], bytes: rows[0].bytes, sha256: rows[0].sha256.clone() }];
    let roots = HashMap::from([("root".to_string(), fixture.0.clone())]);
    verify_export_aliases(&checks, &roots).unwrap();
    fs::write(fixture.0.join(&checks[0].path), b"changed").unwrap();
    assert!(verify_export_aliases(&checks, &roots).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_equal_bytes_in_distinct_files_are_not_aliases() {
    let fixture = Fixture::new();
    fixture.write("imports/op/original.png", b"same"); fixture.write("imports/op/different.png", b"same");
    let paths = vec!["imports/op/original.png".to_owned(), "imports/op/different.png".to_owned()];
    let (unique, aliases) = resolve_selected_path_aliases(&paths, true, |path| selected_asset_file(&fixture.0, path)).unwrap();
    assert_eq!(unique, paths); assert!(aliases.is_empty());
    let rows = inspect_assets_scoped(&fixture.0, Some(&[paths[0].clone()]), None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
    let mut mapped = HashMap::new();
    resolve_reference_path_aliases(&fixture.0, &rows, &[paths[1].clone()], &mut mapped).unwrap();
    assert!(mapped.is_empty());
    let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: paths[0].clone(),
        aliases: vec![paths[1].clone()], bytes: rows[0].bytes, sha256: rows[0].sha256.clone() }];
    assert!(verify_export_aliases(&checks, &HashMap::from([("root".to_string(), fixture.0.clone())])).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_alias_replacement_is_rejected_even_when_bytes_are_equal() {
    let fixture = Fixture::new(); fixture.write("media/original.png", b"same");
    fs::hard_link(fixture.0.join("media/original.png"), fixture.0.join("media/alias.png")).unwrap();
    let (bytes, sha256) = hash_file(&fixture.0.join("media/original.png"), &mut Vec::new()).unwrap();
    let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: "media/original.png".into(),
        aliases: vec!["media/alias.png".into()], bytes, sha256 }];
    let roots = HashMap::from([("root".to_string(), fixture.0.clone())]);
    verify_export_aliases(&checks, &roots).unwrap();
    fs::remove_file(fixture.0.join("media/alias.png")).unwrap(); fixture.write("media/alias.png", b"same");
    assert!(verify_export_aliases(&checks, &roots).is_err());
}

#[cfg(windows)]
#[test]
fn alias_change_at_publication_keeps_output_unpublished() {
    let fixture = Fixture::new(); fixture.write("imports/op/asset.png", b"original");
    let root = fixture.0.clone(); let source = root.join("imports/op/asset.png");
    let (bytes, sha256) = hash_file(&source, &mut Vec::new()).unwrap();
    let checks = vec![ProjectArchiveAliasCheck { root_ref: "root".into(), path: "imports/op/asset.png".into(),
        aliases: vec!["Imports/op/asset.png".into()], bytes, sha256 }];
    let roots = HashMap::from([("root".to_string(), root.clone())]);
    verify_export_aliases(&checks, &roots).unwrap();
    let output = root.join("result.aicanvas");
    let receipt = ArchivePublicationReceipt { operation_id: "alias-change".into(), publication_ref: "a".repeat(64),
        output_path: output.to_str().unwrap().into(), result: None };
    let plan = ArchivePublicationPlan { directory: root, receipt, recheck: Some(Box::new(move || {
        fs::write(&source, b"changed").map_err(|_| "fixture write failed")?;
        verify_export_aliases(&checks, &roots)
    })) };
    assert!(pack_archive_with_publication(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
        None, output.clone(), None, MAX_ARCHIVE_ENTRIES, Some(plan), &HashMap::new()).is_err());
    assert!(!output.exists());
}

#[test]
fn v4_text_allowlist_does_not_expand_the_legacy_archive_contract() {
    let valid = [("manifest.json", "{\"formatVersion\":4}"), ("project.json", "{}"), ("episodes.json", "[]"),
        ("canvases.json", "[]"), ("contents.json", "{}"), ("exchange.json", "{}")];
    let mut with_editor = valid.to_vec(); with_editor.push(("video-editor.json", "{}"));
    validate_v4_entry_names(with_editor).unwrap();
    let mut with_metadata = valid.to_vec(); with_metadata.push(("asset-metadata.json", "{}"));
    validate_v4_entry_names(with_metadata).unwrap();
    validate_v4_entry_names(valid).unwrap();
    let mut unknown = valid.to_vec(); unknown.push(("chat.json", "{}"));
    assert!(validate_v4_entry_names(unknown).is_err());
    assert!(validate_v4_entry_names(valid.into_iter().filter(|(name, _)| *name != "canvases.json")).is_err());
    validate_v4_entry_names([("manifest.json", "{\"formatVersion\":3}"), ("legacy-extension.json", "{}")]).unwrap();
}

#[test]
fn publication_is_exclusive_and_keeps_a_durable_ready_receipt_before_output() {
    let fixture = Fixture::new();
    let output = fixture.0.join("result.aicanvas");
    let operation_id = "archive-operation-1";
    let receipt = ArchivePublicationReceipt { operation_id: operation_id.into(), publication_ref: "a".repeat(64),
        output_path: output.to_str().unwrap().into(), result: None };
    let prepared = publication_path(&fixture.0, operation_id, "prepared");
    write_publication_receipt(&prepared, &receipt).unwrap();
    assert!(write_publication_receipt(&prepared, &receipt).is_err());
    let result = pack_archive_with_publication(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
        None, output.clone(), None, MAX_ARCHIVE_ENTRIES, Some(ArchivePublicationPlan { directory: fixture.0.clone(), receipt, recheck: None }), &HashMap::new()).unwrap();
    let ready = read_publication_receipt(&publication_path(&fixture.0, operation_id, "ready")).unwrap();
    assert_eq!(ready.result.as_ref().unwrap().archive_sha256, result.archive_sha256);
    assert!(publication_path(&fixture.0, operation_id, "published").exists());
    let before = fs::read(&output).unwrap();
    let other = fixture.0.join("other.tmp"); fs::write(&other, b"different").unwrap();
    assert!(publish_archive_exclusive(&other, &output).is_err());
    assert_eq!(fs::read(output).unwrap(), before);
    assert_eq!(hash_file_with_limit(&fixture.0.join("result.aicanvas"), &mut Vec::new(), MAX_EXPANDED_BYTES + MAX_TEXT_BYTES).unwrap().1,
        result.archive_sha256.unwrap());
}

#[test]
fn late_output_collision_is_confirmed_without_replacing_the_occupied_file() {
    let fixture = Fixture::new();
    let output = fixture.0.join("result.aicanvas");
    let operation_id = "archive-late-output-collision";
    let receipt = ArchivePublicationReceipt {
        operation_id: operation_id.into(), publication_ref: "a".repeat(64),
        output_path: output.to_str().unwrap().into(), result: None,
    };
    write_publication_receipt(&publication_path(&fixture.0, operation_id, "prepared"), &receipt).unwrap();
    let occupied_path = output.clone();
    let plan = ArchivePublicationPlan {
        directory: fixture.0.clone(), receipt,
        recheck: Some(Box::new(move || fs::write(&occupied_path, "另一个操作".as_bytes()).map_err(|error| error.to_string()))),
    };
    let result = pack_archive_with_publication(vec![], None, output.clone(), None, MAX_ARCHIVE_ENTRIES, Some(plan), &HashMap::new());

    assert!(matches!(result, Err(ref error) if error.as_str() == ARCHIVE_OUTPUT_OCCUPIED));
    assert_eq!(fs::read(output).unwrap(), "另一个操作".as_bytes());
    assert!(!publication_path(&fixture.0, operation_id, "published").exists());
}

#[test]
fn multi_root_sources_keep_equal_relative_names_separate_and_never_serialize_source_locations() {
    let fixture = Fixture::new();
    fixture.write("left/same.txt", b"left"); fixture.write("right/same.txt", b"right");
    let roots = HashMap::from([("left".to_string(), fixture.0.join("left")), ("right".to_string(), fixture.0.join("right"))]);
    let descriptor = |root: &str, path: &str| {
        let (bytes, sha256) = hash_file(&roots[root].join("same.txt"), &mut Vec::new()).unwrap();
        ArchiveAssetDigest { path: path.into(), bytes, sha256, source_root_ref: Some(root.into()), source_relative_path: Some("same.txt".into()) }
    };
    let assets = vec![descriptor("left", "one.txt"), descriptor("right", "two.txt")];
    let output = fixture.0.join("multi.aicanvas");
    pack_archive_with_publication(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
        None, output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES, None, &roots).unwrap();
    let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
    let unpacked = unpack_archive(&output, &target).unwrap();
    assert_eq!(fs::read(target.join("one.txt")).unwrap(), b"left");
    assert_eq!(fs::read(target.join("two.txt")).unwrap(), b"right");
    assert!(unpacked.assets.iter().all(|asset| asset.source_root_ref.is_none() && asset.source_relative_path.is_none()));
    let mut invalid = assets.clone(); invalid[0].source_relative_path = Some("../right/same.txt".into());
    assert!(multi_root_asset_sources(&invalid, &roots, None).is_err());
    invalid[0].source_relative_path = None;
    assert!(multi_root_asset_sources(&invalid, &roots, None).is_err());
    fixture.write("left/same.txt", b"changed");
    assert!(multi_root_asset_sources(&assets, &roots, None).is_err());
}

#[test]
fn import_directory_publication_does_not_replace_even_an_existing_empty_directory() {
    let fixture = Fixture::new();
    fixture.write("staged/note.txt", b"complete-content");
    let staged = fixture.0.join("staged");
    let occupied = fixture.0.join("occupied");
    fs::create_dir(&occupied).unwrap();
    assert!(publish_import_directory_exclusive(&staged, &occupied).is_err());
    assert!(staged.join("note.txt").exists());
    assert!(fs::read_dir(&occupied).unwrap().next().is_none());
    let published = fixture.0.join("published");
    publish_import_directory_exclusive(&staged, &published).unwrap();
    assert!(!staged.exists());
    assert_eq!(fs::read(published.join("note.txt")).unwrap(), b"complete-content");
}

#[test]
fn effective_entry_size_is_budgeted_before_reading_content() {
    let mut builder = Builder::new(Vec::new());
    let metadata = b"10 size=8\n";
    let mut extension = Header::new_gnu();
    extension.set_entry_type(tar::EntryType::XHeader); extension.set_size(metadata.len() as u64); extension.set_cksum();
    builder.append_data(&mut extension, "metadata", metadata.as_slice()).unwrap();
    let mut header = Header::new_gnu(); header.set_size(8); header.set_cksum();
    builder.append_data(&mut header, "note.txt", [0_u8; 8].as_slice()).unwrap();
    let mut bytes = builder.into_inner().unwrap();
    let offset = {
        let mut raw = Archive::new(bytes.as_slice());
        let position = raw.entries().unwrap().raw(true).map(Result::unwrap).find(|entry| entry.header().entry_type().is_file())
            .unwrap().raw_header_position() as usize;
        position
    };
    let mut raw_header = Header::new_gnu(); raw_header.set_path("note.txt").unwrap();
    raw_header.set_size(0); raw_header.set_cksum(); bytes[offset..offset + 512].copy_from_slice(raw_header.as_bytes());
    validate_archive_stream(bytes.as_slice()).unwrap();
    let mut archive = Archive::new(bytes.as_slice());
    let mut entry = archive.entries().unwrap().next().unwrap().unwrap();
    assert_eq!(entry.size(), 8); assert_eq!(entry.header().entry_size().unwrap(), 0);
    let mut budget = 0;
    assert!(archive_entry_path(&entry, &mut HashSet::new(), &mut budget, 4).unwrap_err().contains("超过上限"));
    assert_eq!(budget, 8);
    let mut accepted = 0;
    assert_eq!(archive_entry_path(&entry, &mut HashSet::new(), &mut accepted, 8).unwrap(), Path::new("note.txt"));
    let mut body = Vec::new(); entry.read_to_end(&mut body).unwrap(); assert_eq!(body, [0_u8; 8]);
}

#[test]
fn rejects_content_on_skipped_directory_and_root_entries() {
    for (path, kind) in [("folder/", tar::EntryType::Directory), (".", tar::EntryType::Regular), ("assets", tar::EntryType::Regular)] {
        let mut builder = Builder::new(Vec::new());
        let mut header = Header::new_gnu(); header.set_entry_type(kind); header.set_size(1); header.set_cksum();
        builder.append_data(&mut header, path, b"x".as_slice()).unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let entry = archive.entries().unwrap().next().unwrap().unwrap();
        let mut budget = 0;
        assert!(archive_entry_path(&entry, &mut HashSet::new(), &mut budget, 8).unwrap_err().contains("不能携带"));
        assert_eq!(budget, 1);
    }
}

#[test]
fn effective_budget_is_accumulated_across_entries() {
    let mut builder = Builder::new(Vec::new());
    for name in ["a.txt", "b.txt"] {
        let mut header = Header::new_gnu(); header.set_size(2); header.set_cksum();
        builder.append_data(&mut header, name, b"ab".as_slice()).unwrap();
    }
    let bytes = builder.into_inner().unwrap();
    let mut archive = Archive::new(bytes.as_slice()); let mut budget = 0; let mut seen = HashSet::new();
    let mut entries = archive.entries().unwrap();
    archive_entry_path(&entries.next().unwrap().unwrap(), &mut seen, &mut budget, 3).unwrap();
    assert!(archive_entry_path(&entries.next().unwrap().unwrap(), &mut seen, &mut budget, 3).unwrap_err().contains("超过上限"));
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ai-canvas-archive-regression-{}-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        Self(canonicalize_simplified(&root).unwrap())
    }
    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let temporary = canonicalize_simplified(&std::env::temp_dir()).unwrap();
        assert!(self.0.starts_with(&temporary) && self.0 != temporary);
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn reused_hash_buffer_preserves_large_short_and_empty_file_digests() {
    let fixture = Fixture::new();
    let large: Vec<u8> = (0..IO_BUFFER_BYTES + 17).map(|index| (index % 251) as u8).collect();
    let files = [("large.bin", large.as_slice()), ("short.bin", b"short tail".as_slice()), ("empty.bin", b"".as_slice())];
    let mut buffer = Vec::new();
    for (path, contents) in files {
        fixture.write(path, contents);
        let actual = hash_file(&fixture.0.join(path), &mut buffer).unwrap();
        assert_eq!(actual, (contents.len() as u64, format!("{:x}", Sha256::digest(contents))));
    }
}

#[test]
fn round_trips_multiple_assets_across_reused_buffer_boundaries() {
    let fixture = Fixture::new();
    let large: Vec<u8> = (0..IO_BUFFER_BYTES + 17).map(|index| (index % 251) as u8).collect();
    let files = [("large.bin", large.as_slice()), ("short.bin", b"short tail".as_slice()), ("empty.bin", b"".as_slice())];
    for (path, contents) in files { fixture.write(&format!("source/{path}"), contents); }
    let source = fixture.0.join("source");
    let expected = inspect_assets_scoped(&source, Some(&[]), None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
    let archive = fixture.0.join("project.aicanvas");
    pack_archive(vec![], Some(source), archive.clone(), Some(expected.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
    let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
    let mut actual = unpack_archive(&archive, &target).unwrap().assets;
    actual.sort_by(|left, right| left.path.cmp(&right.path));
    assert!(actual == expected);
    for (path, contents) in files { assert_eq!(fs::read(target.join(path)).unwrap(), contents); }
}

// 只替换 AppHandle 授权入口；路径解析、父链存在性、目录和链接检查均操作真实文件系统。
fn filesystem_authorize(path: &Path, existing_plain: bool) -> Result<PathBuf, String> {
    if existing_plain {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        #[cfg(windows)]
        let reparse = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let reparse = false;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse {
            return Err("必须为普通目录".into());
        }
    }
    match canonicalize_simplified(path) {
        Ok(resolved) => Ok(resolved),
        Err(error) if !existing_plain && error.kind() == std::io::ErrorKind::NotFound => {
            let parent = canonicalize_simplified(path.parent().ok_or("缺少父目录")?).map_err(|error| error.to_string())?;
            Ok(parent.join(path.file_name().ok_or("缺少目录名")?))
        },
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
#[test]
fn selected_media_source_matches_production_authorization_without_verbatim_prefix() {
    let fixture = Fixture::new();
    let name = "原媒体产物_1.png";
    let contents = b"synthetic image publication bytes";
    fixture.write(name, contents);
    // 生产 authorize_path 使用简化根；std::canonicalize 的文件路径仍带 verbatim 前缀。
    let root = filesystem_authorize(&fixture.0, true).unwrap();
    let verbatim_root = root.canonicalize().unwrap();
    let verbatim_file = root.join(name).canonicalize().unwrap();
    assert!(!root.to_string_lossy().starts_with(r"\\?\"));
    assert!(verbatim_file.to_string_lossy().starts_with(r"\\?\"));
    assert!(!verbatim_file.starts_with(&root));

    let selected = selected_asset_file(&root, Path::new(name)).unwrap().unwrap();
    assert_eq!(selected, root.join(name));
    assert!(selected.starts_with(&root));
    // 覆盖 publish_project_import_assets 随后的再次授权相等检查，而非只通过 containment。
    assert_eq!(filesystem_authorize(&selected, false).unwrap(), selected);
    assert_eq!(filesystem_authorize(&verbatim_file, false).unwrap(), selected);
    assert_eq!(selected_asset_file(&verbatim_root, Path::new(name)).unwrap().unwrap(), selected);
    let (bytes, sha256) = hash_file(&selected, &mut Vec::new()).unwrap();
    assert_eq!(bytes, contents.len() as u64);
    assert_eq!(sha256, format!("{:x}", Sha256::digest(contents)));

    let asset = ArchiveAssetDigest { path: name.into(), bytes, sha256, source_root_ref: Some("source".into()),
        source_relative_path: Some(name.into()) };
    let sources = multi_root_asset_sources(&[asset], &HashMap::from([("source".into(), root.clone())]), None).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(selected_asset_file(&sources[0].0, &sources[0].1).unwrap().unwrap(), selected);
    assert_eq!(fs::read(root.join(name)).unwrap(), contents); // 规范化不移动、覆盖或删除原文件。
}

#[test]
fn selected_media_source_keeps_plain_root_and_relative_component_checks() {
    let fixture = Fixture::new(); fixture.write("image.png", b"synthetic");
    assert!(selected_asset_file(&fixture.0.join("image.png"), Path::new("other.png")).is_err());
    assert!(selected_asset_file(&fixture.0, Path::new("../image.png")).is_err());
    assert!(selected_asset_file(&fixture.0, fixture.0.join("image.png").as_path()).is_err());
    assert!(selected_asset_file(&fixture.0, Path::new("missing.png")).unwrap().is_none());
    assert_eq!(fs::read(fixture.0.join("image.png")).unwrap(), b"synthetic");
}

#[test]
fn scoped_scan_counts_current_files_without_historical_imports() {
    let fixture = Fixture::new();
    fixture.write("current.txt", b"now");
    fixture.write("imports/old-a.txt", b"history a");
    fixture.write("imports/old-b.txt", b"history b");
    fixture.write("imports/live/current.txt", b"live");
    assert!(inspect_assets_scoped(&fixture.0, None, None, 1, 3).is_err());
    let current = inspect_assets_scoped(&fixture.0, Some(&[]), None, 1, 3).unwrap();
    assert_eq!(current.len(), 1); assert_eq!(current[0].path, "current.txt");
    let include = vec!["imports/live/current.txt".to_owned()];
    let current = inspect_assets_scoped(&fixture.0, Some(&include), None, 2, 7).unwrap();
    assert_eq!(current.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(), ["current.txt", "imports/live/current.txt"]);
    assert!(inspect_assets_scoped(&fixture.0, Some(&include), None, 2, 6).is_err());
}

#[test]
fn scoped_scan_only_hashes_selected_shared_media() {
    let fixture = Fixture::new();
    fixture.write("project.txt", b"own");
    fixture.write(".shared-sync/files/asset/revision-current/current.png", b"current");
    fixture.write(".shared-sync/files/asset/revision-old/referenced.png", b"historical");
    fixture.write(".shared-sync/files/asset/revision-unaccepted/secret.png", b"do not pack");
    fixture.write(".shared-sync/inputs/upload/temp.png", b"do not pack");
    fixture.write("roots/sub/.shared-sync/files/asset/revision-old/cache.png", b"do not pack");
    let selected = [
        ".shared-sync/files/asset/revision-current/current.png".to_owned(),
        ".shared-sync/files/asset/revision-old/referenced.png".to_owned(),
    ];
    let actual = inspect_assets_with_shared_scope(&fixture.0, Some(&[]), None, Some(&selected), 3, 20).unwrap();
    assert_eq!(actual.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
        [selected[0].as_str(), selected[1].as_str(), "project.txt"]);
    assert!(inspect_assets_with_shared_scope(&fixture.0, Some(&[]), None,
        Some(&[".shared-sync/inputs/upload/temp.png".to_owned()]), 3, 30).is_err());
}

#[test]
fn scoped_scan_preserves_imports_spelling_and_skips_history_case_insensitively() {
    for directory in ["Imports", "IMPORTS"] {
        let fixture = Fixture::new();
        fixture.write("current.txt", b"now");
        let current = format!("{directory}/live/current.txt");
        fixture.write(&current, b"live");
        fixture.write(&format!("{directory}/recovery/old.txt"), b"unrelated historical bytes");
        let regular = inspect_assets_scoped(&fixture.0, Some(&[]), None, 1, 3).unwrap();
        assert_eq!(regular.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(), ["current.txt"]);
        let include = vec![current.clone()];
        let selected = inspect_assets_scoped(&fixture.0, Some(&include), None, 2, 7).unwrap();
        assert_eq!(selected.len(), 2);
        assert!(selected.iter().any(|row| row.path == current));
        let output = fixture.0.with_extension("aicanvas");
        pack_archive(vec![], Some(fixture.0.clone()), output.clone(), Some(selected.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
        let target = Fixture::new();
        assert!(unpack_archive(&output, &target.0).unwrap().assets == selected);
        fs::remove_file(output).unwrap();
    }
}

#[test]
fn scans_keep_normal_hidden_files_but_skip_native_media_pending_recovery_material() {
    let fixture = Fixture::new();
    let pending = format!("media/.native-media-{}.pending", "a".repeat(64));
    fixture.write(&pending, b"unpublished recovery bytes exceeding the ordinary attachment budget");
    let resumable = format!("media/.native-media-{}.png.pending", "b".repeat(64));
    fixture.write(&resumable, b"resumable recovery material is not an attachment either");
    let ordinary = ["media/finished.png".to_owned(), "media/.ordinary.pending".to_owned(),
        "media/.native-media-short.pending".to_owned(), format!(".native-media-{}.pending", "a".repeat(64)),
        format!("media/sub/.native-media-{}.pending", "a".repeat(64)),
        format!("media/.native-media-{}.txt.pending", "a".repeat(64))];
    for path in &ordinary { fixture.write(path, b"img"); }
    let rows = inspect_assets_scoped(&fixture.0, None, None, ordinary.len(), ordinary.len() as u64 * 3).unwrap();
    let actual: HashSet<_> = rows.iter().map(|row| row.path.as_str()).collect();
    let expected: HashSet<_> = ordinary.iter().map(String::as_str).collect();
    assert_eq!(actual, expected);
    assert_eq!(fs::read(fixture.0.join(&pending)).unwrap(), b"unpublished recovery bytes exceeding the ordinary attachment budget");
    assert_eq!(fs::read(fixture.0.join(&resumable)).unwrap(), b"resumable recovery material is not an attachment either");
}

#[test]
fn explicit_selection_and_pack_cannot_include_native_media_pending_files() {
    for suffix in ["", ".png", ".json"] {
        let fixture = Fixture::new();
        let pending = format!("media/.native-media-{}{suffix}.pending", "b".repeat(64));
        fixture.write(&pending, b"pending");
        let selected = vec![pending.clone()];
        assert!(selected_asset_file(&fixture.0, Path::new(&pending)).unwrap_err().contains("暂存文件"));
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 7).err().unwrap().contains("暂存文件"));
        let (bytes, sha256) = hash_file(&fixture.0.join(&pending), &mut Vec::new()).unwrap();
        let output = fixture.0.with_extension("aicanvas");
        assert!(pack_archive(vec![], Some(fixture.0.clone()), output.clone(),
            Some(vec![ArchiveAssetDigest { path: pending.clone(), bytes, sha256, source_root_ref: None, source_relative_path: None }]), MAX_ARCHIVE_ENTRIES)
            .err().unwrap().contains("暂存文件"));
        assert!(!output.exists()); assert_eq!(fs::read(fixture.0.join(&pending)).unwrap(), b"pending");
    }
}

#[test]
fn explicit_scans_and_pack_reject_excluded_directories() {
    for path in [".trash/current.png", "imports/op/.trash/current.png", ".thumbnail/current.png"] {
        let fixture = Fixture::new(); fixture.write(path, b"img");
        let selected = vec![path.to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 3).err().unwrap().contains("回收站或派生缓存"));
        if path.starts_with("imports/") {
            assert!(inspect_assets_scoped(&fixture.0, Some(&selected), None, 1, 3).err().unwrap().contains("回收站或派生缓存"));
        }
        let (bytes, sha256) = hash_file(&fixture.0.join(path), &mut Vec::new()).unwrap();
        let output = fixture.0.with_extension("aicanvas");
        assert!(pack_archive(vec![], Some(fixture.0.clone()), output.clone(),
            Some(vec![ArchiveAssetDigest { path: path.to_owned(), bytes, sha256, source_root_ref: None, source_relative_path: None }]), MAX_ARCHIVE_ENTRIES)
            .err().unwrap().contains("回收站或派生缓存"));
        assert!(!output.exists());
        assert_eq!(fs::read(fixture.0.join(path)).unwrap(), b"img");
    }
}

#[cfg(windows)]
#[test]
fn explicit_scans_reject_windows_excluded_directory_case_aliases() {
    for path in [".trash/current.png", "imports/op/.trash/current.png", ".thumbnail/current.png"] {
        let fixture = Fixture::new(); fixture.write(path, b"img");
        let alias = path.to_ascii_uppercase(); let selected = vec![alias.clone()];
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 3).is_err());
        if path.starts_with("imports/") {
            assert!(inspect_assets_scoped(&fixture.0, Some(&selected), None, 1, 3).is_err());
        }
        let (bytes, sha256) = hash_file(&fixture.0.join(path), &mut Vec::new()).unwrap();
        assert!(pack_archive(vec![], Some(fixture.0.clone()), fixture.0.with_extension("aicanvas"),
            Some(vec![ArchiveAssetDigest { path: alias, bytes, sha256, source_root_ref: None, source_relative_path: None }]), MAX_ARCHIVE_ENTRIES).is_err());
    }
}

#[test]
fn explicit_scans_keep_nested_thumbnail_directories_and_same_named_plain_files() {
    let fixture = Fixture::new();
    let selected = ["user/.thumbnail/current.png", "imports/op/.thumbnail/current.png", ".trash", ".thumbnail"]
        .into_iter().map(str::to_owned).collect::<Vec<_>>();
    for path in &selected { fixture.write(path, b"img"); }
    let assets = inspect_assets_scoped(&fixture.0, None, Some(&selected), 4, 12).unwrap();
    let include = vec!["imports/op/.thumbnail/current.png".to_owned()];
    assert!(inspect_assets_scoped(&fixture.0, Some(&include), None, 4, 12).unwrap() == assets);
    let output = fixture.0.with_extension("aicanvas");
    pack_archive(vec![], Some(fixture.0.clone()), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
    let target = Fixture::new();
    assert!(unpack_archive(&output, &target.0).unwrap().assets == assets);
    fs::remove_file(output).unwrap();
}

#[test]
fn selected_recovery_scan_reports_missing_or_changed_files_by_digest() {
    let fixture = Fixture::new();
    fixture.write("current.txt", b"current content outside recovery budget");
    fixture.write("imports/recovery/keep.txt", b"keep");
    fixture.write("imports/other/history.txt", b"unrelated history outside recovery budget");
    let selected = vec!["imports/recovery/keep.txt".to_owned(), "imports/recovery/missing.txt".to_owned()];
    let before = inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 4).unwrap();
    assert_eq!(before.len(), 1); assert_eq!(before[0].path, selected[0]);
    fixture.write("imports/recovery/keep.txt", b"edit");
    let after = inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 4).unwrap();
    assert_ne!(before[0].sha256, after[0].sha256);
    fs::remove_file(fixture.0.join("imports/recovery/keep.txt")).unwrap();
    assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 1, 4).unwrap().is_empty());
}

#[test]
fn rejects_invalid_scope_paths_and_duplicate_aliases() {
    let fixture = Fixture::new(); fixture.write("current.txt", b"current");
    for selected in [vec!["../outside.txt"], vec!["/outside.txt"], vec!["imports\\outside.txt"],
        vec!["current.txt", "./current.txt"], vec!["current.txt", "CURRENT.txt"], vec![""]] {
        let selected = selected.into_iter().map(str::to_owned).collect::<Vec<_>>();
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
    }
    let selected = vec!["current.txt".to_owned()];
    assert!(inspect_assets_scoped(&fixture.0, Some(&selected), None, 10, 100).is_err());
    assert!(inspect_assets_scoped(&fixture.0, Some(&[]), Some(&[]), 10, 100).is_err());
    let directory = vec!["imports".to_owned()]; fs::create_dir(fixture.0.join("imports")).unwrap();
    assert!(inspect_assets_scoped(&fixture.0, None, Some(&directory), 10, 100).is_err());
    assert_eq!(fs::read(fixture.0.join("current.txt")).unwrap(), b"current");
}

#[test]
fn packs_only_selected_current_files_despite_other_project_history() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source");
    fixture.write("source/current.txt", b"now");
    fixture.write("source/imports/old-a.txt", b"history a");
    fixture.write("source/imports/old-b.txt", b"history b");
    let assets = inspect_assets_scoped(&source, Some(&[]), None, 1, 3).unwrap();
    let output = fixture.0.join("project.aicanvas");
    pack_archive(vec![], Some(source.clone()), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
    let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
    let unpacked = unpack_archive(&output, &target).unwrap();
    assert!(unpacked.assets == assets);
    assert_eq!(fs::read(target.join("current.txt")).unwrap(), b"now");
    assert!(!target.join("imports").exists());
    fs::write(source.join("current.txt"), b"changed").unwrap();
    assert!(pack_archive(vec![], Some(source), output, Some(assets), MAX_ARCHIVE_ENTRIES).is_err());
}

#[test]
fn creates_first_import_parent_and_reuses_it_without_overwriting_operations() {
    let fixture = Fixture::new();
    assert!(!fixture.0.join("imports").exists());
    let first = create_import_destination(&fixture.0, "first", filesystem_authorize).unwrap();
    fs::write(first.join("keep.txt"), b"original").unwrap();
    let second = create_import_destination(&fixture.0, "second", filesystem_authorize).unwrap();
    assert!(second.is_dir());
    assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
    assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
}

#[test]
fn rejects_import_parent_files_and_existing_operation_files() {
    let fixture = Fixture::new();
    fixture.write("imports", b"keep parent");
    assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
    assert_eq!(fs::read(fixture.0.join("imports")).unwrap(), b"keep parent");
    fs::remove_file(fixture.0.join("imports")).unwrap();
    fixture.write("imports/first", b"keep operation");
    assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
    assert_eq!(fs::read(fixture.0.join("imports/first")).unwrap(), b"keep operation");
}

#[cfg(unix)]
#[test]
fn rejects_import_parent_and_operation_links_without_touching_targets() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let other = Fixture::new();
    other.write("keep.txt", b"outside");
    symlink(&other.0, fixture.0.join("imports")).unwrap();
    assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
    let selected = vec!["imports/keep.txt".to_owned()];
    assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
    assert!(inspect_assets_scoped(&fixture.0, Some(&[]), None, 10, 100).unwrap().is_empty());
    fs::remove_file(fixture.0.join("imports")).unwrap();
    fs::create_dir(fixture.0.join("imports")).unwrap();
    symlink(&other.0, fixture.0.join("imports/first")).unwrap();
    assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
    let selected = vec!["imports/first/keep.txt".to_owned()];
    assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
    assert_eq!(fs::read(other.0.join("keep.txt")).unwrap(), b"outside");
}

#[cfg(windows)]
#[test]
fn rejects_windows_import_junctions_without_touching_targets() {
    struct Junction(PathBuf);
    impl Junction {
        fn new(link: PathBuf, target: &Path) -> Self {
            let shell_path = |path: &Path| {
                let text = path.to_str().unwrap();
                let text = text.strip_prefix(r"\\?\").unwrap_or(text);
                assert!(!text.chars().any(|character| "\"&|<>^%!()\r\n".contains(character)), "测试路径含 shell 特殊字符");
                // Windows Path::join 可保留输入中的正斜杠；cmd 的 mklink 会把它解析为选项。
                text.replace('/', "\\")
            };
            let output = std::process::Command::new("cmd.exe")
                .args(["/d", "/v:off", "/c", "mklink", "/J"])
                .arg(shell_path(&link)).arg(shell_path(target)).output().unwrap();
            assert!(output.status.success(), "创建测试目录联接失败：{}", String::from_utf8_lossy(&output.stderr));
            Self(link)
        }
    }
    impl Drop for Junction {
        fn drop(&mut self) {
            // remove_dir 只解除联接；目标及其文件由独立 Fixture 管理。
            fs::remove_dir(&self.0).unwrap();
        }
    }
    let fixture = Fixture::new();
    let other = Fixture::new();
    other.write("keep.txt", b"outside");
    {
        let _link = Junction::new(fixture.0.join("imports"), &other.0);
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        let selected = vec!["imports/keep.txt".to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
        assert!(inspect_assets_scoped(&fixture.0, Some(&[]), None, 10, 100).unwrap().is_empty());
    }
    fs::create_dir(fixture.0.join("imports")).unwrap();
    {
        let _link = Junction::new(fixture.0.join("imports/first"), &other.0);
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        let selected = vec!["imports/first/keep.txt".to_owned()];
        assert!(inspect_assets_scoped(&fixture.0, None, Some(&selected), 10, 100).is_err());
    }
    assert_eq!(fs::read(other.0.join("keep.txt")).unwrap(), b"outside");
}

#[test]
fn round_trips_long_chinese_paths_and_preserves_bytes() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source");
    let relative = format!("{}/制作总览.md", vec!["汉".repeat(20); 8].join("/"));
    assert!(relative.len() > 255);
    let file = source.join(&relative);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "# 中文原稿\n连续性待核对").unwrap();
    let mut assets = Vec::new(); inspect_assets(&source, Path::new(""), &mut assets).unwrap();
    let output = fixture.0.join("project.aicanvas");
    pack_archive(vec![], Some(source), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
    let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
    let unpacked = unpack_archive(&output, &target).unwrap();
    assert!(unpacked.assets == assets);
    assert_eq!(fs::read(target.join(relative)).unwrap(), "# 中文原稿\n连续性待核对".as_bytes());
}

#[test]
fn round_trips_an_archive_without_assets_and_creates_empty_import_destination() {
    let fixture = Fixture::new();
    let output = fixture.0.join("project.aicanvas");
    let result = pack_archive(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
        None, output.clone(), Some(vec![]), MAX_ARCHIVE_ENTRIES).unwrap();
    assert_eq!(result.asset_count, 0);
    let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
    let unpacked = unpack_archive(&output, &target).unwrap();
    assert!(unpacked.assets.is_empty());
    assert_eq!(unpacked.texts["manifest.json"], "{}");
    let destination = create_import_destination(&fixture.0, "empty", filesystem_authorize).unwrap();
    assert!(destination.is_dir() && fs::read_dir(destination).unwrap().next().is_none());
}

#[test]
fn rejects_complete_asset_path_byte_overflow_before_replacing_export() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source");
    let relative = format!("{}/{}.md", vec!["汉".repeat(40); 8].join("/"), "文".repeat(16));
    assert!(relative.len() <= 1024 && format!("assets/{relative}").len() > 1024);
    // 用多根映射保留超长归档名，避免先撞上本机文件系统的路径上限。
    fixture.write("source/note.md", b"text");
    let (bytes, sha256) = hash_file(&source.join("note.md"), &mut Vec::new()).unwrap();
    let assets = vec![ArchiveAssetDigest { path: relative, bytes, sha256,
        source_root_ref: Some("root".into()), source_relative_path: Some("note.md".into()) }];
    let roots = HashMap::from([("root".to_string(), source)]);
    let output = fixture.0.join("project.aicanvas"); fs::write(&output, b"existing export").unwrap();
    let error = pack_archive_with_publication(vec![], None, output.clone(), Some(assets),
        MAX_ARCHIVE_ENTRIES, None, &roots).err().unwrap();
    assert!(error.contains("不安全路径"));
    assert_eq!(fs::read(output).unwrap(), b"existing export");
    assert!(!fs::read_dir(&fixture.0).unwrap().any(|item| item.unwrap().path().extension().is_some_and(|value| value == "part")));
}

#[test]
fn complete_asset_depth_limit_matches_import_and_rejects_before_publish() {
    for components in [63, 64] {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        let relative = format!("{}/note.md", vec!["a"; components - 1].join("/"));
        let file = source.join(&relative); fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(file, b"note").unwrap();
        let output = fixture.0.join("project.aicanvas");
        let result = pack_archive(vec![], Some(source), output.clone(), None, MAX_ARCHIVE_ENTRIES);
        if components == 63 {
            assert!(result.is_ok());
            let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
            unpack_archive(&output, &target).unwrap();
            assert_eq!(fs::read(target.join(relative)).unwrap(), b"note");
        } else {
            assert!(result.err().unwrap().contains("不安全路径"));
            assert!(!output.exists());
        }
    }
}

#[test]
fn counts_gnu_name_extensions_and_json_entries_before_export_publish() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source"); fs::create_dir(&source).unwrap();
    let name = format!("{}.txt", "长".repeat(40)); fs::write(source.join(&name), b"asset").unwrap();
    let entries = || vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }];
    let output = fixture.0.join("project.aicanvas"); fs::write(&output, b"existing export").unwrap();
    let error = pack_archive(entries(), Some(source.clone()), output.clone(), None, 2).err().unwrap();
    assert!(error.contains("条目超过上限"));
    assert_eq!(fs::read(&output).unwrap(), b"existing export");
    pack_archive(entries(), Some(source), output.clone(), None, 3).unwrap();
    let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
    let unpacked = unpack_archive(&output, &target).unwrap();
    assert_eq!(unpacked.texts["manifest.json"], "{}");
    assert_eq!(fs::read(target.join(name)).unwrap(), b"asset");
}

#[test]
fn rejects_oversized_extensions_before_tar_allocates_them() {
    for kind in [tar::EntryType::GNULongName, tar::EntryType::XHeader, tar::EntryType::XGlobalHeader] {
        let mut header = Header::new_gnu();
        header.set_path("metadata").unwrap(); header.set_entry_type(kind);
        header.set_size(MAX_EXTENSION_BYTES + 1); header.set_cksum();
        assert!(validate_archive_stream(header.as_bytes().as_slice()).unwrap_err().contains("扩展"));
    }
}

#[test]
fn selected_export_omits_recovery_files_and_keeps_active_imports() {
    let directory = std::env::temp_dir().join(format!("ai-canvas-selected-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(directory.join("imports/active")).unwrap();
    fs::create_dir_all(directory.join("imports/recovery")).unwrap();
    fs::write(directory.join("imports/active/a.png"), b"current").unwrap();
    fs::write(directory.join("imports/recovery/a.png"), b"private-old-content").unwrap();
    let selected = HashSet::from(["imports/active/a.png".to_string()]);
    let mut builder = Builder::new(Vec::new()); let mut stats = AssetStats { count: 0, bytes: 0 };
    append_assets_dir(&mut builder, &directory, Path::new(ASSETS_PREFIX), &mut stats, Some(&selected)).unwrap();
    let bytes = builder.into_inner().unwrap();
    let mut archive = Archive::new(bytes.as_slice());
    let paths: Vec<_> = archive.entries().unwrap().map(|item| to_archive_text(&item.unwrap().path().unwrap())).collect();
    let resolved = directory.canonicalize().unwrap();
    assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    fs::remove_dir_all(&resolved).unwrap();
    assert_eq!(paths, ["assets/imports/active/a.png"]); assert_eq!(stats.bytes, 7);
}

#[test]
fn rejects_paths_escaping_the_archive_root() {
    assert!(normalize_archive_path(Path::new("../secret.json")).is_err());
    assert!(normalize_archive_path(Path::new("/etc/passwd")).is_err());
    assert!(normalize_archive_path(Path::new("assets\\a.png")).is_err());
}

#[test]
fn keeps_normal_relative_paths() {
    let normalized =
        normalize_archive_path(Path::new("./assets/分组/a.png")).expect("路径可归一化");
    assert_eq!(to_archive_text(&normalized), "assets/分组/a.png");
}

#[test]
fn inspects_and_packs_nested_assets_with_portable_paths() {
    let directory = std::env::temp_dir().join(format!(
        "ai-canvas-archive-paths-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    let files = [
        ("EP000｜剧本、视觉与制作说明/EP000 制作总览与连续性待核对.md", "# 制作总览\n连续性待核对"),
        ("EP000｜剧本、视觉与制作说明/参考/人物.md", "# 人物\n中文正文"),
    ];
    for (path, content) in files {
        let target = directory.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content.as_bytes()).unwrap();
    }

    let mut assets = Vec::new();
    inspect_assets(&directory, Path::new(""), &mut assets).unwrap();
    assets.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(assets.len(), files.len());
    for (asset, (path, content)) in assets.iter().zip(files) {
        assert_eq!(asset.path, path);
        assert_eq!(asset.bytes, content.len() as u64);
        assert_eq!(asset.sha256, format!("{:x}", Sha256::digest(content.as_bytes())));
        assert!(normalize_archive_path(Path::new(&asset.path)).is_ok());
    }

    let selected = assets.iter().map(|asset| asset.path.clone()).collect::<HashSet<_>>();
    let mut builder = Builder::new(Vec::new());
    let mut stats = AssetStats { count: 0, bytes: 0 };
    append_assets_dir(&mut builder, &directory, Path::new(ASSETS_PREFIX), &mut stats, Some(&selected)).unwrap();
    let bytes = builder.into_inner().unwrap();
    let mut archive = Archive::new(bytes.as_slice());
    let mut packed = Vec::new();
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        let path = normalize_archive_path(&entry.path().unwrap()).unwrap();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        packed.push((to_archive_text(&path), content));
    }
    packed.sort();

    let resolved = directory.canonicalize().unwrap();
    assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    fs::remove_dir_all(&resolved).unwrap();
    assert_eq!(packed, files.map(|(path, content)| (format!("assets/{path}"), content.to_string())));
    assert_eq!(stats.count, files.len());
}

#[test]
fn project_archives_omit_agent_workspace_but_preserve_legacy_assets() {
    let fixture = Fixture::new();
    fixture.write("project/.agent-workspace/results/private.json", b"private");
    fixture.write("project/group/.AGENT-WORKSPACE/scripts/private.py", b"private");
    fixture.write("project/agent-results/task/result.json", b"old result");
    fixture.write("project/agent-teams/team/state.json", b"old state");
    fixture.write("project/_patch_docs_v213.py", b"user file");
    let root = fixture.0.join("project");
    let expected = [
        "_patch_docs_v213.py",
        "agent-results/task/result.json",
        "agent-teams/team/state.json",
    ];

    let scanned = inspect_assets_scoped(&root, None, None, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
    assert_eq!(scanned.iter().map(|asset| asset.path.as_str()).collect::<Vec<_>>(), expected);

    let output = fixture.0.join("project.aicanvas");
    pack_archive(
        vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{\"formatVersion\":3}".into() }],
        Some(root), output.clone(), None, MAX_ARCHIVE_ENTRIES,
    ).unwrap();
    let target = fixture.0.join("unpacked");
    fs::create_dir(&target).unwrap();
    let mut unpacked = unpack_archive(&output, &target).unwrap();
    unpacked.asset_paths.sort();
    assert_eq!(unpacked.asset_paths, expected);
}

#[test]
fn agent_workspace_cannot_be_repacked_as_a_direct_or_remapped_asset() {
    let fixture = Fixture::new();
    let relative = ".agent-workspace/scripts/internal.py";
    fixture.write(&format!("project/{relative}"), b"internal");
    let root = fixture.0.join("project");
    let output = fixture.0.join("project.aicanvas");
    let entries = || [
        ("manifest.json", "{\"formatVersion\":4}"),
        ("project.json", "{}"),
        ("episodes.json", "[]"),
        ("canvases.json", "[]"),
        ("contents.json", "{}"),
        ("exchange.json", "{}"),
    ].into_iter().map(|(path, content)| ProjectArchiveTextEntry { path: path.into(), content: content.into() }).collect();

    // Previously frozen incoming or recovery files remain subject to exact validation.
    let exact = inspect_assets_scoped(&root, None, Some(&[relative.into()]), MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES).unwrap();
    assert_eq!(exact.len(), 1);
    assert_eq!(exact[0].path, relative);
    let direct = pack_archive(entries(), Some(root.clone()), output.clone(), Some(exact.clone()), MAX_ARCHIVE_ENTRIES);
    assert!(direct.err().unwrap().contains("Agent 工作目录"));

    let roots = HashMap::from([("primary".into(), root)]);
    let remapped = ArchiveAssetDigest {
        path: "attachments/renamed.py".into(), source_root_ref: Some("primary".into()),
        source_relative_path: Some(relative.into()), ..exact.into_iter().next().unwrap()
    };
    let routed = pack_archive_with_publication(
        entries(), None, output.clone(), Some(vec![remapped]), MAX_ARCHIVE_ENTRIES, None, &roots,
    );
    assert!(routed.err().unwrap().contains("Agent 工作目录"));
    assert!(!output.exists());
}

#[test]
fn omits_root_thumbnail_cache_but_preserves_nested_user_directory() {
    let directory = std::env::temp_dir().join(format!(
        "ai-canvas-archive-thumbnail-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(directory.join(".thumbnail")).unwrap();
    fs::create_dir_all(directory.join("group/.thumbnail")).unwrap();
    fs::write(directory.join(".thumbnail/cache.webp"), b"cache").unwrap();
    fs::write(directory.join("group/.thumbnail/user.png"), b"user").unwrap();
    fs::write(directory.join("original.png"), b"original").unwrap();

    let mut builder = Builder::new(Vec::new());
    let mut stats = AssetStats { count: 0, bytes: 0 };
    append_assets_dir(
        &mut builder,
        &directory,
        Path::new(ASSETS_PREFIX),
        &mut stats,
        None,
    )
    .unwrap();
    let bytes = builder.into_inner().unwrap();
    let mut archive = Archive::new(bytes.as_slice());
    let mut paths: Vec<String> = archive
        .entries()
        .unwrap()
        .map(|entry| to_archive_text(&entry.unwrap().path().unwrap()))
        .collect();
    paths.sort();

    // The only recursive removal belongs to this test's newly created temporary directory.
    let resolved = directory.canonicalize().unwrap();
    assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    fs::remove_dir_all(&resolved).unwrap();

    assert_eq!(
        paths,
        ["assets/group/.thumbnail/user.png", "assets/original.png"]
    );
    assert_eq!(stats.count, 2);
    assert_eq!(stats.bytes, 12);
}
