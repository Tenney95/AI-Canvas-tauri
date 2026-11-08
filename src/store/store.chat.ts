/**
 * Chat Slice — 对话助手状态管理
 * 管理聊天面板开关、会话列表、消息流、操作日志和 revision 计数
 */
import { MCP_SETTINGS_CONVERSATION_ID } from '../services/mcp/mcpSettingsScope';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../services/chat/assistantScope';
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type {
  ChatConversation,
  ChatImageReference,
  ChatMessage,
  ChatPanelView,
  OperationLog,
} from '../types/chat';
import { AGENT_TERMINAL_STATUSES } from '../types/agent';
import { clearConversationFileGrants } from '../services/chat/fileGrantService';
import { stopConversationAgentTasks } from '../services/chat/agentTaskControl';
import { cancelPendingTeamInvocations } from '../services/chat/teams/teamInvocationService';
import * as chatHistoryService from '../services/chat/chatHistoryService';
import { seriesOwnerId } from './store.utils';
import type { AgentTeamProfile, AssistantExecutionSelection } from '../types/agentTeam';
import type { CreationProfileSelection } from '../types/creationProfile';
import { setConversationCreationProfileCAS } from '../services/indexedDbService';
import { captureCreationProfile } from '../services/creationProfiles/creationProfileService';
import { normalizeTeamProfile } from '../services/chat/teams/teamProfileService';
import { normalizeCreationProfileSelection } from '../services/creationProfiles/creationProfileManifest';
import { createConversationBranch } from '../services/chat/conversationBranchService';
import { normalizeConversationWorkbenchTarget } from '../services/chat/workbenchConversationScope';
import { readEpisodeWorkspaceScope } from '../services/episodeWorkspaceScope';

// ============================================
// 常量
// ============================================

/** 批量操作默认上限 */
export const BATCH_NODE_LIMIT = 50;
/** 画布 revision 初始值 */
const INITIAL_REVISION = 0;
/** 流式消息持续输出时的持久化节流间隔。 */
const STREAMING_MESSAGE_PERSIST_INTERVAL_MS = 500;
const ACTIVE_CONVERSATION_STORAGE_PREFIX = 'ai-canvas.chat.active-conversation';
const scheduledMessagePersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getActiveConversationStorageKey(projectId: string): string {
  return `${ACTIVE_CONVERSATION_STORAGE_PREFIX}:${projectId}`;
}

function readPersistedActiveConversation(projectId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(getActiveConversationStorageKey(projectId)) ?? null;
  } catch {
    return null;
  }
}

function persistActiveConversation(projectId: string, conversationId: string): void {
  try {
    globalThis.localStorage?.setItem(
      getActiveConversationStorageKey(projectId),
      conversationId,
    );
  } catch {
    // localStorage 不可用时退化为本次运行内的 Store 状态。
  }
}

function clearPersistedActiveConversation(projectId: string, conversationId: string): void {
  try {
    const key = getActiveConversationStorageKey(projectId);
    if (globalThis.localStorage?.getItem(key) === conversationId) {
      globalThis.localStorage.removeItem(key);
    }
  } catch {
    // 清理失败不影响会话删除流程。
  }
}

// ============================================
// Slice interface
// ============================================

export interface ChatSlice {
  // ── 面板状态 ──
  chatOpen: boolean;
  /** 聊天面板是否处于独立窗口模式 */
  chatPanelDetached: boolean;
  /** 从应用其他入口请求预填到聊天输入框的一次性草稿。 */
  chatComposerDraft: string | null;
  /** 输入框当前草稿，内嵌浮窗与独立窗口切换时接力用。 */
  chatComposerLiveDraft: string;
  /** 只在运行期间保存，换窗口和换会话都从这里接续。 */
  chatComposerDrafts: Record<string, string>;
  chatImageDrafts: Record<string, ChatImageReference[]>;
  addChatImageDraft: (conversationId: string, image: ChatImageReference) => void;
  removeChatImageDrafts: (conversationId: string, fileNames: string[]) => void;
  chatPanelView: ChatPanelView;

  // ── 会话状态 ──
  conversations: ChatConversation[];
  activeConversationId: string | null;

  // ── 消息状态 ──
  messages: ChatMessage[];
  /** 当前活动的 AI 请求 AbortController */
  activeRequestAbort: AbortController | null;
  /** 消息输入队列（同一会话内排队） */
  messageQueue: string[];

