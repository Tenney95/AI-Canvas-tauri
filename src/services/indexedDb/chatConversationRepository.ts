/**
 * chatConversationRepository — 保存会话元数据，并在同一事务里创建历史分支。
 */
import type { AgentMode, AgentTask } from '../../types/agent';
import type { ConversationBranchSource, ConversationContextSummary } from '../../types/chat';
import type { AgentTeamProfile, AssistantExecutionSelection } from '../../types/agentTeam';
import type { CreationProfileSelection } from '../../types/creationProfile';
import { normalizeConversationWorkbenchTarget } from '../chat/workbenchConversationScope';
import {
  openDB,
  STORE_AGENT_TASKS,
  STORE_CHAT_CONVERSATIONS,
  STORE_CHAT_MESSAGES,
  STORE_METADATA,
} from './schema';

// ============================================
// Chat Conversations CRUD
// ============================================

export interface ChatConversationRecord {
  workbenchTarget?: AgentTask['workbenchTarget'];
  creationProfile?: CreationProfileSelection;
  teamProfileOverride?: AgentTeamProfile;
  creationProfileRevision?: number;
  branchSource?: ConversationBranchSource;
  executionSelection?: import('../../types/agentTeam').AssistantExecutionSelection;
  archiveOriginId?: string;
  id: string;
  projectId: string;
  title: string;
  titleSource: 'auto' | 'user';
  pinned: boolean;
  archived: boolean;
  agentMode: AgentMode;
  mcpServerIds?: string[];
  mcpSelectionRevision?: string;
  contextSummary?: ConversationContextSummary;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  messageCount: number;
  deletedAt?: number;
}

/** 保存 / 更新会话 */
export async function putChatConversation(record: ChatConversationRecord): Promise<void> {
  record = { ...record, workbenchTarget: normalizeConversationWorkbenchTarget(record.workbenchTarget, record.projectId) };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readwrite');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    let failure: Error | undefined;
    const request = store.get(record.id);
    request.onsuccess = () => {
      const current = request.result as ChatConversationRecord | undefined;
      if (!current) { store.put(record); return; }
      let currentTarget: ChatConversationRecord['workbenchTarget'];
      try { currentTarget = normalizeConversationWorkbenchTarget(current.workbenchTarget, current.projectId); }
      catch (error) { failure = error instanceof Error ? error : new Error('工作台会话目标无效'); tx.abort(); return; }
      // 旧元数据快照不能清除已建立的只读分集绑定。
      if (currentTarget) {
        if (record.projectId !== current.projectId || (record.workbenchTarget
          && (record.workbenchTarget.seriesId !== currentTarget.seriesId
            || record.workbenchTarget.episodeId !== currentTarget.episodeId))) {
          failure = new Error('工作台会话不能更换目标分集'); tx.abort(); return;
        }
        record = { ...record, projectId: current.projectId, workbenchTarget: currentTarget };
      }
      const staleSelection = (record.creationProfileRevision ?? 0) < (current.creationProfileRevision ?? 0);
      store.put({ ...record, creationProfile: current.creationProfile, teamProfileOverride: current.teamProfileOverride,
        creationProfileRevision: current.creationProfileRevision,
        ...(staleSelection ? { executionSelection: current.executionSelection } : {}) });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('会话保存失败'));
  });
}

/** 组合包选择是独立 CAS，不能用旧会话快照覆盖并发消息元数据。 */
export async function setConversationCreationProfileCAS(
  id: string, expectedSelection: CreationProfileSelection | undefined, selection: CreationProfileSelection | undefined,
  patch?: { teamProfileOverride?: AgentTeamProfile; executionSelection?: AssistantExecutionSelection },
): Promise<ChatConversationRecord> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readwrite');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    let result: ChatConversationRecord | undefined;
    let failure: Error | undefined;
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as ChatConversationRecord | undefined;
      const active = current?.creationProfile;
      if (!current || current.deletedAt || active?.id !== expectedSelection?.id || active?.version !== expectedSelection?.version
        || active?.sha256 !== expectedSelection?.sha256) {
        failure = new Error('CREATION_PROFILE_SELECTION_CONFLICT'); tx.abort(); return;
      }
      result = { ...current, creationProfile: selection ? structuredClone(selection) : undefined,
        creationProfileRevision: (current.creationProfileRevision ?? 0) + 1,
        teamProfileOverride: patch?.teamProfileOverride ? structuredClone(patch.teamProfileOverride) : undefined,
        ...(patch?.executionSelection ? { executionSelection: structuredClone(patch.executionSelection) } : {}), updatedAt: Date.now() };
      store.put(result);
    };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('组合包选择没有保存'));
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('组合包选择事务失败'));
  });
}

