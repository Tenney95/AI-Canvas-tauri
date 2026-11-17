/**
 * RelayOnAPI 已核对目录（基础 2026-10-27；MJ 与 2.6 补充 2026-11-06）。来源：https://relayonapi.com/docs。
 * SD 路由参数以用户提供的联序调用参考为准；视频时长以 2026-11-17《联序视频模型与可用秒数》为准。
 * 媒体结果映射采用用户确认的 OpenAI 兼容合同，尚未进行厂商真实生成验收。
 * 普通 Flare／Sunburst 的质量和背景候选采用用户确认的兼容选项，未据此宣称平台实测通过。
 * Image 2.6 01 使用独立官网像素表；旧 2.5 兼容能力仅用于严格识别历史配置。
 * 2026-11-17 两款 2.6 变体依官网启用 PNG/GIF/SVG；GIF/SVG 仅方图文生，文件编辑单图 image、多图 image[]。
 * SD 2.5 C2／C3 按用户确认复用 C1 参数与协议，暂无独立文档，仍待真实渠道验收。
 * 其余型号不推断质量、背景或未公开的首尾帧合同。
 */
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability, ImageOutputParameters, MediaReferenceKind, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue, VideoModelCapability } from '../../../types/aiTypes';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import { isRemoteMediaUrl } from '../../../utils/mediaUrl';
import { comparableProtocol } from '../modelProtocol';
import { getImageSizePresets } from '../modelSizeProfiles';
import { getImageCapabilityTemplate, getVideoCapabilityTemplate } from '../modelCapabilityTemplates';
import { SEEDANCE_COMMON_RATIOS } from '../seedanceModelCapabilities';
import { assertImageOutputInput, pickImageOutputParameters, resolveConfiguredImageOutput, resolveImageOutputCapability } from '../imageOutputParameters';

export const RELAYON_BASE_URL = 'https://relayonapi.com/v1';
export const RELAYON_IMAGE_BASE_URL = 'https://api.relayonapi.com/v1';
export const RELAYON_VIDEO_BASE_URL = 'https://api.relayonapi.com/v1';

export const RELAYON_TEXT_MODEL_IDS = [
  'gemini-3.8-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5-5',
] as const;

const TEXT_MODEL_NAMES: Record<typeof RELAYON_TEXT_MODEL_IDS[number], string> = {
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gpt-6.1-sol': 'GPT 6.1 Sol',
  'claude-opus-5-5': 'Claude Opus 5.5',
};

export const RELAYON_MIDJOURNEY_MODEL_IDS = [
  'Midjourney v6', 'Midjourney v6.1', 'Midjourney v7', 'Midjourney v8.1', 'Midjourney v8.2',
] as const;

export const RELAYON_IMAGE_26_VARIANT_MODEL_IDS = ['image-2.6-flare-01', 'image-2.6-sunburst-01'] as const;

export const RELAYON_IMAGE_MODEL_IDS = [
  'image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01',
  'nano-banana-2', 'nano-banana-2.1', 'nano-banana-pro', 'Seedream 5.0 Pro',
  'image-2.6-01', ...RELAYON_IMAGE_26_VARIANT_MODEL_IDS, ...RELAYON_MIDJOURNEY_MODEL_IDS,
] as const;

const SD_25_COMPATIBLE_MODEL_IDS = ['sd-2.5-c2', 'sd-2.5-c3'] as const;

export const RELAYON_VIDEO_MODEL_IDS = [
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615',
  'doubao-seedance-2-5-260628', 'sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2',
  'minimax-h3', 'sd-2.0-c3', 'sd-2.5-c1', ...SD_25_COMPATIBLE_MODEL_IDS,
] as const;

export const RELAYON_VIDEO_RESULT_URL_PATHS = ['url', 'video_url', 'content.video_url'] as const;

/** 当前 imageUtils 内联准备入口最多 6 张；局部快照避免目录反向加载上传与 Store。 */
export const RELAYON_IMAGE_REFERENCE_LIMIT = 6;

// 仅这些精确型号已确认 /images/edits 接受 multipart image/image[] 文件。
const IMAGE_FILE_UPLOAD_MODELS = new Set([
  'image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01',
  'nano-banana-2', 'nano-banana-2.1', 'nano-banana-pro', 'Seedream 5.0 Pro', 'image-2.6-01',
  ...RELAYON_IMAGE_26_VARIANT_MODEL_IDS,
  'Midjourney v6', 'Midjourney v6.1', 'Midjourney v7', 'Midjourney v8.1', 'Midjourney v8.2',
]);

// 只绑定已核对的调用 ID；渠道像素、素材与输出限制在工厂调用处覆写。
const IMAGE_CAPABILITY_TEMPLATES = {
  'image-2-01': 'gpt-image-2',
  'Image-2.5-Flare': 'gpt-image-2.5',
  'image-2.5-flare-01': 'gpt-image-2.5',
  'Image-2.5-Sunburst': 'gpt-image-2.5',
  'image-2.5-sunburst-01': 'gpt-image-2.5',
  'image-2.6-01': 'gpt-image-2.6',
  'image-2.6-flare-01': 'gpt-image-2.6',
  'image-2.6-sunburst-01': 'gpt-image-2.6',
  'nano-banana-2': 'nano-banana-2',
  'nano-banana-2.1': 'nano-banana-2.1',
  'nano-banana-pro': 'nano-banana-pro',
  'Seedream 5.0 Pro': 'seedream-5-pro',
} as const;

