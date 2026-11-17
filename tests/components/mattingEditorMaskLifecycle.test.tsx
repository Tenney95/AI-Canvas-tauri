import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface EffectSlot {
  deps?: readonly unknown[]; layout: boolean; setup: () => void | (() => void); cleanup?: () => void;
}
const driver = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], effects: [] as EffectSlot[], loadSafeImage: vi.fn() }));
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => !!left && !!right
  && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
vi.mock('react', async (original) => {
  const memo = <T,>(factory: () => T, deps?: readonly unknown[]) => {
    const index = driver.index++, old = driver.slots[index] as { value: T; deps?: readonly unknown[] } | undefined;
    if (!old || !sameDeps(old.deps, deps)) driver.slots[index] = { value: factory(), deps };
    return (driver.slots[index] as { value: T }).value;
  };
  const effect = (layout: boolean) => (setup: EffectSlot['setup'], deps?: readonly unknown[]) => {
    const index = driver.index++, old = driver.slots[index] as EffectSlot | undefined;
    if (old && sameDeps(old.deps, deps)) return;
    const slot = { setup, deps, layout, cleanup: old?.cleanup };
    driver.slots[index] = slot; driver.effects.push(slot);
  };
  return {
    ...await original<typeof import('react')>(), useMemo: memo,
    useCallback: <T,>(callback: T, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
    useRef: <T,>(initial: T) => {
      const index = driver.index++;
      return driver.slots[index] ?? (driver.slots[index] = { current: initial });
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = driver.index++;
      if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.slots[index], (next: T | ((previous: T) => T)) => {
        driver.slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(driver.slots[index] as T) : next;
      }];
    },
  };
});
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../src/hooks/useDialogFocus', () => ({ useDialogFocus: () => undefined }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string, values?: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key) }));
vi.mock('../../src/components/nodes/shared/image/MattingToolbar', () => ({ default: 'matting-toolbar' }));
vi.mock('../../src/components/nodes/shared/image/ImageEditorZoomControls', () => ({ default: 'zoom-controls' }));
vi.mock('../../src/components/nodes/shared/image/imageUtils', () => ({ loadSafeImage: driver.loadSafeImage }));

import MattingEditor from '../../src/components/nodes/shared/image/MattingEditor';
import MattingToolbar from '../../src/components/nodes/shared/image/MattingToolbar';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  // The old implementation never subscribes to the safe-loader fixture; its deliberate rejection still needs an observer.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const safeMask = (name: string) => ({ src: `blob:${name}` }) as HTMLImageElement;
class Canvas {
  private w = 2; private h = 2;
  tainted = false; pixel = [0, 0, 0, 0]; strokes = 0;
  get width() { return this.w; }
  set width(value: number) { this.w = value; this.tainted = false; }
  get height() { return this.h; }
  set height(value: number) { this.h = value; this.tainted = false; }
  context = {
    globalAlpha: 1,
    clearRect: vi.fn(() => { this.pixel = [0, 0, 0, 0]; }),
    drawImage: vi.fn((source: { src?: string } | Canvas) => {
      if (source instanceof Canvas) { this.tainted ||= source.tainted; this.pixel = [...source.pixel]; this.strokes = source.strokes; }
      else { this.tainted ||= !source.src?.startsWith('blob:'); this.pixel = [255, 200, 0, 115]; }
    }),
    getImageData: vi.fn(() => {
      if (this.tainted) throw new DOMException('Tainted canvas', 'SecurityError');
      return { width: this.width, height: this.height, data: Uint8ClampedArray.from(Array.from({ length: this.width * this.height }, () => this.pixel).flat()) };
    }),
    putImageData: vi.fn((value: ImageData) => { this.pixel = Array.from(value.data.slice(0, 4)); }),
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(() => { this.strokes++; }),
  };
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 2, height: 2, left: 0, top: 0 }; }
  setPointerCapture() {} hasPointerCapture() { return false; } releasePointerCapture() {}
  toDataURL() {
    if (this.tainted) throw new DOMException('Tainted canvas', 'SecurityError');
    return `data:image/png;base64,${this.strokes ? 'edited' : 'unchanged'}`;
  }
}
let canvas: Canvas;
let image: { src: string; naturalWidth: number; naturalHeight: number; decode: () => Promise<void> };
const props = (): ComponentProps<typeof MattingEditor> => ({ isOpen: true,
  imageUrl: 'asset://localhost/source.png', initialMask: 'asset://localhost/media/saved-mask.png', onClose: vi.fn(), onSave: vi.fn() });
