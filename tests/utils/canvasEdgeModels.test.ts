import { describe, expect, it, vi } from 'vitest';
import { ConnectionMode, Position, type Edge, type InternalNode, type ReactFlowState } from '@xyflow/react';
import type { CanvasEdgeGeometry, CanvasSharedEdgeModel } from '../../src/types/canvasEdges';
import { createCanvasEdgeModelSelector, createCanvasEdgeSnapshotReader } from '../../src/utils/canvasEdgeModels';

function makeNode(id: string, x = 0): InternalNode {
  const node = { id, position: { x, y: 0 }, data: {}, width: 100, height: 80 };
  return {
    ...node,
    measured: { width: 100, height: 80 },
    internals: {
      userNode: node, positionAbsolute: { x, y: 0 }, z: 0,
      handleBounds: {
        source: [{ id: 'out', nodeId: id, type: 'source', position: Position.Right, x: 100, y: 40, width: 8, height: 8 }],
        target: [{ id: 'in', nodeId: id, type: 'target', position: Position.Left, x: 0, y: 40, width: 8, height: 8 }],
      },
    },
  };
}

function fixture() {
  const nodes = [makeNode('a'), makeNode('b', 300), makeNode('c', 600), makeNode('d', 900)];
  const edges: Edge[] = [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'cd', source: 'c', target: 'd' },
  ];
  const state = {
    nodeLookup: new Map(nodes.map((node) => [node.id, node])),
    edgeLookup: new Map(edges.map((edge) => [edge.id, edge])), edges,
    connectionMode: ConnectionMode.Strict, elementsSelectable: true, edgesFocusable: true,
    elevateEdgesOnSelect: true, zIndexMode: 'basic', transform: [0, 0, 1],
  } as unknown as ReactFlowState;
  const geometry = {
    getEdgePosition: vi.fn<CanvasEdgeGeometry['getEdgePosition']>(({ sourceNode, targetNode }) => {
      if ((!sourceNode.internals.handleBounds && !sourceNode.handles?.length)
        || (!targetNode.internals.handleBounds && !targetNode.handles?.length)) return null;
      return {
        sourceX: sourceNode.internals.positionAbsolute.x,
        sourceY: sourceNode.internals.positionAbsolute.y,
        targetX: targetNode.internals.positionAbsolute.x,
        targetY: targetNode.internals.positionAbsolute.y,
        sourcePosition: Position.Right, targetPosition: Position.Left,
      };
    }),
    getElevatedEdgeZIndex: vi.fn<CanvasEdgeGeometry['getElevatedEdgeZIndex']>(({ zIndex = 0, selected }) => zIndex + (selected ? 100 : 0)),
    getMarkerId: vi.fn<CanvasEdgeGeometry['getMarkerId']>((marker, rfId) => typeof marker === 'string'
      ? marker : `${rfId}:${marker?.type}:${marker?.color ?? ''}`),
  };
  const select = createCanvasEdgeModelSelector();
  const mounted = new Set(['a']);
  const read = (ids: readonly string[] = ['ab', 'cd'], rfId = 'flow') => select(state, ids, geometry, rfId, mounted);
  return { nodes, edges, state, geometry, mounted, read };
}

