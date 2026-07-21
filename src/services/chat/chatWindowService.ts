/**
 * chatWindowService — 独立窗口通信服务
 *
 * 使用 Tauri 事件系统（emit/listen）在主窗口和独立对话窗口之间同步状态。
 * emit 广播到所有窗口（含自身），每个窗口只 listen 自己关心的事件。
 *
 * 通信协议：
 * - Main emits  → Chat listens: `chat:sync-state`  首次快照与后续增量补丁
 * - Chat emits  → Main listens: `chat:action`      用户操作
 * - Chat emits  → Main listens: `chat:close-request` 独立窗口即将关闭
 * - Main emits  → Chat listens: `chat:close`       主窗口要求关闭独立窗口
 *
 * 数据流向：
 * - 主窗口持有 Zustand Store 作为唯一数据源
 * - 独立窗口是"哑终端"渲染器
 * - 独立窗口可独立读取 IndexedDB 做初始化加载
 */

import type { ChatConversation, ChatMessage } from '../../types/chat';
import type { GeneralModelConfig } from '../../types';
import type {
  AgentApprovalResolution,
  AgentMode,
  AgentTask,
} from '../../types/agent';
import type { LocalFileGrantSummary } from './fileGrantService';

export const CHAT_SYNC_EVENT = 'chat:sync-state';
export const CHAT_ACTION_EVENT = 'chat:action';
export const CHAT_CLOSE_REQUEST = 'chat:close-request';
export const CHAT_CLOSE_EVENT = 'chat:close';

// ============================================
// 状态快照（主窗口 → 独立窗口）
// ============================================

export interface ChatStateSnapshot {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  agentTasks: AgentTask[];
  projectId: string | null;
  projectName?: string;
  generalModels: GeneralModelConfig[];
  assistantModelId?: string;
  assistantImageModelId?: string;
  assistantVideoModelId?: string;
  mediaModelAvailability?: Record<string, boolean>;
  localFileGrants?: LocalFileGrantSummary[];
}

interface ChatEntityPatch<T> {
  upserted: T[];
  removedIds: string[];
  orderedIds?: string[];
}

export interface ChatStatePatch {
  conversations: ChatEntityPatch<ChatConversation>;
  messages: ChatEntityPatch<ChatMessage>;
  agentTasks: ChatEntityPatch<AgentTask>;
  fields: Partial<{
    activeConversationId: string | null;
    projectId: string | null;
    projectName: string | null;
    generalModels: GeneralModelConfig[];
    assistantModelId: string | null;
    assistantImageModelId: string | null;
    assistantVideoModelId: string | null;
    mediaModelAvailability: Record<string, boolean> | null;
    localFileGrants: LocalFileGrantSummary[] | null;
  }>;
}

export type ChatStateSync =
  | { type: 'snapshot'; revision: number; snapshot: ChatStateSnapshot }
  | {
      type: 'patch';
      baseRevision: number;
      revision: number;
      patch: ChatStatePatch;
    };

type Entity = { id: string };

function createEntityPatch<T extends Entity>(previous: T[], next: T[]): ChatEntityPatch<T> {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextIds = new Set(next.map((item) => item.id));
  const upserted = next.filter((item) => previousById.get(item.id) !== item);
  const removedIds = previous
    .filter((item) => !nextIds.has(item.id))
    .map((item) => item.id);

  const retainedIds = previous
    .filter((item) => nextIds.has(item.id))
    .map((item) => item.id);
  const appendedIds = next
    .filter((item) => !previousById.has(item.id))
    .map((item) => item.id);
  const naturalOrder = [...retainedIds, ...appendedIds];
  const nextOrder = next.map((item) => item.id);
  const orderChanged = naturalOrder.length !== nextOrder.length
    || naturalOrder.some((id, index) => id !== nextOrder[index]);

  return {
    upserted,
    removedIds,
    orderedIds: orderChanged ? nextOrder : undefined,
  };
}

