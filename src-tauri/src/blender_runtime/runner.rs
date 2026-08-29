//! 固定 AI Canvas Blender Job 的原生执行器。
//!
//! Rust 持有路径、参数、进程树与结果提交权；Blender 只运行编译内嵌的固定 bpy
//! 适配器。IPC 无法提供 Python、argv、cwd、环境变量或输出路径。

use super::job::{
    BlenderJobCancellation, BlenderJobOperation, BlenderJobProgressPhase,
    BlenderJobProgressReporter, BlenderJobRunner, BlenderJobRunnerFailure,
    BlenderJobRunnerFailureKind, PreparedBlenderJob,
};
use super::result::{
    canonical_manifest_bytes, expected_artifact_relative_path, validate_blender_collect_candidate,
    validate_existing_blender_manifest, BlenderCollectCandidate, BlenderResultArtifact,
    BlenderResultArtifactKind, BlenderResultManifest, BlenderResultProducer, BlenderResultRuntime,
    BLENDER_RESULT_MANIFEST_MAX_BYTES, BLENDER_RESULT_MAX_ARTIFACTS,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const JOB_PROTOCOL: &str = "ai-canvas-blender-job-v1";
const ADAPTER_VERSION: &str = "1.0.0";
const MAX_SCENE_BYTES: usize = 2 * 1024 * 1024;
const MAX_STAGING_RESULT_BYTES: usize = 64 * 1024;
const MAX_FRAME_IMAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_REFERENCE_VIDEO_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_BLEND_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const PROCESS_POLL: Duration = Duration::from_millis(100);
const RENDER_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const EDITOR_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const TERMINATION_WAIT: Duration = Duration::from_secs(5);

static JOB_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static COMMIT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) struct NativeBlenderJobRunner {
    #[cfg(windows)]
    active: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

impl Default for NativeBlenderJobRunner {
    fn default() -> Self {
        Self {
            #[cfg(windows)]
            active: Mutex::new(HashMap::new()),
        }
    }
}

impl BlenderJobRunner for NativeBlenderJobRunner {
    fn is_available(&self) -> bool {
        cfg!(windows)
    }

    fn run(
        &self,
        job: PreparedBlenderJob,
        cancellation: BlenderJobCancellation,
        progress: BlenderJobProgressReporter,
    ) -> Result<BlenderCollectCandidate, BlenderJobRunnerFailure> {
        #[cfg(windows)]
        {
            return self.run_windows(job, cancellation, progress);
        }
        #[cfg(not(windows))]
        {
            let _ = (job, cancellation, progress);
            Err(BlenderJobRunnerFailure::new(
                BlenderJobRunnerFailureKind::Unavailable,
            ))
        }
    }

    fn shutdown(&self) {
        #[cfg(windows)]
        {
            let processes: Vec<_> = self
                .active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .values()
                .cloned()
                .collect();
            for process in processes {
                process.terminate();
            }
        }
    }
}

impl NativeBlenderJobRunner {
    #[cfg(windows)]
    fn run_windows(
        &self,
        job: PreparedBlenderJob,
        cancellation: BlenderJobCancellation,
        progress: BlenderJobProgressReporter,
    ) -> Result<BlenderCollectCandidate, BlenderJobRunnerFailure> {
        if cancellation.is_cancelled() {
            return Err(cancelled_failure());
        }
        let _ = progress.report(BlenderJobProgressPhase::Preparing, 0, 4);
        let layout = prepare_job_layout(&job).map_err(result_failure)?;

        if cancellation.is_cancelled() {
            cleanup_job_directory(&job.trusted.private_root, &layout.job_directory);
            return Err(cancelled_failure());
        }
        let _ = progress.report(BlenderJobProgressPhase::LoadingScene, 1, 4);
        let process_result = self.execute_blender(&job, &layout, &cancellation);
        if let Err(error) = process_result {
            cleanup_job_directory(&job.trusted.private_root, &layout.job_directory);
            return Err(error);
        }

        if cancellation.is_cancelled() {
            cleanup_job_directory(&job.trusted.private_root, &layout.job_directory);
            return Err(cancelled_failure());
        }
        let phase = match job.request.operation {
            BlenderJobOperation::OpenEditor => BlenderJobProgressPhase::Saving,
            BlenderJobOperation::RenderFrame | BlenderJobOperation::RenderVideo => {
                BlenderJobProgressPhase::Rendering
            }
        };
        let _ = progress.report(phase, 3, 4);
        let candidate = collect_and_commit(&job, &layout, &cancellation).map_err(result_failure);
        if candidate.is_ok() {
            let _ = progress.report(BlenderJobProgressPhase::Finalizing, 4, 4);
        }
        cleanup_job_directory(&job.trusted.private_root, &layout.job_directory);
        candidate
    }

    #[cfg(windows)]
    fn execute_blender(
        &self,
        job: &PreparedBlenderJob,
        layout: &JobLayout,
        cancellation: &BlenderJobCancellation,
    ) -> Result<(), BlenderJobRunnerFailure> {
        let background = job.request.operation != BlenderJobOperation::OpenEditor;
        let arguments = build_blender_arguments(
            &job.trusted.executable,
            &job.trusted
                .resources
                .application_template_root
                .join("startup.blend"),
            &job.trusted
                .resources
                .application_template_root
                .join("__init__.py"),
            &job.trusted.resources.job_script,
            background,
        );

        let environment = build_windows_environment().map_err(startup_failure)?;
        let process = spawn_managed_process(
            &job.trusted.executable,
            &arguments,
            &environment,
            &layout.job_directory,
            background,
        )?;

        {
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if active
                .insert(job.job_id.clone(), Arc::clone(&process))
                .is_some()
            {
                process.terminate();
                return Err(BlenderJobRunnerFailure::new(
                    BlenderJobRunnerFailureKind::Internal,
                ));
            }
        }
        if let Err(error) = process.resume() {
            process.terminate();
            let _ = process.wait_for_exit(TERMINATION_WAIT);
            self.active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&job.job_id);
            return Err(startup_failure(error));
        }

        let timeout = if background {
            RENDER_TIMEOUT
        } else {
            EDITOR_TIMEOUT
        };
        let started = Instant::now();
        let exit_code = loop {
            if cancellation.is_cancelled() {
                process.terminate();
                let _ = process.wait_for_exit(TERMINATION_WAIT);
                self.active
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&job.job_id);
                return Err(cancelled_failure());
            }
            if started.elapsed() >= timeout {
                process.terminate();
                let _ = process.wait_for_exit(TERMINATION_WAIT);
                self.active
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&job.job_id);
                return Err(BlenderJobRunnerFailure::new(
                    BlenderJobRunnerFailureKind::TimedOut,
                ));
            }
            match process.poll_exit(PROCESS_POLL) {
                Ok(Some(code)) => break code,
                Ok(None) => {}
                Err(diagnostic) => {
                    process.terminate();
                    let _ = process.wait_for_exit(TERMINATION_WAIT);
                    self.active
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .remove(&job.job_id);
                    return Err(BlenderJobRunnerFailure::with_private_diagnostic(
                        BlenderJobRunnerFailureKind::Internal,
                        diagnostic,
                    ));
                }
            }
        };
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&job.job_id);
        drop(process);

        match exit_code {
            0 => Ok(()),
            23 => Err(BlenderJobRunnerFailure::new(
                BlenderJobRunnerFailureKind::ResultInvalid,
            )),
            _ => Err(BlenderJobRunnerFailure::new(
                BlenderJobRunnerFailureKind::Crashed,
            )),
        }
    }
}

