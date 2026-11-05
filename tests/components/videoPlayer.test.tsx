/**
 * videoPlayer — 回归测试：UI Kit VideoPlayer。
 */
const comfySources = vi.hoisted(() => ({ media: vi.fn((source?: string, _onError?: () => void) => source), image: vi.fn((source?: string) => source) }));
vi.mock('../../src/hooks/useComfyMediaSource', () => ({ useComfyMediaSource: comfySources.media }));
vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: comfySources.image }));
vi.mock('../../src/services/comfyMediaSource', () => ({ shouldLoadNativeComfyMedia: (source?: string) => source?.includes('/view?') === true }));
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Harness {
  states: unknown[]; refs: Array<{ current: unknown }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>; stateIndex: number; refIndex: number; effectIndex: number;
}
const driver = vi.hoisted(() => ({ current: null as Harness | null, unused: null }));
class DomElement extends EventTarget { closest = vi.fn(); }
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
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
  useCallback: <T extends (...args: unknown[]) => unknown>(fn: T, deps?: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.refIndex++;
    const old = scope.refs[index]?.current as { fn: T; deps?: readonly unknown[] } | undefined;
    if (old && deps && old.deps?.length === deps.length && deps.every((dep, i) => Object.is(dep, old.deps?.[i]))) return old.fn;
    scope.refs[index] = { current: { fn, deps } };
    return fn;
  },
}));
import VideoPlayer from '../../src/components/shared/VideoPlayer';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
type Props = ComponentProps<typeof VideoPlayer>;
let scope: Harness; let input: Props; let tree: unknown; let win: EventTarget;
let video: { src: string; paused: boolean; currentTime: number; muted: boolean; volume: number; playbackRate: number;
  buffered: { length: number; start: (index: number) => number; end: (index: number) => number };
  videoWidth: number; videoHeight: number; duration: number; readyState: number; error: { code: number } | null; play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; getAttribute: ReturnType<typeof vi.fn>; addEventListener: (type: string, cb: (event: unknown) => void) => void; removeEventListener: (type: string, cb: (event: unknown) => void) => void; };
let doc: { fullscreenElement: unknown; exitFullscreen: ReturnType<typeof vi.fn>; querySelector: ReturnType<typeof vi.fn> };
let stage: { requestFullscreen: ReturnType<typeof vi.fn>; querySelector: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn>; closest: ReturnType<typeof vi.fn> };
let progress: { style: { setProperty: ReturnType<typeof vi.fn> }; value: string;
  classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> } };
let frames: Map<number, FrameRequestCallback>; let nextFrame: number; let videoListeners: Map<string, Set<(event: unknown) => void>>;
let mountedVideoElement: Element | undefined;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean): Element { const found = elements(tree).find(predicate); expect(found).toBeDefined(); return found!; }
function control(label: string) { return find((el) => el.props['aria-label'] === label || el.props.children === label
  || el.type === 'button' && Array.isArray(el.props.children) && el.props.children.includes(label)); }
