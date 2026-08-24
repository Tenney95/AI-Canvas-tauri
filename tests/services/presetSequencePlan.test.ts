import { describe, expect, it } from 'vitest';
import { buildPresetSequencePlan } from '../../src/services/presetSequenceService';
import { validatePresetAdvancedConfig } from '../../src/services/presetTemplateService';
import type { BaseNodeData, UserPreset } from '../../src/types';

const preset: UserPreset = {
  id: 'preset-1',
  nodeType: 'ai-image',
  name: '两步链',
  description: '',
  promptTemplate: '',
  triggerMode: 'direct',
  mode: 'advanced',
  advanced: {
    parameters: [],
    steps: [
      { id: 's1', name: '步骤 1', nodeType: 'ai-image', promptTemplate: '{{currentPrompt}} 放大' },
      { id: 's2', name: '步骤 2', nodeType: 'ai-image', promptTemplate: '再来一版' },
    ],
  },
};

const source = (data: Partial<BaseNodeData>, parentId?: string) => ({
  id: 'node-src',
  position: { x: 10, y: 20 },
  ...(parentId ? { parentId } : {}),
  data: {
    type: 'ai-image',
    label: '源图',
    role: 'source',
    status: 'success',
    prompt: '一只猫',
    ...data,
  } as BaseNodeData,
});

describe('buildPresetSequencePlan', () => {
  it('源节点在分组内时，派生节点继承 parentId，否则坐标会被当成绝对值', () => {
    const { nodes } = buildPresetSequencePlan({
      preset,
      sourceNode: source({}, 'group-1'),
      values: {},
    });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.parentId === 'group-1')).toBe(true);
  });

  it('不在分组内时不写 parentId', () => {
    const { nodes } = buildPresetSequencePlan({ preset, sourceNode: source({}), values: {} });
    expect(nodes[0].parentId).toBeUndefined();
  });

  it('provider=comfyui 时继承源节点 workflowId，步骤自带的优先', () => {
    const withWorkflow: UserPreset = {
      ...preset,
      advanced: {
        parameters: [],
        steps: [
          preset.advanced!.steps[0],
          { ...preset.advanced!.steps[1], provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf-step' },
        ],
      },
    };
    const { nodes } = buildPresetSequencePlan({
      preset: withWorkflow,
      sourceNode: source({ provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf-src' }),
      values: {},
    });
    expect(nodes[0].data.workflowId).toBe('wf-src');
    expect(nodes[1].data.workflowId).toBe('wf-step');
  });

  it('非 comfyui 步骤不带 workflowId', () => {
    const { nodes } = buildPresetSequencePlan({
      preset,
      sourceNode: source({ provider: 'apimart', model: 'z-image', workflowId: 'wf-src' }),
      values: {},
    });
    expect(nodes[0].data.workflowId).toBeUndefined();
  });
});

describe('composeStepPrompt / previousResult', () => {
  it('模板不写 previousResult 时，上一步引用仍然前置', () => {
    const { nodes } = buildPresetSequencePlan({ preset, sourceNode: source({}), values: {} });
    expect(nodes[0].data.prompt).toBe('@{node-src:源图}\n一只猫 放大');
  });

  it('模板写了 {{previousResult}} 就按写的位置插入，不再前置', () => {
    const withSlot: UserPreset = {
      ...preset,
      advanced: {
        parameters: [],
        steps: [{
          id: 's1',
          name: '步骤 1',
          nodeType: 'ai-image',
          promptTemplate: '参考 {{previousResult}} 的构图，主体换成狗',
        }],
      },
    };
    const { nodes } = buildPresetSequencePlan({ preset: withSlot, sourceNode: source({}), values: {} });
    expect(nodes[0].data.prompt).toBe('参考 @{node-src:源图} 的构图，主体换成狗');
  });
});

describe('validatePresetAdvancedConfig', () => {
  it('参数变量名占用内置变量时报错', () => {
    const errors = validatePresetAdvancedConfig({
      parameters: [{ id: 'p1', key: 'previousResult', label: '风格', type: 'text' }],
      steps: preset.advanced!.steps,
    });
    expect(errors[0]).toContain('内置变量');
  });

  it('{{previousResult}} 是合法变量，不算未定义', () => {
    const errors = validatePresetAdvancedConfig({
      parameters: [],
      steps: [{ id: 's1', name: '步骤 1', nodeType: 'ai-image', promptTemplate: '{{previousResult}} 放大' }],
    });
    expect(errors).toEqual([]);
  });
});
