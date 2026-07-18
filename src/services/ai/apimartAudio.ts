/** APIMart TTS、Whisper 转录与 Flow Music 协议适配。 */
import type {
  AudioGenerationResult,
  AudioOutputFormat,
  AudioTtsVoice,
} from '../../types/aiTypes';
import { buildAuthHeaders, parseResponseError } from './httpUtils';

export type ApimartAudioCapability = 'speech' | 'music';

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
  progress?: number;
  result?: {
    music?: FlowMusicTrack[];
    lyrics?: FlowMusicLyrics[];
  };
}

const APIMART_AUDIO_CAPABILITIES: Record<string, ApimartAudioCapability> = {
  'gpt-4o-mini-tts': 'speech',
  flowmusic: 'music',
};

export function getApimartAudioCapability(model: string): ApimartAudioCapability | undefined {
  return APIMART_AUDIO_CAPABILITIES[model.toLowerCase()];
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

async function submitFlowMusicTask(
  apiKey: string,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  errorLabel: string,
): Promise<string> {
  const response = await fetch(endpoint(baseUrl, path), {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await parseResponseError(response, `${errorLabel} (${response.status})`);
  }
  const taskId = readTaskId(await response.json());
  if (!taskId) throw new Error(`${errorLabel}：未返回 task_id`);
  return taskId;
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
): Promise<AudioGenerationResult> {
  if (!params.input.trim()) throw new Error('TTS 文本不能为空');
  if (params.input.length > 4096) throw new Error('TTS 文本不能超过 4096 个字符');
  if (params.speed < 0.25 || params.speed > 4) throw new Error('TTS 语速必须在 0.25 到 4 之间');

  const response = await fetch(endpoint(baseUrl, '/audio/speech'), {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify({
      model: params.model,
      input: params.input,
      voice: params.voice,
      response_format: params.format,
      speed: params.speed,
    }),
  });
  if (!response.ok) {
    await parseResponseError(response, `APIMart TTS 生成失败 (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('APIMart TTS 生成完成但未返回音频数据');
  const blob = new Blob([bytes], {
    type: response.headers.get('Content-Type') || `audio/${params.format}`,
  });
  return { url: URL.createObjectURL(blob), bytes, format: params.format };
}

export async function transcribeApimartAudio(
  apiKey: string,
  baseUrl: string,
  request: WhisperTranscriptionRequest,
): Promise<string> {
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

  const response = await fetch(endpoint(baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!response.ok) {
    await parseResponseError(response, `APIMart Whisper 转录失败 (${response.status})`);
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
}

export function submitFlowMusicLyrics(
  apiKey: string,
  baseUrl: string,
  prompt: string,
): Promise<string> {
  if (!prompt.trim()) throw new Error('歌词生成提示词不能为空');
  if (prompt.length > 3000) throw new Error('歌词生成提示词不能超过 3000 个字符');
  return submitFlowMusicTask(
    apiKey,
    baseUrl,
    '/music/generations/lyricsFlowMusic',
    { model: 'flowmusic', prompt },
    'APIMart 歌词任务提交失败',
  );
}

export function submitFlowMusicGeneration(
  apiKey: string,
  baseUrl: string,
  request: FlowMusicGenerationRequest,
): Promise<string> {
  const soundPrompt = request.soundPrompt?.trim();
  const lyrics = request.lyrics?.trim();
  if (!soundPrompt && !lyrics) throw new Error('Flow Music 的风格提示词和歌词不能同时为空');

  const body: Record<string, unknown> = { model: 'flowmusic' };
  if (soundPrompt) body.sound_prompt = soundPrompt;
  if (lyrics) body.lyrics = lyrics;
  if (request.title?.trim()) body.title = request.title.trim();
  if (request.bpm !== undefined) {
    if (!Number.isFinite(request.bpm)) throw new Error('Flow Music BPM 必须是有效数字');
    body.bpm = String(Math.max(1, Math.round(request.bpm)));
  }
  if (request.length !== undefined) {
    if (!Number.isFinite(request.length)) throw new Error('Flow Music 时长必须是有效数字');
    body.length = Math.min(240, Math.max(1, Math.round(request.length)));
  }
  if (request.seed?.trim()) body.seed = request.seed.trim();

  return submitFlowMusicTask(
    apiKey,
    baseUrl,
    '/music/generations',
    body,
    'APIMart 音乐任务提交失败',
  );
}

export async function fetchFlowMusicTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
): Promise<FlowMusicTaskState> {
  const response = await fetch(endpoint(baseUrl, `/music/tasks/${encodeURIComponent(taskId)}?language=zh`), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    await parseResponseError(response, `APIMart 音乐任务查询失败 (${response.status})`);
  }
  const raw = await response.json() as { data?: FlowMusicTaskState } & FlowMusicTaskState;
  return raw.data && typeof raw.data === 'object' ? raw.data : raw;
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
