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
import { sameProjectWindowContext } from '../../services/projectWindowContext';
import {
  receiveChatStateSync,
  emitAction,
  emitCloseRequest,
  initChatWindowListener,
  setChatReferenceWindowFrame,
  requestChatMessage,
  emitChatCloseAcknowledgement,
  getChatClientSessionId,
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
  // 切页仍跟随宿主快照；各原始上下文尚未确认的输入留在本窗口，不能被新页面覆盖。
  const composerHandoffsRef = useRef<ChatComposerHandoff[]>([]);
  const handleComposerDraftChange = useCallback((draft: ChatComposerHandoff) => {
    const index = composerHandoffsRef.current.findIndex((pending) => pending.conversationId === draft.conversationId
      && pending.windowFrame?.sessionId === draft.windowFrame?.sessionId
      && sameProjectWindowContext(pending.windowFrame?.context, draft.windowFrame?.context));
    if (index < 0) composerHandoffsRef.current.push(draft);
    else composerHandoffsRef.current[index] = draft;
  }, []);
  const handleComposerDraftConsumed = useCallback((draft: ChatComposerHandoff) => {
    composerHandoffsRef.current = composerHandoffsRef.current.filter((pending) => !(
      pending.conversationId === draft.conversationId && pending.draft === draft.draft
      && pending.windowFrame?.sessionId === draft.windowFrame?.sessionId
      && sameProjectWindowContext(pending.windowFrame?.context, draft.windowFrame?.context)
    ));
  }, []);
  const resyncRequestedRef = useRef(false);
  const closePendingRef = useRef<Promise<boolean> | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(false);

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

  const showCloseFailure = useCallback(() => {
    closePendingRef.current = null;
    setClosing(false);
    setCloseError(true);
  }, []);

  const requestClose = useCallback((type: 'close_window' | 'dock_window'): Promise<boolean> => {
    if (closePendingRef.current) return closePendingRef.current;
    // 现有关闭协议一次只交接一份草稿，多份未确认输入不能只提交最后一份就销毁窗口。
    if (composerHandoffsRef.current.length > 1) {
      showCloseFailure();
      return Promise.resolve(false);
    }
    setClosing(true);
    setCloseError(false);
    const draft = composerHandoffsRef.current[0];
    const frame = draft?.windowFrame ?? syncStateRef.current?.snapshot.windowFrame;
    const pending = requestChatMessage({ type, composerDraft: draft, sessionId: getChatClientSessionId() }, frame)
      .then((accepted) => { if (!accepted) showCloseFailure(); return accepted; }, () => { showCloseFailure(); return false; });
    closePendingRef.current = pending;
    return pending;
  }, [showCloseFailure]);

  const closeWindow = useCallback((closeRequestId?: string) => {
    void requestClose('close_window').then(async (accepted) => {
      if (closeRequestId) await emitChatCloseAcknowledgement(closeRequestId, accepted);
    }).catch(showCloseFailure);
  }, [requestClose, showCloseFailure]);

  const dockWindow = useCallback(() => { void requestClose('dock_window'); }, [requestClose]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const dispose = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault(); closeWindow();
      });
      if (disposed) dispose(); else stop = dispose;
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, [closeWindow]);

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
        const previousFrame = syncStateRef.current?.snapshot.windowFrame;
        const frame = next.snapshot.windowFrame;
        const hasCurrentFrame = frame?.schemaVersion === 2 && frame.sessionId === getChatClientSessionId();
        if (hasCurrentFrame) {
          composerHandoffsRef.current = composerHandoffsRef.current.filter((handoff) => !(
            handoff.windowFrame?.sessionId === frame.sessionId
            // 绑定会话的草稿表是宿主全局状态；清空会删除键，确认本地副本不需要切回原页面。
            && (handoff.conversationId
              ? (Object.prototype.hasOwnProperty.call(next.snapshot.composerDrafts, handoff.conversationId)
                ? next.snapshot.composerDrafts[handoff.conversationId] === handoff.draft : handoff.draft === '')
              : sameProjectWindowContext(handoff.windowFrame?.context, frame.context)
                && frame.conversationId === null && next.snapshot.composerDraft === handoff.draft)
          ));
          if (previousFrame?.conversationId !== frame.conversationId
            || !sameProjectWindowContext(previousFrame?.context, frame.context)) setCloseError(false);
        }
        syncStateRef.current = next;
        setChatReferenceWindowFrame(next.snapshot.windowFrame ?? null);
        resyncRequestedRef.current = false;
        setSnapshot(next.snapshot);
        stopHandshake();
        setInitialized(hasCurrentFrame);
      },
      closeWindow,
      showCloseFailure,
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
      setChatReferenceWindowFrame(null);
    };
  }, [closeWindow, showCloseFailure]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (composerHandoffsRef.current.length <= 1) void emitCloseRequest(composerHandoffsRef.current[0]);
    };
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
        disabled={closing}
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
        onClick={() => closeWindow()}
        disabled={closing}
      >
        <Icon icon="mdi:close" width="16" height="16" />
      </button>
    </div>
  );

  return (
    <><ChatPanel
      detached
      detachedSnapshot={snapshot}
      detachedInitialized={initialized}
      composerDisabled={closing || !initialized}
      detachedHeaderActions={headerActions}
      onComposerDraftChange={handleComposerDraftChange}
      onComposerDraftConsumed={handleComposerDraftConsumed}
    />
      {closing && <div role="status" className="ui-alert ui-alert--info fixed left-3 right-3 top-12 z-[10010]">
        {t('正在交接草稿并关闭窗口…')}
      </div>}
      {closeError && <div role="alert" className="ui-alert ui-alert--warning fixed left-3 right-3 top-12 z-[10010]">
        {t('独立窗口关闭未完成，草稿与窗口已保留。请等待同步后重试；旧会话草稿无法确认时，请先返回原项目或会话。')}
      </div>}
    </>
  );
}
