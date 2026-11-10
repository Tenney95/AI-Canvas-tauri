/** 自定义媒体模型的能力与请求映射一致性；不推断厂商参数或发送网络请求。 */
import { t } from '../../i18n';
import type { GeneralModelCategory, ProviderModelSelection } from '../../types';
import type { ImageModelCapability, ModelProtocolPresetId, NormalizedModelExecutionProtocol, VideoGenerationInputMode, VideoGenerationOperation, VideoModelCapability } from '../../types/aiTypes';
import type { MediaGenerationParameters } from '../../types/media';
import { modelProtocolUsesVariable, resolveModelExecutionProfile } from './modelProtocol';

export const MEDIA_PARAMETER_TEXT_FIELDS = ['aspectRatio', 'resolution', 'imageQuality', 'imageBackground'] as const;

/** 允许常见厂商枚举与比例，禁止地址、路径和常见密钥格式进入媒体参数快照。 */
export function isSafeMediaParameterText(value: unknown, key: typeof MEDIA_PARAMETER_TEXT_FIELDS[number]): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  if (value === '') return key === 'imageBackground';
  if (value !== value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
  if (/[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(?:file|data|asset|blob|javascript|mailto|tel):/i.test(value)
    || /^(?:[a-z]:[\\/]|[\\/]|~[\\/])/i.test(value)
    || /(?:^|\s)bearer(?:\s+|[:=_-])\S/i.test(value)
    || /^basic\s+[a-z\d+\x2f=]{16,}$/i.test(value)
    || /(?:^|\s)(?:sk|mk|rk|pk|ak|key|token|api[-_]?key)[-_]/i.test(value)
    || /^(?:AIza[a-z\d_-]{15,}|gh[pousr]_[a-z\d]{10,}|github_pat_|xox[baprs]-|hf_)/i.test(value)
    || /^(?:www\.[^\s]+|[a-z\d.-]+\.[a-z]{2,}(?::\d+)?\/)/i.test(value)) return false;
  return true;
}

/** 提交前拒绝敏感值，不在错误信息中回显原参数。 */
export function assertSafeMediaParameterStrings(value: MediaGenerationParameters | undefined): void {
  if (!value) return;
  for (const key of MEDIA_PARAMETER_TEXT_FIELDS) {
    if (value[key] !== undefined && !isSafeMediaParameterText(value[key], key)) {
      throw new Error(`媒体参数 ${key} 格式无效；请使用所选模型声明的参数值`);
    }
  }
}

const RESULT_CATEGORY_LABELS: Record<GeneralModelCategory, string> = {
  text: '文本', image: '图片', video: '视频', audio: '音频',
};

const MODEL_PROTOCOL_PRESET_IDS: readonly ModelProtocolPresetId[] = [
  'openai-chat', 'anthropic-chat', 'gemini-chat', 'openai-image', 'openai-gpt-image',
  'gpt-image-gateway-json', 'google-image-native', 'xai-image-native', 'agnes-video', 'custom',
];

export function isModelProtocolPresetId(value: unknown): value is ModelProtocolPresetId {
  return typeof value === 'string' && MODEL_PROTOCOL_PRESET_IDS.includes(value as ModelProtocolPresetId);
}

/** 请求成功和结果可交付是两项独立条件；不能把文本结果当作视频试跑成功。 */
export function assertModelProtocolResult(
  category: GeneralModelCategory,
  result: { urls?: string[]; text?: string },
): void {
  if (category === 'text') {
    if (typeof result.text !== 'string' || !result.text.trim()) {
      throw new Error('请求成功，但没有解析出文本结果；请检查 response.result.textPath 或 poll.response.result.textPath');
    }
    return;
  }
  if (!result.urls?.length || result.urls.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('请求成功，但没有解析出有效媒体结果地址；请检查结果 URL、Base64 或二进制下载映射');
  }
  for (const rawValue of result.urls) {
    const value = rawValue.trim();
    if (/^data:/i.test(value)) {
      const match = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]+)$/i.exec(value);
      const mimeType = match?.[1].trim().toLowerCase();
      if (!mimeType || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
        || !mimeType.startsWith(`${category}/`) || !match?.[2].trim()) {
        throw new Error('请求成功，但实际返回的内联媒体 MIME 类型与模型类别不匹配，请检查厂商响应与结果映射');
      }
      continue;
    }
    let url: URL;
    try { url = new URL(value); } catch {
      throw new Error('请求成功，但结果字段不是有效的 HTTP(S) 媒体地址，请检查结果 URL 路径是否误指向文本字段');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('请求成功，但结果字段不是无凭据的 HTTP(S) 媒体地址，请检查厂商响应与结果映射');
    }
  }
}

