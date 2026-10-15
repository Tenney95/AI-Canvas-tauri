//! 自有本地窗口的 ComfyUI 运行控制台。输出仅存有界原生内存，不进入日志或持久化。
use super::{installation, launch_settings, management};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::Read,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Condvar, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const MAX_LINES: usize = 2_000;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const SNAPSHOT_LINES: usize = 200;
static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus { Idle, Starting, Running, Exited, Failed, External }

impl RuntimeStatus {
    fn is_owned_active(self) -> bool { matches!(self, Self::Starting | Self::Running) }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleStream { Stdout, Stderr, System }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLine {
    sequence: u64,
    timestamp: u64,
    stream: ConsoleStream,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUIRuntimeStartResult {
    run_id: Option<String>,
    status: RuntimeStatus,
    port: u16,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyUIRuntimeSnapshot {
    run_id: Option<String>,
    status: RuntimeStatus,
    port: u16,
    exit_code: Option<i32>,
    lines: Vec<ConsoleLine>,
    next_sequence: u64,
    truncated: bool,
    message: String,
}

#[derive(Default)]
struct RuntimeShared {
    run: Mutex<Option<RuntimeRun>>,
    shutting_down: AtomicBool,
    finished: Condvar,
}

#[derive(Clone, Default)]
pub struct ComfyUIRuntimeState { shared: Arc<RuntimeShared> }

struct RuntimeRun {
    id: String,
    installation: PathBuf,
    port: u16,
    status: RuntimeStatus,
    exit_code: Option<i32>,
    lines: VecDeque<ConsoleLine>,
    bytes: usize,
    sequence: u64,
    message: String,
    stop_requested: bool,
}

fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
        .min(u64::MAX as u128) as u64
}

impl RuntimeRun {
    fn new(installation: &Path, port: u16, status: RuntimeStatus, message: &str) -> Self {
        Self {
            id: format!("comfy-{}-{}", timestamp(), RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)),
            installation: installation.to_path_buf(), port, status, exit_code: None,
            lines: VecDeque::new(), bytes: 0, sequence: 0, message: message.into(), stop_requested: false,
        }
    }

    fn append(&mut self, stream: ConsoleStream, text: String) {
        self.sequence += 1;
        self.bytes += text.len();
        self.lines.push_back(ConsoleLine { sequence: self.sequence, timestamp: timestamp(), stream, text });
        while self.lines.len() > MAX_LINES || self.bytes > MAX_BYTES {
            if let Some(line) = self.lines.pop_front() { self.bytes -= line.text.len(); }
        }
    }

    fn start_result(&self) -> ComfyUIRuntimeStartResult {
        ComfyUIRuntimeStartResult { run_id: Some(self.id.clone()), status: self.status, port: self.port, message: self.message.clone() }
    }

    fn snapshot(&self, run_id: Option<&str>, after: Option<u64>) -> ComfyUIRuntimeSnapshot {
        let after = if run_id == Some(self.id.as_str()) { after.unwrap_or(0).min(self.sequence) } else { 0 };
        let lines: Vec<_> = self.lines.iter().filter(|line| line.sequence > after).take(SNAPSHOT_LINES).cloned().collect();
        let next_sequence = lines.last().map_or(after, |line| line.sequence);
        ComfyUIRuntimeSnapshot {
            run_id: Some(self.id.clone()), status: self.status, port: self.port, exit_code: self.exit_code,
            truncated: self.lines.front().is_some_and(|line| line.sequence > after.saturating_add(1)),
            lines, next_sequence, message: self.message.clone(),
        }
    }
}

impl RuntimeShared {
    fn update(&self, id: &str, update: impl FnOnce(&mut RuntimeRun)) {
        if let Ok(mut current) = self.run.lock() {
            if let Some(run) = current.as_mut().filter(|run| run.id == id) { update(run); }
        }
    }

    fn append(&self, id: &str, stream: ConsoleStream, text: String) {
        self.update(id, |run| run.append(stream, text));
    }

    fn finish(&self, id: &str, status: RuntimeStatus, exit_code: Option<i32>, message: &str) {
        self.update(id, |run| {
            run.status = status;
            run.exit_code = exit_code;
            run.message = message.into();
            run.append(ConsoleStream::System, message.into());
        });
        self.finished.notify_all();
    }
}

fn port_is_reachable(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port), Duration::from_millis(100),
    ).is_ok()
}

