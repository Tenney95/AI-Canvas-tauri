/** 用户显式选择的图片快速模板：能力、协议和参考图方式作为一个草稿更新。 */
import type { ImageReferenceRequestMode, ProviderModelSelection } from '../../types';
import type { ImageModelCapability, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue } from '../../types/aiTypes';
import { mapImageDimensions } from '../aiDimensions';
import { VLM_MAX_IMAGES } from './imageUtils';

type GptVariant = 'gpt-2' | 'gpt-2.5';
type BananaVariant = 'banana' | 'banana-pro' | 'banana-2' | 'banana-2.1';
type ImageVariant = GptVariant | BananaVariant;
type ImageTransport = 'openai' | 'images-json' | 'google' | 'gemini-relay' | 'apimart';

interface ImageTemplateOption {
  id: string;
  family: 'gpt' | 'banana';
  label: string;
  modelLabel: string;
  formatLabel: string;
  variant: ImageVariant;
  transport: ImageTransport;
}

const GPT_VARIANTS: readonly [GptVariant, string][] = [
  ['gpt-2', 'GPT Image 2'], ['gpt-2.5', 'GPT Image 2.5'],
];
const BANANA_VARIANTS: readonly [BananaVariant, string][] = [
  ['banana', 'Nano Banana'], ['banana-pro', 'Nano Banana Pro'],
  ['banana-2', 'Nano Banana 2'], ['banana-2.1', 'Nano Banana 2.1'],
];

const FORMAT_LABELS: Record<ImageTransport, string> = {
  openai: 'OpenAI 官方 Images', 'images-json': '中转 JSON（images）',
  google: 'Google 官方 generateContent', 'gemini-relay': '中转 Gemini 原生透传', apimart: 'APIMart 异步',
};
function templateOption(family: ImageTemplateOption['family'], variant: ImageVariant, name: string, transport: ImageTransport): ImageTemplateOption {
  return { id: `${variant}:${transport}`, family, label: `${name} · ${FORMAT_LABELS[transport]}`,
    modelLabel: name, formatLabel: FORMAT_LABELS[transport], variant, transport };
}
export const IMAGE_QUICK_ADAPT_OPTIONS: readonly ImageTemplateOption[] = [
  ...GPT_VARIANTS.flatMap(([variant, name]) => (['openai', 'images-json', 'apimart'] as const)
    .map((transport) => templateOption('gpt', variant, name, transport))),
  ...BANANA_VARIANTS.flatMap(([variant, name]) => (['google', 'gemini-relay', 'apimart'] as const)
    .map((transport) => templateOption('banana', variant, name, transport))),
];

const BANANA_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const BANANA_EXTRA_RATIOS = ['1:4', '4:1', '1:8', '8:1'];
// 客户端选择的合法像素组合；遵守 GPT Image 2/2.5 的 16 对齐、比例和总像素限制。
// https://developers.openai.com/api/docs/guides/image-generation
const GPT_DIMENSIONS: NonNullable<ImageModelCapability['dimensionPresets']> = {
  '1K': {
    '1:1': [1024, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536],
    '4:3': [1024, 768], '3:4': [768, 1024], '5:4': [1280, 1024], '4:5': [1024, 1280],
    '16:9': [1536, 864], '9:16': [864, 1536], '2:1': [1536, 768], '1:2': [768, 1536],
    '21:9': [2016, 864], '9:21': [864, 2016], '3:1': [1536, 512], '1:3': [512, 1536],
  },
  '2K': {
    '1:1': [2048, 2048], '3:2': [2048, 1360], '2:3': [1360, 2048],
    '4:3': [2048, 1536], '3:4': [1536, 2048], '5:4': [2560, 2048], '4:5': [2048, 2560],
    '16:9': [2048, 1152], '9:16': [1152, 2048], '2:1': [2688, 1344], '1:2': [1344, 2688],
    '21:9': [2688, 1152], '9:21': [1152, 2688], '3:1': [3072, 1024], '1:3': [1024, 3072],
  },
  '4K': {
    '1:1': [2880, 2880], '3:2': [3520, 2336], '2:3': [2336, 3520],
    '4:3': [3312, 2480], '3:4': [2480, 3312], '5:4': [3216, 2576], '4:5': [2576, 3216],
    '16:9': [3840, 2160], '9:16': [2160, 3840], '2:1': [3840, 1920], '1:2': [1920, 3840],
    '21:9': [3840, 1648], '9:21': [1648, 3840], '3:1': [3840, 1280], '1:3': [1280, 3840],
  },
};
function gptCapability(variant: ImageVariant, transport: ImageTransport): ImageModelCapability {
  const apimart = transport === 'apimart';
  return {
    resolutions: apimart ? ['1k', '2k', '4k'] : ['1K', '2K', '4K'],
    defaultResolution: apimart ? '1k' : '1K',
    ratios: Object.keys(GPT_DIMENSIONS['1K']),
    defaultRatio: '1:1', supportsBatch: !(apimart && variant === 'gpt-2'),
    maxBatchCount: apimart ? variant === 'gpt-2' ? 1 : 4 : 8,
    supportsImageReference: true,
    maxImageReferences: transport === 'images-json' ? 8 : 16,
    supportsDataUrlReference: !(apimart && variant === 'gpt-2.5'),
    ...(!apimart ? { dimensionPresets: structuredClone(GPT_DIMENSIONS) } : {}),
  };
}

