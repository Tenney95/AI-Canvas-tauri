/**
 * ai/generateVideo — 视频生成入口
 */
import { isLocalMediaUrl, isRemoteMediaUrl } from '../../utils/mediaUrl';
import { resolveComfyRefmodMentionInputs } from '../../utils/comfyRefmodMention';
import { videoInputData, videoInputFingerprint } from '../videoBatchPlanning';
import { useAppStore } from '../../store/useAppStore';
import { isRunningHubWorkflow } from '../workflowExecutionService';
import { executeRunningHubWorkflow } from './providers/runninghubWorkflow';
import { splitRunningHubPrompt, resolveRunningHubInputRouting } from './providers/runninghubWorkflowInputs';
import { executeWorkflowApi } from '../workflowApi/workflowApiAdapter';
import { parseWorkflowApiFields } from '../workflowApi/workflowApiConfig';
import { getPendingTasksForProject } from '../pollManager';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { resolveNodeReferencesAsync } from '../nodeReferenceService';
import { expandShotlistRowMentions } from '../shotlistPromptService';
import { generateDreaminaVideo } from '../dreaminaService';
import { executeComfyUIVideoGenerate } from '../comfyWorkflowService';
import type { BaseNodeData } from '../../types';
import type {
  AIVideoGenParams,
  MediaReference,
  MediaReferenceRole,
  VideoReferenceItem,
  VideoGenerationOperation,
  VideoGenerationReferenceInput,
  VideoModelCapability,
  MediaTaskReceipt,
  MediaDownloadAccess,
} from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import { getProviderPolicy, resolveProviderCatalogId } from './providerPolicies';
import { resolvePromptWithMediaRefs } from './promptResolver';
import { compileVideoReferencePrompt } from './referencePrompt';
import {
  collectConnectedReferenceMedia,
  getMediaReferenceUrl,
  getMediaReferenceUrls,
  mergeMediaReferences,
  warnIfTooManyReferences,
} from './connectedReferenceMedia';
import { getApimartSeedanceCapability, type ApimartSeedanceCapability } from './apimartVideoModels';
import { pollVolcengineVideoTask } from './providers/volcengineVideoQuery';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';
import {
  getModelProtocolPresetVideoCapability,
  normalizeFrames8n1,
  resolveModelExecutionProfile,
  type ModelProtocolVariables,
} from './modelProtocol';
import { mediaProviderRegistry } from './mediaProviderRegistry';
import {
  normalizeVideoFps,
  resolveVideoDurationSeconds,
  videoFramesFromDuration,
} from '../aiDimensions';
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling, pauseMediaTask, VIDEO_POLL_MAX_DURATION_MS } from '../pollManager';
import { corsSafeFetch } from './httpTransport';
import { resolveImageUrlArray } from './imageUtils';
import { mapSequentially, resolveImageUrlsSequentially } from './referenceMediaPreparation';
import { resolveMediaReferenceUrl } from '../uploadService';
import { relayonVideoVariables, usesRelayonModelProtocol } from './providers/relayonModelManifest';
import {
  createMediaDataUrlBudget,
  type MediaDataUrlBudget,
} from '../fileService';
import { mapVideoParameters } from './videoParameterMappings';
import {
  getVolcengineSeedanceCapability,
  isVolcengineSeedance25Model,
} from './volcengineVideoModels';
import { getDreaminaVideoCapability } from './dreaminaModels';
import { assertVideoInputConstraints } from './videoInputValidation';
import {
  resolveCanonicalVideoRequest,
  toResolvedVideoCompatibilityValues,
  type CanonicalVideoRequest,
} from './videoRequestResolver';
import { getAsset } from './providers/volcengineAssetLibrary';
import { readAppSecret } from '../providerSecretService';
import { quoteVolcengineVideo } from '../billing/volcenginePricing';
import { createBillingRun, updateBillingRun } from '../billing/volcengineBillingService';
import { assertToapisVideoInput, toapisVideoVariables } from './providers/toapisModelManifest';
import { assertLibapiVideoInput, libapiVideoVariables, usesLibapiModelProtocol } from './providers/libapiModelManifest';
import { withSora2uReferenceLimits } from './providers/sora2uModelManifest';

export { compileVideoReferencePrompt } from './referencePrompt';

export function resolveVideoGenerationOperation(
  imageUrls: readonly string[],
  videoUrls: readonly string[],
): VideoGenerationOperation {
  if (videoUrls.length > 0) return 'video-to-video';
  if (imageUrls.length > 0) return 'image-to-video';
  return 'text-to-video';
}

/** 视频节点上手动挑选的参考帧 / 参考角色；没挑就返回空数组，沿用连线顺序。 */
export function resolveVideoNodeReferences(nodeId: string | undefined): VideoReferenceItem[] {
  if (!nodeId) return [];
  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  return (node?.data as BaseNodeData | undefined)?.videoReferences ?? [];
}

function toMediaReferences(items: readonly VideoReferenceItem[], provider?: string): MediaReference[] {
  return items.map((item) => {
    // 方舟绑定同时保留普通角色预览图；切换到其他厂商时自动回退到普通图片，
    // 避免把只对方舟有效的 asset:// 地址发送给其他 Provider。
    const useVolcengineAsset = provider === 'volcengine' || !item.provider || !item.assetId;
    const url = !useVolcengineAsset && item.previewUrl ? item.previewUrl : item.url;
    return {
      kind: item.mediaKind ?? 'image',
      url,
      origin: 'connection' as const,
    // 方舟虚拟人像始终是角色参考，不能被旧节点数据中的帧角色字段带入首/尾帧语义。
      role: item.provider === 'volcengine' && item.kind === 'volcengine-asset'
      ? item.mediaKind === 'audio' ? 'reference_audio' as const : item.mediaKind === 'video' ? 'reference' as const : 'reference' as const
      : item.role,
      sourceNodeId: item.sourceNodeId,
      provider: useVolcengineAsset ? item.provider : undefined,
      assetId: useVolcengineAsset ? item.assetId : undefined,
      assetGroupId: useVolcengineAsset ? item.assetGroupId : undefined,
      projectName: useVolcengineAsset ? item.projectName : undefined,
    };
  });
}

function hasManualFrameRoles(items: readonly { role: string }[]): boolean {
  return items.some((item) => item.role === 'first_frame' || item.role === 'last_frame');
}

/** 提示词点名了参考角色时附上「图N = 角色名」，否则模型不知道该照着哪张参考图画谁。 */
export function annotateCharacterReferences(
  prompt: string,
  items: readonly VideoReferenceItem[],
  imageUrls: readonly string[],
): string {
  const notes = items.flatMap((item) => {
    if (item.kind !== 'character' || !item.label) return [];
    const name = mentionedCharacterName(prompt, item.label);
    const index = imageUrls.indexOf(item.url);
    return name && index >= 0 ? [`图${index + 1} 是${name}`] : [];
  });
  return notes.length > 0 ? `${prompt}\n\n（角色参考：${notes.join('，')}）` : prompt;
}