  // ── 操作日志 ──
  operationLogs: OperationLog[];

  // ── Revision 计数 ──
  /** 当前项目画布 revision，每次写操作 +1 */
  canvasRevision: number;
  /** 全局 revision 计数（revisionScope === 'global' 的项目使用） */
  globalCanvasRevision: number;

  // ── Panel Actions ──
  openChat: () => void;
  openChatWithDraft: (draft: string) => void;
  clearChatComposerDraft: () => void;
  closeChat: () => void;
  toggleChat: () => void;
  setChatPanelDetached: (detached: boolean) => void;
  setChatComposerLiveDraft: (draft: string, conversationId?: string | null) => void;
  setChatPanelView: (view: ChatPanelView) => void;

  // ── Conversation Actions ──
  setConversations: (conversations: ChatConversation[]) => void;
  addConversation: (conversation: ChatConversation) => void;
  updateConversation: (id: string, partial: Partial<ChatConversation>) => void;
  setConversationCreationProfile: (id: string, selection: CreationProfileSelection | undefined,
    patch?: { teamProfileOverride?: AgentTeamProfile; executionSelection?: AssistantExecutionSelection }) => Promise<void>;
  branchConversation: (conversationId: string, messageId: string) => Promise<string>;
  setConversationMcpServer: (id: string, serverId: string, enabled: boolean) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  /** 在当前项目创建空会话 */
  createConversation: (projectId: string, title?: string) => string;

  // ── 持久化 Actions ──
  /** 从 IndexedDB 加载当前项目的全部会话 */
  loadConversationsForProject: (projectId: string) => Promise<void>;
  /** 从 IndexedDB 加载指定会话的消息（替换当前 messages） */
  loadConversationMessages: (conversationId: string) => Promise<void>;
  /** 修复启动时遗留的中断消息 */
  repairInterruptedForProject: (projectId: string) => Promise<void>;

  // ── Message Actions ──
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, partial: Partial<ChatMessage>) => void;
  /** 更新流式展示状态，并按固定间隔持久化最新快照。 */
  updateMessageTransient: (id: string, partial: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  /** 设置活动 AbortController */
  setActiveRequestAbort: (ctrl: AbortController | null) => void;
  /** 消息队列入队 */
  enqueueMessage: (text: string) => void;
  /** 消息队列出队 */
  dequeueMessage: () => string | undefined;
  /** 清空消息队列 */
  clearMessageQueue: () => void;

  // ── Operation Log Actions ──
  addOperationLog: (log: OperationLog) => void;
  updateOperationLog: (id: string, partial: Partial<OperationLog>) => void;
  clearOperationLogs: () => void;

  // ── Revision Actions ──
  /** 画布写操作后调用，递增 revision */
  incrementRevision: () => number;
  /** 获取当前项目对应的 revision（根据 revisionScope） */
  getCurrentRevision: () => number;
  /** 设置 revision（项目切换/加载时使用） */
  setCanvasRevision: (rev: number) => void;
  setGlobalCanvasRevision: (rev: number) => void;
}

// ============================================
// 持久化 helper（fire-and-forget，不阻塞状态更新）
// ============================================

function persistConv(c: ChatConversation) {
  chatHistoryService.saveConversation(c).catch((e) =>
    console.warn('[chat.persist] 会话保存失败:', e),
  );
}

function persistMsg(m: ChatMessage, projectId: string) {
  chatHistoryService.persistMessage(m, projectId, m.conversationId).catch((e) =>
    console.warn('[chat.persist] 消息保存失败:', e),
  );
}

function retainBackgroundTaskMessages(state: AppState, targetConversationId?: string): ChatMessage[] {
  const activeConversationIds = new Set(
    state.agentTasks
      .filter((task) => !AGENT_TERMINAL_STATUSES.has(task.status))
      .map((task) => task.conversationId),
  );
  return state.messages.filter((message) =>
    message.conversationId !== targetConversationId
    && activeConversationIds.has(message.conversationId),
  );
}

