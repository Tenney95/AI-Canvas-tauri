import { describe, expect, it } from 'vitest';
import { RUNNINGHUB_MODEL_MANIFEST, RUNNINGHUB_LEGACY_MODELS, getRunningHubModel, parseRunningHubModelParameter } from '../../src/services/ai/providers/runninghubModelManifest';
import { defaultModelGroups, getConfiguredModelGroups } from '../../src/components/nodes/shared/defaultModels';
import { fetchProviderModelCatalog } from '../../src/services/ai/providerCatalogService';
import { getImageCapability } from '../../src/services/ai/mediaModelCapabilities';
import type { AppConfig } from '../../src/types';

describe('RunningHub 标准模型目录', () => {
  it('347 个媒体操作有唯一合同、官方来源及正确输出菜单', () => {
    expect(RUNNINGHUB_MODEL_MANIFEST).toHaveLength(347);
    expect(new Set(RUNNINGHUB_MODEL_MANIFEST.map((model) => model.id)).size).toBe(347);
    const options = defaultModelGroups.find((group) => group.id === 'runninghub')!.models;
    for (const model of RUNNINGHUB_MODEL_MANIFEST) {
      expect(model.source).toMatch(/^https:\/\/www\.runninghub\.(cn|ai)\//);
      expect(model.id).not.toMatch(/deprecated|voice-clone|kling-elements|files-upload/);
      expect(options.find((option) => option.value === `runninghub/${model.id}`)?.nodeTypes).toEqual([`ai-${model.kind}`]);
      expect(new Set(model.parameters.map((field) => field.name)).size).toBe(model.parameters.length);
    }
  });
  it.each(RUNNINGHUB_MODEL_MANIFEST.map((model) => [model.id, model] as const))('%s 默认值满足声明限制', (_id, model) => {
    for (const field of model.parameters) {
      if (field.defaultValue !== undefined) {
        expect(() => parseRunningHubModelParameter(field), `${model.id}/${field.name}`).not.toThrow();
        expect(JSON.stringify(field.defaultValue)).not.toMatch(/https?:|Bearer /);
      }
    }
  });
  it('七个旧 ID 保留组合模式，新操作不随参考图自动改道', () => {
    for (const [id, variants] of Object.entries(RUNNINGHUB_LEGACY_MODELS)) {
      expect(getRunningHubModel(`runninghub/${id}`)?.id).toBe(variants[0]);
      expect(getRunningHubModel(`runninghub-model/${id}`, true)?.id).toBe(variants.at(-1));
    }
    const id = 'seedream-v5-pro/text-to-image';
    expect(getRunningHubModel(`runninghub/${id}`, true)?.id).toBe(id);
  });
  it('更新目录不全量启用新模型，显式选择跨类型保留', async () => {
    const config: AppConfig = { providers: { 'runninghub-model': { name: 'RH', apiKey: 'test-key' } }, theme: 'dark' };
    expect(getConfiguredModelGroups(config, 'ai-image')[0].models).toHaveLength(7);
    expect(getConfiguredModelGroups(config, 'ai-video')).toEqual([]);
    const catalog = await fetchProviderModelCatalog({ providerId: 'runninghub-model', config: config.providers['runninghub-model'] });
    expect(catalog.models).toHaveLength(354);
    const selection = catalog.models.find((model) => model.id === 'minimax/h3-max-turbo/image-to-video')!;
    expect(selection.category).toBe('video');
    config.providers['runninghub-model'].selectedModels = [selection];
    expect(getConfiguredModelGroups(config, 'ai-video')[0].models.map((model) => model.value)).toEqual([`runninghub/${selection.id}`]);
    expect(getConfiguredModelGroups(config, 'ai-image')).toEqual([]);
    expect(config.providers['runninghub-model'].selectedModels).toEqual([selection]);
  });
  it('RunningHub 图像能力来自自己的合同，不套用 APIMart 同名限制', () => {
    expect(getImageCapability('runninghub/gpt-image-2')?.modelId).toBe('rhart-image-g-2-official/image-to-image');
    expect(getImageCapability('apimart/gpt-image-2')?.modelId).toBe('gpt-image-2');
    expect(getImageCapability('runninghub/unknown')).toBeUndefined();
  });
  it('保留 0/false/字符串枚举，拒绝空必填、超范围、类型错误与过量引用', () => {
    const model = getRunningHubModel('minimax/h3-max-turbo/image-to-video')!;
    const duration = model.parameters.find((field) => field.name === 'duration')!;
    expect(parseRunningHubModelParameter(duration, '15')).toBe('15');
    expect(() => parseRunningHubModelParameter(duration, '30')).toThrow();
    const number = { name: 'seed', label: '种子', schema: { type: 'integer' as const, minimum: 0, maximum: 10 }, required: true };
    expect(parseRunningHubModelParameter(number, '0')).toBe(0);
    expect(() => parseRunningHubModelParameter(number, '')).toThrow();
    expect(() => parseRunningHubModelParameter(number, '1.5')).toThrow();
    expect(parseRunningHubModelParameter({ name: 'enabled', label: '开关', schema: { type: 'boolean' } }, 'false')).toBe(false);
    expect(() => parseRunningHubModelParameter({ name: 'refs', label: '参考', schema: { type: 'array', maxItems: 1 } }, '["a","b"]')).toThrow();
  });
});