const VIDEO_CAPABILITY_TEMPLATES = {
  'doubao-seedance-2-0-260128': 'seedance-2.0',
  'doubao-seedance-2-0-fast-260128': 'seedance-2.0-fast',
  'doubao-seedance-2-0-mini-260615': 'seedance-2.0-mini',
  'doubao-seedance-2-5-260628': 'seedance-2.5',
  'sd-2.0-A': 'seedance-2.0',
  'sd-2.5-A': 'seedance-2.5',
  'sd-2.0-c1': 'seedance-2.0',
  'sd-2.0-c2': 'seedance-2.0',
  'sd-2.0-c3': 'seedance-2.0',
  'sd-2.5-c1': 'seedance-2.5',
  'minimax-h3': 'minimax-h3',
} as const;

type ImageDimensions = NonNullable<ImageModelCapability['dimensionPresets']>;

const IMAGE_2_PIXELS = getImageSizePresets('relayon-image-2');
const IMAGE_25_PIXELS = getImageSizePresets('relayon-image-2.5');
const IMAGE_26_PIXELS = getImageSizePresets('relayon-image-2.6');
const IMAGE_26_VARIANT_PIXELS = getImageSizePresets('relayon-image-2.6-variant');
const BANANA_PIXELS = getImageSizePresets('relayon-nano-banana');
const SEEDREAM_PIXELS = getImageSizePresets('relayon-seedream-5-pro');
const MIDJOURNEY_PIXELS = getImageSizePresets('relayon-midjourney');
const MIDJOURNEY_8_PIXELS = getImageSizePresets('relayon-midjourney-8');

function isMidjourneyModel(modelId: string): boolean {
  return RELAYON_MIDJOURNEY_MODEL_IDS.some((id) => id === modelId);
}

function isImage26Variant(modelId: string): boolean {
  return RELAYON_IMAGE_26_VARIANT_MODEL_IDS.some((id) => id === modelId);
}

function imageModel(id: string, name: string, pixels: ImageDimensions, maxReferences: number): ProviderModelSelection {
  const hasImageOptions = id === 'Image-2.5-Flare' || id === 'Image-2.5-Sunburst';
  const hasOutputFormats = isImage26Variant(id);
  const hasBase64Result = hasOutputFormats || isMidjourneyModel(id) || ['image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01', 'image-2.6-01'].includes(id);
  const templateId = IMAGE_CAPABILITY_TEMPLATES[id as keyof typeof IMAGE_CAPABILITY_TEMPLATES];
  const channelCapability: ImageModelCapability = {
    resolutions: Object.keys(pixels), ratios: Object.keys(pixels['1K']), dimensionPresets: structuredClone(pixels),
    maxImageReferences: Math.min(RELAYON_IMAGE_REFERENCE_LIMIT, maxReferences),
  };
  const formatCapability: ImageModelCapability = hasOutputFormats ? {
    // auto为应用的“上游默认”选项，实际请求会省略quality。
    qualities: ['auto', 'low', 'medium', 'high'], outputFormats: ['png', 'gif', 'svg'], defaultOutputFormat: 'png',
    textOnlyOutputFormats: ['gif', 'svg'], squareOnlyOutputFormats: ['gif', 'svg'],
    gifFrameCount: { min: 2, max: 16, step: 1, default: 9 },
    gifFrameDurationMs: { min: 20, max: 655350, step: 10, default: 200 }, supportsGifTransparency: true,
  } : {};
  const imageCapability = templateId ? getImageCapabilityTemplate(templateId, {
    defaultQuality: undefined,
    ...(!hasImageOptions ? { qualities: undefined, backgrounds: undefined } : {}),
    ...(templateId.startsWith('gpt-image-') ? { supportsBatch: false, maxBatchCount: 1 } : {}),
    ...(templateId === 'gpt-image-2.6' ? { supportsDataUrlReference: true } : {}),
    ...(templateId === 'seedream-5-pro' ? { defaultResolution: '1K', defaultRatio: '1:1', maxBatchCount: 1 } : {}),
    ...formatCapability,
    ...channelCapability,
  }) : { defaultResolution: '1K', defaultRatio: '1:1', supportsBatch: false, maxBatchCount: 1,
    supportsImageReference: true, supportsDataUrlReference: true, ...channelCapability };
  const protocol: NormalizedModelExecutionProtocol = {
    version: 2, mode: 'sync', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/images/generations', bodyEncoding: 'json',
      body: { model: '{{model}}', prompt: '{{prompt}}', resolution: '{{imageSize}}',
        aspect_ratio: '{{aspectRatio}}', size: '{{size}}', n: 1, response_format: 'url', image: '{{imageUrls}}',
        ...(hasImageOptions || hasOutputFormats ? { quality: '{{imageQuality}}' } : {}),
        ...(hasImageOptions ? { background: '{{imageBackground}}' } : {}),
        ...(hasOutputFormats ? { output_format: '{{imageOutputFormat}}', frame_count: '{{imageFrameCount}}',
          frame_duration_ms: '{{imageFrameDurationMs}}', transparent: '{{imageTransparent}}' } : {}) } },
    response: { type: 'json', errorPath: 'error.message', result: { urlPath: 'data.*.url',
      ...(hasBase64Result ? { base64Path: 'data.*.b64_json', mimeType: 'image/png' } : {}) } },
  };
  return { id, name, provider: 'relayonapi', category: 'image', inputModalities: ['text', 'image'],
    imageReferenceRequestMode: 'generation-json-image-data-urls',
    imageCapability,
    executionProfile: { preset: 'custom', protocol } };
}

const LEGACY_IMAGE_26_CAPABILITY = imageModel('image-2.6-01', 'Image 2.6 01', IMAGE_25_PIXELS, 8).imageCapability!;

function videoProtocol(body: Record<string, ProtocolJsonValue>): NormalizedModelExecutionProtocol {
  return {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/videos', bodyEncoding: 'json', body },
    response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
    poll: { method: 'GET', path: '/videos/{{submit.id}}', intervalMs: 10_000, maxDurationMs: 7_200_000,
      response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        errorPath: 'error.message', result: { urlPath: RELAYON_VIDEO_RESULT_URL_PATHS[0], mimeType: 'video/mp4' } } },
  };
}

