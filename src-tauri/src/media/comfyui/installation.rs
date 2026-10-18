//! ComfyUI 安装用途的原生持久授权，不修改通用 fs / asset 允许范围。
//!
//! Renderer 配置路径只作为候选或当前授权的匹配值。权威记录位于原生私有目录，
//! 只允许主窗口通过系统目录选择器更换，旧配置首次迁移需要已有 scope 或原生确认。

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;

const PRIVATE_DIRECTORY: &str = "comfyui-native-private";
const SELECTION_FILE: &str = "installation.json";
const TEMP_FILE: &str = "installation.json.tmp";
const BACKUP_FILE: &str = "installation.json.backup";
const MAX_RECORD_BYTES: u64 = 128 * 1024;
static RECORD_LOCK: Mutex<()> = Mutex::new(());

const CORRUPT_RECORD: &str = "ComfyUI 安装授权记录已损坏，请重新选择安装目录";
const UNSAFE_RECORD: &str = "ComfyUI 安装授权存储不安全，已拒绝访问";
const UNAVAILABLE_RECORD: &str = "无法访问 ComfyUI 安装授权记录";
const SAVE_FAILED: &str = "无法保存 ComfyUI 安装授权，请检查应用数据目录权限后重试";
const INVALID_INSTALLATION: &str = "已授权的 ComfyUI 安装目录失效，请重新选择安装目录";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedInstallation {
    schema_version: u8,
    installation_root: String,
}

pub(crate) fn private_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir()
        .map(|directory| directory.join(PRIVATE_DIRECTORY))
        .map_err(|_| "无法定位 ComfyUI 安装授权存储".to_string())
}

fn simplify_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().into_owned();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.strip_prefix(r"UNC\")
                .map_or_else(|| rest.to_string(), |unc| format!(r"\\{unc}")));
        }
    }
    path
}

fn normalized(path: &Path) -> PathBuf {
    path.canonicalize().map(simplify_verbatim)
        .unwrap_or_else(|_| path.components().collect())
}

pub(crate) fn is_private_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    private_directory(app).map(|directory| normalized(path).starts_with(normalized(&directory)))
        .unwrap_or(false)
}

pub(crate) fn overlaps_private_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    private_directory(app).map(|directory| {
        let private = normalized(&directory);
        let target = normalized(path);
        target.starts_with(&private) || private.starts_with(&target)
    }).unwrap_or(false)
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}

fn ensure_plain_directory_chain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| UNSAFE_RECORD.to_string())?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(UNSAFE_RECORD.to_string());
        }
    }
    Ok(())
}

/// setup 先执行拒绝规则；每次读写还要再成功执行，不能将 best-effort 当成已隔离。
pub(crate) fn isolate_private_storage<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = private_directory(app)?;
    app.fs_scope().forbid_directory(&directory, true)
        .map_err(|_| "无法隔离 ComfyUI 安装授权存储".to_string())?;
    app.asset_protocol_scope().forbid_directory(&directory, true)
        .map_err(|_| "无法隔离 ComfyUI 安装授权资源".to_string())?;
    if let Ok(canonical) = directory.canonicalize().map(simplify_verbatim) {
        app.fs_scope().forbid_directory(&canonical, true)
            .map_err(|_| "无法隔离 ComfyUI 安装授权存储".to_string())?;
        app.asset_protocol_scope().forbid_directory(&canonical, true)
            .map_err(|_| "无法隔离 ComfyUI 安装授权资源".to_string())?;
    }
    Ok(())
}

/// 插件 setup 在 Builder::build 中执行，早于配置窗口和 Renderer 创建。
/// 放在 fs 插件之后注册；初始隔离失败不能启动可读写旧授权记录的 Renderer。
pub(crate) fn privacy_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("comfyui-installation-privacy")
        .setup(|app, _| {
            isolate_private_storage(app).map_err(|_| std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "无法隔离 ComfyUI 安装授权存储",
            ))?;
            Ok(())
        })
        .build()
}

