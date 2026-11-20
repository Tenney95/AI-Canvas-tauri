/**
 * ai/providers/xaiModelManifest — xAI（Grok）官方模型清单与执行协议。
 * 声明 Grok 文本、图片（Imagine Image）与视频（文生 / 单图生视频）模型，
 * 以及各自的声明式协议（bearer 鉴权、请求体映射、异步轮询与结果抽取）。
 */
import type { NormalizedModelExecutionProtocol } from '../../../types/aiTypes';
import type { ProviderModelSelection } from '../../../types';

export const XAI_BASE_URL = 'https://api.x.ai/v1';

export const XAI_IMAGE_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/images/generations',
    bodyEncoding: 'json',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      response_format: 'url',
    },
  },
  response: {
    type: 'json',
    result: { urlPath: 'data.*.url' },
    errorPath: 'error.message',
  },
};

const XAI_VIDEO_POLL = {
  method: 'GET' as const,
  path: '/videos/{{submit.request_id}}',
  response: {
    statusPath: 'status',
    successValues: ['done'],
    failureValues: ['failed', 'expired'],
    result: { urlPath: 'video.url', mimeType: 'video/mp4' },
    errorPath: 'error.message',
    progressPath: 'progress',
  },
  intervalMs: 10_000,
  maxDurationMs: 3_600_000,
  retry: {
    httpStatuses: [408, 429, 500, 502, 503, 504],
    maxRetries: 5,
    backoff: 'exponential' as const,
    maxDelayMs: 60_000,
    honorRetryAfter: true,
    retryNetworkErrors: true,
  },
};

const createXaiVideoProtocol = (includeReferenceImage: boolean): NormalizedModelExecutionProtocol => ({
  version: 2,
  mode: 'async',
  auth: { type: 'bearer' },
  submit: {
    method: 'POST',
    path: '/videos/generations',
    bodyEncoding: 'json',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      ...(includeReferenceImage ? { image: { url: '{{firstImage}}' } } : {}),
      duration: '{{duration}}',
      aspect_ratio: '{{aspectRatio}}',
      resolution: '{{seedanceResolution}}',
    },
  },
  response: { type: 'json', taskIdPath: 'request_id', errorPath: 'error.message' },
  poll: XAI_VIDEO_POLL,
});

const XAI_TEXT_TO_VIDEO_PROTOCOL = createXaiVideoProtocol(false);
const XAI_IMAGE_TO_VIDEO_PROTOCOL = createXaiVideoProtocol(true);

export const XAI_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    category: 'text',
    provider: 'xai',
    description: 'xAI 官方旗舰文本与推理模型',
    executionProfile: { preset: 'openai-chat' },
  },
  {
    id: 'grok-imagine-image',
    name: 'Grok Imagine Image',
    category: 'image',
    provider: 'xai',
    description: 'xAI 官方标准图片生成模型',
    executionProfile: { preset: 'custom', protocol: XAI_IMAGE_PROTOCOL },
  },
  {
    id: 'grok-imagine-image-quality',
    name: 'Grok Imagine Image Quality',
    category: 'image',
    provider: 'xai',
    description: 'xAI 官方高质量图片生成模型',
    executionProfile: { preset: 'custom', protocol: XAI_IMAGE_PROTOCOL },
  },
  {
    id: 'grok-imagine-video',
    name: 'Grok Imagine Video（文生视频）',
    category: 'video',
    provider: 'xai',
    description: 'xAI 官方文生视频模型',
    executionProfile: { preset: 'custom', protocol: XAI_TEXT_TO_VIDEO_PROTOCOL },
  },
  {
    id: 'grok-imagine-video-1.5',
    name: 'Grok Imagine Video 1.5（单图生视频）',
    category: 'video',
    provider: 'xai',
    description: 'xAI 官方单图生视频模型，需要连接一张参考图',
    executionProfile: { preset: 'custom', protocol: XAI_IMAGE_TO_VIDEO_PROTOCOL },
  },
];
