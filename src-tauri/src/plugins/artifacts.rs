//! 可信 Python 的调用私有媒体工作区。真实路径仅注入本轮 Python 进程。
use crate::{path_policy, plugin_host_effects::PluginHostIdentity, plugin_registry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Runtime, Webview};

const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 48 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 18;
const MAX_WORKSPACES: usize = 16;
const WORKSPACE_TTL: Duration = Duration::from_secs(180);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaInput {
    resource_id: String,
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaArtifact {
    key: String,
    artifact_id: String,
    display_name: String,
    media_type: String,
    size: usize,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactDeclaration {
    key: String,
    file_name: String,
    media_type: String,
}

#[derive(Clone)]
struct Workspace {
    identity: PluginHostIdentity,
    root: PathBuf,
    inputs: BTreeMap<String, String>,
    output: PathBuf,
    ready: bool,
    revoked: Arc<AtomicBool>,
    created: Instant,
    artifacts: HashMap<String, MediaArtifact>,
}

type WorkspaceKey = (String, String);
static WORKSPACES: OnceLock<Mutex<HashMap<WorkspaceKey, Workspace>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
static CLEANED_PREVIOUS_JOBS: OnceLock<()> = OnceLock::new();

fn workspaces() -> &'static Mutex<HashMap<WorkspaceKey, Workspace>> {
    WORKSPACES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(identity: &PluginHostIdentity) -> WorkspaceKey {
    (identity.plugin_id.clone(), identity.invocation_id.clone())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn same_identity(left: &PluginHostIdentity, right: &PluginHostIdentity) -> bool {
    left.plugin_id == right.plugin_id
        && left.source_digest == right.source_digest
        && left.revision_digest == right.revision_digest
        && left.tool_id == right.tool_id
        && left.invocation_id == right.invocation_id
}

fn opaque_id(prefix: &str, identity: &PluginHostIdentity) -> String {
    let mut hash = Sha256::new();
    hash.update(identity.invocation_id.as_bytes());
    hash.update(identity.revision_digest.as_bytes());
    hash.update(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    hash.update(NEXT_ID.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    format!("{prefix}-{:x}", hash.finalize())
}

fn check_authority<R: Runtime>(
    app: &AppHandle<R>,
    identity: &PluginHostIdentity,
) -> Result<(), String> {
    if !valid_id(&identity.invocation_id) {
        return Err("媒体调用 ID 无效".into());
    }
    let executable = plugin_registry::load_plugin_for_execution(
        app,
        &identity.plugin_id,
        &identity.source_digest,
        &identity.revision_digest,
        &identity.tool_id,
    )?;
    if executable.runtime != "python"
        || !executable
            .python_execution
            .is_some_and(|declaration| declaration.media_workspace)
    {
        return Err("该活动 Python 工具没有媒体工作区授权".into());
    }
    crate::plugin_runtime::ensure_invocation_not_cancelled(
        &identity.plugin_id,
        &identity.invocation_id,
    )
}

#[cfg(windows)]
fn is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink()
}
#[cfg(not(windows))]
fn is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn ordinary_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "媒体工作区目录不可访问")?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("媒体工作区目录不是普通目录".into());
    }
    path.canonicalize()
        .map_err(|_| "媒体工作区目录不可访问".into())
}

fn ordinary_output(root: &Path, output: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.len() > 128
        || !name.ends_with(".mp4")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || name.contains("..")
    {
        return Err("媒体产物文件名无效".into());
    }
    let canonical_root = ordinary_directory(root)?;
    let canonical_output = ordinary_directory(output)?;
    if canonical_output.parent() != Some(canonical_root.as_path()) {
        return Err("媒体产物目录已变化".into());
    }
    let path = output.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|_| "媒体产物不存在")?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("媒体产物不是普通文件".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("媒体产物不允许硬链接".into());
        }
    }
    let canonical = path.canonicalize().map_err(|_| "媒体产物不可访问")?;
    if canonical.parent() != Some(canonical_output.as_path()) {
        return Err("媒体产物越出工作区".into());
    }
    Ok(canonical)
}

