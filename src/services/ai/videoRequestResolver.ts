/**
 * Provider-neutral video request resolution.
 *
 * This module deliberately stops before transport compilation: it resolves the
 * user's intent, applies model capability defaults, and rejects unsupported
 * combinations. Provider adapters may consume the canonical result, but HTTP
 * field names and endpoint-specific value transforms do not belong here.
 */
import type {
  AIVideoGenParams,
  MediaReference,
  VideoGenerationInputMode,
  VideoGenerationOperation,
  VideoModelCapability,
} from '../../types/aiTypes';
import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  DEFAULT_VIDEO_FPS,
  resolveVideoDurationSeconds,
  videoFramesFromDuration,
} from '../aiDimensions';

const LEGACY_VIDEO_RESOLUTION = 832;
const LEGACY_VIDEO_RESOLUTION_PRESET = '720p';
const LEGACY_VIDEO_ASPECT_RATIO = '16:9';

export type VideoSubmissionControlParams = Pick<
  AIVideoGenParams,
  | 'videoResolution'
  | 'videoFps'
  | 'videoFrames'
  | 'seedanceResolution'
  | 'seedanceRatio'
  | 'seedanceDuration'
>;

export interface ResolveVideoSubmissionControlOptions extends VideoSubmissionControlParams {
  provider: string;
  workflowId?: string;
}

/**
 * Preserve unknown fields for direct custom protocols. Built-in providers and
 * workflows keep their legacy defaults until their adapters migrate to the
 * canonical request contract.
 */
export function resolveVideoSubmissionControls(
  options: ResolveVideoSubmissionControlOptions,
): VideoSubmissionControlParams {
  const directGeneralProtocol = options.provider === 'general' && !options.workflowId;
  if (directGeneralProtocol) {
    return {
      videoResolution: options.videoResolution,
      videoFps: options.videoFps,
      // API 视频统一以 duration 为用户语义；有 duration 时不再同时提交可能陈旧的 legacy frameCount。
      videoFrames: options.seedanceDuration === undefined ? options.videoFrames : undefined,
      seedanceResolution: options.seedanceResolution,
      seedanceRatio: options.seedanceRatio,
      seedanceDuration: options.seedanceDuration,
    };
  }

  const videoFps = options.videoFps || DEFAULT_VIDEO_FPS;
  const seedanceDuration = resolveVideoDurationSeconds(
    options.seedanceDuration,
    options.videoFrames,
    videoFps,
  );
  return {
    videoResolution: options.videoResolution || LEGACY_VIDEO_RESOLUTION,
    videoFps,
    videoFrames: videoFramesFromDuration(seedanceDuration, videoFps),
    seedanceResolution: options.seedanceResolution || LEGACY_VIDEO_RESOLUTION_PRESET,
    seedanceRatio: options.seedanceRatio || LEGACY_VIDEO_ASPECT_RATIO,
    seedanceDuration,
  };
}

export type CanonicalVideoAudioPolicy = 'generate' | 'mute' | 'model-default';

export type CanonicalVideoValueSource =
  | 'request'
  | 'capability-default'
  | 'derived'
  | 'compatibility-default'
  | 'unspecified';

export interface CanonicalVideoPixelDimensions {
  width: number;
  height: number;
}

export interface CanonicalVideoReferenceSet {
  all: MediaReference[];
  images: MediaReference[];
  videos: MediaReference[];
  audios: MediaReference[];
  counts: {
    image: number;
    video: number;
    audio: number;
    total: number;
  };
}

export interface CanonicalVideoRequest {
  /** Provider-independent model identifier selected by the caller. */
  modelId: string;
  prompt: string;
  operation: VideoGenerationOperation;
  /** Input-role shape, independent from provider-specific mode field names. */
  inputMode: VideoGenerationInputMode;
  references: CanonicalVideoReferenceSet;
  output: {
    /** Ratio intent, independent from exact pixel dimensions. */
    aspectRatio: string | null;
    /** Model-declared quality/resolution tier such as 720p or 2K. */
    resolutionPreset: string | null;
    /** Exact pixels only when they can be resolved without a provider rule. */
    pixelDimensions: CanonicalVideoPixelDimensions | null;
    durationSeconds: number;
    requestedFrameRate: number;
    /** Exact requested frame count; null means the caller requested duration, not frames. */
    frameCount: number | null;
    /** The legacy request has no video batch field, so the canonical count is currently one. */
    candidateCount: 1;
    audio: {
      policy: CanonicalVideoAudioPolicy;
      referenceCount: number;
    };
  };
  /** Makes defaulting and compatibility decisions inspectable by callers and tests. */
  sources: {
    aspectRatio: CanonicalVideoValueSource;
    resolutionPreset: CanonicalVideoValueSource;
    pixelDimensions: CanonicalVideoValueSource;
    durationSeconds: CanonicalVideoValueSource;
    requestedFrameRate: CanonicalVideoValueSource;
    frameCount: CanonicalVideoValueSource;
    audioPolicy: CanonicalVideoValueSource;
  };
}

