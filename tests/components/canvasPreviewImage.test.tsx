/**
 * canvasPreviewImage — 回归测试：canvas preview image integration。
 */
import type { ImgHTMLAttributes, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayImageLease } from '../../src/components/nodes/shared/image/canvasImageDisplay';

const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, effectIndex: 0, zoom: 1,
  rendering: false, rerender: false,
  listeners: new Set<() => void>(), create: vi.fn(),
  config: { performanceMode: false },
  configListeners: new Set<(state: { config: { performanceMode: boolean } }, previous: { config: { performanceMode: boolean } }) => void>(),
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++; const previous = driver.effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    driver.pending.push(() => { previous?.cleanup?.(); driver.effects[index] = { deps, cleanup: run() ?? undefined }; });
  };
  return { ...actual, memo: <T,>(value: T) => value, useContext: () => null,
    useState: <T,>(initial: T) => { const i = driver.stateIndex++; if (!(i in driver.states)) driver.states[i] = initial;
      return [driver.states[i], (value: T | ((previous: T) => T)) => {
        const previous = driver.states[i] as T;
        const next = typeof value === 'function' ? (value as (previous: T) => T)(previous) : value;
        if (Object.is(next, previous)) return;
        driver.states[i] = next;
        if (driver.rendering) driver.rerender = true;
      }]; },
    useRef: <T,>(initial: T) => { const i = driver.refIndex++; driver.refs[i] ??= { current: initial }; return driver.refs[i]; },
    useEffect: effect, useLayoutEffect: effect,
  };
});
vi.mock('@xyflow/react', () => {
  const flow = { getState: () => ({ transform: [0, 0, driver.zoom] }),
    subscribe: (f: () => void) => { driver.listeners.add(f); return () => driver.listeners.delete(f); } };
  return { useStoreApi: () => flow };
});
vi.mock('../../src/components/nodes/shared/image/canvasImageDisplay', () => ({ createCanvasImageDisplay: driver.create }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => ({ config: driver.config }),
  subscribe: (listener: (typeof driver.configListeners extends Set<infer T> ? T : never)) => {
    driver.configListeners.add(listener); return () => driver.configListeners.delete(listener);
  },
} }));
import CanvasPreviewImage from '../../src/components/nodes/shared/image/CanvasPreviewImage';
type Props = Parameters<typeof CanvasPreviewImage>[0];
type ImageEvent = Parameters<NonNullable<ImgHTMLAttributes<HTMLImageElement>['onLoad']>>[0];
type ImageElement = ReactElement<ImgHTMLAttributes<HTMLImageElement> & { ref: { current: HTMLImageElement | null } }>;
const base: Props = { src: 'asset://a.png', projectId: 'project-a', nodeWidth: 280, nodeHeight: 158 };
let active: { viewport: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; committed: ReturnType<typeof vi.fn>; original: ReturnType<typeof vi.fn> };
let publish: (lease: DisplayImageLease) => void;
let rendered: ImageElement;
let imageNode: {
  getAttribute: (name: string) => string | null;
  decode: ReturnType<typeof vi.fn> | undefined;
  dispatchEvent: ReturnType<typeof vi.fn>;
};
function render(props = base) {
  for (let pass = 0; pass < 25; pass++) {
    driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
    driver.pending = [];
    driver.rerender = false;
    driver.rendering = true;
    let image: ImageElement;
    try { image = CanvasPreviewImage(props) as ImageElement; }
    finally { driver.rendering = false; }
    // React discards render-phase effects until the component reaches its final render.
    if (driver.rerender) continue;
    rendered = image;
    image.props.ref.current = imageNode as unknown as HTMLImageElement;
    driver.pending.splice(0).forEach((effect) => effect());
    return image;
  }
  throw new Error('Canvas preview did not settle its render-phase updates');
}
function imageEvent(): ImageEvent {
  return { currentTarget: imageNode, target: imageNode } as unknown as ImageEvent;
}
function hidden(image = rendered) {
  return image.props.className?.split(/\s+/).includes('invisible') ?? false;
}
function deferredDecode() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  imageNode.decode = vi.fn(() => promise);
  return { resolve, reject, promise };
}
async function load() {
  rendered.props.onLoad?.(imageEvent());
  await Promise.resolve();
}
function unmount() {
  rendered.props.ref.current = null;
  driver.effects.forEach((effect) => effect.cleanup?.());
}
beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = []; driver.listeners.clear(); driver.zoom = 1;
  driver.config = { performanceMode: false }; driver.configListeners.clear();
  driver.rendering = driver.rerender = false;
  driver.create.mockReset().mockImplementation((options: { publish: typeof publish }) => {
    publish = options.publish;
    active = { viewport: vi.fn(), dispose: vi.fn(), committed: vi.fn(), original: vi.fn() }; return active;
  });
  imageNode = {
    getAttribute: (name) => name === 'src' ? rendered.props.src ?? null : null,
    decode: vi.fn(async () => {}),
    dispatchEvent: vi.fn((event: Event) => {
      if (event.type === 'error') rendered.props.onError?.(imageEvent());
      return true;
    }),
  };
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { driver.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('canvas preview image integration', () => {
  it('keeps the first frame and pending decode blank, then reveals the decoded image', async () => {
    const onLoad = vi.fn();
    const props = { ...base, className: 'image-preview-img compact', alt: 'Generated', onLoad };
    const initial = render(props);
    expect(initial.type).toBe('img'); expect(initial.props.src).toBeUndefined(); expect(hidden(initial)).toBe(true);
    expect(initial.props.className).toContain('image-preview-img compact');
    const lease = { src: 'blob:cached', release: vi.fn() }; publish(lease);
    const pending = deferredDecode();
    expect(render(props).props.src).toBe(lease.src); expect(hidden()).toBe(true);
    const event = imageEvent();
    rendered.props.onLoad?.(event);
    expect(onLoad).toHaveBeenCalledExactlyOnceWith(event);
    expect(imageNode.decode).toHaveBeenCalledOnce(); expect(hidden(render(props))).toBe(true);
    pending.resolve(); await pending.promise;
    expect(hidden(render(props))).toBe(false);
    expect(rendered.props.className).toBe('image-preview-img compact');
  });
  it('reveals an already-loaded image on load when decode is unavailable', () => {
    render(); publish({ src: 'blob:cached', release: vi.fn() });
    render(); expect(hidden()).toBe(true);
    imageNode.decode = undefined;
    rendered.props.onLoad?.(imageEvent());
    expect(hidden(render())).toBe(false);
  });
  it('retains one img across source tiers and hides each new tier until its own decode', async () => {
    expect(render().type).toBe('img'); expect(active.viewport).toHaveBeenCalledWith(1, 280, 158, 1, false);
    const lease = { src: 'blob:512', release: vi.fn() }; publish(lease);
    expect(render().props.src).toBe('blob:512'); expect(active.committed).toHaveBeenCalledWith(lease);
    const imageRef = rendered.props.ref;
    await load(); expect(hidden(render())).toBe(false);
    const first = active; driver.zoom = 5; driver.listeners.forEach((f) => f());
    expect(active.viewport).toHaveBeenLastCalledWith(5, 280, 158, 1, false); expect(render().props.src).toBe('blob:512');
    expect(hidden()).toBe(false);
    publish({ src: base.src!, release: vi.fn() }); expect(render().type).toBe('img');
    expect(rendered.props.ref).toBe(imageRef); expect(hidden()).toBe(true);
    expect(render().props.src).toBe(base.src); expect(active).toBe(first);
    await load(); expect(hidden(render())).toBe(false);
    expect(driver.create).toHaveBeenCalledOnce();
    expect(render({ ...base, projectId: 'project-b' }).props.src).toBeUndefined(); expect(hidden()).toBe(true);
    expect(first.dispose).toHaveBeenCalledOnce();
  });
  it('does not re-create the controller for pan or size changes and removes subscriptions on source change', () => {
    render(); const first = active; driver.listeners.forEach((f) => f());
    expect(active.viewport).toHaveBeenCalledOnce();
    render({ ...base, nodeWidth: 560 }); expect(driver.create).toHaveBeenCalledOnce();
    expect(active.viewport).toHaveBeenLastCalledWith(1, 560, 158, 1, false);
    render({ ...base, src: 'asset://a.png?revision=2' });
    expect(first.dispose).toHaveBeenCalledOnce(); expect(driver.listeners.size).toBe(1);
    expect(driver.configListeners.size).toBe(1);
  });
  it('updates modes without recreating the controller or hiding the displayed image', async () => {
    render(); const first = active;
    publish({ src: 'blob:ready', release: vi.fn() });
    expect(render().props.src).toBe('blob:ready');
    await load(); expect(hidden(render())).toBe(false);
    for (const performanceMode of [true, false, true]) {
      const previous = { config: driver.config };
      driver.config = { performanceMode };
      driver.configListeners.forEach((f) => f({ config: driver.config }, previous));
      expect(active.viewport).toHaveBeenLastCalledWith(1, 280, 158, 1, performanceMode);
      expect(render().props.src).toBe('blob:ready');
      expect(hidden()).toBe(false);
      expect(active).toBe(first);
    }
    render({ ...base, nodeWidth: 560 });
    expect(active.viewport).toHaveBeenLastCalledWith(1, 560, 158, 1, true);
    expect(driver.create).toHaveBeenCalledOnce(); expect(first.dispose).not.toHaveBeenCalled();
    const calls = active.viewport.mock.calls.length;
    driver.configListeners.forEach((f) => f({ config: driver.config }, { config: driver.config }));
    expect(active.viewport).toHaveBeenCalledTimes(calls);
    unmount();
    expect(driver.configListeners.size).toBe(0); expect(driver.listeners.size).toBe(0);
  });
  it('keeps internal properties out of the DOM and handles absent sources', () => {
    const image = render({ ...base, nodeId: 'a', src: undefined });
    expect(image.props.src).toBeUndefined(); expect(driver.create).not.toHaveBeenCalled();
    expect(hidden(image)).toBe(true);
    for (const key of ['nodeId', 'nodeWidth', 'nodeHeight', 'projectId']) expect(image.props).not.toHaveProperty(key);
  });
  it('hides and reports failed previews without automatically requesting the original', async () => {
    const onError = vi.fn(); const props = { ...base, onError }; render(props);
    const event = imageEvent();
    publish({ src: 'blob:ready', release: vi.fn() }); render(props);
    await load(); expect(hidden(render(props))).toBe(false);
    rendered.props.onError?.(event);
    expect(hidden(render(props))).toBe(true); expect(onError).toHaveBeenCalledWith(event);
    publish({ src: 'blob:bad', release: vi.fn() }); render(props).props.onError?.(event);
    expect(active.original).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledWith(event);
    publish({ src: base.src!, release: vi.fn() }); render(props).props.onError?.(event);
    expect(onError).toHaveBeenCalledWith(event);
  });
  it('reports a rejected decode and keeps the broken image hidden', async () => {
    const onError = vi.fn(); const props = { ...base, onError };
    render(props); publish({ src: 'blob:bad', release: vi.fn() }); render(props);
    const pending = deferredDecode();
    rendered.props.onLoad?.(imageEvent());
    pending.reject(new Error('Decode failed')); await pending.promise.catch(() => {});
    expect(imageNode.dispatchEvent).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce(); expect(hidden(render(props))).toBe(true);
    expect(active.original).not.toHaveBeenCalled();
  });
  it.each(['source', 'project'] as const)('ignores a late decode after a %s switch even when the lease URL repeats', async (change) => {
    render(); publish({ src: 'blob:shared', release: vi.fn() }); render();
    const previous = deferredDecode(); rendered.props.onLoad?.(imageEvent());
    const nextProps = change === 'source' ? { ...base, src: 'asset://b.png' } : { ...base, projectId: 'project-b' };
    expect(render(nextProps).props.src).toBeUndefined(); expect(hidden()).toBe(true);
    publish({ src: 'blob:shared', release: vi.fn() }); render(nextProps);
    const next = deferredDecode(); rendered.props.onLoad?.(imageEvent());
    previous.resolve(); await previous.promise;
    expect(hidden(render(nextProps))).toBe(true);
    next.resolve(); await next.promise;
    expect(hidden(render(nextProps))).toBe(false);
  });
  it('requires a fresh decode after returning from a pending source to a previously decoded source', async () => {
    render(); publish({ src: 'blob:a', release: vi.fn() }); render();
    await load(); expect(hidden(render())).toBe(false);
    const pendingProps = { ...base, src: 'asset://b.png' };
    expect(render(pendingProps).props.src).toBeUndefined(); expect(hidden()).toBe(true);
    // B never publishes a preview, so the old A lease remains in state while its readiness expires.
    expect(render().props.src).toBe('blob:a'); expect(hidden()).toBe(true);
    expect(driver.create).toHaveBeenCalledTimes(3);
    await load(); expect(hidden(render())).toBe(false);
  });
  it('keeps a decoded image visible when a replacement tier lease uses the same URL', async () => {
    render(); publish({ src: 'blob:shared', release: vi.fn() }); render();
    await load(); expect(hidden(render())).toBe(false);
    const imageRef = rendered.props.ref;
    const next = { src: 'blob:shared', release: vi.fn() }; publish(next);
    expect(hidden(render())).toBe(false);
    expect(rendered.props.ref).toBe(imageRef); expect(active.committed).toHaveBeenLastCalledWith(next);
    expect(imageNode.decode).toHaveBeenCalledOnce(); expect(driver.create).toHaveBeenCalledOnce();
  });
  it('finishes an in-flight decode after a same-URL lease replacement without another load', async () => {
    render(); publish({ src: 'blob:shared', release: vi.fn() }); render();
    const previous = deferredDecode(); rendered.props.onLoad?.(imageEvent());
    publish({ src: 'blob:shared', release: vi.fn() }); render();
    expect(hidden()).toBe(true);
    previous.resolve(); await previous.promise;
    expect(hidden(render())).toBe(false);
    expect(imageNode.decode).toHaveBeenCalledOnce();
  });
  it.each(['resolve', 'reject'] as const)('ignores a late decode %s after unmount', async (outcome) => {
    const onError = vi.fn(); const props = { ...base, onError };
    render(props); publish({ src: 'blob:pending', release: vi.fn() }); render(props);
    const pending = deferredDecode(); rendered.props.onLoad?.(imageEvent());
    unmount(); const stateAtUnmount = [...driver.states];
    if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Decode failed'));
    await pending.promise.catch(() => {});
    expect(driver.states).toEqual(stateAtUnmount);
    expect(onError).not.toHaveBeenCalled(); expect(imageNode.dispatchEvent).not.toHaveBeenCalled();
    expect(active.dispose).toHaveBeenCalledOnce();
  });
});
