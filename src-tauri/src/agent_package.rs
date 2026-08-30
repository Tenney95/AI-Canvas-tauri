//! 用户安装的智能体包与外部智能体目录。
//!
//! 本模块只提供宿主级文件边界：用户通过系统对话框选择一次目录或归档后，
//! Renderer 只持有不透明 `sourceId`。真实目录映射保存在 Rust 私有注册表中；
//! 后续读取只接受安全相对路径。这里不会执行包内脚本，也不会把智能体内容注册成插件。

use crate::path_policy::{authorize_path, ensure_trusted_caller, PathAccess};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tar::Archive;
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

const REGISTRY_SCHEMA_VERSION: u32 = 1;
const PRIVATE_DIR_NAME: &str = "agent-private";
const REGISTRY_FILE_NAME: &str = "sources.json";
const REGISTRY_TEMP_FILE_NAME: &str = "sources.json.tmp";
const REGISTRY_BACKUP_FILE_NAME: &str = "sources.json.bak";
const PRIVATE_FILE_NAMES: [&str; 3] = [
    REGISTRY_FILE_NAME,
    REGISTRY_TEMP_FILE_NAME,
    REGISTRY_BACKUP_FILE_NAME,
];
const MANAGED_ROOT_NAME: &str = "agent-packages";
const MANIFEST_FILE_NAME: &str = "ai-canvas-agent.json";

const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_SOURCE_ENTRIES: usize = 200_000;
const MAX_SCAN_DEPTH: usize = 64;
const FREE_SPACE_RESERVE: u64 = 256 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_INSTRUCTION_BYTES: u64 = 256 * 1024;
const MAX_INSTRUCTION_CHARS: usize = 24_000;
const MAX_READ_TEXT_BYTES: u64 = 1024 * 1024;
const MAX_ENTRYPOINTS: usize = 128;

const DEFAULT_IGNORED_DIRECTORIES: [&str; 6] = [
    ".git",
    "node_modules",
    "dist",
    "target",
    "__pycache__",
    ".pytest_cache",
];

const READABLE_TEXT_EXTENSIONS: [&str; 19] = [
    "md", "txt", "json", "csv", "tsv", "yaml", "yml", "toml", "xml", "html", "htm", "css", "js",
    "mjs", "ts", "tsx", "jsx", "py", "rs",
];

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static SOURCE_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSourceType {
    Folder,
    Archive,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourcePreview {
    source_id: String,
    source_type: AgentSourceType,
    name: String,
    version: String,
    manifest: Option<Value>,
    entrypoints: Vec<String>,
    instruction_text: String,
    skill_count: usize,
    file_count: usize,
    total_bytes: u64,
    warnings: Vec<String>,
    health: String,
    content_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceReadTextResult {
    relative_path: String,
    content: String,
    sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceRemoveResult {
    source_id: String,
    source_type: AgentSourceType,
    removed: bool,
    external_source_preserved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSource {
    source_id: String,
    source_type: AgentSourceType,
    root_path: String,
    managed_container_path: Option<String>,
    preview: AgentSourcePreview,
    updated_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRegistry {
    schema_version: u32,
    sources: BTreeMap<String, StoredSource>,
}

impl Default for SourceRegistry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            sources: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
struct ScannedFile {
    absolute_path: PathBuf,
    relative_path: String,
    size: u64,
}

#[derive(Debug)]
struct SourceScan {
    files: Vec<ScannedFile>,
    total_bytes: u64,
    content_hash: String,
    ignored_directory_count: usize,
}

#[derive(Debug)]
struct ArchivePreflight {
    expanded_bytes: u64,
}

fn unix_now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn agent_private_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(PRIVATE_DIR_NAME))
        .map_err(|_| "无法定位智能体私有数据目录".to_string())
}

fn registry_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(agent_private_dir(app)?.join(REGISTRY_FILE_NAME))
}

/// 智能体压缩包解压后的托管目录。
///
/// 默认跟随用户在设置里指定的保存根目录，避免把展开后体积可达 20 GB 的包写进系统盘；
/// 用户未设置该目录或它当前不可用时，回退到应用自有数据目录。
/// 注意这里只决定「托管副本」的位置：`agent-private` 注册表始终留在应用私有目录，
/// 不随保存根目录迁移，否则 sourceId 到真实外部路径的映射会暴露成可读写路径。
fn managed_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(directory) = crate::path_policy::user_storage_root(app) {
        return Ok(directory.join(MANAGED_ROOT_NAME));
    }
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(MANAGED_ROOT_NAME))
        .map_err(|_| "无法定位智能体托管目录".to_string())
}

fn simplify_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().into_owned();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(
                rest.strip_prefix(r"UNC\")
                    .map_or_else(|| rest.to_string(), |unc| format!(r"\\{unc}")),
            );
        }
    }
    path
}

fn normalized_for_compare(path: &Path) -> PathBuf {
    path.canonicalize()
        .map(simplify_verbatim)
        .unwrap_or_else(|_| path.components().collect())
}

fn is_within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

pub(crate) fn is_under_agent_private_dir(private_dir: &Path, resolved: &Path) -> bool {
    let private = normalized_for_compare(private_dir);
    let target = normalized_for_compare(resolved);
    is_within(&target, &private)
}

/// 自定义文件命令不得绕过 Agent sourceId 读取真实外部目录映射。
pub fn is_agent_private_path<R: Runtime>(app: &AppHandle<R>, resolved: &Path) -> bool {
    agent_private_dir(app)
        .map(|directory| is_under_agent_private_dir(&directory, resolved))
        .unwrap_or(false)
}

/// Blender 项目根不能覆盖 Agent 私有注册表，也不能位于其内部。
pub(crate) fn is_agent_private_path_overlap<R: Runtime>(
    app: &AppHandle<R>,
    resolved: &Path,
) -> bool {
    agent_private_dir(app)
        .map(|directory| {
            let private = normalized_for_compare(&directory);
            let target = normalized_for_compare(resolved);
            is_within(&target, &private) || is_within(&private, &target)
        })
        .unwrap_or(false)
}

