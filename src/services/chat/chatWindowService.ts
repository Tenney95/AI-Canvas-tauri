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
 * - 独立窗口等待主窗口快照，不自行加载或执行对话任务
 */

import type { Node } from '@xyflow/react';
import type { ChatConversation, ChatImageReference, ChatMessage, ChatPanelView } from '../../types/chat';
import type { MediaModelOption } from '../../components/nodes/shared/defaultModels';
import type { BaseNodeData, GeneralModelConfig, ModelGroup, PromptSubmitShortcut } from '../../types';
import type { SkillPickerOption } from '../../types/agentPackage';
import type { DramaAssetLibrary } from '../../types/dramaAssets';
import type {
  AgentApprovalResolution,
  AgentMode,
  AgentTask,
} from '../../types/agent';
import type { LocalFileGrantSummary } from './fileGrantService';
import type { McpClientOption } from '../../types/mcpClient';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../types/referencePreview';

export const CHAT_SYNC_EVENT = 'chat:sync-state';
export const CHAT_ACTION_EVENT = 'chat:action';
export const CHAT_CLOSE_REQUEST = 'chat:close-request';
export const CHAT_CLOSE_EVENT = 'chat:close';
/** 原生窗口 label 由 lib.rs 的 open_chat_window 固定创建。 */
export const CHAT_MAIN_WINDOW_LABEL = 'main';
export const CHAT_DETACHED_WINDOW_LABEL = 'chat-assistant';
export const CHAT_REFERENCE_PREVIEW_EVENT = 'chat:reference-preview-result';

/** 仅按需返回给独立窗口，不进入快照、补丁、消息或项目持久化。 */
export interface ChatReferencePreviewResponse {
  requestId: string;
  projectId: string | null;
  content: ReferencePreviewContent;
}

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
  /** 主窗口按配置投影的文本模型分组；仅含选择器元数据，不含厂商凭据或地址。 */
  assistantModelGroups: ModelGroup[];
  mediaModelOptions: MediaModelOption[];
  assistantModelId?: string;
  assistantImageModelId?: string;
  assistantVideoModelId?: string;
  mediaModelAvailability?: Record<string, boolean>;
  localFileGrants?: LocalFileGrantSummary[];
  imageDrafts?: ChatImageReference[];
  imagePreviewUrls?: Record<string, string>;
  /** 画布节点精简投影，供 @ 引用与调用详情渲染；不含提示词/坐标等正文 */
  nodes: Node<BaseNodeData>[];
  dramaAssets: DramaAssetLibrary;
  /** 仅供 Skill 选择器展示；不含正文、sourceId 或包内路径。 */
  skillOptions: SkillPickerOption[];
  mcpClientOptions?: McpClientOption[];
  /** 输入框草稿，独立窗口打开/收回时接力 */
  composerDraft: string;
  composerDrafts: Record<string, string>;
  panelView: ChatPanelView;
  /** 与节点共用的发送快捷键；缺省表示主窗口配置尚未完成加载。 */
  promptSubmitShortcut?: PromptSubmitShortcut;
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
  /** 新补丁按节点 ID 同步；fields.nodes 保留旧完整补丁的读取兼容。 */
  nodes?: ChatEntityPatch<Node<BaseNodeData>>;
  fields: Partial<{
    activeConversationId: string | null;
    projectId: string | null;
    projectName: string | null;
    generalModels: GeneralModelConfig[];
    assistantModelGroups: ModelGroup[];
    mediaModelOptions: MediaModelOption[];
    assistantModelId: string | null;
    assistantImageModelId: string | null;
    assistantVideoModelId: string | null;
    mediaModelAvailability: Record<string, boolean> | null;
    localFileGrants: LocalFileGrantSummary[] | null;
    imageDrafts: ChatImageReference[] | null;
    imagePreviewUrls: Record<string, string> | null;
    nodes: Node<BaseNodeData>[];
    dramaAssets: DramaAssetLibrary;
    skillOptions: SkillPickerOption[];
    mcpClientOptions: McpClientOption[];
    composerDraft: string;
    composerDrafts: Record<string, string>;
    panelView: ChatPanelView;
    promptSubmitShortcut: PromptSubmitShortcut | null;
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
  if (previous === next) return { upserted: [], removedIds: [] };
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
  if (!hasEntityPatchChanges(patch)) return current;
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
  setChangedField(fields, 'assistantModelGroups', previous.assistantModelGroups, next.assistantModelGroups);
  setChangedField(fields, 'mediaModelOptions', previous.mediaModelOptions, next.mediaModelOptions);
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
  setChangedField(fields, 'imageDrafts', previous.imageDrafts, next.imageDrafts);
  setChangedField(fields, 'imagePreviewUrls', previous.imagePreviewUrls, next.imagePreviewUrls);
  setChangedField(fields, 'dramaAssets', previous.dramaAssets, next.dramaAssets);
  setChangedField(fields, 'skillOptions', previous.skillOptions, next.skillOptions);
  setChangedField(fields, 'mcpClientOptions', previous.mcpClientOptions, next.mcpClientOptions);
  setChangedField(fields, 'composerDraft', previous.composerDraft, next.composerDraft);
  setChangedField(fields, 'composerDrafts', previous.composerDrafts, next.composerDrafts);
  setChangedField(fields, 'panelView', previous.panelView, next.panelView);
  setChangedField(fields, 'promptSubmitShortcut', previous.promptSubmitShortcut, next.promptSubmitShortcut);

  return {
    conversations: createEntityPatch(previous.conversations, next.conversations),
    messages: createEntityPatch(previous.messages, next.messages),
    agentTasks: createEntityPatch(previous.agentTasks, next.agentTasks),
    nodes: previous.nodes === next.nodes ? undefined : createEntityPatch(previous.nodes, next.nodes),
    fields,
  };
}

