//! Sprite Sheet 切帧导出：按等分宫格把整张图切成单帧，输出 GIF 动图或 PNG 序列帧。
//!
//! 目标扩展名决定格式：`.gif` 出一个动图，`.png` 出 `{stem}_00.png` 起的一组序列帧
//! （Unity / Godot 直接按序列帧导入，因此不额外生成 meta 文件）。

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use image::codecs::gif::{GifEncoder, Repeat};
use image::{Delay, Frame, RgbaImage};
use serde_json::json;

use crate::path_policy::{authorize_path, PathAccess};

const MAX_FRAMES: u32 = 256;

/// 按 cols×rows 等分切出前 frame_count 帧，顺序与生成时一致：从左到右、从上到下。
fn slice_frames(
    sheet: &RgbaImage,
    cols: u32,
    rows: u32,
    frame_count: u32,
) -> Result<Vec<RgbaImage>, String> {
    if cols == 0 || rows == 0 {
        return Err("宫格行列数必须大于 0".to_string());
    }
    if frame_count == 0 || frame_count > cols * rows {
        return Err(format!("帧数 {frame_count} 超出 {cols}×{rows} 宫格容量"));
    }

    // 整除取整：余下的几个像素留在右/下边缘，避免逐格累积偏移把后面的帧切歪
    let cell_width = sheet.width() / cols;
    let cell_height = sheet.height() / rows;
    if cell_width == 0 || cell_height == 0 {
        return Err(format!(
            "Sprite Sheet {}×{} 太小，无法按 {cols}×{rows} 切分",
            sheet.width(),
            sheet.height()
        ));
    }

    Ok((0..frame_count)
        .map(|index| {
            let x = (index % cols) * cell_width;
            let y = (index / cols) * cell_height;
            image::imageops::crop_imm(sheet, x, y, cell_width, cell_height).to_image()
        })
        .collect())
}

// ponytail: GIF 只有 1 位透明和 256 色，用来预览和分享够了；要保真就导 PNG 序列帧。
fn write_gif(frames: &[RgbaImage], fps: u32, output: &Path) -> Result<(), String> {
    let file = File::create(output).map_err(|error| format!("创建 GIF 文件失败: {error}"))?;
    let mut encoder = GifEncoder::new(BufWriter::new(file));
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|error| format!("设置 GIF 循环失败: {error}"))?;

    let delay = Delay::from_numer_denom_ms(1000, fps);
    for (index, frame) in frames.iter().enumerate() {
        encoder
            .encode_frame(Frame::from_parts(frame.clone(), 0, 0, delay))
            .map_err(|error| format!("写入第 {} 帧失败: {error}", index + 1))?;
    }
    drop(encoder); // 丢弃编码器才会写出 GIF 尾块并 flush BufWriter
    Ok(())
}

fn write_png_sequence(frames: &[RgbaImage], output: &Path) -> Result<Vec<String>, String> {
    let parent = output.parent().ok_or("无法解析导出目录".to_string())?;
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("frame");

    frames
        .iter()
        .enumerate()
        .map(|(index, frame)| {
            let path = parent.join(format!("{stem}_{index:02}.png"));
            frame
                .save(&path)
                .map_err(|error| format!("保存第 {} 帧失败: {error}", index + 1))?;
            Ok(path.to_string_lossy().into_owned())
        })
        .collect()
}

/// 把 Sprite Sheet 切帧导出。`output_path` 的扩展名决定格式：`.gif` / `.png`。
#[tauri::command]
pub async fn export_sprite_frames(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input_path: String,
    output_path: String,
    cols: u32,
    rows: u32,
    frame_count: u32,
    fps: u32,
) -> Result<String, String> {
    crate::path_policy::ensure_trusted_caller(&webview)?;
    let input = authorize_path(&app, &input_path, PathAccess::Read)?;
    if !input.is_file() {
        return Err(format!("Sprite Sheet 不存在: {input_path}"));
    }
    let output = authorize_path(&app, &output_path, PathAccess::Write)?;

    if !(1..=60).contains(&fps) {
        return Err(format!("帧率 {fps} 超出 1–60 范围"));
    }
    if frame_count > MAX_FRAMES {
        return Err(format!("帧数 {frame_count} 超出上限 {MAX_FRAMES}"));
    }

    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let sheet = image::open(&input)
        .map_err(|error| format!("读取 Sprite Sheet 失败: {error}"))?
        .to_rgba8();
    let frames = slice_frames(&sheet, cols, rows, frame_count)?;
    let frame_width = frames[0].width();
    let frame_height = frames[0].height();

    let files = match extension.as_str() {
        "gif" => {
            write_gif(&frames, fps, &output)?;
            vec![output.to_string_lossy().into_owned()]
        }
        "png" => write_png_sequence(&frames, &output)?,
        other => {
            return Err(format!(
                "不支持的导出格式 .{other}，请选择 .gif 或 .png"
            ))
        }
    };

    Ok(json!({
        "files": files,
        "frame_width": frame_width,
        "frame_height": frame_height,
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张 4×2 宫格，每格 3×5 像素，格内填该格序号作为红通道。
    fn numbered_sheet() -> RgbaImage {
        RgbaImage::from_fn(12, 10, |x, y| {
            let index = (y / 5) * 4 + (x / 3);
            image::Rgba([index as u8, 0, 0, 255])
        })
    }

    #[test]
    fn slices_cells_in_row_major_order() {
        let frames = slice_frames(&numbered_sheet(), 4, 2, 8).expect("应切出 8 帧");
        assert_eq!(frames.len(), 8);
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(frame.dimensions(), (3, 5));
            assert_eq!(frame.get_pixel(0, 0)[0], index as u8, "第 {index} 帧位置不对");
        }
    }

    #[test]
    fn slices_only_the_requested_leading_frames() {
        let frames = slice_frames(&numbered_sheet(), 4, 2, 6).expect("应切出 6 帧");
        assert_eq!(frames.len(), 6);
        assert_eq!(frames[5].get_pixel(0, 0)[0], 5);
    }

    #[test]
    fn writes_a_readable_gif_and_a_png_per_frame() {
        let directory = std::env::temp_dir().join(format!(
            "ai-canvas-sprite-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时间应晚于 UNIX epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("应创建测试目录");
        let frames = slice_frames(&numbered_sheet(), 4, 2, 8).expect("应切出 8 帧");

        let gif_path = directory.join("walk.gif");
        write_gif(&frames, 12, &gif_path).expect("应写出 GIF");
        // 编码器必须已 flush 并写完尾块，否则这里解不出 8 帧
        let decoded = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(
            File::open(&gif_path).expect("应打开 GIF"),
        ))
        .expect("应解码 GIF");
        assert_eq!(image::AnimationDecoder::into_frames(decoded).count(), 8);

        let png_path = directory.join("walk.png");
        let files = write_png_sequence(&frames, &png_path).expect("应写出序列帧");
        assert_eq!(files.len(), 8);
        assert!(directory.join("walk_00.png").is_file());
        assert!(directory.join("walk_07.png").is_file());

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn rejects_invalid_grids() {
        let sheet = numbered_sheet();
        assert!(slice_frames(&sheet, 4, 2, 9).is_err(), "帧数超容量应报错");
        assert!(slice_frames(&sheet, 4, 2, 0).is_err(), "0 帧应报错");
        assert!(slice_frames(&sheet, 0, 2, 4).is_err(), "0 列应报错");
        assert!(slice_frames(&sheet, 40, 2, 4).is_err(), "格子小于 1px 应报错");
    }
}
