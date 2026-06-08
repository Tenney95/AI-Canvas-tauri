/**
 * ConnectionMenu 连线目标选择菜单 — 从节点输出 Handle 拖出连线时弹出，选择要创建的目标节点类型
 * 自动检测屏幕边界，避免溢出
 */
import { memo, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { NodeType } from '../../types';
import type { BaseNodeData } from '../../types';
import type { Node as RFNode } from '@xyflow/react';
import { calcFixedPosition } from '../../utils/popupPosition';

interface ConnectionMenuOption {
  label: string;
  type: NodeType;
}

interface ConnectionMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  sourceNodeType: string;
  sourceNode: RFNode<BaseNodeData> | undefined;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (option: ConnectionMenuOption) => void;
  connectionMenuMap: Record<string, ConnectionMenuOption[]>;
}

const iconColors: Record<string, string> = {
  'ai-text': 'text-indigo-400 bg-indigo-500/10',
  'ai-image': 'text-green-400 bg-green-500/10',
  'ai-video': 'text-blue-400 bg-blue-500/10',
  'ai-audio': 'text-orange-400 bg-orange-500/10',
  'ai-panorama': 'text-cyan-400 bg-cyan-500/10',
};

const MENU_W = 260;
const MENU_H = 290; // header + ~6 items max

function ConnectionMenu({
  visible,
  position,
  sourceNodeType,
  sourceNode,
  menuRef,
  onSelect,
  connectionMenuMap,
}: ConnectionMenuProps) {
  if (!visible) return null;

  const items = connectionMenuMap[sourceNodeType];
  if (!items?.length) return null;

  const safePos = useMemo(
    () => calcFixedPosition(position.x, position.y, MENU_W, MENU_H),
    [position.x, position.y],
  );

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={menuRef}
          className="fixed z-50 w-[260px] bg-canvas-card border border-canvas-border rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
          style={{ left: safePos.left, top: safePos.top }}
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-canvas-border">
        <div className="text-[11px] font-medium text-canvas-text-muted uppercase tracking-wider mb-1">
          引用该节点生成
        </div>
        <div className="text-xs text-canvas-text-secondary truncate">
          {sourceNode?.data?.label ?? '节点'}
        </div>
      </div>

      {/* Menu items */}
      <div className="p-1.5 space-y-0.5">
        {items.map((opt) => {
          const color = iconColors[opt.type] ?? 'text-canvas-text-secondary bg-canvas-hover';

          return (
            <button
              key={`${opt.type}-${opt.label}`}
              onClick={() => onSelect(opt)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-canvas-hover transition-colors text-left group"
            >
              <div className={`w-8 h-8 rounded-md ${color} flex items-center justify-center shrink-0`}>
                {opt.type === 'ai-panorama' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <ellipse cx="12" cy="12" rx="6" ry="10" />
                    <line x1="12" y1="2" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                  </svg>
                ) : opt.type === 'ai-text' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="4 7 4 4 20 4 20 7" />
                    <line x1="9" y1="20" x2="15" y2="20" />
                    <line x1="12" y1="4" x2="12" y2="20" />
                  </svg>
                ) : opt.type === 'ai-image' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                ) : opt.type === 'ai-video' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                )}
              </div>
              <span className="text-sm text-canvas-text group-hover:text-white transition-colors">
                {opt.label}
              </span>
              {opt.type === 'ai-panorama' && (
                <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400">
                  全景
                </span>
              )}
            </button>
          );
        })}
      </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default memo(ConnectionMenu);
