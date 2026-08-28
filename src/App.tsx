/**
 * App 根组件 — 装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel / Titlebar / Toast / AINodeDialog / WorkflowPanel
 * Tauri 环境下启用自定义窗口装饰和透明圆角窗口
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { MotionConfig, motion, useReducedMotion } from 'framer-motion';
import Header from './components/Header';
import Titlebar from './components/Titlebar';
import SessionProjectTabs from './components/SessionProjectTabs';
import SeriesRail from './components/SeriesRail';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import NodeMenu from './components/NodeMenu';
import Toast from './components/Toast';
import ProjectSwitchOverlay from './components/ProjectSwitchOverlay';
import SplashScreen from './components/SplashScreen';
import CanvasBackground from './components/backgrounds/CanvasBackground';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoSave } from './hooks/useAutoSave';
import { useReferencedImageWatcher } from './hooks/useReferencedImageWatcher';
import { useTooltipAutoPlacement } from './hooks/useTooltipAutoPlacement';
import { parseAspectRatio, useMainWindowSize } from './hooks/useMainWindowSize';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, type AppState } from './store/useAppStore';
import * as fileService from './services/fileService';
import { checkForUpdate, downloadAndInstallUpdate, type UpdateInfo } from './services/updateService';
import { DOWNLOAD_MASCOT_EVENT } from './components/shared/ModelDownloadDialog';
import UpdateBubble from './components/shared/mascot/UpdateBubble';
import LazyLoadBoundary, { LazyLoadFallback } from './components/shared/LazyLoadBoundary';
import { useMascotStatus } from './hooks/useMascotStatus';
import { useMascotDrag } from './hooks/useMascotDrag';
import { initComfyUIWindowBridge } from './services/comfyUIWindowService';
import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

// 懒加载：吉祥物引入 three + gsap（体积大户），默认隐藏，首次 Ctrl+Shift+M 显示时才加载
const Mascot = lazy(() => import('./components/shared/mascot/Mascot'));
const PacmanMascot = lazy(() => import('./components/shared/mascot/PacmanDownloadMascot'));
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));
const AINodeDialog = lazy(() => import('./components/nodes/AINodeDialog'));
const WorkflowPanel = lazy(() => import('./components/WorkflowPanel'));
const AssetsPanel = lazy(() => import('./components/AssetsPanel'));
const CharacterLibraryPanel = lazy(() => import('./components/CharacterLibraryPanel'));
const OutputHistoryPanel = lazy(() => import('./components/OutputHistoryPanel'));
const ChatPanel = lazy(() => import('./components/chat/ChatPanel'));
const PresetRunnerDialog = lazy(() => import('./components/nodes/shared/PresetRunnerDialog'));
const ReversePromptDialog = lazy(() => import('./components/nodes/shared/ReversePromptDialog'));
const DirectorDeskRuntimeManager = lazy(() => import('./components/director/DirectorDeskRuntimeManager'));
const OnboardingDialog = lazy(() => import('./components/OnboardingDialog'));

/** 首次启动引导只弹一次；关掉后写入本地标记。 */
const ONBOARDING_SEEN_KEY = 'ai-canvas-onboarding-seen';

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
  // 记住窗口尺寸；勾了「固定窗口比例」时还会把比例锁住
  const lockedAspect = useAppStore((s) => (s.config.windowAspectLocked ? s.config.windowAspectRatio ?? '16:9' : null));
  useMainWindowSize(parseAspectRatio(lockedAspect));
  const {
    constraintsRef: mascotDragConstraintsRef,
    x: mascotX,
    y: mascotY,
    handlePointerDownCapture: handleMascotPointerDownCapture,
    handleDragStart: handleMascotDragStart,
    handleDrag: handleMascotDrag,
    handleDragEnd: handleMascotDragEnd,
    getDragForce: getMascotDragForce,
    consumeDragClick: consumeMascotDragClick,
  } = useMascotDrag();

  const featureVisibility = useAppStore(
    useShallow((state) => ({
      settings: state.settingsOpen,
      nodeDialog: state.activeNodeId !== null,
      workflows: state.workflowPanelOpen,
      assets: state.assetsPanelOpen,
      characters: state.characterLibraryOpen || state.characterActionLibraryOpen,
      history: state.historyPanelOpen,
      chat: state.chatOpen || state.chatPanelDetached,
      presetRunner: state.presetRunRequest !== null,
      reversePrompt: state.reversePromptRequest !== null,
    })),
  );
  const mountSettings = useFeatureMount(featureVisibility.settings);
  const mountNodeDialog = useFeatureMount(featureVisibility.nodeDialog);
  const mountWorkflows = useFeatureMount(featureVisibility.workflows);
  const mountAssets = useFeatureMount(featureVisibility.assets);
  const mountCharacters = useFeatureMount(featureVisibility.characters);
  const mountHistory = useFeatureMount(featureVisibility.history);
  const mountChat = useFeatureMount(featureVisibility.chat);
  const mountPresetRunner = useFeatureMount(featureVisibility.presetRunner);
  const mountReversePrompt = useFeatureMount(featureVisibility.reversePrompt);

  // 开屏动画状态
  const [splashDone, setSplashDone] = useState(false);
  // 首次启动引导（开屏动画结束后才弹）
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => localStorage.getItem(ONBOARDING_SEEN_KEY) !== 'true',
  );
  const closeOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_SEEN_KEY, 'true');
    setOnboardingOpen(false);
  }, []);
  // 下载弹窗出现时，右下角吉祥物缩小消失
  const [mascotShrink, setMascotShrink] = useState(false);

  // 更新检测
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBubbleVisible, setUpdateBubbleVisible] = useState(false);
  const [updating, setUpdating] = useState(false);
  const configHydrated = useAppStore((state) => state.configHydrated);
  const mcpAutoStart = useAppStore((state) => state.config.mcpAutoStart === true);

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
  const loadAgentPackages = useAppStore((s) => s.loadAgentPackages);
  // Agent Package 是可选增强层：独立加载且不参与项目、配置或画布 readiness。
  useEffect(() => {
    void loadAgentPackages();
  }, [loadAgentPackages]);
  useEffect(() => {
    void initFromDb().then(() => {
      const store = useAppStore.getState();
      if (store.config.startupView === 'project-library') {
        store.setProjectLibraryOpen(true);
      }
      return migrateHistoryAndLoad();
    });
  }, [initFromDb, migrateHistoryAndLoad]);

  // Flush undo-trash dirs on app close
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          const store = useAppStore.getState();
          try {
            await store.captureCurrentProjectSnapshot();
          } catch (error) {
            console.warn('[退出] 生成画布快照失败:', error);
          }
          try {
            await store.saveCurrentProjectSilent();
          } catch (error) {
            console.warn('[退出] 保存失败:', error);
          }

          // 保存一直失败时不能默默销毁窗口，否则这次会话的工作全丢
          const failure = useAppStore.getState().autoSaveFailure;
          if (failure) {
            const { ask } = await import('@tauri-apps/plugin-dialog');
            const detail = failure.count > 1 ? `已连续失败 ${failure.count} 次。` : '';
            const quitAnyway = await ask(
              `${detail}${failure.reason}\n\n现在退出会丢失未保存的改动。建议先取消退出，再用「导出项目」把内容备份出去。`,
              { title: '保存失败，仍要退出吗？', kind: 'warning', okLabel: '仍然退出', cancelLabel: '取消退出' },
            ).catch(() => true); // 弹不出对话框时不要把用户关在应用里
            if (!quitAnyway) return;
          }

          try {
            await fileService.flushUndoTrashDirs();
            const { stopMcpBridge } = await import('./services/mcp/mcpBridgeService');
            await stopMcpBridge().catch(() => {});
          } catch (error) {
            console.warn('[退出] 清理失败:', error);
          }
          await win.destroy();
        });
      } catch { /* non-Tauri env */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void initComfyUIWindowBridge()
      .then((cleanup) => {
        if (cancelled) cleanup();
        else dispose = cleanup;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error || '未知错误');
        useAppStore.getState().showToast(`ComfyUI 保存桥初始化失败：${message}`, 'error');
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
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

  // 配置为默认开启时自动拉起 MCP 会话（用固定令牌与固定端口，客户端配置不必每次改）
  useEffect(() => {
    if (!isTauri || !configHydrated || !mcpAutoStart) return;
    let cancelled = false;
    void (async () => {
      const [{ getMcpBridgeStatus }, { startConfiguredMcpBridge }] = await Promise.all([
        import('./services/mcp/mcpBridgeService'),
        import('./services/mcp/mcpSessionConfig'),
      ]);
      if (cancelled || await getMcpBridgeStatus()) return;
      await startConfiguredMcpBridge();
    })().catch((startError) => {
      // 端口被占用等失败必须说出来，否则用户只看到「已关闭」而不知道为什么
      useAppStore.getState().showToast(
        `MCP 自动开启失败：${startError instanceof Error ? startError.message : String(startError)}`,
        'error',
      );
    });
    return () => {
      cancelled = true;
    };
  }, [configHydrated, mcpAutoStart]);

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
    // 独立窗口模式是用户选择的显示偏好；窗口关闭后再次点击应重新打开独立窗口。
    if (store.chatPanelDetached) {
      try {
        await invoke('open_chat_window');
      } catch {
        store.showToast('打开独立窗口失败', 'error');
      }
      return;
    }
    // 内嵌面板：打开 ⇄ 关闭切换
    store.toggleChat();
  };

  // 同步主题到 document.documentElement，供 CSS [data-theme] 选择器生效
  // 米白色背景时自动切换为 light，其余背景使用用户手动设置的主题
  const configTheme = useAppStore((s) => s.config.theme);
  const canvasBackground = useAppStore((s) => s.config.canvasBackground);
  const windowGlassFrame = useAppStore((s) => s.config.windowGlassFrame);
  const performanceMode = useAppStore((s) => s.config.performanceMode === true);
  const mascotVisible = useAppStore((s) => s.config.mascotVisible);
  // 任意节点处于生成中 → 吉祥物切换为 LOADING 形态
  const mascotLoading = useAppStore(selectMascotLoading);
  const mascotStatus = useMascotStatus();
  const effectiveTheme = canvasBackground === 'off-white' ? 'light' : configTheme;
  const nativeCursor = useAppStore((s) => s.config.customCursor === false);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    return () => document.documentElement.removeAttribute('data-theme');
  }, [effectiveTheme]);

  // 关闭自定义指针时打标记，cursors.css 据此把 --cursor-* 清空、回落系统指针
  useEffect(() => {
    document.documentElement.toggleAttribute('data-native-cursor', nativeCursor);
    return () => document.documentElement.removeAttribute('data-native-cursor');
  }, [nativeCursor]);

  // 性能模式取消 CSS 自绘圆角后，由 Windows DWM 提供系统原生圆角。
  useEffect(() => {
    if (!isTauri) return;
    invoke('set_main_window_native_corners', { rounded: performanceMode }).catch(() => {});
  }, [performanceMode]);

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
  const showWindowGlassFrame = windowGlassFrame !== false && !isMaximized && !performanceMode;
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
          <ProjectSwitchOverlay />
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
        <LazyLoadBoundary label="角色库">
          <Suspense fallback={<LazyLoadFallback label="角色库" />}>
            {mountCharacters && <CharacterLibraryPanel />}
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
        <LazyLoadBoundary label="反推提示词">
          <Suspense fallback={null}>
            {mountReversePrompt && <ReversePromptDialog />}
          </Suspense>
        </LazyLoadBoundary>
        <Toast />
      </div>
      {/* Sidebar — outside the overflow-hidden container so it's not clipped */}
      <Sidebar />

      {/* 剧集栏贴窗口右缘，和侧栏一样必须放在裁剪容器外面 */}
      <SeriesRail />

      {/* 吉祥物 — 可拖动浮层，默认隐藏，Ctrl+Shift+M 切换 */}
      {mascotVisible && (
        <LazyLoadBoundary label="吉祥物">
          <div
            ref={mascotDragConstraintsRef}
            className="pointer-events-none fixed inset-2 z-50"
          >
            <motion.div
              className="pointer-events-auto absolute left-0 top-0 h-[100px] w-[100px] touch-none"
              style={{ x: mascotX, y: mascotY }}
              drag={!mascotShrink}
              dragConstraints={mascotDragConstraintsRef}
              dragElastic={0}
              dragMomentum={false}
              onPointerDownCapture={handleMascotPointerDownCapture}
              onDragStart={handleMascotDragStart}
              onDrag={handleMascotDrag}
              onDragEnd={handleMascotDragEnd}
            >
              <motion.div
                className="h-full w-full"
                animate={mascotShrink
                  ? { scale: reduceMotion ? 1 : 0.94, opacity: 0 }
                  : { scale: 1, opacity: 1 }}
                transition={{ duration: reduceMotion ? 0.12 : 0.18, ease: [0.23, 1, 0.32, 1] }}
              >
                <button
                  type="button"
                  className="h-full w-full cursor-grab rounded-full border-0 bg-transparent p-0 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
                  onClick={(event) => {
                    if (consumeMascotDragClick(event)) return;
                    void handleMascotActivate();
                  }}
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
                        reduceMotion={performanceMode || Boolean(reduceMotion)}
                        getDragForce={getMascotDragForce}
                      />
                    )}
                  </Suspense>
                </button>
              </motion.div>
            </motion.div>
          </div>
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

      {splashDone && onboardingOpen && (
        <Suspense fallback={null}>
          <OnboardingDialog
            onClose={closeOnboarding}
            onOpenHelp={() => {
              closeOnboarding();
              useAppStore.getState().setHelpOpen(true);
            }}
          />
        </Suspense>
      )}

    </div>
  );

  return (
    <MotionConfig
      reducedMotion={performanceMode ? 'always' : 'user'}
      transition={performanceMode ? { duration: 0 } : undefined}
    >
      <>
        {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
        {appContent}
      </>
    </MotionConfig>
  );
}
