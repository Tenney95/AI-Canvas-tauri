//! Pure Blender Job state core.
//!
//! The module owns no project path and starts no process by itself. Production defaults to an
//! unavailable runner; a later facade may inject a fixed native runner after project-grant,
//! resource-integrity and process-tree checks have succeeded.

use super::result::{
    validate_blender_collect_candidate, BlenderCollectCandidate, BlenderCollectedResult,
    BlenderResultArtifactKind, BlenderResultBinding,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const MAX_OPAQUE_ID_BYTES: usize = 128;
const MAX_RETAINED_JOBS: usize = 128;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_POLL: Duration = Duration::from_millis(10);
const JOB_ID_DOMAIN: &[u8] = b"ai-canvas/blender-job/v1\0";
const MAX_FRAME: u64 = 10_000_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlenderJobOperation {
    OpenEditor,
    RenderFrame,
    RenderVideo,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlenderJobStartRequest {
    pub installation_id: String,
    pub operation: BlenderJobOperation,
    pub project_grant_id: String,
    pub project_id: String,
    pub director_instance_id: String,
    pub scene_id: String,
    pub scene_revision: u64,
    pub scene_sha256: String,
    pub previous_manifest_revision: Option<u64>,
    pub previous_manifest_sha256: Option<String>,
    pub target_frame: Option<u64>,
}

impl BlenderJobStartRequest {
    fn validate(&self) -> Result<(), BlenderJobCoreError> {
        if !is_valid_opaque_id(&self.installation_id)
            || !is_valid_opaque_id(&self.project_grant_id)
            || !is_valid_opaque_id(&self.project_id)
            || !is_valid_opaque_id(&self.director_instance_id)
            || !is_valid_scene_id(&self.scene_id)
            || !is_positive_safe_integer(self.scene_revision)
            || !is_valid_sha256(&self.scene_sha256)
        {
            return Err(BlenderJobCoreError::new(
                BlenderJobCoreErrorCode::InvalidRequest,
            ));
        }
        match self.operation {
            BlenderJobOperation::RenderFrame
                if !self.target_frame.is_some_and(|frame| frame <= MAX_FRAME) =>
            {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::InvalidRequest,
                ));
            }
            BlenderJobOperation::OpenEditor | BlenderJobOperation::RenderVideo
                if self.target_frame.is_some() =>
            {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::InvalidRequest,
                ));
            }
            _ => {}
        }
        match (
            self.previous_manifest_revision,
            self.previous_manifest_sha256.as_deref(),
        ) {
            (None, None) => Ok(()),
            (Some(revision), Some(hash))
                if is_positive_safe_integer(revision)
                    && revision < JS_SAFE_INTEGER_MAX
                    && is_valid_sha256(hash) =>
            {
                Ok(())
            }
            _ => Err(BlenderJobCoreError::new(
                BlenderJobCoreErrorCode::InvalidRequest,
            )),
        }
    }

    pub(crate) fn result_binding(&self) -> BlenderResultBinding {
        BlenderResultBinding {
            scene_id: self.scene_id.clone(),
            scene_revision: self.scene_revision,
            scene_sha256: self.scene_sha256.clone(),
            previous_manifest_revision: self.previous_manifest_revision,
            previous_manifest_sha256: self.previous_manifest_sha256.clone(),
        }
    }

    fn has_same_binding(&self, other: &Self) -> bool {
        self.installation_id == other.installation_id
            && self.operation == other.operation
            && self.target_frame == other.target_frame
            && self.project_grant_id == other.project_grant_id
            && self.project_id == other.project_id
            && self.director_instance_id == other.director_instance_id
            && self.scene_id == other.scene_id
            && self.scene_revision == other.scene_revision
            && self.scene_sha256 == other.scene_sha256
            && self.previous_manifest_revision == other.previous_manifest_revision
            && self.previous_manifest_sha256 == other.previous_manifest_sha256
    }
}

