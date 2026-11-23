/**
 * providerCatalogService — 回归测试：厂商定义与接线策略。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProviderModelCatalog,
  getProviderDefinition,
  getProviderDefinitions,
  createConnectionId,
  isRetiredProviderConnection,
} from '../../src/services/ai/providerCatalogService';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';
import {
  defaultModelGroups,
  getConfiguredModelGroups,
  getGeneralModelGroups,
  getMediaModelOptions,
} from '../../src/components/nodes/shared/defaultModels';
import { assertVideoModelCapability } from '../../src/services/ai/videoRequestResolver';
import { parseConnectionShare, serializeConnection } from '../../src/services/ai/providerConnectionTransfer';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';
import { AIGCSI_MODEL_MANIFEST } from '../../src/services/ai/providers/aigcsiModelManifest';
import { RELAYON_IMAGE_MODEL_IDS, RELAYON_MODEL_MANIFEST, RELAYON_VIDEO_MODEL_IDS } from '../../src/services/ai/providers/relayonModelManifest';
import { RELAYON_PROVIDER_GROUPS, getRelayonGroupPresetModels, relayonConnectionName } from '../../src/services/ai/relayonProviderGroups';
import { useAppStore } from '../../src/store/useAppStore';
import type { ApiProviderConfig, AppConfig, ProviderModelSelection } from '../../src/types';
import { getProviderPolicy } from '../../src/services/ai/providerPolicies';
import { resolveGeneralModelConnection } from '../../src/services/ai/helpers';
import { jsonResponse } from './providerCatalogService/catalogResponse';

it('远端目录优先使用类别声明，并保留嵌套提示词与长时长能力', async () => {
  try {
    const payload = { data: [
      { id: 'kling-image-next', image_capability: { prompt_max_characters: 50_000 } },
      { id: 'kling-unknown', category: 'image', imageCapability: { promptMaxCharacters: 80_000 } },
      { id: 'private-generation', type: 'video', videoCapability: { promptMaxCharacters: 30_000,
        minDuration: 4, maxDuration: 180, ratios: ['16:9'], maxImageReferences: 12 } },
    ] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));
    const result = await fetchProviderModelCatalog({ providerId: 'custom', config: {
      name: 'Custom', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://api.example/v1',
    } });
    expect(result.models.find((model) => model.id === 'kling-image-next')).toMatchObject({ category: 'image', imageCapability: { promptMaxCharacters: 50_000 } });
    expect(result.models.find((model) => model.id === 'kling-unknown')?.category).toBe('image');
    expect(result.models.find((model) => model.id === 'private-generation')?.videoCapability).toMatchObject({
      promptMaxCharacters: 30_000, minDuration: 4, maxDuration: 180, ratios: ['16:9'], maxImageReferences: 12 });
  } finally { vi.unstubAllGlobals(); }
});

it('目录局部更新保留本地的提示词上限、时长和显式 false', async () => {
  try {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'private-image', category: 'image', imageCapability: { ratios: ['3:2'] } },
      { id: 'private-video', category: 'video', videoCapability: { maxImageReferences: 10, supportsStandaloneAudio: false } },
    ] })));
    const result = await fetchProviderModelCatalog({ providerId: 'custom', config: {
      name: 'Custom', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://api.example/v1',
    }, fallbackModels: [
      { id: 'private-image', name: 'Image', provider: 'custom', category: 'image',
        imageCapability: { promptMaxCharacters: 100_000, ratios: ['1:1'] } },
      { id: 'private-video', name: 'Video', provider: 'custom', category: 'video',
        videoCapability: { promptMaxCharacters: 30_000, minDuration: 4, maxDuration: 180, supportsStandaloneAudio: true } },
    ] });
    expect(result.models.find((model) => model.id === 'private-image')?.imageCapability)
      .toMatchObject({ promptMaxCharacters: 100_000, ratios: ['3:2'] });
    expect(result.models.find((model) => model.id === 'private-video')?.videoCapability)
      .toMatchObject({ promptMaxCharacters: 30_000, minDuration: 4, maxDuration: 180,
        maxImageReferences: 10, supportsStandaloneAudio: false });
  } finally { vi.unstubAllGlobals(); }
});

describe('远端媒体目录长度合并', () => {
  const config: ApiProviderConfig = { name: '自定义接口', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://api.example/v1' };
  const image = { id: 'private-image', name: 'Image', provider: 'custom', category: 'image',
    imageCapability: { promptMaxCharacters: 50_000, promptMaxNonAsciiCharacters: 20_000 } } as const satisfies ProviderModelSelection;
  const video: ProviderModelSelection = { id: 'private-video', name: 'Video', provider: 'custom', category: 'video',
    videoCapability: { durations: [5, 10, 20, 30], minDuration: 5, maxDuration: 30, defaultDuration: 10, promptMaxCharacters: 26_000 } };

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { durations: [5, -10, 30] },
    { durations: [5, '10', 30] },
    { durations: [] },
    { durations: [5, 30], min_duration: 10 },
    { min_duration: 21, max_duration: 29 },
    { max_duration: 4 },
    { default_duration: 12 },
  ])('无效时长 %j 保留原时长合同，其他元数据仍能更新', async (invalidTiming) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: video.id, category: 'video',
      video_capability: { ...invalidTiming, prompt_max_characters: 30_000 } }] })));
    const { models } = await fetchProviderModelCatalog({ providerId: 'custom', config, fallbackModels: [video] });
    expect(models[0].videoCapability).toMatchObject({ ...video.videoCapability, promptMaxCharacters: 30_000 });
    expect(() => assertVideoModelCapability(models[0].videoCapability)).not.toThrow();
  });

  it('仅更新区间时收窄已有档位，丢弃不再适用的旧默认值', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: video.id, category: 'video',
      video_capability: { duration_range: { min: 15, max: 30 } } }] })));
    const { models } = await fetchProviderModelCatalog({ providerId: 'custom', config, fallbackModels: [video] });
    const capability = models[0].videoCapability;
    expect(capability).toMatchObject({ durations: [20, 30], minDuration: 15, maxDuration: 30 });
    expect(capability?.defaultDuration).toBeUndefined();
    expect(() => assertVideoModelCapability(capability)).not.toThrow();
  });

  it('新的显式档位可以扩展长度，保留小数秒并断开与旧区间的关联', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: video.id, category: 'video',
      video_capability: { durations: [180, 2.5, 180], default_duration: 180 } }] })));
    const { models } = await fetchProviderModelCatalog({ providerId: 'custom', config, fallbackModels: [video] });
    expect(models[0].videoCapability).toMatchObject({ durations: [2.5, 180], minDuration: 2.5, maxDuration: 180, defaultDuration: 180 });
    expect(() => assertVideoModelCapability(models[0].videoCapability)).not.toThrow();
    expect(video.videoCapability?.durations).toEqual([5, 10, 20, 30]);
  });

  it('错误的双预算成组保留，合法总量可收紧原有加权预算，未知上限不伪造', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: image.id, category: 'image', image_capability: { prompt_max_characters: 100_000, prompt_max_non_ascii_characters: 120_000 } },
      { id: video.id, category: 'video', video_capability: { promptMaxCharacters: 3.5, durations: [60] } },
      { id: 'other-image', category: 'image', image_capability: { prompt_max_characters: 5_000 } },
      { id: 'raw-video', category: 'video', video_capability: { prompt_max_non_ascii_characters: 10_000, durations: [0] } },
    ] })));
    const { models } = await fetchProviderModelCatalog({ providerId: 'custom', config, fallbackModels: [image, { ...image, id: 'other-image' }, video] });
    expect(models.find(({ id }) => id === image.id)?.imageCapability).toMatchObject(image.imageCapability);
    expect(models.find(({ id }) => id === video.id)?.videoCapability).toMatchObject({ promptMaxCharacters: 26_000, durations: [60] });
    expect(models.find(({ id }) => id === 'other-image')?.imageCapability).toMatchObject({ promptMaxCharacters: 5_000, promptMaxNonAsciiCharacters: 5_000 });
    expect(models.find(({ id }) => id === 'raw-video')?.videoCapability).toBeUndefined();
  });
});

describe('MiniMax 官方本地候选目录', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('新建无 Key 时列出八个候选，刷新不调用假设的 models 接口或声称远端验证成功', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const definition = getProviderDefinition('minimax')!;
    expect(definition).toMatchObject({ name: 'MiniMax 官方', catalogAdapter: 'local-manifest',
      defaultBaseUrl: 'https://api.minimax.cn', allowCustomBaseUrl: true });
    expect(definition.policy.catalog.connectionTest).toBe('default');
    const result = await fetchProviderModelCatalog({ providerId: 'minimax-international',
      config: { name: 'MiniMax 国际', catalogId: 'minimax', apiKey: '', baseUrl: 'https://api.minimax.io' },
      fallbackModels: [{ id: 'old-stale', name: 'Old', category: 'video', provider: 'minimax-international' }],
    });
    expect(result.source).toBe('local-manifest');
    expect(result.warning).toContain('未验证 API Key');
    expect(result.models).toHaveLength(8);
    expect(result.models.every((model) => model.provider === 'minimax-international')).toBe(true);
    expect(result.models.map((model) => model.id)).toContain('speech-2.8-hd');
    expect(result.models.filter((model) => model.category === 'image').map((model) => model.id))
      .toEqual(['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed']);
    expect(result.models.some((model) => model.id === 'old-stale')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('已保存连接及菜单保留各自身份，显式同名自定义连接不借用官方合同', () => {
    const definition = getProviderDefinition('minimax')!;
    const selected = definition.models!.filter((item) => item.id === 'MiniMax-H3');
    const config: AppConfig = { theme: 'dark', providers: {
      domestic: { name: '国内', catalogId: 'minimax', apiKey: 'domestic-fixture', selectedModels: [...selected] },
      international: { name: '国际', catalogId: 'minimax', apiKey: 'international-fixture', baseUrl: 'https://api.minimax.io', selectedModels: [...selected] },
    } };
    const models = ['domestic', 'international'].map((id) => ({ id, name: 'H3', category: 'video' as const,
      modelId: 'MiniMax-H3', providerConfigId: id }));
    const groups = getGeneralModelGroups(models, config, 'ai-video');
    expect(groups.map((group) => group.id)).toEqual(['general-provider-domestic', 'general-provider-international']);
    expect(getProviderDefinition('minimax', { catalogId: 'custom-openai' })!.models).toBeUndefined();
  });
});

describe('厂商定义与接线策略', () => {
  it('目录沿用单一策略实例，连接类型不由显示名或同名 ID 覆盖', () => {
    for (const definition of getProviderDefinitions()) expect(definition.policy).toBe(getProviderPolicy(definition.id));
    const custom = getProviderDefinition('libapi', { catalogId: 'custom-openai' });
    expect(custom?.id).toBe('custom-openai');
    expect(custom?.policy.upload).toBeUndefined();
    expect(getProviderDefinition('自己的站点', { catalogId: 'libapi' })?.policy.upload).toBe('libapi');
  });

  it('模型连接只解析一次真实定义和默认地址，不借用其他连接 Key', () => {
    const previous = useAppStore.getState().config;
    try {
      useAppStore.setState({ config: { ...previous, providers: {
        '自己的站点': { name: '自己的站点', catalogId: 'libapi', apiKey: 'own-key' },
        libapi: { name: '同名自定义', catalogId: 'custom-openai', apiKey: 'custom-key', baseUrl: 'https://custom.example/v1' },
      }, generalModels: [
        { id: 'real', name: '视频', category: 'video', providerConfigId: '自己的站点', modelId: 'vo-3.1' },
        { id: 'custom', name: '视频', category: 'video', providerConfigId: 'libapi', modelId: 'vo-3.1' },
      ] } });
      expect(resolveGeneralModelConnection('general/real')).toMatchObject({ apiKey: 'own-key', baseUrl: 'https://libapi.cc/v1',
        definition: { id: 'libapi', policy: { upload: 'libapi' } } });
      expect(resolveGeneralModelConnection('general/custom')).toMatchObject({ apiKey: 'custom-key', baseUrl: 'https://custom.example/v1',
        definition: { id: 'custom-openai' } });
      expect(resolveGeneralModelConnection('general/custom')?.definition?.policy.upload).toBeUndefined();
    } finally {
      useAppStore.setState({ config: previous });
    }
  });

  it.each([
    ['cccapi', undefined, true], ['cccapi', '白嫖', false],
    ['toapis', undefined, false], ['libapi', undefined, false], ['custom-openai', undefined, true],
  ] as const)('%s 的目录失败兜底保留原有分组条件（%s）', async (catalogId, cccGroup, allowFallback) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const fallback: ProviderModelSelection[] = [{ id: 'saved-model', name: '旧候选', provider: catalogId, category: 'text' }];
    try {
      const request = fetchProviderModelCatalog({ providerId: '任意连接名', config: {
        name: '连接', catalogId, cccGroup, apiKey: 'fixture', baseUrl: 'https://relay.example/v1',
      }, fallbackModels: fallback });
      if (allowFallback) expect(await request).toMatchObject({ source: 'local-fallback', models: [{ ...fallback[0], provider: '任意连接名' }] });
      else await expect(request).rejects.toThrow('503');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Amam 内置目录与连接身份', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('默认候选包含 Muse，保存后同步为通用模型，保留当前连接而非借用同名 Key', () => {
    expect(getProviderDefinition('aigc-si')).toMatchObject({ name: 'Amam（AIGC SI）', models: AIGCSI_MODEL_MANIFEST,
      defaultBaseUrl: 'https://aigc-si.com/v1', modelsPath: '/models', externalUrl: 'https://aigc-si.com/?ref=OAXZHWXT' });
    expect(getProviderDefinition('aigc-si')?.description).toContain('每秒 2 分');
    const previous = useAppStore.getState().config;
    try {
      const selected = AIGCSI_MODEL_MANIFEST.find((item) => item.id === 'muse-video-1')!;
      useAppStore.getState().saveProviderConfig('my-amam', { name: '自己的 Amam', catalogId: 'aigc-si',
        apiKey: 'my-fixture', selectedModels: [selected] });
      const synced = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'my-amam')!;
      expect(synced).toMatchObject({ category: 'video', modelId: 'muse-video-1', executionProfile: selected.executionProfile,
        videoCapability: selected.videoCapability });
      expect(resolveGeneralModelConnection(`general/${synced.id}`)).toMatchObject({ apiKey: 'my-fixture',
        providerConfigId: 'my-amam', baseUrl: 'https://aigc-si.com/v1', definition: { id: 'aigc-si' } });
    } finally {
      useAppStore.setState({ config: previous });
    }
    expect(getProviderDefinition('aigc-si', { catalogId: 'custom-openai' })?.id).toBe('custom-openai');
  });

  it('按 api_model 与已适配精确调用值求交，合并 H3 重复 SKU，不采用远端误分类或未知能力', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'muse-internal-sku', api_model: 'muse-video-1', kind: 'video', resolutions: ['4K'] },
      { id: 'h3-768', api_model: 'minimax-h3-5' }, { id: 'h3-2k', api_model: 'minimax-h3-5' },
      { id: 'image-2.5-flare' }, { id: '香蕉' }, { id: 'image-2', enabled: false },
      { id: 'native-image-2.5-flare-pool' }, { id: 'MJ-2k' }, { id: 'future-model' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'my-amam',
      config: { name: 'Amam', catalogId: 'aigc-si', apiKey: 'am-fixture' }, fallbackModels: [...AIGCSI_MODEL_MANIFEST] });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://aigc-si.com/v1/models', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer am-fixture' },
    }));
    expect(new Set(result.models.map((item) => item.id))).toEqual(new Set(['muse-video-1', 'minimax-h3-5', 'image-2.5-flare', '香蕉']));
    expect(result.models.every((item) => item.provider === 'my-amam')).toBe(true);
    expect(result.models.find((item) => item.id === 'muse-video-1')?.videoCapability?.resolutions).toEqual(['720p']);
    expect(result.models.find((item) => item.id === '香蕉')?.category).toBe('image');
    expect(result).toMatchObject({ source: 'remote', resolvedBaseUrl: 'https://aigc-si.com/v1', warning: expect.any(String) });
  });

  it.each([401, 503])('认证目录 HTTP %s 不回退静态候选冒充可用型号', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(fetchProviderModelCatalog({ providerId: 'my-amam',
      config: { name: 'Amam', catalogId: 'aigc-si', apiKey: 'fixture' },
      fallbackModels: [...AIGCSI_MODEL_MANIFEST] })).rejects.toThrow(String(status));
  });

  it('未填 Key 时不查询，也不将默认目录标记为认证成功', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModelCatalog({ providerId: 'my-amam',
      config: { name: 'Amam', catalogId: 'aigc-si', apiKey: '' }, fallbackModels: [...AIGCSI_MODEL_MANIFEST] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LibAPI 内置目录与连接身份', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('注册入口使用邀请码，默认地址与模型合同集中在厂商定义', () => {
    expect(getProviderDefinition('libapi')).toMatchObject({
      name: 'LibAPI', defaultBaseUrl: 'https://libapi.cc/v1', modelsPath: '/models',
      externalUrl: 'https://libapi.cc/signup?ref=HVM4YNC85BR8R97K',
      catalogAdapter: 'openai-compatible', models: LIBAPI_MODEL_MANIFEST,
    });
    expect(createConnectionId('libapi')).toBe('libapi');
  });

  it('先校验目录凭据，再与公开逻辑目录及本地合同求交并排除退役型号', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [
        { id: 'gt-6.1-sol' }, { id: 'gpt-image-2.5-flare', category: 'text' }, { id: 'vo-3.1' },
        { id: 'happyhorse-1-1' }, { id: 'doubao-seedream-5-0' }, { id: 'future-video' },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ models: [
        { id: 'gpt-6.1-sol', public_id: 'gt-6.1-sol', type: 'chat' },
        { id: 'gpt-image-2.5-flare', public_id: 'gt-image-2.5-flare', type: 'image', deprecated: false },
        { id: 'veo-3.1', type: 'video' }, { id: 'happyhorse-1-1', type: 'video', deprecated: true },
        { id: 'seedance-2-5', type: 'video' }, { id: 'future-video', type: 'video' },
      ] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'libapi',
      config: { name: 'LibAPI', apiKey: 'libapi-fixture', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://libapi.cc/v1/models', 'https://libapi.cc/v1/logical-models',
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer libapi-fixture' } });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(result).toMatchObject({ source: 'remote', resolvedBaseUrl: 'https://libapi.cc/v1' });
    expect(result.models.map(({ id, category, provider }) => ({ id, category, provider }))).toEqual([
      { id: 'gpt-image-2.5-flare', category: 'image', provider: 'libapi' },
      { id: 'gt-6.1-sol', category: 'text', provider: 'libapi' },
      { id: 'vo-3.1', category: 'video', provider: 'libapi' },
    ]);
    expect(result.models.filter((model) => model.category !== 'text').every((model) => model.executionProfile)).toBe(true);
    expect(result.warning).toBeTruthy();
  });

  it.each([401, 503])('认证目录 HTTP %s 失败不回退静态模型，也不访问公开逻辑目录', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModelCatalog({ providerId: 'libapi', config: { name: 'LibAPI', apiKey: 'fixture', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST] })).rejects.toThrow(`模型列表拉取失败 (HTTP ${status})`);
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://libapi.cc/v1/models')).toBe(true);
  });

  it('公开逻辑目录失败保留调用方旧选择，不用静态型号冒充已验证目录', async () => {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gt-image-2.5-flare')!;
    const config: ApiProviderConfig = { name: 'LibAPI', apiKey: 'fixture', catalogId: 'libapi', selectedModels: [selected] };
    const original = JSON.stringify(config);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ id: selected.id }] }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 })));
    await expect(fetchProviderModelCatalog({ providerId: 'libapi', config, fallbackModels: [...LIBAPI_MODEL_MANIFEST] }))
      .rejects.toThrow('模型列表拉取失败 (HTTP 503)');
    expect(JSON.stringify(config)).toBe(original);
  });

  it('缺少 Key 时不请求目录', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModelCatalog({ providerId: 'libapi', config: { name: 'LibAPI', apiKey: '', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'future-video', type: 'video' },
    { id: 'happyhorse-1-1', type: 'video', deprecated: true },
  ])('目录中的 $id 无适配或已退役时返回空的远端结果', async (model) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: model.id }] }))
      .mockResolvedValueOnce(jsonResponse({ models: [model] })));
    const result = await fetchProviderModelCatalog({ providerId: 'libapi', config: { name: 'LibAPI', apiKey: 'fixture', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST] });
    expect(result).toMatchObject({ source: 'remote', models: [] });
    expect(result.warning).toBeTruthy();
  });

  it('保存和分享导入贯通节点模型，持久化默认地址并保留用户协议及稳定身份', () => {
    const previous = useAppStore.getState().config;
    const selected = structuredClone(LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gt-image-2.5-flare')!);
    selected.executionProfile = { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/user/images', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'data.*.url' } },
    } };
    selected.imageCapability = undefined;
    selected.imageReferenceRequestMode = undefined;
    const config: ApiProviderConfig = { name: 'LibAPI', apiKey: '', catalogId: 'libapi', selectedModels: [selected] };
    const parsed = parseConnectionShare(serializeConnection(config))!;
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.config.selectedModels?.[0].executionProfile).toEqual(selected.executionProfile);
    try {
      useAppStore.setState({ config: { ...previous, providers: {}, generalModels: [] } });
      useAppStore.getState().saveProviderConfig('libapi', parsed.config);
      const saved = useAppStore.getState().config;
      const model = saved.generalModels![0];
      expect(saved.providers.libapi.baseUrl).toBe('https://libapi.cc/v1');
      expect(model).toMatchObject({ modelId: selected.id, providerConfigId: 'libapi', category: 'image', executionProfile: selected.executionProfile });
      useAppStore.getState().saveProviderConfig('libapi', { ...parsed.config, name: 'LibAPI 已编辑' });
      expect(useAppStore.getState().config.generalModels![0].id).toBe(model.id);
      expect(selected.executionProfile.protocol!.submit.path).toBe('/user/images');
    } finally {
      useAppStore.setState({ config: previous });
    }
  });
});

describe('万象 API 内置目录与连接身份', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('默认提供四个主流文本及已适配媒体候选，不自动启用型号', () => {
    const definition = getProviderDefinition('relayonapi');
    expect(definition).toMatchObject({
      name: '万象 API（RelayOnAPI）', defaultBaseUrl: 'https://relayonapi.com/v1', modelsPath: '/models',
      catalogAdapter: 'openai-compatible', models: RELAYON_MODEL_MANIFEST,
      policy: { syncGeneralModels: true, catalog: {
        initialModelsOnCreate: 'fallback', initialModelsOnEdit: 'fallback', refresh: 'replace-unselected',
        fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog',
      } },
    });
    expect(definition?.models?.filter((model) => model.category === 'text').map((model) => model.id)).toEqual([
      'gemini-3.8-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5-5',
    ]);
    expect(definition?.models).toHaveLength(34);
    expect(definition?.models?.filter((model) => model.category === 'image').map((model) => model.id)).toEqual([...RELAYON_IMAGE_MODEL_IDS]);
    expect(definition?.models?.filter((model) => model.category === 'video').map((model) => model.id)).toEqual([...RELAYON_VIDEO_MODEL_IDS]);
    expect(definition?.models?.filter((model) => model.category === 'text').every((model) => model.executionProfile?.preset === 'openai-chat')).toBe(true);
    expect(definition?.models?.filter((model) => model.category !== 'text').every((model) => model.executionProfile?.preset === 'custom')).toBe(true);
    expect(definition?.policy.upload).toBeUndefined();
    expect(createConnectionId('relayonapi')).toMatch(/^relayonapi-.+/);
  });

  it('分组候选是精确型号的静态快照，并非密钥验证', () => {
    expect(RELAYON_PROVIDER_GROUPS.map(({ name }) => name)).toEqual([
      'Claudekiro号池', 'GPTpro号池', 'Gemini号池', 'default', 'image', 'video',
    ]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'Gemini号池').map(({ id }) => id)).toEqual([
      'gemini-3.8-flash', 'gemini-4-argon',
    ]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'image').map(({ id }) => id)).toEqual([...RELAYON_IMAGE_MODEL_IDS]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'video')).toHaveLength(13);
    for (const id of ['minimax-h3', 'sd-2.0-c3', 'sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3']) {
      expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'video').some((model) => model.id === id)).toBe(true);
      for (const group of ['image', 'default', 'GPTpro号池', 'Gemini号池', 'Claudekiro号池']) {
        expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, group).some((model) => model.id === id)).toBe(false);
      }
    }
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'default')).toEqual([]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, '其他分组')).toEqual([]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST)).toEqual(RELAYON_MODEL_MANIFEST);
    expect(relayonConnectionName({ relayonGroup: 'image' })).toBe('万象 API · image');
    expect(relayonConnectionName()).toBe('万象 API（RelayOnAPI）');
  });

  it('分组刷新求交当前 Key 目录、公开分组与适配型号，公开请求不携带凭据', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'Image-2.5-Flare' }, { id: 'Image-2.5-Sunburst' }, { id: 'future' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [
        { model_name: 'Image-2.5-Flare', enable_groups: ['image'] },
        { model_name: 'Image-2.5-Sunburst', enable_groups: ['other'] },
        { model_name: 'nano-banana-2', enable_groups: ['image'] },
        { model_name: 'future', enable_groups: ['image'] },
      ] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'relayonapi-image', config: {
      name: '图片组', catalogId: 'relayonapi', relayonGroup: 'image', apiKey: 'group-key',
    } });
    expect(result.models.map(({ id }) => id)).toEqual(['Image-2.5-Flare']);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer group-key' } });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.relayonapi.com/api/pricing');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: 'omit' });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body');
  });

  it('视频候选包含 2.5 C2／C3，只按 video 分组及当前 Key 实际权限启用', async () => {
    const ids = ['minimax-h3', 'sd-2.0-c3', 'sd-2.5-c1', 'sd-2.5-c2', 'sd-2.5-c3'];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: ids.map((id) => ({ id })) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ids.map((id) => ({ model_name: id, enable_groups: ['video'] })) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'my-video-group', config: {
      name: '视频组', catalogId: 'relayonapi', relayonGroup: 'video', apiKey: 'video-group-fixture',
    } });
    expect(result.models.map(({ id }) => id)).toEqual(ids);
    expect(result.models.every((model) => model.category === 'video' && model.provider === 'my-video-group')).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer video-group-fixture' });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('headers');
  });

  it.each(['sd-2.5-c2', 'sd-2.5-c3'])('%s 未获当前 Key 开放时不从公开视频候选补入', async (id) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'sd-2.5-c1' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ['sd-2.5-c1', id]
        .map((model_name) => ({ model_name, enable_groups: ['video'] })) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'my-video-group', config: {
      name: '视频组', catalogId: 'relayonapi', relayonGroup: 'video', apiKey: 'video-group-fixture',
    } });
    expect(result.models.map((model) => model.id)).toEqual(['sd-2.5-c1']);
  });

  it.each([null, { success: false, data: [] }, { success: true, data: [{ model_name: 'x' }] }])(
    '公开分组目录无效时不覆盖已有选择（%s）', async (payload) => {
      const selected = RELAYON_MODEL_MANIFEST[0];
      const config: ApiProviderConfig = { name: '万象', catalogId: 'relayonapi', relayonGroup: 'image',
        apiKey: 'fixture', selectedModels: [selected] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ id: selected.id }] }))
        .mockResolvedValueOnce(jsonResponse(payload)));
      await expect(fetchProviderModelCatalog({ providerId: 'relayonapi-group', config })).rejects.toThrow();
      expect(config.selectedModels).toEqual([selected]);
    },
  );

  it('公开目录不可用时不以静态候选冒充已验证结果', async () => {
    const selected = RELAYON_MODEL_MANIFEST[0];
    const config: ApiProviderConfig = { name: '万象', catalogId: 'relayonapi', relayonGroup: 'image',
      apiKey: 'fixture', selectedModels: [selected] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ id: selected.id }] }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 })));
    await expect(fetchProviderModelCatalog({ providerId: 'relayonapi-group', config,
      fallbackModels: [...RELAYON_MODEL_MANIFEST] })).rejects.toThrow('503');
    expect(config.selectedModels).toEqual([selected]);
  });

  it('有效目录中没有该分组时返回空列表，而不补静态候选', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ id: 'Image-2.5-Flare' }] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [
        { model_name: 'Image-2.5-Flare', enable_groups: ['image'] },
      ] })));
    const result = await fetchProviderModelCatalog({ providerId: 'relayonapi-group', config: {
      name: '万象', catalogId: 'relayonapi', relayonGroup: 'default', apiKey: 'fixture',
    } });
    expect(result.models).toEqual([]);
    expect(result.source).toBe('remote');
  });

  it('别名连接仅用自己的 Key 查询可用目录，精确匹配三类合同并排除未接入型号', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [
      ...RELAYON_MODEL_MANIFEST.map((model) => ({ id: model.id, category: 'audio' })),
      { id: 'gemini-3.8-flash' }, { id: 'claude-fable-5-1' }, { id: 'Midjourney v8.2' },
      { id: 'gpt-6-astra' }, { id: 'future-model' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const config: ApiProviderConfig = {
      name: '我的万象连接', catalogId: 'relayonapi', apiKey: 'alias-fixture-key', selectedModels: [],
    };
    const result = await fetchProviderModelCatalog({ providerId: 'relayon-alias', config,
      fallbackModels: [...RELAYON_MODEL_MANIFEST] });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://relayonapi.com/v1/models', expect.objectContaining({
      method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer alias-fixture-key' }),
    }));
    expect(result).toMatchObject({ source: 'remote', resolvedBaseUrl: 'https://relayonapi.com/v1' });
    expect(result.models).toHaveLength(34);
    expect(result.models).toEqual(expect.arrayContaining(RELAYON_MODEL_MANIFEST.map((model) => ({
      ...model, provider: 'relayon-alias',
    }))));
    expect(config.selectedModels).toEqual([]);
    expect(result.warning).toBeTruthy();
  });

  it.each(['401', '网络断开'])('%s 不用预置候选冒充已验证目录', async (failure) => {
    const fetchMock = failure === '401'
      ? vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
      : vi.fn().mockRejectedValue(new TypeError('Network request failed'));
    vi.stubGlobal('fetch', fetchMock);
    const selected = structuredClone(RELAYON_MODEL_MANIFEST[0]);
    const config: ApiProviderConfig = { name: '万象', catalogId: 'relayonapi', apiKey: 'fixture', selectedModels: [selected] };
    await expect(fetchProviderModelCatalog({ providerId: 'relayon-alias', config,
      fallbackModels: [...RELAYON_MODEL_MANIFEST] })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://relayonapi.com/v1/models')).toBe(true);
    expect(config.selectedModels).toEqual([selected]);
  });

  it('缺少 Key 时仍有默认候选，但不能请求或声称目录验证成功', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const definition = getProviderDefinition('relayonapi');
    expect(definition?.models).toHaveLength(34);
    await expect(fetchProviderModelCatalog({ providerId: 'relayonapi',
      config: { name: '万象', catalogId: 'relayonapi', apiKey: '' },
      fallbackModels: [...RELAYON_MODEL_MANIFEST] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('认证目录返回空数组时沿用共享目录错误，不补造可用模型', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [] })));
    await expect(fetchProviderModelCatalog({ providerId: 'relayonapi',
      config: { name: '万象', catalogId: 'relayonapi', apiKey: 'fixture' },
      fallbackModels: [...RELAYON_MODEL_MANIFEST] })).rejects.toThrow('200');
  });

  it('认证目录只返回未接入型号时保留真实空结果，不追加预置候选', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: 'gpt-6-astra' }, { id: 'Midjourney v9' }, { id: 'future-video' }],
    })));
    const result = await fetchProviderModelCatalog({ providerId: 'relayonapi',
      config: { name: '万象', catalogId: 'relayonapi', apiKey: 'fixture' },
      fallbackModels: [...RELAYON_MODEL_MANIFEST] });
    expect(result).toMatchObject({ source: 'remote', models: [] });
  });

  it('名为 relayonapi 的显式自定义连接不继承内置目录白名单或默认地址', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'my-text-model' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'relayonapi',
      config: { name: '同名自定义', catalogId: 'custom-openai', apiKey: 'custom-fixture', baseUrl: 'https://custom.example/v1' } });
    expect(getProviderDefinition('relayonapi', { catalogId: 'custom-openai' })?.id).toBe('custom-openai');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://custom.example/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer custom-fixture' }),
    }));
    expect(result.models).toMatchObject([{ id: 'my-text-model', category: 'text', provider: 'relayonapi' }]);
  });
});

describe('即梦登录后的模型目录与选择', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { fallbackModels: undefined },
    { fallbackModels: [
      { id: '3.0', name: '即梦 3.0', category: 'image' as const, provider: 'dreamina' },
      { id: 'seedance2.0', name: 'Seedance 2.0', category: 'video' as const, provider: 'dreamina' },
    ] },
  ])('缺少或使用旧回退目录时仍提供普通 2.5 与 2.0 Mini', async ({ fallbackModels }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({
      providerId: 'dreamina', config: { name: '即梦', apiKey: '', catalogId: 'dreamina' }, fallbackModels,
    });
    expect(result.source).toBe('local-manifest');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.models).toHaveLength(15);
    expect(new Set(result.models.map((model) => model.id)).size).toBe(15);
    expect(result.models.filter((model) => model.category === 'video').map((model) => model.id))
      .toEqual(expect.arrayContaining(['seedance2.5', 'seedance2.0mini']));
    for (const id of ['seedance2.5', 'seedance2.0mini']) {
      expect(getProviderDefinition('dreamina')?.models?.find((model) => model.id === id))
        .toMatchObject({ category: 'video', provider: 'dreamina' });
    }
    expect(result.models.some((model) => /draft|preview|样片/i.test(`${model.id} ${model.name}`))).toBe(false);
  });

  it('旧登录态和保存的模型勾选均可在视频菜单选择两个型号', async () => {
    const config: AppConfig = { theme: 'dark', providers: {}, dreaminaAuth: { loggedIn: true } };
    const catalog = await fetchProviderModelCatalog({
      providerId: 'dreamina', config: { name: '即梦', apiKey: '', catalogId: 'dreamina' },
    });
    const selectedModels = catalog.models.filter((model) => ['seedance2.5', 'seedance2.0mini'].includes(model.id));
    const savedConfig: AppConfig = { ...config, providers: {
      dreamina: { name: '即梦', apiKey: '', catalogId: 'dreamina', selectedModels },
    } };
    for (const state of [config, savedConfig]) {
      const models = getConfiguredModelGroups(state, 'ai-video').flatMap((group) => group.models);
      for (const id of ['seedance2.5', 'seedance2.0mini']) {
        expect(models.find((model) => model.value === `dreamina/${id}`))
          .toMatchObject({ provider: 'dreamina', nodeTypes: ['ai-video'] });
        expect(getMediaModelOptions([], state).find((model) => model.value === `dreamina/${id}`))
          .toMatchObject({ mediaKind: 'video', groupId: 'dreamina' });
      }
    }
    expect(getConfiguredModelGroups(savedConfig, 'ai-video')[0].models).toHaveLength(2);
    expect(getConfiguredModelGroups(savedConfig, 'ai-image')).toEqual([]);
  });

  it('刷新目录不重新启用未勾选的型号或隐藏的视频分类', async () => {
    const provider: ApiProviderConfig = { name: '即梦', apiKey: '', catalogId: 'dreamina', selectedModels: [
      { id: 'seedance2.0mini', name: 'Seedance 2.0 Mini', category: 'video', provider: 'dreamina' },
    ] };
    const config: AppConfig = { theme: 'dark', providers: { dreamina: provider }, dreaminaAuth: { loggedIn: true } };
    await fetchProviderModelCatalog({ providerId: 'dreamina', config: provider });
    expect(provider.selectedModels?.map((model) => model.id)).toEqual(['seedance2.0mini']);
    expect(getConfiguredModelGroups(config, 'ai-video')[0].models.map((model) => model.value))
      .toEqual(['dreamina/seedance2.0mini']);
    const hiddenProviders: ApiProviderConfig[] = [
      { ...provider, selectedModels: [] }, { ...provider, visibleModelCategories: ['image'] },
    ];
    for (const hiddenProvider of hiddenProviders) {
      const hiddenConfig = { ...config, providers: { dreamina: hiddenProvider } };
      expect(getConfiguredModelGroups(hiddenConfig, 'ai-video')).toEqual([]);
      expect(getMediaModelOptions([], hiddenConfig).filter((model) => model.mediaKind === 'video')).toEqual([]);
    }
  });
});

describe('providerCatalogService 模型分类推断', () => {
  it.each(['https://toapis.cn/v1', 'https://toapis.com/v1'])('ToAPIs 只请求所选站点 %s 的全类型目录并绑定渠道协议', async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'gemini-3.8-flash' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-image-2' }, { id: 'seedance-2-5' }, { id: 'suno' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'toapis-user',
      config: { name: 'ToAPIs', apiKey: 'shared-fixture', catalogId: 'toapis', baseUrl },
      fallbackModels: [...getProviderDefinition('toapis')!.models!],
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/models?type=all`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer shared-fixture' }),
    }));
    expect(result.models.map(({ id, category }) => [id, category])).toEqual([
      ['gemini-3.8-flash', 'text'], ['gpt-image-2', 'image'], ['seedance-2-5', 'video'], ['suno', 'audio'],
    ]);
    expect(result.models[2]).toMatchObject({ provider: 'toapis-user', executionProfile: { preset: 'custom' } });
  });

  it('ToAPIs 验证失败不能用预置清单假装 Key 或另一站点验证成功', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModelCatalog({ providerId: 'toapis', config: { name: 'ToAPIs', apiKey: 'invalid-fixture',
      baseUrl: 'https://toapis.cn/v1' }, fallbackModels: [...getProviderDefinition('toapis')!.models!] })).rejects.toThrow();
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).hostname === 'toapis.cn')).toBe(true);
  });
  it('creates independent CCC connection identities and resolves their shared definition', () => {
    const first = createConnectionId('cccapi');
    const second = createConnectionId('cccapi');
    expect(first).toMatch(/^cccapi-/);
    expect(second).not.toBe(first);
    expect(getProviderDefinition(first, { catalogId: 'cccapi' })?.id).toBe('cccapi');
    expect(getProviderDefinition('cccapi')?.id).toBe('cccapi');
  });

  it('uses only the chosen CCC Key remote directory and enriches matching models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-image-2' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'cccapi-stable',
      config: { name: 'CCC', apiKey: 'stable-fixture', catalogId: 'cccapi', cccGroup: 'CCC生图稳定', baseUrl: 'https://cccapi.cn/v1' },
      fallbackModels: [
        { id: 'gpt-image-2', name: 'GPT Image 2', category: 'image', provider: 'cccapi' },
        { id: 'claude-sonnet-4-6', name: 'Claude', category: 'text', provider: 'cccapi' },
      ] });
    expect(result.models.map((model) => model.id)).toEqual(['gpt-image-2']);
    expect(result.models[0]).toMatchObject({ category: 'image', provider: 'cccapi-stable' });
    expect(fetchMock).toHaveBeenCalledWith('https://cccapi.cn/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer stable-fixture' }),
    }));
  });

  it('CCC 仅为文档确认的 GPT 2.5 版本提供质量，未证明的别名保持未声明', () => {
    const models = getProviderDefinition('cccapi')!.models!;
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      expect(models.find((model) => model.id === id)?.imageCapability).toEqual({
        qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto',
        backgrounds: ['auto', 'opaque', 'transparent'],
      });
    }
    expect(models.find((model) => model.id === 'gpt-image-2.5')?.imageCapability?.qualities).toBeUndefined();
    expect(models.find((model) => model.id === 'gpt-image-2')?.imageCapability?.qualities).toBeUndefined();
  });

  it.each(['imageCapability', 'image_capability'])('保留远端 %s 的质量、背景声明和默认值并可序列化', async (field) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{
      id: 'gpt-image-2.5-sunburst', [field]: { resolutions: ['1K'], qualities: ['auto', 'high'], default_quality: 'auto',
        backgrounds: ['opaque', 'transparent'], default_background: 'transparent' },
    }] })));
    const result = await fetchProviderModelCatalog({ providerId: 'custom-quality',
      config: { name: '自定义接口', apiKey: 'fixture', catalogId: 'custom-openai', baseUrl: 'https://api.example/v1' },
    });
    expect(result.models[0]?.imageCapability).toMatchObject({ resolutions: ['1K'], qualities: ['auto', 'high'], defaultQuality: 'auto',
      backgrounds: ['opaque', 'transparent'], defaultBackground: 'transparent' });
    expect(JSON.parse(JSON.stringify(result.models[0])).imageCapability)
      .toMatchObject({ qualities: ['auto', 'high'], defaultQuality: 'auto',
        backgrounds: ['opaque', 'transparent'], defaultBackground: 'transparent' });
  });

  it.each(['camel', 'snake'] as const)('远端%s格式/GIF元数据保持类型和false，序列化后不丢失', async (style) => {
    const capability = style === 'camel' ? {
      outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
      textOnlyOutputFormats: ['gif', 'svg'], squareOnlyOutputFormats: ['gif', 'svg'],
      gifFrameCount: { min: 2, max: 16, step: 1, default: 9 },
      gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 }, supportsGifTransparency: false,
    } : {
      output_formats: ['png', 'gif', 'svg'], default_output_format: 'png',
      text_only_output_formats: ['gif', 'svg'], square_only_output_formats: ['gif', 'svg'],
      gif_frame_count: { min: 2, max: 16, step: 1, default: 9 },
      gif_frame_duration_ms: { min: 20, max: 655350, step: 10, default: 200 }, supports_gif_transparency: false,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'custom-output-image', category: 'image',
      image_capability: capability }] })));
    const result = await fetchProviderModelCatalog({ providerId: 'custom-formats',
      config: { name: '格式目录', apiKey: 'fixture', catalogId: 'custom-openai', baseUrl: 'https://api.example/v1' } });
    const expected = { outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
      textOnlyOutputFormats: ['gif', 'svg'], squareOnlyOutputFormats: ['gif', 'svg'],
      gifFrameCount: { min: 2, max: 16, step: 1, default: 9 },
      gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 }, supportsGifTransparency: false };
    expect(result.models[0]?.imageCapability).toMatchObject(expected);
    expect(JSON.parse(JSON.stringify(result.models[0])).imageCapability).toMatchObject(expected);
  });

  it('fails a CCC group catalog explicitly instead of offering models from other groups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    const options = { providerId: 'cccapi',
      config: { name: 'CCC', apiKey: 'fixture', catalogId: 'cccapi', baseUrl: 'https://cccapi.cn/v1', cccGroup: 'CC-MAX满血' },
      fallbackModels: [{ id: 'gpt-image-2', name: 'Image', category: 'image' as const, provider: 'cccapi' }] };
    await expect(fetchProviderModelCatalog(options)).rejects.toThrow();
    const legacy = await fetchProviderModelCatalog({ ...options, config: { ...options.config, cccGroup: undefined } });
    expect(legacy.source).toBe('local-fallback');
  });

  it.each([
    ['🍌香蕉（官k）', ['nano-banana-pro', 'gemini-4-image-preview']],
    ['gpt-image-2/2.5（官k）', ['gpt-image-2.5']],
    ['CCC生图白嫖', ['gpt-image-2.5', 'gpt-image-1']],
    ['CCC生图稳定', ['gpt-image-2.5', 'gpt-image-1']],
    ['国模-稳定2折', ['DeepSeek-V4.1-Flash', 'mI MiMo-V2.5']],
    ['GPT-Pro分组', ['gpt-5.6', 'o3']],
    ['GPT-特价Pro', ['gpt-5.6', 'o3']],
    ['CC-MAX满血', ['claude-sonnet-4-6']],
  ])('limits a mixed remote directory to the %s model family without adding unavailable presets', async (cccGroup, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'nano-banana-pro' }, { id: 'gemini-4-image-preview' }, { id: 'gemini-3.5-pro' },
      { id: 'gpt-image-2.5' }, { id: 'gpt-image-1' }, { id: 'gpt-5.6' }, { id: 'o3' },
      { id: 'DeepSeek-V4.1-Flash' }, { id: 'mI MiMo-V2.5' }, { id: 'claude-sonnet-4-6' },
    ] })));
    const result = await fetchProviderModelCatalog({ providerId: 'cccapi-group',
      config: { name: 'CCC', catalogId: 'cccapi', apiKey: 'fixture', cccGroup },
      fallbackModels: [...getProviderDefinition('cccapi')!.models!],
    });
    expect(result.source).toBe('remote');
    expect(result.models.map((model) => model.id).sort()).toEqual([...expected].sort());
  });

  it('preserves the Key directory for a group not yet in the built-in list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'new-model' }] })));
    const result = await fetchProviderModelCatalog({ providerId: 'cccapi-new',
      config: { name: 'CCC', catalogId: 'cccapi', apiKey: 'fixture', cccGroup: '新分组' },
      fallbackModels: [...getProviderDefinition('cccapi')!.models!],
    });
    expect(result.models.map((model) => model.id)).toEqual(['new-model']);
  });
  it('GRSAI 的本地目录保留新文本协议及独立 H3 能力，不请求 Key 页面', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const fallbackModels = defaultModelGroups.find((group) => group.id === 'grsai')!.models
      .map((model) => ({ id: model.value.slice('grsai/'.length), name: model.label,
        category: model.nodeTypes.includes('ai-video') ? 'video' as const : model.nodeTypes.includes('ai-image') ? 'image' as const : 'text' as const,
        provider: 'grsai' }));
    const result = await fetchProviderModelCatalog({ providerId: 'grsai',
      config: { name: 'GRSAI', apiKey: 'test-key' }, fallbackModels });
    expect(result.source).toBe('local-manifest');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.models.find((model) => model.id === 'gpt-6-astra')?.executionProfile).toEqual({ preset: 'openai-chat' });
    expect(result.models.find((model) => model.id === 'minimax-h3')?.videoCapability).toMatchObject({ resolutions: ['480p', '768p', '1080p'], maxVideoReferences: 0 });
    expect(result.models.find((model) => model.id === 'gpt-image-2.5-flare')?.description).toContain('维护中');
    expect(result.models.some((model) => model.id === 'gpt-5.4')).toBe(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['MiniMax-H3'],
    ['minimax-h3'],
    ['MiniMax_H3'],
    ['MiniMax H3'],
  ])('中转站拉取 %s 归类为视频模型', async (modelId) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [
        {
          id: modelId,
          object: 'model',
          created: 0,
          owned_by: 'minimax',
          supported_endpoint_types: ['openai'],
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'apimart',
      config: {
        name: 'APIMart',
        apiKey: 'test-key',
        baseUrl: 'https://api.apimart.ai',
        catalogId: 'apimart',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.apimart.ai/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.category).toBe('video');
    expect(result.models[0]?.provider).toBe('apimart');
  });

  it('APIMart 不再把 H3 特殊操作作为普通视频模型展示', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [
        { id: 'MiniMax-H3', object: 'model' },
        { id: 'MiniMax-H3-Context-IR', object: 'model' },
        { id: 'MiniMax-H3-Regeneration', object: 'model' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'apimart',
      config: {
        name: 'APIMart',
        apiKey: 'test-key',
        baseUrl: 'https://api.apimart.ai',
        catalogId: 'apimart',
      },
    });

    expect(result.models.map((model) => model.id)).toEqual(['MiniMax-H3']);
  });

  it.each([
    [['flowmusic', 'suno'], ['flowmusic-lyria-3.5', 'suno-v6', 'suno-v6-wild', 'suno-v6-mini']],
    [['flowmusic'], ['flowmusic-lyria-3.5']],
    [['suno'], ['suno-v6', 'suno-v6-wild', 'suno-v6-mini']],
    [['gpt-4o'], []],
  ])('音乐版本只随当前 Key 可用的主模型 %j 展开', async (availableIds, versionIds) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      data: availableIds.map((id) => ({ id, object: 'model' })),
    })));
    const fallbackModels = defaultModelGroups.find((group) => group.id === 'apimart')!.models
      .filter((model) => model.nodeTypes?.includes('ai-audio'))
      .map((model) => ({ id: model.value.slice('apimart/'.length), name: model.label, category: 'audio' as const, provider: 'apimart' }));
    const result = await fetchProviderModelCatalog({
      providerId: 'apimart',
      config: { name: 'APIMart', apiKey: 'test-key', baseUrl: 'https://api.apimart.ai', catalogId: 'apimart' },
      fallbackModels,
    });
    expect(result.source).toBe('remote');
    const musicIds = new Set(['flowmusic-lyria-3.5', 'suno-v6', 'suno-v6-wild', 'suno-v6-mini']);
    expect(result.models.filter((model) => musicIds.has(model.id)).map((model) => model.id).sort())
      .toEqual([...versionIds].sort());
    expect(result.models.filter((model) => musicIds.has(model.id) || model.id === 'suno')
      .every((model) => model.category === 'audio')).toBe(true);
    expect(result.models.every((model) => availableIds.includes(model.id) || musicIds.has(model.id))).toBe(true);
  });

  it('新视频型号在远端目录中保持视频分类，不补入 Key 未开放的型号', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      data: ['happyhorse-1.0', 'happyhorse-1.1', 'wan3.0-video', 'flux-3-video'].map((id) => ({ id })),
    })));
    const result = await fetchProviderModelCatalog({
      providerId: 'apimart',
      config: { name: 'APIMart', apiKey: 'test-key', baseUrl: 'https://api.apimart.ai' },
    });
    expect(result.models).toHaveLength(4);
    expect(result.models.every((model) => model.category === 'video')).toBe(true);
  });

  it('自定义连接不展开 APIMart 专用音乐版本', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ id: 'flowmusic' }] })));
    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: { name: '自定义', apiKey: 'test-key', baseUrl: 'https://relay.example.com/v1' },
      fallbackModels: [{ id: 'flowmusic-lyria-3.5', name: 'Lyria 3.5', category: 'audio', provider: 'custom-openai' }],
    });
    expect(result.models.map((model) => model.id)).toEqual(['flowmusic']);
  });

  it('自定义接口拉取 minimax-h3 同样归类为视频模型', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { id: 'MiniMax-H3', object: 'model' },
      { id: 'MiniMax-H3-Context-IR', object: 'model' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: {
        name: '中转',
        apiKey: 'test-key',
        baseUrl: 'https://relay.example.com/v1',
        catalogId: 'custom-openai',
      },
    });

    expect(result.models.every((model) => model.category === 'video')).toBe(true);
  });

  it('不影响其他模型的分类推断', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { id: 'gpt-4o', object: 'model' },
      { id: 'tts-1', object: 'model' },
      { id: 'dall-e-3', object: 'model' },
      { id: 'minimax-text-01', object: 'model' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: {
        name: '中转',
        apiKey: 'test-key',
        baseUrl: 'https://relay.example.com/v1',
        catalogId: 'custom-openai',
      },
    });

    const categoryOf = (id: string) => result.models.find((model) => model.id === id)?.category;
    expect(categoryOf('gpt-4o')).toBe('text');
    expect(categoryOf('tts-1')).toBe('audio');
    expect(categoryOf('dall-e-3')).toBe('image');
    expect(categoryOf('minimax-text-01')).toBe('text');
  });
});

describe('自定义连接原生模型目录', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses Anthropic headers for an Anthropic-compatible catalog', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: [{ id: 'claude-sonnet', display_name: 'Claude Sonnet' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: {
        name: 'Anthropic 中转',
        apiKey: 'secret',
        baseUrl: 'https://relay.example/v1',
        catalogId: 'custom-openai',
        chatApiProtocol: 'anthropic-compatible',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' },
      }),
    );
    expect(result.models[0]).toMatchObject({ id: 'claude-sonnet', name: 'Claude Sonnet' });
  });

  it('parses Gemini models[].name and strips the models/ prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'custom-openai',
      config: {
        name: 'Gemini 中转',
        apiKey: 'secret',
        baseUrl: 'https://relay.example/v1beta',
        catalogId: 'custom-openai',
        chatApiProtocol: 'gemini-native',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/v1beta/models',
      expect.objectContaining({ headers: { 'x-goog-api-key': 'secret' } }),
    );
    expect(result.models[0]).toMatchObject({ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' });
  });
});

describe('Sora2U 目录下架', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { providerId: 'sora2u', connection: {} },
    { providerId: 'saved-connection', connection: { catalogId: 'sora2u' } },
    { providerId: 'sora2u', connection: { baseUrl: 'https://sora2u.com' } },
    { providerId: 'renamed-connection', connection: { catalogId: 'sora2u', baseUrl: 'https://sora2u.com' } },
  ])('下架连接 $providerId 拒绝拉取远端目录和展示本地回退模型', async ({ providerId, connection }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const config = { name: 'Sora2U', apiKey: 'fixture-key', ...connection };

    expect(isRetiredProviderConnection(providerId, config)).toBe(true);
    await expect(fetchProviderModelCatalog({ providerId, config, fallbackModels: [...SORA2U_MODEL_MANIFEST] }))
      .rejects.toThrow('内置厂商已下架');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('显式自定义连接可以沿用相同 ID 和名称，继续按自己的地址拉取', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      object: 'list',
      data: [{ id: 'custom-image', name: 'Custom Image', supports_image: true }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { name: 'Sora2U', apiKey: 'custom-fixture-key', baseUrl: 'https://relay.example/v1', catalogId: 'custom-openai' };
    expect(isRetiredProviderConnection('sora2u', config)).toBe(false);
    const result = await fetchProviderModelCatalog({ providerId: 'sora2u', config });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer custom-fixture-key' },
      }),
    );
    expect(result.source).toBe('remote');
    expect(result.models).toEqual([expect.objectContaining({ id: 'custom-image', provider: 'sora2u' })]);
  });
});
