import { describe, expect, it } from 'vitest';
import { parseRasterImageDimensions } from '../../src/services/rasterImageDimensions';

const writeU32Be = (bytes: Uint8Array, offset: number, value: number) => {
  new DataView(bytes.buffer).setUint32(offset, value, false);
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const jpegSegment = (marker: number, payload: Uint8Array): Uint8Array => {
  const segment = new Uint8Array(payload.length + 4);
  segment.set([0xff, marker], 0);
  new DataView(segment.buffer).setUint16(2, payload.length + 2, false);
  segment.set(payload, 4);
  return segment;
};

describe('parseRasterImageDimensions', () => {
  it('reads PNG dimensions from IHDR without decoding pixels', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    writeU32Be(bytes, 16, 8192);
    writeU32Be(bytes, 20, 4096);
    expect(parseRasterImageDimensions(bytes)).toEqual({ width: 8192, height: 4096 });
  });

  it('reads JPEG SOF dimensions without creating an image element', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x10, 0x00, 0x20, 0x00,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    expect(parseRasterImageDimensions(bytes)).toEqual({ width: 8192, height: 4096 });
  });

  it('reads GIF, WebP VP8X and BMP dimensions', () => {
    const gif = new Uint8Array(10);
    gif.set([...'GIF89a'].map((char) => char.charCodeAt(0)));
    new DataView(gif.buffer).setUint16(6, 640, true);
    new DataView(gif.buffer).setUint16(8, 360, true);

    const webp = new Uint8Array(30);
    webp.set([...'RIFF'].map((char) => char.charCodeAt(0)), 0);
    webp.set([...'WEBP'].map((char) => char.charCodeAt(0)), 8);
    webp.set([...'VP8X'].map((char) => char.charCodeAt(0)), 12);
    const webpWidth = 1920 - 1;
    const webpHeight = 1080 - 1;
    webp.set([webpWidth & 0xff, (webpWidth >> 8) & 0xff, (webpWidth >> 16) & 0xff], 24);
    webp.set([webpHeight & 0xff, (webpHeight >> 8) & 0xff, (webpHeight >> 16) & 0xff], 27);

    const bmp = new Uint8Array(26);
    bmp.set([0x42, 0x4d]);
    new DataView(bmp.buffer).setInt32(18, 800, true);
    new DataView(bmp.buffer).setInt32(22, -600, true);

    expect(parseRasterImageDimensions(gif)).toEqual({ width: 640, height: 360 });
    expect(parseRasterImageDimensions(webp)).toEqual({ width: 1920, height: 1080 });
    expect(parseRasterImageDimensions(bmp)).toEqual({ width: 800, height: 600 });
  });

  it('reads fixed-size SVG metadata and fails closed for ambiguous AVIF item metadata', () => {
    const avif = new Uint8Array(48);
    avif.set([...'ftyp'].map((char) => char.charCodeAt(0)), 4);
    avif.set([...'avif'].map((char) => char.charCodeAt(0)), 8);
    avif.set([...'ispe'].map((char) => char.charCodeAt(0)), 24);
    new DataView(avif.buffer).setUint32(32, 3840, false);
    new DataView(avif.buffer).setUint32(36, 2160, false);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"></svg>');
    const svgWithDataAttributes = new TextEncoder().encode(
      '<svg data-width="9999" data-height="9999" viewBox="0 0 640 360"></svg>',
    );
    expect(parseRasterImageDimensions(avif)).toBeNull();
    expect(parseRasterImageDimensions(svg)).toEqual({ width: 1280, height: 720 });
    expect(parseRasterImageDimensions(svgWithDataAttributes)).toEqual({ width: 640, height: 360 });
  });

  it('fails closed when AVIF or HEIC metadata contains SVG-looking text', () => {
    const avif = new Uint8Array(128);
    writeU32Be(avif, 0, avif.length);
    avif.set([...'ftyp'].map((char) => char.charCodeAt(0)), 4);
    avif.set([...'mif1'].map((char) => char.charCodeAt(0)), 8);
    avif.set([...'avif'].map((char) => char.charCodeAt(0)), 16);
    avif.set(new TextEncoder().encode('<svg width="8192" height="4096"></svg>'), 32);

    const heic = new Uint8Array(128);
    writeU32Be(heic, 0, heic.length);
    heic.set([...'ftyp'].map((char) => char.charCodeAt(0)), 4);
    heic.set([...'heic'].map((char) => char.charCodeAt(0)), 8);
    heic.set(new TextEncoder().encode('<svg width="8192" height="4096"></svg>'), 32);

    expect(parseRasterImageDimensions(avif)).toBeNull();
    expect(parseRasterImageDimensions(heic)).toBeNull();
  });

  it('only accepts SVG markup at the beginning of textual input', () => {
    const binaryWithSvgMetadata = concatBytes(
      new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      new TextEncoder().encode('<svg width="640" height="360"></svg>'),
    );
    const xmlSvg = new TextEncoder().encode(
      '  <?xml version="1.0" encoding="UTF-8"?>\n<svg width="640" height="360"></svg>',
    );

    expect(parseRasterImageDimensions(binaryWithSvgMetadata)).toBeNull();
    expect(parseRasterImageDimensions(xmlSvg)).toEqual({ width: 640, height: 360 });
  });

  it('applies JPEG EXIF orientation before reporting display dimensions', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x10, 0x00, 0x20, 0x00,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
      0xff, 0xda,
    ]);
    expect(parseRasterImageDimensions(bytes)).toEqual({ width: 4096, height: 8192 });
  });

  it('preserves the first valid JPEG EXIF orientation across later APP1 metadata', () => {
    const exifPayload = new Uint8Array([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const xmpPayload = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta></x:xmpmeta>');
    const sof = new Uint8Array([
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x10, 0x00, 0x20, 0x00,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    const bytes = concatBytes(
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe1, exifPayload),
      jpegSegment(0xe1, xmpPayload),
      sof,
      new Uint8Array([0xff, 0xda]),
    );

    expect(parseRasterImageDimensions(bytes)).toEqual({ width: 4096, height: 8192 });
  });
});
