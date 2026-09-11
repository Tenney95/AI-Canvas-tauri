import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>, stateIndex: 0, refIndex: 0, effectIndex: 0,
  image: vi.fn(), video: vi.fn(), unavailable: vi.fn(), revision: 0,
  runtime: null as null | {
    prepareDisplay: (key: object, work: () => Promise<void>, nodeId?: string) => () => void;
    enqueueDisplay: (key: object, work: () => void, nodeId?: string) => () => void;
  },
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, memo: <T,>(value: T) => value,
    useContext: () => driver.runtime,
    useCallback: <T,>(value: T, deps: readonly unknown[]) => {
      const index = driver.refIndex++;
      const previous = driver.refs[index]?.current as { value: T; deps: readonly unknown[] } | undefined;
      if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous.value;
      driver.refs[index] = { current: { value, deps } };
      return value;
    },
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
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock('@xyflow/react', () => ({ Handle: 'handle', Position: { Left: 'left', Right: 'right' } }));
vi.mock('../../src/hooks/useReferencedImageWatcher', () => ({
    withPreviewRevision: (source: string, revision: number) => revision ? `${source}?_refresh=${revision}` : source,
}));
vi.mock('../../src/hooks/useCanvasNodeLod', () => ({ CanvasNodeLodContext: {}, useCanvasNodeLodPreviewRevision: () => driver.revision }));
vi.mock('../../src/components/nodes/shared/image/canvasImagePreviewCache', () => ({ acquireCanvasImagePreview: driver.image }));
vi.mock('../../src/components/nodes/shared/video/canvasVideoPreviewCache', () => ({ acquireCanvasVideoPoster: driver.video }));
import Preview from '../../src/components/nodes/shared/CanvasNodeLodPreview';

type Props = Parameters<typeof Preview>[0];
type Lease = { src: string; release: ReturnType<typeof vi.fn> };
interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
interface ImageProps {
  src: string; className: string;
  onLoad: (event: { currentTarget: { decode: () => Promise<void> } }) => Promise<void>;
  onError: () => void;
}
const base: Props = {
  nodeId: 'image-node',
  data: { type: 'ai-image', label: 'Image', imageUrl: 'asset://image.png' },
  video: false, projectId: 'project-a', width: 280, height: 210, onUnavailable: driver.unavailable,
};
function elements(tree: unknown, type: string): Element[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [...(node.type === type ? [node] : []), ...elements(node.props.children, type)];
}
function render(props: Props = base) {
  driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
  const tree = Preview(props);
  driver.pending.splice(0).forEach((effect) => effect());
  return { tree, image: elements(tree, 'img')[0]?.props as unknown as ImageProps | undefined, handles: elements(tree, 'handle') };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function unmount() { driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; }
beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.image.mockReset(); driver.video.mockReset(); driver.unavailable.mockReset();
  driver.revision = 0; driver.runtime = null;
});
afterEach(unmount);

