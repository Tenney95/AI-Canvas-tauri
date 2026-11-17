/**
 * Sora2U 内置模型清单与声明式执行协议。
 *
 * 公开 API 的图片与视频模型共用 `/api/v1/videos` 异步任务端点；模型目录可在用户
 * 填写 Key 后动态刷新，本清单负责离线兜底并为同 ID 的远端模型补齐执行协议。
 */
import type { ProviderModelSelection } from '../../../types';
import type {
  ModelExecutionProfile,
  NormalizedModelExecutionProtocol,
  VideoModelCapability,
} from '../../../types/aiTypes';
import { getVideoCapabilityTemplate } from '../modelCapabilityTemplates';
import { comparableProtocol } from '../modelProtocol';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import { isRemoteMediaUrl } from '../../../utils/mediaUrl';

export const SORA2U_BASE_URL = 'https://sora2u.com';
export const SORA2U_IMAGE_REFERENCE_LIMIT = 4;
export const SORA2U_INLINE_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
export const SORA2U_REQUEST_QUERY = {
  utm_source: 'tenney',
  utm_medium: 'canvas',
  utm_content: 'wx',
} as const;

const SORA2U_POLL_RETRY = {
  httpStatuses: [408, 429, 500, 502, 503, 504],
  maxRetries: 5,
  backoff: 'exponential' as const,
  maxDelayMs: 60_000,
  honorRetryAfter: true,
  retryNetworkErrors: true,
};

function createSora2uProtocol(resultPath: 'task.image_url' | 'task.video_url', legacyImage = false):
NormalizedModelExecutionProtocol {
  return {
    version: 2,
    mode: 'async',
    auth: { type: 'bearer' },
    submit: {
      method: 'POST',
      path: '/api/v1/videos',
      query: { ...SORA2U_REQUEST_QUERY },
      bodyEncoding: 'json',
      body: {
        model: '{{model}}',
        prompt: '{{prompt}}',
        duration: '{{duration}}',
        aspect_ratio: '{{aspectRatio}}',
        resolution: resultPath === 'task.image_url'
          ? '{{imageSize}}'
          : '{{seedanceResolution}}',
        disable_audio: '{{disableAudio}}',
        reference_urls: legacyImage
          ? '{{imageUrls}}'
          : '{{referenceUrls}}',
        ...(!legacyImage ? { references: '{{inlineReferences}}' } : {}),
      },
    },
    response: {
      type: 'json',
      taskIdPath: 'task.id',
      errorPath: 'error.message',
    },
    poll: {
      method: 'GET',
      path: '/api/v1/videos/{{submit.task.id}}',
      query: { ...SORA2U_REQUEST_QUERY },
      response: {
        statusPath: 'task.status',
        successValues: ['completed'],
        failureValues: ['failed', 'canceled'],
        result: { urlPath: resultPath },
        errorPath: 'task.error',
        progressPath: 'task.progress',
      },
      intervalMs: 5_000,
      maxDurationMs: 3_600_000,
      retry: SORA2U_POLL_RETRY,
    },
  };
}

const SORA2U_IMAGE_PROTOCOL = createSora2uProtocol('task.image_url');
const SORA2U_LEGACY_IMAGE_PROTOCOL = createSora2uProtocol('task.image_url', true);
const SORA2U_VIDEO_PROTOCOL = createSora2uProtocol('task.video_url');

const SORA2U_VIDEO_INPUT_CONSTRAINTS: NonNullable<VideoModelCapability['inputConstraints']> = {
  promptMinCharacters: 10,
  maxBase64DecodedBytes: 20 * 1024 * 1024,
  referenceVideo: {
    width: { min: 300 },
    durationSeconds: { max: 15, maxExclusive: true },
  },
  referenceAudio: {
    durationSeconds: { min: 3, max: 15, maxExclusive: true },
  },
};

