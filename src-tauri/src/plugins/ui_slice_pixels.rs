use image::{
    codecs::png::PngEncoder, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat,
    ImageReader, RgbaImage,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use tokio_util::sync::CancellationToken;

pub(super) const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const MAX_ITEMS: usize = 128;
pub(super) const NORMALIZATION: &str = "srgb-rgba8-exif-v1";
const MAX_PIXELS: u64 = 32_000_000;
const MAX_EDGE: u32 = 8192;
const MAX_VERTICES: usize = 128;
const MAX_ASSET_PIXELS: u64 = 8_000_000;
const MAX_TOTAL_PIXELS: u64 = 64_000_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rect {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
}

impl Rect {
    pub(super) fn width(self) -> u32 {
        self.x1 - self.x0
    }
    pub(super) fn height(self) -> u32 {
        self.y1 - self.y0
    }

    fn valid(self, width: u32, height: u32) -> bool {
        self.x0 < self.x1 && self.y0 < self.y1 && self.x1 <= width && self.y1 <= height
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Item {
    pub label: String,
    pub rect: Rect,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rings: Vec<Vec<[u32; 2]>>,
}

pub(super) fn check_cancelled(cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("切图操作已取消".into())
    } else {
        Ok(())
    }
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify_png_color(bytes: &[u8], assume_srgb: bool) -> Result<(), String> {
    let mut remaining = bytes.get(8..).ok_or("PNG 签名不完整")?;
    let mut tagged_srgb = false;
    let mut gamma = None;
    let mut chromaticity = None;
    while remaining.len() >= 12 {
        let len = u32::from_be_bytes(remaining[..4].try_into().expect("four bytes")) as usize;
        let data = remaining
            .get(8..8usize.checked_add(len).ok_or("PNG 区块无效")?)
            .ok_or("PNG 区块不完整")?;
        match &remaining[4..8] {
            b"IHDR" if data.get(8).is_some_and(|depth| *depth > 8) => {
                return Err("当前切图支持最高 8 位 PNG".into());
            }
            b"iCCP" | b"mDCv" | b"cLLi" | b"cICP" => {
                return Err("请先将带自定义色彩配置或 HDR 的 PNG 转换为 sRGB".into());
            }
            b"acTL" | b"fdAT" | b"fcTL" => return Err("当前切图支持静态 PNG".into()),
            b"sRGB" => tagged_srgb = true,
            b"gAMA" => gamma = Some(data),
            b"cHRM" => chromaticity = Some(data),
            b"IEND" => {
                const SRGB_GAMMA: [u8; 4] = 45_455u32.to_be_bytes();
                const SRGB_CHROMATICITY: [u8; 32] = [
                    0, 0, 122, 38, 0, 0, 128, 132, 0, 0, 250, 0, 0, 0, 128, 232, 0, 0, 117, 48, 0,
                    0, 234, 96, 0, 0, 58, 152, 0, 0, 23, 112,
                ];
                if !tagged_srgb
                    && (gamma.is_some_and(|g| g != SRGB_GAMMA)
                        || chromaticity.is_some_and(|c| c != SRGB_CHROMATICITY))
                {
                    return Err("请先将非标准颜色的 PNG 转换为 sRGB".into());
                }
                return if tagged_srgb || assume_srgb {
                    Ok(())
                } else {
                    Err("未标记色彩空间。请确认按 sRGB 读取".into())
                };
            }
            _ => {}
        }
        remaining = remaining
            .get(12usize.checked_add(len).ok_or("PNG 区块无效")?..)
            .ok_or("PNG 区块不完整")?;
    }
    Err("PNG 缺少结束区块".into())
}

pub(super) fn decode(bytes: &[u8], assume_srgb: bool) -> Result<RgbaImage, String> {
    let format = image::guess_format(bytes).map_err(|_| "无法识别图片格式")?;
    match format {
        ImageFormat::Png => verify_png_color(bytes, assume_srgb)?,
        ImageFormat::Jpeg if assume_srgb => {}
        ImageFormat::Jpeg => return Err("请确认按 sRGB 读取 JPEG".into()),
        _ => return Err("当前切图支持 PNG 和 JPEG".into()),
    }

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "无法读取图片头或图片超限")?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("图片超过 3200 万像素限制".into());
    }
    if format == ImageFormat::Jpeg
        && decoder
            .icc_profile()
            .map_err(|_| "无法读取 JPEG 色彩配置")?
            .is_some()
    {
        return Err("请先将带自定义色彩配置的 JPEG 转换为 sRGB PNG".into());
    }
    let orientation = decoder.orientation().map_err(|_| "无法读取图像方向")?;
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| "图像解码失败")?;
    image.apply_orientation(orientation);
    Ok(image.into_rgba8())
}

