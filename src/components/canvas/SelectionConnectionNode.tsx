/**
 * SelectionConnectionNode — 提供多选节点连接界面与交互。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import GooeyBtn from '../nodes/shared/GooeyBtn';
import { useAppStore } from '../../store/useAppStore';
import { isBatchConnectableNode } from '../../store/store.nodes';
import { getNodeBounds } from '../../utils/nodeBounds.js';
import { t, useT } from '../../i18n';

interface DragSession {
  sourceIds: string[];
  sourcePoints: { id: string; x: number; y: number }[];
  projectId: string | null;
  start: { x: number; y: number };
  current: { x: number; y: number };
}

interface Props {
  rootRef: RefObject<HTMLDivElement | null>;
  onBlankDrop: (
    sourceIds: string[],
    projectId: string | null,
    position: { x: number; y: number },
    sourcePoints: { x: number; y: number }[],
  ) => void;
}

export default function SelectionConnectionHandle({ rootRef, onBlankDrop }: Props) {
  useT();
  const nodes = useAppStore((state) => state.selectedNodeIds.length >= 2 ? state.nodes : null);
  const selectedNodeIds = useAppStore((state) => state.selectedNodeIds);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const connectSelectedNodes = useAppStore((state) => state.connectSelectedNodes);
  const showToast = useAppStore((state) => state.showToast);
  const flow = useReactFlow();
  useViewport();
  const [drag, setDrag] = useState<DragSession | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  const selection = useMemo(() => {
    if (!nodes) return null;
    const selectedIds = new Set(selectedNodeIds);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const selected = nodes.filter((node) => selectedIds.has(node.id) && isBatchConnectableNode(node)
      && !(node.parentId && nodeById.get(node.parentId)?.data.groupCollapsed));
    if (selected.length < 2) return null;
    selected.sort((a, b) => {
      const aId = Number(a.data.displayId);
      const bId = Number(b.data.displayId);
      return (Number.isFinite(aId) ? aId : Infinity) - (Number.isFinite(bId) ? bId : Infinity);
    });

    let right = -Infinity, top = Infinity, bottom = -Infinity;
    const sources = selected.map((node) => {
      const bounds = getNodeBounds(node, nodeById);
      right = Math.max(right, bounds.right);
      top = Math.min(top, bounds.top);
      bottom = Math.max(bottom, bounds.bottom);
      return { id: node.id, x: bounds.right, y: bounds.centerY };
    });
    return { sources, anchor: { x: right, y: (top + bottom) / 2 } };
  }, [nodes, selectedNodeIds]);

  const anchor = selection && !drag ? flow.flowToScreenPosition(selection.anchor) : null;

  const isDragging = drag !== null;
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (event: PointerEvent) => {
      setDrag((current) => {
        if (!current) return null;
        const next = { ...current, current: { x: event.clientX, y: event.clientY } };
        dragRef.current = next;
        return next;
      });
    };
    const onUp = (event: PointerEvent) => {
      const session = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!session || session.projectId !== useAppStore.getState().currentProjectId) return;
      if (Math.hypot(event.clientX - session.start.x, event.clientY - session.start.y) < 8) return;
      const targetElement = document.elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>('.react-flow__node[data-id]'))
        .find((element) => element !== null);
      const targetId = targetElement?.dataset.id;
      if (targetId) {
        const added = connectSelectedNodes(session.sourceIds, targetId, session.projectId);
        showToast(added > 0 ? t('已连接 {count} 个节点', { count: added }) : t('未新增连接'), added > 0 ? 'success' : 'info');
      } else {
        const canvas = rootRef.current?.getBoundingClientRect();
        if (canvas && canvas.left <= event.clientX && canvas.right >= event.clientX
          && canvas.top <= event.clientY && canvas.bottom >= event.clientY) {
          onBlankDrop(
            session.sourceIds,
            session.projectId,
            { x: event.clientX, y: event.clientY },
            session.sourcePoints,
          );
        }
      }
    };
    const onCancel = () => { dragRef.current = null; setDrag(null); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [isDragging, connectSelectedNodes, onBlankDrop, rootRef, showToast]);

  const end = drag?.current;

  return (
    <>
      {anchor && selection && (
        <div
          className="canvas-selection-connect-handle nodrag nopan"
          style={{ left: anchor.x + 30, top: anchor.y }}
        >
          <GooeyBtn
            className="canvas-selection-connect-gooey"
            hue={170}
            ariaLabel={t('连接 {count} 个选中节点', { count: selection.sources.length })}
            title={t('连接 {count} 个选中节点', { count: selection.sources.length })}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              const nodeElements = new Map(Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.react-flow__node[data-id]') ?? [])
                .map((element) => [element.dataset.id, element]));
              const sourcePoints = selection.sources.map(({ id, x, y }) => {
                const handle = nodeElements.get(id)?.querySelector<HTMLElement>('.react-flow__handle-right');
                if (handle) {
                  const rect = handle.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    return { id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                  }
                }
                return { id, ...flow.flowToScreenPosition({ x, y }) };
              });
              const session = {
                sourceIds: sourcePoints.map((point) => point.id),
                sourcePoints,
                projectId: currentProjectId,
                start: { x: event.clientX, y: event.clientY },
                current: { x: event.clientX, y: event.clientY },
              };
              dragRef.current = session;
              setDrag(session);
            }}
          />
        </div>
      )}
      {drag && end && (
        <svg className="canvas-selection-connect-preview" aria-hidden="true">
          {drag.sourcePoints.map((source) => {
            const bend = Math.max(36, Math.abs(end.x - source.x) / 2);
            return (
              <path
                key={source.id}
                d={`M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`}
              />
            );
          })}
        </svg>
      )}
    </>
  );
}