function referenceItems(imageRole: boolean): ProtocolJsonValue[] {
  return (['image', 'video', 'audio'] as const).map((type): ProtocolJsonValue => {
    const variable = type === 'image' ? 'referenceImageUrls' : type === 'video' ? 'referenceVideoUrls' : 'referenceAudioUrls';
    const value: Record<string, ProtocolJsonValue> = { type, url: `{{${variable}}}` };
    if (type === 'image' && imageRole) value.role = 'reference';
    return { $forEach: `{{${variable}}}`, $value: value };
  });
}

function videoModel(id: keyof typeof VIDEO_CAPABILITY_TEMPLATES, name: string, overrides: VideoModelCapability, body: Record<string, ProtocolJsonValue>): ProviderModelSelection {
  const capability = getVideoCapabilityTemplate(VIDEO_CAPABILITY_TEMPLATES[id], {
    ratios: [...SEEDANCE_COMMON_RATIOS], defaultRatio: '16:9', defaultDuration: 4,
    // 渠道未声明的官方模式、输入约束和自动时长不能随基础模板进入默认合同。
    supportsStandaloneAudio: undefined, automaticDurationValue: undefined,
    inputModeCapabilities: undefined, operationCapabilities: undefined,
    inputConstraints: undefined, allowFrameAndReferenceMix: undefined,
    ...overrides,
  });
  return { id, name, provider: 'relayonapi', category: 'video',
    inputModalities: capability.maxImageReferences === 0 ? ['text'] : ['text', 'image'],
    videoCapability: capability, executionProfile: { preset: 'custom', protocol: videoProtocol(body) } };
}

function officialVideo(id: keyof typeof VIDEO_CAPABILITY_TEMPLATES, name: string): ProviderModelSelection {
  return videoModel(id, name, { operations: ['text-to-video'], defaultResolution: '480p',
    maxImageReferences: 0, maxVideoReferences: 0, maxAudioReferences: 0 }, {
    model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
    metadata: { resolution: '{{resolution}}', ratio: '{{aspectRatio}}', generate_audio: '{{generateAudio}}' },
  });
}

function referenceVideo(
  id: keyof typeof VIDEO_CAPABILITY_TEMPLATES, overrides: Partial<VideoModelCapability> = {},
  name = `Seedance ${id === 'sd-2.0-A' ? '2.0' : '2.5'} A`,
): ProviderModelSelection {
  return videoModel(id, name, {
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p',
    // A 渠道没有公开数量上限，不继承官方最大值。
    maxImageReferences: undefined, maxVideoReferences: undefined, maxAudioReferences: undefined,
    // 应用首批只开放已核对的组合，不将未公开的纯音频输入当成厂商能力。
    supportsStandaloneAudio: false,
    ...overrides,
  }, { model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
    output: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}' },
    generate_audio: '{{generateAudio}}', references: referenceItems(true) });
}

function cVideo(
  id: keyof typeof VIDEO_CAPABILITY_TEMPLATES, name: string, minDuration: number, maxVideoReferences: number, overrides: Partial<VideoModelCapability> = {},
): ProviderModelSelection {
  const model = videoModel(id, name, {
    operations: maxVideoReferences ? ['text-to-video', 'image-to-video', 'video-to-video'] : ['text-to-video', 'image-to-video'],
    minDuration, defaultDuration: minDuration, resolutions: ['720p'], defaultResolution: '720p',
    maxImageReferences: 9, maxVideoReferences, maxAudioReferences: 3,
    supportsAudio: undefined, supportsStandaloneAudio: false,
    ...overrides,
  }, { model: '{{model}}', prompt: '{{prompt}}', duration: '{{duration}}', resolution: '{{resolution}}',
    aspect_ratio: '{{aspectRatio}}', references: referenceItems(false) });
  // H3 文档明确提供受保护的二进制下载；不为其他渠道猜测 /content 合同。
  const protocol = model.executionProfile?.protocol;
  if (id === 'minimax-h3' && protocol?.version === 2 && protocol.poll) {
    protocol.poll.response.result = { download: { method: 'GET', path: '/videos/{{submit.id}}/content' }, mimeType: 'video/mp4' };
  }
  return model;
}

/** 已发布的完整视频合同仅用于严格识别旧配置；原任务回执仍沿其保存的协议恢复。 */
const LEGACY_VIDEO_MODELS: readonly ProviderModelSelection[] = [
  officialVideo('doubao-seedance-2-0-260128', 'Doubao Seedance 2.0'),
  officialVideo('doubao-seedance-2-0-fast-260128', 'Doubao Seedance 2.0 Fast'),
  officialVideo('doubao-seedance-2-0-mini-260615', 'Doubao Seedance 2.0 Mini'),
  officialVideo('doubao-seedance-2-5-260628', 'Doubao Seedance 2.5'),
  referenceVideo('sd-2.0-A'), referenceVideo('sd-2.5-A'),
  cVideo('sd-2.0-c1', 'Seedance 2.0 C1', 10, 3), cVideo('sd-2.0-c2', 'Seedance 2.0 C2', 4, 0),
  cVideo('minimax-h3', 'MiniMax H3', 4, 3, { resolutions: ['480p', '720p', '1K', '2K'] }),
  cVideo('sd-2.0-c3', 'Seedance 2.0 C3', 4, 0),
  referenceVideo('sd-2.5-c1', { resolutions: ['720p'], defaultResolution: '720p',
    maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10 }, 'Seedance 2.5 C1'),
];
const LEGACY_VIDEO_BY_ID = new Map(LEGACY_VIDEO_MODELS.map((model) => [model.id, model]));
const SD_CURRENT_COMMON_RATIOS = ['16:9', '9:16', '1:1'];

