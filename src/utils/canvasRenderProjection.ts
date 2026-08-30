import type { Edge, Node, NodeChange } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { withCanvasEdgeLayer, withCanvasNodeLayer } from './canvasElementLayering';

type CanvasNode = Node<BaseNodeData>;

interface CanvasNodeProjectionEntry {
  source: CanvasNode;
  projected: CanvasNode;
  renderData: BaseNodeData;
}

export interface CanvasNodeProjectionCache {
  entries: Map<string, CanvasNodeProjectionEntry>;
  lastProjectedNodes: CanvasNode[];
}

export interface CanvasEdgeProjection {
  layeredEdges: Edge[];
  incidentEdgeIndexesByNodeId: Map<string, number[]>;
}

let indexedNodes: readonly CanvasNode[] | null = null;
const indexedNodeById = new Map<string, CanvasNode>();
const edgeProjectionCache = new WeakMap<readonly Edge[], CanvasEdgeProjection>();

function rebuildNodeIndex(nodes: readonly CanvasNode[]): void {
  indexedNodeById.clear();
  for (const node of nodes) indexedNodeById.set(node.id, node);
}

/**
 * 共享节点 ID 索引。拖拽时 nodes 数组会变，但通常只替换正在移动的节点对象；
 * ID 顺序不变时只更新变化槽位，避免每个已挂载节点分别执行 O(N) find。
 */
function ensureNodeIndex(nodes: readonly CanvasNode[]): void {
  if (indexedNodes === nodes) return;

  const previous = indexedNodes;
  if (previous && previous.length === nodes.length) {
    let sameOrder = true;
    for (let index = 0; index < nodes.length; index += 1) {
      if (previous[index]?.id !== nodes[index]?.id) {
        sameOrder = false;
        break;
      }
    }
    if (sameOrder) {
      for (let index = 0; index < nodes.length; index += 1) {
        if (previous[index] !== nodes[index]) indexedNodeById.set(nodes[index].id, nodes[index]);
      }
      indexedNodes = nodes;
      return;
    }
  }

  rebuildNodeIndex(nodes);
  indexedNodes = nodes;
}

export function getCanvasNodeById(
  nodes: readonly CanvasNode[],
  nodeId: string,
): CanvasNode | undefined {
  ensureNodeIndex(nodes);
  return indexedNodeById.get(nodeId);
}

/** 项目切换到空画布时也主动同步，避免索引暂时保留上一项目的节点引用。 */
export function syncCanvasNodeIndex(nodes: readonly CanvasNode[]): void {
  ensureNodeIndex(nodes);
}

/** 事件节点保留 React Flow 的实时几何，只换回 Store 中的完整业务数据。 */
export function hydrateCanvasNodeData(
  node: CanvasNode,
  nodes: readonly CanvasNode[],
): CanvasNode {
  const stored = getCanvasNodeById(nodes, node.id);
  if (!stored || stored.data === node.data) return node;
  return { ...node, data: stored.data };
}

/** 防止 React Flow 的 replace 变更把轻量 data 壳写回权威 Store。 */
export function hydrateCanvasNodeChanges(
  changes: NodeChange<CanvasNode>[],
  nodes: readonly CanvasNode[],
): NodeChange<CanvasNode>[] {
  let changed = false;
  const hydrated = changes.map((change) => {
    if (change.type !== 'replace') return change;
    const item = hydrateCanvasNodeData(change.item, nodes);
    if (item === change.item) return change;
    changed = true;
    return { ...change, item };
  });
  return changed ? hydrated : changes;
}

export function createCanvasNodeProjectionCache(): CanvasNodeProjectionCache {
  return { entries: new Map(), lastProjectedNodes: [] };
}

function hasSameRenderFallbackData(current: BaseNodeData, next: BaseNodeData): boolean {
  return current.label === next.label
    && current.type === next.type
    && current.displayId === next.displayId;
}

function hasSameNodeFieldsExceptData(previous: CanvasNode, next: CanvasNode): boolean {
  if (previous === next) return true;
  const previousKeys = Object.keys(previous) as Array<keyof CanvasNode>;
  const nextKeys = Object.keys(next) as Array<keyof CanvasNode>;
  const previousFieldCount = previousKeys.reduce(
    (count, key) => count + (key === 'data' ? 0 : 1),
    0,
  );
  const nextFieldCount = nextKeys.reduce(
    (count, key) => count + (key === 'data' ? 0 : 1),
    0,
  );
  if (previousFieldCount !== nextFieldCount) return false;
  return nextKeys.every((key) => (
    key === 'data'
    || (
      Object.prototype.hasOwnProperty.call(previous, key)
      && Object.is(previous[key], next[key])
    )
  ));
}

