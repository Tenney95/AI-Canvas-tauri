/**
 * SelectedNodeFlowEdge 选中节点流动边 — 自定义 React Flow 边组件，在边路径上渲染流动渐变动画效果
 * 支持贝塞尔曲线和平滑阶梯两种路径类型，通过 SVG animateMotion 实现光点沿边流动
 */
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import scissorsIcon from '../../assets/scissors.svg';

const SMOOTHSTEP_TYPE = 'smoothstep';
const FLOW_HALF_LENGTH = 36;
const FLOW_MASK_HALF_HEIGHT = 16;
const FLOW_MASK_MARGIN = 256;

function SelectedNodeFlowEdge({
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
}: EdgeProps) {
  const onEdgesChange = useAppStore((state) => state.onEdgesChange);
  const performanceMode = useAppStore((state) => state.config.performanceMode === true);
  const { screenToFlowPosition } = useReactFlow();
  const [showDeleteButton, setShowDeleteButton] = useState(false);
  const [deleteButtonPosition, setDeleteButtonPosition] = useState({ x: 0, y: 0 });
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const flowId = useId().replace(/:/g, '');
  const gradientId = `selected-node-edge-flow-gradient-${flowId}`;
  const maskId = `selected-node-edge-flow-mask-${flowId}`;
  const pathParams = {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  };
  const baseType = data?.selectedNodeFlowBaseType ?? (type === SMOOTHSTEP_TYPE ? SMOOTHSTEP_TYPE : 'default');
  const [edgePath, labelX, labelY] = baseType === SMOOTHSTEP_TYPE
    ? getSmoothStepPath(pathParams)
    : getBezierPath(pathParams);
  const maskX = Math.min(sourceX, targetX) - FLOW_MASK_MARGIN;
  const maskY = Math.min(sourceY, targetY) - FLOW_MASK_MARGIN;
  const maskWidth = Math.abs(targetX - sourceX) + FLOW_MASK_MARGIN * 2;
  const maskHeight = Math.abs(targetY - sourceY) + FLOW_MASK_MARGIN * 2;

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
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    pointerPositionRef.current = position;
    if (showDeleteButton) setDeleteButtonPosition(position);
  }, [screenToFlowPosition, showDeleteButton]);

  const handleEdgeMouseEnter = useCallback((event: React.MouseEvent<SVGGElement>) => {
    clearTimers();
    updatePointerPosition(event);
    hoverTimerRef.current = setTimeout(() => {
      setDeleteButtonPosition(pointerPositionRef.current);
      setShowDeleteButton(true);
    }, 1000);
  }, [clearTimers, updatePointerPosition]);

  const handleDelete = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearTimers();
    onEdgesChange([{ type: 'remove', id }]);
  }, [clearTimers, id, onEdgesChange]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return (
    <>
      <g onMouseEnter={handleEdgeMouseEnter} onMouseMove={updatePointerPosition} onMouseLeave={scheduleHide}>
        <BaseEdge
          id={id}
          path={edgePath}
          markerStart={markerStart}
          markerEnd={markerEnd}
          style={style}
          interactionWidth={interactionWidth}
          label={label}
          labelX={labelX}
          labelY={labelY}
          labelStyle={labelStyle}
          labelShowBg={labelShowBg}
          labelBgStyle={labelBgStyle}
          labelBgPadding={labelBgPadding}
          labelBgBorderRadius={labelBgBorderRadius}
        />
      </g>
      {type === 'selected-node-flow' && !performanceMode && (
        <g className="selected-node-edge-flow-group" aria-hidden="true">
          <defs>
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={-FLOW_HALF_LENGTH}
              y1="0"
              x2={FLOW_HALF_LENGTH}
              y2="0"
            >
              <stop
                className="selected-node-edge-flow-stop selected-node-edge-flow-stop--edge"
                offset="0%"
              />
              <stop
                className="selected-node-edge-flow-stop selected-node-edge-flow-stop--shoulder"
                offset="22%"
              />
              <stop
                className="selected-node-edge-flow-stop selected-node-edge-flow-stop--center"
                offset="50%"
              />
              <stop
                className="selected-node-edge-flow-stop selected-node-edge-flow-stop--shoulder"
                offset="78%"
              />
              <stop
                className="selected-node-edge-flow-stop selected-node-edge-flow-stop--edge"
                offset="100%"
              />
            </linearGradient>
            <mask
              id={maskId}
              className="selected-node-edge-flow-mask"
              maskUnits="userSpaceOnUse"
              maskContentUnits="userSpaceOnUse"
              x={maskX}
              y={maskY}
              width={maskWidth}
              height={maskHeight}
            >
              <rect
                x={-FLOW_HALF_LENGTH}
                y={-FLOW_MASK_HALF_HEIGHT}
                width={FLOW_HALF_LENGTH * 2}
                height={FLOW_MASK_HALF_HEIGHT * 2}
                fill={`url(#${gradientId})`}
              >
                <animateMotion
                  path={edgePath}
                  dur="1600ms"
                  repeatCount="indefinite"
                  rotate="auto"
                />
              </rect>
            </mask>
          </defs>
          <path
            className="selected-node-edge-flow"
            d={edgePath}
            mask={`url(#${maskId})`}
          />
        </g>
      )}
      {showDeleteButton && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan z-20 flex items-center justify-center"
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
}

export default memo(SelectedNodeFlowEdge);
