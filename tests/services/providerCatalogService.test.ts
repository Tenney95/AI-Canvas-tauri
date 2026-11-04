/**
 * providerCatalogService — 回归测试：厂商定义与接线策略。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProviderModelCatalog,
  getProviderDefinition,
  getProviderDefinitions,
  createConnectionId,
  resolveProviderImageModelForValidation,
} from '../../src/services/ai/providerCatalogService';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';
import { defaultModelGroups, getConfiguredModelGroups, getMediaModelOptions } from '../../src/components/nodes/shared/defaultModels';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { parseConnectionShare, serializeConnection } from '../../src/services/ai/providerConnectionTransfer';
import { TOAPIS_MODEL_MANIFEST } from '../../src/services/ai/providers/toapisModelManifest';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';
import { AIGCSI_MODEL_MANIFEST } from '../../src/services/ai/providers/aigcsiModelManifest';
import { RELAYON_IMAGE_MODEL_IDS, RELAYON_MODEL_MANIFEST, RELAYON_VIDEO_MODEL_IDS } from '../../src/services/ai/providers/relayonModelManifest';
import { RELAYON_PROVIDER_GROUPS, getRelayonGroupPresetModels, relayonConnectionName } from '../../src/services/ai/relayonProviderGroups';
import { useAppStore } from '../../src/store/useAppStore';
import type { ApiProviderConfig, AppConfig, ProviderModelSelection } from '../../src/types';
import type { ProtocolJsonValue } from '../../src/types/aiTypes';
import { getProviderPolicy } from '../../src/services/ai/providerPolicies';
import { resolveGeneralModelConnection } from '../../src/services/ai/helpers';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

  it('先校验目录凭据，再用公开技能目录排除退役和未适配型号，不加入认证目录未返回的型号', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [
        { id: 'gt-6.1-sol' }, { id: 'gt-image-2.5-flare', category: 'text' },
        { id: 'vo-3.1' }, { id: 'happyhorse-1-0' }, { id: 'future-video' },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ models: [
        { name: 'gpt-6.1-sol', type: 'text' }, { name: 'gpt-image-2.5-flare', type: 'image' },
        { name: 'veo-3.1', type: 'video' }, { name: 'seedance-2-5', type: 'video' },
        { name: 'future-video', type: 'video' },
      ] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'libapi',
      config: { name: 'LibAPI', apiKey: 'libapi-fixture', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST],
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://libapi.cc/v1/models', 'https://libapi.cc/v1/skills/models',
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer libapi-fixture' } });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(result).toMatchObject({ source: 'remote', resolvedBaseUrl: 'https://libapi.cc/v1' });
    expect(result.models.map(({ id, category, provider }) => ({ id, category, provider }))).toEqual([
      { id: 'gt-6.1-sol', category: 'text', provider: 'libapi' },
      { id: 'gt-image-2.5-flare', category: 'image', provider: 'libapi' },
      { id: 'vo-3.1', category: 'video', provider: 'libapi' },
    ]);
    expect(result.models.filter((model) => model.category !== 'text').every((model) => model.executionProfile)).toBe(true);
    expect(result.warning).toBeTruthy();
  });

  it.each([401, 503])('目录 HTTP %s 失败不回退静态模型，也不访问公开技能目录', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModelCatalog({ providerId: 'libapi', config: { name: 'LibAPI', apiKey: 'fixture', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST] })).rejects.toThrow();
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://libapi.cc/v1/models')).toBe(true);
  });

  it('技能目录失败保留调用方旧选择，不用静态型号冒充已验证目录', async () => {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gt-image-2.5-flare')!;
    const config: ApiProviderConfig = { name: 'LibAPI', apiKey: 'fixture', catalogId: 'libapi', selectedModels: [selected] };
    const original = JSON.stringify(config);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [{ id: selected.id }] }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 })));
    await expect(fetchProviderModelCatalog({ providerId: 'libapi', config, fallbackModels: [...LIBAPI_MODEL_MANIFEST] })).rejects.toThrow();
    expect(JSON.stringify(config)).toBe(original);
  });

  it('缺少 Key 不请求公开目录，认证目录没有已适配型号时不借用静态清单', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModelCatalog({ providerId: 'libapi', config: { name: 'LibAPI', apiKey: '', catalogId: 'libapi' },
      fallbackModels: [...LIBAPI_MODEL_MANIFEST] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'future-video' }] }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'future-video', type: 'video' }] }));
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
        initialModelsOnCreate: 'fallback', initialModelsOnEdit: 'fallback', refresh: 'replace',
        fallback: 'deny', invalidateOnKeyChange: true, connectionTest: 'catalog',
      } },
    });
    expect(definition?.models?.filter((model) => model.category === 'text').map((model) => model.id)).toEqual([
      'gemini-3.8-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5-5',
    ]);
    expect(definition?.models).toHaveLength(21);
    expect(definition?.models?.filter((model) => model.category === 'image').map((model) => model.id)).toEqual([...RELAYON_IMAGE_MODEL_IDS]);
    expect(definition?.models?.filter((model) => model.category === 'video').map((model) => model.id)).toEqual([...RELAYON_VIDEO_MODEL_IDS]);
    expect(definition?.models?.filter((model) => model.category === 'text').every((model) => model.executionProfile?.preset === 'openai-chat')).toBe(true);
    expect(definition?.models?.filter((model) => model.category !== 'text').every((model) => model.executionProfile?.preset === 'custom')).toBe(true);
    expect(definition?.policy.upload).toBeUndefined();
    expect(createConnectionId('relayonapi')).toMatch(/^relayonapi-.+/);
  });

  it('分组候选是精确型号的静态快照，并非密钥验证', () => {
    expect(RELAYON_PROVIDER_GROUPS.map(({ name }) => name)).toEqual([
      'ClaudeMax号池', 'GPTpro号池', 'Gemini号池', 'default', 'image', 'video',
    ]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'Gemini号池').map(({ id }) => id)).toEqual([
      'gemini-3.8-flash', 'gemini-4-argon',
    ]);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'image')).toHaveLength(9);
    expect(getRelayonGroupPresetModels(RELAYON_MODEL_MANIFEST, 'video')).toHaveLength(8);
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
    expect(fetchMock.mock.calls[1][0]).toBe('https://relayonapi.com/api/pricing');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: 'omit' });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body');
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
    expect(result.models).toHaveLength(21);
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
    expect(definition?.models).toHaveLength(21);
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
      data: [{ id: 'gpt-6-astra' }, { id: 'Midjourney v8.2' }, { id: 'future-video' }],
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
  it.each(['https://toapis.cn/v1', 'https://toapis.com/v1'])('ToAPIs 只请求所选站点 %s，绑定渠道协议并筛选文本型号', async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'gemini-3.8-flash' }, { id: 'gpt-5.6-sol' }, { id: 'seedance-2-5' }, { id: 'suno' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchProviderModelCatalog({ providerId: 'toapis-user',
      config: { name: 'ToAPIs', apiKey: 'shared-fixture', catalogId: 'toapis', baseUrl },
      fallbackModels: [...getProviderDefinition('toapis')!.models!],
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/models`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer shared-fixture' }),
    }));
    expect(result.models.map((item) => item.id)).toEqual(['gemini-3.8-flash', 'seedance-2-5', 'suno']);
    expect(result.models[1]).toMatchObject({ category: 'video', provider: 'toapis-user', executionProfile: { preset: 'custom' } });
    expect(result.models[2].category).toBe('audio');
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

describe('CCC API 内置厂商目录', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('内置目录覆盖监控页列出的全部 openai 渠道模型', () => {
    const definition = getProviderDefinition('cccapi');
    expect(definition).toMatchObject({
      id: 'cccapi',
      name: 'CCC API',
      catalogAdapter: 'openai-compatible',
      defaultBaseUrl: 'https://cccapi.cn/v1',
      modelsPath: '/models',
      allowCustomBaseUrl: false,
      externalUrl: 'https://cccapi.cn/register?aff=F9JX9AZRDCB8',
    });

    const models = definition?.models ?? [];
    const findModel = (id: string) => models.find((model) => model.id === id);
    for (const id of [
      'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2',
      'gpt-5.5', 'gpt-5.4', 'gpt-5.6-terra', 'o4-mini', 'codex-auto-review',
      'gpt-4', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-4o', 'gpt-5.6', 'gpt-5.6-sol',
      'gpt-5.3-codex-spark', 'gpt-5.2', 'o3', 'gpt-5', 'gpt-5.4-mini', 'gpt-5.6-luna',
      'gpt-image-1', 'o3-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5.2-pro',
    ]) {
      expect(findModel(id), `缺少模型 ${id}`).toBeDefined();
    }
    expect(models.every((model) => model.provider === 'cccapi')).toBe(true);

    expect(findModel('gpt-image-1')?.category).toBe('image');
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2']) {
      expect(findModel(id)?.category).toBe('image');
      expect(findModel(id)?.imageReferenceRequestMode).toBe('edits-multipart');
    }
    expect(findModel('gpt-5.6')?.category).toBe('text');
    // 纯文本模型要显式声明，不能落进按 ID 猜模态的兜底分支
    expect(findModel('gpt-4')?.inputModalities).toEqual(['text']);
    expect(findModel('o3-mini')?.inputModalities).toEqual(['text']);
    expect(findModel('gpt-4o-mini')?.inputModalities).toEqual(['text', 'image']);
  });

  it('使用 OpenAI 兼容地址读取当前 Key 可用的模型', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', object: 'model' },
        { id: 'gpt-image-2.5-flare', object: 'model' },
        { id: 'gpt-image-2.5-sunburst', object: 'model' },
        { id: 'gpt-image-2', object: 'model' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'cccapi',
      config: {
        name: 'CCC API',
        apiKey: 'sk-ccc-test',
        catalogId: 'cccapi',
      },
      fallbackModels: [...(getProviderDefinition('cccapi')?.models ?? [])],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cccapi.cn/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer sk-ccc-test' },
      }),
    );
    expect(result).toMatchObject({
      source: 'remote',
      resolvedBaseUrl: 'https://cccapi.cn/v1',
    });
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-4o-mini', category: 'text', provider: 'cccapi' }),
      expect.objectContaining({
        id: 'gpt-image-2.5-flare',
        category: 'image',
        provider: 'cccapi',
        imageReferenceRequestMode: 'edits-multipart',
      }),
      expect.objectContaining({
        id: 'gpt-image-2.5-sunburst',
        category: 'image',
        provider: 'cccapi',
        imageReferenceRequestMode: 'edits-multipart',
      }),
      expect.objectContaining({
        id: 'gpt-image-2',
        category: 'image',
        provider: 'cccapi',
        imageReferenceRequestMode: 'edits-multipart',
      }),
    ]));
  });

  it('补齐模型广场与非 OpenAI 渠道，并为图片型号保留各自协议', () => {
    const models = getProviderDefinition('cccapi')?.models ?? [];
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    for (const id of [
      'DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash', 'mI MiMo-V2.5', 'Hy3',
      'claude-sonnet-4-6', 'claude-sonnet-4.6', 'claude-opus-4-8', 'claude-fable-5',
      'gemini-2.5-pro', 'gemini-3.1-pro-high', 'gemini-3.5-flash',
      'grok-4.5', 'grok-build', 'grok-4.20-multi-agent',
    ]) {
      expect(models.find((model) => model.id === id), id).toMatchObject({
        category: 'text', provider: 'cccapi', executionProfile: { preset: 'openai-chat' },
      });
    }
    expect(models.find((model) => model.id === 'gpt-image-2.5')).toMatchObject({
      category: 'image', imageReferenceRequestMode: 'edits-multipart',
    });
    for (const id of ['gemini-3-pro-image-preview', 'gemini-3-pro-image',
      'gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'nano-banana2', 'nano-banana-pro']) {
      expect(models.find((model) => model.id === id), id).toMatchObject({
        category: 'image', inputModalities: ['text'], executionProfile: {
          preset: 'custom', protocol: { submit: { path: '/v1beta/models/{{model}}:generateContent' } },
        },
      });
    }
  });

  it('当前 Key 的远端清单保留新型号的协议，不自动启用其他分组模型', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'Hy3' }, { id: 'nano-banana2' }, { id: 'gpt-image-2.5' },
    ] })));
    const result = await fetchProviderModelCatalog({
      providerId: 'cccapi', config: { name: 'CCC', apiKey: 'fixture-key', catalogId: 'cccapi' },
      fallbackModels: [...(getProviderDefinition('cccapi')?.models ?? [])],
    });
    expect(result.source).toBe('remote');
    expect(result.models).toHaveLength(3);
    expect(result.models.find((model) => model.id === 'Hy3')?.executionProfile?.preset).toBe('openai-chat');
    expect(result.models.find((model) => model.id === 'nano-banana2')).toMatchObject({
      category: 'image', executionProfile: { preset: 'custom' },
    });
    expect(result.models.find((model) => model.id === 'gpt-image-2.5')?.imageReferenceRequestMode)
      .toBe('edits-multipart');
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

describe('Sora2U 远端模型能力目录', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([undefined, 0, 3, 4])('保留远端联合名额 %s，缺省时保留内置补充', async (maximum) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ object: 'list', data: [{
      id: 'seedance-2.0', reference_limits: { image: 9, video: 3, audio: 3,
        ...(maximum === undefined ? {} : { videoAudioCombined: maximum }) },
    }] })));
    const result = await fetchProviderModelCatalog({ providerId: 'sora2u',
      config: { name: 'Sora2U', apiKey: 'fixture-key', baseUrl: 'https://sora2u.com', catalogId: 'sora2u' },
      fallbackModels: [...SORA2U_MODEL_MANIFEST] });
    expect(result.models.find((model) => model.id === 'seedance-2.0')?.videoCapability)
      .toMatchObject({ maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3,
        maxVideoAudioReferences: maximum ?? 3 });
  });

  it('隐藏 Sora2U 的三个 Seedance 2.5 变体，并保留其他远端新增模型', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      object: 'list',
      data: [
        {
          id: 'seedance-2.5',
          object: 'model',
          name: 'Seedance 2.5 Remote',
          durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 30],
          duration_range: { min: 5, max: 30, step: 1 },
          default_duration: 15,
          aspect_ratios: ['16:9', '9:16', 'adaptive'],
          default_aspect_ratio: 'adaptive',
          resolutions: ['720p', '1080p'],
          default_resolution: '720p',
          supports_text_only: false,
          supports_image: true,
          supports_video: true,
          supports_audio: true,
          reference_limits: { image: 30, video: 10, audio: 10, total: 50 },
        },
        {
          id: 'future-image',
          object: 'model',
          name: 'Future Image',
          supports_image: true,
          supports_video: false,
          supports_audio: false,
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchProviderModelCatalog({
      providerId: 'sora2u',
      config: {
        name: 'Sora2U',
        apiKey: 'sk_sora_test',
        baseUrl: 'https://sora2u.com',
        catalogId: 'sora2u',
      },
      fallbackModels: [...SORA2U_MODEL_MANIFEST],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sora2u.com/api/v1/models?utm_source=tenney&utm_medium=canvas&utm_content=wx',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer sk_sora_test' },
      }),
    );
    expect(result.models.find((model) => model.id === 'seedance-2.5')).toBeUndefined();
    expect(result.models.some((model) => model.id.startsWith('seedance-2.5'))).toBe(false);
    expect(result.models.find((model) => model.id === 'future-image')).toMatchObject({
      category: 'image',
      provider: 'sora2u',
      inputModalities: ['text', 'image'],
    });
  });
});

describe('厂商图片有效合同校验与连接导入', () => {
  function legacyCccModel(): ProviderModelSelection {
    return {
      id: 'gpt-image-2.5-sunburst', name: 'Sunburst', category: 'image', provider: 'saved-ccc',
      imageCapability: { qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], defaultQuality: 'auto',
        backgrounds: ['auto', 'opaque', 'transparent'] },
      imageReferenceRequestMode: 'edits-multipart',
      executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
        submit: { method: 'POST', path: '/old/images', body: { prompt: '{{prompt}}', quality: 'high' } },
        response: { type: 'json', result: { urlPath: 'url' } },
      } },
    };
  }

  function legacyToapisModel(): ProviderModelSelection {
    const model = structuredClone(TOAPIS_MODEL_MANIFEST.find((item) => item.id === 'gpt-image-2.5-sunburst-vip')!);
    (model.executionProfile!.protocol!.submit.body as Record<string, ProtocolJsonValue>).quality = 'high';
    delete (model.executionProfile!.protocol!.submit.body as Record<string, ProtocolJsonValue>).background;
    return model;
  }

  function legacyRelayonModel(modelId = 'Image-2.5-Flare'): ProviderModelSelection {
    const model = structuredClone(RELAYON_MODEL_MANIFEST.find((item) => item.id === modelId)!);
    const body = model.executionProfile!.protocol!.submit.body as Record<string, ProtocolJsonValue>;
    delete body.quality;
    delete body.background;
    return model;
  }

  it.each(['Image-2.5-Flare', 'Image-2.5-Sunburst'])('旧 %s 协议合并新能力后按临时有效副本校验，不改保存原文', (modelId) => {
    const model = legacyRelayonModel(modelId);
    const original = structuredClone(model);
    expect(() => assertModelCapabilityProtocol(model)).toThrow('质量');
    const effective = resolveProviderImageModelForValidation(getProviderDefinition('relayonapi'), model);
    expect(() => assertModelCapabilityProtocol(effective)).not.toThrow();
    expect(effective.executionProfile!.protocol!.submit.body).toMatchObject({ quality: '{{imageQuality}}', background: '{{imageBackground}}' });
    expect(effective.executionProfile!.protocol!.submit.body).not.toHaveProperty('output_format');
    expect(model).toEqual(original);
  });

  it.each([false, true])('RelayOnAPI 旧缓存导入、保存校验与分享保留原始协议和能力（已有新候选 %s）', (hasOptions) => {
    const model = legacyRelayonModel();
    if (!hasOptions) {
      delete model.imageCapability!.qualities;
      delete model.imageCapability!.defaultQuality;
      delete model.imageCapability!.backgrounds;
      delete model.imageCapability!.defaultBackground;
    }
    const config: ApiProviderConfig = { name: '旧万象连接', apiKey: '', catalogId: 'relayonapi',
      selectedModels: [model], catalogModels: [model] };
    const original = structuredClone(config);
    expect(() => assertModelCapabilityProtocol(resolveProviderImageModelForValidation(getProviderDefinition('relayonapi'), model)))
      .not.toThrow();
    const serialized = serializeConnection(config);
    const exported = JSON.parse(serialized).connection;
    expect(exported.selectedModels[0].executionProfile).toEqual(model.executionProfile);
    expect(exported.selectedModels[0].imageCapability).toEqual(model.imageCapability);
    const parsed = parseConnectionShare(serialized)!;
    expect(parsed.diagnostics).toEqual([]);
    for (const imported of [parsed.config.selectedModels![0], parsed.config.catalogModels![0]]) {
      expect(imported.executionProfile).toEqual(model.executionProfile);
      expect(imported.imageCapability).toEqual(model.imageCapability);
    }
    expect(config).toEqual(original);
  });

  it.each(['custom-openai', 'relayonapi'])('%s 中改过的同名协议仍按自身映射严格校验', (catalogId) => {
    const model = legacyRelayonModel();
    model.executionProfile!.protocol!.submit.path = '/custom/images';
    const effective = resolveProviderImageModelForValidation(getProviderDefinition(catalogId), model);
    expect(effective.executionProfile).toBe(model.executionProfile);
    expect(effective.imageCapability).toBe(model.imageCapability);
    expect(() => assertModelCapabilityProtocol(effective)).toThrow('质量');
    const parsed = parseConnectionShare(serializeConnection({ name: '自己配置的接口', apiKey: '', catalogId, selectedModels: [model] }))!;
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: model.id })]));
    expect(parsed.config.selectedModels).toEqual([]);
  });

  it.each(['https://attacker.invalid/images', 'javascript:alert(1)'])('RelayOnAPI 旧协议的不安全路径 %s 不因兼容升级放行', (path) => {
    const model = legacyRelayonModel();
    model.executionProfile!.protocol!.submit.path = path;
    expect(() => resolveProviderImageModelForValidation(getProviderDefinition('relayonapi'), model)).toThrow();
    const parsed = parseConnectionShare(serializeConnection({ name: '旧万象连接', apiKey: '', catalogId: 'relayonapi', selectedModels: [model] }))!;
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      path: 'connection.selectedModels.0.executionProfile.protocol.submit.path',
    })]));
    expect(parsed.config.selectedModels).toEqual([]);
  });

  it('CCC 只用标准合同副本校验，原能力、旧协议和待保存模型保持原样', () => {
    const model = legacyCccModel();
    const original = JSON.stringify(model);
    const effective = resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), model);
    expect(() => assertModelCapabilityProtocol(effective)).not.toThrow();
    expect(effective.executionProfile).toBeUndefined();
    expect(effective.imageCapability).toBe(model.imageCapability);
    expect(JSON.stringify(model)).toBe(original);
    expect(() => resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), {
      ...model, imageCapability: { qualities: ['high'], defaultQuality: 'max' },
    })).toThrow('defaultQuality');
    expect(() => resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), {
      ...model, imageCapability: { backgrounds: ['opaque'], defaultBackground: 'transparent' },
    })).toThrow('defaultBackground');
  });

  it('已知 ToAPIs 完整旧合同使用有效副本校验，用户原始 fixed high 仍可完整分享', () => {
    const model = legacyToapisModel();
    const original = JSON.stringify(model);
    const effective = resolveProviderImageModelForValidation(getProviderDefinition('toapis'), model);
    expect(() => assertModelCapabilityProtocol(effective)).not.toThrow();
    expect(effective.executionProfile!.protocol!.submit.body).toMatchObject({ quality: '{{imageQuality}}' });
    expect(JSON.stringify(model)).toBe(original);
  });

  it.each(['custom-openai', 'unknown-provider'])('相同型号在 %s 连接中不能冒充 CCC 标准合同', (catalogId) => {
    const model = { ...legacyCccModel(), provider: 'cccapi' };
    const effective = resolveProviderImageModelForValidation(getProviderDefinition(catalogId), model);
    expect(effective).toBe(model);
    expect(() => assertModelCapabilityProtocol(effective)).toThrow('质量');
    const parsed = parseConnectionShare(serializeConnection({ name: '同名自定义连接', apiKey: '', catalogId, selectedModels: [model] }))!;
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: model.id })]));
    expect(parsed.config.selectedModels).toEqual([]);
  });

  it.each(['cccapi', 'toapis'])('%s 导入按真实目录上下文校验，保留原始 selected/catalog 模型协议', (catalogId) => {
    const model = catalogId === 'cccapi' ? legacyCccModel() : legacyToapisModel();
    const parsed = parseConnectionShare(serializeConnection({ name: '旧连接', apiKey: '', catalogId,
      selectedModels: [model], catalogModels: [model],
    }))!;
    expect(parsed.diagnostics).toEqual([]);
    for (const imported of [parsed.config.selectedModels![0], parsed.config.catalogModels![0]]) {
      expect(imported.executionProfile).toEqual(model.executionProfile);
      expect(imported.imageCapability).toEqual(model.imageCapability);
      expect(imported.provider).toBe('');
    }
  });

  it.each(['https://attacker.invalid/images', 'javascript:alert(1)'])('CCC 原协议中的不安全路径 %s 仍被严格拒绝', (path) => {
    const model = legacyCccModel();
    model.executionProfile!.protocol!.submit.path = path;
    expect(() => resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), model)).toThrow();
    const parsed = parseConnectionShare(serializeConnection({ name: 'CCC', apiKey: '', catalogId: 'cccapi', selectedModels: [model] }))!;
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      path: 'connection.selectedModels.0.executionProfile.protocol.submit.path',
    })]));
    expect(parsed.config.selectedModels).toEqual([]);
  });

  it('旧 CCC 原协议的非法变量、鉴权覆盖和未知预设不能被有效合同掩盖', () => {
    for (const body of [{ prompt: '{{process.env}}' }, { prompt: '{{prompt}}' }]) {
      const model = legacyCccModel();
      model.executionProfile!.protocol!.submit.body = body;
      if (body.prompt === '{{prompt}}') model.executionProfile!.protocol!.submit.headers = { Authorization: 'unsafe-fixture' };
      expect(() => resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), model)).toThrow();
    }
    const payload = JSON.parse(serializeConnection({ name: 'CCC', apiKey: '', catalogId: 'cccapi', selectedModels: [legacyCccModel()] }));
    payload.connection.selectedModels[0].executionProfile = { preset: 'unknown-preset' };
    const parsed = parseConnectionShare(JSON.stringify(payload))!;
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      path: 'connection.selectedModels.0.executionProfile.preset',
    })]));
    expect(parsed.config.selectedModels).toEqual([]);
  });
});
