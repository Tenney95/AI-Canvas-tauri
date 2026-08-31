/**
 * 应用主侧栏，集中承载节点创建、项目入口、功能面板切换、更新状态与快捷操作。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { createPortal } from 'react-dom';
import type { JSX } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, computeImageNodeDimensions, generateId } from '../store/useAppStore';
import { countUnreadDramaAssets } from '../store/store.dramaAssets';
import ModalOverlay from './shared/ModalOverlay';
import type { NodeType } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import { uploadSourceFileToProject } from '../services/fileService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { classifyFile } from '../hooks/useNodeCreation';
import { checkForUpdate, downloadAndInstallUpdate } from '../services/updateService';
import AnimatedButton from './shared/AnimatedButton';
import LazyLoadBoundary, { LazyLoadFallback } from './shared/LazyLoadBoundary';
import ProjectLibraryModal from './ProjectLibraryModal';
import { invoke } from '@tauri-apps/api/core';
import { useT } from '../i18n';
import { openStyleGuideWindow } from '../utils/styleGuideWindow';
import {
  createPluginNode,
  getAvailablePluginNodes,
} from '../services/plugins/pluginRuntime';

const HelpCenterDialog = lazy(() => import('./HelpCenterDialog'));

/** 「关于」弹窗里连点 logo 打开样式预览窗口：阈值与连点重置间隔 */
const STYLE_GUIDE_LOGO_TAPS = 4;
const STYLE_GUIDE_LOGO_RESET_MS = 1200;

/**
 * Sidebar 侧边栏面板 — 左侧节点类型列表、上传入口、项目切换、拖拽添加节点
 */

/* ============================================
   Node picker menu items
   ============================================ */
const generationItems: {
  type: NodeType;
  label: string;
  sub: string;
  icon: JSX.Element;
}[] = [
  {
    type: 'ai-text',
    label: '生成文本',
    sub: 'AI 文本生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-text'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-image',
    label: '生成图像',
    sub: 'AI 图像生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-image'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-video',
    label: '生成视频',
    sub: 'AI 视频生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-video'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-audio',
    label: '生成音频',
    sub: 'AI 音频生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-audio'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-panorama',
    label: '生成360全景',
    sub: 'AI 全景图生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-panorama'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-animation',
    label: '生成动画',
    sub: '2D 角色逐帧动画',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-animation'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-director',
    label: '3D 导演台',
    sub: '运镜预演 · 截图供生视频',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-director'].icon} width="18" height="18" />,
  },
];

const resourceItems = [
  {
    key: 'upload',
    label: '上传文件',
    sub: '图片 / 视频 / 音频',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
  },
];

/* ============================================
   Node Picker popup
   ============================================ */
