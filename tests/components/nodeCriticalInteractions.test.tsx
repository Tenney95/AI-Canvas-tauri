import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  config: { performanceMode: boolean; providers: Record<string, never> };
  currentProjectId: string | null;
  dialogPosition?: { x: number; y: number };
  nodes: TestNode[];
  edges: Array<{ id: string; source: string; target: string }>;
  projects: Array<{ id: string; settings?: Record<string, unknown> }>;
  customStyles: Array<Record<string, unknown>>;
  workflows: unknown[];
  selectedNodeIds: string[];
  comfyNodeProgress: Record<string, {
    projectId: string;
    nodeId: string;
    requestId: string;
    clientId: string;
    stage: string;
    value?: number;
    max?: number;
    percent?: number;
    updatedAt: number;
  }>;
  getCurrentRevision: () => number;
  setNodes: (nodes: TestNode[]) => void;
  addNode: ReturnType<typeof vi.fn>;
  addNodeTransient: ReturnType<typeof vi.fn>;
  updateNodeData: ReturnType<typeof vi.fn>;
  updateNodeDataTransient: ReturnType<typeof vi.fn<(nodeId: string, patch: Record<string, unknown>) => void>>;
  commitToHistory: ReturnType<typeof vi.fn>;
  recordOutputHistory: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  renameGroup: ReturnType<typeof vi.fn>;
  toggleGroupCollapsed: ReturnType<typeof vi.fn>;
  setGroupColor: ReturnType<typeof vi.fn>;
  closeNodeDialog: ReturnType<typeof vi.fn>;
  mergeDramaExtract: ReturnType<typeof vi.fn>;
  openNodeDialog: ReturnType<typeof vi.fn>;
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
      useSyncExternalStore: () => 'zh-CN',
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
    commitToHistory: vi.fn(),
    recordOutputHistory: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
    renameGroup: vi.fn(),
    toggleGroupCollapsed: vi.fn(),
    setGroupColor: vi.fn(),
    closeNodeDialog: vi.fn(),
    mergeDramaExtract: vi.fn(),
    openNodeDialog: vi.fn(),
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