/// 脱敏先于入环；整行屏蔽凭据，避免含引号/空格的值被不完整截断。
fn sanitize_output(raw: &[u8], installation: &Path, home: Option<&Path>) -> String {
    let text: String = String::from_utf8_lossy(raw).chars().filter(|ch| !ch.is_control() || *ch == '\t').collect();
    let lower = text.to_ascii_lowercase();
    let sensitive_key = ["api_key", "api-key", "apikey", "access_token", "refresh_token", "hf_token", "token", "secret", "password", "passwd", "pwd"]
        .iter().any(|&key| lower.match_indices(key).any(|(index, key)| {
            let before = &lower[..index];
            if before.as_bytes().last().is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_') { return false; }
            lower[index + key.len()..].trim_start_matches([' ', '\t', '\'', '"']).starts_with([':', '='])
        }));
    let url_credentials = lower.split_whitespace().any(|word| word.split_once("://")
        .is_some_and(|(_, tail)| tail.split('/').next().is_some_and(|authority| authority.contains('@'))));
    let spaced_key = ["api key", "api token", "access token", "auth token", "client secret", "password ", "passwd "]
        .iter().any(|&key| lower.contains(key));
    if sensitive_key || spaced_key || lower.contains("authorization") || lower.contains("bearer ") || url_credentials
        || lower.split_whitespace().any(|word| (word.starts_with("sk-") || word.starts_with("hf_")) && word.len() > 20)
    { return "[已隐藏包含凭据的输出]".into(); }
    let mut text = replace_path_prefix(&text, installation, "<ComfyUI>");
    if let Some(home) = home { text = replace_path_prefix(&text, home, "<用户目录>"); }
    hide_other_absolute_paths(&text)
}

fn hide_other_absolute_paths(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        let boundary = index == 0 || matches!(bytes[index - 1], b' ' | b'\t' | b'\'' | b'"' | b'=' | b'(' | b'[' | b'{');
        let drive_boundary = index == 0 || (!bytes[index - 1].is_ascii_alphanumeric() && bytes[index - 1] != b'_');
        let drive = drive_boundary && bytes[index].is_ascii_alphabetic() && bytes.get(index + 1) == Some(&b':')
            && bytes.get(index + 2).is_some_and(|byte| matches!(*byte, b'/' | b'\\'));
        let absolute = drive || (boundary && (bytes[index] == b'/' ||
            (bytes[index] == b'\\' && bytes.get(index + 1) == Some(&b'\\'))));
        if !absolute { index += 1; continue; }
        let end = bytes[index..].iter().position(|byte|
            byte.is_ascii_whitespace() || matches!(*byte, b'\'' | b'"' | b'<' | b'>' | b')' | b']' | b'}' | b',' | b';'))
            .map_or(bytes.len(), |length| index + length);
        if end <= index { index += 1; continue; }
        let path = &text[index..end];
        let name = path.rsplit(['/', '\\']).next().unwrap_or("");
        output.push_str(&text[copied..index]);
        output.push_str("<外部路径>");
        if !name.is_empty() { output.push('/'); output.push_str(name); }
        copied = end;
        index = end;
    }
    output.push_str(&text[copied..]);
    output
}

fn replace_path_prefix(text: &str, prefix: &Path, replacement: &str) -> String {
    let prefix = prefix.to_string_lossy();
    let mut text = text.to_string();
    for candidate in [prefix.to_string(), prefix.replace('\\', "/"), prefix.replace('/', "\\")] {
        if candidate.is_empty() { continue; }
        // ASCII 大小写折叠保留 UTF-8 字节边界，兼容 Windows 路径大小写。
        let lower = text.to_ascii_lowercase();
        let needle = candidate.to_ascii_lowercase();
        let mut output = String::new();
        let mut start = 0;
        for (index, _) in lower.match_indices(&needle) {
            output.push_str(&text[start..index]);
            output.push_str(replacement);
            start = index + candidate.len();
        }
        output.push_str(&text[start..]);
        text = output;
    }
    text
}

/// 不使用 read_line：损坏扩展的无换行输出、OSC 和 ANSI 序列也不能无界占用内存。
#[derive(Default)]
struct OutputFramer { line: Vec<u8>, escape: u8, carriage_return: bool, discarding: bool }

