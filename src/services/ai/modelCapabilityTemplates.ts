/**
 * 精确型号的公共能力基线。渠道只覆写参数能力，不在这里选择 HTTP 协议或识别用户模型名称。
 * undefined 表示渠道没有声明该字段；数组及输入模式整体替换，不合并扩大候选或素材权限。
 */
import type { ImageModelCapability, VideoModelCapability } from '../../types/aiTypes';
import { getImageSizePresets } from './modelSizeProfiles';
import { getOfficialSeedanceCapability } from './seedanceModelCapabilities';
import { getOfficialH3Capability } from './h3ModelCapabilities';

export type ImageCapabilityTemplateId =
  | 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-2' | 'gpt-image-2.5' | 'gpt-image-2.6'
  | 'nano-banana' | 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2.1'
  | 'seedream-4' | 'seedream-4.5' | 'seedream-5-lite' | 'seedream-5-pro';

export type VideoCapabilityTemplateId =
  | 'seedance-2.0' | 'seedance-2.0-fast' | 'seedance-2.0-mini' | 'seedance-2.5'
  | 'minimax-h3' | 'minimax-h3-max';

const BANANA_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const BANANA_EXTRA_RATIOS = ['1:4', '4:1', '1:8', '8:1'];
const COMMON_IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];

const GPT_BASE: ImageModelCapability = {
  resolutions: ['1K', '2K', '4K'], defaultResolution: '1K',
  ratios: Object.keys(getImageSizePresets('openai-gpt')['1K']), defaultRatio: '1:1',
  qualities: ['auto', 'low', 'medium', 'high'], defaultQuality: 'auto',
  supportsBatch: true, maxBatchCount: 8, supportsImageReference: true,
  maxImageReferences: 16, supportsDataUrlReference: true,
};
const BANANA_BASE: ImageModelCapability = {
  resolutions: ['1K', '2K', '4K'], defaultResolution: '1K',
  ratios: BANANA_RATIOS, defaultRatio: '1:1', supportsBatch: false, maxBatchCount: 1,
  supportsImageReference: true, maxImageReferences: 14, supportsDataUrlReference: true,
};
const SEEDREAM_BASE: ImageModelCapability = {
  resolutions: ['1K', '2K', '4K'], defaultResolution: '2K',
  ratios: [...COMMON_IMAGE_RATIOS, '21:9', '9:21'], defaultRatio: '1:1',
  supportsBatch: true, maxBatchCount: 15, supportsImageReference: true,
  maxImageReferences: 15, supportsDataUrlReference: true,
};

const IMAGE_TEMPLATES: Record<ImageCapabilityTemplateId, ImageModelCapability> = {
  'gpt-image-1': { ...GPT_BASE, ratios: ['1:1', '3:2', '2:3'], maxImageReferences: 15 },
  'gpt-image-1.5': { ...GPT_BASE, ratios: ['1:1', '3:2', '2:3'], maxImageReferences: 15 },
  'gpt-image-2': GPT_BASE,
  'gpt-image-2.5': { ...GPT_BASE, qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    backgrounds: ['auto', 'opaque', 'transparent'] },
  // 2.6 的渠道别名没有统一确认的高级能力；兼容 2.5 的渠道须在覆写中明确声明。
  'gpt-image-2.6': { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1',
    supportsBatch: false, supportsImageReference: true },
  'nano-banana': { ...BANANA_BASE, resolutions: ['1K'], maxImageReferences: 3 },
  'nano-banana-pro': BANANA_BASE,
  'nano-banana-2': { ...BANANA_BASE, resolutions: ['512', '1K', '2K', '4K'], ratios: [...BANANA_RATIOS, ...BANANA_EXTRA_RATIOS] },
  'nano-banana-2.1': { ...BANANA_BASE, ratios: [...BANANA_RATIOS, ...BANANA_EXTRA_RATIOS] },
  'seedream-4': SEEDREAM_BASE,
  'seedream-4.5': { ...SEEDREAM_BASE, resolutions: ['2K', '4K'] },
  'seedream-5-lite': { ...SEEDREAM_BASE, resolutions: ['2K', '3K', '4K'], ratios: [...COMMON_IMAGE_RATIOS, '21:9'] },
  'seedream-5-pro': { ...SEEDREAM_BASE, resolutions: ['1K', '1.5K', '2K'], ratios: ['auto', ...COMMON_IMAGE_RATIOS, '21:9'],
    defaultRatio: 'auto', supportsBatch: false, maxBatchCount: undefined, maxImageReferences: 10 },
};

/** 只在内置目录/显式模板构造时使用，不用默认值迁移已保存配置。 */
function channelCapability<T extends ImageModelCapability | VideoModelCapability>(base: T, overrides: T | undefined): T {
  return structuredClone(Object.fromEntries(Object.entries({ ...base, ...overrides })
    .filter(([, value]) => value !== undefined))) as T;
}

export function getImageCapabilityTemplate(
  id: ImageCapabilityTemplateId,
  overrides?: ImageModelCapability,
): ImageModelCapability {
  if (!Object.hasOwn(IMAGE_TEMPLATES, id)) throw new Error(`未知图片基础模板：${id}`);
  return channelCapability(IMAGE_TEMPLATES[id], overrides);
}

export function getVideoCapabilityTemplate(
  id: VideoCapabilityTemplateId,
  overrides?: VideoModelCapability,
): VideoModelCapability {
  if (!['seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'seedance-2.5', 'minimax-h3', 'minimax-h3-max'].includes(id)) {
    throw new Error(`未知视频基础模板：${id}`);
  }
  const base = id === 'minimax-h3' || id === 'minimax-h3-max'
    ? getOfficialH3Capability(id === 'minimax-h3' ? 'h3-standard' : 'h3-max')
    : getOfficialSeedanceCapability(id === 'seedance-2.5' ? '2.5'
      : id === 'seedance-2.0-fast' ? '2.0-fast' : id === 'seedance-2.0-mini' ? '2.0-mini' : '2.0-standard');
  return channelCapability(base, overrides);
}
