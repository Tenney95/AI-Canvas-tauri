import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProviderModelCatalog,
  getProviderDefinition,
  resolveCccGeminiImageExecutionProfile,
  resolveProviderImageModelForValidation,
} from '../../../src/services/ai/providerCatalogService';
import { assertModelCapabilityProtocol } from '../../../src/services/ai/modelCapabilityValidation';
import { parseConnectionShare, serializeConnection } from '../../../src/services/ai/providerConnectionTransfer';
import { TOAPIS_MODEL_MANIFEST } from '../../../src/services/ai/providers/toapisModelManifest';
import { RELAYON_MODEL_MANIFEST } from '../../../src/services/ai/providers/relayonModelManifest';
import type { ApiProviderConfig, ProviderModelSelection } from '../../../src/types';
import type { ModelExecutionProfile, ProtocolJsonValue } from '../../../src/types/aiTypes';
import { CCC_BANANA_MODEL_IDS, getCccGroupPresetModels, isCccBananaGroup, isCccBananaModelId } from '../../../src/services/ai/cccProviderGroups';
import { jsonResponse } from './catalogResponse';

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
        category: 'image', inputModalities: ['text', 'image'], executionProfile: {
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

describe('GPT Image 2.6 的逐厂商目录', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('CCC 只加入基础款，不继承其他中转的质量及透明枚举', () => {
    const models = getProviderDefinition('cccapi')!.models!;
    expect(models.find((item) => item.id === 'gpt-image-2.6')).toMatchObject({
      category: 'image', imageReferenceRequestMode: 'edits-multipart',
    });
    expect(models.find((item) => item.id === 'gpt-image-2.6')?.imageCapability).toBeUndefined();
    expect(models.some((item) => /^gpt-image-2\.6-/.test(item.id))).toBe(false);
    for (const group of ['CCC生图白嫖', 'CCC生图稳定', 'gpt-image-2/2.5（官k）', '🍌香蕉（官k）']) {
      expect(getCccGroupPresetModels(models, group).some((item) => item.id === 'gpt-image-2.6'))
        .toBe(group === 'CCC生图白嫖');
    }
  });

  it('CCC 实际目录仍用当前 Key 求交，保留其新增权限，不补入其他分组候选', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-image-2.6' }] })));
    const result = await fetchProviderModelCatalog({ providerId: 'ccc-new-images',
      config: { name: 'CCC', catalogId: 'cccapi', apiKey: 'fixture-26', cccGroup: 'CCC生图稳定' },
      fallbackModels: [...getProviderDefinition('cccapi')!.models!],
    });
    expect(result.source).toBe('remote');
    expect(result.models).toEqual([expect.objectContaining({ id: 'gpt-image-2.6', provider: 'ccc-new-images',
      category: 'image', imageReferenceRequestMode: 'edits-multipart' })]);
  });

  it('仅已核实的站点具有各自精确 2.6 型号，不替未确认站点添加别名', () => {
    expect(getProviderDefinition('grsai')!.models!.find((item) => item.id === 'gpt-image-2.6')?.category).toBe('image');
    for (const [provider, ids] of [
      ['toapis', ['gpt-image-2.6-flare-official', 'gpt-image-2.6-sunburst-official']],
      ['aigc-si', ['image-2.6-flare', 'image-2.6-sunburst']],
      ['relayonapi', ['image-2.6-01', 'image-2.6-flare-01', 'image-2.6-sunburst-01']],
    ] as const) {
      for (const id of ids) expect(getProviderDefinition(provider)!.models!.find((item) => item.id === id)?.category).toBe('image');
    }
    const withoutImage26 = [
      getProviderDefinition('libapi')!,
      getProviderDefinition('sora2u', { catalogId: 'sora2u' })!,
    ];
    for (const provider of withoutImage26) {
      expect(provider.models?.some((item) => /(?:gpt-)?image[- ]?2\.6/i.test(item.id))).not.toBe(true);
    }
  });
});

