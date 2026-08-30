const MEBIBYTE = 1024 * 1024;
const RGBA_BYTES_PER_PIXEL = 4;

/** 单个编辑器输出画布允许的最大边长。 */
export const MAX_EDITOR_CANVAS_EDGE = 8192;
/**
 * 导出期间通常同时存在工作画布、导出画布、编码读取面和结果缓冲。
 * 预算按四份 RGBA 表面估算，而不是只看一张 canvas 的 backing store。
 */
export const EDITOR_OUTPUT_SURFACE_COPIES = 4;
/** 编辑器一次导出的估算总工作集上限（256 MiB），保留标准 4096×4096 工作流。 */
export const MAX_EDITOR_OUTPUT_WORKING_SET_BYTES = 256 * MEBIBYTE;
/** 单份 RGBA 表面允许的上限（64 MiB，四份合计 256 MiB）。 */
export const MAX_EDITOR_OUTPUT_RGBA_BYTES = Math.floor(
  MAX_EDITOR_OUTPUT_WORKING_SET_BYTES / EDITOR_OUTPUT_SURFACE_COPIES,
);
/** 编辑预览与浏览器内部绘制通常会同时保留至少两份源图表面。 */
export const EDITOR_SOURCE_SURFACE_COPIES = 2;
/** 单张编辑源图的估算总工作集上限（256 MiB）。 */
export const MAX_EDITOR_SOURCE_WORKING_SET_BYTES = 256 * MEBIBYTE;
/** 单张源图一份 RGBA 表面的上限（128 MiB）。 */
export const MAX_EDITOR_SOURCE_RGBA_BYTES = Math.floor(
  MAX_EDITOR_SOURCE_WORKING_SET_BYTES / EDITOR_SOURCE_SURFACE_COPIES,
);
/** 抠图撤销栈内 ImageData 的累计上限（96 MiB）。 */
export const MAX_MATTING_HISTORY_BYTES = 96 * MEBIBYTE;
/** 抠图工作画布的最大边长，保持现有 2048px 编辑精度。 */
export const MAX_MATTING_CANVAS_EDGE = 2048;
/** Konva cache 稳态/处理至少涉及 scene、filter、hit 与临时像素面。 */
export const COMPOSER_FILTER_CACHE_SURFACE_COPIES = 4;
/** 所有 Konva 图片滤镜缓存的估算总工作集上限（256 MiB）。 */
export const MAX_COMPOSER_FILTER_CACHE_WORKING_SET_BYTES = 256 * MEBIBYTE;
/** 单个滤镜缓存的一份 RGBA 表面上限（64 MiB，四份合计256 MiB）。 */
export const MAX_COMPOSER_FILTER_CACHE_RGBA_BYTES = Math.floor(
  MAX_COMPOSER_FILTER_CACHE_WORKING_SET_BYTES / COMPOSER_FILTER_CACHE_SURFACE_COPIES,
);
/** 合成器所有去重后的原图解码表面累计上限（256 MiB）。 */
export const MAX_COMPOSER_SOURCE_RGBA_BYTES = 256 * MEBIBYTE;
/** 合成器稳态（原图历史 + 滤镜缓存）合计上限。 */
export const MAX_COMPOSER_STEADY_WORKING_SET_BYTES = 384 * MEBIBYTE;
/** 合成导出期间（稳态 + 输出编码表面）的总峰值上限。 */
export const MAX_COMPOSER_PEAK_WORKING_SET_BYTES = 640 * MEBIBYTE;

export interface RgbaBudgetEstimate {
  width: number;
  height: number;
  pixels: number;
  bytes: number;
}

const formatMiB = (bytes: number): string => `${Math.ceil(bytes / MEBIBYTE)} MiB`;

export function estimateRgbaBytes(width: number, height: number): RgbaBudgetEstimate | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const safeWidth = Math.ceil(width);
  const safeHeight = Math.ceil(height);
  if (safeWidth < 1 || safeHeight < 1) return null;
  const pixels = safeWidth * safeHeight;
  const bytes = pixels * RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) return null;
  return { width: safeWidth, height: safeHeight, pixels, bytes };
}

