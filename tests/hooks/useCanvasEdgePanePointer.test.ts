import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => {
  const state = {
    elementsSelectable: true,
    paneDragging: false,
    userSelectionActive: false,
    userSelectionRect: null as { width: number; height: number } | null,
    connection: { inProgress: false },
    transform: [0, 0, 1],
  };
  return {
    state,
    store: {
      getState: () => state,
      setState: vi.fn((patch: Partial<typeof state>) => { Object.assign(state, patch); }),
    },
    refs: [] as Array<{ current: unknown }>,
    memos: [] as Array<{ deps: readonly unknown[]; value: unknown }>,
    effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
    pending: [] as Array<() => void>,
    refIndex: 0, memoIndex: 0, effectIndex: 0,
  };
});

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useRef: <T>(initial: T) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useMemo: (create: () => unknown, deps: readonly unknown[]) => {
    const index = driver.memoIndex++;
    const previous = driver.memos[index];
    if (!previous || previous.deps.length !== deps.length
      || !deps.every((dep, i) => Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { deps, value: create() };
    }
    return driver.memos[index].value;
  },
  useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
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
vi.mock('@xyflow/react', () => ({ useStoreApi: () => driver.store }));

import { useCanvasEdgePanePointer } from '../../src/hooks/useCanvasEdgePanePointer';

class Surface extends EventTarget {
  readonly classes: Set<string>;
  readonly classList = { contains: (name: string) => this.classes.has(name) };
  readonly captures = new Set<number>();
  readonly hasPointerCapture = vi.fn((id: number) => this.captures.has(id));
  readonly releasePointerCapture = vi.fn((id: number) => { this.captures.delete(id); });
  parentPane: Surface | null = null;

  constructor(...classes: string[]) {
    super();
    this.classes = new Set(classes);
  }

  closest(selector: string) {
    return selector === '.react-flow__pane' ? this.parentPane : null;
  }
}

function pointer(target: Surface, extras: Partial<ReactPointerEvent<HTMLDivElement>> = {}) {
  return {
    target, clientX: 100, clientY: 200, pointerId: 1, button: 0, isPrimary: true, detail: 1,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extras,
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

function click(target: Surface, extras: Partial<ReactMouseEvent<HTMLDivElement>> = {}) {
  return {
    target, clientX: 100, clientY: 200, button: 0, detail: 1,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extras,
  } as unknown as ReactMouseEvent<HTMLDivElement>;
}

function HookProbe(enabled = true) {
  return useCanvasEdgePanePointer(enabled);
}

function renderProbe(enabled = true) {
  driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  const result = HookProbe(enabled);
  driver.pending.splice(0).forEach((effect) => effect());
  return result;
}

function probe(enabled = true) {
  const result = renderProbe(enabled);
  const bridge = vi.fn(() => true);
  const hitTest = vi.fn(() => true);
  result.bridge.current = { handle: bridge, hitTest };
  const pane = new Surface('react-flow__pane');
  return { ...result, bridgeRef: result.bridge, bridge, hitTest, pane };
}

function untouched(event: ReactMouseEvent<HTMLDivElement>) {
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
}

function unmount() {
  driver.effects.forEach(({ cleanup }) => cleanup?.());
  driver.effects = [];
}

beforeEach(() => {
  driver.refs = []; driver.memos = []; driver.effects = []; driver.pending = [];
  driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  Object.assign(driver.state, {
    elementsSelectable: true, paneDragging: false, userSelectionActive: false,
    userSelectionRect: null, connection: { inProgress: false }, transform: [0, 0, 1],
  });
  driver.store.setState.mockClear();
  vi.stubGlobal('Element', Surface);
});

afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('bitmap edge picking from a stationary pane gesture', () => {
  it('exposes a read-only hit probe without starting a selection gesture', () => {
    const { isEdgeAtPoint, bridgeRef, bridge, hitTest } = probe();
    expect(isEdgeAtPoint({ x: 100, y: 200 })).toBe(true);
    expect(hitTest).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 200 });
    expect(bridge).not.toHaveBeenCalled();
    expect(driver.store.setState).not.toHaveBeenCalled();
    hitTest.mockReturnValue(false);
    expect(isEdgeAtPoint({ x: 500, y: 200 })).toBe(false);
    bridgeRef.current = null;
    expect(isEdgeAtPoint({ x: 100, y: 200 })).toBe(false);
  });

  it('does not probe hidden edges or drawing tools, and keeps the probe stable while enabled', () => {
    const { isEdgeAtPoint, hitTest } = probe();
    expect(renderProbe(true).isEdgeAtPoint).toBe(isEdgeAtPoint);
    expect(renderProbe(false).isEdgeAtPoint({ x: 100, y: 200 })).toBe(false);
    expect(hitTest).not.toHaveBeenCalled();
  });

  it('selects once before Pane pointerup clearing, releases capture, then consumes only the following click', () => {
    const { handlers, bridge, pane } = probe();
    const down = pointer(pane);
    handlers.onPointerDownCapture(down);
    // React Flow starts this zero-size selection before the pointer is released.
    driver.state.userSelectionRect = { width: 0, height: 0 };
    pane.captures.add(1);
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);

    expect(bridge).toHaveBeenCalledExactlyOnceWith(up, 'click');
    expect(driver.store.setState).toHaveBeenCalledExactlyOnceWith({ userSelectionActive: false, userSelectionRect: null });
    expect(pane.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    expect(up.preventDefault).toHaveBeenCalledOnce();
    expect(up.stopPropagation).toHaveBeenCalledOnce();
    untouched(down);

    const followup = click(pane);
    handlers.onClickCapture(followup);
    expect(followup.preventDefault).toHaveBeenCalledOnce();
    expect(followup.stopPropagation).toHaveBeenCalledOnce();
    expect(bridge).toHaveBeenCalledOnce();
    const later = click(pane);
    handlers.onClickCapture(later);
    untouched(later);
  });

  it('leaves a missed hit and the native pane selection lifecycle untouched', () => {
    const { handlers, bridge, pane } = probe();
    bridge.mockReturnValue(false);
    handlers.onPointerDownCapture(pointer(pane));
    driver.state.userSelectionRect = { width: 0, height: 0 };
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    const followup = click(pane);
    handlers.onClickCapture(followup);

    expect(bridge).toHaveBeenCalledExactlyOnceWith(up, 'click');
    expect(driver.store.setState).not.toHaveBeenCalled();
    expect(driver.state.userSelectionRect).toEqual({ width: 0, height: 0 });
    expect(pane.releasePointerCapture).not.toHaveBeenCalled();
    untouched(up); untouched(followup);
  });

  it('does not query geometry while moving and rejects a drag which returns to its starting point', () => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerMoveCapture(pointer(pane, { clientX: 105 }));
    handlers.onPointerMoveCapture(pointer(pane));
    expect(bridge).not.toHaveBeenCalled();
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
  });

  it('checks release distance even if no pointermove was delivered', () => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    const up = pointer(pane, { clientY: 202 });
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
  });

  it.each([0, 1, 2])('rejects a change of viewport transform component %i, including in-place mutation', (component) => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    driver.state.transform[component] += 1;
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
  });

  it.each(['react-flow__node', 'react-flow__panel', 'canvas-edge-delete-control'])('does not capture %s even when it is inside the pane', (className) => {
    const { handlers, bridge, pane } = probe();
    const child = new Surface(className);
    child.parentPane = pane;
    handlers.onPointerDownCapture(pointer(child));
    const up = pointer(child);
    handlers.onPointerUpCapture(up);
    const doubleClick = click(child, { detail: 2 });
    handlers.onDoubleClickCapture(doubleClick);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up); untouched(doubleClick);

    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerUpCapture(pointer(child));
    expect(bridge).not.toHaveBeenCalled();
  });

  it.each(['hidden edges', 'drawing tool'])('stays inactive when disabled for %s', () => {
    const { handlers, bridge, pane } = probe(false);
    handlers.onPointerDownCapture(pointer(pane));
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    const doubleClick = click(pane, { detail: 2 });
    handlers.onDoubleClickCapture(doubleClick);
    expect(bridge).not.toHaveBeenCalled();
    expect(driver.store.setState).not.toHaveBeenCalled();
    untouched(up); untouched(doubleClick);
  });

  it.each(['elementsSelectable', 'userSelectionActive', 'connection'] as const)('does not interfere when %s disallows selection at release', (key) => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    if (key === 'connection') driver.state.connection.inProgress = true;
    else if (key === 'elementsSelectable') driver.state.elementsSelectable = false;
    else driver.state[key] = true;
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    const doubleClick = click(pane, { detail: 2 });
    handlers.onDoubleClickCapture(doubleClick);
    expect(bridge).not.toHaveBeenCalled();
    expect(driver.store.setState).not.toHaveBeenCalled();
    untouched(up); untouched(doubleClick);
  });

  it('accepts a stationary classic-mode tap while mousedown is still marked as paneDragging', () => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    // XYPanZoom marks mousedown as dragging before it knows whether the pointer moves;
    // pointerup capture runs before the later mouseup clears this flag.
    driver.state.paneDragging = true;
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).toHaveBeenCalledExactlyOnceWith(up, 'click');
    expect(up.preventDefault).toHaveBeenCalledOnce();
    expect(up.stopPropagation).toHaveBeenCalledOnce();
    expect(driver.state.paneDragging).toBe(true);
    driver.state.paneDragging = false;
    const followup = click(pane);
    handlers.onClickCapture(followup);
    expect(followup.stopPropagation).toHaveBeenCalledOnce();
  });

  it.each(['move', 'transform'] as const)('still rejects a real classic-mode drag detected through %s', (change) => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    driver.state.paneDragging = true;
    if (change === 'move') {
      handlers.onPointerMoveCapture(pointer(pane, { clientX: 110 }));
      handlers.onPointerMoveCapture(pointer(pane));
    } else driver.state.transform[0] += 10;
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    expect(driver.store.setState).not.toHaveBeenCalled();
    untouched(up);
  });

  it('does not start a new tap when the pane was already dragging at pointerdown', () => {
    const { handlers, bridge, pane } = probe();
    driver.state.paneDragging = true;
    handlers.onPointerDownCapture(pointer(pane));
    driver.state.paneDragging = false;
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    expect(driver.store.setState).not.toHaveBeenCalled();
    untouched(up);
  });

  it('cancels the first touch when a second non-primary pointer appears', () => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane, { pointerType: 'touch' }));
    handlers.onPointerDownCapture(pointer(pane, { pointerType: 'touch', pointerId: 2, isPrimary: false }));
    const up = pointer(pane, { pointerType: 'touch' });
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
  });

  it.each(['onPointerCancelCapture', 'onPointerLeave', 'onWheelCapture'] as const)('%s cancels a pending tap without querying geometry', (name) => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    handlers[name]();
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
    // A cancelled gesture does not disable the next fresh tap.
    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerUpCapture(pointer(pane));
    expect(bridge).toHaveBeenCalledOnce();
  });

  it.each([
    { button: 1 }, { button: 2 }, { isPrimary: false },
  ])('preserves native behavior for a non-primary gesture: %j', (extras) => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane, extras));
    const up = pointer(pane, extras);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
  });

  it('requires the same pointer and pane at release', () => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerUpCapture(pointer(pane, { pointerId: 2 }));
    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerUpCapture(pointer(new Surface('react-flow__pane')));
    expect(bridge).not.toHaveBeenCalled();
  });

  it('blocks background double-click creation only when the edge bridge consumes the gesture', () => {
    const { handlers, bridge, pane } = probe();
    const hit = click(pane, { detail: 2 });
    handlers.onDoubleClickCapture(hit);
    expect(bridge).toHaveBeenCalledExactlyOnceWith(hit, 'doubleClick');
    expect(hit.preventDefault).toHaveBeenCalledOnce();
    expect(hit.stopPropagation).toHaveBeenCalledOnce();
    bridge.mockReturnValue(false);
    const miss = click(pane, { detail: 2 });
    handlers.onDoubleClickCapture(miss);
    untouched(miss);
  });

  it('does not suppress keyboard clicks or retain a handled tap across another pointerdown', () => {
    const { handlers, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerUpCapture(pointer(pane));
    const keyboardClick = click(pane, { detail: 0 });
    handlers.onClickCapture(keyboardClick);
    untouched(keyboardClick);

    handlers.onPointerDownCapture(pointer(pane));
    handlers.onPointerUpCapture(pointer(pane));
    handlers.onPointerDownCapture(pointer(new Surface('react-flow__node')));
    const unrelatedClick = click(pane);
    handlers.onClickCapture(unrelatedClick);
    untouched(unrelatedClick);
  });

  it('drops pending gestures and click suppression across disable/re-enable and unmount', () => {
    const { handlers, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    renderProbe(false);
    const reenabled = renderProbe(true);
    reenabled.handlers.onPointerUpCapture(pointer(pane));
    expect(bridge).not.toHaveBeenCalled();
    reenabled.handlers.onPointerDownCapture(pointer(pane));
    reenabled.handlers.onPointerUpCapture(pointer(pane));
    expect(bridge).toHaveBeenCalledOnce();
    renderProbe(false);
    const afterDisable = renderProbe(true);
    const clickAfterDisable = click(pane);
    afterDisable.handlers.onClickCapture(clickAfterDisable);
    untouched(clickAfterDisable);
    afterDisable.handlers.onPointerDownCapture(pointer(pane));
    unmount();
    afterDisable.handlers.onPointerUpCapture(pointer(pane));
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('reads the current bridge at release and leaves events alone when no edge layer is registered', () => {
    const { handlers, bridgeRef, bridge, pane } = probe();
    handlers.onPointerDownCapture(pointer(pane));
    bridgeRef.current = null;
    const up = pointer(pane);
    handlers.onPointerUpCapture(up);
    expect(bridge).not.toHaveBeenCalled();
    untouched(up);
    const replacement = vi.fn(() => true);
    handlers.onPointerDownCapture(pointer(pane));
    bridgeRef.current = { handle: replacement, hitTest: vi.fn(() => true) };
    handlers.onPointerUpCapture(pointer(pane));
    expect(replacement).toHaveBeenCalledOnce();
  });
});
