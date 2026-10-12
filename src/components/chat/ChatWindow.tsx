/**
 * ChatWindow — 独立对话窗口控制器。
 * UI 直接复用 ChatPanel，当前文件只负责 Tauri 窗口能力与状态快照同步。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { invoke } from '@tauri-apps/api/core';
import { useTooltipAutoPlacement } from '../../hooks/useTooltipAutoPlacement';
import { loadConfigWithoutSecrets } from '../../services/fileService';
import { applyAppearanceTheme, installSystemAppearanceListener } from '../../services/appearance/appearanceRuntime';
import { getAppearanceForConfig } from '../../services/appearance/appearanceMigration';
import { syncPerformanceModeRuntime } from '../../services/performanceModeRuntime';
import { useAppStore } from '../../store/useAppStore';
import { emptyDramaAssetLibrary } from '../../types/dramaAssets';
import type { AppConfig } from '../../types';
import { setLocale, useT } from '../../i18n';
import ChatPanel from './ChatPanel';
import {
  receiveChatStateSync,
  emitAction,
  emitCloseRequest,
  initChatWindowListener,
  type ChatStateSnapshot,
  type ChatWindowState,
  type ChatComposerHandoff,
} from '../../services/chat/chatWindowService';

const EMPTY_SNAPSHOT: ChatStateSnapshot = {
  conversations: [],
  activeConversationId: null,
  messages: [],
  agentTasks: [],
  projectId: null,
  generalModels: [],
  assistantModelGroups: [],
  mediaModelOptions: [],
  nodes: [],
  dramaAssets: emptyDramaAssetLibrary(),
  skillOptions: [],
  composerDraft: '',
  composerDrafts: {},
  panelView: 'chat',
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
  const syncStateRef = useRef<ChatWindowState | null>(null);
  const composerHandoffRef = useRef<ChatComposerHandoff | undefined>(undefined);
  const handleComposerDraftChange = useCallback((draft: ChatComposerHandoff) => { composerHandoffRef.current = draft; }, []);
  const resyncRequestedRef = useRef(false);

  useEffect(() => {
    const handoff = composerHandoffRef.current;
    if (handoff && (handoff.conversationId ? snapshot.composerDrafts[handoff.conversationId] ?? '' : snapshot.composerDraft) === handoff.draft) {
      composerHandoffRef.current = undefined;
    }
  }, [snapshot.composerDraft, snapshot.composerDrafts]);

  useEffect(() => {
    let disposed = false;
    let removeSystemListener = () => {};

    const syncTheme = () => {
      void loadConfigWithoutSecrets().then((savedConfig) => {
        if (disposed) return;
        const config = savedConfig as AppConfig | null;
        const theme = config?.appearance ?? getAppearanceForConfig(config);
        applyAppearanceTheme(theme);
        removeSystemListener();
        removeSystemListener = installSystemAppearanceListener(() => applyAppearanceTheme(theme));
        document.documentElement.toggleAttribute('data-native-cursor', config?.customCursor === false);
        const performanceMode = (config?.performanceMode ?? config?.graphicsCompatibilityMode) === true;
        syncPerformanceModeRuntime(performanceMode);
        document.documentElement.toggleAttribute('data-performance-mode', performanceMode);
        setLocale(config?.language);
      }).catch(() => {
        // 读取失败时保留当前主题；下次聚焦窗口会重新读取。
        if (!disposed) console.warn('[ChatWindow] 主题配置读取失败，已保留当前主题');
      });
    };

    syncTheme();
    window.addEventListener('focus', syncTheme);

    return () => {
      disposed = true;
      removeSystemListener();
      window.removeEventListener('focus', syncTheme);
      document.documentElement.removeAttribute('data-theme');
    };
  }, []);

  // 直接把同步过来的画布切片灌进本窗口 Store，@ 引用 / 调用详情等组件照旧读 Store
  useEffect(() => {
    useAppStore.setState({
      nodes: snapshot.nodes,
      dramaAssets: snapshot.dramaAssets,
      currentProjectId: snapshot.projectId,
    });
  }, [snapshot.nodes, snapshot.dramaAssets, snapshot.projectId]);

  const closeWindow = useCallback(() => {
    void (async () => {
      try {
        await emitCloseRequest(composerHandoffRef.current);
        await invoke('close_chat_window');
      } catch (error) {
        console.error('[ChatWindow] failed to close window:', error);
      }
    })();
  }, []);

  const dockWindow = useCallback(() => {
    void (async () => {
      try {
        await emitAction({ type: 'dock_window', composerDraft: composerHandoffRef.current });
        await invoke('close_chat_window');
      } catch (error) {
        console.error('[ChatWindow] failed to dock window:', error);
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
    // initChatWindowListener 是异步的，可能在 cleanup 之后才 resolve；
    // 不记住这个标记就会漏掉一个永不注销的监听 + 一个还在发 request_sync 的定时器
    let disposed = false;
    let cleanup: (() => void) | undefined;
    let handshake: ReturnType<typeof setInterval> | undefined;
    const stopHandshake = () => {
      if (handshake) clearInterval(handshake);
      handshake = undefined;
    };

    void initChatWindowListener(
      (sync) => {
        if (disposed) return;
        const next = receiveChatStateSync(syncStateRef.current, sync);
        if (!next) {
          if (!resyncRequestedRef.current) {
            resyncRequestedRef.current = true;
            void emitAction({ type: 'request_sync' });
          }
          return;
        }
        if (next === syncStateRef.current) return;
        syncStateRef.current = next;
        resyncRequestedRef.current = false;
        setSnapshot(next.snapshot);
        stopHandshake();
        setInitialized(true);
      },
      closeWindow,
    ).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      cleanup = dispose;
      const startedAt = Date.now();
      void emitAction({ type: 'request_sync' });
      // 主窗口可能还没准备好接收，重试到首帧快照到手为止
      handshake = setInterval(() => {
        if (Date.now() - startedAt > HANDSHAKE_TIMEOUT_MS) {
          stopHandshake();
          // 还没拿到主窗口状态，就继续等；不能把空快照当成真实会话放行。
          console.error('[ChatWindow] no snapshot from the main window; sync channel is down');
          handshake = setInterval(() => { void emitAction({ type: 'request_sync' }); }, 5000);
          return;
        }
        void emitAction({ type: 'request_sync' });
      }, HANDSHAKE_RETRY_MS);
    });

    return () => {
      disposed = true;
      stopHandshake();
      cleanup?.();
    };
  }, [closeWindow]);

  useEffect(() => {
    const handleBeforeUnload = () => { void emitCloseRequest(composerHandoffRef.current); };
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
        onClick={dockWindow}
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
      onComposerDraftChange={handleComposerDraftChange}
    />
  );
}
