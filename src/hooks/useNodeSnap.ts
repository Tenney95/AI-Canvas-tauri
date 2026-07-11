/**
 * useNodeSnap 节点对齐吸附 Hook — 拖拽节点时自动吸附对齐到其他节点的边缘/中心，绘制辅助线
 */
import { createContext, useCallback, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { useAppStore } from '../store/useAppStore';

/** 视口外保留的 margin（流坐标），略大于一个节点高度，避免边缘节点被误裁 */
const VIEWPORT_CULL_MARGIN = 400;

export interface SnapLine {
  type: 'horizontal' | 'vertical';
  position: number;
}

interface SnapResult {
  snapX: number | null;
  snapY: number | null;
  lines: SnapLine[];
}

interface NodeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  centerX: number;
  right: number;
  top: number;
  centerY: number;
  bottom: number;
}

function getDefaultNodeSize(nodeType: string | undefined): { width: number; height: number } {
  switch (nodeType) {
    case 'ai-text':
      return { width: 280, height: 160 };
    case 'ai-image':
      return { width: 280, height: 158 };
    case 'ai-video':
      return { width: 280, height: 160 };
    case 'ai-audio':
      return { width: 260, height: 140 };
    default:
      return { width: 280, height: 160 };
  }
}

/** Follow parentId chain to compute absolute offset from relative position */
function getParentOffset(
  node: Node<BaseNodeData>,
  nodeMap: Map<string, Node<BaseNodeData>>
): { x: number; y: number } {
  let offsetX = 0;
  let offsetY = 0;
  let pid: string | undefined = node.parentId;
  while (pid) {
    const p = nodeMap.get(pid);
    if (!p) break;
    offsetX += p.position.x;
    offsetY += p.position.y;
    pid = p.parentId;
  }
  return { x: offsetX, y: offsetY };
}

function getNodeBounds(
  node: Node<BaseNodeData>,
  nodeMap: Map<string, Node<BaseNodeData>>
): NodeBounds {
  const defaultSize = getDefaultNodeSize(node.type);
  const cardWidth = (node.data?.nodeWidth as number | undefined) ?? defaultSize.width;
  const cardHeight = (node.data?.nodeHeight as number | undefined) ?? defaultSize.height;
  const parentOffset = node.parentId ? getParentOffset(node, nodeMap) : { x: 0, y: 0 };
  const x = node.position.x + parentOffset.x;
  const y = node.position.y + parentOffset.y;
  return {
    x,
    y,
    width: cardWidth,
    height: cardHeight,
    left: x,
    centerX: x + cardWidth / 2,
    right: x + cardWidth,
    top: y,
    centerY: y + cardHeight / 2,
    bottom: y + cardHeight,
  };
}

function getNodesBounds(
  nodes: Node<BaseNodeData>[],
  nodeMap: Map<string, Node<BaseNodeData>>,
): NodeBounds | null {
  if (nodes.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    const bounds = getNodeBounds(node, nodeMap);
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }

  const width = right - left;
  const height = bottom - top;
  return {
    x: left,
    y: top,
    width,
    height,
    left,
    centerX: left + width / 2,
    right,
    top,
    centerY: top + height / 2,
    bottom,
  };
}

interface SnapPoint {
  value: number;
  targetValue: number;
  diff: number;
}

function findBestSnap(
  draggedPoints: number[],
  otherPoints: number[]
): SnapPoint | null {
  let best: SnapPoint | null = null;
  for (const dp of draggedPoints) {
    for (const op of otherPoints) {
      const diff = Math.abs(dp - op);
      if (diff <= 8) {
        if (!best || diff < best.diff) {
          best = { value: dp, targetValue: op, diff };
        }
      }
    }
  }
  return best;
}

/** 取两个候选中更近的一个 */
function pickCloser(a: SnapPoint | null, b: SnapPoint | null): SnapPoint | null {
  if (!a) return b;
  if (!b) return a;
  return b.diff < a.diff ? b : a;
}

/** 缩放吸附桥接：节点内的 ResizeHandle 通过此 Context 调用 Canvas 持有的吸附逻辑 */
export interface ResizeSnapApi {
  onResizeStart: (nodeId: string) => void;
  applyResizeSnap: (
    nodeId: string,
    width: number,
    height: number
  ) => { width: number; height: number };
  onResizeStop: () => void;
}

export const ResizeSnapContext = createContext<ResizeSnapApi | null>(null);

