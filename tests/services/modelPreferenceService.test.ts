/**
 * modelPreferenceService — 覆盖新建模型优先级、类型回退与损坏偏好的安全降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';
import { createWorkflowApiDraft } from '../../src/services/workflowApi/workflowApiDefinition';
import {
  getModelPreferenceType,
  getPreferredNodeModel,
  saveModelPreference,
  saveWorkflowModelPreference,
  pickWorkflowSizeInputs,
} from '../../src/services/modelPreferenceService';

const KEY = 'canvas-model-prefs';

function workflow(adapterType: WorkflowDefinition['adapterType'] = 'comfyui'): WorkflowDefinition {
  return { id: 'flow', name: '工作流', category: 'ai-image', adapterType, fileName: '', fileContent: '{}', createdAt: 1 };
}

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); });

describe('新建节点的模型默认值', () => {
  it.each(['ai-text', 'ai-audio'] as const)('%s 保留完整偏好身份，不挑选第一个通用模型', (type) => {
    localStorage.setItem(KEY, JSON.stringify({ [type]: 'general/second/model' }));
    expect(getPreferredNodeModel(type)).toEqual({ model: 'general/second/model', provider: 'general' });
  });

  it('当前项目默认优先，其他项目的配置不影响本次新建，也不覆盖全局偏好', () => {
    const preference = JSON.stringify({ 'ai-text': 'general/preference' });
    localStorage.setItem(KEY, preference);
    const context = {
      currentProjectId: 'current',
      projects: [
        { id: 'other', settings: { defaultModels: { text: 'general/other' } } },
        { id: 'current', settings: { defaultModels: { text: 'general/project' } } },
      ],
    };
    expect(getPreferredNodeModel('ai-text', context)).toEqual({ model: 'general/project', provider: 'general' });
    expect(getPreferredNodeModel('ai-text', { ...context, currentProjectId: 'missing' }))
      .toEqual({ model: 'general/preference', provider: 'general' });
    expect(localStorage.getItem(KEY)).toBe(preference);
  });

  it('项目默认工作流保留真实 workflowId，动画也采用项目图片默认', () => {
    localStorage.setItem(KEY, JSON.stringify({ 'ai-animation': 'general/remembered-animation' }));
    const context = { currentProjectId: 'project', projects: [
      { id: 'project', settings: { defaultModels: { image: 'comfyui/workflow-1' } } },
    ] };
    expect(getPreferredNodeModel('ai-animation', context)).toEqual({
      model: 'comfyui/workflow', provider: 'comfyui', workflowId: 'workflow-1',
    });
  });

  it.each([
    ['ai-panorama', 'ai-image'], ['ai-animation', 'ai-image'], ['ai-shotlist', 'ai-text'],
    ['source-text', 'ai-text'], ['ai-markdown', 'ai-text'], ['source-audio', 'ai-audio'],
  ] as const)('%s 复用 %s 的目录与兜底偏好', (type, fallback) => {
    localStorage.setItem(KEY, JSON.stringify({ [fallback]: 'general/fallback' }));
    expect(getModelPreferenceType(type)).toBe(fallback);
    expect(getPreferredNodeModel(type)).toEqual({ model: 'general/fallback', provider: 'general' });
  });

  it('独立动画偏好优先于图片兜底；损坏的独立条目不阻断有效兜底', () => {
    localStorage.setItem(KEY, JSON.stringify({ 'ai-animation': 'general/animation', 'ai-image': 'general/image' }));
    expect(getPreferredNodeModel('ai-animation')?.model).toBe('general/animation');
    localStorage.setItem(KEY, JSON.stringify({ 'ai-animation': { model: 'invalid' }, 'ai-image': 'general/image' }));
    expect(getPreferredNodeModel('ai-animation')?.model).toBe('general/image');
  });

  it.each(['null', '[]', 'false', '"general/text"', 'broken-json',
    '{"ai-text":0}', '{"ai-text":"/missing-provider"}', '{"ai-text":"general/"}',
  ])('损坏偏好 %s 不阻断节点创建，也不改写存储', (raw) => {
    localStorage.setItem(KEY, raw);
    expect(getPreferredNodeModel('ai-text')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(raw);
  });

  it('偏好读取不可用时仍可使用项目默认；没有项目默认时保持未选', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    expect(getPreferredNodeModel('ai-text')).toBeNull();
    expect(getPreferredNodeModel('ai-text', { currentProjectId: 'p', projects: [
      { id: 'p', settings: { defaultModels: { text: 'general/project' } } },
    ] })).toEqual({ model: 'general/project', provider: 'general' });
  });
});

describe('显式模型偏好的保存', () => {
  it.each([
    ['comfyui', 'comfyui/flow', 'comfyui/workflow', 'comfyui'],
    ['runninghub', 'runninghubwf/flow', 'runninghubwf/flow', 'runninghubwf'],
    ['workflow-api', 'workflow-api/flow', 'workflow-api/flow', 'workflow-api'],
  ] as const)('%s 记录完整工作流身份，重开后恢复且不依赖服务器在线', (adapter, stored, model, provider) => {
    const flow = workflow(adapter);
    saveWorkflowModelPreference('source-image', flow);
    expect(JSON.parse(localStorage.getItem(KEY)!)['ai-image']).toBe(stored);
    const context = { currentProjectId: null, projects: [], workflows: [flow] };
    expect(getPreferredNodeModel('ai-image', context)).toEqual({ model, provider, workflowId: 'flow' });
    expect(getPreferredNodeModel('ai-image', { ...context, workflows: [] })).toBeNull();
    expect(getPreferredNodeModel('ai-image', { ...context, workflows: [{ ...flow, category: 'ai-video' }] })).toBeNull();
    expect(getPreferredNodeModel('ai-image', { ...context, workflows: [workflow(adapter === 'comfyui' ? 'runninghub' : 'comfyui')] })).toBeNull();
    saveModelPreference('ai-image', 'general/next');
    expect(getPreferredNodeModel('ai-image', context)).toEqual({ model: 'general/next', provider: 'general' });
  });

  it('最近工作流不覆盖项目明确选择的模型，也不保存分类不匹配的选择', () => {
    const flow = workflow();
    saveWorkflowModelPreference('ai-image', flow);
    const saved = localStorage.getItem(KEY);
    saveWorkflowModelPreference('ai-video', flow);
    expect(localStorage.getItem(KEY)).toBe(saved);
    expect(getPreferredNodeModel('ai-image', { currentProjectId: 'p', workflows: [flow], projects: [
      { id: 'p', settings: { defaultModels: { image: 'general/project' } } },
    ] })).toEqual({ model: 'general/project', provider: 'general' });
  });

  it('源类型保存到生成类型，选图片时同步全景而保留独立动画选择', () => {
    localStorage.setItem(KEY, JSON.stringify({ 'ai-animation': 'general/animation', 'ai-audio': 'general/audio' }));
    saveModelPreference('source-image', 'general/image');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      'ai-animation': 'general/animation', 'ai-audio': 'general/audio',
      'ai-image': 'general/image', 'ai-panorama': 'general/image',
    });
  });

  it('损坏旧记录可以重新保存；空选择不清除或重新选择历史偏好', () => {
    localStorage.setItem(KEY, 'null');
    saveModelPreference('ai-text', 'general/text');
    saveModelPreference('ai-text', '');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ 'ai-text': 'general/text' });
  });

  it('偏好写入失败不向模型选择调用方抛错', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => saveModelPreference('ai-text', 'general/text')).not.toThrow();
  });
});

describe('工作流尺寸偏好白名单', () => {
  it('本地仅保存真实标量尺寸字段，排除连线、提示词、素材和种子', () => {
    const flow = { ...workflow(), fileContent: JSON.stringify({
      '515:1': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 4, multiple: 16 } },
      '801': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: ['515:1', 1], seed: 42, text: '旧提示词', image: 'old.png' } },
    }) };
    const sizes = { 'comfy-param::515%3A1::aspect_ratio': '9:16 (Portrait Widescreen)',
      'comfy-param::515%3A1::megapixels': '2.4', 'comfy-param::801::width': '768' };
    const values = { ...sizes, 'comfy-param::515%3A1::multiple': '32', 'comfy-param::801::height': '1360',
      'comfy-param::801::seed': '77', 'comfy-param::801::text': '新提示词', 'comfy-param::801::image': 'private.png',
      '515:1': '@{source:参考图}', 'comfy-param::missing::width': '1280' };
    const snapshot = structuredClone(flow);
    expect(pickWorkflowSizeInputs(flow, values)).toEqual(sizes);
    expect(pickWorkflowSizeInputs(flow, values, { ratio: true })).toEqual({
      'comfy-param::515%3A1::megapixels': '2.4', 'comfy-param::801::width': '768',
    });
    expect(flow).toEqual(snapshot);
    flow.fileContent = JSON.stringify({ '515:1': { inputs: { aspect_ratio: ['other', 0] } } });
    expect(pickWorkflowSizeInputs(flow, values)).toEqual({});
  });

  it('RH 沿用编码后的字段身份、原枚举和真实范围，尺寸标签不能把其他输入带入偏好', () => {
    const flow: WorkflowDefinition = { ...workflow('runninghub'), runninghub: {
      version: 1, kind: 'app', remoteId: '123', connectionId: 'runninghub', parameters: [
        { nodeId: '5:1', fieldName: 'ratio', label: '画面比例', type: 'string', defaultValue: '16:9', options: ['16:9', '9:16'], source: 'value' },
        { nodeId: '6', fieldName: 'resolution', label: '分辨率', type: 'number', defaultValue: 1.5, min: 0.2, max: 4, source: 'value' },
        { nodeId: '7', fieldName: 'width', label: '宽度', type: 'number', defaultValue: 512, inputType: 'prompt', source: 'value' },
        { nodeId: '8', fieldName: 'api_key', label: '分辨率', type: 'string', defaultValue: '', source: 'value' },
        { nodeId: '9', fieldName: 'image', label: '分辨率', type: 'string', defaultValue: '', source: 'image' },
      ],
    } };
    expect(pickWorkflowSizeInputs(flow, { '5%3A1::ratio': '9:16', '6::resolution': '4', '7::width': '768',
      '8::api_key': 'private', '9::image': 'input.png' })).toEqual({ '5%3A1::ratio': '9:16', '6::resolution': '4' });
    expect(pickWorkflowSizeInputs(flow, { '5%3A1::ratio': '21:9', '6::resolution': '10' })).toEqual({});
  });

  it('声明式 API 只继承尺寸，防止路径、素材引用或损坏旧值进入新节点', () => {
    const flow: WorkflowDefinition = { ...workflow('workflow-api'), workflowApi: {
      ...createWorkflowApiDraft().manifest, parameters: {
        resolution: { type: 'string', options: ['1K', '2K'] }, ratio: { type: 'string' },
        width: { type: 'integer', min: 64, max: 4096 }, seed: { type: 'integer' }, prompt: { type: 'string', label: '分辨率' },
      },
    } };
    const values = { 'workflow::resolution': '2K', 'workflow::ratio': '9:16', 'workflow::width': '768',
      'workflow::seed': '77', 'workflow::prompt': '正文', reference: '@{image:素材}' };
    expect(pickWorkflowSizeInputs(flow, values, { resolution: true })).toEqual({ 'workflow::ratio': '9:16' });
    expect(pickWorkflowSizeInputs(flow, { 'workflow::width': '0.5', 'workflow::ratio': '0:1', resolution: 'C:\\private.png' })).toEqual({});
    expect(pickWorkflowSizeInputs({ ...workflow(), fileContent: 'broken' }, values)).toEqual({});
    expect(pickWorkflowSizeInputs(flow, { 'workflow::ratio': 'https://example.com', 'workflow::width': Infinity })).toEqual({});
  });
});
