use super::ui_slice_pixels::{self as pixels, Item, Rect, MAX_ITEMS, MAX_SOURCE_BYTES, NORMALIZATION};
use super::UiSliceSelection;
use crate::path_policy::{
    authorize_existing_plain_file, authorize_existing_plain_file_with_roots, authorize_path_with_roots,
    is_link_or_reparse, reauthorize_existing_plain_directory_with_roots, PathAccess,
};
#[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
use crate::native_project_media::AnchoredDirectory;
#[cfg(not(any(windows, target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))))]
use unsupported_export::AnchoredDirectory;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Runtime};
use tokio_util::sync::CancellationToken;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[cfg(not(any(windows, target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))))]
mod unsupported_export {
    use std::{ffi::OsStr, fs::File, io, path::Path};

    pub(super) enum AnchoredDirectory {}

    impl AnchoredDirectory {
        pub(super) fn open(_: &Path) -> Result<Self, String> { Err("当前平台不支持安全导出切图归档".into()) }
        pub(super) fn verify(&self) -> Result<(), String> { match *self {} }
        pub(super) fn identity(&self) -> io::Result<file_id::FileId> { match *self {} }
        pub(super) fn open_file(&self, _: &OsStr) -> io::Result<File> { match *self {} }
        pub(super) fn create_file(&self, _: &OsStr) -> io::Result<File> { match *self {} }
        pub(super) fn remove_file(&self, _: &OsStr) -> Result<(), String> { match *self {} }
        pub(super) fn rename_file(&self, _: &OsStr, _: &OsStr, _: bool) -> Result<(), String> { match *self {} }
        pub(super) fn sync(&self) -> io::Result<()> { match *self {} }
    }
}

const MAX_PREVIEW_BYTES: usize = 180_000;
const MAX_DETAILED_PREVIEW_BYTES: usize = 12 * 1024 * 1024;
const PREVIEW_CHUNK_BYTES: usize = 180_000;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
pub(super) static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

fn regular_file(path: &Path) -> Result<fs::Metadata, String> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file() && !is_link_or_reparse(meta))
        .ok_or_else(|| "需要可读取的普通文件".into())
}

fn open_for_read(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .share_mode(FILE_SHARE_READ.0);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100 | 0x4);
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        options.custom_flags(0x20000 | 0x800);
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        options.custom_flags(0x8000 | 0x800);
        #[cfg(not(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))))]
        return Err(std::io::Error::other("当前平台不支持安全打开切图文件"));
    }
    options.open(path)
}

fn opened_file_id(file: &File) -> std::io::Result<file_id::FileId> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
                BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
            },
        };
        let handle = HANDLE(file.as_raw_handle());
        let mut high = FILE_ID_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdInfo,
                (&mut high as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .is_ok()
        {
            return Ok(file_id::FileId::new_high_res(
                high.VolumeSerialNumber,
                u128::from_le_bytes(high.FileId.Identifier),
            ));
        }
        let mut low = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(handle, &mut low) }.map_err(std::io::Error::other)?;
        Ok(file_id::FileId::new_low_res(
            low.dwVolumeSerialNumber,
            (u64::from(low.nFileIndexHigh) << 32) | u64::from(low.nFileIndexLow),
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(file_id::FileId::new_inode(metadata.dev(), metadata.ino()))
    }
    #[cfg(not(any(windows, unix)))]
    Err(std::io::Error::other("当前平台不支持核对文件句柄身份"))
}

struct Snapshot {
    raw_digest: String,
    pixel_digest: String,
    image: RgbaImage,
}

fn read_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    assume_srgb: bool,
    cancel: &CancellationToken,
) -> Result<Snapshot, String> {
    let path = authorize_existing_plain_file(app, source).map_err(|_| "源图未获原生读授权")?;
    let expected = file_id::get_file_id(&path).map_err(|_| "无法确认源图文件身份")?;
    let mut file = open_for_read(&path).map_err(|_| "源图无法打开")?;
    let metadata = file.metadata().map_err(|_| "源图文件信息不可读")?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || opened_file_id(&file).ok() != Some(expected)
        || authorize_existing_plain_file(app, source).ok().as_ref() != Some(&path)
    {
        return Err("源图打开期间已改变".into());
    }
    let size = metadata.len();
    if size == 0 || size > MAX_SOURCE_BYTES {
        return Err("输入图片须为 1 字节至 64 MiB".into());
    }
    let modified = metadata.modified().map_err(|_| "源图修改时间不可读")?;
    let mut bytes = Vec::with_capacity(size as usize);
    let mut scratch = [0u8; 64 * 1024];
    loop {
        pixels::check_cancelled(cancel)?;
        let count = file.read(&mut scratch).map_err(|_| "源图读取失败")?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > size as usize {
            return Err("源图读取期间已改变".into());
        }
        bytes.extend_from_slice(&scratch[..count]);
    }
    let current = file.metadata().map_err(|_| "源图文件信息不可读")?;
    if bytes.len() as u64 != size
        || current.len() != size
        || current.modified().ok() != Some(modified)
        || file_id::get_file_id(&path).ok() != Some(expected)
        || authorize_existing_plain_file(app, source).ok().as_ref() != Some(&path)
    {
        return Err("源图读取期间已改变".into());
    }
    drop(file);
    let raw_digest = pixels::digest(&bytes);
    let image = pixels::decode(&bytes, assume_srgb)?;
    pixels::check_cancelled(cancel)?;
    Ok(Snapshot {
        raw_digest,
        pixel_digest: pixels::digest(image.as_raw()),
        image,
    })
}

pub(super) fn inspect<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    assume_srgb: bool,
    cancel: &CancellationToken,
) -> Result<Value, String> {
    let snapshot = read_snapshot(app, source, assume_srgb, cancel)?;
    inspect_snapshot(&snapshot, cancel)
}

fn encode_preview(
    image: &RgbaImage,
    mut edge: u32,
    max_bytes: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let source_edge = image.width().max(image.height());
    loop {
        pixels::check_cancelled(cancel)?;
        let encoded = if edge >= source_edge {
            pixels::png(image.as_raw(), image.width(), image.height())?
        } else {
            let width = ((image.width() * edge + source_edge / 2) / source_edge).max(1);
            let height = ((image.height() * edge + source_edge / 2) / source_edge).max(1);
            let scaled = image::imageops::thumbnail(image, width, height);
            pixels::png(scaled.as_raw(), width, height)?
        };
        if encoded.len() <= max_bytes {
            return Ok(encoded);
        }
        if edge <= 96 {
            return Err("图片预览超过传输上限".into());
        }
        edge = edge * 3 / 4;
    }
}

