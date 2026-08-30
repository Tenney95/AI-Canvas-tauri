import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_EDITOR_OUTPUT_RGBA_BYTES,
  assertEditorCanvasBudget,
  canvasToDataUrl,
  estimateRgbaBytes,
  getComposerFilterCacheBudgetError,
  getComposerFilterCacheAggregateBudgetError,
  getComposerPeakWorkingSetBudgetError,
  estimateComposerFilterCacheWorkingSetBytes,
  getComposerSourceBudgetError,
  getEditorCanvasBudgetError,
  getEditorSourceBudgetError,
} from '../../src/components/nodes/shared/image/imageResourceBudget';
import {
  floodFillImageData,
  trimImageDataHistory,
} from '../../src/components/nodes/shared/image/mattingUtils';

const makeImageData = (width: number, height: number): ImageData => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
  colorSpace: 'srgb',
} as ImageData);

afterEach(() => vi.unstubAllGlobals());

describe('image editor resource budgets', () => {
  it('keeps standard 4096×4096 available and rejects a wider 4K surface', () => {
    expect(assertEditorCanvasBudget(4096, 4096).bytes).toBe(MAX_EDITOR_OUTPUT_RGBA_BYTES);
    expect(getEditorCanvasBudgetError(4096, 4096, '合成导出')).toBeNull();
    expect(getEditorCanvasBudgetError(7282, 4096, '合成导出')).toContain('约 456 MiB 峰值内存');
    expect(getEditorCanvasBudgetError(7282, 4096, '合成导出')).toContain('超过 256 MiB');
  });

  it('rejects pathological edges independently of total pixels', () => {
    expect(getEditorCanvasBudgetError(9000, 100, '裁切输出')).toContain('单边 8192px');
    expect(estimateRgbaBytes(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it('bounds decoded editor source images before a second surface can be allocated', () => {
    expect(getEditorSourceBudgetError(7680, 4320, '编辑源图')).toBeNull();
    expect(getEditorSourceBudgetError(8192, 8192, '编辑源图')).toContain('超过 256 MiB');
  });

  it('includes blur padding in composer filter cache estimates', () => {
    expect(getComposerFilterCacheBudgetError(4096, 4096, 0)).toBeNull();
    expect(getComposerFilterCacheBudgetError(4096, 4096, 4)).toContain('超过 256 MiB');
  });

  it('limits all enabled composer filter caches as a four-surface working set', () => {
    const one2kCache = estimateComposerFilterCacheWorkingSetBytes(2048, 2048, 0)!;
    expect(one2kCache).toBe(64 * 1024 * 1024);
    expect(getComposerFilterCacheAggregateBudgetError(one2kCache * 3, 2048, 2048, 0)).toBeNull();
    expect(getComposerFilterCacheAggregateBudgetError(one2kCache * 4, 2048, 2048, 0))
      .toContain('累计预计需要约 320 MiB');
  });

  it('caps the combined composer source, filter and export peak', () => {
    const sourceBytes = 256 * 1024 * 1024;
    const one2kCache = estimateComposerFilterCacheWorkingSetBytes(2048, 2048, 0)!;
    expect(getComposerFilterCacheAggregateBudgetError(0, 2048, 2048, 0, sourceBytes)).toBeNull();
    expect(getComposerFilterCacheAggregateBudgetError(one2kCache * 2, 2048, 2048, 0, sourceBytes))
      .toContain('合成器稳态上限');
    expect(getComposerPeakWorkingSetBudgetError(sourceBytes, 128 * 1024 * 1024, 4096, 4096))
      .toBeNull();
    expect(getComposerPeakWorkingSetBudgetError(sourceBytes, 256 * 1024 * 1024, 4096, 4096))
      .toContain('超过 640 MiB');
  });

  it('limits aggregate decoded composer source images', () => {
    const existingBytes = 200 * 1024 * 1024;
    expect(getComposerSourceBudgetError(existingBytes, 4096, 4096)).toContain('超过 256 MiB');
    expect(getComposerSourceBudgetError(0, 4096, 4096)).toBeNull();
  });

  it('encodes canvas through the asynchronous Blob path', async () => {
    class TestFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

      readAsDataURL() {
        this.result = 'data:image/png;base64,b2s=';
        this.onload?.({} as ProgressEvent<FileReader>);
      }
    }
    vi.stubGlobal('FileReader', TestFileReader as unknown as typeof FileReader);
    const canvas = {
      toBlob: (callback: BlobCallback) => callback(new Blob(['ok'], { type: 'image/png' })),
    } as HTMLCanvasElement;

    await expect(canvasToDataUrl(canvas)).resolves.toBe('data:image/png;base64,b2s=');
  });
});

describe('matting resource helpers', () => {
  it('fills one connected region without crossing a color barrier', () => {
    const image = makeImageData(5, 3);
    for (let y = 0; y < image.height; y += 1) {
      const barrier = (y * image.width + 2) * 4;
      image.data.set([255, 255, 255, 255], barrier);
    }

    expect(floodFillImageData(image, 0, 0, [255, 200, 0, 255])).toBe(true);
    expect(Array.from(image.data.slice(0, 4))).toEqual([255, 200, 0, 255]);
    expect(Array.from(image.data.slice(2 * 4, 3 * 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(image.data.slice(4 * 4, 5 * 4))).toEqual([0, 0, 0, 0]);
  });

  it('does not enqueue work when the start pixel already has the fill color', () => {
    const image = makeImageData(2, 2);
    image.data.set([255, 200, 0, 255], 0);
    expect(floodFillImageData(image, 0, 0, [255, 200, 0, 255])).toBe(false);
  });

  it('evicts oldest snapshots by bytes and retains the newest oversized entry', () => {
    const snapshots = [1, 2, 3, 4].map(() => makeImageData(5, 2)); // 40 bytes each
    expect(trimImageDataHistory(snapshots, 96)).toEqual(snapshots.slice(2));
    expect(trimImageDataHistory([makeImageData(10, 10)], 1)).toHaveLength(1);
  });
});
