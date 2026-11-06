import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

const driver = vi.hoisted(() => ({
  state: {} as AppState, states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0, ids: 0,
  upload: vi.fn<() => Promise<{ dataUrl: string; fileName: string } | null>>(),
}));
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = driver.memoIndex++, previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { value: factory(), deps };
    }
    return driver.memos[index].value as T;
  };
  return {
    ...await vi.importActual<typeof import('react')>('react'),
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
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }) }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.state), { getState: () => driver.state }),
  generateId: () => String(++driver.ids),
}));
vi.mock('../../src/services/fileService', () => ({ uploadSourceFileToProject: driver.upload }));

import { useCanvasDrawing } from '../../src/hooks/useCanvasDrawing';

class Surface extends EventTarget {
  captures = new Set<number>();
  closest() { return null; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
}
let surface: Surface, win: EventTarget, frames: Map<number, FrameRequestCallback>, frameId: number;
let modalOpen: boolean;
function render() {
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  const view = useCanvasDrawing();
  driver.pending.splice(0).forEach((effect) => effect());
  return view;
}
function dispose() { driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; }
function pointer(x: number, y: number, pointerId = 1) {
  return { target: surface, currentTarget: surface, button: 0, pointerId, clientX: x, clientY: y,
    preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as ReactPointerEvent<HTMLDivElement>;
}
function flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); }
function start(tool: Parameters<ReturnType<typeof useCanvasDrawing>['chooseTool']>[0] = 'freehand') {
  render().chooseTool(tool);
  const view = render();
  view.handlePointerDownCapture(pointer(10, 10));
  return view;
}
function worldPoints(node: AppState['nodes'][number]) {
  return node.data.note?.points?.map((point) => ({ x: point.x + node.position.x, y: point.y + node.position.y }));
}

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.memos = []; driver.effects = []; driver.pending = []; driver.ids = 0;
  driver.state = {
    currentProjectId: 'project', nodes: [], selectedNodeIds: [], commitToHistory: vi.fn(),
    addNode: vi.fn((node: AppState['nodes'][number]) => { driver.state.commitToHistory(); driver.state.nodes = [...driver.state.nodes, node]; }),
    onNodesChange: vi.fn(), setSelectedNodeIds: vi.fn((ids: string[]) => { driver.state.selectedNodeIds = ids; }),
    deleteNode: vi.fn(), showToast: vi.fn(),
  } as unknown as AppState;
  surface = new Surface(); win = new EventTarget(); frames = new Map(); frameId = 0; modalOpen = false;
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
  vi.stubGlobal('window', Object.assign(win, { requestAnimationFrame: requestFrame }));
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('Element', Surface);
  vi.stubGlobal('document', { elementsFromPoint: () => [], querySelector: () => modalOpen ? surface : null });
  driver.upload.mockReset().mockResolvedValue(null);
});
afterEach(() => { dispose(); vi.unstubAllGlobals(); });

