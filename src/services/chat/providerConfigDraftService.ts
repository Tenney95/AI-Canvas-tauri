/**
 * 创建和管理任务级 Provider 配置草稿，负责协议示例分析、字段裁剪与凭据排除。
 * 草稿有数量和存活期限制，不直接写入正式配置。
 */
import type {
  ApiProviderConfig,
  ChatApiProtocol,
  GeneralModelCategory,
  ImageReferenceRequestMode,
  ProviderModelSelection,
} from '../../types';
import { GENERAL_MODEL_CATEGORY_LABELS } from '../../types';
import type {
  ModelExecutionProfile,
  ModelExecutionProtocol,
  NormalizedModelExecutionProtocol,
  VideoGenerationInputMode,
  VideoGenerationOperation,
  VideoModelCapability,
} from '../../types/aiTypes';
import {
  analyzeModelProtocolExamples,
  type ModelProtocolExamples,
} from '../ai/modelProtocolImport';
import {
  modelProtocolUsesVariable,
  parseModelExecutionProtocol,
  previewModelProtocolRequest,
  resolveModelExecutionProfile,
  validateModelExecutionProtocol,
  type ModelProtocolVariables,
} from '../ai/modelProtocol';
import {
  REFERENCE_PROTOCOL_VARIABLES,
  getCategoryProtocolVariables,
} from '../ai/modelProtocolVariables';
import { findModelProtocolForEachCapabilityConflicts } from '../ai/modelProtocolRuntime';
import { normalizeBaseUrl as normalizeUrlInput } from '../ai/providerBaseUrl';
import {
  CHAT_API_PROTOCOL_LABELS,
  resolveChatApiProtocol,
} from '../ai/chatApiProtocol';
import { assertVideoModelCapability } from '../ai/videoRequestResolver';

