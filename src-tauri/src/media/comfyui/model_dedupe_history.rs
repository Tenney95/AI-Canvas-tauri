//! 模型去重参照历史。只保存相对路径；不可变阶段记录不构成文件授权或回滚指令。
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Webview;

use super::{installation, management, model_dedupe, model_dedupe_links::LinkType};

const DIRECTORY: &str = "model-dedupe-history";
const MAX_HISTORY: usize = 100;
const MAX_DIRECTORIES: usize = 256;
const MAX_ITEMS: usize = 256;
const MAX_PLAN_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EVENT_BYTES: u64 = 16 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoryItemPlan {
    pub keeper_relative_path: String,
    pub target_relative_path: String,
    pub hash: String,
    pub link_type: LinkType,
    pub size: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryPlan {
    schema_version: u8,
    id: String,
    created_at: u64,
    scope: model_dedupe::ModelScanScope,
    root_label: String,
    items: Vec<HistoryItemPlan>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum HistoryItemStatus { Pending, Processing, Completed, Failed, NeedsRecovery }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemCheckpoint {
    status: HistoryItemStatus,
    reclaimed_bytes: u64,
    message: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum HistoryStatus { Completed, Partial, Failed, Interrupted }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinalCheckpoint { status: HistoryStatus }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    #[serde(flatten)]
    plan: HistoryItemPlan,
    status: HistoryItemStatus,
    reclaimed_bytes: u64,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    id: String,
    created_at: u64,
    scope: model_dedupe::ModelScanScope,
    root_label: String,
    status: HistoryStatus,
    completed: usize,
    failed: usize,
    unprocessed: usize,
    reclaimed_bytes: u64,
    items: Vec<HistoryItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList { entries: Vec<HistoryEntry>, warnings: Vec<String> }

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}

fn directory_chain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "去重历史目录不可访问".to_string())?;
        if !metadata.is_dir() || is_reparse(&metadata) { return Err("去重历史目录包含链接，已拒绝访问".into()); }
    }
    Ok(())
}

fn history_directory(app: &tauri::AppHandle, create: bool) -> Result<Option<PathBuf>, String> {
    let Some(private) = installation::storage_directory(app, create)? else { return Ok(None); };
    let directory = private.join(DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(_) => directory_chain(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory).map_err(|_| "无法创建模型去重历史目录".to_string())?;
            directory_chain(&directory)?;
        }
        Err(_) => return Err("模型去重历史目录不可访问".into()),
    }
    Ok(Some(directory))
}