/** 角色库里常带前缀（如「女主·林夏」），提示词多半只写其中一段 */
function mentionedCharacterName(prompt: string, label: string): string | undefined {
  if (prompt.includes(label)) return label;
  return label
    .split(/[·・：:|/\\\s-]+/)
    .filter((part) => part.length >= 2)
    .find((part) => prompt.includes(part));
}

function annotateVolcengineCharacterBindings(
  prompt: string,
  nodeItems: readonly VideoReferenceItem[],
  references: readonly MediaReference[],
): string {
  const notes = nodeItems
    .filter((item) => item.provider === 'volcengine' && item.kind === 'character' && item.mediaKind !== 'audio' && item.assetId)
    .flatMap((character) => {
      const voice = nodeItems.find((item) => item.id === `${character.id}:voice` && item.mediaKind === 'audio');
      if (!voice) return [];
      const imageReference = references.find((reference) => reference.assetId === character.assetId);
      const audioReference = references.find((reference) => reference.assetId === voice.assetId);
      if (!imageReference || !audioReference) return [];
      const imageIndex = references.filter((reference) => reference.kind === 'image').indexOf(imageReference) + 1;
      const audioIndex = references.filter((reference) => reference.kind === 'audio').indexOf(audioReference) + 1;
      return imageIndex > 0 && audioIndex > 0 ? [`图片${imageIndex}中的角色使用音频${audioIndex}的声音，并保持口型与音频同步`] : [];
    });
  return notes.length > 0 ? `${prompt}\n\n（角色绑定：${[...new Set(notes)].join('；')}。）` : prompt;
}

function assignVideoReferenceRoles(references: readonly MediaReference[]): MediaReference[] {
  // 只有用户明确挑选的参考帧才保留首/尾帧语义，并按 首帧 → 参考图 → 尾帧 重排。
  if (hasManualFrameRoles(references)) {
    const rank = (role: MediaReferenceRole) => (role === 'first_frame' ? 0 : role === 'last_frame' ? 2 : 1);
    return references
      .map((reference) => ({
        ...reference,
        role: reference.kind === 'audio' ? ('reference_audio' as const) : reference.role,
      }))
      .sort((a, b) => rank(a.role) - rank(b.role));
  }
  // 连线图片和普通 @ 图片默认都是参考图，不能再按图片顺序偷偷推断首尾帧。
  return references.map((reference) => {
    if (reference.kind === 'audio') return { ...reference, role: 'reference_audio' };
    return { ...reference, role: 'reference' };
  });
}

async function resolveGeneralProtocolMediaUrls(
  references: readonly MediaReference[],
  kind: 'video' | 'audio',
  budget: MediaDataUrlBudget,
  signal?: AbortSignal,
  publicUrlProvider?: string,
): Promise<string[]> {
  return mapSequentially(references.filter((reference) => reference.kind === kind), async (reference) => {
    const url = getMediaReferenceUrl(reference);
    // 仅要求公网素材的厂商使用所属连接上传；其他通用协议继续沿用 data URL。
    return resolveMediaReferenceUrl(url, {
      mode: publicUrlProvider ? 'publicUrl' : 'dataUrl', provider: publicUrlProvider, kind, signal, dataUrlBudget: budget,
    });
  }, signal);
}

function replaceReferenceUrls(
  references: readonly MediaReference[],
  urls: { image: readonly string[]; video: readonly string[]; audio: readonly string[] },
): MediaReference[] {
  const indexes = { image: 0, video: 0, audio: 0 };
  return references.map((reference) => {
    const index = indexes[reference.kind]++;
    const url = urls[reference.kind][index];
    if (!url) throw new Error(`参考${reference.kind}素材转换后数量不一致，请重新连接素材后重试`);
    return { ...reference, url, sourceUrl: url };
  });
}

async function resolveVideoReferenceInput(
  rawPrompt: string,
  nodeId: string | undefined,
  /** 调用方直接给定的参考媒体；排在最前，保证首/尾帧角色按调用方的顺序分配 */
  explicitReferences: readonly MediaReference[] = [],
  options: { promptFirst?: boolean; preserveDeclaredRoles?: boolean; sortKeyframes?: boolean; target?: 'remote' | 'local'; apimartModel?: string; legacyPrompt?: string; provider?: string; suppressWarning?: boolean } = {},
): Promise<VideoGenerationReferenceInput> {
  const cameraSettings = useAppStore.getState().nodes.find((node) => node.id === nodeId)?.data.cameraSettings;
  const promptInput = await resolvePromptWithMediaRefs(rawPrompt, { preserveBindings: true, cameraSettings });
  const connected = collectConnectedReferenceMedia(nodeId);
  const nodeItems = resolveVideoNodeReferences(nodeId);
  // RH 先按来源节点归一本地副本，再去重，避免共享原图的其他节点提前被删掉。
  const canonicalReference = (reference: MediaReference): MediaReference => {
    if (options.provider !== 'runninghub' || reference.kind !== 'image' || !reference.sourceNodeId) return reference;
    const local = promptInput.references.find((candidate) => candidate.kind === 'image'
      && candidate.sourceNodeId === reference.sourceNodeId
      && (candidate.sourceUrl === reference.url
        || useAppStore.getState().nodes.find((node) => node.id === candidate.sourceNodeId)?.data.imageUrl === reference.url));
    return local ? { ...reference, url: local.url } : reference;
  };
  const regularReferences = mergeMediaReferences(
    // 节点上手动挑的参考帧/参考角色排在连线与提示词引用之前，重复的图按它们的角色去重
    mergeMediaReferences(explicitReferences.map(canonicalReference), toMediaReferences(nodeItems, options.provider).map(canonicalReference)),
    mergeMediaReferences(promptInput.references, connected.references.map(canonicalReference)),
  );
  const collectedReferences = options.promptFirst
    ? mergeMediaReferences(promptInput.references, regularReferences) : regularReferences;
  // 先按最终传参顺序排好首尾帧，后面的图片编号和角色说明才能对上。
  const orderedReferences = options.sortKeyframes && hasManualFrameRoles(collectedReferences)
    ? assignVideoReferenceRoles(collectedReferences) : collectedReferences;
  // 普通 reference 图片不能被偷偷改成 first_frame；内置 Provider 也只接受用户
  // 明确指定的首/尾帧角色，连线与 @ 图片默认保持普通参考语义。
  const references = options.preserveDeclaredRoles || options.promptFirst
    ? orderedReferences.map((reference) => reference.kind === 'audio'
      ? { ...reference, role: 'reference_audio' as const }
      : reference)
    : assignVideoReferenceRoles(orderedReferences);
  const imageUrls = getMediaReferenceUrls(references, 'image');
  const videoUrls = getMediaReferenceUrls(references, 'video');
  const audioUrls = getMediaReferenceUrls(references, 'audio');
  // APIMart 的带角色数组先发送首尾帧再发送参考图；独立帧字段不占参考图数组编号。
  const apimartCapability = options.apimartModel ? getApimartSeedanceCapability(options.apimartModel) : undefined;
  const explicitFrames = hasManualFrameRoles([...explicitReferences, ...nodeItems]);
  const imageLayout = explicitFrames && apimartCapability?.frameFields ? 'frame-fields'
    : explicitFrames && apimartCapability?.imageWithRoles ? 'frames-first' : undefined;
  const hasCharacterBindings = promptInput.segments?.some((segment) => typeof segment !== 'string' && segment.character);
  const compiledPrompt = options.legacyPrompt !== undefined && !hasCharacterBindings
    ? options.legacyPrompt
    : compileVideoReferencePrompt(promptInput, references, { target: options.target, imageLayout });
  const isFrame = (reference: MediaReference) => reference.role === 'first_frame' || reference.role === 'last_frame';
  const noteReferences = imageLayout === 'frame-fields' ? references.filter((reference) => !isFrame(reference))
    : imageLayout === 'frames-first' ? [...references.filter(isFrame), ...references.filter((reference) => !isFrame(reference))] : references;
  if (!options.suppressWarning) warnIfTooManyReferences({
    image: imageUrls.length,
    video: videoUrls.length,
    audio: audioUrls.length,
  });
  return {
    prompt: annotateVolcengineCharacterBindings(
      annotateCharacterReferences(compiledPrompt, nodeItems, getMediaReferenceUrls(noteReferences, 'image', options.target)),
      nodeItems,
      references,
    ),
    imageUrls,
    videoUrls,
    audioUrls,
    operation: resolveVideoGenerationOperation(imageUrls, videoUrls),
    references,
  };
}