function applyEntityPatch<T extends Entity>(
  current: T[],
  patch: ChatEntityPatch<T>,
): T[] {
  const removedIds = new Set(patch.removedIds);
  const upsertedById = new Map(patch.upserted.map((item) => [item.id, item]));
  const merged = current
    .filter((item) => !removedIds.has(item.id))
    .map((item) => upsertedById.get(item.id) ?? item);
  const currentIds = new Set(merged.map((item) => item.id));

  for (const item of patch.upserted) {
    if (!currentIds.has(item.id)) {
      merged.push(item);
      currentIds.add(item.id);
    }
  }

  if (!patch.orderedIds) return merged;
  const mergedById = new Map(merged.map((item) => [item.id, item]));
  return patch.orderedIds.flatMap((id) => {
    const item = mergedById.get(id);
    return item ? [item] : [];
  });
}

function valuesEqual(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (previous == null || next == null) return false;
  if (typeof previous !== 'object' || typeof next !== 'object') return false;
  return JSON.stringify(previous) === JSON.stringify(next);
}

function setChangedField<K extends keyof ChatStatePatch['fields']>(
  fields: ChatStatePatch['fields'],
  key: K,
  previous: ChatStateSnapshot[K],
  next: ChatStateSnapshot[K],
): void {
  if (valuesEqual(previous, next)) return;
  fields[key] = (next ?? null) as ChatStatePatch['fields'][K];
}

export function createChatStatePatch(
  previous: ChatStateSnapshot,
  next: ChatStateSnapshot,
): ChatStatePatch {
  const fields: ChatStatePatch['fields'] = {};
  setChangedField(fields, 'activeConversationId', previous.activeConversationId, next.activeConversationId);
  setChangedField(fields, 'projectId', previous.projectId, next.projectId);
  setChangedField(fields, 'projectName', previous.projectName, next.projectName);
  setChangedField(fields, 'generalModels', previous.generalModels, next.generalModels);
  setChangedField(fields, 'assistantModelId', previous.assistantModelId, next.assistantModelId);
  setChangedField(fields, 'assistantImageModelId', previous.assistantImageModelId, next.assistantImageModelId);
  setChangedField(fields, 'assistantVideoModelId', previous.assistantVideoModelId, next.assistantVideoModelId);
  setChangedField(
    fields,
    'mediaModelAvailability',
    previous.mediaModelAvailability,
    next.mediaModelAvailability,
  );
  setChangedField(fields, 'localFileGrants', previous.localFileGrants, next.localFileGrants);

  return {
    conversations: createEntityPatch(previous.conversations, next.conversations),
    messages: createEntityPatch(previous.messages, next.messages),
    agentTasks: createEntityPatch(previous.agentTasks, next.agentTasks),
    fields,
  };
}

export function hasChatStatePatchChanges(patch: ChatStatePatch): boolean {
  const entityPatches = [patch.conversations, patch.messages, patch.agentTasks];
  return Object.keys(patch.fields).length > 0 || entityPatches.some(
    (entityPatch) => entityPatch.upserted.length > 0
      || entityPatch.removedIds.length > 0
      || entityPatch.orderedIds !== undefined,
  );
}

export function applyChatStatePatch(
  current: ChatStateSnapshot,
  patch: ChatStatePatch,
): ChatStateSnapshot {
  const fields = patch.fields;
  return {
    ...current,
    ...fields,
    projectName: fields.projectName === null ? undefined : (fields.projectName ?? current.projectName),
    assistantModelId: fields.assistantModelId === null
      ? undefined
      : (fields.assistantModelId ?? current.assistantModelId),
    assistantImageModelId: fields.assistantImageModelId === null
      ? undefined
      : (fields.assistantImageModelId ?? current.assistantImageModelId),
    assistantVideoModelId: fields.assistantVideoModelId === null
      ? undefined
      : (fields.assistantVideoModelId ?? current.assistantVideoModelId),
    mediaModelAvailability: fields.mediaModelAvailability === null
      ? undefined
      : (fields.mediaModelAvailability ?? current.mediaModelAvailability),
    localFileGrants: fields.localFileGrants === null
      ? undefined
      : (fields.localFileGrants ?? current.localFileGrants),
    conversations: applyEntityPatch(current.conversations, patch.conversations),
    messages: applyEntityPatch(current.messages, patch.messages),
    agentTasks: applyEntityPatch(current.agentTasks, patch.agentTasks),
  };
}

