/** Muse 固定原生命令桥；Cookie 和网页执行细节均不进入 Renderer 配置或日志。 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './fs/core';
import { pollTask, PollTaskFailedError } from './pollTask';

export type MuseMediaKind = 'image' | 'video';
interface MuseTaskStatus {
  status: 'prepared' | 'ready' | 'running' | 'completed' | 'failed' | 'unknown';
  url?: string;
}

export async function museInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnv()) throw new Error('Muse 网页登录和生成仅在 Tauri 桌面端可用');
  try { return await invoke<T>(command, args); }
  catch (error) {
    // 原生只返回有限分类文案；不将未知对象、IPC 参数或底层异常写入日志。
    throw new Error(typeof error === 'string' && error.length <= 300 ? error : 'Muse 原生操作失败，请在设置中检查登录状态');
  }
}

export function assertMuseTaskId(taskId: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(taskId)) {
    throw new Error('Muse 原任务身份无效，未提交或重发请求');
  }
}

/** 仅续取指定原任务；prepared、ready、unknown 均不能在此触发发送。 */
export async function queryMuseTask(taskId: string, kind: MuseMediaKind, signal?: AbortSignal): Promise<string> {
  assertMuseTaskId(taskId);
  return pollTask<MuseTaskStatus, string>({
    fetchState: async (querySignal) => { querySignal.throwIfAborted(); return museInvoke<MuseTaskStatus>('muse_query', { taskId }); },
    isComplete: (result) => {
      if (result.status === 'failed') throw new PollTaskFailedError('Muse 原任务已明确失败，请查看 Muse 官网后重新发起');
      if (result.status === 'running') return null;
      if (result.status !== 'completed') throw new Error('Muse 原任务尚未确认提交或连接已中断，请检查原网页；不会重新发送');
      const prefix = kind === 'image' ? /^data:image\/(?:png|jpeg|webp|gif);base64,/ : /^data:video\/(?:mp4|webm);base64,/;
      if (!result.url || !prefix.test(result.url) || result.url.length > (kind === 'image' ? 45 : 180) * 1024 * 1024) {
        throw new Error('Muse 原任务没有可交付的受支持媒体，原任务保留');
      }
      return result.url;
    },
    interval: 3000, maxDuration: kind === 'image' ? 4 * 60_000 : 10 * 60_000,
    timeoutMsg: 'Muse 等待超时，原任务已保留，可继续查询；不会重新生成', signal,
  });
}
