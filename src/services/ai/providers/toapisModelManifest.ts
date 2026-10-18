/** ToAPIs 目录合同。仅绑定已核对的渠道协议，不按同名官方模型推断能力。
 * 资料入口：https://docs.toapis.com/docs/cn/api-reference/models（2026-10-18）。
 * 远端 /models 决定当前站点与 Key 的可用型号；此处不包含凭据或站点自动回退。
 */
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability, NormalizedModelExecutionProtocol, ProtocolJsonValue, VideoModelCapability } from '../../../types/aiTypes';
import type { ModelProtocolVariables } from '../modelProtocol';
import type { CanonicalVideoRequest } from '../videoRequestResolver';

export const TOAPIS_TEXT_MODEL_IDS = [
  'gemini-3.8-flash', 'gemini-4-argon', 'qwen3.8-flash', 'deepseek-v4.1-flash',
  'gpt-6.1-sol', 'grok-4.7', 'qwen3.8-27b', 'claude-opus-5-5', 'glm-5.3-flash',
] as const;

const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];
const WIDE_RATIOS = [...RATIOS, '21:9', '9:21'];
const GPT_RATIOS = [...RATIOS, '5:4', '4:5', '2:1', '1:2', '21:9', '9:21'];
const BANANA_RATIOS = [...RATIOS, '5:4', '4:5', '21:9'];
const BANANA_WIDE_RATIOS = [...BANANA_RATIOS, '1:4', '4:1', '1:8', '8:1'];
const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const SEEDANCE_RATIOS = [...VIDEO_RATIOS, '21:9', 'adaptive'];
type Body = Record<string, ProtocolJsonValue>;

function definedBody(values: ModelProtocolVariables): Body {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, ProtocolJsonValue] => entry[1] !== undefined));
}

function asyncProtocol(path: string, body: Body, options: {
  pollPath?: string; taskIdPath?: string; urlPath?: string; mimeType?: string;
} = {}): NormalizedModelExecutionProtocol {
  const taskIdPath = options.taskIdPath || 'id';
  return {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path, bodyEncoding: 'json', body },
    response: { type: 'json', taskIdPath, errorPath: 'error.message' },
    poll: {
      method: 'GET', path: `${options.pollPath || path}/{{submit.${taskIdPath}}}`,
      intervalMs: 10_000, maxDurationMs: 3_600_000,
      response: {
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed', 'cancelled'],
        progressPath: 'progress', errorPath: 'error.message',
        result: { urlPath: options.urlPath || 'result.data.*.url', ...(options.mimeType ? { mimeType: options.mimeType } : {}) },
      },
      retry: { httpStatuses: [408, 429, 500, 502, 503, 504], maxRetries: 3,
        backoff: 'exponential', maxDelayMs: 60_000, honorRetryAfter: true, retryNetworkErrors: true },
    },
  };
}

function images(ids: string[], capability: ImageModelCapability, overrides: ModelProtocolVariables = {}): ProviderModelSelection[] {
  const body = definedBody({ model: '{{model}}', prompt: '{{prompt}}', n: '{{n}}',
    size: '{{aspectRatio}}', image_urls: '{{imageUrls}}', ...overrides });
  return ids.map((id) => ({ id, name: id, provider: 'toapis', category: 'image',
    description: 'ToAPIs 异步图片任务；本地参考图先上传至所选站点',
    inputModalities: ['text', 'image'],
    imageCapability: { supportsImageReference: true, supportsDataUrlReference: false,
      supportsBatch: false, maxBatchCount: 1, defaultRatio: '1:1', ...capability },
    executionProfile: { preset: 'custom', protocol: asyncProtocol('/images/generations', body) },
  }));
}

// VIP / official 的 size 是合法像素，而普通版 size 是比例。尺寸表只用于前者。
const GPT_PIXEL_SIZES: NonNullable<ImageModelCapability['dimensionPresets']> = {
  '1K': { '1:1': [1024, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536],
    '4:3': [1024, 768], '3:4': [768, 1024], '5:4': [1280, 1024], '4:5': [1024, 1280],
    '16:9': [1536, 864], '9:16': [864, 1536], '21:9': [2016, 864] },
  '2K': { '1:1': [2048, 2048], '3:2': [2048, 1360], '2:3': [1360, 2048],
    '4:3': [2048, 1536], '3:4': [1536, 2048], '5:4': [2560, 2048], '4:5': [2048, 2560],
    '16:9': [2048, 1152], '9:16': [1152, 2048], '21:9': [2688, 1152] },
  '4K': { '1:1': [2880, 2880], '3:2': [3520, 2336], '2:3': [2336, 3520],
    '4:3': [3312, 2480], '3:4': [2480, 3312], '5:4': [3216, 2576], '4:5': [2576, 3216],
    '16:9': [3840, 2160], '9:16': [2160, 3840], '21:9': [3840, 1648] },
};
const K_RESOLUTIONS = { resolutions: ['1K', '2K', '4K'], defaultResolution: '1K' };
const METADATA_RESOLUTION: Body = { metadata: { resolution: '{{imageSize}}' } };

