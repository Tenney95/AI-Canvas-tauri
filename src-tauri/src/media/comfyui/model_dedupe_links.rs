//! 模型去重写入与中断恢复。IPC 只接受扫描对象 ID；任何原始路径都留在原生侧。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Webview;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use super::{management, model_dedupe, model_dedupe_history::{HistoryItemPlan, HistoryItemStatus, HistoryRun, HistoryStatus}};

const RECOVERY_PREFIX: &str = ".ai-canvas-model-dedupe-";
const RECOVERY_SUFFIX: &str = ".recovery";
const JOURNAL_NAME: &str = "journal.json";
const ORIGINAL_NAME: &str = "original";
const MAX_RECOVERY_ENTRIES: usize = 5_000_000;
const MAX_RECOVERY_DIRECTORIES: usize = 250_000;
const MAX_RECOVERY_RECORDS: usize = 4_096;
static NEXT_TRANSACTION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkType { Hardlink, Symlink }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeRequest {
    scan_id: String,
    group_id: String,
    keeper_id: String,
    target_ids: Vec<String>,
    link_type: LinkType,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeBatchGroupRequest {
    group_id: String,
    keeper_id: String,
    target_ids: Vec<String>,
    link_type: LinkType,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedupeBatchRequest {
    scan_id: String,
    groups: Vec<DedupeBatchGroupRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeResult {
    completed: usize,
    failed: usize,
    unprocessed: usize,
    reclaimed_bytes: u64,
    message: String,
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary { id: String, relative_path: String, root_label: String }

// 不依赖 FileId 的调试字符串或平台序列化细节，记录完整卷 ID 和文件 ID。
#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecordedIdentity { kind: u8, volume: String, index: String }

impl From<file_id::FileId> for RecordedIdentity {
    fn from(identity: file_id::FileId) -> Self {
        match identity {
            file_id::FileId::Inode { device_id, inode_number } => Self { kind: 0, volume: device_id.to_string(), index: inode_number.to_string() },
            file_id::FileId::LowRes { volume_serial_number, file_index } => Self { kind: 1, volume: volume_serial_number.to_string(), index: file_index.to_string() },
            file_id::FileId::HighRes { volume_serial_number, file_id } => Self { kind: 2, volume: volume_serial_number.to_string(), index: file_id.to_string() },
        }
    }
}

impl RecordedIdentity {
    fn decode(&self) -> Result<file_id::FileId, String> {
        let invalid = || "恢复记录文件身份无效".to_string();
        Ok(match self.kind {
            0 => file_id::FileId::new_inode(self.volume.parse().map_err(|_| invalid())?, self.index.parse().map_err(|_| invalid())?),
            1 => file_id::FileId::new_low_res(self.volume.parse().map_err(|_| invalid())?, self.index.parse().map_err(|_| invalid())?),
            2 => file_id::FileId::new_high_res(self.volume.parse().map_err(|_| invalid())?, self.index.parse().map_err(|_| invalid())?),
            _ => return Err(invalid()),
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema_version: u8,
    #[serde(default)]
    root_identity: Option<RecordedIdentity>,
    keeper: String,
    target: String,
    link_type: LinkType,
    size: u64,
    sha256: String,
    keeper_identity: RecordedIdentity,
    original_identity: RecordedIdentity,
}

struct VerifiedPair {
    root: PathBuf,
    keeper: PathBuf,
    target: PathBuf,
    size: u64,
    sha256: String,
    keeper_identity: file_id::FileId,
    target_identity: file_id::FileId,
    link_type: LinkType,
}

struct TransactionOutcome { reclaimed_bytes: u64, warning: Option<String> }

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}

fn plain_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "模型文件不存在或不可访问".to_string())?;
    if !metadata.is_file() || is_reparse(&metadata) { return Err("模型必须是普通文件，不能是链接或目录".into()); }
    Ok(())
}

fn open_read(path: &Path, allow_rename: bool) -> Result<File, String> {
    plain_file(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Windows 阻止新写入；链接/改名步骤允许 DELETE 共享并在操作前后复核身份。
        options.share_mode(if allow_rename { 0x0001 | 0x0004 } else { 0x0001 });
    }
    #[cfg(not(windows))]
    let _ = allow_rename;
    let file = options.open(path).map_err(|_| "模型正在写入或无法读取，请停止下载和模型服务后重试".to_string())?;
    fs2::FileExt::try_lock_shared(&file).map_err(|_| "模型正在被其他操作占用".to_string())?;
    Ok(file)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = open_read(path, true)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "读取模型内容失败".to_string())?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn identical_content(keeper: &mut File, target: &mut File) -> Result<String, String> {
    keeper.seek(SeekFrom::Start(0)).map_err(|_| "无法读取保留模型".to_string())?;
    target.seek(SeekFrom::Start(0)).map_err(|_| "无法读取待替换模型".to_string())?;
    let mut left = vec![0; 1024 * 1024];
    let mut right = vec![0; 1024 * 1024];
    let mut digest = Sha256::new();
    let mut remaining = keeper.metadata().map_err(|_| "读取保留模型信息失败".to_string())?.len();
    if target.metadata().map_err(|_| "读取待替换模型信息失败".to_string())?.len() != remaining {
        return Err("两个模型文件大小不同，未替换文件".into());
    }
    while remaining > 0 {
        let count = remaining.min(left.len() as u64) as usize;
        keeper.read_exact(&mut left[..count]).map_err(|_| "读取保留模型失败".to_string())?;
        target.read_exact(&mut right[..count]).map_err(|_| "读取待替换模型失败".to_string())?;
        if left[..count] != right[..count] { return Err("模型内容已变化或并不相同，未替换文件，请重新扫描".into()); }
        digest.update(&left[..count]);
        remaining -= count as u64;
    }
    if keeper.read(&mut left[..1]).map_err(|_| "复核保留模型失败".to_string())? != 0
        || target.read(&mut right[..1]).map_err(|_| "复核待替换模型失败".to_string())? != 0
    { return Err("比较期间模型大小已变化，未替换文件".into()); }
    Ok(format!("{:x}", digest.finalize()))
}

fn stable_scanned_file(file: &model_dedupe::ScannedModelFile, target: bool) -> Result<(), String> {
    plain_file(&file.path)?;
    let current = model_dedupe::read_file_identity(&file.path)?;
    if current.identity != file.identity || current.size != file.size || current.modified != file.modified {
        return Err("模型自扫描后已变化，请重新扫描".into());
    }
    if target && current.link_count != 1 { return Err("待替换文件已经共享磁盘数据，不再重复处理".into()); }
    Ok(())
}

fn authorize_parent(app: &tauri::AppHandle, root: &Path, path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "模型目录无效".to_string())?;
    if !parent.starts_with(root) { return Err("模型超出当前扫描授权目录".into()); }
    model_dedupe::authorize_plain_model_directory(app, root, parent)?;
    let authorized = crate::path_policy::authorize_path_with_roots(app, &path.to_string_lossy(), crate::path_policy::PathAccess::Write, &[root.to_path_buf()])
        .map_err(|_| "模型写入目录未获授权".to_string())?;
    // 链接的 canonical 路径会变成 keeper，只在目标不存在/为普通文件时调用。
    if authorized != path { return Err("模型写入路径已变化".into()); }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> Result<String, String> {
    let value = path.strip_prefix(root).map_err(|_| "模型路径超出扫描授权目录".to_string())?;
    if value.as_os_str().is_empty() || value.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("模型相对路径无效".into());
    }
    value.to_str().map(str::to_owned).ok_or_else(|| "模型路径编码不受支持".into())
}

fn journal_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || value.len() > 32_768 || value.chars().any(char::is_control)
        || path.components().any(|part| !matches!(part, Component::Normal(_)))
    { return Err("恢复记录包含无效相对路径".into()); }
    Ok(root.join(path))
}

fn create_recovery_directory(target: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or_else(|| "模型目录无效".to_string())?;
    for _ in 0..8 {
        let time = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时钟无效".to_string())?.as_nanos();
        let counter = NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed);
        let token = format!("{:x}", Sha256::digest(format!("{}:{time}:{counter}", std::process::id()).as_bytes()));
        let directory = parent.join(format!("{RECOVERY_PREFIX}{token}{RECOVERY_SUFFIX}"));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建模型去重恢复目录，未替换文件".into()),
        }
    }
    Err("无法分配模型去重恢复记录".into())
}

