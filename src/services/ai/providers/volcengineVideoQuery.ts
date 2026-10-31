/** 火山视频首次等待与任务恢复共用的只读查询协议，不提交或重投生成任务。 */
import { pollTask, PollTimeoutError } from '../../pollTask';
import { corsSafeFetch } from '../httpTransport';

export function pollVolcengineVideoTask(options: {
  apiKey: string;
  baseUrl: string;
  taskId: string;
  signal?: AbortSignal;
  maxDuration: number;
  onFailed: (status: 'failed' | 'cancelled') => void;
}): Promise<{ url: string; completionTokens?: number }> {
  const { apiKey, baseUrl, taskId, signal, maxDuration, onFailed } = options;
  return pollTask<Record<string, unknown>, { url: string; completionTokens?: number }>({
    fetchState: async (querySignal) => {
      const response = await corsSafeFetch(`${baseUrl}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: querySignal,
      });
      if ([408, 504].includes(response.status)) throw new PollTimeoutError();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    },
    isComplete: (raw) => {
      if (raw.status !== 'succeeded') return null;
      const content = raw.content as Record<string, unknown> | undefined;
      const url = content?.video_url as string | undefined;
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (!url) throw new Error('任务完成但未返回视频地址');
      return { url, completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined };
    },
    isFailed: (raw) => {
      if (raw.status !== 'failed' && raw.status !== 'cancelled') return null;
      onFailed(raw.status);
      const error = raw.error as { message?: string } | undefined;
      return `任务失败: ${error?.message || raw.status}`;
    },
    interval: 3000, maxDuration, onFetchError: 'throw', signal,
  });
}