fn inspect_snapshot(snapshot: &Snapshot, cancel: &CancellationToken) -> Result<Value, String> {
    let image = &snapshot.image;
    let mut regions = [Rect::default(); MAX_ITEMS];
    let (region_count, truncated) = pixels::transparent_regions(image, &mut regions, cancel)?;
    let edge = image.width().max(image.height());
    let detailed = encode_preview(image, edge, MAX_DETAILED_PREVIEW_BYTES, cancel)?;
    let mut result = json!({
        "sourceSha256": snapshot.raw_digest, "width": image.width(), "height": image.height(),
        "regions": &regions[..region_count], "truncated": truncated,
    });
    if detailed.len() <= MAX_PREVIEW_BYTES {
        result["previewPngBase64"] = json!(STANDARD.encode(detailed));
    } else {
        let preview = encode_preview(image, edge.min(800), MAX_PREVIEW_BYTES, cancel)?;
        result["previewPngBase64"] = json!(STANDARD.encode(preview));
        let mut chunks = Vec::new();
        for chunk in detailed.chunks(PREVIEW_CHUNK_BYTES) {
            pixels::check_cancelled(cancel)?;
            chunks.push(STANDARD.encode(chunk));
        }
        result["previewPngBase64Chunks"] = json!(chunks);
    }
    Ok(result)
}

fn read_zip_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    limit: u64,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(|_| format!("归档缺少 {name}"))?;
    if entry.size() > limit || entry.compression() != CompressionMethod::Stored
        || entry.is_dir() || entry.unix_mode().is_some_and(|mode| {
            let kind = mode & 0o170000;
            kind != 0 && kind != 0o100000
        })
    {
        return Err("归档条目类型、压缩方式或大小无效".into());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    let mut reader = entry.take(limit + 1);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        pixels::check_cancelled(cancel)?;
        let count = reader.read(&mut buffer).map_err(|_| "归档条目读取失败")?;
        if count == 0 { break; }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() as u64 > limit { return Err("归档条目超过大小限制".into()); }
    }
    Ok(bytes)
}

fn has_only_fields(value: &Value, fields: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.keys().all(|key| fields.contains(&key.as_str())))
}

fn decode_draft_png(bytes: &[u8]) -> Result<RgbaImage, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.get(12..16) != Some(&b"IHDR"[..])
        || bytes.get(24..26) != Some(&[8, 6][..])
    {
        return Err("工作稿图片必须是 RGBA8 PNG".into());
    }
    pixels::decode(bytes, false)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DraftFile {
    path: PathBuf,
    version: String,
    parent_identity: String,
}

fn draft_version(identity: file_id::FileId, bytes: u64, modified: std::time::SystemTime) -> String {
    format!("{identity:?}:{bytes}:{modified:?}")
}

fn validate_draft_target<R: Runtime>(app: &AppHandle<R>, draft: &DraftFile) -> Result<file_id::FileId, String> {
    let error = "原草稿已被修改、移动或无法写入，请重新打开草稿或另存为";
    let raw = draft.path.to_str().ok_or(error)?;
    let roots = std::slice::from_ref(&draft.path);
    if authorize_existing_plain_file_with_roots(app, raw, roots).ok().as_ref() != Some(&draft.path)
        || authorize_path_with_roots(app, raw, PathAccess::Write, roots).ok().as_ref() != Some(&draft.path)
    {
        return Err(error.into());
    }
    let metadata = regular_file(&draft.path).map_err(|_| error)?;
    let identity = file_id::get_file_id(&draft.path).map_err(|_| error)?;
    let modified = metadata.modified().map_err(|_| error)?;
    if draft_version(identity, metadata.len(), modified) != draft.version {
        return Err(error.into());
    }
    Ok(identity)
}

