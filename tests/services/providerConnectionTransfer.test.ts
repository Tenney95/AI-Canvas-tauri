import { describe, expect, it } from 'vitest';
import { parseConnectionShare, serializeConnection } from '../../src/services/ai/providerConnectionTransfer';
import type { ProviderModelSelection } from '../../src/types';

describe('CCC group connection transfer', () => {
  it('round trips the group and model configuration while excluding credentials', () => {
    const text = serializeConnection({ name: 'CCC API · CCC生图稳定', catalogId: 'cccapi',
      cccGroup: 'CCC生图稳定', apiKey: 'private-fixture', apiKeyRef: 'secret:provider/cccapi-fixture',
      baseUrl: 'https://cccapi.cn/v1', selectedModels: [
        { id: 'gpt-image-2', name: 'Image', category: 'image', provider: 'cccapi-fixture' },
      ] });
    expect(text).not.toContain('private-fixture');
    expect(text).not.toContain('secret:provider');
    const parsed = parseConnectionShare(text)!;
    expect(parsed.config).toMatchObject({ cccGroup: 'CCC生图稳定', apiKey: '', selectedModels: [{ id: 'gpt-image-2', provider: '' }] });
    expect(parsed.config).not.toHaveProperty('apiKeyRef');
    const payload = JSON.parse(text);
    Object.assign(payload.connection, { apiKey: 'injected', apiKeyRef: 'secret:other' });
    expect(parseConnectionShare(JSON.stringify(payload))!.config.apiKey).toBe('');
  });

  it('keeps legacy CCC imports unassigned and ignores group metadata on other providers', () => {
    const legacy = JSON.parse(serializeConnection({ name: 'CCC', catalogId: 'cccapi', apiKey: '' }));
    expect(parseConnectionShare(JSON.stringify(legacy))!.config.cccGroup).toBeUndefined();
    legacy.connection.catalogId = 'custom-openai';
    legacy.connection.cccGroup = 'CCC生图稳定';
    expect(parseConnectionShare(JSON.stringify(legacy))!.config).not.toHaveProperty('cccGroup');
  });
});

describe('自定义媒体连接 JSON', () => {
  it('图片和视频的参数、默认值、参考限制及协议在启用列表和目录中完整往返', () => {
    const models: ProviderModelSelection[] = [
      { id: 'image-fixture', name: '图片', category: 'image', provider: 'custom-original',
        imageCapability: { resolutions: ['1K', '2K', '4K'], defaultResolution: '2K', ratios: ['1:1', '16:9'],
          defaultRatio: '16:9', supportsBatch: true, maxBatchCount: 4, supportsImageReference: true,
          maxImageReferences: 10, supportsDataUrlReference: false, resolutionField: 'resolution', hasResolutionField: true },
        imageReferenceRequestMode: 'generation-json-image-urls',
        executionProfile: { preset: 'custom', protocol: { version: 1, mode: 'sync', submit: { method: 'POST', path: '/v1/images/generations',
          body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}', resolution: '{{resolution}}' } },
          resultUrlPath: 'data.0.url' } } },
      { id: 'video-fixture', name: '视频', category: 'video', provider: 'custom-original',
        videoCapability: { resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', ratios: ['16:9', '9:16'],
          defaultRatio: '16:9', minDuration: 4, maxDuration: 30, defaultDuration: 5, frameRates: [24], defaultFrameRate: 24,
          maxImageReferences: 10, maxVideoReferences: 3, maxAudioReferences: 3 },
        executionProfile: { preset: 'custom', protocol: { version: 1, mode: 'sync', submit: { method: 'POST', path: '/v1/videos',
          body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}' } },
          resultUrlPath: 'url' } } },
    ];
    const text = serializeConnection({ name: '自定义渠道', catalogId: 'custom-openai', apiKey: 'private-fixture',
      apiKeyRef: 'secret:provider/custom-original', baseUrl: 'https://example.test/v1', selectedModels: models,
      catalogModels: models, visibleModelCategories: ['image', 'video'] });
    expect(text).not.toContain('private-fixture');
    expect(text).not.toContain('secret:provider');
    const parsed = parseConnectionShare(text)!;
    const expectedModels = models.map((model) => ({ ...model, provider: '', categoryManual: false }));
    expect(parsed.config.selectedModels).toEqual(expectedModels);
    expect(parsed.config.catalogModels).toEqual(expectedModels);
    expect(parsed.config.visibleModelCategories).toEqual(['image', 'video']);
  });

  it('兼容旧版没有图片能力的文件，格式不符不导入', () => {
    const text = serializeConnection({ name: '旧连接', catalogId: 'custom-openai', apiKey: '',
      selectedModels: [{ id: 'image-old', name: '图片', category: 'image', provider: 'old' }] });
    expect(parseConnectionShare(text)!.config.selectedModels![0].imageCapability).toBeUndefined();
    expect(parseConnectionShare('{')).toBeNull();
    expect(parseConnectionShare('{"connection":{}}')).toBeNull();
  });
});
