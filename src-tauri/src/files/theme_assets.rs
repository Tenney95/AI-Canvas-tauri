//! 固定安装目录的外观图片：二进制上传、内容寻址与只读图片协议。
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use tauri::{
    http::{header, Request, Response, StatusCode},
    ipc::{InvokeBody, Request as IpcRequest},
    AppHandle, Manager, Runtime, UriSchemeContext, Webview,
};
use crate::path_policy::{authorize_theme_asset_file, ensure_trusted_caller};

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn image_extension(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("背景图片须大于 0 字节且不能超过 5MB".into());
    }
    let format = image::guess_format(bytes).ok();
    let extension = match format {
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::Jpeg) => "jpg",
        Some(image::ImageFormat::WebP) => "webp",
        _ => {
            let svg = std::str::from_utf8(bytes).map_err(|_| "仅支持 PNG、JPG、WebP 或 SVG 图片")?;
            if !svg.trim_start_matches('\u{feff}').trim_start().starts_with('<') || !svg.contains("<svg") {
                return Err("仅支持 PNG、JPG、WebP 或 SVG 图片".into());
            }
            return Ok("svg");
        },
    };
    let dimensions = image::ImageReader::with_format(Cursor::new(bytes), format.ok_or("图片格式无效")?)
        .into_dimensions().map_err(|_| "图片内容无效")?;
    if dimensions.0 == 0 || dimensions.1 == 0 || u64::from(dimensions.0) * u64::from(dimensions.1) > 100_000_000 {
        return Err("图片尺寸无效或过大".into());
    }
    Ok(extension)
}

fn image_name(bytes: &[u8]) -> Result<String, String> {
    let extension = image_extension(bytes)?;
    Ok(format!("{:x}.{extension}", Sha256::digest(bytes)))
}

fn read_image<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<Vec<u8>, String> {
    let path = authorize_theme_asset_file(app, name, false)?;
    let file = File::open(path).map_err(|_| "主题图片不可读取")?;
    let mut bytes = Vec::new();
    file.take((MAX_IMAGE_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|_| "主题图片读取失败")?;
    if image_name(&bytes)? != name {
        return Err("主题图片不存在或已损坏，请重新上传".into());
    }
    Ok(bytes)
}

fn write_image<R: Runtime>(app: &AppHandle<R>, bytes: &[u8]) -> Result<String, String> {
    let name = image_name(bytes)?;
    let _guard = WRITE_LOCK.lock().map_err(|_| "主题图片保存服务不可用")?;
    let target = authorize_theme_asset_file(app, &name, true)?;
    if target.exists() {
        if read_image(app, &name).is_ok() { return Ok(name); }
        // 用户重新上传原图时允许修复损坏的普通文件；不覆盖链接。
        authorize_theme_asset_file(app, &name, true)?;
    }
    let root = target.parent().ok_or("主题图片目录无效")?;
    let temporary = root.join(format!(".upload-{}-{}.tmp", std::process::id(), TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|_| "安装目录的 theme 文件夹不可写，请检查安装目录权限")?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "主题图片保存失败")?;
        drop(file);
        authorize_theme_asset_file(app, &name, true)?;
        fs::rename(&temporary, &target).map_err(|_| "主题图片保存失败")?;
        Ok(name)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[tauri::command]
pub async fn store_theme_image(app: AppHandle, webview: Webview, request: IpcRequest<'_>) -> Result<String, String> {
    ensure_trusted_caller(&webview)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_IMAGE_BYTES => bytes.clone(),
        _ => return Err("主题图片上传格式无效或超过 5MB".into()),
    };
    tauri::async_runtime::spawn_blocking(move || write_image(&app, &bytes))
        .await.map_err(|_| "主题图片保存任务失败")?
}

pub fn handle_protocol<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let result = (|| {
        if !matches!(context.webview_label(), "main" | "asset-search" | "chat-assistant" | "video-editor" | "style-guide" | "comfyui-settings") {
            return Err("forbidden");
        }
        let view = context.app_handle().get_webview_window(context.webview_label()).ok_or("forbidden")?;
        // 图片预览窗口只读；同样拒绝导航到远程页面的窗口。
        let url = view.url().map_err(|_| "forbidden")?;
        let is_local = matches!(url.scheme(), "tauri" | "file")
            || matches!(url.scheme(), "http" | "https") && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "tauri.localhost"));
        if !is_local {
            return Err("forbidden");
        }
        if request.method() != "GET" { return Err("forbidden"); }
        let name = request.uri().path().strip_prefix('/').ok_or("invalid reference")?;
        let bytes = read_image(context.app_handle(), name).map_err(|_| "image unavailable")?;
        let mime = match name.rsplit('.').next() {
            Some("png") => "image/png", Some("jpg") => "image/jpeg",
            Some("webp") => "image/webp", Some("svg") => "image/svg+xml", _ => return Err("invalid reference"),
        };
        Ok((bytes, mime))
    })();
    match result {
        Ok((bytes, mime)) => Response::builder().status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-cache")
            .header("X-Content-Type-Options", "nosniff")
            // 即便直接导航到 SVG，也不能执行脚本、联网或成为有能力的页面。
            .header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
            .body(bytes).unwrap_or_else(|_| Response::new(Vec::new())),
        Err(_) => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_policy::is_theme_asset_name;

    #[test]
    fn references_cannot_address_paths_or_non_images() {
        let name = format!("{}.svg", "a".repeat(64));
        assert!(is_theme_asset_name(&name));
        for invalid in ["../secrets/key", "a.svg", "/tmp/file.png", "a.js", "a.png/../key"] {
            assert!(!is_theme_asset_name(invalid));
        }
        assert!(!is_theme_asset_name(&format!("{}.html", "a".repeat(64))));
        assert!(!is_theme_asset_name(&format!("{}.png", "A".repeat(64))));
    }

    #[test]
    fn svg_names_depend_on_content_and_uploads_are_bounded() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"/>"#;
        assert_eq!(image_name(svg).unwrap(), format!("{:x}.svg", Sha256::digest(svg)));
        assert!(image_extension(b"<html/>").is_err());
        assert!(image_extension(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
    }
}
