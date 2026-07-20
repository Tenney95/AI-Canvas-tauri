/**
 * NodeMenu 浮动节点菜单 — 半透明悬浮按钮，点击展开节点类型选择列表，快速添加节点到画布
 * 自动检测屏幕边界，避免溢出
 */
import { useEffect, useRef, useMemo } from 'react';
import type { JSX } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { springSmooth, fadeFast } from '../utils/motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, computeImageNodeDimensions } from '../store/useAppStore';
import type { NodeType } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import { calcFixedPosition } from '../utils/popupPosition';
import { uploadSourceFileToProject } from '../services/fileService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { classifyFile } from '../hooks/useNodeCreation';
import AnimatedButton from './shared/AnimatedButton';

const menuItems: { type: NodeType; label: string; icon: JSX.Element; badge?: string }[] = [
  {
    type: 'ai-text',
    label: '文本',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-text'].icon} width="18" height="18" />,
    badge: 'Gemini3',
  },
  {
    type: 'ai-image',
    label: '图像',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-image'].icon} width="18" height="18" />,
    badge: 'Banana Pro',
  },
  {
    type: 'ai-video',
    label: '视频',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-video'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-audio',
    label: '音频',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-audio'].icon} width="18" height="18" />,
    badge: 'Beta',
  },
  {
    type: 'ai-animation',
    label: '动画',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-animation'].icon} width="18" height="18" />,
    badge: 'Sprite',
  },
  {
    type: 'ai-director',
    label: '3D导演台',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-director'].icon} width="18" height="18" />,
    badge: '3D',
  },
];

const NODE_MENU_W = 240;
const NODE_MENU_H = 390; // items + header + footer

export default function NodeMenu() {
  const { nodeMenuVisible, nodeMenuPosition, hideNodeMenu, addNode, currentProjectId, showToast } = useAppStore(
    useShallow((s) => ({
      nodeMenuVisible: s.nodeMenuVisible,
      nodeMenuPosition: s.nodeMenuPosition,
      hideNodeMenu: s.hideNodeMenu,
      addNode: s.addNode,
      currentProjectId: s.currentProjectId,
      showToast: s.showToast,
    })),
  );
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideNodeMenu();
      }
    }
    if (nodeMenuVisible) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [nodeMenuVisible, hideNodeMenu]);

  const handleAddNode = (type: NodeType) => {
    const isImage = type === 'ai-image';
    const isAnimation = type === 'ai-animation';
    const isDirector = type === 'ai-director';
    const pos = getCanvasPointerPosition();
    const newNode: Record<string, unknown> = {
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      position: pos,
      data: {
        label: menuItems.find((m) => m.type === type)?.label || '节点',
        type,
        prompt: '',
        status: 'idle' as const,
        nodeWidth: isAnimation || isDirector ? 320 : 280,
        nodeHeight: isDirector ? 240 : isImage ? 158 : isAnimation ? 358 : 160,
        ...(isImage ? { aspectRatio: '16:9', imageSize: '2K' } : {}),
        ...(isAnimation ? {
          prompt: '2D俯视角游戏角色，保持角色造型、朝向、比例和光照一致',
          animationAction: 'idle',
          animationFrames: 8,
          animationPreviewMode: 'playing',
          aspectRatio: '1:1',
          imageSize: '2K',
        } : {}),
        ...(isDirector ? {
          role: 'source',
          directorStatus: 'idle',
          directorCaptureUrls: [],
        } : {}),
      },
    };
    addNode(newNode as never);
    hideNodeMenu();
  };

  const handleUploadFile = async () => {
    hideNodeMenu();
    try {
      const result = await uploadSourceFileToProject('*/*', currentProjectId);
      if (!result) return;

      const ext = result.fileName.split('.').pop()?.toLowerCase() || '';
      const category = classifyFile(ext);

      if (!category) {
        showToast('不支持的文件类型', 'error');
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
      const msg = err instanceof Error ? err.message : '上传失败';
      showToast(msg, 'error');
    }
  };

  const safePos = useMemo(
    () => calcFixedPosition(nodeMenuPosition.x, nodeMenuPosition.y, NODE_MENU_W, NODE_MENU_H),
    [nodeMenuPosition.x, nodeMenuPosition.y],
  );

  return (
    <AnimatePresence>
      {nodeMenuVisible && (
        <motion.div
          ref={menuRef}
          className="fixed z-50 w-[240px] bg-canvas-card border border-canvas-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden"
          style={{ left: safePos.left, top: safePos.top, transformOrigin: 'top center' }}
          initial={{ opacity: 0, scale: 0.92, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -6, transition: fadeFast }}
          transition={springSmooth}
        >
      <div className="p-2">
        <div className="text-[11px] font-medium text-canvas-text-muted uppercase px-2 py-1.5">
          添加节点
        </div>
        <div className="space-y-0.5 mt-1">
          {menuItems.map(({ type, label, icon, badge }) => {
            const cfg = NODE_TYPE_CONFIG[type];
            return (
            <AnimatedButton
              key={type}
              onClick={() => handleAddNode(type)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-canvas-hover transition-colors text-left"
            >
              <div className={`w-8 h-8 rounded-md ${cfg?.bg || 'bg-gray-500/10'} flex items-center justify-center shrink-0`}>
                {icon}
              </div>
              <span className="text-sm text-canvas-text">{label}</span>
              {badge && (
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${cfg?.bg || 'bg-gray-500/15'} ${cfg?.color || 'text-gray-400'}`}>
                  {badge}
                </span>
              )}
            </AnimatedButton>
          )})}
        </div>
      </div>
      <div className="border-t border-canvas-border p-2">
        <AnimatedButton
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-canvas-hover transition-colors text-left"
          onClick={handleUploadFile}
        >
          <div className="w-8 h-8 rounded-md bg-canvas-hover flex items-center justify-center text-canvas-text-secondary shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 16 12 12 8 16" />
              <line x1="12" y1="12" x2="12" y2="21" />
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
            </svg>
          </div>
          <span className="text-sm text-canvas-text-secondary">上传文件</span>
        </AnimatedButton>
      </div>
      </motion.div>
      )}
    </AnimatePresence>
  );
}
