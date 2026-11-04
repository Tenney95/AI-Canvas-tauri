/** Amam 主站已核对合同（2026-11-04）：https://aigc-si.com/docs。真实生成尚待桌面验收。 */
import type { ProviderModelSelection } from '../../../types';
import type { ModelExecutionProfile, NormalizedModelExecutionProtocol, VideoModelCapability } from '../../../types/aiTypes';
import { comparableProtocol } from '../modelProtocol';
import type { ModelProtocolVariables } from '../modelProtocolTypes';

export const AIGCSI_BASE_URL = 'https://aigc-si.com/v1';
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const WIDE_RATIOS = [...RATIOS, '1:4', '1:8', '4:1', '8:1'];
const MEDIA_POLL_LIMIT_MS = 2 * 60 * 60 * 1000;

function imageProtocol(edit: boolean): NormalizedModelExecutionProtocol {
  return {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path: edit ? '/images/edits/async' : '/images/generations/async', bodyEncoding: 'json',
      body: { model: '{{model}}', prompt: '{{prompt}}', resolution: '{{imageSize}}',
        aspect_ratio: '{{aspectRatio}}', n: '{{n}}', response_format: 'url',
        ...(edit ? { images: '{{imageUrls}}' } : {}) } },
    response: { type: 'json', taskIdPath: 'id', errorPath: 'detail' },
    poll: { method: 'GET', path: '/image-jobs/{{submit.id}}', intervalMs: 5000, maxDurationMs: MEDIA_POLL_LIMIT_MS,
      response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed', 'timeout'],
        errorPath: 'error.message', result: { urlPath: 'result.data.*.url' } } },
  };
}

function imageModel(id: string, name: string, ratios = RATIOS, resolutions = ['1K', '2K', '4K']): ProviderModelSelection {
  return { id, name, provider: 'aigc-si', category: 'image', inputModalities: ['text', 'image'],
    imageCapability: { resolutions: [...resolutions], ratios: [...ratios],
      supportsBatch: true, maxBatchCount: 4, supportsImageReference: true,
      maxImageReferences: 6, supportsDataUrlReference: true },
    // 配置声明完整的参考图映射；无参考图时生成入口选择文生图临时协议。
    executionProfile: { preset: 'custom', protocol: imageProtocol(true) } };
}

function videoModel(
  id: string, name: string, maxImageReferences: number, maxVideoReferences: number, maxAudioReferences: number,
  output: Pick<VideoModelCapability, 'resolutions' | 'defaultResolution' | 'ratios' | 'durations' | 'minDuration' | 'maxDuration' | 'defaultDuration'>,
): ProviderModelSelection {
  const isMuse = id === 'muse-video-1';
  const protocol: NormalizedModelExecutionProtocol = {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/videos', bodyEncoding: 'json', body: {
      model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
      resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}',
      reference_images: '{{referenceImageUrls}}',
      ...(isMuse ? {} : { reference_mode: 'asset' }),
      ...(maxVideoReferences ? { reference_videos: '{{referenceVideoUrls}}' } : {}),
      ...(maxAudioReferences ? { reference_audios: '{{referenceAudioUrls}}' } : {}),
    } },
    response: { type: 'json', taskIdPath: 'id', errorPath: 'detail' },
    poll: { method: 'GET', path: '/videos/{{submit.id}}', intervalMs: 5000, maxDurationMs: MEDIA_POLL_LIMIT_MS,
      response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], errorPath: 'error.message',
        result: { download: { method: 'GET', path: '/videos/{{submit.id}}/content' }, mimeType: 'video/mp4' } } },
  };
  return { id, name, provider: 'aigc-si', category: 'video',
    inputModalities: ['text', 'image', ...(maxVideoReferences ? ['video' as const] : []), ...(maxAudioReferences ? ['audio' as const] : [])],
    videoCapability: { operations: ['text-to-video', 'image-to-video', ...(maxVideoReferences ? ['video-to-video' as const] : [])],
      ratios: ['16:9', '9:16'], defaultRatio: '16:9', resolutions: ['720p'], defaultResolution: '720p',
      minDuration: 5, maxDuration: 30, defaultDuration: 5, ...output,
      maxImageReferences, maxVideoReferences, maxAudioReferences, allowFrameAndReferenceMix: false },
    executionProfile: { preset: 'custom', protocol } };
}