const IMAGE_MODELS: ProviderModelSelection[] = [
  ...images(['gpt-image-2', 'gpt-image-2-vip'], {
    resolutions: ['1k', '2k', '4k'], defaultResolution: '1k', ratios: GPT_RATIOS,
    maxImageReferences: 14, supportsBatch: true, maxBatchCount: 8,
  }, { resolution: '{{imageSize}}', reference_images: '{{imageUrls}}', image_urls: undefined }),
  ...images(['gpt-image-2-official'], { ...K_RESOLUTIONS, ratios: GPT_RATIOS,
    maxImageReferences: 16, supportsBatch: true, maxBatchCount: 4,
  }, { resolution: '{{imageSize}}' }),
  ...images(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], {
    ...K_RESOLUTIONS, ratios: BANANA_RATIOS,
  }, { resolution: '{{imageSize}}', quality: 'high', reference_images: '{{imageUrls}}', image_urls: undefined }),
  ...images(['gpt-image-2.5-flare-vip', 'gpt-image-2.5-sunburst-vip',
    'gpt-image-2.5-flare-official', 'gpt-image-2.5-sunburst-official'], {
    ...K_RESOLUTIONS, ratios: BANANA_RATIOS, dimensionPresets: GPT_PIXEL_SIZES,
  }, { size: '{{size}}', quality: 'high' }),
  ...images(['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1-vip', 'gemini-nano-banana-2.1-official'], {
    ...K_RESOLUTIONS, ratios: BANANA_WIDE_RATIOS, maxImageReferences: 14,
  }, METADATA_RESOLUTION),
  ...images(['gemini-3.1-flash-image-preview'], {
    resolutions: ['0.5K', '1K', '2K', '4K'], defaultResolution: '1K', ratios: BANANA_WIDE_RATIOS, maxImageReferences: 6,
  }, METADATA_RESOLUTION),
  ...images(['gemini-3.1-flash-image-preview-vip', 'gemini-3.1-flash-image-official'], {
    ...K_RESOLUTIONS,
    ratios: BANANA_WIDE_RATIOS, maxImageReferences: 14,
  }, METADATA_RESOLUTION),
  ...images(['gemini-3-pro-image-preview'], {
    ...K_RESOLUTIONS, ratios: BANANA_RATIOS, maxImageReferences: 6,
  }, METADATA_RESOLUTION),
  ...images(['gemini-3-pro-image-preview-vip', 'gemini-3-pro-image-official'], {
    ...K_RESOLUTIONS, ratios: BANANA_RATIOS, maxImageReferences: 14,
  }, METADATA_RESOLUTION),
  ...images(['gemini-2.5-flash-image-preview', 'gemini-2.5-flash-image-official'], {
    ratios: RATIOS, maxImageReferences: 14, hasResolutionField: false,
  }),
  ...images(['qwen-image-3.0', 'qwen-image-3.0-pro'], {
    resolutions: ['1K', '2K'], defaultResolution: '1K', ratios: RATIOS, maxImageReferences: 3,
  }, { resolution: '{{imageSize}}' }),
  ...images(['doubao-seedream-4-0'], {
    ...K_RESOLUTIONS, defaultResolution: '2K',
    ratios: WIDE_RATIOS, maxImageReferences: 10, supportsBatch: true, maxBatchCount: 8,
  }, METADATA_RESOLUTION),
  ...images(['doubao-seedream-4-5'], {
    resolutions: ['2K', '4K'], defaultResolution: '2K',
    ratios: WIDE_RATIOS, maxImageReferences: 10, supportsBatch: true, maxBatchCount: 8,
  }, METADATA_RESOLUTION),
  ...images(['doubao-seedream-5-0'], {
    resolutions: ['2K', '3K'], defaultResolution: '2K', ratios: WIDE_RATIOS,
    maxImageReferences: 10, supportsBatch: true, maxBatchCount: 8,
  }, METADATA_RESOLUTION),
  ...images(['doubao-seedream-5-0-pro'], {
    resolutions: ['1K', '2K'], defaultResolution: '1K', ratios: WIDE_RATIOS,
    maxImageReferences: 10, supportsBatch: true, maxBatchCount: 8,
  }, METADATA_RESOLUTION),
  ...images(['flux-kontext-pro', 'flux-kontext-max'], {
    ratios: WIDE_RATIOS, maxImageReferences: 1, hasResolutionField: false,
  }, { n: 1 }),
  ...images(['flux-2-pro', 'flux-2-flex'], {
    ratios: RATIOS, maxImageReferences: 8, hasResolutionField: false,
  }, { n: 1 }),
  ...images(['vidu-image', 'viduq3-fast', 'viduq2-pro'], {
    ...K_RESOLUTIONS, ratios: RATIOS, maxImageReferences: 7,
  }, METADATA_RESOLUTION),
  ...images(['viduq2-fast'], {
    resolutions: ['1K'], defaultResolution: '1K', ratios: RATIOS, maxImageReferences: 7,
  }, METADATA_RESOLUTION),
];