export function getEditorCanvasBudgetError(
  width: number,
  height: number,
  label = '图片输出',
): string | null {
  const estimate = estimateRgbaBytes(width, height);
  if (!estimate) return `${label}尺寸无效，请重新选择区域`;
  if (estimate.width > MAX_EDITOR_CANVAS_EDGE || estimate.height > MAX_EDITOR_CANVAS_EDGE) {
    return `${label}尺寸 ${estimate.width}×${estimate.height} 超过单边 ${MAX_EDITOR_CANVAS_EDGE}px 的安全上限，请减小输出尺寸`;
  }
  if (estimate.bytes > MAX_EDITOR_OUTPUT_RGBA_BYTES) {
    const workingBytes = estimate.bytes * EDITOR_OUTPUT_SURFACE_COPIES;
    return `${label}尺寸 ${estimate.width}×${estimate.height} 预计需要约 ${formatMiB(workingBytes)} 峰值内存（${EDITOR_OUTPUT_SURFACE_COPIES} 份画布表面），超过 ${formatMiB(MAX_EDITOR_OUTPUT_WORKING_SET_BYTES)} 安全上限，请减小输出尺寸`;
  }
  return null;
}

export function assertEditorCanvasBudget(
  width: number,
  height: number,
  label = '图片输出',
): RgbaBudgetEstimate {
  const error = getEditorCanvasBudgetError(width, height, label);
  if (error) throw new RangeError(error);
  return estimateRgbaBytes(width, height)!;
}

export function getEditorSourceBudgetError(
  width: number,
  height: number,
  label = '编辑源图',
): string | null {
  const estimate = estimateRgbaBytes(width, height);
  if (!estimate) return `${label}尺寸无效，请先转换图片格式`;
  if (estimate.width > MAX_EDITOR_CANVAS_EDGE || estimate.height > MAX_EDITOR_CANVAS_EDGE) {
    return `${label}尺寸 ${estimate.width}×${estimate.height} 超过单边 ${MAX_EDITOR_CANVAS_EDGE}px 的安全上限，请先降低分辨率`;
  }
  if (estimate.bytes > MAX_EDITOR_SOURCE_RGBA_BYTES) {
    const workingBytes = estimate.bytes * EDITOR_SOURCE_SURFACE_COPIES;
    return `${label}尺寸 ${estimate.width}×${estimate.height} 预计需要约 ${formatMiB(workingBytes)} 峰值内存（${EDITOR_SOURCE_SURFACE_COPIES} 份源图表面），超过 ${formatMiB(MAX_EDITOR_SOURCE_WORKING_SET_BYTES)} 安全上限，请先降低分辨率`;
  }
  return null;
}

export function assertEditorSourceBudget(
  width: number,
  height: number,
  label = '编辑源图',
): RgbaBudgetEstimate {
  const error = getEditorSourceBudgetError(width, height, label);
  if (error) throw new RangeError(error);
  return estimateRgbaBytes(width, height)!;
}

export function getComposerFilterCacheBudgetError(
  width: number,
  height: number,
  offset: number,
): string | null {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.ceil(offset)) : 0;
  const estimate = estimateRgbaBytes(width + safeOffset * 2, height + safeOffset * 2);
  if (!estimate) return '图片滤镜缓存尺寸无效，请重新添加图片';
  if (estimate.width > MAX_EDITOR_CANVAS_EDGE || estimate.height > MAX_EDITOR_CANVAS_EDGE) {
    return `图片滤镜缓存尺寸 ${estimate.width}×${estimate.height} 超过单边 ${MAX_EDITOR_CANVAS_EDGE}px 的安全上限，请先缩小图片分辨率`;
  }
  const workingBytes = estimate.bytes * COMPOSER_FILTER_CACHE_SURFACE_COPIES;
  if (workingBytes > MAX_COMPOSER_FILTER_CACHE_WORKING_SET_BYTES) {
    return `图片滤镜缓存预计需要约 ${formatMiB(workingBytes)} 峰值内存（${COMPOSER_FILTER_CACHE_SURFACE_COPIES} 份缓存表面），超过 ${formatMiB(MAX_COMPOSER_FILTER_CACHE_WORKING_SET_BYTES)} 安全上限，请先缩小图片分辨率`;
  }
  return null;
}

export function estimateComposerFilterCacheWorkingSetBytes(
  width: number,
  height: number,
  offset: number,
): number | null {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.ceil(offset)) : 0;
  const estimate = estimateRgbaBytes(width + safeOffset * 2, height + safeOffset * 2);
  return estimate ? estimate.bytes * COMPOSER_FILTER_CACHE_SURFACE_COPIES : null;
}

