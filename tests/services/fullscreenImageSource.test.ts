/**
 * fullscreenImageSource — 全屏原图来源、远程读取及租约回归测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ComfyMediaSourceLease } from '../../src/services/comfyMediaSource';

const io = vi.hoisted(() => ({ fetch: vi.fn(), asset: vi.fn(), remote: vi.fn(), matches: vi.fn(), native: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: io.remote }));
vi.mock('../../src/services/fs/core', () => ({ getAssetUrlFromPath: io.asset }));
vi.mock('../../src/services/comfyImageSource', () => ({ shouldLoadNativeComfyImage: io.matches, readNativeComfyImageBlob: io.native }));

import { acquireFullscreenImageSource, FULLSCREEN_IMAGE_ERRORS } from '../../src/services/fullscreenImageSource';

const REMOTE_SOURCE = 'https://images.example/original.png';

function png(width = 3840, height = 2160): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(100);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const leases: ComfyMediaSourceLease[] = [];
const requests: AbortController[] = [];
let create: MockInstance<typeof URL.createObjectURL>;
let revoke: MockInstance<typeof URL.revokeObjectURL>;
function controller() { const request = new AbortController(); requests.push(request); return request; }
async function acquire(source = REMOTE_SOURCE, request = controller()) {
  const lease = await acquireFullscreenImageSource(source, request.signal);
  leases.push(lease); return lease;
}

beforeEach(() => {
  vi.clearAllMocks();
  io.matches.mockReturnValue(false);
  io.asset.mockImplementation(async (path: string) => `asset://localhost/${encodeURIComponent(path)}`);
  io.remote.mockImplementation(async () => new Response(png(), { headers: { 'Content-Type': 'image/png' } }));
  io.native.mockImplementation(async () => new Blob([png()], { type: 'image/png' }));
  create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fullscreen-${create.mock.calls.length}`);
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', io.fetch);
  vi.stubGlobal('createImageBitmap', vi.fn());
});
afterEach(() => {
  requests.splice(0).forEach((request) => request.abort());
  leases.splice(0).forEach((lease) => lease.release());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('fullscreen image sources', () => {
  it.each([
    'asset://localhost/%2Fp%2Fimage.png?_refresh=7',
    'http://asset.localhost/D%3A%5Cimage.png?_refresh=7',
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><text>剧本 😀</text></svg>',
    'blob:original',
  ])('borrows %s for direct display', async (source) => {
    const request = controller();
    const lease = await acquire(source, request);
    expect(lease.src).toBe(source);
    request.abort();
    lease.release();
    expect(io.asset).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.remote).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each([
    ['/p/image.png', '/p/image.png'],
    ['file:///p/image%20original.png', '/p/image original.png'],
    ['D:\\image.png', 'D:\\image.png'],
  ])('converts %s to a scoped Tauri asset URL', async (source, path) => {
    expect((await acquire(source)).src).toBe(`asset://localhost/${encodeURIComponent(path)}`);
    expect(io.asset).toHaveBeenCalledExactlyOnceWith(path);
    expect(io.fetch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a local path when asset conversion is unavailable', async () => {
    io.asset.mockResolvedValueOnce('/p/image.png');
    await expect(acquire('/p/image.png')).rejects.toMatchObject({ code: 'unavailable' });
    expect(io.remote).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('uses the configured native ComfyUI reader with the complete URL and no preview byte cap', async () => {
    io.matches.mockReturnValue(true);
    const source = 'http://127.0.0.1:8188/view?filename=original.png&type=output&subfolder=a';
    await acquire(source);
    expect(io.native).toHaveBeenCalledWith(source, expect.any(AbortSignal), Infinity);
    expect(io.remote).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
  });

  it('preserves the format and bytes of a remote image without decoding it', async () => {
    const source = 'https://images.example/original.gif';
    const bytes = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    io.remote.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/gif' } }));
    await acquire(source);
    const blob = create.mock.calls[0][0] as Blob;
    expect(io.remote).toHaveBeenCalledExactlyOnceWith(source, { signal: expect.any(AbortSignal) });
    expect(blob.type).toBe('image/gif');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('exposes all 39 MiB from a remote image reporting 7424×4224 pixels', async () => {
    const bytes = new Uint8Array(39 * 1024 * 1024);
    const header = png(7424, 4224);
    bytes.set(header);
    io.remote.mockResolvedValueOnce(new Response(bytes, { headers: {
      'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength),
    } }));
    await acquire();
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(bytes.byteLength);
    expect(new Uint8Array(await blob.slice(0, header.length).arrayBuffer())).toEqual(header);
  });

  it('reports an unavailable source without leaking the transport error', async () => {
    io.remote.mockRejectedValueOnce(new Error('private URL https://host/?secret=abc /private/image.png'));
    await expect(acquire('https://images.example/broken.png')).rejects.toMatchObject({ code: 'unavailable', message: FULLSCREEN_IMAGE_ERRORS.unavailable });
    expect(create).not.toHaveBeenCalled();
  });

  it('cancels a failed HTTP response without creating an object URL', async () => {
    const cancel = vi.fn();
    io.remote.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 404 }));
    await expect(acquire()).rejects.toMatchObject({ code: 'unavailable' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps two large images active for comparison and releases each lease once', async () => {
    io.remote.mockImplementation(async () => new Response(png(9000, 8000)));
    const [first, second] = await Promise.all([acquire(), acquire('https://images.example/compare.png')]);
    expect(first.src).not.toBe(second.src);
    expect(revoke).not.toHaveBeenCalled();
    first.release(); first.release();
    second.release(); second.release();
    expect(revoke.mock.calls).toEqual([[first.src], [second.src]]);
  });

  it('reclaims an active lease when its consumer is aborted', async () => {
    const request = controller();
    const first = await acquire(REMOTE_SOURCE, request);
    request.abort(); first.release();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(first.src);
  });

  it('prepares one image at a time and holds the slot until a canceled read actually ends', async () => {
    io.matches.mockReturnValue(true);
    const read = deferred<Blob>();
    io.native.mockReturnValueOnce(read.promise);
    const first = controller();
    const a = acquire('http://comfy/first', first);
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(io.native).toHaveBeenCalledOnce());
    first.abort();
    const b = acquire('http://comfy/second');
    await Promise.resolve();
    expect(io.native).toHaveBeenCalledOnce();
    read.resolve(new Blob([png()]));
    await rejected; await b;
    expect(io.native).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it('cancels queued consumers immediately and bounds the queue without reading their bytes', async () => {
    io.matches.mockReturnValue(true);
    const read = deferred<Blob>(); io.native.mockReturnValueOnce(read.promise);
    const active = controller(); const queued = controller(); const another = controller();
    const first = acquire('http://comfy/active', active);
    const firstFailure = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(io.native).toHaveBeenCalledOnce());
    const second = acquire('http://comfy/queued', queued);
    const secondFailure = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const third = acquire('http://comfy/another', another);
    const thirdFailure = expect(third).rejects.toMatchObject({ name: 'AbortError' });
    await expect(acquire('http://comfy/excess')).rejects.toMatchObject({ code: 'busy' });
    queued.abort(); another.abort();
    await Promise.all([secondFailure, thirdFailure]);
    active.abort(); read.resolve(new Blob([png()]));
    await firstFailure;
    expect(io.native).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
  });

  it('times out a stuck stream with a fixed local error and frees preparation', async () => {
    vi.useFakeTimers();
    io.remote.mockImplementationOnce(async (_source: string, { signal }: RequestInit) => new Response(new ReadableStream({
      start(stream) {
        signal?.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      },
    })));
    const pending = acquire('https://images.example/slow.png');
    const failure = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await vi.waitFor(() => expect(io.remote).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000); await failure;
    await acquire();
  });
});