/** 保留数组元素与角色，不把第二张普通参考图当成尾帧。 */
const videoRoles = [{ $forEach: '{{referenceVideoUrls}}', $value: { url: '{{referenceVideoUrls}}', role: 'reference_video' } }];
const audioRoles = [{ $forEach: '{{referenceAudioUrls}}', $value: { url: '{{referenceAudioUrls}}', role: 'reference_audio' } }];
const videoList = [{ $forEach: '{{referenceVideoUrls}}', $value: { video_url: '{{referenceVideoUrls}}' } }];
const firstFrame = [{ $whenPresent: '{{firstImage}}', $value: '{{firstImage}}' }];
const framePair = [...firstFrame, { $whenPresent: '{{lastImage}}', $value: '{{lastImage}}' }];
const klingImages: ProtocolJsonValue[] = [
  { $forEach: '{{referenceImageUrls}}', $value: { image_url: '{{referenceImageUrls}}' } },
  { $whenPresent: '{{firstImage}}', $value: { image_url: '{{firstImage}}', type: 'first_frame' } },
  { $whenPresent: '{{lastImage}}', $value: { image_url: '{{lastImage}}', type: 'end_frame' } },
];
const FRAME_RATIOS: Pick<VideoModelCapability, 'inputModeCapabilities'> = {
  inputModeCapabilities: {
    text: { ratios: SEEDANCE_RATIOS.filter((ratio) => ratio !== 'adaptive'), defaultRatio: '16:9' },
    keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
  },
};

function videos(ids: string[], capability: VideoModelCapability, overrides: ModelProtocolVariables = {}, path = '/videos/generations'): ProviderModelSelection[] {
  return ids.map((id) => ({ id, name: id, provider: 'toapis', category: 'video',
    description: id.startsWith('kling-') && id !== 'kling-3.0-turbo'
      ? 'ToAPIs 异步视频任务；std/pro 档位分别表示 720P/1080P' : 'ToAPIs 异步视频任务',
    videoCapability: { operations: ['text-to-video', 'image-to-video'], maxVideoReferences: 0, maxAudioReferences: 0, ...capability },
    executionProfile: { preset: 'custom', protocol: asyncProtocol(path, definedBody({
      model: '{{model}}', prompt: '{{prompt}}', duration: '{{duration}}',
      aspect_ratio: '{{aspectRatio}}', resolution: '{{resolution}}', ...overrides,
    }), { mimeType: 'video/mp4' }) },
  }));
}

