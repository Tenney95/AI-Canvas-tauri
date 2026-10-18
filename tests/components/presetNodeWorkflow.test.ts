import { describe, expect, it } from 'vitest';
import { createPresetNode, resolveEffectiveModel, resolvePresetAction, resolvePresetDef } from '../../src/components/nodes/shared/toolbar/presetAction';
import type { BaseNodeData } from '../../src/types';

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
  expect(action!.filledPrompt).toContain('正面身体图、90度侧面身体图、背面身体图');
  expect(action!.filledPrompt).toContain('下排左列（正面）：只展示颈部到脚底');
  expect(action!.filledPrompt).toContain('下排中列（侧面）：90度正侧面，同样只展示颈部到脚底');
  expect(action!.filledPrompt).toContain('下排右列（背面）：背面保留完整头部，头顶到脚底完整入画');
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
