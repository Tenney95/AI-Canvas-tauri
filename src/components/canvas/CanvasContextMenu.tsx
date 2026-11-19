/**
 * CanvasContextMenu 画布右键菜单 — 在画布空白区域右键弹出，支持添加节点（生成/来源）、撤销、重做、粘贴
 * 子菜单位置会自动检测屏幕边界，避免溢出
 */
import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { NodeType } from '../../types';
import type { AvailablePluginNode } from '../../types/plugin';
import type { CanvasContextSubmenu } from '../../hooks/useCanvasContextMenu';
import { calcFixedPosition, calcSubmenuPosition } from '../../utils/popupPosition';
import { useT } from '../../i18n';

interface MergedNodeItem {
  label: string;
  type: NodeType;
  role: 'generator' | 'source';
  shortcut: string;
}

const IS_MAC_OS = typeof navigator !== 'undefined'
  && /Macintosh|Mac OS X/.test(navigator.userAgent);
const MENU_SHORTCUTS = {
  copy: IS_MAC_OS ? '⌘ C' : 'Ctrl C',
  paste: IS_MAC_OS ? '⌘ V' : 'Ctrl V',
  undo: IS_MAC_OS ? '⌘ Z' : 'Ctrl Z',
  redo: IS_MAC_OS ? '⇧⌘ Z' : 'Ctrl Y',
  delete: IS_MAC_OS ? '⌫' : 'Del',
};

function nodeShortcutLabel(item: MergedNodeItem): string {
  if (item.type === 'ai-director') return item.shortcut;
  if (item.role === 'source') return `${IS_MAC_OS ? '⌥' : 'Alt'} ${item.shortcut}`;
  return item.shortcut;
}

const NODE_ITEMS: MergedNodeItem[] = [
  // ── 生成节点 ──
  { label: '生成文本', type: 'ai-text', role: 'generator', shortcut: '1' },
  { label: '生成图像', type: 'ai-image', role: 'generator', shortcut: '2' },
  { label: '生成视频', type: 'ai-video', role: 'generator', shortcut: '3' },
  { label: '生成音频', type: 'ai-audio', role: 'generator', shortcut: '4' },
  { label: '生成360全景', type: 'ai-panorama', role: 'generator', shortcut: '5' },
  { label: '帧动画', type: 'ai-animation', role: 'generator', shortcut: '6' },
  { label: '3D 导演台', type: 'ai-director', role: 'source', shortcut: '7' },
  // ── 源节点 ──
  { label: '文本', type: 'ai-text', role: 'source', shortcut: '1' },
  { label: '图像', type: 'ai-image', role: 'source', shortcut: '2' },
  { label: '视频', type: 'ai-video', role: 'source', shortcut: '3' },
  { label: '音频', type: 'ai-audio', role: 'source', shortcut: '4' },
  { label: 'Markdown', type: 'ai-markdown', role: 'source', shortcut: '5' },
  { label: '分镜表', type: 'ai-shotlist', role: 'source', shortcut: '6' },
];

/** 菜单项行高估算（含 padding） */
const ROW_HEIGHT = 28;
/** 菜单 padding + border 估算 */
const MENU_PADDING = 10;
/** 根菜单以选中态的最大项数估算高度。 */
const L1_ITEM_COUNT = 10;
const L1_SEP_COUNT = 3;
/** 内置子菜单额外包含一行宫格分镜入口。 */
const SUB_ITEM_COUNT = NODE_ITEMS.length + 1;
const SUB_SEP_COUNT = 1;
const GRID_PICKER_ROWS = 8;
const GRID_PICKER_COLS = 12;
const GRID_MAX_DIMENSION = 20;

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
  hoverMenu: CanvasContextSubmenu | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  submenuRef: React.RefObject<HTMLDivElement | null>;
  onAddNode: (type: NodeType, label: string, role: 'generator' | 'source', grid?: { rows: number; cols: number }) => void;
  onAddPluginNode: (pluginNode: AvailablePluginNode) => void;
  pluginNodes: AvailablePluginNode[];
  onUndo: () => void;
  onRedo: () => void;
  onPaste: () => void;
  onCreateFolder: () => void;
  onDelete: () => void;
  onCopyNodes?: () => void;
  onCopyFiles?: () => void;
  hasSelection: boolean;
  onOpenProjectDir: () => void;
  onShowSubmenu: (menu: CanvasContextSubmenu | null) => void;
  onHideSubmenu: (backTo: CanvasContextSubmenu | null) => void;
}