/// 把真实路径注册表从 Renderer 的 fs 与 asset scope 中移除。
///
/// 该动作在应用 setup 中 best-effort 执行；失败只会记录诊断，不阻断普通功能启动。
pub fn deny_agent_private_dir_access<R: Runtime>(app: &AppHandle<R>) {
    let Ok(directory) = agent_private_dir(app) else {
        return;
    };
    if let Err(error) = app.fs_scope().forbid_directory(&directory, true) {
        eprintln!("[agent-package] 无法从 fs scope 拒绝智能体私有目录: {error}");
    }
    let scopes = app.state::<tauri::scope::Scopes>();
    for name in PRIVATE_FILE_NAMES {
        if let Err(error) = scopes.forbid_file(directory.join(name)) {
            eprintln!("[agent-package] 无法从 asset scope 拒绝智能体私有文件: {error}");
        }
    }
}

fn read_registry<R: Runtime>(app: &AppHandle<R>) -> Result<SourceRegistry, String> {
    let file = registry_file(app)?;
    match fs::read(&file) {
        Ok(bytes) => {
            let registry = serde_json::from_slice::<SourceRegistry>(&bytes)
                .map_err(|_| "智能体来源注册表损坏".to_string())?;
            if registry.schema_version != REGISTRY_SCHEMA_VERSION {
                return Err("智能体来源注册表版本不受支持".to_string());
            }
            Ok(registry)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SourceRegistry::default()),
        Err(_) => Err("无法读取智能体来源注册表".to_string()),
    }
}

fn write_registry<R: Runtime>(app: &AppHandle<R>, registry: &SourceRegistry) -> Result<(), String> {
    let file = registry_file(app)?;
    let directory = file
        .parent()
        .ok_or_else(|| "智能体来源注册表路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|_| "无法创建智能体私有数据目录".to_string())?;
    let body =
        serde_json::to_vec(registry).map_err(|_| "无法序列化智能体来源注册表".to_string())?;
    let temporary = directory.join(REGISTRY_TEMP_FILE_NAME);
    let backup = directory.join(REGISTRY_BACKUP_FILE_NAME);
    fs::write(&temporary, body).map_err(|_| "无法写入智能体来源注册表".to_string())?;

    if !file.exists() {
        return fs::rename(&temporary, &file).map_err(|_| "无法提交智能体来源注册表".to_string());
    }

    let _ = fs::remove_file(&backup);
    fs::rename(&file, &backup).map_err(|_| "无法准备智能体来源注册表更新".to_string())?;
    if let Err(_error) = fs::rename(&temporary, &file) {
        let _ = fs::rename(&backup, &file);
        let _ = fs::remove_file(&temporary);
        return Err("无法提交智能体来源注册表".to_string());
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn load_source<R: Runtime>(app: &AppHandle<R>, source_id: &str) -> Result<StoredSource, String> {
    validate_source_id(source_id)?;
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "智能体来源注册表锁异常".to_string())?;
    read_registry(app)?
        .sources
        .get(source_id)
        .cloned()
        .ok_or_else(|| "智能体来源不存在或已卸载".to_string())
}

fn validate_source_id(source_id: &str) -> Result<(), String> {
    if source_id.len() < 8
        || source_id.len() > 80
        || !source_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("智能体来源标识无效".to_string());
    }
    Ok(())
}

fn generate_source_id(seed: &str) -> String {
    let sequence = SOURCE_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update(unix_now_millis().to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(sequence.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("src_{}", &digest[..32])
}

fn normalize_relative_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    if text.contains('\\') || text.contains('\0') {
        return Err("智能体包包含不安全路径".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("智能体包包含越界路径".to_string());
            }
        }
    }
    Ok(normalized)
}

fn normalize_requested_relative_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('~')
        || trimmed.contains(':')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err("智能体资源路径无效".to_string());
    }
    let normalized = normalize_relative_path(Path::new(trimmed))?;
    if normalized.as_os_str().is_empty() {
        return Err("智能体资源路径为空".to_string());
    }
    Ok(normalized)
}

fn relative_path_text(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| "智能体包路径必须使用 UTF-8".to_string())?
                    .to_string(),
            ),
            Component::CurDir => {}
            _ => return Err("智能体包包含不安全路径".to_string()),
        }
    }
    Ok(parts.join("/"))
}

fn should_ignore_directory(name: &str) -> bool {
    DEFAULT_IGNORED_DIRECTORIES
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(name))
}

fn scan_source(root: &Path) -> Result<SourceScan, String> {
    let canonical_root = root
        .canonicalize()
        .map(simplify_verbatim)
        .map_err(|_| "智能体来源目录不存在或无法访问".to_string())?;
    if !canonical_root.is_dir() {
        return Err("智能体来源不是文件夹".to_string());
    }

    let mut pending = vec![(canonical_root.clone(), 0_usize)];
    let mut files = Vec::new();
    let mut entry_count = 0_usize;
    let mut total_bytes = 0_u64;
    let mut ignored_directory_count = 0_usize;

    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            return Err("智能体目录层级超过限制".to_string());
        }
        let mut entries = fs::read_dir(&directory)
            .map_err(|_| "无法读取智能体目录".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取智能体目录项".to_string())?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            entry_count += 1;
            if entry_count > MAX_SOURCE_ENTRIES {
                return Err("智能体目录文件数量超过限制".to_string());
            }
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "无法读取智能体目录项属性".to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("智能体目录包含不允许的符号链接".to_string());
            }

            if metadata.is_dir() {
                let name = entry.file_name();
                let name = name
                    .to_str()
                    .ok_or_else(|| "智能体包路径必须使用 UTF-8".to_string())?;
                if should_ignore_directory(name) {
                    ignored_directory_count += 1;
                    continue;
                }
                let canonical = path
                    .canonicalize()
                    .map(simplify_verbatim)
                    .map_err(|_| "无法解析智能体子目录".to_string())?;
                if !is_within(&canonical, &canonical_root) {
                    return Err("智能体子目录越过来源边界".to_string());
                }
                pending.push((canonical, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                return Err("智能体目录包含不支持的文件类型".to_string());
            }
            if metadata.len() > MAX_SINGLE_FILE_BYTES {
                return Err("智能体目录包含超出大小限制的单个文件".to_string());
            }
            total_bytes = total_bytes.saturating_add(metadata.len());
            if total_bytes > MAX_EXPANDED_BYTES {
                return Err("智能体目录总体积超过限制".to_string());
            }
            let canonical = path
                .canonicalize()
                .map(simplify_verbatim)
                .map_err(|_| "无法解析智能体文件".to_string())?;
            if !is_within(&canonical, &canonical_root) {
                return Err("智能体文件越过来源边界".to_string());
            }
            let relative = canonical
                .strip_prefix(&canonical_root)
                .map_err(|_| "智能体文件越过来源边界".to_string())?;
            let relative_path = relative_path_text(relative)?;
            files.push(ScannedFile {
                absolute_path: canonical,
                relative_path,
                size: metadata.len(),
            });
        }
    }

    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    for file in &files {
        hasher.update(file.relative_path.as_bytes());
        hasher.update([0]);
        hasher.update(file.size.to_le_bytes());
        let mut input =
            File::open(&file.absolute_path).map_err(|_| "无法读取智能体文件".to_string())?;
        let mut read_bytes = 0_u64;
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|_| "无法读取智能体文件".to_string())?;
            if read == 0 {
                break;
            }
            read_bytes = read_bytes.saturating_add(read as u64);
            if read_bytes > file.size {
                return Err("智能体来源在扫描期间发生变化，请重试".to_string());
            }
            hasher.update(&buffer[..read]);
        }
        if read_bytes != file.size {
            return Err("智能体来源在扫描期间发生变化，请重试".to_string());
        }
    }

    Ok(SourceScan {
        files,
        total_bytes,
        content_hash: format!("{:x}", hasher.finalize()),
        ignored_directory_count,
    })
}

