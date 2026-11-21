use std::path::{Path, PathBuf};

pub(super) const DIRECTION_CELL_SIZE: u32 = 512;
const DIRECTION_SUBJECT_MAX_SIZE: u32 = 448;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct DirectionPlacement {
    pub(super) source_index: usize,
    target_row: u32,
    target_col: u32,
    pub(super) mirror: bool,
}

// 源图按 2 列 × 3 行、行优先编号：
// 0=参考图，1=右侧，2=正面，3=背面，4=右下，5=左上。
// 中心格保留参考图；其余三个缺失方向由水平镜像补齐。
pub(super) const DIRECTION_PLACEMENTS: [DirectionPlacement; 9] = [
    DirectionPlacement {
        source_index: 5,
        target_row: 0,
        target_col: 0,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 3,
        target_row: 0,
        target_col: 1,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 5,
        target_row: 0,
        target_col: 2,
        mirror: true,
    },
    DirectionPlacement {
        source_index: 1,
        target_row: 1,
        target_col: 0,
        mirror: true,
    },
    DirectionPlacement {
        source_index: 0,
        target_row: 1,
        target_col: 1,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 1,
        target_row: 1,
        target_col: 2,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 4,
        target_row: 2,
        target_col: 0,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 2,
        target_row: 2,
        target_col: 1,
        mirror: false,
    },
    DirectionPlacement {
        source_index: 4,
        target_row: 2,
        target_col: 2,
        mirror: true,
    },
];

