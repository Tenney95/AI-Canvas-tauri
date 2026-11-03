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
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tar::{Archive, Builder, Header};
use tauri::{AppHandle, Emitter, Runtime, Webview};
use sha2::{Digest, Sha256};

use crate::path_policy::{authorize_path, ensure_trusted_caller, reauthorize_existing_plain_directory, PathAccess};

/// 归档内素材统一前缀；解包时只有该前缀下的条目会写入项目数据目录。
const ASSETS_PREFIX: &str = "assets";
/// 项目回收站是本地撤销缓存，不随项目导出。
const EXCLUDED_DIR_NAMES: [&str; 1] = [".trash"];
const MAX_ARCHIVE_ENTRIES: usize = 200_000;
const MAX_EXPANDED_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// 文本条目（项目 JSON、对话 JSON）解包时的总量上限，避免异常归档撑爆内存。
const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXTENSION_BYTES: u64 = 64 * 1024;

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
    assets: Vec<ArchiveAssetDigest>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveAssetDigest { path: String, bytes: u64, sha256: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectImportAsset { path: String, destination_path: String, bytes: u64, sha256: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress { task_id: String, transferred_bytes: u64, total_bytes: u64 }

/// 后台任务排队期间目录可能变化，开始读写前复核入口捕获的真实路径。
fn reauthorize_archive_path<R: Runtime>(app: &AppHandle<R>, path: &Path, access: PathAccess) -> Result<(), String> {
    if authorize_path(app, &path.to_string_lossy(), access)? != path {
        return Err("项目归档路径已变化，请重新操作".into());
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|_| "无法读取项目素材")?;
    let mut digest = Sha256::new(); let mut bytes = 0_u64; let mut buffer = vec![0_u8; 1024 * 1024];
    loop { let count = file.read(&mut buffer).map_err(|_| "读取素材失败")?; if count == 0 { break; }
        digest.update(&buffer[..count]); bytes += count as u64;
        if bytes > MAX_EXPANDED_BYTES { return Err("素材超过体积限制".into()); }
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn inspect_assets(root: &Path, relative: &Path, rows: &mut Vec<ArchiveAssetDigest>) -> Result<(), String> {
    if relative.components().count() > 64 { return Err("项目素材目录过深".into()); }
    for item in fs::read_dir(root.join(relative)).map_err(|_| "无法读取项目目录")? {
        let entry = item.map_err(|_| "无法读取素材目录项")?;
        let kind = entry.file_type().map_err(|_| "无法读取素材类型")?;
        let name = entry.file_name(); let child = relative.join(&name);
        if kind.is_symlink() { return Err("项目素材包含链接，请先移入普通文件".into()); }
        if kind.is_dir() {
            if EXCLUDED_DIR_NAMES.contains(&name.to_string_lossy().as_ref()) || (relative.as_os_str().is_empty() && name == ".thumbnail") { continue; }
            inspect_assets(root, &child, rows)?;
        } else if kind.is_file() {
            if rows.len() >= MAX_ARCHIVE_ENTRIES { return Err("项目素材数量超过上限".into()); }
            let (bytes, sha256) = hash_file(&entry.path())?;
            // 本机递归路径使用平台分隔符，进入归档校验前统一为正斜杠。
            let archive_path = child.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
            rows.push(ArchiveAssetDigest { path: to_archive_text(&normalize_archive_path(Path::new(&archive_path))?), bytes, sha256 });
        } else { return Err("不支持的素材类型".into()); }
    }
    if rows.iter().map(|row| row.bytes).sum::<u64>() > MAX_EXPANDED_BYTES { return Err("项目素材超过 20 GB".into()); }
    Ok(())
}

#[tauri::command]
pub async fn inspect_project_archive_assets<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, assets_dir: String) -> Result<Vec<ArchiveAssetDigest>, String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" { return Err("仅主窗口可以准备项目归档".into()); }
    let root = authorize_path(&app, &assets_dir, PathAccess::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        reauthorize_archive_path(&app, &root, PathAccess::Read)?;
        let mut rows = Vec::new(); inspect_assets(&root, Path::new(""), &mut rows)?;
        rows.sort_by(|a, b| a.path.cmp(&b.path)); Ok(rows)
    }).await.map_err(|_| "项目素材扫描任务失败".to_string())?
}

/// 授权回调仍使用宿主路径策略；目录按层创建，不能依赖尚不存在的直接父目录。
fn create_import_destination(
    root: &Path,
    operation_id: &str,
    authorize: impl Fn(&Path, bool) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let imports = root.join("imports");
    if authorize(&imports, false)? != imports {
        return Err("导入父目录不能指向项目外或其他目录".into());
    }
    match fs::create_dir(&imports) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(_) => return Err("无法创建导入父目录".into()),
    }
    if authorize(&imports, true)? != imports {
        return Err("导入父目录真实路径已变化，请重新预览".into());
    }
    let destination = imports.join(operation_id);
    if authorize(&destination, false)? != destination {
        return Err("导入目录真实路径已变化，请重新预览".into());
    }
    fs::create_dir(&destination).map_err(|_| "导入目录已存在或无法创建，请重新预览")?;
    Ok(destination)
}

