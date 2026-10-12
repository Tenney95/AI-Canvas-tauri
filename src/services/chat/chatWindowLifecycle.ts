import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import { sanitizeDomainText } from './subAgentMaterials';

let pendingOpen: Promise<void> | null = null;

/** 所有主窗口入口共用一次打开请求；失败后恢复内嵌助手，保留会话和草稿。 */
export function openDetachedChatWindow(): Promise<void> {
  if (pendingOpen) return pendingOpen;
  // 独立窗口加载后立即请求快照，必须在原生命令之前启用主窗口同步。
  useAppStore.getState().setChatPanelDetached(true);
  pendingOpen = Promise.resolve().then(() => invoke<void>('open_chat_window')).catch((error: unknown) => {
    const store = useAppStore.getState();
    store.setChatPanelDetached(false);
    store.openChat();
    const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    throw new Error(sanitizeDomainText(detail).slice(0, 320));
  }).finally(() => { pendingOpen = null; });
  return pendingOpen;
}
