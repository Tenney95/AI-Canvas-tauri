/**
 * mediaModelCapabilities — 回归测试：RelayOnAPI 旧图片参数能力。
 */
import { describe, expect, it } from 'vitest';
import { normalizeSeedreamSize } from '../../src/services/ai/helpers';
import { buildImageCapabilityRequest, getImageCapability, resolveImageParameterCapability } from '../../src/services/ai/mediaModelCapabilities';
import { assertConfiguredImageReferences, assertImageModelCapability, assertModelCapabilityProtocol, resolveConfiguredImageParameters } from '../../src/services/ai/modelCapabilityValidation';
import { TOAPIS_MODEL_MANIFEST } from '../../src/services/ai/providers/toapisModelManifest';
import { RELAYON_MODEL_MANIFEST } from '../../src/services/ai/providers/relayonModelManifest';
import type { ProtocolJsonValue } from '../../src/types/aiTypes';

describe('RelayOnAPI 旧图片参数能力', () => {
  function legacyModel(modelId: string) {
    const model = structuredClone(RELAYON_MODEL_MANIFEST.find((item) => item.id === modelId)!);
    const body = model.executionProfile!.protocol!.submit.body as Record<string, ProtocolJsonValue>;
    delete body.quality;
    delete body.background;
    delete model.imageCapability!.qualities;
    delete model.imageCapability!.defaultQuality;
    delete model.imageCapability!.backgrounds;
    delete model.imageCapability!.defaultBackground;
    return model;
  }

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('已保存 %s 的完整旧快照立即显示质量和背景，且不改比例、分辨率或配置', (modelId) => {
    const model = legacyModel(modelId);
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { saved: { name: '旧万象连接', catalogId: 'relayonapi', apiKey: '', selectedModels: [model] } },
      generalModels: [{ id: 'cached', name: model.name, modelId, category: 'image', providerConfigId: 'saved',
        executionProfile: model.executionProfile, imageCapability: model.imageCapability,
        imageReferenceRequestMode: model.imageReferenceRequestMode }],
    };
    const original = structuredClone(config);
    const capability = resolveImageParameterCapability('general/cached', 'general', config);
    expect(capability).toMatchObject({ qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
      backgrounds: ['auto', 'opaque', 'transparent'], resolutions: model.imageCapability!.resolutions,
      ratios: model.imageCapability!.ratios, dimensionPresets: model.imageCapability!.dimensionPresets });
    expect(capability?.defaultQuality).toBeUndefined();
    expect(capability?.defaultBackground).toBeUndefined();
    expect(resolveConfiguredImageParameters(capability!, { imageSize: '2K', aspectRatio: '9:16',
      imageQuality: 'high', imageBackground: 'transparent', count: 1 }))
      .toEqual({ imageSize: '2K', aspectRatio: '9:16', imageQuality: 'high', imageBackground: 'transparent' });
    expect(config).toEqual(original);
  });

  it.each(['image-2-01', 'image-2.5-flare-01', 'image-2.5-sunburst-01', 'nano-banana-2.1'])('%s 不继承普通 2.5 的质量或背景', (modelId) => {
    const model = RELAYON_MODEL_MANIFEST.find((item) => item.id === modelId)!;
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { saved: { name: '万象连接', catalogId: 'relayonapi', apiKey: '' } },
      generalModels: [{ id: 'saved', name: model.name, modelId, category: 'image', providerConfigId: 'saved',
        executionProfile: model.executionProfile, imageCapability: model.imageCapability }],
    };
    expect(resolveImageParameterCapability('general/saved', 'general', config)?.qualities).toBeUndefined();
    expect(resolveImageParameterCapability('general/saved', 'general', config)?.backgrounds).toBeUndefined();
  });

  it('未知同名前缀型号不推断普通 2.5 的参数能力', () => {
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { saved: { name: '万象连接', catalogId: 'relayonapi', apiKey: '' } },
      generalModels: [{ id: 'future', name: '未知图片', modelId: 'Image-2.5-Flare-future', category: 'image', providerConfigId: 'saved',
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/custom/images', body: { prompt: '{{prompt}}' } },
          response: { type: 'json', result: { urlPath: 'url' } } } } }],
    };
    expect(resolveImageParameterCapability('general/future', 'general', config)).toBeUndefined();
  });

  it.each(['custom-openai', 'relayonapi'])('%s 的用户自定义协议按实际映射显示，不被同名目录强加六档', (catalogId) => {
    const model = legacyModel('Image-2.5-Flare');
    model.executionProfile!.protocol!.submit.path = '/custom/images';
    model.imageCapability = { ...model.imageCapability, qualities: ['low', 'high'], defaultQuality: 'low',
      backgrounds: ['opaque', 'transparent'], defaultBackground: 'opaque' };
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { relayonapi: { name: '自己的连接', catalogId, apiKey: '' } },
      generalModels: [{ id: 'custom', name: model.name, modelId: model.id, category: 'image', providerConfigId: 'relayonapi',
        executionProfile: model.executionProfile, imageCapability: model.imageCapability }],
    };
    const resolve = () => resolveImageParameterCapability('general/custom', 'general', config);
    expect(resolve()?.qualities).toBeUndefined();
    expect(resolve()?.backgrounds).toBeUndefined();
    const body = model.executionProfile!.protocol!.submit.body as Record<string, ProtocolJsonValue>;
    body.quality = 'high';
    body.background = 'opaque';
    expect(resolve()).toMatchObject({ qualities: ['high'], defaultQuality: 'high', backgrounds: ['opaque'],
      defaultBackground: 'opaque', backgroundIsFixed: true });
    body.quality = '{{imageQuality}}';
    body.background = '{{imageBackground}}';
    expect(resolve()).toMatchObject({ qualities: ['low', 'high'], defaultQuality: 'low',
      backgrounds: ['opaque', 'transparent'], defaultBackground: 'opaque' });
    expect(resolve()?.backgroundIsFixed).not.toBe(true);
  });
});

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
  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])('%s 保留文档的尺寸、批量、参考与默认参数合同', (modelId) => {
    const model = `apimart/${modelId}`;
    expect(getImageCapability(model)).toMatchObject({ resolutions: ['1k', '2k', '4k'],
      supportsBatch: true, maxBatchCount: 4, maxImageReferences: 16, supportsDataUrlReference: false });
    const request = buildImageCapabilityRequest(model, 'portrait', { resolution: '2K', ratio: '9:16', count: 8 });
    expect(request).toEqual({ body: { model: modelId, prompt: 'portrait', n: 4, size: '9:16', resolution: '2k', quality: 'auto' },
      dimensions: { width: 1152, height: 2048 }, requestedCount: 4 });
    expect(request?.body).not.toHaveProperty('background');
    expect(() => buildImageCapabilityRequest(model, 'portrait', { ratio: '8:1' })).toThrow('不支持比例');
    expect(() => buildImageCapabilityRequest(model, 'portrait', {
      imageUrls: Array.from({ length: 17 }, (_, index) => `https://reference.example/${index}.png`),
    })).toThrow('最多支持 16 张');
    for (const prefix of ['cccapi', 'custom']) {
      expect(getImageCapability(`${prefix}/${modelId}`)).toBeUndefined();
    }
  });

  it('uses an explicit user ratio and rejects unsupported ratios instead of silently changing it', () => {
    expect(buildImageCapabilityRequest('apimart/gpt-image-2.5-sunburst', 'portrait', { ratio: '9:16' })?.body)
      .toMatchObject({ size: '9:16' });
    expect(() => buildImageCapabilityRequest('apimart/gpt-image-2.5-sunburst', 'portrait', { ratio: '8:1' }))
      .toThrow('不支持比例 8:1');
    expect(buildImageCapabilityRequest('apimart/gpt-image-2.5-sunburst', 'portrait', {})?.body)
      .toMatchObject({ size: '1:1' });
  });
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

