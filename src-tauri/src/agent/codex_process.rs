//! Lifecycle containment for a user-trusted native executable. This is NOT an OS sandbox.
use super::codex_contract::{MAX_FRAME_BYTES, MAX_STREAM_BYTES};
use std::{
    fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Read, Write}, path::Path,
    process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc},
    thread, time::{Duration, Instant},
};
#[cfg(windows)]
use std::os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle, process::CommandExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(windows)]
struct ProcessJob(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use windows::{core::PCWSTR, Win32::{Foundation::HANDLE, System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        }}};
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|_| "CODEX_PROCESS_CONTAINMENT_FAILED")?;
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) }
            .map_err(|_| "CODEX_PROCESS_CONTAINMENT_FAILED")?;
        unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }
            .map_err(|_| "CODEX_PROCESS_CONTAINMENT_FAILED")?;
        Ok(job)
    }
    fn terminate(&self) { unsafe { let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.0, 1223); } }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) { unsafe { let _ = windows::Win32::Foundation::CloseHandle(self.0); } }
}

pub struct CodexProcess {
    child: Option<Child>,
    executable_identity: Option<File>,
    input: mpsc::SyncSender<Vec<u8>>,
    output: mpsc::Receiver<Result<Vec<u8>, String>>,
    stderr_exceeded: Arc<AtomicBool>,
    #[cfg(windows)]
    job: ProcessJob,
}

fn snapshot_layout_matches(binary: &Path, home: &Path, cwd: &Path) -> bool {
    let Some(root) = home.parent() else { return false; };
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    binary.is_absolute() && home.is_absolute() && cwd.is_absolute()
        && binary.parent() == Some(root) && cwd.parent() == Some(root)
        && binary.file_name().is_some_and(|name| name == executable_name)
        && home.file_name().is_some_and(|name| name == "home")
        && cwd.file_name().is_some_and(|name| name == "work")
        && root.parent().and_then(Path::file_name).is_some_and(|name| name == "runs")
}

fn open_executable_snapshot(binary: &Path, home: &Path, cwd: &Path) -> Result<File, String> {
    if !snapshot_layout_matches(binary, home, cwd) { return Err("CODEX_PRIVATE_PATH_INVALID".into()); }
    for path in [binary, home, cwd] {
        if !path.canonicalize().is_ok_and(|actual| actual == path) { return Err("CODEX_PRIVATE_PATH_INVALID".into()); }
        let metadata = fs::symlink_metadata(path).map_err(|_| "CODEX_PRIVATE_PATH_INVALID")?;
        if metadata.file_type().is_symlink() { return Err("CODEX_PRIVATE_PATH_INVALID".into()); }
        #[cfg(windows)]
        if metadata.file_attributes() & 0x400 != 0 { return Err("CODEX_PRIVATE_PATH_INVALID".into()); }
        if (path == binary && !metadata.is_file()) || (path != binary && !metadata.is_dir()) {
            return Err("CODEX_PRIVATE_PATH_INVALID".into());
        }
    }
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)]
    options.share_mode(0x00000001).custom_flags(0x00200000);
    let identity = options.open(binary).map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
    let metadata = identity.metadata().map_err(|_| "CODEX_EXECUTABLE_UNAVAILABLE")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 { return Err("CODEX_EXECUTABLE_REJECTED".into()); }
    Ok(identity)
}

