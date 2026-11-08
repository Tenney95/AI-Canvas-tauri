/**
 * ai/generationRuntime — 对话媒体生成统一入口。
 *
 * ChatPanel / Agent 工具不再直接选择 Provider 或调用具体图片、视频、音频服务，
 * 而是统一走 runMediaGeneration(intent)，由本模块完成：
 *   1. 解析并剥离 @model{...} 引用（extractModelMention / stripModelMentions）；
 *   2. 解析媒体模型（resolveMediaModel），统一校验模型类型、API Key、ComfyUI / 即梦等前置条件；
 *   3. 按 kind 分发到 generateImage / generateVideo / generateAudio；
 *   4. 产物落盘（persistGeneratedMedia），并如实区分「生成成功」与「已保存到项目」两种状态，
 *      失败不再被吞掉，避免签名 URL 过期或 blob 失效后留下打不开的产物。
 *
 * 产物落盘失败后可通过 retryMediaArtifactPersist 重新写盘。
 */
import { useAppStore } from '../../store/useAppStore';
import { supportsNativeMediaProtocol } from '../nativeMediaCapabilities';
import {
  isTauriEnv,
  isTransientMediaUrl,
  persistMediaUrlToProjectData,
} from '../fileService';
import { comfyBaseUrlFor } from '../comfyServers';
import { isRunningHubWorkflow, mediaProviderConfigId, workflowExecution, runningHubConnection } from '../workflowExecutionService';
import { getRunningHubModel } from './providers/runninghubModelManifest';
import { workflowApiConnection } from '../workflowApi/workflowApiAdapter';
import { getCloudWorkflowPersistedOutput } from '../workflowExecutionService';
import type {
  MediaGenerationIntent,
  MediaGenerationParameters,
  MediaGenerationResult,
  MediaGenerationDelivery,
  MediaKind,
  MediaPersistenceStatus,
  ResolvedMediaModel,
} from '../../types/media';
import { generateImage } from './generateImage';
import { generateVideo } from './generateVideo';
import { resolveImageOutputsPerJob, resolveImageParameterCapability } from './mediaModelCapabilities';
import { assertSafeMediaParameterStrings, resolveConfiguredImageBackground, resolveConfiguredImageQuality } from './modelCapabilityValidation';
import { resolveVideoModelCapability } from './videoModelCapabilityResolver';
import { generateAudio, persistAudioGenerationResult } from './generateAudio';
import { findMediaModelOption } from '../../components/nodes/shared/defaultModels';
import { videoLongSideFromLabel } from '../aiDimensions';
import { resolveProjectGenerationPrompt } from '../projectSettingsService';
import type { BaseNodeData, NodeType } from '../../types';
import type { ChatMessage } from '../../types/chat';
import type { MediaDownloadAccess, MediaTaskReceipt } from '../../types/aiTypes';
import { tagGeneratedProjectAssetSafely } from '../fs/generatedAssetTags';
import {
  bindMediaTaskContext, completeMediaNodeTask, getMediaTaskReceipt, getMediaTaskSnapshot, getPendingTasksForProject, pauseMediaTask,
  registerMediaMessageRecoveryHandler, registerMediaNodeOperation, resumeMediaNodeTask,
  updatePendingTask,
  type MediaTaskSnapshot, type PendingTask,
} from '../pollManager';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../canvasDerivationGuard';
import { persistMessage } from '../chat/chatHistoryService';
import { applyImageBatchResults, imageBatchArtifactId } from '../imageBatchService';
import type { CanvasDerivationGuard } from '../canvasDerivationGuard';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from '../projectExecutionContext';
import { registerNativeVideoSubmissionGuard } from '../nativeVideoSubmission';
import { bindNativeMediaOrigin } from '../nativeMediaOrigin';
import { videoInputFingerprintMaterial } from '../videoBatchPlanning';
import { nativeMediaInputMaterial } from '../nativeMediaInput';

const MODEL_MENTION_RE = /@model\{([^|}\s]+)(?:\|[^}]*)?\}/i;

const MEDIA_NODE_TYPES: Record<MediaKind, NodeType> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

const MEDIA_LABELS: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

export const MEDIA_PERSIST_FAILED_MESSAGE = '产物未能写入项目目录，当前是临时地址，重启后可能失效';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
}

export function mediaDeliveryResults(delivery: MediaGenerationDelivery): MediaGenerationResult[] {
  const { additionalResults, ...primary } = delivery;
  delete primary.expectedOutputCount;
  return [primary, ...(additionalResults ?? [])];
}

export function isMediaDeliveryGroup(delivery: MediaGenerationDelivery): boolean {
  return (delivery.expectedOutputCount ?? 1) > 1 || Boolean(delivery.additionalResults?.length);
}

function sameMediaReceipt(left: MediaTaskReceipt | undefined, right: MediaTaskReceipt): boolean {
  return !!left && left.projectId === right.projectId && left.nodeId === right.nodeId
    && left.taskId === right.taskId && left.attemptId === right.attemptId;
}

type MessageTaskIdentity = Pick<MediaTaskSnapshot, 'projectId' | 'nodeId' | 'taskId' | 'attemptId'
  | 'mediaContext' | 'expectedImageOutputs' | 'imageOutputNodeIds'>;

/** 只接受任务自己记下的重挂来源，不按远端 taskId 猜测其他节点。 */
function matchesMessageTaskReceipt(receipt: MediaTaskReceipt | undefined, task: MessageTaskIdentity): boolean {
  if (!receipt || receipt.projectId !== task.projectId || receipt.taskId !== task.taskId
    || receipt.attemptId !== task.attemptId) return false;
  return receipt.nodeId === task.nodeId || Boolean((task.expectedImageOutputs ?? 1) > 1
    && Array.isArray(task.imageOutputNodeIds) && task.imageOutputNodeIds.includes(receipt.nodeId));
}

export function extractModelMention(input: string): string | undefined {
  return MODEL_MENTION_RE.exec(input)?.[1]?.trim() || undefined;
}

