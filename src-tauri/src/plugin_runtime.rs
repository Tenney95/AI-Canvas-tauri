//! 用户插件运行时。
//!
//! 每次调用创建独立 Runtime，不安装模块、文件、网络或 Tauri 宿主函数；
//! JavaScript 继续使用 QuickJS 强沙箱。Python 插件是用户显式信任的本机代码，
//! 通过一次性子进程执行；这里只提供协议、超时和输出上限，不宣称操作系统隔离。

use rquickjs::{Context, Runtime};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Webview};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::{io::AsRawHandle, process::CommandExt};

const MAX_SOURCE_BYTES: usize = 512 * 1024;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 512 * 1024;
const JAVASCRIPT_EXECUTION_TIMEOUT: Duration = Duration::from_secs(2);
const PYTHON_EXECUTION_TIMEOUT: Duration = Duration::from_secs(30);
const PYTHON_PROBE_CANDIDATE_TIMEOUT: Duration = Duration::from_secs(3);
const PYTHON_STATUS_PROBE_TIMEOUT: Duration = Duration::from_secs(9);
const PYTHON_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const PYTHON_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_PYTHON_PROBE_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

type InvocationKey = (String, String);
type ActiveInvocationMap = HashMap<InvocationKey, Arc<AtomicBool>>;

static ACTIVE_PYTHON_INVOCATIONS: OnceLock<Mutex<ActiveInvocationMap>> = OnceLock::new();

fn active_python_invocations() -> &'static Mutex<ActiveInvocationMap> {
    ACTIVE_PYTHON_INVOCATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ActivePythonInvocation {
    key: InvocationKey,
    cancelled: Arc<AtomicBool>,
}

impl ActivePythonInvocation {
    fn register(plugin_id: &str, invocation_id: &str) -> Result<Self, String> {
        validate_invocation_id(invocation_id)?;
        let key = (plugin_id.to_string(), invocation_id.to_string());
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut invocations = active_python_invocations()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if invocations.contains_key(&key) {
            return Err("插件调用 ID 正在使用".to_string());
        }
        invocations.insert(key.clone(), Arc::clone(&cancelled));
        Ok(Self { key, cancelled })
    }
}

fn validate_invocation_id(invocation_id: &str) -> Result<(), String> {
    if invocation_id.is_empty()
        || invocation_id.len() > 128
        || !invocation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err("插件调用 ID 无效".to_string())
    } else {
        Ok(())
    }
}

impl Drop for ActivePythonInvocation {
    fn drop(&mut self) {
        let mut invocations = active_python_invocations()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if invocations
            .get(&self.key)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
        {
            invocations.remove(&self.key);
        }
    }
}

/// 取消某个插件当前仍在运行的所有 Python 调用。
///
/// 插件停用、卸载或被禁用名单命中时由原生注册表调用。调用记录由执行守卫在
/// 子进程结束后移除，因此这里仅设置原子标记，避免与等待线程争用进程句柄。
pub fn cancel_plugin_invocations(plugin_id: &str) {
    let invocations = active_python_invocations()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for ((active_plugin_id, _), cancelled) in invocations.iter() {
        if active_plugin_id == plugin_id {
            cancelled.store(true, Ordering::Release);
        }
    }
}

#[cfg(windows)]
struct PythonProcessJob(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl PythonProcessJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::HANDLE,
                System::JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            },
        };

        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|_| "无法创建 Python 插件 Windows Job Object".to_string())?;
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|_| "无法配置 Python 插件 Windows Job Object".to_string())?;

        let process = HANDLE(child.as_raw_handle());
        unsafe { AssignProcessToJobObject(job.0, process) }
            .map_err(|_| "无法将 Python 插件进程绑定到 Windows Job Object".to_string())?;
        Ok(job)
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1223);
        }
    }
}

#[cfg(windows)]
impl Drop for PythonProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

struct PythonProcessTree {
    #[cfg(windows)]
    job: PythonProcessJob,
}

