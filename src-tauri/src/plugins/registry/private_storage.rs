//! 插件私有目录的初始化、写入授权与旧目录迁移。

use crate::path_policy::{is_link_or_reparse, simplify_verbatim};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::{
    unix_now_millis, LEGACY_PRIVATE_DIR_NAME, MAX_PACKAGE_RESOURCES, MAX_PACKAGE_RESOURCE_BYTES,
    MAX_PLUGIN_REGISTRATIONS, MIGRATION_DIR_NAME, PREPARED_MIGRATION_DIR_NAME, PRIVATE_DIR_NAME,
    REGISTRY_BACKUP_FILE_NAME, REGISTRY_FILE_NAME, REVISIONS_DIR_NAME,
    STORAGE_PERMISSION_ERROR, UI_REVISIONS_DIR_NAME,
};

static STORAGE_MIGRATION_LOCK: Mutex<()> = Mutex::new(());
static STORAGE_PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static STORAGE_AUTHORIZATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn installed_plugin_dir() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| "无法定位应用安装目录")?;
    let directory = executable.parent().ok_or("无法定位应用安装目录")?;
    let directory = directory
        .canonicalize()
        .map_err(|_| "无法解析应用安装目录")?;
    Ok(simplify_verbatim(directory).join(PRIVATE_DIR_NAME))
}

fn legacy_plugin_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(LEGACY_PRIVATE_DIR_NAME))
        .map_err(|_| "无法定位插件私有数据目录".to_string())
}

/// 所有运行入口共用新目录；迁移不与安装事务交错，也不回退旧目录执行。
pub(crate) fn plugin_private_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let directory = installed_plugin_dir()?;
    let _guard = STORAGE_MIGRATION_LOCK
        .lock()
        .map_err(|_| "插件目录迁移锁异常")?;
    let legacy = legacy_plugin_dir(app)?;
    if private_directory_exists(&directory)? {
        if prepared_plugin_directory(&directory)? {
            return Err("插件目录初始化尚未完成，请在设置中重新安装或启用以继续；后台未读取或执行插件".into());
        }
    } else {
        migrate_legacy_plugin_directory_at(&legacy, &directory)?;
    }
    Ok(directory)
}

/// 路径保护使用纯定位，不触发迁移或获取注册表锁。
pub(super) fn plugin_private_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(directory) = installed_plugin_dir() {
        roots.push(directory.with_file_name(MIGRATION_DIR_NAME));
        roots.push(directory);
    }
    if let Ok(directory) = legacy_plugin_dir(app) {
        roots.push(directory);
    }
    roots
}

fn private_directory_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() || is_link_or_reparse(&metadata) => {
            Err("插件私有目录必须是普通目录，不能使用符号链接或目录联接".into())
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(storage_io_error("无法访问插件私有目录", &error)),
    }
}

/// 不把本机路径或系统错误正文写入提示，只保留可判定的类别和错误码。
pub(super) fn storage_io_error(action: &str, error: &io::Error) -> String {
    let prefix = if error.kind() == io::ErrorKind::PermissionDenied {
        STORAGE_PERMISSION_ERROR
    } else {
        ""
    };
    let kind = match error.kind() {
        io::ErrorKind::PermissionDenied => "拒绝访问",
        io::ErrorKind::NotFound => "目录或文件不存在",
        io::ErrorKind::AlreadyExists => "目标已存在",
        io::ErrorKind::InvalidInput => "路径或参数无效",
        _ => "文件系统操作失败",
    };
    match error.raw_os_error() {
        Some(code) => format!("{prefix}{action}（{kind}，系统错误码 {code}）"),
        None => format!("{prefix}{action}（{kind}）"),
    }
}

pub(super) fn storage_permission_denied(error: &str) -> bool {
    error.starts_with(STORAGE_PERMISSION_ERROR)
}

pub(super) fn source_storage_error(error: String) -> String {
    // UAC 只修复安装目录，不能以另一管理员身份读取不可访问的旧用户数据。
    error.strip_prefix(STORAGE_PERMISSION_ERROR).unwrap_or(&error).to_string()
}

