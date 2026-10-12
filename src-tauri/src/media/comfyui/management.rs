//! 本地 ComfyUI 内核与 custom_nodes 管理。路径只由主窗口登记，管理窗口只接受对象 ID。
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use url::Url;

#[cfg(windows)]
use std::os::windows::{io::AsRawHandle, process::CommandExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const WINDOW_LABEL: &str = "comfyui-settings";
const DISABLED_SUFFIX: &str = ".disabled";
const REMOVED_DIR: &str = ".ai-canvas-removed.disabled";
const CATALOG_URL: &str = "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json";
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_CATALOG: u64 = 8 * 1024 * 1024;
static OPERATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) async fn lock_operations() -> tokio::sync::MutexGuard<'static, ()> {
    OPERATION_LOCK.lock().await
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagementUiContext {
    appearance: Option<serde_json::Value>,
    language: Option<String>,
    native_cursor: bool,
}

fn sanitize_ui_context(mut context: ManagementUiContext) -> Result<ManagementUiContext, String> {
    if context.language.as_ref().is_some_and(|value| value.len() > 64 || value.chars().any(char::is_control)) {
        return Err("管理窗口语言数据无效".into());
    }
    if let Some(appearance) = context.appearance.as_mut() {
        let object = appearance.as_object_mut().ok_or_else(|| "管理窗口外观数据无效".to_string())?;
        let top_keys = ["schemaVersion", "id", "name", "builtin", "mode", "ui", "canvas", "node", "edge", "handle", "motion", "createdAt", "updatedAt"];
        object.retain(|key, _| top_keys.contains(&key.as_str()));
        for (section, keys) in [
            ("ui", &["background", "surface", "card", "hover", "border", "text", "textSecondary", "textMuted", "accent", "accentStrong", "accentSoft", "focus", "success", "warning", "danger", "info", "radius", "shadowOpacity", "glassOpacity", "glassBlur", "scrollbar", "scrollbarHover"][..]),
            ("canvas", &["kind", "color", "imageFit", "imagePosition", "imageOpacity", "gridVisible", "gridColor", "gridSize"][..]),
            ("node", &["background", "backgroundOpacity", "border", "borderWidth", "radius", "shadow", "headerBackground", "selectedBorder", "selectedGlow", "text", "handleColor"][..]),
            ("edge", &["color", "width", "selectedColor", "selectedWidth", "flowColor", "previewColor", "animationEnabled"][..]),
            ("handle", &["kind", "color", "hoverColor", "size", "imageFit", "opacity"][..]),
            ("motion", &["enabled", "scale"][..]),
        ] {
            if let Some(section) = object.get_mut(section) {
                let section = section.as_object_mut().ok_or_else(|| "管理窗口外观分区无效".to_string())?;
                section.retain(|key, value| keys.contains(&key.as_str()) && !value.is_object() && !value.is_array());
            }
        }
        for (key, value) in object.iter() {
            if !["ui", "canvas", "node", "edge", "handle", "motion"].contains(&key.as_str()) && (value.is_object() || value.is_array()) {
                return Err("管理窗口外观标识无效".into());
            }
        }
    }
    if serde_json::to_vec(&context).map_err(|_| "外观数据无效".to_string())?.len() > 64 * 1024 {
        return Err("管理窗口外观数据超过限制".into());
    }
    Ok(context)
}

#[derive(Clone)]
struct ManagementSession {
    installation_root: PathBuf,
    source_root: PathBuf,
    origin: Url,
    ui_context: ManagementUiContext,
    git_program: PathBuf,
}

