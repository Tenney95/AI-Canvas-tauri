//! 原生文件命令的调用方与路径校验。
//!
//! 自定义命令不经过 Tauri 的 fs 插件，因此不会自动受 capability scope 约束。
//! Renderer 一旦被注入（XSS、恶意项目数据、Agent 写入），未校验的路径参数就等于
//! 任意文件读写 / 删除 / 启动进程。本模块给这些命令补上两道闸：
//!
//! 1. 调用方校验：只接受加载本地前端的自有窗口，拒绝远程页面（如即梦登录窗）。
//! 2. 路径校验：解析真实路径（含符号链接），要求落在应用自有数据目录，
//!    或用户通过对话框 / 外部素材目录显式授权过的 fs scope 内。

use std::{
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use tauri::{Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

/// 允许调用敏感原生命令的窗口标签，与 capabilities/default.json 的 windows 一致。
/// dreamina-login（远程页面）与 director-desk（本地安装的第三方运行时）不在其中。
const TRUSTED_WINDOW_LABELS: [&str; 3] = ["main", "asset-search", "chat-assistant"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PathAccess {
    /// 读取已存在的文件或目录。
    Read,
    /// 写入 / 删除，目标本身可以尚不存在，此时校验其父目录。
    Write,
}

/// 校验命令来自自有本地窗口，而不是远程页面或第三方运行时窗口。
pub fn ensure_trusted_caller<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    let label = webview.label();
    if !TRUSTED_WINDOW_LABELS.contains(&label) {
        return Err(format!("窗口 {label} 无权调用该命令"));
    }

    // 窗口即使标签可信，也可能被导航到远程地址，必须再确认当前来源仍是本地前端。
    let url = webview
        .url()
        .map_err(|e| format!("无法确认调用窗口来源: {e}"))?;
    let is_local = match url.scheme() {
        "tauri" | "asset" | "file" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "tauri.localhost" | "asset.localhost")
        ),
        _ => false,
    };
    if !is_local {
        return Err(format!("窗口 {label} 当前来源不是本地前端，已拒绝该命令"));
    }
    Ok(())
}

/// canonicalize 后去掉 Windows 的 `\\?\` verbatim 前缀。
///
/// 命令返回的路径会被前端存进节点数据，而前端所有「这个文件在不在项目目录里」的判断
/// 都是字符串前缀比较（改名同步、分组搬运、相对路径索引）。带前缀的路径一律比不中，
/// 且失败都是静默的。fs 插件和前端拼出来的路径本来就是普通形式，这里统一成同一种。
fn canonicalize_simplified(path: &Path) -> std::io::Result<PathBuf> {
    Ok(simplify_verbatim(path.canonicalize()?))
}

#[cfg(windows)]
fn simplify_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        // `\\?\UNC\server\share` 还原成 `\\server\share`
        Some(rest) => PathBuf::from(
            rest.strip_prefix(r"UNC\")
                .map_or_else(|| rest.to_string(), |unc| format!(r"\\{unc}")),
        ),
        None => path,
    }
}

#[cfg(not(windows))]
fn simplify_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// 应用自有的可写数据目录（项目素材、配置、缓存都在其中）。
fn app_owned_roots<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<PathBuf> {
    let path = app.path();
    [
        path.app_data_dir(),
        path.app_local_data_dir(),
        path.app_config_dir(),
        path.app_cache_dir(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|dir| canonicalize_simplified(&dir).ok())
    .collect()
}

fn is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// 自定义命令一律不得触碰凭据目录。
/// 少了这道判断，被注入的 Renderer 可以用 copy_file_streamed 把凭据文件复制进
/// 项目素材目录，而那里是 Renderer 可读的，等于绕过 secret_* 命令整份读走。
fn is_secret_path<R: Runtime>(app: &tauri::AppHandle<R>, resolved: &Path) -> bool {
    let Ok(secret_dir) = crate::secret_store::secret_dir(app) else {
        return false;
    };
    is_under_secret_dir(&secret_dir, resolved)
}

/// 除凭据外，智能体 sourceId 到真实外部目录的映射也只能由 Rust 专用命令读取。
fn is_private_app_path<R: Runtime>(app: &tauri::AppHandle<R>, resolved: &Path) -> bool {
    is_secret_path(app, resolved) || crate::agent_package::is_agent_private_path(app, resolved)
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    is_within(left, right) || is_within(right, left)
}

/// 用作 Blender 项目根时，既不能位于私有目录内，也不能成为私有目录的祖先。
fn overlaps_private_app_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    resolved: &Path,
) -> bool {
    let overlaps_secret = crate::secret_store::secret_dir(app)
        .map(|directory| {
            let normalized = directory.components().collect::<PathBuf>();
            paths_overlap(resolved, &normalized)
                || canonicalize_simplified(&directory)
                    .is_ok_and(|canonical| paths_overlap(resolved, &canonical))
        })
        .unwrap_or(false);
    overlaps_secret
        || crate::agent_package::is_agent_private_path_overlap(app, resolved)
        || crate::blender_runtime::is_blender_private_path_overlap(app, resolved)
}

