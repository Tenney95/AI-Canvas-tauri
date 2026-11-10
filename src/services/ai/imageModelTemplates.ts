/** 用户显式选择的图片快速模板：能力、协议和参考图方式作为一个草稿更新。 */
import type { ImageReferenceRequestMode, ProviderModelSelection } from '../../types';
import type { ImageModelCapability, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue } from '../../types/aiTypes';
import { getImageSizePresets, resolveImageDimensions } from './modelSizeProfiles';

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
const GPT_DIMENSIONS = getImageSizePresets('openai-gpt');
function gptCapability(variant: ImageVariant, transport: ImageTransport): ImageModelCapability {
  const apimart = transport === 'apimart';
  // 官方 2.5 与 APIMart 2.5 Flare/Sunburst 已确认六档；未知 JSON 中转不继承同名能力。
  // APIMart 普通 GPT Image 2 没有公布 quality 字段。
  const qualities = transport === 'openai' || (apimart && variant === 'gpt-2.5')
    ? ['auto', 'low', 'medium', 'high', ...(variant === 'gpt-2.5' ? ['xhigh', 'max'] : [])] : undefined;
  return {
    resolutions: apimart ? ['1k', '2k', '4k'] : ['1K', '2K', '4K'],
    defaultResolution: apimart ? '1k' : '1K',
    ratios: Object.keys(GPT_DIMENSIONS['1K']),
    defaultRatio: '1:1', supportsBatch: !(apimart && variant === 'gpt-2'),
    maxBatchCount: apimart ? variant === 'gpt-2' ? 1 : 4 : 8,
    supportsImageReference: true,
    maxImageReferences: transport === 'images-json' ? 8 : 16,
    supportsDataUrlReference: !(apimart && variant === 'gpt-2.5'),
    ...(qualities ? { qualities, defaultQuality: 'auto' } : {}),
    ...(variant === 'gpt-2.5' && (transport === 'openai' || apimart)
      ? { backgrounds: ['auto', 'opaque', 'transparent'] } : {}),
    ...(!apimart ? { dimensionPresets: structuredClone(GPT_DIMENSIONS) }
      : variant === 'gpt-2.5' ? { dimensionPresets: getImageSizePresets('apimart-gpt-2.5') } : {}),
  };
}

function bananaCapability(variant: ImageVariant, transport: ImageTransport): ImageModelCapability {
  const original = variant === 'banana';
  const flash = variant === 'banana-2';
  const dimensionPresets = transport === 'apimart' || flash ? undefined
    : getImageSizePresets(original ? 'google-gemini-2.5-flash'
      : variant === 'banana-pro' ? 'google-gemini-3-pro' : 'google-nano-banana-2.1');
  return {
    resolutions: original ? ['1K'] : flash ? [transport === 'apimart' ? '0.5K' : '512', '1K', '2K', '4K'] : ['1K', '2K', '4K'],
    defaultResolution: '1K',
    ratios: [...BANANA_RATIOS, ...(flash || variant === 'banana-2.1' ? BANANA_EXTRA_RATIOS : [])],
    defaultRatio: '1:1', supportsBatch: false, maxBatchCount: 1,
    supportsImageReference: true,
    maxImageReferences: original ? 3 : 14,
    supportsDataUrlReference: true,
    ...(dimensionPresets ? { dimensionPresets } : {}),
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
    const protocol = structuredClone(APIMART_PROTOCOL);
    if (option.family === 'gpt' && option.variant === 'gpt-2.5') {
      protocol.submit.body = { ...(protocol.submit.body as Record<string, ProtocolJsonValue>),
        quality: '{{imageQuality}}', background: '{{imageBackground}}' };
    }
    executionProfile = { preset: 'custom', protocol };
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
  return resolveImageDimensions(capability, resolution, ratio);
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