pub(super) fn open_draft<R: Runtime>(
    app: &AppHandle<R>,
    selection: &UiSliceSelection,
    source_path: &str,
    assume_srgb: bool,
    cancel: &CancellationToken,
) -> Result<Value, String> {
    let source = read_snapshot(app, source_path, assume_srgb, cancel)?;
    let archive_path = selection.path.to_str().ok_or("工作稿文件名无效")?;
    let roots = std::slice::from_ref(&selection.path);
    let path = authorize_existing_plain_file_with_roots(app, archive_path, roots)
        .map_err(|_| "工作稿文件未获原生读授权")?;
    if path != selection.path { return Err("所选工作稿已变化，请重新选择".into()); }
    let parent = path.parent().ok_or("无法定位工作稿所在目录")?;
    let parent_id = file_id::get_file_id(parent).map_err(|_| "无法确认工作稿所在目录")?;
    let identity = selection.identity;
    let mut file = open_for_read(&path).map_err(|_| "无法打开工作稿文件")?;
    let metadata = file.metadata().map_err(|_| "无法读取工作稿文件信息")?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) || metadata.len() == 0
        || metadata.len() > MAX_ARCHIVE_BYTES || opened_file_id(&file).ok() != Some(identity)
        || authorize_existing_plain_file_with_roots(app, archive_path, roots).ok().as_ref() != Some(&path)
    {
        return Err("工作稿文件类型、大小或身份无效".into());
    }
    let modified = metadata.modified().map_err(|_| "无法读取工作稿修改时间")?;
    let mut end = [0u8; 22];
    file.seek(SeekFrom::End(-22)).map_err(|_| "工作稿 ZIP 尾部无效")?;
    file.read_exact(&mut end).map_err(|_| "工作稿 ZIP 尾部无效")?;
    let entry_count = u16::from_le_bytes([end[10], end[11]]) as usize;
    if &end[..4] != b"PK\x05\x06" || end[4..8] != [0, 0, 0, 0]
        || end[8..10] != end[10..12] || end[20..22] != [0, 0]
        || entry_count > pixels::MAX_ITEMS + 3
    {
        return Err("工作稿 ZIP 不支持分卷、注释或 ZIP64".into());
    }
    file.rewind().map_err(|_| "无法读取工作稿 ZIP")?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|_| "工作稿 ZIP 无效")?;
    if archive.len() < 3 || archive.len() != entry_count {
        return Err("工作稿条目数无效".into());
    }
    let mut names = std::collections::HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "工作稿条目不可读")?;
        let name = entry.name();
        let allowed = matches!(name, "manifest.json" | "review.json" | "source.png")
            || (1..=pixels::MAX_ITEMS).any(|number| name == format!("assets/slice-{number:03}.png"));
        if !allowed || !names.insert(name.to_owned()) { return Err("工作稿包含重复或不支持的条目".into()); }
    }
    let manifest_bytes = read_zip_entry(&mut archive, "manifest.json", 4 * 1024 * 1024, cancel)?;
    let review_bytes = read_zip_entry(&mut archive, "review.json", 1024 * 1024, cancel)?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(|_| "工作稿清单无效")?;
    let review: Value = serde_json::from_slice(&review_bytes).map_err(|_| "工作稿审核记录无效")?;
    if !has_only_fields(&manifest, &["schema", "packId", "reviewSha256", "source", "assets", "instances", "missing"])
        || !has_only_fields(&manifest["source"], &["sha256", "rgbaSha256", "width", "height", "normalization", "file", "fileSha256"])
        || !has_only_fields(&review, &["schema", "normalization", "sourceSha256", "assumeSrgb", "items", "missing"])
        || manifest["schema"] != "ai-canvas-ui-slice/1" || review["schema"] != "ai-canvas-ui-slice-review/1"
        || manifest["reviewSha256"] != pixels::digest(&review_bytes)
        || manifest["packId"] != pixels::digest(&review_bytes)
        || manifest["source"]["file"] != "source.png"
        || manifest["source"]["rgbaSha256"] != source.pixel_digest
        || manifest["source"]["width"] != source.image.width()
        || manifest["source"]["height"] != source.image.height()
        || manifest["source"]["normalization"] != NORMALIZATION
        || !manifest["source"]["sha256"].as_str().is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        || review["normalization"] != NORMALIZATION
        || review["sourceSha256"] != manifest["source"]["sha256"]
        || review["assumeSrgb"].as_bool().is_none()
    { return Err("工作稿损坏或与当前图片不匹配".into()); }
    let source_bytes = read_zip_entry(&mut archive, "source.png", MAX_SOURCE_BYTES, cancel)?;
    if manifest["source"]["fileSha256"] != pixels::digest(&source_bytes) {
        return Err("工作稿原图摘要不匹配".into());
    }
    let original = decode_draft_png(&source_bytes)?;
    if original.dimensions() != source.image.dimensions() || original.as_raw() != source.image.as_raw() {
        return Err("工作稿原图与当前图片像素不同".into());
    }
    drop(original);
    let items: Vec<Item> = serde_json::from_value(review["items"].clone()).map_err(|_| "工作稿选区无效")?;
    pixels::validate_items(&items, &source.image)?;
    let missing: Vec<Missing> = serde_json::from_value(review.get("missing").cloned().unwrap_or_else(|| json!([])))
        .map_err(|_| "工作稿待补项无效")?;
    validate_missing(&missing)?;
    if manifest["missing"] != json!(missing) { return Err("工作稿待补项不一致".into()); }
    let assets = manifest["assets"].as_array().ok_or("工作稿素材清单无效")?;
    let instances = manifest["instances"].as_array().ok_or("工作稿实例清单无效")?;
    if assets.len() != items.len() || instances.len() != items.len() || names.len() != items.len() + 3 {
        return Err("工作稿素材数量不一致".into());
    }
    let mut scratch = Vec::with_capacity(render_capacity(&items));
    for (index, item) in items.iter().enumerate() {
        let id = format!("slice-{:03}", index + 1);
        let filename = format!("assets/{id}.png");
        let asset = &assets[index];
        if !has_only_fields(asset, &["assetId", "name", "file", "rect", "pixelClass", "rgbaSha256", "fileSha256"])
            || asset["assetId"] != id || asset["file"] != filename || asset["rect"] != json!(item.rect)
            || asset["name"] != item.label
            || asset["pixelClass"] != if item.rings.is_empty() { "exact-composite-rect" } else { "masked-source" }
            || instances[index] != json!({ "instanceId": format!("instance-{:03}", index + 1), "assetId": id, "rect": item.rect })
        { return Err("工作稿素材与选区不一致".into()); }
        let encoded = read_zip_entry(&mut archive, &filename, MAX_SOURCE_BYTES, cancel)?;
        if asset["fileSha256"] != pixels::digest(&encoded) { return Err("工作稿素材摘要不匹配".into()); }
        let actual = decode_draft_png(&encoded)?;
        scratch.resize(item.rect.width() as usize * item.rect.height() as usize * 4, 0);
        pixels::render(&source.image, item, &mut scratch, cancel)?;
        if actual.dimensions() != (item.rect.width(), item.rect.height())
            || actual.as_raw() != &scratch || asset["rgbaSha256"] != pixels::digest(&scratch)
        { return Err("工作稿素材像素与选区不一致".into()); }
    }
    let file = archive.into_inner().into_inner();
    let current = file.metadata().map_err(|_| "无法核对工作稿文件")?;
    if current.len() != metadata.len() || current.modified().ok() != Some(modified)
        || file_id::get_file_id(&path).ok() != Some(identity)
        || file_id::get_file_id(parent).ok() != Some(parent_id)
        || authorize_existing_plain_file_with_roots(app, archive_path, roots).ok().as_ref() != Some(&path)
    { return Err("工作稿读取期间已改变".into()); }
    let mut result = inspect_snapshot(&source, cancel)?;
    result["items"] = json!(items);
    result["missing"] = json!(missing);
    result["draft"] = json!(DraftFile {
        path, version: draft_version(identity, metadata.len(), modified), parent_identity: format!("{parent_id:?}"),
    });
    Ok(result)
}

struct ExportDirectory {
    path: PathBuf,
    identity: file_id::FileId,
    #[cfg(windows)]
    _leases: Vec<File>,
    #[cfg(not(windows))]
    anchor: AnchoredDirectory,
}

impl ExportDirectory {
    fn open(path: PathBuf, expected: file_id::FileId) -> Result<Self, String> {
        #[cfg(windows)]
        let directory = {
            let leases = path.ancestors().filter(|path| !path.as_os_str().is_empty())
                .collect::<Vec<_>>().into_iter().rev()
                .map(|ancestor| crate::native_project_media::lease_directory(ancestor, ancestor == path))
                .collect::<Result<Vec<_>, _>>().map_err(|_| "无法锁定导出目录路径")?;
            Self { path, identity: expected, _leases: leases }
        };
        #[cfg(not(windows))]
        let directory = {
            let anchor = AnchoredDirectory::open(&path).map_err(|_| "无法固定导出目录")?;
            if anchor.identity().ok() != Some(expected) { return Err("所选导出目录已变化".into()); }
            Self { path, identity: expected, anchor }
        };
        directory.verify()?;
        Ok(directory)
    }

