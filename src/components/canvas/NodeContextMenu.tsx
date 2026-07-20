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
  { label: '复制媒体', shortcut: '', action: 'copyMedia' as const, conditional: true, dynamicLabel: true },
  { label: '在 PS 中打开', shortcut: '', action: 'openInPS' as const, conditional: true },
  { label: '在剪映中打开', shortcut: '', action: 'openInJianying' as const, conditional: true },
  { label: '在 PR 中打开', shortcut: '', action: 'openInPremiere' as const, conditional: true },
  { label: '打开文件所在位置', shortcut: '', action: 'showInFolder' as const, conditional: true },
  { label: '另存为...', shortcut: '', action: 'saveAs' as const, conditional: true },
  { label: '删除', shortcut: 'Del', action: 'delete' as const, danger: true },
];

const MENU_W = 176;
const MENU_H = 356; // 视频节点最多 9 items + 1 sep
const TEXT_SELECTION_MENU_EXTRA_H = 78; // 2 text-selection items + separator

interface NodeContextMenuProps {
  visible: boolean;
  position: { x: number; y: number };
  menuRef: React.RefObject<HTMLDivElement | null>;
  onCopy: () => void;
  onCut: () => void;
  hasTextSelection?: boolean;
  onCopyText?: () => void;
  onCutText?: () => void;
  onDuplicate: () => void;
  onUngroup?: () => void;
  onDelete: () => void;
  onShowInFolder?: () => void;
  onSaveAs?: () => void;
  onOpenInPS?: () => void;
  onOpenInJianying?: () => void;
  onOpenInPremiere?: () => void;
  onCopyMedia?: () => void;
  copyMediaLabel?: string;
}
function NodeContextMenu({
  visible,
  position,
  menuRef,
  onCopy,
  onCut,
  hasTextSelection,
  onCopyText,
  onCutText,
  onDuplicate,
  onUngroup,
  onDelete,
  onShowInFolder,
  onSaveAs,
  onOpenInPS,
  onOpenInJianying,
  onOpenInPremiere,
  onCopyMedia,
  copyMediaLabel,
}: NodeContextMenuProps) {
  if (!visible) return null;

  const safePos = calcFixedPosition(
    position.x,
    position.y,
    MENU_W,
    MENU_H + (hasTextSelection ? TEXT_SELECTION_MENU_EXTRA_H : 0),
  );

  const actionMap: Record<string, () => void> = {
    copy: onCopy,
    cut: onCut,
    duplicate: onDuplicate,
    delete: onDelete,
    showInFolder: onShowInFolder || (() => {}),
    saveAs: onSaveAs || (() => {}),
    openInPS: onOpenInPS || (() => {}),
    openInJianying: onOpenInJianying || (() => {}),
    openInPremiere: onOpenInPremiere || (() => {}),
    copyMedia: onCopyMedia || (() => {}),
  };

  const items = MENU_ITEMS.filter((item) => {
    if (item.groupOnly && !onUngroup) return false;
    if (item.conditional && item.action === 'showInFolder' && !onShowInFolder) return false;
    if (item.conditional && item.action === 'saveAs' && !onSaveAs) return false;
    if (item.conditional && item.action === 'openInPS' && !onOpenInPS) return false;
    if (item.conditional && item.action === 'openInJianying' && !onOpenInJianying) return false;
    if (item.conditional && item.action === 'openInPremiere' && !onOpenInPremiere) return false;
    if (item.conditional && item.action === 'copyMedia' && !onCopyMedia) return false;
    return true;
  });

  return (
    <div
      ref={menuRef}
      className="node-ctx-menu canvas-ctx-menu"
      style={{ left: safePos.left, top: safePos.top }}
    >
      {hasTextSelection && (
        <>
          <div className="menu-row menu-row-split" onClick={onCopyText}>
            <span>复制文字</span>
            <span className="menu-kbd">Ctrl C</span>
          </div>
          <div className="menu-row menu-row-split" onClick={onCutText}>
            <span>剪切文字</span>
            <span className="menu-kbd">Ctrl X</span>
          </div>
          <div className="menu-sep" />
        </>
      )}
      {items.map((item) => (
        <div key={item.action}>
          {item.danger && <div className="menu-sep" />}
          <div
            className={`menu-row menu-row-split${item.danger ? ' menu-row-danger' : ''}`}
            onClick={item.action === 'ungroup' ? onUngroup : actionMap[item.action]}
          >
            <span>{item.dynamicLabel && item.action === 'copyMedia' ? (copyMediaLabel || item.label) : item.label}</span>
            <span className="menu-kbd">{item.shortcut}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(NodeContextMenu);
