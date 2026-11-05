/** GRSAI 已核验的目录与厂商合同，不沿用同名模型的其它网关协议。 */
import type { ProviderModelSelection } from '../../types';
import type { ImageModelCapability, NormalizedModelExecutionProtocol, VideoModelCapability } from '../../types/aiTypes';

export const GRSAI_NANO_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'];
export const GRSAI_GPT_RATIOS = [...GRSAI_NANO_RATIOS, '9:21', '2:1', '1:2'];
const NANO_RESOLUTIONS: Record<string, string[]> = {
  'nano-banana-2.1': ['1K', '2K', '4K'],
  'nano-banana-2': ['1K', '2K', '4K'], 'nano-banana-pro': ['1K', '2K', '4K'],
  'nano-banana-2-lite': ['1K'], 'nano-banana-fast': ['1K'],
  'nano-banana-2-cl': ['1K'], 'nano-banana-pro-cl': ['1K'],
  'nano-banana-2-2k-cl': ['2K'], 'nano-banana-2-4k-cl': ['4K'],
  'nano-banana-pro-4k-vip': ['4K'], 'nano-banana-pro-vip': ['1K', '2K'],
};
const GPT_RESOLUTIONS: Record<string, string[]> = {
  'gpt-image-2': ['1K'], 'gpt-image-2.5': ['1K'], 'gpt-image-2.6': ['1K'],
  'gpt-image-2-vip': ['1K', '2K', '4K'],
  'gpt-image-2.5-flare': ['1K', '2K', '4K'], 'gpt-image-2.5-sunburst': ['1K', '2K', '4K'],
};
// https://qmy27nhsd9.apifox.cn/452409160e0.md：质量与输出分辨率是独立合同。
const GPT_QUALITIES: Record<string, string[]> = {
  'gpt-image-2': ['auto'], 'gpt-image-2.5': ['auto'], 'gpt-image-2.6': ['auto'], 'gpt-image-2-vip': ['medium'],
  'gpt-image-2.5-flare': ['low', 'medium', 'high'],
  'gpt-image-2.5-sunburst': ['low', 'medium', 'high', 'xhigh', 'max'],
};

export function getGrsaiImageCapability(model: string): ImageModelCapability | undefined {
  const id = model.replace(/^grsai\//, '');
  const resolutions = NANO_RESOLUTIONS[id] ?? GPT_RESOLUTIONS[id];
  if (!resolutions) return undefined;
  return {
    resolutions, defaultResolution: resolutions[0],
    ...(GPT_QUALITIES[id] ? { qualities: [...GPT_QUALITIES[id]],
      defaultQuality: id === 'gpt-image-2' || id === 'gpt-image-2.5' || id === 'gpt-image-2.6' ? 'auto' : 'medium' } : {}),
    ...(id === 'gpt-image-2-vip' || id === 'gpt-image-2.5-flare' || id === 'gpt-image-2.5-sunburst'
      ? { backgrounds: ['transparent'] } : {}),
    // 2.6 当前仅确认官方 1024x1024 / auto 示例，不继承 2.5 的比例及透明能力。
    ratios: id === 'gpt-image-2.6' ? ['1:1'] : GPT_RESOLUTIONS[id] ? GRSAI_GPT_RATIOS
      : id.startsWith('nano-banana-2') && id !== 'nano-banana-2-lite'
        ? [...GRSAI_NANO_RATIOS, '1:4', '4:1', '1:8', '8:1'] : GRSAI_NANO_RATIOS,
    defaultRatio: '1:1', supportsBatch: false,
    supportsImageReference: true, supportsDataUrlReference: true,
    // 本地 Base64 图片入口的预算；不是服务商公布的上限。
    maxImageReferences: 6,
  };
}

export function getGrsaiVideoCapability(model?: string, resolution?: string): VideoModelCapability | undefined {
  if (model?.replace(/^grsai\//, '') !== 'minimax-h3') return undefined;
  return {
    operations: ['text-to-video', 'image-to-video'],
    resolutions: ['480p', '768p', '1080p'], defaultResolution: '768p',
    ratios: ['16:9', '9:16'], defaultRatio: '16:9',
    minDuration: 1, maxDuration: resolution?.toLowerCase() === '1080p' ? 10 : 15, defaultDuration: 5,
    supportsAudio: false, supportsStandaloneAudio: true,
    maxImageReferences: 9, maxVideoReferences: 0, maxAudioReferences: 3,
  };
}

// https://qmy27nhsd9.apifox.cn/514679297e0
export const GRSAI_H3_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: {
    method: 'POST', path: '/v1/api/generate', pathMode: 'origin',
    body: { model: '{{model}}', prompt: '{{prompt}}', aspectRatio: '{{aspectRatio}}',
      resolution: '{{resolution}}', duration: '{{duration}}', images: '{{imageUrls}}',
      audios: '{{audioUrls}}', replyType: 'async' },
  },
  response: { type: 'json', taskIdPath: 'id', errorPath: 'error' },
  poll: {
    method: 'GET', path: '/v1/api/result?id={{submit.id}}', pathMode: 'origin',
    intervalMs: 5000, maxAttempts: 360, maxDurationMs: 30 * 60 * 1000,
    response: { statusPath: 'status', successValues: ['succeeded'], failureValues: ['failed', 'violation'],
      result: { urlPath: 'results.*.url' }, errorPath: 'error', progressPath: 'progress' },
  },
};

export const GRSAI_ADDED_MODELS: readonly ProviderModelSelection[] = [
  ...[
    ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'], ['gemini-3.7-flash', 'Gemini 3.7 Flash'], ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
  ].map(([id, name]): ProviderModelSelection => ({ id, name, provider: 'grsai', category: 'text',
    description: 'GRSAI OpenAI 兼容对话模型', executionProfile: { preset: 'openai-chat' } })),
  ...[
    ['nano-banana-2.1', 'Nano Banana 2.1', '新一代图片生成与编辑，支持 1K/2K/4K'],
    ['gpt-image-2.5', 'GPT Image 2.5', '图片生成与编辑，仅支持 1K'],
    ['gpt-image-2.6', 'GPT Image 2.6', '1K 基础款；当前仅开放已确认的正方形与 auto 质量'],
    ['gpt-image-2.5-flare', 'GPT Image 2.5 Flare', '支持 1K/2K/4K；官方当前维护中（2026-10-07）'],
    ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '支持 1K/2K/4K；官方当前维护中（2026-10-07）'],
  ].map(([id, name, description]): ProviderModelSelection => ({ id, name, description, provider: 'grsai', category: 'image' })),
  { id: 'minimax-h3', name: 'MiniMax H3', provider: 'grsai', category: 'video',
    description: '1–15 秒，1080p 最长 10 秒；最多 9 张参考图、3 段参考音频',
    videoCapability: getGrsaiVideoCapability('minimax-h3') },
];
