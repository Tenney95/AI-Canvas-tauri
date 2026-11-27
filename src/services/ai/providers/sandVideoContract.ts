import type { ProviderModelSelection } from '../../../types';
import type { MediaReference, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue, VideoModelCapability } from '../../../types/aiTypes';
import { isRemoteMediaUrl } from '../../../utils/mediaUrl';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import type { CanonicalVideoRequest } from '../videoRequestResolver';

export const SAND_VIDEO_MODEL_ID = 'magi-2';
export const SAND_ARK_TASKS_PATH = '/compatible/ark/api/v3/contents/generations/tasks';
export const SAND_V2_TASKS_PATH = '/v2/generations';
export const SAND_ASSETS_PATH = '/v1/assets';
export const SAND_SITES = [
  { id: 'sand-ai', origin: 'https://api.sand.ai', name: 'Sand AI 国际站', docs: 'https://platform.sand.ai' },
  { id: 'sand-ai-cn', origin: 'https://api.sandai.cn', name: 'Sand AI 中国站', docs: 'https://platform.sandai.cn' },
] as const;

export type SandVariant = 'ark' | 'v2';
const SAND_TASKS = {
  ark: { path: SAND_ARK_TASKS_PATH, createStatus: 200, active: ['queued', 'running'], failed: ['failed', 'expired', 'cancelled'], resultPath: 'content.video_url' },
  v2: { path: SAND_V2_TASKS_PATH, createStatus: 202, active: ['queued', 'processing'], failed: ['failed', 'canceled'], resultPath: 'output.videoUrl' },
} as const;

export const SAND_CONNECTIONS = SAND_SITES.flatMap((site) => [
  { ...site, variant: 'ark' as const, name: `${site.name} · Ark`, queryId: `${site.id}-ark-v1` },
  { ...site, variant: 'v2' as const, id: `${site.id}-v2`, name: `${site.name} · 原生 v2`, queryId: `${site.id}-native-v2` },
]);

export function sandSite(catalogId: string | undefined, modelId = SAND_VIDEO_MODEL_ID) {
  if (modelId !== SAND_VIDEO_MODEL_ID) return undefined;
  return SAND_CONNECTIONS.find((site) => site.id === catalogId);
}

export function assertSandOrigin(catalogId: string, baseUrl: string): string {
  const site = sandSite(catalogId);
  if (!site || (baseUrl !== site.origin && baseUrl !== `${site.origin}/`)) {
    throw new Error('Sand AI 连接需要使用所选站点的官方 API 地址');
  }
  return site.origin;
}

const INPUT_DURATION = { min: 2, max: 30 };
export const SAND_ARK_CAPABILITY: VideoModelCapability = {
  operations: ['text-to-video', 'image-to-video', 'video-to-video'],
  resolutions: ['1080p'], defaultResolution: '1080p',
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], defaultRatio: '16:9',
  durations: Array.from({ length: 27 }, (_, index) => 4 + index),
  minDuration: 4, maxDuration: 30, defaultDuration: 5,
  frameRates: [25], defaultFrameRate: 25,
  promptMaxCharacters: 15_000,
  supportsAudio: true, supportsStandaloneAudio: true, allowFrameAndReferenceMix: false,
  maxImageReferences: 10, maxVideoReferences: 5, maxAudioReferences: 5, maxVideoAudioReferences: 10,
  inputConstraints: {
    referenceVideo: { durationSeconds: INPUT_DURATION, totalDurationSeconds: { max: 30 } },
    referenceAudio: { durationSeconds: INPUT_DURATION, totalDurationSeconds: { max: 30 } },
  },
};

const SAND_V2_CAPABILITY: VideoModelCapability = {
  ...SAND_ARK_CAPABILITY,
  supportsKeyframes: false,
  inputConstraints: { ...SAND_ARK_CAPABILITY.inputConstraints, promptMinCharacters: 1 },
};

export function sandVideoCapability(variant: SandVariant): VideoModelCapability {
  return variant === 'v2' ? SAND_V2_CAPABILITY : SAND_ARK_CAPABILITY;
}

