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

  return nodes
    .filter((node) => selectedIds.has(node.id) && node.type !== 'group')
    .map((node) => {
      const bounds = getNodeBounds(node, nodes);
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

function applyAbsoluteAxisPositions(
  nodes: RFNode<BaseNodeData>[],
  axis: DistributionAxis,
  absolutePositions: Map<string, number>,
): RFNode<BaseNodeData>[] {
  const isHorizontal = axis === 'horizontal';

  return nodes.map((node) => {
    const absolutePosition = absolutePositions.get(node.id);
    if (absolutePosition === undefined) return node;

    const parentOffset = getParentOffset(node, nodes);
    return {
      ...node,
      position: {
        ...node.position,
        ...(isHorizontal
          ? { x: absolutePosition - parentOffset.x }
          : { y: absolutePosition - parentOffset.y }),
      },
    };
  });
}

/** 按节点边缘而非中心点平均分布，保证不同尺寸的节点也拥有相同间距。 */
export function distributeNodesWithEqualGap(
  nodes: RFNode<BaseNodeData>[],
  selectedNodeIds: string[],
  axis: DistributionAxis,
  requestedGap?: number,
): RFNode<BaseNodeData>[] {
  const items = getDistributionItems(nodes, selectedNodeIds, axis);
  if (items.length < 3) return nodes;

  // 纵向项目不按 Y 排序，因此单独读取原始 Y 边界以保持原有占用范围。
  const extentStart = axis === 'horizontal'
    ? items[0].start
    : Math.min(...items.map((item) => item.start));
  const extentEnd = axis === 'horizontal'
    ? items[items.length - 1].end
    : Math.max(...items.map((item) => item.end));
  const totalNodeSize = items.reduce((sum, item) => sum + item.size, 0);
  const currentSpan = extentEnd - extentStart;
  const gap = Math.max(
    0,
    requestedGap ?? (currentSpan - totalNodeSize) / (items.length - 1),
  );
  const layoutSize = totalNodeSize + gap * (items.length - 1);
  const layoutCenter = (extentStart + extentEnd) / 2;
  const absolutePositions = new Map<string, number>();
  let cursor = layoutCenter - layoutSize / 2;

  for (const item of items) {
    absolutePositions.set(item.node.id, cursor);
    cursor += item.size + gap;
  }

  return applyAbsoluteAxisPositions(nodes, axis, absolutePositions);
}

/** Shift 拖拽：只移动当前间距两侧的节点，并保持这两个节点的共同中心不变。 */
export function adjustAdjacentNodeGap(
  nodes: RFNode<BaseNodeData>[],
  selectedNodeIds: string[],
  axis: DistributionAxis,
  gapIndex: number,
  requestedGap: number,
): RFNode<BaseNodeData>[] {
  const items = getDistributionItems(nodes, selectedNodeIds, axis);
  const before = items[gapIndex];
  const after = items[gapIndex + 1];
  if (!before || !after) return nodes;

  const currentGap = getItemGap(before, after);
  const gapDelta = Math.max(0, requestedGap) - currentGap;
  const absolutePositions = new Map<string, number>([
    [before.node.id, before.start - gapDelta / 2],
    [after.node.id, after.start + gapDelta / 2],
  ]);

  return applyAbsoluteAxisPositions(nodes, axis, absolutePositions);
}
