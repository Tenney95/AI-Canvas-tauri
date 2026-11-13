import { t } from '../i18n';
import { assertEditorCanvasBudget, assertEditorSourceBudget, canvasToDataUrl } from '../components/nodes/shared/image/imageResourceBudget';
import { characterVisualImageFormat, isCharacterVisualInputUrl } from './fs/characterVisualFiles';
import { readImageSourceBlob } from './fs/imageSourceBlob';
import { bytePartsToBase64Async } from './fs/core';
import { sha256BytesHex } from './mediaDataUrl';
import { parseRasterImageDimensions } from './rasterImageDimensions';

export const CHARACTER_VISUAL_VIEWS = [
  { id: 'sheet', label: '正背全身合图', ratio: '1:1', width: 1440, requirement: '两格分别展示同一角色的正面与背面。等高并排，从发顶到双脚完整入画，服饰、鞋和配饰在两格中对应。' },
  { id: 'side', label: '四分之三侧脸', ratio: '3:4', width: 1080, requirement: '单人头肩近景，头部约转 45 度，清楚呈现发型、眼睛及脸部轮廓。' },
  { id: 'front', label: '正面近脸', ratio: '3:4', width: 1080, requirement: '单人正面头肩近景，脸居中，眼睛朝向镜头，发顶与下颌完整入画。' },
] as const;

export type CharacterVisualView = typeof CHARACTER_VISUAL_VIEWS[number]['id'];
export interface CharacterVisualCrop { zoom: number; x: number; y: number }
export const DEFAULT_CHARACTER_VISUAL_CROP: CharacterVisualCrop = { zoom: 1, x: 50, y: 50 };

export async function freezeCharacterVisualMaskBase(source: string, signal: AbortSignal): Promise<{ url: string; digest: string }> {
  if (!isCharacterVisualInputUrl(source)) throw new Error(t('参考图片地址不可用'));
  const blob = await readImageSourceBlob(source, signal);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dimensions = parseRasterImageDimensions(bytes);
  if (!dimensions) throw new Error(t('图片读取失败'));
  assertEditorCanvasBudget(dimensions.width, dimensions.height);
  const format = characterVisualImageFormat(bytes);
  const digest = await sha256BytesHex(bytes);
  const encoded = await bytePartsToBase64Async([bytes], signal);
  signal.throwIfAborted();
  return { url: `data:${format.mime};base64,${encoded}`, digest };
}

async function decodeVisualImage(source: string, signal: AbortSignal): Promise<ImageBitmap> {
  if (!isCharacterVisualInputUrl(source)) throw new Error(t('参考图片地址不可用'));
  const blob = await readImageSourceBlob(source, signal);
  const dimensions = parseRasterImageDimensions(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()));
  if (!dimensions) throw new Error(t('图片读取失败'));
  assertEditorSourceBudget(dimensions.width, dimensions.height);
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
  return bitmap;
}

export async function prepareCharacterVisualMask(baseUrl: string, overlayUrl: string, signal: AbortSignal): Promise<string> {
  const base = await decodeVisualImage(baseUrl, signal);
  const { width, height } = base;
  base.close();
  assertEditorCanvasBudget(width, height);
  const overlay = await decodeVisualImage(overlayUrl, signal);
  const canvas = document.createElement('canvas');
  try {
    if (Math.abs(overlay.width / overlay.height - width / height) > 0.01) throw new Error(t('底图与蒙版尺寸不匹配'));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error(t('图片读取失败'));
    context.imageSmoothingEnabled = false;
    context.drawImage(overlay, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    let brushed = 0;
    for (let index = 0; index < pixels.data.length; index += 4) {
      const editable = pixels.data[index + 3] > 10;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255;
      pixels.data[index + 3] = editable ? 0 : 255;
      if (editable) brushed++;
    }
    if (!brushed) throw new Error(t('请先涂抹要修改的区域'));
    context.putImageData(pixels, 0, 0);
    const result = await canvasToDataUrl(canvas);
    signal.throwIfAborted();
    return result;
  } finally {
    overlay.close();
    canvas.width = canvas.height = 1;
  }
}

export async function composeCharacterVisualViews(
  inputs: readonly { url: string; width: number; crop: CharacterVisualCrop }[], signal: AbortSignal,
): Promise<string> {
  if (inputs.length < 2 || inputs.length > 3) throw new Error(t('请至少选择两张定妆图'));
  const height = 1440;
  const width = inputs.reduce((sum, input) => sum + input.width, 0);
  assertEditorCanvasBudget(width, height);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('图片读取失败'));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    let x = 0;
    for (const input of inputs) {
      const image = await decodeVisualImage(input.url, signal);
      try {
        const fit = Math.max(input.width / image.width, height / image.height) * input.crop.zoom;
        const sourceWidth = input.width / fit;
        const sourceHeight = height / fit;
        context.drawImage(image, (image.width - sourceWidth) * input.crop.x / 100,
          (image.height - sourceHeight) * input.crop.y / 100, sourceWidth, sourceHeight, x, 0, input.width, height);
        x += input.width;
      } finally { image.close(); }
    }
    const result = await canvasToDataUrl(canvas);
    signal.throwIfAborted();
    return result;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
