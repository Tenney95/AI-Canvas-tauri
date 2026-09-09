import type { ImgHTMLAttributes, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  zoom: 1,
  selector: undefined as ((state: { transform: number[] }) => number) | undefined,
  acquire: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    useState: <T,>(initial: T) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = initial;
      return [driver.states[index] as T, (value: T) => { driver.states[index] = value; }];
    },
    useRef: <T,>(initial: T) => {
      const index = driver.refIndex++;
      driver.refs[index] ??= { current: initial };
      return driver.refs[index];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps?.length === previous.deps?.length
        && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: { transform: number[] }) => number) => {
    driver.selector = selector;
    return selector({ transform: [0, 0, driver.zoom] });
  },
}));
vi.mock('../../src/components/nodes/shared/image/canvasImagePreviewCache', () => ({
  acquireCanvasImagePreview: driver.acquire,
}));

import CanvasPreviewImage from '../../src/components/nodes/shared/image/CanvasPreviewImage';

type Lease = { src: string; release: ReturnType<typeof vi.fn> };
type Props = ImgHTMLAttributes<HTMLImageElement> & { nodeWidth: number; nodeHeight: number; projectId?: string | null };
const baseProps: Props = { src: 'asset://original.png', nodeWidth: 280, nodeHeight: 158 };

function deferred() {
  let resolve!: (value: Lease | null) => void;
  const promise = new Promise<Lease | null>((done) => { resolve = done; });
  return { promise, resolve };
}

function render(props: Props = baseProps) {
  driver.stateIndex = 0;
  driver.refIndex = 0;
  driver.effectIndex = 0;
  let image = CanvasPreviewImage(props) as ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
  if (typeof image.type === 'function') {
    image = (image.type as (props: unknown) => typeof image)(image.props);
  }
  if (driver.effectIndex === 0 && driver.effects.length > 0) {
    unmount();
    driver.states = driver.states.slice(0, 1);
    driver.refs = [];
  }
  const pending = driver.pending.splice(0);
  pending.forEach((effect) => effect());
  return image.props;
}

function unmount() {
  driver.effects.forEach((effect) => effect.cleanup?.());
  driver.effects = [];
}

beforeEach(() => {
  driver.states = [];
  driver.refs = [];
  driver.effects = [];
  driver.pending = [];
  driver.zoom = 1;
  driver.acquire.mockReset();
});