/// 只能由 Rust facade 构造，不能反序列化为 IPC 输入。
#[derive(Clone, Debug)]
pub(crate) struct BlenderJobTrustedContext {
    pub executable: PathBuf,
    pub project_root: PathBuf,
    pub private_root: PathBuf,
    pub resources: super::resources::TrustedBlenderResourcePaths,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedBlenderJob {
    pub job_id: String,
    pub request: BlenderJobStartRequest,
    pub trusted: BlenderJobTrustedContext,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlenderJobState {
    Starting,
    Running,
    AwaitingCollection,
    Collecting,
    Succeeded,
    Cancelling,
    Cancelled,
    Failed,
}

impl BlenderJobState {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlenderJobProgressPhase {
    Preparing,
    LoadingScene,
    Rendering,
    Saving,
    Finalizing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderJobProgress {
    pub phase: BlenderJobProgressPhase,
    pub completed: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlenderJobFailureCode {
    RunnerUnavailable,
    StartupFailed,
    ProcessCrashed,
    TimedOut,
    ResultInvalid,
    InternalFailure,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderJobFailure {
    pub code: BlenderJobFailureCode,
    pub message: String,
}

impl BlenderJobFailure {
    fn fixed(code: BlenderJobFailureCode) -> Self {
        let message = match code {
            BlenderJobFailureCode::RunnerUnavailable => "Blender Job 运行器尚未启用",
            BlenderJobFailureCode::StartupFailed => "Blender Job 启动失败",
            BlenderJobFailureCode::ProcessCrashed => "Blender Job 异常结束",
            BlenderJobFailureCode::TimedOut => "Blender Job 执行超时",
            BlenderJobFailureCode::ResultInvalid => "Blender Job 结果校验失败",
            BlenderJobFailureCode::InternalFailure => "Blender Job 内部状态异常",
        };
        Self {
            code,
            message: message.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderJobStatus {
    pub job_id: String,
    pub operation: BlenderJobOperation,
    pub state: BlenderJobState,
    pub scene_id: String,
    pub scene_revision: u64,
    pub progress: Option<BlenderJobProgress>,
    pub failure: Option<BlenderJobFailure>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Events never contain paths, runner diagnostics, stdout/stderr or failure text.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderJobEvent {
    pub job_id: String,
    pub operation: BlenderJobOperation,
    pub state: BlenderJobState,
    pub progress: Option<BlenderJobProgress>,
    pub updated_at_ms: u64,
}

impl From<&BlenderJobStatus> for BlenderJobEvent {
    fn from(status: &BlenderJobStatus) -> Self {
        Self {
            job_id: status.job_id.clone(),
            operation: status.operation,
            state: status.state,
            progress: status.progress.clone(),
            updated_at_ms: status.updated_at_ms,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlenderJobCoreErrorCode {
    InvalidRequest,
    RuntimeShuttingDown,
    RunnerUnavailable,
    JobAlreadyActive,
    JobCapacityReached,
    JobIdUnavailable,
    JobNotFound,
    JobNotCollectible,
    JobCollectionInProgress,
    JobCancelled,
    JobFailed,
    ResultInvalid,
    InternalState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlenderJobCoreError {
    pub code: BlenderJobCoreErrorCode,
}

impl BlenderJobCoreError {
    fn new(code: BlenderJobCoreErrorCode) -> Self {
        Self { code }
    }

    pub fn public_message(self) -> &'static str {
        match self.code {
            BlenderJobCoreErrorCode::InvalidRequest => "Blender Job 请求无效",
            BlenderJobCoreErrorCode::RuntimeShuttingDown => "Blender Job 运行时正在关闭",
            BlenderJobCoreErrorCode::RunnerUnavailable => "Blender Job 运行器尚未启用",
            BlenderJobCoreErrorCode::JobAlreadyActive => "当前已有 Blender Job 正在执行",
            BlenderJobCoreErrorCode::JobCapacityReached => "Blender Job 状态表已达到上限",
            BlenderJobCoreErrorCode::JobIdUnavailable => "无法生成 Blender Job 标识",
            BlenderJobCoreErrorCode::JobNotFound => "Blender Job 不存在或已过期",
            BlenderJobCoreErrorCode::JobNotCollectible => "Blender Job 当前不能回收结果",
            BlenderJobCoreErrorCode::JobCollectionInProgress => "Blender Job 结果正在回收",
            BlenderJobCoreErrorCode::JobCancelled => "Blender Job 已取消",
            BlenderJobCoreErrorCode::JobFailed => "Blender Job 已失败",
            BlenderJobCoreErrorCode::ResultInvalid => "Blender Job 结果校验失败",
            BlenderJobCoreErrorCode::InternalState => "Blender Job 内部状态异常",
        }
    }
}

impl fmt::Display for BlenderJobCoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.public_message())
    }
}

impl std::error::Error for BlenderJobCoreError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlenderJobRunnerFailureKind {
    Unavailable,
    StartupFailed,
    Crashed,
    TimedOut,
    Cancelled,
    ResultInvalid,
    Internal,
}

/// Diagnostics are intentionally private and are never copied into status, events or IPC errors.
#[derive(Clone, Debug)]
pub struct BlenderJobRunnerFailure {
    kind: BlenderJobRunnerFailureKind,
    _diagnostic: Option<String>,
}

impl BlenderJobRunnerFailure {
    pub fn new(kind: BlenderJobRunnerFailureKind) -> Self {
        Self {
            kind,
            _diagnostic: None,
        }
    }

    pub fn with_private_diagnostic(
        kind: BlenderJobRunnerFailureKind,
        diagnostic: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            _diagnostic: Some(diagnostic.into()),
        }
    }

    fn kind(&self) -> BlenderJobRunnerFailureKind {
        self.kind
    }
}

#[derive(Clone)]
pub struct BlenderJobCancellation {
    cancelled: Arc<AtomicBool>,
}

impl BlenderJobCancellation {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
pub struct BlenderJobProgressReporter {
    shared: Weak<Shared>,
    job_id: String,
}

impl BlenderJobProgressReporter {
    pub fn report(&self, phase: BlenderJobProgressPhase, completed: u64, total: u64) -> bool {
        self.shared
            .upgrade()
            .is_some_and(|shared| shared.report_progress(&self.job_id, phase, completed, total))
    }
}

pub trait BlenderJobRunner: Send + Sync + 'static {
    fn is_available(&self) -> bool;

    /// A successful return must mean every owned external process/resource has already been
    /// reaped. Implementations must observe cancellation and return promptly after `shutdown`.
    fn run(
        &self,
        job: PreparedBlenderJob,
        cancellation: BlenderJobCancellation,
        progress: BlenderJobProgressReporter,
    ) -> Result<BlenderCollectCandidate, BlenderJobRunnerFailure>;

    /// Must synchronously request termination/reaping and remain bounded. The core additionally
    /// bounds its worker joins so application shutdown cannot wait forever.
    fn shutdown(&self) {}
}

#[derive(Default)]
pub struct UnavailableBlenderJobRunner;

impl BlenderJobRunner for UnavailableBlenderJobRunner {
    fn is_available(&self) -> bool {
        false
    }

    fn run(
        &self,
        _job: PreparedBlenderJob,
        _cancellation: BlenderJobCancellation,
        _progress: BlenderJobProgressReporter,
    ) -> Result<BlenderCollectCandidate, BlenderJobRunnerFailure> {
        Err(BlenderJobRunnerFailure::new(
            BlenderJobRunnerFailureKind::Unavailable,
        ))
    }
}

pub trait BlenderJobClock: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

#[derive(Default)]
pub struct SystemBlenderJobClock;

impl BlenderJobClock for SystemBlenderJobClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }
}

pub trait BlenderJobIdGenerator: Send + Sync + 'static {
    fn next_job_id(&self) -> Option<String>;
}

#[derive(Default)]
pub struct DefaultBlenderJobIdGenerator {
    sequence: AtomicU64,
}

impl BlenderJobIdGenerator for DefaultBlenderJobIdGenerator {
    fn next_job_id(&self) -> Option<String> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        let mut hasher = Sha256::new();
        hasher.update(JOB_ID_DOMAIN);
        hasher.update(timestamp.to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(sequence.to_le_bytes());
        Some(format!("blender-job-v1-{:x}", hasher.finalize()))
    }
}

pub trait BlenderJobEventSink: Send + Sync + 'static {
    fn emit(&self, event: &BlenderJobEvent);
}

#[derive(Default)]
pub struct NoopBlenderJobEventSink;

impl BlenderJobEventSink for NoopBlenderJobEventSink {
    fn emit(&self, _event: &BlenderJobEvent) {}
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlenderProjectGrantRevokeResult {
    pub project_grant_id: String,
    pub cancelled_jobs: usize,
}

struct JobRecord {
    request: BlenderJobStartRequest,
    status: BlenderJobStatus,
    cancellation: Arc<AtomicBool>,
    candidate: Option<BlenderCollectCandidate>,
    collected: Option<BlenderCollectedResult>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct RuntimeInner {
    jobs: HashMap<String, JobRecord>,
    active_job_id: Option<String>,
}

struct Shared {
    inner: Mutex<RuntimeInner>,
    shutting_down: AtomicBool,
    runner: Arc<dyn BlenderJobRunner>,
    clock: Arc<dyn BlenderJobClock>,
    events: Arc<dyn BlenderJobEventSink>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, RuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    fn emit_status(&self, status: &BlenderJobStatus) {
        if self.shutting_down.load(Ordering::Acquire) {
            return;
        }
        let event = BlenderJobEvent::from(status);
        let _ = catch_unwind(AssertUnwindSafe(|| self.events.emit(&event)));
    }

    fn report_progress(
        &self,
        job_id: &str,
        phase: BlenderJobProgressPhase,
        completed: u64,
        total: u64,
    ) -> bool {
        if total == 0 || completed > total || self.shutting_down.load(Ordering::Acquire) {
            return false;
        }
        let now = self.now_ms();
        let status =
            {
                let mut inner = self.lock();
                let Some(record) = inner.jobs.get_mut(job_id) else {
                    return false;
                };
                if record.status.state != BlenderJobState::Running {
                    return false;
                }
                if record.status.progress.as_ref().is_some_and(|previous| {
                    previous.phase == phase && completed < previous.completed
                }) {
                    return false;
                }
                record.status.progress = Some(BlenderJobProgress {
                    phase,
                    completed,
                    total,
                });
                record.status.updated_at_ms = record.status.updated_at_ms.max(now);
                record.status.clone()
            };
        self.emit_status(&status);
        true
    }

    fn finish_worker(
        &self,
        job_id: &str,
        outcome: Result<BlenderCollectCandidate, BlenderJobRunnerFailure>,
    ) {
        let now = self.now_ms();
        let (status, _terminal) = {
            let mut inner = self.lock();
            let Some(record) = inner.jobs.get_mut(job_id) else {
                return;
            };
            if record.status.state.is_terminal() {
                return;
            }

            let cancelled = self.shutting_down.load(Ordering::Acquire)
                || record.cancellation.load(Ordering::Acquire)
                || record.status.state == BlenderJobState::Cancelling;
            if cancelled {
                record.status.state = BlenderJobState::Cancelled;
                record.status.failure = None;
                record.candidate = None;
            } else {
                match outcome {
                    Ok(candidate) => {
                        record.status.state = BlenderJobState::AwaitingCollection;
                        record.status.failure = None;
                        record.candidate = Some(candidate);
                    }
                    Err(failure) if failure.kind() == BlenderJobRunnerFailureKind::Cancelled => {
                        record.status.state = BlenderJobState::Cancelled;
                        record.status.failure = None;
                    }
                    Err(failure) => {
                        record.status.state = BlenderJobState::Failed;
                        record.status.failure = Some(runner_failure_to_public(&failure));
                    }
                }
            }
            record.status.updated_at_ms = record.status.updated_at_ms.max(now);
            let terminal = record.status.state.is_terminal();
            (record.status.clone(), terminal)
        };
        let mut inner = self.lock();
        if inner.active_job_id.as_deref() == Some(job_id) {
            inner.active_job_id = None;
        }
        drop(inner);
        self.emit_status(&status);
    }
}

pub struct BlenderJobCore {
    shared: Arc<Shared>,
    ids: Arc<dyn BlenderJobIdGenerator>,
}

impl Default for BlenderJobCore {
    fn default() -> Self {
        Self::with_dependencies(
            Arc::new(UnavailableBlenderJobRunner),
            Arc::new(SystemBlenderJobClock),
            Arc::new(DefaultBlenderJobIdGenerator::default()),
            Arc::new(NoopBlenderJobEventSink),
        )
    }
}

impl BlenderJobCore {
    pub fn with_dependencies(
        runner: Arc<dyn BlenderJobRunner>,
        clock: Arc<dyn BlenderJobClock>,
        ids: Arc<dyn BlenderJobIdGenerator>,
        events: Arc<dyn BlenderJobEventSink>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(RuntimeInner::default()),
                shutting_down: AtomicBool::new(false),
                runner,
                clock,
                events,
            }),
            ids,
        }
    }

    pub fn start(
        &self,
        request: BlenderJobStartRequest,
        trusted: BlenderJobTrustedContext,
    ) -> Result<BlenderJobStatus, BlenderJobCoreError> {
        request.validate()?;
        if self.shared.shutting_down.load(Ordering::Acquire) {
            return Err(BlenderJobCoreError::new(
                BlenderJobCoreErrorCode::RuntimeShuttingDown,
            ));
        }
        let runner_available =
            catch_unwind(AssertUnwindSafe(|| self.shared.runner.is_available())).unwrap_or(false);
        if !runner_available {
            return Err(BlenderJobCoreError::new(
                BlenderJobCoreErrorCode::RunnerUnavailable,
            ));
        }

        let job_id = self
            .ids
            .next_job_id()
            .filter(|value| is_valid_opaque_id(value))
            .ok_or_else(|| BlenderJobCoreError::new(BlenderJobCoreErrorCode::JobIdUnavailable))?;
        let now = self.shared.now_ms();
        let cancellation = Arc::new(AtomicBool::new(false));
        let (start_sender, start_receiver) = mpsc::sync_channel::<()>(0);

        let status = {
            let mut inner = self.shared.lock();
            if self.shared.shutting_down.load(Ordering::Acquire) {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::RuntimeShuttingDown,
                ));
            }
            prune_terminal_jobs(&mut inner);
            if inner.jobs.len() >= MAX_RETAINED_JOBS {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::JobCapacityReached,
                ));
            }
            if inner.jobs.contains_key(&job_id) {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::JobIdUnavailable,
                ));
            }
            if inner.jobs.values().any(|record| {
                !record.status.state.is_terminal() && record.request.has_same_binding(&request)
            }) || inner.active_job_id.is_some()
            {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::JobAlreadyActive,
                ));
            }

            let status = BlenderJobStatus {
                job_id: job_id.clone(),
                operation: request.operation,
                state: BlenderJobState::Starting,
                scene_id: request.scene_id.clone(),
                scene_revision: request.scene_revision,
                progress: Some(BlenderJobProgress {
                    phase: BlenderJobProgressPhase::Preparing,
                    completed: 0,
                    total: 1,
                }),
                failure: None,
                created_at_ms: now,
                updated_at_ms: now,
            };
            inner.active_job_id = Some(job_id.clone());
            inner.jobs.insert(
                job_id.clone(),
                JobRecord {
                    request: request.clone(),
                    status: status.clone(),
                    cancellation: Arc::clone(&cancellation),
                    candidate: None,
                    collected: None,
                    worker: None,
                },
            );

            let worker_shared = Arc::clone(&self.shared);
            let worker_job_id = job_id.clone();
            let worker_job = PreparedBlenderJob {
                job_id: job_id.clone(),
                request: request.clone(),
                trusted,
            };
            let worker_cancellation = Arc::clone(&cancellation);
            let handle = thread::Builder::new()
                .name("ai-canvas-blender-job".to_string())
                .spawn(move || {
                    if start_receiver.recv().is_err() {
                        worker_shared.finish_worker(
                            &worker_job_id,
                            Err(BlenderJobRunnerFailure::new(
                                BlenderJobRunnerFailureKind::Internal,
                            )),
                        );
                        return;
                    }
                    run_worker(
                        worker_shared,
                        worker_job_id,
                        worker_job,
                        worker_cancellation,
                    );
                });
            match handle {
                Ok(handle) => {
                    if let Some(record) = inner.jobs.get_mut(&job_id) {
                        record.worker = Some(handle);
                    }
                }
                Err(_) => {
                    inner.jobs.remove(&job_id);
                    inner.active_job_id = None;
                    return Err(BlenderJobCoreError::new(
                        BlenderJobCoreErrorCode::InternalState,
                    ));
                }
            }
            status
        };

        self.shared.emit_status(&status);
        if start_sender.send(()).is_err() {
            self.shared.finish_worker(
                &job_id,
                Err(BlenderJobRunnerFailure::new(
                    BlenderJobRunnerFailureKind::Internal,
                )),
            );
        }
        Ok(status)
    }

    pub fn get_status(&self, job_id: &str) -> Result<BlenderJobStatus, BlenderJobCoreError> {
        validate_job_lookup_id(job_id)?;
        self.shared
            .lock()
            .jobs
            .get(job_id)
            .map(|record| record.status.clone())
            .ok_or_else(|| BlenderJobCoreError::new(BlenderJobCoreErrorCode::JobNotFound))
    }

    pub fn cancel(&self, job_id: &str) -> Result<BlenderJobStatus, BlenderJobCoreError> {
        validate_job_lookup_id(job_id)?;
        let now = self.shared.now_ms();
        let (status, release_active) = {
            let mut inner = self.shared.lock();
            let record = inner
                .jobs
                .get_mut(job_id)
                .ok_or_else(|| BlenderJobCoreError::new(BlenderJobCoreErrorCode::JobNotFound))?;
            let mut release_active = false;
            match record.status.state {
                BlenderJobState::Starting
                | BlenderJobState::Running
                | BlenderJobState::Collecting => {
                    record.cancellation.store(true, Ordering::Release);
                    record.status.state = BlenderJobState::Cancelling;
                    record.status.updated_at_ms = record.status.updated_at_ms.max(now);
                }
                BlenderJobState::AwaitingCollection => {
                    record.cancellation.store(true, Ordering::Release);
                    record.candidate = None;
                    record.status.state = BlenderJobState::Cancelled;
                    record.status.failure = None;
                    record.status.updated_at_ms = record.status.updated_at_ms.max(now);
                    release_active = true;
                }
                BlenderJobState::Cancelling
                | BlenderJobState::Cancelled
                | BlenderJobState::Succeeded
                | BlenderJobState::Failed => {}
            }
            (record.status.clone(), release_active)
        };
        if release_active {
            let mut inner = self.shared.lock();
            if inner.active_job_id.as_deref() == Some(job_id) {
                inner.active_job_id = None;
            }
        }
        self.shared.emit_status(&status);
        Ok(status)
    }

    pub fn collect(&self, job_id: &str) -> Result<BlenderCollectedResult, BlenderJobCoreError> {
        validate_job_lookup_id(job_id)?;
        let now = self.shared.now_ms();
        let (candidate, binding, operation, collecting_status) =
            {
                let mut inner = self.shared.lock();
                let record = inner.jobs.get_mut(job_id).ok_or_else(|| {
                    BlenderJobCoreError::new(BlenderJobCoreErrorCode::JobNotFound)
                })?;
                match record.status.state {
                    BlenderJobState::Succeeded => {
                        return record.collected.clone().ok_or_else(|| {
                            BlenderJobCoreError::new(BlenderJobCoreErrorCode::InternalState)
                        });
                    }
                    BlenderJobState::Collecting => {
                        return Err(BlenderJobCoreError::new(
                            BlenderJobCoreErrorCode::JobCollectionInProgress,
                        ));
                    }
                    BlenderJobState::Cancelled | BlenderJobState::Cancelling => {
                        return Err(BlenderJobCoreError::new(
                            BlenderJobCoreErrorCode::JobCancelled,
                        ));
                    }
                    BlenderJobState::Failed => {
                        return Err(BlenderJobCoreError::new(BlenderJobCoreErrorCode::JobFailed));
                    }
                    BlenderJobState::Starting | BlenderJobState::Running => {
                        return Err(BlenderJobCoreError::new(
                            BlenderJobCoreErrorCode::JobNotCollectible,
                        ));
                    }
                    BlenderJobState::AwaitingCollection => {}
                }
                let candidate = record.candidate.take().ok_or_else(|| {
                    BlenderJobCoreError::new(BlenderJobCoreErrorCode::InternalState)
                })?;
                let binding = record.request.result_binding();
                let operation = record.request.operation;
                record.status.state = BlenderJobState::Collecting;
                record.status.updated_at_ms = record.status.updated_at_ms.max(now);
                (candidate, binding, operation, record.status.clone())
            };
        self.shared.emit_status(&collecting_status);

        let validated = validate_blender_collect_candidate(&binding, candidate)
            .map_err(|_| BlenderJobCoreError::new(BlenderJobCoreErrorCode::ResultInvalid))
            .and_then(|validated| {
                let collected = validated.collected().clone();
                if operation_has_expected_artifact(operation, &collected) {
                    Ok(collected)
                } else {
                    Err(BlenderJobCoreError::new(
                        BlenderJobCoreErrorCode::ResultInvalid,
                    ))
                }
            });

        let finished_at = self.shared.now_ms();
        let (status, result) = {
            let mut inner = self.shared.lock();
            let record = inner
                .jobs
                .get_mut(job_id)
                .ok_or_else(|| BlenderJobCoreError::new(BlenderJobCoreErrorCode::JobNotFound))?;
            if record.status.state == BlenderJobState::Cancelling
                || record.cancellation.load(Ordering::Acquire)
                || self.shared.shutting_down.load(Ordering::Acquire)
            {
                record.status.state = BlenderJobState::Cancelled;
                record.status.failure = None;
                record.status.updated_at_ms = record.status.updated_at_ms.max(finished_at);
                (
                    record.status.clone(),
                    Err(BlenderJobCoreError::new(
                        BlenderJobCoreErrorCode::JobCancelled,
                    )),
                )
            } else if record.status.state != BlenderJobState::Collecting {
                return Err(BlenderJobCoreError::new(
                    BlenderJobCoreErrorCode::InternalState,
                ));
            } else {
                match validated {
                    Ok(collected) => {
                        record.collected = Some(collected.clone());
                        record.status.state = BlenderJobState::Succeeded;
                        record.status.failure = None;
                        record.status.updated_at_ms = record.status.updated_at_ms.max(finished_at);
                        (record.status.clone(), Ok(collected))
                    }
                    Err(error) => {
                        record.status.state = BlenderJobState::Failed;
                        record.status.failure = Some(BlenderJobFailure::fixed(
                            BlenderJobFailureCode::ResultInvalid,
                        ));
                        record.status.updated_at_ms = record.status.updated_at_ms.max(finished_at);
                        (record.status.clone(), Err(error))
                    }
                }
            }
        };
        {
            let mut inner = self.shared.lock();
            if inner.active_job_id.as_deref() == Some(job_id) {
                inner.active_job_id = None;
            }
        }
        self.shared.emit_status(&status);
        result
    }

    pub fn revoke_project_grant(
        &self,
        project_grant_id: &str,
    ) -> Result<BlenderProjectGrantRevokeResult, BlenderJobCoreError> {
        if !is_valid_opaque_id(project_grant_id) {
            return Err(BlenderJobCoreError::new(
                BlenderJobCoreErrorCode::InvalidRequest,
            ));
        }
        let now = self.shared.now_ms();
        let (statuses, cancelled_jobs, release_active) = {
            let mut inner = self.shared.lock();
            let mut statuses = Vec::new();
            let mut cancelled_jobs = 0;
            let mut release_active = false;
            for record in inner.jobs.values_mut() {
                if record.request.project_grant_id != project_grant_id
                    || record.status.state.is_terminal()
                {
                    continue;
                }
                cancelled_jobs += 1;
                record.cancellation.store(true, Ordering::Release);
                record.candidate = None;
                if record.status.state == BlenderJobState::AwaitingCollection {
                    record.status.state = BlenderJobState::Cancelled;
                    record.status.failure = None;
                    release_active = true;
                } else {
                    record.status.state = BlenderJobState::Cancelling;
                }
                record.status.updated_at_ms = record.status.updated_at_ms.max(now);
                statuses.push(record.status.clone());
            }
            (statuses, cancelled_jobs, release_active)
        };
        if release_active {
            self.shared.lock().active_job_id = None;
        }
        for status in statuses {
            self.shared.emit_status(&status);
        }
        Ok(BlenderProjectGrantRevokeResult {
            project_grant_id: project_grant_id.to_string(),
            cancelled_jobs,
        })
    }

    pub fn shutdown(&self) {
        if self.shared.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let handles = {
            let mut inner = self.shared.lock();
            let mut handles = Vec::new();
            for record in inner.jobs.values_mut() {
                if !record.status.state.is_terminal() {
                    record.cancellation.store(true, Ordering::Release);
                    record.candidate = None;
                    record.status.state = BlenderJobState::Cancelling;
                }
                if let Some(handle) = record.worker.take() {
                    handles.push(handle);
                }
            }
            handles
        };

        let runner = Arc::clone(&self.shared.runner);
        let (shutdown_sender, shutdown_receiver) = mpsc::sync_channel(1);
        if thread::Builder::new()
            .name("ai-canvas-blender-shutdown".to_string())
            .spawn(move || {
                let _ = catch_unwind(AssertUnwindSafe(|| runner.shutdown()));
                let _ = shutdown_sender.send(());
            })
            .is_ok()
        {
            let _ = shutdown_receiver.recv_timeout(SHUTDOWN_GRACE);
        }

        let deadline = Instant::now() + SHUTDOWN_GRACE;
        for handle in handles {
            while !handle.is_finished() && Instant::now() < deadline {
                thread::sleep(SHUTDOWN_POLL);
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        }

        let now = self.shared.now_ms();
        let mut inner = self.shared.lock();
        inner.active_job_id = None;
        for record in inner.jobs.values_mut() {
            if !record.status.state.is_terminal() {
                record.status.state = BlenderJobState::Cancelled;
                record.status.failure = None;
                record.status.updated_at_ms = record.status.updated_at_ms.max(now);
            }
        }
    }
}

