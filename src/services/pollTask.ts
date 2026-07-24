/**
 * pollTask — 通用异步任务轮询工具
 *
 * 统一各供应商（APIMart / 火山方舟 / ComfyUI / 即梦）的任务状态轮询逻辑，
 * 消除 while(true) + setTimeout 重复样板代码。
 */

export interface PollTaskOptions<TRaw, TResult> {
  /** 每次轮询调用此函数获取最新状态（应返回原始 JSON 或结构化数据） */
  fetchState: () => Promise<TRaw>;

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

  /**
   * 进度回调。主循环可将服务端返回的 progress 字段（0–100）透传，
   * 也可在不支持进度时自动按时间估算。
   */
  onProgress?: (progress: number) => void;

  /**
   * fetchState 抛出网络/HTTP 错误时的处理策略：
   * - 'throw'（默认）：立即向上抛出
   * - 'continue'：静默忽略，等待下一轮
   */
  onFetchError?: 'throw' | 'continue';

  /** AbortSignal 用于外部取消轮询 */
  signal?: AbortSignal;

  /** 自定义超时错误消息 */
  timeoutMsg?: string;
}

function waitForPollInterval(interval: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('任务已被取消'));

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
      reject(new Error('任务已被取消'));
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
    onProgress,
    onFetchError = 'throw',
    signal,
    timeoutMsg = '任务轮询超时',
  } = options;

  const startTime = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 检查是否被取消
    if (signal?.aborted) {
      throw new Error('任务已被取消');
    }

    // 等待间隔（第一轮立即执行，之后等待）
    if (attempt > 0) {
      await waitForPollInterval(interval, signal);
    }

    // 检查时长限制
    if (Date.now() - startTime >= maxDuration) {
      throw new Error(timeoutMsg);
    }

    // 执行一次状态查询
    let state: TRaw;
    try {
      state = await fetchState();
    } catch (err) {
      if (onFetchError === 'continue') continue;
      throw err;
    }

    // 检查是否失败
    if (isFailed) {
      const errorMsg = isFailed(state);
      if (errorMsg) throw new Error(errorMsg);
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

  throw new Error(timeoutMsg);
}
