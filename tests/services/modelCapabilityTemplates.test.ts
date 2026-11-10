import { describe, expect, it } from 'vitest';
import {
  getImageCapabilityTemplate, getVideoCapabilityTemplate,
  type ImageCapabilityTemplateId, type VideoCapabilityTemplateId,
} from '../../src/services/ai/modelCapabilityTemplates';
import { getOfficialSeedanceCapability } from '../../src/services/ai/seedanceModelCapabilities';
import { assertImageModelCapability } from '../../src/services/ai/modelCapabilityValidation';
import { assertVideoModelCapability } from '../../src/services/ai/videoRequestResolver';
import { getImageSizePresets } from '../../src/services/ai/modelSizeProfiles';
import { getGrsaiImageCapability } from '../../src/services/ai/grsaiModels';
import { resolveBuiltInImageRequestContract } from '../../src/services/ai/imageRequestContracts';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';

describe('同型号公共模板与渠道覆写', () => {
  it.each<ImageCapabilityTemplateId>([
    'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6',
    'nano-banana', 'nano-banana-pro', 'nano-banana-2', 'nano-banana-2.1',
    'seedream-4', 'seedream-4.5', 'seedream-5-lite', 'seedream-5-pro',
  ])('%s 的基础能力有效且各调用独立', (id) => {
    const first = getImageCapabilityTemplate(id);
    const before = structuredClone(first);
    expect(() => assertImageModelCapability(first)).not.toThrow();
    first.resolutions!.push('changed');
    first.ratios!.push('changed');
    expect(getImageCapabilityTemplate(id)).toEqual(before);
  });

  it.each<VideoCapabilityTemplateId>([
    'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'seedance-2.5', 'minimax-h3', 'minimax-h3-max',
  ])('%s 的基础能力有效且模式不共享可变对象', (id) => {
    const first = getVideoCapabilityTemplate(id);
    const before = structuredClone(first);
    expect(() => assertVideoModelCapability(first)).not.toThrow();
    first.resolutions!.push('changed');
    if (first.inputModeCapabilities?.keyframe?.ratios) first.inputModeCapabilities.keyframe.ratios.push('changed');
    expect(getVideoCapabilityTemplate(id)).toEqual(before);
  });

  it('同一 Seedance 基础能力沿用既有官方源，渠道数组与模式整体替换', () => {
    expect(getVideoCapabilityTemplate('seedance-2.5')).toEqual(getOfficialSeedanceCapability('2.5'));
    const overrides = { ratios: ['9:16'], defaultRatio: '9:16', inputModeCapabilities: undefined,
      operationCapabilities: { 'video-to-video': { ratios: ['9:16'], defaultRatio: '9:16' } } };
    const channel = getVideoCapabilityTemplate('seedance-2.5', overrides);
    expect(channel.ratios).toEqual(['9:16']);
    expect(channel).not.toHaveProperty('inputModeCapabilities');
    expect(channel.operationCapabilities?.['video-to-video']).not.toHaveProperty('automaticDurationOnly');
    channel.ratios!.push('1:1');
    expect(overrides.ratios).toEqual(['9:16']);
    expect(getVideoCapabilityTemplate('seedance-2.5').inputModeCapabilities?.keyframe?.ratios).toEqual(['adaptive']);
  });

  it('渠道未声明的控件真正删除，不继承未知质量或批量能力', () => {
    const channel = getImageCapabilityTemplate('gpt-image-2.5', {
      qualities: undefined, defaultQuality: undefined, backgrounds: undefined,
      supportsBatch: false, maxBatchCount: undefined,
    });
    for (const key of ['qualities', 'defaultQuality', 'backgrounds', 'maxBatchCount']) expect(channel).not.toHaveProperty(key);
    expect(channel.supportsBatch).toBe(false);
    expect(getImageCapabilityTemplate('gpt-image-2.5').qualities).toContain('max');
  });

  it('未知模板不按同名前缀或兜底版本猜测', () => {
    expect(() => getImageCapabilityTemplate('nano-banana-future' as ImageCapabilityTemplateId)).toThrow('未知图片基础模板');
    expect(() => getImageCapabilityTemplate('toString' as ImageCapabilityTemplateId)).toThrow('未知图片基础模板');
    expect(() => getVideoCapabilityTemplate('seedance-2.0-future' as VideoCapabilityTemplateId)).toThrow('未知视频基础模板');
  });

  it.each([
    ['gpt-image-2', '1K', '16:9', [1672, 941]],
    ['gpt-image-2.5-flare', '2K', '4:3', [2304, 1728]],
    ['gpt-image-2.5-sunburst', '4K', '5:4', [3200, 2560]],
  ] as const)('GRSAI %s 的查询尺寸与实际请求同源', (model, resolution, ratio, pixels) => {
    const capability = getGrsaiImageCapability(model)!;
    expect(capability.dimensionPresets?.[resolution]?.[ratio]).toEqual(pixels);
    const contract = resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), model, resolution, ratio);
    expect(contract?.kind).toBe('protocol');
    if (contract?.kind === 'protocol') expect(contract.dimensions).toEqual({ width: pixels[0], height: pixels[1] });
    capability.dimensionPresets![resolution][ratio] = [1, 1];
    expect(getGrsaiImageCapability(model)?.dimensionPresets?.[resolution]?.[ratio]).toEqual(pixels);
  });

  it('万象和 GRSAI 的同名尺寸仍由各自渠道覆写', () => {
    expect(getImageSizePresets('relayon-nano-banana')['2K']['16:9']).toEqual([2560, 1440]);
    expect(getImageSizePresets('google-gemini-3-pro')['2K']['16:9']).toEqual([2752, 1536]);
    expect(getImageSizePresets('grsai-gpt')['4K']['3:2']).toEqual([3504, 2336]);
    expect(getImageSizePresets('openai-gpt')['4K']['3:2']).toEqual([3520, 2336]);
  });
});
