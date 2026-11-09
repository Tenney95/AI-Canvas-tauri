/**
 * 注册图片、视频和音频生成工具；媒体调用沿用项目默认值、统一运行时和固定 Policy 边界。
 */
import { useAppStore } from '../../../store/useAppStore';
import { isTauriEnv } from '../../fs/core';
import { comfyBaseUrlFor } from '../../comfyServers';
import { isRunningHubWorkflow, isCloudWorkflow, mediaProviderConfigId, workflowExecution } from '../../workflowExecutionService';
import { AUTODL_H3_WORKFLOW, validateWorkflowApiManifest, resolveWorkflowApiInputValues } from '../../workflowApi/autodlWorkflowManifest';
import { completeWorkflowApiNodeTask, workflowApiConnection } from '../../workflowApi/workflowApiAdapter';
import { getRunningHubModel, parseRunningHubModelParameter } from '../../ai/providers/runninghubModelManifest';
import { resolveImageParameterCapability } from '../../ai/mediaModelCapabilities';
import { assertSafeMediaParameterStrings } from '../../ai/modelCapabilityValidation';
import { resolveVideoModelCapability } from '../../ai/videoModelCapabilityResolver';
import { resolveRunningHubParameters, runningHubParameterKey } from '../../runninghubWorkflowService';
import { completeRunningHubNodeTask } from '../../ai/providers/runninghubWorkflow';
import type {
  AudioGenerationPurpose,
  MediaDeliveryMode,
  MediaGenerationIntent,
  MediaGenerationDelivery,
  MediaKind,
} from '../../../types/media';
import {
  findMediaModelOption,
  getMediaModelOptions,
} from '../../../components/nodes/shared/defaultModels';
import {
  extractModelMention,
  MEDIA_PERSIST_FAILED_MESSAGE,
  runMediaGeneration,
  deliverMediaMessageGroup,
  isMediaDeliveryGroup,
  mediaDeliveryResults,
  completeMediaMessageDelivery,
  ensureMediaMessageRecoveryHandler,
} from '../../ai/generationRuntime';
import { canResumeMediaTask, getPendingTasksForProject, isMediaTaskPausedError, readPendingMediaTaskViews, resumeMediaNodeTask } from '../../pollManager';
import { completeCanvasDerivation, isCanvasDerivationFresh } from '../../canvasDerivationGuard';
import { recordMcpOperationProgress } from '../../mcp/mcpOperationService';
import { generationInputSnapshot } from '../canvasNodeVersion';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from '../../projectExecutionContext';
import { listNativeMediaTasks, type NativeMediaTaskRecord } from '../../indexedDb/nativeMediaTaskRepository';
import { nativeImageBatchSummary } from '../../nativeImageBatch';
import { readNativeMediaRecoverySummary } from '../../nativeMediaRecoverySummary';
import { supportsNativeMediaProtocol } from '../../nativeMediaCapabilities';
import type { AgentToolDisplaySnapshot } from '../../../types/agent';
import {
  registerAgentTool,
  type AgentToolContext,
  type AgentToolExecutionResult,
} from '../toolRegistry';
import {
  failMediaPlaceholderLifecycle,
  MEDIA_PLACEHOLDER_STALE_ERROR,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
  type MediaPlaceholderLifecycle,
} from '../mediaPlaceholderLifecycle';

interface GenerateMediaInput extends Pick<MediaGenerationIntent, 'audioVoice' | 'audioFormat' | 'audioSpeed' | 'musicTitle' | 'musicLyrics'
  | 'imageQuality' | 'imageBackground' | 'videoFps' | 'generateAudio'> {
  kind: MediaKind;
  prompt: string;
  modelRef?: string;
  deliveryMode: MediaDeliveryMode;
  audioPurpose?: AudioGenerationPurpose;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  modelParameters?: Array<{ name: string; value: string }>;
  workflowInputs?: Array<{ nodeId: string; fieldName: string; value: string }>;
}

const MEDIA_PROMPT_DISPLAY_LIMIT = 1_000;
const AUDIO_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'];
const LEGACY_AUDIO_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

function hasAudioSettings(input: GenerateMediaInput): boolean {
  return [input.audioVoice, input.audioFormat, input.audioSpeed, input.musicTitle, input.musicLyrics]
    .some((value) => value !== undefined);
}

/** MCP 在创建占位节点前检查用户值及将要继承的图片默认值。 */
function assertSafeMediaToolParameters(input: GenerateMediaInput, projectId: string): void {
  assertSafeMediaParameterStrings(input);
  if (input.kind !== 'image') return;
  const store = useAppStore.getState();
  const settings = store.projects.find((project) => project.id === projectId)?.settings?.generation;
  const option = input.modelRef ? findMediaModelOption(input.modelRef, store.config.generalModels ?? [], store.config, store.workflows) : undefined;
  const capability = option && !option.workflowId && option.provider !== 'runninghub'
    ? resolveImageParameterCapability(option.value, option.provider, store.config) : undefined;
  assertSafeMediaParameterStrings({
    resolution: settings?.imageSize || undefined,
    aspectRatio: settings?.imageAspectRatio || undefined,
    imageQuality: input.imageQuality ?? capability?.defaultQuality,
    imageBackground: input.imageBackground ?? capability?.defaultBackground,
  });
}

function resolveMediaToolInput(
  input: GenerateMediaInput,
  context: { projectId: string; mode: string },
): GenerateMediaInput {
  assertSafeMediaToolParameters(input, context.projectId);
  const store = useAppStore.getState();
  const projectSettings = store.projects.find(
    (project) => project.id === context.projectId,
  )?.settings;
  const defaultModel = projectSettings?.defaultModels?.[input.kind];
  let modelRef = input.modelRef ?? defaultModel;
  if (!input.modelRef && context.mode === 'autonomous' && projectSettings?.modelAutoRouting) {
    const terms = input.prompt.toLowerCase().split(/[\s,，。;；、/]+/).filter((term) => term.length >= 2);
    const options = getMediaModelOptions(
      store.config.generalModels ?? [],
      store.config,
      store.workflows,
    ).filter((option) => option.mediaKind === input.kind);
    const ranked = options.map((option) => {
      const description = `${option.label} ${option.description ?? ''}`.toLowerCase();
      const relevance = terms.reduce((score, term) => score + (description.includes(term) ? 1 : 0), 0);
      return { option, score: relevance + (option.value === defaultModel ? 0.25 : 0) };
    }).sort((a, b) => b.score - a.score);
    modelRef = ranked[0]?.option.value ?? modelRef;
  }
  const resolved: GenerateMediaInput = {
    ...input,
    ...(modelRef ? { modelRef } : {}),
  };
  assertSafeMediaToolParameters(resolved, context.projectId);
  if (input.kind !== 'video') return resolved;
  const selectedModel = modelRef
    ? findMediaModelOption(
      modelRef,
      store.config.generalModels ?? [],
      store.config,
      store.workflows,
    )
    : undefined;
  // 自定义 API 的缺省值由该模型 capability / 上游接口决定，不能套用项目里为内置模型
  // 保存的 16:9、1080p、10 秒等偏好。用户本轮显式传入的值已经保留在 resolved 中。
  if (selectedModel?.provider === 'general' && !selectedModel.workflowId) return resolved;
  if (selectedModel && ['runninghubwf', 'runninghub', 'workflow-api'].includes(selectedModel.provider)) return resolved;
  const withProjectDefaults = {
    ...resolved,
    aspectRatio: input.aspectRatio ?? projectSettings?.generation?.videoAspectRatio,
    resolution: input.resolution ?? projectSettings?.generation?.videoResolution,
    duration: input.duration ?? projectSettings?.generation?.videoDuration,
  };
  assertSafeMediaToolParameters(withProjectDefaults, context.projectId);
  return withProjectDefaults;
}

function nodeMediaKind(nodeId: string): MediaKind | undefined {
  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  if (!node) return undefined;
  if (node.data.imageUrl || node.type === 'source-image' || node.type === 'ai-image') return 'image';
  if (node.data.videoUrl || node.type === 'source-video' || node.type === 'ai-video') return 'video';
  if (node.data.audioUrl || node.type === 'source-audio' || node.type === 'ai-audio') return 'audio';
  return undefined;
}

