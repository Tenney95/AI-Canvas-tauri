/** 音频转录入口：解析 APIMart 配置、校验音频并调用 Whisper。 */
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { useAppStore } from '../../store/useAppStore';
import {
  transcribeApimartAudio,
  type WhisperResponseFormat,
} from './apimartAudio';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm']);

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mpga',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/webm': 'webm',
};

export interface TranscribeAudioOptions {
  audioUrl: string;
  fileName?: string;
  language?: string;
  prompt?: string;
  responseFormat?: WhisperResponseFormat;
  temperature?: number;
}

function extensionOf(fileName?: string): string {
  const match = fileName?.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function resolveUploadName(fileName: string | undefined, mimeType: string): string {
  const fileExtension = extensionOf(fileName);
  if (fileExtension && !SUPPORTED_EXTENSIONS.has(fileExtension)) {
    throw new Error('Whisper 仅支持 mp3、mp4、mpeg、mpga、m4a、wav 和 webm 格式');
  }
  if (fileExtension) return fileName!.trim();

  const mimeExtension = MIME_EXTENSIONS[mimeType.toLowerCase()];
  if (!mimeExtension) {
    throw new Error('无法识别音频格式；Whisper 仅支持 mp3、mp4、mpeg、mpga、m4a、wav 和 webm');
  }
  return `audio.${mimeExtension}`;
}

async function readAudioBlob(audioUrl: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(audioUrl);
  } catch {
    throw new Error('无法读取音频文件，请确认文件仍可访问');
  }
  if (!response.ok) throw new Error(`读取音频文件失败 (${response.status})`);

  const blob = await response.blob();
  if (blob.size === 0) throw new Error('音频文件为空，无法转录');
  if (blob.size > MAX_AUDIO_BYTES) throw new Error('Whisper 转录文件不能超过 25 MB');
  return blob;
}

export async function transcribeAudio(options: TranscribeAudioOptions): Promise<string> {
  if (!options.audioUrl) throw new Error('没有可转录的音频');

  const providerConfig = useAppStore.getState().config.providers.apimart;
  const apiKey = providerConfig?.apiKey || '';
  if (!apiKey) throw new Error('请先在设置中配置 APIMart API Key');

  const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.apimart || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先在设置中配置 APIMart 服务地址');

  const blob = await readAudioBlob(options.audioUrl);
  const fileName = resolveUploadName(options.fileName, blob.type);
  return transcribeApimartAudio(apiKey, baseUrl, {
    file: blob,
    fileName,
    language: options.language,
    prompt: options.prompt,
    responseFormat: options.responseFormat,
    temperature: options.temperature,
  });
}