export function sandProtocolFor(catalogId: string): NormalizedModelExecutionProtocol {
  const site = sandSite(catalogId);
  if (!site) throw new Error('Sand AI 连接协议未知');
  const native = site.variant === 'v2';
  const task = SAND_TASKS[site.variant];
  return {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path: task.path, pathMode: 'origin', bodyEncoding: 'json', maxBodyBytes: 256 * 1024, body: {
      model: SAND_VIDEO_MODEL_ID,
      [native ? 'parts' : 'content']: '{{sandContent}}', duration: '{{duration}}',
      [native ? 'aspectRatio' : 'ratio']: '{{aspectRatio}}',
      resolution: '1080p', [native ? 'generateAudio' : 'generate_audio']: '{{generateAudio}}',
      ...(site.origin === 'https://api.sandai.cn' ? { watermark: false } : {}),
    } },
    response: { type: 'json', taskIdPath: 'id' },
    poll: {
      method: 'GET', path: `${task.path}/{{submit.id}}`, pathMode: 'origin',
      response: { statusPath: 'status', successValues: ['succeeded'], failureValues: [...task.failed],
        result: { urlPath: task.resultPath, mimeType: 'video/mp4' } },
      intervalMs: 20_000, maxDurationMs: 3_600_000,
      retry: { httpStatuses: [429, 500, 502, 503, 504], maxRetries: 5, backoff: 'exponential',
        maxDelayMs: 60_000, honorRetryAfter: true, retryNetworkErrors: true },
    },
  };
}

export function sandProfile(catalogId: string, modelId: string): ModelExecutionProfile {
  if (modelId !== SAND_VIDEO_MODEL_ID) throw new Error('Sand AI 官方连接当前仅支持 MAGI-2');
  return { preset: 'custom', protocol: sandProtocolFor(catalogId) };
}

export function sandModelManifest(catalogId: string): ProviderModelSelection[] {
  const site = sandSite(catalogId);
  if (!site) return [];
  return [{
    id: SAND_VIDEO_MODEL_ID, name: 'MAGI-2', provider: catalogId, category: 'video',
    description: site.variant === 'v2' ? 'Sand AI 原生 1080p 视频，支持图／视频／音频参考，需填写提示词'
      : 'Sand AI 官方 1080p 视频，支持首尾帧和图／视频／音频参考',
    inputModalities: ['text', 'image'],
    videoCapability: structuredClone(sandVideoCapability(site.variant)), executionProfile: sandProfile(catalogId, SAND_VIDEO_MODEL_ID),
  }];
}

export function isSandId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
    && (value.length < 19 || value <= '9223372036854775807');
}

export function sandTaskRequest(url: string, method: string | undefined) {
  const address = new URL(url);
  const site = SAND_CONNECTIONS.find((entry) => address.origin === entry.origin
    && (address.pathname === SAND_TASKS[entry.variant].path || address.pathname.startsWith(`${SAND_TASKS[entry.variant].path}/`)));
  if (!site) return undefined;
  const task = SAND_TASKS[site.variant];
  const taskUrl = `${site.origin}${task.path}`;
  if (method === 'POST' && url === taskUrl) return { site, createStatus: task.createStatus };
  const taskId = address.pathname.slice(task.path.length + 1);
  if (method === 'GET' && isSandId(taskId) && url === `${taskUrl}/${taskId}`) return { site, taskId, createStatus: task.createStatus };
  throw new Error('Sand AI 任务请求地址无效');
}