/// 凭据目录可能尚未创建（无法 canonicalize），因此同时按原始路径与解析后路径比对。
fn is_under_secret_dir(secret_dir: &Path, resolved: &Path) -> bool {
    let normalized = secret_dir.components().collect::<PathBuf>();
    is_within(resolved, &normalized)
        || canonicalize_simplified(secret_dir).is_ok_and(|canonical| is_within(resolved, &canonical))
}

/// 解析路径的真实位置：存在则 canonicalize；写入场景下允许目标不存在，改用父目录解析。
/// canonicalize 会展开 `..` 与符号链接，避免用软链把授权目录指到别处。
fn resolve_path(raw: &str, access: PathAccess) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    if trimmed.contains('\0') {
        return Err("路径包含非法字符".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("只接受绝对路径: {trimmed}"));
    }

    if let Ok(canonical) = canonicalize_simplified(&path) {
        return Ok(canonical);
    }
    if access == PathAccess::Read {
        return Err(format!("路径不存在或无法访问: {trimmed}"));
    }

    // 写入目标尚不存在：父目录必须存在且可解析，文件名不能是 `.`/`..` 之类。
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法定位父目录: {trimmed}"))?;
    let file_name = match path.components().next_back() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => return Err(format!("路径缺少有效的文件名: {trimmed}")),
    };
    let canonical_parent = canonicalize_simplified(parent)
        .map_err(|e| format!("目标目录不存在或无法访问（{}）: {e}", parent.display()))?;
    Ok(canonical_parent.join(file_name))
}

/// 判断解析后的路径是否在允许范围内：应用自有目录，或用户已授权的 fs scope。
fn is_authorized<R: Runtime>(
    app: &tauri::AppHandle<R>,
    resolved: &Path,
    access: PathAccess,
    extra_roots: &[PathBuf],
) -> bool {
    if app_owned_roots(app)
        .iter()
        .chain(extra_roots.iter())
        .any(|root| is_within(resolved, root))
    {
        return true;
    }

    // fs scope 覆盖用户通过文件对话框选中的文件、拖入的文件和登记过的外部素材目录。
    // is_allowed 内部会 canonicalize，因此不存在的写入目标要用父目录判断。
    let scope = app.fs_scope();
    if scope.is_allowed(resolved) {
        return true;
    }
    if access == PathAccess::Write {
        if let Some(parent) = resolved.parent() {
            return scope.is_allowed(parent);
        }
    }
    false
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// 校验用途单一的外部目录授权，并只返回经过解析的普通目录。
///
/// 与通用 [`authorize_path`] 不同，这个入口不接受文件或尚不存在的目标，也不在错误中
/// 回显调用方提供的路径。Blender 项目 grant 使用它，避免把绝对项目路径带回前端日志。
pub fn authorize_existing_plain_directory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    raw: &str,
) -> Result<PathBuf, String> {
    const INVALID_DIRECTORY: &str = "目录无效、不可访问或未获授权";
    const MAX_DIRECTORY_CHARS: usize = 32_768;

    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed != raw
        || raw.chars().count() > MAX_DIRECTORY_CHARS
        || raw.chars().any(char::is_control)
    {
        return Err(INVALID_DIRECTORY.to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(INVALID_DIRECTORY.to_string());
    }

    authorize_existing_plain_directory_path(app, &path)
}

fn authorize_existing_plain_directory_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<PathBuf, String> {
    const INVALID_DIRECTORY: &str = "目录无效、不可访问或未获授权";
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| INVALID_DIRECTORY.to_string())?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(INVALID_DIRECTORY.to_string());
    }

    let resolved = canonicalize_simplified(path)
        .map_err(|_| INVALID_DIRECTORY.to_string())?;
    let resolved_metadata = std::fs::symlink_metadata(&resolved)
        .map_err(|_| INVALID_DIRECTORY.to_string())?;
    if !resolved_metadata.is_dir() || is_link_or_reparse(&resolved_metadata) {
        return Err(INVALID_DIRECTORY.to_string());
    }
    if overlaps_private_app_path(app, &resolved)
        || !is_authorized(app, &resolved, PathAccess::Read, &[])
        || !is_authorized(app, &resolved, PathAccess::Write, &[])
    {
        return Err(INVALID_DIRECTORY.to_string());
    }

    Ok(resolved)
}

