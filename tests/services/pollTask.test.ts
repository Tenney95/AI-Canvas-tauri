import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollTask } from '../../src/services/pollTask';

describe('pollTask resource cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes each abort listener after a polling interval completes', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const fetchState = vi.fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true });

    const resultPromise = pollTask<{ done: boolean }, string>({
      fetchState,
      isComplete: (state) => state.done ? 'completed' : null,
      interval: 1_000,
      maxAttempts: 3,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(resultPromise).resolves.toBe('completed');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });

  it('removes the listener and rejects when polling is aborted during a delay', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const fetchState = vi.fn().mockResolvedValue({ done: false });

    const resultPromise = pollTask<{ done: boolean }, string>({
      fetchState,
      isComplete: (state) => state.done ? 'completed' : null,
      interval: 10_000,
      maxAttempts: 2,
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(resultPromise).rejects.toThrow('任务已被取消');
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(fetchState).toHaveBeenCalledTimes(1);
  });
});