function isConversationInCurrentChatScope(state: AppState, conversation: ChatConversation): boolean {
  const ownerId = seriesOwnerId(state.projects, state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
  return conversation.projectId === ownerId || conversation.id === MCP_SETTINGS_CONVERSATION_ID;
}

function resolveMessageProjectId(state: AppState, conversationId: string): string | null {
  return state.conversations.find((conversation) => conversation.id === conversationId)?.projectId
    ?? state.agentTasks.find((task) => task.conversationId === conversationId)?.projectId
    ?? state.currentProjectId;
}

function mergeMessage(
  messages: ChatMessage[],
  id: string,
  partial: Partial<ChatMessage>,
): { messages: ChatMessage[]; changed: ChatMessage } | null {
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) return null;
  const changed = { ...messages[index], ...partial };
  const updated = [...messages];
  updated[index] = changed;
  return { messages: updated, changed };
}

function cancelScheduledMessagePersist(id: string): void {
  const timer = scheduledMessagePersistTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  scheduledMessagePersistTimers.delete(id);
}

function persistMessageFromState(state: AppState, id: string): void {
  const message = state.messages.find((item) => item.id === id);
  if (!message) return;
  const projectId = resolveMessageProjectId(state, message.conversationId);
  if (projectId) persistMsg(message, projectId);
}

function scheduleMessagePersist(id: string, getState: () => AppState): void {
  if (scheduledMessagePersistTimers.has(id)) return;
  const timer = setTimeout(() => {
    scheduledMessagePersistTimers.delete(id);
    persistMessageFromState(getState(), id);
  }, STREAMING_MESSAGE_PERSIST_INTERVAL_MS);
  scheduledMessagePersistTimers.set(id, timer);
}

