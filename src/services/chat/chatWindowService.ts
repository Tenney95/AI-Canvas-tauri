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
  AgentTaskFocusRequest,
} from '../../types/agent';
import type { LocalFileGrantSummary } from './fileGrantService';
import type { McpClientOption } from '../../types/mcpClient';
import type { AgentTeamProfile, AssistantExecutionSelection, TeamGraphDefinition } from '../../types/agentTeam';
import type { CreationProfileOption, CreationProfileSelection } from '../../types/creationProfile';
import type { ExternalAgentDescriptor } from '../../types/externalAgent';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../types/referencePreview';
import type { ProjectWindowFrame } from '../../types/projectWindow';

export const CHAT_SYNC_EVENT = 'chat:sync-state';
export const CHAT_ACTION_EVENT = 'chat:action';
export const CHAT_CLOSE_REQUEST = 'chat:close-request';
export const CHAT_CLOSE_EVENT = 'chat:close';
const CHAT_CLOSE_ACK_EVENT = 'chat:close-ack';
const CHAT_CLOSE_FAILED_EVENT = 'chat:close-failed';
/** 原生窗口 label 由 lib.rs 的 open_chat_window 固定创建。 */
export const CHAT_MAIN_WINDOW_LABEL = 'main';
export const CHAT_DETACHED_WINDOW_LABEL = 'chat-assistant';
export const CHAT_REFERENCE_PREVIEW_EVENT = 'chat:reference-preview-result';
export const CHAT_TEAM_ARTIFACT_EVENT = 'chat:team-artifact-result';
export const CHAT_MANAGED_RESPONSE_EVENT = 'chat:managed-result';
let mainWindowSessionId: string | undefined;
let mainWindowRevision = 0;
const sessionListeners = new Set<() => void>();
const pendingCloses = new Map<string, Promise<void>>();
const closedSessions = new Set<string>();
const closeListeners = new Set<(sessionId: string, closing: Promise<void>) => void>();
/** 只由主窗口真实创建入口分配；子窗口握手不能产生新的写授权。 */
export function beginChatWindowSession(): string {
  mainWindowSessionId = crypto.randomUUID();
  for (const listener of sessionListeners) listener();
  return mainWindowSessionId;
}
export function getMainChatWindowSessionId(): string | undefined { return mainWindowSessionId; }
export function endChatWindowSession(sessionId: string | undefined): void {
  if (!sessionId || sessionId !== mainWindowSessionId) return;
  mainWindowSessionId = undefined;
  for (const listener of sessionListeners) listener();
}
export function subscribeChatWindowSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}

/** 草稿交接成功后，由主窗口按真实 session 完成销毁；成功才撤销会话。 */
export function finishChatWindowClose(sessionId: string): Promise<void> {
  const pending = pendingCloses.get(sessionId);
  if (pending) return pending;
  if (closedSessions.has(sessionId)) return Promise.resolve();
  if (!sessionId || sessionId !== mainWindowSessionId) return Promise.reject(new Error('独立窗口会话已变化，已保留窗口'));
  const closing = Promise.resolve().then(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('close_chat_window', { sessionId });
    closedSessions.add(sessionId);
    if (closedSessions.size > 32) closedSessions.delete(closedSessions.values().next().value!);
    endChatWindowSession(sessionId);
  }).finally(() => { pendingCloses.delete(sessionId); });
  pendingCloses.set(sessionId, closing);
  for (const listener of closeListeners) listener(sessionId, closing);
  return closing;
}

export async function waitForChatWindowClose(): Promise<void> { await Promise.all(pendingCloses.values()); }

export async function emitChatCloseFailure(sessionId: string): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(CHAT_DETACHED_WINDOW_LABEL, CHAT_CLOSE_FAILED_EVENT, { sessionId });
}
export function nextChatWindowRevision(): number { return ++mainWindowRevision; }
export function getChatClientSessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const sessionId = new URLSearchParams(window.location.search).get('session') ?? '';
  return /^[A-Za-z0-9_-]{8,160}$/.test(sessionId) ? sessionId : undefined;
}
export const CHAT_SEND_RESPONSE_EVENT = 'chat:send-result';
interface ChatSendResponse { requestId: string; sessionId?: string; accepted: boolean }