#[derive(Default)]
pub struct ManagementState(Mutex<Option<ManagementSession>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    id: String,
    name: String,
    enabled: bool,
    removed: bool,
    is_git: bool,
    remote_url: Option<String>,
    branch: Option<String>,
    commit: Option<String>,
    commit_date: Option<String>,
    dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    reference: String,
    commit: String,
    title: String,
    date: String,
    kind: String,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    installation_name: String,
    git_available: bool,
    core: Option<Repository>,
    extensions: Vec<Repository>,
    warnings: Vec<String>,
    ui_context: ManagementUiContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAction {
    repository_id: String,
    action: String,
    reference: Option<String>,
}

#[derive(Serialize)]
pub struct ManagementResult {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    id: String,
    name: String,
    description: String,
    repository_url: String,
    installed: bool,
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn current_session(app: &tauri::AppHandle) -> Result<ManagementSession, String> {
    app.state::<ManagementState>().0.lock()
        .map_err(|_| "ComfyUI 管理会话不可用".to_string())?
        .clone().ok_or_else(|| "请从主窗口重新打开 ComfyUI 设置".to_string())
}

pub(super) fn ensure_management_caller(webview: &Webview, app: &tauri::AppHandle) -> Result<(), String> {
    let session = current_session(app)?;
    let current = webview.url().map_err(|_| "无法确认管理窗口来源".to_string())?;
    if webview.label() != WINDOW_LABEL || !same_origin(&current, &session.origin)
        || !matches!(current.path(), "/" | "/index.html")
        || !current.query_pairs().any(|(key, value)| key == "view" && value == "comfyui-settings")
    {
        return Err("该命令只允许由本地 ComfyUI 设置窗口调用".into());
    }
    Ok(())
}

pub(super) fn management_root(webview: &Webview, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    ensure_management_caller(webview, app)?;
    let session = current_session(app)?;
    let installation = authorized_installation_root(app)?;
    let root = crate::path_policy::reauthorize_existing_plain_directory_with_roots(app, &session.source_root, std::slice::from_ref(&installation))?;
    if root != session.source_root || !root.starts_with(&installation) {
        return Err("ComfyUI 安装目录已变化，请重新打开设置".into());
    }
    Ok(root)
}

fn authorized_installation_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let session = current_session(app)?;
    let root = super::installation::reauthorize_installation(app, &session.installation_root)?;
    if root != session.installation_root {
        return Err("ComfyUI 安装目录已变化，请重新打开设置".into());
    }
    Ok(root)
}

fn plain_directory(app: &tauri::AppHandle, path: &Path, parent: &Path) -> Result<PathBuf, String> {
    let installation = authorized_installation_root(app)?;
    let resolved = crate::path_policy::reauthorize_existing_plain_directory_with_roots(app, path, std::slice::from_ref(&installation))?;
    if !resolved.starts_with(parent) || resolved == parent {
        return Err("ComfyUI 子目录已离开授权安装目录".into());
    }
    Ok(resolved)
}

fn plain_file(app: &tauri::AppHandle, path: &Path) -> Result<PathBuf, String> {
    let installation = authorized_installation_root(app)?;
    let resolved = crate::path_policy::authorize_existing_plain_file_with_roots(app, &path.to_string_lossy(), std::slice::from_ref(&installation))?;
    if !resolved.starts_with(&installation) {
        return Err("ComfyUI 文件已离开授权安装目录".into());
    }
    Ok(resolved)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 180 && !name.starts_with('.') && name != "core"
        && !name.ends_with(['.', ' ']) && !name.contains(['/', '\\', ':', '\0'])
        && !name.chars().any(char::is_control)
}

fn extension_path(app: &tauri::AppHandle, root: &Path, id: &str) -> Result<(PathBuf, bool, bool), String> {
    if !valid_name(id) { return Err("扩展标识无效".into()); }
    let nodes = plain_directory(app, &root.join("custom_nodes"), root)?;
    let candidates = [
        (nodes.join(id), true, false),
        (nodes.join(format!("{id}{DISABLED_SUFFIX}")), false, false),
        (nodes.join(REMOVED_DIR).join(id), false, true),
    ];
    let found: Vec<_> = candidates.into_iter().filter(|(path, _, _)| path.exists()).collect();
    if found.len() != 1 { return Err("扩展目录不存在或存在重名冲突".into()); }
    let (path, enabled, removed) = found.into_iter().next().unwrap();
    Ok((plain_directory(app, &path, &nodes)?, enabled, removed))
}

fn repository_path(app: &tauri::AppHandle, root: &Path, id: &str) -> Result<PathBuf, String> {
    if id == "core" { return Ok(root.to_path_buf()); }
    Ok(extension_path(app, root, id)?.0)
}

/// 每次 Git 调用屏蔽 hooks、交互、外部协议、全局配置与 smudge filter。
fn git_command(app: &tauri::AppHandle, path: &Path) -> Result<Command, String> {
    let program = current_session(app)?.git_program;
    if program.is_absolute() && plain_file(app, &program)? != program {
        return Err("ComfyUI Git 程序已变化，请重新打开设置".into());
    }
    let mut command = Command::new(program);
    command.current_dir(path).args([
        "-c", if cfg!(windows) { "core.hooksPath=NUL" } else { "core.hooksPath=/dev/null" },
        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
        "-c", "credential.helper=", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
        "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false",
        "-c", "http.followRedirects=false", "-c", "http.sslVerify=true",
    ]).env("GIT_TERMINAL_PROMPT", "0").env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_LFS_SKIP_SMUDGE", "1").env_remove("GIT_DIR").env_remove("GIT_WORK_TREE")
        .env_remove("GIT_CONFIG_COUNT").env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_SSH").env_remove("GIT_SSH_COMMAND").env_remove("GIT_EXEC_PATH")
        .env_remove("GIT_OBJECT_DIRECTORY").env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_COMMON_DIR").env_remove("GIT_INDEX_FILE").env_remove("GIT_NAMESPACE");
    Ok(command)
}

#[cfg(windows)]
struct ProcessJob(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &std::process::Child) -> Result<Self, String> {
        use windows::{core::PCWSTR, Win32::{Foundation::HANDLE, System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        }}};
        let job = Self(unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|_| "无法创建 ComfyUI 管理进程边界".to_string())?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) }
            .map_err(|_| "无法配置 ComfyUI 管理进程边界".to_string())?;
        unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }
            .map_err(|_| "无法绑定 ComfyUI 管理进程".to_string())?;
        Ok(job)
    }
    fn terminate(&self) { unsafe { let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1223); } }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) { unsafe { let _ = windows::Win32::Foundation::CloseHandle(self.0); } }
}