fn create_link(keeper: &Path, target: &Path, kind: LinkType) -> Result<(), String> {
    let result = match kind {
        LinkType::Hardlink => fs::hard_link(keeper, target),
        LinkType::Symlink => {
            #[cfg(windows)]
            { std::os::windows::fs::symlink_file(keeper, target) }
            #[cfg(unix)]
            { std::os::unix::fs::symlink(keeper, target) }
            #[cfg(not(any(windows, unix)))]
            { Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "unsupported platform")) }
        }
    };
    result.map_err(|error| match kind {
        LinkType::Hardlink if (cfg!(windows) && error.raw_os_error() == Some(17)) || (cfg!(unix) && error.raw_os_error() == Some(18)) => "硬链接要求两个文件处于同一磁盘卷，请选择符号链接".into(),
        LinkType::Hardlink => "无法创建硬链接，原文件将恢复；不会改用复制或直接删除".into(),
        LinkType::Symlink => "无法创建符号链接；Windows 请启用开发者模式或使用具有相应权限的账户，原文件将恢复".into(),
    })
}

fn valid_link(keeper: &Path, target: &Path, kind: LinkType, identity: file_id::FileId) -> bool {
    let Ok(metadata) = fs::symlink_metadata(target) else { return false; };
    match kind {
        LinkType::Hardlink => !is_reparse(&metadata) && metadata.is_file()
            && file_id::get_file_id(target).ok() == Some(identity),
        LinkType::Symlink => metadata.file_type().is_symlink()
            && fs::read_link(target).ok().as_deref() == Some(keeper)
            && fs::canonicalize(target).ok() == fs::canonicalize(keeper).ok()
            && file_id::get_file_id(target).ok() == Some(identity),
    }
}

fn clean_journal(directory: &Path) -> Result<(), String> {
    fs::remove_file(directory.join(JOURNAL_NAME)).map_err(|_| "恢复记录尚未清理，请保留恢复目录".to_string())?;
    fs::remove_dir(directory).map_err(|_| "恢复目录含有其他文件，已保留以免误删".to_string())
}

fn clean_unstarted_record(directory: &Path) -> Result<(), String> {
    let entries: Vec<_> = fs::read_dir(directory).map_err(|_| "无法读取不完整恢复目录".to_string())?
        .take(2).collect::<Result<Vec<_>, _>>().map_err(|_| "无法读取不完整恢复目录".to_string())?;
    if entries.len() > 1 { return Err("恢复目录中包含其他文件，已保留现场，请先人工检查".into()); }
    for entry in &entries {
        if entry.file_name() != JOURNAL_NAME {
            return Err("恢复记录损坏且目录中仍有原文件或未知文件，已完整保留；请先人工检查所示恢复目录".into());
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "不完整恢复记录不可访问".to_string())?;
        if !metadata.is_file() || is_reparse(&metadata) || metadata.len() > 32 * 1024
            || model_dedupe::read_file_identity(&entry.path())?.link_count != 1
        { return Err("不完整恢复记录含未知文件或链接，已保留现场".into()); }
    }
    for entry in entries {
        fs::remove_file(entry.path()).map_err(|_| "无法清理不完整恢复记录".to_string())?;
    }
    fs::remove_dir(directory).map_err(|_| "恢复目录仍有其他内容，已保留现场".to_string())
}

