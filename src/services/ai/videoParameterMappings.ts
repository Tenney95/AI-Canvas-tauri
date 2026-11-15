/**
 * ai/videoParameterMappings — 视频生成参数到各 Provider 请求字段的声明式映射。
 * 统一的上层参数（model、prompt、resolution、aspectRatio、duration、generateAudio
 * 及参考媒体 imageUrls / videoUrls / audioUrls）按厂商与模型模式换算成各家 API 的真实字段名，
 * 供各生成入口拼装视频请求体，避免在调用点散落 if/switch 硬编码。
 */
import { mapParameterFields } from './parameterMappings';

export type VideoParameterKey =
  | 'model'
  | 'prompt'
  | 'resolution'
  | 'aspectRatio'
  | 'duration'
  | 'generateAudio'
  | 'imageUrls'
  | 'videoUrls'
  | 'audioUrls';

export interface VideoParameterMapping {
  providerId: string;
  modelPattern?: RegExp;
  fields: Partial<Record<VideoParameterKey, string>>;
  staticFields?: Record<string, unknown>;
}

const DEFAULT_VIDEO_MAPPING: VideoParameterMapping = {
  providerId: '*',
  fields: { model: 'model', prompt: 'prompt', resolution: 'resolution', aspectRatio: 'aspect_ratio', duration: 'duration', generateAudio: 'generate_audio', imageUrls: 'image_urls', videoUrls: 'video_urls', audioUrls: 'audio_urls' },
};

/** 只收录字段名与 DEFAULT_VIDEO_MAPPING 不同的 Provider；其余（apimart / standard 等）走兜底。 */
export const VIDEO_PARAMETER_MAPPINGS: readonly VideoParameterMapping[] = [
  {
    providerId: 'volcengine',
    fields: { model: 'model', resolution: 'resolution', aspectRatio: 'ratio', duration: 'duration', generateAudio: 'generate_audio' },
  },
  {
    providerId: 'google',
    fields: { model: 'model', prompt: 'prompt', aspectRatio: 'aspectRatio', duration: 'duration', imageUrls: 'image', videoUrls: 'referenceVideos' },
  },
];

export function resolveVideoParameterMapping(providerId: string, modelId = ''): VideoParameterMapping {
  const normalizedProvider = providerId.trim().toLowerCase();
  return VIDEO_PARAMETER_MAPPINGS.find((mapping) =>
    mapping.providerId === normalizedProvider && (!mapping.modelPattern || mapping.modelPattern.test(modelId)),
  ) ?? DEFAULT_VIDEO_MAPPING;
}

export function mapVideoParameters(
  providerId: string,
  modelId: string,
  values: Partial<Record<VideoParameterKey, unknown>>,
): Record<string, unknown> {
  return mapParameterFields(resolveVideoParameterMapping(providerId, modelId), values);
}
