/** 旧异步媒体接口和 APIMart 共用有界结果集合解析。 */
import { pollTask, PollTimeoutError, type PollTaskOptions } from '../pollTask';
import { MAX_NATIVE_MEDIA_OUTPUTS } from '../nativeMediaCollection';
import { toImageDataUrl } from './helpers';
import { corsSafeFetch } from './httpTransport';
import { redactModelProtocolError } from './modelProtocolHttp';

export type AsyncMediaResultField = 'videos' | 'audios' | 'images';
const recordObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 只选择一个明确的返回集合，按调用场景读取首项或保留完整候选。 */
export function readAsyncMediaResultUrls(
  payload: unknown, field: AsyncMediaResultField, allowPartial = false, firstOnly = false,
): string[] {
  if (!recordObject(payload)) return [];
  const containers = [payload, ...(recordObject(payload.result) ? [payload.result] : []), ...(recordObject(payload.data) ? [payload.data] : [])];
  const missing = (message: string): string[] => {
    if (allowPartial) return [];
    throw new Error(message);
  };
  const splitUrls = (url: string) => {
    if (/^data:/i.test(url)) return [url];
    // 只有后续项目明确是另一个地址时拆分，保留签名 URL 查询参数中的字面逗号。
    return url.split(/,\s*(?=(?:https?:\/\/|asset:|blob:))/i).map((item) => item.trim()).filter(Boolean);
  };
  const values = (value: unknown): string[] => {
    if (typeof value === 'string' && value.trim()) return splitUrls(value);
    if (Array.isArray(value) && value.length) return value.flatMap((item) => {
      return typeof item === 'string' && item.trim()
        ? splitUrls(item) : missing('原任务返回了不完整的候选集合');
    });
    return missing('原任务候选没有可保存的媒体地址');
  };
  const collection = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value) || !value.length) return undefined;
    return value.flatMap((item) => recordObject(item)
      ? item.url !== undefined && item.url !== null && item.url !== '' ? values(item.url) : field === 'images' && typeof item.b64_json === 'string' && item.b64_json
        ? [toImageDataUrl(item.b64_json)] : values(undefined)
      : values(item));
  };
  let urls: string[] | undefined;
  for (const container of containers) { urls = collection(container[field]); if (urls) break; }
  if (!urls?.length && field !== 'images') {
    for (const container of containers) { urls = collection(container.images); if (urls) break; }
  }
  if (!urls?.length) for (const container of containers) {
    const candidates = collection(container.data);
    if (candidates?.length) { urls = candidates; break; }
  }
  if (!urls?.length) for (const container of containers) if (typeof container.url === 'string') { urls = values(container.url); break; }
  if (!urls?.length) return [];
  if (firstOnly) return urls.slice(0, 1);
  if (urls.length > MAX_NATIVE_MEDIA_OUTPUTS) throw new Error('原任务候选超过安全上限，未截断交付');
  return urls;
}

type AsyncTaskQuery = Pick<PollTaskOptions<unknown, string[]>,
  'fetchState' | 'interval' | 'maxDuration' | 'onFetchError' | 'signal'> & {
  missingResult: string;
  failureMessage: (task: Record<string, unknown>, status: string) => string;
  readUrls: (task: Record<string, unknown>, raw: unknown) => string[];
};

/** 统一异步任务完成、失败与候选缺失的处理。 */
export function queryAsyncMediaResult({ missingResult, failureMessage, readUrls, ...pollOptions }: AsyncTaskQuery): Promise<string[]> {
  const taskState = (raw: unknown): Record<string, unknown> =>
    recordObject(raw) ? recordObject(raw.data) ? raw.data : raw : {};
  const readStatus = (raw: unknown, task: Record<string, unknown>) => {
    const status = task.status ?? (recordObject(raw) ? raw.status : undefined);
    return typeof status === 'string' ? status.toLowerCase() : '';
  };
  return pollTask<unknown, string[]>({
    ...pollOptions,
    isComplete: (raw) => {
      const task = taskState(raw);
      if (!['completed', 'succeeded', 'success'].includes(readStatus(raw, task))) return null;
      const urls = readUrls(task, raw);
      if (urls.length === 0) throw new Error(missingResult);
      return urls;
    },
    isFailed: (raw) => {
      const task = taskState(raw);
      const status = readStatus(raw, task);
      return ['failed', 'error', 'cancelled', 'canceled'].includes(status) ? failureMessage(task, status) : null;
    },
  });
}

export function queryAsyncImageResult({ allowPartial, firstOnly, ...options }: Omit<AsyncTaskQuery, 'readUrls'> & {
  allowPartial?: boolean;
  firstOnly?: boolean;
}): Promise<string[]> {
  return queryAsyncMediaResult({
    ...options,
    readUrls: (task, raw) => {
      const urls = readAsyncMediaResultUrls(task, 'images', allowPartial, firstOnly);
      return urls.length > 0 || task === raw ? urls : readAsyncMediaResultUrls(raw, 'images', allowPartial, firstOnly);
    },
  });
}

type CompatibleTaskOptions = {
  signal?: AbortSignal; maxDuration: number; timeoutAsPause?: boolean; allowPartial?: boolean;
  firstOnly?: boolean;
};

async function fetchCompatibleTaskState(
  apiKey: string, baseUrl: string, taskId: string, signal?: AbortSignal, timeoutAsPause = true,
): Promise<unknown> {
  try {
    const response = await corsSafeFetch(`${baseUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}?language=zh`, {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal,
    });
    if (timeoutAsPause && [408, 504].includes(response.status)) throw new PollTimeoutError();
    if (!response.ok) throw new Error(`原通用查询失败（HTTP ${response.status}）`);
    return await response.json() as unknown;
  } catch (error) {
    throw redactModelProtocolError(error, apiKey);
  }
}

/** 查询通用 /tasks 图片契约，供实时调用和旧回执恢复共同使用。 */
export function queryCompatibleImageTask(apiKey: string, baseUrl: string, taskId: string, options: CompatibleTaskOptions): Promise<string[]> {
  return queryCompatibleMediaTask(apiKey, baseUrl, taskId, 'images', options);
}

/** 首次取回和续查均对同一个 /tasks 原任务 ID 执行 GET。 */
export function queryCompatibleMediaTask(
  apiKey: string, baseUrl: string, taskId: string, field: AsyncMediaResultField, options: CompatibleTaskOptions,
): Promise<string[]> {
  const { signal, maxDuration, timeoutAsPause, allowPartial, firstOnly } = options;
  const pollOptions = {
    fetchState: (querySignal?: AbortSignal) => fetchCompatibleTaskState(apiKey, baseUrl, taskId, querySignal, timeoutAsPause),
    interval: 3000,
    maxDuration,
    signal,
  };
  if (field === 'images') {
    return queryAsyncImageResult({
      ...pollOptions,
      missingResult: '原通用任务完成但没有完整图片',
      failureMessage: () => '服务商已确认原通用图片任务失败',
      allowPartial,
      firstOnly,
    });
  }
  return queryAsyncMediaResult({
    ...pollOptions,
    readUrls: (task, raw) => readAsyncMediaResultUrls(recordObject(task.result) ? task.result : raw, field, allowPartial, firstOnly),
    missingResult: field === 'audios' ? '原通用任务完成但没有完整音频' : '原通用任务完成但没有完整视频',
    failureMessage: (_task, status) => `任务失败: ${status}`,
  });
}
