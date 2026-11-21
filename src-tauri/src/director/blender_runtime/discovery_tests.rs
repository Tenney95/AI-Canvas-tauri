    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    pub(super) struct TestDirectory {
        pub(super) path: PathBuf,
    }

    impl TestDirectory {
        pub(super) fn new(name: &str) -> Self {
            let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("系统时间应晚于 Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "ai-canvas-blender-runtime-{name}-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("应能创建测试目录");
            Self { path }
        }

        fn discovery_root(&self, source: BlenderInstallationSource) -> DiscoveryRoot {
            DiscoveryRoot {
                source,
                path: self.path.clone(),
            }
        }

        fn create_candidate(&self, directory_name: &str) -> PathBuf {
            let directory = self
                .path
                .join(BLENDER_VENDOR_DIRECTORY)
                .join(directory_name);
            fs::create_dir_all(&directory).expect("应能创建候选目录");
            let executable = directory.join(BLENDER_EXECUTABLE_NAME);
            fs::write(&executable, b"test-only placeholder").expect("应能创建候选文件");
            executable
        }

        fn create_manual_x64_candidate(&self) -> PathBuf {
            let directory = self
                .path
                .join("Program Files (x86)")
                .join("Steam")
                .join("steamapps")
                .join("common")
                .join("Blender");
            fs::create_dir_all(&directory).expect("应能创建手选候选目录");
            let executable = directory.join(BLENDER_EXECUTABLE_NAME);
            let mut bytes = vec![0u8; 126];
            bytes[0..2].copy_from_slice(b"MZ");
            bytes[60..64].copy_from_slice(&120u32.to_le_bytes());
            bytes[120..124].copy_from_slice(b"PE\0\0");
            bytes[124..126].copy_from_slice(&0x8664u16.to_le_bytes());
            fs::write(&executable, bytes).expect("应能创建最小 x64 PE 候选");
            executable
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn discovers_only_fixed_standard_level_without_exposing_paths() {
        let root = TestDirectory::new("fixed-level");
        root.create_candidate("Blender 4.5");

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles64)
        ]);

        assert_eq!(installations.len(), 1);
        let candidate = &installations[0].candidate;
        assert_eq!(candidate.display_name, "Blender 4.5");
        assert_eq!(candidate.version_hint.as_deref(), Some("4.5"));
        assert!(!candidate.version_hint_is_verified);

        let serialized = serde_json::to_string(candidate).expect("候选应可序列化");
        assert!(!serialized.contains(&root.path.to_string_lossy().to_string()));
        assert!(!serialized.contains(BLENDER_EXECUTABLE_NAME));
        assert!(serialized.contains("\"source\":\"program-files-64\""));
    }

    #[test]
    fn ignores_wrong_filename_overdeep_and_non_file_candidates() {
        let root = TestDirectory::new("invalid-shapes");
        let vendor = root.path.join(BLENDER_VENDOR_DIRECTORY);
        let wrong_name = vendor.join("Blender 4.1");
        fs::create_dir_all(&wrong_name).expect("应能创建错误文件名目录");
        fs::write(wrong_name.join("blender.bin"), b"not blender.exe").expect("应能创建错误文件名");

        let overdeep = vendor.join("Blender 4.2").join("extra");
        fs::create_dir_all(&overdeep).expect("应能创建过深目录");
        fs::write(overdeep.join(BLENDER_EXECUTABLE_NAME), b"too deep").expect("应能创建过深候选");

        let directory_candidate = vendor.join("Blender 4.3").join(BLENDER_EXECUTABLE_NAME);
        fs::create_dir_all(&directory_candidate).expect("应能创建同名目录");

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(installations.is_empty());
    }

    #[test]
    fn deduplicates_roots_and_keeps_stable_opaque_id() {
        let root = TestDirectory::new("deduplicate");
        root.create_candidate("Blender 4.4");
        let roots = vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles64),
            root.discovery_root(BlenderInstallationSource::ProgramFiles),
        ];

        let first = discover_from_roots(roots.clone());
        let second = discover_from_roots(roots);

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].candidate, second[0].candidate);
        assert_eq!(
            first[0].candidate.source,
            BlenderInstallationSource::ProgramFiles64
        );
        assert!(first[0]
            .candidate
            .installation_id
            .starts_with("blender-installation-v1-"));
        assert!(!first[0]
            .candidate
            .installation_id
            .contains(&root.path.to_string_lossy().to_string()));
    }

    #[test]
    fn returns_stably_sorted_bounded_candidates() {
        let root = TestDirectory::new("candidate-limit");
        for index in 0..(MAX_RETURNED_CANDIDATES + 4) {
            root.create_candidate(&format!("Blender 4.{index:02}"));
        }

        let first_snapshot = scan_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(first_snapshot.truncated);
        let first = first_snapshot.installations;
        let second = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);

        assert_eq!(first.len(), MAX_RETURNED_CANDIDATES);
        assert_eq!(
            first
                .iter()
                .map(|installation| &installation.candidate)
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|installation| &installation.candidate)
                .collect::<Vec<_>>()
        );
        assert!(first.windows(2).all(|pair| {
            pair[0].candidate.display_name.to_lowercase()
                <= pair[1].candidate.display_name.to_lowercase()
        }));
    }

    #[test]
    fn candidate_limit_boundary_is_exact() {
        let accepted_root = TestDirectory::new("candidate-limit-accepted");
        for index in 0..MAX_RETURNED_CANDIDATES {
            accepted_root.create_candidate(&format!("Blender 4.{index:02}"));
        }
        let accepted = scan_from_roots(vec![
            accepted_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert_eq!(accepted.installations.len(), MAX_RETURNED_CANDIDATES);
        assert!(!accepted.truncated);

        let truncated_root = TestDirectory::new("candidate-limit-truncated");
        for index in 0..=MAX_RETURNED_CANDIDATES {
            truncated_root.create_candidate(&format!("Blender 4.{index:02}"));
        }
        let truncated = scan_from_roots(vec![
            truncated_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert_eq!(truncated.installations.len(), MAX_RETURNED_CANDIDATES);
        assert!(truncated.truncated);
    }

    #[test]
    fn accepts_entry_limit_and_rejects_the_next_entry_deterministically() {
        let accepted_root = TestDirectory::new("entry-limit-accepted");
        accepted_root.create_candidate("Blender 4.5");
        let accepted_vendor = accepted_root.path.join(BLENDER_VENDOR_DIRECTORY);
        for index in 0..(MAX_DIRECTORY_ENTRIES - 1) {
            fs::create_dir_all(accepted_vendor.join(format!("entry-{index:03}")))
                .expect("应能创建边界测试目录");
        }
        let accepted = scan_from_roots(vec![
            accepted_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert_eq!(accepted.installations.len(), 1);
        assert!(!accepted.partial);
        assert!(!accepted.truncated);

        let rejected_root = TestDirectory::new("entry-limit-rejected");
        let rejected_vendor = rejected_root.path.join(BLENDER_VENDOR_DIRECTORY);
        for index in 0..=MAX_DIRECTORY_ENTRIES {
            fs::create_dir_all(rejected_vendor.join(format!("entry-{index:03}")))
                .expect("应能创建限额测试目录");
        }

        let rejected = scan_from_roots(vec![
            rejected_root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(rejected.installations.is_empty());
        assert!(rejected.partial);
        assert!(rejected.truncated);
    }

    #[test]
    fn limits_number_of_scanned_roots() {
        let roots: Vec<_> = (0..(MAX_DISCOVERY_ROOTS + 1))
            .map(|index| {
                let root = TestDirectory::new(&format!("root-limit-{index}"));
                root.create_candidate(&format!("Blender 4.{index}"));
                root
            })
            .collect();
        let discovery_roots = roots
            .iter()
            .map(|root| root.discovery_root(BlenderInstallationSource::ProgramFiles))
            .collect();

        let snapshot = scan_from_roots(discovery_roots);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.installations.len(), MAX_DISCOVERY_ROOTS);
        assert!(snapshot
            .installations
            .iter()
            .all(|installation| installation.candidate.display_name != "Blender 4.3"));
    }

    #[test]
    fn treats_directory_version_as_non_verified_hint_only() {
        let root = TestDirectory::new("version-hint");
        root.create_candidate("Blender 4.2");
        root.create_candidate("Blender nightly");

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        let verified_shape = installations
            .iter()
            .find(|installation| installation.candidate.display_name == "Blender 4.2")
            .expect("应发现规范目录名");
        assert_eq!(
            verified_shape.candidate.version_hint.as_deref(),
            Some("4.2")
        );
        assert!(!verified_shape.candidate.version_hint_is_verified);
        assert!(installations.iter().any(|installation| {
            installation.candidate.display_name == "Blender candidate"
                && installation.candidate.version_hint.is_none()
        }));
    }

    #[test]
    fn accepts_blender_products_but_rejects_similarly_named_plugins() {
        assert!(is_blender_product_display_name("Blender"));
        assert!(is_blender_product_display_name("Blender 5.2"));
        assert!(is_blender_product_display_name("blender 4.5 LTS"));
        assert!(!is_blender_product_display_name(
            "Blender Pipeline Plug-in v2.2 for Character Creator 4"
        ));
        assert!(!is_blender_product_display_name("Blender Launcher"));
    }

    #[test]
    fn parses_bounded_steam_vdf_fields_without_accepting_path_escape() {
        let body = r#"
"libraryfolders"
{
    "0"
    {
        "path"      "F:\\Program Files (x86)\\Steam"
        "apps"
        {
            "365670"    "944579836"
        }
    }
}
"appid"        "365670"
"installdir"   "Blender"
"#;
        assert_eq!(
            vdf_values(body, "path"),
            vec![r"F:\Program Files (x86)\Steam"]
        );
        assert_eq!(vdf_values(body, "appid"), vec![STEAM_BLENDER_APP_ID]);
        assert_eq!(vdf_values(body, "installdir"), vec!["Blender"]);
        assert!(is_safe_single_path_component("Blender"));
        assert!(!is_safe_single_path_component("../Blender"));
        assert!(!is_safe_single_path_component(r"..\Blender"));
        assert!(!is_safe_single_path_component(r"C:\Blender"));
    }

    #[cfg(windows)]
    #[test]
    fn discovers_and_deduplicates_direct_registered_candidate() {
        let root = TestDirectory::new("direct-registered");
        let executable = root.create_manual_x64_candidate();
        let direct = DirectDiscoveryHints {
            hints: vec![
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::WindowsUninstall,
                    executable_path: executable.clone(),
                    display_name: "Blender 5.2".to_string(),
                    version_hint: Some("5.2.1".to_string()),
                },
                DirectDiscoveryHint {
                    source: BlenderInstallationSource::Steam,
                    executable_path: executable,
                    display_name: "Blender（Steam）".to_string(),
                    version_hint: None,
                },
            ],
            ..DirectDiscoveryHints::default()
        };

        let snapshot = merge_direct_hints(DiscoverySnapshot::default(), direct);
        assert_eq!(snapshot.installations.len(), 1);
        let candidate = &snapshot.installations[0].candidate;
        assert_eq!(
            candidate.source,
            BlenderInstallationSource::WindowsUninstall
        );
        assert_eq!(candidate.display_name, "Blender 5.2");
        assert_eq!(candidate.version_hint.as_deref(), Some("5.2.1"));
        let serialized = serde_json::to_string(candidate).expect("候选应可序列化");
        assert!(!serialized.contains(&root.path.to_string_lossy().to_string()));
        assert!(!serialized.contains(BLENDER_EXECUTABLE_NAME));
    }

    #[cfg(windows)]
    #[test]
    fn platform_direct_discovery_returns_only_revalidated_opaque_candidates() {
        let snapshot = merge_direct_hints(
            DiscoverySnapshot::default(),
            platform_direct_discovery_hints(),
        );
        for installation in &snapshot.installations {
            assert_eq!(
                validate_installation_record(&InstallationRecord {
                    candidate: installation.candidate.clone(),
                    canonical_root: installation.canonical_root.clone(),
                    canonical_executable: installation.canonical_executable.clone(),
                })
                .expect("平台自动发现的候选必须通过启动前复核"),
                installation.canonical_executable
            );
        }
        let public_candidates: Vec<_> = snapshot
            .installations
            .iter()
            .map(|installation| &installation.candidate)
            .collect();
        println!(
            "platform_blender_candidates={}",
            serde_json::to_string(&public_candidates).expect("公开候选应可序列化")
        );
    }

    #[test]
    fn rejects_symbolic_link_escape_when_supported() {
        let root = TestDirectory::new("link-root");
        let outside = TestDirectory::new("link-outside");
        let outside_directory = outside.path.join("Blender 4.6");
        fs::create_dir_all(&outside_directory).expect("应能创建外部目录");
        fs::write(outside_directory.join(BLENDER_EXECUTABLE_NAME), b"outside")
            .expect("应能创建外部候选");

        let vendor = root.path.join(BLENDER_VENDOR_DIRECTORY);
        fs::create_dir_all(&vendor).expect("应能创建供应商目录");
        let link = vendor.join("Blender 4.6");

        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside_directory, &link);
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_dir(&outside_directory, &link);
        if link_result.is_err() {
            return;
        }

        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        assert!(installations.is_empty());
    }

    #[test]
    fn rejects_canonical_target_outside_allowed_root_without_symlink_privileges() {
        let root = TestDirectory::new("canonical-root");
        let outside = TestDirectory::new("canonical-outside");
        let vendor = root.path.join(BLENDER_VENDOR_DIRECTORY);
        let version_directory = vendor.join("Blender 4.6");
        fs::create_dir_all(&version_directory).expect("应能创建版本目录");
        let outside_candidate = outside.path.join(BLENDER_EXECUTABLE_NAME);
        fs::write(&outside_candidate, b"outside").expect("应能创建外部候选");

        let canonical_root = root.path.canonicalize().expect("根目录应可解析");
        let canonical_vendor = vendor.canonicalize().expect("供应商目录应可解析");
        let canonical_version = version_directory.canonicalize().expect("版本目录应可解析");
        let canonical_outside = outside_candidate.canonicalize().expect("外部候选应可解析");

        assert!(!candidate_location_is_allowed(
            &canonical_outside,
            &canonical_root,
            &canonical_vendor,
            &canonical_version,
        ));
    }

    #[test]
    fn discovery_replaces_process_local_records() {
        let root = TestDirectory::new("state");
        root.create_candidate("Blender 4.5");
        let installations = discover_from_roots(vec![
            root.discovery_root(BlenderInstallationSource::ProgramFiles)
        ]);
        let state = BlenderRuntimeState::default();

        state
            .replace_installations(&installations)
            .expect("应能保存候选");
        assert_eq!(state.installation_count(), 1);
        state.replace_installations(&[]).expect("应能清空旧候选");
        assert_eq!(state.installation_count(), 0);
    }

    #[test]
    fn main_window_label_is_required() {
        assert!(ensure_main_window_label("main").is_ok());
        assert!(ensure_main_window_label("chat-assistant").is_err());
        assert!(ensure_main_window_label("asset-search").is_err());
        assert!(ensure_main_window_label("director-desk").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn manually_selected_windows_path_keeps_stable_canonical_identity() {
        let root = TestDirectory::new("manual-steam-path");
        let selected = root.create_manual_x64_candidate();
        let executable =
            canonicalize_registered_executable(&selected).expect("手选路径应能转换为内部稳定表示");
        let canonical_root = executable.parent().expect("候选应有安装目录").to_path_buf();
        let record = InstallationRecord {
            candidate: BlenderInstallationCandidate {
                installation_id: installation_id(&path_identity(&executable)),
                display_name: "Blender（手动选择）".to_string(),
                source: BlenderInstallationSource::UserSelected,
                version_hint: None,
                version_hint_is_verified: false,
            },
            canonical_root,
            canonical_executable: executable.clone(),
        };

        assert_eq!(
            validate_installation_record(&record).expect("启动前复核应接受同一手选候选"),
            executable
        );
    }

    #[cfg(windows)]
    #[test]
    fn manually_selected_windows_path_persists_and_restores_from_private_directory() {
        let root = TestDirectory::new("manual-persistence");
        let selected = root.create_manual_x64_candidate();
        let record = manual_installation_record(&selected).expect("手选候选应可登记");
        let private_directory = root.path.join("private");
        fs::create_dir_all(&private_directory).expect("应能创建私有设置目录");

        persist_manual_installation(&private_directory, &record.canonical_executable)
            .expect("手选候选应可保存");
        let restored = restore_manual_installation(&private_directory)
            .expect("已保存候选应可读取")
            .expect("已保存候选应存在");

        assert_eq!(restored.candidate, record.candidate);
        assert_eq!(restored.canonical_executable, record.canonical_executable);
        assert_eq!(
            validate_installation_record(&restored).expect("恢复后仍应通过启动前复核"),
            record.canonical_executable
        );
    }

    #[cfg(windows)]
    #[test]
    fn accepts_only_local_drive_root_hints() {
        assert!(root_hint_is_allowed(Path::new(r"C:\Program Files")));
        assert!(!root_hint_is_allowed(Path::new(r"\\server\share")));
        assert!(!root_hint_is_allowed(Path::new(r"\\?\UNC\server\share")));
        assert!(!root_hint_is_allowed(Path::new(r"\\.\C:\Program Files")));
        assert!(!root_hint_is_allowed(Path::new("relative")));
        assert!(canonical_root_is_allowed(Path::new(
            r"\\?\C:\Program Files"
        )));
    }

    #[test]
    fn empty_result_explicitly_reports_non_exhaustive_scope() {
        let result = public_discovery_result(
            DiscoverySnapshot::default(),
            BlenderDiscoveryScope::WindowsKnownInstallLocations,
            None,
        );

        assert!(result.candidates.is_empty());
        assert!(!result.exhaustive);
        assert!(result.supports_saved_scene);
        assert!(!result.partial);
        assert!(!result.truncated);
        let serialized = serde_json::to_string(&result).expect("结果应可序列化");
        assert!(serialized.contains("\"scope\":\"windows-known-install-locations\""));
        assert!(serialized.contains("\"exhaustive\":false"));
        assert!(serialized.contains("\"supportsSavedScene\":true"));
    }