/// 对已登记的 Blender 项目根执行每次 Job 启动前的重新授权与身份复核。
pub fn reauthorize_existing_plain_directory<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<PathBuf, String> {
    authorize_existing_plain_directory_path(app, path)
}

/// 只接受由文件对话框或 fs scope 明确授权的普通现有文件，不回显路径。
pub fn authorize_existing_plain_file<R: Runtime>(
    app: &tauri::AppHandle<R>,
    raw: &str,
) -> Result<PathBuf, String> {
    const INVALID_FILE: &str = "文件无效、不可访问或未获授权";
    const MAX_FILE_CHARS: usize = 32_768;
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed != raw
        || raw.chars().count() > MAX_FILE_CHARS
        || raw.chars().any(char::is_control)
    {
        return Err(INVALID_FILE.to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(INVALID_FILE.to_string());
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| INVALID_FILE.to_string())?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(INVALID_FILE.to_string());
    }
    let resolved = canonicalize_simplified(&path).map_err(|_| INVALID_FILE.to_string())?;
    let resolved_metadata =
        std::fs::symlink_metadata(&resolved).map_err(|_| INVALID_FILE.to_string())?;
    if !resolved_metadata.is_file()
        || is_link_or_reparse(&resolved_metadata)
        || is_private_app_path(app, &resolved)
        || !is_authorized(app, &resolved, PathAccess::Read, &[])
    {
        return Err(INVALID_FILE.to_string());
    }
    Ok(resolved)
}

/// 校验并解析命令收到的路径参数，返回可安全使用的真实路径。
pub fn authorize_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    raw: &str,
    access: PathAccess,
) -> Result<PathBuf, String> {
    authorize_path_with_roots(app, raw, access, &[])
}

