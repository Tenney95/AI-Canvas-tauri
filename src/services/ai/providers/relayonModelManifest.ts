/**
 * RelayOnAPI 已核对目录（基础 2026-10-27；MJ 与 2.6 补充 2026-11-06）。来源：https://relayonapi.com/docs。
 * 2.5 C1 能力文档暂不可用，按用户确认沿用现有 2.5 A 参数映射，真实渠道尚待验收。
 * 媒体结果映射采用用户确认的 OpenAI 兼容合同，尚未进行厂商真实生成验收。
 * 普通 Flare／Sunburst 的质量和背景候选采用用户确认的兼容选项，未据此宣称平台实测通过。
 * Image 2.6 01 按用户确认兼容 2.5 01 的请求与尺寸，仍待真实渠道验收。
 * 其余型号不推断质量、背景或未公开的首尾帧合同。
 */
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue, VideoModelCapability } from '../../../types/aiTypes';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import { comparableProtocol } from '../modelProtocol';
import { getImageSizePresets } from '../modelSizeProfiles';
import { SEEDANCE_COMMON_RATIOS } from '../seedanceModelCapabilities';

export const RELAYON_BASE_URL = 'https://relayonapi.com/v1';

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

export const RELAYON_IMAGE_MODEL_IDS = [
  'image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01',
  'nano-banana-2', 'nano-banana-2.1', 'nano-banana-pro', 'Seedream 5.0 Pro',
  'image-2.6-01', ...RELAYON_MIDJOURNEY_MODEL_IDS,
] as const;

export const RELAYON_VIDEO_MODEL_IDS = [
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615',
  'doubao-seedance-2-5-260628', 'sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2',
  'minimax-h3', 'sd-2.0-c3', 'sd-2.5-c1',
] as const;

export const RELAYON_VIDEO_RESULT_URL_PATHS = ['url', 'video_url', 'content.video_url'] as const;

/** 当前 imageUtils 内联准备入口最多 6 张；局部快照避免目录反向加载上传与 Store。 */
export const RELAYON_IMAGE_REFERENCE_LIMIT = 6;

type ImageDimensions = NonNullable<ImageModelCapability['dimensionPresets']>;
type PixelPair = readonly [number, number];

const IMAGE_2_PIXELS = getImageSizePresets('relayon-image-2');
const IMAGE_25_PIXELS = getImageSizePresets('relayon-image-2.5');
const BANANA_1K_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832], '3:4': [864, 1152],
  '4:3': [1152, 864], '4:5': [1024, 1280], '5:4': [1280, 1024], '9:16': [720, 1280],
  '16:9': [1280, 720], '21:9': [1344, 576],
};
// 官网三个 Nano 型号的 2K／4K 表分别恰为每维两倍／四倍，已逐表核对。
const BANANA_PIXELS: ImageDimensions = Object.fromEntries([1, 2, 4].map((scale) => [`${scale}K`,
  Object.fromEntries(Object.entries(BANANA_1K_PIXELS).map(([ratio, [width, height]]) => [ratio,
    [width * scale, height * scale] as [number, number],
  ])),
]));
const SEEDREAM_PIXELS: ImageDimensions = {
  '1K': { '1:1': [1024, 1024], '4:3': [1280, 960], '3:4': [960, 1280],
    '16:9': [1536, 864], '9:16': [864, 1536], '3:2': [1536, 1024] },
  '2K': { '1:1': [2048, 2048], '4:3': [2048, 1536], '3:4': [1536, 2048],
    '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [2016, 1344] },
};

const MIDJOURNEY_1K_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '16:9': [1536, 864], '9:16': [864, 1536], '4:3': [1152, 864],
  '3:4': [864, 1152], '3:2': [1248, 832], '2:3': [832, 1248], '4:5': [1024, 1280],
  '5:4': [1280, 1024], '21:9': [1344, 576],
};
const MIDJOURNEY_PIXELS: ImageDimensions = { '1K': MIDJOURNEY_1K_PIXELS };
const MIDJOURNEY_8_PIXELS: ImageDimensions = {
  ...MIDJOURNEY_PIXELS,
  '2K': { '1:1': [2048, 2048], '16:9': [2048, 1152], '9:16': [1152, 2048], '4:3': [2048, 1536],
    '3:4': [1536, 2048], '3:2': [2048, 1360], '2:3': [1360, 2048], '4:5': [1632, 2040],
    '5:4': [2040, 1632], '21:9': [2016, 864] },
};