/** 2026-11-17 时长表生效前的完整已发布合同，仅用于识别旧内置配置。 */
function previousVideoModel(previous: ProviderModelSelection): ProviderModelSelection {
  const model = structuredClone(previous);
  const capability = model.videoCapability!;
  const protocol = model.executionProfile?.protocol;
  if (protocol?.version !== 2 || !protocol.poll) throw new Error('RelayOnAPI 内置视频合同缺少规范异步协议');
  if (model.id === 'minimax-h3') {
    // 上版曾提供四档时长；保留完整旧快照，不把它作为当前可选秒数。
    capability.durations = [15, 20, 25, 30];
    capability.minDuration = 15;
    capability.maxDuration = 30;
    capability.defaultDuration = 15;
    return model;
  }
  if (!model.id.startsWith('sd-')) return model;
  if (['sd-2.0-c1', 'sd-2.0-c2', 'sd-2.0-c3'].includes(model.id)) {
    capability.ratios = [...SD_CURRENT_COMMON_RATIOS];
  }
  if (model.id === 'sd-2.0-c2' || model.id === 'sd-2.0-c3') {
    capability.durations = [5, 10, 15];
    capability.minDuration = 5;
    capability.defaultDuration = 5;
  }
  if (model.id === 'sd-2.0-c3') capability.maxAudioReferences = 0;
  if (model.id === 'sd-2.5-c1') capability.ratios = [...SEEDANCE_COMMON_RATIOS, '21:9'];
  if (model.id.endsWith('-A') || model.id === 'sd-2.5-c1') {
    const body = protocol.submit.body as Record<string, ProtocolJsonValue>;
    delete body.output;
    delete body.generate_audio;
    body.resolution = '{{resolution}}';
    body.aspect_ratio = '{{aspectRatio}}';
    delete capability.supportsAudio;
  }
  protocol.poll!.response.result = {
    download: { method: 'GET', path: '/videos/{{submit.id}}/content' }, mimeType: 'video/mp4',
  };
  return model;
}

const PREVIOUS_VIDEO_MODELS: readonly ProviderModelSelection[] = [
  ...LEGACY_VIDEO_MODELS.map(previousVideoModel),
  // 两款没有更早的历史协议，但已发布的 C1 兼容能力也需参与完整快照识别。
  ...SD_25_COMPATIBLE_MODEL_IDS.map((id) => ({
    ...previousVideoModel(LEGACY_VIDEO_BY_ID.get('sd-2.5-c1')!),
    id, name: `Seedance 2.5 ${id.slice(-2).toUpperCase()}`,
  })),
];
const PREVIOUS_VIDEO_BY_ID = new Map(PREVIOUS_VIDEO_MODELS.map((model) => [model.id, model]));

// 用户 2026-11-17 秒数表：C 系列及 H3 只提供对应标准时长；A 与官转沿用原合同。
const FIXED_VIDEO_DURATIONS = new Map<string, number>([
  ['sd-2.0-c1', 15], ['sd-2.0-c2', 15], ['sd-2.0-c3', 15], ['minimax-h3', 15],
  ['sd-2.5-c1', 30], ['sd-2.5-c2', 30], ['sd-2.5-c3', 30],
]);

function currentVideoModel(previous: ProviderModelSelection): ProviderModelSelection {
  const model = structuredClone(previous);
  const duration = FIXED_VIDEO_DURATIONS.get(model.id);
  if (duration !== undefined) {
    model.videoCapability = { ...model.videoCapability, durations: [duration],
      minDuration: duration, maxDuration: duration, defaultDuration: duration };
  }
  return model;
}

export const RELAYON_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  ...RELAYON_TEXT_MODEL_IDS.map((id): ProviderModelSelection => ({ id, name: TEXT_MODEL_NAMES[id],
    provider: 'relayonapi', category: 'text', inputModalities: ['text'], executionProfile: { preset: 'openai-chat' } })),
  imageModel('image-2-01', 'Image 2 01', IMAGE_2_PIXELS, 8),
  imageModel('Image-2.5-Flare', 'Image 2.5 Flare', IMAGE_25_PIXELS, 16),
  imageModel('image-2.5-flare-01', 'Image 2.5 Flare 01', IMAGE_25_PIXELS, 8),
  imageModel('Image-2.5-Sunburst', 'Image 2.5 Sunburst', IMAGE_25_PIXELS, 16),
  imageModel('image-2.5-sunburst-01', 'Image 2.5 Sunburst 01', IMAGE_25_PIXELS, 8),
  imageModel('nano-banana-2', 'Nano Banana 2', BANANA_PIXELS, 8),
  imageModel('nano-banana-2.1', 'Nano Banana 2.1', BANANA_PIXELS, 8),
  imageModel('nano-banana-pro', 'Nano Banana Pro', BANANA_PIXELS, 8),
  imageModel('Seedream 5.0 Pro', 'Seedream 5.0 Pro', SEEDREAM_PIXELS, 10),
  imageModel('image-2.6-01', 'Image 2.6 01', IMAGE_26_PIXELS, 8),
  imageModel('image-2.6-flare-01', 'Image 2.6 Flare 01', IMAGE_26_VARIANT_PIXELS, 8),
  imageModel('image-2.6-sunburst-01', 'Image 2.6 Sunburst 01', IMAGE_26_VARIANT_PIXELS, 8),
  ...RELAYON_MIDJOURNEY_MODEL_IDS.map((id) => imageModel(id, id,
    id === 'Midjourney v8.1' || id === 'Midjourney v8.2' ? MIDJOURNEY_8_PIXELS : MIDJOURNEY_PIXELS, 1)),
  ...PREVIOUS_VIDEO_MODELS.map(currentVideoModel),
];

const MODEL_BY_ID = new Map(RELAYON_MODEL_MANIFEST.map((model) => [model.id, model]));
const LEGACY_SINGLE_RATIO_MODELS = new Set([
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615',
  'doubao-seedance-2-5-260628', 'sd-2.0-A', 'sd-2.5-A', 'sd-2.5-c1',
]);