function buildMediaInputDisplay(input: GenerateMediaInput): AgentToolDisplaySnapshot {
  const nodeReferences = [...input.prompt.matchAll(/@\{([^:}]+):([^}]+)\}/g)]
    .map((match) => {
      const nodeId = match[1].split('/cell/')[0];
      const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
      return {
        kind: 'node' as const,
        id: nodeId,
        label: node?.data.label || match[2],
        mediaKind: nodeMediaKind(nodeId),
      };
    });
  const assetReferences = [...input.prompt.matchAll(/@asset\{[^}]+\}/g)]
    .map((_, index) => ({
      kind: 'asset' as const,
      id: `asset-${index + 1}`,
      label: `用户素材 ${index + 1}`,
      mediaKind: 'image' as const,
    }));
  const fields: NonNullable<AgentToolDisplaySnapshot['fields']> = [
    {
      label: '媒体类型',
      value: input.kind === 'image' ? '图片' : input.kind === 'video' ? '视频' : '音频',
    },
    { label: '模型', value: input.modelRef || '确认时选择' },
    {
      label: '输出位置',
      value: input.deliveryMode === 'chat'
        ? '对话'
        : input.deliveryMode === 'canvas'
          ? '画布'
          : '对话和画布',
    },
    { label: '提示词', value: input.prompt.trim().slice(0, MEDIA_PROMPT_DISPLAY_LIMIT) },
  ];
  if (input.kind === 'video') {
    fields.push(
      {
        label: '画面比例',
        value: input.aspectRatio || '模型默认',
        source: input.aspectRatio ? 'resolved' : 'model_default',
      },
      {
        label: '分辨率',
        value: input.resolution || '模型默认',
        source: input.resolution ? 'resolved' : 'model_default',
      },
      {
        label: '时长',
        value: input.duration !== undefined ? input.duration < 0 ? '自动' : `${input.duration} 秒` : '模型默认',
        source: input.duration !== undefined ? 'resolved' : 'model_default',
      },
    );
    if (input.videoFps !== undefined) fields.push({ label: '帧率', value: `${input.videoFps} FPS` });
    if (input.generateAudio !== undefined) fields.push({ label: '生成音轨', value: input.generateAudio ? '开启' : '关闭' });
  }
  if (input.kind === 'image') {
    if (input.imageQuality !== undefined) fields.push({ label: '生成质量', value: input.imageQuality });
    if (input.imageBackground !== undefined) fields.push({ label: '生成背景', value: input.imageBackground || '接口默认' });
  }
  if (input.kind === 'audio') {
    if (input.audioVoice !== undefined) fields.push({ label: '音色', value: input.audioVoice });
    if (input.audioFormat !== undefined) fields.push({ label: '音频格式', value: input.audioFormat });
    if (input.audioSpeed !== undefined) fields.push({ label: '语速倍率', value: String(input.audioSpeed) });
    if (input.musicTitle !== undefined) fields.push({ label: '音乐标题', value: input.musicTitle });
    if (input.musicLyrics !== undefined) fields.push({ label: '歌词', value: input.musicLyrics.slice(0, MEDIA_PROMPT_DISPLAY_LIMIT) });
  }
  return {
    fields,
    references: [...nodeReferences, ...assetReferences],
  };
}

function getAssistantMessageId(taskId: string): string | undefined {
  return useAppStore.getState().messages.find(
    (message) => message.agentTaskId === taskId && message.role === 'assistant',
  )?.id;
}

