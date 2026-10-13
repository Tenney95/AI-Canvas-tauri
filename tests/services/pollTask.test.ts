import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPollTimeoutError, pollTask, PollTaskFailedError, PollTimeoutError } from '../../src/services/pollTask';

describe('pollTask resource cleanup', () => {
  it('distinguishes local timeout from a remote failure whose message contains timeout', async () => {
    await expect(pollTask({ fetchState: async () => null, isComplete: () => null, maxAttempts: 0 }))
      .rejects.toBeInstanceOf(PollTimeoutError);
    await expect(pollTask({ fetchState: async () => ({ failed: true }), isComplete: () => null,
      isFailed: () => 'upstream timeout: job failed' })).rejects.toBeInstanceOf(PollTaskFailedError);
    expect(isPollTimeoutError(new PollTaskFailedError('timeout'))).toBe(false);
    expect(isPollTimeoutError(new Error('请求失败：网络请求超时。未收到有效 HTTP 响应'))).toBe(true);
    expect(isPollTimeoutError(new Error('上游提示词超时'))).toBe(false);
  });

  it('stops after its duration budget without issuing another query', async () => {
    const fetchState = vi.fn(async () => null);
    const pending = pollTask({ fetchState, isComplete: () => null, interval: 1000, maxDuration: 1000 });
    const rejected = expect(pending).rejects.toBeInstanceOf(PollTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(fetchState).toHaveBeenCalledOnce();
  });

  it('does not publish a response that arrives after query cancellation', async () => {
    const controller = new AbortController();
    const isComplete = vi.fn(() => 'old-video.mp4');
    await expect(pollTask({ signal: controller.signal, fetchState: async () => {
      controller.abort();
      return { status: 'completed' };
    }, isComplete })).rejects.toThrow('任务已被取消');
    expect(isComplete).not.toHaveBeenCalled();
  });
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
