/**
 * ai/generateVideo — 视频生成入口
 */
import { useAppStore } from '../../store/useAppStore';
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
import { resolvePromptWithMediaRefs } from './promptResolver';
import {
  collectConnectedReferenceMedia,
  getMediaReferenceUrl,
  getMediaReferenceUrls,
  mergeMediaReferences,
  warnIfTooManyReferences,
} from './connectedReferenceMedia';
import { executeGeneralAsyncTask } from './apimartGen';
import type { ApimartSeedanceCapability } from './apimartVideoModels';
import { pollTask } from '../pollTask';
import { runConfiguredModelProtocol } from './modelProtocolRuntime';
import { normalizeFrames8n1, type ModelProtocolVariables } from './modelProtocol';
import { mediaProviderRegistry } from './mediaProviderRegistry';
import {
  mapVideoDimensions,
  normalizeVideoFps,
  resolveVideoDurationSeconds,
  videoFramesFromDuration,
} from '../aiDimensions';
import { savePendingTask, updatePendingTask, removePendingTask, registerNodePolling, cleanupNodePolling } from '../pollManager';
import { corsSafeFetch } from './httpTransport';
import { resolveImageUrlArray } from './imageUtils';
import { resolveMediaReferenceUrl } from '../uploadService';
import { mapVideoParameters } from './videoParameterMappings';
import {
  getVolcengineSeedanceCapability,
  isVolcengineSeedance25Model,
} from './volcengineVideoModels';
import { getDreaminaVideoCapability } from './dreaminaModels';
import { assertVideoInputConstraints } from './videoInputValidation';

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

