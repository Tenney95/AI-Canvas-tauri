//! 固定官方发布包安装；所有目录只从主窗口的原生选择器取得，不开放任意下载或执行能力。
use super::{installation, launch_settings, management, runtime_console};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    future::Future,
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager, Webview};
use tauri_plugin_dialog::DialogExt;

const CANCELLED: &str = "ComfyUI 安装已取消";
const MAX_EXPANDED: u64 = 32 * 1024 * 1024 * 1024;
const RESERVE: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;

#[derive(Deserialize)]
struct Release { version: String, variants: Vec<Variant> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Variant { id: String, label: String, arch: String, asset: String, bytes: u64, sha256: String }

fn release() -> Result<Release, String> {
    let release: Release = serde_json::from_str(include_str!("../../../resources/comfyui-portable.json"))
        .map_err(|_| "内置 ComfyUI 官方安装清单无效".to_string())?;
    if !release.version.starts_with('v') || !release.version[1..].bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
        || release.variants.iter().any(|variant| !variant.asset.starts_with("ComfyUI_windows_portable_")
            || !variant.asset.ends_with(".7z") || variant.asset.contains(['/', '\\'])
            || variant.sha256.len() != 64 || !variant.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || variant.bytes == 0 || variant.bytes > 8 * 1024 * 1024 * 1024) {
        return Err("内置 ComfyUI 官方安装清单校验失败".into());
    }
    Ok(release)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo { supported: bool, version: String, variants: Vec<Variant> }
#[derive(Clone)]
struct Target { id: String, parent: PathBuf, path: PathBuf, parent_identity: file_id::FileId }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTarget { target_id: String, display_path: String }
#[derive(Clone)]
struct Job { id: String, target_id: String, cancelled: Arc<AtomicBool>, committing: Arc<AtomicBool> }
impl Job {
    fn cancel_for(&self, target_id: Option<&str>) {
        if target_id == Some(self.target_id.as_str()) && !self.committing.load(Ordering::Acquire) {
            self.cancelled.store(true, Ordering::Release);
        }
    }
}
#[derive(Default)]
struct Inner { target: Option<Target>, job: Option<Job> }
#[derive(Default)]
pub struct ComfyUIInstallerState(Mutex<Inner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult { path: String, version: String, warning: Option<String> }
#[derive(Serialize)]
struct Progress<'a> { stage: &'a str, source: &'a str, completed: u64, total: Option<u64> }

struct Control { job: Job, channel: Channel<String>, source: &'static str }
impl Control {
    fn check(&self) -> Result<(), String> {
        if self.job.cancelled.load(Ordering::Acquire) { Err(CANCELLED.into()) } else { Ok(()) }
    }
    fn emit(&self, stage: &str, completed: u64, total: Option<u64>) -> Result<(), String> {
        self.check()?;
        let progress = serde_json::to_string(&Progress { stage, source: self.source, completed, total })
            .map_err(|_| "安装进度序列化失败".to_string())?;
        if self.channel.send(progress).is_err() {
            self.job.cancelled.store(true, Ordering::Release);
            return Err(CANCELLED.into());
        }
        Ok(())
    }
}

fn main_caller(webview: &Webview) -> Result<(), String> {
    crate::path_policy::ensure_trusted_caller(webview)?;
    if webview.label() != "main" { return Err("只有主设置窗口可以安装 ComfyUI".into()); }
    Ok(())
}
fn supported() -> bool { cfg!(windows) && matches!(std::env::consts::ARCH, "x86_64" | "aarch64") }
fn idle(app: &AppHandle) -> Result<(), String> {
    if runtime_console::has_active_owned_run(app) { return Err("请先停止本应用启动的 ComfyUI，再安装新的环境".into()); }
    if app.get_webview_window("comfyui-settings").is_some() { return Err("请先关闭 ComfyUI 设置与管理窗口，再安装新的环境".into()); }
    Ok(())
}

/// 原生选择器只登记一次性用途授权；父目录可为磁盘根，实际写入仍由 path_policy 核对。
fn plain_parent(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() { return Err("安装位置必须为本机绝对目录".into()); }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "安装位置不可访问".to_string())?;
        if !metadata.is_dir() || linked(&metadata) { return Err("安装位置不能经过符号链接或目录联接".into()); }
    }
    let canonical = path.canonicalize().map_err(|_| "无法确认安装位置".to_string())?;
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest.strip_prefix(r"UNC\").map_or_else(|| rest.into(), |unc| format!(r"\\{unc}"))));
        }
    }
    Ok(canonical)
}
fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}
fn safe_component(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty() && name.len() <= 240 && name != "." && name != ".."
        && !name.ends_with(['.', ' ']) && !name.chars().any(|ch| ch.is_control() || "/\\:<>\"|?*".contains(ch))
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
fn checked_path(app: &AppHandle, target: &Target, path: &Path) -> Result<PathBuf, String> {
    if plain_parent(&target.parent)? != target.parent || file_id::get_file_id(&target.parent).ok() != Some(target.parent_identity) {
        return Err("安装位置的真实目录已变化，请重新选择".into());
    }
    let resolved = crate::path_policy::authorize_path_with_roots(app, &path.to_string_lossy(),
        crate::path_policy::PathAccess::Write, std::slice::from_ref(&target.parent))
        .map_err(|_| "安装目标未获授权或与应用私有目录重叠".to_string())?;
    if resolved != path || resolved == target.parent || !resolved.starts_with(&target.parent) {
        return Err("安装目标的真实路径已变化".into());
    }
    Ok(resolved)
}
fn target_available(app: &AppHandle, target: &Target) -> Result<(), String> {
    checked_path(app, target, &target.path)?;
    match fs::symlink_metadata(&target.path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("目标文件夹已经存在，请更换位置或文件夹名称；安装不会覆盖已有文件".into()),
        Err(_) => Err("无法确认安装目标是否可用".into()),
    }
}

#[tauri::command]
pub fn get_comfyui_install_info(webview: Webview) -> Result<InstallInfo, String> {
    main_caller(&webview)?;
    let release = release()?;
    let variants = release.variants.into_iter().filter(|variant| variant.arch == std::env::consts::ARCH).collect();
    Ok(InstallInfo { supported: supported(), version: release.version, variants })
}

#[tauri::command]
pub async fn choose_comfyui_install_target(webview: Webview, app: AppHandle, folder_name: String) -> Result<Option<InstallTarget>, String> {
    main_caller(&webview)?;
    if !supported() { return Err("当前平台请使用官方手动安装；一键便携安装支持 Windows x64 / ARM64".into()); }
    if !safe_component(&folder_name) { return Err("安装文件夹名称无效，请勿使用路径、设备名或特殊字符".into()); }
    let _guard = management::lock_operations().await;
    idle(&app)?;
    if app.state::<ComfyUIInstallerState>().0.lock().map_err(|_| "安装状态不可用".to_string())?.job.is_some() {
        return Err("已有 ComfyUI 安装任务，请等待或取消".into());
    }
    let main = app.get_webview_window("main").ok_or_else(|| "找不到主窗口".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().set_parent(&main).set_title("选择安装位置（将在此新建所填名称的文件夹）")
        .pick_folder(move |folder| { let _ = sender.send(folder); });
    let Some(folder) = receiver.await.map_err(|_| "目录选择已中断".to_string())? else { return Ok(None); };
    main_caller(&webview)?;
    let parent = plain_parent(&folder.into_path().map_err(|_| "请选择本机目录".to_string())?)?;
    let parent_identity = file_id::get_file_id(&parent).map_err(|_| "无法确认目录身份".to_string())?;
    let target = Target { id: super::model_dedupe::opaque_id("install-target"), path: parent.join(folder_name), parent, parent_identity };
    target_available(&app, &target)?;
    let result = InstallTarget { target_id: target.id.clone(), display_path: target.path.to_string_lossy().into_owned() };
    app.state::<ComfyUIInstallerState>().0.lock().map_err(|_| "安装状态不可用".to_string())?.target = Some(target);
    Ok(Some(result))
}

#[tauri::command]
pub fn cancel_comfyui_install(webview: Webview, app: AppHandle, target_id: Option<String>) -> Result<(), String> {
    main_caller(&webview)?;
    let state = app.state::<ComfyUIInstallerState>();
    let mut inner = state.0.lock().map_err(|_| "安装状态不可用".to_string())?;
    if let Some(job) = &inner.job {
        job.cancel_for(target_id.as_deref());
    } else if inner.target.as_ref().is_some_and(|target| target_id.as_ref() == Some(&target.id)) { inner.target = None; }
    Ok(())
}

pub fn shutdown_installation(app: &AppHandle) {
    if let Ok(inner) = app.state::<ComfyUIInstallerState>().0.lock() {
        if let Some(job) = &inner.job { job.cancelled.store(true, Ordering::Release); }
    };
}

async fn network<T>(future: impl Future<Output = Result<T, reqwest::Error>>, control: &Control, retryable: &AtomicBool) -> Result<T, String> {
    tokio::pin!(future);
    let deadline = tokio::time::sleep(Duration::from_millis(crate::github_fallback::policy().read_timeout_ms));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result = &mut future => return result.map_err(|error| { retryable.store(error.is_timeout() || error.is_connect() || error.is_body(), Ordering::Release); "安装包网络连接或读取失败".into() }),
            _ = &mut deadline => { retryable.store(true, Ordering::Release); return Err("安装包网络连接或读取超时".into()); },
            _ = tokio::time::sleep(Duration::from_millis(100)) => control.check()?,
        }
    }
}

