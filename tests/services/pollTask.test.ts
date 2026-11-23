/**
 * pollTask — 回归测试：pollTask resource cleanup。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPollTimeoutError, pollTask, PollTaskFailedError, PollTimeoutError, withPollRequestDeadline } from '../../src/services/pollTask';

describe('pollTask resource cleanup', () => {
  it('允许调用方在单次查询超时后有限重查，而总预算仍然终止等待', async () => {
    const firstSignals: AbortSignal[] = [];
    const fetchState = vi.fn((signal: AbortSignal) => {
      firstSignals.push(signal);
      return firstSignals.length === 1 ? new Promise<string>(() => undefined) : Promise.resolve('done');
    });
    const onFetchError = vi.fn((error: unknown) => error instanceof PollTimeoutError ? 'continue' as const : 'throw' as const);
    const result = pollTask({ fetchState, isComplete: (value) => value, interval: 10,
      requestTimeoutMs: 100, maxDuration: 1000, onFetchError });
    await vi.advanceTimersByTimeAsync(110);
    await expect(result).resolves.toBe('done');
    expect(firstSignals[0].aborted).toBe(true);
    expect(fetchState).toHaveBeenCalledTimes(2);
    expect(onFetchError).toHaveBeenCalledOnce();
  });

  it('等待间隔不会越过总预算，也不会重查或重试总超时', async () => {
    const fetchState = vi.fn(async () => null);
    const onFetchError = vi.fn(() => 'continue' as const);
    const result = pollTask({ fetchState, isComplete: () => null, interval: 10_000, maxDuration: 100, onFetchError });
    const rejected = expect(result).rejects.toBeInstanceOf(PollTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fetchState).toHaveBeenCalledOnce();
    expect(onFetchError).not.toHaveBeenCalled();
  });
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

  it.each([-86_400_000, 86_400_000])('keeps query and total deadlines when system time shifts by %s ms', async (shift) => {
    const fetchState = vi.fn().mockResolvedValueOnce('pending').mockResolvedValueOnce('done');
    const result = pollTask({ fetchState, isComplete: (state) => state === 'done' ? state : null,
      interval: 50, requestTimeoutMs: 100, maxDuration: 150 });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + shift);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe('done');
    expect(fetchState).toHaveBeenCalledTimes(2);
  });

  it('does not publish a response that arrives after query cancellation', async () => {
    const controller = new AbortController();
    const isComplete = vi.fn(() => 'old-video.mp4');
    await expect(pollTask({ signal: controller.signal, fetchState: async () => {
      controller.abort();
      return { status: 'completed' };
    }, isComplete })).rejects.toMatchObject({ name: 'AbortError' });
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
    expect(addSpy).toHaveBeenCalledTimes(5);
    expect(removeSpy).toHaveBeenCalledTimes(5);
  });

  it('removes the listener and rejects when polling is aborted during a delay', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
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

    await expect(resultPromise).rejects.toBe(controller.signal.reason);
    expect(removeSpy).toHaveBeenCalledTimes(addSpy.mock.calls.length);
    expect(fetchState).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight query when the total polling budget expires without another query', async () => {
    let querySignal!: AbortSignal;
    const fetchState = vi.fn((signal: AbortSignal) => {
      querySignal = signal;
      return new Promise<null>(() => {});
    });
    const pending = pollTask({ fetchState, isComplete: () => null, maxDuration: 1000 });
    const rejected = expect(pending).rejects.toBeInstanceOf(PollTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(querySignal.aborted).toBe(true);
    expect(fetchState).toHaveBeenCalledOnce();
  });

  it.each([new DOMException('original cancellation', 'AbortError'), new Error('caller stopped polling')])(
    'preserves the caller cancellation reason during an in-flight query', async (reason) => {
      const controller = new AbortController();
      const pending = withPollRequestDeadline(async () => await new Promise<never>(() => {}), controller.signal);
      const rejected = expect(pending).rejects.toBe(reason);
      await Promise.resolve();
      controller.abort(reason);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('covers response body reading and never publishes a late response after the request deadline', async () => {
    let finish!: (value: string) => void;
    let querySignal!: AbortSignal;
    const isComplete = vi.fn(() => 'delivered');
    const pending = pollTask({ fetchState: async (signal) => {
      querySignal = signal;
      return await new Promise<string>((resolve) => { finish = resolve; });
    }, isComplete, requestTimeoutMs: 500 });
    const rejected = expect(pending).rejects.toBeInstanceOf(PollTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(querySignal.aborted).toBe(true);
    finish('late body');
    await Promise.resolve();
    expect(isComplete).not.toHaveBeenCalled();
  });

  it('removes its deadline timer and abort listener on successful response delivery', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(withPollRequestDeadline(async () => 'ready', controller.signal, 1000)).resolves.toBe('ready');
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
