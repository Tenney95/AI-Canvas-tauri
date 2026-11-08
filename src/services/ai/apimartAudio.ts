/** APIMart TTS、Whisper 转录与 Flow Music 协议适配。 */
import type {
  AudioGenerationResult,
  AudioOutputFormat,
  AudioTtsVoice,
} from '../../types/aiTypes';
import { buildAuthHeaders, getHttpResponseError, parseResponseError } from './httpUtils';
import { corsSafeFetch } from './httpTransport';
import { ModelProtocolHttpError, redactModelProtocolError, redactModelProtocolErrorText, throwIfDefinitiveModelResponseFailure } from './modelProtocolHttp';
import {
  getAudioCapability,
  type AudioCapabilityKind,
} from './mediaModelCapabilities';
import { buildAudioMusicRequestBody, buildAudioSpeechRequestBody } from './audioParameterMappings';

export type ApimartAudioCapability = AudioCapabilityKind;

export type WhisperResponseFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';

export interface WhisperTranscriptionRequest {
  file: Blob;
  fileName: string;
  language?: string;
  prompt?: string;
  responseFormat?: WhisperResponseFormat;
  temperature?: number;
}

export interface FlowMusicGenerationRequest {
  version?: 'lyria-3.5';
  soundPrompt?: string;
  lyrics?: string;
  title?: string;
  bpm?: number;
  length?: number;
  seed?: string;
}

export interface FlowMusicTrack {
  clip_id?: string;
  title?: string;
  lyrics?: string;
  audio_url?: string;
  wav_url?: string;
  url?: string;
}

export interface FlowMusicLyrics {
  title?: string;
  lyrics?: string;
}

export interface FlowMusicTaskState {
  status?: string;
  error?: string | { message?: string; code?: string; type?: string };
  progress?: number;
  result?: {
    music?: FlowMusicTrack[];
    lyrics?: FlowMusicLyrics[];
  };
}

export function getApimartAudioCapability(model: string): ApimartAudioCapability | undefined {
  return getAudioCapability(model);
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function readTaskId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return '';
  const taskId = (data[0] as { task_id?: unknown } | undefined)?.task_id;
  return typeof taskId === 'string' ? taskId : '';
}

/** 通用解析器会截断纯文本错误，先脱敏，避免留下跨截断位置的 Key 前缀。 */
async function throwApimartResponseError(response: Response, label: string, apiKey: string): Promise<never> {
  const body = await response.text().catch(() => '');
  return parseResponseError(new Response(redactModelProtocolErrorText(body, apiKey), {
    status: response.status, headers: response.headers,
  }), label);
}