fn run_command(app: &tauri::AppHandle, mut command: Command, timeout: Duration) -> Result<String, String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(super::CREATE_NO_WINDOW);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "无法启动管理命令，请确认 Git / Python 已安装".to_string())?;
    #[cfg(windows)]
    let job = match ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
    };
    let stdout = child.stdout.take().ok_or_else(|| "无法读取管理结果".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "无法读取管理状态".to_string())?;
    let read = |pipe: Box<dyn Read + Send>| std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.take((MAX_OUTPUT + 1) as u64).read_to_end(&mut bytes);
        bytes
    });
    let output_reader = read(Box::new(stdout));
    let error_reader = read(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline && current_session(app).is_ok() => std::thread::sleep(Duration::from_millis(40)),
            _ => break None,
        }
    };
    // 退出或超时都回收整个管理进程树，避免管道由子进程持有。
    #[cfg(windows)]
    job.terminate();
    #[cfg(unix)]
    unsafe {
        unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
        if let Ok(pid) = i32::try_from(child.id()) { let _ = kill(-pid, 9); }
    }
    if status.is_none() { let _ = child.kill(); let _ = child.wait(); }
    let output = output_reader.join().unwrap_or_default();
    let errors = error_reader.join().unwrap_or_default();
    let status = status.ok_or_else(|| "管理操作超时；请刷新列表确认实际状态后再决定是否重试".to_string())?;
    if output.len() > MAX_OUTPUT || errors.len() > MAX_OUTPUT { return Err("管理命令输出超过限制".into()); }
    if !status.success() {
        // 原始 Git / pip 输出可能包含凭据、路径或文件正文，不回传 Renderer 日志。
        return Err("管理命令未完成，请检查网络、仓库权限或本地环境；刷新列表确认当前状态".into());
    }
    String::from_utf8(output).map_err(|_| "管理命令返回了无效 UTF-8 数据".into())
}

fn git(app: &tauri::AppHandle, path: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = git_command(app, path)?;
    command.args(args);
    run_command(app, command, Duration::from_secs(30))
}

fn safe_repository_url(raw: &str) -> Result<String, String> {
    if raw.len() > 2048 { return Err("仓库 URL 过长".into()); }
    let url = Url::parse(raw.trim()).map_err(|_| "仓库 URL 无效".to_string())?;
    let allowed = matches!(url.host_str(), Some("github.com" | "gitlab.com" | "gitee.com" | "jihulab.com"));
    if url.scheme() != "https" || !allowed || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some() || url.query().is_some() || url.fragment().is_some()
    { return Err("仅支持 GitHub、GitLab、Gitee 或极狐上的无凭据 HTTPS 仓库地址".into()); }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if parts.len() < 2 || parts.iter().any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))) {
        return Err("请输入仓库主页 HTTPS 地址".into());
    }
    Ok(format!("https://{}/{}", url.host_str().unwrap(), parts.join("/")))
}

/// GitHub 改名仓库会跳转；先由宿主检查有界 HTTPS 跳转，再让 Git 使用最终地址。
fn resolve_repository_url(raw: &str) -> Result<String, String> {
    let url = safe_repository_url(raw)?;
    let discovery = format!("{}.git/info/refs?service=git-upload-pack", url.trim_end_matches(".git"));
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() >= 5 || url.scheme() != "https"
                || !matches!(url.host_str(), Some("github.com" | "gitlab.com" | "gitee.com" | "jihulab.com"))
                || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
            { attempt.error("仓库跳转离开受支持的 HTTPS 代码托管站点") } else { attempt.follow() }
        }))
        .build().map_err(|_| "无法建立仓库连接".to_string())?;
    let response = client.get(discovery).send().and_then(|response| response.error_for_status())
        .map_err(|_| "无法访问仓库，请检查仓库地址、权限和网络".to_string())?;
    let mut resolved = response.url().clone();
    let path = resolved.path().strip_suffix("/info/refs").ok_or_else(|| "仓库返回了非 Git 地址".to_string())?.to_string();
    resolved.set_path(&path);
    resolved.set_query(None);
    resolved.set_fragment(None);
    safe_repository_url(resolved.as_str())
}