function isMidjourneyModel(modelId: string): boolean {
  return RELAYON_MIDJOURNEY_MODEL_IDS.some((id) => id === modelId);
}

function imageModel(id: string, name: string, pixels: ImageDimensions, maxReferences: number): ProviderModelSelection {
  const hasImageOptions = id === 'Image-2.5-Flare' || id === 'Image-2.5-Sunburst';
  const hasBase64Result = isMidjourneyModel(id) || ['image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01', 'image-2.6-01'].includes(id);
  const protocol: NormalizedModelExecutionProtocol = {
    version: 2, mode: 'sync', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/images/generations', bodyEncoding: 'json',
      body: { model: '{{model}}', prompt: '{{prompt}}', resolution: '{{imageSize}}',
        aspect_ratio: '{{aspectRatio}}', size: '{{size}}', n: 1, response_format: 'url', image: '{{imageUrls}}',
        ...(hasImageOptions ? { quality: '{{imageQuality}}', background: '{{imageBackground}}' } : {}) } },
    response: { type: 'json', errorPath: 'error.message', result: { urlPath: 'data.*.url',
      ...(hasBase64Result ? { base64Path: 'data.*.b64_json', mimeType: 'image/png' } : {}) } },
  };
  return { id, name, provider: 'relayonapi', category: 'image', inputModalities: ['text', 'image'],
    imageReferenceRequestMode: 'generation-json-image-data-urls',
    imageCapability: { resolutions: Object.keys(pixels), defaultResolution: '1K',
      ratios: Object.keys(pixels['1K']), defaultRatio: '1:1', dimensionPresets: structuredClone(pixels),
      ...(hasImageOptions ? { qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], backgrounds: ['auto', 'opaque', 'transparent'] } : {}),
      supportsBatch: false, maxBatchCount: 1, supportsImageReference: true,
      maxImageReferences: Math.min(RELAYON_IMAGE_REFERENCE_LIMIT, maxReferences), supportsDataUrlReference: true },
    executionProfile: { preset: 'custom', protocol } };
}

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

function videoModel(id: string, name: string, capability: VideoModelCapability, body: Record<string, ProtocolJsonValue>): ProviderModelSelection {
  return { id, name, provider: 'relayonapi', category: 'video',
    inputModalities: capability.maxImageReferences === 0 ? ['text'] : ['text', 'image'],
    videoCapability: { defaultRatio: '16:9', defaultDuration: capability.minDuration,
      ...capability,
      // 万象已确认的 Seedance 别名统一复用型号画幅；H3 保持自己的渠道能力。
      ...(id !== 'minimax-h3' ? { ratios: [...SEEDANCE_COMMON_RATIOS] } : {}),
    }, executionProfile: { preset: 'custom', protocol: videoProtocol(body) } };
}

function officialVideo(id: string, name: string, maxDuration: number, resolutions: string[]): ProviderModelSelection {
  return videoModel(id, name, { operations: ['text-to-video'], minDuration: 4, maxDuration,
    resolutions, defaultResolution: resolutions[0], supportsAudio: true,
    maxImageReferences: 0, maxVideoReferences: 0, maxAudioReferences: 0 }, {
    model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
    metadata: { resolution: '{{resolution}}', ratio: '{{aspectRatio}}', generate_audio: '{{generateAudio}}' },
  });
}

function referenceVideo(
  id: string, maxDuration: number, overrides: Partial<VideoModelCapability> = {},
  name = `Seedance ${id === 'sd-2.0-A' ? '2.0' : '2.5'} A`,
): ProviderModelSelection {
  return videoModel(id, name, {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], minDuration: 4, maxDuration,
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p', supportsAudio: true,
    // 应用首批只开放已核对的组合，不将未公开的纯音频输入当成厂商能力。
    supportsStandaloneAudio: false,
    ...overrides,
  }, { model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
    output: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}' },
    generate_audio: '{{generateAudio}}', references: referenceItems(true) });
}

