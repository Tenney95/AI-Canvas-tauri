import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

const driver = vi.hoisted(() => ({
  state: {} as AppState, states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  resize: vi.fn<(width: number, height: number) => void>(), start: vi.fn(), end: vi.fn(),
  snap: { onResizeStart: vi.fn(), onResizeStop: vi.fn(),
    applyResizeSnap: vi.fn<(id: string, width: number, height: number, direction?: unknown) => { width: number; height: number }>() },
}));
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = driver.memoIndex++, previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { value: factory(), deps };
    }
    return driver.memos[index].value as T;
  };
  return { ...await vi.importActual<typeof import('react')>('react'),
    memo: <T,>(component: T) => component, useContext: () => driver.snap,
    useMemo: memo, useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useState: <T,>(initial: T | (() => T)) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (next: T | ((old: T) => T)) => {
        driver.states[index] = typeof next === 'function' ? (next as (old: T) => T)(driver.states[index] as T) : next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = driver.refIndex++;
      return (driver.refs[index] ??= { current: initial }) as { current: T };
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = driver.effectIndex++, previous = driver.effects[index];
      if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      driver.pending.push(() => { previous?.cleanup?.(); driver.effects[index] = { deps, cleanup: effect() ?? undefined }; });
    },
  };
});
vi.mock('react-dom', () => ({ flushSync: (callback: () => void) => callback() }));
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ flowToScreenPosition: (point: unknown) => point, screenToFlowPosition: (point: unknown) => point, getZoom: () => 1 }),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.state), { getState: () => driver.state }),
}));
vi.mock('../../src/hooks/useNodeSnap', () => ({ ResizeSnapContext: {} }));
vi.mock('../../src/utils/batchExecute', () => ({ batchExecuteNodes: vi.fn(), hasBatchExecutableNodes: () => false }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'animated-button' }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('../../src/i18n', () => ({ useT: () => (value: string) => value }));
vi.mock('../../src/utils/distributionGeometry', async (original) => {
  const actual = await original<typeof import('../../src/utils/distributionGeometry')>();
  return { ...actual, getDistributionItems: vi.fn(actual.getDistributionItems) };
});

import ResizeHandle from '../../src/components/nodes/shared/ResizeHandle';
import DistributionGapHandles from '../../src/components/canvas/DistributionGapHandles';
import MultiSelectToolbar from '../../src/components/canvas/MultiSelectToolbar';
import { getDistributionItems } from '../../src/utils/distributionGeometry';

class Surface extends EventTarget {
  dataset = { dirX: '1', dirY: '1' };
  captures = new Set<number>();
  classes = new Set<string>();
  classList = { add: (value: string) => this.classes.add(value), remove: (value: string) => this.classes.delete(value) };
  closest() { return this; }
  contains(target: unknown) { return target === this; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
}
type ElementLike = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
let surface: Surface, win: EventTarget, doc: EventTarget & { body: { style: { cursor: string; userSelect: string } } };
let frames: Map<number, FrameRequestCallback>, nextFrame: number;
function elements(value: unknown): ElementLike[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ElementLike;
  return [element, ...elements(element.props.children)];
}
function render<T>(component: () => T, attach?: (tree: T) => void) {
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  const tree = component(); attach?.(tree);
  driver.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function dispose() { driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; }
function resize(extra: Partial<ComponentProps<typeof ResizeHandle>> = {}) {
  const data = driver.state.nodes[0].data;
  return render(() => ResizeHandle({ nodeId: 'node', currentWidth: data.nodeWidth!, currentHeight: data.nodeHeight!,
    onResizeStart: driver.start, onResizeEnd: driver.end, onResize: driver.resize, ...extra }),
  (tree) => { (tree as ElementLike).props.ref!.current = surface; });
}
function pointer(target: EventTarget, type: string, x = 0, y = 0, pointerId = 1, shiftKey = false) {
  const event = Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerId, clientX: x, clientY: y, shiftKey });
  target.dispatchEvent(event);
}
function flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); }
function node(id: string, x: number, y: number, width = 100, height = 100): AppState['nodes'][number] {
  return { id, type: 'ai-image', position: { x, y }, data: { label: id, type: 'ai-image', nodeWidth: width, nodeHeight: height } };
}
function distribution(axis: 'horizontal' | 'vertical' = 'horizontal', shiftKey = false) {
  const tree = render(() => DistributionGapHandles({ axis }));
  const button = elements(tree).find((element) => element.type === 'button')!;
  (button.props.onPointerDown as (event: unknown) => void)({ button: 0, pointerId: 1, clientX: 0, clientY: 0, shiftKey,
    currentTarget: surface, preventDefault: () => {}, stopPropagation: () => {} });
}
function selection() {
  const group = { ...node('group', 100, 200), type: 'group' };
  driver.state.nodes = [group, ...[0, 1, 2].map((i) => ({ ...node(`n${i}`, i * 200, i * 200), parentId: 'group' }))];
  driver.state.selectedNodeIds = ['n2', 'n0', 'n1'];
}

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.memos = []; driver.effects = []; driver.pending = [];
  driver.state = { currentProjectId: 'project', nodes: [node('node', 100, 200, 300, 200)], selectedNodeIds: [],
    commitToHistory: vi.fn(), setNodes: vi.fn((nodes: AppState['nodes']) => { driver.state.nodes = nodes; }),
    updateNodePositionTransient: vi.fn((id: string, position: { x: number; y: number }) => {
      driver.state.nodes = driver.state.nodes.map((item) => item.id === id ? { ...item, position } : item);
    }), copySelectedNodes: vi.fn(),
  } as unknown as AppState;
  driver.resize.mockReset().mockImplementation((nodeWidth, nodeHeight) => {
    driver.state.nodes = driver.state.nodes.map((item) => item.id === 'node' ? { ...item, data: { ...item.data, nodeWidth, nodeHeight } } : item);
  });
  driver.snap.applyResizeSnap.mockReset().mockImplementation((_id, width, height) => ({ width, height }));
  surface = new Surface(); win = new EventTarget(); frames = new Map(); nextFrame = 0;
  doc = Object.assign(new EventTarget(), { body: { style: { cursor: 'original', userSelect: 'text' } }, querySelectorAll: () => [] });
  vi.stubGlobal('document', doc); vi.stubGlobal('window', Object.assign(win, { matchMedia: () => ({ matches: true }) }));
  vi.stubGlobal('Element', Surface); vi.stubGlobal('getComputedStyle', () => ({ cursor: 'nw-resize' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { dispose(); vi.unstubAllGlobals(); });

describe('resize frames and lifecycle', () => {
  it.each([[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]])('retains direction %s/%s and its opposite edge through a burst and the real pointerup', (x, y) => {
    surface.dataset = { dirX: String(x), dirY: String(y) }; resize();
    pointer(surface, 'pointerdown'); pointer(doc, 'pointermove', 5, 10); pointer(doc, 'pointermove', 10, 20);
    expect(driver.resize).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
    flush(); expect(driver.resize).toHaveBeenCalledOnce();
    resize(); // Native listeners survive the size render and unstable proportional-hook callbacks.
    pointer(doc, 'pointerup', 20, 30); flush();
    expect(driver.resize).toHaveBeenLastCalledWith(x === 0 ? 300 : 300 + x * 20, y === 0 ? 200 : 200 + y * 30);
    expect(driver.state.nodes[0].position).toEqual({ x: x === -1 ? 120 : 100, y: y === -1 ? 230 : 200 });
    expect(driver.start).toHaveBeenCalledOnce(); expect(driver.end).toHaveBeenCalledOnce();
    expect(driver.snap.onResizeStop).toHaveBeenCalledOnce(); expect(surface.captures.size).toBe(0);
  });

  it('keeps Shift transitions, minimum aspect size and click-only history unchanged', () => {
    surface.dataset = { dirX: '1', dirY: '0' }; resize();
    pointer(surface, 'pointerdown'); pointer(doc, 'pointermove', 60, 0, 1, true); flush();
    expect(driver.resize).toHaveBeenLastCalledWith(360, 240);
    pointer(doc, 'pointerup', 30);
    expect(driver.resize).toHaveBeenLastCalledWith(330, 200);
    resize({ lockAspectRatio: true }); pointer(surface, 'pointerdown'); pointer(doc, 'pointerup', -1000);
    expect(driver.resize).toHaveBeenLastCalledWith(198, 120);
    driver.start.mockClear(); driver.end.mockClear(); driver.resize.mockClear();
    pointer(surface, 'pointerdown'); pointer(doc, 'pointerup');
    expect(driver.resize).not.toHaveBeenCalled(); expect(driver.start).not.toHaveBeenCalled(); expect(driver.end).not.toHaveBeenCalled();
  });

  it('honors Shift on the final native pointer event without a preceding keydown', () => {
    surface.dataset = { dirX: '1', dirY: '0' }; resize(); pointer(surface, 'pointerdown');
    pointer(doc, 'pointerup', 60, 0, 1, true);
    expect(driver.resize).toHaveBeenCalledExactlyOnceWith(360, 240);
    expect(driver.start).toHaveBeenCalledOnce(); expect(driver.end).toHaveBeenCalledOnce();
  });

  it.each(['blur', 'pointercancel', 'lostpointercapture', 'project', 'unmount'])('drops a queued resize on %s without a history boundary', (reason) => {
    resize(); pointer(surface, 'pointerdown'); pointer(doc, 'pointermove', 50, 50);
    if (reason === 'blur') win.dispatchEvent(new Event('blur'));
    if (reason === 'pointercancel') pointer(doc, reason);
    if (reason === 'lostpointercapture') pointer(surface, reason);
    if (reason === 'project') driver.state.currentProjectId = 'other';
    if (reason === 'unmount') dispose();
    flush(); pointer(doc, 'pointerup', 100, 100);
    expect(driver.resize).not.toHaveBeenCalled(); expect(driver.start).not.toHaveBeenCalled(); expect(driver.end).not.toHaveBeenCalled();
    expect(driver.snap.onResizeStop).toHaveBeenCalledOnce(); expect(frames.size).toBe(0); expect(surface.captures.size).toBe(0);
    expect(doc.body.style).toEqual({ cursor: 'original', userSelect: 'text' });
  });

  it('ignores other pointers and applies final snapping before finishing', () => {
    resize(); pointer(surface, 'pointerdown'); pointer(surface, 'pointerdown', 100, 100, 2);
    pointer(doc, 'pointermove', 200, 200, 2); pointer(doc, 'pointerup', 200, 200, 2);
    driver.snap.applyResizeSnap.mockImplementation((_id, width, height) => ({ width: width + 3, height: height + 4 }));
    pointer(doc, 'pointerup', 10, 20);
    expect(driver.resize).toHaveBeenCalledExactlyOnceWith(313, 224);
    expect(driver.snap.applyResizeSnap).toHaveBeenCalledExactlyOnceWith('node', 310, 220, { x: 1, y: 1 });
  });

  it('finishes the displayed resize once on blur and drops its pending larger size', () => {
    resize(); pointer(surface, 'pointerdown'); pointer(doc, 'pointermove', 10, 10); flush();
    pointer(doc, 'pointermove', 50, 50); win.dispatchEvent(new Event('blur'));
    flush(); pointer(doc, 'pointerup', 100, 100);
    expect(driver.resize).toHaveBeenCalledExactlyOnceWith(310, 210);
    expect(driver.start).toHaveBeenCalledOnce(); expect(driver.end).toHaveBeenCalledOnce();
  });
});

describe('distribution gesture frames', () => {
  it('prepares geometry once, merges current media/membership and commits the actual final gap once', () => {
    selection(); driver.state.nodes.push(node('removed', 900, 900));
    const readWidth = vi.fn(() => 100);
    Object.defineProperty(driver.state.nodes[1].data, 'nodeWidth', { get: readWidth, enumerable: true });
    distribution(); const geometryCalls = vi.mocked(getDistributionItems).mock.calls.length;
    const geometryReads = readWidth.mock.calls.length; expect(geometryReads).toBeGreaterThan(0);
    pointer(doc, 'pointermove', 10); pointer(doc, 'pointermove', 20); pointer(doc, 'pointermove', 30);
    expect(driver.state.setNodes).not.toHaveBeenCalled(); expect(frames.size).toBe(1); flush();
    const media = { ...driver.state.nodes[2].data, imageUrl: 'asset://new' };
    driver.state.nodes = driver.state.nodes.filter((item) => item.id !== 'removed')
      .map((item) => item.id === 'n1' ? { ...item, data: media, position: { ...item.position, y: 777 } } : item);
    const added = node('added', 900, 900); driver.state.nodes = [...driver.state.nodes, added];
    pointer(doc, 'pointerup', 40); flush();
    expect(driver.state.nodes.filter((item) => item.parentId).map((item) => item.position.x)).toEqual([-40, 200, 440]);
    expect(driver.state.nodes.find((item) => item.id === 'n1')).toMatchObject({ data: media, position: { y: 777 } });
    expect(driver.state.nodes.at(-1)).toBe(added); expect(getDistributionItems).toHaveBeenCalledTimes(geometryCalls);
    expect(driver.state.nodes.some((item) => item.id === 'removed')).toBe(false);
    expect(readWidth).toHaveBeenCalledTimes(geometryReads);
    expect(driver.state.commitToHistory).toHaveBeenCalledOnce(); expect(driver.state.setNodes).toHaveBeenCalledTimes(2);
    expect(surface.captures.size).toBe(0); expect(frames.size).toBe(0);
  });

  it.each(['horizontal', 'vertical'] as const)('retains Shift adjacent-only distribution in %s', (axis) => {
    selection(); distribution(axis, true); pointer(doc, 'pointerup', 20, 20);
    const coordinate = axis === 'horizontal' ? 'x' : 'y';
    expect(driver.state.nodes.filter((item) => item.parentId).map((item) => item.position[coordinate])).toEqual([-10, 210, 400]);
    expect(driver.state.commitToHistory).toHaveBeenCalledOnce();
  });

  it.each(['blur', 'pointercancel', 'lostpointercapture', 'project', 'unmount', 'deleted'])('drops queued distribution after %s', (reason) => {
    selection(); distribution(); pointer(doc, 'pointermove', 50);
    if (reason === 'blur') win.dispatchEvent(new Event('blur'));
    if (reason === 'pointercancel') pointer(doc, reason);
    if (reason === 'lostpointercapture') pointer(surface, reason);
    if (reason === 'project') driver.state.currentProjectId = 'other';
    if (reason === 'unmount') dispose();
    if (reason === 'deleted') driver.state.nodes = driver.state.nodes.filter((item) => item.id !== 'n1');
    flush(); pointer(doc, 'pointerup', 100);
    expect(driver.state.setNodes).not.toHaveBeenCalled(); expect(driver.state.commitToHistory).not.toHaveBeenCalled();
    expect(surface.captures.size).toBe(0); expect(frames.size).toBe(0);
    expect(doc.body.style).toEqual({ cursor: 'original', userSelect: 'text' });
  });
});

describe('batch alignment entry', () => {
  it.each([
    ['左对齐', 'x', [0, 0]], ['水平居中', 'x', [175, 125]], ['右对齐', 'x', [400, 300]],
    ['顶对齐', 'y', [0, 0]], ['垂直居中', 'y', [62.5, 37.5]], ['底对齐', 'y', [150, 100]],
  ] as const)('preserves measured sizes and parent offsets for %s', (label, coordinate, expected) => {
    const group = { ...node('group', 100, 200), type: 'group' };
    const a = { ...node('a', 0, 0), parentId: 'group', measured: { width: 100, height: 50 } };
    const b = { ...node('b', 300, 100), parentId: 'group', measured: { width: 200, height: 100 } };
    const readWidth = vi.fn(() => 100);
    Object.defineProperty(a.data, 'nodeWidth', { get: readWidth, enumerable: true });
    driver.state.nodes = [group, a, b]; driver.state.selectedNodeIds = ['b', 'group', 'a'];
    const tree = render(() => MultiSelectToolbar({}));
    const button = elements(tree).find((element) => element.props['data-tooltip'] === label)!;
    const before = readWidth.mock.calls.length;
    (button.props.onClick as () => void)();
    expect(readWidth).toHaveBeenCalledTimes(before + 1);
    expect(driver.state.nodes.slice(1).map((item) => item.position[coordinate])).toEqual(expected);
    expect(driver.state.nodes[0]).toBe(group); expect(driver.state.nodes[1].data).toBe(a.data); expect(driver.state.nodes[2].data).toBe(b.data);
    expect(driver.state.commitToHistory).toHaveBeenCalledOnce(); expect(driver.state.setNodes).toHaveBeenCalledOnce();
  });
});
