/**
 * chatWindowService — 独立窗口通信服务
 *
 * 使用 Tauri 事件系统（emit/listen）在主窗口和独立对话窗口之间同步状态。
 * emit 广播到所有窗口（含自身），每个窗口只 listen 自己关心的事件。
 *
 * 通信协议：
 * - Main emits  → Chat listens: `chat:sync-state`  完整状态同步
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
  projectId: string | null;
  projectName?: string;
}

// ============================================
// 用户操作（独立窗口 → 主窗口）
// ============================================

export type ChatAction =
  | { type: 'send_message'; content: string; conversationId: string }
  | { type: 'switch_conversation'; conversationId: string }
  | { type: 'create_conversation'; projectId: string; title?: string }
  | { type: 'rename_conversation'; conversationId: string; title: string }
  | { type: 'toggle_pin'; conversationId: string }
  | { type: 'archive_conversation'; conversationId: string }
  | { type: 'delete_conversation'; conversationId: string }
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

/** 主窗口广播状态快照（独立窗口 listen 此事件） */
export async function emitSyncState(snapshot: ChatStateSnapshot): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(CHAT_SYNC_EVENT, snapshot);
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
  onSync: (snapshot: ChatStateSnapshot) => void,
  onCloseRequest: () => void,
): Promise<() => void> {
  if (chatWindowInit) return () => {};
  chatWindowInit = true;

  const { listen } = await import('@tauri-apps/api/event');

  const unlistenSync = await listen<ChatStateSnapshot>(CHAT_SYNC_EVENT, (event) => {
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
