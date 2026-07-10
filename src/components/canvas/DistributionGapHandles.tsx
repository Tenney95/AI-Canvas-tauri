import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import {
  adjustAdjacentNodeGap,
  distributeNodesWithEqualGap,
  getDistributionItems,
  getItemGap,
  type DistributionAxis,
} from '../../utils/distributionGeometry';

interface DistributionGapHandlesProps {
  axis: DistributionAxis;
}

interface DragSession {
  axis: DistributionAxis;
  gapIndex: number;
  selectedNodeIds: string[];
  startNodes: ReturnType<typeof useAppStore.getState>['nodes'];
  startPointer: { x: number; y: number };
  startGap: number;
  adjacentOnly: boolean;
  historyCommitted: boolean;
}

function DistributionGapHandles({ axis }: DistributionGapHandlesProps) {
  const nodes = useAppStore((state) => state.nodes);
  const selectedNodeIds = useAppStore((state) => state.selectedNodeIds);
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();
  useViewport(); // 视口变化时重渲染；下方仅重算少量手柄的屏幕坐标。
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

  const handles = flowHandles.map(({ gapIndex, flowPosition }) => ({
    gapIndex,
    screenPosition: flowToScreenPosition(flowPosition),
  }));

  const finishDrag = useCallback(() => {
    dragSessionRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => () => {
    removeListenersRef.current();
    finishDrag();
  }, [finishDrag]);

  const startDrag = useCallback((gapIndex: number, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const state = useAppStore.getState();
    const startNodes = state.nodes;
    const currentIds = state.selectedNodeIds;
    const items = getDistributionItems(startNodes, currentIds, axis);
    const before = items[gapIndex];
    const after = items[gapIndex + 1];
    if (!before || !after) return;

    const startPointer = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    dragSessionRef.current = {
      axis,
      gapIndex,
      selectedNodeIds: [...currentIds],
      startNodes,
      startPointer,
      startGap: Math.max(0, getItemGap(before, after)),
      adjacentOnly: event.shiftKey,
      historyCommitted: false,
    };

    const cursor = axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';

    const onPointerMove = (moveEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;

      const pointer = screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY });
      const delta = session.axis === 'horizontal'
        ? pointer.x - session.startPointer.x
        : pointer.y - session.startPointer.y;
      if (Math.abs(delta) < 0.5) return;

      if (!session.historyCommitted) {
        useAppStore.getState().commitToHistory();
        session.historyCommitted = true;
      }

      const requestedGap = Math.max(0, session.startGap + delta);
      const updatedNodes = session.adjacentOnly
        ? adjustAdjacentNodeGap(
            session.startNodes,
            session.selectedNodeIds,
            session.axis,
            session.gapIndex,
            requestedGap,
          )
        : distributeNodesWithEqualGap(
            session.startNodes,
            session.selectedNodeIds,
            session.axis,
            requestedGap,
          );
      useAppStore.getState().setNodes(updatedNodes);
    };

    const onPointerEnd = () => {
      removeListenersRef.current();
      finishDrag();
    };

    removeListenersRef.current();
    removeListenersRef.current = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      removeListenersRef.current = () => undefined;
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
  }, [axis, finishDrag, screenToFlowPosition]);

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
          aria-label={`${isHorizontal ? '横向' : '纵向'}间距手柄 ${gapIndex + 1}`}
          title="拖动调整全部间距，Shift 仅调整相邻节点"
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
