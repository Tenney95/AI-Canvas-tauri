use super::*;
const PROJECT: &str = "p2-12345678-1234-4123-8123-123456789abc";

#[test]
fn svg_native_media_uses_original_digest_extension_and_existing_image_budget() {
    let bytes = b"<svg width='320' height='200'><path d='M0 0h1'/></svg>";
    assert_eq!(media_format("image/svg+xml"), Some(("svg", 32 * 1024 * 1024)));
    assert_eq!(crate::file_transfer::validate_svg_image_bytes(bytes).unwrap(), (320, 200));
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    let mut reference = NativeMediaReference { relative_path: format!("media/{sha256}.svg"), sha256,
        bytes: bytes.len() as u64, mime_type: "image/svg+xml".into() };
    assert!(validate_media_reference(&reference).unwrap().ends_with(".svg"));
    reference.relative_path = reference.relative_path.replace(".svg", ".png");
    assert!(validate_media_reference(&reference).is_err());
    reference.relative_path = format!("media/{}.svg", reference.sha256);
    reference.bytes = 32 * 1024 * 1024 + 1;
    assert!(validate_media_reference(&reference).is_err());
}

#[test]
fn search_roots_require_main_registration_and_exact_window() {
    let allowed = HashSet::from([PROJECT.to_string()]);
    assert!(search_root_allowed("asset-search", PROJECT, &allowed));
    assert!(!search_root_allowed("main", PROJECT, &allowed));
    assert!(!search_root_allowed("asset-search", PROJECT, &HashSet::new()));
    assert!(!search_root_allowed("asset-search", "../outside", &allowed));
    assert!(!root_caller_allowed("asset-search", true, true));
    assert!(!root_caller_allowed("asset-search", false, false));
    assert!(!root_caller_allowed("chat-assistant", false, true));
}

#[test]
fn editor_root_requires_the_current_exact_lease() {
    let lease = VideoEditorLease { project_id: PROJECT.into(), canvas_id: "canvas".into(), session_id: "session".into() };
    assert!(editor_root_allowed("video-editor", PROJECT, "canvas", "session", Some(&lease)));
    assert!(!editor_root_allowed("main", PROJECT, "canvas", "session", Some(&lease)));
    assert!(!editor_root_allowed("video-editor", PROJECT, "other", "session", Some(&lease)));
    assert!(!editor_root_allowed("video-editor", PROJECT, "canvas", "old", Some(&lease)));
    assert!(!editor_root_allowed("video-editor", PROJECT, "canvas", "session", None));
    assert!(!root_caller_allowed("video-editor", true, true));
    assert!(!root_caller_allowed("video-editor", false, false));
}

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("native-media-{}-{:?}", std::process::id(), std::thread::current().id()));
    fs::create_dir(&root).unwrap(); root.canonicalize().unwrap()
}

