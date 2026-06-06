/**
 * nodeBounds — 节点包围盒计算工具，供对齐/吸附等功能复用
 */
import type { Node as RFNode } from '@xyflow/react';
import type { BaseNodeData } from '../types';

function getDefaultNodeSize(nodeType: string | undefined): { width: number; height: number } {
  switch (nodeType) {
    case 'ai-text':   return { width: 280, height: 160 };
    case 'ai-image':  return { width: 280, height: 158 };
    case 'ai-video':  return { width: 280, height: 160 };
    case 'ai-audio':  return { width: 260, height: 140 };
    default:          return { width: 280, height: 160 };
  }
}

/** Follow parentId chain to compute absolute offset from relative position */
export function getParentOffset(
  node: RFNode<BaseNodeData>,
  allNodes: RFNode<BaseNodeData>[],
): { x: number; y: number } {
  let offsetX = 0;
  let offsetY = 0;
  let pid: string | undefined = node.parentId;
  while (pid) {
    const p = allNodes.find((n) => n.id === pid);
    if (!p) break;
    offsetX += p.position.x;
    offsetY += p.position.y;
    pid = p.parentId;
  }
  return { x: offsetX, y: offsetY };
}

/** Get absolute bounds for a node (accounting for parent group offsets) */
export function getNodeBounds(
  node: RFNode<BaseNodeData>,
  allNodes: RFNode<BaseNodeData>[],
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
  const parentOffset = node.parentId ? getParentOffset(node, allNodes) : { x: 0, y: 0 };
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