/** 认证目录仅决定可用性；保留真实连接身份，合同取已核对快照，不接受猜测别名。 */
export function matchRelayonCatalog(models: readonly ProviderModelSelection[]): ProviderModelSelection[] {
  const seen = new Set<string>();
  return models.flatMap((remote) => {
    const known = MODEL_BY_ID.get(remote.id);
    if (!known || seen.has(remote.id)) return [];
    seen.add(remote.id);
    return [{ ...structuredClone(known), provider: remote.provider }];
  });
}

/** 只转换完整命中的内置媒体合同；用户修改的协议不冒充厂商快照。 */
export function usesRelayonModelProtocol(modelId: string, profile: ModelExecutionProfile | undefined): boolean {
  const known = MODEL_BY_ID.get(modelId);
  if (!known || known.category === 'text') return false;
  const actual = comparableProtocol(profile);
  if (actual === undefined) return false;
  if (actual === comparableProtocol(known.executionProfile)) return true;
  if (known.category === 'video') {
    return actual === comparableProtocol(LEGACY_VIDEO_BY_ID.get(modelId)?.executionProfile);
  }
  // 本轮新增型号没有历史模板，不能把用户删除结果字段视作旧版本而覆盖。
  if (known.category !== 'image' || isMidjourneyModel(modelId) || modelId === 'image-2.6-01' || isImage26Variant(modelId)) return false;
  // 完整旧内置模板只读取 URL；保留其他请求和响应字段的严格比较。
  const previousResult = structuredClone(known.executionProfile!);
  if (previousResult.protocol?.version !== 2) return false;
  if (previousResult.protocol.response.result?.base64Path) {
    delete previousResult.protocol.response.result.base64Path;
    delete previousResult.protocol.response.result.mimeType;
    if (actual === comparableProtocol(previousResult)) return true;
  }
  if (!known.imageCapability?.qualities || !known.imageCapability.backgrounds) return false;
  // 上版普通 Flare／Sunburst 完整模板尚未映射 quality 和 background；其他字段必须全部一致。
  const previous = structuredClone(known.executionProfile!);
  if (previous.protocol?.version !== 2) return false;
  const body = previous.protocol!.submit.body as Record<string, ProtocolJsonValue>;
  delete body.quality;
  delete body.background;
  if (actual === comparableProtocol(previous)) return true;
  delete previous.protocol.response.result!.base64Path;
  delete previous.protocol.response.result!.mimeType;
  return actual === comparableProtocol(previous);
}

// 官网当前明确的 /videos 文件合同；不把其他线路的 URL 能力推断为文件上传能力。
const VIDEO_FILE_KINDS: Readonly<Record<string, readonly MediaReferenceKind[]>> = {
  'sd-2.0-A': ['image', 'video', 'audio'], 'sd-2.5-A': ['image', 'video', 'audio'],
  'sd-2.0-c1': ['image', 'video', 'audio'], 'minimax-h3': ['image', 'video', 'audio'],
  'sd-2.0-c2': ['image', 'audio'], 'sd-2.0-c3': ['image', 'audio'],
  'sd-2.5-c1': ['image'], 'sd-2.5-c2': ['image'], 'sd-2.5-c3': ['image'],
};

export function getRelayonVideoFileKinds(modelId: string, profile: ModelExecutionProfile | undefined): readonly MediaReferenceKind[] {
  return usesRelayonModelProtocol(modelId, profile) ? VIDEO_FILE_KINDS[modelId] ?? [] : [];
}

/** 仅为新提交投影完整新旧内置协议，不修改配置或已提交任务的恢复合同。 */
export function resolveRelayonVideoExecutionProfile(
  modelId: string, profile: ModelExecutionProfile | undefined,
  variables?: ModelProtocolVariables,
): ModelExecutionProfile | undefined {
  const known = MODEL_BY_ID.get(modelId);
  if (known?.category !== 'video' || !usesRelayonModelProtocol(modelId, profile)) return profile;
  const result = structuredClone(known.executionProfile)!;
  if (!variables) return result;
  const protocol = result.protocol;
  if (protocol?.version !== 2) throw new Error('RelayOnAPI 内置视频合同必须使用 version 2 协议');
  const body = protocol.submit.body as Record<string, ProtocolJsonValue>;
  const supportedFiles = getRelayonVideoFileKinds(modelId, profile);
  const remoteReferences: ProtocolJsonValue[] = [];
  const sourceReferences = Array.isArray(body.references) ? body.references : [];
  let hasFiles = false;
  for (const kind of ['image', 'video', 'audio'] as const) {
    const variable = kind === 'image' ? 'referenceImageUrls' : kind === 'video' ? 'referenceVideoUrls' : 'referenceAudioUrls';
    const urls = stringArray(variables, variable);
    const files: ProtocolJsonValue[] = [];
    const source = sourceReferences.find((item) => item && typeof item === 'object' && !Array.isArray(item)
      && item.$forEach === `{{${variable}}}`);
    const sourceValue = source && typeof source === 'object' && !Array.isArray(source) ? source.$value : undefined;
    urls.forEach((url, index) => {
      if (isRemoteMediaUrl(url) && /^https:\/\//i.test(url)) {
        if (!sourceValue || typeof sourceValue !== 'object' || Array.isArray(sourceValue)) {
          throw new Error('万象当前模型没有对应的参考素材请求字段，请检查模型协议');
        }
        remoteReferences.push({ ...sourceValue, url: `{{${variable}.${index}}}` });
        return;
      }
      const mime = /^data:([^;,]+);base64,/i.exec(url)?.[1].toLowerCase();
      const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
      if (!supportedFiles.includes(kind)) {
        throw new Error(`万象模型“${modelId}”尚未公开${label}文件直传合同，请使用可公开访问的 HTTPS 素材地址；不会回退到图床`);
      }
      if (!mime?.startsWith(`${kind}/`)) throw new Error(`万象参考${label}文件类型无效，请重新导入该类型的文件，或使用可公开访问的 HTTPS 地址`);
      const extension = ({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      } as Record<string, string>)[mime] ?? (kind === 'image' ? 'png' : 'bin');
      files.push({ $file: `{{${variable}.${index}}}`, filename: `reference-${kind}-${index + 1}.${extension}` });
    });
    if (files.length) {
      if (files.length !== urls.length) throw new Error('万象同类型参考素材须统一转为文件后提交，以保持素材编号顺序');
      hasFiles = true;
      // 视频接口使用 image/images、video/videos、audio/audios，与图片编辑的 image[] 不同。
      body[files.length === 1 ? kind : `${kind}s`] = files.length === 1 ? files[0] : files;
    }
  }
  if (hasFiles) {
    protocol.submit.bodyEncoding = 'multipart';
    // 外层数组只追加一个 part，内层数组由既有编码器 JSON.stringify，避免重复 references 对象字段。
    if (remoteReferences.length) body.references = [remoteReferences];
    else delete body.references;
  }
  return result;
}

