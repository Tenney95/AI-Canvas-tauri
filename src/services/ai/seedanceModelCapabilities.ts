/**
 * Seedance 官方能力与自定义接口快速适配模板。
 *
 * 能力语义来自火山方舟模型文档；HTTP 字段和任务响应属于传输层，必须按
 * 火山原生或已确认的中转协议分别生成，不能因为模型同名就共用请求体。
 */
import type {
  ModelExecutionProfile,
  NormalizedModelExecutionProtocol,
  VideoModelCapability,
} from '../../types/aiTypes';
import type { ProviderModelSelection } from '../../types';

export type SeedanceModelVariant = '2.0-standard' | '2.0-fast' | '2.0-mini' | '2.5';
export type SeedanceQuickAdaptTransport = 'volcengine' | 'apimart' | 'lec';
export type SeedanceTemplateId = `${SeedanceModelVariant}:${SeedanceQuickAdaptTransport}`;

export interface SeedanceQuickAdaptOption {
  id: `${SeedanceModelVariant}:${SeedanceQuickAdaptTransport}`;
  model: SeedanceModelVariant;
  transport: SeedanceQuickAdaptTransport;
  label: string;
  description: string;
}

export interface SeedanceQuickAdaptTemplate {
  capability: VideoModelCapability;
  executionProfile: ModelExecutionProfile;
}

export interface SeedanceAutoTemplateMatch {
  model: SeedanceModelVariant;
  templateId?: SeedanceTemplateId;
  capability: VideoModelCapability;
  executionProfile?: ModelExecutionProfile;
}

const FIXED_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const ALL_RATIOS = [...FIXED_RATIOS, 'adaptive'];
const SD20_OPERATIONS = ['text-to-video', 'image-to-video', 'video-to-video'] as const;

const OFFICIAL_CAPABILITIES: Record<SeedanceModelVariant, VideoModelCapability> = {
  '2.0-standard': {
    operations: [...SD20_OPERATIONS],
    resolutions: ['480p', '720p', '1080p', '4k'],
    defaultResolution: '720p',
    ratios: ALL_RATIOS,
    defaultRatio: '16:9',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    supportsAudio: true,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  },
  '2.0-fast': {
    operations: [...SD20_OPERATIONS],
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    ratios: ALL_RATIOS,
    defaultRatio: '16:9',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    supportsAudio: true,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  },
  '2.0-mini': {
    operations: [...SD20_OPERATIONS],
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    ratios: ALL_RATIOS,
    defaultRatio: '16:9',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    supportsAudio: true,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
  },
  '2.5': {
    operations: [...SD20_OPERATIONS],
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    ratios: ALL_RATIOS,
    defaultRatio: 'adaptive',
    minDuration: 4,
    maxDuration: 30,
    automaticDurationValue: -1,
    supportsAudio: true,
    supportsStandaloneAudio: true,
    maxImageReferences: 30,
    maxVideoReferences: 10,
    maxAudioReferences: 10,
    inputModeCapabilities: {
      keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
    },
    operationCapabilities: {
      'video-to-video': {
        ratios: ['adaptive'],
        defaultRatio: 'adaptive',
        automaticDurationOnly: true,
      },
    },
  },
};

const VOLCENGINE_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  submit: {
    method: 'POST',
    path: '/contents/generations/tasks',
    body: {
      model: '{{model}}',
      content: '{{seedanceContent}}',
      resolution: '{{seedanceResolution}}',
      ratio: '{{seedanceRatio}}',
      duration: '{{seedanceDuration}}',
      generate_audio: '{{generateAudio}}',
      watermark: false,
    },
  },
  response: {
    type: 'json',
    taskIdPath: 'id',
    errorPath: 'error.message',
  },
  poll: {
    method: 'GET',
    path: '/contents/generations/tasks/{{submit.id}}',
    response: {
      statusPath: 'status',
      successValues: ['succeeded'],
      failureValues: ['failed', 'cancelled'],
      result: { urlPath: 'content.video_url', mimeType: 'video/mp4' },
      errorPath: 'error.message',
    },
    intervalMs: 5000,
  },
};

