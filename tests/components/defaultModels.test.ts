/**
 * defaultModels — 回归测试：DeepSeek 文本模型的图片输入能力。
 */
import { describe, expect, it } from 'vitest';
import {
  defaultModelGroups,
  findMediaModelOption,
  getConfiguredModelGroups,
  getGeneralModelGroups,
  getMediaModelOptions,
  hasVisionInputCapability,
  isVisionCapableTextModel,
} from '../../src/components/nodes/shared/defaultModels';
import type { AppConfig, ProviderModelSelection } from '../../src/types';
import { APIMART_OMNI_MODELS, replaceLegacyApimartOmni } from '../../src/services/ai/apimartVideoModels';
import { getProviderDefinition, isProviderModelVisible } from '../../src/services/ai/providerCatalogService';

describe('Amam 图片与视频模型菜单', () => {
  it('默认目录不自动启用；勾选后使用当前连接的独立分组，并供对话媒体选择使用', () => {
    const candidates = getProviderDefinition('aigc-si')!.models!;
    expect(candidates).toHaveLength(19);
    const selected = ['image', 'video'].map((category) => candidates.find((item) => item.category === category)!);
    const config: AppConfig = { theme: 'dark', providers: {
      'my-amam': { name: '自己的 Amam', catalogId: 'aigc-si', apiKey: 'fixture', selectedModels: selected },
    } };
    expect(getGeneralModelGroups([], config, 'ai-image')).toEqual([]);
    const models = selected.map((item) => ({ id: `am-${item.category}`, name: item.name, modelId: item.id,
      category: item.category, providerConfigId: 'my-amam' }));
    expect(getGeneralModelGroups(models, config, 'ai-video')).toEqual([
      expect.objectContaining({ id: 'general-provider-my-amam', name: 'Amam（AIGC SI）', badgeText: 'AM',
        models: [expect.objectContaining({ value: 'general/am-video' })] }),
    ]);
    expect(getMediaModelOptions(models, config).map((item) => [item.value, item.mediaKind, item.groupId])).toEqual([
      ['general/am-image', 'image', 'general-provider-my-amam'], ['general/am-video', 'video', 'general-provider-my-amam'],
    ]);
    expect(getGeneralModelGroups(models, config, 'ai-text')).toEqual([]);
    expect(getGeneralModelGroups(models, config, 'ai-audio')).toEqual([]);
  });
});

describe('DeepSeek 文本模型的图片输入能力', () => {
  it.each([
    'deepseek-flash',
    'deepseek/deepseek-flash',
    'DeepSeek-V4.1-Flash',
    'apimart/deepseek-v4.1-flash',
    'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'deepseek-v4-flash-vision-exp',
  ])('为缺少显式声明的已知视觉型号保留图片输入：%s', (modelId) => {
    expect(isVisionCapableTextModel(modelId)).toBe(true);
    expect(hasVisionInputCapability({ modelId })).toBe(true);
  });

  it.each([
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek/deepseek-r1',
    'DeepSeek-V3.2',
    'deepseek-v4-pro',
    'deepseek-v4-pro-0813',
    'deepseek-v4-flash',
    'deepseek-v4-flash-0731',
    'deepseek-v4.1-flash-text-only',
    'deepseek-v4.1-flash-unknown',
    'not-deepseek-flash',
    'unknown-flash',
  ])('不按 DeepSeek 或 Flash 泛匹配未知能力：%s', (modelId) => {
    expect(hasVisionInputCapability({ modelId })).toBe(false);
  });

  it('显式模态优先于型号识别，不覆盖用户或渠道的限制', () => {
    expect(hasVisionInputCapability({ modelId: 'deepseek-flash', inputModalities: ['text'] })).toBe(false);
    expect(hasVisionInputCapability({ modelId: 'DeepSeek-V4.1-Flash', inputModalities: [] })).toBe(false);
    expect(hasVisionInputCapability({ modelId: 'relay/unknown', inputModalities: ['text', 'image'] })).toBe(true);
  });
});

function createConfig(selectedModels: ProviderModelSelection[]): AppConfig {
  return {
    providers: {
      apimart: {
        name: 'APIMart',
        apiKey: 'configured',
        catalogId: 'apimart',
        selectedModels,
      },
    },
    theme: 'dark',
  };
}

