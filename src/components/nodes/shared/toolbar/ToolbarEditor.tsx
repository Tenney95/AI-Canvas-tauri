/**
 * ToolbarEditor — Toolbar 自定义编辑态面板
 *
 * 拖拽实现：Pointer Events 手动拖拽（不用 HTML5 DnD，避免 React Flow nodrag 冲突）
 */
import { memo, useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { Icon } from '@iconify/react';
import { useReactFlow } from '@xyflow/react';
import type { ToolbarButtonDef, NodeType } from '../../../../types';
import type { UseToolbarEditReturn } from '../../../../hooks/useToolbarEdit';
import { getSlashCommands } from '../slashCommands';
import { useAppStore } from '../../../../store/useAppStore';

interface ToolbarEditorProps {
  edit: UseToolbarEditReturn;
  presetItems?: { id: string; title: string; icon: string; description: string }[];
  userPresetItems?: { id: string; name: string; icon?: string; description?: string }[];
  nodeType: string;
}

// ── 拖拽状态（ref，不触发重渲染）──
interface DragState {
  zoneId: string;
  index: number;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
  frameId: number | null;
  sourceEl: HTMLElement;
  captureEl: HTMLElement;
}

interface DragTarget {
  zoneId: string;
  index: number;
}

interface ZoneDragState {
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
  frameId: number | null;
  sourceEl: HTMLElement;
  captureEl: HTMLElement;
}

const DRAG_THRESHOLD_PX = 5;
const VIEWPORT_TRANSITION_DURATION_MS = 420;
const EDITOR_TARGET_ZOOM = 1.2;
const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;

// ── 小型图标渲染 ──
function MiniIcon({ icon }: { icon: string }) {
  if (!icon) return null;
  if (icon.includes(':')) {
    return <Icon icon={icon} width={14} height={14} />;
  }
  return <span style={{ fontSize: 12 }}>{icon}</span>;
}

// ── 按钮库条目 ──
function BankItem({ icon, label, isPreset, onClick }: {
  icon: string; label: string; isPreset?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`toolbar-edit-bank-item nodrag${isPreset ? ' is-preset' : ''}`}
      onClick={onClick}
      data-tooltip={label}
    >
      <span className="toolbar-edit-bank-icon"><MiniIcon icon={icon} /></span>
      <span className="toolbar-edit-bank-label">{label}</span>
    </button>
  );
}