const APIMART_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  submit: {
    method: 'POST',
    path: '/videos/generations',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      resolution: '{{seedanceResolution}}',
      size: '{{seedanceRatio}}',
      duration: '{{seedanceDuration}}',
      generate_audio: '{{generateAudio}}',
      image_with_roles: '{{imageWithRoles}}',
      video_urls: '{{videoUrls}}',
      audio_urls: '{{audioUrls}}',
    },
  },
  response: {
    type: 'json',
    taskIdPath: 'data.0.task_id',
    errorPath: 'error.message',
  },
  poll: {
    method: 'GET',
    path: '/tasks/{{submit.data.0.task_id}}',
    query: { language: 'zh' },
    response: {
      statusPath: 'data.status',
      successValues: ['completed'],
      failureValues: ['failed', 'error', 'cancelled'],
      result: { urlPath: 'data.result.videos.*.url', mimeType: 'video/mp4' },
      errorPath: 'data.error.message',
      progressPath: 'data.progress',
    },
    intervalMs: 3000,
  },
};

/** Lec 对所有公开视频模型统一使用的任务协议；具体能力仍按模型 ID 覆盖。 */
const LEC_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  submit: {
    method: 'POST',
    path: '/v1/videos',
    pathMode: 'origin',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      duration: '{{seedanceDuration}}',
      aspect_ratio: '{{seedanceRatio}}',
      resolution: '{{seedanceResolution}}',
      images: '{{imageUrls}}',
      videos: '{{videoUrls}}',
      audios: '{{audioUrls}}',
    },
  },
  response: {
    type: 'json',
    taskIdPath: 'id',
    errorPath: 'error.message',
  },
  poll: {
    method: 'GET',
    path: '/v1/videos/{{submit.id}}',
    pathMode: 'origin',
    response: {
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed'],
      result: { urlPath: 'url', mimeType: 'video/mp4' },
      errorPath: 'error.message',
      progressPath: 'progress',
    },
    intervalMs: 5000,
    retry: {
      httpStatuses: [429, 500, 502, 503, 504],
      maxRetries: 3,
      backoff: 'exponential',
      maxDelayMs: 30000,
      honorRetryAfter: true,
      retryNetworkErrors: true,
    },
  },
};

const MODEL_LABELS: Record<SeedanceModelVariant, string> = {
  '2.0-standard': 'Seedance 2.0',
  '2.0-fast': 'Seedance 2.0 Fast',
  '2.0-mini': 'Seedance 2.0 Mini',
  '2.5': 'Seedance 2.5',
};

const TRANSPORT_LABELS: Record<SeedanceQuickAdaptTransport, string> = {
  volcengine: '火山原生',
  apimart: 'APIMart 兼容',
  lec: 'Lec API',
};

export const SEEDANCE_QUICK_ADAPT_OPTIONS: readonly SeedanceQuickAdaptOption[] = (
  Object.keys(MODEL_LABELS) as SeedanceModelVariant[]
).flatMap((model) => (
  (Object.keys(TRANSPORT_LABELS) as SeedanceQuickAdaptTransport[]).map((transport) => ({
    id: `${model}:${transport}` as const,
    model,
    transport,
    label: `${MODEL_LABELS[model]} · ${TRANSPORT_LABELS[transport]}`,
    description: transport === 'volcengine'
      ? '火山方舟 contents/generations/tasks 原生协议'
      : transport === 'apimart'
        ? 'APIMart /videos/generations 与 /tasks 查询协议'
        : 'Lec /v1/videos 统一异步任务协议；线路限制以模型 ID 覆盖',
  }))
));

