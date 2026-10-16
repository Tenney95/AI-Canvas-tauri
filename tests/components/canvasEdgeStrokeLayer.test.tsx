import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasSharedEdgeModel } from '../../src/types/canvasEdges';

interface Effect {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const driver = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Effect[],
  pending: [] as Array<() => void>,
  refIndex: 0,
  effectIndex: 0,
  frames: new Map<number, FrameRequestCallback>(),
  nextFrame: 0,
  paths: [] as string[],
  observers: [] as Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useRef: (initial: unknown) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps && deps.length === previous.deps?.length
      && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    driver.pending.push(() => {
      previous?.cleanup?.();
      driver.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

import CanvasEdgeStrokeLayer from '../../src/components/canvas/CanvasEdgeStrokeLayer';

interface ElementTree {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown; ref?: { current: unknown } };
}

function elements(tree: unknown, type: string): ElementTree[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ElementTree;
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)];
}

function edge(id = 'ab', path = 'M0 0 C100 0 100 80 200 80', selected = false): CanvasSharedEdgeModel {
  return { edge: { id, source: 'a', target: 'b', selected }, path: [path, 100, 40, 100, 40] } as CanvasSharedEdgeModel;
}

function flushFrames() {
  const callbacks = [...driver.frames.values()];
  driver.frames.clear();
  callbacks.forEach((callback) => callback(0));
}

function pathPoints(source: string) {
  const values = source.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  return Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
}

function fixture(initialModels = [edge()]) {
  const strokes: Array<{ path: Path2D; color: string; width: number }> = [];
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(),
    stroke: vi.fn((path: Path2D): void => { strokes.push({ path, color: ctx.strokeStyle, width: ctx.lineWidth }); }),
    strokeStyle: '', lineWidth: 0, globalAlpha: 1, lineCap: '', lineJoin: '',
  };
  const viewport = { style: { transform: 'matrix(1,0,0,1,0,0)' } };
  const normal = {};
  const selected = {};
  const media = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const view = {
    devicePixelRatio: 2,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = ++driver.nextFrame;
      driver.frames.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => { driver.frames.delete(id); }),
    getComputedStyle: vi.fn((probe: unknown) => ({
      stroke: probe === selected ? 'rgb(200, 100, 255)' : 'rgb(60, 70, 80)',
      strokeWidth: probe === selected ? '2' : '1.5', opacity: '1',
    })),
    matchMedia: vi.fn(() => media), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const canvas = {
    width: 0, height: 0, style: { width: '', height: '', transform: '' },
    dataset: {} as Record<string, string>,
    closest: vi.fn(() => viewport),
    ownerDocument: { defaultView: view, documentElement: {} },
    getContext: vi.fn(() => ctx), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const state = { width: 400, height: 300, transform: [0, 0, 1] };
  const listeners = new Set<(next: typeof state) => void>();
  const unsubscribe = vi.fn();
  const store = {
    getState: () => state,
    subscribe: vi.fn((listener: (next: typeof state) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    }),
  };
  const onUnavailable = vi.fn();
  const render = (models = initialModels): ReactNode => {
    driver.refIndex = driver.effectIndex = 0;
    const tree = CanvasEdgeStrokeLayer({
      models, store: store as unknown as Parameters<typeof CanvasEdgeStrokeLayer>[0]['store'], zIndex: 0, onUnavailable,
    });
    elements(tree, 'canvas')[0].props.ref!.current = canvas;
    const probes = elements(tree, 'path');
    probes[0].props.ref!.current = normal;
    probes[1].props.ref!.current = selected;
    driver.pending.splice(0).forEach((effect) => effect());
    return tree;
  };
  const notify = () => listeners.forEach((listener) => listener(state));
  const move = (x: number, y: number, zoom: number) => {
    state.transform = [x, y, zoom];
    viewport.style.transform = `matrix(${zoom},0,0,${zoom},${x},${y})`;
    notify();
    flushFrames();
  };
  return { ctx, strokes, canvas, viewport, normal, selected, state, view, media, store, listeners, unsubscribe, render, notify, move, onUnavailable };
}

beforeEach(() => {
  driver.refs = []; driver.effects = []; driver.pending = [];
  driver.refIndex = driver.effectIndex = driver.nextFrame = 0;
  driver.frames.clear(); driver.paths = []; driver.observers = [];
  vi.stubGlobal('Path2D', class {
    constructor(source: string) { driver.paths.push(source); }
  });
  vi.stubGlobal('DOMMatrixReadOnly', class {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; is2D = true;
    constructor(value?: string) {
      if (!value) return;
      [this.a, this.b, this.c, this.d, this.e, this.f] = value.slice(7, -1).split(',').map(Number);
    }
  });
  vi.stubGlobal('MutationObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    readonly callback: () => void;
    constructor(callback: () => void) { this.callback = callback; driver.observers.push(this); }
  });
});

afterEach(() => {
  driver.effects.forEach(({ cleanup }) => cleanup?.());
  vi.unstubAllGlobals();
});