fn ensure_repository(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    // 只管理独立 .git 目录，拒绝指向其他工作树的 .git 文件与符号链接。
    let git_root = plain_directory(app, &path.join(".git"), path)?;
    if git_root.join("commondir").exists() || git_root.join("objects/info/alternates").exists() {
        return Err("不支持共享 Git 工作树或外部对象目录，请用原启动器处理该仓库".into());
    }
    for directory in ["objects", "refs"] {
        plain_directory(app, &git_root.join(directory), &git_root)?;
    }
    let config_path = plain_file(app, &path.join(".git/config"))?;
    let mut configuration = String::new();
    std::fs::File::open(config_path).map_err(|_| "无法读取仓库配置".to_string())?
        .take(64 * 1024 + 1).read_to_string(&mut configuration).map_err(|_| "仓库配置不是有效 UTF-8".to_string())?;
    if configuration.len() > 64 * 1024 || configuration.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        let Some(section) = line.strip_prefix('[').map(str::trim_start) else { return false; };
        section.starts_with("filter") || section.starts_with("url") || section.starts_with("include")
    }) { return Err("仓库含自定义 Git filter、URL 改写或外部配置，请用原启动器处理该仓库".into()); }
    let top = git(app, path, &["rev-parse", "--show-toplevel"])?;
    let installation = authorized_installation_root(app)?;
    let canonical = crate::path_policy::reauthorize_existing_plain_directory_with_roots(app, Path::new(top.trim()), std::slice::from_ref(&installation))?;
    if canonical != path { return Err("该目录不是独立 Git 仓库".into()); }
    // 本地仓库的 smudge/clean filter 是任意命令，不在管理操作中执行。
    Ok(())
}

fn inspect_repository(app: &tauri::AppHandle, path: &Path, id: &str, enabled: bool, removed: bool, git_available: bool) -> Repository {
    let mut repository = Repository {
        id: id.into(), name: if id == "core" { "ComfyUI 内核".into() } else { id.into() },
        enabled, removed, is_git: false, remote_url: None, branch: None, commit: None, commit_date: None, dirty: false,
    };
    if !git_available || ensure_repository(app, path).is_err() { return repository; }
    repository.is_git = true;
    repository.remote_url = git(app, path, &["remote", "get-url", "origin"]).ok().and_then(|url| safe_repository_url(url.trim()).ok());
    repository.branch = git(app, path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().into());
    repository.commit = git(app, path, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().into());
    repository.commit_date = git(app, path, &["show", "-s", "--format=%cI", "HEAD"]).ok().map(|s| s.trim().into());
    repository.dirty = git(app, path, &["status", "--porcelain", "--untracked-files=no"]).map_or(true, |s| !s.trim().is_empty());
    repository
}

fn extension_ids(app: &tauri::AppHandle, root: &Path) -> Result<Vec<String>, String> {
    let nodes = plain_directory(app, &root.join("custom_nodes"), root)?;
    let mut ids = HashSet::new();
    for (folder, removed) in [(nodes.clone(), false), (nodes.join(REMOVED_DIR), true)] {
        if !folder.exists() { continue; }
        if removed { plain_directory(app, &folder, &nodes)?; }
        for entry in std::fs::read_dir(folder).map_err(|_| "无法读取 custom_nodes 目录".to_string())?.take(2000) {
            let entry = entry.map_err(|_| "无法读取扩展目录".to_string())?;
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) { continue; }
            let raw = entry.file_name().to_string_lossy().into_owned();
            let name = raw.strip_suffix(DISABLED_SUFFIX).unwrap_or(&raw);
            if valid_name(name) && name != "__pycache__" { ids.insert(name.to_string()); }
        }
    }
    let mut ids: Vec<_> = ids.into_iter().collect();
    ids.sort_by_key(|name| name.to_lowercase());
    Ok(ids)
}

fn snapshot(app: &tauri::AppHandle, root: &Path) -> Result<Snapshot, String> {
    let session = current_session(app)?;
    let git_available = git(app, root, &["--version"]).is_ok();
    let core = Some(inspect_repository(app, root, "core", true, false, git_available));
    let mut extensions = Vec::new();
    let mut warnings = Vec::new();
    if !git_available { warnings.push("未检测到可用 Git；仍可启停或恢复普通扩展目录。".into()); }
    for id in extension_ids(app, root)? {
        match extension_path(app, root, &id) {
            Ok((path, enabled, removed)) => extensions.push(inspect_repository(app, &path, &id, enabled, removed, git_available)),
            Err(error) => warnings.push(format!("扩展 {id} 已跳过：{error}。")),
        }
    }
    Ok(Snapshot {
        installation_name: session.installation_root.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        git_available, core, extensions, warnings, ui_context: session.ui_context,
    })
}

