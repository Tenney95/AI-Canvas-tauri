import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';
import type { ComfyInputSpec } from '../../src/types/comfyWorkflow';
import { applyComfyWorkflowParameterOverrides, comfyWorkflowParameterKey, loadComfyWorkflowParameters, prepareComfyWorkflowParameterOverrides, splitComfyWorkflowInputs } from '../../src/services/comfyWorkflowParameters';

const graph = {
  '714': { class_type: 'PrimitiveStringMultiline', inputs: { value: '当前人物' } },
  '231': { class_type: 'CLIPTextEncode', inputs: { text: ['714', 0] } },
  '232': { class_type: 'CLIPTextEncode', inputs: { text: '原负面词' } },
  '202': { class_type: 'KSampler', inputs: { steps: 8, cfg: 1, denoise: 0.36, seed: 4, scheduler: 'normal', enabled: false, positive: ['231', 0], negative: ['232', 0] } },
  '235': { class_type: 'KSampler', inputs: { steps: 25 } },
  '515': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9', megapixels: 4, multiple: 16 } },
  '807': { class_type: 'H3OptionalPicture3', inputs: { image: '', upload: 'image' } },
};
const specs: Record<string, Record<string, ComfyInputSpec>> = {
  KSampler: { steps: { type: 'INT', min: 1, max: 100 }, cfg: { type: 'FLOAT', min: 0, max: 100 },
    denoise: { type: 'FLOAT', min: 0, max: 1, step: 0.01 }, seed: { type: 'INT', min: 0 },
    scheduler: { options: ['normal', 'simple', 'karras'] }, enabled: { type: 'BOOLEAN' } },
  CLIPTextEncode: { text: { type: 'STRING', multiline: true } },
  ResolutionSelector: { aspect_ratio: { options: ['16:9', '9:16'] }, megapixels: { type: 'FLOAT', min: 0.1, max: 16, step: 0.1 }, multiple: { type: 'INT', min: 8, max: 128, step: 4 } },
};
const workflow = (input: unknown = graph): WorkflowDefinition => ({ id: 'wf-local', name: '本地工作流', fileName: 'local.json',
  category: 'ai-image', fileContent: JSON.stringify(input), createdAt: 0, defaultNodes: { prompt: '714', image: '807' } });
const getSpecs = async (classType: string) => specs[classType] ?? null;
const key = (nodeId: string, fieldName: string) => comfyWorkflowParameterKey({ nodeId, fieldName });