/** 恢复端按原回执摘要选择，不按“新版优先”替换已提交合同。 */
export function getRelayonVideoRecoveryProfiles(
  modelId: string, profile: ModelExecutionProfile | undefined,
): ModelExecutionProfile[] {
  if (!profile) return [];
  if (MODEL_BY_ID.get(modelId)?.category !== 'video' || !usesRelayonModelProtocol(modelId, profile)) {
    return [structuredClone(profile)];
  }
  const candidates = [profile, MODEL_BY_ID.get(modelId)!.executionProfile!];
  const previous = LEGACY_VIDEO_BY_ID.get(modelId)?.executionProfile;
  if (previous) candidates.push(previous);
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const identity = comparableProtocol(candidate)!;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [structuredClone(candidate)];
  });
}

function sameVideoCapability(left: VideoModelCapability, right: VideoModelCapability, ignoreRatio = false): boolean {
  const fields = Object.keys({ ...left, ...right }) as (keyof VideoModelCapability)[];
  return fields.every((key) => ignoreRatio && (key === 'ratios' || key === 'defaultRatio')
    || JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

/** 只投影完整已发布的能力快照；用户编辑、部分声明与原任务回执保持原值。 */
export function resolveRelayonVideoCapability(
  modelId: string, profile?: ModelExecutionProfile, capability?: VideoModelCapability,
): VideoModelCapability | undefined {
  const known = MODEL_BY_ID.get(modelId);
  if (known?.category !== 'video' || !usesRelayonModelProtocol(modelId, profile)) return capability;
  if (!capability) return structuredClone(known.videoCapability);
  const previous = LEGACY_VIDEO_BY_ID.get(modelId)?.videoCapability;
  const lastPublished = PREVIOUS_VIDEO_BY_ID.get(modelId)?.videoCapability;
  if ([previous, lastPublished].some((snapshot) => snapshot && sameVideoCapability(capability, snapshot))) {
    return structuredClone(known.videoCapability);
  }
  if (modelId === 'minimax-h3') {
    // 上版曾发布连续 4–30 秒；只识别其完整快照，不覆盖用户修改或部分声明。
    return previous && sameVideoCapability(capability, { ...previous, maxDuration: 30 })
      ? structuredClone(known.videoCapability) : capability;
  }
  if (capability.defaultRatio !== undefined && capability.defaultRatio !== '16:9') return capability;
  if (capability.ratios !== undefined) {
    if (!LEGACY_SINGLE_RATIO_MODELS.has(modelId) || capability.ratios.length !== 1 || capability.ratios[0] !== '16:9') return capability;
  }
  // 缺省/历史单画幅只有其余字段完整匹配已发布快照时才补正。
  if (![previous, lastPublished, known.videoCapability].some((snapshot) => snapshot && sameVideoCapability(capability, snapshot, true))) return capability;
  return { ...structuredClone(known.videoCapability), ...(capability.defaultRatio === undefined ? { defaultRatio: undefined } : {}) };
}

/** 固定四候选只属于真实内置合同，不按相同名称改写用户自定义协议的交付语义。 */
export function getRelayonImageOutputsPerJob(modelId: string, profile: ModelExecutionProfile | undefined): number {
  return isMidjourneyModel(modelId) && usesRelayonModelProtocol(modelId, profile) ? 4 : 1;
}

/** 只为真实连接的完整新旧内置合同补临时能力；原配置、用户显式能力和自定义协议保持原值。 */
export function resolveRelayonImageModelContract(
  modelId: string, profile?: ModelExecutionProfile, capability?: ImageModelCapability,
): { executionProfile?: ModelExecutionProfile; imageCapability?: ImageModelCapability } {
  const known = MODEL_BY_ID.get(modelId);
  if (known?.category !== 'image' || !usesRelayonModelProtocol(modelId, profile)) {
    return { executionProfile: profile, imageCapability: capability };
  }
  const previous = modelId === 'image-2.6-01' ? LEGACY_IMAGE_26_CAPABILITY : undefined;
  const legacyFields = Object.keys({ ...previous, ...capability }) as (keyof ImageModelCapability)[];
  const usesLegacyCapability = previous && capability && legacyFields.every((key) =>
    JSON.stringify(capability[key]) === JSON.stringify(previous[key]));
  const imageCapability = { ...structuredClone(known.imageCapability),
    ...structuredClone(usesLegacyCapability ? undefined : capability) };
  // 缺少字段才添加兼容候选；显式缩窄过的候选及默认值不被覆盖。
  if (known.imageCapability?.qualities && capability?.qualities === undefined) {
    imageCapability.qualities = [...known.imageCapability.qualities];
  }
  if (known.imageCapability?.backgrounds && capability?.backgrounds === undefined) {
    imageCapability.backgrounds = [...known.imageCapability.backgrounds];
  }
  return { executionProfile: structuredClone(known.executionProfile), imageCapability };
}

/** 文件直传仅用于完整内置合同；不按同名模型改写用户自定义协议。 */
export function usesRelayonImageFileUpload(modelId: string, profile: ModelExecutionProfile | undefined): boolean {
  return IMAGE_FILE_UPLOAD_MODELS.has(modelId) && usesRelayonModelProtocol(modelId, profile);
}

export function resolveRelayonImageExecutionProfile(
  modelId: string, profile: ModelExecutionProfile | undefined, referenceCount: number, imageBackground?: string,
  outputParameters: ImageOutputParameters = {},
): ModelExecutionProfile | undefined {
  if (!usesRelayonModelProtocol(modelId, profile) || MODEL_BY_ID.get(modelId)?.category !== 'image') return profile;
  const capability = MODEL_BY_ID.get(modelId)!.imageCapability!;
  const output = resolveConfiguredImageOutput(capability, outputParameters);
  assertImageOutputInput(capability, output, { imageCount: referenceCount });
  const maximum = capability.maxImageReferences!;
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > maximum) {
    throw new Error(`RelayOnAPI 图片模型“${modelId}”最多接受 ${maximum} 张参考图`);
  }
  const result = resolveRelayonImageModelContract(modelId, profile).executionProfile!;
  const protocol = result.protocol;
  if (protocol?.version !== 2) throw new Error('RelayOnAPI 内置图片合同必须使用 version 2 协议');
  const body = protocol.submit.body as Record<string, ProtocolJsonValue>;
  protocol.submit.path = referenceCount ? '/images/edits' : '/images/generations';
  if (referenceCount > 0 && usesRelayonImageFileUpload(modelId, profile)) {
    protocol.submit.bodyEncoding = 'multipart';
    delete body.image;
    const field = referenceCount > 1 ? 'image[]' : 'image';
    if (modelId === 'image-2.6-01' || isImage26Variant(modelId)) {
      // 对齐官方文件编辑示例：规格由size表达，每张参考图使用独立文件名。
      delete body.resolution;
      delete body.aspect_ratio;
      const files = Array.from({ length: referenceCount }, (_, index) => ({
        $file: `{{imageUrls.${index}}}`, filename: `reference-${index + 1}.png`,
      }));
      body[field] = referenceCount === 1 ? files[0] : files;
    } else body[field] = { $file: '{{imageUrls}}' };
  }
  if (isImage26Variant(modelId)) {
    const format = output.imageOutputFormat ?? 'png';
    if (format !== 'png') {
      delete body.image;
      delete body['image[]'];
    }
    if (format !== 'gif') {
      delete body.frame_count;
      delete body.frame_duration_ms;
      delete body.transparent;
    }
    protocol.response.result!.mimeType = format === 'svg' ? 'image/svg+xml' : `image/${format}`;
  }
  if (imageBackground?.toLowerCase() === 'transparent' && MODEL_BY_ID.get(modelId)!.imageCapability?.backgrounds) {
    body.output_format = 'png';
  }
  return result;
}

function stringArray(variables: ModelProtocolVariables, name: string): string[] {
  const value = variables[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`RelayOnAPI 参数 ${name} 必须是非空字符串组成的数组`);
  }
  return value as string[];
}