/** 检查声明的输出类别，不依赖 URL 文件后缀推断媒体类型。 */
export function assertModelProtocolResultMapping(
  category: GeneralModelCategory,
  protocol: NormalizedModelExecutionProtocol,
): void {
  const asynchronous = protocol.mode === 'async';
  const result = asynchronous ? protocol.poll?.response.result : protocol.response.result;
  const location = asynchronous ? 'poll.response.result' : 'response.result';
  const binary = !asynchronous && protocol.response.type === 'binary';
  const text = !asynchronous && protocol.response.type === 'text';
  const hasMediaMapping = binary || !!(result?.urlPath || result?.base64Path || result?.download);
  if (category === 'text') {
    if (hasMediaMapping) throw new Error(`${location}：文本模型不能使用媒体结果映射，请配置 textPath 或同步 text 响应`);
    if (!text && !result?.textPath) {
      throw new Error(`${location}：文本模型必须配置 textPath，或使用同步 text 响应`);
    }
  } else if (text || !hasMediaMapping) {
    throw new Error(`${location}：${RESULT_CATEGORY_LABELS[category]}模型需要 URL、Base64、binary 响应或 download 映射，不能仅配置 textPath`);
  }
  const mimeType = result?.mimeType?.split(';')[0].trim().toLowerCase();
  if (mimeType && mimeType !== 'application/octet-stream'
    && !mimeType.startsWith(`${category === 'text' ? 'text' : category}/`)) {
    throw new Error(`${location}.mimeType 与${RESULT_CATEGORY_LABELS[category]}模型类别不匹配，请按厂商文档修改结果 MIME 类型`);
  }
}

export function assertImageModelCapability(capability: ImageModelCapability): void {
  for (const [field, defaultField] of [
    ['resolutions', 'defaultResolution'], ['ratios', 'defaultRatio'], ['qualities', 'defaultQuality'],
    ['backgrounds', 'defaultBackground'],
  ] as const) {
    const values = capability[field];
    if (values && (values.length === 0 || values.some((value) => !value.trim())
      || new Set(values.map((value) => value.toLowerCase())).size !== values.length)) {
      throw new Error(`${field} 必须是非空且不重复的选项`);
    }
    const fallback = capability[defaultField];
    if (fallback !== undefined && !values?.some((value) => value.toLowerCase() === fallback.toLowerCase())) {
      throw new Error(`${defaultField} 必须属于 ${field}`);
    }
  }
  for (const field of ['maxBatchCount', 'maxImageReferences'] as const) {
    const value = capability[field];
    if (value !== undefined && (!Number.isInteger(value) || value < (field === 'maxBatchCount' ? 1 : 0))) {
      throw new Error(`${field} 必须是有效整数`);
    }
  }
  if (capability.supportsBatch === false && (capability.maxBatchCount ?? 1) > 1) {
    throw new Error('不支持批量时 maxBatchCount 不能大于 1');
  }
  if (capability.supportsImageReference === false && (capability.maxImageReferences ?? 0) > 0) {
    throw new Error('不支持参考图时 maxImageReferences 不能大于 0');
  }
  if (capability.dimensionPresets) {
    for (const ratios of Object.values(capability.dimensionPresets)) {
      if (!ratios || typeof ratios !== 'object' || Array.isArray(ratios)) throw new Error('图片像素尺寸表必须按分辨率和比例声明');
      for (const dimensions of Object.values(ratios)) {
        if (!Array.isArray(dimensions) || dimensions.length !== 2
          || dimensions.some((value) => !Number.isInteger(value) || value <= 0)) {
          throw new Error('图片像素尺寸必须是两个正整数');
        }
      }
    }
    for (const resolution of capability.resolutions ?? []) {
      const key = Object.keys(capability.dimensionPresets).find((value) => value.toLowerCase() === resolution.toLowerCase());
      for (const ratio of capability.ratios ?? []) {
        // 动态画幅由输入/模型决定，不存在可要求补齐的固定像素。
        if (['auto', 'adaptive', '自适应'].includes(ratio)) continue;
        if (!key || !capability.dimensionPresets[key][ratio]) {
          throw new Error(`图片参数 ${resolution} / ${ratio} 缺少像素尺寸映射，请重新应用相应模板`);
        }
      }
    }
  }
}

