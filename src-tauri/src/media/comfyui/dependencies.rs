//! 依赖安装的会话租约、取消及固定进度；原始 pip 输出只在有界行缓冲中短暂解析。
use super::{current_session, ManagementSession, ManagementState};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

const MAX_PENDING_CANCELLATIONS: usize = 32;
const MAX_LINE_BYTES: usize = 8192;
const CANCELLED: &str = "已取消依赖安装";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Stage {
    Waiting, Confirming, Checking, Resolving, Downloading, Building, Installing,
    Completed, Cancelled, Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum FailureKind { Network, DependencyConflict, DiskSpace, Permission, Build, Environment, Timeout, Cancelled, Unknown }

impl FailureKind {
    fn priority(self) -> u8 {
        match self {
            Self::Unknown => 0, Self::Environment => 1, Self::Build => 2, Self::Network => 3,
            Self::DependencyConflict => 4, Self::Permission => 5, Self::DiskSpace => 6,
            Self::Timeout => 7, Self::Cancelled => 8,
        }
    }

    fn merge(self, incoming: Self) -> Self {
        if incoming.priority() > self.priority() { incoming } else { self }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Network => "依赖下载连接失败，请检查网络、软件包源、代理和证书配置后再试。",
            Self::DependencyConflict => "依赖版本存在冲突，请核对插件要求与当前 Python 环境的软件包版本。",
            Self::DiskSpace => "依赖安装磁盘空间不足，请释放空间后检查当前环境状态。",
            Self::Permission => "依赖安装被文件访问权限阻止，请检查安装目录权限或占用情况。",
            Self::Build => "依赖构建失败，请确认 Python 版本、编译工具和插件要求是否兼容。",
            Self::Environment => "依赖安装环境检查失败，请核对 Python、pip 和 requirements.txt 后再试。",
            Self::Timeout => "依赖安装已超时并停止；已完成的软件包更改会保留，请确认环境状态后再试。",
            Self::Cancelled => CANCELLED,
            Self::Unknown => "依赖安装未完成，请核对插件要求与当前环境；已完成的软件包更改可能保留。",
        }
    }
}

pub(super) struct Failure { pub(super) kind: FailureKind, pub(super) message: &'static str }
impl Failure {
    pub(super) fn new(kind: FailureKind) -> Self { Self { kind, message: kind.message() } }
    pub(super) fn environment(message: &'static str) -> Self { Self { kind: FailureKind::Environment, message } }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Key { request_id: String, session_id: String, installation_root: PathBuf, source_root: PathBuf }
impl Key {
    fn new(request_id: &str, session: &ManagementSession) -> Self {
        Self { request_id: request_id.into(), session_id: session.id.clone(),
            installation_root: session.installation_root.clone(), source_root: session.source_root.clone() }
    }
    fn same_scope(&self, other: &Self) -> bool {
        self.session_id == other.session_id && self.installation_root == other.installation_root && self.source_root == other.source_root
    }
    fn current(&self, app: &AppHandle) -> bool {
        current_session(app).is_ok_and(|session| self.same_scope(&Self::new(&self.request_id, &session)))
    }
}

struct Job { key: Key, cancelled: AtomicBool }
#[derive(Default)]
struct Registry { active: Option<Arc<Job>>, pending_cancellations: VecDeque<Key> }
#[derive(Default)]
pub(super) struct TaskState(Mutex<Registry>);

fn valid_request_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

impl Registry {
    fn begin(&mut self, key: Key) -> Result<Arc<Job>, String> {
        self.pending_cancellations.retain(|entry| entry.same_scope(&key));
        if self.active.as_ref().is_some_and(|active| active.key.same_scope(&key)) {
            return Err("已有依赖安装正在处理，请先等待结束或取消。".into());
        }
        if let Some(previous) = self.active.take() { previous.cancelled.store(true, Ordering::Release); }
        let cancelled = self.pending_cancellations.iter().any(|entry| entry == &key);
        let job = Arc::new(Job { key, cancelled: AtomicBool::new(cancelled) });
        self.active = Some(job.clone());
        Ok(job)
    }

    fn cancel(&mut self, key: Key) -> Result<(), String> {
        if let Some(active) = self.active.as_ref().filter(|active| active.key == key) {
            active.cancelled.store(true, Ordering::Release);
            return Ok(());
        }
        self.pending_cancellations.retain(|entry| entry.same_scope(&key));
        if self.pending_cancellations.contains(&key) { return Ok(()); }
        if self.pending_cancellations.len() >= MAX_PENDING_CANCELLATIONS {
            return Err("依赖取消记录已达上限，未接受本次取消；请等待当前任务结束或重新打开管理窗口。".into());
        }
        self.pending_cancellations.push_back(key);
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    request_id: &'a str, stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_kind: Option<FailureKind>,
}

struct ProgressState { last: Option<(Stage, Option<String>)>, sent_at: Instant, failure: FailureKind }

#[derive(Clone)]
pub(super) struct Control { app: AppHandle, job: Arc<Job>, channel: Channel<String>, progress: Arc<Mutex<ProgressState>> }
pub(super) struct Task { control: Control }
impl Task {
    pub(super) fn control(&self) -> Control { self.control.clone() }
}
impl Drop for Task {
    fn drop(&mut self) {
        self.control.job.cancelled.store(true, Ordering::Release);
        if let Ok(mut registry) = self.control.app.state::<ManagementState>().2.0.lock() {
            if registry.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, &self.control.job)) { registry.active = None; }
        };
    }
}

pub(super) fn begin(app: &AppHandle, session: &ManagementSession, request_id: &str, channel: Channel<String>) -> Result<Task, String> {
    if !valid_request_id(request_id) { return Err("依赖安装请求标识无效。".into()); }
    let state = app.state::<ManagementState>();
    let job = state.2.0.lock().map_err(|_| "依赖安装状态不可用。".to_string())?.begin(Key::new(request_id, session))?;
    Ok(Task { control: Control { app: app.clone(), job, channel,
        progress: Arc::new(Mutex::new(ProgressState { last: None, sent_at: Instant::now(), failure: FailureKind::Unknown })) } })
}

pub(super) fn cancel(app: &AppHandle, session: &ManagementSession, request_id: &str) -> Result<(), String> {
    if !valid_request_id(request_id) { return Err("依赖安装请求标识无效。".into()); }
    app.state::<ManagementState>().2.0.lock().map_err(|_| "依赖安装状态不可用。".to_string())?
        .cancel(Key::new(request_id, session))
}

impl Control {
    pub(super) fn check(&self) -> Result<(), Failure> {
        if self.job.cancelled.load(Ordering::Acquire) || !self.job.key.current(&self.app) { Err(Failure::new(FailureKind::Cancelled)) } else { Ok(()) }
    }

