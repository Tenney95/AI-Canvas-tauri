/** Compact panorama preparation, camera restoration and explicit capture. */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanoramaCoreHandle, PanoramaCoreProps } from '../../src/types/panorama';
import type { XiaoLuoPanoramaViewerHandle } from '../../src/components/nodes/panorama/XiaoLuoPanoramaViewer';

interface EffectSlot { deps: readonly unknown[]; cleanup?: () => void }
interface ElementLike { type: unknown; key?: string | null; props: Record<string, unknown> }
const driver = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, dirty: false, effects: [] as Array<() => void>,
  jobs: [] as Array<{ work: () => Promise<void>; cancelled: boolean }>,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const memoValue = <T,>(compute: () => T, deps: readonly unknown[]) => {
    const index = driver.cursor++;
    const previous = driver.slots[index] as { deps: readonly unknown[]; value: T } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
    const value = compute();
    driver.slots[index] = { deps, value };
    return value;
  };
  const effect = (work: () => void | (() => void), deps: readonly unknown[] = []) => {
    const index = driver.cursor++;
    const previous = driver.slots[index] as EffectSlot | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const slot: EffectSlot = { deps };
    driver.slots[index] = slot;
    driver.effects.push(() => { previous?.cleanup?.(); slot.cleanup = work() || undefined; });
  };
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    forwardRef: (render: (props: Record<string, unknown>, ref: unknown) => unknown) =>
      (props: Record<string, unknown>) => render(props, props.ref),
    useContext: () => null,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memoValue(() => callback, deps),
    useState: (initial: unknown) => {
      const index = driver.cursor++;
      if (!(index in driver.slots)) driver.slots[index] = initial;
      return [driver.slots[index], (next: unknown) => {
        const value = typeof next === 'function' ? next(driver.slots[index]) : next;
        if (!Object.is(value, driver.slots[index])) { driver.slots[index] = value; driver.dirty = true; }
      }];
    },
    useRef: (initial: unknown) => {
      const index = driver.cursor++;
      return driver.slots[index] ??= { current: initial };
    },
    useEffect: effect, useLayoutEffect: effect,
    useImperativeHandle: (ref: { current: unknown } | null, create: () => unknown) => { if (ref) ref.current = create(); },
  };
});
vi.mock('../../src/hooks/useCanvasNodeLod', () => ({ CanvasNodeLodContext: {} }));
vi.mock('../../src/services/canvasDisplayScheduler', () => ({
  createCanvasDisplayScheduler: () => ({
    prepare: (_key: object, work: () => Promise<void>) => {
      const job = { work, cancelled: false };
      driver.jobs.push(job);
      return () => { job.cancelled = true; };
    },
  }),
}));
vi.mock('../../src/i18n', () => ({ useT: () => (message: string) => message }));
vi.mock('../../src/components/nodes/panorama/internal/PanoramaCore', () => ({ PanoramaCore: 'panorama-core' }));

import Viewer from '../../src/components/nodes/panorama/XiaoLuoPanoramaViewer';

function elements(value: unknown): ElementLike[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ElementLike;
  return [element, ...elements(element.props.children)];
}

function createSession() {
  const ref = { current: null as XiaoLuoPanoramaViewerHandle | null };
  const view = { pitch: 12, yaw: 73, hfov: 88 };
  const core: PanoramaCoreHandle = {
    captureScreenshot: vi.fn(() => 'data:image/png;base64,preview'),
    getView: () => ({ ...view }), focus: vi.fn(), reset: vi.fn(), resize: vi.fn(), setView: vi.fn(),
  };
  let imageUrl = 'panorama-a';
  let interactive = false;
  let tree: unknown;
  let coreElement: ElementLike | undefined;
  const dispose = () => {
    for (const slot of driver.slots) (slot as EffectSlot | undefined)?.cleanup?.();
    driver.slots = []; driver.effects = []; driver.cursor = 0;
  };
  const render = (nextInteractive = interactive, nextSource = imageUrl) => {
    if (imageUrl !== nextSource) dispose();
    imageUrl = nextSource; interactive = nextInteractive;
    let attempts = 0;
    do {
      if (++attempts > 10) throw new Error('Panorama hook driver did not settle');
      driver.dirty = false; driver.cursor = 0;
      const outer = (Viewer as unknown as (props: object) => ReactElement<Record<string, unknown>>)({ imageUrl, interactive, ref });
      tree = (outer.type as (props: object) => unknown)(outer.props);
      const nextCore = elements(tree).find((element) => element.type === 'panorama-core');
      if (coreElement && !nextCore) (coreElement.props.ref as { current: unknown }).current = null;
      coreElement = nextCore;
      if (coreElement) (coreElement.props.ref as { current: unknown }).current = core;
      const effects = driver.effects.splice(0);
      for (const effect of effects) effect();
    } while (driver.dirty);
    return elements(tree);
  };
  const props = () => {
    if (!coreElement) throw new Error('Expected a live panorama core');
    return coreElement.props as unknown as PanoramaCoreProps;
  };
  return { ref, view, core, render, props, dispose };
}

