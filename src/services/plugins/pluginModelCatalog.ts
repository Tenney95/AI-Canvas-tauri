/**
 * plugins/pluginModelCatalog — 插件可见的可调用模型目录。
 *
 * 只输出 ID、名称、厂商、分类与输入模态，不含 API Key、接口地址或任何厂商凭据。
 * 自定义节点与节点工具共用同一份枚举逻辑，避免两处各自维护导致目录漂移。
 */
import { useAppStore } from '../../store/useAppStore';
import type { GeneralModelCategory, NodeType } from '../../types';
import type { PluginModelSummary } from '../../types/plugin';
import {
  defaultModelGroups,
  getConfiguredModelGroups,
  isProviderCategoryVisible,
} from '../../components/nodes/shared/defaultModels';

type AppConfig = ReturnType<typeof useAppStore.getState>['config'];

const CATEGORY_NODE_TYPES: Record<GeneralModelCategory, NodeType> = {
  text: 'ai-text',
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

export const ALL_MODEL_CATEGORIES: GeneralModelCategory[] = ['text', 'image', 'video', 'audio'];

/** 汇总自定义节点字段或节点工具弹窗字段声明的模型分类；未声明时视为不限分类。 */
export function collectDeclaredModelCategories(
  fields: Array<{ type: string; modelCategories?: GeneralModelCategory[] }>,
): GeneralModelCategory[] {
  const declared = fields
    .filter((field) => field.type === 'model')
    .flatMap((field) => field.modelCategories ?? []);
  const categories = declared.length > 0 ? declared : ALL_MODEL_CATEGORIES;
  return [...new Set(categories)];
}

/** 构建插件可见的模型目录；仅当插件声明 models.read 时才应交给插件。 */
export function buildPluginModelCatalog(
  config: AppConfig,
  categories: GeneralModelCategory[],
): PluginModelSummary[] {
  const models = categories.flatMap((category) => {
    const builtIn = getConfiguredModelGroups(
      config,
      CATEGORY_NODE_TYPES[category],
      defaultModelGroups,
      { filterSelectedModels: true },
    ).flatMap((group) => group.models.map((model) => ({
      id: model.value,
      name: model.label,
      provider: model.provider,
      category,
      description: model.description,
      inputModalities: model.inputModalities,
    })));
    const general = (config.generalModels ?? [])
      .filter((model) => (
        model.category === category
        && !!config.providers[model.providerConfigId]?.apiKey
        && isProviderCategoryVisible(config, model.providerConfigId, category)
      ))
      .map((model) => ({
        id: `general/${model.id}`,
        name: model.name,
        provider: 'general',
        category,
        description: model.description || `ID: ${model.modelId}`,
        inputModalities: model.inputModalities,
      }));
    return [...builtIn, ...general];
  });
  return [...new Map(models.map((model) => [model.id, model])).values()];
}
