/**
 * presetNodeWorkflow — 回归用例：预设派生节点的模型、素材引用及文本/音视频工具栏执行边界。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresetNode, executeToolbarPreset, resolveEffectiveModel, resolvePresetAction, resolvePresetDef } from '../../src/components/nodes/shared/toolbar/presetAction';
import type { BaseNodeData, UserPreset } from '../../src/types';
import { useAppStore } from '../../src/store/useAppStore';
import * as generationService from '../../src/services/generationService';

const source = (data: Partial<BaseNodeData>) => ({
  id: 'node-src',
  position: { x: 0, y: 0 },
  data: {
    type: 'ai-image',
    label: '源图',
    role: 'source',
    status: 'success',
    ...data,
  } as BaseNodeData,
});

const resolved = { label: '摄影机视角', icon: 'mdi:camera-control', filledPrompt: '低角度镜头', shouldTrigger: true };

it('双面部特写预设沿用原快捷指令 ID，并将横版源图切换为 4:5 竖幅', () => {
  const action = resolvePresetAction('char-three-view-face', 'ai-image', '参考人物穿棕色外套', []);
  expect(action).not.toBeNull();
  expect(resolvePresetDef('char-three-view-face', 'ai-image', [])?.label).toBe('人物三视图＋双面部特写');
  expect(action!.shouldTrigger).toBe(true);
  expect(action!.filledPrompt).toContain('上二下三的两排布局');
  expect(action!.filledPrompt).toContain('正面面部特写、侧面面部特写');
  expect(action!.filledPrompt).toContain('正面、严格90度侧面、背面身体图');
  expect(action!.filledPrompt).toContain('下排三列统一从颈根裁切至脚底');
  expect(action!.filledPrompt).toContain('背面同样不显示头部，不转头露出侧脸');
  expect(action!.filledPrompt).toContain('同一高度、距离和缩放下原地转向');
  expect(action!.filledPrompt).toContain('整张图恰好只有两个可见头部，且全部位于上排');
  expect(action!.filledPrompt).toContain('下排三格的上沿与这条分隔线重合');
  expect(action!.filledPrompt).toContain('左下正面格：只显示颈根');
  expect(action!.filledPrompt).toContain('中下侧面格：严格90度侧身，从颈根到脚底');
  expect(action!.filledPrompt).toContain('右下背面格：从后颈根部到脚底');
  expect(action!.filledPrompt).toContain('所有格子统一使用中性灰无缝摄影棚背景与同色地面');
  expect(action!.filledPrompt).toContain("Enhance the portrait while strictly preserving the subject's identity");
  expect(action!.filledPrompt).toContain('Sony Al +85mm f1.4');
  expect(action!.filledPrompt).toContain('real skin texture (not plastic), and subtle film grain');
  expect(action!.filledPrompt).toContain('多视图适配（优先于上段通用肖像要求）');
  expect(action!.filledPrompt.indexOf('多视图适配（优先于上段通用肖像要求）'))
    .toBeGreaterThan(action!.filledPrompt.indexOf('No over-smooth skin.'));
  expect(action!.filledPrompt).not.toContain('clean illustration, smooth shading');
  expect(action!.filledPrompt).not.toContain('Negative quality instructions: no noise, no grain');
  expect(action!.filledPrompt).not.toContain('白色或浅灰');
  expect(action!.filledPrompt).not.toContain('背面保留完整头部');
  expect(action!.filledPrompt).not.toContain('下排三张只展示肩部到脚底');
  expect(action!.filledPrompt).toContain('参考人物穿棕色外套');
  const { node, edge } = createPresetNode(source({
    model: 'gpt-image-2', provider: 'apimart', aspectRatio: '16:9', imageSize: '2K',
  }), action!);
  expect(node.data).toMatchObject({
    label: '人物三视图＋双面部特写', aspectRatio: '4:5', nodeWidth: 224, nodeHeight: 280,
    model: 'gpt-image-2', provider: 'apimart', imageSize: '2K',
  });
  expect(edge.source).toBe('node-src');
  expect(edge.target).toBe(node.id);
});

describe('createPresetNode 派生 ComfyUI 工作流节点', () => {
  it.each([
    ['source-text', 'ai-text'], ['source-image', 'ai-image'], ['source-video', 'ai-video'],
    ['source-audio', 'ai-audio'], ['ai-markdown', 'ai-text'],
  ] as const)('%s 的快捷指令创建 %s 生成节点，同时保留原始素材', (type, generationType) => {
    const original = source({ type, model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'original-workflow',
      output: '原始内容', assetId: 'asset-1', filePath: 'original.file' });
    const { node, edge } = createPresetNode(original, resolved);
    expect(node).toMatchObject({ type: generationType, data: { type: generationType, role: 'generator',
      model: 'comfyui/workflow', workflowId: 'original-workflow', prompt: '@{node-src:源图}\n低角度镜头' } });
    expect(node.data.output).toBeUndefined(); expect(node.data.assetId).toBeUndefined(); expect(node.data.filePath).toBeUndefined();
    expect(original.data).toMatchObject({ type, role: 'source', output: '原始内容', assetId: 'asset-1', filePath: 'original.file' });
    expect(edge).toMatchObject({ source: original.id, target: node.id });
    expect(resolveEffectiveModel(type, original.data)).toEqual({ model: 'comfyui/workflow', provider: 'comfyui' });
  });

  it('provider=comfyui 时继承 workflowId，但不继承 workflowInputs', () => {
    const { node } = createPresetNode(
      source({
        model: 'comfyui/workflow',
        provider: 'comfyui',
        workflowId: 'wf-flux-img2img',
        workflowInputs: { '14': '旧的 IO 赋值' },
      }),
      resolved,
    );

    expect(node.data.workflowId).toBe('wf-flux-img2img');
    expect(node.data.workflowInputs).toBeUndefined();
  });

  it('非 comfyui 模型不带上 workflowId', () => {
    const { node } = createPresetNode(
      source({ model: 'z-image', provider: 'apimart', workflowId: 'wf-flux-img2img' }),
      resolved,
    );

    expect(node.data.workflowId).toBeUndefined();
  });

  it('prompt 前置 @ 引用源节点，参考图才能进工作流', () => {
    const { node } = createPresetNode(source({ model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'wf-1' }), resolved);
    expect(node.data.prompt).toBe('@{node-src:源图}\n低角度镜头');
  });
});

describe.each(['ai-text', 'ai-audio', 'ai-video'] as const)('%s 工具栏预设执行', (nodeType) => {
  const preset: UserPreset = {
    id: 'toolbar-preset', nodeType, name: '旧预设', description: '',
    promptTemplate: '旧模板', triggerMode: 'direct',
  };

  beforeEach(() => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      nodes: [source({ type: nodeType, prompt: '旧提示词',
        model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'wf-toolbar' })],
      userPresets: [preset],
    }, true);
    vi.spyOn(generationService, 'executeGeneration').mockResolvedValue({ success: true });
  });

  afterEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it.each(['direct', 'insertPrompt'] as const)('使用最新内容和 %s 模板，只创建及生成一次', (triggerMode) => {
    const original = useAppStore.getState().nodes[0];
    const livePrompt = '最新提示词 @{reference:参考素材}';
    const liveSource = { ...original, data: { ...original.data, label: '最新素材', prompt: livePrompt } };
    useAppStore.setState({
      nodes: [liveSource],
      userPresets: [{ ...preset, name: '新版预设', promptTemplate: '新版 {{currentPrompt}}', triggerMode }],
    });

    executeToolbarPreset(preset.id, nodeType, original.id);

    const state = useAppStore.getState();
    expect(state.nodes).toHaveLength(2);
    const generated = state.nodes.find((node) => node.id !== original.id)!;
    const filled = `新版 ${livePrompt}`;
    const prompt = `@{${original.id}:最新素材}\n${triggerMode === 'direct' ? filled : `${livePrompt}\n${filled}`}`;
    expect(generated.data).toMatchObject({ type: nodeType, label: '新版预设', prompt,
      role: 'generator', model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'wf-toolbar' });
    expect(state.nodes[0]).toEqual(liveSource);
    expect(state.edges).toMatchObject([{ source: original.id, target: generated.id }]);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].nodes).toEqual([liveSource]);
    expect(generationService.executeGeneration).toHaveBeenCalledTimes(1);
    expect(generationService.executeGeneration).toHaveBeenCalledWith(
      generated.id, prompt, undefined, expect.objectContaining({ prompt, workflowId: 'wf-toolbar' }),
    );
  });

  it('顺序预设只请求运行配置，不提前创建节点或生成', () => {
    useAppStore.setState({ userPresets: [{ ...preset, mode: 'advanced', advanced: {
      parameters: [], steps: [{ id: 'step-1', name: '步骤一', nodeType, promptTemplate: '生成内容' }],
    } }] });
    const nodes = useAppStore.getState().nodes;

    executeToolbarPreset(preset.id, nodeType, 'node-src');

    const state = useAppStore.getState();
    expect(state.presetRunRequest).toEqual({ presetId: preset.id, sourceNodeId: 'node-src' });
    expect(state.nodes).toEqual(nodes);
    expect(state.edges).toEqual([]);
    expect(state.history).toEqual([]);
    expect(generationService.executeGeneration).not.toHaveBeenCalled();
  });

  it('预设或源节点已删除时，不创建节点或发起生成', () => {
    executeToolbarPreset('deleted-preset', nodeType, 'node-src');
    expect(useAppStore.getState().nodes).toHaveLength(1);
    useAppStore.setState({ nodes: [] });
    executeToolbarPreset(preset.id, nodeType, 'node-src');

    const state = useAppStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.presetRunRequest).toBeNull();
    expect(generationService.executeGeneration).not.toHaveBeenCalled();
  });
});
