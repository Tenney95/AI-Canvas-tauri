    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Cursor;
    use tar::{Builder, EntryType, Header};

    fn temporary_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ai-canvas-agent-package-{name}-{}-{}",
            std::process::id(),
            SOURCE_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("应创建测试目录");
        path
    }

    fn write_test_archive(path: &Path, entries: &[(&str, &[u8], EntryType)]) {
        let file = File::create(path).expect("应创建归档");
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);
        for (name, content, entry_type) in entries {
            let mut header = Header::new_gnu();
            header.set_entry_type(*entry_type);
            header.set_mode(0o644);
            header.set_size(content.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, *name, Cursor::new(*content))
                .expect("应写入归档项");
        }
        let encoder = builder.into_inner().expect("应完成 tar");
        encoder.finish().expect("应完成 gzip");
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(normalize_relative_path(Path::new("../secret.txt")).is_err());
        assert!(normalize_relative_path(Path::new("/absolute.txt")).is_err());
        assert!(normalize_relative_path(Path::new("folder\\file.txt")).is_err());
        assert!(normalize_requested_relative_path("C:/secret.txt").is_err());
        assert!(normalize_requested_relative_path("~/.ssh/id_rsa").is_err());
        assert_eq!(
            relative_path_text(&normalize_relative_path(Path::new("./docs/a.md")).unwrap())
                .unwrap(),
            "docs/a.md"
        );
    }

    #[test]
    fn private_directory_check_does_not_match_siblings() {
        let root = PathBuf::from("/data/app/agent-private");
        assert!(is_under_agent_private_dir(
            &root,
            Path::new("/data/app/agent-private/sources.json")
        ));
        assert!(!is_under_agent_private_dir(
            &root,
            Path::new("/data/app/agent-private-copy/sources.json")
        ));
    }

    #[test]
    fn scans_manifestless_agent_without_executing_scripts() {
        let root = temporary_directory("manifestless");
        fs::write(root.join("AGENTS.md"), "# Agent\n只读说明").unwrap();
        fs::write(root.join("VERSION"), "1.2.3\n").unwrap();
        fs::create_dir_all(root.join("skills/demo")).unwrap();
        fs::write(root.join("skills/demo/SKILL.md"), "# Demo").unwrap();
        fs::write(root.join("run.py"), "raise RuntimeError('must not run')").unwrap();

        let preview = inspect_source(&root, "src_test123", AgentSourceType::Folder, "测试智能体")
            .expect("无清单目录应可预检");
        assert_eq!(preview.health, "ready");
        assert!(!preview
            .warnings
            .iter()
            .any(|warning| warning.contains(MANIFEST_FILE_NAME)));
        assert_eq!(preview.version, "1.2.3");
        assert_eq!(preview.skill_count, 1);
        assert!(preview.entrypoints.contains(&"AGENTS.md".to_string()));
        assert!(root.join("run.py").is_file(), "扫描不得执行或删除脚本");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn manifestless_readiness_does_not_relax_invalid_source_checks() {
        let invalid_manifest = temporary_directory("invalid-manifest");
        fs::write(
            invalid_manifest.join(MANIFEST_FILE_NAME),
            "{ definitely not json",
        )
        .unwrap();
        fs::write(invalid_manifest.join("AGENTS.md"), "# Agent").unwrap();
        assert!(inspect_source(
            &invalid_manifest,
            "src_invalid_manifest",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .is_err_and(|error| error.contains("智能体清单不是有效 JSON")));

        let missing_entrypoint = temporary_directory("missing-entrypoint");
        fs::write(
            missing_entrypoint.join(MANIFEST_FILE_NAME),
            r#"{"schemaVersion":1,"entrypoints":{"instructions":"missing.md"}}"#,
        )
        .unwrap();
        assert!(inspect_source(
            &missing_entrypoint,
            "src_missing_entrypoint",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .is_err_and(|error| error.contains("智能体清单入口不存在")));

        let missing_instruction = temporary_directory("missing-instruction");
        assert!(inspect_source(
            &missing_instruction,
            "src_missing_instruction",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .is_err_and(|error| error.contains("智能体目录缺少 AGENTS.md、SKILL.md 或清单指令入口")));

        fs::remove_dir_all(invalid_manifest).ok();
        fs::remove_dir_all(missing_entrypoint).ok();
        fs::remove_dir_all(missing_instruction).ok();
    }

    #[test]
    fn registry_preview_never_persists_instruction_body() {
        let root = temporary_directory("registry-preview");
        fs::write(root.join("AGENTS.md"), "# Private instruction body").unwrap();

        let preview = inspect_source(
            &root,
            "src_registry123",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .expect("目录应可预检");
        let stored = preview_for_registry(&preview);

        assert!(!preview.instruction_text.is_empty());
        assert!(stored.instruction_text.is_empty());
        assert_eq!(stored.content_hash, preview.content_hash);
        assert_eq!(stored.entrypoints, preview.entrypoints);
        fs::remove_dir_all(root).ok();
    }

    struct RegistryFixtureDirectory(PathBuf);

    impl Drop for RegistryFixtureDirectory {
        fn drop(&mut self) {
            for filename in [
                "AGENTS.md",
                REGISTRY_FILE_NAME,
                REGISTRY_BACKUP_FILE_NAME,
                REGISTRY_TEMP_FILE_NAME,
            ] {
                let _ = fs::remove_file(self.0.join(filename));
            }
            let _ = fs::remove_dir(&self.0);
        }
    }

    fn with_registry_backup(test: impl FnOnce(&Path)) {
        let nonce = u64::from_le_bytes(crate::secure_random::random_bytes().unwrap());
        let directory = std::env::temp_dir().join(format!("ai-canvas-agent-registry-fixture-{nonce:016x}"));
        // 独占创建成功后才允许写入和清理，已有目录即使重名也不会被碰触。
        fs::create_dir(&directory).expect("应创建独立的注册表测试目录");
        let fixture = RegistryFixtureDirectory(directory);
        fs::write(fixture.0.join("AGENTS.md"), "# Agent fixture").unwrap();
        let source_id = "src_registrybackup";
        let preview = inspect_source(
            &fixture.0,
            source_id,
            AgentSourceType::Folder,
            "备份来源",
        )
        .unwrap();
        let mut backup_registry = SourceRegistry::default();
        backup_registry.sources.insert(
            source_id.into(),
            StoredSource {
                source_id: source_id.into(),
                source_type: AgentSourceType::Folder,
                root_path: fixture.0.to_string_lossy().into_owned(),
                managed_container_path: None,
                preview: preview_for_registry(&preview),
                updated_at: 1,
            },
        );
        let backup = fixture.0.join(REGISTRY_BACKUP_FILE_NAME);
        let backup_bytes = serde_json::to_vec(&backup_registry).unwrap();
        fs::write(&backup, &backup_bytes).unwrap();
        assert!(read_registry_at(&backup)
            .unwrap()
            .sources
            .contains_key(source_id));

        test(&fixture.0.join(REGISTRY_FILE_NAME));

        assert_eq!(fs::read(backup).unwrap(), backup_bytes);
    }

    #[test]
    fn registry_missing_primary_returns_empty_even_with_valid_backup() {
        with_registry_backup(|primary| {
            let registry = read_registry_at(primary).unwrap();
            assert_eq!(registry.schema_version, REGISTRY_SCHEMA_VERSION);
            assert!(registry.sources.is_empty());
            assert_eq!(
                fs::symlink_metadata(primary).unwrap_err().kind(),
                std::io::ErrorKind::NotFound
            );
        });
    }

    #[test]
    fn registry_corrupt_primary_reports_error_even_with_valid_backup() {
        with_registry_backup(|primary| {
            let corrupt = b"{";
            fs::write(primary, corrupt).unwrap();

            assert_eq!(read_registry_at(primary).unwrap_err(), "智能体来源注册表损坏");
            assert_eq!(fs::read(primary).unwrap(), corrupt);
        });
    }

    #[test]
    fn reads_manifest_v1_and_flattens_entrypoints() {
        let root = temporary_directory("manifest");
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"schemaVersion":1,"name":"示例智能体","version":"2.0.0","entrypoints":{"instructions":"AGENTS.md","router":"router.md"}}"#,
        )
        .unwrap();
        fs::write(root.join("AGENTS.md"), "# Instructions").unwrap();
        fs::write(root.join("router.md"), "# Router").unwrap();

        let preview = inspect_source(&root, "src_test456", AgentSourceType::Folder, "fallback")
            .expect("Manifest v1 应可预检");
        assert_eq!(preview.health, "ready");
        assert_eq!(preview.name, "示例智能体");
        assert_eq!(preview.version, "2.0.0");
        assert_eq!(
            preview.entrypoints,
            vec!["AGENTS.md".to_string(), "router.md".to_string()]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn preview_never_exposes_the_selected_root_path() {
        let root = temporary_directory("redaction");
        let root_text = root.to_string_lossy().to_string();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "name": "脱敏测试",
                "version": "1",
                "entrypoints": { "instructions": "AGENTS.md" },
                "localHint": root_text,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("AGENTS.md"),
            format!("本地根目录仅用于测试：{}", root.to_string_lossy()),
        )
        .unwrap();

        let preview = inspect_source(&root, "src_redacted", AgentSourceType::Folder, "fallback")
            .expect("预览应成功");
        assert!(!preview.instruction_text.contains(&root_text));
        assert_eq!(
            preview
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.get("localHint"))
                .and_then(Value::as_str),
            Some("[agent-root]")
        );
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(serialized.contains("[agent-root]"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_preflight_and_extract_accept_safe_tar_gz() {
        let root = temporary_directory("safe-archive");
        let archive = root.join("demo.aicanvas-agent");
        write_test_archive(
            &archive,
            &[
                ("demo/AGENTS.md", b"# Agent", EntryType::Regular),
                ("demo/skills/a/SKILL.md", b"# Skill", EntryType::Regular),
            ],
        );
        let preflight = preflight_archive(&archive).expect("安全归档应通过预检");
        assert_eq!(preflight.expanded_bytes, 14);
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        extract_archive(&archive, &staging).expect("安全归档应解压");
        assert!(staging.join("demo/AGENTS.md").is_file());
        assert_eq!(
            discover_package_root(&staging).unwrap(),
            staging.join("demo")
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_accepts_global_pax_metadata_without_extracting_it() {
        let root = temporary_directory("global-pax-archive");
        let archive = root.join("github.tar.gz");
        let metadata = b"15 comment=git\n";
        write_test_archive(
            &archive,
            &[
                ("pax_global_header", metadata, EntryType::XGlobalHeader),
                ("demo/AGENTS.md", b"# Agent", EntryType::Regular),
                ("demo/skills/a/SKILL.md", b"# Skill", EntryType::Regular),
            ],
        );
        let preflight = preflight_archive(&archive).expect("全局 PAX 元数据应通过预检");
        assert_eq!(preflight.expanded_bytes, 14 + metadata.len() as u64);
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        extract_archive(&archive, &staging).expect("含 PAX 元数据的归档应解压");
        assert!(!staging.join("pax_global_header").exists());
        let package_root = discover_package_root(&staging).unwrap();
        assert_eq!(package_root, staging.join("demo"));
        let preview = inspect_source(
            &package_root,
            "src_pax_archive",
            AgentSourceType::Archive,
            "demo",
        )
        .expect("解压结果应通过智能体扫描");
        assert_eq!(preview.health, "ready");
        assert_eq!(preview.skill_count, 1);
        assert_eq!(preview.file_count, 2);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_with_global_pax_still_rejects_links_and_special_files() {
        for entry_type in [
            EntryType::Symlink,
            EntryType::Link,
            EntryType::Char,
            EntryType::Block,
            EntryType::Fifo,
        ] {
            let root = temporary_directory("global-pax-unsafe-entry");
            let archive = root.join("unsafe.tar.gz");
            write_test_archive(
                &archive,
                &[
                    (
                        "pax_global_header",
                        b"15 comment=git\n",
                        EntryType::XGlobalHeader,
                    ),
                    ("AGENTS.md", b"# Agent", EntryType::Regular),
                    ("unsafe", b"", entry_type),
                ],
            );
            assert_eq!(
                preflight_archive(&archive).unwrap_err(),
                "智能体压缩包包含不允许的链接或设备文件"
            );
            let staging = root.join("staging");
            fs::create_dir_all(&staging).unwrap();
            assert_eq!(
                extract_archive(&archive, &staging).unwrap_err(),
                "智能体压缩包包含不允许的链接或设备文件"
            );
            fs::remove_dir_all(root).ok();
        }
    }

    #[test]
    fn archive_rejects_oversized_global_pax_metadata() {
        let root = temporary_directory("oversized-global-pax");
        let archive = root.join("oversized.tar.gz");
        let metadata = vec![b'a'; MAX_ARCHIVE_METADATA_BYTES as usize + 1];
        write_test_archive(
            &archive,
            &[
                ("pax_global_header", &metadata, EntryType::XGlobalHeader),
                ("AGENTS.md", b"# Agent", EntryType::Regular),
            ],
        );
        assert_eq!(
            preflight_archive(&archive).unwrap_err(),
            "智能体压缩包元数据超过大小限制"
        );
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        assert_eq!(
            extract_archive(&archive, &staging).unwrap_err(),
            "智能体压缩包元数据超过大小限制"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_checks_effective_paths_after_local_pax_extensions() {
        let root = temporary_directory("unsafe-local-pax-path");
        let archive = root.join("unsafe-path.tar.gz");
        write_test_archive(
            &archive,
            &[
                (
                    "pax_global_header",
                    b"15 comment=git\n",
                    EntryType::XGlobalHeader,
                ),
                ("AGENTS.md", b"# Agent", EntryType::Regular),
                (
                    "pax_local_header",
                    b"22 path=../escape.txt\n",
                    EntryType::XHeader,
                ),
                ("safe.txt", b"blocked", EntryType::Regular),
            ],
        );
        assert_eq!(
            preflight_archive(&archive).unwrap_err(),
            "智能体包包含越界路径"
        );
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        assert_eq!(
            extract_archive(&archive, &staging).unwrap_err(),
            "智能体包包含越界路径"
        );
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_rejects_links() {
        let root = temporary_directory("link-archive");
        let archive = root.join("link.tgz");
        write_test_archive(
            &archive,
            &[
                ("AGENTS.md", b"# Agent", EntryType::Regular),
                ("escape", b"target", EntryType::Symlink),
            ],
        );
        assert!(preflight_archive(&archive).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_rejects_duplicate_paths() {
        let root = temporary_directory("duplicate-archive");
        let archive = root.join("duplicate.tar.gz");
        write_test_archive(
            &archive,
            &[
                ("AGENTS.md", b"first", EntryType::Regular),
                ("AGENTS.md", b"second", EntryType::Regular),
            ],
        );
        assert!(preflight_archive(&archive).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn content_hash_changes_with_file_content() {
        let root = temporary_directory("hash");
        fs::write(root.join("AGENTS.md"), "one").unwrap();
        let first = scan_source(&root).unwrap().content_hash;
        fs::write(root.join("AGENTS.md"), "two").unwrap();
        let second = scan_source(&root).unwrap().content_hash;
        assert_ne!(first, second);
        fs::remove_dir_all(root).ok();
    }