export function useNodeSnap() {
  const { screenToFlowPosition } = useReactFlow();
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const dragStartPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  // 拖拽期间不变的数据：节点 Map（父链查找）+ 其他节点的吸附点（预计算一次）
  // 边缘点与中线点分开存放，避免「边↔中」交叉对齐（边只吸边、中线只吸中线）
  const dragCtx = useRef<{
    nodeMap: Map<string, Node<BaseNodeData>>;
    draggedBounds: NodeBounds;
    otherXEdges: number[];
    otherXCenters: number[];
    otherYEdges: number[];
    otherYCenters: number[];
  } | null>(null);
  // 缩放期间不变的数据：被缩放节点固定的左/上边，以及其他节点的 X/Y 候选线
  const resizeCtx = useRef<{
    left: number;
    top: number;
    otherX: number[];
    otherY: number[];
  } | null>(null);

  const clearSnapLines = useCallback(() => {
    setSnapLines([]);
  }, []);

  // 预计算静止节点（排除 excludeId 与多选节点）的吸附候选点，做视口裁剪。
  // 拖拽与缩放共用 —— 候选节点在交互过程中均不移动。
  const buildCandidates = useCallback(
    (excludeId: string, draggedNodeIds?: Set<string>) => {
      // 从 store 直读而非闭包捕获 nodes：拖拽期间 nodes 每帧变化，闭包依赖会让
      // 本 hook 的回调每帧换新引用 → Canvas 的 resizeSnapApi Context 每帧刷新 →
      // 所有节点的 ResizeHandle 每帧重渲染。直读后回调恒定，Context 不再抖动。
      const nodes = useAppStore.getState().nodes;
      const nodeMap = new Map(nodes.map((n) => [n.id, n] as const));

      // 视口裁剪：只把当前可见区域（含 margin）内的节点作为吸附候选，
      // 与总节点数解耦 —— 屏幕外的对齐线本来也画不出来
      let cull: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
      const pane = document.querySelector('.react-flow__pane') as HTMLElement | null;
      const rect = pane?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const tl = screenToFlowPosition({ x: rect.left, y: rect.top });
        const br = screenToFlowPosition({ x: rect.right, y: rect.bottom });
        cull = {
          minX: Math.min(tl.x, br.x) - VIEWPORT_CULL_MARGIN,
          minY: Math.min(tl.y, br.y) - VIEWPORT_CULL_MARGIN,
          maxX: Math.max(tl.x, br.x) + VIEWPORT_CULL_MARGIN,
          maxY: Math.max(tl.y, br.y) + VIEWPORT_CULL_MARGIN,
        };
      }

      const otherXEdges: number[] = [];
      const otherXCenters: number[] = [];
      const otherYEdges: number[] = [];
      const otherYCenters: number[] = [];
      for (const other of nodes) {
        if (other.id === excludeId || draggedNodeIds?.has(other.id) || other.selected === true) continue;
        const b = getNodeBounds(other, nodeMap);
        // 与可见区域不相交的节点直接跳过
        if (cull && (b.right < cull.minX || b.left > cull.maxX || b.bottom < cull.minY || b.top > cull.maxY)) {
          continue;
        }
        otherXEdges.push(b.left, b.right);
        otherXCenters.push(b.centerX);
        otherYEdges.push(b.top, b.bottom);
        otherYCenters.push(b.centerY);
      }
      return { nodeMap, otherXEdges, otherXCenters, otherYEdges, otherYCenters };
    },
    [screenToFlowPosition]
  );

  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent | MouseEvent, node: Node<BaseNodeData>) => {
      dragStartPositions.current.set(node.id, { ...node.position });
      const state = useAppStore.getState();
      const selectedIds = new Set(state.selectedNodeIds);
      const draggedNodes = selectedIds.has(node.id)
        ? state.nodes.filter((candidate) => selectedIds.has(candidate.id))
        : [node];
      const draggedNodeIds = new Set(draggedNodes.map((candidate) => candidate.id));
      const candidates = buildCandidates(node.id, draggedNodeIds);
      const draggedBounds = getNodesBounds(draggedNodes, candidates.nodeMap);
      dragCtx.current = draggedBounds ? { ...candidates, draggedBounds } : null;
    },
    [buildCandidates]
  );

  /**
   * 计算吸附后的位置 —— 纯函数式，由 React Flow 的 onNodesChange 管线调用，
   * 直接返回修正后的「相对位置」，让吸附成为 React Flow 自身状态的一部分，
   * 不再二次 setNodes 覆盖（消除漂移/橡皮筋）。
   */
  const applySnap = useCallback(
    (nodeId: string, proposedPosition: { x: number; y: number }): { x: number; y: number } => {
      const ctx = dragCtx.current;
      if (!ctx) return proposedPosition;
      const { nodeMap, draggedBounds: startDraggedBounds, otherXEdges, otherXCenters, otherYEdges, otherYCenters } = ctx;
      const baseNode = nodeMap.get(nodeId);
      if (!baseNode) return proposedPosition;

      // React Flow 对多选节点施加相同位移：用任一位置变更求出位移，
      // 再移动整个起拖选区包围盒，保证吸附时节点间相对位置不变。
      const baseBounds = getNodeBounds(baseNode, nodeMap);
      const proposedNode = { ...baseNode, position: proposedPosition };
      const proposedBounds = getNodeBounds(proposedNode, nodeMap);
      const deltaX = proposedBounds.x - baseBounds.x;
      const deltaY = proposedBounds.y - baseBounds.y;
      const draggedBounds: NodeBounds = {
        ...startDraggedBounds,
        x: startDraggedBounds.x + deltaX,
        y: startDraggedBounds.y + deltaY,
        left: startDraggedBounds.left + deltaX,
        centerX: startDraggedBounds.centerX + deltaX,
        right: startDraggedBounds.right + deltaX,
        top: startDraggedBounds.top + deltaY,
        centerY: startDraggedBounds.centerY + deltaY,
        bottom: startDraggedBounds.bottom + deltaY,
      };

      const snapResult: SnapResult = { snapX: null, snapY: null, lines: [] };

      // Find best horizontal snap (Y axis alignment) —— 边吸边、中线吸中线
      const bestYSnap = pickCloser(
        findBestSnap([draggedBounds.top, draggedBounds.bottom], otherYEdges),
        findBestSnap([draggedBounds.centerY], otherYCenters),
      );
      if (bestYSnap) {
        snapResult.snapY = bestYSnap.targetValue;
        const snappedEdgeY = bestYSnap.value;
        if (Math.abs(snappedEdgeY - draggedBounds.top) < 0.5) {
          snapResult.lines.push({ type: 'horizontal', position: bestYSnap.targetValue });
        } else if (Math.abs(snappedEdgeY - draggedBounds.centerY) < 0.5) {
          snapResult.lines.push({ type: 'horizontal', position: bestYSnap.targetValue });
        } else {
          snapResult.lines.push({ type: 'horizontal', position: bestYSnap.targetValue });
        }
      }

      // Find best vertical snap (X axis alignment) —— 边吸边、中线吸中线
      const bestXSnap = pickCloser(
        findBestSnap([draggedBounds.left, draggedBounds.right], otherXEdges),
        findBestSnap([draggedBounds.centerX], otherXCenters),
      );
      if (bestXSnap) {
        snapResult.snapX = bestXSnap.targetValue;
        const snappedEdgeX = bestXSnap.value;
        if (Math.abs(snappedEdgeX - draggedBounds.left) < 0.5) {
          snapResult.lines.push({ type: 'vertical', position: bestXSnap.targetValue });
        } else if (Math.abs(snappedEdgeX - draggedBounds.centerX) < 0.5) {
          snapResult.lines.push({ type: 'vertical', position: bestXSnap.targetValue });
        } else {
          snapResult.lines.push({ type: 'vertical', position: bestXSnap.targetValue });
        }
      }

      setSnapLines(snapResult.lines);

      // 把选区吸附修正量加回主节点；Canvas 会把同一修正量应用到其它选中节点。
      let newX = proposedPosition.x;
      let newY = proposedPosition.y;
      if (snapResult.snapY !== null) {
        newY += snapResult.snapY - bestYSnap!.value;
      }
      if (snapResult.snapX !== null) {
        newX += snapResult.snapX - bestXSnap!.value;
      }
      return { x: newX, y: newY };
    },
    []
  );

  // ── 缩放吸附 ──
  // 右下角把手缩放：节点左/上边固定，仅右/下边随尺寸移动。
  // 故只对「移动的右边/下边」与其他节点的边/中线做吸附，命中即对齐并画引导线。
  const onResizeStart = useCallback(
    (nodeId: string) => {
      const { nodeMap, otherXEdges, otherXCenters, otherYEdges, otherYCenters } =
        buildCandidates(nodeId);
      const self = nodeMap.get(nodeId);
      if (!self) {
        resizeCtx.current = null;
        return;
      }
      const b = getNodeBounds(self, nodeMap);
      resizeCtx.current = {
        left: b.left,
        top: b.top,
        otherX: [...otherXEdges, ...otherXCenters],
        otherY: [...otherYEdges, ...otherYCenters],
      };
    },
    [buildCandidates]
  );

  const applyResizeSnap = useCallback(
    (_nodeId: string, width: number, height: number): { width: number; height: number } => {
      const ctx = resizeCtx.current;
      if (!ctx) return { width, height };
      const { left, top, otherX, otherY } = ctx;

      const lines: SnapLine[] = [];
      let snappedWidth = width;
      let snappedHeight = height;

      const bestX = findBestSnap([left + width], otherX);
      if (bestX) {
        snappedWidth = bestX.targetValue - left;
        lines.push({ type: 'vertical', position: bestX.targetValue });
      }
      const bestY = findBestSnap([top + height], otherY);
      if (bestY) {
        snappedHeight = bestY.targetValue - top;
        lines.push({ type: 'horizontal', position: bestY.targetValue });
      }

      setSnapLines(lines);
      return { width: snappedWidth, height: snappedHeight };
    },
    []
  );

  const onResizeStop = useCallback(() => {
    setSnapLines([]);
    resizeCtx.current = null;
  }, []);

  const onNodeDragStop = useCallback(() => {
    dragStartPositions.current.clear();
    setSnapLines([]);
    useAppStore.getState().commitToHistory();
    // 延迟清理：松手时 React Flow 还会发一帧 dragging=false 的 position 变更，
    // 需要它仍能命中吸附缓存，否则节点会弹回未吸附的原始落点。
    queueMicrotask(() => {
      dragCtx.current = null;
    });
  }, []);

  return {
    snapLines,
    onNodeDragStart,
    applySnap,
    onNodeDragStop,
    clearSnapLines,
    onResizeStart,
    applyResizeSnap,
    onResizeStop,
  };
}
