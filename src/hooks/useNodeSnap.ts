/**
 * useNodeSnap 节点吸附 Hook — 拖拽节点时自动吸附到其他节点的边缘、中心或等间距位置
 */
import { createContext, useCallback, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { useAppStore } from '../store/useAppStore';

/** 视口外保留的 margin（流坐标），略大于一个节点高度，避免边缘节点被误裁 */
const VIEWPORT_CULL_MARGIN = 400;
const SNAP_THRESHOLD = 8;
const MIN_SPACING_GAP = 2;
const SPACING_GUIDE_OFFSET = 12;

export type SnapLine =
  | {
      kind: 'alignment';
      type: 'horizontal' | 'vertical';
      position: number;
    }
  | {
      kind: 'spacing';
      type: 'horizontal' | 'vertical';
      distance: number;
      crossPosition: number;
      segments: Array<{ start: number; end: number }>;
    };

export interface NodeBounds {
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

type SpacingAxis = 'horizontal' | 'vertical';
type CrossAlignmentMode = 'start' | 'center' | 'end';
type SpacingPlacement = 'before' | 'between' | 'after';

export interface EqualSpacingCandidate {
  axis: SpacingAxis;
  targetStart: number;
  distance: number;
  placement: SpacingPlacement;
  first: NodeBounds;
  second: NodeBounds;
  crossAlignmentModes: CrossAlignmentMode[];
}

export interface EqualSpacingSnap {
  targetStart: number;
  diff: number;
  guide: Extract<SnapLine, { kind: 'spacing' }>;
}

const CROSS_ALIGNMENT_MODES: CrossAlignmentMode[] = ['start', 'center', 'end'];

function getAxisStart(bounds: NodeBounds, axis: SpacingAxis): number {
  return axis === 'horizontal' ? bounds.left : bounds.top;
}

function getAxisEnd(bounds: NodeBounds, axis: SpacingAxis): number {
  return axis === 'horizontal' ? bounds.right : bounds.bottom;
}

function getCrossStart(bounds: NodeBounds, axis: SpacingAxis): number {
  return axis === 'horizontal' ? bounds.top : bounds.left;
}

function getCrossCoordinate(
  bounds: NodeBounds,
  axis: SpacingAxis,
  mode: CrossAlignmentMode,
): number {
  if (axis === 'horizontal') {
    if (mode === 'start') return bounds.top;
    if (mode === 'center') return bounds.centerY;
    return bounds.bottom;
  }
  if (mode === 'start') return bounds.left;
  if (mode === 'center') return bounds.centerX;
  return bounds.right;
}

function getSharedCrossAlignmentModes(
  first: NodeBounds,
  second: NodeBounds,
  axis: SpacingAxis,
): CrossAlignmentMode[] {
  return CROSS_ALIGNMENT_MODES.filter((mode) => (
    Math.abs(getCrossCoordinate(first, axis, mode) - getCrossCoordinate(second, axis, mode))
      <= SNAP_THRESHOLD
  ));
}

/**
 * 拖拽开始时预计算等间距落点。间距按节点相邻边缘之间的空白计算，
 * 而不是按中心点计算，因此不同尺寸节点也能得到一致的视觉间距。
 */
export function buildEqualSpacingCandidates(
  otherBounds: NodeBounds[],
  draggedSize: number,
  axis: SpacingAxis,
): EqualSpacingCandidate[] {
  const candidates: EqualSpacingCandidate[] = [];
  const adjacentPairs = new Map<string, [NodeBounds, NodeBounds]>();

  for (let i = 0; i < otherBounds.length; i += 1) {
    const first = otherBounds[i];
    for (const mode of CROSS_ALIGNMENT_MODES) {
      let nearestIndex = -1;
      let nearestStart = Infinity;

      for (let j = 0; j < otherBounds.length; j += 1) {
        if (i === j) continue;
        const second = otherBounds[j];
        const secondStart = getAxisStart(second, axis);
        const gap = secondStart - getAxisEnd(first, axis);
        if (gap < MIN_SPACING_GAP || secondStart >= nearestStart) continue;
        if (Math.abs(getCrossCoordinate(first, axis, mode) - getCrossCoordinate(second, axis, mode))
          > SNAP_THRESHOLD) continue;

        nearestIndex = j;
        nearestStart = secondStart;
      }

      if (nearestIndex >= 0) {
        adjacentPairs.set(`${i}:${nearestIndex}`, [first, otherBounds[nearestIndex]]);
      }
    }
  }

  for (const [first, second] of adjacentPairs.values()) {
    const crossAlignmentModes = getSharedCrossAlignmentModes(first, second, axis);
    const availableGap = getAxisStart(second, axis) - getAxisEnd(first, axis);

    candidates.push({
      axis,
      targetStart: getAxisStart(first, axis) - availableGap - draggedSize,
      distance: availableGap,
      placement: 'before',
      first,
      second,
      crossAlignmentModes,
    });
    candidates.push({
      axis,
      targetStart: getAxisEnd(second, axis) + availableGap,
      distance: availableGap,
      placement: 'after',
      first,
      second,
      crossAlignmentModes,
    });

    const equalInnerGap = (availableGap - draggedSize) / 2;
    if (equalInnerGap >= MIN_SPACING_GAP) {
      candidates.push({
        axis,
        targetStart: getAxisEnd(first, axis) + equalInnerGap,
        distance: equalInnerGap,
        placement: 'between',
        first,
        second,
        crossAlignmentModes,
      });
    }
  }

  return candidates;
}

function moveBoundsToAxisStart(
  bounds: NodeBounds,
  axis: SpacingAxis,
  targetStart: number,
): NodeBounds {
  const delta = targetStart - getAxisStart(bounds, axis);
  if (axis === 'horizontal') {
    return {
      ...bounds,
      x: bounds.x + delta,
      left: bounds.left + delta,
      centerX: bounds.centerX + delta,
      right: bounds.right + delta,
    };
  }
  return {
    ...bounds,
    y: bounds.y + delta,
    top: bounds.top + delta,
    centerY: bounds.centerY + delta,
    bottom: bounds.bottom + delta,
  };
}

function createSpacingGuide(
  candidate: EqualSpacingCandidate,
  draggedBounds: NodeBounds,
): Extract<SnapLine, { kind: 'spacing' }> {
  const snappedBounds = moveBoundsToAxisStart(
    draggedBounds,
    candidate.axis,
    candidate.targetStart,
  );
  const { first, second } = candidate;
  let segments: Array<{ start: number; end: number }>;

  if (candidate.placement === 'before') {
    segments = [
      { start: getAxisEnd(snappedBounds, candidate.axis), end: getAxisStart(first, candidate.axis) },
      { start: getAxisEnd(first, candidate.axis), end: getAxisStart(second, candidate.axis) },
    ];
  } else if (candidate.placement === 'between') {
    segments = [
      { start: getAxisEnd(first, candidate.axis), end: getAxisStart(snappedBounds, candidate.axis) },
      { start: getAxisEnd(snappedBounds, candidate.axis), end: getAxisStart(second, candidate.axis) },
    ];
  } else {
    segments = [
      { start: getAxisEnd(first, candidate.axis), end: getAxisStart(second, candidate.axis) },
      { start: getAxisEnd(second, candidate.axis), end: getAxisStart(snappedBounds, candidate.axis) },
    ];
  }

  return {
    kind: 'spacing',
    type: candidate.axis,
    distance: candidate.distance,
    crossPosition: Math.min(
      getCrossStart(first, candidate.axis),
      getCrossStart(second, candidate.axis),
      getCrossStart(snappedBounds, candidate.axis),
    ) - SPACING_GUIDE_OFFSET,
    segments,
  };
}

export function findBestEqualSpacingSnap(
  draggedBounds: NodeBounds,
  candidates: EqualSpacingCandidate[],
  axis: SpacingAxis,
): EqualSpacingSnap | null {
  const draggedStart = getAxisStart(draggedBounds, axis);
  let best: EqualSpacingSnap | null = null;

  for (const candidate of candidates) {
    const diff = Math.abs(draggedStart - candidate.targetStart);
    if (diff > SNAP_THRESHOLD || (best && diff >= best.diff)) continue;

    const crossAligned = candidate.crossAlignmentModes.some((mode) => {
      const draggedCross = getCrossCoordinate(draggedBounds, axis, mode);
      return Math.abs(draggedCross - getCrossCoordinate(candidate.first, axis, mode)) <= SNAP_THRESHOLD
        && Math.abs(draggedCross - getCrossCoordinate(candidate.second, axis, mode)) <= SNAP_THRESHOLD;
    });
    if (!crossAligned) continue;

    best = {
      targetStart: candidate.targetStart,
      diff,
      guide: createSpacingGuide(candidate, draggedBounds),
    };
  }

  return best;
}

function findBestSnap(
  draggedPoints: number[],
  otherPoints: number[]
): SnapPoint | null {
  let best: SnapPoint | null = null;
  for (const dp of draggedPoints) {
    for (const op of otherPoints) {
      const diff = Math.abs(dp - op);
      if (diff <= SNAP_THRESHOLD) {
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
    horizontalSpacingCandidates: EqualSpacingCandidate[];
    verticalSpacingCandidates: EqualSpacingCandidate[];
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
      const otherBounds: NodeBounds[] = [];
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
        otherBounds.push(b);
      }
      return { nodeMap, otherXEdges, otherXCenters, otherYEdges, otherYCenters, otherBounds };
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
      dragCtx.current = draggedBounds ? {
        ...candidates,
        draggedBounds,
        horizontalSpacingCandidates: buildEqualSpacingCandidates(
          candidates.otherBounds,
          draggedBounds.width,
          'horizontal',
        ),
        verticalSpacingCandidates: buildEqualSpacingCandidates(
          candidates.otherBounds,
          draggedBounds.height,
          'vertical',
        ),
      } : null;
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
      const {
        nodeMap,
        draggedBounds: startDraggedBounds,
        otherXEdges,
        otherXCenters,
        otherYEdges,
        otherYCenters,
        horizontalSpacingCandidates,
        verticalSpacingCandidates,
      } = ctx;
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

      const lines: SnapLine[] = [];
      let correctionX = 0;
      let correctionY = 0;

      // Find best horizontal snap (Y axis alignment) —— 边吸边、中线吸中线
      const bestYSnap = pickCloser(
        findBestSnap([draggedBounds.top, draggedBounds.bottom], otherYEdges),
        findBestSnap([draggedBounds.centerY], otherYCenters),
      );
      const bestVerticalSpacing = findBestEqualSpacingSnap(
        draggedBounds,
        verticalSpacingCandidates,
        'vertical',
      );
      if (bestVerticalSpacing && (!bestYSnap || bestVerticalSpacing.diff <= bestYSnap.diff)) {
        correctionY = bestVerticalSpacing.targetStart - draggedBounds.top;
        lines.push(bestVerticalSpacing.guide);
      } else if (bestYSnap) {
        correctionY = bestYSnap.targetValue - bestYSnap.value;
        lines.push({ kind: 'alignment', type: 'horizontal', position: bestYSnap.targetValue });
      }

      // Find best vertical snap (X axis alignment) —— 边吸边、中线吸中线
      const bestXSnap = pickCloser(
        findBestSnap([draggedBounds.left, draggedBounds.right], otherXEdges),
        findBestSnap([draggedBounds.centerX], otherXCenters),
      );
      const bestHorizontalSpacing = findBestEqualSpacingSnap(
        draggedBounds,
        horizontalSpacingCandidates,
        'horizontal',
      );
      if (bestHorizontalSpacing && (!bestXSnap || bestHorizontalSpacing.diff <= bestXSnap.diff)) {
        correctionX = bestHorizontalSpacing.targetStart - draggedBounds.left;
        lines.push(bestHorizontalSpacing.guide);
      } else if (bestXSnap) {
        correctionX = bestXSnap.targetValue - bestXSnap.value;
        lines.push({ kind: 'alignment', type: 'vertical', position: bestXSnap.targetValue });
      }

      setSnapLines(lines);

      // 把选区吸附修正量加回主节点；Canvas 会把同一修正量应用到其它选中节点。
      return {
        x: proposedPosition.x + correctionX,
        y: proposedPosition.y + correctionY,
      };
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
        lines.push({ kind: 'alignment', type: 'vertical', position: bestX.targetValue });
      }
      const bestY = findBestSnap([top + height], otherY);
      if (bestY) {
        snappedHeight = bestY.targetValue - top;
        lines.push({ kind: 'alignment', type: 'horizontal', position: bestY.targetValue });
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