impl PythonProcessTree {
    fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            Ok(Self {
                job: PythonProcessJob::attach(child)?,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    fn terminate(&self, child: &mut Child) {
        #[cfg(windows)]
        self.job.terminate();

        #[cfg(unix)]
        {
            const SIGKILL: i32 = 9;

            if let Ok(process_group) = i32::try_from(child.id()) {
                unsafe extern "C" {
                    fn kill(pid: i32, signal: i32) -> i32;
                }
                // SAFETY: `process_group` is the positive child PID assigned as its dedicated
                // PGID. Its negation targets only that group, and SIGKILL borrows no Rust data.
                unsafe {
                    let _ = kill(-process_group, SIGKILL);
                }
            }
        }

        let _ = child.kill();
    }
}

struct ManagedPythonProcess {
    child: Option<Child>,
    process_tree: PythonProcessTree,
    reaped: bool,
}

impl ManagedPythonProcess {
    fn spawn(command: &mut Command, cleanup_deadline: Instant) -> Result<Self, String> {
        let child = command
            .spawn()
            .map_err(|error| format!("启动 Python 子进程失败: {error}"))?;
        let process_tree = match PythonProcessTree::attach(&child) {
            Ok(process_tree) => process_tree,
            Err(error) => {
                terminate_unmanaged_python_process(child, cleanup_deadline);
                return Err(error);
            }
        };
        Ok(Self {
            child: Some(child),
            process_tree,
            reaped: false,
        })
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("managed child must be present")
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.child_mut().try_wait()?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }

    fn terminate_tree(&mut self) {
        if let Some(child) = self.child.as_mut() {
            self.process_tree.terminate(child);
        }
    }

    fn wait_until(&mut self, deadline: Instant) {
        loop {
            match self.try_wait() {
                Ok(Some(_)) | Err(_) => return,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(PYTHON_PROCESS_POLL_INTERVAL);
                }
                Ok(None) => return,
            }
        }
    }

    fn terminate_and_wait(&mut self, deadline: Instant) {
        self.terminate_tree();
        self.wait_until(deadline);
    }
}

impl Drop for ManagedPythonProcess {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        self.process_tree.terminate(&mut child);
        if !self.reaped {
            // Never extend the caller's deadline merely to reap. The process tree has already
            // been terminated; a detached waiter prevents a Unix zombie if exit is slightly late.
            let _ = thread::Builder::new()
                .name("plugin-python-reaper".to_string())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}

fn terminate_unmanaged_python_process(mut child: Child, deadline: Instant) {
    let _ = child.kill();
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(PYTHON_PROCESS_POLL_INTERVAL);
            }
            Ok(None) => {
                let _ = thread::Builder::new()
                    .name("plugin-python-reaper".to_string())
                    .spawn(move || {
                        let _ = child.wait();
                    });
                return;
            }
        }
    }
}

const PYTHON_RUNNER: &str = r#"
import contextlib
import inspect
import json
import sys

class _DiscardOutput:
    def write(self, value):
        return len(value)

    def flush(self):
        return None

def _run():
    payload = json.load(sys.stdin)
    definition = None

    def define_plugin(value):
        nonlocal definition
        if definition is not None:
            raise RuntimeError("define_plugin 只能调用一次")
        definition = value

    namespace = {"__name__": "__ai_canvas_plugin__", "define_plugin": define_plugin}
    discarded = _DiscardOutput()
    with contextlib.redirect_stdout(discarded), contextlib.redirect_stderr(discarded):
        exec(compile(payload["source"], "<ai-canvas-plugin>", "exec"), namespace, namespace)
        if not isinstance(definition, dict):
            raise RuntimeError("插件必须调用 define_plugin")
        tools = definition.get("tools")
        tool = tools.get(payload["toolId"]) if isinstance(tools, dict) else None
        if not callable(tool):
            raise RuntimeError("插件未注册该节点工具")
        result = tool(payload["input"])
        if inspect.isawaitable(result):
            raise RuntimeError("Python 插件工具不支持异步返回值")
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

try:
    _run()
except BaseException as error:
    message = str(error).replace("\r", " ").replace("\n", " ")[:4096]
    sys.stderr.write(f"{type(error).__name__}: {message}")
    raise SystemExit(1)
"#;