describe('图片生成质量按渠道隔离', () => {
  it.each([
    ['apimart/gpt-image-1-official', ['auto', 'low', 'medium', 'high'], 'auto'],
    ['apimart/gpt-image-1.5-official', ['auto', 'low', 'medium', 'high'], 'auto'],
    ['apimart/gpt-image-2-official', ['auto', 'low', 'medium', 'high'], 'auto'],
    ['apimart/gpt-image-2.5-flare', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'auto'],
    ['apimart/gpt-image-2.5-sunburst', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'auto'],
    ['apimart/gpt-image-2.6-flare', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'auto'],
    ['apimart/gpt-image-2.6-sunburst', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], 'auto'],
    ['grsai/gpt-image-2', ['auto'], 'auto'],
    ['grsai/gpt-image-2-vip', ['medium'], 'medium'],
    ['grsai/gpt-image-2.5', ['auto'], 'auto'],
    ['grsai/gpt-image-2.5-flare', ['low', 'medium', 'high'], 'medium'],
    ['grsai/gpt-image-2.5-sunburst', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ])('%s 只展示该渠道文档的质量并保留默认值', (model, qualities, defaultQuality) => {
    expect(getImageCapability(model as string)).toMatchObject({ qualities, defaultQuality });
  });

  it.each(['apimart/gpt-image-1', 'apimart/gpt-image-1.5', 'apimart/gpt-image-2',
    'apimart/gpt-image-2.5-ext', 'apimart/gpt-image-2.5-flare-unknown',
    'cccapi/gpt-image-2.5-flare', 'custom/gpt-image-2.5-flare', 'gpt-image-2.5-flare'])(
    '不把同名或未知渠道 %s 当作已确认质量能力', (model) => {
    expect(getImageCapability(model)?.qualities).toBeUndefined();
  });

  it('APIMart 请求中的质量不改变分辨率或比例，未声明质量的型号不发送质量', () => {
    expect(buildImageCapabilityRequest('apimart/gpt-image-2.5-sunburst', 'prompt', {
      imageQuality: 'max', resolution: '2K', ratio: '16:9',
    })?.body).toMatchObject({ quality: 'max', resolution: '2k', size: '16:9' });
    expect(buildImageCapabilityRequest('apimart/gpt-image-2-official', 'prompt', {})?.body).toMatchObject({ quality: 'auto' });
    expect(() => buildImageCapabilityRequest('apimart/gpt-image-2-official', 'prompt', { imageQuality: 'max' })).toThrow('质量');
    expect(buildImageCapabilityRequest('apimart/gpt-image-2', 'prompt', { imageQuality: 'max' })?.body).not.toHaveProperty('quality');
  });

  it('旧内置连接的标准请求补充已确认质量，自定义同名连接只使用自己的声明', () => {
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: {
        savedCcc: { name: 'CCC', apiKey: '', catalogId: 'cccapi' },
        savedApimart: { name: 'APIMart', apiKey: '', catalogId: 'apimart' },
        custom: { name: 'Custom', apiKey: '', catalogId: 'custom-openai' },
      },
      generalModels: ['savedCcc', 'savedApimart', 'custom'].map((providerConfigId) => ({
        id: providerConfigId, name: 'GPT', modelId: 'gpt-image-2.5-flare', category: 'image' as const, providerConfigId,
        imageCapability: { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1' },
      })),
    };
    for (const id of ['savedCcc', 'savedApimart']) {
      expect(resolveImageParameterCapability(`general/${id}`, 'general', config)).toMatchObject({
        resolutions: ['1K'], qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto',
      });
    }
    expect(resolveImageParameterCapability('general/custom', 'general', config)?.qualities).toBeUndefined();
    expect(resolveImageParameterCapability('cccapi/gpt-image-2.5', 'cccapi', config)?.qualities).toBeUndefined();
  });

  it('CCC 已确认的 Images 合同优先于旧 custom 协议，质量仍按当前目录发送', () => {
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { ccc: { name: 'CCC', apiKey: '', catalogId: 'cccapi' } },
      generalModels: [{ id: 'ccc-image', name: 'Sunburst', modelId: 'gpt-image-2.5-sunburst', category: 'image',
        providerConfigId: 'ccc', imageCapability: { qualities: ['high'], defaultQuality: 'high' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/old/images', body: { quality: 'high' } },
          response: { type: 'json', result: { urlPath: 'url' } },
        } },
      }],
    };
    expect(resolveImageParameterCapability('general/ccc-image', 'general', config))
      .toMatchObject({ qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto' });
  });

  it('自定义固定质量保持单值，未映射与动态映射不能继承目录质量', () => {
    const base = { id: 'saved', name: 'GPT', modelId: 'gpt-image-2.5-flare', category: 'image' as const,
      providerConfigId: 'savedApimart', imageCapability: { qualities: ['low', 'high'], defaultQuality: 'low' } };
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { savedApimart: { name: 'APIMart', apiKey: '', catalogId: 'apimart' } },
      generalModels: [{ ...base, executionProfile: { preset: 'custom', protocol: {
        version: 2, mode: 'sync', submit: { method: 'POST', path: '/images', body: { quality: 'high' } },
        response: { type: 'json', result: { urlPath: 'url' } },
      } } }],
    };
    expect(resolveImageParameterCapability('general/saved', 'general', config)).toMatchObject({ qualities: ['high'], defaultQuality: 'high' });
    const saved = config.generalModels![0];
    saved.executionProfile!.protocol!.submit.body = { prompt: '{{prompt}}' };
    expect(resolveImageParameterCapability('general/saved', 'general', config)?.qualities).toBeUndefined();
    saved.executionProfile!.protocol!.submit.body = { quality: '{{imageQuality}}' };
    expect(resolveImageParameterCapability('general/saved', 'general', config)).toMatchObject({ qualities: ['low', 'high'], defaultQuality: 'low' });
  });

  it('已保存的 ToAPIs 完整旧合同与当前节点目录使用相同质量能力', () => {
    const current = TOAPIS_MODEL_MANIFEST.find((model) => model.id === 'gpt-image-2.5-sunburst-vip')!;
    const previous = structuredClone(current.executionProfile!);
    (previous.protocol!.submit.body as Record<string, ProtocolJsonValue>).quality = 'high';
    delete (previous.protocol!.submit.body as Record<string, ProtocolJsonValue>).background;
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { savedToapis: { name: 'ToAPIs', apiKey: '', catalogId: 'toapis' } },
      generalModels: [{ id: 'saved', name: current.name, modelId: current.id, category: 'image',
        providerConfigId: 'savedToapis', executionProfile: previous,
        imageCapability: { ...current.imageCapability, qualities: undefined, defaultQuality: undefined,
          backgrounds: undefined, defaultBackground: undefined },
      }],
    };
    expect(resolveImageParameterCapability('general/saved', 'general', config))
      .toMatchObject({ qualities: current.imageCapability!.qualities, defaultQuality: 'high' });
    expect((previous.protocol!.submit.body as Record<string, ProtocolJsonValue>).quality).toBe('high');
  });
});

