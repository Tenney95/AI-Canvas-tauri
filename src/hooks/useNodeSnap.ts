import { useCallback, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';

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

function getNodeBounds(node: Node<BaseNodeData>): {
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
  const x = node.position.x;
  const y = node.position.y;
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

export function useNodeSnap(
  nodes: Node<BaseNodeData>[],
  setNodes: (nodes: Node<BaseNodeData>[]) => void
) {
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const dragStartPositions = useRef<Map<string, { x: number; y: number }>>(new Map());

  const clearSnapLines = useCallback(() => {
    setSnapLines([]);
  }, []);

  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent | MouseEvent, node: Node<BaseNodeData>) => {
      dragStartPositions.current.set(node.id, { ...node.position });
    },
    []
  );

  const onNodeDrag = useCallback(
    (_evt: React.MouseEvent | MouseEvent, node: Node<BaseNodeData>) => {
      const draggedBounds = getNodeBounds(node);
      const otherNodes = nodes.filter((n) => n.id !== node.id && n.selected !== true);

      const snapResult: SnapResult = {
        snapX: null,
        snapY: null,
        lines: [],
      };

      // Collect all snap points from other nodes
      const otherXPoints: number[] = [];
      const otherYPoints: number[] = [];
      for (const other of otherNodes) {
        const b = getNodeBounds(other);
        otherXPoints.push(b.left, b.centerX, b.right);
        otherYPoints.push(b.top, b.centerY, b.bottom);
      }

      // Find best horizontal snap (Y axis alignment)
      const draggedYPoints = [draggedBounds.top, draggedBounds.centerY, draggedBounds.bottom];
      const bestYSnap = findBestSnap(draggedYPoints, otherYPoints);
      if (bestYSnap) {
        snapResult.snapY = bestYSnap.targetValue;
        // Determine which dragged edge is snapping to show correct line
        const snappedEdgeY = bestYSnap.value;
        if (Math.abs(snappedEdgeY - draggedBounds.top) < 0.5) {
          snapResult.lines.push({ type: 'horizontal', position: draggedBounds.top });
        } else if (Math.abs(snappedEdgeY - draggedBounds.centerY) < 0.5) {
          snapResult.lines.push({ type: 'horizontal', position: draggedBounds.centerY });
        } else {
          snapResult.lines.push({ type: 'horizontal', position: draggedBounds.bottom });
        }
      }

      // Find best vertical snap (X axis alignment)
      const draggedXPoints = [draggedBounds.left, draggedBounds.centerX, draggedBounds.right];
      const bestXSnap = findBestSnap(draggedXPoints, otherXPoints);
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

      // Apply snap by updating node position
      if (snapResult.snapX !== null || snapResult.snapY !== null) {
        let newX = node.position.x;
        let newY = node.position.y;

        if (snapResult.snapY !== null) {
          const snappedEdgeY = bestYSnap!.value;
          const edgeOffset = snappedEdgeY - draggedBounds.y;
          newY = snapResult.snapY - edgeOffset;
        }

        if (snapResult.snapX !== null) {
          const snappedEdgeX = bestXSnap!.value;
          const edgeOffset = snappedEdgeX - draggedBounds.x;
          newX = snapResult.snapX - edgeOffset;
        }

        setNodes(
          nodes.map((n) =>
            n.id === node.id ? { ...n, position: { x: newX, y: newY } } : n
          )
        );
      }
    },
    [nodes, setNodes]
  );

  const onNodeDragStop = useCallback(() => {
    dragStartPositions.current.clear();
    setSnapLines([]);
  }, []);

  return {
    snapLines,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    clearSnapLines,
  };
}