pub(super) fn validate_items(items: &[Item], source: &RgbaImage) -> Result<(), String> {
    if items.is_empty() || items.len() > MAX_ITEMS {
        return Err("请选择 1–128 个素材".into());
    }
    let mut total = 0;
    for item in items {
        let rect = item.rect;
        if !rect.valid(source.width(), source.height())
            || item.label.trim().is_empty()
            || item.label.chars().count() > 80
            || item.label.chars().any(char::is_control)
        {
            return Err("素材名称或原图坐标无效".into());
        }
        let pixels = u64::from(rect.width()) * u64::from(rect.height());
        total += pixels;
        if pixels > MAX_ASSET_PIXELS || total > MAX_TOTAL_PIXELS {
            return Err("单片或整批输出像素超限".into());
        }
        if item.rings.len() > 16
            || item.rings.iter().map(Vec::len).sum::<usize>() > MAX_VERTICES
            || item.rings.iter().any(|ring| {
                ring.len() < 3
                    || ring
                        .iter()
                        .any(|&[x, y]| x < rect.x0 || y < rect.y0 || x > rect.x1 || y > rect.y1)
            })
        {
            return Err("套索顶点超限或超出素材框".into());
        }
    }
    Ok(())
}

// 求交点右侧的第一个像素中心，整数除法保留像素中心恰好落在线上的约定。
fn crossing_column(lower: [u32; 2], upper: [u32; 2], row: u32) -> u32 {
    let dy = i64::from(upper[1] - lower[1]);
    let dx = i64::from(upper[0]) - i64::from(lower[0]);
    let denominator = 2 * dy;
    let numerator =
        i64::from(lower[0]) * denominator + (2 * i64::from(row - lower[1]) + 1) * dx - dy;
    (-(-numerator).div_euclid(denominator)) as u32
}

pub(super) fn render(
    source: &RgbaImage,
    item: &Item,
    out: &mut [u8],
    cancel: &CancellationToken,
) -> Result<(), String> {
    let rect = item.rect;
    let source_stride = source.width() as usize * 4;
    let target_stride = rect.width() as usize * 4;
    let mut crossings = [0u32; MAX_VERTICES];
    let mut covered = item.rings.is_empty();
    for (index, row) in out.chunks_exact_mut(target_stride).enumerate() {
        if index % 32 == 0 {
            check_cancelled(cancel)?;
        }
        let y = rect.y0 + index as u32;
        let start = y as usize * source_stride + rect.x0 as usize * 4;
        let src = &source.as_raw()[start..start + target_stride];
        if item.rings.is_empty() {
            row.copy_from_slice(src);
            continue;
        }
        row.fill(0);
        let mut count = 0;
        for ring in &item.rings {
            let mut previous = ring[ring.len() - 1];
            for &point in ring {
                let (lower, upper) = if previous[1] <= point[1] {
                    (previous, point)
                } else {
                    (point, previous)
                };
                if lower[1] <= y && y < upper[1] {
                    crossings[count] = crossing_column(lower, upper, y).clamp(rect.x0, rect.x1);
                    count += 1;
                }
                previous = point;
            }
        }
        crossings[..count].sort_unstable();
        for pair in crossings[..count].chunks_exact(2) {
            let start = (pair[0] - rect.x0) as usize * 4;
            let end = (pair[1] - rect.x0) as usize * 4;
            covered |= start < end;
            row[start..end].copy_from_slice(&src[start..end]);
        }
    }
    if !covered {
        return Err("套索未覆盖任何像素中心".into());
    }
    Ok(())
}