// 只清理已创建的调用目录，不跟随符号链接或 Windows 重解析目录。
fn remove_workspace_tree(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if is_link(&metadata) {
        if metadata.is_dir() {
            let _ = fs::remove_dir(path);
        } else {
            let _ = fs::remove_file(path);
        }
    } else if metadata.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                remove_workspace_tree(&entry.path());
            }
        }
        let _ = fs::remove_dir(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

fn discard(workspace: Workspace) {
    workspace.revoked.store(true, Ordering::Release);
    remove_workspace_tree(&workspace.root);
}

// Windows 上撤销时文件可能仍被复制线程或 Python 占用，退出后再做一次幂等清理。
pub(crate) struct MediaWorkspaceCleanup(Workspace);

impl Drop for MediaWorkspaceCleanup {
    fn drop(&mut self) {
        if self.0.revoked.load(Ordering::Acquire) {
            remove_workspace_tree(&self.0.root);
        }
    }
}

pub(crate) fn cleanup_guard(
    identity: &PluginHostIdentity,
) -> Result<MediaWorkspaceCleanup, String> {
    snapshot(identity).map(MediaWorkspaceCleanup)
}

pub(crate) fn revoke_plugin_workspaces(plugin_id: Option<&str>) {
    let removed = {
        let mut map = workspaces()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let keys: Vec<_> = map
            .iter()
            .filter(|(_, workspace)| plugin_id.is_none_or(|id| workspace.identity.plugin_id == id))
            .map(|(key, _)| key.clone())
            .collect();
        keys.into_iter()
            .filter_map(|key| map.remove(&key))
            .collect::<Vec<_>>()
    };
    for workspace in removed {
        discard(workspace);
    }
}

pub(crate) fn revoke_invocation(identity: &PluginHostIdentity) {
    let removed = {
        let mut map = workspaces()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map
            .get(&key(identity))
            .is_some_and(|workspace| same_identity(&workspace.identity, identity))
        {
            map.remove(&key(identity))
        } else {
            None
        }
    };
    if let Some(workspace) = removed {
        discard(workspace);
    }
}

pub(crate) fn revoke_invocation_by_id(plugin_id: &str, invocation_id: &str) {
    let removed = workspaces()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(plugin_id.to_string(), invocation_id.to_string()));
    if let Some(workspace) = removed {
        discard(workspace);
    }
}

fn snapshot(identity: &PluginHostIdentity) -> Result<Workspace, String> {
    let map = workspaces().lock().map_err(|_| "媒体工作区锁异常")?;
    map.get(&key(identity))
        .filter(|workspace| {
            same_identity(&workspace.identity, identity)
                && workspace.ready
                && !workspace.revoked.load(Ordering::Acquire)
                && workspace.created.elapsed() < WORKSPACE_TTL
        })
        .cloned()
        .ok_or_else(|| "媒体工作区已失效".into())
}

pub(crate) fn inject_python_input(
    identity: &PluginHostIdentity,
    input: &mut Value,
) -> Result<(), String> {
    let workspace = snapshot(identity)?;
    ordinary_directory(&workspace.root)?;
    ordinary_directory(&workspace.output)?;
    input.as_object_mut().ok_or("插件输入必须是对象")?.insert(
        "nativeMedia".into(),
        json!({
            "inputFiles": workspace.inputs, "outputDir": workspace.output.to_string_lossy(),
        }),
    );
    Ok(())
}

fn copy_input(source: &Path, target: &Path, cancelled: &AtomicBool) -> Result<(), String> {
    let mut input = File::open(source).map_err(|_| "无法读取授权媒体")?;
    let size = input.metadata().map_err(|_| "无法检查授权媒体")?.len();
    if size == 0 || size > MAX_INPUT_BYTES {
        return Err("源视频为空或超过 256 MiB".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| "无法暂存授权媒体")?;
    let mut copied = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("媒体操作已取消".into());
        }
        let count = input.read(&mut buffer).map_err(|_| "授权媒体读取失败")?;
        if count == 0 {
            break;
        }
        copied += count as u64;
        if copied > MAX_INPUT_BYTES || copied > size {
            return Err("源视频在暂存期间变化".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| "授权媒体暂存失败")?;
    }
    if copied != size {
        return Err("源视频在暂存期间变化".into());
    }
    output.sync_all().map_err(|_| "授权媒体暂存失败".into())
}

