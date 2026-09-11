//! 凭据存储 —— 由 Rust 独占的本地文件，Renderer 拿不到整份内容。
//!
//! API Key 以前随整份配置写进 IndexedDB：任何拿到 Renderer 执行权的代码（XSS、
//! 恶意项目数据、被注入的依赖）都能整库读走，磁盘上也留有明文。现在凭据只落在
//! `{appData}/secrets/credentials.json`，配置里只留条目名，Renderer 只能通过下面的
//! 命令按条目名逐条索取，无法枚举或整份导出。
//!
//! 该目录在三条访问路径上都被显式拒绝：fs 插件 scope、asset 协议 scope、
//! 以及自定义原生命令的 path_policy（见 `deny_secret_dir_access`）。少任何一条，
//! 被注入的 Renderer 都能绕开本模块直接读文件。
//!
//! 静态保护只有文件权限（unix 0600）：以当前用户身份运行的本地进程仍可读取。
//! 想再上一层需要系统钥匙串（macOS 未签名构建会反复弹授权）或 Windows DPAPI。

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, Webview};

use crate::path_policy::ensure_trusted_caller;

/// 凭据目录名，path_policy 与 scope 拒绝规则都引用它。
pub const SECRET_DIR_NAME: &str = "secrets";
const SECRET_FILE_NAME: &str = "credentials.json";
/// 凭据目录下会出现的全部文件（含原子写入的临时文件）。
/// asset 协议 scope 只能按文件拒绝，新增文件时必须同步加进这里。
const SECRET_LOCK_NAME: &str = "credentials.lock";
const SECRET_FILE_NAMES: [&str; 3] = [SECRET_FILE_NAME, "credentials.json.tmp", SECRET_LOCK_NAME];
/// 单条凭据长度上限，避免被当成任意大小的存储滥用。
const MAX_SECRET_BYTES: usize = 8 * 1024;
const MAX_KEY_LEN: usize = 120;

const LOCK_TIMEOUT: Duration = Duration::from_millis(1000);

/// 只返回稳定分类，不把系统路径、凭据或原始错误传给 Renderer。
#[derive(Debug, Serialize, PartialEq)]
pub struct SecretError {
    code: &'static str,
}

impl SecretError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl From<std::io::Error> for SecretError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind;
        #[cfg(windows)]
        if matches!(error.raw_os_error(), Some(32 | 33)) {
            return Self::new("busy");
        }
        Self::new(match error.kind() {
            ErrorKind::PermissionDenied => "permission_denied",
            ErrorKind::WouldBlock | ErrorKind::TimedOut => "busy",
            ErrorKind::Interrupted => "interrupted",
            ErrorKind::InvalidData | ErrorKind::InvalidInput => "invalid_data",
            ErrorKind::StorageFull => "quota",
            _ => "unknown",
        })
    }
}

/// 可选参数保持旧 IPC 兼容；新版调用明确提供预期值或不含明文的清理指纹。
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum SecretExpectation {
    Value { value: Option<String> },
    Fingerprint { fingerprint: String },
}

fn fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn check_expected(
    current: Option<&String>,
    expected: Option<&SecretExpectation>,
) -> Result<(), SecretError> {
    let matches = match expected {
        None => true,
        Some(SecretExpectation::Value { value }) => current == value.as_ref(),
        Some(SecretExpectation::Fingerprint { fingerprint: hash }) => {
            current.is_some_and(|value| fingerprint(value) == *hash)
        }
    };
    if matches {
        Ok(())
    } else {
        Err(SecretError::new("conflict"))
    }
}

type SecretMap = BTreeMap<String, String>;

/// 条目名由前端按 `provider/{连接ID}` 生成，这里只做字符白名单。
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err("凭据条目名长度不合法".to_string());
    }
    let allowed = key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':'));
    if !allowed {
        return Err("凭据条目名包含非法字符".to_string());
    }
    // 条目名固定由 `provider/{连接ID}` 生成，出现 `..` 只可能是拼接被污染
    if key.contains("..") {
        return Err("凭据条目名包含非法片段".to_string());
    }
    Ok(())
}

/// 凭据目录：`{appData}/secrets`。
pub fn secret_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    Ok(base.join(SECRET_DIR_NAME))
}

fn secret_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(secret_dir(app)?.join(SECRET_FILE_NAME))
}

/// unix 下把文件收紧到仅当前用户可读写；Windows 依赖用户目录自身的 ACL。
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), SecretError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(SecretError::from)
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), SecretError> {
    Ok(())
}