function assertSingleResult(variables: ModelProtocolVariables): void {
  if (['n', 'batchCount'].some((key) => variables[key] !== undefined && variables[key] !== 1)) {
    throw new Error('RelayOnAPI 每次生成仅提交一个结果，请将生成数量设为 1');
  }
}

/** 同一份像素快照同时决定 size、resolution 与 aspect_ratio，不静默改付费档位。 */
export function relayonImageVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const declaredCapability = MODEL_BY_ID.get(modelId)?.imageCapability;
  if (!declaredCapability) throw new Error(`RelayOnAPI 图片模型“${modelId}”尚未适配`);
  const output = resolveConfiguredImageOutput(declaredCapability, pickImageOutputParameters(variables));
  const capability = resolveImageOutputCapability(declaredCapability, output.imageOutputFormat)!;
  assertSingleResult(variables);
  const urls = stringArray(variables, 'imageUrls');
  if (urls.length > capability.maxImageReferences!) throw new Error(`RelayOnAPI 图片模型“${modelId}”最多接受 ${capability.maxImageReferences} 张参考图`);
  for (const url of urls) {
    if (/^https:\/\//i.test(url)) continue;
    const data = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
    if (!data) throw new Error('RelayOnAPI 参考图仅支持 HTTPS 或 PNG、JPEG、WebP 的 Base64 data URI');
    const encoded = data[1].replace(/\s/g, '');
    const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > 20 * 1024 * 1024) throw new Error('RelayOnAPI 单张参考图不能超过 20 MiB');
  }
  const resolution = capability.resolutions!.find((value) => value.toLowerCase() === String(variables.imageSize ?? capability.defaultResolution).toLowerCase());
  const ratio = typeof variables.aspectRatio === 'string' ? variables.aspectRatio : capability.defaultRatio!;
  assertImageOutputInput(declaredCapability, output, { aspectRatio: ratio, imageCount: urls.length,
    hasMask: Boolean(variables.mask ?? variables.characterPaintMask) });
  const dimensions = modelId === 'image-2.6-01' && resolution === '4K' && ratio === '1:1' && variables.size === '2880x2880'
    ? [2880, 2880] : resolution && capability.dimensionPresets![resolution]?.[ratio];
  if (!dimensions) throw new Error(`RelayOnAPI 图片参数 ${String(variables.imageSize)} / ${ratio} 没有已公布的像素尺寸`);
  const size = `${dimensions[0]}x${dimensions[1]}`;
  if (variables.size !== undefined && variables.size !== size) throw new Error('RelayOnAPI 图片 size 与所选分辨率、比例不一致');
  return { ...variables, ...output, imageSize: isMidjourneyModel(modelId) ? resolution!.toLowerCase() : resolution,
    // PNG文件编辑沿用编辑接口的默认输出；文生的格式字段不带入此请求。
    ...(isImage26Variant(modelId) && urls.length > 0 && output.imageOutputFormat === 'png'
      ? { imageOutputFormat: undefined } : {}),
    ...(isImage26Variant(modelId) && variables.imageQuality === 'auto' ? { imageQuality: undefined } : {}),
    aspectRatio: ratio, size, width: dimensions[0], height: dimensions[1],
    imageUrls: urls.length ? urls : undefined };
}

