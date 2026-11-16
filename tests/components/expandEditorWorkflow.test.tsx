import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';

const driver = vi.hoisted(() => ({
  index: 0, slots: [] as unknown[], effects: [] as Array<() => unknown>,
  state: { workflows: [] as WorkflowDefinition[] },
  canvasToDataUrl: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: <T,>(factory: () => T) => factory(), useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => unknown) => { driver.effects.push(effect); },
  useLayoutEffect: (effect: () => unknown) => { driver.effects.push(effect); },
  useRef: <T,>(initial: T) => {
    const index = driver.index++;
    return driver.slots[index] ?? (driver.slots[index] = { current: initial });
  },
  useState: <T,>(initial?: T | (() => T)) => {
    const index = driver.index++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T | ((previous: T) => T)) => {
      driver.slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(driver.slots[index] as T) : next;
    }];
  },
}));
vi.mock('framer-motion', () => ({ motion: { div: 'motion-div' } }));
vi.mock('../../src/utils/motion', () => ({ springGentle: {} }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: typeof driver.state) => unknown) => selector(driver.state) }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/components/shared/FullscreenOverlay', () => ({ default: 'fullscreen' }));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'animated-button' }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: 'model-selector' }));
vi.mock('../../src/components/nodes/shared/CloudWorkflowParamSelector', () => ({ default: 'workflow-parameters' }));
vi.mock('../../src/services/workflowExecutionService', () => ({ workflowExecution: (workflow: WorkflowDefinition) => ({
  provider: 'comfyui', model: 'comfyui/workflow', workflowId: workflow.id,
}) }));
vi.mock('../../src/components/nodes/shared/image/imageUtils', () => ({ createSafeImagePreviewSource: async (sourceUrl: string) => ({
  sourceUrl, src: 'blob:preview', dimensions: { width: 100, height: 80 }, release: vi.fn(),
}) }));
vi.mock('../../src/components/nodes/shared/image/imageResourceBudget', () => ({
  assertEditorCanvasBudget: vi.fn(), getEditorCanvasBudgetError: () => null,
  canvasToDataUrl: driver.canvasToDataUrl,
}));

import ExpandEditor from '../../src/components/nodes/shared/image/ExpandEditor';
import ModelSelector from '../../src/components/nodes/shared/ModelSelector';
import CloudWorkflowParamSelector from '../../src/components/nodes/shared/CloudWorkflowParamSelector';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
const workflow = (id: string, patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id, name: id, category: 'ai-image', fileName: `${id}.json`, fileContent: '{}', createdAt: 1,
  ioNodes: [{ nodeId: '1', title: 'Input image', type: 'image' }], ...patch,
});
function render(props: ComponentProps<typeof ExpandEditor>) {
  driver.index = 0; driver.effects = [];
  return elements(ExpandEditor(props));
}
const selector = (tree: Element[]) => tree.find((element) => element.type === ModelSelector)!.props as unknown as ComponentProps<typeof ModelSelector>;
const parameters = (tree: Element[]) => tree.find((element) => element.type === CloudWorkflowParamSelector)!.props as unknown as ComponentProps<typeof CloudWorkflowParamSelector>;
const confirm = (tree: Element[]) => tree.find((element) => element.props['aria-label'] === '开始扩图')!.props as unknown as { disabled: boolean; onClick: () => Promise<void> };
async function prepare(props: ComponentProps<typeof ExpandEditor>) {
  let tree = render(props);
  const stage = tree.find((element) => element.props.className === 'crop-stage expand-stage')!;
  (stage.props.ref as { current: unknown }).current = { clientWidth: 900, clientHeight: 700 };
  driver.effects.forEach((effect) => effect());
  await Promise.resolve();
  tree = render(props);
  const image = tree.find((element) => element.type === 'img')!;
  (image.props.ref as { current: unknown }).current = { complete: true };
  (image.props.onLoad as () => void)();
  return render(props);
}

beforeEach(() => {
  driver.index = 0; driver.slots = []; driver.effects = []; driver.state.workflows = [];
  driver.canvasToDataUrl.mockReset().mockResolvedValue('data:image/png;base64,padded');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) }) });
});
afterEach(() => vi.unstubAllGlobals());

