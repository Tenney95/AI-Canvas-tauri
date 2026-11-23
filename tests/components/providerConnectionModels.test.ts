/**
 * providerConnectionModels — 回归测试：RelayOnAPI 编辑初始化保留已保存配置。
 */
import { describe, expect, it } from 'vitest';
import { assertProviderModelsVideoCapabilities, materializeLegacyImageProtocolDefault, mergeModels } from '../../src/components/settings/providerConnection/providerConnectionModels';
import { assertModelProtocolResult } from '../../src/services/ai/modelCapabilityValidation';
import type { ModelExecutionProtocol, ModelProtocolPresetId } from '../../src/types/aiTypes';
import type { GeneralModelCategory, ProviderModelSelection } from '../../src/types';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';

it('preserves configured image tiers and video limits when refreshing a raw catalog', () => {
  const configured = [
    { id: 'image', name: 'Image', category: 'image' as const, provider: 'custom', imageCapability: { resolutions: ['1K'], maxBatchCount: 2 } },
    { id: 'video', name: 'Video', category: 'video' as const, provider: 'custom', videoCapability: { minDuration: 4, maxDuration: 30 } },
  ];
  const refreshed = mergeModels(configured, configured.map(({ id, category, provider }) => ({ id, name: id, category, provider,
    imageCapability: undefined, videoCapability: undefined })));
  expect(refreshed[0].imageCapability).toEqual(configured[0].imageCapability);
  expect(refreshed[1].videoCapability).toEqual(configured[1].videoCapability);
});

it('keeps a configured request whole and never attaches it to a different category', () => {
  const current: ProviderModelSelection = { id: 'same-id', name: 'Edited image', provider: 'custom', category: 'image',
    executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/custom/image', body: { prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'output' } } } } };
  expect(mergeModels([current], [{ ...current, executionProfile: undefined, imageCapability: { maxBatchCount: 8 } }])[0])
    .toMatchObject({ executionProfile: current.executionProfile, imageCapability: undefined });
  const incoming: ProviderModelSelection = { id: current.id, name: 'Remote video', provider: current.provider,
    category: 'video', videoCapability: { durations: [4, 8] } };
  expect(mergeModels([current], [incoming])[0]).toMatchObject({
    category: 'image', videoCapability: undefined, executionProfile: current.executionProfile,
  });
  expect(mergeModels([{ ...current, executionProfile: undefined }], [incoming])[0]).toMatchObject({
    category: 'video', videoCapability: incoming.videoCapability, executionProfile: undefined,
  });
  expect(mergeModels([current], [{ ...incoming, categoryManual: true }], { preferIncomingConfiguration: true })[0]).toMatchObject({
    category: 'video', videoCapability: incoming.videoCapability, executionProfile: undefined,
  });
});

it.each(['cccapi', 'toapis', 'libapi', 'relayonapi'])('%s 刷新目录保留当前连接的显式协议和能力，不借用同名其他厂商合同', (catalogId) => {
  const catalog = structuredClone(getProviderDefinition(catalogId)!.models!.find((model) => model.category === 'image')!);
  const configured: ProviderModelSelection = { ...catalog, provider: catalogId,
    imageCapability: { resolutions: ['1K'] },
    executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/user/images', body: { prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'output' } },
    } },
  };
  const original = JSON.stringify(configured);
  const refreshed = mergeModels([configured], [{ ...catalog, provider: catalogId }]);
  expect(refreshed[0].executionProfile).toEqual(configured.executionProfile);
  expect(refreshed[0].imageCapability).toEqual({ resolutions: ['1K'] });
  expect(refreshed[0].provider).toBe(catalogId);
  expect(JSON.stringify(configured)).toBe(original);
  const other: ProviderModelSelection = { ...configured, provider: 'other-relay', executionProfile: { preset: 'openai-gpt-image' } };
  expect(mergeModels([other], [{ id: other.id, name: other.name, category: other.category, provider: 'other-relay' }])[0].executionProfile)
    .toEqual({ preset: 'openai-gpt-image' });
});

