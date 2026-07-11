/**
 * Chat Slice — 对话助手状态管理
 * 管理聊天面板开关、会话列表、消息流、操作日志和 revision 计数
 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type {
  ChatConversation,
  ChatMessage,
  ChatMessageStatus,
  OperationLog,
} from '../types/chat';

// ============================================
// 常量
// ============================================

/** 批量操作默认上限 */
export const BATCH_NODE_LIMIT = 50;
/** 画布 revision 初始值 */
const INITIAL_REVISION = 0;

// ============================================
// Slice interface
// ============================================

export interface ChatSlice {
  // ── 面板状态 ──
  chatOpen: boolean;
  /** 聊天面板是否处于独立窗口模式 */
  chatPanelDetached: boolean;

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
  closeChat: () => void;
  toggleChat: () => void;
  setChatPanelDetached: (detached: boolean) => void;

  // ── Conversation Actions ──
  setConversations: (conversations: ChatConversation[]) => void;
  addConversation: (conversation: ChatConversation) => void;
  updateConversation: (id: string, partial: Partial<ChatConversation>) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  /** 在当前项目创建空会话 */
  createConversation: (projectId: string, title?: string) => string;

  // ── Message Actions ──
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, partial: Partial<ChatMessage>) => void;
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
// Slice implementation
// ============================================

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set, get) => ({
  // ── 面板初始状态 ──
  chatOpen: false,
  chatPanelDetached: false,

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

  openChat: () => set({ chatOpen: true }),
  closeChat: () => set({ chatOpen: false }),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setChatPanelDetached: (detached) => set({ chatPanelDetached: detached }),

  // ==========================================
  // Conversation Actions
  // ==========================================

  setConversations: (conversations) => set({ conversations }),

  addConversation: (conversation) =>
    set((s) => ({ conversations: [...s.conversations, conversation] })),

  updateConversation: (id, partial) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, ...partial, updatedAt: Date.now() } : c,
      ),
    })),

  removeConversation: (id) =>
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      // 如果删除的是活动会话，清除活动会话
      activeConversationId:
        s.activeConversationId === id ? null : s.activeConversationId,
    })),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  createConversation: (projectId, title) => {
    const id = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const conversation: ChatConversation = {
      id,
      projectId,
      title: title || '新对话',
      titleSource: title ? 'user' : 'auto',
      pinned: false,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    };
    set((s) => ({
      conversations: [...s.conversations, conversation],
      activeConversationId: id,
    }));
    return id;
  },

  // ==========================================
  // Message Actions
  // ==========================================

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((s) => {
      // 更新会话的消息计数和预览
      const convId = s.activeConversationId;
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
    }),

  updateMessage: (id, partial) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...partial } : m)),
    })),

  clearMessages: () =>
    set((s) => {
      const convId = s.activeConversationId;
      const conversations = convId
        ? s.conversations.map((c) =>
            c.id === convId
              ? { ...c, messageCount: 0, lastMessagePreview: undefined, updatedAt: Date.now() }
              : c,
          )
        : s.conversations;
      return { messages: [], conversations };
    }),

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
    set({
      canvasRevision: nextCanvas,
      globalCanvasRevision: nextGlobal,
    });
    return nextCanvas;
  },

  getCurrentRevision: () => {
    const state = get();
    const project = state.projects.find((p) => p.id === state.currentProjectId);
    if (project?.revisionScope === 'global') {
      return state.globalCanvasRevision;
    }
    return state.canvasRevision;
  },

  setCanvasRevision: (rev) => set({ canvasRevision: rev }),
  setGlobalCanvasRevision: (rev) => set({ globalCanvasRevision: rev }),
});
