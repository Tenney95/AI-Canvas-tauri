/**
 * relayonProviderGroups — 维护 Relayon 分组目录与模型、价格筛选。
 */
import type { ApiProviderConfig, ProviderModelSelection } from '../../types';

/** 官网分组快照，候选不代表 Key 已验证或具有全部权限。 */
export const RELAYON_PROVIDER_GROUPS = [
  { name: 'ClaudeMax号池', description: 'Claude 文本模型分组' },
  { name: 'GPTpro号池', description: 'GPT 文本模型分组' },
  { name: 'Gemini号池', description: 'Gemini 文本模型分组' },
  { name: 'default', description: '默认分组' },
  { name: 'image', description: '图片模型分组' },
  { name: 'video', description: '视频模型分组' },
] as const;

const GROUP_PRESETS: Record<string, readonly string[]> = {
  'ClaudeMax号池': ['claude-opus-5-5'],
  'GPTpro号池': ['gpt-6.1-sol'],
  'Gemini号池': ['gemini-3.8-flash', 'gemini-4-argon'],
  default: [],
  image: ['image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst',
    'image-2.5-sunburst-01', 'nano-banana-2', 'nano-banana-2.1', 'nano-banana-pro', 'Seedream 5.0 Pro'],
  video: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-5-260628',
    'sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2', 'minimax-h3', 'sd-2.0-c3', 'sd-2.5-c1'],
};

export function getRelayonGroupPresetModels(models: readonly ProviderModelSelection[], group?: string): ProviderModelSelection[] {
  if (!group?.trim()) return [...models];
  const ids = new Set(GROUP_PRESETS[group.trim()] ?? []);
  return models.filter((model) => ids.has(model.id));
}

export function relayonConnectionName(config?: Pick<ApiProviderConfig, 'relayonGroup'>): string {
  return config?.relayonGroup?.trim() ? `万象 API · ${config.relayonGroup.trim()}` : '万象 API（RelayOnAPI）';
}

/** 仅接受完整的公开定价目录，异常时交给调用方保留已保存目录。 */
export function filterRelayonGroupPricing(
  models: readonly ProviderModelSelection[], group: string, payload: unknown,
): ProviderModelSelection[] {
  if (!payload || typeof payload !== 'object') throw new Error('万象分组目录无效');
  const data = payload as Record<string, unknown>;
  if (data.success !== true || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('万象分组目录无效');
  }
  const ids = new Set<string>();
  for (const item of data.data as unknown[]) {
    if (!item || typeof item !== 'object') throw new Error('万象分组目录无效');
    const entry = item as Record<string, unknown>;
    if (typeof entry.model_name !== 'string' || !entry.model_name.trim()
      || !Array.isArray(entry.enable_groups) || !entry.enable_groups.every((value: unknown) => typeof value === 'string')) {
      throw new Error('万象分组目录无效');
    }
    if (entry.enable_groups.includes(group)) ids.add(entry.model_name);
  }
  return models.filter((model) => ids.has(model.id));
}