describe('viewport Canvas edge strokes', () => {
  it('allocates only the viewport backing store and cancels its parent transform', () => {
    const f = fixture([edge('ab', 'M0 1000 C100 1000 100 1080 200 1080')]);
    f.viewport.style.transform = 'matrix(0.25,0,0,0.25,100,-200)';
    f.render();
    flushFrames();
    expect([f.canvas.width, f.canvas.height]).toEqual([800, 600]);
    expect(f.canvas.style).toMatchObject({ width: '400px', height: '300px', transform: 'matrix(4,0,0,4,-400,800)' });
    expect(f.ctx.setTransform).toHaveBeenLastCalledWith(0.5, 0, 0, 0.5, 200, -400);
    expect(f.ctx.stroke).toHaveBeenCalled();
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it('coalesces Store and committed DOM transform changes and reuses Path2D on small pans', () => {
    const f = fixture();
    f.render(); flushFrames();
    f.ctx.stroke.mockClear(); f.view.requestAnimationFrame.mockClear();
    f.state.transform = [50, -30, 1];
    f.notify(); f.notify();
    driver.observers[0].callback(); driver.observers[0].callback();
    expect(driver.frames.size).toBe(1);
    expect(f.view.requestAnimationFrame).toHaveBeenCalledOnce();
    // The committed DOM transform intentionally lags the Store publication.
    f.viewport.style.transform = 'matrix(1,0,0,1,30,-20)';
    flushFrames();
    expect(f.ctx.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 60, -40);
    expect(driver.paths).toHaveLength(1);
    expect(f.ctx.stroke).toHaveBeenCalledOnce();
  });

  it.each([0.1, 0.45, 0.85, 1.2, 5])('sends only nearby cubic geometry to Path2D at zoom %s', (zoom) => {
    const source = 'M-100000,0 C-50000,5 50000,-5 100000,0';
    const f = fixture([edge('long', source)]);
    f.viewport.style.transform = `matrix(${zoom},0,0,${zoom},200,150)`;
    f.render(); flushFrames();
    expect(f.onUnavailable).not.toHaveBeenCalled();
    expect(f.canvas.dataset).toMatchObject({ edgeDrawn: '1', edgeCulled: '0', edgeClipFallbacks: '0' });
    expect(driver.paths).toHaveLength(1);
    const clipped = driver.paths[0];
    expect(clipped).not.toBe(source);
    expect(clipped).toContain('C');
    expect(clipped).not.toContain('L');
    const points = pathPoints(clipped);
    // Original endpoints are far offscreen, but the middle must remain drawn.
    expect(-100000 * zoom + 200).toBeLessThan(0);
    expect(100000 * zoom + 200).toBeGreaterThan(f.state.width);
    const margin = 128 + 4 * zoom + 1;
    for (const point of points) {
      expect(point.x * zoom + 200).toBeGreaterThanOrEqual(-margin);
      expect(point.x * zoom + 200).toBeLessThanOrEqual(f.state.width + margin);
      expect(point.y * zoom + 150).toBeGreaterThanOrEqual(-margin);
      expect(point.y * zoom + 150).toBeLessThanOrEqual(f.state.height + margin);
    }
    expect(f.ctx.stroke).toHaveBeenCalled();
  });

  it('culls a curve whose control bbox overlaps the viewport but whose actual curve misses it', () => {
    const f = fixture([edge('outside', 'M-10000,10000 C-10000,-10000 10000,-10000 10000,10000')]);
    f.viewport.style.transform = 'matrix(1,0,0,1,200,150)';
    f.render(); flushFrames();
    expect(driver.paths).toHaveLength(0);
    expect(f.ctx.stroke).not.toHaveBeenCalled();
    expect(f.canvas.dataset).toMatchObject({ edgeDrawn: '0', edgeCulled: '1', edgeClipFallbacks: '0' });
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it('reuses the overscan window for small pans and recrops for large pans and magnification', () => {
    const f = fixture([edge('long', 'M-100000,0 C-50000,5 50000,-5 100000,0')]);
    f.viewport.style.transform = 'matrix(1,0,0,1,200,150)';
    f.render(); flushFrames();
    expect(driver.paths).toHaveLength(1);
    const initial = driver.paths[0];
    f.move(240, 150, 1);
    expect(driver.paths).toEqual([initial]);
    f.move(-800, 150, 1);
    expect(driver.paths).toHaveLength(2);
    expect(driver.paths[1]).not.toBe(initial);
    // Keep the view centered around world x=1000 while magnifying it.
    f.move(-4800, 150, 5);
    expect(driver.paths).toHaveLength(3);
    const points = pathPoints(driver.paths[2]);
    const xs = points.map(({ x }) => x * 5 - 4800);
    const margin = 128 + 4 * 5 + 1;
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-margin);
    expect(Math.max(...xs)).toBeLessThanOrEqual(f.state.width + margin);
    expect(f.canvas.dataset.edgeClipFallbacks).toBe('0');
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it('strokes a translucent edge only once even when clipping yields multiple visible subpaths', () => {
    const f = fixture([edge('overlap', 'M-100000,0 C300000,0 -300000,0 100000,0')]);
    f.viewport.style.transform = 'matrix(1,0,0,1,200,150)';
    f.view.getComputedStyle.mockReturnValue({ stroke: 'rgba(60, 70, 80, 0.5)', strokeWidth: '1.5', opacity: '0.4' });
    f.render(); flushFrames();
    expect(driver.paths).toHaveLength(1);
    expect(driver.paths[0].match(/M/g)).toHaveLength(3);
    expect(driver.paths[0].match(/C/g)).toHaveLength(3);
    f.ctx.stroke.mockClear();
    driver.observers[0].callback(); flushFrames();
    expect(f.ctx.stroke).toHaveBeenCalledOnce();
    expect(f.ctx.globalAlpha).toBe(0.4);
    expect(f.ctx.strokeStyle).toBe('rgba(60, 70, 80, 0.5)');
    expect(f.canvas.dataset.edgeDrawn).toBe('1');
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it.each([1, 1.5, 2])('bounds curve input across a continuous 10%%–500%% sweep at DPR %s', (ratio) => {
    const f = fixture([edge('long', 'M-100000,0 C-50000,5 50000,-5 100000,0')]);
    f.view.devicePixelRatio = ratio;
    f.viewport.style.transform = 'matrix(0.1,0,0,0.1,200,150)';
    f.render(); flushFrames();
    for (let step = 10; step <= 500; step++) {
      const zoom = step / 100;
      f.move(200, 150, zoom);
      const source = driver.paths.at(-1)!;
      const xs = pathPoints(source).map(({ x }) => x * zoom + 200);
      expect(source).toContain('C');
      expect(source).not.toContain('L');
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual((f.state.width + 256) * 1.5 + 1);
      expect(f.canvas.dataset).toMatchObject({ edgeDrawn: '1', edgeClipFallbacks: '0' });
    }
    expect([f.canvas.width, f.canvas.height]).toEqual([Math.ceil(400 * ratio), Math.ceil(300 * ratio)]);
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it('changes selection styling without rebuilding paths and invalidates only moved paths', () => {
    const original = edge();
    const f = fixture([original, edge('cd', 'M10 20 L30 40')]);
    f.render(); flushFrames();
    expect(driver.paths).toHaveLength(2);
    f.render([{ ...original, edge: { ...original.edge, selected: true } }, edge('cd', 'M10 20 L30 40')]);
    flushFrames();
    expect(driver.paths).toHaveLength(2);
    // The first selected edge is drawn before the ordinary second edge.
    expect(f.ctx.stroke.mock.calls.at(-2)?.[0]).toBe(f.ctx.stroke.mock.calls[0][0]);
    expect(f.strokes.at(-2)).toMatchObject({ color: 'rgb(200, 100, 255)', width: 2 });
    expect(f.strokes.at(-1)).toMatchObject({ color: 'rgb(60, 70, 80)', width: 1.5 });
    f.render([edge('ab', 'M1 0 C100 0 100 80 200 80')]);
    flushFrames();
    expect(driver.paths).toHaveLength(3);
    f.render([edge('cd', 'M10 20 L30 40')]);
    flushFrames();
    expect(driver.paths).toHaveLength(4);
  });

  it('refreshes appearance styles while preserving path cache', () => {
    const f = fixture();
    f.render(); flushFrames();
    f.view.getComputedStyle.mockClear();
    driver.observers[1].callback(); driver.observers[1].callback();
    flushFrames();
    expect(f.view.getComputedStyle).toHaveBeenCalledTimes(2);
    expect(driver.paths).toHaveLength(1);
  });

  it('cancels queued work and disconnects all live subscriptions on unmount', () => {
    const f = fixture();
    f.render(); flushFrames();
    f.state.transform = [1, 2, 0.5]; f.notify();
    expect(driver.frames.size).toBe(1);
    driver.effects.forEach(({ cleanup }) => cleanup?.());
    driver.effects = [];
    expect(driver.frames.size).toBe(0);
    expect(f.view.cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    expect(driver.observers.every(({ disconnect }) => disconnect.mock.calls.length === 1)).toBe(true);
    expect(f.media.removeEventListener).toHaveBeenCalled();
    expect([f.canvas.width, f.canvas.height]).toEqual([0, 0]);
  });

  it('requests SVG fallback once when drawing fails and stops scheduling', () => {
    const f = fixture();
    f.ctx.stroke.mockImplementation(() => { throw new Error('context failure'); });
    f.render(); flushFrames();
    expect(f.onUnavailable).toHaveBeenCalledOnce();
    f.state.transform = [1, 2, 0.5]; f.notify();
    driver.observers[0].callback();
    expect(driver.frames.size).toBe(0);
  });
});
