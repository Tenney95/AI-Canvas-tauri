/**
 * 声明 APIMart Seedance 视频模型能力表，并将通用生成参数映射为各模型请求字段。
 */
import type { VideoGenerationOperation, VideoModelCapability } from '../../types/aiTypes';
import { mapVideoParameters } from './videoParameterMappings';
import type { ProviderModelSelection } from '../../types';

export type ApimartSeedanceRatioField = 'aspect_ratio' | 'size';
export type ApimartSeedanceAudioField = 'audio' | 'generate_audio';

export interface ApimartSeedanceCapability {
  modelId: string;
  resolutions: readonly string[];
  defaultResolution: string;
  ratios: readonly string[];
  defaultRatio: string;
  ratioField: ApimartSeedanceRatioField;
  /** 只允许这几个时长（秒）；为空表示 min~max 连续可选 */
  durations?: number[];
  minDuration: number;
  maxDuration: number;
  defaultDuration: number;
  audioField?: ApimartSeedanceAudioField;
  defaultAudio?: boolean;
  operations: readonly VideoGenerationOperation[];
  maxImageReferences: number;
  maxVideoReferences?: number;
  maxAudioReferences?: number;
  /** MiniMax-H3 等模型用独立的首/尾帧字段（而非 image_urls 顺序推断）。 */
  frameFields?: {
    first: string;
    last: string;
  };
  /** 支持 AIGC 水印字段（watermark/aigc_watermark）。 */
  watermarkField?: 'watermark' | 'aigc_watermark';
  defaultWatermark?: boolean;
  /** Seedance 2.0/2.5 用 image_with_roles 数组传递首/尾帧（而非独立字段）。 */
  imageWithRoles?: boolean;
  /** Omni 使用独立的参考素材与时长合同，不套用 Seedance 首尾帧互斥规则。 */
  omniVariant?: 'flash' | 'ext' | 'preview';
  durationMode?: 'automatic' | 'without-video';
  inputConstraints?: VideoModelCapability['inputConstraints'];
}

export const APIMART_OMNI_MODELS: readonly ProviderModelSelection[] = [
  { id: 'gemini-omni-1.1-flash', name: 'Gemini Omni 1.1 Flash', category: 'video', provider: 'apimart',
    description: '最高 4K，时长自动；最多 10 张图片，支持首尾帧和单视频编辑' },
  { id: 'gemini-omni-1.1-flash-ext', name: 'Gemini Omni 1.1 Flash Ext', category: 'video', provider: 'apimart',
    description: '最高 4K，4/6/8/10 秒；1 或 3 张参考图，单视频参考时由模型决定时长' },
  { id: 'gemini-omni-flash-preview', name: 'Gemini Omni Flash Preview', category: 'video', provider: 'apimart',
    description: '720p，时长自动；最多 16 张参考图和 1 个参考视频' },
];

