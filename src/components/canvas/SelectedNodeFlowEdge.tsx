/**
 * SelectedNodeFlowEdge 选中节点流动边 — 自定义 React Flow 边组件，在边路径上渲染流光反馈。
 * 支持贝塞尔曲线和平滑阶梯，路径复用并汇入共享 SVG，流光不创建离屏遮罩。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import type { CanvasEdgeVisualProps } from '../../types/canvasEdges';
import { canAnimateCanvasEdgeFlow } from '../../utils/canvasRenderProjection';
import { getCanvasEdgePath } from '../../utils/canvasEdgePath';
import scissorsIcon from '../../assets/scissors.svg';

const SMOOTHSTEP_TYPE = 'smoothstep';
const FLOW_EFFECT_MARGIN = 256;

/** Only mounted edges with visible endpoints retain hover state and timers. */
export const CanvasEdgeHover = memo(function CanvasEdgeHover({
  id,
  onDelete,
  resolveHoverEdge,
  children,
}: Pick<CanvasEdgeVisualProps, 'id' | 'onDelete' | 'resolveHoverEdge'> & { children: ReactNode }) {
  const { screenToFlowPosition } = useReactFlow();
  const [showDeleteButton, setShowDeleteButton] = useState(false);
  const [deleteButtonPosition, setDeleteButtonPosition] = useState({ x: 0, y: 0 });
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const hoveredEdgeRef = useRef(id);
  const clearTimers = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hoverTimerRef.current = null;
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hideTimerRef.current = setTimeout(() => setShowDeleteButton(false), 180);
  }, []);

  const updatePointerPosition = useCallback((event: React.MouseEvent<SVGGElement>) => {
    // 指针可比屏幕刷新率更快；只有悬停这一条边在帧末读取视口并更新剪刀位置。
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    if (!showDeleteButton || pointerFrameRef.current !== null) return;
    pointerFrameRef.current = requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      hoveredEdgeRef.current = resolveHoverEdge?.(pointerPositionRef.current) ?? id;
      setDeleteButtonPosition(screenToFlowPosition(pointerPositionRef.current));
    });
  }, [id, resolveHoverEdge, screenToFlowPosition, showDeleteButton]);

  const handleEdgeMouseEnter = useCallback((event: React.MouseEvent<SVGGElement>) => {
    clearTimers();
    updatePointerPosition(event);
    hoverTimerRef.current = setTimeout(() => {
      hoveredEdgeRef.current = resolveHoverEdge?.(pointerPositionRef.current) ?? id;
      setDeleteButtonPosition(screenToFlowPosition(pointerPositionRef.current));
      setShowDeleteButton(true);
    }, 1000);
  }, [clearTimers, id, resolveHoverEdge, screenToFlowPosition, updatePointerPosition]);

  const handleDelete = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearTimers();
    onDelete(hoveredEdgeRef.current);
  }, [clearTimers, onDelete]);

  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => () => {
    if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
    pointerFrameRef.current = null;
  }, [showDeleteButton]);

  return (
    <>
      <g
        onMouseEnter={handleEdgeMouseEnter}
        onMouseMove={updatePointerPosition}
        onMouseLeave={scheduleHide}
      >
        {children}
      </g>
      {showDeleteButton && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="canvas-edge-delete-control nodrag nopan z-20 flex items-center justify-center"
            style={{
              position: 'absolute',
              width: '40px',
              height: '40px',
              padding: 0,
              border: 0,
              background: 'transparent',
              pointerEvents: 'all',
              transform: `translate(-50%, -50%) translate(${deleteButtonPosition.x}px, ${deleteButtonPosition.y}px)`,
            }}
            aria-label="删除连线"
            data-tooltip="删除连线"
            onMouseEnter={clearTimers}
            onMouseLeave={scheduleHide}
            onClick={handleDelete}
          >
            <span
              className="ui-icon-btn ui-icon-btn--danger pointer-events-none rounded-full"
            >
              <img src={scissorsIcon} alt="" width={24} height={24} draggable={false} aria-hidden="true" />
            </span>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const CanvasEdgeVisual = memo(function CanvasEdgeVisual({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  interactionWidth,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  data,
  type,
  path,
  baseStroke = true,
  interactive = true,
  performanceMode,
  onDelete,
  resolveHoverEdge,
}: CanvasEdgeVisualProps) {
  const baseType = data?.selectedNodeFlowBaseType ?? (type === SMOOTHSTEP_TYPE ? SMOOTHSTEP_TYPE : 'default');
  const [edgePath, labelX, labelY] = useMemo(() => {
    return path ?? getCanvasEdgePath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
      type: baseType === SMOOTHSTEP_TYPE ? SMOOTHSTEP_TYPE : 'default' });
  }, [path, baseType, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);
  const effectWidth = Math.abs(targetX - sourceX) + FLOW_EFFECT_MARGIN * 2;
  const effectHeight = Math.abs(targetY - sourceY) + FLOW_EFFECT_MARGIN * 2;
  const stroke = baseStroke ? (
    <BaseEdge
      id={id}
      path={edgePath}
      markerStart={markerStart}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactive ? interactionWidth : 0}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  ) : interactive ? (
    <path d={edgePath} fill="none" strokeOpacity={0} strokeWidth={interactionWidth ?? 20}
      className="react-flow__edge-interaction" />
  ) : null;

  return (
    <>
      {interactive ? <CanvasEdgeHover id={id} onDelete={onDelete} resolveHoverEdge={resolveHoverEdge}>{stroke}</CanvasEdgeHover> : stroke}
      {interactive && type === 'selected-node-flow' && !performanceMode
        && data?.selectedNodeFlowAnimated !== false && canAnimateCanvasEdgeFlow(effectWidth, effectHeight) && (
        <g className="selected-node-edge-flow-group" aria-hidden="true">
          <path className="selected-node-edge-flow" d={edgePath} pathLength={100} />
        </g>
      )}
    </>
  );
});

function SelectedNodeFlowEdge(props: EdgeProps) {
  const onEdgesChange = useAppStore((state) => state.onEdgesChange);
  const performanceMode = useAppStore((state) => state.config.performanceMode === true);
  const handleDelete = useCallback((id: string) => {
    onEdgesChange([{ type: 'remove', id }]);
  }, [onEdgesChange]);

  return <CanvasEdgeVisual {...props} performanceMode={performanceMode} onDelete={handleDelete} />;
}

export default memo(SelectedNodeFlowEdge);
