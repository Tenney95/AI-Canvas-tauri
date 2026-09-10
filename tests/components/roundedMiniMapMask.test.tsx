import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ pending: [] as Array<() => void | (() => void)> }));

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => effects.pending.push(effect),
}));

import RoundedMiniMapMask from '../../src/components/canvas/RoundedMiniMapMask';

const outerPath = 'M-100,-100h2000v2000h-2000z';
const squarePath = (x = 10, width = 600, height = 400) => (
  `${outerPath} M${x},20h${width}v${height}h${-width}z`
);

class MiniMapSvg {
  screenWidth = 180;
  viewBoxWidth = 1800;
  readViewBox = vi.fn(() => ({ width: this.viewBoxWidth }));
  viewBox = Object.defineProperty({}, 'baseVal', { get: this.readViewBox });
  getBoundingClientRect = vi.fn(() => ({ width: this.screenWidth }));
}

class MaskPath {
  isConnected = true;
  d = squarePath();
  ownerSVGElement = new MiniMapSvg();
  getAttribute = vi.fn(() => this.d);
  setAttribute = vi.fn((_name: string, value: string) => {
    this.d = value;
    notifyMutation(this);
  });
}

class MutationObserverMock {
  static instances: MutationObserverMock[] = [];
  static pending = new Set<MutationObserverMock>();
  readonly callback: () => void;
  target: unknown;
  active = false;
  observe = vi.fn((target: unknown) => {
    this.target = target;
    this.active = true;
  });
  disconnect = vi.fn(() => {
    this.active = false;
    MutationObserverMock.pending.delete(this);
  });

  constructor(callback: () => void) {
    this.callback = callback;
    MutationObserverMock.instances.push(this);
  }
}

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly callback: () => void;
  target: unknown;
  active = false;
  observe = vi.fn((target: unknown) => {
    this.target = target;
    this.active = true;
  });
  disconnect = vi.fn(() => { this.active = false; });

  constructor(callback: () => void) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
}

function notifyMutation(target: unknown) {
  for (const observer of MutationObserverMock.instances) {
    if (observer.active && observer.target === target) MutationObserverMock.pending.add(observer);
  }
}

function flushMutationBatch() {
  const pending = [...MutationObserverMock.pending];
  MutationObserverMock.pending.clear();
  for (const observer of pending) {
    if (observer.active) observer.callback();
  }
}

function flushMutations() {
  for (let count = 0; MutationObserverMock.pending.size > 0; count++) {
    if (count > 10) throw new Error('Mask mutation observer did not settle');
    flushMutationBatch();
  }
}

function writeReactFlowPath(path: MaskPath, d: string) {
  path.d = d;
  notifyMutation(path);
}

function resize(svg: MiniMapSvg, width: number) {
  svg.screenWidth = width;
  for (const observer of ResizeObserverMock.instances) {
    if (observer.active && observer.target === svg) observer.callback();
  }
  flushMutations();
}

function pathRadius(path: MaskPath): number {
  return Number(path.d.match(/a([^,]+),/)?.[1]);
}

