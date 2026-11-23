/**
 * pollTask — 通用异步任务轮询工具
 *
 * 统一各供应商（APIMart / 火山方舟 / ComfyUI / 即梦）的任务状态轮询逻辑，
 * 消除 while(true) + setTimeout 重复样板代码。
 */

/** 本地等待预算耗尽，与上游明确失败分开处理。 */
export class PollTimeoutError extends Error {
  constructor(message = '任务轮询超时') {
    super(message);
    this.name = 'PollTimeoutError';
  }
}

export class PollTaskFailedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PollTaskFailedError';
  }
}

export function isPollTimeoutError(error: unknown): boolean {
  if (error instanceof PollTaskFailedError) return false;
  if (error instanceof Error && error.name === 'ModelProtocolHttpError') {
    return [408, 504].includes((error as Error & { status: number }).status);
  }
  return error instanceof PollTimeoutError
    || (error instanceof Error && error.name === 'TimeoutError')
    // Rust proxy_transport_error 的固定脱敏类别；不按任意上游文案猜测超时。
    || (error instanceof Error && error.name === 'Error' && /^请求失败：网络请求超时/.test(error.message));
}

/** 只约束任务查询及其响应读取，不改变生成提交或普通文本流的等待策略。 */
export const POLL_REQUEST_TIMEOUT_MS = 120_000;

function pollingCancellation(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('任务已被取消', 'AbortError');
}

export async function withPollRequestDeadline<T>(
  operation: (querySignal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = POLL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (signal?.aborted) throw pollingCancellation(signal);
  if (timeoutMs <= 0) throw new PollTimeoutError('任务查询等待超时，原任务未取消');
  const controller = new AbortController();
  const deadline = Number.isFinite(timeoutMs) ? performance.now() + timeoutMs : Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => {
        controller.abort(signal?.reason);
        reject(pollingCancellation(signal));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          const error = new PollTimeoutError('任务查询等待超时，原任务未取消');
          controller.abort(error);
          reject(error);
        }, Math.ceil(timeoutMs));
      }
      // 即使底层忽略 abort，迟到结果也只会完成已经 settled 的 Promise。
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw pollingCancellation(controller.signal);
        return operation(controller.signal);
      }).then((value) => {
        if (performance.now() >= deadline) {
          const error = new PollTimeoutError('任务查询等待超时，原任务未取消');
          controller.abort(error);
          reject(error);
        } else resolve(value);
      }, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

type PollFetchErrorAction = 'throw' | 'continue' | number;

export interface PollTaskOptions<TRaw, TResult> {
  /** 每次轮询调用此函数获取最新状态（应返回原始 JSON 或结构化数据） */
  fetchState: (querySignal: AbortSignal) => Promise<TRaw>;

  /** 检查任务是否已完成。返回结果表示完成，返回 null 表示仍需等待 */
  isComplete: (data: TRaw) => TResult | null;

  /** 检查任务是否失败。返回错误消息表示失败，返回 null 表示无错误 */
  isFailed?: (data: TRaw) => string | null;

  /** 轮询间隔（毫秒），默认 3000 */
  interval?: number;

  /** 最大轮询次数，默认 Infinity */
  maxAttempts?: number;

  /** 最大轮询时长（毫秒），默认 Infinity。与 maxAttempts 同时设置时，任一触发即超时 */
  maxDuration?: number;

  /** 单次查询连同 body 读取的限时；不会自动重试生成提交。 */
  requestTimeoutMs?: number;

  /**
   * 进度回调。主循环可将服务端返回的 progress 字段（0–100）透传，
   * 也可在不支持进度时自动按时间估算。
   */
  onProgress?: (progress: number) => void;

  /**
   * fetchState 抛出网络/HTTP 错误时的处理策略：
   * - 'throw'（默认）：立即向上抛出
   * - 'continue'：静默忽略，按默认间隔等待下一轮
   * - 函数：根据错误和剩余时长返回上述策略，或指定下一次查询的等待毫秒数
   */
  onFetchError?: 'throw' | 'continue' | ((error: unknown, remainingMs: number) => PollFetchErrorAction | Promise<PollFetchErrorAction>);

  /** AbortSignal 用于外部取消轮询 */
  signal?: AbortSignal;

  /** 自定义超时错误消息 */
  timeoutMsg?: string;
}

function waitForPollInterval(interval: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(pollingCancellation(signal));

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, interval);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(pollingCancellation(signal));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    // 覆盖前置检查与监听器注册之间发生取消的竞态。
    if (signal?.aborted) onAbort();
  });
}

/**
 * 轮询异步任务直到完成、失败或超时。
 *
 * @example
 * ```ts
 * const result = await pollTask({
 *   fetchState: () => fetch(`/api/tasks/${id}`).then(r => r.json()),
 *   isComplete: (data) => data.status === 'completed' ? data : null,
 *   isFailed: (data) => data.status === 'error' ? data.message : null,
 *   interval: 2000,
 *   maxAttempts: 300,
 * });
 * ```
 */
export async function pollTask<TRaw = unknown, TResult = unknown>(
  options: PollTaskOptions<TRaw, TResult>,
): Promise<TResult> {
  const {
    fetchState,
    isComplete,
    isFailed,
    interval = 3000,
    maxAttempts = Infinity,
    maxDuration = Infinity,
    requestTimeoutMs = POLL_REQUEST_TIMEOUT_MS,
    onProgress,
    onFetchError = 'throw',
    signal,
    timeoutMsg = '任务轮询超时',
  } = options;

  const deadline = performance.now() + maxDuration;
  let nextInterval = interval;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 检查是否被取消
    if (signal?.aborted) {
      throw pollingCancellation(signal);
    }

    // 等待间隔（第一轮立即执行，之后等待）
    if (attempt > 0) {
      const remainingMs = deadline - performance.now();
      await waitForPollInterval(Math.max(0, Math.ceil(Math.min(nextInterval, remainingMs))), signal);
      nextInterval = interval;
    }

    // 检查时长限制
    if (performance.now() >= deadline) {
      throw new PollTimeoutError(timeoutMsg);
    }

    // 执行一次状态查询
    let state: TRaw;
    try {
      state = await withPollRequestDeadline(fetchState, signal,
        Math.min(requestTimeoutMs, deadline - performance.now()));
    } catch (err) {
      if (signal?.aborted) throw pollingCancellation(signal);
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new PollTimeoutError(timeoutMsg);
      if (typeof onFetchError === 'function') {
        const action = await onFetchError(err, remainingMs);
        if (action === 'throw') throw err;
        if (typeof action === 'number') nextInterval = action;
        continue;
      }
      if (err instanceof PollTimeoutError) throw err;
      if (onFetchError === 'continue') continue;
      throw err;
    }
    if (signal?.aborted) throw pollingCancellation(signal);

    // 检查是否失败
    if (isFailed) {
      const errorMsg = isFailed(state);
      if (errorMsg) throw new PollTaskFailedError(errorMsg);
    }

    // 检查是否完成
    const result = isComplete(state);
    if (result !== null) {
      return result;
    }

    // 报告进度（如果可能）
    if (onProgress) {
      // 尝试从 state 中提取 progress 字段
      const raw = state as Record<string, unknown> | null;
      const progress = typeof raw?.progress === 'number'
        ? raw.progress as number
        : Math.min(100, Math.round((attempt / maxAttempts) * 100));
      onProgress(progress);
    }
  }

  throw new PollTimeoutError(timeoutMsg);
}
