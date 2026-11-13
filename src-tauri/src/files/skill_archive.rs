//! Skill 压缩包只读取有界 UTF-8 文本，不按归档路径直接解包或执行脚本。

use crate::path_policy::{authorize_existing_plain_file, authorize_path, ensure_trusted_caller, PathAccess};
use flate2::read::GzDecoder;
use serde::Serialize;
use std::{collections::HashSet, fs::File, io::{Cursor, Read}, sync::Mutex};
use tauri::{AppHandle, Runtime, Webview};

const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const MAX_ENTRIES: usize = 4096;
static ARCHIVE_READ_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillArchiveText {
    relative_path: String,
    content: String,
}

fn read_bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)
        .map_err(|_| "Skill 压缩包损坏、加密或格式不受支持".to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Skill 压缩包超过大小限制（压缩包 32 MiB、展开 64 MiB、单文件 8 MiB）".into());
    }
    Ok(bytes)
}

pub(super) fn safe_archive_path(raw: &str, directory: bool) -> Result<String, String> {
    const INVALID: &str = "Skill 压缩包包含不安全路径";
    if raw.len() > 4096 || raw.contains('\\') || raw.chars().any(char::is_control) {
        return Err(INVALID.into());
    }
    let mut path = raw;
    while let Some(rest) = path.strip_prefix("./") { path = rest; }
    if directory { path = path.trim_end_matches('/'); }
    if directory && (path.is_empty() || path == ".") { return Ok(String::new()); }
    let segments: Vec<_> = path.split('/').collect();
    if segments.len() > 64 || segments.iter().any(|part| {
        let device = part.split('.').next().unwrap_or_default().to_ascii_lowercase();
        part.is_empty() || *part == "." || *part == ".." || part.starts_with('~')
            || part.ends_with(['.', ' ']) || part.contains([':', '*', '?', '"', '<', '>', '|'])
            || matches!(device.as_str(), "con" | "prn" | "aux" | "nul")
            || (device.len() == 4 && (device.starts_with("com") || device.starts_with("lpt"))
                && matches!(device.as_bytes()[3], b'1'..=b'9'))
    }) {
        return Err(INVALID.into());
    }
    Ok(path.to_string())
}

fn register_path(paths: &mut HashSet<String>, path: &str) -> Result<(), String> {
    // 各平台保持相同结果，Windows 上大小写不同的条目不能互相覆盖。
    if !path.is_empty() && !paths.insert(path.to_lowercase()) {
        return Err("Skill 压缩包包含重复路径".into());
    }
    Ok(())
}

fn collect_text(files: &mut Vec<SkillArchiveText>, path: String, bytes: Vec<u8>) -> Result<(), String> {
    if path.split('/').any(|part| part == "__MACOSX" || part.starts_with("._")) {
        return Ok(());
    }
    let extension = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    if matches!(extension.as_str(), "md" | "txt" | "json") {
        let content = String::from_utf8(bytes).map_err(|_| "Skill 文件必须是 UTF-8 文本".to_string())?;
        let content = content.strip_prefix('\u{feff}').unwrap_or(&content).to_string();
        files.push(SkillArchiveText { relative_path: path, content });
    }
    Ok(())
}

fn read_zip(bytes: Vec<u8>) -> Result<Vec<SkillArchiveText>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Skill ZIP 压缩包格式无效".to_string())?;
    if archive.len() > MAX_ENTRIES { return Err("Skill 压缩包条目超过 4096 个".into()); }
    let mut files = Vec::new();
    let mut paths = HashSet::new();
    let mut expanded = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)
            .map_err(|_| "Skill ZIP 压缩包损坏、加密或压缩方式不受支持".to_string())?;
        let directory = entry.is_dir();
        let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
        if entry.encrypted() || !matches!(kind, 0 | 0o100000 | 0o040000)
            || (kind == 0o040000 && !directory) || (kind == 0o100000 && directory)
        {
            return Err("Skill 压缩包包含加密条目、链接或特殊文件".into());
        }
        let raw = std::str::from_utf8(entry.name_raw())
            .map_err(|_| "Skill 压缩包路径必须使用 UTF-8".to_string())?;
        let path = safe_archive_path(raw, directory)?;
        register_path(&mut paths, &path)?;
        let declared = entry.size();
        if declared > MAX_FILE_BYTES || (directory && declared != 0) {
            return Err("Skill 压缩包单文件超过 8 MiB 或目录条目无效".into());
        }
        let content = read_bounded(&mut entry, MAX_FILE_BYTES.min(MAX_EXPANDED_BYTES - expanded))?;
        if content.len() as u64 != declared { return Err("Skill 压缩包条目大小不一致".into()); }
        expanded += content.len() as u64;
        if !directory { collect_text(&mut files, path, content)?; }
    }
    Ok(files)
}