#[derive(Clone, Debug)]
struct PythonCommand {
    program: String,
    prefix_args: Vec<String>,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonPluginRuntimeStatus {
    available: bool,
    command: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[cfg(windows)]
fn configure_background_process(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn configure_background_process(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn configure_background_process(_command: &mut Command) {}

fn bounded_shutdown_deadline(overall_deadline: Instant) -> Instant {
    overall_deadline.min(Instant::now() + PYTHON_SHUTDOWN_TIMEOUT)
}

fn python_work_deadline(hard_deadline: Instant) -> Instant {
    let now = Instant::now();
    let remaining = hard_deadline.saturating_duration_since(now);
    let cleanup_reserve = PYTHON_SHUTDOWN_TIMEOUT.min(remaining / 4);
    hard_deadline.checked_sub(cleanup_reserve).unwrap_or(now)
}

fn python_candidates() -> Vec<PythonCommand> {
    #[cfg(windows)]
    let candidates = vec![
        ("python", vec![], "python"),
        ("py", vec!["-3"], "py -3"),
        ("python3", vec![], "python3"),
    ];
    #[cfg(not(windows))]
    let candidates = vec![("python3", vec![], "python3"), ("python", vec![], "python")];

    candidates
        .into_iter()
        .map(|(program, args, label)| PythonCommand {
            program: program.to_string(),
            prefix_args: args.into_iter().map(str::to_string).collect(),
            label: label.to_string(),
        })
        .collect()
}

fn run_python_probe_command(
    command: &mut Command,
    deadline: Instant,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<Vec<u8>>, String> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Python 环境检测已取消".to_string());
    }
    if Instant::now() >= deadline {
        return Ok(None);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_background_process(command);
    let mut process =
        match ManagedPythonProcess::spawn(command, bounded_shutdown_deadline(deadline)) {
            Ok(process) => process,
            Err(_) => return Ok(None),
        };
    let Some(stdout) = process.child_mut().stdout.take() else {
        process.terminate_and_wait(bounded_shutdown_deadline(deadline));
        return Ok(None);
    };
    let Some(stderr) = process.child_mut().stderr.take() else {
        drop(stdout);
        process.terminate_and_wait(bounded_shutdown_deadline(deadline));
        return Ok(None);
    };
    let stdout_reader = spawn_limited_reader(stdout, MAX_PYTHON_PROBE_OUTPUT_BYTES);
    let stderr_reader = spawn_limited_reader(stderr, MAX_PYTHON_PROBE_OUTPUT_BYTES);
    let work_deadline = python_work_deadline(deadline);

    let exit_status = loop {
        match process.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let shutdown_deadline = bounded_shutdown_deadline(deadline);
                process.terminate_and_wait(shutdown_deadline);
                let _ = receive_python_output(stdout_reader, stderr_reader, shutdown_deadline);
                return Ok(None);
            }
        }
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            let shutdown_deadline = bounded_shutdown_deadline(deadline);
            process.terminate_and_wait(shutdown_deadline);
            let _ = receive_python_output(stdout_reader, stderr_reader, shutdown_deadline);
            return Err("Python 环境检测已取消".to_string());
        }
        if Instant::now() >= work_deadline {
            process.terminate_and_wait(deadline);
            let _ = receive_python_output(stdout_reader, stderr_reader, deadline);
            return Ok(None);
        }
        thread::sleep(PYTHON_PROCESS_POLL_INTERVAL);
    };

    process.terminate_tree();
    let output_deadline = bounded_shutdown_deadline(deadline);
    let Ok(((stdout, stdout_exceeded), _)) =
        receive_python_output(stdout_reader, stderr_reader, output_deadline)
    else {
        return Ok(None);
    };
    if !exit_status.success() || stdout_exceeded {
        return Ok(None);
    }
    Ok(Some(stdout))
}

fn probe_python(
    candidate: &PythonCommand,
    deadline: Instant,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<String>, String> {
    let mut command = Command::new(&candidate.program);
    command.args(&candidate.prefix_args).args([
        "-c",
        "import sys; print('.'.join(map(str, sys.version_info[:3])))",
    ]);
    let Some(stdout) = run_python_probe_command(&mut command, deadline, cancelled)? else {
        return Ok(None);
    };
    let Ok(version) = String::from_utf8(stdout) else {
        return Ok(None);
    };
    let version = version.trim().to_string();
    if version.is_empty()
        || version.split('.').next() != Some("3")
        || !version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        Ok(None)
    } else {
        Ok(Some(version))
    }
}

fn find_python(
    deadline: Instant,
    cancelled: Option<&AtomicBool>,
) -> Result<(PythonCommand, String), String> {
    for candidate in python_candidates() {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err("Python 环境检测已取消".to_string());
        }
        if Instant::now() >= deadline {
            return Err("Python 环境检测超时".to_string());
        }
        let candidate_deadline = deadline.min(Instant::now() + PYTHON_PROBE_CANDIDATE_TIMEOUT);
        if let Some(version) = probe_python(&candidate, candidate_deadline, cancelled)? {
            return Ok((candidate, version));
        }
    }
    if Instant::now() >= deadline {
        return Err("Python 环境检测超时".to_string());
    }
    Err(
        "未找到可用的 Python 3。请安装 Python，并确保 python、python3 或 Windows py -3 可用"
            .to_string(),
    )
}

