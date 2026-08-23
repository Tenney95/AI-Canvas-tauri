/**
 * NodeContextMenu 节点右键菜单 — 在节点上右键弹出，支持复制、剪切、创建副本、解除分组、删除操作
 * 自动检测屏幕边界，避免溢出
 */
import { memo } from 'react';
import { calcFixedPosition } from '../../utils/popupPosition';
import { useT } from '../../i18n';
import type { AvailableNodePluginTool } from '../../types/plugin';

const MENU_ITEMS = [
  { label: '复制', shortcut: 'Ctrl C', action: 'copy' as const },
  { label: '剪切', shortcut: 'Ctrl X', action: 'cut' as const },
  { label: '创建副本', shortcut: 'Ctrl D', action: 'duplicate' as const },
  { label: '锁定', shortcut: '', action: 'toggleLock' as const, dynamicLockLabel: true },
  { label: '转换图片', shortcut: '', action: 'convertImage' as const, conditional: true, dynamicLabel: true },
  { label: '解除分组', shortcut: '', action: 'ungroup' as const, groupOnly: true },
  { label: '打开文件夹', shortcut: '', action: 'openGroupFolder' as const, conditional: true },
  { label: '添加到角色库…', shortcut: '', action: 'addToCharacter' as const, conditional: true },
  { label: '复制媒体', shortcut: '', action: 'copyMedia' as const, conditional: true, dynamicLabel: true },
  { label: '在 PS 中打开', shortcut: '', action: 'openInPS' as const, conditional: true },
  { label: '编辑视频', shortcut: '', action: 'editVideo' as const, conditional: true, dynamicLabel: true },
  { label: '在剪映中打开', shortcut: '', action: 'openInJianying' as const, conditional: true },
  { label: '在 PR 中打开', shortcut: '', action: 'openInPremiere' as const, conditional: true },
  { label: '打开文件所在位置', shortcut: '', action: 'showInFolder' as const, conditional: true },
  { label: '另存为...', shortcut: '', action: 'saveAs' as const, conditional: true },
  { label: '删除', shortcut: 'Del', action: 'delete' as const, danger: true },
];