export function validateSandTask(payload: unknown, expectedId?: string, apiKey = '', variant: SandVariant = 'ark'): void {
  if (!payload || typeof payload !== 'object') throw new Error('Sand AI 未返回有效任务');
  const { id, model, status, content, output } = payload as {
    id?: unknown; model?: unknown; status?: unknown; content?: { video_url?: unknown }; output?: { videoUrl?: unknown };
  };
  if (!isSandId(id) || apiKey && id.includes(apiKey)) throw new Error('Sand AI 未返回可保存的任务 ID');
  if (expectedId === undefined) return;
  const task = SAND_TASKS[variant];
  if (id !== expectedId || variant === 'ark' && model !== SAND_VIDEO_MODEL_ID
    || typeof status !== 'string' || !(status === 'succeeded'
      || task.active.some((state) => state === status) || task.failed.some((state) => state === status))) {
    throw new Error('Sand AI 未返回原任务的有效状态');
  }
  const result = variant === 'v2' ? output?.videoUrl : content?.video_url;
  if (status === 'succeeded' && (typeof result !== 'string' || !sandPublicUrl(result)
    || apiKey && [apiKey, apiKey.trim(), encodeURIComponent(apiKey)].some((secret) => secret && result.includes(secret)))) {
    throw new Error('Sand AI 原任务成功，但没有可安全下载的视频地址，请续查原任务');
  }
}

export function sandPublicUrl(value: string): boolean {
  if (value.length > 8192 || !isRemoteMediaUrl(value) || !/^https:\/\//i.test(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && !/(^|\.)localhost\.?$/i.test(url.hostname);
}

export function mergeSandReferences(references: readonly MediaReference[]): MediaReference[] {
  const explicitFrames = new Set<string>();
  for (const reference of references) {
    if (reference.kind === 'image' && (reference.role === 'first_frame' || reference.role === 'last_frame')) {
      explicitFrames.add(reference.url.trim());
    }
  }
  const seen = new Set<string>();
  const merged: MediaReference[] = [];
  for (const reference of references) {
    const url = reference.url.trim();
    if (reference.kind === 'image' && reference.role === 'reference' && explicitFrames.has(url)) continue;
    const key = `${reference.kind}:${reference.role}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(reference);
  }
  return merged;
}

export function assertSandReferenceLayout(prompt: string, references: readonly MediaReference[], variant: SandVariant): void {
  if (!prompt.trim() && (variant === 'v2' || !references.length)) throw new Error('请填写 MAGI-2 提示词');
  let first = 0, last = 0;
  for (const reference of references) {
    if (reference.role === 'reference' || reference.kind === 'audio' && reference.role === 'reference_audio') continue;
    if (variant === 'v2') throw new Error('MAGI-2 原生 v2 只接受普通参考素材。请将素材设为参考，或选择 Ark 连接使用首尾帧');
    if (reference.kind !== 'image') throw new Error('MAGI-2 首尾帧必须使用图片');
    if (reference.role === 'first_frame') first++;
    else if (reference.role === 'last_frame') last++;
    else throw new Error('MAGI-2 参考素材的类型与角色不匹配');
  }
  if (last > first || first > 1 || last > 1) throw new Error('MAGI-2 需要一张首帧，最多搭配一张尾帧');
  if (first && references.length !== first + last) throw new Error('MAGI-2 首尾帧与普通参考素材互斥');
}

export function sandVariables(request: CanonicalVideoRequest, variant: SandVariant, uploadedIds?: ReadonlyMap<MediaReference, string>): ModelProtocolVariables {
  const { prompt, references, output } = request;
  assertSandReferenceLayout(prompt, references.all, variant);
  const content: ProtocolJsonValue[] = [];
  if (prompt.trim()) content.push({ type: 'text', text: prompt });
  for (const reference of references.all) {
    const assetId = uploadedIds?.get(reference);
    if (assetId !== undefined ? !isSandId(assetId) : !sandPublicUrl(reference.url)) {
      throw new Error('MAGI-2 参考素材需要公开 HTTPS 地址或本次上传的 Sand 素材');
    }
    if (variant === 'v2') {
      content.push({ type: `reference_${reference.kind}`, [reference.kind]: assetId ? { assetId } : { url: reference.url } });
      continue;
    }
    const type = `${reference.kind}_url`;
    content.push({ type, role: reference.role === 'first_frame' || reference.role === 'last_frame' ? reference.role : `reference_${reference.kind}`,
      [type]: { url: assetId ? `asset://${assetId}` : reference.url } });
  }
  return { sandContent: content, duration: output.durationSeconds, aspectRatio: output.aspectRatio,
    generateAudio: output.audio.policy === 'model-default' ? undefined : output.audio.policy === 'generate' };
}