describe('RelayOnAPI 编辑初始化保留已保存配置', () => {
  const savedProtocol = (path: string): ModelExecutionProtocol => ({ version: 2, mode: 'sync',
    submit: { method: 'POST', path, body: { prompt: '{{prompt}}' } },
    response: { type: 'json', result: { urlPath: 'output' } },
  });
  const preferSaved = { preferIncomingConfiguration: true };

  it('本地模板、目录缓存、已选模型依次合并时保留已选自定义协议和比例', () => {
    const definition = getProviderDefinition('relayonapi')!;
    const local = structuredClone(definition.models!.filter((model) => ['Image-2.5-Flare', 'sd-2.0-c1'].includes(model.id)));
    const cached = local.map((model): ProviderModelSelection => ({ ...model,
      executionProfile: { preset: 'custom', protocol: savedProtocol('/cached/generate') },
      ...(model.category === 'image' ? { imageCapability: { resolutions: ['1K'], ratios: ['3:4'] } }
        : { videoCapability: { minDuration: 10, maxDuration: 15, ratios: ['3:4'] } }),
    }));
    const selected = cached.map((model): ProviderModelSelection => ({ ...model,
      executionProfile: { preset: 'custom', protocol: savedProtocol('/user/generate') },
      ...(model.category === 'image' ? { imageCapability: { resolutions: ['2K'], ratios: ['9:16'], maxImageReferences: 2 } }
        : { videoCapability: { minDuration: 10, maxDuration: 12, ratios: ['9:16'] } }),
    }));
    const original = JSON.stringify({ local, cached, selected });
    const merged = mergeModels(mergeModels(local, cached, preferSaved), selected, preferSaved);
    expect(merged).toHaveLength(2);
    for (const saved of selected) {
      const result = merged.find((model) => model.id === saved.id)!;
      expect(result.executionProfile).toEqual(saved.executionProfile);
      expect(result.imageCapability).toEqual(saved.imageCapability);
      expect(result.videoCapability).toEqual(saved.videoCapability);
    }
    expect(JSON.stringify({ local, cached, selected })).toBe(original);
  });

  it('未选择的型号保留缓存配置，未保存的字段仍由已有配置提供', () => {
    const local = structuredClone(getProviderDefinition('relayonapi')!.models!.find((model) => model.id === 'Image-2.5-Flare')!);
    const cached: ProviderModelSelection = { ...local,
      executionProfile: { preset: 'custom', protocol: savedProtocol('/cached/images') },
      imageCapability: { resolutions: ['1K'], ratios: ['4:3'] },
    };
    const initialized = mergeModels(mergeModels([local], [cached], preferSaved), [], preferSaved);
    expect(initialized[0].executionProfile).toEqual(cached.executionProfile);
    expect(initialized[0].imageCapability).toEqual(cached.imageCapability);
    const partial: ProviderModelSelection = { id: cached.id, name: cached.name, provider: cached.provider,
      category: 'image', executionProfile: undefined, imageCapability: undefined, videoCapability: undefined };
    expect(mergeModels(initialized, [partial], preferSaved)[0]).toMatchObject({
      executionProfile: cached.executionProfile, imageCapability: cached.imageCapability,
    });
  });

  it('该选项不改变手动元数据规则，其他调用仍默认保留当前协议和能力', () => {
    const current: ProviderModelSelection = { id: 'fixture', name: '当前友好名称', category: 'image', categoryManual: true,
      provider: 'custom', description: '人工说明', descriptionManual: true, inputModalities: ['text'], inputModalitiesManual: true,
      imageCapability: { ratios: ['9:16'] }, executionProfile: { preset: 'custom', protocol: savedProtocol('/current') } };
    const incoming: ProviderModelSelection = { id: 'fixture', name: 'fixture', category: 'video', provider: 'custom',
      description: '目录说明', inputModalities: ['text', 'image'],
      imageCapability: { ratios: ['1:1'] }, executionProfile: { preset: 'custom', protocol: savedProtocol('/incoming') } };
    const normal = mergeModels([current], [incoming])[0];
    expect(normal.imageCapability).toEqual(current.imageCapability);
    expect(normal.executionProfile).toEqual(current.executionProfile);
    const preferred = mergeModels([current], [incoming], preferSaved)[0];
    expect(preferred.imageCapability).toEqual(current.imageCapability);
    expect(preferred.executionProfile).toEqual(current.executionProfile);
    for (const result of [normal, preferred]) {
      expect(result).toMatchObject({ name: current.name, category: current.category,
        description: current.description, descriptionManual: true, inputModalities: ['text'], inputModalitiesManual: true });
    }
  });
});

describe('legacy connection image protocol', () => {
  it('copies a saved connection default only to selected image models without overrides', () => {
    const models = materializeLegacyImageProtocolDefault([
      { id: 'image-a', name: '图片 A', category: 'image', provider: 'gateway' },
      { id: 'image-b', name: '图片 B', category: 'image', provider: 'gateway',
        executionProfile: { preset: 'openai-gpt-image' },
        imageReferenceRequestMode: 'edits-multipart' },
      { id: 'text-a', name: '文本 A', category: 'text', provider: 'gateway' },
    ], {
      imageProtocolDefault: { preset: 'gpt-image-gateway-json' },
      imageReferenceRequestModeDefault: 'generation-json-image-data-urls',
    });
    expect(models[0]).toMatchObject({
      executionProfile: { preset: 'gpt-image-gateway-json' },
      imageReferenceRequestMode: 'generation-json-image-data-urls',
    });
    expect(models[1]).toMatchObject({
      executionProfile: { preset: 'openai-gpt-image' },
      imageReferenceRequestMode: 'edits-multipart',
    });
    expect(models[2].executionProfile).toBeUndefined();
  });
});