impl Drop for BlenderJobCore {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_worker(
    shared: Arc<Shared>,
    job_id: String,
    job: PreparedBlenderJob,
    cancellation: Arc<AtomicBool>,
) {
    let now = shared.now_ms();
    let (running_status, cancelled_status) = {
        let mut inner = shared.lock();
        let Some(record) = inner.jobs.get_mut(&job_id) else {
            return;
        };
        if shared.shutting_down.load(Ordering::Acquire)
            || cancellation.load(Ordering::Acquire)
            || record.status.state == BlenderJobState::Cancelling
        {
            record.status.state = BlenderJobState::Cancelled;
            record.status.failure = None;
            record.status.updated_at_ms = record.status.updated_at_ms.max(now);
            (None, Some(record.status.clone()))
        } else if record.status.state == BlenderJobState::Starting {
            record.status.state = BlenderJobState::Running;
            record.status.updated_at_ms = record.status.updated_at_ms.max(now);
            (Some(record.status.clone()), None)
        } else {
            return;
        }
    };
    let Some(running_status) = running_status else {
        let mut inner = shared.lock();
        if inner.active_job_id.as_deref() == Some(&job_id) {
            inner.active_job_id = None;
        }
        drop(inner);
        if let Some(status) = cancelled_status {
            shared.emit_status(&status);
        }
        return;
    };
    shared.emit_status(&running_status);

    let progress = BlenderJobProgressReporter {
        shared: Arc::downgrade(&shared),
        job_id: job_id.clone(),
    };
    let cancellation_handle = BlenderJobCancellation {
        cancelled: cancellation,
    };
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        shared.runner.run(job, cancellation_handle, progress)
    }))
    .unwrap_or_else(|_| {
        Err(BlenderJobRunnerFailure::new(
            BlenderJobRunnerFailureKind::Internal,
        ))
    });
    shared.finish_worker(&job_id, outcome);
}

