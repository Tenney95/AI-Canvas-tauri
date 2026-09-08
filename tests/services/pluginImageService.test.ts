import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginLineArtImage, rgbaToLineArt } from '../../src/services/plugins/pluginImageService';

function pixels(width: number, height: number, color: (x: number, y: number) => number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = color(x, y);
    }
  }
  return rgba;
}

describe('rgbaToLineArt', () => {
  it('produces thin black contours and opaque white interiors without changing the source', () => {
    const source = pixels(32, 32, (x, y) => x >= 8 && x < 24 && y >= 8 && y < 24 ? 0 : 255);
    const unchanged = source.slice();
    const result = rgbaToLineArt(source, 32, 32);
    const black: number[] = [];
    for (let i = 0; i < result.length; i += 4) {
      expect([0, 255]).toContain(result[i]);
      expect(result[i + 1]).toBe(result[i]);
      expect(result[i + 2]).toBe(result[i]);
      expect(result[i + 3]).toBe(255);
      if (!result[i]) black.push(i / 4);
    }
    expect(black.length).toBeGreaterThan(40);
    expect(black.length).toBeLessThan(90);
    expect(result[(16 * 32 + 16) * 4]).toBe(255);
    expect(result[0]).toBe(255);
    expect(source).toEqual(unchanged);
  });

  it('does not reveal hidden RGB under transparent pixels or amplify flat-area noise', () => {
    const source = pixels(16, 16, (x) => x < 8 ? 0 : 255);
    for (let i = 3; i < source.length; i += 4) source[i] = 0;
    expect(rgbaToLineArt(source, 16, 16).every((value) => value === 255)).toBe(true);
    const noise = pixels(16, 16, (x, y) => 128 + ((x + y) % 3));
    expect(rgbaToLineArt(noise, 16, 16).every((value) => value === 255)).toBe(true);
  });

  it('supports narrow images and rejects invalid dimensions or pixel buffers before allocation', () => {
    expect(rgbaToLineArt(new Uint8Array(8), 1, 2)).toEqual(new Uint8ClampedArray(8).fill(255));
    for (const [width, height] of [[0, 1], [1.5, 2], [NaN, 1], [Infinity, 1], [1025, 1024], [Number.MAX_SAFE_INTEGER, 2]]) {
      expect(() => rgbaToLineArt(new Uint8Array(), width, height)).toThrow('尺寸');
    }
    expect(() => rgbaToLineArt(new Uint8Array(3), 1, 1)).toThrow('RGBA');
    expect(() => rgbaToLineArt([0, 0, 0, 255] as unknown as Uint8Array, 1, 1)).toThrow('RGBA');
  });
});

// DOM 解码/编码在这些单元测试中模拟；文件头包含真实字段，像素算法使用真实 RGBA。
function png(width = 8, height = 8, size = 33): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function jpeg(width = 8, height = 8): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255,
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    0xff, 0xda,
  ]);
}

function webp(width = 8, height = 8, declared?: { width: number; height: number; animation?: boolean }): Uint8Array {
  const bytes = new Uint8Array(declared ? 48 : 30);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  let offset = 12;
  if (declared) {
    bytes.set(new TextEncoder().encode('VP8X'), offset);
    view.setUint32(offset + 4, 10, true);
    bytes[offset + 8] = declared.animation ? 2 : 0;
    for (const [position, value] of [[24, declared.width - 1], [27, declared.height - 1]]) {
      bytes.set([value & 255, (value >> 8) & 255, (value >> 16) & 255], position);
    }
    offset += 18;
  }
  bytes.set(new TextEncoder().encode('VP8L'), offset);
  view.setUint32(offset + 4, 9, true);
  bytes[offset + 8] = 0x2f;
  view.setUint32(offset + 9, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

class CanvasDouble {
  width = 0;
  height = 0;
  context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels(this.width, this.height, (x) => x < this.width / 2 ? 0 : 255) })),
    putImageData: vi.fn(),
  };
  getContext = vi.fn(() => this.context);
  toBlob = vi.fn((callback: BlobCallback, type: string) => {
    const result = encode(this, type);
    void Promise.resolve(result).then(callback);
  });
}

const encode = vi.fn<(canvas: CanvasDouble, type: string) => Blob | null | Promise<Blob | null>>();
const decode = vi.fn();
const close = vi.fn();
const canvases: CanvasDouble[] = [];

