import type { ProviderModelSelection } from '../../../types';
import type { ModelExecutionProfile, NormalizedModelExecutionProtocol, VideoModelCapability } from '../../../types/aiTypes';
import { isSafeNativeProtocolTaskId } from '../../nativeProtocolContext';
import { readModelProtocolFirstScalar, readModelProtocolUrls } from '../modelProtocolResponse';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import type { CanonicalVideoRequest } from '../videoRequestResolver';
import { assertSandReferenceLayout, sandPublicUrl, SAND_VIDEO_MODEL_ID } from './sandVideoContract';

const MODES = ['text-to-video', 'image-to-video', 'reference-to-video'] as const;
type Mode = typeof MODES[number];
const MAGI_ID = SAND_VIDEO_MODEL_ID;
const DURATIONS = Array.from({ length: 27 }, (_, index) => index + 4);
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const RANGE = { min: 2, max: 30 };
const MEDIA_DURATION = { durationSeconds: RANGE, totalDurationSeconds: { max: 30 } };

export const MAGI_VIDEO_GATEWAYS = [
  {
    id: 'higgsfield', name: 'Higgsfield', badgeText: 'HF', origin: 'https://api.higgsfield.ai',
    docs: 'https://open.higgsfield.ai/models/sand/magi-2/text-to-video/api-reference',
    keyHint: 'KEY_ID:KEY_SECRET', queryPrefix: '/requests/', querySuffix: '/status',
    queryId: 'higgsfield-magi-v1', idPath: 'request_id', statusPath: 'status', urlPath: 'video.url',
    active: ['queued', 'in_progress'], success: 'completed', failed: ['failed', 'nsfw', 'canceled'],
    createStatuses: [200, 201, 202], interval: 10_000, promptMax: 15_000,
  },
  {
    id: 'beatapi', name: 'BeatAPI', badgeText: 'BA', origin: 'https://api.beatapi.io',
    docs: 'https://docs.beatapi.io/api-reference/video-api/magi-2',
    keyHint: 'BeatAPI API Key', queryPrefix: '/v1/tasks/', querySuffix: '',
    queryId: 'beatapi-magi-v1', idPath: 'data.id', statusPath: 'data.status', urlPath: 'data.output.media.*.url',
    active: ['queued', 'processing'], success: 'succeeded', failed: ['failed'],
    createStatuses: [201], interval: 8_000, promptMax: 5_000,
  },
  {
    id: 'nereo', name: 'Nereo', badgeText: 'NE', origin: 'https://api.nereo.io',
    docs: 'https://api.nereo.io/models/sand/magi-2/text-to-video',
    keyHint: 'Nereo API Key', queryPrefix: '/api/v1/requests/', querySuffix: '/status',
    queryId: 'nereo-magi-v1', idPath: 'request_id', statusPath: 'status', urlPath: 'outputs.*.url',
    active: ['queued', 'in_progress'], success: 'completed', failed: ['failed', 'nsfw'],
    createStatuses: [200], interval: 10_000, promptMax: 15_000,
  },
] as const;

type Gateway = typeof MAGI_VIDEO_GATEWAYS[number];

export function magiVideoGateway(catalogId: string | undefined, modelId = MAGI_ID): Gateway | undefined {
  if (modelId !== MAGI_ID) return undefined;
  return MAGI_VIDEO_GATEWAYS.find((entry) => entry.id === catalogId);
}

export function assertMagiGatewayOrigin(gateway: Gateway, baseUrl: string): string {
  if (baseUrl !== gateway.origin && baseUrl !== `${gateway.origin}/`) throw new Error(`${gateway.name} 需要使用官方 API 地址`);
  return gateway.origin;
}

