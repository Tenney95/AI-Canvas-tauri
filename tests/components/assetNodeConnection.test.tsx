import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import type { InstalledPlugin } from '../../src/types/plugin';

const driver = vi.hoisted(() => ({
  store: null as StoreApi<AppState> | null,
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, effectIndex: 0, image: vi.fn(), video: vi.fn(), history: vi.fn(), nextId: 0,
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  memo: <T,>(value: T) => value,
  useMemo: <T,>(factory: () => T) => factory(),
  useState: <T,>(initial: T) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: T) => { driver.states[index] = value; }];
  },
  useRef: <T,>(initial: T) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    driver.pending.push(() => { previous?.cleanup?.(); driver.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
}));
vi.mock('../../src/store/useAppStore', () => ({
  generateId: () => `test-${driver.nextId++}`,
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.store!.getState()), {
    getState: () => driver.store!.getState(),
    subscribe: (listener: (state: AppState) => void) => driver.store!.subscribe(listener),
  }),
}));
vi.mock('../../src/hooks/useViewportMediaSource', () => ({ useViewportMediaSource: (source: string | undefined) => source }));
vi.mock('../../src/components/nodes/shared/image/canvasImagePreviewCache', () => ({ acquireCanvasImagePreview: driver.image }));
vi.mock('../../src/components/nodes/shared/video/canvasVideoPreviewCache', () => ({ acquireCanvasVideoPoster: driver.video }));
vi.mock('react-dom', async () => ({ ...await vi.importActual<typeof import('react-dom')>('react-dom'), createPortal: (value: unknown) => value }));

import { createNodeSlice } from '../../src/store/store.nodes';
import Card from '../../src/components/assets/CanvasNodeCardContent';
import {
  commitAssetNodeConnection, findAssetNodeConnectionTarget, getAssetNodePorts,
  resolveAssetNodeConnection, startAssetNodeConnectionDrag,
} from '../../src/utils/assetNodeConnection';