describe('本地 ComfyUI 参数编辑', () => {
  it('DynamicCombo 的 task.text 与 task.prompt 不重复展示，旧覆盖不能盖过对话框正文', async () => {
    const local = workflow({ '714': { class_type: 'Speech', inputs: { 'task.text': '原台词', 'task.prompt': '原正文', 'task.description': '音色描述', speed: 1 } } });
    const fields = await loadComfyWorkflowParameters(local, async () => ({
      'task.text': { type: 'STRING' }, 'task.prompt': { type: 'STRING' }, 'task.description': { type: 'STRING' }, speed: { type: 'FLOAT' },
    }));
    expect(fields.map((field) => field.fieldName)).toEqual(['task.description', 'speed']);
    await expect(prepareComfyWorkflowParameterOverrides(local, { [key('714', 'task.text')]: '过期台词覆盖' }, getSpecs)).rejects.toThrow('参数已失效');
  });
  it('只展示已声明的标量，区分两轮步数，正文/媒体/连线不进入普通参数，负面可单独编辑', async () => {
    const original = workflow();
    const snapshot = structuredClone(original);
    const fields = await loadComfyWorkflowParameters(original, getSpecs);
    expect(fields.filter((field) => field.fieldName === 'steps').map((field) => [field.nodeId, field.defaultValue, field.type])).toEqual([['202', 8, 'integer'], ['235', 25, 'integer']]);
    expect(fields.find((field) => field.nodeId === '232')).toMatchObject({ fieldName: 'text', multiline: true });
    expect(fields.find((field) => field.fieldName === 'scheduler')?.options).toEqual(['normal', 'simple', 'karras']);
    expect(fields.find((field) => field.fieldName === 'megapixels')).toMatchObject({ min: 0.1, max: 16 });
    expect(fields.some((field) => ['714', '231', '807'].includes(field.nodeId))).toBe(false);
    expect(original).toEqual(snapshot);
  });

  it('普通参数与 @ 输入分离，数字、零和 false 保持实际类型，只改提交副本', async () => {
    const values = { '714': '本轮正文', [key('202', 'steps')]: '12', [key('235', 'steps')]: '30',
      [key('202', 'cfg')]: '0', [key('202', 'enabled')]: 'false', [key('202', 'scheduler')]: 'karras' };
    const split = splitComfyWorkflowInputs(values);
    expect(split.inputs).toEqual({ '714': '本轮正文' });
    const assignments = await prepareComfyWorkflowParameterOverrides(workflow(), split.parameters, getSpecs);
    const draft = structuredClone(graph);
    applyComfyWorkflowParameterOverrides(draft, assignments);
    expect(draft['202'].inputs).toMatchObject({ steps: 12, cfg: 0, enabled: false, scheduler: 'karras', positive: ['231', 0] });
    expect(draft['235'].inputs.steps).toBe(30);
    expect(graph['202'].inputs.steps).toBe(8);
    expect(splitComfyWorkflowInputs(undefined).inputs).toEqual({});
  });

  it.each([['steps', '0'], ['steps', '1.5'], ['seed', '9007199254740993'], ['denoise', '1.1'], ['cfg', ''], ['scheduler', 'invalid'], ['enabled', 'yes']])(
    '拒绝非法 %s=%s，不修正成其他值', async (fieldName, value) => {
      await expect(prepareComfyWorkflowParameterOverrides(workflow(), { [key('202', fieldName)]: value }, getSpecs)).rejects.toThrow();
    },
  );

  it('UI 步进不作为服务端整数倍限制；过期字段、改成连线和显式 @ 冲突拒绝', async () => {
    const assignments = await prepareComfyWorkflowParameterOverrides(workflow(), { [key('202', 'denoise')]: '0.365' }, getSpecs);
    expect(assignments[0].value).toBe(0.365);
    await expect(prepareComfyWorkflowParameterOverrides(workflow(), { [key('missing', 'steps')]: '12' }, getSpecs)).rejects.toThrow('参数已失效');
    await expect(prepareComfyWorkflowParameterOverrides(workflow({ ...graph, '235': { class_type: 'KSampler', inputs: { steps: ['202', 0] } } }), { [key('235', 'steps')]: '12' }, getSpecs)).rejects.toThrow('参数已失效');
    await expect(prepareComfyWorkflowParameterOverrides(workflow(), { [key('232', 'text')]: '普通负面覆盖' }, getSpecs, { '232': '显式负面' })).rejects.toThrow('已有显式 @ 输入');
  });

  it('副本目标变化与 H3 专用设置冲突不静默覆盖；写入前检查全部目标', async () => {
    const assignments = await prepareComfyWorkflowParameterOverrides(workflow(), { [key('202', 'steps')]: '12', [key('235', 'steps')]: '30' }, getSpecs);
    const draft: Record<string, { class_type: string; inputs: Record<string, unknown> }> = structuredClone(graph);
    draft['235'].inputs.steps = ['202', 0];
    expect(() => applyComfyWorkflowParameterOverrides(draft, assignments)).toThrow('C#235');
    expect(draft['202'].inputs.steps).toBe(8);
    draft['235'].inputs.steps = 25;
    applyComfyWorkflowParameterOverrides(draft, assignments);
    expect(() => applyComfyWorkflowParameterOverrides(draft, assignments, true)).not.toThrow();
    draft['235'].inputs.steps = 20;
    expect(() => applyComfyWorkflowParameterOverrides(draft, assignments, true)).toThrow('专用设置冲突');
  });

  it('不猜未知字段类型，不暴露路径/凭据/RefMod 控制；服务器声明改变按本次声明读取', async () => {
    const info = vi.fn(async (): Promise<Record<string, ComfyInputSpec>> => ({ secret: { type: 'STRING' }, directory: { type: 'STRING' },
      other: { type: 'CUSTOM' }, path_value: { type: 'STRING' }, count: { type: 'INT', max: 5 } }));
    const local = workflow({ '1': { class_type: 'Custom', inputs: { secret: 'hidden', directory: 'hidden', other: 'abc', path_value: 'hidden', count: 1 } },
      '2': { class_type: 'H3RefModLoader', inputs: { count: 1 } } });
    expect((await loadComfyWorkflowParameters(local, info)).map((field) => field.fieldName)).toEqual(['count']);
    info.mockResolvedValueOnce({ count: { type: 'INT', max: 2 } });
    expect((await loadComfyWorkflowParameters(local, info))[0].max).toBe(2);
    await expect(loadComfyWorkflowParameters(local, async () => null)).rejects.toThrow('参数声明');
  });
});
