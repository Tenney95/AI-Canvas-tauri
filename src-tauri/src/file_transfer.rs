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
    pub(crate) path: String,
    pub(crate) total_bytes: u64,
    pub(crate) content_type: Option<String>,
}

pub(crate) struct DownloadMetadata {
    pub(crate) content_length: Option<u64>,
    pub(crate) content_type: Option<String>,
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

fn validate_transfer_size(
    transferred_bytes: u64,
    expected_bytes: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    if let Some(max_bytes) = max_bytes {
        if transferred_bytes > max_bytes {
            return Err(format!("下载文件超过允许的体积上限 {max_bytes} 字节"));
        }
    }
    if let Some(expected_bytes) = expected_bytes {
        if transferred_bytes != expected_bytes {
            return Err(format!(
                "下载不完整: 期望 {expected_bytes} 字节，实际 {transferred_bytes} 字节"
            ));
        }
    }
    Ok(())
}

fn stream_to_file<R, C, P, V>(
    task_id: &str,
    reader: &mut R,
    destination: &Path,
    expected_bytes: Option<u64>,
    disk_space_bytes: Option<u64>,
    max_bytes: Option<u64>,
    mut cancelled: C,
    mut on_progress: P,
    validate_temp: V,
) -> Result<u64, String>
where
    R: Read,
    C: FnMut() -> Result<bool, String>,
    P: FnMut(u64),
    V: FnOnce(&Path) -> Result<(), String>,
{
    let parent = destination
        .parent()
        .ok_or_else(|| "目标文件没有父目录".to_string())?;
    ensure_disk_space(parent, disk_space_bytes)?;

    let temp_path = temporary_path(destination, task_id)?;
    let transfer_result = (|| {
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        let mut output = File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut buffer = vec![0_u8; BUFFER_SIZE];
        let mut transferred_bytes = 0_u64;

        loop {
            if cancelled()? {
                return Err("文件传输已取消".to_string());
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|e| format!("读取传输数据失败: {e}"))?;
            if read == 0 {
                break;
            }
            let next_total = transferred_bytes.saturating_add(read as u64);
            validate_transfer_size(next_total, None, max_bytes)?;
            output
                .write_all(&buffer[..read])
                .map_err(|e| format!("写入目标文件失败: {e}"))?;
            transferred_bytes = next_total;
            on_progress(transferred_bytes);
        }

        validate_transfer_size(transferred_bytes, expected_bytes, max_bytes)?;
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        output
            .sync_all()
            .map_err(|e| format!("同步目标文件失败: {e}"))?;
        drop(output);
        validate_temp(&temp_path)?;
        if cancelled()? {
            return Err("文件传输已取消".to_string());
        }
        fs::rename(&temp_path, destination).map_err(|e| format!("完成目标文件写入失败: {e}"))?;
        Ok(transferred_bytes)
    })();

    if transfer_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    transfer_result
}

pub(crate) fn download_to_file<V>(
    app: &AppHandle,
    task_id: &str,
    url: &str,
    destination: &Path,
    max_bytes: Option<u64>,
    validate_temp: V,
) -> Result<FileTransferResult, String>
where
    V: FnOnce(&Path, &DownloadMetadata) -> Result<(), String>,
{
    let result = (|| {
        if is_cancelled(task_id)? {
            return Err("文件传输已取消".to_string());
        }
        let client = reqwest::blocking::Client::builder()
            .user_agent("AI-Canvas/0.4")
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
        let mut response: Response = client
            .get(url)
            .send()
            .map_err(|e| format!("下载请求失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("下载请求失败: HTTP {}", response.status()));
        }

        let metadata = DownloadMetadata {
            content_length: response.content_length(),
            content_type: response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(str::trim)
                .map(str::to_string),
        };
        if let (Some(content_length), Some(max_bytes)) = (metadata.content_length, max_bytes) {
            validate_transfer_size(content_length, None, Some(max_bytes))?;
        }

        let disk_space_bytes = metadata.content_length.or(max_bytes);
        let transferred = stream_to_file(
            task_id,
            &mut response,
            destination,
            metadata.content_length,
            disk_space_bytes,
            max_bytes,
            || is_cancelled(task_id),
            |transferred_bytes| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: task_id.to_string(),
                        transferred_bytes,
                        total_bytes: metadata.content_length,
                    },
                );
            },
            |temp_path| validate_temp(temp_path, &metadata),
        )?;

        Ok(FileTransferResult {
            path: destination.to_string_lossy().into_owned(),
            total_bytes: transferred,
            content_type: metadata.content_type,
        })
    })();
    clear_cancelled(task_id);
    result
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
            &task_id_for_worker,
            &mut input,
            &destination,
            Some(total_bytes),
            Some(total_bytes),
            None,
            || is_cancelled(&task_id_for_worker),
            |transferred_bytes| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    FileTransferProgress {
                        task_id: task_id_for_worker.clone(),
                        transferred_bytes,
                        total_bytes: Some(total_bytes),
                    },
                );
            },
            |_| Ok(()),
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
        let destination = PathBuf::from(destination_path);
        download_to_file(
            &app,
            &task_id_for_worker,
            &url,
            &destination,
            None,
            |_, _| Ok(()),
        )
    })
    .await
    .map_err(|e| format!("文件下载任务执行失败: {e}"))?;
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
    use std::io::Cursor;

    struct GeneratedReader {
        remaining: u64,
    }

    impl Read for GeneratedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.remaining.min(buffer.len() as u64) as usize;
            buffer[..read].fill(0x5a);
            self.remaining -= read as u64;
            Ok(read)
        }
    }

    fn test_directory(name: &str) -> PathBuf {
        let unique = format!(
            "ai-canvas-file-transfer-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时间应晚于 UNIX epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        fs::create_dir_all(&directory).expect("应创建测试目录");
        directory
    }

    fn part_path(destination: &Path, task_id: &str) -> PathBuf {
        temporary_path(destination, task_id).expect("应生成临时路径")
    }

    #[test]
    fn reserves_at_least_sixty_four_megabytes() {
        assert_eq!(required_free_space(100), 100 + MIN_FREE_SPACE_RESERVE);
    }

    #[test]
    fn reserves_five_percent_for_large_files() {
        let size = 2 * 1024 * 1024 * 1024_u64;
        assert_eq!(required_free_space(size), size + size / 20);
    }

    #[test]
    fn streams_then_atomically_promotes_complete_file() {
        let directory = test_directory("complete");
        let destination = directory.join("model.onnx");
        let task_id = "complete-task";
        let bytes = vec![7_u8; BUFFER_SIZE + 17];
        let mut reader = Cursor::new(bytes.clone());

        let transferred = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            Some(bytes.len() as u64),
            Some(bytes.len() as u64),
            Some((bytes.len() + 1) as u64),
            || Ok(false),
            |_| {},
            |_| Ok(()),
        )
        .expect("完整传输应成功");

        assert_eq!(transferred, bytes.len() as u64);
        assert_eq!(fs::read(&destination).expect("应读取正式文件"), bytes);
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn removes_part_when_actual_length_differs() {
        let directory = test_directory("length-mismatch");
        let destination = directory.join("model.onnx");
        let task_id = "length-task";
        let mut reader = Cursor::new(vec![1_u8; 32]);

        let result = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            Some(64),
            Some(64),
            None,
            || Ok(false),
            |_| {},
            |_| Ok(()),
        );

        assert!(result.expect_err("长度不符应失败").contains("下载不完整"));
        assert!(!destination.exists());
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn removes_part_when_transfer_exceeds_limit() {
        let directory = test_directory("too-large");
        let destination = directory.join("model.onnx");
        let task_id = "limit-task";
        let mut reader = Cursor::new(vec![2_u8; 65]);

        let result = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            None,
            Some(64),
            Some(64),
            || Ok(false),
            |_| {},
            |_| Ok(()),
        );

        assert!(result.expect_err("超过上限应失败").contains("体积上限"));
        assert!(!destination.exists());
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    fn removes_part_when_cancelled_mid_transfer() {
        let directory = test_directory("cancelled");
        let destination = directory.join("model.onnx");
        let task_id = "cancel-task";
        let mut reader = Cursor::new(vec![3_u8; BUFFER_SIZE * 2]);
        let mut checks = 0_u8;

        let result = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            None,
            Some((BUFFER_SIZE * 2) as u64),
            None,
            || {
                checks += 1;
                Ok(checks >= 3)
            },
            |_| {},
            |_| Ok(()),
        );

        assert!(result.expect_err("取消应失败").contains("已取消"));
        assert!(!destination.exists());
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    #[test]
    #[ignore = "176 MiB 磁盘与内存压力验收"]
    fn streams_176_mib_without_allocating_the_model_in_memory() {
        let directory = test_directory("176-mib");
        let destination = directory.join("model.onnx");
        let task_id = "memory-task";
        let total_bytes = 176 * 1024 * 1024_u64;
        let mut reader = GeneratedReader {
            remaining: total_bytes,
        };

        let transferred = stream_to_file(
            task_id,
            &mut reader,
            &destination,
            Some(total_bytes),
            Some(total_bytes),
            Some(total_bytes),
            || Ok(false),
            |_| {},
            |_| Ok(()),
        )
        .expect("176 MiB 流式传输应成功");

        assert_eq!(transferred, total_bytes);
        assert_eq!(
            fs::metadata(&destination).expect("应读取正式文件").len(),
            total_bytes
        );
        assert!(!part_path(&destination, task_id).exists());
        fs::remove_dir_all(directory).expect("应清理测试目录");
    }
}