fn runner_failure_to_public(failure: &BlenderJobRunnerFailure) -> BlenderJobFailure {
    let code = match failure.kind() {
        BlenderJobRunnerFailureKind::Unavailable => BlenderJobFailureCode::RunnerUnavailable,
        BlenderJobRunnerFailureKind::StartupFailed => BlenderJobFailureCode::StartupFailed,
        BlenderJobRunnerFailureKind::Crashed => BlenderJobFailureCode::ProcessCrashed,
        BlenderJobRunnerFailureKind::TimedOut => BlenderJobFailureCode::TimedOut,
        BlenderJobRunnerFailureKind::Cancelled => {
            return BlenderJobFailure::fixed(BlenderJobFailureCode::InternalFailure)
        }
        BlenderJobRunnerFailureKind::ResultInvalid => BlenderJobFailureCode::ResultInvalid,
        BlenderJobRunnerFailureKind::Internal => BlenderJobFailureCode::InternalFailure,
    };
    BlenderJobFailure::fixed(code)
}

fn operation_has_expected_artifact(
    operation: BlenderJobOperation,
    result: &BlenderCollectedResult,
) -> bool {
    let expected_kind = match operation {
        BlenderJobOperation::OpenEditor => BlenderResultArtifactKind::BlendProject,
        BlenderJobOperation::RenderFrame => BlenderResultArtifactKind::FrameImage,
        BlenderJobOperation::RenderVideo => BlenderResultArtifactKind::ReferenceVideo,
    };
    result
        .manifest
        .artifacts
        .iter()
        .any(|artifact| artifact.kind == expected_kind)
}