/** Read-only preflight: resolve real inputs without uploading or submitting a task. */
export async function hasVideoReferenceContent(params: AIVideoGenParams): Promise<boolean> {
  const state = useAppStore.getState();
  const options = { durationSeconds: params.seedanceDuration, cameraSettings: state.nodes.find((node) => node.id === params.nodeId)?.data.cameraSettings };
  const expandedInputs = params.workflowInputs && Object.fromEntries(Object.entries(params.workflowInputs)
    .map(([key, value]) => [key, expandShotlistRowMentions(value, state.nodes, options)]));
  const input = resolveComfyRefmodMentionInputs({
    prompt: expandShotlistRowMentions(params.prompt, state.nodes, options),
    workflowInputs: expandedInputs,
    manual: params.comfyRefmods,
  });
  // RefMod is a deliberate character reference even when no image is attached.
  if (input.comfyRefmods.length) return true;
  const workflow = state.workflows.find((item) => item.id === params.workflowId);
  const referencePrompt = workflow?.adapterType === 'runninghub' ? splitRunningHubPrompt(input.prompt).prompt : input.prompt;
  const referenceInput = await resolveVideoReferenceInput(referencePrompt, params.nodeId, params.referenceMedia ?? [], {
    provider: params.provider, target: 'local', preserveDeclaredRoles: true, suppressWarning: true,
  });
  if (referenceInput.references?.length) return true;

  // ComfyUI explicit media slots are resolved separately from the main prompt.
  // RH 的定向素材不混入正文，单独检查其已声明的输入槽。
  if (workflow?.adapterType === 'runninghub') {
    const routing = await resolveRunningHubInputRouting(workflow, input.prompt, input.workflowInputs);
    return [...routing.bindings.values()].some((binding) => !!binding.mediaSource);
  }
  if (!workflow || (workflow.adapterType && workflow.adapterType !== 'comfyui')) return false;
  for (const io of workflow.ioNodes ?? []) {
    if (!['image', 'video', 'audio'].includes(io.type)) continue;
    const raw = input.workflowInputs?.[io.nodeId];
    if (raw === undefined || !raw.trim()) continue;
    const media = await resolveVideoReferenceInput(raw, undefined, [], {
      target: 'local', preserveDeclaredRoles: true, suppressWarning: true, provider: params.provider,
    });
    if (media.references?.length) return true;
    const url = (await resolveNodeReferencesAsync(raw)).trim();
    if (isLocalMediaUrl(url) || isRemoteMediaUrl(url)) return true;
  }
  return false;
}

function assertVideoOperationSupported(
  referenceInput: VideoGenerationReferenceInput,
  target: string,
): void {
  if (referenceInput.operation === 'video-to-video') {
    throw new Error(`${target} 暂不支持视频到视频生成，请选择支持该能力的模型`);
  }
}

/**
 * 按模型声明的参考素材上限拦截，超了直接报错而不是让接口返回一句看不懂的 400。
 * 上限缺省表示该模型没声明，保持原有的「不拦截、只提醒」行为。
 */
export function assertVideoReferenceLimits(
  referenceInput: VideoGenerationReferenceInput,
  capability: VideoModelCapability | ApimartSeedanceCapability | undefined,
  modelName: string,
): void {
  if (!capability) return;
  if (
    'requiresReference' in capability
    && capability.requiresReference
    && referenceInput.imageUrls.length === 0
    && referenceInput.videoUrls.length === 0
    && referenceInput.audioUrls.length === 0
  ) {
    throw new Error(`模型 "${modelName}" 至少需要一份参考素材`);
  }
  const limits = [
    { kind: '参考图', count: referenceInput.imageUrls.length, max: capability.maxImageReferences },
    { kind: '参考视频', count: referenceInput.videoUrls.length, max: capability.maxVideoReferences },
    { kind: '参考音频', count: referenceInput.audioUrls.length, max: capability.maxAudioReferences },
  ];
  for (const { kind, count, max } of limits) {
    if (max === undefined || count <= max) continue;
    throw new Error(max === 0
      ? `模型 "${modelName}" 不支持${kind}，请断开多余的连线`
      : `模型 "${modelName}" 最多支持 ${max} 个${kind}，当前有 ${count} 个，请断开多余的连线`);
  }
}

function referencesFromLegacyInput(
  referenceInput: VideoGenerationReferenceInput,
): MediaReference[] {
  if (referenceInput.references?.length) return referenceInput.references;
  const imageReferences = referenceInput.imageUrls.map((url) => ({
    kind: 'image' as const,
    url,
    origin: 'connection' as const,
    // 旧调用方没有角色数组时只能按普通参考图处理；首尾帧必须由调用方明确声明。
    role: 'reference' as const,
  }));
  return [
    ...imageReferences,
    ...referenceInput.videoUrls.map((url) => ({
      kind: 'video' as const,
      url,
      origin: 'connection' as const,
      role: 'reference' as const,
    })),
    ...referenceInput.audioUrls.map((url) => ({
      kind: 'audio' as const,
      url,
      origin: 'connection' as const,
      role: 'reference_audio' as const,
    })),
  ];
}

