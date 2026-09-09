//! 主窗口显式读取 Windows 剪贴板图片/文本；不读取文件路径或更改剪贴板。
use serde::Serialize;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_UNITS: usize = 100_000;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipboardContent {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
}

fn ensure_main_label(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("剪贴板读取仅允许主窗口调用".into())
    }
}

#[cfg(any(target_os = "windows", test))]
fn decode_text(bytes: &[u8]) -> Result<ClipboardContent, String> {
    if bytes.len() > (MAX_TEXT_UNITS + 1) * 2 || bytes.len() % 2 != 0 {
        return Err("剪贴板文本超过上限或编码无效".into());
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or("剪贴板文本缺少终止符")?;
    if end > MAX_TEXT_UNITS {
        return Err("剪贴板文本超过 100000 字".into());
    }
    let text = String::from_utf16(&units[..end]).map_err(|_| "剪贴板文本编码无效")?;
    Ok(ClipboardContent::Text { text })
}

#[cfg(any(target_os = "windows", test))]
fn encode_image<D: image::ImageDecoder>(mut decoder: D) -> Result<ClipboardContent, String> {
    use base64::Engine;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || decoder.total_bytes() > 128 * 1024 * 1024
    {
        return Err("剪贴板图像尺寸超过上限".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    decoder
        .set_limits(limits)
        .map_err(|_| "剪贴板图像超过解码上限")?;
    let image = image::DynamicImage::from_decoder(decoder).map_err(|_| "剪贴板图像解码失败")?;
    let mut output = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| "剪贴板图像编码失败")?;
    let png = output.into_inner();
    if png.len() > MAX_INPUT_BYTES {
        return Err("剪贴板图像超过 32 MiB".into());
    }
    Ok(ClipboardContent::Image {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ),
    })
}

#[cfg(any(target_os = "windows", test))]
fn decode_image(bytes: Vec<u8>, dib: bool) -> Result<ClipboardContent, String> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("剪贴板图像超过 32 MiB".into());
    }
    let cursor = std::io::Cursor::new(bytes);
    if dib {
        let decoder = image::codecs::bmp::BmpDecoder::new_without_file_header(cursor)
            .map_err(|_| "剪贴板位图无效")?;
        encode_image(decoder)
    } else {
        let decoder = image::codecs::png::PngDecoder::new(cursor).map_err(|_| "剪贴板 PNG 无效")?;
        encode_image(decoder)
    }
}

#[cfg(target_os = "windows")]
fn read_windows_clipboard() -> Result<ClipboardContent, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    struct ClipboardLease;
    impl Drop for ClipboardLease {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    struct MemoryLease(HGLOBAL);
    impl Drop for MemoryLease {
        fn drop(&mut self) {
            unsafe {
                let _ = GlobalUnlock(self.0);
            }
        }
    }

    // 只在占用剪贴板期间复制有界字节；昂贵的图像解码在关闭剪贴板后执行。
    let (format, bytes) = unsafe {
        OpenClipboard(None).map_err(|_| "剪贴板暂时被占用，请稍后重新调用")?;
        let _lease = ClipboardLease;
        let png = RegisterClipboardFormatW(windows::core::w!("PNG"));
        let formats = [png, 17, 8, 13]; // PNG、CF_DIBV5、CF_DIB、CF_UNICODETEXT
        let format = formats
            .into_iter()
            .find(|f| *f != 0 && IsClipboardFormatAvailable(*f).is_ok())
            .ok_or("剪贴板没有可读取的图片或文本；文件请使用媒体导入")?;
        let handle = GetClipboardData(format).map_err(|_| "剪贴板读取失败")?;
        let memory = HGLOBAL(handle.0);
        let size = GlobalSize(memory);
        let limit = if format == 13 {
            (MAX_TEXT_UNITS + 1) * 2
        } else {
            MAX_INPUT_BYTES
        };
        if size == 0 || size > limit {
            return Err("剪贴板内容为空或超过大小上限".into());
        }
        let pointer = GlobalLock(memory);
        if pointer.is_null() {
            return Err("剪贴板内存不可读取".into());
        }
        let _memory = MemoryLease(memory);
        (
            format,
            std::slice::from_raw_parts(pointer as *const u8, size).to_vec(),
        )
    };
    if format == 13 {
        decode_text(&bytes)
    } else {
        decode_image(bytes, format == 17 || format == 8)
    }
}

#[tauri::command]
pub async fn read_canvas_clipboard(webview: tauri::Webview) -> Result<ClipboardContent, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    ensure_main_label(webview.label())?;
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(read_windows_clipboard)
            .await
            .map_err(|_| "剪贴板读取任务失败")?
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("当前平台使用浏览器剪贴板接口".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_window_and_decodes_bounded_unicode() {
        assert!(ensure_main_label("main").is_ok());
        for label in ["chat-assistant", "plugin-1", "comfyui", ""] {
            assert!(ensure_main_label(label).is_err());
        }
        let bytes: Vec<u8> = "中文 test\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert!(
            matches!(decode_text(&bytes).unwrap(), ClipboardContent::Text { text } if text == "中文 test")
        );
        assert!(decode_text(&[0]).is_err());
        assert!(decode_text(&[1, 0]).is_err());
        assert!(decode_text(&vec![1; 200004]).is_err());
    }
    #[test]
    fn decodes_png_and_windows_dib_without_a_bitmap_file_header() {
        let image = image::DynamicImage::new_rgb8(2, 3);
        for format in [image::ImageFormat::Png, image::ImageFormat::Bmp] {
            let mut output = std::io::Cursor::new(Vec::new());
            image.write_to(&mut output, format).unwrap();
            let mut bytes = output.into_inner();
            if format == image::ImageFormat::Bmp {
                bytes = bytes[14..].to_vec();
            }
            assert!(
                matches!(decode_image(bytes, format == image::ImageFormat::Bmp).unwrap(), ClipboardContent::Image { data_url } if data_url.starts_with("data:image/png;base64,"))
            );
        }
        assert!(decode_image(vec![0; 40], true).is_err());
        assert!(decode_image(vec![0; 40], false).is_err());
    }
}