// ============================================
// Slice implementation
// ============================================

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set, get) => ({
  // ── 面板初始状态 ──
  chatOpen: false,
  chatPanelDetached: false,
  chatComposerDraft: null,
  chatComposerLiveDraft: '',
  chatComposerDrafts: {},
  chatImageDrafts: {},
  addChatImageDraft: (conversationId, image) => set((state) => ({
    chatImageDrafts: { ...state.chatImageDrafts, [conversationId]: [
      ...(state.chatImageDrafts[conversationId] ?? []).filter((item) => item.fileName !== image.fileName), image,
    ] },
  })),
  removeChatImageDrafts: (conversationId, fileNames) => set((state) => ({
    chatImageDrafts: { ...state.chatImageDrafts,
      [conversationId]: (state.chatImageDrafts[conversationId] ?? []).filter((item) => !fileNames.includes(item.fileName)) },
  })),
  chatPanelView: 'chat',

  // ── 会话初始状态 ──
  conversations: [],
  activeConversationId: null,

  // ── 消息初始状态 ──
  messages: [],
  activeRequestAbort: null,
  messageQueue: [],

  // ── 操作日志初始状态 ──
  operationLogs: [],

  // ── Revision 初始状态 ──
  canvasRevision: INITIAL_REVISION,
  globalCanvasRevision: INITIAL_REVISION,

  // ==========================================
  // Panel Actions
  // ==========================================

  openChat: () => set({
    chatOpen: true,
    settingsOpen: false,
    assetsPanelOpen: false,
    characterLibraryOpen: false,
    historyPanelOpen: false,
    dramaAssetsPanelOpen: false,
  }),
  openChatWithDraft: (draft) => {
    const state = get();
    if (state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.workbenchTarget) {
      state.createConversation(state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
    }
    set({
      chatOpen: true,
      chatPanelDetached: false,
      chatComposerDraft: draft,
      settingsOpen: false,
      assetsPanelOpen: false,
      characterLibraryOpen: false,
      historyPanelOpen: false,
      dramaAssetsPanelOpen: false,
    });
  },
  clearChatComposerDraft: () => set({ chatComposerDraft: null }),
  closeChat: () => set({ chatOpen: false }),
  toggleChat: () => set((s) => (s.chatOpen
    ? { chatOpen: false }
    : {
        chatOpen: true,
        settingsOpen: false,
        assetsPanelOpen: false,
        characterLibraryOpen: false,
        historyPanelOpen: false,
        dramaAssetsPanelOpen: false,
      })),
  setChatPanelDetached: (detached) => set({ chatPanelDetached: detached }),

  setChatComposerLiveDraft: (draft, conversationId = get().activeConversationId) => set((state) => {
    if (!conversationId) return { chatComposerLiveDraft: draft };
    if (!state.conversations.some((conversation) => conversation.id === conversationId)) return {};
    const drafts = { ...state.chatComposerDrafts };
    if (draft) drafts[conversationId] = draft;
    else delete drafts[conversationId];
    return {
      chatComposerDrafts: drafts,
      chatComposerLiveDraft: conversationId === state.activeConversationId ? draft : state.chatComposerLiveDraft,
    };
  }),
  setChatPanelView: (view) => set({ chatPanelView: view }),

  // ==========================================
  // Conversation Actions
  // ==========================================

  setConversations: (conversations) => set({ conversations: conversations.map((conversation) => ({ ...conversation,
    workbenchTarget: normalizeConversationWorkbenchTarget(conversation.workbenchTarget, conversation.projectId),
  })) }),
  setConversationMcpServer: (id, serverId, enabled) => {
    const state = get();
    const conversation = state.conversations.find((item) => item.id === id && !item.deletedAt && item.id.startsWith('conv-'));
    const connection = state.config.mcpClientConnections?.find((item) => item.id === serverId && item.enabled);
    const ownerId = seriesOwnerId(state.projects, state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
    if (!conversation || id !== state.activeConversationId || conversation.projectId !== ownerId
      || (enabled && (!connection || Object.keys(connection.tools).length === 0))) return;
    const selected = new Set(conversation.mcpServerIds ?? []);
    if (enabled) selected.add(serverId); else selected.delete(serverId);
    state.updateConversation(id, { mcpServerIds: [...selected], mcpSelectionRevision: crypto.randomUUID() });
  },

  addConversation: (conversation) => {
    const normalized = { ...conversation,
      workbenchTarget: normalizeConversationWorkbenchTarget(conversation.workbenchTarget, conversation.projectId) };
    set((s) => ({ conversations: [...s.conversations, normalized] }));
    persistConv(normalized);
  },

  updateConversation: (id, partial) =>
    set((s) => {
      const updated = s.conversations.map((c) => {
        if (c.id !== id) return c;
        const currentTarget = normalizeConversationWorkbenchTarget(c.workbenchTarget, c.projectId);
        const requestedTarget = normalizeConversationWorkbenchTarget(partial.workbenchTarget, c.projectId);
        if (currentTarget && requestedTarget && (currentTarget.seriesId !== requestedTarget.seriesId
          || currentTarget.episodeId !== requestedTarget.episodeId)) throw new Error('工作台会话不能更换目标分集');
        if (!currentTarget && requestedTarget) {
          const scope = readEpisodeWorkspaceScope(s, requestedTarget.episodeId);
          if (c.deletedAt || !scope || scope.owner.id !== requestedTarget.seriesId) throw new Error('工作台分集范围已变化');
        }
        return { ...c, ...partial, id: c.id, projectId: c.projectId,
          workbenchTarget: currentTarget ?? requestedTarget, updatedAt: Date.now() };
      });
      const changed = updated.find((c) => c.id === id);
      if (changed) persistConv(changed);
      return { conversations: updated };
    }),

  setConversationCreationProfile: async (id, selection, patch) => {
    const state = get();
    const conversation = state.conversations.find((entry) => entry.id === id);
    if (!conversation || conversation.deletedAt || !isConversationInCurrentChatScope(state, conversation)) throw new Error('会话已变化，请重新选择组合包');
    const normalized = normalizeCreationProfileSelection(selection);
    if (selection !== undefined && !normalized) throw new Error('组合包选择无效');
    const captured = await captureCreationProfile(normalized, state.currentProjectId ?? conversation.projectId);
    const latest = get();
    const currentConversation = latest.conversations.find((entry) => entry.id === id && !entry.deletedAt);
    if (latest.currentProjectId !== state.currentProjectId || !currentConversation
      || !isConversationInCurrentChatScope(latest, currentConversation)) throw new Error('组合包准备期间项目或会话已变化');
    const profileOverride = patch?.teamProfileOverride ? normalizeTeamProfile(patch.teamProfileOverride) : undefined;
    const executionSelection = patch?.executionSelection ?? (captured.profile?.teamTemplateId
      ? { kind: 'team' as const, templateId: captured.profile.teamTemplateId } : undefined);
    const saved = await setConversationCreationProfileCAS(id, conversation.creationProfile, normalized,
      { teamProfileOverride: profileOverride, executionSelection });
    set((current) => ({ conversations: current.conversations.map((entry) => entry.id === id ? { ...entry,
      creationProfile: saved.creationProfile, creationProfileRevision: saved.creationProfileRevision,
      teamProfileOverride: saved.teamProfileOverride, executionSelection: saved.executionSelection,
      updatedAt: Math.max(entry.updatedAt, saved.updatedAt),
    } : entry) }));
  },

  branchConversation: async (conversationId, messageId) => {
    const source = get().conversations.find((entry) => entry.id === conversationId);
    if (!source || !isConversationInCurrentChatScope(get(), source)) throw new Error('来源会话已变化');
    const branch = await createConversationBranch({ projectId: source.projectId, conversationId, messageId });
    if (isConversationInCurrentChatScope(get(), branch.conversation)) {
      set((state) => ({ conversations: [...state.conversations, branch.conversation], messages: [...state.messages, ...branch.messages] }));
      get().setActiveConversation(branch.conversation.id);
    }
    return branch.conversation.id;
  },

  removeConversation: (id) => {
    clearConversationFileGrants(id);
    cancelPendingTeamInvocations(id);
    // 停止该会话仍在后台运行的 Agent 任务，避免删除后继续产生副作用
    stopConversationAgentTasks(id);
    // 删除来源对话不删除已确认记忆，只标记来源不可用
    get().markConversationMemorySourceUnavailable(id);
    const removedConversation = get().conversations.find((conversation) => conversation.id === id);
    if (removedConversation) {
      clearPersistedActiveConversation(removedConversation.projectId, id);
    }
    set((s) => {
      const conv = s.conversations.find((c) => c.id === id);
      if (conv) {
        // 异步软删除（持久化到 IndexedDB）
        chatHistoryService.softDeleteConversation(conv).catch((e) =>
          console.warn('[chat] 软删除会话失败:', e),
        );
      }
      return {
        conversations: s.conversations.filter((c) => c.id !== id),
        chatComposerDrafts: Object.fromEntries(Object.entries(s.chatComposerDrafts).filter(([key]) => key !== id)),
        chatImageDrafts: Object.fromEntries(Object.entries(s.chatImageDrafts).filter(([key]) => key !== id)),
        chatComposerLiveDraft: s.activeConversationId === id ? '' : s.chatComposerLiveDraft,
        activeConversationId:
          s.activeConversationId === id ? null : s.activeConversationId,
      };
    });
  },

  setActiveConversation: (id) => {
    if (id) {
      const state = get();
      const conversation = state.conversations.find((item) => item.id === id);
      if (!conversation || !isConversationInCurrentChatScope(state, conversation)) return;
      persistActiveConversation(conversation.projectId, id);
    }
    set({ activeConversationId: id, chatComposerLiveDraft: id ? get().chatComposerDrafts[id] ?? '' : '' });
  },

  createConversation: (projectId, title) => {
    // 会话按剧集项目归属：同一部剧的分集共用会话，普通项目归自己（seriesOwnerId 对普通项目是恒等）
    const ownerId = seriesOwnerId(get().projects, projectId);
    const id = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const conversation: ChatConversation = {
      id,
      projectId: ownerId,
      title: title || '新对话',
      titleSource: title ? 'user' : 'auto',
      pinned: false,
      archived: false,
      agentMode: 'collaborative',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    set((s) => ({
      conversations: [...s.conversations, conversation],
      activeConversationId: id,
      chatComposerLiveDraft: '',
    }));
    persistActiveConversation(ownerId, id);
    persistConv(conversation);
    return id;
  },

  // ==========================================
  // 持久化 Actions
  // ==========================================

  loadConversationsForProject: async (projectId) => {
    if ((get().currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID) !== projectId) return;
    const ownerId = seriesOwnerId(get().projects, projectId);
    // 先切换展示作用域，再读取历史；慢读取或失败都不能把旧项目继续当作活动对话。
    set((state) => {
      const conversations = state.conversations.filter((conversation) => conversation.projectId === ownerId
        || conversation.id === MCP_SETTINGS_CONVERSATION_ID);
      const activeId = conversations.find((conversation) => conversation.id === state.activeConversationId)?.id ?? null;
      return {
        conversations,
        activeConversationId: activeId,
        chatComposerLiveDraft: activeId ? state.chatComposerLiveDraft
          : projectId === GENERAL_ASSISTANT_SCOPE_ID && !state.activeConversationId ? state.chatComposerLiveDraft : '',
        messages: [
          ...retainBackgroundTaskMessages(state, activeId ?? undefined),
          ...state.messages.filter((message) => message.conversationId === activeId),
        ],
        operationLogs: [],
      };
    });
    try {
      // 会话按剧集项目归属：分集共用剧集的会话（seriesOwnerId 对普通项目是恒等）
      const persistedConversations = await chatHistoryService.loadProjectConversations(ownerId);
      // 列表加载期间用户可能已新建或编辑会话，内存中的最新记录优先。
      const projectConversations = [...new Map([
        ...persistedConversations,
        ...get().conversations.filter((conversation) => conversation.projectId === ownerId),
      ].map((conversation) => [conversation.id, conversation])).values()];
      const settingsConversations = get().conversations.filter((conversation) => conversation.id === MCP_SETTINGS_CONVERSATION_ID);
      const conversations = [...settingsConversations, ...projectConversations];
      if ((get().currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID) !== projectId) return;
      const persistedId = readPersistedActiveConversation(ownerId);
      const settingsActive = get().activeConversationId === MCP_SETTINGS_CONVERSATION_ID;
      const hasUnboundDraft = projectId === GENERAL_ASSISTANT_SCOPE_ID
        && !get().activeConversationId && !!get().chatComposerLiveDraft;
      const restoredConversation = hasUnboundDraft ? undefined : ((settingsActive ? settingsConversations[0] : undefined)
        ?? projectConversations.find((conversation) => conversation.id === get().activeConversationId)
        ?? projectConversations.find((conversation) => conversation.id === persistedId) ?? projectConversations[0]);
      set((state) => ({
        conversations,
        activeConversationId: restoredConversation?.id ?? null,
        chatComposerLiveDraft: restoredConversation ? state.chatComposerDrafts[restoredConversation.id] ?? ''
          : projectId === GENERAL_ASSISTANT_SCOPE_ID ? state.chatComposerLiveDraft : '',
        messages: [
          ...retainBackgroundTaskMessages(state, restoredConversation?.id),
          ...state.messages.filter((message) => message.conversationId === restoredConversation?.id),
        ],
        operationLogs: [],
      }));
      if (restoredConversation) {
        if (!settingsActive) persistActiveConversation(ownerId, restoredConversation.id);
        await get().loadConversationMessages(restoredConversation.id);
      }
    } catch (e) {
      console.warn('[chat] 加载会话列表失败:', e);
    }
  },

  loadConversationMessages: async (conversationId) => {
    try {
      const { messages } = await chatHistoryService.loadMessages(conversationId, 0, 200);
      // 只保留当前展示的 conversationId 的消息（时序上切换后仍然可能收到旧异步结果）
      const current = get();
      const conversation = current.conversations.find((item) => item.id === conversationId);
      if (current.activeConversationId !== conversationId || !conversation
        || !isConversationInCurrentChatScope(current, conversation)) return;
      set((state) => ({
        messages: [
          ...retainBackgroundTaskMessages(state, conversationId),
          ...[...new Map([
            ...messages,
            ...state.messages.filter((message) => message.conversationId === conversationId),
          ].map((message) => [message.id, message])).values()].sort((a, b) => a.timestamp - b.timestamp),
        ],
      }));
      const { projectNativeMediaMessages } = await import('../services/nativeMediaMessages');
      await projectNativeMediaMessages(conversationId);
    } catch (e) {
      console.warn('[chat] 加载消息失败:', e);
    }
  },

  repairInterruptedForProject: async (projectId) => {
    try {
      const affectedIds = await chatHistoryService.repairInterruptedMessages(projectId);
      if (affectedIds.length > 0) {
        console.log('[chat] 已修复中断消息，涉及会话:', affectedIds);
      }
    } catch (e) {
      console.warn('[chat] 修复中断消息失败:', e);
    }
  },

  // ==========================================
  // Message Actions
  // ==========================================

  setMessages: (messages) => set({ messages }),

  addMessage: (message) => {
    set((s) => {
      const convId = message.conversationId;
      const conversations = convId
        ? s.conversations.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messageCount: c.messageCount + 1,
                  lastMessageAt: message.timestamp,
                  lastMessagePreview:
                    message.content.slice(0, 60) + (message.content.length > 60 ? '…' : ''),
                  updatedAt: Date.now(),
                }
              : c,
          )
        : s.conversations;
      return {
        messages: [...s.messages, message],
        conversations,
      };
    });
    const projectId = resolveMessageProjectId(get(), message.conversationId);
    if (projectId) persistMsg(message, projectId);
  },

  updateMessage: (id, partial) => {
    cancelScheduledMessagePersist(id);
    let changed: ChatMessage | undefined;
    set((s) => {
      const result = mergeMessage(s.messages, id, partial);
      if (!result) return s;
      changed = result.changed;
      return { messages: result.messages };
    });
    if (changed) {
      const projectId = resolveMessageProjectId(get(), changed.conversationId);
      if (projectId) persistMsg(changed, projectId);
    }
  },

  updateMessageTransient: (id, partial) => {
    let changed = false;
    set((s) => {
      const result = mergeMessage(s.messages, id, partial);
      if (!result) return s;
      changed = true;
      return { messages: result.messages };
    });
    if (changed) scheduleMessagePersist(id, get);
  },

  clearMessages: () => {
    const convId = get().activeConversationId;
    if (convId) {
      cancelPendingTeamInvocations(convId);
      stopConversationAgentTasks(convId);
    }
    set((s) => {
      if (convId) {
        chatHistoryService.clearConversationMessages(convId).catch((e) =>
          console.warn('[chat] 清空消息失败:', e),
        );
      }
      const conversations = convId
        ? s.conversations.map((c) =>
            c.id === convId
              ? { ...c, messageCount: 0, lastMessagePreview: undefined, updatedAt: Date.now() }
              : c,
          )
        : s.conversations;
      return { messages: [], conversations };
    });
  },

  setActiveRequestAbort: (ctrl) => set({ activeRequestAbort: ctrl }),

  enqueueMessage: (text) =>
    set((s) => ({ messageQueue: [...s.messageQueue, text] })),

  dequeueMessage: () => {
    const state = get();
    if (state.messageQueue.length === 0) return undefined;
    const [head, ...tail] = state.messageQueue;
    set({ messageQueue: tail });
    return head;
  },

  clearMessageQueue: () => set({ messageQueue: [] }),

  // ==========================================
  // Operation Log Actions
  // ==========================================

  addOperationLog: (log) =>
    set((s) => ({ operationLogs: [...s.operationLogs, log] })),

  updateOperationLog: (id, partial) =>
    set((s) => ({
      operationLogs: s.operationLogs.map((l) =>
        l.id === id ? { ...l, ...partial } : l,
      ),
    })),

  clearOperationLogs: () => set({ operationLogs: [] }),

  // ==========================================
  // Revision Actions
  // ==========================================

  incrementRevision: () => {
    const state = get();
    const nextCanvas = state.canvasRevision + 1;
    const nextGlobal = state.globalCanvasRevision + 1;
    const context = state.projectExecutionContext;
    const project = state.projects.find((item) => item.id === state.currentProjectId);
    set({
      canvasRevision: nextCanvas,
      globalCanvasRevision: nextGlobal,
      ...(context?.kind === 'canvas' && context.canvasId === state.currentProjectId
        ? { projectExecutionContext: { ...context, canvasRevision: project?.revisionScope === 'global' ? nextGlobal : nextCanvas } }
        : {}),
    });
    return nextCanvas;
  },

  getCurrentRevision: () => {
    const state = get();
    const project = state.projects.find((p: { id: string }) => p.id === state.currentProjectId);
    if (project?.revisionScope === 'global') {
      return state.globalCanvasRevision;
    }
    return state.canvasRevision;
  },

  setCanvasRevision: (rev) => set((state) => {
    const context = state.projectExecutionContext;
    const project = state.projects.find((item) => item.id === state.currentProjectId);
    return { canvasRevision: rev, ...(context?.kind === 'canvas' && context.canvasId === state.currentProjectId
      && project?.revisionScope !== 'global' ? { projectExecutionContext: { ...context, canvasRevision: rev } } : {}) };
  }),
  setGlobalCanvasRevision: (rev) => set((state) => {
    const context = state.projectExecutionContext;
    const project = state.projects.find((item) => item.id === state.currentProjectId);
    return { globalCanvasRevision: rev, ...(context?.kind === 'canvas' && context.canvasId === state.currentProjectId
      && project?.revisionScope === 'global' ? { projectExecutionContext: { ...context, canvasRevision: rev } } : {}) };
  }),
});
