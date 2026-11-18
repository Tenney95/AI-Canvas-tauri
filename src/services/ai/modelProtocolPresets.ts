/**
 * ai/modelProtocolPresets — 内置调用协议预设与对应的视频能力声明。
 *
 * 预设只覆盖有跨厂商事实标准的端点（OpenAI 的 chat / images）；
 * 视频没有统一端点，因此自定义视频协议的 path 留空，强制用户提供文档依据。
 */
import type { GeneralModelCategory } from '../../types';
import type {
  ModelExecutionProfile,
  ModelProtocolPresetId,
  NormalizedModelExecutionProtocol,
  VideoModelCapability,
} from '../../types/aiTypes';
import { GOOGLE_IMAGE_PROTOCOL } from './providers/googleModelManifest';
import { XAI_IMAGE_PROTOCOL } from './providers/xaiModelManifest';

const OPENAI_CHAT_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  streamFormat: 'openai-sse',
  submit: {
    method: 'POST',
    path: '/chat/completions',
    body: {
      model: '{{model}}',
      messages: '{{messages}}',
      stream: '{{stream}}',
      tools: '{{tools}}',
      tool_choice: '{{toolChoice}}',
    },
  },
  response: {
    type: 'json',
    result: { textPath: 'choices.0.message.content' },
    errorPath: 'error.message',
  },
};

const OPENAI_IMAGE_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  submit: {
    method: 'POST',
    path: '/images/generations',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      size: '{{size}}',
      quality: '{{imageQuality}}',
      background: '{{imageBackground}}',
      extra_body: { response_format: 'url' },
    },
  },
  response: {
    type: 'json',
    result: { urlPath: 'data.*.url' },
    errorPath: 'error.message',
  },
};

/** 官方 Images API：结果默认可返回 b64_json，编辑请求由标准 multipart 路径处理。 */
const OPENAI_GPT_IMAGE_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  submit: {
    method: 'POST',
    path: '/images/generations',
    body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', quality: '{{imageQuality}}',
      background: '{{imageBackground}}', n: '{{n}}' },
  },
  response: {
    type: 'json',
    result: { urlPath: 'data.*.url', base64Path: 'data.*.b64_json', mimeType: 'image/png' },
    errorPath: 'error.message',
  },
};

/** 常见 GPT-Image 中转合同：生成端点通过 JSON images 接收参考图。 */
const GPT_IMAGE_GATEWAY_JSON_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  submit: {
    method: 'POST',
    path: '/images/generations',
    body: {
      model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: '{{n}}',
      quality: '{{imageQuality}}',
      background: '{{imageBackground}}',
      images: Array.from({ length: 8 }, (_, index) => ({
        $whenPresent: `{{imageUrls.${index}}}`,
        $value: `{{imageUrls.${index}}}`,
      })),
      response_format: 'url',
    },
  },
  response: {
    type: 'json',
    result: { urlPath: 'data.*.url' },
    errorPath: 'error.message',
  },
};

const AGNES_VIDEO_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  submit: {
    method: 'POST',
    path: '/videos',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      height: 768,
      width: 1152,
      num_frames: '{{frames8n1}}',
      frame_rate: '{{fps}}',
    },
  },
  response: {
    type: 'json',
    taskIdPath: 'video_id',
  },
  poll: {
    method: 'GET',
    path: '/agnesapi',
    pathMode: 'origin',
    query: { video_id: '{{submit.video_id}}' },
    response: {
      statusPath: 'status',
      successValues: ['completed'],
      failureValues: ['failed', 'error'],
      result: { urlPath: 'url', mimeType: 'video/mp4' },
      errorPath: 'error',
      progressPath: 'progress',
    },
    intervalMs: 10000,
  },
};

/**
 * The legacy Agnes preset historically relied on the application's global
 * 5-second / 24-fps defaults. Keep that compatibility explicit at the preset
 * boundary so the canonical resolver never has to invent values for arbitrary
 * custom video protocols.
 */
const AGNES_VIDEO_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video'],
  defaultResolution: '1152x768',
  defaultRatio: '3:2',
  defaultFrameRate: 24,
  defaultDuration: 5,
  maxImageReferences: 0,
  maxVideoReferences: 0,
  maxAudioReferences: 0,
};

function cloneProtocol(protocol: NormalizedModelExecutionProtocol): NormalizedModelExecutionProtocol {
  return structuredClone(protocol);
}

export function getModelProtocolPreset(
  preset: Exclude<ModelProtocolPresetId, 'custom' | 'plugin' | 'openai-responses' | 'anthropic-chat' | 'gemini-chat'>,
): NormalizedModelExecutionProtocol {
  if (preset === 'openai-chat') return cloneProtocol(OPENAI_CHAT_PROTOCOL);
  if (preset === 'openai-gpt-image') return cloneProtocol(OPENAI_GPT_IMAGE_PROTOCOL);
  if (preset === 'gpt-image-gateway-json') return cloneProtocol(GPT_IMAGE_GATEWAY_JSON_PROTOCOL);
  if (preset === 'google-image-native') return cloneProtocol(GOOGLE_IMAGE_PROTOCOL);
  if (preset === 'xai-image-native') return cloneProtocol(XAI_IMAGE_PROTOCOL);
  if (preset === 'agnes-video') return cloneProtocol(AGNES_VIDEO_PROTOCOL);
  if (preset === 'openai-image') return cloneProtocol(OPENAI_IMAGE_PROTOCOL);
  throw new Error('不支持的声明式协议预设');
}

export function getModelProtocolPresetVideoCapability(
  profile: ModelExecutionProfile | undefined,
): VideoModelCapability | undefined {
  return profile?.preset === 'agnes-video'
    ? structuredClone(AGNES_VIDEO_CAPABILITY)
    : undefined;
}

/** 将帧数收敛到 Agnes 等模型要求的 8 * n + 1，尽量贴近用户原始选择。 */
export function normalizeFrames8n1(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : 121;
  const multiplier = Math.max(1, Math.round((Math.max(9, finiteValue) - 1) / 8));
  return multiplier * 8 + 1;
}

export function getDefaultCustomProtocol(category: GeneralModelCategory): NormalizedModelExecutionProtocol {
  if (category === 'text') return getModelProtocolPreset('openai-chat');
  if (category === 'image') return getModelProtocolPreset('openai-image');
  const requiresDocumentedVideoEndpoint = category === 'video';
  return {
    version: 2,
    mode: 'async',
    submit: {
      method: 'POST',
      // Video APIs have no cross-provider standard endpoint. An empty path is
      // deliberately invalid so the editor cannot save a guessed request.
      path: requiresDocumentedVideoEndpoint ? '' : '/audio/generations',
      body: { model: '{{model}}', prompt: '{{prompt}}' },
    },
    response: {
      type: 'json',
      taskIdPath: 'task_id',
    },
    poll: {
      method: 'GET',
      path: requiresDocumentedVideoEndpoint ? '' : '/tasks/{{submit.task_id}}',
      response: {
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed', 'error'],
        result: { urlPath: 'url' },
        errorPath: 'error.message',
      },
      intervalMs: 3000,
    },
  };
}
