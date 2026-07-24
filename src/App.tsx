/**
 * App 根组件 — 装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel / Titlebar / Toast / AINodeDialog / WorkflowPanel
 * Tauri 环境下启用自定义窗口装饰和透明圆角窗口
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Header from './components/Header';
import Titlebar from './components/Titlebar';
import SessionProjectTabs from './components/SessionProjectTabs';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import NodeMenu from './components/NodeMenu';
import Toast from './components/Toast';
import SplashScreen from './components/SplashScreen';
import CanvasBackground from './components/backgrounds/CanvasBackground';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoSave } from './hooks/useAutoSave';
import { useReferencedImageWatcher } from './hooks/useReferencedImageWatcher';
import { useTooltipAutoPlacement } from './hooks/useTooltipAutoPlacement';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type AppState } from './store/useAppStore';
import * as fileService from './services/fileService';
import { checkForUpdate, downloadAndInstallUpdate, type UpdateInfo } from './services/updateService';
import { DOWNLOAD_MASCOT_EVENT } from './components/shared/ModelDownloadDialog';
import UpdateBubble from './components/shared/mascot/UpdateBubble';
import LazyLoadBoundary, { LazyLoadFallback } from './components/shared/LazyLoadBoundary';
import { useMascotStatus } from './hooks/useMascotStatus';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

// 懒加载：吉祥物引入 three + gsap（体积大户），默认隐藏，首次 Ctrl+Shift+M 显示时才加载
const Mascot = lazy(() => import('./components/shared/mascot/Mascot'));
const PacmanMascot = lazy(() => import('./components/shared/mascot/PacmanDownloadMascot'));
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));
const AINodeDialog = lazy(() => import('./components/nodes/AINodeDialog'));
const WorkflowPanel = lazy(() => import('./components/WorkflowPanel'));
const AssetsPanel = lazy(() => import('./components/AssetsPanel'));
const OutputHistoryPanel = lazy(() => import('./components/OutputHistoryPanel'));
const ChatPanel = lazy(() => import('./components/chat/ChatPanel'));
const PresetRunnerDialog = lazy(() => import('./components/nodes/shared/PresetRunnerDialog'));
const DirectorDeskRuntimeManager = lazy(() => import('./components/director/DirectorDeskRuntimeManager'));

let cachedMascotNodes: AppState['nodes'] | undefined;
let cachedMascotLoading = false;

function selectMascotLoading(state: AppState) {
  if (!state.config.mascotVisible) return false;
  if (state.nodes !== cachedMascotNodes) {
    cachedMascotNodes = state.nodes;
    cachedMascotLoading = state.nodes.some(
      (node) => (node.data as { status?: string })?.status === 'loading',
    );
  }
  return cachedMascotLoading;
}

function useFeatureMount(active: boolean) {
  const [hasMounted, setHasMounted] = useState(active);
  if (active && !hasMounted) setHasMounted(true);
  return active || hasMounted;
}

export default function App() {
  const reduceMotion = useReducedMotion();
  useKeyboardShortcuts();
  useAutoSave();
  useReferencedImageWatcher();
  useTooltipAutoPlacement();

  const featureVisibility = useAppStore(
    useShallow((state) => ({
      settings: state.settingsOpen,
      nodeDialog: state.activeNodeId !== null,
      workflows: state.workflowPanelOpen,
      assets: state.assetsPanelOpen,
      history: state.historyPanelOpen,
      chat: state.chatOpen || state.chatPanelDetached,
      presetRunner: state.presetRunRequest !== null,
    })),
  );
  const mountSettings = useFeatureMount(featureVisibility.settings);
  const mountNodeDialog = useFeatureMount(featureVisibility.nodeDialog);
  const mountWorkflows = useFeatureMount(featureVisibility.workflows);
  const mountAssets = useFeatureMount(featureVisibility.assets);
  const mountHistory = useFeatureMount(featureVisibility.history);
  const mountChat = useFeatureMount(featureVisibility.chat);
  const mountPresetRunner = useFeatureMount(featureVisibility.presetRunner);

  // 开屏动画状态
  const [splashDone, setSplashDone] = useState(false);
  // 下载弹窗出现时，右下角吉祥物缩小消失
  const [mascotShrink, setMascotShrink] = useState(false);

  // 更新检测
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBubbleVisible, setUpdateBubbleVisible] = useState(false);
  const [updating, setUpdating] = useState(false);
  const configHydrated = useAppStore((state) => state.configHydrated);

  // 开屏动画结束后后台静默检查更新
  useEffect(() => {
    if (!splashDone || !isTauri || !configHydrated) return;
    const run = async () => {
      const result = await checkForUpdate();
      if (result.available) {
        const store = useAppStore.getState();
        // 强制显示吉祥物
        if (!store.config.mascotVisible) {
          store.updateConfig({ mascotVisible: true });
          store.saveConfig();
        }
        setUpdateInfo({ version: result.version, body: result.body, date: result.date });
        setUpdateBubbleVisible(true);
      }
    };
    run();
  }, [configHydrated, splashDone]);

  // 监听下载事件 → 控制吉祥物缩小动画
  useEffect(() => {
    const handler = ((e: CustomEvent) => setMascotShrink(e.detail.active)) as EventListener;
    window.addEventListener(DOWNLOAD_MASCOT_EVENT, handler);
    return () => window.removeEventListener(DOWNLOAD_MASCOT_EVENT, handler);
  }, []);

  // Load projects from IndexedDB on mount
  const initFromDb = useAppStore((s) => s.initFromDb);
  const migrateHistoryAndLoad = useAppStore((s) => s.migrateHistoryAndLoad);
  useEffect(() => {
    initFromDb().then(() => migrateHistoryAndLoad());
  }, [initFromDb, migrateHistoryAndLoad]);

  // Flush undo-trash dirs on app close
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async () => {
          const store = useAppStore.getState();
          await store.captureCurrentProjectSnapshot();
          await store.saveCurrentProjectSilent();
          await fileService.flushUndoTrashDirs();
          const { stopMcpBridge } = await import('./services/mcp/mcpBridgeService');
          await stopMcpBridge().catch(() => {});
          win.destroy();
        });
      } catch { /* non-Tauri env */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    import('./services/mcp/mcpControlService')
      .then(({ initMcpControlService }) => initMcpControlService())
      .then((cleanup) => {
        if (cancelled) cleanup();
        else dispose = cleanup;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // ── 更新相关操作 ──
  const handleUpdateNow = async () => {
    setUpdating(true);
    await downloadAndInstallUpdate();
    setUpdating(false);
  };
  const handleDismissUpdate = () => {
    setUpdateBubbleVisible(false);
  };
  const handleMascotActivate = async () => {
    const store = useAppStore.getState();
    if (!store.chatPanelDetached) {
      store.openChat();
      return;
    }

    if (isTauri) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const chatWindow = await WebviewWindow.getByLabel('chat-assistant');
        if (chatWindow) {
          await chatWindow.show();
          await chatWindow.unminimize();
          await chatWindow.setFocus();
          return;
        }
      } catch { /* fall back to the embedded panel */ }
    }

    store.setChatPanelDetached(false);
    store.openChat();
  };

  // 同步主题到 document.documentElement，供 CSS [data-theme] 选择器生效
  // 米白色背景时自动切换为 light，其余背景使用用户手动设置的主题
  const configTheme = useAppStore((s) => s.config.theme);
  const canvasBackground = useAppStore((s) => s.config.canvasBackground);
  const windowGlassFrame = useAppStore((s) => s.config.windowGlassFrame);
  const mascotVisible = useAppStore((s) => s.config.mascotVisible);
  // 任意节点处于生成中 → 吉祥物切换为 LOADING 形态
  const mascotLoading = useAppStore(selectMascotLoading);
  const mascotStatus = useMascotStatus();
  const effectiveTheme = canvasBackground === 'off-white' ? 'light' : configTheme;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    return () => document.documentElement.removeAttribute('data-theme');
  }, [effectiveTheme]);

  // Tauri 模式下给 body 加属性，Portal 渲染的弹窗元素也在 body 下，CSS 选择器才能匹配
  useEffect(() => {
    if (isTauri) {
      document.body.setAttribute('data-tauri-window', '');
      return () => document.body.removeAttribute('data-tauri-window');
    }
  }, []);

  // 窗口最大化状态（Tauri）：最大化时取消悬浮效果（无透明边条可悬浮）
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const check = () => win.isMaximized().then(setIsMaximized).catch(() => {});
        await check();
        unlisten = await win.onResized(check);
      } catch { /* non-Tauri env */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  // 侧边栏悬浮显示开关（默认开启）；最大化时强制非悬浮。
  // 同步到 body 属性，供 CSS 切换侧边栏停靠/悬浮位置 + 弹窗蒙层的左偏移
  const sidebarFloatingCfg = useAppStore((s) => s.config.sidebarFloating);
  const effectiveFloating = sidebarFloatingCfg !== false && !isMaximized;
  const showWindowGlassFrame = windowGlassFrame !== false && !isMaximized;
  useEffect(() => {
    if (!isTauri) return;
    document.body.toggleAttribute('data-window-glass-frame', showWindowGlassFrame);
    return () => document.body.removeAttribute('data-window-glass-frame');
  }, [showWindowGlassFrame]);
  useEffect(() => {
    if (effectiveFloating) {
      document.body.setAttribute('data-sidebar-floating', '');
    } else {
      document.body.removeAttribute('data-sidebar-floating');
    }
  }, [effectiveFloating]);

  const appContent = (
    <div
      className={`app-shell h-screen relative text-canvas-text font-sans ${
        showWindowGlassFrame ? 'app-shell--glass-frame ' : ''
      }${
        isTauri && effectiveFloating ? 'ml-[30px] w-[calc(100vw-30px)]' : 'w-screen'
      }`}
      style={{
        transition:
          'margin-left 0.42s var(--ease-out-expo), width 0.42s var(--ease-out-expo)',
      }}
    >
      {/* Content area — clip-path clips ALL descendants including fixed-position backdrops */}
      <div className="app-box app-shell__content absolute bg-canvas-bg/[0.988] shadow-2xl overflow-hidden">
        <div className="app-canvas-viewport absolute inset-0">
          <CanvasBackground />
          <Canvas />
        </div>
        {/* Top drag region */}
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-10" />
        <Header />
        <Titlebar />
        <SessionProjectTabs />
        <NodeMenu />
        <LazyLoadBoundary label="设置面板">
          <Suspense fallback={<LazyLoadFallback label="设置面板" />}>
            {mountSettings && <SettingsPanel />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="节点编辑器">
          <Suspense fallback={<LazyLoadFallback label="节点编辑器" />}>
            {mountNodeDialog && <AINodeDialog />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="工作流面板">
          <Suspense fallback={<LazyLoadFallback label="工作流面板" />}>
            {mountWorkflows && <WorkflowPanel />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="资产面板">
          <Suspense fallback={<LazyLoadFallback label="资产面板" />}>
            {mountAssets && <AssetsPanel />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="输出历史">
          <Suspense fallback={<LazyLoadFallback label="输出历史" />}>
            {mountHistory && <OutputHistoryPanel />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="对话助手">
          <Suspense fallback={<LazyLoadFallback label="对话助手" />}>
            {mountChat && <ChatPanel />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="快捷指令运行器">
          <Suspense fallback={null}>
            {mountPresetRunner && <PresetRunnerDialog />}
          </Suspense>
        </LazyLoadBoundary>
        <Toast />
      </div>
      {/* Sidebar — outside the overflow-hidden container so it's not clipped */}
      <Sidebar />

      {/* 吉祥物 — 右下角浮动预览，默认隐藏，Ctrl+Shift+M 切换 */}
      {mascotVisible && (
        <LazyLoadBoundary label="吉祥物">
          <motion.div
            className="fixed bottom-40 right-5 z-50 h-[100px] w-[100px] pointer-events-auto"
            animate={mascotShrink
              ? { transform: reduceMotion ? 'scale(1)' : 'scale(0.94)', opacity: 0 }
              : { transform: 'scale(1)', opacity: 1 }}
            transition={{ duration: reduceMotion ? 0.12 : 0.18, ease: [0.23, 1, 0.32, 1] }}
          >
            <button
              type="button"
              className="h-full w-full rounded-full border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
              onClick={() => { void handleMascotActivate(); }}
              disabled={mascotShrink}
              aria-label={mascotStatus === 'thinking'
                ? '打开画布助手，正在思考'
                : mascotStatus === 'success'
                  ? '打开画布助手，任务已完成'
                  : mascotStatus === 'error'
                    ? '打开画布助手，任务失败'
                    : '打开画布助手'}
              data-tooltip={mascotStatus === 'thinking'
                ? '画布助手：思考中'
                : mascotStatus === 'success'
                  ? '画布助手：已完成'
                  : mascotStatus === 'error'
                    ? '画布助手：任务失败'
                    : '打开画布助手'}
            >
              <Suspense
                fallback={(
                  <div
                    className="flex h-full w-full items-center justify-center"
                    role="status"
                    aria-label="正在加载吉祥物"
                  >
                    <span
                      className="h-5 w-5 animate-spin rounded-full border-2 border-canvas-border border-t-canvas-text-secondary motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  </div>
                )}
              >
                {updating ? (
                  <PacmanMascot />
                ) : (
                  <Mascot
                    loading={mascotLoading}
                    status={mascotStatus}
                    theme={effectiveTheme}
                    reduceMotion={Boolean(reduceMotion)}
                  />
                )}
              </Suspense>
            </button>
          </motion.div>
        </LazyLoadBoundary>
      )}

      {/* 更新聊天气泡 — 悬停在吉祥物左上方 */}
      {updateInfo && (
        <UpdateBubble
          info={updateInfo}
          visible={updateBubbleVisible}
          onUpdate={() => { handleUpdateNow(); }}
          onDismiss={handleDismissUpdate}
          updating={updating}
        />
      )}

      <Suspense fallback={null}>
        <DirectorDeskRuntimeManager />
      </Suspense>

    </div>
  );

  return (
    <>
      {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
      {appContent}
    </>
  );
}
