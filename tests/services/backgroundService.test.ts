import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compressImageLossless } from '../../src/services/backgroundService';

type ImageBehavior = 'load' | 'error';

let imageBehavior: ImageBehavior;
let imageWidth: number;
let imageHeight: number;
let encodingError: Error | null;
let canvases: TestCanvas[];

const createObjectURL = vi.fn(() => `blob:test-${createObjectURL.mock.calls.length}`);
const revokeObjectURL = vi.fn();

class TestImage {
  naturalWidth = imageWidth;
  naturalHeight = imageHeight;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => {
      if (imageBehavior === 'load') {
        this.onload?.();
      } else {
        this.onerror?.();
      }
    });
  }
}

class TestCanvas {
  width = 0;
  height = 0;

  getContext() {
    return { drawImage: vi.fn() };
  }

  toBlob(callback: BlobCallback, type: string) {
    if (encodingError) throw encodingError;
    const size = type === 'image/webp' ? 8 : 16;
    callback(new Blob([new Uint8Array(size)], { type }));
  }
}

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    this.result = `data:${blob.type};base64,dGVzdA==`;
    queueMicrotask(() => this.onload?.());
  }
}

function createImageFile(): File {
  return Object.assign(
    new Blob([new Uint8Array(1024)], { type: 'image/png' }),
    { name: 'test.png', lastModified: 0 },
  ) as File;
}

beforeEach(() => {
  imageBehavior = 'load';
  imageWidth = 100;
  imageHeight = 100;
  encodingError = null;
  canvases = [];
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();

  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal('FileReader', TestFileReader);
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = new TestCanvas();
      canvases.push(canvas);
      return canvas;
    },
  });
});

describe('compressImageLossless resource cleanup', () => {
  it('creates and revokes one object URL and releases the canvas after successful encoding', async () => {
    await expect(compressImageLossless(createImageFile())).resolves.toMatchObject({
      format: 'webp',
      keptOriginal: false,
    });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
  });

  it('revokes the object URL once when image loading fails', async () => {
    imageBehavior = 'error';

    await expect(compressImageLossless(createImageFile())).rejects.toThrow('图片加载失败');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(canvases).toHaveLength(0);
  });

  it('revokes the object URL once when the image exceeds the pixel limit', async () => {
    imageWidth = 5000;
    imageHeight = 5000;

    await expect(compressImageLossless(createImageFile())).rejects.toThrow('图片分辨率过高');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(canvases).toHaveLength(0);
  });

  it('revokes the object URL once and releases the canvas after an encoding exception', async () => {
    encodingError = new Error('encoding failed');

    await expect(compressImageLossless(createImageFile())).rejects.toThrow('encoding failed');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
  });

  it('balances object URL creation and cleanup across 100 repeated imports', async () => {
    await Promise.all(Array.from({ length: 100 }, () => compressImageLossless(createImageFile())));

    expect(createObjectURL).toHaveBeenCalledTimes(100);
    expect(revokeObjectURL).toHaveBeenCalledTimes(100);
    expect(canvases).toHaveLength(100);
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });
});
