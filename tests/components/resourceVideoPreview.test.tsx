import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Harness {
  states: unknown[]; refs: Array<{ current: unknown }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>; stateIndex: number; refIndex: number; effectIndex: number;
}
const driver = vi.hoisted(() => ({ current: null as Harness | null, visible: true, present: true, reduced: false, poster: vi.fn(), convert: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.current!; const index = scope.stateIndex++;
    if (!(index in scope.states)) scope.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.states[index], (value: T | ((old: T) => T)) => {
      scope.states[index] = typeof value === 'function' ? (value as (old: T) => T)(scope.states[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => {
    const scope = driver.current!; const index = scope.refIndex++;
    return scope.refs[index] ??= { current: initial };
  },
  useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.effectIndex++; const old = scope.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    scope.pending.push(() => { old?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.effectIndex++; const old = scope.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    scope.pending.push(() => { old?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('framer-motion', () => ({ motion: { div: 'div' }, AnimatePresence: 'presence', MotionConfig: 'motion-config', useIsPresent: () => driver.present, useReducedMotion: () => driver.reduced }));
vi.mock('../../src/services/fileService', () => ({ getConvertFileSrc: driver.convert }));
vi.mock('../../src/hooks/useViewportMediaSource', () => ({ useViewportMediaSource: (source: string, _ref: unknown, options?: { eager: boolean }) => driver.visible || options?.eager ? source : undefined }));
vi.mock('../../src/components/nodes/shared/video/canvasVideoPreviewCache', () => ({ acquireCanvasVideoPoster: driver.poster }));

import ResourceVideoPreview from '../../src/components/shared/ResourceVideoPreview';
import { getResourceVideoFloatingRect, resolveResourceVideoSource, useResourceVideoPreview } from '../../src/hooks/useResourceVideoPreview';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
const scopes: Harness[] = [];
const anchorRect = { left: 84, top: 240, width: 100, height: 90, right: 184, bottom: 330 };
const boundary = { getBoundingClientRect: () => ({ left: 72, top: 64, width: 340, height: 644, right: 412, bottom: 708 }) };
const anchor = { getBoundingClientRect: () => anchorRect, closest: () => boundary, querySelector: () => null, contains: () => false };
function harness(): Harness {
  const scope: Harness = { states: [], refs: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, effectIndex: 0 };
  scopes.push(scope); return scope;
}
function dispose(scope: Harness) { scope.effects.forEach((effect) => effect.cleanup?.()); scope.effects = []; }
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
function render<T>(scope: Harness, fn: () => T, video?: unknown): T {
  driver.current = scope; scope.stateIndex = scope.refIndex = scope.effectIndex = 0;
  const tree = fn();
  elements(tree).forEach((element) => { if (element.props.ref) element.props.ref.current = element.type === 'video' ? video : anchor; });
  scope.pending.splice(0).forEach((effect) => effect());
  return tree;
}
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const props = (extra: Partial<ComponentProps<typeof ResourceVideoPreview>> = {}): ComponentProps<typeof ResourceVideoPreview> => ({ src: 'https://media.test/a.mp4', name: '测试视频', expanded: false, onExpandedChange: vi.fn(), ...extra });
function preview(scope: Harness, input = props()) { return render(scope, () => ResourceVideoPreview(input)); }
async function loaded(scope: Harness, input: ComponentProps<typeof ResourceVideoPreview>) {
  if (input.expanded && !scope.states[0]) {
    const tree = preview(scope, { ...input, expanded: false, onExpandedChange: () => {} });
    click(elements(tree).find((item) => item.props['aria-label'] === '展开播放 测试视频')!);
  }
  preview(scope, input); await flush(); preview(scope, input); await flush(); return preview(scope, input);
}
function click(element: Element) { (element.props.onClick as () => void)(); }

beforeEach(() => {
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  driver.visible = true;
  driver.present = true; driver.reduced = false;
  driver.poster.mockReset().mockResolvedValue({ src: 'blob:poster', release: vi.fn() });
  driver.convert.mockReset().mockResolvedValue((path: string) => `asset://localhost/${encodeURIComponent(path)}`);
});
afterEach(() => { scopes.splice(0).forEach(dispose); vi.unstubAllGlobals(); });

describe('资源视频封面与播放器', () => {
  it('默认显示共享封面而不创建播放器，悬浮播放时保留原缩略卡片', async () => {
    const scope = harness(); const input = props(); const tree = await loaded(scope, input);
    expect(elements(tree).find((item) => item.type === 'img')?.props.src).toBe('blob:poster');
    expect(elements(tree).some((item) => item.type === 'video')).toBe(false);
    click(elements(tree).find((item) => item.props['aria-label'] === '展开播放 测试视频')!);
    expect(input.onExpandedChange).toHaveBeenCalledWith(true);
    const expanded = await loaded(scope, { ...input, expanded: true });
    expect(elements(expanded).find((item) => item.props['aria-label'] === '展开播放 测试视频')?.props['aria-expanded']).toBe(true);
    expect(elements(expanded).find((item) => item.type === 'img')?.props.src).toBe('blob:poster');
  });
  it('已有图片封面直接显示，失败时才申请共享视频取帧', async () => {
    const scope = harness(); const input = props({ poster: 'cover.jpg' });
    let tree = await loaded(scope, input);
    expect(driver.poster).not.toHaveBeenCalled();
    const image = elements(tree).find((item) => item.type === 'img')!;
    expect(image.props.src).toBe('cover.jpg'); (image.props.onError as () => void)();
    tree = await loaded(scope, input);
    expect(driver.poster).toHaveBeenCalledOnce();
    expect(elements(tree).find((item) => item.type === 'img')?.props.src).toBe('blob:poster');
  });
  it('离屏缩略项不解析文件或取帧，进入视口才转换本地路径', async () => {
    driver.visible = false;
    const scope = harness(); const input = props({ src: undefined, filePath: 'G:/media/test.mp4' });
    await loaded(scope, input);
    expect(driver.convert).not.toHaveBeenCalled(); expect(driver.poster).not.toHaveBeenCalled();
    driver.visible = true; await loaded(scope, input);
    expect(driver.poster).toHaveBeenCalledWith('asset://localhost/G%3A%2Fmedia%2Ftest.mp4', expect.any(AbortSignal));
  });
  it('离屏和卸载释放封面租约，切换源后拒绝迟到封面', async () => {
    const scope = harness(); const release = vi.fn();
    driver.poster.mockResolvedValueOnce({ src: 'blob:first', release });
    const first = props(); await loaded(scope, first);
    driver.visible = false; preview(scope, first); expect(release).toHaveBeenCalledOnce();
    driver.visible = true;
    let finish!: (value: unknown) => void;
    driver.poster.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    preview(scope, first); await flush();
    const signal = driver.poster.mock.calls.at(-1)![1] as AbortSignal;
    const second = props({ src: 'https://media.test/b.mp4' });
    await loaded(scope, second);
    const lateRelease = vi.fn(); finish({ src: 'blob:late', release: lateRelease }); await flush();
    expect(signal.aborted).toBe(true); expect(lateRelease).toHaveBeenCalledOnce();
    expect(elements(preview(scope, second)).find((item) => item.type === 'img')?.props.src).toBe('blob:poster');
  });
  it('本地媒体不可用时回退已有线上地址，不重新授权目录', async () => {
    driver.poster.mockResolvedValueOnce(null);
    const scope = harness(); const input = props({ filePath: 'G:/missing.mp4' });
    await loaded(scope, input); await loaded(scope, input);
    expect(driver.poster.mock.calls.map((call) => call[0])).toEqual(['asset://localhost/G%3A%2Fmissing.mp4', input.src]);
  });
  it('相同资产键的两张卡片只允许实际点击的一张创建播放器', async () => {
    const first = harness(); const second = harness(); const input = props({ expanded: true });
    const clicked = await loaded(first, input);
    preview(second, input); await flush(); preview(second, input); await flush();
    const duplicate = preview(second, input);
    const isPlayer = (element: Element) => typeof element.type === 'function' && 'onSourceError' in element.props;
    expect(elements(clicked).filter(isPlayer)).toHaveLength(1);
    expect(elements(duplicate).filter(isPlayer)).toHaveLength(0);
    const player = elements(clicked).find(isPlayer)!;
    (player.props.onEnded as () => void)();
    // 同一次事件另一卡片接管，相同资产键令父级 expanded 仍为 true。
    expect(elements(preview(first, input)).filter(isPlayer)).toHaveLength(0);
    click(elements(duplicate).find((element) => element.type === 'button')!);
    expect(elements(preview(second, input)).filter(isPlayer)).toHaveLength(1);
  });
  it('单播放器在性能模式的外层配置中仍启用用户动效策略', async () => {
    const tree = await loaded(harness(), props({ expanded: true }));
    const config = elements(tree).find((element) => element.props.reducedMotion)!;
    expect(config.props.reducedMotion).toBe('user');
    expect(config.props.transition).toMatchObject({ type: 'spring' });
    expect(config.props.transition).not.toHaveProperty('duration', 0);
  });
  it('展开后播放结束和手动收起都通知原列表还原', async () => {
    const scope = harness(); const input = props({ expanded: true }); const tree = await loaded(scope, input);
    const player = elements(tree).find((item) => typeof item.type === 'function')!;
    (player.props.onEnded as () => void)();
    const output = render(harness(), () => (player.type as (p: typeof player.props) => unknown)(player.props));
    click(elements(output).find((item) => item.props['aria-label'] === '收起 测试视频')!);
    expect(input.onExpandedChange).toHaveBeenNthCalledWith(1, false);
    expect(input.onExpandedChange).toHaveBeenNthCalledWith(2, false);
  });
  it('播放器显式播放、无循环；卸载停止解码并忽略迟到的播放失败', async () => {
    const input = props({ expanded: true }); const tree = await loaded(harness(), input);
    const player = elements(tree).find((item) => typeof item.type === 'function')!;
    const scope = harness(); let reject!: (error: Error) => void;
    const video = { play: vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; })), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const output = render(scope, () => (player.type as (p: typeof player.props) => unknown)(player.props), video);
    const element = elements(output).find((item) => item.type === 'video')!;
    expect(element.props.controls).toBe(true); expect(element.props.loop).toBeUndefined();
    expect(video.play).toHaveBeenCalledOnce();
    dispose(scope); reject(new Error('late')); await flush();
    expect(video.pause).toHaveBeenCalledOnce(); expect(video.removeAttribute).toHaveBeenCalledWith('src'); expect(video.load).toHaveBeenCalledOnce();
    expect(scope.states[0]).toBe(false);
  });
  it('自动播放被拦截时保留重试按钮，用户点击后可以播放', async () => {
    const tree = await loaded(harness(), props({ expanded: true }));
    const player = elements(tree).find((item) => typeof item.type === 'function')!;
    const scope = harness(); const video = { play: vi.fn().mockRejectedValueOnce(new Error('blocked')).mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), getAttribute: vi.fn().mockReturnValue('source'), load: vi.fn() };
    const draw = () => render(scope, () => (player.type as (p: typeof player.props) => unknown)(player.props), video);
    draw(); await flush();
    click(elements(draw()).find((item) => item.props.className === 'ui-btn ui-btn--secondary resource-video-retry')!); await flush();
    expect(video.play).toHaveBeenCalledTimes(2);
    (elements(draw()).find((item) => item.type === 'video')!.props.onPlay as () => void)();
    expect(elements(draw()).filter((item) => item.props.className === 'ui-btn ui-btn--secondary resource-video-retry')).toHaveLength(0);
  });
  it('StrictMode 清理后重放初始化会重新设置源并恢复播放', async () => {
    const tree = await loaded(harness(), props({ expanded: true }));
    const player = elements(tree).find((item) => typeof item.type === 'function')!;
    const scope = harness();
    const video = { src: '', play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(),
      removeAttribute: vi.fn(() => { video.src = ''; }), load: vi.fn() };
    const draw = () => render(scope, () => (player.type as (p: typeof player.props) => unknown)(player.props), video);
    draw(); expect(video.src).toBe(player.props.src);
    dispose(scope); expect(video.src).toBe('');
    draw(); expect(video.src).toBe(player.props.src); expect(video.play).toHaveBeenCalledTimes(2);
  });
  it('收起弹簧动画开始即释放播放器，动画结束才卸载浮层', async () => {
    const input = props({ expanded: true }); const parent = harness(); const tree = await loaded(parent, input);
    const player = elements(tree).find((element) => typeof element.type === 'function')!;
    const scope = harness(); const video = { src: '', play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const draw = () => render(scope, () => (player.type as (p: typeof player.props) => Element)(player.props), video);
    const open = elements(draw()).find((element) => element.props.role === 'dialog')!;
    const geometry = player.props.openingGeometry as ReturnType<typeof getResourceVideoFloatingRect>;
    expect(open.props.initial).toEqual({ opacity: 0, ...geometry.thumbnail });
    expect(open.props.exit).toMatchObject({ ...geometry.thumbnail, opacity: 0 });
    expect(open.props.transition).toMatchObject({ default: { type: 'spring', bounce: 0.32 } });
    driver.present = false;
    const closing = elements(draw()).find((element) => element.props.role === 'dialog')!;
    expect(closing.props.className).toContain('is-closing'); expect(closing.props['aria-hidden']).toBe(true);
    expect(video.pause).toHaveBeenCalledOnce(); expect(video.play).toHaveBeenCalledOnce();
    (player.props.onEnded as () => void)();
    const retained = preview(parent, { ...input, expanded: false });
    const presence = elements(retained).find((element) => element.props.onExitComplete)!;
    expect(presence).toBeDefined(); (presence.props.onExitComplete as () => void)();
    expect(elements(preview(parent, { ...input, expanded: false })).some((element) => element.props.onExitComplete)).toBe(false);
  });
  it('减少动态效果设置关闭缩放，保留淡入淡出', async () => {
    driver.reduced = true;
    const tree = await loaded(harness(), props({ expanded: true }));
    const player = elements(tree).find((element) => typeof element.type === 'function')!;
    const output = elements(render(harness(), () => (player.type as (p: typeof player.props) => Element)(player.props))).find((element) => element.props.role === 'dialog')!;
    expect(output.props.initial).toEqual({ opacity: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    expect(output.props.exit).toMatchObject({ opacity: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 });
  });
  it('播放控件隔离父级定位和拖拽，缩略项仍允许父卡片文件拖拽', () => {
    const scope = harness(); const collapsed = preview(scope); const stop = vi.fn(); const prevent = vi.fn();
    (collapsed.props.onClick as (event: unknown) => void)({ stopPropagation: stop });
    (collapsed.props.onDragStart as (event: unknown) => void)({ stopPropagation: stop, preventDefault: prevent });
    expect(prevent).not.toHaveBeenCalled();
    click(elements(collapsed).find((element) => element.type === 'button')!);
    const expanded = preview(scope, props({ expanded: true }));
    (expanded.props.onDragStart as (event: unknown) => void)({ stopPropagation: stop, preventDefault: prevent });
    expect(prevent).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('列表展开和媒体地址', () => {
  it('同一窗口只展开一项，结束收起，其他窗口互不影响', () => {
    const first = harness(); const second = harness(); const ids = ['a', 'b'];
    const read = (scope: Harness) => render(scope, () => useResourceVideoPreview('project', ids));
    read(first).setExpanded('a'); read(second).setExpanded('a');
    read(first).setExpanded('b'); expect(read(first).expandedId).toBe('b'); expect(read(second).expandedId).toBe('a');
    read(first).setExpanded(null); expect(read(first).expandedId).toBeNull();
  });
  it('切换范围或删除播放项会清理，切回来不会恢复旧播放器', () => {
    const scope = harness(); const read = (key: string, ids = ['a']) => render(scope, () => useResourceVideoPreview(key, ids));
    read('p1').setExpanded('a'); expect(read('p2').expandedId).toBeNull(); expect(read('p1').expandedId).toBeNull();
    read('p1').setExpanded('a'); expect(read('p1', []).expandedId).toBeNull(); expect(read('p1').expandedId).toBeNull();
  });
  it.each([[1920, 1080], [1080, 1920], [600, 600], [3840, 1080], [160, 90]])('悬浮尺寸保持 %s × %s 原比例并限制在小窗口内', (width, height) => {
    const rect = getResourceVideoFloatingRect({ left: 350, top: 500, width: 100 }, { width, height }, { width: 400, height: 600 });
    expect(rect.width / rect.height).toBeCloseTo(width / height);
    expect(rect.left).toBeGreaterThanOrEqual(12); expect(rect.top).toBeGreaterThanOrEqual(12);
    expect(rect.left + rect.width).toBeLessThanOrEqual(388);
    expect(rect.top + rect.height + 34).toBeLessThanOrEqual(588);
    expect(rect.width).toBeLessThanOrEqual(width);
  });
  it('悬浮内容不超过有偏移的父面板，横竖视频都保留比例', () => {
    for (const media of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
      const rect = getResourceVideoFloatingRect({ left: 180, top: 610, width: 100 }, media, { left: 72, top: 65, width: 340, height: 643 });
      expect(rect.width / rect.height).toBeCloseTo(media.width / media.height);
      expect(rect.left).toBeGreaterThanOrEqual(84); expect(rect.left + rect.width).toBeLessThanOrEqual(400);
      expect(rect.top).toBeGreaterThanOrEqual(77); expect(rect.top + rect.height + 34).toBeLessThanOrEqual(696);
    }
  });
  it.each([
    { left: 84, top: 210, width: 100, height: 90, horizontal: 'left', vertical: 'top' },
    { left: 192, top: 340, width: 100, height: 90, horizontal: 'center', vertical: 'center' },
    { left: 300, top: 594, width: 100, height: 90, horizontal: 'right', vertical: 'bottom' },
  ])('从 $horizontal/$vertical 的缩略图展开，反向变换精确回到该矩形', (anchor) => {
    const target = getResourceVideoFloatingRect(anchor, { width: 1920, height: 1080 }, { left: 72, top: 64, width: 340, height: 644 });
    const start = target.thumbnail;
    expect(target.left + start.x).toBe(anchor.left);
    expect(target.top + start.y).toBe(anchor.top);
    expect(target.width * start.scaleX).toBeCloseTo(anchor.width);
    expect((target.height + 34) * start.scaleY).toBeCloseTo(anchor.height);
    if (anchor.horizontal === 'left') expect(target.left).toBe(anchor.left);
    if (anchor.horizontal === 'center') expect(target.left + target.width / 2).toBe(anchor.left + anchor.width / 2);
    if (anchor.horizontal === 'right') expect(target.left + target.width).toBe(anchor.left + anchor.width);
    if (anchor.vertical === 'top') expect(target.top).toBe(anchor.top);
    if (anchor.vertical === 'center') expect(target.top + (target.height + 34) / 2).toBe(anchor.top + anchor.height / 2);
    if (anchor.vertical === 'bottom') expect(target.top + target.height + 34).toBe(anchor.top + anchor.height);
  });
  it('虚拟节点引用不作为文件路径转换，Web 模式继续使用源 URL', async () => {
    expect(await resolveResourceVideoSource('blob:video', 'node://clip.mp4')).toBe('blob:video');
    expect(driver.convert).not.toHaveBeenCalled();
    driver.convert.mockResolvedValueOnce(null);
    expect(await resolveResourceVideoSource('https://media.test/a.mp4', 'G:/clip.mp4')).toBe('https://media.test/a.mp4');
  });
});
