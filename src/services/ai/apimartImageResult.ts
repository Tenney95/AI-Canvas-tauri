/** APIMart 图片首次取图和原任务续查共用状态与候选解析。 */
import { PollTimeoutError, type PollTaskOptions } from '../pollTask';
import { queryAsyncImageResult } from './asyncMediaResult';
import { corsSafeFetch } from './httpTransport';
import { redactModelProtocolError, redactModelProtocolErrorText } from './modelProtocolHttp';

/* ── APIMart 任务轮询共享类型 ── */
export interface ApimartTaskResult<TResult = Record<string, unknown>> {
  code: number;
  data?: {
    status: string;
    progress?: number;
    result?: TResult;
    error?: ApimartTaskError;
  };
  status?: string;
  progress?: number;
  result?: TResult;
  error?: ApimartTaskError;
}

type ApimartTaskError = string | {
  code?: string;
  message?: string;
  type?: string;
};

/** 为 APIMart 图片、视频和旧音频读取单次任务状态，统一响应封装并对错误脱敏。 */
export async function fetchApimartTask<TResult = Record<string, unknown>>(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
  timeoutAsPause = false,
): Promise<ApimartTaskResult<TResult>> {
  try {
    const resp = await corsSafeFetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!resp.ok) {
      if (timeoutAsPause && [408, 504].includes(resp.status)) throw new PollTimeoutError('APIMart 任务查询超时');
      const errBody = await resp.text().catch(() => '');
      throw new Error(`APIMart 任务查询失败 (${resp.status}): ${redactModelProtocolErrorText(errBody, apiKey).slice(0, 200)}`);
    }
    const raw = (await resp.json()) as Record<string, unknown>;
    // 恢复查询也直接调用这里，失败详情离开网络层前就移除本次凭据。
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
      ? raw.data as Record<string, unknown> : raw;
    const taskError = (data.error ?? raw.error) as ApimartTaskError | undefined;
    const error = typeof taskError === 'string' ? redactModelProtocolErrorText(taskError, apiKey)
      : taskError && {
        ...(typeof taskError.message === 'string' ? { message: redactModelProtocolErrorText(taskError.message, apiKey) } : {}),
        ...(typeof taskError.code === 'string' ? { code: redactModelProtocolErrorText(taskError.code, apiKey) } : {}),
        ...(typeof taskError.type === 'string' ? { type: redactModelProtocolErrorText(taskError.type, apiKey) } : {}),
      };
    if (data === raw) return { ...raw, error } as unknown as ApimartTaskResult<TResult>;
    return { code: raw.code as number, status: (data.status ?? raw.status) as string | undefined,
      progress: (data.progress ?? raw.progress) as number | undefined, result: data.result as TResult | undefined, error };
  } catch (error) {
    throw redactModelProtocolError(error, apiKey);
  }
}

/** 供图片首次取回和续查复用，按原顺序返回有效候选。 */
export function queryApimartImageResult(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  options: Pick<PollTaskOptions<ApimartTaskResult, string[]>,
    'interval' | 'maxDuration' | 'onFetchError' | 'signal'> & { timeoutAsPause?: boolean } = {},
): Promise<string[]> {
  const { timeoutAsPause = true, ...pollOptions } = options;
  return queryAsyncImageResult({
    ...pollOptions,
    fetchState: (signal) => fetchApimartTask(apiKey, baseUrl, encodeURIComponent(taskId), signal, timeoutAsPause),
    allowPartial: true,
    missingResult: 'APIMart 生成完成但未返回图片',
    failureMessage: (task, status) => {
      const error = task.error as ApimartTaskError | undefined;
      const detail = typeof error === 'string' ? error : error?.message;
      return redactModelProtocolErrorText(`APIMart 图片生成失败: ${typeof detail === 'string' && detail.trim() || status}`, apiKey);
    },
  });
}
