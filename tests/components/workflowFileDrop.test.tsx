import { beforeEach, expect, it, vi } from 'vitest';

type ElementLike = { props: Record<string, unknown> & { children?: unknown } };
type DropPayload =
  | { type: 'drop' | 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'leave' };

function find(root: unknown, predicate: (el: ElementLike) => boolean): ElementLike | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, predicate)).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const el = root as ElementLike;
  return predicate(el) ? el : find(el.props.children, predicate);
}

beforeEach(() => { vi.resetModules(); });

async function setup() {
  const slots: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void | (() => void)> = [];
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    useRef: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [slots[index], (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next;
      }];
    },
  }));
  vi.doMock('framer-motion', () => ({ motion: new Proxy({}, { get: (_target, key) => String(key) }), AnimatePresence: 'presence' }));
  vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
  vi.doMock('../../src/components/shared/PopupCloseButton', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/Select', () => ({ default: () => null }));
  vi.doMock('../../src/components/runninghub/RunningHubWorkflowImport', () => ({ default: () => null }));
  vi.doMock('../../src/services/comfyServers', () => ({ comfyBaseUrlFor: vi.fn(), DEFAULT_COMFY_URL: '' }));
  const extract = vi.fn(() => []);
  vi.doMock('../../src/services/comfyUIWindowService', () => ({ extractComfyUIIONodes: extract, openComfyUIWorkflowEditor: vi.fn() }));
  const read = vi.fn(async () => new TextEncoder().encode('{"nodes":[]}'));
  vi.doMock('../../src/services/fileService', () => ({ readBinaryFile: read, copyFileToProjectData: vi.fn(), arrayBufferToBase64: vi.fn() }));
  const store = {
    workflows: [], workflowPanelOpen: true, workflowPanelSource: 'comfyui', config: { comfyServers: [] },
    addNode: vi.fn(), pasteExternalFromDataTransfer: vi.fn(), showToast: vi.fn(),
  };
  vi.doMock('../../src/store/useAppStore', () => ({
    generateId: () => 'test', computeImageNodeDimensions: vi.fn(),
    useAppStore: Object.assign(<T,>(selector: (state: typeof store) => T) => selector(store), { getState: () => store }),
  }));
  vi.doMock('@xyflow/react', () => ({ useReactFlow: () => ({ screenToFlowPosition: (pos: unknown) => pos }) }));
  const callbacks: Array<(event: { payload: DropPayload }) => Promise<void> | void> = [];
  const releases: ReturnType<typeof vi.fn>[] = [];
  vi.doMock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({
    onDragDropEvent: async (callback: (event: { payload: DropPayload }) => Promise<void> | void) => {
      callbacks.push(callback);
      const release = vi.fn(); releases.push(release); return release;
    },
  }) }));
  let globalDrop: ((event: { payload: { paths: string[]; position: { x: number; y: number } } }) => void) | undefined;
  vi.doMock('@tauri-apps/api/event', () => ({ listen: async (_name: string, callback: typeof globalDrop) => { globalDrop = callback; return vi.fn(); } }));
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, devicePixelRatio: 2, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const { default: WorkflowPanel } = await import('../../src/components/WorkflowPanel');
  const { useNodeCreation: createNodes } = await import('../../src/hooks/useNodeCreation');
  const render = () => { cursor = 0; effects = []; return WorkflowPanel(); };
  const tree = render();
  const zone = find(tree, (el) => el.props.role === 'button' && String(el.props.className).includes('ui-dropzone'))!;
  (zone.props.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ left: 100, right: 200, top: 100, bottom: 200 }) };
  const cleanup = effects.map((effect) => effect());
  effects = [];
  const canvas = createNodes();
  cleanup.push(...effects.map((effect) => effect()));
  await vi.waitFor(() => { expect(callbacks).toHaveLength(2); expect(globalDrop).toBeDefined(); });
  return { store, read, extract, canvas, zone, render, callbacks, releases,
    dispose: () => cleanup.forEach((release) => release?.()),
    nativeDrop: async (x = 300, path = 'G:\\workflow.json') => {
      const payload = { type: 'drop' as const, paths: [path], position: { x, y: 300 } };
      await Promise.all(callbacks.map((callback) => callback({ payload })));
      globalDrop?.({ payload });
    },
  };
}

it('imports a native workflow at scaled drop-zone coordinates without creating canvas nodes', async () => {
  const h = await setup();
  await h.nativeDrop();
  expect(h.extract).toHaveBeenCalledExactlyOnceWith('{"nodes":[]}');
  expect(h.store.addNode).not.toHaveBeenCalled();
  expect(find(h.render(), (el) => el.props.title === 'workflow.json')).toBeDefined();
  h.store.workflowPanelOpen = false;
  const later = Date.now() + 1000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  await h.callbacks[1]({ payload: { type: 'drop', paths: ['G:\\canvas.json'], position: { x: 300, y: 300 } } });
  await vi.waitFor(() => expect(h.store.addNode).toHaveBeenCalledOnce());
  h.dispose();
  expect(h.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
});

it('ignores native drops outside the import zone and rejects non-JSON files', async () => {
  const h = await setup();
  await h.nativeDrop(500);
  await h.nativeDrop(300, 'G:\\image.png');
  expect(h.read).not.toHaveBeenCalled();
  expect(h.extract).not.toHaveBeenCalled();
  expect(h.store.addNode).not.toHaveBeenCalled();
  h.dispose();
});

it('stops browser drop propagation and restores canvas import when the panel closes', async () => {
  const h = await setup();
  const event = {
    preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 150, clientY: 150,
    dataTransfer: { files: [{ name: 'browser.json', text: async () => '{}' }] },
  };
  (h.zone.props.onDrop as (event: unknown) => void)(event);
  await vi.waitFor(() => expect(h.extract).toHaveBeenCalledWith('{}'));
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  await h.canvas.onDrop(event as unknown as React.DragEvent);
  expect(h.store.pasteExternalFromDataTransfer).not.toHaveBeenCalled();
  h.store.workflowPanelOpen = false;
  await h.canvas.onDrop(event as unknown as React.DragEvent);
  expect(h.store.pasteExternalFromDataTransfer).toHaveBeenCalledOnce();
  h.dispose();
});

it('does not fill the form after closing while a native file is still being read', async () => {
  const h = await setup();
  let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
  h.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.nativeDrop();
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce());
  h.dispose();
  finish(new TextEncoder().encode('{}'));
  await pending;
  expect(h.extract).not.toHaveBeenCalled();
});
