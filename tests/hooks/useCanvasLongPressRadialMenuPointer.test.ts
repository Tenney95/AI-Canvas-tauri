import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  callbacks: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, callbackIndex: 0, effectIndex: 0,
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T>(initial: T) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: T) => { driver.states[index] = value; }];
  },
  useRef: <T>(initial: T) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const index = driver.callbackIndex++;
    const previous = driver.callbacks[index];
    if (!previous || previous.deps.length !== deps.length
      || !deps.every((dep, i) => Object.is(dep, previous.deps[i]))) {
      driver.callbacks[index] = { value: callback, deps };
    }
    return driver.callbacks[index].value;
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps && previous.deps?.length === deps.length
      && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    driver.pending.push(() => {
      previous?.cleanup?.();
      driver.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

import {
  CANVAS_LONG_PRESS_DELAY_MS,
  CANVAS_LONG_PRESS_INDICATOR_DELAY_MS,
  useCanvasLongPressRadialMenu,
} from '../../src/hooks/useCanvasLongPressRadialMenu';

class Surface extends EventTarget {
  readonly classes: Set<string>;
  readonly classList = { contains: (name: string) => this.classes.has(name) };
  parent: Surface | null = null;
  radialMenu = false;

  constructor(...classes: string[]) {
    super();
    this.classes = new Set(classes);
  }

  contains(target: unknown) {
    for (let current = target; current instanceof Surface; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector: string): Surface | null {
    const selectors = selector.split(',').map((part) => part.trim());
    if (selectors.some((part) => part === '[data-canvas-radial-menu]'
      ? this.radialMenu : part.startsWith('.') && this.classes.has(part.slice(1)))) return this;
    return this.parent?.closest(selector) ?? null;
  }
}

function HookProbe(rootRef: RefObject<HTMLElement | null>, enabled: boolean, isEdgeAtPoint?: (point: { x: number; y: number }) => boolean) {
  driver.stateIndex = driver.refIndex = driver.callbackIndex = driver.effectIndex = 0;
  const result = useCanvasLongPressRadialMenu(rootRef, enabled, isEdgeAtPoint);
  driver.pending.splice(0).forEach((effect) => effect());
  return result;
}

function probe(edgeHit = false, enabled = true) {
  const root = new Surface('canvas-drawing-root');
  const pane = new Surface('react-flow__pane');
  pane.parent = root;
  const rootRef = { current: root as unknown as HTMLElement };
  const isEdgeAtPoint = vi.fn(() => edgeHit);
  const snapshot = () => HookProbe(rootRef, enabled, isEdgeAtPoint);
  snapshot();
  const dispatch = (type: string, target: Surface = pane, extras: Partial<PointerEvent> = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, { pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 200, ...extras });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    root.dispatchEvent(event);
    return { event, preventDefault, stopPropagation };
  };
  return { root, pane, isEdgeAtPoint, snapshot, dispatch };
}

function unmount() {
  driver.effects.forEach(({ cleanup }) => cleanup?.());
  driver.effects = [];
}

let clearSelection: ReturnType<typeof vi.fn>;
let getSelection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  driver.states = []; driver.refs = []; driver.callbacks = []; driver.effects = []; driver.pending = [];
  driver.stateIndex = driver.refIndex = driver.callbackIndex = driver.effectIndex = 0;
  clearSelection = vi.fn();
  getSelection = vi.fn(() => ({ removeAllRanges: clearSelection }));
  vi.stubGlobal('Element', Surface);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { getSelection }));
});

afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('canvas long-press pointer target excludes bitmap edge geometry', () => {
  it('does not show a hold indicator or radial menu when the DOM target is the pane but geometry is an edge', () => {
    const test = probe(true);
    test.dispatch('pointerdown');
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 500);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
    expect(test.isEdgeAtPoint).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 200 });
    expect(vi.getTimerCount()).toBe(0);
    expect(getSelection).not.toHaveBeenCalled();
  });

  it.each([true, false])('queries geometry only on pointerdown, never on pointermove (edge hit: %s)', (hit) => {
    const test = probe(hit);
    test.dispatch('pointerdown');
    for (let i = 1; i <= 20; i++) test.dispatch('pointermove', test.pane, { clientX: 100 + i / 10 });
    expect(test.isEdgeAtPoint).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 200 });
    test.dispatch('pointerup');
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 100);
    expect(test.isEdgeAtPoint).toHaveBeenCalledOnce();
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
  });

  it('keeps the existing 180ms indicator and 480ms menu timing for a true blank-pane miss', () => {
    const test = probe(false);
    test.dispatch('pointerdown');
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_INDICATOR_DELAY_MS - 1);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
    vi.advanceTimersByTime(1);
    expect(test.snapshot()).toMatchObject({ holdPosition: { x: 100, y: 200 }, position: null });
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS - CANVAS_LONG_PRESS_INDICATOR_DELAY_MS - 1);
    expect(test.snapshot()).toMatchObject({ holdPosition: { x: 100, y: 200 }, position: null });
    vi.advanceTimersByTime(1);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: { x: 100, y: 200 } });
    expect(test.isEdgeAtPoint).toHaveBeenCalledOnce();
    expect(clearSelection).toHaveBeenCalledOnce();
  });

  it('leaves edge pointer events available to selection and other native handlers', () => {
    const test = probe(true);
    const down = test.dispatch('pointerdown');
    const move = test.dispatch('pointermove', test.pane, { clientX: 101 });
    const up = test.dispatch('pointerup');
    for (const result of [down, move, up]) {
      expect(result.event.defaultPrevented).toBe(false);
      expect(result.preventDefault).not.toHaveBeenCalled();
      expect(result.stopPropagation).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
  });

  it.each(['react-flow__node', 'react-flow__edge', 'react-flow__controls', 'radial-menu'])('does not query geometry for %s or its descendants', (kind) => {
    const test = probe(false);
    const excluded = new Surface(kind);
    excluded.radialMenu = kind === 'radial-menu';
    excluded.parent = test.pane;
    const child = new Surface('child');
    child.parent = excluded;
    test.dispatch('pointerdown', child);
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.isEdgeAtPoint).not.toHaveBeenCalled();
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
  });

  it('does not query geometry for a pane outside the canvas root', () => {
    const test = probe(false);
    test.dispatch('pointerdown', new Surface('react-flow__pane'));
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.isEdgeAtPoint).not.toHaveBeenCalled();
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
  });

  it.each([{ button: 1 }, { button: 2 }, { isPrimary: false }])('does not query geometry for a non-primary left press: %j', (extras) => {
    const test = probe(false);
    test.dispatch('pointerdown', test.pane, extras);
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.isEdgeAtPoint).not.toHaveBeenCalled();
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
  });

  it('cancels an existing pending press before rejecting a second non-primary touch', () => {
    const test = probe(false);
    test.dispatch('pointerdown', test.pane, { pointerType: 'touch' });
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_INDICATOR_DELAY_MS);
    expect(test.snapshot().holdPosition).toEqual({ x: 100, y: 200 });
    test.dispatch('pointerdown', test.pane, { pointerId: 2, pointerType: 'touch', isPrimary: false });
    expect(test.snapshot().holdPosition).toBeNull();
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
    expect(test.isEdgeAtPoint).toHaveBeenCalledOnce();
    expect(getSelection).not.toHaveBeenCalled();
  });

  it('cancels an existing blank hold before rejecting a new geometry hit', () => {
    const test = probe(false);
    test.dispatch('pointerdown');
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_INDICATOR_DELAY_MS);
    expect(test.snapshot().holdPosition).toEqual({ x: 100, y: 200 });
    test.isEdgeAtPoint.mockReturnValue(true);
    test.dispatch('pointerdown', test.pane, { pointerId: 2, clientX: 300, clientY: 400 });
    expect(test.snapshot().holdPosition).toBeNull();
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
    expect(test.isEdgeAtPoint).toHaveBeenCalledTimes(2);
    expect(test.isEdgeAtPoint).toHaveBeenLastCalledWith({ x: 300, y: 400 });
    expect(getSelection).not.toHaveBeenCalled();
  });

  it('cancels an existing hold before rejecting a new press on a DOM node', () => {
    const test = probe(false);
    test.dispatch('pointerdown');
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_INDICATOR_DELAY_MS);
    const node = new Surface('react-flow__node');
    node.parent = test.pane;
    test.dispatch('pointerdown', node);
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
    expect(test.isEdgeAtPoint).toHaveBeenCalledOnce();
  });

  it('keeps a disabled drawing hook free of geometry probes and timers', () => {
    const test = probe(false, false);
    test.dispatch('pointerdown');
    vi.advanceTimersByTime(CANVAS_LONG_PRESS_DELAY_MS + 1);
    expect(test.isEdgeAtPoint).not.toHaveBeenCalled();
    expect(test.snapshot()).toMatchObject({ holdPosition: null, position: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});
