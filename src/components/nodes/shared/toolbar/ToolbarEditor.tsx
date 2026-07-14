/**
 * ToolbarEditor — Toolbar 自定义编辑态面板
 *
 * 拖拽实现：Pointer Events 手动拖拽（不用 HTML5 DnD，避免 React Flow nodrag 冲突）
 */
import { memo, useCallback, useState, useRef, useEffect } from 'react';
import { Icon } from '@iconify/react';
import type { ToolbarButtonDef } from '../../../../types';
import type { UseToolbarEditReturn } from '../../../../hooks/useToolbarEdit';

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

const DRAG_THRESHOLD_PX = 5;

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

  // 只在落点变化时更新 React 状态；高频指针坐标保存在 dragRef 中
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);

  const zones = edit.layout.zones;
  const moveButtonAcross = edit.moveButtonAcross;
  const exitEdit = edit.exitEdit;

  // ── 根据鼠标位置计算目标 zone + index ──
  const calcTarget = useCallback((clientX: number, clientY: number): { zoneId: string; index: number } | null => {
    if (!containerRef.current) return null;
    const zoneEls = containerRef.current.querySelectorAll<HTMLElement>('.toolbar-edit-zone');
    for (const zoneEl of zoneEls) {
      const zoneRect = zoneEl.getBoundingClientRect();
      if (clientY >= zoneRect.top && clientY <= zoneRect.bottom
        && clientX >= zoneRect.left && clientX <= zoneRect.right) {
        const zoneId = zoneEl.dataset.zoneId;
        if (!zoneId) return null;
        const body = zoneEl.querySelector<HTMLElement>('.toolbar-edit-zone-body');
        const btnEls = Array.from(body?.querySelectorAll<HTMLElement>('.toolbar-edit-btn') ?? []);
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

  // 组件卸载时兜底清理克隆浮层和全局拖拽样式
  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.frameId !== null && drag?.frameId !== undefined) cancelAnimationFrame(drag.frameId);
    drag?.sourceEl.classList.remove('is-dragging');
    document.body.classList.remove('toolbar-edit-dragging');
    ghostElRef.current?.remove();
    ghostElRef.current = null;
    dragRef.current = null;
  }, []);

  // ── 点击外部退出编辑态 ──
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        exitEdit();
      }
    };
    if (edit.isEditing) {
      document.addEventListener('mousedown', onDown, true);
      return () => document.removeEventListener('mousedown', onDown, true);
    }
  }, [edit.isEditing, exitEdit]);

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
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
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
          <button type="button" className="toolbar-edit-action-btn toolbar-edit-action-btn--done nodrag" onClick={edit.exitEdit}>
            <Icon icon="mdi:check" width={14} height={14} />
            <span>完成</span>
          </button>
        </div>
      </div>

      {/* ── 可编辑 Zone 列表 ── */}
      <div className="toolbar-edit-zones nodrag">
        {zones.map((zone) => (
          <div
            key={zone.id}
            className={`toolbar-edit-zone nodrag${dragTarget?.zoneId === zone.id ? ' drag-over' : ''}`}
            data-zone-id={zone.id}
          >
            <div className="toolbar-edit-zone-header">
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
                  const p = presetItems.find((pi) => pi.id === key);
                  const u = userPresetItems.find((ui) => ui.id === key);
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
    </div>
  );
}

export default memo(ToolbarEditorInner);
