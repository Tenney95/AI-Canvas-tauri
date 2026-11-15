/**
 * nodeMenuModelPreferences — 验证浮动菜单新建节点实际绑定模型，而非只在选择器显示偏好。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';

interface Element {
  type: unknown;
  key?: string | null;
  props: { children?: unknown; onClick?: () => void };
}

const driver = vi.hoisted(() => ({ state: {} as AppState }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useEffect: () => {},
  useRef: <T,>(value: T) => ({ current: value }),
  useMemo: <T,>(factory: () => T) => factory(),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('framer-motion', () => ({ AnimatePresence: 'presence', motion: { div: 'motion-div' } }));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(driver.state), {
    getState: () => driver.state,
  }),
  computeImageNodeDimensions: vi.fn(),
}));
vi.mock('../../src/store/store.utils', () => ({ generateId: () => 'created' }));
vi.mock('../../src/services/fileService', () => ({ uploadSourceFileToProject: vi.fn() }));
vi.mock('../../src/services/canvasPointerService', () => ({ getCanvasPointerPosition: () => ({ x: 20, y: 40 }) }));
vi.mock('../../src/services/sourceFileImportService', () => ({ importSourceFileToCanvas: vi.fn() }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'animated-button' }));
vi.mock('../../src/utils/popupPosition', () => ({ calcFixedPosition: () => ({ left: 0, top: 0 }) }));
vi.mock('../../src/services/plugins/pluginRuntime', () => ({ getAvailablePluginNodes: () => [], createPluginNode: vi.fn() }));

import NodeMenu from '../../src/components/NodeMenu';

function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}

function create(type: string) {
  const button = elements(NodeMenu()).find((element) => element.type === 'animated-button' && element.key === type);
  expect(button).toBeDefined();
  button!.props.onClick!();
  return vi.mocked(driver.state.addNode).mock.calls.at(-1)![0];
}

beforeEach(() => {
  localStorage.clear();
  driver.state = {
    currentProjectId: 'project', projects: [], installedPlugins: [],
    nodeMenuVisible: true, nodeMenuPosition: { x: 0, y: 0 },
    addNode: vi.fn(), hideNodeMenu: vi.fn(), showToast: vi.fn(),
  } as unknown as AppState;
});

describe('浮动菜单新建模型绑定', () => {
  it.each(['ai-text', 'ai-audio'] as const)('%s 将历史偏好写入提交给 Store 的节点', (type) => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({ [type]: 'general/preferred' }));
    const node = create(type);
    expect(node.data).toMatchObject({ type, model: 'general/preferred', provider: 'general', status: 'idle',
      nodeWidth: 280, nodeHeight: 160 });
    expect(node.data).not.toHaveProperty('role');
    expect(driver.state.hideNodeMenu).toHaveBeenCalledOnce();
  });

  it('项目默认优先，动画预置提示词不会提前锁定全局偏好', () => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({ 'ai-image': 'general/preferred' }));
    driver.state.projects = [{ id: 'project', name: '项目', createdAt: 0, updatedAt: 0,
      settings: { defaultModels: { image: 'general/project' } } }];
    expect(create('ai-animation').data).toMatchObject({
      model: 'general/project', provider: 'general', animationAction: 'idle', animationFrames: 8,
      animationPreviewMode: 'playing', aspectRatio: '1:1', imageSize: '2K', nodeWidth: 320, nodeHeight: 358,
    });
  });

  it('默认工作流身份完整写入，不丢失 workflowId', () => {
    driver.state.projects = [{ id: 'project', name: '项目', createdAt: 0, updatedAt: 0,
      settings: { defaultModels: { image: 'comfyui/image-workflow' } } }];
    expect(create('ai-image').data).toMatchObject({
      model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'image-workflow',
    });
  });

  it('浮动菜单分镜表保留 source 角色、文本偏好和独立的三行初始数据', () => {
    localStorage.setItem('canvas-model-prefs', JSON.stringify({ 'ai-text': 'general/text' }));
    const first = create('ai-shotlist').data;
    const second = create('ai-shotlist').data;
    expect(first).toMatchObject({ role: 'source', nodeWidth: 720, nodeHeight: 380,
      model: 'general/text', provider: 'general', prompt: '' });
    expect(first.shotlistRows?.map((row) => row.shotNo)).toEqual(['1', '2', '3']);
    expect(second.shotlistRows).not.toBe(first.shotlistRows);
    expect(second.shotlistRows?.[0]).not.toBe(first.shotlistRows?.[0]);
  });

  it('没有偏好时保持未选，导演台不继承普通模型偏好', () => {
    expect(create('ai-text').data.model).toBeUndefined();
    localStorage.setItem('canvas-model-prefs', JSON.stringify({ 'ai-director': 'general/implicit' }));
    expect(create('ai-director').data).toMatchObject({ role: 'source', directorStatus: 'idle' });
    expect(create('ai-director').data.model).toBeUndefined();
  });
});
