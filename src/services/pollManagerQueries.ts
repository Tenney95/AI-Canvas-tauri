/** 旧媒体任务恢复使用的查询与结果解析；任务状态仍由 pollManager 管理。 */
import type { NodeType } from '../types';
import { splitCommaSeparatedUrls } from './ai/helpers';
import { corsSafeFetch } from './ai/httpTransport';
import { pollTask, PollTimeoutError } from './pollTask';

export interface ApimartTaskResult<TResult = Record<string, unknown>> {
  code: number;
  status?: string;
  progress?: number;
  result?: TResult;
}

export async function fetchApimartTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
  timeoutAsPause = false,
): Promise<ApimartTaskResult> {
  const resp = await corsSafeFetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (timeoutAsPause && [408, 504].includes(resp.status)) throw new PollTimeoutError();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = (await resp.json()) as Record<string, unknown>;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    const d = raw.data as Record<string, unknown>;
    return {
      code: raw.code as number,
      status: (d.status ?? raw.status) as string | undefined,
      progress: (d.progress ?? raw.progress) as number | undefined,
      result: d.result as Record<string, unknown> | undefined,
    };
  }
  return raw as unknown as ApimartTaskResult;
}

export function extractApimartUrls(
  result: Record<string, unknown> | undefined,
  nodeType: NodeType,
): string[] {
  if (!result) return [];
  const extractUrls = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const url = (item as { url?: unknown }).url;
      if (Array.isArray(url)) {
        return splitCommaSeparatedUrls(url.filter((entry): entry is string => typeof entry === 'string'));
      }
      return typeof url === 'string' ? splitCommaSeparatedUrls([url]) : [];
    });
  };
  if (nodeType === 'ai-video') {
    const urls = extractUrls(result.videos);
    if (urls.length > 0) return [urls[0]];
  }
  if (nodeType === 'ai-audio') {
    const urls = extractUrls(result.audios);
    if (urls.length > 0) return [urls[0]];
  }
  return extractUrls(result.images);
}

interface RunningHubTaskResult {
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  results?: Array<{ url?: string | null }> | null;
}

async function fetchRunningHubTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<RunningHubTaskResult> {
  const response = await corsSafeFetch(`${baseUrl.replace(/\/+$/, '')}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ taskId }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const code = payload.code;
  if (!response.ok || (typeof code === 'number' && code !== 0)) {
    const message = typeof payload.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
    throw new Error(`RunningHub 任务查询失败：${message}`);
  }
  const data = payload.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as RunningHubTaskResult
    : payload as RunningHubTaskResult;
}

export async function pollRunningHubTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal: AbortSignal,
): Promise<string[]> {
  return pollTask<RunningHubTaskResult, string[]>({
    fetchState: (querySignal) => fetchRunningHubTask(apiKey, baseUrl, taskId, querySignal),
    isComplete: (result) => {
      if (result.status?.toUpperCase() !== 'SUCCESS') return null;
      const urls = result.results?.flatMap((item) => item.url ? [item.url] : []) ?? [];
      if (urls.length === 0) throw new Error('RunningHub 任务完成但未返回图片');
      return urls;
    },
    isFailed: (result) => result.status?.toUpperCase() === 'FAILED'
      ? `RunningHub 任务失败：${result.errorMessage || result.errorCode || '未知错误'}`
      : null,
    interval: 3000,
    signal,
  });
}