fn assert_server_stopped(app: &tauri::AppHandle) -> Result<(), String> {
    let ports: HashSet<u16> = [8188, super::launch_settings::configured_port(app)?, super::launch_settings::last_launch_port().unwrap_or(0)]
        .into_iter().filter(|port| *port > 0).collect();
    for port in ports {
        if std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok() {
            return Err("ComfyUI 服务仍在运行，请先关闭启动终端，再修改内核或扩展".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn open_comfyui_settings_window(webview: Webview, app: tauri::AppHandle, comfy_path: String, ui_context: ManagementUiContext) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("ComfyUI 设置只能由主窗口打开".into()); }
    let ui_context = sanitize_ui_context(ui_context)?;
    let _guard = OPERATION_LOCK.lock().await;
    let installation_root = super::installation::authorize_installation(&app, &comfy_path).await?;
    let source = super::find_main_py(&installation_root).ok_or_else(|| "未找到 ComfyUI main.py，请选择安装根目录".to_string())?;
    let source_root = crate::path_policy::reauthorize_existing_plain_directory_with_roots(&app, &source, std::slice::from_ref(&installation_root))
        .map_err(|_| "ComfyUI 源码目录未获授权，请改选包含源码的安装基目录".to_string())?;
    if !source_root.starts_with(&installation_root) {
        return Err("ComfyUI 源码目录不在安装根内，请改选包含源码的安装基目录".into());
    }
    let origin = webview.url().map_err(|_| "无法确认主窗口来源".to_string())?;
    let git_program = [installation_root.join("git/cmd/git.exe"), installation_root.join("git/bin/git.exe"),
        installation_root.join("git/mingw64/bin/git.exe"), installation_root.join("tools/git/bin/git.exe")]
        .into_iter().find_map(|candidate| crate::path_policy::authorize_existing_plain_file_with_roots(&app, &candidate.to_string_lossy(), std::slice::from_ref(&installation_root)).ok()
            .filter(|resolved| resolved.starts_with(&installation_root)))
        .unwrap_or_else(|| PathBuf::from("git"));
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if current_session(&app)?.source_root != source_root {
            return Err("已打开其他安装目录的设置，请先关闭该设置窗口".into());
        }
        window.show().map_err(|_| "无法显示设置窗口".to_string())?;
        window.set_focus().map_err(|_| "无法聚焦设置窗口".to_string())?;
        return Ok(());
    }
    *app.state::<ManagementState>().0.lock().map_err(|_| "管理会话不可用".to_string())? = Some(ManagementSession {
        installation_root, source_root, origin: origin.clone(), ui_context, git_program,
    });
    let result = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App("index.html?view=comfyui-settings".into()))
        .title("ComfyUI 设置与管理").inner_size(1120.0, 760.0).min_inner_size(860.0, 600.0)
        .decorations(true).resizable(true).center()
        .on_navigation(move |url| same_origin(url, &origin) && matches!(url.path(), "/" | "/index.html"))
        .build();
    match result {
        Ok(window) => {
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Ok(mut state) = handle.state::<ManagementState>().0.lock() { *state = None; }
                }
            });
            Ok(())
        }
        Err(_) => {
            if let Ok(mut state) = app.state::<ManagementState>().0.lock() { *state = None; }
            Err("无法创建 ComfyUI 设置窗口".into())
        }
    }
}

#[tauri::command]
pub async fn get_comfyui_management_snapshot(webview: Webview, app: tauri::AppHandle) -> Result<Snapshot, String> {
    let _guard = OPERATION_LOCK.lock().await;
    let root = management_root(&webview, &app)?;
    tauri::async_runtime::spawn_blocking(move || snapshot(&app, &root)).await.map_err(|_| "读取管理状态失败".to_string())?
}

fn fetch_origin(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    ensure_repository(app, path)?;
    let url = resolve_repository_url(git(app, path, &["remote", "get-url", "origin"])?.trim())?;
    let mut command = git_command(app, path)?;
    // 使用经过校验的 URL，而不是仓库中的 remote.*.pushurl / 上传命令。
    command.args(["fetch", "--no-recurse-submodules", "--tags", &url, "+refs/heads/*:refs/remotes/origin/*"]);
    run_command(app, command, Duration::from_secs(180))?;
    Ok(())
}

