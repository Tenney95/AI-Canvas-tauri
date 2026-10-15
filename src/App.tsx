/**
 * App 根组件 — 装配 Header / Sidebar / Canvas / NodeMenu / SettingsPanel / Titlebar / Toast / AINodeDialog / WorkflowPanel
 * Tauri 环境下启用自定义窗口装饰和透明圆角窗口
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MotionConfig, motion, useReducedMotion } from 'framer-motion';
import { Bot, Check, Download, Ellipsis, TriangleAlert } from 'lucide-react';
import Header from './components/Header';
import Titlebar from './components/Titlebar';
import SessionProjectTabs from './components/SessionProjectTabs';
import SeriesRail from './components/SeriesRail';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import NodeMenu from './components/NodeMenu';
import Toast from './components/Toast';
import ProjectLibraryModal from './components/ProjectLibraryModal';
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
import { checkForUpdate, downloadAndInstallUpdate, isAppUpdateRunning, type UpdateInfo } from './services/updateService';
import { DOWNLOAD_MASCOT_EVENT } from './components/shared/ModelDownloadDialog';
import UpdateBubble from './components/shared/mascot/UpdateBubble';
import HiddenFilmSet from './components/shared/mascot/HiddenFilmSet';
import { openDetachedChatWindow } from './services/chat/chatWindowLifecycle';
import LazyLoadBoundary, { LazyLoadFallback } from './components/shared/LazyLoadBoundary';
import ModalOverlay from './components/shared/ModalOverlay';
import { useMascotStatus } from './hooks/useMascotStatus';
import { useMascotLifecycle } from './hooks/useMascotLifecycle';
import { useMascotDrag } from './hooks/useMascotDrag';
// type-only：Mascot 是懒加载的，类型导入不会把它拖进主包
import type { MascotHandle } from './components/shared/mascot/Mascot';
import { initComfyUIWindowBridge } from './services/comfyUIWindowService';
import { initComfyRuntimeHostSync } from './services/comfyRuntimeHostSync';
import { invoke } from '@tauri-apps/api/core';
import { prepareSettingsClose, resumeSettingsPersistence } from './services/configPersistenceQueue';
import { applyNativePerformanceMode, registerPerformanceRestartHost } from './services/nativePerformanceModeService';
import { t } from './i18n';
import { applyAppearanceTheme, installSystemAppearanceListener, resolveAppearanceMode } from './services/appearance/appearanceRuntime';
import { getBuiltinAppearanceTheme, normalizeAppearanceTheme } from './services/appearance/appearanceDefaults';
import { getAppearanceForConfig } from './services/appearance/appearanceMigration';
import { installStyleGuideAppearanceSource } from './services/appearance/appearanceWindowSync';

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
const PresetManager = lazy(() => import('./components/nodes/shared/PresetManager'));
const PresetRunnerDialog = lazy(() => import('./components/nodes/shared/PresetRunnerDialog'));
const ReversePromptDialog = lazy(() => import('./components/nodes/shared/ReversePromptDialog'));
const DirectorDeskRuntimeManager = lazy(() => import('./components/director/DirectorDeskRuntimeManager'));
const FreeDistributionNoticeDialog = lazy(() => import('./components/FreeDistributionNoticeDialog'));
const OnboardingDialog = lazy(() => import('./components/OnboardingDialog'));

/** 免费发行提醒独立记忆；升级后的现有用户也会看到一次。 */
const FREE_DISTRIBUTION_NOTICE_SEEN_KEY = 'ai-canvas-free-distribution-notice-seen-v1';
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
      nodeDialogResetKey: JSON.stringify([state.currentProjectId, state.activeNodeId]),
      workflows: state.workflowPanelOpen,
      assets: state.assetsPanelOpen,
      characters: state.characterLibraryOpen || state.characterActionLibraryOpen,
      history: state.historyPanelOpen,
      chat: state.chatOpen || state.chatPanelDetached,
      presetManager: state.presetManagerOpen,
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
  const mountPresetManager = useFeatureMount(featureVisibility.presetManager);
  const mountPresetRunner = useFeatureMount(featureVisibility.presetRunner);
  const mountReversePrompt = useFeatureMount(featureVisibility.reversePrompt);

  // 开屏动画状态
  const [splashDone, setSplashDone] = useState(false);
  const [closePhase, setClosePhase] = useState<'saving' | 'closing' | 'restarting' | null>(null);
  const closeInProgress = useRef(false);
  const [freeDistributionNoticeOpen, setFreeDistributionNoticeOpen] = useState(
    () => localStorage.getItem(FREE_DISTRIBUTION_NOTICE_SEEN_KEY) !== 'true',
  );
  const acknowledgeFreeDistributionNotice = useCallback(() => {
    localStorage.setItem(FREE_DISTRIBUTION_NOTICE_SEEN_KEY, 'true');
    setFreeDistributionNoticeOpen(false);
  }, []);
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
  const updating = useAppStore((state) => isAppUpdateRunning(state.appUpdateProgress));
  const appUpdateMessage = useAppStore((state) => state.appUpdateProgress?.message);
  const appUpdateVersion = useAppStore((state) => state.appUpdateProgress?.version);
  const availableUpdateInfo = updateInfo ?? (appUpdateVersion ? { version: appUpdateVersion } : null);
  const configHydrated = useAppStore((state) => state.configHydrated);
  const projectLoadStatus = useAppStore((state) => state.projectLoadStatus);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const switchingProjectName = useAppStore((state) => state.switchingProjectName);
  const isCreatingProject = useAppStore((state) => state.isCreatingProject);
  const isReturningToStartPage = useAppStore((state) => state.isReturningToStartPage);
  const [canvasReadyProjectId, setCanvasReadyProjectId] = useState<string | null>(null);
  const [revealedProjectId, setRevealedProjectId] = useState<string | null>(null);
  const nativePerformanceSynced = useRef(false);
  const [projectBootReady, setProjectBootReady] = useState(false);
  const showCanvas = projectBootReady && currentProjectId !== null;
  const projectLoading = projectLoadStatus === 'loading' || switchingProjectName !== null || isCreatingProject || isReturningToStartPage;
  // 启动页没有挂载画布；再次打开同一项目也必须重新等待本次首帧。
  if (!showCanvas && (canvasReadyProjectId !== null || revealedProjectId !== null)) {
    setCanvasReadyProjectId(null);
    setRevealedProjectId(null);
  }
  const showProjectSplash = !splashDone || projectLoading || (showCanvas && revealedProjectId !== currentProjectId);
  const splashReady = projectBootReady && !projectLoading
    && (!showCanvas || canvasReadyProjectId === currentProjectId);
  const completeProjectSplash = useCallback(() => {
    setSplashDone(true);
    setRevealedProjectId(currentProjectId);
  }, [currentProjectId]);
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
    void initFromDb().then(() => setProjectBootReady(true));
  }, [initFromDb]);
  useEffect(() => {
    if (projectBootReady && currentProjectId && projectLoadStatus === 'ready') {
      void migrateHistoryAndLoad();
    }
  }, [currentProjectId, migrateHistoryAndLoad, projectBootReady, projectLoadStatus]);

  // 退出或保存后返回启动页期间，阻止画布快捷键继续编辑。
  useEffect(() => {
    if (!closePhase && !isReturningToStartPage) return;
    const blockKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockKeyDown, true);
    return () => window.removeEventListener('keydown', blockKeyDown, true);
  }, [closePhase, isReturningToStartPage]);

  // 性能模式重启与原生关闭共用互斥锁和输入遮罩；保存编排由服务负责。
  useEffect(() => registerPerformanceRestartHost(async (work) => {
    if (closeInProgress.current) throw new Error('窗口正在保存，请稍后重试');
    closeInProgress.current = true;
    try {
      flushSync(() => setClosePhase('restarting'));
      // 先展示遮罩，避免保存期间继续编辑；不依赖可能被遮挡节流的 rAF。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await work();
    } finally {
      closeInProgress.current = false;
      setClosePhase(null);
    }
  }), []);

  useEffect(() => {
    if (!isTauri || !splashDone || !projectBootReady || !configHydrated || projectLoadStatus !== 'ready' || nativePerformanceSynced.current) return;
    nativePerformanceSynced.current = true;
    void applyNativePerformanceMode().catch((error: unknown) => {
      useAppStore.getState().showToast(t(error instanceof Error ? error.message : '图形启动设置保存失败，未重启'), 'error');
    });
  }, [configHydrated, projectBootReady, projectLoadStatus, splashDone]);

  // 保存与清理完成后再关闭窗口，全程展示反馈。
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closeInProgress.current) return;
          closeInProgress.current = true;
          try {
            flushSync(() => setClosePhase('saving'));
            // 给提示一次绘制机会；窗口隐藏时 rAF 可能暂停，用计时器兜底。
            await new Promise<void>((resolve) => {
              const timeout = window.setTimeout(() => {
                cancelAnimationFrame(frame);
                resolve();
              }, 100);
              const frame = requestAnimationFrame(() => {
                window.clearTimeout(timeout);
                window.setTimeout(resolve, 0);
              });
            });
            const store = useAppStore.getState();
            let settingsSaved = await prepareSettingsClose();
            while (!settingsSaved) {
              const { ask } = await import('@tauri-apps/plugin-dialog');
              const retry = await ask('部分设置或工具栏布局尚未保存。是否重试保存？', {
                title: '设置尚未保存', kind: 'warning', okLabel: '重试保存', cancelLabel: '其他选择',
              }).catch(() => false);
              if (retry) { settingsSaved = await prepareSettingsClose(true); continue; }
              const discard = await ask('退出会放弃本次尚未保存的设置。是否仍然退出？', {
                title: '确认放弃未保存的设置', kind: 'warning', okLabel: '放弃并退出', cancelLabel: '取消退出',
              }).catch(() => false);
              if (!discard) return;
              break;
            }
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

            setClosePhase('closing');
            try {
              await fileService.flushUndoTrashDirs();
              const { stopMcpBridge } = await import('./services/mcp/mcpBridgeService');
              await stopMcpBridge().catch(() => {});
            } catch (error) {
              console.warn('[退出] 清理失败:', error);
            }
            await win.destroy();
          } catch (error) {
            console.warn('[退出] 关闭窗口失败:', error);
            useAppStore.getState().showToast('关闭未完成，请重试', 'error');
          } finally {
            resumeSettingsPersistence();
            closeInProgress.current = false;
            setClosePhase(null);
          }
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
    if (!isTauri || !configHydrated) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void initComfyRuntimeHostSync()
      .then((cleanup) => {
        if (cancelled) cleanup();
        else dispose = cleanup;
      })
      .catch(() => {
        useAppStore.getState().showToast('ComfyUI 运行状态同步未能初始化，请重新打开应用后重试', 'error');
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [configHydrated]);

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
      .catch(() => {
        useAppStore.getState().showToast('MCP 控制器初始化失败，请重新加载应用后重试', 'error');
      });
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
    await downloadAndInstallUpdate(useAppStore.getState().setAppUpdateProgress);
  };
  const handleDismissUpdate = () => {
    setUpdateBubbleVisible(false);
  };
  const handleMascotActivate = async (forceDetached = false) => {
    const store = useAppStore.getState();
    // 独立窗口模式是用户选择的显示偏好；窗口关闭后再次点击应重新打开独立窗口。
    if (forceDetached || store.chatPanelDetached) {
      if (!isTauri) {
        store.showToast('独立窗口功能需要 Tauri 环境', 'info');
        return;
      }
      try {
        await openDetachedChatWindow();
      } catch (error) {
        const detail = error instanceof Error ? error.message : '';
        store.showToast(`打开独立窗口失败${detail ? `：${detail}` : ''}`, 'error');
      }
      return;
    }
    store.openChat();
  };

  // 同步完整外观快照到 document.documentElement，所有 CSS 组件从这里读取变量。
  const configTheme = useAppStore((s) => s.config.theme);
  const appearance = useAppStore((s) => s.config.appearance);
  const appearancePreview = useAppStore((s) => s.appearancePreview);
  const windowGlassFrame = useAppStore((s) => s.config.windowGlassFrame);
  const performanceMode = useAppStore((s) => s.config.performanceMode === true);
  const mascotVisible = useAppStore((s) => s.config.mascotVisible);
  // 任意节点处于生成中 → 吉祥物切换为 LOADING 形态
  const mascotLoading = useAppStore(selectMascotLoading);
  const mascotStatus = useMascotStatus();
  // 播放句柄：窗口失焦、待审批任务等事件通过它触发一次性动画片段
  const mascotHandleRef = useRef<MascotHandle | null>(null);
  // 性能模式仅保留静态助手入口，不挂载 WebGL 吉祥物或调度生命周期动画。
  useMascotLifecycle(mascotHandleRef, Boolean(mascotVisible) && !updating && !performanceMode);
  const mascotFeedback = updating
    ? t(appUpdateMessage ?? '正在下载更新')
    : mascotLoading
      ? t('生成中')
      : mascotStatus === 'thinking'
        ? t('处理中')
        : mascotStatus === 'success'
          ? t('已完成')
          : mascotStatus === 'error'
            ? t('失败')
            : t('画布助手');
  const StaticMascotIcon = updating
    ? Download
    : mascotStatus === 'success'
      ? Check
      : mascotStatus === 'error'
        ? TriangleAlert
        : mascotLoading || mascotStatus === 'thinking'
          ? Ellipsis
          : Bot;
  const effectiveTheme = resolveAppearanceMode(appearance?.mode ?? configTheme);
  const managedCanvasBackground = Boolean((appearancePreview ?? appearance)?.canvas);
  const nativeCursor = useAppStore((s) => s.config.customCursor === false);
  useEffect(() => installStyleGuideAppearanceSource(
    () => {
      const state = useAppStore.getState();
      return state.appearancePreview ?? getAppearanceForConfig(state.config);
    },
    (onChange) => useAppStore.subscribe((state, previous) => {
      if (state.appearancePreview !== previous.appearancePreview
        || state.config.appearance !== previous.config.appearance
        || state.config.theme !== previous.config.theme) onChange();
    }),
  ), []);
  useEffect(() => {
    const theme = appearancePreview ?? (appearance
      ? normalizeAppearanceTheme(appearance)
      : getBuiltinAppearanceTheme(effectiveTheme === 'light' ? 'standard-light' : 'standard-dark'));
    applyAppearanceTheme(theme);
    return installSystemAppearanceListener(() => applyAppearanceTheme(theme));
  }, [appearance, appearancePreview, effectiveTheme]);

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

  // 侧边栏悬浮显示开关（默认关闭）；最大化时强制非悬浮。
  // 同步到 body 属性，供 CSS 切换侧边栏停靠/悬浮位置 + 弹窗蒙层的左偏移
  const sidebarFloatingCfg = useAppStore((s) => s.config.sidebarFloating);
  const effectiveFloating = showCanvas && sidebarFloatingCfg === true && !isMaximized;
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
      <div className={`app-box app-shell__content absolute ${managedCanvasBackground ? 'bg-transparent' : 'bg-canvas-bg/[0.988]'} shadow-2xl overflow-hidden`}>
        {showCanvas ? (
          <div className="app-canvas-viewport absolute inset-0">
            <CanvasBackground />
            <Canvas key={currentProjectId} onReady={setCanvasReadyProjectId} />
          </div>
        ) : projectBootReady ? (
          <ProjectLibraryModal
            isOpen
            presentation="page"
            onClose={() => useAppStore.getState().setProjectLibraryOpen(false)}
          />
        ) : <LazyLoadFallback label="项目列表" />}
        {/* Top drag region */}
        <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 z-10" />
        {showCanvas && <Header />}
        <Titlebar />
        {showCanvas && <SessionProjectTabs />}
        {showCanvas && <NodeMenu />}
        <LazyLoadBoundary label="设置面板">
          <Suspense fallback={<LazyLoadFallback label="设置面板" />}>
            {mountSettings && <SettingsPanel />}
          </Suspense>
        </LazyLoadBoundary>
        <LazyLoadBoundary label="节点编辑器" resetKey={featureVisibility.nodeDialogResetKey}>
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
        <LazyLoadBoundary label="快捷指令管理器">
          <Suspense fallback={<LazyLoadFallback label="快捷指令管理器" />}>
            {mountPresetManager && <PresetManager />}
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
      {showCanvas && <Sidebar />}

      {/* 剧集栏贴窗口右缘，和侧栏一样必须放在裁剪容器外面 */}
      {showCanvas && <SeriesRail />}

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
                transition={{ duration: performanceMode ? 0 : reduceMotion ? 0.12 : 0.18, ease: [0.23, 1, 0.32, 1] }}
              >
                <HiddenFilmSet
                  available={!performanceMode && !mascotShrink && !updating && !mascotLoading && mascotStatus === 'idle'}
                  reduceMotion={performanceMode || Boolean(reduceMotion)}
                  mascotHandleRef={mascotHandleRef}
                  consumeDragClick={consumeMascotDragClick}
                  type="button"
                  className="h-full w-full cursor-grab rounded-full border-0 bg-transparent p-0 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
                  onClick={() => {
                    void handleMascotActivate();
                  }}
                  onDoubleClick={() => {
                    void handleMascotActivate(true);
                  }}
                  disabled={mascotShrink}
                  aria-label={updating
                    ? `打开画布助手，${mascotFeedback}`
                    : mascotLoading
                      ? '打开画布助手，正在生成'
                      : mascotStatus === 'thinking'
                        ? '打开画布助手，正在思考'
                        : mascotStatus === 'success'
                          ? '打开画布助手，任务已完成'
                          : mascotStatus === 'error'
                            ? '打开画布助手，任务失败'
                            : '打开画布助手'}
                  data-tooltip={updating
                    ? mascotFeedback
                    : mascotLoading
                      ? t('生成中')
                      : mascotStatus === 'thinking'
                        ? '画布助手：思考中'
                        : mascotStatus === 'success'
                          ? '画布助手：已完成'
                          : mascotStatus === 'error'
                            ? '画布助手：任务失败'
                            : '打开画布助手'}
                >
                  {performanceMode ? (
                    <span className="ui-card flex h-full w-full flex-col items-center justify-center gap-1 p-2">
                      <StaticMascotIcon
                        size={32}
                        className={mascotStatus === 'error' ? 'text-danger-light' : mascotStatus === 'success' ? 'text-success-light' : 'text-brand-light'}
                        aria-hidden="true"
                      />
                      <span role="status" aria-live="polite" className="max-w-full truncate text-xs text-canvas-text-secondary">
                        {mascotFeedback}
                      </span>
                    </span>
                  ) : (
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
                          handleRef={mascotHandleRef}
                        />
                      )}
                    </Suspense>
                  )}
                </HiddenFilmSet>
              </motion.div>
            </motion.div>
          </div>
        </LazyLoadBoundary>
      )}

      {/* 更新聊天气泡 — 悬停在吉祥物左上方 */}
      {availableUpdateInfo && (
        <UpdateBubble
          info={availableUpdateInfo}
          visible={updateBubbleVisible || updating}
          onUpdate={() => { handleUpdateNow(); }}
          onDismiss={handleDismissUpdate}
          updating={updating}
        />
      )}

      <Suspense fallback={null}>
        <DirectorDeskRuntimeManager />
      </Suspense>

      {splashDone && freeDistributionNoticeOpen && (
        <Suspense fallback={null}>
          <FreeDistributionNoticeDialog onAcknowledge={acknowledgeFreeDistributionNotice} />
        </Suspense>
      )}

      {splashDone && !freeDistributionNoticeOpen && onboardingOpen && (
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
        {showProjectSplash && (
          <SplashScreen
            ready={splashReady}
            label={isReturningToStartPage ? 'AI Canvas 正在返回启动页' : splashDone ? 'AI Canvas 正在打开项目' : 'AI Canvas 正在启动'}
            onComplete={completeProjectSplash}
          />
        )}
        {appContent}
        <ModalOverlay
          isOpen={closePhase !== null}
          onClose={() => {}}
          closeOnBackdrop={false}
          motionPreset="quick"
          backdropBlur={false}
          ariaLabel="正在关闭软件"
          className="w-80 max-w-[calc(100vw-2rem)] p-6"
        >
          <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-col items-center gap-3 text-center">
            <span
              aria-hidden="true"
              className="h-7 w-7 animate-spin rounded-full border-2 border-canvas-border border-t-canvas-text-secondary motion-reduce:animate-none"
            />
            <p className="text-sm font-medium text-canvas-text">
              {closePhase === 'restarting' ? t('正在保存并重启，应用性能模式…') : closePhase === 'closing' ? '正在关闭…' : '正在保存，准备关闭…'}
            </p>
            <p className="text-xs text-canvas-text-secondary">{closePhase === 'restarting' ? t('完成后将自动重新打开，请稍候') : '完成后将自动退出，请稍候'}</p>
          </div>
        </ModalOverlay>
      </>
    </MotionConfig>
  );
}
