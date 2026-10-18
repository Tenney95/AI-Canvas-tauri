import type { ReactNode } from 'react';
import type { Edge, InternalNode, Position, ReactFlowState } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasEdgeGeometry, CanvasEdgeLayerProps } from '../../src/types/canvasEdges';

interface Hooks {
  states: unknown[];
  memos: Array<{ deps?: readonly unknown[]; value: unknown }>;
  refs: Array<{ current: unknown }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>;
  stateIndex: number;
  memoIndex: number;
  refIndex: number;
  effectIndex: number;
}

const driver = vi.hoisted(() => ({
  instances: new Map<string, Hooks>(),
  current: null as Hooks | null,
  store: null as unknown,
  observers: [] as Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
  frames: new Map<number, FrameRequestCallback>(),
  nextFrame: 0,
  panePointer: { current: null as {
    handle(event: unknown, action: 'click' | 'doubleClick'): boolean;
    hitTest(point: { x: number; y: number }): boolean;
  } | null },
  appState: { config: { performanceMode: false }, onEdgesChange: vi.fn() },
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useCallback: <T,>(callback: T) => callback,
  useContext: () => driver.panePointer,
  useMemo: (compute: () => unknown, deps?: readonly unknown[]) => {
    const hooks = driver.current!;
    const index = hooks.memoIndex++;
    const previous = hooks.memos[index];
    if (previous && deps && deps.length === previous.deps?.length
      && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return previous.value;
    const value = compute();
    hooks.memos[index] = { deps, value };
    return value;
  },
  useState: (initial: unknown) => {
    const hooks = driver.current!;
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (value: unknown) => {
      hooks.states[index] = typeof value === 'function' ? value(hooks.states[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const hooks = driver.current!;
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = driver.current!;
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length
      && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('@xyflow/react', async () => ({
  ...await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react'),
  useStoreApi: () => driver.store,
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: typeof driver.appState) => unknown) => selector(driver.appState), {
    getState: () => driver.appState,
  }),
}));
vi.mock('../../src/components/canvas/SelectedNodeFlowEdge', () => ({ CanvasEdgeVisual: 'edge-visual' }));

import CanvasEdgeLayer from '../../src/components/canvas/CanvasEdgeLayer';
import CanvasEdgeStrokeLayer from '../../src/components/canvas/CanvasEdgeStrokeLayer';

interface ElementTree {
  type: unknown;
  key?: string | null;
  props: Record<string, unknown> & { children?: unknown };
}

function elements(tree: unknown, type: unknown): ElementTree[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ElementTree;
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)];
}

function component<P>(name: string, render: (props: P) => ReactNode, props: P) {
  let hooks = driver.instances.get(name);
  if (!hooks) {
    hooks = { states: [], memos: [], refs: [], effects: [], pending: [], stateIndex: 0, memoIndex: 0, refIndex: 0, effectIndex: 0 };
    driver.instances.set(name, hooks);
  }
  hooks.stateIndex = hooks.memoIndex = hooks.refIndex = hooks.effectIndex = 0;
  driver.current = hooks;
  const tree = render(props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return tree;
}

function node(id: string): InternalNode {
  const userNode = { id, data: {}, position: { x: 0, y: 0 } };
  return {
    ...userNode,
    measured: { width: 100, height: 80 },
    internals: { userNode, positionAbsolute: { x: 0, y: 0 }, z: 1 },
  };
}

function fixture(edges: Edge[] = [{ id: 'ab', source: 'a', target: 'b' }]) {
  const children: Array<{ getAttribute: (name: string) => string | null; classList: { contains: (name: string) => boolean } }> = [];
  const container = { children };
  const sharedSvg = { getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const root = {
    querySelector: vi.fn((selector: string): unknown => selector === '.react-flow__nodes' ? container
      : selector === '.canvas-shared-edge-layer' ? sharedSvg : null),
    querySelectorAll: vi.fn(() => []),
  };
  const listeners = new Set<() => void>();
  const state = {
    edges,
    edgeLookup: new Map(edges.map((edge) => [edge.id, edge])),
    nodeLookup: new Map(['a', 'b'].map((id) => [id, node(id)])),
    domNode: root,
    connectionMode: 'loose', elementsSelectable: true, edgesFocusable: true,
    multiSelectionActive: false, nodesSelectionActive: true, zIndexMode: 'manual',
    addSelectedEdges: vi.fn(), unselectNodesAndEdges: vi.fn(),
  } as unknown as ReactFlowState;
  const store = {
    getState: () => state,
    setState: vi.fn((patch: Partial<ReactFlowState>) => Object.assign(state, patch)),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  const geometry: CanvasEdgeGeometry = {
    getEdgePosition: () => ({ sourceX: 0, sourceY: 0, targetX: 500, targetY: 300,
      sourcePosition: 'right' as Position, targetPosition: 'left' as Position }),
    getElevatedEdgeZIndex: ({ zIndex }) => zIndex ?? 0,
    getMarkerId: (marker) => typeof marker === 'string' ? marker : marker?.type ?? '',
  };
  const renderEdge = vi.fn((id: string) => <svg data-native-edge={id} />);
  const props: CanvasEdgeLayerProps = {
    edgeIds: edges.map((edge) => edge.id), geometry, rfId: 'flow', noPanClassName: 'nopan', renderEdge,
  };
  driver.store = store;
  const render = (overrides: Partial<CanvasEdgeLayerProps> = {}) => component('layer', CanvasEdgeLayer, { ...props, ...overrides });
  const notify = () => listeners.forEach((listener) => listener());
  const mountNode = (id: string) => children.push({
    getAttribute: (name) => name === 'data-id' ? id : null,
    classList: { contains: (name) => name === 'react-flow__node' },
  });
  return { state, store, props, renderEdge, render, root, sharedSvg, container, notify, mountNode };
}

function sharedGroup(tree: unknown, id = 'ab') {
  const svg = elements(tree, 'svg').find((element) => element.props['data-canvas-shared-edge-layer'] === 'central');
  const children = svg?.props.children as ElementTree[];
  const edge = children.find((element) => (element.props.model as { edge: Edge }).edge.id === id);
  if (!edge || typeof edge.type !== 'function') throw new Error(`Missing shared edge ${id}`);
  return component(`edge:${id}`, edge.type as (props: Record<string, unknown>) => ReactNode, edge.props) as ElementTree;
}

function groupHandlers(group: ElementTree) {
  return group.props as unknown as {
    ref: { current: unknown };
    onClick: (event: unknown) => void;
    onKeyDown?: (event: { key: string }) => void;
  };
}

beforeEach(() => {
  driver.instances.clear(); driver.observers = []; driver.frames.clear(); driver.nextFrame = 0;
  driver.panePointer.current = null;
  driver.appState.onEdgesChange.mockClear();
  vi.stubGlobal('MutationObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    readonly callback: () => void;
    constructor(callback: () => void) { this.callback = callback; driver.observers.push(this); }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++driver.nextFrame; driver.frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => driver.frames.delete(id));
});
afterEach(() => {
  driver.instances.forEach((hooks) => hooks.effects.forEach(({ cleanup }) => cleanup?.()));
  vi.unstubAllGlobals();
});

describe('central canvas edge rendering', () => {
  it('uses Canvas for ordinary strokes while retaining SVG fallback for markers and Canvas failures', () => {
    vi.stubGlobal('Path2D', class {});
    vi.stubGlobal('DOMMatrixReadOnly', class {});
    const f = fixture([
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'arrow', source: 'b', target: 'a', markerEnd: 'arrow' },
    ]);
    const tree = f.render();
    const strokes = elements(tree, CanvasEdgeStrokeLayer);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].props.models).toMatchObject([{ edge: { id: 'ab' } }]);
    const runs = elements(tree, 'svg');
    const ordinary = (runs[0].props.children as ElementTree[])[0];
    const arrow = (runs[1].props.children as ElementTree[])[0];
    expect(ordinary.props.baseStroke).toBe(false);
    expect(arrow.props.baseStroke).toBe(true);
    (strokes[0].props.onUnavailable as () => void)();
    const fallback = f.render();
    expect(elements(fallback, CanvasEdgeStrokeLayer)).toHaveLength(0);
    expect(elements(fallback, 'svg')).toHaveLength(1);
    expect(elements(sharedGroup(fallback), 'edge-visual')[0].props.baseStroke).toBe(true);
  });

  it('caps Canvas backing stores at two without reordering later SVG fallback strokes', () => {
    vi.stubGlobal('Path2D', class {});
    vi.stubGlobal('DOMMatrixReadOnly', class {});
    const f = fixture([
      { id: 'first', source: 'a', target: 'b' },
      { id: 'arrow-1', source: 'a', target: 'b', markerEnd: 'arrow' },
      { id: 'second', source: 'b', target: 'a' },
      { id: 'arrow-2', source: 'b', target: 'a', markerEnd: 'arrow' },
      { id: 'third', source: 'a', target: 'b' },
      { id: 'fourth', source: 'b', target: 'a' },
    ]);
    const tree = f.render();
    expect(elements(tree, CanvasEdgeStrokeLayer)).toHaveLength(2);
    const groups = elements(tree, 'svg').flatMap((svg) => svg.props.children as ElementTree[]);
    expect(groups.map((group) => (group.props.model as { edge: Edge }).edge.id))
      .toEqual(['first', 'arrow-1', 'second', 'arrow-2', 'third', 'fourth']);
    expect(groups.map((group) => group.props.baseStroke)).toEqual([false, true, false, true, true, true]);
    expect(f.renderEdge).not.toHaveBeenCalled();
  });

  it('keeps the shared SVG key when the first visible edge changes', () => {
    const f = fixture([{ id: 'ab', source: 'a', target: 'b' }, { id: 'ba', source: 'b', target: 'a' }]);
    const first = elements(f.render(), 'svg')[0];
    const next = elements(f.render({ edgeIds: ['ba'] }), 'svg')[0];
    expect(next.key).toBe(first.key);
    expect(sharedGroup(f.render({ edgeIds: ['ba'] }), 'ba').props['data-id']).toBe('ba');
  });

  it('renders ordinary edges as groups in one SVG without native wrappers or per-edge observers', () => {
    const f = fixture([{ id: 'ab', source: 'a', target: 'b' }, { id: 'ba', source: 'b', target: 'a' }]);
    const tree = f.render();
    expect(elements(tree, 'svg')).toHaveLength(1);
    const groups = [sharedGroup(tree, 'ab'), sharedGroup(tree, 'ba')];
    expect(groups.map((group) => group.type)).toEqual(['g', 'g']);
    expect(groups[0].props).toMatchObject({ 'data-id': 'ab', 'data-testid': 'rf__edge-ab', tabIndex: 0 });
    expect(groups[0].props.className).toContain('nopan');
    expect(elements(groups, 'edge-visual')).toHaveLength(2);
    expect(f.renderEdge).not.toHaveBeenCalled();
    expect(driver.observers).toHaveLength(1);
    expect(driver.observers[0].observe).toHaveBeenCalledExactlyOnceWith(f.container, { childList: true });
  });

  it('keeps unknown native edges between shared SVG runs in the original paint order', () => {
    const f = fixture([
      { id: 'before', source: 'a', target: 'b' },
      { id: 'custom', source: 'a', target: 'b', type: 'unknown' },
      { id: 'after', source: 'a', target: 'b' },
      { id: 'raised', source: 'a', target: 'b', zIndex: 1 },
    ]);
    const tree = f.render() as ElementTree;
    const layers = tree.props.children as ElementTree[];
    expect(layers).toHaveLength(4);
    expect(layers[0].type).toBe('svg');
    expect((layers[0].props.children as ElementTree[])[0].props.model).toMatchObject({ edge: { id: 'before' } });
    expect(elements(layers[1], 'svg')[0].props['data-native-edge']).toBe('custom');
    expect((layers[2].props.children as ElementTree[])[0].props.model).toMatchObject({ edge: { id: 'after' } });
    expect(layers[3].props.style).toEqual({ zIndex: 1 });
    expect(f.renderEdge).toHaveBeenCalledExactlyOnceWith('custom');
  });

  it('uses React Flow selection actions and clears node-selection mode on click', () => {
    const f = fixture();
    groupHandlers(sharedGroup(f.render())).onClick({});
    expect(f.store.setState).toHaveBeenCalledWith({ nodesSelectionActive: false });
    expect(f.state.addSelectedEdges).toHaveBeenCalledExactlyOnceWith(['ab']);
    expect(f.state.unselectNodesAndEdges).not.toHaveBeenCalled();
  });

  it.each(['svg', 'canvas'])('routes overlapping %s hit strokes to the closest line for click, Shift, double click and context menu', (backend) => {
    if (backend === 'canvas') {
      vi.stubGlobal('Path2D', class {});
      vi.stubGlobal('DOMMatrixReadOnly', class {});
    }
    const f = fixture([{ id: 'near', source: 'a', target: 'b' }, { id: 'far', source: 'a', target: 'b' }]);
    f.props.geometry.getEdgePosition = ({ id }) => ({ sourceX: 0, sourceY: id === 'near' ? 0 : 8,
      targetX: 500, targetY: id === 'near' ? 0 : 8,
      sourcePosition: 'right' as Position, targetPosition: 'left' as Position });
    const onEdgeClick = vi.fn();
    const onEdgeDoubleClick = vi.fn();
    const onEdgeContextMenu = vi.fn();
    const group = sharedGroup(f.render({ onEdgeClick, onEdgeDoubleClick, onEdgeContextMenu }), 'far');
    const event = { detail: 1, clientX: 225, clientY: 100,
      currentTarget: { ownerSVGElement: { getScreenCTM: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 100, f: 100 }) } } };
    groupHandlers(group).onClick(event);
    expect(f.state.addSelectedEdges).toHaveBeenCalledExactlyOnceWith(['near']);
    expect(onEdgeClick).toHaveBeenCalledWith(event, expect.objectContaining({ id: 'near' }));
    (group.props.onDoubleClick as (event: unknown) => void)(event);
    (group.props.onContextMenu as (event: unknown) => void)(event);
    expect(onEdgeDoubleClick).toHaveBeenCalledWith(event, expect.objectContaining({ id: 'near' }));
    expect(onEdgeContextMenu).toHaveBeenCalledWith(event, expect.objectContaining({ id: 'near' }));
    const selected = { ...f.state.edgeLookup.get('near')!, selected: true };
    f.state.edgeLookup.set('near', selected);
    f.state.multiSelectionActive = true;
    groupHandlers(group).onClick(event);
    expect(f.state.unselectNodesAndEdges).toHaveBeenCalledWith({ nodes: [], edges: [selected] });
    // Keyboard activation still applies to the focused edge, without pointer picking.
    groupHandlers(group).onKeyDown?.({ key: 'Enter' });
    expect(f.state.addSelectedEdges).toHaveBeenLastCalledWith(['far']);
  });

  it.each([0.1, 0.25, 0.45, 0.85, 1.2, 4.5, 5])('picks long crossing bitmap edges with both endpoints unmounted at zoom %s', (zoom) => {
    vi.stubGlobal('Path2D', class {});
    vi.stubGlobal('DOMMatrixReadOnly', class {});
    const f = fixture([{ id: 'near', source: 'a', target: 'b' }, { id: 'far', source: 'a', target: 'b' }]);
    f.props.geometry.getEdgePosition = ({ id }) => ({ sourceX: id === 'near' ? 20 : 25, sourceY: -100000,
      targetX: id === 'near' ? 20 : 25, targetY: 100000,
      sourcePosition: 'bottom' as Position, targetPosition: 'top' as Position });
    f.sharedSvg.getScreenCTM = () => ({ a: zoom, b: 0, c: 0, d: zoom, e: 100, f: 100 });
    const onEdgeClick = vi.fn();
    const onEdgeDoubleClick = vi.fn();
    const tree = f.render({ onEdgeClick, onEdgeDoubleClick });
    for (const id of ['near', 'far']) {
      const visual = elements(sharedGroup(tree, id), 'edge-visual')[0];
      expect(visual.props).toMatchObject({ baseStroke: false, interactive: false });
    }
    const event = { clientX: 100 + 20 * zoom, clientY: 100 };
    expect(driver.panePointer.current?.hitTest({ x: event.clientX, y: event.clientY })).toBe(true);
    expect(f.store.setState).not.toHaveBeenCalled();
    expect(f.state.addSelectedEdges).not.toHaveBeenCalled();
    expect(f.state.unselectNodesAndEdges).not.toHaveBeenCalled();
    expect(f.root.querySelectorAll).not.toHaveBeenCalled();
    expect(onEdgeClick).not.toHaveBeenCalled();
    expect(onEdgeDoubleClick).not.toHaveBeenCalled();
    expect(driver.panePointer.current?.handle(event, 'click')).toBe(true);
    expect(f.state.addSelectedEdges).toHaveBeenCalledExactlyOnceWith(['near']);
    expect(onEdgeClick).toHaveBeenCalledWith(event, expect.objectContaining({ id: 'near' }));
    const selected = { ...f.state.edgeLookup.get('near')!, selected: true };
    f.state.edgeLookup.set('near', selected);
    f.state.multiSelectionActive = true;
    expect(driver.panePointer.current?.handle(event, 'click')).toBe(true);
    expect(f.state.unselectNodesAndEdges).toHaveBeenCalledWith({ nodes: [], edges: [selected] });
    expect(driver.panePointer.current?.handle(event, 'doubleClick')).toBe(true);
    expect(onEdgeDoubleClick).toHaveBeenCalledWith(event, selected);
    expect(driver.panePointer.current?.handle({ clientX: 100 + 100 * zoom, clientY: 100 }, 'click')).toBe(false);
  });

  it('does not consume a pane hit after its edge is removed and releases the bridge on unmount', () => {
    const f = fixture();
    f.render();
    const handler = driver.panePointer.current;
    expect(handler?.hitTest({ x: 0, y: 0 })).toBe(true);
    expect(handler?.handle({ clientX: 0, clientY: 0 }, 'click')).toBe(true);
    f.state.edgeLookup.delete('ab');
    expect(handler?.handle({ clientX: 0, clientY: 0 }, 'click')).toBe(false);
    expect(handler?.hitTest({ x: 0, y: 0 })).toBe(false);
    driver.instances.get('layer')!.effects.forEach(({ cleanup }) => cleanup?.());
    expect(driver.panePointer.current).toBeNull();
  });

  it('reads live selection for Shift cancellation and preserves selected nodes', () => {
    const f = fixture();
    const group = sharedGroup(f.render());
    const blur = vi.fn();
    groupHandlers(group).ref.current = { blur };
    const live = { ...f.state.edgeLookup.get('ab')!, selected: true };
    f.state.edgeLookup.set('ab', live);
    f.state.multiSelectionActive = true;
    groupHandlers(group).onClick({});
    expect(f.state.unselectNodesAndEdges).toHaveBeenCalledExactlyOnceWith({ nodes: [], edges: [live] });
    expect(f.state.addSelectedEdges).not.toHaveBeenCalled();
    expect(blur).toHaveBeenCalledOnce();
  });

  it('retains Enter, Space and Escape selection semantics without handling deletion keys', () => {
    const f = fixture();
    const group = sharedGroup(f.render());
    const blur = vi.fn();
    const handlers = groupHandlers(group);
    handlers.ref.current = { blur };
    handlers.onKeyDown?.({ key: 'Enter' });
    handlers.onKeyDown?.({ key: ' ' });
    expect(f.state.addSelectedEdges).toHaveBeenCalledTimes(2);
    expect(f.state.addSelectedEdges).toHaveBeenNthCalledWith(1, ['ab']);
    expect(f.state.addSelectedEdges).toHaveBeenNthCalledWith(2, ['ab']);
    handlers.onKeyDown?.({ key: 'Escape' });
    expect(blur).toHaveBeenCalledOnce();
    expect(f.state.unselectNodesAndEdges).toHaveBeenCalledExactlyOnceWith({ edges: [f.state.edgeLookup.get('ab')] });
    handlers.onKeyDown?.({ key: 'Delete' });
    handlers.onKeyDown?.({ key: 'Backspace' });
    expect(f.state.addSelectedEdges).toHaveBeenCalledTimes(2);
    expect(driver.appState.onEdgesChange).not.toHaveBeenCalled();
  });

  it('does not select or emit callbacks through stale handlers after the edge is removed', () => {
    const f = fixture();
    const onEdgeClick = vi.fn();
    const handlers = groupHandlers(sharedGroup(f.render({ onEdgeClick })));
    f.state.edgeLookup.delete('ab');
    handlers.onClick({});
    handlers.onKeyDown?.({ key: 'Enter' });
    expect(f.store.setState).not.toHaveBeenCalled();
    expect(f.state.addSelectedEdges).not.toHaveBeenCalled();
    expect(f.state.unselectNodesAndEdges).not.toHaveBeenCalled();
    expect(onEdgeClick).not.toHaveBeenCalled();
  });

  it('attaches when domNode initializes later and coalesces direct node mounts into one frame', () => {
    const f = fixture();
    f.state.domNode = null;
    f.render();
    expect(driver.observers[0].observe).not.toHaveBeenCalled();
    f.state.domNode = f.root as unknown as HTMLDivElement;
    f.notify();
    expect(driver.observers[0].observe).toHaveBeenCalledWith(f.container, { childList: true });
    expect(elements(sharedGroup(f.render()), 'edge-visual')[0].props.interactive).toBe(false);
    f.mountNode('a');
    driver.observers[0].callback();
    driver.observers[0].callback();
    expect(driver.frames.size).toBe(1);
    const frames = [...driver.frames.values()]; driver.frames.clear();
    frames.forEach((callback) => callback(0));
    expect(elements(sharedGroup(f.render()), 'edge-visual')[0].props.interactive).toBe(true);
  });
});