export function getOfficialSeedanceCapability(model: SeedanceModelVariant): VideoModelCapability {
  return structuredClone(OFFICIAL_CAPABILITIES[model]);
}

function getTransportCapability(
  model: SeedanceModelVariant,
  transport: SeedanceQuickAdaptTransport,
): VideoModelCapability {
  const capability = getOfficialSeedanceCapability(model);
  // Lec 文档未提供生成音频开关；参考音频能力仍由原合同声明。
  if (transport === 'lec') delete capability.supportsAudio;
  if (transport !== 'apimart') return capability;

  capability.allowFrameAndReferenceMix = false;
  if (model === '2.5') {
    capability.defaultDuration = 5;
    // APIMart 的 video_urls 同时承载参考视频与编辑，由提示词判定；不强制所有参考任务为自动时长。
    delete capability.operationCapabilities;
  }
  return capability;
}

export function createSeedanceQuickAdaptTemplate(
  model: SeedanceModelVariant,
  transport: SeedanceQuickAdaptTransport,
): SeedanceQuickAdaptTemplate {
  const protocol = transport === 'volcengine'
    ? VOLCENGINE_PROTOCOL
    : transport === 'apimart'
      ? APIMART_PROTOCOL
      : LEC_PROTOCOL;
  return {
    capability: getTransportCapability(model, transport),
    executionProfile: {
      preset: 'custom',
      protocol: structuredClone(protocol),
    },
  };
}

function normalizedModelId(value: string): string {
  return value.trim().toLowerCase().replace(/[_.\s]+/g, '-');
}

/** 只认 Seedance/Seed/SD 加明确 2.x 版本，避免把 Agnes 2.5、Seedream 等误判进来。 */
export function inferSeedanceModelVariant(
  modelId: string,
  name = '',
): SeedanceModelVariant | undefined {
  const value = normalizedModelId(`${modelId} ${name}`);
  const family = '(?:seedance|seed|sd)';
  if (new RegExp(`(?:^|[-/])${family}-?2-?5(?:-|$)`).test(value)) return '2.5';
  if (!new RegExp(`(?:^|[-/])${family}-?2(?:-?0)?(?:-|$)`).test(value)) return undefined;
  if (/(?:^|[-/])mini(?:-|$)/.test(value)) return '2.0-mini';
  if (/(?:^|[-/])fast(?:-|$)/.test(value)) return '2.0-fast';
  return '2.0-standard';
}

function inferSeedanceTransport(baseUrl?: string): SeedanceQuickAdaptTransport | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'api.paipu.net') return 'lec';
    if (host === 'api.apimart.ai' || host.endsWith('.apimart.ai')) return 'apimart';
    if (host === 'ark.cn-beijing.volces.com' || host.endsWith('.volces.com')) return 'volcengine';
  } catch {
    return undefined;
  }
  return undefined;
}

function parseTemplateId(value?: string): {
  model: SeedanceModelVariant;
  transport: SeedanceQuickAdaptTransport;
} | undefined {
  if (!value) return undefined;
  const option = SEEDANCE_QUICK_ADAPT_OPTIONS.find((item) => item.id === value);
  return option ? { model: option.model, transport: option.transport } : undefined;
}