function hasEntityPatchChanges(patch: ChatEntityPatch<unknown>): boolean {
  return patch.upserted.length > 0 || patch.removedIds.length > 0 || patch.orderedIds !== undefined;
}

export function hasChatStatePatchChanges(patch: ChatStatePatch): boolean {
  return Object.keys(patch.fields).length > 0
    || [patch.conversations, patch.messages, patch.agentTasks].some(hasEntityPatchChanges)
    || (!!patch.nodes && hasEntityPatchChanges(patch.nodes));
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
    imageDrafts: fields.imageDrafts === null ? undefined : (fields.imageDrafts ?? current.imageDrafts),
    imagePreviewUrls: fields.imagePreviewUrls === null ? undefined : (fields.imagePreviewUrls ?? current.imagePreviewUrls),
    assistantModelGroups: fields.assistantModelGroups ?? current.assistantModelGroups,
    nodes: patch.nodes ? applyEntityPatch(current.nodes, patch.nodes) : (fields.nodes ?? current.nodes),
    dramaAssets: fields.dramaAssets ?? current.dramaAssets,
    skillOptions: fields.skillOptions ?? current.skillOptions,
    composerDraft: fields.composerDraft ?? current.composerDraft,
    promptSubmitShortcut: fields.promptSubmitShortcut === null
      ? undefined
      : (fields.promptSubmitShortcut ?? current.promptSubmitShortcut),
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
      imageFileNames?: string[];
      /** 首次发送由主窗口创建当前范围的会话。 */
      conversationId?: string;
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
  | { type: 'authorize_local_files'; conversationId?: string; draft?: string }
  | { type: 'set_mcp_connection'; conversationId?: string; scopeId: string; serverId: string; enabled: boolean; draft?: string }
  | { type: 'open_mcp_client_settings' }
  | { type: 'revoke_local_file'; conversationId: string; grantId: string }
  | { type: 'remove_image_attachment'; conversationId: string; fileName: string }
  | { type: 'select_model'; modelId?: string; category?: 'text' | 'image' | 'video' }
  | { type: 'focus_node'; nodeId: string }
  | { type: 'set_hovered_node'; nodeId: string | null }
  | { type: 'set_composer_draft'; draft: string; conversationId?: string | null }
  | { type: 'set_panel_view'; view: ChatPanelView }
  | { type: 'set_prompt_submit_shortcut'; shortcut: PromptSubmitShortcut }
  | { type: 'preview_reference'; requestId: string; projectId: string | null; source: ReferencePreviewSource }
  | { type: 'cancel_reference_preview'; requestId: string; projectId: string | null }
  | { type: 'dock_window'; composerDraft?: ChatComposerHandoff }
  | { type: 'confirm_commands'; messageId: string }
  | { type: 'cancel_commands'; messageId: string }
  | { type: 'request_sync' };

export interface ChatComposerHandoff {
  conversationId: string | null;
  draft: string;
}

export interface ChatWindowState {
  revision: number;
  snapshot: ChatStateSnapshot;
}

/** 旧帧直接忽略；补丁缺前帧时返回 null，让窗口重新请求完整快照。 */
export function receiveChatStateSync(current: ChatWindowState | null, sync: ChatStateSync): ChatWindowState | null {
  if (current && sync.revision <= current.revision) return current;
  if (sync.type === 'snapshot') return { revision: sync.revision, snapshot: sync.snapshot };
  if (!current || sync.baseRevision !== current.revision) return null;
  return { revision: sync.revision, snapshot: applyChatStatePatch(current.snapshot, sync.patch) };
}

// ============================================
// 主窗口：发送状态 + 接收 action
// ============================================

/**
 * 启动主窗口监听：接收来自独立窗口的 action。
 * 生命周期归调用方（同步控制器）管，这里不做模块级去重 —— StrictMode 下
 * 第二次挂载会被旧实例的标记挡掉，结果两边都没有监听器，独立窗口永远拿不到快照。
 */
export async function initMainWindowListener(
  onAction: (action: ChatAction) => void,
  onDetachClosed: (draft?: ChatComposerHandoff) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');

  const unlistenAction = await listen<ChatAction>(CHAT_ACTION_EVENT, (event) => {
    onAction(event.payload);
  });

  const unlistenClose = await listen<{ composerDraft?: ChatComposerHandoff }>(CHAT_CLOSE_REQUEST, (event) => {
    onDetachClosed(event.payload.composerDraft);
  });

  return () => {
    unlistenAction();
    unlistenClose();
  };
}

/** 主窗口广播首次快照或后续增量补丁（独立窗口 listen 此事件） */
export async function emitSyncState(sync: ChatStateSync): Promise<void> {
  const { emit } = await import('@tauri-apps/api/event');
  await emit(CHAT_SYNC_EVENT, sync);
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

/** 启动独立窗口监听：接收来自主窗口的状态同步（同样由调用方管生命周期） */
export async function initChatWindowListener(
  onSync: (sync: ChatStateSync) => void,
  onCloseRequest: () => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');

  const unlistenSync = await listen<ChatStateSync>(CHAT_SYNC_EVENT, (event) => {
    onSync(event.payload);
  });

  const unlistenClose = await listen(CHAT_CLOSE_EVENT, () => {
    onCloseRequest();
  });

  return () => {
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
export async function emitCloseRequest(composerDraft?: ChatComposerHandoff): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_CLOSE_REQUEST, { composerDraft });
  } catch { /* ignore */ }
}
