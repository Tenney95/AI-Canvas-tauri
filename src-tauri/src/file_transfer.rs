use reqwest::blocking::Response;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};

const BUFFER_SIZE: usize = 1024 * 1024;
const MIN_FREE_SPACE_RESERVE: u64 = 64 * 1024 * 1024;
const PROGRESS_EVENT: &str = "file-transfer-progress";

static CANCELLED_TRANSFERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_transfers() -> &'static Mutex<HashSet<String>> {
    CANCELLED_TRANSFERS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTransferProgress {
    task_id: String,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferResult {
    path: String,
    total_bytes: u64,
    content_type: Option<String>,
}

fn is_cancelled(task_id: &str) -> Result<bool, String> {
    cancelled_transfers()
        .lock()
        .map(|items| items.contains(task_id))
        .map_err(|_| "读取文件传输取消状态失败".to_string())
}

fn clear_cancelled(task_id: &str) {
    if let Ok(mut items) = cancelled_transfers().lock() {
        items.remove(task_id);
    }
}

fn required_free_space(total_bytes: u64) -> u64 {
    total_bytes.saturating_add((total_bytes / 20).max(MIN_FREE_SPACE_RESERVE))
}

fn ensure_disk_space(parent: &Path, total_bytes: Option<u64>) -> Result<(), String> {
    let available =
        fs2::available_space(parent).map_err(|e| format!("无法读取目标磁盘可用空间: {e}"))?;
    let required = total_bytes
        .map(required_free_space)
        .unwrap_or(MIN_FREE_SPACE_RESERVE);
    if available < required {
        return Err(format!(
            "目标磁盘空间不足，需要至少 {required} 字节，当前可用 {available} 字节"
        ));
    }
    Ok(())
}

fn temporary_path(destination: &Path, task_id: &str) -> Result<PathBuf, String> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "目标文件名无效".to_string())?;
    Ok(destination.with_file_name(format!(".{file_name}.{task_id}.part")))
}

fn stream_to_file<R: Read>(
    app: &AppHandle,
    task_id: &str,
    reader: &mut R,
    destination: &Path,
    total_bytes: Option<u64>,
) -> Result<u64, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "目标文件没有父目录".to_string())?;
    ensure_disk_space(parent, total_bytes)?;

    let temp_path = temporary_path(destination, task_id)?;
    let transfer_result = (|| {
        let mut output = File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut buffer = vec![0_u8; BUFFER_SIZE];
        let mut transferred_bytes = 0_u64;

        loop {
            if is_cancelled(task_id)? {
                return Err("文件传输已取消".to_string());
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|e| format!("读取传输数据失败: {e}"))?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|e| format!("写入目标文件失败: {e}"))?;
            transferred_bytes = transferred_bytes.saturating_add(read as u64);
            let _ = app.emit(
                PROGRESS_EVENT,
                FileTransferProgress {
                    task_id: task_id.to_string(),
                    transferred_bytes,
                    total_bytes,
                },
            );
        }

        output
            .sync_all()
            .map_err(|e| format!("同步目标文件失败: {e}"))?;
        drop(output);
        fs::rename(&temp_path, destination).map_err(|e| format!("完成目标文件写入失败: {e}"))?;
        Ok(transferred_bytes)
    })();

    if transfer_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    transfer_result
}

#[tauri::command]
pub async fn copy_file_streamed(
    app: AppHandle,
    task_id: String,
    source_path: String,
    destination_path: String,
) -> Result<FileTransferResult, String> {
    let task_id_for_worker = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(source_path);
        let destination = PathBuf::from(destination_path);
        let total_bytes = fs::metadata(&source)
            .map_err(|e| format!("读取源文件信息失败: {e}"))?
            .len();
        let mut input = File::open(&source).map_err(|e| format!("打开源文件失败: {e}"))?;
        let transferred = stream_to_file(
            &app,
            &task_id_for_worker,
            &mut input,
            &destination,
            Some(total_bytes),
        )?;
        Ok(FileTransferResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: transferred,
            content_type: None,
        })
    })
    .await
    .map_err(|e| format!("文件复制任务执行失败: {e}"))?;
    clear_cancelled(&task_id);
    result
}

#[tauri::command]
pub async fn download_file_streamed(
    app: AppHandle,
    task_id: String,
    url: String,
    destination_path: String,
) -> Result<FileTransferResult, String> {
    let task_id_for_worker = task_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent("AI-Canvas/0.4")
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
        let mut response: Response = client
            .get(&url)
            .send()
            .map_err(|e| format!("下载请求失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("下载请求失败: HTTP {}", response.status()));
        }
        let total_bytes = response.content_length();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .map(str::to_string);
        let destination = PathBuf::from(destination_path);
        let transferred = stream_to_file(
            &app,
            &task_id_for_worker,
            &mut response,
            &destination,
            total_bytes,
        )?;
        Ok(FileTransferResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: transferred,
            content_type,
        })
    })
    .await
    .map_err(|e| format!("文件下载任务执行失败: {e}"))?;
    clear_cancelled(&task_id);
    result
}

#[tauri::command]
pub fn cancel_file_transfer(task_id: String) -> Result<(), String> {
    cancelled_transfers()
        .lock()
        .map_err(|_| "更新文件传输取消状态失败".to_string())?
        .insert(task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_at_least_sixty_four_megabytes() {
        assert_eq!(required_free_space(100), 100 + MIN_FREE_SPACE_RESERVE);
    }

    #[test]
    fn reserves_five_percent_for_large_files() {
        let size = 2 * 1024 * 1024 * 1024_u64;
        assert_eq!(required_free_space(size), size + size / 20);
    }
}