pub(super) fn png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut encoded = Vec::new();
    PngEncoder::new(&mut encoded)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|_| "PNG 编码失败")?;
    // sRGB chunk, rendering intent 0 (perceptual), immediately after IHDR.
    const SRGB_CHUNK: [u8; 13] = [
        0, 0, 0, 1, b's', b'R', b'G', b'B', 0, 0xAE, 0xCE, 0x1C, 0xE9,
    ];
    encoded.splice(33..33, SRGB_CHUNK);
    Ok(encoded)
}

pub(super) fn render_verified(
    source: &RgbaImage,
    item: &Item,
    buffer: &mut Vec<u8>,
    cancel: &CancellationToken,
) -> Result<(Vec<u8>, String), String> {
    let rect = item.rect;
    buffer.resize(rect.width() as usize * rect.height() as usize * 4, 0);
    render(source, item, buffer, cancel)?;
    let png = png(buffer, rect.width(), rect.height())?;
    let decoded = decode(&png, false)?;
    check_cancelled(cancel)?;
    if decoded.dimensions() != (rect.width(), rect.height()) || decoded.as_raw() != buffer {
        return Err("切片 PNG 回读像素不一致".into());
    }
    Ok((png, digest(buffer)))
}

pub(super) fn transparent_regions(
    source: &RgbaImage,
    output: &mut [Rect; MAX_ITEMS],
    cancel: &CancellationToken,
) -> Result<(usize, bool), String> {
    let (width, height) = source.dimensions();
    let stride = width as usize * 4;
    let rows = source.as_raw().chunks_exact(stride);
    let mut row_start = None;
    let mut column_buffer = [false; MAX_EDGE as usize];
    let columns = &mut column_buffer[..width as usize];
    let mut count = 0;
    for (index, row) in rows.chain(std::iter::once(&[][..])).enumerate() {
        if index % 32 == 0 {
            check_cancelled(cancel)?;
        }
        let mut visible = false;
        for (column, pixel) in row.chunks_exact(4).enumerate() {
            let filled = pixel[3] != 0;
            columns[column] |= filled;
            visible |= filled;
        }
        if visible {
            row_start.get_or_insert(index as u32);
        } else if let Some(y0) = row_start.take() {
            let mut column_start = None;
            for (column, filled) in columns
                .iter()
                .copied()
                .chain(std::iter::once(false))
                .enumerate()
            {
                if filled {
                    column_start.get_or_insert(column as u32);
                } else if let Some(x0) = column_start.take() {
                    if count == output.len() {
                        return Ok((count, true));
                    }
                    output[count] = Rect {
                        x0,
                        y0,
                        x1: column as u32,
                        y1: index as u32,
                    };
                    count += 1;
                }
            }
            columns.fill(false);
        }
    }
    if count == 1
        && output[0]
            == (Rect {
                x0: 0,
                y0: 0,
                x1: width,
                y1: height,
            })
    {
        count = 0;
    }
    Ok((count, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::{alloc::{GlobalAlloc, Layout, System}, cell::Cell};

    thread_local! {
        static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) };
    }

    struct CountingAllocator;

    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get().map(|value| value + 1)));
            unsafe { System.alloc(layout) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) }
        }
    }

    #[test]
    fn scans_and_renders_into_preallocated_buffers_without_allocating() {
        let source = RgbaImage::from_fn(64, 64, |x, y| Rgba([12, 34, 56, u8::from(x < 32 && y < 32)]));
        let rect = Rect { x0: 0, y0: 0, x1: 32, y1: 32 };
        let mut item = Item {
            label: "masked".into(), rect,
            rings: vec![vec![[0, 0], [32, 0], [32, 32], [0, 32]], vec![[8, 8], [24, 8], [24, 24], [8, 24]]],
        };
        let mut regions = [Rect::default(); MAX_ITEMS];
        let mut output = [0u8; 32 * 32 * 4];
        let cancel = CancellationToken::new();
        ALLOCATIONS.with(|count| count.set(Some(0)));
        let scanned = transparent_regions(&source, &mut regions, &cancel);
        let masked = render(&source, &item, &mut output, &cancel);
        let hole = output[(8 * 32 + 8) * 4 + 3];
        item.rings.clear();
        let rectangle = render(&source, &item, &mut output, &cancel);
        let allocations = ALLOCATIONS.with(|count| count.replace(None));
        assert_eq!(allocations, Some(0));
        assert_eq!(scanned.unwrap(), (1, false));
        assert_eq!(regions[0], rect);
        masked.unwrap();
        rectangle.unwrap();
        assert_eq!(hole, 0);
        assert_eq!(output[(8 * 32 + 8) * 4 + 3], 1);
    }

    #[test]
    fn rectangle_uses_half_open_bounds_and_preserves_hidden_rgb() {
        let source = RgbaImage::from_fn(4, 3, |x, y| Rgba([x as u8, y as u8, 210, 0]));
        let item = Item {
            label: "rect".into(),
            rect: Rect {
                x0: 1,
                y0: 1,
                x1: 4,
                y1: 3,
            },
            rings: vec![],
        };
        let mut scratch = Vec::new();
        let (encoded, sha256) =
            render_verified(&source, &item, &mut scratch, &CancellationToken::new()).unwrap();
        let output = decode(&encoded, false).unwrap();
        assert_eq!(output.dimensions(), (3, 2));
        assert_eq!(*output.get_pixel(0, 0), *source.get_pixel(1, 1));
        assert_eq!(*output.get_pixel(2, 1), *source.get_pixel(3, 2));
        assert_eq!(sha256, digest(output.as_raw()));
    }

    #[test]
    fn even_odd_mask_removes_hole_in_either_ring_direction() {
        let color = Rgba([7, 91, 203, 127]);
        let source = RgbaImage::from_pixel(5, 5, color);
        let outer = vec![[0, 0], [5, 0], [5, 5], [0, 5]];
        let mut hole = vec![[1, 1], [4, 1], [4, 4], [1, 4]];
        let mut scratch = Vec::new();
        for _ in 0..2 {
            let item = Item {
                label: "mask".into(),
                rect: Rect {
                    x0: 0,
                    y0: 0,
                    x1: 5,
                    y1: 5,
                },
                rings: vec![outer.clone(), hole.clone()],
            };
            let (encoded, _) =
                render_verified(&source, &item, &mut scratch, &CancellationToken::new()).unwrap();
            let output = decode(&encoded, false).unwrap();
            for (x, y, pixel) in output.enumerate_pixels() {
                let expected = if (1..4).contains(&x) && (1..4).contains(&y) {
                    Rgba([0; 4])
                } else {
                    color
                };
                assert_eq!(*pixel, expected);
            }
            hole.reverse();
        }
    }

    #[test]
    fn opaque_alpha_of_one_blocks_an_apparent_gutter() {
        let mut source = RgbaImage::new(5, 2);
        for x in [0, 1, 3, 4] {
            source.put_pixel(x, 0, Rgba([0, 0, 0, 255]));
        }
        let cancel = CancellationToken::new();
        let mut regions = [Rect::default(); MAX_ITEMS];
        let (count, _) = transparent_regions(&source, &mut regions, &cancel).unwrap();
        assert_eq!(count, 2);
        source.put_pixel(2, 0, Rgba([0, 0, 0, 1]));
        let (count, _) = transparent_regions(&source, &mut regions, &cancel).unwrap();
        assert_eq!(
            regions[..count],
            [Rect {
                x0: 0,
                y0: 0,
                x1: 5,
                y1: 1
            }]
        );
        cancel.cancel();
        assert!(transparent_regions(&source, &mut regions, &cancel).is_err());
    }
}