#[cfg(windows)]
fn build_blender_arguments(
    executable: &Path,
    startup_blend: &Path,
    template_init: &Path,
    job_script: &Path,
    background: bool,
) -> Vec<OsString> {
    let mut arguments = vec![executable.as_os_str().to_owned()];
    if background {
        arguments.extend([
            OsString::from("--background"),
            // 后台 Job 不读取用户首选项，也不会加载用户已启用的插件。
            OsString::from("--factory-startup"),
        ]);
    }
    arguments.extend([
        OsString::from("--disable-autoexec"),
        startup_blend.as_os_str().to_owned(),
        OsString::from("--python-exit-code"),
        OsString::from("23"),
        OsString::from("--python"),
        template_init.as_os_str().to_owned(),
        OsString::from("--python"),
        job_script.as_os_str().to_owned(),
    ]);
    arguments
}

fn cancelled_failure() -> BlenderJobRunnerFailure {
    BlenderJobRunnerFailure::new(BlenderJobRunnerFailureKind::Cancelled)
}

fn result_failure(diagnostic: String) -> BlenderJobRunnerFailure {
    BlenderJobRunnerFailure::with_private_diagnostic(
        BlenderJobRunnerFailureKind::ResultInvalid,
        diagnostic,
    )
}

fn startup_failure(diagnostic: impl Into<String>) -> BlenderJobRunnerFailure {
    BlenderJobRunnerFailure::with_private_diagnostic(
        BlenderJobRunnerFailureKind::StartupFailed,
        diagnostic,
    )
}

