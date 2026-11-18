/** 旧异步媒体接口和 APIMart 共用有界结果集合解析。 */
import { pollTask, PollTimeoutError, type PollTaskOptions } from '../pollTask';
import { MAX_NATIVE_MEDIA_OUTPUTS } from '../nativeMediaCollection';
import { splitCommaSeparatedUrls, toImageDataUrl } from './helpers';
import { corsSafeFetch } from './httpTransport';
import { redactModelProtocolError } from './modelProtocolHttp';

export type AsyncMediaResultField = 'videos' | 'audios' | 'images';
const recordObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 只选择一个明确的返回集合；每项／每项中的多个 URL 都保留，不按请求张数截断。 */
export function readAsyncMediaResultUrls(payload: unknown, field: AsyncMediaResultField, allowPartial = false): string[] {
  if (!recordObject(payload)) return [];
  const containers = [payload, ...(recordObject(payload.result) ? [payload.result] : []), ...(recordObject(payload.data) ? [payload.data] : [])];
  const missing = (message: string): string[] => {
    if (allowPartial) return [];
    throw new Error(message);
  };
  const splitUrls = (url: string) => {
    if (/^data:/i.test(url)) return [url];
    if (field !== 'images') return splitCommaSeparatedUrls([url]);
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
  if (!urls && field !== 'images') for (const container of containers) { urls = collection(container.images); if (urls) break; }
  if (!urls?.length) for (const container of containers) {
    const candidates = collection(container.data);
    if (candidates?.length) { urls = candidates; break; }
  }
  if (!urls?.length) for (const container of containers) if (typeof container.url === 'string') { urls = values(container.url); break; }
  if (!urls?.length) return [];
  if (urls.length > MAX_NATIVE_MEDIA_OUTPUTS) throw new Error('原任务候选超过安全上限，未截断交付');
  return urls;
}

type ImageTaskQuery = Pick<PollTaskOptions<unknown, string[]>,
  'fetchState' | 'interval' | 'maxDuration' | 'onFetchError' | 'signal'> & {
  missingResult: string;
  failureMessage: (task: Record<string, unknown>, status: string) => string;
  allowPartial?: boolean;
};

/** 统一兼容异步图片任务状态和有序候选。轮询时限由调用方提供。 */
export function queryAsyncImageResult({ missingResult, failureMessage, allowPartial, ...pollOptions }: ImageTaskQuery): Promise<string[]> {
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
      const taskUrls = readAsyncMediaResultUrls(task, 'images', allowPartial);
      const urls = taskUrls.length > 0 || task === raw ? taskUrls : readAsyncMediaResultUrls(raw, 'images', allowPartial);
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

/** 查询通用 /tasks 图片契约，供实时调用和旧回执恢复共同使用。 */
export function queryCompatibleImageTask(apiKey: string, baseUrl: string, taskId: string, options: {
  signal?: AbortSignal; maxDuration: number; timeoutAsPause?: boolean; allowPartial?: boolean;
}): Promise<string[]> {
  const { signal, maxDuration, timeoutAsPause = true } = options;
  return queryAsyncImageResult({
    fetchState: async (querySignal) => {
      try {
        const response = await corsSafeFetch(`${baseUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}?language=zh`, {
          headers: { Authorization: `Bearer ${apiKey}` }, signal: querySignal,
        });
        if (timeoutAsPause && [408, 504].includes(response.status)) throw new PollTimeoutError();
        if (!response.ok) throw new Error(`原通用查询失败（HTTP ${response.status}）`);
        return await response.json() as unknown;
      } catch (error) {
        throw redactModelProtocolError(error, apiKey);
      }
    },
    missingResult: '原通用任务完成但没有完整图片',
    failureMessage: () => '服务商已确认原通用图片任务失败',
    allowPartial: options.allowPartial,
    interval: 3000,
    maxDuration,
    signal,
  });
}