pub(super) fn storage_directory<R: Runtime>(app: &AppHandle<R>, create: bool) -> Result<Option<PathBuf>, String> {
    isolate_private_storage(app)?;
    let directory = private_directory(app)?;
    match fs::symlink_metadata(&directory) {
        Ok(_) => ensure_plain_directory_chain(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = directory.parent().ok_or_else(|| UNSAFE_RECORD.to_string())?;
            // 应用数据根可尚未创建；逐层创建前先拒绝所有已存在祖先中的链接。
            for ancestor in parent.ancestors() {
                match fs::symlink_metadata(ancestor) {
                    Ok(metadata) if !metadata.is_dir() || is_link_or_reparse(&metadata) => return Err(UNSAFE_RECORD.to_string()),
                    Ok(_) => {},
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                    Err(_) => return Err(UNAVAILABLE_RECORD.to_string()),
                }
            }
            fs::create_dir_all(&directory).map_err(|_| SAVE_FAILED.to_string())?;
            ensure_plain_directory_chain(&directory)?;
        },
        Err(_) => return Err(UNAVAILABLE_RECORD.to_string()),
    }
    isolate_private_storage(app)?;
    directory.canonicalize().map(simplify_verbatim).map(Some)
        .map_err(|_| UNAVAILABLE_RECORD.to_string())
}

fn ordinary_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || is_link_or_reparse(&metadata) => Err(UNSAFE_RECORD.to_string()),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(UNAVAILABLE_RECORD.to_string()),
    }
}

