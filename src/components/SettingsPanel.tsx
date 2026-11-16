/**
 * SettingsPanel 设置面板 — 模态弹窗，管理常规、文件与应用、API Key、快捷键、ComfyUI 等设置
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import '../styles/settings.css';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import ModalOverlay from './shared/ModalOverlay';
import AnimatedButton from './shared/AnimatedButton';
import PopupCloseButton from './shared/PopupCloseButton';
import ApiKeySettings from './settings/ApiKeySettings';
import StorageHealthCenter from './settings/StorageHealthCenter';
import DirectorDeskStorageManager from './settings/DirectorDeskStorageManager';
import OnnxModelStorageManager from './settings/OnnxModelStorageManager';
import McpSettings from './settings/McpSettings';
import SettingsNavigation from './settings/SettingsNavigation';
import ShortcutSettings from './settings/ShortcutSettings';
import CanvasZoomRangeSettings from './settings/CanvasZoomRangeSettings';
import ComfyUISettings from './settings/ComfyUISettings';
import FileAppSettings from './settings/FileAppSettings';
import PluginSettings from './settings/PluginSettings';
import AppearanceSettings from './settings/AppearanceSettings';
import type {
  InteractionMode,
  NodeToolbarMode,
  StartupView,
  WindowAspectRatio,
} from '../types';

import type { SettingsTab } from '../store/store.ui';
import { LOCALES, LOCALE_LABELS, getLocale, useT } from '../i18n';
import { applyNativePerformanceMode, isNativePerformanceModeSupported } from '../services/nativePerformanceModeService';
import { applyMainWindowWorkArea } from '../services/mainWindowBoundsService';

const SharedAssetStorageSettings = lazy(() => import('./settings/SharedAssetStorageSettings'));
const ExternalAgentSettings = lazy(() => import('./settings/ExternalAgentSettings'));

/** 窗口尺寸预设：每种比例给紧凑 / 标准 / 大屏三档主流尺寸 */
const WINDOW_ASPECT_OPTIONS: {
  id: WindowAspectRatio;
  presets: { w: number; h: number; label: string }[];
}[] = [
  { id: '16:9',  presets: [{ w: 1280, h: 720, label: '紧凑' }, { w: 1600, h: 900, label: '标准' }, { w: 1920, h: 1080, label: '大屏' }] },
  { id: '16:10', presets: [{ w: 1280, h: 800, label: '紧凑' }, { w: 1440, h: 900, label: '标准' }, { w: 1680, h: 1050, label: '大屏' }] },
  { id: '4:3',   presets: [{ w: 1024, h: 768, label: '紧凑' }, { w: 1280, h: 960, label: '标准' }, { w: 1440, h: 1080, label: '大屏' }] },
];