describe('createPluginLineArtImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvases.length = 0;
    decode.mockResolvedValue({ width: 8, height: 8, close });
    encode.mockImplementation((canvas, type) => new Blob([new Uint8Array(png(canvas.width, canvas.height))], { type }));
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        expect(tag).toBe('canvas');
        const canvas = new CanvasDouble();
        canvases.push(canvas);
        return canvas;
      }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['image/png', png()], ['image/jpeg', jpeg()], ['image/webp', webp()], ['image/webp', webp(8, 8, { width: 8, height: 8 })],
  ])('accepts verified %s and returns PNG bytes, dimensions and a bounded PNG preview', async (mediaType, bytes) => {
    const assertFresh = vi.fn();
    const result = await createPluginLineArtImage({ mediaType: mediaType as string, bytes: bytes as Uint8Array }, { assertFresh });
    expect(result).toMatchObject({ mediaType: 'image/png', width: 8, height: 8 });
    expect(result.previewDataUrl).toBe(`data:image/png;base64,${Buffer.from(result.bytes).toString('base64')}`);
    expect(result.previewDataUrl.length).toBeLessThanOrEqual(240_000);
    expect(decode.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(decode.mock.calls[0][0].type).toBe(mediaType);
    expect(canvases[0].context.putImageData).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(assertFresh.mock.calls.length).toBeGreaterThan(5);
  });

  it.each([
    ['empty', new Uint8Array(), 'image/png'],
    ['bytes over budget', png(8, 8, 4 * 1024 * 1024 + 1), 'image/png'],
    ['pixels over budget', png(8192, 4096), 'image/png'],
    ['zero dimensions', png(0, 8), 'image/png'],
    ['MIME mismatch', png(), 'image/jpeg'],
    ['SVG', new TextEncoder().encode('<svg width="8" height="8"/>'), 'image/svg+xml'],
    ['truncated JPEG', jpeg().subarray(0, 12), 'image/jpeg'],
    ['WebP frame/canvas mismatch', webp(16, 16, { width: 8, height: 8 }), 'image/webp'],
    ['WebP animation', webp(8, 8, { width: 8, height: 8, animation: true }), 'image/webp'],
    ['WebP truncation', webp().subarray(0, 29), 'image/webp'],
  ])('rejects %s before creating any decoder or canvas', async (_name, bytes, mediaType) => {
    await expect(createPluginLineArtImage({ bytes: bytes as Uint8Array, mediaType: mediaType as string })).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
    expect(canvases).toHaveLength(0);
  });

  it('checks the full PNG signature and rejects duplicate JPEG frame headers', async () => {
    const fakePng = png(); fakePng[4] = 0;
    await expect(createPluginLineArtImage({ bytes: fakePng, mediaType: 'image/png' })).rejects.toThrow('MIME');
    const first = jpeg(8192, 4096);
    const second = jpeg(8, 8);
    const duplicated = new Uint8Array([...first.subarray(0, -2), ...second.subarray(2)]);
    await expect(createPluginLineArtImage({ bytes: duplicated, mediaType: 'image/jpeg' })).rejects.toThrow('多个');
    expect(decode).not.toHaveBeenCalled();
  });

  it('checks actual decoded dimensions and closes an inconsistent bitmap', async () => {
    decode.mockResolvedValue({ width: 8192, height: 8192, close });
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' })).rejects.toThrow('尺寸');
    expect(close).toHaveBeenCalledOnce();
    expect(canvases).toHaveLength(0);
    decode.mockResolvedValue({ width: 9, height: 8, close });
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' })).rejects.toThrow('不一致');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('downscales large inputs to a 1024 longest edge and independently bounds preview size', async () => {
    decode.mockResolvedValue({ width: 4096, height: 2048, close });
    const dimensions: number[][] = [];
    encode.mockImplementation((canvas, type) => {
      dimensions.push([canvas.width, canvas.height]);
      const size = canvas.width > 480 ? 200_000 : 100_000;
      return new Blob([new Uint8Array(png(canvas.width, canvas.height, size))], { type });
    });
    const result = await createPluginLineArtImage({ bytes: png(4096, 2048), mediaType: 'image/png' });
    expect(result).toMatchObject({ width: 1024, height: 512 });
    expect(dimensions).toEqual([[1024, 512], [640, 320], [480, 240]]);
    expect(result.previewDataUrl.length).toBeLessThanOrEqual(240_000);
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every((canvas) => !canvas.width && !canvas.height)).toBe(true);
  });

  it('does not decode when already aborted or when the lease is stale', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' }, { signal: controller.signal })).rejects.toThrow('取消');
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' }, { assertFresh: () => { throw new Error('租约失效'); } })).rejects.toThrow('租约');
    expect(decode).not.toHaveBeenCalled();
  });

  it('closes a late bitmap when cancellation happens while decoding', async () => {
    const controller = new AbortController();
    let resolveDecode!: (value: { width: number; height: number; close: typeof close }) => void;
    decode.mockReturnValue(new Promise((resolve) => { resolveDecode = resolve; }));
    const pending = createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' }, { signal: controller.signal });
    controller.abort();
    resolveDecode({ width: 8, height: 8, close });
    await expect(pending).rejects.toThrow('取消');
    expect(close).toHaveBeenCalledOnce();
    expect(canvases).toHaveLength(0);
  });

  it('rechecks the lease immediately after decode and does not draw a stale result', async () => {
    let active = true;
    decode.mockImplementation(async () => { active = false; return { width: 8, height: 8, close }; });
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' }, {
      assertFresh: () => { if (!active) throw new Error('租约失效'); },
    })).rejects.toThrow('租约失效');
    expect(close).toHaveBeenCalledOnce();
    expect(canvases).toHaveLength(0);
  });

  it('discards output and releases all buffers if cancellation happens during PNG encoding', async () => {
    const controller = new AbortController();
    encode.mockImplementation((canvas) => {
      controller.abort();
      return new Blob([new Uint8Array(png(canvas.width, canvas.height))], { type: 'image/png' });
    });
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' }, { signal: controller.signal })).rejects.toThrow('取消');
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every((canvas) => !canvas.width && !canvas.height)).toBe(true);
  });

  it.each(['null', 'MIME', 'size', 'dimensions', 'header'] as const)('fails closed on invalid PNG encoding: %s', async (failure) => {
    encode.mockImplementation(() => failure === 'null' ? null : new Blob([
      new Uint8Array(failure === 'size' ? new Uint8Array(4 * 1024 * 1024 + 1)
        : failure === 'header' ? new Uint8Array([1, 2, 3]) : png(failure === 'dimensions' ? 9 : 8, 8)),
    ], { type: failure === 'MIME' ? 'image/jpeg' : 'image/png' }));
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' })).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every((canvas) => !canvas.width && !canvas.height)).toBe(true);
  });

  it('propagates a decode rejection without creating fallback URLs or canvases', async () => {
    decode.mockRejectedValue(new Error('corrupt pixels'));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    await expect(createPluginLineArtImage({ bytes: png(), mediaType: 'image/png' })).rejects.toThrow('corrupt pixels');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(canvases).toHaveLength(0);
  });
});
