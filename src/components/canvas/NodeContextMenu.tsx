import { memo } from 'react';

const MENU_ITEMS = [
  { label: '复制', shortcut: 'Ctrl C', action: 'copy' as const },
  { label: '剪切', shortcut: 'Ctrl X', action: 'cut' as const },
  { label: '创建副本', shortcut: 'Ctrl D', action: 'duplicate' as const },
  { label: '删除', shortcut: 'Del', action: 'delete' as const, danger: true },
];

interface NodeContextMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  menuRef: React.RefObject<HTMLDivElement | null>;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function NodeContextMenu({
  visible,
  position,
  menuRef,
  onCopy,
  onCut,
  onDuplicate,
  onDelete,
}: NodeContextMenuProps) {
  if (!visible) return null;

  const actionMap: Record<string, () => void> = {
    copy: onCopy,
    cut: onCut,
    duplicate: onDuplicate,
    delete: onDelete,
  };

  return (
    <div
      ref={menuRef}
      className="v2-node-ctx-menu v2-canvas-ctx-menu"
      style={{ left: position.x, top: position.y }}
    >
      {MENU_ITEMS.map((item) => (
        <div key={item.action}>
          {item.danger && <div className="v2-menu-sep" />}
          <div
            className={`v2-menu-row v2-menu-row-split${item.danger ? ' v2-menu-row-danger' : ''}`}
            onClick={actionMap[item.action]}
          >
            <span>{item.label}</span>
            <span className="v2-menu-kbd">{item.shortcut}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(NodeContextMenu);