function toMediaReferences(items: readonly VideoReferenceItem[]): MediaReference[] {
  return items.map((item) => ({
    kind: 'image' as const,
    url: item.url,
    origin: 'connection' as const,
    role: item.role,
    sourceNodeId: item.sourceNodeId,
  }));
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

function assignVideoReferenceRoles(references: readonly MediaReference[]): MediaReference[] {
  // 手动挑过参考帧：保留指派，其余降为普通参考图，并按 首帧 → 中间 → 尾帧 重排
  // （APIMart / 即梦 / 通用协议都只看图片顺序判断首尾帧）
  if (hasManualFrameRoles(references)) {
    const rank = (role: MediaReferenceRole) => (role === 'first_frame' ? 0 : role === 'last_frame' ? 2 : 1);
    return references
      .map((reference) => ({
        ...reference,
        role: reference.kind === 'audio' ? ('reference_audio' as const) : reference.role,
      }))
      .sort((a, b) => rank(a.role) - rank(b.role));
  }
  const imageIndexes = references.flatMap((reference, index) => (
    reference.kind === 'image' ? [index] : []
  ));
  const firstImageIndex = imageIndexes[0];
  const lastImageIndex = imageIndexes.length > 1 ? imageIndexes[imageIndexes.length - 1] : undefined;
  return references.map((reference, index) => {
    if (reference.kind === 'audio') return { ...reference, role: 'reference_audio' };
    if (index === firstImageIndex) return { ...reference, role: 'first_frame' };
    if (index === lastImageIndex) return { ...reference, role: 'last_frame' };
    return { ...reference, role: 'reference' };
  });
}

async function resolveGeneralProtocolMediaUrls(
  references: readonly MediaReference[],
  kind: 'video' | 'audio',
): Promise<string[]> {
  return Promise.all(references.filter((reference) => reference.kind === kind).map(async (reference) => {
    const url = getMediaReferenceUrl(reference);
    // 通用协议模型需要 data URL（base64）；公网 / data: 原样返回
    return resolveMediaReferenceUrl(url, { mode: 'dataUrl', kind });
  }));
}

async function resolveVideoReferenceInput(
  rawPrompt: string,
  nodeId: string | undefined,
  /** 调用方直接给定的参考媒体；排在最前，保证首/尾帧角色按调用方的顺序分配 */
  explicitReferences: readonly MediaReference[] = [],
): Promise<VideoGenerationReferenceInput> {
  const promptInput = await resolvePromptWithMediaRefs(rawPrompt);
  const connected = collectConnectedReferenceMedia(nodeId);
  const nodeItems = resolveVideoNodeReferences(nodeId);
  const references = assignVideoReferenceRoles(
    mergeMediaReferences(
      // 节点上手动挑的参考帧/参考角色排在连线与提示词引用之前，重复的图按它们的角色去重
      mergeMediaReferences(explicitReferences, toMediaReferences(nodeItems)),
      mergeMediaReferences(promptInput.references, connected.references),
    ),
  );
  const imageUrls = getMediaReferenceUrls(references, 'image');
  const videoUrls = getMediaReferenceUrls(references, 'video');
  const audioUrls = getMediaReferenceUrls(references, 'audio');
  warnIfTooManyReferences({
    image: imageUrls.length,
    video: videoUrls.length,
    audio: audioUrls.length,
  });
  return {
    prompt: annotateCharacterReferences(promptInput.prompt, nodeItems, imageUrls),
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

export function buildGeneralVideoProtocolVariables(
  modelId: string,
  params: AIVideoGenParams,
  referenceInput: VideoGenerationReferenceInput,
  videoCapability?: VideoModelCapability,
): ModelProtocolVariables {
  const videoResolution = params.videoResolution ?? 1152;
  const aspectRatio = params.seedanceRatio ?? '16:9';
  const { width, height } = mapVideoDimensions(videoResolution, aspectRatio);
  const fps = normalizeVideoFps(params.videoFps);
  // 通用模型声明了时长上限时按声明钳制，否则沿用全局兜底上限
  const requestedDuration = resolveVideoDurationSeconds(
    params.seedanceDuration,
    params.videoFrames,
    fps,
    videoCapability?.maxDuration,
  );
  // 声明了离散时长（如仅 10 / 15 秒）时吸附到最接近的合法档，
  // 否则画布上的 4 秒会原样发出去换来一句 seconds must be one of 10, 15
  const allowedDurations = videoCapability?.durations?.length ? videoCapability.durations : undefined;
  const duration = allowedDurations
    ? allowedDurations.reduce((best, value) => (
      Math.abs(value - requestedDuration) < Math.abs(best - requestedDuration) ? value : best
    ), allowedDurations[0])
    : requestedDuration;
  const frames = videoFramesFromDuration(duration, fps);
  const seedanceResolution = params.seedanceResolution ?? '720p';
  const firstImage = referenceInput.imageUrls[0];
  const lastImage = referenceInput.imageUrls.length > 1
    ? referenceInput.imageUrls[referenceInput.imageUrls.length - 1]
    : undefined;
  // 带角色的参考图数组（[{ url, role }]），供协议模板按 image_with_roles 语义引用：
  // 首/尾帧保留原角色，其余参考图按 Seedance 约定写 reference_image；
  // 为空时置 undefined，让模板省略该字段而不是发出空数组。
  const roleImages = (referenceInput.references ?? [])
    .filter((reference) => reference.kind === 'image')
    .map((reference) => ({
      url: getMediaReferenceUrl(reference),
      role: reference.role === 'first_frame' || reference.role === 'last_frame'
        ? reference.role
        : 'reference_image',
    }));
  const imageWithRoles = roleImages.length > 0 ? roleImages : undefined;
  const combinedReferences = [
    ...referenceInput.imageUrls,
    ...referenceInput.videoUrls,
    ...referenceInput.audioUrls,
  ];
  const referenceUrls = combinedReferences.filter((url) => /^https?:\/\//i.test(url));
  const inlineReferences = combinedReferences.filter((url) => url.startsWith('data:'));

  return {
    model: modelId,
    prompt: referenceInput.prompt,
    size: `${width}x${height}`,
    aspectRatio,
    width,
    height,
    frames,
    frames8n1: normalizeFrames8n1(frames),
    fps,
    duration,
    resolution: seedanceResolution,
    videoResolution,
    videoFrames: frames,
    videoFps: fps,
    seedanceResolution,
    seedanceRatio: aspectRatio,
    seedanceDuration: duration,
    generateAudio: params.generateAudio ?? true,
    disableAudio: params.generateAudio === false ? true : undefined,
    videoOperation: referenceInput.operation,
    imageUrls: referenceInput.imageUrls,
    firstImage,
    lastImage,
    imageWithRoles,
    referenceImageUrls: referenceInput.imageUrls,
    videoUrls: referenceInput.videoUrls,
    referenceVideoUrl: referenceInput.videoUrls[0],
    referenceVideoUrls: referenceInput.videoUrls,
    audioUrls: referenceInput.audioUrls,
    audioUrl: referenceInput.audioUrls[0],
    referenceAudioUrls: referenceInput.audioUrls,
    referenceUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
    inlineReferences: inlineReferences.length > 0 ? inlineReferences : undefined,
    n: 1,
    batchCount: 1,
  };
}

export async function generateVideo(
  params: AIVideoGenParams,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  const videoFps = normalizeVideoFps(params.videoFps);
  const seedanceDuration = resolveVideoDurationSeconds(
    params.seedanceDuration,
    params.videoFrames,
    videoFps,
  );
  params = {
    ...params,
    videoFps,
    seedanceDuration,
    videoFrames: videoFramesFromDuration(seedanceDuration, videoFps),
  };
  const { prompt: rawPrompt, model, provider } = params;

  // 解析 @{nodeId:label} 引用为对应节点的实际输出内容
  const prompt = resolveNodeReferences(rawPrompt);

  // ComfyUI 工作流执行路径：连线音频兜底填充工作流的 audio IO 节点（唇形同步等）
  if (params.workflowId) {
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? []);
    const references = referenceInput.references ?? [];
    const videoUrls = getMediaReferenceUrls(references, 'video', 'local');
    const workflow = useAppStore.getState().workflows.find((item) => item.id === params.workflowId);
    // 视频引用只有落到某个 video IO 节点才有意义：要么被 @ 了，要么工作流指定了默认视频节点
    const hasVideoTarget = Boolean(workflow?.defaultNodes?.video)
      || (workflow?.ioNodes ?? []).some((io) => io.type === 'video' && params.workflowInputs?.[io.nodeId]);
    if (videoUrls.length > 0 && !hasVideoTarget) {
      throw new Error('该 ComfyUI 工作流没有可接收视频的 IO 节点，请在工作流管理里指定默认视频节点或移除视频引用');
    }
    return executeComfyUIVideoGenerate(
      { ...params, prompt },
      signal,
      getMediaReferenceUrls(references, 'audio', 'local'),
      {
        imageUrls: getMediaReferenceUrls(references, 'image', 'local'),
        videoUrls,
      },
    );
  }

  const registeredAdapter = mediaProviderRegistry.getVideoAdapter(provider);
  if (registeredAdapter) {
    return registeredAdapter.generateVideo({
      params,
      prompt,
      resolveReferenceInput: async () => {
        return resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? []);
      },
      signal,
    });
  }

  // 即梦视频：按参考素材自动路由文生、图生、首尾帧或全模态 CLI 子命令
  if (provider === 'dreamina') {
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? []);
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
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? []);
    const isSeedance25 = isVolcengineSeedance25Model(modelName);
    const capability = getVolcengineSeedanceCapability(modelName);
    if (capability) {
      assertVideoReferenceLimits(referenceInput, capability, '火山方舟当前视频模型');
    }
    if (!isSeedance25) {
      assertVideoOperationSupported(referenceInput, '火山方舟当前视频接口');
    }
    const resolvedPrompt = referenceInput.prompt;
    const requestReferences = (referenceInput.references ?? [])
      .filter((reference) => isSeedance25 || reference.kind === 'image');
    if (!resolvedPrompt.trim() && requestReferences.length === 0) {
      throw new Error('提示词不能为空');
    }
    const preserveFrameRoles = hasManualFrameRoles([
      ...(params.referenceMedia ?? []),
      ...resolveVideoNodeReferences(params.nodeId),
    ]);
    const remoteReferences = await Promise.all(requestReferences.map(async (reference) => {
      const sourceUrl = getMediaReferenceUrl(reference);
      const url = reference.kind === 'image'
        ? (await resolveImageUrlArray([sourceUrl], 'volcengine'))[0]
        : await resolveMediaReferenceUrl(sourceUrl, {
          provider: 'volcengine',
          kind: reference.kind,
          mode: 'publicUrl',
        });
      return { ...reference, url };
    }));
    return generateVolcengineVideo(
      apiKey,
      baseUrl,
      modelName,
      resolvedPrompt,
      remoteReferences,
      preserveFrameRoles,
      params,
      signal,
    );
  }

  // ── 通用模型视频生成 ──
  if (provider === 'general') {
    const gm = resolveGeneralModel(model);
    if (!gm) throw new Error('未找到该通用模型配置\n请在「设置 → API Key」中检查');
    const connection = resolveGeneralModelConnection(model);
    if (!connection) throw new Error(`通用模型 "${gm.name}" 的连接配置不存在`);
    if (!connection.baseUrl) throw new Error(`通用模型 "${gm.name}" 未配置接口地址`);
    const referenceInput = await resolveVideoReferenceInput(rawPrompt, params.nodeId, params.referenceMedia ?? []);
    assertVideoReferenceLimits(referenceInput, gm.videoCapability, gm.name);
    if (gm.executionProfile) {
      const [remoteImageUrls, videoUrls, audioUrls] = await Promise.all([
        resolveImageUrlArray(referenceInput.imageUrls, connection.providerConfigId),
        resolveGeneralProtocolMediaUrls(referenceInput.references ?? [], 'video'),
        resolveGeneralProtocolMediaUrls(referenceInput.references ?? [], 'audio'),
      ]);
      const resolvedReferenceInput = {
        ...referenceInput,
        imageUrls: remoteImageUrls,
        videoUrls,
        audioUrls,
      };
      await assertVideoInputConstraints(
        resolvedReferenceInput,
        gm.videoCapability,
        gm.name,
        { signal },
      );
      const urls = await runConfiguredModelProtocol({
        model: gm,
        category: 'video',
        nodeId: params.nodeId,
        signal,
        variables: buildGeneralVideoProtocolVariables(
          gm.modelId,
          params,
          resolvedReferenceInput,
          gm.videoCapability,
        ),
      });
      const url = urls[0];
      if (!url) throw new Error('视频生成完成但未返回结果');
      return { url };
    }
    assertVideoOperationSupported(referenceInput, '该通用模型的旧版视频协议');
    return executeGeneralAsyncTask(
      connection.apiKey,
      connection.baseUrl,
      gm.modelId,
      referenceInput.prompt,
      'videos',
      connection.providerConfigId,
      params.nodeId,
      signal,
      mapVideoParameters(connection.providerConfigId, gm.modelId, {
        model: gm.modelId,
        prompt: referenceInput.prompt,
        resolution: params.seedanceResolution,
        aspectRatio: params.seedanceRatio,
        duration: params.seedanceDuration,
        generateAudio: params.generateAudio,
        imageUrls: referenceInput.imageUrls,
        videoUrls: referenceInput.videoUrls,
        audioUrls: referenceInput.audioUrls,
      }),
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
): Promise<{ url: string }> {
  const nodeId = params.nodeId;
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

    // 提交任务
    const apiUrl = `${baseUrl}/contents/generations/tasks`;
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
      updatePendingTask(nodeId, { taskId, submitted: true });
    }

    // 轮询
    return await pollTask<Record<string, unknown>, { url: string }>({
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
          if (videoUrl) return { url: videoUrl };
          throw new Error('任务完成但未返回视频地址');
        }
        return null;
      },
      isFailed: (raw) => {
        const status = raw.status as string;
        if (status === 'failed' || status === 'cancelled') {
          const err = raw.error as { message?: string } | undefined;
          return `任务失败: ${err?.message || status}`;
        }
        return null;
      },
      interval: 3000,
      signal,
    });

  } finally {
    if (nodeId) {
      cleanupNodePolling(nodeId);
      removePendingTask(nodeId);
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
    : params.seedanceRatio || '16:9';
  const duration = isSeedance25 && hasReferenceVideo
    ? -1
    : params.seedanceDuration ?? 5;
  const resolution = params.seedanceResolution || '720p';
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