struct ResponseReader<'a> {
    response: reqwest::Response, pending: Cursor<Vec<u8>>, runtime: tokio::runtime::Handle,
    control: &'a Control, retryable: &'a AtomicBool,
}
impl Read for ResponseReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() { return Ok(0); }
        loop {
            self.control.check().map_err(io::Error::other)?;
            if self.pending.position() < self.pending.get_ref().len() as u64 { return self.pending.read(buffer); }
            let chunk = self.runtime.block_on(network(self.response.chunk(), self.control, self.retryable)).map_err(io::Error::other)?;
            match chunk { Some(bytes) => self.pending = Cursor::new(bytes.to_vec()), None => return Ok(0) }
        }
    }
}

fn download(app: &AppHandle, target: &Target, archive: &Path, release: &Release, variant: &Variant,
    control: &mut Control, runtime: &tokio::runtime::Handle) -> Result<(), String> {
    let client = reqwest::Client::builder().user_agent("AI-Canvas/ComfyUI-installer")
        .connect_timeout(Duration::from_millis(crate::github_fallback::policy().connect_timeout_ms)).https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let allowed = url.host_str().is_some_and(|host| matches!(host, "github.com" | "gh-proxy.com")
                || host.ends_with(".githubusercontent.com") || host.ends_with(".gh-proxy.com"));
            if attempt.previous().len() >= 8 || url.scheme() != "https" || !allowed
                || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
                attempt.error("安装包跳转离开受信任下载站点")
            } else { attempt.follow() }
        })).build().map_err(|_| "无法创建安装下载连接".to_string())?;
    let official = format!("https://github.com/Comfy-Org/ComfyUI/releases/download/{}/{}", release.version, variant.asset);
    let mirror = crate::github_fallback::mirror_url(&official).ok_or_else(|| "官方安装包地址无效".to_string())?;
    for (source, url) in [("official", official.clone()), ("mirror", mirror)] {
        control.source = source;
        control.emit("connecting", 0, Some(variant.bytes))?;
        let retryable = AtomicBool::new(false);
        let attempt = (|| {
            checked_path(app, target, archive)?;
            let response = runtime.block_on(network(client.get(&url).send(), control, &retryable))?;
            if !response.status().is_success() {
                retryable.store(crate::github_fallback::transient_status(response.status().as_u16()), Ordering::Release);
                return Err(format!("安装包下载返回 HTTP {}", response.status().as_u16()));
            }
            if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("text/html")) || response.content_length().is_some_and(|length| length != variant.bytes) {
                return Err("下载站点返回了拦截页面或不完整安装包".into());
            }
            let mut reader = ResponseReader { response, pending: Cursor::new(Vec::new()), runtime: runtime.clone(), control, retryable: &retryable };
            let mut last = Instant::now();
            crate::file_transfer::stream_to_file(&control.job.id, &mut reader, archive,
                Some(variant.bytes), Some(variant.bytes), Some(variant.bytes),
                || Ok(control.job.cancelled.load(Ordering::Acquire)),
                |done| { if last.elapsed() >= Duration::from_millis(150) || done == variant.bytes {
                    let _ = control.emit("downloading", done, Some(variant.bytes)); last = Instant::now();
                } },
                |temporary| {
                    control.emit("verifying", 0, Some(variant.bytes))?;
                    let mut verified_at = Instant::now();
                    let mut file = File::open(temporary).map_err(|_| "无法读取待校验的安装包".to_string())?;
                    let mut hasher = Sha256::new();
                    let mut buffer = vec![0u8; 1024 * 1024];
                    let mut done = 0;
                    loop {
                        control.check()?;
                        let count = file.read(&mut buffer).map_err(|_| "安装包校验读取失败".to_string())?;
                        if count == 0 { break; }
                        hasher.update(&buffer[..count]); done += count as u64;
                        if verified_at.elapsed() >= Duration::from_millis(150) { control.emit("verifying", done, Some(variant.bytes))?; verified_at = Instant::now(); }
                    }
                    if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&variant.sha256) { return Err("安装包 SHA-256 与内置官方清单不一致，已拒绝解压".into()); }
                    control.emit("verifying", done, Some(variant.bytes))
                })?;
            Ok(())
        })();
        if attempt.is_ok() { return Ok(()); }
        control.check()?;
        if source == "mirror" || !retryable.load(Ordering::Acquire) { return attempt; }
    }
    Err("官方和国内加速源均未能完成下载".into())
}