impl OutputFramer {
    fn read(&mut self, bytes: &[u8], mut emit: impl FnMut(&[u8])) {
        for &byte in bytes {
            match self.escape {
                1 => { self.escape = match byte { b'[' => 2, b']' => 3, _ => 0 }; continue; }
                2 => { if (0x40..=0x7e).contains(&byte) { self.escape = 0; } continue; }
                3 => { if byte == 7 { self.escape = 0; } else if byte == 27 { self.escape = 4; } continue; }
                4 => { self.escape = if byte == b'\\' { 0 } else { 3 }; continue; }
                _ => {}
            }
            if byte == 27 { self.escape = 1; continue; }
            if byte == b'\r' || byte == b'\n' {
                if (byte != b'\n' || !self.carriage_return) && !self.discarding { emit(&self.line); self.line.clear(); }
                self.discarding = false;
                self.carriage_return = byte == b'\r';
            } else {
                self.carriage_return = false;
                if self.discarding { continue; }
                if byte >= 32 || byte == b'\t' { self.line.push(byte); }
                if self.line.len() >= MAX_LINE_BYTES {
                    emit(&self.line);
                    emit("[该行超过 16 KiB，后续内容已截断]".as_bytes());
                    self.line.clear();
                    // 不把超长行的后半截作为新行，避免遗失凭据字段前缀后泄漏值。
                    self.discarding = true;
                }
            }
        }
    }

    fn finish(&mut self, mut emit: impl FnMut(&[u8])) {
        if !self.line.is_empty() { emit(&self.line); self.line.clear(); }
    }
}

fn start_reader(
    pipe: impl Read + Send + 'static,
    shared: Arc<RuntimeShared>, id: String, stream: ConsoleStream, installation: PathBuf,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name("comfyui-output".into()).spawn(move || {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
        let mut pipe = pipe;
        let mut framer = OutputFramer::default();
        let mut chunk = [0u8; 4096];
        let emit = |bytes: &[u8]| shared.append(&id, stream, sanitize_output(bytes, &installation, home.as_deref()));
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => framer.read(&chunk[..count], &emit),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    shared.append(&id, ConsoleStream::System, "一条输出流已中断，可能缺少部分输出。".into());
                    break;
                }
            }
        }
        framer.finish(emit);
    })
}

struct OwnedProcess {
    child: Child,
    #[cfg(windows)]
    job: Option<management::ProcessJob>,
    terminated: bool,
}