describe('内置厂商动态模型目录', () => {
  it('GRSAI 新模型分类正确，默认目录不再列出已下架 GPT-5.4，已有选择保持可读', () => {
    const models = defaultModelGroups.find((group) => group.id === 'grsai')!.models;
    for (const [id, kind] of [['nano-banana-2.1', 'image'], ['gpt-image-2.5', 'image'], ['gpt-image-2.5-flare', 'image'], ['gpt-image-2.5-sunburst', 'image'], ['minimax-h3', 'video'], ['gpt-6-astra', 'text'], ['gpt-5.6-sol', 'text'], ['gpt-5.6-terra', 'text'], ['gemini-3.5-flash-lite', 'text'], ['gemini-3.7-flash', 'text'], ['gemini-3.8-flash', 'text']]) {
      expect(models.find((model) => model.value === `grsai/${id}`)?.nodeTypes).toContain(`ai-${kind}`);
    }
    expect(models.some((model) => model.value === 'grsai/gpt-5.4')).toBe(false);
    const config: AppConfig = { theme: 'dark', providers: { grsai: { name: 'GRSAI', apiKey: 'configured', selectedModels: [{ id: 'gpt-5.4', name: 'GPT-5.4', category: 'text', provider: 'grsai' }] } } };
    expect(getConfiguredModelGroups(config, 'ai-text').flatMap((group) => group.models).map((model) => model.value)).toEqual(['grsai/gpt-5.4']);
    expect(getConfiguredModelGroups(config, 'ai-video')).toEqual([]);
  });
  it('新模型按媒体分类展示且不自动启用', () => {
    const models = defaultModelGroups.find((group) => group.id === 'apimart')!.models;
    expect(models.filter((model) => model.nodeTypes.includes('ai-text')).map((model) => model.value)).toEqual([
      'apimart/gemini-3.8-flash',
      'apimart/gemini-4-argon',
      'apimart/qwen3.8-flash',
      'apimart/deepseek-v4.1-flash',
      'apimart/gpt-6.1-sol',
      'apimart/grok-4.7',
      'apimart/qwen3.8-27b',
      'apimart/claude-opus-5-5',
      'apimart/glm-5.3-flash',
    ]);
    for (const [id, kind] of [['grok-imagine-image-2.0', 'image'], ['seedream-5-0-flash', 'image'], ['wan3.0-video', 'video'], ['seedance-2.5', 'video'], ['suno-v6-mini', 'audio'], ['flowmusic-lyria-3.5', 'audio']]) {
      expect(models.find((model) => model.value === `apimart/${id}`)?.nodeTypes).toContain(`ai-${kind}`);
    }
    const configured = createConfig([{ id: 'gpt-5.4', name: 'GPT', category: 'text', provider: 'apimart' }]);
    expect(getConfiguredModelGroups(configured, 'ai-text').flatMap((group) => group.models).map((model) => model.value))
      .toEqual(['apimart/gpt-5.4']);
    expect(getConfiguredModelGroups(configured, 'ai-image')).toEqual([]);
    expect(getConfiguredModelGroups(configured, 'ai-audio')).toEqual([]);
  });
  it('云工作流进入媒体目录并保留指定连接，旧无参数合同的云 ID 不再作为可运行选项', () => {
    const config: AppConfig = { theme: 'dark', providers: { runninghub: { name: 'RH 工作流', apiKey: 'configured' } } };
    const workflows = [{ id: 'cloud-video', name: '云视频', category: 'ai-video' as const, adapterType: 'runninghub' as const, runninghub: { version: 1 as const, kind: 'workflow' as const, remoteId: '1904152026220003329', connectionId: 'runninghub-model' as const, parameters: [] }, fileName: 'RH', fileContent: '', createdAt: 1 }];
    const option = findMediaModelOption('runninghubwf/cloud-video', [], config, workflows);
    expect(option).toMatchObject({ provider: 'runninghubwf', providerConfigId: 'runninghub-model', workflowId: 'cloud-video', mediaKind: 'video' });
    expect(getConfiguredModelGroups(config, 'ai-video').some((group) => group.id === 'runninghubwf')).toBe(false);
  });
  it('用三个 Omni 视频模型替换已选择的旧条目，不影响其它选择', () => {
    const other: ProviderModelSelection = { id: 'wan2.7', name: 'Wan', category: 'video', provider: 'apimart' };
    const legacy: ProviderModelSelection = { id: 'apimart/Omni-Flash-Ext', name: 'Omni Flash', category: 'video', provider: 'apimart' };
    const selections = [other, legacy, { ...APIMART_OMNI_MODELS[0] }];
    const migrated = replaceLegacyApimartOmni(selections)!;
    expect(migrated).toHaveLength(4);
    expect(migrated[0]).toBe(other);
    expect(replaceLegacyApimartOmni(migrated)).toBe(migrated);
    expect(selections[1]).toBe(legacy);
    const models = getConfiguredModelGroups(createConfig(selections), 'ai-video')[0].models;
    expect(models.map((model) => model.value)).toEqual(expect.arrayContaining(
      APIMART_OMNI_MODELS.map((model) => `apimart/${model.id}`),
    ));
    expect(models.some((model) => model.value.includes('Omni-Flash-Ext'))).toBe(false);
    expect(isProviderModelVisible('apimart', 'Omni-Flash-Ext')).toBe(false);
    expect(isProviderModelVisible('google', 'gemini-omni-flash-preview')).toBe(true);
  });

  it('不会重新启用用户没有选择的 Omni 模型', () => {
    const selections = [{ ...APIMART_OMNI_MODELS[2] }];
    expect(replaceLegacyApimartOmni(selections)).toBe(selections);
    expect(getConfiguredModelGroups(createConfig(selections), 'ai-video')[0].models.map((model) => model.value))
      .toEqual(['apimart/gemini-omni-flash-preview']);
  });
  it('内置即梦 CLI v1.4.17 完整媒体模型目录', () => {
    const models = defaultModelGroups.find((group) => group.id === 'dreamina')?.models ?? [];

    expect(models.map((model) => model.value)).toEqual([
      'dreamina/3.0',
      'dreamina/3.1',
      'dreamina/4.0',
      'dreamina/4.1',
      'dreamina/4.5',
      'dreamina/4.6',
      'dreamina/4.7',
      'dreamina/5.0',
      'dreamina/5.0Pro',
      'dreamina/seedance2.0',
      'dreamina/seedance2.0fast',
      'dreamina/seedance2.0_vip',
      'dreamina/seedance2.0fast_vip',
      'dreamina/seedance2.0mini',
      'dreamina/seedance2.5',
    ]);
    expect(models.filter((model) => model.nodeTypes.includes('ai-image'))).toHaveLength(9);
    expect(models.filter((model) => model.nodeTypes.includes('ai-video'))).toHaveLength(6);
  });

  it('内置 GRSAI 当前目录与兼容型号', () => {
    const models = defaultModelGroups.find((group) => group.id === 'grsai')?.models ?? [];

    expect(models.map((model) => model.value)).toEqual([
      'grsai/gpt-6-astra',
      'grsai/gpt-5.6-sol',
      'grsai/gpt-5.6-terra',
      'grsai/gemini-3.5-flash-lite',
      'grsai/gemini-3.7-flash',
      'grsai/gemini-3.8-flash',
      'grsai/nano-banana-2.1',
      'grsai/gpt-image-2.5',
      'grsai/gpt-image-2.5-flare',
      'grsai/gpt-image-2.5-sunburst',
      'grsai/minimax-h3',
      'grsai/gpt-image-2',
      'grsai/gpt-image-2-vip',
      'grsai/nano-banana-pro',
      'grsai/nano-banana-2',
      'grsai/nano-banana-2-lite',
      'grsai/nano-banana-pro-vt',
      'grsai/nano-banana-fast',
      'grsai/nano-banana-2-cl',
      'grsai/nano-banana-pro-cl',
      'grsai/nano-banana-2-2k-cl',
      'grsai/nano-banana-pro-4k-vip',
      'grsai/nano-banana-pro-vip',
      'grsai/nano-banana-2-4k-cl',
      'grsai/gpt-5.5',
      'grsai/gemini-3.1-flash-lite',
      'grsai/gemini-3.1-pro',
      'grsai/gemini-3.5-flash',
      'grsai/gemini-3-flash',
      'grsai/gemini-3-pro',
      'grsai/gemini-2.5-flash',
      'grsai/gemini-2.5-pro',
    ]);
    expect(models.filter((model) => model.nodeTypes.includes('ai-image'))).toHaveLength(17);
    expect(models.filter((model) => model.nodeTypes.includes('ai-text'))).toHaveLength(14);
    expect(models.filter((model) => model.nodeTypes.includes('ai-video'))).toHaveLength(1);
  });

  it('把已选的 GRSAI 旧版模型 ID 映射到当前官网模型', () => {
    const config: AppConfig = {
      providers: {
        grsai: {
          name: 'GRSAI',
          apiKey: 'configured',
          catalogId: 'grsai',
          selectedModels: [{
            id: 'nanobanana-pro',
            name: 'NanobananaPRO',
            category: 'image',
            provider: 'grsai',
          }],
        },
      },
      theme: 'dark',
    };

    expect(getConfiguredModelGroups(config, 'ai-image')
      .find((group) => group.id === 'grsai')?.models).toContainEqual(expect.objectContaining({
      value: 'grsai/nano-banana-pro',
      provider: 'grsai',
      label: 'Nano Banana Pro',
    }));
  });

  it('把已选但未预置的模型加入对应类别和厂商分组', () => {
    const config = createConfig([
      {
        id: 'gpt-future',
        name: 'GPT Future',
        category: 'text',
        provider: 'apimart',
      },
      {
        id: 'imagen-future',
        name: 'Imagen Future',
        category: 'image',
        provider: 'apimart',
      },
    ]);

    const textGroup = getConfiguredModelGroups(config, 'ai-text')
      .find((group) => group.id === 'apimart');

    expect(textGroup?.models).toContainEqual(expect.objectContaining({
      value: 'apimart/gpt-future',
      provider: 'apimart',
      label: 'GPT Future',
      nodeTypes: ['ai-text'],
    }));
    expect(textGroup?.models.some((model) => model.value === 'apimart/imagen-future')).toBe(false);
  });

  it('保留已选预置模型且不会生成重复项', () => {
    const config = createConfig([{
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      category: 'text',
      provider: 'apimart',
    }]);

    const models = getConfiguredModelGroups(config, 'ai-text')
      .find((group) => group.id === 'apimart')?.models ?? [];

    expect(models.filter((model) => model.value === 'apimart/gpt-6.1-sol')).toHaveLength(1);
    expect(models.some((model) => model.value === 'apimart/gemini-3.8-flash')).toBe(false);
  });

  it('保留远端模型 ID 自带的命名空间', () => {
    const config = createConfig([{
      id: 'vendor/gpt-5.4',
      name: 'Vendor GPT-5.4',
      category: 'text',
      provider: 'apimart',
    }]);

    const models = getConfiguredModelGroups(config, 'ai-text')
      .find((group) => group.id === 'apimart')?.models ?? [];

    expect(models).toContainEqual(expect.objectContaining({
      value: 'apimart/vendor/gpt-5.4',
      provider: 'apimart',
    }));
    expect(models.some((model) => model.value === 'apimart/gpt-5.4')).toBe(false);
  });

  it('可通过当前配置解析动态媒体模型', () => {
    const config = createConfig([{
      id: 'imagen-future',
      name: 'Imagen Future',
      category: 'image',
      provider: 'apimart',
    }]);

    expect(findMediaModelOption('apimart/imagen-future', [], config)).toEqual(
      expect.objectContaining({
        value: 'apimart/imagen-future',
        provider: 'apimart',
        mediaKind: 'image',
      }),
    );
  });
});