async function submitFlowMusicTask(
  apiKey: string,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  errorLabel: string,
  signal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<string> {
  try {
    if (beforeSubmit) await beforeSubmit();
    signal?.throwIfAborted();
    const response = await corsSafeFetch(endpoint(baseUrl, path), {
      method: 'POST',
      headers: buildAuthHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      try {
        await throwApimartResponseError(response, `${errorLabel} (${response.status})`, apiKey);
      } catch (error) {
        throw new ModelProtocolHttpError(response.status,
          redactModelProtocolErrorText(error instanceof Error ? error.message : errorLabel, apiKey),
          undefined, getHttpResponseError(error)?.definitiveFailure);
      }
    }
    const payload: unknown = await response.json();
    const taskId = readTaskId(payload);
    if (!taskId) {
      const record = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : undefined;
      if (typeof record?.code === 'number' && Number.isInteger(record.code)
        && record.code >= 400 && record.code < 500 && record.code !== 408) {
        const detail = typeof record.message === 'string' ? record.message : typeof record.msg === 'string' ? record.msg : '';
        throw new ModelProtocolHttpError(response.status,
          redactModelProtocolErrorText(detail.trim() || `${errorLabel}（业务码 ${record.code}）`, apiKey), undefined, true);
      }
      throwIfDefinitiveModelResponseFailure(payload, response.status, undefined, apiKey);
      throw new Error(`${errorLabel}：未返回 task_id`);
    }
    return taskId;
  } catch (error) {
    throw redactModelProtocolError(error, apiKey);
  }
}

export async function generateApimartSpeech(
  apiKey: string,
  baseUrl: string,
  params: {
    model: string;
    input: string;
    voice: AudioTtsVoice;
    format: AudioOutputFormat;
    speed: number;
  },
  signal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<AudioGenerationResult> {
  try {
    if (!params.input.trim()) throw new Error('TTS 文本不能为空');
    if (params.input.length > 4096) throw new Error('TTS 文本不能超过 4096 个字符');
    if (params.speed < 0.25 || params.speed > 4) throw new Error('TTS 语速必须在 0.25 到 4 之间');

    if (beforeSubmit) await beforeSubmit();
    signal?.throwIfAborted();
    const response = await corsSafeFetch(endpoint(baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: buildAuthHeaders(apiKey),
      body: JSON.stringify(buildAudioSpeechRequestBody(params)),
      signal,
    });
    if (!response.ok) {
      await throwApimartResponseError(response, `APIMart TTS 生成失败 (${response.status})`, apiKey);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('APIMart TTS 生成完成但未返回音频数据');
    if (/\bjson\b|\+json\b/i.test(response.headers.get('Content-Type') || '')) {
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error('APIMart TTS 返回无效 JSON，未返回音频数据'); }
      throwIfDefinitiveModelResponseFailure(payload, response.status, undefined, apiKey);
      throw new Error('APIMart TTS 返回 JSON，未返回音频数据');
    }
    const blob = new Blob([bytes], {
      type: response.headers.get('Content-Type') || `audio/${params.format}`,
    });
    return { url: URL.createObjectURL(blob), bytes, format: params.format };
  } catch (error) {
    throw redactModelProtocolError(error, apiKey);
  }
}

export async function transcribeApimartAudio(
  apiKey: string,
  baseUrl: string,
  request: WhisperTranscriptionRequest,
): Promise<string> {
  try {
    const responseFormat = request.responseFormat ?? 'json';
    if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 1)) {
      throw new Error('Whisper temperature 必须在 0 到 1 之间');
    }

    const formData = new FormData();
    formData.append('file', request.file, request.fileName);
    formData.append('model', 'whisper-1');
    formData.append('response_format', responseFormat);
    if (request.language?.trim()) formData.append('language', request.language.trim());
    if (request.prompt?.trim()) formData.append('prompt', request.prompt.trim());
    if (request.temperature !== undefined) {
      formData.append('temperature', String(request.temperature));
    }

    const response = await corsSafeFetch(endpoint(baseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      await throwApimartResponseError(response, `APIMart Whisper 转录失败 (${response.status})`, apiKey);
    }

    if (responseFormat === 'json' || responseFormat === 'verbose_json') {
      const payload = await response.json() as { text?: unknown };
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) throw new Error('APIMart Whisper 转录完成但未返回文本');
      return text;
    }

    const text = (await response.text()).trim();
    if (!text) throw new Error('APIMart Whisper 转录完成但未返回文本');
    return text;
  } catch (error) {
    throw redactModelProtocolError(error, apiKey);
  }
}

export function submitFlowMusicLyrics(
  apiKey: string,
  baseUrl: string,
  prompt: string,
  signal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<string> {
  if (!prompt.trim()) throw new Error('歌词生成提示词不能为空');
  if (prompt.length > 3000) throw new Error('歌词生成提示词不能超过 3000 个字符');
  return submitFlowMusicTask(
    apiKey,
    baseUrl,
    '/music/generations/lyricsFlowMusic',
    { model: 'flowmusic', prompt },
    'APIMart 歌词任务提交失败',
    signal,
    beforeSubmit,
  );
}

export function submitFlowMusicGeneration(
  apiKey: string,
  baseUrl: string,
  request: FlowMusicGenerationRequest,
  signal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<string> {
  const soundPrompt = request.soundPrompt?.trim();
  const lyrics = request.lyrics?.trim();
  if (!soundPrompt && !lyrics) throw new Error('Flow Music 的风格提示词和歌词不能同时为空');

  const body: Record<string, unknown> = buildAudioMusicRequestBody({
    soundPrompt,
    musicLyrics: lyrics,
    musicTitle: request.title?.trim(),
    musicBpm: request.bpm,
    musicDuration: request.length,
  });
  if (request.bpm !== undefined) {
    if (!Number.isFinite(request.bpm)) throw new Error('Flow Music BPM 必须是有效数字');
    body.bpm = String(Math.max(1, Math.round(request.bpm)));
  }
  if (request.length !== undefined) {
    if (!Number.isFinite(request.length)) throw new Error('Flow Music 时长必须是有效数字');
    body.length = Math.min(240, Math.max(1, Math.round(request.length)));
  }
  if (request.seed?.trim()) body.seed = request.seed.trim();
  if (request.version) body.version = request.version;

  return submitFlowMusicTask(
    apiKey,
    baseUrl,
    '/music/generations',
    body,
    'APIMart 音乐任务提交失败',
    signal,
    beforeSubmit,
  );
}

/** Suno 与 Flow Music 共用提交和查询路径；版本及歌词字段必须分别映射。 */
export function submitSunoGeneration(
  apiKey: string,
  baseUrl: string,
  request: { version: 'v6' | 'v6-wild' | 'v6-mini'; prompt: string; lyrics?: string; title?: string; duration?: number },
  signal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<string> {
  const lyrics = request.lyrics?.trim();
  const custom = Boolean(lyrics);
  const prompt = custom ? lyrics! : request.prompt.trim();
  if (!prompt) throw new Error('Suno 提示词或歌词不能为空');
  if (Array.from(prompt).length > (custom ? 5000 : 3000)) throw new Error('Suno 提示词或歌词超过长度限制');
  if (custom && Array.from(request.prompt).length > 1000) throw new Error('Suno 风格不能超过 1000 个字符');
  if (custom && Array.from(request.title ?? '').length > 80) throw new Error('Suno 标题不能超过 80 个字符');
  if (custom && request.duration !== undefined
    && (!Number.isInteger(request.duration) || request.duration < 10 || request.duration > 360)) throw new Error('Suno 时长必须是 10–360 秒的整数');
  return submitFlowMusicTask(apiKey, baseUrl, '/music/generations', {
    model: 'suno', version: request.version, custom, prompt,
    ...(custom ? { style: request.prompt.trim(), title: request.title?.trim(), duration: request.duration } : {}),
  }, 'APIMart Suno 音乐任务提交失败', signal, beforeSubmit);
}

export async function fetchFlowMusicTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<FlowMusicTaskState> {
  try {
    const response = await corsSafeFetch(endpoint(baseUrl, `/music/tasks/${encodeURIComponent(taskId)}?language=zh`), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!response.ok) {
      await throwApimartResponseError(response, `APIMart 音乐任务查询失败 (${response.status})`, apiKey);
    }
    const raw = await response.json() as { data?: FlowMusicTaskState } & FlowMusicTaskState;
    const task = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    // 失败详情还会进入轮询回执和消息，不能等界面显示时再移除凭据。
    return { ...task, ...(task.error ? { error: typeof task.error === 'string'
      ? redactModelProtocolErrorText(task.error, apiKey)
      : {
        ...(typeof task.error.message === 'string' ? { message: redactModelProtocolErrorText(task.error.message, apiKey) } : {}),
        ...(typeof task.error.code === 'string' ? { code: redactModelProtocolErrorText(task.error.code, apiKey) } : {}),
        ...(typeof task.error.type === 'string' ? { type: redactModelProtocolErrorText(task.error.type, apiKey) } : {}),
      } } : {}) };
  } catch (error) {
    throw redactModelProtocolError(error, apiKey);
  }
}

export function extractFlowMusicLyrics(task: FlowMusicTaskState): Required<FlowMusicLyrics> {
  const item = task.result?.lyrics?.[0];
  const lyrics = item?.lyrics?.trim();
  if (!lyrics) throw new Error('APIMart 歌词生成完成但未返回歌词');
  return { title: item?.title?.trim() || '', lyrics };
}

export function extractFlowMusicTrack(task: FlowMusicTaskState): AudioGenerationResult {
  const item = task.result?.music?.[0];
  const url = item?.audio_url || item?.url || item?.wav_url;
  if (!url) throw new Error('APIMart 音乐生成完成但未返回音频地址');
  return {
    url,
    clipId: item?.clip_id,
    title: item?.title,
    lyrics: item?.lyrics,
  };
}

/** 原任务可能包含多个音轨；原生恢复必须保留全部结果，不能取首项冒充完成。 */
export function extractFlowMusicTracks(task: FlowMusicTaskState): AudioGenerationResult[] {
  const tracks = task.result?.music;
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > 128) throw new Error('原音乐任务音轨集合缺失或超过上限');
  return tracks.map((track) => extractFlowMusicTrack({ result: { music: [track] } }));
}