const origin = { projectId: 'p1', nodeId: 'a', handleId: 'right' };
const target = { nodeId: 'b', handleId: 'left' };
const node = (id: string, data: Partial<BaseNodeData> = {}): AppState['nodes'][number] => ({
  id, position: { x: 0, y: 0 }, type: data.type ?? 'ai-image', data: { type: 'ai-image', label: id, ...data },
});
const props = { nodeId: 'a', data: node('a').data, projectId: 'p1', connectable: true };
let win: EventTarget;
let doc: EventTarget;
let hit: unknown;
const cleanups: Array<() => void> = [];
interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown, type: string): Element[] {
  if (Array.isArray(tree)) return tree.flatMap((item) => elements(item, type));
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const el = tree as Element;
  return [...(el.type === type ? [el] : []), ...elements(el.props.children, type)];
}
function render(data: BaseNodeData = props.data, extra: Partial<typeof props> = {}) {
  driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
  const tree = Card({ ...props, data, ...extra });
  driver.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function canvasHit(id = 'b', handleId?: string, enabled = true) {
  const nodeElement = { dataset: { id }, getBoundingClientRect: () => ({ left: 400, width: 200 }) };
  const handle = handleId ? { dataset: { handleid: handleId }, classList: { contains: () => enabled } } : null;
  return { closest: (selector: string) => selector === '.react-flow__handle' ? handle : nodeElement };
}
function pointer(type: string, extra: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: 7, clientX: 430, clientY: 120, ...extra });
  win.dispatchEvent(event);
  return event;
}
function start() {
  const onMove = vi.fn(); const onEnd = vi.fn();
  const cancel = startAssetNodeConnectionDrag({ origin, pointerId: 7, onMove, onEnd });
  cleanups.push(cancel);
  return { onMove, onEnd, cancel };
}
const plugin = {
  id: 'plugin', enabled: true,
  manifest: { name: 'Test', contributes: { nodes: [{ id: 'custom', inputs: [{ id: 'image', label: '参考图' }], outputs: [{ id: 'result', label: '结果' }] }] } },
} as unknown as InstalledPlugin;

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.image.mockReset().mockResolvedValue(null); driver.video.mockReset().mockResolvedValue(null); driver.history.mockReset();
  driver.store = createStore<AppState>()((set, get, api) => ({
    ...createNodeSlice(set, get, api), currentProjectId: 'p1', installedPlugins: [],
    nodes: [node('a'), node('b')], edges: [], commitToHistory: driver.history,
  } as unknown as AppState));
  win = new EventTarget(); doc = new EventTarget(); hit = canvasHit();
  vi.stubGlobal('window', Object.assign(win, { innerWidth: 1200 }));
  vi.stubGlobal('document', Object.assign(doc, { body: {}, elementFromPoint: () => hit }));
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  driver.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe('侧栏节点真实连线', () => {
  it('标准节点与 Markdown 复用左右端口，笔记无虚构端口，插件保留真实端口 ID', () => {
    expect(getAssetNodePorts(node('a').data, []).map((port) => port.id)).toEqual(['left', 'right']);
    expect(getAssetNodePorts(node('a', { type: 'ai-markdown' }).data, [])).toHaveLength(2);
    expect(getAssetNodePorts(node('a', { type: 'canvas-note' }).data, [])).toHaveLength(0);
    const data = node('a', { type: 'plugin-node', pluginId: 'plugin', pluginNodeId: 'custom' }).data;
    expect(getAssetNodePorts(data, [plugin]).map((port) => port.id)).toEqual(['plugin-in-image', 'plugin-out-result']);
    expect(getAssetNodePorts(data, [{ ...plugin, enabled: false }])).toHaveLength(0);
  });
  it('从输出和输入反向拖拽都归一化为真实输出到输入', () => {
    const state = driver.store!.getState();
    const expected = { source: 'a', sourceHandle: 'right', target: 'b', targetHandle: 'left' };
    expect(resolveAssetNodeConnection(state, origin, target)).toEqual(expected);
    expect(resolveAssetNodeConnection(state, { ...origin, nodeId: 'b', handleId: 'left' }, { nodeId: 'a', handleId: 'right' })).toEqual(expected);
  });
  it('调用真实 Store onConnect，只产生一条边和一次历史快照，并拒绝重复边', () => {
    driver.history.mockImplementation(() => expect(driver.store!.getState().edges).toHaveLength(0));
    expect(commitAssetNodeConnection(origin, target)).toBe(true);
    expect(driver.store!.getState().edges).toEqual([expect.objectContaining({ source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' })]);
    expect(commitAssetNodeConnection(origin, target)).toBe(false);
    expect(driver.history).toHaveBeenCalledTimes(1);
  });
  it('拒绝跨项目、自连接、同方向、缺失节点和未知端口，不产生历史', () => {
    expect(commitAssetNodeConnection({ ...origin, projectId: 'old' }, target)).toBe(false);
    for (const to of [null, { nodeId: 'a', handleId: 'left' }, { nodeId: 'b', handleId: 'right' }, { nodeId: 'missing', handleId: 'left' }, { nodeId: 'b', handleId: 'unknown' }]) {
      expect(commitAssetNodeConnection(origin, to)).toBe(false);
    }
    expect(driver.history).not.toHaveBeenCalled();
  });
  it('插件连接使用当前启用清单，拒绝虚构左右端口和两个输入相连', () => {
    driver.store!.setState({ installedPlugins: [plugin], nodes: [node('a'), node('b', { type: 'plugin-node', pluginId: 'plugin', pluginNodeId: 'custom' })] });
    expect(commitAssetNodeConnection(origin, target)).toBe(false);
    expect(commitAssetNodeConnection({ ...origin, handleId: 'left' }, { nodeId: 'b', handleId: 'plugin-in-image' })).toBe(false);
    expect(commitAssetNodeConnection(origin, { nodeId: 'b', handleId: 'plugin-in-image' })).toBe(true);
    expect(driver.store!.getState().edges[0].targetHandle).toBe('plugin-in-image');
  });
  it('精确命中端口并沿用画布主体左右半区规则，禁用端口不能接收', () => {
    expect(findAssetNodeConnectionTarget(430, 120)).toEqual(target);
    expect(findAssetNodeConnectionTarget(560, 120)).toEqual({ nodeId: 'b', handleId: 'right' });
    hit = canvasHit('b', 'plugin-in-image');
    expect(findAssetNodeConnectionTarget(430, 120)).toEqual({ nodeId: 'b', handleId: 'plugin-in-image' });
    hit = canvasHit('b', 'left', false);
    expect(findAssetNodeConnectionTarget(430, 120)).toBeNull();
  });
  it('移动预览不写边，放开时写入真实边并释放事件监听', () => {
    const session = start(); pointer('pointermove');
    expect(session.onMove).toHaveBeenCalledWith({ x: 430, y: 120, valid: true });
    expect(driver.store!.getState().edges).toHaveLength(0);
    pointer('pointerup'); pointer('pointerup'); pointer('pointermove');
    expect(driver.store!.getState().edges).toHaveLength(1);
    expect(session.onEnd).toHaveBeenCalledTimes(1);
    expect(session.onMove).toHaveBeenCalledTimes(1);
  });
  it.each(['escape', 'blur', 'pointercancel', 'project', 'delete', 'unmount'])('%s 取消拖线，不写入边或历史', (reason) => {
    const session = start();
    if (reason === 'escape') doc.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
    if (reason === 'blur') win.dispatchEvent(new Event('blur'));
    if (reason === 'pointercancel') pointer('pointercancel');
    if (reason === 'project') driver.store!.setState({ currentProjectId: 'p2' });
    if (reason === 'delete') driver.store!.setState({ nodes: [node('b')] });
    if (reason === 'unmount') session.cancel();
    pointer('pointerup');
    expect(session.onEnd).toHaveBeenCalledTimes(1);
    expect(driver.store!.getState().edges).toHaveLength(0);
    expect(driver.history).not.toHaveBeenCalled();
  });
  it('放开时重验目标，忽略其他指针及空白拖放', () => {
    start(); pointer('pointerup', { pointerId: 99 });
    expect(driver.store!.getState().edges).toHaveLength(0);
    hit = null; pointer('pointerup');
    expect(driver.history).not.toHaveBeenCalled();
    start(); pointer('pointermove');
    hit = canvasHit(); driver.store!.setState({ nodes: [node('a')] }); pointer('pointerup');
    expect(driver.history).not.toHaveBeenCalled();
  });
  it('拖拽中插件停用会取消源端口会话，失效目标端口不能写入连接', () => {
    const pluginData = { type: 'plugin-node', pluginId: 'plugin', pluginNodeId: 'custom' } as Partial<BaseNodeData>;
    driver.store!.setState({ installedPlugins: [plugin], nodes: [node('a', pluginData), node('b')] });
    const onEnd = vi.fn();
    cleanups.push(startAssetNodeConnectionDrag({
      origin: { ...origin, handleId: 'plugin-out-result' }, pointerId: 7, onMove: vi.fn(), onEnd,
    }));
    driver.store!.setState({ installedPlugins: [{ ...plugin, enabled: false }] });
    pointer('pointerup');
    expect(onEnd).toHaveBeenCalledTimes(1);
    driver.store!.setState({ installedPlugins: [plugin], nodes: [node('a'), node('b', pluginData)] });
    hit = canvasHit('b', 'plugin-in-image'); start(); pointer('pointermove');
    driver.store!.setState({ installedPlugins: [{ ...plugin, enabled: false }] });
    pointer('pointerup');
    expect(driver.store!.getState().edges).toHaveLength(0);
    expect(driver.history).not.toHaveBeenCalled();
  });
});

describe('节点内容卡片', () => {
  it('直接显示文本内容与真实端口，大弹窗不展示遮挡画布的拖线入口', () => {
    const data = node('a', { type: 'ai-text', output: '<script>内容仅作文本</script>' }).data;
    const tree = render(data);
    expect(elements(tree, 'p')[0].props.children).toBe(data.output);
    expect(elements(tree, 'button')).toHaveLength(2);
    expect(elements(render(data, { connectable: false }), 'button')).toHaveLength(0);
  });
  it('申请共享 512px 图片预览，媒体切换取消旧请求并拒绝迟到结果', async () => {
    let finish!: (value: { src: string; release: () => void }) => void;
    driver.image.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(node('a', { imageUrl: 'old.png' }).data);
    const oldSignal = driver.image.mock.calls[0][2] as AbortSignal;
    const releaseOld = vi.fn(); const releaseNew = vi.fn();
    driver.image.mockResolvedValueOnce({ src: 'blob:new', release: releaseNew });
    const data = node('a', { imageUrl: 'new.png' }).data;
    render(data); await Promise.resolve();
    finish({ src: 'blob:old', release: releaseOld }); await Promise.resolve();
    expect(oldSignal.aborted).toBe(true);
    expect(releaseOld).toHaveBeenCalledTimes(1);
    expect(driver.image).toHaveBeenLastCalledWith('new.png', 512, expect.any(AbortSignal), 'p1');
    expect(elements(render(data), 'img')[0].props.src).toBe('blob:new');
    driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = [];
    expect(releaseNew).toHaveBeenCalledTimes(1);
  });
  it('不需派生缩略图的小图仍显示原图，原图加载失败后显示占位', async () => {
    const data = node('a', { imageUrl: 'small.png' }).data;
    render(data); await Promise.resolve();
    const image = elements(render(data), 'img')[0];
    expect(image.props.src).toBe('small.png');
    expect(image.props.loading).toBe('lazy');
    (image.props.onError as () => void)();
    expect(elements(render(data), 'img')).toHaveLength(0);
  });
  it('视频使用已有封面缓存，提供封面图片时不再申请视频解码', async () => {
    const data = node('a', { type: 'ai-video', videoUrl: 'clip.mp4' }).data;
    driver.video.mockResolvedValue({ src: 'blob:poster', release: vi.fn() });
    render(data); await Promise.resolve();
    expect(elements(render(data), 'img')[0].props.src).toBe('blob:poster');
    expect(elements(render(data), 'video')).toHaveLength(0);
    render({ ...data, thumbnailUrl: 'cover.png' });
    expect(driver.image).toHaveBeenCalledWith('cover.png', 512, expect.any(AbortSignal), 'p1');
    expect(driver.video).toHaveBeenCalledTimes(1);
  });
  it('音频按需播放且不自动预加载，笔记没有虚构端口', () => {
    const tree = render(node('a', { type: 'ai-audio', audioUrl: 'sound.wav' }).data);
    const audio = elements(tree, 'audio')[0];
    expect(audio.props.preload).toBe('none'); expect(audio.props.autoPlay).toBeUndefined();
    expect(elements(render(node('a', { type: 'canvas-note' }).data), 'button')).toHaveLength(0);
  });
});