describe('Sora2U 独立模型分组', () => {
  const config: AppConfig = {
    providers: {
      sora2u: { name: 'Sora2U', apiKey: 'k', catalogId: 'sora2u', selectedModels: [] },
      relay: { name: '自定义中转', apiKey: 'k', catalogId: 'custom-openai', selectedModels: [] },
    },
    theme: 'dark',
  };
  const generalModels = [
    {
      id: 'sora-image',
      name: 'Gemini Image',
      modelId: 'gemini-image',
      category: 'image' as const,
      providerConfigId: 'sora2u',
    },
    {
      id: 'relay-image',
      name: 'Relay Image',
      modelId: 'relay-image',
      category: 'image' as const,
      providerConfigId: 'relay',
    },
  ];

  it('节点菜单把 Sora2U 从通用模型中拆成独立厂商分组', () => {
    const groups = getGeneralModelGroups(generalModels, config, 'ai-image');

    expect(groups.find((group) => group.name === 'Sora2U')).toMatchObject({
      id: 'general-provider-sora2u',
      badgeText: 'S2U',
      models: [expect.objectContaining({
        value: 'general/sora-image',
        provider: 'general',
        label: 'Gemini Image',
      })],
    });
    expect(groups.find((group) => group.id === 'general-models')?.models).toEqual([
      expect.objectContaining({ value: 'general/relay-image' }),
    ]);
  });

  it('对话媒体目录沿用 Sora2U 分组，但模型引用保持 general 协议', () => {
    const option = getMediaModelOptions(generalModels, config)
      .find((model) => model.value === 'general/sora-image');

    expect(option).toMatchObject({
      value: 'general/sora-image',
      provider: 'general',
      groupId: 'general-provider-sora2u',
      groupName: 'Sora2U',
    });
  });
});