export type ChatManagedOperation =
  | { kind: 'preview_creation_profile'; profile: CreationProfileOption }
  | { kind: 'apply_creation_profile'; selection: CreationProfileSelection | null }
  | { kind: 'save_team_profile'; profile: AgentTeamProfile }
  | { kind: 'refresh_external_agents' }
  | { kind: 'edit_team_graph'; taskId: string; graph: TeamGraphDefinition; expected: { revision: number; boardRevision: number } }
  | { kind: 'resolve_dispatch'; taskId: string; dispatchId: string; decision: 'verified_completed' | 'abandoned' }
  | { kind: 'branch_conversation'; messageId: string }
  | { kind: 'team_result'; taskId: string; action: 'apply' | 'restore' | 'reconcile' }
  | { kind: 'amend_team_task'; taskId: string; instruction: string };
export interface ChatManagedResponse { requestId: string; sessionId?: string; scopeId: string; conversationId?: string; value?: unknown; error?: string }

export interface ChatTeamArtifactResponse {
  requestId: string;
  sessionId?: string;
  taskId: string;
  artifactId: string;
  text?: string;
  error?: string;
}

/** 仅按需返回给独立窗口，不进入快照、补丁、消息或项目持久化。 */
export interface ChatReferencePreviewResponse {
  requestId: string;
  sessionId?: string;
  projectId: string | null;
  content: ReferencePreviewContent;
}

// ============================================
// 状态快照（主窗口 → 独立窗口）
// ============================================

