/** 引用编辑器的真实入口回归：订阅范围、候选准备与 DOM 同步失效。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactElement } from 'react';
import type { AppState } from '../../src/store/useAppStore';
import type { BaseNodeData, WorkflowDefinition } from '../../src/types';
import { emptyDramaAssetLibrary } from '../../src/types/dramaAssets';

const driver = vi.hoisted(() => ({
  state: null as unknown as AppState, states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  layouts: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, layoutIndex: 0,
}));
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = driver.memoIndex++; const previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) driver.memos[index] = { value: factory(), deps };
    return driver.memos[index].value as T;
  };
  return { ...await vi.importActual<typeof import('react')>('react'),
    forwardRef: (fn: (props: unknown, ref: null) => unknown) => (props: unknown) => fn(props, null),
    // 此 driver 只提交布局效果；浏览器监听、目录 IO 和焦点由既有独立回归与桌面验收覆盖。
    lazy: () => 'lazy-component', useId: () => 'mention-editor', useEffect: () => {}, useImperativeHandle: () => {},
    useMemo: memo, useCallback: <T,>(fn: T, deps: readonly unknown[]) => memo(() => fn, deps),
    useState: <T,>(initial?: T | (() => T)) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (next: T | ((old: T) => T)) => { driver.states[index] = typeof next === 'function' ? (next as (old: T) => T)(driver.states[index] as T) : next; }];
    },
    useRef: <T,>(initial: T) => driver.refs[driver.refIndex++] ??= { current: initial },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.layoutIndex++; const old = driver.layouts[index];
      if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
      driver.pending.push(() => { old?.cleanup?.(); driver.layouts[index] = { deps, cleanup: effect() ?? undefined }; });
    },
  };
});
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.state), { getState: () => driver.state }) }));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('framer-motion', () => ({ motion: { div: 'div' }, AnimatePresence: 'presence' }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>(); return { ...actual, useT: () => actual.t };
});
vi.mock('../../src/hooks/useDialogFocus', () => ({ useDialogFocus: () => {} }));
vi.mock('../../src/hooks/useComfyDomImageSources', () => ({ useComfyDomImageSources: () => {} }));
vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
vi.mock('../../src/hooks/useComfyRefmodMentionOptions', () => ({ useComfyRefmodMentionOptions: () => ({ entries: [], loading: false, error: '', refresh: () => {} }) }));
vi.mock('../../src/components/shared/MentionPicker', () => ({ default: 'mention-picker' }));
vi.mock('../../src/components/nodes/shared/mentionEditorDom', async (original) => {
  const actual = await original<typeof import('../../src/components/nodes/shared/mentionEditorDom')>();
  return { ...actual, getNodeMetaMap: vi.fn(actual.getNodeMetaMap) };
});
vi.mock('../../src/components/nodes/shared/mentionEditorHistory', async (original) => {
  const actual = await original<typeof import('../../src/components/nodes/shared/mentionEditorHistory')>();
  return { ...actual, captureMentionEditorSnapshot: vi.fn(actual.captureMentionEditorSnapshot) };
});
vi.mock('../../src/components/nodes/shared/mentionEditorSources', async (original) => {
  const actual = await original<typeof import('../../src/components/nodes/shared/mentionEditorSources')>();
  return { ...actual, resolveCanvasMentionNodes: vi.fn(actual.resolveCanvasMentionNodes), resolveDramaMentionItems: vi.fn(actual.resolveDramaMentionItems), resolveWorkflowMentionNodes: vi.fn(actual.resolveWorkflowMentionNodes) };
});
import MentionEditor from '../../src/components/nodes/shared/MentionEditor';
import { getNodeMetaMap } from '../../src/components/nodes/shared/mentionEditorDom';
import { captureMentionEditorSnapshot } from '../../src/components/nodes/shared/mentionEditorHistory';
import { resolveCanvasMentionNodes, resolveDramaMentionItems, resolveWorkflowMentionNodes } from '../../src/components/nodes/shared/mentionEditorSources';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
const root = { innerHTML: '', childNodes: [] as unknown[], querySelectorAll: () => [], contains: () => true, focus: () => {},
  classList: { contains: () => false }, ownerDocument: { getSelection: () => null }, replaceChildren: vi.fn() };
let prompt = '';
const onChange = (value: string) => { prompt = value; };
function node(id: string, data: Partial<BaseNodeData> = {}, parentId?: string): AppState['nodes'][number] {
  return { id, type: data.type ?? 'ai-image', parentId, position: { x: 0, y: 0 }, data: { type: 'ai-image', label: id, ...data } };
}
const workflow = (id: string): WorkflowDefinition => ({ id, name: id, category: 'ai-video', fileContent: '', fileName: '', createdAt: 0,
  ioNodes: [{ nodeId: 'input', title: '参考图片', type: 'image' }] });
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
function render(extra: Partial<ComponentProps<typeof MentionEditor>> = {}) {
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.layoutIndex = 0;
  const tree = MentionEditor({ value: prompt, nodeId: 'editor', selectedWorkflowId: 'selected', onChange, ...extra });
  const textbox = elements(tree).find((element) => element.props.role === 'textbox')!;
  textbox.props.ref!.current = root;
  driver.pending.splice(0).forEach((effect) => effect()); return { tree, textbox };
}
function updateNode(id: string, data: Partial<BaseNodeData>) {
  driver.state.nodes = driver.state.nodes.map((item) => item.id === id ? { ...item, data: { ...item.data, ...data } } : item);
}
function openMenu() {
  const { textbox } = render();
  const text = { nodeType: 3, textContent: '@', cloneNode: () => ({ nodeType: 3, textContent: '@' }) };
  root.innerHTML = '@'; root.childNodes = [text];
  const range = { startContainer: text, startOffset: 1, cloneRange: () => ({ startContainer: text, startOffset: 1 }) };
  vi.stubGlobal('window', { ...window, getSelection: () => ({ rangeCount: 1, getRangeAt: () => range }) });
  (textbox.props.onInput as (event: unknown) => void)({ nativeEvent: { inputType: 'insertText' } });
  return render();
}
function picker(tree: unknown) { return elements(tree).find((element) => element.type === 'mention-picker')!.props; }

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.memos = []; driver.layouts = []; driver.pending = []; prompt = '';
  root.innerHTML = ''; root.childNodes = []; root.replaceChildren.mockClear();
  vi.stubGlobal('Node', { TEXT_NODE: 3, ELEMENT_NODE: 1 });
  vi.stubGlobal('document', { body: {}, activeElement: null });
  vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {}, getSelection: () => null });
  driver.state = { currentProjectId: 'project', nodes: [node('editor', { type: 'ai-video' }), node('source', { imageUrl: 'asset://old.png' })], edges: [],
    workflows: [workflow('selected'), workflow('other')], dramaAssets: emptyDramaAssetLibrary(), globalCharacters: [], globalScenes: [], globalProps: [],
    globalDramaAssetsLoading: false, globalDramaAssetsError: '', config: { assetFolders: [] } } as unknown as AppState;
});
afterEach(() => { driver.layouts.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('MentionEditor subscription boundaries', () => {
  it('shares the full display projection and metadata across editors without repeating movement scans', () => {
    const readDisplayId = vi.fn(() => 7);
    Object.defineProperty(driver.state.nodes[1].data, 'displayId', { get: readDisplayId, enumerable: true });
    driver.state.nodes = [...driver.state.nodes, node('editor-2', { type: 'ai-video' })];
    const first = { states: driver.states, refs: driver.refs, memos: driver.memos, layouts: driver.layouts, pending: driver.pending };
    const second: typeof first = { states: [], refs: [], memos: [], layouts: [], pending: [] };
    const renderEditor = (scope: typeof first, nodeId: string) => { Object.assign(driver, scope); return render({ nodeId }); };
    try {
      renderEditor(first, 'editor');
      const firstReads = readDisplayId.mock.calls.length;
      expect(firstReads).toBeGreaterThan(0);
      renderEditor(second, 'editor-2');
      expect(readDisplayId).toHaveBeenCalledTimes(firstReads);
      const metadata = vi.mocked(getNodeMetaMap).mock.results;
      expect(metadata[0].value).toBe(metadata[1].value);
      readDisplayId.mockClear();
      const snapshots = vi.mocked(captureMentionEditorSnapshot).mock.calls.length;
      driver.state.nodes = driver.state.nodes.map((item) => item.id === 'source' ? { ...item, position: { x: 50, y: 100 } } : item);
      renderEditor(first, 'editor');
      const movementReads = readDisplayId.mock.calls.length;
      expect(movementReads).toBeGreaterThan(0);
      renderEditor(second, 'editor-2');
      expect(readDisplayId).toHaveBeenCalledTimes(movementReads);
      expect(getNodeMetaMap).toHaveBeenCalledTimes(2);
      expect(captureMentionEditorSnapshot).toHaveBeenCalledTimes(snapshots);
      updateNode('source', { imageUrl: 'asset://new.png' });
      Object.defineProperty(driver.state.nodes[1].data, 'displayId', { get: readDisplayId, enumerable: true });
      readDisplayId.mockClear(); renderEditor(first, 'editor');
      const mediaReads = readDisplayId.mock.calls.length;
      expect(mediaReads).toBeGreaterThan(0);
      renderEditor(second, 'editor-2');
      expect(readDisplayId).toHaveBeenCalledTimes(mediaReads);
      expect(metadata[2].value).toBe(metadata[3].value);
      expect(metadata[3].value.get('source')?.thumbnailUrl).toBe('asset://new.png');
      expect(resolveCanvasMentionNodes).not.toHaveBeenCalled();
    } finally {
      for (const scope of [first, second]) scope.layouts.forEach((effect) => effect.cleanup?.());
      driver.layouts = [];
    }
  });

  it('does not sync DOM/history or prepare candidates for unrelated movement, edge style or other workflows', () => {
    render();
    const metadataCalls = vi.mocked(getNodeMetaMap).mock.calls.length;
    const snapshots = vi.mocked(captureMentionEditorSnapshot).mock.calls.length;
    expect(metadataCalls).toBe(1); expect(snapshots).toBe(1);
    driver.state.nodes = driver.state.nodes.map((item) => item.id === 'source' ? { ...item, position: { x: 50, y: 100 }, data: { ...item.data, status: 'loading' } } : item);
    driver.state.edges = [{ id: 'e', source: 'source', target: 'editor', style: { opacity: 0.5 } }];
    driver.state.workflows = driver.state.workflows.map((item) => item.id === 'other' ? { ...item, name: 'renamed' } : item);
    render();
    expect(getNodeMetaMap).toHaveBeenCalledTimes(metadataCalls);
    expect(captureMentionEditorSnapshot).toHaveBeenCalledTimes(snapshots);
    expect(resolveCanvasMentionNodes).not.toHaveBeenCalled();
    expect(resolveDramaMentionItems).not.toHaveBeenCalled();
    expect(resolveWorkflowMentionNodes).not.toHaveBeenCalled();
    expect(root.replaceChildren).not.toHaveBeenCalled();
  });

  it('keeps media, director, storyboard, shot labels and asset updates live while deferring DOM work during IME', () => {
    render();
    const fields: Partial<BaseNodeData>[] = [
      { displayId: 42 }, { label: '新名字' }, { imageUrl: 'asset://new.png' }, { type: 'ai-video' },
      { videoUrl: 'asset://clip.mp4' }, { thumbnailUrl: 'asset://poster.png' }, { filePath: 'media/clip.mp4' },
      { audioUrl: 'asset://voice.wav' }, { type: 'ai-director' }, { directorCaptureUrls: ['asset://capture.png'] },
      { type: 'ai-storyboard' }, { storyboardCols: 2 }, { storyboardRows: 1 }, { storyboardOverrides: [null, { url: 'asset://cell.png' }] },
      { type: 'ai-shotlist' }, { shotlistRows: [{ id: 'shot', shotNo: '3', content: '镜头' }] },
    ];
    for (const data of fields) {
      const before = vi.mocked(captureMentionEditorSnapshot).mock.calls.length; updateNode('source', data); render();
      expect(captureMentionEditorSnapshot).toHaveBeenCalledTimes(before + 1);
    }
    expect(vi.mocked(getNodeMetaMap).mock.results.at(-1)?.value.get('source/shot/shot')?.label).toBe('镜3 · 新名字');
    const before = vi.mocked(captureMentionEditorSnapshot).mock.calls.length;
    (render().textbox.props.onCompositionStart as () => void)(); updateNode('source', { imageUrl: 'asset://ime.png' }); render();
    expect(captureMentionEditorSnapshot).toHaveBeenCalledTimes(before);
    (render().textbox.props.onCompositionEnd as () => void)(); render();
    expect(vi.mocked(captureMentionEditorSnapshot).mock.calls.length).toBeGreaterThan(before);
    const afterComposition = vi.mocked(captureMentionEditorSnapshot).mock.calls.length;
    driver.state.dramaAssets = { ...driver.state.dramaAssets, characters: [{
      id: 'hero', key: 'hero', kind: 'character', name: '人物', identity: '', summary: '', visualNotes: '',
      importance: 'main', confirmed: true, source: 'manual', createdAt: 0, updatedAt: 0, imageUrl: 'asset://hero.png',
    }] }; render();
    expect(captureMentionEditorSnapshot).toHaveBeenCalledTimes(afterComposition + 1);
    driver.state.globalCharacters = [{ ...driver.state.dramaAssets.characters[0], imageUrl: 'asset://global.png' }]; render();
    expect(captureMentionEditorSnapshot).toHaveBeenCalledTimes(afterComposition + 2);
  });

  it('prepares full connected/group and project search candidates only while the menu is open', () => {
    driver.state.nodes = [node('editor', { type: 'ai-video' }, 'target-group'), { ...node('target-group'), type: 'group' },
      { ...node('source-group'), type: 'group' }, node('source', { label: '连线素材', imageUrl: 'asset://source.png' }, 'source-group'),
      node('unconnected', { label: '未连线', fileName: '另一张.png' })];
    driver.state.edges = [{ id: 'groups', source: 'source-group', target: 'target-group' }];
    let view = openMenu();
    expect((picker(view.tree).items as Array<{ label: string }>).map((item) => item.label)).toEqual(['连线素材']);
    (picker(view.tree).search as { onExpandedChange: (expanded: boolean) => void }).onExpandedChange(true);
    view = render();
    expect(resolveCanvasMentionNodes).toHaveBeenLastCalledWith('editor', driver.state.nodes, driver.state.edges, 'project');
    expect((picker(view.tree).items as Array<{ label: string }>).some((item) => item.label === '未连线')).toBe(true);
    (view.textbox.props.onKeyDown as (event: unknown) => void)({ key: 'Escape', nativeEvent: {}, target: { closest: () => null }, preventDefault: () => {} }); render();
    const calls = vi.mocked(resolveCanvasMentionNodes).mock.calls.length;
    updateNode('unconnected', { label: '关闭后更名' }); render();
    expect(resolveCanvasMentionNodes).toHaveBeenCalledTimes(calls);
    view = openMenu();
    (picker(view.tree).search as { onExpandedChange: (expanded: boolean) => void }).onExpandedChange(true);
    driver.state.workflows = driver.state.workflows.map((item) => item.id === 'selected'
      ? { ...item, ioNodes: [{ nodeId: 'input', title: '已更新工作流输入', type: 'image' as const }] } : item);
    view = render();
    const items = picker(view.tree).items as Array<{ label: string; onSelect: () => void }>;
    expect(items.some((item) => item.label === '已更新工作流输入')).toBe(true);
    const stale = items.find((item) => item.label === '关闭后更名')!;
    driver.state.currentProjectId = 'other-project';
    expect(() => stale.onSelect()).not.toThrow();
    expect(prompt).toBe('@');
  });
});
