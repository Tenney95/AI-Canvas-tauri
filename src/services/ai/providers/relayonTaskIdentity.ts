import { isRecord } from '../modelProtocolShared';

function taskIdentity(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/** 仅供匹配完整内置视频协议的万象提交使用；不改查询协议，也不猜测冲突响应的原任务。 */
export function normalizeRelayonVideoSubmitResponse(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const id = taskIdentity(payload.id), taskId = taskIdentity(payload.task_id);
  if (id !== undefined && taskId !== undefined && id !== taskId) {
    throw new Error('万象提交响应中的任务身份不一致，原提交已保留，未重新提交生成');
  }
  const identity = id ?? taskId;
  return identity === undefined ? payload : { ...payload, id: identity };
}
