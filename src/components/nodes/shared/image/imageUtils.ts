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
