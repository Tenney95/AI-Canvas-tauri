/** frameCoalescer — 连续拖拽仅预览最新输入，取消和松手后不回放旧预览。 */
import { describe, expect, it, vi } from 'vitest';
import { createFrameCoalescer } from '../../src/utils/frameCoalescer';

function frames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => callbacks.delete(key));
  return { callbacks, flush() { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach((callback) => callback(0)); } };
}

describe('drag preview frames', () => {
  it('coalesces a burst without delaying the next frame', () => {
    const clock = frames(), run = vi.fn();
    const preview = createFrameCoalescer(run);
    preview.schedule({ x: 1 }); preview.schedule({ x: 2 }); preview.schedule({ x: 3 });
    expect(clock.callbacks.size).toBe(1);
    expect(run).not.toHaveBeenCalled();
    clock.flush();
    expect(run).toHaveBeenCalledExactlyOnceWith({ x: 3 });
    preview.schedule({ x: 4 }); clock.flush();
    expect(run).toHaveBeenLastCalledWith({ x: 4 });
  });

  it('drops queued work on stop, blur or project change, and accepts a new gesture', () => {
    const clock = frames(), run = vi.fn();
    const preview = createFrameCoalescer(run);
    preview.schedule('old'); preview.cancel(); clock.flush();
    expect(run).not.toHaveBeenCalled();
    preview.schedule('new'); clock.flush();
    expect(run).toHaveBeenCalledExactlyOnceWith('new');
    preview.cancel();
  });
});