fn read_limited<R: Read>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut stored = Vec::with_capacity(limit.min(8192));
    let mut exceeded = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取插件子进程输出失败: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(stored.len());
        if remaining > 0 {
            stored.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        if count > remaining {
            exceeded = true;
        }
    }
    Ok((stored, exceeded))
}

type InputWriteResult = Result<(), String>;

fn spawn_python_input_writer<W>(mut writer: W, input: Vec<u8>) -> Receiver<InputWriteResult>
where
    W: Write + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = writer
            .write_all(&input)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("写入 Python 插件输入失败: {error}"));
        drop(writer);
        let _ = sender.send(result);
    });
    receiver
}

fn receive_python_input_writer(
    receiver: Receiver<InputWriteResult>,
    deadline: Instant,
) -> InputWriteResult {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match receiver.recv_timeout(remaining) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err("等待 Python 插件输入管道关闭超时".to_string()),
        Err(RecvTimeoutError::Disconnected) => Err("Python 插件输入写入线程异常".to_string()),
    }
}

type LimitedReadResult = Result<(Vec<u8>, bool), String>;

fn spawn_limited_reader<R>(reader: R, limit: usize) -> Receiver<LimitedReadResult>
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(read_limited(reader, limit));
    });
    receiver
}

fn receive_limited_reader(
    receiver: Receiver<LimitedReadResult>,
    deadline: Instant,
    label: &str,
) -> LimitedReadResult {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match receiver.recv_timeout(remaining) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(format!("等待 Python 插件{label}管道关闭超时")),
        Err(RecvTimeoutError::Disconnected) => Err(format!("Python 插件{label}读取线程异常")),
    }
}

fn receive_python_output(
    stdout_reader: Receiver<LimitedReadResult>,
    stderr_reader: Receiver<LimitedReadResult>,
    deadline: Instant,
) -> Result<((Vec<u8>, bool), (Vec<u8>, bool)), String> {
    let stdout = receive_limited_reader(stdout_reader, deadline, "输出")?;
    let stderr = receive_limited_reader(stderr_reader, deadline, "错误")?;
    Ok((stdout, stderr))
}

#[cfg(test)]
fn execute_python_with_command(
    python: &PythonCommand,
    source: String,
    tool_id: String,
    input: Value,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    let hard_deadline = Instant::now() + timeout;
    execute_python_with_command_until(
        python,
        source,
        tool_id,
        input,
        hard_deadline,
        timeout,
        cancelled,
    )
}