export interface ResolveCanonicalVideoRequestOptions {
  /**
   * Fully collected references. When supplied, this list is authoritative;
   * otherwise params.referenceMedia is used as the compatibility input.
   */
  references?: readonly MediaReference[];
  capability?: VideoModelCapability;
}

export type VideoRequestResolutionErrorCode =
  | 'INVALID_PARAMETER'
  | 'INVALID_CAPABILITY'
  | 'UNSUPPORTED_OPERATION'
  | 'REQUIRED_REFERENCE'
  | 'REFERENCE_LIMIT_EXCEEDED'
  | 'REFERENCE_COMBINATION_UNSUPPORTED'
  | 'STANDALONE_AUDIO_UNSUPPORTED'
  | 'AUDIO_GENERATION_UNSUPPORTED'
  | 'UNSUPPORTED_ASPECT_RATIO'
  | 'UNSUPPORTED_RESOLUTION'
  | 'UNSUPPORTED_FRAME_RATE'
  | 'UNSUPPORTED_DURATION'
  | 'DURATION_OUT_OF_RANGE';

export class VideoRequestResolutionError extends Error {
  readonly code: VideoRequestResolutionErrorCode;
  readonly field?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: VideoRequestResolutionErrorCode,
    message: string,
    options: { field?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'VideoRequestResolutionError';
    this.code = code;
    this.field = options.field;
    this.details = options.details;
  }
}

/**
 * Compatibility values for the current generation runtime. These remain
 * semantic values rather than a provider request body.
 */
export interface ResolvedVideoCompatibilityValues {
  prompt: string;
  operation: VideoGenerationOperation;
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
  firstImageUrl?: string;
  lastImageUrl?: string;
  aspectRatio?: string;
  resolutionPreset?: string;
  width?: number;
  height?: number;
  durationSeconds: number;
  requestedFrameRate: number;
  /** Existing local workflows use an inclusive first-frame count (duration * fps + 1). */
  frameCount: number;
  generateAudio?: boolean;
  candidateCount: 1;
}

interface ResolvedValue<T> {
  value: T;
  source: CanonicalVideoValueSource;
}

const VIDEO_OPERATIONS = new Set<VideoGenerationOperation>([
  'text-to-video',
  'image-to-video',
  'video-to-video',
]);
const VIDEO_INPUT_MODES = new Set<VideoGenerationInputMode>([
  'text',
  'keyframe',
  'reference',
  'mixed',
]);

function fail(
  code: VideoRequestResolutionErrorCode,
  message: string,
  field?: string,
  details?: Record<string, unknown>,
): never {
  throw new VideoRequestResolutionError(code, message, { field, details });
}

function assertPositiveFinite(value: number, field: string, subject = '参数'): void {
  if (!Number.isFinite(value) || value <= 0) {
    fail('INVALID_PARAMETER', `${subject} ${field} 必须是大于 0 的有限数值`, field, { value });
  }
}