fn read_record_file(path: &Path) -> Result<Option<PersistedInstallation>, String> {
    if !ordinary_file(path)? { return Ok(None); }
    let file = fs::File::open(path).map_err(|_| UNAVAILABLE_RECORD.to_string())?;
    if file.metadata().map_err(|_| UNAVAILABLE_RECORD.to_string())?.len() > MAX_RECORD_BYTES {
        return Err(CORRUPT_RECORD.to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE_RECORD.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES { return Err(CORRUPT_RECORD.to_string()); }
    let record: PersistedInstallation = serde_json::from_slice(&bytes)
        .map_err(|_| CORRUPT_RECORD.to_string())?;
    if record.schema_version != 1 || record.installation_root.is_empty()
        || record.installation_root.trim() != record.installation_root
        || record.installation_root.chars().count() > 32_768
        || record.installation_root.chars().any(char::is_control)
        || !Path::new(&record.installation_root).is_absolute()
    { return Err(CORRUPT_RECORD.to_string()); }
    Ok(Some(record))
}

fn read_record_at(directory: &Path) -> Result<Option<PersistedInstallation>, String> {
    let primary = directory.join(SELECTION_FILE);
    if let Some(record) = read_record_file(&primary)? { return Ok(Some(record)); }
    let backup = directory.join(BACKUP_FILE);
    let Some(record) = read_record_file(&backup)? else { return Ok(None); };
    // 仅恢复已提交的旧备份；未完成的 tmp 不可成为授权。
    fs::rename(&backup, &primary).map_err(|_| UNAVAILABLE_RECORD.to_string())?;
    Ok(Some(record))
}

fn discard_ordinary_file(path: &Path) -> Result<(), String> {
    if ordinary_file(path)? { fs::remove_file(path).map_err(|_| SAVE_FAILED.to_string())?; }
    Ok(())
}

fn write_record_at(directory: &Path, root: &Path) -> Result<(), String> {
    let text = root.to_str().ok_or_else(|| SAVE_FAILED.to_string())?;
    let bytes = serde_json::to_vec(&PersistedInstallation { schema_version: 1, installation_root: text.to_string() })
        .map_err(|_| SAVE_FAILED.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES { return Err(SAVE_FAILED.to_string()); }
    let primary = directory.join(SELECTION_FILE);
    let temporary = directory.join(TEMP_FILE);
    let backup = directory.join(BACKUP_FILE);
    let mut has_primary = ordinary_file(&primary)?;
    // 上次事务若仅剩旧 backup，先恢复它，避免新选择写入失败时丢失已提交授权。
    if !has_primary && ordinary_file(&backup)? {
        fs::rename(&backup, &primary).map_err(|_| SAVE_FAILED.to_string())?;
        has_primary = true;
    }
    discard_ordinary_file(&temporary)?;
    discard_ordinary_file(&backup)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|_| SAVE_FAILED.to_string())?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = discard_ordinary_file(&temporary);
        return Err(SAVE_FAILED.to_string());
    }
    drop(file);
    if has_primary {
        fs::rename(&primary, &backup).map_err(|_| SAVE_FAILED.to_string())?;
    }
    if fs::rename(&temporary, &primary).is_err() {
        if has_primary { let _ = fs::rename(&backup, &primary); }
        let _ = discard_ordinary_file(&temporary);
        return Err(SAVE_FAILED.to_string());
    }
    // primary 已提交；残留备份不能改变新授权，后续写入会清理。
    let _ = discard_ordinary_file(&backup);
    Ok(())
}

fn validate_installation<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Result<PathBuf, String> {
    let root = crate::path_policy::validate_comfyui_installation_directory(app, raw)?;
    if let Some(source) = super::find_main_py(&root) {
        let source_root = crate::path_policy::validate_comfyui_installation_directory(app, &source.to_string_lossy())?;
        if !source_root.starts_with(&root) {
            return Err("ComfyUI 源码目录超出安装根，请选择包含源码的基目录".to_string());
        }
        let main = crate::path_policy::validate_comfyui_installation_file(app, &source_root.join("main.py"), &root)
            .map_err(|_| "ComfyUI main.py 必须为安装根中的普通文件".to_string())?;
        if main.parent() != Some(source_root.as_path()) {
            return Err("ComfyUI main.py 超出源码目录".to_string());
        }
        return Ok(root);
    }
    // 保留 Windows 原有固定批处理 / 启动器兜底；这些安装只能默认启动，管理仍需源码。
    #[cfg(windows)]
    for name in super::FALLBACK_SCRIPTS.iter().chain(super::FALLBACK_LAUNCHERS.iter()) {
        let path = root.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let parent = path.parent().ok_or_else(|| "ComfyUI 启动入口无效".to_string())?;
                let parent = crate::path_policy::validate_comfyui_installation_directory(app, &parent.to_string_lossy())?;
                crate::path_policy::validate_comfyui_installation_file(app, &path, &root)
                    .map_err(|_| "ComfyUI 启动入口必须为普通文件".to_string())?;
                if !parent.starts_with(&root) {
                    return Err("ComfyUI 启动入口超出安装根".to_string());
                }
                return Ok(root);
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("无法访问 ComfyUI 启动入口".to_string()),
        }
    }
    Err("未找到安装根中的 ComfyUI main.py 或受支持的启动入口，请选择包含源码的安装基目录".to_string())
}

fn saved_installation<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    let _guard = RECORD_LOCK.lock().map_err(|_| UNAVAILABLE_RECORD.to_string())?;
    let Some(directory) = storage_directory(app, false)? else { return Ok(None); };
    let Some(record) = read_record_at(&directory)? else { return Ok(None); };
    let root = validate_installation(app, &record.installation_root)
        .map_err(|_| INVALID_INSTALLATION.to_string())?;
    if root != PathBuf::from(record.installation_root) { return Err(INVALID_INSTALLATION.to_string()); }
    Ok(Some(root))
}

pub(super) fn persist_installation<R: Runtime>(app: &AppHandle<R>, expected: &Path) -> Result<(), String> {
    let _guard = RECORD_LOCK.lock().map_err(|_| UNAVAILABLE_RECORD.to_string())?;
    let root = validate_installation(app, &expected.to_string_lossy())?;
    if root != expected { return Err(INVALID_INSTALLATION.to_string()); }
    let directory = storage_directory(app, true)?.ok_or_else(|| SAVE_FAILED.to_string())?;
    write_record_at(&directory, &root)
}

/// 当前已记住的安装根，只供原生运行状态匹配，不授予通用文件权限。
pub(super) fn current_installation_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    saved_installation(app)
}