/** 普通参考按类别原序传递；SD 与 H3 仅把有真实对应素材的编号统一为 @ 引用。 */
export function relayonVideoVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const capability = MODEL_BY_ID.get(modelId)?.videoCapability;
  if (!capability) throw new Error(`RelayOnAPI 视频模型“${modelId}”尚未适配`);
  assertSingleResult(variables);
  if (variables.firstImage || variables.lastImage || variables.videoInputMode === 'keyframe' || variables.videoInputMode === 'mixed') {
    throw new Error('RelayOnAPI 当前 JSON 合同未公布首尾帧字段，请改用普通参考素材');
  }
  const imageUrls = stringArray(variables, variables.referenceImageUrls === undefined ? 'imageUrls' : 'referenceImageUrls');
  const videoUrls = stringArray(variables, variables.referenceVideoUrls === undefined ? 'videoUrls' : 'referenceVideoUrls');
  const audioUrls = stringArray(variables, variables.referenceAudioUrls === undefined ? 'audioUrls' : 'referenceAudioUrls');
  if (modelId === 'sd-2.0-c3' && audioUrls.length) {
    throw new Error('RelayOnAPI C3 当前没有可调度的参考音频线路，请移除参考音频或切换型号');
  }
  for (const [label, urls, maximum] of [
    ['参考图', imageUrls, capability.maxImageReferences], ['参考视频', videoUrls, capability.maxVideoReferences],
    ['参考音频', audioUrls, capability.maxAudioReferences],
  ] as const) {
    if (maximum !== undefined && urls.length > maximum) throw new Error(`RelayOnAPI 模型“${modelId}”最多接受 ${maximum} 个${label}`);
  }
  if (modelId === 'minimax-h3' && imageUrls.length + videoUrls.length + audioUrls.length > 12) {
    throw new Error('RelayOnAPI MiniMax H3 的图片、视频与音频参考合计最多 12 份，请减少参考素材');
  }
  const usesSeconds = modelId.endsWith('-A') || modelId === 'sd-2.5-c1'
    || SD_25_COMPATIBLE_MODEL_IDS.some((id) => id === modelId) || modelId.startsWith('doubao-');
  const duration = Number((usesSeconds ? variables.durationText ?? variables.duration : variables.duration ?? variables.durationText)
    ?? capability.defaultDuration);
  if (!Number.isInteger(duration) || duration < capability.minDuration! || duration > capability.maxDuration!
    || capability.durations && !capability.durations.includes(duration)) {
    throw new Error(`RelayOnAPI 模型“${modelId}”不支持 ${duration} 秒；${capability.durations ? '可选时长为 ' + capability.durations.join('、') : '时长范围为 ' + capability.minDuration + '–' + capability.maxDuration} 秒`);
  }
  const ratio = String(variables.aspectRatio ?? capability.defaultRatio);
  if (!capability.ratios?.includes(ratio)) {
    throw new Error(`RelayOnAPI 模型“${modelId}”当前不支持比例 ${ratio}；请改为 ${capability.ratios!.join('、')}`);
  }
  if (audioUrls.length && !imageUrls.length && !videoUrls.length && capability.supportsStandaloneAudio === false) {
    throw new Error('RelayOnAPI 当前应用接入尚未开放仅使用参考音频生成视频，请同时提供图片或视频参考');
  }
  let prompt = variables.prompt;
  if (modelId === 'minimax-h3' || modelId.startsWith('sd-')) {
    const counts: Record<string, number> = { 图片: imageUrls.length, 图: imageUrls.length, 视频: videoUrls.length, 音频: audioUrls.length };
    if (typeof prompt === 'string') prompt = prompt.replace(/@?(图片|图|视频|音频)(\d+)/gu, (label, kind: string, index: string) => (
      Number(index) >= 1 && Number(index) <= counts[kind] ? `@${kind === '图片' || kind === '图' ? '图' : kind}${Number(index)}` : label
    ));
  }
  let resolution = variables.resolution;
  if (modelId === 'minimax-h3') {
    const mentioned = new Set(typeof prompt === 'string' ? Array.from(prompt.matchAll(/@图(\d+)/gu), (match) => Number(match[1])) : []);
    for (let index = 1; index <= imageUrls.length; index += 1) {
      if (!mentioned.has(index)) throw new Error(`RelayOnAPI MiniMax H3 的参考图 ${index} 未在提示词中引用，请补充 @图${index}`);
    }
    const requested = String(resolution ?? capability.defaultResolution).toLowerCase();
    if (!['480p', '720p', '1k', '2k'].includes(requested)) throw new Error('RelayOnAPI MiniMax H3 分辨率仅支持 480p、720p、1K 或 2K');
    resolution = requested;
  }
  return { ...variables, prompt,
    ...(modelId === 'minimax-h3' ? { resolution } : {}),
    referenceImageUrls: imageUrls.length ? imageUrls : undefined,
    referenceVideoUrls: videoUrls.length ? videoUrls : undefined,
    referenceAudioUrls: audioUrls.length ? audioUrls : undefined };
}