fn rollback(pair: &VerifiedPair, directory: &Path) -> Result<(), String> {
    let original = directory.join(ORIGINAL_NAME);
    plain_file(&original)?;
    if file_id::get_file_id(&original).ok() != Some(pair.target_identity)
        || sha256_file(&original)? != pair.sha256
    { return Err("备份身份或内容发生变化，已保留恢复目录".into()); }
    if fs::symlink_metadata(&pair.target).is_ok() {
        if plain_file(&pair.target).is_ok() && file_id::get_file_id(&pair.target).ok() == Some(pair.target_identity)
            && sha256_file(&pair.target)? == pair.sha256
        {
            // 上次恢复在还原原路径后中断：原路径已经正确，只清理同一 inode 的备份。
            fs::remove_file(&original).map_err(|_| "原路径已恢复，但恢复副本仍待清理".to_string())?;
            return clean_journal(directory);
        }
        // 恢复原件不依赖保留路径仍然存在；精确匹配的悬空符号链接也可安全移除。
        let expected_link = match pair.link_type {
            LinkType::Hardlink => valid_link(&pair.keeper, &pair.target, pair.link_type, pair.keeper_identity),
            LinkType::Symlink => fs::symlink_metadata(&pair.target).is_ok_and(|metadata| metadata.file_type().is_symlink())
                && fs::read_link(&pair.target).ok().as_deref() == Some(pair.keeper.as_path()),
        };
        if !expected_link {
            return Err("原路径出现其他文件，未覆盖；原模型保存在恢复目录中".into());
        }
        fs::remove_file(&pair.target).map_err(|_| "无法移除新链接，原模型仍保存在恢复目录".to_string())?;
    }
    // create-link 不覆盖现有路径；即使其他程序在此时写入，也只会保留备份并失败。
    fs::hard_link(&original, &pair.target).map_err(|_| "无法还原原路径，原模型仍保存在恢复目录".to_string())?;
    if file_id::get_file_id(&pair.target).ok() != Some(pair.target_identity) {
        return Err("还原文件身份复核失败，请保留恢复目录".into());
    }
    fs::remove_file(&original).map_err(|_| "原路径已恢复，但恢复副本仍待清理".to_string())?;
    clean_journal(directory)
}