const VIDEO_MODELS: ProviderModelSelection[] = [
  ...videos(['seedance-2', 'seedance-2-fast', 'seedance-2-mini'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], resolutions: ['480p', '720p'], defaultResolution: '720p',
    ratios: SEEDANCE_RATIOS, defaultRatio: '16:9', ...FRAME_RATIOS,
    minDuration: 4, maxDuration: 15, defaultDuration: 5, supportsAudio: true,
    supportsStandaloneAudio: false, allowFrameAndReferenceMix: false,
    maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3,
  }, { image_with_roles: '{{imageWithRoles}}', video_with_roles: videoRoles, audio_with_roles: audioRoles, generate_audio: '{{generateAudio}}' }),
  ...videos(['seedance-2-5'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
    ratios: SEEDANCE_RATIOS, defaultRatio: '16:9', ...FRAME_RATIOS,
    minDuration: 4, maxDuration: 30, automaticDurationValue: -1, defaultDuration: 5,
    supportsAudio: true, supportsStandaloneAudio: true, allowFrameAndReferenceMix: false,
    maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10,
  }, { image_with_roles: '{{imageWithRoles}}', video_with_roles: videoRoles, audio_with_roles: audioRoles, generate_audio: '{{generateAudio}}' }),
  ...videos(['seedance-2.5-ext'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], resolutions: ['720p'], defaultResolution: '720p',
    ratios: VIDEO_RATIOS, defaultRatio: '16:9', minDuration: 10, maxDuration: 30, defaultDuration: 10,
    maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10, supportsStandaloneAudio: false,
  }, { reference_images: '{{referenceImageUrls}}', video_with_roles: videoRoles, audio_with_roles: audioRoles }),
  ...videos(['seedance-2-fast-ext'], {
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', ratios: VIDEO_RATIOS, defaultRatio: '16:9',
    durations: [5, 10, 15], defaultDuration: 5, maxImageReferences: 9,
  }, { reference_images: '{{referenceImageUrls}}' }),
  ...videos(['MiniMax-H3', 'MiniMax-H3-Max'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    resolutions: ['768p', '2K'], defaultResolution: '2K', ratios: SEEDANCE_RATIOS, defaultRatio: '16:9', ...FRAME_RATIOS,
    minDuration: 4, maxDuration: 15, defaultDuration: 5, maxImageReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3,
    supportsStandaloneAudio: false, allowFrameAndReferenceMix: false,
  }, { image_with_roles: '{{imageWithRoles}}', video_with_roles: videoRoles, audio_with_roles: audioRoles }),
  ...videos(['MiniMax-H3-Max-Turbo'], {
    resolutions: ['480P', '768P'], defaultResolution: '768P', ratios: SEEDANCE_RATIOS, defaultRatio: '16:9', ...FRAME_RATIOS,
    minDuration: 5, maxDuration: 15, defaultDuration: 5, maxImageReferences: 2, allowFrameAndReferenceMix: false,
  }, { image_with_roles: '{{imageWithRoles}}' }),
  ...videos(['wan3.0-video'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], resolutions: ['480p', '720p', '1080p'], defaultResolution: '1080p',
    ratios: [...VIDEO_RATIOS, 'adaptive'], defaultRatio: '16:9', minDuration: 2, maxDuration: 30, defaultDuration: 5, automaticDurationValue: -1,
    maxImageReferences: 10, maxVideoReferences: 5, maxAudioReferences: 5, supportsAudio: true, allowFrameAndReferenceMix: false,
    inputConstraints: { referenceVideo: { totalDurationSeconds: { max: 15 } }, referenceAudio: { totalDurationSeconds: { max: 15 } } },
  }, { image_with_roles: '{{imageWithRoles}}', reference_images: '{{referenceImageUrls}}',
    video_list: videoList, audio_with_roles: audioRoles, audio: '{{generateAudio}}' }),
  ...videos(['kling-v2-6', 'kling-v3'], {
    resolutions: ['std', 'pro'], defaultResolution: 'std', ratios: ['16:9', '9:16', '1:1'], defaultRatio: '16:9',
    minDuration: 3, maxDuration: 15, defaultDuration: 5, supportsAudio: true,
  }, { mode: '{{resolution}}', resolution: undefined, image_with_roles: '{{imageWithRoles}}', audio: '{{generateAudio}}' }),
  ...videos(['kling-3.0-turbo'], {
    resolutions: ['720p', '1080p'], defaultResolution: '720p', ratios: ['16:9', '9:16', '1:1'], defaultRatio: '16:9',
    minDuration: 3, maxDuration: 15, defaultDuration: 5, maxImageReferences: 1,
  }, { reference_images: firstFrame }),
  ...videos(['kling-v3-omni', 'kling-video-o1'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], maxVideoReferences: 1,
    resolutions: ['std', 'pro'], defaultResolution: 'std', ratios: ['16:9', '9:16', '1:1'], defaultRatio: '16:9',
    minDuration: 3, maxDuration: 15, defaultDuration: 5,
  }, { resolution: undefined, mode: '{{resolution}}', video_list: videoList, metadata: { image_list: klingImages } }),
  ...videos(['doubao-seedance-1-0-pro-fast', 'doubao-seedance-1-0-pro-quality'], {
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', ratios: [...VIDEO_RATIOS, '21:9'], defaultRatio: '16:9',
    minDuration: 2, maxDuration: 12, defaultDuration: 5, maxImageReferences: 3,
  }, { image_with_roles: '{{imageWithRoles}}' }),
  ...videos(['doubao-seedance-1-5-pro'], {
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p', ratios: [...VIDEO_RATIOS, '21:9'], defaultRatio: '16:9',
    minDuration: 4, maxDuration: 12, defaultDuration: 5, maxImageReferences: 2, supportsAudio: true,
  }, { resolution: undefined, image_with_roles: '{{imageWithRoles}}', metadata: { resolution: '{{resolution}}', audio: '{{generateAudio}}' } }),
  ...videos(['veo3.1-fast', 'veo3.1-quality', 'veo3.1-lite'], {
    ratios: ['16:9', '9:16'], defaultRatio: '16:9', durations: [8], defaultDuration: 8,
  }, { image_urls: '{{imageUrls}}' }),
  ...videos(['Veo3.1-fast-official', 'Veo3.1-quality-official', 'Veo3.1-lite-official'], {
    resolutions: ['720p', '1080p', '4k'], defaultResolution: '720p', ratios: ['16:9', '9:16'], defaultRatio: '16:9',
    durations: [4, 6, 8], defaultDuration: 8, maxImageReferences: 3, supportsAudio: true, allowFrameAndReferenceMix: false,
  }, { size: '{{aspectRatio}}', image_urls: firstFrame,
    metadata: { lastFrame: '{{lastImage}}', referenceImages: '{{referenceImageUrls}}', generateAudio: '{{generateAudio}}' } }),
  ...videos(['sora-2-official'], {
    ratios: ['16:9', '9:16'], defaultRatio: '9:16', durations: [4, 8, 12], defaultDuration: 4, maxImageReferences: 1,
  }, { image_urls: firstFrame }),
  ...videos(['MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast'], {
    resolutions: ['768P', '1080P'], defaultResolution: '768P', durations: [6, 10], defaultDuration: 6, maxImageReferences: 2,
  }, { image_urls: firstFrame, metadata: { last_frame_image: '{{lastImage}}' } }),
  ...videos(['wan2.6', 'wan2.6-flash'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    resolutions: ['720p', '1080p'], defaultResolution: '1080p', ratios: VIDEO_RATIOS, defaultRatio: '16:9',
    durations: [5, 10, 15], defaultDuration: 5, maxImageReferences: 1, supportsAudio: true,
  }, { image_urls: firstFrame, metadata: { reference_urls: '{{referenceVideoUrls}}' }, audio: '{{generateAudio}}' }),
  ...videos(['gemini-omni-1.1-flash-preview'], {
    resolutions: ['720p'], defaultResolution: '720p', ratios: ['16:9', '9:16'], defaultRatio: '16:9',
    durations: [10], defaultDuration: 10, maxImageReferences: 5,
  }, { image_urls: '{{referenceImageUrls}}' }, '/videos'),
  ...videos(['gemini-omni-1.1-flash-preview-vip'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], maxVideoReferences: 1,
    resolutions: ['360p', '720p', '1080p', '4k'], defaultResolution: '720p', ratios: ['16:9', '9:16'], defaultRatio: '16:9',
    durations: [4, 6, 8, 10], defaultDuration: 6, maxImageReferences: 3,
  }, { generation_type: '{{parameters.generationType}}', image_urls: '{{imageUrls}}', video_urls: '{{videoUrls}}' }, '/videos'),
  ...videos(['gemini-omni-flash-preview-official', 'gemini-omni-1.1-flash-preview-official'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], maxVideoReferences: 3,
    resolutions: ['360p', '720p', '1080p', '4K'], defaultResolution: '720p', ratios: ['16:9', '9:16'], defaultRatio: '16:9',
    minDuration: 3, maxDuration: 10, defaultDuration: 6, maxImageReferences: 10,
  }, { image_urls: '{{referenceImageUrls}}', video_list: videoList }),
  ...videos(['viduq3', 'viduq3-pro', 'viduq3-turbo'], {
    resolutions: ['540p', '720p', '1080p'], defaultResolution: '720p', ratios: ['16:9', '9:16', '1:1'], defaultRatio: '16:9',
    minDuration: 1, maxDuration: 16, defaultDuration: 5, maxImageReferences: 2, supportsAudio: true,
  }, { image_urls: '{{imageUrls}}', audio: '{{generateAudio}}' }),
  ...videos(['viduq3-pro-fast'], {
    operations: ['image-to-video'], requiresReference: true, resolutions: ['720P', '1080P'], defaultResolution: '720P',
    defaultDuration: 5, maxImageReferences: 1, supportsAudio: true,
  }, { image_urls: firstFrame, audio: '{{generateAudio}}' }),
  ...videos(['viduq4-preview'], {
    operations: ['image-to-video'], requiresReference: true, resolutions: ['540p', '720p', '1080p', '2K', '4K'], defaultResolution: '720p',
    ratios: VIDEO_RATIOS, defaultRatio: '16:9', minDuration: 3, maxDuration: 16, defaultDuration: 5,
    maxImageReferences: 15, maxAudioReferences: 3, supportsAudio: true, supportsStandaloneAudio: false,
  }, { image_urls: '{{imageUrls}}', video_generation_mode: '{{parameters.generationMode}}',
    audio: '{{generateAudio}}', metadata: { sounds: '{{audioUrls}}' } }),
  ...videos(['grok-video-1.0', 'grok-video-1.5'], {
    resolutions: ['480p', '720p'], defaultResolution: '720p', ratios: ['16:9', '9:16', '1:1', '3:2', '2:3'], defaultRatio: '16:9',
    minDuration: 1, maxDuration: 15, defaultDuration: 8, maxImageReferences: 7,
  }, { image: '{{firstImage}}', reference_images: '{{referenceImageUrls}}', video_generation_mode: '{{parameters.generationMode}}' }),
  ...videos(['happyhorse-1.1'], {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], resolutions: ['720P', '1080P'], defaultResolution: '1080P',
    ratios: VIDEO_RATIOS, defaultRatio: '16:9', minDuration: 3, maxDuration: 15, defaultDuration: 5,
    maxImageReferences: 9, maxVideoReferences: 1, allowFrameAndReferenceMix: false,
  }, { action: '{{parameters.action}}', image_urls: firstFrame, reference_images: '{{referenceImageUrls}}', url: '{{referenceVideoUrl}}' }),
];