    fn emit(&self, stage: Stage, package_name: Option<String>, failure_kind: Option<FailureKind>, force: bool) {
        let Ok(mut state) = self.progress.lock() else { self.job.cancelled.store(true, Ordering::Release); return; };
        if !force && (state.last.as_ref() == Some(&(stage, package_name.clone())) || state.sent_at.elapsed() < Duration::from_millis(100)) { return; }
        let progress = Progress { request_id: &self.job.key.request_id, stage, package_name: package_name.as_deref(), failure_kind };
        if serde_json::to_string(&progress).ok().is_none_or(|message| self.channel.send(message).is_err()) {
            self.job.cancelled.store(true, Ordering::Release);
        }
        state.last = Some((stage, package_name)); state.sent_at = Instant::now();
    }

    pub(super) fn stage(&self, stage: Stage) { self.emit(stage, None, None, true); }
    pub(super) fn finish(&self, result: &Result<(), Failure>) {
        match result {
            Ok(()) => self.emit(Stage::Completed, None, None, true),
            Err(error) => self.emit(if error.kind == FailureKind::Cancelled { Stage::Cancelled } else { Stage::Failed }, None, Some(error.kind), true),
        }
    }

    fn observe(&self, line: &str) {
        if self.job.cancelled.load(Ordering::Acquire) { return; }
        if let Some(kind) = failure_kind(line) {
            if let Ok(mut state) = self.progress.lock() {
                state.failure = state.failure.merge(kind);
            }
        }
        if let Some((stage, package)) = parse_progress(line) { self.emit(stage, package, None, false); }
    }