/** 未声明质量能力或默认值时沿用接口默认，不把第一个候选档位当作默认。 */
export function resolveConfiguredImageQuality(
  capability: ImageModelCapability | undefined,
  imageQuality?: string,
): string | undefined {
  if (!capability?.qualities?.length) return undefined;
  assertImageModelCapability({ qualities: capability.qualities, defaultQuality: capability.defaultQuality });
  const selected = imageQuality ?? capability.defaultQuality;
  if (selected === undefined) return undefined;
  const match = capability.qualities.find((value) => value.toLowerCase() === selected.toLowerCase());
  if (!match) throw new Error(`图片模型不支持质量 ${selected}，可选：${capability.qualities.join('、')}`);
  return match;
}

/** 空字符串表示用户显式选择接口默认；undefined 才采用已声明的默认背景。 */
export function resolveConfiguredImageBackground(
  capability: ImageModelCapability | undefined,
  imageBackground?: string,
): string | undefined {
  if (!capability?.backgrounds?.length) return undefined;
  assertImageModelCapability({ backgrounds: capability.backgrounds, defaultBackground: capability.defaultBackground });
  if (imageBackground === '') return undefined;
  const selected = imageBackground ?? capability.defaultBackground;
  if (selected === undefined) return undefined;
  const match = capability.backgrounds.find((value) => value.toLowerCase() === selected.toLowerCase());
  if (!match) throw new Error(`图片模型不支持背景 ${selected}，可选：${capability.backgrounds.join('、')}`);
  return match;
}

export function resolveConfiguredImageParameters(
  capability: ImageModelCapability,
  params: { imageSize?: string; aspectRatio?: string; imageQuality?: string; imageBackground?: string; count: number },
): { imageSize: string; aspectRatio: string; imageQuality?: string; imageBackground?: string } {
  assertImageModelCapability(capability);
  const select = (value: string | undefined, allowed: string[] | undefined, fallback: string | undefined, label: string, legacy: string) => {
    const normalized = value === '自适应' ? 'auto' : value;
    if (normalized !== undefined && allowed?.length) {
      const match = allowed.find((item) => item.toLowerCase() === normalized.toLowerCase());
      if (!match) throw new Error(`图片模型不支持${label} ${value}，可选：${allowed.join('、')}`);
      return match;
    }
    return normalized ?? fallback ?? allowed?.[0] ?? legacy;
  };
  const maximum = capability.supportsBatch === false ? 1 : capability.maxBatchCount;
  if (maximum !== undefined && params.count > maximum) {
    throw new Error(`图片模型单次最多生成 ${maximum} 张图片`);
  }
  const imageQuality = resolveConfiguredImageQuality(capability, params.imageQuality);
  const imageBackground = resolveConfiguredImageBackground(capability, params.imageBackground);
  return {
    imageSize: select(params.imageSize, capability.resolutions, capability.defaultResolution, '分辨率', '2K'),
    aspectRatio: select(params.aspectRatio, capability.ratios, capability.defaultRatio, '比例', '1:1'),
    ...(imageQuality !== undefined ? { imageQuality } : {}),
    ...(imageBackground !== undefined ? { imageBackground } : {}),
  };
}