fn replace_one(
    pair: &VerifiedPair,
    validate: impl Fn() -> Result<(), String>,
    make_link: impl Fn(&Path, &Path, LinkType) -> Result<(), String>,
    before_cleanup: impl Fn() -> Result<(), String>,
) -> Result<TransactionOutcome, String> {
    validate()?;
    let journal = Journal {
        schema_version: 2,
        root_identity: Some(file_id::get_file_id(&pair.root).map_err(|_| "扫描授权目录身份不可读取，未替换文件".to_string())?.into()),
        keeper: relative(&pair.root, &pair.keeper)?, target: relative(&pair.root, &pair.target)?,
        link_type: pair.link_type, size: pair.size, sha256: pair.sha256.clone(),
        keeper_identity: pair.keeper_identity.into(), original_identity: pair.target_identity.into(),
    };
    let directory = create_recovery_directory(&pair.target)?;
    let write_journal = (|| {
        let bytes = serde_json::to_vec(&journal).map_err(|_| "无法写入恢复记录".to_string())?;
        if bytes.len() > 32 * 1024 { return Err("模型路径过长，无法保存有界恢复记录；原文件未移动".to_string()); }
        let mut file = OpenOptions::new().write(true).create_new(true).open(directory.join(JOURNAL_NAME))
            .map_err(|_| "无法创建恢复记录".to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "无法持久保存恢复记录".to_string())
    })();
    if let Err(error) = write_journal {
        // 还没移动任何模型。清理本次创建的未完成记录，不留下无法解析的半条日志。
        let _ = fs::remove_file(directory.join(JOURNAL_NAME));
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    let original = directory.join(ORIGINAL_NAME);
    // 不在事务中响应取消；关窗后本文件要么完成，要么保留可恢复的原文件。
    if let Err(error) = validate() {
        let _ = clean_journal(&directory);
        return Err(error);
    }
    fs::rename(&pair.target, &original).map_err(|_| "原模型无法改名，文件未替换；恢复记录可稍后清理".to_string())?;
    let apply: Result<(), String> = (|| {
        if file_id::get_file_id(&original).ok() != Some(pair.target_identity) {
            return Err("模型在改名前发生变化，未执行链接".into());
        }
        make_link(&pair.keeper, &pair.target, pair.link_type)?;
        if !valid_link(&pair.keeper, &pair.target, pair.link_type, pair.keeper_identity) {
            return Err("新链接未通过身份复核".into());
        }
        if sha256_file(&original)? != pair.sha256 || sha256_file(&pair.keeper)? != pair.sha256 {
            return Err("模型在写入期间发生变化，未删除原文件".into());
        }
        let original_identity = model_dedupe::read_file_identity(&original)?;
        if original_identity.identity != pair.target_identity || original_identity.link_count != 1
            || !valid_link(&pair.keeper, &pair.target, pair.link_type, pair.keeper_identity)
        { return Err("链接或恢复副本在复核期间发生变化，未删除原文件".into()); }
        // 历史阶段必须持久成功后才删除原数据；写入失败走相同事务回滚。
        before_cleanup()?;
        Ok(())
    })();
    if let Err(error) = apply {
        return match rollback(pair, &directory) {
            Ok(()) => Err(format!("{error}；原文件已恢复")),
            Err(recovery) => Err(format!("{error}；{recovery}，请使用中断恢复入口")),
        };
    }
    if fs::remove_file(&original).is_err() {
        return Ok(TransactionOutcome { reclaimed_bytes: 0, warning: Some("链接已创建，但原文件恢复副本仍占用空间；请通过中断恢复处理".into()) });
    }
    let warning = clean_journal(&directory).err();
    Ok(TransactionOutcome { reclaimed_bytes: pair.size, warning })
}

#[tauri::command]
pub async fn apply_comfyui_model_deduplication(webview: Webview, app: tauri::AppHandle, request: DedupeRequest) -> Result<DedupeResult, String> {
    apply_batch(webview, app, DedupeBatchRequest { scan_id: request.scan_id, groups: vec![DedupeBatchGroupRequest {
        group_id: request.group_id, keeper_id: request.keeper_id, target_ids: request.target_ids, link_type: request.link_type,
    }] }).await
}

#[tauri::command]
pub async fn apply_comfyui_model_deduplication_batch(webview: Webview, app: tauri::AppHandle, request: DedupeBatchRequest) -> Result<DedupeResult, String> {
    apply_batch(webview, app, request).await
}

async fn apply_batch(webview: Webview, app: tauri::AppHandle, request: DedupeBatchRequest) -> Result<DedupeResult, String> {
    let requested_targets = request.groups.iter().fold(0_usize, |total, group| total.saturating_add(group.target_ids.len()));
    if request.groups.is_empty() || request.groups.len() > 256 || requested_targets == 0 || requested_targets > 256 {
        return Err("单次操作请选择 1 至 256 个待替换模型；超过上限请分批选择，未执行任何替换".into());
    }
    if request.scan_id.len() > 128 || request.groups.iter().any(|group| group.group_id.len() > 128 || group.keeper_id.len() > 128
        || group.target_ids.iter().any(|id| id.len() > 128)) {
        return Err("模型扫描对象标识无效，请重新扫描".into());
    }
    let _guard = management::lock_operations().await;
    let installation_root = management::management_root(&webview, &app)?;
    let session_id = management::management_session_id(&app)?;
    management::assert_server_stopped(&app)?;
    ensure_no_pending_recoveries(&app, &installation_root).await?;
    let selections = model_dedupe::take_groups_for_replacement(&app, &request.scan_id, &request.groups.iter().map(|group| {
        model_dedupe::DuplicateSelectionRequest { group_id: group.group_id.clone(), keeper_id: group.keeper_id.clone(), target_ids: group.target_ids.clone() }
    }).collect::<Vec<_>>())?;
    let authorization = selections.first().ok_or_else(|| "请选择需要替换的模型副本".to_string())?.scan_root.clone();
    model_dedupe::verify_model_scan_root(&app, &authorization)?;
    let total = selections.iter().map(|selection| selection.targets.len()).sum::<usize>();
    let group_count = selections.len();
    let hardlinks = request.groups.iter().filter(|group| matches!(group.link_type, LinkType::Hardlink)).map(|group| group.target_ids.len()).sum::<usize>();
    let symlinks = total - hardlinks;
    let approval_app = app.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || approval_app.dialog()
        .message(format!("将按各组当前选择合并 {group_count} 组中的 {total} 个模型副本（硬链接 {hardlinks} 项、符号链接 {symlinks} 项），保留每个原目录和文件名。写入前重新逐字节比较内容；链接复核及历史保存成功后才删除重复数据。遇到失败即停止，未执行项不会自动重试。\n\n链接后的路径共用模型内容，修改其中一个文件可能影响其他路径。请停止模型下载、同步和 ComfyUI 服务。本次保留相对路径参照历史（最近 100 次）；历史不是回滚授权。"))
        .title("确认合并重复模型？").kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("确认创建链接".into(), "取消".into())).blocking_show())
        .await.map_err(|_| "无法显示模型去重确认".to_string())?;
    if !approved { return Err("已取消模型去重".into()); }
    if management::management_root(&webview, &app)? != installation_root || management::management_session_id(&app)? != session_id { return Err("管理会话已变化，请重新扫描".into()); }
    model_dedupe::verify_model_scan_root(&app, &authorization)?;
    management::assert_server_stopped(&app)?;
    ensure_no_pending_recoveries(&app, &installation_root).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = &authorization.root;
        // 所有计划先落盘。记录只来自本次原生快照，不接受 Renderer 路径或摘要。
        let history_items = selections.iter().zip(&request.groups).flat_map(|(selection, group)| selection.targets.iter().map(move |target| HistoryItemPlan {
            keeper_relative_path: selection.keeper.relative_path.clone(), target_relative_path: target.relative_path.clone(),
            hash: selection.hash.clone(), link_type: group.link_type, size: selection.size,
        })).collect();
        let history = HistoryRun::create(&app, authorization.scope, root, history_items)?;
        let mut completed = 0;
        let mut failed = 0;
        let mut reclaimed_bytes = 0;
        let mut warnings = Vec::new();
        let mut history_healthy = true;
        let mut index = 0;
        'groups: for (selection, group) in selections.iter().zip(&request.groups) {
            let mut keeper: Option<File> = None;
            for target in &selection.targets {
                if let Err(error) = history.processing(index) {
                    warnings.push(error);
                    history_healthy = false;
                    break 'groups;
                }
                let operation = (|| {
                    if management::management_root(&webview, &app)? != installation_root || management::management_session_id(&app)? != session_id { return Err("管理会话已关闭或变化，后续副本未处理".into()); }
                    model_dedupe::verify_model_scan_root(&app, &authorization)?;
                    management::assert_server_stopped(&app)?;
                    model_dedupe::authorize_plain_model_file(&app, root, &selection.keeper.path)?;
                    model_dedupe::authorize_plain_model_file(&app, root, &target.path)?;
                    stable_scanned_file(&selection.keeper, false)?;
                    stable_scanned_file(target, true)?;
                    if selection.keeper.identity == target.identity { return Err("两个路径已经指向同一文件，无需去重".into()); }
                    if keeper.is_none() {
                        // 同组只重新散列一次。句柄持有至整组结束，并逐项复核元数据及精确内容。
                        let opened = open_read(&selection.keeper.path, matches!(group.link_type, LinkType::Hardlink))?;
                        if model_dedupe::hash_model_file(&app, root, &selection.keeper, &Arc::new(AtomicBool::new(false)))? != selection.hash {
                            return Err("保留模型内容自扫描后已变化，请重新扫描".into());
                        }
                        keeper = Some(opened);
                    }
                    let mut duplicate = open_read(&target.path, true)?;
                    let digest = identical_content(keeper.as_mut().ok_or_else(|| "保留模型句柄不可用".to_string())?, &mut duplicate)?;
                    stable_scanned_file(&selection.keeper, false)?;
                    stable_scanned_file(target, true)?;
                    let pair = VerifiedPair { root: root.clone(), keeper: selection.keeper.path.clone(), target: target.path.clone(), size: selection.size,
                        sha256: digest, keeper_identity: selection.keeper.identity, target_identity: target.identity, link_type: group.link_type };
                    replace_one(&pair, || {
                        if management::management_root(&webview, &app)? != installation_root || management::management_session_id(&app)? != session_id { return Err("管理会话已关闭或变化，后续副本未处理".into()); }
                        model_dedupe::verify_model_scan_root(&app, &authorization)?;
                        authorize_parent(&app, root, &target.path)?;
                        model_dedupe::authorize_plain_model_file(&app, root, &selection.keeper.path)?;
                        stable_scanned_file(&selection.keeper, false)?;
                        stable_scanned_file(target, true)
                    }, create_link, || history.linked(index))
                })();
                match operation {
                    Ok(outcome) => {
                        completed += 1;
                        reclaimed_bytes += outcome.reclaimed_bytes;
                        let status = if outcome.warning.is_some() { HistoryItemStatus::NeedsRecovery } else { HistoryItemStatus::Completed };
                        if let Err(error) = history.item_result(index, status, outcome.reclaimed_bytes, outcome.warning.clone()) {
                            warnings.push(error);
                            history_healthy = false;
                            break 'groups;
                        }
                        if let Some(warning) = outcome.warning {
                            warnings.push(warning);
                            break 'groups;
                        }
                    }
                    Err(error) => {
                        failed += 1;
                        if let Err(history_error) = history.item_result(index, HistoryItemStatus::Failed, 0, Some(error.clone())) {
                            warnings.push(history_error);
                            history_healthy = false;
                        }
                        warnings.push(error);
                        break 'groups;
                    }
                }
                index += 1;
            }
        }
        let unprocessed = total - completed - failed;
        let status = if completed == total && warnings.is_empty() { HistoryStatus::Completed }
            else if completed == 0 && failed > 0 { HistoryStatus::Failed } else { HistoryStatus::Partial };
        if history_healthy {
            if let Err(error) = history.finish(status) { warnings.push(error); }
        }
        Ok(DedupeResult { completed, failed, unprocessed, reclaimed_bytes,
            message: format!("已处理 {completed} 项，失败 {failed} 项，未处理 {unprocessed} 项；原目录和文件名保持不变。结果已保留参照历史，请重新扫描确认。"),
            warnings, history_id: Some(history.id) })
    }).await.map_err(|_| "模型去重任务中断，请查看参照历史并检查中断恢复记录后再操作".to_string())?
}