function createRenderData(data: BaseNodeData): BaseNodeData {
  return {
    label: data.label,
    type: data.type,
    displayId: data.displayId,
  };
}

function applyCanvasNodeRenderLayout(node: CanvasNode, data: BaseNodeData): CanvasNode {
  const renderNode = node.type === 'canvas-note'
    ? {
        ...node,
        data,
        style: {
          ...node.style,
          // 笔记的透明外接矩形不能遮挡下方节点；可见内容由笔记样式恢复命中。
          pointerEvents: 'none' as const,
        },
      }
    : { ...node, data };
  return withCanvasNodeLayer(renderNode);
}

/**
 * React Flow 只持有稳定的轻量 data；完整 data 由统一节点 wrapper 按 ID 从 Store 读取。
 * 顶层几何/交互字段未变化时复用投影对象，避免媒体状态更新触发全图同步。
 */
export function projectCanvasNodesForReactFlow(
  nodes: readonly CanvasNode[],
  cache: CanvasNodeProjectionCache,
): CanvasNode[] {
  const activeNodeIds = new Set<string>();
  const nextProjectedNodes = nodes.map((node) => {
    activeNodeIds.add(node.id);
    const cached = cache.entries.get(node.id);
    if (
      cached
      && hasSameNodeFieldsExceptData(cached.source, node)
      && hasSameRenderFallbackData(cached.renderData, node.data)
    ) {
      cached.source = node;
      return cached.projected;
    }

    const renderData = createRenderData(node.data);
    const projected = applyCanvasNodeRenderLayout(node, renderData);
    cache.entries.set(node.id, { source: node, projected, renderData });
    return projected;
  });

  for (const nodeId of cache.entries.keys()) {
    if (!activeNodeIds.has(nodeId)) cache.entries.delete(nodeId);
  }

  const canReusePreviousArray = cache.lastProjectedNodes.length === nextProjectedNodes.length
    && nextProjectedNodes.every((node, index) => cache.lastProjectedNodes[index] === node);
  if (canReusePreviousArray) return cache.lastProjectedNodes;
  cache.lastProjectedNodes = nextProjectedNodes;
  return nextProjectedNodes;
}

/** 本地草稿节点尚未进入 Store，保留完整 data，只应用画布渲染布局。 */
export function projectTransientCanvasNode(node: CanvasNode): CanvasNode {
  return applyCanvasNodeRenderLayout(node, node.data);
}

export function createCanvasEdgeProjection(edges: readonly Edge[]): CanvasEdgeProjection {
  const cached = edgeProjectionCache.get(edges);
  if (cached) return cached;

  const layeredEdges = edges.map(withCanvasEdgeLayer);
  const incidentEdgeIndexesByNodeId = new Map<string, number[]>();
  const addIncidentIndex = (nodeId: string, edgeIndex: number) => {
    const indexes = incidentEdgeIndexesByNodeId.get(nodeId);
    if (indexes) indexes.push(edgeIndex);
    else incidentEdgeIndexesByNodeId.set(nodeId, [edgeIndex]);
  };

  edges.forEach((edge, edgeIndex) => {
    addIncidentIndex(edge.source, edgeIndex);
    if (edge.target !== edge.source) addIncidentIndex(edge.target, edgeIndex);
  });

  const projection = { layeredEdges, incidentEdgeIndexesByNodeId };
  edgeProjectionCache.set(edges, projection);
  return projection;
}

export function projectSelectedCanvasEdges(
  projection: CanvasEdgeProjection,
  selectedNodeIds: readonly string[],
  smoothLine: boolean,
): Edge[] {
  if (selectedNodeIds.length === 0) return projection.layeredEdges;

  const selectedEdgeIndexes = new Set<number>();
  for (const nodeId of selectedNodeIds) {
    for (const edgeIndex of projection.incidentEdgeIndexesByNodeId.get(nodeId) ?? []) {
      selectedEdgeIndexes.add(edgeIndex);
    }
  }
  if (selectedEdgeIndexes.size === 0) return projection.layeredEdges;

  const selectedEdges = [...projection.layeredEdges];
  for (const edgeIndex of selectedEdgeIndexes) {
    const edge = projection.layeredEdges[edgeIndex];
    selectedEdges[edgeIndex] = withCanvasEdgeLayer({
      ...edge,
      type: 'selected-node-flow',
      data: {
        ...edge.data,
        selectedNodeFlowBaseType: edge.type === 'smoothstep' || (!edge.type && smoothLine)
          ? 'smoothstep'
          : 'default',
      },
    });
  }
  return selectedEdges;
}
