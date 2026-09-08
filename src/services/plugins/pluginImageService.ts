/** 固定的宿主本地线稿处理：只接收已授权图像字节，不读取 URL、路径或插件代码。 */
import { parseRasterImageDimensions, type RasterImageDimensions } from '../rasterImageDimensions';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16 * 1024 * 1024;
const MAX_OUTPUT_PIXELS = 1024 * 1024;
const MAX_PREVIEW_CHARS = 240_000;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface PluginLineArtImage {
  bytes: Uint8Array;
  mediaType: 'image/png';
  width: number;
  height: number;
  previewDataUrl: string;
}

interface LineArtOptions {
  signal?: AbortSignal;
  assertFresh?: () => void;
}

function assertCurrent(options: LineArtOptions): void {
  if (options.signal?.aborted) throw new Error('线稿转换已取消');
  options.assertFresh?.();
}

function assertDimensions(dimensions: RasterImageDimensions | null, maxPixels: number): asserts dimensions is RasterImageDimensions {
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
    || dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > maxPixels || dimensions.height > maxPixels
    || dimensions.width * dimensions.height > maxPixels) {
    throw new Error('线稿图片尺寸无效或超过处理上限');
  }
}

const ascii = (bytes: Uint8Array, offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** 不让多个 SOF 用后面的安全尺寸掩盖前面的超大 JPEG 帧。 */
function assertJpegHeader(bytes: Uint8Array): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('图片文件头与 MIME 不匹配');
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let frames = 0;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('JPEG 图片头损坏');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > bytes.length) throw new Error('JPEG 图片头不完整');
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 图片头不完整');
    if (sof.has(marker) && ++frames > 1) throw new Error('不支持包含多个图像帧头的 JPEG');
    offset += length;
  }
  if (frames !== 1) throw new Error('无法确认 JPEG 图片尺寸');
}

/** 校验 WebP 容器和实际帧尺寸，避免仅信任可伪造的 VP8X 画布尺寸。 */
function assertWebpHeader(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP'
    || view.getUint32(4, true) + 8 !== bytes.length) throw new Error('WebP 图片头或容器长度无效');
  let encoded: RasterImageDimensions | null = null;
  let declared: RasterImageDimensions | null = null;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('WebP 图片头不完整');
    const kind = ascii(bytes, offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end + (length % 2) > bytes.length) throw new Error('WebP 图片数据不完整');
    if (kind === 'ANIM' || kind === 'ANMF') throw new Error('线稿转换仅支持静态图像');
    if (kind === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[start] & 2)) throw new Error('WebP 扩展帧头无效或包含动画');
      declared = parseRasterImageDimensions(bytes);
      assertDimensions(declared, MAX_INPUT_PIXELS);
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (encoded || length < (kind === 'VP8 ' ? 10 : 5)) throw new Error('WebP 图像帧头无效');
      // 复用已有 VP8/VP8L 尺寸解析器；只构造固定的 30 字节帧头视图。
      const frameHeader = new Uint8Array(30);
      frameHeader.set(bytes.subarray(0, 12));
      frameHeader.set(bytes.subarray(offset, Math.min(end, offset + 18)), 12);
      encoded = parseRasterImageDimensions(frameHeader);
      assertDimensions(encoded, MAX_INPUT_PIXELS);
    }
    offset = end + (length % 2);
  }
  if (!encoded || (declared && (declared.width !== encoded.width || declared.height !== encoded.height))) {
    throw new Error('WebP 画布与图像尺寸不一致');
  }
}

function validateImageHeader(bytes: Uint8Array, mediaType: string): RasterImageDimensions {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('线稿源图片为空或超过 4 MiB 上限');
  }
  if (mediaType === 'image/png') {
    if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
      || ascii(bytes, 12) !== 'IHDR'
      || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13) {
      throw new Error('图片文件头与 PNG MIME 不匹配');
    }
  } else if (mediaType === 'image/jpeg') {
    assertJpegHeader(bytes);
  } else if (mediaType === 'image/webp') {
    assertWebpHeader(bytes);
  } else {
    throw new Error('线稿转换仅支持 JPEG、PNG、WebP 图像');
  }
  const dimensions = parseRasterImageDimensions(bytes);
  assertDimensions(dimensions, MAX_INPUT_PIXELS);
  return dimensions;
}