// ── Zone 名称编辑 ──
function ZoneNameEditor({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  if (!editing) {
    return (
      <span className="toolbar-edit-zone-name" onClick={(e) => { e.stopPropagation(); setEditing(true); }} data-tooltip="点击编辑分区名">
        {name}
        <Icon icon="mdi:pencil" width={10} height={10} style={{ marginLeft: 4, opacity: 0.5 }} />
      </span>
    );
  }
  return (
    <input
      ref={inputRef}
      className="toolbar-edit-zone-name-input nodrag"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => { onRename(val || name); setEditing(false); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { onRename(val || name); setEditing(false); }
        if (e.key === 'Escape') { setVal(name); setEditing(false); }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── 主组件 ──
function ToolbarEditorInner({ edit, presetItems = [], userPresetItems = [], nodeType }: ToolbarEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const zoneGhostElRef = useRef<HTMLDivElement | null>(null);
  const { getViewport, screenToFlowPosition, setCenter, setViewport } = useReactFlow();
  const originalViewportRef = useRef<ReturnType<typeof getViewport> | null>(null);
  const unmountRestoreFrameRef = useRef<number | null>(null);

  // 只在落点变化时更新 React 状态；高频指针坐标保存在 dragRef 中
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);

  // ── 分区拖拽排序 ──
  const [zoneDragFrom, setZoneDragFrom] = useState<number | null>(null);
  const [zoneDragOver, setZoneDragOver] = useState<number | null>(null);
  const zoneDragRef = useRef<ZoneDragState | null>(null);

  const zones = edit.layout.zones;
  const moveButtonAcross = edit.moveButtonAcross;
  const setToolbarLayout = edit.setToolbarLayout;
  const exitEdit = edit.exitEdit;

  const restoreOriginalViewport = useCallback(() => {
    const originalViewport = originalViewportRef.current;
    if (!originalViewport) return;
    originalViewportRef.current = null;
    void setViewport(originalViewport, {
      duration: VIEWPORT_TRANSITION_DURATION_MS,
      ease: easeOutCubic,
    });
  }, [setViewport]);

  const handleExitEdit = useCallback(() => {
    restoreOriginalViewport();
    exitEdit();
  }, [exitEdit, restoreOriginalViewport]);

  // 节点隐藏或删除导致编辑器直接卸载时也恢复；下一次 effect setup 会取消 Strict Mode 的模拟卸载。
  useEffect(() => {
    if (unmountRestoreFrameRef.current !== null) {
      cancelAnimationFrame(unmountRestoreFrameRef.current);
      unmountRestoreFrameRef.current = null;
    }

    return () => {
      if (!originalViewportRef.current) return;
      unmountRestoreFrameRef.current = requestAnimationFrame(() => {
        unmountRestoreFrameRef.current = null;
        restoreOriginalViewport();
      });
    };
  }, [restoreOriginalViewport]);

  // 编辑框完成首次布局后，将其平滑移动到画布可视区域中央并缩放至 120%。
  useEffect(() => {
    if (!edit.isEditing) return;
    originalViewportRef.current ??= getViewport();

    const frameId = requestAnimationFrame(() => {
      const editorEl = containerRef.current;
      if (!editorEl) return;

      const editorRect = editorEl.getBoundingClientRect();
      const editorCenterX = editorRect.left + editorRect.width / 2;
      const editorCenterY = editorRect.top + editorRect.height / 2;
      const editorFlowCenter = screenToFlowPosition({ x: editorCenterX, y: editorCenterY });

      void setCenter(
        editorFlowCenter.x,
        editorFlowCenter.y,
        {
          zoom: EDITOR_TARGET_ZOOM,
          duration: VIEWPORT_TRANSITION_DURATION_MS,
          ease: easeOutCubic,
        },
      );
    });

    return () => cancelAnimationFrame(frameId);
  }, [edit.isEditing, getViewport, screenToFlowPosition, setCenter]);

  const calcZoneTarget = useCallback((clientY: number): number | null => {
    const zonesEl = containerRef.current?.querySelector('.toolbar-edit-zones') as HTMLElement | null | undefined;
    const zoneEls: HTMLElement[] = zonesEl
      ? Array.from(zonesEl.querySelectorAll('.toolbar-edit-zone'))
      : [];
    if (!zonesEl || zoneEls.length === 0) return null;

    const listRect = zonesEl.getBoundingClientRect();
    if (clientY < listRect.top - 24 || clientY > listRect.bottom + 24) return null;

    for (let index = 0; index < zoneEls.length; index++) {
      const rect = zoneEls[index].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return zoneEls.length;
  }, []);

  const updateZoneDragOver = useCallback((index: number | null) => {
    setZoneDragOver((current) => (current === index ? current : index));
  }, []);

  const positionZoneGhost = useCallback((clientX: number, clientY: number, drag: ZoneDragState) => {
    const ghost = zoneGhostElRef.current;
    if (!ghost) return;
    ghost.style.setProperty('--toolbar-zone-drag-x', `${clientX - drag.offsetX}px`);
    ghost.style.setProperty('--toolbar-zone-drag-y', `${clientY - drag.offsetY}px`);
  }, []);

  const startZoneDragVisuals = useCallback((drag: ZoneDragState, clientX: number, clientY: number) => {
    drag.active = true;
    setZoneDragFrom(drag.fromIndex);
    containerRef.current?.classList.add('is-zone-dragging');
    document.body.classList.add('toolbar-edit-zone-dragging');

    const ghost = drag.sourceEl.cloneNode(true) as HTMLDivElement;
    ghost.classList.remove('is-zone-drag-from', 'is-zone-drag-over', 'is-zone-drag-over-end');
    ghost.classList.add('toolbar-edit-zone-drag-ghost');
    ghost.removeAttribute('data-zone-id');
    ghost.querySelectorAll('[data-tooltip]').forEach((element) => element.removeAttribute('data-tooltip'));
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${drag.sourceEl.getBoundingClientRect().width}px`;
    document.body.appendChild(ghost);
    zoneGhostElRef.current = ghost;
    positionZoneGhost(clientX, clientY, drag);
  }, [positionZoneGhost]);

  const resetZoneDrag = useCallback(() => {
    const drag = zoneDragRef.current;
    if (!drag) return;

    zoneDragRef.current = null;
    if (drag.frameId !== null) cancelAnimationFrame(drag.frameId);
    containerRef.current?.classList.remove('is-zone-dragging');
    document.body.classList.remove('toolbar-edit-zone-dragging');
    zoneGhostElRef.current?.remove();
    zoneGhostElRef.current = null;
    setZoneDragFrom(null);
    updateZoneDragOver(null);

    if (drag.captureEl.hasPointerCapture(drag.pointerId)) {
      drag.captureEl.releasePointerCapture(drag.pointerId);
    }
  }, [updateZoneDragOver]);

  const scheduleZoneDragFrame = useCallback((clientX: number, clientY: number) => {
    const drag = zoneDragRef.current;
    if (!drag) return;
    drag.lastX = clientX;
    drag.lastY = clientY;
    if (drag.frameId !== null) return;

    drag.frameId = requestAnimationFrame(() => {
      const current = zoneDragRef.current;
      if (!current?.active) return;
      current.frameId = null;
      positionZoneGhost(current.lastX, current.lastY, current);
      updateZoneDragOver(calcZoneTarget(current.lastY));
    });
  }, [calcZoneTarget, positionZoneGhost, updateZoneDragOver]);

  const handleZoneDragStart = useCallback((e: React.PointerEvent, zoneIndex: number) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sourceEl = el.closest<HTMLElement>('.toolbar-edit-zone');
    if (!sourceEl) {
      el.releasePointerCapture(e.pointerId);
      return;
    }
    const rect = sourceEl.getBoundingClientRect();
    zoneDragRef.current = {
      fromIndex: zoneIndex,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      active: false,
      frameId: null,
      sourceEl,
      captureEl: el,
    };
  }, []);

  const handleZoneDragMove = useCallback((e: React.PointerEvent) => {
    const drag = zoneDragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();

    if (!drag.active) {
      const deltaX = e.clientX - drag.startX;
      const deltaY = e.clientY - drag.startY;
      if (deltaX * deltaX + deltaY * deltaY < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      startZoneDragVisuals(drag, e.clientX, e.clientY);
    }
    scheduleZoneDragFrame(e.clientX, e.clientY);
  }, [scheduleZoneDragFrame, startZoneDragVisuals]);

  const handleZoneDragEnd = useCallback((e: React.PointerEvent) => {
    const drag = zoneDragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;

    const toIndex = drag.active ? calcZoneTarget(e.clientY) : null;
    resetZoneDrag();

    if (toIndex !== null && toIndex !== drag.fromIndex && toIndex !== drag.fromIndex + 1) {
      const newZones = [...zones];
      const [moved] = newZones.splice(drag.fromIndex, 1);
      const insertAt = toIndex > drag.fromIndex ? toIndex - 1 : toIndex;
      newZones.splice(insertAt, 0, moved);
      const next = { ...edit.layout, zones: newZones };
      setToolbarLayout(next);
    }
  }, [calcZoneTarget, edit.layout, resetZoneDrag, setToolbarLayout, zones]);

  const handleZoneDragCancel = useCallback((e: React.PointerEvent) => {
    if (zoneDragRef.current?.pointerId === e.pointerId) resetZoneDrag();
  }, [resetZoneDrag]);

  // ── 快捷指令数据 ──
  const userPresets = useAppStore((s) => s.userPresets);
  const allSlashCommands = useMemo(() => {
    const cmds = getSlashCommands(nodeType as NodeType);
    const flat: { id: string; title: string; icon: string; description: string }[] = [];
    const walk = (items: typeof cmds) => {
      for (const item of items) {
        if (item.promptTemplate) {
          flat.push({ id: item.id, title: item.title, icon: item.icon, description: item.description });
        }
        if (item.children) walk(item.children);
      }
    };
    walk(cmds);
    return flat;
  }, [nodeType]);

  const matchingUserPresets = useMemo(
    () => userPresets.filter((p) => p.nodeType === nodeType),
    [userPresets, nodeType],
  );

  // ── 根据鼠标位置计算目标 zone + index ──
  const calcTarget = useCallback((clientX: number, clientY: number): { zoneId: string; index: number } | null => {
    if (!containerRef.current) return null;
    const zoneEls = Array.from(
      containerRef.current.querySelectorAll('.toolbar-edit-zone'),
    ) as HTMLElement[];
    for (const zoneEl of zoneEls) {
      const zoneRect = zoneEl.getBoundingClientRect();
      if (clientY >= zoneRect.top && clientY <= zoneRect.bottom
        && clientX >= zoneRect.left && clientX <= zoneRect.right) {
        const zoneId = zoneEl.dataset.zoneId;
        if (!zoneId) return null;
        const body = zoneEl.querySelector('.toolbar-edit-zone-body') as HTMLElement | null;
        const btnEls: HTMLElement[] = body
          ? Array.from(body.querySelectorAll('.toolbar-edit-btn'))
          : [];
        if (btnEls.length === 0) return { zoneId, index: 0 };

        // flex-wrap 后不能只比较 X：先选离指针最近的一行，再计算该行内的插入边界
        const rows: { top: number; bottom: number; items: { index: number; rect: DOMRect }[] }[] = [];
        btnEls.forEach((button, index) => {
          const rect = button.getBoundingClientRect();
          const currentRow = rows.at(-1);
          if (!currentRow || rect.top > currentRow.bottom - 2) {
            rows.push({ top: rect.top, bottom: rect.bottom, items: [{ index, rect }] });
            return;
          }
          currentRow.bottom = Math.max(currentRow.bottom, rect.bottom);
          currentRow.items.push({ index, rect });
        });

        let nearestRow = rows[0];
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const row of rows) {
          const distance = clientY < row.top
            ? row.top - clientY
            : clientY > row.bottom
              ? clientY - row.bottom
              : 0;
          if (distance < nearestDistance) {
            nearestRow = row;
            nearestDistance = distance;
          }
        }

        for (const item of nearestRow.items) {
          if (clientX < item.rect.left + item.rect.width / 2) {
            return { zoneId, index: item.index };
          }
        }
        return { zoneId, index: nearestRow.items.at(-1)!.index + 1 };
      }
    }
    return null;
  }, []);

  const updateDragTarget = useCallback((target: DragTarget | null) => {
    setDragTarget((current) => {
      if (current?.zoneId === target?.zoneId && current?.index === target?.index) return current;
      return target;
    });
  }, []);

  const positionGhost = useCallback((clientX: number, clientY: number, drag: DragState) => {
    const ghost = ghostElRef.current;
    if (!ghost) return;
    ghost.style.setProperty('--toolbar-drag-x', `${clientX - drag.offsetX}px`);
    ghost.style.setProperty('--toolbar-drag-y', `${clientY - drag.offsetY}px`);
  }, []);

  const startDragVisuals = useCallback((drag: DragState, clientX: number, clientY: number) => {
    drag.active = true;
    drag.sourceEl.classList.add('is-dragging');
    containerRef.current?.classList.add('is-dragging');
    document.body.classList.add('toolbar-edit-dragging');

    const ghost = drag.sourceEl.cloneNode(true) as HTMLDivElement;
    ghost.classList.remove('is-dragging');
    ghost.classList.add('toolbar-edit-drag-ghost');
    ghost.removeAttribute('data-tooltip');
    ghost.querySelectorAll('[data-tooltip]').forEach((element) => element.removeAttribute('data-tooltip'));
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${drag.sourceEl.getBoundingClientRect().width}px`;
    document.body.appendChild(ghost);
    ghostElRef.current = ghost;
    positionGhost(clientX, clientY, drag);
  }, [positionGhost]);

  const resetDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;

    dragRef.current = null;
    if (drag.frameId !== null) cancelAnimationFrame(drag.frameId);
    drag.sourceEl.classList.remove('is-dragging');
    containerRef.current?.classList.remove('is-dragging');
    document.body.classList.remove('toolbar-edit-dragging');
    ghostElRef.current?.remove();
    ghostElRef.current = null;
    updateDragTarget(null);

    if (drag.captureEl.hasPointerCapture(drag.pointerId)) {
      drag.captureEl.releasePointerCapture(drag.pointerId);
    }
  }, [updateDragTarget]);

  const scheduleDragFrame = useCallback((clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.lastX = clientX;
    drag.lastY = clientY;
    if (drag.frameId !== null) return;

    drag.frameId = requestAnimationFrame(() => {
      const current = dragRef.current;
      if (!current?.active) return;
      current.frameId = null;
      positionGhost(current.lastX, current.lastY, current);
      updateDragTarget(calcTarget(current.lastX, current.lastY));
    });
  }, [calcTarget, positionGhost, updateDragTarget]);

  // ── 拖拽开始 ──
  const handlePointerDown = useCallback((e: React.PointerEvent, zoneId: string, index: number) => {
    // 只响应主指针的鼠标左键，并保留移除按钮的点击行为
    if (!e.isPrimary || e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const rect = el.getBoundingClientRect();
    dragRef.current = {
      zoneId,
      index,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      active: false,
      frameId: null,
      sourceEl: el,
      captureEl: el,
    };
  }, []);

  // ── 拖拽移动 ──
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();

    if (!drag.active) {
      const deltaX = e.clientX - drag.startX;
      const deltaY = e.clientY - drag.startY;
      if (deltaX * deltaX + deltaY * deltaY < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      startDragVisuals(drag, e.clientX, e.clientY);
    }
    scheduleDragFrame(e.clientX, e.clientY);
  }, [scheduleDragFrame, startDragVisuals]);

  // ── 拖拽结束 ──
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;

    if (drag.active) {
      const target = calcTarget(e.clientX, e.clientY);
      if (target) {
        // 同分区先移除源按钮后，右侧落点需回退一位；相邻边界视为原位不动
        const targetIndex = target.zoneId === drag.zoneId && target.index > drag.index
          ? target.index - 1
          : target.index;
        if (target.zoneId !== drag.zoneId || targetIndex !== drag.index) {
          moveButtonAcross(drag.zoneId, drag.index, target.zoneId, targetIndex);
        }
      }
    }
    resetDrag();
  }, [calcTarget, moveButtonAcross, resetDrag]);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) resetDrag();
  }, [resetDrag]);

  const handleEditorPointerMove = useCallback((e: React.PointerEvent) => {
    if (zoneDragRef.current) handleZoneDragMove(e);
    else handlePointerMove(e);
  }, [handlePointerMove, handleZoneDragMove]);

  const handleEditorPointerUp = useCallback((e: React.PointerEvent) => {
    if (zoneDragRef.current) handleZoneDragEnd(e);
    else handlePointerUp(e);
  }, [handlePointerUp, handleZoneDragEnd]);

  const handleEditorPointerCancel = useCallback((e: React.PointerEvent) => {
    if (zoneDragRef.current) handleZoneDragCancel(e);
    else handlePointerCancel(e);
  }, [handlePointerCancel, handleZoneDragCancel]);

  // 组件卸载时兜底清理克隆浮层和全局拖拽样式
  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.frameId !== null && drag?.frameId !== undefined) cancelAnimationFrame(drag.frameId);
    drag?.sourceEl.classList.remove('is-dragging');
    const zoneDrag = zoneDragRef.current;
    if (zoneDrag?.frameId !== null && zoneDrag?.frameId !== undefined) cancelAnimationFrame(zoneDrag.frameId);
    document.body.classList.remove('toolbar-edit-dragging');
    document.body.classList.remove('toolbar-edit-zone-dragging');
    ghostElRef.current?.remove();
    zoneGhostElRef.current?.remove();
    ghostElRef.current = null;
    zoneGhostElRef.current = null;
    dragRef.current = null;
    zoneDragRef.current = null;
  }, []);

  // ── 点击外部退出编辑态 ──
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleExitEdit();
      }
    };
    if (edit.isEditing) {
      document.addEventListener('mousedown', onDown, true);
      return () => document.removeEventListener('mousedown', onDown, true);
    }
  }, [edit.isEditing, handleExitEdit]);

  // ── 添加到第一个 Zone ──
  const addToZone = useCallback((buttonKey: string) => {
    const targetZone = zones[0]?.id;
    if (targetZone) edit.addButton(targetZone, buttonKey);
  }, [edit, zones]);

  if (!edit.isEditing) return null;

  const bankButtons = edit.removedButtons;

  return (
    <div
      className={`toolbar-editor nodrag toolbar-editor--${nodeType}`}
      ref={containerRef}
      onPointerMove={handleEditorPointerMove}
      onPointerUp={handleEditorPointerUp}
      onPointerCancel={handleEditorPointerCancel}
      onLostPointerCapture={handleEditorPointerCancel}
    >
      {/* ── 按钮库面板 ── */}
      <div className="toolbar-edit-bank nodrag">
        <div className="toolbar-edit-bank-header">
          <span>按钮库</span>
          <span className="toolbar-edit-bank-hint">点击添加按钮到下方 Toolbar</span>
        </div>
        <div className="toolbar-edit-bank-list nodrag">
          {bankButtons.map((def) => (
            <BankItem key={def.key} icon={def.icon} label={def.label} onClick={() => addToZone(def.key)} />
          ))}
          {presetItems.map((p) => {
            if (edit.activeButtonKeys.has(p.id)) return null;
            return (
              <BankItem key={`preset-${p.id}`} icon={p.icon} label={p.title} isPreset onClick={() => addToZone(p.id)} />
            );
          })}
          {userPresetItems.map((p) => {
            if (edit.activeButtonKeys.has(p.id)) return null;
            return (
              <BankItem key={`upreset-${p.id}`} icon={p.icon || 'mdi:star'} label={p.name} isPreset onClick={() => addToZone(p.id)} />
            );
          })}
        </div>
        <div className="toolbar-edit-bank-actions">
          <button type="button" className="toolbar-edit-action-btn nodrag" onClick={edit.resetLayout} data-tooltip="恢复为默认按钮布局">
            <Icon icon="mdi:restore" width={14} height={14} />
            <span>恢复默认</span>
          </button>
          <button type="button" className="toolbar-edit-action-btn toolbar-edit-action-btn--done nodrag" onClick={handleExitEdit}>
            <Icon icon="mdi:check" width={14} height={14} />
            <span>完成</span>
          </button>
        </div>
      </div>

      {/* ── Zone 编辑区 + 快捷指令面板（左右分栏）── */}
      <div className="toolbar-edit-main nodrag">
        {/* 左侧：Zone 列表 */}
        <div className="toolbar-edit-zones nodrag">
          {zones.map((zone, zoneIndex) => (
            <div
              key={zone.id}
              className={`toolbar-edit-zone nodrag${dragTarget?.zoneId === zone.id ? ' drag-over' : ''}${zoneDragFrom === zoneIndex ? ' is-zone-drag-from' : ''}${zoneDragOver === zoneIndex ? ' is-zone-drag-over' : ''}${zoneDragOver === zones.length && zoneIndex === zones.length - 1 ? ' is-zone-drag-over-end' : ''}`}
              data-zone-id={zone.id}
            >
            <div className="toolbar-edit-zone-header">
              <span
                className="toolbar-edit-btn-grip nodrag toolbar-edit-zone-grip"
                onPointerDown={(e) => handleZoneDragStart(e, zoneIndex)}
                data-tooltip="拖拽调整分区顺序"
              >
                <Icon icon="mdi:drag-vertical" width={12} height={12} />
              </span>
              <ZoneNameEditor name={zone.name} onRename={(n) => edit.renameZone(zone.id, n)} />
              {zone.buttonKeys.length === 0 && zones.length > 1 && (
                <button type="button" className="toolbar-edit-zone-del nodrag" onClick={() => edit.removeZone(zone.id)} data-tooltip="删除此分区">
                  <Icon icon="mdi:close" width={12} height={12} />
                </button>
              )}
            </div>
            <div className="toolbar-edit-zone-body nodrag">
              {zone.buttonKeys.map((key, idx) => {
                const isInsertBefore = dragTarget?.zoneId === zone.id && dragTarget?.index === idx;
                const def = edit.registry.find((d) => d.key === key);
                const resolvedDef: ToolbarButtonDef = def ?? (() => {
                  const p = allSlashCommands.find((pi) => pi.id === key);
                  const u = matchingUserPresets.find((ui) => ui.id === key);
                  return { key, label: p?.title || u?.name || key, icon: p?.icon || u?.icon || 'mdi:star', defaultZone: zone.name };
                })();

                return (
                  <span key={key} style={{ display: 'contents' }}>
                    {isInsertBefore && <div className="toolbar-edit-insert-indicator" />}
                    <div
                      className="toolbar-edit-btn nodrag"
                      data-tooltip={`${resolvedDef.label} · 拖拽排序 / 点 × 移除`}
                      onPointerDown={(e) => handlePointerDown(e, zone.id, idx)}
                    >
                      <span className="toolbar-edit-btn-grip nodrag">
                        <Icon icon="mdi:drag-vertical" width={12} height={12} />
                      </span>
                      <span className="toolbar-edit-btn-icon"><MiniIcon icon={resolvedDef.icon} /></span>
                      <span className="toolbar-edit-btn-label">{resolvedDef.label}</span>
                      <button
                        type="button"
                        className="toolbar-edit-btn-remove nodrag"
                        onClick={(e) => { e.stopPropagation(); edit.removeButton(zone.id, key); }}
                        data-tooltip="移除此按钮"
                      >
                        <Icon icon="mdi:close" width={12} height={12} />
                      </button>
                    </div>
                  </span>
                );
              })}
              {dragTarget?.zoneId === zone.id && (dragTarget?.index ?? -1) >= zone.buttonKeys.length && (
                <div className="toolbar-edit-insert-indicator toolbar-edit-insert-indicator--end" />
              )}
              {zone.buttonKeys.length === 0 && dragTarget?.zoneId !== zone.id && (
                <div className="toolbar-edit-zone-empty">拖拽按钮到此处或点击上方按钮添加</div>
              )}
            </div>
            {zones.indexOf(zone) < zones.length - 1 && <div className="toolbar-edit-zone-divider" />}
          </div>
        ))}

        <button type="button" className="toolbar-edit-add-zone nodrag" onClick={edit.addZone} data-tooltip="新建分区">
          <Icon icon="mdi:plus" width={14} height={14} />
          <span>新建分区</span>
        </button>
      </div>

      {/* 右侧：快捷指令面板 */}
      {(allSlashCommands.length > 0 || matchingUserPresets.length > 0) && (
        <div className="toolbar-edit-commands nodrag">
          <div className="toolbar-edit-commands-header">快捷指令</div>
          <div className="toolbar-edit-commands-list nodrag nowheel">
            {allSlashCommands.map((cmd) => {
              if (edit.activeButtonKeys.has(cmd.id)) return null;
              return (
                <button
                  key={`sc-${cmd.id}`}
                  type="button"
                  className="toolbar-edit-command-item nodrag"
                  onClick={() => addToZone(cmd.id)}
                  data-tooltip={cmd.description}
                >
                  <span className="toolbar-edit-bank-icon"><MiniIcon icon={cmd.icon} /></span>
                  <span className="toolbar-edit-command-label">{cmd.title}</span>
                </button>
              );
            })}
            {matchingUserPresets.map((p) => {
              if (edit.activeButtonKeys.has(p.id)) return null;
              return (
                <button
                  key={`up-${p.id}`}
                  type="button"
                  className="toolbar-edit-command-item nodrag"
                  onClick={() => addToZone(p.id)}
                  data-tooltip={p.description || p.name}
                >
                  <span className="toolbar-edit-bank-icon"><MiniIcon icon={p.icon || 'mdi:star'} /></span>
                  <span className="toolbar-edit-command-label">{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

export default memo(ToolbarEditorInner);
