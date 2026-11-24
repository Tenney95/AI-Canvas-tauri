/**
 * zoomableImageInteractions — 回归测试：fullscreen source preparation。
 */
import { Children, isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gesture = vi.hoisted(() => ({ scale: 1, zoomTo: vi.fn(), reset: vi.fn() }));
const fullscreenSource = vi.hoisted(() => vi.fn());
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], stateIndex: 0, effectIndex: 0,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
}));
vi.mock('../../src/services/fullscreenImageSource', async (original) => ({
  ...await original<typeof import('../../src/services/fullscreenImageSource')>(),
  acquireFullscreenImageSource: fullscreenSource,
}));

vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
  useState: <T,>(initial?: T | (() => T)) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index], (value: T | ((old: T) => T)) => {
      hooks.values[index] = typeof value === 'function' ? (value as (old: T) => T)(hooks.values[index] as T) : value;
    }];
  },
  useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.effectIndex++; const previous = hooks.effects[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); hooks.effects[index] = { deps, cleanup: run() ?? undefined }; });
  },
}));
vi.mock('../../src/hooks/useImageViewportGesture', () => ({
  useImageViewportGesture: () => ({
    ...gesture,
    containerRef: vi.fn(),
    containerEl: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } },
    tx: 0, ty: 0, dragging: false, gesturing: false, cursor: 'default',
    onPointerDown: vi.fn(),
  }),
}));

import ZoomableImage from '../../src/components/shared/ZoomableImage';
import { FullscreenImageSourceError, FULLSCREEN_IMAGE_ERRORS } from '../../src/services/fullscreenImageSource';

type Element = ReactElement<{
  children?: React.ReactNode;
  className?: string;
  src?: string;
  'aria-label'?: string;
  role?: string;
  onError?: () => void;
  'data-tauri-drag-region'?: string;
  style?: { transform?: string; transition?: string; willChange?: string };
  onClick?: (event: Event) => void;
  onDoubleClick?: (event: Event) => void;
  onMouseDown?: (event: Event) => void;
  onMouseUp?: (event: Event) => void;
}>;

function children(element: Element): Element[] {
  return Children.toArray(element.props.children).filter(isValidElement) as Element[];
}

// 按按钮、控制栏、预览容器的顺序冒泡，复现缩放尚未重新渲染时的同一次点击。
function dispatch(path: Element[], handler: 'onClick' | 'onDoubleClick' | 'onMouseDown' | 'onMouseUp' = 'onClick') {
  const type = { onClick: 'click', onDoubleClick: 'dblclick', onMouseDown: 'mousedown', onMouseUp: 'mouseup' }[handler];
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: path[0] });
  Object.assign(event, { clientX: 400, clientY: 300 });
  for (const element of path) {
    Object.defineProperty(event, 'currentTarget', { value: element, configurable: true });
    element.props[handler]?.(event);
    if (event.cancelBubble) break;
  }
  return event;
}

function render(props: Parameters<typeof ZoomableImage>[0]) {
  hooks.stateIndex = hooks.effectIndex = 0;
  const result = ZoomableImage(props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return result;
}
async function ready(props: Parameters<typeof ZoomableImage>[0]) {
  render(props); await Promise.resolve();
  const result = render(props);
  gesture.reset.mockClear();
  return result;
}
function unmount() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects = []; }

beforeEach(() => {
  gesture.scale = 1;
  vi.clearAllMocks();
  hooks.values = []; hooks.effects = []; hooks.pending = [];
  fullscreenSource.mockReset().mockImplementation(async () => ({ src: 'blob:safe-original', release: vi.fn() }));
});
afterEach(unmount);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
function text(value: React.ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  return isValidElement(value) ? text((value as Element).props.children) : '';
}