/** 将有界 RGBA 转成白纸上的黑色轮廓；透明像素先与白色合成。 */
export function rgbaToLineArt(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  assertDimensions({ width, height }, MAX_OUTPUT_PIXELS);
  const size = width * height;
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== size * 4) {
    throw new TypeError('线稿图片的 RGBA 像素数据无效');
  }
  const output = new Uint8ClampedArray(size * 4).fill(255);
  if (width < 3 || height < 3) return output;
  const gray = new Float32Array(size);
  const blurred = new Float32Array(size);
  const magnitude = new Float32Array(size);
  const direction = new Uint8Array(size);
  const suppressed = new Float32Array(size);
  const states = new Uint8Array(size);
  const stack = new Int32Array(size);
  const histogram = new Uint32Array(512);

  for (let i = 0; i < size; i += 1) {
    const offset = i * 4;
    const alpha = rgba[offset + 3] / 255;
    gray[i] = 255 + (rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722 - 255) * alpha;
  }
  // 可分离的 3x3 Gaussian [1, 2, 1]；钳制边界，避免产生虚假的深色边框。
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      blurred[index] = (gray[index - (x > 0 ? 1 : 0)] + 2 * gray[index] + gray[index + (x + 1 < width ? 1 : 0)]) / 4;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      gray[index] = (blurred[index - (y > 0 ? width : 0)] + 2 * blurred[index] + blurred[index + (y + 1 < height ? width : 0)]) / 4;
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const gx = (-gray[index - width - 1] + gray[index - width + 1] - 2 * gray[index - 1] + 2 * gray[index + 1] - gray[index + width - 1] + gray[index + width + 1]) / 4;
      const gy = (-gray[index - width - 1] - 2 * gray[index - width] - gray[index - width + 1] + gray[index + width - 1] + 2 * gray[index + width] + gray[index + width + 1]) / 4;
      magnitude[index] = Math.sqrt(gx * gx + gy * gy);
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      direction[index] = ay <= ax * 0.41421356237 ? 0 : (ax <= ay * 0.41421356237 ? 2 : (gx * gy >= 0 ? 1 : 3));
    }
  }
  let candidateCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const strength = magnitude[index];
      if (strength < 9) continue;
      const delta = direction[index] === 0 ? 1 : (direction[index] === 2 ? width : (direction[index] === 1 ? width + 1 : width - 1));
      if (strength < magnitude[index - delta] || strength <= magnitude[index + delta]) continue;
      suppressed[index] = strength;
      histogram[Math.min(511, Math.floor(strength))] += 1;
      candidateCount += 1;
    }
  }
  if (!candidateCount) return output;
  const percentileTarget = Math.ceil(candidateCount * 0.85);
  let cumulative = 0;
  let percentile = 9;
  for (let i = 9; i < histogram.length; i += 1) {
    cumulative += histogram[i];
    if (cumulative >= percentileTarget) { percentile = i; break; }
  }
  const highThreshold = Math.max(18, percentile * 0.45);
  const lowThreshold = Math.max(9, highThreshold * 0.45);
  let stackLength = 0;
  for (let i = 0; i < size; i += 1) {
    if (suppressed[i] >= highThreshold) {
      states[i] = 2;
      stack[stackLength++] = i;
    } else if (suppressed[i] >= lowThreshold) states[i] = 1;
  }
  // 弱轮廓只有与强边相连时才保留，避免把平坦区域的噪点提成线条。
  while (stackLength > 0) {
    const index = stack[--stackLength];
    const offset = index * 4;
    output[offset] = 0;
    output[offset + 1] = 0;
    output[offset + 2] = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const neighbor = index + dy * width + dx;
        if (states[neighbor] === 1) { states[neighbor] = 2; stack[stackLength++] = neighbor; }
      }
    }
  }
  return output;
}