/// 只由显式安装/更新、重新启用调用；状态读取和后台执行不会申请提升。
pub(super) async fn prepare_plugin_storage_for_mutation(
    app: &AppHandle,
    plugin_id: &str,
    revision_digest: Option<&str>,
) -> Result<(), String> {
    // 并发安装共用一次目录准备；后到操作重新探测，不重复申请已修复的权限。
    let _authorization_guard = STORAGE_AUTHORIZATION_LOCK.lock().await;
    async fn prepare(
        app: &AppHandle,
        plugin_id: &str,
        revision_digest: Option<&str>,
        require_prepared_marker: bool,
    ) -> Result<(), String> {
        let app = app.clone();
        let plugin_id = plugin_id.to_string();
        let revision_digest = revision_digest.map(str::to_string);
        tauri::async_runtime::spawn_blocking(move || {
            let installed = installed_plugin_dir()?;
            {
                let _guard = STORAGE_MIGRATION_LOCK.lock().map_err(|_| "插件目录迁移锁异常".to_string())?;
                let prepared = private_directory_exists(&installed)? && prepared_plugin_directory(&installed)?;
                if require_prepared_marker && !prepared {
                    return Err("插件目录授权未返回完整初始化标记，未继续本次操作；请检查该目录".into());
                }
                if prepared {
                    finish_prepared_plugin_directory_at(&legacy_plugin_dir(&app)?, &installed)?;
                }
            }
            let directory = plugin_private_dir(&app)?;
            ensure_private_directory(&directory)?;
            probe_plugin_storage_writable(&directory, &plugin_id, revision_digest.as_deref())
        })
        .await
        .map_err(|_| "插件目录写入检测未完成".to_string())?
    }

    let error = match prepare(app, plugin_id, revision_digest, false).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if !cfg!(windows) || !storage_permission_denied(&error) {
        return Err(error);
    }
    let require_prepared_marker = match fs::symlink_metadata(installed_plugin_dir()?) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => false,
        Ok(_) => return Err("插件目录必须是普通目录，未申请管理员授权".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        // 原权限不允许确认旧根时不能猜测“初始化已完成”。
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => true,
        Err(error) => return Err(storage_io_error("无法确认插件目录授权目标", &error)),
    };

    // 对话框、UAC 与进程等待均不持有迁移锁或注册表锁。
    let dialog_app = app.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message("应用安装目录中的 Plugin 无法写入。是否请求 Windows 管理员授权？\n\n仅为当前用户准备 Plugin 目录及必要的修改权限；不修改整个应用目录，应用和 Python 插件仍以普通权限运行。\n\n接下来 Windows 可能要求管理员确认或凭据。取消将停止本次操作，保留已有插件。")
            .title("授权创建插件目录")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("申请授权".into(), "取消".into()))
            .blocking_show()
    })
    .await
    .map_err(|_| "无法显示插件目录授权提示".to_string())?;
    if !approved {
        return Err("已取消插件目录授权，未继续本次操作".into());
    }
    tauri::async_runtime::spawn_blocking(crate::plugin_install_permissions::request_directory_access)
        .await
        .map_err(|_| "插件目录授权未完成".to_string())??;
    // 成功以原普通用户的实际写入为准，不信任提升进程的退出本身。
    prepare(app, plugin_id, revision_digest, require_prepared_marker).await.map_err(|error| {
        format!("授权后插件目录仍不可写，未继续本次操作；{error}")
    })
}

pub(super) fn probe_plugin_storage_writable(directory: &Path, plugin_id: &str, revision_digest: Option<&str>) -> Result<(), String> {
    let mut paths = vec![directory.to_path_buf()];
    for name in [REVISIONS_DIR_NAME, UI_REVISIONS_DIR_NAME, "settings", "window-profiles", "media-jobs"] {
        let path = directory.join(name);
        if private_directory_exists(&path)? {
            paths.push(path);
        }
    }
    for path in [
        directory.join(REVISIONS_DIR_NAME).join(plugin_id),
        directory.join(UI_REVISIONS_DIR_NAME).join(plugin_id),
    ] {
        if private_directory_exists(&path)? { paths.push(path); }
    }
    if let Some(digest) = revision_digest {
        let revision = directory.join(REVISIONS_DIR_NAME).join(plugin_id).join(digest);
        for path in [revision.clone(), revision.join("resources")] {
            if private_directory_exists(&path)? { paths.push(path); }
        }
    }
    for path in paths {
        let probe = path.join(format!(".write-probe-{}-{}", std::process::id(), STORAGE_PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&probe).map_err(|error| storage_io_error("无法创建插件目录写入探针", &error))?;
        let file_path = probe.join("write");
        let result = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&file_path)?;
            file.write_all(b"AI Canvas plugin storage probe\n")?;
            file.sync_all()
        })();
        let cleanup_file = fs::remove_file(&file_path);
        let cleanup_directory = fs::remove_dir(&probe);
        result.map_err(|error| storage_io_error("无法写入插件目录", &error))?;
        cleanup_file.map_err(|error| storage_io_error("无法删除插件目录写入探针", &error))?;
        cleanup_directory.map_err(|error| storage_io_error("无法删除插件目录写入探针", &error))?;
    }
    #[cfg(windows)]
    for name in [REGISTRY_FILE_NAME, REGISTRY_BACKUP_FILE_NAME, super::REGISTRY_TEMP_FILE_NAME] {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{DELETE, FILE_FLAG_OPEN_REPARSE_POINT};
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_file() || is_link_or_reparse(&metadata) => {
                return Err("插件注册表必须是普通文件，不能使用链接".into());
            }
            Ok(_) => {
                // 只申请打开权限，不改动注册表内容；原子替换需要现有文件允许 DELETE。
                fs::OpenOptions::new().access_mode(DELETE.0).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
                    .open(path).map_err(|error| storage_io_error("无法替换插件注册表文件", &error))?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(storage_io_error("无法检查插件注册表文件", &error)),
        }
    }
    Ok(())
}