describe('canvas edge model selector', () => {
  it('does not read any of 502 edge bodies across 100 transform-only publications', () => {
    const { state, geometry, mounted } = fixture();
    const getter = vi.fn(() => 'label');
    const edges: Edge[] = Array.from({ length: 502 }, (_, index) => {
      const edge: Edge = { id: `edge-${index}`, source: 'a', target: 'b' };
      Object.defineProperty(edge, 'label', { enumerable: true, get: getter });
      return edge;
    });
    state.edges = edges;
    state.edgeLookup = new Map(edges.map((edge) => [edge.id, edge]));
    const ids = edges.map((edge) => edge.id);
    const select = createCanvasEdgeModelSelector();
    const first = select(state, ids, geometry, 'flow', mounted);
    getter.mockClear();
    geometry.getEdgePosition.mockClear();
    geometry.getElevatedEdgeZIndex.mockClear();
    let published = state;
    for (let index = 0; index < 100; index += 1) {
      published = { ...published, transform: [index, -index, 0.2 + index / 100] };
      expect(select(published, ids, geometry, 'flow', mounted)).toBe(first);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(geometry.getEdgePosition).not.toHaveBeenCalled();
    expect(geometry.getElevatedEdgeZIndex).not.toHaveBeenCalled();
  });

  it('inspects edge values on non-viewport publications and captures previous scalar fields', () => {
    const { state, edges, geometry, mounted } = fixture();
    const getter = vi.fn(() => 'label');
    Object.defineProperty(edges[0], 'label', { enumerable: true, get: getter });
    const ids = ['ab', 'cd'];
    const select = createCanvasEdgeModelSelector();
    const first = select(state, ids, geometry, 'flow', mounted);
    getter.mockClear();
    edges[0].selected = true;
    const selectedState = { ...state };
    const selected = select(selectedState, ids, geometry, 'flow', mounted);
    expect(selected).not.toBe(first);
    expect(selected[0]).toMatchObject({ props: { selected: true } });
    expect(getter).toHaveBeenCalled();

    getter.mockClear();
    selectedState.elementsSelectable = false;
    const next = select({ ...selectedState, transform: [20, 0, 1] }, ids, geometry, 'flow', mounted);
    expect(next[0]).toMatchObject({ selectable: false });
    expect(getter).toHaveBeenCalled();
  });

  it('does not fast return after in-place node geometry/elevation changes with a new transform', () => {
    const { state, nodes, geometry, mounted } = fixture();
    const ids = ['ab', 'cd'];
    const select = createCanvasEdgeModelSelector();
    const first = select(state, ids, geometry, 'flow', mounted);
    geometry.getEdgePosition.mockClear();
    nodes[0].internals.positionAbsolute.x = 45;
    let published = { ...state, transform: [20, 0, 1] as [number, number, number] };
    const moved = select(published, ids, geometry, 'flow', mounted);
    expect(moved[0]).not.toBe(first[0]);
    expect(moved[1]).toBe(first[1]);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(1);
    expect((moved[0] as CanvasSharedEdgeModel).props.sourceX).toBe(45);
    geometry.getElevatedEdgeZIndex.mockClear();
    nodes[0].internals.z = 20;
    nodes[0].selected = true;
    published = { ...published, transform: [30, 0, 1] };
    select(published, ids, geometry, 'flow', mounted);
    expect(geometry.getElevatedEdgeZIndex).toHaveBeenCalledTimes(1);
  });

  it('invalidates viewport shortcut when edge/default references or reader inputs change', () => {
    const { state, edges, geometry, mounted } = fixture();
    const getter = vi.fn(() => 'label');
    Object.defineProperty(edges[0], 'label', { enumerable: true, get: getter });
    const select = createCanvasEdgeModelSelector();
    const ids = ['ab', 'cd'];
    let published = state;
    select(published, ids, geometry, 'flow', mounted);
    const readChanged = (
      nextIds = ids, nextGeometry = geometry, rfId = 'flow', nextMounted = mounted,
    ) => {
      getter.mockClear();
      published = { ...published, transform: [published.transform[0] + 1, 0, 1] };
      select(published, nextIds, nextGeometry, rfId, nextMounted);
      expect(getter).toHaveBeenCalled();
    };
    published = { ...published, defaultEdgeOptions: { animated: true } };
    readChanged();
    published = { ...published, edges: [...published.edges] };
    readChanged();
    readChanged([...ids]);
    readChanged(ids, { ...geometry });
    readChanged(ids, geometry, 'other');
    readChanged(ids, geometry, 'flow', new Set(['b']));
  });

  it('requires a changed transform reference before shortcutting a new Store object', () => {
    const { state, edges, geometry, mounted } = fixture();
    const getter = vi.fn(() => 'label');
    Object.defineProperty(edges[0], 'label', { enumerable: true, get: getter });
    const select = createCanvasEdgeModelSelector();
    const ids = ['ab'];
    select(state, ids, geometry, 'flow', mounted);
    getter.mockClear();
    state.transform[0] = 20;
    edges[0].selected = true;
    const next = select({ ...state }, ids, geometry, 'flow', mounted);
    expect(next[0]).toMatchObject({ props: { selected: true } });
    expect(getter).toHaveBeenCalled();
  });

  it('reuses the same array and models across viewport snapshots without geometry calls', () => {
    const { state, geometry, read } = fixture();
    const first = read();
    geometry.getEdgePosition.mockClear();
    geometry.getElevatedEdgeZIndex.mockClear();
    for (let zoom = 0.2; zoom < 1.5; zoom += 0.1) {
      state.transform = [zoom * 200, zoom * -100, zoom];
      expect(read()).toBe(first);
    }
    expect(geometry.getEdgePosition).not.toHaveBeenCalled();
    expect(geometry.getElevatedEdgeZIndex).not.toHaveBeenCalled();
  });

  it('invalidates only incident edges when absolute position changes in place', () => {
    const { nodes, geometry, read } = fixture();
    const first = read();
    geometry.getEdgePosition.mockClear();
    nodes[0].internals.positionAbsolute.x = 25;
    const second = read();
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(1);
    expect((second[0] as CanvasSharedEdgeModel).props.sourceX).toBe(25);
  });

  it('captures mutable handle fields and source/target ordering', () => {
    const { nodes, geometry, read } = fixture();
    read();
    const source = nodes[0].internals.handleBounds!.source!;
    source[0].x = 125;
    read();
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(3);
    source.push({ ...source[0], id: 'other' });
    read();
    source.reverse();
    read();
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(5);
  });

  it('captures dimensions, fallback handles and endpoint position hints', () => {
    const { nodes, geometry, read } = fixture();
    read();
    nodes[0].measured.width = 120;
    read();
    nodes[0].sourcePosition = Position.Top;
    read();
    nodes[0].targetPosition = Position.Bottom;
    read();
    nodes[0].internals.handleBounds = undefined;
    nodes[0].handles = [{ id: 'out', type: 'source', position: Position.Right, x: 100, y: 40 }];
    read();
    nodes[0].handles[0].height = 10;
    read();
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(7);
  });

  it('updates selection, parent elevation and mounted interactivity without recomputing positions', () => {
    const { nodes, edges, geometry, mounted, read } = fixture();
    const first = read();
    geometry.getEdgePosition.mockClear();
    nodes[0].selected = true;
    nodes[0].internals.z = 4;
    nodes[0].parentId = 'parent';
    edges[0].selected = true;
    mounted.clear();
    const second = read();
    expect(second[0]).toMatchObject({ kind: 'shared', zIndex: 100, interactive: false, props: { selected: true } });
    expect(second[1]).toBe(first[1]);
    expect((second[0] as CanvasSharedEdgeModel).path).toBe((first[0] as CanvasSharedEdgeModel).path);
    expect(geometry.getElevatedEdgeZIndex).toHaveBeenLastCalledWith(expect.objectContaining({ selected: true, sourceNode: nodes[0] }));
    expect(geometry.getEdgePosition).not.toHaveBeenCalled();
  });

  it('rebuilds cached path geometry only when an endpoint or base curve type changes', () => {
    const { nodes, edges, read } = fixture();
    const first = read() as CanvasSharedEdgeModel[];
    nodes[0].internals.positionAbsolute.x = 75;
    const moved = read() as CanvasSharedEdgeModel[];
    expect(moved[0].path).not.toBe(first[0].path);
    expect(moved[0].path[0]).not.toBe(first[0].path[0]);
    expect(moved[1].path).toBe(first[1].path);

    edges[0].type = 'selected-node-flow';
    edges[0].data = { selectedNodeFlowBaseType: 'smoothstep' };
    const orthogonal = read() as CanvasSharedEdgeModel[];
    expect(orthogonal[0].path[0]).not.toBe(moved[0].path[0]);
    expect(orthogonal[1].path).toBe(first[1].path);
  });

  it('merges defaults and forwards all edge component props and marker URLs', () => {
    const { state, edges, geometry, read } = fixture();
    state.defaultEdgeOptions = {
      type: 'smoothstep', animated: true, selectable: false, deletable: false,
      markerStart: 'start', markerEnd: { type: 'arrowclosed', color: 'red' },
      label: 'default', labelStyle: { color: 'red' }, labelShowBg: true,
      labelBgStyle: { fill: 'black' }, labelBgPadding: [2, 3], labelBgBorderRadius: 4,
      interactionWidth: 24, style: { strokeWidth: 3 }, data: { defaultData: true },
    };
    edges[0].label = 'edge';
    edges[0].sourceHandle = 'out';
    edges[0].targetHandle = 'in';
    Object.assign(edges[0], { pathOptions: { borderRadius: 9 } });
    const model = read(['ab'])[0] as CanvasSharedEdgeModel;
    expect(model.props).toMatchObject({
      type: 'smoothstep', animated: true, selectable: false, deletable: false,
      markerStart: "url('#start')", markerEnd: "url('#flow:arrowclosed:red')",
      label: 'edge', labelStyle: { color: 'red' }, labelShowBg: true,
      labelBgStyle: { fill: 'black' }, labelBgPadding: [2, 3], labelBgBorderRadius: 4,
      interactionWidth: 24, style: { strokeWidth: 3 }, data: { defaultData: true },
      sourceHandleId: 'out', targetHandleId: 'in', pathOptions: { borderRadius: 9 },
    });
    expect(geometry.getMarkerId).toHaveBeenCalledWith('start', 'flow');
    expect(model.edge).not.toBe(edges[0]);
    expect(edges[0]).not.toHaveProperty('animated');
  });

  it('invalidates mutable markers/defaults and flow IDs without recalculating endpoints', () => {
    const { state, geometry, read } = fixture();
    const marker = { type: 'arrowclosed' as const, color: 'red' };
    state.defaultEdgeOptions = { markerEnd: marker, selectable: false };
    const first = read(['ab']);
    geometry.getEdgePosition.mockClear();
    marker.color = 'blue';
    state.defaultEdgeOptions.selectable = true;
    const second = read(['ab']);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toMatchObject({ selectable: true, props: { markerEnd: "url('#flow:arrowclosed:blue')" } });
    expect(read(['ab'], 'other')[0]).toMatchObject({ props: { markerEnd: "url('#other:arrowclosed:blue')" } });
    expect(geometry.getEdgePosition).not.toHaveBeenCalled();
  });

  it('refreshes position or elevation only for the affected global option', () => {
    const { state, geometry, read } = fixture();
    read();
    geometry.getEdgePosition.mockClear();
    geometry.getElevatedEdgeZIndex.mockClear();
    state.zIndexMode = 'manual';
    state.elevateEdgesOnSelect = false;
    read();
    expect(geometry.getEdgePosition).not.toHaveBeenCalled();
    expect(geometry.getElevatedEdgeZIndex).toHaveBeenCalledTimes(2);
    state.connectionMode = ConnectionMode.Loose;
    read();
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(2);
    state.onError = vi.fn();
    read();
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(4);
  });

  it('preserves explicit flags and refreshes inherited flags', () => {
    const { state, edges, read } = fixture();
    edges[0].selectable = false;
    edges[0].focusable = false;
    read();
    state.elementsSelectable = false;
    state.edgesFocusable = false;
    const models = read();
    expect(models[0]).toMatchObject({ selectable: false, focusable: false });
    expect(models[1]).toMatchObject({ selectable: false, focusable: false, props: { deletable: true } });
  });

  it('falls back for unknown types/nonempty DOM attributes and shares known types', () => {
    const { edges, geometry, read } = fixture();
    edges[0].type = 'custom';
    edges[1].domAttributes = { 'aria-hidden': true };
    expect(read()).toEqual([{ kind: 'native', id: 'ab' }, { kind: 'native', id: 'cd' }]);
    expect(geometry.getEdgePosition).not.toHaveBeenCalled();
    edges[0].type = 'selected-node-flow';
    edges[1].domAttributes = {};
    expect(read().map((model) => model.kind)).toEqual(['shared', 'shared']);
  });

  it('omits hidden edges, missing endpoints and uninitialized geometry', () => {
    const { nodes, edges, state, geometry, read } = fixture();
    read();
    edges[0].hidden = true;
    state.nodeLookup.delete('d');
    expect(read()).toEqual([]);
    edges[0].hidden = false;
    nodes[0].hidden = true;
    nodes[0].internals.handleBounds = undefined;
    expect(read(['ab'])).toEqual([]);
    const calls = geometry.getEdgePosition.mock.calls.length;
    expect(read(['ab'])).toEqual([]);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(calls);
  });

  it('keeps React Flow hidden-node semantics with explicitly initialized handles', () => {
    const { nodes, read } = fixture();
    nodes[0].hidden = true;
    expect(read(['ab'])[0].kind).toBe('shared');
  });

  it('prunes invisible/deleted edge entries instead of accumulating cached positions', () => {
    const { state, geometry, read } = fixture();
    read();
    read(['ab']);
    geometry.getEdgePosition.mockClear();
    read(['ab', 'cd']);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(1);
    read([]);
    geometry.getEdgePosition.mockClear();
    read(['ab']);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(1);
    state.edgeLookup.delete('ab');
    expect(read(['ab'])).toEqual([]);
  });

  it('protects Store-owned fallback handles from geometry helper normalization', () => {
    const { nodes, geometry, read } = fixture();
    nodes[0].internals.handleBounds = undefined;
    nodes[0].handles = [{ id: 'out', type: 'source', position: Position.Right, x: 100, y: 40 }];
    const original = geometry.getEdgePosition.getMockImplementation()!;
    geometry.getEdgePosition.mockImplementation((params) => {
      if (params.sourceNode.handles) params.sourceNode.handles[0].width ??= 1;
      return original(params);
    });
    const first = read(['ab']);
    expect(nodes[0].handles[0].width).toBeUndefined();
    expect(read(['ab'])).toBe(first);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(1);
  });
});

describe('canvas edge snapshot reader', () => {
  it('scans once per published Store object despite repeated snapshot reads', () => {
    const { state, geometry, mounted, edges } = fixture();
    let published = state;
    const select = vi.fn(createCanvasEdgeModelSelector());
    const read = createCanvasEdgeSnapshotReader(() => published, select, ['ab', 'cd'], geometry, 'flow', mounted);
    const first = read();
    expect(read()).toBe(first);
    expect(read()).toBe(first);
    expect(select).toHaveBeenCalledTimes(1);

    published = { ...published, transform: [10, 20, 0.5] };
    expect(read()).toBe(first);
    expect(read()).toBe(first);
    expect(select).toHaveBeenCalledTimes(2);
    expect(geometry.getEdgePosition).toHaveBeenCalledTimes(2);

    edges[0].selected = true;
    published = { ...published };
    const selected = read();
    expect(selected).not.toBe(first);
    expect(selected[0]).toMatchObject({ props: { selected: true } });
    expect(read()).toBe(selected);
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('recomputes when a reader is constructed with new inputs for the same Store object', () => {
    const { state, geometry } = fixture();
    state.defaultEdgeOptions = { markerEnd: { type: 'arrowclosed' } };
    const select = vi.fn(createCanvasEdgeModelSelector());
    const first = createCanvasEdgeSnapshotReader(() => state, select, ['ab'], geometry, 'first', new Set(['a']))();
    const next = createCanvasEdgeSnapshotReader(() => state, select, ['cd'], geometry, 'next', new Set())();
    expect(first[0]).toMatchObject({ interactive: true, props: { id: 'ab', markerEnd: "url('#first:arrowclosed:')" } });
    expect(next[0]).toMatchObject({ interactive: false, props: { id: 'cd', markerEnd: "url('#next:arrowclosed:')" } });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed selection as a successfully read Store snapshot', () => {
    const { state, geometry, mounted } = fixture();
    const select = vi.fn(createCanvasEdgeModelSelector()).mockImplementationOnce(() => { throw new Error('selection failed'); });
    const read = createCanvasEdgeSnapshotReader(() => state, select, ['ab'], geometry, 'flow', mounted);
    expect(read).toThrow('selection failed');
    expect(read()[0].kind).toBe('shared');
    expect(select).toHaveBeenCalledTimes(2);
  });
});