pub(super) fn unique_sibling_png(input: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = input.parent().ok_or("无法解析输入图片目录".to_string())?;
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");

    for index in 0..10_000u32 {
        let numbered = if index == 0 {
            format!("{stem}_{suffix}.png")
        } else {
            format!("{stem}_{suffix}_{index}.png")
        };
        let candidate = parent.join(numbered);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("无法为 8 向图生成不冲突的输出文件名".to_string())
}

/// 键控底色：必须与 8 向图提示词里钉死的纯色背景一致（影视标准绿 #00B140）。
/// 角色本身是绿色系时改用蓝幕：这里换 [0x00, 0x00, 0xFF]、SPILL_CHANNEL 换 2，
/// 提示词里的色号同步换掉。品红这类双主通道的底色这套去反光不适用。
pub(super) const CHROMA_KEY_COLOR: [u8; 3] = [0x00, 0xB1, 0x40];
/// 键控色的主通道下标，用于压掉溅在角色轮廓上的底色反光；#00B140 的主通道是 G。
const CHROMA_KEY_SPILL_CHANNEL: usize = 1;
/// 到键控色的 RGB 距离：≤SOLID 判定为纯背景，≥EDGE 判定为角色，中间线性羽化边缘。
/// 模型出图有色偏、背景有布光渐变、再过一道压缩，所以不能按精确色值匹配。
const CHROMA_KEY_SOLID_DISTANCE: f32 = 60.0;
const CHROMA_KEY_EDGE_DISTANCE: f32 = 110.0;

fn chroma_key_distance(pixel: &image::Rgba<u8>) -> f32 {
    let dr = f32::from(pixel[0]) - f32::from(CHROMA_KEY_COLOR[0]);
    let dg = f32::from(pixel[1]) - f32::from(CHROMA_KEY_COLOR[1]);
    let db = f32::from(pixel[2]) - f32::from(CHROMA_KEY_COLOR[2]);
    (dr * dr + dg * dg + db * db).sqrt()
}

/// 从四边 flood fill 抠掉键控底色。
/// 只吃与边框连通的那片背景，角色身上的同色图案是孤岛，不会被一起抠掉。
/// 源图不是键控底（老图、照片）时边框种子为空，整格原样保留。
fn key_out_chroma_background(cell: &mut image::RgbaImage) {
    let (width, height) = cell.dimensions();
    if width == 0 || height == 0 {
        return;
    }

    let distances: Vec<f32> = cell.pixels().map(chroma_key_distance).collect();
    let mut keyed = vec![false; distances.len()];
    let mut stack: Vec<usize> = Vec::new();

    for y in 0..height {
        for x in 0..width {
            if x != 0 && y != 0 && x != width - 1 && y != height - 1 {
                continue;
            }
            let index = (y * width + x) as usize;
            if !keyed[index] && distances[index] < CHROMA_KEY_EDGE_DISTANCE {
                keyed[index] = true;
                stack.push(index);
            }
        }
    }

    while let Some(index) = stack.pop() {
        let x = index as u32 % width;
        let y = index as u32 / width;
        // 减到 0 以下会绕成 u32::MAX，正好被下面的越界判断拦掉
        for (neighbour_x, neighbour_y) in [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ] {
            if neighbour_x >= width || neighbour_y >= height {
                continue;
            }
            let neighbour = (neighbour_y * width + neighbour_x) as usize;
            if keyed[neighbour] || distances[neighbour] >= CHROMA_KEY_EDGE_DISTANCE {
                continue;
            }
            keyed[neighbour] = true;
            stack.push(neighbour);
        }
    }

    let feather = (CHROMA_KEY_EDGE_DISTANCE - CHROMA_KEY_SOLID_DISTANCE).max(1.0);
    for (index, pixel) in cell.pixels_mut().enumerate() {
        if !keyed[index] {
            continue;
        }
        let distance = distances[index];
        if distance <= CHROMA_KEY_SOLID_DISTANCE {
            pixel[3] = 0;
            continue;
        }
        // 半透明的过渡像素：按色距羽化，并把底色反光压回另外两个通道的量级
        let ratio = ((distance - CHROMA_KEY_SOLID_DISTANCE) / feather).clamp(0.0, 1.0);
        pixel[3] = (f32::from(pixel[3]) * ratio).round() as u8;
        let other_a = pixel[(CHROMA_KEY_SPILL_CHANNEL + 1) % 3];
        let other_b = pixel[(CHROMA_KEY_SPILL_CHANNEL + 2) % 3];
        pixel[CHROMA_KEY_SPILL_CHANNEL] = pixel[CHROMA_KEY_SPILL_CHANNEL].min(other_a.max(other_b));
    }
}

fn alpha_bounds(image: &image::RgbaImage) -> Option<(u32, u32, u32, u32)> {
    let mut min_x = image.width();
    let mut min_y = image.height();
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;

    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] == 0 {
            continue;
        }
        found = true;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }

    found.then_some((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
}

fn normalize_direction_cell(
    subject: &image::RgbaImage,
    source_index: usize,
) -> Result<image::RgbaImage, String> {
    let source_row = source_index / 2;
    let source_col = source_index % 2;
    let x0 = source_col as u32 * subject.width() / 2;
    let x1 = (source_col as u32 + 1) * subject.width() / 2;
    let y0 = source_row as u32 * subject.height() / 3;
    let y1 = (source_row as u32 + 1) * subject.height() / 3;
    let cell_width = x1.saturating_sub(x0);
    let cell_height = y1.saturating_sub(y0);
    let inset = (cell_width.min(cell_height) / 128).max(2);

    if cell_width <= inset * 2 || cell_height <= inset * 2 {
        return Err(format!("源图第 {} 块尺寸过小", source_index + 1));
    }

    let mut cell = image::imageops::crop_imm(
        subject,
        x0 + inset,
        y0 + inset,
        cell_width - inset * 2,
        cell_height - inset * 2,
    )
    .to_image();
    key_out_chroma_background(&mut cell);
    let (trim_x, trim_y, trim_width, trim_height) = alpha_bounds(&cell)
        .ok_or_else(|| format!("源图第 {} 块抠底后没剩下主体", source_index + 1))?;
    let trimmed =
        image::imageops::crop_imm(&cell, trim_x, trim_y, trim_width, trim_height).to_image();

    let longest = trim_width.max(trim_height) as f64;
    let scale = DIRECTION_SUBJECT_MAX_SIZE as f64 / longest;
    let target_width = ((trim_width as f64 * scale).round() as u32).max(1);
    let target_height = ((trim_height as f64 * scale).round() as u32).max(1);
    Ok(image::imageops::resize(
        &trimmed,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    ))
}

pub(super) fn compose_character_direction_grid_image(
    subject: &image::RgbaImage,
) -> Result<image::RgbaImage, String> {
    if subject.width() < 4 || subject.height() < 6 {
        return Err("8 向图源图片尺寸不足，无法按 2×3 拆分".to_string());
    }

    let sprites = (0..6)
        .map(|source_index| normalize_direction_cell(subject, source_index))
        .collect::<Result<Vec<_>, _>>()?;
    let grid_size = DIRECTION_CELL_SIZE * 3;
    let mut grid = image::RgbaImage::new(grid_size, grid_size);

    for placement in DIRECTION_PLACEMENTS {
        let source = &sprites[placement.source_index];
        let mirrored;
        let sprite = if placement.mirror {
            mirrored = image::imageops::flip_horizontal(source);
            &mirrored
        } else {
            source
        };
        let cell_x = placement.target_col * DIRECTION_CELL_SIZE;
        let cell_y = placement.target_row * DIRECTION_CELL_SIZE;
        let x = cell_x + (DIRECTION_CELL_SIZE - sprite.width()) / 2;
        let y = cell_y + (DIRECTION_CELL_SIZE - sprite.height()) / 2;
        image::imageops::overlay(&mut grid, sprite, i64::from(x), i64::from(y));
    }

    Ok(grid)
}

pub(super) fn compose_character_direction_grid(source_path: &Path, output_path: &Path) -> Result<(), String> {
    let subject = image::open(source_path)
        .map_err(|error| format!("读取 8 向图源图片失败: {error}"))?
        .to_rgba8();
    let grid = compose_character_direction_grid_image(&subject)?;
    grid.save(output_path)
        .map_err(|error| format!("保存角色 8 向宫格失败: {error}"))
}