fn execute_python_with_command_until(
    python: &PythonCommand,
    source: String,
    tool_id: String,
    input: Value,
    hard_deadline: Instant,
    timeout_label: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Python 插件执行已取消".to_string());
    }
    if Instant::now() >= hard_deadline {
        return Err(format!(
            "Python 插件执行超过 {} 秒，已终止",
            timeout_label.as_secs()
        ));
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err("插件源码超过 512 KiB 上限".to_string());
    }
    if tool_id.is_empty() || tool_id.len() > 64 {
        return Err("插件工具 ID 无效".to_string());
    }
    let envelope = serde_json::json!({ "source": source, "toolId": tool_id, "input": input });
    let input_json = serde_json::to_vec(&envelope)
        .map_err(|error| format!("Python 插件输入序列化失败: {error}"))?;
    if input_json.len() > MAX_INPUT_BYTES + MAX_SOURCE_BYTES {
        return Err("Python 插件输入超过上限".to_string());
    }
    if Instant::now() >= hard_deadline {
        return Err(format!(
            "Python 插件执行超过 {} 秒，已终止",
            timeout_label.as_secs()
        ));
    }

    let mut command = Command::new(&python.program);
    command
        .args(&python.prefix_args)
        .args(["-u", "-c", PYTHON_RUNNER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env_remove("AI_CANVAS_PLUGIN_INPUT")
        .env_remove("AI_CANVAS_PLUGIN_OUTPUT");
    configure_background_process(&mut command);
    let mut process =
        ManagedPythonProcess::spawn(&mut command, bounded_shutdown_deadline(hard_deadline))
            .map_err(|error| format!("启动 Python 插件进程失败: {error}"))?;

    let Some(stdin) = process.child_mut().stdin.take() else {
        process.terminate_and_wait(bounded_shutdown_deadline(hard_deadline));
        return Err("无法打开 Python 插件输入".to_string());
    };
    let Some(stdout) = process.child_mut().stdout.take() else {
        drop(stdin);
        process.terminate_and_wait(bounded_shutdown_deadline(hard_deadline));
        return Err("无法读取 Python 插件输出".to_string());
    };
    let Some(stderr) = process.child_mut().stderr.take() else {
        drop(stdin);
        drop(stdout);
        process.terminate_and_wait(bounded_shutdown_deadline(hard_deadline));
        return Err("无法读取 Python 插件错误".to_string());
    };
    let stdout_reader = spawn_limited_reader(stdout, MAX_OUTPUT_BYTES);
    let stderr_reader = spawn_limited_reader(stderr, MAX_ERROR_BYTES);
    let input_writer = spawn_python_input_writer(stdin, input_json);
    let mut input_write_complete = false;
    let work_deadline = python_work_deadline(hard_deadline);

    let exit_status = loop {
        if !input_write_complete {
            match input_writer.try_recv() {
                Ok(Ok(())) => input_write_complete = true,
                Ok(Err(error)) => {
                    let shutdown_deadline = bounded_shutdown_deadline(hard_deadline);
                    process.terminate_and_wait(shutdown_deadline);
                    let _ = receive_python_output(stdout_reader, stderr_reader, shutdown_deadline);
                    return Err(error);
                }
                Err(TryRecvError::Disconnected) => {
                    let shutdown_deadline = bounded_shutdown_deadline(hard_deadline);
                    process.terminate_and_wait(shutdown_deadline);
                    let _ = receive_python_output(stdout_reader, stderr_reader, shutdown_deadline);
                    return Err("Python 插件输入写入线程异常".to_string());
                }
                Err(TryRecvError::Empty) => {}
            }
        }
        let status = match process.try_wait() {
            Ok(status) => status,
            Err(error) => {
                let shutdown_deadline = bounded_shutdown_deadline(hard_deadline);
                process.terminate_and_wait(shutdown_deadline);
                if !input_write_complete {
                    let _ = receive_python_input_writer(input_writer, shutdown_deadline);
                }
                let _ = receive_python_output(stdout_reader, stderr_reader, shutdown_deadline);
                return Err(format!("等待 Python 插件进程失败: {error}"));
            }
        };
        if let Some(status) = status {
            break status;
        }
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            let shutdown_deadline = bounded_shutdown_deadline(hard_deadline);
            process.terminate_and_wait(shutdown_deadline);
            if !input_write_complete {
                let _ = receive_python_input_writer(input_writer, shutdown_deadline);
            }
            let _ = receive_python_output(stdout_reader, stderr_reader, shutdown_deadline);
            return Err("Python 插件执行已取消".to_string());
        }
        if Instant::now() >= work_deadline {
            process.terminate_and_wait(hard_deadline);
            if !input_write_complete {
                let _ = receive_python_input_writer(input_writer, hard_deadline);
            }
            let _ = receive_python_output(stdout_reader, stderr_reader, hard_deadline);
            return Err(format!(
                "Python 插件执行超过 {} 秒，已终止",
                timeout_label.as_secs()
            ));
        }
        thread::sleep(PYTHON_PROCESS_POLL_INTERVAL);
    };

    process.terminate_tree();
    let shutdown_deadline = bounded_shutdown_deadline(hard_deadline);
    if !input_write_complete {
        receive_python_input_writer(input_writer, shutdown_deadline)?;
    }
    let ((stdout, stdout_exceeded), (stderr, stderr_exceeded)) =
        receive_python_output(stdout_reader, stderr_reader, shutdown_deadline)?;
    if stdout_exceeded {
        return Err("Python 插件输出超过 1 MiB 上限".to_string());
    }
    if !exit_status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        let suffix = if stderr_exceeded {
            "（错误信息已截断）"
        } else {
            ""
        };
        return Err(if detail.is_empty() {
            format!("Python 插件执行失败{suffix}")
        } else {
            format!("Python 插件执行失败: {detail}{suffix}")
        });
    }
    serde_json::from_slice(&stdout)
        .map_err(|error| format!("Python 插件输出不是有效 JSON: {error}"))
}