fn versions(app: &tauri::AppHandle, path: &Path) -> Result<Vec<Version>, String> {
    ensure_repository(app, path)?;
    let head = git(app, path, &["rev-parse", "HEAD"])?;
    let attached_branch = git(app, path, &["symbolic-ref", "--quiet", "HEAD"]).ok().map(|value| value.trim().to_string());
    let mut versions = Vec::new();
    let refs = git(app, path, &["for-each-ref", "--sort=-creatordate", "--count=300", "--format=%(refname)%09%(creatordate:iso-strict)%09%(objectname)%09%(*objectname)%09%(objecttype)%09%(*objecttype)", "refs/tags", "refs/heads", "refs/remotes/origin"])?;
    for line in refs.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 6 { continue; }
        let reference = fields[0];
        let date = fields[1];
        if reference.ends_with("/HEAD") { continue; }
        let commit = if fields[4] == "commit" { fields[2] } else if fields[5] == "commit" { fields[3] } else { continue; }.to_string();
        if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) { continue; }
        let kind = if reference.starts_with("refs/tags/") { "tag" } else { "branch" };
        let title = reference.trim_start_matches("refs/tags/").trim_start_matches("refs/heads/").trim_start_matches("refs/remotes/").to_string();
        let same_commit = commit == head.trim();
        let current = if kind == "tag" {
            attached_branch.is_none() && same_commit
        } else {
            attached_branch.as_ref().is_some_and(|branch| same_commit && (branch == reference
                || reference.strip_prefix("refs/remotes/origin/").is_some_and(|remote| branch == &format!("refs/heads/{remote}"))))
        };
        versions.push(Version { reference: reference.into(), current, commit, title, date: date.into(), kind: kind.into() });
    }
    for line in git(app, path, &["log", "--all", "-n", "100", "--format=%H%x09%cI%x09%s"])?.lines() {
        let parts: Vec<_> = line.splitn(3, '\t').collect();
        if parts.len() != 3 { continue; }
        versions.push(Version { reference: parts[0].into(), commit: parts[0].into(), title: parts[2].chars().take(200).collect(), date: parts[1].into(), kind: "commit".into(), current: attached_branch.is_none() && parts[0] == head.trim() });
    }
    Ok(versions)
}

#[tauri::command]
pub async fn list_comfyui_versions(webview: Webview, app: tauri::AppHandle, repository_id: String, refresh: bool) -> Result<Vec<Version>, String> {
    let _guard = OPERATION_LOCK.lock().await;
    let root = management_root(&webview, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = repository_path(&app, &root, &repository_id)?;
        if refresh { fetch_origin(&app, &path)?; }
        versions(&app, &path)
    }).await.map_err(|_| "读取版本列表失败".to_string())?
}

fn ensure_clean(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    ensure_repository(app, path)?;
    if !git(app, path, &["status", "--porcelain", "--untracked-files=no"])?.trim().is_empty() {
        return Err("仓库的已跟踪文件存在本地修改，请先自行备份并处理；管理器不会覆盖这些修改".into());
    }
    Ok(())
}

fn rename_extension(app: &tauri::AppHandle, root: &Path, id: &str, action: &str) -> Result<(), String> {
    let (path, enabled, removed) = extension_path(app, root, id)?;
    let nodes = plain_directory(app, &root.join("custom_nodes"), root)?;
    let target = match action {
        "enable" if !enabled && !removed => nodes.join(id),
        "disable" if enabled && !removed => nodes.join(format!("{id}{DISABLED_SUFFIX}")),
        "uninstall" if !removed => {
            let trash = nodes.join(REMOVED_DIR);
            if !trash.exists() { std::fs::create_dir(&trash).map_err(|_| "无法创建扩展恢复目录".to_string())?; }
            plain_directory(app, &trash, &nodes)?.join(id)
        }
        "restore" if removed => nodes.join(format!("{id}{DISABLED_SUFFIX}")),
        _ => return Err("扩展状态已变化，请刷新后重试".into()),
    };
    if target.exists() { return Err("目标目录已存在，不能覆盖同名扩展".into()); }
    let installation = authorized_installation_root(app)?;
    let resolved_target = crate::path_policy::authorize_path_with_roots(app, &target.to_string_lossy(), crate::path_policy::PathAccess::Write, std::slice::from_ref(&installation))
        .map_err(|_| "扩展恢复目标目录未获授权".to_string())?;
    if !resolved_target.starts_with(&nodes) || resolved_target == nodes {
        return Err("扩展目标目录已离开 custom_nodes".into());
    }
    std::fs::rename(path, target).map_err(|_| "扩展目录移动失败，请检查文件占用和目录权限".to_string())
}

