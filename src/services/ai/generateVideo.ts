/**
 * ai/generateVideo — 视频生成入口
 */
import { isRemoteMediaUrl } from '../../utils/mediaUrl';
import { useAppStore } from '../../store/useAppStore';
import { isRunningHubWorkflow } from '../workflowExecutionService';
import { executeRunningHubWorkflow } from './providers/runninghubWorkflow';
import { executeWorkflowApi } from '../workflowApi/workflowApiAdapter';
import { parseWorkflowApiFields } from '../workflowApi/workflowApiConfig';
import { getPendingTasksForProject } from '../pollManager';
import { DEFAULT_BASE_URLS } from '../../constants/api';
import { resolveNodeReferences } from '../nodeReferenceService';
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
} from '../../types/aiTypes';
import { extractModelName, resolveGeneralModel, resolveGeneralModelConnection } from './helpers';
import { resolvePromptWithMediaRefs, type PromptCharacterBinding, type PromptMediaReferences } from './promptResolver';
import {
  collectConnectedReferenceMedia,
  getMediaReferenceUrl,
  getMediaReferenceUrls,
  mergeMediaReferences,
  warnIfTooManyReferences,
} from './connectedReferenceMedia';
import { getApimartSeedanceCapability, type ApimartSeedanceCapability } from './apimartVideoModels';
import { pollTask } from '../pollTask';
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
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling } from '../pollManager';
import { corsSafeFetch } from './httpTransport';
import { resolveImageUrlArray } from './imageUtils';
import { resolveMediaReferenceUrl } from '../uploadService';
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

async function mapSequentially<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
    results.push(await mapper(items[index], index));
  }
  return results;
}

function resolveImageUrlsSequentially(
  urls: readonly string[],
  provider: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return mapSequentially(
    urls,
    async (url) => (await resolveImageUrlArray([url], provider, signal))[0],
    signal,
  );
}

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

const CHARACTER_REFERENCE_USAGE: Record<PromptCharacterBinding['usage'], string> = {
  appearance: '外观参考', action: '动作参考', timbre: '音色参考',
  line: '台词参考', emotion: '情绪参考', other: '声音参考',
};

