/** canvasConnectionIndex — 按连线数组身份缓存入边来源，保留画布节点顺序。 */
import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { getCanvasNodeById, getCanvasNodeOrder } from './canvasRenderProjection';

const incomingSources = new WeakMap<readonly Edge[], Map<string, Set<string>>>();

export function getCanvasConnectedSourceNodes(
  nodes: readonly Node<BaseNodeData>[], edges: readonly Edge[], nodeId: string | undefined,
): Node<BaseNodeData>[] {
  if (!nodeId) return [];
  let index = incomingSources.get(edges);
  if (!index) {
    index = new Map();
    for (const edge of edges) {
      let ids = index.get(edge.target);
      if (!ids) index.set(edge.target, ids = new Set());
      ids.add(edge.source);
    }
    incomingSources.set(edges, index);
  }
  return [...(index.get(nodeId) ?? [])]
    .flatMap((id) => { const node = getCanvasNodeById(nodes, id); return node ? [node] : []; })
    .sort((left, right) => getCanvasNodeOrder(nodes, left.id) - getCanvasNodeOrder(nodes, right.id));
}