function click(element: Element) { (element.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() }); }
function render() {
  driver.current = scope; scope.stateIndex = scope.refIndex = scope.effectIndex = 0; tree = VideoPlayer(input);
  const nextVideoElement = elements(tree).find((el) => el.type === 'video');
  if (!nextVideoElement && mountedVideoElement?.props.ref) {
    if (typeof mountedVideoElement.props.ref === 'function') (mountedVideoElement.props.ref as (node: unknown) => void)(null);
    else mountedVideoElement.props.ref.current = null;
  }
  mountedVideoElement = nextVideoElement;
  elements(tree).forEach((el) => {
    if (!el.props.ref) return;
    if (el.type === 'video') video.src = String(el.props.src ?? '');
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
  comfySources.media.mockReset().mockImplementation((source?: string) => source);
  comfySources.image.mockReset().mockImplementation((source?: string) => source);
  scope = { states: [], refs: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, effectIndex: 0 };
  mountedVideoElement = undefined;
  videoListeners = new Map();
  input = { src: 'https://videos.test/a.mp4?preview=1', name: '视频.mp4', autoPlay: true,
    unavailable: true, onEscape: vi.fn(), onError: vi.fn(), onEnded: vi.fn(), onMetadata: vi.fn() };
  win = new class extends EventTarget {
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) { super.addEventListener(type, callback); }
    override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) { super.removeEventListener(type, callback); }
  }();
  doc = { fullscreenElement: null, exitFullscreen: vi.fn().mockResolvedValue(undefined), querySelector: vi.fn().mockReturnValue(null) };
  stage = { requestFullscreen: vi.fn().mockResolvedValue(undefined), querySelector: vi.fn(() => ({ focus: vi.fn() })), contains: vi.fn(() => false), closest: vi.fn().mockReturnValue(null) };
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
  it('未激活卡片不持有媒体来源，首次点击可等待原生源就绪后播放并在收起时释放', () => {
    const original = 'http://127.0.0.1:8188/view?filename=deferred.mp4';
    const onRequestPlayback = vi.fn(() => { input = { ...input, active: true }; render(); });
    let ready = false;
    comfySources.media.mockImplementation((source?: string) => source && ready ? 'http://comfy-media.localhost/opaque-video' : undefined);
    input = { ...input, src: original, compact: true, active: false, autoPlay: false, unavailable: false, onRequestPlayback };
    render();
    expect(comfySources.media).toHaveBeenLastCalledWith(undefined, expect.any(Function));
    expect(control('播放视频').props.disabled).toBe(false);
    click(control('播放视频'));
    expect(onRequestPlayback).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(comfySources.media).toHaveBeenLastCalledWith(original, expect.any(Function));
    expect(video.play).not.toHaveBeenCalled();
    ready = true; render();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.src).toBe('http://comfy-media.localhost/opaque-video');
    input = { ...input, active: false }; render();
    expect(comfySources.media).toHaveBeenLastCalledWith(undefined, expect.any(Function));
    expect(video.src).toBe('');
  });

  it.each([
    ['NotSupportedError', undefined, '视频格式或编码不兼容'],
    ['Error', 2, '视频读取失败，请检查网络或文件'],
    ['Error', 3, '视频解码失败：编码不兼容或文件损坏'],
    ['Error', 4, '视频格式或编码不兼容'],
    ['Error', undefined, '视频加载失败，点击重试'],
    ['AbortError', 3, '视频解码失败：编码不兼容或文件损坏'],
  ] as const)('首次同步激活的 %s / %s 拒绝直接显示原因并通知宿主', async (name, code, message) => {
    const onRequestPlayback = vi.fn(() => { input = { ...input, active: true }; render(); });
    input = { ...input, compact: true, active: false, autoPlay: false, unavailable: false, onRequestPlayback };
    video.play.mockImplementationOnce(() => {
      video.error = code === undefined ? null : { code };
      return Promise.reject(Object.assign(new Error('private source detail'), { name }));
    });
    render();
    expect(elements(tree).some((el) => el.type === 'video')).toBe(false);
    click(control('点击播放'));
    expect(onRequestPlayback).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.src).toBe(input.src);
    await settle();
    expect(control(`${message}，重试播放`).type).toBe('button');
    expect(input.onError).toHaveBeenCalledOnce();
    expect(elements(tree).some((el) => String(el.props.children).includes('private source detail'))).toBe(false);
  });

  it('原生源在同步挂载时已就绪也只播放一次', () => {
    const original = 'http://127.0.0.1:8188/view?filename=ready.mp4';
    const nativeSource = 'http://comfy-media.localhost/ready-video';
    comfySources.media.mockImplementation((source?: string) => source === original ? nativeSource : source);
    input = { ...input, src: original, active: false, autoPlay: false, unavailable: false,
      onRequestPlayback: () => { input = { ...input, active: true }; render(); } };
    render(); click(control('点击播放'));
    expect(video.src).toBe(nativeSource);
    expect(video.play).toHaveBeenCalledOnce();
    render(); expect(video.play).toHaveBeenCalledOnce();
  });

  it('首次同步激活的权限限制保留手动重试，不通知媒体失败', async () => {
    input = { ...input, active: false, autoPlay: false, unavailable: false,
      onRequestPlayback: () => { input = { ...input, active: true }; render(); } };
    video.play.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    render(); click(control('点击播放')); await settle();
    expect(input.onError).not.toHaveBeenCalled();
    const retry = control('点击播放');
    expect(retry.type).toBe('button');
    click(retry); await settle(); event('onPlay');
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(elements(tree).some((el) => el.props['aria-label'] === '点击播放')).toBe(false);
  });

  it('暂停或重新加载中断同一来源的播放请求时不提示媒体失败', async () => {
    let reject!: (reason: Error) => void;
    input = { ...input, autoPlay: false };
    video.play.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    render(); click(control('播放视频'));
    video.paused = true; event('onPause');
    reject(Object.assign(new Error('normal interruption'), { name: 'AbortError' })); await settle();
    expect(input.onError).not.toHaveBeenCalled();
    expect(elements(tree).some((el) => el.props['aria-label'] === '点击播放'
      || el.props.children === '视频加载失败，点击重试')).toBe(false);
  });

  it('无海报的中心播放按钮隔离画布事件，图片海报仍不接管单击', () => {
    const onRequestPlayback = vi.fn();
    input = { ...input, active: false, autoPlay: false, unavailable: false, onRequestPlayback };
    render();
    const button = control('点击播放');
    expect(button.type).toBe('button');
    expect(button.props.className).toContain('ui-btn');
    expect(button.props.className).toContain('nodrag nopan');
    const event = { stopPropagation: vi.fn() };
    (button.props.onPointerDown as (event: unknown) => void)(event);
    (button.props.onDoubleClick as (event: unknown) => void)(event);
    expect(onRequestPlayback).not.toHaveBeenCalled();
    (button.props.onClick as (event: unknown) => void)(event);
    expect(event.stopPropagation).toHaveBeenCalledTimes(3);
    expect(onRequestPlayback).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    input = { ...input, poster: 'https://videos.test/cover.jpg' }; render();
    expect(find((el) => el.type === 'img').props.onClick).toBeUndefined();
  });

  it('有来源但宿主标记不可用时保留不可用状态，不显示中心播放入口', () => {
    input = { ...input, active: false, autoPlay: false, unavailable: true, onRequestPlayback: vi.fn() };
    render();
    expect(control('视频不可用').props.role).toBe('status');
    expect(elements(tree).some((el) => el.props['aria-label'] === '点击播放')).toBe(false);
    expect(input.onRequestPlayback).not.toHaveBeenCalled();
  });

  it('更换错误回调不释放当前来源，拒绝播放时通知最新宿主', async () => {
    const previousError = input.onError;
    const onError = vi.fn();
    input = { ...input, autoPlay: false }; render();
    input = { ...input, onError }; render();
    expect(video.removeAttribute).not.toHaveBeenCalled();
    video.play.mockRejectedValueOnce(Object.assign(new Error('unsupported'), { name: 'NotSupportedError' }));
    click(control('播放视频')); await settle();
    expect(previousError).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([false, true])('原生来源=%s 的媒体错误后收起视频仍显示错误按钮，不让海报遮住重试', async (nativeSource) => {
    const original = nativeSource ? 'http://127.0.0.1:8188/view?filename=failed.mp4' : input.src;
    comfySources.media.mockImplementation((source?: string) => nativeSource && source === original
      ? 'http://comfy-media.localhost/failed-video' : source);
    input = { ...input, src: original, autoPlay: false, unavailable: false, poster: 'https://videos.test/cover.jpg',
      onRequestPlayback: () => { input = { ...input, active: true }; render(); } };
    render(); video.error = { code: 3 }; event('onError');
    input = { ...input, active: false, unavailable: true }; render();
    expect(elements(tree).some((el) => el.type === 'video' || el.type === 'img')).toBe(false);
    const retry = control('视频解码失败：编码不兼容或文件损坏，重试播放');
    expect(retry.type).toBe('button');
    video.error = null; click(retry); await settle(); event('onPlay');
    expect(video.play).toHaveBeenCalledOnce();
    expect(elements(tree).some((el) => el.props.children === '视频解码失败：编码不兼容或文件损坏')).toBe(false);
  });

  it('Comfy 旧产物只把原生播放源与安全海报交给媒体元素及重试', () => {
    const original = 'http://127.0.0.1:8188/view?filename=old.mp4&type=output';
    const nativeSource = 'http://comfy-media.localhost/opaque-video';
    comfySources.media.mockImplementation((source?: string) => source === original ? nativeSource : source);
    comfySources.image.mockReturnValue('blob:safe-poster');
    input = { ...input, src: original, poster: 'http://127.0.0.1:8188/view?filename=poster.png' };
    render();
    expect(find((element) => element.type === 'video').props.src).toBe(nativeSource);
    expect(find((element) => element.type === 'video').props.poster).toBe('blob:safe-poster');
    expect(video.src).toBe(nativeSource);
    video.error = { code: 2 };
    click(control('播放视频'));
    expect(video.src).toBe(nativeSource);
    expect(comfySources.media).toHaveBeenCalledWith(original, expect.any(Function));
  });

  it('原生申请失败后的重试先撤销来源再重新申请，就绪后延续本次播放意图', () => {
    const original = 'http://127.0.0.1:8188/view?filename=retry.mp4';
    let ready = false;
    comfySources.media.mockImplementation((source?: string) => source && ready ? 'http://comfy-media.localhost/retry-video' : undefined);
    input = { ...input, src: original, autoPlay: false };
    render();
    comfySources.media.mock.lastCall?.[1]?.();
    render();
    expect(input.onError).toHaveBeenCalledOnce();
    click(control('播放视频')); render();
    expect(comfySources.media).toHaveBeenLastCalledWith(undefined, expect.any(Function));
    const [frameId, callback] = frames.entries().next().value!;
    frames.delete(frameId); callback(0); render();
    expect(comfySources.media).toHaveBeenLastCalledWith(original, expect.any(Function));
    ready = true; render();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.src).toBe('http://comfy-media.localhost/retry-video');
  });

  it('原生来源尚未就绪时不挂载原始 Comfy 请求', () => {
    comfySources.media.mockReturnValue(undefined);
    input = { ...input, src: 'http://127.0.0.1:8188/view?filename=pending.mp4' };
    render();
    expect(elements(tree).some((element) => element.type === 'video')).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.src).toBe('');
  });

  it('紧凑播放器提供 Tab 入口以显露控件，普通播放器不额外占用焦点', () => {
    input = { ...input, compact: true }; render();
    expect(control('视频.mp4 视频播放器').props.tabIndex).toBe(0);
    expect(control('视频.mp4 视频播放器').props.className).toContain('ui-video-player--compact');
    input = { ...input, compact: false }; render();
    expect(control('视频.mp4 视频播放器').props.tabIndex).toBeUndefined();
  });
  it('播放时逐帧同步真实进度，暂停、结束、换源及卸载取消刷新', async () => {
    const frame = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0); };
    render(); await settle(); event('onLoadedMetadata'); expect(frames.size).toBe(0);
    video.readyState = 4; video.paused = false; event('onPlay'); native('playing'); expect(frames.size).toBe(1);
    video.currentTime = 0.016; frame();
    expect(progress.style.setProperty).toHaveBeenLastCalledWith('--video-played', '0.32%'); expect(progress.value).toBe('0.016');
    video.playbackRate = 2; video.currentTime = 0.048; frame();
    expect(Number.parseFloat(progress.style.setProperty.mock.lastCall![1])).toBeCloseTo(0.96); expect(frames.size).toBe(1);
    video.paused = true; event('onPause'); native('pause'); expect(frames.size).toBe(0);
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
    video.play.mockRejectedValueOnce(Object.assign(new Error('autoplay blocked'), { name: 'NotAllowedError' })); render(); await settle();
    click(control('点击播放')); await settle(); expect(video.play).toHaveBeenCalledTimes(2);
    video.paused = false; event('onPlay'); click(control('暂停视频')); expect(video.pause).toHaveBeenCalled();
    event('onEnded'); expect(input.onEnded).toHaveBeenCalledOnce(); expect(input.onEscape).not.toHaveBeenCalled();
    event('onError'); expect(input.onError).toHaveBeenCalledOnce(); expect(control('视频加载失败，点击重试')).toBeDefined();
  });
  it.each([
    [1, '视频加载已中止，点击重试'],
    [2, '视频读取失败，请检查网络或文件'],
    [3, '视频解码失败：编码不兼容或文件损坏'],
    [4, '视频格式或编码不兼容'],
  ] as const)('媒体错误码 %i 显示具体原因并保留重试', async (code, message) => {
    render(); await settle(); video.error = { code }; event('onError');
    const retry = control(`${message}，重试播放`);
    expect(retry.type).toBe('button'); expect(control(message)).toBeDefined();
    expect(input.onError).toHaveBeenCalledOnce();
    if (code === 3 || code === 4) expect(retry.props.title).toContain('H.264');
    video.error = null; click(retry); await settle(); event('onPlay');
    expect(elements(tree).some((el) => el.props.children === message)).toBe(false);
  });
  it.each([true, false])('不支持的视频在自动播放=%s 时直接提示格式或编码不兼容', async (autoPlay) => {
    input = { ...input, autoPlay };
    video.play.mockRejectedValueOnce(Object.assign(new Error('private media url'), { name: 'NotSupportedError' }));
    render(); if (!autoPlay) click(control('播放视频')); await settle();
    expect(control('视频格式或编码不兼容')).toBeDefined();
    expect(elements(tree).some((el) => String(el.props.children).includes('private media url'))).toBe(false);
  });
  it('自动播放权限受限仍提示点击播放，不误报为格式不兼容', async () => {
    video.play.mockRejectedValueOnce(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    render(); await settle(); expect(control('点击播放').type).toBe('button');
    expect(elements(tree).some((el) => el.props.children === '视频格式或编码不兼容')).toBe(false);
  });
  it('换源后不显示上个视频的格式错误', async () => {
    render(); await settle(); video.error = { code: 4 }; event('onError');
    expect(control('视频格式或编码不兼容')).toBeDefined();
    input = { ...input, src: 'https://videos.test/compatible.mp4' }; video.error = null; render();
    expect(elements(tree).some((el) => el.props.children === '视频格式或编码不兼容')).toBe(false);
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
  it('顶层引用预览打开时背景播放器不处理 Esc，预览内播放器仍能关闭自己的菜单', async () => {
    render(); await settle(); click(control('播放速度')); render();
    doc.querySelector.mockReturnValue({});
    expect(key().defaultPrevented).toBe(false); render();
    expect(input.onEscape).not.toHaveBeenCalled();
    expect(control('播放速度').props['aria-expanded']).toBe(true);
    stage.closest.mockReturnValue({});
    expect(key().defaultPrevented).toBe(true); render();
    expect(control('播放速度').props['aria-expanded']).toBe(false);
    expect(input.onEscape).not.toHaveBeenCalled();
  });
  it('换源释放旧视频并忽略旧播放请求的迟到失败', async () => {
    let reject!: (reason: Error) => void;
    video.play.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })); render();
    input = { ...input, src: 'https://videos.test/b.mp4' }; render();
    expect(video.removeAttribute).toHaveBeenCalledWith('src'); expect(video.src).toBe(input.src);
    reject(Object.assign(new Error('old source blocked'), { name: 'NotSupportedError' })); await settle();
    expect(elements(tree).some((el) => el.props['aria-label'] === '点击播放')).toBe(false);
    expect(elements(tree).some((el) => el.props.children === '视频格式或编码不兼容')).toBe(false);
  });
  it('首次激活的旧来源请求迟到失败不污染新来源或通知错误', async () => {
    let reject!: (reason: Error) => void;
    input = { ...input, active: false, autoPlay: false, unavailable: false,
      onRequestPlayback: () => { input = { ...input, active: true }; render(); } };
    video.play.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    render(); click(control('点击播放'));
    input = { ...input, src: 'https://videos.test/new.mp4' }; render();
    reject(Object.assign(new Error('old source failed'), { name: 'NotSupportedError' })); await settle();
    expect(video.src).toBe(input.src);
    expect(input.onError).not.toHaveBeenCalled();
    expect(elements(tree).some((el) => el.props.children === '视频格式或编码不兼容')).toBe(false);
  });
  it('同一来源重新挂载后旧实例的播放拒绝不污染新实例', async () => {
    let reject!: (reason: Error) => void;
    input = { ...input, active: false, autoPlay: false, unavailable: false,
      onRequestPlayback: () => { input = { ...input, active: true }; render(); } };
    const previousVideo = video;
    previousVideo.getAttribute.mockImplementation(() => previousVideo.src);
    previousVideo.removeAttribute.mockImplementation(() => { previousVideo.src = ''; });
    previousVideo.play.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    render(); click(control('点击播放'));
    input = { ...input, active: false }; render();
    video = { ...previousVideo, src: '', error: null, play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(), load: vi.fn(), getAttribute: vi.fn(() => video.src),
      removeAttribute: vi.fn(() => { video.src = ''; }) };
    click(control('点击播放'));
    // 即使旧元素仍留着同一 src，只有当前 ref 指向的实例能更新错误状态。
    previousVideo.src = input.src!;
    reject(Object.assign(new Error('old instance failed'), { name: 'NotSupportedError' })); await settle();
    expect(video.play).toHaveBeenCalledOnce();
    expect(input.onError).not.toHaveBeenCalled();
    expect(elements(tree).some((el) => el.props.children === '视频格式或编码不兼容')).toBe(false);
  });
});
