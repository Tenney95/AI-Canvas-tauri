/** 帧动画时钟仅驱动预览子树，保留逐帧和播放控件行为。 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const driver = vi.hoisted(() => ({ states: [] as unknown[], index: 0,
  deps: undefined as readonly unknown[] | undefined, cleanup: undefined as (() => void) | undefined,
  pending: [] as Array<() => void>, timers: new Map<number, () => void>(), nextTimer: 0,
  update: vi.fn(), transient: vi.fn(), history: vi.fn(), mode: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(component: T) => component,
  useState: <T,>(initial: T) => {
    const index = driver.index++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: T | ((previous: T) => T)) => {
      driver.states[index] = typeof value === 'function' ? (value as (previous: T) => T)(driver.states[index] as T) : value;
    }];
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    if (driver.deps?.length === deps.length && deps.every((value, index) => Object.is(value, driver.deps?.[index]))) return;
    driver.deps = deps;
    driver.pending.push(() => { driver.cleanup?.(); driver.cleanup = effect() ?? undefined; });
  },
}));
vi.mock('../../src/store/useAppStore', () => {
  const state = { updateNodeData: driver.update, updateNodeDataTransient: driver.transient, commitToHistory: driver.history };
  return { useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('../../src/i18n', () => ({ useT: () => (text: string, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, String(replacement)), text) }));
vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }));
import { AnimationNodePreview } from '../../src/components/nodes/AnimationNode';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
const base = { id: 'animation', data: { type: 'ai-animation', label: '动画' } as BaseNodeData,
  sheet: { cols: 4, rows: 2, frameCount: 8, action: 'idle' as const }, action: 'idle' as const,
  playingFrames: Array.from({ length: 8 }, (_, sourceIndex) => ({ sourceIndex, enabled: true, offsetX: 0, offsetY: 0 })),
  previewMode: 'playing' as const, fps: 8, loop: true, displaySrc: 'asset://sprite.png',
  preparingPreview: false, pageVisible: true, onPreviewModeChange: driver.mode };
let tree: unknown;
function render(patch: Partial<Parameters<typeof AnimationNodePreview>[0]> = {}) {
  driver.index = 0;
  tree = AnimationNodePreview({ ...base, ...patch });
  driver.pending.splice(0).forEach((effect) => effect());
}
function find(predicate: (element: Element) => boolean) {
  const element = elements(tree).find(predicate);
  if (!element) throw new Error('Missing animation preview control');
  return element;
}
const label = (name: string) => find((element) => element.props['aria-label'] === name);
const event = () => ({ stopPropagation: vi.fn() });
function click(name: string) { (label(name).props.onClick as (event: unknown) => void)(event()); }
function tick() { for (const callback of [...driver.timers.values()]) callback(); }
const counter = () => find((element) => element.props.className === 'animation-transport-counter').props.children;
beforeEach(() => {
  driver.states = []; driver.index = 0; driver.deps = undefined; driver.cleanup = undefined; driver.pending = [];
  driver.timers.clear(); driver.nextTimer = 0;
  driver.update.mockClear(); driver.transient.mockClear(); driver.history.mockClear(); driver.mode.mockClear();
  vi.stubGlobal('window', { setInterval: (callback: () => void) => { const id = ++driver.nextTimer; driver.timers.set(id, callback); return id; },
    clearInterval: (id: number) => { driver.timers.delete(id); } });
});
afterEach(() => { driver.cleanup?.(); });

describe('animation node preview playback', () => {
  it('autoplays, loops and keeps per-frame updates local to the preview without Store writes', () => {
    render();
    expect(driver.timers.size).toBe(1);
    expect(counter()).toEqual([1, '/', 8]);
    tick(); render();
    expect(counter()).toEqual([2, '/', 8]);
    expect(find((element) => element.type === 'img').props.style).toMatchObject({ left: '-100%' });
    for (let index = 0; index < 7; index += 1) tick();
    render();
    expect(counter()).toEqual([1, '/', 8]);
    expect(driver.update).not.toHaveBeenCalled();
    expect(driver.transient).not.toHaveBeenCalled();
    expect(driver.history).not.toHaveBeenCalled();
  });

  it('stops at the single-play last frame and restarts from the beginning on play', () => {
    render({ loop: false });
    for (let index = 0; index < 7; index += 1) { tick(); render({ loop: false }); }
    expect(counter()).toEqual([8, '/', 8]);
    expect(driver.timers.size).toBe(0);
    click('播放'); render({ loop: false });
    expect(counter()).toEqual([1, '/', 8]);
    expect(driver.timers.size).toBe(1);
  });

  it('keeps the current frame through pause, visibility, source and mode changes and preserves manual stepping', () => {
    render(); tick(); render();
    click('暂停'); render();
    expect(driver.timers.size).toBe(0);
    click('上一帧'); render(); expect(counter()).toEqual([1, '/', 8]);
    click('上一帧'); render(); expect(counter()).toEqual([8, '/', 8]);
    click('下一帧'); render(); expect(counter()).toEqual([1, '/', 8]);
    click('播放'); render(); tick(); render();
    render({ pageVisible: false }); expect(driver.timers.size).toBe(0);
    render({ pageVisible: false, displaySrc: 'asset://replacement.png' });
    render({ displaySrc: 'asset://replacement.png' });
    expect(counter()).toEqual([2, '/', 8]);
    expect(find((element) => element.type === 'img').props.src).toBe('asset://replacement.png');
    render({ previewMode: 'sheet' }); expect(driver.timers.size).toBe(0);
    expect(elements(tree).filter((element) => element.type === 'img')).toHaveLength(8);
    render(); expect(counter()).toEqual([2, '/', 8]);
    expect(driver.timers.size).toBe(1);
  });

  it('keeps mode, FPS/history and loop controls routed through their existing actions', () => {
    render();
    click('静态排布状态'); expect(driver.mode).toHaveBeenLastCalledWith('sheet');
    const fps = label('播放帧率');
    (fps.props.onPointerDown as (event: unknown) => void)(event());
    (fps.props.onChange as (event: unknown) => void)({ target: { value: '12' } });
    expect(driver.history).toHaveBeenCalledOnce();
    expect(driver.transient).toHaveBeenLastCalledWith('animation', { animationFps: 12 });
    click('循环播放'); expect(driver.update).toHaveBeenLastCalledWith('animation', { animationLoop: false });
    render({ loop: false }); click('单次播放'); render();
    expect(driver.update).toHaveBeenLastCalledWith('animation', { animationLoop: true });
    expect(counter()).toEqual([1, '/', 8]);
  });

  it('shows the existing preparation state and starts the same preview only after its source is ready', () => {
    render({ displaySrc: undefined, preparingPreview: true });
    expect(driver.timers.size).toBe(0);
    expect(elements(tree).some((element) => element.type === 'img')).toBe(false);
    expect(find((element) => element.props.role === 'status')).toBeDefined();
    render();
    expect(find((element) => element.type === 'img').props.src).toBe('asset://sprite.png');
    expect(driver.timers.size).toBe(1);
  });
});
