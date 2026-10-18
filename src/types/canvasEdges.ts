import type { ComponentType, ReactNode } from 'react';
import type {
  Edge,
  EdgeMouseHandler,
  EdgeProps,
  InternalNode,
  ReactFlowState,
} from '@xyflow/react';

export type CanvasEdgeDisplayMode = 'orthogonal' | 'curved' | 'hidden';

export type CanvasEdgePosition = Pick<EdgeProps,
  'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>;

export type CanvasEdgePath = [path: string, labelX: number, labelY: number, offsetX: number, offsetY: number];

/** Only the installed React Flow's geometry helpers cross the build adapter. */
export interface CanvasEdgeGeometry {
  getEdgePosition(params: {
    id: string;
    sourceNode: InternalNode;
    targetNode: InternalNode;
    sourceHandle: string | null;
    targetHandle: string | null;
    connectionMode: ReactFlowState['connectionMode'];
    onError?: ReactFlowState['onError'];
  }): CanvasEdgePosition | null;
  getElevatedEdgeZIndex(params: {
    sourceNode: InternalNode;
    targetNode: InternalNode;
    selected?: boolean;
    zIndex?: number;
    elevateOnSelect?: boolean;
    zIndexMode?: ReactFlowState['zIndexMode'];
  }): number;
  getMarkerId(marker: Edge['markerStart'], rfId: string): string;
}

export interface CanvasEdgeLayerProps {
  edgeIds: readonly string[];
  rfId: string;
  geometry: CanvasEdgeGeometry;
  renderEdge(id: string): ReactNode;
  noPanClassName: string;
  disableKeyboardA11y?: boolean;
  onEdgeClick?: EdgeMouseHandler;
  onEdgeDoubleClick?: EdgeMouseHandler;
  onEdgeContextMenu?: EdgeMouseHandler;
  onEdgeMouseEnter?: EdgeMouseHandler;
  onEdgeMouseMove?: EdgeMouseHandler;
  onEdgeMouseLeave?: EdgeMouseHandler;
}

export type CanvasLayerEdgeComponent = ComponentType<EdgeProps> & {
  renderLayer?: ComponentType<CanvasEdgeLayerProps>;
};

export type CanvasEdgeVisualProps = EdgeProps & {
  path?: CanvasEdgePath;
  /** Canvas owns the base stroke; SVG keeps hit testing and decorations. */
  baseStroke?: boolean;
  interactive?: boolean;
  performanceMode: boolean;
  onDelete(id: string): void;
  resolveHoverEdge?(point: { x: number; y: number }): string;
};

export interface CanvasSharedEdgeModel {
  kind: 'shared';
  edge: Edge;
  props: EdgeProps;
  path: CanvasEdgePath;
  zIndex: number;
  interactive: boolean;
  focusable: boolean;
  selectable: boolean;
}

export interface CanvasNativeEdgeModel {
  kind: 'native';
  id: string;
}

export type CanvasEdgeModel = CanvasSharedEdgeModel | CanvasNativeEdgeModel;