function cVideo(
  id: string, name: string, minDuration: number, maxVideoReferences: number, overrides: Partial<VideoModelCapability> = {},
): ProviderModelSelection {
  const model = videoModel(id, name, {
    operations: maxVideoReferences ? ['text-to-video', 'image-to-video', 'video-to-video'] : ['text-to-video', 'image-to-video'],
    minDuration, maxDuration: 15, resolutions: ['720p'], defaultResolution: '720p',
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'], maxImageReferences: 9, maxVideoReferences, maxAudioReferences: 3,
    supportsStandaloneAudio: false,
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
  imageModel('image-2.6-01', 'Image 2.6 01', IMAGE_25_PIXELS, 8),
  ...RELAYON_MIDJOURNEY_MODEL_IDS.map((id) => imageModel(id, id,
    id === 'Midjourney v8.1' || id === 'Midjourney v8.2' ? MIDJOURNEY_8_PIXELS : MIDJOURNEY_PIXELS, 1)),
  officialVideo('doubao-seedance-2-0-260128', 'Doubao Seedance 2.0', 15, ['480p', '720p', '1080p', '4k']),
  officialVideo('doubao-seedance-2-0-fast-260128', 'Doubao Seedance 2.0 Fast', 15, ['480p', '720p']),
  officialVideo('doubao-seedance-2-0-mini-260615', 'Doubao Seedance 2.0 Mini', 15, ['480p', '720p']),
  officialVideo('doubao-seedance-2-5-260628', 'Doubao Seedance 2.5', 30, ['480p', '720p', '1080p']),
  referenceVideo('sd-2.0-A', 15), referenceVideo('sd-2.5-A', 30),
  cVideo('sd-2.0-c1', 'Seedance 2.0 C1', 10, 3), cVideo('sd-2.0-c2', 'Seedance 2.0 C2', 4, 0),
  cVideo('minimax-h3', 'MiniMax H3', 4, 3, { resolutions: ['480p', '720p', '1K', '2K'] }),
  cVideo('sd-2.0-c3', 'Seedance 2.0 C3', 4, 0),
  referenceVideo('sd-2.5-c1', 30, { resolutions: ['720p'], defaultResolution: '720p',
    maxImageReferences: 30, maxVideoReferences: 10, maxAudioReferences: 10 }, 'Seedance 2.5 C1'),
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
  // 本轮新增型号没有历史模板，不能把用户删除结果字段视作旧版本而覆盖。
  if (known.category !== 'image' || isMidjourneyModel(modelId) || modelId === 'image-2.6-01') return false;
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

/** 只补正内置 Seedance 合同的旧单画幅快照；不迁移配置或改写节点已选值。 */
export function resolveRelayonVideoCapability(
  modelId: string, profile?: ModelExecutionProfile, capability?: VideoModelCapability,
): VideoModelCapability | undefined {
  const known = MODEL_BY_ID.get(modelId);
  if (known?.category !== 'video' || modelId === 'minimax-h3' || !usesRelayonModelProtocol(modelId, profile)) return capability;
  if (!capability) return structuredClone(known.videoCapability);
  if (capability.defaultRatio !== undefined && capability.defaultRatio !== '16:9') return capability;
  if (capability.ratios !== undefined) {
    if (!LEGACY_SINGLE_RATIO_MODELS.has(modelId) || capability.ratios.length !== 1 || capability.ratios[0] !== '16:9') return capability;
  }
  // 只修复确实发过的完整旧快照；部分声明及已修改的时长、素材或模式不自动扩宽。
  const fields = Object.keys({ ...known.videoCapability, ...capability }) as (keyof VideoModelCapability)[];
  if (fields.some((key) => key !== 'ratios' && key !== 'defaultRatio'
    && JSON.stringify(capability[key]) !== JSON.stringify(known.videoCapability?.[key]))) return capability;
  return { ...capability, ratios: [...SEEDANCE_COMMON_RATIOS] };
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
  const imageCapability = { ...structuredClone(known.imageCapability), ...structuredClone(capability) };
  // 缺少字段才添加兼容候选；显式缩窄过的候选及默认值不被覆盖。
  if (known.imageCapability?.qualities && capability?.qualities === undefined) {
    imageCapability.qualities = [...known.imageCapability.qualities];
  }
  if (known.imageCapability?.backgrounds && capability?.backgrounds === undefined) {
    imageCapability.backgrounds = [...known.imageCapability.backgrounds];
  }
  return { executionProfile: structuredClone(known.executionProfile), imageCapability };
}

export function resolveRelayonImageExecutionProfile(
  modelId: string, profile: ModelExecutionProfile | undefined, referenceCount: number, imageBackground?: string,
): ModelExecutionProfile | undefined {
  if (!usesRelayonModelProtocol(modelId, profile) || MODEL_BY_ID.get(modelId)?.category !== 'image') return profile;
  const maximum = MODEL_BY_ID.get(modelId)!.imageCapability!.maxImageReferences!;
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > maximum) {
    throw new Error(`RelayOnAPI 图片模型“${modelId}”最多接受 ${maximum} 张参考图`);
  }
  const result = resolveRelayonImageModelContract(modelId, profile).executionProfile!;
  result.protocol!.submit.path = referenceCount ? '/images/edits' : '/images/generations';
  if (imageBackground?.toLowerCase() === 'transparent' && MODEL_BY_ID.get(modelId)!.imageCapability?.backgrounds) {
    (result.protocol!.submit.body as Record<string, ProtocolJsonValue>).output_format = 'png';
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
  const capability = MODEL_BY_ID.get(modelId)?.imageCapability;
  if (!capability) throw new Error(`RelayOnAPI 图片模型“${modelId}”尚未适配`);
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
  const dimensions = resolution && capability.dimensionPresets![resolution]?.[ratio];
  if (!dimensions) throw new Error(`RelayOnAPI 图片参数 ${String(variables.imageSize)} / ${ratio} 没有已公布的像素尺寸`);
  const size = `${dimensions[0]}x${dimensions[1]}`;
  if (variables.size !== undefined && variables.size !== size) throw new Error('RelayOnAPI 图片 size 与所选分辨率、比例不一致');
  return { ...variables, imageSize: isMidjourneyModel(modelId) ? resolution!.toLowerCase() : resolution,
    aspectRatio: ratio, size, width: dimensions[0], height: dimensions[1],
    imageUrls: urls.length ? urls : undefined };
}

/** 普通参考按类别原序传递；C1、H3、C3 使用 @ 编号，C2 保留图片／音频编号。 */
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
  for (const [label, urls, maximum] of [
    ['参考图', imageUrls, capability.maxImageReferences], ['参考视频', videoUrls, capability.maxVideoReferences],
    ['参考音频', audioUrls, capability.maxAudioReferences],
  ] as const) {
    if (maximum !== undefined && urls.length > maximum) throw new Error(`RelayOnAPI 模型“${modelId}”最多接受 ${maximum} 个${label}`);
  }
  if (modelId === 'minimax-h3' && imageUrls.length + videoUrls.length + audioUrls.length > 12) {
    throw new Error('RelayOnAPI MiniMax H3 的图片、视频与音频参考合计最多 12 份，请减少参考素材');
  }
  if (modelId === 'sd-2.0-c3' && audioUrls.length) {
    const duration = Number(variables.duration ?? variables.durationText ?? capability.defaultDuration);
    const ratio = String(variables.aspectRatio ?? capability.defaultRatio);
    if (![5, 10, 15].includes(duration)) {
      throw new Error(`RelayOnAPI C3 带参考音频时不支持 ${duration} 秒；请在视频参数中将时长改为 5、10 或 15 秒`);
    }
    if (!['16:9', '9:16', '1:1'].includes(ratio)) {
      throw new Error(`RelayOnAPI C3 带参考音频时不支持比例 ${ratio}；请在视频参数中改为 16:9、9:16 或 1:1`);
    }
  }
  if (audioUrls.length && !imageUrls.length && !videoUrls.length && capability.supportsStandaloneAudio === false) {
    throw new Error('RelayOnAPI 当前应用接入尚未开放仅使用参考音频生成视频，请同时提供图片或视频参考');
  }
  let prompt = variables.prompt;
  if (modelId === 'sd-2.0-c1') {
    const counts: Record<string, number> = { 图片: imageUrls.length, 视频: videoUrls.length, 音频: audioUrls.length };
    if (typeof prompt === 'string') prompt = prompt.replace(/@?(图片|视频|音频)(\d+)/gu, (label, kind: string, index: string) => (
      Number(index) >= 1 && Number(index) <= counts[kind] ? `@${kind === '图片' ? '图' : kind}${index}` : label
    ));
  }
  if (modelId === 'minimax-h3' || modelId === 'sd-2.0-c3') {
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