/** 把主窗口设成指定逻辑尺寸；超出当前显示器可视范围时等比缩小，避免窗口大到没法操作 */
async function applyWindowSize(width: number, height: number): Promise<void> {
  try {
    const { getCurrentWindow, LogicalSize, currentMonitor } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (await win.isFullscreen()) await win.setFullscreen(false);
    if (await win.isMaximized()) await win.unmaximize();

    const monitor = await currentMonitor();
    if (monitor && /Macintosh|Mac OS X/.test(navigator.userAgent)) {
      await applyMainWindowWorkArea(win, monitor, {
        size: { width, height }, ratio: width / height, center: true,
      });
    } else {
      let w = width;
      let h = height;
      if (monitor) {
        const maxW = monitor.size.width / monitor.scaleFactor - 40;
        const maxH = monitor.size.height / monitor.scaleFactor - 80;
        const scale = Math.min(1, maxW / w, maxH / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      await win.setSize(new LogicalSize(w, h));
      await win.center();
    }
  } catch (error) {
    // 权限没配全时 Tauri 会直接 reject，静默 catch 会让人以为按钮没反应
    console.warn('[窗口尺寸] 设置失败:', error);
  }
}

const INTERACTION_MODE_OPTIONS: {
  id: InteractionMode;
  title: string;
  badge: string;
  description: string;
  gestures: { key: string; action: string }[];
}[] = [
  {
    id: 'default',
    title: 'Figma 模式',
    badge: '选择优先',
    description: '左键框选，滚轮直接缩放，适合高频编辑节点',
    gestures: [
      { key: '左键拖动', action: '框选节点' },
      { key: '右键 / 中键', action: '平移画布' },
      { key: '滚轮', action: '缩放画布' },
      { key: 'Shift + 点击', action: '追加多选' },
      { key: '右键轻点', action: '打开菜单' },
    ],
  },
  {
    id: 'classic',
    title: '经典模式',
    badge: '导航优先',
    description: '左键拖动画布，组合键缩放，适合大范围浏览',
    gestures: [
      { key: '左键拖动', action: '平移画布' },
      { key: 'Shift + 左键', action: '框选节点' },
      { key: '滚轮', action: '垂直平移' },
      { key: 'Shift + 滚轮', action: '水平平移' },
      { key: 'Ctrl + 滚轮', action: '缩放画布' },
      { key: '鼠标右键', action: '打开菜单' },
    ],
  },
];

const NODE_TOOLBAR_MODE_OPTIONS: {
  id: NodeToolbarMode;
  label: string;
  icon: string;
}[] = [
  { id: 'icons', label: '极简图标', icon: 'lucide:circle-dot' },
  { id: 'icons-and-text', label: '图标 + 文本', icon: 'lucide:panel-top' },
];

const STARTUP_VIEW_OPTIONS: {
  id: StartupView;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    id: 'last-project',
    label: '上次画布',
    description: '恢复关闭软件时正在编辑的项目',
    icon: 'lucide:history',
  },
  {
    id: 'project-library',
    label: '项目列表',
    description: '启动后先选择要打开的项目',
    icon: 'lucide:layout-grid',
  },
];

export default function SettingsPanel() {
  const t = useT();
  const locale = getLocale();
  const saveStatus = useAppStore((s) => s.configSaveStatus);
  const saveError = useAppStore((s) => s.configSaveError);
  const configHydrated = useAppStore((s) => s.configHydrated);
  const unreadSecretCount = useAppStore((s) => s.configSecretReadErrors?.length ?? 0);
  const { settingsOpen, setSettingsOpen, settingsInitialTab, setSettingsInitialTab, config, updateConfig, saveConfig, showToast } =
    useAppStore(
      useShallow((s) => ({
        settingsOpen: s.settingsOpen,
        setSettingsOpen: s.setSettingsOpen,
        settingsInitialTab: s.settingsInitialTab,
        setSettingsInitialTab: s.setSettingsInitialTab,
        config: s.config,
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
        showToast: s.showToast,
      })),
    );
  const persist = async () => {
    try { await saveConfig(); return true; } catch { return false; }
  };
  const reload = async () => {
    if (useAppStore.getState().configDirty) {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      if (!await ask(t('重新加载会放弃当前未保存的设置，是否继续？'), {
        title: t('重新加载设置'), kind: 'warning', okLabel: t('重新加载'), cancelLabel: t('取消'),
      }).catch(() => false)) return;
    }
    await useAppStore.getState().loadConfig().catch(() => {});
  };
  const sidebarFloating = config.sidebarFloating === true; // 默认关闭
  const configuredWindowGlassFrame = config.windowGlassFrame !== false; // 默认开启
  const performanceMode = config.performanceMode === true;
  const [performanceApplying, setPerformanceApplying] = useState(false);
  const applyPerformanceMode = async (enabled: boolean) => {
    setPerformanceApplying(true);
    try {
      await applyNativePerformanceMode(enabled);
      if (!enabled && isNativePerformanceModeSupported()) showToast(t('已关闭性能模式，原生图形设置将在下次启动时恢复'));
    } catch (error) {
      showToast(t(error instanceof Error ? error.message : '图形启动设置保存失败，未重启'), 'error');
    } finally { setPerformanceApplying(false); }
  };
  const windowAspectRatio = config.windowAspectRatio ?? '16:9';
  const windowAspectLocked = config.windowAspectLocked === true;
  // 当前窗口实际尺寸 —— 用来给尺寸预设标出选中态
  const [currentWindowSize, setCurrentWindowSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const read = async () => {
          const size = (await win.innerSize()).toLogical(await win.scaleFactor());
          setCurrentWindowSize({ w: Math.round(size.width), h: Math.round(size.height) });
        };
        await read();
        const off = await win.onResized(() => { void read(); });
        if (disposed) off();
        else unlisten = off;
      } catch { /* 非 Tauri 环境（浏览器预览）忽略 */ }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [settingsOpen]);
  const windowGlassFrame = configuredWindowGlassFrame && !performanceMode;
  const interactionMode = config.interactionMode ?? 'default';
  const nodeToolbarMode = config.nodeToolbarMode ?? 'icons';
  const nodeLabelVisible = config.nodeLabelVisible !== false; // 默认开启
  const canvasNoteToolbarVisible = config.canvasNoteToolbarVisible !== false; // 默认开启
  const autoMentionOnConnect = config.autoMentionOnConnect !== false;
  const startupView = config.startupView ?? 'project-library';
  const activeInteractionMode = INTERACTION_MODE_OPTIONS.find((option) => option.id === interactionMode)
    ?? INTERACTION_MODE_OPTIONS[0];
  const [selectedTab, setSelectedTab] = useState<SettingsTab>('general');
  // 外部（如 Agent 保存厂商配置后）请求的标签页在渲染期直接生效，不用 effect 回写 state；
  // 用户手动切换即视为消费掉该请求（关闭面板时 store 也会清空它）
  const activeTab = (settingsOpen ? settingsInitialTab : null) ?? selectedTab;
  const selectTab = (tab: SettingsTab) => {
    setSelectedTab(tab);
    setSettingsInitialTab(null);
  };

  return (
    <ModalOverlay
      isOpen={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      ariaLabel={t('设置')}
      className="w-[min(900px,90vw)] h-[90vh] max-h-[940px] rounded-2xl settings-modal-shell ui-dialog-surface border ring-1 ring-black/5 shadow-2xl"
      closeOnBackdrop={false}
    >
        {/* Header */}
        <div className="flex items-center justify-between px-2.5 py-2 bg-canvas-surface border-b border-canvas-border settings-modal-header select-none shrink-0 z-20">
          <h2 className="text-[17px] font-semibold text-canvas-text settings-modal-header-title tracking-tight leading-none">{t('设置')}</h2>
          <PopupCloseButton
            ariaLabel={t('关闭设置')}
            onClick={() => setSettingsOpen(false)}
          />
        </div>
        {(saveError || !configHydrated || unreadSecretCount > 0 || (activeTab !== 'appearance' && saveStatus !== 'idle' && saveStatus !== 'saved')) && (
        <div role="status" className={`ui-alert ${saveStatus === 'error' || saveStatus === 'conflict' ? 'ui-alert--danger' : 'ui-alert--info'} mx-3 my-2`} data-settings-persistence>
          <div className="ui-alert__body flex-1">
            {saveError ?? t(saveStatus === 'saving' ? '正在保存设置…' : saveStatus === 'dirty' ? '有未保存的设置'
              : saveStatus === 'saved' ? '设置已保存' : configHydrated ? '设置已加载' : '设置尚未加载完成')}
          </div>
          {(saveStatus === 'error' || saveStatus === 'dirty') && configHydrated && (
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => void persist()}>{t('重试保存')}</button>
          )}
          {(saveStatus === 'conflict' || !configHydrated || unreadSecretCount > 0) && (
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => void reload()}>{t('重新加载')}</button>
          )}
        </div>
        )}

        <div className="flex flex-1 min-h-0">
          <SettingsNavigation activeTab={activeTab} onSelect={selectTab} />

          {/* Content */}
          <div className={`settings-content flex-1 overflow-y-auto overflow-x-hidden ${activeTab === 'appearance' ? 'p-0' : 'p-4 sm:p-6'}`}>
            {activeTab === 'api' && (
              <ApiKeySettings onClose={() => setSettingsOpen(false)} />
            )}

            {activeTab === 'comfyui' && <ComfyUISettings />}

            {activeTab === 'appearance' && <AppearanceSettings />}

            {activeTab === 'general' && (
              <div className="space-y-4">
                <section>
                  <h3 className="mb-2 text-sm font-medium text-canvas-text">{t('界面语言')}</h3>
                  <div
                    className="grid grid-cols-4 gap-1 rounded-lg border border-canvas-border bg-canvas-card p-1"
                    role="radiogroup"
                    aria-label={t('界面语言')}
                  >
                    {LOCALES.map((code) => {
                      const active = locale === code;
                      return (
                        <AnimatedButton
                          key={code}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={async () => {
                            if (active) return;
                            updateConfig({ language: code });
                            if (!await persist()) return;
                          }}
                          className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors ${
                            active
                              ? 'bg-brand/15 text-brand-light shadow-sm'
                              : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                          }`}
                        >
                          <span>{LOCALE_LABELS[code]}</span>
                        </AnimatedButton>
                      );
                    })}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-canvas-text">{t('启动时打开')}</h3>
                  <div
                    className="grid grid-cols-2 gap-2"
                    role="radiogroup"
                    aria-label={t('软件启动时打开')}
                  >
                    {STARTUP_VIEW_OPTIONS.map((option) => {
                      const active = startupView === option.id;
                      return (
                        <AnimatedButton
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={async () => {
                            if (active) return;
                            updateConfig({ startupView: option.id });
                            if (!await persist()) return;
                          }}
                          className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                            active
                              ? 'border-brand bg-brand/10 text-brand-light'
                              : 'border-canvas-border bg-canvas-card text-canvas-text-secondary hover:border-canvas-hover'
                          }`}
                        >
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                              active ? 'bg-brand/15' : 'bg-canvas-surface'
                            }`}
                            aria-hidden="true"
                          >
                            <Icon icon={option.icon} width="16" height="16" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-canvas-text">{t(option.label)}</span>
                            <span className="mt-1 block whitespace-nowrap text-[11px] leading-4 text-canvas-text-muted">
                              {t(option.description)}
                            </span>
                          </span>
                        </AnimatedButton>
                      );
                    })}
                  </div>
                </section>

                {/* 应用窗口大小 */}
                <section>
                  <h3 className="mb-2 text-sm font-medium text-canvas-text">{t('应用窗口大小')}</h3>
                  <div
                    className="mb-2 grid grid-cols-3 gap-1 rounded-lg border border-canvas-border bg-canvas-card p-1"
                    role="radiogroup"
                    aria-label={t('窗口比例')}
                  >
                    {WINDOW_ASPECT_OPTIONS.map(({ id }) => {
                      const active = windowAspectRatio === id;
                      return (
                        <AnimatedButton
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={async () => {
                            if (active) return;
                            updateConfig({ windowAspectRatio: id });
                            if (!await persist()) return;
                          }}
                          className={`flex h-9 items-center justify-center rounded-md text-xs font-medium transition-colors ${
                            active
                              ? 'bg-brand/15 text-brand-light shadow-sm'
                              : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                          }`}
                        >
                          {id}
                        </AnimatedButton>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('应用窗口大小')}>
                    {(WINDOW_ASPECT_OPTIONS.find((o) => o.id === windowAspectRatio) ?? WINDOW_ASPECT_OPTIONS[0]).presets.map(({ w, h, label }) => {
                      // 允许 2px 误差：DPI 缩放下取整会差一点
                      const active = currentWindowSize != null
                        && Math.abs(currentWindowSize.w - w) <= 2
                        && Math.abs(currentWindowSize.h - h) <= 2;
                      return (
                        <AnimatedButton
                          key={`${w}x${h}`}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => { void applyWindowSize(w, h); }}
                          className={`flex flex-col items-center gap-0.5 rounded-lg border px-2 py-2 transition-colors ${
                            active
                              ? 'border-brand bg-brand/10'
                              : 'border-canvas-border bg-canvas-card hover:border-canvas-hover'
                          }`}
                        >
                          <span className={`text-xs font-medium ${active ? 'text-brand-light' : 'text-canvas-text'}`}>{w} × {h}</span>
                          <span className={`text-[11px] ${active ? 'text-brand-light/70' : 'text-canvas-text-muted'}`}>{t(label)}</span>
                        </AnimatedButton>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ windowAspectLocked: !windowAspectLocked });
                      void persist();
                    }}
                    aria-pressed={windowAspectLocked}
                    className={`sidebar-pref-card mt-2${windowAspectLocked ? ' is-floating' : ''}`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        windowAspectLocked ? 'bg-brand/15 text-brand-light' : 'bg-canvas-surface text-canvas-text-secondary'
                      }`}
                      aria-hidden="true"
                    >
                      <Icon icon={windowAspectLocked ? 'mdi:lock-outline' : 'mdi:lock-open-variant-outline'} width="16" height="16" />
                    </span>

                    <div className="sidebar-pref-text">
                      <div className="sidebar-pref-title">{t('固定窗口比例')}</div>
                      <div className="sidebar-pref-desc">
                        {windowAspectLocked
                          ? t('拖拽缩放窗口时自动保持 {ratio}', { ratio: windowAspectRatio })
                          : t('拖拽缩放窗口时不限制宽高比')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </section>

                {/* Mac 也能切换模式，鼠标和触摸板按各自习惯选择。 */}
                <section className="canvas-interaction-settings">
                  <div className="canvas-interaction-heading">
                    <div>
                      <h3>{t('画布交互方式')}</h3>
                      <p>{t('选择更符合你操作习惯的画布手感')}</p>
                    </div>
                    <span>{t('即时生效')}</span>
                  </div>

                  <div className="canvas-interaction-mode-grid" role="radiogroup" aria-label={t('画布交互方式')}>
                    {INTERACTION_MODE_OPTIONS.map((opt) => {
                      const active = interactionMode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => {
                            updateConfig({ interactionMode: opt.id });
                            void persist();
                          }}
                          className={`canvas-interaction-mode-card${active ? ' is-active' : ''}`}
                        >
                          <div className={`canvas-interaction-preview is-${opt.id}`} aria-hidden="true">
                            <span className="canvas-preview-grid" />
                            <span className="canvas-preview-node node-a" />
                            <span className="canvas-preview-node node-b" />
                            {opt.id === 'default' ? (
                              <>
                                <span className="canvas-preview-selection">
                                  <i /><i /><i /><i />
                                </span>
                                <span className="canvas-preview-cursor">↖</span>
                              </>
                            ) : (
                              <>
                                <span className="canvas-preview-pan-axis axis-x" />
                                <span className="canvas-preview-pan-axis axis-y" />
                                <span className="canvas-preview-hand">✥</span>
                              </>
                            )}
                          </div>

                          <div className="canvas-interaction-mode-copy">
                            <div className="canvas-interaction-mode-title">
                              <strong>{t(opt.title)}</strong>
                              <span>{t(opt.badge)}</span>
                            </div>
                            <p>{t(opt.description)}</p>
                          </div>

                          <span className="canvas-interaction-check" aria-hidden="true">
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                              <path d="m2.4 6.1 2.1 2.1 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="canvas-interaction-gesture-map">
                    <div className="canvas-gesture-map-heading">
                      <div>
                        <span className="canvas-gesture-status-dot" />
                        {t('当前手势地图')}
                      </div>
                      <strong>{t(activeInteractionMode.title)}</strong>
                    </div>
                    <div className="canvas-gesture-grid">
                      {activeInteractionMode.gestures.map((gesture) => (
                        <div className="canvas-gesture-item" key={gesture.key}>
                          <kbd>{t(gesture.key)}</kbd>
                          <span>{t(gesture.action)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <CanvasZoomRangeSettings onPersist={persist} />

                {/* 节点顶部工具栏显示方式 */}
                <section>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('节点工具栏')}</h3>
                  <div
                    className="grid grid-cols-2 gap-1 rounded-lg border border-canvas-border bg-canvas-card p-1"
                    role="radiogroup"
                    aria-label={t('节点工具栏显示方式')}
                  >
                    {NODE_TOOLBAR_MODE_OPTIONS.map((option) => {
                      const active = nodeToolbarMode === option.id;
                      return (
                        <AnimatedButton
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={async () => {
                            updateConfig({ nodeToolbarMode: option.id });
                            if (!await persist()) return;
                          }}
                          className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors ${
                            active
                              ? 'bg-brand/15 text-brand-light shadow-sm'
                              : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text'
                          }`}
                        >
                          <Icon icon={option.icon} width="14" height="14" aria-hidden="true" />
                          <span>{t(option.label)}</span>
                        </AnimatedButton>
                      );
                    })}
                  </div>
                </section>

                {/* 画布笔记工具栏是否显示 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('画布笔记工具栏')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ canvasNoteToolbarVisible: !canvasNoteToolbarVisible });
                      void persist();
                    }}
                    aria-pressed={canvasNoteToolbarVisible}
                    className={`sidebar-pref-card${canvasNoteToolbarVisible ? ' is-floating' : ''}`}
                  >
                    <div className="sidebar-pref-window flex items-end justify-center pb-2" aria-hidden="true">
                      <div
                        className={`flex items-center gap-1 rounded-md border border-canvas-border bg-canvas-bg p-1 transition-opacity duration-200 ${
                          canvasNoteToolbarVisible ? 'opacity-100' : 'opacity-30'
                        }`}
                      >
                        <span className="h-3 w-3 rounded-[3px] bg-brand/60" />
                        <span className="h-3 w-3 rounded-[3px] border border-canvas-text-muted" />
                        <span className="h-3 w-3 rounded-full border border-canvas-text-muted" />
                      </div>
                    </div>

                    <div className="sidebar-pref-text">
                      <div className="sidebar-pref-title">{t('显示笔记工具栏')}</div>
                      <div className="sidebar-pref-desc">
                        {canvasNoteToolbarVisible
                          ? t('在画布左下角显示绘图与笔记工具')
                          : t('隐藏工具栏，已有笔记仍可编辑')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </div>

                <section>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('素材引用')}</h3>
                  <button
                    type="button"
                    role="switch"
                    aria-labelledby="auto-mention-on-connect-label"
                    aria-describedby="auto-mention-on-connect-desc"
                    aria-checked={autoMentionOnConnect}
                    className={`sidebar-pref-card${autoMentionOnConnect ? ' is-floating' : ''}`}
                    onClick={() => {
                      updateConfig({ autoMentionOnConnect: !autoMentionOnConnect });
                      void persist();
                    }}
                  >
                    <div className="sidebar-pref-window flex items-center justify-center gap-1 p-1.5" aria-hidden="true">
                      <span className="flex h-5 w-4 shrink-0 items-center justify-center rounded-[3px] border border-canvas-border bg-canvas-bg text-canvas-text-muted">
                        <Icon icon="mdi:image-outline" width="12" height="12" />
                      </span>
                      <span className="flex w-3 shrink-0 items-center text-canvas-text-muted">
                        <span className="h-px flex-1 bg-canvas-text-muted" />
                        <span className="text-[9px] leading-none">▸</span>
                      </span>
                      <span className="flex h-8 w-9 shrink-0 flex-col justify-center gap-1 rounded-[4px] border border-canvas-border bg-canvas-bg p-1">
                        <span className={`rounded-sm bg-indigo-500/15 px-0.5 text-[7px] leading-[10px] text-indigo-400 transition-opacity motion-reduce:transition-none ${autoMentionOnConnect ? 'opacity-100' : 'opacity-0'}`}>
                          @{t('素材')}
                        </span>
                        <span className="h-0.5 w-4 rounded-full bg-canvas-text-muted/40" />
                      </span>
                    </div>

                    <div className="sidebar-pref-text">
                      <div id="auto-mention-on-connect-label" className="sidebar-pref-title">{t('连线后自动 @ 素材')}</div>
                      <div id="auto-mention-on-connect-desc" className="sidebar-pref-desc">{t('新建连线时，将上游素材追加到生成节点的提示词中，已有引用不会重复添加。')}</div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </section>

                {/* 节点标题（node-label）是否显示 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('节点标题')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ nodeLabelVisible: !nodeLabelVisible });
                      void persist();
                    }}
                    aria-pressed={nodeLabelVisible}
                    className={`sidebar-pref-card${nodeLabelVisible ? ' is-floating' : ''}`}
                  >
                    {/* 迷你节点预览：顶部小标签 + 节点卡片 */}
                    <div className="sidebar-pref-window flex items-center justify-center pt-2" aria-hidden="true">
                      <div className="relative w-[52px]">
                        <div
                          className={`absolute -top-[9px] left-0 right-0 flex items-center gap-1 transition-opacity duration-200 ${
                            nodeLabelVisible ? 'opacity-100' : 'opacity-0'
                          }`}
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-brand/70" />
                          <span className="h-1 flex-1 rounded-full bg-canvas-border" />
                        </div>
                        <div className="h-7 w-full rounded-[5px] border border-canvas-border bg-canvas-bg" />
                      </div>
                    </div>

                    <div className="sidebar-pref-text">
                      <div className="sidebar-pref-title">{t('显示节点标题')}</div>
                      <div className="sidebar-pref-desc">
                        {nodeLabelVisible
                          ? t('节点上方显示类型图标与名称，双击可重命名')
                          : t('隐藏节点上方的标题栏，画布更简洁')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </div>

                {/* 主窗口玻璃外框 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('窗口外观')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ windowGlassFrame: !configuredWindowGlassFrame });
                      void persist();
                    }}
                    disabled={performanceMode}
                    aria-pressed={windowGlassFrame}
                    className={`sidebar-pref-card${windowGlassFrame ? ' is-floating' : ''}`}
                  >
                    <div
                      className={`sidebar-pref-window overflow-hidden${windowGlassFrame ? ' glass-bevel' : ''}`}
                      aria-hidden="true"
                    >
                      <div
                        className={`absolute flex items-center gap-2 overflow-hidden border border-canvas-border bg-canvas-bg px-2 transition-[inset,border-radius] duration-200 ${
                          windowGlassFrame ? 'inset-[5px] rounded-[5px]' : 'inset-0 rounded-[8px]'
                        }`}
                      >
                        <span className="h-6 w-1.5 shrink-0 rounded-sm bg-brand/35" />
                        <span className="h-1 flex-1 rounded-full bg-canvas-border" />
                      </div>
                    </div>

                    <div className="sidebar-pref-text">
                      <div className="sidebar-pref-title">{t('玻璃外框')}</div>
                      <div className="sidebar-pref-desc">
                        {performanceMode
                          ? t('性能模式下已关闭玻璃外框')
                          : windowGlassFrame
                            ? t('显示 5px 玻璃带与双层边缘高光')
                            : t('内容贴合窗口边缘，不显示外框')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </div>

                {/* 性能模式 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('图形与性能')}</h3>
                  <button
                    type="button"
                    onClick={() => { void applyPerformanceMode(!performanceMode); }}
                    disabled={!configHydrated || performanceApplying}
                    aria-busy={performanceApplying}
                    aria-pressed={performanceMode}
                    className={`sidebar-pref-card${performanceMode ? ' is-floating' : ''}`}
                  >
                    <div className="sidebar-pref-window overflow-hidden" aria-hidden="true">
                      <div
                        className={`absolute inset-[5px] rounded-[5px] border border-canvas-border px-2 py-1.5 transition-colors duration-200 ${
                          performanceMode
                            ? 'bg-canvas-surface'
                            : 'bg-canvas-surface/60 backdrop-blur-md'
                        }`}
                      >
                        <span className="block h-1 w-2/3 rounded-full bg-canvas-text-muted/50" />
                        <span className="mt-1.5 block h-3 rounded-[3px] bg-brand/20" />
                      </div>
                    </div>

                    <div className="sidebar-pref-text">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="sidebar-pref-title">{t('性能模式')}</div>
                        <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium leading-none text-amber-300">
                          {t('低配置省内存，界面闪烁时可开启')}
                        </span>
                      </div>
                      <div className="sidebar-pref-desc">
                        {performanceMode
                          ? t('使用轻量媒体预览和较小缓存，释放离屏媒体；关闭图片与动态背景、3D 吉祥物和装饰动画')
                          : t('保留完整视觉效果与界面动画')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                  <div className="mt-2 text-xs text-canvas-text-secondary">
                    {t('关闭后恢复原有背景与视觉设置，原图与生成内容不变。')}
                  </div>
                  {isNativePerformanceModeSupported() && (
                    <div className="mt-2 text-xs text-canvas-text-secondary">
                      {t('开启后将保存并自动重启，正在运行的任务会中断；关闭后下次启动恢复原生图形设置。')}
                      {performanceMode && <button type="button" className="ui-btn ui-btn--sm ml-2" disabled={performanceApplying} onClick={() => { void applyPerformanceMode(true); }}>
                        {t('重新应用')}
                      </button>}
                    </div>
                  )}
                </div>

                {/* 侧边栏是否悬浮显示 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('侧边栏')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ sidebarFloating: !sidebarFloating });
                      void persist();
                    }}
                    aria-pressed={sidebarFloating}
                    className={`sidebar-pref-card${sidebarFloating ? ' is-floating' : ''}`}
                  >
                    {/* 迷你界面预览：外框=界面，竖条=侧边栏 */}
                    <div className="sidebar-pref-window" aria-hidden="true">
                      <div className="sidebar-pref-content">
                        <span /><span /><span />
                      </div>
                      <div className="sidebar-pref-bar" />
                    </div>

                    <div className="sidebar-pref-text">
                      <div className="sidebar-pref-title">{t('悬浮显示')}</div>
                      <div className="sidebar-pref-desc">
                        {sidebarFloating
                          ? t('侧边栏半隐于窗口边缘，悬浮在画布之上')
                          : t('侧边栏停靠在窗口内侧')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'files' && <FileAppSettings active />}

            {activeTab === 'shortcuts' && <ShortcutSettings />}

            {activeTab === 'storage' && (
              <>
                <StorageHealthCenter />
                <DirectorDeskStorageManager />
                <OnnxModelStorageManager />
                <Suspense fallback={<p role="status" className="ui-hint">{t('正在加载项目云同步设置…')}</p>}><SharedAssetStorageSettings /></Suspense>
              </>
            )}

            {activeTab === 'mcp' && <McpSettings />}

            {activeTab === 'plugins' && <PluginSettings />}
            {activeTab === 'external-agents' && <Suspense fallback={<p role="status" className="ui-hint">{t('正在加载外部 Agent 设置…')}</p>}><ExternalAgentSettings /></Suspense>}
          </div>
        </div>
    </ModalOverlay>
  );
}