export interface ChatStateSnapshot {
  /** 仅用于窗口协议；旧只读快照可展示，缺少此帧的写请求失败关闭。 */
  windowFrame?: ProjectWindowFrame | null;
  conversations: ChatConversation[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  agentTasks: AgentTask[];
  agentTaskFocus?: AgentTaskFocusRequest | null;
  projectId: string | null;
  projectName?: string;
  isEpisodeProject?: boolean;
  generalModels: GeneralModelConfig[];
  /** 主窗口按配置投影的文本模型分组；仅含选择器元数据，不含厂商凭据或地址。 */
  assistantModelGroups: ModelGroup[];
  mediaModelOptions: MediaModelOption[];
  assistantModelId?: string;
  agentTeamProfile?: AgentTeamProfile;
  creationProfiles?: CreationProfileOption[];
  externalAgents?: ExternalAgentDescriptor[];
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
    windowFrame: ProjectWindowFrame | null;
    activeConversationId: string | null;
    agentTaskFocus: AgentTaskFocusRequest | null;
    projectId: string | null;
    projectName: string | null;
    isEpisodeProject: boolean;
    generalModels: GeneralModelConfig[];
    assistantModelGroups: ModelGroup[];
    mediaModelOptions: MediaModelOption[];
    assistantModelId: string | null;
    agentTeamProfile: AgentTeamProfile | null;
    creationProfiles: CreationProfileOption[] | null;
    externalAgents: ExternalAgentDescriptor[] | null;
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
  | { type: 'snapshot'; sessionId?: string; acceptedSequence?: number; revision: number; snapshot: ChatStateSnapshot }
  | {
      type: 'patch';
      sessionId?: string;
      acceptedSequence?: number;
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
  setChangedField(fields, 'windowFrame', previous.windowFrame, next.windowFrame);
  setChangedField(fields, 'activeConversationId', previous.activeConversationId, next.activeConversationId);
  setChangedField(fields, 'agentTaskFocus', previous.agentTaskFocus, next.agentTaskFocus);
  setChangedField(fields, 'projectId', previous.projectId, next.projectId);
  setChangedField(fields, 'projectName', previous.projectName, next.projectName);
  setChangedField(fields, 'isEpisodeProject', previous.isEpisodeProject, next.isEpisodeProject);
  setChangedField(fields, 'generalModels', previous.generalModels, next.generalModels);
  setChangedField(fields, 'assistantModelGroups', previous.assistantModelGroups, next.assistantModelGroups);
  setChangedField(fields, 'mediaModelOptions', previous.mediaModelOptions, next.mediaModelOptions);
  setChangedField(fields, 'assistantModelId', previous.assistantModelId, next.assistantModelId);
  setChangedField(fields, 'agentTeamProfile', previous.agentTeamProfile, next.agentTeamProfile);
  setChangedField(fields, 'creationProfiles', previous.creationProfiles, next.creationProfiles);
  setChangedField(fields, 'externalAgents', previous.externalAgents, next.externalAgents);
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
    agentTeamProfile: fields.agentTeamProfile === null ? undefined : (fields.agentTeamProfile ?? current.agentTeamProfile),
    creationProfiles: fields.creationProfiles === null ? undefined : (fields.creationProfiles ?? current.creationProfiles),
    externalAgents: fields.externalAgents === null ? undefined : (fields.externalAgents ?? current.externalAgents),
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

export type ChatAction = (
  | { type: 'managed_request'; requestId: string; scopeId: string; conversationId?: string; draft?: string; operation: ChatManagedOperation }
  | {
      type: 'send_message';
      content: string;
      imageFileNames?: string[];
      /** 首次发送由主窗口创建当前范围的会话。 */
      conversationId?: string;
      dispatchMode?: 'queue' | 'interject';
      executionSelection?: AssistantExecutionSelection;
      requestId?: string;
    }
  | { type: 'switch_conversation'; conversationId: string }
  | { type: 'create_conversation'; projectId: string; title?: string }
  | { type: 'rename_conversation'; conversationId: string; title: string }
  | { type: 'toggle_pin'; conversationId: string }
  | { type: 'archive_conversation'; conversationId: string }
  | { type: 'delete_conversation'; conversationId: string }
  | { type: 'set_agent_mode'; conversationId: string; mode: AgentMode }
  | { type: 'set_execution_selection'; scopeId: string; conversationId?: string; selection: AssistantExecutionSelection; draft?: string }
  | { type: 'set_team_profile'; profile: AgentTeamProfile }
  | { type: 'read_team_artifact'; requestId: string; taskId: string; artifactId: string }
  | { type: 'apply_team_result'; taskId: string }
  | { type: 'restore_team_result'; taskId: string }
  | { type: 'reconcile_team_result'; taskId: string }
  | { type: 'amend_team_task'; taskId: string; instruction: string }
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
  | { type: 'mark_skill_used'; skillId: string }
  | { type: 'set_panel_view'; view: ChatPanelView }
  | { type: 'set_prompt_submit_shortcut'; shortcut: PromptSubmitShortcut }
  | { type: 'preview_reference'; requestId: string; projectId: string | null; source: ReferencePreviewSource }
  | { type: 'cancel_reference_preview'; requestId: string; projectId: string | null }
  | { type: 'dock_window' | 'close_window'; requestId?: string; sessionId?: string; composerDraft?: ChatComposerHandoff }
  | { type: 'confirm_commands'; messageId: string }
  | { type: 'cancel_commands'; messageId: string }
  | { type: 'request_sync'; sessionId?: string }) & { windowFrame?: ProjectWindowFrame; sequence?: number };

export interface ChatComposerHandoff {
  conversationId: string | null;
  draft: string;
  windowFrame?: ProjectWindowFrame;
}

export interface ChatWindowState {
  sessionId?: string;
  revision: number;
  snapshot: ChatStateSnapshot;
}

/** 旧帧直接忽略；补丁缺前帧时返回 null，让窗口重新请求完整快照。 */
export function receiveChatStateSync(current: ChatWindowState | null, sync: ChatStateSync): ChatWindowState | null {
  const frame = sync.type === 'snapshot' ? sync.snapshot.windowFrame : sync.patch.fields.windowFrame;
  const sessionId = sync.sessionId ?? frame?.sessionId;
  if (frame && sync.sessionId && frame.sessionId !== sync.sessionId) return null;
  const currentSessionId = current?.sessionId ?? current?.snapshot.windowFrame?.sessionId;
  if (currentSessionId && sessionId && currentSessionId !== sessionId) return current;
  if (frame && (frame.schemaVersion !== 2 || frame.revision !== sync.revision)) return null;
  if (current && sync.revision <= current.revision) return current;
  if (sync.type === 'snapshot') return { sessionId, revision: sync.revision, snapshot: sync.snapshot };
  if (!current || sync.baseRevision !== current.revision) return null;
  return { sessionId: sessionId ?? current.sessionId, revision: sync.revision, snapshot: applyChatStatePatch(current.snapshot, sync.patch) };
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
  onDetachClosed: (draft?: ChatComposerHandoff, sessionId?: string) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');

  const unlistenAction = await listen<ChatAction>(CHAT_ACTION_EVENT, (event) => {
    onAction(event.payload);
  });

  const unlistenClose = await listen<{ composerDraft?: ChatComposerHandoff; sessionId?: string }>(CHAT_CLOSE_REQUEST, (event) => {
    onDetachClosed(event.payload.composerDraft, event.payload.sessionId);
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
export async function emitCloseChatWindow(expectedSessionId?: string): Promise<void> {
  const sessionId = expectedSessionId ?? mainWindowSessionId;
  const { waitForChatWindowOpen } = await import('./chatWindowLifecycle');
  const opening = waitForChatWindowOpen();
  // 创建期间标签可能尚未注册；打开报错后仍需查询真实窗口，不能据此撤销会话。
  if (opening) await opening.catch(() => undefined);
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  // 关闭子窗保留 detached 展示偏好；窗口已经不存在时没有待交接输入。
  if (!await WebviewWindow.getByLabel(CHAT_DETACHED_WINDOW_LABEL)) {
    if (mainWindowSessionId && mainWindowSessionId !== sessionId) throw new Error('独立窗口已重新打开，请核对新窗口中的草稿');
    endChatWindowSession(sessionId);
    return;
  }
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const requestId = crypto.randomUUID();
  if (!sessionId || (mainWindowSessionId !== sessionId && !closedSessions.has(sessionId))
    || mainWindowSessionId && mainWindowSessionId !== sessionId) {
    throw new Error('独立窗口会话已失效，请核对窗口中的草稿');
  }
  const pending = pendingCloses.get(sessionId);
  if (pending) { await pending; return; }
  await new Promise<void>((resolve, reject) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const onClosing = (closingSession: string, closing: Promise<void>) => {
      if (settled || closingSession !== sessionId) return;
      settled = true; clearTimeout(timer); stop?.(); closeListeners.delete(onClosing);
      void closing.then(resolve, reject);
    };
    closeListeners.add(onClosing);
    const timer = setTimeout(() => { settled = true; stop?.(); closeListeners.delete(onClosing); reject(new Error('独立窗口尚未确认草稿交接，已保留窗口')); }, 30000);
    void listen<{ requestId: string; sessionId?: string; accepted: boolean }>(CHAT_CLOSE_ACK_EVENT, ({ payload }) => {
      if (settled || payload.requestId !== requestId || payload.sessionId !== sessionId) return;
      settled = true; clearTimeout(timer); stop?.(); closeListeners.delete(onClosing);
      if (mainWindowSessionId && mainWindowSessionId !== sessionId) { reject(new Error('独立窗口已重新打开，请核对新窗口中的草稿')); return; }
      if (payload.accepted) resolve(); else reject(new Error('窗口上下文已变化，草稿仍保留在独立窗口'));
    }).then(async (dispose) => {
      stop = dispose;
      if (settled) { dispose(); return; }
      if (mainWindowSessionId !== sessionId) {
        if (!mainWindowSessionId && closedSessions.has(sessionId)) {
          settled = true; clearTimeout(timer); dispose(); closeListeners.delete(onClosing); resolve(); return;
        }
        throw new Error('独立窗口已重新打开，请核对新窗口中的草稿');
      }
      await emitTo(CHAT_DETACHED_WINDOW_LABEL, CHAT_CLOSE_EVENT, { requestId, sessionId });
    })
      .catch((error: unknown) => { settled = true; clearTimeout(timer); stop?.(); closeListeners.delete(onClosing); reject(error); });
  });
  if (mainWindowSessionId && mainWindowSessionId !== sessionId) throw new Error('独立窗口已重新打开，请核对新窗口中的草稿');
  await finishChatWindowClose(sessionId);
}

// ============================================
// 独立窗口：接收状态 + 发送 action
// ============================================

/** 启动独立窗口监听：接收来自主窗口的状态同步（同样由调用方管生命周期） */
export async function initChatWindowListener(
  onSync: (sync: ChatStateSync) => void,
  onCloseRequest: (requestId?: string) => void,
  onCloseFailure?: () => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const sessionId = getChatClientSessionId();

  const unlistenSync = await listen<ChatStateSync>(CHAT_SYNC_EVENT, (event) => {
    if (!sessionId || event.payload.sessionId !== sessionId) return;
    const frame = event.payload.type === 'snapshot' ? event.payload.snapshot.windowFrame : event.payload.patch.fields.windowFrame;
    if (frame && frame.sessionId !== sessionId) return;
    // 同一真实窗口刷新/重连沿用 nonce，从宿主已接受的序号继续；request_sync 本身不重置授权。
    if (Number.isSafeInteger(event.payload.acceptedSequence) && event.payload.acceptedSequence! >= 0) {
      clientSequence = Math.max(clientSequence, event.payload.acceptedSequence!);
    }
    onSync(event.payload);
  });

  const unlistenClose = await listen<{ requestId?: string; sessionId?: string }>(CHAT_CLOSE_EVENT, ({ payload }) => {
    const currentSession = sessionId;
    if (!currentSession || payload?.sessionId !== currentSession) {
      if (payload?.requestId) void emitChatCloseAcknowledgement(payload.requestId, false).catch(() => {});
      return;
    }
    onCloseRequest(payload?.requestId);
  });
  const unlistenFailure = await listen<{ sessionId?: string }>(CHAT_CLOSE_FAILED_EVENT, ({ payload }) => {
    if (sessionId && payload?.sessionId === sessionId) onCloseFailure?.();
  });

  return () => {
    unlistenSync();
    unlistenClose();
    unlistenFailure();
  };
}

/** 独立窗口发送 action 到主窗口 */
let clientSequence = 0;
let readOnlyWindowFrame: ProjectWindowFrame | null = null;
/** 只供无业务写入的引用预览捕获当前帧；写动作必须由原视图显式传入帧。 */
export function setChatReferenceWindowFrame(frame: ProjectWindowFrame | null): void { readOnlyWindowFrame = frame; }
export function getChatReferenceWindowFrame(): ProjectWindowFrame | null { return readOnlyWindowFrame; }
export async function emitAction(action: ChatAction, windowFrame?: ProjectWindowFrame | null): Promise<void> {
  try {
    const { emitTo } = await import('@tauri-apps/api/event');
    await emitTo(CHAT_MAIN_WINDOW_LABEL, CHAT_ACTION_EVENT, { ...action, windowFrame: windowFrame ?? action.windowFrame,
      ...(action.type === 'request_sync' ? { sessionId: getChatClientSessionId() } : {}),
      sequence: ++clientSequence });
  } catch {
    console.warn('[chatWindow] failed to emit action');
  }
}

/** 发送成功由主窗口确认；拒绝、超时或断线均保留原输入，不自动重投。 */
export async function requestChatMessage(action: Extract<ChatAction, { type: 'send_message' | 'dock_window' | 'close_window' }>, windowFrame?: ProjectWindowFrame | null): Promise<boolean> {
  const { listen } = await import('@tauri-apps/api/event');
  const requestId = action.requestId ?? crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const finish = (accepted: boolean) => { if (settled) return; settled = true; clearTimeout(timer); stop?.(); resolve(accepted); };
    const timer = setTimeout(() => finish(false), 30000);
    void listen<ChatSendResponse>(CHAT_SEND_RESPONSE_EVENT, ({ payload }) => {
      const sessionId = (windowFrame ?? action.windowFrame)?.sessionId ?? ('sessionId' in action ? action.sessionId : undefined);
      if (payload.requestId === requestId && payload.sessionId === sessionId) finish(payload.accepted === true);
    }).then(async (dispose) => {
      stop = dispose;
      if (settled) { dispose(); return; }
      await emitAction({ ...action, requestId }, windowFrame);
    }).catch(() => finish(false));
  });
}

export async function emitChatCloseAcknowledgement(requestId: string, accepted: boolean): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(CHAT_MAIN_WINDOW_LABEL, CHAT_CLOSE_ACK_EVENT, { requestId, sessionId: getChatClientSessionId(), accepted });
}

export async function emitChatSendResponse(requestId: string | undefined, accepted: boolean, sessionId?: string): Promise<void> {
  if (!requestId) return;
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(CHAT_DETACHED_WINDOW_LABEL, CHAT_SEND_RESPONSE_EVENT, { requestId, sessionId, accepted } satisfies ChatSendResponse);
}

/** 独立助手只请求主窗口已登记产物，不接收文件路径或直接读取项目目录。 */
export async function requestTeamArtifactText(taskId: string, artifactId: string, windowFrame?: ProjectWindowFrame | null): Promise<string> {
  if (!taskId || !artifactId || taskId.length > 160 || artifactId.length > 160) throw new Error('团队产物身份无效');
  const { emit, listen } = await import('@tauri-apps/api/event');
  const requestId = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (text?: string, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      if (error) reject(new Error(error)); else resolve(text ?? '');
    };
    const timer = setTimeout(() => finish(undefined, '主窗口未返回团队成果，请回到主窗口核对后重试'), 20000);
    void (async () => {
      unlisten = await listen<ChatTeamArtifactResponse>(CHAT_TEAM_ARTIFACT_EVENT, (event) => {
        const response = event.payload;
        if (response.requestId !== requestId || response.sessionId !== windowFrame?.sessionId
          || response.taskId !== taskId || response.artifactId !== artifactId) return;
        if (typeof response.text === 'string' && response.text.length > 120000) {
          finish(undefined, '产物超过窗口预览上限，请在主窗口查看');
        } else finish(response.text, response.error);
      });
      if (settled) { unlisten(); return; }
      await emit(CHAT_ACTION_EVENT, { type: 'read_team_artifact', requestId, taskId, artifactId,
        windowFrame: windowFrame ?? undefined, sequence: ++clientSequence } satisfies ChatAction);
    })().catch(() => finish(undefined, '无法连接主窗口读取团队成果'));
  });
}

