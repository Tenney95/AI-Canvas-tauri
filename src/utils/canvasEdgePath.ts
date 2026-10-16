import { getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import type { CanvasEdgePath, CanvasEdgePosition, CanvasSharedEdgeModel } from '../types/canvasEdges';

export function getCanvasEdgePath(props: CanvasEdgePosition & Pick<EdgeProps, 'type' | 'data'>): CanvasEdgePath {
  const baseType = props.data?.selectedNodeFlowBaseType ?? props.type;
  return baseType === 'smoothstep' ? getSmoothStepPath(props) : getBezierPath(props);
}

/** Preserve SVG semantics for features the basic Canvas stroke does not implement. */
export function canUseCanvasEdgeStroke({ edge }: CanvasSharedEdgeModel): boolean {
  return !edge.markerStart && !edge.markerEnd && (edge.label == null || edge.label === '') && !edge.animated && !edge.className
    && Object.keys(edge.style ?? {}).every((key) => key === 'stroke' || key === 'strokeWidth');
}
