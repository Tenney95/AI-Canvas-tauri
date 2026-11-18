/** CCC 异步图片结果的查询合同，由首次取图和原任务续查共享。 */
import type { ResolvedModelProtocolPoll } from '../../types/aiTypes';
import { PollTaskFailedError } from '../pollTask';
import { pollResolvedModelProtocol } from './modelProtocol';

/** 按原任务 ID 构造 CCC 图片的声明式查询合同。 */
export function createCccImageResultPoll(
  baseUrl: string, taskId: string, limits: Pick<ResolvedModelProtocolPoll, 'maxDurationMs' | 'maxAttempts'>,
): ResolvedModelProtocolPoll {
  return {
    method: 'GET', url: `${baseUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}`,
    auth: { type: 'bearer' }, statusPath: 'data.status', successValues: ['completed'], failureValues: ['failed'],
    resultUrlPath: 'data.result.images.*.url', intervalMs: 3000, ...limits,
  };
}

function validateCccFailure(raw: unknown): void {
  const payload = raw as { data?: { status?: string; error?: { message?: unknown } }; error?: { message?: unknown } } | null;
  if (payload?.data?.status !== 'failed') return;
  const detail = payload.data.error?.message ?? payload.error?.message;
  throw new PollTaskFailedError(typeof detail === 'string' && detail.trim() ? `CCC 图片任务失败：${detail}` : 'CCC 图片任务失败');
}

/** 首次取回与原任务续查共用声明式轮询和图片候选解析。 */
export async function queryCccImageResult(
  poll: ResolvedModelProtocolPoll, apiKey: string, signal: AbortSignal | undefined, allowedBaseUrl: string,
  includeFailureDetail = false,
): Promise<string[]> {
  const args = [poll, apiKey, signal, allowedBaseUrl] as const;
  const result = await (includeFailureDetail
    ? pollResolvedModelProtocol(...args, validateCccFailure)
    : pollResolvedModelProtocol(...args));
  return result.urls ?? [];
}