function NodePicker({
  onEnter,
  onLeave,
}: {
  onEnter: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const { nodePickerOpen, closeNodePicker, addNode, currentProjectId, showToast, installedPlugins } = useAppStore(
    useShallow((s) => ({
      nodePickerOpen: s.nodePickerOpen,
      closeNodePicker: s.closeNodePicker,
      addNode: s.addNode,
      currentProjectId: s.currentProjectId,
      showToast: s.showToast,
      installedPlugins: s.installedPlugins,
    })),
  );
  const pickerRef = useRef<HTMLDivElement>(null);
  const pluginNodes = getAvailablePluginNodes(installedPlugins);

  const handleAddNode = (type: NodeType) => {
    const isImage = type === 'ai-image';
    const isPanorama = type === 'ai-panorama';
    const isAnimation = type === 'ai-animation';
    const isDirector = type === 'ai-director';
    const nodeData: Record<string, unknown> = {
      label: t(NODE_TYPE_CONFIG[type]?.label || generationItems.find((m) => m.type === type)?.label || '节点'),
      type,
      prompt: '',
      status: 'idle' as const,
      nodeWidth: isAnimation || isDirector ? 320 : isPanorama ? 300 : 280,
      nodeHeight: isDirector ? 240 : isImage ? 158 : isAnimation ? 358 : isPanorama ? 200 : 160,
    };
    if (isImage) {
      nodeData.aspectRatio = '16:9';
      nodeData.imageSize = '2K';
    }
    if (isPanorama) {
      nodeData.previewMode = 'image';
    }
    if (isAnimation) {
      nodeData.prompt = '2D俯视角游戏角色，保持角色造型、朝向、比例和光照一致';
      nodeData.animationAction = 'idle';
      nodeData.animationFrames = 8;
      nodeData.animationPreviewMode = 'playing';
      nodeData.aspectRatio = '1:1';
      nodeData.imageSize = '2K';
    }
    if (isDirector) {
      nodeData.role = 'source';
      nodeData.directorStatus = 'idle';
      nodeData.directorCaptureUrls = [];
    }
    // Auto-fill default model from localStorage preference
    // 全景图节点回退到生图节点偏好
    try {
      const raw = localStorage.getItem('canvas-model-prefs');
      if (raw) {
        const prefs: Record<string, string> = JSON.parse(raw);
        const modelValue = prefs[type]
          || (type === 'ai-panorama' || type === 'ai-animation' ? prefs['ai-image'] : undefined);
        if (modelValue) {
          const slashIdx = modelValue.indexOf('/');
          if (slashIdx !== -1) {
            const provider = modelValue.slice(0, slashIdx);
            if (provider) {
              nodeData.model = modelValue;
              nodeData.provider = provider;
            }
          }
        }
      }
    } catch { /* ignore */ }
    const pos = getCanvasPointerPosition();
    addNode({
      id: `node-${generateId()}`,
      type,
      position: pos,
      data: nodeData,
    } as never);
    closeNodePicker();
  };

  const handleUploadFile = async () => {
    closeNodePicker();
    try {
      const result = await uploadSourceFileToProject('*/*', currentProjectId);
      if (!result) return;

      const ext = result.fileName.split('.').pop()?.toLowerCase() || '';
      const category = classifyFile(ext);

      if (!category) {
        showToast(t('不支持的文件类型'), 'error');
        return;
      }

      const pos = getCanvasPointerPosition();
      const typeMap: Record<string, { type: NodeType; label: string; field: string }> = {
        image: { type: 'ai-image', label: result.fileName, field: 'imageUrl' },
        video: { type: 'ai-video', label: result.fileName, field: 'videoUrl' },
        audio: { type: 'ai-audio', label: result.fileName, field: 'audioUrl' },
        text: { type: 'ai-text', label: result.fileName, field: 'output' },
      };
      const info = typeMap[category];

      const nodeData: Record<string, unknown> = {
        label: info.label,
        type: info.type,
        role: 'source',
        status: 'success',
        fileName: result.fileName,
        nodeWidth: info.type === 'ai-audio' ? 260 : 280,
        nodeHeight: 160,
        [info.field]: result.dataUrl,
        ...(result.filePath ? { filePath: result.filePath } : {}),
        ...(info.field === 'output' ? { prompt: '' } : {}),
      };

      if (category === 'image' && result.dataUrl) {
        try {
          const dims = await computeImageNodeDimensions(result.dataUrl);
          Object.assign(nodeData, dims);
        } catch { /* ignore */ }
      }

      addNode({
        id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: info.type,
        position: pos,
        data: nodeData,
      } as never);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('上传失败');
      showToast(msg, 'error');
    }
  };

  const handleAddPluginNode = (pluginNode: (typeof pluginNodes)[number]) => {
    addNode(createPluginNode(pluginNode, getCanvasPointerPosition()));
    closeNodePicker();
  };

  return (
    <AnimatePresence>
      {nodePickerOpen && (
        <motion.div
          ref={pickerRef}
          className="node-picker"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
      <div className="menu-section">
        <span className="menu-title">{t('画布自由生成')}</span>
        <div className="menu-rule" />
      </div>
      {generationItems.map(({ type, label, sub, icon }) => (
        <AnimatedButton
          key={type}
          scale={1.02}
          className="menu-row has-desc"
          onClick={() => {
            handleAddNode(type);
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{t(label)}</span>
            <span className="menu-sub">{t(sub)}</span>
          </div>
        </AnimatedButton>
      ))}
      {pluginNodes.length > 0 && (
        <>
          <div className="menu-section">
            <span className="menu-title">{t('插件节点')}</span>
            <div className="menu-rule" />
          </div>
          {pluginNodes.map((pluginNode) => (
            <AnimatedButton
              key={`${pluginNode.pluginId}:${pluginNode.node.id}`}
              scale={1.02}
              className="menu-row has-desc"
              onClick={() => handleAddPluginNode(pluginNode)}
            >
              <div className="menu-ico">
                <Icon icon={pluginNode.node.icon} width="18" height="18" />
              </div>
              <div className="menu-txt-wrap">
                <span className="menu-lbl">{pluginNode.node.title}</span>
                <span className="menu-sub">{pluginNode.pluginName}</span>
              </div>
            </AnimatedButton>
          ))}
        </>
      )}
      <div className="menu-section">
        <span className="menu-title">{t('添加资源')}</span>
        <div className="menu-rule" />
      </div>
      {resourceItems.map(({ key, label, sub, icon }) => (
        <AnimatedButton key={key} scale={1.02} className="menu-row has-desc"
          onClick={async () => {
            if (key === 'upload') return handleUploadFile();
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{t(label)}</span>
            <span className="menu-sub">{t(sub)}</span>
          </div>
        </AnimatedButton>
      ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================================
   Avatar / Settings dropdown menu
   ============================================ */
function AvatarMenu() {
  const t = useT();
  const { avatarMenuOpen, closeAvatarMenu, setSettingsOpen, helpOpen, setHelpOpen } = useAppStore(
    useShallow((s) => ({
      avatarMenuOpen: s.avatarMenuOpen,
      closeAvatarMenu: s.closeAvatarMenu,
      setSettingsOpen: s.setSettingsOpen,
      helpOpen: s.helpOpen,
      setHelpOpen: s.setHelpOpen,
    })),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** 「关于」里连点 logo 的计数与重置计时器；纯交互状态，不参与渲染所以用 ref */
  const logoTapsRef = useRef(0);
  const logoTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'no-update' | 'available' | 'updating' | 'error'>('idle');
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateVersion, setUpdateVersion] = useState('');

  const handleCheckUpdate = async () => {
    setUpdateStatus('checking');
    setUpdateMsg('');
    try {
      const result = await checkForUpdate();
      if (result.available) {
        setUpdateStatus('available');
        setUpdateVersion(result.version);
        setUpdateMsg(t('发现新版本 v{version}', { version: result.version }));
      } else {
        setUpdateStatus('no-update');
        setUpdateMsg(t('已是最新版本'));
      }
    } catch {
      setUpdateStatus('error');
      setUpdateMsg(t('检查失败，请稍后重试'));
    }
  };

  const handleDownloadUpdate = async () => {
    setUpdateStatus('updating');
    setUpdateMsg(t('正在下载更新...'));
    const ok = await downloadAndInstallUpdate();
    if (!ok) {
      setUpdateStatus('error');
      setUpdateMsg(t('下载失败，请稍后重试'));
    }
  };

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // 连点 logo 达到阈值时打开样式预览窗口；超过间隔没有下一次点击就重新计数
  const handleLogoClick = useCallback(() => {
    const taps = logoTapsRef.current + 1;
    logoTapsRef.current = taps;
    if (logoTapTimerRef.current) clearTimeout(logoTapTimerRef.current);

    if (taps >= STYLE_GUIDE_LOGO_TAPS) {
      logoTapsRef.current = 0;
      logoTapTimerRef.current = null;
      setAboutOpen(false);
      void openStyleGuideWindow();
      useAppStore.getState().showToast(t('已打开样式预览窗口'));
      return;
    }

    logoTapTimerRef.current = setTimeout(() => {
      logoTapsRef.current = 0;
      logoTapTimerRef.current = null;
    }, STYLE_GUIDE_LOGO_RESET_MS);
  }, [t]);

  useEffect(() => () => {
    if (logoTapTimerRef.current) clearTimeout(logoTapTimerRef.current);
  }, []);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const handler = (e: MouseEvent) => {
      // Ignore clicks on the gear button itself
      const gearBtn = document.getElementById('btn-user-gear');
      if (gearBtn && gearBtn.contains(e.target as Node)) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeAvatarMenu();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [avatarMenuOpen, closeAvatarMenu]);

  return (
    <>
      <AnimatePresence>
      {avatarMenuOpen && (
        <motion.div
          ref={menuRef}
          className="avatar-menu"
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            scale={1.02}
            onClick={() => {
              setSettingsOpen(true);
              closeAvatarMenu();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t('设置')}
          </AnimatedButton>
          <div className="avatar-menu-sep" />
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            scale={1.02}
            onClick={() => {
              setHelpOpen(true);
              closeAvatarMenu();
            }}
          >
            <Icon icon="mdi:help-circle-outline" width="16" height="16" aria-hidden="true" />
            {t('帮助')}
          </AnimatedButton>
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            onClick={() => {
              setAboutOpen(true);
              closeAvatarMenu();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            {t('关于')}
          </AnimatedButton>
        </motion.div>
      )}
    </AnimatePresence>

      {helpOpen ? (
        <LazyLoadBoundary label={t('帮助中心')}>
          <Suspense fallback={<LazyLoadFallback label={t('帮助中心')} />}>
            <HelpCenterDialog onClose={() => setHelpOpen(false)} />
          </Suspense>
        </LazyLoadBoundary>
      ) : null}

      {/* About dialog — portal to body to escape aside containing block */}
      {createPortal(
        <ModalOverlay
          isOpen={aboutOpen}
          onClose={() => setAboutOpen(false)}
          ariaLabel={t('关于 AI Canvas')}
          className="w-[420px] max-h-[85vh] overflow-y-auto"
        >
        <div className="p-3 space-y-3">
          {/* Header */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleLogoClick}
              className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-indigo-500/20 transition-transform active:scale-95"
              aria-label={t('AI Canvas')}
            >
              <img src="/icons.svg" alt="" />
            </button>
            <div>
              <h2 className="text-lg font-semibold text-canvas-text">AI Canvas</h2>
              <p className="text-xs text-canvas-text-secondary">v{appVersion} · {t('开发预览版')}</p>
              <button
                onClick={updateStatus === 'available' ? handleDownloadUpdate : handleCheckUpdate}
                disabled={updateStatus === 'checking' || updateStatus === 'updating'}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:text-canvas-text-muted transition-colors"
              >
                {updateStatus === 'checking' ? (
                  <>
                    <Icon icon="svg-spinners:90-ring" width="12" height="12" />
                    {t('检查中...')}
                  </>
                ) : updateStatus === 'updating' ? (
                  <>
                    <Icon icon="svg-spinners:90-ring" width="12" height="12" />
                    {t('下载中...')}
                  </>
                ) : updateStatus === 'no-update' && updateMsg ? (
                  updateMsg
                ) : updateStatus === 'available' ? (
                  t('发现 v{version}，点击更新', { version: updateVersion })
                ) : updateStatus === 'error' ? (
                  updateMsg
                ) : (
                  t('检查更新')
                )}
              </button>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm text-canvas-text-secondary leading-relaxed">
            {t('AI Canvas 是一个智能多媒体创意画布，通过可视化节点编排的方式，调用多种 AI 模型来生成文本、图像、视频和音频内容。支持多厂商模型接入、ComfyUI 工作流、本地文件管理与实时协作。')}
          </p>

          {/* Feature list */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">{t('核心能力')}</h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'AI 文本生成', color: 'bg-indigo-500/20 text-indigo-400' },
                { label: 'AI 图像生成', color: 'bg-green-500/20 text-green-400' },
                { label: 'AI 视频生成', color: 'bg-blue-500/20 text-blue-400' },
                { label: 'AI 音频生成', color: 'bg-orange-500/20 text-orange-400' },
                { label: 'ComfyUI 工作流', color: 'bg-purple-500/20 text-purple-400' },
                { label: '节点分组管理', color: 'bg-cyan-500/20 text-cyan-400' },
                { label: '画布无限缩放', color: 'bg-pink-500/20 text-pink-400' },
                { label: '本地文件读写', color: 'bg-yellow-500/20 text-yellow-400' },
              ].map(({ label, color }) => (
                <span
                  key={label}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium ${color}`}
                >
                  {t(label)}
                </span>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-canvas-border" />

          {/* Tech stack */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">{t('技术栈')}</h3>
            <div className="flex flex-wrap gap-1.5">
              {['Tauri 2', 'React 19', 'React Flow 12', 'TypeScript', 'Zustand 5', 'Tailwind CSS 3', 'Vite 8'].map((tech) => (
                <span key={tech} className="px-2.5 py-1 rounded-md bg-canvas-hover text-xs text-canvas-text-secondary">
                  {tech}
                </span>
              ))}
            </div>
          </div>

          {/* Community */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">{t('社区')}</h3>
            <div className="flex flex-col gap-2">
              <a
                href="https://github.com/Tenney95/AI-Canvas-tauri"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-hover hover:bg-canvas-border transition-colors text-xs text-canvas-text-secondary hover:text-canvas-text"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                GitHub
              </a>
              <button
                type="button"
                onClick={() => {
                  const qq = '873354155';
                  navigator.clipboard?.writeText(qq).catch(() => {});
                  useAppStore.getState().showToast(t('已复制 QQ 群号：873354155'));
                }}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-hover hover:bg-canvas-border transition-colors text-xs text-canvas-text-secondary hover:text-canvas-text text-left cursor-pointer"
                data-tooltip={t('点击复制 QQ 群号')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a39.548 39.548 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a38.97 38.97 0 0 0-.802 2.264c-1.021 3.283-1.045 4.643-1.045 4.643 0 1.706 1.036 2.841 2.439 2.841.808 0 1.258-.387 1.85-.92.228-.206.463-.372.708-.498.449-.23 1.022-.405 1.719-.479 1.087-.116 3.274-.464 5.223-.464h.001c1.949 0 4.136.348 5.223.464.697.074 1.27.249 1.719.479.245.126.48.292.708.498.592.533 1.042.92 1.85.92 1.403 0 2.439-1.135 2.439-2.841 0 0-.025-1.361-1.046-4.643z"/></svg>
                {t('QQ 群：873354155')}
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-2 flex items-center justify-between border-t border-canvas-border">
            <span className="text-[11px] text-canvas-text-muted">© 2026 AI Canvas Team</span>
            <AnimatedButton
              type="button"
              className="px-3 py-1.5 text-xs font-medium text-canvas-text bg-canvas-hover hover:bg-canvas-border rounded-lg transition-colors"
              onClick={() => setAboutOpen(false)}
            >
              {t('知道了')}
            </AnimatedButton>
          </div>
        </div>
      </ModalOverlay>,
        document.body,
      )}
    </>
  );
}

/* ============================================
   Logo / Project switcher menu
   ============================================ */
function LogoMenu() {
  const t = useT();
  const { projectLibraryOpen, setProjectLibraryOpen } = useAppStore(
    useShallow((state) => ({
      projectLibraryOpen: state.projectLibraryOpen,
      setProjectLibraryOpen: state.setProjectLibraryOpen,
    })),
  );

  const openProjectLibrary = () => {
    setProjectLibraryOpen(true);
    window.setTimeout(async () => {
      const store = useAppStore.getState();
      const capturedProjectId = await store.captureCurrentProjectSnapshot();
      if (capturedProjectId && useAppStore.getState().currentProjectId === capturedProjectId) {
        await useAppStore.getState().saveCurrentProjectSilent();
      }
    }, 220);
  };

  return (
    <>
      <button
        type="button"
        className={`sidebar-btn-v3 sidebar-canvas-btn ${projectLibraryOpen ? 'active' : ''}`}
        data-tooltip={t('画布 / 项目')}
        aria-haspopup="dialog"
        aria-expanded={projectLibraryOpen}
        onClick={openProjectLibrary}
      >
        <svg className="ico-normal" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 14a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM18 3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm-6-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm-8 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm8-8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 15a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm8-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z" clipRule="evenodd" />
        </svg>
        <svg className="ico-hover" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="4" width="13" height="16" rx="2" />
          <path d="m19 8 3 4-3 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13 12h9" strokeLinecap="round" />
        </svg>
      </button>

      {createPortal(
        <ProjectLibraryModal
          isOpen={projectLibraryOpen}
          onClose={() => setProjectLibraryOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}

/* ============================================
   Main Sidebar
   ============================================ */
export default function Sidebar() {
  const t = useT();
  const {
    openNodePicker,
    closeNodePicker,
    toggleAvatarMenu,
    nodePickerOpen,
    setAssetsPanelOpen,
    setCharacterLibraryOpen,
    setHistoryPanelOpen,
    unreadDramaAssetCount,
  } = useAppStore(
      useShallow((s) => ({
        openNodePicker: s.openNodePicker,
        closeNodePicker: s.closeNodePicker,
        toggleAvatarMenu: s.toggleAvatarMenu,
        nodePickerOpen: s.nodePickerOpen,
        setAssetsPanelOpen: s.setAssetsPanelOpen,
        setCharacterLibraryOpen: s.setCharacterLibraryOpen,
        setHistoryPanelOpen: s.setHistoryPanelOpen,
        unreadDramaAssetCount: countUnreadDramaAssets(s.dramaAssets),
      })),
    );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAddEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openNodePicker();
  };
  const handleAddLeave = () => {
    closeTimer.current = setTimeout(closeNodePicker, 120);
  };
  const handlePickerEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const handlePickerLeave = () => {
    closeNodePicker();
  };

  return (
    <aside data-tauri-drag-region className="sidebar-floating">
      {/* Add button — hover to open node picker */}
      <button
        id="btn-add-node"
        type="button"
        className={`sidebar-btn-v3 add-btn-v3 ${nodePickerOpen ? 'active' : ''}`}
        onMouseEnter={handleAddEnter}
        onMouseLeave={handleAddLeave}
        onClick={() => (nodePickerOpen ? closeNodePicker() : openNodePicker())}
        aria-label={t('添加节点')}
      >
        {/* Normal: plus */}
        <svg className="ico-normal" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {/* Hover/active: cross */}
        <svg className="ico-hover" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>

      {/* Logo / Canvas home */}
      <div className="sidebar-logo-wrap">
        <LogoMenu />
      </div>

      {/* Assets */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={unreadDramaAssetCount > 0 ? t('资产 · 新增短剧资产 ({count})', { count: unreadDramaAssetCount }) : t('资产')}
        onClick={() => setAssetsPanelOpen(true)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><path strokeDasharray="64" strokeDashoffset="64" d="M12 7h8c0.55 0 1 0.45 1 1v10c0 0.55 -0.45 1 -1 1h-16c-0.55 0 -1 -0.45 -1 -1v-11Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="64;0"/></path><path d="M12 7h-9v0c0 0 0.45 0 1 0h6z" opacity="0"><animate fill="freeze" attributeName="d" begin="0.6s" dur="0.2s" values="M12 7h-9v0c0 0 0.45 0 1 0h6z;M12 7h-9v-1c0 -0.55 0.45 -1 1 -1h6z"/><set fill="freeze" attributeName="opacity" begin="0.6s" to="1"/></path></g></svg>
        {unreadDramaAssetCount > 0 ? (
          <span className="sidebar-badge">
            {unreadDramaAssetCount > 99 ? '99+' : unreadDramaAssetCount}
          </span>
        ) : null}
      </button>

      {/* Character library */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={t('角色库')}
        aria-label={t('打开角色库')}
        onClick={() => setCharacterLibraryOpen(true)}
      >
        <Icon icon="lucide:contact-round" width="20" height="20" aria-hidden="true" />
      </button>

      {/* History */}
      <button type="button" className="sidebar-btn-v3" data-tooltip={t('输出历史')} onClick={() => setHistoryPanelOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M11.007 21H9.605c-3.585 0-5.377 0-6.491-1.135S2 16.903 2 13.25s0-5.48 1.114-6.615S6.02 5.5 9.605 5.5h3.803c3.585 0 5.378 0 6.492 1.135c.857.873 1.054 2.156 1.1 4.365"/><path d="m18.85 18.85l-1.35-.9V15.7M13 17.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 0 0-9 0m3-12l-.1-.31c-.494-1.54-.742-2.31-1.331-2.75C13.979 2 13.197 2 11.632 2h-.264c-1.565 0-2.348 0-2.937.44c-.59.44-.837 1.21-1.332 2.75L7 5.5"/></g></svg>
      </button>

      {/* AI Chat Assistant */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={t('AI 助手')}
        aria-label={t('打开 AI 助手')}
        onClick={async () => {
          const store = useAppStore.getState();
          if (store.chatPanelDetached) {
            // 保留独立显示偏好：窗口被关闭后，再次点击仍打开独立窗口。
            try {
              await invoke('open_chat_window');
            } catch {
              store.showToast(t('打开独立窗口失败'), 'error');
            }
          } else {
            store.toggleChat();
          }
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <rect x="8.4" y="9.25" width="2" height="5.5" rx="1" fill="currentColor" />
          <rect x="13.6" y="9.25" width="2" height="5.5" rx="1" fill="currentColor" />
        </svg>
      </button>

      {/* Task Center */}
      {/* <button type="button" className="sidebar-btn-v3 task-center-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 6h11" strokeLinecap="round" />
          <path d="M9 12h11" strokeLinecap="round" />
          <path d="M9 18h11" strokeLinecap="round" />
          <path d="M4 6l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 12l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 18l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="task-center-tooltip">
          <span>任务</span>
          <span className="task-center-tooltip-beta">beta</span>
        </span>
      </button> */}

      {/* Separator */}
      <div className="sidebar-sep-v3" />

      {/* Settings / Avatar */}
      <div className="avatar-wrap">
        <button
          id="btn-user-gear"
          type="button"
          className="user-gear-plain"
          onClick={toggleAvatarMenu}
          data-tooltip={t('设置')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
        </button>
        <AvatarMenu />
      </div>

      {/* Node Picker popup */}
      <NodePicker onEnter={handlePickerEnter} onLeave={handlePickerLeave} />
    </aside>
  );
}