    fn verify(&self) -> Result<(), String> {
        #[cfg(windows)]
        if file_id::get_file_id(&self.path).ok() != Some(self.identity) {
            return Err("导出目录已变化".into());
        }
        #[cfg(not(windows))]
        self.anchor.verify().map_err(|_| "导出目录已变化")?;
        Ok(())
    }

    fn open_file(&self, name: &OsStr) -> std::io::Result<File> {
        #[cfg(windows)]
        { open_for_read(&self.path.join(name)) }
        #[cfg(not(windows))]
        { self.anchor.open_file(name) }
    }

    fn current(&self, name: &OsStr) -> Result<Option<(file_id::FileId, fs::Metadata)>, String> {
        #[cfg(windows)]
        let entry = {
            let path = self.path.join(name);
            fs::symlink_metadata(&path).and_then(|meta| {
                if !meta.is_file() || is_link_or_reparse(&meta) { return Err(std::io::ErrorKind::InvalidData.into()); }
                Ok((file_id::get_file_id(path)?, meta))
            })
        };
        #[cfg(not(windows))]
        let entry = self.open_file(name).and_then(|file| Ok((opened_file_id(&file)?, file.metadata()?)));
        match entry {
            Ok((identity, metadata)) if metadata.is_file() && !is_link_or_reparse(&metadata) => Ok(Some((identity, metadata))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => Err("目标归档无法核对或不是普通文件".into()),
        }
    }

    fn matches(&self, name: &OsStr, identity: file_id::FileId, bytes: u64, modified: std::time::SystemTime) -> bool {
        self.current(name).ok().flatten().is_some_and(|(entry_id, metadata)| {
            entry_id == identity && metadata.len() == bytes && metadata.modified().ok() == Some(modified)
        })
    }

    fn create_stage(&self, name: OsString) -> Result<(File, StagedArchive<'_>), String> {
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            use windows::Win32::Storage::FileSystem::{
                DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
            };
            OpenOptions::new().create_new(true).write(true).read(true)
                .access_mode(DELETE.0 | FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).share_mode(0)
                .open(self.path.join(&name))
        };
        #[cfg(not(windows))]
        let file = self.anchor.create_file(&name);
        let file = file.map_err(|_| "无法在所选目录建立独占暂存档")?;
        let identity = opened_file_id(&file).map_err(|_| "无法确认暂存档身份")?;
        Ok((file, StagedArchive { directory: self, name, identity }))
    }

    fn remove_owned(&self, name: &OsStr, identity: file_id::FileId) -> Result<(), String> {
        if !self.current(name)?.is_some_and(|(entry_id, _)| entry_id == identity) { return Ok(()); }
        #[cfg(windows)]
        fs::remove_file(self.path.join(name)).map_err(|_| "无法移除暂存档")?;
        #[cfg(not(windows))]
        self.anchor.remove_file(name).map_err(|_| "无法移除暂存档")?;
        Ok(())
    }

    #[cfg(not(windows))]
    fn replace_draft(
        &self, stage: &StagedArchive<'_>, target: &OsStr, draft: &DraftFile, old: file_id::FileId,
    ) -> Result<(), String> {
        let error = "无法安全覆盖原草稿，请检查目录后重新打开草稿";
        let matches_old = |name| -> Result<bool, String> {
            let (identity, metadata) = self.current(name)?.ok_or(error)?;
            let modified = metadata.modified().map_err(|_| error)?;
            Ok(identity == old && draft_version(identity, metadata.len(), modified) == draft.version)
        };
        if !matches_old(target)? { return Err(error.into()); }
        self.verify()?;
        self.anchor.rename_file(&stage.name, target, true).map_err(|_| error)?;
        let new_is_target = || self.current(target).ok().flatten().is_some_and(|(identity, _)| identity == stage.identity);
        if !new_is_target() || self.anchor.sync().is_err() || self.verify().is_err() || matches_old(&stage.name) != Ok(true) {
            // 交换不会删除后来替换的目标。还能确认新稿位置时，把两个名字各归原位。
            if new_is_target() { let _ = self.anchor.rename_file(&stage.name, target, true); }
            return Err(error.into());
        }
        self.anchor.remove_file(&stage.name).map_err(|_| error)?;
        self.anchor.sync().map_err(|_| error)?;
        self.verify()
    }
}

struct StagedArchive<'a> {
    directory: &'a ExportDirectory,
    name: OsString,
    identity: file_id::FileId,
}

fn render_capacity(items: &[Item]) -> usize {
    items.iter().map(|item| item.rect.width() as usize * item.rect.height() as usize * 4)
        .max().unwrap_or(0)
}

impl Drop for StagedArchive<'_> {
    fn drop(&mut self) {
        let _ = self.directory.remove_owned(&self.name, self.identity);
    }
}

fn validate_export_directory<R: Runtime>(app: &AppHandle<R>, selection: &UiSliceSelection) -> Result<(), String> {
    let error = "导出目录未获授权或已变化";
    let resolved = reauthorize_existing_plain_directory_with_roots(app, &selection.path, std::slice::from_ref(&selection.path))
        .map_err(|_| error)?;
    if resolved != selection.path || file_id::get_file_id(&resolved).ok() != Some(selection.identity) {
        return Err(error.into());
    }
    Ok(())
}

fn hash_stream(
    reader: &mut impl Read,
    limit: u64,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let mut sha = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0;
    loop {
        pixels::check_cancelled(cancel)?;
        let count = reader.read(&mut buffer).map_err(|_| "切图归档回读失败")?;
        if count == 0 {
            return Ok(format!("{:x}", sha.finalize()));
        }
        total += count as u64;
        if total > limit {
            return Err("切图归档回读超限".into());
        }
        sha.update(&buffer[..count]);
    }
}

