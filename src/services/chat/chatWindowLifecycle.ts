/**
 * chatWindowLifecycle — 管理独立聊天窗口打开时的状态交接。
 */
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import { sanitizeDomainText } from './subAgentMaterials';
import { beginChatWindowSession, CHAT_DETACHED_WINDOW_LABEL, endChatWindowSession, finishChatWindowClose,
  getMainChatWindowSessionId, waitForChatWindowClose } from './chatWindowService';

let pendingOpen: Promise<void> | null = null;

/** 只观察调用时已在途的打开操作，不创建窗口或授予新会话。 */
export function waitForChatWindowOpen(): Promise<void> | null { return pendingOpen; }

/** 所有主窗口入口共用一次打开请求；失败时先核对真实窗口，保留存活会话和草稿。 */
export function openDetachedChatWindow(): Promise<void> {
  if (pendingOpen) return pendingOpen;
  // 独立窗口加载后立即请求快照，必须在原生命令之前启用主窗口同步。
  useAppStore.getState().setChatPanelDetached(true);
  let createdSessionId: string | undefined;
  let attemptedSessionId: string | undefined;
  let cancelled = false;
  const stopWatching = useAppStore.subscribe((state) => {
    if (!state.chatPanelDetached) cancelled = true;
  });
  const assertOpening = () => {
    if (cancelled || !useAppStore.getState().chatPanelDetached) throw new Error('独立窗口打开已取消，已保留内嵌助手');
  };
  pendingOpen = Promise.resolve().then(async () => {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await waitForChatWindowClose();
    assertOpening();
    const existing = await WebviewWindow.getByLabel(CHAT_DETACHED_WINDOW_LABEL);
    assertOpening();
    const sessionId = existing ? getMainChatWindowSessionId() : (createdSessionId = beginChatWindowSession());
    attemptedSessionId = sessionId;
    if (!sessionId) throw new Error('原独立窗口尚未完成关闭，请先核对窗口中的草稿');
    await invoke<void>('open_chat_window', { sessionId, ...(existing ? { reuseExisting: true } : {}) });
    if (cancelled || !useAppStore.getState().chatPanelDetached) {
      // 原生命令可能已在创建窗口；只回收本次新建且已撤销授权的迟到窗口。
      if (createdSessionId && (!getMainChatWindowSessionId() || getMainChatWindowSessionId() === createdSessionId)) {
        await finishChatWindowClose(createdSessionId);
      }
      assertOpening();
    }
  }).catch(async (error: unknown) => {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    // 查询失败不能当作窗口已销毁；保留原 nonce 与展示方式，避免显示第二份助手。
    const exists = await WebviewWindow.getByLabel(CHAT_DETACHED_WINDOW_LABEL).then((window) => !!window, () => true);
    const store = useAppStore.getState();
    const latestSession = getMainChatWindowSessionId();
    if (exists || attemptedSessionId && latestSession && latestSession !== attemptedSessionId) store.setChatPanelDetached(true);
    else {
      endChatWindowSession(attemptedSessionId);
      store.setChatPanelDetached(false);
      store.openChat();
    }
    const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    throw new Error(sanitizeDomainText(detail).slice(0, 320));
  }).finally(() => { stopWatching(); pendingOpen = null; });
  return pendingOpen;
}
