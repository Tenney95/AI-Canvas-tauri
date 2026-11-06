import type { ChatConversation } from '../../types/chat';

/** 非法持久绑定必须失败关闭，不能删除字段后退回普通画布会话。 */
export function normalizeConversationWorkbenchTarget(
  value: unknown,
  projectId: string,
): ChatConversation['workbenchTarget'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作台会话目标无效');
  const target = value as Record<string, unknown>;
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 180
    && id.trim() === id && !/[\s/\\\p{Cc}]/u.test(id);
  if (!validId(target.seriesId) || !validId(target.episodeId) || target.seriesId !== projectId
    || target.seriesId === target.episodeId) throw new Error('工作台会话目标无效');
  return { seriesId: target.seriesId, episodeId: target.episodeId };
}
