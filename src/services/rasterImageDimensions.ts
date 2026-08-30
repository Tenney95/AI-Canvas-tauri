export interface RasterImageDimensions {
  width: number;
  height: number;
}

const MAX_HEADER_BYTES = 1024 * 1024;

const ascii = (bytes: Uint8Array, offset: number, length: number): string => String.fromCharCode(
  ...bytes.subarray(offset, offset + length),
);

const readU16Le = (bytes: Uint8Array, offset: number): number => (
  bytes[offset] | (bytes[offset + 1] << 8)
);

const readU24Le = (bytes: Uint8Array, offset: number): number => (
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
);

const readU32Be = (bytes: Uint8Array, offset: number): number => (
  ((bytes[offset] << 24) >>> 0)
  + (bytes[offset + 1] << 16)
  + (bytes[offset + 2] << 8)
  + bytes[offset + 3]
);

const readI32Le = (bytes: Uint8Array, offset: number): number => new DataView(
  bytes.buffer,
  bytes.byteOffset + offset,
  4,
).getInt32(0, true);

function validDimensions(width: number, height: number): RasterImageDimensions | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  return { width, height };
}

function readExifOrientation(bytes: Uint8Array, segmentOffset: number, segmentLength: number): number | null {
  const payloadOffset = segmentOffset + 2;
  const segmentEnd = payloadOffset + segmentLength - 2;
  if (segmentLength < 16 || segmentEnd > bytes.length) return null;
  if (ascii(bytes, payloadOffset, 6) !== 'Exif\0\0') return null;

  const tiffOffset = payloadOffset + 6;
  if (tiffOffset + 8 > segmentEnd) return null;
  const byteOrder = ascii(bytes, tiffOffset, 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readU16 = (offset: number) => view.getUint16(offset, littleEndian);
  const readU32 = (offset: number) => view.getUint32(offset, littleEndian);
  if (readU16(tiffOffset + 2) !== 42) return null;

  const firstIfdOffset = readU32(tiffOffset + 4);
  const ifdOffset = tiffOffset + firstIfdOffset;
  if (ifdOffset + 2 > segmentEnd) return null;
  const entryCount = readU16(ifdOffset);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > segmentEnd) return null;
    if (readU16(entryOffset) !== 0x0112) continue;
    const type = readU16(entryOffset + 2);
    const count = readU32(entryOffset + 4);
    if (type !== 3 || count < 1) return null;
    const orientation = readU16(entryOffset + 8);
    return orientation >= 1 && orientation <= 8 ? orientation : null;
  }
  return null;
}

function readJpegDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let encodedDimensions: RasterImageDimensions | null = null;
  let orientation: number | null = null;

  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (marker === 0xe1 && orientation === null) {
      const candidate = readExifOrientation(bytes, offset, segmentLength);
      if (candidate !== null) orientation = candidate;
    }
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      encodedDimensions = validDimensions(
        (bytes[offset + 5] << 8) | bytes[offset + 6],
        (bytes[offset + 3] << 8) | bytes[offset + 4],
      );
    }
    offset += segmentLength;
  }

  if (!encodedDimensions) return null;
  return (orientation ?? 1) >= 5 && (orientation ?? 1) <= 8
    ? { width: encodedDimensions.height, height: encodedDimensions.width }
    : encodedDimensions;
}

function readWebpDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    return validDimensions(readU24Le(bytes, 24) + 1, readU24Le(bytes, 27) + 1);
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    const height = 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    return validDimensions(width, height);
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return validDimensions(readU16Le(bytes, 26) & 0x3fff, readU16Le(bytes, 28) & 0x3fff);
  }
  return null;
}

function readSvgDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  const source = new TextDecoder().decode(bytes).trimStart();
  const svgTag = source.match(/^(?:<\?xml\b[^>]*>\s*)?(<svg\b[^>]*>)/i)?.[1];
  if (!svgTag) return null;
  const readLength = (name: string) => {
    const raw = svgTag.match(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(?:px)?\\s*["']`, 'i'))?.[1];
    return raw ? Math.ceil(Number(raw)) : null;
  };
  const width = readLength('width');
  const height = readLength('height');
  if (width && height) return validDimensions(width, height);

  const viewBox = svgTag.match(/\bviewBox\s*=\s*["']\s*([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)[\s,]+([-+0-9.eE]+)\s*["']/i);
  if (!viewBox) return null;
  return validDimensions(Math.ceil(Number(viewBox[3])), Math.ceil(Number(viewBox[4])));
}

const ISO_BMFF_IMAGE_BRANDS = new Set([
  'avif', 'avis',
  'heic', 'heix', 'hevc', 'hevx',
  'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1',
]);

function isIsoBmffImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return false;

  const declaredBoxSize = readU32Be(bytes, 0);
  if (declaredBoxSize !== 0 && declaredBoxSize < 12) return false;
  const boxEnd = Math.min(
    bytes.length,
    declaredBoxSize === 0 ? bytes.length : declaredBoxSize,
    64,
  );
  if (ISO_BMFF_IMAGE_BRANDS.has(ascii(bytes, 8, 4))) return true;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    if (ISO_BMFF_IMAGE_BRANDS.has(ascii(bytes, offset, 4))) return true;
  }
  return false;
}

export function parseRasterImageDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (isIsoBmffImage(bytes)) return null;
  if (bytes.length >= 24
    && bytes[0] === 0x89
    && ascii(bytes, 1, 3) === 'PNG'
    && ascii(bytes, 12, 4) === 'IHDR') {
    return validDimensions(readU32Be(bytes, 16), readU32Be(bytes, 20));
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return validDimensions(readU16Le(bytes, 6), readU16Le(bytes, 8));
  }
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return validDimensions(Math.abs(readI32Le(bytes, 18)), Math.abs(readI32Le(bytes, 22)));
  }
  return readJpegDimensions(bytes)
    ?? readWebpDimensions(bytes)
    ?? readSvgDimensions(bytes);
}

/** 只读取编码头，避免用 HTMLImageElement/naturalWidth 做一次隐式完整解码。 */
export async function readRasterImageDimensions(blob: Blob): Promise<RasterImageDimensions | null> {
  const header = new Uint8Array(await blob.slice(0, MAX_HEADER_BYTES).arrayBuffer());
  return parseRasterImageDimensions(header);
}