#[test]
fn windows_media_project_recycle_requires_exact_root_and_rejects_protected_aliases() {
    let root = canonicalize_simplified(&fixture()).unwrap();
    let base = root.join("base");
    let registry = root.join("registry");
    let other = root.join("other");
    for path in [&base, &registry, &other] { fs::create_dir(path).unwrap(); }
    let target = bind_root(&base, &registry, PROJECT, true, Some("回收验证")).unwrap();
    let expected = target.to_str().unwrap();
    let child = target.join("images");
    fs::create_dir(&child).unwrap();
    with_bound_root(&base, &registry, PROJECT, false, None, |owned| {
        assert!(check_recycle_root(&owned, &owned, expected).is_ok());
        assert!(check_recycle_root(&owned, &other, expected).is_err());
        assert!(check_recycle_root(&owned, &owned, child.to_str().unwrap()).is_err());
        assert!(check_protected_recycle_roots(&owned, &[other.clone()]).is_ok());
        assert!(check_protected_recycle_roots(&owned, &[base.clone()]).is_err());
        assert!(check_protected_recycle_roots(&owned, &[child.clone()]).is_err());
        #[cfg(unix)]
        {
            let alias = other.join("asset-alias");
            std::os::unix::fs::symlink(&child, &alias).unwrap();
            assert!(check_protected_recycle_roots(&owned, &[alias]).is_err());
        }
        // 归属锁覆盖最终动作，其他原生绑定读取不能在核对及回收之间进入。
        assert!(bind_root(&base, &registry, PROJECT, false, None).is_err());
        Ok(())
    }).unwrap();
    assert!(target.is_dir());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
fn windows_media_reference(bytes: &[u8]) -> (String, NativeMediaReference) {
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    let name = format!("{sha256}.png");
    let reference = NativeMediaReference {
        relative_path: format!("media/{name}"), sha256, bytes: bytes.len() as u64, mime_type: "image/png".into(),
    };
    (name, reference)
}

#[cfg(windows)]
#[test]
fn windows_media_publishes_into_an_empty_directory_with_production_leases() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_ADD_FILE, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE};
    let root = crate::path_policy::simplify_verbatim(fixture());
    let media = root.join("media");
    fs::create_dir(&media).unwrap();
    let mut leases = Vec::new();
    for ancestor in media.ancestors().collect::<Vec<_>>().into_iter().rev().filter(|path| !path.as_os_str().is_empty()) {
        leases.push(lease_directory(ancestor, false).unwrap());
    }
    let bytes = b"first mask in an empty media directory";
    let (name, reference) = windows_media_reference(bytes);
    write_windows_media_file(&media, leases.last_mut().unwrap(), &name, &reference, bytes, || Ok(())).unwrap();
    assert_eq!(read_media_file(&media.join(&name), &reference).unwrap().as_slice(), bytes);
    assert_eq!(fs::read_dir(&media).unwrap().count(), 1);
    // Publication must restore the no-write lease before closing the staging file.
    assert!(OpenOptions::new().access_mode(FILE_ADD_FILE.0).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0).open(&media).is_err());
    assert!(fs::rename(&media, root.join("replaced-media")).is_err());
    write_windows_media_file(&media, leases.last_mut().unwrap(), &name, &reference, bytes, || Ok(())).unwrap();
    assert_eq!(fs::read_dir(&media).unwrap().count(), 1);
    drop(leases);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_media_recovers_a_verified_short_write_and_reuses_the_published_copy() {
    let media = fixture();
    let mut media_lease = lease_directory(&media, false).unwrap();
    let bytes = b"full native image bytes";
    let (name, reference) = windows_media_reference(bytes);
    let old = &bytes[..5];
    fs::write(media.join(&name), old).unwrap();
    let pending = media.join(".native-media-interrupted.pending");
    fs::write(&pending, b"interrupted stage").unwrap();

    write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Ok(())).unwrap();
    assert_eq!(read_media_file(&media.join(&name), &reference).unwrap().as_slice(), bytes);
    assert_eq!(fs::read(&pending).unwrap().as_slice(), b"interrupted stage");
    let files: Vec<_> = fs::read_dir(&media).unwrap().map(|entry| entry.unwrap().path()).collect();
    let recovered = files.iter().find(|path| *path != &pending && path.extension().is_some_and(|ext| ext == "pending")).unwrap();
    assert_eq!(fs::read(recovered).unwrap().as_slice(), old);
    assert_eq!(files.len(), 3);

    write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Ok(())).unwrap();
    assert_eq!(fs::read_dir(&media).unwrap().count(), files.len());
    drop(media_lease);
    fs::remove_dir_all(media).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_media_preserves_a_destination_with_unrelated_bytes() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_ADD_FILE, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE};
    let media = fixture();
    let mut media_lease = lease_directory(&media, false).unwrap();
    let bytes = b"expected content";
    let (name, reference) = windows_media_reference(bytes);
    let original = b"unrelated";
    let target = media.join(&name);
    fs::write(&target, original).unwrap();

    assert!(write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Ok(())).is_err());
    assert!(OpenOptions::new().access_mode(FILE_ADD_FILE.0).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0).open(&media).is_err());
    assert_eq!(fs::read(&target).unwrap().as_slice(), original);
    let paths: Vec<_> = fs::read_dir(&media).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(paths.len(), 2);
    let staged = paths.iter().find(|path| *path != &target).unwrap();
    assert_eq!(fs::read(staged).unwrap().as_slice(), bytes);
    drop(media_lease);
    fs::remove_dir_all(media).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_media_binding_change_cannot_publish_or_move_existing_bytes() {
    let media = fixture();
    let mut media_lease = lease_directory(&media, false).unwrap();
    let bytes = b"expected content";
    let (name, reference) = windows_media_reference(bytes);
    let target = media.join(&name);
    fs::write(&target, &bytes[..4]).unwrap();

    let result = write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Err(ERROR.into()));
    assert!(result.is_err());
    assert_eq!(fs::read(&target).unwrap().as_slice(), &bytes[..4]);
    drop(media_lease);
    fs::remove_dir_all(media).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_media_reuses_one_verified_stage_after_repeated_failures_and_resumes_a_prefix() {
    let media = fixture();
    let bytes = b"resumable native image bytes";
    let (name, reference) = windows_media_reference(bytes);
    let staging = media.join(format!(".native-media-{name}.pending"));
    let legacy = media.join(format!(".native-media-{}.pending", "a".repeat(64)));
    fs::write(&staging, &bytes[..6]).unwrap();
    fs::write(&legacy, b"legacy recovery material").unwrap();
    let mut media_lease = lease_directory(&media, false).unwrap();
    for _ in 0..3 {
        assert!(write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Err(ERROR.into())).is_err());
        assert_eq!(fs::read(&staging).unwrap().as_slice(), bytes);
        assert_eq!(fs::read_dir(&media).unwrap().count(), 2);
    }
    write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Ok(())).unwrap();
    assert_eq!(fs::read(media.join(&name)).unwrap().as_slice(), bytes);
    assert!(!staging.exists());
    assert_eq!(fs::read(&legacy).unwrap(), b"legacy recovery material");
    assert_eq!(fs::read_dir(&media).unwrap().count(), 2);
    drop(media_lease); fs::remove_dir_all(media).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_media_never_replaces_unrelated_long_locked_or_hard_link_staging_files() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = fixture();
    let bytes = b"expected native media";
    let (name, reference) = windows_media_reference(bytes);
    for scenario in ["unrelated", "long", "locked", "hard-link"] {
        let media = root.join(scenario); fs::create_dir(&media).unwrap();
        let staging = media.join(format!(".native-media-{name}.pending"));
        let original = match scenario {
            "unrelated" => b"different".to_vec(), "long" => vec![1; bytes.len() + 1], _ => bytes[..4].to_vec(),
        };
        fs::write(&staging, &original).unwrap();
        let outside = root.join("source-original");
        if scenario == "hard-link" { fs::hard_link(&staging, &outside).unwrap(); }
        let locked = (scenario == "locked").then(|| OpenOptions::new().read(true).write(true).share_mode(0).open(&staging).unwrap());
        let mut media_lease = lease_directory(&media, false).unwrap();
        for _ in 0..2 {
            assert!(write_windows_media_file(&media, &mut media_lease, &name, &reference, bytes, || Ok(())).is_err());
            assert_eq!(fs::read_dir(&media).unwrap().count(), 1);
        }
        drop(locked);
        assert_eq!(fs::read(&staging).unwrap(), original);
        assert!(!media.join(&name).exists());
        if scenario == "hard-link" { assert_eq!(fs::read(&outside).unwrap(), original); fs::remove_file(outside).unwrap(); }
        drop(media_lease);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn existing_unbound_directory_and_changed_root_are_never_claimed() {
    let root = fixture(); let base = root.join("base"); let other = root.join("other"); let registry = root.join("registry");
    for dir in [&base, &other, &registry] { fs::create_dir(dir).unwrap(); }
    fs::create_dir(base.join(format!("project-{PROJECT}"))).unwrap();
    assert!(bind_root(&base, &registry, PROJECT, true, None).is_err());
    assert!(fs::read_dir(base.join(format!("project-{PROJECT}"))).unwrap().next().is_none());
    let owned = bind_root(&other, &registry, PROJECT, true, None).unwrap();
    assert_eq!(bind_root(&other, &registry, PROJECT, false, None).unwrap(), owned);
    assert_eq!(bind_root(&other, &registry, PROJECT, true, Some("改名不会搬走旧目录")).unwrap(), owned);
    assert!(bind_root(&base, &registry, PROJECT, false, None).is_err());
    fs::remove_file(owned.join(".ai-canvas-native-project.json")).unwrap();
    assert!(bind_root(&other, &registry, PROJECT, false, None).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_identity_or_unbound_root_is_rejected() {
    let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
    fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
    assert!(bind_root(&base, &registry, "../elsewhere", true, Some("项目")).is_err());
    assert!(bind_root(&base, &registry, PROJECT, false, None).is_err());
    assert!(!valid_id("r2-12345678-1234-1123-8123-123456789abc", "r2"));
    assert!(valid_id("r2-12345678-1234-4123-8123-123456789abc", "r2"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn readable_names_are_safe_bounded_utf8_components_with_the_original_uuid_suffix() {
    assert_eq!(named_folder(PROJECT, " .. 新项目结构测试 .. "), "新项目结构测试-12345678");
    assert_eq!(sanitize_project_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
    assert_eq!(sanitize_project_name("\0\r\n . \t"), "project");
    for name in ["CON", "con.txt", "PRN.data", "AUX", "NUL", "COM9", "LPT¹.txt", "CONIN$"] {
        assert!(sanitize_project_name(name).starts_with('_'));
    }
    let truncated_device = format!("CON{}X", " ".repeat(MAX_PROJECT_NAME_BYTES));
    assert_eq!(sanitize_project_name(&truncated_device), "_CON");
    assert_eq!(sanitize_project_name(&sanitize_project_name(&truncated_device)), "_CON");
    let name = "新🎬".repeat(100);
    let cleaned = sanitize_project_name(&name);
    assert!(cleaned.len() <= MAX_PROJECT_NAME_BYTES);
    assert!(name.starts_with(&cleaned));
    assert!(cleaned.len() + name[cleaned.len()..].chars().next().unwrap().len_utf8() > MAX_PROJECT_NAME_BYTES);
    let binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, &name),
        base_sha256: "hash".into(), creation_nonce: Some("a".repeat(64)) };
    assert!(valid_binding(&binding, PROJECT, "hash"));
    assert_eq!(binding.folder.len(), cleaned.len() + 9);
    assert!(!matches_binding(&binding, PROJECT, &format!("project-{PROJECT}"), "hash"));
}

#[test]
fn readable_binding_rejects_paths_wrong_suffixes_unsafe_names_and_unknown_versions() {
    let mut binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "项目"),
        base_sha256: "hash".into(), creation_nonce: Some("a".repeat(64)) };
    for folder in ["../项目-12345678", "/项目-12345678", "C:项目-12345678", "a/b-12345678", "a\\b-12345678",
        "CON.txt-12345678", ".项目-12345678", "项目 -12345678", "项目-87654321", "-12345678"] {
        binding.folder = folder.into(); assert!(!valid_binding(&binding, PROJECT, "hash"), "{folder}");
    }
    binding.folder = named_folder(PROJECT, "项目");
    binding.version = 3; assert!(!valid_binding(&binding, PROJECT, "hash"));
    binding.version = 1; assert!(!valid_binding(&binding, PROJECT, "hash"));
    binding.version = 2; assert!(!valid_binding(&binding, PROJECT, "other-base"));
    assert!(!valid_binding(&binding, "../project", "hash"));
    binding.folder = format!("{}-12345678", "a".repeat(MAX_PROJECT_NAME_BYTES + 1));
    assert!(!valid_binding(&binding, PROJECT, "hash"));
    binding.folder = named_folder(PROJECT, "项目");
    for nonce in [None, Some("a".repeat(63)), Some("A".repeat(64)), Some("g".repeat(64))] {
        binding.creation_nonce = nonce; assert!(!valid_binding(&binding, PROJECT, "hash"));
    }
    binding.version = 1; binding.folder = format!("project-{PROJECT}");
    binding.creation_nonce = Some("a".repeat(64)); assert!(!valid_binding(&binding, PROJECT, "hash"));
    binding.creation_nonce = None; assert!(valid_binding(&binding, PROJECT, "hash"));
    assert!(serde_json::to_value(&binding).unwrap().get("creationNonce").is_none());
}

#[test]
fn new_named_roots_keep_their_binding_across_restarts_and_display_renames() {
    const SECOND: &str = "p2-87654321-1234-4123-8123-123456789abc";
    const SAME_SHORT_ID: &str = "p2-12345678-4321-4321-8321-abcdef123456";
    let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
    fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
    let first = bind_root(&base, &registry, PROJECT, true, Some("新项目结构测试")).unwrap();
    assert_eq!(first, base.join("新项目结构测试-12345678"));
    fs::write(first.join("keep.txt"), b"original").unwrap();
    assert_eq!(bind_root(&base, &registry, PROJECT, false, None).unwrap(), first);
    assert_eq!(bind_root(&base, &registry, PROJECT, true, None).unwrap(), first);
    assert_eq!(bind_root(&base, &registry, PROJECT, true, Some("显示名称已变化")).unwrap(), first);
    assert!(!base.join(named_folder(PROJECT, "显示名称已变化")).exists());
    assert!(!base.join(format!("project-{PROJECT}")).exists());
    assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
    let entry = read_binding(&registry.join(format!("{PROJECT}.json"))).unwrap().unwrap();
    assert_eq!(entry.version, 2);
    assert_eq!(entry.creation_nonce.as_ref().unwrap().len(), 64);
    assert_eq!(read_binding(&registry.join(format!("{PROJECT}.lock"))).unwrap().as_ref(), Some(&entry));
    assert!(!matches_binding(&entry, PROJECT, &format!("project-{PROJECT}"), &base_hash(&base).unwrap()));
    assert_eq!(read_binding(&first.join(".ai-canvas-native-project.json")).unwrap(), Some(entry));
    let second = bind_root(&base, &registry, SECOND, true, Some("新项目结构测试")).unwrap();
    assert_eq!(second, base.join("新项目结构测试-87654321"));
    assert_ne!(first, second);
    assert!(bind_root(&base, &registry, SAME_SHORT_ID, true, Some("新项目结构测试")).is_err());
    assert!(!registry.join(format!("{SAME_SHORT_ID}.json")).exists());
    assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn occupied_named_roots_and_unbound_legacy_roots_are_not_taken_over() {
    let root = fixture(); let base = root.join("base"); let registry = root.join("registry");
    fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
    let occupied = base.join(named_folder(PROJECT, "同名项目"));
    fs::create_dir(&occupied).unwrap(); fs::write(occupied.join("keep.txt"), b"unowned").unwrap();
    assert!(bind_root(&base, &registry, PROJECT, true, Some("同名项目")).is_err());
    assert_eq!(fs::read(occupied.join("keep.txt")).unwrap(), b"unowned");
    assert!(!occupied.join(".ai-canvas-native-project.json").exists());
    assert!(!registry.join(format!("{PROJECT}.json")).exists());
    assert!(fs::read(registry.join(format!("{PROJECT}.lock"))).unwrap().is_empty());
    let old = base.join(format!("project-{PROJECT}")); fs::create_dir(&old).unwrap();
    fs::write(old.join("keep.txt"), b"legacy-failure-evidence").unwrap();
    assert!(bind_root(&base, &registry, PROJECT, true, Some("另一名称")).is_err());
    assert!(!base.join(named_folder(PROJECT, "另一名称")).exists());
    assert_eq!(fs::read(old.join("keep.txt")).unwrap(), b"legacy-failure-evidence");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn another_profiles_same_project_and_folder_cannot_publish_its_private_binding_over_the_original_root() {
    let root = fixture(); let base = root.join("base");
    let first_registry = root.join("profile-a"); let other_registry = root.join("profile-b");
    for directory in [&base, &first_registry, &other_registry] { fs::create_dir(directory).unwrap(); }
    let first_intent = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "同一个项目"),
        base_sha256: base_hash(&base).unwrap(), creation_nonce: Some("a".repeat(64)) };
    let other_intent = Binding { version: 2, project_id: PROJECT.into(), folder: first_intent.folder.clone(),
        base_sha256: first_intent.base_sha256.clone(), creation_nonce: Some("b".repeat(64)) };
    write_binding(&first_registry.join(format!("{PROJECT}.lock")), &first_intent).unwrap();
    write_binding(&other_registry.join(format!("{PROJECT}.lock")), &other_intent).unwrap();
    let target = bind_root(&base, &first_registry, PROJECT, true, Some("后续名称无权改变意图")).unwrap();
    fs::write(target.join("keep.txt"), b"original-profile").unwrap();
    assert!(bind_root(&base, &other_registry, PROJECT, true, Some("同一个项目")).is_err());
    assert!(!other_registry.join(format!("{PROJECT}.json")).exists());
    assert_eq!(read_binding(&other_registry.join(format!("{PROJECT}.lock"))).unwrap(), Some(other_intent));
    assert_eq!(read_binding(&target.join(".ai-canvas-native-project.json")).unwrap(), Some(first_intent));
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"original-profile");
    assert_eq!(bind_root(&base, &first_registry, PROJECT, false, None).unwrap(), target);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_intent_without_creation_nonce_never_adopts_an_existing_directory() {
    let root = fixture();
    for exists in [false, true] {
        let stage = root.join(if exists { "occupied" } else { "uncreated" }); fs::create_dir(&stage).unwrap();
        let base = stage.join("base"); let registry = stage.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        let binding = Binding { version: 1, project_id: PROJECT.into(), folder: format!("project-{PROJECT}"),
            base_sha256: base_hash(&base).unwrap(), creation_nonce: None };
        write_binding(&registry.join(format!("{PROJECT}.lock")), &binding).unwrap();
        let target = base.join(&binding.folder);
        if exists {
            fs::create_dir(&target).unwrap(); write_binding(&target.join(".ai-canvas-native-project.json"), &binding).unwrap();
            assert!(bind_root(&base, &registry, PROJECT, true, Some("不能绕过旧目录")).is_err());
            assert!(!registry.join(format!("{PROJECT}.json")).exists());
        } else {
            assert_eq!(bind_root(&base, &registry, PROJECT, true, Some("旧意图仍使用原目录")).unwrap(), target);
            assert_eq!(read_binding(&registry.join(format!("{PROJECT}.json"))).unwrap(), Some(binding));
        }
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn durable_creation_intent_recovers_only_the_original_folder_before_or_after_root_marker() {
    let root = fixture();
    for ready in [false, true] {
        let stage = root.join(if ready { "root-ready" } else { "intent-only" });
        fs::create_dir(&stage).unwrap();
        let base = stage.join("base"); let registry = stage.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        let binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "冻结的原始项目名"),
            base_sha256: base_hash(&base).unwrap(), creation_nonce: Some("a".repeat(64)) };
        write_binding(&registry.join(format!("{PROJECT}.lock")), &binding).unwrap();
        let target = base.join(&binding.folder);
        if ready {
            fs::create_dir(&target).unwrap(); write_binding(&target.join(".ai-canvas-native-project.json"), &binding).unwrap();
            fs::write(target.join("keep.txt"), b"original").unwrap();
        }
        assert_eq!(bind_root(&base, &registry, PROJECT, true, Some("重启后改名")).unwrap(), target);
        assert!(!base.join(named_folder(PROJECT, "重启后改名")).exists());
        assert_eq!(read_binding(&registry.join(format!("{PROJECT}.json"))).unwrap(), Some(binding));
        assert_eq!(bind_root(&base, &registry, PROJECT, false, None).unwrap(), target);
        if ready { assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"original"); }
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn incomplete_or_mismatched_creation_evidence_cannot_be_bypassed_by_another_name() {
    let root = fixture();
    for failure in ["partial-intent", "wrong-intent", "missing-marker", "wrong-marker"] {
        let stage = root.join(failure); fs::create_dir(&stage).unwrap();
        let base = stage.join("base"); let registry = stage.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        let binding = Binding { version: 2, project_id: PROJECT.into(), folder: named_folder(PROJECT, "首次名称"),
            base_sha256: base_hash(&base).unwrap(), creation_nonce: Some("a".repeat(64)) };
        let lock = registry.join(format!("{PROJECT}.lock"));
        if failure == "partial-intent" { fs::write(&lock, b"{\"version\":2,").unwrap(); }
        else if failure == "wrong-intent" {
            write_binding(&lock, &Binding { base_sha256: "other-base".into(), ..binding }).unwrap();
        } else {
            write_binding(&lock, &binding).unwrap();
            let target = base.join(&binding.folder); fs::create_dir(&target).unwrap();
            fs::write(target.join("keep.txt"), b"failure-evidence").unwrap();
            if failure == "wrong-marker" { write_binding(&target.join(".ai-canvas-native-project.json"),
                &Binding { version: 1, ..binding }).unwrap(); }
        }
        let original_intent = fs::read(&lock).unwrap();
        assert!(bind_root(&base, &registry, PROJECT, true, Some("改名也不能另建")).is_err());
        assert!(!registry.join(format!("{PROJECT}.json")).exists());
        assert!(!base.join(named_folder(PROJECT, "改名也不能另建")).exists());
        assert_eq!(fs::read(lock).unwrap(), original_intent);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn media_references_never_accept_paths_or_unmapped_formats() {
    let hash = "a".repeat(64);
    let mut reference = NativeMediaReference { relative_path: format!("media/{hash}.png"), sha256: hash, bytes: 1, mime_type: "image/png".into() };
    assert!(validate_media_reference(&reference).is_ok());
    reference.relative_path = "../elsewhere.png".into();
    assert!(validate_media_reference(&reference).is_err());
    reference.relative_path = format!("media/{}.png", reference.sha256);
    reference.mime_type = "image/unknown".into();
    assert!(validate_media_reference(&reference).is_err());
    reference.mime_type = "image/png".into();
    reference.bytes = 32 * 1024 * 1024 + 1;
    assert!(validate_media_reference(&reference).is_err());
}

#[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
mod unix_media {
    use super::*;
    use std::os::unix::fs::symlink;

    fn setup() -> (PathBuf, PathBuf) {
        let root = fixture();
        let base = root.join("base"); let registry = root.join("registry");
        fs::create_dir(&base).unwrap(); fs::create_dir(&registry).unwrap();
        let project = bind_root(&base, &registry, PROJECT, true, Some("蒙板素材")).unwrap();
        (root, project)
    }

    fn mask() -> (Vec<u8>, NativeMediaReference, String) {
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(2, 2));
        let mut output = std::io::Cursor::new(Vec::new());
        image.write_to(&mut output, image::ImageFormat::Png).unwrap();
        let bytes = output.into_inner();
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let reference = NativeMediaReference { relative_path: format!("media/{sha256}.png"), sha256,
            bytes: bytes.len() as u64, mime_type: "image/png".into() };
        let name = validate_media_reference(&reference).unwrap();
        (bytes, reference, name)
    }

    #[test]
    fn mask_publication_is_exclusive_round_trips_and_reuses_valid_content_after_reopen() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        directory.write(&name, &reference, &bytes).unwrap();
        assert_eq!(directory.read(&name, &reference).unwrap(), bytes);
        directory.write(&name, &reference, &bytes).unwrap();
        assert_eq!(fs::read_dir(project.join("media")).unwrap().count(), 1);
        drop(directory);
        assert_eq!(bind_root(&root.join("base"), &root.join("registry"), PROJECT, false, None).unwrap(), project);
        let reopened = unix_io::Directory::open(&project, false).unwrap();
        assert_eq!(reopened.read(&name, &reference).unwrap(), bytes);
        drop(reopened); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_existing_content_is_preserved_and_never_overwritten() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        let target = project.join("media").join(&name);
        for invalid in [b"short".to_vec(), vec![0; bytes.len()]] {
            fs::write(&target, &invalid).unwrap();
            assert!(directory.read(&name, &reference).is_err());
            assert!(directory.write(&name, &reference, &bytes).is_err());
            assert_eq!(fs::read(&target).unwrap(), invalid);
        }
        drop(directory); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_staging_is_reused_without_poisoning_the_final_content_filename() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        assert!(directory.write(&name, &reference, &bytes[..8]).is_err());
        assert!(!project.join("media").join(&name).exists());
        let staging = fs::read_dir(project.join("media")).unwrap().next().unwrap().unwrap().path();
        assert!(staging.file_name().unwrap().to_str().unwrap().starts_with(".native-media-"));
        assert_eq!(fs::read(&staging).unwrap(), bytes[..8]);
        assert!(directory.write(&name, &reference, &bytes[..8]).is_err());
        assert_eq!(fs::read_dir(project.join("media")).unwrap().count(), 1);
        directory.write(&name, &reference, &bytes).unwrap();
        assert_eq!(directory.read(&name, &reference).unwrap(), bytes);
        assert!(!staging.exists());
        assert_eq!(fs::read_dir(project.join("media")).unwrap().count(), 1);
        drop(directory); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn complete_staging_survives_reopen_and_legacy_random_material_is_retained() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        let staging = project.join("media").join(format!(".native-media-{name}.pending"));
        let legacy = project.join("media").join(format!(".native-media-{}.pending", "a".repeat(64)));
        fs::write(&staging, &bytes).unwrap(); fs::write(&legacy, b"legacy recovery").unwrap();
        drop(directory);
        let reopened = unix_io::Directory::open(&project, false).unwrap();
        reopened.write(&name, &reference, &bytes).unwrap();
        assert_eq!(reopened.read(&name, &reference).unwrap(), bytes);
        assert!(!staging.exists());
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy recovery");
        assert_eq!(fs::read_dir(project.join("media")).unwrap().count(), 2);
        drop(reopened); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unrelated_long_locked_and_linked_stages_are_preserved_without_new_files() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        let staging = project.join("media").join(format!(".native-media-{name}.pending"));
        for invalid in [b"unrelated".to_vec(), vec![0; bytes.len() + 1]] {
            fs::write(&staging, &invalid).unwrap();
            for _ in 0..2 { assert!(directory.write(&name, &reference, &bytes).is_err()); }
            assert_eq!(fs::read(&staging).unwrap(), invalid);
            assert_eq!(fs::read_dir(project.join("media")).unwrap().count(), 1);
        }
        fs::write(&staging, &bytes[..8]).unwrap();
        let locked = OpenOptions::new().read(true).write(true).open(&staging).unwrap();
        FileExt::try_lock_exclusive(&locked).unwrap();
        assert!(directory.write(&name, &reference, &bytes).is_err());
        assert_eq!(fs::read(&staging).unwrap(), bytes[..8]);
        drop(locked); fs::remove_file(&staging).unwrap();
        let outside = root.join("original.png"); fs::write(&outside, &bytes[..8]).unwrap();
        for hard_link in [false, true] {
            if hard_link { fs::hard_link(&outside, &staging).unwrap(); } else { symlink(&outside, &staging).unwrap(); }
            assert!(directory.write(&name, &reference, &bytes).is_err());
            assert_eq!(fs::read(&outside).unwrap(), bytes[..8]);
            assert_eq!(fs::read_dir(project.join("media")).unwrap().count(), 1);
            fs::remove_file(&staging).unwrap();
        }
        assert!(!project.join("media").join(name).exists());
        drop(directory); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbolic_media_directories_and_symbolic_ancestors_are_rejected() {
        let (root, project) = setup();
        let outside = root.join("outside"); fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"original").unwrap();
        symlink(&outside, project.join("media")).unwrap();
        assert!(unix_io::Directory::open(&project, true).is_err());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"original");
        fs::remove_file(project.join("media")).unwrap();
        let alias = root.join("alias"); symlink(project.parent().unwrap(), &alias).unwrap();
        assert!(unix_io::Directory::open(&alias.join(project.file_name().unwrap()), true).is_err());
        assert!(!project.join("media").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbolic_and_hard_link_media_files_cannot_escape_the_project_boundary() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        let outside = root.join("original.png"); fs::write(&outside, &bytes).unwrap();
        let target = project.join("media").join(&name);
        symlink(&outside, &target).unwrap();
        assert!(directory.read(&name, &reference).is_err());
        assert!(directory.write(&name, &reference, &bytes).is_err());
        fs::remove_file(&target).unwrap(); fs::hard_link(&outside, &target).unwrap();
        assert!(directory.read(&name, &reference).is_err());
        assert!(directory.write(&name, &reference, &bytes).is_err());
        assert_eq!(fs::read(outside).unwrap(), bytes);
        drop(directory); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replaced_root_or_media_directories_never_redirect_an_opened_operation() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        let moved = project.with_file_name("original-root"); fs::rename(&project, &moved).unwrap();
        fs::create_dir(&project).unwrap(); fs::create_dir(project.join("media")).unwrap();
        fs::copy(moved.join(".ai-canvas-native-project.json"), project.join(".ai-canvas-native-project.json")).unwrap();
        assert!(directory.write(&name, &reference, &bytes).is_err());
        assert!(!moved.join("media").join(&name).exists());
        assert!(!project.join("media").join(&name).exists());
        drop(directory);

        let directory = unix_io::Directory::open(&project, true).unwrap();
        let original_media = project.join("original-media"); fs::rename(project.join("media"), &original_media).unwrap();
        fs::create_dir(project.join("media")).unwrap();
        assert!(directory.write(&name, &reference, &bytes).is_err());
        assert!(!original_media.join(&name).exists());
        assert!(!project.join("media").join(&name).exists());
        drop(directory); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replaced_or_mutated_ownership_markers_fail_closed_even_with_the_same_path() {
        let (root, project) = setup();
        let (bytes, reference, name) = mask();
        let directory = unix_io::Directory::open(&project, true).unwrap();
        let marker = project.join(".ai-canvas-native-project.json");
        let original = fs::read(&marker).unwrap();
        fs::write(&marker, b"{}").unwrap();
        assert!(directory.write(&name, &reference, &bytes).is_err());
        fs::write(&marker, &original).unwrap();
        let previous = project.join("original-marker"); fs::rename(&marker, &previous).unwrap();
        fs::write(&marker, &original).unwrap();
        assert!(directory.write(&name, &reference, &bytes).is_err());
        assert!(!project.join("media").join(&name).exists());
        drop(directory); fs::remove_dir_all(root).unwrap();
    }
}