fn valid_id(value: &str) -> bool {
    value.strip_prefix("history-").is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn valid_relative(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8_192 && !value.chars().any(char::is_control)
        && Path::new(value).components().all(|part| matches!(part, Component::Normal(_)))
}

fn validate_plan(plan: &HistoryPlan, id: &str) -> Result<(), String> {
    if plan.schema_version != 1 || plan.id != id || !valid_id(id) || plan.items.is_empty() || plan.items.len() > MAX_ITEMS
        || plan.root_label.is_empty() || plan.root_label.len() > 1_024 || plan.root_label.chars().any(char::is_control)
        || plan.items.iter().any(|item| !valid_relative(&item.keeper_relative_path) || !valid_relative(&item.target_relative_path)
            || item.keeper_relative_path == item.target_relative_path || item.size == 0
            || item.hash.len() != 64 || !item.hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    { return Err("模型去重历史记录格式无效".into()); }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<T, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取模型去重历史记录".to_string())?;
    if !metadata.is_file() || is_reparse(&metadata) || metadata.len() > limit
        || model_dedupe::read_file_identity(path)?.link_count != 1
    { return Err("模型去重历史记录不是受限普通文件".into()); }
    let mut bytes = Vec::new();
    File::open(path).map_err(|_| "无法读取模型去重历史记录".to_string())?.take(limit + 1).read_to_end(&mut bytes)
        .map_err(|_| "读取模型去重历史记录失败".to_string())?;
    if bytes.len() as u64 > limit { return Err("模型去重历史记录过大".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "模型去重历史记录不完整".into())
}

fn write_json(path: &Path, value: &impl Serialize, limit: u64) -> Result<(), String> {
    directory_chain(path.parent().ok_or_else(|| "去重历史目录无效".to_string())?)?;
    let bytes = serde_json::to_vec(value).map_err(|_| "无法序列化模型去重历史".to_string())?;
    if bytes.len() as u64 > limit { return Err("模型去重历史内容超过保存上限，未继续替换".into()); }
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|_| "无法创建模型去重历史阶段记录，未继续替换".to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all())
        .map_err(|_| "无法持久保存模型去重历史，已停止后续替换".to_string())
}

fn root_label(root: &Path) -> String {
    if let Some(name) = root.file_name().and_then(|value| value.to_str()) { return name.to_string(); }
    #[cfg(windows)]
    if let Some(Component::Prefix(prefix)) = root.components().next() {
        use std::path::Prefix;
        if let Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) = prefix.kind() { return format!("{}:", letter as char); }
    }
    "根目录".to_string()
}

fn stored_directories(directory: &Path) -> Result<Vec<(PathBuf, Option<HistoryPlan>)>, String> {
    let mut records = Vec::new();
    for (index, entry) in fs::read_dir(directory).map_err(|_| "无法枚举模型去重历史".to_string())?.enumerate() {
        if index >= MAX_DIRECTORIES { return Err("模型去重历史目录条目过多，已停止写入历史".into()); }
        let entry = entry.map_err(|_| "无法枚举模型去重历史".to_string())?;
        let name = entry.file_name();
        let Some(id) = name.to_str().filter(|id| valid_id(id)) else { continue; };
        directory_chain(&entry.path())?;
        // 计划写入中断尚未触及模型；坏记录只占一个历史槽，不隐藏其他有效记录。
        let plan = read_json::<HistoryPlan>(&entry.path().join("plan.json"), MAX_PLAN_BYTES)
            .ok().filter(|plan| validate_plan(plan, id).is_ok());
        records.push((entry.path(), plan));
    }
    records.sort_by(|left, right| right.1.as_ref().map_or(0, |plan| plan.created_at).cmp(&left.1.as_ref().map_or(0, |plan| plan.created_at))
        .then_with(|| right.0.file_name().cmp(&left.0.file_name())));
    Ok(records)
}

fn checkpoint_name(index: usize, phase: &str) -> String { format!("{index:03}-{phase}.json") }

fn remove_history(directory: &Path, count: usize) -> Result<(), String> {
    directory_chain(directory)?;
    let mut allowed = std::collections::HashSet::from(["plan.json".to_string(), "final.json".to_string()]);
    for index in 0..count {
        for phase in ["processing", "linked", "result"] { allowed.insert(checkpoint_name(index, phase)); }
    }
    let mut files = Vec::new();
    for (index, entry) in fs::read_dir(directory).map_err(|_| "无法清理旧模型去重历史".to_string())?.enumerate() {
        if index > MAX_ITEMS * 3 + 2 { return Err("旧模型去重历史包含未知内容，已保留".into()); }
        let entry = entry.map_err(|_| "无法清理旧模型去重历史".to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "旧模型去重历史不可访问".to_string())?;
        if !entry.file_name().to_str().is_some_and(|name| allowed.contains(name))
            || !metadata.is_file() || is_reparse(&metadata) || model_dedupe::read_file_identity(&entry.path())?.link_count != 1
        { return Err("旧模型去重历史包含未知文件或链接，已保留".into()); }
        files.push(entry.path());
    }
    // 不递归删除，也不跟随记录内任何模型路径。plan 最后清理，便于清理失败后重试。
    files.sort_by_key(|path| path.file_name().is_some_and(|name| name == "plan.json"));
    for file in files { fs::remove_file(file).map_err(|_| "无法清理旧模型去重历史".to_string())?; }
    fs::remove_dir(directory).map_err(|_| "旧模型去重历史目录含有其他内容，已保留".to_string())
}

pub(super) struct HistoryRun {
    app: tauri::AppHandle,
    directory: PathBuf,
    directory_identity: file_id::FileId,
    pub id: String,
}

impl HistoryRun {
    pub(super) fn create(app: &tauri::AppHandle, scope: model_dedupe::ModelScanScope, root: &Path, items: Vec<HistoryItemPlan>) -> Result<Self, String> {
        let parent = history_directory(app, true)?.ok_or_else(|| "模型去重历史目录不可用".to_string())?;
        let records = stored_directories(&parent)?;
        for (directory, plan) in records.into_iter().skip(MAX_HISTORY - 1) { remove_history(&directory, plan.map_or(MAX_ITEMS, |plan| plan.items.len()))?; }
        let id = model_dedupe::opaque_id("history");
        let directory = parent.join(&id);
        let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时钟无效".to_string())?.as_millis()
            .try_into().map_err(|_| "系统时钟超过历史支持范围".to_string())?;
        let plan = HistoryPlan { schema_version: 1, id: id.clone(), created_at, scope, root_label: root_label(root), items };
        validate_plan(&plan, &id)?;
        fs::create_dir(&directory).map_err(|_| "无法创建本次模型去重历史".to_string())?;
        if let Err(error) = write_json(&directory.join("plan.json"), &plan, MAX_PLAN_BYTES) {
            let _ = fs::remove_file(directory.join("plan.json"));
            let _ = fs::remove_dir(&directory);
            return Err(error);
        }
        let directory_identity = file_id::get_file_id(&directory).map_err(|_| "无法读取去重历史目录身份".to_string())?;
        Ok(Self { app: app.clone(), directory, directory_identity, id })
    }

    fn write(&self, name: &str, value: &impl Serialize) -> Result<(), String> {
        let parent = history_directory(&self.app, false)?.ok_or_else(|| "去重历史存储已变化".to_string())?;
        if self.directory.parent() != Some(parent.as_path()) || file_id::get_file_id(&self.directory).ok() != Some(self.directory_identity) {
            return Err("去重历史存储身份已变化，已停止后续替换".into());
        }
        write_json(&self.directory.join(name), value, MAX_EVENT_BYTES)
    }

    pub(super) fn processing(&self, index: usize) -> Result<(), String> {
        self.write(&checkpoint_name(index, "processing"), &ItemCheckpoint { status: HistoryItemStatus::Processing, reclaimed_bytes: 0, message: None })
    }

    pub(super) fn linked(&self, index: usize) -> Result<(), String> {
        self.write(&checkpoint_name(index, "linked"), &ItemCheckpoint { status: HistoryItemStatus::Processing, reclaimed_bytes: 0,
            message: Some("链接已复核；若缺少最终结果，需结合中断恢复记录确认原副本是否已清理。".into()) })
    }

    pub(super) fn item_result(&self, index: usize, status: HistoryItemStatus, reclaimed_bytes: u64, message: Option<String>) -> Result<(), String> {
        self.write(&checkpoint_name(index, "result"), &ItemCheckpoint { status, reclaimed_bytes, message })
    }

    pub(super) fn finish(&self, status: HistoryStatus) -> Result<(), String> { self.write("final.json", &FinalCheckpoint { status }) }
}

fn read_entry(directory: &Path, plan: HistoryPlan) -> Result<HistoryEntry, String> {
    directory_chain(directory)?;
    let mut items = Vec::with_capacity(plan.items.len());
    let mut incomplete = false;
    for (index, item) in plan.items.into_iter().enumerate() {
        let mut checkpoint = ItemCheckpoint { status: HistoryItemStatus::Pending, reclaimed_bytes: 0, message: None };
        for phase in ["processing", "linked", "result"] {
            let path = directory.join(checkpoint_name(index, phase));
            if fs::symlink_metadata(&path).is_ok() {
                // 半写入阶段不作为成功证据；保留上一份已持久阶段，整批显示为中断。
                match read_json::<ItemCheckpoint>(&path, MAX_EVENT_BYTES) {
                    Ok(next) if (phase == "result" && matches!(next.status, HistoryItemStatus::Completed | HistoryItemStatus::Failed | HistoryItemStatus::NeedsRecovery)
                        || phase != "result" && next.status == HistoryItemStatus::Processing && next.reclaimed_bytes == 0)
                        && next.message.as_ref().is_none_or(|message| message.len() <= 8_192 && !message.contains('\0')) => checkpoint = next,
                    _ => incomplete = true,
                }
            }
        }
        if checkpoint.reclaimed_bytes > item.size { return Err("模型去重历史释放量无效".into()); }
        items.push(HistoryItem { plan: item, status: checkpoint.status, reclaimed_bytes: checkpoint.reclaimed_bytes, message: checkpoint.message });
    }
    let completed = items.iter().filter(|item| matches!(item.status, HistoryItemStatus::Completed | HistoryItemStatus::NeedsRecovery)).count();
    let failed = items.iter().filter(|item| item.status == HistoryItemStatus::Failed).count();
    let unprocessed = items.len() - completed - failed;
    let reclaimed_bytes = items.iter().map(|item| item.reclaimed_bytes).sum();
    let final_status = read_json::<FinalCheckpoint>(&directory.join("final.json"), MAX_EVENT_BYTES)
        .map(|checkpoint| checkpoint.status).unwrap_or(HistoryStatus::Interrupted);
    // 最终文件不能将缺失/损坏的逐项结果变成成功证据。
    let status = if incomplete || final_status == HistoryStatus::Completed
        && (failed != 0 || unprocessed != 0 || items.iter().any(|item| item.status != HistoryItemStatus::Completed)) {
        HistoryStatus::Interrupted
    } else { final_status };
    Ok(HistoryEntry { id: plan.id, created_at: plan.created_at, scope: plan.scope, root_label: plan.root_label, status,
        completed, failed, unprocessed, reclaimed_bytes, items })
}

#[tauri::command]
pub async fn list_comfyui_model_dedupe_history(webview: Webview, app: tauri::AppHandle) -> Result<HistoryList, String> {
    let _guard = management::lock_operations().await;
    management::management_root(&webview, &app)?;
    let session_id = management::management_session_id(&app)?;
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let Some(directory) = history_directory(&worker_app, false)? else { return Ok(HistoryList { entries: Vec::new(), warnings: Vec::new() }); };
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        for (directory, plan) in stored_directories(&directory)?.into_iter().take(MAX_HISTORY) {
            let Some(plan) = plan else {
                warnings.push("一条去重计划写入不完整，未作为替换成功证据；其他历史仍可查看。".into());
                continue;
            };
            match read_entry(&directory, plan) {
                Ok(entry) => entries.push(entry),
                Err(_) => warnings.push("一条模型去重历史损坏，未作为替换成功证据；请结合中断恢复记录核对。".into()),
            }
        }
        Ok::<_, String>(HistoryList { entries, warnings })
    }).await.map_err(|_| "读取模型去重历史失败".to_string())??;
    management::management_root(&webview, &app)?;
    if management::management_session_id(&app)? != session_id { return Err("管理会话已变化，请刷新替换历史".into()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_plan_rejects_absolute_and_parent_paths() {
        assert!(valid_relative("models/renamed-model.safetensors"));
        assert!(!valid_relative("../outside/model.bin"));
        assert!(!valid_relative("/absolute/model.bin"));
        #[cfg(windows)]
        assert!(!valid_relative(r"F:\models\model.bin"));
    }

    #[test]
    fn folder_root_label_keeps_only_name() {
        let root = Path::new("parent").join("private-user-folder").join("models");
        assert_eq!(root_label(&root), "models");
    }

    #[test]
    fn immutable_checkpoint_never_overwrites_existing_record() {
        let directory = std::env::temp_dir().join(model_dedupe::opaque_id("history-test"));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("checkpoint.json");
        write_json(&path, &FinalCheckpoint { status: HistoryStatus::Failed }, MAX_EVENT_BYTES).unwrap();
        assert!(write_json(&path, &FinalCheckpoint { status: HistoryStatus::Completed }, MAX_EVENT_BYTES).is_err());
        assert!(matches!(read_json::<FinalCheckpoint>(&path, MAX_EVENT_BYTES).unwrap().status, HistoryStatus::Failed));
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    fn fixture_plan() -> HistoryPlan {
        HistoryPlan { schema_version: 1, id: model_dedupe::opaque_id("history"), created_at: 1,
            scope: model_dedupe::ModelScanScope::Folder, root_label: "models".into(), items: vec![HistoryItemPlan {
                keeper_relative_path: "weights/original.safetensors".into(), target_relative_path: "plugin/renamed.pth".into(),
                hash: "a".repeat(64), link_type: LinkType::Hardlink, size: 100,
            }] }
    }

    #[test]
    fn final_success_cannot_hide_missing_item_result() {
        let plan = fixture_plan();
        let directory = std::env::temp_dir().join(&plan.id);
        fs::create_dir(&directory).unwrap();
        write_json(&directory.join("final.json"), &FinalCheckpoint { status: HistoryStatus::Completed }, MAX_EVENT_BYTES).unwrap();
        let entry = read_entry(&directory, plan).unwrap();
        assert!(matches!(entry.status, HistoryStatus::Interrupted));
        assert_eq!(entry.unprocessed, 1);
        assert_eq!(entry.completed, 0);
        fs::remove_file(directory.join("final.json")).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn processing_checkpoint_is_not_success_after_interruption() {
        let plan = fixture_plan();
        let directory = std::env::temp_dir().join(&plan.id);
        fs::create_dir(&directory).unwrap();
        let checkpoint = checkpoint_name(0, "processing");
        write_json(&directory.join(&checkpoint), &ItemCheckpoint { status: HistoryItemStatus::Processing, reclaimed_bytes: 0, message: None }, MAX_EVENT_BYTES).unwrap();
        let entry = read_entry(&directory, plan).unwrap();
        assert!(matches!(entry.status, HistoryStatus::Interrupted));
        assert!(matches!(entry.items[0].status, HistoryItemStatus::Processing));
        assert_eq!(entry.reclaimed_bytes, 0);
        fs::remove_file(directory.join(checkpoint)).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
