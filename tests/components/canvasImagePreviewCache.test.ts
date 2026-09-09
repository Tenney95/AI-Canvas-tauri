import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CanvasImagePreviewLease } from '../../src/components/nodes/shared/image/canvasImagePreviewCache';

const dimensions = vi.hoisted(() => ({ width: 4096, height: 2048 }));
const disk = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../../src/services/fs/thumbnailCache', () => ({ prepareProjectThumbnail: disk.prepare }));
vi.mock('../../src/services/rasterImageDimensions', () => ({
  readRasterImageDimensions: vi.fn(async () => ({ ...dimensions })),
}));

type Acquire = typeof import('../../src/components/nodes/shared/image/canvasImagePreviewCache').acquireCanvasImagePreview;
let acquire: Acquire;
let interacting = false;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let bitmapMock: ReturnType<typeof vi.fn<typeof createImageBitmap>>;
let createUrl: MockInstance;
let revokeUrl: MockInstance;
let canvases: Array<{ width: number; height: number; getContext: ReturnType<typeof vi.fn>; toBlob: ReturnType<typeof vi.fn> }>;

function png(animated = false): Blob {
  const header = [137, 80, 78, 71, 13, 10, 26, 10];
  const chunk = (kind: string, payload: number[]) => [
    0, 0, 0, payload.length, ...[...kind].map((char) => char.charCodeAt(0)), ...payload, 0, 0, 0, 0,
  ];
  return new Blob([new Uint8Array([
    ...header, ...chunk('IHDR', Array<number>(13).fill(0)),
    ...(animated ? chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) : []),
    ...chunk('IDAT', [0]),
  ])], { type: 'image/png' });
}

function webp(animated: boolean): Blob {
  const bytes = new Uint8Array(30);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WEBP'], [12, 'VP8X']] as const) {
    bytes.set([...value].map((char) => char.charCodeAt(0)), offset);
  }
  bytes[20] = animated ? 2 : 0;
  return new Blob([bytes], { type: 'image/webp' });
}

function request(source = 'asset://localhost/image.png', maxEdge = 512) {
  const controller = new AbortController();
  return { controller, promise: acquire(source, maxEdge, controller.signal) };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await vi.advanceTimersByTimeAsync(1);
}