// 同系列仍按文档区分不同 SKU，而不是套一份完整官方能力。
for (const model of VIDEO_MODELS) {
  const capability = model.videoCapability!;
  if (model.id === 'seedance-2') capability.resolutions = ['480p', '720p', '1080p', '4k'];
  if (model.id === 'seedance-2' || model.id === 'seedance-2-fast') capability.automaticDurationValue = -1;
  if (model.id === 'seedance-2' || model.id === 'seedance-2-fast') {
    capability.maxVideoReferences = undefined;
    capability.maxAudioReferences = undefined;
  }
  if (model.id === 'MiniMax-H3-Max') Object.assign(capability, { resolutions: ['480P', '768P'], defaultResolution: '768P', minDuration: 5 });
  if (model.id === 'kling-v2-6') Object.assign(capability, { durations: [5, 10], minDuration: undefined, maxDuration: undefined });
  if (model.id === 'kling-video-o1') capability.maxDuration = 10;
  if (model.id === 'kling-v3-omni' && model.executionProfile?.protocol) {
    capability.supportsAudio = true;
    model.executionProfile.protocol.submit.body = { ...(model.executionProfile.protocol.submit.body as Body), audio: '{{generateAudio}}' };
  }
  if (model.id === 'MiniMax-Hailuo-2.3-Fast') Object.assign(capability, { operations: ['image-to-video'], requiresReference: true, maxImageReferences: 1 });
  if (model.id === 'MiniMax-Hailuo-2.3') capability.maxImageReferences = 1;
  if (model.id === 'wan2.6-flash') Object.assign(capability, { operations: ['image-to-video', 'video-to-video'], requiresReference: true });
  if (model.id === 'wan2.6' || model.id === 'wan2.6-flash') capability.maxVideoReferences = 3;
  if (model.id === 'gemini-omni-flash-preview-official') Object.assign(capability, { resolutions: ['720p'], durations: [4, 6, 8, 10], minDuration: undefined, maxDuration: undefined });
  if (model.id === 'Veo3.1-lite-official') Object.assign(capability, { resolutions: ['720p'], defaultResolution: '720p' });
  if (model.id === 'viduq3') Object.assign(capability, { minDuration: 3, maxImageReferences: 7, operations: ['image-to-video'], requiresReference: true });
  if (model.id === 'viduq3-pro' || model.id === 'viduq3-turbo') model.executionProfile!.protocol!.submit.body = {
    ...(model.executionProfile!.protocol!.submit.body as Body), image_urls: framePair,
  };
  if (model.id === 'grok-video-1.0') capability.maxImageReferences = 8;
}

