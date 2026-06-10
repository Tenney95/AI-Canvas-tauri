/**
 * NodeContextMenu 节点右键菜单 — 在节点上右键弹出，支持复制、剪切、创建副本、解除分组、删除操作
 * 自动检测屏幕边界，避免溢出
 */
import { memo } from 'react';
import { calcFixedPosition } from '../../utils/popupPosition';

const MENU_ITEMS = [
  { label: '复制', shortcut: 'Ctrl C', action: 'copy' as const },
  { label: '剪切', shortcut: 'Ctrl X', action: 'cut' as const },
  { label: '创建副本', shortcut: 'Ctrl D', action: 'duplicate' as const },
  { label: '解除分组', shortcut: '', action: 'ungroup' as const, groupOnly: true },
  { label: '打开文件所在位置', shortcut: '', action: 'showInFolder' as const, conditional: true },
  { label: '删除', shortcut: 'Del', action: 'delete' as const, danger: true },
];

const MENU_W = 176;
const MENU_H = 250; // 6 items + 2 seps

interface NodeContextMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  menuRef: React.RefObject<HTMLDivElement | null>;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onUngroup?: () => void;
  onDelete: () => void;
  onShowInFolder?: () => void;
}
function NodeContextMenu({
  visible,
  position,
  menuRef,
  onCopy,
  onCut,
  onDuplicate,
  onUngroup,
  onDelete,
  onShowInFolder,
}: NodeContextMenuProps) {
  if (!visible) return null;

  const safePos = calcFixedPosition(position.x, position.y, MENU_W, MENU_H);

  const actionMap: Record<string, () => void> = {
    copy: onCopy,
    cut: onCut,
    duplicate: onDuplicate,
    delete: onDelete,
    showInFolder: onShowInFolder || (() => {}),
  };

  const items = MENU_ITEMS.filter((item) => {
    if (item.groupOnly && !onUngroup) return false;
    if (item.conditional && item.action === 'showInFolder' && !onShowInFolder) return false;
    return true;
  });

  return (
    <div
      ref={menuRef}
      className="node-ctx-menu canvas-ctx-menu"
      style={{ left: safePos.left, top: safePos.top }}
    >
      {items.map((item) => (
        <div key={item.action}>
          {item.danger && <div className="menu-sep" />}
          <div
            className={`menu-row menu-row-split${item.danger ? ' menu-row-danger' : ''}`}
            onClick={item.action === 'ungroup' ? onUngroup : actionMap[item.action]}
          >
            <span>{item.label}</span>
            <span className="menu-kbd">{item.shortcut}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(NodeContextMenu);
