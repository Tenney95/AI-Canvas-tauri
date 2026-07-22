/**
 * SelectedNodeFlowEdge 选中节点流动边 — 自定义 React Flow 边组件，在边路径上渲染流动渐变动画效果
 * 支持贝塞尔曲线和平滑阶梯两种路径类型，通过 SVG animateMotion 实现光点沿边流动
 */
import { memo, useId } from 'react';
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';

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
}: EdgeProps) {
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
  const [edgePath, labelX, labelY] = data?.selectedNodeFlowBaseType === SMOOTHSTEP_TYPE
    ? getSmoothStepPath(pathParams)
    : getBezierPath(pathParams);
  const maskX = Math.min(sourceX, targetX) - FLOW_MASK_MARGIN;
  const maskY = Math.min(sourceY, targetY) - FLOW_MASK_MARGIN;
  const maskWidth = Math.abs(targetX - sourceX) + FLOW_MASK_MARGIN * 2;
  const maskHeight = Math.abs(targetY - sourceY) + FLOW_MASK_MARGIN * 2;

  return (
    <>
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
    </>
  );
}

export default memo(SelectedNodeFlowEdge);