describe('fullscreen source preparation', () => {
  it('shows loading without attaching an unchecked image source', async () => {
    const source = deferred<{ src: string; release: () => void }>();
    fullscreenSource.mockReturnValue(source.promise);
    const props = { src: 'asset://large.png', onError: vi.fn() };
    const loading = render(props);
    expect(text(loading)).toContain('正在加载...');
    expect(children(children(loading)[0])[0].type).not.toBe('img');
    source.resolve({ src: 'blob:validated', release: vi.fn() });
    await Promise.resolve();
    const image = children(children(render(props))[0])[0];
    expect(image.type).toBe('img');
    expect(image.props.src).toBe('blob:validated');
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('keeps a fixed preparation failure inside the viewer and allows an explicit retry', async () => {
    fullscreenSource.mockRejectedValueOnce(new FullscreenImageSourceError('busy'))
      .mockResolvedValueOnce({ src: 'blob:retry', release: vi.fn() });
    const props = { src: 'asset://large.png', onError: vi.fn(), onClose: vi.fn() };
    const failure = await ready(props);
    expect(text(failure)).toContain(FULLSCREEN_IMAGE_ERRORS.busy);
    expect(props.onError).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    const buttons = children(children(children(failure)[0])[0]).flatMap(children);
    const retry = buttons.find((element) => text(element) === '重新加载')!;
    expect(retry).toBeDefined();
    retry.props.onClick?.(new Event('click'));
    const image = children(children(await ready(props))[0])[0];
    expect(image.props.src).toBe('blob:retry');
    expect(fullscreenSource).toHaveBeenCalledTimes(2);
  });

  it('preserves the native img error notification and stops its lease', async () => {
    const props = { src: 'asset://corrupt.png', onError: vi.fn() };
    const root = await ready(props);
    const image = children(children(root)[0])[0];
    image.props.onError?.();
    expect(props.onError).toHaveBeenCalledOnce();
    expect((fullscreenSource.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    expect(text(render(props))).toContain(FULLSCREEN_IMAGE_ERRORS.unavailable);
    expect(fullscreenSource).toHaveBeenCalledOnce();
  });

  it('cancels an old source and releases its late lease without replacing the newer image', async () => {
    const old = deferred<{ src: string; release: () => void }>();
    const release = vi.fn();
    fullscreenSource.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ src: 'blob:second', release: vi.fn() });
    render({ src: 'asset://first.png' });
    const latest = { src: 'asset://second.png' };
    render(latest); await Promise.resolve();
    expect((fullscreenSource.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    old.resolve({ src: 'blob:stale', release }); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(children(children(render(latest))[0])[0].props.src).toBe('blob:second');
  });

  it('releases a late lease after the viewer has unmounted', async () => {
    const pending = deferred<{ src: string; release: () => void }>();
    const release = vi.fn();
    fullscreenSource.mockReturnValue(pending.promise);
    render({ src: 'asset://first.png' }); unmount();
    pending.resolve({ src: 'blob:late', release }); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('fullscreen image zoom controls', () => {
  it('uses only the prepared display source without changing the original reference', async () => {
    const source = 'http://127.0.0.1:8188/view?filename=output.png&type=output';
    const onError = vi.fn();
    fullscreenSource.mockResolvedValue({ src: 'blob:comfy-original', release: vi.fn() });
    const image = children(children(await ready({ src: source, onError }))[0])[0];
    expect(fullscreenSource).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(image.props.src).toBe('blob:comfy-original');
  });

  it('静止图片不保持变换图层，也不对大图追加过渡或 will-change', async () => {
    const image = children(children(await ready({ src: 'asset://preview.png' }))[0])[0];
    expect(image.props.style?.transform).toBe('none');
    expect(image.props.style).not.toHaveProperty('transition');
    expect(image.props.style).not.toHaveProperty('willChange');
  });

  it.each([
    ['放大', 1, 1.4],
    ['缩小', 1.4, 1],
    ['复位缩放', 1, null],
  ] as const)('%s does not close the preview', async (label, scale, expectedScale) => {
    gesture.scale = scale;
    const onClose = vi.fn();
    const root = await ready({ src: 'asset://preview.png', onClose });
    const controls = children(root).find((element) => element.props.className === 'zoom-controls')!;
    const button = children(controls).find((element) => element.props['aria-label'] === label)!;

    dispatch([button, controls, root]);

    expect(onClose).not.toHaveBeenCalled();
    if (expectedScale === null) expect(gesture.reset).toHaveBeenCalledOnce();
    else expect(gesture.zoomTo).toHaveBeenCalledWith(expectedScale, 0, 0);
  });

  it.each([1, 1.4, 8])('keeps image clicks inside the preview at scale %s', async (scale) => {
    gesture.scale = scale;
    const onClose = vi.fn();
    const parent = { props: { onClick: vi.fn() } } as unknown as Element;
    const root = await ready({ src: 'asset://preview.png', onClose });
    const stage = children(root)[0];
    const image = children(stage)[0];
    dispatch([image, stage, root, parent]);
    expect(onClose).not.toHaveBeenCalled();
    expect(parent.props.onClick).not.toHaveBeenCalled();
  });

  it('keeps the two clicks before a double click open and then zooms around the cursor', async () => {
    const onClose = vi.fn();
    const root = await ready({ src: 'asset://preview.png', onClose });
    const stage = children(root)[0];
    const image = children(stage)[0];
    dispatch([image, stage, root]);
    dispatch([image, stage, root]);
    dispatch([image, stage, root], 'onDoubleClick');
    expect(onClose).not.toHaveBeenCalled();
    expect(gesture.zoomTo).toHaveBeenCalledExactlyOnceWith(2, 0, 0);
  });

  it('still closes when directly clicking the blank background at the default scale', async () => {
    const onClose = vi.fn();
    const root = await ready({ src: 'asset://preview.png', onClose });
    dispatch([root]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['onMouseDown', 'onMouseUp'] as const)('keeps image and control %s inside the viewer at every scale', async (handler) => {
    for (const scale of [1, 1.4, 8]) {
      gesture.scale = scale;
      const root = await ready({ src: 'asset://preview.png' });
      const parent = { props: { [handler]: vi.fn() } } as unknown as Element;
      const image = children(children(root)[0])[0];
      const controls = children(root).find((element) => element.props.className === 'zoom-controls')!;
      dispatch([image, root, parent], handler);
      dispatch([children(controls)[0], controls, root, parent], handler);
      expect(parent.props[handler]).not.toHaveBeenCalled();
    }
  });

  it.each(['onMouseDown', 'onMouseUp'] as const)('allows backdrop %s to reach Tauri only at the default scale', async (handler) => {
    for (const scale of [1, 1.4, 8]) {
      gesture.scale = scale;
      const root = await ready({ src: 'asset://preview.png' });
      const parent = { props: { [handler]: vi.fn() } } as unknown as Element;
      dispatch([root, parent], handler);
      expect(root.props['data-tauri-drag-region']).toBe(scale === 1 ? 'true' : 'false');
      expect(parent.props[handler]).toHaveBeenCalledTimes(scale === 1 ? 1 : 0);
    }
  });
});
