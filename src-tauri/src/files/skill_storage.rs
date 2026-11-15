//! Skill 托管文本与外部目录的原生持久授权；不扩大 fs / asset 允许范围。

use crate::path_policy::{
    authorize_existing_plain_directory, authorize_existing_plain_file_with_roots,
    authorize_path_with_roots, authorize_skill_storage_root, canonicalize_simplified, ensure_plain_skill_directory_chain,
    ensure_trusted_caller, is_link_or_reparse, reauthorize_existing_plain_directory_with_roots,
    PathAccess,
};
use crate::skill_archive::{safe_archive_path, MAX_ENTRIES, MAX_EXPANDED_BYTES, MAX_FILE_BYTES};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime, Webview};
use tauri_plugin_fs::FsExt;

const REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const SOURCE_ERROR: &str = "Skill 来源不存在、不可访问或未获授权，请重新选择目录";
const SAVE_ERROR: &str = "Skill 保存失败，请检查安装目录 skills 的写入权限和存储空间";
const PRIVATE_STORAGE_ERROR: &str = "Skill 来源授权存储不可访问，请检查应用私有数据目录的读写权限和存储空间";
const REMOVE_ERROR: &str = "Skill 托管文件删除失败，请关闭占用文件的程序，并检查安装目录 skills 的删除权限；未删除的内容已保留，可重试";
const REMOVE_CHANGED: &str = "Skill 托管目录或文件在删除期间发生变化，已停止清理，请核对后重试";
// 上传上限不含本次托管根目录；删除计划额外保留这一项。
const MAX_REMOVAL_ENTRIES: usize = MAX_ENTRIES + 1;
static STORAGE_LOCK: Mutex<()> = Mutex::new(());
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillTextFile {
    relative_path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSkillSource {
    source_id: String,
    storage_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum SkillSource {
    ManagedFile { name: String, entry: String },
    ManagedDirectory { name: String },
    LinkedDirectory { root: PathBuf },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    sources: BTreeMap<String, SkillSource>,
}

impl Default for Registry {
    fn default() -> Self { Self { version: 1, sources: BTreeMap::new() } }
}

/// 只用于 Tauri 给出的系统数据根；系统 HOME / AppData 别名不属于用户 Skill 子树。
/// 尚不存在时只解析最近的既有祖先，不创建或授予任何目录权限。
fn canonical_system_data_root(raw: &Path) -> Result<PathBuf, String> {
    if !raw.is_absolute() { return Err(PRIVATE_STORAGE_ERROR.into()); }
    let mut ancestor = raw.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(&ancestor) {
            Ok(_) => {
                let mut root = canonicalize_simplified(&ancestor).map_err(|_| PRIVATE_STORAGE_ERROR)?;
                if !fs::metadata(&root).map_err(|_| PRIVATE_STORAGE_ERROR)?.is_dir() {
                    return Err(PRIVATE_STORAGE_ERROR.into());
                }
                for component in missing.iter().rev() { root.push(component); }
                return Ok(root);
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(ancestor.file_name().ok_or(PRIVATE_STORAGE_ERROR)?.to_os_string());
                if !ancestor.pop() { return Err(PRIVATE_STORAGE_ERROR.into()); }
            },
            Err(_) => return Err(PRIVATE_STORAGE_ERROR.into()),
        }
    }
}

fn private_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let private = crate::agent_package::agent_private_dir(app)?;
    let system = canonical_system_data_root(private.parent().ok_or(PRIVATE_STORAGE_ERROR)?)?;
    Ok(system.join(private.file_name().ok_or(PRIVATE_STORAGE_ERROR)?).join("skill-storage"))
}

fn isolate_private_storage<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = private_directory(app)?;
    app.fs_scope().forbid_directory(&directory, true)
        .map_err(|_| "无法隔离 Skill 来源授权存储")?;
    app.asset_protocol_scope().forbid_directory(&directory, true)
        .map_err(|_| "无法隔离 Skill 来源授权资源")?;
    if let Ok(canonical) = canonicalize_simplified(&directory) {
        app.fs_scope().forbid_directory(&canonical, true)
            .map_err(|_| "无法隔离 Skill 来源授权存储")?;
        app.asset_protocol_scope().forbid_directory(&canonical, true)
            .map_err(|_| "无法隔离 Skill 来源授权资源")?;
    }
    Ok(())
}

/// 在 fs 插件之后、首个 Renderer 之前施加拒绝；每次读写也重新确认隔离。
pub(crate) fn privacy_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("skill-storage-privacy")
        .setup(|app, _| {
            isolate_private_storage(app).map_err(|_| std::io::Error::new(
                std::io::ErrorKind::PermissionDenied, "无法隔离 Skill 来源授权存储",
            ))?;
            Ok(())
        })
        .build()
}

fn create_plain_directory_tree(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => ensure_plain_skill_directory_chain(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_plain_directory_tree(path.parent().ok_or(PRIVATE_STORAGE_ERROR)?)?;
            match fs::create_dir(path) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
                Err(_) => return Err(PRIVATE_STORAGE_ERROR.into()),
            }
            ensure_plain_skill_directory_chain(path)
        },
        Err(_) => Err(PRIVATE_STORAGE_ERROR.into()),
    }
}

fn plain_file(path: &Path) -> Result<(), String> {
    ensure_plain_skill_directory_chain(path.parent().ok_or(SOURCE_ERROR)?)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| SOURCE_ERROR)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata)
        || canonicalize_simplified(path).map_err(|_| SOURCE_ERROR)? != path
    {
        return Err(SOURCE_ERROR.into());
    }
    Ok(())
}

fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    plain_file(path)?;
    let file = File::open(path).map_err(|_| SOURCE_ERROR)?;
    if file.metadata().map_err(|_| SOURCE_ERROR)?.len() > limit {
        return Err("Skill 文件超过读取大小限制".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| SOURCE_ERROR)?;
    plain_file(path)?;
    if bytes.len() as u64 > limit { return Err("Skill 文件超过读取大小限制".into()); }
    Ok(bytes)
}

fn read_text(path: &Path) -> Result<String, String> {
    let text = String::from_utf8(read_bytes(path, MAX_FILE_BYTES)?)
        .map_err(|_| "Skill 文件必须是 UTF-8 文本")?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// 文件锁同时约束多实例；锁文件与注册表都不受 Renderer 的配置或 scope 恢复控制。
fn registry_lock<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, File), String> {
    isolate_private_storage(app)?;
    let directory = private_directory(app)?;
    create_plain_directory_tree(&directory)?;
    let directory = canonicalize_simplified(&directory).map_err(|_| PRIVATE_STORAGE_ERROR)?;
    isolate_private_storage(app)?;
    let path = directory.join("sources.lock");
    let file = match OpenOptions::new().read(true).write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            plain_file(&path)?;
            OpenOptions::new().read(true).write(true).open(&path).map_err(|_| "无法读取 Skill 来源锁")?
        },
        Err(_) => return Err("无法创建 Skill 来源锁".into()),
    };
    plain_file(&path)?;
    file.try_lock_exclusive().map_err(|_| "另一个窗口或应用正在处理 Skill，请稍后重试")?;
    Ok((directory, file))
}

fn read_registry(directory: &Path) -> Result<Registry, String> {
    let path = directory.join("sources.json");
    let path = match fs::symlink_metadata(&path) {
        Ok(_) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let backup = directory.join("sources.json.bak");
            match fs::symlink_metadata(&backup) {
                Ok(_) => backup,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
                Err(_) => return Err("Skill 来源注册表不可访问".into()),
            }
        },
        Err(_) => return Err("Skill 来源注册表不可访问".into()),
    };
    let registry: Registry = serde_json::from_slice(&read_bytes(&path, REGISTRY_BYTES)?)
        .map_err(|_| "Skill 来源注册表损坏，未恢复文件授权")?;
    if registry.version != 1 || registry.sources.len() > MAX_ENTRIES
        || registry.sources.keys().any(|id| !valid_source_id(id))
    {
        return Err("Skill 来源注册表无效，未恢复文件授权".into());
    }
    Ok(registry)
}

fn write_registry(directory: &Path, registry: &Registry) -> Result<(), String> {
    let bytes = serde_json::to_vec(registry).map_err(|_| "无法保存 Skill 来源注册表")?;
    if bytes.len() as u64 > REGISTRY_BYTES { return Err("Skill 来源注册表已达到容量上限".into()); }
    ensure_plain_skill_directory_chain(directory)?;
    let file = directory.join("sources.json");
    let temporary = directory.join(format!("{}.tmp", new_source_id()));
    let backup = directory.join("sources.json.bak");
    let result = (|| {
        let mut output = OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|_| "无法保存 Skill 来源注册表")?;
        output.write_all(&bytes).and_then(|_| output.sync_all()).map_err(|_| "无法保存 Skill 来源注册表")?;
        drop(output);
        match fs::symlink_metadata(&file) {
            Ok(_) => {
                plain_file(&file)?;
                match fs::symlink_metadata(&backup) {
                    Ok(_) => { plain_file(&backup)?; fs::remove_file(&backup).map_err(|_| "无法更新 Skill 来源注册表")?; },
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                    Err(_) => return Err("无法更新 Skill 来源注册表".into()),
                }
                fs::rename(&file, &backup).map_err(|_| "无法更新 Skill 来源注册表")?;
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("无法更新 Skill 来源注册表".into()),
        }
        if fs::rename(&temporary, &file).is_err() {
            if !file.exists() && plain_file(&backup).is_ok() { let _ = fs::rename(&backup, &file); }
            return Err("无法提交 Skill 来源注册表".into());
        }
        if plain_file(&backup).is_ok() { let _ = fs::remove_file(&backup); }
        Ok(())
    })();
    if result.is_err() && plain_file(&temporary).is_ok() { let _ = fs::remove_file(&temporary); }
    result
}