/// 只从已保存的原生安装授权恢复；管理会话复核不能弹确认或依赖易失 fs scope。
pub(super) fn reauthorize_installation(app: &AppHandle, expected: &Path) -> Result<PathBuf, String> {
    let root = saved_installation(app)?
        .ok_or_else(|| "ComfyUI 安装授权不存在，请从主窗口重新选择安装目录".to_string())?;
    if root != expected { return Err("ComfyUI 安装授权已变更，请重新打开设置".to_string()); }
    Ok(root)
}

async fn request_installation_approval(app: &AppHandle, root: &Path) -> Result<bool, String> {
    let main = app.get_webview_window("main").ok_or_else(|| "未找到 ComfyUI 安装授权主窗口".to_string())?;
    let message = format!("是否记住以下 ComfyUI 安装目录？\n\n{}\n\n此授权仅用于启动 ComfyUI、管理内核与扩展。启动会以当前用户权限运行该目录中的 Python 和扩展代码，管理会修改该安装目录。授权在重启后保留，不增加通用文件访问权限。请确认这是你信任的安装目录。", root.display());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().message(message).parent(&main).title("记住 ComfyUI 安装目录？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("信任并记住此安装目录".to_string(), "取消".to_string()))
        .show(move |approved| { let _ = tx.send(approved); });
    rx.await.map_err(|_| "ComfyUI 安装授权确认已中断".to_string())
}

/// 调用命令必须先校验本地调用方并持有 management 的操作锁。
pub(super) async fn authorize_installation(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    if let Some(root) = saved_installation(app)? {
        let candidate = validate_installation(app, raw)?;
        if candidate != root {
            return Err("ComfyUI 安装目录与已授权安装不一致，请通过更换按钮重新选择".to_string());
        }
        return Ok(root);
    }
    // raw 此时仍只是候选，校验固定安装结构和私有边界后才能请求授权。
    let candidate = validate_installation(app, raw)?;
    let scoped = crate::path_policy::authorize_existing_plain_directory(app, raw)
        .is_ok_and(|authorized| authorized == candidate);
    if !scoped && !request_installation_approval(app, &candidate).await? {
        return Err("已取消 ComfyUI 安装目录授权".to_string());
    }
    // 对话框等待期间目录可能变化，提交前复核；已有记录不能被并发候选覆盖。
    if let Some(saved) = saved_installation(app)? {
        return if saved == candidate { Ok(saved) }
            else { Err("ComfyUI 安装授权已变更，请重新发起操作".to_string()) };
    }
    persist_installation(app, &candidate)?;
    Ok(candidate)
}

fn ensure_main_caller(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview)?;
    if webview.label() != "main" { return Err("仅主窗口可以选择或恢复 ComfyUI 安装目录".to_string()); }
    Ok(())
}