fn archive_path(name: &str) -> Result<PathBuf, String> {
    let name = name.replace('\\', "/");
    if name.starts_with('/') || name.len() > 2048 { return Err("安装包包含绝对路径或超长路径".into()); }
    let name = name.trim_end_matches('/');
    let mut result = PathBuf::new();
    for component in name.split('/') {
        if !safe_component(component) { return Err("安装包包含越界路径、设备名或非法文件名".into()); }
        result.push(component);
    }
    if result.as_os_str().is_empty() { return Err("安装包包含空路径".into()); }
    Ok(result)
}

fn unpack(app: &AppHandle, target: &Target, archive: &Path, content: &Path, control: &Control) -> Result<PathBuf, String> {
    checked_path(app, target, archive)?;
    checked_path(app, target, content)?;
    fs::create_dir(content).map_err(|_| "无法创建独立解压目录".to_string())?;
    let mut reader = sevenz_rust::SevenZReader::open(archive, sevenz_rust::Password::empty())
        .map_err(|_| "无法打开已校验的官方 7z 安装包".to_string())?;
    let files = &reader.archive().files;
    if files.is_empty() || files.len() > MAX_ENTRIES { return Err("安装包文件数量超过限制".into()); }
    let mut expanded = 0u64;
    let mut paths = HashSet::new();
    for entry in files {
        control.check()?;
        let relative = archive_path(&entry.name)?;
        let mode = entry.windows_attributes >> 16 & 0xf000;
        if entry.is_anti_item || entry.windows_attributes & 0x400 != 0 || !matches!(mode, 0 | 0x4000 | 0x8000) {
            return Err("安装包包含链接或特殊项，已拒绝解压".into());
        }
        if !paths.insert(relative.to_string_lossy().replace('\\', "/").to_lowercase()) { return Err("安装包存在重复路径，已拒绝覆盖".into()); }
        expanded = expanded.checked_add(entry.size).ok_or_else(|| "安装包展开大小无效".to_string())?;
        if expanded > MAX_EXPANDED { return Err("安装包展开后超过 32 GiB 限制".into()); }
    }
    if fs2::available_space(content).map_err(|_| "无法读取安装磁盘空间".to_string())? < expanded.saturating_add(RESERVE) {
        return Err("磁盘剩余空间不足，无法解压完整运行环境".into());
    }
    control.emit("extracting", 0, Some(expanded))?;
    let mut completed = 0u64;
    let mut last = Instant::now();
    let mut failure = None;
    let result = reader.for_each_entries(|entry, source| {
        let write = (|| -> Result<(), String> {
            control.check()?;
            let path = content.join(archive_path(&entry.name)?);
            checked_path(app, target, &path)?;
            if entry.is_directory {
                fs::create_dir_all(&path).map_err(|_| "无法创建安装包子目录".to_string())?;
                return Ok(());
            }
            let parent = path.parent().ok_or_else(|| "解压目标无效".to_string())?;
            fs::create_dir_all(parent).map_err(|_| "无法创建安装包父目录".to_string())?;
            checked_path(app, target, &path)?;
            let mut output = OpenOptions::new().write(true).create_new(true).open(&path)
                .map_err(|_| "无法创建解压文件（禁止覆盖）".to_string())?;
            let mut buffer = vec![0u8; 1024 * 1024];
            let mut file_bytes = 0u64;
            loop {
                control.check()?;
                let count = source.read(&mut buffer).map_err(|_| "安装包解压读取或 CRC 校验失败".to_string())?;
                if count == 0 { break; }
                file_bytes = file_bytes.saturating_add(count as u64);
                completed = completed.saturating_add(count as u64);
                if file_bytes > entry.size || completed > expanded { return Err("解压内容超过清单大小".into()); }
                output.write_all(&buffer[..count]).map_err(|_| "安装包解压写入失败，请检查磁盘空间".to_string())?;
                if last.elapsed() >= Duration::from_millis(150) { control.emit("extracting", completed, Some(expanded))?; last = Instant::now(); }
            }
            if file_bytes != entry.size { return Err("安装包解压文件不完整".into()); }
            Ok(())
        })();
        match write { Ok(()) => Ok(true), Err(error) => { failure = Some(error); Err(sevenz_rust::Error::other("安装解压已中断")) } }
    });
    if result.is_err() { return Err(failure.unwrap_or_else(|| "安装包解压或 CRC 校验失败".into())); }
    control.emit("extracting", completed, Some(expanded))?;
    let mut payloads = Vec::new();
    for name in ["ComfyUI_windows_portable", "ComfyUI_windows_portable_amd", "ComfyUI_windows_portable_intel", "ComfyUI_windows_portable_nvidia", "ComfyUI_windows_portable_nvidia_cu126", "ComfyUI_windows_portable_nvidia_arm64"] {
        let payload = content.join(name);
        if payload.join("ComfyUI/main.py").is_file() && payload.join("python_embeded/python.exe").is_file() {
            for required in ["ComfyUI/main.py", "ComfyUI/comfy/cli_args.py", "python_embeded/python.exe"] {
                crate::path_policy::validate_comfyui_installation_file(app, &payload.join(required), &payload)?;
            }
            payloads.push(payload);
        }
    }
    if payloads.len() != 1 { return Err("官方安装包的 ComfyUI 源码或嵌入式 Python 目录缺失或不唯一".into()); }
    Ok(payloads.remove(0))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Environment { python: String, torch: String, accelerator_available: bool }

fn check_environment(app: &AppHandle, payload: &Path, variant: &Variant, control: &Control) -> Result<Option<String>, String> {
    control.emit("checking", 0, None)?;
    let python = crate::path_policy::validate_comfyui_installation_file(app, &payload.join("python_embeded/python.exe"), payload)?;
    let mut command = Command::new(python);
    // 固定脚本只检测官方依赖，不从 Renderer 接受脚本或任意 argv。
    command.current_dir(payload.join("ComfyUI")).args(["-s", "-c",
        "import json,sys,torch,aiohttp,numpy,PIL,safetensors,yaml; from importlib.metadata import version; version('comfyui-frontend-package'); print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'torch':str(torch.__version__),'acceleratorAvailable':bool(torch.cuda.is_available() or (hasattr(torch,'xpu') and torch.xpu.is_available()))}))"])
        .env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8").env("PYTHONDONTWRITEBYTECODE", "1");
    let output = management::run_scoped_command(command, Duration::from_secs(120), None,
        || !control.job.cancelled.load(Ordering::Acquire) && app.get_webview_window("main").is_some());
    control.check()?;
    let output = output.map_err(|_| "官方 Python / PyTorch 环境检测未通过，请确认 Windows 版本、显卡驱动与 VC++ 运行库是否兼容".to_string())?;
    let environment: Environment = output.lines().rev().find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| "安装环境未返回有效检测结果".to_string())?;
    if environment.python.is_empty() || environment.torch.is_empty() { return Err("Python / PyTorch 版本信息不完整".into()); }
    if !variant.id.starts_with("cpu") && !environment.accelerator_available {
        return Ok(Some("安装已完成，但未检测到可用的兼容 GPU。请更新对应显卡驱动，或在常用设置中选择 CPU 模式后启动。".into()));
    }
    Ok(None)
}

