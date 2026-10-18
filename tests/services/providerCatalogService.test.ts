import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProviderModelCatalog,
  getProviderDefinition,
  createConnectionId,
} from '../../src/services/ai/providerCatalogService';
import { SORA2U_MODEL_MANIFEST } from '../../src/services/ai/providers/sora2uModelManifest';
import { defaultModelGroups } from '../../src/components/nodes/shared/defaultModels';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
      externalUrl: 'https://cccapi.cn/keys',
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
