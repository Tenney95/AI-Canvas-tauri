import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineProps } from '../../src/components/shared/Timeline';
import { formatTimelineTime, sampleTimelineThumbnails } from '../../src/components/shared/timelineGeometry';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  stateCursor: 0, refCursor: 0, effects: [] as Array<() => void | (() => void)>, layouts: [] as Array<() => void | (() => void)> }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(fn: T) => fn,
  useMemo: <T,>(fn: () => T) => fn(),
  useRef: <T,>(value: T) => {
    const index = hooks.refCursor++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: value });
  },
  useEffect: (fn: () => void | (() => void)) => hooks.effects.push(fn),
  useLayoutEffect: (fn: () => void | (() => void)) => hooks.layouts.push(fn),
  useState: <T,>(initial: T) => {
    const index = hooks.stateCursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((value: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.states[index] as T) : next;
    }];
  },
}));
import Timeline from '../../src/components/shared/Timeline';

interface ElementLike { props: Record<string, unknown> & { children?: unknown }; type: unknown }
function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}
function invoke(element: ElementLike, handler: string, event: unknown) {
  (element.props[handler] as (event: unknown) => void)(event);
}
const labels = { title: '时间轴', playhead: '播放头', track: '视频轨', segments: '生成段', addMarker: '打点',
  removeMarker: '删除', resetMarkers: '自动', zoomIn: '放大', zoomOut: '缩小', fit: '适应', position: '秒', marker: '切点' };
function props(extra: Partial<TimelineProps> = {}): TimelineProps {
  return { duration: 60, playhead: 10, thumbnails: ['a', 'b'], markers: [{ id: 'cut', time: 20 }],
    segments: [{ id: 'one', start: 0, end: 30, label: '0–30' }, { id: 'two', start: 30, end: 60, label: '30–60' }],
    labels, onSeek: vi.fn(), onAddMarker: vi.fn(), onMoveMarker: vi.fn(), onRemoveMarker: vi.fn(),
    onResetMarkers: vi.fn(), ...extra };
}
function render(options: TimelineProps) {
  hooks.stateCursor = 0; hooks.refCursor = 0; hooks.effects = []; hooks.layouts = [];
  return elements(Timeline(options));
}
function byClass(nodes: ElementLike[], name: string): ElementLike {
  const found = nodes.find((node) => String(node.props.className).split(' ').includes(name));
  expect(found).toBeDefined(); return found!;
}
class PointerTarget {
  listeners = new Map<string, (event: unknown) => void>(); captured = false;
  setPointerCapture() { this.captured = true; }
  hasPointerCapture() { return this.captured; }
  releasePointerCapture() { this.captured = false; }
  addEventListener(name: string, callback: (event: unknown) => void) { this.listeners.set(name, callback); }
  removeEventListener(name: string) { this.listeners.delete(name); }
}
const pointer = (target: PointerTarget, clientX: number) => ({ currentTarget: target, clientX, button: 0, pointerId: 1,
  preventDefault: vi.fn(), stopPropagation: vi.fn() });
beforeEach(() => { hooks.states = []; hooks.refs = []; hooks.stateCursor = 0; hooks.refCursor = 0; });

