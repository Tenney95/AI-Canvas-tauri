/**
 * cccProviderGroups — 维护 CCC 分组目录与模型筛选。
 */
import type { ApiProviderConfig, ProviderModelSelection } from '../../types';

/** CCC 控制台公开的分组名称；权限与模型目录始终以该分组的 Key 返回值为准。 */
export const CCC_PROVIDER_GROUPS = [
  { name: '🍌香蕉（官k）', description: '香蕉官方 Key 分组', family: 'gemini-image' },
  { name: 'gpt-image-2/2.5（官k）', description: '官方图片参数与透明背景', family: 'gpt-image-2' },
  { name: 'CCC生图白嫖', description: '该渠道无法限制分辨率，请以渠道实际输出为准', family: 'gpt-image' },
  { name: 'CCC生图稳定', description: '自营 Adobe 图片渠道，支持 4K 传参', family: 'gpt-image' },
  { name: '国模-稳定2折', description: 'DeepSeek、GLM、Qwen、Hy3、MiMo 等国产模型', family: 'domestic' },
  { name: 'GPT-Pro分组', description: 'GPT Pro 质量与稳定性分组', family: 'gpt-text' },
  { name: 'GPT-特价Pro', description: 'GPT Pro 特价分组', family: 'gpt-text' },
  { name: 'CC-MAX满血', description: 'Claude 稳定分组', family: 'claude' },
] as const;

const DOMESTIC_MODEL_IDS = new Set(['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash', 'Hy3', 'mI MiMo-V2.5']);

/** 按控制台说明限定模型族；未收录分组与旧连接保留 Key 返回的目录。 */
export function filterCccGroupModels(models: readonly ProviderModelSelection[], group?: string): ProviderModelSelection[] {
  const definition = CCC_PROVIDER_GROUPS.find((item) => item.name === group?.trim());
  return models.filter((model) => {
    switch (definition?.family) {
      case 'gemini-image': return model.category === 'image' && /^(?:gemini-.*image|nano-banana)/i.test(model.id);
      case 'gpt-image-2': return model.category === 'image' && /^gpt-image-2(?:\.5)?(?:-|$)/i.test(model.id);
      case 'gpt-image': return model.category === 'image' && /^gpt-image-/i.test(model.id);
      case 'domestic': return model.category === 'text' && DOMESTIC_MODEL_IDS.has(model.id);
      case 'gpt-text': return model.category === 'text' && /^(?:gpt-|o\d|codex-)/i.test(model.id);
      case 'claude': return model.category === 'text' && /^claude-/i.test(model.id);
      default: return true;
    }
  });
}

/** 预置目录只用于已知分组的选择预览，不表示 Key 已验证或拥有全部型号权限。 */
export function getCccGroupPresetModels(models: readonly ProviderModelSelection[], group?: string): ProviderModelSelection[] {
  if (!CCC_PROVIDER_GROUPS.some((item) => item.name === group?.trim())) return [];
  // 2026-11-05 广场只在白嫖组列出 2.6；仅限制预览，不拦截 Key 实际返回的新权限。
  return filterCccGroupModels(models, group).filter((model) => model.id !== 'gpt-image-2.6' || group?.trim() === 'CCC生图白嫖');
}

export function cccConnectionName(config?: Pick<ApiProviderConfig, 'cccGroup'>): string {
  return config?.cccGroup?.trim() ? `CCC API · ${config.cccGroup.trim()}` : 'CCC API';
}