struct RecoveryRecord {
    authorization: model_dedupe::ModelScanRoot,
    journal_root: PathBuf,
    directory: PathBuf,
    journal: Option<Journal>,
    id: String,
}

fn recovery_id(directory: &Path) -> String {
    // 不同扫描根下相同的相对文件名不能共用恢复 ID；绝对路径只参与原生内存散列。
    format!("{:x}", Sha256::digest(directory.as_os_str().to_string_lossy().as_bytes()))
}

fn journal_root_for_record(authorized_root: &Path, directory: &Path, target: &str) -> Result<PathBuf, String> {
    // 日志中的路径相对首次扫描根。以后选择它的祖先（例如整个磁盘）仍可发现并恢复。
    let target = Path::new(target);
    if target.components().next().is_none() || target.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("恢复记录包含无效相对路径".into());
    }
    let mut root = directory.parent().ok_or_else(|| "恢复目录无效".to_string())?;
    for _ in target.parent().into_iter().flat_map(Path::components) {
        root = root.parent().ok_or_else(|| "恢复记录超出扫描授权目录".to_string())?;
    }
    if !root.starts_with(authorized_root) { return Err("恢复记录需要重新授权原扫描目录".into()); }
    Ok(root.to_path_buf())
}

fn read_record(app: &tauri::AppHandle, authorization: &model_dedupe::ModelScanRoot, directory: &Path) -> Result<RecoveryRecord, String> {
    let root = &authorization.root;
    let journal_file = directory.join(JOURNAL_NAME);
    model_dedupe::authorize_plain_model_file(app, root, &journal_file)?;
    let metadata = fs::metadata(&journal_file).map_err(|_| "恢复记录不可访问".to_string())?;
    if metadata.len() > 32 * 1024 { return Err("恢复记录过大".into()); }
    let mut bytes = Vec::new();
    File::open(&journal_file).map_err(|_| "无法读取恢复记录".to_string())?.take(32 * 1024 + 1).read_to_end(&mut bytes)
        .map_err(|_| "无法读取恢复记录".to_string())?;
    if bytes.len() > 32 * 1024 { return Err("恢复记录过大".into()); }
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|_| "恢复记录格式无效".to_string())?;
    let journal_root = journal_root_for_record(root, directory, &journal.target)?;
    model_dedupe::authorize_plain_model_directory(app, root, &journal_root)?;
    if journal.schema_version == 2 && (journal.root_identity.is_none()
        || journal.root_identity.as_ref() != file_id::get_file_id(&journal_root).ok().map(RecordedIdentity::from).as_ref()) {
        return Err("原扫描目录身份已变化，请保留恢复记录".into());
    }
    let keeper = journal_path(&journal_root, &journal.keeper)?;
    let target = journal_path(&journal_root, &journal.target)?;
    if !matches!(journal.schema_version, 1 | 2) || journal.size == 0 || journal.sha256.len() != 64
        || !journal.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || keeper == target || target.parent() != directory.parent()
        || directory.file_name().and_then(|name| name.to_str()).is_none_or(|name| !name.starts_with(RECOVERY_PREFIX) || !name.ends_with(RECOVERY_SUFFIX))
    { return Err("恢复记录不匹配当前模型目录".into()); }
    let id = recovery_id(directory);
    Ok(RecoveryRecord { authorization: authorization.clone(), journal_root, directory: directory.to_path_buf(), journal: Some(journal), id })
}