/// 同 [`authorize_path`]，另外接受一组命令自身额外允许的根目录。
pub fn authorize_path_with_roots<R: Runtime>(
    app: &tauri::AppHandle<R>,
    raw: &str,
    access: PathAccess,
    extra_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let resolved = resolve_path(raw, access)?;
    if is_private_app_path(app, &resolved) {
        return Err("应用私有目录不允许通过该命令访问".to_string());
    }
    if !is_authorized(app, &resolved, access, extra_roots) {
        return Err(format!(
            "路径未获授权，请先在设置中添加该目录: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

/// 用户把文件拖入自有窗口，等同于对该文件的一次显式授权（与文件对话框选中同义）。
/// 登记进 fs scope 后，后续的复制 / 读取命令才能通过路径校验。
pub fn grant_dropped_paths<R: Runtime>(app: &tauri::AppHandle<R>, paths: &[PathBuf]) {
    let scope = app.fs_scope();
    for path in paths {
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let result = if canonical.is_dir() {
            scope.allow_directory(&canonical, true)
        } else {
            scope.allow_file(&canonical)
        };
        if let Err(error) = result {
            eprintln!("[path-policy] 登记拖入路径失败 {}: {error}", canonical.display());
        }
    }
}

/// 应用自身的安装目录（可执行文件所在目录），只用于“在文件管理器中定位”。
pub fn app_install_roots<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(canonical) = canonicalize_simplified(dir) {
                roots.push(canonical);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Ok(canonical) = canonicalize_simplified(&resource_dir) {
            roots.push(canonical);
        }
    }
    roots
}

/// 校验要启动的应用路径。
///
/// 该命令只服务“用 Photoshop 打开图片”，因此不接受任意可执行文件：
/// 必须是系统里已安装的应用，且不得位于应用自身可写的数据目录 ——
/// 否则被注入的 Renderer 只需先往素材目录写一个可执行文件，再调用本命令即可执行任意代码。
pub fn authorize_launch_target<R: Runtime>(
    app: &tauri::AppHandle<R>,
    app_path: &str,
) -> Result<String, String> {
    let trimmed = app_path.trim();
    if trimmed.is_empty() {
        return Err("应用路径为空".to_string());
    }
    if trimmed.contains('\0') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("应用路径包含非法字符".to_string());
    }

    let path = PathBuf::from(trimmed);
    let has_separator = trimmed.contains('/') || trimmed.contains('\\');

    // macOS 允许直接给应用名（交由 LaunchServices 在已安装应用中解析）。
    if cfg!(target_os = "macos") && !has_separator {
        return Ok(trimmed.to_string());
    }

    if !path.is_absolute() {
        return Err(format!("只接受绝对路径或已安装的应用名: {trimmed}"));
    }
    // 与 app_owned_roots 同样去掉 verbatim 前缀，否则下面的 is_within 恒不成立
    let canonical = canonicalize_simplified(&path)
        .map_err(|e| format!("应用路径不存在或无法访问（{trimmed}）: {e}"))?;

    // 关键约束：不允许启动位于应用可写目录内的程序（Renderer 可以往那里落文件）。
    if app_owned_roots(app)
        .iter()
        .any(|root| is_within(&canonical, root))
    {
        return Err(format!(
            "拒绝启动应用数据目录内的程序: {}",
            canonical.display()
        ));
    }

    if cfg!(target_os = "macos") {
        let is_app_bundle = canonical
            .components()
            .any(|component| match component {
                Component::Normal(name) => name
                    .to_str()
                    .is_some_and(|text| text.to_ascii_lowercase().ends_with(".app")),
                _ => false,
            });
        if !is_app_bundle {
            return Err(format!("只允许启动 .app 应用包: {}", canonical.display()));
        }
    } else {
        let is_executable = canonical
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
        if !is_executable || !canonical.is_file() {
            return Err(format!("只允许启动 .exe 可执行文件: {}", canonical.display()));
        }
    }

    Ok(canonical.to_string_lossy().into_owned())
}

/// 用户在设置里指定的文件保存根目录（`AppConfig.baseDataDir` 的原生侧投影）。
///
/// 只存在于本进程内存：权威值持久化在前端 AppConfig，每次启动或改动都会由
/// `sync_authorized_directories` 重新带入。需要落到用户目录的派生数据
/// （例如智能体压缩包解压目录）通过它定位，避免默认写进系统盘。
#[derive(Default)]
pub struct UserStorageRoot(pub Mutex<Option<PathBuf>>);

/// 记录用户设置的保存根目录；传入空值表示回退到应用自有目录。
///
/// 校验标准与 fs scope 授权保持一致：必须是已存在的普通目录，且不得落在应用
/// 私有子树内。校验失败时静默清空并回退，不阻断设置同步 —— 否则用户把一个
/// 暂时不可用的盘符设为保存根目录后，整个设置面板都会报错。
pub fn set_user_storage_root<R: Runtime>(app: &tauri::AppHandle<R>, raw: Option<&str>) {
    let next = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| resolve_user_storage_root(app, value));

    if let Some(state) = app.try_state::<UserStorageRoot>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = next;
        }
    }
}

fn resolve_user_storage_root<R: Runtime>(app: &tauri::AppHandle<R>, raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return None;
    }
    // 与 fs scope 授权同样拒绝符号链接：否则可用软链把「用户目录」指向凭据等私有子树。
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return None;
    }
    let resolved = canonicalize_simplified(&path).ok()?;
    let resolved_metadata = std::fs::symlink_metadata(&resolved).ok()?;
    if !resolved_metadata.is_dir() || is_link_or_reparse(&resolved_metadata) {
        return None;
    }
    if overlaps_private_app_path(app, &resolved) {
        return None;
    }
    Some(resolved)
}