export function assertConfiguredImageReferences(capability: ImageModelCapability, count: number): void {
  if (count > 0 && capability.supportsImageReference === false) throw new Error('该图片模型不支持参考图（仅文生图）');
  if (capability.maxImageReferences !== undefined && count > capability.maxImageReferences) {
    throw new Error(`该图片模型最多支持 ${capability.maxImageReferences} 张参考图`);
  }
}

/** 按生成解析器的输入模式优先级，收集实际可用操作的比例候选。 */
function reachableVideoRatios(capability: VideoModelCapability): Set<string> {
  const operations: readonly VideoGenerationOperation[] = capability.operations?.length
    ? capability.operations : ['text-to-video', 'image-to-video', 'video-to-video'];
  const imagesAllowed = capability.maxImageReferences !== 0;
  const videosAllowed = capability.maxVideoReferences !== 0 && capability.maxVideoAudioReferences !== 0;
  const audioAllowed = capability.maxAudioReferences !== 0 && capability.maxVideoAudioReferences !== 0;
  const ratios = new Set<string>();
  for (const operation of operations) {
    const modes: VideoGenerationInputMode[] = [];
    if (operation === 'text-to-video') {
      if (!capability.requiresReference) modes.push('text');
      if (audioAllowed && capability.supportsStandaloneAudio !== false) modes.push('reference');
    } else if (operation === 'image-to-video' && imagesAllowed) {
      modes.push('keyframe', 'reference');
      if (capability.allowFrameAndReferenceMix !== false
        && (capability.maxImageReferences === undefined || capability.maxImageReferences >= 2 || audioAllowed)) modes.push('mixed');
    } else if (operation === 'video-to-video' && videosAllowed) {
      modes.push('reference');
      if (imagesAllowed && capability.allowFrameAndReferenceMix !== false) modes.push('mixed');
    }
    for (const mode of modes) {
      const modeCapability = capability.inputModeCapabilities?.[mode];
      const operationCapability = capability.operationCapabilities?.[operation];
      const options = modeCapability?.ratios ?? operationCapability?.ratios ?? capability.ratios;
      const fallback = modeCapability?.defaultRatio ?? operationCapability?.defaultRatio ?? capability.defaultRatio;
      for (const ratio of options ?? (fallback ? [fallback] : [])) ratios.add(ratio.toLowerCase());
    }
  }
  return ratios;
}

