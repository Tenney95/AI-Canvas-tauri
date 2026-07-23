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
  currentProjectId: string | null;
  dialogPosition?: { x: number; y: number };
  nodes: TestNode[];
  edges: Array<{ id: string; source: string; target: string }>;
  projects: Array<{ id: string; settings?: Record<string, unknown> }>;
  customStyles: Array<Record<string, unknown>>;
  workflows: unknown[];
  selectedNodeIds: string[];
  getCurrentRevision: () => number;
  setNodes: (nodes: TestNode[]) => void;
  addNode: ReturnType<typeof vi.fn>;
  addNodeTransient: ReturnType<typeof vi.fn>;
  updateNodeData: ReturnType<typeof vi.fn>;
  updateNodeDataTransient: ReturnType<typeof vi.fn>;
  commitToHistory: ReturnType<typeof vi.fn>;
  recordOutputHistory: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  renameGroup: ReturnType<typeof vi.fn>;
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
) {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof import('react')>('react');
    let stateIndex = 0;
    return {
      ...actual,
      memo: <T,>(component: T) => component,
      lazy: () => function LazyComponentMock() { return null; },
      Suspense: ({ children }: { children: unknown }) => children,
      useCallback: <T,>(callback: T) => callback,
      useEffect: () => undefined,
      useLayoutEffect: () => undefined,
      useMemo: <T,>(factory: () => T) => factory(),
      useRef: <T,>(initialValue: T) => ({ current: initialValue }),
      useState: <T,>(initialValue: T | (() => T)) => {
        const resolved = typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue;
        const value = stateValue?.(resolved, stateIndex++) ?? resolved;
        return [value as T, vi.fn()] as const;
      },
    };
  });
}

function createStore(nodes: TestNode[], getRevision: () => number): TestStore {
  const store = {
    activeNodeId: null,
    currentProjectId: 'project-a',
    nodes,
    edges: [],
    projects: [{ id: 'project-a', settings: { styleReferenceId: 'style-project' } }],
    customStyles: [{ id: 'style-project', name: 'Project style' }],
    workflows: [],
    selectedNodeIds: [],
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

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('critical canvas node interactions', () => {
  it('ImageNode cancels a pending crop when the canvas revision changes', async () => {
    let revision = 1;
    const store = createStore([{
      id: 'image-source',
      type: 'ai-image',
      position: { x: 20, y: 30 },
      data: { type: 'ai-image', label: 'Source image', imageUrl: 'data:image/png;base64,source' },
    }], () => revision);
    const saveResult = deferred<{ assetUrl: string; filePath: string }>();

    await installReactHookDriver((initialValue, index) => index === 7 ? true : initialValue);
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
    const cropEditor = findElement(tree, (element) => componentName(element) === 'CropEditorMock');

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
  });

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
    const tree = VideoNode({ id: 'video-source', data: store.nodes[0].data, selected: true });
    const video = findElement(tree, (element) => element.type === 'video' && element.props.preload === 'metadata');
    const toolbar = findElement(tree, (element) => componentName(element) === 'VideoNodeToolbarMock');
    (video.props.ref as { current: unknown }).current = {
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 12.5,
    };

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
    const batchButton = findElement(tree, (element) => componentName(element) === 'AnimatedButtonMock');

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
    vi.doMock('../../src/services/fileService', () => ({ downloadUrlAndSave: vi.fn().mockResolvedValue(null) }));
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
      videoFrames: 121,
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
});
