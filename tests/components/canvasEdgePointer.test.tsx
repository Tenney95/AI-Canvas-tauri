import type { EdgeProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  frames: new Map<number, FrameRequestCallback>(), nextFrame: 0,
  requestFrame: vi.fn(), cancelFrame: vi.fn(), screenToFlowPosition: vi.fn(),
}));

vi.mock('react', async () => {
  const memoValue = (create: () => unknown, deps: readonly unknown[]) => {
    const index = driver.memoIndex++;
    const previous = driver.memos[index];
    if (!previous || !deps.every((dep, i) => Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { value: create(), deps };
    }
    return driver.memos[index].value;
  };
  return {
    ...await vi.importActual<typeof import('react')>('react'),
    memo: <T,>(component: T) => component,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memoValue(() => callback, deps),
    useMemo: memoValue,
    useState: <T,>(initial: T) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = initial;
      return [driver.states[index], (value: T) => { driver.states[index] = value; }];
    },
    useRef: <T,>(initial: T) => {
      const index = driver.refIndex++;
      driver.refs[index] ??= { current: initial };
      return driver.refs[index];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps && deps.length === previous.deps?.length
        && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock('@xyflow/react', () => ({
  BaseEdge: 'base-edge', EdgeLabelRenderer: 'edge-label',
  getBezierPath: () => ['M0,0L500,300', 250, 150],
  getSmoothStepPath: () => ['M0,0L500,300', 250, 150],
  useReactFlow: () => ({ screenToFlowPosition: driver.screenToFlowPosition }),
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ config: { performanceMode: false } }),
}));

import { CanvasEdgeHover, CanvasEdgeVisual } from '../../src/components/canvas/SelectedNodeFlowEdge';

interface ElementTree {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
interface PointerHandlers {
  onMouseEnter: (event: { clientX: number; clientY: number }) => void;
  onMouseMove: (event: { clientX: number; clientY: number }) => void;
  onMouseLeave: () => void;
}
const edgeProps = {
  id: 'edge-a', type: 'default', sourceX: 0, sourceY: 0, targetX: 500, targetY: 300,
  sourcePosition: 'right', targetPosition: 'left',
} as EdgeProps;
const onDelete = vi.fn();

function elements(tree: unknown, type: unknown): ElementTree[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ElementTree;
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)];
}
function render() {
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  const tree = CanvasEdgeHover({ id: edgeProps.id, onDelete, children: <path d="M0,0L500,300" /> });
  driver.pending.splice(0).forEach((effect) => effect());
  return { hit: elements(tree, 'g')[0].props as unknown as PointerHandlers, button: elements(tree, 'button')[0] };
}
function flushFrame() {
  const frames = [...driver.frames.values()];
  driver.frames.clear();
  frames.forEach((callback) => callback(0));
}
function unmount() {
  driver.effects.forEach(({ cleanup }) => cleanup?.());
  driver.effects = [];
}

beforeEach(() => {
  vi.useFakeTimers();
  driver.states = []; driver.refs = []; driver.memos = []; driver.effects = []; driver.pending = [];
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  driver.frames.clear(); driver.nextFrame = 0;
  driver.screenToFlowPosition.mockReset().mockImplementation(({ x, y }: { x: number; y: number }) => ({ x: x / 2, y: y / 2 }));
  driver.requestFrame.mockReset().mockImplementation((callback: FrameRequestCallback) => {
    const id = ++driver.nextFrame;
    driver.frames.set(id, callback);
    return id;
  });
  driver.cancelFrame.mockReset().mockImplementation((id: number) => driver.frames.delete(id));
  vi.stubGlobal('requestAnimationFrame', driver.requestFrame);
  vi.stubGlobal('cancelAnimationFrame', driver.cancelFrame);
});
afterEach(() => { unmount(); vi.useRealTimers(); });

describe('canvas edge pointer scheduling', () => {
  it('keeps only the transparent hit path when Canvas owns the shared geometry', () => {
    const tree = CanvasEdgeVisual({ ...edgeProps, baseStroke: false, interactive: true,
      path: ['M10 20L30 40', 20, 30, 10, 10], performanceMode: false, onDelete });
    expect(elements(tree, 'base-edge')).toHaveLength(0);
    expect(elements(tree, CanvasEdgeHover)).toHaveLength(1);
    expect(elements(tree, 'path').map((element) => element.props)).toEqual([
      expect.objectContaining({ d: 'M10 20L30 40', className: 'react-flow__edge-interaction', strokeOpacity: 0, strokeWidth: 20 }),
    ]);
  });

  it('retains no long SVG path when Canvas owns a noninteractive edge', () => {
    const tree = CanvasEdgeVisual({ ...edgeProps, baseStroke: false, interactive: false,
      performanceMode: false, onDelete });
    expect(elements(tree, 'base-edge')).toHaveLength(0);
    expect(elements(tree, 'path')).toHaveLength(0);
    expect(elements(tree, CanvasEdgeHover)).toHaveLength(0);
  });

  it('omits hover state, wide interaction strokes and flow decoration when no endpoints are mounted', () => {
    const tree = CanvasEdgeVisual({ ...edgeProps, type: 'selected-node-flow', interactive: false, performanceMode: false, onDelete });
    expect(elements(tree, CanvasEdgeHover)).toHaveLength(0);
    expect(elements(tree, 'base-edge')[0].props.interactionWidth).toBe(0);
    expect(elements(tree, 'g')).toHaveLength(0);
    expect(driver.refs).toHaveLength(0);
    expect(driver.effects).toHaveLength(0);
  });

  it('waits one second before converting the latest pointer position for the scissors', () => {
    const { hit } = render();
    hit.onMouseEnter({ clientX: 10, clientY: 20 });
    for (let i = 1; i <= 100; i++) hit.onMouseMove({ clientX: i * 2, clientY: i * 4 });
    vi.advanceTimersByTime(999);
    expect(driver.requestFrame).not.toHaveBeenCalled();
    expect(driver.screenToFlowPosition).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(driver.screenToFlowPosition).toHaveBeenCalledExactlyOnceWith({ x: 200, y: 400 });
    expect(render().button.props.style).toMatchObject({ transform: 'translate(-50%, -50%) translate(100px, 200px)' });
  });

  it('coalesces 100 visible-scissors mouse moves into one frame and one viewport conversion', () => {
    render().hit.onMouseEnter({ clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(1000);
    const { hit } = render();
    driver.screenToFlowPosition.mockClear();
    for (let i = 1; i <= 100; i++) hit.onMouseMove({ clientX: i * 3, clientY: i * 6 });
    expect(driver.requestFrame).toHaveBeenCalledOnce();
    expect(driver.screenToFlowPosition).not.toHaveBeenCalled();
    flushFrame();
    expect(driver.screenToFlowPosition).toHaveBeenCalledExactlyOnceWith({ x: 300, y: 600 });
    expect(render().button.props.style).toMatchObject({ transform: 'translate(-50%, -50%) translate(150px, 300px)' });
  });

  it('cancels queued pointer frames when the scissors hide and when the edge unmounts', () => {
    render().hit.onMouseEnter({ clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(1000);
    let { hit } = render();
    driver.screenToFlowPosition.mockClear();
    hit.onMouseMove({ clientX: 50, clientY: 60 });
    hit.onMouseLeave();
    vi.advanceTimersByTime(180);
    expect(render().button).toBeUndefined();
    expect(driver.cancelFrame).toHaveBeenCalledWith(1);
    expect(driver.frames.size).toBe(0);
    flushFrame();
    expect(driver.screenToFlowPosition).not.toHaveBeenCalled();

    render().hit.onMouseEnter({ clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(1000);
    ({ hit } = render());
    driver.screenToFlowPosition.mockClear();
    hit.onMouseMove({ clientX: 70, clientY: 80 });
    unmount();
    expect(driver.cancelFrame).toHaveBeenCalledWith(2);
    expect(driver.frames.size).toBe(0);
    flushFrame();
    expect(driver.screenToFlowPosition).not.toHaveBeenCalled();
  });
});
