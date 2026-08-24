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

/**
 * 生成前按画面比例预估节点框高度：图片还没出来，只能用比例把固定宽度的卡片撑开。
 * 4px 是卡片边框，min 保证竖排比例下不会矮到看不见标题。
 */
export function nodeHeightForAspectRatio(
  aspectRatio: string,
  nodeWidth = 280,
  min = 160,
): number {
  const [w, h] = aspectRatio.split(':').map(Number);
  const ratio = w && h ? w / h : 1;
  return Math.max(min, Math.round((nodeWidth - 4) / ratio) + 4);
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
