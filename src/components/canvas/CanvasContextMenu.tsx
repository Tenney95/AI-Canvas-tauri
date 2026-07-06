/**
 * CanvasContextMenu 画布右键菜单 — 在画布空白区域右键弹出，支持添加节点（生成/来源）、撤销、重做、粘贴
 * 子菜单位置会自动检测屏幕边界，避免溢出
 */
import { memo, useLayoutEffect, useState } from 'react';
import type { NodeType } from '../../types';
import { calcFixedPosition, calcSubmenuPosition } from '../../utils/popupPosition';

const GEN_NODE_ITEMS: { label: string; type: NodeType }[] = [
  { label: '生成文本', type: 'ai-text' },
  { label: '生成图像', type: 'ai-image' },
  { label: '生成视频', type: 'ai-video' },
  { label: '生成音频', type: 'ai-audio' },
  { label: '生成360全景', type: 'ai-panorama' },
];

const SRC_NODE_ITEMS: { label: string; type: NodeType }[] = [
  { label: '文本', type: 'ai-text' },
  { label: '图像', type: 'ai-image' },
  { label: '视频', type: 'ai-video' },
  { label: '音频', type: 'ai-audio' },
  { label: 'Markdown', type: 'ai-markdown' },
];

/** 菜单项行高估算（含 padding） */
const ROW_HEIGHT = 28;
/** 菜单 padding + border 估算 */
const MENU_PADDING = 10;
/** 根菜单项数（添加节点 + 分割线 + 粘贴 + 撤销 + 重做 + 删除 = 6 个 .menu-row + 1 个 .menu-sep） */
const L1_ITEM_COUNT = 6;
const L1_SEP_COUNT = 2;
/** Level 2 菜单项数（生成节点 + 源节点 = 2） */
const L2_ITEM_COUNT = 2;
/** Level 3 菜单项数（5 个节点类型） */
const L3_ITEM_COUNT = 5;

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
  hoverMenu: 'addNode' | 'genNode' | 'srcNode' | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  submenuRef: React.RefObject<HTMLDivElement | null>;
  onAddNode: (type: NodeType, label: string, role: 'generator' | 'source') => void;
  onUndo: () => void;
  onRedo: () => void;
  onPaste: () => void;
  onDelete: () => void;
  hasSelection: boolean;
  onShowSubmenu: (menu: 'addNode' | 'genNode' | 'srcNode' | null) => void;
  onHideSubmenu: (backTo: 'addNode' | 'genNode' | 'srcNode' | null) => void;
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
  onShowSubmenu,
  onHideSubmenu,
}: CanvasContextMenuProps) {
  // 动态计算子菜单位置，使用 state 触发重渲染。初始值用 CPU 从位置估算，useLayoutEffect 中根据实际 DOM 修正。
  const [l2Pos, setL2Pos] = useState<{ left: number; top: number } | null>(null);
  const [l3Pos, setL3Pos] = useState<{ left: number; top: number } | null>(null);

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

    // Level 2 子菜单位置
    const l2h = estMenuHeight(L2_ITEM_COUNT);
    const l2w = estMenuWidth(L2_ITEM_COUNT);
    const l2 = calcSubmenuPosition(l1Rect, l2w, l2h, 'right');
    setL2Pos({ left: l2.left, top: l2.top });

    // Level 3：如果 L2 翻到了左边，L3 也应该在左边
    if (hoverMenu === 'genNode' || hoverMenu === 'srcNode') {
      const l2El = submenuRef.current;
      if (l2El) {
        const l2Rect = l2El.getBoundingClientRect();
        const l3h = estMenuHeight(L3_ITEM_COUNT);
        const l3w = estMenuWidth(L3_ITEM_COUNT);
        // 如果 L2 在 L1 左边，L3 也应在 L2 左边
        const l2dir = l2.direction === 'left' ? 'left' : 'right';
        const l3 = calcSubmenuPosition(l2Rect, l3w, l3h, l2dir);
        setL3Pos({ left: l3.left, top: l3.top });
      } else {
        // L2 还未挂载，用 L1 位置估算
        const l3h = estMenuHeight(L3_ITEM_COUNT);
        const l3w = estMenuWidth(L3_ITEM_COUNT);
        const l3dir = l2.direction === 'left' ? 'left' : 'right';
        const fakeL2Rect = new DOMRect(l2.left, l2.top, l2w, l2h);
        const l3 = calcSubmenuPosition(fakeL2Rect, l3w, l3h, l3dir);
        setL3Pos({ left: l3.left, top: l3.top });
      }
    }
  }, [visible, position.x, position.y, hoverMenu, menuRef, submenuRef]);

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

      {/* Level 2: 添加节点 submenu */}
      {(hoverMenu === 'addNode' || hoverMenu === 'genNode' || hoverMenu === 'srcNode') && l2Pos && (
        <div
          ref={submenuRef}
          className="canvas-ctx-menu submenu"
          style={{ left: l2Pos.left, top: l2Pos.top }}
          onMouseEnter={() => onShowSubmenu('addNode')}
          onMouseLeave={() => onHideSubmenu(null)}
        >
          <div
            className={`menu-row menu-row-split${hoverMenu === 'genNode' ? ' highlight' : ''}`}
            onMouseEnter={() => onShowSubmenu('genNode')}
          >
            <span className="menu-rowlabel">生成节点</span>
            <span className="menu-arrow menu-arrow-ml8">▶</span>
          </div>
          <div
            className={`menu-row menu-row-split${hoverMenu === 'srcNode' ? ' highlight' : ''}`}
            onMouseEnter={() => onShowSubmenu('srcNode')}
          >
            <span className="menu-rowlabel">源节点</span>
            <span className="menu-arrow menu-arrow-ml8">▶</span>
          </div>
        </div>
      )}

      {/* Level 3a: 生成节点 submenu */}
      {hoverMenu === 'genNode' && l3Pos && (
        <div
          className="canvas-ctx-menu submenu"
          style={{ left: l3Pos.left, top: l3Pos.top }}
          onMouseEnter={() => onShowSubmenu('genNode')}
          onMouseLeave={() => onHideSubmenu('addNode')}
        >
          {GEN_NODE_ITEMS.map((item) => (
            <div
              key={item.type}
              className="menu-row"
              onClick={() => onAddNode(item.type, item.label, 'generator')}
            >
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Level 3b: 源节点 submenu */}
      {hoverMenu === 'srcNode' && l3Pos && (
        <div
          className="canvas-ctx-menu submenu"
          style={{ left: l3Pos.left, top: l3Pos.top }}
          onMouseEnter={() => onShowSubmenu('srcNode')}
          onMouseLeave={() => onHideSubmenu('addNode')}
        >
          {SRC_NODE_ITEMS.map((item) => (
            <div
              key={item.type}
              className="menu-row"
              onClick={() => onAddNode(item.type, item.label, 'source')}
            >
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}


export default memo(CanvasContextMenu);