struct JobLayout {
    job_directory: PathBuf,
    output_directory: PathBuf,
    previous_artifacts: Vec<BlenderResultArtifact>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixedJobRequest<'a> {
    schema_version: u32,
    protocol: &'static str,
    job_id: &'a str,
    operation: BlenderJobOperation,
    scene_id: &'a str,
    scene_revision: u64,
    scene_sha256: &'a str,
    manifest_revision: u64,
    target_frame: Option<u64>,
    base_blend: Option<BaseBlendRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BaseBlendRequest {
    staged_file_name: &'static str,
    sha256: String,
    bytes: u64,
}

fn prepare_job_layout(job: &PreparedBlenderJob) -> Result<JobLayout, String> {
    let scene_relative = format!(
        "director/scenes/{}/scene-r{}-{}.json",
        job.request.scene_id, job.request.scene_revision, job.request.scene_sha256
    );
    let scene_path = join_project_relative(&job.trusted.project_root, &scene_relative)?;
    let scene_bytes =
        read_bounded_plain_file(&job.trusted.project_root, &scene_path, MAX_SCENE_BYTES)?;
    if format!("{:x}", Sha256::digest(&scene_bytes)) != job.request.scene_sha256 {
        return Err("Director Scene 内容哈希不匹配".to_string());
    }

    let (previous_artifacts, base_artifact) = load_previous_manifest(job)?;
    let job_directory = create_private_job_directory(&job.trusted.private_root, &job.job_id)?;
    let input_directory = job_directory.join("input");
    let output_directory = job_directory.join("output");
    for directory in [&input_directory, &output_directory] {
        fs::create_dir_all(directory).map_err(|_| "无法创建 Blender Job 私有目录".to_string())?;
        ensure_plain_directory(directory)?;
    }

    write_new_synced(&input_directory.join("scene.json"), &scene_bytes)?;
    let base_blend = if let Some(artifact) = base_artifact {
        let source = join_project_relative(&job.trusted.project_root, &artifact.relative_path)?;
        verify_artifact_file(&job.trusted.project_root, &source, &artifact)?;
        let staged = input_directory.join("base.blend");
        copy_new_synced(&source, &staged, artifact.bytes, &artifact.sha256)?;
        Some(BaseBlendRequest {
            staged_file_name: "base.blend",
            sha256: artifact.sha256,
            bytes: artifact.bytes,
        })
    } else {
        None
    };

    let manifest_revision = job
        .request
        .previous_manifest_revision
        .map_or(1, |revision| revision + 1);
    let fixed_request = FixedJobRequest {
        schema_version: 1,
        protocol: JOB_PROTOCOL,
        job_id: &job.job_id,
        operation: job.request.operation,
        scene_id: &job.request.scene_id,
        scene_revision: job.request.scene_revision,
        scene_sha256: &job.request.scene_sha256,
        manifest_revision,
        target_frame: job.request.target_frame,
        base_blend,
    };
    let mut request_bytes = serde_json::to_vec_pretty(&fixed_request)
        .map_err(|_| "无法构造 Blender Job 请求".to_string())?;
    request_bytes.push(b'\n');
    write_new_synced(&job_directory.join("request.json"), &request_bytes)?;

    Ok(JobLayout {
        job_directory,
        output_directory,
        previous_artifacts,
    })
}

fn load_previous_manifest(
    job: &PreparedBlenderJob,
) -> Result<(Vec<BlenderResultArtifact>, Option<BlenderResultArtifact>), String> {
    let (Some(revision), Some(hash)) = (
        job.request.previous_manifest_revision,
        job.request.previous_manifest_sha256.as_deref(),
    ) else {
        return Ok((Vec::new(), None));
    };
    let relative = format!(
        "director/scenes/{}/results/manifest-r{}-{}.json",
        job.request.scene_id, revision, hash
    );
    let path = join_project_relative(&job.trusted.project_root, &relative)?;
    let bytes = read_bounded_plain_file(
        &job.trusted.project_root,
        &path,
        BLENDER_RESULT_MANIFEST_MAX_BYTES,
    )?;
    let manifest =
        validate_existing_blender_manifest(&job.request.result_binding(), revision, hash, &bytes)
            .map_err(|_| "上一份 Blender 结果清单无效".to_string())?;
    for artifact in &manifest.artifacts {
        let artifact_path =
            join_project_relative(&job.trusted.project_root, &artifact.relative_path)?;
        verify_artifact_file(&job.trusted.project_root, &artifact_path, artifact)?;
    }
    let base = manifest
        .artifacts
        .iter()
        .rev()
        .find(|artifact| artifact.kind == BlenderResultArtifactKind::BlendProject)
        .cloned();
    Ok((manifest.artifacts, base))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagedJobResult {
    schema_version: u32,
    protocol: String,
    job_id: String,
    scene_id: String,
    scene_revision: u64,
    scene_sha256: String,
    manifest_revision: u64,
    producer: BlenderResultProducer,
    artifact_candidates: Vec<StagedArtifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagedArtifact {
    artifact_id: String,
    kind: BlenderResultArtifactKind,
    mime_type: String,
    staged_file_name: String,
    sha256: String,
    bytes: u64,
    frame: Option<u64>,
    start_frame: Option<u64>,
    end_frame: Option<u64>,
    fps: Option<serde_json::Number>,
}

fn collect_and_commit(
    job: &PreparedBlenderJob,
    layout: &JobLayout,
    cancellation: &BlenderJobCancellation,
) -> Result<BlenderCollectCandidate, String> {
    let result_path = layout.output_directory.join("job-result.json");
    let result_bytes = read_bounded_plain_file(
        &layout.output_directory,
        &result_path,
        MAX_STAGING_RESULT_BYTES,
    )?;
    if std::str::from_utf8(&result_bytes).is_err() || result_bytes.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return Err("Blender Job 结果编码无效".to_string());
    }
    let staged: StagedJobResult = serde_json::from_slice(&result_bytes)
        .map_err(|_| "Blender Job 结果结构无效".to_string())?;
    let expected_revision = job
        .request
        .previous_manifest_revision
        .map_or(1, |revision| revision + 1);
    if staged.schema_version != 1
        || staged.protocol != JOB_PROTOCOL
        || staged.job_id != job.job_id
        || staged.scene_id != job.request.scene_id
        || staged.scene_revision != job.request.scene_revision
        || staged.scene_sha256 != job.request.scene_sha256
        || staged.manifest_revision != expected_revision
        || staged.producer.runtime != BlenderResultRuntime::Blender
        || staged.producer.adapter_version != ADAPTER_VERSION
        || !staged.producer.blender_version.starts_with("5.2.1")
    {
        return Err("Blender Job 结果绑定无效".to_string());
    }
    validate_operation_artifacts(job, &staged.artifact_candidates)?;
    validate_output_directory(&layout.output_directory, &staged.artifact_candidates)?;

    let mut artifacts = layout.previous_artifacts.clone();
    for candidate in staged.artifact_candidates {
        if cancellation.is_cancelled() {
            return Err("Blender Job 已取消".to_string());
        }
        let staged_path = layout.output_directory.join(&candidate.staged_file_name);
        let (actual_bytes, actual_hash, _) = hash_plain_file(
            &layout.output_directory,
            &staged_path,
            artifact_limit(candidate.kind),
        )?;
        if actual_bytes != candidate.bytes || actual_hash != candidate.sha256 {
            return Err("Blender Job artifact 内容不匹配".to_string());
        }
        verify_magic(&staged_path, candidate.kind)?;
        let expected_id = format!("{}-{}", artifact_prefix(candidate.kind), candidate.sha256);
        if candidate.artifact_id != expected_id
            || candidate.mime_type != candidate.kind.expected_mime_type()
        {
            return Err("Blender Job artifact 标识无效".to_string());
        }

        let mut artifact = BlenderResultArtifact {
            artifact_id: candidate.artifact_id,
            kind: candidate.kind,
            mime_type: candidate.mime_type,
            relative_path: String::new(),
            sha256: candidate.sha256,
            bytes: candidate.bytes,
            frame: candidate.frame,
            start_frame: candidate.start_frame,
            end_frame: candidate.end_frame,
            fps: candidate.fps,
        };
        artifact.relative_path = expected_artifact_relative_path(&job.request.scene_id, &artifact);
        let target = join_project_relative(&job.trusted.project_root, &artifact.relative_path)?;
        persist_staged_artifact(&job.trusted.project_root, &staged_path, &target, &artifact)?;
        if let Some(existing) = artifacts
            .iter()
            .find(|existing| existing.artifact_id == artifact.artifact_id)
        {
            if existing != &artifact {
                return Err("Blender artifact 标识发生冲突".to_string());
            }
        } else {
            artifacts.push(artifact);
        }
    }
    if artifacts.len() > BLENDER_RESULT_MAX_ARTIFACTS {
        return Err("Blender 结果 artifact 数量超过上限".to_string());
    }

    let manifest = BlenderResultManifest {
        schema_version: 1,
        scene_id: job.request.scene_id.clone(),
        scene_revision: job.request.scene_revision,
        scene_sha256: job.request.scene_sha256.clone(),
        manifest_revision: expected_revision,
        producer: staged.producer,
        artifacts,
    };
    let canonical = canonical_manifest_bytes(&manifest)
        .map_err(|_| "无法生成规范 Blender 结果清单".to_string())?;
    let validated = validate_blender_collect_candidate(
        &job.request.result_binding(),
        BlenderCollectCandidate::new(canonical),
    )
    .map_err(|_| "Blender 结果清单校验失败".to_string())?;
    if cancellation.is_cancelled() {
        return Err("Blender Job 已取消".to_string());
    }
    let manifest_target = join_project_relative(
        &job.trusted.project_root,
        &validated.collected().manifest_reference.relative_path,
    )?;
    persist_bytes_immutable(
        &job.trusted.project_root,
        &manifest_target,
        validated.canonical_manifest_bytes(),
    )?;
    Ok(BlenderCollectCandidate::new(
        validated.canonical_manifest_bytes().to_vec(),
    ))
}

fn validate_operation_artifacts(
    job: &PreparedBlenderJob,
    artifacts: &[StagedArtifact],
) -> Result<(), String> {
    let frame_count = artifacts
        .iter()
        .filter(|artifact| artifact.kind == BlenderResultArtifactKind::FrameImage)
        .count();
    let video_count = artifacts
        .iter()
        .filter(|artifact| artifact.kind == BlenderResultArtifactKind::ReferenceVideo)
        .count();
    let blend_count = artifacts
        .iter()
        .filter(|artifact| artifact.kind == BlenderResultArtifactKind::BlendProject)
        .count();
    let exact = match job.request.operation {
        BlenderJobOperation::OpenEditor => {
            artifacts.len() == 1 && frame_count == 0 && video_count == 0 && blend_count == 1
        }
        BlenderJobOperation::RenderFrame => {
            artifacts.len() == 2 && frame_count == 1 && video_count == 0 && blend_count == 1
        }
        BlenderJobOperation::RenderVideo => {
            artifacts.len() == 2 && frame_count == 0 && video_count == 1 && blend_count == 1
        }
    };
    if !exact {
        return Err("Blender Job artifact 集合无效".to_string());
    }
    let mut ids = HashSet::new();
    let mut staged_names = HashSet::new();
    for artifact in artifacts {
        let expected_name = staged_file_name(artifact.kind);
        if artifact.staged_file_name != expected_name
            || artifact.bytes == 0
            || artifact.bytes > artifact_limit(artifact.kind)
            || !ids.insert(artifact.artifact_id.as_str())
            || !staged_names.insert(artifact.staged_file_name.as_str())
        {
            return Err("Blender Job artifact 描述无效".to_string());
        }
        match artifact.kind {
            BlenderResultArtifactKind::FrameImage => {
                if artifact.frame != job.request.target_frame
                    || artifact.start_frame.is_some()
                    || artifact.end_frame.is_some()
                    || artifact.fps.is_some()
                {
                    return Err("Blender 单帧结果无效".to_string());
                }
            }
            BlenderResultArtifactKind::ReferenceVideo => {
                if artifact.frame.is_some()
                    || artifact.start_frame.is_none()
                    || artifact.end_frame.is_none()
                    || artifact.fps.is_none()
                {
                    return Err("Blender 视频结果无效".to_string());
                }
            }
            BlenderResultArtifactKind::BlendProject => {
                if artifact.frame.is_some()
                    || artifact.start_frame.is_some()
                    || artifact.end_frame.is_some()
                    || artifact.fps.is_some()
                {
                    return Err("Blender 工程结果无效".to_string());
                }
            }
        }
    }
    Ok(())
}

fn validate_output_directory(output: &Path, artifacts: &[StagedArtifact]) -> Result<(), String> {
    ensure_plain_directory(output)?;
    let mut expected: HashSet<&str> = artifacts
        .iter()
        .map(|artifact| artifact.staged_file_name.as_str())
        .collect();
    expected.insert("job-result.json");
    let mut actual = HashSet::new();
    let entries = fs::read_dir(output).map_err(|_| "Blender 输出目录不可读".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "Blender 输出目录不可读".to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Blender 输出文件名无效".to_string())?;
        if !actual.insert(name.clone()) || !expected.contains(name.as_str()) {
            return Err("Blender 输出目录包含未声明内容".to_string());
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| "Blender 输出文件不可用".to_string())?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) {
            return Err("Blender 输出文件不安全".to_string());
        }
    }
    if actual.len() != expected.len() {
        return Err("Blender 输出文件不完整".to_string());
    }
    Ok(())
}

fn staged_file_name(kind: BlenderResultArtifactKind) -> &'static str {
    match kind {
        BlenderResultArtifactKind::FrameImage => "frame.png",
        BlenderResultArtifactKind::ReferenceVideo => "reference.mp4",
        BlenderResultArtifactKind::BlendProject => "project.blend",
    }
}

