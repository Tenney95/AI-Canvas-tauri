import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { CanvasFarNodeCard } from '../../src/components/canvas/CanvasFarNodeBitmap';
import { collectMediaDamage, mediaBodyPixels } from '../../src/components/canvas/canvasMediaRasterDamage';

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(value: T) => value,
  useRef: <T,>(current: T) => ({ current }),
  useLayoutEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock('../../src/components/nodes/shared/NodeLabel', () => ({ default: () => null }));
vi.mock('../../src/components/nodes/shared/image/canvasImagePreviewCache', () => ({
  acquireCachedCanvasImagePreview: () => null,
  acquireCanvasImagePreview: async (source: string, edge: number) => ({ src: `${source}/${edge}`, release: vi.fn() }),
}));
vi.mock('../../src/components/canvas/canvasNearMediaStyle', () => ({
  CANVAS_MEDIA_TITLE_HEIGHT: 20,
  readCanvasNearMediaStyle: () => ({}),
  drawCanvasNearMedia: vi.fn(),
  drawCanvasNearMediaTitle: vi.fn(),
}));

import Bitmap from '../../src/components/canvas/CanvasFarNodeBitmap';
import { drawCanvasNearMedia, drawCanvasNearMediaTitle } from '../../src/components/canvas/canvasNearMediaStyle';

type Props = Parameters<typeof Bitmap>[0];
const cleanup: Array<() => void> = [];
function card(id: string, source: string, x: number, width = 80): CanvasFarNodeCard {
  return { id, source, x, y: 20, width, height: 45, image: true };
}

function mount(cards: CanvasFarNodeCard[], near = false) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = nextFrame++; frames.set(frame, callback); return frame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const observers: Array<() => void> = [];
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { observers.push(callback); }
    observe() {} disconnect() {}
  });
  const viewport = { style: { transform: 'matrix(1,0,0,1,0,0)' } };
  vi.stubGlobal('DOMMatrixReadOnly', class {
    a: number; b: number; c: number; d: number; e: number; f: number; is2D = true;
    constructor(value: string) { [this.a,this.b,this.c,this.d,this.e,this.f] = value.slice(7,-1).split(',').map(Number); }
  });
  const ctx = {
    clearRect: vi.fn(), rect: vi.fn(), drawImage: vi.fn(), roundRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    setTransform: vi.fn(), beginPath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(),
  };
  const view = {
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    getComputedStyle: () => ({ backgroundColor: 'white', getPropertyValue: () => 'black', borderTopLeftRadius: '4px' }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), clearTimeout: vi.fn(),
  };
  const pending = new Map<string, { done(): void; fail(): void }>();
  const createElement = () => ({ src: '', naturalWidth: 80, naturalHeight: 45, removeAttribute: vi.fn(),
    decode() { return new Promise<void>((resolve, reject) => pending.set(this.src, { done: resolve, fail: reject })); },
  });
  const canvas = { width: 0, height: 0, dataset: {} as Record<string, string>, style: {},
    ownerDocument: { defaultView: view, documentElement: {}, createElement },
    closest: () => viewport, getContext: () => ctx, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const onPreviewError = vi.fn(), onUnavailable = vi.fn();
  const store = { getState: () => ({ width: 1200, height: 600 }), subscribe: () => () => {} };
  const runtime = { prepareDisplay: (_key: object, fn: () => Promise<void>) => { void fn(); return () => {}; } };
  const tree = Bitmap({ cards, near, projectId: 'test', store: store as unknown as Props['store'],
    runtime: runtime as unknown as Props['runtime'], onPreviewError, onUnavailable, webGpuRequested: false,
  }) as ReactElement<{ children: Array<ReactElement<{ ref: { current: unknown } }> | false> }>;
  for (const child of tree.props.children) {
    if (child && child.props.ref) child.props.ref.current = child.type === 'canvas' ? canvas : {};
  }
  for (const effect of hooks.effects.splice(0)) { const off = effect(); if (off) cleanup.push(off); }
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach((f) => f(0)); };
  flush();
  const settle = async (source: string, success = true) => {
    await Promise.resolve();
    const ready = pending.get(source);
    if (!ready) throw Error(`Missing preview ${source}`);
    if (success) ready.done(); else ready.fail();
    await Promise.resolve();
    flush();
  };
  return { ctx, canvas, view, viewport, observers, flush, settle, pending, onUnavailable, onPreviewError };
}