describe('CCC API 独立模型分组', () => {
  it('distinguishes the same image model across CCC groups in node and conversation menus', () => {
    const grouped: AppConfig = { theme: 'dark', providers: {
      'cccapi-free': { name: 'CCC', apiKey: 'free', catalogId: 'cccapi', cccGroup: 'CCC生图白嫖' },
      'cccapi-stable': { name: 'CCC', apiKey: 'stable', catalogId: 'cccapi', cccGroup: 'CCC生图稳定' },
    } };
    const models = ['free', 'stable'].map((suffix) => ({ id: suffix, name: 'GPT Image 2',
      modelId: 'gpt-image-2', category: 'image' as const, providerConfigId: `cccapi-${suffix}` }));
    const groups = getGeneralModelGroups(models, grouped, 'ai-image');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'general-provider-cccapi', name: 'CCC API' });
    expect(groups[0].models.map((model) => model.value)).toEqual(['general/free', 'general/stable']);
    expect(groups.flatMap((group) => group.models.map((model) => model.label)))
      .toEqual(['GPT Image 2 · CCC生图白嫖', 'GPT Image 2 · CCC生图稳定']);
    const media = getMediaModelOptions(models, grouped).filter((model) => model.provider === 'general');
    expect(media.map((model) => model.value)).toEqual(['general/free', 'general/stable']);
    expect(new Set(media.map((model) => model.groupId))).toEqual(new Set(['general-provider-cccapi']));
    expect(media.every((model) => model.groupName === 'CCC API')).toBe(true);
    expect(media.map((model) => model.label)).toEqual(groups.flatMap((group) => group.models.map((model) => model.label)));
  });

  it('合并旧连接与新分组，同时保留每组的类别可见性和模型引用', () => {
    const grouped: AppConfig = { theme: 'dark', providers: {
      cccapi: { name: 'CCC', apiKey: 'legacy' },
      'cccapi-free': { name: 'CCC', apiKey: 'free', catalogId: 'cccapi', cccGroup: 'CCC生图白嫖', visibleModelCategories: ['text'] },
      'cccapi-pro': { name: 'CCC', apiKey: 'pro', catalogId: 'cccapi', cccGroup: 'GPT-特价Pro' },
    } };
    const models = [
      { id: 'legacy', name: 'Legacy Image', modelId: 'gpt-image-2', category: 'image' as const, providerConfigId: 'cccapi' },
      { id: 'hidden', name: 'Hidden Image', modelId: 'gpt-image-2', category: 'image' as const, providerConfigId: 'cccapi-free' },
      { id: 'text', name: 'GPT', modelId: 'gpt-5.6-sol', category: 'text' as const, providerConfigId: 'cccapi-pro' },
    ];
    const image = getGeneralModelGroups(models, grouped, 'ai-image');
    expect(image).toHaveLength(1);
    expect(image[0].models.map((model) => model.value)).toEqual(['general/legacy']);
    const text = getGeneralModelGroups(models, grouped, 'ai-text');
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ id: image[0].id, name: 'CCC API' });
    expect(text[0].models[0]).toMatchObject({ value: 'general/text', label: 'GPT · GPT-特价Pro' });
    expect(getMediaModelOptions(models, grouped).filter((model) => model.provider === 'general').map((model) => model.value))
      .toEqual(['general/legacy']);
    expect(models.map((model) => model.providerConfigId)).toEqual(['cccapi', 'cccapi-free', 'cccapi-pro']);
  });
  const config: AppConfig = {
    providers: {
      cccapi: { name: 'CCC API', apiKey: 'k', catalogId: 'cccapi', selectedModels: [] },
    },
    theme: 'dark',
  };
  const generalModels = [
    {
      id: 'ccc-image',
      name: 'GPT Image 2',
      modelId: 'gpt-image-2',
      category: 'image' as const,
      providerConfigId: 'cccapi',
    },
  ];

  it('节点菜单显示独立的 CCC API 厂商分组', () => {
    const groups = getGeneralModelGroups(generalModels, config, 'ai-image');

    expect(groups).toEqual([
      expect.objectContaining({
        id: 'general-provider-cccapi',
        name: 'CCC API',
        badgeText: 'CCC',
        models: [expect.objectContaining({
          value: 'general/ccc-image',
          provider: 'general',
          label: 'GPT Image 2',
        })],
      }),
    ]);
  });

  it('对话媒体目录沿用 CCC API 分组', () => {
    const option = getMediaModelOptions(generalModels, config)
      .find((model) => model.value === 'general/ccc-image');

    expect(option).toMatchObject({
      groupId: 'general-provider-cccapi',
      groupName: 'CCC API',
    });
  });
});