describe('canvas image preview lifecycle', () => {
  it('cancels pending disk work when project changes even if the source is unchanged', async () => {
    const first = deferred();
    const second = deferred();
    driver.acquire.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render({ ...baseProps, projectId: 'project-a' });
    const firstSignal = driver.acquire.mock.calls[0][2] as AbortSignal;
    const next = { ...baseProps, projectId: 'project-b' };
    expect(render(next).src).toBeUndefined();
    expect(firstSignal.aborted).toBe(true);
    expect(driver.acquire).toHaveBeenLastCalledWith(baseProps.src, 512, expect.any(AbortSignal), 'project-b');
    const stale = { src: 'blob:project-a', release: vi.fn() };
    first.resolve(stale);
    await first.promise;
    expect(stale.release).toHaveBeenCalled();
    expect(render(next).src).toBeUndefined();
    const fresh = { src: 'blob:project-b', release: vi.fn() };
    second.resolve(fresh);
    await second.promise;
    const props = render(next);
    expect(props.src).toBe(fresh.src);
    expect(props).not.toHaveProperty('projectId');
    unmount();
    expect(fresh.release).toHaveBeenCalled();
  });

  it('does not request or dereference a preview when the image source is absent', () => {
    expect(render({ ...baseProps, src: undefined }).src).toBeUndefined();
    expect(driver.acquire).not.toHaveBeenCalled();
    unmount();
  });

  it('subscribes to resolution tiers and falls back to the original at high zoom', async () => {
    const request = deferred();
    driver.acquire.mockReturnValue(request.promise);
    expect(render().src).toBeUndefined();
    expect(driver.acquire).toHaveBeenCalledWith(baseProps.src, 512, expect.any(AbortSignal), undefined);
    expect(driver.selector?.({ transform: [100, 40, 1.1] })).toBe(512);
    expect(driver.selector?.({ transform: [500, -90, 0.8] })).toBe(256);
    expect(driver.selector?.({ transform: [0, 0, 2] })).toBe(1024);

    const lease = { src: 'blob:small', release: vi.fn() };
    request.resolve(lease);
    await request.promise;
    expect(render().src).toBe('blob:small');
    driver.zoom = 5;
    expect(render().src).toBe(baseProps.src);
    expect(driver.acquire).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalled();
    unmount();
    expect(lease.release).toHaveBeenCalled();
  });

  it('cancels an old source and never displays its late result', async () => {
    const first = deferred();
    const second = deferred();
    driver.acquire.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render();
    const firstSignal = driver.acquire.mock.calls[0][2] as AbortSignal;
    const next = { ...baseProps, src: 'asset://original.png?_refresh=2' };
    expect(render(next).src).toBeUndefined();
    expect(firstSignal.aborted).toBe(true);

    const stale = { src: 'blob:stale', release: vi.fn() };
    first.resolve(stale);
    await first.promise;
    expect(stale.release).toHaveBeenCalled();
    expect(render(next).src).toBeUndefined();
    const fresh = { src: 'blob:fresh', release: vi.fn() };
    second.resolve(fresh);
    await second.promise;
    expect(render(next).src).toBe('blob:fresh');
    unmount();
    expect(fresh.release).toHaveBeenCalled();
  });

  it('keeps the previous tier leased until its replacement commits', async () => {
    const first = deferred();
    const second = deferred();
    driver.acquire.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render();
    const small = { src: 'blob:512', release: vi.fn() };
    first.resolve(small);
    await first.promise;
    render();
    driver.zoom = 2;
    expect(render().src).toBe('blob:512');
    expect(small.release).not.toHaveBeenCalled();
    const large = { src: 'blob:1024', release: vi.fn() };
    second.resolve(large);
    await second.promise;
    expect(render().src).toBe('blob:1024');
    expect(small.release).toHaveBeenCalled();
    unmount();
    expect(large.release).toHaveBeenCalled();
  });

  it('keeps an already displayed original visible while rebuilding an expired small preview', async () => {
    driver.zoom = 5;
    expect(render().src).toBe(baseProps.src);
    const request = deferred();
    driver.acquire.mockReturnValue(request.promise);
    driver.zoom = 0.5;
    expect(render().src).toBe(baseProps.src);
    const lease = { src: 'blob:rebuilt', release: vi.fn() };
    request.resolve(lease);
    await request.promise;
    expect(render().src).toBe('blob:rebuilt');
    unmount();
    expect(lease.release).toHaveBeenCalled();
  });

  it('returns to the original when a preview fails and preserves original error handling', async () => {
    const lease = { src: 'blob:broken', release: vi.fn() };
    driver.acquire.mockResolvedValue(lease);
    const onError = vi.fn();
    const props = { ...baseProps, onError };
    render(props);
    await Promise.resolve();
    const event = {} as Parameters<NonNullable<ImgHTMLAttributes<HTMLImageElement>['onError']>>[0];
    render(props).onError?.(event);
    expect(onError).not.toHaveBeenCalled();
    const fallback = render(props);
    expect(fallback.src).toBe(baseProps.src);
    expect(lease.release).toHaveBeenCalled();
    fallback.onError?.(event);
    expect(onError).toHaveBeenCalledWith(event);
    unmount();
  });

  it('releases a result if unmounted before its state update is rendered', async () => {
    const lease = { src: 'blob:uncommitted', release: vi.fn() };
    driver.acquire.mockResolvedValue(lease);
    render();
    await Promise.resolve();
    unmount();
    expect(lease.release).toHaveBeenCalled();
    expect((driver.acquire.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
  });

  it('uses the original for unsupported images or a failed derivation', async () => {
    driver.acquire.mockResolvedValue(null);
    render();
    await Promise.resolve();
    expect(render().src).toBe(baseProps.src);
    unmount();
  });
});
