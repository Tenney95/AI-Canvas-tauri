/**
 * ai/providers/googleModelManifest — Google 官方模型清单与执行协议。
 * 声明 Gemini 文本、图片（Nano Banana）、视频（Omni / Veo）与 TTS 模型，
 * 以及各自走 openai 兼容端点或 interactions / predictLongRunning 的声明式协议
 * （含鉴权、请求体映射、轮询与结果抽取）。
 */
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability, NormalizedModelExecutionProtocol } from '../../../types/aiTypes';
import { getImageSizePresets } from '../modelSizeProfiles';

export const GOOGLE_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const GOOGLE_API_KEY_AUTH = { type: 'header' as const, name: 'x-goog-api-key' };

const googleInteractionProtocol = (
  mediaType: 'image' | 'video',
  fixedImageSize?: string,
): NormalizedModelExecutionProtocol => ({
  version: 2,
  mode: 'sync',
  auth: GOOGLE_API_KEY_AUTH,
  submit: {
    method: 'POST',
    path: '/v1beta/interactions',
    pathMode: 'origin',
    bodyEncoding: 'json',
    body: {
      model: '{{model}}',
      input: '{{prompt}}',
      response_format: {
        type: mediaType,
        aspect_ratio: '{{aspectRatio}}',
        ...(mediaType === 'image'
          ? { image_size: fixedImageSize ?? '{{imageSize}}' }
          : {}),
      },
    },
  },
  response: {
    type: 'json',
    result: {
      base64Path: 'steps.*.content.*.data',
      mimeType: mediaType === 'image' ? 'image/png' : 'video/mp4',
    },
    errorPath: 'error.message',
  },
});

const GOOGLE_TTS_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'sync',
  auth: GOOGLE_API_KEY_AUTH,
  submit: {
    method: 'POST',
    path: '/v1beta/interactions',
    pathMode: 'origin',
    bodyEncoding: 'json',
    body: {
      model: '{{model}}',
      input: '{{prompt}}',
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: 'Kore' }],
      },
    },
  },
  response: {
    type: 'json',
    result: {
      base64Path: 'steps.*.content.*.data',
      mimeType: 'audio/wav',
      base64Transform: {
        type: 'pcm-s16le-to-wav',
        sampleRate: 24_000,
        channels: 1,
      },
    },
    errorPath: 'error.message',
  },
};

const GOOGLE_VEO_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2,
  mode: 'async',
  auth: GOOGLE_API_KEY_AUTH,
  submit: {
    method: 'POST',
    path: '/v1beta/models/{{model}}:predictLongRunning',
    pathMode: 'origin',
    bodyEncoding: 'json',
    body: {
      instances: [{ prompt: '{{prompt}}' }],
      parameters: { aspectRatio: '{{aspectRatio}}' },
    },
  },
  response: {
    type: 'json',
    taskIdPath: 'name',
    errorPath: 'error.message',
  },
  poll: {
    method: 'GET',
    path: '/v1beta/{{submit.name}}',
    pathMode: 'origin',
    response: {
      statusPath: 'done',
      successValues: ['true'],
      failureValues: ['failed', 'error', 'cancelled'],
      result: {
        urlPath: 'response.generateVideoResponse.generatedSamples.*.video.uri',
        mimeType: 'video/mp4',
        fetchUrl: true,
      },
      errorPath: 'error.message',
    },
    intervalMs: 10_000,
    maxDurationMs: 3_600_000,
    retry: {
      httpStatuses: [408, 429, 500, 502, 503, 504],
      maxRetries: 5,
      backoff: 'exponential',
      maxDelayMs: 60_000,
      honorRetryAfter: true,
      retryNetworkErrors: true,
    },
  },
};

export const GOOGLE_IMAGE_PROTOCOL = googleInteractionProtocol('image');
const GOOGLE_IMAGE_LITE_PROTOCOL = googleInteractionProtocol('image', '1K');
const GOOGLE_OMNI_VIDEO_PROTOCOL = googleInteractionProtocol('video');
const GOOGLE_PRO_IMAGE_DIMENSIONS = getImageSizePresets('google-gemini-3-pro');

export const GOOGLE_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    category: 'text',
    provider: 'google',
    description: 'Google 官方生产级文本与多模态模型',
    executionProfile: { preset: 'openai-chat' },
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    category: 'text',
    provider: 'google',
    description: 'Google 官方低延迟、低成本文本模型',
    executionProfile: { preset: 'openai-chat' },
  },
  ...([
    { id: 'gemini-3.1-flash-lite-image', name: 'Gemini 3.1 Flash Lite Image', protocol: GOOGLE_IMAGE_LITE_PROTOCOL,
      imageCapability: undefined },
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', protocol: GOOGLE_IMAGE_PROTOCOL,
      imageCapability: undefined },
    { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image', protocol: GOOGLE_IMAGE_PROTOCOL,
      imageCapability: {
        resolutions: ['1K', '2K', '4K'], defaultResolution: '1K',
        ratios: Object.keys(GOOGLE_PRO_IMAGE_DIMENSIONS['1K']), defaultRatio: '1:1',
        dimensionPresets: GOOGLE_PRO_IMAGE_DIMENSIONS,
        supportsBatch: false, maxBatchCount: 1,
        // 当前 Interactions 合同只有文本 input；图片参考仍由显式原生快速模板配置。
        supportsImageReference: false,
      } },
  ] satisfies Array<{
    id: string;
    name: string;
    protocol: NormalizedModelExecutionProtocol;
    imageCapability?: ImageModelCapability;
  }>).map(({ id, name, protocol, imageCapability }) => ({
    id,
    name,
    category: 'image' as const,
    provider: 'google',
    description: 'Google 官方 Nano Banana 图片生成模型（当前接入文生图）',
    imageCapability,
    executionProfile: {
      preset: 'custom' as const,
      protocol,
    },
  })),
  {
    id: 'gemini-omni-flash-preview',
    name: 'Gemini Omni Flash Video（文生视频）',
    category: 'video',
    provider: 'google',
    description: 'Google 官方原生多模态视频模型，当前接入文生视频',
    executionProfile: { preset: 'custom', protocol: GOOGLE_OMNI_VIDEO_PROTOCOL },
  },
  {
    id: 'veo-3.1-generate-preview',
    name: 'Veo 3.1（文生视频）',
    category: 'video',
    provider: 'google',
    description: 'Google 官方高质量异步视频生成模型，自动鉴权下载结果',
    executionProfile: { preset: 'custom', protocol: GOOGLE_VEO_PROTOCOL },
  },
  {
    id: 'gemini-3.1-flash-tts-preview',
    name: 'Gemini 3.1 Flash TTS（Kore / WAV）',
    category: 'audio',
    provider: 'google',
    description: 'Google 官方语音生成模型，24kHz 单声道 PCM 自动封装为 WAV',
    executionProfile: { preset: 'custom', protocol: GOOGLE_TTS_PROTOCOL },
  },
];
