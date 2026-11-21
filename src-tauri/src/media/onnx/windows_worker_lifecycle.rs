use super::{WorkerFailure, WORKER_EXIT_POLL_INTERVAL};
use std::{
    os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, TryLockError, Weak,
    },
    time::{Duration, Instant},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{HANDLE, WAIT_OBJECT_0},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
                TerminateJobObject, JobObjectExtendedLimitInformation,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::WaitForSingleObject,
        },
    },
};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const START_ERROR: &str = "无法安全启动本地推理进程";
const SHUTDOWN_ERROR: &str = "本地推理进程未能安全退出，未启动更新安装";

/// 句柄始终指向本次启动的进程；Job 句柄不可继承，主进程硬退出也会回收 worker。
pub(super) struct OwnedWorker {
    process: OwnedHandle,
    job: OwnedHandle,
    cancelled_for_update: AtomicBool,
}

impl OwnedWorker {
    fn create_job() -> Result<OwnedHandle, String> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|_| START_ERROR.to_string())?;
        // SAFETY: 新建的非继承 Job 句柄只在此交给 OwnedHandle 管理一次。
        let job = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                HANDLE(job.as_raw_handle()),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|_| START_ERROR.to_string())?;
        Ok(job)
    }

    fn attach(child: &Child, job: OwnedHandle) -> Result<Self, String> {
        let process = child.as_handle().try_clone_to_owned()
            .map_err(|_| START_ERROR.to_string())?;
        unsafe {
            AssignProcessToJobObject(
                HANDLE(job.as_raw_handle()),
                HANDLE(process.as_raw_handle()),
            )
        }
        .map_err(|_| START_ERROR.to_string())?;
        Ok(Self {
            process,
            job,
            cancelled_for_update: AtomicBool::new(false),
        })
    }

    fn cancel_for_update(&self) {
        self.cancelled_for_update.store(true, Ordering::Release);
        self.terminate();
    }

    pub(super) fn was_cancelled_for_update(&self) -> bool {
        self.cancelled_for_update.load(Ordering::Acquire)
    }

    pub(super) fn terminate(&self) {
        // 最终以原进程句柄的 signaled 状态为准；Job 恰好为空或进程已退出不算失败。
        let _ = unsafe { TerminateJobObject(HANDLE(self.job.as_raw_handle()), 1223) };
    }

    fn wait_until(&self, deadline: Instant) -> Result<(), String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let wait_ms = remaining.as_millis().min(u32::MAX as u128) as u32;
        if unsafe { WaitForSingleObject(HANDLE(self.process.as_raw_handle()), wait_ms) }
            == WAIT_OBJECT_0
        {
            Ok(())
        } else {
            Err(SHUTDOWN_ERROR.to_string())
        }
    }
}

#[derive(Default)]
struct WorkerRegistry {
    closing: bool,
    workers: Vec<Weak<OwnedWorker>>,
}

type Registry = Arc<Mutex<WorkerRegistry>>;
static REGISTRY: OnceLock<Registry> = OnceLock::new();

fn registry() -> Registry {
    Arc::clone(REGISTRY.get_or_init(|| Arc::new(Mutex::new(WorkerRegistry::default()))))
}

fn ensure_open(state: &WorkerRegistry) -> Result<(), WorkerFailure> {
    if state.closing {
        Err(WorkerFailure::UpdateShutdown)
    } else {
        Ok(())
    }
}