function bananaCapability(variant: ImageVariant, transport: ImageTransport): ImageModelCapability {
  const original = variant === 'banana';
  const flash = variant === 'banana-2';
  return {
    resolutions: original ? ['1K'] : flash ? [transport === 'apimart' ? '0.5K' : '512', '1K', '2K', '4K'] : ['1K', '2K', '4K'],
    defaultResolution: '1K',
    ratios: [...BANANA_RATIOS, ...(flash || variant === 'banana-2.1' ? BANANA_EXTRA_RATIOS : [])],
    defaultRatio: '1:1', supportsBatch: false, maxBatchCount: 1,
    supportsImageReference: true,
    // 原生 inlineData 沿用应用现有 Base64 内存预算；URL 型 APIMart 保留渠道上限。
    maxImageReferences: Math.min(original ? 3 : 14, transport === 'apimart' ? 14 : VLM_MAX_IMAGES),
    supportsDataUrlReference: true,
  };
}

// https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.5/generation
// https://docs.apimart.ai/en/api-reference/images/gemini-3-pro/generation
// https://docs.apimart.ai/cn/api-reference/tasks/status
const APIMART_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/images/generations', bodyEncoding: 'json', body: {
    model: '{{model}}', prompt: '{{prompt}}', size: '{{aspectRatio}}',
    resolution: '{{imageSize}}', n: '{{n}}', image_urls: '{{imageUrls}}',
  } },
  response: { type: 'json', taskIdPath: 'data.0.task_id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/tasks/{{submit.data.0.task_id}}', intervalMs: 2000,
    response: { statusPath: 'data.status', successValues: ['completed'], failureValues: ['failed', 'cancelled'],
      result: { urlPath: 'data.result.images.*.url', mimeType: 'image/png' },
      errorPath: 'data.error.message', progressPath: 'data.progress' },
  },
};

function googleProtocol(variant: ImageVariant, relay: boolean): NormalizedModelExecutionProtocol {
  // Google 当前文档用 responseFormat；原生中转沿用 ImageConfig 字段合同。
  // https://ai.google.dev/gemini-api/docs/generate-content/image-generation
  // https://ai.google.dev/api/generate-content#ImageConfig
  const image: Record<string, ProtocolJsonValue> = {
    aspectRatio: '{{aspectRatio}}', ...(variant !== 'banana' ? { imageSize: '{{imageSize}}' } : {}),
  };
  return {
    version: 2, mode: 'sync', auth: relay ? { type: 'bearer' } : { type: 'header', name: 'x-goog-api-key' },
    submit: { method: 'POST', path: `${relay ? '/v1beta' : '/v1'}/models/{{model}}:generateContent`, pathMode: 'origin', bodyEncoding: 'json',
      body: { contents: [{ role: 'user', parts: '{{googleImageParts}}' }], generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'], ...(relay ? { imageConfig: image } : { responseFormat: { image } }),
      } },
    },
    response: { type: 'json', result: { base64Path: 'candidates.*.content.parts.*.inlineData.data', mimeType: 'image/png' }, errorPath: 'error.message' },
  };
}