afterEach(() => {
  cleanup.splice(0).forEach((off) => off());
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('media bitmap preview redraw', () => {
  it('repaints every instance and overlapping card once in their original order', async () => {
    const f = mount([card('below', 'other', 40), card('a', 'shared', 10), card('b', 'shared', 500), card('away', 'none', 950)]);
    await f.settle('other/256');
    f.ctx.clearRect.mockClear(); f.ctx.drawImage.mockClear(); f.ctx.rect.mockClear();
    await f.settle('shared/256');
    expect(f.canvas.dataset).toMatchObject({ previewReadyCount: '3', bitmapRasterCount: '3', bitmapPartialRasterCount: '2' });
    expect(f.ctx.clearRect.mock.calls).toEqual([[297,307,82,47], [787,307,82,47]]);
    expect(f.ctx.rect.mock.calls).toEqual(f.ctx.clearRect.mock.calls);
    expect(f.ctx.drawImage.mock.calls.map(([img]) => img.src)).toEqual(['other/256','shared/256','shared/256']);
    expect(f.onUnavailable).not.toHaveBeenCalled();
  });

  it('does a full pass after a theme, resolution, or uncovered camera change', async () => {
    const f = mount([card('a', 'shared', 10)]);
    await f.settle('shared/256');
    f.observers[1](); f.flush();
    f.view.devicePixelRatio = 2; f.observers[0](); f.flush();
    f.viewport.style.transform = 'matrix(1,0,0,1,-900,0)'; f.observers[0](); f.flush();
    expect(f.canvas.dataset).toMatchObject({ bitmapRasterCount: '5', bitmapPartialRasterCount: '1', renderedNodeCount: '0' });
    expect(f.ctx.clearRect).toHaveBeenLastCalledWith(0, 0, f.canvas.width, f.canvas.height);
  });

  it('keeps the sharper tier, replays neighbouring labels, and retains the low tier on upgrade failure', async () => {
    const detailed = (value: CanvasFarNodeCard) => ({ ...value, detail: { video: false, title: value.id } });
    const f = mount([detailed(card('wide','wide',10,480)), detailed(card('next','different',790,480))], true);
    await Promise.resolve();
    const high = [...f.pending.keys()].find((key) => key.startsWith('wide/') && key !== 'wide/256')!;
    const failed = high.replace('wide/', 'different/');
    vi.mocked(drawCanvasNearMedia).mockClear();
    await f.settle(high);
    expect(drawCanvasNearMedia).toHaveBeenCalledTimes(1);
    expect(drawCanvasNearMediaTitle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'next' }), expect.anything());
    const count = f.canvas.dataset.bitmapRasterCount;
    await f.settle('wide/256');
    expect(f.canvas.dataset.bitmapRasterCount).toBe(count);
    await f.settle('different/256'); await f.settle(failed, false);
    expect(f.canvas.dataset).toMatchObject({ previewReadyCount: '2', detailReadyCount: '1' });
    expect(f.onPreviewError).not.toHaveBeenCalled();
  });

  it('snaps damage outwards at fractional scale and falls back for large or fragmented updates', () => {
    const rect = mediaBodyPixels(card('a','a',3,12), { left: 1.5, top: 18.5 }, 1.5, 1.25, 200, 200);
    expect(rect).toEqual({ left: 1, top: 0, right: 22, bottom: 60 });
    expect(collectMediaDamage([], { left: 0, top: 0, right: 50, bottom: 100 }, 10000)).toBeNull();
    expect(collectMediaDamage(Array(24).fill(rect), rect, 1000000)).toBeNull();
  });
});
