import {
  readAgentAuthorizedTextFile,
  selectAgentTextFiles,
} from '../fileService';

const MAX_FILES_PER_CONVERSATION = 10;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_FILE_READ_BYTES = 256 * 1024;

interface LocalFileGrant {
  id: string;
  conversationId: string;
  path: string;
  displayName: string;
  size: number;
  extension: string;
  createdAt: number;
  activeReads: Set<AbortController>;
}

export interface LocalFileGrantSummary {
  id: string;
  displayName: string;
  size: number;
  extension: string;
  createdAt: number;
}

const grants = new Map<string, LocalFileGrant>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function toSummary(grant: LocalFileGrant): LocalFileGrantSummary {
  return {
    id: grant.id,
    displayName: grant.displayName,
    size: grant.size,
    extension: grant.extension,
    createdAt: grant.createdAt,
  };
}

export function subscribeFileGrants(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listConversationFileGrants(
  conversationId: string,
): LocalFileGrantSummary[] {
  return [...grants.values()]
    .filter((grant) => grant.conversationId === conversationId)
    .map(toSummary);
}

export async function authorizeConversationFiles(
  conversationId: string,
): Promise<LocalFileGrantSummary[]> {
  if (!conversationId) throw new Error('没有活动对话，无法授权文件');
  const existing = listConversationFileGrants(conversationId);
  const remaining = MAX_FILES_PER_CONVERSATION - existing.length;
  if (remaining <= 0) throw new Error(`每个对话最多授权 ${MAX_FILES_PER_CONVERSATION} 个文件`);
  const selected = await selectAgentTextFiles();
  const created: LocalFileGrantSummary[] = [];
  for (const file of selected.slice(0, remaining)) {
    if (file.size > MAX_FILE_BYTES) continue;
    const duplicate = [...grants.values()].some(
      (grant) => grant.conversationId === conversationId && grant.path === file.path,
    );
    if (duplicate) continue;
    const id = `grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const grant: LocalFileGrant = {
      id,
      conversationId,
      path: file.path,
      displayName: file.fileName,
      size: file.size,
      extension: file.extension,
      createdAt: Date.now(),
      activeReads: new Set(),
    };
    grants.set(id, grant);
    created.push(toSummary(grant));
  }
  if (created.length > 0) notify();
  return created;
}

export function revokeFileGrant(conversationId: string, grantId: string): boolean {
  const grant = grants.get(grantId);
  if (!grant || grant.conversationId !== conversationId) return false;
  for (const controller of grant.activeReads) controller.abort();
  grants.delete(grantId);
  notify();
  return true;
}

export function clearConversationFileGrants(conversationId: string): void {
  let changed = false;
  for (const grant of [...grants.values()]) {
    if (grant.conversationId !== conversationId) continue;
    for (const controller of grant.activeReads) controller.abort();
    grants.delete(grant.id);
    changed = true;
  }
  if (changed) notify();
}

export async function readGrantedTextFile(
  conversationId: string,
  grantId: string,
  signal?: AbortSignal,
): Promise<{ summary: LocalFileGrantSummary; content: string }> {
  const grant = grants.get(grantId);
  if (!grant || grant.conversationId !== conversationId) {
    throw new Error('文件授权不存在、已撤销或不属于当前对话');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  grant.activeReads.add(controller);
  try {
    let content: string;
    try {
      content = await readAgentAuthorizedTextFile(
        grant.path,
        MAX_AGENT_FILE_READ_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('读取已取消', 'AbortError');
      const message = error instanceof Error ? error.message : '';
      if (
        message.startsWith('文件超过')
        || message === '文件不是有效的 UTF-8 文本'
        || message === '授权目标已不再是文件'
      ) throw error;
      throw new Error('读取授权文件失败', { cause: error });
    }
    if (!grants.has(grantId)) throw new Error('文件授权已撤销');
    return { summary: toSummary(grant), content };
  } finally {
    signal?.removeEventListener('abort', abort);
    grant.activeReads.delete(controller);
  }
}