describe('GPT Image 2.5 背景能力与请求', () => {
  it.each([
    ['apimart/gpt-image-2.5-flare', ['auto', 'opaque', 'transparent']],
    ['apimart/gpt-image-2.5-sunburst', ['auto', 'opaque', 'transparent']],
    ['apimart/gpt-image-2.6-flare', ['auto', 'opaque', 'transparent']],
    ['apimart/gpt-image-2.6-sunburst', ['auto', 'opaque', 'transparent']],
    ['grsai/gpt-image-2.5-flare', ['transparent']],
    ['grsai/gpt-image-2.5-sunburst', ['transparent']],
  ] as const)('%s 按精确渠道声明背景并保持接口缺省值', (model, backgrounds) => {
    expect(getImageCapability(model)?.backgrounds).toEqual(backgrounds);
    expect(getImageCapability(model)?.defaultBackground).toBeUndefined();
  });

  it.each(['gpt-image-2.5-flare', 'custom/gpt-image-2.5-flare', 'apimart/gpt-image-2.5-ext',
    'apimart/gpt-image-2.5-flare-unknown', 'apimart/gpt-image-2-official', 'grsai/gpt-image-2.5'])(
    '不向裸型号、未知别名或未确认型号 %s 泄漏背景能力', (model) => {
      expect(getImageCapability(model)?.backgrounds).toBeUndefined();
      expect(getImageCapability(model)?.defaultBackground).toBeUndefined();
    },
  );

  it('APIMart 透明请求使用 PNG，默认、auto 和 opaque 不被改成透明', () => {
    const request = (imageBackground?: string) => buildImageCapabilityRequest('apimart/gpt-image-2.5-sunburst', 'portrait', {
      imageBackground, imageQuality: 'high', resolution: '2K', ratio: '9:16',
    })!.body;
    expect(request('TRANSPARENT')).toMatchObject({ background: 'transparent', output_format: 'png',
      quality: 'high', resolution: '2k', size: '9:16' });
    for (const value of [undefined, '']) {
      expect(request(value)).not.toHaveProperty('background');
      expect(request(value)).not.toHaveProperty('output_format');
    }
    for (const value of ['auto', 'opaque']) {
      expect(request(value)).toMatchObject({ background: value });
      expect(request(value)).not.toHaveProperty('output_format');
    }
    expect(() => request('solid')).toThrow('背景');
    const unknown = buildImageCapabilityRequest('apimart/gpt-image-2', 'portrait', { imageBackground: 'transparent' })!.body;
    expect(unknown).not.toHaveProperty('background');
    expect(unknown).not.toHaveProperty('output_format');
  });

  it('内置 CCC 的旧固定背景协议不覆盖当前标准合同，未声明默认仍省略', () => {
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { ccc: { name: 'CCC', apiKey: '', catalogId: 'cccapi' } },
      generalModels: [{ id: 'saved', name: 'Sunburst', category: 'image', modelId: 'gpt-image-2.5-sunburst', providerConfigId: 'ccc',
        imageCapability: { backgrounds: ['opaque'], defaultBackground: 'opaque' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/old/images', body: { background: 'opaque' } },
          response: { type: 'json', result: { urlPath: 'url' } },
        } },
      }],
    };
    const capability = resolveImageParameterCapability('general/saved', 'general', config);
    expect(capability?.backgrounds).toEqual(['auto', 'opaque', 'transparent']);
    expect(capability?.defaultBackground).toBeUndefined();
  });

  it('自定义协议动态背景仅保留显式能力，固定背景只读单值，无映射时不展示', () => {
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { custom: { name: 'Custom', apiKey: '', catalogId: 'custom-openai' } },
      generalModels: [{ id: 'saved', name: 'Custom GPT', category: 'image', modelId: 'gpt-image-2.5-flare', providerConfigId: 'custom',
        imageCapability: { backgrounds: ['opaque', 'transparent'], defaultBackground: 'transparent' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/images', body: { background: '{{imageBackground}}' } },
          response: { type: 'json', result: { urlPath: 'url' } },
        } },
      }],
    };
    const resolve = () => resolveImageParameterCapability('general/saved', 'general', config);
    expect(resolve()).toMatchObject({ backgrounds: ['opaque', 'transparent'], defaultBackground: 'transparent' });
    config.generalModels![0].executionProfile!.protocol!.submit.body = { background: 'opaque' };
    expect(resolve()).toMatchObject({ backgrounds: ['opaque'], defaultBackground: 'opaque' });
    config.generalModels![0].executionProfile!.protocol!.submit.body = { prompt: '{{prompt}}' };
    expect(resolve()?.backgrounds).toBeUndefined();
    expect(resolve()?.defaultBackground).toBeUndefined();
    config.generalModels![0].providerConfigId = 'apimart';
    config.providers.apimart = { name: 'APIMart', apiKey: '' };
    expect(resolve()?.backgrounds).toBeUndefined();
  });

  it.each(['custom-openai', 'toapis'])('%s 动态单选默认背景仍可省略，固定标记仅由实际协议派生', (catalogId) => {
    const declaration = { backgrounds: ['transparent'], defaultBackground: 'transparent', backgroundIsFixed: true };
    const config: Pick<AppConfig, 'providers' | 'generalModels'> = {
      providers: { saved: { name: 'Saved', apiKey: '', catalogId } },
      generalModels: [{ id: 'image', name: 'GPT', category: 'image', modelId: 'gpt-image-2.5-sunburst-vip', providerConfigId: 'saved',
        imageCapability: declaration,
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/custom/images', body: { background: '{{imageBackground}}' } },
          response: { type: 'json', result: { urlPath: 'url' } },
        } },
      }],
    };
    const resolve = () => resolveImageParameterCapability('general/image', 'general', config);
    expect(resolve()).toMatchObject({ backgrounds: ['transparent'], defaultBackground: 'transparent' });
    expect(resolve()?.backgroundIsFixed).not.toBe(true);
    config.generalModels![0].executionProfile!.protocol!.submit.body = { background: 'transparent' };
    expect(resolve()).toMatchObject({ backgrounds: ['transparent'], defaultBackground: 'transparent', backgroundIsFixed: true });
    config.generalModels![0].executionProfile!.protocol!.submit.body = { prompt: '{{prompt}}' };
    expect(resolve()?.backgroundIsFixed).not.toBe(true);
    expect(resolve()?.backgrounds).toBeUndefined();
    config.generalModels![0].executionProfile = { preset: 'openai-gpt-image' };
    expect(resolve()?.backgroundIsFixed).not.toBe(true);
    expect(declaration.backgroundIsFixed).toBe(true);
  });
});