fn read_utf8_file(path: &Path, max_bytes: u64, label: &str) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|_| format!("无法读取智能体{label}"))?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(format!("智能体{label}超过大小限制"));
    }
    let bytes = fs::read(path).map_err(|_| format!("无法读取智能体{label}"))?;
    String::from_utf8(bytes).map_err(|_| format!("智能体{label}必须是 UTF-8 文本"))
}

fn scan_file<'a>(scan: &'a SourceScan, relative_path: &str) -> Option<&'a ScannedFile> {
    scan.files
        .iter()
        .find(|file| file.relative_path.eq_ignore_ascii_case(relative_path))
}

fn safe_display_text(value: &str, fallback: &str, max_chars: usize) -> String {
    let cleaned = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn manifest_string(
    manifest: &Value,
    key: &str,
    max_chars: usize,
) -> Result<Option<String>, String> {
    let Some(value) = manifest.get(key) else {
        return Ok(None);
    };
    let text = value
        .as_str()
        .ok_or_else(|| format!("智能体清单字段 {key} 必须是字符串"))?;
    if text.chars().count() > max_chars {
        return Err(format!("智能体清单字段 {key} 超过长度限制"));
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!("智能体清单字段 {key} 不能为空"));
    }
    Ok(Some(trimmed.to_string()))
}

fn collect_manifest_entrypoints(manifest: &Value) -> Result<Vec<String>, String> {
    fn collect(value: &Value, output: &mut Vec<String>) -> Result<(), String> {
        match value {
            Value::String(path) => output.push(relative_path_text(
                &normalize_requested_relative_path(path)?,
            )?),
            Value::Array(values) => {
                for value in values {
                    collect(value, output)?;
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    if value.is_string() || value.is_array() {
                        collect(value, output)?;
                    }
                }
            }
            Value::Null => {}
            _ => return Err("智能体清单 entrypoints 格式无效".to_string()),
        }
        Ok(())
    }

    let mut output = Vec::new();
    if let Some(entrypoints) = manifest.get("entrypoints") {
        collect(entrypoints, &mut output)?;
    }
    if let Some(instructions) = manifest.get("instructions") {
        collect(instructions, &mut output)?;
    }
    output.sort();
    output.dedup();
    if output.len() > MAX_ENTRYPOINTS {
        return Err("智能体清单入口数量超过限制".to_string());
    }
    Ok(output)
}

