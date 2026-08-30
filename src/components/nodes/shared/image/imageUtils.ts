/**
 * 图像节点工具函数
 */
import { fetchImageForCrop } from '../../../../services/fileService';
import {
  readRasterImageDimensions,
  type RasterImageDimensions,
} from '../../../../services/rasterImageDimensions';
import { assertEditorSourceBudget } from './imageResourceBudget';

interface LoadSafeImageOptions {
  beforeDecode?: (dimensions: RasterImageDimensions) => void;
  label?: string;
}

const SAFE_FORMAT_MESSAGE = '无法在解码前确认图片尺寸，请先转换为 PNG、JPEG、WebP、GIF、BMP 或带固定尺寸的 SVG';

async function readSafeImageBlob(url: string): Promise<Blob> {
  const source = !url.startsWith('data:')
    && !url.startsWith('blob:')
    && !url.startsWith('asset://')
    && !url.includes('asset.localhost')
    ? await fetchImageForCrop(url)
    : url;
  const response = await fetch(source);
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
  return response.blob();
}

export interface SafeImagePreviewSource {
  sourceUrl: string;
  src: string;
  dimensions: RasterImageDimensions;
  release: () => void;
}

/**
 * 为编辑器预览准备同源 object URL，并在浏览器解码前完成尺寸/内存校验。
 * 预览和后续 canvas 绘制可以复用同一个 DOM 图片，不再二次完整解码。
 */
export async function createSafeImagePreviewSource(
  url: string,
  label = '编辑源图',
): Promise<SafeImagePreviewSource> {
  const blob = await readSafeImageBlob(url);
  const dimensions = await readRasterImageDimensions(blob);
  if (!dimensions) throw new RangeError(SAFE_FORMAT_MESSAGE);
  assertEditorSourceBudget(dimensions.width, dimensions.height, label);
  const src = URL.createObjectURL(blob);
  let released = false;
  return {
    sourceUrl: url,
    src,
    dimensions,
    release: () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(src);
    },
  };
}

/**
 * 加载一张「可安全绘制到 canvas / 不会污染」的 HTMLImageElement。
 * - data:/blob: 同源直接加载
 * - asset://（Tauri）：fetch → 临时 blob:，避免额外构造整份 Base64 字符串
 * - http(s)://：经 Rust 原生 HTTP 下载，绕过 WebView CORS
 * 用于 Konva 合成导出（toDataURL 在 tainted canvas 上会抛错）。
 */
export async function loadSafeImage(
  url: string,
  options: LoadSafeImageOptions = {},
): Promise<HTMLImageElement> {
  const prepared = await createSafeImagePreviewSource(url, options.label ?? '编辑源图');
  const img = new Image();
  try {
    options.beforeDecode?.(prepared.dimensions);
    img.src = prepared.src;
    await img.decode();
    return img;
  } finally {
    prepared.release();
  }
}

/**
 * 从源图裁出第 (row,col) 格（rows×cols 均分），返回真实裁片 PNG 与其像素尺寸。
 * 用于宫格分镜「提取」：拖出的格是实打实裁好的图，而非偏移显示。
 */
export async function cropImageCell(
  imageUrl: string,
  col: number,
  row: number,
  cols: number,
  rows: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadSafeImage(imageUrl);
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  const x0 = Math.round((col * natW) / cols);
  const x1 = Math.round(((col + 1) * natW) / cols);
  const y0 = Math.round((row * natH) / rows);
  const y1 = Math.round(((row + 1) * natH) / rows);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
}

/**
 * 按百分比区域裁切图像（非均匀网格用）。
 * @param hRanges 行边界百分比数组（如 [0, 20, 70, 100]）
 * @param vRanges 列边界百分比数组（如 [0, 30, 100]）
 * @param row 第几行（0-based）
 * @param col 第几列（0-based）
 */
export async function cropImageByRanges(
  imageUrl: string,
  hRanges: number[],
  vRanges: number[],
  row: number,
  col: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadSafeImage(imageUrl);
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  const x0 = Math.round((vRanges[col] / 100) * natW);
  const x1 = Math.round((vRanges[col + 1] / 100) * natW);
  const y0 = Math.round((hRanges[row] / 100) * natH);
  const y1 = Math.round((hRanges[row + 1] / 100) * natH);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
}

/** 读取图片真实像素尺寸，并计算图像节点的建议展示尺寸。 */
export function computeImageNodeDimensions(
  dataUrl: string,
): Promise<{
  imageWidth?: number;
  imageHeight?: number;
  nodeWidth: number;
  nodeHeight: number;
}> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const imageWidth = img.naturalWidth;
      const imageHeight = img.naturalHeight;
      if (imageWidth <= 0 || imageHeight <= 0) {
        resolve({ nodeWidth: 280, nodeHeight: 158 });
        return;
      }

      const naturalRatio = imageWidth / imageHeight;
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = imageWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ imageWidth, imageHeight, nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}
