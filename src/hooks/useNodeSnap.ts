/**
 * useNodeSnap 节点对齐吸附 Hook — 拖拽节点时自动吸附对齐到其他节点的边缘/中心，绘制辅助线
 */
import { useCallback, useRef, useState } from 'react';
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
): {
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
} {
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

export function useNodeSnap(
  nodes: Node<BaseNodeData>[],
) {
  const { screenToFlowPosition } = useReactFlow();
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const dragStartPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  // 拖拽期间不变的数据：节点 Map（父链查找）+ 其他节点的吸附点（预计算一次）
  // 边缘点与中线点分开存放，避免「边↔中」交叉对齐（边只吸边、中线只吸中线）
  const dragCtx = useRef<{
    nodeMap: Map<string, Node<BaseNodeData>>;
    otherXEdges: number[];
    otherXCenters: number[];
    otherYEdges: number[];
    otherYCenters: number[];
  } | null>(null);

  const clearSnapLines = useCallback(() => {
    setSnapLines([]);
  }, []);

  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent | MouseEvent, node: Node<BaseNodeData>) => {
      dragStartPositions.current.set(node.id, { ...node.position });

      // 预计算：节点 Map + 静止节点的吸附点（拖拽过程中这些节点不移动）
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
        if (other.id === node.id || other.selected === true) continue;
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
      dragCtx.current = { nodeMap, otherXEdges, otherXCenters, otherYEdges, otherYCenters };
    },
    [nodes, screenToFlowPosition]
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
      const { nodeMap, otherXEdges, otherXCenters, otherYEdges, otherYCenters } = ctx;
      const baseNode = nodeMap.get(nodeId);
      if (!baseNode) return proposedPosition;

      // 用候选位置构造被拖节点的包围盒（parentId/type/data 取自起拖快照）
      const node = { ...baseNode, position: proposedPosition };
      const draggedBounds = getNodeBounds(node, nodeMap);
      const parentOffset = node.parentId ? getParentOffset(node, nodeMap) : { x: 0, y: 0 };

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
          snapResult.lines.push({ type: 'horizontal', position: draggedBounds.top });
        } else if (Math.abs(snappedEdgeY - draggedBounds.centerY) < 0.5) {
          snapResult.lines.push({ type: 'horizontal', position: draggedBounds.centerY });
        } else {
          snapResult.lines.push({ type: 'horizontal', position: draggedBounds.bottom });
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
          snapResult.lines.push({ type: 'vertical', position: draggedBounds.left });
        } else if (Math.abs(snappedEdgeX - draggedBounds.centerX) < 0.5) {
          snapResult.lines.push({ type: 'vertical', position: draggedBounds.centerX });
        } else {
          snapResult.lines.push({ type: 'vertical', position: draggedBounds.right });
        }
      }

      setSnapLines(snapResult.lines);

      // 将吸附后的绝对坐标换算回相对坐标（减去父级偏移）
      let newX = proposedPosition.x;
      let newY = proposedPosition.y;
      if (snapResult.snapY !== null) {
        const edgeOffset = bestYSnap!.value - draggedBounds.y;
        newY = snapResult.snapY - edgeOffset - parentOffset.y;
      }
      if (snapResult.snapX !== null) {
        const edgeOffset = bestXSnap!.value - draggedBounds.x;
        newX = snapResult.snapX - edgeOffset - parentOffset.x;
      }
      return { x: newX, y: newY };
    },
    []
  );

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
  };
}