/// 只向全新子目录发布；逐文件复核已预览的字节，不覆盖目标的任何已有素材。
#[tauri::command]
pub async fn publish_project_import_assets<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, staging_dir: String,
    project_dir: String, operation_id: String, assets: Vec<ProjectImportAsset>) -> Result<(), String> {
    ensure_trusted_caller(&webview)?;
    if webview.label() != "main" || operation_id.len() > 128 || operation_id.is_empty()
        || !operation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("导入操作身份无效".into()); }
    let staging = authorize_path(&app, &staging_dir, PathAccess::Read)?;
    let root = authorize_path(&app, &project_dir, PathAccess::Write)?;
    let cancellation_id = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        reauthorize_archive_path(&app, &staging, PathAccess::Read)?;
        reauthorize_archive_path(&app, &root, PathAccess::Write)?;
        let total_bytes = assets.iter().try_fold(0_u64, |total, asset| total.checked_add(asset.bytes)).ok_or("素材体积无效")?;
        if assets.len() > MAX_ARCHIVE_ENTRIES || total_bytes > MAX_EXPANDED_BYTES { return Err("导入素材超过上限".into()); }
        crate::file_transfer::ensure_disk_space(&root, Some(total_bytes))?;
        if crate::file_transfer::is_cancelled(&operation_id)? { return Err("项目导入已取消".into()); }
        let destination = create_import_destination(&root, &operation_id, |path, existing_plain| {
            if existing_plain { reauthorize_existing_plain_directory(&app, path) }
            else { authorize_path(&app, &path.to_string_lossy(), PathAccess::Write) }
        })?;
        let mut seen = HashSet::new(); let mut total = 0_u64; let mut transferred = 0_u64;
        let result = (|| {
            for asset in assets {
                if crate::file_transfer::is_cancelled(&operation_id)? { return Err("项目导入已取消".into()); }
                let relative = normalize_archive_path(Path::new(&asset.path))?;
                let published = normalize_archive_path(Path::new(&asset.destination_path))?;
                if !seen.insert(to_archive_text(&published).to_lowercase()) || relative.as_os_str().is_empty() || published.as_os_str().is_empty() { return Err("导入素材路径重复".into()); }
                total = total.saturating_add(asset.bytes);
                if seen.len() > MAX_ARCHIVE_ENTRIES || total > MAX_EXPANDED_BYTES { return Err("导入素材超过上限".into()); }
                let source = authorize_path(&app, &staging.join(&relative).to_string_lossy(), PathAccess::Read)?;
                if !source.starts_with(&staging) { return Err("素材不在本次暂存目录内".into()); }
                let target = destination.join(&published);
                fs::create_dir_all(target.parent().ok_or("素材目录无效")?).map_err(|_| "无法创建素材目录")?;
                let mut input = File::open(&source).map_err(|_| "无法打开暂存素材")?;
                let mut output = fs::OpenOptions::new().create_new(true).write(true).open(&target).map_err(|_| "无法创建目标素材")?;
                let mut buffer = vec![0; 1024 * 1024]; let mut bytes = 0_u64; let mut digest = Sha256::new();
                loop {
                    if crate::file_transfer::is_cancelled(&operation_id)? { return Err("项目导入已取消".into()); }
                    let count = input.read(&mut buffer).map_err(|_| "素材发布读取失败")?; if count == 0 { break; }
                    bytes += count as u64;
                    if bytes > asset.bytes { return Err("暂存素材大小已变化".into()); }
                    output.write_all(&buffer[..count]).map_err(|_| "素材写入失败，原项目未改变")?; digest.update(&buffer[..count]);
                    transferred += count as u64;
                    let _ = app.emit_to("main", "file-transfer-progress", ImportProgress { task_id: operation_id.clone(), transferred_bytes: transferred, total_bytes });
                }
                output.sync_all().map_err(|_| "素材落盘失败")?; drop(output);
                let sha256 = format!("{:x}", digest.finalize());
                if bytes != asset.bytes || sha256 != asset.sha256 { return Err("素材内容已变化，请重新导入".into()); }
            }
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_dir_all(&destination); }
        result
    }).await.map_err(|_| "项目素材发布任务失败".to_string());
    crate::file_transfer::clear_cancelled(&cancellation_id);
    result?
}

