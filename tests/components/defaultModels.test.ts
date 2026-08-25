import { describe, expect, it } from 'vitest';
import {
  defaultModelGroups,
  findMediaModelOption,
  getConfiguredModelGroups,
  getGeneralModelGroups,
  getMediaModelOptions,
} from '../../src/components/nodes/shared/defaultModels';
import type { AppConfig, ProviderModelSelection } from '../../src/types';

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

  it('内置 GRSAI 官网当前完整模型目录', () => {
    const models = defaultModelGroups.find((group) => group.id === 'grsai')?.models ?? [];

    expect(models.map((model) => model.value)).toEqual([
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
      'grsai/gpt-5.4',
      'grsai/gpt-5.5',
      'grsai/gemini-3.1-flash-lite',
      'grsai/gemini-3.1-pro',
      'grsai/gemini-3.5-flash',
      'grsai/gemini-3-flash',
      'grsai/gemini-3-pro',
      'grsai/gemini-2.5-flash',
      'grsai/gemini-2.5-pro',
    ]);
    expect(models.filter((model) => model.nodeTypes.includes('ai-image'))).toHaveLength(13);
    expect(models.filter((model) => model.nodeTypes.includes('ai-text'))).toHaveLength(9);
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
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      category: 'text',
      provider: 'apimart',
    }]);

    const models = getConfiguredModelGroups(config, 'ai-text')
      .find((group) => group.id === 'apimart')?.models ?? [];

    expect(models.filter((model) => model.value === 'apimart/gpt-5.4')).toHaveLength(1);
    expect(models.some((model) => model.value === 'apimart/gpt-5.2')).toBe(false);
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
