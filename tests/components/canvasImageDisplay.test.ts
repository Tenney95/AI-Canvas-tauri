import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasDisplayScheduler } from '../../src/services/canvasDisplayScheduler';
import { canvasImageTier, createCanvasImageDisplay, prepareCanvasImage, type DisplayImageLease } from '../../src/components/nodes/shared/image/canvasImageDisplay';

const { acquire, cached } = vi.hoisted(() => ({ acquire: vi.fn(), cached: vi.fn() }));
vi.mock('../../src/components/nodes/shared/image/canvasImagePreviewCache', () => ({
  acquireCanvasImagePreview: acquire, acquireCachedCanvasImagePreview: cached,
}));

function fixture() {
  let id = 0;
  const frames = new Map<number, () => void>();
  const queue = createCanvasDisplayScheduler({
    now: () => Date.now(), frame: (f) => { frames.set(++id, f); return id; },
    cancelFrame: (id) => { frames.delete(id); }, delay: (f, ms) => setTimeout(f, ms), cancelDelay: clearTimeout,
  });
  const tick = async (ms = 16) => {
    await vi.advanceTimersByTimeAsync(ms);
    const batch = [...frames.values()]; frames.clear(); batch.forEach((f) => f());
    await vi.advanceTimersByTimeAsync(0);
  };
  const queueForImage = {
    enqueue: (key: object, work: () => void, delay?: number) => queue.enqueue(key, work, undefined, delay),
    prepare: (key: object, work: () => Promise<void>, delay?: number) => queue.prepare(key, work, undefined, delay),
  };
  const prepare = vi.fn(async (_source: string, edge: number, _signal: AbortSignal): Promise<DisplayImageLease> => ({ src: `blob:${edge}`, release: vi.fn() }));
  const publish = vi.fn();
  const display = createCanvasImageDisplay({ source: 'asset://source.png', projectId: 'a', queue: queueForImage, prepare, publish });
  const update = (zoom: number) => display.viewport(zoom, 512, 288, 2);
  const settle = async () => {
    for (let i = 0; (frames.size || vi.getTimerCount()) && i < 2000; i++) await tick();
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  };
  return { queue, queueForImage, prepare, publish, display, update, frames, tick, settle };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); cached.mockReset().mockReturnValue(null); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); acquire.mockReset(); });