describe('ToAPIs 独立模型分组', () => {
  it('节点和对话按厂商分组，并保留模型身份和类别可见性', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      toapis: { name: 'ToAPIs', catalogId: 'toapis', apiKey: 'key', visibleModelCategories: ['image', 'video', 'text'] },
      relay: { name: '自定义', catalogId: 'custom-openai', apiKey: 'other' },
    } };
    const models = [
      { id: 'toapis-image', name: 'GPT Image 2', modelId: 'gpt-image-2', category: 'image' as const, providerConfigId: 'toapis' },
      { id: 'toapis-video', name: 'Seedance 2.5', modelId: 'seedance-2-5', category: 'video' as const, providerConfigId: 'toapis' },
      { id: 'toapis-audio', name: 'Suno', modelId: 'suno', category: 'audio' as const, providerConfigId: 'toapis' },
      { id: 'toapis-text', name: 'GPT 6.1', modelId: 'gpt-6.1-sol', category: 'text' as const, providerConfigId: 'toapis' },
      { id: 'relay-image', name: 'GPT Image 2', modelId: 'gpt-image-2', category: 'image' as const, providerConfigId: 'relay' },
    ];
    const groups = getGeneralModelGroups(models, config, 'ai-image');
    expect(groups.find((group) => group.name === 'ToAPIs')).toMatchObject({
      id: 'general-provider-toapis', badgeText: 'T',
      models: [expect.objectContaining({ value: 'general/toapis-image', provider: 'general' })],
    });
    expect(groups.find((group) => group.id === 'general-models')?.models)
      .toEqual([expect.objectContaining({ value: 'general/relay-image' })]);
    expect(getGeneralModelGroups(models, config, 'ai-text')[0]).toMatchObject({
      name: 'ToAPIs', models: [expect.objectContaining({ value: 'general/toapis-text' })],
    });
    const media = getMediaModelOptions(models, config).filter((model) => model.groupName === 'ToAPIs');
    expect(media.map((model) => model.value)).toEqual(['general/toapis-image', 'general/toapis-video']);
    expect(media.every((model) => model.groupId === 'general-provider-toapis' && model.provider === 'general')).toBe(true);
  });
});

