//! 私有注册表的写盘和备份回滚。读表与内容校验由各注册表负责。

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};

type PlainFileCheck = fn(&Path) -> Result<(), String>;

pub(crate) enum RegistryWriteMode {
    FixedTemporary,
    ExclusiveSynced(PlainFileCheck),
}

pub(crate) struct RegistryWriteErrors {
    pub write: &'static str,
    pub prepare: &'static str,
    pub commit: &'static str,
}

/// 共用注册表的暂存、备份和发布失败回滚。调用方负责加锁、路径和内容校验。
/// Agent 和插件使用固定暂存文件。Skill 独占创建暂存文件、同步写盘并校验文件类型。
pub(crate) fn write_registry_file(
    primary: &Path,
    temporary: &Path,
    backup: &Path,
    bytes: &[u8],
    mode: RegistryWriteMode,
    errors: RegistryWriteErrors,
) -> Result<(), String> {
    let (write, check_plain_file) = match mode {
        RegistryWriteMode::FixedTemporary => (fs::write(temporary, bytes), None),
        RegistryWriteMode::ExclusiveSynced(check) => {
            let write = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(temporary)
                .and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()));
            (write, Some(check))
        }
    };
    let result = write.map_err(|_| errors.write.to_string()).and_then(|()| {
        publish_registry_file(primary, temporary, backup, check_plain_file, &errors)
    });
    if let Some(check) = check_plain_file {
        if result.is_err() && check(temporary).is_ok() {
            let _ = fs::remove_file(temporary);
        }
    }
    result
}

fn registry_path_exists(path: &Path, message: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(message.to_string()),
    }
}

fn publish_registry_file(
    primary: &Path,
    temporary: &Path,
    backup: &Path,
    check_plain_file: Option<PlainFileCheck>,
    errors: &RegistryWriteErrors,
) -> Result<(), String> {
    let existing_primary = match check_plain_file {
        Some(check) if registry_path_exists(primary, errors.prepare)? => {
            check(primary)?;
            true
        }
        Some(_) => false,
        None => primary.exists(),
    };
    if existing_primary {
        if let Some(check) = check_plain_file {
            if registry_path_exists(backup, errors.prepare)? {
                check(backup)?;
                fs::remove_file(backup).map_err(|_| errors.prepare.to_string())?;
            }
        } else {
            let _ = fs::remove_file(backup);
        }
        fs::rename(primary, backup).map_err(|_| errors.prepare.to_string())?;
    }

    if fs::rename(temporary, primary).is_err() {
        // Skill 在主表初始缺失时也可使用上次留下的合规备份。
        if check_plain_file.map_or(existing_primary, |check| {
            !primary.exists() && check(backup).is_ok()
        }) {
            let _ = fs::rename(backup, primary);
        }
        if check_plain_file.is_none() && existing_primary {
            let _ = fs::remove_file(temporary);
        }
        return Err(errors.commit.to_string());
    }
    if check_plain_file.map_or(existing_primary, |check| check(backup).is_ok()) {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ERRORS: RegistryWriteErrors = RegistryWriteErrors {
        write: "write failed",
        prepare: "prepare failed",
        commit: "commit failed",
    };

    struct RegistryPaths {
        directory: PathBuf,
        primary: PathBuf,
        temporary: PathBuf,
        backup: PathBuf,
    }

    impl RegistryPaths {
        fn new() -> Self {
            let nonce = u64::from_le_bytes(crate::secure_random::random_bytes().unwrap());
            let directory = std::env::temp_dir().join(format!("ai-canvas-registry-write-{nonce}"));
            fs::create_dir(&directory).unwrap();
            Self {
                primary: directory.join("registry.json"),
                temporary: directory.join("stage.tmp"),
                backup: directory.join("registry.json.bak"),
                directory,
            }
        }

        fn write(&self, mode: RegistryWriteMode) -> Result<(), String> {
            write_registry_file(
                &self.primary,
                &self.temporary,
                &self.backup,
                b"new",
                mode,
                ERRORS,
            )
        }

        fn publish_without_staged_file(&self, check: Option<PlainFileCheck>) -> Result<(), String> {
            publish_registry_file(&self.primary, &self.temporary, &self.backup, check, &ERRORS)
        }
    }

    impl Drop for RegistryPaths {
        fn drop(&mut self) {
            for path in [&self.primary, &self.temporary, &self.backup] {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_dir(&self.backup);
            let _ = fs::remove_dir(&self.directory);
        }
    }

    fn check_plain_file(path: &Path) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path).map_err(|_| "unsafe file".to_string())?;
        if !metadata.is_file() || crate::path_policy::is_link_or_reparse(&metadata) {
            return Err("unsafe file".into());
        }
        Ok(())
    }

    #[test]
    fn first_commit_preserves_only_the_fixed_mode_orphan_backup() {
        for (mode, keeps_backup) in [
            (RegistryWriteMode::FixedTemporary, true),
            (RegistryWriteMode::ExclusiveSynced(check_plain_file), false),
        ] {
            let paths = RegistryPaths::new();
            fs::write(&paths.backup, b"old").unwrap();

            paths.write(mode).unwrap();

            assert_eq!(fs::read(&paths.primary).unwrap(), b"new");
            assert!(!paths.temporary.exists());
            assert_eq!(paths.backup.exists(), keeps_backup);
        }
    }

    #[test]
    fn failed_replacement_restores_original_primary_in_both_modes() {
        for check in [None, Some(check_plain_file as PlainFileCheck)] {
            let paths = RegistryPaths::new();
            fs::write(&paths.primary, b"original").unwrap();
            fs::write(&paths.backup, b"earlier").unwrap();

            assert_eq!(paths.publish_without_staged_file(check), Err(ERRORS.commit.into()));

            assert_eq!(fs::read(&paths.primary).unwrap(), b"original");
            assert!(!paths.backup.exists());
        }
    }

    #[test]
    fn failed_first_commit_restores_orphan_backup_only_in_exclusive_mode() {
        for check in [None, Some(check_plain_file as PlainFileCheck)] {
            let paths = RegistryPaths::new();
            fs::write(&paths.backup, b"original").unwrap();

            assert_eq!(paths.publish_without_staged_file(check), Err(ERRORS.commit.into()));

            let retained = if check.is_some() { &paths.primary } else { &paths.backup };
            assert_eq!(fs::read(retained).unwrap(), b"original");
            assert_eq!(paths.primary.exists(), check.is_some());
            assert_eq!(paths.backup.exists(), check.is_none());
        }
    }

    #[test]
    fn exclusive_mode_validates_backup_and_cleans_up_staged_file_on_error() {
        let paths = RegistryPaths::new();
        fs::write(&paths.primary, b"original").unwrap();
        fs::create_dir(&paths.backup).unwrap();

        assert_eq!(
            paths.write(RegistryWriteMode::ExclusiveSynced(check_plain_file)),
            Err("unsafe file".into()),
        );

        assert_eq!(fs::read(&paths.primary).unwrap(), b"original");
        assert!(paths.backup.is_dir());
        assert!(!paths.temporary.exists());
    }
}