function lecCapabilityOverride(modelId: string): VideoModelCapability | undefined {
  switch (normalizedModelId(modelId)) {
    case 'lec-gt-seedance-2-0-full':
      return {
        operations: ['text-to-video', 'image-to-video', 'video-to-video'],
        resolutions: ['480p', '720p', '1080p'],
        defaultResolution: '480p',
        ratios: [...FIXED_RATIOS],
        defaultRatio: '16:9',
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        maxImageReferences: 9,
        maxVideoReferences: 3,
        maxAudioReferences: 3,
      };
    case 'lec-gt-seedance-2-5-720p':
      return {
        operations: ['text-to-video', 'image-to-video', 'video-to-video'],
        resolutions: ['480p', '720p', '1080p'],
        defaultResolution: '720p',
        ratios: [...FIXED_RATIOS],
        defaultRatio: '16:9',
        minDuration: 12,
        maxDuration: 30,
        defaultDuration: 12,
        supportsStandaloneAudio: true,
        maxImageReferences: 30,
        maxVideoReferences: 10,
        maxAudioReferences: 10,
      };
    case 'lec-seedance-2-5-30s':
      return {
        operations: ['text-to-video', 'image-to-video'],
        resolutions: ['720p'],
        defaultResolution: '720p',
        ratios: ['16:9', '9:16', '1:1'],
        defaultRatio: '16:9',
        durations: [30],
        defaultDuration: 30,
        maxImageReferences: 30,
        maxVideoReferences: 0,
        maxAudioReferences: 0,
      };
    case 'lec-ac-seedance-2-5-all-reference':
      return {
        operations: ['text-to-video', 'image-to-video'],
        resolutions: ['720p'],
        defaultResolution: '720p',
        ratios: ['16:9', '9:16', '1:1'],
        defaultRatio: '16:9',
        minDuration: 4,
        maxDuration: 30,
        defaultDuration: 4,
        supportsStandaloneAudio: true,
        maxImageReferences: 30,
        maxVideoReferences: 0,
        maxAudioReferences: 10,
      };
    default:
      return undefined;
  }
}

function tailorLecExecutionProfile(
  profile: ModelExecutionProfile,
  capability: VideoModelCapability,
): ModelExecutionProfile {
  const tailored = structuredClone(profile);
  const body = tailored.protocol?.submit.body;
  if (!body || Array.isArray(body) || typeof body !== 'object') return tailored;
  const fields = body as Record<string, unknown>;
  if ((capability.maxImageReferences ?? 0) === 0) delete fields.images;
  if ((capability.maxVideoReferences ?? 0) === 0) delete fields.videos;
  if ((capability.maxAudioReferences ?? 0) === 0) delete fields.audios;
  return tailored;
}

export function resolveSeedanceAutoTemplate(options: {
  modelId: string;
  name?: string;
  baseUrl?: string;
  templateId?: string;
  capability?: VideoModelCapability;
}): SeedanceAutoTemplateMatch | undefined {
  const explicit = parseTemplateId(options.templateId);
  const model = explicit?.model ?? inferSeedanceModelVariant(options.modelId, options.name);
  if (!model) return undefined;
  const transport = explicit?.transport ?? inferSeedanceTransport(options.baseUrl);
  // 同名中转模型不代表继承官方能力；只有已确认协议或显式模板才成套补齐。
  if (!transport) return undefined;
  const template = createSeedanceQuickAdaptTemplate(model, transport);
  const capability = options.capability ?? (transport === 'lec'
    ? lecCapabilityOverride(options.modelId) ?? template.capability
    : template.capability);
  return {
    model,
    templateId: `${model}:${transport}` as SeedanceTemplateId,
    capability: structuredClone(capability),
    executionProfile: transport === 'lec'
      ? tailorLecExecutionProfile(template.executionProfile, capability)
      : template.executionProfile,
  };
}

/**
 * 设置页和目录合并共用的安全默认值：用户显式配置永远优先，未知网关不猜协议。
 */
export function applySeedanceTemplateDefaults(
  model: ProviderModelSelection,
  baseUrl?: string,
  templateId?: string,
): ProviderModelSelection {
  if (model.categoryManual && model.category !== 'video') return model;
  const match = resolveSeedanceAutoTemplate({
    modelId: model.id,
    name: model.name,
    baseUrl,
    templateId,
  });
  if (!match) return model;
  // 已有协议只使用配套的显式能力，不能混入另一份模板声明的可调参数。
  return {
    ...model,
    category: 'video',
    videoCapability: model.videoCapability ?? (model.executionProfile ? undefined : match.capability),
    executionProfile: model.executionProfile ?? match.executionProfile,
  };
}
