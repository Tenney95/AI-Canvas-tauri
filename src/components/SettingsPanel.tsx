/**
 * SettingsPanel 设置面板 — 模态弹窗，管理常规设置、API Key 配置、快捷键、ComfyUI
 */
import { useState, useEffect, useRef } from 'react';
import { Icon } from '@iconify/react';
import '../styles/settings.css';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { getProjectDataDir, getBaseDir, openDirectoryInFileManager, PROJECT_DISK_CHANGED_EVENT } from '../services/fileService';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import ModalOverlay from './shared/ModalOverlay';
import AnimatedButton from './shared/AnimatedButton';
import ApiKeySettings from './settings/ApiKeySettings';
import StorageHealthCenter from './settings/StorageHealthCenter';
import { BACKGROUND_OPTIONS } from './backgrounds/CanvasBackground';
import { detectBackgroundBrightness, compressImageLossless } from '../services/backgroundService';
import type { CanvasBackground as CanvasBg, InteractionMode } from '../types';
import type { BackgroundDetection } from '../services/backgroundService';

type SettingsTab = 'general' | 'api' | 'shortcuts' | 'comfyui' | 'storage';

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

/** 是否运行在 macOS（用于快捷键修饰键显示） */
const IS_MAC =  typeof navigator !== 'undefined'  && /Macintosh|Mac OS X/.test(navigator.userAgent);

/** 按当前系统生成键盘快捷键列表（修饰键 Win/Mac 自适应） */
function getShortcutList(): { action: string; key: string }[] {
  const mod = IS_MAC ? '⌘' : 'Ctrl';        // 应用绑定 ctrlKey||metaKey，Mac 上为 ⌘
  const ctrl = IS_MAC ? '⌃' : 'Ctrl';       // 字面 Control 键
  const alt = IS_MAC ? '⌥' : 'Alt';
  const shift = IS_MAC ? '⇧' : 'Shift';
  const del = IS_MAC ? '⌫ Delete' : 'Delete / Backspace';
  return [
    { action: '保存画布', key: `${mod} + S` },
    { action: '撤销', key: `${mod} + Z` },
    { action: '重做', key: `${mod} + Y  /  ${mod} + ${shift} + Z` },
    { action: '复制节点', key: `${mod} + C` },
    { action: '粘贴节点', key: `${mod} + V` },
    { action: '删除节点', key: del },
    { action: '分组 / 取消分组', key: `${mod} + G` },
    { action: '创建生成节点（文本 / 图像 / 视频 / 音频 / 全景 / 动画）', key: '1–6' },
    { action: '创建源节点（文本 / 图像 / 视频 / 音频 / Markdown）', key: `${alt} + 1–5` },
    { action: '弹出对话框', key: `选中节点+Space` },
    { action: '锁定比例缩放', key: `缩放时按住 ${shift}` },
    { action: '关闭菜单 / 设置', key: 'Escape' },
    { action: '画布复位', key: 'F' },
    { action: '小地图', key: 'M' },
    { action: '资源搜索窗口', key: `${alt} + Space  /  ${ctrl} + ${shift} + Space` },
    { action: '显示/隐藏吉祥物', key: `${mod} + ${shift} + M` },
  ];
}