fn cleanup(app: &AppHandle, target: &Target, stage: &Path, identity: file_id::FileId) -> Result<(), String> {
    if stage.parent() != Some(target.parent.as_path()) || !stage.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".ai-canvas-comfyui-install-")) {
        return Err("安装临时目录身份不匹配，已保留供核对".into());
    }
    checked_path(app, target, stage)?;
    let metadata = fs::symlink_metadata(stage).map_err(|_| "无法读取安装临时目录".to_string())?;
    if !metadata.is_dir() || linked(&metadata) || file_id::get_file_id(stage).ok() != Some(identity) {
        return Err("安装临时目录真实身份已变化，已保留供核对".into());
    }
    fs::remove_dir_all(stage).map_err(|_| "临时安装包清理失败，请在安装位置清理本次 .ai-canvas-comfyui-install 临时文件夹".to_string())
}

/// worker 异常退出也尝试清理；始终保留目录身份和私有路径校验。
struct StageGuard<'a> { app: &'a AppHandle, target: &'a Target, path: &'a Path, identity: file_id::FileId, finished: bool }
impl StageGuard<'_> {
    fn finish(&mut self) -> Result<(), String> {
        self.finished = true;
        cleanup(self.app, self.target, self.path, self.identity)
    }
}
impl Drop for StageGuard<'_> {
    fn drop(&mut self) {
        if !self.finished { let _ = cleanup(self.app, self.target, self.path, self.identity); }
    }
}

