import { describe, expect, it } from 'vitest';
import type { Edge, Node, NodeChange } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { createCanvasNoteData } from '../../src/types/canvasNote';
import { resolveCanvasMentionNodes } from '../../src/components/nodes/shared/mentionEditorSources';
import {
  createCanvasEdgeProjection,
  createCanvasNodeProjectionCache,
  getCanvasNodeById,
  hydrateCanvasNodeChanges,
  hydrateCanvasNodeData,
  projectCanvasNodesForReactFlow,
  projectSelectedCanvasEdges,
  projectTransientCanvasNode,
  syncCanvasNodeIndex,
} from '../../src/utils/canvasRenderProjection';

function makeNode(
  id: string,
  overrides: Partial<Node<BaseNodeData>> = {},
): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-image',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: 'ai-image',
      displayId: 1,
      imageUrl: `data:image/png;base64,${'A'.repeat(4_096)}`,
      output: '不应进入 React Flow 的重数据',
    },
    ...overrides,
  };
}

describe('canvas render projection', () => {
  it('keeps full Store data while React Flow receives a lightweight data shell', () => {
    const source = makeNode('far-node', { position: { x: 1_000_000, y: 1_000_000 } });
    const projected = projectCanvasNodesForReactFlow(
      [source],
      createCanvasNodeProjectionCache(),
    )[0];

    expect(projected).not.toBe(source);
    expect(projected.position).toBe(source.position);
    expect(projected.data).toMatchObject({
      label: 'far-node',
      type: 'ai-image',
      displayId: 1,
    });
    expect(projected.data).not.toHaveProperty('imageUrl');
    expect(projected.data).not.toHaveProperty('output');
    expect(source.data.imageUrl).toContain('data:image/png;base64,');
    expect(getCanvasNodeById([source], source.id)?.data).toBe(source.data);

    syncCanvasNodeIndex([]);
    expect(getCanvasNodeById([], source.id)).toBeUndefined();
  });

  it('reuses unchanged geometry projections and hydrates the latest full data by id', () => {
    const cache = createCanvasNodeProjectionCache();
    const source = makeNode('node-a');
    const sibling = makeNode('node-b', { position: { x: 400, y: 0 } });
    const first = projectCanvasNodesForReactFlow([source, sibling], cache);
    const updatedSource = {
      ...source,
      data: {
        ...source.data,
        imageUrl: 'asset://localhost/new-image.png',
        status: 'success' as const,
      },
    };
    const second = projectCanvasNodesForReactFlow([updatedSource, sibling], cache);

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(hydrateCanvasNodeData(second[0], [updatedSource, sibling]).data).toBe(updatedSource.data);

    const movedSource = { ...updatedSource, position: { x: 120, y: 80 } };
    const third = projectCanvasNodesForReactFlow([movedSource, sibling], cache);
    expect(third[0]).not.toBe(second[0]);
    expect(third[0].position).toEqual({ x: 120, y: 80 });
    expect(third[1]).toBe(second[1]);
  });

  it('restores full Store data before a React Flow replace change is applied', () => {
    const source = makeNode('replace-source');
    const projected = projectCanvasNodesForReactFlow(
      [source],
      createCanvasNodeProjectionCache(),
    )[0];
    const changes: NodeChange<Node<BaseNodeData>>[] = [{
      id: source.id,
      type: 'replace',
      item: projected,
    }];
    const hydrated = hydrateCanvasNodeChanges(changes, [source]);

    expect(hydrated).not.toBe(changes);
    expect(hydrated[0]).toMatchObject({ id: source.id, type: 'replace' });
    if (hydrated[0].type !== 'replace') throw new Error('replace change expected');
    expect(hydrated[0].item.data).toBe(source.data);
  });

  it('does not reuse a projection when optional top-level field names change', () => {
    const cache = createCanvasNodeProjectionCache();
    const source = makeNode('optional-fields', { draggable: undefined });
    const first = projectCanvasNodesForReactFlow([source], cache);
    const updated = { ...source, selectable: undefined };
    delete updated.draggable;
    const second = projectCanvasNodesForReactFlow([updated], cache);

    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(Object.prototype.hasOwnProperty.call(second[0], 'draggable')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(second[0], 'selectable')).toBe(true);
  });

  it('keeps a 5000-node projection stable for a single heavy-data update', () => {
    const sharedImage = `data:image/png;base64,${'A'.repeat(4_096)}`;
    const nodes = Array.from({ length: 5_000 }, (_, index): Node<BaseNodeData> => ({
      id: `node-${index}`,
      type: 'ai-image',
      position: { x: (index % 100) * 320, y: Math.floor(index / 100) * 220 },
      data: {
        label: `节点${index}`,
        type: 'ai-image',
        imageUrl: sharedImage,
      },
    }));
    const cache = createCanvasNodeProjectionCache();
    const first = projectCanvasNodesForReactFlow(nodes, cache);
    const dataUpdated = [...nodes];
    dataUpdated[2_500] = {
      ...dataUpdated[2_500],
      data: { ...dataUpdated[2_500].data, status: 'success', mediaVersion: 2 },
    };
    const second = projectCanvasNodesForReactFlow(dataUpdated, cache);

    expect(second).toBe(first);
    expect(second.every((node, index) => node === first[index])).toBe(true);

    const positionUpdated = [...dataUpdated];
    positionUpdated[2_500] = {
      ...positionUpdated[2_500],
      position: { x: 999, y: 888 },
    };
    const third = projectCanvasNodesForReactFlow(positionUpdated, cache);
    expect(third).not.toBe(second);
    expect(third.filter((node, index) => node !== second[index])).toHaveLength(1);
    expect(third[2_500].position).toEqual({ x: 999, y: 888 });
  });

  it('preserves canvas-note hit testing and keeps transient draft data intact', () => {
    const note = makeNode('note', {
      type: 'canvas-note',
      style: { opacity: 0.8 },
      data: {
        label: '笔记',
        type: 'canvas-note',
        note: createCanvasNoteData('text', { text: '草稿内容' }),
      },
    });
    const projected = projectCanvasNodesForReactFlow(
      [note],
      createCanvasNodeProjectionCache(),
    )[0];
    const transient = projectTransientCanvasNode(note);

    expect(projected.style).toMatchObject({ opacity: 0.8, pointerEvents: 'none' });
    expect(projected.data).not.toHaveProperty('note');
    expect(transient.style).toMatchObject({ opacity: 0.8, pointerEvents: 'none' });
    expect(transient.data).toBe(note.data);
    expect(note.style).toEqual({ opacity: 0.8 });
  });

  it('indexes incident edges and only replaces edges related to selected nodes', () => {
    const edges: Edge[] = [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c', type: 'smoothstep' },
      { id: 'dd', source: 'd', target: 'd' },
      { id: 'ef', source: 'e', target: 'f' },
    ];
    const projection = createCanvasEdgeProjection(edges);

    expect(createCanvasEdgeProjection(edges)).toBe(projection);
    expect(projection.incidentEdgeIndexesByNodeId.get('d')).toEqual([2]);
    expect(projectSelectedCanvasEdges(projection, [], false)).toBe(projection.layeredEdges);

    const selected = projectSelectedCanvasEdges(projection, ['b', 'd'], false);
    expect(selected[0]).not.toBe(projection.layeredEdges[0]);
    expect(selected[1]).not.toBe(projection.layeredEdges[1]);
    expect(selected[2]).not.toBe(projection.layeredEdges[2]);
    expect(selected[3]).toBe(projection.layeredEdges[3]);
    expect(selected[0].type).toBe('selected-node-flow');
    expect(selected[1].data?.selectedNodeFlowBaseType).toBe('smoothstep');
    expect(selected[2].data?.selectedNodeFlowBaseType).toBe('default');
    expect(edges.every((edge) => edge.type !== 'selected-node-flow')).toBe(true);
  });

  it('keeps a far connected node available to @ through the full Store graph', () => {
    const source = makeNode('far-source', {
      position: { x: 1_000_000, y: 1_000_000 },
      data: {
        label: '远处参考图',
        type: 'ai-image',
        imageUrl: 'asset://localhost/reference.png',
      },
    });
    const target = makeNode('target', {
      type: 'ai-video',
      data: { label: '视频生成', type: 'ai-video' },
    });
    const edges: Edge[] = [{ id: 'far-to-target', source: source.id, target: target.id }];
    const projected = projectCanvasNodesForReactFlow(
      [source, target],
      createCanvasNodeProjectionCache(),
    );

    expect(projected[0].data).not.toHaveProperty('imageUrl');
    expect(resolveCanvasMentionNodes(target.id, [source, target], edges)).toEqual([
      expect.objectContaining({ id: source.id, label: '远处参考图', outputType: 'image' }),
    ]);
  });
});