describe('CCC Gemini 图片型号与旧连接协议兼容', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('香蕉当前预置仅展示三个精确型号，不把旧别名当作当前候选', () => {
    const models = getProviderDefinition('cccapi')!.models!;
    const original = structuredClone(models);
    const current = getCccGroupPresetModels(models, '🍌香蕉（官k）');
    expect(current.map((model) => model.id)).toEqual([...CCC_BANANA_MODEL_IDS]);
    for (const id of CCC_BANANA_MODEL_IDS) {
      expect(isCccBananaModelId(id)).toBe(true);
      expect(current.find((model) => model.id === id)?.imageCapability).toMatchObject({
        resolutions: ['1K', '2K', '4K'], defaultResolution: '1K',
      });
    }
    for (const id of ['nano-banana-pro', 'nano-banana2', 'gemini-3-pro-image-preview', 'Nano-Banana-Next']) {
      expect(isCccBananaModelId(id)).toBe(false);
    }
    expect(isCccBananaGroup(' 🍌香蕉（官k） ')).toBe(true);
    expect(isCccBananaGroup('CCC生图稳定')).toBe(false);
    expect(isCccBananaGroup(undefined)).toBe(false);
    expect(getCccGroupPresetModels(models, 'CCC生图稳定').every((model) => model.id.startsWith('gpt-image-'))).toBe(true);
    expect(getCccGroupPresetModels(models, '新分组')).toEqual([]);
    expect(models).toEqual(original);
  });

  it('当前 Key 返回的三款香蕉保留精确 ID 和分辨率，不添加未返回候选', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [
      { id: 'Nano-Banana-pro' }, { id: 'Nano-Banana-2.1' },
    ] })));
    const result = await fetchProviderModelCatalog({ providerId: 'ccc-banana-current', config: {
      name: 'CCC', catalogId: 'cccapi', cccGroup: '🍌香蕉（官k）', apiKey: 'fixture-key',
    }, fallbackModels: [...getProviderDefinition('cccapi')!.models!] });
    expect(result.models.map((model) => model.id).sort()).toEqual(['Nano-Banana-2.1', 'Nano-Banana-pro']);
    for (const model of result.models) {
      expect(model.imageCapability).toMatchObject({ resolutions: ['1K', '2K', '4K'], defaultResolution: '1K' });
      expect(model.imageCapability?.qualities).toBeUndefined();
      expect(model.imageCapability?.backgrounds).toBeUndefined();
      expect(model.imageCapability?.maxImageReferences).toBeUndefined();
    }
  });

  it('候选包含网页的三个精确 Nano Banana 写法，并保留旧型号 ID', () => {
    const models = getProviderDefinition('cccapi')!.models!;
    for (const id of ['Nano-Banana-pro', 'Nano-Banana-2', 'Nano-Banana-2.1', 'nano-banana-pro', 'nano-banana2']) {
      expect(models.find((model) => model.id === id), id).toMatchObject({
        id, category: 'image', provider: 'cccapi', inputModalities: ['text', 'image'],
        executionProfile: { preset: 'custom', protocol: { submit: {
          method: 'POST', path: '/v1beta/models/{{model}}:generateContent', pathMode: 'origin',
        } } },
      });
    }
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
  });

  it.each([undefined, 'openai-image', 'openai-gpt-image'] as const)(
    '已知 Gemini 图片型号用原生协议补齐旧预设 %s，但不修改保存值', (preset) => {
      const profile = preset ? { preset } : undefined;
      const original = structuredClone(profile);
      for (const id of ['Nano-Banana-pro', 'nano-banana-2', 'NANO-BANANA-2.1', 'nano-banana2',
        'gemini-3-pro-image-preview', 'GEMINI-3.1-FLASH-IMAGE', 'gemini-2.5-flash-image']) {
        const effective = resolveCccGeminiImageExecutionProfile(id, profile);
        expect(effective, id).toMatchObject({ preset: 'custom', protocol: {
          auth: { type: 'bearer' }, submit: { method: 'POST', path: '/v1beta/models/{{model}}:generateContent', pathMode: 'origin' },
          response: { result: { base64Path: 'candidates.*.content.parts.*.inlineData.data' } },
        } });
      }
      expect(profile).toEqual(original);
    },
  );

  it('用户 custom 与其他原生预设保持原对象，不被 CCC 合同覆盖', () => {
    const custom: ModelExecutionProfile = { preset: 'custom', protocol: {
      version: 2, mode: 'sync', submit: { method: 'POST', path: '/my/image-endpoint', body: { prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'result.url' } },
    } };
    for (const profile of [custom, { preset: 'google-image-native' } satisfies ModelExecutionProfile,
      { preset: 'openai-image', protocol: custom.protocol } satisfies ModelExecutionProfile]) {
      const original = structuredClone(profile);
      expect(resolveCccGeminiImageExecutionProfile('Nano-Banana-2', profile)).toBe(profile);
      expect(profile).toEqual(original);
    }
  });

  function legacyNativeImageProfile(modelId: string): ModelExecutionProfile {
    const profile = structuredClone(getProviderDefinition('cccapi')!.models!
      .find((model) => model.id === modelId)!.executionProfile!);
    const body = profile.protocol!.submit.body as Record<string, ProtocolJsonValue>;
    body.contents = [{ role: 'user', parts: [{ text: '{{prompt}}' }] }];
    return profile;
  }

  it.each(['gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'Nano-Banana-2.1'])(
    '完整旧内置模板 %s 临时补齐全部参考图，已保存协议保持原样', (modelId) => {
      const profile = legacyNativeImageProfile(modelId);
      const saved = structuredClone(profile);
      const effective = resolveCccGeminiImageExecutionProfile(modelId.toUpperCase(), profile);
      expect(effective).not.toBe(profile);
      expect(effective?.protocol?.submit.body).toMatchObject({
        contents: [{ role: 'user', parts: '{{googleImageParts}}' }],
      });
      const body = effective?.protocol?.submit.body as Record<string, ProtocolJsonValue>;
      expect(body.generationConfig).toMatchObject({ imageConfig: modelId === 'gemini-2.5-flash-image'
        ? { aspectRatio: '{{aspectRatio}}' } : { aspectRatio: '{{aspectRatio}}', imageSize: '{{imageSize}}' } });
      if (modelId === 'gemini-2.5-flash-image') {
        expect(body.generationConfig).not.toHaveProperty('imageConfig.imageSize');
      }
      expect(profile).toEqual(saved);
      const model: ProviderModelSelection = { id: modelId, name: modelId, category: 'image',
        provider: 'cccapi', executionProfile: profile };
      expect(resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), model).executionProfile)
        .toEqual(effective);
      expect(model.executionProfile).toEqual(saved);
    },
  );

  it.each(['path', 'headers', 'body', 'result'] as const)(
    '旧内置模板的 %s 被用户修改后不替换协议', (field) => {
      const profile = legacyNativeImageProfile('gemini-3-pro-image-preview');
      const protocol = profile.protocol!;
      if (field === 'path') protocol.submit.path = '/my-native-image';
      if (field === 'headers') protocol.submit.headers = { 'X-Image-Mode': 'custom' };
      if (field === 'body') (protocol.submit.body as Record<string, ProtocolJsonValue>).customOption = true;
      if (field === 'result' && protocol.version === 2) protocol.response.result = { urlPath: 'my_image.url' };
      const saved = structuredClone(profile);
      expect(resolveCccGeminiImageExecutionProfile('gemini-3-pro-image-preview', profile)).toBe(profile);
      expect(profile).toEqual(saved);
    },
  );

  it('不替换新模板，也不为未知 ID 套用旧模板升级', () => {
    const current = getProviderDefinition('cccapi')!.models!
      .find((model) => model.id === 'gemini-3-pro-image-preview')!.executionProfile!;
    expect(resolveCccGeminiImageExecutionProfile('gemini-3-pro-image-preview', current)).toBe(current);
    const legacy = legacyNativeImageProfile('gemini-3-pro-image-preview');
    expect(resolveCccGeminiImageExecutionProfile('gemini-4-image-preview', legacy)).toBe(legacy);
  });

  it('远端大小写不同仍补已知原生合同，原 ID 和当前 Key 的目录范围保持不变', async () => {
    const ids = ['NANO-BANANA-PRO', 'nano-banana-2.1', 'GeMiNi-3.1-flash-image', 'gemini-4-image-preview'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: ids.map((id) => ({ id })) })));
    const fallbackModels = [...getProviderDefinition('cccapi')!.models!];
    const original = structuredClone(fallbackModels);
    const result = await fetchProviderModelCatalog({ providerId: 'cccapi-banana',
      config: { name: '香蕉官k', catalogId: 'cccapi', apiKey: 'fixture-key', cccGroup: '🍌香蕉（官k）' }, fallbackModels });
    expect(result.source).toBe('remote');
    expect(result.models.map((model) => model.id).sort()).toEqual([...ids].sort());
    for (const id of ids.slice(0, 3)) {
      expect(result.models.find((model) => model.id === id), id).toMatchObject({ id,
        inputModalities: ['text', 'image'], executionProfile: { preset: 'custom', protocol: { submit: {
          path: '/v1beta/models/{{model}}:generateContent',
        } } },
      });
    }
    expect(result.models.find((model) => model.id === 'gemini-4-image-preview')?.executionProfile).toBeUndefined();
    expect(fallbackModels).toEqual(original);
  });

  it('自定义站点同名型号不会隐式获得 CCC 大小写匹配的原生合同', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'NANO-BANANA-PRO' }] })));
    const result = await fetchProviderModelCatalog({ providerId: 'my-relay', config: {
      name: '自定义接口', catalogId: 'custom-openai', baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key',
    }, fallbackModels: [{ id: 'nano-banana-pro', name: '自己的别名', category: 'image', provider: 'my-relay',
      executionProfile: { preset: 'openai-image' } }] });
    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('NANO-BANANA-PRO');
    expect(result.models[0].executionProfile).toBeUndefined();
  });

  it.each([undefined, 'openai-image', 'openai-gpt-image'] as const)(
    '旧 CCC Gemini 预设 %s 仅用有效协议副本校验，不改导出或自定义站点配置', (preset) => {
      const model: ProviderModelSelection = { id: 'Nano-Banana-2', name: '香蕉2', category: 'image', provider: 'cccapi',
        ...(preset ? { executionProfile: { preset } } : {}) };
      const original = structuredClone(model);
      const effective = resolveProviderImageModelForValidation(getProviderDefinition('cccapi'), model);
      expect(effective.executionProfile).toMatchObject({ preset: 'custom', protocol: { submit: {
        path: '/v1beta/models/{{model}}:generateContent',
      } } });
      expect(() => assertModelCapabilityProtocol(effective)).not.toThrow();
      expect(model).toEqual(original);
      for (const catalogId of ['custom-openai', 'unknown-provider']) {
        expect(resolveProviderImageModelForValidation(getProviderDefinition(catalogId), model)).toBe(model);
      }
      const parsed = parseConnectionShare(serializeConnection({ name: '旧香蕉连接', catalogId: 'cccapi', apiKey: '',
        selectedModels: [model] }))!;
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.config.selectedModels![0].executionProfile).toEqual(model.executionProfile);
    },
  );

  it('未知未来图片 ID 仍保留目录，但不凭名称编造原生能力或覆盖协议', () => {
    const saved: ModelExecutionProfile = { preset: 'openai-image' };
    for (const id of ['gemini-4-image-preview', 'Nano-Banana-Next', 'gpt-image-2.5']) {
      expect(resolveCccGeminiImageExecutionProfile(id)).toBeUndefined();
      expect(resolveCccGeminiImageExecutionProfile(id, saved)).toBe(saved);
    }
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