    fn failure(&self) -> Failure {
        Failure::new(self.progress.lock().map(|state| state.failure).unwrap_or(FailureKind::Unknown))
    }
}

fn package_name(value: &str) -> Option<String> {
    let value = value.split(|ch: char| ch.is_ascii_whitespace() || "[=<>!~;,".contains(ch)).next()?;
    if value.is_empty() || value.len() > 80 || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')) { return None; }
    Some(value.into())
}

fn archive_package(value: &str) -> Option<String> {
    let file = value.split_whitespace().next()?;
    if !file.ends_with(".whl") || file.contains(['/', '\\', ':', '@', '?', '#']) { return None; }
    package_name(file.split('-').next()?)
}

fn parse_progress(line: &str) -> Option<(Stage, Option<String>)> {
    let line = line.trim();
    for prefix in ["Collecting ", "Requirement already satisfied: "] {
        if let Some(value) = line.strip_prefix(prefix) { return Some((Stage::Resolving, package_name(value))); }
    }
    for prefix in ["Downloading ", "Using cached "] {
        if let Some(value) = line.strip_prefix(prefix) { return Some((Stage::Downloading, archive_package(value))); }
    }
    for prefix in ["Building wheel for ", "Running setup.py install for "] {
        if let Some(value) = line.strip_prefix(prefix) { return Some((Stage::Building, package_name(value))); }
    }
    if ["Installing build dependencies", "Getting requirements to build wheel", "Preparing metadata ("].iter().any(|prefix| line.starts_with(prefix)) {
        return Some((Stage::Building, None));
    }
    if line.starts_with("Installing collected packages:") || line.starts_with("Successfully installed ") { return Some((Stage::Installing, None)); }
    None
}

fn failure_kind(line: &str) -> Option<FailureKind> {
    let line = line.to_ascii_lowercase();
    [
        (FailureKind::DiskSpace, &["no space left on device", "disk full", "not enough space"][..]),
        (FailureKind::Permission, &["permission denied", "access is denied", "winerror 5"][..]),
        (FailureKind::DependencyConflict, &["resolutionimpossible", "conflicting dependencies", "dependency conflict"][..]),
        (FailureKind::Build, &["failed building wheel", "failed to build", "subprocess-exited-with-error", "metadata-generation-failed"][..]),
        (FailureKind::Environment, &["no matching distribution found", "could not find a version that satisfies", "no module named pip"][..]),
        (FailureKind::Network, &["readtimeout", "connecttimeout", "connectionerror", "max retries exceeded", "could not fetch url", "temporary failure in name resolution", "certificate_verify_failed", "proxyerror", "network is unreachable", "connection refused"][..]),
    ].into_iter().find_map(|(kind, patterns)| patterns.iter().any(|pattern| line.contains(pattern)).then_some(kind))
}

fn read_status(mut pipe: impl Read, control: Control) {
    let mut buffer = [0_u8; 4096];
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let count = match pipe.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(count) => count };
        for &byte in &buffer[..count] {
            if matches!(byte, b'\r' | b'\n') {
                if !oversized { if let Ok(text) = std::str::from_utf8(&line) { control.observe(text); } }
                line.clear(); oversized = false;
            } else if line.len() < MAX_LINE_BYTES { line.push(byte); } else { oversized = true; }
        }
    }
    if !oversized { if let Ok(text) = std::str::from_utf8(&line) { control.observe(text); } }
}

struct Process {
    child: Child,
    #[cfg(windows)]
    job: super::ProcessJob,
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(windows)]
        self.job.terminate();
        #[cfg(unix)]
        unsafe {
            unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
            if let Ok(pid) = i32::try_from(self.child.id()) { let _ = kill(-pid, 9); }
        }
        let _ = self.child.kill(); let _ = self.child.wait();
    }
}