fn new_source_id() -> String {
    let mut hash = Sha256::new();
    hash.update(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_le_bytes());
    hash.update(std::process::id().to_le_bytes());
    hash.update(ID_SEQUENCE.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    format!("skill_{}", &format!("{:x}", hash.finalize())[..32])
}

fn valid_source_id(id: &str) -> bool {
    id.strip_prefix("skill_").is_some_and(|value| value.len() == 32
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn text_path(raw: &str) -> Result<String, String> {
    let path = safe_archive_path(raw, false).map_err(|_| "Skill 资料路径无效")?;
    if path != raw || !matches!(path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str(), "md" | "txt" | "json") {
        return Err("Skill 资料只支持目录内的 .md / .txt / .json 相对路径".into());
    }
    Ok(path)
}

fn leaf_name(raw: &str) -> Result<String, String> {
    let name = safe_archive_path(raw, false).map_err(|_| "Skill 名称无效")?;
    if name != raw || name.contains('/') { return Err("Skill 名称无效".into()); }
    Ok(name)
}

fn validate_upload(name: &str, files: &[SkillTextFile], directory: bool) -> Result<(), String> {
    leaf_name(name)?;
    if name.len() > 200 { return Err("Skill 名称过长".into()); }
    if files.is_empty() || files.len() > MAX_ENTRIES || !directory && files.len() != 1 {
        return Err("Skill 文件数量无效或超过 4096 个".into());
    }
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for file in files {
        let path = text_path(&file.relative_path)?;
        if !directory && (path.contains('/') || path != name) { return Err("单文件 Skill 名称与内容不匹配".into()); }
        if !paths.insert(path.to_lowercase()) { return Err("Skill 包含重复资料路径".into()); }
        let size = file.content.len() as u64;
        total = total.checked_add(size).ok_or("Skill 文本超过大小限制")?;
        if size > MAX_FILE_BYTES || total > MAX_EXPANDED_BYTES { return Err("Skill 文本超过大小限制（单文件 8 MiB、总计 64 MiB）".into()); }
    }
    let mut entries = paths.clone();
    for file in files {
        let mut parent = Path::new(&file.relative_path).parent();
        while let Some(path) = parent {
            let key = path.to_string_lossy().replace('\\', "/").to_lowercase();
            if paths.contains(&key) {
                return Err("Skill 资料的文件与目录路径冲突".into());
            }
            if !key.is_empty() { entries.insert(key); }
            parent = path.parent();
        }
    }
    if entries.len() > MAX_ENTRIES { return Err("Skill 文件及目录条目超过 4096 个".into()); }
    Ok(())
}

fn unique_name(name: &str, index: usize, directory: bool) -> String {
    if index == 0 { return name.to_string(); }
    if !directory {
        if let Some((stem, extension)) = name.rsplit_once('.') { return format!("{stem} ({}).{extension}", index + 1); }
    }
    format!("{name} ({})", index + 1)
}

fn source_path<R: Runtime>(app: &AppHandle<R>, source: &SkillSource) -> Result<(PathBuf, bool), String> {
    let (path, directory, allowed) = match source {
        SkillSource::LinkedDirectory { root } => (root.clone(), true, root.clone()),
        SkillSource::ManagedDirectory { name } => {
            let root = authorize_skill_storage_root(app, false)?;
            (root.join(leaf_name(name)?), true, root)
        },
        SkillSource::ManagedFile { name, entry } => {
            text_path(entry)?;
            let root = authorize_skill_storage_root(app, false)?;
            (root.join(leaf_name(name)?), false, root)
        },
    };
    if !path.is_absolute() { return Err(SOURCE_ERROR.into()); }
    let resolved = if directory {
        ensure_plain_skill_directory_chain(&path)?;
        reauthorize_existing_plain_directory_with_roots(app, &path, &[allowed])?
    } else {
        ensure_plain_skill_directory_chain(path.parent().ok_or(SOURCE_ERROR)?)?;
        authorize_existing_plain_file_with_roots(app, &path.to_string_lossy(), &[allowed])?
    };
    if resolved != path { return Err(SOURCE_ERROR.into()); }
    Ok((resolved, directory))
}

fn load_source<R: Runtime>(app: &AppHandle<R>, registry: &Registry, id: &str) -> Result<(SkillSource, PathBuf, bool), String> {
    if !valid_source_id(id) { return Err(SOURCE_ERROR.into()); }
    let source = registry.sources.get(id).ok_or(SOURCE_ERROR)?.clone();
    let (path, directory) = source_path(app, &source)?;
    Ok((source, path, directory))
}

fn register_source(directory: &Path, registry: &mut Registry, source: SkillSource, path: &Path) -> Result<SavedSkillSource, String> {
    if let SkillSource::LinkedDirectory { root } = &source {
        if let Some((source_id, _)) = registry.sources.iter().find(|(_, existing)| {
            matches!(existing, SkillSource::LinkedDirectory { root: existing_root } if existing_root == root)
        }) {
            return Ok(SavedSkillSource { source_id: source_id.clone(), storage_path: path.to_string_lossy().into_owned() });
        }
    }
    if registry.sources.len() >= MAX_ENTRIES { return Err("Skill 来源数量达到上限".into()); }
    let source_id = new_source_id();
    registry.sources.insert(source_id.clone(), source);
    write_registry(directory, registry)?;
    Ok(SavedSkillSource { source_id, storage_path: path.to_string_lossy().into_owned() })
}

fn save_files<R: Runtime>(app: &AppHandle<R>, name: &str, files: &[SkillTextFile], directory: bool) -> Result<SavedSkillSource, String> {
    validate_upload(name, files, directory)?;
    let _guard = STORAGE_LOCK.lock().map_err(|_| SAVE_ERROR)?;
    let (registry_directory, _native_lock) = registry_lock(app)?;
    let mut registry = read_registry(&registry_directory)?;
    let root = authorize_skill_storage_root(app, true)?;
    let mut reserved = None;
    for index in 0..MAX_ENTRIES {
        authorize_skill_storage_root(app, false)?;
        let candidate = root.join(unique_name(name, index, directory));
        let result = if directory { fs::create_dir(&candidate).map(|_| None) }
            else { OpenOptions::new().write(true).create_new(true).open(&candidate).map(Some) };
        match result {
            Ok(file) => { reserved = Some((candidate, file)); break; },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SAVE_ERROR.into()),
        }
    }
    let (target, single_file) = reserved.ok_or("Skill 同名文件过多，请修改名称")?;
    let target_name = target.file_name().and_then(|name| name.to_str()).ok_or(SAVE_ERROR)?.to_string();
    let source = if directory { SkillSource::ManagedDirectory { name: target_name } }
        else { SkillSource::ManagedFile { name: target_name, entry: files[0].relative_path.clone() } };
    let mut written = Vec::new();
    let mut created_directories = if directory { vec![target.clone()] } else { Vec::new() };
    let result = (|| {
        if let Some(mut output) = single_file {
            written.push(target.clone());
            source_path(app, &source)?;
            output.write_all(files[0].content.as_bytes()).and_then(|_| output.sync_all()).map_err(|_| SAVE_ERROR)?;
            drop(output);
        } else {
            for file in files {
                source_path(app, &source)?;
                let path = target.join(&file.relative_path);
                let parent = path.parent().ok_or(SAVE_ERROR)?;
                let mut accumulated = target.clone();
                for component in parent.strip_prefix(&target).map_err(|_| SAVE_ERROR)?.components() {
                    accumulated.push(component);
                    match fs::create_dir(&accumulated) {
                        Ok(()) => created_directories.push(accumulated.clone()),
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
                        Err(_) => return Err(SAVE_ERROR.into()),
                    }
                    ensure_plain_skill_directory_chain(&accumulated)?;
                }
                let mut output = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| SAVE_ERROR)?;
                written.push(path.clone());
                authorize_existing_plain_file_with_roots(app, &path.to_string_lossy(), std::slice::from_ref(&target))?;
                output.write_all(file.content.as_bytes()).and_then(|_| output.sync_all()).map_err(|_| SAVE_ERROR)?;
            }
        }
        source_path(app, &source)?;
        register_source(&registry_directory, &mut registry, source.clone(), &target)
    })();
    if result.is_err() && authorize_skill_storage_root(app, false).is_ok() {
        // 只清理本次 create_new 的普通文件和空目录，不递归删除或跟随替换后的链接。
        for path in written.iter().rev() {
            if path.starts_with(&root) && plain_file(path).is_ok() { let _ = fs::remove_file(path); }
        }
        for path in created_directories.iter().rev() {
            if path.starts_with(&root) && ensure_plain_skill_directory_chain(path).is_ok() { let _ = fs::remove_dir(path); }
        }
    }
    result
}

#[tauri::command]
pub async fn save_skill_files<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, name: String, files: Vec<SkillTextFile>, directory: bool) -> Result<SavedSkillSource, String> {
    ensure_trusted_caller(&webview)?;
    validate_upload(&name, &files, directory)?;
    tauri::async_runtime::spawn_blocking(move || save_files(&app, &name, &files, directory))
        .await.map_err(|_| "Skill 保存任务失败")?
}