export function getComposerFilterCacheAggregateBudgetError(
  retainedWorkingBytes: number,
  width: number,
  height: number,
  offset: number,
  retainedSourceBytes = 0,
): string | null {
  const individualError = getComposerFilterCacheBudgetError(width, height, offset);
  if (individualError) return individualError;
  const nextBytes = estimateComposerFilterCacheWorkingSetBytes(width, height, offset);
  if (nextBytes === null) return '图片滤镜缓存尺寸无效，请重新添加图片';
  const safeRetainedBytes = Number.isFinite(retainedWorkingBytes) ? Math.max(0, retainedWorkingBytes) : 0;
  const totalBytes = safeRetainedBytes + nextBytes;
  if (totalBytes > MAX_COMPOSER_FILTER_CACHE_WORKING_SET_BYTES) {
    return `全部图片滤镜缓存累计预计需要约 ${formatMiB(totalBytes)} 峰值内存，超过 ${formatMiB(MAX_COMPOSER_FILTER_CACHE_WORKING_SET_BYTES)} 安全上限，请关闭部分大图滤镜`;
  }
  const safeSourceBytes = Number.isFinite(retainedSourceBytes) ? Math.max(0, retainedSourceBytes) : 0;
  const combinedBytes = safeSourceBytes + totalBytes;
  if (combinedBytes > MAX_COMPOSER_STEADY_WORKING_SET_BYTES) {
    return `图片历史与滤镜缓存合计预计需要约 ${formatMiB(combinedBytes)} 内存，超过 ${formatMiB(MAX_COMPOSER_STEADY_WORKING_SET_BYTES)} 合成器稳态上限，请清理撤销历史或关闭部分大图滤镜`;
  }
  return null;
}

export function getComposerPeakWorkingSetBudgetError(
  retainedSourceBytes: number,
  retainedFilterBytes: number,
  outputWidth: number,
  outputHeight: number,
): string | null {
  const output = estimateRgbaBytes(outputWidth, outputHeight);
  if (!output) return '合成导出尺寸无效，请重新设置画布';
  const safeSourceBytes = Number.isFinite(retainedSourceBytes) ? Math.max(0, retainedSourceBytes) : 0;
  const safeFilterBytes = Number.isFinite(retainedFilterBytes) ? Math.max(0, retainedFilterBytes) : 0;
  const totalBytes = safeSourceBytes
    + safeFilterBytes
    + output.bytes * EDITOR_OUTPUT_SURFACE_COPIES;
  if (totalBytes <= MAX_COMPOSER_PEAK_WORKING_SET_BYTES) return null;
  return `合成导出总峰值预计约 ${formatMiB(totalBytes)}，超过 ${formatMiB(MAX_COMPOSER_PEAK_WORKING_SET_BYTES)} 安全上限，请清理撤销历史、关闭部分滤镜或降低画布分辨率`;
}

export function getComposerSourceBudgetError(
  existingBytes: number,
  width: number,
  height: number,
): string | null {
  const estimate = estimateRgbaBytes(width, height);
  if (!estimate) return '图片图层尺寸无效，请重新添加图片';
  const safeExistingBytes = Number.isFinite(existingBytes) ? Math.max(0, existingBytes) : 0;
  const totalBytes = safeExistingBytes + estimate.bytes;
  return getComposerRetainedSourceBudgetError(totalBytes);
}

export function getComposerRetainedSourceBudgetError(totalBytes: number): string | null {
  const safeTotalBytes = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
  if (safeTotalBytes <= MAX_COMPOSER_SOURCE_RGBA_BYTES) return null;
  return `图片图层解码后累计需要约 ${formatMiB(safeTotalBytes)} 内存，超过 ${formatMiB(MAX_COMPOSER_SOURCE_RGBA_BYTES)} 安全上限，请先删除部分大图图层`;
}

/** 使用浏览器异步编码路径，避免大画布同步 toDataURL 长时间阻塞 UI。 */
export function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('图片编码失败，请重试'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('图片编码结果无效，请重试'));
      };
      reader.onerror = () => reject(reader.error ?? new Error('图片编码失败，请重试'));
      reader.readAsDataURL(blob);
    }, type, quality);
  });
}
