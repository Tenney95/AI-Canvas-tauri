/**
 * ChatWindow — 独立对话窗口控制器。
 * UI 直接复用 ChatPanel，当前文件只负责 Tauri 窗口能力与状态快照同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import ChatPanel from './ChatPanel';
import {
  emitAction,
  emitCloseRequest,
  initChatWindowListener,
  type ChatStateSnapshot,
} from '../../services/chat/chatWindowService';

const EMPTY_SNAPSHOT: ChatStateSnapshot = {
  conversations: [],
  activeConversationId: null,
  messages: [],
  agentTasks: [],
  projectId: null,
  generalModels: [],
};

export default function ChatWindow() {
  const [snapshot, setSnapshot] = useState<ChatStateSnapshot>(EMPTY_SNAPSHOT);
  const [initialized, setInitialized] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const isLockedRef = useRef(false);

  const closeWindow = useCallback(() => {
    void (async () => {
      try {
        await emitCloseRequest();
        await invoke('close_chat_window');
      } catch (error) {
        console.error('[ChatWindow] failed to close window:', error);
      }
    })();
  }, []);

  const handleToggleLock = useCallback(async () => {
    const next = !isLockedRef.current;
    try {
      await invoke('set_chat_window_locked', { locked: next });
      isLockedRef.current = next;
      setIsLocked(next);
    } catch (error) {
      console.error('[ChatWindow] failed to change lock state:', error);
    }
  }, []);

  useEffect(() => {
    const fallbackTimer = setTimeout(() => setInitialized(true), 3000);
    let cleanup: (() => void) | undefined;

    void initChatWindowListener(
      (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setInitialized(true);
        clearTimeout(fallbackTimer);
      },
      closeWindow,
    ).then((dispose) => {
      cleanup = dispose;
      void emitAction({ type: 'request_sync' });
    });

    return () => {
      clearTimeout(fallbackTimer);
      cleanup?.();
    };
  }, [closeWindow]);

  useEffect(() => {
    const handleBeforeUnload = () => { void emitCloseRequest(); };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const headerActions = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md
                   text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover transition-colors"
        data-tooltip="收回内嵌"
        onClick={closeWindow}
      >
        <Icon icon="mdi:dock-left" width="16" height="16" />
      </button>
      <button
        type="button"
        className={`pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md transition-colors
                    ${isLocked
                      ? 'text-amber-400 bg-amber-400/15'
                      : 'text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover'
                    }`}
        data-tooltip={isLocked ? '已锁定到主窗口' : '锁定到主窗口'}
        aria-label={isLocked ? '取消位置锁定' : '锁定到主窗口'}
        onClick={handleToggleLock}
      >
        <Icon icon={isLocked ? 'mdi:lock' : 'mdi:lock-open-outline'} width="16" height="16" />
      </button>
      <button
        type="button"
        className="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md
                   text-canvas-text-muted hover:text-canvas-text hover:bg-red-500/20 transition-colors"
        aria-label="关闭独立窗口"
        onClick={closeWindow}
      >
        <Icon icon="mdi:close" width="16" height="16" />
      </button>
    </div>
  );

  return (
    <ChatPanel
      detached
      detachedSnapshot={snapshot}
      detachedInitialized={initialized}
      detachedHeaderActions={headerActions}
    />
  );
}