describe('canvas image preparation', () => {
  function images() {
    const pending: Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null; decode: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('Image', class {
      src = ''; decoding = ''; onload = null; onerror = null;
      decode = vi.fn(async () => {}); removeAttribute = vi.fn();
      constructor() { pending.push(this); }
    });
    return pending;
  }
  it('waits for decode even on a cache hit and returns its live lease', async () => {
    const pending = images(); const lease = { src: 'blob:cached', release: vi.fn() };
    acquire.mockResolvedValue(lease);
    const complete = vi.fn();
    const result = prepareCanvasImage('asset://source', 256, new AbortController().signal, 'project-a').then(complete);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending[0].src).toBe(lease.src); expect(complete).not.toHaveBeenCalled();
    let decoded!: () => void;
    pending[0].decode.mockImplementation(() => new Promise<void>((resolve) => { decoded = resolve; }));
    pending[0].onload?.(); await vi.advanceTimersByTimeAsync(0);
    expect(complete).not.toHaveBeenCalled(); decoded(); await result;
    expect(complete).toHaveBeenCalledWith(lease); expect(lease.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases a failed thumbnail and decodes the original fallback', async () => {
    const pending = images(); const release = vi.fn(); acquire.mockResolvedValue({ src: 'blob:bad', release });
    const result = prepareCanvasImage('asset://source', 512, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0); pending[0].onerror?.(); await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce(); expect(pending[1].src).toBe('asset://source');
    pending[1].onload?.(); expect((await result).src).toBe('asset://source');
    expect(pending[1].decode).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending decode and returns its thumbnail lease', async () => {
    const pending = images(); const release = vi.fn(); acquire.mockResolvedValue({ src: 'blob:pending', release });
    const abort = new AbortController();
    const result = prepareCanvasImage('asset://source', 256, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await rejected;
    expect(release).toHaveBeenCalledOnce(); expect(pending[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a stalled original and lets the actual image expose its error or retry UI', async () => {
    images(); const result = prepareCanvasImage('asset://stalled', 0, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).src).toBe('asset://stalled'); expect(acquire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('canvas image display transitions', () => {
  it('shows only an existing preview on first entry during interaction and queues a later upgrade', async () => {
    const f = fixture();
    const lease = { src: 'blob:cached-small', maxEdge: 256, release: vi.fn() };
    cached.mockReturnValueOnce(lease);
    f.queue.interaction(true);
    f.update(.4);
    expect(cached).toHaveBeenCalledWith('asset://source.png', 512, expect.any(AbortSignal), 'a');
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(lease);
    await f.tick(1000);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
    f.queue.interaction(false);
    await f.settle();
    expect(f.prepare.mock.lastCall?.[1]).toBe(512);
    f.display.committed(f.publish.mock.lastCall![0]);
    expect(lease.release).toHaveBeenCalledOnce();
    f.display.dispose();
  });

  it('does not prepare a matching cached tier and releases it when a strict-mode effect is disposed', async () => {
    const f = fixture();
    const lease = { src: 'blob:cached', maxEdge: 256, release: vi.fn() };
    cached.mockReturnValueOnce(lease);
    f.queue.interaction(true);
    f.update(.2);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(lease);
    f.display.dispose();
    f.display.dispose();
    await f.tick(1000);
    expect(lease.release).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('uses a cached small preview while an initial original request still waits for the interaction queue', async () => {
    const f = fixture();
    const lease = { src: 'blob:cached', maxEdge: 512, release: vi.fn() };
    cached.mockReturnValueOnce(lease);
    f.queue.interaction(true);
    f.update(2);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(lease);
    expect(f.prepare).not.toHaveBeenCalled();
    f.queue.interaction(false);
    await f.settle();
    expect(f.prepare.mock.lastCall?.[1]).toBe(0);
    f.display.dispose();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it.each([1, 1.5, 2])('caps only performance previews at DPR %s, keeping the image until the replacement commits', async (dpr) => {
    const f = fixture();
    f.display.viewport(3, 1024, 768, dpr);
    await f.settle();
    expect(f.prepare.mock.calls[0][1]).toBe(0);
    const originalSignal = f.prepare.mock.calls[0][2];
    f.queue.interaction(true);
    f.display.viewport(3, 1024, 768, dpr, true);
    await f.tick(1000);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(originalSignal.aborted).toBe(false);
    f.queue.interaction(false); await f.settle();
    expect(f.prepare.mock.calls[1][1]).toBe(512);
    expect(originalSignal.aborted).toBe(false);
    f.display.committed(f.publish.mock.calls[1][0]);
    expect(originalSignal.aborted).toBe(true);
    // 同一模式内的大倍率往返不再请求原图，也不重复生成最高档。
    for (const zoom of [2, 5, 1.2, 3]) f.display.viewport(zoom, 1024, 768, dpr, true);
    await f.settle(); expect(f.prepare).toHaveBeenCalledTimes(2);
    f.display.viewport(3, 1024, 768, dpr, false); await f.settle();
    expect(f.prepare.mock.calls[2][1]).toBe(0);
    f.display.dispose();
  });

  it('keeps small tiers and error fallback in performance mode, cancelling obsolete mode changes', async () => {
    const f = fixture();
    for (const [zoom, edge] of [[0.2, 256], [0.4, 512], [0.8, 512]]) {
      f.display.viewport(zoom, 512, 288, 2, true); await f.settle();
      expect(f.prepare.mock.lastCall?.[1]).toBe(edge);
    }
    f.display.viewport(3, 512, 288, 2, false);
    f.display.viewport(3, 512, 288, 2, true);
    await f.settle(); expect(f.prepare).toHaveBeenCalledTimes(2);
    f.display.original(); await f.settle();
    expect(f.prepare.mock.lastCall?.[1]).toBe(0);
    f.display.dispose();
  });

  it('caps the 1024 tier as well as automatic original resolution without rejecting an explicit original request', async () => {
    const f = fixture();
    for (const screenEdge of [600, 1024, 1800]) {
      f.display.viewport(1, screenEdge, 300, 1, true);
      await f.settle();
      expect(f.prepare.mock.lastCall?.[1]).toBe(512);
    }
    expect(f.prepare).toHaveBeenCalledOnce();
    f.display.original(); await f.settle();
    expect(f.prepare.mock.lastCall?.[1]).toBe(0);
    f.display.viewport(1, 600, 300, 1, false); await f.settle();
    expect(f.prepare.mock.lastCall?.[1]).toBe(1024);
    f.display.dispose();
  });

  it.each([1, 1.5, 2])('holds tiers around every boundary at DPR %s and crosses outside hysteresis', (dpr) => {
    for (const [edge, next] of [[256, 512], [512, 1024], [1024, 0]]) {
      let tier = edge;
      for (const ratio of [0.99, 1.01, 0.99, 1.05]) {
        const zoom = edge * ratio / (512 * dpr);
        tier = canvasImageTier(512 * zoom * dpr, tier);
        expect(tier).toBe(edge);
      }
      expect(canvasImageTier(edge * 1.11, tier)).toBe(next);
      expect(canvasImageTier(edge * 0.99, next)).toBe(next);
      expect(canvasImageTier(edge * 0.89, next)).toBe(edge);
    }
  });
  it('keeps the displayed lease alive during a switch and releases only after commit', async () => {
    const f = fixture(); f.update(.2); await f.settle();
    const first = f.publish.mock.calls[0][0] as DisplayImageLease;
    const signal = f.prepare.mock.calls[0][2];
    f.update(.4); await f.tick(180);
    expect(signal.aborted).toBe(false); expect(f.publish).toHaveBeenCalledTimes(1);
    await f.settle(); const second = f.publish.mock.calls[1][0] as DisplayImageLease;
    expect(signal.aborted).toBe(false);
    f.display.committed(second); expect(signal.aborted).toBe(true);
    const spy = vi.spyOn(second, 'release');
    f.display.dispose(); expect(spy).toHaveBeenCalledOnce();
    expect(first.src).toBe('blob:256');
  });
  it('coalesces rapid reversal and does not prepare an obsolete higher tier', async () => {
    const f = fixture(); f.update(.2); await f.settle();
    f.update(.4); await f.tick(80); f.update(.2); await f.settle();
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce();
  });
  it('gates memory-ready and original updates through the same interaction queue', async () => {
    const f = fixture(); f.update(.2); await f.settle();
    f.queue.interaction(true); f.update(1.2); await f.tick(1000);
    expect(f.prepare).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce();
    f.queue.interaction(false); await f.tick(179); expect(f.prepare).toHaveBeenCalledOnce();
    await f.settle(); expect(f.prepare.mock.calls[1][1]).toBe(0);
    expect(f.publish.mock.calls[1][0].src).toBe('blob:0');
    f.update(.2); await f.tick(999); expect(f.prepare).toHaveBeenCalledTimes(2);
    await f.settle(); expect(f.prepare.mock.calls[2][1]).toBe(256);
  });
  it('releases a late preparation after disposal and never publishes into another project', async () => {
    const f = fixture(); let resolve!: (lease: DisplayImageLease) => void;
    f.prepare.mockImplementation(() => new Promise((done) => { resolve = done; }));
    f.update(.2); await f.tick(); f.display.dispose();
    const lease = { src: 'blob:late', release: vi.fn() }; resolve(lease); await f.tick();
    expect(lease.release).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled();
    expect(f.frames.size).toBe(0);
  });
  it('does not publish prepared content when input resumes before the display commit', async () => {
    const f = fixture(); f.update(.2); await f.tick();
    f.queue.interaction(true); await f.tick(1000); expect(f.publish).not.toHaveBeenCalled();
    f.queue.interaction(false); await f.settle(); expect(f.publish).toHaveBeenCalledOnce();
  });
  it.each([70, 300, 500])('bounds shared commits for %i images across every tier in both directions', async (count) => {
    const f = fixture(); let commits = 0;
    const images = Array.from({ length: count }, (_, i) => createCanvasImageDisplay({
      source: `asset://image-${i}.png`, queue: f.queueForImage, prepare: f.prepare,
      publish: () => { commits++; },
    }));
    for (const zoom of [.12, .3, .6, 1.2, .6, .3, .12]) {
      f.queue.interaction(true);
      const before = commits;
      images.forEach((image) => image.viewport(zoom, 512, 288, 2));
      await f.tick(1000); expect(commits).toBe(before);
      f.queue.interaction(false);
      let ticks = 0;
      while (f.frames.size || vi.getTimerCount()) {
        const previous = commits; await f.tick();
        expect(commits - previous).toBeLessThanOrEqual(4);
        expect(++ticks).toBeLessThan(2000);
      }
      expect(commits - before).toBe(count);
    }
    images.forEach((image) => image.dispose());
  });
});
