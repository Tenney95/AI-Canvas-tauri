import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData, ModelGroup, NodeType, WorkflowDefinition } from '../../src/types';
import { getGenerationNodeType, resolveGenerationNodeData } from '../../src/utils/nodeGeneration';
import { ModelMenu, type ModelMenuProps } from '../../src/components/shared/ModelPicker';

interface Element { type?: unknown; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0, effectIndex: 0,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  probe: vi.fn(), editor: vi.fn(), toast: vi.fn(), resolveUrl: vi.fn(),
  config: { providers: {}, comfyUIUrl: 'http://localhost:8188', comfyServers: [{ id: 'remote', name: '远程', url: 'https://comfy.example.com' }] },
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useMemo: <T,>(fn: () => T) => fn(),
  useCallback: <T,>(fn: T) => fn,
  useRef: <T,>(initial: T) => ({ current: initial }),
  useLayoutEffect: () => {},
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.states[index], (next: T | ((value: T) => T)) => {
      driver.states[index] = typeof next === 'function' ? (next as (value: T) => T)(driver.states[index] as T) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    driver.pending.push(() => {
      previous?.cleanup?.();
      driver.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(
  (select: (state: unknown) => unknown) => select({ config: driver.config }),
  { getState: () => ({ showToast: driver.toast }) },
) }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/services/comfyServers', () => ({
  probeComfyServer: driver.probe, comfyBaseUrlFor: driver.resolveUrl, DEFAULT_COMFY_URL: 'http://127.0.0.1:8188',
}));
vi.mock('../../src/services/comfyUIWindowService', () => ({ openComfyUIWorkflowEditor: driver.editor }));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({
  defaultModelGroups: [], getConfiguredModelGroups: () => [], getGeneralModelGroups: () => [],
}));
vi.mock('../../src/components/shared/ProviderBadge', () => ({ default: 'badge' }));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
import ModelSelector from '../../src/components/nodes/shared/ModelSelector';

function all(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(all);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...all(element.props.children)];
}
function click(element: Element) {
  (element.props.onClick as (event: unknown) => void)({ stopPropagation: vi.fn() });
}
function workflow(id: string, extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { id, name: id, category: 'ai-image', fileName: `${id}.json`, fileContent: '{}', createdAt: 0, updatedAt: 0, ...extra };
}
const select = vi.fn();
function render(workflows: WorkflowDefinition[], selectedWorkflowId?: string) {
  driver.stateIndex = 0;
  driver.effectIndex = 0;
  const tree = ModelSelector({ nodeType: 'ai-image', workflows, selectedWorkflowId, onSelect: vi.fn(), onWorkflowSelect: select });
  driver.pending.splice(0).forEach((effect) => effect());
  return all(tree);
}
function menu(elements: Element[]) { return elements.find((element) => element.type === ModelMenu)?.props as unknown as ModelMenuProps | undefined; }
function group(elements: Element[]) { return menu(elements)?.groups.find((entry) => entry.id === '__workflows'); }
function items(elements: Element[]) { return group(elements)?.items ?? []; }
function open(workflows: WorkflowDefinition[]) {
  click(render(workflows).find((element) => String(element.props.className).startsWith('model-selector-trigger'))!);
  return render(workflows);
}

beforeEach(() => {
  vi.useFakeTimers();
  driver.states = []; driver.effects = []; driver.pending = [];
  driver.probe.mockReset().mockResolvedValue(false);
  driver.editor.mockReset().mockResolvedValue({ missingNodeClasses: [] });
  driver.resolveUrl.mockReset().mockReturnValue('https://comfy.example.com');
  driver.config.comfyServers = [{ id: 'remote', name: '远程', url: 'https://comfy.example.com' }];
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  driver.effects.forEach((effect) => effect.cleanup?.());
  vi.useRealTimers();
});

