/**
 * plugins/pluginModelCatalog — 插件可见的可调用模型目录。
 *
 * 只输出模型身份、分类、能力与展示分组，不含 API Key、接口地址或任何厂商凭据。
 * 自定义节点与节点工具共用同一份枚举逻辑，避免两处各自维护导致目录漂移。
 */
import { useAppStore } from '../../store/useAppStore';
import type { GeneralModelCategory, ModelGroup, NodeType, WorkflowDefinition } from '../../types';
import type { PluginModelGroupSummary, PluginModelSummary } from '../../types/plugin';
import { resolveVideoModelCapability } from '../ai/videoModelCapabilityResolver';
import {
  defaultModelGroups,
  getConfiguredModelGroups,
  getGeneralModelGroups,
  getMediaModelOptions,
  hasVisionInputCapability,
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

const GROUP_TONES: Record<string, PluginModelGroupSummary['tone']> = {
  apimart: 'success',
  volcengine: 'info',
  grsai: 'danger',
  dreamina: 'warning',
};

/** 显式挑选展示字段，不能把分组源码、连接配置或工作流详情整体交给插件。 */
function groupSummary(group: ModelGroup): PluginModelGroupSummary {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    badgeText: group.badgeText,
    tone: GROUP_TONES[group.id] ?? 'brand',
  };
}

/** 完整复刻仅开放已接入提交前租约校验的通道；显示提示与执行入口共用此策略。 */
export function getPluginVideoReplicaSupport(provider: string) {
  if (['general', 'comfyui', 'volcengine'].includes(provider)) return { supported: true } as const;
  return { supported: false, reason: '此通道暂不支持一键全片复刻，请选择其他视频模型或工作流。' } as const;
}

function videoCapabilitySummary(
  category: GeneralModelCategory, modelId: string, provider: string, config: AppConfig,
): Pick<PluginModelSummary, 'videoCapability' | 'videoReplicaSupport'> {
  if (category !== 'video') return {};
  const capability = resolveVideoModelCapability(modelId, config);
  return { ...(capability ? { videoCapability: capability } : {}), videoReplicaSupport: getPluginVideoReplicaSupport(provider) };
}

/** 旧目录没有显式模态时复用宿主既有视觉能力判断，让插件不用复制模型 ID 规则。 */
export function resolvePluginModelInputModalities(
  category: GeneralModelCategory,
  modelId: string,
  declared: PluginModelSummary['inputModalities'],
): PluginModelSummary['inputModalities'] {
  if (declared !== undefined || category !== 'text') return declared;
  return hasVisionInputCapability({ modelId }) ? ['text', 'image'] : ['text'];
}

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
  workflows: WorkflowDefinition[] = useAppStore.getState().workflows ?? [],
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
      group: groupSummary(group),
      inputModalities: resolvePluginModelInputModalities(category, model.value, model.inputModalities),
      ...videoCapabilitySummary(category, model.value, model.provider, config),
    })));
    const callableGeneralModels = (config.generalModels ?? [])
      .filter((model) => (
        model.category === category
        && !!config.providers[model.providerConfigId]?.apiKey
        && isProviderCategoryVisible(config, model.providerConfigId, category)
      ));
    const generalPresentations = new Map(getGeneralModelGroups(
      callableGeneralModels,
      config,
      CATEGORY_NODE_TYPES[category],
    ).flatMap((group) => group.models.map((model) => [model.value, { model, group: groupSummary(group) }] as const)));
    const general = callableGeneralModels.map((model) => {
      const presentation = generalPresentations.get(`general/${model.id}`);
      return {
        id: `general/${model.id}`,
        name: presentation?.model.label ?? model.name,
        provider: 'general',
        category,
        description: presentation?.model.description ?? (model.description || `ID: ${model.modelId}`),
        ...(presentation ? { group: presentation.group } : {}),
        inputModalities: resolvePluginModelInputModalities(category, model.modelId, model.inputModalities),
        ...videoCapabilitySummary(category, `general/${model.id}`, 'general', config),
      };
    });
    return [...builtIn, ...general];
  });
  const videoWorkflows = categories.includes('video') ? workflows.filter((workflow) => {
    const boundUrl = config.comfyServers?.find((server) => server.id === workflow.serverId)?.url;
    return workflow.category === 'ai-video' && (!workflow.adapterType || workflow.adapterType === 'comfyui')
      && !!workflow.fileContent.trim() && !!(boundUrl?.trim() || config.comfyUIUrl?.trim());
  }) : [];
  const workflowModels: PluginModelSummary[] = getMediaModelOptions([], config, videoWorkflows)
    .filter((option) => !!option.workflowId && option.provider === 'comfyui')
    .map((option) => ({
      id: option.value,
      name: option.label,
      provider: 'comfyui',
      category: 'video',
      description: 'ComfyUI 工作流',
      group: { id: '__workflows', name: '工作流', description: 'ComfyUI、RunningHub 与工作流 API', badgeText: 'WF', tone: 'brand' },
      videoReplicaSupport: getPluginVideoReplicaSupport('comfyui'),
    }));
  return [...new Map([...models, ...workflowModels].map((model) => [model.id, model])).values()];
}