/** 格式化字节为可读大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, config, updateConfig, saveConfig, currentProjectId, workflows, setWorkflowPanelOpen, showToast } =
    useAppStore(
      useShallow((s) => ({
        settingsOpen: s.settingsOpen,
        setSettingsOpen: s.setSettingsOpen,
        config: s.config,
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
        currentProjectId: s.currentProjectId,
        workflows: s.workflows,
        setWorkflowPanelOpen: s.setWorkflowPanelOpen,
        showToast: s.showToast,
      })),
    );
  const sidebarFloating = config.sidebarFloating !== false; // 默认开启
  const interactionMode = config.interactionMode ?? 'default';
  const activeInteractionMode = INTERACTION_MODE_OPTIONS.find((option) => option.id === interactionMode)
    ?? INTERACTION_MODE_OPTIONS[0];
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [comfyUiLaunching, setComfyUiLaunching] = useState(false);
  // ComfyUI 服务状态：启动按钮下方的即时反馈（starting → ready / failed）
  const [comfyStatus, setComfyStatus] = useState<'idle' | 'starting' | 'ready' | 'failed'>('idle');
  const [bgUploading, setBgUploading] = useState(false);
  const [bgDetection, setBgDetection] = useState<BackgroundDetection | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载项目文件夹路径
  useEffect(() => {
    if (!settingsOpen || activeTab !== 'general' || !currentProjectId) return;
    let cancelled = false;
    const refreshProjectDir = () => {
      setDirLoading(true);
      getProjectDataDir(currentProjectId)
        .then((dir) => {
          if (!cancelled) setProjectDir(dir);
        })
        .catch(() => {
          if (!cancelled) setProjectDir(null);
        })
        .finally(() => {
          if (!cancelled) setDirLoading(false);
        });
    };
    refreshProjectDir();
    window.addEventListener(PROJECT_DISK_CHANGED_EVENT, refreshProjectDir);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECT_DISK_CHANGED_EVENT, refreshProjectDir);
    };
  }, [settingsOpen, activeTab, currentProjectId]);

  /** 在系统文件管理器中打开文件保存根目录 */
  const handleOpenProjectDir = async () => {
    try {
      const dir = baseDataDir || await getBaseDir();
      if (!dir) return;
      await openDirectoryInFileManager(dir);
    } catch (err) {
      console.warn('无法打开文件夹:', err);
    }
  };

  /** 选择文件保存根目录 */
  const handleChooseBaseDir = async () => {
    try {
      const selected = await openDialog({ directory: true, title: '选择文件保存根目录' });
      if (selected && typeof selected === 'string') {
        updateConfig({ baseDataDir: selected });
        await saveConfig();
      }
    } catch {
      // 浏览器环境忽略
    }
  };

  /** 选择 ComfyUI 安装目录 */
  const handleChooseComfyUIPath = async () => {
    try {
      const selected = await openDialog({ directory: true, title: '选择 ComfyUI 安装目录' });
      if (selected && typeof selected === 'string') {
        updateConfig({ comfyUIPath: selected });
        await saveConfig();
      }
    } catch {
      // 浏览器环境忽略
    }
  };

  /** 选择 Photoshop.exe 路径 */
  const handleChoosePhotoshopPath = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: '选择 Photoshop.exe',
        filters: [{ name: 'Photoshop', extensions: ['exe', 'app'] }],
      });
      if (selected && typeof selected === 'string') {
        updateConfig({ photoshopPath: selected });
        await saveConfig();
      }
    } catch {
      // 浏览器环境忽略
    }
  };

  /** 启动 ComfyUI：拉起进程后轮询服务端口，直到 API 真正就绪才算启动成功 */
  const handleLaunchComfyUI = async () => {
    const comfyPath = config.comfyUIPath?.trim();
    if (!comfyPath) {
      showToast('请先设置 ComfyUI 安装目录', 'error');
      return;
    }
    setComfyUiLaunching(true);
    setComfyStatus('starting');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke<string>('launch_comfyui', { comfyPath });

      // 进程已拉起，但 ComfyUI 导入依赖需要数十秒 —— 轮询 API 直到就绪
      // no-cors 探测：能连通即视为就绪，不依赖服务端 CORS 配置
      const base = (config.comfyUIUrl?.trim() || 'http://127.0.0.1:8188').replace(/\/+$/, '');
      const deadline = Date.now() + 300_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          await fetch(`${base}/system_stats`, { mode: 'no-cors' });
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (ready) {
        setComfyStatus('ready');
        showToast('ComfyUI 服务已就绪', 'success');
      } else {
        setComfyStatus('failed');
        showToast('ComfyUI 进程已启动，但等待服务就绪超时，请查看终端窗口日志', 'error');
      }
    } catch (err) {
      setComfyStatus('failed');
      showToast(typeof err === 'string' ? err : '启动 ComfyUI 失败', 'error');
    } finally {
      setComfyUiLaunching(false);
    }
  };

  /** 处理背景图片文件选择：无损压缩 → 自动识别深色/浅色 */
  const handleBgFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 只允许图片格式
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件', 'error');
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
        ? `（保留原图，重编码会增大）`
        : compression.compressionRatio > 0
          ? `（缩减 ${compression.compressionRatio}%，${compression.format.toUpperCase()}）`
          : `（已最优，${compression.format.toUpperCase()}）`;
      showToast(`${detection.isDark ? '深色' : '浅色'}背景 · ${sizeLabel} ${ratioLabel}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '背景图片处理失败', 'error');
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
    showToast('已恢复默认背景');
  };

  const baseDataDir = config.baseDataDir;
  const comfyUIPath = config.comfyUIPath;
  const photoshopPath = config.photoshopPath;

  const handleOpenWorkflowPanel = () => {
    setSettingsOpen(false);
    setWorkflowPanelOpen(true);
  };

  return (
    <ModalOverlay
      isOpen={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      ariaLabel="设置"
      className="w-[640px] h-[80vh]"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-canvas-border">
          <h2 className="text-base font-semibold text-canvas-text">设置</h2>
          <AnimatedButton
            aria-label="关闭设置"
            onClick={() => setSettingsOpen(false)}
            className="w-8 h-8 rounded-lg hover:bg-canvas-hover flex items-center justify-center text-canvas-text-secondary hover:text-canvas-text transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </AnimatedButton>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar Nav */}
          <nav className="w-44 border-r border-canvas-border p-3 space-y-0.5 shrink-0">
            {[
              { id: 'general', label: '常规' },
              { id: 'api', label: 'API Key' },
              { id: 'storage', label: '存储健康' },
              { id: 'comfyui', label: 'ComfyUI' },
              { id: 'shortcuts', label: '快捷键' },
            ].map(({ id, label }) => (
              <AnimatedButton
                key={id}
                onClick={() => setActiveTab(id as SettingsTab)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  activeTab === id ? 'bg-indigo-500/15 text-indigo-400' : 'text-canvas-text-secondary hover:bg-canvas-hover'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {id === 'storage' && (
                    <>
                      <ellipse cx="12" cy="5" rx="9" ry="3" />
                      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                    </>
                  )}
                  {id === 'api' && (
                    <>
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </>
                  )}
                  {id === 'comfyui' && (
                    <>
                      <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
                    </>
                  )}
                  {id === 'general' && (
                    <>
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" />
                    </>
                  )}
                  {id === 'shortcuts' && (
                    <>
                      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                      <line x1="6" y1="8" x2="6.01" y2="8" /><line x1="10" y1="8" x2="10.01" y2="8" />
                      <line x1="14" y1="8" x2="14.01" y2="8" /><line x1="18" y1="8" x2="18.01" y2="8" />
                      <line x1="8" y1="12" x2="8.01" y2="12" /><line x1="12" y1="12" x2="12.01" y2="12" />
                      <line x1="16" y1="12" x2="16.01" y2="12" /><line x1="7" y1="16" x2="17" y2="16" />
                    </>
                  )}
                </svg>
                {label}
              </AnimatedButton>
            ))}
          </nav>

          {/* Content */}
          <div className="settings-content flex-1 overflow-y-auto overflow-x-hidden p-4">
            {activeTab === 'api' && (
              <ApiKeySettings onClose={() => setSettingsOpen(false)} />
            )}

            {activeTab === 'comfyui' && (
              <div className="space-y-6">
                {/* ComfyUI 安装目录 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">ComfyUI 安装目录</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
                    <div className="text-xs text-canvas-text-muted mb-1.5">ComfyUI 根目录路径</div>
                    {comfyUIPath ? (
                      <div className="flex items-center gap-2 mb-3">
                        <div className="flex-1 min-w-0 text-[11px] text-canvas-text-secondary break-all font-mono leading-relaxed bg-canvas-surface rounded-md px-3 py-1.5 border border-canvas-border select-all">
                          {comfyUIPath}
                        </div>
                        <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs" onClick={handleChooseComfyUIPath}>
                          更换
                        </AnimatedButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mb-3">
                        <div className="flex-1 text-xs text-canvas-text-muted bg-canvas-surface rounded-md px-3 py-1.5 border border-canvas-border italic">
                          未设置
                        </div>
                        <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs" onClick={handleChooseComfyUIPath}>
                          选择文件夹
                        </AnimatedButton>
                      </div>
                    )}
                    <p className="text-[11px] text-canvas-text-muted leading-relaxed mb-3">
                      选择 ComfyUI 的安装根目录，支持 GitHub 源码版 / 秋叶整合包 / 官方便携版 / Comfy Desktop（选安装基目录，如 F:\ComfyUI）。将以 API 模式直接启动，跳过启动器检测
                    </p>

                    {/* 启动按钮 */}
                    <div className="pt-2 border-t border-canvas-border">
                      <AnimatedButton
                        type="button"
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 transition-colors text-sm font-medium"
                        onClick={handleLaunchComfyUI}
                        disabled={comfyUiLaunching}
                      >
                        {comfyUiLaunching ? (
                          <>
                            <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="8" />
                            </svg>
                            正在启动，等待服务就绪…
                          </>
                        ) : (
                          <>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                            启动 ComfyUI
                          </>
                        )}
                      </AnimatedButton>
                      {/* 启动状态反馈 */}
                      {comfyStatus === 'starting' && (
                        <p className="text-[11px] text-canvas-text-secondary mt-2 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
                          正在等待 ComfyUI 服务就绪，首次启动可能需要几分钟时间…
                        </p>
                      )}
                      {comfyStatus === 'ready' && (
                        <p className="text-[11px] text-emerald-400 mt-2 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          ComfyUI 服务已就绪（{(config.comfyUIUrl?.trim() || 'http://127.0.0.1:8188')}），可以开始使用
                        </p>
                      )}
                      {comfyStatus === 'failed' && (
                        <p className="text-[11px] text-red-400 mt-2 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                          服务未就绪，请查看弹出的终端窗口中的日志
                        </p>
                      )}
                      {comfyStatus === 'idle' && (
                        <p className="text-[11px] text-canvas-text-muted mt-2">
                          启动后 ComfyUI 会在新窗口中运行，服务启动后即可在下方配置地址
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* ComfyUI 服务地址 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">ComfyUI 服务地址</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
                    <div className="text-xs text-canvas-text-muted mb-1.5">后端地址</div>
                    <input
                      type="text"
                      className="w-full text-sm bg-canvas-surface border border-canvas-border rounded-md px-3 py-2 text-canvas-text placeholder-canvas-text-muted focus:outline-none focus:border-indigo-500 transition-colors"
                      placeholder="http://127.0.0.1:8188"
                      defaultValue={config.comfyUIUrl || ''}
                      onBlur={async (e) => {
                        updateConfig({ comfyUIUrl: e.target.value });
                        await saveConfig();
                      }}
                    />
                    <p className="text-[11px] text-canvas-text-muted mt-2">
                      ComfyUI 后端服务的地址，用于执行导入的工作流。默认端口为 8188
                    </p>
                  </div>
                </div>

                {/* ComfyUI 工作流 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">ComfyUI 工作流</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-2 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                      <Icon icon="lucide:workflow" width="18" height="18" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-canvas-text">工作流管理</div>
                      <div className="text-[11px] text-canvas-text-muted mt-0.5">已导入 {workflows.length} 个工作流</div>
                    </div>
                    <AnimatedButton
                      type="button"
                      className="settings-save-btn shrink-0 text-xs flex items-center gap-1.5"
                      onClick={handleOpenWorkflowPanel}
                    >
                      管理工作流
                      <Icon icon="lucide:chevron-right" width="14" height="14" />
                    </AnimatedButton>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'general' && (
              <div className="space-y-6">
                {/* 画布背景主题 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">画布背景</h3>
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
                          className={`flex flex-col items-center gap-2 p-1 rounded-lg border transition-colors ${
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
                              ? 'bg-[#F5F0EB]'
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
                          <span className="text-[11px] font-medium">{label}</span>
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
                              {bgUploading ? '识别中…' : '更换图片'}
                            </AnimatedButton>
                            <AnimatedButton
                              type="button"
                              className="text-xs px-3 py-1 rounded-md text-red-400 hover:bg-red-500/10 transition-colors"
                              onClick={handleRemoveCustomBg}
                            >
                              移除背景
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
                                ? `已识别为${bgDetection.isDark ? '深色' : '浅色'}背景（亮度: ${bgDetection.brightness}/255）`
                                : config.customBackgroundIsDark !== undefined
                                  ? `已识别为${config.customBackgroundIsDark ? '深色' : '浅色'}背景`
                                  : '未检测'}
                            </span>
                          </div>
                          {/* 透明度滑块 */}
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-canvas-text-muted shrink-0">透明度</span>
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
                      <h3>画布交互方式</h3>
                      <p>选择更符合你操作习惯的画布手感</p>
                    </div>
                    <span>即时生效</span>
                  </div>

                  <div className="canvas-interaction-mode-grid" role="radiogroup" aria-label="画布交互方式">
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
                              <strong>{opt.title}</strong>
                              <span>{opt.badge}</span>
                            </div>
                            <p>{opt.description}</p>
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
                        当前手势地图
                      </div>
                      <strong>{activeInteractionMode.title}</strong>
                    </div>
                    <div className="canvas-gesture-grid">
                      {activeInteractionMode.gestures.map((gesture) => (
                        <div className="canvas-gesture-item" key={gesture.key}>
                          <kbd>{gesture.key}</kbd>
                          <span>{gesture.action}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
                )}

                {/* 侧边栏是否悬浮显示 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">侧边栏</h3>
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
                      <div className="sidebar-pref-title">悬浮显示</div>
                      <div className="sidebar-pref-desc">
                        {sidebarFloating
                          ? '侧边栏半隐于窗口边缘，悬浮在画布之上'
                          : '侧边栏停靠在窗口内侧'}
                      </div>
                    </div>

                    <div className="sidebar-pref-switch" aria-hidden="true">
                      <span />
                    </div>
                  </button>
                </div>

                {/* 文件保存位置 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">文件保存位置</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
                    {/* 保存根目录选择 */}
                    <div className="mb-3">
                      <div className="text-xs text-canvas-text-muted mb-1.5">保存根目录</div>
                      {baseDataDir ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0 text-[11px] text-canvas-text-secondary break-all font-mono leading-relaxed bg-canvas-surface rounded-md px-3 py-1.5 border border-canvas-border select-all">
                            {baseDataDir}
                          </div>
                          <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs" onClick={handleChooseBaseDir}>
                            更换
                          </AnimatedButton>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 text-xs text-canvas-text-muted bg-canvas-surface rounded-md px-3 py-1.5 border border-canvas-border italic">
                            未设置（使用系统默认目录）
                          </div>
                          <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs" onClick={handleChooseBaseDir}>
                            选择文件夹
                          </AnimatedButton>
                        </div>
                      )}
                    </div>

                    {/* 路径结构提示 */}
                    <div className="text-[11px] text-canvas-text-muted leading-relaxed mb-3">
                      文件保存为：<span className="text-canvas-text-secondary font-mono">{baseDataDir || '系统目录'}/{'{项目ID}'}/...</span>
                    </div>

                    {/* 当前项目目录 + 打开按钮 */}
                    <div className="pt-2 border-t border-canvas-border">
                      {dirLoading ? (
                        <div className="text-xs text-canvas-text-muted">加载中…</div>
                      ) : projectDir ? (
                        <div className="space-y-2">
                          <div className="flex items-start gap-2 min-w-0">
                            <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            </svg>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs text-canvas-text-muted mb-0.5">当前项目目录</div>
                              <div className="text-[11px] text-canvas-text-secondary break-all font-mono leading-relaxed select-all">
                                {projectDir}
                              </div>
                            </div>
                          </div>
                          <AnimatedButton
                            type="button"
                            className="settings-save-btn"
                            onClick={handleOpenProjectDir}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                            打开文件夹
                          </AnimatedButton>
                        </div>
                      ) : (
                        <div className="text-xs text-canvas-text-muted">仅在 Tauri 桌面环境中可用</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Photoshop 路径 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">Photoshop 路径</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-2">
                    <div className="text-xs text-canvas-text-muted mb-1.5">Photoshop.exe 路径</div>
                    {photoshopPath ? (
                      <div className="flex items-center gap-2 mb-3">
                        <div className="flex-1 min-w-0 text-[11px] text-canvas-text-secondary break-all font-mono leading-relaxed bg-canvas-surface rounded-md px-3 py-1.5 border border-canvas-border select-all">
                          {photoshopPath}
                        </div>
                        <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs" onClick={handleChoosePhotoshopPath}>
                          更换
                        </AnimatedButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mb-3">
                        <div className="flex-1 text-xs text-canvas-text-muted bg-canvas-surface rounded-md px-3 py-1.5 border border-canvas-border italic">
                          未设置（自动检测）
                        </div>
                        <AnimatedButton type="button" className="settings-save-btn shrink-0 text-xs" onClick={handleChoosePhotoshopPath}>
                          选择文件
                        </AnimatedButton>
                      </div>
                    )}
                    <p className="text-[11px] text-canvas-text-muted leading-relaxed">
                      右键图片节点选择「在 PS 中打开」时，优先自动检测 Photoshop 安装位置；检测失败时使用此处配置的路径。支持各版本 Photoshop，不限安装盘符
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="space-y-1">
                <p className="text-sm text-canvas-text-muted mb-4">键盘快捷键配置</p>
                {getShortcutList().map(({ action, key }) => (
                  <div key={action} className="flex items-center justify-between py-2 px-2.5 rounded-lg hover:bg-canvas-hover">
                    <span className="text-sm text-canvas-text">{action}</span>
                    <kbd className="px-2 py-0.5 bg-canvas-card border border-canvas-border rounded text-[11px] text-canvas-text-secondary font-mono">
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'storage' && (
              <StorageHealthCenter />
            )}
          </div>
        </div>
    </ModalOverlay>
  );
}