fn prune_terminal_jobs(inner: &mut RuntimeInner) {
    if inner.jobs.len() < MAX_RETAINED_JOBS {
        return;
    }
    let mut terminal: Vec<_> = inner
        .jobs
        .iter()
        .filter(|(_, record)| record.status.state.is_terminal())
        .map(|(job_id, record)| (job_id.clone(), record.status.updated_at_ms))
        .collect();
    terminal.sort_by_key(|(_, updated_at)| *updated_at);
    for (job_id, _) in terminal {
        if inner.jobs.len() < MAX_RETAINED_JOBS {
            break;
        }
        inner.jobs.remove(&job_id);
    }
}

fn validate_job_lookup_id(job_id: &str) -> Result<(), BlenderJobCoreError> {
    if is_valid_opaque_id(job_id) {
        Ok(())
    } else {
        Err(BlenderJobCoreError::new(
            BlenderJobCoreErrorCode::InvalidRequest,
        ))
    }
}

fn is_positive_safe_integer(value: u64) -> bool {
    value > 0 && value <= JS_SAFE_INTEGER_MAX
}

fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn is_valid_opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn is_valid_scene_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_OPAQUE_ID_BYTES {
        return false;
    }
    let is_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    is_edge(bytes[0])
        && is_edge(bytes[bytes.len() - 1])
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::super::result::{
        BlenderResultArtifact, BlenderResultManifest, BlenderResultProducer, BlenderResultRuntime,
    };
    use super::*;

    #[derive(Default)]
    struct FixedClock(AtomicU64);

    impl BlenderJobClock for FixedClock {
        fn now_ms(&self) -> u64 {
            self.0.fetch_add(1, Ordering::Relaxed)
        }
    }

    struct FixedIds;

    impl BlenderJobIdGenerator for FixedIds {
        fn next_job_id(&self) -> Option<String> {
            Some("blender-job-test-1".to_string())
        }
    }

    struct ImmediateRunner;

    impl BlenderJobRunner for ImmediateRunner {
        fn is_available(&self) -> bool {
            true
        }

        fn run(
            &self,
            job: PreparedBlenderJob,
            _cancellation: BlenderJobCancellation,
            progress: BlenderJobProgressReporter,
        ) -> Result<BlenderCollectCandidate, BlenderJobRunnerFailure> {
            let _ = progress.report(BlenderJobProgressPhase::Rendering, 1, 1);
            let hash = "b".repeat(64);
            let manifest = BlenderResultManifest {
                schema_version: 1,
                scene_id: job.request.scene_id,
                scene_revision: job.request.scene_revision,
                scene_sha256: job.request.scene_sha256,
                manifest_revision: 1,
                producer: BlenderResultProducer {
                    runtime: BlenderResultRuntime::Blender,
                    adapter_version: "1.0.0".to_string(),
                    blender_version: "4.5.0".to_string(),
                },
                artifacts: vec![BlenderResultArtifact {
                    artifact_id: "frame-1".to_string(),
                    kind: BlenderResultArtifactKind::FrameImage,
                    mime_type: "image/png".to_string(),
                    relative_path: format!("director/scenes/scene-1/results/frame-1-{hash}.png"),
                    sha256: hash,
                    bytes: 16,
                    frame: Some(1),
                    start_frame: None,
                    end_frame: None,
                    fps: None,
                }],
            };
            let mut bytes = serde_json::to_vec_pretty(&manifest).expect("serialize manifest");
            bytes.push(b'\n');
            Ok(BlenderCollectCandidate::new(bytes))
        }
    }

    fn request() -> BlenderJobStartRequest {
        BlenderJobStartRequest {
            installation_id: "blender-installation-test".to_string(),
            operation: BlenderJobOperation::RenderFrame,
            project_grant_id: "project-grant-test".to_string(),
            project_id: "project-1".to_string(),
            director_instance_id: "director-1".to_string(),
            scene_id: "scene-1".to_string(),
            scene_revision: 1,
            scene_sha256: "a".repeat(64),
            previous_manifest_revision: None,
            previous_manifest_sha256: None,
            target_frame: Some(1),
        }
    }

    fn trusted() -> BlenderJobTrustedContext {
        let root = PathBuf::from("C:/ai-canvas-test");
        BlenderJobTrustedContext {
            executable: root.join("blender.exe"),
            project_root: root.join("project"),
            private_root: root.join("private"),
            resources: super::super::resources::TrustedBlenderResourcePaths {
                runtime_root: root.join("runtime"),
                runtime_manifest: root.join("runtime/runtime-manifest.json"),
                blender_user_scripts_root: root.join("runtime/scripts"),
                application_templates_root: root
                    .join("runtime/scripts/startup/bl_app_templates_user"),
                application_template_root: root
                    .join("runtime/scripts/startup/bl_app_templates_user/ai_canvas_director"),
                jobs_root: root.join("runtime/jobs"),
                job_script: root.join("runtime/jobs/job.py"),
            },
        }
    }

    #[test]
    fn default_runner_fails_closed() {
        let core = BlenderJobCore::default();
        let error = core
            .start(request(), trusted())
            .expect_err("default runner is unavailable");
        assert_eq!(error.code, BlenderJobCoreErrorCode::RunnerUnavailable);
    }

    #[test]
    fn injected_runner_reaches_collect_and_succeeds() {
        let core = BlenderJobCore::with_dependencies(
            Arc::new(ImmediateRunner),
            Arc::new(FixedClock::default()),
            Arc::new(FixedIds),
            Arc::new(NoopBlenderJobEventSink),
        );
        let started = core.start(request(), trusted()).expect("job should start");
        for _ in 0..100 {
            if core
                .get_status(&started.job_id)
                .expect("status should exist")
                .state
                == BlenderJobState::AwaitingCollection
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let result = core
            .collect(&started.job_id)
            .expect("result should collect");
        assert_eq!(result.manifest.scene_id, "scene-1");
        assert_eq!(
            core.get_status(&started.job_id)
                .expect("status should exist")
                .state,
            BlenderJobState::Succeeded
        );
    }
}