fn recovery_records(app: &tauri::AppHandle, authorization: &model_dedupe::ModelScanRoot, mut traversal_roots: Vec<PathBuf>) -> Result<Vec<RecoveryRecord>, String> {
    model_dedupe::verify_model_scan_root(app, authorization)?;
    let root = &authorization.root;
    // 显式选择的深层子根先走，保留各自的深度界限；随后父根遇到已完成目录便跳过。
    traversal_roots.sort_by(|left, right| left.components().count().cmp(&right.components().count()).then_with(|| left.cmp(right)));
    traversal_roots.dedup();
    let mut stack: Vec<_> = traversal_roots.into_iter().map(|path| (path, 0)).collect();
    let mut seen_directories = HashSet::new();
    let mut visited = 0;
    let mut directories = 0;
    let mut records = Vec::new();
    while let Some((directory, depth)) = stack.pop() {
        model_dedupe::verify_model_scan_root(app, authorization)?;
        if depth > model_dedupe::MAX_MODEL_SCAN_DEPTH { continue; }
        if !seen_directories.insert(directory.clone()) { continue; }
        directories += 1;
        if directories > MAX_RECOVERY_DIRECTORIES { return Err("扫描文件夹过多，请关闭管理窗口后选择更小的文件夹再处理恢复记录".into()); }
        if model_dedupe::authorize_plain_model_directory(app, root, &directory).is_err() { continue; }
        let Ok(entries) = fs::read_dir(&directory) else { continue; };
        for entry in entries.flatten() {
            visited += 1;
            if visited % 128 == 0 { model_dedupe::verify_model_scan_root(app, authorization)?; }
            if visited > MAX_RECOVERY_ENTRIES { return Err("扫描范围过大，恢复记录枚举已停止，请关闭管理窗口后选择更小的文件夹".into()); }
            // Windows 的 ReadDir 已提供 file type，普通文件无须逐个再发起 metadata 读取。
            if !entry.file_type().is_ok_and(|kind| kind.is_dir() && !kind.is_symlink()) { continue; }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else { continue; };
            if !metadata.is_dir() || is_reparse(&metadata) { continue; }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(RECOVERY_PREFIX) {
                // 半写入/损坏的记录同样显式显示；不能让扫描被阻止却没有恢复入口。
                let record = match read_record(app, authorization, &path) {
                    Ok(record) => record,
                    Err(_) => {
                        model_dedupe::authorize_plain_model_directory(app, root, &path)?;
                        RecoveryRecord { authorization: authorization.clone(), journal_root: root.clone(), id: recovery_id(&path), directory: path, journal: None }
                    }
                };
                records.push(record);
                if records.len() > MAX_RECOVERY_RECORDS { return Err("恢复记录过多，请缩小扫描范围并先处理现有记录".into()); }
                continue;
            }
            if model_dedupe::excluded_directory(&name) { continue; }
            if model_dedupe::authorize_plain_model_directory(app, root, &path).is_ok() {
                if stack.len() >= MAX_RECOVERY_DIRECTORIES { return Err("扫描文件夹过多，请关闭管理窗口后缩小恢复记录查找范围".into()); }
                stack.push((path, depth + 1));
            }
        }
    }
    Ok(records)
}

/// 调用方已持有 management operation lock；避免插件目录移动后破坏恢复记录的位置。
pub(super) async fn ensure_no_pending_recoveries(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let session_id = management::management_session_id(app)?;
    let worker_app = app.clone();
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if !model_dedupe::authorized_model_scan_roots(&worker_app)?.iter().any(|entry| entry.root == root) {
            return Err("管理或扫描目录已变化，请重新打开管理窗口".into());
        }
        if !all_recovery_records(&worker_app)?.is_empty() {
            return Err("存在未处理的模型去重恢复记录，请先到模型去重页验证并恢复".into());
        }
        Ok(())
    }).await.map_err(|_| "检查模型恢复记录失败".to_string())??;
    if management::management_session_id(app)? != session_id { return Err("管理会话已变化，请重新打开管理窗口".into()); }
    Ok(())
}

fn all_recovery_records(app: &tauri::AppHandle) -> Result<Vec<RecoveryRecord>, String> {
    let mut records: Vec<RecoveryRecord> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let authorized = model_dedupe::authorized_model_scan_roots(app)?;
    for root in &authorized {
        let covered_by_parent = authorized.iter().any(|parent| external_scope(parent.scope)
            && root.root.starts_with(&parent.root)
            && (root.root != parent.root || !external_scope(root.scope) || parent.id < root.id));
        if covered_by_parent { continue; }
        let traversal_roots = authorized.iter().filter(|child| child.id == root.id
            || external_scope(root.scope) && child.root.starts_with(&root.root))
            .flat_map(model_dedupe::ModelScanRoot::traversal_roots).collect();
        for record in recovery_records(app, root, traversal_roots)? {
            if let Some(index) = positions.get(&record.id).copied() {
                // 授权子目录可能先发现记录却不足以解析；优先展示完整授权根下的可恢复项。
                if records[index].journal.is_none() && record.journal.is_some() { records[index] = record; }
            } else {
                if records.len() >= MAX_RECOVERY_RECORDS { return Err("恢复记录过多，请关闭管理窗口后选择更小范围分批恢复".into()); }
                positions.insert(record.id.clone(), records.len());
                records.push(record);
            }
        }
    }
    Ok(records)
}

fn external_scope(scope: model_dedupe::ModelScanScope) -> bool {
    matches!(scope, model_dedupe::ModelScanScope::Folder | model_dedupe::ModelScanScope::Disk)
}

#[tauri::command]
pub async fn list_comfyui_model_dedupe_recoveries(webview: Webview, app: tauri::AppHandle) -> Result<Vec<RecoverySummary>, String> {
    let _guard = management::lock_operations().await;
    management::management_root(&webview, &app)?;
    let session_id = management::management_session_id(&app)?;
    let worker_app = app.clone();
    let records = tauri::async_runtime::spawn_blocking(move || all_recovery_records(&worker_app).and_then(|records| records.into_iter()
        .map(|record| Ok(RecoverySummary { id: record.id, root_label: record.authorization.root.to_string_lossy().into_owned(), relative_path: match record.journal {
            Some(journal) => relative(&record.authorization.root, &journal_path(&record.journal_root, &journal.target)?)?,
            None => format!("{}（记录不完整）", relative(&record.authorization.root, &record.directory)?),
        } })).collect::<Result<Vec<_>, String>>()))
        .await.map_err(|_| "读取模型恢复记录失败".to_string())??;
    management::management_root(&webview, &app)?;
    if management::management_session_id(&app)? != session_id { return Err("管理会话已变化，请刷新恢复列表".into()); }
    Ok(records)
}