impl OwnedProcess {
    fn new(child: Child) -> Self {
        Self { child, #[cfg(windows)] job: None, terminated: false }
    }

    fn terminate(&mut self) {
        if self.terminated { return; }
        self.terminated = true;
        #[cfg(windows)]
        if let Some(job) = &self.job { job.terminate(); }
        #[cfg(unix)]
        unsafe {
            unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
            if let Ok(pid) = i32::try_from(self.child.id()) { let _ = kill(-pid, 9); }
        }
        let _ = self.child.kill();
        // 不对 Renderer PID 或外部进程操作，只回收尚未释放的 std Child。
        let _ = self.child.wait();
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) { self.terminate(); }
}

fn supervise(mut command: Command, shared: Arc<RuntimeShared>, id: String, installation: PathBuf, port: u16,
    ready: std::sync::mpsc::SyncSender<Result<(), String>>) {
    if shared.shutting_down.load(Ordering::Acquire) {
        shared.finish(&id, RuntimeStatus::Failed, None, "应用正在退出，未启动 ComfyUI。");
        let _ = ready.send(Err("应用正在退出，未启动 ComfyUI。".into()));
        return;
    }
    let mut process = match command.spawn() {
        Ok(child) => OwnedProcess::new(child),
        Err(error) => {
            let message = format!("无法启动 ComfyUI，请检查 Python 环境（{:?}，系统错误码：{}）。",
                error.kind(), error.raw_os_error().map_or_else(|| "无".to_string(), |code| code.to_string()));
            shared.finish(&id, RuntimeStatus::Failed, None, &message);
            let _ = ready.send(Err(message));
            return;
        }
    };
    #[cfg(windows)]
    match management::ProcessJob::attach(&process.child) {
        Ok(job) => process.job = Some(job),
        Err(error) => {
            process.terminate();
            shared.finish(&id, RuntimeStatus::Failed, None, &error);
            let _ = ready.send(Err(error));
            return;
        }
    };
    let readers = process.child.stdout.take().zip(process.child.stderr.take()).and_then(|(stdout, stderr)| {
        let stdout = start_reader(stdout, shared.clone(), id.clone(), ConsoleStream::Stdout, installation.clone()).ok()?;
        let stderr = start_reader(stderr, shared.clone(), id.clone(), ConsoleStream::Stderr, installation).ok()?;
        Some((stdout, stderr))
    });
    let Some((stdout, stderr)) = readers else {
        process.terminate();
        shared.finish(&id, RuntimeStatus::Failed, None, "无法创建 ComfyUI 输出读取任务，已结束本次启动。");
        let _ = ready.send(Err("无法创建 ComfyUI 输出读取任务，已结束本次启动。".into()));
        return;
    };
    let _ = ready.send(Ok(()));
    let mut reachable = false;
    let mut last_probe = Instant::now();
    let outcome = loop {
        let stop_requested = shared.run.lock().ok().is_some_and(|current|
            current.as_ref().is_some_and(|run| run.id == id && run.stop_requested));
        if shared.shutting_down.load(Ordering::Acquire) || stop_requested {
            process.terminate();
            break (RuntimeStatus::Exited, None, if stop_requested { "已停止由本应用启动的 ComfyUI。" }
                else { "应用退出，已结束由本应用启动的 ComfyUI。" });
        }
        match process.child.try_wait() {
            Ok(Some(status)) => break (
                if status.success() { RuntimeStatus::Exited } else { RuntimeStatus::Failed },
                status.code(), if status.success() { "ComfyUI 进程已退出。" } else { "ComfyUI 进程异常退出，请查看前面的输出。" },
            ),
            Err(_) => {
                process.terminate();
                break (RuntimeStatus::Failed, None, "无法读取 ComfyUI 进程状态，已结束本次进程。");
            }
            Ok(None) => {}
        }
        if !reachable && last_probe.elapsed() >= Duration::from_millis(500) {
            last_probe = Instant::now();
            if port_is_reachable(port) {
                reachable = true;
                shared.update(&id, |run| {
                    run.status = RuntimeStatus::Running;
                    run.message = "运行进程的端口已响应，加载状态以 ComfyUI 页面为准。".into();
                });
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // 子进程退出后回收其子树，避免孙进程持有管道使控制台永远等待 EOF。
    process.terminate();
    let drain_until = Instant::now() + Duration::from_millis(500);
    while (!stdout.is_finished() || !stderr.is_finished()) && Instant::now() < drain_until {
        std::thread::sleep(Duration::from_millis(10));
    }
    if stdout.is_finished() { let _ = stdout.join(); }
    if stderr.is_finished() { let _ = stderr.join(); }
    shared.finish(&id, outcome.0, outcome.1, outcome.2);
}

/// 两个启动入口都在 management 操作锁内调用，不接收 Renderer 指定的程序/参数。
pub(super) fn launch_authorized(app: &tauri::AppHandle, installation_root: &Path) -> Result<ComfyUIRuntimeStartResult, String> {
    let installation_root = installation::reauthorize_installation(app, installation_root)?;
    let shared = app.state::<ComfyUIRuntimeState>().shared.clone();
    if shared.shutting_down.load(Ordering::Acquire) { return Err("应用正在退出，无法启动 ComfyUI".into()); }
    {
        let current = shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())?;
        if let Some(run) = current.as_ref().filter(|run| run.status.is_owned_active()) {
            if run.installation != installation_root { return Err("本应用启动的另一个 ComfyUI 服务尚未退出，请先结束该服务再启动其他安装。".into()); }
            return Ok(run.start_result());
        }
    }
    let settings = launch_settings::load_settings(app)?;
    if port_is_reachable(settings.port) {
        let mut run = RuntimeRun::new(&installation_root, settings.port, RuntimeStatus::External,
            "配置端口已有服务，未重复启动；该服务的命令行输出不由本应用捕获。");
        run.append(ConsoleStream::System, run.message.clone());
        let result = run.start_result();
        *shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())? = Some(run);
        launch_settings::record_launch_port(settings.port);
        return Ok(result);
    }
    let working_dir = super::find_main_py(&installation_root);
    let direct = working_dir.as_ref().and_then(|working_dir| super::find_python(working_dir, &installation_root));
    #[cfg(not(windows))]
    let direct = direct.or_else(|| Some("python3".to_string()));
    if let (Some(working_dir), Some(python)) = (working_dir, direct) {
        crate::path_policy::validate_comfyui_installation_file(app, &working_dir.join("main.py"), &installation_root)?;
        crate::path_policy::validate_comfyui_installation_file(app, &working_dir.join("comfy/cli_args.py"), &installation_root)?;
        let executable = Path::new(&python);
        if executable.is_absolute() {
            #[cfg(windows)]
            crate::path_policy::validate_comfyui_installation_file(app, executable, &installation_root)?;
            #[cfg(not(windows))]
            {
                // Unix venv/bin/python 常为系统 Python 的标准软链；启动候选仍只由原生固定探测产生。
                let parent = executable.parent().ok_or_else(|| "ComfyUI Python 目录无效".to_string())?;
                let parent = crate::path_policy::validate_comfyui_installation_directory(app, &parent.to_string_lossy())?;
                if !parent.starts_with(&installation_root) || !executable.is_file() {
                    return Err("ComfyUI Python 候选不在已授权安装环境中".into());
                }
            }
        }
        let args = super::build_comfy_args(&installation_root, &working_dir, &settings)?;
        let mut command = Command::new(python);
        command.args(args).current_dir(working_dir)
            .env("PYTHONUNBUFFERED", "1").env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(super::CREATE_NO_WINDOW);
        #[cfg(unix)]
        command.process_group(0);
        let mut run = RuntimeRun::new(&installation_root, settings.port, RuntimeStatus::Starting, "ComfyUI 已开始启动，正在等待服务就绪。");
        run.append(ConsoleStream::System, "直接启动 ComfyUI，下面显示 Python 与扩展的实时输出。".into());
        let id = run.id.clone();
        let result = run.start_result();
        *shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())? = Some(run);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker_shared = shared.clone();
        let worker_id = id.clone();
        if std::thread::Builder::new().name("comfyui-process".into()).spawn(move || {
            let monitor_shared = worker_shared.clone();
            let monitor_id = worker_id.clone();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                supervise(command, worker_shared, worker_id, installation_root, settings.port, sender);
            })).is_err() {
                monitor_shared.finish(&monitor_id, RuntimeStatus::Failed, None, "ComfyUI 运行任务中断，已结束本次进程。");
            }
        }).is_err() {
            shared.finish(&id, RuntimeStatus::Failed, None, "无法创建 ComfyUI 启动任务。");
            return Err("无法创建 ComfyUI 启动任务。".into());
        }
        // 不设置超时后盲目重试：响应丢失时只查询当前运行状态，不产生第二个服务。
        receiver.recv().map_err(|_| "ComfyUI 启动任务中断，请查看运行输出后再决定是否重试".to_string())??;
        launch_settings::record_launch_port(result.port);
        return Ok(result);
    }
    #[cfg(windows)]
    {
        let message = super::launch_external_windows(app, &installation_root, &settings)?;
        let message = format!("{message}。此安装使用外部启动器，输出仍在其原窗口显示，无法在此捕获。");
        let mut run = RuntimeRun::new(&installation_root, settings.port, RuntimeStatus::External, &message);
        run.append(ConsoleStream::System, message);
        let result = run.start_result();
        *shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())? = Some(run);
        launch_settings::record_launch_port(settings.port);
        return Ok(result);
    }
    #[cfg(not(windows))]
    Err("未找到可直接启动的 ComfyUI main.py 与 Python 环境，请检查安装目录。".into())
}

