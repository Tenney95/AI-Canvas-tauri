/**
 * projectMemoryService — 项目记忆持久化与脱敏（P3-D2）。
 *
 * 记忆只保存简短事实，写入前统一脱敏密钥、凭据和本地绝对路径，
 * 并按长度上限截断，禁止把文件全文、网页全文或临时结果写入长期记忆。
 */
import {
  putProjectMemory,
  getProjectMemories,
  deleteProjectMemory as dbDeleteProjectMemory,
  deleteProjectMemories as dbDeleteProjectMemories,
  markConversationMemoriesUnavailable as dbMarkConversationMemoriesUnavailable,
} from '../indexedDbService';
import {
  PROJECT_MEMORY_CONTENT_LIMIT,
  type ProjectMemory,
} from '../../types/memory';

/**
 * 脱敏记忆正文：移除密钥、凭据和本地绝对路径，并截断到长度上限。
 * 与 agentRuntime 的持久化摘要脱敏保持一致的模式。
 */
export function sanitizeMemoryContent(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[已脱敏密钥]')
    .replace(/\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, '[已脱敏凭据]')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, '[本地路径]')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '[本地路径]')
    .trim()
    .slice(0, PROJECT_MEMORY_CONTENT_LIMIT);
}

export async function saveProjectMemory(memory: ProjectMemory): Promise<void> {
  await putProjectMemory(memory);
}

export async function loadProjectMemories(projectId: string): Promise<ProjectMemory[]> {
  const records = await getProjectMemories(projectId);
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeProjectMemory(id: string): Promise<void> {
  await dbDeleteProjectMemory(id);
}

export async function removeProjectMemories(projectId: string): Promise<void> {
  await dbDeleteProjectMemories(projectId);
}

export async function markConversationMemoriesUnavailable(
  conversationId: string,
): Promise<void> {
  await dbMarkConversationMemoriesUnavailable(conversationId);
}