fn artifact_prefix(kind: BlenderResultArtifactKind) -> &'static str {
    match kind {
        BlenderResultArtifactKind::FrameImage => "frame",
        BlenderResultArtifactKind::ReferenceVideo => "video",
        BlenderResultArtifactKind::BlendProject => "blend",
    }
}

fn artifact_limit(kind: BlenderResultArtifactKind) -> u64 {
    match kind {
        BlenderResultArtifactKind::FrameImage => MAX_FRAME_IMAGE_BYTES,
        BlenderResultArtifactKind::ReferenceVideo => MAX_REFERENCE_VIDEO_BYTES,
        BlenderResultArtifactKind::BlendProject => MAX_BLEND_BYTES,
    }
}

fn verify_artifact_file(
    root: &Path,
    path: &Path,
    artifact: &BlenderResultArtifact,
) -> Result<(), String> {
    let (bytes, hash, _) = hash_plain_file(root, path, artifact_limit(artifact.kind))?;
    if bytes != artifact.bytes || hash != artifact.sha256 {
        return Err("既有 Blender artifact 内容无效".to_string());
    }
    verify_magic(path, artifact.kind)
}

fn verify_magic(path: &Path, kind: BlenderResultArtifactKind) -> Result<(), String> {
    let mut file = File::open(path).map_err(|_| "Blender artifact 不可读".to_string())?;
    let mut header = [0u8; 12];
    let count = file
        .read(&mut header)
        .map_err(|_| "Blender artifact 不可读".to_string())?;
    let valid = match kind {
        BlenderResultArtifactKind::FrameImage => {
            count >= 8 && header[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        }
        BlenderResultArtifactKind::ReferenceVideo => count >= 8 && &header[4..8] == b"ftyp",
        BlenderResultArtifactKind::BlendProject => count >= 7 && &header[..7] == b"BLENDER",
    };
    if valid {
        Ok(())
    } else {
        Err("Blender artifact 文件头无效".to_string())
    }
}

fn hash_plain_file(root: &Path, path: &Path, maximum: u64) -> Result<(u64, String, u64), String> {
    ensure_contained_plain_file(root, path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "文件不可用".to_string())?;
    if metadata.len() == 0 || metadata.len() > maximum {
        return Err("文件大小超过安全上限".to_string());
    }
    let mut file = File::open(path).map_err(|_| "文件不可读".to_string())?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "文件不可读".to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "文件大小无效".to_string())?;
        if total > maximum {
            return Err("文件大小超过安全上限".to_string());
        }
        hasher.update(&buffer[..read]);
    }
    if total != metadata.len() {
        return Err("文件在读取期间发生变化".to_string());
    }
    Ok((total, format!("{:x}", hasher.finalize()), metadata.len()))
}