pub(super) fn notify_main_started(app: &tauri::AppHandle, result: &ComfyUIRuntimeStartResult) {
    if result.status.is_owned_active() {
        let _ = app.emit_to("main", "comfyui-runtime-started", serde_json::json!({ "port": result.port }));
    }
}

pub(super) fn has_active_owned_run(app: &tauri::AppHandle) -> bool {
    let shared = app.state::<ComfyUIRuntimeState>().shared.clone();
    let active = shared.run.lock().map_or(true, |current|
        current.as_ref().is_some_and(|run| run.status.is_owned_active()));
    active
}

/// 主窗口只取当前安装的轻量状态，不开放原始输出。
#[tauri::command]
pub fn get_comfyui_runtime_status(webview: tauri::Webview, app: tauri::AppHandle) -> Result<ComfyUIRuntimeStartResult, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("仅主窗口可以读取 ComfyUI 启动状态".into()); }
    let root = installation::current_installation_root(&app)?;
    let shared = app.state::<ComfyUIRuntimeState>().shared.clone();
    let current = shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())?;
    if let Some(run) = current.as_ref().filter(|run| Some(&run.installation) == root.as_ref()) {
        return Ok(run.start_result());
    }
    Ok(ComfyUIRuntimeStartResult { run_id: None, status: RuntimeStatus::Idle, port: launch_settings::configured_port(&app)?,
        message: "当前安装尚未由本应用启动。".into() })
}