function GridPicker({
  anchorRef,
  onCreate,
  onMouseEnter,
  onMouseLeave,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onCreate: (rows: number, cols: number) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const t = useT();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [rowsInput, setRowsInput] = useState('3');
  const [colsInput, setColsInput] = useState('3');
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null);
  const rows = Number(rowsInput);
  const cols = Number(colsInput);
  const valid = Number.isInteger(rows) && Number.isInteger(cols)
    && rows >= 1 && cols >= 1 && rows <= GRID_MAX_DIMENSION && cols <= GRID_MAX_DIMENSION;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const picker = pickerRef.current;
    if (!anchor || !picker) return;
    const next = calcSubmenuPosition(anchor.getBoundingClientRect(), picker.offsetWidth, picker.offsetHeight);
    const containerRect = picker.closest<HTMLElement>('.app-canvas-viewport')?.getBoundingClientRect();
    setPosition({
      left: next.left - (containerRect?.left ?? 0),
      top: next.top - (containerRect?.top ?? 0),
    });
  }, [anchorRef]);

  return (
    <div
      ref={pickerRef}
      className="canvas-ctx-menu w-[300px] max-h-[calc(100vh-16px)] overflow-y-auto"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="px-2 py-2 text-xs font-medium text-canvas-text-secondary">{t('选择宫格')}</div>
      <div className="grid grid-cols-4 gap-1 px-2">
        {[2, 3, 4, 5].map((side) => (
          <button key={side} type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onCreate(side, side)}>
            {side * side}{t('宫格')}
          </button>
        ))}
      </div>
      <div className="mx-2 my-2 border-t border-canvas-border" />
      <div className="px-2 text-xs text-canvas-text-secondary">
        {hover ? `${hover.rows} 行 × ${hover.cols} 列` : t('自定义行列')}
      </div>
      <div className="grid grid-cols-12 gap-1 p-2" onMouseLeave={() => setHover(null)} role="group" aria-label={t('选择宫格行列')}>
        {Array.from({ length: GRID_PICKER_ROWS * GRID_PICKER_COLS }, (_, index) => {
          const cellRows = Math.floor(index / GRID_PICKER_COLS) + 1;
          const cellCols = index % GRID_PICKER_COLS + 1;
          const active = hover && cellRows <= hover.rows && cellCols <= hover.cols;
          return (
            <button
              key={index}
              type="button"
              className={`h-4 w-4 rounded-[3px] border cursor-pointer ${active ? 'border-brand bg-brand/50' : 'border-canvas-text-muted/50 bg-canvas-surface hover:border-brand'}`}
              aria-label={t('{rows} 行 {cols} 列', { rows: cellRows, cols: cellCols })}
              onMouseEnter={() => setHover({ rows: cellRows, cols: cellCols })}
              onFocus={() => setHover({ rows: cellRows, cols: cellCols })}
              onClick={() => onCreate(cellRows, cellCols)}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 px-2 pb-2">
        <input className="ui-input ui-input--sm w-16" type="number" min={1} max={GRID_MAX_DIMENSION} value={rowsInput}
          onChange={(event) => setRowsInput(event.target.value)} aria-label={t('行数')} />
        <span className="text-canvas-text-muted">×</span>
        <input className="ui-input ui-input--sm w-16" type="number" min={1} max={GRID_MAX_DIMENSION} value={colsInput}
          onChange={(event) => setColsInput(event.target.value)} aria-label={t('列数')} />
        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary ml-auto" disabled={!valid}
          onClick={() => onCreate(rows, cols)}>{t('创建')}</button>
      </div>
    </div>
  );
}

function CanvasContextMenu({
  visible,
  position,
  hoverMenu,
  menuRef,
  submenuRef,
  onAddNode,
  onAddPluginNode,
  pluginNodes,
  onUndo,
  onRedo,
  onPaste,
  onCreateFolder,
  onDelete,
  onCopyNodes,
  onCopyFiles,
  hasSelection,
  onOpenProjectDir,
  onShowSubmenu,
  onHideSubmenu,
}: CanvasContextMenuProps) {
  const t = useT();
  // 估算值仅用于首次布局；挂载后使用真实 DOM 尺寸修正，避免菜单项变化或界面缩放导致底部被裁切。
  const [l1Pos, setL1Pos] = useState<{ left: number; top: number } | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const [gridPickerOpen, setGridPickerOpen] = useState(false);
  const gridRowRef = useRef<HTMLDivElement>(null);
  const pluginRowRef = useRef<HTMLButtonElement>(null);
  const showPluginNodes = hoverMenu === 'addPluginNode';

  const l1Height = estMenuHeight(L1_ITEM_COUNT, L1_SEP_COUNT);
  const l1Width = estMenuWidth(L1_ITEM_COUNT);

  // 计算 Level 1 菜单的安全位置
  const safeL1 = calcFixedPosition(position.x, position.y, l1Width, l1Height);

  // 当 L1 渲染后，先按真实尺寸修正根菜单，再计算子菜单位置。
  useLayoutEffect(() => {
    if (!visible) return;
    const l1El = menuRef.current;
    if (!l1El) return;

    const safeViewportPos = calcFixedPosition(
      position.x,
      position.y,
      l1El.offsetWidth,
      l1El.offsetHeight,
    );
    // contain: paint 会让画布视口成为 fixed 定位容器，样式坐标需换算到该容器内。
    const fixedContainer = l1El.closest<HTMLElement>('.app-canvas-viewport');
    const fixedContainerRect = fixedContainer?.getBoundingClientRect();
    const nextL1 = {
      left: safeViewportPos.left - (fixedContainerRect?.left ?? 0),
      top: safeViewportPos.top - (fixedContainerRect?.top ?? 0),
    };
    setL1Pos((current) => (
      current?.left === nextL1.left && current.top === nextL1.top ? current : nextL1
    ));

    const l1Rect = l1El.getBoundingClientRect();
    const pluginRow = showPluginNodes ? pluginRowRef.current?.getBoundingClientRect() : undefined;
    const anchor = pluginRow
      ? new DOMRect(l1Rect.left, pluginRow.top, l1Rect.width, pluginRow.height)
      : l1Rect;
    const subEl = submenuRef.current;
    const subItemCount = showPluginNodes ? Math.max(1, pluginNodes.length) : SUB_ITEM_COUNT;
    const subSepCount = showPluginNodes ? 0 : SUB_SEP_COUNT;
    const subH = subEl?.offsetHeight ?? estMenuHeight(subItemCount, subSepCount);
    const subW = subEl?.offsetWidth ?? estMenuWidth(subItemCount);
    const sub = calcSubmenuPosition(anchor, subW, subH);
    const nextSubPos = {
      left: sub.left - (fixedContainerRect?.left ?? 0),
      top: sub.top - (fixedContainerRect?.top ?? 0),
    };
    setSubPos((current) => (
      current?.left === nextSubPos.left && current.top === nextSubPos.top
        ? current
        : nextSubPos
    ));
  }, [visible, position.x, position.y, hoverMenu, showPluginNodes, hasSelection, pluginNodes.length, l1Pos, menuRef, submenuRef]);

  if (!visible) return null;

  return (
    <>
      {/* Level 1: Root menu */}
      <div
        ref={menuRef}
        className="canvas-ctx-menu"
        style={{ left: l1Pos?.left ?? safeL1.left, top: l1Pos?.top ?? safeL1.top }}
      >
        <div
          className={`menu-row menu-row-split${hoverMenu === 'addNode' ? ' highlight' : ''}`}
          onMouseEnter={() => { setGridPickerOpen(false); onShowSubmenu('addNode'); }}
          onMouseLeave={() => onHideSubmenu(null)}
          onClick={() => { setGridPickerOpen(false); onShowSubmenu('addNode'); }}
        >
          <span className="menu-rowlabel">{t('添加节点')}</span>
          <span className="menu-arrow menu-arrow-ml8">▶</span>
        </div>
        <button
          ref={pluginRowRef}
          type="button"
          className={`menu-row menu-row-split${showPluginNodes ? ' highlight' : ''}`}
          aria-expanded={showPluginNodes}
          onMouseEnter={() => { setGridPickerOpen(false); onShowSubmenu('addPluginNode'); }}
          onMouseLeave={() => onHideSubmenu(null)}
          onClick={() => { setGridPickerOpen(false); onShowSubmenu('addPluginNode'); }}
        >
          <span className="menu-rowlabel">{t('添加插件节点')}</span>
          <span className="menu-arrow menu-arrow-ml8" aria-hidden="true">▶</span>
        </button>
        <div className="menu-row" onClick={onCreateFolder}>
          <span>{t('创建文件夹')}</span>
        </div>
        <div className="menu-sep" />
        {hasSelection && (
          <div className="menu-row menu-row-split" onClick={onCopyNodes}>
            <span>{t('复制')}</span>
            <span className="menu-kbd">{MENU_SHORTCUTS.copy}</span>
          </div>
        )}
        <div className="menu-row menu-row-split" onClick={onPaste}>
          <span>{t('粘贴')}</span>
          <span className="menu-kbd">{MENU_SHORTCUTS.paste}</span>
        </div>
        {hasSelection && (
          <div className="menu-row menu-row-split" onClick={onCopyFiles}>
            <span>{t('复制文件')}</span>
          </div>
        )}
        <div className="menu-row menu-row-split" onClick={onUndo}>
          <span>{t('撤销')}</span>
          <span className="menu-kbd">{MENU_SHORTCUTS.undo}</span>
        </div>
        <div className="menu-row menu-row-split" onClick={onRedo}>
          <span>{t('重做')}</span>
          <span className="menu-kbd">{MENU_SHORTCUTS.redo}</span>
        </div>
        <div className="menu-sep" />
        <div className="menu-row" onClick={onOpenProjectDir}>
          <span>{t('打开项目文件夹')}</span>
        </div>
        {hasSelection && (
          <>
            <div className="menu-sep" />
            <div className="menu-row menu-row-split menu-row-danger" onClick={onDelete}>
              <span>{t('删除')}</span>
              <span className="menu-kbd">{MENU_SHORTCUTS.delete}</span>
            </div>
          </>
        )}
      </div>

      {hoverMenu && subPos && (
        <div
          ref={submenuRef}
          className="canvas-ctx-menu submenu max-h-[calc(100vh-16px)] overflow-y-auto"
          style={{ left: subPos.left, top: subPos.top }}
          onMouseEnter={() => onShowSubmenu(hoverMenu)}
          onMouseLeave={() => onHideSubmenu(null)}
        >
          {showPluginNodes ? (
            <>
              {pluginNodes.length === 0 && <div className="ui-hint px-2.5 py-2">{t('暂无可添加的插件节点')}</div>}
              {pluginNodes.map((pluginNode) => (
                <button
                  key={`${pluginNode.pluginId}-${pluginNode.node.id}`}
                  type="button"
                  className="menu-row menu-row-split"
                  title={`${pluginNode.node.title} · ${pluginNode.pluginName}`}
                  onClick={() => onAddPluginNode(pluginNode)}
                >
                  <span className="max-w-56 truncate">{pluginNode.node.title}</span>
                  <span className="menu-kbd max-w-40 truncate">{pluginNode.pluginName}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              {NODE_ITEMS.map((item, i) => (
                <div key={`${item.role}-${item.type}`}>
                  {i === 7 && <div className="menu-sep" />}
                  <div
                    className="menu-row menu-row-split"
                    onMouseEnter={() => setGridPickerOpen(false)}
                    onClick={() => onAddNode(item.type, item.label, item.role)}
                  >
                    <span>{t(item.label)}</span>
                    <span className="menu-kbd">{nodeShortcutLabel(item)}</span>
                  </div>
                </div>
              ))}
              <div
                ref={gridRowRef}
                className={`menu-row menu-row-split${gridPickerOpen ? ' highlight' : ''}`}
                onMouseEnter={() => setGridPickerOpen(true)}
                onClick={() => setGridPickerOpen(true)}
              >
                <span>{t('宫格分镜')}</span>
                <span className="menu-arrow">▶</span>
              </div>
            </>
          )}
        </div>
      )}
      {hoverMenu === 'addNode' && gridPickerOpen && (
        <GridPicker
          anchorRef={gridRowRef}
          onCreate={(rows, cols) => onAddNode('ai-storyboard', '宫格分镜', 'source', { rows, cols })}
          onMouseEnter={() => onShowSubmenu('addNode')}
          onMouseLeave={() => { setGridPickerOpen(false); onHideSubmenu(null); }}
        />
      )}
    </>
  );
}


export default memo(CanvasContextMenu);
