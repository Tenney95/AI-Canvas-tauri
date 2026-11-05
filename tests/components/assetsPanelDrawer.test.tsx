/**
 * assetsPanelDrawer — 回归测试：项目创作资产工具条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { AssetFileEntry, AssetFolderEntry } from '../../src/services/fileService';
import type { AssetScanOptions } from '../../src/services/fs/assetLibrary';
import { createUISlice } from '../../src/store/store.ui';
import type { NodeType } from '../../src/types';
import type { DramaAsset, DramaAssetWriteOptions } from '../../src/types/dramaAssets';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  store: null as StoreApi<AppState> | null,
  states: [] as unknown[], setters: [] as Array<(next: unknown) => void>, refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>, stateIndex: 0, refIndex: 0, effectIndex: 1,
  dirty: false, listProject: vi.fn(), getProjectDir: vi.fn(), listGlobal: vi.fn(), listExternal: vi.fn(), drag: vi.fn(),
  portal: vi.fn((children: unknown) => children),
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>, memoIndex: 0,
  reduceMotion: true,
  createFolder: vi.fn(), resolveFolder: vi.fn(), copyFolder: vi.fn(), copyClipboard: vi.fn(), readClipboard: vi.fn(),
  copyText: vi.fn(), deleteFile: vi.fn(), revealFile: vi.fn(), imageDetails: vi.fn(), videoHistory: vi.fn(),
  native: true,
  nodeFile: null as AssetFileEntry | null,
  globalFolders: [] as AssetFolderEntry[],
  markUsed: vi.fn(),
  lastUsedTimes: vi.fn(),
  exportDrama: vi.fn(), importDrama: vi.fn(), exportGlobalDrama: vi.fn(), importGlobalDrama: vi.fn(), uploadDrama: vi.fn(),
  monitorNativeDrag: false, cursor: vi.fn(), origin: vi.fn(), scale: vi.fn(),
  importFiles: vi.fn(), moveFile: vi.fn(),
  nativeDrop: null as null | ((event: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void),
  globalDrop: null as null | ((event: { payload: { paths: string[]; position: { x: number; y: number } } }) => void),
  globalDragEvents: {} as Record<string, (event: { payload: { paths?: string[]; position?: { x: number; y: number } } }) => void>,
  hitFolder: null as string | null,
}));

// 与仓库其他组件交互测试一样，驱动真实组件的状态、effect 和事件，不依赖 DOM 库。
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = driver.memoIndex++;
    const previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      driver.memos[index] = { value: factory(), deps };
    }
    return driver.memos[index].value as T;
  };
  return {
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
  useMemo: memo,
  useDeferredValue: <T,>(value: T) => value,
  useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    driver.setters[index] ??= (next: unknown) => {
      const value = typeof next === 'function' ? (next as (old: T) => T)(driver.states[index] as T) : next;
      if (!Object.is(value, driver.states[index])) driver.dirty = true;
      driver.states[index] = value;
    };
    return [driver.states[index], driver.setters[index]];
  },
  useRef: <T,>(initial: T) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useId: () => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: `asset-selection-${index}` };
    return String(driver.refs[index].current);
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    // render 阶段的状态调整可能重绘；提交最后一次渲染的 effect。
    driver.pending[index] = () => {
      previous?.cleanup?.();
      driver.effects[index] = { deps, cleanup: effect() ?? undefined };
    };
  },
  };
});
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('react-dom', () => ({ createPortal: driver.portal }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.store!.getState()), {
    getState: () => driver.store!.getState(),
    subscribe: (listener: (state: AppState, previous: AppState) => void) => driver.store!.subscribe(listener),
  }),
}));
vi.mock('framer-motion', () => ({
  motion: { div: 'div', button: 'button' }, AnimatePresence: 'presence', MotionConfig: 'motion-config',
  useReducedMotion: () => driver.reduceMotion,
}));
vi.mock('../../src/services/fileService', async () => ({
  listProjectFiles: driver.listProject, listGlobalFiles: driver.listGlobal,
  getProjectDataDir: driver.getProjectDir,
  listGlobalFolderContents: async (options?: AssetScanOptions) => ({ files: await driver.listGlobal(options), folders: driver.globalFolders, truncated: false, rootPath: '/global/file' }),
  createAssetSubfolder: driver.createFolder, resolveAssetFolderDirectory: driver.resolveFolder, copyAssetFolder: driver.copyFolder,
  importAssetFilesToFolder: driver.importFiles,
  listExternalFolderContents: driver.listExternal,
  selectAssetFolderFiles: (await vi.importActual<typeof import('../../src/services/fs/assetLibrary')>('../../src/services/fs/assetLibrary')).selectAssetFolderFiles,
  extractFilesFromNodeData: () => driver.nodeFile,
  addAssetFilesToGlobal: vi.fn(), pickAssetFolder: vi.fn(), saveAssetToPermanent: vi.fn(), deletePermanentFile: driver.deleteFile,
  revealFileInFolder: driver.revealFile, isTauriEnv: () => driver.native,
  uploadSourceFileToProject: driver.uploadDrama,
  CATEGORY_LABELS: { image: '图像', video: '视频', audio: '音频', text: '文本', other: '其他' },
}));
vi.mock('../../src/services/clipboardService', () => ({ copyFile: driver.copyClipboard, copyText: driver.copyText, readClipboardFolders: driver.readClipboard }));
vi.mock('../../src/services/assetImageDetails', () => ({ loadAssetImageDetails: driver.imageDetails }));
vi.mock('../../src/services/assetVideoDetails', () => ({ loadAssetVideoHistory: driver.videoHistory }));
vi.mock('../../src/services/fs/sharedAssetSync', () => ({
  projectAssetSyncService: {
    readProjectFiles: (projectId: string, options?: AssetScanOptions) => driver.listProject(projectId, options),
    projectFileView: async (_projectId: string, files: AssetFileEntry[]) => files,
  },
}));
vi.mock('../../src/services/dramaAssetTransferService', () => ({
  exportProjectDramaAssets: driver.exportDrama, importProjectDramaAssets: driver.importDrama,
  exportGlobalDramaAssets: driver.exportGlobalDrama, importGlobalDramaAssets: driver.importGlobalDrama,
}));
vi.mock('../../src/services/indexedDbService', async () => ({
  imageHistoryReferenceKey: (await vi.importActual<typeof import('../../src/services/indexedDbService')>('../../src/services/indexedDbService')).imageHistoryReferenceKey,
  getAllAssetMeta: async () => [], putAssetMeta: vi.fn(), deleteAssetMeta: vi.fn(),
  getAssetLastUsedTimes: driver.lastUsedTimes,
}));
vi.mock('../../src/store/store.dramaAssets', () => ({ countUnreadDramaAssets: () => 0 }));
vi.mock('../../src/utils/assetDrag', () => ({ startAssetDrag: driver.drag, prepareDragIcon: async () => {} }));
vi.mock('../../src/utils/assetSearchWindow', () => ({ openAssetSearchWindow: vi.fn() }));
vi.mock('../../src/utils/nodeAnimations', () => ({ playNodeExit: vi.fn() }));
vi.mock('../../src/services/pollManager', () => ({ cancelNodePolling: vi.fn() }));
vi.mock('../../src/services/canvasPointerService', () => ({ getCanvasPointerPosition: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  cursorPosition: driver.cursor,
  getCurrentWindow: () => {
    if (!driver.monitorNativeDrag) throw new Error('Web test');
    return { innerPosition: driver.origin, scaleFactor: driver.scale };
  },
}));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({}));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (callback: typeof driver.nativeDrop) => {
  driver.nativeDrop = callback; return () => { if (driver.nativeDrop === callback) driver.nativeDrop = null; };
} }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: (typeof driver.globalDragEvents)[string]) => {
  driver.globalDragEvents[name] = callback;
  if (name === 'tauri://drag-drop') driver.globalDrop = callback;
  return () => {
    if (driver.globalDragEvents[name] === callback) delete driver.globalDragEvents[name];
    if (driver.globalDrop === callback) driver.globalDrop = null;
  };
} }));
vi.mock('../../src/components/shared/AssetThumb', () => ({ default: 'asset-thumb' }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'asset-select' }));
vi.mock('../../src/components/assets/AssetImagePreview', () => ({ default: 'asset-image-preview' }));

import AssetsPanel from '../../src/components/AssetsPanel';
import DramaAssetsPanel, { DramaAssetCard } from '../../src/components/DramaAssetsPanel';
import GlobalCreativeAssetsPanel from '../../src/components/assets/GlobalCreativeAssetsPanel';
import { setLocale } from '../../src/i18n';
import Tabs, { type TabsProps } from '../../src/components/shared/Tabs';
import AssetFolderNavigation, { type AssetFolderNavigationProps } from '../../src/components/assets/AssetFolderNavigation';
import AssetFileContextMenu, { type AssetFileContextMenuProps } from '../../src/components/assets/AssetFileContextMenu';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { isExternalDropCaptured, setExternalDropCaptured } from '../../src/utils/dropCapture';

class Target {
  tagName = 'DIV'; isContentEditable = false; canvas = true; control = false; drawer = false;
  closest(selector: string) {
    if (selector === '.react-flow') return this.canvas ? this : null;
    if (selector === '.assets-panel--drawer') return this.drawer ? this : null;
    return this.control ? this : null;
  }
}
let doc: EventTarget & { body: Target; documentElement: Target; querySelector: (selector: string) => Target | null };
let win: EventTarget;
let blockingModal: boolean;
let tree: unknown;

function all(root: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((item) => all(item, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [...(predicate(element) ? [element] : []), ...all(element.props.children, predicate)];
}
function visibleText(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(visibleText).join('');
  if (!root || typeof root !== 'object' || !('props' in root)) return '';
  return visibleText((root as Element).props.children);
}
function find(predicate: (element: Element) => boolean): Element {
  const result = all(tree, predicate)[0];
  if (!result) throw new Error('Missing element');
  return result;
}
function button(label: string) { return find((el) => el.props['aria-label'] === label); }
function click(element: Element) { (element.props.onClick as () => void)(); }
function renderDramaCards(root: unknown): unknown {
  if (Array.isArray(root)) return root.map(renderDramaCards);
  if (!root || typeof root !== 'object' || !('props' in root)) return root;
  const element = root as Element;
  if (element.type === DramaAssetCard) return renderDramaCards(DramaAssetCard(element.props as unknown as Parameters<typeof DramaAssetCard>[0]));
  return { ...element, props: { ...element.props, children: renderDramaCards(element.props.children) } };
}
// 展开真实 Tabs 子组件，沿用同一套 hook 驱动，保留业务级交互回归。
function renderTabs(root: unknown): unknown {
  if (Array.isArray(root)) return root.map(renderTabs);
  if (!root || typeof root !== 'object' || !('props' in root)) return root;
  const element = root as Element;
  if (element.type === Tabs) return Tabs(element.props as unknown as TabsProps);
  if (element.type === AssetFolderNavigation) return renderTabs(AssetFolderNavigation(element.props as unknown as AssetFolderNavigationProps));
  return { ...element, props: { ...element.props, children: renderTabs(element.props.children) } };
}
function render() {
  for (let pass = 0; pass < 5; pass++) {
    driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 1; driver.memoIndex = 0; driver.dirty = false;
    tree = renderTabs(AssetsPanel());
    if (!driver.dirty) break;
  }
  const pending = driver.pending;
  driver.pending = [];
  pending.forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function key(keyName = 'Tab', target = doc.body, options: Record<string, unknown> = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  Object.assign(event, { key: keyName, repeat: false, isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...options });
  doc.dispatchEvent(event);
  return event;
}
function file(name: string, tags: string[] = []): AssetFileEntry {
  return { name, path: `assets/${name}.png`, category: 'image', size: 123, tags };
}
function cards() { return all(tree, (element) => !!element.props.file); }
function fileMenu() { return find((element) => element.type === AssetFileContextMenu).props as unknown as AssetFileContextMenuProps; }
function openFileMenu(index = 0) {
  const focus = vi.fn();
  (cards()[index].props.onContextMenu as (event: unknown) => void)({
    target: { closest: () => null }, currentTarget: { focus }, clientX: 120, clientY: 180,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  });
  render(); expect(focus).toHaveBeenCalledOnce(); return fileMenu();
}
function canvasNode(id: string, type: NodeType, label = id): AppState['nodes'][number] {
  return { id, type, position: { x: 0, y: 0 }, data: { type, label } };
}
function nodeRows() { return all(tree, (element) => typeof element.props['data-node-id'] === 'string'); }
function nodeListTab() { return find((element) => element.props.role === 'tab' && element.props['data-tab-value'] === 'nodes'); }
function openNodeList() {
  click(nodeListTab()); render();
}

beforeEach(() => {
  setExternalDropCaptured(false);
  driver.states = []; driver.setters = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.memos = []; driver.memoIndex = 0;
  driver.reduceMotion = true;
  driver.globalFolders = [];
  driver.native = true; driver.nodeFile = null;
  driver.copyText.mockReset().mockResolvedValue(true);
  driver.deleteFile.mockReset().mockResolvedValue(undefined);
  driver.revealFile.mockReset().mockResolvedValue(undefined);
  driver.imageDetails.mockReset().mockResolvedValue({ record: null, history: { prompt: '历史提示词' } });
  driver.videoHistory.mockReset().mockResolvedValue({ prompt: '视频提示词' });
  driver.createFolder.mockReset().mockResolvedValue('/global/file/新建文件夹');
  driver.resolveFolder.mockReset().mockResolvedValue('/global/file');
  driver.copyFolder.mockReset().mockResolvedValue('/global/file/素材');
  driver.copyClipboard.mockReset().mockResolvedValue(true);
  driver.readClipboard.mockReset().mockResolvedValue(['/library/素材']);
  driver.importFiles.mockReset().mockResolvedValue(2);
  driver.moveFile.mockReset().mockResolvedValue({ path: '/library/人物/图.png', moved: true });
  driver.nativeDrop = null; driver.globalDrop = null; driver.globalDragEvents = {}; driver.hitFolder = null;
  blockingModal = false;
  doc = Object.assign(new EventTarget(), {
    body: new Target(), documentElement: new Target(),
    querySelector: (selector: string) => selector === '.react-flow' || blockingModal ? doc.body : null,
    elementFromPoint: () => driver.hitFolder ? { closest: () => ({ getAttribute: () => driver.hitFolder }) } : null,
  });
  win = new EventTarget();
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  setLocale('zh-CN');
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  driver.listProject.mockReset().mockResolvedValue([file('森林', ['夜景']), file('人物')]);
  driver.getProjectDir.mockReset().mockImplementation(async (id: string) => `/${id}`);
  driver.listGlobal.mockReset().mockResolvedValue([{ ...file('全局参考'), source: 'global' }]);
  driver.listExternal.mockReset().mockResolvedValue({ files: [], folders: [], truncated: false });
  driver.portal.mockClear();
  driver.markUsed.mockReset().mockResolvedValue(true);
  driver.lastUsedTimes.mockReset().mockResolvedValue(new Map());
  driver.exportDrama.mockReset().mockResolvedValue(null);
  driver.importDrama.mockReset().mockResolvedValue(null);
  driver.exportGlobalDrama.mockReset().mockResolvedValue(null);
  driver.importGlobalDrama.mockReset().mockResolvedValue(null);
  driver.uploadDrama.mockReset().mockResolvedValue(null);
  driver.drag.mockReset(); driver.monitorNativeDrag = false;
  driver.cursor.mockReset().mockResolvedValue({ x: 1400, y: 800 });
  driver.origin.mockReset().mockResolvedValue({ x: 1000, y: 500 });
  driver.scale.mockReset().mockResolvedValue(2);
  driver.store = createStore<AppState>()((set, get, api) => ({
    ...createUISlice(set, get, api), currentProjectId: 'project-1', nodes: [],
    projects: [{ id: 'project-1', name: '项目一' }], config: { assetWaterfallColumns: 6 },
    dramaAssets: { characters: [], scenes: [], props: [], lastViewedAt: 1 },
    setDramaAssetsPanelOpen: (open: boolean) => set({ dramaAssetsPanelOpen: open }),
    loadGlobalDramaAssets: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn(), saveConfig: vi.fn(), markDramaAssetsViewed: vi.fn(),
    markAssetUsed: driver.markUsed,
    moveGlobalAssetToFolder: driver.moveFile,
  } as unknown as AppState));
  driver.effectIndex = 0;
  useKeyboardShortcuts();
  driver.pending.forEach((effect) => effect());
  driver.pending = [];
});
afterEach(() => {
  driver.effects.forEach((effect) => effect?.cleanup?.());
  setLocale('zh-CN');
  setExternalDropCaptured(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('项目创作资产工具条', () => {
  function renderDrama() {
    for (let pass = 0; pass < 5; pass++) {
      driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 1; driver.memoIndex = 0; driver.dirty = false;
      tree = renderDramaCards(DramaAssetsPanel({ compact: true }));
      if (!driver.dirty) break;
    }
    const pending = driver.pending; driver.pending = [];
    pending.forEach((effect) => effect());
  }
  async function settleDrama() { await new Promise<void>((resolve) => setImmediate(resolve)); renderDrama(); }
  function open() {
    const base = { key: 'asset', summary: '', visualNotes: '', importance: 'main', confirmed: true,
      createdAt: 1, updatedAt: 1, source: 'manual' } as const;
    driver.store!.setState({
      dramaAssets: { version: 2, characters: [{ ...base, id: 'hero', name: '人物甲', kind: 'character', identity: '' }],
        scenes: [{ ...base, id: 'room', name: '场景甲', kind: 'scene' }], props: [{ ...base, id: 'key', name: '道具甲', kind: 'prop' }] },
      showToast: vi.fn(), importDramaAssets: vi.fn().mockResolvedValue(1), saveCurrentProjectSilent: vi.fn().mockResolvedValue('project-1'),
    });
    driver.store!.getState().setAssetsPanelOpen(true, 'page');
    driver.store!.getState().setDramaAssetsPanelOpen(true);
    renderDrama();
  }

  it('使用小尺寸控件，先保存新项目，导出完整创作资产而不受分类和搜索影响', async () => {
    open();
    const upload = find((element) => element.type === 'button' && String(element.props.className).includes('ui-btn--primary'));
    expect(upload.props.className).toContain('ui-btn--sm');
    expect(button('上传资产类型').props.size).toBe('sm');
    const search = find((element) => element.props.placeholder === '搜索名称、简介、别名…');
    expect(search.props.className).toContain('ui-input--sm');
    click(find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children[0] === '人物')); renderDrama();
    (find((element) => element.props.placeholder === '搜索名称、简介、别名…').props.onChange as (event: unknown) => void)({ target: { value: '无匹配' } }); renderDrama();
    driver.store!.setState({ currentProjectId: null });
    vi.mocked(driver.store!.getState().saveCurrentProjectSilent).mockImplementation(async () => {
      driver.store!.setState({ currentProjectId: 'project-1' }); return 'project-1';
    });
    driver.exportDrama.mockResolvedValue({ assetCount: 3, mediaCount: 4 });
    click(button('导出创作资产')); await settleDrama();
    expect(driver.store!.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    expect(driver.exportDrama.mock.calls[0][0]).toMatchObject({ projectId: 'project-1', ownerId: 'project-1', projectName: '项目一',
      assets: [expect.objectContaining({ id: 'hero' }), expect.objectContaining({ id: 'room' }), expect.objectContaining({ id: 'key' })],
    });
    expect(driver.exportDrama.mock.calls[0][0]).not.toHaveProperty('assetName');
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导出 3 项创作资产，包含 4 份媒体', 'success');
  });

  it('单卡按类别和 ID 导出最新记录及绑定媒体，沿用分集资产归属与忙碌保护', async () => {
    open();
    const current = driver.store!.getState();
    const scene = { ...current.dramaAssets.scenes[0], id: 'hero' };
    const nodes = [canvasNode('scene-image', 'source-image', '场景参考图')];
    driver.store!.setState({ currentProjectId: 'episode-1',
      projects: [{ ...current.projects[0], id: 'series-1', name: '整部剧' },
        { ...current.projects[0], id: 'episode-1', name: '第一集', parentId: 'series-1' }],
      dramaAssets: { ...current.dramaAssets, scenes: [scene] }, nodes,
    });
    renderDrama();
    const exportSingle = button('导出资产「场景甲」');
    const exportAll = button('导出创作资产');
    expect(exportSingle.props.className).toContain('ui-btn--sm');
    expect(exportSingle.props.title).toBe('导出当前资产及其绑定媒体');
    const latestScene = { ...scene, name: '场景乙', summary: '最新场景简介', imageNodeId: 'scene-image' };
    driver.store!.setState({ dramaAssets: { ...current.dramaAssets, scenes: [latestScene] } });
    let finishExport!: () => void;
    driver.exportDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 1, mediaCount: 1 }); }));
    click(exportSingle); renderDrama();
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    const input = driver.exportDrama.mock.calls[0][0];
    expect(input).toMatchObject({ projectId: 'episode-1', ownerId: 'series-1', projectName: '整部剧', assetName: '场景乙' });
    expect(input.assets).toEqual([latestScene]);
    expect(input.assets[0]).toBe(latestScene);
    expect(input.nodes).toBe(nodes);
    expect(driver.store!.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
    expect(button('导出资产「场景乙」').props.disabled).toBe(true);
    expect(button('导出创作资产').props.disabled).toBe(true);
    click(exportSingle); click(exportAll);
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    finishExport(); await settleDrama();
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导出 1 项创作资产，包含 1 份媒体', 'success');
    expect(button('导出资产「场景乙」').props.disabled).toBe(false);
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
  });

  it.each(['before-click', 'while-saving'] as const)('%s 删除卡片后，旧导出入口不会导出其他类别的同 ID 资产', async (change) => {
    open();
    const exportSingle = button('导出资产「人物甲」');
    let finishSave!: () => void;
    if (change === 'while-saving') {
      driver.store!.setState({ currentProjectId: null });
      vi.mocked(driver.store!.getState().saveCurrentProjectSilent).mockImplementation(() => new Promise<string>((resolve) => {
        finishSave = () => { driver.store!.setState({ currentProjectId: 'project-1' }); resolve('project-1'); };
      }));
      click(exportSingle);
      expect(driver.store!.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    }
    const library = driver.store!.getState().dramaAssets;
    driver.store!.setState({ dramaAssets: { ...library, characters: [], scenes: [{ ...library.scenes[0], id: 'hero' }] } });
    if (change === 'before-click') click(exportSingle);
    else finishSave();
    await settleDrama();
    expect(driver.exportDrama).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('资产已删除，请重新选择', 'error');
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
    expect(all(tree, (element) => element.props['aria-label'] === '导出资产「人物甲」')).toEqual([]);
  });

  it.each(['project', 'owner'] as const)('%s 改变后撤销单卡导出范围，迟到结果不显示成功', async (change) => {
    open();
    let finishExport!: () => void;
    driver.exportDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 1, mediaCount: 0 }); }));
    click(button('导出资产「人物甲」')); renderDrama();
    const options = driver.exportDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    expect(options.signal?.aborted).toBe(false);
    if (change === 'project') driver.store!.setState({ currentProjectId: 'project-2' });
    else driver.store!.setState({ projects: driver.store!.getState().projects.map((project) => ({ ...project, parentId: 'series-2' })) });
    expect(options.signal?.aborted).toBe(true);
    expect(() => options.assertCurrent?.()).toThrow('资产操作已取消');
    finishExport(); await settleDrama();
    expect(driver.exportDrama).toHaveBeenCalledOnce();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
  });

  it.each([
    ['en-US', 'Export asset “人物甲”', 'Export this asset and its bound media'],
    ['ja-JP', 'アセット「人物甲」を書き出す', 'このアセットと紐付いたメディアを書き出す'],
    ['ko-KR', '에셋 "人物甲" 내보내기', '이 에셋과 연결된 미디어 내보내기'],
  ] as const)('%s 使用翻译后的单卡导出名称和媒体说明', (locale, label, title) => {
    open();
    setLocale(locale); renderDrama();
    expect(button(label).props.title).toBe(title);
    expect(all(tree, (element) => element.props['aria-label'] === '导出资产「人物甲」')).toEqual([]);
    setLocale('zh-CN'); renderDrama();
    expect(button('导出资产「人物甲」').props.title).toBe('导出当前资产及其绑定媒体');
  });

  it('上传和传输共用忙碌保护，导入等待 Store 保存且保存阶段不可取消', async () => {
    open();
    const upload = find((element) => element.type === 'button' && String(element.props.className).includes('ui-btn--primary'));
    const exportButton = button('导出创作资产');
    let finishSave!: () => void;
    vi.mocked(driver.store!.getState().importDramaAssets).mockImplementation(() => new Promise<number>((resolve) => { finishSave = () => resolve(1); }));
    driver.importDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => {
      options.onProgress('正在保存资产');
      const assets = [{ ...driver.store!.getState().dramaAssets.characters[0], id: 'imported' }];
      await input.commit(assets);
      return { assetCount: 1, mediaCount: 2, assets: assets.map(({ kind, id }) => ({ kind, id })) };
    });
    click(button('导入创作资产')); renderDrama();
    click(exportButton); click(upload);
    expect(driver.exportDrama).not.toHaveBeenCalled(); expect(driver.uploadDrama).not.toHaveBeenCalled();
    expect(button('导入创作资产').props.disabled).toBe(true);
    expect(button('导出创作资产').props.disabled).toBe(true);
    expect(button('取消资产操作').props.disabled).toBe(true);
    expect(find((element) => String(element.props.className).includes('drama-assets-grid')).props.inert).toBe(true);
    click(button('取消资产操作'));
    expect(driver.importDrama.mock.calls[0][1].signal.aborted).toBe(false);
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
    finishSave(); await settleDrama();
    expect(driver.store!.getState().importDramaAssets).toHaveBeenCalledWith([expect.objectContaining({ id: 'imported' })], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导入 1 项创作资产，包含 2 份媒体', 'success');
    expect(button('导入创作资产').props.disabled).toBe(false);
  });

  it.each(['project', 'close', 'unmount'] as const)('%s 后中止导入，迟到提交不能写入其他项目或显示成功', async (change) => {
    open();
    let finishRead!: () => void;
    driver.importDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }) => {
      await new Promise<void>((resolve) => { finishRead = resolve; });
      await input.commit([]);
      return { assetCount: 1, mediaCount: 0 };
    });
    click(button('导入创作资产')); renderDrama();
    const options = driver.importDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    if (change === 'project') driver.store!.setState({ currentProjectId: 'project-2' });
    else if (change === 'close') driver.store!.getState().setAssetsPanelOpen(false);
    else driver.effects.slice(1).forEach((effect) => effect?.cleanup?.());
    expect(options.signal?.aborted).toBe(true);
    finishRead(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.store!.getState().importDramaAssets).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
  });
});

describe('全局创作资产工具条', () => {
  function renderGlobal(kind: DramaAsset['kind'] = 'character') {
    for (let pass = 0; pass < 5; pass++) {
      driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 1; driver.memoIndex = 0; driver.dirty = false;
      tree = renderDramaCards(GlobalCreativeAssetsPanel({ kind, compact: true }));
      if (!driver.dirty) break;
    }
    const pending = driver.pending; driver.pending = [];
    pending.forEach((effect) => effect());
  }
  async function settleGlobal(kind: DramaAsset['kind'] = 'character') { await new Promise<void>((resolve) => setImmediate(resolve)); renderGlobal(kind); }
  function open(kind: DramaAsset['kind'] = 'character') {
    const base = { key: 'global', summary: '', visualNotes: '', importance: 'main', confirmed: true,
      createdAt: 1, updatedAt: 1, source: 'manual' } as const;
    driver.store!.setState({ currentProjectId: null,
      globalCharacters: [{ ...base, id: 'character-1', name: '人物甲', kind: 'character', identity: '' },
        { ...base, id: 'character-2', name: '人物乙', kind: 'character', identity: '' }],
      globalScenes: [{ ...base, id: 'scene-1', name: '场景甲', kind: 'scene' }, { ...base, id: 'scene-2', name: '场景乙', kind: 'scene' }],
      globalProps: [{ ...base, id: 'prop-1', name: '道具甲', kind: 'prop' }, { ...base, id: 'prop-2', name: '道具乙', kind: 'prop' }],
      globalDramaAssetsLoading: false, globalDramaAssetsError: null,
      showToast: vi.fn(), saveCurrentProjectSilent: vi.fn(), importGlobalDramaAssets: vi.fn().mockResolvedValue(3),
      saveGlobalDramaAsset: vi.fn().mockResolvedValue(true), deleteGlobalDramaAsset: vi.fn().mockResolvedValue(true),
      bindGlobalDramaAssetImage: vi.fn().mockResolvedValue(true),
    });
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent' });
    renderGlobal(kind);
  }
  function mixedAssets(): DramaAsset[] {
    const state = driver.store!.getState();
    return [state.globalCharacters[0], state.globalScenes[0], state.globalProps[0]].map((asset) => ({ ...asset, id: `imported-${asset.kind}` }));
  }

  it.each([
    ['character', '人物'], ['scene', '场景'], ['prop', '道具'],
  ] as const)('没有当前项目也可导出全部全局%s，不受搜索或项目切换影响', async (kind, label) => {
    open(kind);
    const search = button('搜索全局创作资产');
    expect(search.props.className).toContain('ui-input--sm');
    const controls = find((element) => String(element.props.className).includes('ml-auto') && all(element, (child) => child === search).length === 1);
    expect(controls.props.className).toContain('min-w-0');
    expect(controls.props.className).toContain('flex-wrap');
    expect(all(controls, (element) => String(element.props.className).includes('ui-input-group'))[0].props.className).toContain('max-w-full');
    (search.props.onChange as (event: unknown) => void)({ target: { value: '甲' } }); renderGlobal(kind);
    expect(all(tree, (element) => element.props['data-asset-kind'] === kind)).toHaveLength(1);
    let finishExport!: () => void;
    driver.exportGlobalDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 2, mediaCount: 3 }); }));
    click(button(`导出全部全局${label}`)); renderGlobal(kind);
    const [input, options] = driver.exportGlobalDrama.mock.calls[0];
    expect(input).toMatchObject({ libraryName: `全局${label}`, assets: [expect.objectContaining({ kind, name: `${label}甲` }), expect.objectContaining({ kind, name: `${label}乙` })] });
    expect(input).not.toHaveProperty('assetName'); expect(input).not.toHaveProperty('projectId'); expect(input).not.toHaveProperty('ownerId');
    expect(driver.store!.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
    driver.store!.setState({ currentProjectId: 'project-2' });
    expect(options.signal.aborted).toBe(false);
    expect(() => options.assertCurrent()).not.toThrow();
    finishExport(); await settleGlobal(kind);
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导出 2 项全局创作资产，包含 3 份媒体', 'success');
  });

  it('单卡只导出同类别同 ID 的最新全局记录，并与顶部操作互斥', async () => {
    open('scene');
    const exportSingle = button('导出资产「场景甲」');
    const exportAll = button('导出全部全局场景');
    const state = driver.store!.getState();
    const latest = { ...state.globalScenes[0], name: '最新场景', summary: '修改后的简介' };
    driver.store!.setState({ globalScenes: [latest, state.globalScenes[1]],
      globalCharacters: [{ ...state.globalCharacters[0], id: latest.id }] });
    let finishExport!: () => void;
    driver.exportGlobalDrama.mockImplementation(() => new Promise((resolve) => { finishExport = () => resolve({ assetCount: 1, mediaCount: 0 }); }));
    click(exportSingle); renderGlobal('scene');
    expect(driver.exportGlobalDrama).toHaveBeenCalledOnce();
    expect(driver.exportGlobalDrama.mock.calls[0][0]).toEqual({
      libraryName: '全局场景', assetName: '最新场景', assets: [latest],
      allAssets: [{ ...state.globalCharacters[0], id: latest.id }, latest, state.globalScenes[1], ...state.globalProps],
    });
    expect(button('导出资产「最新场景」').props.disabled).toBe(true);
    expect(button('导入全局创作资产').props.disabled).toBe(true);
    click(exportAll); click(exportSingle);
    expect(driver.exportGlobalDrama).toHaveBeenCalledOnce();
    expect(driver.store!.getState().characterLibraryOpen).toBe(false);
    finishExport(); await settleGlobal('scene');
    driver.exportGlobalDrama.mockClear();
    const staleButton = button('导出资产「最新场景」');
    driver.store!.setState({ globalScenes: [] });
    click(staleButton); await settleGlobal('scene');
    expect(driver.exportGlobalDrama).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('资产已删除，请重新选择', 'error');
  });

  it('混合包按自身类别提交全局 Store，导入等待保存且保存阶段不可取消', async () => {
    open('prop');
    const incoming = mixedAssets();
    const exportAll = button('导出全部全局道具');
    let finishSave!: () => void;
    vi.mocked(driver.store!.getState().importGlobalDramaAssets).mockImplementation(() => new Promise<number>((resolve) => { finishSave = () => resolve(3); }));
    driver.importGlobalDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => {
      options.onProgress('正在保存资产');
      await input.commit(incoming);
      return { assetCount: 3, mediaCount: 4, assets: incoming.map(({ kind, id }) => ({ kind, id })) };
    });
    click(button('导入全局创作资产')); renderGlobal('prop');
    expect(driver.store!.getState().importGlobalDramaAssets).toHaveBeenCalledWith(incoming, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(incoming.map((asset) => asset.kind)).toEqual(['character', 'scene', 'prop']);
    expect(find((element) => String(element.props.className).includes('drama-assets-grid')).props.inert).toBe(true);
    expect(button('取消资产操作').props.disabled).toBe(true);
    click(button('取消资产操作')); click(exportAll);
    expect(driver.exportGlobalDrama).not.toHaveBeenCalled();
    const options = driver.importGlobalDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    driver.store!.setState({ currentProjectId: 'project-2' });
    expect(options.signal?.aborted).toBe(false);
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
    finishSave(); await settleGlobal('prop');
    expect(driver.store!.getState().showToast).toHaveBeenCalledWith('已导入 3 项全局创作资产，包含 4 份媒体', 'success');
    expect(find((element) => String(element.props.className).includes('drama-assets-grid')).props.inert).toBeUndefined();
    expect(button('导入全局创作资产').props.disabled).toBe(false);
  });

  it.each(['close', 'kind', 'unmount'] as const)('%s 后中止全局导入，迟到读取不能提交', async (change) => {
    open();
    const incoming = mixedAssets();
    let finishRead!: () => void;
    driver.importGlobalDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }) => {
      await new Promise<void>((resolve) => { finishRead = resolve; });
      await input.commit(incoming);
      return { assetCount: 3, mediaCount: 0 };
    });
    click(button('导入全局创作资产')); renderGlobal();
    const options = driver.importGlobalDrama.mock.calls[0][1] as DramaAssetWriteOptions;
    if (change === 'close') driver.store!.getState().setAssetsPanelOpen(false);
    else if (change === 'kind') renderGlobal('scene');
    else driver.effects.slice(1).forEach((effect) => effect?.cleanup?.());
    expect(options.signal?.aborted).toBe(true);
    finishRead(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(driver.store!.getState().importGlobalDramaAssets).not.toHaveBeenCalled();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
  });

  it('保存已开始后关闭页面仍等待全局保存，不显示迟到成功提示', async () => {
    open();
    let finishSave!: () => void;
    vi.mocked(driver.store!.getState().importGlobalDramaAssets).mockImplementation(() => new Promise<number>((resolve) => { finishSave = () => resolve(1); }));
    const committed = vi.fn();
    driver.importGlobalDrama.mockImplementation(async (input: { commit: (assets: DramaAsset[]) => Promise<void> }, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => {
      options.onProgress('正在保存资产');
      await input.commit([mixedAssets()[0]]);
      committed(); return { assetCount: 1, mediaCount: 0 };
    });
    click(button('导入全局创作资产')); renderGlobal();
    expect(button('取消资产操作').props.disabled).toBe(true);
    driver.store!.getState().setAssetsPanelOpen(false);
    finishSave(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(committed).toHaveBeenCalledOnce();
    expect(driver.store!.getState().importGlobalDramaAssets).toHaveBeenCalledOnce();
    expect(driver.store!.getState().showToast).not.toHaveBeenCalled();
  });
});

describe('资产文件夹原生拖放', () => {
  const target = { kind: 'folder' as const, rootPath: '/library', relativePath: '人物' };
  async function open(mode: 'page' | 'modal' | 'drawer' = 'page') {
    driver.globalFolders = [{ rootPath: '/library', relativePath: '人物', parentRelativePath: null, name: '人物', fileCount: 1, availability: 'online' }];
    driver.store!.setState((state) => ({ config: { ...state.config, assetFolders: ['/library'] } }));
    driver.listGlobal.mockResolvedValue([{ ...file('图'), path: '/library/图.png', source: 'folder', assetId: 'stable' }]);
    driver.store!.getState().setAssetsPanelOpen(true, mode, { tab: 'permanent', folder: { kind: 'all' } });
    render(); await settle(); await settle();
    driver.hitFolder = JSON.stringify(target);
  }
  function emit(type: string, paths?: string[]) {
    driver.nativeDrop?.({ payload: { type, paths, position: { x: 20, y: 80 } } }); render();
  }
  function pointer(type: string, x = 120, y = 180, pointerId = 1) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 });
    win.dispatchEvent(event); render(); return event;
  }
  function press() {
    const card = Object.assign(new EventTarget(), {
      closest: (selector: string) => selector === '[data-resource-video-boundary]' ? {
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 }),
      } : null,
      setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    });
    (cards()[0].props.onPointerDown as (event: unknown) => void)({ target: card, currentTarget: card,
      button: 0, pointerType: 'mouse', pointerId: 1, clientX: 400, clientY: 180, preventDefault: vi.fn() });
    return card;
  }
  it('库内指针拖动直接显示目录虚线和放大，放下只移动一次，不启动原生循环', async () => {
    await open(); const card = press();
    expect(card.setPointerCapture).not.toHaveBeenCalled();
    pointer('pointermove', 398); expect(driver.drag).not.toHaveBeenCalled();
    pointer('pointermove');
    expect(card.setPointerCapture).toHaveBeenCalledWith(1);
    const row = () => find((element) => element.props['data-asset-folder-target'] === JSON.stringify(target));
    expect(row().props.className).toContain('outline-dashed');
    expect(row().props.className).toContain('motion-safe:scale-[1.02]');
    expect(driver.cursor).not.toHaveBeenCalled(); expect(driver.drag).not.toHaveBeenCalled();
    pointer('pointerup'); pointer('pointerup'); await settle();
    expect(row().props.className).not.toContain('outline-dashed');
    expect(driver.moveFile).toHaveBeenCalledTimes(1); expect(driver.importFiles).not.toHaveBeenCalled();
    const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (cards()[0].props.onClickCapture as (event: unknown) => void)(clickEvent);
    expect(clickEvent.preventDefault).toHaveBeenCalledOnce();
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });
  it('移开目录清除反馈，取消指针拖拽不移动文件，之后无残留监听', async () => {
    await open(); press(); pointer('pointermove');
    driver.hitFolder = null; pointer('pointermove', 500);
    expect(find((element) => element.props['data-asset-folder-target'] === JSON.stringify(target)).props.className).not.toContain('outline-dashed');
    driver.hitFolder = JSON.stringify(target); pointer('pointermove'); pointer('pointercancel');
    pointer('pointerup'); expect(driver.moveFile).not.toHaveBeenCalled(); expect(driver.drag).not.toHaveBeenCalled();
  });
  it('Esc、失去焦点或关闭面板都取消库内拖拽且清理捕获', async () => {
    await open();
    for (const end of ['escape', 'blur', 'close']) {
      driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
      render(); await settle();
      const card = press(); pointer('pointermove');
      if (end === 'escape') {
        const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' }); win.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true); expect(driver.store!.getState().assetsPanelOpen).toBe(true);
      } else if (end === 'blur') win.dispatchEvent(new Event('blur'));
      else { driver.store!.getState().setAssetsPanelOpen(false); render(); }
      pointer('pointerup'); expect(card.releasePointerCapture).toHaveBeenCalledWith(1);
    }
    expect(driver.moveFile).not.toHaveBeenCalled(); expect(driver.drag).not.toHaveBeenCalled();
  });
  it.each(['page', 'modal'] as const)('从 %s 拖出边界同步交给系统，库内不提前交接', async (mode) => {
    await open(mode); press(); pointer('pointermove');
    expect(driver.drag).not.toHaveBeenCalled();
    pointer('pointermove', 950);
    expect(driver.drag).toHaveBeenCalledTimes(1);
    expect(driver.store!.getState().assetsPanelOpen).toBe(mode === 'page');
    pointer('pointerup', 950); expect(driver.moveFile).not.toHaveBeenCalled();
  });
  it('库内拖拽保持页面，高亮目录，放下调用移动 Action 且双通道只执行一次', async () => {
    await open();
    const card = cards()[0];
    (card.props.onDragStart as (event: unknown) => void)({ preventDefault: vi.fn() });
    emit('over');
    const highlighted = find((element) => element.props['data-asset-folder-target'] === JSON.stringify(target));
    expect(highlighted.props.className).toContain('outline-dashed');
    expect(highlighted.props.className).toContain('outline-brand');
    expect(highlighted.props.className).toContain('motion-safe:scale-[1.02]');
    expect(highlighted.props.className).toContain('motion-reduce:transition-none');
    emit('drop', ['/library/图.png']);
    driver.globalDrop?.({ payload: { paths: ['/library/图.png'], position: { x: 20, y: 80 } } });
    await settle();
    expect(driver.moveFile).toHaveBeenCalledTimes(1);
    expect(driver.moveFile).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'stable' }), target, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(driver.importFiles).not.toHaveBeenCalled(); expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });
  it('外部多文件复制到目标目录，刷新列表，原生结束不关闭页面', async () => {
    await open(); emit('enter', ['E:/a.png', 'E:/b.mp4']); emit('drop', ['E:/a.png', 'E:/b.mp4']); await settle();
    expect(driver.importFiles).toHaveBeenCalledWith(['E:/a.png', 'E:/b.mp4'], target, ['/library'], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(driver.moveFile).not.toHaveBeenCalled(); expect(driver.listGlobal.mock.calls.length).toBeGreaterThan(1);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });
  it('整页没有弹窗类且未收到悬停事件时，仍通过系统光标定位并高亮目录', async () => {
    await open();
    vi.useFakeTimers(); driver.monitorNativeDrag = true;
    const closest = vi.fn((selector: string) => selector === '[data-resource-video-boundary]' ? {
      getBoundingClientRect: () => ({ left: 0, right: 900, top: 0, bottom: 600, width: 900, height: 600 }),
    } : null);
    (cards()[0].props.onDragStart as (event: unknown) => void)({ preventDefault: vi.fn(), currentTarget: { closest } });
    await vi.advanceTimersByTimeAsync(0); render();
    expect(closest).toHaveBeenCalledWith('[data-resource-video-boundary]');
    expect(driver.cursor).toHaveBeenCalledOnce();
    const row = () => find((element) => element.props['data-asset-folder-target'] === JSON.stringify(target));
    expect(row().props.className).toContain('outline-dashed');
    expect(row().props.className).toContain('motion-safe:scale-[1.02]');
    driver.hitFolder = null;
    await vi.advanceTimersByTimeAsync(50); render();
    expect(row().props.className).not.toContain('outline-dashed');
    (driver.drag.mock.calls[0][1] as () => void)();
    const calls = driver.cursor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(driver.cursor).toHaveBeenCalledTimes(calls);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });
  it('仅窗口通道发送悬停和离开时也更新高亮，关闭后解绑所有阶段', async () => {
    await open();
    driver.globalDragEvents['tauri://drag-over']({ payload: { position: { x: 20, y: 80 } } }); render();
    const row = () => find((element) => element.props['data-asset-folder-target'] === JSON.stringify(target));
    expect(row().props.className).toContain('outline-dashed');
    driver.globalDragEvents['tauri://drag-leave']({ payload: {} }); render();
    expect(row().props.className).not.toContain('outline-dashed');
    driver.store!.getState().setAssetsPanelOpen(false); render();
    expect(Object.keys(driver.globalDragEvents)).toHaveLength(0);
  });
  it('全部资产、未登记及离线目录不接收；导入文件根目录可接收', async () => {
    await open();
    for (const invalid of [{ kind: 'all' }, { ...target, rootPath: '/removed' }]) {
      driver.hitFolder = JSON.stringify(invalid); emit('drop', ['E:/a.png']);
    }
    expect(driver.importFiles).not.toHaveBeenCalled();
    driver.globalFolders[0].availability = 'offline';
    // 用重新加载后的真实离线目录列表验证落点，而非依赖 DOM 属性。
    driver.store!.getState().setAssetsPanelOpen(false); render();
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } }); render(); await settle(); await settle();
    driver.hitFolder = JSON.stringify(target); emit('drop', ['E:/a.png']);
    expect(driver.importFiles).not.toHaveBeenCalled();
    driver.hitFolder = JSON.stringify({ kind: 'global' }); emit('drop', ['E:/a.png']); await settle();
    expect(driver.importFiles).toHaveBeenCalledWith(['E:/a.png'], { kind: 'global' }, ['/library'], expect.any(Object));
  });
  it('离开文件夹清除高亮，关闭后不再处理迟到的原生事件', async () => {
    await open(); emit('over'); emit('leave');
    expect(find((element) => element.props['data-asset-folder-target'] === JSON.stringify(target)).props.className).not.toContain('outline-dashed');
    const callback = driver.nativeDrop;
    driver.store!.getState().setAssetsPanelOpen(false); render();
    callback?.({ payload: { type: 'drop', paths: ['E:/a.png'], position: { x: 20, y: 80 } } });
    expect(driver.importFiles).not.toHaveBeenCalled();
  });
  it('同一操作进行中拒绝第二次拖放，取消后保留面板并刷新', async () => {
    await open();
    driver.importFiles.mockImplementationOnce((_paths, _target, _roots, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }));
    emit('drop', ['E:/a.png']); emit('drop', ['E:/b.png']);
    expect(driver.importFiles).toHaveBeenCalledTimes(1);
    click(find((element) => element.props.children === '取消操作')); await settle();
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    expect(find((element) => element.props.children === '操作已取消，原文件和已完成的副本均保留')).toBeDefined();
  });
  it('全局资产 Tab 抽屉内拖拽不立即关闭，目录落点由面板独占', async () => {
    await open('drawer');
    (cards()[0].props.onDragStart as (event: unknown) => void)({ preventDefault: vi.fn() });
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    emit('over'); expect(isExternalDropCaptured()).toBe(true);
    emit('drop', ['/library/图.png']); await settle();
    expect(driver.moveFile).toHaveBeenCalledTimes(1);
  });
});

describe('启动页资产入口与最近使用', () => {
  it('整页资源库发起原生拖拽时保持页面，不返回启动页', async () => {
    driver.store!.setState({ currentProjectId: null });
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await settle();
    (cards()[0].props.onDragStart as (event: unknown) => void)({ preventDefault: vi.fn() });
    expect(driver.drag).toHaveBeenCalledWith(cards()[0].props.file, expect.any(Function), undefined);
    expect(driver.store!.getState()).toMatchObject({ assetsPanelOpen: true, assetsPanelMode: 'page', currentProjectId: null });
    expect(driver.cursor).not.toHaveBeenCalled();
    expect(isExternalDropCaptured()).toBe(true);
  });
  it('没有当前项目也可直接打开全局资产，目录请求不创建或恢复画布', async () => {
    driver.store!.setState({ currentProjectId: null, dramaAssetsPanelOpen: true });
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await settle();
    expect(driver.listGlobal).toHaveBeenCalled(); expect(driver.listProject).not.toHaveBeenCalled();
    expect(cards()[0].props.file).toMatchObject({ name: '全局参考' });
    expect(driver.store!.getState().currentProjectId).toBeNull();
    expect(driver.store!.getState().dramaAssetsPanelOpen).toBe(false);
  });
  it('资源库整页展示，不创建弹窗或背景遮罩；返回时仍未打开画布', async () => {
    driver.store!.setState({ currentProjectId: null, recentAssetsRevision: 7 });
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await settle();
    expect(find((element) => element.props.role === 'main').props['aria-label']).toBe('资源库');
    expect(all(tree, (element) => element.props.role === 'dialog' || element.props.className === 'assets-panel-backdrop')).toHaveLength(0);
    expect(driver.portal).not.toHaveBeenCalled();
    expect(cards()[0].props.videoPresentation).toBe('fullscreen');
    blockingModal = true;
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    blockingModal = false;
    click(find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children.includes('返回启动页')));
    render();
    expect(driver.store!.getState()).toMatchObject({ assetsPanelOpen: false, assetsPanelRequest: null, currentProjectId: null, recentAssetsRevision: 7 });
  });
  it('图片预览才写入使用记录，列表加载和关闭预览不产生记录', async () => {
    key(); render(); await settle(); expect(driver.markUsed).not.toHaveBeenCalled();
    (cards()[0].props.onImagePreview as () => void)(); render();
    expect(driver.markUsed).toHaveBeenCalledWith(cards()[0].props.file);
    const preview = find((element) => element.type === 'asset-image-preview');
    (preview.props.onClose as () => void)(); render(); expect(driver.markUsed).toHaveBeenCalledOnce();
  });
  it('视频展开记录一次，收起和再次加载不产生使用记录', async () => {
    driver.listProject.mockResolvedValue([{ name: '视频', path: '/video.mp4', assetId: 'video', category: 'video', size: 12 }]);
    key(); render(); await settle();
    (cards()[0].props.onVideoExpandedChange as (expanded: boolean) => void)(true); render();
    (cards()[0].props.onVideoExpandedChange as (expanded: boolean) => void)(false); render();
    expect(driver.markUsed).toHaveBeenCalledOnce(); expect(driver.markUsed).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'video' }));
  });
});

describe('资产卡片悬浮提示', () => {
  async function open(mode: 'drawer' | 'modal' | 'page' = 'drawer') {
    driver.store!.getState().setAssetsPanelOpen(true, mode);
    render(); await settle(); vi.useFakeTimers();
  }
  function hover(index = 0) { (cards()[index].props.onHover as () => void)(); render(); }
  function leave(index = 0) { (cards()[index].props.onHoverEnd as () => void)(); render(); }
  function cardElement(index = 0) {
    const card = cards()[index];
    return (card.type as (props: Record<string, unknown>) => Element)(card.props);
  }
  async function readPrompt() { await vi.advanceTimersByTimeAsync(400); render(); }

  it('停留后读取编辑提示词并展示拖拽说明，悬浮不产生最近使用记录', async () => {
    driver.imageDetails.mockResolvedValue({ record: { prompt: '编辑后的\n提示词' }, history: { prompt: '旧提示词' } });
    await open();
    const index = cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林');
    hover(index);
    expect(driver.imageDetails).not.toHaveBeenCalled();
    expect(cardElement(index).props['data-tooltip']).toContain('正在读取');
    await readPrompt();
    expect(driver.imageDetails).toHaveBeenCalledWith(cards()[index].props.file, 'project-1', expect.any(AbortSignal));
    expect(cardElement(index).props['data-tooltip']).toBe('拖拽到画布可添加节点；\n提示词：编辑后的 提示词\n标签：\n夜景');
    expect(driver.markUsed).not.toHaveBeenCalled();
    expect(all(cardElement(index), (element) => element.type === 'asset-thumb')[0].props.showNativeTooltip).toBe(false);
  });

  it('快速扫过不读取；移开后忽略迟到结果，重新悬浮可读取最新内容', async () => {
    await open(); hover(); leave(); await readPrompt();
    expect(driver.imageDetails).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void;
    driver.imageDetails.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    hover(); await readPrompt();
    const signal = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    leave(); expect(signal.aborted).toBe(true);
    finish({ record: { prompt: '已过期' } }); await readPrompt();
    expect(cardElement().props['data-tooltip']).not.toContain('已过期');
    hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('历史提示词');
  });

  it('主动清空不回退历史，缺少记录与读取失败分别反馈', async () => {
    driver.imageDetails.mockResolvedValueOnce({ record: { prompt: '' }, history: { prompt: '旧提示词' } })
      .mockResolvedValueOnce({ record: null, history: null }).mockRejectedValueOnce(new Error('read failed'));
    await open(); hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('暂无提示词');
    expect(cardElement().props['data-tooltip']).not.toContain('旧提示词');
    leave(); hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('暂无提示词');
    leave(); hover(); await readPrompt();
    expect(cardElement().props['data-tooltip']).toContain('读取失败，请重试');
  });

  it('视频按所查看项目查询；弹窗和整页使用相应的拖拽说明', async () => {
    driver.listProject.mockResolvedValue([{ name: '视频', path: '/video.mp4', category: 'video', size: 12 }]);
    await open('modal'); hover(); await readPrompt();
    expect(driver.videoHistory).toHaveBeenCalledWith('/video.mp4', undefined, 'project-1', expect.any(AbortSignal));
    expect(cardElement().props['data-tooltip']).toBe('拖出弹窗到画布可添加节点；\n提示词：视频提示词\n标签：\n暂无标签');
    driver.store!.setState({ currentProjectId: null });
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await vi.advanceTimersByTimeAsync(0); render(); hover(); await readPrompt();
    expect(driver.imageDetails).toHaveBeenCalledWith(expect.objectContaining({ name: '全局参考' }), undefined, expect.any(AbortSignal));
    expect(cardElement().props['data-tooltip']).toContain('可拖拽到其他窗口或应用');
  });

  it('文本、虚拟和离线素材不查询图像历史，提示拖拽可用性', async () => {
    driver.listProject.mockResolvedValue([
      { ...file('文本'), category: 'text' }, { ...file('虚拟'), path: 'virtual://image' },
      { ...file('离线'), availability: 'offline' },
    ]);
    await open();
    for (let index = 0; index < cards().length; index++) {
      hover(index); await readPrompt();
      expect(cardElement(index).props['data-tooltip']).toContain('暂无提示词');
      if ((cards()[index].props.file as AssetFileEntry).category !== 'text') {
        expect(cardElement(index).props['data-tooltip']).toContain('暂不支持拖拽');
      }
    }
    expect(driver.imageDetails).not.toHaveBeenCalled(); expect(driver.videoHistory).not.toHaveBeenCalled();
  });

  it('搜索、项目切换和关闭面板取消读取，旧上下文内容不展示', async () => {
    driver.imageDetails.mockImplementation(() => new Promise(() => {}));
    await open(); hover(); await readPrompt();
    const first = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    (find((element) => element.props.placeholder === '搜索名称或标签…').props.onChange as (event: unknown) => void)({ target: { value: '森林' } });
    render(); expect(first.aborted).toBe(true);
    hover(); await readPrompt();
    const second = driver.imageDetails.mock.calls[1][2] as AbortSignal;
    driver.store!.setState({ currentProjectId: 'project-2' }); render(); expect(second.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0); render(); hover(); await readPrompt();
    const third = driver.imageDetails.mock.calls[2][2] as AbortSignal;
    driver.store!.getState().setAssetsPanelOpen(false); render(); expect(third.aborted).toBe(true);
  });

  it('长提示词截取摘要，拖拽与右键时隐藏提示，键盘焦点仍可读取', async () => {
    driver.imageDetails.mockResolvedValue({ record: { prompt: '长'.repeat(1000) } });
    await open('modal');
    (cardElement().props.onFocus as (event: unknown) => void)({ currentTarget: { contains: () => false }, relatedTarget: null });
    render(); await readPrompt();
    expect(String(cardElement().props['data-tooltip'])).toContain('点击查看完整提示词');
    expect(String(cardElement().props['data-tooltip']).length).toBeLessThan(300);
    openFileMenu(); expect(cardElement().props['data-tooltip']).toBeUndefined();
    fileMenu().onClose(); render(); leave(); hover(); await readPrompt();
    (cards()[0].props.onDragStart as (event: unknown) => void)({ preventDefault: vi.fn(), currentTarget: { closest: () => null } });
    render(); expect(cardElement().props['data-tooltip']).toBeUndefined();
  });

  it('鼠标和键盘焦点交接时保留已读取提示，均离开后取消', async () => {
    await open(); hover(); await readPrompt();
    const signal = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    (cardElement().props.onMouseLeave as (event: unknown) => void)({ currentTarget: { contains: () => true } });
    expect(signal.aborted).toBe(false);
    (cardElement().props.onBlur as (event: unknown) => void)({ currentTarget: { contains: () => false, matches: () => true }, relatedTarget: null });
    expect(signal.aborted).toBe(false);
    (cardElement().props.onBlur as (event: unknown) => void)({ currentTarget: { contains: () => false, matches: () => false }, relatedTarget: null });
    expect(signal.aborted).toBe(true);
  });
});

describe('资源管理弹窗拖出后收起', () => {
  async function startModalDrag() {
    driver.store!.getState().setAssetsPanelOpen(true, 'modal'); render(); await settle();
    vi.useFakeTimers(); driver.monitorNativeDrag = true;
    const event = { preventDefault: vi.fn(), currentTarget: { closest: () => ({
      getBoundingClientRect: () => ({ left: 100, right: 400, top: 80, bottom: 300, width: 300, height: 220 }),
    }) } };
    (cards()[0].props.onDragStart as (event: unknown) => void)(event);
    expect(driver.drag).toHaveBeenCalledWith(cards()[0].props.file, expect.any(Function), event.currentTarget);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
  }
  it('按窗口原点和缩放转换系统坐标，只有越过弹窗边界才关闭', async () => {
    await startModalDrag();
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    expect(driver.cursor).toHaveBeenCalledOnce();
    expect(isExternalDropCaptured()).toBe(true);
    driver.cursor.mockResolvedValue({ x: 1900, y: 800 });
    await vi.advanceTimersByTimeAsync(50); render();
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
    expect(isExternalDropCaptured()).toBe(false);
    const calls = driver.cursor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(driver.cursor).toHaveBeenCalledTimes(calls);
  });
  it('拖拽结束或取消时停止检查，之后移出弹窗不会误关闭', async () => {
    await startModalDrag();
    (driver.drag.mock.calls[0][1] as () => void)();
    driver.cursor.mockResolvedValue({ x: 1900, y: 800 });
    await vi.advanceTimersByTimeAsync(200);
    expect(driver.cursor).toHaveBeenCalledOnce();
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    expect(isExternalDropCaptured()).toBe(true);
  });
  it('关闭重开后忽略上一轮未完成的鼠标位置查询', async () => {
    let finish!: (point: { x: number; y: number }) => void;
    driver.cursor.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await startModalDrag();
    driver.store!.getState().setAssetsPanelOpen(false); render();
    driver.store!.getState().setAssetsPanelOpen(true, 'modal'); render();
    finish({ x: 1900, y: 800 });
    await vi.advanceTimersByTimeAsync(100);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });
  it('原生坐标读取失败时保留弹窗并结束检查', async () => {
    driver.cursor.mockRejectedValueOnce(new Error('native unavailable'));
    await startModalDrag(); await vi.advanceTimersByTimeAsync(200);
    expect(driver.cursor).toHaveBeenCalledOnce();
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });
});

describe('资产文件右键操作', () => {
  it('抽屉与弹窗都提供文件复制和打开目录，完整路径不被改写', async () => {
    key(); render(); await settle();
    let menu = openFileMenu(cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林'));
    expect(menu).toMatchObject({ name: '森林', canFileActions: true, canCopyPrompt: true, x: 120, y: 180 });
    await menu.onCopy(); expect(driver.copyClipboard).toHaveBeenCalledWith('assets/森林.png');
    await menu.onReveal(); expect(driver.revealFile).toHaveBeenCalledWith('assets/森林.png');
    driver.store!.getState().setAssetsPanelOpen(true); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    menu = openFileMenu(); await menu.onCopy(); await menu.onReveal();
    expect(driver.copyClipboard).toHaveBeenLastCalledWith('assets/全局参考.png');
    expect(driver.revealFile).toHaveBeenLastCalledWith('assets/全局参考.png');
  });
  it('图片优先复制用户保存的提示词，清空后的编辑内容不回退到生成历史', async () => {
    key(); render(); await settle();
    driver.imageDetails.mockResolvedValue({ record: { prompt: '用户编辑\n完整提示词' }, history: { prompt: '原始' } });
    const index = cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林');
    await openFileMenu(index).onCopyPrompt();
    expect(driver.copyText).toHaveBeenLastCalledWith('用户编辑\n完整提示词');
    expect(driver.imageDetails).toHaveBeenCalledWith(expect.objectContaining({ path: 'assets/森林.png' }), 'project-1', expect.any(AbortSignal));
    driver.copyText.mockClear(); driver.imageDetails.mockResolvedValue({ record: { prompt: '' }, history: { prompt: '原始' } });
    await openFileMenu(index).onCopyPrompt(); render();
    expect(driver.copyText).not.toHaveBeenCalled(); expect(find((el) => el.props.children === '此资产暂无提示词')).toBeDefined();
  });
  it('视频按项目与完整媒体地址读取，全局资产不限定项目', async () => {
    const video: AssetFileEntry = { name: '视频', path: '/assets/video.mp4', category: 'video', size: 10, assetUrl: 'asset://video' };
    driver.listProject.mockResolvedValue([video]); driver.listGlobal.mockResolvedValue([video]);
    key(); render(); await settle(); await openFileMenu().onCopyPrompt();
    expect(driver.videoHistory).toHaveBeenCalledWith(video.path, video.assetUrl, 'project-1', expect.any(AbortSignal));
    expect(driver.copyText).toHaveBeenLastCalledWith('视频提示词');
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle(); await openFileMenu().onCopyPrompt();
    expect(driver.videoHistory).toHaveBeenLastCalledWith(video.path, video.assetUrl, undefined, expect.any(AbortSignal));
  });
  it('读取失败和剪贴板失败有反馈，不伪造成功', async () => {
    key(); render(); await settle(); driver.copyClipboard.mockResolvedValue(false);
    await openFileMenu().onCopy(); render(); expect(find((el) => el.props.children === '复制失败，请检查文件和系统剪贴板')).toBeDefined();
    driver.imageDetails.mockRejectedValue(new Error('db')); await openFileMenu().onCopyPrompt(); render();
    expect(driver.copyText).not.toHaveBeenCalled(); expect(find((el) => el.props.children === '提示词读取或复制失败，请重试')).toBeDefined();
    driver.revealFile.mockRejectedValue(new Error('offline')); await openFileMenu().onReveal(); render();
    expect(find((el) => el.props.children === '打开目录失败，请检查文件位置和权限')).toBeDefined();
  });
  it.each(['project', 'tab', 'close', 'dismiss'])('提示词读取期间 %s 会取消查询且不复制迟到结果', async (change) => {
    key(); render(); await settle();
    let finish!: (value: unknown) => void;
    driver.imageDetails.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const menu = openFileMenu(); const pending = menu.onCopyPrompt();
    const signal = driver.imageDetails.mock.calls[0][2] as AbortSignal;
    if (change === 'project') driver.store!.setState({ currentProjectId: 'project-2' });
    else if (change === 'tab') click(all(tree, (el) => el.props.role === 'tab')[1]);
    else if (change === 'close') driver.store!.getState().setAssetsPanelOpen(false);
    else menu.onClose();
    render(); finish({ record: { prompt: '迟到提示词' }, history: null }); await pending;
    expect(signal.aborted).toBe(true); expect(driver.copyText).not.toHaveBeenCalled();
  });
  it('虚拟资源、离线文件与 Web 环境禁用磁盘操作，文本不提供提示词复制', async () => {
    driver.listProject.mockResolvedValue([
      { ...file('虚拟'), path: 'node://image' }, { ...file('离线'), availability: 'offline' },
      { ...file('文本'), category: 'text' }, { ...file('远程'), path: 'https://example.test/image.png' },
    ]); key(); render(); await settle();
    const named = (name: string) => openFileMenu(cards().findIndex((el) => (el.props.file as AssetFileEntry).name === name));
    expect(named('虚拟').canFileActions).toBe(false); expect(named('离线').canFileActions).toBe(false);
    expect(named('文本').canCopyPrompt).toBe(false); expect(named('远程').canFileActions).toBe(false);
    driver.native = false; expect(named('文本').canFileActions).toBe(false);
    await fileMenu().onDelete().catch(() => {}); expect(driver.deleteFile).not.toHaveBeenCalled();
  });
  it('删除失败保留卡片，成功刷新列表且不重新加入残留节点引用', async () => {
    key(); render(); await settle();
    const menu = openFileMenu(cards().findIndex((element) => (element.props.file as AssetFileEntry).name === '森林'));
    expect(driver.deleteFile).not.toHaveBeenCalled(); driver.deleteFile.mockRejectedValueOnce(new Error('locked'));
    await expect(menu.onDelete()).rejects.toThrow('删除失败'); render(); expect(cards()).toHaveLength(2);
    driver.listProject.mockResolvedValue([file('人物')]);
    driver.nodeFile = file('森林'); driver.store!.setState({ nodes: [canvasNode('source', 'source-image')] });
    await menu.onDelete(); render(); expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['人物']);
    expect(driver.deleteFile).toHaveBeenCalledWith('assets/森林.png');
    expect(driver.store!.getState().nodes).toHaveLength(1);
  });
  it('全局资产原有删除按钮也先确认；确认期间切换项目不会删除旧文件', async () => {
    key(); render(); await settle(); click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    (cards()[0].props.onDelete as () => void)(); render();
    const menu = fileMenu(); expect(menu.confirmDelete).toBe(true); expect(driver.deleteFile).not.toHaveBeenCalled();
    driver.store!.setState({ currentProjectId: 'project-2' }); render(); await menu.onDelete();
    expect(driver.deleteFile).not.toHaveBeenCalled();
  });
  it('键盘 ContextMenu/Shift+F10 定位菜单；标签输入保留原生菜单', async () => {
    key(); render(); await settle();
    const event = { key: 'F10', shiftKey: true, target: { closest: () => null }, currentTarget: { focus: vi.fn(), getBoundingClientRect: () => ({ left: 20, top: 40 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (cards()[0].props.onMenuKeyDown as (event: unknown) => void)(event); render();
    expect(fileMenu()).toMatchObject({ x: 32, y: 52 }); fileMenu().onClose(); render();
    const preventDefault = vi.fn();
    (cards()[0].props.onContextMenu as (event: unknown) => void)({ target: { closest: () => ({}) }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled(); expect(all(tree, (el) => el.type === AssetFileContextMenu)).toHaveLength(0);
  });
});

describe('资产文件排序', () => {
  async function open(files: AssetFileEntry[]) {
    vi.mocked(driver.store!.getState().updateConfig).mockImplementation((patch) => {
      driver.store!.setState((state) => ({ config: { ...state.config, ...patch } }));
    });
    vi.mocked(driver.store!.getState().saveConfig).mockResolvedValue(undefined);
    driver.listGlobal.mockResolvedValue(files);
    driver.store!.getState().setAssetsPanelOpen(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    render(); await settle(); await settle();
  }
  function choose(value: string) {
    (button('排序方式').props.onChange as (value: string) => void)(value); render();
  }
  function names() { return cards().map((element) => (element.props.file as AssetFileEntry).name); }

  it('默认名称自然升序，大小和真实时间排序保存字段与方向，未知创建时间始终置后', async () => {
    const files: AssetFileEntry[] = [
      { ...file('clip10'), size: 10, createdAt: 30, modifiedAt: 100 },
      { ...file('clip2'), size: 20, createdAt: 10, modifiedAt: 300 },
      { ...file('clip1'), size: 30, modifiedAt: 200 },
    ];
    await open(files);
    expect(button('排序方式').props.value).toBe('name');
    expect(button('切换为降序').props.children).toContain('升序');
    expect(names()).toEqual(['clip1', 'clip2', 'clip10']);
    choose('size');
    expect(names()).toEqual(['clip10', 'clip2', 'clip1']);
    expect(driver.store!.getState().updateConfig).toHaveBeenLastCalledWith({ assetSortBy: 'size', assetSortOrder: 'asc' });
    choose('createdAt');
    expect(names()).toEqual(['clip2', 'clip10', 'clip1']);
    click(button('切换为降序')); render();
    expect(names()).toEqual(['clip10', 'clip2', 'clip1']);
    expect(driver.store!.getState().updateConfig).toHaveBeenLastCalledWith({ assetSortBy: 'createdAt', assetSortOrder: 'desc' });
    expect(button('切换为升序').props.children).toContain('降序');
    choose('modifiedAt');
    expect(names()).toEqual(['clip2', 'clip1', 'clip10']);
    expect(driver.store!.getState().config).toMatchObject({ assetSortBy: 'modifiedAt', assetSortOrder: 'desc' });
    expect(driver.store!.getState().saveConfig).toHaveBeenCalledTimes(4);
    expect(driver.store!.getState().saveConfig).toHaveBeenLastCalledWith({ silent: true });
    expect(files.map((entry) => entry.name)).toEqual(['clip10', 'clip2', 'clip1']);
  });

  it('先排序完整筛选结果再取第一页，切换排序保留搜索分类标签并关闭图片预览', async () => {
    await open([
      ...Array.from({ length: 60 }, (_, index) => ({ ...file(`clip${60 - index}`, ['精选']), size: 60 - index })),
      { ...file('clip999', ['其他']), size: 999 },
      { ...file('clip-video', ['精选']), category: 'video', size: 9999 },
      { ...file('noise', ['精选']), size: 99999 },
    ]);
    const search = find((element) => element.props.placeholder === '搜索名称或标签…');
    (search.props.onChange as (event: unknown) => void)({ target: { value: 'clip' } }); render();
    click(find((element) => element.type === 'button' && Array.isArray(element.props.children) && element.props.children.includes('图像'))); render();
    click(find((element) => String(element.props.className).includes('assets-tag-chip')
      && Array.isArray(element.props.children) && element.props.children.includes('精选'))); render();
    expect(cards()).toHaveLength(48);
    // 瀑布流按列存放 DOM；校验第一页成员，避免把列内顺序误认为排序结果。
    expect(new Set(names())).toEqual(new Set(Array.from({ length: 48 }, (_, index) => `clip${index + 1}`)));
    (cards()[0].props.onImagePreview as () => void)(); render();
    expect(find((element) => element.type === 'asset-image-preview')).toBeDefined();
    choose('size');
    click(button('切换为降序')); render();
    expect(cards()).toHaveLength(48);
    expect(new Set(names())).toEqual(new Set(Array.from({ length: 48 }, (_, index) => `clip${60 - index}`)));
    expect(find((element) => element.props.placeholder === '搜索名称或标签…').props.value).toBe('clip');
    expect(find((element) => element.type === 'button' && Array.isArray(element.props.children)
      && element.props.children.includes('图像')).props.className).toContain('active');
    expect(find((element) => String(element.props.className).includes('assets-tag-chip')
      && Array.isArray(element.props.children) && element.props.children.includes('精选')).props.className).toContain('active');
    expect(all(tree, (element) => element.type === 'asset-image-preview')).toHaveLength(0);
  });

  it('最近使用默认降序且按稳定资产身份读取记录，使用记录变更会刷新当前排序', async () => {
    driver.lastUsedTimes.mockResolvedValue(new Map([['ten', 10], ['two', 20]]));
    await open([
      { ...file('clip10'), assetId: 'ten' }, { ...file('clip2'), assetId: 'two' }, { ...file('clip1'), assetId: 'one', createdAt: 999 },
    ]);
    choose('usedAt'); await settle();
    expect(names()).toEqual(['clip2', 'clip10', 'clip1']);
    expect(driver.store!.getState().updateConfig).toHaveBeenLastCalledWith({ assetSortBy: 'usedAt', assetSortOrder: 'desc' });
    expect(driver.store!.getState().saveConfig).toHaveBeenLastCalledWith({ silent: true });
    expect(driver.lastUsedTimes).toHaveBeenCalledWith(expect.arrayContaining(['ten', 'two', 'one']));
    const reads = driver.lastUsedTimes.mock.calls.length;
    (cards()[0].props.onImagePreview as () => void)(); render();
    driver.lastUsedTimes.mockResolvedValue(new Map([['one', 30], ['two', 20], ['ten', 10]]));
    driver.store!.setState((state) => ({ recentAssetsRevision: state.recentAssetsRevision + 1 }));
    render(); await settle();
    expect(names()).toEqual(['clip2', 'clip10', 'clip1']);
    expect(driver.lastUsedTimes.mock.calls.length).toBe(reads);
    (find((element) => element.type === 'asset-image-preview').props.onClose as () => void)();
    render(); await settle();
    expect(driver.lastUsedTimes.mock.calls.length).toBeGreaterThan(reads);
    expect(names()).toEqual(['clip1', 'clip2', 'clip10']);
    expect(button('排序方式').props.value).toBe('usedAt');
    expect(button('切换为升序').props.children).toContain('降序');
  });
});

describe('资产库 Tab 抽屉', () => {
  it('Tab 抽屉指定浮动视频，大弹窗改为全屏且携带查看项目', async () => {
    key(); render(); await settle();
    expect(cards()[0].props).toMatchObject({ videoPresentation: 'inline', videoProjectId: 'project-1' });
    driver.store!.getState().setAssetsPanelOpen(true); render(); await settle();
    expect(cards()[0].props).toMatchObject({ videoPresentation: 'fullscreen', videoProjectId: 'project-1' });
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    expect(cards()[0].props.videoProjectId).toBeUndefined();
    expect(cards()[0].props.videoPresentation).toBe('fullscreen');
  });
  it('画布 Tab 打开/收起，长按不连发且不发生焦点跳转', () => {
    expect(key().defaultPrevented).toBe(true);
    expect(driver.store!.getState().assetsPanelMode).toBe('drawer');
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    expect(key('Tab', doc.body, { repeat: true }).defaultPrevented).toBe(true);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    key();
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
  });

  it('抽屉滚动区、页签和搜索框获得焦点后按 Tab 收起，外部按钮保留焦点导航', () => {
    key(); render();
    expect(find((el) => el.props.role === 'tablist').props.tabIndex).toBe(-1);
    click(all(tree, (el) => el.props.role === 'tab')[2]); render();
    const otherButton = Object.assign(new Target(), { tagName: 'BUTTON', canvas: false, control: true });
    expect(key('Tab', otherButton).defaultPrevented).toBe(false);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    for (const target of [
      Object.assign(new Target(), { canvas: false, drawer: true }),
      Object.assign(new Target(), { tagName: 'BUTTON', canvas: false, control: true, drawer: true }),
      Object.assign(new Target(), { tagName: 'INPUT', canvas: false, control: true, drawer: true }),
    ]) {
      expect(key('Tab', target).defaultPrevented).toBe(true);
      expect(driver.store!.getState().assetsPanelOpen).toBe(false);
      driver.store!.getState().setAssetsPanelOpen(true, 'drawer');
    }
  });

  it.each(['shiftKey', 'ctrlKey', 'metaKey', 'altKey', 'isComposing'])('保留 %s + Tab', (modifier) => {
    expect(key('Tab', doc.body, { [modifier]: true }).defaultPrevented).toBe(false);
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
  });

  it('输入、按钮、画布外区域及上层弹窗均不被 Tab 抢占', () => {
    const input = Object.assign(new Target(), { tagName: 'INPUT' });
    const editable = Object.assign(new Target(), { isContentEditable: true });
    const control = Object.assign(new Target(), { control: true });
    const outside = Object.assign(new Target(), { canvas: false });
    for (const target of [input, editable, control, outside]) expect(key('Tab', target).defaultPrevented).toBe(false);
    blockingModal = true;
    expect(key().defaultPrevented).toBe(false);
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
    blockingModal = false;
    driver.store!.getState().setHelpOpen(true);
    expect(key().defaultPrevented).toBe(false);
  });

  it('抽屉不带全屏蒙层，原入口仍显示大弹窗', () => {
    key(); render();
    expect(find((el) => el.props.role === 'region').props['aria-modal']).toBeUndefined();
    expect(all(tree, (el) => el.props.className === 'assets-panel-backdrop')).toHaveLength(0);
    expect(driver.portal).not.toHaveBeenCalled();
    driver.store!.getState().setAssetsPanelOpen(true); render();
    expect(find((el) => el.props.role === 'dialog').props['aria-modal']).toBe(true);
    expect(all(tree, (el) => el.props.className === 'assets-panel-backdrop')).toHaveLength(1);
    expect(driver.portal).toHaveBeenLastCalledWith(expect.anything(), doc.body);
    expect(key().defaultPrevented).toBe(false);
  });

  it('抽屉从左侧整幅滑入并原向退出，关闭后保留退场宿主', () => {
    driver.reduceMotion = false;
    key(); render();
    const panel = find((el) => el.props.role === 'region');
    const variants = panel.props.variants as Record<string, Record<string, unknown>>;
    expect(variants.hidden).toMatchObject({ x: '-100%', opacity: 0 });
    expect(variants.visible).toMatchObject({ x: 0, opacity: 1 });
    expect(variants.exit).toMatchObject({ x: '-100%', opacity: 0 });
    const config = find((el) => el.type === 'motion-config');
    expect(config.props.reducedMotion).toBe('user');
    expect(config.props.transition).toEqual({ type: 'spring', visualDuration: 0.35, bounce: 0 });
    expect(variants.visible.transition).toEqual(config.props.transition);
    expect(variants.exit.transition).toEqual(config.props.transition);

    click(button('收起资产库')); render();
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
    expect(driver.store!.getState().assetsPanelMode).toBe('modal');
    expect(find((el) => el.type === 'motion-config').props.reducedMotion).toBe('user');
    expect(all(tree, (el) => el.type === 'presence')).toHaveLength(1);
    expect(all(tree, (el) => el.props.role === 'region')).toHaveLength(0);
  });

  it('系统减少动态效果时只淡入淡出，大弹窗不覆盖外层动效设置', () => {
    key(); render();
    const variants = find((el) => el.props.role === 'region').props.variants as Record<string, Record<string, unknown>>;
    expect(variants.hidden).toEqual({ x: 0, opacity: 0 });
    expect(variants.exit).toEqual({ x: 0, opacity: 0, transition: { duration: 0.12 } });
    expect(find((el) => el.type === 'motion-config').props.transition).toEqual({ duration: 0.12 });

    driver.store!.getState().setAssetsPanelOpen(true); render();
    expect(all(tree, (el) => el.type === 'motion-config')).toHaveLength(0);
  });

  it('抽屉固定三列且隐藏列数、批量反推与提示，不改写大弹窗设置', async () => {
    key(); render(); await settle();
    expect(find((el) => el.props.className === 'assets-file-waterfall').props['data-columns']).toBe(3);
    expect(all(tree, (el) => el.props['aria-label'] === '瀑布流列数')).toHaveLength(0);
    expect(all(tree, (el) => el.props.title === '批量反推当前筛选图片的提示词和标签')).toHaveLength(0);
    expect(all(tree, (el) => el.props.className === 'assets-panel-subtitle')).toHaveLength(0);
    expect(driver.store!.getState().updateConfig).not.toHaveBeenCalled();
    driver.store!.getState().setAssetsPanelOpen(true); render();
    expect(button('当前 6 列').props.children).toBe(6);
    expect(button('减少瀑布流列数').props.disabled).toBe(false);
    expect(all(tree, (el) => el.props.title === '批量反推当前筛选图片的提示词和标签')).toHaveLength(1);
    expect(all(tree, (el) => el.props.className === 'assets-panel-subtitle')).toHaveLength(1);
  });

  it('复用名称/标签搜索、全局与创作页签，重新打开回到当前项目', async () => {
    key(); render(); await settle();
    expect(cards()).toHaveLength(2);
    const search = find((el) => el.props.placeholder === '搜索名称或标签…');
    (search.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '夜景' } });
    render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['森林']);
    const tabs = () => all(tree, (el) => el.props.role === 'tab');
    click(tabs()[1]); render(); await settle();
    // 资产库原行为：切换文件页签保留搜索词。
    expect(cards()).toHaveLength(0);
    click(button('清空')); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['全局参考']);
    click(tabs()[2]); render();
    expect(find((el) => el.props.compact === true)).toBeDefined();
    click(button('收起资产库')); render();
    key(); render(); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['人物', '森林']);
  });

  it('目录导航按本层筛选，子目录和空目录保留，全部资产仍汇总', async () => {
    const folders: AssetFolderEntry[] = [
      { rootPath: '/library', relativePath: '', parentRelativePath: null, name: '素材库', fileCount: 1, availability: 'online' },
      { rootPath: '/library', relativePath: '人物', parentRelativePath: '', name: '人物', fileCount: 1, availability: 'online' },
      { rootPath: '/library', relativePath: '人物/表情', parentRelativePath: '人物', name: '表情', fileCount: 1, availability: 'online' },
      { rootPath: '/library', relativePath: '空目录', parentRelativePath: '', name: '空目录', fileCount: 0, availability: 'online' },
    ];
    driver.listExternal.mockResolvedValue({ folders, truncated: false, files: [
      { ...file('根目录图片'), path: '/library/root.png', source: 'folder', tags: ['夜景'] },
      { ...file('人物图片'), path: '/library/人物/hero.png', source: 'folder' },
      { ...file('微笑视频'), path: '/library/人物/表情/smile.mp4', category: 'video', source: 'folder' },
    ] });
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    expect(cards()).toHaveLength(4);
    expect(all(tree, (el) => el.props.className === 'assets-folder-picker')).toHaveLength(1);
    expect(button('浏览文件夹 空目录')).toBeDefined();
    click(button('浏览文件夹 素材库')); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['根目录图片']);
    click(button('浏览文件夹 人物')); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['人物图片']);
    expect(button('浏览文件夹 表情')).toBeDefined();
    click(button('浏览文件夹 表情')); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['微笑视频']);
    click(button('浏览文件夹 空目录')); render();
    expect(cards()).toHaveLength(0);
    expect(all(tree, (el) => el.props.children === '此文件夹为空')).toHaveLength(1);
    click(button('导入文件')); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['全局参考']);
    click(button('全部资产')); render();
    expect(cards()).toHaveLength(4);
    expect(find((el) => el.props.className === 'assets-file-waterfall').props['data-columns']).toBe(3);
  });

  it('父目录只有子目录时给出导航提示，不混入子目录文件', async () => {
    driver.listExternal.mockResolvedValue({ truncated: false, folders: [
      { rootPath: '/library', relativePath: '', parentRelativePath: null, name: '素材库', fileCount: 0, availability: 'online' },
      { rootPath: '/library', relativePath: '人物', parentRelativePath: '', name: '人物', fileCount: 1, availability: 'online' },
    ], files: [{ ...file('人物图片'), path: '/library/人物/hero.png', source: 'folder' }] });
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    click(button('浏览文件夹 素材库')); render();
    expect(cards()).toHaveLength(0);
    expect(all(tree, (el) => el.props.children === '此文件夹没有本层文件，请选择子文件夹浏览')).toHaveLength(1);
    click(button('浏览文件夹 人物')); render();
    expect(cards()).toHaveLength(1);
  });

  it('目录切换重置类型筛选，但保留搜索并复用拖拽', async () => {
    driver.listExternal.mockResolvedValue({ truncated: false, folders: [
      { rootPath: '/library', relativePath: '', parentRelativePath: null, name: '素材库', fileCount: 2, availability: 'online' },
    ], files: [
      { ...file('人物图片'), path: '/library/hero.png', source: 'folder' },
      { ...file('人物视频'), path: '/library/hero.mp4', source: 'folder', category: 'video' },
    ] });
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    const search = find((el) => el.props.placeholder === '搜索名称或标签…');
    (search.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '人物' } }); render();
    const videoFilter = find((el) => el.type === 'button' && Array.isArray(el.props.children) && el.props.children.includes('视频'));
    click(videoFilter); render();
    expect(cards()).toHaveLength(1);
    click(button('浏览文件夹 素材库')); render();
    expect(cards()).toHaveLength(2);
    expect(find((el) => el.props.placeholder === '搜索名称或标签…').props.value).toBe('人物');
    const imageCard = cards().find((element) => (element.props.file as AssetFileEntry).path === '/library/hero.png')!;
    (imageCard.props.onDragStart as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(driver.drag).toHaveBeenCalledWith(expect.objectContaining({ path: '/library/hero.png' }), expect.any(Function), undefined);
  });

  it('无法访问和未扫描目录不冒充空目录，显示扫描上限提示', async () => {
    driver.listExternal.mockResolvedValue({ files: [], truncated: true, folders: [
      { rootPath: '/missing', relativePath: '', parentRelativePath: null, name: '离线目录', fileCount: 0, availability: 'offline' },
      { rootPath: '/large', relativePath: '', parentRelativePath: null, name: '未扫描目录', fileCount: 0, availability: 'unscanned' },
    ] });
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    expect(button('浏览文件夹 未扫描目录').props.disabled).toBe(true);
    expect(all(tree, (el) => el.props.role === 'status')).toHaveLength(1);
    click(button('浏览文件夹 离线目录')); render();
    expect(all(tree, (el) => el.props.children === '文件夹无法访问，请检查位置或权限')).toHaveLength(1);
  });

  it('取消目录引用后回到全部资产，并忽略迟到的旧扫描', async () => {
    const folder: AssetFolderEntry = { rootPath: '/library', relativePath: '', parentRelativePath: null,
      name: '素材库', fileCount: 1, availability: 'online' };
    const entry: AssetFileEntry = { ...file('外部图片'), path: '/library/hero.png', source: 'folder' };
    driver.store!.setState((state) => ({ config: { ...state.config, assetFolders: ['/library'] } }));
    driver.listExternal.mockResolvedValue({ files: [entry], folders: [folder], truncated: false });
    vi.mocked(driver.store!.getState().updateConfig).mockImplementation((patch) => {
      driver.store!.setState((state) => ({ config: { ...state.config, ...patch } }));
    });
    vi.mocked(driver.store!.getState().saveConfig).mockResolvedValue(undefined);
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    click(button('浏览文件夹 素材库')); render();
    expect(cards()).toHaveLength(1);
    driver.listExternal.mockResolvedValue({ files: [], folders: [], truncated: false });
    click(button('移除文件夹引用 素材库')); render(); await settle();
    expect(driver.store!.getState().config.assetFolders).toEqual([]);
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['全局参考']);
    expect(button('全部资产').props['aria-pressed']).toBe(true);

    let finishOld!: (value: { files: AssetFileEntry[]; folders: AssetFolderEntry[]; truncated: boolean }) => void;
    driver.listExternal.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    driver.store!.setState((state) => ({ config: { ...state.config, assetFolders: ['/old'] } })); render();
    driver.store!.setState((state) => ({ config: { ...state.config, assetFolders: ['/new'] } })); render(); await settle();
    finishOld({ files: [entry], folders: [folder], truncated: false }); await settle();
    expect(all(tree, (el) => el.props['aria-label'] === '浏览文件夹 素材库')).toHaveLength(0);
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['全局参考']);
  });

  it('文件夹右键创建真实子目录，失败保留名称并显示错误', async () => {
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    const context = button('导入文件').props.onContextMenu as (event: unknown) => void;
    context({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: {}, clientX: 100, clientY: 120 }); render();
    const menuItem = (label: string) => find((el) => el.props.role === 'menuitem' && (el.props.children as unknown[]).includes(label));
    click(menuItem('新建子文件夹')); render();
    (button('子文件夹名称').props.onChange as (event: unknown) => void)({ target: { value: '参考图' } }); render();
    driver.createFolder.mockRejectedValueOnce(new Error('同名文件夹或文件已存在'));
    (find((el) => el.props['aria-label'] === '新建子文件夹').props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
    render(); await settle();
    expect(driver.createFolder).toHaveBeenCalledWith({ kind: 'global' }, [], '参考图');
    expect(button('子文件夹名称').props.value).toBe('参考图');
    expect(find((el) => el.props.role === 'alert').props.children).toBe('同名文件夹或文件已存在');
    (find((el) => el.props['aria-label'] === '新建子文件夹').props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
    render(); await settle(); await settle();
    expect(all(tree, (el) => el.props['aria-label'] === '新建子文件夹')).toHaveLength(0);
    expect(driver.listGlobal.mock.calls.length).toBeGreaterThan(1);
  });

  it('右键系统复制与粘贴读取当前剪贴板，并把目录传给原生传输', async () => {
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    const openContext = () => {
      (button('导入文件').props.onContextMenu as (event: unknown) => void)({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: {}, clientX: 100, clientY: 120 }); render();
    };
    const item = (label: string) => find((el) => el.props.role === 'menuitem' && (el.props.children as unknown[]).includes(label));
    openContext(); click(item('复制文件夹')); render(); await settle();
    expect(driver.copyClipboard).toHaveBeenCalledExactlyOnceWith('/global/file');
    driver.readClipboard.mockResolvedValueOnce(['/library/新剪贴板']);
    openContext(); click(item('粘贴')); render(); await settle(); await settle();
    expect(driver.readClipboard).toHaveBeenCalledTimes(1);
    expect(driver.copyFolder).toHaveBeenCalledWith('/library/新剪贴板', '/global/file', expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });

  it('粘贴中可以取消，失败后刷新目录且不显示成功提示', async () => {
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    driver.copyFolder.mockImplementationOnce((_source: string, _target: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
    }));
    (button('导入文件').props.onContextMenu as (event: unknown) => void)({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: {}, clientX: 100, clientY: 120 }); render();
    click(find((el) => el.props.role === 'menuitem' && (el.props.children as unknown[]).includes('粘贴'))); render(); await settle();
    const before = driver.listGlobal.mock.calls.length;
    click(find((el) => el.props.children === '取消操作')); render(); await settle(); await settle();
    expect(driver.listGlobal.mock.calls.length).toBeGreaterThan(before);
    expect(all(tree, (el) => el.props.children === '复制已取消；已复制内容保留在目标目录')).toHaveLength(1);
    expect(button('导入文件').props.disabled).toBe(false);
  });

  it('图片点击打开预览，关闭后保留目录和文件列表；切换项目使预览失效', async () => {
    driver.listGlobal.mockResolvedValue([{ ...file('参考图'), source: 'global', assetUrl: 'https://images.test/reference.png' }]);
    key(); render(); await settle();
    click(all(tree, (el) => el.props.role === 'tab')[1]); render(); await settle();
    click(button('导入文件')); render();
    (cards()[0].props.onImagePreview as () => void)(); render();
    const preview = find((el) => el.type === 'asset-image-preview');
    expect(preview.props.initialPath).toBe('assets/参考图.png');
    expect(preview.props.projectId).toBeUndefined();
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    expect(button('导入文件').props['aria-pressed']).toBe(true);
    (preview.props.onClose as () => void)(); render();
    expect(all(tree, (el) => el.type === 'asset-image-preview')).toHaveLength(0);
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['参考图']);
    expect(button('导入文件').props['aria-pressed']).toBe(true);
    (cards()[0].props.onImagePreview as () => void)(); render();
    driver.store!.setState({ currentProjectId: 'other-project' }); render();
    expect(all(tree, (el) => el.type === 'asset-image-preview')).toHaveLength(0);
  });

  it('项目图片预览关联当前查看项目，并不受列表增量展示上限限制', async () => {
    driver.listProject.mockResolvedValue(Array.from({ length: 55 }, (_, i) => ({ ...file(`图片${i}`), assetUrl: `https://images.test/${i}.png` })));
    key(); render(); await settle();
    (cards()[0].props.onImagePreview as () => void)(); render();
    const preview = find((el) => el.type === 'asset-image-preview');
    expect((preview.props.projectIdForFile as (file: AssetFileEntry) => string | undefined)(cards()[0].props.file as AssetFileEntry)).toBe('project-1');
    expect((preview.props.files as AssetFileEntry[])).toHaveLength(55);
    expect(cards()).toHaveLength(48);
  });

  it('Esc 收起，确认弹窗打开时先保留抽屉', () => {
    key(); render();
    blockingModal = true;
    win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    blockingModal = false;
    win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
  });

  it('拖入画布复用原生资产拖拽并收起抽屉', async () => {
    key(); render(); await settle();
    const card = cards()[0];
    (card.props.onDragStart as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(driver.drag).toHaveBeenCalledWith(card.props.file, undefined, undefined);
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
  });

  it.each(['drawer', 'modal'] as const)('%s 首批文件就绪后立即显示，不等待全部扫描完成', async (mode) => {
    let publish!: (batch: AssetFileEntry[]) => void;
    let finish!: (files: AssetFileEntry[]) => void;
    driver.listProject.mockImplementationOnce((_id: string, options?: AssetScanOptions) => {
      publish = options!.onFiles!;
      return new Promise<AssetFileEntry[]>((resolve) => { finish = resolve; });
    });
    driver.store!.getState().setAssetsPanelOpen(true, mode); render(); await settle();
    expect(cards()).toHaveLength(0);
    publish([file('先完成')]); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['先完成']);
    expect(all(tree, (el) => el.props.className === 'assets-empty')).toHaveLength(0);
    finish([file('先完成'), file('后完成')]); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['后完成', '先完成']);
  });

  it.each(['drawer', 'modal'] as const)('%s 同范围重开时保留已有卡片，扫描完成后替换为最新列表', async (mode) => {
    driver.store!.getState().setAssetsPanelOpen(true, mode); render(); await settle();
    expect(cards()).toHaveLength(2);
    driver.store!.getState().setAssetsPanelOpen(false); render();
    let finish!: (files: AssetFileEntry[]) => void;
    driver.listProject.mockImplementationOnce(() => new Promise<AssetFileEntry[]>((resolve) => { finish = resolve; }));
    driver.store!.getState().setAssetsPanelOpen(true, mode); render(); render(); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['人物', '森林']);
    expect(all(tree, (el) => el.props.className === 'assets-empty')).toHaveLength(0);
    finish([file('刷新结果')]); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['刷新结果']);
  });

  it.each(['drawer', 'modal'] as const)('%s 扫描中重命名图片会刷新列表，旧扫描不能恢复旧路径', async (mode) => {
    const previous = { ...file('改名前'), assetUrl: 'asset://before.png' };
    const renamed = { ...file('改名后'), assetUrl: 'asset://after.png' };
    let oldOptions!: AssetScanOptions;
    let finishOld!: (files: AssetFileEntry[]) => void;
    driver.listProject.mockImplementationOnce((_id: string, options?: AssetScanOptions) => {
      oldOptions = options!;
      return new Promise<AssetFileEntry[]>((resolve) => { finishOld = resolve; });
    }).mockResolvedValueOnce([renamed]);
    driver.store!.getState().setAssetsPanelOpen(true, mode); render(); await settle();
    oldOptions.onFiles!([previous]); render();
    (cards()[0].props.onImagePreview as () => void)(); render();
    const preview = find((el) => el.type === 'asset-image-preview');
    (preview.props.onRenamed as (previous: AssetFileEntry, next: AssetFileEntry) => void)(previous, renamed);
    render(); await settle();
    expect(oldOptions.signal?.aborted).toBe(true);
    expect(driver.listProject).toHaveBeenCalledTimes(2);
    expect(cards().map((el) => (el.props.file as AssetFileEntry).path)).toEqual([renamed.path]);
    oldOptions.onFiles!([previous]); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).path)).toEqual([renamed.path]);
    finishOld([previous]); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).path)).toEqual([renamed.path]);
  });

  it.each([
    { label: '空列表', files: [] as AssetFileEntry[] },
    { label: '不同文件', files: [file('重试结果')] },
  ])('首轮流出文件后失败，重试成功返回$label时不残留首轮条目', async ({ files: finalFiles }) => {
    vi.useFakeTimers();
    let publish!: (batch: AssetFileEntry[]) => void;
    let fail!: (error: Error) => void;
    driver.listProject.mockImplementationOnce((_id: string, options?: AssetScanOptions) => {
      publish = options!.onFiles!;
      return new Promise<AssetFileEntry[]>((_resolve, reject) => { fail = reject; });
    }).mockResolvedValueOnce(finalFiles);
    key(); render(); await vi.advanceTimersByTimeAsync(0); render();
    publish([file('首轮旧条目')]); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['首轮旧条目']);
    fail(new Error('temporary scan failure'));
    await vi.advanceTimersByTimeAsync(100); render();
    expect(driver.listProject).toHaveBeenCalledTimes(2);
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(finalFiles.map((entry) => entry.name));
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  it.each([
    { label: '最深分集目录', firstDirectory: '/series/episodes', secondDirectory: '/series/episodes/第二集' },
    { label: '相同目录按后一个分集', firstDirectory: '/series/shared', secondDirectory: '/series/shared' },
  ])('父扫描首批按$label解析归属，预览和悬浮读取都使用分集身份', async ({ firstDirectory, secondDirectory }) => {
    driver.store!.setState({ currentProjectId: 'series', projects: [
      { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-1', name: '第一集', parentId: 'series', episodeNo: 1, createdAt: 1, updatedAt: 1 },
      { id: 'episode-2', name: '第二集', parentId: 'series', episodeNo: 2, createdAt: 1, updatedAt: 1 },
    ] });
    const directories: Record<string, string> = { series: '/series', 'episode-1': firstDirectory, 'episode-2': secondDirectory };
    driver.getProjectDir.mockImplementation(async (id: string) => directories[id]);
    let publish!: (batch: AssetFileEntry[]) => void;
    let finishParent!: (files: AssetFileEntry[]) => void;
    driver.listProject.mockImplementation((id: string, options?: AssetScanOptions) => {
      if (id !== 'series') return Promise.resolve([]);
      publish = options!.onFiles!;
      return new Promise<AssetFileEntry[]>((resolve) => { finishParent = resolve; });
    });
    key(); render(); await settle(); vi.useFakeTimers();
    const entry = { ...file('分集图片'), path: `${secondDirectory}/hero.png`, assetUrl: 'asset://hero.png' };
    publish([entry]); render();
    expect(driver.listProject).toHaveBeenCalledTimes(1);
    expect(cards()[0].props.videoProjectId).toBe('episode-2');
    (cards()[0].props.onImagePreview as () => void)(); render();
    const preview = find((el) => el.type === 'asset-image-preview');
    expect((preview.props.projectIdForFile as (file: AssetFileEntry) => string | undefined)(entry)).toBe('episode-2');
    (preview.props.onClose as () => void)(); render();
    (cards()[0].props.onHover as () => void)(); render();
    await vi.advanceTimersByTimeAsync(400); render();
    expect(driver.imageDetails).toHaveBeenCalledWith(entry, 'episode-2', expect.any(AbortSignal));
    finishParent([entry]); await vi.advanceTimersByTimeAsync(0); render();
  });

  it.each(['drawer', 'modal'] as const)('首次打开 %s 读取短暂失败时自动恢复，不必关闭重开', async (mode) => {
    vi.useFakeTimers();
    driver.listProject.mockRejectedValueOnce(new Error('temporary index failure'));
    driver.store!.getState().setAssetsPanelOpen(true, mode);
    render();
    await vi.advanceTimersByTimeAsync(100); render();
    expect(driver.listProject).toHaveBeenCalledTimes(2);
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['人物', '森林']);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  it('某一分集持续读取失败时仍显示共享素材和画布资源，可原地重试', async () => {
    vi.useFakeTimers();
    driver.store!.setState({ currentProjectId: 'episode-1', projects: [
      { id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode-1', name: '第一集', parentId: 'series', episodeNo: 1, createdAt: 1, updatedAt: 1 },
      { id: 'episode-2', name: '第二集', parentId: 'series', episodeNo: 2, createdAt: 1, updatedAt: 1 },
    ], nodes: [canvasNode('image', 'source-image')] });
    driver.nodeFile = file('画布图片');
    driver.listProject.mockImplementation(async (id: string) => {
      if (id === 'episode-2') throw new Error('文件引用写入事务失败');
      return [file('共享素材')];
    });
    driver.store!.getState().setAssetsPanelOpen(true); render();
    await vi.advanceTimersByTimeAsync(100); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['共享素材', '画布图片']);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(1);
    const warning = visibleText(find((el) => el.props.role === 'alert'));
    expect(warning).toContain('项目文件读取未完成，已保留可用资源，请重试。');
    expect(warning).toContain('第二集：文件索引保存失败');
    expect(warning).not.toContain('第一集：');
    expect(driver.listProject.mock.calls.filter(([id]) => id === 'episode-2')).toHaveLength(2);
    driver.listProject.mockImplementation(async (id: string) => [file(id === 'episode-2' ? '第二集素材' : '共享素材')]);
    click(find((el) => el.type === 'button' && el.props.children === '重试加载'));
    await vi.advanceTimersByTimeAsync(0); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['第二集素材', '共享素材', '画布图片']);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
  });

  it.each([
    { kind: '索引事务', error: new Error('文件引用写入事务失败'), reason: '文件索引保存失败' },
    { kind: '身份校验', error: new Error('项目文件包含其他来源的资产身份，请先复制为独立项目资产'), reason: '文件身份校验失败' },
    { kind: '迁移记录', error: '读取文件引用迁移记录失败', reason: '文件迁移记录读取失败' },
    { kind: '未知异常', error: new Error('文件引用写入事务失败: C:\\private-assets\\image.png Authorization: Bearer private-credential-marker'), reason: '读取失败' },
  ])('项目读取失败只展示安全类别，不泄露原始异常：$kind', async ({ error, reason }) => {
    vi.useFakeTimers();
    driver.listProject.mockRejectedValue(error);
    key(); render(); await vi.advanceTimersByTimeAsync(100); render();

    const warning = visibleText(find((el) => el.props.role === 'alert'));
    expect(warning).toContain('项目一：' + reason);
    expect(warning).not.toContain(error instanceof Error ? error.message : error);
    expect(visibleText(tree)).not.toContain('C:\\private-assets\\image.png');
    expect(visibleText(tree)).not.toContain('private-credential-marker');
    expect(visibleText(tree)).not.toContain('Authorization: Bearer');
  });

  it('持续失败明确提示而不冒充空项目，手动重试后正常展示', async () => {
    vi.useFakeTimers();
    driver.listProject.mockRejectedValue(new Error('read failed'));
    key(); render(); await vi.advanceTimersByTimeAsync(100); render();
    expect(driver.listProject).toHaveBeenCalledTimes(2);
    expect(cards()).toHaveLength(0);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(1);
    expect(all(tree, (el) => el.props.children === '暂无项目文件')).toHaveLength(0);
    driver.listProject.mockResolvedValue([file('已恢复')]);
    click(find((el) => el.type === 'button' && el.props.children === '重试加载'));
    await vi.advanceTimersByTimeAsync(0); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['已恢复']);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  it('关闭面板会使等待中的自动重试失效，再次打开可以正常加载', async () => {
    vi.useFakeTimers();
    driver.listProject.mockRejectedValueOnce(new Error('temporary failure'));
    key(); render(); await vi.advanceTimersByTimeAsync(0);
    driver.store!.getState().setAssetsPanelOpen(false); render();
    await vi.advanceTimersByTimeAsync(100); render();
    expect(driver.listProject).toHaveBeenCalledOnce();
    key(); render(); await vi.advanceTimersByTimeAsync(0); render();
    expect(cards()).toHaveLength(2);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  it('切换到读取失败的项目时不显示上一项目文件', async () => {
    key(); render(); await settle();
    expect(cards()).toHaveLength(2);
    vi.useFakeTimers();
    driver.listProject.mockRejectedValue(new Error('new project unavailable'));
    driver.store!.setState({ currentProjectId: 'project-2' }); render();
    await vi.advanceTimersByTimeAsync(100); render();
    expect(cards()).toHaveLength(0);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(1);
  });

  it('保存根目录变化时重新加载，真正的空目录不反复重试', async () => {
    key(); render(); await settle();
    const calls = driver.listProject.mock.calls.length;
    driver.listProject.mockResolvedValue([]);
    driver.store!.setState((state) => ({ config: { ...state.config, baseDataDir: 'F:/new-assets' } }));
    render(); await settle();
    expect(driver.listProject).toHaveBeenCalledTimes(calls + 1);
    expect(cards()).toHaveLength(0);
    expect(all(tree, (el) => el.props.children === '暂无项目文件')).toHaveLength(1);
    expect(all(tree, (el) => el.props.role === 'alert')).toHaveLength(0);
  });

  it('项目切换后取消旧扫描，忽略旧项目的迟到批次和最终列表', async () => {
    let oldOptions!: AssetScanOptions;
    let finishOld!: (files: AssetFileEntry[]) => void;
    driver.listProject.mockImplementationOnce((_id: string, options?: AssetScanOptions) => {
      oldOptions = options!;
      return new Promise<AssetFileEntry[]>((resolve) => { finishOld = resolve; });
    });
    key(); render(); await settle();
    oldOptions.onFiles!([file('项目一首批')]); render();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['项目一首批']);
    driver.store!.setState({ currentProjectId: 'project-2' });
    driver.listProject.mockResolvedValue([file('项目二')]);
    render(); await settle();
    expect(oldOptions.signal?.aborted).toBe(true);
    oldOptions.onFiles!([file('项目一迟到批次')]); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['项目二']);
    finishOld([file('项目一迟到文件')]); await settle();
    expect(cards().map((el) => (el.props.file as AssetFileEntry).name)).toEqual(['项目二']);
  });

  it('节点列表页签列出当前画布全部类型，与文件页的项目范围和搜索独立', async () => {
    const types: NodeType[] = ['ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama',
      'ai-markdown', 'ai-storyboard', 'ai-shotlist', 'ai-director', 'source-image', 'source-video',
      'source-audio', 'source-text', 'canvas-note', 'plugin-node', 'comment'];
    driver.store!.setState({ nodes: types.map((type) => canvasNode(type, type)) });
    key(); render(); await settle();
    (find((el) => el.props.placeholder === '搜索名称或标签…').props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '无关文件关键词' } });
    (find((el) => el.type === 'asset-select').props.onChange as (value: string) => void)('another-project');
    render(); openNodeList();
    expect(nodeRows().map((el) => el.props['data-node-id'])).toEqual(types);
    expect(all(tree, (el) => el.type === 'asset-select')).toHaveLength(0);
    expect(cards()).toHaveLength(0);
    expect(find((el) => el.props.placeholder === '搜索节点名称、类型或编号…').props.value).toBe('');
    expect(all(nodeListTab(), (el) => el.props.className === 'ui-tabs__count')[0].props.children).toBe(types.length);
  });

  it('节点增删、改名和项目切换后，节点列表与计数实时跟随画布', () => {
    driver.store!.setState({ nodes: [canvasNode('image', 'ai-image', '旧名称')] });
    key(); render(); openNodeList();
    driver.store!.setState({ nodes: [canvasNode('image', 'ai-image', '新名称'), canvasNode('note', 'canvas-note')] });
    render();
    expect(button('查看节点 新名称')).toBeDefined();
    expect(nodeRows()).toHaveLength(2);
    driver.store!.setState({ currentProjectId: 'project-2', nodes: [canvasNode('text', 'ai-text')] }); render();
    expect(nodeRows().map((el) => el.props['data-node-id'])).toEqual(['text']);
    expect(all(nodeListTab(), (el) => el.props.className === 'ui-tabs__count')[0].props.children).toBe(1);
    driver.store!.setState({ nodes: [] }); render();
    expect(nodeRows()).toHaveLength(0);
    expect(find((el) => el.props.children === '当前画布暂无节点')).toBeDefined();
  });

  it('节点搜索支持名称、类型和编号，大列表可以继续加载全部节点', () => {
    const nodes = Array.from({ length: 55 }, (_, i) => canvasNode(`node-${i}`, 'ai-image', `图片 ${i}`));
    nodes[54] = { ...canvasNode('note', 'canvas-note', '分镜备注'), data: { type: 'canvas-note', label: '分镜备注', displayId: 99 } };
    driver.store!.setState({ nodes });
    key(); render(); openNodeList();
    expect(nodeRows()).toHaveLength(48);
    click(find((el) => el.props.children === '加载更多节点')); render();
    expect(nodeRows()).toHaveLength(55);
    for (const query of ['分镜备注', '画布笔记', '#99', '不匹配的词']) {
      (find((el) => el.props.placeholder === '搜索节点名称、类型或编号…').props.onChange as (e: { target: { value: string } }) => void)({ target: { value: query } });
      render();
      expect(nodeRows().map((el) => el.props['data-node-id'])).toEqual(query === '不匹配的词' ? [] : ['note']);
    }
  });

  it('查看节点发送与历史记录相同的定位回弹事件，抽屉保持打开', () => {
    driver.store!.setState({ nodes: [canvasNode('target', 'ai-image', '参考图')] });
    key(); render(); openNodeList();
    const focus = vi.fn();
    win.addEventListener('canvas-focus-node', (event) => focus((event as CustomEvent).detail));
    const locate = button('查看节点 参考图');
    click(locate);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ nodeId: 'target', pulse: true });
    expect(driver.store!.getState().assetsPanelOpen).toBe(true);
    driver.store!.setState({ nodes: [] });
    click(locate);
    expect(focus).toHaveBeenCalledTimes(1);
    render();
    expect(find((el) => el.props.children === '节点已不存在')).toBeDefined();
  });

  it('大弹窗先关闭再定位，切换项目后不执行迟到的定位', () => {
    vi.useFakeTimers();
    driver.store!.setState({ nodes: [canvasNode('target', 'ai-text')] });
    driver.store!.getState().setAssetsPanelOpen(true); render(); openNodeList();
    const focus = vi.fn();
    win.addEventListener('canvas-focus-node', (event) => focus((event as CustomEvent).detail));
    click(button('查看节点 target'));
    expect(driver.store!.getState().assetsPanelOpen).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ nodeId: 'target', pulse: true });
    driver.store!.getState().setAssetsPanelOpen(true); render();
    click(button('查看节点 target'));
    driver.store!.setState({ currentProjectId: 'project-2' });
    vi.advanceTimersByTime(300);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
