import { describe, expect, it } from 'vitest';
import { normalizeSeedreamSize } from '../../src/services/ai/helpers';
import { buildImageCapabilityRequest, getImageCapability, resolveImageParameterCapability } from '../../src/services/ai/mediaModelCapabilities';
import { assertConfiguredImageReferences, assertImageModelCapability, assertModelCapabilityProtocol, resolveConfiguredImageParameters } from '../../src/services/ai/modelCapabilityValidation';

describe('custom image parameter declarations', () => {
  it('resolves a gateway model using its own saved tiers instead of a same-name provider', () => {
    const config = { providers: { custom: { name: 'Custom', apiKey: '', catalogId: 'custom-openai' } },
      generalModels: [{ id: 'image', name: 'Image', modelId: 'gpt-image-2.5', category: 'image' as const, providerConfigId: 'custom',
        imageCapability: { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1' } }] };
    expect(resolveImageParameterCapability('general/image', 'general', config)?.resolutions).toEqual(['1K']);
    expect(resolveImageParameterCapability('general/image', 'general', { ...config,
      generalModels: [{ ...config.generalModels[0], imageCapability: undefined }] })?.resolutions).toEqual([]);
  });

  it('uses declared defaults and rejects unsupported parameters and references', () => {
    const capability = { resolutions: ['1K'], defaultResolution: '1K', ratios: ['16:9'], defaultRatio: '16:9',
      supportsBatch: true, maxBatchCount: 2, supportsImageReference: false };
    expect(resolveConfiguredImageParameters(capability, { count: 1 })).toEqual({ imageSize: '1K', aspectRatio: '16:9' });
    expect(() => resolveConfiguredImageParameters(capability, { imageSize: '4K', count: 1 })).toThrow('分辨率');
    expect(() => resolveConfiguredImageParameters(capability, { count: 3 })).toThrow('最多生成 2');
    expect(() => assertConfiguredImageReferences(capability, 1)).toThrow('不支持参考图');
    expect(() => assertImageModelCapability({ resolutions: ['1K'], defaultResolution: '2K' })).toThrow('defaultResolution');
  });

  it('does not accept an audio toggle without a request mapping', () => {
    expect(() => assertModelCapabilityProtocol({ id: 'video', name: 'Video', category: 'video', provider: 'custom',
      videoCapability: { supportsAudio: true }, executionProfile: { preset: 'custom', protocol: {
        version: 2, mode: 'sync', submit: { method: 'POST', path: '/videos', body: { prompt: '{{prompt}}' } },
        response: { type: 'json', result: { urlPath: 'url' } },
      } } })).toThrow('音频开关');
  });

  it('rejects image reference declarations that their transport cannot honor', () => {
    const model = { id: 'image', name: 'Image', category: 'image' as const, provider: 'custom',
      imageCapability: { supportsImageReference: true, supportsDataUrlReference: false },
      executionProfile: { preset: 'custom' as const, protocol: {
        version: 2 as const, mode: 'sync' as const, submit: { method: 'POST' as const, path: '/images', body: { prompt: '{{prompt}}' } },
        response: { type: 'json' as const, result: { urlPath: 'url' } },
      } },
    };
    expect(() => assertModelCapabilityProtocol({ ...model,
      imageReferenceRequestMode: 'generation-json-image-urls' })).toThrow('参考图');
    expect(() => assertModelCapabilityProtocol({ ...model,
      imageReferenceRequestMode: 'generation-json-image-data-urls' })).toThrow('Base64');
  });
});
import { resolveBuiltInImageRequestContract } from '../../src/services/ai/imageRequestContracts';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import type { AppConfig } from '../../src/types';

describe('image model capability resolution', () => {
  const grsaiConfig: Pick<AppConfig, 'providers' | 'generalModels'> = {
    providers: {
      grsai: { name: 'GRSAI', apiKey: '' },
      'saved-grsai': { name: '旧 GRSAI 连接', apiKey: '', catalogId: 'grsai' },
      custom: { name: '自定义接口', apiKey: '', catalogId: 'custom-openai' },
    },
    generalModels: [{ id: 'saved-pro', name: 'Nano Banana Pro', modelId: 'nano-banana-pro', category: 'image', providerConfigId: 'saved-grsai' }],
  };

  it.each([
    ['grsai/nano-banana-pro', 'grsai'],
    ['nano-banana-pro', 'grsai'],
    ['saved-grsai/nano-banana-pro', 'saved-grsai'],
    ['general/saved-pro', 'general'],
    ['saved-pro', 'general'],
  ])('shows all GRSAI Pro tiers for model reference %s', (model, provider) => {
    const capability = resolveImageParameterCapability(model, provider, grsaiConfig);
    expect(capability?.resolutions).toEqual(['1K', '2K', '4K']);
    expect(capability?.modelId).toBe('nano-banana-pro');
    for (const imageSize of ['2K', '4K']) {
      const contract = resolveBuiltInImageRequestContract(getProviderDefinition('grsai'), capability!.modelId, imageSize, '16:9');
      expect(contract?.kind).toBe('protocol');
      if (contract?.kind === 'protocol') expect(contract.protocol.submit.body).toMatchObject({ imageSize, aspectRatio: '16:9' });
    }
  });

  it.each([
    ['nano-banana-2', ['1K', '2K', '4K']],
    ['nano-banana-2.1', ['1K', '2K', '4K']],
    ['nano-banana-pro-cl', ['1K']],
    ['nano-banana-pro-vip', ['1K', '2K']],
    ['nano-banana-pro-4k-vip', ['4K']],
  ])('keeps GRSAI channel-specific tiers for %s', (model, resolutions) => {
    expect(resolveImageParameterCapability(model, 'grsai', grsaiConfig)?.resolutions).toEqual(resolutions);
  });

  it('does not apply GRSAI tiers based only on a Nano Banana Pro model name', () => {
    expect(resolveImageParameterCapability('custom/nano-banana-pro', 'custom', grsaiConfig)?.resolutions).toEqual(['1K']);
    expect(resolveImageParameterCapability('google/gemini-3-pro-image-preview', 'google', grsaiConfig)?.resolutions).toEqual(['1K']);
    expect(resolveImageParameterCapability(undefined, 'grsai', grsaiConfig)).toBeUndefined();
  });

  it('keeps GRSAI image tiers separate from APIMart and other same-name models', () => {
    expect(getImageCapability('grsai/nano-banana-2.1')?.resolutions).toEqual(['1K', '2K', '4K']);
    expect(getImageCapability('grsai/nano-banana-2.1')?.ratios).toContain('1:8');
    expect(getImageCapability('grsai/nano-banana-2-lite')?.resolutions).toEqual(['1K']);
    expect(getImageCapability('grsai/nano-banana-2-lite')?.ratios).not.toContain('1:8');
    expect(getImageCapability('grsai/gpt-image-2.5')?.resolutions).toEqual(['1K']);
    expect(getImageCapability('grsai/nano-banana-2-4k-cl')?.resolutions).toEqual(['4K']);
    expect(getImageCapability('grsai/gpt-image-2.5-flare')?.resolutions).toEqual(['1K', '2K', '4K']);
    expect(getImageCapability('apimart/gpt-image-2.5-flare')?.resolutions).toEqual(['1k', '2k', '4k']);
  });
  it('resolves the versioned Volcengine Seedream 5.0 Pro model', () => {
    const capability = getImageCapability('volcengine/doubao-seedream-5-0-pro-260628');

    expect(capability).toMatchObject({
      modelId: 'doubao-seedream-5-0-pro',
      resolutions: ['1K', '1.5K', '2K'],
      defaultResolution: '2K',
      defaultRatio: 'auto',
    });
    expect(capability?.ratios).toContain('auto');
    expect(capability?.dimensionPresets?.['2K']?.['16:9']).toEqual([2816, 1584]);
  });

  it.each([
    ['volcengine/doubao-seedream-5-0-lite-260128', ['2K', '3K', '4K']],
    ['volcengine/doubao-seedream-4-5-251128', ['2K', '4K']],
    ['volcengine/doubao-seedream-4-0-250828', ['1K', '2K', '4K']],
  ])('resolves versioned model %s', (model, resolutions) => {
    expect(getImageCapability(model)?.resolutions).toEqual(resolutions);
  });

  it('keeps Seedream 5.0 Pro 1.5K instead of degrading it', () => {
    expect(normalizeSeedreamSize('doubao-seedream-5-0-pro-260628', '1.5K')).toBe('1.5K');
  });
});

describe('APIMart 新图片模型合同', () => {
  it('Nano Banana 原版与官方渠道开放真实档位，保留其他厂商能力', () => {
    expect(buildImageCapabilityRequest('apimart/gemini-3.1-flash-image-preview', 'prompt', { resolution: '4K', ratio: '8:1' })?.body)
      .toMatchObject({ resolution: '4K', size: '8:1' });
    expect(buildImageCapabilityRequest('apimart/gemini-3.1-flash-image-preview-official', 'prompt', { resolution: '0.5K' })?.dimensions)
      .toEqual({ width: 512, height: 512 });
    expect(getImageCapability('google/gemini-3.1-flash-image-preview')?.resolutions).toEqual(['1K']);
  });
  it('将 Grok 2.0 官方比例写入 aspect_ratio，保留三图顺序', () => {
    const imageUrls = ['https://cdn.example/a.png', 'https://cdn.example/b.png', 'https://cdn.example/c.png'];
    const request = buildImageCapabilityRequest('apimart/grok-imagine-image-2.0', 'edit', { resolution: '2K', ratio: '9:20', imageUrls, count: 10 });
    expect(request?.body).toEqual({ model: 'grok-imagine-image-2.0', prompt: 'edit', n: 10, aspect_ratio: '9:20', resolution: '2k', image_urls: imageUrls });
    expect(() => buildImageCapabilityRequest('apimart/grok-imagine-image-2.0', 'edit', { imageUrls: [...imageUrls, imageUrls[0]] })).toThrow('最多支持 3 张');
  });

  it('Grok 2.0 Ext 拒绝参考图，接受七种比例与最多十二张输出', () => {
    expect(buildImageCapabilityRequest('apimart/grok-imagine-2.0-ext', 'prompt', { count: 12, ratio: '4:3', resolution: '4K' })?.body)
      .toEqual({ model: 'grok-imagine-2.0-ext', prompt: 'prompt', n: 12, size: '4:3' });
    expect(() => buildImageCapabilityRequest('apimart/grok-imagine-2.0-ext', 'edit', { imageUrls: ['https://cdn.example/a.png'] })).toThrow('仅文生图');
  });

  it.each(['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-lite-image-ext'])('%s 始终提交 1K，不伪装为高分辨率', (model) => {
    expect(buildImageCapabilityRequest(`apimart/${model}`, 'prompt', { resolution: '4K', count: 4 })?.body)
      .toMatchObject({ model, resolution: '1K', n: 1 });
  });

  it('Seedream 中转像素表与火山直连保持隔离', () => {
    expect(buildImageCapabilityRequest('apimart/seedream-5-0-pro', 'prompt', { resolution: '2K', ratio: '16:9' })?.dimensions).toEqual({ width: 2560, height: 1440 });
    expect(buildImageCapabilityRequest('apimart/seedream-5-0-flash', 'prompt', { resolution: '1.5K', ratio: '2:1' })?.dimensions).toEqual({ width: 2176, height: 1088 });
    expect(getImageCapability('volcengine/doubao-seedream-5-0-pro-260628')?.dimensionPresets?.['2K']?.['16:9']).toEqual([2816, 1584]);
  });

  it('GPT Image Ext 显式传入版本，并限制合法比例与输出档位', () => {
    expect(buildImageCapabilityRequest('apimart/gpt-image-2.5-ext', 'prompt', { resolution: '4k', ratio: '21:9', count: 4 })?.body)
      .toEqual({ model: 'gpt-image-2.5-ext', prompt: 'prompt', version: 'flare', resolution: '4K', size: '21:9', n: 4 });
  });
});