fn manifest_instruction_path(manifest: &Value) -> Option<String> {
    manifest
        .get("entrypoints")
        .and_then(Value::as_object)
        .and_then(|entrypoints| entrypoints.get("instructions"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            manifest
                .get("instructions")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn redact_root_from_string(value: &str, root: &Path) -> String {
    let root_text = root.to_string_lossy();
    let forward = root_text.replace('\\', "/");
    value
        .replace(root_text.as_ref(), "[agent-root]")
        .replace(&forward, "[agent-root]")
}

fn sanitize_manifest_for_preview(value: &Value, root: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(redact_root_from_string(text, root)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| sanitize_manifest_for_preview(value, root))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), sanitize_manifest_for_preview(value, root)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn fallback_name_from_root(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .map(|name| safe_display_text(name, "用户智能体", 120))
        .unwrap_or_else(|| "用户智能体".to_string())
}

/// 来源注册表只保存恢复与健康检查所需的脱敏元数据。
/// 指令正文仅作为当前预检结果返回 Renderer，不能持久化到磁盘。
fn preview_for_registry(preview: &AgentSourcePreview) -> AgentSourcePreview {
    let mut stored = preview.clone();
    stored.instruction_text.clear();
    stored
}

fn inspect_source(
    root: &Path,
    source_id: &str,
    source_type: AgentSourceType,
    fallback_name: &str,
) -> Result<AgentSourcePreview, String> {
    let scan = scan_source(root)?;
    let manifest_file = scan_file(&scan, MANIFEST_FILE_NAME);
    let manifest = match manifest_file {
        Some(file) => {
            let text = read_utf8_file(&file.absolute_path, MAX_MANIFEST_BYTES, "清单")?;
            let value = serde_json::from_str::<Value>(&text)
                .map_err(|_| "智能体清单不是有效 JSON".to_string())?;
            if !value.is_object() {
                return Err("智能体清单根节点必须是对象".to_string());
            }
            if let Some(schema_version) = value.get("schemaVersion") {
                let supported =
                    schema_version.as_u64() == Some(1) || schema_version.as_str() == Some("1");
                if !supported {
                    return Err("智能体清单版本不受支持".to_string());
                }
            }
            Some(value)
        }
        None => None,
    };

    let skill_paths = scan
        .files
        .iter()
        .filter(|file| {
            file.relative_path
                .rsplit('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        })
        .map(|file| file.relative_path.clone())
        .collect::<Vec<_>>();

    let root_agents = scan_file(&scan, "AGENTS.md").map(|file| file.relative_path.clone());
    let root_skill = scan_file(&scan, "SKILL.md").map(|file| file.relative_path.clone());
    let fallback_instruction = root_agents
        .clone()
        .or(root_skill)
        .or_else(|| skill_paths.first().cloned());

    let mut declared_entrypoints = match manifest.as_ref() {
        Some(value) => collect_manifest_entrypoints(value)?,
        None => Vec::new(),
    };
    for entrypoint in &declared_entrypoints {
        if scan_file(&scan, entrypoint).is_none() {
            return Err(format!("智能体清单入口不存在: {entrypoint}"));
        }
    }

    let instruction_path = manifest
        .as_ref()
        .and_then(manifest_instruction_path)
        .map(|path| {
            normalize_requested_relative_path(&path).and_then(|path| relative_path_text(&path))
        })
        .transpose()?
        .or(fallback_instruction)
        .ok_or_else(|| "智能体目录缺少 AGENTS.md、SKILL.md 或清单指令入口".to_string())?;
    let instruction_file =
        scan_file(&scan, &instruction_path).ok_or_else(|| "智能体指令入口不存在".to_string())?;
    let raw_instruction_text = read_utf8_file(
        &instruction_file.absolute_path,
        MAX_INSTRUCTION_BYTES,
        "指令入口",
    )?;
    let instruction_truncated = raw_instruction_text.chars().count() > MAX_INSTRUCTION_CHARS;
    let instruction_text = raw_instruction_text
        .chars()
        .take(MAX_INSTRUCTION_CHARS)
        .collect::<String>();

    declared_entrypoints.push(instruction_path.clone());
    declared_entrypoints.extend(skill_paths.iter().cloned());
    let mut entrypoints = declared_entrypoints.into_iter().collect::<BTreeSet<_>>();
    if entrypoints.len() > MAX_ENTRYPOINTS {
        let mut limited = entrypoints
            .into_iter()
            .filter(|entrypoint| entrypoint != &instruction_path)
            .take(MAX_ENTRYPOINTS.saturating_sub(1))
            .collect::<BTreeSet<_>>();
        limited.insert(instruction_path);
        entrypoints = limited;
    }

    let name = match manifest.as_ref() {
        Some(value) => manifest_string(value, "name", 120)?
            .map(|value| safe_display_text(&value, fallback_name, 120))
            .unwrap_or_else(|| safe_display_text(fallback_name, "用户智能体", 120)),
        None => safe_display_text(fallback_name, "用户智能体", 120),
    };
    let version_from_file = scan_file(&scan, "VERSION")
        .map(|file| read_utf8_file(&file.absolute_path, 1024, "版本文件"))
        .transpose()?
        .and_then(|text| text.lines().next().map(str::trim).map(str::to_string))
        .filter(|text| !text.is_empty());
    let version = match manifest.as_ref() {
        Some(value) => manifest_string(value, "version", 64)?
            .or(version_from_file)
            .unwrap_or_else(|| "未声明".to_string()),
        None => version_from_file.unwrap_or_else(|| "legacy".to_string()),
    };

    let mut warnings = Vec::new();
    // ai-canvas-agent.json 是可选增强清单。执行到这里时已经确认存在可读的
    // AGENTS.md、SKILL.md 或清单指令入口，因此无清单本身不构成健康风险。
    let health = "ready";
    if scan.ignored_directory_count > 0 {
        warnings.push(format!(
            "已跳过 {} 个构建、缓存或依赖目录",
            scan.ignored_directory_count
        ));
    }
    if instruction_truncated {
        warnings.push(format!(
            "指令入口超过 {} 字符，预览已截断；完整内容仍可按需读取",
            MAX_INSTRUCTION_CHARS
        ));
    }
    if skill_paths.len() > MAX_ENTRYPOINTS {
        warnings.push(format!(
            "发现 {} 个 Skill，预览入口仅展示前 {} 个",
            skill_paths.len(),
            MAX_ENTRYPOINTS
        ));
    }

    Ok(AgentSourcePreview {
        source_id: source_id.to_string(),
        source_type,
        name,
        version: safe_display_text(&version, "未声明", 64),
        manifest: manifest
            .as_ref()
            .map(|value| sanitize_manifest_for_preview(value, root)),
        entrypoints: entrypoints.into_iter().collect(),
        instruction_text: redact_root_from_string(&instruction_text, root),
        skill_count: skill_paths.len(),
        file_count: scan.files.len(),
        total_bytes: scan.total_bytes,
        warnings,
        health: health.to_string(),
        content_hash: scan.content_hash,
    })
}

fn has_root_marker(directory: &Path) -> bool {
    directory.join(MANIFEST_FILE_NAME).is_file()
        || directory.join("AGENTS.md").is_file()
        || directory.join("SKILL.md").is_file()
}

fn discover_package_root(staging: &Path) -> Result<PathBuf, String> {
    if has_root_marker(staging) {
        return Ok(staging.to_path_buf());
    }
    let entries = fs::read_dir(staging)
        .map_err(|_| "无法读取智能体包根目录".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取智能体包根目录项".to_string())?;
    if entries.len() == 1 {
        let entry = &entries[0];
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| "无法读取智能体包根目录项".to_string())?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            return Ok(entry.path());
        }
    }
    Ok(staging.to_path_buf())
}

fn is_supported_archive(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    name.ends_with(".aicanvas-agent") || name.ends_with(".tgz") || name.ends_with(".tar.gz")
}

fn archive_fallback_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("用户智能体");
    let lower = raw.to_ascii_lowercase();
    let trimmed = if lower.ends_with(".aicanvas-agent") {
        &raw[..raw.len() - ".aicanvas-agent".len()]
    } else if lower.ends_with(".tar.gz") {
        &raw[..raw.len() - ".tar.gz".len()]
    } else if lower.ends_with(".tgz") {
        &raw[..raw.len() - ".tgz".len()]
    } else {
        raw
    };
    safe_display_text(trimmed, "用户智能体", 120)
}

fn open_tar_archive(path: &Path) -> Result<Archive<GzDecoder<File>>, String> {
    let file = File::open(path).map_err(|_| "无法打开智能体压缩包".to_string())?;
    Ok(Archive::new(GzDecoder::new(file)))
}

fn preflight_archive(path: &Path) -> Result<ArchivePreflight, String> {
    let archive_bytes = fs::metadata(path)
        .map_err(|_| "无法读取智能体压缩包属性".to_string())?
        .len();
    if archive_bytes == 0 || archive_bytes > MAX_ARCHIVE_BYTES {
        return Err("智能体压缩包大小超过限制".to_string());
    }
    let mut archive = open_tar_archive(path)?;
    let entries = archive
        .entries()
        .map_err(|_| "智能体压缩包格式无效".to_string())?;
    let mut paths = HashSet::new();
    let mut entry_count = 0_usize;
    let mut expanded_bytes = 0_u64;
    let mut has_candidate_entry = false;

    for item in entries {
        entry_count += 1;
        if entry_count > MAX_SOURCE_ENTRIES {
            return Err("智能体压缩包文件数量超过限制".to_string());
        }
        let entry = item.map_err(|_| "无法读取智能体压缩包条目".to_string())?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("智能体压缩包包含不允许的链接或设备文件".to_string());
        }
        let raw_path = entry
            .path()
            .map_err(|_| "无法读取智能体压缩包路径".to_string())?;
        let normalized = normalize_relative_path(&raw_path)?;
        if normalized.as_os_str().is_empty() {
            continue;
        }
        let path_text = relative_path_text(&normalized)?;
        if !paths.insert(path_text.clone()) {
            return Err("智能体压缩包包含重复路径".to_string());
        }
        let leaf = path_text.rsplit('/').next().unwrap_or_default();
        if leaf.eq_ignore_ascii_case(MANIFEST_FILE_NAME)
            || leaf.eq_ignore_ascii_case("AGENTS.md")
            || leaf.eq_ignore_ascii_case("SKILL.md")
        {
            has_candidate_entry = true;
        }
        if entry_type.is_file() {
            let size = entry.header().size().unwrap_or(0);
            if size > MAX_SINGLE_FILE_BYTES {
                return Err("智能体压缩包包含超出大小限制的单个文件".to_string());
            }
            expanded_bytes = expanded_bytes.saturating_add(size);
            if expanded_bytes > MAX_EXPANDED_BYTES {
                return Err("智能体压缩包展开后总体积超过限制".to_string());
            }
        }
    }
    if !has_candidate_entry {
        return Err("智能体压缩包缺少清单、AGENTS.md 或 SKILL.md".to_string());
    }
    Ok(ArchivePreflight { expanded_bytes })
}

fn extract_archive(path: &Path, staging: &Path) -> Result<(), String> {
    let mut archive = open_tar_archive(path)?;
    let entries = archive
        .entries()
        .map_err(|_| "智能体压缩包格式无效".to_string())?;
    let mut paths = HashSet::new();
    let mut entry_count = 0_usize;
    let mut expanded_bytes = 0_u64;

    for item in entries {
        entry_count += 1;
        if entry_count > MAX_SOURCE_ENTRIES {
            return Err("智能体压缩包文件数量超过限制".to_string());
        }
        let mut entry = item.map_err(|_| "无法读取智能体压缩包条目".to_string())?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("智能体压缩包包含不允许的链接或设备文件".to_string());
        }
        let raw_path = entry
            .path()
            .map_err(|_| "无法读取智能体压缩包路径".to_string())?;
        let normalized = normalize_relative_path(&raw_path)?;
        if normalized.as_os_str().is_empty() {
            continue;
        }
        let path_text = relative_path_text(&normalized)?;
        if !paths.insert(path_text) {
            return Err("智能体压缩包包含重复路径".to_string());
        }
        let destination = staging.join(&normalized);
        if entry_type.is_dir() {
            fs::create_dir_all(&destination).map_err(|_| "无法创建智能体包目录".to_string())?;
            continue;
        }

        let declared_size = entry.header().size().unwrap_or(0);
        if declared_size > MAX_SINGLE_FILE_BYTES {
            return Err("智能体压缩包包含超出大小限制的单个文件".to_string());
        }
        expanded_bytes = expanded_bytes.saturating_add(declared_size);
        if expanded_bytes > MAX_EXPANDED_BYTES {
            return Err("智能体压缩包展开后总体积超过限制".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建智能体包目录".to_string())?;
        }
        let mut output =
            File::create(&destination).map_err(|_| "无法创建智能体包文件".to_string())?;
        let copied = std::io::copy(&mut entry, &mut output)
            .map_err(|_| "无法解压智能体包文件".to_string())?;
        if copied != declared_size {
            return Err("智能体压缩包条目大小不一致".to_string());
        }
        output
            .flush()
            .map_err(|_| "无法写入智能体包文件".to_string())?;
    }
    Ok(())
}

fn upsert_source<R: Runtime>(app: &AppHandle<R>, source: StoredSource) -> Result<(), String> {
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "智能体来源注册表锁异常".to_string())?;
    let mut registry = read_registry(app)?;
    registry.sources.insert(source.source_id.clone(), source);
    write_registry(app, &registry)
}

fn existing_linked_source_id<R: Runtime>(
    app: &AppHandle<R>,
    root_path: &str,
) -> Result<Option<String>, String> {
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "智能体来源注册表锁异常".to_string())?;
    let registry = read_registry(app)?;
    Ok(registry
        .sources
        .values()
        .find(|source| {
            source.source_type == AgentSourceType::Folder && source.root_path == root_path
        })
        .map(|source| source.source_id.clone()))
}

fn link_source(app: &AppHandle, root: PathBuf) -> Result<AgentSourcePreview, String> {
    let root_path = root
        .to_str()
        .ok_or_else(|| "智能体来源路径必须使用 UTF-8".to_string())?
        .to_string();
    let source_id = existing_linked_source_id(app, &root_path)?
        .unwrap_or_else(|| generate_source_id(&root_path));
    let fallback_name = fallback_name_from_root(&root);
    let preview = inspect_source(&root, &source_id, AgentSourceType::Folder, &fallback_name)?;
    upsert_source(
        app,
        StoredSource {
            source_id,
            source_type: AgentSourceType::Folder,
            root_path,
            managed_container_path: None,
            preview: preview_for_registry(&preview),
            updated_at: unix_now_millis(),
        },
    )?;
    Ok(preview)
}

fn import_archive(app: &AppHandle, archive_path: PathBuf) -> Result<AgentSourcePreview, String> {
    let preflight = preflight_archive(&archive_path)?;
    let root = managed_root(app)?;
    fs::create_dir_all(&root).map_err(|_| "无法创建智能体托管目录".to_string())?;
    let available =
        fs2::available_space(&root).map_err(|_| "无法读取智能体托管目录可用空间".to_string())?;
    let required = preflight.expanded_bytes.saturating_add(FREE_SPACE_RESERVE);
    if available < required {
        return Err("磁盘可用空间不足，无法导入智能体压缩包".to_string());
    }

    let seed = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("agent-package");
    let source_id = generate_source_id(seed);
    let staging = root.join(format!(".install-{source_id}"));
    let target = root.join(&source_id);
    if staging.exists() || target.exists() {
        return Err("智能体托管目录发生标识冲突，请重试".to_string());
    }
    fs::create_dir_all(&staging).map_err(|_| "无法创建智能体安装临时目录".to_string())?;

    let result = (|| {
        extract_archive(&archive_path, &staging)?;
        let package_root = discover_package_root(&staging)?;
        let root_relative = package_root
            .strip_prefix(&staging)
            .map_err(|_| "智能体包根目录无效".to_string())?
            .to_path_buf();
        let fallback_name = archive_fallback_name(&archive_path);
        let preview = inspect_source(
            &package_root,
            &source_id,
            AgentSourceType::Archive,
            &fallback_name,
        )?;
        let stored_root = target.join(root_relative);
        let root_path = stored_root
            .to_str()
            .ok_or_else(|| "智能体托管路径必须使用 UTF-8".to_string())?
            .to_string();
        fs::rename(&staging, &target).map_err(|_| "无法提交智能体托管目录".to_string())?;
        let container_path = target
            .to_str()
            .ok_or_else(|| "智能体托管路径必须使用 UTF-8".to_string())?
            .to_string();
        if let Err(error) = upsert_source(
            app,
            StoredSource {
                source_id: source_id.clone(),
                source_type: AgentSourceType::Archive,
                root_path,
                managed_container_path: Some(container_path),
                preview: preview_for_registry(&preview),
                updated_at: unix_now_millis(),
            },
        ) {
            let _ = fs::remove_dir_all(&target);
            return Err(error);
        }
        Ok(preview)
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn probe_source(app: &AppHandle, source_id: &str) -> Result<AgentSourcePreview, String> {
    let stored = load_source(app, source_id)?;
    let root = PathBuf::from(&stored.root_path);
    if !root.exists() {
        let mut missing = stored.preview;
        missing.health = "missing".to_string();
        missing
            .warnings
            .push("智能体来源当前不可访问，普通助手功能不受影响".to_string());
        return Ok(missing);
    }

    match inspect_source(
        &root,
        &stored.source_id,
        stored.source_type,
        &stored.preview.name,
    ) {
        Ok(preview) => {
            upsert_source(
                app,
                StoredSource {
                    preview: preview_for_registry(&preview),
                    updated_at: unix_now_millis(),
                    ..stored
                },
            )?;
            Ok(preview)
        }
        Err(_) => {
            let mut invalid = stored.preview;
            invalid.health = "invalid".to_string();
            invalid
                .warnings
                .push("智能体来源校验失败，请重新选择或修复来源".to_string());
            Ok(invalid)
        }
    }
}

fn validate_managed_container<R: Runtime>(
    app: &AppHandle<R>,
    source: &StoredSource,
) -> Result<PathBuf, String> {
    let raw = source
        .managed_container_path
        .as_deref()
        .ok_or_else(|| "智能体托管记录不完整".to_string())?;
    let root = managed_root(app)?
        .canonicalize()
        .map(simplify_verbatim)
        .map_err(|_| "智能体托管目录不存在".to_string())?;
    let container = PathBuf::from(raw)
        .canonicalize()
        .map(simplify_verbatim)
        .map_err(|_| "智能体托管内容不存在".to_string())?;
    if container == root
        || !is_within(&container, &root)
        || container.file_name().and_then(|name| name.to_str()) != Some(&source.source_id)
    {
        return Err("智能体托管记录越过安全边界".to_string());
    }
    Ok(container)
}

fn remove_source(app: &AppHandle, source_id: &str) -> Result<AgentSourceRemoveResult, String> {
    validate_source_id(source_id)?;
    let _guard = REGISTRY_LOCK
        .lock()
        .map_err(|_| "智能体来源注册表锁异常".to_string())?;
    let mut registry = read_registry(app)?;
    let source = registry
        .sources
        .get(source_id)
        .cloned()
        .ok_or_else(|| "智能体来源不存在或已卸载".to_string())?;

    let mut tombstone = None;
    if source.source_type == AgentSourceType::Archive {
        let raw_container = source
            .managed_container_path
            .as_deref()
            .ok_or_else(|| "智能体托管记录不完整".to_string())?;
        if Path::new(raw_container).exists() {
            let container = validate_managed_container(app, &source)?;
            let managed = managed_root(app)?;
            let removed_path = managed.join(format!(".remove-{}-{}", source_id, unix_now_millis()));
            fs::rename(&container, &removed_path)
                .map_err(|_| "无法准备移除智能体托管内容".to_string())?;
            tombstone = Some((container, removed_path));
        }
    }

    registry.sources.remove(source_id);
    if let Err(error) = write_registry(app, &registry) {
        if let Some((container, removed_path)) = &tombstone {
            let _ = fs::rename(removed_path, container);
        }
        return Err(error);
    }
    if let Some((_container, removed_path)) = tombstone {
        let _ = fs::remove_dir_all(removed_path);
    }

    Ok(AgentSourceRemoveResult {
        source_id: source_id.to_string(),
        source_type: source.source_type,
        removed: true,
        external_source_preserved: source.source_type == AgentSourceType::Folder,
    })
}

fn ensure_no_links(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err("智能体资源路径无效".to_string());
        };
        current.push(value);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "智能体资源不存在".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("智能体资源路径包含不允许的符号链接".to_string());
        }
    }
    Ok(())
}

fn is_readable_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            READABLE_TEXT_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
}