function render(input: ComponentProps<typeof MattingEditor>) {
  driver.index = 0;
  const tree = elements(MattingEditor(input));
  for (const element of tree) {
    if (!element.props.ref) continue;
    let target: unknown = { addEventListener() {}, removeEventListener() {} };
    if (element.type === 'img') { image.src = element.props.src as string; target = image; }
    if (element.type === 'canvas') target = canvas;
    (element.props.ref as { current: unknown }).current = target;
  }
  return tree;
}
function flushEffects() {
  const queued = driver.effects.splice(0).sort((left, right) => Number(right.layout) - Number(left.layout));
  for (const slot of queued) { slot.cleanup?.(); slot.cleanup = slot.setup() || undefined; }
}
function effectSlots() {
  return driver.slots.filter((slot): slot is EffectSlot => !!slot && typeof slot === 'object' && 'setup' in slot)
    .sort((left, right) => Number(right.layout) - Number(left.layout));
}
function unmount() { for (const slot of effectSlots()) { slot.cleanup?.(); slot.cleanup = undefined; } }
function replayEffects() {
  const slots = effectSlots();
  for (const slot of slots) slot.cleanup?.();
  for (const slot of slots) slot.cleanup = slot.setup() || undefined;
}
const toolbar = (tree: Element[]) => tree.find((element) => element.type === MattingToolbar)!.props as unknown as ComponentProps<typeof MattingToolbar>;
const pointer = () => ({ button: 0, clientX: 1, clientY: 1, pointerId: 1, preventDefault() {} });
function paint(tree: Element[]) {
  const handlers = tree.find((element) => element.type === 'canvas')!.props;
  for (const name of ['onPointerDown', 'onPointerMove', 'onPointerUp']) (handlers[name] as (event: unknown) => void)(pointer());
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => {
  driver.index = 0; driver.slots = []; driver.effects = [];
  driver.loadSafeImage.mockReset().mockResolvedValue(safeMask('safe-mask'));
  canvas = new Canvas();
  image = { src: '', naturalWidth: 2, naturalHeight: 2, decode: vi.fn(async () => undefined) };
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { body: {}, createElement: () => new Canvas() });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('saved mask editing lifecycle', () => {
  it('still paints and saves a new mask when no initial mask exists', async () => {
    const input = { ...props(), initialMask: undefined };
    render(input); flushEffects(); await settle();
    const tree = render(input);
    expect(toolbar(tree).canSave).toBe(true);
    expect(driver.loadSafeImage).not.toHaveBeenCalled();
    paint(tree); toolbar(render(input)).onSave();
    expect(input.onSave).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,edited');
  });

  it('loads a native mask through the safe loader before painting and exporting, preserving the source URL', async () => {
    const input = props();
    let tree = render(input); flushEffects();
    paint(tree); toolbar(tree).onClear(); toolbar(tree).onSave();
    expect(input.onSave).not.toHaveBeenCalled();
    expect(canvas.context.getImageData).not.toHaveBeenCalled();
    expect(toolbar(tree).canSave).toBe(false);
    await settle(); tree = render(input);
    expect(driver.loadSafeImage).toHaveBeenCalledExactlyOnceWith(input.initialMask, { label: '画笔蒙版' });
    expect(toolbar(tree).canSave).toBe(true);
    expect(canvas.pixel[3]).toBe(255);
    paint(tree); toolbar(render(input)).onSave();
    expect(canvas.strokes).toBe(1);
    expect(input.onSave).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,edited');
    expect(image.src).toBe(input.imageUrl);
    expect(canvas.tainted).toBe(false);
  });

  it('keeps save disabled on A to B to A while rejecting the old B load', async () => {
    const a = props(), b = { ...a, initialMask: 'asset://localhost/media/other-mask.png' };
    render(a); flushEffects(); await settle();
    expect(toolbar(render(a)).canSave).toBe(true);
    const oldB = deferred<HTMLImageElement>(), newA = deferred<HTMLImageElement>();
    driver.loadSafeImage.mockReturnValueOnce(oldB.promise).mockReturnValueOnce(newA.promise);
    render(b); flushEffects();
    let tree = render(a); expect(toolbar(tree).canSave).toBe(false); flushEffects();
    oldB.resolve(safeMask('old-b')); await settle();
    tree = render(a); expect(toolbar(tree).canSave).toBe(false);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(1);
    newA.resolve(safeMask('new-a')); await settle();
    expect(toolbar(render(a)).canSave).toBe(true);
    expect(canvas.context.drawImage.mock.calls.map(([source]) => (source as HTMLImageElement).src)).toEqual(['blob:safe-mask', 'blob:new-a']);
  });

  it.each(['source-change', 'close', 'unmount'] as const)('does not draw or save an old pending mask after %s', async (change) => {
    const pending = deferred<HTMLImageElement>(), input = props();
    driver.loadSafeImage.mockReturnValueOnce(pending.promise);
    render(input); flushEffects();
    if (change === 'unmount') unmount();
    else { render({ ...input, ...(change === 'close' ? { isOpen: false } : { imageUrl: 'asset://localhost/new-source.png' }) }); flushEffects(); }
    pending.resolve(safeMask('obsolete')); await settle();
    expect(canvas.context.drawImage.mock.calls.every(([source]) => (source as HTMLImageElement).src !== 'blob:obsolete')).toBe(true);
    expect(input.onSave).not.toHaveBeenCalled();
  });

  it('revokes old work across StrictMode cleanup and setup, then permits the new load', async () => {
    const old = deferred<HTMLImageElement>(), next = deferred<HTMLImageElement>(), input = props();
    driver.loadSafeImage.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    render(input); flushEffects(); replayEffects();
    old.resolve(safeMask('old-replay')); await settle();
    expect(canvas.context.drawImage).not.toHaveBeenCalled();
    next.resolve(safeMask('new-replay')); await settle();
    expect(toolbar(render(input)).canSave).toBe(true);
    expect(canvas.context.drawImage).toHaveBeenCalledExactlyOnceWith(safeMask('new-replay'), 0, 0, 2, 2);
  });

  it('reports a mask read failure and never exports a blank replacement', async () => {
    const pending = deferred<HTMLImageElement>(), input = props();
    driver.loadSafeImage.mockReturnValueOnce(pending.promise);
    render(input); flushEffects(); pending.reject(new Error('read denied')); await settle();
    const tree = render(input);
    expect(toolbar(tree).canSave).toBe(false);
    expect(tree.some((element) => element.props.role === 'alert')).toBe(true);
    paint(tree); toolbar(tree).onUndo(); toolbar(tree).onRedo(); toolbar(tree).onClear(); toolbar(tree).onSave();
    expect(canvas.context.drawImage).not.toHaveBeenCalled();
    expect(input.onSave).not.toHaveBeenCalled();
    expect(input.initialMask).toBe('asset://localhost/media/saved-mask.png');
  });
});
