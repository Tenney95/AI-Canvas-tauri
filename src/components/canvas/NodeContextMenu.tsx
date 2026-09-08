/**
 * NodeContextMenu 节点右键菜单 — 在节点上右键弹出，支持复制、剪切、创建副本、解除分组、删除操作
 * 自动检测屏幕边界，避免溢出
 */
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { calcFixedPosition, calcSubmenuPosition } from '../../utils/popupPosition';
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

function PluginToolsSubmenu({ tools, onSelect }: {
  tools: AvailableNodePluginTool[];
  onSelect: (pluginId: string, toolId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusOnOpen = useRef(false);
  const id = useId();
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = (focus = false) => {
    cancelClose();
    focusOnOpen.current = focus;
    setOpen(true);
    if (open && focus) submenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  };
  const hideLater = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [open]);
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const submenu = submenuRef.current;
    if (!open || !trigger || !submenu) return;
    const next = calcSubmenuPosition(trigger.getBoundingClientRect(), submenu.offsetWidth, submenu.offsetHeight);
    setPosition((previous) => previous.left === next.left && previous.top === next.top ? previous : next);
    if (focusOnOpen.current) {
      submenu.querySelector<HTMLButtonElement>('button')?.focus();
      focusOnOpen.current = false;
    }
  }, [open, tools]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`menu-row menu-row-split${open ? ' highlight' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onMouseEnter={() => show()}
        onMouseLeave={hideLater}
        onClick={() => show(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            show(true);
          }
        }}
      >
        <span>插件工具</span><span className="menu-arrow" aria-hidden="true">›</span>
      </button>
      {open && createPortal(
        <div
          ref={submenuRef}
          id={id}
          role="menu"
          aria-label="插件工具"
          className="canvas-ctx-menu submenu max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto"
          style={{ left: position.left, top: position.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={hideLater}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const buttons = Array.from(submenuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}
        >
          {tools.map((pluginTool) => (
            <button
              key={`${pluginTool.pluginId}:${pluginTool.tool.id}`}
              type="button"
              role="menuitem"
              className="menu-row menu-row-split"
              title={pluginTool.tool.description}
              onClick={() => {
                setOpen(false);
                onSelect(pluginTool.pluginId, pluginTool.tool.id);
              }}
            >
              <span className="min-w-0 truncate">{pluginTool.tool.title}</span>
              <span className="menu-kbd">{pluginTool.pluginName}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

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
      + (pluginTools.length > 0 && onPluginTool ? 42 : 0),
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
          <PluginToolsSubmenu
            key={`${position.x}:${position.y}`}
            tools={pluginTools}
            onSelect={onPluginTool}
          />
        </>
      )}
      {items.filter((item) => item.danger).map(renderItem)}
    </div>
  );
}

export default memo(NodeContextMenu);