fn persistent_plugin_entries() -> [&'static str; 5] {
    [REGISTRY_FILE_NAME, REGISTRY_BACKUP_FILE_NAME, REVISIONS_DIR_NAME, UI_REVISIONS_DIR_NAME, "settings"]
}

pub(super) fn migration_entry_limit() -> usize {
    MAX_PLUGIN_REGISTRATIONS * (3 * (MAX_PACKAGE_RESOURCES + 5) + 4)
}

pub(super) fn prepared_plugin_directory(directory: &Path) -> Result<bool, String> {
    use crate::plugin_install_permissions::{PREPARED_MARKER, PREPARED_MARKER_CONTENT};
    let marker = directory.join(PREPARED_MARKER);
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(storage_io_error("无法读取插件目录初始化状态", &error)),
    };
    if !metadata.is_file() || is_link_or_reparse(&metadata)
        || metadata.len() != PREPARED_MARKER_CONTENT.len() as u64
    {
        return Err("插件目录初始化标记异常，未读取插件数据".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(marker)
        .and_then(|file| file.take(PREPARED_MARKER_CONTENT.len() as u64 + 1).read_to_end(&mut bytes))
        .map_err(|error| storage_io_error("无法读取插件目录初始化状态", &error))?;
    if bytes.as_slice() != PREPARED_MARKER_CONTENT {
        return Err("插件目录初始化标记异常，未读取插件数据".into());
    }
    Ok(true)
}

/// UAC 只发布带标记的空根；复制与提交始终在原普通用户权限下进行。
/// 最后删除标记才开放读取。崩溃后只接受已发布且逐字节相同的条目，不覆盖或合并。
pub(super) fn finish_prepared_plugin_directory_at(legacy: &Path, directory: &Path) -> Result<(), String> {
    use crate::plugin_install_permissions::PREPARED_MARKER;
    if !private_directory_exists(directory)? {
        return Err("插件初始化目录不存在，未读取迁移数据".into());
    }
    if !prepared_plugin_directory(directory)? {
        return Ok(());
    }
    let entries = persistent_plugin_entries();
    if !private_directory_exists(legacy).map_err(source_storage_error)? {
        for name in entries {
            match fs::symlink_metadata(directory.join(name)) {
                Ok(_) => return Err("插件目录初始化尚未完成，原迁移来源不可用；已保留现有数据".into()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                Err(error) => return Err(storage_io_error("无法检查插件初始化数据", &error)),
            }
        }
        return fs::remove_file(directory.join(PREPARED_MARKER))
            .map_err(|error| storage_io_error("无法完成插件目录初始化", &error));
    }

    let staging_root = directory.join(PREPARED_MIGRATION_DIR_NAME);
    ensure_private_directory(&staging_root)?;
    let staging = staging_root.join(format!("stage-{}-{}", std::process::id(), unix_now_millis()));
    fs::create_dir(&staging)
        .map_err(|error| storage_io_error("无法创建插件迁移暂存目录", &error))?;
    let result = (|| {
        let mut remaining_entries = migration_entry_limit();
        for name in entries {
            let source = legacy.join(name);
            match fs::symlink_metadata(&source) {
                Ok(_) => copy_legacy_plugin_entry(&source, &staging.join(name), 0, &mut remaining_entries)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    match fs::symlink_metadata(directory.join(name)) {
                        Ok(_) => return Err("插件迁移来源与已暂存内容不一致；未覆盖现有数据".into()),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                        Err(error) => return Err(storage_io_error("无法检查插件迁移目标", &error)),
                    }
                }
                Err(error) => return Err(source_storage_error(storage_io_error("无法读取旧插件迁移数据", &error))),
            }
        }
        // 源码、UI 和偏好先到位，注册表最后发布；标记在整个提交期间保持存在。
        for name in [REVISIONS_DIR_NAME, UI_REVISIONS_DIR_NAME, "settings", REGISTRY_BACKUP_FILE_NAME, REGISTRY_FILE_NAME] {
            let staged = staging.join(name);
            match fs::symlink_metadata(&staged) {
                Ok(_) => {},
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(storage_io_error("无法检查插件暂存数据", &error)),
            }
            let target = directory.join(name);
            match fs::symlink_metadata(&target) {
                Ok(_) => {
                    let mut remaining = migration_entry_limit();
                    if !migration_entries_equal(&staged, &target, 0, &mut remaining)? {
                        return Err("插件目录初始化存在内容冲突，未覆盖或合并已有数据".into());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    publish_prepared_entry(&staged, &target)?;
                }
                Err(error) => return Err(storage_io_error("无法检查插件迁移目标", &error)),
            }
        }
        fs::remove_file(directory.join(PREPARED_MARKER))
            .map_err(|error| storage_io_error("无法提交插件目录初始化", &error))
    })();
    // 提升进程从不进入这里；只回收本次普通用户创建的暂存，不删除旧来源或已发布条目。
    if fs::symlink_metadata(&staging).is_ok_and(|metadata| metadata.is_dir() && !is_link_or_reparse(&metadata)) {
        let _ = fs::remove_dir_all(&staging);
    }
    let _ = fs::remove_dir(&staging_root);
    result
}

pub(super) fn publish_prepared_entry(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS}};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // 不使用 REPLACE_EXISTING；并发创建的目标也不能被覆盖。
        unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(target.as_ptr()), MOVE_FILE_FLAGS(0)) }
            .map_err(|error| storage_io_error("无法发布插件迁移条目", &io::Error::from_raw_os_error(error.code().0 & 0xffff)))
    }
    #[cfg(not(windows))]
    {
        // 授权辅助模式仅在 Windows 使用；保留可移植的定向回归入口。
        if fs::symlink_metadata(target).is_ok() {
            return Err("插件迁移目标已存在，未覆盖已有数据".into());
        }
        fs::rename(source, target).map_err(|error| storage_io_error("无法发布插件迁移条目", &error))
    }
}