#[tauri::command]
pub fn get_comfyui_installation(webview: Webview, app: AppHandle) -> Result<Option<String>, String> {
    ensure_main_caller(&webview)?;
    saved_installation(&app).map(|root| root.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn select_comfyui_installation(webview: Webview, app: AppHandle) -> Result<Option<String>, String> {
    ensure_main_caller(&webview)?;
    let _guard = super::management::lock_operations().await;
    if super::runtime_console::has_active_owned_run(&app) {
        return Err("请先在 ComfyUI 运行输出页停止本应用启动的服务，再更换安装目录".to_string());
    }
    if app.get_webview_window("comfyui-settings").is_some() {
        return Err("请先关闭 ComfyUI 设置窗口，再更换安装目录".to_string());
    }
    // 先确认能够隔离权威存储；失败不能选择后悄悄使用临时授权。
    isolate_private_storage(&app)?;
    let main = app.get_webview_window("main").ok_or_else(|| "未找到主窗口".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Rust builder 直接接收系统选择结果，不经过 JS open 的通用 scope 授权包装。
    app.dialog().file().set_parent(&main).set_title("选择 ComfyUI 安装目录")
        .pick_folder(move |selected| { let _ = tx.send(selected); });
    let Some(selected) = rx.await.map_err(|_| "ComfyUI 目录选择已中断".to_string())? else { return Ok(None); };
    ensure_main_caller(&webview)?;
    let path = selected.into_path().map_err(|_| "请选择本机 ComfyUI 安装目录".to_string())?;
    let root = validate_installation(&app, &path.to_string_lossy())?;
    persist_installation(&app, &root)?;
    super::management::invalidate_management_cache(&app);
    Ok(Some(root.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TemporaryDirectory(PathBuf);
    impl TemporaryDirectory {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("ai-canvas-comfy-grant-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TemporaryDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn committed_selection_roundtrips_and_replaces_previous_root() {
        let directory = TemporaryDirectory::new();
        let first = directory.0.join("first");
        let second = directory.0.join("second");
        write_record_at(&directory.0, &first).unwrap();
        assert_eq!(read_record_at(&directory.0).unwrap().unwrap().installation_root, first.to_str().unwrap());
        write_record_at(&directory.0, &second).unwrap();
        assert_eq!(read_record_at(&directory.0).unwrap().unwrap().installation_root, second.to_str().unwrap());
    }

    #[test]
    fn interrupted_commit_restores_backup_but_never_promotes_temporary_record() {
        let directory = TemporaryDirectory::new();
        let first = directory.0.join("first");
        write_record_at(&directory.0, &first).unwrap();
        fs::rename(directory.0.join(SELECTION_FILE), directory.0.join(BACKUP_FILE)).unwrap();
        fs::write(directory.0.join(TEMP_FILE), b"uncommitted").unwrap();
        assert_eq!(read_record_at(&directory.0).unwrap().unwrap().installation_root, first.to_str().unwrap());
        assert!(directory.0.join(SELECTION_FILE).is_file());
        fs::remove_file(directory.0.join(SELECTION_FILE)).unwrap();
        assert!(read_record_at(&directory.0).unwrap().is_none());
    }

    #[test]
    fn failed_replacement_preserves_previously_committed_backup_selection() {
        let directory = TemporaryDirectory::new();
        let first = directory.0.join("first");
        write_record_at(&directory.0, &first).unwrap();
        fs::rename(directory.0.join(SELECTION_FILE), directory.0.join(BACKUP_FILE)).unwrap();
        // tmp 被目录占用时写入必须失败，不能为重试删除目录或丢掉旧授权。
        fs::create_dir(directory.0.join(TEMP_FILE)).unwrap();
        assert!(write_record_at(&directory.0, &directory.0.join("second")).is_err());
        assert_eq!(read_record_at(&directory.0).unwrap().unwrap().installation_root, first.to_str().unwrap());
        assert!(directory.0.join(TEMP_FILE).is_dir());
    }

    #[test]
    fn corrupt_or_oversized_committed_record_does_not_become_a_fresh_grant() {
        let directory = TemporaryDirectory::new();
        fs::write(directory.0.join(SELECTION_FILE), b"{broken").unwrap();
        assert!(matches!(read_record_at(&directory.0), Err(error) if error == CORRUPT_RECORD));
        fs::write(directory.0.join(SELECTION_FILE), vec![b' '; MAX_RECORD_BYTES as usize + 1]).unwrap();
        assert!(matches!(read_record_at(&directory.0), Err(error) if error == CORRUPT_RECORD));
    }

    #[cfg(unix)]
    #[test]
    fn linked_grant_file_is_rejected_without_reading_or_overwriting_target() {
        let directory = TemporaryDirectory::new();
        let target = directory.0.join("outside.json");
        fs::write(&target, b"unchanged").unwrap();
        std::os::unix::fs::symlink(&target, directory.0.join(SELECTION_FILE)).unwrap();
        assert!(matches!(read_record_at(&directory.0), Err(error) if error == UNSAFE_RECORD));
        assert!(matches!(write_record_at(&directory.0, &directory.0.join("root")), Err(error) if error == UNSAFE_RECORD));
        assert_eq!(fs::read(target).unwrap().as_slice(), b"unchanged");
    }
}
