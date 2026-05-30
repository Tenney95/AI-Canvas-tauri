/**
 * CanvasContextMenu 画布右键菜单 — 在画布空白区域右键弹出，支持添加节点（生成/来源）、撤销、重做、粘贴
 */
import { memo } from 'react';
import type { NodeType } from '../../types';

const GEN_NODE_ITEMS: { label: string; type: NodeType }[] = [
  { label: '生成文本', type: 'ai-text' },
  { label: '生成图像', type: 'ai-image' },
  { label: '生成视频', type: 'ai-video' },
  { label: '生成音频', type: 'ai-audio' },
];

const SRC_NODE_ITEMS: { label: string; type: NodeType }[] = [
  { label: '文本', type: 'ai-text' },
  { label: '图像', type: 'ai-image' },
  { label: '视频', type: 'ai-video' },
  { label: '音频', type: 'ai-audio' },
];

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
  onShowSubmenu,
  onHideSubmenu,
}: CanvasContextMenuProps) {
  if (!visible) return null;

  return (
    <>
      {/* Level 1: Root menu */}
      <div
        ref={menuRef}
        className="canvas-ctx-menu"
        style={{ left: position.x, top: position.y }}
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
      </div>

      {/* Level 2: 添加节点 submenu */}
      {(hoverMenu === 'addNode' || hoverMenu === 'genNode' || hoverMenu === 'srcNode') && (
        <div
          ref={submenuRef}
          className="canvas-ctx-menu submenu"
          style={{ left: position.x + 180, top: position.y + 4 }}
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
      {hoverMenu === 'genNode' && (
        <div
          className="canvas-ctx-menu submenu"
          style={{ left: position.x + 364, top: position.y + 4 }}
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
      {hoverMenu === 'srcNode' && (
        <div
          className="canvas-ctx-menu submenu"
          style={{ left: position.x + 364, top: position.y + 36 }}
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
