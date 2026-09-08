import { beforeEach, expect, it, vi } from 'vitest';
import type { ComfyUIWorkflowOpenResult } from '../../src/services/comfyUIWindowService';

interface ElementLike {
  props: Record<string, unknown> & { children?: unknown };
}

function findElement(root: unknown, predicate: (element: ElementLike) => boolean): ElementLike | undefined {
  if (Array.isArray(root)) {
    for (const child of root) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const element = root as ElementLike;
  return predicate(element) ? element : findElement(element.props.children, predicate);
}

function textOf(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(textOf).join('');
  if (root && typeof root === 'object' && 'props' in root) return textOf((root as ElementLike).props.children);
  return '';
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

it('shows loading, blocks repeated opens, and retries a failed workflow from its row', async () => {
  // Preserve state and refs between explicit renders without invoking browser-only effects.
  const slots: unknown[] = [];
  let cursor = 0;
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => undefined,
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
  vi.doMock('framer-motion', () => ({
    motion: new Proxy({}, { get: (_target, key) => String(key) }),
    AnimatePresence: 'presence',
  }));
  vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
  vi.doMock('../../src/components/shared/PopupCloseButton', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/Select', () => ({ default: () => null }));
  vi.doMock('../../src/components/runninghub/RunningHubWorkflowImport', () => ({ default: () => null }));
  const store = {
    workflows: ['A', 'B'].map((name) => ({
      id: `wf-${name}`, name, category: 'ai-image', fileName: `${name}.json`,
      fileContent: '{}', createdAt: 0,
    })),
    workflowPanelOpen: true,
    config: { comfyServers: [] },
    showToast: vi.fn(),
  };
  vi.doMock('../../src/store/useAppStore', () => ({
    generateId: () => 'test',
    useAppStore: <T,>(selector: (state: typeof store) => T) => selector(store),
  }));
  vi.doMock('../../src/services/comfyServers', () => ({
    comfyBaseUrlFor: () => 'http://127.0.0.1:8188', DEFAULT_COMFY_URL: 'http://127.0.0.1:8188',
  }));
  let rejectOpen!: (error: Error) => void;
  const openEditor = vi.fn().mockImplementationOnce(
    () => new Promise<ComfyUIWorkflowOpenResult>((_resolve, reject) => { rejectOpen = reject; }),
  );
  vi.doMock('../../src/services/comfyUIWindowService', () => ({
    extractComfyUIIONodes: () => [], openComfyUIWorkflowEditor: openEditor,
  }));
  const { default: WorkflowPanel } = await import('../../src/components/WorkflowPanel');
  const render = () => { cursor = 0; return WorkflowPanel(); };
  const editButton = (tree: unknown, name: string) => {
    const button = findElement(tree, (element) => element.props['aria-label'] === `编辑工作流：${name}`);
    expect(button).toBeDefined();
    return button!;
  };
  const click = (element: ElementLike) => (element.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() });

  const first = editButton(render(), 'A');
  click(first);
  click(first);
  expect(openEditor).toHaveBeenCalledTimes(1);
  let tree = render();
  expect(editButton(tree, 'A').props['aria-busy']).toBe(true);
  expect(editButton(tree, 'B').props.disabled).toBe(true);
  expect(textOf(findElement(tree, (element) => element.props.role === 'status'))).toContain('正在检查工作流');

  rejectOpen(new Error('工作流载入后画布为空'));
  await vi.waitFor(() => expect(store.showToast).toHaveBeenCalledWith('工作流载入后画布为空', 'error'));
  tree = render();
  expect(textOf(findElement(tree, (element) => element.props.role === 'alert'))).toContain('画布为空');
  expect(editButton(tree, 'B').props.disabled).toBe(false);
  openEditor.mockResolvedValueOnce({
    requestId: 'open-retry', nodeCount: 12, source: 'api', detail: '已从 API 数据恢复画布', missingNodeClasses: [],
  } satisfies ComfyUIWorkflowOpenResult);
  const retry = findElement(tree, (element) => element.props.children === '重试打开');
  expect(retry).toBeDefined();
  click(retry!);
  await vi.waitFor(() => expect(textOf(render())).toContain('12 个画布节点'));
  expect(openEditor).toHaveBeenCalledTimes(2);
  expect(openEditor.mock.calls[1][1].id).toBe('wf-A');
  expect(editButton(render(), 'B').props.disabled).toBe(false);
});
