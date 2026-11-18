/** 即梦首次取回和原任务续查共用本地 CLI 查询。 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { logAiRequest } from './ai/httpTransport';
import { pollTask } from './pollTask';

interface DreaminaQuery {
  status: 'pending' | 'success' | 'failed';
  outputs: Array<{ url: string; localPath: string }>;
  failReason: string;
}

interface DreaminaResultOptions {
  signal?: AbortSignal;
  firstOnly?: boolean;
  failureMessage?: string;
  logQuery?: boolean;
}

/** 用原 submitId 查询 CLI，优先返回本地文件地址，支持首项和完整候选两种交付。 */
export function queryDreaminaResult(submitId: string, options: DreaminaResultOptions = {}): Promise<string[]> {
  return pollTask<DreaminaQuery, string[]>({
    fetchState: async (signal) => {
      signal?.throwIfAborted();
      if (options.logQuery) {
        logAiRequest('tauri://dreamina_query_result', {
          method: 'INVOKE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ submitId }),
        }, 'Dreamina');
      }
      try {
        return await invoke<DreaminaQuery>('dreamina_query_result', { submitId });
      } catch (cause) {
        if (cause instanceof Error) throw cause;
        throw new Error(typeof cause === 'string' ? cause : JSON.stringify(cause), { cause });
      }
    },
    isComplete: (result) => {
      if (result.status !== 'success' || result.outputs.length === 0) return null;
      const outputs = options.firstOnly ? result.outputs.slice(0, 1) : result.outputs;
      return outputs.map(({ localPath, url }) => localPath ? convertFileSrc(localPath) : url);
    },
    isFailed: (result) => result.status === 'failed'
      ? options.failureMessage ?? (result.failReason || '即梦生成失败') : null,
    interval: 3000,
    maxDuration: 60 * 60 * 1000,
    timeoutMsg: '即梦生成超时',
    signal: options.signal,
  });
}