pub(super) fn spawn_registered(
    command: &mut Command,
) -> Result<(Child, Arc<OwnedWorker>), WorkerFailure> {
    let registry = registry();
    // 与更新关闭共用一把锁：不能在检查 closing 后、注册前漏出一个新 worker。
    let mut state = registry.lock().map_err(|_| START_ERROR.to_string())?;
    ensure_open(&state)?;
    let job = OwnedWorker::create_job()?;
    let mut child = command.spawn().map_err(|_| START_ERROR.to_string())?;
    let owned = match OwnedWorker::attach(&child, job) {
        Ok(owned) => Arc::new(owned),
        Err(error) => {
            // Child 自有句柄不会命中复用后的 PID；未注册成功的进程也必须回收。
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    };
    state.workers.retain(|worker| worker.strong_count() > 0);
    state.workers.push(Arc::downgrade(&owned));
    Ok((child, owned))
}

#[must_use]
pub struct UpdateWorkerShutdownGuard {
    registry: Registry,
}

impl Drop for UpdateWorkerShutdownGuard {
    fn drop(&mut self) {
        // install 返回失败或准备阶段失败时重新允许任务；成功硬退出由 OS 关闭 Job。
        let mut state = self.registry.lock().unwrap_or_else(|error| error.into_inner());
        state.closing = false;
    }
}

fn prepare_shutdown(
    registry: Registry,
    deadline: Instant,
) -> Result<UpdateWorkerShutdownGuard, String> {
    let mut state = loop {
        match registry.try_lock() {
            Ok(state) => break state,
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(WORKER_EXIT_POLL_INTERVAL);
            }
            Err(_) => return Err(SHUTDOWN_ERROR.to_string()),
        }
    };
    ensure_open(&state).map_err(WorkerFailure::into_message)?;
    state.closing = true;
    // 在任何可失败的等待前建立 guard，错误路径同样恢复接新任务。
    let guard = UpdateWorkerShutdownGuard {
        registry: Arc::clone(&registry),
    };
    let workers = state.workers.iter().filter_map(Weak::upgrade).collect::<Vec<_>>();
    state.workers.retain(|worker| worker.strong_count() > 0);
    drop(state);
    // 先通知全部 Job，避免第一个等待吃满期限时，其余进程还未收到终止。
    for worker in &workers {
        worker.cancel_for_update();
    }
    for worker in &workers {
        worker.wait_until(deadline)?;
    }
    Ok(guard)
}

/// 在阻塞线程调用；锁等待与全部进程等待共用一次五秒期限。
pub fn prepare_update_worker_shutdown() -> Result<UpdateWorkerShutdownGuard, String> {
    prepare_shutdown(registry(), Instant::now() + SHUTDOWN_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_lease_blocks_starts_and_does_not_own_expired_workers() {
        let registry = Arc::new(Mutex::new(WorkerRegistry {
            closing: false,
            workers: vec![Weak::new()],
        }));
        let guard = prepare_shutdown(Arc::clone(&registry), Instant::now() + SHUTDOWN_TIMEOUT)
            .expect("空注册表应允许准备更新");
        {
            let state = registry.lock().unwrap();
            assert!(ensure_open(&state).is_err());
            assert!(state.workers.is_empty(), "过期弱引用不应保活进程句柄");
        }
        assert!(prepare_shutdown(Arc::clone(&registry), Instant::now()).is_err());
        assert!(registry.lock().unwrap().closing, "第二次准备失败不能解除第一份租约");
        drop(guard);
        assert!(ensure_open(&registry.lock().unwrap()).is_ok());
    }

    #[test]
    fn a_locked_startup_obeys_the_shared_shutdown_deadline() {
        let registry = Arc::new(Mutex::new(WorkerRegistry::default()));
        let state = registry.lock().unwrap();
        assert!(prepare_shutdown(Arc::clone(&registry), Instant::now()).is_err());
        assert!(!state.closing, "未取得锁的失败不应修改门禁");
    }

    #[test]
    fn update_cancellation_survives_reopening_and_waits_for_the_owned_process() {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;

        // set /p 等待本进程持有的管道输入，不会在 Job 绑定前再派生进程。
        let job = OwnedWorker::create_job().expect("测试 Job 应可创建");
        let mut child = Command::new("cmd")
            .args(["/C", "set /p DUMMY="])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .expect("测试进程应可启动");
        let owned = match OwnedWorker::attach(&child, job) {
            Ok(owned) => Arc::new(owned),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("{error}");
            }
        };
        let registry = Arc::new(Mutex::new(WorkerRegistry {
            closing: false,
            workers: vec![Arc::downgrade(&owned)],
        }));
        let guard = prepare_shutdown(Arc::clone(&registry), Instant::now() + SHUTDOWN_TIMEOUT)
            .expect("应终止并等到本次进程退出");
        assert!(child.try_wait().unwrap().is_some());
        drop(guard);
        assert!(ensure_open(&registry.lock().unwrap()).is_ok());
        assert!(owned.was_cancelled_for_update(), "重开门禁不能把旧任务当成 GPU 故障");
    }
}
