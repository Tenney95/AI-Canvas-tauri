import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { NodeType } from '../types';

const menuItems: { type: NodeType; label: string; icon: JSX.Element; badge?: string; color: string }[] = [
  {
    type: 'ai-text',
    label: '文本',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
    badge: 'Gemini3',
    color: 'indigo',
  },
  {
    type: 'ai-image',
    label: '图像',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    ),
    badge: 'Banana Pro',
    color: 'green',
  },
  {
    type: 'ai-video',
    label: '视频',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" />
      </svg>
    ),
    color: 'blue',
  },
  {
    type: 'ai-audio',
    label: '音频',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    ),
    badge: 'Beta',
    color: 'orange',
  },
];

export default function NodeMenu() {
  const { nodeMenuVisible, nodeMenuPosition, hideNodeMenu, addNode, nodes } = useAppStore();
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

  if (!nodeMenuVisible) return null;

  const handleAddNode = (type: NodeType) => {
    const offset = nodes.length * 40;
    const isImage = type === 'ai-image';
    const newNode: Record<string, unknown> = {
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      position: { x: 300 + offset, y: 100 + offset },
      data: {
        label: menuItems.find((m) => m.type === type)?.label || '节点',
        type,
        prompt: '',
        status: 'idle' as const,
        nodeWidth: 280,
        nodeHeight: isImage ? 158 : 160,
        ...(isImage ? { aspectRatio: '16:9', imageSize: '2K' } : {}),
      },
    };
    addNode(newNode as never);
    hideNodeMenu();
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-[240px] bg-canvas-card border border-canvas-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      style={{ left: nodeMenuPosition.x, top: nodeMenuPosition.y }}
    >
      <div className="p-2">
        <div className="text-[11px] font-medium text-canvas-text-muted uppercase tracking-wider px-2 py-1.5">
          添加节点
        </div>
        <div className="space-y-0.5 mt-1">
          {menuItems.map(({ type, label, icon, badge, color }) => (
            <button
              key={type}
              onClick={() => handleAddNode(type)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-canvas-hover transition-colors text-left"
            >
              <div className={`w-8 h-8 rounded-md bg-${color}-500/10 flex items-center justify-center shrink-0`}>
                {icon}
              </div>
              <span className="text-sm text-canvas-text">{label}</span>
              {badge && (
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${color === 'indigo' ? 'bg-purple-500/15 text-purple-400' : `bg-${color}-500/15 text-${color}-400`}`}>
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-canvas-border p-2">
        <button className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-canvas-hover transition-colors text-left">
          <div className="w-8 h-8 rounded-md bg-canvas-hover flex items-center justify-center text-canvas-text-secondary shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 16 12 12 8 16" />
              <line x1="12" y1="12" x2="12" y2="21" />
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
            </svg>
          </div>
          <span className="text-sm text-canvas-text-secondary">上传文件</span>
        </button>
      </div>
    </div>
  );
}
