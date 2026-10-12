/**
 * MiniMax H3 官方能力与自定义接口快速适配模板。
 *
 * H3 / H3-Max 的能力约束与网关传输分离：同一模型族可以共享参数语义，
 * 但 MiniMax、APIMart、AI Ping 的路径、请求体与任务响应必须分别声明。
 */
import type { ProviderModelSelection } from '../../types';
import type {
  ModelExecutionProfile,
  NormalizedModelExecutionProtocol,
  VideoModelCapability,
} from '../../types/aiTypes';

export type H3ModelVariant = 'h3-standard' | 'h3-max';
export type H3QuickAdaptTransport = 'minimax' | 'apimart' | 'aiping';
export type H3TemplateId = `${H3ModelVariant}:${H3QuickAdaptTransport}`;

export interface H3QuickAdaptOption {
  id: H3TemplateId;
  model: H3ModelVariant;
  transport: H3QuickAdaptTransport;
  label: string;
  description: string;
}

export interface H3QuickAdaptTemplate {
  capability: VideoModelCapability;
  executionProfile: ModelExecutionProfile;
}

export interface H3AutoTemplateMatch {
  model: H3ModelVariant;
  templateId?: H3TemplateId;
  capability: VideoModelCapability;
  executionProfile?: ModelExecutionProfile;
}

const FIXED_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const ALL_RATIOS = ['adaptive', ...FIXED_RATIOS];
const OPERATIONS = ['text-to-video', 'image-to-video', 'video-to-video'] as const;

const SHARED_INPUT_MODE_CAPABILITIES: VideoModelCapability['inputModeCapabilities'] = {
  text: {
    ratios: [...FIXED_RATIOS],
    defaultRatio: '16:9',
    requiresRatio: true,
  },
  keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
  reference: { ratios: [...ALL_RATIOS], defaultRatio: 'adaptive' },
};

const SHARED_REFERENCE_CONSTRAINTS: VideoModelCapability['inputConstraints'] = {
  referenceVideo: {
    durationSeconds: { min: 2, max: 15 },
    totalDurationSeconds: { max: 15 },
  },
  referenceAudio: {
    durationSeconds: { min: 2, max: 15 },
    totalDurationSeconds: { max: 15 },
  },
};

const OFFICIAL_CAPABILITIES: Record<H3ModelVariant, VideoModelCapability> = {
  'h3-standard': {
    operations: [...OPERATIONS],
    resolutions: ['768P', '2K'],
    defaultResolution: '2K',
    ratios: [...ALL_RATIOS],
    defaultRatio: 'adaptive',
    inputModeCapabilities: SHARED_INPUT_MODE_CAPABILITIES,
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    supportsAudio: true,
    allowFrameAndReferenceMix: false,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    inputConstraints: SHARED_REFERENCE_CONSTRAINTS,
  },
  'h3-max': {
    operations: [...OPERATIONS],
    resolutions: ['480P', '768P'],
    defaultResolution: '768P',
    ratios: [...ALL_RATIOS],
    defaultRatio: 'adaptive',
    inputModeCapabilities: SHARED_INPUT_MODE_CAPABILITIES,
    minDuration: 5,
    maxDuration: 15,
    defaultDuration: 5,
    supportsAudio: true,
    allowFrameAndReferenceMix: false,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    inputConstraints: SHARED_REFERENCE_CONSTRAINTS,
  },
};