fn read_map(file: &Path) -> Result<SecretMap, SecretError> {
    match std::fs::read(file) {
        Ok(bytes) => {
            let map = serde_json::from_slice::<SecretMap>(&bytes)
                .map_err(|_| SecretError::new("invalid_data"))?;
            if map.iter().any(|(key, value)| {
                validate_key(key).is_err() || value.is_empty() || value.len() > MAX_SECRET_BYTES
            }) {
                return Err(SecretError::new("invalid_data"));
            }
            Ok(map)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SecretMap::new()),
        Err(error) => Err(error.into()),
    }
}

fn open_private_file(path: &Path, truncate: bool) -> Result<File, SecretError> {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .read(true)
        .write(true)
        .truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    restrict_permissions(path)?;
    Ok(file)
}

/// 锁住固定的旁置文件，不能锁随后会被 rename 替换的凭据文件本身。
fn lock_store(file: &Path, timeout: Duration) -> Result<File, SecretError> {
    let dir = file
        .parent()
        .ok_or_else(|| SecretError::new("invalid_data"))?;
    std::fs::create_dir_all(dir)?;
    let lock = open_private_file(&dir.join(SECRET_LOCK_NAME), false)?;
    let started = Instant::now();
    loop {
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => return Ok(lock),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                if started.elapsed() >= timeout {
                    return Err(SecretError::new("busy"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

/// 先写临时文件再改名，避免写入中断留下半份凭据。
fn write_map(file: &Path, map: &SecretMap) -> Result<(), SecretError> {
    let dir = file
        .parent()
        .ok_or_else(|| SecretError::new("invalid_data"))?;
    std::fs::create_dir_all(dir)?;

    let body = serde_json::to_vec(map).map_err(|_| SecretError::new("invalid_data"))?;
    let temp = file.with_extension("json.tmp");
    let mut staging = open_private_file(&temp, true)?;
    staging.write_all(&body)?;
    staging.sync_all()?;
    drop(staging);
    std::fs::rename(&temp, file)?;
    // Windows 同步替换后的文件；Unix 还需同步父目录的目录项。
    OpenOptions::new().write(true).open(file)?.sync_all()?;
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    Ok(())
}

fn set_entry(
    file: &Path,
    key: &str,
    value: &str,
    expected: Option<&SecretExpectation>,
) -> Result<(), SecretError> {
    let _lock = lock_store(file, LOCK_TIMEOUT)?;
    let mut map = read_map(file)?;
    // 部分成功后的显式重试允许收敛到已经提交的同值，不再次覆盖文件。
    if map.get(key).map(String::as_str) == Some(value) {
        return Ok(());
    }
    check_expected(map.get(key), expected)?;
    map.insert(key.to_string(), value.to_string());
    write_map(file, &map)
}

fn delete_entry(
    file: &Path,
    key: &str,
    expected: Option<&SecretExpectation>,
) -> Result<(), SecretError> {
    let _lock = lock_store(file, LOCK_TIMEOUT)?;
    let mut map = read_map(file)?;
    if !map.contains_key(key) {
        return Ok(());
    }
    check_expected(map.get(key), expected)?;
    map.remove(key);
    write_map(file, &map)
}

/// 写入或覆盖一条凭据。
#[tauri::command]
pub async fn secret_set(
    app: AppHandle,
    webview: Webview,
    key: String,
    value: String,
    expected: Option<SecretExpectation>,
) -> Result<(), SecretError> {
    ensure_trusted_caller(&webview).map_err(|_| SecretError::new("permission_denied"))?;
    validate_key(&key).map_err(|_| SecretError::new("invalid_data"))?;
    if value.is_empty() {
        return Err(SecretError::new("invalid_data"));
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err(SecretError::new("invalid_data"));
    }

    let file = secret_file(&app).map_err(|_| SecretError::new("unavailable"))?;
    tauri::async_runtime::spawn_blocking(move || set_entry(&file, &key, &value, expected.as_ref()))
        .await
        .map_err(|_| SecretError::new("unknown"))?
}

/// 读取一条凭据；条目不存在返回 None（首次运行、用户手动清理都属正常）。
#[tauri::command]
pub async fn secret_get(
    app: AppHandle,
    webview: Webview,
    key: String,
    fingerprint_only: Option<bool>,
) -> Result<Option<String>, SecretError> {
    ensure_trusted_caller(&webview).map_err(|_| SecretError::new("permission_denied"))?;
    validate_key(&key).map_err(|_| SecretError::new("invalid_data"))?;

    let file = secret_file(&app).map_err(|_| SecretError::new("unavailable"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = lock_store(&file, LOCK_TIMEOUT)?;
        Ok(read_map(&file)?.get(&key).map(|value| {
            if fingerprint_only == Some(true) {
                fingerprint(value)
            } else {
                value.clone()
            }
        }))
    })
    .await
    .map_err(|_| SecretError::new("unknown"))?
}

/// 删除一条凭据；条目本就不存在视为成功。
#[tauri::command]
pub async fn secret_delete(
    app: AppHandle,
    webview: Webview,
    key: String,
    expected: Option<SecretExpectation>,
) -> Result<(), SecretError> {
    ensure_trusted_caller(&webview).map_err(|_| SecretError::new("permission_denied"))?;
    validate_key(&key).map_err(|_| SecretError::new("invalid_data"))?;

    let file = secret_file(&app).map_err(|_| SecretError::new("unavailable"))?;
    tauri::async_runtime::spawn_blocking(move || delete_entry(&file, &key, expected.as_ref()))
        .await
        .map_err(|_| SecretError::new("unknown"))?
}

/// 凭据存储是否可用（能否创建目录）。前端据此决定是持久化还是仅本次会话有效。
#[tauri::command]
pub async fn secret_store_available(app: AppHandle, webview: Webview) -> Result<bool, SecretError> {
    ensure_trusted_caller(&webview).map_err(|_| SecretError::new("permission_denied"))?;
    let file = secret_file(&app).map_err(|_| SecretError::new("unavailable"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = lock_store(&file, LOCK_TIMEOUT)?;
        read_map(&file)?;
        Ok(true)
    })
    .await
    .map_err(|_| SecretError::new("unknown"))?
}

/// 把凭据目录从 fs 插件 scope 和 asset 协议 scope 中彻底拒掉。
/// 拒绝规则优先于允许规则，因此即使 `$APPDATA/**` 被放行，这个子目录仍不可达。
pub fn deny_secret_dir_access<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_fs::FsExt;

    let Ok(dir) = secret_dir(app) else {
        return;
    };
    if app.fs_scope().forbid_directory(&dir, true).is_err() {
        eprintln!("[secret-store] 无法从 fs scope 拒绝凭据目录");
    }
    // asset 协议的 scope 只暴露按文件拒绝的接口，逐个拒掉已知文件名
    let scopes = app.state::<tauri::scope::Scopes>();
    for name in SECRET_FILE_NAMES {
        if scopes.forbid_file(dir.join(name)).is_err() {
            eprintln!("[secret-store] 无法从 asset scope 拒绝凭据资源");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let root = std::env::var_os("AI_CANVAS_SECRET_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = root.join(format!(
            "ai-canvas-secret-test-{name}-{}-{nonce}",
            std::process::id()
        ));
        dir.join(SECRET_FILE_NAME)
    }

    #[test]
    fn conditional_writes_and_deletes_reject_stale_values() {
        let file = temp_file("conditional");
        let missing = SecretExpectation::Value { value: None };
        set_entry(&file, "provider/a", "first", Some(&missing)).unwrap();
        assert_eq!(
            set_entry(&file, "provider/a", "second", Some(&missing))
                .unwrap_err()
                .code,
            "conflict"
        );
        // 对已经提交的同值允许显式重试；不影响其他条目。
        set_entry(&file, "provider/a", "first", Some(&missing)).unwrap();
        let expected: SecretExpectation =
            serde_json::from_value(serde_json::json!({ "fingerprint": fingerprint("first") }))
                .unwrap();
        set_entry(
            &file,
            "provider/a",
            "second",
            Some(&SecretExpectation::Value {
                value: Some("first".into()),
            }),
        )
        .unwrap();
        assert_eq!(
            delete_entry(&file, "provider/a", Some(&expected))
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(
            read_map(&file).unwrap().get("provider/a").unwrap(),
            "second"
        );
        delete_entry(
            &file,
            "provider/a",
            Some(&SecretExpectation::Fingerprint {
                fingerprint: fingerprint("second"),
            }),
        )
        .unwrap();
        assert!(read_map(&file).unwrap().is_empty());
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn bounded_lock_wait_does_not_touch_credentials() {
        let file = temp_file("locked");
        let lock = lock_store(&file, LOCK_TIMEOUT).unwrap();
        let start = Instant::now();
        assert_eq!(
            lock_store(&file, Duration::from_millis(40))
                .unwrap_err()
                .code,
            "busy"
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(!file.exists());
        drop(lock);
        set_entry(&file, "provider/a", "fixture", None).unwrap();
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn failed_staging_and_corrupt_files_never_replace_the_last_record() {
        let file = temp_file("staging");
        set_entry(&file, "provider/a", "original", None).unwrap();
        let before = std::fs::read(&file).unwrap();
        std::fs::create_dir(file.with_extension("json.tmp")).unwrap();
        assert!(set_entry(&file, "provider/a", "replacement", None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), before);
        std::fs::write(&file, b"invalid fixture").unwrap();
        assert_eq!(
            set_entry(&file, "provider/a", "replacement", None)
                .unwrap_err()
                .code,
            "invalid_data"
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"invalid fixture");
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn errors_and_private_file_names_do_not_expose_credentials() {
        let error = SecretError::from(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "fixture-private-path-key",
        ));
        assert_eq!(
            serde_json::to_string(&error).unwrap(),
            r#"{"code":"permission_denied"}"#
        );
        assert!(SECRET_FILE_NAMES.contains(&SECRET_LOCK_NAME));
    }

    fn worker(file: &Path, id: &str) -> std::process::Command {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "secret_store::tests::cross_process_worker",
                "--nocapture",
            ])
            .env("AI_CANVAS_SECRET_WORKER_FILE", file)
            .env("AI_CANVAS_SECRET_WORKER_ID", id);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    #[test]
    fn cross_process_worker() {
        let Some(file) = std::env::var_os("AI_CANVAS_SECRET_WORKER_FILE") else {
            return;
        };
        let file = PathBuf::from(file);
        let id = std::env::var("AI_CANVAS_SECRET_WORKER_ID").unwrap();
        if id == "exit-with-lock" {
            let _lock = lock_store(&file, LOCK_TIMEOUT).unwrap();
            std::process::exit(0);
        }
        for index in 0..12 {
            set_entry(&file, &format!("provider/{id}-{index}"), "fixture", None).unwrap();
        }
    }

    #[test]
    fn separate_processes_preserve_entries_and_release_locks_after_exit() {
        let file = temp_file("processes");
        let children: Vec<_> = (0..3)
            .map(|id| {
                worker(&file, &id.to_string())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(read_map(&file).unwrap().len(), 36);
        assert!(worker(&file, "exit-with-lock")
            .output()
            .unwrap()
            .status
            .success());
        set_entry(&file, "provider/after-exit", "fixture", None).unwrap();
        assert_eq!(read_map(&file).unwrap().len(), 37);
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn rejects_malformed_entry_keys() {
        assert!(validate_key("provider/apimart").is_ok());
        assert!(validate_key("provider:custom-openai.1").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("provider/../../etc").is_err());
        assert!(validate_key("provider name").is_err());
        assert!(validate_key(&"x".repeat(MAX_KEY_LEN + 1)).is_err());
    }

    #[test]
    fn missing_file_reads_as_empty_store() {
        let file = temp_file("missing");
        assert!(read_map(&file).expect("缺文件应视为空").is_empty());
    }

    #[test]
    fn round_trips_entries_and_keeps_others_on_delete() {
        let file = temp_file("round-trip");
        let mut map = SecretMap::new();
        map.insert("provider/a".to_string(), "key-a".to_string());
        map.insert("provider/b".to_string(), "key-b".to_string());
        write_map(&file, &map).expect("写入应成功");

        let loaded = read_map(&file).expect("读取应成功");
        assert_eq!(loaded.get("provider/a").map(String::as_str), Some("key-a"));
        assert_eq!(loaded.get("provider/b").map(String::as_str), Some("key-b"));

        let mut after_delete = loaded;
        after_delete.remove("provider/a");
        write_map(&file, &after_delete).expect("重写应成功");
        let reloaded = read_map(&file).expect("读取应成功");
        assert!(!reloaded.contains_key("provider/a"));
        assert_eq!(
            reloaded.get("provider/b").map(String::as_str),
            Some("key-b")
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stores_credentials_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let file = temp_file("permissions");
        let mut map = SecretMap::new();
        map.insert("provider/a".to_string(), "key-a".to_string());
        write_map(&file, &map).expect("写入应成功");

        let mode = std::fs::metadata(&file)
            .expect("应能读取元数据")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn reports_corrupted_file_instead_of_silently_dropping_secrets() {
        let file = temp_file("corrupted");
        std::fs::create_dir_all(file.parent().unwrap()).expect("建目录");
        std::fs::write(&file, b"not json").expect("写坏数据");

        assert!(read_map(&file).is_err());

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }
}
