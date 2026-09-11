import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_NODE_LOD, createCanvasNodeLodRuntime } from '../../src/services/canvasNodeLodRuntime';

function fixture(zoom = 0.12) {
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const runtime = createCanvasNodeLodRuntime(zoom, {
    now: () => Date.now(),
    frame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame: (id) => { frames.delete(id); },
    delay: (callback, ms) => setTimeout(callback, ms),
    cancelDelay: (id) => clearTimeout(id),
  });
  const tick = () => {
    vi.advanceTimersByTime(16);
    const batch = [...frames.values()];
    frames.clear();
    batch.forEach((callback) => callback());
  };
  return { runtime, tick, frames };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('canvas node LOD scheduling', () => {
  it('uses hysteresis and never publishes on ordinary pan or threshold-band zoom', () => {
    const { runtime, tick } = fixture(1);
    const changed = vi.fn();
    runtime.subscribe('node', changed);
    runtime.viewport(0.16);
    expect(runtime.getSnapshot('node')).toBe(true);
    runtime.viewport(0.159);
    expect(runtime.getSnapshot('node')).toBe(false);
    for (const zoom of [0.16, 0.23, 0.18, 0.249]) runtime.viewport(zoom, 100, 200);
    expect(changed).toHaveBeenCalledTimes(1);
    tick();
    expect(runtime.getSnapshot('node')).toBe(false);
    runtime.viewport(0.25);
    expect(runtime.getSnapshot('node')).toBe(false);
    tick();
    expect(runtime.getSnapshot('node')).toBe(true);
    runtime.viewport(0.16);
    expect(runtime.getSnapshot('node')).toBe(true);
    runtime.viewport(0.159);
    expect(runtime.getSnapshot('node')).toBe(false);
    runtime.deactivate();
  });

  it.each([70, 300, 500])('restores %i mounted nodes in batches of four, nearest first', (count) => {
    const { runtime, tick, frames } = fixture();
    const changes: number[] = [];
    for (let i = 0; i < count; i++) {
      runtime.subscribe(String(i), () => { if (runtime.getSnapshot(String(i))) changes.push(i); });
      runtime.position(String(i), i * 10, 0);
    }
    runtime.interaction(true);
    runtime.viewport(0.3, (count - 1) * 10, 0);
    expect(frames.size).toBe(0);
    runtime.interaction(false);
    vi.advanceTimersByTime(CANVAS_NODE_LOD.idleMs - 1);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(1);
    tick();
    expect(changes).toEqual([count - 1, count - 2, count - 3, count - 4]);
    while (frames.size) {
      const before = changes.length;
      tick();
      expect(changes.length - before).toBeLessThanOrEqual(4);
    }
    expect(changes).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels recovery on input, waits for a fresh quiet interval, and drops unmounted work', () => {
    const { runtime, tick, frames } = fixture();
    const releases = Array.from({ length: 12 }, (_, i) => runtime.subscribe(String(i), vi.fn()));
    runtime.viewport(0.3);
    tick();
    runtime.interaction(true);
    expect(frames.size).toBe(0);
    releases.slice(4, 8).forEach((release) => release());
    vi.advanceTimersByTime(1000);
    expect(runtime.getSnapshot('8')).toBe(false);
    runtime.interaction(false);
    vi.advanceTimersByTime(100);
    runtime.interaction(true);
    runtime.interaction(false);
    vi.advanceTimersByTime(179);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(1);
    tick();
    expect(runtime.getSnapshot('8')).toBe(true);
    expect(frames.size).toBe(0);
    releases.forEach((release) => release());
  });

  it('keeps overlapping protection leases full even during far zoom and input', () => {
    const { runtime, frames } = fixture();
    runtime.subscribe('node', vi.fn());
    runtime.interaction(true);
    const first = runtime.pin('node');
    const second = runtime.pin('node');
    expect(runtime.getSnapshot('node')).toBe(true);
    first();
    expect(runtime.getSnapshot('node')).toBe(true);
    second();
    expect(runtime.getSnapshot('node')).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('aborts a batch when its notification starts input or reverses zoom', () => {
    const { runtime, tick, frames } = fixture();
    const changed = vi.fn();
    runtime.subscribe('first', () => {
      if (runtime.getSnapshot('first')) runtime.interaction(true);
    });
    runtime.subscribe('second', changed);
    runtime.viewport(0.3);
    tick();
    expect(changed).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    runtime.viewport(0.12);
    runtime.interaction(false);
    vi.advanceTimersByTime(500);
    expect(runtime.getSnapshot('first')).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('releases queued work, supports effect reactivation and isolates projects with reused IDs', () => {
    const a = fixture();
    const b = fixture(1);
    const release = a.runtime.subscribe('same', vi.fn());
    a.runtime.viewport(0.3);
    a.runtime.deactivate();
    expect(a.frames.size).toBe(0);
    a.runtime.activate();
    expect(a.frames.size).toBe(1);
    expect(b.runtime.getSnapshot('same')).toBe(true);
    expect(a.runtime.getSnapshot('same')).toBe(false);
    release();
    expect(a.frames.size).toBe(0);
    a.runtime.subscribe('new-visible-node', vi.fn());
    expect(a.runtime.getSnapshot('new-visible-node')).toBe(false);
    a.tick();
    expect(a.runtime.getSnapshot('new-visible-node')).toBe(true);
    a.runtime.viewport(Number.NaN);
    expect(a.runtime.getSnapshot('new-visible-node')).toBe(true);
  });
});
