import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeVideo extends EventTarget {
  readyState = 0;
  videoWidth = 1920;
  videoHeight = 1080;
  duration = 10;
  currentTime = 0;
  seeking = false;
  crossOrigin = '';
  muted = false;
  playsInline = false;
  preload = '';
  src = '';
  pause = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; this.readyState = 0; });
  load = vi.fn();
  ready() {
    this.readyState = 2;
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('loadeddata'));
  }
}

type Poster = import('../../src/components/nodes/shared/video/canvasVideoPreviewCache').CanvasVideoPoster;
let cache: typeof import('../../src/components/nodes/shared/video/canvasVideoPreviewCache');
let videos: FakeVideo[];
let canvases: Array<{ width: number; height: number }>;
let interacting: boolean;
let blank: boolean;
let failDrawing: boolean;
let pendingEncoder: ((blob: Blob | null) => void) | undefined;
let deferEncode: boolean;
let controllers: AbortController[];
let leases: Poster[];
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const OriginalUrl = URL;

function acquire(source: string) {
  const controller = new AbortController();
  controllers.push(controller);
  const promise = cache.acquireCanvasVideoPoster(source, controller.signal).then((poster) => {
    if (poster) leases.push(poster);
    return poster;
  });
  return { promise, controller };
}

async function start() { await vi.advanceTimersByTimeAsync(0); }
async function finish(video = videos[videos.length - 1]) {
  video.ready();
  await vi.advanceTimersByTimeAsync(blank ? 900 : 250);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  videos = [];
  canvases = [];
  controllers = [];
  leases = [];
  interacting = false;
  blank = false;
  failDrawing = false;
  deferEncode = false;
  pendingEncoder = undefined;
  createUrl.mockReset().mockImplementation(() => `blob:poster-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  vi.stubGlobal('URL', class extends OriginalUrl {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: () => interacting } },
    createElement: (tag: string) => {
      if (tag === 'video') { const video = new FakeVideo(); videos.push(video); return video; }
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({
          drawImage: () => { if (failDrawing) throw new Error('Tainted canvases may not be exported'); },
          getImageData: () => ({ data: new Uint8ClampedArray(blank ? [0, 0, 0, 255] : [255, 200, 100, 255]) }),
        }),
        toBlob: (callback: (blob: Blob | null) => void) => {
          if (deferEncode) pendingEncoder = callback;
          else callback(new Blob(['poster'], { type: 'image/jpeg' }));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  cache = await import('../../src/components/nodes/shared/video/canvasVideoPreviewCache');
});

afterEach(async () => {
  controllers.forEach((controller) => controller.abort());
  leases.forEach((poster) => poster.release());
  pendingEncoder?.(null);
  await vi.advanceTimersByTimeAsync(30_100);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canvas video poster scheduling and ownership', () => {
  it('shares one decode and keeps the original metadata while bounding the poster footprint', async () => {
    const first = acquire('asset://same.mp4');
    const second = acquire('asset://same.mp4');
    await start();
    expect(videos).toHaveLength(1);
    await finish();
    const [a, b] = await Promise.all([first.promise, second.promise]);
    expect(a).toMatchObject({ src: 'blob:poster-1', width: 640, height: 360, videoWidth: 1920, videoHeight: 1080, duration: 10 });
    expect(b?.src).toBe(a?.src);
    expect(videos[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(videos[0].load).toHaveBeenCalled();
    expect(canvases[0]).toMatchObject({ width: 1, height: 1 });
    a?.release();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(revokeUrl).not.toHaveBeenCalled();
    b?.release();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:poster-1');
  });

  it('serializes different videos and pauses queued work during canvas gestures', async () => {
    interacting = true;
    const a = acquire('asset://a.mp4');
    const b = acquire('asset://b.mp4');
    await vi.advanceTimersByTimeAsync(200);
    expect(videos).toHaveLength(0);
    interacting = false;
    await vi.advanceTimersByTimeAsync(80);
    expect(videos).toHaveLength(1);
    interacting = true;
    await finish();
    expect(await a.promise).not.toBeNull();
    expect(videos).toHaveLength(1);
    interacting = false;
    await vi.advanceTimersByTimeAsync(80);
    expect(videos).toHaveLength(2);
    await finish();
    expect(await b.promise).not.toBeNull();
  });

  it('cancels queued work and immediately unloads a running job when its last consumer leaves', async () => {
    const a = acquire('asset://a.mp4');
    const b = acquire('asset://b.mp4');
    await start();
    b.controller.abort();
    a.controller.abort();
    expect(await a.promise).toBeNull();
    expect(await b.promise).toBeNull();
    await start();
    expect(videos).toHaveLength(1);
    expect(videos[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('does not cancel a shared producer while another consumer is waiting', async () => {
    const a = acquire('asset://same.mp4');
    const b = acquire('asset://same.mp4');
    await start();
    a.controller.abort();
    expect(await a.promise).toBeNull();
    expect(videos[0].load).not.toHaveBeenCalled();
    await finish();
    expect(await b.promise).not.toBeNull();
  });

  it('fails closed on timeout, releases decoder resources, and then services the next node', async () => {
    const a = acquire('asset://stuck.mp4');
    const b = acquire('asset://next.mp4');
    await vi.advanceTimersByTimeAsync(15_100);
    expect(await a.promise).toBeNull();
    expect(videos[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(videos).toHaveLength(2);
    await finish();
    expect(await b.promise).not.toBeNull();
  });

  it('discards an encoded result that finishes after cancellation without starting overlapping encoders', async () => {
    deferEncode = true;
    const a = acquire('asset://a.mp4');
    const b = acquire('asset://b.mp4');
    await start();
    await finish();
    expect(pendingEncoder).toBeTypeOf('function');
    a.controller.abort();
    await start();
    expect(videos).toHaveLength(1);
    deferEncode = false;
    pendingEncoder?.(new Blob(['late']));
    await start();
    expect(await a.promise).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
    expect(videos).toHaveLength(2);
    await finish();
    expect(await b.promise).not.toBeNull();
  });

  it('retains a legitimate black video cover after bounded candidate probes', async () => {
    blank = true;
    const a = acquire('asset://black.mp4');
    await start();
    await finish();
    expect(await a.promise).not.toBeNull();
    expect(createUrl).toHaveBeenCalledTimes(1);
  });

  it('settles consumers on timeout even while a noncancelable canvas encoder is still finishing', async () => {
    deferEncode = true;
    const request = acquire('asset://encoder-timeout.mp4');
    await start();
    await finish();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await request.promise).toBeNull();
    expect(videos[0].removeAttribute).toHaveBeenCalledWith('src');
    pendingEncoder?.(new Blob(['late']));
    await start();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('caches decode failures briefly instead of repeatedly trying an unsupported source on every remount', async () => {
    failDrawing = true;
    const a = acquire('https://remote.example/no-cors.mp4');
    await start();
    await finish();
    expect(await a.promise).toBeNull();
    expect(await acquire('https://remote.example/no-cors.mp4').promise).toBeNull();
    expect(videos).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_001);
    const retry = acquire('https://remote.example/no-cors.mp4');
    await start();
    expect(videos).toHaveLength(2);
    retry.controller.abort();
  });

  it('reclaims the oldest idle posters when their estimated RGBA footprint exceeds 32 MiB', async () => {
    for (let index = 0; index < 24; index++) {
      const request = acquire(`asset://square-${index}.mp4`);
      await start();
      videos[index].videoWidth = 4096;
      videos[index].videoHeight = 4096;
      await finish();
      (await request.promise)?.release();
    }
    expect(revokeUrl.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(revokeUrl).toHaveBeenCalledWith('blob:poster-1');
  });

  it('waits for pixels instead of metadata alone and cancels listeners when the node goes away', async () => {
    const video = new FakeVideo();
    const controller = new AbortController();
    let ready = false;
    const waiting = cache.waitForCanvasVideoReady(video as unknown as HTMLVideoElement, controller.signal).then(() => { ready = true; });
    video.readyState = 1;
    video.dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();
    expect(ready).toBe(false);
    video.ready();
    await waiting;
    expect(ready).toBe(true);
    video.readyState = 0;
    const canceled = cache.waitForCanvasVideoReady(video as unknown as HTMLVideoElement, controller.signal);
    const assertion = expect(canceled).rejects.toThrow('视频预览已取消');
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
