/**
 * 在多选节点间绘制可拖拽间距手柄，用于交互式调整或一键平均分布水平和垂直间距。
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import {
  applyDistributionPositions,
  prepareDistributionLayout,
  getDistributionItems,
  getItemGap,
  type DistributionAxis,
} from '../../utils/distributionGeometry';
import { createFrameCoalescer } from '../../utils/frameCoalescer';

interface DistributionGapHandlesProps {
  axis: DistributionAxis;
}

interface DragSession {
  axis: DistributionAxis;
  gapIndex: number;
  selectedNodeIds: string[];
  projectId: string | null;
  pointerId: number;
  parents: Map<string, string | undefined>;
  layout: ReturnType<typeof prepareDistributionLayout>;
  startPointer: { x: number; y: number };
  startGap: number;
  adjacentOnly: boolean;
  historyCommitted: boolean;
}

function DistributionGapHandles({ axis }: DistributionGapHandlesProps) {
  const t = useT();
  const nodes = useAppStore((state) => state.nodes);
  const selectedNodeIds = useAppStore((state) => state.selectedNodeIds);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();
  const { zoom } = useViewport();
  const dragSessionRef = useRef<DragSession | null>(null);
  const removeListenersRef = useRef<() => void>(() => undefined);

  const flowHandles = useMemo(() => {
    const items = getDistributionItems(nodes, selectedNodeIds, axis);
    return items.slice(0, -1).map((item, gapIndex) => {
      const next = items[gapIndex + 1];
      // 取相邻两节点在交叉轴上的内侧边界中心：
      // 有交叠时是交叠区域中心，无交叠时自然退化为两节点间隙中心。
      const pairCrossCenter = (
        Math.max(item.crossStart, next.crossStart)
        + Math.min(item.crossEnd, next.crossEnd)
      ) / 2;
      const flowPosition = axis === 'horizontal'
        ? { x: (item.end + next.start) / 2, y: pairCrossCenter }
        : { x: pairCrossCenter, y: (item.end + next.start) / 2 };
      return {
        gapIndex,
        flowPosition,
      };
    });
  }, [axis, nodes, selectedNodeIds]);

  // 每次渲染共用一个包含容器偏移的屏幕原点，避免逐个手柄读取容器边界。
  const screenOrigin = flowHandles.length > 0 ? flowToScreenPosition({ x: 0, y: 0 }) : null;
  const handles = screenOrigin ? flowHandles.map(({ gapIndex, flowPosition }) => ({
    gapIndex,
    screenPosition: {
      x: screenOrigin.x + flowPosition.x * zoom,
      y: screenOrigin.y + flowPosition.y * zoom,
    },
  })) : [];

  const finishDrag = useCallback(() => {
    if (!dragSessionRef.current) return;
    dragSessionRef.current = null;
    removeListenersRef.current();
  }, []);

  useEffect(() => () => {
    finishDrag();
  }, [axis, currentProjectId, finishDrag]);

  const startDrag = useCallback((gapIndex: number, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragSessionRef.current) return;
    const state = useAppStore.getState();
    if (state.currentProjectId !== currentProjectId) return;
    const currentIds = state.selectedNodeIds;
    const items = getDistributionItems(state.nodes, currentIds, axis);
    const before = items[gapIndex], after = items[gapIndex + 1];
    if (!before || !after) return;
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const session: DragSession = {
      axis, gapIndex, projectId: currentProjectId, pointerId: event.pointerId,
      selectedNodeIds: [...currentIds],
      parents: new Map(items.map(({ node }) => [node.id, node.parentId])),
      layout: prepareDistributionLayout(items, axis),
      startPointer: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      startGap: Math.max(0, getItemGap(before, after)),
      adjacentOnly: event.shiftKey,
      historyCommitted: false,
    };
    dragSessionRef.current = session;

    const applyPointer = (point: { x: number; y: number }) => {
      const latest = useAppStore.getState();
      const nodeMap = new Map(latest.nodes.map((node) => [node.id, node]));
      const selected = new Set(latest.selectedNodeIds);
      if (dragSessionRef.current !== session || latest.currentProjectId !== session.projectId
        || selected.size !== session.selectedNodeIds.length || session.selectedNodeIds.some((id) => !selected.has(id))
        || [...session.parents].some(([id, parentId]) => !nodeMap.has(id) || nodeMap.get(id)?.parentId !== parentId)) {
        finishDrag();
        return;
      }
      const pointer = screenToFlowPosition(point);
      const delta = session.axis === 'horizontal'
        ? pointer.x - session.startPointer.x : pointer.y - session.startPointer.y;
      if (Math.abs(delta) < 0.5 && !session.historyCommitted) return;
      const gap = Math.max(0, session.startGap + delta);
      const positions = session.adjacentOnly
        ? session.layout.adjacentGap(session.gapIndex, gap) : session.layout.equalGap(gap);
      const updated = applyDistributionPositions(latest.nodes, session.axis, positions, nodeMap);
      if (updated === latest.nodes) return;
      if (!session.historyCommitted) {
        latest.commitToHistory();
        session.historyCommitted = true;
      }
      latest.setNodes(updated);
    };
    const preview = createFrameCoalescer(applyPointer);
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === session.pointerId) preview.schedule({ x: moveEvent.clientX, y: moveEvent.clientY });
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== session.pointerId) return;
      preview.cancel();
      applyPointer({ x: upEvent.clientX, y: upEvent.clientY });
      finishDrag();
    };
    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === session.pointerId) finishDrag();
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
    removeListenersRef.current = () => {
      preview.cancel();
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      target.removeEventListener('lostpointercapture', onPointerCancel);
      window.removeEventListener('blur', finishDrag);
      if (target.hasPointerCapture(session.pointerId)) target.releasePointerCapture(session.pointerId);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      removeListenersRef.current = () => undefined;
    };
    target.setPointerCapture(session.pointerId);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    target.addEventListener('lostpointercapture', onPointerCancel);
    window.addEventListener('blur', finishDrag);
  }, [axis, currentProjectId, finishDrag, screenToFlowPosition]);

  if (handles.length === 0) return null;

  const isHorizontal = axis === 'horizontal';

  return (
    <div className="fixed inset-0 z-[9998] pointer-events-none" aria-hidden={false}>
      {handles.map(({ gapIndex, screenPosition }) => (
        <button
          key={`${axis}-${gapIndex}`}
          type="button"
          data-distribution-axis={axis}
          data-gap-index={gapIndex}
          aria-label={t('{dir}间距手柄 {index}', { dir: isHorizontal ? t('横向') : t('纵向'), index: gapIndex + 1 })}
          title={t('拖动调整全部间距，Shift 仅调整相邻节点')}
          className={`nokey nodrag nopan fixed pointer-events-auto border border-indigo-400/40 bg-indigo-400/25 backdrop-blur-sm transition-[opacity,border-color,background-color] hover:border-indigo-400/70 hover:bg-indigo-400/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 ${
            isHorizontal
              ? 'h-5 w-1.5 cursor-ew-resize rounded-full'
              : 'h-1.5 w-5 cursor-ns-resize rounded-full'
          }`}
          style={{
            left: screenPosition.x,
            top: screenPosition.y,
            transform: 'translate(-50%, -50%)',
          }}
          onPointerDown={(event) => startDrag(gapIndex, event)}
        />
      ))}
    </div>
  );
}

export default memo(DistributionGapHandles);