function createOfficialContentProtocol(
  submitPath: string,
  pollPath: string,
): NormalizedModelExecutionProtocol {
  return {
    version: 2,
    mode: 'async',
    auth: { type: 'bearer' },
    submit: {
      method: 'POST',
      path: submitPath,
      pathMode: 'origin',
      bodyEncoding: 'json',
      maxBodyBytes: 64 * 1024 * 1024,
      body: {
        model: '{{model}}',
        content: [
          { type: 'text', text: '{{prompt}}' },
          {
            $whenPresent: '{{firstImage}}',
            $value: {
              type: 'image_url',
              image_url: { url: '{{firstImage}}' },
              role: 'first_frame',
            },
          },
          {
            $whenPresent: '{{lastImage}}',
            $value: {
              type: 'image_url',
              image_url: { url: '{{lastImage}}' },
              role: 'last_frame',
            },
          },
          {
            $forEach: '{{referenceImageUrls}}',
            $value: {
              type: 'image_url',
              image_url: { url: '{{referenceImageUrls}}' },
              role: 'reference_image',
            },
          },
          {
            $forEach: '{{referenceVideoUrls}}',
            $value: {
              type: 'video_url',
              video_url: { url: '{{referenceVideoUrls}}' },
              role: 'reference_video',
            },
          },
          {
            $forEach: '{{referenceAudioUrls}}',
            $value: {
              type: 'audio_url',
              audio_url: { url: '{{referenceAudioUrls}}' },
              role: 'reference_audio',
            },
          },
        ],
        resolution: '{{seedanceResolution}}',
        duration: '{{duration}}',
        ratio: '{{aspectRatio}}',
      },
    },
    response: {
      type: 'json',
      taskIdPath: 'task_id',
      errorPath: 'base_resp.status_msg',
    },
    poll: {
      method: 'GET',
      path: pollPath,
      pathMode: 'origin',
      response: {
        statusPath: 'task.status',
        successValues: ['succeeded'],
        failureValues: ['failed', 'cancelled'],
        result: { urlPath: 'task.content.url', mimeType: 'video/mp4' },
        errorPath: 'task.error.message',
      },
      intervalMs: 5000,
    },
  };
}

const MINIMAX_PROTOCOL = createOfficialContentProtocol(
  '/v2/video_generation',
  '/v2/query/video_generation/{{submit.task_id}}',
);

const AIPING_PROTOCOL = createOfficialContentProtocol(
  '/api/v1/multimodal/minimax/videos/video_generation',
  '/api/v1/multimodal/minimax/videos/query/video_generation/{{submit.task_id}}',
);

