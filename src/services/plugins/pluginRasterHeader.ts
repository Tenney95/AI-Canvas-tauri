import { parseRasterImageDimensions, type RasterImageDimensions } from '../rasterImageDimensions';

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const ascii = (bytes: Uint8Array, offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));

interface JpegHeaderMessages {
  invalidSegment?: string;
  multipleFrames?: string;
  missingFrame?: string;
}

interface WebpHeaderMessages {
  invalidContainer?: string;
  truncatedChunk?: string;
  animated?: string;
  invalidExtendedHeader?: string;
  mismatchedDimensions?: string;
}

/** 不让多个 SOF 用后面的安全尺寸掩盖前面的超大 JPEG 帧。 */
export function assertStaticJpegHeader(bytes: Uint8Array, messages: JpegHeaderMessages = {}): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('图片文件头与 MIME 不匹配');
  let frames = 0;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('JPEG 图片头损坏');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > bytes.length) throw new Error('JPEG 图片头不完整');
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new Error(messages.invalidSegment ?? 'JPEG 图片头不完整');
    if (JPEG_FRAME_MARKERS.has(marker) && ++frames > 1) throw new Error(messages.multipleFrames ?? '不支持包含多个图像帧头的 JPEG');
    offset += length;
  }
  if (frames !== 1) throw new Error(messages.missingFrame ?? '无法确认 JPEG 图片尺寸');
}

/** 校验 WebP 容器和实际帧尺寸，避免仅信任可伪造的 VP8X 画布尺寸。 */
export function assertStaticWebpHeader(
  bytes: Uint8Array,
  assertDimensions: (dimensions: RasterImageDimensions | null) => void,
  messages: WebpHeaderMessages = {},
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP'
    || view.getUint32(4, true) + 8 !== bytes.length) throw new Error(messages.invalidContainer ?? 'WebP 图片头或容器长度无效');
  let encoded: RasterImageDimensions | null = null;
  let declared: RasterImageDimensions | null = null;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('WebP 图片头不完整');
    const kind = ascii(bytes, offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end + (length % 2) > bytes.length) throw new Error(messages.truncatedChunk ?? 'WebP 图片数据不完整');
    if (kind === 'ANIM' || kind === 'ANMF') throw new Error(messages.animated ?? '线稿转换仅支持静态图像');
    if (kind === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[start] & 2)) throw new Error(messages.invalidExtendedHeader ?? 'WebP 扩展帧头无效或包含动画');
      declared = parseRasterImageDimensions(bytes);
      assertDimensions(declared);
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (encoded || length < (kind === 'VP8 ' ? 10 : 5)) throw new Error('WebP 图像帧头无效');
      // 复用已有 VP8/VP8L 尺寸解析器；只构造固定的 30 字节帧头视图。
      const frameHeader = new Uint8Array(30);
      frameHeader.set(bytes.subarray(0, 12));
      frameHeader.set(bytes.subarray(offset, Math.min(end, offset + 18)), 12);
      encoded = parseRasterImageDimensions(frameHeader);
      assertDimensions(encoded);
    }
    offset = end + (length % 2);
  }
  if (!encoded || (declared && (declared.width !== encoded.width || declared.height !== encoded.height))) {
    throw new Error(messages.mismatchedDimensions ?? 'WebP 画布与图像尺寸不一致');
  }
}
