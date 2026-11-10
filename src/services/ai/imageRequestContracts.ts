/**
 * 内置图片接口合同。按已确认的厂商身份选择协议，不按域名或模型名称猜兼容性。
 * 标准 Images 复用 standardImage；厂商 JSON 映射复用 modelProtocol。
 */
import type { NormalizedModelExecutionProtocol } from '../../types/aiTypes';
import type { ProviderDefinition } from './providerCatalogService';
import { mapImageDimensions } from '../aiDimensions';
import { getGrsaiImageCapability } from './grsaiModels';
import { resolveConfiguredImageBackground, resolveConfiguredImageQuality } from './modelCapabilityValidation';

export type BuiltInImageRequestContract = {
  kind: 'standard';
  imageReferenceRequestMode: 'edits-multipart';
} | {
  kind: 'protocol';
  referenceInput: 'data-url';
  protocol: NormalizedModelExecutionProtocol;
  dimensions: { width: number; height: number };
};

// https://qmy27nhsd9.apifox.cn/452392911e0
const GRSAI_NANO_MODELS = new Set([
  'nano-banana', 'nano-banana-fast', 'nano-banana-2', 'nano-banana-2.1', 'nano-banana-2-lite', 'nano-banana-2-cl',
  'nano-banana-2-2k-cl', 'nano-banana-2-4k-cl', 'nano-banana-pro',
  'nano-banana-pro-vt', 'nano-banana-pro-cl', 'nano-banana-pro-vip', 'nano-banana-pro-4k-vip',
]);
const GRSAI_GPT_MODELS = new Set([
  'gpt-image-2', 'gpt-image-2-vip', 'gpt-image-2.5', 'gpt-image-2.6',
  'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
]);

const GRSAI_NANO_RATIOS = new Set(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']);
const GRSAI_NANO_2_EXTRA_RATIOS = new Set(['1:4', '4:1', '1:8', '8:1']);

function dimensionsFromSize(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number);
  return { width, height };
}

export function resolveBuiltInImageRequestContract(
  definition: ProviderDefinition | undefined,
  modelId: string,
  imageSize: string,
  aspectRatio: string,
  imageQuality?: string,
  imageBackground?: string,
): BuiltInImageRequestContract | undefined {
  if (definition?.id === 'cccapi') {
    const model = definition.models?.find((item) => item.id === modelId);
    return model?.category === 'image' && model.imageReferenceRequestMode === 'edits-multipart'
      ? { kind: 'standard', imageReferenceRequestMode: 'edits-multipart' }
      : undefined;
  }
  if (definition?.id !== 'grsai') return undefined;
  const isNano = GRSAI_NANO_MODELS.has(modelId);
  if (!isNano && !GRSAI_GPT_MODELS.has(modelId)) return undefined;

  const requestedSize = imageSize === '720p' ? '1K' : imageSize;
  if (!['1K', '2K', '4K'].includes(requestedSize)) throw new Error(`GRSAI 不支持图片档位 ${imageSize}`);
  const capability = getGrsaiImageCapability(modelId);
  if (modelId === 'gpt-image-2.6' && aspectRatio !== '1:1') {
    throw new Error(`GRSAI ${modelId} 当前仅确认 1:1 比例，请在参数中选择 1:1`);
  }
  const background = resolveConfiguredImageBackground(capability, imageBackground);
  const normalizedSize = capability && !capability.resolutions?.includes(requestedSize)
    ? capability.defaultResolution! : requestedSize;
  let dimensions = mapImageDimensions(normalizedSize, aspectRatio);
  let sizeFields: Record<string, string>;
  if (isNano) {
    const supportsRatio = GRSAI_NANO_RATIOS.has(aspectRatio)
      || (modelId.startsWith('nano-banana-2') && modelId !== 'nano-banana-2-lite' && GRSAI_NANO_2_EXTRA_RATIOS.has(aspectRatio));
    if (!supportsRatio) throw new Error(`GRSAI ${modelId} 不支持比例 ${aspectRatio}`);
    sizeFields = { aspectRatio, imageSize: normalizedSize };
  } else {
    const isBase = modelId === 'gpt-image-2' || modelId === 'gpt-image-2.5';
    const pixels = capability?.dimensionPresets?.[normalizedSize]?.[aspectRatio];
    const size = pixels ? `${pixels[0]}x${pixels[1]}` : undefined;
    if (aspectRatio !== 'auto' && !size) throw new Error(`GRSAI ${modelId} 不支持比例 ${aspectRatio}`);
    if (size) dimensions = dimensionsFromSize(size);
    // 基础款只支持 1K，直接提交比例；VIP/2.5 增强款要求精确像素。
    sizeFields = { aspectRatio: isBase || aspectRatio === 'auto' ? aspectRatio : size!,
      quality: resolveConfiguredImageQuality(capability, imageQuality) ?? (isBase ? 'auto' : 'medium') };
  }
  return {
    kind: 'protocol',
    referenceInput: 'data-url',
    dimensions,
    protocol: {
      version: 2,
      mode: 'sync',
      auth: { type: 'bearer' },
      submit: {
        method: 'POST', path: '/api/generate', bodyEncoding: 'json',
        body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}',
          ...sizeFields, ...(background ? { background } : {}), replyType: 'json' },
      },
      response: { type: 'json', result: { urlPath: 'results.*.url' }, errorPath: 'error' },
    },
  };
}

/** 同步接口只有 succeeded 才可交付；保留服务端错误，不把任务 ID 当图片。 */
export function validateBuiltInImageResponse(payload: unknown): void {
  const result = payload as { status?: string; error?: string } | null;
  if (result?.status !== 'succeeded') {
    throw new Error(result?.error || '图片任务尚未成功完成，请先检查服务商任务记录，不要重复提交');
  }
}