#[tauri::command]
pub async fn register_skill_folder<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, path: String) -> Result<SavedSkillSource, String> {
    ensure_trusted_caller(&webview)?;
    let root = authorize_existing_plain_directory(&app, &path)?;
    ensure_plain_skill_directory_chain(Path::new(&path))?;
    ensure_plain_skill_directory_chain(&root)?;
    if !app.fs_scope().is_allowed(&root) { return Err(SOURCE_ERROR.into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORAGE_LOCK.lock().map_err(|_| SOURCE_ERROR)?;
        let (directory, _native_lock) = registry_lock(&app)?;
        let mut registry = read_registry(&directory)?;
        let current = authorize_existing_plain_directory(&app, &path)?;
        if current != root || !app.fs_scope().is_allowed(&current) { return Err(SOURCE_ERROR.into()); }
        ensure_plain_skill_directory_chain(Path::new(&path))?;
        ensure_plain_skill_directory_chain(&current)?;
        register_source(&directory, &mut registry, SkillSource::LinkedDirectory { root: current.clone() }, &current)
    }).await.map_err(|_| "Skill 目录登记任务失败")?
}

fn list_files<R: Runtime>(app: &AppHandle<R>, root: &Path, limit: usize) -> Result<Vec<String>, String> {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut paths = Vec::new();
    let mut entries = 0_usize;
    let mut bytes = 0_u64;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 64 { return Err("Skill 目录层级超过限制".into()); }
        ensure_plain_skill_directory_chain(&directory)?;
        reauthorize_existing_plain_directory_with_roots(app, &directory, &[root.to_path_buf()])?;
        for item in fs::read_dir(&directory).map_err(|_| SOURCE_ERROR)? {
            entries += 1;
            if entries > MAX_ENTRIES { return Err("Skill 资料条目超过 4096 个".into()); }
            let item = item.map_err(|_| SOURCE_ERROR)?;
            let path = item.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| SOURCE_ERROR)?;
            if is_link_or_reparse(&metadata) { return Err("Skill 目录包含不允许的符号链接或目录联接".into()); }
            if metadata.is_dir() { queue.push_back((path, depth + 1)); continue; }
            if !metadata.is_file() { return Err("Skill 目录包含不支持的特殊文件".into()); }
            let relative = path.strip_prefix(root).map_err(|_| SOURCE_ERROR)?.to_str().ok_or("Skill 资料路径必须使用 UTF-8")?.replace('\\', "/");
            let extension = relative.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            if !matches!(extension.as_str(), "md" | "txt" | "json") { continue; }
            let relative = text_path(&relative)?;
            authorize_existing_plain_file_with_roots(app, &path.to_string_lossy(), &[root.to_path_buf()])?;
            bytes = bytes.checked_add(metadata.len()).ok_or("Skill 资料超过大小限制")?;
            if metadata.len() > MAX_FILE_BYTES || bytes > MAX_EXPANDED_BYTES { return Err("Skill 资料超过大小限制（单文件 8 MiB、总计 64 MiB）".into()); }
            paths.push(relative);
        }
    }
    paths.sort_by(|left, right| left.split('/').count().cmp(&right.split('/').count()).then_with(|| left.cmp(right)));
    paths.truncate(limit.min(MAX_ENTRIES));
    Ok(paths)
}

#[tauri::command]
pub async fn list_skill_source_files<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, source_id: String, limit: usize) -> Result<Vec<String>, String> {
    ensure_trusted_caller(&webview)?;
    if limit == 0 { return Ok(Vec::new()); }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORAGE_LOCK.lock().map_err(|_| SOURCE_ERROR)?;
        let (directory, _native_lock) = registry_lock(&app)?;
        let (source, path, is_directory) = load_source(&app, &read_registry(&directory)?, &source_id)?;
        if !is_directory {
            return match source { SkillSource::ManagedFile { entry, .. } => Ok(vec![text_path(&entry)?]), _ => Err(SOURCE_ERROR.into()) };
        }
        list_files(&app, &path, limit)
    }).await.map_err(|_| "Skill 资料列举任务失败")?
}

