/**
 * providerConnectionTransfer — 回归测试：CCC group connection transfer。
 */
import { describe, expect, it } from 'vitest';
import { parseConnectionShare, serializeConnection } from '../../src/services/ai/providerConnectionTransfer';
import type { ProviderModelSelection } from '../../src/types';

it('round trips a missing plugin reference without stripping its identity or injecting an adapter', () => {
  const executionProfile = { preset: 'plugin' as const, plugin: { pluginId: 'example.responses', presetId: 'responses' } };
  const text = serializeConnection({ name: 'plugin', apiKey: 'private-fixture', catalogId: 'custom-openai', baseUrl: 'https://gateway.example/v1',
    selectedModels: [{ id: 'model', name: 'model', provider: 'p', category: 'text', executionProfile }] });
  const parsed = parseConnectionShare(text)!;
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.config.selectedModels![0].executionProfile).toEqual(executionProfile);
  expect(text).not.toContain('private-fixture');
  const invalid = JSON.parse(text);
  invalid.connection.selectedModels[0].executionProfile.plugin.adapter = 'openai-compatible';
  expect(parseConnectionShare(JSON.stringify(invalid))!.diagnostics[0].path).toContain('executionProfile.plugin');
});

it('round trips Responses connection and native model settings without credentials', () => {
  const text = serializeConnection({ name: 'Responses', catalogId: 'custom-openai', apiKey: 'private-fixture',
    baseUrl: 'https://example.test/v1', chatApiProtocol: 'openai-responses', selectedModels: [{
      id: 'configured-model', name: 'Vision model', provider: 'custom-original', category: 'text',
      inputModalities: ['text', 'image'], executionProfile: { preset: 'openai-responses' },
    }] });
  expect(text).not.toContain('private-fixture');
  const parsed = parseConnectionShare(text)!;
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.config).toMatchObject({ chatApiProtocol: 'openai-responses', apiKey: '', selectedModels: [{
    inputModalities: ['text', 'image'], executionProfile: { preset: 'openai-responses' },
  }] });
});

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