function integerDurations(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function videoCapability(
  minDuration: number,
  maxDuration: number,
  limits: Pick<VideoModelCapability,
    'maxImageReferences' | 'maxVideoReferences' | 'maxAudioReferences'>,
  extras: Partial<VideoModelCapability> = {},
): VideoModelCapability {
  return {
    durations: integerDurations(minDuration, maxDuration),
    minDuration,
    maxDuration,
    defaultDuration: minDuration,
    supportsAudio: true,
    inputConstraints: SORA2U_VIDEO_INPUT_CONSTRAINTS,
    ...limits,
    ...extras,
  };
}

function videoModel(
  id: string,
  name: string,
  capability: VideoModelCapability,
  description: string,
): ProviderModelSelection {
  return {
    id,
    name,
    category: 'video',
    provider: 'sora2u',
    description,
    videoCapability: capability,
    executionProfile: { preset: 'custom', protocol: SORA2U_VIDEO_PROTOCOL },
  };
}

function seedanceCapability(
  templateId: 'seedance-2.0' | 'seedance-2.5', extras: Partial<VideoModelCapability> = {},
): VideoModelCapability {
  const is25 = templateId === 'seedance-2.5';
  return getVideoCapabilityTemplate(templateId, {
    durations: integerDurations(5, is25 ? 30 : 15), minDuration: 5, defaultDuration: is25 ? 15 : 5,
    supportsStandaloneAudio: true, inputConstraints: SORA2U_VIDEO_INPUT_CONSTRAINTS,
    // 渠道未确认输出候选和首尾帧模式，不把官方模板的可选能力补到已有合同。
    operations: undefined, resolutions: undefined, defaultResolution: undefined,
    ratios: undefined, defaultRatio: undefined, automaticDurationValue: undefined,
    inputModeCapabilities: undefined, operationCapabilities: undefined,
    ...(is25 ? { requiresReference: true } : {}),
    ...extras,
  });
}

export const SORA2U_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  videoModel('seedance-1.5', 'Seedance 1.5', videoCapability(5, 12, {
    maxImageReferences: 1,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
  }, {
    requiresReference: true,
    ratios: ['9:16'],
    defaultRatio: '9:16',
    resolutions: ['720p'],
    defaultResolution: '720p',
    supportsAudio: false,
  }), 'Sora2U 图片驱动视频模型'),
  videoModel('seedance-2.0', 'Seedance 2.0', seedanceCapability('seedance-2.0', { maxVideoAudioReferences: 3 }),
    'Sora2U 全模态视频模型，支持文生视频'),
  videoModel('seedance-2.0-character', 'Seedance 2.0 Character', seedanceCapability('seedance-2.0', { maxVideoAudioReferences: 3 }),
    'Sora2U 角色一致性全模态视频模型'),
  videoModel('seedance-2.0-character-mono', 'Seedance 2.0 Character Mono', seedanceCapability('seedance-2.0'),
    'Sora2U 单角色一致性全模态视频模型'),
  videoModel('seedance-2.5', 'Seedance 2.5', seedanceCapability('seedance-2.5'),
    'Sora2U 多模态参考视频模型，至少需要一份参考素材'),
  videoModel('seedance-2.5-character', 'Seedance 2.5 Character', seedanceCapability('seedance-2.5'),
    'Sora2U 角色一致性多模态视频模型，至少需要一份参考素材'),
  videoModel('seedance-2.5-character-mono', 'Seedance 2.5 Character Mono', seedanceCapability('seedance-2.5', {
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  }), 'Sora2U 单角色一致性多模态视频模型，至少需要一份参考素材'),
  {
    id: 'gemini-image',
    name: 'Gemini Image',
    category: 'image',
    provider: 'sora2u',
    description: 'Sora2U Gemini 图片生成模型，支持最多 4 张参考图',
    inputModalities: ['text', 'image'],
    executionProfile: { preset: 'custom', protocol: SORA2U_IMAGE_PROTOCOL },
  },
  {
    id: 'kontext-image',
    name: 'Kontext Image',
    category: 'image',
    provider: 'sora2u',
    description: 'Sora2U Kontext 图片生成模型，支持最多 4 张参考图',
    inputModalities: ['text', 'image'],
    executionProfile: { preset: 'custom', protocol: SORA2U_IMAGE_PROTOCOL },
  },
];

/** 只识别完整内置新旧协议；改过路径、映射或恢复字段的用户协议不投影。 */
export function usesSora2uModelProtocol(modelId: string, profile: ModelExecutionProfile | undefined): boolean {
  const known = SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId);
  const actual = comparableProtocol(profile);
  return Boolean(known && actual && (actual === comparableProtocol(known.executionProfile)
    || known.category === 'image' && actual === comparableProtocol({ preset: 'custom', protocol: SORA2U_LEGACY_IMAGE_PROTOCOL })));
}

/** 仅新图片提交使用有效副本；不写回配置，也不重建历史任务的查询合同。 */
export function resolveSora2uImageExecutionProfile(modelId: string, profile: ModelExecutionProfile | undefined): ModelExecutionProfile | undefined {
  const known = SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId);
  return known?.category === 'image' && usesSora2uModelProtocol(modelId, profile)
    ? { ...profile, preset: 'custom', protocol: structuredClone(SORA2U_IMAGE_PROTOCOL) } : profile;
}

/** references 接收 data URL 字符串数组；reference_urls 只接 HTTPS，不使用对象式媒体块。 */
export function sora2uImageVariables(variables: ModelProtocolVariables): ModelProtocolVariables {
  const images = variables.imageUrls ?? [];
  if (!Array.isArray(images) || images.some((value) => typeof value !== 'string')) throw new Error('Sora2U 参考图片必须是地址数组');
  if (images.length > SORA2U_IMAGE_REFERENCE_LIMIT) throw new Error('Sora2U 图片模型最多支持 4 张参考图');
  const referenceUrls: string[] = [];
  const inlineReferences: string[] = [];
  let inlineBytes = 0;
  for (const image of images as string[]) {
    if (isRemoteMediaUrl(image) && /^https:\/\//i.test(image)) referenceUrls.push(image);
    else if (/^data:image\/[^;,]+;base64,/i.test(image)) {
      const payload = image.slice(image.indexOf(',') + 1).replace(/\s/g, '');
      inlineBytes += Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
      inlineReferences.push(image);
    } else throw new Error('Sora2U 参考图片须为 HTTPS 地址或已读取的图片 data URL，不会回退到图床');
  }
  if (inlineBytes > SORA2U_INLINE_REFERENCE_MAX_BYTES) throw new Error('Sora2U 内联参考图解码后合计不能超过 20 MiB');
  return { ...variables, referenceUrls: referenceUrls.length ? referenceUrls : undefined,
    inlineReferences: inlineReferences.length ? inlineReferences : undefined };
}

/** 旧模型记录也要补上已核实的联合名额，远端明确声明的值仍优先。 */
export function withSora2uReferenceLimits(
  modelId: string,
  capability: VideoModelCapability | undefined,
): VideoModelCapability | undefined {
  const maximum = capability?.maxVideoAudioReferences
    ?? SORA2U_MODEL_MANIFEST.find((model) => model.id === modelId)?.videoCapability?.maxVideoAudioReferences;
  return maximum === undefined ? capability : { ...capability, maxVideoAudioReferences: maximum };
}
