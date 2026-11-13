import { t } from '../../i18n';
import { readImageSourceBlob } from '../fs/imageSourceBlob';
import { parseRasterImageDimensions, readRasterImageDimensions } from '../rasterImageDimensions';

const MAX_MASK_BYTES = 4_000_000;
const MAX_BASE_BYTES = 50_000_000;
const MAX_BASE_PIXELS = 24_000_000;
const MASK_MODELS = new Set([
  'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-04-21',
  'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08',
  'gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08',
  'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'chatgpt-image-latest',
]);

/** 只有明确的 OpenAI 编辑合同才启用 mask，兼容代理可能忽略该字段。 */
export function isOpenAIPaintMaskContract(baseUrl: string | undefined, modelName: string): boolean {
  if (!baseUrl || !MASK_MODELS.has(modelName)) return false;
  try { return new URL(baseUrl).href.replace(/\/$/, '') === 'https://api.openai.com/v1'; }
  catch { return false; }
}

export function isCharacterImageMaskDataUrl(value: string): boolean {
  return value.startsWith('data:image/png;base64,') && value.length < 4 * Math.ceil(MAX_MASK_BYTES / 3) + 22;
}

export async function prepareCharacterImageMask(base: Blob, dataUrl: string, signal?: AbortSignal): Promise<{ image: Blob; mask: Blob }> {
  const invalidMask = () => new Error(t('蒙版须为与底图同尺寸、包含透明修改区且小于 4 MB 的 PNG'));
  const invalidBase = () => new Error(t('底图格式或尺寸不支持画笔蒙版'));
  if (!isCharacterImageMaskDataUrl(dataUrl)) throw invalidMask();
  const activeSignal = signal ?? new AbortController().signal;
  const baseDimensions = await readRasterImageDimensions(base);
  if (!baseDimensions || baseDimensions.width * baseDimensions.height > MAX_BASE_PIXELS) throw invalidBase();
  const mask = await readImageSourceBlob(dataUrl, activeSignal);
  if (mask.size >= MAX_MASK_BYTES) throw invalidMask();
  const png = new Uint8Array(await mask.slice(0, 33).arrayBuffer());
  const maskDimensions = parseRasterImageDimensions(png);
  if (!maskDimensions || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => png[index] === value)
    || maskDimensions.width * maskDimensions.height > MAX_BASE_PIXELS) throw invalidMask();

  const baseBitmap = await createImageBitmap(base, { imageOrientation: 'from-image' });
  try {
    activeSignal.throwIfAborted();
    if (maskDimensions.width !== baseBitmap.width || maskDimensions.height !== baseBitmap.height) throw invalidMask();
    const canvas = document.createElement('canvas');
    canvas.width = baseBitmap.width;
    canvas.height = baseBitmap.height;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw invalidBase();
      const maskBitmap = await createImageBitmap(mask);
      try {
        context.drawImage(maskBitmap, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels.some((value, index) => index % 4 === 3 && value === 0)) throw invalidMask();
      } finally { maskBitmap.close(); }
      activeSignal.throwIfAborted();
      // 统一应用底图 EXIF 方向，并以和蒙版一致的 PNG 像素坐标提交。
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(baseBitmap, 0, 0);
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      activeSignal.throwIfAborted();
      if (!image?.size || image.size >= MAX_BASE_BYTES) throw invalidBase();
      return { image, mask };
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { baseBitmap.close(); }
}
