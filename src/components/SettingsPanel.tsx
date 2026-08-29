/**
 * SettingsPanel 设置面板 — 模态弹窗，管理常规、文件与应用、API Key、快捷键、ComfyUI 等设置
 */
import { useEffect, useRef, useState } from 'react';
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
import McpControlSettings from './settings/McpControlSettings';
import SettingsNavigation from './settings/SettingsNavigation';
import ShortcutSettings from './settings/ShortcutSettings';
import ComfyUISettings from './settings/ComfyUISettings';
import FileAppSettings from './settings/FileAppSettings';
import PluginSettings from './settings/PluginSettings';
import { BACKGROUND_OPTIONS } from './backgrounds/backgroundOptions';
import { detectBackgroundBrightness, compressImageLossless } from '../services/backgroundService';
import type {
  CanvasBackground as CanvasBg,
  InteractionMode,
  NodeToolbarMode,
  StartupView,
  WindowAspectRatio,
} from '../types';
import type { BackgroundDetection } from '../services/backgroundService';

import type { SettingsTab } from '../store/store.ui';
import { LOCALES, LOCALE_LABELS, getLocale, useT } from '../i18n';

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

    let w = width;
    let h = height;
    const monitor = await currentMonitor();
    if (monitor) {
      const maxW = monitor.size.width / monitor.scaleFactor - 40;
      const maxH = monitor.size.height / monitor.scaleFactor - 80;
      const scale = Math.min(1, maxW / w, maxH / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    await win.setSize(new LogicalSize(w, h));
    await win.center();
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

const IS_MAC = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);

/** 格式化字节为可读大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SettingsPanel() {
  const t = useT();
  const locale = getLocale();
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
  const sidebarFloating = config.sidebarFloating === true; // 默认关闭
  const configuredWindowGlassFrame = config.windowGlassFrame !== false; // 默认开启
  const performanceMode = config.performanceMode === true;
  const windowAspectRatio = config.windowAspectRatio ?? '16:9';
  const windowAspectLocked = config.windowAspectLocked === true;
  const customCursor = config.customCursor !== false; // 默认开启
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
  const startupView = config.startupView ?? 'last-project';
  const activeInteractionMode = INTERACTION_MODE_OPTIONS.find((option) => option.id === interactionMode)
    ?? INTERACTION_MODE_OPTIONS[0];
  const [selectedTab, setSelectedTab] = useState<SettingsTab>('general');
  const [bgUploading, setBgUploading] = useState(false);
  const [bgDetection, setBgDetection] = useState<BackgroundDetection | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 外部（如 Agent 保存厂商配置后）请求的标签页在渲染期直接生效，不用 effect 回写 state；
  // 用户手动切换即视为消费掉该请求（关闭面板时 store 也会清空它）
  const activeTab = (settingsOpen ? settingsInitialTab : null) ?? selectedTab;
  const selectTab = (tab: SettingsTab) => {
    setSelectedTab(tab);
    setSettingsInitialTab(null);
  };

  /** 处理背景图片文件选择：无损压缩 → 自动识别深色/浅色 */
  const handleBgFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 只允许图片格式
    if (!file.type.startsWith('image/')) {
      showToast(t('请选择图片文件'), 'error');
      return;
    }

    setBgUploading(true);
    setBgDetection(null);
    try {
      // 1. 无损压缩
      const compression = await compressImageLossless(file);
      if (import.meta.env.DEV) {
        console.log(
          `[背景压缩] 原始: ${formatBytes(compression.originalSize)} → 最终: ${formatBytes(compression.compressedSize)}` +
          (compression.keptOriginal
            ? ` (保留原图, 重编码会增大)`
            : compression.compressionRatio > 0
              ? ` (缩减 ${compression.compressionRatio}%, 格式: ${compression.format.toUpperCase()})`
              : ` (已最优, 格式: ${compression.format.toUpperCase()})`),
        );
      }

      // 2. 自动识别深色/浅色
      const detection = await detectBackgroundBrightness(compression.dataUrl);
      setBgDetection(detection);

      updateConfig({
        canvasBackground: 'custom',
        customBackgroundUrl: compression.dataUrl,
        customBackgroundIsDark: detection.isDark,
        theme: detection.isDark ? config.theme : 'light',
      });
      await saveConfig();

      const sizeLabel = formatBytes(compression.compressedSize);
      const ratioLabel = compression.keptOriginal
        ? t('（保留原图，重编码会增大）')
        : compression.compressionRatio > 0
          ? t('（缩减 {ratio}%，{format}）', { ratio: compression.compressionRatio, format: compression.format.toUpperCase() })
          : t('（已最优，{format}）', { format: compression.format.toUpperCase() });
      showToast(t('{tone}背景 · {size} {ratio}', {
        tone: detection.isDark ? t('深色') : t('浅色'),
        size: sizeLabel,
        ratio: ratioLabel,
      }), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('背景图片处理失败'), 'error');
    } finally {
      setBgUploading(false);
      // 重置 input 以允许重复选择同一文件
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** 移除自定义背景 */
  const handleRemoveCustomBg = async () => {
    updateConfig({
      canvasBackground: 'default',
      customBackgroundUrl: undefined,
      customBackgroundIsDark: undefined,
    });
    setBgDetection(null);
    await saveConfig();
    showToast(t('已恢复默认背景'));
  };

  return (
    <ModalOverlay
      isOpen={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      ariaLabel={t('设置')}
      className="w-[640px] h-[80vh]"
      closeOnBackdrop={false}
    >
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-canvas-border">
          <h2 className="text-base font-semibold text-canvas-text">{t('设置')}</h2>
          <PopupCloseButton
            ariaLabel={t('关闭设置')}
            onClick={() => setSettingsOpen(false)}
          />
        </div>

        <div className="flex flex-1 min-h-0">
          <SettingsNavigation activeTab={activeTab} onSelect={selectTab} />

          {/* Content */}
          <div className="settings-content flex-1 overflow-y-auto overflow-x-hidden p-3">
            {activeTab === 'api' && (
              <ApiKeySettings onClose={() => setSettingsOpen(false)} />
            )}

            {activeTab === 'comfyui' && <ComfyUISettings />}

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
                            await saveConfig();
                          }}
                          className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors ${
                            active
                              ? 'bg-indigo-500/15 text-indigo-400 shadow-sm'
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
                            await saveConfig();
                          }}
                          className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                            active
                              ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400'
                              : 'border-canvas-border bg-canvas-card text-canvas-text-secondary hover:border-canvas-hover'
                          }`}
                        >
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                              active ? 'bg-indigo-500/15' : 'bg-canvas-surface'
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
                            await saveConfig();
                          }}
                          className={`flex h-9 items-center justify-center rounded-md text-xs font-medium transition-colors ${
                            active
                              ? 'bg-indigo-500/15 text-indigo-400 shadow-sm'
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
                              ? 'border-indigo-500 bg-indigo-500/10'
                              : 'border-canvas-border bg-canvas-card hover:border-canvas-hover'
                          }`}
                        >
                          <span className={`text-xs font-medium ${active ? 'text-indigo-400' : 'text-canvas-text'}`}>{w} × {h}</span>
                          <span className={`text-[11px] ${active ? 'text-indigo-400/70' : 'text-canvas-text-muted'}`}>{t(label)}</span>
                        </AnimatedButton>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ windowAspectLocked: !windowAspectLocked });
                      saveConfig();
                    }}
                    aria-pressed={windowAspectLocked}
                    className={`sidebar-pref-card mt-2${windowAspectLocked ? ' is-floating' : ''}`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        windowAspectLocked ? 'bg-indigo-500/15 text-indigo-400' : 'bg-canvas-surface text-canvas-text-secondary'
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

                {/* 画布背景主题 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('画布背景')}</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {BACKGROUND_OPTIONS.map(({ value, label, theme }) => {
                      const isActive = (config.canvasBackground || 'default') === value;
                      return (
                        <AnimatedButton
                          key={value}
                          onClick={async () => {
                            if (value === 'custom') {
                              if (config.customBackgroundUrl) {
                                updateConfig({
                                  canvasBackground: 'custom',
                                  theme: config.customBackgroundIsDark ? config.theme : 'light',
                                });
                                await saveConfig();
                              } else {
                                fileInputRef.current?.click();
                              }
                              return;
                            }
                            updateConfig({ canvasBackground: value as CanvasBg, theme });
                            setBgDetection(null);
                            await saveConfig();
                          }}
                          className={`flex flex-col items-center gap-1.5 p-1 rounded-lg border transition-colors ${
                            isActive
                              ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400'
                              : 'border-canvas-border bg-canvas-card text-canvas-text-secondary hover:border-canvas-hover'
                          }`}
                        >
                          {/* 预览缩略图 */}
                          <div className={`w-full h-12 rounded overflow-hidden border border-canvas-border flex items-center justify-center ${
                            value === 'default'
                              ? 'bg-[#0a0a1a]'
                              : value === 'solar-system'
                              ? 'bg-gradient-to-br from-[#0a0a1a] via-[#1a1030] to-[#0a1020]'
                              : value === 'nebula'
                              ? 'bg-gradient-to-b from-[#0a0514] via-[#14081e] to-[#0a0514]'
                              : value === 'off-white'
                              ? 'bg-[#F4F6FB]'
                              : value === 'frosted-glass'
                              ? 'canvas-bg-frosted-preview'
                              : value === 'custom'
                              ? (config.customBackgroundUrl
                                ? ''
                                : 'bg-canvas-surface')
                              : 'bg-black'
                          }`}
                          style={
                            value === 'custom' && config.customBackgroundUrl
                              ? { backgroundImage: `url(${config.customBackgroundUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                              : undefined
                          }>
                            {value === 'default' && (
                              <div className="w-full h-full" style={{
                                backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)',
                                backgroundSize: '8px 8px',
                              }} />
                            )}
                            {value === 'solar-system' && (
                              <div className="w-full h-full flex items-center justify-center relative">
                                <div className="w-5 h-5 rounded-full bg-gradient-to-br from-purple-400 to-orange-400 opacity-80 shadow-lg shadow-orange-500/30" />
                                <div className="absolute bottom-1 left-0 right-0 flex justify-center">
                                  <div className="w-8 h-1 rounded-full" style={{ borderRadius: '50% 50% 0 0', borderTop: '1px solid var(--white-alpha-15)' }} />
                                </div>
                              </div>
                            )}
                            {value === 'nebula' && (
                              <div className="w-full h-full flex items-center justify-center gap-1.5 relative">
                                <div className="flex gap-1.5 opacity-60">
                                  <div className="w-2 h-3 rounded-sm bg-purple-600/60 blur-[2px]" />
                                  <div className="w-2 h-3 rounded-sm bg-fuchsia-600/50 blur-[2px]" />
                                  <div className="w-2 h-3 rounded-sm bg-violet-600/40 blur-[2px]" />
                                </div>
                                <div className="absolute inset-0" style={{
                                  backgroundImage: 'radial-gradient(1px 1px, rgba(180,150,255,0.3) 0%, transparent 100%)',
                                  backgroundSize: '12px 12px',
                                }} />
                              </div>
                            )}
                            {value === 'off-white' && (
                              <div className="w-full h-full" style={{
                                backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.06) 1px, transparent 1px)',
                                backgroundSize: '8px 8px',
                              }} />
                            )}
                            {value === 'custom' && !config.customBackgroundUrl && (
                              <>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-canvas-text-muted">
                                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                  <polyline points="17 8 12 3 7 8" />
                                  <line x1="12" y1="3" x2="12" y2="15" />
                                </svg>
                              </>
                            )}
                          </div>
                          <span className="text-[11px] font-medium">{t(label)}</span>
                        </AnimatedButton>
                      );
                    })}
                  </div>

                  {/* 自定义背景上传 & 检测结果 */}
                  {config.canvasBackground === 'custom' && config.customBackgroundUrl && (
                    <div className="mt-3 bg-canvas-card border border-canvas-border rounded-lg p-2 space-y-3">
                      {/* 预览图 + 移除按钮 */}
                      <div className="flex items-center gap-3">
                        <div
                          className="w-20 h-14 rounded border border-canvas-border shrink-0"
                          style={{
                            backgroundImage: `url(${config.customBackgroundUrl})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                          }}
                        />
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <AnimatedButton
                              type="button"
                              className="settings-save-btn text-xs"
                              onClick={() => fileInputRef.current?.click()}
                              disabled={bgUploading}
                            >
                              {bgUploading ? t('识别中…') : t('更换图片')}
                            </AnimatedButton>
                            <AnimatedButton
                              type="button"
                              className="text-xs px-3 py-1 rounded-md text-red-400 hover:bg-red-500/10 transition-colors"
                              onClick={handleRemoveCustomBg}
                            >
                              {t('移除背景')}
                            </AnimatedButton>
                          </div>
                          {/* 深色/浅色检测结果 */}
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                bgDetection ? (bgDetection.isDark ? 'bg-indigo-400' : 'bg-amber-400') : 'bg-canvas-border'
                              }`}
                            />
                            <span className="text-[11px] text-canvas-text-secondary">
                              {bgDetection
                                ? t('已识别为{tone}背景（亮度: {brightness}/255）', { tone: bgDetection.isDark ? t('深色') : t('浅色'), brightness: bgDetection.brightness })
                                : config.customBackgroundIsDark !== undefined
                                  ? t('已识别为{tone}背景', { tone: config.customBackgroundIsDark ? t('深色') : t('浅色') })
                                  : t('未检测')}
                            </span>
                          </div>
                          {/* 透明度滑块 */}
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-canvas-text-muted shrink-0">{t('透明度')}</span>
                            <input
                              type="range"
                              min="5"
                              max="100"
                              value={Math.round((config.customBackgroundOpacity ?? 0.3) * 100)}
                              onChange={(e) => {
                                updateConfig({ customBackgroundOpacity: Number(e.target.value) / 100 });
                                saveConfig();
                              }}
                              className="flex-1 h-1 accent-indigo-500 cursor-pointer"
                            />
                            <span className="text-[11px] text-canvas-text-secondary w-8 text-right tabular-nums">
                              {Math.round((config.customBackgroundOpacity ?? 0.3) * 100)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 隐藏的文件选择器 */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleBgFileChange}
                  />
                </div>

                {/* 画布交互模式（macOS 使用系统原生手势，隐藏此设置） */}
                {!IS_MAC && (
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
                            saveConfig();
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
                )}

                {/* 鼠标指针 */}
                <section>
                  <h3 className="mb-2 text-sm font-medium text-canvas-text">{t('鼠标指针')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ customCursor: !customCursor });
                      saveConfig();
                    }}
                    aria-pressed={customCursor}
                    className={`sidebar-pref-card${customCursor ? ' is-floating' : ''}`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        customCursor ? 'bg-indigo-500/15 text-indigo-400' : 'bg-canvas-surface text-canvas-text-secondary'
                      }`}
                      aria-hidden="true"
                    >
                      <Icon icon="mdi:cursor-default-outline" width="16" height="16" />
                    </span>

                    <div className="sidebar-pref-text">
                      <div className="sidebar-pref-title">{t('自定义指针样式')}</div>
                      <div className="sidebar-pref-desc">
                        {customCursor
                          ? t('使用内置指针，跟随明暗主题自动切换黑白')
                          : t('使用系统默认指针')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>

                </section>

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
                            await saveConfig();
                          }}
                          className={`flex h-9 items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors ${
                            active
                              ? 'bg-indigo-500/15 text-indigo-400 shadow-sm'
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
                      saveConfig();
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
                        <span className="h-3 w-3 rounded-[3px] bg-indigo-400/60" />
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

                {/* 节点标题（node-label）是否显示 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('节点标题')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ nodeLabelVisible: !nodeLabelVisible });
                      saveConfig();
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
                          <span className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-indigo-400/70" />
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
                      saveConfig();
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
                        <span className="h-6 w-1.5 shrink-0 rounded-sm bg-indigo-400/35" />
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
                    onClick={() => {
                      updateConfig({ performanceMode: !performanceMode });
                      saveConfig();
                    }}
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
                        <span className="mt-1.5 block h-3 rounded-[3px] bg-indigo-500/20" />
                      </div>
                    </div>

                    <div className="sidebar-pref-text">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="sidebar-pref-title">{t('性能模式')}</div>
                        <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium leading-none text-amber-300">
                          {t('卡顿或页面显示不全时开启')}
                        </span>
                      </div>
                      <div className="sidebar-pref-desc">
                        {performanceMode
                          ? t('已关闭毛玻璃、自定义圆角、玻璃外框和装饰动画，保留 Windows 默认圆角')
                          : t('保留完整视觉效果与界面动画')}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </div>

                {/* 侧边栏是否悬浮显示 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-2">{t('侧边栏')}</h3>
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ sidebarFloating: !sidebarFloating });
                      saveConfig();
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
              </>
            )}

            {activeTab === 'mcp' && <McpControlSettings />}

            {activeTab === 'plugins' && <PluginSettings />}
          </div>
        </div>
    </ModalOverlay>
  );
}