fn valid_branch(branch: &str) -> bool {
    !branch.is_empty() && branch.len() <= 512 && !branch.starts_with('-')
        && !branch.chars().any(char::is_control)
}

#[tauri::command]
pub async fn apply_comfyui_repository_action(webview: Webview, app: tauri::AppHandle, request: RepositoryAction) -> Result<ManagementResult, String> {
    let _guard = OPERATION_LOCK.lock().await;
    let root = management_root(&webview, &app)?;
    assert_server_stopped(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = repository_path(&app, &root, &request.repository_id)?;
        assert_server_stopped(&app)?;
        match request.action.as_str() {
            "enable" | "disable" | "uninstall" | "restore" if request.repository_id != "core" => rename_extension(&app, &root, &request.repository_id, &request.action)?,
            "update" => {
                ensure_clean(&app, &path)?;
                let branch = git(&app, &path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                    .map_err(|_| "当前处于固定版本，请先切换到分支再更新".to_string())?;
                if !valid_branch(branch.trim()) { return Err("仓库分支名无效".into()); }
                fetch_origin(&app, &path)?;
                let reference = format!("refs/remotes/origin/{}", branch.trim());
                if !versions(&app, &path)?.iter().any(|v| v.reference == reference) { return Err("远端不存在当前分支".into()); }
                assert_server_stopped(&app)?;
                git(&app, &path, &["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", &reference])?;
            }
            "switch" => {
                ensure_clean(&app, &path)?;
                let requested = request.reference.as_deref().ok_or_else(|| "请选择版本".to_string())?;
                let version = versions(&app, &path)?.into_iter().find(|v| v.reference == requested)
                    .ok_or_else(|| "目标版本不在当前列表，请刷新版本列表".to_string())?;
                assert_server_stopped(&app)?;
                if let Some(branch) = version.reference.strip_prefix("refs/heads/") {
                    if !valid_branch(branch) { return Err("仓库分支名无效".into()); }
                    git(&app, &path, &["checkout", "--no-overwrite-ignore", branch, "--"])?;
                } else if let Some(branch) = version.reference.strip_prefix("refs/remotes/origin/") {
                    if !valid_branch(branch) { return Err("仓库分支名无效".into()); }
                    let local = format!("refs/heads/{branch}");
                    if versions(&app, &path)?.iter().any(|v| v.reference == local) {
                        git(&app, &path, &["merge-base", "--is-ancestor", &local, &version.reference])
                            .map_err(|_| "本地分支有远端未包含的提交，请选择本地分支；管理器不会回退或覆盖这些提交".to_string())?;
                        git(&app, &path, &["checkout", "--no-overwrite-ignore", branch, "--"])?;
                        git(&app, &path, &["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", &version.reference])?;
                    } else {
                        git(&app, &path, &["checkout", "--no-overwrite-ignore", "-b", branch, "--track", &version.reference])?;
                    }
                } else {
                    if version.commit.len() != 40 || !version.commit.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("版本提交标识无效".into()); }
                    git(&app, &path, &["checkout", "--no-overwrite-ignore", "--detach", &version.commit, "--"])?;
                }
            }
            _ => return Err("不支持的管理操作".into()),
        }
        Ok(ManagementResult { message: if request.action == "uninstall" {
            "扩展已移入恢复目录，可在扩展列表恢复为停用状态。".into()
        } else { "操作完成，请重新启动 ComfyUI 使改动生效；版本变化后可单独安装依赖。".into() } })
    }).await.map_err(|_| "管理操作失败，请刷新列表确认实际状态".to_string())?
}

#[tauri::command]
pub async fn list_comfyui_catalog(webview: Webview, app: tauri::AppHandle) -> Result<Vec<CatalogEntry>, String> {
    let _guard = OPERATION_LOCK.lock().await;
    let root = management_root(&webview, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let installed: HashSet<_> = snapshot(&app, &root)?.extensions.into_iter().filter(|repository| !repository.removed)
            .filter_map(|repository| repository.remote_url).map(|url| url.trim_end_matches(".git").to_lowercase()).collect();
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "无法建立扩展目录连接".to_string())?;
        let response = client.get(CATALOG_URL).send().and_then(|response| response.error_for_status())
            .map_err(|_| "无法读取 ComfyUI Manager 官方目录，请检查网络后重试".to_string())?;
        if response.content_length().is_some_and(|size| size > MAX_CATALOG) { return Err("扩展目录超过体积上限".into()); }
        let mut bytes = Vec::new();
        response.take(MAX_CATALOG + 1).read_to_end(&mut bytes).map_err(|_| "读取扩展目录失败".to_string())?;
        if bytes.len() as u64 > MAX_CATALOG { return Err("扩展目录超过体积上限".into()); }
        let catalog: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "官方扩展目录格式无效".to_string())?;
        let entries = catalog.get("custom_nodes").and_then(|value| value.as_array()).ok_or_else(|| "官方扩展目录格式无效".to_string())?;
        let mut result = Vec::new();
        for entry in entries.iter().take(20_000) {
            if entry.get("install_type").and_then(|value| value.as_str()) != Some("git-clone") { continue; }
            let Some(files) = entry.get("files").and_then(|value| value.as_array()).filter(|files| files.len() == 1) else { continue; };
            let Some(url) = files[0].as_str().and_then(|raw| safe_repository_url(raw).ok()) else { continue; };
            result.push(CatalogEntry {
                id: url.clone(), name: entry.get("title").and_then(|v| v.as_str()).unwrap_or("未命名扩展").chars().take(180).collect(),
                description: entry.get("description").and_then(|v| v.as_str()).unwrap_or("").chars().take(1500).collect(),
                installed: installed.contains(&url.trim_end_matches(".git").to_lowercase()), repository_url: url,
            });
        }
        Ok(result)
    }).await.map_err(|_| "读取扩展目录失败".to_string())?
}

