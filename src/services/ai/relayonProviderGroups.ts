/**
 * relayonProviderGroups — 维护 Relayon 分组目录与模型、价格筛选。
 */
import type { ApiProviderConfig, ProviderModelSelection } from '../../types';
import { RELAYON_BASE_URL, RELAYON_IMAGE_BASE_URL, RELAYON_VIDEO_BASE_URL, RELAYON_IMAGE_MODEL_IDS, RELAYON_VIDEO_MODEL_IDS } from './providers/relayonModelManifest';

/** 新图片／视频分组使用各自文档的 API 域名；已有连接不在此改写。 */
export function relayonGroupBaseUrl(group?: string): string {
  return group?.trim() === 'image' ? RELAYON_IMAGE_BASE_URL
    : group?.trim() === 'video' ? RELAYON_VIDEO_BASE_URL : RELAYON_BASE_URL;
}

/** 仅供已确认完整内置图片合同的新调用使用，不迁移配置或历史回执。 */
export function resolveRelayonImageBaseUrl(value: string): string {
  return isRelayonOfficialBaseUrl(value) ? RELAYON_IMAGE_BASE_URL : value;
}

/** 导入保留原官方来源；拒绝凭据、非标准端口和路径伪装。 */
export function isRelayonOfficialBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return [new URL(RELAYON_BASE_URL).origin, new URL(RELAYON_VIDEO_BASE_URL).origin].includes(url.origin)
      && !url.username && !url.password && url.pathname.replace(/\/+$/, '') === '/v1' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const CLAUDE_GROUP = 'Claudekiro号池';

/** 旧分组名继续对应当前目录，存储的连接身份与配置无需迁移。 */
export function resolveRelayonGroup(group?: string): string | undefined {
  const name = group?.trim();
  return name === 'ClaudeMax号池' ? CLAUDE_GROUP : name || undefined;
}

/** 官网分组快照，候选不代表 Key 已验证或具有全部权限。 */
export const RELAYON_PROVIDER_GROUPS = [
  { name: CLAUDE_GROUP, description: 'Claude 文本模型分组' },
  { name: 'GPTpro号池', description: 'GPT 文本模型分组' },
  { name: 'Gemini号池', description: 'Gemini 文本模型分组' },
  { name: 'default', description: '默认分组' },
  { name: 'image', description: '图片模型分组' },
  { name: 'video', description: '视频模型分组' },
] as const;

const GROUP_PRESETS: Record<string, readonly string[]> = {
  [CLAUDE_GROUP]: ['claude-opus-5-5'],
  'GPTpro号池': ['gpt-6.1-sol'],
  'Gemini号池': ['gemini-3.8-flash', 'gemini-4-argon'],
  default: [],
  image: RELAYON_IMAGE_MODEL_IDS,
  video: RELAYON_VIDEO_MODEL_IDS,
};

export function getRelayonGroupPresetModels(models: readonly ProviderModelSelection[], group?: string): ProviderModelSelection[] {
  const name = resolveRelayonGroup(group);
  if (!name) return [...models];
  const ids = new Set(GROUP_PRESETS[name] ?? []);
  return models.filter((model) => ids.has(model.id));
}

export function relayonConnectionName(config?: Pick<ApiProviderConfig, 'relayonGroup'>): string {
  const group = resolveRelayonGroup(config?.relayonGroup);
  return group ? `万象 API · ${group}` : '万象 API（RelayOnAPI）';
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
  const name = resolveRelayonGroup(group);
  const ids = new Set<string>();
  for (const item of data.data as unknown[]) {
    if (!item || typeof item !== 'object') throw new Error('万象分组目录无效');
    const entry = item as Record<string, unknown>;
    if (typeof entry.model_name !== 'string' || !entry.model_name.trim()
      || !Array.isArray(entry.enable_groups) || !entry.enable_groups.every((value: unknown) => typeof value === 'string')) {
      throw new Error('万象分组目录无效');
    }
    if (name !== undefined && entry.enable_groups.includes(name)) ids.add(entry.model_name);
  }
  return models.filter((model) => ids.has(model.id));
}