impl CodexProcess {
    pub fn spawn(binary: &Path, argument: &str, home: &Path, cwd: &Path, key: Option<&str>) -> Result<Self, String> {
        if argument != "app-server" && argument != "--version" { return Err("CODEX_ARGUMENT_REJECTED".into()); }
        // Callers may only launch their verified per-run private copy, never the
        // original installation path. This lease also survives deferred reaping.
        let executable_identity = open_executable_snapshot(binary, home, cwd)?;
        let mut command = Command::new(binary);
        command.arg(argument).current_dir(cwd).env_clear()
            .env("CODEX_HOME", home).env("CODEX_SQLITE_HOME", home)
            .env("HOME", home).env("USERPROFILE", home).env("APPDATA", home).env("LOCALAPPDATA", home)
            .env("TEMP", cwd).env("TMP", cwd).env("TMPDIR", cwd)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(value) = std::env::var_os("SystemRoot") { command.env("SystemRoot", value); }
        if let Some(secret) = key { command.env("AI_CANVAS_CODEX_API_KEY", secret); }
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; no shell or script launch.
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| "CODEX_PROCESS_START_FAILED")?;
        #[cfg(windows)]
        let job = match ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        };
        let (Some(stdin),Some(stdout),Some(stderr))=(child.stdin.take(),child.stdout.take(),child.stderr.take()) else {
            let _=child.kill(); thread::spawn(move||{let _identity=executable_identity;let _=child.wait();});
            return Err("CODEX_PROCESS_PIPE_FAILED".into());
        };
        let (input, writer) = mpsc::sync_channel::<Vec<u8>>(8);
        thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(bytes) = writer.recv() {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() { break; }
            }
        });
        let (sender, output) = mpsc::sync_channel(32);
        thread::spawn(move || read_frames(stdout, sender));
        let stderr_exceeded = Arc::new(AtomicBool::new(false));
        let limit = Arc::clone(&stderr_exceeded);
        thread::spawn(move || {
            // Drain, count, and discard. Raw stderr (paths, prompts or secrets) never leaves this thread.
            let mut reader = stderr; let mut buffer = [0_u8; 4096]; let mut bytes = 0_usize;
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 { break; }
                bytes = bytes.saturating_add(count);
                if bytes > 16 * 1024 { limit.store(true, Ordering::Release); break; }
            }
        });
        Ok(Self { child: Some(child), executable_identity: Some(executable_identity), input, output, stderr_exceeded, #[cfg(windows)] job })
    }

    pub fn send(&self, value: &serde_json::Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "CODEX_PROTOCOL_INVALID")?;
        if bytes.len() > MAX_FRAME_BYTES { return Err("CODEX_INPUT_LIMIT".into()); }
        bytes.push(b'\n');
        self.input.try_send(bytes).map_err(|_| "CODEX_PROCESS_PIPE_FAILED".into())
    }

    pub fn receive(&self, timeout: Duration) -> Result<Option<Vec<u8>>, String> {
        if self.stderr_exceeded.load(Ordering::Acquire) { return Err("CODEX_STDERR_LIMIT".into()); }
        match self.output.recv_timeout(timeout) {
            Ok(line) => line.map(Some),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("CODEX_PROCESS_DISCONNECTED".into()),
        }
    }

    pub fn exited(&mut self) -> Result<Option<bool>, String> {
        self.child.as_mut().ok_or("CODEX_PROCESS_DISCONNECTED")?.try_wait()
            .map(|status| status.map(|value| value.success())).map_err(|_| "CODEX_PROCESS_WAIT_FAILED".into())
    }

    pub fn terminate(&mut self) {
        if let Some(child) = self.child.as_mut() {
            #[cfg(windows)] self.job.terminate();
            #[cfg(unix)] {
                unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
                if let Ok(pid) = i32::try_from(child.id()) { unsafe { let _ = kill(-pid, 9); } }
            }
            let _ = child.kill();
        }
    }
}

impl Drop for CodexProcess {
    fn drop(&mut self) {
        self.terminate();
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                    Ok(None) | Err(_) => break,
                }
            }
            let identity = self.executable_identity.take();
            thread::spawn(move || { let _identity = identity; let _ = child.wait(); });
        }
    }
}

fn read_frames(stdout: impl Read, sender: mpsc::SyncSender<Result<Vec<u8>, String>>) {
    let mut reader = BufReader::new(stdout); let mut frame = Vec::new(); let mut total = 0_usize;
    loop {
        let chunk = match reader.fill_buf() {
            Ok([]) => { if !frame.is_empty() { let _ = sender.send(Ok(frame)); } return; }
            Ok(chunk) => chunk,
            Err(_) => { let _ = sender.send(Err("CODEX_PROCESS_PIPE_FAILED".into())); return; }
        };
        let consumed = chunk.iter().position(|byte| *byte == b'\n').map_or(chunk.len(), |index| index + 1);
        total = total.saturating_add(consumed);
        if frame.len() + consumed > MAX_FRAME_BYTES || total > MAX_STREAM_BYTES {
            let _ = sender.send(Err("CODEX_PROTOCOL_LIMIT".into())); return;
        }
        let complete = chunk[consumed - 1] == b'\n';
        frame.extend_from_slice(&chunk[..consumed]); reader.consume(consumed);
        if complete && sender.send(Ok(std::mem::take(&mut frame))).is_err() { return; }
    }
}

pub fn probe_version(binary: &Path, home: &Path, cwd: &Path) -> Result<(), String> {
    let mut process = CodexProcess::spawn(binary, "--version", home, cwd, None)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut stdout = Vec::new();
    while Instant::now() < deadline {
        match process.receive(Duration::from_millis(30)) {
            Ok(Some(line)) => { stdout.extend(line); if stdout.len() > 4096 { return Err("CODEX_VERSION_UNSUPPORTED".into()); } }
            Ok(None) => {},
            Err(error) if error == "CODEX_PROCESS_DISCONNECTED" => {
                if let Some(success) = process.exited()? {
                    if !success { return Err("CODEX_VERSION_UNSUPPORTED".into()); }
                    return super::codex_contract::validate_version(std::str::from_utf8(&stdout).map_err(|_| "CODEX_VERSION_UNSUPPORTED")?);
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
    Err("CODEX_VERSION_TIMEOUT".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_layout_only_accepts_the_fixed_private_snapshot() {
        let base = if cfg!(windows) { Path::new("C:\\agent-private") } else { Path::new("/agent-private") };
        let root = base.join("runs").join("run-test");
        let binary = root.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        let home = root.join("home"); let cwd = root.join("work");
        assert!(snapshot_layout_matches(&binary, &home, &cwd));
        assert!(!snapshot_layout_matches(&base.join("codex"), &home, &cwd));
        assert!(!snapshot_layout_matches(&binary, &home, &base.join("work")));
        assert!(!snapshot_layout_matches(&root.join("other"), &home, &cwd));
    }
}