export function magiGatewayCapability(gateway: Gateway, modelId: string): VideoModelCapability | undefined {
  if (modelId !== MAGI_ID) return undefined;
  return {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'],
    durations: DURATIONS, minDuration: 4, maxDuration: 30, defaultDuration: 5,
    resolutions: ['1080p'], defaultResolution: '1080p',
    ...(gateway.id === 'nereo' ? { frameRates: [25], defaultFrameRate: 25 } : {}),
    ratios: RATIOS, defaultRatio: '16:9',
    ...(gateway.id === 'beatapi' ? { inputModeCapabilities: { keyframe: { ratioFromFirstFrame: true } } } : {}),
    promptMaxCharacters: gateway.promptMax,
    supportsAudio: true, supportsStandaloneAudio: true, allowFrameAndReferenceMix: false,
    maxImageReferences: 10, maxVideoReferences: 5, maxAudioReferences: 5, maxVideoAudioReferences: 10,
    inputConstraints: {
      ...(gateway.id === 'beatapi' ? { promptMinCharacters: 1 } : {}),
      referenceVideo: MEDIA_DURATION, referenceAudio: MEDIA_DURATION,
    },
  };
}

function submitPath(gateway: Gateway, mode: Mode): string {
  if (gateway.id === 'beatapi') return '/v1/videos/tasks';
  return `${gateway.id === 'nereo' ? '/api/v1' : ''}/sand/magi-2/${mode}`;
}

export function magiGatewayProtocol(gateway: Gateway, mode: Mode = 'text-to-video'): NormalizedModelExecutionProtocol {
  return {
    version: 2, mode: 'async',
    auth: { type: 'bearer', ...(gateway.id === 'higgsfield' ? { prefix: 'Key ' } : {}) },
    submit: { method: 'POST', pathMode: 'origin', path: submitPath(gateway, mode),
      bodyEncoding: 'json', maxBodyBytes: 256 * 1024, body: '{{gatewayVideoBody}}' },
    response: { type: 'json', taskIdPath: gateway.idPath },
    poll: {
      magiGateway: true,
      method: 'GET', pathMode: 'origin', path: `${gateway.queryPrefix}{{submit.${gateway.idPath}}}${gateway.querySuffix}`,
      response: { statusPath: gateway.statusPath, successValues: [gateway.success], failureValues: [...gateway.failed],
        result: { urlPath: gateway.urlPath, mimeType: 'video/mp4' } },
      intervalMs: gateway.interval, maxDurationMs: 3_600_000,
      retry: { httpStatuses: [429, 500, 502, 503, 504], maxRetries: 5, backoff: 'exponential',
        maxDelayMs: 60_000, honorRetryAfter: true, retryNetworkErrors: true },
    },
  };
}

export function magiGatewayManifest(gateway: Gateway): ProviderModelSelection[] {
  return [{
    id: MAGI_ID, provider: gateway.id, name: 'MAGI-2', category: 'video',
    description: '支持文生、首帧、首尾帧及图／视频／音频参考，素材使用公开 HTTPS 地址',
    inputModalities: ['text', 'image'],
    videoCapability: magiGatewayCapability(gateway, MAGI_ID),
    executionProfile: { preset: 'custom', protocol: magiGatewayProtocol(gateway) },
  }];
}

export function compileMagiGatewayRequest(gateway: Gateway, request: CanonicalVideoRequest): {
  executionProfile: ModelExecutionProfile; variables: ModelProtocolVariables;
} {
  if (request.modelId !== MAGI_ID) throw new Error(`${gateway.name} 当前只提供内置 MAGI-2 合同`);
  const { inputMode, prompt, references, output } = request;
  assertSandReferenceLayout(prompt, references.all, 'ark');
  if (!prompt.trim() && (inputMode === 'text' || gateway.id === 'beatapi')) throw new Error('请填写 MAGI-2 提示词');
  if (references.all.some(({ url, provider }) => provider || !sandPublicUrl(url))) {
    throw new Error(`${gateway.name} 参考素材需要公开 HTTPS 地址。请先用该平台上传文件，再粘贴素材链接`);
  }
  const firstFrame = references.images.find(({ role }) => role === 'first_frame')?.url;
  const lastFrame = references.images.find(({ role }) => role === 'last_frame')?.url;
  if (inputMode === 'keyframe' && !firstFrame) throw new Error('请指定首帧图片');
  const mode = inputMode === 'text' ? 'text-to-video' : inputMode === 'keyframe' ? 'image-to-video' : 'reference-to-video';
  const beat = gateway.id === 'beatapi';
  const body: Record<string, string | number | boolean | string[]> = { resolution: '1080p', duration: output.durationSeconds };
  if (beat) body.model = MAGI_ID;
  if (prompt.trim()) body.prompt = prompt;
  if (output.aspectRatio && !(beat && firstFrame)) body.aspect_ratio = output.aspectRatio;
  if (output.audio.policy !== 'model-default') body.generate_audio = output.audio.policy === 'generate';
  if (firstFrame) {
    if (beat) body.images = lastFrame ? [firstFrame, lastFrame] : [firstFrame];
    else {
      body.image_url = firstFrame;
      if (lastFrame) body.end_image_url = lastFrame;
    }
  } else if (mode === 'reference-to-video') {
    for (const kind of ['image', 'video', 'audio'] as const) {
      const media = references[`${kind}s`];
      if (media.length) {
        const field = beat ? `reference_${kind}s` : `${gateway.id === 'nereo' ? 'reference_' : ''}${kind}_urls`;
        body[field] = media.map(({ url }) => url);
      }
    }
  }
  return { executionProfile: { preset: 'custom', protocol: magiGatewayProtocol(gateway, mode) },
    variables: { gatewayVideoBody: body } };
}

