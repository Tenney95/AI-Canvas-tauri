//! macOS 应用包与 Mach-O 校验；不执行扫描候选，不递归扫描磁盘。
use super::*;

const BUNDLE_EXECUTABLE: &str = "Contents/MacOS/Blender";
const MAX_MACHO_SLICES: u32 = 32;
const MAX_APPLICATION_ENTRIES: usize = 256;

pub(super) fn resolve_executable(path: &Path, architecture: &str) -> Result<PathBuf, String> {
    let is_bundle = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    let bundle = if is_bundle {
        path
    } else {
        path.ancestors()
            .nth(3)
            .filter(|root| {
                root.extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
                    && root.join(BUNDLE_EXECUTABLE) == path
            })
            .ok_or_else(|| "请选择 Blender.app 应用包".to_string())?
    };
    let bundle = bundle
        .canonicalize()
        .map_err(|_| "Blender 应用包不可用".to_string())?;
    for directory in [
        bundle.clone(),
        bundle.join("Contents"),
        bundle.join("Contents/MacOS"),
    ] {
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| "Blender 应用包结构无效".to_string())?;
        if !is_plain_directory(&metadata) {
            return Err("Blender 应用包结构无效".to_string());
        }
    }
    let executable = bundle.join(BUNDLE_EXECUTABLE);
    let metadata =
        fs::symlink_metadata(&executable).map_err(|_| "应用包中没有 Blender 程序".to_string())?;
    if !is_plain_file(&metadata) || executable.canonicalize().ok().as_ref() != Some(&executable) {
        return Err("Blender 应用程序路径无效".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("Blender 应用程序没有执行权限，请重新安装官方应用".to_string());
        }
    }
    let mut file = fs::File::open(&executable).map_err(|_| "Blender 应用程序不可读".to_string())?;
    validate_macho(&mut file, metadata.len(), architecture)?;
    Ok(executable)
}

fn validate_macho<R: Read + Seek>(
    file: &mut R,
    size: u64,
    architecture: &str,
) -> Result<(), String> {
    let invalid = || "Blender 应用程序不是有效的 macOS 64 位可执行文件".to_string();
    let wrong_arch = || {
        "Blender 架构不匹配，请选择与本应用相同架构的 macOS Blender（Apple Silicon 或 Intel）"
            .to_string()
    };
    let cpu = match architecture {
        "aarch64" => 0x0100_000c,
        "x86_64" => 0x0100_0007,
        _ => return Err(wrong_arch()),
    };
    let mut prefix = [0; 8];
    file.read_exact(&mut prefix).map_err(|_| invalid())?;
    if matches!(
        &prefix[..4],
        [0xcf, 0xfa, 0xed, 0xfe] | [0xfe, 0xed, 0xfa, 0xcf]
    ) {
        file.seek(SeekFrom::Start(0)).map_err(|_| invalid())?;
        return validate_macho_slice(file, cpu);
    }
    // Universal binaries have a big-endian architecture table, regardless of slice byte order.
    let wide = match &prefix[..4] {
        [0xca, 0xfe, 0xba, 0xbe] => false,
        [0xca, 0xfe, 0xba, 0xbf] => true,
        _ => return Err(invalid()),
    };
    let count = u32::from_be_bytes(prefix[4..8].try_into().unwrap());
    if count == 0 || count > MAX_MACHO_SLICES {
        return Err(invalid());
    }
    let entry_size = if wide { 32 } else { 20 };
    let table_end = 8 + u64::from(count) * entry_size;
    for index in 0..count {
        file.seek(SeekFrom::Start(8 + u64::from(index) * entry_size))
            .map_err(|_| invalid())?;
        let mut entry = [0u8; 32];
        file.read_exact(&mut entry[..entry_size as usize])
            .map_err(|_| invalid())?;
        let entry_cpu = u32::from_be_bytes(entry[..4].try_into().unwrap());
        let (offset, length) = if wide {
            (
                u64::from_be_bytes(entry[8..16].try_into().unwrap()),
                u64::from_be_bytes(entry[16..24].try_into().unwrap()),
            )
        } else {
            (
                u64::from(u32::from_be_bytes(entry[8..12].try_into().unwrap())),
                u64::from(u32::from_be_bytes(entry[12..16].try_into().unwrap())),
            )
        };
        if offset < table_end
            || length < 32
            || offset.checked_add(length).is_none_or(|end| end > size)
        {
            return Err(invalid());
        }
        if entry_cpu == cpu {
            file.seek(SeekFrom::Start(offset)).map_err(|_| invalid())?;
            return validate_macho_slice(file, cpu);
        }
    }
    Err(wrong_arch())
}

