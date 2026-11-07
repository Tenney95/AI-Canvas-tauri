/**
 * chatWindowLifecycle — 管理独立聊天窗口打开时的状态交接。
 */
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import { sanitizeDomainText } from './subAgentMaterials';
import { beginChatWindowSession, CHAT_DETACHED_WINDOW_LABEL, endChatWindowSession, getMainChatWindowSessionId } from './chatWindowService';

let pendingOpen: Promise<void> | null = null;

/** 所有主窗口入口共用一次打开请求；失败后恢复内嵌助手，保留会话和草稿。 */
export function openDetachedChatWindow(): Promise<void> {
  if (pendingOpen) return pendingOpen;
  // 独立窗口加载后立即请求快照，必须在原生命令之前启用主窗口同步。
  useAppStore.getState().setChatPanelDetached(true);
  let createdSessionId: string | undefined;
  let cancelled = false;
  const stopWatching = useAppStore.subscribe((state) => {
    if (!state.chatPanelDetached) { cancelled = true; endChatWindowSession(createdSessionId); }
  });
  const assertOpening = () => {
    if (cancelled || !useAppStore.getState().chatPanelDetached) throw new Error('独立窗口打开已取消，已保留内嵌助手');
  };
  pendingOpen = Promise.resolve().then(async () => {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    assertOpening();
    const existing = await WebviewWindow.getByLabel(CHAT_DETACHED_WINDOW_LABEL);
    assertOpening();
    const sessionId = existing ? getMainChatWindowSessionId() : (createdSessionId = beginChatWindowSession());
    if (!sessionId) throw new Error('原独立窗口尚未完成关闭，请先核对窗口中的草稿');
    await invoke<void>('open_chat_window', { sessionId });
    if (cancelled || !useAppStore.getState().chatPanelDetached) {
      // 原生命令可能已在创建窗口；只回收本次新建且已撤销授权的迟到窗口。
      if (createdSessionId && (!getMainChatWindowSessionId() || getMainChatWindowSessionId() === createdSessionId)) {
        await invoke<void>('close_chat_window');
      }
      assertOpening();
    }
  }).catch((error: unknown) => {
    endChatWindowSession(createdSessionId);
    const store = useAppStore.getState();
    store.setChatPanelDetached(false);
    store.openChat();
    const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    throw new Error(sanitizeDomainText(detail).slice(0, 320));
  }).finally(() => { stopWatching(); pendingOpen = null; });
  return pendingOpen;
}
