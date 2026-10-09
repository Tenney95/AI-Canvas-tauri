/** 插件与批量规划共用的模型能力入口；未知模型不按名称猜测能力。 */
import type { AppConfig } from '../../types';
import type { NumericInputConstraint, VideoModelCapability, VideoParameterCapabilityOverride } from '../../types/aiTypes';
import { getApimartSeedanceCapability, type ApimartSeedanceCapability } from './apimartVideoModels';
import { getVolcengineSeedanceCapability } from './volcengineVideoModels';
import { getDreaminaVideoCapability } from './dreaminaModels';
import { getGrsaiVideoCapability } from './grsaiModels';
import { getModelProtocolPresetVideoCapability } from './modelProtocolPresets';
import { SORA2U_MODEL_MANIFEST } from './providers/sora2uModelManifest';

function safeRange(range: NumericInputConstraint | undefined): NumericInputConstraint | undefined {
  return range === undefined ? undefined : {
    min: range.min, max: range.max, minExclusive: range.minExclusive, maxExclusive: range.maxExclusive,
  };
}

function safeOverride(override: VideoParameterCapabilityOverride | undefined): VideoParameterCapabilityOverride | undefined {
  return override === undefined ? undefined : {
    ratios: override.ratios ? [...override.ratios] : undefined,
    defaultRatio: override.defaultRatio, requiresRatio: override.requiresRatio,
    automaticDurationOnly: override.automaticDurationOnly,
  };
}

/** 白名单投影，防止旧配置或导入记录的未知字段混入插件可见摘要。 */
function safeCapability(capability: VideoModelCapability): VideoModelCapability {
  const constraints = capability.inputConstraints;
  return {
    operations: capability.operations ? [...capability.operations] : undefined,
    requiresReference: capability.requiresReference,
    resolutions: capability.resolutions ? [...capability.resolutions] : undefined,
    defaultResolution: capability.defaultResolution,
    ratios: capability.ratios ? [...capability.ratios] : undefined,
    defaultRatio: capability.defaultRatio,
    inputModeCapabilities: capability.inputModeCapabilities ? {
      ...(capability.inputModeCapabilities.text ? { text: safeOverride(capability.inputModeCapabilities.text) } : {}),
      ...(capability.inputModeCapabilities.keyframe ? { keyframe: safeOverride(capability.inputModeCapabilities.keyframe) } : {}),
      ...(capability.inputModeCapabilities.reference ? { reference: safeOverride(capability.inputModeCapabilities.reference) } : {}),
      ...(capability.inputModeCapabilities.mixed ? { mixed: safeOverride(capability.inputModeCapabilities.mixed) } : {}),
    } : undefined,
    operationCapabilities: capability.operationCapabilities ? {
      ...(capability.operationCapabilities['text-to-video'] ? { 'text-to-video': safeOverride(capability.operationCapabilities['text-to-video']) } : {}),
      ...(capability.operationCapabilities['image-to-video'] ? { 'image-to-video': safeOverride(capability.operationCapabilities['image-to-video']) } : {}),
      ...(capability.operationCapabilities['video-to-video'] ? { 'video-to-video': safeOverride(capability.operationCapabilities['video-to-video']) } : {}),
    } : undefined,
    frameRates: capability.frameRates ? [...capability.frameRates] : undefined,
    defaultFrameRate: capability.defaultFrameRate,
    durations: capability.durations ? [...capability.durations] : undefined,
    minDuration: capability.minDuration, maxDuration: capability.maxDuration,
    defaultDuration: capability.defaultDuration, automaticDurationValue: capability.automaticDurationValue,
    supportsAudio: capability.supportsAudio, supportsStandaloneAudio: capability.supportsStandaloneAudio,
    allowFrameAndReferenceMix: capability.allowFrameAndReferenceMix,
    maxImageReferences: capability.maxImageReferences, maxVideoReferences: capability.maxVideoReferences,
    maxAudioReferences: capability.maxAudioReferences,
    inputConstraints: constraints ? {
      promptMinCharacters: constraints.promptMinCharacters, maxBase64DecodedBytes: constraints.maxBase64DecodedBytes,
      referenceVideo: constraints.referenceVideo ? {
        width: safeRange(constraints.referenceVideo.width),
        durationSeconds: safeRange(constraints.referenceVideo.durationSeconds),
        totalDurationSeconds: safeRange(constraints.referenceVideo.totalDurationSeconds),
      } : undefined,
      referenceAudio: constraints.referenceAudio ? {
        durationSeconds: safeRange(constraints.referenceAudio.durationSeconds),
        totalDurationSeconds: safeRange(constraints.referenceAudio.totalDurationSeconds),
      } : undefined,
    } : undefined,
  };
}

