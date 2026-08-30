import { readFileSync } from 'node:fs';
import type { ImgHTMLAttributes, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  refCursor: 0,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      hooks.effects.push(effect);
    },
    useRef: <T,>(initialValue: T) => {
      const index = hooks.refCursor;
      hooks.refCursor += 1;
      if (!hooks.refs[index]) hooks.refs[index] = { current: initialValue };
      return hooks.refs[index] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = hooks.stateCursor;
      hooks.stateCursor += 1;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        const current = hooks.values[index] as T;
        hooks.values[index] = typeof next === 'function'
          ? (next as (value: T) => T)(current)
          : next;
      };
      return [hooks.values[index] as T, setValue] as const;
    },
  };
});

import ViewportImage from '../../src/components/shared/ViewportImage';
import { releaseViewportVideoElement } from '../../src/components/shared/viewportVideoResource';

const originalIntersectionObserver = globalThis.IntersectionObserver;
const viewportImageSource = readFileSync(
  new URL('../../src/components/shared/ViewportImage.tsx', import.meta.url),
  'utf8',
);
const viewportMediaHookSource = readFileSync(
  new URL('../../src/hooks/useViewportMediaSource.ts', import.meta.url),
  'utf8',
);
const projectAssetsSource = readFileSync(
  new URL('../../src/components/ProjectAssetsOverlay.tsx', import.meta.url),
  'utf8',
);
const characterLibrarySource = readFileSync(
  new URL('../../src/components/CharacterLibraryPanel.tsx', import.meta.url),
  'utf8',
);
const messageBubbleSource = readFileSync(
  new URL('../../src/components/chat/MessageBubble.tsx', import.meta.url),
  'utf8',
);
const panelsCssSource = readFileSync(
  new URL('../../src/styles/panels.css', import.meta.url),
  'utf8',
);

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  private readonly callback: IntersectionObserverCallback;
  readonly options?: IntersectionObserverInit;

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  emit(target: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function renderViewportImage(
  props: ImgHTMLAttributes<HTMLImageElement> & { src?: string; eager?: boolean; unloadDelayMs?: number },
): ReactElement<ImgHTMLAttributes<HTMLImageElement>> {
  hooks.stateCursor = 0;
  hooks.refCursor = 0;
  hooks.effects = [];
  return ViewportImage(props) as ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
}

function installFakeObserver(): void {
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
}

afterEach(() => {
  vi.useRealTimers();
  if (originalIntersectionObserver === undefined) {
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  } else {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

describe('ViewportImage', () => {
  beforeEach(() => {
    hooks.values = [];
    hooks.refs = [];
    hooks.stateCursor = 0;
    hooks.refCursor = 0;
    hooks.effects = [];
    FakeIntersectionObserver.instances = [];
  });

  it('mounts near-viewport sources, unloads them after a delay, and releases the observer', () => {
    vi.useFakeTimers();
    installFakeObserver();
    const element = {} as Element;

    let image = renderViewportImage({
      src: 'asset://large-image.png',
      alt: 'preview',
      unloadDelayMs: 2_000,
    });
    expect(image.props.src).toBeUndefined();
    expect(image.props['data-viewport-image' as keyof typeof image.props]).toBe('deferred');

    hooks.refs[0].current = element;
    const cleanup = hooks.effects[0]?.();
    const observer = FakeIntersectionObserver.instances[0];
    expect(observer.observe).toHaveBeenCalledWith(element);

    observer.emit(element, true);
    image = renderViewportImage({ src: 'asset://large-image.png', alt: 'preview', unloadDelayMs: 2_000 });
    expect(image.props.src).toBe('asset://large-image.png');

    observer.emit(element, false);
    vi.advanceTimersByTime(1_999);
    image = renderViewportImage({ src: 'asset://large-image.png', alt: 'preview', unloadDelayMs: 2_000 });
    expect(image.props.src).toBe('asset://large-image.png');
    vi.advanceTimersByTime(1);
    image = renderViewportImage({ src: 'asset://large-image.png', alt: 'preview', unloadDelayMs: 2_000 });
    expect(image.props.src).toBeUndefined();

    if (typeof cleanup === 'function') cleanup();
    expect(observer.unobserve).toHaveBeenCalledWith(element);
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('falls back to a normal lazy image when IntersectionObserver is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    const image = renderViewportImage({ src: 'asset://large-image.png', alt: 'preview' });

    expect(image.props.src).toBe('asset://large-image.png');
    expect(image.props.loading).toBe('lazy');
    expect(image.props.decoding).toBe('async');
  });

  it('keeps explicitly eager images mounted', () => {
    installFakeObserver();
    const image = renderViewportImage({ src: 'asset://selected.png', alt: 'selected', eager: true });

    expect(image.props.src).toBe('asset://selected.png');
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it('clears a pending unload timer when the component unmounts', () => {
    vi.useFakeTimers();
    installFakeObserver();
    const element = {} as Element;

    renderViewportImage({ src: 'asset://large-image.png', alt: 'preview', unloadDelayMs: 2_000 });
    hooks.refs[0].current = element;
    const cleanup = hooks.effects[0]?.();
    const observer = FakeIntersectionObserver.instances[0];
    observer.emit(element, true);
    observer.emit(element, false);

    if (typeof cleanup === 'function') cleanup();
    vi.advanceTimersByTime(2_000);
    const image = renderViewportImage({
      src: 'asset://large-image.png',
      alt: 'preview',
      unloadDelayMs: 2_000,
    });
    expect(image.props.src).toBe('asset://large-image.png');
  });

  it('shares viewport observers and skips layout work for offscreen asset cards', () => {
    expect(viewportImageSource).toContain('useViewportMediaSource');
    expect(viewportMediaHookSource).toContain('const observerPools = new Map');
    expect(viewportMediaHookSource.match(/new IntersectionObserver/g)).toHaveLength(1);
    expect(panelsCssSource).toMatch(
      /\.assets-waterfall-card\s*\{(?=[^}]*content-visibility:\s*auto)(?=[^}]*contain-intrinsic-size:\s*auto 260px)[^}]*\}/s,
    );
    expect(panelsCssSource).toMatch(
      /\.drama-asset-card\s*\{(?=[^}]*content-visibility:\s*auto)(?=[^}]*contain-intrinsic-size:\s*auto 148px)[^}]*\}/s,
    );
    expect(panelsCssSource).toMatch(/\.project-asset-card\s*\{[^}]*content-visibility:\s*auto/s);
    expect(panelsCssSource).toMatch(/\.character-action-card\s*\{[^}]*content-visibility:\s*auto/s);
  });

  it('actively releases offscreen video players and uses them in long media lists', () => {
    const video = {
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    releaseViewportVideoElement(video);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.load).toHaveBeenCalledOnce();
    expect(projectAssetsSource).toContain('<ViewportVideo');
    expect(projectAssetsSource).toContain('for (const ep of episodes)');
    expect(projectAssetsSource).toContain('loadRequestRef.current !== requestId');
    expect(projectAssetsSource).not.toMatch(/Promise\.all\(\s*episodes\.map/);
    expect(characterLibrarySource.match(/<ViewportVideo/g)?.length).toBeGreaterThanOrEqual(3);
    expect(messageBubbleSource).toContain('<ViewportVideo');
  });
});