describe('canvas drawing gesture lifecycle', () => {
  it('publishes one immutable preview per frame, retains every accepted sample and commits the real endpoint once', () => {
    const view = start();
    view.handlePointerMoveCapture(pointer(10.5, 10));
    view.handlePointerMoveCapture(pointer(20, 30));
    view.handlePointerMoveCapture(pointer(30, 12));
    expect(frames.size).toBe(1);
    expect(render().draftNode).toBeNull();
    flush();
    const preview = render().draftNode!;
    expect(worldPoints(preview)).toEqual([{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 30, y: 12 }]);
    view.handlePointerMoveCapture(pointer(-5, 25));
    view.handlePointerUpCapture(pointer(-4.5, 25.5));
    view.handlePointerUpCapture(pointer(100, 100));
    flush();
    const node = driver.state.nodes[0];
    expect(worldPoints(node)).toEqual([...worldPoints(preview)!, { x: -5, y: 25 }, { x: -4.5, y: 25.5 }]);
    expect(worldPoints(preview)).toHaveLength(3);
    expect(node.position).toEqual({ x: -11, y: 4 });
    expect(node.data.note).toMatchObject({ width: 47, height: 32 });
    expect(driver.state.addNode).toHaveBeenCalledOnce();
    expect(driver.state.commitToHistory).toHaveBeenCalledOnce();
    expect(driver.state.selectedNodeIds).toEqual([node.id]);
    expect(render().draftNode).toBeNull();
    expect(surface.captures.size).toBe(0);
  });

  it.each(['rectangle', 'diamond', 'ellipse', 'arrow', 'line'] as const)('uses the pointerup position for an unflushed %s', (tool) => {
    const view = start(tool);
    view.handlePointerMoveCapture(pointer(20, 20));
    view.handlePointerUpCapture(pointer(70, 50));
    expect(driver.state.nodes[0].data.note).toMatchObject({ kind: tool, width: 60, height: 40 });
    expect(frames.size).toBe(0);
  });

  it.each(['pointercancel', 'lostcapture', 'blur', 'Escape', 'tool', 'project', 'unmount'])('drops the displayed draft, queued frame and late pointerup after %s', (reason) => {
    const view = start();
    flush();
    expect(render().draftNode).not.toBeNull();
    view.handlePointerMoveCapture(pointer(30, 40));
    if (reason === 'pointercancel' || reason === 'lostcapture') view.handlePointerCancelCapture(pointer(30, 40));
    if (reason === 'blur') win.dispatchEvent(new Event('blur'));
    if (reason === 'Escape') win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    if (reason === 'tool') view.chooseTool('rectangle');
    if (reason === 'project') { driver.state.currentProjectId = 'other'; render(); }
    if (reason === 'unmount') dispose();
    flush();
    view.handlePointerUpCapture(pointer(50, 50));
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.state.commitToHistory).not.toHaveBeenCalled();
    expect(surface.captures.size).toBe(0);
    expect(frames.size).toBe(0);
    if (reason !== 'unmount') {
      expect(render().draftNode).toBeNull();
      start().handlePointerUpCapture(pointer(40, 40));
      expect(driver.state.addNode).toHaveBeenCalledOnce();
    }
  });

  it('ignores a second pointer without replacing the active pointer or its samples', () => {
    const view = start();
    view.handlePointerDownCapture(pointer(300, 300, 2));
    view.handlePointerMoveCapture(pointer(400, 400, 2));
    view.handlePointerUpCapture(pointer(500, 500, 2));
    view.handlePointerCancelCapture(pointer(500, 500, 2));
    view.handlePointerMoveCapture(pointer(20, 30));
    view.handlePointerUpCapture(pointer(40, 50));
    expect(worldPoints(driver.state.nodes[0])).toEqual([{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 40, y: 50 }]);
    expect(driver.state.addNode).toHaveBeenCalledOnce();
  });

  it('rejects old pointer handlers after the Store switches project before React rerenders', () => {
    const view = start();
    driver.state.currentProjectId = 'other';
    view.handlePointerUpCapture(pointer(30, 40));
    view.handlePointerDownCapture(pointer(50, 60));
    flush();
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.state.commitToHistory).not.toHaveBeenCalled();
    expect(surface.captures.size).toBe(0);
    expect(frames.size).toBe(0);
  });

  it.each(['defaultPrevented', 'composing', 'legacyIME', 'modal', 'editor'])('leaves Escape to its owner during %s', (owner) => {
    const view = start();
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'Escape', isComposing: owner === 'composing', keyCode: owner === 'legacyIME' ? 229 : 27,
    });
    if (owner === 'defaultPrevented') event.preventDefault();
    if (owner === 'modal') modalOpen = true;
    if (owner === 'editor') Object.assign(win, { tagName: 'TEXTAREA' });
    win.dispatchEvent(event);
    expect(surface.hasPointerCapture(1)).toBe(true);
    view.handlePointerUpCapture(pointer(30, 40));
    expect(driver.state.addNode).toHaveBeenCalledOnce();
  });

  it('keeps click-to-create sizes, style choices and text editing intact', () => {
    render().chooseTool('rectangle');
    render().applyNotePatch({ style: { strokeWidth: 4 } });
    const shape = render();
    shape.handlePointerDownCapture(pointer(10, 10));
    shape.handlePointerUpCapture(pointer(10, 10));
    expect(driver.state.nodes[0].data.note).toMatchObject({ width: 160, height: 100, style: { strokeWidth: 4 } });
    const edit = vi.fn();
    win.addEventListener('canvas-note-edit-text', edit);
    start('text'); flush();
    expect(driver.state.nodes[1].data.note?.kind).toBe('text');
    expect(edit).toHaveBeenCalledOnce();
  });

  it('keeps eraser hits immediate and distinct without adding work on cancellation', () => {
    vi.stubGlobal('document', {
      elementsFromPoint: () => [{ closest: () => ({ dataset: { canvasNoteId: 'note' } }) }],
      querySelector: () => null,
    });
    const view = start('eraser');
    view.handlePointerMoveCapture(pointer(20, 20));
    view.handlePointerCancelCapture(pointer(20, 20));
    expect(driver.state.deleteNode).toHaveBeenCalledExactlyOnceWith('note');
    expect(driver.state.addNode).not.toHaveBeenCalled();
    expect(driver.state.commitToHistory).not.toHaveBeenCalled();
  });

  it('keeps native image selection alive across blur and prevents a result after changing tools', async () => {
    let resolve!: (value: { dataUrl: string; fileName: string }) => void;
    driver.upload.mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal('Image', class {
      naturalWidth = 320; naturalHeight = 200; onload?: () => void;
      set src(_value: string) { this.onload?.(); }
    });
    render().chooseTool('image'); win.dispatchEvent(new Event('blur'));
    resolve({ dataUrl: 'asset://image', fileName: 'image.png' });
    await new Promise<void>((done) => setImmediate(done));
    const image = render();
    expect(image.pendingImage?.fileName).toBe('image.png');
    image.handlePointerDownCapture(pointer(50, 60));
    expect(driver.state.nodes[0].data.note).toMatchObject({ kind: 'image', width: 320, height: 200 });
    render().chooseTool('image'); render().chooseTool('rectangle');
    resolve({ dataUrl: 'asset://late', fileName: 'late.png' });
    await new Promise<void>((done) => setImmediate(done));
    expect(render().pendingImage).toBeNull();
    expect(render().activeTool).toBe('rectangle');
  });
});