const MENU_W = 176;
const MENU_H = 494; // 视频节点最多 13 items + 1 sep
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
  onToggleLock: () => void;
  isLocked: boolean;
  onConvertImage?: () => void;
  imageConversionLabel?: string;
  onAddToCharacter?: () => void;
  onUngroup?: () => void;
  onOpenGroupFolder?: () => void;
  onDelete: () => void;
  onShowInFolder?: () => void;
  onSaveAs?: () => void;
  onOpenInPS?: () => void;
  onEditVideo?: () => void;
  editVideoLabel?: string;
  onOpenInJianying?: () => void;
  onOpenInPremiere?: () => void;
  onCopyMedia?: () => void;
  copyMediaLabel?: string;
  pluginTools?: AvailableNodePluginTool[];
  onPluginTool?: (pluginId: string, toolId: string) => void;
}
export function NodeContextMenu({
  visible,
  position,
  menuRef,
  onCopy,
  onCut,
  hasTextSelection,
  onCopyText,
  onCutText,
  onDuplicate,
  onToggleLock,
  isLocked,
  onConvertImage,
  imageConversionLabel,
  onAddToCharacter,
  onUngroup,
  onOpenGroupFolder,
  onDelete,
  onShowInFolder,
  onSaveAs,
  onOpenInPS,
  onEditVideo,
  editVideoLabel,
  onOpenInJianying,
  onOpenInPremiere,
  onCopyMedia,
  copyMediaLabel,
  pluginTools = [],
  onPluginTool,
}: NodeContextMenuProps) {
  const t = useT();
  if (!visible) return null;

  const safePos = calcFixedPosition(
    position.x,
    position.y,
    MENU_W,
    MENU_H
      + (hasTextSelection ? TEXT_SELECTION_MENU_EXTRA_H : 0)
      + (pluginTools.length > 0 ? 28 + pluginTools.length * 32 : 0),
  );

  const actionMap: Record<string, () => void> = {
    copy: onCopy,
    cut: onCut,
    duplicate: onDuplicate,
    toggleLock: onToggleLock,
    convertImage: onConvertImage || (() => {}),
    addToCharacter: onAddToCharacter || (() => {}),
    delete: onDelete,
    showInFolder: onShowInFolder || (() => {}),
    openGroupFolder: onOpenGroupFolder || (() => {}),
    saveAs: onSaveAs || (() => {}),
    openInPS: onOpenInPS || (() => {}),
    editVideo: onEditVideo || (() => {}),
    openInJianying: onOpenInJianying || (() => {}),
    openInPremiere: onOpenInPremiere || (() => {}),
    copyMedia: onCopyMedia || (() => {}),
  };

  const items = MENU_ITEMS.filter((item) => {
    if (item.groupOnly && !onUngroup) return false;
    if (item.conditional && item.action === 'showInFolder' && !onShowInFolder) return false;
    if (item.conditional && item.action === 'openGroupFolder' && !onOpenGroupFolder) return false;
    if (item.conditional && item.action === 'saveAs' && !onSaveAs) return false;
    if (item.conditional && item.action === 'openInPS' && !onOpenInPS) return false;
    if (item.conditional && item.action === 'editVideo' && !onEditVideo) return false;
    if (item.conditional && item.action === 'openInJianying' && !onOpenInJianying) return false;
    if (item.conditional && item.action === 'openInPremiere' && !onOpenInPremiere) return false;
    if (item.conditional && item.action === 'copyMedia' && !onCopyMedia) return false;
    if (item.conditional && item.action === 'addToCharacter' && !onAddToCharacter) return false;
    if (item.conditional && item.action === 'convertImage' && !onConvertImage) return false;
    return true;
  });
  const renderItem = (item: (typeof MENU_ITEMS)[number]) => (
    <div key={item.action}>
      {item.danger && <div className="menu-sep" />}
      <div
        className={`menu-row menu-row-split${item.danger ? ' menu-row-danger' : ''}`}
        onClick={item.action === 'ungroup' ? onUngroup : actionMap[item.action]}
      >
        <span>
          {item.dynamicLockLabel && item.action === 'toggleLock'
            ? (isLocked ? t('解锁') : t('锁定'))
            : item.dynamicLabel && item.action === 'copyMedia'
              ? (copyMediaLabel || t(item.label))
              : item.dynamicLabel && item.action === 'convertImage'
                ? (imageConversionLabel || t(item.label))
                : item.dynamicLabel && item.action === 'editVideo'
                  ? (editVideoLabel || t(item.label))
                  : t(item.label)}
        </span>
        <span className="menu-kbd">{item.shortcut}</span>
      </div>
    </div>
  );

  return (
    <div
      ref={menuRef}
      className="node-ctx-menu canvas-ctx-menu"
      style={{ left: safePos.left, top: safePos.top }}
    >
      {hasTextSelection && (
        <>
          <div className="menu-row menu-row-split" onClick={onCopyText}>
            <span>{t('复制文字')}</span>
            <span className="menu-kbd">Ctrl C</span>
          </div>
          <div className="menu-row menu-row-split" onClick={onCutText}>
            <span>{t('剪切文字')}</span>
            <span className="menu-kbd">Ctrl X</span>
          </div>
          <div className="menu-sep" />
        </>
      )}
      {items.filter((item) => !item.danger).map(renderItem)}
      {pluginTools.length > 0 && onPluginTool && (
        <>
          <div className="menu-sep" />
          <div className="px-3 py-1 text-[10px] text-canvas-text-muted">插件工具</div>
          {pluginTools.map((pluginTool) => (
            <div
              key={`${pluginTool.pluginId}:${pluginTool.tool.id}`}
              className="menu-row menu-row-split"
              title={pluginTool.tool.description}
              onClick={() => onPluginTool(pluginTool.pluginId, pluginTool.tool.id)}
            >
              <span>{pluginTool.tool.title}</span>
              <span className="menu-kbd">{pluginTool.pluginName}</span>
            </div>
          ))}
        </>
      )}
      {items.filter((item) => item.danger).map(renderItem)}
    </div>
  );
}

export default memo(NodeContextMenu);
