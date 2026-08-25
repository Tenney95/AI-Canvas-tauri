/**
 * Sora2U 内置模型清单与声明式执行协议。
 *
 * 公开 API 的图片与视频模型共用 `/api/v1/videos` 异步任务端点；模型目录可在用户
 * 填写 Key 后动态刷新，本清单负责离线兜底并为同 ID 的远端模型补齐执行协议。
 */
import type { ProviderModelSelection } from '../../../types';
import type {
  NormalizedModelExecutionProtocol,
  VideoModelCapability,
} from '../../../types/aiTypes';

export const SORA2U_BASE_URL = 'https://sora2u.com';

const SORA2U_POLL_RETRY = {
  httpStatuses: [408, 429, 500, 502, 503, 504],
  maxRetries: 5,
  backoff: 'exponential' as const,
  maxDelayMs: 60_000,
  honorRetryAfter: true,
  retryNetworkErrors: true,
};

function createSora2uProtocol(resultPath: 'task.image_url' | 'task.video_url'):
NormalizedModelExecutionProtocol {
  return {
    version: 2,
    mode: 'async',
    auth: { type: 'bearer' },
    submit: {
      method: 'POST',
      path: '/api/v1/videos',
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
        reference_urls: resultPath === 'task.image_url'
          ? '{{imageUrls}}'
          : '{{referenceUrls}}',
        ...(resultPath === 'task.video_url'
          ? { references: '{{inlineReferences}}' }
          : {}),
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
const SORA2U_VIDEO_PROTOCOL = createSora2uProtocol('task.video_url');

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

const SEEDANCE_20_CAPABILITY = videoCapability(5, 15, {
  maxImageReferences: 9,
  maxVideoReferences: 3,
  maxAudioReferences: 3,
}, { supportsStandaloneAudio: true });

const SEEDANCE_25_CAPABILITY = videoCapability(5, 30, {
  maxImageReferences: 30,
  maxVideoReferences: 10,
  maxAudioReferences: 10,
}, { requiresReference: true, supportsStandaloneAudio: true, defaultDuration: 15 });

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
  videoModel('seedance-2.0', 'Seedance 2.0', SEEDANCE_20_CAPABILITY,
    'Sora2U 全模态视频模型，支持文生视频'),
  videoModel('seedance-2.0-character', 'Seedance 2.0 Character', SEEDANCE_20_CAPABILITY,
    'Sora2U 角色一致性全模态视频模型'),
  videoModel('seedance-2.0-character-mono', 'Seedance 2.0 Character Mono', SEEDANCE_20_CAPABILITY,
    'Sora2U 单角色一致性全模态视频模型'),
  videoModel('seedance-2.5', 'Seedance 2.5', SEEDANCE_25_CAPABILITY,
    'Sora2U 多模态参考视频模型，至少需要一份参考素材'),
  videoModel('seedance-2.5-character', 'Seedance 2.5 Character', SEEDANCE_25_CAPABILITY,
    'Sora2U 角色一致性多模态视频模型，至少需要一份参考素材'),
  videoModel('seedance-2.5-character-mono', 'Seedance 2.5 Character Mono', {
    ...SEEDANCE_25_CAPABILITY,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  }, 'Sora2U 单角色一致性多模态视频模型，至少需要一份参考素材'),
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