#[tauri::command]
pub async fn read_skill_source_file<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, source_id: String, relative_path: String) -> Result<String, String> {
    ensure_trusted_caller(&webview)?;
    let relative = text_path(&relative_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORAGE_LOCK.lock().map_err(|_| SOURCE_ERROR)?;
        let (directory, _native_lock) = registry_lock(&app)?;
        let (source, root, is_directory) = load_source(&app, &read_registry(&directory)?, &source_id)?;
        let path = if is_directory {
            let path = root.join(&relative);
            ensure_plain_skill_directory_chain(path.parent().ok_or(SOURCE_ERROR)?)?;
            authorize_existing_plain_file_with_roots(&app, &path.to_string_lossy(), std::slice::from_ref(&root))?
        } else {
            if !matches!(source, SkillSource::ManagedFile { entry, .. } if entry == relative) { return Err(SOURCE_ERROR.into()); }
            root
        };
        read_text(&path)
    }).await.map_err(|_| "Skill 资料读取任务失败")?
}

struct SkillRemovalEntry {
    path: PathBuf,
    directory: bool,
    identity: file_id::FileId,
}

struct SkillRemovalPlan {
    root: PathBuf,
    root_identity: file_id::FileId,
    entries: Vec<SkillRemovalEntry>,
}

/// 来源登记是唯一删除权威；名称必须仍然是 skills 根的一个直接子项。
fn managed_removal_target(root: &Path, source: &SkillSource) -> Result<Option<(PathBuf, bool)>, String> {
    let (name, directory) = match source {
        SkillSource::LinkedDirectory { .. } => return Ok(None),
        SkillSource::ManagedDirectory { name } => (name, true),
        SkillSource::ManagedFile { name, entry } => {
            text_path(entry)?;
            (name, false)
        },
    };
    let target = root.join(leaf_name(name)?);
    if !root.is_absolute() || target.parent() != Some(root) { return Err(REMOVE_ERROR.into()); }
    Ok(Some((target, directory)))
}

/// 整个 skills 目录已被外部移除时，也只核对固定安装位置，不重建目录。
fn removal_storage_root<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    let executable = std::env::current_exe().map_err(|_| REMOVE_ERROR)?;
    let install = canonicalize_simplified(executable.parent().ok_or(REMOVE_ERROR)?)
        .map_err(|_| REMOVE_ERROR)?;
    ensure_plain_skill_directory_chain(&install).map_err(|_| REMOVE_ERROR)?;
    let root = install.join("skills");
    let resolved = authorize_path_with_roots(app, root.to_str().ok_or(REMOVE_ERROR)?, PathAccess::Write,
        std::slice::from_ref(&install)).map_err(|_| REMOVE_ERROR)?;
    if resolved != root { return Err(REMOVE_ERROR.into()); }
    match fs::symlink_metadata(&root) {
        Ok(_) => {
            let authorized = authorize_skill_storage_root(app, false).map_err(|_| REMOVE_ERROR)?;
            if authorized != root { return Err(REMOVE_ERROR.into()); }
            Ok(Some(root))
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(REMOVE_ERROR.into()),
    }
}

fn removal_metadata(root: &Path, path: &Path, directory: bool) -> Result<fs::Metadata, String> {
    if path == root || !path.starts_with(root) { return Err(REMOVE_CHANGED.into()); }
    ensure_plain_skill_directory_chain(path.parent().ok_or(REMOVE_CHANGED)?).map_err(|_| REMOVE_CHANGED)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| REMOVE_ERROR)?;
    if is_link_or_reparse(&metadata) || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err("Skill 托管目录包含符号链接、目录联接或特殊文件，已停止清理，请核对后重试".into());
    }
    if canonicalize_simplified(path).map_err(|_| REMOVE_CHANGED)? != path { return Err(REMOVE_CHANGED.into()); }
    Ok(metadata)
}

/// 先遍历完整子树并复核每个条目；预检失败前不会删除任何文件。
fn plan_managed_removal(root: &Path, target: &Path, directory: bool,
    authorize: &impl Fn(&Path) -> Result<(), String>) -> Result<SkillRemovalPlan, String> {
    if !root.is_absolute() || target.parent() != Some(root) { return Err(REMOVE_ERROR.into()); }
    ensure_plain_skill_directory_chain(root).map_err(|_| REMOVE_ERROR)?;
    if canonicalize_simplified(root).map_err(|_| REMOVE_ERROR)? != root { return Err(REMOVE_ERROR.into()); }
    authorize(root)?;
    let root_identity = file_id::get_file_id(root).map_err(|_| REMOVE_ERROR)?;
    let mut plan = SkillRemovalPlan { root: root.to_path_buf(), root_identity, entries: Vec::new() };
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(plan),
        Err(_) => return Err(REMOVE_ERROR.into()),
        Ok(_) => {},
    }
    let mut queue = VecDeque::from([(target.to_path_buf(), directory, 0_usize)]);
    let mut bytes = 0_u64;
    while let Some((path, directory, depth)) = queue.pop_front() {
        if depth > 64 || plan.entries.len() >= MAX_REMOVAL_ENTRIES { return Err("Skill 托管目录超过安全删除的条目或层级上限".into()); }
        let metadata = removal_metadata(root, &path, directory)?;
        authorize(&path)?;
        let identity = file_id::get_file_id(&path).map_err(|_| REMOVE_ERROR)?;
        if directory {
            for child in fs::read_dir(&path).map_err(|_| REMOVE_ERROR)? {
                if plan.entries.len() + queue.len() + 1 >= MAX_REMOVAL_ENTRIES {
                    return Err("Skill 托管目录超过安全删除的条目上限".into());
                }
                let child = child.map_err(|_| REMOVE_ERROR)?;
                let child_type = child.file_type().map_err(|_| REMOVE_ERROR)?;
                queue.push_back((child.path(), child_type.is_dir(), depth + 1));
            }
        } else {
            bytes = bytes.checked_add(metadata.len()).ok_or(REMOVE_ERROR)?;
            if bytes > MAX_EXPANDED_BYTES { return Err("Skill 托管文件超过安全删除的大小上限".into()); }
        }
        plan.entries.push(SkillRemovalEntry { path, directory, identity });
    }
    Ok(plan)
}