describe('LibAPI 独立模型分组', () => {
  it('仅真实连接和完整内置音频协议声明语音或音乐用途', () => {
    const catalog = getProviderDefinition('libapi')!.models!;
    const speech = catalog.find((model) => model.id === 'gm-3.1-flash-tts')!;
    const music = catalog.find((model) => model.id === 'music')!;
    const customized = structuredClone(speech);
    customized.executionProfile!.protocol!.submit.path = '/custom/audio';
    const config: AppConfig = { theme: 'dark', providers: {
      libapi: { name: 'LibAPI', apiKey: 'fixture', catalogId: 'libapi' },
      relay: { name: '其他中转', apiKey: 'other', catalogId: 'custom-openai' },
    } };
    const models = [
      { id: 'speech', name: speech.name, modelId: speech.id, providerConfigId: 'libapi', category: 'audio' as const, executionProfile: speech.executionProfile },
      { id: 'music', name: music.name, modelId: music.id, providerConfigId: 'libapi', category: 'audio' as const, executionProfile: music.executionProfile },
      { id: 'customized', name: speech.name, modelId: speech.id, providerConfigId: 'libapi', category: 'audio' as const, executionProfile: customized.executionProfile },
      { id: 'other', name: speech.name, modelId: speech.id, providerConfigId: 'relay', category: 'audio' as const, executionProfile: speech.executionProfile },
    ];
    const options = getMediaModelOptions(models, config);
    expect(options.find((model) => model.value === 'general/speech')).toMatchObject({ audioPurpose: 'speech', groupName: 'LibAPI' });
    expect(options.find((model) => model.value === 'general/music')).toMatchObject({ audioPurpose: 'music', groupName: 'LibAPI' });
    expect(options.find((model) => model.value === 'general/customized')?.audioPurpose).toBeUndefined();
    expect(options.find((model) => model.value === 'general/other')?.audioPurpose).toBeUndefined();
  });

  it('文本、图片与视频按连接启用并保留同名厂商的独立身份', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      libapi: { name: 'LibAPI', catalogId: 'libapi', apiKey: 'fixture', visibleModelCategories: ['text', 'image', 'video'] },
      relay: { name: '自定义', catalogId: 'custom-openai', apiKey: 'other' },
    } };
    const models = [
      { id: 'libapi-text', name: 'GPT 6.1 Sol', modelId: 'gt-6.1-sol', category: 'text' as const, providerConfigId: 'libapi' },
      { id: 'libapi-image', name: 'GPT Image 2.5 Flare', modelId: 'gt-image-2.5-flare', category: 'image' as const, providerConfigId: 'libapi' },
      { id: 'libapi-video', name: 'Veo 3.1', modelId: 'vo-3.1', category: 'video' as const, providerConfigId: 'libapi' },
      { id: 'relay-image', name: 'GPT Image 2.5 Flare', modelId: 'gt-image-2.5-flare', category: 'image' as const, providerConfigId: 'relay' },
    ];
    expect(getGeneralModelGroups(models, config, 'ai-text')[0]).toMatchObject({
      id: 'general-provider-libapi', name: 'LibAPI', badgeText: 'LIB',
      models: [expect.objectContaining({ value: 'general/libapi-text', provider: 'general' })],
    });
    const images = getGeneralModelGroups(models, config, 'ai-image');
    expect(images.find((group) => group.name === 'LibAPI')?.models.map((model) => model.value))
      .toEqual(['general/libapi-image']);
    expect(images.find((group) => group.id === 'general-models')?.models.map((model) => model.value))
      .toEqual(['general/relay-image']);
    expect(getMediaModelOptions(models, config).filter((model) => model.groupName === 'LibAPI')
      .map((model) => ({ value: model.value, groupId: model.groupId, kind: model.mediaKind }))).toEqual([
      { value: 'general/libapi-image', groupId: 'general-provider-libapi', kind: 'image' },
      { value: 'general/libapi-video', groupId: 'general-provider-libapi', kind: 'video' },
    ]);
    const hidden = { ...config, providers: { ...config.providers, libapi: { ...config.providers.libapi, visibleModelCategories: ['text' as const] } } };
    expect(getMediaModelOptions(models, hidden).some((model) => model.groupName === 'LibAPI')).toBe(false);
  });
});