fn prepare<R: Runtime>(
    app: &AppHandle<R>,
    identity: PluginHostIdentity,
    inputs: Vec<MediaInput>,
) -> Result<(), String> {
    check_authority(app, &identity)?;
    if inputs.len() != 1 || !valid_id(&inputs[0].resource_id) {
        return Err("媒体工作区需要一个授权视频资源".into());
    }
    let source = path_policy::authorize_existing_plain_file(app, &inputs[0].path)?;
    let private = plugin_registry::plugin_private_dir(app)?;
    ordinary_directory(&private)?;
    let jobs = private.join("media-jobs");
    match fs::create_dir(&jobs) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("无法创建媒体任务目录".into()),
    }
    let jobs = ordinary_directory(&jobs)?;
    // 上次异常退出仅可能留下本模块生成的调用目录；首次准备前清理，不触碰其它私有文件。
    CLEANED_PREVIOUS_JOBS.get_or_init(|| {
        if let Ok(entries) = fs::read_dir(&jobs) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.strip_prefix("job-").is_some_and(|id| {
                    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                }) {
                    remove_workspace_tree(&entry.path());
                }
            }
        }
    });
    let root = jobs.join(opaque_id("job", &identity));
    fs::create_dir(&root).map_err(|_| "无法创建媒体工作区")?;
    let output = root.join("output");
    if fs::create_dir(&output).is_err() {
        remove_workspace_tree(&root);
        return Err("无法创建媒体产物目录".into());
    }
    let input_path = root.join("input.mp4");
    let revoked = Arc::new(AtomicBool::new(false));
    let workspace = Workspace {
        identity: identity.clone(),
        root,
        inputs: BTreeMap::from([(
            inputs[0].resource_id.clone(),
            input_path.to_string_lossy().into_owned(),
        )]),
        output,
        ready: false,
        revoked: Arc::clone(&revoked),
        created: Instant::now(),
        artifacts: HashMap::new(),
    };
    let mut stale = Vec::new();
    let insertion = (|| {
        let mut map = workspaces().lock().map_err(|_| "媒体工作区锁异常")?;
        let expired: Vec<_> = map
            .iter()
            .filter(|(_, item)| item.created.elapsed() >= WORKSPACE_TTL)
            .map(|(key, _)| key.clone())
            .collect();
        for expired_key in expired {
            if let Some(item) = map.remove(&expired_key) {
                stale.push(item);
            }
        }
        if map.contains_key(&key(&identity)) || map.len() >= MAX_WORKSPACES {
            return Err("媒体工作区重复或并发达到上限".into());
        }
        map.insert(key(&identity), workspace.clone());
        Ok::<(), String>(())
    })();
    for item in stale {
        discard(item);
    }
    if let Err(error) = insertion {
        discard(workspace);
        return Err(error);
    }
    let result = (|| {
        copy_input(&source, &input_path, &revoked)?;
        check_authority(app, &identity)?;
        let mut map = workspaces().lock().map_err(|_| "媒体工作区锁异常")?;
        let current = map
            .get_mut(&key(&identity))
            .filter(|item| Arc::ptr_eq(&item.revoked, &revoked))
            .ok_or("媒体工作区已取消")?;
        if revoked.load(Ordering::Acquire) {
            return Err("媒体工作区已取消".into());
        }
        current.ready = true;
        Ok(())
    })();
    if result.is_err() {
        revoke_invocation(&identity);
        discard(workspace);
    }
    result
}