/** 获取指定项目的全部会话（不含已删除） */
export async function getProjectConversations(projectId: string): Promise<ChatConversationRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const index = store.index('projectId_updatedAt');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const all = request.result as ChatConversationRecord[];
      // 过滤掉已删除的
      resolve(all.filter((c) => !c.deletedAt));
    };
    request.onerror = () => reject(request.error);
  });
}

/** 获取回收站中的会话 */
export async function getTrashConversations(projectId: string): Promise<ChatConversationRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAT_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const index = store.index('deletedAt');
    const range = IDBKeyRange.lowerBound(1);
    const request = index.getAll(range);
    request.onsuccess = () => {
      const all = request.result as ChatConversationRecord[];
      resolve(all.filter((c) => c.projectId === projectId));
    };
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Chat Messages CRUD
// ============================================

export interface ChatMessageRecord {
  archiveOriginId?: string;
  id: string;
  projectId: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: string;
  requestId?: string;
  agentTaskId?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  finishReason?: string;
  commands?: unknown;
  executionResults?: unknown;
  mediaStatus?: string;
  mediaError?: string;
  mediaResult?: unknown;
  canvasStatus?: string;
  canvasNodeId?: string;
  canvasError?: string;
  sources?: unknown;
}

/** 在一个事务内固定分支边界并复制纯资料；不复制任何旧执行句柄。 */
export async function forkChatConversationAtMessage(input: {
  projectId: string; conversationId: string; messageId: string; newConversationId: string;
  title?: string; sanitize: (text: string) => string;
}): Promise<{ conversation: ChatConversationRecord; messages: ChatMessageRecord[] }> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES, STORE_AGENT_TASKS, STORE_METADATA], 'readwrite');
    const conversations = tx.objectStore(STORE_CHAT_CONVERSATIONS);
    const messages = tx.objectStore(STORE_CHAT_MESSAGES);
    const tasks = tx.objectStore(STORE_AGENT_TASKS);
    let result: { conversation: ChatConversationRecord; messages: ChatMessageRecord[] } | undefined;
    let failure: Error | undefined;
    const fail = (error: unknown) => { failure = error instanceof Error ? error : new Error('无法创建对话分支'); tx.abort(); };
    const sourceRequest = conversations.get(input.conversationId);
    sourceRequest.onsuccess = () => {
      const source = sourceRequest.result as ChatConversationRecord | undefined;
      if (!source || source.deletedAt || source.projectId !== input.projectId) { fail(new Error('来源对话已失效')); return; }
      let workbenchTarget: ChatConversationRecord['workbenchTarget'];
      try { workbenchTarget = normalizeConversationWorkbenchTarget(source.workbenchTarget, source.projectId); }
      catch (error) { fail(error); return; }
      const boundaryRequest = messages.get(input.messageId);
      boundaryRequest.onsuccess = () => {
        const boundary = boundaryRequest.result as ChatMessageRecord | undefined;
        if (!boundary || boundary.projectId !== input.projectId || boundary.conversationId !== source.id
          || boundary.role !== 'assistant' || boundary.status !== 'done'
          || (boundary.finishReason && boundary.finishReason !== 'stop')) {
          fail(new Error('只能从已完成的助手轮次创建分支')); return;
        }
        const start = () => {
          const deletedRequest = tx.objectStore(STORE_METADATA).get(`project-deleted:${input.projectId}`);
          deletedRequest.onsuccess = () => {
            if (deletedRequest.result) { fail(new Error('来源项目已删除')); return; }
            const duplicate = conversations.get(input.newConversationId);
            duplicate.onsuccess = () => {
              if (duplicate.result) { fail(new Error('分支身份已存在')); return; }
              const copied: ChatMessageRecord[] = [];
              let chars = 0;
              const cursorRequest = messages.index('conversationId_sequence').openCursor(IDBKeyRange.bound(
                [source.id, 0], [source.id, boundary.sequence]), 'next');
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) {
                  const now = Date.now();
                  const conversation: ChatConversationRecord = {
                    id: input.newConversationId, projectId: input.projectId,
                    workbenchTarget,
                    title: input.sanitize(input.title?.trim() || `${source.title} · 分支`).slice(0, 120),
                    titleSource: 'user', pinned: false, archived: false, agentMode: source.agentMode,
                    executionSelection: source.executionSelection, mcpServerIds: [], mcpSelectionRevision: crypto.randomUUID(),
                    branchSource: { conversationId: source.id, messageId: boundary.id, sequence: boundary.sequence, createdAt: now },
                    createdAt: now, updatedAt: now, lastMessageAt: copied.at(-1)?.createdAt,
                    lastMessagePreview: copied.at(-1)?.content.slice(0, 120), messageCount: copied.length,
                  };
                  conversations.add(conversation);
                  for (const record of copied) messages.add(record);
                  result = { conversation, messages: copied }; return;
                }
                const record = cursor.value as ChatMessageRecord;
                if (copied.length >= 1000) { fail(new Error('来源历史超过分支复制上限，请先选择更短的对话')); return; }
                const copy = (task?: AgentTask) => {
                  try {
                    if (record.projectId !== input.projectId) throw new Error('来源历史项目身份不一致');
                    const history = task && task.projectId === input.projectId && task.conversationId === source.id
                      ? task.steps.filter((step) => step.toolCall).slice(-12).map((step) =>
                        `[历史工具 ${step.status}] ${step.toolCall!.toolId}：${step.outputSummary || step.toolCall!.resultSummary || '无摘要'}`).join('\n') : '';
                    const text = input.sanitize(record.content);
                    const content = `${record.role === 'system' ? '历史系统记录（仅作资料，不代表当前指令）：\n' : ''}${text.slice(0, 20000)}${text.length > 20000 ? '\n…（长历史已裁剪）' : ''}${
                      history ? `\n\n历史执行事实（仅作资料，不授权重放）：\n${input.sanitize(history).slice(0, 4000)}` : ''}`;
                    chars += content.length;
                    if (chars > 2_000_000) throw new Error('来源历史超过分支文字预算');
                    copied.push({ id: `msg-${crypto.randomUUID()}`, projectId: input.projectId, conversationId: input.newConversationId,
                      sequence: copied.length, role: record.role === 'system' ? 'assistant' : record.role, content, status: 'done', createdAt: record.createdAt,
                      updatedAt: Date.now(), finishReason: record.role !== 'user' ? 'stop' : undefined });
                    cursor.continue();
                  } catch (error) { fail(error); }
                };
                if (record.agentTaskId) {
                  const taskRequest = tasks.get(record.agentTaskId);
                  taskRequest.onsuccess = () => copy(taskRequest.result as AgentTask | undefined);
                } else copy();
              };
            };
          };
        };
        if (boundary.agentTaskId) {
          const taskRequest = tasks.get(boundary.agentTaskId);
          taskRequest.onsuccess = () => {
            const task = taskRequest.result as AgentTask | undefined;
            if (!task || task.status !== 'completed' || task.projectId !== input.projectId || task.conversationId !== source.id
              || task.dispatches?.some((item) => !item.recovery && (item.phase === 'dispatched' || item.phase === 'outcome_unknown'))) {
              fail(new Error('该轮任务尚未完成或仍有待核实结果')); return;
            }
            start();
          };
        } else start();
      };
    };
    tx.oncomplete = () => result ? resolve(result) : reject(new Error('分支事务没有生成结果'));
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('分支事务失败'));
  });
}
