/**
 * ChatWindow — 独立对话窗口控制器。
 * UI 直接复用 ChatPanel，当前文件只负责 Tauri 窗口能力与状态快照同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { useTooltipAutoPlacement } from '../../hooks/useTooltipAutoPlacement';
import { loadConfig } from '../../services/fileService';
import { useAppStore } from '../../store/useAppStore';
import { emptyDramaAssetLibrary } from '../../types/dramaAssets';
import type { AppConfig } from '../../types';
import { setLocale, useT } from '../../i18n';
import ChatPanel from './ChatPanel';
import {
  applyChatStatePatch,
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
  nodes: [],
  dramaAssets: emptyDramaAssetLibrary(),
  userSkills: [],
  composerDraft: '',
};

const HANDSHAKE_RETRY_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 8000;

export default function ChatWindow() {
  const t = useT();
  useTooltipAutoPlacement();
  const [snapshot, setSnapshot] = useState<ChatStateSnapshot>(EMPTY_SNAPSHOT);
  const [initialized, setInitialized] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const isLockedRef = useRef(false);
  const syncRevisionRef = useRef(0);
  const resyncRequestedRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    const syncTheme = () => {
      void loadConfig().then((savedConfig) => {
        if (disposed) return;
        const config = savedConfig as AppConfig | null;
        const effectiveTheme = config?.canvasBackground === 'off-white'
          ? 'light'
          : config?.theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', effectiveTheme);
        setLocale(config?.language);
      });
    };

    syncTheme();
    window.addEventListener('focus', syncTheme);

    return () => {
      disposed = true;
      window.removeEventListener('focus', syncTheme);
      document.documentElement.removeAttribute('data-theme');
    };
  }, []);

  // 直接把同步过来的画布切片灌进本窗口 Store，@ 引用 / 调用详情等组件照旧读 Store
  useEffect(() => {
    useAppStore.setState({
      nodes: snapshot.nodes,
      dramaAssets: snapshot.dramaAssets,
      userSkills: snapshot.userSkills,
      currentProjectId: snapshot.projectId,
    });
  }, [snapshot.nodes, snapshot.dramaAssets, snapshot.userSkills, snapshot.projectId]);

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
    let cleanup: (() => void) | undefined;
    let handshake: ReturnType<typeof setInterval> | undefined;
    const stopHandshake = () => {
      if (handshake) clearInterval(handshake);
      handshake = undefined;
    };

    void initChatWindowListener(
      (sync) => {
        if (sync.type === 'snapshot') {
          syncRevisionRef.current = sync.revision;
          resyncRequestedRef.current = false;
          setSnapshot(sync.snapshot);
        } else if (sync.baseRevision === syncRevisionRef.current) {
          syncRevisionRef.current = sync.revision;
          setSnapshot((current) => applyChatStatePatch(current, sync.patch));
        } else if (!resyncRequestedRef.current) {
          resyncRequestedRef.current = true;
          void emitAction({ type: 'request_sync' });
        }
        stopHandshake();
        setInitialized(true);
      },
      closeWindow,
    ).then((dispose) => {
      cleanup = dispose;
      const startedAt = Date.now();
      void emitAction({ type: 'request_sync' });
      // 主窗口可能还没准备好接收，重试到首帧快照到手为止
      handshake = setInterval(() => {
        if (Date.now() - startedAt > HANDSHAKE_TIMEOUT_MS) {
          stopHandshake();
          // 握手失败不该伪装成「没有对话」，先放行 UI 再把原因留在控制台
          console.error('[ChatWindow] no snapshot from the main window; sync channel is down');
          setInitialized(true);
          return;
        }
        void emitAction({ type: 'request_sync' });
      }, HANDSHAKE_RETRY_MS);
    });

    return () => {
      stopHandshake();
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
        data-tooltip={t('收回内嵌')}
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
        data-tooltip={isLocked ? t('已锁定到主窗口') : t('锁定到主窗口')}
        aria-label={isLocked ? t('取消位置锁定') : t('锁定到主窗口')}
        onClick={handleToggleLock}
      >
        <Icon icon={isLocked ? 'mdi:lock' : 'mdi:lock-open-outline'} width="16" height="16" />
      </button>
      <button
        type="button"
        className="pointer-events-auto flex items-center justify-center w-7 h-7 rounded-md
                   text-canvas-text-muted hover:text-canvas-text hover:bg-red-500/20 transition-colors"
        aria-label={t('关闭独立窗口')}
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
