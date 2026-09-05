//! 项目整体导出 / 导入所用的 tar.gz 归档打包与解包。
//!
//! 归档内的文本条目（清单、项目记录、对话记录）由前端组装后原样写入，
//! 素材文件统一放在 `assets/` 前缀下，与项目数据目录一一对应。
//! 解包只把 `assets/` 下的内容落到调用方指定的目标目录，其余条目按文本返回，
//! 由前端决定如何写入 IndexedDB。

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tar::{Archive, Builder, Header};
use tauri::{AppHandle, Runtime, Webview};

use crate::path_policy::{authorize_path, ensure_trusted_caller, PathAccess};

/// 归档内素材统一前缀；解包时只有该前缀下的条目会写入项目数据目录。
const ASSETS_PREFIX: &str = "assets";
/// 项目回收站是本地撤销缓存，不随项目导出。
const EXCLUDED_DIR_NAMES: [&str; 1] = [".trash"];
const MAX_ARCHIVE_ENTRIES: usize = 200_000;
const MAX_EXPANDED_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// 文本条目（项目 JSON、对话 JSON）解包时的总量上限，避免异常归档撑爆内存。
const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Deserialize)]
pub struct ProjectArchiveTextEntry {
    /// 归档内相对路径，例如 `manifest.json`
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchivePackResult {
    asset_count: usize,
    asset_bytes: u64,
    archive_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveUnpackResult {
    /// 归档内非 `assets/` 条目的原文，键为归档内相对路径。
    texts: HashMap<String, String>,
    /// 已写入目标目录的素材相对路径（正斜杠分隔）。
    asset_paths: Vec<String>,
    asset_bytes: u64,
}

/// 校验归档内相对路径：拒绝绝对路径、`..`、盘符和反斜杠，避免解包写到目标目录之外。
fn normalize_archive_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    if text.contains('\\') {
        return Err(format!("项目归档包含不安全路径: {text}"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("项目归档包含不安全路径: {text}"));
            }
        }
    }
    Ok(normalized)
}

