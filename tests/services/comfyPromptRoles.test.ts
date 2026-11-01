import { describe, expect, it } from 'vitest';
import { inferComfyPromptRoles, workflowPromptRoles } from '../../src/services/comfyPromptRoles';
import type { WorkflowDefinition } from '../../src/types';

const graph = {
  '714': { class_type: 'PrimitiveStringMultiline', inputs: { value: '当前人物' } },
  '199': { class_type: 'CLIPTextEncode', inputs: { text: ['714', 0], clip: ['900', 0] }, _meta: { title: '负面（故意起错名）' } },
  '232': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: '正面（故意起错名）' } },
  '200': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['199', 0] } },
  '202': { class_type: 'KSampler', inputs: { positive: ['199', 0], negative: ['200', 0] } },
  '235': { class_type: 'KSamplerAdvanced', inputs: { positive: ['199', 0], negative: ['232', 0] } },
  '900': { class_type: 'PrimitiveString', inputs: { value: '这是模型输入，不是正文' } },
};

describe('ComfyUI 提示词用途识别', () => {
  it('按端口识别而非标题，回溯字符串原文；清零负面分支不污染正面用途，也不经过 CLIP 模型输入', () => {
    const before = JSON.stringify(graph);
    expect(Object.fromEntries(inferComfyPromptRoles(graph))).toEqual({ '714': 'positive', '199': 'positive', '232': 'negative' });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('同一字符串经不同编码节点进入正负两路时标记共用，条件合并保留两路来源', () => {
    const roles = inferComfyPromptRoles({
      ...graph,
      '232': { class_type: 'CLIPTextEncode', inputs: { text: ['714', 0] } },
      '240': { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['199', 0], conditioning_2: ['232', 0] } },
      '235': { class_type: 'SamplerCustom', inputs: { positive: ['240', 0], negative: ['232', 0] } },
    });
    expect(roles.get('714')).toBe('mixed');
    expect(roles.get('199')).toBe('positive');
    expect(roles.get('232')).toBe('mixed');
  });

  it('按多输出条件节点的具体槽位回溯，不把正负串线或把 latent/image 当作条件', () => {
    const roles = inferComfyPromptRoles({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '人物' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '模糊' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '非条件素材' } },
      '4': { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['1', 0], negative: ['2', 0], image: ['3', 0] } },
      '5': { class_type: 'InpaintModelConditioning', inputs: { positive: ['4', 0], negative: ['4', 1] } },
      '6': { class_type: 'CFGGuider', inputs: { positive: ['5', 0], negative: ['5', 1] } },
      '7': { class_type: 'KSampler', inputs: { positive: ['5', 2], negative: ['1', 1] } },
    });
    expect(Object.fromEntries(roles)).toEqual({ '1': 'positive', '2': 'negative' });
  });

  it('BasicGuider 的 conditioning 为正面；SDXL 双文本和 Flux 编码只回溯其已知文本字段', () => {
    const roles = inferComfyPromptRoles({
      '1': { class_type: 'PrimitiveString', inputs: { value: '正文' } },
      '2': { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: ['1', 0], text_l: '' } },
      '3': { class_type: 'FluxGuidance', inputs: { conditioning: ['2', 0] } },
      '4': { class_type: 'BasicGuider', inputs: { conditioning: ['3', 0] } },
      '5': { class_type: 'CLIPTextEncodeFlux', inputs: { clip_l: '', t5xxl: ['1', 0] } },
      '6': { class_type: 'BasicGuider', inputs: { conditioning: ['5', 0] } },
    });
    expect(Object.fromEntries(roles)).toEqual({ '1': 'positive', '2': 'positive', '5': 'positive' });
  });

  it('未知节点、伪装类名、断链及循环不猜用途，纯 UI 图也不按标签判断', () => {
    const roles = inferComfyPromptRoles({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '正文' } },
      '2': { class_type: 'UnknownConditioning', inputs: { conditioning: ['1', 0] } },
      '3': { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['3', 0], conditioning_2: ['404', 0] } },
      '4': { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['3', 0] } },
      '5': { class_type: 'CLIPTextEncodeHelper', inputs: { text: '辅助' } },
      '6': { class_type: 'BasicGuider', inputs: { conditioning: ['5', 0] } },
    });
    expect(roles.size).toBe(0);
    expect(inferComfyPromptRoles({ nodes: [{ id: 1, title: '正面提示词' }] }).size).toBe(0);
    expect(inferComfyPromptRoles(null).size).toBe(0);
  });

  it('本地旧记录由 API 图派生，云端只用字段身份元数据，换字段或无连线的旧记录保持未判定', () => {
    const workflow: WorkflowDefinition = { id: 'wf-test', name: '测试', category: 'ai-image', fileName: 'test.json', fileContent: JSON.stringify(graph), createdAt: 0 };
    expect(workflowPromptRoles(workflow).get('714')).toBe('positive');
    expect(workflowPromptRoles({ ...workflow, fileContent: 'broken JSON' }).size).toBe(0);
    const cloud: WorkflowDefinition = { ...workflow, adapterType: 'runninghub', fileContent: '', runninghub: {
      version: 1, kind: 'workflow', remoteId: '123', connectionId: 'runninghub', parameters: [],
      promptRoles: { '714::value': 'positive', '232::text': 'negative' },
    } };
    expect(workflowPromptRoles(cloud).get('714::value')).toBe('positive');
    expect(workflowPromptRoles(cloud).has('714::text')).toBe(false);
    expect(workflowPromptRoles({ ...cloud, runninghub: { ...cloud.runninghub!, promptRoles: undefined } }).size).toBe(0);
  });
});
