/** MiniMax 官方视频与语音合同（2026-11-05），真实生成待桌面验收。 */
import type { ProviderModelSelection } from '../../../types';
import type { AudioModelCapability, ModelExecutionProfile, ResolvedModelProtocolPoll } from '../../../types/aiTypes';
import { createH3QuickAdaptTemplate } from '../h3ModelCapabilities';
import { comparableProtocol } from '../modelProtocol';
import { ModelProtocolHttpError } from '../modelProtocolHttp';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import { isRecord } from '../modelProtocolShared';
import type { CanonicalVideoRequest } from '../videoRequestResolver';
import { PollTaskFailedError } from '../../pollTask';

export const MINIMAX_BASE_URL = 'https://api.minimax.cn';
const OFFICIAL_ORIGINS = new Set([MINIMAX_BASE_URL, 'https://api.minimax.io']);
const SPEECH_MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo']);
const MEDIA_UNREACHABLE = 'MiniMax 无法读取参考素材。请重新上传到当前 MiniMax 连接，或检查素材地址是否允许外部服务器访问；不要直接重复生成。';

/** 国内与国际连接分别持有自己的 Key、文件和任务，不把地址别名当作共享凭据。 */
export function resolveMinimaxBaseUrl(baseUrl?: string): string {
  let url: URL;
  try { url = new URL(baseUrl?.trim() || MINIMAX_BASE_URL); }
  catch { throw new Error('MiniMax 接口地址无效，请使用国内或国际官方 API 地址'); }
  if (!OFFICIAL_ORIGINS.has(url.origin) || url.username || url.password || url.search || url.hash
    || !/^\/(?:v1\/?)?$/.test(url.pathname)) {
    throw new Error('MiniMax 仅支持 https://api.minimax.cn 或 https://api.minimax.io 官方连接');
  }
  return url.origin;
}

function videoModel(id: string): ProviderModelSelection {
  const template = createH3QuickAdaptTemplate(id === 'MiniMax-H3-Max' ? 'h3-max' : 'h3-standard', 'minimax');
  const capability = template.capability;
  if (id === 'MiniMax-H3-Highspeed' || id === 'MiniMax-H3-Lite') {
    capability.resolutions = ['480P', '768P'];
    capability.defaultResolution = '768P';
  }
  if (id === 'MiniMax-H3-Lite') {
    capability.inputModeCapabilities = { ...capability.inputModeCapabilities,
      reference: { ratios: capability.ratios!.filter((ratio) => ratio !== 'adaptive'), defaultRatio: '16:9' } };
  }
  return { id, name: id, provider: 'minimax', category: 'video', inputModalities: ['text', 'image'],
    description: 'MiniMax 官方 H3；本地参考素材使用当前官方连接上传',
    videoCapability: capability, executionProfile: template.executionProfile };
}

/** 普通语音合成不上传参考音频克隆；可填平台已有的系统或自建音色 ID。 */
export function getMinimaxAudioCapability(modelId: string): AudioModelCapability | undefined {
  if (!SPEECH_MODELS.has(modelId)) return undefined;
  return { kind: 'speech', voiceInput: 'id', defaultVoice: 'male-qn-qingse',
    formats: ['mp3', 'wav', 'flac'], defaultFormat: 'mp3',
    speed: { min: 0.5, max: 2, step: 0.1, default: 1 }, supportsVoiceReference: false };
}

function speechModel(id: string): ProviderModelSelection {
  return { id, name: id, provider: 'minimax', category: 'audio', inputModalities: ['text'],
    description: 'MiniMax 官方语音合成；使用平台已有音色 ID，不自动克隆参考声音',
    executionProfile: { preset: 'custom', protocol: {
      version: 2, mode: 'sync', auth: { type: 'bearer' },
      submit: { method: 'POST', path: '/v1/t2a_v2', pathMode: 'origin', bodyEncoding: 'json', body: {
        model: '{{model}}', text: '{{prompt}}', stream: false, output_format: 'url',
        voice_setting: { voice_id: '{{audioVoice}}', speed: '{{audioSpeed}}' },
        audio_setting: { format: '{{audioFormat}}' },
      } },
      response: { type: 'json', errorPath: 'base_resp.status_msg', result: { urlPath: 'data.audio' } },
    } } };
}

export const MINIMAX_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  ...['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'].map(videoModel),
  ...[...SPEECH_MODELS].map(speechModel),
];
const MODEL_BY_ID = new Map(MINIMAX_MODEL_MANIFEST.map((model) => [model.id, model]));

/** 只补精确内置型号的缺省合同，不修改配置，也不覆盖用户显式协议。 */
export function resolveMinimaxExecutionProfile(modelId: string, profile?: ModelExecutionProfile): ModelExecutionProfile | undefined {
  return profile ?? (MODEL_BY_ID.get(modelId)?.executionProfile
    ? structuredClone(MODEL_BY_ID.get(modelId)!.executionProfile) : undefined);
}

