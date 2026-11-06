/**
 * 计算多选节点的几何边界、相邻间距和平均分布位置，不直接写入画布 Store。
 */
import type { Node as RFNode } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { getNodeBounds, getParentOffset } from './nodeBounds.js';

export type DistributionAxis = 'horizontal' | 'vertical';

export interface DistributionItem {
  node: RFNode<BaseNodeData>;
  start: number;
  end: number;
  size: number;
  center: number;
  crossStart: number;
  crossEnd: number;
}

export function getDistributionItems(
  nodes: RFNode<BaseNodeData>[],
  selectedNodeIds: string[],
  axis: DistributionAxis,
): DistributionItem[] {
  const selectedIds = new Set(selectedNodeIds);
  const isHorizontal = axis === 'horizontal';
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  return nodes
    .filter((node) => selectedIds.has(node.id) && node.type !== 'group')
    .map((node) => {
      const bounds = getNodeBounds(node, nodeMap);
      return {
        node,
        start: isHorizontal ? bounds.left : bounds.top,
        end: isHorizontal ? bounds.right : bounds.bottom,
        size: isHorizontal ? bounds.width : bounds.height,
        center: isHorizontal ? bounds.centerX : bounds.centerY,
        crossStart: isHorizontal ? bounds.top : bounds.left,
        crossEnd: isHorizontal ? bounds.bottom : bounds.right,
      };
    })
    .sort((a, b) => {
      if (isHorizontal) return a.center - b.center;

      // 纵向分布的上下顺序由节点原本的左右顺序决定。
      const aCrossCenter = (a.crossStart + a.crossEnd) / 2;
      const bCrossCenter = (b.crossStart + b.crossEnd) / 2;
      return aCrossCenter - bCrossCenter || a.center - b.center;
    });
}

export function getItemGap(leftOrTop: DistributionItem, rightOrBottom: DistributionItem): number {
  return rightOrBottom.start - leftOrTop.end;
}

/** 只合并位置，保留当前节点的数据、成员与其它轴坐标。 */
export function applyDistributionPositions(
  nodes: RFNode<BaseNodeData>[],
  axis: DistributionAxis,
  absolutePositions: ReadonlyMap<string, number>,
  nodeMap = new Map(nodes.map((node) => [node.id, node])),
): RFNode<BaseNodeData>[] {
  if (absolutePositions.size === 0) return nodes;
  const coordinate = axis === 'horizontal' ? 'x' : 'y';
  let changed = false;
  const next = nodes.map((node) => {
    const absolutePosition = absolutePositions.get(node.id);
    if (absolutePosition === undefined) return node;
    const position = absolutePosition - getParentOffset(node, nodeMap)[coordinate];
    if (node.position[coordinate] === position) return node;
    changed = true;
    return { ...node, position: { ...node.position, [coordinate]: position } };
  });
  return changed ? next : nodes;
}

/** 起拖时固定排序和几何；连续输入只重算目标位置。 */
export function prepareDistributionLayout(items: DistributionItem[], axis: DistributionAxis) {
  const extentStart = items.length === 0 ? 0 : axis === 'horizontal'
    ? items[0].start : Math.min(...items.map((item) => item.start));
  const extentEnd = items.length === 0 ? 0 : axis === 'horizontal'
    ? items[items.length - 1].end : Math.max(...items.map((item) => item.end));
  const totalNodeSize = items.reduce((sum, item) => sum + item.size, 0);
  const layoutCenter = (extentStart + extentEnd) / 2;
  return {
    equalGap(requestedGap?: number) {
      const positions = new Map<string, number>();
      if (items.length < 3) return positions;
      const gap = Math.max(0, requestedGap ?? (extentEnd - extentStart - totalNodeSize) / (items.length - 1));
      let cursor = layoutCenter - (totalNodeSize + gap * (items.length - 1)) / 2;
      for (const item of items) {
        positions.set(item.node.id, cursor);
        cursor += item.size + gap;
      }
      return positions;
    },
    adjacentGap(gapIndex: number, requestedGap: number) {
      const before = items[gapIndex], after = items[gapIndex + 1];
      if (!before || !after) return new Map<string, number>();
      const delta = Math.max(0, requestedGap) - getItemGap(before, after);
      return new Map([
        [before.node.id, before.start - delta / 2],
        [after.node.id, after.start + delta / 2],
      ]);
    },
  };
}

/** 按节点边缘而非中心点平均分布，保证不同尺寸的节点也拥有相同间距。 */
export function distributeNodesWithEqualGap(
  nodes: RFNode<BaseNodeData>[],
  selectedNodeIds: string[],
  axis: DistributionAxis,
  requestedGap?: number,
): RFNode<BaseNodeData>[] {
  const layout = prepareDistributionLayout(getDistributionItems(nodes, selectedNodeIds, axis), axis);
  return applyDistributionPositions(nodes, axis, layout.equalGap(requestedGap));
}

/** Shift 拖拽：只移动当前间距两侧的节点，并保持这两个节点的共同中心不变。 */
export function adjustAdjacentNodeGap(
  nodes: RFNode<BaseNodeData>[],
  selectedNodeIds: string[],
  axis: DistributionAxis,
  gapIndex: number,
  requestedGap: number,
): RFNode<BaseNodeData>[] {
  const layout = prepareDistributionLayout(getDistributionItems(nodes, selectedNodeIds, axis), axis);
  return applyDistributionPositions(nodes, axis, layout.adjacentGap(gapIndex, requestedGap));
}