describe('rounded minimap mask', () => {
  let path: MaskPath;
  let connectedPath: MaskPath | null;
  let body: object;
  let querySelector: ReturnType<typeof vi.fn<() => MaskPath | null>>;
  let cleanup: (() => void) | undefined;

  const mount = (radius = 6) => {
    RoundedMiniMapMask({ radius });
    cleanup = effects.pending.shift()?.() || undefined;
  };

  beforeEach(() => {
    effects.pending = [];
    MutationObserverMock.instances = [];
    MutationObserverMock.pending.clear();
    ResizeObserverMock.instances = [];
    path = new MaskPath();
    connectedPath = path;
    body = {};
    querySelector = vi.fn(() => connectedPath);
    vi.stubGlobal('document', { body, querySelector });
    vi.stubGlobal('MutationObserver', MutationObserverMock);
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
  });

  it('preserves the outer mask and uses a screen-pixel corner radius', () => {
    mount();

    expect(path.d.startsWith(`${outerPath}\nM70,20h480a60,60`)).toBe(true);
    expect(pathRadius(path)).toBe(60);
    expect(path.ownerSVGElement.getBoundingClientRect).toHaveBeenCalledTimes(1);

    writeReactFlowPath(path, squarePath(10, 50, 60));
    flushMutations();
    expect(pathRadius(path)).toBe(25);
  });

  it('does not measure or search the DOM again for repeated viewport and unrelated DOM updates', () => {
    mount();

    for (let index = 0; index < 100; index++) {
      writeReactFlowPath(path, squarePath(index));
      notifyMutation(body);
      flushMutations();
    }

    expect(path.ownerSVGElement.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(querySelector).toHaveBeenCalledTimes(1);
    expect(path.ownerSVGElement.readViewBox).toHaveBeenCalledTimes(101);
    expect(path.setAttribute).toHaveBeenCalledTimes(101);
    expect(path.d).toContain('\nM159,20h480a60,60');
  });

  it('ignores its own path write before reading the viewBox or rebuilding the path', () => {
    mount();
    writeReactFlowPath(path, squarePath(30));
    flushMutationBatch();
    expect(MutationObserverMock.pending.size).toBe(1);

    path.ownerSVGElement.readViewBox.mockClear();
    path.setAttribute.mockClear();
    flushMutationBatch();

    expect(path.ownerSVGElement.readViewBox).not.toHaveBeenCalled();
    expect(path.setAttribute).not.toHaveBeenCalled();
    expect(MutationObserverMock.pending.size).toBe(0);
  });

  it('uses the latest viewBox during zoom without remeasuring the SVG', () => {
    mount();
    path.ownerSVGElement.viewBoxWidth = 3600;
    writeReactFlowPath(path, squarePath(15));
    flushMutations();

    expect(pathRadius(path)).toBe(120);
    expect(path.ownerSVGElement.getBoundingClientRect).toHaveBeenCalledTimes(1);
  });

  it('recalculates the radius on resize and does not rewrite for an unchanged initial resize notification', () => {
    mount();
    resize(path.ownerSVGElement, 180);
    expect(path.setAttribute).toHaveBeenCalledTimes(1);

    resize(path.ownerSVGElement, 360);
    expect(pathRadius(path)).toBe(30);
    expect(path.setAttribute).toHaveBeenCalledTimes(2);

    resize(path.ownerSVGElement, 0);
    writeReactFlowPath(path, squarePath(80));
    flushMutations();
    expect(path.d).toBe(squarePath(80));

    resize(path.ownerSVGElement, 180);
    expect(pathRadius(path)).toBe(60);
    expect(path.d).toContain('\nM140,20h480a60,60');
  });

  it('disconnects a removed mask and reconnects when the minimap becomes visible again', () => {
    connectedPath = null;
    mount();
    expect(path.setAttribute).not.toHaveBeenCalled();

    connectedPath = path;
    notifyMutation(body);
    flushMutations();
    expect(pathRadius(path)).toBe(60);
    const oldPathObserver = MutationObserverMock.instances.find((observer) => observer.target === path)!;
    const oldResizeObserver = ResizeObserverMock.instances[0];

    path.isConnected = false;
    connectedPath = null;
    notifyMutation(body);
    flushMutations();
    expect(oldPathObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(oldResizeObserver.disconnect).toHaveBeenCalledTimes(1);

    connectedPath = new MaskPath();
    connectedPath.ownerSVGElement.screenWidth = 360;
    notifyMutation(body);
    flushMutations();
    expect(pathRadius(connectedPath)).toBe(30);
    expect(connectedPath.ownerSVGElement.getBoundingClientRect).toHaveBeenCalledTimes(1);
  });

  it('replaces detached masks and cleans every observer on unmount', () => {
    mount();
    const firstPath = path;
    firstPath.isConnected = false;
    path = new MaskPath();
    connectedPath = path;
    notifyMutation(body);
    flushMutations();
    expect(pathRadius(path)).toBe(60);

    const oldMeasurements = firstPath.ownerSVGElement.getBoundingClientRect.mock.calls.length;
    resize(firstPath.ownerSVGElement, 720);
    writeReactFlowPath(firstPath, squarePath(90));
    flushMutations();
    expect(firstPath.ownerSVGElement.getBoundingClientRect).toHaveBeenCalledTimes(oldMeasurements);
    expect(firstPath.d).toBe(squarePath(90));

    cleanup?.();
    cleanup = undefined;
    expect(MutationObserverMock.instances.every((observer) => !observer.active)).toBe(true);
    expect(ResizeObserverMock.instances.every((observer) => !observer.active)).toBe(true);

    path.setAttribute.mockClear();
    path.ownerSVGElement.getBoundingClientRect.mockClear();
    notifyMutation(body);
    writeReactFlowPath(path, squarePath(120));
    resize(path.ownerSVGElement, 720);
    flushMutations();
    expect(path.setAttribute).not.toHaveBeenCalled();
    expect(path.ownerSVGElement.getBoundingClientRect).not.toHaveBeenCalled();
  });
});