/** 旧调用入口保留；内部先统一解析为 provider-neutral canonical request。 */
export function buildGeneralVideoProtocolVariables(
  modelId: string,
  params: AIVideoGenParams,
  referenceInput: VideoGenerationReferenceInput,
  videoCapability?: VideoModelCapability,
): ModelProtocolVariables {
  const canonical = resolveCanonicalVideoRequest({
    ...params,
    model: modelId,
    prompt: referenceInput.prompt,
  }, {
    references: referencesFromLegacyInput(referenceInput),
    capability: videoCapability,
  });
  return buildCanonicalVideoProtocolVariables(canonical);
}

export function buildCanonicalVideoProtocolVariables(
  request: CanonicalVideoRequest,
): ModelProtocolVariables {
  const compatibility = toResolvedVideoCompatibilityValues(request);
  const aspectRatio = compatibility.aspectRatio;
  const width = compatibility.width;
  const height = compatibility.height;
  const size = width !== undefined && height !== undefined ? `${width}x${height}` : undefined;
  const videoResolution = width !== undefined && height !== undefined
    ? Math.max(width, height)
    : undefined;
  const fps = request.sources.requestedFrameRate === 'compatibility-default'
    ? undefined
    : compatibility.requestedFrameRate;
  const duration = request.sources.durationSeconds === 'compatibility-default'
    ? undefined
    : compatibility.durationSeconds;
  const frames = request.output.frameCount ?? (
    duration !== undefined && fps !== undefined ? compatibility.frameCount : undefined
  );
  const firstImage = request.references.images
    .find((reference) => reference.role === 'first_frame')?.url;
  const lastImage = request.references.images
    .find((reference) => reference.role === 'last_frame')?.url;
  const imageUrls = compatibility.imageUrls.length > 0 ? compatibility.imageUrls : undefined;
  const referenceImageUrlsValue = request.references.images
    .filter((reference) => reference.role === 'reference')
    .map((reference) => reference.url);
  const referenceImageUrls = referenceImageUrlsValue.length > 0
    ? referenceImageUrlsValue
    : undefined;
  const videoUrls = compatibility.videoUrls.length > 0 ? compatibility.videoUrls : undefined;
  const audioUrls = compatibility.audioUrls.length > 0 ? compatibility.audioUrls : undefined;
  // 带角色的参考图数组（[{ url, role }]），供协议模板按 image_with_roles 语义引用：
  // 首/尾帧保留原角色，其余参考图按 Seedance 约定写 reference_image；
  // 为空时置 undefined，让模板省略该字段而不是发出空数组。
  const roleImages = request.references.images
    .map((reference) => ({
      url: reference.url,
      role: reference.role === 'first_frame' || reference.role === 'last_frame'
        ? reference.role
        : 'reference_image',
    }));
  const imageWithRoles = roleImages.length > 0 ? roleImages : undefined;
  const seedanceContent = [
    { type: 'text', text: request.prompt },
    ...request.references.images.map((reference) => ({
      type: 'image_url',
      image_url: { url: reference.url },
      role: reference.role === 'first_frame' || reference.role === 'last_frame'
        ? reference.role
        : 'reference_image',
    })),
    ...request.references.videos.map((reference) => ({
      type: 'video_url',
      video_url: { url: reference.url },
      role: 'reference_video',
    })),
    ...request.references.audios.map((reference) => ({
      type: 'audio_url',
      audio_url: { url: reference.url },
      role: 'reference_audio',
    })),
  ];
  const combinedReferences = [
    ...compatibility.imageUrls,
    ...compatibility.videoUrls,
    ...compatibility.audioUrls,
  ];
  const referenceUrls = combinedReferences.filter(isRemoteMediaUrl);
  const inlineReferences = combinedReferences.filter((url) => url.startsWith('data:'));

  return {
    model: request.modelId,
    prompt: request.prompt,
    size,
    aspectRatio,
    width,
    height,
    frames,
    frames8n1: frames === undefined ? undefined : normalizeFrames8n1(frames),
    fps,
    duration,
    durationText: duration === undefined ? undefined : String(duration),
    resolution: compatibility.resolutionPreset,
    videoResolution,
    videoFrames: frames,
    videoFps: fps,
    seedanceResolution: compatibility.resolutionPreset,
    seedanceRatio: aspectRatio,
    seedanceDuration: duration,
    generateAudio: compatibility.generateAudio,
    disableAudio: request.output.audio.policy === 'mute' ? true : undefined,
    videoOperation: request.operation,
    videoInputMode: request.inputMode,
    imageUrls,
    firstImage,
    lastImage,
    imageWithRoles,
    seedanceContent,
    referenceImageUrls,
    videoUrls,
    referenceVideoUrl: videoUrls?.[0],
    referenceVideoUrls: videoUrls,
    audioUrls,
    audioUrl: audioUrls?.[0],
    referenceAudioUrls: audioUrls,
    referenceUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
    inlineReferences: inlineReferences.length > 0 ? inlineReferences : undefined,
    n: compatibility.candidateCount,
    batchCount: compatibility.candidateCount,
  };
}