fn install(app: &AppHandle, target: &Target, release: Release, variant: Variant, mut control: Control,
    runtime: tokio::runtime::Handle) -> Result<InstallResult, String> {
    target_available(app, target)?;
    let old_settings = launch_settings::load_settings(app)?;
    let required_space = variant.bytes.saturating_mul(5).saturating_add(RESERVE);
    if fs2::available_space(&target.parent).map_err(|_| "无法读取目标磁盘空间".to_string())? < required_space {
        return Err(format!("安装磁盘剩余空间不足，请至少预留 {:.1} GiB", required_space as f64 / (1024.0 * 1024.0 * 1024.0)));
    }
    let stage = target.parent.join(format!(".ai-canvas-comfyui-install-{}", control.job.id));
    checked_path(app, target, &stage)?;
    fs::create_dir(&stage).map_err(|_| "无法创建独立安装临时目录".to_string())?;
    let identity = file_id::get_file_id(&stage).map_err(|_| "无法确认安装临时目录身份；本次临时空目录已保留，请核对安装位置".to_string())?;
    let mut stage_guard = StageGuard { app, target, path: &stage, identity, finished: false };
    let result = (|| {
        download(app, target, &stage.join("portable.7z"), &release, &variant, &mut control, &runtime)?;
        let payload = unpack(app, target, &stage.join("portable.7z"), &stage.join("content"), &control)?;
        let warning = check_environment(app, &payload, &variant, &control)?;
        control.emit("committing", 0, None)?;
        target_available(app, target)?;
        checked_path(app, target, &payload)?;
        {
            // 取消与发布在同一任务锁下交接，旧弹窗不能取消后续安装。
            let state = app.state::<ComfyUIInstallerState>();
            let inner = state.0.lock().map_err(|_| "安装状态不可用".to_string())?;
            if !inner.job.as_ref().is_some_and(|job| job.id == control.job.id) { return Err("安装任务已变化".into()); }
            control.check()?;
            control.job.committing.store(true, Ordering::Release);
        }
        // 本安装器只在 Windows 执行；目录 rename 不替换已存在的目标目录。
        fs::rename(&payload, &target.path).map_err(|_| "无法发布新安装目录，目标可能已存在；未覆盖原目录".to_string())?;
        let settings = launch_settings::ComfyUILaunchSettings {
            port: old_settings.port,
            vram_mode: if variant.id.starts_with("cpu") { launch_settings::VramMode::Cpu } else { launch_settings::VramMode::Auto },
            ..Default::default()
        };
        // 发布后不再响应取消；保持“设置 + 用途授权”提交的一致性。
        launch_settings::save_settings(app, settings).map_err(|_| "安装已解压，但启动设置保存失败；原安装选择未变，可通过更换按钮选择新安装".to_string())?;
        if installation::persist_installation(app, &target.path).is_err() {
            let restored = launch_settings::save_settings(app, old_settings).is_ok();
            return Err(if restored { "安装已解压，但记住目录失败，原安装选择已保留；请通过更换按钮选择新安装" }
                else { "安装已解压，但目录授权和启动设置恢复失败；请检查应用数据目录权限并重新选择安装" }.into());
        }
        management::invalidate_management_cache(app);
        Ok(InstallResult { path: target.path.to_string_lossy().into_owned(), version: release.version, warning })
    })();
    let cleaned = stage_guard.finish();
    match (result, cleaned) {
        (Ok(mut installed), Err(error)) => { installed.warning = Some(installed.warning.map_or(error.clone(), |warning| format!("{warning} {error}"))); Ok(installed) }
        (Err(error), Err(cleanup_error)) => Err(format!("{error}；{cleanup_error}")),
        (result, Ok(())) => result,
    }
}