/** 只编译 @ 产生的位置；角色归属独立于媒体去重，以最终传参顺序为准。 */
export function compileVideoReferencePrompt(
  input: PromptMediaReferences,
  references: readonly MediaReference[],
  options: { target?: 'remote' | 'local'; imageLayout?: 'frames-first' | 'frame-fields' } = {},
): string {
  if (!input.segments) return input.prompt;
  const urlOf = (reference: MediaReference) => options.target === 'local'
    ? reference.url.trim() : getMediaReferenceUrl(reference).trim();
  const frame = (reference: MediaReference) => reference.kind === 'image'
    && (reference.role === 'first_frame' || reference.role === 'last_frame');
  const ordered = options.imageLayout === 'frames-first'
    ? [...references.filter(frame), ...references.filter((reference) => !frame(reference))]
    : options.imageLayout === 'frame-fields' ? references.filter((reference) => !frame(reference)) : references;
  const urls = (kind: MediaReference['kind']) => [...new Set(ordered.filter((reference) => reference.kind === kind).map(urlOf))];
  const indexes = { image: urls('image'), video: urls('video'), audio: urls('audio') };
  const characters = new Map<string, { alias: string; name: string; usages: Map<string, Set<string>> }>();
  const prompt = input.segments.map((segment) => {
    if (typeof segment === 'string') return segment;
    const source = segment.reference;
    // 先用本地媒体身份找到去重后的条目，再使用该条目最终选定的远端或本地 URL。
    const reference = references.find((candidate) => candidate.kind === source.kind && candidate.url.trim() === source.url.trim())
      ?? references.find((candidate) => candidate.kind === source.kind && urlOf(candidate) === urlOf(source));
    if (!reference) throw new Error('引用素材未进入视频请求，请重新选择素材');
    const index = indexes[reference.kind].indexOf(urlOf(reference));
    const label = options.imageLayout === 'frame-fields' && frame(reference)
      ? reference.role === 'first_frame' ? '首帧图片' : '尾帧图片'
      : index >= 0 ? `${reference.kind === 'image' ? '图片' : reference.kind === 'video' ? '视频' : '音频'}${index + 1}` : undefined;
    if (!label) throw new Error('引用素材编号与视频参数不一致');
    if (!segment.character) return label;
    const binding = segment.character;
    let character = characters.get(binding.id);
    if (!character) {
      character = {
        alias: `角色${characters.size + 1}`,
        name: binding.name.replace(/[\r\n\t]+/g, ' ').trim() || '未命名角色',
        usages: new Map(),
      };
      characters.set(binding.id, character);
    }
    const usage = CHARACTER_REFERENCE_USAGE[binding.usage];
    const labels = character.usages.get(usage) ?? new Set<string>();
    labels.add(label);
    character.usages.set(usage, labels);
    return `${character.name}〔${character.alias}，${label}〕`;
  }).join('').trim();
  if (characters.size === 0) return prompt;
  const notes = [...characters.values()].map((character) => {
    const usages = [...character.usages].map(([usage, labels]) => `${usage}：${[...labels].join('、')}`);
    return `- ${character.alias}「${character.name}」：${usages.join('；')}。`;
  });
  const hasVoice = [...characters.values()].some((character) =>
    [...character.usages.keys()].some((usage) => ['音色参考', '台词参考', '情绪参考', '声音参考'].includes(usage)),
  );
  return `${prompt}\n\n角色参考对应：\n${notes.join('\n')}\n各角色的外观、动作和声音按以上对应关系使用，避免互换。`
    + (hasVoice ? '\n音色和情绪样本中的台词不自动作为本次对白；对白内容以正文的明确要求为准。' : '');
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
): Promise<string[]> {
  return mapSequentially(references.filter((reference) => reference.kind === kind), async (reference) => {
    const url = getMediaReferenceUrl(reference);
    // 通用协议模型需要 data URL（base64）；公网 / data: 原样返回
    return resolveMediaReferenceUrl(url, {
      mode: 'dataUrl', kind, signal, dataUrlBudget: budget,
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
  options: { promptFirst?: boolean; preserveDeclaredRoles?: boolean; target?: 'remote' | 'local'; apimartModel?: string; legacyPrompt?: string; provider?: string } = {},
): Promise<VideoGenerationReferenceInput> {
  const promptInput = await resolvePromptWithMediaRefs(rawPrompt, { preserveBindings: true });
  const connected = collectConnectedReferenceMedia(nodeId);
  const nodeItems = resolveVideoNodeReferences(nodeId);
  const regularReferences = mergeMediaReferences(
    // 节点上手动挑的参考帧/参考角色排在连线与提示词引用之前，重复的图按它们的角色去重
    mergeMediaReferences(explicitReferences, toMediaReferences(nodeItems, options.provider)),
    mergeMediaReferences(promptInput.references, connected.references),
  );
  const collectedReferences = options.promptFirst
    ? mergeMediaReferences(promptInput.references, regularReferences) : regularReferences;
  // 普通 reference 图片不能被偷偷改成 first_frame；内置 Provider 也只接受用户
  // 明确指定的首/尾帧角色，连线与 @ 图片默认保持普通参考语义。
  const references = options.preserveDeclaredRoles || options.promptFirst
    ? collectedReferences.map((reference) => reference.kind === 'audio'
      ? { ...reference, role: 'reference_audio' as const }
      : reference)
    : assignVideoReferenceRoles(collectedReferences);
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
  warnIfTooManyReferences({
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
): Promise<{ url: string; runninghubOutputs?: import('../../types/runninghub').RunningHubOutput[];
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
  const { prompt: rawPrompt, model, provider } = params;
  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);

  // ComfyUI 工作流执行路径：连线音频兜底填充工作流的 audio IO 节点（唇形同步等）
  if (params.workflowId) {
    const workflow = useAppStore.getState().workflows.find((item) => item.id === params.workflowId);
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? [], {
      promptFirst: !workflow?.adapterType || workflow.adapterType === 'comfyui',
      preserveDeclaredRoles: provider === 'workflow-api', target: 'local',
      provider,
      legacyPrompt: workflow?.adapterType === 'workflow-api' ? undefined : prompt,
    });
    const references = referenceInput.references ?? [];
    const videoUrls = getMediaReferenceUrls(references, 'video', 'local');
    if (workflow?.adapterType === 'workflow-api') {
      const outputs = await executeWorkflowApi({ workflowId: params.workflowId, nodeId: params.nodeId,
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
      const outputs = await executeRunningHubWorkflow({ ...params, workflowId: params.workflowId, prompt: referenceInput.prompt, kind: 'video', references: {
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
          provider,
          apimartModel: provider === 'apimart' ? extractModelName(model, provider) : undefined,
        });
      },
      signal,
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
    const videoCapability = gm.videoCapability
      ?? getModelProtocolPresetVideoCapability(gm.executionProfile);
    const referenceInput = await resolveVideoReferenceInput(
      rawPrompt,
      params.nodeId,
      params.referenceMedia ?? [],
      { preserveDeclaredRoles: true, provider },
    );
    const canonicalParams = {
      ...params,
      model: gm.modelId,
      prompt: referenceInput.prompt,
    };
    const originalReferences = referenceInput.references ?? referencesFromLegacyInput(referenceInput);
    // 所有能力和组合错误都必须在素材上传或付费提交前失败。
    resolveCanonicalVideoRequest(canonicalParams, {
      references: originalReferences,
      capability: videoCapability,
    });
    if (resolveModelExecutionProfile(gm.executionProfile)) {
      const dataUrlBudget = createMediaDataUrlBudget('本次视频模型参考媒体');
      const remoteImageUrls = await resolveImageUrlsSequentially(
        referenceInput.imageUrls,
        connection.providerConfigId,
        signal,
      );
      const videoUrls = await resolveGeneralProtocolMediaUrls(
        originalReferences, 'video', dataUrlBudget, signal,
      );
      const audioUrls = await resolveGeneralProtocolMediaUrls(
        originalReferences, 'audio', dataUrlBudget, signal,
      );
      const remoteReferences = replaceReferenceUrls(originalReferences, {
        image: remoteImageUrls,
        video: videoUrls,
        audio: audioUrls,
      });
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
        variables: buildCanonicalVideoProtocolVariables(canonicalRequest),
      });
      const url = urls[0];
      if (!url) throw new Error('视频生成完成但未返回结果');
      return { url };
    }
    throw new Error(
      `视频模型“${gm.name}”未配置可执行的提交/轮询协议，请在自定义 API 设置中重新导入并确认接口文档。`
      + '系统不会再猜测 /videos/generations 等通用视频端点。',
    );
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
): Promise<{ url: string }> {
  const nodeId = params.nodeId;
  let billingRun: Awaited<ReturnType<typeof createBillingRun>> = null;
  let submittedTaskId: string | undefined;
  let requestSent = false;
  let remoteFailed = false;
  let remoteCancelled = false;
  let keepPending = false;
  const nodeSignal = nodeId ? registerNodePolling(nodeId) : undefined;
  const signal = nodeSignal && externalSignal
    ? AbortSignal.any([nodeSignal, externalSignal])
    : nodeSignal ?? externalSignal;

  try {
    // 预存待续任务
    if (nodeId) {
      const projectId = useAppStore.getState().currentProjectId;
      if (projectId) {
        savePendingTask({
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
      remoteFailed = true;
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
    submittedTaskId = taskId;
    billingRun = await updateBillingRun(billingRun, { status: 'running', taskId });

    // 回填 taskId
    if (nodeId) {
      updatePendingTask(nodeId, { taskId, submitted: true });
    }

    // 轮询
    const completed = await pollTask<Record<string, unknown>, { url: string; completionTokens?: number }>({
      fetchState: async () => {
        const pollResp = await corsSafeFetch(`${baseUrl}/contents/generations/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!pollResp.ok) throw new Error(`HTTP ${pollResp.status}`);
        return (await pollResp.json()) as Record<string, unknown>;
      },
      isComplete: (raw) => {
        const status = raw.status as string;
        if (status === 'succeeded') {
          const c = raw.content as Record<string, unknown> | undefined;
          const videoUrl = c?.video_url as string | undefined;
          const usage = raw.usage as Record<string, unknown> | undefined;
          if (videoUrl) return { url: videoUrl, completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined };
          throw new Error('任务完成但未返回视频地址');
        }
        return null;
      },
      isFailed: (raw) => {
        const status = raw.status as string;
        if (status === 'failed' || status === 'cancelled') {
          remoteFailed = true;
          remoteCancelled = status === 'cancelled';
          const err = raw.error as { message?: string } | undefined;
          return `任务失败: ${err?.message || status}`;
        }
        return null;
      },
      interval: 3000,
      signal,
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
    return { url: completed.url };

  } catch (error) {
    await updateBillingRun(billingRun, {
      status: remoteCancelled ? 'cancelled' : remoteFailed || !requestSent ? 'failed' : 'unknown', finishedAt: Date.now(),
      calculatedMicros: remoteFailed || !requestSent ? 0 : null,
      amountConfidence: remoteFailed || !requestSent ? 'calculated' : 'unknown',
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : '视频请求失败',
    });
    keepPending = Boolean(submittedTaskId && !remoteFailed);
    throw error;
  } finally {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      if (!keepPending) removePendingTask(nodeId);
    }
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