export const TOAPIS_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  ...TOAPIS_TEXT_MODEL_IDS.map((id): ProviderModelSelection => ({ id, name: id, provider: 'toapis', category: 'text',
    inputModalities: ['text'], executionProfile: { preset: 'openai-chat' } })),
  ...IMAGE_MODELS, ...VIDEO_MODELS,
  { id: 'suno', name: 'Suno 音乐', provider: 'toapis', category: 'audio',
    description: 'Suno 灵感模式；每次返回两首候选，当前音频节点采用首个结果',
    executionProfile: { preset: 'custom', protocol: asyncProtocol('/music/generations/generation', {
      model: '{{model}}', custom: false, gpt_description: '{{prompt}}',
    }, { taskIdPath: 'task_id', pollPath: '/music/tasks', urlPath: 'result.music.*.audio_url', mimeType: 'audio/mpeg' }) },
  },
];
const MODEL_BY_ID = new Map(TOAPIS_MODEL_MANIFEST.map((model) => [model.id, model]));

/** 仅匹配已适配合同及指定的九个文本 ID；绝不把目录中的未知媒体当作通用文本。 */
export function matchToapisCatalog(models: readonly ProviderModelSelection[]): ProviderModelSelection[] {
  return models.flatMap((remote) => {
    const known = MODEL_BY_ID.get(remote.id);
    return known ? [{ ...remote, ...structuredClone(known), provider: remote.provider,
      inputModalities: known.category === 'text' ? remote.inputModalities ?? known.inputModalities : known.inputModalities,
    }] : [];
  });
}