fn read_bounded_plain_file(root: &Path, path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    ensure_contained_plain_file(root, path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "文件不可用".to_string())?;
    if metadata.len() == 0 || metadata.len() > maximum as u64 {
        return Err("文件大小超过安全上限".to_string());
    }
    let file = File::open(path).map_err(|_| "文件不可读".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "文件不可读".to_string())?;
    if bytes.len() as u64 != metadata.len() || bytes.len() > maximum {
        return Err("文件在读取期间发生变化".to_string());
    }
    Ok(bytes)
}

fn persist_staged_artifact(
    project_root: &Path,
    source: &Path,
    target: &Path,
    artifact: &BlenderResultArtifact,
) -> Result<(), String> {
    if target.exists() {
        return verify_artifact_file(project_root, target, artifact);
    }
    let parent = target
        .parent()
        .ok_or_else(|| "artifact 目标无效".to_string())?;
    ensure_directory_tree(project_root, parent)?;
    let temporary = temporary_commit_path(parent);
    copy_new_synced(source, &temporary, artifact.bytes, &artifact.sha256)?;
    match commit_create_new(&temporary, target) {
        Ok(()) => verify_artifact_file(project_root, target, artifact),
        Err(_) if target.exists() => {
            let _ = fs::remove_file(&temporary);
            verify_artifact_file(project_root, target, artifact)
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            Err("无法提交 Blender artifact".to_string())
        }
    }
}

