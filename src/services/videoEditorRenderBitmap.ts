import { readRasterImageDimensions } from "./rasterImageDimensions";
import type { VideoEditorCanvasSize } from "../types/videoEditor";

const MAX_RENDER_IMAGE_BITMAP_BYTES = 256 * 1024 * 1024;

export async function createBudgetedRenderBitmap(
  url: string,
  retainedBytes: number,
  outputSize: VideoEditorCanvasSize,
): Promise<{ bitmap: ImageBitmap; bytes: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取图片素材失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const dimensions = await readRasterImageDimensions(blob);
  if (!dimensions) {
    throw new RangeError('无法在解码前确认图片素材尺寸，请先转换为 PNG、JPEG、WebP、GIF、BMP 或带固定尺寸的 SVG');
  }
  const sourceBytes = dimensions.width * dimensions.height * 4;
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1
    || retainedBytes + sourceBytes > MAX_RENDER_IMAGE_BITMAP_BYTES) {
    const sourceMiB = Math.ceil((retainedBytes + Math.max(0, sourceBytes)) / (1024 * 1024));
    throw new RangeError(
      `图片素材解码后累计约 ${sourceMiB} MiB，超过视频合成 256 MiB 安全上限，请减少大图贴图或先降低分辨率`,
    );
  }
  const scale = Math.min(
    1,
    outputSize.width / dimensions.width,
    outputSize.height / dimensions.height,
  );
  const targetWidth = Math.max(1, Math.round(dimensions.width * scale));
  const targetHeight = Math.max(1, Math.round(dimensions.height * scale));
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    resizeWidth: targetWidth,
    resizeHeight: targetHeight,
    resizeQuality: 'high',
  });
  const bytes = bitmap.width * bitmap.height * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || retainedBytes + bytes > MAX_RENDER_IMAGE_BITMAP_BYTES) {
    bitmap.close();
    const retainedMiB = Math.ceil((retainedBytes + Math.max(0, bytes)) / (1024 * 1024));
    throw new RangeError(
      `图片素材解码后累计约 ${retainedMiB} MiB，超过视频合成 256 MiB 安全上限，请减少大图贴图或先降低分辨率`,
    );
  }
  return { bitmap, bytes };
}