fn management_context(webview: &tauri::Webview, app: &tauri::AppHandle) -> Result<(String, PathBuf), String> {
    management::management_root(webview, app)?;
    Ok((management::management_session_id(app)?, management::authorized_installation_root(app)?))
}

fn recheck_management(webview: &tauri::Webview, app: &tauri::AppHandle, session: &str, root: &Path) -> Result<(), String> {
    let current = management_context(webview, app)?;
    if current.0 != session || current.1 != root { return Err("ComfyUI 管理会话已变化，请重新操作".into()); }
    Ok(())
}

#[tauri::command]
pub async fn start_comfyui_managed(webview: tauri::Webview, app: tauri::AppHandle) -> Result<ComfyUIRuntimeStartResult, String> {
    let (session, root) = management_context(&webview, &app)?;
    let _guard = management::lock_operations().await;
    recheck_management(&webview, &app, &session, &root)?;
    let launch_app = app.clone();
    let launch_root = root.clone();
    let launch_session = session.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if management::management_session_id(&launch_app)? != launch_session {
            return Err("ComfyUI 管理会话已变化，请重新操作".into());
        }
        launch_authorized(&launch_app, &launch_root)
    }).await.map_err(|_| "ComfyUI 启动任务中断，请查看运行状态".to_string())??;
    notify_main_started(&app, &result);
    recheck_management(&webview, &app, &session, &root)?;
    Ok(result)
}

#[tauri::command]
pub async fn stop_comfyui_managed(webview: tauri::Webview, app: tauri::AppHandle, run_id: String) -> Result<String, String> {
    let (session, root) = management_context(&webview, &app)?;
    if run_id.len() > 96 || run_id.is_empty() || run_id.chars().any(char::is_control) {
        return Err("ComfyUI 运行标识无效".into());
    }
    let _guard = management::lock_operations().await;
    recheck_management(&webview, &app, &session, &root)?;
    let shared = app.state::<ComfyUIRuntimeState>().shared.clone();
    let mut current = shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())?;
    let run = current.as_mut().filter(|run| run.id == run_id && run.installation == root && run.status.is_owned_active())
        .ok_or_else(|| "当前服务不是本应用仍在运行的进程，无法从这里停止。".to_string())?;
    run.stop_requested = true;
    run.message = "正在停止由本应用启动的 ComfyUI…".into();
    Ok("已请求停止 ComfyUI，请等待运行状态更新。".into())
}

#[tauri::command]
pub async fn get_comfyui_runtime_snapshot(webview: tauri::Webview, app: tauri::AppHandle,
    run_id: Option<String>, after_sequence: Option<u64>) -> Result<ComfyUIRuntimeSnapshot, String> {
    let (session, root) = management_context(&webview, &app)?;
    if run_id.as_ref().is_some_and(|id| id.len() > 96 || id.chars().any(char::is_control)) {
        return Err("ComfyUI 运行标识无效".into());
    }
    let shared = app.state::<ComfyUIRuntimeState>().shared.clone();
    let snapshot = {
        let current = shared.run.lock().map_err(|_| "ComfyUI 运行状态不可用".to_string())?;
        match current.as_ref().filter(|run| run.installation == root) {
            Some(run) => run.snapshot(run_id.as_deref(), after_sequence),
            None => ComfyUIRuntimeSnapshot { run_id: None, status: RuntimeStatus::Idle, port: launch_settings::configured_port(&app)?,
                exit_code: None, lines: Vec::new(), next_sequence: 0, truncated: false,
                message: "尚未由本应用启动当前安装；从这里启动后即可查看实时输出。".into() },
        }
    };
    recheck_management(&webview, &app, &session, &root)?;
    Ok(snapshot)
}

