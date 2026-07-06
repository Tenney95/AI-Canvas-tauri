import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { createPortal } from 'react-dom';
import type { JSX } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, computeImageNodeDimensions } from '../store/useAppStore';
import ModalOverlay from './shared/ModalOverlay';
import type { NodeType } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import { uploadSourceFileToProject } from '../services/fileService';
import { classifyFile } from '../hooks/useNodeCreation';
import AnimatedButton from './shared/AnimatedButton';

/**
 * Sidebar 侧边栏面板 — 左侧节点类型列表、上传入口、项目切换、拖拽添加节点
 */

/* ============================================
   Node picker menu items
   ============================================ */
const generationItems: {
  type: NodeType | '3d-director';
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
  const { nodePickerOpen, closeNodePicker, addNode, lastCanvasMousePos, currentProjectId, showToast } = useAppStore(
    useShallow((s) => ({
      nodePickerOpen: s.nodePickerOpen,
      closeNodePicker: s.closeNodePicker,
      addNode: s.addNode,
      lastCanvasMousePos: s.lastCanvasMousePos,
      currentProjectId: s.currentProjectId,
      showToast: s.showToast,
    })),
  );
  const pickerRef = useRef<HTMLDivElement>(null);

  const handleAddNode = (type: NodeType) => {
    const isImage = type === 'ai-image';
    const isPanorama = type === 'ai-panorama';
    const nodeData: Record<string, unknown> = {
      label: NODE_TYPE_CONFIG[type]?.label || generationItems.find((m) => m.type === type)?.label || '节点',
      type,
      prompt: '',
      status: 'idle' as const,
      nodeWidth: isPanorama ? 300 : 280,
      nodeHeight: isImage ? 158 : isPanorama ? 200 : 160,
    };
    if (isImage) {
      nodeData.aspectRatio = '16:9';
      nodeData.imageSize = '2K';
    }
    if (isPanorama) {
      nodeData.previewMode = 'image';
    }
    // Auto-fill default model from localStorage preference
    // 全景图节点回退到生图节点偏好
    try {
      const raw = localStorage.getItem('canvas-model-prefs');
      if (raw) {
        const prefs: Record<string, string> = JSON.parse(raw);
        const modelValue = prefs[type] || (type === 'ai-panorama' ? prefs['ai-image'] : undefined);
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
    const pos = lastCanvasMousePos ?? { x: 300, y: 200 };
    addNode({
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
        showToast('不支持的文件类型', 'error');
        return;
      }

      const pos = lastCanvasMousePos ?? { x: 300, y: 200 };
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
      const msg = err instanceof Error ? err.message : '上传失败';
      showToast(msg, 'error');
    }
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
        <span className="menu-title">画布自由生成</span>
        <div className="menu-rule" />
      </div>
      {generationItems.map(({ type, label, sub, icon }) => (
        <AnimatedButton
          key={type}
          scale={1.02}
          className="menu-row has-desc"
          onClick={() => {
            if (type === '3d-director') return; // placeholder
            handleAddNode(type as NodeType);
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{label}</span>
            <span className="menu-sub">{sub}</span>
          </div>
        </AnimatedButton>
      ))}
      <div className="menu-section">
        <span className="menu-title">添加资源</span>
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
            <span className="menu-lbl">{label}</span>
            <span className="menu-sub">{sub}</span>
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
  const { avatarMenuOpen, closeAvatarMenu, setSettingsOpen } = useAppStore(
    useShallow((s) => ({
      avatarMenuOpen: s.avatarMenuOpen,
      closeAvatarMenu: s.closeAvatarMenu,
      setSettingsOpen: s.setSettingsOpen,
    })),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
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
            设置
          </AnimatedButton>
          <div className="avatar-menu-sep" />
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
            关于
          </AnimatedButton>
        </motion.div>
      )}
    </AnimatePresence>

      {/* About dialog — portal to body to escape aside containing block */}
      {createPortal(
        <ModalOverlay isOpen={aboutOpen} onClose={() => setAboutOpen(false)} className="w-[420px] max-h-[85vh] overflow-y-auto">
        <div className="p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/20">
              <img src="/icons.svg" alt="" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-canvas-text">AI Canvas</h2>
              <p className="text-xs text-canvas-text-secondary">v{appVersion} · 开发预览版</p>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm text-canvas-text-secondary leading-relaxed">
            AI Canvas 是一个智能多媒体创意画布，通过可视化节点编排的方式，
            调用多种 AI 模型来生成文本、图像、视频和音频内容。支持多厂商模型接入、
            ComfyUI 工作流、本地文件管理与实时协作。
          </p>

          {/* Feature list */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-canvas-text-muted">核心能力</h3>
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
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-canvas-border" />

          {/* Tech stack */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-canvas-text-muted">技术栈</h3>
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
            <h3 className="text-xs font-semibold uppercase tracking-wider text-canvas-text-muted">社区</h3>
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
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-hover hover:bg-canvas-border transition-colors text-xs text-canvas-text-secondary hover:text-canvas-text text-left cursor-default"
                title="QQ 群号"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a39.548 39.548 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a38.97 38.97 0 0 0-.802 2.264c-1.021 3.283-1.045 4.643-1.045 4.643 0 1.706 1.036 2.841 2.439 2.841.808 0 1.258-.387 1.85-.92.228-.206.463-.372.708-.498.449-.23 1.022-.405 1.719-.479 1.087-.116 3.274-.464 5.223-.464h.001c1.949 0 4.136.348 5.223.464.697.074 1.27.249 1.719.479.245.126.48.292.708.498.592.533 1.042.92 1.85.92 1.403 0 2.439-1.135 2.439-2.841 0 0-.025-1.361-1.046-4.643z"/></svg>
                QQ 群：873354155
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-2 flex items-center justify-between border-t border-canvas-border">
            <span className="text-[11px] text-canvas-text-muted">© 2026 AI Canvas Team</span>
            <AnimatedButton
              type="button"
              className="px-4 py-1.5 text-xs font-medium text-canvas-text bg-canvas-hover hover:bg-canvas-border rounded-lg transition-colors"
              onClick={() => setAboutOpen(false)}
            >
              知道了
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
  const {
    projects,
    currentProjectId,
    projectName,
    switchProject,
    createProject,
    deleteProject,
  } = useAppStore(
    useShallow((s) => ({
      projects: s.projects,
      currentProjectId: s.currentProjectId,
      projectName: s.projectName,
      switchProject: s.switchProject,
      createProject: s.createProject,
      deleteProject: s.deleteProject,
    })),
  );
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; rect: DOMRect } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Suppress outside-click close while delete confirmation is showing,
    // otherwise the capture-phase mousedown fires setOpen(false) which
    // causes a re-render that prevents the confirm button's onClick.
    if (confirmDelete) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open, confirmDelete]);

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`sidebar-btn-v3 sidebar-canvas-btn ${open ? 'active' : ''}`}
        title="画布 / 项目"
        onClick={() => setOpen(!open)}
      >
        {/* <svg className="ico-normal" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="6" width="14" height="11" rx="2" />
          <rect x="7" y="3" width="14" height="11" rx="2" />
          <circle cx="19" cy="4" r="2.5" fill="currentColor" opacity="0.6" />
        </svg> */}
        <svg className="ico-normal" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path fill="currentColor" fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 14a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM18 3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm-6-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm-8 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm8-8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 15a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm8-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z" clipRule="evenodd"/></svg>
        <svg className="ico-hover" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="13" height="16" rx="2" />
          <path d="M19 8l3 4-3 4" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="13" y1="12" x2="22" y2="12" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="node-picker"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="menu-section">
              <span className="menu-title">当前项目</span>
              <div className="menu-rule" />
            </div>
          <div className="menu-row menu-row-current">
            <div className="menu-ico menu-ico--brand">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="6" width="14" height="11" rx="2" />
                <rect x="7" y="3" width="14" height="11" rx="2" />
                <circle cx="19" cy="4" r="2.5" fill="currentColor" opacity="0.6" />
              </svg>
            </div>
            <div className="menu-txt-wrap">
              <span className="menu-lbl">{projectName}</span>
            </div>
          </div>

          <div className="menu-section">
            <span className="menu-title">项目列表</span>
            <div className="menu-rule" />
          </div>
          <div className="project-list-scroll">
            {projects.map((p) => (
              <AnimatedButton
                key={p.id}
                type="button"
                scale={1.01}
                className={`menu-row${p.id === currentProjectId ? ' menu-row--active' : ''}`}
                onClick={() => {
                  switchProject(p.id);
                  setOpen(false);
                }}
              >
                <div className="menu-ico">
                  {p.id === currentProjectId ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="5" />
                      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="3" y="3" width="18" height="18" rx="3" />
                    </svg>
                  )}
                </div>
                <div className="menu-txt-wrap">
                  <span className="menu-lbl">
                    {p.name}
                  </span>
                  <span className="menu-sub">
                    {new Date(p.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {p.id !== 'default' && projects.filter(proj => proj.id !== 'default').length > 1 && (
                  <span
                    className="project-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setConfirmDelete({ id: p.id, rect });
                    }}
                    title="删除项目"
                    role="button"
                    tabIndex={0}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </span>
                )}
              </AnimatedButton>
            ))}
          </div>

          <div className="menu-section">
            <span className="menu-title">操作</span>
            <div className="menu-rule" />
          </div>
          <AnimatedButton
            type="button"
            className="menu-row"
            scale={1.02}
            onClick={() => {
              createProject();
              setOpen(false);
            }}
          >
            <div className="menu-ico">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <div className="menu-txt-wrap">
              <span className="menu-lbl">新建项目</span>
            </div>
          </AnimatedButton>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Project Confirm Popover — portal to body, positioned above the delete button */}
      {confirmDelete && createPortal((() => {
        const target = projects.find((p) => p.id === confirmDelete.id);
        const DIALOG_W = 260;
        const DIALOG_H = 130;
        const PAD = 8;
        const r = confirmDelete.rect;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // 水平居中于删除按钮，但不超出屏幕
        let left = r.left + r.width / 2;
        if (left < PAD) left = PAD;
        if (left + DIALOG_W / 2 > vw - PAD) left = vw - PAD - DIALOG_W / 2;
        if (left - DIALOG_W / 2 < PAD) left = DIALOG_W / 2 + PAD;

        // 优先在按钮上方弹出；上方空间不足则改为下方
        const aboveSpace = r.top - DIALOG_H - 10;
        let top: number;
        let arrowClass = '';
        if (aboveSpace >= PAD) {
          top = r.top - DIALOG_H - 10;
          arrowClass = ' delete-confirm-below'; // arrow points down
        } else {
          top = r.bottom + 10;
          arrowClass = ' delete-confirm-above'; // arrow points up
          if (top + DIALOG_H > vh - PAD) {
            top = Math.max(PAD, vh - DIALOG_H - PAD);
          }
        }

        const dialogStyle: React.CSSProperties = {
          position: 'fixed' as const,
          left: `${left}px`,
          top: `${top}px`,
          transform: 'translateX(-50%)',
        };
        return (
          <>
            <div className="delete-confirm-overlay" onClick={() => setConfirmDelete(null)} />
            <div className={`delete-confirm-dialog${arrowClass}`} style={dialogStyle} onClick={(e) => e.stopPropagation()}>
              <div className="delete-confirm-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="delete-confirm-text">
                <p className="delete-confirm-title">确认删除「{target?.name ?? '未命名项目'}」</p>
                <p className="delete-confirm-hint">此操作不可撤销</p>
              </div>
              <div className="delete-confirm-actions">
                <AnimatedButton
                  type="button"
                  className="delete-confirm-btn cancel"
                  onClick={() => setConfirmDelete(null)}
                >
                  取消
                </AnimatedButton>
                <AnimatedButton
                  type="button"
                  className="delete-confirm-btn confirm"
                  onClick={() => {
                    deleteProject(confirmDelete.id);
                    setConfirmDelete(null);
                    setOpen(false);
                  }}
                >
                  确认删除
                </AnimatedButton>
              </div>
            </div>
          </>
        );
      })(), document.body)}
    </div>
  );
}

/* ============================================
   Main Sidebar
   ============================================ */
export default function Sidebar() {
  const { openNodePicker, closeNodePicker, toggleAvatarMenu, nodePickerOpen, setWorkflowPanelOpen, setAssetsPanelOpen, setHistoryPanelOpen } =
    useAppStore(
      useShallow((s) => ({
        openNodePicker: s.openNodePicker,
        closeNodePicker: s.closeNodePicker,
        toggleAvatarMenu: s.toggleAvatarMenu,
        nodePickerOpen: s.nodePickerOpen,
        setWorkflowPanelOpen: s.setWorkflowPanelOpen,
        setAssetsPanelOpen: s.setAssetsPanelOpen,
        setHistoryPanelOpen: s.setHistoryPanelOpen,
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
      <button type="button" className="sidebar-btn-v3" title="资产" onClick={() => setAssetsPanelOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><path strokeDasharray="64" strokeDashoffset="64" d="M12 7h8c0.55 0 1 0.45 1 1v10c0 0.55 -0.45 1 -1 1h-16c-0.55 0 -1 -0.45 -1 -1v-11Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="64;0"/></path><path d="M12 7h-9v0c0 0 0.45 0 1 0h6z" opacity="0"><animate fill="freeze" attributeName="d" begin="0.6s" dur="0.2s" values="M12 7h-9v0c0 0 0.45 0 1 0h6z;M12 7h-9v-1c0 -0.55 0.45 -1 1 -1h6z"/><set fill="freeze" attributeName="opacity" begin="0.6s" to="1"/></path></g></svg>
      </button>

      {/* Workflows */}
      <button type="button" className="sidebar-btn-v3" title="工作流" onClick={() => setWorkflowPanelOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M1 3a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H7v4.063C7 16.355 7.644 17 8.438 17H12.5v-2.5a2 2 0 0 1 2-2H21a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2v-2.5H8.437A2.94 2.94 0 0 1 5.5 15.562V11.5H3a2 2 0 0 1-2-2Zm2-.5a.5.5 0 0 0-.5.5v6.5a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5ZM14.5 14a.5.5 0 0 0-.5.5V21a.5.5 0 0 0 .5.5H21a.5.5 0 0 0 .5-.5v-6.5a.5.5 0 0 0-.5-.5Z"/></svg>
      </button>

      {/* History */}
      <button type="button" className="sidebar-btn-v3" title="输出历史" onClick={() => setHistoryPanelOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M11.007 21H9.605c-3.585 0-5.377 0-6.491-1.135S2 16.903 2 13.25s0-5.48 1.114-6.615S6.02 5.5 9.605 5.5h3.803c3.585 0 5.378 0 6.492 1.135c.857.873 1.054 2.156 1.1 4.365"/><path d="m18.85 18.85l-1.35-.9V15.7M13 17.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 0 0-9 0m3-12l-.1-.31c-.494-1.54-.742-2.31-1.331-2.75C13.979 2 13.197 2 11.632 2h-.264c-1.565 0-2.348 0-2.937.44c-.59.44-.837 1.21-1.332 2.75L7 5.5"/></g></svg>
      </button>

      {/* Spacer */}
      <div className="sidebar-flex-spacer" />

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
          title="设置"
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