export function stripModelMentions(input: string): string {
  return input.replace(new RegExp(MODEL_MENTION_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

export function resolveMediaModel(kind: MediaKind, modelRef?: string): ResolvedMediaModel {
  const config = useAppStore.getState().config;
  if (!modelRef) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    throw new Error(`请先通过 @ 选择${label}模型`);
  }

  const option = findMediaModelOption(
    modelRef,
    config.generalModels ?? [],
    config,
    useAppStore.getState().workflows,
  );
  if (!option) throw new Error('未找到 @ 引用的媒体模型');
  if (option.mediaKind !== kind) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    throw new Error(`模型“${option.label}”不能用于${label}生成`);
  }

  if (option.provider === 'general') {
    const generalId = option.value.slice('general/'.length);
    const generalModel = (config.generalModels ?? []).find((model) => model.id === generalId);
    if (!generalModel) throw new Error('未找到 @ 引用的通用模型配置');
    const provider = config.providers[generalModel.providerConfigId];
    if (!provider?.baseUrl || !generalModel.modelId) {
      throw new Error(`模型“${generalModel.name}”的接口配置不完整`);
    }
    return {
      configId: option.value,
      requestModel: `general/${generalModel.id}`,
      provider: 'general',
      audioPurpose: option.audioPurpose,
    };
  }

  if (option.workflowId) {
    const workflow = useAppStore.getState().workflows.find((item) => item.id === option.workflowId);
    if (workflow?.adapterType === 'workflow-api' && workflow.workflowApi) {
      workflowApiConnection(config.providers[workflow.workflowApi.connectionId], workflow.workflowApi);
      const execution = workflowExecution(workflow);
      return { configId: option.value, requestModel: execution.model, provider: execution.provider, workflowId: workflow.id };
    }
    if (isRunningHubWorkflow(workflow) && workflow?.runninghub) {
      runningHubConnection(config.providers, workflow.runninghub.connectionId);
      const execution = workflowExecution(workflow);
      return { configId: option.value, requestModel: execution.model, provider: execution.provider, workflowId: workflow.id };
    }
    if (!comfyBaseUrlFor(option.workflowId)) {
      throw new Error('未配置 ComfyUI 服务地址\n请在「设置 → ComfyUI」中配置');
    }
    return {
      configId: option.value,
      requestModel: 'comfyui/workflow',
      provider: 'comfyui',
      workflowId: option.workflowId,
    };
  }

  if (option.provider === 'dreamina') {
    if (!config.dreaminaAuth?.loggedIn) throw new Error('请先登录即梦账号');
  } else if (!config.providers[mediaProviderConfigId(option.provider)]?.apiKey) {
    throw new Error(`请先配置 ${option.provider} 的 API Key`);
  }

  return {
    configId: option.value,
    requestModel: option.value,
    provider: option.provider,
    audioPurpose: option.audioPurpose,
  };
}

async function saveGeneratedMedia(
  url: string,
  projectId: string,
  kind: MediaKind,
  artifactId: string,
  mediaDownloadAccess?: MediaDownloadAccess,
  signal?: AbortSignal,
) {
  const baseName = `对话${MEDIA_LABELS[kind]}-${artifactId}`;
  return persistMediaUrlToProjectData(url, projectId, MEDIA_NODE_TYPES[kind], baseName, { mediaDownloadAccess, signal });
}

interface MediaPersistOutcome {
  status: MediaPersistenceStatus;
  filePath?: string;
  assetUrl?: string;
  sourceUrl?: string;
  error?: string;
}

/**
 * 落盘生成产物，并如实返回结果。
 * 失败不再被吞掉：调用方据此把「生成成功」和「已保存到项目」分开呈现，
 * 否则签名 URL 过期或 blob 失效后，用户手里就只剩一个打不开的产物。
 */
async function persistGeneratedMedia(
  url: string,
  projectId: string | null | undefined,
  kind: MediaKind,
  artifactId: string,
  mediaDownloadAccess?: MediaDownloadAccess,
  signal?: AbortSignal,
): Promise<MediaPersistOutcome> {
  if (!projectId || !isTauriEnv()) return { status: 'skipped' };
  try {
    const saved = await saveGeneratedMedia(url, projectId, kind, artifactId, mediaDownloadAccess, signal);
    if (!saved?.filePath) return { status: 'failed', error: MEDIA_PERSIST_FAILED_MESSAGE };
    return {
      status: 'saved',
      filePath: saved.filePath,
      assetUrl: saved.mediaUrl,
      sourceUrl: saved.sourceUrl,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : MEDIA_PERSIST_FAILED_MESSAGE,
    };
  }
}

async function tagSavedGeneratedMedia(
  filePath: string | undefined,
  projectId: string | null | undefined,
  prompt: string,
): Promise<void> {
  if (!filePath || !projectId) return;
  await tagGeneratedProjectAssetSafely({ filePath, projectId, prompt });
}

function mediaParameters(intent: MediaGenerationIntent, model: ResolvedMediaModel, projectId?: string | null): MediaGenerationParameters | undefined {
  const store = useAppStore.getState();
  const settings = store.projects.find((project) => project.id === (projectId ?? store.currentProjectId))?.settings?.generation;
  const directVideo = ((model.provider === 'general' || model.provider === 'runninghub') && !model.workflowId)
    || model.provider === 'workflow-api';
  const ratio = intent.aspectRatio ?? (directVideo ? undefined : settings?.videoAspectRatio);
  const resolution = intent.resolution ?? (directVideo ? undefined : settings?.videoResolution);
  const duration = intent.duration ?? (directVideo ? undefined : settings?.videoDuration);
  const imageCapability = intent.kind === 'image' && !model.workflowId && model.provider !== 'runninghub'
    ? resolveImageParameterCapability(model.requestModel, model.provider, store.config) : undefined;
  const imageQuality = resolveConfiguredImageQuality(imageCapability, intent.imageQuality);
  const imageBackground = intent.imageBackground === '' ? ''
    : resolveConfiguredImageBackground(imageCapability, intent.imageBackground);
  const parameters: MediaGenerationParameters = intent.kind === 'image' ? {
    resolution: settings?.imageSize || '2K',
    aspectRatio: settings?.imageAspectRatio || '1:1',
    ...(imageQuality !== undefined ? { imageQuality } : {}),
    ...(imageBackground !== undefined ? { imageBackground } : {}),
  } : intent.kind === 'video' ? {
    ...(ratio !== undefined ? { aspectRatio: ratio } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(intent.videoFps !== undefined ? { videoFps: intent.videoFps } : {}),
    ...(intent.generateAudio !== undefined ? { generateAudio: intent.generateAudio } : {}),
  } : {};
  return Object.keys(parameters).length || intent.kind === 'video' ? parameters : undefined;
}

/** 显式参数必须属于当前模型，不能被底层缺省逻辑静默丢弃。 */
function assertExplicitMediaParameters(intent: MediaGenerationIntent, model: ResolvedMediaModel): void {
  if (intent.kind !== 'image' && (intent.imageQuality !== undefined || intent.imageBackground !== undefined)) {
    throw new Error('图片质量和背景只能用于图片生成');
  }
  if (intent.kind !== 'video' && (intent.videoFps !== undefined || intent.generateAudio !== undefined)) {
    throw new Error('帧率和生成音轨只能用于视频生成');
  }
  if ((model.workflowId || model.provider === 'runninghub')
    && [intent.imageQuality, intent.imageBackground, intent.videoFps, intent.generateAudio].some((value) => value !== undefined)) {
    throw new Error('RunningHub 和工作流使用自己的参数定义，请使用模型或工作流专属参数');
  }
  const config = useAppStore.getState().config;
  if (intent.kind === 'image' && (intent.imageQuality !== undefined || intent.imageBackground !== undefined)) {
    const capability = resolveImageParameterCapability(model.requestModel, model.provider, config);
    if (intent.imageQuality !== undefined && !capability?.qualities?.length) throw new Error('所选模型未声明图片质量参数');
    if (intent.imageBackground !== undefined && intent.imageBackground !== '' && !capability?.backgrounds?.length) {
      throw new Error('所选模型未声明图片背景参数');
    }
    if (intent.imageBackground === '' && capability?.backgroundIsFixed) {
      throw new Error('所选模型的背景由协议固定，不能选择接口默认');
    }
    resolveConfiguredImageQuality(capability, intent.imageQuality);
    resolveConfiguredImageBackground(capability, intent.imageBackground);
  }
  if (intent.kind === 'video' && (intent.videoFps !== undefined || intent.generateAudio !== undefined
    || (intent.duration !== undefined && intent.duration <= 0))) {
    const capability = resolveVideoModelCapability(model.configId, config, intent.resolution);
    if (intent.videoFps !== undefined && (!Number.isFinite(intent.videoFps)
      || !capability?.frameRates?.includes(intent.videoFps))) throw new Error('所选模型未声明或不支持该视频帧率');
    if (intent.generateAudio !== undefined && capability?.supportsAudio !== true) throw new Error('所选模型未声明可调生成音轨开关');
    if (intent.duration !== undefined && intent.duration <= 0
      && (intent.duration === 0 || !Number.isFinite(intent.duration) || intent.duration !== capability?.automaticDurationValue)) {
      throw new Error('所选模型不支持该自动时长值');
    }
  }
}

export async function runMediaGeneration(
  intent: MediaGenerationIntent,
  projectId?: string | null,
  signal?: AbortSignal,
  targetNodeId?: string,
  runninghubTaskContext?: import('../../types/runninghub').RunningHubTaskContext,
): Promise<MediaGenerationDelivery> {
  intent = structuredClone(intent);
  throwIfAborted(signal);
  const projectContext = useAppStore.getState().projectExecutionContext;
  if (intent.kind !== 'audio' && [intent.audioVoice, intent.audioFormat, intent.audioSpeed, intent.musicTitle, intent.musicLyrics]
    .some((value) => value !== undefined)) throw new Error('音频参数只能用于音频生成');
  if (!stripModelMentions(intent.prompt)) throw new Error('媒体生成提示词不能为空');
  const model = resolveMediaModel(intent.kind, intent.modelRef);
  assertSafeMediaParameterStrings(intent);
  const parameters = mediaParameters(intent, model, projectId);
  assertSafeMediaParameterStrings(parameters);
  assertExplicitMediaParameters(intent, model);
  if (projectContext && projectContext.modelGeneration > 0) {
    const context = captureLegacyCanvasContext(useAppStore.getState());
    if (!context || context.modelGeneration !== 1 || projectId !== context.canvasId
      || !supportsNativeMediaProtocol(intent.kind, model.provider, model.workflowId, useAppStore.getState().workflows)
      || intent.deliveryMode !== 'chat' && !targetNodeId || !runninghubTaskContext) {
      throw new Error('此新项目媒体目的地尚不能安全续查，未提交请求');
    }
    const trackingNodeId = targetNodeId ?? `media-message-${crypto.randomUUID()}`;
    const state = useAppStore.getState(), node = state.nodes.find((item) => item.id === targetNodeId);
    if (intent.deliveryMode !== 'chat' && !node || !state.messages.some((message) => message.id === runninghubTaskContext.messageId
      && message.conversationId === runninghubTaskContext.conversationId)) throw new Error('原媒体消息或占位节点已变化');
    const messageMaterial = (current: ReturnType<typeof useAppStore.getState>) => JSON.stringify([intent, parameters,
      current.projects.find((item) => item.id === context.canvasId)?.settings, current.customStyles,
      current.config.generalModels?.find((item) => item.id === model.configId.replace(/^general\//, '')),
      nativeMediaInputMaterial({ id: trackingNodeId, type: `ai-${intent.kind}`, position: { x: 0, y: 0 },
        data: { type: `ai-${intent.kind}`, label: '', prompt: intent.prompt, model: model.configId, provider: model.provider, workflowId: model.workflowId } }, current, 'media-input-v3')]);
    const inputMaterial = intent.kind === 'video' ? videoInputFingerprintMaterial
      : (target: Parameters<typeof nativeMediaInputMaterial>[0], current: Parameters<typeof nativeMediaInputMaterial>[1]) => nativeMediaInputMaterial(target, current, 'media-input-v3');
    const material = node ? inputMaterial(node, state) : messageMaterial(state);
    const guard = registerNativeVideoSubmissionGuard(() => {
      throwIfAborted(signal);
      const current = useAppStore.getState(), next = current.nodes.find((item) => item.id === targetNodeId);
      if (!isProjectExpectedContextCurrent(context, current, { checkCanvasRevision: false })
        || (intent.deliveryMode === 'chat' ? messageMaterial(current) !== material : !next || inputMaterial(next, current) !== material)
        || !current.messages.some((message) => message.id === runninghubTaskContext.messageId
          && message.conversationId === runninghubTaskContext.conversationId)) throw new Error('原媒体输入、消息或画布已变化，未提交请求');
    });
    const message = state.messages.find((entry) => entry.id === runninghubTaskContext.messageId)!;
    const origin = { conversationId: runninghubTaskContext.conversationId,
      messageId: runninghubTaskContext.messageId, ...(message.agentTaskId ? { agentTaskId: message.agentTaskId } : {}),
      modelId: model.configId,
      deliveryMode: intent.deliveryMode };
    const { persistNativeMediaOrigin } = await import('../nativeMediaOriginPersistence');
    await persistNativeMediaOrigin(context, origin); guard();
    const unbind = bindNativeMediaOrigin(context.canvasId, trackingNodeId, origin, intent.deliveryMode === 'chat' ? { material, assertCurrent: guard } : undefined);
    try { return await generateMediaArtifact(intent, projectId, signal, trackingNodeId, runninghubTaskContext, model, parameters, guard); }
    finally { unbind(); }
  }
  ensureMediaMessageRecoveryHandler();
  const nativeCloud = ['runninghubwf', 'runninghub', 'workflow-api'].includes(model.provider);
  const trackingId = targetNodeId ?? (!nativeCloud && runninghubTaskContext
    ? `media-message-${runninghubTaskContext.messageId}-${crypto.randomUUID()}` : undefined);
  let operationReceipt: MediaTaskReceipt | undefined;
  const taskProjectId = runninghubTaskContext?.projectId ?? projectId ?? useAppStore.getState().currentProjectId;
  const unbind = trackingId && !nativeCloud && taskProjectId ? bindMediaTaskContext(trackingId, {
    projectId: taskProjectId,
    conversationId: runninghubTaskContext?.conversationId,
    messageId: runninghubTaskContext?.messageId,
    deliveryMode: runninghubTaskContext ? intent.deliveryMode === 'chat' ? 'message' : 'node+message' : 'node',
    canvasNodeId: targetNodeId,
    modelId: model.configId,
    ...(parameters ? { parameters } : {}),
  }, (receipt) => { operationReceipt = receipt; }) : undefined;
  const finishOperation = trackingId ? registerMediaNodeOperation(trackingId) : undefined;
  try {
    const artifact = await generateMediaArtifact(intent, projectId, signal, trackingId, runninghubTaskContext, model, parameters);
    if (parameters) artifact.parameters = parameters;
    for (const item of artifact.additionalResults ?? []) if (parameters) item.parameters = parameters;
    if (!artifact.taskReceipt && operationReceipt && getPendingTasksForProject(operationReceipt.projectId).some((task) =>
      task.nodeId === operationReceipt!.nodeId && task.taskId === operationReceipt!.taskId && task.attemptId === operationReceipt!.attemptId)) {
      artifact.taskReceipt = operationReceipt;
    }
    if (isMediaDeliveryGroup(artifact) && artifact.taskReceipt) {
      artifact.id = imageBatchArtifactId(artifact.taskReceipt, 0);
      for (const [index, item] of (artifact.additionalResults ?? []).entries()) {
        item.taskReceipt = artifact.taskReceipt;
        item.id = imageBatchArtifactId(artifact.taskReceipt, index + 1);
      }
    }
    if (artifact.taskReceipt && mediaDeliveryResults(artifact).some((item) => item.persistence === 'failed')) {
      pauseMediaTask(artifact.taskReceipt, undefined, 'delivery_pending');
    }
    return artifact;
  } catch (error) {
    if (operationReceipt) {
      const paused = pauseMediaTask(operationReceipt, error, operationReceipt.taskId ? 'query_interrupted' : 'submit_unknown');
      if (paused) throw paused;
    }
    throw error;
  } finally {
    finishOperation?.();
    unbind?.();
  }
}

async function generateMediaArtifact(
  intent: MediaGenerationIntent,
  projectId: string | null | undefined,
  signal: AbortSignal | undefined,
  targetNodeId: string | undefined,
  runninghubTaskContext: import('../../types/runninghub').RunningHubTaskContext | undefined,
  model: ResolvedMediaModel,
  parameters?: MediaGenerationParameters,
  beforeSubmit?: () => void | Promise<void>,
): Promise<MediaGenerationDelivery> {
  throwIfAborted(signal);

  const prompt = stripModelMentions(intent.prompt);
  if (!prompt) throw new Error('媒体生成提示词不能为空');

  const store = useAppStore.getState();
  const targetProjectId = projectId ?? store.currentProjectId;
  const projectSettings = store.projects.find(
    (project) => project.id === targetProjectId,
  )?.settings;
  const effectivePrompt = resolveProjectGenerationPrompt({
    prompt,
    data: {
      label: '对话媒体生成',
      type: MEDIA_NODE_TYPES[intent.kind],
      role: 'generator',
    } as BaseNodeData,
    settings: projectSettings,
    customStyles: store.customStyles,
  });

  if (model.provider === 'runninghubwf' && [intent.aspectRatio, intent.resolution, intent.duration].some((value) => value !== undefined)) throw new Error('请通过工作流参数设置比例、分辨率或时长');
  if (model.provider === 'workflow-api' && useAppStore.getState().workflows.find((workflow) => workflow.id === model.workflowId)?.workflowApi?.version === 2
    && [intent.aspectRatio, intent.resolution, intent.duration].some((value) => value !== undefined)) throw new Error('自定义工作流请通过 workflowInputs 设置参数');
  if (
    intent.kind === 'audio'
    && intent.audioPurpose
    && model.audioPurpose
    && intent.audioPurpose !== model.audioPurpose
  ) {
    throw new Error(`所选模型不支持${intent.audioPurpose === 'music' ? '音乐' : '语音'}生成`);
  }
  const runninghubModelParameters = { ...intent.runninghubModelParameters };
  if (model.provider === 'runninghub') {
    const definition = getRunningHubModel(model.requestModel);
    for (const [name, value] of Object.entries({ aspectRatio: intent.aspectRatio, resolution: intent.resolution, duration: intent.duration })) {
      if (value === undefined) continue;
      const field = definition?.parameters.find((field) => field.name === name || (name === 'aspectRatio' && field.name === 'ratio'));
      if (!field) throw new Error(`所选 RunningHub 操作没有 ${name} 参数，请读取模型专属参数`);
      if (runninghubModelParameters[field.name] !== undefined && runninghubModelParameters[field.name] !== String(value)) throw new Error('通用参数与模型专属参数冲突');
      runninghubModelParameters[field.name] = String(value);
    }
  }
  const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (intent.kind === 'image') {
    const imageOptions = {
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      ...(resolveImageOutputsPerJob(model.requestModel, model.provider, store.config) > 1 ? { collectCandidates: true } : {}),
      imageSize: parameters?.resolution ?? '2K',
      aspectRatio: parameters?.aspectRatio ?? '1:1',
      ...(parameters?.imageQuality !== undefined ? { imageQuality: parameters.imageQuality } : {}),
      ...(parameters?.imageBackground !== undefined ? { imageBackground: parameters.imageBackground } : {}),
      workflowId: model.workflowId,
      workflowInputs: intent.workflowInputs, runninghubModelParameters: model.provider === 'runninghub' ? runninghubModelParameters : undefined,
      nodeId: targetNodeId,
      runninghubTaskContext,

      workflowApiTaskContext: model.provider === 'workflow-api' ? runninghubTaskContext : undefined,
    };
    const result = beforeSubmit ? await generateImage(imageOptions, signal, beforeSubmit) : await generateImage(imageOptions, signal);
    const taskReceipt = result.taskReceipt ?? (result.comfyTaskId && targetNodeId ? getMediaTaskReceipt(targetNodeId, result.comfyTaskId) : undefined);
    const candidates = [result, ...(result.additionalResults ?? [])];
    const expectedOutputCount = result.expectedOutputCount ?? candidates.length;
    if (expectedOutputCount <= 1) throwIfAborted(signal);
    const artifacts: MediaGenerationResult[] = [];
    for (const [index, candidate] of candidates.entries()) {
      if (expectedOutputCount <= 1) throwIfAborted(signal);
      const artifactId = expectedOutputCount > 1 && taskReceipt ? imageBatchArtifactId(taskReceipt, index)
        : index === 0 ? id : `${id}-output-${index}`;
      const savedCloud = getCloudWorkflowPersistedOutput(candidate.workflowApiOutputs ?? candidate.runninghubOutputs, candidate.url);
      const persisted: MediaPersistOutcome = savedCloud ? { ...savedCloud, status: savedCloud.persistence }
        : signal?.aborted ? { status: 'failed', error: '已停止保存，原候选仍待保存' }
        : await persistGeneratedMedia(candidate.url, projectId, intent.kind, artifactId, candidate.mediaDownloadAccess ?? result.mediaDownloadAccess, signal);
      if (expectedOutputCount <= 1 && persisted.status === 'failed' && isTransientMediaUrl(candidate.url) && !taskReceipt) {
        throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
      }
      if (!signal?.aborted) await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
      if (expectedOutputCount <= 1) throwIfAborted(signal);
      artifacts.push({
        id: artifactId, kind: intent.kind, taskReceipt,
        runninghubOutputs: candidate.runninghubOutputs,
        workflowApiOutputs: candidate.workflowApiOutputs, workflowApiTaskId: candidate.workflowApiTaskId,
        deliveryMode: intent.deliveryMode, url: persisted.assetUrl || candidate.url,
        sourceUrl: persisted.sourceUrl || candidate.url, filePath: persisted.filePath,
        persistence: persisted.status, persistError: persisted.error,
        width: candidate.width, height: candidate.height, prompt,
        modelId: model.configId, provider: model.provider, createdAt: Date.now(),
      });
    }
    return { ...artifacts[0], ...(expectedOutputCount > 1
      ? { additionalResults: artifacts.slice(1), expectedOutputCount } : {}) };
  }

  if (intent.kind === 'video') {
    const directGeneralProtocol = ((model.provider === 'general' || model.provider === 'runninghub') && !model.workflowId) || model.provider === 'workflow-api';
    const aspectRatio = parameters?.aspectRatio;
    const resolution = parameters?.resolution;
    const duration = parameters?.duration;
    const videoOptions = {
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      seedanceRatio: aspectRatio,
      seedanceResolution: resolution,
      seedanceDuration: duration,
      ...(intent.videoFps !== undefined ? { videoFps: intent.videoFps } : {}),
      ...(intent.generateAudio !== undefined ? { generateAudio: intent.generateAudio } : {}),
      // 工作流只认数字长边，档位换算后再传
      videoResolution: directGeneralProtocol ? undefined : videoLongSideFromLabel(resolution),
      workflowId: model.workflowId,
      workflowInputs: intent.workflowInputs, runninghubModelParameters: model.provider === 'runninghub' ? runninghubModelParameters : undefined,
      nodeId: targetNodeId,
      runninghubTaskContext,
      workflowApiTaskContext: model.provider === 'workflow-api' ? runninghubTaskContext : undefined,
    };
    const result = beforeSubmit ? await generateVideo(videoOptions, signal, beforeSubmit) : await generateVideo(videoOptions, signal);
    const taskReceipt = result.taskReceipt ?? (result.comfyTaskId && targetNodeId ? getMediaTaskReceipt(targetNodeId, result.comfyTaskId) : undefined);
    throwIfAborted(signal);
    const savedCloud = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url);
    const persisted: MediaPersistOutcome = savedCloud ? { ...savedCloud, status: savedCloud.persistence } : await persistGeneratedMedia(result.url, projectId, intent.kind, id, result.mediaDownloadAccess, signal);
    if (persisted.status === 'failed' && isTransientMediaUrl(result.url) && !taskReceipt) {
      throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
    }
    await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
    throwIfAborted(signal);
    return {
      id,
      kind: intent.kind,
      taskReceipt,
      runninghubOutputs: result.runninghubOutputs,
      workflowApiOutputs: result.workflowApiOutputs, workflowApiTaskId: result.workflowApiTaskId,
      deliveryMode: intent.deliveryMode,
      url: persisted.assetUrl || result.url,
      sourceUrl: persisted.sourceUrl || result.url,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: persisted.error,
      prompt,
      modelId: model.configId,
      provider: model.provider,
      createdAt: Date.now(),
    };
  }

  const audioOptions = {
    prompt: effectivePrompt,
    model: model.requestModel,
    provider: model.provider,
    ...(intent.audioVoice !== undefined ? { audioVoice: intent.audioVoice } : {}),
    ...(intent.audioFormat !== undefined ? { audioFormat: intent.audioFormat } : {}),
    ...(intent.audioSpeed !== undefined ? { audioSpeed: intent.audioSpeed } : {}),
    ...(intent.musicTitle !== undefined ? { musicTitle: intent.musicTitle } : {}),
    ...(intent.musicLyrics !== undefined ? { musicLyrics: intent.musicLyrics } : {}),
    workflowId: model.workflowId,
    workflowInputs: intent.workflowInputs, runninghubModelParameters: model.provider === 'runninghub' ? runninghubModelParameters : undefined,
    nodeId: targetNodeId,
    runninghubTaskContext,

    workflowApiTaskContext: model.provider === 'workflow-api' ? runninghubTaskContext : undefined,
  };
    const result = beforeSubmit ? await generateAudio(audioOptions, signal, beforeSubmit) : await generateAudio(audioOptions, signal);
  const taskReceipt = result.taskReceipt ?? (result.comfyTaskId && targetNodeId ? getMediaTaskReceipt(targetNodeId, result.comfyTaskId) : undefined);
  throwIfAborted(signal);
  const persisted = await persistAudioGenerationResult(
    result,
    projectId,
    `对话音频-${id}`,
  );
  await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
  throwIfAborted(signal);
  return {
    id,
    kind: intent.kind,
    taskReceipt,
    runninghubOutputs: result.runninghubOutputs,

    workflowApiOutputs: result.workflowApiOutputs, workflowApiTaskId: result.workflowApiTaskId,
    deliveryMode: intent.deliveryMode,
    url: persisted.mediaUrl,
    sourceUrl: persisted.sourceUrl || persisted.outputUrl,
    filePath: persisted.filePath,
    persistence: persisted.persistence,
    persistError: persisted.persistError,
    prompt,
    modelId: model.configId,
    provider: model.provider,
    audioPurpose: intent.audioPurpose,
    createdAt: Date.now(),
  };
}

/**
 * 重新把已生成的产物写入项目目录（用于落盘失败后的重试下载）。
 * 成功时返回指向本地文件的新产物，失败时抛出可直接展示的原因。
 */
export async function retryMediaArtifactPersist(
  artifact: MediaGenerationResult,
  projectId?: string | null,
): Promise<MediaGenerationResult> {
  if (!isTauriEnv()) throw new Error('浏览器模式不支持把产物保存到项目目录');
  const targetProjectId = projectId ?? useAppStore.getState().currentProjectId;
  if (!targetProjectId) throw new Error('当前没有打开的项目，无法保存产物');

  const sourceUrl = artifact.sourceUrl || artifact.url;
  if (!sourceUrl) throw new Error('产物已没有可用的下载地址，请重新生成');
  const receipt = artifact.taskReceipt;
  const task = receipt ? getPendingTasksForProject(receipt.projectId).find((item) => item.nodeId === receipt.nodeId
    && item.taskId === receipt.taskId && item.attemptId === receipt.attemptId) : undefined;

  const persisted = await persistGeneratedMedia(
    sourceUrl,
    targetProjectId,
    artifact.kind,
    artifact.id,
    task?.mediaDownloadAccess,
  );
  if (persisted.status !== 'saved') {
    throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
  }
  await tagSavedGeneratedMedia(persisted.filePath, targetProjectId, artifact.prompt);
  return {
    ...artifact,
    url: persisted.assetUrl || artifact.url,
    sourceUrl: persisted.sourceUrl || artifact.sourceUrl,
    filePath: persisted.filePath,
    persistence: 'saved',
    persistError: undefined,
  };
}

function matchesRecoverableMessageTask(messageId: string, message: ChatMessage | undefined, task: MessageTaskIdentity): boolean {
  return task.mediaContext?.messageId === messageId
      && (!message || !task.mediaContext.conversationId || task.mediaContext.conversationId === message.conversationId)
    || Boolean(message && task.mediaContext?.conversationId === message.conversationId
      && matchesMessageTaskReceipt(message.mediaResult?.taskReceipt, task));
}

/** 展示专用稳定投影，不读取 Store 消息、解析账本或发起任务恢复。 */
export function getRecoverableMessageTaskSnapshot(message: ChatMessage, projectId: string | null): MediaTaskSnapshot | undefined {
  if (!projectId) return undefined;
  return getMediaTaskSnapshot().find((task) => task.projectId === projectId
    && matchesRecoverableMessageTask(message.id, message, task));
}

/** 只暴露原消息的任务身份，不从消息或模型提供的 URL 重建查询协议。 */
export function getRecoverableMessageTask(messageId: string, projectId?: string | null): PendingTask | undefined {
  const state = useAppStore.getState();
  const targetProjectId = projectId ?? state.currentProjectId;
  if (!targetProjectId) return undefined;
  const message = state.messages.find((item) => item.id === messageId);
  return getPendingTasksForProject(targetProjectId).find((task) => matchesRecoverableMessageTask(messageId, message, task));
}

export async function retryMediaMessageTask(messageId: string): Promise<void> {
  const task = getRecoverableMessageTask(messageId);
  if (!task) throw new Error('未找到该消息的待恢复任务');
  if (!task.taskId || !task.submitted) throw new Error('提交状态未知，请先到对应平台核对任务，避免重复生成');
  ensureMediaMessageRecoveryHandler();
  try {
    await resumeMediaNodeTask(task.nodeId);
  } catch (error) {
    const state = useAppStore.getState();
    const message = state.messages.find((item) => item.id === messageId && item.conversationId === task.mediaContext?.conversationId);
    if (state.currentProjectId === task.projectId && message
      && !getRecoverableMessageTask(messageId, task.projectId)
      && (!message.mediaResult || message.mediaResult.taskReceipt?.taskId === task.taskId
        && message.mediaResult.taskReceipt.attemptId === task.attemptId)) {
      state.updateMessage(messageId, { mediaStatus: 'failed', mediaError: error instanceof Error ? error.message : '原任务未返回可交付结果' });
    }
    throw error;
  }
}

/** 消息与画布采用相同交付边界，持久化消息失败时保留原任务。 */
export async function completeMediaMessageDelivery(messageId: string, artifact: MediaGenerationResult, canvasReady: boolean): Promise<void> {
  const receipt = artifact.taskReceipt;
  if (!receipt) return;
  if (artifact.persistence === 'failed' || !canvasReady) {
    pauseMediaTask(receipt, undefined, artifact.persistence === 'failed' ? 'delivery_pending' : 'canvas_changed');
    return;
  }
  const state = useAppStore.getState();
  const message = state.messages.find((item) => item.id === messageId && item.mediaResult?.id === artifact.id);
  if (state.currentProjectId !== receipt.projectId || !message) {
    pauseMediaTask(receipt, undefined, 'canvas_changed');
    return;
  }
  try {
    const task = getPendingTasksForProject(receipt.projectId).find((item) => matchesMessageTaskReceipt(receipt, item));
    if (task && task.nodeId !== receipt.nodeId) {
      pauseMediaTask({ projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId }, undefined, 'delivery_pending');
      return;
    }
    const expected = task?.nodeType === 'ai-image' ? task.expectedImageOutputs ?? 1 : 1;
    if (expected > 1) {
      const grouped = Array.from({ length: expected }, (_, index) => state.messages.find((item) =>
        item.conversationId === message.conversationId
        && item.mediaResult?.id === imageBatchArtifactId(receipt, index)
        && sameMediaReceipt(item.mediaResult.taskReceipt, receipt)));
      const ready = (item: typeof message | undefined) => !!item && item.mediaResult?.persistence !== 'failed'
        && (item.mediaResult?.deliveryMode === 'chat' || item.canvasStatus === 'created')
        && (item.mediaResult?.deliveryMode === 'chat' || state.nodes.some((node) =>
          node.id === item.canvasNodeId && node.data.artifactId === item.mediaResult?.id));
      if (!grouped.every(ready)) { pauseMediaTask(receipt, undefined, 'delivery_pending'); return; }
      for (const item of grouped) await persistMessage(item!, receipt.projectId, message.conversationId);
      const current = useAppStore.getState();
      if (current.currentProjectId !== receipt.projectId || grouped.some((item) =>
        !current.messages.some((live) => live.id === item!.id && live.mediaResult === item!.mediaResult
          && (live.mediaResult?.deliveryMode === 'chat' || live.canvasStatus === 'created'
            && current.nodes.some((node) => node.id === live.canvasNodeId && node.data.artifactId === live.mediaResult?.id))))) {
        pauseMediaTask(receipt, undefined, 'canvas_changed');
        return;
      }
      completeMediaNodeTask(receipt);
      return;
    }
    await persistMessage(message, receipt.projectId, message.conversationId);
    const current = useAppStore.getState();
    if (current.currentProjectId !== receipt.projectId
      || !current.messages.some((item) => item.id === messageId && item.mediaResult?.id === artifact.id)) {
      pauseMediaTask(receipt, undefined, 'canvas_changed');
      return;
    }
    completeMediaNodeTask(receipt);
  } catch (error) {
    pauseMediaTask(receipt, error, 'delivery_pending');
  }
}

/** 一次作业的候选分别进入既有单产物消息，整组保存后再确认同一回执。 */
export async function deliverMediaMessageGroup(
  messageId: string,
  delivery: MediaGenerationDelivery,
  options: { targetNodeId?: string; guard?: CanvasDerivationGuard | null; signal?: AbortSignal;
    isCurrent?: () => boolean; allowCanvas?: boolean } = {},
): Promise<{ complete: boolean; canvasReady: boolean; artifactIds: string[] }> {
  const state = useAppStore.getState();
  const root = state.messages.find((message) => message.id === messageId);
  if (!root) throw new Error('原媒体消息已不存在，结果仍保留');
  const projectId = delivery.taskReceipt?.projectId ?? state.currentProjectId;
  const artifacts = mediaDeliveryResults(delivery);
  if (!artifacts.length) throw new Error('图片作业没有可交付结果');
  const expected = delivery.expectedOutputCount ?? artifacts.length;
  const isCurrent = () => !options.signal?.aborted && options.isCurrent?.() !== false
    && useAppStore.getState().currentProjectId === projectId
    && useAppStore.getState().messages.some((message) => message.id === messageId && message.conversationId === root.conversationId);
  if (!isCurrent()) throw new Error('原项目或对话已变化，结果仍保留');
  let canvasReady = !options.targetNodeId;
  if (options.targetNodeId && options.allowCanvas !== false
    && (!options.guard || isCanvasDerivationFresh(options.guard, useAppStore.getState()))) {
    try {
      canvasReady = await applyImageBatchResults({ nodeId: options.targetNodeId,
        batch: { requestedCount: 1, expectedOutputCount: expected, failedCount: Math.max(0, expected - artifacts.length),
          allTasksSettled: true, results: artifacts.map((artifact) => ({ url: artifact.sourceUrl,
            width: artifact.width ?? 0, height: artifact.height ?? 0, taskReceipt: artifact.taskReceipt })) },
        artifacts, deferTaskCompletion: true, commitHistory: false,
        projectId, prompt: delivery.prompt, imageSize: delivery.parameters?.resolution ?? '1K',
        aspectRatio: delivery.parameters?.aspectRatio ?? '1:1', model: delivery.modelId, provider: delivery.provider,
        imageQuality: delivery.parameters?.imageQuality, imageBackground: delivery.parameters?.imageBackground,
        isCurrent: () => isCurrent() && (!options.guard || isCanvasDerivationFresh(options.guard, useAppStore.getState())),
        signal: options.signal, silent: true,
      });
    } catch (error) {
      if (delivery.taskReceipt) pauseMediaTask(delivery.taskReceipt, error, 'delivery_pending');
    }
  }
  if (!isCurrent()) throw new Error('原项目或对话已变化，结果仍保留');
  const current = useAppStore.getState();
  for (const [index, artifact] of artifacts.entries()) {
    const outputMessageId = index === 0 ? messageId : `media-output-${artifact.id}`;
    const existing = current.messages.find((message) => message.id === outputMessageId);
    if (existing && existing.conversationId !== root.conversationId) throw new Error('媒体消息身份不匹配，结果仍保留');
    if (!existing) current.addMessage({ id: outputMessageId, conversationId: root.conversationId, role: 'assistant',
      content: `候选图片 ${index + 1}/${expected}`, timestamp: artifact.createdAt, status: 'done' });
    const outputNodeId = options.targetNodeId ? current.nodes.find((node) => node.data.artifactId === artifact.id
      && node.data.status === 'success')?.id : undefined;
    current.updateMessage(outputMessageId, { mediaResult: artifact,
      mediaStatus: artifact.persistence === 'failed' ? 'paused' : 'succeeded', mediaError: undefined,
      canvasStatus: options.targetNodeId ? outputNodeId ? 'created' : 'failed' : 'none',
      canvasNodeId: outputNodeId ?? (index === 0 ? options.targetNodeId : undefined),
      canvasError: options.targetNodeId && !outputNodeId ? '原画布尚未回填，可继续保存原结果' : undefined,
    });
  }
  const allReady = canvasReady && artifacts.length >= expected && artifacts.every((artifact) => artifact.persistence !== 'failed');
  if (projectId && (!allReady || !delivery.taskReceipt)) {
    try {
      for (const artifact of artifacts) {
        const message = useAppStore.getState().messages.find((item) => item.mediaResult?.id === artifact.id
          && item.conversationId === root.conversationId);
        if (message) await persistMessage(message, projectId, root.conversationId);
        if (!isCurrent()) throw new Error('原项目或对话已变化，结果仍保留');
      }
    } catch (error) {
      if (delivery.taskReceipt) pauseMediaTask(delivery.taskReceipt, error, 'delivery_pending');
      return { complete: false, canvasReady, artifactIds: artifacts.map((artifact) => artifact.id) };
    }
  }
  await completeMediaMessageDelivery(messageId, artifacts[0], canvasReady);
  const pending = delivery.taskReceipt && getPendingTasksForProject(delivery.taskReceipt.projectId).some((task) =>
    sameMediaReceipt(delivery.taskReceipt, { projectId: task.projectId, nodeId: task.nodeId,
      taskId: task.taskId, attemptId: task.attemptId }));
  return { complete: !pending && canvasReady && artifacts.length >= expected
    && artifacts.every((artifact) => artifact.persistence !== 'failed'), canvasReady,
    artifactIds: artifacts.map((artifact) => artifact.id) };
}

async function recoverMediaMessage(task: PendingTask, urls: string[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const context = task.mediaContext;
  if (!context?.messageId || !context.conversationId) throw new Error('任务缺少原消息身份');
  const receipt = { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId };
  const isCurrent = () => {
    const state = useAppStore.getState();
    return !signal?.aborted && state.currentProjectId === task.projectId
      && state.messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId)
      && getPendingTasksForProject(task.projectId).some((saved) => saved.nodeId === task.nodeId
        && saved.taskId === task.taskId && saved.attemptId === task.attemptId);
  };
  if (!isCurrent()) throw new Error('请回到原项目和对话继续取回任务');
  const kind: MediaKind = task.nodeType === 'ai-audio' ? 'audio' : task.nodeType === 'ai-video' ? 'video' : 'image';
  if (kind === 'image' && (task.expectedImageOutputs ?? 1) > 1) {
    await recoverMediaMessageGroup(task, urls, signal);
    return;
  }
  const sourceUrl = urls[0];
  if (!sourceUrl) throw new Error('任务已完成，但没有可保存的媒体结果');
  const state = useAppStore.getState();
  const existing = state.messages.find((message) => message.id === context.messageId)?.mediaResult;
  const previous = existing?.taskReceipt?.taskId === task.taskId
    && existing.taskReceipt.attemptId === task.attemptId ? existing : undefined;
  const nodeId = context.deliveryMode === 'node+message' ? context.canvasNodeId ?? task.nodeId : undefined;
  const guard = nodeId ? registerCanvasDerivation(state, nodeId) : null;
  try {
    const persisted = await persistGeneratedMedia(sourceUrl, task.projectId, kind, previous?.id ?? `recovered-${task.attemptId ?? task.taskId}`, task.mediaDownloadAccess, signal);
    if (!isCurrent()) throw new Error('原项目或对话已变化，任务仍保留');
    if (persisted.status === 'failed') throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
    const artifact: MediaGenerationResult = {
      ...previous,
      ...(context.parameters ? { parameters: context.parameters } : {}),
      id: previous?.id ?? `recovered-${task.attemptId ?? task.taskId}`,
      kind,
      taskReceipt: receipt,
      deliveryMode: context.deliveryMode === 'message' ? 'chat' : previous?.deliveryMode ?? 'both',
      url: persisted.assetUrl || sourceUrl,
      sourceUrl: persisted.sourceUrl || sourceUrl,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: undefined,
      prompt: previous?.prompt ?? '',
      modelId: previous?.modelId ?? context.modelId ?? task.provider,
      provider: previous?.provider ?? task.provider,
      createdAt: previous?.createdAt ?? Date.now(),
    };
    const current = useAppStore.getState();
    const currentArtifact = current.messages.find((message) => message.id === context.messageId)?.mediaResult;
    const appendRecovered = !!currentArtifact && (currentArtifact.taskReceipt?.taskId !== task.taskId
      || currentArtifact.taskReceipt?.attemptId !== task.attemptId);
    const deliveryMessageId = appendRecovered ? `media-recovered-${task.nodeId}-${task.attemptId ?? task.taskId}` : context.messageId;
    if (appendRecovered) {
      if (!current.messages.some((message) => message.id === deliveryMessageId)) {
        current.addMessage({ id: deliveryMessageId, conversationId: context.conversationId, role: 'assistant',
          content: '已取回原媒体任务', timestamp: Date.now(), status: 'done' });
      }
      updatePendingTask(task.nodeId, { mediaContext: { ...context, messageId: deliveryMessageId } }, task.taskId, task.attemptId);
    }
    throwIfAborted(signal);
    const canvasReady = !nodeId || !!guard && isCanvasDerivationFresh(guard, current)
      && current.settleMediaPlaceholder(nodeId, artifact);
    throwIfAborted(signal);
    current.updateMessage(deliveryMessageId, {
      mediaResult: artifact, mediaStatus: 'succeeded', mediaError: undefined,
      canvasStatus: nodeId ? canvasReady ? 'created' : 'failed' : 'none', canvasNodeId: nodeId,
      canvasError: canvasReady ? undefined : '原画布已变化，结果已保存，任务尚待回填',
    });
    const message = useAppStore.getState().messages.find((item) => item.id === deliveryMessageId);
    if (message) await persistMessage(message, task.projectId, context.conversationId);
    if (!isCurrent()) throw new Error('原项目或对话已变化，任务仍保留');
    if (!canvasReady) {
      pauseMediaTask(receipt, undefined, 'canvas_changed');
      throw new Error('结果已保存，原画布尚未回填，任务已保留');
    }
    completeMediaNodeTask(receipt);
  } finally {
    if (guard) completeCanvasDerivation(guard);
  }
}

async function recoverMediaMessageGroup(task: PendingTask, urls: string[], signal?: AbortSignal): Promise<void> {
  const context = task.mediaContext!;
  const receipt: MediaTaskReceipt = { projectId: task.projectId, nodeId: task.nodeId,
    taskId: task.taskId, attemptId: task.attemptId };
  const state = useAppStore.getState();
  const original = state.messages.find((message) => message.id === context.messageId && message.conversationId === context.conversationId)!;
  const appendRecovered = original.mediaResult && !matchesMessageTaskReceipt(original.mediaResult.taskReceipt, task);
  const rootMessageId = appendRecovered ? `media-recovered-${task.nodeId}-${task.attemptId ?? task.taskId}` : original.id;
  const recoveryContext = appendRecovered ? { ...context, deliveryMode: 'message' as const, canvasNodeId: undefined } : context;
  if (appendRecovered) {
    if (!state.messages.some((message) => message.id === rootMessageId)) state.addMessage({ id: rootMessageId,
      conversationId: context.conversationId!, role: 'assistant',
      content: '原画布已变化，原任务候选仅保存到对话，可逐图添加到画布', timestamp: Date.now(), status: 'done' });
    updatePendingTask(task.nodeId, { mediaContext: { ...recoveryContext, messageId: rootMessageId } }, task.taskId, task.attemptId);
  }
  const nodeId = recoveryContext.deliveryMode === 'node+message' ? recoveryContext.canvasNodeId ?? task.nodeId : undefined;
  const guard = nodeId ? registerCanvasDerivation(state, nodeId) : null;
  const isCurrent = () => !signal?.aborted && useAppStore.getState().currentProjectId === task.projectId
    && useAppStore.getState().messages.some((message) => message.id === rootMessageId && message.conversationId === context.conversationId)
    && getPendingTasksForProject(task.projectId).some((saved) => sameMediaReceipt(receipt, { projectId: saved.projectId,
      nodeId: saved.nodeId, taskId: saved.taskId, attemptId: saved.attemptId }));
  try {
    const artifacts: MediaGenerationResult[] = [];
    for (const [index, sourceUrl] of urls.slice(0, task.expectedImageOutputs).entries()) {
      throwIfAborted(signal);
      const id = imageBatchArtifactId(receipt, index);
      const previous = useAppStore.getState().messages.find((message) => message.conversationId === context.conversationId
        && message.mediaResult?.id === id && matchesMessageTaskReceipt(message.mediaResult.taskReceipt, task))?.mediaResult;
      if (previous?.persistence === 'saved' && previous.filePath) {
        artifacts.push({ ...previous, taskReceipt: receipt,
          ...(recoveryContext.deliveryMode === 'message' ? { deliveryMode: 'chat' as const } : {}) });
        continue;
      }
      const persisted = await persistGeneratedMedia(sourceUrl, task.projectId, 'image', id, task.mediaDownloadAccess, signal);
      if (!isCurrent()) throw new Error('原项目或对话已变化，任务仍保留');
      artifacts.push({ ...previous, id, kind: 'image', taskReceipt: receipt,
        ...(context.parameters ? { parameters: context.parameters } : {}),
        deliveryMode: recoveryContext.deliveryMode === 'message' ? 'chat' : previous?.deliveryMode ?? 'both',
        url: persisted.assetUrl || sourceUrl, sourceUrl: persisted.sourceUrl || sourceUrl,
        filePath: persisted.filePath, persistence: persisted.status, persistError: persisted.error,
        prompt: previous?.prompt ?? (appendRecovered ? '' : original.mediaResult?.prompt) ?? '',
        modelId: previous?.modelId ?? context.modelId ?? task.provider, provider: previous?.provider ?? task.provider,
        createdAt: previous?.createdAt ?? Date.now(),
      });
    }
    if (!artifacts.length) throw new Error('任务已完成，但没有可保存的图片结果');
    const delivered = await deliverMediaMessageGroup(rootMessageId, { ...artifacts[0], additionalResults: artifacts.slice(1),
      expectedOutputCount: task.expectedImageOutputs }, { targetNodeId: nodeId, guard, signal, isCurrent,
        allowCanvas: !appendRecovered && (!nodeId || Boolean(guard)) });
    if (nodeId && delivered.canvasReady) useAppStore.getState().incrementRevision();
    if (!delivered.complete) throw new Error('部分候选图片仍待保存或回填，原结果已保留');
  } finally {
    if (guard) completeCanvasDerivation(guard);
  }
}

/** 按调用入口安装，避免模块加载时写入轮询运行时。 */
export function ensureMediaMessageRecoveryHandler(): void {
  registerMediaMessageRecoveryHandler(recoverMediaMessage);
}