pub(super) fn run(mut command: Command, control: Control) -> Result<(), Failure> {
    control.check()?;
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1").env("PIP_NO_COLOR", "1").env("PIP_PROGRESS_BAR", "off");
    #[cfg(windows)]
    command.creation_flags(super::super::CREATE_NO_WINDOW);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|_| Failure::new(FailureKind::Environment))?;
    #[cfg(windows)]
    let mut child = child;
    #[cfg(windows)]
    let job = match super::ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err(Failure::new(FailureKind::Environment)); }
    };
    let mut process = Process { child, #[cfg(windows)] job };
    let stdout = process.child.stdout.take().ok_or_else(|| Failure::new(FailureKind::Environment))?;
    let stderr = process.child.stderr.take().ok_or_else(|| Failure::new(FailureKind::Environment))?;
    let stdout_control = control.clone();
    let output = std::thread::spawn(move || read_status(stdout, stdout_control));
    let error_control = control.clone();
    let errors = std::thread::spawn(move || read_status(stderr, error_control));
    let deadline = Instant::now() + Duration::from_secs(600);
    let result = loop {
        if let Err(error) = control.check() { break Err(error); }
        if Instant::now() >= deadline { break Err(Failure::new(FailureKind::Timeout)); }
        match process.child.try_wait() {
            Ok(Some(status)) => break if status.success() { Ok(()) } else { Err(Failure::new(FailureKind::Unknown)) },
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => break Err(Failure::new(FailureKind::Environment)),
        }
    };
    drop(process);
    let output_ok = output.join().is_ok();
    let errors_ok = errors.join().is_ok();
    if !output_ok || !errors_ok { return Err(Failure::new(FailureKind::Environment)); }
    control.check()?;
    match result {
        Err(error) if error.kind == FailureKind::Unknown => Err(control.failure()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(session: &str, installation: &str, request: &str) -> Key {
        Key { session_id: session.into(), installation_root: installation.into(), source_root: format!("{installation}/ComfyUI").into(), request_id: request.into() }
    }

    #[test]
    fn cancellation_before_registration_is_scoped_to_request_session_and_installation() {
        let mut registry = Registry::default();
        registry.cancel(key("session-a", "install-a", "request-one")).unwrap();
        let unrelated = registry.begin(key("session-a", "install-a", "request-two")).unwrap();
        assert!(!unrelated.cancelled.load(Ordering::Acquire));
        registry.active = None;
        let cancelled = registry.begin(key("session-a", "install-a", "request-one")).unwrap();
        assert!(cancelled.cancelled.load(Ordering::Acquire));
        registry.active = None;
        registry.cancel(key("session-a", "install-a", "request-three")).unwrap();
        let reopened = registry.begin(key("session-b", "install-b", "request-three")).unwrap();
        assert!(!reopened.cancelled.load(Ordering::Acquire));
        registry.cancel(key("session-b", "install-b", "another-request")).unwrap();
        assert!(!reopened.cancelled.load(Ordering::Acquire));
        registry.cancel(key("session-a", "install-b", "request-three")).unwrap();
        assert!(!reopened.cancelled.load(Ordering::Acquire));
        registry.cancel(key("session-b", "install-a", "request-three")).unwrap();
        assert!(!reopened.cancelled.load(Ordering::Acquire));
        registry.cancel(key("session-b", "install-b", "request-three")).unwrap();
        assert!(reopened.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn pending_cancellation_capacity_never_forgets_an_accepted_request() {
        let mut registry = Registry::default();
        for index in 0..MAX_PENDING_CANCELLATIONS { registry.cancel(key("session", "installation", &format!("request-{index}"))).unwrap(); }
        assert!(registry.cancel(key("session", "installation", "overflow-request")).is_err());
        assert!(registry.cancel(key("session", "installation", "request-0")).is_ok());
        assert_eq!(registry.pending_cancellations.len(), MAX_PENDING_CANCELLATIONS);
        let earliest = registry.begin(key("session", "installation", "request-0")).unwrap();
        assert!(earliest.cancelled.load(Ordering::Acquire));
        registry.active = None;
        let replay = registry.begin(key("session", "installation", "request-0")).unwrap();
        assert!(replay.cancelled.load(Ordering::Acquire));
        assert!(!valid_request_id("x"));
        assert!(!valid_request_id("https://secret.example/token"));
    }

    #[test]
    fn only_fixed_phases_and_package_identifiers_leave_the_parser() {
        assert_eq!(parse_progress("Collecting torch>=2.0 (from -r private-file)"), Some((Stage::Resolving, Some("torch".into()))));
        assert_eq!(parse_progress("Downloading safetensors-0.4.0-cp312-win_amd64.whl (1 MB)"), Some((Stage::Downloading, Some("safetensors".into()))));
        assert_eq!(parse_progress("Building wheel for numpy (pyproject.toml)"), Some((Stage::Building, Some("numpy".into()))));
        assert_eq!(parse_progress("Collecting https://user:secret@example.com/package"), Some((Stage::Resolving, None)));
        assert_eq!(parse_progress("Downloading /private/path/file.whl"), Some((Stage::Downloading, None)));
        assert_eq!(parse_progress("Successfully installed torch-2.0"), Some((Stage::Installing, None)));
        assert_eq!(parse_progress("Untrusted raw body and credentials"), None);
        assert_eq!(failure_kind("ERROR: ResolutionImpossible: details"), Some(FailureKind::DependencyConflict));
        assert_eq!(failure_kind("OSError: [Errno 28] No space left on device: private-path"), Some(FailureKind::DiskSpace));
        assert_eq!(failure_kind("Retrying: ProxyError(secret-url)"), Some(FailureKind::Network));
    }

    #[test]
    fn network_root_cause_survives_generic_resolver_and_build_followup_errors() {
        for lines in [
            vec!["Retrying: ProxyError(private-url)", "ERROR: Could not find a version that satisfies the requirement numpy", "ERROR: No matching distribution found"],
            vec!["ERROR: Could not fetch URL private-url", "error: subprocess-exited-with-error", "ERROR: No matching distribution found"],
        ] {
            let kind = lines.into_iter().filter_map(failure_kind).fold(FailureKind::Unknown, FailureKind::merge);
            assert_eq!(kind, FailureKind::Network);
        }
        let kind = ["Retrying: ProxyError(private-url)", "OSError: No space left on device"]
            .into_iter().filter_map(failure_kind).fold(FailureKind::Unknown, FailureKind::merge);
        assert_eq!(kind, FailureKind::DiskSpace);
    }
}
