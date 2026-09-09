//! macOS 固定 Blender 命令的进程组生命周期；不是任意命令执行接口。
use super::*;
use std::{
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
};

struct ProcessState {
    child: Child,
    exit_code: Option<u32>,
    terminated: bool,
}

pub(super) struct ManagedProcess {
    state: Mutex<ProcessState>,
}

impl ProcessState {
    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        self.terminated = true;
        if let Ok(group) = i32::try_from(self.child.id()) {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            // SAFETY: spawn assigns the positive child PID as a dedicated process group.
            // No shell, caller PID or caller-provided group can reach this function.
            if group > 0 {
                unsafe {
                    let _ = kill(-group, 9);
                }
            }
        }
        if self.exit_code.is_none() {
            let _ = self.child.kill();
        }
    }

    fn poll(&mut self) -> Result<Option<u32>, String> {
        if let Some(code) = self.exit_code {
            return Ok(Some(code));
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                let code = status
                    .code()
                    .and_then(|code| u32::try_from(code).ok())
                    .unwrap_or(1);
                self.exit_code = Some(code);
                // Reap the direct child and stop remaining members of its dedicated group.
                self.terminate();
                Ok(Some(code))
            }
            Ok(None) => Ok(None),
            Err(_) => Err("读取 Blender 退出状态失败".to_string()),
        }
    }
}

impl ManagedProcess {
    pub(super) fn resume(&self) -> Result<(), String> {
        // Unix spawn assigns the process group atomically before exec; no suspended handle.
        Ok(())
    }

    pub(super) fn terminate(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .terminate();
    }

    pub(super) fn poll_exit(&self, wait: Duration) -> Result<Option<u32>, String> {
        let status = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .poll()?;
        if status.is_none() {
            std::thread::sleep(wait);
        }
        Ok(status)
    }

    pub(super) fn wait_for_exit(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if self.poll_exit(PROCESS_POLL)?.is_some() {
                return Ok(());
            }
        }
        Err("Blender 进程终止等待超时".to_string())
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        self.terminate();
        let _ = self.wait_for_exit(TERMINATION_WAIT);
    }
}

fn fixed_command(
    executable: &Path,
    arguments: &[OsString],
    directory: &Path,
    background: bool,
) -> Command {
    let mut command = Command::new(executable);
    // argv[0] belongs to CreateProcess on Windows; std::process::Command supplies it on Unix.
    command
        .args(arguments.iter().skip(1))
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    if background {
        for (key, _) in std::env::vars_os() {
            let upper = key.to_string_lossy().to_ascii_uppercase();
            if upper.starts_with("BLENDER_") || upper.starts_with("PYTHON") {
                command.env_remove(key);
            }
        }
    }
    command
}

pub(super) fn spawn_managed_process(
    executable: &Path,
    arguments: &[OsString],
    directory: &Path,
    background: bool,
) -> Result<Arc<ManagedProcess>, BlenderJobRunnerFailure> {
    let child = fixed_command(executable, arguments, directory, background)
        .spawn()
        .map_err(|error| startup_failure(format!("macOS Blender 启动失败: {error}")))?;
    Ok(Arc::new(ManagedProcess {
        state: Mutex::new(ProcessState {
            child,
            exit_code: None,
            terminated: false,
        }),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_command_passes_paths_as_arguments_without_shell_or_duplicate_executable() {
        let exe = Path::new("/Applications/Blender 4.5.app/Contents/MacOS/Blender");
        let arguments = build_blender_arguments(
            exe,
            Path::new("/private/a b/startup.blend"),
            Path::new("/private/a b/__init__.py"),
            Path::new("/private/a b/job.py"),
            true,
        );
        let command = fixed_command(exe, &arguments, Path::new("/private/a b"), true);
        assert_eq!(command.get_program(), exe.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            arguments[1..]
                .iter()
                .map(OsString::as_os_str)
                .collect::<Vec<_>>()
        );
        assert_eq!(command.get_current_dir(), Some(Path::new("/private/a b")));
    }

    #[test]
    fn managed_process_collects_exit_and_can_terminate_its_group() {
        let arguments = vec![OsString::from("/usr/bin/true")];
        let process = spawn_managed_process(
            Path::new("/usr/bin/true"),
            &arguments,
            Path::new("/"),
            false,
        )
        .unwrap();
        process.wait_for_exit(Duration::from_secs(5)).unwrap();
        assert_eq!(process.poll_exit(Duration::ZERO).unwrap(), Some(0));
        let arguments = vec![OsString::from("/bin/sleep"), OsString::from("30")];
        let process =
            spawn_managed_process(Path::new("/bin/sleep"), &arguments, Path::new("/"), false)
                .unwrap();
        process.terminate();
        process.wait_for_exit(Duration::from_secs(5)).unwrap();
        assert_ne!(process.poll_exit(Duration::ZERO).unwrap(), Some(0));
    }
}
