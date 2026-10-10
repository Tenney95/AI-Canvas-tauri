import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Harness {
  states: unknown[]; refs: Array<{ current: unknown }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>; stateIndex: number; refIndex: number; effectIndex: number;
}
const driver = vi.hoisted(() => ({ current: null as Harness | null, unused: null }));
class DomElement extends EventTarget { closest = vi.fn(); }
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.current!; const index = scope.stateIndex++;
    if (!(index in scope.states)) scope.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.states[index], (value: T | ((old: T) => T)) => {
      scope.states[index] = typeof value === 'function' ? (value as (old: T) => T)(scope.states[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => { const scope = driver.current!; return scope.refs[scope.refIndex++] ??= { current: initial }; },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.effectIndex++; const old = scope.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    scope.pending.push(() => { old?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
  useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.effectIndex++; const old = scope.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    scope.pending.push(() => { old?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
  useCallback: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));
import VideoPlayer from '../../src/components/shared/VideoPlayer';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
type Props = ComponentProps<typeof VideoPlayer>;
let scope: Harness; let input: Props; let tree: unknown; let win: EventTarget;
let video: { src: string; paused: boolean; currentTime: number; muted: boolean; volume: number; playbackRate: number;
  buffered: { length: number; start: (index: number) => number; end: (index: number) => number };
  videoWidth: number; videoHeight: number; duration: number; readyState: number; error: null; play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; getAttribute: ReturnType<typeof vi.fn>; addEventListener: (type: string, cb: (event: unknown) => void) => void; removeEventListener: (type: string, cb: (event: unknown) => void) => void; };
let doc: { fullscreenElement: unknown; exitFullscreen: ReturnType<typeof vi.fn> };
let stage: { requestFullscreen: ReturnType<typeof vi.fn>; querySelector: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn> };
let progress: { style: { setProperty: ReturnType<typeof vi.fn> }; value: string;
  classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> } };
let frames: Map<number, FrameRequestCallback>; let nextFrame: number; let videoListeners: Map<string, Set<(event: unknown) => void>>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean): Element { const found = elements(tree).find(predicate); expect(found).toBeDefined(); return found!; }
function control(label: string) { return find((el) => el.props['aria-label'] === label || el.props.children === label
  || el.type === 'button' && Array.isArray(el.props.children) && el.props.children.includes(label)); }
function click(element: Element) { (element.props.onClick as () => void)(); }
function render() {
  driver.current = scope; scope.stateIndex = scope.refIndex = scope.effectIndex = 0; tree = VideoPlayer(input);
  elements(tree).forEach((el) => {
    if (!el.props.ref) return;
    const node = el.type === 'video' ? video : el.type === 'input' || el.props.className === 'ui-video-player__progress' ? progress : stage;
    if (typeof el.props.ref === 'function') (el.props.ref as (node: unknown) => void)(node);
    else el.props.ref.current = node;
  });
  scope.pending.splice(0).forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function event(type: string) { (find((el) => el.type === 'video').props[type] as (event: unknown) => void)({ currentTarget: video }); render(); }
function key() { const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }); win.dispatchEvent(event); return event; }
function native(type: string, extra: Record<string, unknown> = {}) { videoListeners.get(type)?.forEach((cb) => cb({ currentTarget: video, ...extra })); }
beforeEach(() => {
  scope = { states: [], refs: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, effectIndex: 0 };
  videoListeners = new Map();
  input = { src: 'https://videos.test/a.mp4?preview=1', name: '视频.mp4', autoPlay: true,
    unavailable: true, onEscape: vi.fn(), onError: vi.fn(), onEnded: vi.fn(), onMetadata: vi.fn() };
  win = new class extends EventTarget {
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) { super.addEventListener(type, callback); }
    override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) { super.removeEventListener(type, callback); }
  }();
  doc = { fullscreenElement: null, exitFullscreen: vi.fn().mockResolvedValue(undefined) };
  stage = { requestFullscreen: vi.fn().mockResolvedValue(undefined), querySelector: vi.fn(() => ({ focus: vi.fn() })), contains: vi.fn(() => false) };
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc); vi.stubGlobal('Element', DomElement);
  progress = { style: { setProperty: vi.fn() }, value: '', classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } }; frames = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
  video = { src: '', paused: true, currentTime: 0, muted: false, volume: 1, playbackRate: 1, videoWidth: 1920, videoHeight: 1080, duration: 5, readyState: 1, error: null,
    buffered: { length: 1, start: () => 0, end: () => 4 },
    play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), load: vi.fn(), getAttribute: vi.fn(() => video.src),
    removeAttribute: vi.fn(() => { video.src = ''; }),
    addEventListener: (type: string, cb: (event: unknown) => void) => { if (!videoListeners.has(type)) videoListeners.set(type, new Set()); videoListeners.get(type)!.add(cb); },
    removeEventListener: (type: string, cb: (event: unknown) => void) => { videoListeners.get(type)?.delete(cb); } };
});
afterEach(() => { scope.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('UI Kit VideoPlayer', () => {
  it('播放时逐帧同步真实进度，暂停、结束、换源及卸载取消刷新', async () => {
    const frame = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0); };
    render(); await settle(); event('onLoadedMetadata'); expect(frames.size).toBe(0);
    video.readyState = 4; video.paused = false; event('onPlay'); native('playing'); expect(frames.size).toBe(1);
    video.currentTime = 0.016; frame();
    expect(progress.style.setProperty).toHaveBeenLastCalledWith('--video-played', '0.32%'); expect(progress.value).toBe('0.016');
    video.playbackRate = 2; video.currentTime = 0.048; frame();
    expect(Number.parseFloat(progress.style.setProperty.mock.lastCall![1])).toBeCloseTo(0.96); expect(frames.size).toBe(1);
    video.paused = true; event('onPause'); expect(frames.size).toBe(0);
    video.currentTime = 3; event('onSeeked'); native('seeked');
    expect(progress.style.setProperty).toHaveBeenLastCalledWith('--video-played', '60%');
    video.paused = false; event('onPlay'); video.currentTime = 5; event('onEnded'); native('ended'); expect(frames.size).toBe(0);
    expect(progress.style.setProperty).toHaveBeenLastCalledWith('--video-played', '100%');
    event('onPlay'); const previous = [...frames.keys()];
    input = { ...input, src: 'https://videos.test/b.mp4' }; render();
    expect(previous.every((id) => !frames.has(id))).toBe(true);
    scope.effects.forEach((effect) => effect.cleanup?.()); scope.effects = []; expect(frames.size).toBe(0);
  });
  it('StrictMode 清理重放恢复源和播放，关闭后 Esc 监听也被移除', async () => {
    render(); await settle(); scope.effects.forEach((effect) => effect.cleanup?.()); scope.effects = [];
    expect(video.src).toBe(''); render(); expect(video.src).toBe(input.src); expect(video.play).toHaveBeenCalledTimes(2);
    expect(key().defaultPrevented).toBe(true); expect(input.onEscape).toHaveBeenCalledOnce();
    scope.effects.forEach((effect) => effect.cleanup?.()); scope.effects = []; key(); expect(input.onEscape).toHaveBeenCalledOnce();
  });
  it('自动播放受限可重试，播放结束留在全屏，源失败通知上层回退', async () => {
    video.play.mockRejectedValueOnce(new Error('autoplay blocked')); render(); await settle();
    click(control('点击播放')); await settle(); expect(video.play).toHaveBeenCalledTimes(2);
    video.paused = false; event('onPlay'); click(control('暂停视频')); expect(video.pause).toHaveBeenCalled();
    event('onEnded'); expect(input.onEnded).toHaveBeenCalledOnce(); expect(input.onEscape).not.toHaveBeenCalled();
    event('onError'); expect(input.onError).toHaveBeenCalledOnce(); expect(control('视频加载失败，点击重试')).toBeDefined();
  });
  it('底部控件更新进度、速度和静音，原生全屏 Esc 不关闭详情层', async () => {
    render(); await settle(); event('onLoadedMetadata');
    (control('播放进度').props.onChange as (event: unknown) => void)({ currentTarget: { value: '3.25' } }); render();
    expect(video.currentTime).toBe(3.25);
    click(control('播放速度')); render();
    (control('调整播放速度').props.onChange as (event: unknown) => void)({ currentTarget: { value: '1.5' } });
    expect(video.playbackRate).toBe(1.5); event('onRateChange'); expect(control('调整播放速度').props.value).toBe(1.5);
    key(); render(); expect(input.onEscape).not.toHaveBeenCalled();
    click(control('静音视频')); expect(video.muted).toBe(true); event('onVolumeChange'); expect(control('取消静音')).toBeDefined();
    click(control('全屏播放视频')); expect(stage.requestFullscreen).toHaveBeenCalledOnce();
    const outerModal = vi.fn(); win.addEventListener('keydown', outerModal);
    doc.fullscreenElement = stage; expect(key().defaultPrevented).toBe(false); expect(input.onEscape).not.toHaveBeenCalled();
    expect(outerModal).not.toHaveBeenCalled();
    click(control('全屏播放视频')); expect(doc.exitFullscreen).toHaveBeenCalledOnce();
  });
  it('全屏不可用显示状态，源未就绪不创建视频且禁用进度', async () => {
    input = { ...input, src: undefined, unavailable: false }; stage.requestFullscreen.mockRejectedValueOnce(new Error('unsupported'));
    render(); await settle(); expect(elements(tree).some((el) => el.type === 'video')).toBe(false);
    expect(control('加载视频…')).toBeDefined(); expect(control('播放进度').props.disabled).toBe(true);
    expect(elements(tree).some((el) => el.props.className === 'ui-video-player__progress-marker')).toBe(false);
    for (const range of elements(tree).filter((el) => el.type === 'input' && el.props.type === 'range')) { if (String(range.props.className ?? '').includes('ui-slider')) continue; expect(range.props['data-native-range']).toBe(true); }
    click(control('全屏播放视频')); await settle(); expect(control('此窗口暂不支持播放器全屏')).toBeDefined();
  });
  it('媒体就绪后显示位置标记，所有自绘滑杆隔离全局原生滑杆样式', async () => {
    render(); await settle();
    expect(elements(tree).some((el) => el.props.className === 'ui-video-player__progress-marker')).toBe(false);
    event('onLoadedMetadata'); click(control('播放速度')); render();
    expect(elements(tree).some((el) => el.props.className === 'ui-video-player__progress-marker')).toBe(true);
    const ranges = elements(tree).filter((el) => el.type === 'input' && el.props.type === 'range');
    expect(ranges).toHaveLength(3);
    for (const range of ranges) { if (String(range.props.className ?? '').includes('ui-slider')) continue; expect(range.props['data-native-range']).toBe(true); }
    input = { ...input, src: undefined }; render();
    expect(control('播放进度').props.disabled).toBe(true);
    expect(elements(tree).some((el) => el.props.className === 'ui-video-player__progress-marker')).toBe(false);
  });
  it('速度弹层支持细分倍速与滑杆，Esc 只关弹层，外部点击关闭', async () => {
    render(); await settle(); click(control('播放速度')); render();
    expect(control('播放速度').props['aria-expanded']).toBe(true);
    expect(stage.querySelector).toHaveBeenCalledWith('input');
    click(control('0.75 倍速')); expect(video.playbackRate).toBe(0.75); event('onRateChange');
    expect(control('调整播放速度').props.value).toBe(0.75);
    (control('调整播放速度').props.onChange as (event: unknown) => void)({ currentTarget: { value: '1.75' } });
    expect(video.playbackRate).toBe(1.75); event('onRateChange');
    expect(key().defaultPrevented).toBe(true); render();
    expect(input.onEscape).not.toHaveBeenCalled(); expect(control('播放速度').props['aria-expanded']).toBe(false);
    click(control('播放速度')); render(); win.dispatchEvent(new Event('pointerdown')); render();
    expect(control('播放速度').props['aria-expanded']).toBe(false);
  });
  it('时间菜单切换剩余时间并支持键盘导航，居中时间不受左侧控件宽度影响', async () => {
    render(); await settle(); event('onLoadedMetadata'); video.currentTime = 2; event('onTimeUpdate');
    click(control('时间显示格式')); render();
    const menu = control('时间显示格式选项');
    const options = [{ focus: vi.fn() }, { focus: vi.fn() }];
    const preventDefault = vi.fn();
    (menu.props.onKeyDown as (event: unknown) => void)({ key: 'ArrowDown', currentTarget: { querySelectorAll: () => options }, target: options[0], preventDefault, stopPropagation: vi.fn() });
    expect(options[1].focus).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
    click(control('剩余时间 / 总时长')); render();
    expect(control('时间显示格式').props['aria-expanded']).toBe(false);
    const text = find((el) => el.type === 'time').props.children as string[];
    expect(text.join('')).toBe('-0:03 / 0:05');
    expect(input.onEscape).not.toHaveBeenCalled();
  });
  it('音量滑杆解除静音，零音量可恢复，缓冲只显示当前连续区间', async () => {
    render(); await settle(); event('onLoadedMetadata'); video.currentTime = 2; event('onTimeUpdate'); native('loadedmetadata');
    const progressEl = find((el) => el.props.className === 'ui-video-player__progress');
    expect(progressEl.props.style).toMatchObject({ '--video-buffered': '80%' });
    expect(progress.style.setProperty).toHaveBeenLastCalledWith('--video-played', '40%');
    video.buffered = { length: 2, start: (index) => index === 0 ? 0 : 4.5, end: (index) => index === 0 ? 3 : 5 };
    event('onProgress'); expect(find((el) => el.props.className === 'ui-video-player__progress').props.style).toMatchObject({ '--video-buffered': '60%' });
    (control('视频音量').props.onChange as (event: unknown) => void)({ currentTarget: { value: '0' } }); event('onVolumeChange');
    expect(video.muted).toBe(true); click(control('取消静音')); event('onVolumeChange');
    expect(video.volume).toBe(1); expect(video.muted).toBe(false);
    (control('视频音量').props.onChange as (event: unknown) => void)({ currentTarget: { value: '0.35' } }); event('onVolumeChange');
    expect(control('视频音量').props.value).toBe(0.35);
  });
  it('悬停只打开独立静音预览，不跳动主视频，离开移除并释放预览源', async () => {
    render(); await settle(); event('onLoadedMetadata');
    const progress = find((el) => el.props.className === 'ui-video-player__progress');
    (progress.props.onPointerMove as (event: unknown) => void)({ pointerType: 'mouse', clientX: 100, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 200 }) } }); render();
    const child = find((el) => typeof el.type === 'function' && el.props.time !== undefined);
    const mainVideo = video;
    const previewVideo = { ...video, src: '', pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(() => { previewVideo.src = ''; }) };
    const mainScope = scope;
    const previewScope: Harness = { states: [], refs: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, effectIndex: 0 };
    driver.current = previewScope;
    const previewTree = (child.type as (props: { src: string; time: number }) => unknown)(child.props as { src: string; time: number });
    elements(previewTree).forEach((el) => { if (el.props.ref) el.props.ref.current = previewVideo; });
    previewScope.pending.splice(0).forEach((effect) => effect());
    expect(previewVideo.currentTime).toBe(2.6); expect(mainVideo.currentTime).toBe(0);
    expect(find((el) => el.type === 'video').props.muted).toBeUndefined();
    expect(elements(previewTree).find((el) => el.type === 'video')?.props.muted).toBe(true);
    previewScope.effects.forEach((effect) => effect.cleanup?.());
    expect(previewVideo.pause).toHaveBeenCalledOnce(); expect(previewVideo.src).toBe('');
    driver.current = mainScope;
    (progress.props.onPointerLeave as () => void)(); render();
    expect(elements(tree).some((el) => el.props.className === 'ui-video-player__seek-anchor')).toBe(false);
  });
  it('默认不自动播放，元数据回调与错误由调用方接收', async () => {
    input = { ...input, autoPlay: false }; render(); await settle();
    expect(video.play).not.toHaveBeenCalled(); click(control('播放视频')); expect(video.play).toHaveBeenCalledOnce();
    event('onLoadedMetadata'); expect(input.onMetadata).toHaveBeenCalledWith({ width: 1920, height: 1080, duration: 5 });
    event('onError'); expect(input.onError).toHaveBeenCalledOnce();
  });
  it('普通嵌入只处理播放器内菜单，不抢占外部 Esc 或其他播放器全屏', async () => {
    input = { ...input, onEscape: undefined, autoPlay: false }; render(); await settle();
    expect(key().defaultPrevented).toBe(false);
    click(control('播放速度')); render(); expect(key().defaultPrevented).toBe(false);
    stage.contains.mockReturnValue(true); expect(key().defaultPrevented).toBe(true); render();
    expect(control('播放速度').props['aria-expanded']).toBe(false);
    stage.contains.mockReturnValue(false); doc.fullscreenElement = {};
    expect(key().defaultPrevented).toBe(false);
  });
  it('换源释放旧视频并忽略旧播放请求的迟到失败', async () => {
    let reject!: (reason: Error) => void;
    video.play.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })); render();
    input = { ...input, src: 'https://videos.test/b.mp4' }; render();
    expect(video.removeAttribute).toHaveBeenCalledWith('src'); expect(video.src).toBe(input.src);
    reject(new Error('old source blocked')); await settle();
    expect(elements(tree).some((el) => el.props.children === '点击播放')).toBe(false);
  });
});