describe('模型选择器工作流可用性', () => {
  it.each([
    ['source-text', 'ai-text'], ['source-image', 'ai-image'], ['source-video', 'ai-video'],
    ['source-audio', 'ai-audio'], ['ai-markdown', 'ai-text'],
  ] as const)('%s 沿用 %s 的模型和工作流，选中后写入公用偏好', (type, generationType) => {
    localStorage.clear();
    const selectModel = vi.fn(); const selectWorkflow = vi.fn();
    const groups: ModelGroup[] = [{ id: 'configured', name: '已配置', description: '', models:
      (['ai-text', 'ai-image', 'ai-video', 'ai-audio'] as const).map((nodeType) => ({
        value: `general/${nodeType}`, provider: 'general', label: nodeType, nodeTypes: [nodeType],
      })) }];
    const flow = workflow('cloud', { category: generationType, adapterType: 'runninghub' });
    const draw = () => {
      driver.stateIndex = 0; driver.effectIndex = 0;
      const elements = all(ModelSelector({ nodeType: type, configuredGroupsOverride: groups, workflows: [flow],
        onSelect: selectModel, onWorkflowSelect: selectWorkflow }));
      driver.pending.splice(0).forEach((effect) => effect());
      return elements;
    };
    click(draw().find((element) => String(element.props.className).startsWith('model-selector-trigger'))!);
    const picker = menu(draw())!;
    expect(picker.groups.find((item) => item.id === 'configured')?.items.map((item) => item.value)).toEqual([`general/${generationType}`]);
    expect(picker.groups.find((item) => item.id === '__workflows')?.items.map((item) => item.value)).toEqual(['workflow:cloud']);
    picker.onChange(`general/${generationType}`);
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ value: `general/${generationType}` }));
    expect(JSON.parse(localStorage.getItem('canvas-model-prefs')!)[generationType]).toBe(`general/${generationType}`);
    click(draw().find((element) => String(element.props.className).startsWith('model-selector-trigger'))!);
    menu(draw())!.onChange('workflow:cloud');
    expect(selectWorkflow).toHaveBeenLastCalledWith('cloud');
  });

  it('能力映射不改变原节点字段，特殊节点和普通生成节点沿用原对象', () => {
    const data: BaseNodeData = { type: 'source-text', label: '原文', output: '正文 @{reference:素材}', role: 'source', assetId: 'asset-1' };
    expect(resolveGenerationNodeData(data)).toEqual({ ...data, type: 'ai-text' });
    expect(data.type).toBe('source-text');
    for (const type of ['ai-text', 'ai-image', 'ai-video', 'ai-audio', 'ai-animation', 'ai-panorama', 'ai-shotlist', 'ai-director', 'plugin-node', 'canvas-note'] as NodeType[]) {
      const original = { ...data, type };
      expect(resolveGenerationNodeData(original)).toBe(original);
      expect(getGenerationNodeType(type)).toBe(type);
    }
    expect(resolveGenerationNodeData(undefined)).toBeUndefined();
    expect(getGenerationNodeType('unknown-node')).toBe('unknown-node');
  });

  it('编辑按钮打开当前工作流绑定的服务器，不展开菜单且防止重复打开', async () => {
    const flow = workflow('remote', { serverId: 'remote' });
    let complete!: (value: { missingNodeClasses: string[] }) => void;
    driver.editor.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const button = render([flow], flow.id).find((element) => element.props['aria-label'] === '在 ComfyUI 中编辑')!;
    click(button);
    click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.resolveUrl).toHaveBeenCalledWith(flow.id);
    expect(driver.editor).toHaveBeenCalledExactlyOnceWith('https://comfy.example.com', flow);
    const elements = render([flow], flow.id);
    expect(elements.find((element) => element.props['aria-label'] === '在 ComfyUI 中编辑')?.props.disabled).toBe(true);
    expect(elements.some((element) => String(element.props.className).startsWith('ui-model-menu__surface'))).toBe(false);
    complete({ missingNodeClasses: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(render([flow], flow.id).find((element) => element.props['aria-label'] === '在 ComfyUI 中编辑')?.props.disabled).toBe(false);
  });

  it('打开失败提示错误并恢复按钮', async () => {
    const flow = workflow('local');
    driver.editor.mockRejectedValue(new Error('服务未启动'));
    click(render([flow], flow.id).find((element) => element.props['aria-label'] === '在 ComfyUI 中编辑')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.toast).toHaveBeenCalledWith('服务未启动', 'error');
    expect(render([flow], flow.id).find((element) => element.props['aria-label'] === '在 ComfyUI 中编辑')?.props.disabled).toBe(false);
  });

  it('普通模型与云端工作流不显示 ComfyUI 编辑按钮', () => {
    const flows = [workflow('cloud', { adapterType: 'runninghub' }), workflow('api', { adapterType: 'workflow-api' })];
    for (const id of [undefined, 'cloud', 'api']) {
      expect(render(flows, id).some((element) => element.props['aria-label'] === '在 ComfyUI 中编辑')).toBe(false);
    }
  });

  it('关闭菜单不探测，未就绪时隐藏整个分组且不清除当前选择', async () => {
    const flows = [workflow('local')];
    render(flows);
    expect(driver.probe).not.toHaveBeenCalled();
    expect(group(open(flows))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    const elements = render(flows, 'local');
    expect(group(elements)).toBeUndefined();
    expect(elements.find((element) => element.props.className === 'model-selector-label')?.props.children).toBe('local');
  });

  it('按实际绑定服务器过滤，折叠可切换且仍能选择工作流', async () => {
    const flows = [workflow('local'), workflow('remote-a', { serverId: 'remote' }), workflow('remote-b', { serverId: 'remote' })];
    driver.probe.mockImplementation(async (url: string) => url.startsWith('https:'));
    open(flows);
    await vi.advanceTimersByTimeAsync(0);
    let elements = render(flows);
    expect(driver.probe).toHaveBeenCalledTimes(2);
    expect(items(elements)).toHaveLength(2);
    expect(items(elements).map((item) => item.value)).toEqual(['workflow:remote-a', 'workflow:remote-b']);
    expect(menu(elements)?.expandedGroupIds).not.toContain('__workflows');
    menu(elements)!.onGroupToggle('__workflows');
    elements = render(flows);
    expect(menu(elements)?.expandedGroupIds).toContain('__workflows');
    menu(elements)!.onChange(items(elements)[0].value);
    expect(select).toHaveBeenCalledWith('remote-a');
    render(flows);
    const signal = driver.probe.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('在线状态刷新后出现或消失，已删除服务器回落默认地址', async () => {
    const flows = [workflow('fallback', { serverId: 'deleted' })];
    open(flows);
    await vi.advanceTimersByTimeAsync(0);
    expect(group(render(flows))).toBeUndefined();
    driver.probe.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(items(render(flows))).toHaveLength(1);
    expect(driver.probe.mock.calls[0][0]).toBe('http://localhost:8188');
    driver.probe.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(group(render(flows))).toBeUndefined();
  });

  it('ComfyUI 离线不隐藏 RunningHub 和工作流 API', async () => {
    const flows = [workflow('local'), workflow('cloud', { adapterType: 'runninghub' }), workflow('api', { adapterType: 'workflow-api' })];
    open(flows);
    await vi.advanceTimersByTimeAsync(0);
    expect(items(render(flows))).toHaveLength(2);
  });
});