fn execute_python(
    source: String,
    tool_id: String,
    input: Value,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    let hard_deadline = Instant::now() + timeout;
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err("Python 插件执行已取消".to_string());
    }
    let (python, _) = find_python(hard_deadline, cancelled)?;
    execute_python_with_command_until(
        &python,
        source,
        tool_id,
        input,
        hard_deadline,
        timeout,
        cancelled,
    )
}

fn execute_with_timeout(
    source: String,
    tool_id: String,
    input: Value,
    timeout: Duration,
) -> Result<Value, String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err("插件源码超过 512 KiB 上限".to_string());
    }
    if tool_id.is_empty() || tool_id.len() > 64 {
        return Err("插件工具 ID 无效".to_string());
    }
    let input_json =
        serde_json::to_string(&input).map_err(|error| format!("插件输入序列化失败: {error}"))?;
    if input_json.len() > MAX_INPUT_BYTES {
        return Err("插件输入超过 1 MiB 上限".to_string());
    }
    let tool_id_json = serde_json::to_string(&tool_id).map_err(|error| error.to_string())?;

    let runtime = Runtime::new().map_err(|error| format!("创建插件沙箱失败: {error}"))?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(MAX_STACK_BYTES);
    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context =
        Context::full(&runtime).map_err(|error| format!("创建插件上下文失败: {error}"))?;

    let script = format!(
        r#"
"use strict";
let __pluginDefinition = null;
function definePlugin(definition) {{
  if (__pluginDefinition !== null) throw new Error("definePlugin 只能调用一次");
  __pluginDefinition = definition;
}}
{source}
if (!__pluginDefinition || typeof __pluginDefinition !== "object") {{
  throw new Error("插件必须调用 definePlugin");
}}
const __toolId = {tool_id_json};
const __tool = __pluginDefinition.tools && __pluginDefinition.tools[__toolId];
if (typeof __tool !== "function") throw new Error("插件未注册该节点工具");
const __input = Object.freeze({input_json});
const __result = __tool(__input);
if (__result && typeof __result.then === "function") {{
  throw new Error("首版插件工具不支持异步返回值");
}}
const __json = JSON.stringify(__result);
if (typeof __json !== "string") throw new Error("插件必须返回可 JSON 序列化的对象");
__json;
"#,
    );

    let output_json = context
        .with(|ctx| ctx.eval::<String, _>(script))
        .map_err(|error| {
            if Instant::now() >= deadline {
                "插件执行超过 2 秒，已终止".to_string()
            } else {
                format!("插件执行失败: {error}")
            }
        })?;
    if output_json.len() > MAX_OUTPUT_BYTES {
        return Err("插件输出超过 1 MiB 上限".to_string());
    }
    serde_json::from_str(&output_json).map_err(|error| format!("插件输出不是有效 JSON: {error}"))
}

fn execute_plugin_tool_inner(
    runtime: String,
    source: String,
    tool_id: String,
    input: Value,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    match runtime.as_str() {
        "javascript" => execute_with_timeout(source, tool_id, input, JAVASCRIPT_EXECUTION_TIMEOUT),
        "python" => execute_python(source, tool_id, input, PYTHON_EXECUTION_TIMEOUT, cancelled),
        _ => Err("不支持的插件运行时".to_string()),
    }
}