export function usesMinimaxModelProtocol(modelId: string, profile?: ModelExecutionProfile): boolean {
  const known = MODEL_BY_ID.get(modelId);
  const actual = comparableProtocol(profile);
  return !!known && actual !== undefined && actual === comparableProtocol(known.executionProfile);
}

/** 官方多模态合同只转换参数，不重排或替换已上传的素材引用。 */
export function minimaxVideoVariables(request: CanonicalVideoRequest, variables: ModelProtocolVariables): ModelProtocolVariables {
  const model = MODEL_BY_ID.get(request.modelId);
  if (!model?.videoCapability) throw new Error('未找到 MiniMax 官方视频型号合同');
  const capability = model.videoCapability;
  if (!request.prompt.trim() || Array.from(request.prompt).length > 7000) throw new Error('MiniMax 视频提示词须为 1–7000 个字符');
  const duration = request.output.durationSeconds;
  if (!Number.isInteger(duration) || duration < capability.minDuration! || duration > capability.maxDuration!) {
    throw new Error(`MiniMax ${model.id} 视频时长须为 ${capability.minDuration}–${capability.maxDuration} 秒的整数`);
  }
  const resolution = capability.resolutions!.find((value) => value.toLowerCase() === request.output.resolutionPreset?.toLowerCase());
  if (!resolution) throw new Error(`MiniMax ${model.id} 不支持所选分辨率`);
  const first = request.references.images.filter((item) => item.role === 'first_frame').length;
  const last = request.references.images.filter((item) => item.role === 'last_frame').length;
  const ordinary = request.references.images.length - first - last;
  if (first > 1 || last > 1 || last > 0 && first !== 1) throw new Error('MiniMax 尾帧须与首帧配对，首帧和尾帧各最多一张');
  const keyframe = first + last > 0;
  if (keyframe && (ordinary || request.references.videos.length || request.references.audios.length)) {
    throw new Error('MiniMax 首尾帧与普通图片、视频、音频参考不能混用');
  }
  if (ordinary > 9 || request.references.videos.length > 3 || request.references.audios.length > 3) {
    throw new Error('MiniMax 最多支持 9 张参考图片、3 段参考视频和 3 段参考音频');
  }
  const mode = keyframe ? 'keyframe' : request.references.all.length ? 'reference' : 'text';
  const ratios = capability.inputModeCapabilities?.[mode]?.ratios ?? capability.ratios!;
  const ratio = keyframe ? 'adaptive' : request.output.aspectRatio ?? capability.inputModeCapabilities?.[mode]?.defaultRatio;
  if (!ratio || !ratios.includes(ratio)) throw new Error(`MiniMax ${model.id} 当前输入方式不支持所选比例`);
  return { ...variables, model: model.id, duration, seedanceResolution: resolution, aspectRatio: ratio };
}

export function minimaxAudioVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const capability = getMinimaxAudioCapability(modelId);
  if (!capability) throw new Error('未找到 MiniMax 官方语音型号合同');
  if (typeof variables.prompt !== 'string' || !variables.prompt.trim()) throw new Error('MiniMax 语音文本不能为空');
  if (typeof variables.prompt === 'string' && Array.from(variables.prompt).length > 10000) throw new Error('MiniMax 同步语音文本最多 10000 个字符');
  const voice = variables.audioVoice ?? capability.defaultVoice;
  if (typeof voice !== 'string' || !voice.trim() || voice.length > 256 || /[\p{Cc}\p{Cf}]/u.test(voice)
    || /^(?:https?:|file:|data:|mm_file:|bearer\s)/i.test(voice)) throw new Error('请填写有效的 MiniMax 平台音色 ID');
  const format = variables.audioFormat ?? capability.defaultFormat;
  if (typeof format !== 'string' || !capability.formats!.includes(format as 'mp3' | 'wav' | 'flac')) throw new Error('MiniMax 语音输出仅支持 mp3、wav 或 flac');
  const speed = variables.audioSpeed ?? capability.speed!.default;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('MiniMax 语速须为 0.5–2');
  for (const key of ['n', 'batchCount']) if (variables[key] !== undefined && variables[key] !== 1) throw new Error('MiniMax 每次仅生成一条语音');
  for (const key of ['musicTitle', 'musicLyrics', 'musicBpm', 'musicDuration', 'duration']) {
    if (variables[key] !== undefined && variables[key] !== '') throw new Error('MiniMax 普通语音合成不支持音乐参数');
  }
  for (const key of ['imageUrls', 'referenceImageUrls', 'videoUrls', 'referenceVideoUrls', 'audioUrls', 'referenceAudioUrls']) {
    const value = variables[key];
    if (Array.isArray(value) && value.length) throw new Error('MiniMax 普通语音合成不接收参考素材，音色克隆需单独创建平台音色');
  }
  return { ...variables, model: modelId, audioVoice: voice.trim(), audioFormat: format, audioSpeed: speed };
}

