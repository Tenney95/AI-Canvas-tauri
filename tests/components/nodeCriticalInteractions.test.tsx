/**
 * nodeCriticalInteractions — 回归测试：image generation history application。
 */
vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
vi.mock('../../src/hooks/useComfyMediaSource', () => ({ useComfyMediaSource: (source?: string) => source }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';
import type { AppState } from '../../src/store/useAppStore';
import type { ComfyNodeProgress } from '../../src/types/comfyProgress';
import type { AppConfig } from '../../src/types';

const confirmVideoReferencesBeforeGeneration = vi.fn<
  (nodeId: string, overridePrompt?: string) => Promise<boolean>
>();
const flushPendingAutoSave = vi.fn<(projectId: string) => Promise<boolean>>();

interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

interface TestNode {
  id: string;
  type: string;
  parentId?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface TestStore {
  activeNodeId: string | null;
  config: Pick<AppConfig, 'providers' | 'generalModels'> & { performanceMode: boolean };
  currentProjectId: string | null;
  projectLoadStatus: 'ready' | 'loading';
  dialogPosition?: { x: number; y: number };
  nodes: TestNode[];
  edges: Array<{ id: string; source: string; target: string }>;
  projects: Array<{ id: string; settings?: Record<string, unknown> }>;
  customStyles: Array<Record<string, unknown>>;
  workflows: unknown[];
  selectedNodeIds: string[];
  comfyNodeProgress: Record<string, ComfyNodeProgress>;
  getCurrentRevision: () => number;
  setNodes: (nodes: TestNode[]) => void;
  addNode: ReturnType<typeof vi.fn>;
  addNodeTransient: ReturnType<typeof vi.fn>;
  updateNodeData: ReturnType<typeof vi.fn>;
  updateNodeDataTransient: ReturnType<typeof vi.fn<(nodeId: string, patch: Record<string, unknown>) => void>>;
  commitToHistory: ReturnType<typeof vi.fn<AppState['commitToHistory']>>;
  recordOutputHistory: ReturnType<typeof vi.fn<AppState['recordOutputHistory']>>;
  showToast: ReturnType<typeof vi.fn>;
  renameGroup: ReturnType<typeof vi.fn>;
  toggleGroupCollapsed: ReturnType<typeof vi.fn>;
  setGroupColor: ReturnType<typeof vi.fn>;
  settleGroupMembersOnResizeEnd: ReturnType<typeof vi.fn<(groupId: string) => void>>;
  closeNodeDialog: ReturnType<typeof vi.fn>;
  mergeDramaExtract: ReturnType<typeof vi.fn>;
  openNodeDialog: ReturnType<typeof vi.fn>;
  bindShotlistFrame: ReturnType<typeof vi.fn>;
  bindShotlistVideo: ReturnType<typeof vi.fn>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isElementLike(value: unknown): value is ElementLike {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function findElement(root: unknown, predicate: (element: ElementLike) => boolean): ElementLike {
  if (Array.isArray(root)) {
    for (const child of root) {
      try {
        return findElement(child, predicate);
      } catch {
        // Continue through sibling elements.
      }
    }
    throw new Error('Element not found');
  }
  if (!isElementLike(root)) throw new Error('Element not found');
  if (predicate(root)) return root;
  return findElement(root.props.children, predicate);
}

function componentName(element: ElementLike): string {
  return typeof element.type === 'function' ? element.type.name : String(element.type);
}

async function installReactHookDriver(
  stateValue?: (initialValue: unknown, index: number) => unknown,
  effects?: Array<() => void | (() => void)>,
  layoutEffects?: Array<() => void | (() => void)>,
  setters?: Array<ReturnType<typeof vi.fn>>,
) {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof import('react')>('react');
    let stateIndex = 0;
    let idIndex = 0;
    return {
      ...actual,
      memo: <T,>(component: T) => component,
      lazy: () => function LazyComponentMock() { return null; },
      Suspense: ({ children }: { children: unknown }) => children,
      useCallback: <T,>(callback: T) => callback,
      useEffect: (effect: () => void | (() => void)) => { effects?.push(effect); },
      useLayoutEffect: (effect: () => void | (() => void)) => { layoutEffects?.push(effect); },
      useContext: () => undefined,
      useId: () => `test-id-${++idIndex}`,
      useMemo: <T,>(factory: () => T) => factory(),
      useRef: <T,>(initialValue: T) => ({ current: initialValue }),
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown, getServerSnapshot?: () => unknown) => (
        typeof document === 'undefined' && getServerSnapshot ? getServerSnapshot() : getSnapshot()
      ),
      useState: <T,>(initialValue: T | (() => T)) => {
        const resolved = typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue;
        const value = stateValue?.(resolved, stateIndex++) ?? resolved;
        const setter = vi.fn();
        setters?.push(setter);
        return [value as T, setter] as const;
      },
    };
  });
}

function createStore(nodes: TestNode[], getRevision: () => number): TestStore {
  const store = {
    activeNodeId: null,
    config: { performanceMode: false, providers: {} },
    currentProjectId: 'project-a',
    projectLoadStatus: 'ready',
    nodes,
    edges: [],
    projects: [{ id: 'project-a', settings: { styleReferenceId: 'style-project' } }],
    customStyles: [{ id: 'style-project', name: 'Project style' }],
    workflows: [],
    selectedNodeIds: [],
    comfyNodeProgress: {},
    getCurrentRevision: getRevision,
    setNodes: (nextNodes: TestNode[]) => { store.nodes = nextNodes; },
    addNode: vi.fn((node: TestNode) => { store.nodes = [...store.nodes, node]; }),
    addNodeTransient: vi.fn((node: TestNode) => { store.nodes = [...store.nodes, node]; }),
    updateNodeData: vi.fn((nodeId: string, patch: Record<string, unknown>) => {
      store.nodes = store.nodes.map((node) => (
        node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
      ));
    }),
    updateNodeDataTransient: vi.fn((nodeId: string, patch: Record<string, unknown>) => {
      store.nodes = store.nodes.map((node) => (
        node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
      ));
    }),
    commitToHistory: vi.fn<AppState['commitToHistory']>(),
    recordOutputHistory: vi.fn<AppState['recordOutputHistory']>().mockResolvedValue(undefined),
    showToast: vi.fn(),
    renameGroup: vi.fn(),
    toggleGroupCollapsed: vi.fn(),
    setGroupColor: vi.fn(),
    settleGroupMembersOnResizeEnd: vi.fn<(groupId: string) => void>(() => { store.commitToHistory(); }),
    closeNodeDialog: vi.fn(),
    mergeDramaExtract: vi.fn(),
    openNodeDialog: vi.fn(),
    bindShotlistFrame: vi.fn(),
    bindShotlistVideo: vi.fn().mockReturnValue(true),
  } satisfies TestStore;
  return store;
}

function installStoreMock(store: TestStore) {
  const useAppStore = Object.assign(
    <T,>(selector: (state: TestStore) => T) => selector(store),
    { getState: () => store },
  );
  vi.doMock('../../src/store/useAppStore', () => ({
    generateId: () => 'generated',
    computeImageNodeDimensions: vi.fn(),
    useAppStore,
  }));
}

function mockComfyDeliveries() {
  return {
    subscribeComfyDeliveries: () => () => {},
    isComfyNodeDeliveryActive: () => false,
    beginComfyNodeDelivery: vi.fn(),
    completeComfyNodeTask: vi.fn(),
    pauseComfyNodeDelivery: vi.fn(),
    prepareMediaNodeGeneration: vi.fn(),
    registerMediaNodeOperation: () => vi.fn(),
    completeMediaNodeTask: vi.fn(),
    pauseMediaTask: vi.fn(),
    isMediaTaskPausedError: () => false,
  };
}

function installCommonNodeMocks() {
  vi.doMock('../../src/hooks/useCompletionFlash', () => ({ useCompletionFlash: () => false }));
  vi.doMock('../../src/hooks/useReferencedImageWatcher', () => ({
    useReferencedImageRevisions: () => () => 0,
    withPreviewRevision: (url: string | undefined) => url,
  }));
  vi.doMock('../../src/components/nodes/shared/useNodeRename', () => ({
    useNodeRename: (_id: string, data: Record<string, unknown>, fallback: string) => ({
      displayLabel: data.label ?? fallback,
      handleRename: vi.fn(),
    }),
  }));
  vi.doMock('../../src/components/nodes/shared/useSourceFileUpload', () => ({
    useSourceFileUpload: () => ({ isUploading: false, handleUpload: vi.fn() }),
  }));
}

async function setupImageHistoryApplication(currentPath = 'C:/project/current.png', status = 'success') {
  const entry: HistoryRecord = {
    id: 'history-image', projectId: 'project-a', nodeId: 'image-node', nodeLabel: '图片',
    timestamp: 100, prompt: '历史提示词', output: 'https://example.com/history.png',
    mediaUrl: 'https://example.com/history.png', filePath: 'C:/project/history.png',
    nodeType: 'ai-image', model: 'history-model', provider: 'history-provider', status: 'success',
  };
  const effects: Array<() => void | (() => void)> = [];
  await installReactHookDriver((initial, index) => index % 9 === 0 ? [entry] : index % 9 === 1 ? 'project-a' : initial, effects);
  let revision = 1;
  const store = createStore([{
    id: 'image-node', type: 'ai-image', position: { x: 0, y: 0 },
    data: { filePath: currentPath, imageUrl: `asset://localhost/${encodeURIComponent(currentPath)}`,
      prompt: '当前提示词', model: 'current-model', status, nodeWidth: 360, mediaVersion: 5,
      annotation: 'old-annotation', mattingMask: 'old-mask', artifactId: 'old-artifact' },
  }], () => revision);
  installStoreMock(store);
  vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text, getLocale: () => 'zh-CN' }));
  vi.doMock('react-dom', () => ({ createPortal: (children: unknown) => children }));
  vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}` }));
  vi.doMock('../../src/services/indexedDbService', () => ({ getNodeHistoryEntries: vi.fn(async () => [entry]) }));
  vi.doMock('../../src/components/shared/ModalOverlay', () => ({ default: function ModalOverlayMock() { return null; } }));
  vi.doMock('../../src/components/shared/PopupCloseButton', () => ({ default: function PopupCloseButtonMock() { return null; } }));
  vi.doMock('../../src/components/shared/FullscreenOverlay', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ZoomableImage', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ViewportImage', () => ({ default: () => null }));
  const size = { imageWidth: 1024, imageHeight: 512, nodeWidth: 280, nodeHeight: 142 };
  const dimensions = vi.fn<typeof import('../../src/components/nodes/shared/image/imageUtils').computeImageNodeDimensions>()
    .mockResolvedValue(size);
  vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({ computeImageNodeDimensions: dimensions }));
  vi.stubGlobal('document', { body: {} });
  const Dialog = (await import('../../src/components/nodes/shared/image/ImageGenerationHistoryDialog')).default;
  const render = () => Dialog({ isOpen: true, nodeId: 'image-node', onClose: vi.fn() });
  const tree = render();
  const button = findElement(tree, (element) => element.type === 'button'
    && Array.isArray(element.props.children) && ['应用', '当前使用'].includes(element.props.children[1] as string));
  return { store, dimensions, size, tree, button, render, effects, changeRevision: () => { revision += 1; },
    click: () => (button.props.onClick as () => void)() };
}

describe('image generation history application', () => {
  afterEach(() => {
    vi.doUnmock('../../src/i18n');
    vi.doUnmock('react-dom');
    vi.doUnmock('@tauri-apps/api/core');
    vi.doUnmock('../../src/services/indexedDbService');
    vi.doUnmock('../../src/components/shared/ModalOverlay');
    vi.doUnmock('../../src/components/shared/PopupCloseButton');
    vi.doUnmock('../../src/components/shared/FullscreenOverlay');
    vi.doUnmock('../../src/components/shared/ZoomableImage');
    vi.doUnmock('../../src/components/shared/ViewportImage');
    vi.doUnmock('../../src/components/nodes/shared/image/imageUtils');
  });

  it('applies a historical image through the Store action while retaining generation settings', async () => {
    const setup = await setupImageHistoryApplication();
    setup.click();
    await vi.waitFor(() => expect(setup.store.updateNodeData).toHaveBeenCalledTimes(1));
    expect(setup.store.nodes[0].data).toMatchObject({
      imageUrl: 'asset://localhost/C%3A%2Fproject%2Fhistory.png',
      thumbnailUrl: 'asset://localhost/C%3A%2Fproject%2Fhistory.png', filePath: 'C:/project/history.png',
      prompt: '当前提示词', model: 'current-model', imageWidth: 1024, imageHeight: 512,
      nodeWidth: 360, nodeHeight: 182, mediaVersion: 6,
      annotation: undefined, mattingMask: undefined, artifactId: undefined,
    });
    const currentButton = findElement(setup.render(), (element) => element.type === 'button'
      && Array.isArray(element.props.children) && element.props.children[1] === '当前使用');
    expect(currentButton.props.disabled).toBe(true);
  });

  it('recognizes the current Windows path despite slash and case differences', async () => {
    const setup = await setupImageHistoryApplication('c:\\PROJECT\\history.png');
    expect(setup.button.props.disabled).toBe(true);
    setup.click();
    expect(setup.dimensions).not.toHaveBeenCalled();
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
  });

  it('falls back to the media link without retaining an unavailable local file', async () => {
    const setup = await setupImageHistoryApplication();
    setup.dimensions.mockResolvedValueOnce({ nodeWidth: 280, nodeHeight: 158 });
    setup.click();
    await vi.waitFor(() => expect(setup.store.updateNodeData).toHaveBeenCalledTimes(1));
    expect(setup.dimensions).toHaveBeenNthCalledWith(2, 'https://example.com/history.png');
    expect(setup.store.nodes[0].data).toMatchObject({
      imageUrl: 'https://example.com/history.png', filePath: undefined, fileName: undefined,
    });
  });

  it('retains the current result when both image sources fail', async () => {
    const setup = await setupImageHistoryApplication();
    setup.dimensions.mockResolvedValue({ nodeWidth: 280, nodeHeight: 158 });
    setup.click();
    await vi.waitFor(() => expect(setup.store.showToast).toHaveBeenCalledWith('图片加载失败', 'error'));
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
    expect(setup.store.nodes[0].data.filePath).toBe('C:/project/current.png');
  });

  it.each(['project', 'revision', 'node', 'close', 'unmount'] as const)('rejects a late image after %s changes', async (change) => {
    const setup = await setupImageHistoryApplication();
    const pending = deferred<typeof setup.size>();
    setup.dimensions.mockReturnValueOnce(pending.promise);
    setup.click();
    setup.click();
    expect(setup.dimensions).toHaveBeenCalledTimes(1);
    if (change === 'project') setup.store.currentProjectId = 'project-b';
    if (change === 'revision') setup.changeRevision();
    if (change === 'node') setup.store.nodes = [];
    if (change === 'close') {
      const modal = findElement(setup.tree, (element) => componentName(element) === 'ModalOverlayMock');
      (modal.props.onClose as () => void)();
    }
    if (change === 'unmount') {
      const cleanup = setup.effects[0]();
      if (typeof cleanup !== 'function') throw new Error('Missing application cleanup');
      cleanup();
    }
    pending.resolve(setup.size);
    await pending.promise;
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
    expect(setup.store.showToast).not.toHaveBeenCalled();
  });

  it('does not replace a result while the node is generating', async () => {
    const setup = await setupImageHistoryApplication(undefined, 'loading');
    expect(setup.button.props.disabled).toBe(true);
    setup.click();
    expect(setup.dimensions).not.toHaveBeenCalled();
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
  });
});

async function installShotlistTimelineMock() {
  const { resolveShotlistTimelineRows, resolveShotlistVoiceoverNodes } = await vi.importActual<
    typeof import('../../src/services/videoEditorService')
  >('../../src/services/videoEditorService');
  const hasShotlistTimeline = vi.fn().mockResolvedValue(false);
  const openVideoEditorForShotlist = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../src/services/videoEditorService', () => ({
    hasShotlistTimeline, openVideoEditorForShotlist, resolveShotlistTimelineRows, resolveShotlistVoiceoverNodes,
  }));
  return { hasShotlistTimeline, openVideoEditorForShotlist };
}

async function setupShotlistWidths(
  widths?: Record<string, number>, rows: Record<string, unknown>[] = [], dragRowId?: string,
  dataOverrides: Record<string, unknown> = {},
  options: { nodes?: TestNode[]; picker?: Record<string, unknown> } = {},
) {
  const setters: Array<ReturnType<typeof vi.fn>> = [];
  await installReactHookDriver((initial, index) => index === 1 ? true
    : index === 2 ? dragRowId ?? initial : index === 4 ? options.picker ?? initial : initial,
  undefined, undefined, setters);
  const shotlist: TestNode = {
    id: 'shotlist', type: 'ai-shotlist', position: { x: 0, y: 0 },
    data: { type: 'ai-shotlist', label: '第一场', shotlistColumnWidths: widths, shotlistRows: rows, ...dataOverrides },
  };
  const store = createStore([shotlist, ...(options.nodes ?? [])], () => 1);
  installStoreMock(store);
  installCommonNodeMocks();
  vi.doMock('@xyflow/react', () => ({
    Handle: function HandleMock() { return null; },
    Position: { Left: 'left', Right: 'right' },
    useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn() }),
  }));
  vi.doMock('react-dom', () => ({ createPortal: (children: unknown) => children }));
  const timeline = await installShotlistTimelineMock();
  const ShotlistNode = (await import('../../src/components/nodes/ShotlistNode')).default as unknown as (
    props: { id: string; data: Record<string, unknown>; selected: boolean },
  ) => unknown;
  const tree = ShotlistNode({ id: shotlist.id, data: shotlist.data, selected: true });
  const table = findElement(tree, (element) => element.type === 'table');
  const header = {
    dataset: { shotColumn: 'content' }, offsetWidth: widths?.content ?? 200,
    getBoundingClientRect: () => ({ width: (widths?.content ?? 200) / 2 }),
  };
  (table.props.ref as { current: unknown }).current = { offsetWidth: 1456 };
  const handle = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '内容列宽');
  const pointer = (clientX: number) => ({
    button: 0, pointerId: 7, clientX, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    currentTarget: {
      closest: () => header, setPointerCapture: vi.fn(),
      hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    },
  });
  return { tree, table, store, handle, pointer, setters, timeline };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/services/generationService');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // These component tests cover delegation; the real reference guard has its own suite.
  confirmVideoReferencesBeforeGeneration.mockReset().mockResolvedValue(true);
  vi.doMock('../../src/services/videoReferenceConfirmation', () => ({ confirmVideoReferencesBeforeGeneration }));
  flushPendingAutoSave.mockReset().mockResolvedValue(true);
  vi.doMock('../../src/hooks/useAutoSave', () => ({ flushPendingAutoSave }));
  // The hook driver renders element trees directly, including the dialog's body portal.
  vi.doMock('react-dom', () => ({ createPortal: (children: unknown) => children }));
  vi.stubGlobal('document', { body: {}, documentElement: { getAttribute: () => null } });
});

async function setupImageFullscreen() {
  const effects: Array<() => void | (() => void)> = [];
  const setters: Array<ReturnType<typeof vi.fn>> = [];
  await installReactHookDriver(undefined, effects, undefined, setters);
  let revision = 1;
  const store = createStore([{
    id: 'image-source', type: 'ai-image', position: { x: 20, y: 30 },
    data: { type: 'ai-image', label: '原图', imageUrl: 'asset://localhost/image.png', filePath: '/project/image.png', mediaVersion: 1 },
  }], () => revision);
  installStoreMock(store);
  installCommonNodeMocks();
  vi.doMock('@xyflow/react', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }));
  vi.doMock('../../src/components/nodes/shared/image/ImageNodeToolbar', () => ({ default: () => null }));
  vi.doMock('../../src/hooks/useCanvasNodeLod', () => ({ useCanvasNodeLodPreviewRevision: () => undefined, useCanvasNodeLodProtection: () => {} }));
  vi.doMock('../../src/components/nodes/shared/image/useImageNodeOnnxActions', () => ({ useImageNodeOnnxActions: () => ({}) }));
  vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({ computeImageNodeDimensions: vi.fn() }));
  vi.doMock('../../src/services/fileService', () => ({ buildNodeFileName: vi.fn(), saveDataUrlToProjectData: vi.fn() }));
  vi.doMock('../../src/services/clipboardService', () => ({ copyImage: vi.fn() }));
  vi.doMock('../../src/services/apimartService', () => ({ generateOutpaintImage: vi.fn() }));
  vi.doMock('../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
  vi.doMock('../../src/store/store.utils', () => ({ blobToDataUrl: vi.fn() }));
  vi.doMock('../../src/components/nodes/shared/toolbar/presetAction', () => ({ createPresetNode: vi.fn() }));
  const ImageNode = (await import('../../src/components/nodes/ImageNode')).default as unknown as (
    props: { id: string; data: Record<string, unknown>; selected: boolean },
  ) => unknown;
  const renderNode = (id: string) => {
    const offset = setters.length;
    const tree = ImageNode({ id, data: store.nodes.find((node) => node.id === id)!.data, selected: true });
    const toolbar = findElement(tree, (element) => typeof element.props.onFullscreen === 'function');
    return { setters: setters.slice(offset), open: toolbar.props.onFullscreen as () => Promise<void> };
  };
  const first = renderNode('image-source');
  return { store, setters: first.setters, effects, open: first.open, renderNode,
    changeRevision: () => { revision++; } };
}

describe('image fullscreen save barrier', () => {
  afterEach(() => {
    for (const path of [
      '@xyflow/react', '../../src/components/nodes/shared/image/ImageNodeToolbar',
      '../../src/hooks/useCanvasNodeLod', '../../src/components/nodes/shared/image/useImageNodeOnnxActions',
      '../../src/components/nodes/shared/image/imageUtils', '../../src/services/fileService',
      '../../src/services/clipboardService', '../../src/services/apimartService',
      '../../src/services/generationService', '../../src/store/store.utils',
      '../../src/components/nodes/shared/toolbar/presetAction',
    ]) vi.doUnmock(path);
  });

  it('waits for the actual save before opening, coalesces repeated clicks and preserves the original', async () => {
    const setup = await setupImageFullscreen();
    const original = structuredClone(setup.store.nodes[0]);
    const saved = deferred<boolean>();
    flushPendingAutoSave.mockReturnValueOnce(saved.promise);
    const first = setup.open();
    await setup.open();
    expect(flushPendingAutoSave).toHaveBeenCalledExactlyOnceWith('project-a');
    expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
    saved.resolve(true);
    await first;
    expect(setup.setters[2]).toHaveBeenCalledWith('project-a');
    expect(setup.setters[3]).toHaveBeenCalledWith(true);
    expect(setup.store.nodes[0]).toEqual(original);
    expect(setup.store.updateNodeData).not.toHaveBeenCalled();
    expect(setup.store.commitToHistory).not.toHaveBeenCalled();
  });

  it('opens only the latest image when two nodes share the same pending save', async () => {
    const setup = await setupImageFullscreen();
    setup.store.nodes = [...setup.store.nodes, { ...setup.store.nodes[0], id: 'image-second',
      data: { ...setup.store.nodes[0].data, imageUrl: 'blob:second' } }];
    const second = setup.renderNode('image-second');
    const saved = deferred<boolean>();
    flushPendingAutoSave.mockReturnValue(saved.promise);
    const firstOpening = setup.open();
    setup.store.selectedNodeIds = ['image-second'];
    const secondOpening = second.open();
    saved.resolve(true);
    await Promise.all([firstOpening, secondOpening]);
    expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
    expect(second.setters[3]).toHaveBeenCalledWith(true);
    expect(setup.store.showToast).not.toHaveBeenCalled();
  });

  it.each(['false', 'reject'] as const)('keeps the canvas and reports a fixed error when saving returns %s', async (failure) => {
    const setup = await setupImageFullscreen();
    if (failure === 'false') flushPendingAutoSave.mockResolvedValue(false);
    else flushPendingAutoSave.mockRejectedValue(new Error('/private/secret/project save failed'));
    await setup.open();
    expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
    expect(setup.store.showToast).toHaveBeenCalledExactlyOnceWith('保存失败，编辑内容已保留', 'error');
    expect(setup.store.nodes).toHaveLength(1);
    flushPendingAutoSave.mockResolvedValue(true);
    await setup.open();
    expect(setup.setters[3]).toHaveBeenCalledWith(true);
  });

  it.each(['project', 'revision', 'node', 'imageUrl', 'filePath', 'mediaVersion', 'unmount'] as const)(
    'rejects late fullscreen opening after %s changes while saving', async (change) => {
      const setup = await setupImageFullscreen();
      const saved = deferred<boolean>();
      flushPendingAutoSave.mockReturnValue(saved.promise);
      const pending = setup.open();
      if (change === 'project') setup.store.currentProjectId = 'project-b';
      if (change === 'revision') setup.changeRevision();
      if (change === 'node') setup.store.nodes = [];
      if (change === 'imageUrl') setup.store.nodes[0].data = { ...setup.store.nodes[0].data, imageUrl: 'blob:replacement' };
      if (change === 'filePath') setup.store.nodes[0].data = { ...setup.store.nodes[0].data, filePath: '/project/new.png' };
      if (change === 'mediaVersion') setup.store.nodes[0].data = { ...setup.store.nodes[0].data, mediaVersion: 2 };
      if (change === 'unmount') setup.effects.forEach((effect) => { const dispose = effect(); if (dispose) dispose(); });
      saved.resolve(true);
      await pending;
      expect(setup.setters[3]).not.toHaveBeenCalledWith(true);
      expect(setup.store.showToast).not.toHaveBeenCalled();
    },
  );
});

function visibleShotRatio(store: TestStore, column: string) {
  const ratios = store.nodes[0].data.shotlistColumnRatios as Record<string, number>;
  const total = ['shotSize', 'camera', 'cinematography', 'content', 'dialogue']
    .reduce((sum, key) => sum + ratios[key], 0);
  return ratios[column] / total * 100;
}

describe('critical canvas node interactions', () => {
  it('keeps frame editor keyboard input from opening generation or modifying the canvas', async () => {
    const effects: Array<() => void | (() => void)> = [];
    await installReactHookDriver(undefined, effects);
    const store = createStore([{ id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 }, data: { type: 'ai-animation' } }], () => 1);
    store.selectedNodeIds = ['animation'];
    installStoreMock(store);
    const listeners = new Map<string, (event: unknown) => Promise<void>>();
    vi.stubGlobal('document', { addEventListener: (name: string, listener: (event: unknown) => Promise<void>) => listeners.set(name, listener), removeEventListener: vi.fn() });
    vi.doMock('../../src/utils/assetSearchWindow', () => ({ openAssetSearchWindow: vi.fn() }));
    vi.doMock('../../src/utils/nodeAnimations', () => ({ playNodeExit: vi.fn() }));
    vi.doMock('../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), cancelNodePolling: vi.fn() }));
    vi.doMock('@tauri-apps/plugin-global-shortcut', () => ({ unregisterAll: vi.fn() }));
    vi.doMock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => { throw new Error('Web test'); } }));
    const { useKeyboardShortcuts } = await import('../../src/hooks/useKeyboardShortcuts');
    useKeyboardShortcuts();
    const cleanup = effects[0]();
    const target = { tagName: 'BUTTON', closest: (selector: string) => selector === '.animation-editor' ? {} : null };
    for (const key of [' ', 'Delete', 'Backspace', 'z', '6']) {
      const event = { target, key, code: key === '6' ? 'Digit6' : key === ' ' ? 'Space' : '', ctrlKey: key === 'z', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      await listeners.get('keydown')!(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(store.openNodeDialog).not.toHaveBeenCalled(); expect(store.addNode).not.toHaveBeenCalled();
    expect(store.nodes).toHaveLength(1); expect(store.commitToHistory).not.toHaveBeenCalled();
    cleanup?.();
  });
  it.each(['生成动画', '动画', '角色待机'])('opens the frame editor on a node double click and preserves custom labels (%s)', async (label) => {
    const setters: Array<ReturnType<typeof vi.fn>> = [];
    await installReactHookDriver(undefined, undefined, undefined, setters);
    const node: TestNode = { id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 }, data: { type: 'ai-animation', label } };
    const store = createStore([node], () => 1);
    installStoreMock(store); installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({ Handle: function HandleMock() { return null; }, Position: { Left: 'left', Right: 'right' } }));
    const AnimationNode = (await import('../../src/components/nodes/AnimationNode')).default as unknown as (props: { id: string; data: Record<string, unknown>; selected: boolean }) => unknown;
    const tree = AnimationNode({ id: node.id, data: node.data, selected: true });
    const title = findElement(tree, (element) => element.props.kind === 'ai-animation');
    expect(title.props.label).toBe(label === '角色待机' ? label : '帧动画');
    const body = findElement(tree, (element) => typeof element.props.onDoubleClick === 'function');
    const doubleClick = body.props.onDoubleClick as (event: unknown) => void;
    const stopPropagation = vi.fn();
    doubleClick({ target: { closest: () => ({}) }, stopPropagation });
    expect(setters.every((setter) => setter.mock.calls.length === 0)).toBe(true);
    doubleClick({ target: { closest: () => null }, stopPropagation });
    expect(setters.filter((setter) => setter.mock.calls.length > 0)).toHaveLength(1);
    expect(setters.some((setter) => setter.mock.calls[0]?.[0] === true)).toBe(true);
    expect(store.closeNodeDialog).toHaveBeenCalledOnce();
    expect(store.openNodeDialog).not.toHaveBeenCalled();
    const generate = findElement(tree, (element) => element.props['aria-label'] === '生成帧动画');
    (generate.props.onClick as (event: unknown) => void)({ stopPropagation });
    expect(store.openNodeDialog).toHaveBeenCalledExactlyOnceWith('animation');
  });
  it.each(['playing', 'sheet'])('waits for the transparent preview after remount and source changes (%s)', async (mode) => {
    const effects: Array<() => void | (() => void)> = [];
    const setters: Array<ReturnType<typeof vi.fn>> = [];
    let previewState: unknown;
    await installReactHookDriver((initial, index) => index % 6 === 5 ? previewState : initial, effects, undefined, setters);
    const node: TestNode = {
      id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 },
      data: { type: 'ai-animation', filePath: 'sprite.png', imageUrl: 'asset://original', animationPreviewMode: mode },
    };
    const store = createStore([node], () => 1);
    installStoreMock(store); installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({ Handle: function HandleMock() { return null; }, Position: { Left: 'left', Right: 'right' } }));
    const request = deferred<{ url: string; cols: number; rows: number; cellWidth: number; cellHeight: number; warnings: string[]; dispose: () => void }>();
    const prepare = vi.fn(() => request.promise);
    vi.doMock('../../src/services/animationService', async () => ({
      ...await vi.importActual<typeof import('../../src/services/animationService')>('../../src/services/animationService'),
      prepareAnimationPreview: prepare,
    }));
    const AnimationNode = (await import('../../src/components/nodes/AnimationNode')).default as unknown as (props: { id: string; data: Record<string, unknown> }) => unknown;
    const props = { id: node.id, data: node.data };
    const pending = AnimationNode(props);
    expect(() => findElement(pending, (element) => element.type === 'img')).toThrow('Element not found');
    expect(findElement(pending, (element) => element.props.role === 'status').props.children).toBeDefined();
    const cleanup = effects[0]();
    const preview = { url: 'blob:transparent-cache', cols: 4, rows: 2, cellWidth: 96, cellHeight: 96, warnings: [], dispose: vi.fn() };
    request.resolve(preview);
    await request.promise;
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledExactlyOnceWith('sprite.png', expect.any(Object), expect.any(Object), 'project-a');
    previewState = setters[5].mock.calls[0][0];
    const ready = AnimationNode(props);
    expect(findElement(ready, (element) => element.type === 'img').props.src).toBe(preview.url);
    // 相同路径在另一个项目，或换图/改处理参数，都不能沿用旧缓存或先闪原图。
    store.currentProjectId = 'project-b';
    expect(() => findElement(AnimationNode(props), (element) => element.type === 'img')).toThrow('Element not found');
    store.currentProjectId = 'project-a';
    for (const patch of [{ filePath: 'new-sprite.png' }, { animationProcessing: { chromaKey: 'green' } }]) {
      expect(() => findElement(AnimationNode({ ...props, data: { ...node.data, ...patch } }), (element) => element.type === 'img')).toThrow('Element not found');
    }
    cleanup?.();
    expect(preview.dispose).toHaveBeenCalledOnce();
    previewState = undefined;
    const remounted = AnimationNode(props);
    expect(() => findElement(remounted, (element) => element.type === 'img')).toThrow('Element not found');
    expect(findElement(remounted, (element) => element.props.role === 'status').props.children).toBeDefined();
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses the original only without a local source or after preview failure (local: %s)', async (local) => {
    const effects: Array<() => void | (() => void)> = [];
    const setters: Array<ReturnType<typeof vi.fn>> = [];
    let previewState: unknown;
    await installReactHookDriver((initial, index) => index % 6 === 5 ? previewState : initial, effects, undefined, setters);
    const node: TestNode = {
      id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 },
      data: { type: 'ai-animation', imageUrl: 'asset://original', ...(local ? { filePath: 'sprite.png' } : {}) },
    };
    installStoreMock(createStore([node], () => 1)); installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({ Handle: function HandleMock() { return null; }, Position: { Left: 'left', Right: 'right' } }));
    const prepare = vi.fn().mockRejectedValue(new Error('preview unavailable'));
    vi.doMock('../../src/services/animationService', async () => ({
      ...await vi.importActual<typeof import('../../src/services/animationService')>('../../src/services/animationService'),
      prepareAnimationPreview: prepare,
    }));
    const AnimationNode = (await import('../../src/components/nodes/AnimationNode')).default as unknown as (props: { id: string; data: Record<string, unknown> }) => unknown;
    const props = { id: node.id, data: node.data };
    AnimationNode(props);
    effects[0]();
    if (local) {
      await Promise.resolve(); await Promise.resolve();
      previewState = setters[5].mock.calls[0][0];
    } else expect(prepare).not.toHaveBeenCalled();
    const tree = AnimationNode(props);
    expect(findElement(tree, (element) => element.type === 'img').props.src).toBe('asset://original');
    if (local) expect(findElement(tree, (element) => element.props.className === 'animation-processing-hint').props.children).toBe('preview unavailable');
  });
  it('lets a custom Select type spaces and use input undo without triggering canvas shortcuts', async () => {
    const effects: Array<() => void | (() => void)> = [];
    await installReactHookDriver(undefined, effects);
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('window', { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: vi.fn() });
    const Select = (await import('../../src/components/shared/Select')).default;
    const textChange = vi.fn();
    const tree = Select({ value: 'custom', onChange: vi.fn(), 'aria-label': '运镜',
      options: [{ value: 'custom', label: '自定义' }], customInput: { value: '手持', onChange: textChange } });
    const input = findElement(tree, (element) => element.type === 'input');
    const target = { blur: vi.fn() };
    (input.props.ref as { current: unknown }).current = target;
    (tree.props.ref as { current: unknown }).current = { contains: (element: unknown) => element === target };
    effects.forEach((effect) => effect());
    const keydown = listeners.get('keydown')!;
    for (const key of [' ', 'Backspace', 'z']) {
      const event = { key, target, ctrlKey: key === 'z', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
      keydown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    }
    const enter = { key: 'Enter', target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    keydown(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(target.blur).toHaveBeenCalledOnce();
    const composing = { ...enter, isComposing: true, preventDefault: vi.fn() };
    keydown(composing);
    expect(composing.preventDefault).not.toHaveBeenCalled();
    (input.props.onChange as (event: unknown) => void)({ target: { value: '手持 环绕' } });
    expect(textChange).toHaveBeenCalledWith('手持 环绕');
  });

  it('shows shot numbers as read-only row positions even when saved numbers differ', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '3a' }, { id: 'row-2', shotNo: '9' },
    ]);
    const body = findElement(tree, (element) => element.type === 'tbody');
    const numbers = (body.props.children as ElementLike[]).map((row) =>
      findElement(row, (element) => element.props['aria-label'] === '镜号'));
    expect(numbers.map((number) => number.type)).toEqual(['span', 'span']);
    expect(numbers.map((number) => number.props.children)).toEqual([1, 2]);
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
  });

  it('keeps the generated video column visible and opens a separate ready-video picker', async () => {
    vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 900 });
    const frame = { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' };
    const { tree, table, setters } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '1', frame },
    ], undefined, { shotlistColumns: ['camera', 'dialogue'] }, { nodes: [
      { id: 'other-video', type: 'source-video', position: { x: 0, y: 0 }, data: { label: '导入视频', videoUrl: 'asset://other.mp4' } },
      { id: 'shot-video', type: 'ai-video', position: { x: 0, y: 0 }, data: { label: '本镜成片', videoUrl: 'asset://shot.mp4',
        shotlistProductionSource: { kind: 'video', nodeId: 'shotlist', rowId: 'row-1' } } },
      { id: 'pending-video', type: 'ai-video', position: { x: 0, y: 0 }, data: { status: 'loading' } },
      { id: 'reference', type: 'source-image', position: { x: 0, y: 0 }, data: { imageUrl: frame.url } },
    ] });
    const videoHeader = findElement(table, (element) => element.type === 'th' && element.props['data-shot-column'] === 'video');
    expect((videoHeader.props.children as unknown[])[0]).toBe('生成视频');
    const videoCell = findElement(tree, (element) => element.props['data-shot-video-row'] === 'row-1');
    const anchor = { getBoundingClientRect: () => ({ left: 200, bottom: 300 }) };
    (videoCell.props.onClick as (event: unknown) => void)({ currentTarget: anchor });
    expect(setters[4]).toHaveBeenLastCalledWith(expect.objectContaining({ rowId: 'row-1', target: 'video',
      candidates: [expect.objectContaining({ nodeId: 'shot-video' }), expect.objectContaining({ nodeId: 'other-video' })],
    }));
    const framePicker = findElement(tree, (element) => element.props['aria-label'] === '换一个画面');
    (framePicker.props.onClick as (event: unknown) => void)({ currentTarget: anchor });
    expect(setters[4]).toHaveBeenLastCalledWith(expect.objectContaining({ rowId: 'row-1', target: 'frame' }));
  });

  it('binds a picked generated video through its own Store action', async () => {
    vi.stubGlobal('document', { body: {} });
    const frame = { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' };
    const { tree, store } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', frame }], undefined, {}, {
      picker: { rowId: 'row-1', target: 'video', projectId: 'project-a', left: 0, top: 0,
        candidates: [{ nodeId: 'shot-video', kind: 'video', label: '本镜成片' }] },
    });
    const candidate = findElement(tree, (element) => element.type === 'button' && element.props.title === '本镜成片');
    (candidate.props.onClick as () => void)();
    expect(store.bindShotlistVideo).toHaveBeenCalledWith('shotlist', 'row-1', 'shot-video');
    expect(store.bindShotlistFrame).not.toHaveBeenCalled();
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].frame).toBe(frame);
  });

  it('clears only the generated video binding and preserves the reference frame', async () => {
    const frame = { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' };
    const video = { nodeId: 'shot-video', kind: 'video', url: 'asset://shot.mp4' };
    const { tree, store } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', frame, video }]);
    const clear = findElement(tree, (element) => element.props['aria-label'] === '解除视频绑定');
    (clear.props.onClick as () => void)();
    expect(store.nodes[0].data.shotlistRows).toEqual([{ id: 'row-1', shotNo: '1', frame, video: null }]);
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    expect(store.bindShotlistFrame).not.toHaveBeenCalled();
  });

  it('pushes only ready generated videos and reports the skipped shot numbers', async () => {
    const { tree, store, timeline } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '1', frame: { nodeId: 'reference-video', kind: 'video', url: 'asset://reference.mp4' } },
      { id: 'row-2', shotNo: '2', frame: { nodeId: 'reference', kind: 'image', url: 'asset://reference.png' },
        video: { nodeId: 'shot-video', kind: 'video', url: 'asset://old.mp4' } },
      { id: 'row-3', shotNo: '3', video: { nodeId: 'pending-video', kind: 'video', url: 'asset://stale.mp4' } },
    ], undefined, {}, { nodes: [
      { id: 'shot-video', type: 'ai-video', position: { x: 0, y: 0 }, data: { videoUrl: 'asset://ready.mp4' } },
      { id: 'pending-video', type: 'ai-video', position: { x: 0, y: 0 }, data: {} },
    ] });
    const push = findElement(tree, (element) => element.type === 'button' && element.props.className === 'shotlist-btn shotlist-btn--primary');
    await (push.props.onClick as () => Promise<void>)();
    expect(timeline.openVideoEditorForShotlist).toHaveBeenCalledOnce();
    expect(timeline.openVideoEditorForShotlist).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', nodeId: 'shotlist', rows: [expect.objectContaining({ id: 'row-2',
        video: expect.objectContaining({ nodeId: 'shot-video', url: 'asset://ready.mp4' }),
      })],
    }));
    expect(store.showToast).toHaveBeenCalledWith('已推送 1 段视频；跳过未就绪镜头：1、3', 'info');
  });

  it('does not open or replace a timeline when the table has no ready generated videos', async () => {
    const { tree, store, timeline } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1',
      frame: { nodeId: 'reference-video', kind: 'video', url: 'asset://reference.mp4' }, video: null,
    }]);
    const push = findElement(tree, (element) => element.type === 'button' && element.props.className === 'shotlist-btn shotlist-btn--primary');
    await (push.props.onClick as () => Promise<void>)();
    expect(timeline.hasShotlistTimeline).not.toHaveBeenCalled();
    expect(timeline.openVideoEditorForShotlist).not.toHaveBeenCalled();
    expect(store.showToast).toHaveBeenCalledWith('请先在“生成视频”列回填已就绪的视频，再推送时间轴', 'error');
  });

  it.each(['add', 'delete', 'reorder'])(
    'renumbers shots after %s while keeping their stable IDs and frame bindings', async (action) => {
      const frame = { nodeId: 'image-source', kind: 'image', url: 'data:image/png;base64,frame' };
      const { tree, store } = await setupShotlistWidths(undefined, [
        { id: 'row-1', shotNo: '3a', frame },
        { id: 'row-2', shotNo: '9' },
        { id: 'row-3', shotNo: '12' },
      ], action === 'reorder' ? 'row-1' : undefined);
      const body = findElement(tree, (element) => element.type === 'tbody');
      const renderedRows = body.props.children as ElementLike[];
      if (action === 'add') {
        const add = findElement(tree, (element) => element.props.onClick !== undefined
          && element.props.className === 'shotlist-add nodrag');
        (add.props.onClick as () => void)();
      } else if (action === 'delete') {
        const remove = findElement(renderedRows[1], (element) => element.props['aria-label'] === '删除该镜');
        (remove.props.onClick as () => void)();
      } else {
        (renderedRows[2].props.onDrop as (event: unknown) => void)({ preventDefault: vi.fn() });
      }
      const result = store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>;
      const expectedIds = action === 'add' ? ['row-1', 'row-2', 'row-3', 'shot-generated']
        : action === 'delete' ? ['row-1', 'row-3'] : ['row-2', 'row-3', 'row-1'];
      expect(result.map((row) => row.id)).toEqual(expectedIds);
      expect(result.map((row) => row.shotNo)).toEqual(expectedIds.map((_, index) => String(index + 1)));
      expect(result.find((row) => row.id === 'row-1')?.frame).toBe(frame);
      expect(store.updateNodeDataTransient).toHaveBeenCalledOnce();
      expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    },
  );

  it('edits shot content with shared mention chips while preserving serialized references and row bindings', async () => {
    const content = '参考 @drama{scene-1:工作室} 与 @{image-1:参考图}';
    const frame = { nodeId: 'frame-1', mediaType: 'image' };
    const { tree, store } = await setupShotlistWidths(undefined, [
      { id: 'row-1', shotNo: '1', content, dialogue: '原台词', frame, duration: 3 },
      { id: 'row-2', shotNo: '2', content: '第二镜', duration: 4 },
    ]);
    const editor = findElement(tree, (element) => element.props.value === content
      && element.props.className === 'shot-content-editor w-full');
    expect(editor.props).toMatchObject({ nodeId: 'shotlist', ariaLabel: '内容', portalDropdown: true, canSubmit: false, submitShortcut: 'ctrl-enter' });
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    (editor.props.onChange as (value: string) => void)(`${content}\n补充动作`);
    expect(store.nodes[0].data.shotlistRows).toEqual([
      { id: 'row-1', shotNo: '1', content: `${content}\n补充动作`, dialogue: '原台词', frame, duration: 3 },
      { id: 'row-2', shotNo: '2', content: '第二镜', duration: 4 },
    ]);
    expect(store.commitToHistory).not.toHaveBeenCalled();
    (editor.props.onBlur as () => void)();
    expect(store.commitToHistory).toHaveBeenCalledOnce();
  });

  it.each([['content', '内容'], ['dialogue', '台词']])('opens the full field editor for %s while chip double-click keeps preview behavior', async (field, label) => {
    const { tree, store, setters } = await setupShotlistWidths(undefined, [{
      id: 'row-1', shotNo: '1', content: '镜头内容', dialogue: '台词内容', duration: 3,
    }]);
    const cell = findElement(tree, (element) => element.props.className === 'ui-input-group shot-input nodrag nowheel'
      && (element.props.children as ElementLike)?.props?.ariaLabel === label);
    const event = { stopPropagation: vi.fn(), target: { closest: vi.fn(() => null) } };
    (cell.props.onDoubleClick as (event: unknown) => void)(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(setters.some((setter) => setter.mock.calls.some(([value]) => value?.rowId === 'row-1'
      && value?.field === field && value?.projectId === 'project-a'))).toBe(true);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    (cell.props.onDoubleClick as (event: unknown) => void)({ ...event, target: { closest: () => ({}) } });
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    const editor = cell.props.children as ElementLike;
    expect(editor.props).toMatchObject({ nodeId: 'shotlist', ariaLabel: label, portalDropdown: true, canSubmit: false });
    const shortcut = { altKey: true, key: 'Enter', nativeEvent: { isComposing: true, keyCode: 229 }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (cell.props.onKeyDownCapture as (event: unknown) => void)(shortcut);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    (cell.props.onKeyDownCapture as (event: unknown) => void)({ ...shortcut, nativeEvent: { isComposing: false, keyCode: 13 } });
    expect(shortcut.preventDefault).toHaveBeenCalledOnce();
    expect(shortcut.stopPropagation).toHaveBeenCalledOnce();
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
  });

  it('edits dialogue through the shared reference editor without changing shot content', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [{
      id: 'row-1', shotNo: '1', content: '保留画面内容', dialogue: '原台词', duration: 3,
    }]);
    const editor = findElement(tree, (element) => element.props.ariaLabel === '台词' && element.props.portalDropdown === true);
    (editor.props.onChange as (value: string) => void)('角色 @drama{character-1:人物}：新台词');
    expect(store.nodes[0].data.shotlistRows).toEqual([{
      id: 'row-1', shotNo: '1', content: '保留画面内容', dialogue: '角色 @drama{character-1:人物}：新台词', duration: 3,
    }]);
  });

  it('opens table defaults and stable-row photography from the shared table, without writing on open', async () => {
    const { tree, store, setters } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', content: '原内容' }]);
    const defaults = findElement(tree, (element) => element.type === 'button' && Array.isArray(element.props.children)
      && element.props.children.includes('整表摄影'));
    (defaults.props.onClick as () => void)();
    expect(setters.some((setter) => setter.mock.calls.some(([value]) => value?.projectId === 'project-a' && value?.rowId === undefined))).toBe(true);
    const shot = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '摄影设置 · 镜头 1');
    (shot.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() });
    expect(setters.some((setter) => setter.mock.calls.some(([value]) => value?.projectId === 'project-a' && value?.rowId === 'row-1'))).toBe(true);
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
  });

  it('keeps custom shotlist options editable and stores real values when selecting UI Kit presets', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [{
      id: 'row-1', shotNo: '1', shotSize: '特写', camera: '手持跟拍并轻微晃动', duration: 3,
    }]);
    const cameraSelect = findElement(tree, (element) => componentName(element) === 'Select'
      && element.props['aria-label'] === '运镜');
    expect(cameraSelect.props.fixedMenu).toBe(true);
    expect(cameraSelect.props.value).toBe('custom');
    expect(() => findElement(tree, (element) => element.type === 'input'
      && element.props['aria-label'] === '运镜自定义')).toThrow('Element not found');
    const Select = (await import('../../src/components/shared/Select')).default;
    const control = Select(cameraSelect.props as unknown as Parameters<typeof Select>[0]);
    const customInput = findElement(control, (element) => element.type === 'input');
    expect(customInput.props.value).toBe('手持跟拍并轻微晃动');
    expect(customInput.props.role).toBe('combobox');
    const inputGroup = findElement(control, (element) => (element.props.className as string | undefined)?.includes('ui-input-group') ?? false);
    expect(findElement(inputGroup, (element) => element.type === 'button').props['aria-haspopup']).toBe('listbox');
    (customInput.props.onChange as (event: unknown) => void)({ target: { value: '环绕后推进' } });
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].camera).toBe('环绕后推进');
    store.commitToHistory.mockClear();
    (cameraSelect.props.onChange as (value: string) => void)('preset:0');
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0]).toMatchObject({
      camera: '固定', shotSize: '特写', duration: 3,
    });
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    store.updateNodeDataTransient.mockClear();
    (cameraSelect.props.onChange as (value: string) => void)('custom');
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    (cameraSelect.props.onChange as (value: string) => void)('');
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].camera).toBe('');
  });

  it('resizes shotlist columns in canvas coordinates and saves once when the drag ends', async () => {
    const { tree, handle, pointer, store } = await setupShotlistWidths();
    const initialRatio = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '内容列宽').props.value as number;
    (handle.props.onPointerDown as (event: unknown) => void)(pointer(100));
    (handle.props.onPointerMove as (event: unknown) => void)(pointer(150));
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
    (handle.props.onPointerUp as (event: unknown) => void)(pointer(150));
    // 剩余弹性空间 1000px，画布缩放 50%，屏幕上移动 50px 对应增加 10 个百分点。
    expect(store.updateNodeDataTransient).toHaveBeenCalledOnce();
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(initialRatio + 10);
    expect(store.nodes[0].data.shotlistColumnWidths).toBeUndefined();
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    (handle.props.onLostPointerCapture as (event: unknown) => void)(pointer(150));
    expect(store.updateNodeDataTransient).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'lost capture', 'project switch', 'revision change', 'no movement'])(
    'does not save a column drag after %s', async (reason) => {
      const { handle, pointer, store } = await setupShotlistWidths();
      (handle.props.onPointerDown as (event: unknown) => void)(pointer(100));
      if (reason !== 'no movement') (handle.props.onPointerMove as (event: unknown) => void)(pointer(150));
      if (reason === 'project switch') store.currentProjectId = 'project-b';
      if (reason === 'revision change') store.getCurrentRevision = () => 2;
      const callback = reason === 'cancel' ? 'onPointerCancel'
        : reason === 'lost capture' ? 'onLostPointerCapture' : 'onPointerUp';
      (handle.props[callback] as (event: unknown) => void)(pointer(150));
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(store.commitToHistory).not.toHaveBeenCalled();
    },
  );

  it('converts legacy widths to percentages, redistributes space and resets the layout', async () => {
    const { tree, table, store } = await setupShotlistWidths({ content: 320, dialogue: 180 });
    const input = findElement(tree, (element) => componentName(element) === 'NumberStepper' && element.props['aria-label'] === '内容列宽');
    expect(input.props.value).toBeCloseTo(320 / (68 + 68 + 180 + 320 + 180) * 100);
    expect(input.props.unit).toBe('%');
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toContain('minmax(0,');
    expect((table.props.style as Record<string, string>).width).toBeUndefined();
    expect((table.props.style as Record<string, string>).minWidth).toBeUndefined();
    (input.props.onChange as (value: number) => void)(12);
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(12);
    expect(store.nodes[0].data.shotlistColumnWidths).toBeUndefined();
    const reset = findElement(tree, (element) => element.type === 'button' && element.props.children === '恢复默认');
    (reset.props.onClick as () => void)();
    expect(store.nodes[0].data.shotlistColumnWidths).toBeUndefined();
    expect(store.nodes[0].data.shotlistColumnRatios).toBeUndefined();
  });

  it('supports keyboard resizing with a bounded width', async () => {
    const { handle, store } = await setupShotlistWidths(undefined, [], undefined, {
      shotlistColumnRatios: { shotNo: 1, frame: 1, video: 1, shotSize: 2, camera: 2, cinematography: 2, dialogue: 2, content: 94 },
    });
    (handle.props.onKeyDown as (event: unknown) => void)({
      key: 'ArrowRight', shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(95);
  });

  it.each([
    { column: 'duration', label: '时长', width: 84, layout: '84px 106px' },
    { column: 'frame', label: '画面', width: 96, layout: '48px 96px 96px' },
    { column: 'video', label: '生成视频', width: 96, layout: '48px 96px 96px' },
  ])('keeps $column fixed at $width px and excludes it from resizing and percentage settings', async ({ column, label, layout }) => {
    const { tree, table } = await setupShotlistWidths({ [column]: 500, content: 300 });
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toContain(layout);
    expect(() => findElement(tree, (element) => element.props['aria-label'] === `${label}列宽`)).toThrow('Element not found');
  });

  it('keeps shot numbers fixed at 48px and excludes them from resizing and percentage settings', async () => {
    const { tree, table } = await setupShotlistWidths({ shotNo: 300, content: 300 }, [], undefined, {
      shotlistColumnRatios: { shotNo: 90, content: 30 },
    });
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toMatch(/^26px 48px /);
    expect(() => findElement(tree, (element) => element.props['aria-label'] === '镜号列宽')).toThrow('Element not found');
  });

  it('restores persisted ratios while keeping hidden column preferences', async () => {
    const { tree, store } = await setupShotlistWidths(undefined, [], undefined, {
      shotlistColumnRatios: { shotNo: 5, frame: 10, shotSize: 10, camera: 15, cinematography: 20, content: 30, dialogue: 30, note: 20 },
    });
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '内容列宽');
    // 画面和生成视频固定后，剩余列只按自己的旧比例重新分配空间。
    expect(stepper.props.value).toBeCloseTo(30 / (10 + 15 + 20 + 30 + 30) * 100);
    (stepper.props.onChange as (value: number) => void)(40);
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(40);
    expect((store.nodes[0].data.shotlistColumnRatios as Record<string, number>).note).toBe(20);
    expect(visibleShotRatio(store, 'shotSize') / visibleShotRatio(store, 'camera')).toBeCloseTo(10 / 15);
  });

  it('uses the small NumberStepper for fractional durations without losing frame bindings', async () => {
    const frame = { nodeId: 'image-source', kind: 'image' };
    const { tree, store } = await setupShotlistWidths(undefined, [{ id: 'row-1', shotNo: '1', duration: 3, frame }]);
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '时长');
    expect(stepper.props).toMatchObject({ value: 3, size: 'sm', min: 0, step: 0.5, unit: 's' });
    (stepper.props.onChange as (value: number) => void)(3.5);
    expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0])
      .toMatchObject({ id: 'row-1', shotNo: '1', duration: 3.5, frame });
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
  });

  it.each(['时长', '内容列宽'])('groups NumberStepper scrubbing for %s into one history change', async (label) => {
    const { tree, store } = await setupShotlistWidths({ content: 300 }, [{ id: 'row-1', shotNo: '1', duration: 3 }]);
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === label);
    const scrub = stepper.props.onScrubStateChange as (active: boolean) => void;
    const change = stepper.props.onChange as (value: number) => void;
    scrub(true);
    change(label === '时长' ? 3.5 : 31);
    change(label === '时长' ? 4 : 32);
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    scrub(false);
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    if (label === '时长') {
      expect((store.nodes[0].data.shotlistRows as Array<Record<string, unknown>>)[0].duration).toBe(4);
    } else {
      expect(visibleShotRatio(store, 'content')).toBeCloseTo(32);
    }
  });

  it('NodeGenerationProgress renders real ComfyUI value and percent for the current project', async () => {
    await installReactHookDriver();
    const store = createStore([], () => 1);
    store.comfyNodeProgress['node-1'] = {
      projectId: 'project-a',
      nodeId: 'node-1',
      requestId: 'request-1',
      clientId: 'client-1',
      stage: 'running',
      value: 6,
      max: 12,
      percent: 50,
      executingNodeId: '12',
      executingNodeLabel: '视频采样',
      cachedNodeCount: 8,
      updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');

    const rendered = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成图像中...' });
    const progressbar = findElement(rendered, (element) => element.props.role === 'progressbar');
    const detail = findElement(rendered, (element) => element.props.children === '6 / 12 · 50%');

    expect(progressbar.props['aria-valuenow']).toBe(50);
    expect(progressbar.props['aria-label']).toBe('ComfyUI 当前节点进度');
    expect(detail).toBeTruthy();
    expect(findElement(rendered, (element) => element.props.children === '#12 · 视频采样')).toBeTruthy();
    expect(findElement(rendered, (element) => element.props.title === '已复用 8 个缓存节点')).toBeTruthy();
  });

  it('ComfyUI waiting and finalizing never display a stale node percentage', async () => {
    await installReactHookDriver();
    const store = createStore([], () => 1);
    store.comfyNodeProgress['node-1'] = {
      projectId: 'project-a', nodeId: 'node-1', requestId: 'request', clientId: 'client',
      stage: 'queued', queuePosition: 3, value: 12, max: 12, percent: 100, updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');
    const waiting = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成视频中...', overlay: true });
    expect(findElement(waiting, (element) => element.props.children === '等待队列第 3 位')).toBeTruthy();
    expect(findElement(waiting, (element) => element.props.role === 'progressbar').props['aria-valuenow']).toBeUndefined();
    expect(waiting.props.className).toBe('generation-progress-overlay');

    store.comfyNodeProgress['node-1'].stage = 'finalizing';
    const finalizing = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成视频中...' });
    expect(findElement(finalizing, (element) => element.props.children === '执行已结束，等待结果回传')).toBeTruthy();
    expect(findElement(finalizing, (element) => element.props.role === 'progressbar').props['aria-valuenow']).toBeUndefined();
  });

  it('ComfyUI fallback explains unavailable step progress and does not leak another project status', async () => {
    await installReactHookDriver();
    const store = createStore([], () => 1);
    store.comfyNodeProgress['node-1'] = {
      projectId: 'project-a', nodeId: 'node-1', requestId: 'request', clientId: 'client',
      stage: 'running', transport: 'polling', updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');
    const render = () => NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成视频中...' });
    expect(findElement(render(), (element) => element.props.children === '正在查询任务状态').props.title)
      .toBe('正在查询任务状态，步骤进度暂不可用');
    store.comfyNodeProgress['node-1'].connectionIssue = 'forbidden';
    expect(findElement(render(), (element) => element.props.children === '进度访问被拒绝（403），仍在查询结果').props.title)
      .toContain('请检查 ComfyUI 服务或网关的访问权限');
    store.comfyNodeProgress['node-1'].projectId = 'other-project';
    expect(() => findElement(render(), (element) => element.props.role === 'progressbar')).toThrow('Element not found');
  });

  it('generation timing keeps total elapsed time while measuring the current ComfyUI node separately', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await installReactHookDriver();
    const store = createStore([{ id: 'video', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', status: 'loading', generationStartedAt: 880_000 } }], () => 1);
    installStoreMock(store);
    const { GenerationWaitTime } = await import('../../src/components/nodes/shared/NodeGenerationProgress');
    const timing = GenerationWaitTime({ nodeId: 'video', nodeStartedAt: 990_000 });
    expect(findElement(timing, (element) => element.props.children === '已等待 02:00')).toBeTruthy();
    expect(findElement(timing, (element) => element.props.children === '本节点 00:10')).toBeTruthy();
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    store.nodes[0].data.videoTaskState = 'paused';
    store.nodes[0].data.status = 'idle';
    now.mockReturnValue(1_060_000);
    expect(findElement(GenerationWaitTime({ nodeId: 'video' }), (element) => element.props.children === '已等待 03:00')).toBeTruthy();
  });

  it('NodeContextMenu exposes character capture only when the callback is available', async () => {
    await installReactHookDriver();
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 });
    const { NodeContextMenu } = await import('../../src/components/canvas/NodeContextMenu');
    const baseProps = {
      visible: true,
      position: { x: 10, y: 10 },
      menuRef: { current: null },
      onCopy: vi.fn(),
      onCut: vi.fn(),
      onDuplicate: vi.fn(),
      onToggleLock: vi.fn(),
      isLocked: false,
      onDelete: vi.fn(),
    };

    const withCapture = NodeContextMenu({ ...baseProps, onAddToCharacter: vi.fn() });
    expect(findElement(
      withCapture,
      (element) => element.type === 'span' && element.props.children === '添加到角色库…',
    )).toBeTruthy();

    const withoutCapture = NodeContextMenu(baseProps);
    expect(() => findElement(
      withoutCapture,
      (element) => element.type === 'span' && element.props.children === '添加到角色库…',
    )).toThrow('Element not found');
  });

  it('ImageNode cancels a pending crop when the canvas revision changes', async () => {
    let revision = 1;
    const store = createStore([{
      id: 'image-source',
      type: 'ai-image',
      position: { x: 20, y: 30 },
      data: { type: 'ai-image', label: 'Source image', imageUrl: 'data:image/png;base64,source' },
    }], () => revision);
    const saveResult = deferred<{ assetUrl: string; filePath: string }>();

    // 强制打开裁切编辑器：按 ImageNode 里 useState 的声明顺序数，isCrop 是第 7 个（下标 6）。
    // 在它之前增删 useState 会让本用例找不到裁切编辑器，届时按声明顺序重新数一次。
    const IS_CROP_STATE_INDEX = 6;
    await installReactHookDriver((initialValue, index) => (
      index === IS_CROP_STATE_INDEX ? true : initialValue
    ));
    installStoreMock(store);
    installCommonNodeMocks();
    vi.doMock('../../src/components/nodes/shared/image/CropEditor', () => ({
      default: function CropEditorMock() { return null; },
    }));
    vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({
      computeImageNodeDimensions: vi.fn().mockResolvedValue({ nodeWidth: 200, nodeHeight: 120 }),
    }));
    vi.doMock('../../src/services/fileService', () => ({
      buildNodeFileName: () => 'crop.png',
      saveDataUrlToProjectData: vi.fn(() => saveResult.promise),
    }));
    vi.doMock('../../src/services/clipboardService', () => ({ copyImage: vi.fn() }));
    vi.doMock('../../src/services/apimartService', () => ({ generateOutpaintImage: vi.fn() }));
    vi.doMock('../../src/services/onnxService', () => ({
      imageUpscale: vi.fn(), subjectMatting: vi.fn(), checkModelExists: vi.fn(), downloadModel: vi.fn(),
    }));
    vi.doMock('../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
    vi.doMock('../../src/store/store.utils', () => ({ blobToDataUrl: vi.fn() }));
    vi.doMock('../../src/components/nodes/shared/toolbar/presetAction', () => ({ createPresetNode: vi.fn() }));

    const ImageNode = (await import('../../src/components/nodes/ImageNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = ImageNode({ id: 'image-source', data: store.nodes[0].data, selected: true });
    // CropEditor 已改为 lazy 加载，而本文件的 react stub 把所有 lazy 统一换成
    // LazyComponentMock，按组件名找不到它。几个编辑器都是条件渲染，本用例只打开了
    // 裁切，按裁切编辑器特有的 onStart + onSave 回调定位比按组件名更稳。
    const cropEditor = findElement(tree, (element) => (
      typeof element.props.onStart === 'function'
      && typeof element.props.onSave === 'function'
    ));

    (cropEditor.props.onStart as () => void)();
    expect(store.nodes.map((node) => node.id)).toContain('node-generated');

    const completion = (cropEditor.props.onSave as (url: string) => Promise<void>)('data:image/png;base64,crop');
    await vi.waitFor(() => expect(store.nodes).toHaveLength(2));
    revision = 2;
    saveResult.resolve({ assetUrl: 'asset://crop.png', filePath: 'data/crop.png' });
    await completion;

    expect(store.nodes.map((node) => node.id)).toEqual(['image-source']);
    expect(store.updateNodeDataTransient).not.toHaveBeenCalledWith(
      'node-generated',
      expect.objectContaining({ status: 'success' }),
    );
    expect(store.showToast).not.toHaveBeenCalledWith('裁切完成，已创建新节点');
  },
  // 该用例要 doMock 十余个模块并驱动 React hook，单跑约 2~3 秒；
  // 全量并发时会被调度拖慢，默认 5s 超时不够用，这里放宽到 20s 避免偶发失败。
  20_000);

  it('VideoNode does not create a frame node after its derivation becomes stale', async () => {
    let revision = 1;
    const dimensions = deferred<{ nodeWidth: number; nodeHeight: number }>();
    const store = createStore([{
      id: 'video-source',
      type: 'ai-video',
      position: { x: 20, y: 30 },
      data: { type: 'ai-video', label: 'Source video', videoUrl: 'asset://video.mp4' },
    }], () => revision);

    await installReactHookDriver();
    installCommonNodeMocks();
    const useAppStore = Object.assign(
      <T,>(selector: (state: TestStore) => T) => selector(store),
      { getState: () => store },
    );
    vi.doMock('../../src/store/useAppStore', () => ({
      generateId: () => 'frame',
      computeImageNodeDimensions: () => dimensions.promise,
      useAppStore,
    }));
    vi.doMock('../../src/components/nodes/shared/VideoNodeToolbar', () => ({
      default: function VideoNodeToolbarMock() { return null; },
    }));
    vi.doMock('../../src/components/shared/VideoPlayer', () => ({
      default: function VideoPlayerMock() { return null; },
    }));
    vi.doMock('../../src/services/fileService', () => ({
      buildNodeFileName: () => 'frame.png',
      saveDataUrlToProjectData: vi.fn(),
      downloadUrlAndSave: vi.fn(),
    }));
    vi.doMock('../../src/services/clipboardService', () => ({ copyFile: vi.fn() }));
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => 'data:image/png;base64,frame',
      }),
    });

    const VideoNode = (await import('../../src/components/nodes/VideoNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    store.selectedNodeIds = ['video-source'];
    const tree = VideoNode({ id: 'video-source', data: store.nodes[0].data, selected: true });
    const video = findElement(tree, (element) => componentName(element) === 'VideoPlayerMock' && element.props.compact === true);
    const toolbar = findElement(tree, (element) => componentName(element) === 'VideoNodeToolbarMock');
    (video.props.mediaRef as (video: unknown) => void)({
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 12.5,
    });

    const completion = (toolbar.props.onCaptureFrame as () => Promise<void>)();
    revision = 2;
    dimensions.resolve({ nodeWidth: 280, nodeHeight: 158 });
    await completion;

    expect(store.addNode).not.toHaveBeenCalled();
    expect(store.showToast).not.toHaveBeenCalledWith('已截取当前帧为图像节点', 'success');
  });

  it('StoryboardNode rolls back its placeholder and extracted flag after a revision race', async () => {
    let revision = 1;
    const cropResult = deferred<{ dataUrl: string; width: number; height: number }>();
    const source: TestNode = {
      id: 'storyboard',
      type: 'ai-storyboard',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-storyboard',
        label: 'Storyboard',
        imageUrl: 'data:image/png;base64,board',
        storyboardRows: 1,
        storyboardCols: 1,
        storyboardExtracted: [false],
      },
    };
    const store = createStore([source], () => revision);
    const documentListeners = new Map<string, (event: Record<string, unknown>) => void>();

    await installReactHookDriver((initialValue, index) => index === 0 ? true : initialValue);
    installStoreMock(store);
    installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({
      Handle: function HandleMock() { return null; },
      Position: { Left: 'left', Right: 'right' },
      useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
    }));
    vi.doMock('../../src/components/nodes/shared/image/imageUtils', () => ({
      cropImageCell: vi.fn(() => cropResult.promise),
      cropImageByRanges: vi.fn(),
      computeImageNodeDimensions: vi.fn().mockResolvedValue({ nodeWidth: 200, nodeHeight: 200 }),
    }));
    vi.doMock('../../src/services/fileService', () => ({
      buildNodeFileName: () => 'cell.png',
      saveDataUrlToProjectData: vi.fn().mockResolvedValue(null),
    }));
    vi.stubGlobal('document', {
      body: {},
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        documentListeners.set(type, listener);
      },
      removeEventListener: (type: string) => { documentListeners.delete(type); },
    });

    const StoryboardNode = (await import('../../src/components/nodes/StoryboardNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = StoryboardNode({ id: 'storyboard', data: source.data, selected: true });
    const cell = findElement(tree, (element) => element.props['data-sb-cell-idx'] === 0);
    (cell.props.onPointerDown as (event: Record<string, unknown>) => void)({
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    documentListeners.get('pointerup')?.({ clientX: 20, clientY: 20 });

    await vi.waitFor(() => {
      expect(store.nodes.map((node) => node.id)).toContain('node-generated');
    });
    expect(store.nodes.find((node) => node.id === 'storyboard')?.data.storyboardExtracted).toEqual([true]);

    revision = 2;
    cropResult.resolve({ dataUrl: 'data:image/png;base64,cell', width: 100, height: 100 });
    await vi.waitFor(() => {
      expect(store.nodes.map((node) => node.id)).toEqual(['storyboard']);
    });
    expect(store.nodes[0].data.storyboardExtracted).toEqual([false]);
  });

  it('ShotlistNode keeps a drag surface even though every cell is a nodrag input', async () => {
    // 表体的输入框必须带 nodrag 才能编辑文字，于是整张表都拖不动节点。
    // 工具带和表头是仅剩的抓手，谁给它们加上 nodrag，这个节点就彻底钉死在画布上了。
    const shotlist: TestNode = {
      id: 'shotlist',
      type: 'ai-shotlist',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-shotlist',
        label: '第一场',
        shotlistRows: [{ id: 'row-1', shotNo: '1', content: '警察松动警戒线', duration: 3 }],
      },
    };
    const store = createStore([shotlist], () => 1);

    await installReactHookDriver();
    installStoreMock(store);
    installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({
      Handle: function HandleMock() { return null; },
      Position: { Left: 'left', Right: 'right' },
      useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn() }),
    }));
    await installShotlistTimelineMock();

    const ShotlistNode = (await import('../../src/components/nodes/ShotlistNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = ShotlistNode({ id: 'shotlist', data: shotlist.data, selected: false });

    const toolbar = findElement(tree, (element) => (
      typeof element.props.className === 'string'
      && element.props.className.includes('shotlist-toolbar')
      && !element.props.className.includes('actions')
    ));
    expect(toolbar.props.className).not.toContain('nodrag');

    // 按钮区反过来必须挡住拖拽，否则点「推送时间轴」会变成拽着节点跑
    const actions = findElement(tree, (element) => (
      typeof element.props.className === 'string'
      && element.props.className.includes('shotlist-toolbar-actions')
    ));
    expect(actions.props.className).toContain('nodrag');

    // 单元格输入必须保留 nodrag，否则选中文字就变成拖节点
    const input = findElement(tree, (element) => (
      typeof element.props.className === 'string'
      && element.props.className.includes('shot-input')
    ));
    expect(input.props.className).toContain('nodrag');
  });

  it('GroupNode batches only direct children, keeps empty groups renderable, and records resize history', async () => {
    const group: TestNode = {
      id: 'group-a',
      type: 'group',
      position: { x: 0, y: 0 },
      data: { groupId: 'group-data-a', color: '#ffffff', label: 'Group A' },
    };
    const store = createStore([
      group,
      { id: 'direct', type: 'ai-image', parentId: 'group-a', position: { x: 0, y: 0 }, data: { type: 'ai-image' } },
      { id: 'nested', type: 'ai-image', parentId: 'direct', position: { x: 0, y: 0 }, data: { type: 'ai-image' } },
      { id: 'external', type: 'ai-image', parentId: 'group-b', position: { x: 0, y: 0 }, data: { type: 'ai-image' } },
    ], () => 1);
    const batchExecuteNodes = vi.fn().mockResolvedValue({ ok: 1, fail: 0 });

    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('@xyflow/react', () => ({
      NodeResizer: function NodeResizerMock() { return null; },
      Handle: function HandleMock() { return null; },
      Position: { Left: 'left', Right: 'right' },
    }));
    vi.doMock('@iconify/react', () => ({ Icon: function IconMock() { return null; } }));
    vi.doMock('../../src/components/shared/AnimatedButton', () => ({
      default: function AnimatedButtonMock() { return null; },
    }));
    vi.doMock('../../src/utils/batchExecute', () => ({ batchExecuteNodes }));

    const GroupNode = (await import('../../src/components/nodes/GroupNode')).default as unknown as (
      props: { id: string; data: Record<string, unknown>; selected: boolean },
    ) => unknown;
    const tree = GroupNode({ id: 'group-a', data: group.data, selected: true });
    const resizer = findElement(tree, (element) => componentName(element) === 'NodeResizerMock');
    const batchButton = findElement(tree, (element) => componentName(element) === 'AnimatedButtonMock'
      && String(element.props.className ?? '').includes('hover:text-green-300'));

    (resizer.props.onResizeStart as () => void)();
    (resizer.props.onResizeEnd as () => void)();
    await (batchButton.props.onClick as () => Promise<void>)();

    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
    expect(store.settleGroupMembersOnResizeEnd).toHaveBeenCalledWith('group-a');
    expect(batchExecuteNodes).toHaveBeenCalledWith(
      ['direct'],
      store.nodes,
      store.edges,
      expect.objectContaining({ currentProjectId: 'project-a' }),
    );
    store.nodes = [group];
    expect(GroupNode({ id: 'group-a', data: group.data, selected: false })).not.toBeNull();
  });

  it.each([
    { runtime: 'lightweight-web', expanded: false }, { runtime: 'lightweight-web', expanded: true },
    { runtime: 'blender', expanded: false }, { runtime: 'blender', expanded: true },
    { runtime: undefined, expanded: false }, { runtime: undefined, expanded: true },
  ])('hides director input in runtime=$runtime, expanded=$expanded, including a live runtime switch', async ({ runtime, expanded }) => {
    const store = createStore([{
      id: 'director', type: 'ai-director', position: { x: 0, y: 0 },
      data: { type: 'ai-director', directorRuntimeKind: 'ai-threejs', status: 'idle' },
    }], () => 1);
    store.activeNodeId = 'director';
    const layoutEffects: Array<() => void | (() => void)> = [];
    await installReactHookDriver((initial, index) => index === 0 ? expanded : initial, undefined, layoutEffects);
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => [], resumeComfyUINodeTask: vi.fn(), resumeRunningHubNodeTask: vi.fn(),
      updatePendingTask: vi.fn(), removePendingTask: vi.fn(),
    }));
    const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    expect(findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock')).toBeDefined();
    for (const status of ['idle', 'loading', 'success', 'error']) {
      store.nodes[0].data = { ...store.nodes[0].data, directorRuntimeKind: runtime, status, imageUrl: 'frame.png', model: 'general/text', provider: 'general' };
      layoutEffects.length = 0;
      expect(AINodeDialog()).toBeNull();
      layoutEffects[0]();
    }
    expect(store.closeNodeDialog).toHaveBeenCalledTimes(4);
  });

  describe('source image generation', () => {
    afterEach(() => {
      vi.doUnmock('../../src/services/ai/mediaModelCapabilities');
      vi.doUnmock('../../src/services/projectSettingsService');
    });

    it.each([
      { type: 'source-image', entry: 'dialog' }, { type: 'source-image', entry: 'toolbar' },
      { type: 'ai-image', entry: 'dialog' }, { type: 'ai-image', entry: 'toolbar' },
    ].flatMap((entry) => ['9:16', undefined].map((aspectRatio) => ({ ...entry, aspectRatio }))))(
      'uses image models for $type through $entry while preserving ratio $aspectRatio and source identity', async ({ type, entry, aspectRatio }) => {
      const store = createStore([{
        id: 'imported-image', type, position: { x: 12, y: 34 },
        data: { type, label: '上传图片', role: 'source', status: 'success',
          imageUrl: 'asset://original.png', filePath: 'original.png', assetId: 'original-asset',
          dramaAssetId: 'character-1', prompt: '@{reference:参考图} 重绘',
          aspectRatio, nodeWidth: 158, nodeHeight: 280,
          model: 'old-model', provider: 'general' },
      }], () => 1);
      store.activeNodeId = 'imported-image';
      const generateImage = vi.fn().mockResolvedValue({ url: 'https://example.com/result.png', width: 768, height: 1024 });
      const generateText = vi.fn();
      const resolveProjectGenerationPrompt = vi.fn(
        ({ prompt, data }: { prompt: string; data: Record<string, unknown> }) => `${data.type}:${prompt}`,
      );
      await installReactHookDriver();
      installStoreMock(store);
      vi.doUnmock('../../src/services/generationService');
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
      vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({
        default: function PromptPanelMock() { return null; },
      }));
      vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../src/services/aiService', () => ({
        generateText, generateImage, generateImagesBatch: vi.fn(), generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn(),
      }));
      vi.doMock('../../src/services/fileService', () => ({
        persistMediaUrlToProjectData: vi.fn(async (url: string) => ({ mediaUrl: url, sourceUrl: url, filePath: 'result.png' })),
      }));
      vi.doMock('../../src/services/ai/mediaModelCapabilities', async () => ({
        ...await vi.importActual<typeof import('../../src/services/ai/mediaModelCapabilities')>('../../src/services/ai/mediaModelCapabilities'),
        resolveImageParameterCapability: () => ({ resolutions: ['1K'], defaultResolution: '1K', ratios: ['3:4', '9:16', '1:1'], defaultRatio: '3:4',
          qualities: ['low', 'high'], defaultQuality: 'high', backgrounds: ['auto', 'opaque', 'transparent'] }),
      }));
      vi.doMock('../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../src/services/projectSettingsService')>('../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt,
        getImageNodeDimensionsForAspectRatio: () => ({ nodeWidth: 210, nodeHeight: 280 }),
        getProjectModelKind: (nodeType: string) => nodeType === 'ai-image' ? 'image' : null,
        parseProjectModelRef: (model: string | undefined) => model ? { model, provider: 'general' } : null,
      }));
      vi.doMock('../../src/services/pollManager', () => ({
        ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
        prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn(),
      }));

      const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
      expect(panel.props.nodeType).toBe('ai-image');
      expect(panel.props.onPassThrough).toBeUndefined();
      (panel.props.onModelSelect as (model: Record<string, unknown>) => void)({
        value: 'general/image-model', provider: 'general', label: 'Image model',
      });
      expect(store.nodes[0].data).toMatchObject({
        type, role: 'source', model: 'general/image-model', imageSize: '1K', aspectRatio, imageQuality: 'high',
        nodeWidth: 158, nodeHeight: 280,
        imageUrl: 'asset://original.png', filePath: 'original.png', assetId: 'original-asset', dramaAssetId: 'character-1',
      });
      (panel.props.onChangeImageQuality as (quality: string) => void)('low');
      (panel.props.onChangeImageBackground as (background: string) => void)('transparent');
      if (entry === 'dialog') await (panel.props.onSubmit as () => Promise<void>)();
      else {
        const { executeGeneration } = await import('../../src/services/generationService');
        expect(await executeGeneration('imported-image')).toEqual({ success: true });
      }
      expect(resolveProjectGenerationPrompt).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ type: 'ai-image', role: 'source' }),
      }));
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: 'imported-image', model: 'general/image-model', provider: 'general',
        prompt: 'ai-image:@{reference:参考图} 重绘', imageSize: '1K', aspectRatio: aspectRatio ?? '1:1', imageQuality: 'low', imageBackground: 'transparent',
      }));
      expect(generateText).not.toHaveBeenCalled();
      expect(store.nodes[0]).toMatchObject({ id: 'imported-image', type, position: { x: 12, y: 34 },
        data: { type, role: 'source', assetId: 'original-asset', dramaAssetId: 'character-1',
          status: 'success', imageUrl: 'https://example.com/result.png' } });
      expect(store.recordOutputHistory).toHaveBeenCalledWith('imported-image', expect.objectContaining({
        nodeType: 'ai-image', params: expect.objectContaining({ imageQuality: 'low', imageBackground: 'transparent' }),
      }));
    });
  });

  describe('AINodeDialog image quality', () => {
    afterEach(() => {
      for (const module of [
        '../../src/services/ai/mediaModelCapabilities', '../../src/services/projectSettingsService',
        '../../src/services/imageBatchService', '../../src/services/pollManager',
      ]) vi.doUnmock(module);
    });

    async function setupImageQualityDialog(batchCount = 1) {
      const store = createStore([{
        id: 'quality-image', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '图片', status: 'idle', prompt: 'cat',
          model: 'general/model-a', provider: 'general', imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent', batchCount,
          nodeWidth: 280, nodeHeight: 158 },
      }], () => 1);
      store.activeNodeId = 'quality-image';
      const generateImage = vi.fn().mockResolvedValue({ url: 'https://example.com/result.png', width: 1024, height: 1024 });
      const generateImagesBatch = vi.fn().mockResolvedValue({ results: [{ url: 'https://example.com/result.png' }] });
      const applyImageBatchResults = vi.fn().mockResolvedValue(true);
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
      vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
      vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../src/services/aiService', () => ({
        generateText: vi.fn(), generateImage, generateImagesBatch, generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn(),
      }));
      vi.doMock('../../src/services/fileService', () => ({
        persistMediaUrlToProjectData: vi.fn(async (url: string) => ({ mediaUrl: url, sourceUrl: url, filePath: 'result.png' })),
      }));
      vi.doMock('../../src/services/ai/mediaModelCapabilities', () => ({
        resolveImageParameterCapability: (model: string) => model === 'general/model-compatible'
          ? { resolutions: ['1K', '2k', '4K'], defaultResolution: '1K', ratios: ['1:1', '16:9', '9:16', 'auto'], defaultRatio: '1:1',
            qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto',
            backgrounds: ['auto', 'opaque', 'transparent'], defaultBackground: 'opaque' }
          : model === 'general/model-restricted'
          ? { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1',
            qualities: ['low', 'medium', 'high'], defaultQuality: 'medium', backgrounds: ['auto', 'opaque'], defaultBackground: 'opaque' }
          : model === 'general/model-fixed'
          ? { resolutions: ['2K'], defaultResolution: '2K', ratios: ['16:9'], defaultRatio: '16:9',
            qualities: ['high'], defaultQuality: 'high', backgrounds: ['transparent'], defaultBackground: 'transparent', backgroundIsFixed: true }
          : ['general/model-b', 'general/model-c'].includes(model)
          ? { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1', '16:9', '9:16'], defaultRatio: '1:1',
            qualities: ['low', 'medium', 'high'], defaultQuality: 'medium', backgrounds: ['auto', 'opaque', 'transparent'],
            defaultBackground: model === 'general/model-c' ? 'opaque' : undefined }
          : undefined,
      }));
      vi.doMock('../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../src/services/projectSettingsService')>('../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => prompt,
        getImageNodeDimensionsForAspectRatio: () => ({ nodeWidth: 280, nodeHeight: 280 }),
      }));
      vi.doMock('../../src/services/pollManager', () => ({
        ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
        prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn(),
      }));
      vi.doMock('../../src/services/imageBatchService', () => ({
        prepareImageBatchNodes: () => ({ nodeIds: ['quality-image', 'batch-image'] }),
        applyImageBatchResults, failImageBatchNodes: vi.fn(),
      }));
      const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = () => findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
      return { store, panel, generateImage, generateImagesBatch, applyImageBatchResults };
    }

    it('adjusts only incompatible quality while retaining compatible background, ratio and dimensions', async () => {
      const { store, panel } = await setupImageQualityDialog();
      const select = (value: string) => (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value, provider: 'general' });
      select('general/model-a');
      expect(store.nodes[0].data.imageQuality).toBe('max');
      expect(store.nodes[0].data.imageBackground).toBe('transparent');
      select('general/model-b');
      expect(store.nodes[0].data.imageQuality).toBe('medium');
      expect(store.nodes[0].data.imageBackground).toBe('transparent');
      (panel().props.onChangeImageBackground as (background: string) => void)('transparent');
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
      (panel().props.onChangeAspectRatio as (ratio: string) => void)('9:16');
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '9:16', nodeWidth: 280, nodeHeight: 280 });
      (panel().props.onChangeImageQuality as (quality: string) => void)('high');
      expect(store.nodes[0].data.imageQuality).toBe('high');
      select('general/model-a');
      expect(store.nodes[0].data.imageQuality).toBeUndefined();
      expect(store.nodes[0].data.imageBackground).toBeUndefined();
      expect(store.nodes[0].data.aspectRatio).toBe('9:16');
      select('general/model-b');
      (panel().props.onChangeImageBackground as (background: string) => void)('transparent');
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)('workflow-1');
      expect(store.nodes[0].data.imageQuality).toBeUndefined();
      expect(store.nodes[0].data.imageBackground).toBeUndefined();
      select('general/model-b');
      expect(store.nodes[0].data.imageQuality).toBe('medium');
      (panel().props.onChangeImageBackground as (background: string) => void)('transparent');
      (panel().props.onClearModel as () => void)();
      expect(store.nodes[0].data.imageQuality).toBeUndefined();
      expect(store.nodes[0].data.imageBackground).toBeUndefined();
    });

    it.each([
      { imageSize: '2K', imageQuality: 'xhigh', imageBackground: 'transparent', aspectRatio: '16:9' },
      { imageSize: '4K', imageQuality: 'max', imageBackground: '', aspectRatio: '9:16' },
      { imageSize: '2k', imageQuality: 'high', imageBackground: 'opaque', aspectRatio: '自适应' },
    ])('keeps compatible image parameters through the real menu callback sequence: $imageQuality / $imageBackground', async (parameters) => {
      const { store, panel } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, parameters);
      const dimensions = { nodeWidth: store.nodes[0].data.nodeWidth, nodeHeight: store.nodes[0].data.nodeHeight };
      const callbacks = panel().props;
      (callbacks.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (callbacks.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ ...parameters, ...dimensions, model: 'general/model-compatible' });
      expect(store.updateNodeData).toHaveBeenCalledTimes(1);
      // 重选同一型号并再次通知清空工作流，也不能覆盖已选参数。
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ ...parameters, ...dimensions });
    });

    it('falls back only unsupported values and updates dimensions only for an incompatible ratio', async () => {
      const { store, panel } = await setupImageQualityDialog();
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-restricted', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '1K', imageQuality: 'medium', imageBackground: 'opaque',
        aspectRatio: '1:1', nodeWidth: 280, nodeHeight: 280 });
    });

    it('clears workflow execution fields once without resetting compatible image parameters', async () => {
      const { store, panel } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, { workflowId: 'previous-workflow', workflowInputs: { prompt: 'old workflow input' },
        workflowApiOutputs: [{ url: 'https://example.com/old.png', kind: 'image' }], workflowApiStage: '已完成', comfyRefmods: [] });
      const callbacks = panel().props;
      (callbacks.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (callbacks.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ workflowId: undefined, workflowInputs: undefined,
        workflowApiOutputs: undefined, workflowApiStage: undefined, comfyRefmods: undefined,
        imageSize: '2K', imageQuality: 'max', imageBackground: 'transparent', aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
      expect(store.updateNodeData).toHaveBeenCalledTimes(1);
    });

    it('honors a fixed background contract while retaining the compatible resolution and ratio', async () => {
      const { store, panel } = await setupImageQualityDialog();
      store.nodes[0].data.imageBackground = '';
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-fixed', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '2K', imageQuality: 'high', imageBackground: 'transparent',
        aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
    });

    it('does not initialize an unset ratio or discard explicit API-default background on a model change', async () => {
      const { store, panel } = await setupImageQualityDialog();
      Object.assign(store.nodes[0].data, { aspectRatio: undefined, imageBackground: '' });
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-compatible', provider: 'general' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '2K', imageQuality: 'max', imageBackground: '',
        aspectRatio: undefined, nodeWidth: 280, nodeHeight: 158 });
    });

    it('keeps a compatible Dreamina resolution when selecting an OAuth image model', async () => {
      const { store, panel } = await setupImageQualityDialog();
      (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'dreamina/3.0', provider: 'dreamina' });
      (panel().props.onWorkflowSelect as (id: string | undefined) => void)(undefined);
      expect(store.nodes[0].data).toMatchObject({ imageSize: '2K', imageQuality: undefined, imageBackground: undefined,
        aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
    });

    it.each([
      { count: 1, quality: undefined, expected: 'medium' }, { count: 1, quality: 'high', expected: 'high' },
      { count: 2, quality: undefined, expected: 'medium' }, { count: 2, quality: 'high', expected: 'high' },
    ])('passes effective quality $expected through submission/history for batch count $count', async ({ count, quality, expected }) => {
      const { store, panel, generateImage, generateImagesBatch, applyImageBatchResults } = await setupImageQualityDialog(count);
      const currentPanel = panel();
      (currentPanel.props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-b', provider: 'general' });
      (currentPanel.props.onChangeImageQuality as (quality: string | undefined) => void)(quality);
      await (currentPanel.props.onSubmit as () => Promise<void>)();
      if (count === 1) {
        expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: expected }));
        expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({
          params: expect.objectContaining({ imageQuality: expected }),
        }));
      } else {
        expect(generateImagesBatch).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: expected }), 2);
        expect(applyImageBatchResults).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: expected }));
      }
    });

    it('omits stale quality when the selected model has no quality capability', async () => {
      const { store, panel, generateImage } = await setupImageQualityDialog();
      await (panel().props.onSubmit as () => Promise<void>)();
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: undefined, imageBackground: undefined }));
      expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({
        params: expect.objectContaining({ imageQuality: undefined, imageBackground: undefined }),
      }));
    });

    it.each([1, 2].flatMap((count) => (count === 1 ? ['dialog', 'toolbar', 'selection'] : ['dialog', 'toolbar']).flatMap((entry) => (
      [undefined, 'transparent', ''].map((background) => ({ count, entry, background }))
    ))))('passes background $background through $entry with batch count $count while history keeps the effective value', async ({ count, entry, background }) => {
      const { store, panel, generateImage, generateImagesBatch, applyImageBatchResults } = await setupImageQualityDialog(count);
      const currentPanel = panel();
      (currentPanel.props.onModelSelect as (model: Record<string, unknown>) => void)({ value: 'general/model-c', provider: 'general' });
      expect(store.nodes[0].data.imageBackground).toBe('transparent');
      (currentPanel.props.onChangeImageBackground as (value: string | undefined) => void)(background);
      const effective = background === '' ? undefined : background ?? 'opaque';
      const requested = background === '' ? '' : effective;
      if (entry === 'dialog') await (currentPanel.props.onSubmit as () => Promise<void>)();
      else if (entry === 'toolbar') {
        vi.doUnmock('../../src/services/generationService');
        const { executeGeneration } = await import('../../src/services/generationService');
        expect(await executeGeneration('quality-image')).toEqual({ success: true });
      } else {
        vi.doUnmock('../../src/services/generationService');
        vi.doUnmock('../../src/utils/batchExecute');
        const { batchExecuteNodes } = await import('../../src/utils/batchExecute');
        expect(await batchExecuteNodes(['quality-image'], store.nodes as unknown as Parameters<typeof batchExecuteNodes>[1], [], {
          commitToHistory: store.commitToHistory, currentProjectId: store.currentProjectId,
        })).toEqual({ ok: 1, fail: 0, skipped: 0 });
      }
      if (count === 1) {
        expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ imageBackground: requested, aspectRatio: '16:9' }));
        expect(store.recordOutputHistory).toHaveBeenCalledWith('quality-image', expect.objectContaining({
          params: expect.objectContaining({ imageBackground: effective }),
        }));
      } else {
        expect(generateImagesBatch).toHaveBeenCalledWith(expect.objectContaining({ imageBackground: requested, aspectRatio: '16:9' }), 2);
        expect(applyImageBatchResults).toHaveBeenCalledWith(expect.objectContaining({ imageBackground: effective }));
      }
      expect(store.nodes[0].data).toMatchObject({ aspectRatio: '16:9', nodeWidth: 280, nodeHeight: 158 });
    });
  });

  it.each([
    { catalogId: 'libapi', customized: false, adapted: true },
    { catalogId: 'custom-openai', customized: false, adapted: false },
    { catalogId: 'libapi', customized: true, adapted: false },
  ])('音频模型切换仅清理真实 LibAPI 完整合同的不适用参数（$catalogId / 自定义协议 $customized）', async ({ catalogId, customized, adapted }) => {
    const { LIBAPI_MODEL_MANIFEST } = await import('../../src/services/ai/providers/libapiModelManifest');
    const selected = structuredClone(LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gm-3.1-flash-tts')!);
    if (customized) selected.executionProfile!.protocol!.submit.path = '/custom/audio';
    const store = createStore([{
      id: 'speech-node', type: 'ai-audio', position: { x: 0, y: 0 }, data: { type: 'ai-audio', label: '配音', status: 'idle',
        prompt: '你好', model: 'general/previous-audio', provider: 'general', audioVoice: 'alloy', audioFormat: 'wav', audioSpeed: 1,
        musicDuration: 60, musicBpm: 120, autoGenerateLyrics: true },
    }], () => 1);
    store.activeNodeId = 'speech-node';
    store.config = { ...store.config, providers: { 'audio-connection': { name: '音频连接', apiKey: 'fixture', catalogId } },
      generalModels: [{ id: 'selected-audio', name: selected.name, modelId: selected.id, category: 'audio',
        providerConfigId: 'audio-connection', executionProfile: selected.executionProfile }] };
    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../src/services/aiService', () => ({ generateText: vi.fn(), generateImage: vi.fn(), generateImagesBatch: vi.fn(),
      generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
    vi.doMock('../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
      prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn() }));
    const Dialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const panel = () => findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
    (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({
      value: 'general/selected-audio', provider: 'general', audioPurpose: 'speech',
    });
    expect(store.nodes[0].data.audioFormat).toBe('wav');
    if (adapted) {
      expect(store.nodes[0].data).toMatchObject({ audioVoice: undefined, audioSpeed: undefined,
        musicDuration: undefined, musicBpm: undefined, autoGenerateLyrics: undefined });
      expect(panel().props.audioVoice).toBeUndefined();
      expect(panel().props.audioSpeed).toBeUndefined();
    } else {
      expect(store.nodes[0].data).toMatchObject({ audioVoice: 'alloy', audioSpeed: 1,
        musicDuration: 60, musicBpm: 120, autoGenerateLyrics: true });
    }
  });

  it.each([
    { type: 'source-text', generationType: 'ai-text' },
    { type: 'ai-markdown', generationType: 'ai-text' },
    { type: 'source-video', generationType: 'ai-video' },
    { type: 'source-audio', generationType: 'ai-audio' },
  ].flatMap((item) => ['dialog', 'toolbar'].map((entry) => ({ ...item, entry }))))('routes $type through $entry while preserving the original node identity', async ({ type, generationType, entry }) => {
    const store = createStore([{
      id: 'source-node', type, position: { x: 12, y: 34 },
      data: { type, label: '原始素材', role: 'source', status: 'success', output: '原始正文',
        prompt: '参考 @{reference:原始素材} 生成', model: 'old-model', provider: 'general', assetId: 'asset-1' },
    }], () => 1);
    store.activeNodeId = 'source-node';
    const generateText = vi.fn().mockResolvedValue('生成后的文本');
    const generateVideo = vi.fn().mockResolvedValue({ url: 'https://example.com/result.mp4' });
    const generateAudio = vi.fn().mockResolvedValue({ url: 'https://example.com/result.mp3' });
    const generateImage = vi.fn();
    await installReactHookDriver(); installStoreMock(store);
    vi.doUnmock('../../src/services/generationService');
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../src/services/aiService', () => ({
      generateText, generateVideo, generateAudio, generateImage, generateImagesBatch: vi.fn(), buildPanoramaPrompt: vi.fn(),
    }));
    vi.doMock('../../src/services/fileService', () => ({
      persistMediaUrlToProjectData: vi.fn(async (url: string) => ({ mediaUrl: url, sourceUrl: url })),
    }));
    vi.doMock('../../src/services/ai/generateAudio', () => ({
      persistAudioGenerationResult: vi.fn(async ({ url }: { url: string }) => ({ mediaUrl: url, sourceUrl: url, outputUrl: url })),
    }));
    vi.doMock('../../src/services/projectSettingsService', async () => ({
      ...await vi.importActual<typeof import('../../src/services/projectSettingsService')>('../../src/services/projectSettingsService'),
      resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => prompt,
    }));
    vi.doMock('../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => [], prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(),
    }));
    const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const panel = findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
    expect(panel.props.nodeType).toBe(generationType);
    expect(typeof panel.props.onPassThrough).toBe(generationType === 'ai-text' ? 'function' : 'undefined');
    (panel.props.onModelSelect as (model: Record<string, unknown>) => void)({
      value: 'general/new-model', provider: 'general', label: '模型',
    });
    expect(store.nodes[0].data).toMatchObject({ type, role: 'source', output: '原始正文', model: 'general/new-model' });
    if (entry === 'dialog') await (panel.props.onSubmit as () => Promise<void>)();
    else {
      const { executeGeneration } = await import('../../src/services/generationService');
      expect(await executeGeneration('source-node')).toEqual({ success: true });
    }
    if (entry === 'dialog' && generationType === 'ai-video') {
      expect(confirmVideoReferencesBeforeGeneration).toHaveBeenCalledExactlyOnceWith('source-node', undefined);
    } else {
      expect(confirmVideoReferencesBeforeGeneration).not.toHaveBeenCalled();
    }
    const expectedGenerator = generationType === 'ai-text' ? generateText : generationType === 'ai-video' ? generateVideo : generateAudio;
    expect(expectedGenerator).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '参考 @{reference:原始素材} 生成', model: 'general/new-model', provider: 'general',
    }));
    expect([generateText, generateVideo, generateAudio].filter((generate) => generate.mock.calls.length)).toEqual([expectedGenerator]);
    expect(generateImage).not.toHaveBeenCalled();
    expect(store.nodes[0]).toMatchObject({ id: 'source-node', type, position: { x: 12, y: 34 },
      data: { type, role: 'source', assetId: 'asset-1', status: 'success' } });
    expect(store.recordOutputHistory).toHaveBeenCalledWith('source-node', expect.objectContaining({ nodeType: generationType }),
      ...(generationType === 'ai-video' ? [true] : []));
    vi.doUnmock('../../src/services/projectSettingsService');
  });

  describe('text asset extraction preserves source content on failure', () => {
    afterEach(() => { vi.doUnmock('../../src/services/projectSettingsService'); });

    async function setupExtraction(entry: 'dialog' | 'toolbar', kind: 'character' | 'scene' | 'prop', output = '原始剧本：阿青在旧车站捡到一枚铜钥匙。') {
      const type = kind === 'character' ? 'source-text' : kind === 'scene' ? 'ai-markdown' : 'ai-text';
      const store = createStore([{
        id: 'script-source', type, position: { x: 12, y: 34 },
        data: { type, label: '分镜执行单.md', role: 'source', status: 'success', output,
          prompt: '', model: 'general/text-model', provider: 'general', assetId: 'source-file' },
      }], () => 1);
      store.activeNodeId = 'script-source';
      const generateText = vi.fn().mockResolvedValue(JSON.stringify({ kind, items: [{ name: '提取资产', summary: '有效简介' }] }));
      await installReactHookDriver(); installStoreMock(store);
      vi.doUnmock('../../src/services/generationService');
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
      vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../src/services/aiService', () => ({ generateText, generateImage: vi.fn(), generateImagesBatch: vi.fn(),
        generateVideo: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
      vi.doMock('../../src/services/projectSettingsService', async () => ({
        ...await vi.importActual<typeof import('../../src/services/projectSettingsService')>('../../src/services/projectSettingsService'),
        resolveProjectGenerationPrompt: ({ prompt }: { prompt: string }) => `${prompt}\n\n项目附加提示词：简介要简洁。`,
      }));
      vi.doMock('../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [] }));
      const { getSlashCommands, fillTemplate } = await import('../../src/components/nodes/shared/slashCommands');
      const id = kind === 'character' ? 'text-extract-characters' : kind === 'scene' ? 'text-extract-scenes' : 'text-extract-props';
      const command = getSlashCommands('ai-text').find((item) => item.id === id)!;
      const prompt = fillTemplate(command.promptTemplate!, '');
      const submit = async () => {
        if (entry === 'toolbar') {
          const { executeGeneration } = await import('../../src/services/generationService');
          return executeGeneration('script-source', prompt);
        }
        const Dialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
        const panel = findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
        return (panel.props.onSubmit as (prompt: string) => Promise<void>)(prompt);
      };
      return { store, generateText, submit, output, type };
    }

    const extractionCases = (['character', 'scene', 'prop'] as const).flatMap((kind) => (
      (['dialog', 'toolbar'] as const).map((entry) => ({ kind, entry }))
    ));
    it.each(extractionCases.flatMap((item) => ['invalid-json', 'empty-items', 'request-error'].map((failure) => ({ ...item, failure }))))(
      'keeps $kind original content and failure history through $entry on $failure', async ({ kind, entry, failure }) => {
      const { store, generateText, submit, output, type } = await setupExtraction(entry, kind);
      if (failure === 'request-error') generateText.mockRejectedValueOnce(new Error('测试接口暂时不可用'));
      else generateText.mockResolvedValueOnce(failure === 'empty-items' ? JSON.stringify({ kind, items: [], notes: '未提供正文' }) : '这不是有效 JSON');
      const result = await submit();
      if (entry === 'toolbar') expect(result).toMatchObject({ success: false });
      expect(generateText).toHaveBeenCalledOnce();
      const sent = generateText.mock.calls[0][0].prompt as string;
      expect(sent).toContain(output);
      expect(sent.indexOf(output)).toBeLessThan(sent.indexOf('项目附加提示词'));
      expect(store.nodes[0]).toMatchObject({ id: 'script-source', type, position: { x: 12, y: 34 },
        data: { role: 'source', assetId: 'source-file', output, status: 'error', error: expect.any(String) } });
      expect(store.mergeDramaExtract).not.toHaveBeenCalled();
      expect(store.updateNodeData).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).toHaveBeenCalledExactlyOnceWith('script-source', expect.objectContaining({ status: 'error', output: '', error: expect.any(String) }));
      expect(store.showToast).toHaveBeenCalledWith(expect.any(String), 'error');
    });

    it.each(extractionCases)('fills $kind script and accepts a validated result through $entry', async ({ kind, entry }) => {
      const { store, generateText, submit, output, type } = await setupExtraction(entry, kind);
      await submit();
      expect(generateText).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[0][0].prompt).toContain(output);
      expect(store.nodes[0]).toMatchObject({ type, data: { role: 'source', assetId: 'source-file', status: 'success' } });
      expect(store.nodes[0].data.output).toContain('提取资产');
      expect(store.mergeDramaExtract).toHaveBeenCalledOnce();
      expect(store.recordOutputHistory).toHaveBeenCalledExactlyOnceWith('script-source', expect.objectContaining({ status: 'success', prompt: expect.stringContaining(output) }));
    });

    it.each(['dialog', 'toolbar'] as const)('rejects an empty source before requesting the model through %s', async (entry) => {
      const { store, generateText, submit } = await setupExtraction(entry, 'character', '');
      const result = await submit();
      if (entry === 'toolbar') expect(result).toMatchObject({ success: false });
      expect(generateText).not.toHaveBeenCalled();
      expect(store.nodes[0].data).toMatchObject({ output: '', status: 'error', error: expect.stringContaining('缺少剧本正文') });
      expect(store.mergeDramaExtract).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).toHaveBeenCalledWith('script-source', expect.objectContaining({ status: 'error' }));
    });
  });

  describe('AINodeDialog shared video generation', () => {
    afterEach(() => {
      vi.doUnmock('../../src/services/generationService');
    });

    it.each(['ai-video', 'source-video'].flatMap((type) => (
      ['submit', 'reference-cancel', 'project-switch', 'node-replaced', 'comfy-recovery'].map((scenario) => ({ type, scenario }))
    )))('delegates $type safely after loading the executor: $scenario', async ({ type, scenario }) => {
      const store = createStore([{
        id: 'video-node', type, position: { x: 0, y: 0 },
        data: { type, label: '视频', prompt: '旧提示词', model: 'general/video', provider: 'general' },
      }], () => 1);
      store.activeNodeId = 'video-node';
      const executeGeneration = vi.fn().mockResolvedValue({ success: true });
      await installReactHookDriver();
      installStoreMock(store);
      vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
      vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
      vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({
        default: function PromptPanelMock() { return null; },
      }));
      vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
      vi.doMock('../../src/services/pollManager', () => ({
        ...mockComfyDeliveries(),
        getPendingTasksForProject: () => scenario === 'comfy-recovery'
          ? [{ nodeId: 'video-node', taskType: 'comfyui', comfyRecoveryState: 'cancel_pending' }] : [],
      }));
      vi.doMock('../../src/services/generationService', () => ({
        executeGeneration, subscribeImageBatches: () => () => {}, isImageBatchGenerating: () => false,
        cancelImageBatchGeneration: vi.fn(), usesSequentialImageBatch: () => false,
      }));
      const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
      const panel = findElement(AINodeDialog(), (element) => componentName(element) === 'PromptPanelMock');
      const overridePrompt = '@{sheet/shot/stable-row:第1镜} 保留附加要求';
      if (scenario === 'reference-cancel') confirmVideoReferencesBeforeGeneration.mockResolvedValueOnce(false);
      const submission = (panel.props.onSubmit as (prompt: string) => Promise<void>)(overridePrompt);
      if (scenario === 'comfy-recovery') {
        await submission;
        expect(store.showToast).toHaveBeenCalledWith('该节点还有未确认结束的 ComfyUI 任务，请先继续查询或终止任务', 'error');
      } else {
        // onSubmit 已捕获原始节点；在动态 import 的 await 边界切换输入。
        if (scenario === 'project-switch') store.currentProjectId = 'project-b';
        if (scenario === 'node-replaced') {
          store.nodes[0] = { ...store.nodes[0], data: { ...store.nodes[0].data, prompt: '新提示词' } };
        }
        await submission;
      }
      if (scenario === 'submit') {
        expect(confirmVideoReferencesBeforeGeneration).toHaveBeenCalledExactlyOnceWith('video-node', overridePrompt);
        expect(executeGeneration).toHaveBeenCalledExactlyOnceWith('video-node', overridePrompt);
      } else {
        if (scenario === 'reference-cancel') {
          expect(confirmVideoReferencesBeforeGeneration).toHaveBeenCalledExactlyOnceWith('video-node', overridePrompt);
        } else {
          expect(confirmVideoReferencesBeforeGeneration).not.toHaveBeenCalled();
        }
        expect(executeGeneration).not.toHaveBeenCalled();
      }
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      expect(store.recordOutputHistory).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: '通用到通用', from: 'general/video-a', fromProvider: 'general', to: 'general/video-b', provider: 'general', ratio: '9:16' },
    { label: '通用到原生', from: 'general/video-a', fromProvider: 'general', to: 'volcengine/doubao-seedance-2-5', provider: 'volcengine', ratio: '9:16' },
    { label: '原生到通用', from: 'apimart/seedance-2.5', fromProvider: 'apimart', to: 'general/video-b', provider: 'general', ratio: '9:16' },
    { label: '原生到原生', from: 'volcengine/doubao-seedance-2-5', fromProvider: 'volcengine', to: 'dreamina/seedance2.5', provider: 'dreamina', ratio: '16:9' },
    { label: '未设比例到通用', from: 'general/video-a', fromProvider: 'general', to: 'general/video-b', provider: 'general', ratio: undefined },
    { label: '未设比例到原生', from: 'general/video-a', fromProvider: 'general', to: 'dreamina/seedance2.5', provider: 'dreamina', ratio: undefined },
    { label: '重选同一通用模型', from: 'general/video-a', fromProvider: 'general', to: 'general/video-a', provider: 'general', ratio: '9:16' },
    { label: '未设比例重选同一原生模型', from: 'volcengine/doubao-seedance-2-5', fromProvider: 'volcengine', to: 'volcengine/doubao-seedance-2-5', provider: 'volcengine', ratio: undefined },
    { label: '工作流转通用模型', from: 'comfyui/workflow-a', fromProvider: 'comfyui', to: 'general/video-b', provider: 'general', ratio: '9:16', workflowId: 'workflow-a' },
    { label: '未设置任何参数到原生', from: 'general/video-a', fromProvider: 'general', to: 'dreamina/seedance2.5', provider: 'dreamina', ratio: undefined, unsetParameters: true },
  ])('视频模型切换保留已有参数（$label）', async ({ from, fromProvider, to, provider, ratio, workflowId, unsetParameters }) => {
    const parameters = { videoResolution: unsetParameters ? undefined : 1280, videoFps: unsetParameters ? undefined : 30,
      videoFrames: unsetParameters ? undefined : 301, seedanceResolution: unsetParameters ? undefined : '1080p',
      seedanceDuration: unsetParameters ? undefined : 10, generateAudio: unsetParameters ? undefined : false };
    const store = createStore([{
      id: 'ratio-video', type: 'ai-video', position: { x: 0, y: 0 }, data: {
        type: 'ai-video', label: '比例保持', status: 'idle', prompt: '视频', model: from, provider: fromProvider,
        seedanceRatio: ratio, aspectRatio: ratio, nodeWidth: 280, nodeHeight: 498,
        ...parameters, workflowId,
      },
    }], () => 1);
    store.activeNodeId = 'ratio-video';
    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    const generateVideo = vi.fn();
    vi.doMock('../../src/services/aiService', () => ({ generateText: vi.fn(), generateImage: vi.fn(), generateImagesBatch: vi.fn(),
      generateVideo, generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn() }));
    vi.doMock('../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [],
      prepareMediaNodeGeneration: vi.fn(), registerMediaNodeOperation: () => vi.fn(), completeMediaNodeTask: vi.fn() }));
    const Dialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const panel = () => findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
    (panel().props.onModelSelect as (model: Record<string, unknown>) => void)({ value: to, provider });
    expect(store.nodes[0].data).toMatchObject({ model: to, provider, seedanceRatio: ratio,
      aspectRatio: ratio, nodeWidth: 280, nodeHeight: 498, workflowId: undefined,
      ...parameters });
    expect(panel().props.seedanceRatio).toBe(ratio);
    expect(panel().props.seedanceResolution).toBe(parameters.seedanceResolution);
    for (const key of ['seedanceRatio', ...Object.keys(parameters)]) {
      expect(store.updateNodeData.mock.calls.at(-1)?.[1]).not.toHaveProperty(key);
    }
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it('AINodeDialog submits the latest video parameters and resolved project prompt', async () => {
    const originalData = {
      type: 'ai-video',
      label: 'Video node',
      prompt: 'old prompt',
      model: 'old-model',
      provider: 'old-provider',
      videoResolution: 640,
      videoFps: 24,
      videoFrames: 77,
      seedanceResolution: '720p',
      seedanceRatio: '16:9',
      seedanceDuration: 5,
      generateAudio: false,
      style: 'old-style',
      cameraSettings: { lens: '85mm', aperture: 'f/2.8' },
    };
    const store = createStore([{
      id: 'video-node',
      type: 'ai-video',
      position: { x: 0, y: 0 },
      data: originalData,
    }], () => 1);
    store.activeNodeId = 'video-node';
    const generateVideo = vi.fn().mockResolvedValue({ url: 'https://example.com/result.mp4' });
    const resolveProjectGenerationPrompt = vi.fn(
      ({ prompt, data }: { prompt: string; data: Record<string, unknown> }) => `resolved:${prompt}:${data.style}`,
    );

    await installReactHookDriver();
    installStoreMock(store);
    vi.doUnmock('../../src/services/generationService');
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../src/services/aiService', () => ({
      generateText: vi.fn(),
      generateImage: vi.fn(),
      generateImagesBatch: vi.fn(),
      generateVideo,
      generateAudio: vi.fn(),
      buildPanoramaPrompt: vi.fn(),
    }));
    vi.doMock('../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
    vi.doMock('../../src/services/fileService', () => ({
      persistMediaUrlToProjectData: vi.fn(async (url: string) => ({
        mediaUrl: url,
        sourceUrl: url,
      })),
    }));
    vi.doMock('../../src/services/imageBatchService', () => ({ applyImageBatchResults: vi.fn() }));
    vi.doMock('../../src/services/onnxService', () => ({
      checkModelExists: vi.fn(), createCharacterDirectionGrid: vi.fn(), downloadModel: vi.fn(),
    }));
    vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../src/services/canvasViewportService', () => ({
      CANVAS_PAN_DURATION_MS: 200,
      requestCanvasPanBy: vi.fn(),
    }));
    vi.doMock('../../src/services/projectSettingsService', async () => ({
      ...await vi.importActual<typeof import('../../src/services/projectSettingsService')>('../../src/services/projectSettingsService'),
      resolveProjectGenerationPrompt,
    }));
    vi.doMock('../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => [],
      prepareVideoNodeGeneration: vi.fn(), completeVideoNodeTask: vi.fn(), pauseVideoNodeTask: vi.fn(),
      VideoPollingPausedError: class extends Error {},
    }));

    const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const tree = AINodeDialog();
    const promptPanel = findElement(tree, (element) => componentName(element) === 'PromptPanelMock');
    const changePrompt = promptPanel.props.onChange as (value: string, previousValue?: string) => void;
    // 后连线已经写入 Store，但编辑器还持有旧 DOM；继续输入不能抹掉新引用。
    store.updateNodeDataTransient('video-node', { prompt: 'old prompt @{image:新参考图} @{audio:新声音}' });
    changePrompt('正在编辑的内容', 'old prompt');
    expect(store.nodes[0].data.prompt).toBe('正在编辑的内容 @{image:新参考图} @{audio:新声音}');
    (promptPanel.props.onContinuousEditEnd as () => void)();
    expect(store.commitToHistory).not.toHaveBeenCalled();
    store.updateNodeDataTransient('video-node', { workflowInputs: { panelInput: '保留的面板参数' } });
    changePrompt('@wf{57:27|提示词|prompt}(修改后的内容)');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数', '57:27': '修改后的内容' });
    // 编辑器撤销标签内容时，正文与工作流参数一起恢复；面板输入保留。
    changePrompt('@wf{57:27|提示词|prompt}(原文)', '@wf{57:27|提示词|prompt}(修改后的内容)');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数', '57:27': '原文' });
    changePrompt('删除工作流标签');
    expect(store.nodes[0].data.workflowInputs).toEqual({ panelInput: '保留的面板参数' });
    expect(store.commitToHistory).not.toHaveBeenCalled();
    const editWrites = store.updateNodeDataTransient.mock.calls.length;
    store.currentProjectId = 'project-b';
    changePrompt('旧项目迟到的输入', '正在编辑的内容');
    expect(store.updateNodeDataTransient).toHaveBeenCalledTimes(editWrites);
    store.currentProjectId = 'project-a';
    (promptPanel.props.onModelSelect as (model: Record<string, unknown>) => void)({
      value: 'general/custom-video',
      label: 'Custom Video',
      provider: 'general',
    });
    expect(store.updateNodeData).toHaveBeenCalledWith('video-node', expect.objectContaining({
      model: 'general/custom-video',
      provider: 'general',
    }));
    expect(store.nodes[0].data).toMatchObject({ seedanceRatio: '16:9', seedanceResolution: '720p',
      videoResolution: 640, videoFps: 24, videoFrames: 77, seedanceDuration: 5, generateAudio: false });
    store.nodes[0] = {
      ...store.nodes[0],
      data: {
        ...originalData,
        prompt: 'latest prompt',
        model: 'latest-model',
        provider: 'latest-provider',
        videoResolution: 1280,
        videoFps: 30,
        videoFrames: 121,
        seedanceResolution: '1080p',
        seedanceRatio: '9:16',
        seedanceDuration: 10,
        generateAudio: true,
        style: 'latest-style',
        workflowId: 'workflow-video',
        workflowInputs: { motion: 9 },
      },
    };

    await (promptPanel.props.onSubmit as () => Promise<void>)();

    expect(resolveProjectGenerationPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'latest prompt',
      data: expect.objectContaining({ style: 'latest-style' }),
      settings: { styleReferenceId: 'style-project' },
      customStyles: store.customStyles,
    }));
    expect(generateVideo).toHaveBeenCalledWith({
      prompt: 'resolved:latest prompt:latest-style\n\nCamera settings: 85mm portrait lens, f/2.8 aperture, soft background separation.',
      model: 'latest-model',
      provider: 'latest-provider',
      videoResolution: 1280,
      videoFps: 30,
      videoFrames: 301,
      seedanceResolution: '1080p',
      seedanceRatio: '9:16',
      seedanceDuration: 10,
      generateAudio: true,
      workflowId: 'workflow-video',
      workflowInputs: { motion: 9 },
      nodeId: 'video-node',
    });
    expect(store.updateNodeData).toHaveBeenCalledWith('video-node', expect.objectContaining({
      videoUrl: 'https://example.com/result.mp4',
      status: 'success',
    }));
    expect(store.recordOutputHistory).toHaveBeenCalledWith('video-node', expect.objectContaining({
      params: expect.objectContaining({ cameraSettings: originalData.cameraSettings }),
    }), true);
  });

  it.each(['success', 'failure', 'project-switch'])('AINodeDialog ComfyUI stop and recovery: %s', async (outcome) => {
    const store = createStore([{
      id: 'image-node',
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        type: 'ai-image',
        label: 'Image node',
        prompt: 'cat',
        model: 'comfyui/workflow',
        provider: 'comfyui',
        workflowId: 'wf-1',
        status: 'loading',
      },
    }], () => 1);
    store.activeNodeId = 'image-node';
    let pendingTasks = [{ nodeId: 'image-node', taskId: 'prompt-1', taskType: 'comfyui', comfyRecoveryState: undefined as string | undefined }];
    const resumeComfyUINodeTask = vi.fn().mockResolvedValue(undefined);
    const generateImage = vi.fn();
    const cancelComfyUINodeTask = vi.fn(async () => {
      if (outcome === 'failure') {
        pendingTasks[0].comfyRecoveryState = 'cancel_pending';
        throw new Error('HTTP 503');
      }
      pendingTasks = [];
      if (outcome === 'project-switch') store.currentProjectId = 'project-b';
    });
    vi.doMock('../../src/services/pollManager', () => ({
      ...mockComfyDeliveries(),
      getPendingTasksForProject: () => pendingTasks,
      resumeComfyUINodeTask,
    }));

    await installReactHookDriver();
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
    vi.doMock('../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../src/services/aiService', () => ({
      generateText: vi.fn(),
      generateImage,
      generateImagesBatch: vi.fn(),
      generateVideo: vi.fn(),
      generateAudio: vi.fn(),
      buildPanoramaPrompt: vi.fn(),
    }));
    vi.doMock('../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
    vi.doMock('../../src/services/fileService', () => ({
      persistMediaUrlToProjectData: vi.fn(async (url: string) => ({
        mediaUrl: url,
        sourceUrl: url,
      })),
    }));
    vi.doMock('../../src/services/imageBatchService', () => ({ applyImageBatchResults: vi.fn() }));
    vi.doMock('../../src/services/onnxService', () => ({
      checkModelExists: vi.fn(), createCharacterDirectionGrid: vi.fn(), downloadModel: vi.fn(),
    }));
    vi.doMock('../../src/components/nodes/shared/defaultModels', () => ({ findMediaModelOption: vi.fn() }));
    vi.doMock('../../src/services/canvasViewportService', () => ({
      CANVAS_PAN_DURATION_MS: 200,
      requestCanvasPanBy: vi.fn(),
    }));
    vi.doMock('../../src/services/projectSettingsService', () => ({
      getImageNodeDimensionsForAspectRatio: vi.fn(),
      resolveProjectGenerationPrompt: vi.fn(),
    }));
    vi.doMock('../../src/services/comfyWorkflowService', () => ({ cancelComfyUINodeTask }));

    const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const tree = AINodeDialog();
    const promptPanel = findElement(tree, (element) => componentName(element) === 'PromptPanelMock');

    expect(promptPanel.props.isGenerating).toBe(true);
    expect(promptPanel.props.onCancelGeneration).toEqual(expect.any(Function));
    (promptPanel.props.onCancelGeneration as () => void)();
    await vi.waitFor(() => expect(cancelComfyUINodeTask).toHaveBeenCalledWith('image-node'));
    if (outcome === 'project-switch') {
      expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
      return;
    }
    if (outcome === 'failure') {
      await vi.waitFor(() => expect(store.nodes[0].data.status).toBe('error'));
      const recoveredTree = AINodeDialog();
      const recoveredPanel = findElement(recoveredTree, (element) => componentName(element) === 'PromptPanelMock');
      expect(recoveredPanel.props.canGenerate).toBe(false);
      await (recoveredPanel.props.onSubmit as () => Promise<void>)();
      expect(generateImage).not.toHaveBeenCalled();
      const resume = findElement(recoveredTree, (element) => element.type === 'button' && element.props.children === '继续查询');
      (resume.props.onClick as () => void)();
      expect(resumeComfyUINodeTask).toHaveBeenCalledWith('image-node');
      expect(findElement(recoveredTree, (element) => element.type === 'button' && element.props.children === '再次终止')).toBeTruthy();
      return;
    }
    await vi.waitFor(() => expect(store.updateNodeDataTransient).toHaveBeenCalledWith(
      'image-node',
      { status: 'idle', error: undefined },
    ));
    expect(store.showToast).toHaveBeenCalledWith('已终止 ComfyUI 任务');
  });
});
