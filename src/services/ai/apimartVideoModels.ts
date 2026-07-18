export type ApimartSeedanceRatioField = 'aspect_ratio' | 'size';
export type ApimartSeedanceAudioField = 'audio' | 'generate_audio';

export interface ApimartSeedanceCapability {
  modelId: string;
  resolutions: readonly string[];
  defaultResolution: string;
  ratios: readonly string[];
  defaultRatio: string;
  ratioField: ApimartSeedanceRatioField;
  minDuration: number;
  maxDuration: number;
  defaultDuration: number;
  audioField?: ApimartSeedanceAudioField;
  defaultAudio?: boolean;
  maxImageReferences: number;
}

export interface ApimartSeedanceRequestParams {
  resolution?: string;
  ratio?: string;
  duration?: number;
  generateAudio?: boolean;
  imageUrls?: string[];
}

const COMMON_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const;
const SD_1_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const SD_2_RESOLUTIONS = ['480p', '720p'] as const;

const APIMART_SEEDANCE_CAPABILITIES: Record<string, ApimartSeedanceCapability> = {
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
    maxImageReferences: 9,
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
    maxImageReferences: 9,
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
    maxImageReferences: 9,
  },
};

function normalizeModelId(model: string): string {
  return model.startsWith('apimart/') ? model.slice('apimart/'.length) : model;
}

export function getApimartSeedanceCapability(
  model?: string,
): ApimartSeedanceCapability | undefined {
  return model ? APIMART_SEEDANCE_CAPABILITIES[normalizeModelId(model)] : undefined;
}

export function isApimartSeedanceModel(model?: string): boolean {
  return Boolean(getApimartSeedanceCapability(model));
}

export function buildApimartSeedanceRequest(
  model: string,
  prompt: string,
  params: ApimartSeedanceRequestParams,
): Record<string, unknown> | null {
  const capability = getApimartSeedanceCapability(model);
  if (!capability) return null;

  const imageUrls = (params.imageUrls ?? []).filter(Boolean);
  if (imageUrls.length > capability.maxImageReferences) {
    throw new Error(`APIMart ${model} 最多支持 ${capability.maxImageReferences} 张参考图`);
  }

  const resolution = params.resolution && capability.resolutions.includes(params.resolution)
    ? params.resolution
    : capability.defaultResolution;
  const ratio = params.ratio && capability.ratios.includes(params.ratio)
    ? params.ratio
    : capability.defaultRatio;
  const requestedDuration = Number.isFinite(params.duration)
    ? Math.round(params.duration as number)
    : capability.defaultDuration;
  const duration = Math.min(
    capability.maxDuration,
    Math.max(capability.minDuration, requestedDuration),
  );

  const body: Record<string, unknown> = {
    model: capability.modelId,
    prompt,
    duration,
    resolution,
    [capability.ratioField]: ratio,
  };
  if (imageUrls.length > 0) body.image_urls = imageUrls;
  if (capability.audioField) {
    body[capability.audioField] = params.generateAudio ?? capability.defaultAudio ?? false;
  }
  return body;
}