export function isMagiGatewayTaskId(gateway: Gateway, value: unknown, apiKey = ''): value is string {
  if (!isSafeNativeProtocolTaskId(value, [apiKey])) return false;
  if (gateway.id === 'nereo') return /^[A-Za-z0-9_-]{1,128}$/.test(value);
  return gateway.id === 'beatapi'
    ? /^task_[a-zA-Z0-9]{32}$/.test(value)
    : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

export function magiGatewayTaskRequest(url: string, method: string | undefined): { gateway: Gateway; taskId?: string } | undefined {
  const address = new URL(url);
  const gateway = MAGI_VIDEO_GATEWAYS.find((entry) => entry.origin === address.origin);
  if (!gateway) return undefined;
  const isSubmitPath = MODES.some((mode) => address.pathname === submitPath(gateway, mode));
  const isQueryPath = address.pathname.startsWith(gateway.queryPrefix) && address.pathname.endsWith(gateway.querySuffix);
  if (!isSubmitPath && !isQueryPath) return undefined;
  if (method === 'POST' && isSubmitPath && url === gateway.origin + address.pathname) return { gateway };
  const id = address.pathname.slice(gateway.queryPrefix.length, address.pathname.length - gateway.querySuffix.length);
  if (method === 'GET' && isMagiGatewayTaskId(gateway, id)
    && url === `${gateway.origin}${gateway.queryPrefix}${id}${gateway.querySuffix}`) return { gateway, taskId: id };
  throw new Error(`${gateway.name} MAGI-2 任务地址无效`);
}

export function validateMagiGatewayTask(gateway: Gateway, payload: unknown, expectedId: string | undefined, apiKey: string): void {
  const taskId = readModelProtocolFirstScalar(payload, gateway.idPath);
  if (!isMagiGatewayTaskId(gateway, taskId, apiKey) || expectedId !== undefined && expectedId !== taskId) {
    throw new Error(`${gateway.name} 未返回原任务的有效 ID`);
  }
  if (expectedId === undefined) return;
  const status = readModelProtocolFirstScalar(payload, gateway.statusPath);
  if (![...gateway.active, gateway.success, ...gateway.failed].some((state) => state === status)
    || gateway.id === 'beatapi' && readModelProtocolFirstScalar(payload, 'data.model') !== MAGI_ID
    || gateway.id === 'nereo' && !MODES.some((mode) => readModelProtocolFirstScalar(payload, 'endpoint_id') === `sand/magi-2/${mode}`)) {
    throw new Error(`${gateway.name} 未返回原任务的有效状态`);
  }
  if (status !== gateway.success) return;
  const urls = readModelProtocolUrls(payload, gateway.urlPath);
  if (urls.length !== 1 || urls.some((url) => !sandPublicUrl(url)
    || apiKey && [apiKey, apiKey.trim(), encodeURIComponent(apiKey)].some((secret) => secret && url.includes(secret)))) {
    throw new Error(`${gateway.name} 已完成原任务，但未返回可安全下载的视频地址`);
  }
}