fn persist_bytes_immutable(root: &Path, target: &Path, bytes: &[u8]) -> Result<(), String> {
    if target.exists() {
        let existing = read_bounded_plain_file(root, target, BLENDER_RESULT_MANIFEST_MAX_BYTES)?;
        return if existing == bytes {
            Ok(())
        } else {
            Err("Blender Manifest 目标发生冲突".to_string())
        };
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Manifest 目标无效".to_string())?;
    ensure_directory_tree(root, parent)?;
    let temporary = temporary_commit_path(parent);
    write_new_synced(&temporary, bytes)?;
    match commit_create_new(&temporary, target) {
        Ok(()) => {
            let existing =
                read_bounded_plain_file(root, target, BLENDER_RESULT_MANIFEST_MAX_BYTES)?;
            if existing == bytes {
                Ok(())
            } else {
                Err("Blender Manifest 提交校验失败".to_string())
            }
        }
        Err(_) if target.exists() => {
            let _ = fs::remove_file(&temporary);
            let existing =
                read_bounded_plain_file(root, target, BLENDER_RESULT_MANIFEST_MAX_BYTES)?;
            if existing == bytes {
                Ok(())
            } else {
                Err("Blender Manifest 目标发生冲突".to_string())
            }
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            Err("无法提交 Blender Manifest".to_string())
        }
    }
}

fn temporary_commit_path(parent: &Path) -> PathBuf {
    let sequence = COMMIT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".ai-canvas-blender-{}-{sequence}.tmp",
        std::process::id()
    ))
}

#[cfg(windows)]
fn commit_create_new(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(not(windows))]
fn commit_create_new(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(temporary, target)?;
    fs::remove_file(temporary)
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "无法创建固定 Job 文件".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法写入固定 Job 文件".to_string())
}

fn copy_new_synced(
    source: &Path,
    target: &Path,
    expected_bytes: u64,
    expected_hash: &str,
) -> Result<(), String> {
    let mut source_file = File::open(source).map_err(|_| "源文件不可读".to_string())?;
    let mut target_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| "无法创建 staging 文件".to_string())?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = source_file
            .read(&mut buffer)
            .map_err(|_| "源文件不可读".to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "源文件大小无效".to_string())?;
        target_file
            .write_all(&buffer[..read])
            .map_err(|_| "staging 文件写入失败".to_string())?;
        hasher.update(&buffer[..read]);
    }
    target_file
        .sync_all()
        .map_err(|_| "staging 文件刷新失败".to_string())?;
    if total != expected_bytes || format!("{:x}", hasher.finalize()) != expected_hash {
        let _ = fs::remove_file(target);
        return Err("staging 文件内容校验失败".to_string());
    }
    Ok(())
}

fn create_private_job_directory(private_root: &Path, job_id: &str) -> Result<PathBuf, String> {
    ensure_plain_directory(private_root)?;
    let jobs_root = private_root.join("jobs");
    fs::create_dir_all(&jobs_root).map_err(|_| "无法创建 Blender Job 根目录".to_string())?;
    ensure_plain_directory(&jobs_root)?;
    for _ in 0..64 {
        let sequence = JOB_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut hasher = Sha256::new();
        hasher.update(job_id.as_bytes());
        hasher.update(timestamp.to_le_bytes());
        hasher.update(sequence.to_le_bytes());
        let directory = jobs_root.join(format!("job-{:x}", hasher.finalize()));
        match fs::create_dir(&directory) {
            Ok(()) => {
                ensure_plain_directory(&directory)?;
                return Ok(directory);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建 Blender Job 私有目录".to_string()),
        }
    }
    Err("无法分配 Blender Job 私有目录".to_string())
}

fn cleanup_job_directory(private_root: &Path, job_directory: &Path) {
    let jobs_root = private_root.join("jobs");
    let safe_name = job_directory
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with("job-") && name.len() == 68);
    if safe_name && job_directory.parent() == Some(jobs_root.as_path()) {
        let _ = fs::remove_dir_all(job_directory);
    }
}

fn join_project_relative(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("项目相对路径无效".to_string());
    }
    Ok(root.join(relative))
}

fn ensure_directory_tree(root: &Path, target: &Path) -> Result<(), String> {
    ensure_plain_directory(root)?;
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "目标目录超出项目根".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("目标目录无效".to_string());
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            Ok(_) => return Err("项目目录包含不安全节点".to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| "无法创建项目结果目录".to_string())?;
                ensure_plain_directory(&current)?;
            }
            Err(_) => return Err("项目目录不可访问".to_string()),
        }
    }
    Ok(())
}

fn ensure_contained_plain_file(root: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "文件路径无效".to_string())?;
    ensure_existing_directory_chain(root, parent)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "文件不可用".to_string())?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err("文件不是普通文件".to_string());
    }
    let canonical_root = canonicalize_simplified(root)?;
    let canonical_path = canonicalize_simplified(path)?;
    if canonical_path == canonical_root || !canonical_path.starts_with(&canonical_root) {
        return Err("文件超出受信目录".to_string());
    }
    Ok(())
}

fn ensure_existing_directory_chain(root: &Path, target: &Path) -> Result<(), String> {
    ensure_plain_directory(root)?;
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "目录超出受信根".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("目录路径无效".to_string());
        };
        current.push(name);
        ensure_plain_directory(&current)?;
    }
    Ok(())
}