fn verify_mp4(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 24 || bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("媒体产物为空或超过 16 MiB".into());
    }
    let mut offset = 0usize;
    let mut ftyp = false;
    let mut moov = false;
    let mut mdat = false;
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err("MP4 产物文件结构不完整".into());
        }
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let kind = &bytes[offset + 4..offset + 8];
        let (length, header) = if length == 1 {
            if bytes.len() - offset < 16 {
                return Err("MP4 产物文件结构不完整".into());
            }
            let length = u64::from_be_bytes(bytes[offset + 8..offset + 16].try_into().unwrap());
            (usize::try_from(length).map_err(|_| "MP4 产物大小无效")?, 16)
        } else if length == 0 {
            (bytes.len() - offset, 8)
        } else {
            (length, 8)
        };
        if length < header || length > bytes.len() - offset {
            return Err("MP4 产物文件结构不完整".into());
        }
        if kind == b"ftyp" {
            ftyp = offset == 0 && length >= 16;
        }
        if kind == b"moov" {
            moov = true;
        }
        if kind == b"mdat" {
            mdat = length > header;
        }
        offset += length;
    }
    if ftyp && moov && mdat {
        Ok(())
    } else {
        Err("媒体产物不是完整 MP4 文件".into())
    }
}

fn read_verified_output(workspace: &Workspace, name: &str) -> Result<Vec<u8>, String> {
    let path = ordinary_output(&workspace.root, &workspace.output, name)?;
    let mut file = File::open(path).map_err(|_| "媒体产物不可访问")?;
    let metadata = file.metadata().map_err(|_| "媒体产物不可访问")?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_ARTIFACT_BYTES as u64 {
        return Err("媒体产物不是有界普通文件".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_ARTIFACT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "媒体产物读取失败")?;
    verify_mp4(&bytes)?;
    Ok(bytes)
}

pub(crate) fn collect_result<R: Runtime>(
    app: &AppHandle<R>,
    identity: &PluginHostIdentity,
    result: &mut Value,
) -> Result<(), String> {
    check_authority(app, identity)?;
    let workspace = snapshot(identity)?;
    let raw = result
        .get("artifacts")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let declarations: Vec<ArtifactDeclaration> =
        serde_json::from_value(raw).map_err(|_| "媒体产物清单无效")?;
    if declarations.len() > MAX_ARTIFACTS || result.get("effect").is_some() {
        return Err("媒体工作区只接受最终结果及最多 18 个 MP4 产物".into());
    }
    let mut keys = HashSet::new();
    let mut names = HashSet::new();
    let mut total = 0usize;
    let mut artifacts = Vec::new();
    for declaration in declarations {
        if !valid_id(&declaration.key)
            || !keys.insert(declaration.key.clone())
            || !names.insert(declaration.file_name.clone())
            || declaration.media_type != "video/mp4"
        {
            return Err("媒体产物身份重复或类型无效".into());
        }
        let bytes = read_verified_output(&workspace, &declaration.file_name)?;
        total += bytes.len();
        if total > MAX_TOTAL_BYTES {
            return Err("媒体产物总大小超过 48 MiB".into());
        }
        artifacts.push(MediaArtifact {
            key: declaration.key,
            artifact_id: opaque_id("artifact", identity),
            display_name: declaration.file_name,
            media_type: "video/mp4".into(),
            size: bytes.len(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        });
    }
    check_authority(app, identity)?;
    let mut map = workspaces().lock().map_err(|_| "媒体工作区锁异常")?;
    let current = map
        .get_mut(&key(identity))
        .filter(|item| {
            same_identity(&item.identity, identity)
                && Arc::ptr_eq(&item.revoked, &workspace.revoked)
                && !item.revoked.load(Ordering::Acquire)
        })
        .ok_or("媒体工作区已撤销")?;
    current.artifacts = artifacts
        .iter()
        .map(|artifact| (artifact.artifact_id.clone(), artifact.clone()))
        .collect();
    result.as_object_mut().ok_or("插件输出必须为对象")?.insert(
        "artifacts".into(),
        serde_json::to_value(artifacts).map_err(|_| "媒体产物序列化失败")?,
    );
    Ok(())
}

#[tauri::command]
pub async fn prepare_plugin_media_workspace(
    app: AppHandle,
    webview: Webview,
    identity: PluginHostIdentity,
    inputs: Vec<MediaInput>,
) -> Result<(), String> {
    path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("媒体工作区只能由主窗口管理".into());
    }
    tauri::async_runtime::spawn_blocking(move || prepare(&app, identity, inputs))
        .await
        .map_err(|_| "媒体暂存任务失败")?
}

#[tauri::command]
pub async fn read_plugin_media_artifact(
    app: AppHandle,
    webview: Webview,
    identity: PluginHostIdentity,
    artifact_id: String,
) -> Result<Vec<u8>, String> {
    path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("媒体产物只能由主窗口读取".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        check_authority(&app, &identity)?;
        let workspace = snapshot(&identity)?;
        let artifact = workspace
            .artifacts
            .get(&artifact_id)
            .ok_or("媒体产物不属于当前调用")?;
        let bytes = read_verified_output(&workspace, &artifact.display_name)?;
        if bytes.len() != artifact.size
            || format!("{:x}", Sha256::digest(&bytes)) != artifact.sha256
        {
            return Err("媒体产物在验证后变化".into());
        }
        check_authority(&app, &identity)?;
        let current = snapshot(&identity)?;
        if !Arc::ptr_eq(&current.revoked, &workspace.revoked) {
            return Err("媒体工作区已变化".into());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| "媒体读取任务失败")?
}

#[tauri::command]
pub async fn release_plugin_media_workspace(
    webview: Webview,
    identity: PluginHostIdentity,
) -> Result<(), String> {
    path_policy::ensure_trusted_caller(&webview)?;
    if webview.label() != "main" {
        return Err("媒体工作区只能由主窗口管理".into());
    }
    // 过期 revision 也可释放其自己的工作区；不能释放新 revision 或其它工具。
    revoke_invocation(&identity);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4() -> Vec<u8> {
        let mut bytes = Vec::new();
        for (kind, payload) in [
            (b"ftyp", b"isom0000".as_slice()),
            (b"moov", b"abcd".as_slice()),
            (b"mdat", b"frame".as_slice()),
        ] {
            bytes.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(payload);
        }
        bytes
    }

    #[test]
    fn plugin_media_artifact_rejects_truncated_and_fake_mp4() {
        let bytes = mp4();
        assert!(verify_mp4(&bytes).is_ok());
        assert!(verify_mp4(&bytes[..bytes.len() - 1]).is_err());
        assert!(verify_mp4(b"secret-file-not-an-mp4").is_err());
        let mut broken = bytes.clone();
        broken[..4].copy_from_slice(&1u32.to_be_bytes());
        assert!(verify_mp4(&broken).is_err());
    }

    #[test]
    fn plugin_media_artifact_rejects_traversal_and_wrong_identity() {
        let identity = PluginHostIdentity {
            plugin_id: "test.plugin".into(),
            source_digest: "a".repeat(64),
            revision_digest: "b".repeat(64),
            tool_id: "replicate".into(),
            invocation_id: "test-id".into(),
        };
        let root = std::env::temp_dir().join(opaque_id("plugin-artifact-test", &identity));
        fs::create_dir(&root).unwrap();
        let output = root.join("output");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("valid.mp4"), mp4()).unwrap();
        assert!(ordinary_output(&root, &output, "valid.mp4").is_ok());
        assert!(ordinary_output(&root, &output, "../valid.mp4").is_err());
        assert!(ordinary_output(&root, &output, "C:private.mp4").is_err());
        assert!(ordinary_output(&root, &output, "valid.exe").is_err());
        let mut other = identity.clone();
        other.revision_digest = "c".repeat(64);
        assert!(!same_identity(&identity, &other));
        remove_workspace_tree(&root);
        assert!(!root.exists());
    }

    #[test]
    fn plugin_media_copy_cancellation_never_returns_success() {
        let identity = PluginHostIdentity {
            plugin_id: "test.plugin".into(),
            source_digest: "a".repeat(64),
            revision_digest: "b".repeat(64),
            tool_id: "replicate".into(),
            invocation_id: "copy-cancel".into(),
        };
        let root = std::env::temp_dir().join(opaque_id("plugin-copy-test", &identity));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.mp4");
        let target = root.join("target.mp4");
        fs::write(&source, mp4()).unwrap();
        assert!(copy_input(&source, &target, &AtomicBool::new(true)).is_err());
        remove_workspace_tree(&root);
    }
}