async function lease(source = 'asset://localhost/image.png', maxEdge = 512): Promise<CanvasImagePreviewLease> {
  const item = request(source, maxEdge);
  await flush();
  const result = await item.promise;
  expect(result).not.toBeNull();
  return result!;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  interacting = false;
  dimensions.width = 4096;
  dimensions.height = 2048;
  disk.prepare.mockReset().mockResolvedValue(null);
  canvases = [];
  fetchMock = vi.fn<typeof fetch>(async () => new Response(png()));
  bitmapMock = vi.fn<typeof createImageBitmap>(async () => ({ close: vi.fn() }) as unknown as ImageBitmap);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', bitmapMock);
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: () => interacting } },
    createElement: () => {
      const canvas = {
        width: 0, height: 0,
        getContext: vi.fn(() => ({ drawImage: vi.fn() })),
        toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['preview'], { type: 'image/webp' }))),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  let sequence = 0;
  createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++sequence}`);
  revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  acquire = (await import('../../src/components/nodes/shared/image/canvasImagePreviewCache')).acquireCanvasImagePreview;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canvas image preview cache', () => {
  it('shows previews and continues deriving while a background disk write is pending', async () => {
    let finishWrite!: () => void;
    const writing = new Promise<void>((resolve) => { finishWrite = resolve; });
    const persist = vi.fn(() => writing);
    disk.prepare.mockResolvedValue({ cached: null, persist });
    const first = await lease('asset://localhost/one.png');
    expect(first.src).toMatch(/^blob:/);
    const second = await lease('asset://localhost/two.png');
    expect(bitmapMock).toHaveBeenCalledTimes(2);
    expect(second.src).toMatch(/^blob:/);
    finishWrite();
    first.release();
    second.release();
  });

  it('reuses the project disk copy after memory eviction without reading or decoding the original', async () => {
    let saved: Blob | undefined;
    const persist = vi.fn(async (blob: Blob) => { saved = blob; });
    disk.prepare.mockImplementation(async () => ({
      cached: saved ? { blob: saved, width: 512, height: 256 } : null, persist,
    }));
    const firstRequest = acquire('asset://localhost/image.png', 512, new AbortController().signal, 'project-a');
    await flush();
    const first = await firstRequest;
    expect(persist).toHaveBeenCalledOnce();
    first?.release();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(revokeUrl).toHaveBeenCalledWith(first?.src);
    const nextRequest = acquire('asset://localhost/image.png', 512, new AbortController().signal, 'project-a');
    await flush();
    const next = await nextRequest;
    expect(next).not.toBeNull();
    expect(next?.src).not.toBe(first?.src);
    expect(disk.prepare).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bitmapMock).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    next?.release();
  });

  it('keeps requests for different projects separate even when they display the same source', async () => {
    const a = acquire('asset://localhost/shared.png', 256, new AbortController().signal, 'project-a');
    const b = acquire('asset://localhost/shared.png', 256, new AbortController().signal, 'project-b');
    await flush();
    expect(disk.prepare).toHaveBeenCalledWith('project-a', 'asset://localhost/shared.png', 256, expect.any(AbortSignal));
    expect(disk.prepare).toHaveBeenCalledWith('project-b', 'asset://localhost/shared.png', 256, expect.any(AbortSignal));
    expect((await a)?.src).not.toBe((await b)?.src);
    (await a)?.release();
    (await b)?.release();
  });

  it('discards a late disk hit after cancellation without allocating a preview URL', async () => {
    let finish!: (result: unknown) => void;
    disk.prepare.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = acquire('asset://localhost/image.png', 512, controller.signal, 'project-a');
    await flush();
    controller.abort();
    finish({ cached: { blob: png(), width: 512, height: 256 }, persist: vi.fn() });
    await flush();
    expect(await pending).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares one derivation and keeps the preview alive until every lease is released', async () => {
    const first = request();
    const second = request();
    await flush();
    const a = await first.promise;
    const b = await second.promise;
    expect(a?.src).toBe(b?.src);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bitmapMock).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ resizeWidth: 512, resizeHeight: 256 }));
    first.controller.abort();
    a?.release();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(revokeUrl).not.toHaveBeenCalled();
    b?.release();
    b?.release();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(a?.src);
  });

  it('reuses an idle preview when a node returns to the viewport', async () => {
    const first = await lease();
    first.release();
    const second = await lease();
    expect(second.src).toBe(first.src);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    second.release();
  });

  it('pauses queued work during interaction and starts one derivation at a time', async () => {
    interacting = true;
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    bitmapMock.mockImplementationOnce(() => new Promise((resolve) => { resolveBitmap = resolve; }));
    const first = request('asset://localhost/one.png');
    const second = request('asset://localhost/two.png');
    await vi.advanceTimersByTimeAsync(240);
    expect(fetchMock).not.toHaveBeenCalled();
    interacting = false;
    await vi.advanceTimersByTimeAsync(80);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bitmapMock).toHaveBeenCalledTimes(1);
    resolveBitmap({ close: vi.fn() } as unknown as ImageBitmap);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    (await first.promise)?.release();
    (await second.promise)?.release();
  });

  it('drops cancelled queued work without reading its source', async () => {
    interacting = true;
    const item = request();
    item.controller.abort();
    expect(await item.promise).toBeNull();
    interacting = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes late decoded bitmaps after cancellation and delivers no stale URL', async () => {
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    bitmapMock.mockImplementationOnce(() => new Promise((resolve) => { resolveBitmap = resolve; }));
    const item = request();
    await flush();
    item.controller.abort();
    expect(await item.promise).toBeNull();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
    resolveBitmap({ close } as unknown as ImageBitmap);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('does not abort shared work when only one waiting consumer cancels', async () => {
    const first = request();
    const second = request();
    first.controller.abort();
    await flush();
    expect(await first.promise).toBeNull();
    expect(await second.promise).not.toBeNull();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    second.controller.abort();
  });

  it('times out a stalled remote fetch and starts the next queued image', async () => {
    fetchMock.mockImplementationOnce((_source, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const stalled = request('https://example.test/stalled.png');
    const next = request('asset://localhost/next.png');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(await stalled.promise).toBeNull();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await next.promise).not.toBeNull();
    next.controller.abort();
  });

  it('falls back on decode timeout while closing the late bitmap before starting another decode', async () => {
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    bitmapMock.mockImplementationOnce(() => new Promise((resolve) => { resolveBitmap = resolve; }));
    const stalled = request();
    const next = request('asset://localhost/next.png');
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stalled.promise).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createUrl).not.toHaveBeenCalled();
    resolveBitmap({ close } as unknown as ImageBitmap);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createUrl).toHaveBeenCalledTimes(1);
    (await next.promise)?.release();
  });

  it('cleans up a late encoding callback after timeout without creating a preview URL', async () => {
    let finishEncode!: BlobCallback;
    const close = vi.fn();
    bitmapMock.mockResolvedValueOnce({ close } as unknown as ImageBitmap);
    const canvas = {
      width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => { finishEncode = callback; },
    };
    vi.stubGlobal('document', {
      documentElement: { classList: { contains: () => false } },
      createElement: () => canvas,
    });
    const item = request();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await item.promise).toBeNull();
    finishEncode(new Blob(['late preview']));
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 1, height: 1 });
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('keys by full source revision and size and preserves the refresh query in fetch', async () => {
    const first = await lease('http://asset.localhost/test.png?_refresh=1', 256);
    const second = await lease('http://asset.localhost/test.png?_refresh=2', 256);
    const third = await lease('http://asset.localhost/test.png?_refresh=2', 512);
    expect(new Set([first.src, second.src, third.src]).size).toBe(3);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://asset.localhost/test.png?_refresh=2', expect.any(Object));
    first.release(); second.release(); third.release();
  });

  it.each([
    ['GIF', () => new Blob(['GIF89a'], { type: 'image/gif' })],
    ['SVG', () => new Blob(['<svg width="4000" height="2000"/>'], { type: 'image/svg+xml' })],
    ['APNG', () => png(true)],
    ['animated WebP', () => webp(true)],
    ['unknown bytes', () => new Blob(['not an image'], { type: 'image/png' })],
  ])('keeps %s on the original source without creating a static thumbnail', async (_, source) => {
    fetchMock.mockImplementation(async () => new Response(source()));
    const item = request();
    await flush();
    expect(await item.promise).toBeNull();
    expect(bitmapMock).not.toHaveBeenCalled();
  });

  it.each([
    ['JPEG', () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])])],
    ['static WebP', () => webp(false)],
  ])('accepts %s based on actual bytes', async (_, source) => {
    fetchMock.mockImplementation(async () => new Response(source()));
    (await lease()).release();
  });

  it('skips small images and rejects over-budget source dimensions before decode', async () => {
    dimensions.width = 200;
    dimensions.height = 100;
    const small = request();
    await flush();
    expect(await small.promise).toBeNull();
    dimensions.width = 10_000;
    const huge = request();
    await flush();
    expect(await huge.promise).toBeNull();
    expect(bitmapMock).not.toHaveBeenCalled();
  });

  it('retries a later acquisition after CORS/read failure and releases temporary graphics on encode failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('CORS'));
    const failed = request();
    await flush();
    expect(await failed.promise).toBeNull();
    const close = vi.fn();
    bitmapMock.mockResolvedValueOnce({ close } as unknown as ImageBitmap);
    vi.stubGlobal('document', {
      documentElement: { classList: { contains: () => false } },
      createElement: () => {
        const canvas = {
          width: 0, height: 0, getContext: vi.fn(() => ({ drawImage: vi.fn() })),
          toBlob: vi.fn(() => { throw new Error('encode failed'); }),
        };
        canvases.push(canvas);
        return canvas;
      },
    });
    const retry = request();
    await flush();
    expect(await retry.promise).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(canvases[0]).toMatchObject({ width: 1, height: 1 });
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('bounds declared and streamed encoded bytes before image decode', async () => {
    fetchMock.mockResolvedValueOnce(new Response(png(), { headers: { 'content-length': String(33 * 1024 * 1024) } }));
    const declared = request();
    await flush();
    expect(await declared.promise).toBeNull();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start: (controller) => controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)),
      cancel,
    })));
    const streamed = request();
    await flush();
    expect(await streamed.promise).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(bitmapMock).not.toHaveBeenCalled();
  });

  it('evicts idle RGBA memory beyond 32 MiB while keeping live leases', async () => {
    dimensions.height = 4096;
    const active = await lease('asset://localhost/live.png', 1024);
    const released: CanvasImagePreviewLease[] = [];
    for (let index = 0; index < 9; index++) {
      const item = await lease(`asset://localhost/${index}.png`, 1024);
      released.push(item);
      item.release();
    }
    expect(revokeUrl).toHaveBeenCalledWith(released[0].src);
    expect(revokeUrl).not.toHaveBeenCalledWith(active.src);
    active.release();
  });

  it('evicts more than 128 idle entries independently of byte size', async () => {
    const released: CanvasImagePreviewLease[] = [];
    for (let index = 0; index < 129; index++) {
      const item = await lease(`asset://localhost/${index}.png`, 64);
      released.push(item);
      item.release();
    }
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(released[0].src);
  });

  it('rejects raw paths, invalid sizes and pre-cancelled work without network access', async () => {
    const controller = new AbortController();
    expect(await acquire('G:/private/image.png', 512, controller.signal)).toBeNull();
    expect(await acquire('asset://localhost/a.png', Number.NaN, controller.signal)).toBeNull();
    controller.abort();
    expect(await acquire('asset://localhost/a.png', 512, controller.signal)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
