import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewport } from '@xyflow/react';
import { bindCanvasWheelZoom } from '../../src/hooks/useCanvasWheelZoom';

class Surface extends EventTarget {
  excluded = false;
  flow: Surface = this;
  closest(selector: string) { return selector === '.react-flow' ? this.flow : this.excluded ? this : null; }
  getBoundingClientRect() { return { left: 25, top: 50, width: 1000, height: 800 }; }
}

let surface: Surface;
let viewport: Viewport;
let frames: Map<number, FrameRequestCallback>;
let now: number;
let nextFrame: number;
let destroy: () => void;
let win: EventTarget;
let doc: EventTarget & { hidden: boolean };
let onStart: ReturnType<typeof vi.fn<() => void>>;
let onEnd: ReturnType<typeof vi.fn<(interrupted: boolean) => void>>;
let setViewport: ReturnType<typeof vi.fn<(next: Viewport) => Promise<boolean>>>;

function wheel(deltaY: number, extras: Partial<WheelEvent> = {}) {
  const event = new Event('wheel', { cancelable: true, bubbles: true });
  Object.assign(event, { deltaY, deltaMode: 0, clientX: 425, clientY: 350, buttons: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...extras });
  surface.dispatchEvent(event);
  return event;
}
function timeAt(time: number) {
  const delta = time - now;
  now = time;
  vi.advanceTimersByTime(delta);
}
function frameAt(time: number) {
  timeAt(time);
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(now));
}
function install() {
  vi.stubGlobal('window', win);
  destroy = bindCanvasWheelZoom(surface as unknown as HTMLElement, {
    getViewport: () => viewport, setViewport, onStart, onEnd, minZoom: 0.1, maxZoom: 5,
  }).destroy;
}