describe('RelayOnAPI 模型分组', () => {
  const textIds = ['gemini-3.8-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5-5'];
  const selectedModels = (): ProviderModelSelection[] => getProviderDefinition('relayonapi')!.models!
    .filter((model) => model.category === 'text');
  const generalModels = (providerConfigId: string) => selectedModels().map((model, index) => ({
    id: `${providerConfigId}-${index}`, name: model.name, modelId: model.id,
    category: model.category, providerConfigId,
  }));

  it.each(['', 'fixture'])('预置四个文本候选，未勾选时不自动注入节点模型（Key %s）', (apiKey) => {
    expect(selectedModels().map((model) => model.id)).toEqual(textIds);
    const config: AppConfig = { theme: 'dark', providers: {
      relayonapi: { name: '万象连接', catalogId: 'relayonapi', apiKey, selectedModels: [] },
    } };
    expect(getConfiguredModelGroups(config, 'ai-text')).toEqual([]);
    expect(getGeneralModelGroups([], config, 'ai-text')).toEqual([]);
    expect(getMediaModelOptions([], config)).toEqual([]);
  });

  it('已启用文本聚合厂商并标识分组，模型身份保持独立', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      left: { name: '左万象连接', catalogId: 'relayonapi', relayonGroup: 'default', apiKey: 'left-fixture', selectedModels: selectedModels() },
      right: { name: '右万象连接', catalogId: 'relayonapi', relayonGroup: 'Gemini号池', apiKey: 'right-fixture', selectedModels: selectedModels() },
    } };
    const models = [...generalModels('left'), ...generalModels('right')];
    const groups = getGeneralModelGroups(models, config, 'ai-text');
    expect(groups.map((group) => group.id)).toEqual(['general-provider-relayonapi']);
    expect(groups[0]).toMatchObject({ name: '万象 API（RelayOnAPI）', badgeText: 'RA' });
    for (const [index, connectionId] of ['left', 'right'].entries()) {
      const options = groups[0].models.slice(index * textIds.length, (index + 1) * textIds.length);
      expect(options.map((model) => model.value))
        .toEqual(textIds.map((_, modelIndex) => `general/${connectionId}-${modelIndex}`));
      expect(options.every((model) => model.provider === 'general' && model.nodeTypes.includes('ai-text'))).toBe(true);
      expect(options.every((model) => model.label.endsWith(index === 0 ? ' · default' : ' · Gemini号池'))).toBe(true);
    }
    for (const category of ['ai-image', 'ai-video', 'ai-audio'] as const) {
      expect(getGeneralModelGroups(models, config, category)).toEqual([]);
    }
    expect(getMediaModelOptions(models, config)).toEqual([]);
    expect(models.map((model) => model.providerConfigId)).toEqual(['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right']);
  });

  it('仅展示同步保留的勾选模型，关闭文本类别后隐藏整个连接', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      relay: { name: '万象连接', catalogId: 'relayonapi', apiKey: 'fixture', selectedModels: [selectedModels()[2]] },
    } };
    const models = [generalModels('relay')[2]];
    expect(getGeneralModelGroups(models, config, 'ai-text')[0].models.map((model) => model.value))
      .toEqual(['general/relay-2']);
    const hidden = { ...config, providers: { relay: { ...config.providers.relay, visibleModelCategories: [] } } };
    expect(getGeneralModelGroups(models, hidden, 'ai-text')).toEqual([]);
  });

  it('默认媒体候选不自动启用，勾选后文本、图片、视频共用当前连接分组', () => {
    const catalog = getProviderDefinition('relayonapi')!.models!;
    const selected = ['text', 'image', 'video'].map((category) => catalog.find((model) => model.category === category)!);
    const config: AppConfig = { theme: 'dark', providers: {
      'my-relay': { name: '我的万象连接', catalogId: 'relayonapi', apiKey: 'fixture', selectedModels: selected },
    } };
    expect(getGeneralModelGroups([], config, 'ai-image')).toEqual([]);
    expect(getMediaModelOptions([], config)).toEqual([]);
    const models = selected.map((model) => ({ id: `relay-${model.category}`, name: model.name,
      modelId: model.id, providerConfigId: 'my-relay', category: model.category }));
    for (const [nodeType, category] of [['ai-text', 'text'], ['ai-image', 'image'], ['ai-video', 'video']] as const) {
      expect(getGeneralModelGroups(models, config, nodeType)).toEqual([
        expect.objectContaining({ id: 'general-provider-relayonapi', name: '万象 API（RelayOnAPI）', badgeText: 'RA',
          models: [expect.objectContaining({ value: `general/relay-${category}`, provider: 'general' })] }),
      ]);
    }
    expect(getMediaModelOptions(models, config).map((model) => ({ value: model.value, kind: model.mediaKind,
      groupId: model.groupId }))).toEqual([
      { value: 'general/relay-image', kind: 'image', groupId: 'general-provider-relayonapi' },
      { value: 'general/relay-video', kind: 'video', groupId: 'general-provider-relayonapi' },
    ]);
    const hidden = { ...config, providers: { 'my-relay': { ...config.providers['my-relay'], visibleModelCategories: ['text' as const] } } };
    expect(getMediaModelOptions(models, hidden)).toEqual([]);
    expect(getGeneralModelGroups(models, config, 'ai-audio')).toEqual([]);
  });

  it('连接名称等于 RelayOnAPI ID 的显式自定义连接保持通用分组', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      relayonapi: { name: '同名自定义连接', catalogId: 'custom-openai', apiKey: 'fixture' },
    } };
    expect(getGeneralModelGroups([generalModels('relayonapi')[0]], config, 'ai-text')).toEqual([
      expect.objectContaining({ id: 'general-models', models: [expect.objectContaining({ value: 'general/relayonapi-0' })] }),
    ]);
  });

  it('旧连接不猜测分组，媒体和节点菜单均保留显式分组', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      relayonapi: { name: '旧连接', apiKey: 'legacy-fixture' },
      image: { name: '图片组', catalogId: 'relayonapi', relayonGroup: 'image', apiKey: 'image-fixture' },
    } };
    const models = ['relayonapi', 'image'].map((providerConfigId) => ({
      id: `${providerConfigId}-image`, name: 'Image', modelId: 'image-2.5-flare',
      category: 'image' as const, providerConfigId,
    }));
    expect(getGeneralModelGroups(models, config, 'ai-image')[0].models.map((model) => model.label))
      .toEqual(['Image', 'Image · image']);
    expect(getMediaModelOptions(models, config).map((model) => [model.value, model.label]))
      .toEqual([['general/relayonapi-image', 'Image'], ['general/image-image', 'Image · image']]);
  });
});

