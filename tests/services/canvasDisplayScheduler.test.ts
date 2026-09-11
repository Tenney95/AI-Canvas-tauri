import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasDisplayScheduler } from '../../src/services/canvasDisplayScheduler';

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
  return { queue, frames, tick };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('shared canvas display budget', () => {
  it('coalesces keys, preserves a replacement against stale cancellation, and prioritizes work', async () => {
    const { queue, tick } = fixture(); const calls: string[] = []; const key = {};
    const cancel = queue.enqueue(key, () => calls.push('stale'));
    queue.enqueue(key, () => calls.push('latest'), () => 100);
    queue.enqueue({}, () => calls.push('near'), () => 0);
    cancel(); await tick(); expect(calls).toEqual(['near', 'latest']);
  });
  it('shares the frame budget between node and media commits and waits through renewed input', async () => {
    const { queue, frames, tick } = fixture(); const calls = vi.fn();
    for (let i = 0; i < 20; i++) queue.enqueue({}, calls);
    queue.interaction(true); await tick(1000); expect(calls).not.toHaveBeenCalled();
    queue.interaction(false); await tick(100); queue.interaction(true); queue.interaction(false);
    await tick(179); expect(calls).not.toHaveBeenCalled();
    await tick(1); expect(calls).toHaveBeenCalledTimes(4);
    while (frames.size) { const before = calls.mock.calls.length; await tick(); expect(calls.mock.calls.length - before).toBeLessThanOrEqual(4); }
    expect(calls).toHaveBeenCalledTimes(20);
  });
  it('reduces batch size after a slow rendered frame and bounds synchronous callback work', async () => {
    const { queue, tick } = fixture(); const calls = vi.fn();
    for (let i = 0; i < 40; i++) queue.enqueue({}, calls);
    await tick(); expect(calls).toHaveBeenCalledTimes(4);
    await tick(50); expect(calls).toHaveBeenCalledTimes(6);
    await tick(50); expect(calls).toHaveBeenCalledTimes(7);
    const other = fixture(); const slow = vi.fn(() => vi.setSystemTime(Date.now() + 4));
    for (let i = 0; i < 4; i++) other.queue.enqueue({}, slow);
    await other.tick(); expect(slow).toHaveBeenCalledTimes(1);
  });
  it('limits preparation concurrency, sleeps when slots are full, and gates completion commits', async () => {
    const { queue, tick, frames } = fixture(); const starts = vi.fn(); const commits = vi.fn(); const finish: Array<() => void> = [];
    for (let i = 0; i < 5; i++) queue.prepare({}, async () => {
      starts(); await new Promise<void>((resolve) => finish.push(resolve)); queue.enqueue({}, commits);
    });
    await tick(); expect(starts).toHaveBeenCalledTimes(2); expect(frames.size).toBe(0);
    queue.interaction(true); finish.splice(0).forEach((f) => f()); await tick(1000);
    expect(commits).not.toHaveBeenCalled(); expect(starts).toHaveBeenCalledTimes(2);
    queue.interaction(false); await tick(180);
    expect(starts).toHaveBeenCalledTimes(4); expect(commits).toHaveBeenCalledTimes(2);
  });
  it('does not spend display slots on asynchronous preparation starts', async () => {
    const { queue, tick } = fixture(); const prepared = vi.fn(); const commits = vi.fn();
    for (let i = 0; i < 10; i++) queue.prepare({}, async () => { prepared(); await new Promise(() => {}); });
    for (let i = 0; i < 10; i++) queue.enqueue({}, commits);
    await tick();
    expect(prepared).toHaveBeenCalledTimes(2); expect(commits).toHaveBeenCalledTimes(4);
    queue.deactivate();
  });
  it('does not let canceled, delayed or deactivated work run', async () => {
    const { queue, tick, frames } = fixture(); const calls = vi.fn();
    const cancel = queue.enqueue({}, calls, undefined, 1000); cancel();
    queue.enqueue({}, calls, undefined, 180); queue.deactivate(); await tick(1000);
    expect(calls).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
    queue.activate(); await tick(); expect(calls).toHaveBeenCalledTimes(1);
  });
});