fn read_tar_gz(bytes: Vec<u8>) -> Result<Vec<SkillArchiveText>, String> {
    // 先限制真实解压流，PAX/GNU 元数据及被忽略文件也计入总量。
    let expanded = read_bounded(GzDecoder::new(Cursor::new(bytes)), MAX_EXPANDED_BYTES)?;
    let mut archive = tar::Archive::new(Cursor::new(expanded));
    let entries = archive.entries().map_err(|_| "Skill tar.gz 压缩包格式无效".to_string())?;
    let mut files = Vec::new();
    let mut paths = HashSet::new();
    for (index, item) in entries.enumerate() {
        if index >= MAX_ENTRIES { return Err("Skill 压缩包条目超过 4096 个".into()); }
        let mut entry = item.map_err(|_| "Skill tar.gz 压缩包条目无效".to_string())?;
        let kind = entry.header().entry_type();
        // 全局 PAX 只作元数据；局部 PAX/GNU 长路径由 tar 解析后再次校验。
        if kind.is_pax_global_extensions() { continue; }
        if !kind.is_file() && !kind.is_dir() {
            return Err("Skill 压缩包包含不允许的链接或特殊文件".into());
        }
        let raw = entry.path().map_err(|_| "Skill 压缩包路径无效".to_string())?;
        let raw = raw.to_str().ok_or_else(|| "Skill 压缩包路径必须使用 UTF-8".to_string())?;
        let path = safe_archive_path(raw, kind.is_dir())?;
        register_path(&mut paths, &path)?;
        let size = entry.size();
        if size > MAX_FILE_BYTES || (kind.is_dir() && size != 0) {
            return Err("Skill 压缩包单文件超过 8 MiB 或目录条目无效".into());
        }
        if kind.is_file() {
            let content = read_bounded(&mut entry, MAX_FILE_BYTES)?;
            if content.len() as u64 != size { return Err("Skill 压缩包条目大小不一致".into()); }
            collect_text(&mut files, path, content)?;
        }
    }
    Ok(files)
}