fn read_source_text(
    app: &AppHandle,
    source_id: &str,
    relative_path: &str,
    requested_max_bytes: Option<u64>,
) -> Result<AgentSourceReadTextResult, String> {
    let source = load_source(app, source_id)?;
    let relative = normalize_requested_relative_path(relative_path)?;
    if !is_readable_text_file(&relative) {
        return Err("智能体资源不是受支持的 UTF-8 文本文件".to_string());
    }
    let root = PathBuf::from(source.root_path)
        .canonicalize()
        .map(simplify_verbatim)
        .map_err(|_| "智能体来源当前不可访问".to_string())?;
    ensure_no_links(&root, &relative)?;
    let candidate = root.join(&relative);
    let resolved = candidate
        .canonicalize()
        .map(simplify_verbatim)
        .map_err(|_| "智能体资源不存在".to_string())?;
    if !is_within(&resolved, &root) || !resolved.is_file() {
        return Err("智能体资源越过来源边界".to_string());
    }

    let max_bytes = requested_max_bytes
        .unwrap_or(MAX_READ_TEXT_BYTES)
        .clamp(1, MAX_READ_TEXT_BYTES);
    let metadata = fs::metadata(&resolved).map_err(|_| "无法读取智能体资源属性".to_string())?;
    if metadata.len() > max_bytes {
        return Err("智能体文本资源超过本次读取上限".to_string());
    }
    let bytes = fs::read(&resolved).map_err(|_| "无法读取智能体文本资源".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("智能体文本资源超过本次读取上限".to_string());
    }
    let content =
        String::from_utf8(bytes.clone()).map_err(|_| "智能体文本资源必须是 UTF-8".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);

    Ok(AgentSourceReadTextResult {
        relative_path: relative_path_text(&relative)?,
        content,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

#[tauri::command]
pub async fn agent_source_link(
    webview: Webview,
    app: AppHandle,
    source_path: String,
) -> Result<AgentSourcePreview, String> {
    ensure_trusted_caller(&webview)?;
    let root = authorize_path(&app, &source_path, PathAccess::Read)
        .map_err(|_| "所选智能体文件夹未获授权或不可访问".to_string())?;
    if !root.is_dir() {
        return Err("请选择智能体文件夹".to_string());
    }
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || link_source(&worker_app, root))
        .await
        .map_err(|_| "智能体文件夹扫描任务异常结束".to_string())?
}

#[tauri::command]
pub async fn agent_package_import_archive(
    webview: Webview,
    app: AppHandle,
    archive_path: String,
) -> Result<AgentSourcePreview, String> {
    ensure_trusted_caller(&webview)?;
    let archive = authorize_path(&app, &archive_path, PathAccess::Read)
        .map_err(|_| "所选智能体压缩包未获授权或不可访问".to_string())?;
    if !archive.is_file() || !is_supported_archive(&archive) {
        return Err("智能体压缩包仅支持 .aicanvas-agent、.tgz 或 .tar.gz".to_string());
    }
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || import_archive(&worker_app, archive))
        .await
        .map_err(|_| "智能体压缩包导入任务异常结束".to_string())?
}

#[tauri::command]
pub async fn agent_source_probe(
    webview: Webview,
    app: AppHandle,
    source_id: String,
) -> Result<AgentSourcePreview, String> {
    ensure_trusted_caller(&webview)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || probe_source(&worker_app, &source_id))
        .await
        .map_err(|_| "智能体来源检查任务异常结束".to_string())?
}

