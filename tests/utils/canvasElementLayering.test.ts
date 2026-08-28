import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  CANVAS_EDGE_Z_INDEX,
  CANVAS_NODE_Z_INDEX,
  SELECTED_CANVAS_NODE_Z_INDEX_OFFSET,
  withCanvasEdgeLayer,
  withCanvasNodeLayer,
} from '../../src/utils/canvasElementLayering';

describe('canvas element layering', () => {
  it('keeps every node above the edge layer', () => {
    const node = withCanvasNodeLayer({ id: 'node-1', position: { x: 0, y: 0 }, data: {} } as Node);
    const edge = withCanvasEdgeLayer({ id: 'edge-1', source: 'node-1', target: 'node-2' } as Edge);

    expect(node.zIndex).toBe(CANVAS_NODE_Z_INDEX);
    expect(edge.zIndex).toBe(CANVAS_EDGE_Z_INDEX);
    expect(node.zIndex).toBeGreaterThan(edge.zIndex ?? 0);
  });

  it('preserves relative node z-index while keeping the node layer offset', () => {
    const node = withCanvasNodeLayer({
      id: 'node-1',
      position: { x: 0, y: 0 },
      data: {},
      zIndex: 4,
    } as Node);

    expect(node.zIndex).toBe(5);
  });

  it('continues to elevate selected nodes above other nodes', () => {
    const node = withCanvasNodeLayer({
      id: 'node-1',
      position: { x: 0, y: 0 },
      data: {},
      selected: true,
    } as Node);

    expect(node.zIndex).toBe(CANVAS_NODE_Z_INDEX + SELECTED_CANVAS_NODE_Z_INDEX_OFFSET);
  });

  it('overrides persisted edge z-index values in render state only', () => {
    const edge = { id: 'edge-1', source: 'node-1', target: 'node-2', zIndex: 999 } as Edge;
    const layered = withCanvasEdgeLayer(edge);

    expect(layered.zIndex).toBe(CANVAS_EDGE_Z_INDEX);
    expect(edge.zIndex).toBe(999);
  });
});