fn verify_archive(
    file: &mut File,
    entries: &[(String, String)],
    cancel: &CancellationToken,
) -> Result<String, String> {
    file.rewind().map_err(|_| "无法回读暂存档")?;
    let mut zip = ZipArchive::new(BufReader::new(&mut *file)).map_err(|_| "无法解析暂存档")?;
    if zip.len() != entries.len() {
        return Err("切图归档条目数不一致".into());
    }
    for (index, (name, digest)) in entries.iter().enumerate() {
        let mut entry = zip.by_index(index).map_err(|_| "切图归档条目不可读")?;
        if entry.name() != name || hash_stream(&mut entry, MAX_ARCHIVE_BYTES, cancel)? != *digest {
            return Err("切图归档条目摘要不一致".into());
        }
    }
    drop(zip);
    file.rewind().map_err(|_| "无法核对暂存档")?;
    hash_stream(&mut BufReader::new(file), MAX_ARCHIVE_BYTES, cancel)
}

pub(super) enum Destination<'a> {
    Directory(&'a UiSliceSelection),
    NewDraft(&'a UiSliceSelection),
    OverwriteDraft(&'a DraftFile),
}

pub(super) struct Publish<'a> {
    pub source: &'a str,
    pub destination: Destination<'a>,
    pub source_sha256: &'a str,
    pub assume_srgb: bool,
    pub items: &'a [Item],
    pub missing: &'a [Missing],
    pub include_source: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Missing {
    name: String,
    reason: String,
    #[serde(rename = "box", default, skip_serializing_if = "Option::is_none")]
    bounds: Option<[u16; 4]>,
}

fn validate_missing(missing: &[Missing]) -> Result<(), String> {
    if missing.len() > 256 {
        return Err("待补项超过 256 项".into());
    }
    for gap in missing {
        if gap.name.trim().is_empty() || gap.name.chars().count() > 64
            || gap.reason.trim().is_empty() || gap.reason.chars().count() > 120
            || gap.name.chars().any(char::is_control) || gap.reason.chars().any(char::is_control)
            || gap.bounds.is_some_and(|[x0, y0, x1, y1]| {
                x0 >= x1 || y0 >= y1 || x1 > 1000 || y1 > 1000
            })
        {
            return Err("待补项名称、原因或位置无效".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn replace_windows_draft(file: &File, target: &Path) -> Result<(), String> {
    use std::{mem::{offset_of, size_of}, os::windows::{ffi::OsStrExt, io::AsRawHandle}, ptr};
    use windows::Win32::{Foundation::{BOOLEAN, HANDLE}, Storage::FileSystem::{
        FILE_RENAME_INFO, FileRenameInfo, SetFileInformationByHandle,
    }};
    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let error = "无法覆盖原草稿，文件可能正被占用";
    if !target.is_absolute() || name.contains(&0) {
        return Err(error.into());
    }
    let name_bytes = name.len() * size_of::<u16>();
    let record_bytes = offset_of!(FILE_RENAME_INFO, FileName) + name_bytes + size_of::<u16>();
    let mut storage = vec![0_usize; record_bytes.max(size_of::<FILE_RENAME_INFO>()).div_ceil(size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let name_bytes = u32::try_from(name_bytes).map_err(|_| error)?;
    let record_bytes = u32::try_from(record_bytes).map_err(|_| error)?;
    unsafe {
        (*info).Anonymous.ReplaceIfExists = BOOLEAN(1);
        (*info).FileNameLength = name_bytes;
        ptr::copy_nonoverlapping(name.as_ptr(), ptr::addr_of_mut!((*info).FileName).cast(), name.len());
        SetFileInformationByHandle(HANDLE(file.as_raw_handle()), FileRenameInfo, info.cast(), record_bytes)
    }.map_err(|_| error.into())
}

pub(super) fn publish<R: Runtime>(
    app: &AppHandle<R>,
    params: Publish<'_>,
    request_id: &str,
    cancel: &CancellationToken,
    commit: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<Value, String> {
    let (directory, selected_directory, new_draft, overwrite_draft) = match params.destination {
        Destination::Directory(selection) | Destination::NewDraft(selection) => {
            validate_export_directory(app, selection)?;
            let directory = ExportDirectory::open(selection.path.clone(), selection.identity)?;
            (directory, Some(selection), matches!(params.destination, Destination::NewDraft(_)), None)
        }
        Destination::OverwriteDraft(draft) => {
            validate_draft_target(app, draft)?;
            let path = draft.path.parent().ok_or("无法定位原草稿所在目录")?.to_path_buf();
            let identity = file_id::get_file_id(&path).map_err(|_| "无法确认导出目录身份")?;
            if format!("{identity:?}") != draft.parent_identity {
                return Err("原草稿所在目录已变化，请重新打开草稿".into());
            }
            (ExportDirectory::open(path, identity)?, None, false, Some(draft))
        }
    };
    let source = read_snapshot(app, params.source, params.assume_srgb, cancel)?;
    if source.raw_digest != params.source_sha256 {
        return Err("源图已改变，请重新打开切图界面".into());
    }
    pixels::validate_items(params.items, &source.image)?;
    validate_missing(params.missing)?;
    let mut review_value = json!({ "schema": "ai-canvas-ui-slice-review/1", "normalization": NORMALIZATION,
        "sourceSha256": source.raw_digest, "assumeSrgb": params.assume_srgb, "items": params.items });
    if !params.missing.is_empty() {
        review_value["missing"] = json!(params.missing);
    }
    let review = serde_json::to_vec(&review_value)
        .map_err(|_| "无法记录切图审核")?;
    let pack_id = pixels::digest(&review);
    let name = if let Some(draft) = overwrite_draft {
        draft.path.file_name().and_then(|name| name.to_str()).ok_or("原草稿文件名无效")?.to_owned()
    } else if new_draft {
        format!("ui-slice-draft-{request_id}.zip")
    } else if params.include_source {
        format!("ui-slice-draft-{}.zip", &pack_id[..24])
    } else {
        format!("ui-slice-{}.zip", &pack_id[..24])
    };
    let target_name = OsStr::new(&name);
    directory.verify()?;
    if let Some(draft) = overwrite_draft { validate_draft_target(app, draft)?; }
    let (file, stage) = directory.create_stage(format!(".ui-slice-{request_id}.pending").into())?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(zip::DateTime::default());
    let mut entries = Vec::with_capacity(params.items.len() + 3);
    let mut assets = Vec::with_capacity(params.items.len());
    let mut instances = Vec::with_capacity(params.items.len());
    let mut scratch = Vec::with_capacity(render_capacity(params.items));
    let mut encoded_bytes = 0;
    let mut source_file_sha256 = None;
    if params.include_source {
        let png = pixels::png(source.image.as_raw(), source.image.width(), source.image.height())?;
        if png.len() as u64 > MAX_SOURCE_BYTES {
            return Err("规范原图超过 64 MiB，请使用较小的图片".into());
        }
        let decoded = pixels::decode(&png, false)?;
        if decoded.dimensions() != source.image.dimensions() || decoded.as_raw() != source.image.as_raw() {
            return Err("规范原图回读像素不一致".into());
        }
        let digest = pixels::digest(&png);
        zip.start_file("source.png", options).map_err(|_| "原图条目写入失败")?;
        zip.write_all(&png).map_err(|_| "规范原图写入失败")?;
        encoded_bytes += png.len() as u64;
        entries.push(("source.png".into(), digest.clone()));
        source_file_sha256 = Some(digest);
    }
    for (index, item) in params.items.iter().enumerate() {
        pixels::check_cancelled(cancel)?;
        let (png, rgba_sha256) =
            pixels::render_verified(&source.image, item, &mut scratch, cancel)?;
        encoded_bytes += png.len() as u64;
        if encoded_bytes > MAX_ARCHIVE_BYTES {
            return Err("切图归档超过 512 MiB".into());
        }
        let asset_id = format!("slice-{:03}", index + 1);
        let path = format!("assets/{asset_id}.png");
        let file_sha256 = pixels::digest(&png);
        zip.start_file(&path, options)
            .map_err(|_| "切图片条目写入失败")?;
        zip.write_all(&png).map_err(|_| "切图片写入失败")?;
        assets.push(json!({
            "assetId": asset_id, "name": item.label, "file": path, "rect": item.rect,
            "pixelClass": if item.rings.is_empty() { "exact-composite-rect" } else { "masked-source" },
            "rgbaSha256": rgba_sha256, "fileSha256": file_sha256
        }));
        instances.push(json!({ "instanceId": format!("instance-{:03}", index + 1), "assetId": asset_id, "rect": item.rect }));
        entries.push((path, file_sha256));
    }
    let mut manifest_value = json!({
        "schema": "ai-canvas-ui-slice/1", "packId": pack_id, "reviewSha256": pixels::digest(&review),
        "source": { "sha256": source.raw_digest, "rgbaSha256": source.pixel_digest,
            "width": source.image.width(), "height": source.image.height(), "normalization": NORMALIZATION },
        "assets": assets, "instances": instances, "missing": params.missing
    });
    if let Some(digest) = source_file_sha256 {
        manifest_value["source"]["file"] = json!("source.png");
        manifest_value["source"]["fileSha256"] = json!(digest);
    }
    let manifest = serde_json::to_vec_pretty(&manifest_value).map_err(|_| "切图清单序列化失败")?;
    for (path, bytes) in [("review.json", &review), ("manifest.json", &manifest)] {
        zip.start_file(path, options)
            .map_err(|_| "切图清单条目写入失败")?;
        zip.write_all(bytes).map_err(|_| "切图清单写入失败")?;
        entries.push((path.to_string(), pixels::digest(bytes)));
    }
    let mut writer = zip.finish().map_err(|_| "切图归档封装失败")?;
    writer
        .flush()
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|_| "切图归档落盘失败")?;
    let meta = writer
        .get_ref()
        .metadata()
        .map_err(|_| "无法确认切图归档大小")?;
    let bytes = meta.len();
    let stage_modified = meta.modified().map_err(|_| "无法确认暂存档修改时间")?;
    if bytes > MAX_ARCHIVE_BYTES {
        return Err("切图归档超过 512 MiB".into());
    }
    let sha256 = verify_archive(writer.get_mut(), &entries, cancel)?;
    let matches_published =
        || -> Result<Option<(File, file_id::FileId, std::time::SystemTime)>, String> {
            let Some((identity, meta)) = directory.current(target_name)? else { return Ok(None); };
            if meta.len() != bytes {
                return Err("目标文件已存在，不能安全重用".into());
            }
            let mut file = directory.open_file(target_name).map_err(|_| "无法读取已有切图归档")?;
            let opened = file.metadata().map_err(|_| "无法读取已有切图归档")?;
            if opened_file_id(&file).ok() != Some(identity)
                || is_link_or_reparse(&opened)
                || !opened.is_file()
            {
                return Err("已有切图归档打开期间已变化".into());
            }
            if hash_stream(&mut BufReader::new(&mut file), bytes, cancel)? != sha256 {
                return Err("目标文件已存在且内容不同".into());
            }
            let modified = opened.modified().map_err(|_| "无法读取已有归档修改时间")?;
            if !directory.matches(target_name, identity, bytes, modified) {
                return Err("已有归档在回读期间已变化".into());
            }
            Ok(Some((file, identity, modified)))
        };
    let reused = if overwrite_draft.is_some() || new_draft { None } else { matches_published()? };
    commit(&mut || {
        pixels::check_cancelled(cancel)?;
        if let Some(selection) = selected_directory {
            validate_export_directory(app, selection)?;
        }
        directory.verify()?;
        if !directory.matches(&stage.name, stage.identity, bytes, stage_modified) {
            return Err("导出目录或暂存档已变化".into());
        }
        pixels::check_cancelled(cancel)?;
        if let Some(draft) = overwrite_draft {
            let _old_identity = validate_draft_target(app, draft)?;
            #[cfg(windows)]
            replace_windows_draft(writer.get_ref(), &directory.path.join(target_name))?;
            #[cfg(not(windows))]
            directory.replace_draft(&stage, target_name, draft, _old_identity)?;
        } else if let Some((_file, identity, modified)) = &reused {
            if !directory.matches(target_name, *identity, bytes, *modified) {
                return Err("已有切图归档在提交前已变化".into());
            }
        } else {
            #[cfg(windows)]
            let published =
                crate::native_project_media::rename_windows_media_file(writer.get_ref(), &directory.path.join(target_name))
                    .and_then(|_| {
                        writer
                            .get_ref()
                            .sync_all()
                            .map_err(|_| "切图归档落盘失败".into())
                    });
            #[cfg(not(windows))]
            let published = directory.anchor.rename_file(&stage.name, target_name, false).and_then(|_| {
                let result = directory.verify().and_then(|_| {
                    if !directory.matches(target_name, stage.identity, bytes, stage_modified) {
                        return Err("发布后的归档身份已变化".into());
                    }
                    directory.anchor.sync().map_err(|_| "切图归档落盘失败".into())
                }).and_then(|_| directory.verify());
                if result.is_err() { let _ = directory.remove_owned(target_name, stage.identity); }
                result
            });
            published.map_err(|_| "切图发布结果需核对。重试同一选区可校验已有整包")?;
        }
        directory.verify()
    })?;
    drop(writer);
    let mut receipt = json!({ "fileName": name, "assetCount": params.items.len(), "sha256": sha256, "bytes": bytes, "reused": reused.is_some() });
    if params.include_source {
        let error = "草稿保存后无法确认文件身份，请重新打开草稿";
        let identity = reused.as_ref().map_or(stage.identity, |(_, identity, _)| *identity);
        let (actual, metadata) = directory.current(target_name).map_err(|_| error)?.ok_or(error)?;
        if metadata.len() != bytes || actual != identity {
            return Err(error.into());
        }
        let version = draft_version(identity, bytes, metadata.modified().map_err(|_| error)?);
        let parent_identity = format!("{:?}", directory.identity);
        receipt["draft"] = json!(DraftFile { path: directory.path.join(target_name), version, parent_identity });
    }
    Ok(receipt)
}

#[cfg(all(test, feature = "tauri-channel-tests"))]
mod tests {
    use super::*;
    use tauri_plugin_fs::FsExt;

    fn select(path: &Path) -> UiSliceSelection {
        let path = crate::path_policy::canonicalize_simplified(path).unwrap();
        let identity = file_id::get_file_id(&path).unwrap();
        UiSliceSelection { path, identity }
    }

    #[cfg(any(target_os = "macos", all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))))]
    #[test]
    fn rejects_replaced_export_directory_and_cleans_only_its_own_stage() {
        let root = std::env::temp_dir().join(crate::comfyui::media_source::new_id().unwrap());
        let path = root.join("output");
        let moved = root.join("moved");
        let unrelated = root.join("unrelated");
        fs::create_dir_all(&path).unwrap();
        fs::create_dir(&unrelated).unwrap();
        let selection = select(&path);
        let directory = ExportDirectory::open(selection.path.clone(), selection.identity).unwrap();
        let name = ".ui-slice-relocate.pending";
        let (file, stage) = directory.create_stage(name.into()).unwrap();
        fs::write(unrelated.join(name), b"unrelated").unwrap();
        fs::rename(&path, &moved).unwrap();
        std::os::unix::fs::symlink(&unrelated, &path).unwrap();

        assert!(directory.verify().is_err());
        drop(file);
        drop(stage);
        assert!(!moved.join(name).exists());
        assert_eq!(fs::read(unrelated.join(name)).unwrap(), b"unrelated");

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(ExportDirectory::open(selection.path, selection.identity).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detailed_preview_retains_original_pixels_when_the_thumbnail_exceeds_its_budget() {
        let mut state = 1u32;
        let image = RgbaImage::from_fn(640, 360, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let [_, red, green, blue] = state.to_le_bytes();
            image::Rgba([red, green, blue, 255])
        });
        let snapshot = Snapshot {
            raw_digest: String::new(),
            pixel_digest: pixels::digest(image.as_raw()),
            image,
        };
        let result = inspect_snapshot(&snapshot, &CancellationToken::new()).unwrap();
        let thumbnail = STANDARD.decode(result["previewPngBase64"].as_str().unwrap()).unwrap();
        assert!(thumbnail.len() <= MAX_PREVIEW_BYTES);
        let mut encoded = String::new();
        for chunk in result["previewPngBase64Chunks"].as_array().unwrap() {
            let chunk = chunk.as_str().unwrap();
            assert!(chunk.len() <= 240_000);
            encoded.push_str(chunk);
        }
        let png = STANDARD.decode(encoded).unwrap();
        assert!(pixels::decode(&png, false).unwrap() == snapshot.image);
    }

    #[test]
    #[ignore = "requires an externally generated PS-Tidy interoperability fixture"]
    fn exchanges_ps_tidy_draft() {
        let fixture = PathBuf::from(std::env::var_os("UI_SLICE_INTEROP_DIR").expect("fixture directory"));
        let source = PathBuf::from(std::env::var_os("UI_SLICE_INTEROP_SOURCE").expect("fixture source"));
        let draft = fixture.join("payload").join("draft.zip");
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let scope = app.fs_scope();
        scope.allow_file(&source).unwrap();
        let token = CancellationToken::new();
        let restored = open_draft(app.handle(), &select(&draft), source.to_str().unwrap(), true, &token).unwrap();
        assert_eq!(restored["items"][0]["label"], "卡片");
        assert_eq!(restored["items"][0]["rings"].as_array().unwrap().len(), 2);
        assert_eq!(restored["missing"][0]["name"], "底板");
        let items: Vec<Item> = serde_json::from_value(restored["items"].clone()).unwrap();
        let missing: Vec<Missing> = serde_json::from_value(restored["missing"].clone()).unwrap();
        let source_sha256 = restored["sourceSha256"].as_str().unwrap();
        let result = publish(app.handle(), Publish {
            source: source.to_str().unwrap(), destination: Destination::Directory(&select(&fixture)), source_sha256,
            assume_srgb: true, items: &items, missing: &missing, include_source: true,
        }, "interop", &token, |commit| commit()).unwrap();
        assert!(fixture.join(result["fileName"].as_str().unwrap()).is_file());
    }

    #[test]
    fn inspects_and_publishes_verified_pixels_without_leaving_pending_files() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let root = std::env::temp_dir().join(crate::comfyui::media_source::new_id().unwrap());
        let directory = root.join("output");
        let source = root.join("source.png");
        fs::create_dir_all(&directory).unwrap();
        let rgba = [11, 22, 33, 255, 44, 55, 66, 0];
        let source_bytes = pixels::png(&rgba, 2, 1).unwrap();
        fs::write(&source, &source_bytes).unwrap();
        let scope = app.fs_scope();
        scope.allow_file(&source).unwrap();
        let selected_directory = select(&directory);

        let token = CancellationToken::new();
        let info = inspect(app.handle(), source.to_str().unwrap(), true, &token).unwrap();
        let source_sha256 = pixels::digest(&source_bytes);
        assert_eq!(info["sourceSha256"], source_sha256);
        assert_eq!((info["width"].as_u64(), info["height"].as_u64()), (Some(2), Some(1)));
        let items = serde_json::from_value::<Vec<Item>>(json!([{
            "label": "透明像素", "rect": {"x0": 1, "y0": 0, "x1": 2, "y1": 1}, "rings": []
        }])).unwrap();
        let missing = serde_json::from_value::<Vec<Missing>>(json!([{
            "name": "按钮底板", "reason": "被遮挡", "box": [1, 2, 500, 900]
        }])).unwrap();

        let publish_once = |request_id: &str, cancel: &CancellationToken| {
            publish(app.handle(), Publish {
                source: source.to_str().unwrap(), destination: Destination::Directory(&selected_directory),
                source_sha256: &source_sha256, assume_srgb: true, items: &items, missing: &missing, include_source: false,
            }, request_id, cancel, |commit| commit())
        };
        let receipt = publish_once("first", &token).unwrap();
        assert_eq!(receipt["assetCount"], 1);
        assert_eq!(receipt["reused"], false);
        let target = directory.join(receipt["fileName"].as_str().unwrap());
        let bytes = fs::read(&target).unwrap();
        assert_eq!(receipt["sha256"], pixels::digest(&bytes));
        {
            let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
            let mut png = Vec::new();
            archive.by_name("assets/slice-001.png").unwrap().read_to_end(&mut png).unwrap();
            assert_eq!(pixels::decode(&png, true).unwrap().as_raw(), &rgba[4..]);
            let manifest: Value = serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
            assert_eq!(manifest["assets"][0]["fileSha256"], pixels::digest(&png));
            assert_eq!(manifest["assets"][0]["rect"]["x0"], 1);
            assert_eq!(manifest["missing"][0]["name"], "按钮底板");
            let review: Value = serde_json::from_reader(archive.by_name("review.json").unwrap()).unwrap();
            assert_eq!(review["missing"], manifest["missing"]);
        }
        assert_eq!(publish_once("again", &token).unwrap()["reused"], true);
        let draft = publish(app.handle(), Publish {
            source: source.to_str().unwrap(), destination: Destination::Directory(&selected_directory),
            source_sha256: &source_sha256, assume_srgb: true, items: &items, missing: &missing, include_source: true,
        }, "draft", &token, |commit| commit()).unwrap();
        let draft_path = directory.join(draft["fileName"].as_str().unwrap());
        let restored = open_draft(app.handle(), &select(&draft_path), source.to_str().unwrap(), true, &token).unwrap();
        assert_eq!(restored["items"], json!(items));
        assert_eq!(restored["missing"], json!(missing));
        let named_draft = root.join("当前草稿.zip");
        fs::copy(&draft_path, &named_draft).unwrap();
        let opened = open_draft(app.handle(), &select(&named_draft), source.to_str().unwrap(), true, &token).unwrap();
        let overwrite: DraftFile = serde_json::from_value(opened["draft"].clone()).unwrap();
        let edited_items: Vec<Item> = serde_json::from_value(json!([{
            "label": "已编辑", "rect": {"x0": 0, "y0": 0, "x1": 1, "y1": 1}, "rings": []
        }])).unwrap();
        let save_edited = |destination, request_id| publish(app.handle(), Publish {
            source: source.to_str().unwrap(), destination, source_sha256: &source_sha256,
            assume_srgb: true, items: &edited_items, missing: &missing, include_source: true,
        }, request_id, &token, |commit| commit());
        let updated = save_edited(Destination::OverwriteDraft(&overwrite), "overwrite").unwrap();
        assert_eq!(updated["fileName"], "当前草稿.zip");
        assert!(save_edited(Destination::OverwriteDraft(&overwrite), "stale").is_err());
        let copy = save_edited(Destination::NewDraft(&selected_directory), "copy").unwrap();
        let second_copy = save_edited(Destination::NewDraft(&selected_directory), "copy-again").unwrap();
        assert_ne!(copy["fileName"], second_copy["fileName"]);
        assert_eq!(fs::read(&named_draft).unwrap(), fs::read(directory.join(copy["fileName"].as_str().unwrap())).unwrap());
        let reopened = open_draft(app.handle(), &select(&named_draft), source.to_str().unwrap(), true, &token).unwrap();
        assert_eq!(reopened["items"], json!(edited_items));
        fs::remove_file(named_draft).unwrap();
        for receipt in [copy, second_copy] {
            fs::remove_file(directory.join(receipt["fileName"].as_str().unwrap())).unwrap();
        }
        let mut original = ZipArchive::new(std::io::Cursor::new(fs::read(&draft_path).unwrap())).unwrap();
        let mut broken = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for index in 0..original.len() {
            let mut entry = original.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut content = Vec::new();
            entry.read_to_end(&mut content).unwrap();
            if name == "assets/slice-001.png" {
                content[0] ^= 1;
            }
            broken.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
            broken.write_all(&content).unwrap();
        }
        let broken_path = root.join("broken.zip");
        fs::write(&broken_path, broken.finish().unwrap().into_inner()).unwrap();
        assert!(open_draft(app.handle(), &select(&broken_path), source.to_str().unwrap(), true, &token).is_err());
        fs::remove_file(broken_path).unwrap();
        let mut duplicate = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for index in 0..original.len() {
            let mut entry = original.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut content = Vec::new();
            entry.read_to_end(&mut content).unwrap();
            duplicate.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
            duplicate.write_all(&content).unwrap();
        }
        duplicate.start_file("reviev.json", SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
        duplicate.write_all(b"{}").unwrap();
        let duplicate_path = root.join("duplicate.zip");
        let mut duplicate_bytes = duplicate.finish().unwrap().into_inner();
        let old_name = b"reviev.json";
        let new_name = b"review.json";
        for index in 0..=duplicate_bytes.len() - old_name.len() {
            if &duplicate_bytes[index..index + old_name.len()] == old_name {
                duplicate_bytes[index..index + new_name.len()].copy_from_slice(new_name);
            }
        }
        fs::write(&duplicate_path, duplicate_bytes).unwrap();
        assert!(open_draft(app.handle(), &select(&duplicate_path), source.to_str().unwrap(), true, &token).is_err());
        fs::remove_file(duplicate_path).unwrap();
        let other_source = root.join("other.png");
        fs::write(&other_source, pixels::png(&[0, 0, 0, 255, 44, 55, 66, 0], 2, 1).unwrap()).unwrap();
        scope.allow_file(&other_source).unwrap();
        assert!(open_draft(app.handle(), &select(&draft_path), other_source.to_str().unwrap(), true, &token).is_err());
        fs::remove_file(other_source).unwrap();
        fs::remove_file(draft_path).unwrap();
        token.cancel();
        assert!(publish_once("cancelled", &token).is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_file(target).unwrap();
        fs::remove_file(source).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