fn execute_managed_removal(plan: &SkillRemovalPlan,
    authorize: &impl Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let directories: BTreeMap<_, _> = plan.entries.iter().filter(|entry| entry.directory)
        .map(|entry| (entry.path.as_path(), entry.identity)).collect();
    // 广度优先预检的逆序保证先删子项；不用 remove_dir_all 跟随后来替换的父目录。
    for entry in plan.entries.iter().rev() {
        ensure_plain_skill_directory_chain(&plan.root).map_err(|_| REMOVE_CHANGED)?;
        authorize(&plan.root)?;
        if file_id::get_file_id(&plan.root).ok() != Some(plan.root_identity) { return Err(REMOVE_CHANGED.into()); }
        for ancestor in entry.path.ancestors().skip(1).take_while(|path| *path != plan.root.as_path()) {
            if let Some(identity) = directories.get(ancestor) {
                ensure_plain_skill_directory_chain(ancestor).map_err(|_| REMOVE_CHANGED)?;
                if file_id::get_file_id(ancestor).ok().as_ref() != Some(identity) { return Err(REMOVE_CHANGED.into()); }
            }
        }
        removal_metadata(&plan.root, &entry.path, entry.directory)?;
        authorize(&entry.path)?;
        if file_id::get_file_id(&entry.path).ok() != Some(entry.identity) { return Err(REMOVE_CHANGED.into()); }
        let result = if entry.directory { fs::remove_dir(&entry.path) } else { fs::remove_file(&entry.path) };
        result.map_err(|_| REMOVE_ERROR)?;
    }
    Ok(())
}