#[tauri::command]
pub async fn agent_source_remove(
    webview: Webview,
    app: AppHandle,
    source_id: String,
) -> Result<AgentSourceRemoveResult, String> {
    ensure_trusted_caller(&webview)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || remove_source(&worker_app, &source_id))
        .await
        .map_err(|_| "智能体来源移除任务异常结束".to_string())?
}

#[tauri::command]
pub async fn agent_source_read_text(
    webview: Webview,
    app: AppHandle,
    source_id: String,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<AgentSourceReadTextResult, String> {
    ensure_trusted_caller(&webview)?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_source_text(&worker_app, &source_id, &relative_path, max_bytes)
    })
    .await
    .map_err(|_| "智能体文本读取任务异常结束".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Cursor;
    use tar::{Builder, EntryType, Header};

    fn temporary_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ai-canvas-agent-package-{name}-{}-{}",
            std::process::id(),
            SOURCE_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("应创建测试目录");
        path
    }

    fn write_test_archive(path: &Path, entries: &[(&str, &[u8], EntryType)]) {
        let file = File::create(path).expect("应创建归档");
        let encoder = GzEncoder::new(file, Compression::default());
        let mut builder = Builder::new(encoder);
        for (name, content, entry_type) in entries {
            let mut header = Header::new_gnu();
            header.set_entry_type(*entry_type);
            header.set_mode(0o644);
            header.set_size(content.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, *name, Cursor::new(*content))
                .expect("应写入归档项");
        }
        let encoder = builder.into_inner().expect("应完成 tar");
        encoder.finish().expect("应完成 gzip");
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(normalize_relative_path(Path::new("../secret.txt")).is_err());
        assert!(normalize_relative_path(Path::new("/absolute.txt")).is_err());
        assert!(normalize_relative_path(Path::new("folder\\file.txt")).is_err());
        assert!(normalize_requested_relative_path("C:/secret.txt").is_err());
        assert!(normalize_requested_relative_path("~/.ssh/id_rsa").is_err());
        assert_eq!(
            relative_path_text(&normalize_relative_path(Path::new("./docs/a.md")).unwrap())
                .unwrap(),
            "docs/a.md"
        );
    }

    #[test]
    fn private_directory_check_does_not_match_siblings() {
        let root = PathBuf::from("/data/app/agent-private");
        assert!(is_under_agent_private_dir(
            &root,
            Path::new("/data/app/agent-private/sources.json")
        ));
        assert!(!is_under_agent_private_dir(
            &root,
            Path::new("/data/app/agent-private-copy/sources.json")
        ));
    }

    #[test]
    fn scans_manifestless_agent_without_executing_scripts() {
        let root = temporary_directory("manifestless");
        fs::write(root.join("AGENTS.md"), "# Agent\n只读说明").unwrap();
        fs::write(root.join("VERSION"), "1.2.3\n").unwrap();
        fs::create_dir_all(root.join("skills/demo")).unwrap();
        fs::write(root.join("skills/demo/SKILL.md"), "# Demo").unwrap();
        fs::write(root.join("run.py"), "raise RuntimeError('must not run')").unwrap();

        let preview = inspect_source(&root, "src_test123", AgentSourceType::Folder, "测试智能体")
            .expect("无清单目录应可预检");
        assert_eq!(preview.health, "ready");
        assert!(!preview
            .warnings
            .iter()
            .any(|warning| warning.contains(MANIFEST_FILE_NAME)));
        assert_eq!(preview.version, "1.2.3");
        assert_eq!(preview.skill_count, 1);
        assert!(preview.entrypoints.contains(&"AGENTS.md".to_string()));
        assert!(root.join("run.py").is_file(), "扫描不得执行或删除脚本");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn manifestless_readiness_does_not_relax_invalid_source_checks() {
        let invalid_manifest = temporary_directory("invalid-manifest");
        fs::write(
            invalid_manifest.join(MANIFEST_FILE_NAME),
            "{ definitely not json",
        )
        .unwrap();
        fs::write(invalid_manifest.join("AGENTS.md"), "# Agent").unwrap();
        assert!(inspect_source(
            &invalid_manifest,
            "src_invalid_manifest",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .is_err_and(|error| error.contains("智能体清单不是有效 JSON")));

        let missing_entrypoint = temporary_directory("missing-entrypoint");
        fs::write(
            missing_entrypoint.join(MANIFEST_FILE_NAME),
            r#"{"schemaVersion":1,"entrypoints":{"instructions":"missing.md"}}"#,
        )
        .unwrap();
        assert!(inspect_source(
            &missing_entrypoint,
            "src_missing_entrypoint",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .is_err_and(|error| error.contains("智能体清单入口不存在")));

        let missing_instruction = temporary_directory("missing-instruction");
        assert!(inspect_source(
            &missing_instruction,
            "src_missing_instruction",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .is_err_and(|error| error.contains("智能体目录缺少 AGENTS.md、SKILL.md 或清单指令入口")));

        fs::remove_dir_all(invalid_manifest).ok();
        fs::remove_dir_all(missing_entrypoint).ok();
        fs::remove_dir_all(missing_instruction).ok();
    }

    #[test]
    fn registry_preview_never_persists_instruction_body() {
        let root = temporary_directory("registry-preview");
        fs::write(root.join("AGENTS.md"), "# Private instruction body").unwrap();

        let preview = inspect_source(
            &root,
            "src_registry123",
            AgentSourceType::Folder,
            "测试智能体",
        )
        .expect("目录应可预检");
        let stored = preview_for_registry(&preview);

        assert!(!preview.instruction_text.is_empty());
        assert!(stored.instruction_text.is_empty());
        assert_eq!(stored.content_hash, preview.content_hash);
        assert_eq!(stored.entrypoints, preview.entrypoints);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reads_manifest_v1_and_flattens_entrypoints() {
        let root = temporary_directory("manifest");
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            r#"{"schemaVersion":1,"name":"示例智能体","version":"2.0.0","entrypoints":{"instructions":"AGENTS.md","router":"router.md"}}"#,
        )
        .unwrap();
        fs::write(root.join("AGENTS.md"), "# Instructions").unwrap();
        fs::write(root.join("router.md"), "# Router").unwrap();

        let preview = inspect_source(&root, "src_test456", AgentSourceType::Folder, "fallback")
            .expect("Manifest v1 应可预检");
        assert_eq!(preview.health, "ready");
        assert_eq!(preview.name, "示例智能体");
        assert_eq!(preview.version, "2.0.0");
        assert_eq!(
            preview.entrypoints,
            vec!["AGENTS.md".to_string(), "router.md".to_string()]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn preview_never_exposes_the_selected_root_path() {
        let root = temporary_directory("redaction");
        let root_text = root.to_string_lossy().to_string();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "name": "脱敏测试",
                "version": "1",
                "entrypoints": { "instructions": "AGENTS.md" },
                "localHint": root_text,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("AGENTS.md"),
            format!("本地根目录仅用于测试：{}", root.to_string_lossy()),
        )
        .unwrap();

        let preview = inspect_source(&root, "src_redacted", AgentSourceType::Folder, "fallback")
            .expect("预览应成功");
        assert!(!preview.instruction_text.contains(&root_text));
        assert_eq!(
            preview
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.get("localHint"))
                .and_then(Value::as_str),
            Some("[agent-root]")
        );
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(serialized.contains("[agent-root]"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_preflight_and_extract_accept_safe_tar_gz() {
        let root = temporary_directory("safe-archive");
        let archive = root.join("demo.aicanvas-agent");
        write_test_archive(
            &archive,
            &[
                ("demo/AGENTS.md", b"# Agent", EntryType::Regular),
                ("demo/skills/a/SKILL.md", b"# Skill", EntryType::Regular),
            ],
        );
        let preflight = preflight_archive(&archive).expect("安全归档应通过预检");
        assert_eq!(preflight.expanded_bytes, 14);
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        extract_archive(&archive, &staging).expect("安全归档应解压");
        assert!(staging.join("demo/AGENTS.md").is_file());
        assert_eq!(
            discover_package_root(&staging).unwrap(),
            staging.join("demo")
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_rejects_links() {
        let root = temporary_directory("link-archive");
        let archive = root.join("link.tgz");
        write_test_archive(
            &archive,
            &[
                ("AGENTS.md", b"# Agent", EntryType::Regular),
                ("escape", b"target", EntryType::Symlink),
            ],
        );
        assert!(preflight_archive(&archive).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn archive_rejects_duplicate_paths() {
        let root = temporary_directory("duplicate-archive");
        let archive = root.join("duplicate.tar.gz");
        write_test_archive(
            &archive,
            &[
                ("AGENTS.md", b"first", EntryType::Regular),
                ("AGENTS.md", b"second", EntryType::Regular),
            ],
        );
        assert!(preflight_archive(&archive).is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn content_hash_changes_with_file_content() {
        let root = temporary_directory("hash");
        fs::write(root.join("AGENTS.md"), "one").unwrap();
        let first = scan_source(&root).unwrap().content_hash;
        fs::write(root.join("AGENTS.md"), "two").unwrap();
        let second = scan_source(&root).unwrap().content_hash;
        assert_ne!(first, second);
        fs::remove_dir_all(root).ok();
    }
}
