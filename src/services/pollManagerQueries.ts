/** 旧媒体任务恢复使用的查询与结果解析；任务状态仍由 pollManager 管理。 */
import { fetchApimartTask, type ApimartTaskResult } from './ai/apimartImageResult';
import { queryAsyncMediaResult, readAsyncMediaResultUrls } from './ai/asyncMediaResult';
import { corsSafeFetch } from './ai/httpTransport';
import { parseRunningHubModelOutputs, readRunningHubModelStatus } from './ai/providers/runninghubModelResult';
import { pollTask } from './pollTask';

/** 续查旧 APIMart 音频回执，优先读取 audios 首项，兼容历史 images 字段。 */
export function queryLegacyApimartAudioResult(
  apiKey: string, baseUrl: string, taskId: string, maxDuration: number, signal: AbortSignal,
): Promise<string[]> {
  return queryAsyncMediaResult({
    fetchState: (querySignal) => fetchApimartTask(apiKey, baseUrl.replace(/\/+$/, ''), encodeURIComponent(taskId), querySignal, true),
    readUrls: (task) => {
      const result = task.result as ApimartTaskResult['result'];
      const urls = readAsyncMediaResultUrls({ audios: result?.audios }, 'audios', true, true);
      return urls.length ? urls : readAsyncMediaResultUrls({ audios: result?.images }, 'audios', true);
    },
    missingResult: '任务完成但未返回结果',
    failureMessage: (_task, status) => `任务失败: ${status}`,
    interval: 3000,
    maxDuration,
    signal,
  });
}

interface RunningHubTaskResult {
  status?: unknown;
  errorCode?: string;
  errorMessage?: string;
  results?: unknown;
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
  if (!response.ok || (typeof code === 'number' && code !== 0 && code !== 200)) {
    const message = typeof payload.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
    throw new Error(`RunningHub 任务查询失败：${message}`);
  }
  const data = payload.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as RunningHubTaskResult
    : payload as RunningHubTaskResult;
}

/** 使用原任务 ID 续查旧 RunningHub 回执，复用共用模型结果解析。 */
export async function pollRunningHubTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal: AbortSignal,
): Promise<string[]> {
  return pollTask<RunningHubTaskResult, string[]>({
    fetchState: (querySignal) => fetchRunningHubTask(apiKey, baseUrl, taskId, querySignal),
    isComplete: (result) => readRunningHubModelStatus(result.status) === 'SUCCESS'
      ? parseRunningHubModelOutputs(result.results, 'image').map((output) => output.url)
      : null,
    isFailed: (result) => readRunningHubModelStatus(result.status) === 'FAILED'
      ? `RunningHub 任务失败：${result.errorMessage || result.errorCode || '未知错误'}`
      : null,
    interval: 3000,
    signal,
  });
}