describe('RelayOnAPI group connection transfer', () => {
  it('round trips the group and models without either credential field', () => {
    const text = serializeConnection({ name: '万象图片组', catalogId: 'relayonapi', relayonGroup: 'image',
      apiKey: 'private-fixture', apiKeyRef: 'secret:provider/relay-fixture', baseUrl: 'https://relayonapi.com/v1',
      selectedModels: [{ id: 'image-2.5-flare', name: 'Image', category: 'image', provider: 'relay-image' }] });
    expect(text).not.toContain('private-fixture');
    expect(text).not.toContain('secret:provider');
    const parsed = parseConnectionShare(text)!;
    expect(parsed.config).toMatchObject({ catalogId: 'relayonapi', relayonGroup: 'image', apiKey: '',
      selectedModels: [{ id: 'image-2.5-flare', provider: '' }] });
    expect(parsed.config).not.toHaveProperty('apiKeyRef');
    const payload = JSON.parse(text);
    Object.assign(payload.connection, { apiKey: 'injected', apiKeyRef: 'secret:other' });
    expect(parseConnectionShare(JSON.stringify(payload))!.config).toMatchObject({ apiKey: '', relayonGroup: 'image' });
  });

  it('keeps old connections unassigned and ignores group metadata for custom connections', () => {
    const payload = JSON.parse(serializeConnection({ name: '旧万象连接', catalogId: 'relayonapi', apiKey: '' }));
    expect(parseConnectionShare(JSON.stringify(payload))!.config.relayonGroup).toBeUndefined();
    payload.connection.relayonGroup = 'image';
    payload.connection.catalogId = 'custom-openai';
    expect(parseConnectionShare(JSON.stringify(payload))!.config).not.toHaveProperty('relayonGroup');
    expect(serializeConnection({ name: '自定义', catalogId: 'custom-openai', apiKey: '', relayonGroup: 'image' }))
      .not.toContain('relayonGroup');
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
          body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}', size: '{{size}}', n: '{{n}}' } },
          resultUrlPath: 'data.0.url' } } },
      { id: 'video-fixture', name: '视频', category: 'video', provider: 'custom-original',
        videoCapability: { resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', ratios: ['16:9', '9:16'],
          defaultRatio: '16:9', minDuration: 4, maxDuration: 30, defaultDuration: 5, frameRates: [24], defaultFrameRate: 24,
          maxImageReferences: 10, maxVideoReferences: 3, maxAudioReferences: 3 },
        executionProfile: { preset: 'custom', protocol: { version: 1, mode: 'sync', submit: { method: 'POST', path: '/v1/videos',
          body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}', videos: '{{videoUrls}}', audios: '{{audioUrls}}',
            resolution: '{{resolution}}', ratio: '{{aspectRatio}}', duration: '{{duration}}' } },
          resultUrlPath: 'url' } } },
    ];
    const text = serializeConnection({ name: '自定义渠道', catalogId: 'custom-openai', apiKey: 'private-fixture',
      apiKeyRef: 'secret:provider/custom-original', baseUrl: 'https://example.test/v1', selectedModels: models,
      catalogModels: models, visibleModelCategories: ['image', 'video'] });
    expect(text).not.toContain('private-fixture');
    expect(text).not.toContain('secret:provider');
    const parsed = parseConnectionShare(text)!;
    expect(parsed.diagnostics).toEqual([]);
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

  it('逐模型报告非法协议与未知预设，不把删除协议后的模型留在启用列表', () => {
    const payload = JSON.parse(serializeConnection({ name: '自定义', catalogId: 'custom-openai', apiKey: '', selectedModels: [] }));
    payload.connection.selectedModels = [
      { id: 'valid', category: 'text' },
      { id: 'bad-path', name: '路径错误', category: 'video', executionProfile: { preset: 'custom', protocol: {
        version: 2, mode: 'sync', submit: { method: 'POST', path: 'https://example.test/private?key=private-fixture' },
        response: { type: 'json', result: { urlPath: 'url' } },
      } } },
      { id: 'future', name: '未知预设', category: 'video', executionProfile: { preset: 'future-video' } },
    ];
    const parsed = parseConnectionShare(JSON.stringify(payload))!;
    expect(parsed.config.selectedModels?.map((model) => model.id)).toEqual(['valid']);
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'bad-path', path: 'connection.selectedModels.1.executionProfile.protocol.submit.path' }),
      expect.objectContaining({ modelId: 'future', path: 'connection.selectedModels.2.executionProfile.preset' }),
    ]));
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('private-fixture');
    expect(JSON.stringify(parsed.diagnostics)).not.toContain('https://example.test');
  });

  it('目录中的非法配置也阻止整批导入，结果类别错误定位到结果映射', () => {
    const payload = JSON.parse(serializeConnection({ name: '视频', catalogId: 'custom-openai', apiKey: '',
      selectedModels: [{ id: 'valid', category: 'text', name: '文本', provider: '' }] }));
    payload.connection.catalogModels = [{ id: 'wrong-result', category: 'video', executionProfile: { preset: 'custom', protocol: {
      version: 2, mode: 'sync', submit: { method: 'POST', path: '/generate' },
      response: { type: 'json', result: { textPath: 'prompt' } },
    } } }];
    const parsed = parseConnectionShare(JSON.stringify(payload))!;
    expect(parsed.diagnostics[0]).toMatchObject({ modelId: 'wrong-result', path: 'connection.catalogModels.0.executionProfile.protocol.response.result' });
    expect(parsed.config.catalogModels).toEqual([]);
  });

  it('未声明的可选能力及未配置协议保留为待配置，不要求补全参数', () => {
    const text = serializeConnection({ name: '待配置', catalogId: 'custom-openai', apiKey: '', selectedModels: [
      { id: 'video-empty', name: '待配置视频', category: 'video', provider: '' },
      { id: 'image-empty', name: '待配置图片', category: 'image', provider: '', imageCapability: {} },
    ] });
    const parsed = parseConnectionShare(text)!;
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.config.selectedModels).toHaveLength(2);
    expect(parsed.config.selectedModels![0].videoCapability).toBeUndefined();
    expect(parsed.config.selectedModels![1].imageCapability).toEqual({});
  });
});