describe('声明式厂商菜单的分组范围', () => {
  it.each([
    { catalogId: 'cccapi', name: 'CCC API', badge: 'CCC', sharedGroup: true },
    { catalogId: 'toapis', name: 'ToAPIs', badge: 'T', sharedGroup: false },
    { catalogId: 'libapi', name: 'LibAPI', badge: 'LIB', sharedGroup: false },
    { catalogId: 'sora2u', name: 'Sora2U', badge: 'S2U', sharedGroup: false },
  ])('$catalogId 的节点和对话菜单保留连接身份及原分组范围', ({ catalogId, name, badge, sharedGroup }) => {
    const config: AppConfig = { theme: 'dark', providers: {
      left: { name: '左连接', catalogId, apiKey: 'left-fixture' },
      right: { name: '右连接', catalogId, apiKey: 'right-fixture' },
    } };
    const models = ['left', 'right'].map((providerConfigId) => ({ id: providerConfigId, name: providerConfigId,
      modelId: 'same-remote-id', category: 'image' as const, providerConfigId }));
    const expectedGroups = sharedGroup ? [`general-provider-${catalogId}`] : ['general-provider-left', 'general-provider-right'];
    const groups = getGeneralModelGroups(models, config, 'ai-image');
    expect(groups.map((group) => group.id)).toEqual(expectedGroups);
    expect(groups.every((group) => group.name === name && group.badgeText === badge)).toBe(true);
    expect(groups.flatMap((group) => group.models.map((model) => model.value))).toEqual(['general/left', 'general/right']);
    const media = getMediaModelOptions(models, config).filter((model) => model.provider === 'general');
    expect(media.map((model) => model.value)).toEqual(['general/left', 'general/right']);
    expect([...new Set(media.map((model) => model.groupId))]).toEqual(expectedGroups);
    expect(media.every((model) => model.groupName === name)).toBe(true);
  });

  it('显式自定义厂商身份优先于连接名，未声明独立菜单的官方模型仍在通用分组', () => {
    const config: AppConfig = { theme: 'dark', providers: {
      libapi: { name: '同名自定义连接', catalogId: 'custom-openai', apiKey: 'fixture' },
      official: { name: '官方连接', catalogId: 'google', apiKey: 'fixture' },
    } };
    const models = ['libapi', 'official'].map((providerConfigId) => ({ id: providerConfigId, name: providerConfigId,
      modelId: 'same-remote-id', category: 'image' as const, providerConfigId }));
    expect(getGeneralModelGroups(models, config, 'ai-image')).toEqual([
      expect.objectContaining({ id: 'general-models', models: [
        expect.objectContaining({ value: 'general/libapi' }), expect.objectContaining({ value: 'general/official' }),
      ] }),
    ]);
    expect(getMediaModelOptions(models, config).filter((model) => model.provider === 'general')
      .every((model) => model.groupId === 'general-models')).toBe(true);
  });
});

describe('自定义连接模型的来源标注', () => {
  const config: AppConfig = {
    providers: {
      'custom-a': { name: '甲中转站', apiKey: 'k', catalogId: 'custom-openai', selectedModels: [] },
      'custom-b': { name: '乙中转站', apiKey: 'k', catalogId: 'custom-openai', selectedModels: [] },
    },
    theme: 'dark',
  };
  const generalModels = [
    { id: 'gm-a', name: 'GPT-4o', modelId: 'gpt-4o', category: 'image' as const, providerConfigId: 'custom-a' },
    { id: 'gm-b', name: 'GPT-4o', modelId: 'gpt-4o', category: 'image' as const, providerConfigId: 'custom-b' },
  ];

  it('同名模型按所属连接区分', () => {
    const options = getMediaModelOptions(generalModels, config);
    const descriptions = options
      .filter((option) => option.label === 'GPT-4o')
      .map((option) => option.description);

    expect(descriptions).toEqual(['甲中转站 · ID: gpt-4o', '乙中转站 · ID: gpt-4o']);
  });

  it('缺少连接信息时退回原说明', () => {
    const option = getMediaModelOptions([generalModels[0]])
      .find((item) => item.value === 'general/gm-a');
    expect(option?.description).toBe('ID: gpt-4o');
  });
});