describe('shared Timeline', () => {
  it('shows zero-based timecodes and accessible icon tools in the compact ruler layout', () => {
    expect(formatTimelineTime(0, 10)).toBe('00:00');
    expect(formatTimelineTime(10, 10)).toBe('00:10');
    expect(formatTimelineTime(95, 10)).toBe('01:35');
    expect(formatTimelineTime(59.96, 0.1)).toBe('01:00.0');
    expect(formatTimelineTime(3600, 10)).toBe('01:00:00');
    const html = renderToStaticMarkup(<Timeline {...props()} />);
    expect(html).toContain('ui-timeline__tick-label">00:00</em>');
    expect(html).toContain('aria-label="打点" title="打点 · S"');
    expect(html).toContain('aria-label="删除" title="删除 · Delete / Backspace"');
    expect(html).toContain('ui-icon-btn--ghost');
    expect(html).toContain('ui-timeline__split-icon');
    expect(html).not.toContain('<kbd');
  });

  it('renders source frames and full generated segments with bounded thumbnail work', () => {
    const html = renderToStaticMarkup(<Timeline {...props()} />);
    expect(html).toContain('ui-timeline__ruler'); expect(html).toContain('ui-timeline__thumbnails');
    expect(html).toContain('30–60'); expect(html).toContain('aria-label="切点 20.000s"');
    expect(sampleTimelineThumbnails({ thumbnails: ['a', 'b'], sourceDuration: 60, duration: 300, pixelsPerSecond: 400 })).toHaveLength(360);
    expect(sampleTimelineThumbnails({ thumbnails: ['a', 'b'], timestamps: [0, 59], sourceDuration: 60,
      sourceIn: 55, duration: 5, pixelsPerSecond: 10 })).toEqual(['b']);
    expect(sampleTimelineThumbnails({ thumbnails: ['a', 'b'], sourceDuration: 60, sourceIn: 30, duration: 30, pixelsPerSecond: 2 })).toEqual(['b']);
  });

  it('converts pointer position using scroll offset and clamps playhead to the source', () => {
    const options = props(); const nodes = render(options); const target = new PointerTarget();
    hooks.refs[0].current = { scrollLeft: 100, getBoundingClientRect: () => ({ left: 50 }) };
    invoke(byClass(nodes, 'ui-timeline__track'), 'onPointerDown', pointer(target, 350));
    expect(options.onSeek).toHaveBeenCalledWith(10);
    target.listeners.get('pointermove')?.({ clientX: 10000 }); expect(options.onSeek).toHaveBeenLastCalledWith(60);
    target.listeners.get('pointerup')?.({}); expect(target.listeners.size).toBe(0); expect(target.captured).toBe(false);
  });

  it('previews marker movement and commits once on release, with no commit on cancellation', () => {
    const options = props(); const nodes = render(options); const target = new PointerTarget();
    hooks.refs[0].current = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0 }) };
    const marker = byClass(nodes, 'ui-timeline__marker');
    invoke(marker, 'onPointerDown', pointer(target, 800));
    target.listeners.get('pointermove')?.({ clientX: 1000 }); expect(options.onMoveMarker).not.toHaveBeenCalled();
    target.listeners.get('pointerup')?.({}); expect(options.onMoveMarker).toHaveBeenCalledExactlyOnceWith('cut', 25);
    invoke(marker, 'onClick', {}); expect(options.onSeek).not.toHaveBeenCalled();
    invoke(marker, 'onPointerDown', pointer(target, 800)); target.listeners.get('pointermove')?.({ clientX: 900 });
    target.listeners.get('pointercancel')?.({}); expect(options.onMoveMarker).toHaveBeenCalledTimes(1);
    expect(target.listeners.size).toBe(0);
  });

  it('supports cut keyboard shortcuts, precise positions, marker keys and disabled interaction', () => {
    const options = props(); let nodes = render(options);
    const key = (key: string) => ({ key, target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    invoke(nodes[0], 'onKeyDown', key('s')); expect(options.onAddMarker).toHaveBeenCalledWith(10);
    invoke(byClass(nodes, 'ui-timeline__marker'), 'onClick', {}); nodes = render(options);
    invoke(nodes[0], 'onKeyDown', key('Delete')); expect(options.onRemoveMarker).toHaveBeenCalledWith('cut');
    invoke(byClass(nodes, 'ui-timeline__marker'), 'onKeyDown', key('ArrowRight'));
    expect(options.onMoveMarker).toHaveBeenCalledWith('cut', 20.1);
    nodes = render({ ...options, disabled: true });
    invoke(nodes[0], 'onKeyDown', key('s')); expect(options.onAddMarker).toHaveBeenCalledTimes(1);
    const target = new PointerTarget(); invoke(byClass(nodes, 'ui-timeline__track'), 'onPointerDown', pointer(target, 300));
    expect(target.captured).toBe(false);
  });

  it('cancels active pointer subscriptions when unmounted and preserves viewport callbacks', () => {
    const options = props({ viewState: { pixelsPerSecond: 80, scrollLeft: 300 }, onViewChange: vi.fn() });
    const nodes = render(options); const target = new PointerTarget();
    const scroll = { scrollLeft: 0, clientWidth: 600, getBoundingClientRect: () => ({ left: 0 }) };
    hooks.refs[0].current = scroll;
    hooks.layouts.forEach((fn) => fn()); expect(scroll.scrollLeft).toBe(300);
    invoke(byClass(nodes, 'ui-timeline__scroll'), 'onScroll', { currentTarget: { scrollLeft: 320 } });
    expect(options.onViewChange).toHaveBeenLastCalledWith(expect.objectContaining({ pixelsPerSecond: 80, scrollLeft: 320 }));
    invoke(byClass(nodes, 'ui-timeline__marker'), 'onPointerDown', pointer(target, 100));
    const clean = hooks.effects[0](); expect(clean).toBeTypeOf('function'); if (typeof clean === 'function') clean();
    expect(target.listeners.size).toBe(0); expect(options.onMoveMarker).not.toHaveBeenCalled();
  });
});