fn validate_macho_slice<R: Read>(file: &mut R, cpu: u32) -> Result<(), String> {
    let mut header = [0u8; 32];
    file.read_exact(&mut header)
        .map_err(|_| "Blender Mach-O 文件头不完整".to_string())?;
    let decode = match &header[..4] {
        [0xcf, 0xfa, 0xed, 0xfe] => u32::from_le_bytes,
        [0xfe, 0xed, 0xfa, 0xcf] => u32::from_be_bytes,
        _ => return Err("Blender Mach-O 文件头无效".to_string()),
    };
    if decode(header[4..8].try_into().unwrap()) != cpu {
        return Err(
            "Blender 架构不匹配，请选择与本应用相同架构的 macOS Blender（Apple Silicon 或 Intel）"
                .to_string(),
        );
    }
    if decode(header[12..16].try_into().unwrap()) != 2 {
        return Err("Blender Mach-O 不是可执行程序".to_string());
    }
    Ok(())
}

fn collect_application_hints(
    roots: Vec<(BlenderInstallationSource, PathBuf)>,
) -> DirectDiscoveryHints {
    let mut result = DirectDiscoveryHints::default();
    for (source, root) in roots.into_iter().take(MAX_DISCOVERY_ROOTS) {
        // 标准安装优先，即使应用目录超过扫描上限也仍可发现。
        push_bundle_hint(&mut result, source, root.join("Blender.app"));
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                result.partial = true;
                continue;
            }
        };
        for (index, entry) in entries.enumerate() {
            if index >= MAX_APPLICATION_ENTRIES {
                result.truncated = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    result.partial = true;
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.starts_with("blender") {
                continue;
            }
            if name.ends_with(".app") {
                push_bundle_hint(&mut result, source, entry.path());
            } else if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                // 兼容 /Applications/Blender 4.5/Blender.app，不扫描更深层级。
                push_bundle_hint(&mut result, source, entry.path().join("Blender.app"));
            }
        }
    }
    result
}

fn push_bundle_hint(
    result: &mut DirectDiscoveryHints,
    source: BlenderInstallationSource,
    bundle: PathBuf,
) {
    if result.hints.len() >= MAX_DIRECT_DISCOVERY_HINTS {
        result.truncated = true;
        return;
    }
    if !bundle.is_dir() {
        return;
    }
    let name = bundle
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("Blender");
    let name = if name.eq_ignore_ascii_case("blender") {
        bundle
            .parent()
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .filter(|name| name.to_lowercase().starts_with("blender"))
            .unwrap_or(name)
    } else {
        name
    };
    result.hints.push(DirectDiscoveryHint {
        source,
        executable_path: bundle.join(BUNDLE_EXECUTABLE),
        display_name: name.to_string(),
        version_hint: version_hint(name),
    });
}

