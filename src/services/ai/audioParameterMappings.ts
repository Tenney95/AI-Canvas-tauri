/**
 * ai/audioParameterMappings — 音频生成参数到各 Provider 请求字段的声明式映射。
 * 区分 TTS（语音合成）与 FlowMusic（音乐）两类模型模式，把 model、prompt、input、voice、
 * format、speed、soundPrompt、lyrics、title、bpm、length 等上层参数换算成各家 API 字段名，
 * 供 buildAudioSpeechRequestBody / buildAudioMusicRequestBody 生成请求体。
 */
import type { AIAudioGenParams, AudioOutputFormat, AudioTtsVoice } from '../../types/aiTypes';
import { mapParameterFields } from './parameterMappings';

export type AudioParameterKey =
  | 'model'
  | 'prompt'
  | 'batchCount'
  | 'input'
  | 'voice'
  | 'format'
  | 'speed'
  | 'soundPrompt'
  | 'lyrics'
  | 'title'
  | 'bpm'
  | 'length';

export interface AudioParameterMapping {
  providerId: string;
  modelPattern?: RegExp;
  fields: Partial<Record<AudioParameterKey, string>>;
  staticFields?: Record<string, unknown>;
}

const DEFAULT_AUDIO_MAPPING: AudioParameterMapping = {
  providerId: '*',
  fields: { model: 'model', prompt: 'prompt', batchCount: 'n', input: 'input', voice: 'voice', format: 'response_format', speed: 'speed', soundPrompt: 'sound_prompt', lyrics: 'lyrics', title: 'title', bpm: 'bpm', length: 'length' },
};

export const AUDIO_PARAMETER_MAPPINGS: readonly AudioParameterMapping[] = [
  {
    providerId: 'apimart',
    modelPattern: /tts|speech|voice/i,
    fields: { model: 'model', prompt: 'prompt', batchCount: 'n', input: 'input', voice: 'voice', format: 'response_format', speed: 'speed' },
  },
  {
    providerId: 'apimart',
    modelPattern: /flowmusic|music/i,
    fields: { model: 'model', soundPrompt: 'sound_prompt', lyrics: 'lyrics', title: 'title', bpm: 'bpm', length: 'length' },
    staticFields: { model: 'flowmusic' },
  },
  {
    providerId: 'standard',
    fields: { model: 'model', input: 'input', voice: 'voice', format: 'response_format', speed: 'speed' },
  },
];

export function resolveAudioParameterMapping(providerId: string, modelId = ''): AudioParameterMapping {
  const normalizedProvider = providerId.trim().toLowerCase();
  const providerMatch = AUDIO_PARAMETER_MAPPINGS.find((mapping) =>
    mapping.providerId === normalizedProvider
      && (!mapping.modelPattern || mapping.modelPattern.test(modelId)),
  );
  if (providerMatch) return providerMatch;
  if (normalizedProvider === 'standard') {
    return AUDIO_PARAMETER_MAPPINGS.find((mapping) => mapping.providerId === 'standard') ?? DEFAULT_AUDIO_MAPPING;
  }
  return DEFAULT_AUDIO_MAPPING;
}

export function mapAudioParameters(
  providerId: string,
  modelId: string,
  values: Partial<Record<AudioParameterKey, unknown>>,
): Record<string, unknown> {
  return mapParameterFields(resolveAudioParameterMapping(providerId, modelId), values);
}

export interface AudioSpeechMappingInput {
  model: string;
  input: string;
  voice: AudioTtsVoice;
  format: AudioOutputFormat;
  speed: number;
}

export function buildAudioSpeechRequestBody(input: AudioSpeechMappingInput): Record<string, unknown> {
  return mapAudioParameters('apimart', input.model, input);
}

export function buildAudioMusicRequestBody(
  params: Pick<AIAudioGenParams, 'musicTitle' | 'musicLyrics' | 'musicBpm' | 'musicDuration'> & { soundPrompt?: string },
): Record<string, unknown> {
  return mapAudioParameters('apimart', 'flowmusic', {
    soundPrompt: params.soundPrompt,
    lyrics: params.musicLyrics,
    title: params.musicTitle,
    bpm: params.musicBpm === undefined ? undefined : String(Math.max(1, Math.round(params.musicBpm))),
    length: params.musicDuration === undefined ? undefined : Math.min(240, Math.max(1, Math.round(params.musicDuration))),
  });
}
