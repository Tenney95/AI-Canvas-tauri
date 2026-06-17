/**
 * SettingsPanel 设置面板 — 模态弹窗，管理常规设置、API Key 配置、快捷键、ComfyUI
 */
import { useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { getProjectDataDir, getBaseDir } from '../services/fileService';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import ModalOverlay from './shared/ModalOverlay';
import AnimatedButton from './shared/AnimatedButton';
import ApiKeySettings from './settings/ApiKeySettings';
import { BACKGROUND_OPTIONS } from './backgrounds/CanvasBackground';
import { detectBackgroundBrightness, compressImageLossless } from '../services/backgroundService';
import type { CanvasBackground as CanvasBg } from '../types';
import type { BackgroundDetection } from '../services/backgroundService';

type SettingsTab = 'general' | 'api' | 'shortcuts' | 'comfyui';

/** 格式化字节为可读大小 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, config, updateConfig, saveConfig, currentProjectId, showToast } =
    useAppStore(
      useShallow((s) => ({
        settingsOpen: s.settingsOpen,
        setSettingsOpen: s.setSettingsOpen,
        config: s.config,
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
        currentProjectId: s.currentProjectId,
        showToast: s.showToast,
      })),
    );
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [comfyUiLaunching, setComfyUiLaunching] = useState(false);
  const [bgUploading, setBgUploading] = useState(false);
  const [bgDetection, setBgDetection] = useState<BackgroundDetection | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载项目文件夹路径
  useEffect(() => {
    if (!settingsOpen || activeTab !== 'general' || !currentProjectId) return;
    setDirLoading(true);
    getProjectDataDir(currentProjectId)
      .then(setProjectDir)
      .catch(() => setProjectDir(null))
      .finally(() => setDirLoading(false));
  }, [settingsOpen, activeTab, currentProjectId]);

  /** 在系统文件管理器中打开文件保存根目录 */
  const handleOpenProjectDir = async () => {
    try {
      const dir = baseDataDir || await getBaseDir();
      if (!dir) return;
      const { Command } = await import('@tauri-apps/plugin-shell');
      const isWin = navigator.platform.toLowerCase().includes('win');
      if (isWin) {
        await Command.create('explorer', ['/root,', dir]).execute();
      } else {
        const cmd = navigator.platform.toLowerCase().includes('mac') ? 'open' : 'xdg-open';
        await Command.create(cmd, [dir]).execute();
      }
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

  /** 启动 ComfyUI */
  const handleLaunchComfyUI = async () => {
    const comfyPath = config.comfyUIPath?.trim();
    if (!comfyPath) {
      showToast('请先设置 ComfyUI 安装目录', 'error');
      return;
    }
    setComfyUiLaunching(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<string>('launch_comfyui', { comfyPath });
      showToast(result, 'success');
    } catch (err) {
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
      console.log(
        `[背景压缩] 原始: ${formatBytes(compression.originalSize)} → 最终: ${formatBytes(compression.compressedSize)}` +
        (compression.keptOriginal
          ? ` (保留原图, 重编码会增大)`
          : compression.compressionRatio > 0
            ? ` (缩减 ${compression.compressionRatio}%, 格式: ${compression.format.toUpperCase()})`
            : ` (已最优, 格式: ${compression.format.toUpperCase()})`),
      );

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

  return (
    <ModalOverlay isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} className="w-[640px] max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-canvas-border">
          <h2 className="text-base font-semibold text-canvas-text">设置</h2>
          <AnimatedButton
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
          <div className="settings-content flex-1 overflow-y-auto overflow-x-hidden p-5">
            {activeTab === 'api' && (
              <ApiKeySettings onClose={() => setSettingsOpen(false)} />
            )}

            {activeTab === 'comfyui' && (
              <div className="space-y-6">
                {/* ComfyUI 安装目录 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">ComfyUI 安装目录</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-4">
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
                      选择 ComfyUI 的安装根目录（包含 run_nvidia_gpu.bat 或 main.py 的文件夹）
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
                            启动中…
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
                      <p className="text-[11px] text-canvas-text-muted mt-2">
                        启动后 ComfyUI 会在新窗口中运行，服务启动后即可在下方配置地址
                      </p>
                    </div>
                  </div>
                </div>

                {/* ComfyUI 服务地址 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">ComfyUI 服务地址</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-4">
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
                    <div className="mt-3 bg-canvas-card border border-canvas-border rounded-lg p-4 space-y-3">
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

                <div style={{ display: 'none' }}>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">输入偏好</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-canvas-text">鼠标大小</div>
                        <div className="text-xs text-canvas-text-muted mt-0.5">选择光标显示大小</div>
                      </div>
                      <div className="flex gap-1">
                        {['小', '中', '大'].map((size, i) => (
                          <AnimatedButton
                            key={size}
                            className={`px-3 py-1.5 rounded-md text-xs ${i === 1 ? 'bg-indigo-500/20 text-indigo-400' : 'bg-canvas-card text-canvas-text-secondary hover:bg-canvas-hover'}`}
                          >
                            {size}
                          </AnimatedButton>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 侧边栏是否悬浮显示 */}

                {/* 文件保存位置 */}
                <div>
                  <h3 className="text-sm font-medium text-canvas-text mb-3">文件保存位置</h3>
                  <div className="bg-canvas-card border border-canvas-border rounded-lg p-4">
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
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="space-y-2">
                <p className="text-sm text-canvas-text-muted mb-4">键盘快捷键配置</p>
                {[
                  { action: '保存画布', key: 'Ctrl + S' },
                  { action: '撤销', key: 'Ctrl + Z' },
                  { action: '重做', key: 'Ctrl + Y' },
                  { action: '删除节点', key: 'Delete / Backspace' },
                  { action: '画布复位', key: 'F' },
                  { action: '小地图', key: 'M' },
                ].map(({ action, key }) => (
                  <div key={action} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-canvas-hover">
                    <span className="text-sm text-canvas-text">{action}</span>
                    <kbd className="px-2 py-0.5 bg-canvas-card border border-canvas-border rounded text-[11px] text-canvas-text-secondary font-mono">
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
    </ModalOverlay>
  );
}