export async function generateVideo(
  params: AIVideoGenParams,
  signal?: AbortSignal,
  /** 宿主任务在素材准备完成后、实际提交前复核运行时租约。 */
  beforeSubmit?: () => void | Promise<void>,
): Promise<{ url: string; taskReceipt?: MediaTaskReceipt; mediaDownloadAccess?: MediaDownloadAccess; comfyTaskId?: string; runninghubOutputs?: import('../../types/runninghub').RunningHubOutput[];
  workflowApiOutputs?: import('../../types/workflowApi').CloudWorkflowOutput[]; workflowApiTaskId?: string }> {
  // 内置 Provider 与本地工作流暂时保持旧归一化；通用模型交给 capability-aware
  // canonical resolver，避免在读到模型的 30 秒能力前先被全局 15 秒上限截断。
  if (params.provider !== 'workflow-api' && (!['general', 'runninghub'].includes(params.provider) || params.workflowId)) {
    const videoFps = normalizeVideoFps(params.videoFps);
    const volcengineCapability = params.provider === 'volcengine'
      ? getVolcengineSeedanceCapability(params.model)
      : undefined;
    const maxDuration = volcengineCapability?.maxDuration;
    const preservesAutomaticDuration = volcengineCapability?.automaticDurationValue !== undefined
      && (params.seedanceDuration === volcengineCapability.automaticDurationValue
        || (params.seedanceDuration === undefined && params.videoFrames === undefined));
    const seedanceDuration = preservesAutomaticDuration
      ? params.seedanceDuration
      : resolveVideoDurationSeconds(params.seedanceDuration, params.videoFrames, videoFps, maxDuration);
    params = {
      ...params,
      videoFps,
      seedanceDuration,
      videoFrames: seedanceDuration === undefined || seedanceDuration < 0
        ? params.videoFrames
        : videoFramesFromDuration(seedanceDuration, videoFps, maxDuration),
    };
  }
  const { model, provider } = params;
  // 镜头行与所有 IO 文本先展开，再统一提取本地模型引用，避免 token 进入媒体上传或其他厂商。
  const cameraState = useAppStore.getState();
  const shotOptions = { durationSeconds: params.seedanceDuration, cameraSettings: cameraState.nodes.find((node) => node.id === params.nodeId)?.data.cameraSettings };
  const expandedPrompt = expandShotlistRowMentions(params.prompt, cameraState.nodes, shotOptions);
  const expandedInputs = params.workflowInputs && Object.fromEntries(Object.entries(params.workflowInputs)
    .map(([key, value]) => [key, typeof value === 'string'
      ? expandShotlistRowMentions(value, cameraState.nodes, shotOptions) : value]));
  const refmodInputs = resolveComfyRefmodMentionInputs({ prompt: expandedPrompt, workflowInputs: expandedInputs, manual: params.comfyRefmods });
  let rawPrompt = refmodInputs.prompt;
  const rawWorkflowPrompt = rawPrompt;
  if (isRunningHubWorkflow(useAppStore.getState().workflows.find((workflow) => workflow.id === params.workflowId))) {
    rawPrompt = splitRunningHubPrompt(rawWorkflowPrompt).prompt;
  }
  params = { ...params, prompt: rawPrompt,
    ...(expandedInputs ? { workflowInputs: refmodInputs.workflowInputs } : {}),
    ...(refmodInputs.comfyRefmods.length ? { comfyRefmods: refmodInputs.comfyRefmods } : {}),
  };
  if (`${rawPrompt}\n${JSON.stringify(params.workflowInputs ?? {})}`.includes('@drama{global/')) {
    const owner = useAppStore.getState();
    await owner.loadGlobalDramaAssets();
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (useAppStore.getState().currentProjectId !== owner.currentProjectId) throw new Error('项目已切换，请重新生成视频');
  }
  if (params.comfyRefmods?.length) {
    const captured = useAppStore.getState();
    const workflow = captured.workflows.find((item) => item.id === params.workflowId);
    if (!workflow || (workflow.adapterType && workflow.adapterType !== 'comfyui')) {
      throw new Error('RefMod 仅能用于本地 ComfyUI 工作流，请切换工作流或移除 RefMod');
    }
    if (params.comfyRefmods.some((ref) => ref.workflowId !== undefined && ref.workflowId !== workflow.id)) {
      throw new Error('ComfyUI 角色引用属于其他工作流，请删除后重新 @ 选择');
    }
    const capturedNodeId = params.nodeId;
    const capturedNode = captured.nodes.find((node) => node.id === capturedNodeId);
    const projectId = captured.currentProjectId;
    if (!capturedNode || capturedNode.type !== 'ai-video' || capturedNode.data.role === 'source' || !projectId
      || videoInputData(capturedNode, captured).workflowId !== params.workflowId) {
      throw new Error('ComfyUI 角色引用需要项目中的视频生成节点，请先选择本地视频工作流');
    }
    const revision = captured.getCurrentRevision();
    const fingerprint = videoInputFingerprint(capturedNode, captured);
    const previousBeforeSubmit = beforeSubmit;
    beforeSubmit = async () => {
      await previousBeforeSubmit?.();
      const current = useAppStore.getState();
      const node = current.nodes.find((item) => item.id === capturedNodeId);
      if (current.currentProjectId !== projectId || current.getCurrentRevision() !== revision || !node
        || node.type !== 'ai-video' || node.data.role === 'source'
        || videoInputFingerprint(node, current) !== fingerprint) {
        throw new Error('项目、视频节点或角色引用已变化，请重新生成');
      }
    };
  }
  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = await resolveNodeReferencesAsync(rawPrompt);

  // ComfyUI 工作流执行路径：连线音频兜底填充工作流的 audio IO 节点（唇形同步等）
  if (params.workflowId) {
    const workflow = useAppStore.getState().workflows.find((item) => item.id === params.workflowId);
    const runninghubWorkflow = isRunningHubWorkflow(workflow);
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? [], {
      promptFirst: !workflow?.adapterType || workflow.adapterType === 'comfyui',
      preserveDeclaredRoles: provider === 'workflow-api' || runninghubWorkflow, target: 'local',
      provider: runninghubWorkflow ? 'runninghub' : provider,
      legacyPrompt: workflow?.adapterType === 'workflow-api' || runninghubWorkflow ? undefined : prompt,
    });
    const references = referenceInput.references ?? [];
    const videoUrls = getMediaReferenceUrls(references, 'video', 'local');
    if (workflow?.adapterType === 'workflow-api') {
      const outputs = await executeWorkflowApi({ workflowId: params.workflowId, nodeId: params.nodeId, beforeSubmit,
        taskContext: params.workflowApiTaskContext, prompt: referenceInput.prompt, inputs: {
          ...parseWorkflowApiFields(params.workflowInputs, workflow.workflowApi),
          ...(workflow.workflowApi?.version === 2 || params.seedanceDuration === undefined ? {} : { duration: params.seedanceDuration }),
          ...(workflow.workflowApi?.version === 2 || params.seedanceResolution === undefined ? {} : { resolution: params.seedanceResolution }),
          ...(workflow.workflowApi?.version === 2 || params.seedanceRatio === undefined ? {} : { ratio: params.seedanceRatio }),
        }, references: {
          image: getMediaReferenceUrls(references, 'image', 'local'), video: videoUrls,
          audio: getMediaReferenceUrls(references, 'audio', 'local'),
        } }, signal);
      const projectId = params.workflowApiTaskContext?.projectId ?? useAppStore.getState().currentProjectId;
      const trackingId = params.nodeId ?? `workflow-api-message-${params.workflowApiTaskContext?.messageId}`;
      const task = projectId ? getPendingTasksForProject(projectId).find((item) => item.nodeId === trackingId && item.taskType === 'workflow-api') : undefined;
      return { url: outputs[0].url, workflowApiOutputs: outputs, workflowApiTaskId: task?.taskId };
    }
    if (provider === 'workflow-api' || (workflow?.adapterType && !['comfyui', 'runninghub'].includes(workflow.adapterType))) throw new Error('工作流定义缺失或执行类型不支持');
    if (isRunningHubWorkflow(workflow)) {
      const outputs = await executeRunningHubWorkflow({ ...params, workflowId: params.workflowId, rawWorkflowPrompt, beforeSubmit, prompt: referenceInput.prompt, kind: 'video', references: {
        image: getMediaReferenceUrls(references, 'image', 'local'), video: videoUrls, audio: getMediaReferenceUrls(references, 'audio', 'local'),
      } }, signal);
      return { url: outputs[0].url, runninghubOutputs: outputs };
    }
    const comfyArgs = [
      { ...params, prompt: referenceInput.prompt },
      signal,
      getMediaReferenceUrls(references, 'audio', 'local'),
      {
        imageUrls: getMediaReferenceUrls(references, 'image', 'local'),
        videoUrls,
      },
    ] as const;
    return beforeSubmit
      ? executeComfyUIVideoGenerate(...comfyArgs, beforeSubmit)
      : executeComfyUIVideoGenerate(...comfyArgs);
  }

  if (provider === 'workflow-api') throw new Error('请先配置并选择工作流 API');
  const registeredAdapter = mediaProviderRegistry.getVideoAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateVideo({
      params,
      prompt,
      resolveReferenceInput: async () => {
        return resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? [], {
          target: provider === 'runninghub' ? 'local' : 'remote',
          preserveDeclaredRoles: provider === 'runninghub',
          provider,
          apimartModel: provider === 'apimart' ? extractModelName(model, provider) : undefined,
        });
      },
      signal,
      beforeSubmit,
    });
  }

  // 即梦视频：按参考素材自动路由文生、图生、首尾帧或全模态 CLI 子命令
  if (provider === 'dreamina') {
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? [], { provider });
    const dreaminaPrompt = referenceInput.prompt;
    if (!dreaminaPrompt.trim()) throw new Error('提示词不能为空');
    const capability = getDreaminaVideoCapability(model);
    assertVideoReferenceLimits(referenceInput, capability, '即梦当前视频模型');
    return generateDreaminaVideo({
      beforeSubmit,
      prompt: dreaminaPrompt,
      model,
      references: referenceInput.references ?? [],
      nodeId: params.nodeId,
      ratio: params.seedanceRatio,
      duration: params.seedanceDuration,
      resolution: params.seedanceResolution,
    }, signal);
  }

  // ── 火山方舟 Seedance 视频生成 ──
  if (provider === 'volcengine') {
    const config = useAppStore.getState().config;
    const providerConfig = config.providers.volcengine;
    const apiKey = providerConfig?.apiKey || '';
    if (!apiKey) {
      throw new Error('未配置 火山方舟 的 API Key\n请在「设置 → API Key」中配置');
    }
    const baseUrl = (providerConfig?.baseUrl || DEFAULT_BASE_URLS.volcengine || '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('未配置 火山方舟 的服务地址\n请在「设置 → API Key」中添加');
    }
    const modelName = extractModelName(model, provider);
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? [], { provider });
    const assetReferences = (referenceInput.references ?? []).filter((reference) => reference.provider === 'volcengine');
    const isSeedance25 = isVolcengineSeedance25Model(modelName);
    const capability = getVolcengineSeedanceCapability(modelName);
    if (assetReferences.length > 0 && !capability) {
      throw new Error('火山方舟虚拟人像库素材仅支持 Seedance 2.0 和 Seedance 2.5 模型');
    }
    const projectName = providerConfig?.assetLibrary?.projectName?.trim() || 'default';
    const invalidProjectReference = assetReferences.find((reference) => reference.projectName !== projectName);
    if (invalidProjectReference) {
      throw new Error(`方舟素材“${invalidProjectReference.assetId || '未知素材'}”属于项目 ${invalidProjectReference.projectName || '未知'}，当前连接项目为 ${projectName}`);
    }
    if (assetReferences.length > 0) {
      const library = providerConfig?.assetLibrary;
      if (!library?.enabled) throw new Error('请先在火山方舟编辑连接中启用虚拟人像库');
      const secretName = (value: string | undefined, fallback: string) => value?.startsWith('secret:') ? value.slice(7) : value || fallback;
      const [accessKeyId, secretAccessKey] = await Promise.all([
        readAppSecret(secretName(library.accessKeyIdRef, 'provider/volcengine/asset-library/access-key')),
        readAppSecret(secretName(library.secretAccessKeyRef, 'provider/volcengine/asset-library/secret-key')),
      ]);
      if (!accessKeyId || !secretAccessKey) throw new Error('请先保存虚拟人像库 AK/SK');
      const assetOptions = { accessKeyId, secretAccessKey, projectName, region: library.region || 'cn-beijing', baseUrl: library.apiBaseUrl, signal };
      for (const reference of assetReferences) {
        if (!reference.assetId) throw new Error('方舟虚拟人像素材缺少 Asset ID，请重新选择');
        const detail = await getAsset(assetOptions, reference.assetId);
        if (detail.status !== 'Active') throw new Error(`方舟素材“${detail.name || reference.assetId}”当前状态为 ${detail.status}，仅 Active 素材可用于生成`);
      }
    }
    if (capability) {
      assertVideoReferenceLimits(referenceInput, capability, '火山方舟当前视频模型');
    }
    if (!isSeedance25) {
      assertVideoOperationSupported(referenceInput, '火山方舟当前视频接口');
    }
    const resolvedPrompt = referenceInput.prompt;
    const requestReferences = (referenceInput.references ?? [])
      .filter((reference) => isSeedance25 || reference.kind !== 'video');
    if (!resolvedPrompt.trim() && requestReferences.length === 0) {
      throw new Error('提示词不能为空');
    }
    const preserveFrameRoles = hasManualFrameRoles([
      ...(params.referenceMedia ?? []),
      ...resolveVideoNodeReferences(params.nodeId),
    ]);
    const remoteReferences = await mapSequentially(requestReferences, async (reference) => {
      if (reference.provider === 'volcengine') {
        if (!reference.assetId || reference.url !== `asset://${reference.assetId}`) {
          throw new Error('方舟虚拟人像素材引用无效，请从素材库重新选择');
        }
        return reference;
      }
      const sourceUrl = getMediaReferenceUrl(reference);
      const url = reference.kind === 'image'
        ? (await resolveImageUrlArray([sourceUrl], 'volcengine', signal))[0]
        : await resolveMediaReferenceUrl(sourceUrl, {
          provider: 'volcengine',
          kind: reference.kind,
          mode: 'publicUrl',
          signal,
        });
      return { ...reference, url };
    }, signal);
    return generateVolcengineVideo(
      apiKey,
      baseUrl,
      modelName,
      resolvedPrompt,
      remoteReferences,
      preserveFrameRoles,
      params,
      signal,
      beforeSubmit,
    );
  }

  // ── 通用模型视频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    const connection = resolveGeneralModelConnection(model);
    if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
    if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    const catalogId = connection.definition?.id ?? resolveProviderCatalogId(connection.providerConfigId, connection.provider);
    const isToapis = catalogId === 'toapis';
    const isLibapi = catalogId === 'libapi';
    const usesRelayonProtocol = catalogId === 'relayonapi' && usesRelayonModelProtocol(gm.modelId, gm.executionProfile);
    const policy = getProviderPolicy(catalogId);
    const publicUrlProvider = policy.upload || (usesRelayonProtocol && policy.referenceTransport === 'public-url')
      ? connection.providerConfigId : undefined;
    const usesLibapiProtocol = isLibapi && usesLibapiModelProtocol(gm.modelId, gm.executionProfile);
    const configuredVideoCapability = gm.videoCapability
      ?? getModelProtocolPresetVideoCapability(gm.executionProfile);
    const videoCapability = catalogId === 'sora2u'
      ? withSora2uReferenceLimits(gm.modelId, configuredVideoCapability) : configuredVideoCapability;
    const referenceInput = await resolveVideoReferenceInput(
      rawPrompt,
      params.nodeId,
      params.referenceMedia ?? [],
      { preserveDeclaredRoles: true, sortKeyframes: usesLibapiProtocol, provider },
    );
    const canonicalParams = {
      ...params,
      model: gm.modelId,
      prompt: referenceInput.prompt,
    };
    const originalReferences = referenceInput.references ?? referencesFromLegacyInput(referenceInput);
    // 所有能力和组合错误都必须在素材上传或付费提交前失败。
    const preflight = resolveCanonicalVideoRequest(canonicalParams, {
      references: originalReferences,
      capability: videoCapability,
    });
    if (isToapis) assertToapisVideoInput(preflight);
    if (usesLibapiProtocol) assertLibapiVideoInput(preflight);
    if (usesRelayonProtocol) {
      // 先检查素材角色与组合，避免上传完成后才发现内置合同接不住首尾帧。
      relayonVideoVariables(gm.modelId, buildCanonicalVideoProtocolVariables(preflight));
    }
    if (resolveModelExecutionProfile(gm.executionProfile)) {
      const dataUrlBudget = createMediaDataUrlBudget('本次视频模型参考媒体');
      const remoteImageUrls = await resolveImageUrlsSequentially(
        referenceInput.imageUrls,
        connection.providerConfigId,
        signal,
      );
      const videoUrls = await resolveGeneralProtocolMediaUrls(
        originalReferences, 'video', dataUrlBudget, signal, publicUrlProvider,
      );
      const audioUrls = await resolveGeneralProtocolMediaUrls(
        originalReferences, 'audio', dataUrlBudget, signal, publicUrlProvider,
      );
      const remoteReferences = replaceReferenceUrls(originalReferences, {
        image: remoteImageUrls,
        video: videoUrls,
        audio: audioUrls,
      });
      if (usesRelayonProtocol && remoteReferences.some((reference) => !/^https:\/\//i.test(reference.url))) {
        throw new Error('RelayOnAPI 视频 JSON 参考素材必须是可访问的 HTTPS 地址，请检查素材链接或公共上传结果');
      }
      const canonicalRequest = resolveCanonicalVideoRequest(canonicalParams, {
        references: remoteReferences,
        capability: videoCapability,
      });
      const compatibility = toResolvedVideoCompatibilityValues(canonicalRequest);
      const resolvedReferenceInput = {
        prompt: canonicalRequest.prompt,
        operation: canonicalRequest.operation,
        references: remoteReferences,
        imageUrls: compatibility.imageUrls,
        videoUrls: compatibility.videoUrls,
        audioUrls: compatibility.audioUrls,
      };
      await assertVideoInputConstraints(
        resolvedReferenceInput,
        videoCapability,
        gm.name,
        { signal },
      );
      if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
      if (beforeSubmit) await beforeSubmit();
      if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
      const urls = await runConfiguredModelProtocol({
        model: gm,
        category: 'video',
        nodeId: params.nodeId,
        signal,
        variables: isToapis ? toapisVideoVariables(canonicalRequest, buildCanonicalVideoProtocolVariables(canonicalRequest))
          : usesLibapiProtocol ? libapiVideoVariables(canonicalRequest, buildCanonicalVideoProtocolVariables(canonicalRequest))
            : usesRelayonProtocol ? relayonVideoVariables(gm.modelId, buildCanonicalVideoProtocolVariables(canonicalRequest))
            : buildCanonicalVideoProtocolVariables(canonicalRequest),
      });
      const url = urls[0];
      if (!url) throw new Error('视频生成完成但未返回结果');
      return { url, ...(urls.taskReceipt ? { taskReceipt: urls.taskReceipt } : {}),
        ...(urls.mediaDownloadAccess ? { mediaDownloadAccess: urls.mediaDownloadAccess } : {}) };
    }
    const connectionName = connection.provider.name.trim() || connection.providerConfigId;
    const preset = gm.executionProfile?.preset;
    const textPreset = preset === 'anthropic-chat'
      ? 'Anthropic Messages'
      : preset === 'gemini-chat' ? 'Google Gemini generateContent' : undefined;
    const reason = textPreset
      ? `“协议预设”误选为文本对话协议“${textPreset}”，不能用于视频生成。`
      : '尚未配置“模型调用协议”；仅添加模型或填写参数能力不会生成调用协议。';
    throw new Error([
      textPreset ? '视频生成已拦截：调用协议类型不适用。' : '视频生成已拦截：模型调用协议未配置。',
      `连接：${connectionName}`,
      `模型：${gm.name}（模型 ID：${gm.modelId}）`,
      `原因：${reason}`,
      `修改位置：设置 → API Key → 编辑“${connectionName}” → 启用模型 → 此模型右侧“调用协议”（滑杆图标）。`,
      '处理：选择“高级自定义 JSON”，按渠道文档配置提交请求和结果解析；异步接口还需配置任务 ID 与轮询。也可在“视频参数能力”中应用匹配渠道的模板。',
      '最后点击“保存更改”，再重试生成。本次尚未提交视频生成请求。',
    ].join('\n'));
  }

  // 无 workflowId 时暂不支持直接调用 API，提示配置
  throw new Error('视频生成需要选择 ComfyUI 工作流\n请在模型选择器中导入并选择工作流');
}

