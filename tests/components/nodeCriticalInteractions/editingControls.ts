import { expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../../src/types';
import type { ComfyWorkflowParameter } from '../../../src/types/comfyWorkflow';
import { WORKFLOW_RANDOM_SEED } from '../../../src/services/workflowSeed';
import {
  type TestNode,
  deferred,
  findElement,
  componentName,
  installReactHookDriver,
  createStore,
  installStoreMock,
  mockComfyDeliveries,
  installCommonNodeMocks,
} from './nodeFixture';

async function loadWorkflowEditingDialog() {
  vi.doMock('../../../src/components/nodes/shared/ConnectedNodesPreview', () => ({ default: () => null }));
  vi.doMock('../../../src/components/shared/ResourceVideoPreview', () => ({ default: () => null }));
  // 本组只执行弹窗编辑回调，不渲染预览和费用子组件，避免把其冷加载算入交互耗时。
  vi.doMock('../../../src/components/shared/ViewportImage', () => ({ default: () => null }));
  vi.doMock('../../../src/components/shared/ViewportAudio', () => ({ default: () => null }));
  vi.doMock('../../../src/components/nodes/shared/VolcengineCostEstimate', () => ({ default: () => null }));
  // 编辑回调不执行生成或文件操作；隔离这些边界，避免冷加载整套原生生成依赖图。
  vi.doMock('../../../src/services/fileService', () => ({ persistMediaUrlToProjectData: vi.fn() }));
  vi.doMock('../../../src/services/imageBatchService', () => ({
    applyImageBatchResults: vi.fn(), failImageBatchNodes: vi.fn(), prepareImageBatchNodes: vi.fn(),
  }));
  vi.doMock('../../../src/services/comfyWorkflowService', () => ({ cancelComfyUINodeTask: vi.fn() }));
  vi.doMock('../../../src/services/workflowApi/workflowApiAdapter', () => ({
    completeWorkflowApiNodeTask: vi.fn(), stopWorkflowApiNodeTask: vi.fn(),
  }));
  vi.doMock('../../../src/services/ai/providers/runninghubWorkflow', () => ({
    cancelRunningHubNodeTask: vi.fn(), completeRunningHubNodeTask: vi.fn(),
  }));
  vi.doMock('../../../src/services/aiService', () => ({
    generateText: vi.fn(), generateTextResult: vi.fn(), generateImage: vi.fn(), generateImagesBatch: vi.fn(),
    generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn(),
  }));
  vi.doMock('../../../src/services/generationService', () => ({
    cancelImageBatchGeneration: vi.fn(), isImageBatchGenerating: () => false,
    subscribeImageBatches: () => () => undefined, usesSequentialImageBatch: () => false,
  }));
  vi.doMock('../../../src/services/shotlistService', () => ({ generateShotlistRows: vi.fn() }));
  vi.doMock('../../../src/services/ai/generateAudio', () => ({ persistAudioGenerationResult: vi.fn() }));
  try {
    return (await import('../../../src/components/nodes/AINodeDialog')).default as unknown as () => unknown;
  } finally {
    // 当前模块保留导入的替身；后续 resetModules 后的生成用例仍加载自己的真实实现或替身。
    vi.doUnmock('../../../src/components/nodes/shared/ConnectedNodesPreview');
    vi.doUnmock('../../../src/components/shared/ResourceVideoPreview');
    vi.doUnmock('../../../src/components/shared/ViewportImage');
    vi.doUnmock('../../../src/components/shared/ViewportAudio');
    vi.doUnmock('../../../src/components/nodes/shared/VolcengineCostEstimate');
    vi.doUnmock('../../../src/services/fileService');
    vi.doUnmock('../../../src/services/imageBatchService');
    vi.doUnmock('../../../src/services/comfyWorkflowService');
    vi.doUnmock('../../../src/services/workflowApi/workflowApiAdapter');
    vi.doUnmock('../../../src/services/ai/providers/runninghubWorkflow');
    vi.doUnmock('../../../src/services/aiService');
    vi.doUnmock('../../../src/services/generationService');
    vi.doUnmock('../../../src/services/shotlistService');
    vi.doUnmock('../../../src/services/ai/generateAudio');
  }
}

export function registerEditingControlTests() {
  it('工作流小数输入和滑块写入同一字段，未完成的输入不覆盖有效值', async () => {
    await installReactHookDriver();
    installStoreMock(createStore([], () => 1));
    const Field = (await import('../../../src/components/nodes/shared/CloudWorkflowParameterField')).default;
    const onChange = vi.fn();
    const props = { name: 'target_megapixels', label: '百万像素', type: 'number' as const,
      min: 0.2, max: 36, step: 0.1, onChange };
    const draw = (value: string) => Field({ ...props, value });
    const getInput = (tree: unknown, type: string) => findElement(tree, (element) => element.type === 'input' && element.props.type === type);
    const edit = (tree: unknown, type: string, value: string) => {
      (getInput(tree, type).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    };
    const original = draw('2.1');
    edit(original, 'number', '');
    edit(original, 'number', '36.1');
    expect(onChange).not.toHaveBeenCalled();
    edit(original, 'number', '2.15');
    expect(onChange).toHaveBeenLastCalledWith('2.15');
    const precise = draw('2.15');
    expect(getInput(precise, 'range').props.value).toBe(2.15);
    expect(getInput(precise, 'range').props.disabled).toBe(false);
    edit(precise, 'range', '2.27');
    expect(onChange).toHaveBeenLastCalledWith('2.3');
    expect(getInput(draw('2.3'), 'number').props.value).toBe('2.3');
  });

  it('种子面板不抽值，随机/固定切换、一次填入和固定编辑按操作写回', async () => {
    await installReactHookDriver();
    installStoreMock(createStore([], () => 1));
    const Field = (await import('../../../src/components/nodes/shared/CloudWorkflowParameterField')).default;
    const onChange = vi.fn();
    const props = { name: 'seed', label: 'K采样器 · SEED', nodeId: '202', type: 'integer' as const,
      min: 0, max: 99, defaultValue: 42, allowRandomSeed: true, onChange };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const tree = Field({ ...props, value: WORKFLOW_RANDOM_SEED });
      expect(random).not.toHaveBeenCalled();
      expect(findElement(tree, (element) => element.type === 'input').props.readOnly).toBe(true);
      (findElement(tree, (element) => element.type === 'button' && element.props.children === '固定').props.onClick as () => void)();
      expect(onChange).toHaveBeenLastCalledWith('42'); expect(random).not.toHaveBeenCalled();
      (findElement(tree, (element) => element.props['aria-label'] === 'K采样器 · SEED · C#202：随机填入固定种子').props.onClick as () => void)();
      expect(onChange).toHaveBeenLastCalledWith('50'); expect(random).toHaveBeenCalledOnce();
      const fixed = Field({ ...props, value: '77' }); onChange.mockClear();
      (findElement(fixed, (element) => element.type === 'button' && element.props.children === '固定').props.onClick as () => void)();
      expect(onChange).not.toHaveBeenCalled();
      (findElement(fixed, (element) => element.type === 'input').props.onChange as (event: unknown) => void)({ target: { value: '0' } });
      expect(onChange).toHaveBeenLastCalledWith('0');
      (findElement(fixed, (element) => element.type === 'button' && element.props.children === '随机').props.onClick as () => void)();
      expect(onChange).toHaveBeenLastCalledWith(WORKFLOW_RANDOM_SEED); expect(random).toHaveBeenCalledOnce();
    } finally { random.mockRestore(); }
  });

  it('声明式工作流固定种子清空可继续编辑，恢复默认才移除覆盖', async () => {
    await installReactHookDriver(); installStoreMock(createStore([], () => 1));
    const Fields = (await import('../../../src/components/nodes/shared/WorkflowApiParameterFields')).default;
    const { manifest } = (await import('../../../src/services/workflowApi/workflowApiDefinition')).createWorkflowApiDraft();
    manifest.parameters = { seed: { type: 'integer', label: '种子', default: 42 } };
    const onChange = vi.fn();
    const tree = Fields({ manifest, values: { 'workflow::seed': '77' }, appearance: 'popover', onChange });
    const field = findElement(tree, (element) => element.props.name === 'seed');
    (field.props.onChange as (value: string) => void)('');
    expect(onChange).toHaveBeenLastCalledWith({ 'workflow::seed': '' });
    expect(field.props.displayDefaultWhenEmpty).toBe(false);
    (field.props.onReset as () => void)();
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it.each(['comfyui', 'runninghub', 'workflow-api'] as const)('%s 比例选择与恢复默认传出归一化比例，保留提交原值且不被其他参数触发', async (adapterType) => {
    const fields: ComfyWorkflowParameter[] = [
      { nodeId: '515', fieldName: 'aspect_ratio', classType: 'ResolutionSelector', label: '分辨率选择器 · ASPECT_RATIO',
        type: 'string', defaultValue: '16:9 (Widescreen)', options: ['16:9 (Widescreen)', '9:16 (Portrait Widescreen)'] },
      { nodeId: '202', fieldName: 'steps', classType: 'KSampler', label: 'K采样器 · STEPS', type: 'number', defaultValue: 8 },
    ];
    const workflow: WorkflowDefinition = { id: 'workflow-ratio', name: '比例联动', category: 'ai-image', adapterType,
      fileName: 'ratio.json', fileContent: '{}', createdAt: 0 };
    if (adapterType === 'runninghub') workflow.runninghub = { version: 1, kind: 'workflow', remoteId: '123', connectionId: 'runninghub',
      parameters: fields.map((field) => ({ nodeId: field.nodeId, fieldName: field.fieldName, label: field.label,
        type: field.type === 'integer' ? 'number' : field.type, defaultValue: field.defaultValue, source: 'value' })) };
    if (adapterType === 'workflow-api') {
      const { manifest } = (await import('../../../src/services/workflowApi/workflowApiDefinition')).createWorkflowApiDraft();
      manifest.parameters = { aspect_ratio: { type: 'string', label: '画面比例', default: '16:9 (Widescreen)' },
        steps: { type: 'integer', default: 8 } };
      workflow.workflowApi = manifest;
    }
    await installReactHookDriver((initial) => initial === false ? true
      : initial && typeof initial === 'object' && 'fields' in initial ? { workflow, address: '', reload: 0, fields } : initial);
    installStoreMock(createStore([], () => 1));
    const Selector = (await import('../../../src/components/nodes/shared/CloudWorkflowParamSelector')).default;
    const onChange = vi.fn();
    const snapshot = structuredClone(workflow);
    const key = adapterType === 'comfyui' ? 'comfy-param::515::aspect_ratio'
      : adapterType === 'runninghub' ? '515::aspect_ratio' : 'workflow::aspect_ratio';
    const change = (values: Record<string, string>, disabled = false) => {
      const tree = Selector({ workflow, values, onChange, disabled });
      return findElement(tree, (element) => typeof element.props.onChange === 'function'
        && ('parameters' in element.props || 'manifest' in element.props)).props.onChange as (next: Record<string, string>) => void;
    };
    const original = { 'reference-input': '保留参考' };
    const selected = { ...original, [key]: '9:16 (Portrait Widescreen)' };
    change(original)(selected);
    expect(onChange).toHaveBeenLastCalledWith(selected, '9:16');
    change(selected)(original);
    expect(onChange).toHaveBeenLastCalledWith(original, '16:9');
    change(selected)({ ...selected });
    expect(onChange).toHaveBeenLastCalledWith(selected, '9:16');
    const stepKey = adapterType === 'comfyui' ? 'comfy-param::202::steps' : adapterType === 'runninghub' ? '202::steps' : 'workflow::steps';
    const stepped = { ...selected, [stepKey]: '25' };
    change(selected)(stepped);
    expect(onChange).toHaveBeenLastCalledWith(stepped, undefined);
    for (const value of ['auto', '0:1', 'bad ratio']) {
      const next = { ...selected, [key]: value };
      change(selected)(next);
      expect(onChange).toHaveBeenLastCalledWith(next, undefined);
    }
    if (adapterType === 'workflow-api') {
      change({ aspect_ratio: '9:16 (Portrait Widescreen)' })({});
      expect(onChange).toHaveBeenLastCalledWith({}, '16:9');
    }
    onChange.mockClear();
    change(original, true)(selected);
    expect(onChange).not.toHaveBeenCalled();
    expect(workflow).toEqual(snapshot);
  });

  it.each(['ai-image', 'ai-video'] as const)('%s 在一次连续编辑中同步工作流参数与比例，沿用节点尺寸规则并保留素材', async (type) => {
    await installReactHookDriver();
    const store = createStore([{ id: 'ratio-node', type, position: { x: 0, y: 0 },
      data: { type, prompt: '保留正文', status: 'idle', nodeWidth: 340, nodeHeight: 191,
        imageUrl: type === 'ai-image' ? 'blob:previous-image' : undefined,
        videoUrl: type === 'ai-video' ? 'blob:previous-video' : undefined } }], () => 1);
    store.activeNodeId = 'ratio-node';
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({ default: function PromptPanelMock() { return null; } }));
    vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [] }));
    const Dialog = await loadWorkflowEditingDialog();
    const panel = findElement(Dialog(), (element) => componentName(element) === 'PromptPanelMock');
    const values = { '515::aspect_ratio': '9:16 (Portrait Widescreen)' };
    (panel.props.onWorkflowInputsChange as (next: Record<string, string>, ratio?: string) => void)(values, '9:16');
    expect(store.updateNodeDataTransient).toHaveBeenCalledExactlyOnceWith('ratio-node', type === 'ai-image'
      ? { workflowInputs: values, aspectRatio: '9:16', nodeWidth: 158, nodeHeight: 280 }
      : { workflowInputs: values, aspectRatio: '9:16', seedanceRatio: '9:16' });
    expect(store.updateNodeData).not.toHaveBeenCalled();
    expect(store.commitToHistory).toHaveBeenCalledOnce();
    expect(store.nodes[0].data).toMatchObject({ prompt: '保留正文', workflowInputs: values, aspectRatio: '9:16',
      ...(type === 'ai-image' ? { imageUrl: 'blob:previous-image' } : { videoUrl: 'blob:previous-video', nodeWidth: 340, nodeHeight: 191 }) });
    (panel.props.onContinuousEditEnd as () => void)();
    expect(store.commitToHistory).toHaveBeenCalledTimes(2);
  });

  it('ComfyUI 顶部时长显示旧节点保存的通用值，显式工作流覆盖仍优先', async () => {
    const graph = { '9': { class_type: 'PrimitiveFloat', inputs: { value: 5 }, _meta: { title: '生成时长' } } };
    const workflow: WorkflowDefinition = { id: 'video', name: '视频', category: 'ai-video',
      fileName: 'video.json', fileContent: JSON.stringify(graph), createdAt: 0 };
    const fields: ComfyWorkflowParameter[] = [{ nodeId: '9', fieldName: 'value', classType: 'PrimitiveFloat',
      label: '生成时长 · value', type: 'number', defaultValue: 5 }];
    const specs = new Map([['PrimitiveFloat', { value: { type: 'FLOAT' } }]]);
    await installReactHookDriver((initial) => initial === false ? true
      : initial && typeof initial === 'object' && 'fields' in initial ? { workflow, address: '', reload: 0, fields, specs } : initial);
    installStoreMock(createStore([], () => 1));
    const Selector = (await import('../../../src/components/nodes/shared/CloudWorkflowParamSelector')).default;
    const render = vi.fn(() => null);
    const values = { 'comfy-param::9::value': '7' };

    Selector({ workflow, values, onChange: vi.fn(), videoParameters: { controls: { seedanceDuration: 9 }, render } });

    expect(render).toHaveBeenCalledExactlyOnceWith({
      ratio: null,
      resolution: null,
      duration: expect.objectContaining({
        props: expect.objectContaining({ parameters: [{ ...fields[0], defaultValue: 9 }], values }),
      }),
    });
    expect(JSON.parse(workflow.fileContent)).toEqual(graph);
    expect(fields[0].defaultValue).toBe(5);
  });

  it('dismisses node input outside its React subtree while preserving portal interactions and edits', async () => {
    const effects: Array<() => void | (() => void)> = [];
    await installReactHookDriver(undefined, effects);
    const store = createStore([{
      id: 'workflow-node', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', prompt: '保留输入', status: 'idle' },
    }], () => 1);
    store.activeNodeId = 'workflow-node';
    installStoreMock(store);
    vi.doMock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
    vi.doMock('../../../src/components/nodes/shared/PromptPanel', () => ({
      default: function PromptPanelMock() { return null; },
    }));
    vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), getPendingTasksForProject: () => [] }));
    const doc = Object.assign(new EventTarget(), document, { querySelector: () => null });
    // Node 的 EventTarget 移除布尔 capture 监听时与 DOM 不一致，显式归一化选项。
    const removeEventListener = doc.removeEventListener.bind(doc);
    doc.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions) => removeEventListener(type, listener,
      typeof options === 'boolean' ? { capture: options } : options);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', new EventTarget());
    const Dialog = await loadWorkflowEditingDialog();
    const tree = Dialog();
    const boundary = findElement(tree, (element) => element.props.className === 'contents');
    const capture = boundary.props.onPointerDownCapture as (event: { nativeEvent: Event }) => void;
    const panel = findElement(tree, (element) => componentName(element) === 'PromptPanelMock');
    const cleanups = effects.map((effect) => effect());
    vi.useFakeTimers();
    try {
      // 编辑器和挂到 body 的子菜单都沿 React 子树经过同一捕获边界。
      for (const target of ['editor', 'portal-menu']) {
        const event = new Event('pointerdown');
        Object.defineProperty(event, 'target', { value: { id: target } });
        doc.dispatchEvent(event);
        capture({ nativeEvent: event });
        event.stopPropagation();
        vi.runOnlyPendingTimers();
        expect(store.closeNodeDialog).not.toHaveBeenCalled();
      }
      (panel.props.onWorkflowInputsChange as (values: Record<string, string>) => void)({ parameter: '保留参数' });
      expect(store.commitToHistory).toHaveBeenCalledOnce();
      const outside = new Event('pointerdown', { cancelable: true });
      doc.dispatchEvent(outside);
      outside.stopPropagation();
      vi.runOnlyPendingTimers();
      expect(store.closeNodeDialog).toHaveBeenCalledOnce();
      expect(store.commitToHistory).toHaveBeenCalledTimes(2);
      expect(store.nodes[0].data).toMatchObject({ prompt: '保留输入', workflowInputs: { parameter: '保留参数' } });
      expect(outside.defaultPrevented).toBe(false);

      doc.dispatchEvent(new Event('pointerdown'));
      cleanups.forEach((cleanup) => { if (cleanup) cleanup(); });
      doc.dispatchEvent(new Event('pointerdown'));
      vi.runOnlyPendingTimers();
      expect(store.closeNodeDialog).toHaveBeenCalledOnce();
    } finally {
      cleanups.forEach((cleanup) => { if (cleanup) cleanup(); });
      vi.useRealTimers();
    }
  });

  it('keeps frame editor keyboard input from opening generation or modifying the canvas', async () => {
    const effects: Array<() => void | (() => void)> = [];
    await installReactHookDriver(undefined, effects);
    const store = createStore([{ id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 }, data: { type: 'ai-animation' } }], () => 1);
    store.selectedNodeIds = ['animation'];
    installStoreMock(store);
    const listeners = new Map<string, (event: unknown) => Promise<void>>();
    vi.stubGlobal('document', { addEventListener: (name: string, listener: (event: unknown) => Promise<void>) => listeners.set(name, listener), removeEventListener: vi.fn() });
    vi.doMock('../../../src/utils/assetSearchWindow', () => ({ openAssetSearchWindow: vi.fn() }));
    vi.doMock('../../../src/utils/nodeAnimations', () => ({ playNodeExit: vi.fn() }));
    vi.doMock('../../../src/services/pollManager', () => ({ ...mockComfyDeliveries(), cancelNodePolling: vi.fn() }));
    vi.doMock('@tauri-apps/plugin-global-shortcut', () => ({ unregisterAll: vi.fn() }));
    vi.doMock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => { throw new Error('Web test'); } }));
    const { useKeyboardShortcuts } = await import('../../../src/hooks/useKeyboardShortcuts');
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
    const AnimationNode = (await import('../../../src/components/nodes/AnimationNode')).default as unknown as (props: { id: string; data: Record<string, unknown>; selected: boolean }) => unknown;
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
    await installReactHookDriver((initial, index) => index % 4 === 3 ? previewState : initial, effects, undefined, setters);
    const node: TestNode = {
      id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 },
      data: { type: 'ai-animation', filePath: 'sprite.png', imageUrl: 'asset://original', animationPreviewMode: mode },
    };
    const store = createStore([node], () => 1);
    installStoreMock(store); installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({ Handle: function HandleMock() { return null; }, Position: { Left: 'left', Right: 'right' } }));
    const request = deferred<{ url: string; cols: number; rows: number; cellWidth: number; cellHeight: number; warnings: string[]; dispose: () => void }>();
    const prepare = vi.fn(() => request.promise);
    vi.doMock('../../../src/services/animationService', async () => ({
      ...await vi.importActual<typeof import('../../../src/services/animationService')>('../../../src/services/animationService'),
      prepareAnimationPreview: prepare,
    }));
    const AnimationNode = (await import('../../../src/components/nodes/AnimationNode')).default as unknown as (props: { id: string; data: Record<string, unknown> }) => unknown;
    const props = { id: node.id, data: node.data };
    const pending = AnimationNode(props);
    expect(findElement(pending, (element) => componentName(element) === 'AnimationNodePreview').props.displaySrc).toBeUndefined();
    expect(findElement(pending, (element) => componentName(element) === 'AnimationNodePreview').props.preparingPreview).toBe(true);
    const cleanup = effects[0]();
    const preview = { url: 'blob:transparent-cache', cols: 4, rows: 2, cellWidth: 96, cellHeight: 96, warnings: [], dispose: vi.fn() };
    request.resolve(preview);
    await request.promise;
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledExactlyOnceWith('sprite.png', expect.any(Object), expect.any(Object), 'project-a');
    previewState = setters[3].mock.calls[0][0];
    const ready = AnimationNode(props);
    expect(findElement(ready, (element) => componentName(element) === 'AnimationNodePreview').props.displaySrc).toBe(preview.url);
    // 相同路径在另一个项目，或换图/改处理参数，都不能沿用旧缓存或先闪原图。
    store.currentProjectId = 'project-b';
    expect(findElement(AnimationNode(props), (element) => componentName(element) === 'AnimationNodePreview').props.displaySrc).toBeUndefined();
    store.currentProjectId = 'project-a';
    for (const patch of [{ filePath: 'new-sprite.png' }, { animationProcessing: { chromaKey: 'green' } }]) {
      expect(findElement(AnimationNode({ ...props, data: { ...node.data, ...patch } }), (element) => componentName(element) === 'AnimationNodePreview').props.displaySrc).toBeUndefined();
    }
    cleanup?.();
    expect(preview.dispose).toHaveBeenCalledOnce();
    previewState = undefined;
    const remounted = AnimationNode(props);
    expect(findElement(remounted, (element) => componentName(element) === 'AnimationNodePreview').props.displaySrc).toBeUndefined();
    expect(findElement(remounted, (element) => componentName(element) === 'AnimationNodePreview').props.preparingPreview).toBe(true);
    expect(store.updateNodeDataTransient).not.toHaveBeenCalled();
    expect(store.commitToHistory).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses the original only without a local source or after preview failure (local: %s)', async (local) => {
    const effects: Array<() => void | (() => void)> = [];
    const setters: Array<ReturnType<typeof vi.fn>> = [];
    let previewState: unknown;
    await installReactHookDriver((initial, index) => index % 4 === 3 ? previewState : initial, effects, undefined, setters);
    const node: TestNode = {
      id: 'animation', type: 'ai-animation', position: { x: 0, y: 0 },
      data: { type: 'ai-animation', imageUrl: 'asset://original', ...(local ? { filePath: 'sprite.png' } : {}) },
    };
    installStoreMock(createStore([node], () => 1)); installCommonNodeMocks();
    vi.doMock('@xyflow/react', () => ({ Handle: function HandleMock() { return null; }, Position: { Left: 'left', Right: 'right' } }));
    const prepare = vi.fn().mockRejectedValue(new Error('preview unavailable'));
    vi.doMock('../../../src/services/animationService', async () => ({
      ...await vi.importActual<typeof import('../../../src/services/animationService')>('../../../src/services/animationService'),
      prepareAnimationPreview: prepare,
    }));
    const AnimationNode = (await import('../../../src/components/nodes/AnimationNode')).default as unknown as (props: { id: string; data: Record<string, unknown> }) => unknown;
    const props = { id: node.id, data: node.data };
    AnimationNode(props);
    effects[0]();
    if (local) {
      await Promise.resolve(); await Promise.resolve();
      previewState = setters[3].mock.calls[0][0];
    } else expect(prepare).not.toHaveBeenCalled();
    const tree = AnimationNode(props);
    expect(findElement(tree, (element) => componentName(element) === 'AnimationNodePreview').props.displaySrc).toBe('asset://original');
    if (local) expect(findElement(tree, (element) => element.props.className === 'animation-processing-hint').props.children).toBe('preview unavailable');
  });
  it('lets a custom Select type spaces and use input undo without triggering canvas shortcuts', async () => {
    const effects: Array<() => void | (() => void)> = [];
    await installReactHookDriver(undefined, effects);
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('window', { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: vi.fn() });
    const Select = (await import('../../../src/components/shared/Select')).default;
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
}