// https://platform.minimaxi.com/docs/api-reference/errorcode：只把已核实的明确拒绝码作为终态。
const REJECTED_CODES: Readonly<Record<number, string>> = {
  1002: '请求频率超限', 1004: '鉴权失败，请检查当前连接的 API Key', 1008: '账户余额不足',
  1026: '输入内容未通过平台审核', 1027: '输出内容未通过平台审核', 1039: 'Token 用量限制',
  2013: '请求参数无效', 20132: '音色或语音样本参数无效', 2042: '无权使用该音色',
  2043: '当前模型不支持该音色', 2049: 'API Key 无效', 2053: '积分不足',
  2054: '音色不存在', 2056: '套餐资源限制', 2057: '当前密钥不适用该接口',
};
function isUnreachableMedia(message: unknown): boolean {
  return typeof message === 'string' && /media\s+url\s+unreachable|(?:media|image|video|audio).{0,20}(?:unreachable|unable to (?:fetch|access))|素材.{0,8}无法访问/i.test(message);
}

/** 只替换安全提示，调用方保留真实 HTTP 状态和原错误分类。 */
export function getMinimaxMediaAccessHint(message: unknown): string | undefined {
  return isUnreachableMedia(message) ? MEDIA_UNREACHABLE : undefined;
}

export function assertMinimaxResponse(payload: unknown, requireBusinessStatus = false): void {
  if (!isRecord(payload)) throw new Error('MiniMax 响应必须是 JSON 对象');
  const error = isRecord(payload.error) ? payload.error : undefined;
  if (isUnreachableMedia(error?.message)) throw new ModelProtocolHttpError(200, MEDIA_UNREACHABLE, undefined, true);
  if (payload.base_resp === undefined && !requireBusinessStatus) return;
  if (!isRecord(payload.base_resp) || typeof payload.base_resp.status_code !== 'number'
    || !Number.isInteger(payload.base_resp.status_code)) throw new Error('MiniMax 响应缺少有效业务状态码');
  const code = payload.base_resp.status_code as number;
  if (code === 0) return;
  const detail = isUnreachableMedia(payload.base_resp.status_msg) ? MEDIA_UNREACHABLE : REJECTED_CODES[code];
  const definitive = REJECTED_CODES[code] !== undefined;
  throw new ModelProtocolHttpError(200, `MiniMax ${definitive ? '请求失败' : '状态待确认'}（业务码 ${code}）：${detail ?? '平台未确认处理结果，请保留原任务核对'}`,
    undefined, definitive);
}

export function assertMinimaxQueryResponse(payload: unknown): void {
  const task = isRecord(payload) && isRecord(payload.task) ? payload.task : undefined;
  if (task?.status === 'failed' || task?.status === 'cancelled') {
    if (isRecord(task.error) && isUnreachableMedia(task.error.message)) throw new PollTaskFailedError(MEDIA_UNREACHABLE);
    return;
  }
  assertMinimaxResponse(payload);
}

/** 恢复只认原任务的官方查询合同，不依据当前连接名或用户后来改写的协议。 */
export function usesMinimaxResolvedVideoPoll(poll: ResolvedModelProtocolPoll, taskId: string, originalOrigin?: string): boolean {
  let url: URL;
  try {
    url = new URL(poll.url);
    const origin = resolveMinimaxBaseUrl(url.origin);
    if (originalOrigin !== undefined && resolveMinimaxBaseUrl(originalOrigin) !== origin) return false;
  } catch { return false; }
  if (!taskId || url.username || url.password || url.search || url.hash
    || url.pathname !== `/v2/query/video_generation/${encodeURIComponent(taskId)}` || poll.method !== 'GET'
    || poll.auth?.type !== 'bearer' || Object.entries(poll.auth).some(([key, value]) => key !== 'type' && value !== undefined)
    || Object.keys(poll.headers ?? {}).length || poll.body !== undefined
    || poll.bodyEncoding !== undefined && poll.bodyEncoding !== 'json') return false;
  const allowed = new Set(['method', 'url', 'auth', 'headers', 'bodyEncoding', 'body', 'statusPath', 'successValues', 'failureValues',
    'resultUrlPath', 'resultMimeType', 'errorPath', 'intervalMs', 'maxAttempts', 'maxDurationMs', 'retry']);
  if (Object.entries(poll).some(([key, value]) => value !== undefined && !allowed.has(key))) return false;
  return poll.statusPath === 'task.status' && JSON.stringify(poll.successValues) === '["succeeded"]'
    && JSON.stringify(poll.failureValues) === '["failed","cancelled"]' && poll.resultUrlPath === 'task.content.url'
    && poll.resultMimeType === 'video/mp4' && poll.errorPath === 'task.error.message';
}