const PROVIDER_CONFIG_DRAFT_TTL_MS = 30 * 60 * 1_000;
const MAX_PROVIDER_CONFIG_DRAFTS = 32;
const MAX_DECLARATIVE_PROTOCOL_BYTES = 64 * 1_024;
const MAX_DECLARATIVE_PROTOCOL_DEPTH = 32;
const MAX_DECLARATIVE_PROTOCOL_NODES = 4_096;
const DOCUMENTATION_HOST_LABELS = new Set(['doc', 'docs', 'documentation', 'developer']);
const CREDENTIAL_FIELD_FRAGMENTS = ['token', 'key', 'secret', 'password', 'credential'] as const;
const CREDENTIAL_FIELD_EXACT_NAMES = new Set(['authorization']);
// keyframe 是视频输入形态而非凭据。其余包含 key 的任意未知键仍按凭据拒绝。
const SAFE_KEY_FIELD_NAMES = new Set(['keyframe', 'keyframes']);
const MODEL_IDENTIFIER_FIELD_NAMES = new Set(['model', 'modelid', 'modelname', 'modelcode', 'models']);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROTOCOL_TEMPLATE_ROOT_RE = /{{\s*([a-zA-Z][a-zA-Z0-9_]*)/g;
const CREDENTIAL_LITERAL_PATTERNS = [
  /^\s*Bearer\s+\S{12,}\s*$/i,
  /^\s*sk-[A-Za-z0-9_-]{12,}\s*$/,
  /^\s*AKIA[0-9A-Z]{16}\s*$/,
  /^\s*[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\s*$/,
];
const HEX_CREDENTIAL_LITERAL_RE = /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const BASE64URL_LITERAL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const FULL_TRUSTED_TEMPLATE_RE = /^{{\s*[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*\s*}}$/;
const VIDEO_IMAGE_REFERENCE_VARIABLES = [
  'imageUrls',
  'firstImage',
  'lastImage',
  'imageWithRoles',
  'referenceImageUrls',
] as const;
const VIDEO_KEYFRAME_VARIABLES = [
  'imageUrls',
  'firstImage',
  'lastImage',
  'imageWithRoles',
] as const;
const VIDEO_REFERENCE_IMAGE_VARIABLES = ['referenceImageUrls'] as const;
const VIDEO_VIDEO_REFERENCE_VARIABLES = [
  'videoUrls',
  'referenceVideoUrl',
  'referenceVideoUrls',
] as const;
const VIDEO_AUDIO_REFERENCE_VARIABLES = [
  'audioUrls',
  'audioUrl',
  'referenceAudioUrls',
] as const;
const VIDEO_GENERIC_REFERENCE_VARIABLES = ['referenceUrls', 'inlineReferences'] as const;

export type ProviderConfigProtocolSource = 'examples' | 'declarative';

export interface ProviderConfigModelExamples extends Partial<ModelProtocolExamples> {
  /** 缺省保持原有示例推断模式；declarative 直接使用本地校验通过的声明式协议。 */
  protocolSource?: ProviderConfigProtocolSource;
  /** protocolSource=declarative 时必填；不得与四个请求/响应示例字段混用。 */
  executionProtocol?: ModelExecutionProtocol;
  modelId?: string;
  name?: string;
  category?: GeneralModelCategory;
  /** 文档里的模型用途说明，显示在模型选择器里。 */
  description?: string;
  /** 文档声明的输入模态；含 'image' 表示该文本模型可读图。 */
  inputModalities?: Array<'text' | 'image'>;
  /** 文档写明的上下文窗口（token），只对文本模型有意义。 */
  contextWindow?: number;
  imageReferenceRequestMode?: ImageReferenceRequestMode;
  videoCapability?: VideoModelCapability;
}

export interface ProviderConfigDraftInput {
  connectionId?: string;
  connectionName: string;
  baseUrl?: string;
  /** 文本/对话请求协议；旧调用缺省为 OpenAI 兼容。 */
  chatApiProtocol?: ChatApiProtocol;
  models: ProviderConfigModelExamples[];
}

export type ProviderConfigDraftConfig = Omit<ApiProviderConfig, 'apiKey'>;

export interface ProviderConfigDraft {
  id: string;
  taskId: string;
  projectId?: string;
  conversationId?: string;
  connectionId: string;
  connectionName: string;
  baseUrl: string;
  config: ProviderConfigDraftConfig;
  /** 更新已有模型时允许覆盖的字段；新模型使用完整校验后的配置。 */
  modelUpdateFields: Record<string, Array<keyof ProviderModelSelection>>;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

export interface ProviderConfigDraftAccessScope {
  projectId: string;
  conversationId: string;
}

const drafts = new Map<string, ProviderConfigDraft>();
// 仅用于比较的内存基线，不暴露给模型、不进入草稿摘要或持久化。
const draftTargets = new WeakMap<ProviderConfigDraft, { connectionId: string; snapshot: string }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCredentialFieldName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isCredentialFieldName(value: string): boolean {
  const normalized = normalizeCredentialFieldName(value);
  if (SAFE_KEY_FIELD_NAMES.has(normalized)) return false;
  return CREDENTIAL_FIELD_EXACT_NAMES.has(normalized)
    || CREDENTIAL_FIELD_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function hasHighRiskBase64UrlShape(value: string): boolean {
  if (value.length < 43 || value.length > 4_096 || !BASE64URL_LITERAL_RE.test(value)) {
    return false;
  }
  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[_-]/]
    .filter((pattern) => pattern.test(value)).length;
  const uniqueCharacters = new Set(value.replace(/=/g, '')).size;
  return uniqueCharacters >= 12
    && (characterClasses >= 3 || (value.length >= 64 && characterClasses >= 2));
}

function looksLikeCredentialLiteral(value: string, parentKey?: string): boolean {
  const candidate = value.trim();
  if (!candidate || FULL_TRUSTED_TEMPLATE_RE.test(candidate)) return false;
  const normalizedParentKey = parentKey ? normalizeCredentialFieldName(parentKey) : '';
  // 模型 ID 可能本来就是内容哈希；URL / 相对路径也可能包含哈希段，不能误判为凭据。
  if (
    MODEL_IDENTIFIER_FIELD_NAMES.has(normalizedParentKey)
    || /^(?:https?:\/\/|data:|\/)/i.test(candidate)
  ) {
    return false;
  }
  return CREDENTIAL_LITERAL_PATTERNS.some((pattern) => pattern.test(candidate))
    || HEX_CREDENTIAL_LITERAL_RE.test(candidate)
    || hasHighRiskBase64UrlShape(candidate);
}

function containsCredentialField(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isCredentialFieldName(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

function assertSafeDeclarativeProtocol(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('声明式调用协议必须是可序列化的 JSON 对象');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_DECLARATIVE_PROTOCOL_BYTES) {
    throw new Error(`声明式调用协议不能超过 ${MAX_DECLARATIVE_PROTOCOL_BYTES / 1_024} KiB`);
  }

  let nodes = 0;
  const visit = (current: unknown, depth: number, parentKey?: string): void => {
    nodes += 1;
    if (nodes > MAX_DECLARATIVE_PROTOCOL_NODES) {
      throw new Error(`声明式调用协议最多允许 ${MAX_DECLARATIVE_PROTOCOL_NODES} 个 JSON 节点`);
    }
    if (depth > MAX_DECLARATIVE_PROTOCOL_DEPTH) {
      throw new Error(`声明式调用协议嵌套深度不能超过 ${MAX_DECLARATIVE_PROTOCOL_DEPTH} 层`);
    }
    if (typeof current === 'string') {
      if (looksLikeCredentialLiteral(current, parentKey)) {
        throw new Error('声明式调用协议不得包含疑似真实凭据值');
      }
      return;
    }
    if (
      current === null
      || typeof current === 'boolean'
      || (typeof current === 'number' && Number.isFinite(current))
    ) {
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1, parentKey));
      return;
    }
    if (!isRecord(current)) {
      throw new Error('声明式调用协议只能包含标准 JSON 值');
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('声明式调用协议只能包含普通 JSON 对象');
    }
    for (const [key, child] of Object.entries(current)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        throw new Error(`声明式调用协议包含不安全对象键：${key}`);
      }
      if (isCredentialFieldName(key)) {
        throw new Error(`声明式调用协议不得包含凭据字段：${key}`);
      }
      visit(child, depth + 1, key);
    }
  };
  visit(value, 0);
}

function assertDeclarativeProtocolCategoryVariables(
  value: unknown,
  category: GeneralModelCategory,
): void {
  const supported = new Set(getCategoryProtocolVariables(category));
  supported.add('submit');
  const source = JSON.stringify(value);
  for (const match of source.matchAll(PROTOCOL_TEMPLATE_ROOT_RE)) {
    const root = match[1];
    if (!supported.has(root)) {
      throw new Error(`声明式调用协议使用了${GENERAL_MODEL_CATEGORY_LABELS[category]}模型不会提供的变量：${root}`);
    }
  }
}

function usesSubmitVariables(
  submitSource: string,
  variables: readonly string[],
): boolean {
  return modelProtocolUsesVariable(submitSource, ...variables);
}

function dryRunReferenceCount(maximum: number | undefined): number {
  if (maximum === 0) return 0;
  return maximum === 1 ? 1 : 2;
}

function createVideoDryRunVariables(
  modelId: string,
  operation: VideoGenerationOperation,
  inputMode: VideoGenerationInputMode,
  promptMarker: string,
): ModelProtocolVariables {
  return {
    model: modelId,
    prompt: promptMarker,
    n: 1,
    batchCount: 1,
    size: '1280x720',
    aspectRatio: '16:9',
    width: 1280,
    height: 720,
    frames: 49,
    frames8n1: 49,
    fps: 24,
    duration: 5,
    durationText: '5',
    resolution: '720p',
    videoResolution: 720,
    videoFrames: 49,
    videoFps: 24,
    seedanceResolution: '720p',
    seedanceRatio: '16:9',
    seedanceDuration: 5,
    generateAudio: true,
    disableAudio: false,
    videoOperation: operation,
    videoInputMode: inputMode,
  };
}

interface DryRunReference {
  marker: string;
  url: string;
}

function createDryRunReferences(kind: string, count: number): DryRunReference[] {
  return Array.from({ length: count }, (_, index) => {
    const marker = `AICANVAS_DRY_RUN_${kind.toUpperCase()}_${index + 1}_Q7Z`;
    return { marker, url: `https://dry-run.invalid/${marker}` };
  });
}

function addDryRunImages(
  variables: ModelProtocolVariables,
  references: DryRunReference[],
  mode: 'keyframe' | 'reference',
): void {
  const urls = references.map((reference) => reference.url);
  variables.imageUrls = urls;
  variables.imageWithRoles = urls.map((url, index) => ({
    url,
    role: mode === 'keyframe'
      ? index === 0 ? 'first_frame' : 'last_frame'
      : 'reference_image',
  }));
  if (mode === 'keyframe') {
    variables.firstImage = urls[0];
    if (urls.length > 1) variables.lastImage = urls[urls.length - 1];
  } else {
    variables.referenceImageUrls = urls;
  }
}

function addDryRunVideos(
  variables: ModelProtocolVariables,
  references: DryRunReference[],
): void {
  const urls = references.map((reference) => reference.url);
  variables.videoUrls = urls;
  variables.referenceVideoUrl = urls[0];
  variables.referenceVideoUrls = urls;
}

function addDryRunAudios(
  variables: ModelProtocolVariables,
  references: DryRunReference[],
): void {
  const urls = references.map((reference) => reference.url);
  variables.audioUrls = urls;
  variables.audioUrl = urls[0];
  variables.referenceAudioUrls = urls;
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const found = source.indexOf(needle, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + needle.length;
  }
  return count;
}

function assertDeclarativeVideoDryRun(
  protocol: NormalizedModelExecutionProtocol,
  baseUrl: string,
  modelId: string,
  label: string,
  operation: VideoGenerationOperation,
  inputMode: VideoGenerationInputMode,
  references: DryRunReference[],
  configureReferences?: (variables: ModelProtocolVariables) => void,
): void {
  const promptMarker = `AICANVAS_DRY_RUN_PROMPT_${inputMode.toUpperCase()}_Q7Z`;
  const variables = createVideoDryRunVariables(modelId, operation, inputMode, promptMarker);
  configureReferences?.(variables);
  const referenceUrls = references.map((reference) => reference.url);
  if (referenceUrls.length > 0) variables.referenceUrls = referenceUrls;

  let preview: ReturnType<typeof previewModelProtocolRequest>;
  try {
    // 这里只渲染同源 URL、headers 和 body；preview 不调用 fetch，绝不会向厂商发请求。
    preview = previewModelProtocolRequest({ baseUrl, protocol, variables });
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地请求渲染失败';
    throw new Error(`视频声明式协议无法执行${label}本地 dry-run：${message}`, { cause: error });
  }
  const rendered = JSON.stringify(preview);
  if (!rendered.includes(promptMarker)) {
    throw new Error(`视频声明式协议的 ${label} 请求没有实际发送动态 {{prompt}}`);
  }
  for (const reference of references) {
    const occurrences = countOccurrences(rendered, reference.marker);
    if (occurrences === 0) {
      throw new Error(`视频声明式协议的 ${label} 请求没有消费全部参考素材`);
    }
    if (occurrences > 1) {
      throw new Error(
        `视频声明式协议的 ${label} 请求重复映射了同一参考素材，`
        + '可能同时输出了互斥的请求字段',
      );
    }
  }
}

function assertDeclarativeVideoProtocolSemantics(
  protocol: NormalizedModelExecutionProtocol,
  capability: VideoModelCapability,
  baseUrl: string,
  modelId: string,
): void {
  const submitSource = JSON.stringify(protocol.submit);
  if (!modelProtocolUsesVariable(submitSource, 'prompt')) {
    throw new Error('视频声明式协议的 submit 必须动态绑定 {{prompt}}，不能发送固定提示词');
  }
  const expansionConflicts = findModelProtocolForEachCapabilityConflicts(protocol, capability);
  if (expansionConflicts.length > 0) {
    throw new Error(expansionConflicts[0]);
  }

  const operations = new Set(capability.operations ?? []);
  const usesImage = usesSubmitVariables(submitSource, VIDEO_IMAGE_REFERENCE_VARIABLES);
  const usesKeyframe = usesSubmitVariables(submitSource, VIDEO_KEYFRAME_VARIABLES);
  const usesReferenceImage = usesSubmitVariables(submitSource, VIDEO_REFERENCE_IMAGE_VARIABLES);
  const usesVideo = usesSubmitVariables(submitSource, VIDEO_VIDEO_REFERENCE_VARIABLES);
  const usesAudio = usesSubmitVariables(submitSource, VIDEO_AUDIO_REFERENCE_VARIABLES);
  const usesGeneric = usesSubmitVariables(submitSource, VIDEO_GENERIC_REFERENCE_VARIABLES);

  if (operations.has('image-to-video') && !usesImage && !usesGeneric) {
    throw new Error('videoCapability.operations 声明 image-to-video，但 submit 没有图片参考字段');
  }
  if (operations.has('video-to-video') && !usesVideo && !usesGeneric) {
    throw new Error('videoCapability.operations 声明 video-to-video，但 submit 没有视频参考字段');
  }
  if (usesVideo && !operations.has('video-to-video')) {
    throw new Error('submit 使用了视频参考字段，但 videoCapability.operations 未声明 video-to-video');
  }
  if (usesImage && !operations.has('image-to-video') && !operations.has('video-to-video')) {
    throw new Error('submit 使用了图片参考字段，但 videoCapability.operations 未声明可接收图片的操作');
  }
  const canUseGenericReference = operations.has('image-to-video')
    || operations.has('video-to-video')
    || capability.supportsStandaloneAudio === true
    || (capability.maxAudioReferences ?? 0) > 0;
  if (usesGeneric && !canUseGenericReference) {
    throw new Error('submit 使用了通用参考素材字段，但 videoCapability 未声明对应参考能力');
  }

  if (operations.has('image-to-video') && capability.maxImageReferences === 0) {
    throw new Error('videoCapability.operations 声明 image-to-video，但 maxImageReferences 为 0');
  }
  if (operations.has('video-to-video') && capability.maxVideoReferences === 0) {
    throw new Error('videoCapability.operations 声明 video-to-video，但 maxVideoReferences 为 0');
  }
  const referenceRules: Array<[string, number | undefined, boolean]> = [
    ['图片', capability.maxImageReferences, usesImage],
    ['视频', capability.maxVideoReferences, usesVideo],
    ['音频', capability.maxAudioReferences, usesAudio],
  ];
  for (const [kind, maximum, usesTypedField] of referenceRules) {
    if (maximum === 0 && usesTypedField) {
      throw new Error(`videoCapability 声明不支持参考${kind}，但 submit 仍包含对应参考字段`);
    }
    if ((maximum ?? 0) > 0 && !usesTypedField && !usesGeneric) {
      throw new Error(`videoCapability 声明支持参考${kind}，但 submit 没有对应参考字段`);
    }
  }
  if (capability.supportsStandaloneAudio && !usesAudio && !usesGeneric) {
    throw new Error('videoCapability 声明 supportsStandaloneAudio，但 submit 没有音频参考字段');
  }
  if (capability.supportsStandaloneAudio && !operations.has('text-to-video')) {
    throw new Error('supportsStandaloneAudio 需要 operations 声明 text-to-video');
  }

  const modeCapabilities = capability.inputModeCapabilities;
  if (modeCapabilities?.text && !operations.has('text-to-video')) {
    throw new Error('inputModeCapabilities.text 与 operations 不一致');
  }
  if (modeCapabilities?.keyframe && !operations.has('image-to-video')) {
    throw new Error('inputModeCapabilities.keyframe 与 operations 不一致');
  }
  if (
    modeCapabilities?.reference
    && !operations.has('image-to-video')
    && !operations.has('video-to-video')
    && capability.supportsStandaloneAudio !== true
  ) {
    throw new Error('inputModeCapabilities.reference 与参考素材能力不一致');
  }
  if (modeCapabilities?.mixed && capability.allowFrameAndReferenceMix === false) {
    throw new Error('inputModeCapabilities.mixed 与 allowFrameAndReferenceMix:false 互斥');
  }

  if (operations.has('text-to-video')) {
    assertDeclarativeVideoDryRun(
      protocol,
      baseUrl,
      modelId,
      '纯文本形态',
      'text-to-video',
      'text',
      [],
    );
  }

  if (operations.has('image-to-video') && (usesKeyframe || !usesReferenceImage)) {
    const keyframes = createDryRunReferences(
      'keyframe',
      dryRunReferenceCount(capability.maxImageReferences),
    );
    assertDeclarativeVideoDryRun(
      protocol,
      baseUrl,
      modelId,
      '关键帧形态',
      'image-to-video',
      'keyframe',
      keyframes,
      (variables) => addDryRunImages(variables, keyframes, 'keyframe'),
    );
  }

  const referenceImages = usesReferenceImage
    || (usesGeneric && (capability.maxImageReferences ?? 0) > 0
      && !operations.has('image-to-video'))
    ? createDryRunReferences('reference_image', dryRunReferenceCount(capability.maxImageReferences))
    : [];
  const referenceVideos = operations.has('video-to-video') || usesVideo
    ? createDryRunReferences('reference_video', dryRunReferenceCount(capability.maxVideoReferences))
    : [];
  const referenceAudios = usesAudio
    || capability.supportsStandaloneAudio === true
    || (capability.maxAudioReferences ?? 0) > 0
    ? createDryRunReferences('reference_audio', dryRunReferenceCount(capability.maxAudioReferences))
    : [];
  const referenceMaterials = [...referenceImages, ...referenceVideos, ...referenceAudios];
  if (referenceMaterials.length > 0) {
    const operation: VideoGenerationOperation = referenceVideos.length > 0
      ? 'video-to-video'
      : referenceImages.length > 0 ? 'image-to-video' : 'text-to-video';
    assertDeclarativeVideoDryRun(
      protocol,
      baseUrl,
      modelId,
      '参考素材形态',
      operation,
      'reference',
      referenceMaterials,
      (variables) => {
        if (referenceImages.length > 0) addDryRunImages(variables, referenceImages, 'reference');
        if (referenceVideos.length > 0) addDryRunVideos(variables, referenceVideos);
        if (referenceAudios.length > 0) addDryRunAudios(variables, referenceAudios);
      },
    );
  }
}

function hasOwnExampleField(examples: ProviderConfigModelExamples): boolean {
  return ['submitRequest', 'submitResponse', 'pollRequest', 'pollResponse']
    .some((key) => Object.hasOwn(examples, key));
}

interface ResolvedDraftModelProtocol {
  baseUrl: string;
  modelId: string;
  category: GeneralModelCategory;
  protocol: NormalizedModelExecutionProtocol;
  imageReferenceRequestMode?: ImageReferenceRequestMode;
}

function resolveDraftModelProtocol(
  examples: ProviderConfigModelExamples,
  declaredBaseUrl?: string,
): ResolvedDraftModelProtocol {
  const protocolSource = examples.protocolSource ?? 'examples';
  if (protocolSource !== 'examples' && protocolSource !== 'declarative') {
    throw new Error('protocolSource 只支持 examples 或 declarative');
  }

  if (protocolSource === 'declarative') {
    if (hasOwnExampleField(examples)) {
      throw new Error('declarative 模式不得同时提供请求或响应示例字段');
    }
    if (!declaredBaseUrl) throw new Error('declarative 模式必须显式提供 connection baseUrl');
    const modelId = examples.modelId?.trim();
    if (!modelId) throw new Error('declarative 模式必须显式提供 modelId');
    if (!examples.category) throw new Error('declarative 模式必须显式提供 category');
    if (!Object.hasOwn(examples, 'executionProtocol') || !isRecord(examples.executionProtocol)) {
      throw new Error('declarative 模式必须提供 executionProtocol JSON 对象');
    }
    assertSafeDeclarativeProtocol(examples.executionProtocol);
    assertDeclarativeProtocolCategoryVariables(examples.executionProtocol, examples.category);
    const protocolErrors = validateModelExecutionProtocol(examples.executionProtocol);
    if (protocolErrors.length > 0) {
      throw new Error(`模型“${examples.name?.trim() || modelId}”协议校验失败：${protocolErrors[0]}`);
    }
    return {
      baseUrl: declaredBaseUrl,
      modelId,
      category: examples.category,
      protocol: parseModelExecutionProtocol(examples.executionProtocol),
      imageReferenceRequestMode: examples.imageReferenceRequestMode,
    };
  }

  if (Object.hasOwn(examples, 'executionProtocol')) {
    throw new Error('examples 模式不得提供 executionProtocol；请改用 protocolSource: declarative');
  }
  if (typeof examples.submitRequest !== 'string' || !examples.submitRequest.trim()) {
    throw new Error('examples 模式必须提供 submitRequest');
  }
  if (typeof examples.submitResponse !== 'string' || !examples.submitResponse.trim()) {
    throw new Error('examples 模式必须提供 submitResponse');
  }
  const sourceExamples: ModelProtocolExamples = {
    submitRequest: examples.submitRequest,
    submitResponse: examples.submitResponse,
    ...(examples.pollRequest !== undefined ? { pollRequest: examples.pollRequest } : {}),
    ...(examples.pollResponse !== undefined ? { pollResponse: examples.pollResponse } : {}),
  };
  const explicitModelId = examples.modelId?.trim()
    || (examples.name && !/\s/.test(examples.name.trim()) ? examples.name.trim() : undefined);
  const result = analyzeModelProtocolExamples(sourceExamples, {
    category: examples.category,
    modelId: explicitModelId,
    baseUrl: declaredBaseUrl,
  });
  const displayName = examples.name?.trim() || explicitModelId || result.modelId;
  const diagnostic = result.warnings[0] ? `：${result.warnings[0]}` : '';
  if (!result.baseUrl) {
    throw new Error(`模型“${displayName || '未命名模型'}”未识别到 Base URL${diagnostic}`);
  }
  if (!result.modelId) throw new Error(`模型“${displayName || '未命名模型'}”未识别到模型 ID`);
  if (!result.protocol) {
    throw new Error(`模型“${displayName || result.modelId}”无法生成有效调用协议${diagnostic}`);
  }
  const protocolErrors = validateModelExecutionProtocol(result.protocol);
  if (protocolErrors.length > 0) {
    throw new Error(`模型“${displayName || result.modelId}”协议校验失败：${protocolErrors[0]}`);
  }
  return {
    baseUrl: result.baseUrl,
    modelId: result.modelId,
    category: result.category ?? examples.category ?? 'text',
    protocol: parseModelExecutionProtocol(result.protocol),
    imageReferenceRequestMode: result.imageReferenceRequestMode,
  };
}

function createOpaqueId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`;
}

function normalizeConnectionId(value?: string): string {
  const candidate = value?.trim();
  if (!candidate) return createOpaqueId('custom');
  if (!/^custom-[a-zA-Z0-9_-]{1,56}$/.test(candidate)) {
    throw new Error('Agent 只能新建或更新 custom-* 自定义接口连接');
  }
  return candidate;
}

/**
 * Agent 侧的 Base URL 规范化：先走和设置页同一套清理（补协议、去尾斜杠、
 * 剥掉助手常从文档里照抄的 /chat/completions 之类端点后缀），再做这里独有的
 * 安全校验——助手的输入来自它读到的网页，比用户手输的更不可信，
 * 所以 HTTPS、默认端口、非文档站这几条限制一条都不放宽。
 */
function normalizeBaseUrl(value: string, chatApiProtocol: ChatApiProtocol): string {
  const url = new URL(normalizeUrlInput(value, chatApiProtocol) || value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('厂商 Base URL 必须是无凭据的 HTTPS 地址');
  }
  if (url.port && url.port !== '443') {
    throw new Error('厂商 Base URL 只允许使用 HTTPS 默认端口');
  }
  const firstHostLabel = url.hostname.toLowerCase().split('.')[0];
  if (DOCUMENTATION_HOST_LABELS.has(firstHostLabel)) {
    throw new Error('厂商 Base URL 不能使用文档站地址，请提供实际 API 网关地址');
  }
  return url.toString().replace(/\/$/, '');
}

function pruneExpiredDrafts(now: number): void {
  for (const [draftId, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(draftId);
  }
  while (drafts.size >= MAX_PROVIDER_CONFIG_DRAFTS) {
    const oldestDraftId = drafts.keys().next().value as string | undefined;
    if (!oldestDraftId) break;
    drafts.delete(oldestDraftId);
  }
}

function createModelSelection(
  connectionId: string,
  examples: ProviderConfigModelExamples,
  declaredBaseUrl?: string,
  chatApiProtocol: ChatApiProtocol = 'openai-compatible',
): { selection: ProviderModelSelection; baseUrl: string; updateFields: Array<keyof ProviderModelSelection> } {
  const result = resolveDraftModelProtocol(examples, declaredBaseUrl);
  const displayName = examples.name?.trim() || result.modelId;
  const category = result.category;
  // 文本模型由连接级标准聊天协议统一处理。仍先解析文档示例以验证模型 ID、
  // Base URL 和文档证据，但不把一次性 OpenAI 风格模板写进模型配置。
  const executionProfile: ModelExecutionProfile | undefined = category === 'text'
    ? undefined
    : {
        preset: 'custom',
        protocol: result.protocol,
      };
  const imageReferenceRequestMode = examples.imageReferenceRequestMode
    ?? result.imageReferenceRequestMode;
  if (imageReferenceRequestMode && category !== 'image') {
    throw new Error(`模型“${displayName || result.modelId}”只有图片分类可以配置参考图请求协议`);
  }
  // 能力声明只对视频模型生效：参数面板据此约束时长 / 比例 / 分辨率 / 参考素材数量
  if (examples.videoCapability && category !== 'video') {
    throw new Error(`模型“${displayName || result.modelId}”只有视频分类可以声明 videoCapability`);
  }
  if (category === 'video' && !examples.videoCapability?.operations?.length) {
    throw new Error(
      `模型“${displayName || result.modelId}”必须按接口文档声明非空 videoCapability.operations，`
      + '避免运行时猜测文生视频、图生视频或视频生视频能力',
    );
  }
  if (examples.videoCapability) {
    try {
      assertVideoModelCapability(examples.videoCapability);
    } catch (error) {
      const message = error instanceof Error ? error.message : '能力声明无效';
      throw new Error(
        `模型“${displayName || result.modelId}”的 videoCapability 无效：${message}`,
        { cause: error },
      );
    }
  }
  if (
    examples.protocolSource === 'declarative'
    && category === 'video'
    && examples.videoCapability
  ) {
    assertDeclarativeVideoProtocolSemantics(
      result.protocol,
      examples.videoCapability,
      result.baseUrl,
      result.modelId,
    );
  }
  const description = examples.description?.trim().slice(0, 500);
  const inputModalities = examples.inputModalities?.length
    ? [...new Set(['text' as const, ...examples.inputModalities])]
    : undefined;
  if (inputModalities && category !== 'text') {
    throw new Error(`模型“${displayName || result.modelId}”只有文本分类可以声明 inputModalities`);
  }
  const contextWindow = Number.isFinite(examples.contextWindow) && (examples.contextWindow ?? 0) > 0
    ? Math.floor(examples.contextWindow as number)
    : undefined;
  if (contextWindow && category !== 'text') {
    throw new Error(`模型“${displayName || result.modelId}”只有文本分类可以声明 contextWindow`);
  }
  const updateFields: Array<keyof ProviderModelSelection> = ['provider', 'executionProfile'];
  if (examples.name?.trim()) updateFields.push('name');
  if (examples.category) updateFields.push('category', 'categoryManual');
  if (examples.description !== undefined) updateFields.push('description', 'descriptionManual');
  if (inputModalities) updateFields.push('inputModalities', 'inputModalitiesManual');
  if (contextWindow) updateFields.push('contextWindow');
  if (examples.imageReferenceRequestMode) updateFields.push('imageReferenceRequestMode');
  if (examples.videoCapability) updateFields.push('videoCapability');
  return {
    baseUrl: normalizeBaseUrl(result.baseUrl, chatApiProtocol),
    updateFields,
    selection: {
      id: result.modelId,
      name: displayName || result.modelId,
      category,
      provider: connectionId,
      executionProfile,
      // 助手按文档定下的分类比拉取目录时的 ID 正则更准，标成手动避免下次刷新被改回去
      ...(examples.category ? { categoryManual: true } : {}),
      ...(description !== undefined ? { description, descriptionManual: true } : {}),
      ...(inputModalities ? { inputModalities, inputModalitiesManual: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(imageReferenceRequestMode ? { imageReferenceRequestMode } : {}),
      ...(examples.videoCapability ? { videoCapability: examples.videoCapability } : {}),
    },
  };
}

export interface ProviderModelMergeResult {
  /** 合并后的模型列表：同 ID 仅更新明确提供字段，新模型追加在后。 */
  merged: ProviderModelSelection[];
  /** 草稿中原本不存在的模型 ID。 */
  addedIds: string[];
  /** 草稿明确提供的字段产生变化的模型 ID。 */
  updatedIds: string[];
  /** 同 ID 且配置逐字段相同、原样跳过的模型 ID。 */
  unchangedIds: string[];
  /** 本次未涉及、原样保留的模型 ID。 */
  keptIds: string[];
  /** 仅包含字段名，不包含协议正文、配置值或凭据。 */
  fieldChanges: Array<{ id: string; updated: string[]; preserved: string[] }>;
}

/** 键序无关的稳定序列化，用于判断草稿模型与已有模型是否逐字段相同。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function targetSnapshot(provider: ApiProviderConfig | undefined): string {
  // 显式白名单：apiKey、apiKeyRef 和目录刷新时间不进入基线。
  return stableStringify(provider ? {
    name: provider.name,
    baseUrl: provider.baseUrl,
    chatApiProtocol: resolveChatApiProtocol(provider.chatApiProtocol),
    catalogId: provider.catalogId,
    selectedModels: provider.selectedModels,
    catalogModels: provider.catalogModels,
    visibleModelCategories: provider.visibleModelCategories,
  } : null);
}

/** 仅供受信预览/写入代码登记本次已确定的目标，不接收模型输入的基线。 */
export function bindProviderConfigDraftTarget(
  draft: ProviderConfigDraft,
  connectionId: string,
  provider: ApiProviderConfig | undefined,
): void {
  draftTargets.set(draft, { connectionId, snapshot: targetSnapshot(provider) });
}

export function assertProviderConfigDraftTarget(
  draft: ProviderConfigDraft,
  connectionId: string,
  provider: ApiProviderConfig | undefined,
): void {
  const target = draftTargets.get(draft);
  if (!target || target.connectionId !== connectionId || target.snapshot !== targetSnapshot(provider)) {
    throw new Error('目标连接或模型配置在预览后已变化，草稿已保留，请重新预览后再保存');
  }
}

/**
 * 把草稿模型并入已有连接，而不是整体替换。
 *
 * 用户说「给这个连接再加一个模型」时，草稿里只有那一个模型；直接替换会静默
 * 删掉该连接下其余模型和它们在 generalModels 中的关联项。
 * 同 ID 且配置完全相同的模型原样跳过，避免助手重复对接时把审批卡刷成一堆「更新」。
 */
export function mergeProviderModels(
  existingModels: ProviderModelSelection[] | undefined,
  draftModels: ProviderModelSelection[],
  fieldsById?: ProviderConfigDraft['modelUpdateFields'],
): ProviderModelMergeResult {
  const existing = existingModels ?? [];
  const draftById = new Map(draftModels.map((model) => [model.id, model]));
  const existingById = new Map(existing.map((model) => [model.id, model]));

  const updatedIds: string[] = [];
  const unchangedIds: string[] = [];
  const fieldChanges: ProviderModelMergeResult['fieldChanges'] = [];
  const merged = existing.map((model) => {
    const draft = draftById.get(model.id);
    if (!draft) return model;
    const fields = fieldsById && Object.hasOwn(fieldsById, model.id) ? fieldsById[model.id] : undefined;
    if (fields && !fields.includes('category') && draft.category !== model.category) {
      throw new Error(`模型“${model.id}”的推断分类与现有分类不同，请明确 category 后重新预览`);
    }
    const entries = Object.entries(draft).filter(([key, value]) => {
      const field = key as keyof ProviderModelSelection;
      return key !== 'id'
        && (!fields || fields.includes(field))
        && (value !== undefined || Boolean(fields?.includes(field)));
    });
    const patch = Object.fromEntries(entries) as Partial<ProviderModelSelection>;
    const updated = entries
      .filter(([key, value]) => stableStringify(model[key as keyof ProviderModelSelection]) !== stableStringify(value))
      .map(([key]) => key);
    fieldChanges.push({
      id: model.id,
      updated,
      preserved: Object.keys(model).filter((key) => key !== 'id' && !Object.hasOwn(patch, key)),
    });
    if (updated.length === 0) {
      unchangedIds.push(model.id);
      return model;
    }
    updatedIds.push(model.id);
    return { ...model, ...patch };
  });
  const addedIds: string[] = [];
  for (const model of draftModels) {
    if (existingById.has(model.id)) continue;
    merged.push(model);
    addedIds.push(model.id);
  }

  return {
    merged,
    addedIds,
    updatedIds,
    unchangedIds,
    keptIds: existing.filter((model) => !draftById.has(model.id)).map((model) => model.id),
    fieldChanges,
  };
}

export function describeProviderModelFields(result: ProviderModelMergeResult): string {
  return result.fieldChanges.map(({ id, updated, preserved }) => (
    `字段变更 ${id}：更新 ${updated.join('、') || '无'}；保留未指定字段 ${preserved.join('、') || '无'}`
  )).join('\n');
}

/** 合并结果的中文说明，用于审批卡与回传模型的观察结果。 */
export function describeProviderModelMerge(result: ProviderModelMergeResult): string {
  const parts = [
    result.addedIds.length > 0 ? `新增 ${result.addedIds.length} 个模型` : '',
    result.updatedIds.length > 0 ? `更新 ${result.updatedIds.length} 个同 ID 模型` : '',
    result.unchangedIds.length > 0
      ? `跳过 ${result.unchangedIds.length} 个已存在且配置相同的模型（${result.unchangedIds.join('、')}）`
      : '',
    result.keptIds.length > 0 ? `保留原有 ${result.keptIds.length} 个模型` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : '模型列表无变化';
}

/**
 * 图片 / 视频模型的协议里一个参考素材字段都没有时给出提示。
 * 中转站文档常常只给纯文生图 / 文生视频示例，照抄出来的配置在画布上连了参考图
 * 也发不出去；这个信息要出现在审批卡和回传给模型的摘要里，而不是等生成时才发现。
 */
function describeReferenceGap(model: ProviderModelSelection): string {
  const { category } = model;
  if (category !== 'image' && category !== 'video') return '';
  // 图片模型显式声明了参考图请求协议时走标准通道，不看模板
  if (model.imageReferenceRequestMode) return '';
  const protocol = resolveModelExecutionProfile(model.executionProfile);
  if (!protocol) return '';
  const supported = getCategoryProtocolVariables(category);
  const variables = REFERENCE_PROTOCOL_VARIABLES.filter((name) => supported.includes(name));
  return modelProtocolUsesVariable(JSON.stringify(protocol), ...variables)
    ? ''
    : '，无参考素材字段';
}

export function summarizeProviderConfigDraft(draft: ProviderConfigDraft): string {
  const models = draft.config.selectedModels ?? [];
  const referenceModeLabels: Record<ImageReferenceRequestMode, string> = {
    'generation-json-image-urls': '公网 URL 数组',
    'generation-json-image-data-urls': 'data URL 数组',
    'edits-multipart': 'Multipart 图片文件',
  };
  return [
    `连接：${draft.connectionName}`,
    `地址：${draft.baseUrl}`,
    `聊天协议：${CHAT_API_PROTOCOL_LABELS[resolveChatApiProtocol(draft.config.chatApiProtocol)]}`,
    `模型：${models.map((model) => (
      `${model.name}（${GENERAL_MODEL_CATEGORY_LABELS[model.category]}${model.inputModalities?.includes('image')
        ? '，可读图'
        : ''}${model.imageReferenceRequestMode
        ? `，参考图：${referenceModeLabels[model.imageReferenceRequestMode]}`
        : ''}${describeReferenceGap(model)}）`
    )).join('、')}`,
    '不会写入 API Key：新连接保持空白，已有连接保留原值',
  ].join('\n');
}

export function createProviderConfigDraft(
  taskId: string,
  input: ProviderConfigDraftInput,
  now = Date.now(),
  accessScope?: ProviderConfigDraftAccessScope,
): ProviderConfigDraft {
  if (containsCredentialField(input)) {
    throw new Error('配置草稿不得包含 API Key 或其他凭据字段');
  }
  const normalizedTaskId = taskId.trim();
  const connectionName = input.connectionName?.trim();
  if (!normalizedTaskId) throw new Error('Agent 任务 ID 不能为空');
  if (!connectionName) throw new Error('厂商连接名称不能为空');
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error('至少需要一个模型的请求和响应示例');
  }

  const connectionId = normalizeConnectionId(input.connectionId);
  const chatApiProtocol = resolveChatApiProtocol(input.chatApiProtocol);
  const declaredBaseUrl = input.baseUrl?.trim()
    ? normalizeBaseUrl(input.baseUrl, chatApiProtocol)
    : undefined;
  const analyzed = input.models.map((examples) => (
    createModelSelection(connectionId, examples, declaredBaseUrl, chatApiProtocol)
  ));
  const baseUrl = analyzed[0].baseUrl;
  if (analyzed.some((item) => item.baseUrl !== baseUrl)) {
    throw new Error('同一个厂商配置中的模型必须使用同一个 Base URL');
  }
  const modelIds = new Set<string>();
  for (const { selection } of analyzed) {
    if (modelIds.has(selection.id)) throw new Error(`模型 ID 重复：${selection.id}`);
    modelIds.add(selection.id);
  }
  const selectedModels = analyzed.map((item) => item.selection);
  const visibleModelCategories = [...new Set(selectedModels.map((model) => model.category))];
  const draftId = createOpaqueId('provider-draft');
  const draft: ProviderConfigDraft = {
    id: draftId,
    taskId: normalizedTaskId,
    ...(accessScope ? {
      projectId: accessScope.projectId,
      conversationId: accessScope.conversationId,
    } : {}),
    connectionId,
    connectionName,
    baseUrl,
    modelUpdateFields: Object.fromEntries(analyzed.map(({ selection, updateFields }) => [selection.id, updateFields])),
    config: {
      name: connectionName,
      baseUrl,
      chatApiProtocol,
      catalogId: 'custom-openai',
      selectedModels,
      catalogModels: selectedModels.map((model) => ({ ...model })),
      visibleModelCategories,
      catalogUpdatedAt: now,
    },
    summary: '',
    createdAt: now,
    expiresAt: now + PROVIDER_CONFIG_DRAFT_TTL_MS,
  };
  draft.summary = summarizeProviderConfigDraft(draft);
  pruneExpiredDrafts(now);
  drafts.set(draft.id, draft);
  return draft;
}

function isSameMcpControlScope(
  draft: ProviderConfigDraft,
  accessScope?: ProviderConfigDraftAccessScope,
): boolean {
  if (!accessScope || !draft.projectId || !draft.conversationId) return false;
  const expectedConversationId = `mcp-control-${accessScope.projectId}`;
  return draft.projectId === accessScope.projectId
    && draft.conversationId === expectedConversationId
    && accessScope.conversationId === expectedConversationId;
}

export function getProviderConfigDraft(
  taskId: string,
  draftId: string,
  now = Date.now(),
  accessScope?: ProviderConfigDraftAccessScope,
): ProviderConfigDraft {
  const draft = drafts.get(draftId);
  if (!draft) throw new Error('厂商配置草稿不存在或已失效');
  if (draft.taskId !== taskId && !isSameMcpControlScope(draft, accessScope)) {
    throw new Error('厂商配置草稿不属于当前 Agent 任务');
  }
  if (draft.expiresAt <= now) {
    drafts.delete(draftId);
    throw new Error('厂商配置草稿已过期，请重新分析文档');
  }
  return draft;
}

export function deleteProviderConfigDraft(
  taskId: string,
  draftId: string,
  accessScope?: ProviderConfigDraftAccessScope,
): void {
  const draft = getProviderConfigDraft(taskId, draftId, Date.now(), accessScope);
  if (drafts.get(draftId) === draft) drafts.delete(draftId);
}

/**
 * 按 draftId 直查草稿，不做任务归属校验。
 * 仅供只读的摘要展示使用；写入路径必须走带 taskId 校验的 getProviderConfigDraft。
 */
export function peekProviderConfigDraft(draftId: string): ProviderConfigDraft | undefined {
  const draft = drafts.get(draftId);
  if (!draft || draft.expiresAt <= Date.now()) return undefined;
  return draft;
}

export function clearProviderConfigDraftsForTests(): void {
  drafts.clear();
}