struct JobGuard { app: AppHandle, id: String }
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.app.state::<ComfyUIInstallerState>().0.lock() {
            if inner.job.as_ref().is_some_and(|job| job.id == self.id) { inner.job = None; }
        };
    }
}

#[tauri::command]
pub async fn install_comfyui_portable(webview: Webview, app: AppHandle, target_id: String, variant_id: String, on_progress: Channel<String>) -> Result<InstallResult, String> {
    main_caller(&webview)?;
    if !supported() { return Err("当前平台不支持 Windows 官方便携版自动安装".into()); }
    let release = release()?;
    let variant = release.variants.iter().find(|variant| variant.id == variant_id && variant.arch == std::env::consts::ARCH)
        .cloned().ok_or_else(|| "请选择受支持的官方运行环境".to_string())?;
    let (target, job) = {
        let state = app.state::<ComfyUIInstallerState>();
        let mut inner = state.0.lock().map_err(|_| "安装状态不可用".to_string())?;
        if inner.job.is_some() { return Err("已有 ComfyUI 安装任务，请等待或取消".into()); }
        let target = inner.target.as_ref().filter(|target| target.id == target_id).cloned()
            .ok_or_else(|| "安装目标授权已失效，请重新选择目录".to_string())?;
        let job = Job { id: super::model_dedupe::opaque_id("portable"), target_id: target.id.clone(),
            cancelled: Arc::new(AtomicBool::new(false)), committing: Arc::new(AtomicBool::new(false)) };
        inner.target = None;
        inner.job = Some(job.clone());
        (target, job)
    };
    let job_guard = JobGuard { app: app.clone(), id: job.id.clone() };
    let operation_guard = management::lock_operations().await;
    main_caller(&webview)?;
    idle(&app)?;
    let worker_app = app.clone();
    let runtime = tokio::runtime::Handle::current();
    // 将锁和任务守卫交给 worker；Renderer 中断不能提前释放正在使用的安装授权。
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _job_guard = job_guard;
        let _operation_guard = operation_guard;
        let control = Control { job, channel: on_progress, source: "official" };
        control.check()?;
        install(&worker_app, &target, release, variant, control, runtime)
    }).await.map_err(|_| "安装任务中断，请核对所选目录；原安装授权仍由原生记录决定".to_string())?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_device_names_ads_and_absolute_archive_entries() {
        for invalid in ["../outside", "a/../outside", "/absolute", "C:\\outside", "a/file:secret", "a/CON.txt", "a/NUL", "a/file.", "a//file", "a/./file"] {
            assert!(archive_path(invalid).is_err(), "{invalid}");
        }
        assert_eq!(archive_path("ComfyUI_windows_portable/ComfyUI/main.py").unwrap(), PathBuf::from("ComfyUI_windows_portable/ComfyUI/main.py"));
        assert_eq!(archive_path("ComfyUI_windows_portable/ComfyUI/").unwrap(), PathBuf::from("ComfyUI_windows_portable/ComfyUI"));
        assert!(safe_component("我的 ComfyUI"));
        assert!(!safe_component("COM1"));
    }
    #[test]
    fn release_is_pinned_to_official_assets_and_has_independent_hashes() {
        let release = release().unwrap();
        assert_eq!(release.version, "v0.41.0");
        assert!(release.variants.iter().any(|variant| variant.id == "cpu"));
        assert_ne!(release.variants[0].sha256, release.variants[1].sha256);
        assert!(release.variants.iter().all(|variant| variant.bytes > 1024 * 1024 * 1024 && variant.sha256.len() == 64));
    }
    #[test]
    fn cancellation_requires_the_current_target_and_stops_before_commit() {
        let job = Job { id: "job".into(), target_id: "current".into(), cancelled: Arc::new(AtomicBool::new(false)), committing: Arc::new(AtomicBool::new(false)) };
        job.cancel_for(None);
        job.cancel_for(Some("previous"));
        assert!(!job.cancelled.load(Ordering::Acquire));
        job.cancel_for(Some("current"));
        assert!(job.cancelled.load(Ordering::Acquire));
        job.cancelled.store(false, Ordering::Release);
        job.committing.store(true, Ordering::Release);
        job.cancel_for(Some("current"));
        assert!(!job.cancelled.load(Ordering::Acquire));
    }
}