async function nativeMediaRows(canvasId: string, conversationId: string): Promise<NativeMediaTaskRecord[] | null> {
  const state = useAppStore.getState(), context = captureLegacyCanvasContext(state);
  if (!context && state.projectExecutionContext?.modelGeneration === 1) throw new Error('原生画布上下文尚未就绪，请重新读取原回执');
  if (!context || context.modelGeneration !== 1) return null;
  if (context.canvasId !== canvasId) throw new Error('只能查看原媒体画布');
  const records = await listNativeMediaTasks(context.projectId);
  if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原媒体画布已切换');
  return records.filter((row) => row.canvasId === context.canvasId && row.episodeId === context.episodeId
    && row.projectEpoch === context.projectEpoch && row.canvasEpoch === context.canvasEpoch
    && (!row.origin || row.origin.conversationId === conversationId));
}
type NativeResumeInput = { nodeId: string; taskId?: string; operationId?: string };
async function nativeToolRecovery(record: NativeMediaTaskRecord, conversationId: string) {
  const summary = await readNativeMediaRecoverySummary(record);
  return summary.canContinueGenerationStage && record.origin?.conversationId !== conversationId
    ? { ...summary, canContinueGenerationStage: false, recoveryAction: 'manual_review_only' as const } : summary;
}
async function executeNativeMediaResume(context: AgentToolContext, input: NativeResumeInput,
  records: NativeMediaTaskRecord[], allowUnstartedStage = false): Promise<AgentToolExecutionResult> {
  const described = await Promise.all(records.map(async (row) => ({ row, recovery: await nativeToolRecovery(row, context.conversationId) })));
  const matches = described.filter(({ row }) => row.nodeId === input.nodeId
    && (!input.operationId || row.operationId === input.operationId)
    && (row.submissionKind === 'sync' ? input.operationId === row.operationId && input.taskId === undefined
      : input.taskId === undefined ? input.operationId === row.operationId : row.remoteTaskId === input.taskId));
  if (matches.length !== 1) return { status: 'error', summary: '原媒体回执不唯一或不可续查',
    modelContent: '请重新读取原回执列表；未重新提交生成。', errorCode: 'MEDIA_RECOVERY_STALE' };
  const { row, recovery: before } = matches[0];
  const stageAllowed = allowUnstartedStage && row.recovery?.kind === 'builtin-audio' && row.origin?.conversationId === context.conversationId
    && row.status !== 'reviewed' && before.canContinueGenerationStage;
  if (!stageAllowed && (!before.canResume || allowUnstartedStage)) return { status: 'error',
    summary: before.canContinueGenerationStage ? '原操作还有未发送的付费阶段，请使用继续原生成阶段工具' : '原媒体回执不能自动续查，请先核对',
    modelContent: JSON.stringify({ operationId: row.operationId, recovery: before, ...(before.canContinueGenerationStage
      ? { nextTool: 'media_resume_generation_stage', mayIncurCost: true } : {}) }), errorCode: before.canContinueGenerationStage ? 'MEDIA_STAGE_CONFIRMATION_REQUIRED' : 'MEDIA_RECOVERY_STALE' };
  try {
    const { resumeNativeVolcengineTask } = await import('../../nativeVolcengineRecovery');
    await resumeNativeVolcengineTask(row.operationId, context.signal, { allowUnstartedStage: stageAllowed });
    const completed = (await listNativeMediaTasks(row.ownerProjectId)).find((entry) => entry.operationId === row.operationId);
    const recovery = completed && await readNativeMediaRecoverySummary(completed);
    return { status: completed?.status === 'delivered' ? 'success' : 'error', summary: completed?.status !== 'delivered'
      ? '原媒体操作尚未完成，原回执已保留' : recovery?.partial ? '已交付原操作的已确认产物，请核对部分失败或未知回执' : '已核验原任务并交付原结果',
      modelContent: JSON.stringify({ operationId: row.operationId, repeatedSubmittedStage: false, continuedOriginalStage: stageAllowed,
        batch: completed && nativeImageBatchSummary(completed), recovery }) };
  } catch (error) {
    const latest = (await listNativeMediaTasks(row.ownerProjectId).catch(() => [])).find((entry) => entry.operationId === row.operationId);
    return { status: 'error', summary: error instanceof Error ? error.message : '原任务续查未完成',
      modelContent: JSON.stringify({ operationId: row.operationId, repeatedSubmittedStage: false,
        ...(latest ? { recovery: await readNativeMediaRecoverySummary(latest) } : {}) }), errorCode: 'MEDIA_RECOVERY_PENDING' };
  }
}
export function registerMediaAgentTools(): Array<() => void> {
  return [
    registerAgentTool<Record<string, never>>({
      id: 'media_pending_tasks', title: '查看待恢复媒体任务', effect: 'read',
      description: '列出当前项目已保留的媒体任务身份、阶段和安全计数。canResume=true 可用 media_resume_task 续取；canContinueGenerationStage=true 用 media_resume_generation_stage 显式继续未发送的付费阶段。其他情况先核对原回执，不能重新调用 media_generate。不返回凭据、文件路径、请求正文或媒体地址。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      authorize: (context) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId, reason: '只能读取当前项目的待恢复任务' }),
      execute: async (context) => {
        const native = await nativeMediaRows(context.projectId, context.conversationId);
        if (native) {
          const summaries = await Promise.all(native.map((row) => nativeToolRecovery(row, context.conversationId)));
          return { status: 'success', summary: '已读取当前原生画布的媒体回执', modelContent: JSON.stringify(native.map((row, index) => ({
          operationId: row.operationId, nodeId: row.nodeId, ...(row.remoteTaskId ? { taskId: row.remoteTaskId } : {}),
          status: row.status, kind: row.category, submissionKind: row.submissionKind ?? 'async',
          recoveryAction: summaries[index].recoveryAction,
          provider: row.providerConfigId, canResume: summaries[index].canResume, canContinueGenerationStage: summaries[index].canContinueGenerationStage,
          batch: nativeImageBatchSummary(row), recovery: summaries[index],
        }))) }; }
        const view = readPendingMediaTaskViews([context.projectId]);
        return view.status === 'ok' ? { status: 'success', summary: '已只读查询待恢复媒体任务', modelContent: JSON.stringify(view.tasks) }
          : { status: 'error', summary: '原待恢复任务源不可读或包含未知记录，已保留原数据，请先核实，勿重投',
            modelContent: '待恢复任务源未被修改，不能将此状态当作没有已提交任务。', errorCode: view.errorCode };
      },
    }),
    registerAgentTool<{ nodeId: string; taskId?: string; operationId?: string }>({
      id: 'media_resume_task', title: '续取原媒体任务', effect: 'canvas_write',
      description: '续取原媒体操作，不提交新的付费阶段。新项目使用 media_pending_tasks 中 canResume=true 的 nodeId 和 operationId；同步任务只投递已核验的本机产物。需要首次提交后续音乐阶段时使用 media_resume_generation_stage。旧任务仍使用 nodeId 和 taskId。对话任务须打开原对话。',
      inputSchema: { type: 'object', required: ['nodeId'], additionalProperties: false,
        properties: { nodeId: { type: 'string', minLength: 1, maxLength: 300 }, taskId: { type: 'string', minLength: 1, maxLength: 256 },
          operationId: { type: 'string', minLength: 1, maxLength: 128 } } },
      authorize: (context, input) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId
        && (captureLegacyCanvasContext(useAppStore.getState())?.modelGeneration === 1
          || getPendingTasksForProject(context.projectId).some((task) => task.nodeId === input.nodeId && task.taskId === input.taskId && canResumeMediaTask(task))),
      reason: '只能续取当前项目已保存的同一个媒体任务' }),
      execute: async (context, input) => {
        if (context.signal.aborted) return { status: 'error', summary: '已停止本次等待', modelContent: '未重新提交生成，也未取消远端任务。', errorCode: 'MEDIA_RECOVERY_STOPPED' };
        const native = await nativeMediaRows(context.projectId, context.conversationId);
        if (native) return executeNativeMediaResume(context, input, native);
        const original = getPendingTasksForProject(context.projectId).find((task) => task.nodeId === input.nodeId && task.taskId === input.taskId
          && canResumeMediaTask(task));
        if (useAppStore.getState().currentProjectId !== context.projectId || !original) {
          return { status: 'error', summary: '原任务身份已变化', modelContent: '请重新读取待恢复任务列表，不会续查同节点的新任务。', errorCode: 'MEDIA_RECOVERY_STALE' };
        }
        try {
          ensureMediaMessageRecoveryHandler();
          await resumeMediaNodeTask(input.nodeId, context.signal);
        } catch (error) {
          if (context.signal.aborted) return { status: 'error', summary: '已停止本次等待',
            modelContent: '未重新提交生成，也未取消远端任务。', errorCode: 'MEDIA_RECOVERY_STOPPED' };
          const state = useAppStore.getState();
          const message = state.messages.find((item) => item.id === original.mediaContext?.messageId
            && item.conversationId === original.mediaContext?.conversationId);
          const pending = getPendingTasksForProject(context.projectId).some((task) => task.nodeId === original.nodeId
            && task.taskId === original.taskId && task.attemptId === original.attemptId);
          const detail = error instanceof Error ? error.message : '原任务未返回可交付结果';
          if (state.currentProjectId === context.projectId && message && !pending
            && (!message.mediaResult || message.mediaResult.taskReceipt?.taskId === original.taskId
              && message.mediaResult.taskReceipt.attemptId === original.attemptId)) {
            state.updateMessage(message.id, { mediaStatus: 'failed', mediaError: detail });
          }
          return { status: 'error', summary: detail, modelContent: detail, errorCode: 'MEDIA_RECOVERY_FAILED' };
        }
        if (context.signal.aborted) return { status: 'error', summary: '已停止本次等待',
          modelContent: '未重新提交生成，也未取消远端任务。', errorCode: 'MEDIA_RECOVERY_STOPPED' };
        const pending = getPendingTasksForProject(context.projectId).some((task) => task.nodeId === input.nodeId && task.taskId === input.taskId);
        return { status: pending ? 'error' : 'success', summary: pending ? '原任务仍保留，查询或保存尚未完成' : '原任务已取回并交付',
          modelContent: pending ? '任务仍保留；请核对原项目、对话及连接后继续查询，不要重新提交生成。' : '已查询并保存原任务结果，没有重新提交生成。',
          ...(pending ? { errorCode: 'MEDIA_RECOVERY_PENDING' } : {}) };
      },
    }),
    registerAgentTool<{ nodeId: string; operationId: string }>({
      id: 'media_resume_generation_stage', title: '继续原媒体生成阶段', effect: 'media_generation',
      description: '继续原音乐操作中有未发送证明的后续阶段，可能产生费用。只接受 media_pending_tasks 返回 canContinueGenerationStage=true 的原 nodeId/operationId，不接受新模型、提示词或参数；不重投已提交阶段，结束跟踪或状态未知时拒绝。',
      inputSchema: { type: 'object', required: ['nodeId', 'operationId'], additionalProperties: false,
        properties: { nodeId: { type: 'string', minLength: 1, maxLength: 300 }, operationId: { type: 'string', minLength: 1, maxLength: 128 } } },
      authorize: (context) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId
        && captureLegacyCanvasContext(useAppStore.getState())?.modelGeneration === 1, reason: '只能继续当前原生画布中原对话的已保留生成阶段' }),
      summarizeInput: (input) => `继续原操作 ${input.operationId} 的未发送生成阶段，可能产生费用`,
      execute: async (context, input) => {
        if (context.signal.aborted) return { status: 'error', summary: '已停止本次等待', modelContent: '未提交后续阶段。', errorCode: 'MEDIA_RECOVERY_STOPPED' };
        const records = await nativeMediaRows(context.projectId, context.conversationId);
        if (!records) return { status: 'error', summary: '原生成阶段不属于当前原生画布', modelContent: '未提交后续阶段。', errorCode: 'MEDIA_RECOVERY_STALE' };
        return executeNativeMediaResume(context, input, records, true);
      },
    }),
    registerAgentTool<{ modelRef: string }>({
      id: 'media_model_parameters', title: '读取模型专属参数', effect: 'read',
      description: '读取当前可选图片、视频模型的参数能力；RunningHub 返回专属参数，工作流使用 media_workflow_parameters。未声明的选项不代表支持。',
      inputSchema: { type: 'object', required: ['modelRef'], additionalProperties: false, properties: { modelRef: { type: 'string', minLength: 1, maxLength: 240 } } },
      authorize: (context) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId, reason: '只能读取当前项目可用的模型' }),
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        const option = findMediaModelOption(input.modelRef, store.config.generalModels ?? [], store.config, store.workflows);
        if (option?.provider === 'runninghub') {
          const model = getRunningHubModel(input.modelRef, true);
          if (model) return { status: 'success', summary: `已读取 ${model.label} 参数`, modelContent: JSON.stringify(model) };
        }
        if (!option || option.workflowId || !['image', 'video'].includes(option.mediaKind)) {
          return { status: 'error', summary: '未找到可用的图片或视频模型', modelContent: '请先启用模型；工作流使用 media_workflow_parameters', errorCode: 'MEDIA_MODEL_NOT_FOUND' };
        }
        const image = option.mediaKind === 'image' ? resolveImageParameterCapability(option.value, option.provider, store.config) : undefined;
        const video = option.mediaKind === 'video' ? resolveVideoModelCapability(option.value, store.config) : undefined;
        const capability = image ? {
          resolutions: image.resolutions, defaultResolution: image.defaultResolution,
          ratios: image.ratios, defaultRatio: image.defaultRatio,
          qualities: image.qualities, defaultQuality: image.defaultQuality,
          backgrounds: image.backgrounds, defaultBackground: image.defaultBackground,
          backgroundIsFixed: image.backgroundIsFixed,
          supportsBatch: image.supportsBatch, maxBatchCount: image.maxBatchCount,
          supportsImageReference: image.supportsImageReference, maxImageReferences: image.maxImageReferences,
        } : video;
        return { status: 'success', summary: `已读取 ${option.label} 参数`, modelContent: JSON.stringify({
          modelRef: option.value, kind: option.mediaKind, capability: capability ?? null,
          note: '仅展示已声明的能力；缺省表示待确认。',
        }) };
      },
    }),
    registerAgentTool<{ modelRef: string }>({
      id: 'media_workflow_parameters', title: '读取云工作流参数', effect: 'read',
      description: '读取已保存云工作流的输出类型、参数名称、默认值与素材映射，供 media_generate 使用。',
      inputSchema: { type: 'object', required: ['modelRef'], additionalProperties: false, properties: { modelRef: { type: 'string', minLength: 1, maxLength: 240 } } },
      authorize: (context) => ({ allowed: context.projectId === useAppStore.getState().currentProjectId, reason: '只能读取当前项目可用的工作流' }),
      execute: async (_context, input) => {
        const store = useAppStore.getState();
        const option = findMediaModelOption(input.modelRef, store.config.generalModels ?? [], store.config, store.workflows);
        const workflow = store.workflows.find((item) => item.id === option?.workflowId);
        if (workflow?.adapterType === 'workflow-api') {
          validateWorkflowApiManifest(workflow.workflowApi);
          if (workflow.workflowApi.version === 2) return { status: 'success', summary: `已读取 ${workflow.name} 的参数`, modelContent: JSON.stringify({
            workflowId: workflow.id, outputType: workflow.workflowApi.outputKind, references: workflow.workflowApi.references,
            prompt: workflow.workflowApi.prompt, parameters: Object.entries(workflow.workflowApi.parameters).map(([name, spec]) => ({
              nodeId: 'workflow', fieldName: name, type: spec.type, required: spec.required ?? false, defaultValue: spec.default,
              label: spec.label, min: spec.min, max: spec.max, options: spec.options,
            })), usage: '通过 workflowInputs 传入工作流声明的参数；nodeId 为 workflow，fieldName 为参数名。素材在 prompt 中显式引用。不要同时传通用 duration/resolution/aspectRatio。',
          }) };
          const defaults = resolveWorkflowApiInputValues(workflow.workflowApi.defaults);
          return { status: 'success', summary: `已读取 ${workflow.name} 的参数`, modelContent: JSON.stringify({
            workflowId: workflow.id, outputType: 'video', capability: AUTODL_H3_WORKFLOW.capability, defaults,
            parameters: [{ nodeId: 'workflow', fieldName: 'seed', type: 'number', required: false, defaultValue: defaults.seed }],
            usage: '时长、分辨率和比例使用 duration/resolution/aspectRatio；可选 seed 放入 workflowInputs。图片与音频在 prompt 中显式引用，按顺序传入。',
          }) };
        }
        if (!isRunningHubWorkflow(workflow) || !workflow?.runninghub) return { status: 'error', summary: '未找到已保存的云工作流', modelContent: '请先在工作流管理中导入 RunningHub 工作流或 AI 应用', errorCode: 'RUNNINGHUB_WORKFLOW_NOT_FOUND' };
        return { status: 'success', summary: `已读取 ${workflow.name} 的参数`, modelContent: JSON.stringify({ workflowId: workflow.id, outputType: workflow.category,
          parameters: resolveRunningHubParameters(workflow.runninghub.parameters).map((field) => ({ ...field, defaultValue: typeof field.defaultValue === 'string' ? field.defaultValue.slice(0, 1200) : field.defaultValue })),
          usage: 'workflowInputs 仅设置 source=value 的参数。主提示词使用本次 prompt，图片、视频和音频在 prompt 中显式引用，按各类型顺序绑定；不要传导入示例中的提示词或文件名。',
        }) };
      },
    }),
    registerAgentTool<GenerateMediaInput>({
      id: 'media_generate',
      title: '生成媒体内容',
      description: [
        '生成图片、视频、音乐或语音。用户本轮已提供 @model 时把模型 ID 写入 modelRef；',
        '未提供 @model 时省略 modelRef，运行时优先使用项目默认模型。',
        '若项目已设置该类型默认模型则直接使用；自主模式开启自动路由后，可依据模型能力与用户自定义说明选择。',
        '图片 prompt 可以原样包含用户提供的 @{nodeId:label} 或 @asset{path} 引用，',
        '运行时会自动解析为参考图输入；无需先读取节点原 prompt，也不要要求用户重新描述图片。',
        '图片可按模型能力传入 imageQuality、imageBackground（空字符串表示接口默认）；视频可传 aspectRatio、resolution、duration、videoFps、generateAudio。自动时长只允许该模型声明的负数值。',
        '自定义 API 省略视频参数时由模型 capability / 接口默认值决定，内置模型与工作流才锁定项目默认值。',
        '音频可显式传 audioVoice、audioFormat、audioSpeed，音乐可传 musicTitle 和 musicLyrics；音色使用所选模型公布的真实 ID，省略时沿用模型默认。RunningHub 与工作流仍使用各自参数。',
        '协作模式由 Policy 请求确认，自主模式直接执行。deliveryMode 控制结果显示在对话、画布或两者。',
        'MCP付费调用建议在 tools_call 信封同级传 operationKey（不要放 arguments）；started 仅表示进入本地生成调用，不证明服务商已受理。回执 partial/unknown 时只读核实并续取原媒体任务，不能换 key 重投。',
      ].join(''),
      inputSchema: {
        type: 'object',
        required: ['kind', 'prompt', 'deliveryMode'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['image', 'video', 'audio'] },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 12000,
            description: '生成或编辑要求；图片编辑时必须原样保留用户给出的节点或资产引用标记。',
          },
          modelRef: { type: 'string', minLength: 1, maxLength: 240 },
          modelParameters: {
            type: 'array', maxItems: 100, description: 'RunningHub 标准模型专属参数；先用 media_model_parameters 读取合同。值为字符串，数组使用 JSON 字符串数组，数字/布尔值由本地还原。',
            items: { type: 'object', required: ['name', 'value'], additionalProperties: false, properties: {
              name: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 12000 },
            } },
          },
          workflowInputs: {
            type: 'array', maxItems: 200, description: 'RunningHub 参数覆盖；先用 media_workflow_parameters 读取参数定义，数字和布尔值以字符串传入并由本地恢复类型。',
            items: { type: 'object', required: ['nodeId', 'fieldName', 'value'], additionalProperties: false, properties: {
              nodeId: { type: 'string', minLength: 1, maxLength: 120 }, fieldName: { type: 'string', minLength: 1, maxLength: 160 }, value: { type: 'string', maxLength: 12000 },
            } },
          },
          deliveryMode: { type: 'string', enum: ['chat', 'canvas', 'both'] },
          audioPurpose: { type: 'string', enum: ['music', 'speech'] },
          audioVoice: { type: 'string', minLength: 1, maxLength: 256, description: '所选语音模型公布的音色 ID，不含控制字符。' },
          audioFormat: { type: 'string', enum: AUDIO_FORMATS },
          audioSpeed: { type: 'number', minimum: 0.25, maximum: 4 },
          musicTitle: { type: 'string', maxLength: 120 },
          musicLyrics: { type: 'string', maxLength: 8000 },
          imageQuality: { type: 'string', minLength: 1, maxLength: 64, description: '图片生成质量，必须由所选模型明确声明。' },
          imageBackground: { type: 'string', maxLength: 64, description: '图片背景；空字符串表示接口默认。' },
          videoFps: { type: 'number', minimum: 1, maximum: 240, description: '视频帧率，必须由所选模型明确声明。' },
          generateAudio: { type: 'boolean', description: '是否生成视频音轨；仅用于明确支持开关的模型。' },
          aspectRatio: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: '视频画面比例；用户明确指定时传入，合法值由所选模型 capability 校验。',
          },
          resolution: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: '视频分辨率档位；用户明确指定时传入，合法值由所选模型 capability 校验。',
          },
          duration: {
            type: 'number',
            maximum: 3600,
            description: '视频时长，单位秒；负数仅允许所选模型声明的自动时长值。',
          },
        },
      },
      effect: 'media_generation',
      resolveInput: resolveMediaToolInput,
      authorize: (context, input) => {
        const store = useAppStore.getState();
        if ((context.executionContext ?? context.projectScope)?.modelGeneration === 1) {
          const option = input.modelRef ? findMediaModelOption(input.modelRef, store.config.generalModels ?? [], store.config, store.workflows) : undefined;
          const generalModel = store.config.generalModels?.find((model) => model.id === input.modelRef?.replace(/^general\//, ''));
          const supported = !!option && supportsNativeMediaProtocol(input.kind, option.provider, option.workflowId, store.workflows);
          if (!supported || generalModel && generalModel.category !== input.kind) return { allowed: false, reason: '此模型尚未接入新项目原回执续查，未提交生成' };
        }
        try { assertSafeMediaToolParameters(input, context.projectId); } catch {
          return { allowed: false, reason: '媒体参数格式无效，请使用所选模型声明的参数值' };
        }
        if (hasAudioSettings(input) && input.kind !== 'audio') {
          return { allowed: false, reason: '音频参数只能用于音频生成' };
        }
        if (input.kind !== 'image' && (input.imageQuality !== undefined || input.imageBackground !== undefined)) {
          return { allowed: false, reason: '图片质量和背景只能用于图片生成' };
        }
        if (input.kind !== 'video' && (input.videoFps !== undefined || input.generateAudio !== undefined)) {
          return { allowed: false, reason: '帧率和生成音轨只能用于视频生成' };
        }
        if (input.audioVoice !== undefined && (typeof input.audioVoice !== 'string' || !input.audioVoice.trim()
          || input.audioVoice !== input.audioVoice.trim() || input.audioVoice.length > 256
          || Array.from(input.audioVoice).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || (code >= 127 && code <= 159);
          }))) {
          return { allowed: false, reason: 'audioVoice 必须是 1–256 字符且不含控制字符的音色 ID' };
        }
        if (input.audioPurpose === 'speech' && (input.musicTitle !== undefined || input.musicLyrics !== undefined)) {
          return { allowed: false, reason: '音乐标题和歌词只能用于音乐生成' };
        }
        if (input.audioPurpose === 'music' && (input.audioVoice !== undefined || input.audioFormat !== undefined || input.audioSpeed !== undefined)) {
          return { allowed: false, reason: '音色、格式和语速参数只能用于语音生成' };
        }
        const task = store.agentTasks.find((item) => item.id === context.taskId);
        const mentionedModel = task ? extractModelMention(task.goal) : undefined;
        if (mentionedModel && mentionedModel !== input.modelRef) {
          return {
            allowed: false,
            reason: '工具使用的媒体模型与用户本轮 @model 选择不一致',
          };
        }
        if (input.modelRef) {
          const option = findMediaModelOption(
            input.modelRef,
            store.config.generalModels ?? [],
            store.config,
            store.workflows,
          );
          if (!option || option.mediaKind !== input.kind) {
            return { allowed: false, reason: '所选模型与本次媒体类型不兼容' };
          }
          if (hasAudioSettings(input) && (option.workflowId || option.provider === 'runninghub')) {
            return { allowed: false, reason: 'RunningHub 和工作流使用自己的参数，请通过 modelParameters 或 workflowInputs 设置音频参数' };
          }
          if ((option.workflowId || option.provider === 'runninghub')
            && [input.imageQuality, input.imageBackground, input.videoFps, input.generateAudio].some((value) => value !== undefined)) {
            return { allowed: false, reason: 'RunningHub 和工作流使用自己的参数定义，请通过 modelParameters 或 workflowInputs 设置参数' };
          }
          if (input.audioVoice !== undefined && option.provider !== 'general' && !LEGACY_AUDIO_VOICES.includes(input.audioVoice)) {
            return { allowed: false, reason: '所选模型不支持该音色，请使用当前厂商公布的音色' };
          }
          if (input.modelParameters?.length) {
            const model = option.provider === 'runninghub' ? getRunningHubModel(input.modelRef, true) : undefined;
            if (!model) return { allowed: false, reason: '所选模型不支持 RunningHub 专属参数' };
            if (new Set(input.modelParameters.map((field) => field.name)).size !== input.modelParameters.length) return { allowed: false, reason: '模型参数包含重复字段' };
            try {
              for (const entry of input.modelParameters) {
                const field = model.parameters.find((field) => field.name === entry.name);
                if (!field) return { allowed: false, reason: '模型参数不在当前合同中' };
                parseRunningHubModelParameter(field, entry.value);
              }
            } catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : '模型参数无效' }; }
          }
          if (option.workflowId) {
            const workflow = store.workflows.find((item) => item.id === option.workflowId);
            if ((isRunningHubWorkflow(workflow) || workflow?.workflowApi?.version === 2) && [input.aspectRatio, input.resolution, input.duration].some((value) => value !== undefined)) return { allowed: false, reason: '云工作流使用自己的参数定义，请通过 workflowInputs 设置比例、分辨率或时长' };
            if (input.workflowInputs && new Set(input.workflowInputs.map(runningHubParameterKey)).size !== input.workflowInputs.length) return { allowed: false, reason: '工作流参数包含重复节点/字段' };
            if (isRunningHubWorkflow(workflow)) {
              if (!store.config.providers[mediaProviderConfigId(option.provider, workflow)]?.apiKey) return { allowed: false, reason: '请先配置该 RunningHub 工作流使用的 API Key' };
            } else if (workflow?.adapterType === 'workflow-api') {
              try { validateWorkflowApiManifest(workflow.workflowApi); workflowApiConnection(store.config.providers[workflow.workflowApi.connectionId], workflow.workflowApi); }
              catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : '工作流连接无效' }; }
            } else {
              try {
                if (!comfyBaseUrlFor(option.workflowId)) return { allowed: false, reason: '请先在设置里配置 ComfyUI 服务地址' };
              } catch (error) {
                return { allowed: false, reason: error instanceof Error ? error.message : 'ComfyUI 服务器配置无效' };
              }
            }
          } else if (option.provider === 'general') {
            const generalModel = (store.config.generalModels ?? []).find(
              (model) => `general/${model.id}` === option.value,
            );
            const provider = generalModel
              ? store.config.providers[generalModel.providerConfigId]
              : undefined;
            if (!generalModel?.modelId || !provider?.baseUrl) {
              return { allowed: false, reason: `模型“${option.label}”的接口配置不完整` };
            }
          } else if (option.provider === 'dreamina') {
            if (!store.config.dreaminaAuth?.loggedIn) {
              return { allowed: false, reason: '请先登录即梦账号' };
            }
          } else if (option.provider === 'muse') {
            const connection = store.config.providers.muse;
            if (!isTauriEnv() || !connection || (connection.catalogId && connection.catalogId !== 'muse')) {
              return { allowed: false, reason: '请在桌面应用的设置中连接 Muse 并完成网页登录' };
            }
          } else if (!store.config.providers[mediaProviderConfigId(option.provider)]?.apiKey) {
            return { allowed: false, reason: `请先配置 ${option.provider} 的 API Key` };
          }
        }
        if (
          input.deliveryMode !== 'chat'
          && store.currentProjectId !== context.projectId
        ) {
          return {
            allowed: false,
            reason: '目标项目当前未加载，不能把媒体结果写入其他项目的画布',
          };
        }
        if (input.kind === 'audio' && !input.audioPurpose) {
          return {
            allowed: false,
            reason: '音频生成必须说明用途是音乐还是语音',
          };
        }
        if (
          input.kind !== 'video'
          && (input.aspectRatio !== undefined || input.resolution !== undefined || input.duration !== undefined)
        ) {
          return { allowed: false, reason: '比例、分辨率和时长参数只适用于视频生成' };
        }
        return { allowed: true };
      },
      summarizeInput: (input) => {
        const label = input.kind === 'image'
          ? '图片'
          : input.kind === 'video'
            ? '视频'
            : input.audioPurpose === 'music'
              ? '音乐'
              : '语音';
        const referenceCount = input.prompt.match(/@asset\{[^}]+\}|@\{[^:}]+:[^}]+\}/g)?.length ?? 0;
        return `${input.modelRef ? `使用 ${input.modelRef}` : '选择模型后'}${referenceCount > 0 ? `，基于 ${referenceCount} 个参考输入` : ''}生成${label}，输出到${
          input.deliveryMode === 'chat'
            ? '对话'
            : input.deliveryMode === 'canvas'
              ? '画布'
              : '对话和画布'
        }`;
      },
      buildInputDisplay: buildMediaInputDisplay,
      execute: async (context, input): Promise<AgentToolExecutionResult> => {
        const store = useAppStore.getState();
        try { assertSafeMediaToolParameters(input, context.projectId); } catch {
          return { status: 'error', summary: '媒体参数格式无效', modelContent: '请使用所选模型声明的参数值', errorCode: 'MEDIA_PARAMETER_INVALID' };
        }
        if (!input.modelRef) {
          return {
            status: 'error',
            summary: '未选择媒体模型',
            modelContent: '未选择媒体模型',
            errorCode: 'AGENT_MEDIA_MODEL_REQUIRED',
          };
        }
        const referencedNodeIds = [...input.prompt.matchAll(/@\{([^:}]+):[^}]+\}/g)]
          .map((match) => match[1].split('/cell/')[0]);
        const missingNodeId = referencedNodeIds.find(
          (nodeId) => !store.nodes.some((node) => node.id === nodeId),
        );
        if (missingNodeId) {
          return {
            status: 'error',
            summary: '参考节点已不存在，请重新选择图片',
            modelContent: '参考节点已不存在，请重新选择图片',
            errorCode: 'AGENT_MEDIA_REFERENCE_NOT_FOUND',
          };
        }
        const assistantMessageId = getAssistantMessageId(context.taskId);
        const originalNativeContext = store.projectExecutionContext?.modelGeneration === 1 ? captureLegacyCanvasContext(store) : null;
        if (!assistantMessageId) {
          return {
            status: 'error',
            summary: '未找到承载媒体结果的助手消息',
            modelContent: '未找到承载媒体结果的助手消息',
            errorCode: 'AGENT_MEDIA_MESSAGE_NOT_FOUND',
          };
        }
        if (store.projectExecutionContext?.modelGeneration === 1 && store.messages.some((message) => message.id === assistantMessageId && message.mediaResult)) {
          return { status: 'error', summary: '此消息已有媒体产物，请从新消息发起生成', modelContent: '原产物保留，未提交新的生成请求。', errorCode: 'AGENT_MEDIA_SLOT_OCCUPIED' };
        }

        const intent: MediaGenerationIntent = {
          kind: input.kind,
          prompt: input.prompt,
          modelRef: input.modelRef,
          deliveryMode: input.deliveryMode,
          audioPurpose: input.audioPurpose,
          audioVoice: input.audioVoice,
          audioFormat: input.audioFormat,
          audioSpeed: input.audioSpeed,
          musicTitle: input.musicTitle,
          musicLyrics: input.musicLyrics,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          duration: input.duration,
          imageQuality: input.imageQuality,
          imageBackground: input.imageBackground,
          videoFps: input.videoFps,
          generateAudio: input.generateAudio,
          runninghubModelParameters: input.modelParameters ? Object.fromEntries(input.modelParameters.map((field) => [field.name, field.value])) : undefined,
          workflowInputs: input.workflowInputs ? Object.fromEntries(input.workflowInputs.map((field) => [runningHubParameterKey(field), field.value])) : undefined,
        };
        const needsCanvas = input.deliveryMode === 'canvas' || input.deliveryMode === 'both';
        const tracksOperation = Boolean(store.agentTasks?.some((task) => task.id === context.taskId && task.mcpOperation));
        const initialRevision = store.getCurrentRevision();
        const initialProjectSettings = JSON.stringify(store.projects.find((project) => project.id === context.projectId)?.settings);
        let targetNodeId: string | undefined;
        let placeholderLifecycle: MediaPlaceholderLifecycle | null = null;
        let enteredGeneration = false;
        let generatedArtifact: MediaGenerationDelivery | undefined;
        let deliveredToCanvas = false;
        let receiptUnconfirmed = false;
        let placeholderDataBeforeWait: unknown;
        let placeholderGenerationInput: string | undefined;
        const assertOperationFresh = (checkWaitData = true) => {
          if (context.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
          const current = useAppStore.getState();
          const placeholder = targetNodeId ? current.nodes.find((node) => node.id === targetNodeId) : undefined;
          if (current.currentProjectId !== context.projectId
            || JSON.stringify(current.projects.find((project) => project.id === context.projectId)?.settings) !== initialProjectSettings
            || !current.messages.some((message) => message.id === assistantMessageId && message.conversationId === context.conversationId)
            || !current.agentTasks?.some((task) => task.id === context.taskId && task.mcpOperation
              && !['paused', 'stopped', 'failed', 'completed'].includes(task.status))
            || (targetNodeId !== undefined && !placeholderLifecycle)
            || (targetNodeId !== undefined && checkWaitData && placeholder?.data !== placeholderDataBeforeWait)
            || (placeholder && generationInputSnapshot(placeholder.data,
              current.projects.find((project) => project.id === context.projectId)?.settings) !== placeholderGenerationInput)
            || (placeholderLifecycle ? !isCanvasDerivationFresh(placeholderLifecycle.guard, current)
              : needsCanvas && current.getCurrentRevision() !== initialRevision)) {
            throw new Error('媒体操作的项目、消息或画布租约已变化，请只读核实');
          }
        };
        try {
          if (tracksOperation) {
            // 占位本身也是写入；先留下消息身份，不能在持久化失败后继续创建或提交。
            await recordMcpOperationProgress(context.taskId, { mediaStage: 'preparing', messageId: assistantMessageId, persistence: 'pending' });
            assertOperationFresh();
          }
          if (needsCanvas) {
            const current = useAppStore.getState();
            targetNodeId = current.createMediaPlaceholder(intent);
            const cloud = current.workflows?.find((workflow) => isCloudWorkflow(workflow) && workflowExecution(workflow).model === input.modelRef);
            if (!cloud && input.modelRef && getRunningHubModel(input.modelRef)) current.updateNodeDataTransient(targetNodeId, { provider: 'runninghub', model: input.modelRef, runninghubModelParameters: intent.runninghubModelParameters });
            if (cloud) current.updateNodeDataTransient(targetNodeId, { ...workflowExecution(cloud), workflowInputs: intent.workflowInputs });
            placeholderLifecycle = registerMediaPlaceholderLifecycle(targetNodeId);
            const placeholder = useAppStore.getState().nodes.find((node) => node.id === targetNodeId);
            placeholderGenerationInput = placeholder && generationInputSnapshot(placeholder.data,
              useAppStore.getState().projects.find((project) => project.id === context.projectId)?.settings);
          }
          store.updateMessage(assistantMessageId, {
            mediaStatus: 'queued', mediaError: undefined, canvasStatus: needsCanvas ? 'pending' : 'none',
            canvasNodeId: targetNodeId, canvasError: undefined,
          });
          if (tracksOperation) {
            placeholderDataBeforeWait = targetNodeId ? useAppStore.getState().nodes.find((node) => node.id === targetNodeId)?.data : undefined;
            await recordMcpOperationProgress(context.taskId, { mediaStage: 'started', messageId: assistantMessageId,
              ...(targetNodeId ? { canvasNodeId: targetNodeId } : {}) });
            assertOperationFresh();
          }
          enteredGeneration = true;
          useAppStore.getState().updateMessage(assistantMessageId, {
            mediaStatus: 'generating',
          });
          const result = await runMediaGeneration(
            intent,
            context.projectId,
            context.signal,
            targetNodeId,
            { projectId: context.projectId, conversationId: context.conversationId, messageId: assistantMessageId, deliveryMode: input.deliveryMode },
          );
          generatedArtifact = result;
          if (tracksOperation) {
            // Provider运行态可变化；原始可编辑输入必须仍与进入调用前一致。
            assertOperationFresh(false);
            placeholderDataBeforeWait = targetNodeId ? useAppStore.getState().nodes.find((node) => node.id === targetNodeId)?.data : undefined;
            try {
              await recordMcpOperationProgress(context.taskId, { mediaStage: 'generated', artifactId: result.id, persistence: result.persistence });
            } catch { receiptUnconfirmed = true; }
            // 新的持久化await期间也可能取消或切项目；已生成的产物交给下方partial分支保留。
            assertOperationFresh();
          }
          if (context.signal.aborted) {
            throw new DOMException('请求已取消', 'AbortError');
          }
          const currentStore = useAppStore.getState();
          if (isMediaDeliveryGroup(result)) {
            let grouped: Awaited<ReturnType<typeof deliverMediaMessageGroup>>;
            try {
              grouped = await deliverMediaMessageGroup(assistantMessageId, result, { targetNodeId,
                guard: placeholderLifecycle?.guard, signal: context.signal,
                isCurrent: () => useAppStore.getState().currentProjectId === context.projectId
                  && useAppStore.getState().messages.some((message) => message.id === assistantMessageId
                    && message.conversationId === context.conversationId),
                allowCanvas: !targetNodeId || Boolean(placeholderLifecycle) });
              deliveredToCanvas = grouped.canvasReady;
              if (targetNodeId && grouped.canvasReady) useAppStore.getState().incrementRevision();
            } finally {
              if (placeholderLifecycle) completeCanvasDerivation(placeholderLifecycle.guard);
            }
            const artifacts = mediaDeliveryResults(result);
            if (tracksOperation) {
              try {
                await recordMcpOperationProgress(context.taskId, { mediaStage: grouped.complete ? 'delivered' : 'generated',
                  artifactId: result.id, persistence: artifacts.every((item) => item.persistence !== 'failed') ? result.persistence : 'failed',
                  ...(!grouped.complete ? { phase: 'partial', errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' } : {}) });
                receiptUnconfirmed = false;
              } catch { receiptUnconfirmed = true; }
            }
            return { status: 'success', summary: grouped.complete ? `已交付 ${artifacts.length} 张候选图片`
              : '候选图片已生成，部分交付尚未完成，可继续取回原结果',
              ...(!grouped.complete ? { errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' }
                : receiptUnconfirmed ? { errorCode: 'MCP_OPERATION_RECEIPT_UNCONFIRMED' } : {}),
              modelContent: JSON.stringify({ artifactId: result.id, artifactIds: grouped.artifactIds,
                kind: result.kind, deliveryMode: result.deliveryMode, canvasNodeId: targetNodeId,
                outputCount: artifacts.length, deliveryPending: !grouped.complete, receiptUnconfirmed }),
              display: { fields: [{ label: '候选图片', value: `${artifacts.length} 张` },
                { label: '产物 ID', value: grouped.artifactIds.join('、') }] } };
          }
          const nodeCreated = placeholderLifecycle
            ? settleMediaPlaceholderLifecycle(placeholderLifecycle, result)
            : targetNodeId ? currentStore.settleMediaPlaceholder(targetNodeId, result) : false;
          deliveredToCanvas = nodeCreated;
          if (nodeCreated && targetNodeId && ['runninghubwf', 'runninghub'].includes(result.provider)) {
            currentStore.updateNodeDataTransient(targetNodeId, { runninghubOutputs: result.runninghubOutputs });
            completeRunningHubNodeTask(targetNodeId);
          }
          currentStore.updateMessage(assistantMessageId, {
            mediaResult: result,
            mediaStatus: 'succeeded',
            mediaError: undefined,
            canvasStatus: targetNodeId ? (nodeCreated ? 'created' : 'failed') : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId && !nodeCreated
              ? MEDIA_PLACEHOLDER_STALE_ERROR
              : undefined,
          });
          await completeMediaMessageDelivery(assistantMessageId, result, !targetNodeId || nodeCreated);
          if (!targetNodeId && ['runninghubwf', 'runninghub'].includes(result.provider)) completeRunningHubNodeTask(`runninghub-message-${assistantMessageId}`);
          if (result.workflowApiTaskId && (!targetNodeId || nodeCreated)) {
            if (targetNodeId) currentStore.updateNodeDataTransient(targetNodeId, { workflowApiOutputs: result.workflowApiOutputs });
            completeWorkflowApiNodeTask(targetNodeId ?? `workflow-api-message-${assistantMessageId}`, result.workflowApiTaskId);
          }
          // 落盘失败时产物只有临时地址，必须让用户和模型都看到，而不是报告纯成功
          const unsaved = result.persistence === 'failed';
          const deliveryPending = Boolean(result.taskReceipt && getPendingTasksForProject(context.projectId).some((task) =>
            task.nodeId === result.taskReceipt!.nodeId && task.taskId === result.taskReceipt!.taskId
              && task.attemptId === result.taskReceipt!.attemptId));
          const deliveryIncomplete = unsaved || Boolean(targetNodeId && !nodeCreated) || deliveryPending
            || (tracksOperation && (context.signal.aborted || useAppStore.getState().currentProjectId !== context.projectId));
          if (tracksOperation) {
            try {
              await recordMcpOperationProgress(context.taskId, { mediaStage: deliveryIncomplete ? 'generated' : 'delivered',
                artifactId: result.id, persistence: result.persistence,
                ...(deliveryIncomplete ? { phase: 'partial', errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' } : {}) });
              receiptUnconfirmed = false;
            } catch { receiptUnconfirmed = true; }
          }
          if (unsaved) {
            currentStore.showToast(
              `媒体已生成，但未保存到项目：${result.persistError || MEDIA_PERSIST_FAILED_MESSAGE}`,
              'error',
            );
          }
          return {
            status: 'success',
            summary: unsaved ? '媒体内容已生成，但未能保存到项目目录'
              : deliveryIncomplete ? '媒体内容已生成，部分交付尚未完成，请核对原任务'
                : receiptUnconfirmed ? '媒体内容已生成，操作回执尚未确认，请只读核实' : '媒体内容已生成',
            ...(receiptUnconfirmed ? { errorCode: 'MCP_OPERATION_RECEIPT_UNCONFIRMED' } : {}),
            modelContent: JSON.stringify({
              artifactId: result.id,
              kind: result.kind,
              audioPurpose: result.audioPurpose,
              deliveryMode: result.deliveryMode,
              canvasNodeId: targetNodeId,
              persistence: result.persistence,
              persistError: result.persistError,
              ...(tracksOperation ? { deliveryPending: deliveryIncomplete, receiptUnconfirmed } : {}),
            }),
            display: {
              fields: [
                { label: '产物 ID', value: result.id },
                { label: '媒体类型', value: result.kind },
                { label: '模型', value: result.modelId },
                { label: '保存状态', value: result.persistence },
                ...(targetNodeId
                  ? [{ label: '画布节点', value: targetNodeId }]
                  : []),
              ],
            },
          };
        } catch (error) {
          const native = await nativeMediaRows(context.projectId, context.conversationId).catch(() => null);
          if (error instanceof Error && error.name === 'NativeMediaTaskDelivered') {
            const operationId = (error as Error & { nativeOperationId?: unknown }).nativeOperationId;
            const original = originalNativeContext && typeof operationId === 'string'
              ? (await listNativeMediaTasks(originalNativeContext.projectId).catch(() => [])).find((row) => row.operationId === operationId
                && row.canvasId === originalNativeContext.canvasId && row.episodeId === originalNativeContext.episodeId
                && row.projectEpoch === originalNativeContext.projectEpoch && row.canvasEpoch === originalNativeContext.canvasEpoch
                && row.origin?.messageId === assistantMessageId && row.origin.conversationId === context.conversationId && row.status === 'delivered') : undefined;
            const delivered = native?.find((row) => row.origin?.messageId === assistantMessageId && row.status === 'delivered') ?? original;
            if (delivered) {
              if (placeholderLifecycle) completeCanvasDerivation(placeholderLifecycle.guard);
              const { projectNativeMediaMessages } = await import('../../nativeMediaMessages');
              if (originalNativeContext && isProjectExpectedContextCurrent(originalNativeContext, useAppStore.getState(), { checkCanvasRevision: false })) {
                await projectNativeMediaMessages(context.conversationId).catch(() => undefined);
              }
              if (tracksOperation) await recordMcpOperationProgress(context.taskId, { mediaStage: 'delivered',
                persistence: 'saved', artifactId: `native-media-${delivered.operationId}` }).catch(() => undefined);
              const batch = nativeImageBatchSummary(delivered);
              const recovery = await readNativeMediaRecoverySummary(delivered);
              return { status: 'success', summary: recovery.partial ? '原操作已确认产物已保存并交付，请核对部分失败或未知回执' : '原媒体已保存并交付',
                modelContent: JSON.stringify({ operationId: delivered.operationId, artifactId: `native-media-${delivered.operationId}`, persistence: 'saved', batch, recovery }) };
            }
            // 完成事务后切集只影响当前视图；不能把已耐久完成的原操作改记为失败。
            if (placeholderLifecycle) completeCanvasDerivation(placeholderLifecycle.guard);
            return { status: 'success', summary: '原媒体的完成回执已保存，请返回原画布核对产物',
              modelContent: JSON.stringify({ ...(typeof operationId === 'string' && /^[a-f0-9-]{36}$/.test(operationId) ? { operationId } : {}),
                persistence: 'saved', originalViewRequired: true }) };
          }
          const pendingNative = native?.find((row) => (!targetNodeId || row.nodeId === targetNodeId) && row.origin?.messageId === assistantMessageId
            && ['prepared', 'submitted', 'outcome-unknown'].includes(row.status));
          if (pendingNative) {
            if (placeholderLifecycle) completeCanvasDerivation(placeholderLifecycle.guard);
            const recovery = await readNativeMediaRecoverySummary(pendingNative);
            const current = useAppStore.getState();
            if (current.currentProjectId === context.projectId && current.messages.some((entry) => entry.id === assistantMessageId
              && entry.conversationId === context.conversationId)) current.updateMessage(assistantMessageId, {
                mediaStatus: recovery.needsReview ? 'submit_unknown' : 'paused',
                mediaError: '原媒体任务已保留，请续查原回执，不要重新生成。', canvasStatus: targetNodeId ? 'pending' : 'none', canvasNodeId: targetNodeId,
              });
            if (tracksOperation) await recordMcpOperationProgress(context.taskId, { phase: 'partial',
              mediaStage: 'started', errorCode: 'AGENT_MEDIA_RECOVERY_PENDING' }).catch(() => undefined);
            return { status: 'success', summary: '媒体原操作已保留，可按原回执续查', errorCode: 'AGENT_MEDIA_RECOVERY_PENDING',
              modelContent: JSON.stringify({ operationId: pendingNative.operationId, nodeId: pendingNative.nodeId,
                taskId: pendingNative.remoteTaskId, status: pendingNative.status, canResume: recovery.canResume,
                batch: nativeImageBatchSummary(pendingNative), recovery, retryable: false }) };
          }
          if (generatedArtifact && isMediaDeliveryGroup(generatedArtifact)) {
            const current = useAppStore.getState();
            if (current.currentProjectId === context.projectId && current.messages.some((message) =>
              message.id === assistantMessageId && message.conversationId === context.conversationId)) {
              await deliverMediaMessageGroup(assistantMessageId, generatedArtifact, { targetNodeId, allowCanvas: false }).catch(() => undefined);
            }
            if (placeholderLifecycle) completeCanvasDerivation(placeholderLifecycle.guard);
            if (tracksOperation) await recordMcpOperationProgress(context.taskId, { phase: 'partial', mediaStage: 'generated',
              artifactId: generatedArtifact.id, persistence: generatedArtifact.persistence,
              errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' }).catch(() => undefined);
            return { status: 'success', summary: '候选图片已生成，交付未完整确认；请续取原任务，不要重新生成',
              errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE', modelContent: JSON.stringify({
                artifactIds: mediaDeliveryResults(generatedArtifact).map((item) => item.id), deliveryPending: true, retryable: false }) };
          }
          if (tracksOperation && generatedArtifact) {
            // 生成后的取消、租约变化或回执异常不能抹掉产物，也不能清除原媒体恢复身份。
            const current = useAppStore.getState();
            if (placeholderLifecycle && !deliveredToCanvas) failMediaPlaceholderLifecycle(placeholderLifecycle, MEDIA_PLACEHOLDER_STALE_ERROR);
            if (current.currentProjectId === context.projectId && current.messages.some((message) =>
              message.id === assistantMessageId && message.conversationId === context.conversationId)) {
              current.updateMessage(assistantMessageId, { mediaResult: generatedArtifact, mediaStatus: 'succeeded',
                canvasStatus: targetNodeId ? deliveredToCanvas ? 'created' : 'failed' : 'none', canvasNodeId: targetNodeId,
                canvasError: targetNodeId && !deliveredToCanvas ? MEDIA_PLACEHOLDER_STALE_ERROR : undefined });
            }
            await completeMediaMessageDelivery(assistantMessageId, generatedArtifact, false);
            await recordMcpOperationProgress(context.taskId, { phase: 'partial', mediaStage: 'generated',
              artifactId: generatedArtifact.id, persistence: generatedArtifact.persistence, errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE' }).catch(() => undefined);
            return { status: 'success', summary: '媒体已生成，交付未完整确认；请核对原产物或续取原任务，不要重新生成',
              errorCode: 'AGENT_MEDIA_DELIVERY_INCOMPLETE', modelContent: JSON.stringify({ artifactId: generatedArtifact.id,
                canvasNodeId: targetNodeId, persistence: generatedArtifact.persistence, deliveryPending: true, retryable: false }) };
          }
          const recoverable = isMediaTaskPausedError(error);
          const submissionUnknown = recoverable && 'reason' in error && error.reason === 'submit_unknown';
          const stopped = context.signal.aborted
            || (error instanceof DOMException && error.name === 'AbortError');
          const message = tracksOperation && !enteredGeneration
            ? '媒体生成未开始；操作回执、项目或取消状态已变化，请只读核实原 key'
            : stopped
            ? '已停止本地跟踪；供应商未确认远端取消，任务可能继续并产生费用'
            : error instanceof Error ? error.message : '未知错误';
          const currentStore = useAppStore.getState();
          if (placeholderLifecycle && recoverable) completeCanvasDerivation(placeholderLifecycle.guard);
          else if (placeholderLifecycle) failMediaPlaceholderLifecycle(placeholderLifecycle, message);
          else if (targetNodeId) currentStore.failMediaPlaceholder(targetNodeId, message);
          currentStore.updateMessage(assistantMessageId, {
            mediaStatus: submissionUnknown ? 'submit_unknown' : recoverable ? 'paused' : 'failed',
            mediaError: message,
            canvasStatus: targetNodeId ? 'failed' : 'none',
            canvasNodeId: targetNodeId,
            canvasError: targetNodeId ? message : undefined,
          });
          if (tracksOperation) await recordMcpOperationProgress(context.taskId, {
            phase: enteredGeneration ? 'unknown' : 'failed',
            errorCode: enteredGeneration ? 'AGENT_MEDIA_RESULT_UNCONFIRMED' : 'AGENT_MEDIA_NOT_STARTED',
          }).catch(() => undefined);
          return {
            status: 'error',
            summary: recoverable ? '媒体任务已保留，可继续查询原任务' : stopped ? message : `媒体生成失败：${message}`,
            modelContent: recoverable ? `${message}；不要再次调用 media_generate，可通过 media_pending_tasks 和 media_resume_task 续取原任务。` : stopped ? message : `媒体生成失败：${message}`,
            errorCode: tracksOperation && !enteredGeneration ? 'AGENT_MEDIA_NOT_STARTED' : stopped
              ? 'AGENT_MEDIA_TRACKING_STOPPED'
              : recoverable ? 'AGENT_MEDIA_RECOVERY_PENDING' : 'AGENT_MEDIA_GENERATION_FAILED',
          };
        }
      },
    }),
  ];
}
