import type { AppConfig } from '../../src/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  state: {
    currentProjectId: 'episode-1', configHydrated: true,
    config: {} as Pick<AppConfig, 'canvasViewportMode' | 'canvasViewportZoom' | 'canvasViewportMinZoom' | 'canvasViewportMaxZoom'>,
    updateConfig: vi.fn(), saveConfig: vi.fn(),
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  flow: {
    viewportInitialized: true, getViewport: vi.fn(), getZoom: vi.fn(), getNodes: vi.fn(),
    setViewport: vi.fn(), fitView: vi.fn(), zoomTo: vi.fn(),
  },
  refs: [] as Array<{ current: unknown }>, states: [] as unknown[],
  memos: [] as Array<{ deps: readonly unknown[]; value: unknown }>,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>, refIndex: 0, stateIndex: 0, memoIndex: 0, effectIndex: 0,
}));

vi.mock('react', async () => {
  const memo = (create: () => unknown, deps: readonly unknown[]) => {
    const index = driver.memoIndex++;
    const previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      driver.memos[index] = { deps, value: create() };
    }
    return driver.memos[index].value;
  };
  return {
    ...await vi.importActual<typeof import('react')>('react'),
    useMemo: memo, useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useRef: (initial: unknown) => {
      const index = driver.refIndex++;
      driver.refs[index] ??= { current: initial };
      return driver.refs[index];
    },
    useState: (initial: unknown) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? initial() : initial;
      return [driver.states[index], (value: unknown) => { driver.states[index] = value; }];
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock('@xyflow/react', () => ({ useReactFlow: () => driver.flow }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((select: (state: typeof driver.state) => unknown) => select(driver.state), {
    getState: () => driver.state,
  }),
}));

import { useCanvasViewportPreferences } from '../../src/hooks/useCanvasViewportPreferences';
import { readCanvasViewport, saveCanvasViewport } from '../../src/services/canvasViewportPersistence';

const rootRef = { current: { clientWidth: 1200, clientHeight: 800 } as HTMLDivElement };
const cancelRef = { current: null };
function ViewportProbe() { return useCanvasViewportPreferences(rootRef, cancelRef); }
function renderProbe() {
  driver.refIndex = driver.stateIndex = driver.memoIndex = driver.effectIndex = 0;
  const result = ViewportProbe();
  driver.pending.splice(0).forEach((effect) => effect());
  return result;
}
function unmount() {
  driver.effects.forEach(({ cleanup }) => cleanup?.());
  driver.effects = []; driver.memos = []; driver.refs = []; driver.states = []; driver.pending = [];
}

beforeEach(() => {
  const records = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value) });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  driver.viewport = { x: 0, y: 0, zoom: 1 };
  driver.state.currentProjectId = 'episode-1';
  driver.state.config = { canvasViewportMode: 'manual', canvasViewportZoom: 1.5 };
  driver.state.updateConfig.mockReset().mockImplementation((patch) => {
    driver.state.config = { ...driver.state.config, ...patch };
  });
  driver.state.saveConfig.mockReset().mockResolvedValue(undefined);
  driver.flow.getViewport.mockReset().mockImplementation(() => driver.viewport);
  driver.flow.getZoom.mockReset().mockImplementation(() => driver.viewport.zoom);
  driver.flow.getNodes.mockReset().mockReturnValue([{ id: 'image', hidden: false }]);
  driver.flow.setViewport.mockReset().mockImplementation(async (viewport) => { driver.viewport = viewport; return true; });
  driver.flow.fitView.mockReset().mockResolvedValue(true);
  driver.flow.zoomTo.mockReset().mockResolvedValue(true);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('opening a project at its last viewport', () => {
  it('restores before first paint and does not recenter again on a delayed project-open signal', async () => {
    const saved = { x: -3200, y: -8400, zoom: 0.57, width: 1200, height: 800 };
    saveCanvasViewport('episode-1', saved);
    const view = renderProbe();
    await view.restoreInitialView();
    view.markViewportReady();
    expect(view.initialFit).toBe(false);
    expect(driver.flow.setViewport).toHaveBeenCalledOnce();
    expect(driver.viewport.x).toBeCloseTo(saved.x);
    expect(driver.viewport.y).toBeCloseTo(saved.y);
    expect(driver.viewport.zoom).toBe(0.57);
    expect(driver.flow.fitView).not.toHaveBeenCalled();
    expect(driver.flow.zoomTo).not.toHaveBeenCalled();

    const moved = { x: -700, y: -12000, zoom: 0.85 };
    driver.viewport = moved;
    view.recordViewport(moved, saved);
    expect(readCanvasViewport('episode-1')?.zoom).toBe(0.57);
    window.dispatchEvent(new Event('beforeunload'));
    expect(readCanvasViewport('episode-1')).toMatchObject(moved);
    await renderProbe().restoreInitialView();
    expect(driver.flow.setViewport).toHaveBeenCalledOnce();
    expect(driver.viewport).toEqual(moved);

    driver.state.currentProjectId = 'episode-2';
    driver.viewport = { x: 0, y: 0, zoom: 2 };
    unmount();
    expect(readCanvasViewport('episode-1')).toMatchObject(moved);
    expect(readCanvasViewport('episode-2')).toBeNull();
  });

  it('only fits once for an unseen project and still allows explicit user auto-fit', async () => {
    const view = renderProbe();
    await view.restoreInitialView();
    view.markViewportReady();
    await view.restoreInitialView();
    expect(view.initialFit).toBe(true);
    expect(driver.flow.fitView).toHaveBeenCalledOnce();
    view.autoFit();
    expect(driver.flow.fitView).toHaveBeenCalledTimes(2);
    expect(driver.state.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ canvasViewportMode: 'auto' }));
  });
});