/** 多选项必须消费动态变量；单一固定值允许由厂商协议固定输出。 */
export function assertModelCapabilityProtocol(model: ProviderModelSelection): void {
  if (model.executionProfile && !isModelProtocolPresetId(model.executionProfile.preset)) {
    throw new Error('executionProfile.preset：调用协议预设不受当前应用支持');
  }
  if (model.imageCapability) assertImageModelCapability(model.imageCapability);
  if (model.imageCapability?.supportsDataUrlReference === false
    && model.imageReferenceRequestMode === 'generation-json-image-data-urls') {
    throw new Error(`模型“${model.name}”声明不支持 Base64 参考图，但请求方式会发送 Base64`);
  }
  const protocol = resolveModelExecutionProfile(model.executionProfile);
  if (model.executionProfile && !protocol && model.category !== 'text') {
    throw new Error('executionProfile.preset：原生文本协议不能用于媒体模型');
  }
  if (!protocol) return;
  assertModelProtocolResultMapping(model.category, protocol);
  if (model.category === 'image' && (model.imageCapability?.qualities?.length ?? 0) > 1
    && !modelProtocolUsesVariable(JSON.stringify(protocol.submit), 'imageQuality')) {
    throw new Error(`模型“${model.name}”声明可调质量，但提交协议没有映射 {{imageQuality}}`);
  }
  if (model.category === 'image') {
    const backgrounds = model.imageCapability?.backgrounds;
    const body = protocol.submit.body;
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
    const fixedBackground = typeof fields?.background === 'string' && !fields.background.includes('{{')
      ? fields.background : undefined;
    if (backgrounds?.length && !modelProtocolUsesVariable(JSON.stringify(protocol.submit), 'imageBackground')
      && !(backgrounds.length === 1 && backgrounds[0].toLowerCase() === fixedBackground?.toLowerCase())) {
      throw new Error(`模型“${model.name}”声明可调背景，但提交协议没有映射 {{imageBackground}}`);
    }
    if (typeof fields?.output_format === 'string' && fields.output_format.toLowerCase() === 'jpeg'
      && (backgrounds?.some((value) => value.toLowerCase() === 'transparent') || fixedBackground?.toLowerCase() === 'transparent')) {
      throw new Error(`模型“${model.name}”的透明背景不能与固定 output_format: jpeg 同时使用，请按渠道文档修改输出格式或背景能力`);
    }
  }
  // 厂商预设的请求映射由各预设维护；这里不把它当成用户声明的自定义参数。
  if (model.executionProfile?.preset !== 'custom') return;
  const source = JSON.stringify(protocol.submit);
  const requireMapping = (adjustable: boolean, label: string, variables: string[]) => {
    if (adjustable && !modelProtocolUsesVariable(source, ...variables)) {
      throw new Error(`模型“${model.name}”声明可调${label}，但提交协议没有映射 ${variables.map((value) => `{{${value}}}`).join(' / ')}`);
    }
  };
  if (model.category === 'image') {
    const capability = model.imageCapability;
    if (!capability) return;
    requireMapping((capability.resolutions?.length ?? 0) > 1, '分辨率', ['imageSize', 'size', 'width', 'height']);
    requireMapping((capability.ratios?.length ?? 0) > 1, '比例', ['aspectRatio', 'size', 'width', 'height']);
    requireMapping(capability.supportsBatch === true && (capability.maxBatchCount ?? 2) > 1, '数量', ['n', 'batchCount']);
    requireMapping(capability.supportsImageReference === true, '参考图', ['imageUrls', 'googleImageParts']);
    if (capability.supportsImageReference === false && modelProtocolUsesVariable(source, 'imageUrls', 'googleImageParts')) {
      throw new Error(`模型“${model.name}”声明不支持参考图，但协议仍映射参考图`);
    }
  } else if (model.category === 'video') {
    const capability = model.videoCapability;
    if (!capability) return;
    requireMapping((capability.resolutions?.length ?? 0) > 1, '分辨率', ['seedanceResolution', 'resolution', 'videoResolution', 'size', 'width', 'height']);
    requireMapping(reachableVideoRatios(capability).size > 1, '比例', ['aspectRatio', 'seedanceRatio', 'size', 'width', 'height']);
    requireMapping((capability.frameRates?.length ?? 0) > 1, '帧率', ['fps', 'videoFps', 'frames8n1', 'frames', 'videoFrames']);
    requireMapping((capability.durations?.length ?? 0) > 1
      || (capability.minDuration !== undefined && capability.maxDuration !== undefined && capability.minDuration !== capability.maxDuration),
    '时长', ['duration', 'durationText', 'seedanceDuration', 'frames8n1', 'frames', 'videoFrames']);
    requireMapping(capability.supportsAudio === true, '音频开关', ['generateAudio', 'disableAudio']);
  }
}

export function describeModelParameterGaps(model: ProviderModelSelection): string {
  const missing: string[] = [];
  if (model.category === 'image') {
    if (!model.imageCapability?.resolutions?.length) missing.push('分辨率');
    if (!model.imageCapability?.ratios?.length) missing.push('比例');
    if (model.imageCapability?.supportsBatch === undefined) missing.push('数量');
    if (model.imageCapability?.supportsImageReference === undefined) missing.push('参考图');
  } else if (model.category === 'video') {
    const capability = model.videoCapability;
    if (!capability?.resolutions?.length) missing.push('分辨率');
    if (!capability?.ratios?.length) missing.push('比例');
    if (!capability?.durations?.length && capability?.minDuration === undefined && capability?.maxDuration === undefined) missing.push('时长');
    if (!capability?.frameRates?.length) missing.push('帧率');
  }
  return missing.length ? t('{parameters}待确认（未声明）', { parameters: missing.map((label) => t(label)).join(', ') }) : '';
}