beforeEach(() => {
  driver.slots = []; driver.cursor = 0; driver.effects = []; driver.jobs = []; driver.dirty = false;
});
afterEach(() => {
  for (const slot of driver.slots) (slot as EffectSlot | undefined)?.cleanup?.();
  vi.unstubAllGlobals();
});

describe('compact panorama resource lifetime', () => {
  it('prepares an idle cover through the shared budget and releases the Core', async () => {
    const session = createSession();
    expect(session.render().some((element) => element.type === 'panorama-core')).toBe(false);
    expect(driver.jobs).toHaveLength(1);
    const prepared = driver.jobs[0].work();
    session.render();
    session.props().onLoad?.();
    const tree = session.render();
    expect(tree.some((element) => element.type === 'panorama-core')).toBe(false);
    expect(tree.find((element) => element.type === 'img')?.props.src).toBe('data:image/png;base64,preview');
    await prepared;
    session.dispose();
  });

  it('restores the last camera and prepares the original renderer for a static capture', async () => {
    const session = createSession();
    session.render(true);
    session.props().onLoad?.(); session.render();
    session.render(false);
    const capture = session.ref.current!.captureScreenshot();
    session.render(false);
    expect(session.props()).toMatchObject({ initialPitch: 12, initialYaw: 73, initialHfov: 88 });
    session.props().onLoad?.(); session.render();
    expect(await capture).toBe('data:image/png;base64,preview');
    expect(session.core.captureScreenshot).toHaveBeenCalledTimes(2);
    session.render(true);
    expect(session.props()).toMatchObject({ initialPitch: 12, initialYaw: 73, initialHfov: 88 });
    expect(driver.jobs).toHaveLength(0);
    session.dispose();
  });

  it('retains the live fallback on capture failure and resolves captures on source disposal', async () => {
    const session = createSession();
    vi.mocked(session.core.captureScreenshot).mockReturnValue(null);
    session.render(true);
    session.props().onLoad?.(); session.render(false);
    expect(session.props()).toBeDefined();
    // Retry / source replacement cannot leave a waiting capture tied to an old Core.
    session.render(false, 'panorama-b');
    const capture = session.ref.current!.captureScreenshot();
    session.render(false);
    session.dispose();
    expect(await capture).toBeNull();
    expect(driver.jobs.at(-1)?.cancelled).toBe(true);
  });

  it('cancels queued work when interaction takes priority and reports load errors', async () => {
    const session = createSession();
    session.render();
    session.render(true);
    expect(driver.jobs[0].cancelled).toBe(true);
    const capture = session.ref.current!.captureScreenshot();
    session.props().onError?.('Cannot load panorama');
    session.render();
    expect(await capture).toBeNull();
    expect(await session.ref.current!.captureScreenshot()).toBeNull();
    session.dispose();
  });

  it('bounds a stalled capture without cancelling the viewer or a later capture', async () => {
    const timeouts: Array<() => void> = [];
    vi.stubGlobal('setTimeout', (callback: () => void) => timeouts.push(callback));
    vi.stubGlobal('clearTimeout', vi.fn());
    const session = createSession();
    session.render(true);
    const stalled = session.ref.current!.captureScreenshot();
    timeouts[0]();
    expect(await stalled).toBeNull();
    const retry = session.ref.current!.captureScreenshot();
    session.props().onLoad?.(); session.render();
    expect(await retry).toBe('data:image/png;base64,preview');
    expect(session.props()).toBeDefined();
    session.dispose();
  });
});