#[tauri::command]
pub async fn execute_node_plugin_tool(
    app: AppHandle,
    webview: Webview,
    plugin_id: String,
    source_digest: String,
    revision_digest: String,
    tool_id: String,
    invocation_id: String,
    input: Value,
) -> Result<Value, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    validate_invocation_id(&invocation_id)?;
    let mut executable = crate::plugin_registry::load_plugin_for_execution(
        &app,
        &plugin_id,
        &source_digest,
        &revision_digest,
        &tool_id,
    )?;
    let active_invocation = if executable.runtime == "python" {
        let active = ActivePythonInvocation::register(&plugin_id, &invocation_id)?;
        // The registry may be changed between the first lookup and cancellation registration.
        // Looking it up again closes the remove/disable race: after registration, a later
        // removal can signal this invocation through `cancel_plugin_invocations`.
        executable = crate::plugin_registry::load_plugin_for_execution(
            &app,
            &plugin_id,
            &source_digest,
            &revision_digest,
            &tool_id,
        )?;
        Some(active)
    } else {
        None
    };

    tauri::async_runtime::spawn_blocking(move || {
        let _active_invocation = active_invocation;
        let cancelled = _active_invocation
            .as_ref()
            .map(|invocation| invocation.cancelled.as_ref());
        execute_plugin_tool_inner(
            executable.runtime,
            executable.source,
            tool_id,
            input,
            cancelled,
        )
    })
    .await
    .map_err(|error| format!("插件运行任务失败: {error}"))?
}