fn ensure_plain_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "目录不可用".to_string())?;
    if metadata.is_dir() && !is_link_or_reparse(&metadata) {
        Ok(())
    } else {
        Err("目录不是普通目录".to_string())
    }
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn canonicalize_simplified(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "路径无法解析".to_string())?;
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy().into_owned();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(
                rest.strip_prefix(r"UNC\")
                    .map_or_else(|| rest.to_string(), |unc| format!(r"\\{unc}")),
            ));
        }
    }
    Ok(canonical)
}

#[cfg(windows)]
struct OwnedHandle(isize);

#[cfg(windows)]
unsafe impl Send for OwnedHandle {}
#[cfg(windows)]
unsafe impl Sync for OwnedHandle {}

#[cfg(windows)]
impl OwnedHandle {
    fn new(handle: windows::Win32::Foundation::HANDLE) -> Self {
        Self(handle.0 as isize)
    }

    fn get(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(self.0 as *mut core::ffi::c_void)
    }
}

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.get());
        }
    }
}

#[cfg(windows)]
struct ManagedProcess {
    job: OwnedHandle,
    process: OwnedHandle,
    thread: Mutex<Option<OwnedHandle>>,
}

#[cfg(windows)]
impl ManagedProcess {
    fn resume(&self) -> Result<(), String> {
        use windows::Win32::System::Threading::ResumeThread;
        let thread = self
            .thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            .ok_or_else(|| "Blender 主线程句柄不可用".to_string())?;
        let result = unsafe { ResumeThread(thread.get()) };
        if result == u32::MAX {
            Err("Blender 主线程恢复失败".to_string())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.job.get(), 1223);
        }
    }

    fn poll_exit(&self, wait: Duration) -> Result<Option<u32>, String> {
        use windows::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{GetExitCodeProcess, WaitForSingleObject},
        };
        let wait_ms = wait.as_millis().min(u128::from(u32::MAX)) as u32;
        let state = unsafe { WaitForSingleObject(self.process.get(), wait_ms) };
        if state == WAIT_TIMEOUT {
            return Ok(None);
        }
        if state != WAIT_OBJECT_0 {
            return Err("等待 Blender 进程失败".to_string());
        }
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.process.get(), &mut code) }
            .map_err(|_| "读取 Blender 退出状态失败".to_string())?;
        Ok(Some(code))
    }

    fn wait_for_exit(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if self.poll_exit(PROCESS_POLL)?.is_some() {
                return Ok(());
            }
        }
        Err("Blender 进程终止等待超时".to_string())
    }
}

#[cfg(windows)]
fn spawn_managed_process(
    executable: &Path,
    arguments: &[OsString],
    environment: &[u16],
    current_directory: &Path,
    background: bool,
) -> Result<Arc<ManagedProcess>, BlenderJobRunnerFailure> {
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::BOOL,
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{
                    CreateProcessW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
                    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_CREATION_FLAGS,
                    PROCESS_INFORMATION, STARTUPINFOW,
                },
            },
        },
    };

    let executable_wide = wide_nul(executable.as_os_str()).map_err(startup_failure)?;
    let current_directory_wide =
        wide_nul(current_directory.as_os_str()).map_err(startup_failure)?;
    let mut command_line = build_windows_command_line(arguments).map_err(startup_failure)?;

    let job_handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map(OwnedHandle::new)
        .map_err(|_| startup_failure("无法创建 Blender Windows Job Object"))?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job_handle.get(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|_| startup_failure("无法配置 Blender Windows Job Object"))?;

    let mut startup = STARTUPINFOW::default();
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut information = PROCESS_INFORMATION::default();
    let mut creation_flags: PROCESS_CREATION_FLAGS = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
    if background {
        creation_flags |= CREATE_NO_WINDOW;
    }
    unsafe {
        CreateProcessW(
            PCWSTR(executable_wide.as_ptr()),
            PWSTR(command_line.as_mut_ptr()),
            None,
            None,
            BOOL(0),
            creation_flags,
            Some(environment.as_ptr().cast()),
            PCWSTR(current_directory_wide.as_ptr()),
            &startup,
            &mut information,
        )
    }
    .map_err(|_| startup_failure("Blender 进程创建失败"))?;

    let process_handle = OwnedHandle::new(information.hProcess);
    let thread_handle = OwnedHandle::new(information.hThread);
    if unsafe { AssignProcessToJobObject(job_handle.get(), process_handle.get()) }.is_err() {
        unsafe {
            let _ = TerminateProcess(process_handle.get(), 1);
            let _ = WaitForSingleObject(process_handle.get(), 5_000);
        }
        return Err(startup_failure("Blender 进程树绑定失败"));
    }

    Ok(Arc::new(ManagedProcess {
        job: job_handle,
        process: process_handle,
        thread: Mutex::new(Some(thread_handle)),
    }))
}

#[cfg(windows)]
fn build_windows_environment() -> Result<Vec<u16>, String> {
    build_windows_environment_from(std::env::vars_os())
}