function fromNativeCapability(capability: ApimartSeedanceCapability): VideoModelCapability {
  return {
    operations: [...capability.operations],
    resolutions: [...capability.resolutions],
    defaultResolution: capability.defaultResolution,
    ratios: [...capability.ratios],
    defaultRatio: capability.defaultRatio,
    ...(capability.durations ? { durations: [...capability.durations] } : {}),
    minDuration: capability.minDuration,
    maxDuration: capability.maxDuration,
    defaultDuration: capability.defaultDuration,
    automaticDurationValue: capability.automaticDurationValue,
    supportsAudio: Boolean(capability.audioField),
    supportsStandaloneAudio: capability.allowsAudioOnly,
    maxImageReferences: capability.maxImageReferences,
    maxVideoReferences: capability.maxVideoReferences,
    maxAudioReferences: capability.maxAudioReferences,
    ...(capability.imageWithRoles ? { allowFrameAndReferenceMix: false } : {}),
    inputConstraints: capability.inputConstraints,
    inputModeCapabilities: capability.inputModeCapabilities,
    operationCapabilities: capability.operationCapabilities,
  };
}

/** 只返回参数能力，不输出连接地址、协议模板或凭据。 */
export function resolveVideoModelCapability(
  modelId: string,
  config: AppConfig,
  resolution?: string,
): VideoModelCapability | undefined {
  if (modelId.startsWith('comfyui/')) return undefined;
  if (modelId.startsWith('general/')) {
    const general = config.generalModels?.find((model) => model.id === modelId.slice('general/'.length));
    if (!general || general.category !== 'video') return undefined;
    const capability = general.videoCapability ?? getModelProtocolPresetVideoCapability(general.executionProfile);
    return capability ? safeCapability(capability) : undefined;
  }

  const separator = modelId.indexOf('/');
  if (separator <= 0) return undefined;
  const provider = modelId.slice(0, separator);
  const rawId = modelId.slice(separator + 1);
  let capability: VideoModelCapability | undefined;
  if (provider === 'apimart' || provider === 'volcengine') {
    const native = provider === 'apimart'
      ? getApimartSeedanceCapability(rawId)
      : getVolcengineSeedanceCapability(rawId);
    capability = native ? fromNativeCapability(native) : undefined;
  } else if (provider === 'dreamina') {
    const native = getDreaminaVideoCapability(rawId);
    if (native) {
      capability = {
        operations: [...native.operations], resolutions: [...native.resolutions],
        defaultResolution: native.defaultResolution, ratios: [...native.ratios],
        defaultRatio: native.defaultRatio, minDuration: native.minDuration,
        maxDuration: native.maxDuration, defaultDuration: native.defaultDuration,
        supportsAudio: Boolean(native.audioField), supportsStandaloneAudio: native.allowsAudioOnly,
        maxImageReferences: native.maxImageReferences, maxVideoReferences: native.maxVideoReferences,
        maxAudioReferences: native.maxAudioReferences,
      };
    }
  } else if (provider === 'grsai') {
    capability = getGrsaiVideoCapability(rawId, resolution);
  }
  if (!capability) {
    const selected = config.providers[provider]?.selectedModels?.find((model) => (
      model.category === 'video' && (model.id === rawId || model.id === modelId)
    ));
    capability = selected?.videoCapability ?? getModelProtocolPresetVideoCapability(selected?.executionProfile);
    if (!capability && provider === 'sora2u') {
      capability = SORA2U_MODEL_MANIFEST.find((model) => model.category === 'video' && model.id === rawId)?.videoCapability;
    }
  }
  return capability ? safeCapability(capability) : undefined;
}