/// 只清理安装目录内的托管副本；外部链接与格式合法的未知来源均幂等保留。
#[tauri::command]
pub async fn remove_skill_source_files<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, source_id: String) -> Result<bool, String> {
    ensure_trusted_caller(&webview)?;
    if !valid_source_id(&source_id) { return Err("Skill 来源标识无效".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORAGE_LOCK.lock().map_err(|_| REMOVE_ERROR)?;
        let (registry_directory, _native_lock) = registry_lock(&app)?;
        let mut registry = read_registry(&registry_directory)?;
        let Some(source) = registry.sources.get(&source_id).cloned() else { return Ok(false); };
        if matches!(source, SkillSource::LinkedDirectory { .. }) { return Ok(false); }
        if let Some(root) = removal_storage_root(&app)? {
            let (target, directory) = managed_removal_target(&root, &source)?.ok_or(REMOVE_ERROR)?;
            let authorize = |path: &Path| -> Result<(), String> {
                let resolved = authorize_path_with_roots(&app, path.to_str().ok_or(REMOVE_ERROR)?,
                    PathAccess::Write, std::slice::from_ref(&root)).map_err(|_| REMOVE_ERROR)?;
                if resolved != path { return Err(REMOVE_CHANGED.into()); }
                Ok(())
            };
            let plan = plan_managed_removal(&root, &target, directory, &authorize)?;
            execute_managed_removal(&plan, &authorize)?;
        }
        registry.sources.remove(&source_id);
        write_registry(&registry_directory, &registry)?;
        Ok(true)
    }).await.map_err(|_| "Skill 托管文件删除任务失败")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> SkillTextFile { SkillTextFile { relative_path: path.into(), content: "# 中文资料".into() } }

    fn removal_root() -> PathBuf {
        let id = new_source_id();
        // 保持 macOS 临时目录下 Unix socket 的完整路径小于系统长度限制。
        let root = std::env::temp_dir().join(format!("sr-{}", &id[6..22]));
        fs::create_dir(&root).unwrap();
        canonicalize_simplified(&root).unwrap()
    }

    #[test]
    fn managed_removal_uses_native_leaf_names_and_never_targets_linked_sources() {
        let root = removal_root();
        let external = SkillSource::LinkedDirectory { root: root.join("external") };
        assert!(managed_removal_target(&root, &external).unwrap().is_none());
        for name in ["../outside", "a/b", "a\\b", "C:/outside", "NUL.txt"] {
            assert!(managed_removal_target(&root, &SkillSource::ManagedDirectory { name: name.into() }).is_err());
        }
        let source = SkillSource::ManagedFile { name: "说明 (2).md".into(), entry: "说明.md".into() };
        let (target, directory) = managed_removal_target(&root, &source).unwrap().unwrap();
        assert_eq!(target, root.join("说明 (2).md"));
        assert!(!directory);
        fs::write(&target, b"owned").unwrap();
        let keep = root.join("keep.md");
        fs::write(&keep, b"keep").unwrap();
        let plan = plan_managed_removal(&root, &target, directory, &|_| Ok(())).unwrap();
        execute_managed_removal(&plan, &|_| Ok(())).unwrap();
        assert!(!target.exists());
        assert_eq!(fs::read(&keep).unwrap(), b"keep");
        assert!(plan_managed_removal(&root, &target, directory, &|_| Ok(())).unwrap().entries.is_empty());
        fs::remove_file(keep).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn managed_directory_is_fully_preflighted_before_any_mutation() {
        let root = removal_root();
        let target = root.join("owned");
        let nested = target.join("references");
        fs::create_dir(&target).unwrap();
        fs::create_dir(&nested).unwrap();
        let entry = target.join("SKILL.md");
        let resource = nested.join("notes.json");
        fs::write(&entry, b"entry").unwrap();
        fs::write(&resource, b"resource").unwrap();
        let authorize = |path: &Path| {
            if path == resource { Err("denied".into()) } else { Ok(()) }
        };
        assert!(plan_managed_removal(&root, &target, true, &authorize).is_err());
        assert!(entry.is_file());
        assert!(resource.is_file());
        let plan = plan_managed_removal(&root, &target, true, &|_| Ok(())).unwrap();
        execute_managed_removal(&plan, &|_| Ok(())).unwrap();
        assert!(!target.exists());
        assert!(root.is_dir());
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn directory_replacement_is_rejected_even_when_the_leaf_identity_is_shared() {
        let root = removal_root();
        let target = root.join("owned");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("SKILL.md"), b"keep").unwrap();
        let plan = plan_managed_removal(&root, &target, true, &|_| Ok(())).unwrap();
        let original = root.join("original");
        fs::rename(&target, &original).unwrap();
        fs::create_dir(&target).unwrap();
        fs::hard_link(original.join("SKILL.md"), target.join("SKILL.md")).unwrap();
        assert!(execute_managed_removal(&plan, &|_| Ok(())).is_err());
        assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), b"keep");
        assert_eq!(fs::read(original.join("SKILL.md")).unwrap(), b"keep");
        fs::remove_file(target.join("SKILL.md")).unwrap();
        fs::remove_file(original.join("SKILL.md")).unwrap();
        fs::remove_dir(target).unwrap();
        fs::remove_dir(original).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn unexpected_new_files_are_preserved_and_make_cleanup_fail() {
        let root = removal_root();
        let target = root.join("owned");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("SKILL.md"), b"entry").unwrap();
        let plan = plan_managed_removal(&root, &target, true, &|_| Ok(())).unwrap();
        let added = target.join("new.txt");
        fs::write(&added, b"new").unwrap();
        assert!(execute_managed_removal(&plan, &|_| Ok(())).is_err());
        assert_eq!(fs::read(&added).unwrap(), b"new");
        assert!(target.is_dir());
        // 按当前完整子树重试，而不是递归删除上一轮未预检的条目。
        let retry = plan_managed_removal(&root, &target, true, &|_| Ok(())).unwrap();
        execute_managed_removal(&retry, &|_| Ok(())).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn oversized_tree_fails_before_deleting_its_entry() {
        let root = removal_root();
        let target = root.join("owned");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("SKILL.md"), b"entry").unwrap();
        let oversized = target.join("large.txt");
        File::create(&oversized).unwrap().set_len(MAX_EXPANDED_BYTES + 1).unwrap();
        assert!(plan_managed_removal(&root, &target, true, &|_| Ok(())).is_err());
        assert!(target.join("SKILL.md").is_file());
        fs::remove_file(oversized).unwrap();
        fs::remove_file(target.join("SKILL.md")).unwrap();
        fs::remove_dir(target).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn maximum_upload_entry_count_remains_removable_with_its_owned_root() {
        let root = removal_root();
        let target = root.join("owned");
        fs::create_dir(&target).unwrap();
        for index in 0..MAX_ENTRIES { fs::write(target.join(format!("entry-{index}.txt")), b"").unwrap(); }
        let plan = plan_managed_removal(&root, &target, true, &|_| Ok(())).unwrap();
        assert_eq!(plan.entries.len(), MAX_ENTRIES + 1);
        let excess = target.join("excess.txt");
        fs::write(&excess, b"").unwrap();
        assert!(plan_managed_removal(&root, &target, true, &|_| Ok(())).is_err());
        assert_eq!(fs::read_dir(&target).unwrap().count(), MAX_ENTRIES + 1);
        fs::remove_file(excess).unwrap();
        execute_managed_removal(&plan, &|_| Ok(())).unwrap();
        assert!(!target.exists());
        fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_and_special_descendants_abort_preflight_without_touching_outside_files() {
        let root = removal_root();
        let target = root.join("owned");
        fs::create_dir(&target).unwrap();
        let outside = root.join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        fs::write(target.join("SKILL.md"), b"entry").unwrap();
        let link = target.join("linked.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(plan_managed_removal(&root, &target, true, &|_| Ok(())).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert!(target.join("SKILL.md").is_file());
        fs::remove_file(link).unwrap();
        let socket_path = target.join("special");
        let socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        assert!(plan_managed_removal(&root, &target, true, &|_| Ok(())).is_err());
        drop(socket);
        fs::remove_file(socket_path).unwrap();
        let plan = plan_managed_removal(&root, &target, true, &|_| Ok(())).unwrap();
        execute_managed_removal(&plan, &|_| Ok(())).unwrap();
        fs::remove_file(outside).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_readonly_files_fail_without_changing_their_permissions() {
        let root = removal_root();
        let target = root.join("SKILL.md");
        fs::write(&target, b"entry").unwrap();
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&target, permissions).unwrap();
        let plan = plan_managed_removal(&root, &target, false, &|_| Ok(())).unwrap();
        assert!(execute_managed_removal(&plan, &|_| Ok(())).is_err());
        assert!(fs::metadata(&target).unwrap().permissions().readonly());
        let mut permissions = fs::metadata(&target).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&target, permissions).unwrap();
        fs::remove_file(target).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn uploads_accept_only_bounded_relative_text_and_single_file_identity() {
        assert!(validate_upload("示例", &[file("SKILL.md"), file("references/说明.json")], true).is_ok());
        assert!(validate_upload("SKILL.md", &[file("SKILL.md")], false).is_ok());
        for path in ["../SKILL.md", "/SKILL.md", "C:/SKILL.md", "a\\SKILL.md", "./SKILL.md", "scripts/run.py", "NUL.txt"] {
            assert!(text_path(path).is_err(), "{path}");
        }
        assert!(validate_upload("SKILL.md", &[file("other.md")], false).is_err());
        assert!(validate_upload("目录", &[file("SKILL.md"), file("skill.md")], true).is_err());
        assert!(validate_upload("目录", &[file("note.md"), file("note.md/child.txt")], true).is_err());
        assert!(validate_upload("目录", &[], true).is_err());
        let oversized = SkillTextFile { relative_path: "SKILL.md".into(), content: "x".repeat(MAX_FILE_BYTES as usize + 1) };
        assert!(validate_upload("SKILL.md", &[oversized], false).is_err());
    }

    #[test]
    fn collision_names_preserve_extensions_and_opaque_sources_survive_registry_roundtrip() {
        assert_eq!(unique_name("说明.md", 1, false), "说明 (2).md");
        assert_eq!(unique_name("示例", 1, true), "示例 (2)");
        let first = new_source_id();
        let second = new_source_id();
        assert!(valid_source_id(&first));
        assert_ne!(first, second);
        assert!(!valid_source_id("../../SKILL.md"));
        let mut registry = Registry::default();
        registry.sources.insert(first.clone(), SkillSource::ManagedFile { name: "说明 (2).md".into(), entry: "说明.md".into() });
        let reopened: Registry = serde_json::from_slice(&serde_json::to_vec(&registry).unwrap()).unwrap();
        assert!(matches!(reopened.sources.get(&first), Some(SkillSource::ManagedFile { name, entry }) if name == "说明 (2).md" && entry == "说明.md"));
    }

    #[test]
    fn source_reads_are_strict_utf8_and_never_follow_file_links() {
        let directory = std::env::temp_dir().join(new_source_id());
        fs::create_dir(&directory).unwrap();
        let path = directory.join("SKILL.md");
        fs::write(&path, b"text").unwrap();
        let path = canonicalize_simplified(&path).unwrap();
        assert_eq!(read_bytes(&path, 4).unwrap(), b"text");
        assert!(read_bytes(&path, 3).is_err());
        fs::write(&path, "\u{feff}# 中文 Skill".as_bytes()).unwrap();
        assert_eq!(read_text(&path).unwrap(), "# 中文 Skill");
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(read_text(&path).is_err());
        #[cfg(unix)]
        {
            let link = directory.join("link.md");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(read_bytes(&link, 4).is_err());
            fs::remove_file(link).unwrap();
        }
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn registry_is_committed_on_disk_and_missing_primary_recovers_only_its_private_backup() {
        let directory = std::env::temp_dir().join(new_source_id());
        fs::create_dir(&directory).unwrap();
        let directory = canonicalize_simplified(&directory).unwrap();
        let mut registry = Registry::default();
        let first = new_source_id();
        registry.sources.insert(first.clone(), SkillSource::ManagedDirectory { name: "示例".into() });
        write_registry(&directory, &registry).unwrap();
        assert!(read_registry(&directory).unwrap().sources.contains_key(&first));
        let second = new_source_id();
        registry.sources.insert(second.clone(), SkillSource::LinkedDirectory { root: directory.clone() });
        write_registry(&directory, &registry).unwrap();
        assert_eq!(read_registry(&directory).unwrap().sources.len(), 2);
        let repeated = register_source(&directory, &mut registry,
            SkillSource::LinkedDirectory { root: directory.clone() }, &directory).unwrap();
        assert_eq!(repeated.source_id, second);
        assert_eq!(registry.sources.len(), 2);
        fs::rename(directory.join("sources.json"), directory.join("sources.json.bak")).unwrap();
        assert!(read_registry(&directory).unwrap().sources.contains_key(&second));
        fs::write(directory.join("sources.json"), b"corrupt").unwrap();
        assert!(read_registry(&directory).is_err());
        fs::remove_file(directory.join("sources.json")).unwrap();
        fs::remove_file(directory.join("sources.json.bak")).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn host_data_alias_is_normalized_but_private_subtree_links_remain_forbidden() {
        let temporary = canonicalize_simplified(&std::env::temp_dir()).unwrap().join(new_source_id());
        fs::create_dir(&temporary).unwrap();
        let actual = temporary.join("actual");
        let alias = temporary.join("host-alias");
        let outside = temporary.join("other");
        fs::create_dir(&actual).unwrap();
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        let system = canonical_system_data_root(&alias.join("new-app-data")).unwrap();
        assert_eq!(system, actual.join("new-app-data"));
        assert!(!system.exists());
        fs::create_dir(&system).unwrap();
        let private = system.join("agent-private");
        std::os::unix::fs::symlink(&outside, &private).unwrap();
        assert!(create_plain_directory_tree(&private.join("skill-storage")).is_err());
        assert!(ensure_plain_skill_directory_chain(&alias).is_err());
        assert!(!outside.join("skill-storage").exists());
        fs::remove_file(private).unwrap();
        fs::remove_file(alias).unwrap();
        fs::remove_dir(system).unwrap();
        fs::remove_dir(actual).unwrap();
        fs::remove_dir(outside).unwrap();
        fs::remove_dir(temporary).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn host_data_root_uses_the_same_simplified_windows_form_as_registry_files() {
        let directory = std::env::temp_dir().join(new_source_id());
        fs::create_dir(&directory).unwrap();
        let verbatim = directory.canonicalize().unwrap();
        let normalized = canonicalize_simplified(&directory).unwrap();
        assert_eq!(canonical_system_data_root(&verbatim).unwrap(), normalized);
        assert_eq!(canonical_system_data_root(&verbatim.join("new-app-data")).unwrap(), normalized.join("new-app-data"));
        assert_eq!(crate::path_policy::simplify_verbatim(PathBuf::from(r"\\?\UNC\server\share\app")),
            PathBuf::from(r"\\server\share\app"));
        fs::remove_dir(directory).unwrap();
    }
}
