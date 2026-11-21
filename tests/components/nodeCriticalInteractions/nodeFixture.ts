import { vi } from 'vitest';
import type { AppState } from '../../../src/store/useAppStore';
import type { ComfyNodeProgress } from '../../../src/types/comfyProgress';
import type { AppConfig } from '../../../src/types';

export const confirmVideoReferencesBeforeGeneration = vi.fn<
  (nodeId: string, overridePrompt?: string) => Promise<boolean>
>();

export const flushPendingAutoSave = vi.fn<(projectId: string) => Promise<boolean>>();

export interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

export interface TestNode {
  id: string;
  type: string;
  parentId?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface TestStore {
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function isElementLike(value: unknown): value is ElementLike {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

export function findElement(root: unknown, predicate: (element: ElementLike) => boolean): ElementLike {
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

export function componentName(element: ElementLike): string {
  return typeof element.type === 'function' ? element.type.name : String(element.type);
}

export async function installReactHookDriver(
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

export function createStore(nodes: TestNode[], getRevision: () => number): TestStore {
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

export function installStoreMock(store: TestStore) {
  const useAppStore = Object.assign(
    <T,>(selector: (state: TestStore) => T) => selector(store),
    { getState: () => store, subscribe: () => () => undefined },
  );
  vi.doMock('../../../src/store/useAppStore', () => ({
    generateId: () => 'generated',
    computeImageNodeDimensions: vi.fn(),
    useAppStore,
  }));
}

export function mockComfyDeliveries() {
  return {
    subscribeComfyDeliveries: () => () => {},
    isComfyNodeDeliveryActive: () => false,
    beginComfyNodeDelivery: vi.fn(),
    completeComfyNodeTask: vi.fn(),
    pauseComfyNodeDelivery: vi.fn(),
    prepareMediaNodeGeneration: vi.fn(),
    registerMediaNodeOperation: () => vi.fn(),
    registerNodePolling: (_nodeId: string, parentSignal?: AbortSignal) => parentSignal ?? new AbortController().signal,
    cleanupNodePolling: vi.fn(),
    completeMediaNodeTask: vi.fn(),
    pauseMediaTask: vi.fn(),
    isMediaTaskPausedError: () => false,
  };
}

export function installCommonNodeMocks() {
  vi.doMock('../../../src/hooks/useCompletionFlash', () => ({ useCompletionFlash: () => false }));
  vi.doMock('../../../src/hooks/useReferencedImageWatcher', () => ({
    useReferencedImageRevisions: () => () => 0,
    withPreviewRevision: (url: string | undefined) => url,
  }));
  vi.doMock('../../../src/components/nodes/shared/useNodeRename', () => ({
    useNodeRename: (_id: string, data: Record<string, unknown>, fallback: string) => ({
      displayLabel: data.label ?? fallback,
      handleRename: vi.fn(),
    }),
  }));
  vi.doMock('../../../src/components/nodes/shared/useSourceFileUpload', () => ({
    useSourceFileUpload: () => ({ isUploading: false, handleUpload: vi.fn() }),
  }));
}

export async function installShotlistTimelineMock() {
  const { resolveShotlistTimelineRows, resolveShotlistVoiceoverNodes } = await vi.importActual<
    typeof import('../../../src/services/videoEditorService')
  >('../../../src/services/videoEditorService');
  const hasShotlistTimeline = vi.fn().mockResolvedValue(false);
  const openVideoEditorForShotlist = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../../src/services/videoEditorService', () => ({
    hasShotlistTimeline, openVideoEditorForShotlist, resolveShotlistTimelineRows, resolveShotlistVoiceoverNodes,
  }));
  return { hasShotlistTimeline, openVideoEditorForShotlist };
}