fn to_archive_text(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

struct AssetStats {
    count: usize,
    bytes: u64,
}

/// 递归打包项目数据目录。符号链接既不是文件也不是目录，会被跳过，
/// 避免把项目目录之外的内容打进归档。
fn append_assets_dir<W: Write>(
    builder: &mut Builder<W>,
    source: &Path,
    archive_dir: &Path,
    stats: &mut AssetStats,
) -> Result<(), String> {
    let read_dir =
        fs::read_dir(source).map_err(|error| format!("读取项目素材目录失败: {error}"))?;
    for item in read_dir {
        let entry = item.map_err(|error| format!("读取项目素材目录项失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取项目素材类型失败: {error}"))?;
        let name = entry.file_name();
        let archive_path = archive_dir.join(&name);

        if file_type.is_dir() {
            if EXCLUDED_DIR_NAMES.contains(&name.to_string_lossy().as_ref()) {
                continue;
            }
            append_assets_dir(builder, &entry.path(), &archive_path, stats)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        stats.count += 1;
        if stats.count > MAX_ARCHIVE_ENTRIES {
            return Err("项目素材文件数量超过导出上限".to_string());
        }
        let path = entry.path();
        let mut file =
            File::open(&path).map_err(|error| format!("打开项目素材失败: {error}"))?;
        let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        stats.bytes = stats.bytes.saturating_add(size);
        if stats.bytes > MAX_EXPANDED_BYTES {
            return Err("项目素材总体积超过 20 GB 导出上限".to_string());
        }
        builder
            .append_file(&archive_path, &mut file)
            .map_err(|error| format!("写入项目素材失败: {error}"))?;
    }
    Ok(())
}

/// 把项目文本记录与素材目录打包为单个 tar.gz 归档。
#[tauri::command]
pub fn pack_project_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    entries: Vec<ProjectArchiveTextEntry>,
    assets_dir: Option<String>,
    output_path: String,
) -> Result<ProjectArchivePackResult, String> {
    ensure_trusted_caller(&webview)?;
    let output = authorize_path(&app, &output_path, PathAccess::Write)?;
    let assets_root = match assets_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => Some(authorize_path(&app, raw, PathAccess::Read)?),
        None => None,
    };

    let file = File::create(&output).map_err(|error| format!("创建导出文件失败: {error}"))?;
    let encoder = GzEncoder::new(BufWriter::new(file), Compression::default());
    let mut builder = Builder::new(encoder);
    let mtime = unix_now();

    for entry in &entries {
        let relative = normalize_archive_path(Path::new(&entry.path))?;
        if relative.as_os_str().is_empty() {
            return Err("项目归档条目路径为空".to_string());
        }
        let bytes = entry.content.as_bytes();
        let mut header = Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(mtime);
        builder
            .append_data(&mut header, &relative, bytes)
            .map_err(|error| format!("写入项目记录失败: {error}"))?;
    }

    let mut stats = AssetStats { count: 0, bytes: 0 };
    if let Some(root) = &assets_root {
        append_assets_dir(&mut builder, root, Path::new(ASSETS_PREFIX), &mut stats)?;
    }

    let encoder = builder
        .into_inner()
        .map_err(|error| format!("完成项目归档失败: {error}"))?;
    let mut writer = encoder
        .finish()
        .map_err(|error| format!("压缩项目归档失败: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("写入项目归档失败: {error}"))?;
    drop(writer);

    let archive_bytes = fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    Ok(ProjectArchivePackResult {
        asset_count: stats.count,
        asset_bytes: stats.bytes,
        archive_bytes,
    })
}

/// 解包项目归档：`assets/` 下的素材写入 `assets_dir`，其余条目按文本返回。
#[tauri::command]
pub fn unpack_project_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    archive_path: String,
    assets_dir: String,
) -> Result<ProjectArchiveUnpackResult, String> {
    ensure_trusted_caller(&webview)?;
    let archive_file = authorize_path(&app, &archive_path, PathAccess::Read)?;
    let target_dir = authorize_path(&app, &assets_dir, PathAccess::Write)?;
    if !target_dir.is_dir() {
        return Err("导入目标目录不存在".to_string());
    }

    let file =
        File::open(&archive_file).map_err(|error| format!("打开项目归档失败: {error}"))?;
    let decoder = GzDecoder::new(BufReader::new(file));
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("读取项目归档失败: {error}"))?;

    let mut texts: HashMap<String, String> = HashMap::new();
    let mut asset_paths: Vec<String> = Vec::new();
    let mut entry_count = 0_usize;
    let mut asset_bytes = 0_u64;
    let mut text_bytes = 0_u64;

    for item in entries {
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err("项目归档文件数量超过限制".to_string());
        }
        let mut entry = item.map_err(|error| format!("读取项目归档项失败: {error}"))?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("项目归档包含不允许的链接或设备文件".to_string());
        }
        let raw_path = entry
            .path()
            .map_err(|error| format!("读取项目归档路径失败: {error}"))?
            .into_owned();
        let relative = normalize_archive_path(&raw_path)?;
        if relative.as_os_str().is_empty() {
            continue;
        }

        let mut components = relative.components();
        let is_asset = matches!(components.next(), Some(Component::Normal(first)) if first == ASSETS_PREFIX);
        if !is_asset {
            if entry_type.is_dir() {
                continue;
            }
            let size = entry.header().size().unwrap_or(0);
            text_bytes = text_bytes.saturating_add(size);
            if text_bytes > MAX_TEXT_BYTES {
                return Err("项目归档中的记录数据超过 512 MB 限制".to_string());
            }
            let mut content = String::new();
            entry
                .read_to_string(&mut content)
                .map_err(|error| format!("读取项目记录失败: {error}"))?;
            texts.insert(to_archive_text(&relative), content);
            continue;
        }

        let inner: PathBuf = components.collect();
        if inner.as_os_str().is_empty() {
            continue;
        }
        let destination = target_dir.join(&inner);
        if entry_type.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("创建素材目录失败: {error}"))?;
            continue;
        }

        asset_bytes = asset_bytes.saturating_add(entry.header().size().unwrap_or(0));
        if asset_bytes > MAX_EXPANDED_BYTES {
            return Err("项目归档展开后超过 20 GB 限制".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("解压项目素材失败: {error}"))?;
        asset_paths.push(to_archive_text(&inner));
    }

    Ok(ProjectArchiveUnpackResult {
        texts,
        asset_paths,
        asset_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_escaping_the_archive_root() {
        assert!(normalize_archive_path(Path::new("../secret.json")).is_err());
        assert!(normalize_archive_path(Path::new("/etc/passwd")).is_err());
        assert!(normalize_archive_path(Path::new("assets\\a.png")).is_err());
    }

    #[test]
    fn keeps_normal_relative_paths() {
        let normalized =
            normalize_archive_path(Path::new("./assets/分组/a.png")).expect("路径可归一化");
        assert_eq!(to_archive_text(&normalized), "assets/分组/a.png");
    }
}