export function isLegacyApimartOmni(model: string): boolean {
  return model.replace(/^apimart\//i, '').toLowerCase() === 'omni-flash-ext';
}

/** 仅替换已选择的旧条目；保留其它模型和用户有意关闭的新模型。 */
export function replaceLegacyApimartOmni(
  models: ProviderModelSelection[] | undefined,
): ProviderModelSelection[] | undefined {
  const legacy = models?.find((model) => isLegacyApimartOmni(model.id));
  if (!models || !legacy) return models;
  const retained = models.filter((model) => !isLegacyApimartOmni(model.id));
  return [...retained, ...APIMART_OMNI_MODELS
    .filter((model) => !retained.some((item) => item.id.replace(/^apimart\//i, '') === model.id))
    .map((model) => ({ ...model, provider: legacy.provider }))];
}

export interface ApimartSeedanceRequestParams {
  resolution?: string;
  ratio?: string;
  duration?: number;
  generateAudio?: boolean;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  operation?: VideoGenerationOperation;
  /** MiniMax-H3 首帧图 URL（写入 first_frame_image）。 */
  firstFrameUrl?: string;
  /** MiniMax-H3 尾帧图 URL（写入 last_frame_image）。 */
  lastFrameUrl?: string;
  /** MiniMax-H3 是否添加 AIGC 水印。 */
  watermark?: boolean;
  /** Seedance 2.0/2.5 带角色的图片（写入 image_with_roles）：首帧 / 尾帧 / 参考图。 */
  imageWithRoles?: Array<{ url: string; role: 'first_frame' | 'last_frame' | 'reference_image' }>;
}

const COMMON_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const;
const SD_1_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const SD_2_RESOLUTIONS = ['480p', '720p'] as const;
// MiniMax-H3 分辨率（2K / 768P），宽高比不支持 adaptive，仅具体比例
const H3_RESOLUTIONS = ['2K', '768P'] as const;
const H3_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const;

const OMNI_CAPABILITY: ApimartSeedanceCapability = {
  modelId: 'gemini-omni-1.1-flash',
  resolutions: ['360p', '720p', '1080p', '4k'], defaultResolution: '720p',
  ratios: ['16:9', '9:16'], defaultRatio: '16:9', ratioField: 'aspect_ratio',
  minDuration: 3, maxDuration: 10, defaultDuration: 6,
  operations: ['text-to-video', 'image-to-video', 'video-to-video'],
  maxImageReferences: 10, maxVideoReferences: 1, maxAudioReferences: 0,
  frameFields: { first: 'first_frame_image', last: 'last_frame_image' },
  omniVariant: 'flash', durationMode: 'automatic',
  inputConstraints: { referenceVideo: { durationSeconds: { max: 10 } } },
};

const APIMART_SEEDANCE_CAPABILITIES: Record<string, ApimartSeedanceCapability> = {
  'gemini-omni-1.1-flash': OMNI_CAPABILITY,
  'gemini-omni-1.1-flash-ext': {
    ...OMNI_CAPABILITY, modelId: 'gemini-omni-1.1-flash-ext',
    omniVariant: 'ext', durationMode: 'without-video',
    inputConstraints: undefined,
    minDuration: 4, durations: [4, 6, 8, 10], maxImageReferences: 3,
  },
  'gemini-omni-flash-preview': {
    ...OMNI_CAPABILITY, modelId: 'gemini-omni-flash-preview',
    omniVariant: 'preview', resolutions: ['720p'], maxImageReferences: 16,
    inputConstraints: { referenceVideo: { durationSeconds: { min: 1, max: 24 } } },
  },
  'doubao-seedance-1-0-pro-fast': {
    modelId: 'doubao-seedance-1-0-pro-fast',
    resolutions: SD_1_RESOLUTIONS,
    defaultResolution: '1080p',
    ratios: COMMON_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'aspect_ratio',
    minDuration: 2,
    maxDuration: 12,
    defaultDuration: 5,
    operations: ['text-to-video', 'image-to-video'],
    maxImageReferences: 9,
  },
  'doubao-seedance-1-0-pro-quality': {
    modelId: 'doubao-seedance-1-0-pro-quality',
    resolutions: SD_1_RESOLUTIONS,
    defaultResolution: '1080p',
    ratios: COMMON_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'aspect_ratio',
    minDuration: 2,
    maxDuration: 12,
    defaultDuration: 5,
    operations: ['text-to-video', 'image-to-video'],
    maxImageReferences: 9,
  },
  'doubao-seedance-1-5-pro': {
    modelId: 'doubao-seedance-1-5-pro',
    resolutions: SD_1_RESOLUTIONS,
    defaultResolution: '720p',
    ratios: COMMON_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'aspect_ratio',
    minDuration: 4,
    maxDuration: 12,
    defaultDuration: 5,
    audioField: 'audio',
    defaultAudio: true,
    operations: ['text-to-video', 'image-to-video'],
    maxImageReferences: 9,
  },
  'doubao-seedance-2.0': {
    modelId: 'doubao-seedance-2.0',
    resolutions: [...SD_2_RESOLUTIONS, '1080p', '4k'],
    defaultResolution: '720p',
    ratios: COMMON_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'size',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    audioField: 'generate_audio',
    defaultAudio: true,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    imageWithRoles: true,
  },
  'doubao-seedance-2.0-fast': {
    modelId: 'doubao-seedance-2.0-fast',
    resolutions: SD_2_RESOLUTIONS,
    defaultResolution: '720p',
    ratios: COMMON_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'size',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    audioField: 'generate_audio',
    defaultAudio: true,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    imageWithRoles: true,
  },
  'doubao-seedance-2.0-mini': {
    modelId: 'doubao-seedance-2.0-mini',
    resolutions: SD_2_RESOLUTIONS,
    defaultResolution: '720p',
    ratios: COMMON_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'size',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    audioField: 'generate_audio',
    defaultAudio: true,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    imageWithRoles: true,
  },
  'doubao-seedance-2.5': {
    modelId: 'doubao-seedance-2.5',
    resolutions: SD_2_RESOLUTIONS,
    defaultResolution: '720p',
    ratios: COMMON_RATIOS,
    defaultRatio: 'adaptive',
    ratioField: 'size',
    minDuration: 4,
    maxDuration: 30,
    defaultDuration: 5,
    audioField: 'generate_audio',
    defaultAudio: true,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 30,
    maxVideoReferences: 10,
    maxAudioReferences: 10,
    watermarkField: 'watermark',
    defaultWatermark: false,
    imageWithRoles: true,
  },
  'minimax-h3': {
    modelId: 'MiniMax-H3',
    resolutions: H3_RESOLUTIONS,
    defaultResolution: '2K',
    ratios: H3_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'aspect_ratio',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    frameFields: { first: 'first_frame_image', last: 'last_frame_image' },
    watermarkField: 'watermark',
    defaultWatermark: false,
  },
  'minimax-h3-context-ir': {
    modelId: 'MiniMax-H3-Context-IR',
    resolutions: H3_RESOLUTIONS,
    defaultResolution: '2K',
    ratios: H3_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'aspect_ratio',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    frameFields: { first: 'first_frame_image', last: 'last_frame_image' },
    watermarkField: 'watermark',
    defaultWatermark: false,
  },
  'minimax-h3-regeneration': {
    modelId: 'MiniMax-H3-Regeneration',
    resolutions: H3_RESOLUTIONS,
    defaultResolution: '2K',
    ratios: H3_RATIOS,
    defaultRatio: '16:9',
    ratioField: 'aspect_ratio',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    frameFields: { first: 'first_frame_image', last: 'last_frame_image' },
    watermarkField: 'watermark',
    defaultWatermark: false,
  },
};

function normalizeModelId(model: string): string {
  if (isLegacyApimartOmni(model)) return 'gemini-omni-1.1-flash-ext';
  const stripped = model.startsWith('apimart/') ? model.slice('apimart/'.length) : model;
  // 能力表 key 统一小写，模型 ID（如 MiniMax-H3）大小写不敏感地查找
  return stripped.toLowerCase();
}

export function getApimartSeedanceCapability(
  model?: string,
): ApimartSeedanceCapability | undefined {
  return model ? APIMART_SEEDANCE_CAPABILITIES[normalizeModelId(model)] : undefined;
}

export function isApimartSeedanceModel(model?: string): boolean {
  return Boolean(getApimartSeedanceCapability(model));
}

/**
 * 将通用视频模型的能力声明（VideoModelCapability）适配为 UI 参数面板消费的能力视图。
 * 缺省字段按通用 Seedance 兜底补齐，使 general 模型也能按声明约束时长/分辨率/比例。
 */
export function toSeedanceCapabilityView(
  capability: VideoModelCapability | undefined,
): ApimartSeedanceCapability | undefined {
  if (!capability) return undefined;
  const resolutions = capability.resolutions?.length ? capability.resolutions : ['480p', '720p', '1080p'];
  return {
    modelId: '',
    resolutions,
    defaultResolution: capability.defaultResolution ?? resolutions[resolutions.length - 1],
    ratios: capability.ratios?.length ? capability.ratios : ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
    defaultRatio: capability.defaultRatio ?? '16:9',
    ratioField: 'size',
    ...(capability.durations?.length ? { durations: capability.durations } : {}),
    minDuration: capability.minDuration ?? Math.min(...(capability.durations ?? [2])),
    maxDuration: capability.maxDuration ?? Math.max(...(capability.durations ?? [15])),
    defaultDuration: capability.defaultDuration ?? capability.durations?.[0] ?? 5,
    audioField: capability.supportsAudio === false ? undefined : 'generate_audio',
    defaultAudio: capability.supportsAudio === false ? false : true,
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    maxImageReferences: capability.maxImageReferences ?? 9,
    maxVideoReferences: capability.maxVideoReferences ?? 3,
    maxAudioReferences: capability.maxAudioReferences ?? 3,
  };
}

export function buildApimartSeedanceRequest(
  model: string,
  prompt: string,
  params: ApimartSeedanceRequestParams,
): Record<string, unknown> | null {
  const capability = getApimartSeedanceCapability(model);
  if (!capability) return null;
  if (capability.omniVariant) return buildOmniRequest(capability, prompt, params);

  const imageUrls = (params.imageUrls ?? []).filter(Boolean);
  const videoUrls = (params.videoUrls ?? []).filter(Boolean);
  const audioUrls = (params.audioUrls ?? []).filter(Boolean);
  const frameFields = capability.frameFields;
  const hasFrame = frameFields
    ? Boolean(params.firstFrameUrl?.trim() || params.lastFrameUrl?.trim())
    : false;
  // image_with_roles 携带的带角色图片（Seedance 2.0/2.5）
  const imageWithRoles = (params.imageWithRoles ?? [])
    .filter((item) => item.url?.trim()
      && (item.role === 'first_frame' || item.role === 'last_frame' || item.role === 'reference_image'));
  const hasFrameRoles = imageWithRoles.some((item) => item.role === 'first_frame' || item.role === 'last_frame');
  const hasImageWithRoles = imageWithRoles.length > 0;
  // 首/尾帧（frameFields 独立字段 或 image_with_roles 首/尾帧）与 image_urls / 视频 / 音频严格互斥，混用会返回 400。
  // 注意：image_with_roles 中的 reference_image 属于「带角色的参考图」，本身可与首/尾帧共存，
  // 但不得与 image_urls（无角色参考图）混用。
  if ((hasFrame || hasFrameRoles) && (imageUrls.length > 0 || videoUrls.length > 0 || audioUrls.length > 0)) {
    throw new Error(`APIMart ${model} 首尾帧与参考素材不能同时使用`);
  }
  if (hasImageWithRoles && imageUrls.length > 0) {
    throw new Error(`APIMart ${model} image_with_roles 与 image_urls 不能同时使用`);
  }
  const operation = params.operation
    ?? (videoUrls.length > 0
      ? 'video-to-video'
      : imageUrls.length > 0 || hasFrame || hasFrameRoles || hasImageWithRoles ? 'image-to-video' : 'text-to-video');
  if (!capability.operations.includes(operation)) {
    throw new Error(`APIMart ${model} 不支持 ${operation}`);
  }
  // 参考图上限对 image_urls 与 image_with_roles 一并生效（后者也是参考图，只是带角色）
  if (imageUrls.length + imageWithRoles.length > capability.maxImageReferences) {
    throw new Error(`APIMart ${model} 最多支持 ${capability.maxImageReferences} 张参考图`);
  }
  if (videoUrls.length > (capability.maxVideoReferences ?? 0)) {
    throw new Error(capability.maxVideoReferences
      ? `APIMart ${model} 最多支持 ${capability.maxVideoReferences} 个参考视频`
      : `APIMart ${model} 不支持参考视频`);
  }
  if (audioUrls.length > (capability.maxAudioReferences ?? 0)) {
    throw new Error(capability.maxAudioReferences
      ? `APIMart ${model} 最多支持 ${capability.maxAudioReferences} 个参考音频`
      : `APIMart ${model} 不支持参考音频`);
  }
  // MiniMax-H3：音频不能单独使用，必须搭配参考图或参考视频
  // （Seedance 2.5 支持纯音频参考，仅 H3 系列保留此限制）
  if (frameFields
    && audioUrls.length > 0
    && imageUrls.length === 0
    && videoUrls.length === 0
    && !hasFrame) {
    throw new Error(`APIMart ${model} 参考音频不能单独使用，请搭配参考图或参考视频`);
  }

  const resolution = params.resolution && capability.resolutions.includes(params.resolution)
    ? params.resolution
    : capability.defaultResolution;
  const ratio = params.ratio && capability.ratios.includes(params.ratio)
    ? params.ratio
    : capability.defaultRatio;
  // 首/尾帧任务：APIMart 规定 size 仅 adaptive（提交阶段同步校验），强制覆盖，忽略用户所选比例。
  const effectiveRatio = hasFrameRoles && ratio !== 'adaptive' ? 'adaptive' : ratio;
  const requestedDuration = Number.isFinite(params.duration)
    ? Math.round(params.duration as number)
    : capability.defaultDuration;
  const duration = Math.min(
    capability.maxDuration,
    Math.max(capability.minDuration, requestedDuration),
  );

  const body = mapVideoParameters('apimart', capability.modelId, {
    model: capability.modelId,
    prompt,
    resolution,
    aspectRatio: effectiveRatio,
    duration,
  });
  if (capability.ratioField !== 'aspect_ratio') {
    delete body.aspect_ratio;
    body[capability.ratioField] = effectiveRatio;
  }
  if (frameFields) {
    if (params.firstFrameUrl?.trim()) body[frameFields.first] = params.firstFrameUrl.trim();
    if (params.lastFrameUrl?.trim()) body[frameFields.last] = params.lastFrameUrl.trim();
    // MiniMax-H3 参考图（role=reference）仍走 image_urls，与首尾帧互斥已在上方校验
    if (imageUrls.length > 0) body.image_urls = imageUrls;
  } else if (hasImageWithRoles) {
    // Seedance 2.0/2.5：带角色图片走 image_with_roles（与 image_urls 互斥，此时不写 image_urls）
    body.image_with_roles = imageWithRoles.map(({ url, role }) => ({ url: url.trim(), role }));
  } else {
    if (imageUrls.length > 0) body.image_urls = imageUrls;
  }
  if (videoUrls.length > 0) body.video_urls = videoUrls;
  if (audioUrls.length > 0) body.audio_urls = audioUrls;
  if (capability.audioField) {
    body[capability.audioField] = params.generateAudio ?? capability.defaultAudio ?? false;
  }
  if (capability.watermarkField) {
    body[capability.watermarkField] = params.watermark ?? capability.defaultWatermark ?? false;
  }
  return body;
}

function buildOmniRequest(
  capability: ApimartSeedanceCapability,
  prompt: string,
  params: ApimartSeedanceRequestParams,
): Record<string, unknown> {
  const images = (params.imageUrls ?? []).filter(Boolean);
  const videos = (params.videoUrls ?? []).filter(Boolean);
  const first = params.firstFrameUrl?.trim();
  const last = params.lastFrameUrl?.trim();
  if (params.imageWithRoles?.length) throw new Error('Omni 请使用首尾帧字段或普通参考图');
  if (params.audioUrls?.length) throw new Error('Omni 不支持参考音频');
  if (params.operation && !capability.operations.includes(params.operation)) throw new Error('Omni 不支持该生成方式');
  if (videos.length > 1) throw new Error('Omni 最多支持 1 个参考视频');
  if (!prompt.trim() && !images.length && !videos.length && !first && !last) throw new Error('提示词或参考素材至少提供一项');
  if (capability.omniVariant === 'ext' && !prompt.trim()) throw new Error('Omni Ext 提示词不能为空');
  if (last && capability.omniVariant !== 'flash') throw new Error('该 Omni 模型不支持尾帧，请使用 Gemini Omni 1.1 Flash');
  if (last && !first) throw new Error('Omni 尾帧必须同时提供首帧');
  if (images.length + Number(Boolean(first)) + Number(Boolean(last)) > capability.maxImageReferences) {
    throw new Error(`Omni 图片与首尾帧合计最多 ${capability.maxImageReferences} 张`);
  }
  const allUrls = [...images, ...videos, ...(first ? [first] : []), ...(last ? [last] : [])];
  if (allUrls.some((value) => {
    try { return !['http:', 'https:'].includes(new URL(value).protocol); } catch { return true; }
  })) throw new Error('Omni 参考素材必须是可访问的 HTTP/HTTPS URL');

  const requestedResolution = params.resolution?.toLowerCase();
  const resolution = requestedResolution === '2160p' ? '4k' : requestedResolution ?? capability.defaultResolution;
  if (!capability.resolutions.includes(resolution)) throw new Error(`Omni 分辨率仅支持 ${capability.resolutions.join(' / ')}`);
  const ratio = params.ratio ?? capability.defaultRatio;
  if (!capability.ratios.includes(ratio)) throw new Error('Omni 比例仅支持 16:9 / 9:16');
  const body: Record<string, unknown> = { model: capability.modelId, prompt, resolution };
  if (!videos.length) body.aspect_ratio = ratio;
  if (capability.omniVariant === 'ext') {
    if (first && images.length) throw new Error('Omni Ext 首帧模式不能混用参考图');
    const referenceImages = first ? [first] : images;
    if (referenceImages.length && ![1, 3].includes(referenceImages.length)) throw new Error('Omni Ext 参考图只能为 1 张或 3 张');
    if (referenceImages.length) {
      body.image_urls = referenceImages;
      body.generation_type = first ? 'frame' : 'reference';
    }
    if (!videos.length) {
      const duration = params.duration ?? capability.defaultDuration;
      if (!capability.durations?.includes(duration)) throw new Error('Omni Ext 时长仅支持 4 / 6 / 8 / 10 秒');
      body.duration = duration;
    }
  } else if (capability.omniVariant === 'flash') {
    if (first) body.first_frame_image = first;
    if (last) body.last_frame_image = last;
    if (images.length) body.image_urls = images;
  } else {
    if (first && images.length) throw new Error('Omni Preview 请将图片统一作为参考图使用');
    if (first || images.length) body.image_urls = first ? [first] : images;
  }
  if (videos.length) body.video_urls = videos;
  return body;
}