beforeEach(() => {
  vi.useFakeTimers();
  surface = new Surface(); viewport = { x: 20, y: 30, zoom: 1 };
  frames = new Map(); now = 0; nextFrame = 0;
  win = new EventTarget(); doc = Object.assign(new EventTarget(), { hidden: false });
  onStart = vi.fn(); onEnd = vi.fn();
  setViewport = vi.fn(async next => { viewport = next; return true; });
  vi.stubGlobal('Element', Surface);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  install();
});
afterEach(() => { destroy(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('canvas fine wheel zoom', () => {
  it('starts on the next frame, reaches an 8% notch in 60ms and releases the UI without a tail', () => {
    const event = wheel(-120);
    expect(event.defaultPrevented).toBe(true);
    expect(viewport.zoom).toBe(1);
    expect(onStart).toHaveBeenCalledOnce();
    frameAt(16);
    expect(viewport.zoom).toBeGreaterThan(1);
    expect(viewport.zoom).toBeLessThan(1.08);
    expect((400 - viewport.x) / viewport.zoom).toBeCloseTo(380, 8);
    expect((300 - viewport.y) / viewport.zoom).toBeCloseTo(270, 8);
    expect(onEnd).not.toHaveBeenCalled();
    frameAt(59);
    expect(onEnd).not.toHaveBeenCalled();
    frameAt(60);
    expect(viewport.zoom).toBeCloseTo(1.08, 8);
    expect((400 - viewport.x) / viewport.zoom).toBeCloseTo(380, 8);
    expect((300 - viewport.y) / viewport.zoom).toBeCloseTo(270, 8);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(false);
    const committed = { ...viewport };
    const committedCount = setViewport.mock.calls.length;
    frameAt(300);
    expect(viewport).toEqual(committed);
    expect(setViewport).toHaveBeenCalledTimes(committedCount);
    expect(frames.size).toBe(0);
  });

  it('coalesces a burst into one frame and preserves the accumulated target', () => {
    for (let i = 0; i < 12; i++) wheel(-10);
    expect(frames.size).toBe(1);
    frameAt(120);
    expect(setViewport).toHaveBeenCalledOnce();
    expect(viewport.zoom).toBeCloseTo(1.08, 8);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it.each([1, 15])('keeps up with sustained input arriving %sms before each display frame', lead => {
    for (let i = 1; i <= 10; i++) {
      timeAt(i * 16 - lead);
      wheel(-12);
      expect(frames.size).toBe(1);
      const previous = viewport.zoom;
      frameAt(i * 16);
      expect(viewport.zoom).toBeGreaterThan(previous);
    }
    // 累计目标为8%；不能将主要缩放积压到停滚之后才执行。
    expect(viewport.zoom).toBeGreaterThan(1.065);
    expect(viewport.zoom).toBeLessThan(1.08);
    expect(setViewport).toHaveBeenCalledTimes(10);
    frameAt(now + 60);
    expect(viewport.zoom).toBeCloseTo(1.08, 8);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(false);
    expect(frames.size).toBe(0);
  });

  it.each([
    Array.from({ length: 10 }, (_, i) => ({ at: 1 + i * 16, delta: -12 })),
    Array.from({ length: 20 }, (_, i) => ({ at: 1 + i * 7, delta: -6 })),
    [{ at: 1, delta: -120 }, { at: 16, delta: -120 }],
  ])('shows the same input timeline at common frames on 60Hz and 120Hz displays: %j', (...inputs) => {
    const sample = (hz: number) => {
      destroy();
      viewport = { x: 20, y: 30, zoom: 1 };
      frames.clear(); now = 0;
      setViewport.mockClear();
      install();
      const samples: Viewport[] = [];
      let inputIndex = 0;
      for (let i = 1; i <= hz / 3; i++) {
        const time = i * 1000 / hz;
        while (inputIndex < inputs.length && inputs[inputIndex].at <= time) {
          timeAt(inputs[inputIndex].at);
          const writes = setViewport.mock.calls.length;
          wheel(inputs[inputIndex++].delta);
          expect(setViewport).toHaveBeenCalledTimes(writes);
        }
        frameAt(time);
        if (i % (hz / 60) === 0) samples.push({ ...viewport });
      }
      expect(frames.size).toBe(0);
      return samples;
    };
    const regular = sample(60);
    const highRefresh = sample(120);
    highRefresh.forEach((viewport, index) => {
      expect(viewport.zoom).toBeCloseTo(regular[index].zoom, 9);
      expect(viewport.x).toBeCloseTo(regular[index].x, 8);
      expect(viewport.y).toBeCloseTo(regular[index].y, 8);
    });
  });

  it('reverses on the next frame without leaving an obsolete animation target', () => {
    wheel(-120); wheel(-120);
    frameAt(30);
    const before = viewport.zoom;
    wheel(120);
    frameAt(60);
    expect(viewport.zoom).toBeLessThan(before);
    frameAt(150);
    expect(viewport.zoom).toBeCloseTo(before / 1.08, 8);
  });

  it('adopts a moved cursor without moving its world-space anchor', () => {
    wheel(-100); frameAt(40);
    const x = (700 - viewport.x) / viewport.zoom;
    const y = (500 - viewport.y) / viewport.zoom;
    wheel(-100, { clientX: 725, clientY: 550 });
    frameAt(160);
    expect((700 - viewport.x) / viewport.zoom).toBeCloseTo(x, 8);
    expect((500 - viewport.y) / viewport.zoom).toBeCloseTo(y, 8);
  });

  it.each([[120, 0, 1 / 1.08], [3, 1, 1 / 1.08], [1, 2, 1 / 1.08], [1200, 0, 1 / 1.08 ** 10], [0.25, 0, 1 / 1.08 ** (0.25 / 120)]])('preserves continuous delta %s in mode %s', (deltaY, deltaMode, expected) => {
    wheel(deltaY, { deltaMode }); frameAt(120);
    expect(viewport.zoom).toBeCloseTo(expected, 10);
  });

  it('preserves the same total zoom when a browser combines multiple wheel increments', () => {
    wheel(-240); frameAt(60);
    const combined = viewport.zoom;
    destroy(); viewport = { x: 20, y: 30, zoom: 1 }; install();
    wheel(-120); wheel(-120); frameAt(120);
    expect(viewport.zoom).toBeCloseTo(combined, 10);
    expect(combined).toBeCloseTo(1.08 ** 2, 10);
  });

  it('clamps at both zoom limits and responds immediately when direction changes at the limit', () => {
    viewport.zoom = 4.99;
    wheel(-120); frameAt(120);
    expect(viewport.zoom).toBe(5);
    wheel(-120);
    expect(frames.size).toBe(0);
    wheel(120); frameAt(240);
    expect(viewport.zoom).toBeLessThan(5);
    destroy(); install(); viewport.zoom = 0.101;
    wheel(120); frameAt(360);
    expect(viewport.zoom).toBe(0.1);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { buttons: 1 }, { deltaY: 0 }, { deltaY: Infinity }])('leaves other gestures alone: %j', extras => {
    expect(wheel(-120, extras).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('preserves panel/editor scrolling and does not handle a nested React Flow', () => {
    surface.excluded = true;
    expect(wheel(-100).defaultPrevented).toBe(false);
    surface.excluded = false; surface.flow = new Surface();
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('cancels queued input before dragging or another navigation takes control', () => {
    wheel(-100);
    surface.dispatchEvent(new Event('pointerdown'));
    const before = { ...viewport };
    frameAt(200);
    expect(viewport).toEqual(before);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(true);
    wheel(-100);
    viewport = { x: 40, y: 80, zoom: 2 };
    frameAt(230);
    expect(viewport).toEqual({ x: 40, y: 80, zoom: 2 });
    expect(frames.size).toBe(0);
  });

  it('cleans up pending frames and input listeners when switching project or unmounting', () => {
    wheel(-100); destroy(); frameAt(300);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(true);
    expect(setViewport).not.toHaveBeenCalled();
    expect(wheel(-100).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('keeps same-frame inputs together and clears pending work on blur', () => {
    wheel(-100);
    wheel(-100);
    expect(onStart).toHaveBeenCalledOnce(); expect(onEnd).not.toHaveBeenCalled();
    win.dispatchEvent(new Event('blur'));
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(true);
    expect(frames.size).toBe(0);
  });

  it('follows a same-frame reversal without displaying the obsolete forward target', () => {
    wheel(-120); wheel(120);
    frameAt(16);
    expect(viewport.zoom).toBeLessThan(1);
    frameAt(60);
    expect(viewport.zoom).toBeCloseTo(1 / 1.08, 8);
    expect(frames.size).toBe(0);
    expect(setViewport.mock.calls.every(([next]) => next.zoom <= 1)).toBe(true);
  });

  it('respects reduced motion by applying the same step without interpolation', () => {
    Object.assign(win, { matchMedia: () => ({ matches: true }) });
    destroy(); install();
    wheel(-120); frameAt(16);
    expect(viewport.zoom).toBeCloseTo(1.08, 8);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(false);
    expect(frames.size).toBe(0);
  });
});