export function assertVideoModelCapability(capability: VideoModelCapability | undefined): void {
  if (!capability) return;

  if (capability.operations) {
    if (capability.operations.length === 0
      || capability.operations.some((operation) => !VIDEO_OPERATIONS.has(operation))) {
      fail('INVALID_CAPABILITY', '模型能力 operations 包含无效视频操作', 'operations', {
        values: capability.operations,
      });
    }
    if (new Set(capability.operations).size !== capability.operations.length) {
      fail('INVALID_CAPABILITY', '模型能力 operations 不能重复', 'operations', {
        values: capability.operations,
      });
    }
  }

  const stringLists: Array<[string, readonly string[] | undefined]> = [
    ['resolutions', capability.resolutions],
    ['ratios', capability.ratios],
  ];
  for (const [field, values] of stringLists) {
    if (!values) continue;
    if (values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      fail('INVALID_CAPABILITY', `模型能力 ${field} 含有空值`, field, { values });
    }
  }
  const stringDefaults: Array<[string, string | undefined]> = [
    ['defaultResolution', capability.defaultResolution],
    ['defaultRatio', capability.defaultRatio],
  ];
  for (const [field, value] of stringDefaults) {
    if (value !== undefined && value.trim().length === 0) {
      fail('INVALID_CAPABILITY', `模型能力 ${field} 不能为空`, field, { value });
    }
  }

  const numberLists: Array<[string, readonly number[] | undefined]> = [
    ['frameRates', capability.frameRates],
    ['durations', capability.durations],
  ];
  for (const [field, values] of numberLists) {
    if (!values) continue;
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
      fail('INVALID_CAPABILITY', `模型能力 ${field} 必须全部为大于 0 的有限数值`, field, { values });
    }
  }
  if (
    capability.defaultFrameRate !== undefined
    && (!Number.isFinite(capability.defaultFrameRate) || capability.defaultFrameRate <= 0)
  ) {
    fail(
      'INVALID_CAPABILITY',
      '模型能力 defaultFrameRate 必须是大于 0 的有限数值',
      'defaultFrameRate',
      { value: capability.defaultFrameRate },
    );
  }

  const durationBounds: Array<[string, number | undefined]> = [
    ['minDuration', capability.minDuration],
    ['maxDuration', capability.maxDuration],
    ['defaultDuration', capability.defaultDuration],
  ];
  for (const [field, value] of durationBounds) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      fail('INVALID_CAPABILITY', `模型能力 ${field} 必须是大于 0 的有限数值`, field, { value });
    }
  }
  if (
    capability.minDuration !== undefined
    && capability.maxDuration !== undefined
    && capability.minDuration > capability.maxDuration
  ) {
    fail('INVALID_CAPABILITY', '模型能力的 minDuration 不能大于 maxDuration', 'minDuration', {
      minDuration: capability.minDuration,
      maxDuration: capability.maxDuration,
    });
  }
  if (capability.durations?.some((duration) => (
    (capability.minDuration !== undefined && duration < capability.minDuration)
    || (capability.maxDuration !== undefined && duration > capability.maxDuration)
  ))) {
    fail(
      'INVALID_CAPABILITY',
      '模型能力 durations 含有超出 minDuration/maxDuration 的值',
      'durations',
      {
        durations: capability.durations,
        minDuration: capability.minDuration,
        maxDuration: capability.maxDuration,
      },
    );
  }

  const referenceLimits: Array<[string, number | undefined]> = [
    ['maxImageReferences', capability.maxImageReferences],
    ['maxVideoReferences', capability.maxVideoReferences],
    ['maxAudioReferences', capability.maxAudioReferences],
  ];
  for (const [field, value] of referenceLimits) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      fail('INVALID_CAPABILITY', `模型能力 ${field} 必须是非负整数`, field, { value });
    }
  }

  if (capability.requiresReference && capability.operations?.includes('text-to-video')) {
    fail(
      'INVALID_CAPABILITY',
      '模型要求参考素材时，operations 不能同时声明 text-to-video',
      'operations',
    );
  }
  if (capability.supportsStandaloneAudio && capability.maxAudioReferences === 0) {
    fail(
      'INVALID_CAPABILITY',
      '模型声明支持纯音频参考，但 maxAudioReferences 为 0',
      'maxAudioReferences',
    );
  }

  assertCapabilityDefault(
    'defaultResolution',
    capability.defaultResolution,
    capability.resolutions,
  );
  assertCapabilityDefault('defaultRatio', capability.defaultRatio, capability.ratios);
  assertCapabilityDefault('defaultFrameRate', capability.defaultFrameRate, capability.frameRates);

  for (const [mode, rawModeCapability] of Object.entries(capability.inputModeCapabilities ?? {})) {
    if (!VIDEO_INPUT_MODES.has(mode as VideoGenerationInputMode)) {
      fail('INVALID_CAPABILITY', `模型能力 inputModeCapabilities 包含无效输入模式 ${mode}`, 'inputModeCapabilities');
    }
    if (!rawModeCapability || typeof rawModeCapability !== 'object' || Array.isArray(rawModeCapability)) {
      fail('INVALID_CAPABILITY', `模型能力 inputModeCapabilities.${mode} 必须是对象`, `inputModeCapabilities.${mode}`);
    }
    const modeCapability = rawModeCapability;
    if (modeCapability.ratios) {
      if (modeCapability.ratios.length === 0 || modeCapability.ratios.some((ratio) => (
        typeof ratio !== 'string' || ratio.trim().length === 0
      ))) {
        fail(
          'INVALID_CAPABILITY',
          `模型能力 inputModeCapabilities.${mode}.ratios 必须是非空字符串数组`,
          `inputModeCapabilities.${mode}.ratios`,
        );
      }
      if (capability.ratios?.length && modeCapability.ratios.some((ratio) => !capability.ratios!.includes(ratio))) {
        fail(
          'INVALID_CAPABILITY',
          `模型能力 inputModeCapabilities.${mode}.ratios 必须是模型级 ratios 的子集`,
          `inputModeCapabilities.${mode}.ratios`,
        );
      }
    }
    if (modeCapability.defaultRatio !== undefined && !modeCapability.defaultRatio.trim()) {
      fail(
        'INVALID_CAPABILITY',
        `模型能力 inputModeCapabilities.${mode}.defaultRatio 不能为空`,
        `inputModeCapabilities.${mode}.defaultRatio`,
      );
    }
    const effectiveRatios = modeCapability.ratios ?? capability.ratios;
    const effectiveDefaultRatio = modeCapability.defaultRatio ?? capability.defaultRatio;
    assertCapabilityDefault(
      `inputModeCapabilities.${mode}.defaultRatio`,
      effectiveDefaultRatio,
      effectiveRatios,
    );
    if (modeCapability.requiresRatio !== undefined && typeof modeCapability.requiresRatio !== 'boolean') {
      fail(
        'INVALID_CAPABILITY',
        `模型能力 inputModeCapabilities.${mode}.requiresRatio 必须是布尔值`,
        `inputModeCapabilities.${mode}.requiresRatio`,
      );
    }
  }

  if (capability.defaultDuration !== undefined) {
    const defaultDuration = capability.defaultDuration;
    if (capability.durations?.length && !capability.durations.includes(defaultDuration)) {
      fail(
        'INVALID_CAPABILITY',
        '模型能力 defaultDuration 不在 durations 中',
        'defaultDuration',
        { value: defaultDuration, allowed: capability.durations },
      );
    }
    if (
      (capability.minDuration !== undefined && defaultDuration < capability.minDuration)
      || (capability.maxDuration !== undefined && defaultDuration > capability.maxDuration)
    ) {
      fail(
        'INVALID_CAPABILITY',
        '模型能力 defaultDuration 超出 minDuration/maxDuration',
        'defaultDuration',
        {
          value: defaultDuration,
          minDuration: capability.minDuration,
          maxDuration: capability.maxDuration,
        },
      );
    }
  }

  const promptMinimum = capability.inputConstraints?.promptMinCharacters;
  if (promptMinimum !== undefined && (!Number.isInteger(promptMinimum) || promptMinimum < 0)) {
    fail(
      'INVALID_CAPABILITY',
      '模型能力 promptMinCharacters 必须是非负整数',
      'promptMinCharacters',
      { value: promptMinimum },
    );
  }
  const maxBase64DecodedBytes = capability.inputConstraints?.maxBase64DecodedBytes;
  if (maxBase64DecodedBytes !== undefined
    && (!Number.isInteger(maxBase64DecodedBytes) || maxBase64DecodedBytes < 0)) {
    fail(
      'INVALID_CAPABILITY',
      '模型能力 maxBase64DecodedBytes 必须是非负整数',
      'maxBase64DecodedBytes',
      { value: maxBase64DecodedBytes },
    );
  }
  assertNumericConstraintShape(
    capability.inputConstraints?.referenceVideo?.width,
    'referenceVideo.width',
  );
  assertNumericConstraintShape(
    capability.inputConstraints?.referenceVideo?.durationSeconds,
    'referenceVideo.durationSeconds',
  );
  assertNumericConstraintShape(
    capability.inputConstraints?.referenceVideo?.totalDurationSeconds,
    'referenceVideo.totalDurationSeconds',
  );
  assertNumericConstraintShape(
    capability.inputConstraints?.referenceAudio?.durationSeconds,
    'referenceAudio.durationSeconds',
  );
  assertNumericConstraintShape(
    capability.inputConstraints?.referenceAudio?.totalDurationSeconds,
    'referenceAudio.totalDurationSeconds',
  );
}

