/**
 * cloudWorkflowParameterField — 回归测试：云工作流参数默认展示。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CloudWorkflowParameterField from '../../src/components/nodes/shared/CloudWorkflowParameterField';
import RunningHubParameterFields from '../../src/components/nodes/shared/RunningHubParameterFields';
import WorkflowApiParameterFields from '../../src/components/nodes/shared/WorkflowApiParameterFields';
import { createWorkflowApiDraft } from '../../src/services/workflowApi/workflowApiDefinition';
import type { RunningHubParameter } from '../../src/types/runninghub';
import ComfyWorkflowParameterFields from '../../src/components/nodes/shared/ComfyWorkflowParameterFields';
import type { ComfyWorkflowParameter } from '../../src/types/comfyWorkflow';
import { WORKFLOW_RANDOM_SEED } from '../../src/services/workflowSeed';

const ignoreChange = () => undefined;

describe('云工作流参数默认展示', () => {
  it('工作流种子默认显示随机且不暴露模式标记，固定输入与普通模型控件保留', () => {
    const parameters: RunningHubParameter[] = [{ nodeId: '202', fieldName: 'seed', label: 'K采样器 · SEED',
      type: 'number', defaultValue: 42, source: 'value', min: 0, max: 99 }];
    const random = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} appearance="popover" onChange={ignoreChange} />);
    expect(random).toMatch(/aria-pressed="true"[^>]*>随机<\/button>/);
    expect(random).toContain('每次生成时随机'); expect(random).not.toContain(WORKFLOW_RANDOM_SEED);
    const fixed = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} appearance="popover" values={{ '202::seed': '0' }} onChange={ignoreChange} />);
    expect(fixed).toMatch(/aria-pressed="true"[^>]*>固定<\/button>/); expect(fixed).toContain('value="0"');
    const plain = renderToStaticMarkup(<CloudWorkflowParameterField name="seed" label="种子" type="integer" value="42" onChange={ignoreChange} />);
    expect(plain).not.toContain('种子模式'); expect(plain).toContain('value="42"');
    const speech = renderToStaticMarkup(<ComfyWorkflowParameterFields parameters={[{ nodeId: '3', classType: 'FB_Qwen3TTSVoiceClone',
      fieldName: 'seed', label: '固定种子', type: 'integer', defaultValue: 42, dedicatedSeedControl: true }]} values={{}} onChange={ignoreChange} />);
    expect(speech).not.toContain('种子模式'); expect(speech).toContain('value="42"');
  });

  it('本地内部批量大于一时明确提示当前只接收首份，不把批量数量等同于画布节点数', () => {
    const parameters: ComfyWorkflowParameter[] = [{ nodeId: '801', classType: 'EmptyLatentImage', fieldName: 'batch_size',
      label: '空 Latent · batch_size', type: 'integer', defaultValue: 1, min: 1, max: 64 }];
    const original = renderToStaticMarkup(<ComfyWorkflowParameterFields parameters={parameters} values={{}} onChange={ignoreChange} />);
    expect(original).not.toContain('当前画布只接收首份产物');
    const batch = renderToStaticMarkup(<ComfyWorkflowParameterFields parameters={parameters} values={{ 'comfy-param::801::batch_size': '3' }} onChange={ignoreChange} />);
    expect(batch).toContain('当前画布只接收首份产物');
    expect(batch).toContain('C#801'); expect(batch).toContain('value="3"');
  });
  it('RH 默认字符串正文不在参数浮层重复编辑，负面仍可调，导入表单仍保留原定义', () => {
    const parameters: RunningHubParameter[] = [
      { nodeId: '714', fieldName: 'value', label: '字符串（多行） · value', type: 'string', defaultValue: '原正文', source: 'value', inputType: 'prompt' },
      { nodeId: '232', fieldName: 'text', label: '负面提示词', type: 'string', defaultValue: '低清晰度', source: 'value', inputType: 'prompt' },
    ];
    const html = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} defaultPromptKey="714::value" appearance="popover" onChange={ignoreChange} />);
    expect(html).not.toContain('原正文'); expect(html).not.toContain('C#714');
    expect(html).toContain('低清晰度'); expect(html).toContain('C#232');
    const form = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} defaultPromptKey="714::value" onChange={ignoreChange} />);
    expect(form).toContain('原正文');
    const legacy = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} appearance="popover" onChange={ignoreChange} />);
    expect(legacy).toContain('C#714');
  });
  it('RH 与本地字段使用 C# 节点标记区分同名步数，本地沿用排序、下拉和原参数身份', () => {
    const local: ComfyWorkflowParameter[] = [
      { nodeId: '202', fieldName: 'scheduler', classType: 'KSampler', label: 'K采样器 · scheduler', type: 'string', defaultValue: 'normal', options: ['normal', 'karras'] },
      { nodeId: '202', fieldName: 'steps', classType: 'KSampler', label: 'K采样器 · steps', type: 'integer', defaultValue: 8, min: 1, max: 100 },
      { nodeId: '235', fieldName: 'steps', classType: 'KSampler', label: 'K采样器 · steps', type: 'integer', defaultValue: 25, min: 1, max: 100 },
    ];
    const snapshot = structuredClone(local);
    const html = renderToStaticMarkup(<ComfyWorkflowParameterFields parameters={local} values={{}} onChange={ignoreChange} />);
    expect(html).toContain('C#202'); expect(html).toContain('C#235');
    expect(html.indexOf('value="8"')).toBeLessThan(html.indexOf('value="25"'));
    expect(html.indexOf('value="25"')).toBeLessThan(html.indexOf('scheduler'));
    expect(html).toContain('K采样器 · scheduler · C#202');
    expect(local).toEqual(snapshot);
    const cloud = renderToStaticMarkup(<RunningHubParameterFields parameters={[
      { nodeId: '235', fieldName: 'steps', label: 'K采样器 · steps', type: 'number', defaultValue: 25, source: 'value' },
    ]} appearance="popover" onChange={ignoreChange} />);
    expect(cloud).toContain('C#235');
  });
  it('RunningHub 浮层将常用参数置顶，原定义与同类参数顺序保持', () => {
    const parameters: RunningHubParameter[] = [
      { nodeId: '197', fieldName: 'device', label: 'CLIP加载器 · DEVICE', type: 'string', defaultValue: 'default', source: 'value' },
      { nodeId: '202', fieldName: 'steps', label: '一采 · STEPS', type: 'number', defaultValue: 8, source: 'value' },
      { nodeId: '515', fieldName: 'aspect_ratio', label: '分辨率选择器 · ASPECT_RATIO', type: 'string', defaultValue: '21:9 (Ultrawide)', source: 'value' },
      { nodeId: '515', fieldName: 'megapixels', label: '分辨率选择器 · MEGAPIXELS', type: 'number', defaultValue: 4, source: 'value' },
      { nodeId: '235', fieldName: 'steps', label: '二采 · STEPS', type: 'number', defaultValue: 25, source: 'value' },
      { nodeId: '201', fieldName: 'vae_name', label: 'VAE加载器 · VAE_NAME', type: 'string', defaultValue: 'flux2-vae.safetensors', source: 'value' },
    ];
    const snapshot = structuredClone(parameters);
    const html = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} appearance="popover" onChange={ignoreChange} />);
    const labels = ['分辨率选择器 · MEGAPIXELS', '分辨率选择器 · ASPECT_RATIO', '一采 · STEPS', '二采 · STEPS', 'CLIP加载器 · DEVICE', 'VAE加载器 · VAE_NAME'];
    labels.forEach((label, index) => {
      expect(html.indexOf(label)).toBeGreaterThan(-1);
      if (index > 0) expect(html.indexOf(label)).toBeGreaterThan(html.indexOf(labels[index - 1]));
    });
    expect(parameters).toEqual(snapshot);
    const form = renderToStaticMarkup(<RunningHubParameterFields parameters={parameters} onChange={ignoreChange} />);
    expect(form.indexOf('CLIP加载器 · DEVICE')).toBeLessThan(form.indexOf('一采 · STEPS'));
  });

  it('声明式云工作流只排序浮层，编辑表单和参数键保持原顺序', () => {
    const { manifest } = createWorkflowApiDraft();
    manifest.parameters = {
      device: { type: 'string', label: '设备', default: 'default' },
      steps: { type: 'integer', label: '总步数', default: 12 },
      aspect_ratio: { type: 'string', label: '画面比例', default: '16:9', options: ['16:9', '9:16'] },
      resolution: { type: 'number', label: '分辨率', default: 1.5 },
    };
    const html = renderToStaticMarkup(<WorkflowApiParameterFields manifest={manifest} appearance="popover" onChange={ignoreChange} />);
    expect(html.indexOf('分辨率')).toBeLessThan(html.indexOf('画面比例'));
    expect(html.indexOf('画面比例')).toBeLessThan(html.indexOf('总步数'));
    expect(html.indexOf('总步数')).toBeLessThan(html.indexOf('设备'));
    expect(Object.keys(manifest.parameters)).toEqual(['device', 'steps', 'aspect_ratio', 'resolution']);
    const form = renderToStaticMarkup(<WorkflowApiParameterFields manifest={manifest} onChange={ignoreChange} />);
    expect(form.indexOf('设备')).toBeLessThan(form.indexOf('总步数'));
  });

  it('旧分辨率选择器显示八种带图标的比例卡片，不重复显示只读当前值', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="aspect_ratio" label="分辨率选择器 · ASPECT_RATIO" type="string"
      value="21:9 (Ultrawide)" onChange={ignoreChange} />);
    expect(html.match(/class="img-rp-ratio-item /g)).toHaveLength(8);
    expect(html).toContain('title="21:9 (Ultrawide)" aria-pressed="true"');
    expect(html).toContain('title="16:9 (Widescreen)" aria-pressed="false"');
    expect(html.match(/<svg /g)).toHaveLength(8);
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('<output');
    expect(html).not.toContain('自适应');
  });

  it('未知比例保留原值且不自动选中，已有枚举限制与禁用状态保持', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="aspect_ratio" label="分辨率选择器 · aspect_ratio" type="string"
      value="2:1 (Custom)" options={['16:9 (Widescreen)', '9:16 (Portrait)']} disabled onChange={ignoreChange} />);
    expect(html.match(/class="img-rp-ratio-item /g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('当前值：2:1 (Custom)');
  });

  it('未知节点没有枚举时保留可编辑比例输入，不伪造允许选项', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="aspect_ratio" label="自定义节点 · aspect_ratio" type="string"
      value="2:1" onChange={ignoreChange} />);
    expect(html).toContain('type="text"');
    expect(html).toContain('value="2:1"');
    expect(html).not.toContain('img-rp-ratio-item');
  });

  it('倍数 16 使用原版数值输入，百万像素不再受 H3 通用范围限制', () => {
    const multiple = renderToStaticMarkup(<CloudWorkflowParameterField name="multiple" label="分辨率选择器 · MULTIPLE" type="number"
      value="16" onChange={ignoreChange} />);
    expect(multiple).toContain('type="number"');
    expect(multiple).toContain('value="16"');
    expect(multiple).toContain('min="8" max="128" step="4"');
    expect(multiple).not.toContain('type="range"');
    expect(multiple).not.toContain('不在滑块范围');
    const megapixels = renderToStaticMarkup(<CloudWorkflowParameterField name="megapixels" label="分辨率选择器 · MEGAPIXELS" type="number"
      value="4" onChange={ignoreChange} />);
    expect(megapixels).toContain('min="0.1" max="16"');
  });

  it('时长只显示滑块和默认值，不再提供数值输入或区间编辑', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="duration" label="时长" type="number"
      value="" defaultValue={12} min={4} max={30} displayDefaultWhenEmpty onChange={ignoreChange} />);
    const sliderInput = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('调整滑块区间');
    expect(sliderInput).toContain('value="12"');
    expect(sliderInput).not.toContain('disabled=""');
  });

  it('声明式文本默认值不妨碍清空后重新输入', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="scheduler" label="调度器" type="string"
      value="" defaultValue="simple" displayDefaultWhenEmpty onChange={ignoreChange} />);
    expect(html).toContain('placeholder="simple"');
    expect(html).toContain('value=""');
    expect(html).not.toContain('value="simple"');
  });

  it('声明式枚举默认 0 和 false 保持选中态', () => {
    const zero = renderToStaticMarkup(<CloudWorkflowParameterField name="seed" label="种子" type="number"
      value="" defaultValue={0} options={[0, 1]} displayDefaultWhenEmpty onChange={ignoreChange} />);
    const falseValue = renderToStaticMarkup(<CloudWorkflowParameterField name="enabled" label="声音" type="boolean"
      value="" defaultValue={false} displayDefaultWhenEmpty onChange={ignoreChange} />);
    expect(zero).toContain('title="0" aria-pressed="true"');
    expect(falseValue).toContain('title="false" aria-pressed="true"');
  });

  it('RunningHub 显式空串不会被默认值重新选中', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="duration" label="时长" type="number"
      value="" defaultValue={12} min={4} max={30} onChange={ignoreChange} />);
    const sliderInput = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(sliderInput).toContain('disabled=""');
    expect(sliderInput).not.toContain('value="12"');
    expect(html).toContain('未填写；请选择刻度设置。');
  });

  it('合法的非步长倍数保留精确值，不让滑块自动显示为相邻值', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="resolution" label="分辨率" type="number"
      value="1.6" min={1} max={2} step={0.5} onChange={ignoreChange} />);
    const sliderInput = html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(sliderInput).toContain('value="1.6"');
    expect(sliderInput).toContain('step="any"');
    expect(sliderInput).toContain('disabled=""');
    expect(html).toContain('原值保留；选择刻度后可拖动调整');
  });

  it('数值型分辨率使用固定端点，普通数字字段仍可输入', () => {
    const resolution = renderToStaticMarkup(<CloudWorkflowParameterField name="resolution" label="分辨率" type="number"
      value="1.5" onChange={ignoreChange} />);
    const sliderInput = resolution.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
    expect(sliderInput).toContain('min="0.2"');
    expect(sliderInput).toContain('max="4"');
    expect(resolution).not.toContain('type="number"');
    const seed = renderToStaticMarkup(<CloudWorkflowParameterField name="seed" label="种子" type="number" value="0" onChange={ignoreChange} />);
    expect(seed).toContain('type="number"');
    expect(seed).toContain('value="0"');
  });

  it('固定范围没有默认值时仍能通过唯一刻度填写', () => {
    const html = renderToStaticMarkup(<CloudWorkflowParameterField name="duration" label="时长" type="integer"
      value="" min={2} max={2} onChange={ignoreChange} />);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>2<\/button>/);
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('当前参数范围不可用');
  });
});