function scaledDimensions(source: RasterImageDimensions, longestEdge: number): RasterImageDimensions {
  const scale = Math.min(1, longestEdge / Math.max(source.width, source.height));
  return { width: Math.max(1, Math.floor(source.width * scale)), height: Math.max(1, Math.floor(source.height * scale)) };
}

async function encodePng(canvas: HTMLCanvasElement, options: LineArtOptions): Promise<Uint8Array> {
  assertCurrent(options);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  assertCurrent(options);
  if (!blob || blob.type !== 'image/png' || blob.size < 1 || blob.size > MAX_IMAGE_BYTES) {
    throw new Error('线稿 PNG 编码失败或超过 4 MiB 上限');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertCurrent(options);
  const dimensions = validateImageHeader(bytes, 'image/png');
  if (dimensions.width !== canvas.width || dimensions.height !== canvas.height) throw new Error('线稿 PNG 编码尺寸不一致');
  return bytes;
}

function previewDataUrl(bytes: Uint8Array): string | null {
  if (PNG_PREFIX.length + 4 * Math.ceil(bytes.length / 3) > MAX_PREVIEW_CHARS) return null;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return PNG_PREFIX + btoa(binary);
}

export async function createPluginLineArtImage(
  input: { bytes: Uint8Array; mediaType: string },
  options: LineArtOptions = {},
): Promise<PluginLineArtImage> {
  assertCurrent(options);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('线稿源图片为空或超过 4 MiB 上限');
  }
  // 先取得自有快照，再校验并解码相同字节；避免共享缓冲区在校验后被修改。
  const sourceBytes = new Uint8Array(input.bytes);
  const headerDimensions = validateImageHeader(sourceBytes, input.mediaType);
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error('当前环境不支持本地线稿转换');
  const blob = new Blob([sourceBytes], { type: input.mediaType });
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let preview: HTMLCanvasElement | undefined;
  try {
    assertCurrent(options);
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    assertCurrent(options);
    assertDimensions(bitmap, MAX_INPUT_PIXELS);
    if (bitmap.width !== headerDimensions.width || bitmap.height !== headerDimensions.height) {
      throw new Error('解码图像与已验证的文件头尺寸不一致');
    }
    const { width, height } = scaledDimensions(bitmap, 1024);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('当前环境不能绘制线稿');
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    pixels.data.set(rgbaToLineArt(pixels.data, width, height));
    context.putImageData(pixels, 0, 0);
    assertCurrent(options);
    const bytes = await encodePng(canvas, options);
    assertCurrent(options);
    let dataUrl = Math.max(width, height) <= 640 ? previewDataUrl(bytes) : null;
    if (!dataUrl) {
      preview = document.createElement('canvas');
      for (let edge = Math.min(640, Math.max(width, height)); ; edge = Math.max(1, Math.floor(edge * 0.75))) {
        assertCurrent(options);
        const dimensions = scaledDimensions(canvas, edge);
        preview.width = dimensions.width;
        preview.height = dimensions.height;
        const previewContext = preview.getContext('2d');
        if (!previewContext) throw new Error('当前环境不能绘制线稿预览');
        previewContext.drawImage(canvas, 0, 0, preview.width, preview.height);
        dataUrl = previewDataUrl(await encodePng(preview, options));
        assertCurrent(options);
        if (dataUrl) break;
        if (edge === 1) throw new Error('线稿预览超过大小上限');
      }
    }
    assertCurrent(options);
    return { bytes, mediaType: 'image/png', width, height, previewDataUrl: dataUrl };
  } finally {
    // createImageBitmap 没有取消接口；即使等待解码期间撤销租约，得到的位图也必定在此关闭。
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    if (preview) { preview.width = 0; preview.height = 0; }
  }
}