describe('canvas lightweight media preview', () => {
  it('queues cache acquisition, display and decode completion separately and cancels pending display on unmount', async () => {
    const preparation = new Map<object, () => Promise<void>>();
    const display = new Map<object, () => void>();
    driver.runtime = {
      prepareDisplay: (key, work, id) => { expect(id).toBe('image-node'); preparation.set(key, work); return () => { preparation.delete(key); }; },
      enqueueDisplay: (key, work, id) => { expect(id).toBe('image-node'); display.set(key, work); return () => { display.delete(key); }; },
    };
    const lease = { src: 'blob:cached', release: vi.fn() }; driver.image.mockResolvedValue(lease);
    render(); expect(driver.image).not.toHaveBeenCalled();
    await [...preparation.values()][0]();
    expect(render().image).toBeUndefined(); expect(display.size).toBe(1);
    [...display.values()][0](); display.clear();
    const image = render().image!; expect(image.src).toBe(lease.src);
    await image.onLoad({ currentTarget: { decode: async () => {} } });
    expect(render().image?.className).not.toContain('is-ready'); expect(display.size).toBe(1);
    unmount(); expect(display.size).toBe(0); expect(preparation.size).toBe(0);
    expect(lease.release).toHaveBeenCalledOnce(); expect(driver.unavailable).not.toHaveBeenCalled();
  });
  it('uses the retained boundary revision to avoid stale memory previews after an external edit', () => {
    driver.image.mockReturnValue(new Promise(() => {}));
    render();
    const oldSignal = driver.image.mock.calls[0][2] as AbortSignal;
    driver.revision = 2;
    render();
    expect(oldSignal.aborted).toBe(true);
    expect(driver.image).toHaveBeenLastCalledWith('asset://image.png?_refresh=2', 256, expect.any(AbortSignal), 'project-a');
  });
  it('requests a 256px lease, keeps exact connection IDs, and shows pixels only after decode', async () => {
    const acquisition = deferred<Lease>();
    driver.image.mockReturnValue(acquisition.promise);
    const first = render();
    expect(first.image).toBeUndefined();
    expect(first.handles.map((handle) => [handle.props.id, handle.props.type])).toEqual([['left', 'source'], ['right', 'source']]);
    expect(driver.image).toHaveBeenCalledWith(base.data.imageUrl, 256, expect.any(AbortSignal), 'project-a');
    const lease = { src: 'blob:small', release: vi.fn() };
    acquisition.resolve(lease);
    await acquisition.promise;
    const image = render().image!;
    expect(image.src).toBe(lease.src);
    expect(image.className).not.toContain('is-ready');
    const decoding = deferred<void>();
    const loaded = image.onLoad({ currentTarget: { decode: () => decoding.promise } });
    expect(render().image?.className).not.toContain('is-ready');
    decoding.resolve();
    await loaded;
    expect(render().image?.className).toContain('is-ready');
    expect(render({ ...base, cover: true }).handles).toHaveLength(0);
    expect(driver.image).toHaveBeenCalledTimes(1);
    unmount();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('shares the existing video poster path, or uses a supplied image cover without starting video', async () => {
    driver.video.mockResolvedValue({ src: 'blob:poster', release: vi.fn() });
    const props = { ...base, video: true, data: { ...base.data, videoUrl: 'asset://video.mp4', thumbnailUrl: 'asset://video.mp4' } };
    render(props);
    await Promise.resolve();
    expect(driver.video).toHaveBeenCalledWith(props.data.videoUrl, expect.any(AbortSignal));
    expect(render(props).image?.src).toBe('blob:poster');
    driver.image.mockResolvedValue({ src: 'blob:cover', release: vi.fn() });
    render({ ...props, data: { ...props.data, thumbnailUrl: 'asset://cover.png' } });
    expect(driver.image).toHaveBeenCalledWith('asset://cover.png', 256, expect.any(AbortSignal), 'project-a');
    expect(driver.video).toHaveBeenCalledTimes(1);
  });

  it('releases late acquisitions and rejects stale load/decode events across source and project changes', async () => {
    const first = deferred<Lease>();
    const second = deferred<Lease>();
    driver.image.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render();
    const lease = { src: 'blob:old', release: vi.fn() };
    first.resolve(lease);
    await first.promise;
    const oldImage = render().image!;
    const decoding = deferred<void>();
    const loaded = oldImage.onLoad({ currentTarget: { decode: () => decoding.promise } });
    const next = { ...base, projectId: 'project-b' };
    expect(render(next).image).toBeUndefined();
    oldImage.onError();
    decoding.resolve();
    await loaded;
    expect(driver.unavailable).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(1);
    unmount();
    const lateLease = { src: 'blob:late', release: vi.fn() };
    second.resolve(lateLease);
    await second.promise;
    expect(lateLease.release).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'rejected', 'decode', 'load'])('restores the original component on %s failure without requesting raw pixels in LOD', async (failure) => {
    driver.image.mockImplementation(() => failure === 'rejected' ? Promise.reject(new Error('Unavailable'))
      : Promise.resolve(failure === 'missing' ? null : { src: 'blob:small', release: vi.fn() }));
    render();
    await Promise.resolve();
    const { image } = render();
    if (failure === 'decode') await image!.onLoad({ currentTarget: { decode: () => Promise.reject(new Error('Decode')) } });
    if (failure === 'load') image!.onError();
    expect(driver.unavailable).toHaveBeenCalledTimes(1);
    expect(image?.src).not.toBe(base.data.imageUrl);
    expect(driver.image).toHaveBeenCalledTimes(1);
  });
});
