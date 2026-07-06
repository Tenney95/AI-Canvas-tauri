/**
 * 图像节点工具函数
 */
import { fetchImageForCrop } from '../../../../services/fileService';

/**
 * 加载一张「可安全绘制到 canvas / 不会污染」的 HTMLImageElement。
 * - data:/blob: 同源直接加载
 * - asset://（Tauri）：fetch → FileReader 转 data: 绝对同源
 * - http(s)://：经 Rust 原生 HTTP 下载，绕过 WebView CORS
 * 用于 Konva 合成导出（toDataURL 在 tainted canvas 上会抛错）。
 */
export async function loadSafeImage(url: string): Promise<HTMLImageElement> {
  let src = url;
  if (url.startsWith('asset://') || url.includes('asset.localhost')) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } else if (!url.startsWith('data:') && !url.startsWith('blob:')) {
    src = await fetchImageForCrop(url);
  }
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
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

/** 根据 data URL 计算图像节点的建议尺寸 */
export function computeImageNodeDimensions(
  dataUrl: string,
): Promise<{ nodeWidth: number; nodeHeight: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const maxWidth = 280;
      const minWidth = 160;
      let nodeWidth = img.naturalWidth;
      if (nodeWidth > maxWidth) nodeWidth = maxWidth;
      if (nodeWidth < minWidth) nodeWidth = minWidth;
      const contentWidth = nodeWidth - 4;
      const previewHeight = Math.round(contentWidth / naturalRatio);
      const nodeHeight = Math.max(120, previewHeight + 4);
      resolve({ nodeWidth, nodeHeight });
    };
    img.onerror = () => resolve({ nodeWidth: 280, nodeHeight: 158 });
    img.src = dataUrl;
  });
}
