/**
 * settings/providerConnection/providerConnectionModels — 候选模型的合并与能力规范化。
 *
 * 合并规则的核心：用户手动改过的分类 / 描述 / 输入模态优先于目录或 Agent 带来的值，
 * 避免每次拉取模型清单都把人工修正冲掉。
 */
import type { ProviderModelSelection } from '../../../types';
import type { VideoModelCapability } from '../../../types/aiTypes';
import { assertVideoModelCapability } from '../../../services/ai/videoRequestResolver';

export function mergeModels(
  current: ProviderModelSelection[],
  incoming: ProviderModelSelection[],
): ProviderModelSelection[] {
  const models = new Map(current.map((model) => [model.id, model]));
  for (const model of incoming) {
    const existing = models.get(model.id);
    const incomingHasOnlyRawName = model.name.trim().toLowerCase() === model.id.trim().toLowerCase();
    const existingHasFriendlyName = existing
      && existing.name.trim().toLowerCase() !== existing.id.trim().toLowerCase();
    const preserveExistingMetadata = incomingHasOnlyRawName && existingHasFriendlyName;
    // 用户手动指定过分类时，重新拉取目录或合并模型不再覆盖该分类。
    const preserveExistingCategory = Boolean(existing?.categoryManual) || preserveExistingMetadata;
    models.set(model.id, {
      ...existing,
      ...model,
      name: preserveExistingMetadata ? existing.name : model.name,
      category: preserveExistingCategory && existing ? existing.category : model.category,
      description: existing?.descriptionManual
        ? existing.description
        : model.description || existing?.description,
      descriptionManual: existing?.descriptionManual ?? model.descriptionManual,
      inputModalities: existing?.inputModalitiesManual
        ? existing.inputModalities
        : model.inputModalities ?? existing?.inputModalities,
      inputModalitiesManual: existing?.inputModalitiesManual ?? model.inputModalitiesManual,
      categoryManual: existing?.categoryManual ?? model.categoryManual,
    });
  }
  return [...models.values()];
}

// 编辑器候选预设只用于展示，绝不能把未声明字段补进权威 capability。
export function createEditableVideoCapability(
  capability?: VideoModelCapability,
): VideoModelCapability {
  return {
    ...capability,
    ...(capability?.ratios ? { ratios: [...capability.ratios] } : {}),
    ...(capability?.resolutions ? { resolutions: [...capability.resolutions] } : {}),
    ...(capability?.frameRates ? { frameRates: [...capability.frameRates] } : {}),
    ...(capability?.durations ? { durations: [...capability.durations] } : {}),
  };
}

export function keepDeclaredVideoCapabilityDefault<T>(
  currentDefault: T | undefined,
  allowedValues: readonly T[],
): T | undefined {
  return currentDefault !== undefined && allowedValues.includes(currentDefault)
    ? currentDefault
    : undefined;
}

export function assertProviderModelsVideoCapabilities(
  models: readonly ProviderModelSelection[],
): void {
  for (const model of models) {
    if (model.category !== 'video' || !model.videoCapability) continue;
    try {
      assertVideoModelCapability(model.videoCapability);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '能力声明无效';
      throw new Error(`视频模型“${model.name}”的能力配置无效：${detail}`, { cause: error });
    }
  }
}