/// 仅退出整个应用时回收自有进程；关闭管理窗口不触发。外部服务不在这个状态里。
pub fn shutdown_runtime(app: &tauri::AppHandle) {
    let shared = app.state::<ComfyUIRuntimeState>().shared.clone();
    shared.shutting_down.store(true, Ordering::Release);
    if let Ok(current) = shared.run.lock() {
        // 让 supervisor 先关闭进程树和管道；Windows Job 在进程退出时也会关闭并回收。
        drop(shared.finished.wait_timeout_while(current, Duration::from_secs(2), |current|
            current.as_ref().is_some_and(|run| run.status.is_owned_active())));
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_bounded_and_removes_terminal_sequences_across_reads() {
        let mut framer = OutputFramer::default();
        let mut lines = Vec::new();
        framer.read(b"\x1b[3", |line| lines.push(line.to_vec()));
        framer.read(b"1mwarning\x1b[0m\r\nnext\x1b]8;;url\x07text\n", |line| lines.push(line.to_vec()));
        assert_eq!(lines, [b"warning".to_vec(), b"nexttext".to_vec()]);
        framer.read(&vec![b'x'; MAX_LINE_BYTES * 3 + 17], |line| lines.push(line.to_vec()));
        assert!(framer.line.len() < MAX_LINE_BYTES);
        assert!(lines.iter().all(|line| line.len() <= MAX_LINE_BYTES));
    }

    #[test]
    fn redacts_credentials_and_local_prefixes_before_retaining_output() {
        let root = Path::new("/models/ComfyUI");
        assert_eq!(sanitize_output(b"Authorization: Bearer private", root, None), "[已隐藏包含凭据的输出]");
        assert_eq!(sanitize_output(b"https://example.com/api?token=private", root, None), "[已隐藏包含凭据的输出]");
        assert_eq!(sanitize_output(b"api_key = 'private value'", root, None), "[已隐藏包含凭据的输出]");
        assert_eq!(sanitize_output(b"API Key: private", root, None), "[已隐藏包含凭据的输出]");
        assert_eq!(sanitize_output(b"tokenizer loaded /models/ComfyUI/models/a.safetensors", root, None), "tokenizer loaded <ComfyUI>/models/a.safetensors");
        assert_eq!(sanitize_output("中文 /users/example/file".as_bytes(), root, Some(Path::new("/users/example"))), "中文 <用户目录>/file");
        assert_eq!(sanitize_output("model F:\\shared_models\\中文.safetensors".as_bytes(), root, None), "model <外部路径>/中文.safetensors");
        assert_eq!(sanitize_output(b"loaded /opt/shared/model.safetensors", root, None), "loaded <外部路径>/model.safetensors");
        assert_eq!(sanitize_output(b"https://example.com/docs", root, None), "https://example.com/docs");
        assert_eq!(sanitize_output(b"To see the GUI go to: http://127.0.0.1:8188", root, None), "To see the GUI go to: http://127.0.0.1:8188");
    }

    #[test]
    fn ring_cursor_replays_uses_batches_and_reports_lost_lines() {
        let mut run = RuntimeRun::new(Path::new("/comfy"), 8188, RuntimeStatus::Starting, "starting");
        for _ in 0..(MAX_LINES + 5) { run.append(ConsoleStream::Stderr, "info".into()); }
        assert!(run.lines.len() <= MAX_LINES);
        let first = run.snapshot(None, Some(9999));
        assert!(first.truncated);
        assert_eq!(first.lines.len(), SNAPSHOT_LINES);
        let next = run.snapshot(Some(&run.id), Some(first.next_sequence));
        assert!(!next.truncated);
        assert_eq!(next.lines[0].sequence, first.next_sequence + 1);
        for _ in 0..100 { run.append(ConsoleStream::Stdout, "x".repeat(MAX_LINE_BYTES)); }
        assert!(run.bytes <= MAX_BYTES);
    }

    #[test]
    fn previous_process_output_cannot_cross_into_a_new_run() {
        let shared = RuntimeShared::default();
        let old = RuntimeRun::new(Path::new("/first"), 8188, RuntimeStatus::Exited, "exited");
        let old_id = old.id.clone();
        let new = RuntimeRun::new(Path::new("/second"), 8190, RuntimeStatus::Starting, "starting");
        *shared.run.lock().unwrap() = Some(new);
        shared.append(&old_id, ConsoleStream::Stderr, "old private output".into());
        assert!(shared.run.lock().unwrap().as_ref().unwrap().lines.is_empty());
    }
}