fn migration_entries_equal(left: &Path, right: &Path, depth: usize, remaining: &mut usize) -> Result<bool, String> {
    if depth > 4 || *remaining == 0 {
        return Err("插件迁移比对超过目录深度或文件数量限制".into());
    }
    *remaining -= 1;
    let a = fs::symlink_metadata(left).map_err(|error| storage_io_error("无法读取插件迁移条目", &error))?;
    let b = fs::symlink_metadata(right).map_err(|error| storage_io_error("无法读取插件迁移目标", &error))?;
    if is_link_or_reparse(&a) || is_link_or_reparse(&b) {
        return Err("插件迁移数据不能包含符号链接或目录联接".into());
    }
    if a.is_dir() && b.is_dir() {
        fn names(path: &Path, limit: usize) -> Result<BTreeSet<std::ffi::OsString>, String> {
            let mut names = BTreeSet::new();
            for entry in fs::read_dir(path).map_err(|error| storage_io_error("无法读取插件迁移目录", &error))? {
                if names.len() >= limit {
                    return Err("插件迁移比对超过文件数量限制".into());
                }
                names.insert(entry.map_err(|error| storage_io_error("无法读取插件迁移目录项", &error))?.file_name());
            }
            Ok(names)
        }
        let left_names = names(left, *remaining)?;
        if left_names != names(right, *remaining)? {
            return Ok(false);
        }
        for name in left_names {
            if !migration_entries_equal(&left.join(&name), &right.join(&name), depth + 1, remaining)? {
                return Ok(false);
            }
        }
        Ok(true)
    } else if a.is_file() && b.is_file() && a.len() == b.len() && a.len() <= MAX_PACKAGE_RESOURCE_BYTES as u64 {
        fn digest(path: &Path) -> Result<Vec<u8>, String> {
            let mut file = fs::File::open(path).map_err(|error| storage_io_error("无法读取插件迁移文件", &error))?;
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 8192];
            let mut total = 0;
            loop {
                let count = file.read(&mut buffer).map_err(|error| storage_io_error("无法读取插件迁移文件", &error))?;
                if count == 0 { break; }
                total += count;
                if total > MAX_PACKAGE_RESOURCE_BYTES {
                    return Err("插件迁移文件在比对期间超出大小限制".into());
                }
                hash.update(&buffer[..count]);
            }
            Ok(hash.finalize().to_vec())
        }
        Ok(digest(left)? == digest(right)?)
    } else {
        Ok(false)
    }
}