#[tauri::command]
pub async fn get_python_plugin_runtime_status(
    webview: Webview,
) -> Result<PythonPluginRuntimeStatus, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let status = tauri::async_runtime::spawn_blocking(|| {
        match find_python(Instant::now() + PYTHON_STATUS_PROBE_TIMEOUT, None) {
            Ok((python, version)) => PythonPluginRuntimeStatus {
                available: true,
                command: Some(python.label),
                version: Some(version),
                error: None,
            },
            Err(error) => PythonPluginRuntimeStatus {
                available: false,
                command: None,
                version: None,
                error: Some(error),
            },
        }
    })
    .await
    .unwrap_or_else(|error| PythonPluginRuntimeStatus {
        available: false,
        command: None,
        version: None,
        error: Some(format!("Python 环境检测失败: {error}")),
    });
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PROBE_TEST_HELPER_ENV: &str = "AI_CANVAS_PLUGIN_RUNTIME_PROBE_TEST_HELPER";

    fn available_python() -> Result<(PythonCommand, String), String> {
        find_python(Instant::now() + PYTHON_STATUS_PROBE_TIMEOUT, None)
    }

    fn hanging_probe_test_command() -> Command {
        let mut command = Command::new(std::env::current_exe().expect("test executable path"));
        command
            .args([
                "--exact",
                "plugin_runtime::tests::managed_probe_test_helper",
                "--nocapture",
            ])
            .env(PROBE_TEST_HELPER_ENV, "hang");
        command
    }

    #[test]
    fn managed_probe_test_helper() {
        if std::env::var(PROBE_TEST_HELPER_ENV).as_deref() == Ok("hang") {
            thread::sleep(Duration::from_secs(60));
        }
    }

    #[test]
    fn executes_registered_tool_with_json_input() {
        let result = execute_with_timeout(
            r#"definePlugin({ tools: { upper: (input) => ({ data: { output: input.node.data.output.toUpperCase() } }) } });"#.to_string(),
            "upper".to_string(),
            json!({ "node": { "data": { "output": "hello" } } }),
            Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!(result["data"]["output"], "HELLO");
    }

    #[test]
    fn rejects_unregistered_tool() {
        let error = execute_with_timeout(
            "definePlugin({ tools: {} });".to_string(),
            "missing".to_string(),
            json!({}),
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(error.contains("插件执行失败"));
    }

    #[test]
    fn interrupts_infinite_loop() {
        let error = execute_with_timeout(
            "definePlugin({ tools: { loop: () => { while (true) {} } } });".to_string(),
            "loop".to_string(),
            json!({}),
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.contains("已终止"));
    }

    #[test]
    fn executes_python_plugin_when_python_is_available() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let result = execute_python_with_command(
            &python,
            r#"
def upper(input_value):
    return {"data": {"output": input_value["node"]["data"]["output"].upper()}}

define_plugin({"tools": {"upper": upper}})
"#
            .to_string(),
            "upper".to_string(),
            json!({ "node": { "data": { "output": "hello" } } }),
            Duration::from_secs(5),
            None,
        )
        .unwrap();
        assert_eq!(result["data"]["output"], "HELLO");
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn returns_after_python_main_exits_while_a_descendant_holds_output_pipes() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let result = execute_python_with_command(
                &python,
                r#"
import subprocess
import sys

def spawn_descendant(_input_value):
    subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        stdin=subprocess.DEVNULL,
        stdout=sys.__stdout__,
        stderr=sys.__stderr__,
        close_fds=False,
    )
    return {"data": {"output": "parent-finished"}}

define_plugin({"tools": {"spawn": spawn_descendant}})
"#
                .to_string(),
                "spawn".to_string(),
                json!({}),
                Duration::from_secs(5),
                None,
            );
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_secs(8))
            .expect("Python 主进程退出后，继承管道的后代不得让调用无限等待")
            .unwrap();
        assert_eq!(result["data"]["output"], "parent-finished");
    }

    #[test]
    fn bounds_a_hanging_probe_without_path_changes() {
        let hard_deadline = Instant::now() + Duration::from_millis(300);
        let started = Instant::now();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut command = hanging_probe_test_command();
            let result = run_python_probe_command(&mut command, hard_deadline, None);
            let _ = sender.send(result);
        });

        let result = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("Python 探测必须在外层硬上限内返回")
            .unwrap();
        assert!(result.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn cancels_a_hanging_probe_without_path_changes() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_request = Arc::clone(&cancelled);
        let request_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation_request.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let mut command = hanging_probe_test_command();

        let error = run_python_probe_command(
            &mut command,
            Instant::now() + Duration::from_secs(2),
            Some(cancelled.as_ref()),
        )
        .unwrap_err();

        request_thread.join().unwrap();
        assert!(error.contains("环境检测已取消"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn returns_after_the_python_process_closes_stdin_early() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let mut prefix_args = python.prefix_args;
        prefix_args.extend([
            "-c".to_string(),
            "import sys,time; sys.stdin.close(); time.sleep(60)".to_string(),
        ]);
        let closing_candidate = PythonCommand {
            program: python.program,
            prefix_args,
            label: "stdin-closing test interpreter".to_string(),
        };
        let large_source = "#".repeat(MAX_SOURCE_BYTES);
        let started = Instant::now();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = execute_python_with_command(
                &closing_candidate,
                large_source,
                "tool".to_string(),
                json!({}),
                Duration::from_millis(500),
                None,
            );
            let _ = sender.send(result);
        });

        let error = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("Python 提前关闭 stdin 后，输入写线程不得让调用无限等待")
            .unwrap_err();
        assert!(error.contains("写入 Python 插件输入失败") || error.contains("已终止"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn terminates_python_plugin_after_timeout_when_python_is_available() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let error = execute_python_with_command(
            &python,
            r#"
def loop(_input_value):
    while True:
        pass

define_plugin({"tools": {"loop": loop}})
"#
            .to_string(),
            "loop".to_string(),
            json!({}),
            Duration::from_millis(100),
            None,
        )
        .unwrap_err();
        assert!(error.contains("已终止"));
    }

    #[test]
    fn rejects_unknown_runtime() {
        let error = execute_plugin_tool_inner(
            "ruby".to_string(),
            "puts 1".to_string(),
            "tool".to_string(),
            json!({}),
            None,
        )
        .unwrap_err();
        assert!(error.contains("不支持的插件运行时"));
    }

    #[test]
    fn cancels_active_python_plugin_when_python_is_available() {
        let Ok((python, _)) = available_python() else {
            return;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation_request = Arc::clone(&cancelled);
        let request_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation_request.store(true, Ordering::Release);
        });
        let error = execute_python_with_command(
            &python,
            r#"
def loop(_input_value):
    while True:
        pass

define_plugin({"tools": {"loop": loop}})
"#
            .to_string(),
            "loop".to_string(),
            json!({}),
            Duration::from_secs(5),
            Some(cancelled.as_ref()),
        )
        .unwrap_err();
        request_thread.join().unwrap();
        assert!(error.contains("已取消"));
    }

    #[test]
    fn cancels_all_registered_invocations_for_one_plugin() {
        let first = ActivePythonInvocation::register("plugin-a", "invocation-1").unwrap();
        let second = ActivePythonInvocation::register("plugin-a", "invocation-2").unwrap();
        let other = ActivePythonInvocation::register("plugin-b", "invocation-1").unwrap();

        cancel_plugin_invocations("plugin-a");

        assert!(first.cancelled.load(Ordering::Acquire));
        assert!(second.cancelled.load(Ordering::Acquire));
        assert!(!other.cancelled.load(Ordering::Acquire));
    }
}
