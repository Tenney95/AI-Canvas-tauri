import { describe, expect, it } from 'vitest';
import {
  findMediaModelOption,
  getConfiguredModelGroups,
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
