/** APIMart 视频首次取回和原任务恢复共用结果查询。 */
import { fetchApimartTask, type ApimartTaskResult } from './apimartImageResult';
import { queryAsyncMediaResult, readAsyncMediaResultUrls } from './asyncMediaResult';
import { redactModelProtocolErrorText } from './modelProtocolHttp';

interface ApimartVideoQueryOptions {
  maxDuration: number;
  signal?: AbortSignal;
  allowImageFallback?: boolean;
  allowPartial?: boolean;
  firstVideoOnly?: boolean;
  missingResult?: string;
  failureMessage?: (status: string) => string;
  onFailed?: (status: 'failed' | 'cancelled') => void;
}

function readApimartVideoUrls(collection: unknown, allowPartial?: boolean): string[] {
  if (!Array.isArray(collection)) return [];
  const candidates = collection.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('url' in item)) return [item];
    const url = Array.isArray(item.url)
      ? item.url.filter((entry: unknown) => typeof entry !== 'string' || entry.trim())
      : item.url;
    // APIMart may include an empty URL array next to valid output or before the fallback field.
    if ((Array.isArray(url) && url.length === 0) || (typeof url === 'string' && !url.trim())) return [];
    return [{ url }];
  });
  return readAsyncMediaResultUrls({ videos: candidates }, 'videos', allowPartial);
}

/** 供视频首次取回和续查复用，优先读取视频候选，按调用方配置兼容旧图片字段。 */
export function queryApimartVideoResult(
  apiKey: string, baseUrl: string, taskId: string, options: ApimartVideoQueryOptions,
): Promise<string[]> {
  const { maxDuration, signal, allowImageFallback = true, allowPartial, firstVideoOnly, onFailed } = options;
  return queryAsyncMediaResult({
    fetchState: (querySignal) => fetchApimartTask(apiKey, baseUrl.replace(/\/+$/, ''), encodeURIComponent(taskId), querySignal, true),
    readUrls: (task) => {
      const result = task.result as ApimartTaskResult['result'];
      const videos = readApimartVideoUrls(result?.videos, allowPartial);
      if (videos.length) return firstVideoOnly ? videos.slice(0, 1) : videos;
      return allowImageFallback ? readApimartVideoUrls(result?.images, allowPartial) : [];
    },
    missingResult: options.missingResult ?? 'APIMart 视频生成完成但未返回结果',
    failureMessage: (task, status) => {
      onFailed?.(status === 'cancelled' || status === 'canceled' ? 'cancelled' : 'failed');
      if (options.failureMessage) return options.failureMessage(status);
      const error = task.error as ApimartTaskResult['error'];
      const detail = typeof error === 'string' ? error : error?.message;
      return redactModelProtocolErrorText(`APIMart 视频生成失败: ${detail?.trim() || status}`, apiKey);
    },
    interval: 3000,
    maxDuration,
    signal,
  });
}