/// 只接受可信自有窗口和用户通过对话框授权的普通文件；不接收解包目标路径。
#[tauri::command]
pub async fn read_skill_archive<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    archive_path: String,
) -> Result<Vec<SkillArchiveText>, String> {
    ensure_trusted_caller(&webview)?;
    authorize_path(&app, &archive_path, PathAccess::Read)
        .map_err(|_| "Skill 压缩包无效、不可访问或未获授权".to_string())?;
    let path = authorize_existing_plain_file(&app, &archive_path)?;
    let lower = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_ascii_lowercase();
    let is_zip = lower.ends_with(".zip");
    if !is_zip && !lower.ends_with(".tar.gz") && !lower.ends_with(".tgz") {
        return Err("Skill 压缩包只支持 .zip / .tar.gz / .tgz".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ARCHIVE_READ_LOCK.try_lock().map_err(|_| "正在读取其他 Skill 压缩包，请稍后重试".to_string())?;
        let file = File::open(path).map_err(|_| "无法读取 Skill 压缩包".to_string())?;
        if file.metadata().map_err(|_| "无法读取 Skill 压缩包属性".to_string())?.len() > MAX_ARCHIVE_BYTES {
            return Err("Skill 压缩包超过 32 MiB".into());
        }
        let bytes = read_bounded(file, MAX_ARCHIVE_BYTES)?;
        let files = if is_zip { read_zip(bytes)? } else { read_tar_gz(bytes)? };
        if files.is_empty() { return Err("Skill 压缩包中没有可用的 .md / .txt / .json 文件".into()); }
        Ok(files)
    }).await.map_err(|_| "Skill 压缩包读取任务失败".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use tar::{Builder, EntryType, Header};
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (path, content) in entries {
            writer.start_file(*path, SimpleFileOptions::default()).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn tar_gz_bytes(entries: &[(&str, &[u8], EntryType)]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = Builder::new(encoder);
        for (path, content, kind) in entries {
            let mut header = Header::new_gnu();
            // 直接构造头，恶意路径也必须交给读取端检查。
            header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            header.set_entry_type(*kind);
            header.set_mode(0o644);
            header.set_size(content.len() as u64);
            header.set_cksum();
            builder.append(&header, *content).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn zip_and_tar_gz_read_utf8_text_and_ignore_binary_and_scripts() {
        let entries: [(&str, &[u8]); 4] = [
            ("示例/SKILL.md", "\u{feff}# 中文 Skill".as_bytes()),
            ("示例/references/检查.json", "{\"内容\":\"中文\"}".as_bytes()),
            ("示例/cover.png", &[0xff, 0xfe]),
            ("示例/scripts/run.py", b"raise Exception()"),
        ];
        let tar_entries: Vec<_> = entries.iter().map(|(path, content)| (*path, *content, EntryType::Regular)).collect();
        for files in [read_zip(zip_bytes(&entries)), read_tar_gz(tar_gz_bytes(&tar_entries))] {
            let files = files.unwrap();
            assert_eq!(files.len(), 2);
            assert_eq!(files[0].relative_path, "示例/SKILL.md");
            assert_eq!(files[0].content, "# 中文 Skill");
            assert_eq!(files[1].content, "{\"内容\":\"中文\"}");
        }
    }

    #[test]
    fn rejects_unsafe_paths_duplicate_names_and_non_utf8_text() {
        for path in ["../SKILL.md", "/SKILL.md", "C:/SKILL.md", "a\\SKILL.md", "a/../SKILL.md", "NUL.txt"] {
            assert!(read_zip(zip_bytes(&[(path, b"# skill")])).is_err(), "{path}");
            assert!(read_tar_gz(tar_gz_bytes(&[(path, b"# skill", EntryType::Regular)])).is_err(), "{path}");
        }
        assert!(read_zip(zip_bytes(&[("SKILL.md", b"a"), ("skill.md", b"b")])).is_err());
        assert!(read_tar_gz(tar_gz_bytes(&[
            ("SKILL.md", b"a", EntryType::Regular), ("skill.md", b"b", EntryType::Regular),
        ])).is_err());
        assert!(read_zip(zip_bytes(&[("SKILL.md", &[0xff])])).is_err());
        assert!(read_tar_gz(tar_gz_bytes(&[("SKILL.md", &[0xff], EntryType::Regular)])).is_err());
    }

    #[test]
    fn refuses_links_but_accepts_global_pax_metadata() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.add_symlink("SKILL.md", "../outside.md", SimpleFileOptions::default()).unwrap();
        assert!(read_zip(writer.finish().unwrap().into_inner()).is_err());
        assert!(read_tar_gz(tar_gz_bytes(&[("SKILL.md", b"", EntryType::Symlink)])).is_err());
        assert!(read_tar_gz(tar_gz_bytes(&[("SKILL.md", b"", EntryType::Link)])).is_err());
        let files = read_tar_gz(tar_gz_bytes(&[
            ("pax_global_header", b"", EntryType::XGlobalHeader),
            ("./demo/SKILL.md", b"# skill", EntryType::Regular),
        ])).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "demo/SKILL.md");
    }

    #[test]
    fn enforces_actual_read_limit_and_rejects_corruption() {
        assert!(read_bounded(Cursor::new(b"12345"), 4).is_err());
        assert!(read_zip(b"not a zip".to_vec()).is_err());
        assert!(read_tar_gz(b"not gzip".to_vec()).is_err());
        let large = vec![b'a'; MAX_FILE_BYTES as usize + 1];
        assert!(read_zip(zip_bytes(&[("SKILL.md", &large)])).is_err());
        assert!(read_tar_gz(tar_gz_bytes(&[("SKILL.md", &large, EntryType::Regular)])).is_err());
    }
}