describe('自定义模型结果合同', () => {
  const validate = (category: GeneralModelCategory, protocol: ModelExecutionProtocol) => assertProviderModelsVideoCapabilities([
    { id: 'fixture', name: '测试模型', category, provider: '', executionProfile: { preset: 'custom', protocol } },
  ]);
  const submit = { method: 'POST' as const, path: '/generate' };

  it('保存视频文本结果映射时准确报告结果位置，未声明可选能力仍允许保存', () => {
    expect(() => validate('video', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { textPath: 'prompt' } } })).toThrow('response.result');
    expect(() => validate('video', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { urlPath: 'output' } } })).not.toThrow();
    expect(() => assertProviderModelsVideoCapabilities([
      { id: 'pending', name: '待配置', category: 'video', provider: '' },
    ])).not.toThrow();
  });

  it('接受 Base64、同步二进制和异步下载，不从 URL 后缀猜媒体类型', () => {
    expect(() => validate('image', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { base64Path: 'image', mimeType: 'image/png' } } })).not.toThrow();
    expect(() => validate('audio', { version: 2, mode: 'sync', submit,
      response: { type: 'binary', result: { mimeType: 'audio/mpeg' } } })).not.toThrow();
    expect(() => validate('video', { version: 2, mode: 'async', submit, response: { type: 'json', taskIdPath: 'id' },
      poll: { method: 'GET', path: '/tasks/{{submit.id}}', response: { statusPath: 'status', successValues: ['completed'],
        failureValues: ['failed'], result: { download: { method: 'GET', path: '/tasks/{{submit.id}}/content' }, mimeType: 'video/mp4' } } } })).not.toThrow();
    expect(() => assertModelProtocolResult('video', { urls: ['https://example.test/signed-download?token=fixture'] })).not.toThrow();
  });

  it('声明的 MIME 类型、原生文本预设和未知预设不能冒充媒体协议', () => {
    expect(() => validate('video', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { urlPath: 'output', mimeType: 'image/png' } } })).toThrow('mimeType');
    expect(() => validate('text', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { urlPath: 'output' } } })).toThrow('文本模型');
    for (const preset of ['openai-chat', 'anthropic-chat', 'future-preset']) {
      expect(() => assertProviderModelsVideoCapabilities([{ id: 'v', name: '视频', category: 'video', provider: '',
        executionProfile: { preset: preset as ModelProtocolPresetId } }])).toThrow();
    }
  });

  it('真实试跑必须得到当前类别的非空结果，返回文本不能算视频成功', () => {
    expect(() => assertModelProtocolResult('video', { text: 'enhanced prompt' })).toThrow('没有解析出有效媒体结果地址');
    expect(() => assertModelProtocolResult('image', { urls: [] })).toThrow('有效媒体结果地址');
    expect(() => assertModelProtocolResult('text', { urls: ['https://example.test/result'] })).toThrow('文本');
    expect(() => assertModelProtocolResult('text', { text: '   ' })).toThrow('文本');
    expect(() => assertModelProtocolResult('text', { text: '完成' })).not.toThrow();
  });

  it('实际返回文本、带凭据 URL、JSON 二进制或错误媒体 MIME 不能算媒体试跑成功', () => {
    for (const url of ['enhanced prompt', 'file:///private/video.mp4', 'https://user:password@example.test/video',
      'javascript:alert(1)', 'data:application/json;base64,e30=', 'data:image/png;base64,aW1hZ2U=']) {
      expect(() => assertModelProtocolResult('video', { urls: [url] })).toThrow();
    }
    expect(() => assertModelProtocolResult('video', { urls: ['data:video/mp4;base64,dmlkZW8='] })).not.toThrow();
    expect(() => assertModelProtocolResult('image', { urls: ['data:image/png;base64,aW1hZ2U='] })).not.toThrow();
    expect(() => assertModelProtocolResult('audio', { urls: ['data:audio/wav;base64,YXVkaW8='] })).not.toThrow();
    expect(() => assertModelProtocolResult('video', { urls: ['https://example.test/result.png?signature=fixture'] })).not.toThrow();
    expect(() => assertModelProtocolResult('video', { urls: ['https://example.test/result', 'not a URL'] })).toThrow();
  });
});
