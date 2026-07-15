/**
 * CanvasContextMenu 画布右键菜单 — 在画布空白区域右键弹出，支持添加节点（生成/来源）、撤销、重做、粘贴
 * 子菜单位置会自动检测屏幕边界，避免溢出
 */
import { memo, useLayoutEffect, useState } from 'react';
import type { NodeType } from '../../types';
import { calcFixedPosition, calcSubmenuPosition } from '../../utils/popupPosition';

interface MergedNodeItem {
  label: string;
  type: NodeType;
  role: 'generator' | 'source';
}

const NODE_ITEMS: MergedNodeItem[] = [
  // ── 生成节点 ──
  { label: '生成文本', type: 'ai-text', role: 'generator' },
  { label: '生成图像', type: 'ai-image', role: 'generator' },
  { label: '生成视频', type: 'ai-video', role: 'generator' },
  { label: '生成音频', type: 'ai-audio', role: 'generator' },
  { label: '生成动画', type: 'ai-animation', role: 'generator' },
  { label: '生成360全景', type: 'ai-panorama', role: 'generator' },
  // ── 源节点 ──
  { label: '文本', type: 'ai-text', role: 'source' },
  { label: '图像', type: 'ai-image', role: 'source' },
  { label: '视频', type: 'ai-video', role: 'source' },
  { label: '音频', type: 'ai-audio', role: 'source' },
  { label: 'Markdown', type: 'ai-markdown', role: 'source' },
];

/** 菜单项行高估算（含 padding） */
const ROW_HEIGHT = 28;
/** 菜单 padding + border 估算 */
const MENU_PADDING = 10;
/** 根菜单项数（添加节点 + 分割线 + 粘贴 + 撤销 + 重做 + 分割线 + 打开项目文件夹 + 删除 = 7 个 .menu-row + 3 个 .menu-sep） */
const L1_ITEM_COUNT = 7;
const L1_SEP_COUNT = 3;
/** 子菜单项数（6 个生成节点 + 1 条分割线 + 5 个源节点 = 11 个 .menu-row + 1 个 .menu-sep） */
const SUB_ITEM_COUNT = 11;
const SUB_SEP_COUNT = 1;

/** 估算菜单高度 */
function estMenuHeight(items: number, seps: number = 0): number {
  return items * ROW_HEIGHT + seps * 8 + MENU_PADDING;
}

/** 估算菜单宽度 */
function estMenuWidth(itemCount: number): number {
  // 最宽的情况：生成文本 (约 170px with padding)
  return Math.max(176, itemCount > 2 ? 180 : 160);
}

interface CanvasContextMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  hoverMenu: 'addNode' | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  submenuRef: React.RefObject<HTMLDivElement | null>;
  onAddNode: (type: NodeType, label: string, role: 'generator' | 'source') => void;
  onUndo: () => void;
  onRedo: () => void;
  onPaste: () => void;
  onDelete: () => void;
  hasSelection: boolean;
  onOpenProjectDir: () => void;
  onShowSubmenu: (menu: 'addNode' | null) => void;
  onHideSubmenu: (backTo: 'addNode' | null) => void;
}

function CanvasContextMenu({
  visible,
  position,
  hoverMenu,
  menuRef,
  submenuRef,
  onAddNode,
  onUndo,
  onRedo,
  onPaste,
  onDelete,
  hasSelection,
  onOpenProjectDir,
  onShowSubmenu,
  onHideSubmenu,
}: CanvasContextMenuProps) {
  // 动态计算子菜单位置，使用 state 触发重渲染。初始值用 CPU 从位置估算，useLayoutEffect 中根据实际 DOM 修正。
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);

  const l1Height = estMenuHeight(L1_ITEM_COUNT, L1_SEP_COUNT);
  const l1Width = estMenuWidth(L1_ITEM_COUNT);

  // 计算 Level 1 菜单的安全位置
  const safeL1 = calcFixedPosition(position.x, position.y, l1Width, l1Height);

  // 当 L1 渲染后，测量实际尺寸并计算子菜单位置
  useLayoutEffect(() => {
    if (!visible) return;
    const l1El = menuRef.current;
    if (!l1El) return;

    const l1Rect = l1El.getBoundingClientRect();
    const subH = estMenuHeight(SUB_ITEM_COUNT, SUB_SEP_COUNT);
    const subW = estMenuWidth(SUB_ITEM_COUNT);
    const sub = calcSubmenuPosition(l1Rect, subW, subH, 'right');
    setSubPos({ left: sub.left, top: sub.top });
  }, [visible, position.x, position.y, menuRef]);

  if (!visible) return null;

  return (
    <>
      {/* Level 1: Root menu */}
      <div
        ref={menuRef}
        className="canvas-ctx-menu"
        style={{ left: safeL1.left, top: safeL1.top }}
      >
        <div
          className={`menu-row menu-row-split${hoverMenu === 'addNode' ? ' highlight' : ''}`}
          onMouseEnter={() => onShowSubmenu('addNode')}
          onMouseLeave={() => onHideSubmenu(null)}
          onClick={() => onShowSubmenu('addNode')}
        >
          <span className="menu-rowlabel">添加节点</span>
          <span className="menu-arrow menu-arrow-ml8">▶</span>
        </div>
        <div className="menu-sep" />
        <div className="menu-row menu-row-split" onClick={onPaste}>
          <span>粘贴</span>
          <span className="menu-kbd">Ctrl V</span>
        </div>
        <div className="menu-row menu-row-split" onClick={onUndo}>
          <span>撤销</span>
          <span className="menu-kbd">Ctrl Z</span>
        </div>
        <div className="menu-row menu-row-split" onClick={onRedo}>
          <span>重做</span>
          <span className="menu-kbd">Ctrl Y</span>
        </div>
        <div className="menu-sep" />
        <div className="menu-row" onClick={onOpenProjectDir}>
          <span>打开项目文件夹</span>
        </div>
        {hasSelection && (
          <>
            <div className="menu-sep" />
            <div className="menu-row menu-row-split menu-row-danger" onClick={onDelete}>
              <span>删除</span>
              <span className="menu-kbd">Del</span>
            </div>
          </>
        )}
      </div>

      {/* 合并子菜单：生成节点 + 分割线 + 源节点 */}
      {hoverMenu === 'addNode' && subPos && (
        <div
          ref={submenuRef}
          className="canvas-ctx-menu submenu"
          style={{ left: subPos.left, top: subPos.top }}
          onMouseEnter={() => onShowSubmenu('addNode')}
          onMouseLeave={() => onHideSubmenu(null)}
        >
          {NODE_ITEMS.map((item, i) => (
            <div key={`${item.role}-${item.type}`}>
              {/* 第 6 项前插入分割线（生成节点 → 源节点） */}
              {i === 6 && <div className="menu-sep" />}
              <div
                className="menu-row"
                onClick={() => onAddNode(item.type, item.label, item.role)}
              >
                <span>{item.label}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}


export default memo(CanvasContextMenu);
