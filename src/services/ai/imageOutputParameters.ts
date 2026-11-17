import type { ImageModelCapability, ImageOutputFormat, ImageOutputParameters, ImageParameterRange } from '../../types/aiTypes';

export const IMAGE_OUTPUT_PARAMETER_KEYS = ['imageOutputFormat', 'imageFrameCount', 'imageFrameDurationMs', 'imageTransparent'] as const;
const OUTPUT_FORMATS: readonly ImageOutputFormat[] = ['png', 'gif', 'svg'];

export function pickImageOutputParameters(value: ImageOutputParameters | Record<string, unknown>): ImageOutputParameters {
  // 这里只投影白名单；来自协议/导入的未知值仍须经过下方严格校验。
  return Object.fromEntries(IMAGE_OUTPUT_PARAMETER_KEYS.flatMap((key) => value[key] !== undefined ? [[key, value[key]]] : [])) as ImageOutputParameters;
}

function assertRange(range: ImageParameterRange, label: string): void {
  const step = range.step ?? 1;
  if (![range.min, range.max, step, range.default].every(Number.isSafeInteger)
    || range.min <= 0 || range.max < range.min || step <= 0 || range.default < range.min || range.default > range.max
    || (range.default - range.min) % step !== 0) throw new Error(`${label}范围或默认值无效`);
}

export function assertImageOutputCapability(capability: ImageModelCapability): void {
  const formats = capability.outputFormats;
  if (formats !== undefined && (!Array.isArray(formats) || !formats.length
    || formats.some((value) => !OUTPUT_FORMATS.includes(value)) || new Set(formats).size !== formats.length)) {
    throw new Error('图片输出格式必须是非空、不重复的 PNG、GIF、SVG 选项');
  }
  if (capability.defaultOutputFormat !== undefined && !formats?.includes(capability.defaultOutputFormat)) {
    throw new Error('默认图片输出格式必须属于已声明格式');
  }
  for (const field of ['textOnlyOutputFormats', 'squareOnlyOutputFormats'] as const) {
    const values = capability[field];
    if (values !== undefined && (!Array.isArray(values) || new Set(values).size !== values.length
      || values.some((value) => !formats?.includes(value)))) throw new Error(`${field}必须属于已声明格式`);
  }
  for (const [field, label] of [['gifFrameCount', 'GIF帧数'], ['gifFrameDurationMs', 'GIF帧时长']] as const) {
    const range = capability[field];
    if (range !== undefined) {
      if (!formats?.includes('gif') || !range || typeof range !== 'object') throw new Error(`${label}需要声明GIF输出格式`);
      assertRange(range, label);
    }
  }
  if (capability.supportsGifTransparency !== undefined
    && (typeof capability.supportsGifTransparency !== 'boolean' || !formats?.includes('gif'))) {
    throw new Error('GIF透明能力需要声明GIF输出格式');
  }
}

function resolveRange(value: number | undefined, range: ImageParameterRange | undefined, label: string): number | undefined {
  if (!range) {
    if (value !== undefined) throw new Error(`所选模型未声明${label}`);
    return undefined;
  }
  const selected = value === undefined ? range.default : value;
  if (!Number.isSafeInteger(selected) || selected < range.min || selected > range.max
    || (selected - range.min) % (range.step ?? 1) !== 0) {
    throw new Error(`${label}须为${range.min}–${range.max}，步进${range.step ?? 1}`);
  }
  return selected;
}

/** 不为旧模型补造格式；显式不适用参数在产生网络副作用前拒绝。 */
export function resolveConfiguredImageOutput(
  capability: ImageModelCapability | undefined, params: ImageOutputParameters = {},
): ImageOutputParameters {
  if (capability) assertImageOutputCapability(capability);
  if (!capability?.outputFormats?.length) {
    if (IMAGE_OUTPUT_PARAMETER_KEYS.some((key) => params[key] !== undefined)) throw new Error('所选模型未声明图片输出格式参数');
    return {};
  }
  if (params.imageOutputFormat !== undefined && typeof params.imageOutputFormat !== 'string') throw new Error('图片输出格式无效');
  const requested = params.imageOutputFormat?.toLowerCase() ?? capability.defaultOutputFormat ?? capability.outputFormats[0];
  const format = capability.outputFormats.find((value) => value === requested);
  if (!format) throw new Error('图片输出格式不属于所选模型声明的选项');
  if (format !== 'gif') {
    if ([params.imageFrameCount, params.imageFrameDurationMs, params.imageTransparent].some((value) => value !== undefined)) {
      throw new Error('帧数、帧时长和透明选项仅适用于GIF输出');
    }
    return { imageOutputFormat: format };
  }
  if (params.imageTransparent !== undefined && typeof params.imageTransparent !== 'boolean') throw new Error('GIF透明选项须为布尔值');
  if (params.imageTransparent !== undefined && !capability.supportsGifTransparency) throw new Error('所选模型未声明GIF透明选项');
  const imageFrameCount = resolveRange(params.imageFrameCount, capability.gifFrameCount, 'GIF帧数');
  const imageFrameDurationMs = resolveRange(params.imageFrameDurationMs, capability.gifFrameDurationMs, 'GIF帧时长');
  return { imageOutputFormat: format,
    ...(imageFrameCount !== undefined ? { imageFrameCount } : {}),
    ...(imageFrameDurationMs !== undefined ? { imageFrameDurationMs } : {}),
    ...(capability.supportsGifTransparency ? { imageTransparent: params.imageTransparent ?? false } : {}) };
}

/** 共用参数面板和执行入口的格式约束，不修改保存的能力。 */
export function resolveImageOutputCapability<T extends ImageModelCapability>(capability: T | undefined, format?: ImageOutputFormat): T | undefined {
  if (!capability || !format || !capability.outputFormats?.includes(format)) return capability;
  const square = capability.squareOnlyOutputFormats?.includes(format);
  const textOnly = capability.textOnlyOutputFormats?.includes(format);
  return { ...capability,
    ...(square ? { ratios: ['1:1'], defaultRatio: '1:1' } : {}),
    ...(textOnly ? { supportsImageReference: false, maxImageReferences: 0 } : {}) };
}

export function assertImageOutputInput(capability: ImageModelCapability | undefined, params: ImageOutputParameters,
  input: { aspectRatio?: string; imageCount?: number; hasMask?: boolean }): void {
  const normalized = resolveConfiguredImageOutput(capability, params);
  const format = normalized.imageOutputFormat;
  if (!format) return;
  if (capability?.squareOnlyOutputFormats?.includes(format) && input.aspectRatio !== undefined && input.aspectRatio !== '1:1') {
    throw new Error('所选图片输出格式仅支持1:1方图');
  }
  if (capability?.textOnlyOutputFormats?.includes(format) && ((input.imageCount ?? 0) > 0 || input.hasMask)) {
    throw new Error('所选图片输出格式仅支持文生，不能包含参考图或蒙版');
  }
}
