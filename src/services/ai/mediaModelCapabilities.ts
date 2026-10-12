/**
 * 通用媒体模型能力表 —— 跨 Provider 的图片 / 音频模型能力声明与参数映射基础设施。
 *
 * 不同生图模型的分辨率档位、批量数量、参考图能力差异很大，统一按能力表约束，
 * 替代「全局 2K + 1:1 + 统一 n」的兜底。音频模型按 kind（speech / music）声明能力。
 * 字段语义与 types/aiTypes.ts 的 ImageModelCapability / AudioModelCapability 对齐，
 * 供参数面板与生成入口消费。
 */
import type { AudioModelCapability, ImageModelCapability } from '../../types/aiTypes';
import type { AppConfig } from '../../types';
import { getRunningHubModel } from './providers/runninghubModelManifest';
import { getGrsaiImageCapability } from './grsaiModels';
import { getProviderDefinition } from './providerCatalogService';

/* ── 生图能力表 ── */

export interface ImageCapabilityRequestParams {
  /** 分辨率档位，如 '1K' | '2K' | '4K' | '2MP'。 */
  resolution?: string;
  /** 宽高比，如 '1:1' | '16:9' | 'auto'。 */
  ratio?: string;
  /** 批量生成数量。 */
  count?: number;
  /** 参考图 URL（图生图 / 编辑）。 */
  imageUrls?: string[];
}

export interface ImageCapabilityRequest {
  body: Record<string, unknown>;
  /** 提交后用于回填结果的像素尺寸（能力表若无法换算则保留调用方传入值）。 */
  dimensions: { width: number; height: number };
  /** 实际生效的批量数量（能力表钳制后）。 */
  requestedCount: number;
}

/**
 * 分辨率字段的取值风格。部分模型（FLUX.2）用 MP 而非 K，部分模型无 resolution 字段。
 */
export type ImageResolutionStyle = 'K' | 'MP' | 'none';

const COMMON_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const;

export interface ImageCapability extends ImageModelCapability {
  /** 模型 ID（文档中的实际 model 值）。 */
  modelId: string;
  /** 分辨率取值风格：K（1K/2K/4K）、MP（1MP/2MP...）、none（无 resolution 字段）。 */
  resolutionStyle: ImageResolutionStyle;
  /** 厂商公布的实际像素映射；未声明时沿用短边换算。 */
  dimensionPresets?: Record<string, Record<string, readonly [number, number]>>;
  ratioField?: 'size' | 'aspect_ratio';
  staticFields?: Record<string, unknown>;
  requestHeaders?: Record<string, string>;
  supportsIdempotency?: boolean;
}

// https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation
// 两个版本共用尺寸与批量合同；quality 等可选字段保持接口默认值。
const GPT_IMAGE_25_CAPABILITY: Omit<ImageCapability, 'modelId'> = {
  resolutions: ['1k', '2k', '4k'],
  defaultResolution: '1k',
  ratios: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21', '3:1', '1:3'],
  defaultRatio: '1:1',
  resolutionStyle: 'K',
  supportsBatch: true,
  maxBatchCount: 4,
  supportsImageReference: true,
  maxImageReferences: 16,
  supportsDataUrlReference: false,
  dimensionPresets: {
    '1k': {
      '1:1': [1024, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536],
      '4:3': [1024, 768], '3:4': [768, 1024], '5:4': [1280, 1024], '4:5': [1024, 1280],
      '16:9': [1536, 864], '9:16': [864, 1536], '2:1': [2048, 1024], '1:2': [1024, 2048],
      '21:9': [2016, 864], '9:21': [864, 2016], '3:1': [1536, 512], '1:3': [512, 1536],
    },
    '2k': {
      '1:1': [2048, 2048], '3:2': [2048, 1360], '2:3': [1360, 2048],
      '4:3': [2048, 1536], '3:4': [1536, 2048], '5:4': [2560, 2048], '4:5': [2048, 2560],
      '16:9': [2048, 1152], '9:16': [1152, 2048], '2:1': [2688, 1344], '1:2': [1344, 2688],
      '21:9': [2688, 1152], '9:21': [1152, 2688], '3:1': [3072, 1024], '1:3': [1024, 3072],
    },
    '4k': {
      '1:1': [2880, 2880], '3:2': [3520, 2336], '2:3': [2336, 3520],
      '4:3': [3312, 2480], '3:4': [2480, 3312], '5:4': [3216, 2576], '4:5': [2576, 3216],
      '16:9': [3840, 2160], '9:16': [2160, 3840], '2:1': [3840, 1920], '1:2': [1920, 3840],
      '21:9': [3840, 1648], '9:21': [1648, 3840], '3:1': [3840, 1280], '1:3': [1280, 3840],
    },
  },
};