describe('扩图模型与工作流', () => {
  it('只列出带图片输入的本地图片工作流，提交其完整参数并隔离模型偏好', async () => {
    driver.state.workflows = [workflow('local'), workflow('text-only', { ioNodes: [] }),
      workflow('video', { category: 'ai-video' }), workflow('cloud', { adapterType: 'runninghub' })];
    const props = { isOpen: true, imageUrl: 'source.png', onClose: vi.fn(), onGenerate: vi.fn() };
    let tree = await prepare(props);
    expect(selector(tree).workflows?.map((item) => item.id)).toEqual(['local']);
    expect(selector(tree).persistPreference).toBe(false);
    selector(tree).onWorkflowSelect?.('local');
    tree = render(props);
    const values = { 'comfy-param::2::steps': '30', 'comfy-param::3::width': '1024' };
    parameters(tree).onChange(values);
    tree = render(props);
    expect(selector(tree)).toMatchObject({ selectedModel: 'comfyui/workflow', selectedProvider: 'comfyui', selectedWorkflowId: 'local' });
    await confirm(tree).onClick();
    expect(props.onGenerate).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,padded', {
      size: '1:1', width: 125, height: 125, model: 'comfyui/workflow', provider: 'comfyui', prompt: '',
      workflowId: 'local', workflowInputs: values,
    });
  });

  it('从工作流切回普通模型时清除工作流参数，保留新模型并禁用合成期间的模型编辑', async () => {
    driver.state.workflows = [workflow('local')];
    const props = { isOpen: true, imageUrl: 'source.png', onClose: vi.fn(), onGenerate: vi.fn() };
    let tree = await prepare(props);
    selector(tree).onWorkflowSelect?.('local');
    tree = render(props);
    parameters(tree).onChange({ 'comfy-param::2::steps': '30' });
    const model = { value: 'general/custom', provider: 'general', label: 'Custom', nodeTypes: ['ai-image'] as const };
    selector(tree).onSelect({ ...model, nodeTypes: [...model.nodeTypes] });
    selector(tree).onWorkflowSelect?.(undefined);
    tree = render(props);
    expect(selector(tree)).toMatchObject({ selectedModel: model.value, selectedProvider: model.provider });
    expect(selector(tree).selectedWorkflowId).toBeUndefined();
    expect(tree.some((element) => element.type === CloudWorkflowParamSelector)).toBe(false);
    let finish!: (value: string) => void;
    driver.canvasToDataUrl.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const pending = confirm(tree).onClick();
    tree = render(props);
    expect(confirm(tree).disabled).toBe(true);
    expect(selector(tree).disabled).toBe(true);
    selector(tree).onWorkflowSelect?.('local');
    expect(selector(render(props)).selectedWorkflowId).toBeUndefined();
    finish('data:image/png;base64,padded');
    await pending;
    expect(props.onGenerate.mock.calls[0][1]).toEqual(expect.objectContaining({ model: model.value, provider: model.provider }));
    expect(props.onGenerate.mock.calls[0][1]).not.toHaveProperty('workflowId');
    expect(props.onGenerate.mock.calls[0][1]).not.toHaveProperty('workflowInputs');
  });

  it('合成期间切换源图会丢弃旧垫图，并允许新来源继续确认', async () => {
    const props = { isOpen: true, imageUrl: 'source.png', onClose: vi.fn(), onGenerate: vi.fn() };
    const tree = await prepare(props);
    let finish!: (value: string) => void;
    driver.canvasToDataUrl.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
    const pending = confirm(tree).onClick();
    const replacement = { ...props, imageUrl: 'replacement.png' };
    const nextTree = await prepare(replacement);
    expect(confirm(nextTree).disabled).toBe(false);
    finish('data:image/png;base64,old-source');
    await pending;
    expect(props.onGenerate).not.toHaveBeenCalled();
    await confirm(nextTree).onClick();
    expect(props.onGenerate).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,padded', expect.any(Object));
  });
});