async function setupShotlistWidths(
  widths?: Record<string, number>, rows: Record<string, unknown>[] = [], dragRowId?: string,
  dataOverrides: Record<string, unknown> = {},
) {
  await installReactHookDriver((initial, index) => index === 1 ? true : index === 2 ? dragRowId ?? initial : initial);
  const shotlist: TestNode = {
    id: 'shotlist', type: 'ai-shotlist', position: { x: 0, y: 0 },
    data: { type: 'ai-shotlist', label: '第一场', shotlistColumnWidths: widths, shotlistRows: rows, ...dataOverrides },
  };
  const store = createStore([shotlist], () => 1);
  installStoreMock(store);
  installCommonNodeMocks();
  vi.doMock('@xyflow/react', () => ({
    Handle: function HandleMock() { return null; },
    Position: { Left: 'left', Right: 'right' },
    useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn() }),
  }));
  vi.doMock('../../src/services/videoEditorService', () => ({
    hasShotlistTimeline: vi.fn(), openVideoEditorForShotlist: vi.fn(),
  }));
  const ShotlistNode = (await import('../../src/components/nodes/ShotlistNode')).default as unknown as (
    props: { id: string; data: Record<string, unknown>; selected: boolean },
  ) => unknown;
  const tree = ShotlistNode({ id: shotlist.id, data: shotlist.data, selected: true });
  const table = findElement(tree, (element) => element.type === 'table');
  const header = {
    dataset: { shotColumn: 'content' }, offsetWidth: widths?.content ?? 200,
    getBoundingClientRect: () => ({ width: (widths?.content ?? 200) / 2 }),
  };
  (table.props.ref as { current: unknown }).current = { offsetWidth: 1264 };
  const handle = findElement(tree, (element) => element.type === 'button' && element.props['aria-label'] === '内容列宽');
  const pointer = (clientX: number) => ({
    button: 0, pointerId: 7, clientX, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    currentTarget: {
      closest: () => header, setPointerCapture: vi.fn(),
      hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    },
  });
  return { tree, table, store, handle, pointer };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function visibleShotRatio(store: TestStore, column: string) {
  const ratios = store.nodes[0].data.shotlistColumnRatios as Record<string, number>;
  const total = ['frame', 'shotSize', 'camera', 'content', 'dialogue']
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
    vi.doMock('../../src/services/pollManager', () => ({ cancelNodePolling: vi.fn() }));
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
    expect(input.props.value).toBeCloseTo(320 / (84 + 68 + 68 + 320 + 180) * 100);
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
      shotlistColumnRatios: { shotNo: 1, frame: 1, shotSize: 1, camera: 1, dialogue: 1, content: 94 },
    });
    (handle.props.onKeyDown as (event: unknown) => void)({
      key: 'ArrowRight', shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(95);
  });

  it('keeps duration fixed at 84px and excludes it from resizing and percentage settings', async () => {
    const { tree, table } = await setupShotlistWidths({ duration: 500, content: 300 });
    expect((table.props.style as Record<string, string>)['--shotlist-columns']).toContain('84px 106px');
    expect(() => findElement(tree, (element) => element.props['aria-label'] === '时长列宽')).toThrow('Element not found');
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
      shotlistColumnRatios: { shotNo: 5, frame: 10, shotSize: 10, camera: 15, content: 30, dialogue: 30, note: 20 },
    });
    const stepper = findElement(tree, (element) => componentName(element) === 'NumberStepper'
      && element.props['aria-label'] === '内容列宽');
    expect(stepper.props.value).toBeCloseTo(30 / 95 * 100);
    (stepper.props.onChange as (value: number) => void)(40);
    expect(visibleShotRatio(store, 'content')).toBeCloseTo(40);
    expect((store.nodes[0].data.shotlistColumnRatios as Record<string, number>).note).toBe(20);
    expect(visibleShotRatio(store, 'frame') / visibleShotRatio(store, 'camera')).toBeCloseTo(10 / 15);
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
      updatedAt: 1,
    };
    installStoreMock(store);
    const { default: NodeGenerationProgress } = await import('../../src/components/nodes/shared/NodeGenerationProgress');

    const rendered = NodeGenerationProgress({ nodeId: 'node-1', fallbackLabel: '生成图像中...' });
    const progressbar = findElement(rendered, (element) => element.props.role === 'progressbar');
    const detail = findElement(rendered, (element) => element.props.children === '6 / 12 · 50%');

    expect(progressbar.props['aria-valuenow']).toBe(50);
    expect(detail).toBeTruthy();
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
    vi.doMock('../../src/services/videoEditorService', () => ({
      hasShotlistTimeline: vi.fn().mockResolvedValue(false),
      openVideoEditorForShotlist: vi.fn(),
    }));

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
    vi.doMock('../../src/services/projectSettingsService', () => ({ resolveProjectGenerationPrompt }));

    const AINodeDialog = (await import('../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
    const tree = AINodeDialog();
    const promptPanel = findElement(tree, (element) => componentName(element) === 'PromptPanelMock');
    const changePrompt = promptPanel.props.onChange as (value: string, previousValue?: string) => void;
    // 后连线已经写入 Store，但编辑器还持有旧 DOM；继续输入不能抹掉新引用。
    store.updateNodeDataTransient('video-node', { prompt: 'old prompt @{image:新参考图} @{audio:新声音}' });
    changePrompt('正在编辑的内容', 'old prompt');
    expect(store.nodes[0].data.prompt).toBe('正在编辑的内容 @{image:新参考图} @{audio:新声音}');
    (promptPanel.props.onContinuousEditEnd as () => void)();
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
      videoResolution: undefined,
      videoFps: undefined,
      videoFrames: undefined,
      seedanceResolution: undefined,
      seedanceRatio: undefined,
      seedanceDuration: undefined,
      generateAudio: undefined,
    }));
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
      prompt: 'resolved:latest prompt:latest-style',
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