/** 只取当前文档已明确的普通图片和视频；MJ、多协议图片池及未知型号不按名字推断合同。 */
export const AIGCSI_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  videoModel('muse-video-1', 'Muse Video', 4, 0, 0,
    { ratios: ['16:9', '9:16', '1:1'], durations: [5, 6, 8, 10], minDuration: 5, maxDuration: 10 }),
  videoModel('seedance2.5-15', 'Seedance 2.5 · 人脸限制渠道', 30, 0, 10, {}),
  videoModel('seedance2.5-12', 'Seedance 2.5 · 渠道十八', 30, 10, 10, {}),
  videoModel('seedance2.5-max-1', 'Seedance 2.5 Max', 30, 10, 10, {}),
  videoModel('seedance2.5-14', 'Seedance 2.5 · 按条计费渠道', 30, 10, 10, {}),
  videoModel('seedance2.5-13', 'Seedance 2.5 · 豆包原生渠道', 30, 10, 10, {}),
  videoModel('seedance2.0-930-1', 'Seedance 2.0 · 9图3视频', 9, 3, 0, { maxDuration: 15 }),
  videoModel('seedance2.0-15', 'Seedance 2.0 · 9图3音频', 9, 0, 3, { maxDuration: 15 }),
  videoModel('seedance2.0-7', 'Seedance 2.0 · 渠道八', 9, 3, 3,
    { resolutions: ['480p', '720p', '1080p', '4K'], defaultResolution: '480p', durations: [15], minDuration: 15, maxDuration: 15, defaultDuration: 15 }),
  videoModel('minimax-h3-5', 'MiniMax H3 · 默认渠道', 9, 3, 3,
    { resolutions: ['768p', '2K'], defaultResolution: '768p', minDuration: 4, maxDuration: 15, defaultDuration: 4 }),
  imageModel('image-2.5-flare', 'Image 2.5 Flare'),
  imageModel('image-2.5-sunburst', 'Image 2.5 Sunburst'),
  imageModel('image-2', 'Image 2'),
  imageModel('image-2-原生', 'Image 2 原生'),
  imageModel('香蕉-pro', '香蕉 Pro'),
  imageModel('香蕉-2', '香蕉 2', WIDE_RATIOS),
  imageModel('香蕉2.1', '香蕉 2.1', [...WIDE_RATIOS, '2:3', '3:2', '4:5', '5:4', '21:9'], ['1K']),
  imageModel('香蕉', '香蕉'),
  imageModel('香蕉-v2', '香蕉 V2', WIDE_RATIOS),
];

const MODEL_BY_ID = new Map(AIGCSI_MODEL_MANIFEST.map((model) => [model.id, model]));

/** 普通目录的 api_model 才是推荐调用值；缺失时仅按明确的具体 id 匹配。 */
export function normalizeAigcsiCatalogItems(items: readonly unknown[]): unknown[] {
  return items.flatMap<unknown>((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return typeof item === 'string' ? [item] : [];
    const record = item as Record<string, unknown>;
    if (record.enabled === false) return [];
    const id = typeof record.api_model === 'string' && record.api_model.trim() ? record.api_model.trim() : record.id;
    return [{ ...record, id }];
  });
}

export function matchAigcsiCatalog(models: readonly ProviderModelSelection[]): ProviderModelSelection[] {
  const seen = new Set<string>();
  return models.flatMap((remote) => {
    const known = MODEL_BY_ID.get(remote.id);
    if (!known || seen.has(remote.id)) return [];
    seen.add(remote.id);
    return [{ ...structuredClone(known), provider: remote.provider }];
  });
}

/** 只有完整内置协议才做站点参数转换；用户修改过的协议沿用其声明。 */
export function usesAigcsiModelProtocol(modelId: string, profile: ModelExecutionProfile | undefined): boolean {
  const known = MODEL_BY_ID.get(modelId);
  const actual = comparableProtocol(profile);
  return Boolean(known && actual && (actual === comparableProtocol(known.executionProfile)
    || (known.category === 'image' && actual === comparableProtocol({ preset: 'custom', protocol: imageProtocol(false) }))));
}

export function aigcsiImageExecutionProfile(referenceCount: number): ModelExecutionProfile {
  return { preset: 'custom', protocol: imageProtocol(referenceCount > 0) };
}

/** 本批只开放普通参考模式，避免将首尾帧角色静默降为普通图片。 */
export function aigcsiVideoVariables(variables: ModelProtocolVariables): ModelProtocolVariables {
  if (variables.firstImage || variables.lastImage || variables.videoInputMode === 'keyframe' || variables.videoInputMode === 'mixed') {
    throw new Error('Amam 当前接入仅支持普通参考素材；尚未确认该型号的首尾帧模式，请改用普通参考图');
  }
  return variables;
}