/**
 * 生图能力表。modelId 以各 Provider 文档为准；getImageCapability 用归一化 key 匹配，
 * 兼容 defaultModels 里旧的历史 ID（如 seedream-4.0 → doubao-seedream-4.0）。
 */
const IMAGE_CAPABILITIES: Record<string, ImageCapability> = {
  // ── Nano Banana / Gemini 系列 ──
  'gemini-3.1-flash-image-preview': {
    modelId: 'gemini-3.1-flash-image-preview',
    resolutions: ['1K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS, '4:5', '5:4', '21:9'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 14,
    supportsDataUrlReference: true,
  },
  'gemini-3-pro-image-preview': {
    modelId: 'gemini-3-pro-image-preview',
    resolutions: ['1K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS, '4:5', '5:4', '21:9'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 14,
    supportsDataUrlReference: true,
  },
  'gemini-2.5-flash-image-preview': {
    modelId: 'gemini-2.5-flash-image-preview',
    resolutions: ['1K'],
    defaultResolution: '1K',
    ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 14,
    supportsDataUrlReference: true,
  },

  // ── GPT-Image 系列 ──
  'gpt-image-2.5-flare': {
    ...GPT_IMAGE_25_CAPABILITY,
    modelId: 'gpt-image-2.5-flare',
  },
  'gpt-image-2.5-sunburst': {
    ...GPT_IMAGE_25_CAPABILITY,
    modelId: 'gpt-image-2.5-sunburst',
  },
  'gpt-image-1': {
    modelId: 'gpt-image-1',
    resolutions: ['1k', '2k', '4k'],
    defaultResolution: '1k',
    ratios: ['1:1', '3:2', '2:3'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 4,
    supportsImageReference: true,
    maxImageReferences: 15,
    supportsDataUrlReference: false,
  },
  'gpt-image-1.5': {
    modelId: 'gpt-image-1.5',
    resolutions: ['1k', '2k', '4k'],
    defaultResolution: '1k',
    ratios: ['1:1', '3:2', '2:3'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 4,
    supportsImageReference: true,
    maxImageReferences: 15,
    supportsDataUrlReference: false,
  },
  'gpt-image-2': {
    modelId: 'gpt-image-2',
    resolutions: ['1k', '2k', '4k'],
    defaultResolution: '1k',
    ratios: ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '1:2', '2:1', '1:3', '3:1', '21:9', '9:21'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    // APIMart 的 gpt-image-2 不接受 n>1；多图由调用层拆成多次 n=1 请求。
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 16,
    supportsDataUrlReference: true,
  },

  // ── Imagen 4.0（仅文生图）──
  'imagen-4.0-apimart': {
    modelId: 'imagen-4.0-apimart',
    resolutions: [],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    defaultRatio: '16:9',
    resolutionStyle: 'none',
    supportsBatch: false,
    supportsImageReference: false,
  },

  // ── FLUX.2 系列（分辨率用 MP，n 固定 1）──
  'flux-2-pro': {
    modelId: 'flux-2-pro',
    resolutions: ['1MP', '2MP', '3MP', '4MP'],
    defaultResolution: '2MP',
    ratios: [...COMMON_RATIOS, '21:9', '9:21'],
    defaultRatio: '1:1',
    resolutionStyle: 'MP',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 8,
    supportsDataUrlReference: true,
  },
  'flux-2-flex': {
    modelId: 'flux-2-flex',
    resolutions: ['1MP', '2MP', '3MP', '4MP'],
    defaultResolution: '2MP',
    ratios: [...COMMON_RATIOS, '21:9', '9:21'],
    defaultRatio: '1:1',
    resolutionStyle: 'MP',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 8,
    supportsDataUrlReference: true,
  },
  'flux-2-max': {
    modelId: 'flux-2-max',
    resolutions: ['1MP', '2MP', '3MP', '4MP'],
    defaultResolution: '2MP',
    ratios: [...COMMON_RATIOS, '21:9', '9:21'],
    defaultRatio: '1:1',
    resolutionStyle: 'MP',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 8,
    supportsDataUrlReference: true,
  },

  // ── Qwen Image 系列 ──
  'qwen-image-2.0': {
    modelId: 'qwen-image-2.0',
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 6,
    supportsImageReference: true,
    maxImageReferences: 9,
    supportsDataUrlReference: false,
  },
  'qwen-image-2.0-pro': {
    modelId: 'qwen-image-2.0-pro',
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 6,
    supportsImageReference: true,
    maxImageReferences: 9,
    supportsDataUrlReference: false,
  },
  'qwen-image-3.0': {
    modelId: 'qwen-image-3.0',
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 6,
    supportsImageReference: true,
    maxImageReferences: 3,
    supportsDataUrlReference: true,
  },
  'qwen-image-3.0-pro': {
    modelId: 'qwen-image-3.0-pro',
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 6,
    supportsImageReference: true,
    maxImageReferences: 3,
    supportsDataUrlReference: true,
  },

  // ── Z-Image-Turbo（仅文生图，无 n）──
  'z-image-turbo': {
    modelId: 'z-image-turbo',
    resolutions: ['1K', '2K'],
    defaultResolution: '1K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: false,
    supportsImageReference: false,
  },

  // ── Grok Imagine 系列（无 resolution 字段）──
  'grok-imagine-1.0-apimart': {
    modelId: 'grok-imagine-1.0-apimart',
    resolutions: [],
    ratios: ['1:1', '16:9', '9:16', '3:2', '2:3'],
    defaultRatio: '1:1',
    resolutionStyle: 'none',
    supportsBatch: true,
    maxBatchCount: 10,
    supportsImageReference: true,
    maxImageReferences: 1,
    supportsDataUrlReference: true,
  },
  'grok-imagine-1.5-apimart': {
    modelId: 'grok-imagine-1.5-apimart',
    resolutions: [],
    ratios: ['1:1', '16:9', '9:16', '3:2', '2:3'],
    defaultRatio: '1:1',
    resolutionStyle: 'none',
    supportsBatch: true,
    maxBatchCount: 10,
    supportsImageReference: true,
    maxImageReferences: 1,
    supportsDataUrlReference: true,
  },
  'grok-imagine-2.0-ext': {
    modelId: 'grok-imagine-2.0-ext',
    resolutions: [],
    ratios: ['1:1', '16:9', '9:16', '3:2', '2:3'],
    defaultRatio: '1:1',
    resolutionStyle: 'none',
    supportsBatch: true,
    maxBatchCount: 10,
    supportsImageReference: true,
    maxImageReferences: 1,
    supportsDataUrlReference: true,
  },

  // ── wan2.7 image（size 支持分辨率关键词，n 1-4）──
  'wan2.7-image': {
    modelId: 'wan2.7-image',
    resolutions: ['1K', '2K'],
    defaultResolution: '2K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 4,
    supportsImageReference: true,
    maxImageReferences: 9,
    supportsDataUrlReference: true,
  },
  'wan2.7-image-pro': {
    modelId: 'wan2.7-image-pro',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '2K',
    ratios: [...COMMON_RATIOS],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 4,
    supportsImageReference: true,
    maxImageReferences: 9,
    supportsDataUrlReference: true,
  },

  // ── Seedream 系列（doubao-seedream-*）──
  'doubao-seedream-4.0': {
    modelId: 'doubao-seedream-4.0',
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '2K',
    ratios: [...COMMON_RATIOS, '21:9', '9:21'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 15,
    supportsImageReference: true,
    maxImageReferences: 15,
    supportsDataUrlReference: true,
  },
  'doubao-seedream-4.5': {
    modelId: 'doubao-seedream-4.5',
    resolutions: ['2K', '4K'],
    defaultResolution: '2K',
    ratios: [...COMMON_RATIOS, '21:9', '9:21'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 15,
    supportsImageReference: true,
    maxImageReferences: 15,
    supportsDataUrlReference: true,
  },
  'doubao-seedream-5.0-lite': {
    modelId: 'doubao-seedream-5-0-lite',
    resolutions: ['2K', '3K', '4K'],
    defaultResolution: '2K',
    ratios: [...COMMON_RATIOS, '21:9'],
    defaultRatio: '1:1',
    resolutionStyle: 'K',
    supportsBatch: true,
    maxBatchCount: 15,
    supportsImageReference: true,
    maxImageReferences: 15,
    supportsDataUrlReference: true,
  },
  'doubao-seedream-5.0-pro': {
    modelId: 'doubao-seedream-5-0-pro',
    resolutions: ['1K', '1.5K', '2K'],
    defaultResolution: '2K',
    ratios: ['auto', ...COMMON_RATIOS, '21:9'],
    defaultRatio: 'auto',
    resolutionStyle: 'K',
    supportsBatch: false,
    supportsImageReference: true,
    maxImageReferences: 10,
    supportsDataUrlReference: true,
    dimensionPresets: {
      '1K': {
        '1:1': [1024, 1024], '4:3': [1152, 864], '3:4': [864, 1152],
        '16:9': [1424, 800], '9:16': [800, 1424], '3:2': [1248, 832],
        '2:3': [832, 1248], '21:9': [1568, 672],
      },
      '1.5K': {
        '1:1': [1536, 1536], '4:3': [1792, 1344], '3:4': [1344, 1792],
        '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [1872, 1248],
        '2:3': [1248, 1872], '21:9': [2352, 1008],
      },
      '2K': {
        '1:1': [2048, 2048], '4:3': [2368, 1776], '3:4': [1776, 2368],
        '16:9': [2816, 1584], '9:16': [1584, 2816], '3:2': [2496, 1664],
        '2:3': [1664, 2496], '21:9': [3136, 1344],
      },
    },
  },
};

/**
 * 历史旧 ID → 文档新 ID 的归一化别名，兼容 defaultModels 中已保存的旧配置。
 */
// APIMart 的同名中转模型合同独立于火山等直连能力，避免覆盖其像素表。
const APIMART_IMAGE_CAPABILITIES: Record<string, ImageCapability> = {
  ...Object.fromEntries(['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-lite-image-ext'].map((modelId) => [modelId, {
    ...IMAGE_CAPABILITIES['gemini-3.1-flash-image-preview'], modelId,
    ratios: ['auto', ...COMMON_RATIOS, '4:5', '5:4', '21:9'],
  }])),
  ...Object.fromEntries(['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image-preview-official'].map((modelId) => [modelId, {
    ...IMAGE_CAPABILITIES['gemini-3.1-flash-image-preview'], modelId,
    resolutions: ['0.5K', '1K', '2K', '4K'],
    ratios: ['auto', ...COMMON_RATIOS, '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'],
  }])),
  ...Object.fromEntries(['gemini-3-pro-image-preview', 'gemini-3-pro-image-preview-official'].map((modelId) => [modelId, {
    ...IMAGE_CAPABILITIES['gemini-3-pro-image-preview'], modelId,
    resolutions: ['1K', '2K', '4K'], ratios: ['auto', ...COMMON_RATIOS, '4:5', '5:4', '21:9'],
  }])),
  'gpt-image-2-official': { ...GPT_IMAGE_25_CAPABILITY, modelId: 'gpt-image-2-official', supportsDataUrlReference: true, dimensionPresets: undefined },
  'gpt-image-2.5-ext': {
    ...GPT_IMAGE_25_CAPABILITY, modelId: 'gpt-image-2.5-ext',
    resolutions: ['1K', '2K', '4K'], defaultResolution: '1K',
    ratios: ['auto', ...COMMON_RATIOS, '5:4', '4:5', '21:9'],
    dimensionPresets: undefined, supportsDataUrlReference: true,
    staticFields: { version: 'flare' },
  },
  ...Object.fromEntries(['seedream-5-0-pro', 'seedream-5-0-flash'].map((modelId) => [modelId, {
    ...IMAGE_CAPABILITIES['doubao-seedream-5.0-pro'], modelId, defaultResolution: '1K',
    ratios: ['auto', ...COMMON_RATIOS, '2:1', '1:2', '21:9'],
    dimensionPresets: {
      '1K': { '1:1': [1024, 1024], '4:3': [1152, 864], '3:4': [864, 1152], '16:9': [1312, 736], '9:16': [736, 1312], '3:2': [1248, 832], '2:3': [832, 1248], '2:1': [1440, 720], '1:2': [720, 1440], '21:9': [1568, 672] },
      '1.5K': { '1:1': [1536, 1536], '4:3': [1792, 1344], '3:4': [1344, 1792], '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [1872, 1248], '2:3': [1248, 1872], '2:1': [2176, 1088], '1:2': [1088, 2176], '21:9': [2352, 1008] },
      '2K': { '1:1': [2048, 2048], '4:3': [2304, 1728], '3:4': [1728, 2304], '16:9': [2560, 1440], '9:16': [1440, 2560], '3:2': [2496, 1664], '2:3': [1664, 2496], '2:1': [2880, 1440], '1:2': [1440, 2880], '21:9': [3024, 1296] },
    },
  }])),
  'grok-imagine-1.5-apimart': {
    ...IMAGE_CAPABILITIES['grok-imagine-1.5-apimart'], maxImageReferences: 5, supportsDataUrlReference: false,
  },
  'grok-imagine-2.0-ext': {
    ...IMAGE_CAPABILITIES['grok-imagine-2.0-ext'],
    ratios: [...COMMON_RATIOS], maxBatchCount: 12,
    supportsImageReference: false, maxImageReferences: 0, supportsDataUrlReference: false,
  },
  'grok-imagine-image-2.0': {
    modelId: 'grok-imagine-image-2.0', resolutions: ['1k', '2k'], defaultResolution: '1k',
    ratios: ['auto', ...COMMON_RATIOS, '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1'],
    defaultRatio: '1:1', resolutionStyle: 'K', ratioField: 'aspect_ratio',
    supportsBatch: true, maxBatchCount: 10, supportsImageReference: true,
    maxImageReferences: 3, supportsDataUrlReference: false,
    requestHeaders: { 'X-APIMart-Response-Version': '2026-07-27' }, supportsIdempotency: true,
  },
};

const IMAGE_MODEL_ID_ALIASES: Record<string, string> = {
  'seedream-4.0': 'doubao-seedream-4.0',
  'seedream-4.5': 'doubao-seedream-4.5',
  'seedream-5.0-lite': 'doubao-seedream-5.0-lite',
  'seedream-5.0-pro': 'doubao-seedream-5.0-pro',
  'grok-imagine': 'grok-imagine-1.5-apimart',
  'nano-banana': 'gemini-2.5-flash-image-preview',
  'nano-banana-ext': 'gemini-2.5-flash-image-preview',
  'nano-banana-3.1': 'gemini-3.1-flash-image-preview',
  'nano-banana-pro': 'gemini-3-pro-image-preview',
};

/** 去掉 `provider/` 前缀并归一化别名，得到能力表查询 key。 */
function normalizeImageModelId(model: string): string {
  const stripped = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const key = stripped.toLowerCase().replace(
    /^(doubao-seedream-[45])-(\d)(?=-|$)/,
    '$1.$2',
  );
  return IMAGE_MODEL_ID_ALIASES[key] ?? key;
}

export function getImageCapability(model?: string): ImageCapability | undefined {
  if (model?.startsWith('grsai/')) {
    const capability = getGrsaiImageCapability(model);
    if (capability) return { ...capability, modelId: model.slice('grsai/'.length), resolutionStyle: 'none' };
  }
  if (model && (!model.includes('/') || model.startsWith('apimart/'))) {
    const key = model.replace(/^apimart\//, '').toLowerCase();
    const override = APIMART_IMAGE_CAPABILITIES[key];
    if (override) return override;
  }
  if (model && /^runninghub(?:-model)?\//.test(model)) {
    const definition = getRunningHubModel(model, true);
    if (!definition || definition.kind !== 'image') return undefined;
    const resolution = definition.parameters.find((field) => field.name === 'resolution');
    const ratio = definition.parameters.find((field) => ['aspectRatio', 'ratio'].includes(field.name));
    const references = definition.parameters.filter((field) => field.binding === 'image');
    return { modelId: definition.id, resolutions: resolution?.schema.enum?.map(String) ?? [], defaultResolution: String(resolution?.defaultValue ?? ''),
      ratios: ratio?.schema.enum?.map(String) ?? [], defaultRatio: String(ratio?.defaultValue ?? ''), resolutionStyle: resolution ? 'K' : 'none',
      supportsBatch: true, maxBatchCount: 16, supportsImageReference: references.length > 0,
      maxImageReferences: references.length ? Math.max(...references.map((field) => field.schema.type === 'array' ? (field.schema.maxItems ?? 64) : (field.referenceIndex ?? 0) + 1)) : 0,
      supportsDataUrlReference: true };
  }
  if (!model) return undefined;
  const normalizedModelId = normalizeImageModelId(model);
  const exact = IMAGE_CAPABILITIES[normalizedModelId];
  if (exact) return exact;
  const versionedKey = Object.keys(IMAGE_CAPABILITIES)
    .sort((left, right) => right.length - left.length)
    .find((key) => normalizedModelId.startsWith(`${key}-`));
  return versionedKey ? IMAGE_CAPABILITIES[versionedKey] : undefined;
}

/** 参数面板按生成入口相同的连接身份解析，兼容旧节点的原始 ID 和通用模型引用。 */
export function resolveImageParameterCapability(
  model: string | undefined,
  provider: string | undefined,
  config: Pick<AppConfig, 'providers' | 'generalModels'>,
): ImageCapability | undefined {
  if (!model) return undefined;
  const generalModel = provider === 'general'
    ? config.generalModels?.find((item) => item.id === model.replace(/^general\//, ''))
    : undefined;
  const connectionId = generalModel?.providerConfigId ?? provider;
  if (connectionId && getProviderDefinition(connectionId, config.providers[connectionId])?.id === 'grsai') {
    const modelId = generalModel?.modelId
      ?? (model.startsWith(`${connectionId}/`) ? model.slice(connectionId.length + 1) : model);
    return getImageCapability(modelId.startsWith('grsai/') ? modelId : `grsai/${modelId}`);
  }
  if (generalModel) {
    // 自定义网关的同名模型不能继承其他厂商能力。
    const declared = generalModel.imageCapability
      ?? config.providers[generalModel.providerConfigId]?.selectedModels?.find((item) => item.id === generalModel.modelId)?.imageCapability;
    if (!declared && getProviderDefinition(generalModel.providerConfigId,
      config.providers[generalModel.providerConfigId])?.id !== 'custom-openai') {
      const definition = getProviderDefinition(generalModel.providerConfigId, config.providers[generalModel.providerConfigId]);
      return getImageCapability(`${definition?.id}/${generalModel.modelId}`) ?? getImageCapability(model);
    }
    return { modelId: generalModel.modelId, resolutionStyle: 'none',
      ...declared, resolutions: declared?.resolutions ?? [], ratios: declared?.ratios ?? [] };
  }
  return getImageCapability(model);
}

/** 将分辨率档位换算为像素短边，用于结果回填的尺寸。 */
function shortSideFromResolution(resolution: string | undefined): number {
  if (!resolution) return 1024;
  const normalized = resolution.toLowerCase().trim();
  const map: Record<string, number> = {
    '0.5k': 512,
    '1k': 1024, '1mp': 1024, '720p': 720, '720': 720,
    '2k': 2048, '2mp': 1536, '3k': 3072, '3mp': 2048,
    '4k': 4096, '4mp': 2560, '1.5k': 1536,
  };
  return map[normalized] ?? 1024;
}

function shortSideToDimensions(shortSide: number, ratio: string): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number);
  if (!w || !h) return { width: shortSide, height: shortSide };
  if (w >= h) return { width: Math.round(shortSide * (w / h)), height: shortSide };
  return { width: shortSide, height: Math.round(shortSide * (h / w)) };
}

/**
 * 依据能力表把通用生图参数映射为请求体，并做数量 / 参考图能力校验。
 * 返回 null 表示该模型不在生图能力表中（调用方应回退到通用提交逻辑）。
 */
export function buildImageCapabilityRequest(
  model: string,
  prompt: string,
  params: ImageCapabilityRequestParams,
): ImageCapabilityRequest | null {
  const capability = getImageCapability(model);
  if (!capability) return null;

  const imageUrls = (params.imageUrls ?? []).filter(Boolean);

  // 图生图能力校验：不支持参考图的模型，传入参考图应显式报错而非静默丢弃。
  if (!capability.supportsImageReference && imageUrls.length > 0) {
    throw new Error(`图片模型 "${capability.modelId}" 不支持参考图（仅文生图）`);
  }
  if (imageUrls.length > (capability.maxImageReferences ?? 0)) {
    throw new Error(`${capability.modelId} 最多支持 ${capability.maxImageReferences} 张参考图`);
  }

  // 批量数量钳制：不支持批量或上限为 1 的模型固定为 1。
  const maxBatch = capability.supportsBatch === false
    ? 1
    : (capability.maxBatchCount ?? 1);
  const requestedCount = Math.min(maxBatch, Math.max(1, Math.floor(params.count ?? 1)));

  // 分辨率与比例：能力表未声明该档位时回退默认值。
  // 分辨率档位做大小写不敏感匹配（'2K' 与 '2k' 视为同一档），避免用户默认值被误判为不支持。
  const normalizedResolution = params.resolution?.toLowerCase();
  const matchedResolution = (capability.resolutions ?? []).find((item) => item.toLowerCase() === normalizedResolution);
  const resolution = matchedResolution ?? capability.defaultResolution;
  const requestedRatio = params.ratio === '自适应' ? 'auto' : params.ratio;
  const ratio = requestedRatio && (capability.ratios ?? []).includes(requestedRatio)
    ? requestedRatio
    : (capability.defaultRatio ?? '1:1');

  const body: Record<string, unknown> = {
    ...capability.staticFields,
    model: capability.modelId,
    prompt,
    n: requestedCount,
    [capability.ratioField ?? 'size']: ratio,
  };
  // 仅当能力表声明了分辨率字段风格才写 resolution（K / MP）；none 表示模型无此字段。
  if (capability.resolutionStyle !== 'none' && resolution) {
    body.resolution = resolution;
  }
  if (imageUrls.length > 0) {
    body.image_urls = imageUrls;
  }

  // 优先使用厂商公布的像素；auto 仅用方图估算布局，实际尺寸由产物加载确认。
  const presets = capability.dimensionPresets?.[resolution ?? ''];
  const preset = presets?.[ratio] ?? (ratio === 'auto' ? presets?.['1:1'] : undefined);
  const shortSide = shortSideFromResolution(resolution);
  const dimensions = preset
    ? { width: preset[0], height: preset[1] }
    : shortSideToDimensions(shortSide, ratio);

  return { body, dimensions, requestedCount };
}

/* ── 音频能力表 ── */

export type AudioCapabilityKind = 'speech' | 'music';

const AUDIO_CAPABILITIES: Record<string, AudioModelCapability> = {
  'gpt-4o-mini-tts': {
    kind: 'speech',
    voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    supportsVoiceReference: false,
  },
  flowmusic: {
    kind: 'music',
    supportsVoiceReference: false,
  },
  'flowmusic-lyria-3.5': { kind: 'music', supportsVoiceReference: false },
  suno: { kind: 'music', supportsVoiceReference: false },
  'suno-v6': { kind: 'music', supportsVoiceReference: false },
  'suno-v6-wild': { kind: 'music', supportsVoiceReference: false },
  'suno-v6-mini': { kind: 'music', supportsVoiceReference: false },
};

/** 结构化音频能力表（含音色列表 / 是否支持音色参考），供参数面板与生成入口消费。 */
export function getAudioCapabilityDetail(model: string): AudioModelCapability | undefined {
  if (/^runninghub(?:-model)?\//.test(model)) {
    const definition = getRunningHubModel(model);
    if (!definition?.audioPurpose) return undefined;
    return { kind: definition.audioPurpose, supportsVoiceReference: definition.parameters.some((field) => field.binding === 'audio'),
      voices: definition.parameters.find((field) => ['voice', 'voice_id', 'speaker'].includes(field.name))?.schema.enum?.map(String) };
  }
  return AUDIO_CAPABILITIES[normalizeImageModelId(model)];
}

export function getAudioCapability(model: string): AudioCapabilityKind | undefined {
  return getAudioCapabilityDetail(model)?.kind;
}