export function createImageQuickAdaptTemplate(templateId: string): Pick<ProviderModelSelection,
  'imageCapability' | 'executionProfile' | 'imageReferenceRequestMode'> {
  const option = IMAGE_QUICK_ADAPT_OPTIONS.find((item) => item.id === templateId);
  if (!option) throw new Error('未找到图片参数模板');
  let executionProfile: ModelExecutionProfile;
  let imageReferenceRequestMode: ImageReferenceRequestMode | undefined;
  if (option.transport === 'openai') {
    executionProfile = { preset: 'openai-gpt-image' };
    imageReferenceRequestMode = 'edits-multipart';
  } else if (option.transport === 'images-json') {
    executionProfile = { preset: 'gpt-image-gateway-json' };
    imageReferenceRequestMode = 'generation-json-image-urls';
  } else if (option.transport === 'apimart') {
    executionProfile = { preset: 'custom', protocol: structuredClone(APIMART_PROTOCOL) };
    imageReferenceRequestMode = 'generation-json-image-urls';
  } else {
    executionProfile = { preset: 'custom', protocol: googleProtocol(option.variant, option.transport === 'gemini-relay') };
    // 沿用已有本地素材读取和 Base64 准备路径；模板随后转成原生 inlineData。
    imageReferenceRequestMode = 'generation-json-image-data-urls';
  }
  return { imageCapability: option.family === 'gpt' ? gptCapability(option.variant, option.transport)
    : bananaCapability(option.variant, option.transport), executionProfile, imageReferenceRequestMode };
}

/** 有显式像素表时不能再走通用短边换算，也不能把编辑后的未映射组合静默降级。 */
export function resolveImageTemplateDimensions(capability: ImageModelCapability | undefined, resolution: string, ratio: string) {
  if (!capability?.dimensionPresets) {
    const halfK = resolution === '512' || resolution.toUpperCase() === '0.5K';
    const dimensions = mapImageDimensions(halfK ? '1K' : resolution.toUpperCase(), ratio);
    return halfK ? { width: Math.round(dimensions.width / 2), height: Math.round(dimensions.height / 2) } : dimensions;
  }
  const resolutionKey = Object.keys(capability.dimensionPresets).find((key) => key.toLowerCase() === resolution.toLowerCase());
  const dimensions = resolutionKey ? capability.dimensionPresets[resolutionKey][ratio] : undefined;
  if (!dimensions) throw new Error(`图片参数 ${resolution} / ${ratio} 缺少像素尺寸映射，请重新应用模板或补齐尺寸表`);
  return { width: dimensions[0], height: dimensions[1] };
}

/** 请求与本地预览共用，不上传、不打印参考图。素材已由现有准备路径转为 data URL。 */
export function buildGoogleImageParts(prompt: string, imageUrls: string[]): ProtocolJsonValue[] {
  return [{ text: prompt }, ...imageUrls.map((url) => {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
    if (!match) throw new Error('Google 原生图片参考素材必须是有效的 Base64 图片');
    return { inlineData: { mimeType: match[1], data: match[2].replace(/\s/g, '') } };
  })];
}

/** 交付校验只把原生图片块还原为素材身份；提示词和 MIME 字符串不算参考图。 */
export function readGoogleImagePartsReferenceUrls(value: unknown): (string | undefined)[] {
  if (!Array.isArray(value)) return [];
  // 保留原始下标，不能让 parts.0（提示词）被误判为第一张参考图。
  return value.map((part: unknown) => {
    if (!part || typeof part !== 'object' || !('inlineData' in part)) return undefined;
    const inline = part.inlineData;
    return inline && typeof inline === 'object' && 'mimeType' in inline && 'data' in inline
      && typeof inline.mimeType === 'string' && typeof inline.data === 'string'
      ? `data:${inline.mimeType};base64,${inline.data}` : undefined;
  });
}