export function assertToapisImageInput(modelId: string, referenceCount: number, count: number): void {
  if (['doubao-seedream-4-0', 'doubao-seedream-4-5', 'doubao-seedream-5-0', 'doubao-seedream-5-0-pro'].includes(modelId)
    && referenceCount + count > 15) {
    throw new Error(`ToAPIs 模型“${modelId}”的参考图与输出图片合计最多 15 张，当前为 ${referenceCount} + ${count} 张`);
  }
}

/** Gemini 普通/VIP 文档使用 {url} 元素，official 与其他图片渠道使用字符串 URL。 */
export function toapisImageReferences(modelId: string, urls: readonly string[]): ProtocolJsonValue | undefined {
  if (!urls.length) return undefined;
  return ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image-preview-vip',
    'gemini-3-pro-image-preview', 'gemini-3-pro-image-preview-vip', 'gemini-2.5-flash-image-preview'].includes(modelId)
    ? urls.map((url) => ({ url })) : [...urls];
}

/** 渠道特有组合约束，在上传素材和提交付费任务前执行。 */
export function assertToapisVideoInput(request: CanonicalVideoRequest): void {
  const { modelId: id, references: refs, output } = request;
  const first = refs.images.filter((item) => item.role === 'first_frame');
  const last = refs.images.filter((item) => item.role === 'last_frame');
  const ordinary = refs.images.filter((item) => item.role === 'reference');
  const fail = (reason: string): never => { throw new Error(`ToAPIs 模型“${id}”：${reason}。本次尚未提交生成请求`); };
  if (last.length && !first.length) fail('尾帧必须与首帧一起设置');
  if (id.startsWith('MiniMax-H3') && refs.counts.total > 12) fail('图片、视频和音频参考素材合计最多 12 个');
  const framesOnly = ['MiniMax-H3-Max-Turbo', 'MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3',
    'MiniMax-Hailuo-2.3-Fast', 'kling-3.0-turbo', 'sora-2-official', 'viduq3-pro', 'viduq3-turbo', 'viduq3-pro-fast', 'wan2.6', 'wan2.6-flash'];
  if (framesOnly.includes(id) && ordinary.length) fail('图片输入只支持首帧控制，请在视频参数的“参考帧”中指定首帧，不要使用普通参考图');
  const referenceOnly = ['seedance-2.5-ext', 'seedance-2-fast-ext', 'gemini-omni-1.1-flash-preview',
    'gemini-omni-flash-preview-official', 'gemini-omni-1.1-flash-preview-official', 'viduq3',
    'veo3.1-fast', 'veo3.1-quality', 'veo3.1-lite'];
  if (referenceOnly.includes(id) && (first.length || last.length)) fail('该渠道仅接收普通参考图，请移除首帧/尾帧角色后改用参考图');
  const firstOnly = ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'kling-3.0-turbo', 'sora-2-official', 'viduq3-pro-fast', 'wan2.6', 'wan2.6-flash'];
  if (firstOnly.includes(id) && last.length) fail('该渠道不支持尾帧，请移除尾帧');
  if ((id === 'wan2.6' || id === 'wan2.6-flash') && refs.images.length && refs.videos.length) fail('首帧和参考视频不能同时使用');
  if (id.startsWith('MiniMax-Hailuo') && output.resolutionPreset?.toLowerCase() === '1080p' && output.durationSeconds !== 6) fail('1080P 仅支持 6 秒，请修改时长或选择 768P');
  if (id === 'kling-v2-6' && output.resolutionPreset === 'std' && output.audio.policy === 'generate') fail('std 档仅支持静音，请选择 pro 或关闭音频');
  if (id === 'kling-v3-omni' && refs.videos.length && output.audio.policy === 'generate') fail('参考视频与音频生成开关不能同时开启');
  if (id === 'kling-video-o1' && refs.videos.length && (first.length || last.length)) fail('参考视频与首尾帧不能混用');
  if (id.startsWith('doubao-seedance-1-0-') && ordinary.length > 1) fail('该渠道最多接收一张普通参考图');
  if (id.startsWith('doubao-seedance-1-0-') && ordinary.length && output.resolutionPreset === '1080p') fail('普通参考图模式不支持 1080p，请选择 480p / 720p');
  if (id === 'doubao-seedance-1-0-pro-fast' && last.length) fail('fast 渠道不支持尾帧');
  if (id === 'doubao-seedance-1-5-pro' && ordinary.length) fail('该渠道只支持首尾帧，请在“参考帧”中指定图片角色');
  if (id === 'seedance-2.5-ext' && output.durationSeconds === 15 && (refs.videos.length || refs.audios.length || refs.images.length > 10)) fail('该素材组合不支持 15 秒，请修改时长');
  if (id === 'gemini-omni-1.1-flash-preview-vip') {
    if (last.length || first.length && ordinary.length) fail('首帧与参考图不能混用，也不支持尾帧');
    if (ordinary.length && ![1, 3].includes(ordinary.length)) fail('参考图模式只能传 1 或 3 张图片');
  }
  if (id === 'viduq4-preview' && last.length) fail('该渠道不支持尾帧');
  if (id === 'viduq4-preview' && first.length && (ordinary.length || refs.audios.length)) fail('首帧与参考图/音频不能混用');
  if (id === 'grok-video-1.5' && (last.length || first.length && ordinary.length)) fail('首帧与参考图不能混用，也不支持尾帧');
  if (id === 'grok-video-1.0' && last.length) fail('该渠道不支持尾帧');
  if (id === 'happyhorse-1.1' && last.length) fail('该渠道不支持尾帧');
  if (id === 'happyhorse-1.1' && refs.videos.length && ordinary.length > 5) fail('视频编辑最多搭配 5 张参考图');
}