/// 读取用户设置的保存根目录；未设置或当前不可用时返回 None，由调用方回退到应用自有目录。
pub fn user_storage_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.try_state::<UserStorageRoot>()?
        .0
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_inside_the_secret_dir() {
        let secret_dir = PathBuf::from("/data/app/secrets");

        assert!(is_under_secret_dir(&secret_dir, &secret_dir));
        assert!(is_under_secret_dir(
            &secret_dir,
            Path::new("/data/app/secrets/credentials.json"),
        ));
        // 同级目录不能被误判，否则会挡掉正常的项目素材路径
        assert!(!is_under_secret_dir(&secret_dir, Path::new("/data/app/projects/a.png")));
        assert!(!is_under_secret_dir(&secret_dir, Path::new("/data/app/secrets-backup/x")));
    }

    #[test]
    fn agent_private_directory_helper_rejects_only_its_own_subtree() {
        let private_dir = PathBuf::from("/data/app/agent-private");
        assert!(crate::agent_package::is_under_agent_private_dir(
            &private_dir,
            Path::new("/data/app/agent-private/sources.json"),
        ));
        assert!(!crate::agent_package::is_under_agent_private_dir(
            &private_dir,
            Path::new("/data/app/agent-private-copy/sources.json"),
        ));
    }

    #[test]
    fn rejects_relative_and_empty_paths() {
        assert!(resolve_path("", PathAccess::Read).is_err());
        assert!(resolve_path("relative/file.png", PathAccess::Read).is_err());
        assert!(resolve_path("/tmp/with\0nul", PathAccess::Read).is_err());
    }

    #[test]
    fn resolves_existing_path_and_strips_traversal() {
        let dir = std::env::temp_dir().canonicalize().expect("临时目录可解析");
        let nested = dir.join("ai-canvas-path-policy-test");
        std::fs::create_dir_all(&nested).expect("创建测试目录");
        let traversal = nested.join("..").join("ai-canvas-path-policy-test");

        let resolved = resolve_path(&traversal.to_string_lossy(), PathAccess::Read)
            .expect("含 .. 的已存在路径应可解析");
        assert_eq!(
            resolved,
            simplify_verbatim(nested.canonicalize().expect("目录可解析")),
        );

        std::fs::remove_dir_all(&nested).ok();
    }

    /// 返回给前端的路径不能带 `\\?\`：前端靠前缀比较判断文件是否在项目目录内，
    /// 带前缀会让改名同步、分组搬运、相对路径索引全部静默失效。
    #[test]
    fn resolved_paths_never_keep_the_verbatim_prefix() {
        let dir = std::env::temp_dir();
        let existing = resolve_path(&dir.to_string_lossy(), PathAccess::Read).expect("临时目录可解析");
        let missing = resolve_path(
            &dir.join("ai-canvas-verbatim-probe.bin").to_string_lossy(),
            PathAccess::Write,
        )
        .expect("父目录存在时应可解析");

        for path in [existing, missing] {
            assert!(
                !path.to_string_lossy().starts_with(r"\\?\"),
                "路径仍带 verbatim 前缀: {}",
                path.display(),
            );
        }
    }

    #[test]
    fn write_access_accepts_missing_file_but_needs_existing_parent() {
        let dir = std::env::temp_dir().canonicalize().expect("临时目录可解析");
        let missing = dir.join("ai-canvas-missing-file.bin");
        std::fs::remove_file(&missing).ok();

        let resolved = resolve_path(&missing.to_string_lossy(), PathAccess::Write)
            .expect("父目录存在时应可解析");
        assert_eq!(resolved.file_name(), missing.file_name());
        assert!(resolve_path(&missing.to_string_lossy(), PathAccess::Read).is_err());

        let nested_missing = dir.join("ai-canvas-missing-dir").join("file.bin");
        assert!(resolve_path(&nested_missing.to_string_lossy(), PathAccess::Write).is_err());
    }
}