/// 校验归档内相对路径：拒绝绝对路径、`..`、盘符和反斜杠，避免解包写到目标目录之外。
fn normalize_archive_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    if text.len() > 1024 || path.components().count() > 64
        || text.contains('\\') || text.contains(':') || text.chars().any(|c| c.is_control()) {
        return Err(format!("项目归档包含不安全路径: {text}"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => {
                let part = value.to_string_lossy();
                let stem = part.split('.').next().unwrap_or("").to_uppercase();
                if part.ends_with('.') || part.ends_with(' ') || part.chars().any(|c| ['<', '>', '"', '|', '?', '*'].contains(&c))
                    || ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
                        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&stem.as_str()) { return Err("项目归档路径不受支持".into()); }
                normalized.push(value);
            },
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
    selected: Option<&HashSet<String>>,
) -> Result<(), String> {
    if archive_dir.components().count() > 65 { return Err("项目素材目录过深".into()); }
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
            // 只排除项目根的派生缓存，分组中的同名目录仍属于用户素材。
            if archive_dir == Path::new(ASSETS_PREFIX) && name == ".thumbnail" {
                continue;
            }
            append_assets_dir(builder, &entry.path(), &archive_path, stats, selected)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = archive_path.strip_prefix(ASSETS_PREFIX).map_err(|_| "素材路径无效")?;
        if selected.is_some_and(|paths| !paths.contains(&to_archive_text(relative))) { continue; }

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
pub async fn pack_project_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    entries: Vec<ProjectArchiveTextEntry>,
    assets_dir: Option<String>,
    output_path: String,
    expected_assets: Option<Vec<ArchiveAssetDigest>>,
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
    if assets_root.as_ref().is_some_and(|root| output.starts_with(root)) { return Err("项目包不能导出到被打包的素材目录内".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        reauthorize_archive_path(&app, &output, PathAccess::Write)?;
        if let Some(root) = &assets_root { reauthorize_archive_path(&app, root, PathAccess::Read)?; }
        pack_archive(entries, assets_root, output, expected_assets, MAX_ARCHIVE_ENTRIES)
    }).await.map_err(|_| "项目归档打包任务失败".to_string())?
}

fn pack_archive(
    entries: Vec<ProjectArchiveTextEntry>,
    assets_root: Option<PathBuf>,
    output: PathBuf,
    expected_assets: Option<Vec<ArchiveAssetDigest>>,
    entry_limit: usize,
) -> Result<ProjectArchivePackResult, String> {
    let selected = expected_assets.as_ref().map(|assets| assets.iter().map(|asset| asset.path.clone()).collect::<HashSet<_>>());
    if let Some(expected) = &expected_assets {
        if selected.as_ref().map_or(0, HashSet::len) != expected.len() { return Err("导出素材清单重复".into()); }
        for asset in expected { normalize_archive_path(Path::new(&asset.path))?; }
    }
    if let (Some(root), Some(expected)) = (&assets_root, &expected_assets) {
        let mut actual = Vec::new(); inspect_assets(root, Path::new(""), &mut actual)?;
        actual.retain(|asset| selected.as_ref().is_some_and(|paths| paths.contains(&asset.path)));
        let mut expected = expected.clone(); expected.sort_by(|a, b| a.path.cmp(&b.path)); actual.sort_by(|a, b| a.path.cmp(&b.path));
        if actual != expected { return Err("素材在导出前已变化，请重新导出".into()); }
    }
    let temporary = output.with_extension(format!("{}.part", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时间无效")?.as_nanos()));
    let file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| format!("创建导出文件失败: {error}"))?;
    let result = (|| {
    let encoder = GzEncoder::new(BufWriter::new(file), Compression::default());
    let mut builder = Builder::new(encoder);
    let mtime = unix_now();

    let mut text_bytes = 0_u64; let mut paths = HashSet::new();
    for entry in &entries {
        let relative = normalize_archive_path(Path::new(&entry.path))?;
        if relative.as_os_str().is_empty() {
            return Err("项目归档条目路径为空".to_string());
        }
        if relative.starts_with(ASSETS_PREFIX) || !paths.insert(to_archive_text(&relative).to_lowercase()) { return Err("项目记录路径冲突".into()); }
        text_bytes = text_bytes.saturating_add(entry.content.len() as u64);
        if text_bytes > MAX_TEXT_BYTES { return Err("项目记录超过 512 MB 上限".into()); }
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
        append_assets_dir(&mut builder, root, Path::new(ASSETS_PREFIX), &mut stats, selected.as_ref())?;
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

    {
        // 发布前与导入共用 raw 条目预算和完整路径校验，GNU 长名称扩展也计入条目数。
        let mut file = File::open(&temporary).map_err(|_| "无法复核归档")?;
        validate_archive_stream_with_limit(GzDecoder::new(BufReader::new(&mut file)), entry_limit)?;
        file.seek(SeekFrom::Start(0)).map_err(|_| "无法重新读取待发布归档")?;
        let mut archive = Archive::new(GzDecoder::new(BufReader::new(file)));
        let mut actual = Vec::new();
        let mut seen = HashSet::new();
        for entry in archive.entries().map_err(|_| "无法复核归档")? {
            let mut entry = entry.map_err(|_| "无法复核归档条目")?;
            let path = to_archive_text(&archive_entry_path(&entry, &mut seen)?);
            if let Some(path) = path.strip_prefix("assets/").filter(|_| entry.header().entry_type().is_file()) {
                let mut digest = Sha256::new(); let mut bytes = 0_u64; let mut buffer = vec![0; 1024 * 1024];
                loop { let count = entry.read(&mut buffer).map_err(|_| "归档素材读取失败")?; if count == 0 { break; } digest.update(&buffer[..count]); bytes += count as u64; }
                actual.push(ArchiveAssetDigest { path: path.into(), bytes, sha256: format!("{:x}", digest.finalize()) });
            }
        }
        if let Some(expected) = &expected_assets {
            let mut expected = expected.clone(); actual.sort_by(|a, b| a.path.cmp(&b.path)); expected.sort_by(|a, b| a.path.cmp(&b.path));
            if actual != expected { return Err("素材在导出中发生变化，未发布归档".into()); }
        }
    }
    fs::rename(&temporary, &output).map_err(|_| "无法发布归档，目标可能正被占用")?;
    let archive_bytes = fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);
    Ok(ProjectArchivePackResult {
        asset_count: stats.count,
        asset_bytes: stats.bytes,
        archive_bytes,
    })
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

/// 解包项目归档：`assets/` 下的素材写入 `assets_dir`，其余条目按文本返回。
// tar 会在暴露普通条目前把 GNU/PAX 扩展读入内存；必须先以 raw 模式限制它们。
fn validate_archive_stream<R: Read>(reader: R) -> Result<(), String> {
    validate_archive_stream_with_limit(reader, MAX_ARCHIVE_ENTRIES)
}

fn validate_archive_stream_with_limit<R: Read>(reader: R, entry_limit: usize) -> Result<(), String> {
    let mut archive = Archive::new(reader);
    let mut total = 0_u64;
    for (index, item) in archive.entries().map_err(|_| "归档头无效")?.raw(true).enumerate() {
        if index >= entry_limit { return Err("项目归档条目超过上限".into()); }
        let entry = item.map_err(|_| "归档条目无效")?;
        let kind = entry.header().entry_type();
        let size = entry.size();
        if kind.is_gnu_longname() || kind.is_gnu_longlink() || kind.is_pax_local_extensions() || kind.is_pax_global_extensions() {
            if size > MAX_EXTENSION_BYTES { return Err("归档扩展元数据超过上限".into()); }
        } else if !kind.is_file() && !kind.is_dir() { return Err("项目归档包含不允许的链接或设备文件".into()); }
        total = total.checked_add(size).ok_or("归档体积无效")?;
        if total > MAX_EXPANDED_BYTES + MAX_TEXT_BYTES { return Err("归档展开体积超过上限".into()); }
    }
    Ok(())
}

/// 导出复核和解包必须针对带 assets/ 前缀的完整名称执行同一套校验。
fn archive_entry_path<R: Read>(entry: &tar::Entry<'_, R>, seen: &mut HashSet<String>) -> Result<PathBuf, String> {
    let kind = entry.header().entry_type();
    if !kind.is_file() && !kind.is_dir() {
        return Err("项目归档包含不允许的链接或设备文件".into());
    }
    let path = normalize_archive_path(&entry.path().map_err(|_| "读取项目归档路径失败")?)?;
    if !path.as_os_str().is_empty() && !seen.insert(to_archive_text(&path).to_lowercase()) {
        return Err("项目归档含重复或大小写冲突路径".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn unpack_project_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    archive_path: String,
    assets_dir: String,
) -> Result<ProjectArchiveUnpackResult, String> {
    ensure_trusted_caller(&webview)?;
    let archive_file = authorize_path(&app, &archive_path, PathAccess::Read)?;
    let target_dir = authorize_path(&app, &assets_dir, PathAccess::Write)?;
    tauri::async_runtime::spawn_blocking(move || {
        reauthorize_archive_path(&app, &archive_file, PathAccess::Read)?;
        reauthorize_archive_path(&app, &target_dir, PathAccess::Write)?;
        unpack_archive(&archive_file, &target_dir)
    }).await.map_err(|_| "项目归档解包任务失败".to_string())?
}

fn unpack_archive(archive_file: &Path, target_dir: &Path) -> Result<ProjectArchiveUnpackResult, String> {
    if !target_dir.is_dir() {
        return Err("导入目标目录不存在".to_string());
    }
    if fs::read_dir(&target_dir).map_err(|_| "无法读取导入暂存目录")?.next().is_some() { return Err("项目包只能解压至空目录".into()); }

    let mut file =
        File::open(&archive_file).map_err(|error| format!("打开项目归档失败: {error}"))?;
    validate_archive_stream(GzDecoder::new(BufReader::new(&mut file)))?;
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法重新读取已校验的归档")?;
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
    let mut seen = HashSet::new(); let mut assets = Vec::new();

    for item in entries {
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err("项目归档文件数量超过限制".to_string());
        }
        let mut entry = item.map_err(|error| format!("读取项目归档项失败: {error}"))?;
        let entry_type = entry.header().entry_type();
        let relative = archive_entry_path(&entry, &mut seen)?;
        if relative.as_os_str().is_empty() {
            continue;
        }

        let mut components = relative.components();
        let is_asset = matches!(components.next(), Some(Component::Normal(first)) if first == ASSETS_PREFIX);
        if !is_asset {
            if entry_type.is_dir() {
                continue;
            }
            let size = entry.size();
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

        asset_bytes = asset_bytes.saturating_add(entry.size());
        if asset_bytes > MAX_EXPANDED_BYTES {
            return Err("项目归档展开后超过 20 GB 限制".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;
        }
        let mut target = fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|_| "无法创建暂存素材")?;
        std::io::copy(&mut entry, &mut target).map_err(|_| "解压素材失败")?; target.flush().map_err(|_| "暂存素材写入失败")?; drop(target);
        let path = to_archive_text(&inner); let (bytes, sha256) = hash_file(&destination)?;
        asset_paths.push(path.clone()); assets.push(ArchiveAssetDigest { path, bytes, sha256 });
    }

    Ok(ProjectArchiveUnpackResult {
        texts,
        asset_paths,
        asset_bytes,
        assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ai-canvas-archive-regression-{}-{}", std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn write(&self, relative: &str, bytes: &[u8]) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let temporary = std::env::temp_dir().canonicalize().unwrap();
            assert!(self.0.starts_with(&temporary) && self.0 != temporary);
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    // 只替换 AppHandle 授权入口；路径解析、父链存在性、目录和链接检查均操作真实文件系统。
    fn filesystem_authorize(path: &Path, existing_plain: bool) -> Result<PathBuf, String> {
        if existing_plain {
            let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let reparse = false;
            if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse {
                return Err("必须为普通目录".into());
            }
        }
        match path.canonicalize() {
            Ok(resolved) => Ok(resolved),
            Err(error) if !existing_plain && error.kind() == std::io::ErrorKind::NotFound => {
                let parent = path.parent().ok_or("缺少父目录")?.canonicalize().map_err(|error| error.to_string())?;
                Ok(parent.join(path.file_name().ok_or("缺少目录名")?))
            },
            Err(error) => Err(error.to_string()),
        }
    }

    #[test]
    fn creates_first_import_parent_and_reuses_it_without_overwriting_operations() {
        let fixture = Fixture::new();
        assert!(!fixture.0.join("imports").exists());
        let first = create_import_destination(&fixture.0, "first", filesystem_authorize).unwrap();
        fs::write(first.join("keep.txt"), b"original").unwrap();
        let second = create_import_destination(&fixture.0, "second", filesystem_authorize).unwrap();
        assert!(second.is_dir());
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
    }

    #[test]
    fn rejects_import_parent_files_and_existing_operation_files() {
        let fixture = Fixture::new();
        fixture.write("imports", b"keep parent");
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(fixture.0.join("imports")).unwrap(), b"keep parent");
        fs::remove_file(fixture.0.join("imports")).unwrap();
        fixture.write("imports/first", b"keep operation");
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(fixture.0.join("imports/first")).unwrap(), b"keep operation");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_import_parent_and_operation_links_without_touching_targets() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let other = Fixture::new();
        other.write("keep.txt", b"outside");
        symlink(&other.0, fixture.0.join("imports")).unwrap();
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        fs::remove_file(fixture.0.join("imports")).unwrap();
        fs::create_dir(fixture.0.join("imports")).unwrap();
        symlink(&other.0, fixture.0.join("imports/first")).unwrap();
        assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        assert_eq!(fs::read(other.0.join("keep.txt")).unwrap(), b"outside");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_import_junctions_without_touching_targets() {
        struct Junction(PathBuf);
        impl Junction {
            fn new(link: PathBuf, target: &Path) -> Self {
                let shell_path = |path: &Path| {
                    let text = path.to_str().unwrap();
                    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
                    assert!(!text.chars().any(|character| "\"&|<>^%!()\r\n".contains(character)), "测试路径含 shell 特殊字符");
                    text.to_owned()
                };
                let output = std::process::Command::new("cmd.exe")
                    .args(["/d", "/v:off", "/c", "mklink", "/J"])
                    .arg(shell_path(&link)).arg(shell_path(target)).output().unwrap();
                assert!(output.status.success(), "创建测试目录联接失败：{}", String::from_utf8_lossy(&output.stderr));
                Self(link)
            }
        }
        impl Drop for Junction {
            fn drop(&mut self) {
                // remove_dir 只解除联接；目标及其文件由独立 Fixture 管理。
                fs::remove_dir(&self.0).unwrap();
            }
        }
        let fixture = Fixture::new();
        let other = Fixture::new();
        other.write("keep.txt", b"outside");
        {
            let _link = Junction::new(fixture.0.join("imports"), &other.0);
            assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        }
        fs::create_dir(fixture.0.join("imports")).unwrap();
        {
            let _link = Junction::new(fixture.0.join("imports/first"), &other.0);
            assert!(create_import_destination(&fixture.0, "first", filesystem_authorize).is_err());
        }
        assert_eq!(fs::read(other.0.join("keep.txt")).unwrap(), b"outside");
    }

    #[test]
    fn round_trips_long_chinese_paths_and_preserves_bytes() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        let relative = format!("{}/制作总览.md", vec!["汉".repeat(40); 8].join("/"));
        let file = source.join(&relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# 中文原稿\n连续性待核对").unwrap();
        let mut assets = Vec::new(); inspect_assets(&source, Path::new(""), &mut assets).unwrap();
        let output = fixture.0.join("project.aicanvas");
        pack_archive(vec![], Some(source), output.clone(), Some(assets.clone()), MAX_ARCHIVE_ENTRIES).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert!(unpacked.assets == assets);
        assert_eq!(fs::read(target.join(relative)).unwrap(), "# 中文原稿\n连续性待核对".as_bytes());
    }

    #[test]
    fn round_trips_an_archive_without_assets_and_creates_empty_import_destination() {
        let fixture = Fixture::new();
        let output = fixture.0.join("project.aicanvas");
        let result = pack_archive(vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }],
            None, output.clone(), Some(vec![]), MAX_ARCHIVE_ENTRIES).unwrap();
        assert_eq!(result.asset_count, 0);
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert!(unpacked.assets.is_empty());
        assert_eq!(unpacked.texts["manifest.json"], "{}");
        let destination = create_import_destination(&fixture.0, "empty", filesystem_authorize).unwrap();
        assert!(destination.is_dir() && fs::read_dir(destination).unwrap().next().is_none());
    }

    #[test]
    fn rejects_complete_asset_path_byte_overflow_before_replacing_export() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        let relative = format!("{}/{}.md", vec!["汉".repeat(40); 8].join("/"), "文".repeat(16));
        assert!(relative.len() <= 1024 && format!("assets/{relative}").len() > 1024);
        let file = source.join(relative); fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(file, b"text").unwrap();
        let mut assets = Vec::new(); inspect_assets(&source, Path::new(""), &mut assets).unwrap();
        let output = fixture.0.join("project.aicanvas"); fs::write(&output, b"existing export").unwrap();
        let error = pack_archive(vec![], Some(source), output.clone(), Some(assets), MAX_ARCHIVE_ENTRIES).err().unwrap();
        assert!(error.contains("不安全路径"));
        assert_eq!(fs::read(output).unwrap(), b"existing export");
        assert!(!fs::read_dir(&fixture.0).unwrap().any(|item| item.unwrap().path().extension().is_some_and(|value| value == "part")));
    }

    #[test]
    fn complete_asset_depth_limit_matches_import_and_rejects_before_publish() {
        for components in [63, 64] {
            let fixture = Fixture::new();
            let source = fixture.0.join("source");
            let relative = format!("{}/note.md", vec!["a"; components - 1].join("/"));
            let file = source.join(&relative); fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(file, b"note").unwrap();
            let output = fixture.0.join("project.aicanvas");
            let result = pack_archive(vec![], Some(source), output.clone(), None, MAX_ARCHIVE_ENTRIES);
            if components == 63 {
                assert!(result.is_ok());
                let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
                unpack_archive(&output, &target).unwrap();
                assert_eq!(fs::read(target.join(relative)).unwrap(), b"note");
            } else {
                assert!(result.err().unwrap().contains("不安全路径"));
                assert!(!output.exists());
            }
        }
    }

    #[test]
    fn counts_gnu_name_extensions_and_json_entries_before_export_publish() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source"); fs::create_dir(&source).unwrap();
        let name = format!("{}.txt", "长".repeat(40)); fs::write(source.join(&name), b"asset").unwrap();
        let entries = || vec![ProjectArchiveTextEntry { path: "manifest.json".into(), content: "{}".into() }];
        let output = fixture.0.join("project.aicanvas"); fs::write(&output, b"existing export").unwrap();
        let error = pack_archive(entries(), Some(source.clone()), output.clone(), None, 2).err().unwrap();
        assert!(error.contains("条目超过上限"));
        assert_eq!(fs::read(&output).unwrap(), b"existing export");
        pack_archive(entries(), Some(source), output.clone(), None, 3).unwrap();
        let target = fixture.0.join("unpacked"); fs::create_dir(&target).unwrap();
        let unpacked = unpack_archive(&output, &target).unwrap();
        assert_eq!(unpacked.texts["manifest.json"], "{}");
        assert_eq!(fs::read(target.join(name)).unwrap(), b"asset");
    }

    #[test]
    fn rejects_oversized_extensions_before_tar_allocates_them() {
        for kind in [tar::EntryType::GNULongName, tar::EntryType::XHeader, tar::EntryType::XGlobalHeader] {
            let mut header = Header::new_gnu();
            header.set_path("metadata").unwrap(); header.set_entry_type(kind);
            header.set_size(MAX_EXTENSION_BYTES + 1); header.set_cksum();
            assert!(validate_archive_stream(header.as_bytes().as_slice()).unwrap_err().contains("扩展"));
        }
    }

    #[test]
    fn selected_export_omits_recovery_files_and_keeps_active_imports() {
        let directory = std::env::temp_dir().join(format!("ai-canvas-selected-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(directory.join("imports/active")).unwrap();
        fs::create_dir_all(directory.join("imports/recovery")).unwrap();
        fs::write(directory.join("imports/active/a.png"), b"current").unwrap();
        fs::write(directory.join("imports/recovery/a.png"), b"private-old-content").unwrap();
        let selected = HashSet::from(["imports/active/a.png".to_string()]);
        let mut builder = Builder::new(Vec::new()); let mut stats = AssetStats { count: 0, bytes: 0 };
        append_assets_dir(&mut builder, &directory, Path::new(ASSETS_PREFIX), &mut stats, Some(&selected)).unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let paths: Vec<_> = archive.entries().unwrap().map(|item| to_archive_text(&item.unwrap().path().unwrap())).collect();
        let resolved = directory.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(&resolved).unwrap();
        assert_eq!(paths, ["assets/imports/active/a.png"]); assert_eq!(stats.bytes, 7);
    }

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

    #[test]
    fn inspects_and_packs_nested_assets_with_portable_paths() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-archive-paths-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let files = [
            ("EP000｜剧本、视觉与制作说明/EP000 制作总览与连续性待核对.md", "# 制作总览\n连续性待核对"),
            ("EP000｜剧本、视觉与制作说明/参考/人物.md", "# 人物\n中文正文"),
        ];
        for (path, content) in files {
            let target = directory.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, content.as_bytes()).unwrap();
        }

        let mut assets = Vec::new();
        inspect_assets(&directory, Path::new(""), &mut assets).unwrap();
        assets.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(assets.len(), files.len());
        for (asset, (path, content)) in assets.iter().zip(files) {
            assert_eq!(asset.path, path);
            assert_eq!(asset.bytes, content.len() as u64);
            assert_eq!(asset.sha256, format!("{:x}", Sha256::digest(content.as_bytes())));
            assert!(normalize_archive_path(Path::new(&asset.path)).is_ok());
        }

        let selected = assets.iter().map(|asset| asset.path.clone()).collect::<HashSet<_>>();
        let mut builder = Builder::new(Vec::new());
        let mut stats = AssetStats { count: 0, bytes: 0 };
        append_assets_dir(&mut builder, &directory, Path::new(ASSETS_PREFIX), &mut stats, Some(&selected)).unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let mut packed = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = normalize_archive_path(&entry.path().unwrap()).unwrap();
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            packed.push((to_archive_text(&path), content));
        }
        packed.sort();

        let resolved = directory.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(&resolved).unwrap();
        assert_eq!(packed, files.map(|(path, content)| (format!("assets/{path}"), content.to_string())));
        assert_eq!(stats.count, files.len());
    }

    #[test]
    fn omits_root_thumbnail_cache_but_preserves_nested_user_directory() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-archive-thumbnail-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(directory.join(".thumbnail")).unwrap();
        fs::create_dir_all(directory.join("group/.thumbnail")).unwrap();
        fs::write(directory.join(".thumbnail/cache.webp"), b"cache").unwrap();
        fs::write(directory.join("group/.thumbnail/user.png"), b"user").unwrap();
        fs::write(directory.join("original.png"), b"original").unwrap();

        let mut builder = Builder::new(Vec::new());
        let mut stats = AssetStats { count: 0, bytes: 0 };
        append_assets_dir(
            &mut builder,
            &directory,
            Path::new(ASSETS_PREFIX),
            &mut stats,
            None,
        )
        .unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = Archive::new(bytes.as_slice());
        let mut paths: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|entry| to_archive_text(&entry.unwrap().path().unwrap()))
            .collect();
        paths.sort();

        // The only recursive removal belongs to this test's newly created temporary directory.
        let resolved = directory.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        fs::remove_dir_all(&resolved).unwrap();

        assert_eq!(
            paths,
            ["assets/group/.thumbnail/user.png", "assets/original.png"]
        );
        assert_eq!(stats.count, 2);
        assert_eq!(stats.bytes, 12);
    }
}
