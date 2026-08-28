import type { Edge, Node } from '@xyflow/react';

export const CANVAS_EDGE_Z_INDEX = 0;
export const CANVAS_NODE_Z_INDEX = 1;
export const SELECTED_CANVAS_NODE_Z_INDEX_OFFSET = 1000;

/**
 * React Flow 的 basic 模式会把连接分组子节点的边提升到父节点上方。
 * 画布改用 manual 模式后，在渲染态统一保证所有节点都高于所有连线。
 */
export function withCanvasNodeLayer<T extends Node>(node: T): T {
  const baseZIndex = Math.max(CANVAS_NODE_Z_INDEX, (node.zIndex ?? 0) + CANVAS_NODE_Z_INDEX);
  const zIndex = baseZIndex + (node.selected ? SELECTED_CANVAS_NODE_Z_INDEX_OFFSET : 0);
  return node.zIndex === zIndex ? node : { ...node, zIndex };
}

export function withCanvasEdgeLayer<T extends Edge>(edge: T): T {
  return edge.zIndex === CANVAS_EDGE_Z_INDEX
    ? edge
    : { ...edge, zIndex: CANVAS_EDGE_Z_INDEX };
}