pub(super) fn copy_legacy_plugin_entry(
    source: &Path,
    target: &Path,
    depth: usize,
    remaining_entries: &mut usize,
) -> Result<(), String> {
    if depth > 4 || *remaining_entries == 0 {
        return Err("旧插件数据的目录深度或文件数量超过迁移限制".into());
    }
    *remaining_entries -= 1;
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| source_storage_error(storage_io_error("无法读取旧插件迁移数据", &error)))?;
    if is_link_or_reparse(&metadata) {
        return Err("旧插件迁移数据不能包含符号链接或目录联接".into());
    }
    if metadata.is_dir() {
        fs::create_dir(target).map_err(|error| storage_io_error("无法创建插件迁移子目录", &error))?;
        for entry in fs::read_dir(source).map_err(|error| source_storage_error(storage_io_error("无法读取旧插件迁移目录", &error)))? {
            let entry = entry.map_err(|error| source_storage_error(storage_io_error("无法读取旧插件迁移目录项", &error)))?;
            copy_legacy_plugin_entry(
                &entry.path(),
                &target.join(entry.file_name()),
                depth + 1,
                remaining_entries,
            )?;
        }
    } else if metadata.is_file() && metadata.len() <= MAX_PACKAGE_RESOURCE_BYTES as u64 {
        // 分开源读取与目标写入错误，不能为读取另一个用户的数据申请提升。
        let mut input = fs::File::open(source)
            .map_err(|error| source_storage_error(storage_io_error("无法读取旧插件迁移文件", &error)))?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target)
            .map_err(|error| storage_io_error("无法创建插件迁移文件", &error))?;
        let mut buffer = [0u8; 8192];
        let mut bytes = 0u64;
        loop {
            let count = input.read(&mut buffer)
                .map_err(|error| source_storage_error(storage_io_error("无法读取旧插件迁移文件", &error)))?;
            if count == 0 { break; }
            bytes += count as u64;
            if bytes > metadata.len() || bytes > MAX_PACKAGE_RESOURCE_BYTES as u64 {
                return Err("旧插件数据在迁移期间发生变化，请重试".into());
            }
            output.write_all(&buffer[..count])
                .map_err(|error| storage_io_error("无法写入插件迁移文件", &error))?;
        }
        output.sync_all().map_err(|error| storage_io_error("无法保存插件迁移文件", &error))?;
        if bytes != metadata.len() {
            return Err("旧插件数据在迁移期间发生变化，请重试".into());
        }
    } else {
        return Err("旧插件迁移数据不是普通文件或超过大小限制".into());
    }
    Ok(())
}

pub(super) fn migrate_legacy_plugin_directory_at(legacy: &Path, target: &Path) -> Result<bool, String> {
    if private_directory_exists(target)? || !private_directory_exists(legacy).map_err(source_storage_error)? {
        return Ok(false);
    }
    // 与最终目录同卷暂存，再原子发布；旧目录保留为备份，兼容跨盘安装。
    let staging_root = target.with_file_name(MIGRATION_DIR_NAME);
    ensure_private_directory(&staging_root)?;
    let staging = staging_root.join(format!(
        "stage-{}-{}",
        std::process::id(),
        unix_now_millis(),
    ));
    fs::create_dir(&staging).map_err(|error| storage_io_error("无法创建插件迁移目录", &error))?;
    let result = (|| {
        let mut remaining_entries = migration_entry_limit();
        for name in persistent_plugin_entries() {
            let source = legacy.join(name);
            match fs::symlink_metadata(&source) {
                Ok(_) => copy_legacy_plugin_entry(
                    &source,
                    &staging.join(name),
                    0,
                    &mut remaining_entries,
                )?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(source_storage_error(storage_io_error("旧插件数据不可访问，迁移未完成", &error))),
            }
        }
        if private_directory_exists(target)? {
            return Err("Plugin 目录在迁移期间已创建，未覆盖已有数据".into());
        }
        fs::rename(&staging, target).map_err(|error| storage_io_error("无法提交插件目录迁移", &error))?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    let _ = fs::remove_dir(&staging_root);
    result
}

pub(super) fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| storage_io_error("无法创建插件私有数据目录", &error))?;
    if !private_directory_exists(path)? {
        return Err("插件私有数据目录不存在".into());
    }
    Ok(())
}