const APIMART_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/v1/videos/generations',
    pathMode: 'origin',
    bodyEncoding: 'json',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      duration: '{{duration}}',
      resolution: '{{seedanceResolution}}',
      aspect_ratio: '{{aspectRatio}}',
      watermark: false,
      first_frame_image: '{{firstImage}}',
      last_frame_image: '{{lastImage}}',
      image_urls: '{{referenceImageUrls}}',
      video_urls: '{{referenceVideoUrls}}',
      audio_urls: '{{referenceAudioUrls}}',
    },
  },
  response: {
    type: 'json',
    taskIdPath: 'data.0.task_id',
    errorPath: 'error.message',
  },
  poll: {
    method: 'GET',
    path: '/v1/tasks/{{submit.data.0.task_id}}',
    pathMode: 'origin',
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

const MODEL_LABELS: Record<H3ModelVariant, string> = {
  'h3-standard': 'MiniMax H3',
  'h3-max': 'MiniMax H3-Max',
};

const TRANSPORT_LABELS: Record<H3QuickAdaptTransport, string> = {
  minimax: 'MiniMax 官方',
  apimart: 'APIMart 兼容',
  aiping: 'AI Ping 兼容',
};

export const H3_QUICK_ADAPT_OPTIONS: readonly H3QuickAdaptOption[] = (
  Object.keys(MODEL_LABELS) as H3ModelVariant[]
).flatMap((model) => (
  (Object.keys(TRANSPORT_LABELS) as H3QuickAdaptTransport[]).map((transport) => ({
    id: `${model}:${transport}` as H3TemplateId,
    model,
    transport,
    label: `${MODEL_LABELS[model]} · ${TRANSPORT_LABELS[transport]}`,
    description: transport === 'minimax'
      ? 'MiniMax /v2/video_generation 原生 content 协议'
      : transport === 'apimart'
        ? 'APIMart 扁平参数与 /v1/tasks 查询协议'
        : 'AI Ping MiniMax 多模态 content 兼容协议',
  }))
));

export function getOfficialH3Capability(model: H3ModelVariant): VideoModelCapability {
  return structuredClone(OFFICIAL_CAPABILITIES[model]);
}

function getTransportCapability(
  model: H3ModelVariant,
  transport: H3QuickAdaptTransport,
): VideoModelCapability {
  const capability = getOfficialH3Capability(model);
  // 快速模板未映射音频开关；能力表保留原生能力，模板只声明实际可提交的参数。
  capability.supportsAudio = undefined;
  if (transport !== 'apimart') return capability;
  capability.ratios = [...FIXED_RATIOS];
  capability.defaultRatio = '16:9';
  capability.inputModeCapabilities = {
    text: { ratios: [...FIXED_RATIOS], defaultRatio: '16:9', requiresRatio: true },
    keyframe: { ratios: [...FIXED_RATIOS], defaultRatio: '16:9', requiresRatio: true },
    reference: { ratios: [...FIXED_RATIOS], defaultRatio: '16:9', requiresRatio: true },
  };
  return capability;
}

export function createH3QuickAdaptTemplate(
  model: H3ModelVariant,
  transport: H3QuickAdaptTransport,
): H3QuickAdaptTemplate {
  const protocol = transport === 'minimax'
    ? MINIMAX_PROTOCOL
    : transport === 'apimart'
      ? APIMART_PROTOCOL
      : AIPING_PROTOCOL;
  return {
    capability: getTransportCapability(model, transport),
    executionProfile: { preset: 'custom', protocol: structuredClone(protocol) },
  };
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase().replace(/[_.\s]+/g, '-');
}

/** Context-IR 返回文本，Regeneration 需要源任务；两者不能冒充普通视频生成模型。 */
export function inferH3ModelVariant(modelId: string, name = ''): H3ModelVariant | undefined {
  const value = normalizeModelId(`${modelId} ${name}`);
  if (/(?:context-?ir|regeneration|video-?regeneration)/.test(value)) return undefined;
  if (!/(?:minimax|hailuo)[-/]*h3|h3[-/]*(?:minimax|hailuo)/.test(value)) return undefined;
  return /(?:^|[-/])h3[-/]*max(?:-|\/|$)/.test(value) ? 'h3-max' : 'h3-standard';
}

function inferH3Transport(baseUrl?: string): H3QuickAdaptTransport | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'api.apimart.ai' || host.endsWith('.apimart.ai')) return 'apimart';
    if (host === 'aiping.cn' || host.endsWith('.aiping.cn')) return 'aiping';
    if (
      host === 'api.minimax.io'
      || host.endsWith('.minimax.io')
      || host === 'api.minimaxi.com'
      || host.endsWith('.minimaxi.com')
    ) return 'minimax';
  } catch {
    return undefined;
  }
  return undefined;
}

function parseTemplateId(value?: string): {
  model: H3ModelVariant;
  transport: H3QuickAdaptTransport;
} | undefined {
  if (!value) return undefined;
  const option = H3_QUICK_ADAPT_OPTIONS.find((item) => item.id === value);
  return option ? { model: option.model, transport: option.transport } : undefined;
}

export function resolveH3AutoTemplate(options: {
  modelId: string;
  name?: string;
  baseUrl?: string;
  templateId?: string;
  capability?: VideoModelCapability;
}): H3AutoTemplateMatch | undefined {
  const explicit = parseTemplateId(options.templateId);
  const model = explicit?.model ?? inferH3ModelVariant(options.modelId, options.name);
  if (!model) return undefined;
  const transport = explicit?.transport ?? inferH3Transport(options.baseUrl);
  if (!transport) return { model, capability: getOfficialH3Capability(model) };
  const template = createH3QuickAdaptTemplate(model, transport);
  return {
    model,
    templateId: `${model}:${transport}`,
    capability: structuredClone(options.capability ?? template.capability),
    executionProfile: template.executionProfile,
  };
}

export function applyH3TemplateDefaults(
  model: ProviderModelSelection,
  baseUrl?: string,
  templateId?: string,
): ProviderModelSelection {
  if (model.categoryManual && model.category !== 'video') return model;
  const match = resolveH3AutoTemplate({
    modelId: model.id,
    name: model.name,
    baseUrl,
    templateId,
  });
  if (!match) return model;
  return {
    ...model,
    category: 'video',
    videoCapability: model.videoCapability ?? match.capability,
    executionProfile: model.executionProfile ?? match.executionProfile,
  };
}