// ============================================
// 用户操作（独立窗口 → 主窗口）
// ============================================

export type ChatAction =
  | {
      type: 'send_message';
      content: string;
      conversationId: string;
      dispatchMode?: 'queue' | 'interject';
    }
  | { type: 'switch_conversation'; conversationId: string }
  | { type: 'create_conversation'; projectId: string; title?: string }
  | { type: 'rename_conversation'; conversationId: string; title: string }
  | { type: 'toggle_pin'; conversationId: string }
  | { type: 'archive_conversation'; conversationId: string }
  | { type: 'delete_conversation'; conversationId: string }
  | { type: 'set_agent_mode'; conversationId: string; mode: AgentMode }
  | {
      type: 'resolve_agent_approval';
      approvalId: string;
      resolution: AgentApprovalResolution;
    }
  | { type: 'pause_agent_task'; taskId: string }
  | { type: 'resume_agent_task'; taskId: string }
  | { type: 'stop_agent_task'; taskId: string }
  | { type: 'skip_agent_step'; taskId: string; stepId: string }
  | { type: 'replan_agent_task'; taskId: string }
  | { type: 'rewind_agent_task'; taskId: string }
  | { type: 'authorize_local_files'; conversationId: string }
  | { type: 'revoke_local_file'; conversationId: string; grantId: string }
  | { type: 'select_model'; modelId?: string; category?: 'text' | 'image' | 'video' }
  | { type: 'focus_node'; nodeId: string }
  | { type: 'set_hovered_node'; nodeId: string | null }
  | { type: 'confirm_commands'; messageId: string }
  | { type: 'cancel_commands'; messageId: string }
  | { type: 'request_sync' };

// ============================================
// 主窗口：发送状态 + 接收 action
// ============================================

let mainInitDone = false;

/** 启动主窗口监听：接收来自独立窗口的 action */
export async function initMainWindowListener(
  onAction: (action: ChatAction) => void,
  onDetachClosed: () => void,
): Promise<() => void> {
  if (mainInitDone) return () => {};
  mainInitDone = true;

  const { listen } = await import('@tauri-apps/api/event');

  const unlistenAction = await listen<ChatAction>(CHAT_ACTION_EVENT, (event) => {
    onAction(event.payload);
  });

  const unlistenClose = await listen(CHAT_CLOSE_REQUEST, () => {
    onDetachClosed();
  });

  return () => {
    mainInitDone = false;
    unlistenAction();
    unlistenClose();
  };
}

/** 主窗口广播首次快照或后续增量补丁（独立窗口 listen 此事件） */
export async function emitSyncState(sync: ChatStateSync): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_SYNC_EVENT, sync);
  } catch {
    // 非 Tauri 环境静默失败
  }
}

/** 主窗口要求独立窗口关闭 */
export async function emitCloseChatWindow(): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_CLOSE_EVENT, {});
  } catch { /* ignore */ }
}

// ============================================
// 独立窗口：接收状态 + 发送 action
// ============================================

let chatWindowInit = false;

/** 启动独立窗口监听：接收来自主窗口的状态同步 */
export async function initChatWindowListener(
  onSync: (sync: ChatStateSync) => void,
  onCloseRequest: () => void,
): Promise<() => void> {
  if (chatWindowInit) return () => {};
  chatWindowInit = true;

  const { listen } = await import('@tauri-apps/api/event');

  const unlistenSync = await listen<ChatStateSync>(CHAT_SYNC_EVENT, (event) => {
    onSync(event.payload);
  });

  const unlistenClose = await listen(CHAT_CLOSE_EVENT, () => {
    onCloseRequest();
  });

  return () => {
    chatWindowInit = false;
    unlistenSync();
    unlistenClose();
  };
}

/** 独立窗口发送 action 到主窗口 */
export async function emitAction(action: ChatAction): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_ACTION_EVENT, action);
  } catch {
    console.warn('[chatWindow] failed to emit action');
  }
}

/** 独立窗口通知主窗口：即将关闭 */
export async function emitCloseRequest(): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_CLOSE_REQUEST, {});
  } catch { /* ignore */ }
}