function assertNumericConstraintShape(
  constraint: { min?: number; max?: number } | undefined,
  field: string,
): void {
  if (!constraint) return;
  if (constraint.min !== undefined && !Number.isFinite(constraint.min)) {
    fail('INVALID_CAPABILITY', `模型能力 ${field}.min 必须是有限数值`, field);
  }
  if (constraint.max !== undefined && !Number.isFinite(constraint.max)) {
    fail('INVALID_CAPABILITY', `模型能力 ${field}.max 必须是有限数值`, field);
  }
  if (constraint.min !== undefined && constraint.max !== undefined && constraint.min > constraint.max) {
    fail('INVALID_CAPABILITY', `模型能力 ${field}.min 不能大于 max`, field, {
      min: constraint.min,
      max: constraint.max,
    });
  }
}

function assertCapabilityDefault<T>(
  field: string,
  value: T | undefined,
  allowed: readonly T[] | undefined,
): void {
  if (value === undefined || !allowed?.length || allowed.includes(value)) return;
  fail('INVALID_CAPABILITY', `模型能力 ${field} 不在声明的可选值中`, field, { value, allowed });
}

function normalizeReferences(references: readonly MediaReference[]): CanonicalVideoReferenceSet {
  const all: MediaReference[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    const url = reference.url?.trim();
    if (!url) {
      fail('INVALID_PARAMETER', '参考素材 URL 不能为空', 'references', {
        kind: reference.kind,
        role: reference.role,
      });
    }
    // Preserve the same asset in different semantic roles (for example first
    // and last frame), while removing exact duplicate bindings.
    const key = `${reference.kind}:${reference.role}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ ...reference, url });
  }

  const images = all.filter((reference) => reference.kind === 'image');
  const videos = all.filter((reference) => reference.kind === 'video');
  const audios = all.filter((reference) => reference.kind === 'audio');

  return {
    all,
    images,
    videos,
    audios,
    counts: {
      image: images.length,
      video: videos.length,
      audio: audios.length,
      total: all.length,
    },
  };
}

export function resolveCanonicalVideoOperation(
  references: Pick<CanonicalVideoReferenceSet, 'images' | 'videos'>,
): VideoGenerationOperation {
  if (references.videos.length > 0) return 'video-to-video';
  if (references.images.length > 0) return 'image-to-video';
  return 'text-to-video';
}

export function resolveCanonicalVideoInputMode(
  references: Pick<CanonicalVideoReferenceSet, 'images' | 'videos' | 'audios'>,
): VideoGenerationInputMode {
  const hasKeyframe = references.images.some((reference) => (
    reference.role === 'first_frame' || reference.role === 'last_frame'
  ));
  const hasReference = references.images.some((reference) => reference.role === 'reference')
    || references.videos.length > 0
    || references.audios.length > 0;
  if (hasKeyframe && hasReference) return 'mixed';
  if (hasKeyframe) return 'keyframe';
  if (hasReference) return 'reference';
  return 'text';
}

function assertReferenceCapabilities(
  references: CanonicalVideoReferenceSet,
  capability: VideoModelCapability | undefined,
  modelId: string,
): void {
  if (!capability) return;

  if (capability.requiresReference && references.counts.total === 0) {
    fail('REQUIRED_REFERENCE', `模型 "${modelId}" 至少需要一份参考素材`, 'references');
  }

  const limits: Array<[string, number, number | undefined]> = [
    ['参考图', references.counts.image, capability.maxImageReferences],
    ['参考视频', references.counts.video, capability.maxVideoReferences],
    ['参考音频', references.counts.audio, capability.maxAudioReferences],
  ];
  for (const [label, count, maximum] of limits) {
    if (maximum === undefined || count <= maximum) continue;
    fail(
      'REFERENCE_LIMIT_EXCEEDED',
      maximum === 0
        ? `模型 "${modelId}" 不支持${label}`
        : `模型 "${modelId}" 最多支持 ${maximum} 个${label}，当前有 ${count} 个`,
      'references',
      { label, count, maximum },
    );
  }

  const hasOnlyAudio = references.counts.audio > 0
    && references.counts.image === 0
    && references.counts.video === 0;
  if (hasOnlyAudio && capability.supportsStandaloneAudio === false) {
    fail(
      'STANDALONE_AUDIO_UNSUPPORTED',
      `模型 "${modelId}" 不支持只使用参考音频生成视频`,
      'references',
    );
  }
}

function assertOperationSupported(
  operation: VideoGenerationOperation,
  capability: VideoModelCapability | undefined,
  modelId: string,
): void {
  if (!capability?.operations?.length || capability.operations.includes(operation)) return;
  fail(
    'UNSUPPORTED_OPERATION',
    `模型 "${modelId}" 不支持 ${operation} 操作`,
    'operation',
    { operation, allowed: capability.operations },
  );
}

function assertReferenceCombinationSupported(
  references: CanonicalVideoReferenceSet,
  capability: VideoModelCapability | undefined,
  modelId: string,
): void {
  if (capability?.allowFrameAndReferenceMix !== false) return;
  const hasFrameRole = references.images.some((reference) => (
    reference.role === 'first_frame' || reference.role === 'last_frame'
  ));
  const hasReferenceRole = references.videos.length > 0
    || references.audios.length > 0
    || references.images.some((reference) => reference.role === 'reference');
  if (!hasFrameRole || !hasReferenceRole) return;
  fail(
    'REFERENCE_COMBINATION_UNSUPPORTED',
    `模型 "${modelId}" 不允许首/尾帧与普通图片、视频或音频参考混用`,
    'references',
  );
}

function resolveOptionalString(
  requested: string | undefined,
  fallback: string | undefined,
): ResolvedValue<string | null> {
  if (typeof requested === 'string' && requested.trim()) {
    return { value: requested.trim(), source: 'request' };
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return { value: fallback.trim(), source: 'capability-default' };
  }
  return { value: null, source: 'unspecified' };
}

function assertAllowedString(
  value: string | null,
  allowed: readonly string[] | undefined,
  code: 'UNSUPPORTED_ASPECT_RATIO' | 'UNSUPPORTED_RESOLUTION',
  field: string,
  label: string,
): void {
  if (value === null || !allowed?.length || allowed.includes(value)) return;
  fail(code, `${label} "${value}" 不在模型支持范围内`, field, { value, allowed });
}

function resolveFrameRate(
  requested: number | undefined,
  capability: VideoModelCapability | undefined,
): ResolvedValue<number> {
  if (requested !== undefined) {
    assertPositiveFinite(requested, 'requestedFrameRate');
    return { value: requested, source: 'request' };
  }
  if (capability?.defaultFrameRate !== undefined) {
    return { value: capability.defaultFrameRate, source: 'capability-default' };
  }
  return { value: DEFAULT_VIDEO_FPS, source: 'compatibility-default' };
}

function assertFrameRateSupported(
  frameRate: number,
  capability: VideoModelCapability | undefined,
  source: CanonicalVideoValueSource,
): void {
  if (source === 'compatibility-default') return;
  if (!capability?.frameRates?.length || capability.frameRates.includes(frameRate)) return;
  fail(
    'UNSUPPORTED_FRAME_RATE',
    `帧率 ${frameRate} fps 不在模型支持范围内`,
    'requestedFrameRate',
    { value: frameRate, allowed: capability.frameRates },
  );
}

function resolveExplicitFrameCount(frameCount: number | undefined): ResolvedValue<number | null> {
  if (frameCount === undefined) return { value: null, source: 'unspecified' };
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    fail('INVALID_PARAMETER', 'frameCount 必须是大于 0 的整数', 'frameCount', { value: frameCount });
  }
  return { value: frameCount, source: 'request' };
}

function resolveDuration(
  requestedDuration: number | undefined,
  frameCount: number | null,
  frameRate: ResolvedValue<number>,
  capability: VideoModelCapability | undefined,
): ResolvedValue<number> {
  if (requestedDuration !== undefined) {
    assertPositiveFinite(requestedDuration, 'durationSeconds');
    return { value: requestedDuration, source: 'request' };
  }

  if (frameCount !== null) {
    // Compatibility with the existing local-workflow convention where the
    // first frame is inclusive. No global 2..15 second clamp is applied.
    const duration = (frameCount - 1) / frameRate.value;
    assertPositiveFinite(duration, 'durationSeconds', '由 frameCount 推导出的时长');
    return {
      value: duration,
      source: frameRate.source === 'compatibility-default'
        ? 'compatibility-default'
        : 'derived',
    };
  }

  if (capability?.defaultDuration !== undefined) {
    return { value: capability.defaultDuration, source: 'capability-default' };
  }

  return { value: DEFAULT_VIDEO_DURATION_SECONDS, source: 'compatibility-default' };
}

function assertDurationSupported(
  duration: number,
  capability: VideoModelCapability | undefined,
  source: CanonicalVideoValueSource,
  subject = '时长',
): void {
  if (source === 'compatibility-default') return;
  if (!capability) return;
  if (capability.durations?.length && !capability.durations.includes(duration)) {
    fail(
      'UNSUPPORTED_DURATION',
      `${subject} ${duration} 秒不在模型支持的离散时长中`,
      'durationSeconds',
      { value: duration, allowed: capability.durations },
    );
  }
  if (capability.minDuration !== undefined && duration < capability.minDuration) {
    fail(
      'DURATION_OUT_OF_RANGE',
      `${subject} ${duration} 秒低于模型下限 ${capability.minDuration} 秒`,
      'durationSeconds',
      { value: duration, minimum: capability.minDuration },
    );
  }
  if (capability.maxDuration !== undefined && duration > capability.maxDuration) {
    fail(
      'DURATION_OUT_OF_RANGE',
      `${subject} ${duration} 秒超过模型上限 ${capability.maxDuration} 秒`,
      'durationSeconds',
      { value: duration, maximum: capability.maxDuration },
    );
  }
}

function parsePixelDimensions(value: string | null): CanonicalVideoPixelDimensions | null {
  if (!value) return null;
  const match = value.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function derivePixelDimensions(
  longEdge: number | undefined,
  aspectRatio: string | null,
  resolutionPreset: string | null,
): ResolvedValue<CanonicalVideoPixelDimensions | null> {
  const dimensionsFromPreset = parsePixelDimensions(resolutionPreset);
  if (dimensionsFromPreset) {
    return { value: dimensionsFromPreset, source: 'derived' };
  }

  if (longEdge === undefined) return { value: null, source: 'unspecified' };
  assertPositiveFinite(longEdge, 'pixelDimensions');

  const match = aspectRatio?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return { value: null, source: 'unspecified' };
  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  if (ratioWidth <= 0 || ratioHeight <= 0) return { value: null, source: 'unspecified' };

  return ratioWidth >= ratioHeight
    ? {
      value: { width: Math.round(longEdge), height: Math.round(longEdge * ratioHeight / ratioWidth) },
      source: 'derived',
    }
    : {
      value: { width: Math.round(longEdge * ratioWidth / ratioHeight), height: Math.round(longEdge) },
      source: 'derived',
    };
}

function resolveAudioPolicy(
  requested: boolean | undefined,
  capability: VideoModelCapability | undefined,
): ResolvedValue<CanonicalVideoAudioPolicy> {
  if (requested === true) {
    if (capability?.supportsAudio === false) {
      fail(
        'AUDIO_GENERATION_UNSUPPORTED',
        '当前模型不支持生成视频音轨',
        'audioPolicy',
      );
    }
    return { value: 'generate', source: 'request' };
  }
  if (requested === false) return { value: 'mute', source: 'request' };
  if (capability?.supportsAudio === false) {
    return { value: 'mute', source: 'capability-default' };
  }
  return { value: 'model-default', source: 'unspecified' };
}

/**
 * Resolve a provider-independent video intent and enforce the selected model's
 * declared capability before any paid request is submitted.
 */
export function resolveCanonicalVideoRequest(
  params: AIVideoGenParams,
  options: ResolveCanonicalVideoRequestOptions = {},
): CanonicalVideoRequest {
  const capability = options.capability;
  assertVideoModelCapability(capability);

  const references = normalizeReferences(options.references ?? params.referenceMedia ?? []);
  const operation = resolveCanonicalVideoOperation(references);
  const inputMode = resolveCanonicalVideoInputMode(references);
  assertReferenceCapabilities(references, capability, params.model);
  assertOperationSupported(operation, capability, params.model);
  assertReferenceCombinationSupported(references, capability, params.model);

  const minimumPromptLength = capability?.inputConstraints?.promptMinCharacters;
  if (minimumPromptLength !== undefined && params.prompt.trim().length < minimumPromptLength) {
    fail(
      'INVALID_PARAMETER',
      `提示词至少需要 ${minimumPromptLength} 个字符`,
      'prompt',
      { length: params.prompt.trim().length, minimum: minimumPromptLength },
    );
  }

  const inputModeCapability = capability?.inputModeCapabilities?.[inputMode];
  const aspectRatio = resolveOptionalString(
    params.seedanceRatio,
    inputModeCapability?.defaultRatio ?? capability?.defaultRatio,
  );
  const resolutionPreset = resolveOptionalString(
    params.seedanceResolution,
    capability?.defaultResolution,
  );
  assertAllowedString(
    aspectRatio.value,
    inputModeCapability?.ratios ?? capability?.ratios,
    'UNSUPPORTED_ASPECT_RATIO',
    'aspectRatio',
    '宽高比',
  );
  if (inputModeCapability?.requiresRatio && aspectRatio.value === null) {
    fail(
      'INVALID_PARAMETER',
      `当前 ${inputMode} 输入模式必须指定宽高比`,
      'aspectRatio',
      { inputMode },
    );
  }
  assertAllowedString(
    resolutionPreset.value,
    capability?.resolutions,
    'UNSUPPORTED_RESOLUTION',
    'resolutionPreset',
    '分辨率档位',
  );

  const frameRate = resolveFrameRate(params.videoFps, capability);
  assertFrameRateSupported(frameRate.value, capability, frameRate.source);
  const frameCount = resolveExplicitFrameCount(params.videoFrames);
  const duration = resolveDuration(
    params.seedanceDuration,
    frameCount.value,
    frameRate,
    capability,
  );
  if (frameCount.source === 'request' && duration.source === 'request') {
    const expectedFrameCount = Math.round(duration.value * frameRate.value) + 1;
    if (Math.abs(frameCount.value! - expectedFrameCount) > 1) {
      fail(
        'INVALID_PARAMETER',
        `显式 frameCount ${frameCount.value} 与 ${duration.value} 秒 / ${frameRate.value} fps 不一致（应约为 ${expectedFrameCount} 帧）`,
        'frameCount',
        {
          frameCount: frameCount.value,
          durationSeconds: duration.value,
          requestedFrameRate: frameRate.value,
          expectedFrameCount,
        },
      );
    }
  }
  assertDurationSupported(duration.value, capability, duration.source);

  const pixelDimensions = derivePixelDimensions(
    params.videoResolution,
    aspectRatio.value,
    resolutionPreset.value,
  );
  const audioPolicy = resolveAudioPolicy(params.generateAudio, capability);

  return {
    modelId: params.model,
    prompt: params.prompt,
    operation,
    inputMode,
    references,
    output: {
      aspectRatio: aspectRatio.value,
      resolutionPreset: resolutionPreset.value,
      pixelDimensions: pixelDimensions.value,
      durationSeconds: duration.value,
      requestedFrameRate: frameRate.value,
      frameCount: frameCount.value,
      candidateCount: 1,
      audio: {
        policy: audioPolicy.value,
        referenceCount: references.counts.audio,
      },
    },
    sources: {
      aspectRatio: aspectRatio.source,
      resolutionPreset: resolutionPreset.source,
      pixelDimensions: pixelDimensions.source,
      durationSeconds: duration.source,
      requestedFrameRate: frameRate.source,
      frameCount: frameCount.source,
      audioPolicy: audioPolicy.source,
    },
  };
}

/**
 * Project the canonical request into values understood by the current runtime.
 * This remains provider-neutral and intentionally does not create an HTTP body.
 */
export function toResolvedVideoCompatibilityValues(
  request: CanonicalVideoRequest,
): ResolvedVideoCompatibilityValues {
  const imageUrls = request.references.images.map((reference) => reference.url);
  const videoUrls = request.references.videos.map((reference) => reference.url);
  const audioUrls = request.references.audios.map((reference) => reference.url);
  const firstRoleImage = request.references.images.find((item) => item.role === 'first_frame');
  const lastRoleImage = request.references.images.find((item) => item.role === 'last_frame');
  const firstImageUrl = (firstRoleImage ?? request.references.images[0])?.url;
  const lastFallback = request.references.images.length > 1
    ? request.references.images[request.references.images.length - 1]
    : undefined;
  const lastImageUrl = (lastRoleImage ?? lastFallback)?.url;
  const generatedFrameCount = Math.round(
    request.output.durationSeconds * request.output.requestedFrameRate,
  ) + 1;

  return {
    prompt: request.prompt,
    operation: request.operation,
    imageUrls,
    videoUrls,
    audioUrls,
    ...(firstImageUrl ? { firstImageUrl } : {}),
    ...(lastImageUrl ? { lastImageUrl } : {}),
    ...(request.output.aspectRatio ? { aspectRatio: request.output.aspectRatio } : {}),
    ...(request.output.resolutionPreset
      ? { resolutionPreset: request.output.resolutionPreset }
      : {}),
    ...(request.output.pixelDimensions
      ? {
        width: request.output.pixelDimensions.width,
        height: request.output.pixelDimensions.height,
      }
      : {}),
    durationSeconds: request.output.durationSeconds,
    requestedFrameRate: request.output.requestedFrameRate,
    frameCount: request.output.frameCount ?? generatedFrameCount,
    generateAudio: request.output.audio.policy === 'model-default'
      ? undefined
      : request.output.audio.policy === 'generate',
    candidateCount: request.output.candidateCount,
  };
}