#[tauri::command]
pub async fn install_comfyui_extension(webview: Webview, app: tauri::AppHandle, repository_url: String) -> Result<ManagementResult, String> {
    let _guard = OPERATION_LOCK.lock().await;
    let root = management_root(&webview, &app)?;
    assert_server_stopped(&app)?;
    let url = safe_repository_url(&repository_url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = resolve_repository_url(&url)?;
        let parsed = Url::parse(&url).map_err(|_| "仓库 URL 无效".to_string())?;
        let name = parsed.path_segments().and_then(|segments| segments.last()).unwrap_or("").trim_end_matches(".git");
        if !valid_name(name) { return Err("仓库名不适合作为扩展目录".into()); }
        let nodes = plain_directory(&app, &root.join("custom_nodes"), &root)?;
        if [nodes.join(name), nodes.join(format!("{name}{DISABLED_SUFFIX}")), nodes.join(REMOVED_DIR).join(name)].iter().any(|path| path.exists()) {
            return Err("该扩展的目录已存在，请在扩展列表管理或恢复".into());
        }
        // 固定停用目录暂存，失败保留现场，不递归删除或自动重复安装。
        let target_name = format!("{name}{DISABLED_SUFFIX}");
        assert_server_stopped(&app)?;
        let mut command = git_command(&app, &nodes)?;
        command.args(["clone", "--no-recurse-submodules", "--template=", "--", &url, &target_name]);
        run_command(&app, command, Duration::from_secs(240))?;
        let staged = plain_directory(&app, &nodes.join(&target_name), &nodes)?;
        ensure_repository(&app, &staged)?;
        Ok(ManagementResult { message: "扩展已下载并保持停用。请按需安装依赖，再启用并重启 ComfyUI；不会自动运行 install.py。".into() })
    }).await.map_err(|_| "安装操作失败，请刷新列表确认目录状态".to_string())?
}

#[tauri::command]
pub async fn install_comfyui_dependencies(webview: Webview, app: tauri::AppHandle, repository_id: String) -> Result<ManagementResult, String> {
    let _guard = OPERATION_LOCK.lock().await;
    management_root(&webview, &app)?;
    assert_server_stopped(&app)?;
    let approval_app = app.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || approval_app.dialog()
        .message("安装 requirements.txt 会下载 Python 软件包，软件包构建可能执行第三方代码，并修改当前 ComfyUI Python 环境。请确认信任该内核或扩展；建议事先备份环境。此操作不运行 install.py。")
        .title("安装 ComfyUI 依赖？").kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("信任并安装依赖".into(), "取消".into())).blocking_show())
        .await.map_err(|_| "无法显示依赖安装确认".to_string())?;
    if !approved { return Err("已取消依赖安装".into()); }
    let root = management_root(&webview, &app)?;
    assert_server_stopped(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = repository_path(&app, &root, &repository_id)?;
        let requirements = path.join("requirements.txt");
        plain_file(&app, &requirements)
            .map_err(|_| "该仓库没有可访问的 requirements.txt".to_string())?;
        let session = current_session(&app)?;
        let python = super::find_python(&root, &session.installation_root).ok_or_else(|| "未找到 ComfyUI Python 环境".to_string())?;
        assert_server_stopped(&app)?;
        let mut command = Command::new(python);
        command.current_dir(&path).args(["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", "requirements.txt"]);
        run_command(&app, command, Duration::from_secs(600))?;
        Ok(ManagementResult { message: "依赖安装完成，请重启 ComfyUI。".into() })
    }).await.map_err(|_| "依赖安装失败，请检查环境后重试".to_string())?
}