#[cfg(target_os = "macos")]
pub(super) fn collect_direct_hints() -> DirectDiscoveryHints {
    let mut roots = vec![(
        BlenderInstallationSource::MacApplications,
        PathBuf::from("/Applications"),
    )];
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    if let Some(home) = &home {
        roots.push((
            BlenderInstallationSource::MacUserApplications,
            home.join("Applications"),
        ));
    }
    let mut result = collect_application_hints(roots);
    if let Some(home) = home {
        push_bundle_hint(
            &mut result,
            BlenderInstallationSource::Steam,
            home.join("Library/Application Support/Steam/steamapps/common/Blender/Blender.app"),
        );
    }
    // Finder 启动通常不继承用户 shell PATH，Applications 发现不依赖 PATH。
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path).take(MAX_PATH_ENTRIES) {
            if !directory.is_absolute() {
                continue;
            }
            for name in ["blender", "Blender"] {
                if let Ok(executable) = directory.join(name).canonicalize() {
                    if result.hints.len() >= MAX_DIRECT_DISCOVERY_HINTS {
                        result.truncated = true;
                        break;
                    }
                    result.hints.push(DirectDiscoveryHint {
                        source: BlenderInstallationSource::EnvironmentPath,
                        executable_path: executable,
                        display_name: "Blender (PATH)".to_string(),
                        version_hint: None,
                    });
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn macho(cpu: u32) -> Vec<u8> {
        let mut bytes = vec![0; 32];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&cpu.to_le_bytes());
        bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
        bytes
    }

    #[test]
    fn accepts_native_executables_and_rejects_wrong_architecture_dylibs_and_pe() {
        for (arch, cpu) in [("aarch64", 0x0100000c), ("x86_64", 0x01000007)] {
            let bytes = macho(cpu);
            assert!(validate_macho(&mut Cursor::new(&bytes), 32, arch).is_ok());
            let mut library = bytes.clone();
            library[12] = 6;
            assert!(validate_macho(&mut Cursor::new(library), 32, arch).is_err());
        }
        assert!(validate_macho(&mut Cursor::new(macho(0x01000007)), 32, "aarch64").is_err());
        assert!(validate_macho(&mut Cursor::new(b"MZ-not-a-mac-app"), 16, "x86_64").is_err());
    }

    #[test]
    fn universal_binary_validates_slice_and_rejects_offsets_outside_file() {
        for wide in [false, true] {
            let entry_size = if wide { 32 } else { 20 };
            let offset = 8 + entry_size;
            let mut bytes = vec![0; offset];
            bytes[..4].copy_from_slice(if wide {
                &[0xca, 0xfe, 0xba, 0xbf]
            } else {
                &[0xca, 0xfe, 0xba, 0xbe]
            });
            bytes[4..8].copy_from_slice(&1u32.to_be_bytes());
            bytes[8..12].copy_from_slice(&0x0100000cu32.to_be_bytes());
            if wide {
                bytes[16..24].copy_from_slice(&(offset as u64).to_be_bytes());
                bytes[24..32].copy_from_slice(&32u64.to_be_bytes());
            } else {
                bytes[16..20].copy_from_slice(&(offset as u32).to_be_bytes());
                bytes[20..24].copy_from_slice(&32u32.to_be_bytes());
            }
            bytes.extend(macho(0x0100000c));
            assert!(
                validate_macho(&mut Cursor::new(&bytes), bytes.len() as u64, "aarch64").is_ok()
            );
            bytes[16] = 0xff;
            assert!(
                validate_macho(&mut Cursor::new(&bytes), bytes.len() as u64, "aarch64").is_err()
            );
        }
    }

    #[test]
    fn application_discovery_and_bundle_resolution_support_renamed_apps() {
        let temp = super::super::tests::TestDirectory::new("macos-bundle");
        let applications = temp.path.join("Applications");
        let bundle = applications.join("Blender 4.5.app");
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        let executable = bundle.join(BUNDLE_EXECUTABLE);
        fs::write(&executable, macho(0x01000007)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let hints = collect_application_hints(vec![(
            BlenderInstallationSource::MacApplications,
            applications,
        )]);
        assert_eq!(hints.hints.len(), 1);
        assert_eq!(hints.hints[0].display_name, "Blender 4.5");
        assert_eq!(
            resolve_executable(&bundle, "x86_64").unwrap(),
            executable.canonicalize().unwrap()
        );
        assert!(resolve_executable(&bundle, "aarch64").is_err());
        assert_eq!(
            resolve_executable(&executable, "x86_64").unwrap(),
            executable.canonicalize().unwrap()
        );
        assert!(resolve_executable(&temp.path, "x86_64").is_err());
        fs::write(&executable, b"not an executable").unwrap();
        assert!(resolve_executable(&bundle, "x86_64").is_err());
    }

    #[test]
    fn standard_bundle_survives_scan_limit_and_user_applications_are_scanned() {
        let temp = super::super::tests::TestDirectory::new("macos-discovery-limit");
        let system = temp.path.join("Applications");
        let user = temp.path.join("UserApplications");
        fs::create_dir_all(system.join("Blender.app")).unwrap();
        fs::create_dir_all(user.join("Blender 4.5/Blender.app")).unwrap();
        for index in 0..MAX_APPLICATION_ENTRIES {
            fs::create_dir_all(system.join(format!("OtherApp{index}.app"))).unwrap();
        }
        let result = collect_application_hints(vec![
            (BlenderInstallationSource::MacApplications, system.clone()),
            (BlenderInstallationSource::MacUserApplications, user.clone()),
        ]);
        assert!(result.truncated);
        assert!(
            result
                .hints
                .iter()
                .any(|hint| hint.executable_path
                    == system.join("Blender.app").join(BUNDLE_EXECUTABLE))
        );
        assert!(result.hints.iter().any(|hint| hint.source
            == BlenderInstallationSource::MacUserApplications
            && hint.executable_path
                == user.join("Blender 4.5/Blender.app").join(BUNDLE_EXECUTABLE)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_registration_persistence_and_discovery_share_the_bundle_identity() {
        use std::os::unix::fs::PermissionsExt;
        let temp = super::super::tests::TestDirectory::new("macos-registration");
        let bundle = temp.path.join("Blender.app");
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        let cpu = if std::env::consts::ARCH == "aarch64" {
            0x0100000c
        } else {
            0x01000007
        };
        let executable = bundle.join(BUNDLE_EXECUTABLE);
        fs::write(&executable, macho(cpu)).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let record = manual_installation_record(&bundle).unwrap();
        persist_manual_installation(&temp.path, &record.canonical_executable).unwrap();
        let restored = restore_manual_installation(&temp.path).unwrap().unwrap();
        assert_eq!(
            record.candidate.installation_id,
            restored.candidate.installation_id
        );
        assert_eq!(
            validate_installation_record(&restored).unwrap(),
            executable.canonicalize().unwrap()
        );
        let snapshot = merge_direct_hints(
            DiscoverySnapshot::default(),
            collect_application_hints(vec![(
                BlenderInstallationSource::MacApplications,
                temp.path.clone(),
            )]),
        );
        assert_eq!(snapshot.installations.len(), 1);
        assert_eq!(
            snapshot.installations[0].candidate.installation_id,
            record.candidate.installation_id
        );
        fs::remove_file(&executable).unwrap();
        std::os::unix::fs::symlink("/bin/sh", &executable).unwrap();
        assert!(validate_installation_record(&record).is_err());
    }
}