#[tauri::command]
pub async fn recover_comfyui_model_dedupe(webview: Webview, app: tauri::AppHandle, recovery_id: String) -> Result<DedupeResult, String> {
    let _guard = management::lock_operations().await;
    let installation_root = management::management_root(&webview, &app)?;
    let session_id = management::management_session_id(&app)?;
    management::assert_server_stopped(&app)?;
    if recovery_id.len() != 64 || !recovery_id.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("恢复记录 ID 无效".into()); }
    let approval_app = app.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || approval_app.dialog()
        .message("恢复中断的模型去重：存在原文件备份时，将在验证身份和完整内容后恢复原目录中的普通文件；如果链接已完成且原副本已清理，只清理恢复记录。遇到未知文件或内容变化会保留现场，不覆盖文件。")
        .title("恢复模型文件？").kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("验证并恢复".into(), "取消".into())).blocking_show())
        .await.map_err(|_| "无法显示模型恢复确认".to_string())?;
    if !approved { return Err("已取消模型恢复".into()); }
    if management::management_root(&webview, &app)? != installation_root || management::management_session_id(&app)? != session_id { return Err("管理会话已变化".into()); }
    management::assert_server_stopped(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let record = all_recovery_records(&app)?.into_iter().find(|record| record.id == recovery_id)
            .ok_or_else(|| "恢复记录已失效，请刷新列表".to_string())?;
        let authorization = record.authorization;
        let root = authorization.root.clone();
        model_dedupe::verify_model_scan_root(&app, &authorization)?;
        model_dedupe::authorize_plain_model_directory(&app, &root, &record.directory)?;
        if management::management_root(&webview, &app)? != installation_root || management::management_session_id(&app)? != session_id { return Err("管理会话已变化，恢复未执行".into()); }
        management::assert_server_stopped(&app)?;
        model_dedupe::invalidate_model_scans(&app);
        let Some(journal) = record.journal else {
            clean_unstarted_record(&record.directory)?;
            return Ok(DedupeResult { completed: 0, failed: 0, unprocessed: 0, history_id: None, reclaimed_bytes: 0, message: "已清理尚未移动模型的未完成恢复记录，请重新扫描。".into(), warnings: Vec::new() });
        };
        let keeper = journal_path(&record.journal_root, &journal.keeper)?;
        let target = journal_path(&record.journal_root, &journal.target)?;
        let keeper_identity = journal.keeper_identity.decode()?;
        let parent = target.parent().ok_or_else(|| "模型父目录无效".to_string())?;
        model_dedupe::authorize_plain_model_directory(&app, &root, parent)?;
        if management::management_root(&webview, &app)? != installation_root || management::management_session_id(&app)? != session_id { return Err("管理会话已变化，恢复未执行".into()); }
        model_dedupe::verify_model_scan_root(&app, &authorization)?;
        management::assert_server_stopped(&app)?;
        model_dedupe::invalidate_model_scans(&app);
        let original = record.directory.join(ORIGINAL_NAME);
        if fs::symlink_metadata(&original).is_ok() {
            model_dedupe::authorize_plain_model_file(&app, &root, &original)?;
            let backup = model_dedupe::read_file_identity(&original)?;
            if RecordedIdentity::from(backup.identity) != journal.original_identity
                || backup.size != journal.size || sha256_file(&original)? != journal.sha256
            { return Err("原文件恢复副本已变化，现场已保留".into()); }
            let pair = VerifiedPair { root: root.clone(), keeper, target, size: journal.size,
                sha256: journal.sha256, keeper_identity, target_identity: backup.identity, link_type: journal.link_type };
            // validate 写入父目录，不通过 canonical 链接目标来授权原路径。
            let parent = pair.target.parent().ok_or_else(|| "模型父目录无效".to_string())?;
            model_dedupe::authorize_plain_model_directory(&app, &root, parent)?;
            model_dedupe::verify_model_scan_root(&app, &authorization)?;
            management::assert_server_stopped(&app)?;
            rollback(&pair, &record.directory)?;
        } else {
            let current = file_id::get_file_id(&target).map_err(|_| "原模型和恢复副本均缺失，请保留恢复记录".to_string())?;
            let untouched = RecordedIdentity::from(current) == journal.original_identity
                && model_dedupe::authorize_plain_model_file(&app, &root, &target).is_ok()
                && sha256_file(&target)? == journal.sha256;
            if !untouched {
                model_dedupe::authorize_plain_model_file(&app, &root, &keeper)?;
                let _keeper_handle = open_read(&keeper, false)?;
                if file_id::get_file_id(&keeper).ok() != Some(keeper_identity)
                    || sha256_file(&keeper)? != journal.sha256
                    || !valid_link(&keeper, &target, journal.link_type, keeper_identity)
                { return Err("原路径存在未识别文件或保留模型已变化，未清理恢复记录".into()); }
            }
            model_dedupe::verify_model_scan_root(&app, &authorization)?;
            management::assert_server_stopped(&app)?;
            clean_journal(&record.directory)?;
        }
        Ok(DedupeResult { completed: 0, failed: 0, unprocessed: 0, history_id: None, reclaimed_bytes: 0, message: "中断记录已处理；存在备份的模型已恢复为普通文件，请重新扫描。".into(), warnings: Vec::new() })
    }).await.map_err(|_| "模型恢复任务中断，请保留恢复目录".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("canvas-model-links-{}-{}", std::process::id(), NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn pair(&self) -> VerifiedPair {
            let keeper = self.0.join("original-name.safetensors");
            let target = self.0.join("plugin-specific-name.pth");
            fs::write(&keeper, b"identical model weights").unwrap();
            fs::write(&target, b"identical model weights").unwrap();
            VerifiedPair { root: self.0.clone(), keeper_identity: file_id::get_file_id(&keeper).unwrap(), target_identity: file_id::get_file_id(&target).unwrap(),
                keeper, target, size: 23, sha256: format!("{:x}", Sha256::digest(b"identical model weights")), link_type: LinkType::Hardlink }
        }
    }
    impl Drop for TempRoot { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn different_names_remain_at_original_paths_after_hardlink() {
        let root = TempRoot::new();
        let pair = root.pair();
        let result = replace_one(&pair, || Ok(()), create_link, || Ok(())).unwrap();
        assert_eq!(result.reclaimed_bytes, pair.size);
        assert_eq!(fs::read(&pair.target).unwrap(), b"identical model weights");
        assert_eq!(file_id::get_file_id(&pair.target).unwrap(), pair.keeper_identity);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
    }

    #[test]
    fn unequal_bytes_are_rejected_before_any_mutation() {
        let root = TempRoot::new();
        let pair = root.pair();
        fs::write(&pair.target, b"different model weights").unwrap();
        let mut keeper = File::open(&pair.keeper).unwrap();
        let mut target = File::open(&pair.target).unwrap();
        assert!(identical_content(&mut keeper, &mut target).is_err());
        assert_eq!(fs::read(&pair.target).unwrap(), b"different model weights");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
    }

    #[test]
    fn link_failure_restores_original_file_and_cleans_record() {
        let root = TempRoot::new();
        let pair = root.pair();
        let result = replace_one(&pair, || Ok(()), |_, _, _| Err("simulated link failure".into()), || Ok(()));
        assert!(result.is_err());
        assert_eq!(file_id::get_file_id(&pair.target).unwrap(), pair.target_identity);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
    }

    #[test]
    fn history_checkpoint_failure_restores_original_before_deleting_data() {
        let root = TempRoot::new();
        let pair = root.pair();
        let result = replace_one(&pair, || Ok(()), create_link, || Err("history storage is full".into()));
        assert!(result.is_err());
        assert_eq!(file_id::get_file_id(&pair.target).unwrap(), pair.target_identity);
        assert_eq!(fs::read(&pair.target).unwrap(), b"identical model weights");
        assert_eq!(file_id::get_file_id(&pair.keeper).unwrap(), pair.keeper_identity);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
    }

    #[test]
    fn conflicting_new_file_is_never_overwritten_during_rollback() {
        let root = TempRoot::new();
        let pair = root.pair();
        let result = replace_one(&pair, || Ok(()), |_, target, _| {
            fs::write(target, b"a concurrent download").unwrap();
            Err("simulated conflicting writer".into())
        }, || Ok(()));
        assert!(result.is_err());
        assert_eq!(fs::read(&pair.target).unwrap(), b"a concurrent download");
        let recovery = fs::read_dir(&root.0).unwrap().flatten().map(|entry| entry.path()).find(|path| path.is_dir()).unwrap();
        assert_eq!(fs::read(recovery.join(ORIGINAL_NAME)).unwrap(), b"identical model weights");
    }

    #[test]
    fn journal_rejects_absolute_and_parent_relative_paths() {
        let root = TempRoot::new();
        assert!(journal_path(&root.0, "../elsewhere/model.pth").is_err());
        assert!(journal_path(&root.0, &root.0.to_string_lossy()).is_err());
        assert!(journal_path(&root.0, "models/model.pth").is_ok());
    }

    #[test]
    fn broader_authorized_root_resolves_original_journal_base() {
        let parent = PathBuf::from("scan-root");
        let original_root = parent.join("selected-folder");
        let directory = original_root.join("weights").join(".ai-canvas-model-dedupe-test.recovery");
        assert_eq!(journal_root_for_record(&parent, &directory, "weights/model.pth").unwrap(), original_root);
    }

    #[test]
    fn narrower_authorization_cannot_recover_paths_outside_its_root() {
        let original_root = PathBuf::from("scan-root");
        let narrower_root = original_root.join("weights");
        let directory = narrower_root.join(".ai-canvas-model-dedupe-test.recovery");
        assert!(journal_root_for_record(&narrower_root, &directory, "weights/model.pth").is_err());
        assert!(journal_root_for_record(&original_root, &directory, "../model.pth").is_err());
    }

    #[test]
    fn recovery_ids_distinguish_same_relative_names_in_different_roots() {
        let first = Path::new("first-root").join("weights/.ai-canvas-model-dedupe-test.recovery");
        let second = Path::new("second-root").join("weights/.ai-canvas-model-dedupe-test.recovery");
        assert_ne!(recovery_id(&first), recovery_id(&second));
        assert_eq!(recovery_id(&first), recovery_id(&first));
    }

    #[test]
    fn rollback_reentry_accepts_already_restored_original_identity() {
        let root = TempRoot::new();
        let pair = root.pair();
        let directory = create_recovery_directory(&pair.target).unwrap();
        fs::write(directory.join(JOURNAL_NAME), b"{}").unwrap();
        fs::rename(&pair.target, directory.join(ORIGINAL_NAME)).unwrap();
        fs::hard_link(directory.join(ORIGINAL_NAME), &pair.target).unwrap();
        rollback(&pair, &directory).unwrap();
        assert_eq!(file_id::get_file_id(&pair.target).unwrap(), pair.target_identity);
        assert!(!directory.exists());
    }

    #[test]
    fn missing_keeper_does_not_prevent_restoring_unmoved_backup() {
        let root = TempRoot::new();
        let pair = root.pair();
        let directory = create_recovery_directory(&pair.target).unwrap();
        fs::write(directory.join(JOURNAL_NAME), b"{}").unwrap();
        fs::rename(&pair.target, directory.join(ORIGINAL_NAME)).unwrap();
        fs::remove_file(&pair.keeper).unwrap();
        rollback(&pair, &directory).unwrap();
        assert_eq!(fs::read(&pair.target).unwrap(), b"identical model weights");
        assert!(!directory.exists());
    }

    #[test]
    fn incomplete_empty_record_can_be_removed_but_original_is_preserved() {
        let root = TempRoot::new();
        let pair = root.pair();
        let directory = create_recovery_directory(&pair.target).unwrap();
        fs::write(directory.join(JOURNAL_NAME), b"{partial").unwrap();
        clean_unstarted_record(&directory).unwrap();
        let directory = create_recovery_directory(&pair.target).unwrap();
        fs::write(directory.join(ORIGINAL_NAME), b"important original").unwrap();
        assert!(clean_unstarted_record(&directory).is_err());
        assert_eq!(fs::read(directory.join(ORIGINAL_NAME)).unwrap(), b"important original");
    }
}