export async function emitTeamArtifactResponse(response: ChatTeamArtifactResponse): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(CHAT_DETACHED_WINDOW_LABEL, CHAT_TEAM_ARTIFACT_EVENT, response);
}

/** 保存成功必须等主窗口 ack；超时仅报未知，不自动重投。 */
export async function requestManagedChatOperation<T = unknown>(scopeId: string, conversationId: string | undefined,
  operation: ChatManagedOperation, draft?: string, windowFrame?: ProjectWindowFrame | null): Promise<T> {
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  const requestId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (response?: ChatManagedResponse, error?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); unlisten?.();
      if (error || response?.error) reject(new Error(error ?? response!.error)); else resolve(response?.value as T);
    };
    const timer = setTimeout(() => finish(undefined, '主窗口尚未确认操作结果，请核对最新状态；未自动重试'), 30000);
    void (async () => {
      unlisten = await listen<ChatManagedResponse>(CHAT_MANAGED_RESPONSE_EVENT, ({ payload }) => {
        if (payload?.requestId !== requestId || payload.sessionId !== windowFrame?.sessionId
          || payload.scopeId !== scopeId || payload.conversationId !== conversationId) return;
        finish(payload);
      });
      if (settled) { unlisten(); return; }
      await emitTo(CHAT_MAIN_WINDOW_LABEL, CHAT_ACTION_EVENT,
        { type: 'managed_request', requestId, scopeId, conversationId, operation, draft,
          windowFrame: windowFrame ?? undefined, sequence: ++clientSequence } satisfies ChatAction);
    })().catch(() => finish(undefined, '无法连接主窗口；未自动重试'));
  });
}

export async function emitManagedChatResponse(response: ChatManagedResponse): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo(CHAT_DETACHED_WINDOW_LABEL, CHAT_MANAGED_RESPONSE_EVENT, response);
}

/** 独立窗口通知主窗口：即将关闭 */
export async function emitCloseRequest(composerDraft?: ChatComposerHandoff): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_CLOSE_REQUEST, { composerDraft, sessionId: getChatClientSessionId() });
  } catch { /* ignore */ }
}