/** 火山方舟 Seedance 视频生成 — 异步提交 + 轮询 */
async function generateVolcengineVideo(
  apiKey: string,
  baseUrl: string,
  modelName: string,
  prompt: string,
  references: readonly MediaReference[],
  preserveFrameRoles: boolean,
  params: AIVideoGenParams,
  externalSignal?: AbortSignal,
  beforeSubmit?: () => void | Promise<void>,
): Promise<{ url: string; taskReceipt?: MediaTaskReceipt }> {
  const nodeId = params.nodeId;
  let billingRun: Awaited<ReturnType<typeof createBillingRun>> = null;
  let receipt: MediaTaskReceipt | undefined;
  let requestSent = false;
  let remoteFailed = false;
  let remoteCancelled = false;
  const nodeSignal = nodeId ? registerNodePolling(nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  try {
    // 预存待续任务
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        receipt = savePendingTask({
          nodeId,
          projectId,
          nodeType: 'ai-video',
          provider: 'volcengine',
          providerConfigId: 'volcengine',
          taskId: '',
          taskType: 'volcengine',
          submitted: false,
        });
      }
    }

    const requestBody = buildVolcengineVideoRequestBody(
      modelName,
      prompt,
      references,
      preserveFrameRoles,
      params,
    );
    const durationSeconds = Number(requestBody.duration ?? -1);
    const resolution = String(requestBody.resolution ?? '720p');
    const ratio = String(requestBody.ratio ?? '16:9');
    const hasInputVideo = references.some((item) => item.kind === 'video');
    const quote = quoteVolcengineVideo({
      modelId: modelName, durationSeconds, resolution, ratio,
      fps: params.videoFps, inputVideoSeconds: hasInputVideo ? 1 : undefined,
    });
    billingRun = await createBillingRun({
      nodeId, modelType: 'video', modelId: modelName, prompt,
      details: {
        referenceType: hasInputVideo ? 'video-reference'
          : references.some((item) => item.role === 'first_frame' || item.role === 'last_frame') ? 'frame-reference'
            : references.length ? 'multimodal-reference' : 'text-to-video',
        referenceCount: references.length,
        durationSeconds, resolution, ratio, fps: params.videoFps ?? null,
      }, quote,
    });

    // 提交任务
    const apiUrl = `${baseUrl}/contents/generations/tasks`;
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    if (beforeSubmit) await beforeSubmit();
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    requestSent = true;
    const submitResp = await corsSafeFetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!submitResp.ok) {
      remoteFailed = submitResp.status < 500 && ![408, 429].includes(submitResp.status);
      const errBody = await submitResp.text().catch(() => '');
      let errorMsg = `提交失败 (${submitResp.status})`;
      try {
        const err = JSON.parse(errBody);
        errorMsg = err.error?.message || errorMsg;
      } catch {
        if (errBody) errorMsg += `: ${errBody.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const submitResult = await submitResp.json() as { id?: string };
    const taskId = submitResult.id;
    if (!taskId) {
      throw new Error('火山方舟视频生成提交失败: 未返回任务 ID');
    }

    // 回填 taskId
    if (nodeId) {
      receipt = updatePendingTask(nodeId, { taskId, submitted: true }, receipt?.taskId, receipt?.attemptId) ?? receipt;
    }
    billingRun = await updateBillingRun(billingRun, { status: 'running', taskId });

    // 轮询
    const completed = await pollVolcengineVideoTask({
      apiKey, baseUrl, taskId, signal, maxDuration: VIDEO_POLL_MAX_DURATION_MS,
      onFailed: (status) => {
        remoteFailed = true;
        remoteCancelled = status === 'cancelled';
      },
    });

    const measured = completed.completionTokens === undefined ? null : quoteVolcengineVideo({
      modelId: modelName, durationSeconds, resolution, ratio,
      inputVideoSeconds: hasInputVideo ? 1 : undefined,
      completionTokens: completed.completionTokens,
    }).amountMicros;
    billingRun = await updateBillingRun(billingRun, {
      status: 'succeeded', finishedAt: Date.now(), calculatedMicros: measured,
      amountConfidence: measured === null ? 'unknown' : 'usage',
      inputJson: JSON.stringify({ ...JSON.parse(billingRun?.inputJson || '{}'), completionTokens: completed.completionTokens ?? null }),
    });
    if (receipt) receipt = updatePendingTask(receipt.nodeId, { mediaRecoveryState: 'delivery_pending' }, receipt.taskId, receipt.attemptId) ?? receipt;
    return { url: completed.url, ...(receipt ? { taskReceipt: receipt } : {}) };

  } catch (error) {
    await updateBillingRun(billingRun, {
      status: remoteCancelled ? 'cancelled' : remoteFailed || !requestSent ? 'failed' : 'unknown', finishedAt: Date.now(),
      calculatedMicros: remoteFailed || !requestSent ? 0 : null,
      amountConfidence: remoteFailed || !requestSent ? 'calculated' : 'unknown',
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : '视频请求失败',
    });
    if (receipt) {
      if (remoteFailed || !requestSent) {
        removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
      } else {
        const paused = pauseMediaTask(receipt, error, receipt.taskId ? undefined : 'submit_unknown');
        if (paused) throw paused;
      }
    }
    throw error;
  } finally {
    if (nodeId) cleanupNodePolling(nodeId, nodeSignal);
  }
}

export function buildVolcengineVideoContent(
  prompt: string,
  references: readonly MediaReference[],
  preserveFrameRoles: boolean,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (prompt.trim()) {
    content.push({ type: 'text', text: prompt.trim() });
  }
  references.forEach((reference) => {
    if (reference.kind === 'image') {
      const frameRole = preserveFrameRoles
        && (reference.role === 'first_frame' || reference.role === 'last_frame')
        ? reference.role
        : undefined;
      content.push({
        type: 'image_url',
        image_url: { url: reference.url },
        role: frameRole ?? 'reference_image',
      });
      return;
    }
    if (reference.kind === 'video') {
      content.push({
        type: 'video_url',
        video_url: { url: reference.url },
        role: 'reference_video',
      });
      return;
    }
    content.push({
      type: 'audio_url',
      audio_url: { url: reference.url },
      role: 'reference_audio',
    });
  });
  return content;
}

type VolcengineVideoRequestParams = Pick<
  AIVideoGenParams,
  'seedanceResolution' | 'seedanceRatio' | 'seedanceDuration' | 'generateAudio'
>;

export function buildVolcengineVideoRequestBody(
  modelName: string,
  prompt: string,
  references: readonly MediaReference[],
  preserveFrameRoles: boolean,
  params: VolcengineVideoRequestParams,
): Record<string, unknown> {
  const isSeedance25 = isVolcengineSeedance25Model(modelName);
  const capability = getVolcengineSeedanceCapability(modelName);
  const hasFrame = preserveFrameRoles && references.some((reference) => (
    reference.kind === 'image'
    && (reference.role === 'first_frame' || reference.role === 'last_frame')
  ));
  const hasReferenceVideo = references.some((reference) => reference.kind === 'video');
  const hasOmniReference = references.some((reference) => (
    reference.kind !== 'image'
    || !preserveFrameRoles
    || (reference.role !== 'first_frame' && reference.role !== 'last_frame')
  ));

  const ratio = isSeedance25 && (hasFrame || hasReferenceVideo)
    ? 'adaptive'
    : params.seedanceRatio || capability?.defaultRatio || '16:9';
  const duration = isSeedance25 && hasReferenceVideo
    ? capability?.automaticDurationValue ?? -1
    : params.seedanceDuration
      ?? capability?.defaultDuration
      ?? capability?.automaticDurationValue
      ?? 5;
  const resolution = params.seedanceResolution || capability?.defaultResolution || '720p';
  const requestBody = mapVideoParameters('volcengine', modelName, {
    model: modelName,
    aspectRatio: ratio,
    duration,
    resolution,
  });
  requestBody.content = buildVolcengineVideoContent(prompt, references, preserveFrameRoles);
  requestBody.watermark = false;
  if (params.generateAudio) {
    requestBody.generate_audio = true;
  }
  if (isSeedance25 && hasOmniReference) {
    requestBody.omni_reference_task_type = 'auto';
  }
  return requestBody;
}