#[cfg(windows)]
fn build_windows_environment_from<I>(inherited: I) -> Result<Vec<u16>, String>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    use std::os::windows::ffi::OsStrExt;
    let mut entries: HashMap<String, (OsString, OsString)> = HashMap::new();
    for (name, value) in inherited {
        let display = name.to_string_lossy();
        let upper = display.to_ascii_uppercase();
        if display.is_empty()
            || display.contains('=')
            || display.contains('\0')
            || upper.starts_with("BLENDER_")
            || upper.starts_with("PYTHON")
        {
            continue;
        }
        entries.insert(upper, (name, value));
    }
    // 不注入任何 Blender 用户/系统资源根，让编辑器按正常启动规则解析首选项、插件和扩展。
    // 外部 Blender/Python 路径覆盖仍被过滤；固定启动文件与脚本只通过受信命令参数传入。
    let mut ordered: Vec<_> = entries.into_iter().collect();
    ordered.sort_by(|left, right| left.0.cmp(&right.0));
    let mut block = Vec::new();
    for (_, (name, value)) in ordered {
        let name_wide: Vec<_> = name.encode_wide().collect();
        let value_wide: Vec<_> = value.encode_wide().collect();
        if name_wide.contains(&0) || value_wide.contains(&0) {
            return Err("Blender 环境变量包含非法字符".to_string());
        }
        block.extend(name_wide);
        block.push(b'=' as u16);
        block.extend(value_wide);
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

#[cfg(all(test, windows))]
mod environment_tests {
    use super::*;

    fn decode_environment(block: &[u16]) -> HashMap<String, String> {
        block
            .split(|value| *value == 0)
            .take_while(|entry| !entry.is_empty())
            .map(|entry| String::from_utf16(entry).expect("环境块应为 UTF-16"))
            .map(|entry| {
                let (name, value) = entry.split_once('=').expect("环境项应包含等号");
                (name.to_ascii_uppercase(), value.to_string())
            })
            .collect()
    }

    #[test]
    fn blender_environment_reuses_default_user_directories_without_path_overrides() {
        let inherited = [
            (
                OsString::from("APPDATA"),
                OsString::from(r"C:\Users\Tester\AppData\Roaming"),
            ),
            (
                OsString::from("BLENDER_USER_CONFIG"),
                OsString::from(r"C:\untrusted-config"),
            ),
            (
                OsString::from("BLENDER_USER_SCRIPTS"),
                OsString::from(r"C:\untrusted-scripts"),
            ),
            (
                OsString::from("BLENDER_SYSTEM_SCRIPTS"),
                OsString::from(r"C:\untrusted-system-scripts"),
            ),
            (
                OsString::from("PYTHONPATH"),
                OsString::from(r"C:\untrusted-python"),
            ),
        ];
        let block = build_windows_environment_from(inherited).expect("应能构造 Blender 环境");
        let environment = decode_environment(&block);

        assert_eq!(
            environment.get("APPDATA").map(String::as_str),
            Some(r"C:\Users\Tester\AppData\Roaming")
        );
        assert!(!environment.contains_key("BLENDER_USER_CONFIG"));
        assert!(!environment.contains_key("BLENDER_USER_SCRIPTS"));
        assert!(!environment.contains_key("BLENDER_SYSTEM_SCRIPTS"));
        assert!(!environment.contains_key("PYTHONPATH"));
    }

    #[test]
    fn editor_inherits_preferences_while_background_jobs_use_factory_startup() {
        let executable = Path::new(r"C:\Blender\blender.exe");
        let startup_blend = Path::new(r"C:\AI Canvas\startup.blend");
        let template_init = Path::new(r"C:\AI Canvas\__init__.py");
        let job_script = Path::new(r"C:\AI Canvas\job.py");

        let editor =
            build_blender_arguments(executable, startup_blend, template_init, job_script, false);
        assert!(!editor.contains(&OsString::from("--background")));
        assert!(!editor.contains(&OsString::from("--factory-startup")));
        assert!(!editor.contains(&OsString::from("--app-template")));
        assert!(editor.contains(&startup_blend.as_os_str().to_owned()));
        assert!(editor.contains(&template_init.as_os_str().to_owned()));
        assert_eq!(
            editor
                .iter()
                .filter(|argument| argument.as_os_str() == "--python")
                .count(),
            2
        );

        let background =
            build_blender_arguments(executable, startup_blend, template_init, job_script, true);
        assert!(background.contains(&OsString::from("--background")));
        assert!(background.contains(&OsString::from("--factory-startup")));
        assert!(background.contains(&OsString::from("--disable-autoexec")));
        assert!(!background.contains(&OsString::from("--app-template")));
    }
}

#[cfg(windows)]
fn wide_nul(value: &OsStr) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<_> = value.encode_wide().collect();
    if wide.contains(&0) {
        return Err("Windows 路径包含非法字符".to_string());
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(windows)]
fn build_windows_command_line(arguments: &[OsString]) -> Result<Vec<u16>, String> {
    use std::os::windows::ffi::OsStrExt;
    let mut command = Vec::new();
    for (index, argument) in arguments.iter().enumerate() {
        if index > 0 {
            command.push(b' ' as u16);
        }
        let wide: Vec<_> = argument.encode_wide().collect();
        if wide.contains(&0) {
            return Err("Blender 参数包含非法字符".to_string());
        }
        append_quoted_windows_argument(&mut command, &wide);
    }
    command.push(0);
    Ok(command)
}

#[cfg(windows)]
fn append_quoted_windows_argument(target: &mut Vec<u16>, argument: &[u16]) {
    let needs_quotes = argument.is_empty()
        || argument
            .iter()
            .any(|value| matches!(*value, 0x20 | 0x09 | 0x22));
    if !needs_quotes {
        target.extend_from_slice(argument);
        return;
    }
    target.push(b'"' as u16);
    let mut backslashes = 0usize;
    for value in argument {
        if *value == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if *value == b'"' as u16 {
            target.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
        } else {
            target.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        }
        backslashes = 0;
        target.push(*value);
    }
    target.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    target.push(b'"' as u16);
}