/** 模式字段只由已解析的素材角色决定；不修改用户模型 ID，不让上游猜首尾帧。 */
export function toapisVideoVariables(request: CanonicalVideoRequest, variables: ModelProtocolVariables): ModelProtocolVariables {
  const { modelId: id, references: refs } = request;
  const hasFirst = refs.images.some((item) => item.role === 'first_frame');
  const result: ModelProtocolVariables = { ...variables, parameters: definedBody({
    generationType: refs.images.length ? hasFirst ? 'frame' : 'reference' : undefined,
    generationMode: id === 'viduq4-preview' ? hasFirst ? undefined : 'reference_images_to_video'
      : id === 'grok-video-1.5' ? hasFirst ? 'first_frame_image_to_video' : refs.images.length ? 'reference_images_to_video' : 'text_to_video' : undefined,
    action: refs.videos.length ? 'video-edit' : hasFirst ? 'image-to-video' : refs.images.length ? 'reference-to-video' : 'text-to-video',
  }) };
  if (id === 'wan3.0-video') {
    const frames = refs.images.filter((item) => item.role !== 'reference').map(({ url, role }) => ({ url, role }));
    result.imageWithRoles = frames.length ? frames : undefined;
  }
  if (id.startsWith('doubao-seedance-1-0-')) {
    result.imageWithRoles = refs.images.length ? refs.images.map(({ url, role }) => ({ url, role })) : undefined;
  }
  if (id === 'kling-v3-omni' || id === 'kling-video-o1') {
    const imageOrder = [
      ...refs.images.filter((item) => item.role === 'reference'),
      ...refs.images.filter((item) => item.role === 'first_frame'),
      ...refs.images.filter((item) => item.role === 'last_frame'),
    ];
    result.prompt = request.prompt.replace(/图片(\d+)/g, (original, number: string) =>
      refs.images[Number(number) - 1] ? `<<<image_${imageOrder.indexOf(refs.images[Number(number) - 1]) + 1}>>>` : original)
      .replace(/视频(\d+)/g, (original, number: string) => Number(number) <= refs.videos.length ? `<<<video_${number}>>>` : original);
  }
  // 这些渠道在视频参考/编辑时明确不接收用户输出时长或比例。
  if (id === 'gemini-omni-1.1-flash-preview-vip' && refs.videos.length) result.duration = undefined;
  if ((id === 'gemini-omni-flash-preview-official' || id === 'gemini-omni-1.1-flash-preview-official')
    && refs.videos.length) result.aspectRatio = undefined;
  if ((id.startsWith('wan2.6') || id === 'happyhorse-1.1') && hasFirst) result.aspectRatio = undefined;
  if (id === 'wan2.6-flash') result.aspectRatio = undefined;
  if (id === 'happyhorse-1.1' && refs.videos.length) result.duration = undefined;
  return result;
}
