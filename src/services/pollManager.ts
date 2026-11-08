/**
 * pollManager — 待续任务管理器
 *
 * 记录正在轮询的异步任务到 localStorage，支持：
 * - 切换项目后恢复轮询
 * - 关闭应用后重新打开继续轮询
 *
 * 存储结构按 projectId 隔离，每个节点或消息跟踪 ID 最多一条待续记录。
 */
import { isPollTimeoutError, pollTask, PollTaskFailedError, PollTimeoutError, withPollRequestDeadline } from './pollTask';
import { derivedNodePlacement, generateId, getNextDisplayId } from '../store/store.utils';
import { corsSafeFetch } from './ai/httpTransport';
import { pollVolcengineVideoTask } from './ai/providers/volcengineVideoQuery';
import { useAppStore } from '../store/useAppStore';
import { MediaPersistenceError, persistMediaUrlToProjectData, type MediaPersistenceFailureKind } from './fileService';
import { applyImageBatchResults, imageBatchArtifactId } from './imageBatchService';
import { mapImageDimensions } from './aiDimensions';
import { parseMultiPathResponse, splitCommaSeparatedUrls } from './ai/helpers';
import { resolveComfyOutputUrl, sanitizeComfyOutputFile, type ComfyOutputFile, type ComfyOutputKind, type ComfyOutputs } from './comfyOutputs';
import { ComfyOutputUnavailableError, ComfyPendingError, ComfyQueryAuthorizationError, getComfyQueryAuthorizationMessage, pollComfyHistory, pollComfyTextHistory } from './comfyPolling';
import { maybeAutoReleaseComfyMemory } from './comfyMemory';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from './canvasDerivationGuard';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { pollResolvedModelProtocol } from './ai/modelProtocol';
import { assertMinimaxQueryResponse, usesMinimaxResolvedVideoPoll } from './ai/providers/minimaxModelManifest';
import { assertModelProtocolResult, isSafeMediaParameterText, MEDIA_PARAMETER_TEXT_FIELDS } from './ai/modelCapabilityValidation';
import {
  extractFlowMusicLyrics,
  extractFlowMusicTrack,
  fetchFlowMusicTask,
  type FlowMusicTaskState,
} from './ai/apimartAudio';
import type { BaseNodeData, NodeType } from '../types';
import type { MediaDownloadAccess, MediaTaskContext, MediaTaskReceipt, ResolvedModelProtocolPoll } from '../types/aiTypes';
import { createMediaDownloadAccess, sanitizeMediaDownloadAccess, sanitizeMediaResultUrls } from './ai/mediaDownloadAccess';
import { getHttpResponseError } from './ai/httpUtils';
import {
  APIMART_BASE_URL,
  RUNNINGHUB_MODEL_BASE_URL,
  VOLCENGINE_BASE_URL,
} from '../constants/api';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getGenerationNodeType } from '../utils/nodeGeneration';
import { isHistoryMediaDownloadPending } from './historyMediaRecovery';

// ═══════════════════════════════════════════
// AbortController 注册表 — 节点删除时取消轮询
// ═══════════════════════════════════════════

type MediaMessageRecoveryHandler = (task: PendingTask, urls: string[], signal?: AbortSignal) => Promise<void>;

const EMPTY_MEDIA_TASK_SNAPSHOT: readonly MediaTaskSnapshot[] = Object.freeze([]);

function createMediaTaskSnapshotState() {
  return {
    tasks: EMPTY_MEDIA_TASK_SNAPSHOT,
    serialized: undefined as string | null | undefined,
    messageIdentities: new Set<string>(),
    refresh: undefined as Promise<void> | undefined,
    storageListener: undefined as ((event: StorageEvent) => void) | undefined,
  };
}

function createPollManagerRuntime() {
  return {
    abortControllers: new Map<string, Pick<AbortController, 'signal' | 'abort'>>(),
    pollingProjects: new Map<string, string>(),
    stoppedProjectIds: new Set<string>(),
    videoResumePromises: new Map<string, Promise<void>>(),
    mediaResumeOutcomes: new Map<string, { receipt: MediaTaskReceipt; delivered: boolean; error?: unknown }>(),
    mediaTaskContexts: new Map<string, MediaTaskContext>(),
    mediaTaskObservers: new Map<string, (receipt: MediaTaskReceipt) => void>(),
    activeMediaOperations: new Map<string, Set<symbol>>(),
    latestMediaOperationOwners: new Map<string, symbol>(),
    mediaMessageRecoveryHandler: undefined as MediaMessageRecoveryHandler | undefined,
    editorTransitionResultSinks: new Map<string, { receipt: MediaTaskReceipt; receive: (task: PendingTask, urls: string[]) => void }>(),
    mediaTaskListeners: new Set<() => void>(),
    mediaTaskSnapshot: createMediaTaskSnapshotState(),
    runninghubMessageWaiters: new Map<string, () => void>(),
    workflowApiMessageWaiters: new Map<string, () => void>(),
    // 只描述本进程仍在消费的交付操作，不作为任务或画布写入授权。
    activeComfyDeliveries: new Map<string, { projectId: string; nodeId: string; taskId: string }>(),
    comfyDeliveryListeners: new Set<() => void>(),
    pausedErrors: new WeakSet<Error>(),
  };
}

/** 热更新继续使用同一份运行时，旧请求的清理闭包也必须能找到它。 */
export function createOrReusePollManagerRuntime(hotData?: { pollManagerRuntime?: ReturnType<typeof createPollManagerRuntime> }) {
  const runtime = hotData?.pollManagerRuntime ?? createPollManagerRuntime();
  runtime.latestMediaOperationOwners ??= new Map();
  runtime.mediaTaskSnapshot ??= createMediaTaskSnapshotState();
  runtime.pollingProjects ??= new Map();
  runtime.stoppedProjectIds ??= new Set();
  runtime.editorTransitionResultSinks ??= new Map();
  // 依赖重新求值时不保证先触发 dispose，首次载入就要保留引用。
  if (hotData) hotData.pollManagerRuntime = runtime;
  return runtime;
}

const runtime = createOrReusePollManagerRuntime(import.meta.hot?.data);
const { abortControllers, videoResumePromises, mediaResumeOutcomes, mediaTaskContexts, mediaTaskObservers,
  activeMediaOperations, latestMediaOperationOwners, mediaTaskListeners, runninghubMessageWaiters, workflowApiMessageWaiters,
  activeComfyDeliveries, comfyDeliveryListeners, pausedErrors } = runtime;

/** 逻辑删除后只撤销本进程运行资格；不loadAll、不删除/重写付费或unknown回执。 */
export function stopPollingForDeletedProjects(projectIds: readonly string[]): void {
  const ids = new Set(projectIds);
  for (const id of ids) runtime.stoppedProjectIds.add(id);
  const nodes = new Set<string>();
  for (const [nodeId, projectId] of runtime.pollingProjects) if (ids.has(projectId)) nodes.add(nodeId);
  for (const [nodeId, context] of mediaTaskContexts) if (ids.has(context.projectId)) nodes.add(nodeId);
  const state = useAppStore.getState();
  if (state.currentProjectId && ids.has(state.currentProjectId)) for (const node of state.nodes) nodes.add(node.id);
  for (const [key, operations] of activeMediaOperations) {
    const identity: unknown = JSON.parse(key);
    if (Array.isArray(identity) && ids.has(identity[0] as string)) {
      operations.clear(); activeMediaOperations.delete(key); latestMediaOperationOwners.delete(key);
    }
  }
  for (const nodeId of nodes) {
    // 导入/复制可沿用nodeId，当前controller的项目归属优先，不能取消另一项目同名节点。
    const owner = runtime.pollingProjects.get(nodeId);
    if (owner && ids.has(owner)) abortNodePolling(nodeId);
  }
  let changed = false;
  for (const [key, delivery] of activeComfyDeliveries) if (ids.has(delivery.projectId)) {
    activeComfyDeliveries.delete(key); changed = true;
  }
  if (changed) notifyComfyDeliveries();
}
/** 展示只读投影；恢复/取消/保存仍须通过 loadAll 复核原任务。 */
export function getMediaTaskSnapshot(): readonly MediaTaskSnapshot[] {
  return runtime.mediaTaskSnapshot.tasks;
}

export function hasPendingMessageMediaTask(projectId: string, conversationId: string, messageId: string): boolean {
  const identities = runtime.mediaTaskSnapshot.messageIdentities;
  return identities.has(JSON.stringify([projectId, conversationId, messageId]))
    || identities.has(JSON.stringify([projectId, null, messageId]));
}

/** 同一批挂载只读一次账本；不在 React getSnapshot 或渲染期间迁移存储。 */
export function initializeMediaTaskSnapshot(): Promise<void> {
  const snapshot = runtime.mediaTaskSnapshot;
  snapshot.refresh ??= Promise.resolve().then(() => {
    loadAll();
    mediaTaskListeners.forEach((listener) => listener());
  }).finally(() => { snapshot.refresh = undefined; });
  return snapshot.refresh;
}

export function subscribeMediaTasks(listener: () => void): () => void {
  const firstSubscriber = mediaTaskListeners.size === 0;
  mediaTaskListeners.add(listener);
  // HMR 可能保留旧版本的订阅者，不能只在 listeners 从 0 变为 1 时补上初始化。
  if (!runtime.mediaTaskSnapshot.storageListener && typeof window !== 'undefined') {
    runtime.mediaTaskSnapshot.storageListener = (event) => {
      if ((event.storageArea === null || event.storageArea === localStorage)
        && (event.key === null || event.key === STORAGE_KEY)) void initializeMediaTaskSnapshot();
    };
    window.addEventListener('storage', runtime.mediaTaskSnapshot.storageListener);
  }
  if (firstSubscriber || runtime.mediaTaskSnapshot.serialized === undefined) void initializeMediaTaskSnapshot();
  return () => {
    mediaTaskListeners.delete(listener);
    const storageListener = runtime.mediaTaskSnapshot.storageListener;
    if (mediaTaskListeners.size === 0 && storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', storageListener);
      runtime.mediaTaskSnapshot.storageListener = undefined;
    }
  };
}

/** 一个任务查询失联时停止同批的本地查询，明确失败则继续收齐其余终态。 */
export async function settleMediaTaskQueries<T>(
  queries: Array<(signal: AbortSignal) => Promise<T>>, signal?: AbortSignal,
): Promise<PromiseSettledResult<T>[]> {
  const controller = new AbortController();
  const querySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return await Promise.allSettled(queries.map(async (query) => {
    try { return await query(querySignal); }
    catch (error) {
      if (!(error instanceof PollTaskFailedError)) controller.abort(error);
      throw error;
    }
  }));
}
const notifyComfyDeliveries = () => comfyDeliveryListeners.forEach((listener) => listener());

export function subscribeComfyDeliveries(listener: () => void): () => void {
  comfyDeliveryListeners.add(listener);
  return () => { comfyDeliveryListeners.delete(listener); };
}

export function isComfyNodeDeliveryActive(projectId: string | null, nodeId: string | undefined): boolean {
  return [...activeComfyDeliveries.values()].some((item) => item.projectId === projectId && item.nodeId === nodeId);
}

export function beginComfyNodeDelivery(nodeId: string, taskId: string | undefined): void {
  if (!taskId) return;
  const task = loadAll().find((item) => item.nodeId === nodeId && item.taskType === 'comfyui' && item.taskId === taskId);
  if (!task) return;
  const key = JSON.stringify([task.projectId, nodeId, taskId]);
  if (activeComfyDeliveries.has(key)) return;
  activeComfyDeliveries.set(key, { projectId: task.projectId, nodeId, taskId });
  notifyComfyDeliveries();
}

function endComfyNodeDelivery(nodeId: string, taskId: string): void {
  let changed = false;
  for (const [key, item] of activeComfyDeliveries) {
    if (item.nodeId === nodeId && item.taskId === taskId) { activeComfyDeliveries.delete(key); changed = true; }
  }
  if (changed) notifyComfyDeliveries();
}

function abortNodePolling(nodeId: string): void {
  const controller = abortControllers.get(nodeId);
  if (controller) {
    controller.abort();
    abortControllers.delete(nodeId);
  }
}

/** 为节点注册轮询控制器，返回 AbortSignal 传给 pollTask */
export function registerNodePolling(nodeId: string, parentSignal?: AbortSignal): AbortSignal {
  // 已经停止的调用不能先中断别人的轮询，再登记一轮新的查询。
  parentSignal?.throwIfAborted();
  const projectId = mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  if (projectId && runtime.stoppedProjectIds.has(projectId)) throw new DOMException('项目已删除，本地查询已停止', 'AbortError');
  abortNodePolling(nodeId); // 先取消旧轮询，但保留 pending task 以支持恢复
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  abortControllers.set(nodeId, { signal, abort: (reason?: unknown) => controller.abort(reason) });
  if (projectId) runtime.pollingProjects.set(nodeId, projectId);
  return signal;
}

/** 取消节点的轮询（节点被删除时调用，同时清理 pending task） */
export function cancelNodePolling(nodeId: string, preservePending = false): void {
  abortNodePolling(nodeId);
  // 同时清理 localStorage 中的待续任务记录
  if (!preservePending) removePendingTask(nodeId);
}

/** 轮询正常结束/失败后清理注册表（不调用 abort） */
export function cleanupNodePolling(nodeId: string, expectedSignal?: AbortSignal): boolean {
  if (expectedSignal && abortControllers.get(nodeId)?.signal !== expectedSignal) return false;
  abortControllers.delete(nodeId);
  runtime.pollingProjects.delete(nodeId);
  return true;
}

// ═══════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════

export interface PendingTask {
  nodeId: string;
  projectId: string;
  nodeType: NodeType;
  provider: string;
  taskId: string;
  taskType: 'apimart' | 'apimart-flow-music' | 'dreamina' | 'comfyui' | 'general' | 'custom-protocol' | 'volcengine' | 'runninghub' | 'runninghub-workflow' | 'workflow-api' | 'runninghub-model';
  runninghubModelId?: string;
  runninghubSubmissionUncertain?: boolean;
  workflowApi?: import('../types/workflowApi').WorkflowApiTaskDescriptor;
  workflowApiMessage?: import('../types/workflowApi').CloudWorkflowTaskContext;
  runninghubRecoveryState?: 'disconnected' | 'cancel_pending' | 'submit_unknown' | 'save_pending';
  /** 新任务固定原站点以供续查/取消，不保存密钥；旧记录缺省沿用当前选择。 */
  runninghubSite?: import('../types/runninghub').RunningHubSiteId;
  runninghubOutputNodeIds?: string[];
  runninghubWorkflowId?: string;
  runninghubMessage?: import('../types/runninghub').RunningHubTaskContext;
  /** Flow Music 当前远端任务阶段。 */
  audioTaskStage?: 'lyrics' | 'music';
  /** 本地 ComfyUI 恢复轮询用地址；厂商地址统一从 providerConfigId 解析。 */
  baseUrl?: string;
  /** 批量图片任务期望回填的结果数量；旧记录缺省为 1。 */
  batchCount?: number;
  /** 单个远端作业固定返回多候选时的交付数量；不随当前连接配置变化。 */
  expectedImageOutputs?: number;
  /** 固定候选任务内部重挂的历史节点，仅用于严格匹配旧消息回执。 */
  imageOutputNodeIds?: string[];
  /** 同一节点对应的多个异步任务 ID（APIMart / RunningHub 批量图片生成）。 */
  taskIds?: string[];
  /** 声明式协议任务从连接配置重新读取密钥，不在此处新增密钥副本。 */
  providerConfigId?: string;
  protocolPoll?: ResolvedModelProtocolPoll;
  /** 多个独立远端任务的查询描述，与 taskIds 顺序一致。 */
  protocolPolls?: ResolvedModelProtocolPoll[];
  /** 同步接口已返回的可重取结果，仅继续下载，不发起生成。 */
  resultUrls?: string[];
  /** 已确认的 ComfyUI 相对文件描述；仅由原 baseUrl 的 /view 续取，不保存任意 URL。 */
  comfyOutputFile?: ComfyOutputFile;
  /** 原工作流明确声明的最终 SaveText 节点，仅保存 ID，不保存执行图或文本正文。 */
  comfyTextOutputNodeIds?: string[];
  mediaDownloadAccess?: MediaDownloadAccess;
  /** 是否已取得远端任务 ID；false 不能证明请求未被上游接收。 */
  submitted: boolean;
  attemptId?: string;
  mediaContext?: MediaTaskContext;
  mediaRecoveryState?: 'query_paused' | 'delivery_pending' | 'submit_unknown';
  mediaRecoveryReason?: MediaTaskPauseReason;
  /** 只保存有限错误分类与状态码，不保存响应正文、Key 或原始异常。 */
  mediaFailureDiagnostic?: { kind: 'http' | 'timeout' | 'network' | 'persistence' | 'canvas_changed'; httpStatus?: number; failureKind?: MediaPersistenceFailureKind };
  /** 已确认终态失败，但所属项目未加载；切回后显示普通失败，不再续查。 */
  terminalFailure?: true;
  /** 批次已有部分 ID 但仍有提交响应丢失，不能由已知任务成功掩盖。 */
  mediaSubmissionUncertain?: boolean;
  /** 本地查询暂停，重启后等待用户手动继续。 */
  videoRecoveryState?: 'paused';
  /** 仅保存已脱敏的落盘原因或固定暂停分类，不保存底层错误或媒体地址。 */
  videoRecoveryMessage?: string;
  /** 本轮生成开始的时间戳；跨暂停、重试、项目重开保留，不是恢复查询的开始时间。 */
  videoGenerationStartedAt?: number;
  /** 只保存生成输入标量，不包含参考素材路径、请求正文或凭据。 */
  videoGeneration?: Pick<BaseNodeData, 'prompt' | 'model' | 'provider' | 'seedanceResolution'
    | 'seedanceRatio' | 'seedanceDuration' | 'generateAudio' | 'videoResolution' | 'videoFrames' | 'videoFps'>;
  /** ComfyUI 远端终态尚未确认，保留任务并提供续查/再次取消。 */
  comfyRecoveryState?: 'disconnected' | 'cancel_pending' | 'save_pending' | 'output_unavailable';
  /** 仅保留可识别的查询鉴权状态，不保存上游错误正文、地址或凭据。 */
  comfyQueryHttpStatus?: 401 | 403;
}

/** UI 恢复提示的最小身份与状态；不含查询协议、下载授权、URL 或生成参数。 */
export interface MediaTaskSnapshot extends Readonly<Pick<PendingTask,
  'projectId' | 'nodeId' | 'taskId' | 'attemptId' | 'submitted' | 'mediaRecoveryState'
  | 'mediaSubmissionUncertain' | 'expectedImageOutputs' | 'terminalFailure'>> {
  readonly mediaContext?: Readonly<Pick<MediaTaskContext, 'conversationId' | 'messageId' | 'editorTransition'>>;
  readonly imageOutputNodeIds?: readonly string[];
  readonly historyDownloadPending: boolean;
}

// ═══════════════════════════════════════════
// localStorage 持久化
// ═══════════════════════════════════════════

const STORAGE_KEY = 'ai_canvas_pending_tasks';
const LEGACY_PENDING_TASK_TYPES = new Set(['apimart', 'apimart-flow-music', 'dreamina', 'comfyui', 'general', 'custom-protocol',
  'volcengine', 'runninghub', 'runninghub-workflow', 'workflow-api', 'runninghub-model']);
const UNSUPPORTED_PENDING_EXECUTION_FIELDS = ['version', 'schemaVersion', 'modelGeneration', 'expectedContext', 'executionContext',
  'projectScope', 'contextVersion', 'runtimeEpoch', 'projectEpoch', 'canvasEpoch'];

export class PendingMediaTaskSourceError extends Error {
  readonly code: 'MEDIA_PENDING_SOURCE_INVALID' | 'MEDIA_PENDING_SOURCE_UNAVAILABLE';

  constructor(code: 'MEDIA_PENDING_SOURCE_INVALID' | 'MEDIA_PENDING_SOURCE_UNAVAILABLE' = 'MEDIA_PENDING_SOURCE_INVALID') {
    super('原待恢复任务源损坏、版本不受支持或暂不可读；原数据已保留，请先核实，勿重新提交生成');
    this.name = 'PendingMediaTaskSourceError';
    this.code = code;
  }
}

/** 仅读取已知旧合同；未来执行字段不能被sanitize成旧授权，坏源也不能变成空队列。 */
function parseLegacyPendingTaskSource(raw: string | null): LegacyPendingTask[] {
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new PendingMediaTaskSourceError(); }
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
    || UNSUPPORTED_PENDING_EXECUTION_FIELDS.some((field) => Object.hasOwn(item, field))
    || typeof item.projectId !== 'string' || !item.projectId || typeof item.nodeId !== 'string' || !item.nodeId
    || typeof item.nodeType !== 'string' || typeof item.provider !== 'string' || !LEGACY_PENDING_TASK_TYPES.has(item.taskType)
    || item.taskId !== undefined && typeof item.taskId !== 'string'
    || item.submitted !== undefined && typeof item.submitted !== 'boolean')) throw new PendingMediaTaskSourceError();
  return parsed as LegacyPendingTask[];
}

/** 无显式等待预算的云视频查询，每轮最多等待 30 分钟，随后可手动续查。 */
export const VIDEO_POLL_MAX_DURATION_MS = 30 * 60 * 1000;
export const MEDIA_POLL_MAX_DURATION_MS = VIDEO_POLL_MAX_DURATION_MS;

const RECOVERABLE_VIDEO_TASK_TYPES: PendingTask['taskType'][] = ['custom-protocol', 'general', 'apimart', 'volcengine', 'comfyui'];

export class VideoPollingPausedError extends Error {
  readonly taskReceipt?: MediaTaskReceipt;

  constructor(taskReceipt?: MediaTaskReceipt, message = '视频查询超时或中断，任务已保留，可点击重试继续查询') {
    super(message);
    this.name = 'VideoPollingPausedError';
    this.taskReceipt = taskReceipt;
    pausedErrors.add(this);
  }
}

export type MediaTaskPauseReason = 'query_timeout' | 'query_interrupted' | 'delivery_pending' | 'canvas_changed' | 'submit_unknown';

export class MediaTaskPausedError extends VideoPollingPausedError {
  readonly reason: MediaTaskPauseReason;

  constructor(receipt: MediaTaskReceipt, reason: MediaTaskPauseReason, comfyQueryHttpStatus?: 401 | 403) {
    super(receipt, getComfyQueryAuthorizationMessage(comfyQueryHttpStatus) ?? (reason === 'submit_unknown'
      ? '生成请求的提交状态未知，请先到平台确认任务，避免重复生成'
      : reason === 'delivery_pending' ? '生成已完成，保存或回填尚未完成，可继续取回原结果'
        : '任务查询已暂停，原任务已保留，可继续查询'));
    this.name = 'MediaTaskPausedError';
    this.reason = reason;
  }
}

export function isMediaTaskPausedError(error: unknown): error is VideoPollingPausedError {
  return error instanceof Error && pausedErrors.has(error);
}

/** 只保存有限的媒体选项，避免恢复记录混入提示词、路径或任意对象。 */
function sanitizeMediaParameters(value: MediaTaskContext['parameters']): MediaTaskContext['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: NonNullable<MediaTaskContext['parameters']> = {};
  for (const key of MEDIA_PARAMETER_TEXT_FIELDS) {
    const item = value[key];
    if (isSafeMediaParameterText(item, key)) result[key] = item;
  }
  if (typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration !== 0
    && value.duration <= 3600) result.duration = value.duration;
  if (typeof value.videoFps === 'number' && Number.isFinite(value.videoFps)
    && value.videoFps >= 1 && value.videoFps <= 240) result.videoFps = value.videoFps;
  if (typeof value.generateAudio === 'boolean') result.generateAudio = value.generateAudio;
  // 空对象是新任务的显式快照，与没有快照的旧任务不同。
  return result;
}

function sanitizeEditorTransition(value: MediaTaskContext['editorTransition']): MediaTaskContext['editorTransition'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const safeId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256
    && !/[\\/:]/.test(id) && ![...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && id !== '.' && id !== '..';
  if (!safeId(value.anchorNodeId) || !safeId(value.requestId)) return;
  return { anchorNodeId: value.anchorNodeId, requestId: value.requestId,
    ...(safeId(value.fileName) ? { fileName: value.fileName } : {}),
    ...(value.delivered === true ? { delivered: true } : {}) };
}

export function bindMediaTaskContext(trackingId: string, context: MediaTaskContext,
  observer?: (receipt: MediaTaskReceipt) => void): () => void {
  const parameters = sanitizeMediaParameters(context.parameters);
  const safe: MediaTaskContext = { projectId: context.projectId, conversationId: context.conversationId,
    messageId: context.messageId, deliveryMode: context.deliveryMode, canvasNodeId: context.canvasNodeId, modelId: context.modelId,
    ...(sanitizeEditorTransition(context.editorTransition) ? { editorTransition: sanitizeEditorTransition(context.editorTransition) } : {}),
    ...(parameters ? { parameters } : {}) };
  mediaTaskContexts.set(trackingId, safe);
  if (observer) mediaTaskObservers.set(trackingId, observer);
  else mediaTaskObservers.delete(trackingId);
  return () => {
    if (mediaTaskContexts.get(trackingId) === safe) {
      mediaTaskContexts.delete(trackingId);
      if (mediaTaskObservers.get(trackingId) === observer) mediaTaskObservers.delete(trackingId);
    }
  };
}

/** 运行中转场的真实锚点，仅供 Provider 提交前守卫；不作为任务的跟踪 ID。 */
export function getVideoEditorTransitionAnchor(trackingId: string | undefined): string | undefined {
  return trackingId ? mediaTaskContexts.get(trackingId)?.editorTransition?.anchorNodeId : undefined;
}

export function isVideoEditorTransitionTaskActive(projectId: string, trackingId: string): boolean {
  return isMediaOperationActive(projectId, trackingId) || abortControllers.has(trackingId)
    || runtime.editorTransitionResultSinks.has(trackingId);
}

function notifyMediaReceipt(task: PendingTask): void {
  if (mediaTaskContexts.get(task.nodeId)?.projectId === task.projectId) {
    mediaTaskObservers.get(task.nodeId)?.(receiptForTask(task));
  }
}

export function registerMediaMessageRecoveryHandler(handler: MediaMessageRecoveryHandler): () => void {
  runtime.mediaMessageRecoveryHandler = handler;
  return () => { if (runtime.mediaMessageRecoveryHandler === handler) runtime.mediaMessageRecoveryHandler = undefined; };
}

/** 覆盖同步等待和交付阶段；不把运行时租约写入持久化。 */
export function registerMediaNodeOperation(nodeId: string, ownsGeneration = false): (() => void) & { isCurrent: () => boolean } {
  const projectId = mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  if (projectId && runtime.stoppedProjectIds.has(projectId)) throw new DOMException('项目已删除，本地交付已停止', 'AbortError');
  const key = JSON.stringify([projectId, nodeId]);
  const token = Symbol();
  const operations = activeMediaOperations.get(key) ?? new Set<symbol>();
  operations.add(token);
  activeMediaOperations.set(key, operations);
  // 声明式执行器等内层也会登记活跃状态，只有外层生成入口领取运行所有权。
  if (ownsGeneration) latestMediaOperationOwners.set(key, token);
  const release = () => {
    operations.delete(token);
    if (operations.size === 0 && activeMediaOperations.get(key) === operations) {
      activeMediaOperations.delete(key);
      latestMediaOperationOwners.delete(key);
    }
  };
  // 新尝试结束也不让旧尝试重新取得保存资格；运行时身份不进入持久化。
  return Object.assign(release, { isCurrent: () => operations.has(token)
    && (!ownsGeneration || latestMediaOperationOwners.get(key) === token) });
}

function isMediaOperationActive(projectId: string, nodeId: string): boolean {
  return activeMediaOperations.has(JSON.stringify([projectId, nodeId]));
}

function receiptForTask(task: PendingTask): MediaTaskReceipt {
  return { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId };
}

function matchesReceipt(task: PendingTask, receipt: MediaTaskReceipt): boolean {
  return task.projectId === receipt.projectId && task.nodeId === receipt.nodeId
    && task.taskId === receipt.taskId && task.attemptId === receipt.attemptId;
}

export function getMediaTaskReceipt(nodeId: string, expectedTaskId?: string): MediaTaskReceipt | undefined {
  const projectId = mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === projectId
    && (expectedTaskId === undefined || item.taskId === expectedTaskId));
  return task ? receiptForTask(task) : undefined;
}

function isRecoverableMediaTask(task: PendingTask): boolean {
  if (task.mediaContext?.editorTransition && task.taskType === 'runninghub-model') return true;
  if (task.taskType === 'comfyui') return task.comfyRecoveryState !== 'cancel_pending'
    && ((task.submitted && !!task.taskId) || task.mediaSubmissionUncertain === true || task.mediaRecoveryState === 'submit_unknown');
  return ['ai-image', 'ai-video', 'ai-audio', 'ai-panorama', 'ai-animation'].includes(task.nodeType)
    && ['custom-protocol', 'general', 'apimart', 'apimart-flow-music', 'volcengine', 'dreamina'].includes(task.taskType);
}

export function pauseMediaTask(receipt: MediaTaskReceipt, error?: unknown,
  reason: MediaTaskPauseReason = 'query_interrupted'): MediaTaskPausedError | undefined {
  if (runtime.stoppedProjectIds.has(receipt.projectId)) return undefined;
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task || task.terminalFailure || !isRecoverableMediaTask(task)) return undefined;
  const unknown = task.mediaSubmissionUncertain || task.runninghubSubmissionUncertain || !task.submitted || !task.taskId || reason === 'submit_unknown';
  const resolvedReason = unknown ? 'submit_unknown' : reason;
  const deliveryPending = !unknown && (reason === 'delivery_pending'
    || reason === 'canvas_changed' && task.mediaRecoveryState === 'delivery_pending');
  const comfyQueryHttpStatus = !unknown && task.taskType === 'comfyui'
    ? error instanceof ComfyQueryAuthorizationError ? error.status : task.comfyQueryHttpStatus : undefined;
  updatePendingTask(task.nodeId, {
    mediaRecoveryState: unknown ? 'submit_unknown' : deliveryPending ? 'delivery_pending' : 'query_paused',
    mediaRecoveryReason: resolvedReason,
    comfyQueryHttpStatus,
    mediaFailureDiagnostic: error === undefined
      ? reason === 'canvas_changed' ? { kind: 'canvas_changed' } : task.mediaFailureDiagnostic
      : describeMediaFailure(error),
    ...(task.nodeType === 'ai-video' && !unknown ? { videoRecoveryState: 'paused' as const } : {}),
  }, task.taskId, task.attemptId);
  const store = useAppStore.getState();
  const canvasNodeId = task.mediaContext?.canvasNodeId ?? task.nodeId;
  const nodeIds = new Set([...getBatchTaskNodeIds(task, store.nodes), canvasNodeId]);
  if (store.currentProjectId === task.projectId) for (const node of store.nodes) {
    if (!nodeIds.has(node.id)) continue;
    store.updateNodeDataTransient(node.id, { status: node.data.status === 'success' ? 'success' : 'idle', error: undefined,
      mediaTaskState: unknown ? 'submit_unknown' : deliveryPending ? 'delivery_pending' : 'paused',
      mediaTaskStage: undefined, ...(task.nodeType === 'ai-video' && !unknown ? {
        videoTaskState: 'paused' as const, generationStartedAt: task.videoGenerationStartedAt,
      } : {}) });
  }
  const paused = new MediaTaskPausedError(receipt, resolvedReason, comfyQueryHttpStatus);
  const outcome = mediaResumeOutcomes.get(JSON.stringify([task.projectId, task.nodeId]));
  if (comfyQueryHttpStatus && outcome && matchesReceipt(task, outcome.receipt)) outcome.error = paused;
  return paused;
}

function sanitizeMediaFailureDiagnostic(value: unknown): PendingTask['mediaFailureDiagnostic'] {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.kind === 'canvas_changed') return { kind: 'canvas_changed' };
  if (record.kind === 'persistence') {
    const kinds: MediaPersistenceFailureKind[] = ['http', 'timeout', 'network', 'path_access', 'permission', 'disk_space',
      'missing_file', 'invalid_media', 'connection_changed', 'missing_key', 'unknown'];
    if (!kinds.some((kind) => kind === record.failureKind)) return;
    const httpStatus = typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus)
      && record.httpStatus >= 400 && record.httpStatus <= 599 ? record.httpStatus : undefined;
    return { kind: 'persistence', failureKind: record.failureKind as MediaPersistenceFailureKind,
      ...(record.failureKind === 'http' && httpStatus !== undefined ? { httpStatus } : {}) };
  }
  if (record.kind === 'network' || record.kind === 'timeout') return { kind: record.kind };
  if (record.kind === 'http' && typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus)
    && record.httpStatus >= 400 && record.httpStatus <= 599) return { kind: 'http', httpStatus: record.httpStatus };
}

function describeMediaFailure(error: unknown): PendingTask['mediaFailureDiagnostic'] {
  if (error instanceof MediaPersistenceError) {
    return sanitizeMediaFailureDiagnostic({ kind: 'persistence', failureKind: error.failureKind, httpStatus: error.httpStatus });
  }
  if (error instanceof CanvasResultStaleError) return { kind: 'canvas_changed' };
  const http = getHttpResponseError(error);
  if (http) return sanitizeMediaFailureDiagnostic({ kind: 'http', httpStatus: http.status });
  const seen = new Set<Error>();
  for (let depth = 0; depth < 8 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error);
    const status = /\bHTTP\s*\(?\s*([45]\d{2})\b/i.exec(error.message)?.[1];
    if (status) return { kind: 'http', httpStatus: Number(status) };
    if (isPollTimeoutError(error) || /timed?\s*out|timeout|超时/i.test(error.message)) return { kind: 'timeout' };
    if (/failed to fetch|network|网络|连接.*(?:失败|中断)|connection (?:reset|closed|refused)/i.test(error.message)) return { kind: 'network' };
    error = error.cause;
  }
}

export function pauseMediaNodeTask(nodeId: string, expectedTaskId?: string, reason?: MediaTaskPauseReason): MediaTaskPausedError | undefined {
  const receipt = getMediaTaskReceipt(nodeId, expectedTaskId);
  return receipt ? pauseMediaTask(receipt, undefined, reason) : undefined;
}

/** 必须在本地保存及目标回填完成后确认，旧尝试不能清理新任务。 */
export function completeMediaNodeTask(receipt: MediaTaskReceipt): void {
  if (runtime.stoppedProjectIds.has(receipt.projectId)) return;
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task) return;
  if (task.mediaSubmissionUncertain || !task.submitted || !task.taskId) {
    pauseMediaTask(receipt, undefined, 'submit_unknown');
    return;
  }
  if (task.mediaContext?.editorTransition) {
    updatePendingTask(task.nodeId, { mediaContext: { ...task.mediaContext,
      editorTransition: { ...task.mediaContext.editorTransition, delivered: true } } }, task.taskId, task.attemptId);
    return;
  }
  const outcome = mediaResumeOutcomes.get(JSON.stringify([receipt.projectId, receipt.nodeId]));
  if (outcome && matchesReceipt(task, outcome.receipt)) outcome.delivered = true;
  saveAll(loadAll().filter((item) => !matchesReceipt(item, receipt)));
  const store = useAppStore.getState();
  const canvasNodeId = task.mediaContext?.canvasNodeId ?? task.nodeId;
  const nodeIds = new Set([...getBatchTaskNodeIds(task, store.nodes), canvasNodeId]);
  if (store.currentProjectId === task.projectId) for (const node of store.nodes) {
    if (nodeIds.has(node.id)) store.updateNodeDataTransient(node.id, {
      mediaTaskState: undefined, mediaTaskStage: undefined, videoTaskState: undefined });
  }
}

/** 仅供用户明确解除本地保留；不会声称远端已经取消或未扣费。 */
export function discardMediaTask(receipt: MediaTaskReceipt): void {
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task) return;
  abortNodePolling(task.nodeId);
  saveAll(loadAll().filter((item) => !matchesReceipt(item, receipt)));
  const store = useAppStore.getState();
  const nodeId = task.mediaContext?.canvasNodeId ?? task.nodeId;
  if (store.currentProjectId === task.projectId && store.nodes.some((node) => node.id === nodeId)) {
    store.updateNodeDataTransient(nodeId, { mediaTaskState: undefined, mediaTaskStage: undefined, videoTaskState: undefined });
  }
}

const CONFIRMED_MEDIA_FAILURE_MESSAGE = '生成失败：服务商已明确拒绝请求或任务已失败';

/** 同组占位节点若已开始独立生成，不再归旧批次终态所有。 */
function failedTaskNodeIds(task: PendingTask): Set<string> {
  const store = useAppStore.getState();
  const tasks = loadAll();
  return new Set([...getBatchTaskNodeIds(task, store.nodes), task.mediaContext?.canvasNodeId ?? task.nodeId]
    .filter((nodeId) => nodeId === task.nodeId || (!isMediaOperationActive(task.projectId, nodeId)
      && !tasks.some((other) => other.projectId === task.projectId && other.nodeId === nodeId && !matchesReceipt(other, receiptForTask(task))))));
}

/** 后台失败只更新原消息；未落盘时保留终态记录，不能丢失其唯一交付身份。 */
async function persistFailedMediaMessage(task: PendingTask): Promise<void> {
  const context = task.mediaContext ?? task.runninghubMessage;
  if (!context?.messageId || !context.conversationId) return;
  const patch = { mediaStatus: 'failed' as const, mediaError: CONFIRMED_MEDIA_FAILURE_MESSAGE };
  const { getConversationMessages, putChatMessage } = await import('./indexedDbService');
  for (let offset = 0; ; offset += 50) {
    const page = await getConversationMessages(context.conversationId, offset, 50);
    if (!loadAll().some((item) => matchesReceipt(item, receiptForTask(task)))) return;
    const state = useAppStore.getState();
    const currentMessage = state.currentProjectId === task.projectId ? state.messages.find((message) =>
      message.id === context.messageId && message.conversationId === context.conversationId) : undefined;
    const storedMessage = page.messages.find((message) => message.id === context.messageId && message.projectId === task.projectId);
    const message = currentMessage ?? storedMessage;
    if (message) {
      // 已成功的消息不能被旧终态回调覆盖；失败消息也要确认落盘后才能清理回执。
      if (message.mediaStatus === 'succeeded') return;
      if (currentMessage) {
        const { persistMessage } = await import('./chat/chatHistoryService');
        await persistMessage({ ...currentMessage, ...patch }, task.projectId, context.conversationId);
        if (useAppStore.getState().currentProjectId === task.projectId
          && useAppStore.getState().messages.find((item) => item.id === context.messageId) === currentMessage) {
          state.updateMessage(currentMessage.id, patch);
        }
      } else if (storedMessage) await putChatMessage({ ...storedMessage, ...patch, updatedAt: Date.now() });
      return;
    }
    if (offset + page.messages.length >= page.total || page.messages.length === 0) return;
  }
}

/** 仅用于已确认的拒绝或终态失败；完整身份防止旧回调清理新尝试。 */
export function removeFailedMediaTask(receipt: MediaTaskReceipt): void {
  if (runtime.stoppedProjectIds.has(receipt.projectId)) return;
  const tasks = loadAll();
  const task = tasks.find((item) => matchesReceipt(item, receipt));
  if (!task) return;
  if (task.mediaContext?.editorTransition) {
    // 原窗口的重复事件仍可能到达；终态保留原身份，不能被当成新请求再次生成。
    saveAll(tasks.map((item) => matchesReceipt(item, receipt) ? { ...item, terminalFailure: true } : item));
    return;
  }
  const store = useAppStore.getState();
  const hasMessage = !!(task.mediaContext?.messageId || task.runninghubMessage?.messageId);
  if (store.currentProjectId !== task.projectId || (hasMessage && !task.terminalFailure)) {
    // 原项目的持久化节点可能仍为 loading；留下有限终态，避免切回时误判提交未知。
    saveAll(tasks.map((item) => matchesReceipt(item, receipt) ? { ...item, terminalFailure: true } : item));
    if (hasMessage && store.currentProjectId === task.projectId) {
      // 同项目也可能已切换对话，调用方的当前消息守卫不会再回写原消息。
      void persistFailedMediaMessage(task).then(() => {
        if (useAppStore.getState().currentProjectId === task.projectId) removeFailedMediaTask(receipt);
      }).catch(() => { /* 持久化失败保留终态，下一次项目恢复继续交付失败状态。 */ });
    }
    return;
  }
  saveAll(tasks.filter((item) => !matchesReceipt(item, receipt)));
  const nodeIds = failedTaskNodeIds(task);
  for (const node of store.nodes) {
    if (nodeIds.has(node.id)) store.updateNodeDataTransient(node.id, {
      mediaTaskState: undefined, mediaTaskStage: undefined, videoTaskState: undefined,
    });
  }
}

const VIDEO_PAUSE_MESSAGES = {
  canvas_changed: '画布或项目在本轮视频取回期间发生变化，结果尚未回填；请点击重试取回原任务',
  query_interrupted: '本轮视频查询中断或等待超时，任务已保留；请点击重试继续查询',
  query_timeout: '本轮视频查询超时，任务已保留；请点击重试继续查询',
  delivery_pending: '本轮视频已生成，但保存或回填尚未完成；请点击重试取回原结果',
} as const;

class CanvasResultStaleError extends ComfyPendingError {
  constructor() { super('画布已变化，任务结果已保留，请继续查询'); }
}

function isRecoverableVideoTask(task: PendingTask): boolean {
  return task.nodeType === 'ai-video' && task.submitted && !!task.taskId
    && !(task.taskType === 'comfyui' && task.comfyRecoveryState === 'cancel_pending')
    && RECOVERABLE_VIDEO_TASK_TYPES.includes(task.taskType);
}

export function canResumeMediaTask(task: PendingTask): boolean {
  return (isRecoverableMediaTask(task) || isRecoverableVideoTask(task))
    && !task.terminalFailure && task.submitted && !!task.taskId && !task.mediaSubmissionUncertain
    && task.mediaRecoveryState !== 'submit_unknown'
    && (videoResumePromises.has(task.nodeId) || !isMediaOperationActive(task.projectId, task.nodeId));
}

export function captureVideoTaskGeneration(nodeId?: string): PendingTask['videoGeneration'] {
  const data = useAppStore.getState().nodes.find((node) => node.id === nodeId)?.data;
  if (!data) return undefined;
  const { prompt, model, provider, seedanceResolution, seedanceRatio, seedanceDuration,
    generateAudio, videoResolution, videoFrames, videoFps } = data;
  return { prompt, model, provider, seedanceResolution, seedanceRatio, seedanceDuration,
    generateAudio, videoResolution, videoFrames, videoFps };
}

function isCurrentVideoTask(task: PendingTask, signal?: AbortSignal): boolean {
  const store = useAppStore.getState();
  return !signal?.aborted && store.currentProjectId === task.projectId
    && store.nodes.some((node) => node.id === task.nodeId)
    && loadAll().some((item) => item.nodeId === task.nodeId && item.projectId === task.projectId && item.taskId === task.taskId);
}

function isCurrentMediaTask(task: PendingTask, signal?: AbortSignal): boolean {
  const store = useAppStore.getState();
  return !signal?.aborted && store.currentProjectId === task.projectId
    && loadAll().some((item) => matchesReceipt(item, receiptForTask(task)))
    && (!!task.mediaContext?.messageId || !!task.mediaContext?.editorTransition || store.nodes.some((node) => node.id === task.nodeId));
}

function guardVideoTaskQuery(task: PendingTask, signal: AbortSignal) {
  const lease = registerPendingTaskContextGuard(task, signal);
  const hasNode = useAppStore.getState().nodes.some((node) => node.id === task.nodeId);
  const guard = hasNode ? registerCanvasDerivation(useAppStore.getState(), task.nodeId) : null;
  return {
    isCurrent: () => lease.isCurrent() && isCurrentMediaTask(task, signal)
      && (!hasNode || (!!guard && isCanvasDerivationFresh(guard, useAppStore.getState()))),
    isTargetCurrent: lease.isCurrent,
    complete: () => { lease.complete(); if (guard) completeCanvasDerivation(guard); },
  };
}

/** 本进程恢复租约，原持久队列不补epoch；切走再切回也不能复活旧回调。 */
export function registerPendingTaskContextGuard(task: Pick<PendingTask, 'projectId' | 'nodeId'>, signal?: AbortSignal) {
  let expected: ReturnType<typeof captureLegacyCanvasContext> = null;
  try { expected = captureLegacyCanvasContext(useAppStore.getState()); } catch { /* 无效上下文失败关闭 */ }
  let stale = !expected || expected.canvasId !== task.projectId || expected.modelGeneration !== 0;
  let boundSignal = signal;
  const invalidate = () => {
    stale ||= !expected || !isProjectExpectedContextCurrent(expected, useAppStore.getState(), { checkCanvasRevision: false });
    if (stale && boundSignal) {
      const controller = abortControllers.get(task.nodeId);
      if (controller?.signal === boundSignal) controller.abort();
    }
    return !stale && !boundSignal?.aborted;
  };
  const unsubscribe = useAppStore.subscribe(invalidate);
  invalidate();
  return { isCurrent: invalidate,
    bindSignal: (next: AbortSignal) => { boundSignal = next; invalidate(); },
    complete: unsubscribe };
}

/** 保留远端身份；旧请求、删除节点和切换后的回调不能改写当前节点。 */
export function pauseVideoNodeTask(nodeId: string, expectedTaskId?: string, error?: unknown, reason?: keyof typeof VIDEO_PAUSE_MESSAGES): VideoPollingPausedError | undefined {
  const task = loadAll().find((item) => item.nodeId === nodeId);
  if (!task || !isRecoverableVideoTask(task) || (expectedTaskId !== undefined && task.taskId !== expectedTaskId)) return undefined;
  const comfyQueryHttpStatus = task.taskType === 'comfyui'
    ? error instanceof ComfyQueryAuthorizationError ? error.status : task.comfyQueryHttpStatus : undefined;
  updatePendingTask(nodeId, {
    videoRecoveryState: 'paused',
    videoRecoveryMessage: error instanceof MediaPersistenceError ? error.message : reason ? VIDEO_PAUSE_MESSAGES[reason] : undefined,
    mediaRecoveryState: reason === 'delivery_pending' ? 'delivery_pending' : 'query_paused',
    mediaRecoveryReason: reason ?? 'query_interrupted',
    comfyQueryHttpStatus,
  }, task.taskId);
  if (isCurrentVideoTask(task)) {
    useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'idle', error: undefined, videoTaskState: 'paused',
      mediaTaskState: reason === 'delivery_pending' ? 'delivery_pending' : 'paused', mediaTaskStage: undefined,
      generationStartedAt: task.videoGenerationStartedAt });
  }
  return new VideoPollingPausedError(receiptForTask(task), getComfyQueryAuthorizationMessage(comfyQueryHttpStatus));
}

/** 仅在已取得任务 ID 的查询超时时转换控制状态；提交超时和远端失败不能冒充可恢复任务。 */
export function pauseVideoNodeTaskOnTimeout(nodeId: string | undefined, error: unknown, taskId?: string): VideoPollingPausedError | undefined {
  return nodeId && taskId && isPollTimeoutError(error) ? pauseVideoNodeTask(nodeId, taskId, undefined, 'query_timeout') : undefined;
}

export function completeVideoNodeTask(nodeId: string, expectedTaskId?: string): void {
  const task = loadAll().find((item) => item.nodeId === nodeId);
  if (task && isRecoverableVideoTask(task) && isCurrentVideoTask(task)
    && (expectedTaskId === undefined || task.taskId === expectedTaskId)) {
    completeMediaNodeTask(receiptForTask(task));
    if (loadAll().some((item) => matchesReceipt(item, receiptForTask(task)))) return;
    // localStorage 删除不会通知节点：完成同一任务时同步清除暂停标记，
    // 让已挂载的重试卡片收到 Store 更新，避免视频已交付仍显示旧提示。
    useAppStore.getState().updateNodeDataTransient(nodeId, { videoTaskState: undefined });
  }
}

/** 原结果已保存并写回后调用；不能用旧回执清理其他项目或新任务。 */
export function completeComfyNodeTask(nodeId: string, expectedTaskId: string | undefined): void {
  if (!expectedTaskId) return;
  const state = useAppStore.getState();
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === state.currentProjectId
    && item.taskType === 'comfyui' && item.submitted && item.taskId === expectedTaskId);
  if (task && state.nodes.some((node) => node.id === nodeId)) completeMediaNodeTask(receiptForTask(task));
}

/** 已生成的原任务尚未交付时，保留续取入口，且不触碰切换后的项目或新任务。 */
export function pauseComfyNodeDelivery(nodeId: string, expectedTaskId: string | undefined, isCurrent: () => boolean, error?: unknown): void {
  if (!expectedTaskId) return;
  endComfyNodeDelivery(nodeId, expectedTaskId);
  const task = loadAll().find((item) => item.nodeId === nodeId && item.taskType === 'comfyui'
    && item.submitted && item.taskId === expectedTaskId && item.comfyRecoveryState === 'save_pending');
  if (!task) return;
  const state = useAppStore.getState();
  if (isCurrent() && state.currentProjectId === task.projectId && state.nodes.some((node) => node.id === nodeId)) {
    pauseMediaTask(receiptForTask(task), error, 'delivery_pending');
  }
}

/** 新生成前将暂停任务移到恢复节点，保持每个节点一个任务的既有存储语义。 */
export function prepareVideoNodeGeneration(nodeId: string): void {
  const store = useAppStore.getState();
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === store.currentProjectId);
  if (!task && store.nodes.find((node) => node.id === nodeId)?.data.videoTaskState === 'paused') {
    // 复制节点或旧记录已清理时，新生成不能沿用没有任务身份的暂停计时。
    store.updateNodeDataTransient(nodeId, { status: 'idle', videoTaskState: undefined, error: undefined });
  }
  if (!task || !isRecoverableVideoTask(task) || task.videoRecoveryState !== 'paused') return;
  const source = store.nodes.find((node) => node.id === nodeId);
  if (!source || abortControllers.has(nodeId) || videoResumePromises.has(nodeId)) throw new Error('视频任务正在查询，请等待查询结束');
  const recoveryNodeId = generateId();
  const placement = derivedNodePlacement(source);
  // 同一源节点可以保留多个旧任务，避免恢复卡片完全重叠。
  while (store.nodes.some((node) => node.parentId === placement.parentId
    && Math.abs(node.position.x - placement.position.x) < 20 && Math.abs(node.position.y - placement.position.y) < 20)) {
    placement.position.y += (Number(source.data.nodeHeight) || 158) + 40;
  }
  const { nodeWidth, nodeHeight } = source.data;
  const originalTasks = loadAll();
  const tasks = originalTasks.map((item) => item.nodeId === nodeId && item.projectId === task.projectId
    ? { ...item, nodeId: recoveryNodeId, mediaContext: item.mediaContext
      ? { ...item.mediaContext, canvasNodeId: recoveryNodeId } : undefined } : item);
  // 先确保任务身份可持久化，再进行一次画布历史写入。
  saveAll(tasks);
  try {
    store.commitToHistory();
    store.addNodesTransient([{
      id: recoveryNodeId, type: 'ai-video', ...placement,
      data: { type: 'ai-video', role: 'generator', label: `${source.data.label} · 待恢复`,
        displayId: getNextDisplayId(store.nodes), nodeWidth, nodeHeight,
        ...(task.videoGeneration ?? captureVideoTaskGeneration(nodeId)), status: 'idle', videoTaskState: 'paused', mediaTaskState: 'paused',
        generationStartedAt: task.videoGenerationStartedAt ?? source.data.generationStartedAt },
    }]);
  } catch (error) {
    saveAll(originalTasks);
    throw error;
  }
  store.updateNodeDataTransient(nodeId, { videoTaskState: undefined, mediaTaskState: undefined, mediaTaskStage: undefined, error: undefined });
}

/** 再次生成是显式的新任务；先保留旧任务，不能覆盖其唯一恢复身份。 */
export function prepareMediaNodeGeneration(nodeId: string): void {
  const store = useAppStore.getState();
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === store.currentProjectId);
  if (!task) return;
  if (task.terminalFailure) { removeFailedMediaTask(receiptForTask(task)); return; }
  if (!isRecoverableMediaTask(task)) return;
  if (!task.taskId || !task.submitted || task.mediaSubmissionUncertain || task.mediaRecoveryState === 'submit_unknown') {
    throw new MediaTaskPausedError(receiptForTask(task), 'submit_unknown');
  }
  if (task.nodeType === 'ai-video') { prepareVideoNodeGeneration(nodeId); return; }
  if (!task.mediaRecoveryState) throw new Error('该节点仍有未交付的生成任务，请先继续查询');
  if (abortControllers.has(nodeId) || videoResumePromises.has(nodeId)) throw new Error('任务正在查询，请等待查询结束');
  const source = store.nodes.find((node) => node.id === nodeId);
  if (!source) return;
  const recoveryNodeId = generateId();
  const placement = derivedNodePlacement(source);
  const retainedCandidate = task.nodeType === 'ai-image' && (task.expectedImageOutputs ?? 1) > 1
    && source.data.artifactId === imageBatchArtifactId(receiptForTask(task), 0) && Boolean(source.data.imageUrl);
  const originalTasks = loadAll();
  saveAll(originalTasks.map((item) => item.nodeId === nodeId && item.projectId === task.projectId
    ? { ...item, nodeId: recoveryNodeId,
      ...(task.nodeType === 'ai-image' && (task.expectedImageOutputs ?? 1) > 1
        ? { imageOutputNodeIds: [...new Set([...(item.imageOutputNodeIds ?? []), nodeId])] } : {}),
      mediaContext: item.mediaContext
      ? { ...item.mediaContext, canvasNodeId: recoveryNodeId } : undefined } : item));
  try {
    store.commitToHistory();
    store.addNodesTransient([{ ...source, id: recoveryNodeId, ...placement, selected: false,
      data: { ...source.data, label: `${source.data.label} · 待恢复`, displayId: getNextDisplayId(store.nodes),
        status: 'idle', error: undefined,
        ...(!retainedCandidate ? { imageUrl: undefined, audioUrl: undefined, thumbnailUrl: undefined,
          output: undefined, sourceUrl: undefined, filePath: undefined } : {}),
        mediaTaskState: task.mediaRecoveryState === 'delivery_pending' ? 'delivery_pending' : 'paused', mediaTaskStage: undefined } }]);
  } catch (error) { saveAll(originalTasks); throw error; }
  store.updateNodeDataTransient(nodeId, { mediaTaskState: undefined, mediaTaskStage: undefined, error: undefined,
    ...(retainedCandidate ? { artifactId: undefined } : {}),
    ...(task.nodeType === 'ai-image' && (task.batchCount ?? 1) > 1 ? { batchGroupId: undefined } : {}) });
}

interface LegacyPendingTask extends PendingTask {
  apiKey?: string;
}

const PROVIDER_CONFIG_ID_BY_TASK_TYPE: Partial<Record<PendingTask['taskType'], string>> = {
  apimart: 'apimart',
  'apimart-flow-music': 'apimart',
  volcengine: 'volcengine',
  runninghub: 'runninghub-model',
};

function normalizeUrl(value?: string): string {
  return value?.trim().replace(/\/+$/, '') || '';
}

function inferLegacyProviderConfigId(task: LegacyPendingTask): string | undefined {
  if (task.providerConfigId) return task.providerConfigId;
  const knownProviderConfigId = PROVIDER_CONFIG_ID_BY_TASK_TYPE[task.taskType];
  if (knownProviderConfigId) return knownProviderConfigId;
  if (task.taskType !== 'general') return undefined;

  const legacyBaseUrl = normalizeUrl(task.baseUrl);
  const legacyApiKey = task.apiKey || '';
  return Object.entries(useAppStore.getState().config.providers).find(([, provider]) => (
    normalizeUrl(provider.baseUrl) === legacyBaseUrl
    && (legacyApiKey === '' || provider.apiKey === legacyApiKey)
  ))?.[0];
}

function sanitizePendingTask(task: LegacyPendingTask): PendingTask {
  const { baseUrl: legacyBaseUrl, comfyQueryHttpStatus, comfyOutputFile, comfyTextOutputNodeIds, mediaDownloadAccess, resultUrls, mediaFailureDiagnostic, terminalFailure,
    imageOutputNodeIds, ...safeTask } = task;
  delete safeTask.apiKey;
  const providerConfigId = inferLegacyProviderConfigId(task);
  const parameters = sanitizeMediaParameters(task.mediaContext?.parameters);
  const access = sanitizeMediaDownloadAccess(mediaDownloadAccess);
  const safeAccess = access?.providerConfigId === providerConfigId ? access : undefined;
  const urls = sanitizeMediaResultUrls(resultUrls, providerConfigId ? useAppStore.getState().config.providers[providerConfigId]?.apiKey : undefined);
  const outputFile = task.taskType === 'comfyui' ? sanitizeComfyOutputFile(comfyOutputFile) : undefined;
  const textOutputNodeIds = task.taskType === 'comfyui' && getGenerationNodeType(task.nodeType) === 'ai-text'
    && Array.isArray(comfyTextOutputNodeIds)
    ? [...new Set(comfyTextOutputNodeIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))] : [];
  const migratedImageNodes = task.nodeType === 'ai-image' && (task.expectedImageOutputs ?? 1) > 1 && Array.isArray(imageOutputNodeIds)
    ? [...new Set(imageOutputNodeIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  return {
    ...safeTask,
    nodeType: getGenerationNodeType(safeTask.nodeType),
    providerConfigId,
    ...(safeAccess ? { mediaDownloadAccess: safeAccess } : {}),
    ...(urls ? { resultUrls: urls } : {}),
    ...(outputFile ? { comfyOutputFile: outputFile } : {}),
    ...(textOutputNodeIds.length ? { comfyTextOutputNodeIds: textOutputNodeIds } : {}),
    ...(migratedImageNodes.length ? { imageOutputNodeIds: migratedImageNodes } : {}),
    ...(sanitizeMediaFailureDiagnostic(mediaFailureDiagnostic) ? { mediaFailureDiagnostic: sanitizeMediaFailureDiagnostic(mediaFailureDiagnostic) } : {}),
    ...(terminalFailure === true ? { terminalFailure: true as const } : {}),
    ...(task.taskType === 'comfyui' && legacyBaseUrl ? { baseUrl: legacyBaseUrl } : {}),
    ...(task.taskType === 'comfyui' && (comfyQueryHttpStatus === 401 || comfyQueryHttpStatus === 403) ? { comfyQueryHttpStatus } : {}),
    ...(task.mediaContext ? { mediaContext: { projectId: task.projectId,
      conversationId: task.mediaContext.conversationId, messageId: task.mediaContext.messageId,
      deliveryMode: task.mediaContext.deliveryMode, canvasNodeId: task.mediaContext.canvasNodeId, modelId: task.mediaContext.modelId,
      ...(sanitizeEditorTransition(task.mediaContext.editorTransition) ? { editorTransition: sanitizeEditorTransition(task.mediaContext.editorTransition) } : {}),
      ...(parameters ? { parameters } : {}) } } : {}),
  };
}

function updateMediaTaskSnapshot(tasks: PendingTask[], serialized: string | null): void {
  const snapshot = runtime.mediaTaskSnapshot;
  if (snapshot.serialized === serialized) return;
  snapshot.serialized = serialized;
  const key = (task: MediaTaskReceipt) => JSON.stringify([task.projectId, task.nodeId, task.attemptId]);
  const previous = new Map(snapshot.tasks.map((task) => [key(task), task]));
  const next = tasks.map((task): MediaTaskSnapshot => {
    const view: MediaTaskSnapshot = {
      projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId,
      submitted: task.submitted, mediaRecoveryState: task.mediaRecoveryState,
      mediaSubmissionUncertain: task.mediaSubmissionUncertain, expectedImageOutputs: task.expectedImageOutputs,
      ...(task.terminalFailure ? { terminalFailure: true as const } : {}),
      ...(task.mediaContext ? { mediaContext: Object.freeze({ conversationId: task.mediaContext.conversationId,
        messageId: task.mediaContext.messageId,
        ...(task.mediaContext.editorTransition ? { editorTransition: Object.freeze({
          anchorNodeId: task.mediaContext.editorTransition.anchorNodeId, requestId: task.mediaContext.editorTransition.requestId,
          ...(task.mediaContext.editorTransition.delivered ? { delivered: true as const } : {}),
        }) } : {}) }) } : {}),
      ...(task.imageOutputNodeIds ? { imageOutputNodeIds: Object.freeze([...task.imageOutputNodeIds]) } : {}),
      historyDownloadPending: isHistoryMediaDownloadPending(task),
    };
    const old = previous.get(key(task));
    return old && JSON.stringify(old) === JSON.stringify(view) ? old : Object.freeze(view);
  });
  if (next.length === snapshot.tasks.length && next.every((task, index) => task === snapshot.tasks[index])) return;
  snapshot.tasks = Object.freeze(next);
  snapshot.messageIdentities = new Set(next.filter((task) => task.mediaContext?.messageId)
    .map((task) => JSON.stringify([task.projectId, task.mediaContext?.conversationId || null, task.mediaContext?.messageId])));
}

function loadAll(): PendingTask[] {
  let raw: string | null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { throw new PendingMediaTaskSourceError('MEDIA_PENDING_SOURCE_UNAVAILABLE'); }
  const parsed = parseLegacyPendingTaskSource(raw);
  try {
    if (raw === null) { updateMediaTaskSnapshot([], null); return []; }
    const tasks = parsed.map(sanitizePendingTask);
    const serialized = JSON.stringify(tasks);
    if (serialized !== raw) localStorage.setItem(STORAGE_KEY, serialized);
    // loadAll 也由展示组件读取：只同步投影，不在调用者渲染期间通知其他组件。
    updateMediaTaskSnapshot(tasks, serialized);
    return tasks;
  } catch { throw new PendingMediaTaskSourceError('MEDIA_PENDING_SOURCE_UNAVAILABLE'); }
}

export interface PendingMediaTaskReadView {
  projectId: string; nodeId: string; taskId: string; provider: string; category: NodeType; stage: string;
  messageId?: string; conversationId?: string; canResume: boolean;
}
export type PendingMediaTaskReadResult = { status: 'ok'; tasks: PendingMediaTaskReadView[] }
  | { status: 'invalid' | 'unavailable'; errorCode: 'MEDIA_PENDING_SOURCE_INVALID' | 'MEDIA_PENDING_SOURCE_UNAVAILABLE' };

/** 查询专用投影：不落盘、不通知、不丢弃未知记录，也不把损坏源伪装成空队列。 */
export function readPendingMediaTaskViews(projectIds: readonly string[]): PendingMediaTaskReadResult {
  let raw: string | null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { return { status: 'unavailable', errorCode: 'MEDIA_PENDING_SOURCE_UNAVAILABLE' }; }
  if (raw === null) return { status: 'ok', tasks: [] };
  try {
    const parsed = parseLegacyPendingTaskSource(raw);
    const ids = new Set(projectIds);
    const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
      && value === value.trim() && value.length <= 512 && ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code >= 127 && code <= 159;
      });
    const types = LEGACY_PENDING_TASK_TYPES;
    const categories = new Set(['ai-image', 'ai-video', 'ai-audio', 'ai-text', 'ai-panorama', 'ai-animation']);
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
      || UNSUPPORTED_PENDING_EXECUTION_FIELDS.some((field) => Object.hasOwn(item, field))
      || !validId(item.projectId) || !validId(item.nodeId) || item.taskId !== undefined
        && (typeof item.taskId !== 'string' || item.taskId.length > 512)
      || !types.has(item.taskType) || !categories.has(getGenerationNodeType(item.nodeType))
      || item.mediaRecoveryState !== undefined && !['query_paused', 'delivery_pending', 'submit_unknown'].includes(item.mediaRecoveryState)
      || item.runninghubRecoveryState !== undefined && !['disconnected', 'cancel_pending', 'submit_unknown', 'save_pending'].includes(item.runninghubRecoveryState)
      || item.videoRecoveryState !== undefined && item.videoRecoveryState !== 'paused')) {
      return { status: 'invalid', errorCode: 'MEDIA_PENDING_SOURCE_INVALID' };
    }
    const tasks = parsed.filter((item) => ids.has(item.projectId)).map((item): PendingMediaTaskReadView => {
      const task = sanitizePendingTask({ ...item, taskId: item.taskId ?? '', submitted: item.submitted ?? false });
      return { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId,
        provider: types.has(task.provider) || task.provider === 'runninghubwf' ? task.provider : 'unknown', category: task.nodeType,
        stage: task.mediaRecoveryState ?? task.videoRecoveryState ?? task.runninghubRecoveryState
          ?? (!task.submitted || !task.taskId ? 'submit_unknown' : 'querying'),
        ...(validId(task.mediaContext?.messageId) ? { messageId: task.mediaContext.messageId } : {}),
        ...(validId(task.mediaContext?.conversationId) ? { conversationId: task.mediaContext.conversationId } : {}),
        canResume: Boolean(canResumeMediaTask(task)) };
    });
    return { status: 'ok', tasks };
  } catch { return { status: 'invalid', errorCode: 'MEDIA_PENDING_SOURCE_INVALID' }; }
}

function saveAll(tasks: PendingTask[]): void {
  // loadAll失败后其他入口不能以新数组覆盖未知或损坏的原付费队列。
  let raw: string | null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { throw new PendingMediaTaskSourceError('MEDIA_PENDING_SOURCE_UNAVAILABLE'); }
  parseLegacyPendingTaskSource(raw);
  parseLegacyPendingTaskSource(JSON.stringify(tasks));
  const sanitized = tasks.map(sanitizePendingTask);
  const serialized = JSON.stringify(sanitized);
  try { localStorage.setItem(STORAGE_KEY, serialized); }
  catch { throw new PendingMediaTaskSourceError('MEDIA_PENDING_SOURCE_UNAVAILABLE'); }
  updateMediaTaskSnapshot(sanitized, serialized);
  mediaTaskListeners.forEach((listener) => listener());
  let changed = false;
  for (const [key, active] of activeComfyDeliveries) {
    if (!tasks.some((task) => task.projectId === active.projectId && task.nodeId === active.nodeId && task.taskId === active.taskId)) {
      activeComfyDeliveries.delete(key); changed = true;
    }
  }
  if (changed) notifyComfyDeliveries();
}

function resolveProviderTaskConfig(
  task: PendingTask,
  fallbackProviderConfigId?: string,
  fallbackBaseUrl = '',
): { apiKey: string; baseUrl: string } | undefined {
  const providerConfigId = task.providerConfigId || fallbackProviderConfigId;
  if (!providerConfigId) return undefined;
  const provider = useAppStore.getState().config.providers[providerConfigId];
  if (!provider?.apiKey) return undefined;
  const baseUrl = normalizeUrl(provider.baseUrl || fallbackBaseUrl);
  if (!baseUrl) return undefined;
  return { apiKey: provider.apiKey, baseUrl };
}

/** 保存一条待续任务（同一 nodeId 会覆盖旧记录） */
export function savePendingTask(task: PendingTask): MediaTaskReceipt {
  const mediaContext = task.mediaContext ?? mediaTaskContexts.get(task.nodeId);
  task = { ...task, projectId: mediaContext?.projectId ?? task.projectId,
    attemptId: task.attemptId ?? generateId(), mediaContext };
  // 这些 Provider 在建立此占位后才提交远端异步任务。旧队列没有新画布代际，
  // 在提交前明确拒绝，不要留下无法恢复的付费任务；同步结果和本地 Comfy 保持原路径。
  const state = useAppStore.getState();
  const projectContext = state.projectExecutionContext;
  const target = state.projects.find((project) => project.id === task.projectId) as
    { nativeView?: { canvasId?: string | null } } | undefined;
  const nativeTarget = projectContext?.kind === 'canvas' && projectContext.modelGeneration > 0
    && projectContext.canvasId === task.projectId || target?.nativeView?.canvasId === task.projectId;
  const knownAsync = ['apimart', 'apimart-flow-music', 'dreamina', 'volcengine',
    'runninghub-workflow', 'runninghub-model'].includes(task.taskType)
    || task.taskType === 'workflow-api' && task.workflowApi?.manifest?.protocol.mode !== 'sync'
    || task.taskType === 'custom-protocol' && task.provider === 'grsai';
  if (!task.submitted && knownAsync && nativeTarget) {
    throw new Error('新项目暂不支持异步媒体任务恢复，未提交请求');
  }
  task = sanitizePendingTask(task);
  const tasks = loadAll().filter((t) => t.nodeId !== task.nodeId || t.projectId !== task.projectId);
  if (task.nodeType === 'ai-video') {
    const startedAt = task.videoGenerationStartedAt
      ?? useAppStore.getState().nodes.find((node) => node.id === task.nodeId)?.data.generationStartedAt;
    task = { ...task, videoGeneration: task.videoGeneration ?? captureVideoTaskGeneration(task.nodeId),
      videoGenerationStartedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now() };
  }
  tasks.push(task);
  saveAll(tasks);
  notifyMediaReceipt(task);
  return receiptForTask(task);
}

/** 更新已保存的待续任务（如回填 taskId） */
export function updatePendingTask(nodeId: string, patch: Partial<PendingTask>, expectedTaskId?: string, expectedAttemptId?: string): MediaTaskReceipt | undefined {
  const tasks = loadAll();
  const candidates = tasks.filter((task) => task.nodeId === nodeId);
  const projectId = mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  const idx = tasks.findIndex((task) => task.nodeId === nodeId
    && (expectedAttemptId !== undefined ? task.attemptId === expectedAttemptId
      : candidates.length === 1 || task.projectId === projectId));
  if (idx === -1) return;
  if (expectedTaskId !== undefined && tasks[idx].taskId !== expectedTaskId) return;
  if (expectedAttemptId !== undefined && tasks[idx].attemptId !== expectedAttemptId) return;
  const previous = tasks[idx];
  tasks[idx] = { ...previous, ...patch, nodeId: previous.nodeId, projectId: previous.projectId, attemptId: previous.attemptId };
  const outcome = mediaResumeOutcomes.get(JSON.stringify([previous.projectId, previous.nodeId]));
  if (outcome && matchesReceipt(previous, outcome.receipt)) outcome.receipt = receiptForTask(tasks[idx]);
  saveAll(tasks);
  notifyMediaReceipt(tasks[idx]);
  return receiptForTask(tasks[idx]);
}

/** 移除一条待续任务（轮询完成/失败/取消时调用） */
export function removePendingTask(nodeId: string, expectedTaskId?: string, expectedAttemptId?: string): void {
  const pollingProjectId = mediaTaskContexts.get(nodeId)?.projectId ?? runtime.pollingProjects.get(nodeId)
    ?? useAppStore.getState().currentProjectId;
  if (pollingProjectId && runtime.stoppedProjectIds.has(pollingProjectId)) return;
  const tasks = loadAll();
  const candidates = tasks.filter((task) => task.nodeId === nodeId);
  const contextProjectId = mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  const task = candidates.find((item) => expectedAttemptId !== undefined ? item.attemptId === expectedAttemptId
    : candidates.length === 1 || item.projectId === contextProjectId);
  if (expectedTaskId !== undefined && task?.taskId !== expectedTaskId) return;
  if (expectedAttemptId !== undefined && task?.attemptId !== expectedAttemptId) return;
  if (task && runtime.stoppedProjectIds.has(task.projectId)) return;
  const currentProjectId = useAppStore.getState().currentProjectId;

  // 后台请求可能在用户切换到其他项目后才结束。此时不能删除原项目的
  // pending 记录，否则切回去时 loading 节点会被当作孤立任务。
  if (task && currentProjectId && task.projectId !== currentProjectId) {
    return;
  }

  if (!task) return;
  if (task.mediaContext?.editorTransition && (task.submitted || task.mediaSubmissionUncertain
    || task.runninghubSubmissionUncertain || task.mediaRecoveryState === 'submit_unknown')) return;
  saveAll(tasks.filter((item) => !matchesReceipt(item, receiptForTask(task))));
  runninghubMessageWaiters.get(nodeId)?.();
  runninghubMessageWaiters.delete(nodeId);
  workflowApiMessageWaiters.get(nodeId)?.();
  workflowApiMessageWaiters.delete(nodeId);
}

/** 清理指定项目的所有待续任务 */
export function clearProjectTasks(projectId: string): void {
  const tasks = loadAll().filter((t) => t.projectId !== projectId);
  saveAll(tasks);
}

/** 获取指定项目的所有待续任务 */
export function getPendingTasksForProject(projectId: string): PendingTask[] {
  return loadAll().filter((t) => t.projectId === projectId);
}

// ═══════════════════════════════════════════
// 结果应用（镜像 AINodeDialog 的完成逻辑）
// ═══════════════════════════════════════════

async function applyNodeResult(
  nodeId: string,
  resultUrl: string,
  nodeLabel: string,
  isCurrent?: () => boolean,
  savedOutput?: { mediaUrl: string; sourceUrl: string; filePath?: string },
  generation?: PendingTask['videoGeneration'],
  mediaDownloadAccess?: MediaDownloadAccess,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (isCurrent && !isCurrent()) throw new CanvasResultStaleError();
  const store = useAppStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const data = node.data as BaseNodeData;
  const nodeType = getGenerationNodeType(data.type);
  const currentProjectId = store.currentProjectId;
  const historyReceipt = getMediaTaskReceipt(nodeId);

  // 下载远程 URL 到本地
  const guard = isCurrent ? registerCanvasDerivation(store, nodeId) : null;
  let persisted;
  try {
    persisted = savedOutput ?? (currentProjectId
      ? await persistMediaUrlToProjectData(resultUrl, currentProjectId, nodeType, nodeLabel, { mediaDownloadAccess, signal })
      : { mediaUrl: resultUrl, sourceUrl: resultUrl });
    signal?.throwIfAborted();
    if (isCurrent && (!isCurrent() || !guard || !isCanvasDerivationFresh(guard, useAppStore.getState()))) {
      throw new CanvasResultStaleError();
    }
  } finally {
    if (guard) completeCanvasDerivation(guard);
  }
  const mediaUrl = persisted.mediaUrl;

  const updateData: Partial<BaseNodeData> = {
    output: persisted.sourceUrl,
    sourceUrl: persisted.sourceUrl,
    filePath: persisted.filePath,
    thumbnailUrl: mediaUrl,
    status: 'success',
    error: undefined,
    videoTaskState: undefined,
    mediaTaskState: undefined,
    mediaTaskStage: undefined,
  };

  if (nodeType === 'ai-image' || nodeType === 'ai-panorama' || nodeType === 'ai-animation') {
    updateData.imageUrl = mediaUrl;
  } else if (nodeType === 'ai-video') {
    updateData.videoUrl = mediaUrl;
  } else if (nodeType === 'ai-audio') {
    updateData.audioUrl = mediaUrl;
  }

  store.updateNodeDataTransient(nodeId, updateData);
  // 异步轮询完成的生图也要回写短剧资产绑图
  if (nodeType === 'ai-image' || nodeType === 'ai-panorama') {
    store.syncDramaAssetImageFromNode?.(nodeId, mediaUrl);
  }
  await store.recordOutputHistory(nodeId, {
    nodeId,
    nodeLabel,
    timestamp: Date.now(),
    prompt: generation?.prompt ?? data.prompt ?? '',
    output: persisted.sourceUrl,
    nodeType,
    model: generation?.model ?? data.model ?? '',
    provider: generation?.provider ?? data.provider ?? '',
    status: 'success',
    mediaUrl,
    filePath: persisted.filePath,
  }, false, historyReceipt);
  const historyOutcome = currentProjectId ? mediaResumeOutcomes.get(JSON.stringify([currentProjectId, nodeId])) : undefined;
  if (historyReceipt && historyOutcome && historyOutcome.receipt.taskId === historyReceipt.taskId
    && historyOutcome.receipt.attemptId === historyReceipt.attemptId) historyOutcome.delivered = true;
  store.showToast(`${nodeLabel} 生成已完成`);
}

function getBatchTaskNodeIds(
  task: PendingTask,
  nodes: ReadonlyArray<{ id: string; data: BaseNodeData }>,
): string[] {
  if (task.nodeType !== 'ai-image' || (task.batchCount ?? 1) <= 1) return [task.nodeId];
  const sourceNode = nodes.find((node) => node.id === task.nodeId);
  const batchGroupId = sourceNode?.data.batchGroupId;
  if (!batchGroupId) return [task.nodeId];
  return nodes
    .filter((node) => node.id === task.nodeId || node.data.batchGroupId === batchGroupId)
    .map((node) => node.id);
}

async function handleResumeError(
  task: PendingTask,
  err: unknown,
  signal?: AbortSignal,
): Promise<void> {
  // 转场没有可写画布节点；保留原请求身份，不能落入普通节点清理或回填。
  if (task.mediaContext?.editorTransition) {
    if (err instanceof PollTaskFailedError) updatePendingTask(task.nodeId, { terminalFailure: true }, task.taskId, task.attemptId);
    else pauseMediaTask(receiptForTask(task), err, 'query_interrupted');
    return;
  }
  if (err instanceof PollTaskFailedError && useAppStore.getState().currentProjectId !== task.projectId) {
    removeFailedMediaTask(receiptForTask(task));
    return;
  }
  if (useAppStore.getState().currentProjectId !== task.projectId
    || !loadAll().some((item) => item.projectId === task.projectId && item.nodeId === task.nodeId && item.attemptId === task.attemptId)) return;
  if (err instanceof PollTaskFailedError) {
    const outcome = mediaResumeOutcomes.get(JSON.stringify([task.projectId, task.nodeId]));
    if (outcome && matchesReceipt(task, outcome.receipt)) outcome.error = err;
  }
  if (isRecoverableMediaTask(task) && !(err instanceof PollTaskFailedError)) {
    // 被更新一轮查询替代的旧回调不得更改正在查询的状态。
    if (signal?.aborted && abortControllers.get(task.nodeId)?.signal !== signal) return;
    const current = loadAll().find((item) => item.nodeId === task.nodeId && item.projectId === task.projectId
      && item.attemptId === task.attemptId);
    if (current) pauseMediaTask(receiptForTask(current), err,
      err instanceof CanvasResultStaleError ? 'canvas_changed'
        : err instanceof MediaPersistenceError || current.mediaRecoveryState === 'delivery_pending' ? 'delivery_pending'
          : isPollTimeoutError(err) ? 'query_timeout' : 'query_interrupted');
    return;
  }
  if (!isRecoverableMediaTask(task) && isRecoverableVideoTask(task)) {
    if (signal?.aborted || !isCurrentVideoTask(task, signal)) {
      if (!(err instanceof PollTaskFailedError)) pauseVideoNodeTask(task.nodeId, task.taskId);
      return;
    }
    if (!(err instanceof PollTaskFailedError)) {
      pauseVideoNodeTask(task.nodeId, task.taskId, err, err instanceof CanvasResultStaleError ? 'canvas_changed' : undefined);
      return;
    }
  }
  const msg = err instanceof Error ? err.message : String(err || '任务恢复失败');
  const store = useAppStore.getState();
  const nodeIds = failedTaskNodeIds(task);
  for (const node of store.nodes) {
    if (nodeIds.has(node.id) && node.data.status === 'loading') {
      store.updateNodeDataTransient(node.id, { status: 'error', error: msg });
    }
  }
  cleanupNodePolling(task.nodeId, signal);
  saveAll(loadAll().filter((item) => !matchesReceipt(item, receiptForTask(task))));
}

/** 对话任务由消息所属模块确认交付；这里不向当前打开的会话写入结果。 */
async function deliverMediaMessageResult(task: PendingTask, urls: string[], signal?: AbortSignal): Promise<boolean> {
  if (task.mediaContext?.editorTransition) {
    const sink = runtime.editorTransitionResultSinks.get(task.nodeId);
    if (!sink || !matchesReceipt(task, sink.receipt)) throw new Error('AI 转场结果已保留，请从原视频节点主动取回');
    sink.receive(task, urls);
    return true;
  }
  if (!task.mediaContext?.messageId || task.mediaContext.deliveryMode === 'node') return false;
  if (!isCurrentMediaTask(task, signal)) throw new CanvasResultStaleError();
  if (!runtime.mediaMessageRecoveryHandler) {
    const { ensureMediaMessageRecoveryHandler } = await import('./ai/generationRuntime');
    ensureMediaMessageRecoveryHandler();
  }
  if (!runtime.mediaMessageRecoveryHandler) throw new Error('对话任务恢复入口尚未就绪，任务已保留');
  signal?.throwIfAborted();
  await runtime.mediaMessageRecoveryHandler(task, urls, signal);
  return true;
}

function markMediaTaskDeliveryPending(task: PendingTask, signal?: AbortSignal, urls?: string[]): void {
  // 查询响应到达即保留事实；画布切换或取消信号只能阻止交付，不能抹掉已付费结果。
  if (task.mediaContext?.editorTransition) {
    const providerKey = task.providerConfigId ? useAppStore.getState().config.providers[task.providerConfigId]?.apiKey : undefined;
    const resultUrls = sanitizeMediaResultUrls(urls, providerKey);
    if (resultUrls) updatePendingTask(task.nodeId, { resultUrls, mediaRecoveryState: 'delivery_pending' }, task.taskId, task.attemptId);
  }
  signal?.throwIfAborted();
  if (!loadAll().some((item) => matchesReceipt(item, receiptForTask(task)))) return;
  updatePendingTask(task.nodeId, { mediaRecoveryState: 'delivery_pending' }, task.taskId, task.attemptId);
  if (isCurrentMediaTask(task)) {
    const nodeId = task.mediaContext?.canvasNodeId ?? task.nodeId;
    if (useAppStore.getState().nodes.some((node) => node.id === nodeId)) {
      useAppStore.getState().updateNodeDataTransient(nodeId, { mediaTaskStage: 'saving' });
    }
  }
}

// ═══════════════════════════════════════════
// 各供应商恢复逻辑
// ═══════════════════════════════════════════

/* ── APIMart ── */

interface ApimartTaskResult<TResult = Record<string, unknown>> {
  code: number;
  status?: string;
  progress?: number;
  result?: TResult;
}

async function fetchApimartTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
  timeoutAsPause = false,
): Promise<ApimartTaskResult> {
  const resp = await corsSafeFetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (timeoutAsPause && [408, 504].includes(resp.status)) throw new PollTimeoutError();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = (await resp.json()) as Record<string, unknown>;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    const d = raw.data as Record<string, unknown>;
    return {
      code: raw.code as number,
      status: (d.status ?? raw.status) as string | undefined,
      progress: (d.progress ?? raw.progress) as number | undefined,
      result: d.result as Record<string, unknown> | undefined,
    };
  }
  return raw as unknown as ApimartTaskResult;
}

function extractApimartUrls(
  result: Record<string, unknown> | undefined,
  nodeType: NodeType,
): string[] {
  if (!result) return [];
  const extractUrls = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const url = (item as { url?: unknown }).url;
      if (Array.isArray(url)) {
        return splitCommaSeparatedUrls(url.filter((entry): entry is string => typeof entry === 'string'));
      }
      return typeof url === 'string' ? splitCommaSeparatedUrls([url]) : [];
    });
  };
  if (nodeType === 'ai-video') {
    const urls = extractUrls(result.videos);
    if (urls.length > 0) return [urls[0]];
  }
  if (nodeType === 'ai-audio') {
    const urls = extractUrls(result.audios);
    if (urls.length > 0) return [urls[0]];
  }
  return extractUrls(result.images);
}

async function resumeApimart(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, nodeType } = task;
  const providerConfig = resolveProviderTaskConfig(task, 'apimart', APIMART_BASE_URL);
  const taskIds = (task.taskIds?.length ? task.taskIds : [task.taskId]).filter(Boolean);
  if (!providerConfig || taskIds.length === 0) {
    await handleResumeError(task, new Error('任务恢复失败：缺少 API 配置'));
    return;
  }
  const { apiKey, baseUrl } = providerConfig;
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const nodeData = node?.data as BaseNodeData | undefined;
  const label = nodeData?.label || '';

  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);

  try {
    // 旧任务没有访问描述时按原连接补齐；外部 CDN 仍不会收到连接密钥。
    const mediaDownloadAccess = task.mediaDownloadAccess ?? createMediaDownloadAccess(
      task.providerConfigId || 'apimart', baseUrl, { type: 'bearer' },
    );
    if (mediaDownloadAccess) {
      task = { ...task, mediaDownloadAccess };
      updatePendingTask(nodeId, { mediaDownloadAccess }, task.taskId, task.attemptId);
    }
    const settled = await settleMediaTaskQueries(taskIds.map((taskId) => (batchSignal: AbortSignal) => (
      pollTask<ApimartTaskResult, string[]>({
        fetchState: async (querySignal) => {
          try { return await fetchApimartTask(apiKey, baseUrl, taskId, querySignal, true); }
          catch (error) { if (nodeType === 'ai-video' && isPollTimeoutError(error)) throw new PollTimeoutError(); throw error; }
        },
        isComplete: (t) => {
          if (t.status !== 'completed') return null;
          const resolved = extractApimartUrls(t.result, nodeType);
          if (resolved.length === 0) throw new Error('任务完成但未返回结果');
          return resolved;
        },
        isFailed: (t) =>
          t.status === 'failed' || t.status === 'error' || t.status === 'cancelled' ? `任务失败: ${t.status}` : null,
        interval: 3000,
        maxDuration: MEDIA_POLL_MAX_DURATION_MS,
        onFetchError: 'throw',
        signal: batchSignal,
      })
    )), signal);
    const uncertain = settled.find((result) => result.status === 'rejected' && !(result.reason instanceof PollTaskFailedError));
    if (uncertain?.status === 'rejected') throw uncertain.reason;
    const urls = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (urls.length === 0) {
      const failed = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
      throw failed?.reason || new Error('任务完成但未返回结果');
    }
    const requestedCount = Math.max(1, task.batchCount ?? 1);
    markMediaTaskDeliveryPending(task, signal, urls);
    if (await deliverMediaMessageResult(task, urls, signal)) return;
    if (nodeType === 'ai-image' && requestedCount > 1 && nodeData) {
      const imageSize = (nodeData.imageSize as string) || '2K';
      const aspectRatio = (nodeData.aspectRatio as string) || '1:1';
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      const results = urls.slice(0, requestedCount).map((url) => ({ url, ...dimensions, mediaDownloadAccess, taskReceipt: receiptForTask(task) }));
      const delivered = await applyImageBatchResults({
        nodeId,
        batch: {
          requestedCount,
          results,
          failedCount: Math.max(0, requestedCount - results.length),
          allTasksSettled: true,
        },
        projectId: task.projectId,
        prompt: (nodeData.prompt as string) || '',
        imageSize,
        aspectRatio,
        isCurrent: query.isCurrent,
        signal,
      });
      if (!delivered) { pauseMediaTask(receiptForTask(task), undefined, 'delivery_pending'); return; }
    } else {
      await applyNodeResult(nodeId, urls[0], label, query.isCurrent, undefined, task.videoGeneration, mediaDownloadAccess, signal);
    }
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (err) {
    await handleResumeError(task, err, signal);
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

/* ── RunningHub 标准模型 ── */

interface RunningHubTaskResult {
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  results?: Array<{ url?: string | null }> | null;
}

async function fetchRunningHubTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<RunningHubTaskResult> {
  const response = await corsSafeFetch(`${baseUrl.replace(/\/+$/, '')}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ taskId }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const code = payload.code;
  if (!response.ok || (typeof code === 'number' && code !== 0)) {
    const message = typeof payload.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
    throw new Error(`RunningHub 任务查询失败：${message}`);
  }
  const data = payload.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as RunningHubTaskResult
    : payload as RunningHubTaskResult;
}

async function pollRunningHubTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal: AbortSignal,
): Promise<string[]> {
  return pollTask<RunningHubTaskResult, string[]>({
    fetchState: (querySignal) => fetchRunningHubTask(apiKey, baseUrl, taskId, querySignal),
    isComplete: (result) => {
      if (result.status?.toUpperCase() !== 'SUCCESS') return null;
      const urls = result.results?.flatMap((item) => item.url ? [item.url] : []) ?? [];
      if (urls.length === 0) throw new Error('RunningHub 任务完成但未返回图片');
      return urls;
    },
    isFailed: (result) => result.status?.toUpperCase() === 'FAILED'
      ? `RunningHub 任务失败：${result.errorMessage || result.errorCode || '未知错误'}`
      : null,
    interval: 3000,
    signal,
  });
}

async function resumeRunningHub(task: PendingTask): Promise<void> {
  const { nodeId } = task;
  const providerConfig = resolveProviderTaskConfig(
    task,
    'runninghub-model',
    RUNNINGHUB_MODEL_BASE_URL,
  );
  const taskIds = (task.taskIds?.length ? task.taskIds : [task.taskId]).filter(Boolean);
  if (!providerConfig || taskIds.length === 0) {
    useAppStore.getState().updateNodeDataTransient(nodeId, {
      status: 'error',
      error: '任务恢复失败：缺少 RunningHub 模型 API 配置',
    });
    return;
  }
  const { apiKey, baseUrl } = providerConfig;

  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  const nodeData = node?.data as BaseNodeData | undefined;
  if (!nodeData) {
    return;
  }

  const signal = registerNodePolling(nodeId);
  const query = guardVideoTaskQuery(task, signal);
  try {
    const settled = await Promise.allSettled(
      taskIds.map((taskId) => pollRunningHubTask(apiKey, baseUrl, taskId, signal)),
    );
    const urls = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (urls.length === 0) {
      const failed = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
      throw failed?.reason || new Error('RunningHub 图片生成未返回可用结果');
    }

    const requestedCount = Math.max(1, task.batchCount ?? taskIds.length);
    if (!query.isCurrent()) return;
    const imageSize = (nodeData.imageSize as string) || '2K';
    const aspectRatio = (nodeData.aspectRatio as string) || '1:1';
    const dimensions = mapImageDimensions(imageSize, aspectRatio);
    if (requestedCount > 1) {
      const results = urls.slice(0, requestedCount).map((url) => ({ url, ...dimensions }));
      await applyImageBatchResults({
        nodeId,
        batch: {
          requestedCount,
          results,
          failedCount: Math.max(0, requestedCount - results.length),
        },
        projectId: task.projectId,
        prompt: (nodeData.prompt as string) || '',
        imageSize,
        aspectRatio,
        isCurrent: query.isCurrent,
        signal,
      });
    } else {
      await applyNodeResult(nodeId, urls[0], nodeData.label || '', query.isCurrent, undefined, task.videoGeneration, task.mediaDownloadAccess, signal);
    }
    if (query.isTargetCurrent()) removePendingTask(nodeId, task.taskId, task.attemptId);
  } catch (error) {
    // 旧远端身份保留；过期、网络或交付失败都不能清队列后促使用户重新付费。
    if (query.isCurrent()) pauseMediaTask(receiptForTask(task), error,
      error instanceof CanvasResultStaleError ? 'canvas_changed' : 'query_interrupted');
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

async function pollFlowMusicTask(
  apiKey: string,
  baseUrl: string,
  taskId: string,
  signal: AbortSignal,
): Promise<FlowMusicTaskState> {
  return pollTask<FlowMusicTaskState, FlowMusicTaskState>({
    fetchState: (querySignal) => fetchFlowMusicTask(apiKey, baseUrl, taskId, querySignal),
    isComplete: (state) => state.status === 'completed' ? state : null,
    isFailed: (state) =>
      state.status === 'failed' || state.status === 'error'
        ? `APIMart 音乐任务失败: ${state.status}`
        : null,
    interval: 3000,
    onFetchError: 'throw',
    maxDuration: MEDIA_POLL_MAX_DURATION_MS,
    signal,
  });
}

/** 恢复只取回原阶段；歌词取回后由用户显式发起新的音乐生成。 */
async function resumeApimartFlowMusic(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId } = task;
  const providerConfig = resolveProviderTaskConfig(task, 'apimart', APIMART_BASE_URL);
  if (!providerConfig) {
    await handleResumeError(task, new Error('任务恢复失败：缺少 API 配置'));
    return;
  }
  const { apiKey, baseUrl } = providerConfig;

  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  const data = (node?.data ?? (task.mediaContext?.messageId ? { label: '', type: 'ai-audio' } : undefined)) as BaseNodeData | undefined;
  if (!data) {
    removePendingTask(nodeId);
    return;
  }

  const signal = registerNodePolling(nodeId, parentSignal);
  const taskId = task.taskId;
  const stage = task.audioTaskStage ?? 'music';
  const query = guardVideoTaskQuery(task, signal);

  try {
    if (stage === 'lyrics') {
      const generated = extractFlowMusicLyrics(
        await pollFlowMusicTask(apiKey, baseUrl, taskId, signal),
      );
      if (query.isCurrent && !query.isCurrent()) throw new CanvasResultStaleError();
      useAppStore.getState().updateNodeDataTransient(nodeId, {
        musicTitle: generated.title || data.musicTitle,
        musicLyrics: generated.lyrics,
        autoGenerateLyrics: false,
      });
      signal.throwIfAborted();
      completeMediaNodeTask(receiptForTask(task));
      useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'idle', error: undefined });
      useAppStore.getState().showToast('歌词已取回，请确认后生成音乐');
      return;
    }

    const result = extractFlowMusicTrack(
      await pollFlowMusicTask(apiKey, baseUrl, taskId, signal),
    );
    if (query.isCurrent && !query.isCurrent()) throw new CanvasResultStaleError();
    const latestData = useAppStore.getState().nodes.find((item) => item.id === nodeId)?.data as BaseNodeData | undefined;
    useAppStore.getState().updateNodeDataTransient(nodeId, {
      musicClipId: result.clipId,
      musicTitle: result.title || latestData?.musicTitle,
      musicLyrics: result.lyrics || latestData?.musicLyrics,
    });
    markMediaTaskDeliveryPending(task, signal, [result.url]);
    if (await deliverMediaMessageResult(task, [result.url], signal)) return;
    await applyNodeResult(nodeId, result.url, data.label, query.isCurrent, undefined, task.videoGeneration, task.mediaDownloadAccess, signal);
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (err) {
    await handleResumeError(task, err, signal);
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

/* ── 即梦 ── */

interface DreaminaOutput {
  url: string;
  localPath: string;
}
interface DreaminaQuery {
  status: 'pending' | 'success' | 'failed';
  outputs: DreaminaOutput[];
  failReason: string;
}

async function resumeDreamina(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, taskId } = task;
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);

  try {
    const out = await pollTask<DreaminaQuery, DreaminaOutput>({
      fetchState: () => invoke<DreaminaQuery>('dreamina_query_result', { submitId: taskId }),
      isComplete: (r) =>
        r.status === 'success' && r.outputs.length > 0 ? r.outputs[0] : null,
      isFailed: (r) =>
        r.status === 'failed' ? r.failReason || '即梦生成失败' : null,
      interval: 3000,
      maxDuration: 60 * 60 * 1000,
      timeoutMsg: '即梦生成超时',
      onFetchError: 'throw',
      signal,
    });

    const url = out.localPath ? convertFileSrc(out.localPath) : out.url;
    markMediaTaskDeliveryPending(task, signal, [url]);
    if (await deliverMediaMessageResult(task, [url], signal)) return;
    await applyNodeResult(nodeId, url, label, query.isCurrent, undefined, task.videoGeneration, task.mediaDownloadAccess, signal);
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (err) {
    await handleResumeError(task, err, signal);
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

/* ── ComfyUI ── */

async function resumeComfyUI(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, taskId, baseUrl, nodeType } = task;
  if (!baseUrl) {
    await handleResumeError(task, new Error('任务恢复失败：缺少 ComfyUI 地址'));
    return;
  }
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId, parentSignal);
  const deliveryGuard = node ? registerCanvasDerivation(useAppStore.getState(), nodeId) : null;
  const isCurrent = () => isCurrentMediaTask(task, signal)
    && (!node || (!!deliveryGuard && isCanvasDerivationFresh(deliveryGuard, useAppStore.getState())))
    && (nodeType !== 'ai-text' || useAppStore.getState().nodes.some((item) => item.id === nodeId
      && getGenerationNodeType(item.data.type) === 'ai-text'));

  const kinds: ComfyOutputKind[] =
    nodeType === 'ai-video' ? ['video']
      : nodeType === 'ai-audio' ? ['audio', 'video']
        : ['image'];
  const extract = (outputs: ComfyOutputs) => resolveComfyOutputUrl(baseUrl, outputs, kinds);
  let resultReceived = false;

  try {
    beginComfyNodeDelivery(nodeId, taskId);
    updatePendingTask(nodeId, { comfyQueryHttpStatus: undefined }, taskId, task.attemptId);
    if (nodeType === 'ai-text') {
      if (!node || getGenerationNodeType(node.data.type) !== 'ai-text') throw new CanvasResultStaleError();
      const { text } = await pollComfyTextHistory(baseUrl, taskId, task.comfyTextOutputNodeIds ?? [], signal);
      resultReceived = true;
      updatePendingTask(nodeId, { comfyRecoveryState: 'save_pending' }, taskId, task.attemptId);
      if (!isCurrent()) throw new CanvasResultStaleError();
      markMediaTaskDeliveryPending(task, signal);
      await maybeAutoReleaseComfyMemory(baseUrl, useAppStore.getState().config.comfyMemoryPolicy ?? 'smart').catch(() => {});
      if (!isCurrent()) throw new CanvasResultStaleError();
      const { getNodeHistoryEntries } = await import('./indexedDbService');
      const history = await getNodeHistoryEntries(task.projectId, nodeId);
      if (!isCurrent()) throw new CanvasResultStaleError();
      if (!history.some((entry) => entry.nodeType === 'ai-text' && entry.status === 'success'
        && entry.params?.comfyTextTaskId === taskId && entry.params?.comfyTextAttemptId === task.attemptId)) {
        await useAppStore.getState().recordOutputHistory(nodeId, {
          nodeId, nodeLabel: label, timestamp: Date.now(), prompt: node.data.prompt ?? '', output: text,
          nodeType: 'ai-text', model: node.data.model ?? '', provider: node.data.provider ?? 'comfyui', status: 'success',
          params: { comfyTextTaskId: taskId, comfyTextAttemptId: task.attemptId },
        }, true, receiptForTask(task));
      }
      signal.throwIfAborted();
      if (!isCurrent()) throw new CanvasResultStaleError();
      useAppStore.getState().updateNodeData(nodeId, { output: text, status: 'success', error: undefined,
        mediaTaskState: undefined, mediaTaskStage: undefined });
      completeMediaNodeTask(receiptForTask(task));
      useAppStore.getState().showToast(`${label} 生成已完成`);
      return;
    }
    // 与实时生成共用轮询：ComfyUI 重启后 promptId 会彻底消失，那里会连 /queue 一起确认并直接判失败，
    // 不再让恢复出来的任务空转一小时
    const cachedFile = sanitizeComfyOutputFile(task.comfyOutputFile);
    // 旧版本可能给音频任务缓存了封面；同样经过当前媒体识别规则，不能绕过类型检查。
    const cachedKey = nodeType === 'ai-audio' ? 'audio' : nodeType === 'ai-video' ? 'videos' : 'images';
    const cachedResult = cachedFile ? resolveComfyOutputUrl(baseUrl, { cached: { [cachedKey]: [cachedFile] } }, kinds) : null;
    const result = cachedResult ?? await pollComfyHistory(
      baseUrl,
      taskId,
      'ComfyUI 任务恢复超时（1 小时）',
      extract,
      signal,
    );
    resultReceived = true;
    const { url } = result;
    updatePendingTask(nodeId, { comfyRecoveryState: 'save_pending', comfyOutputFile: result.file }, taskId, task.attemptId);
    markMediaTaskDeliveryPending(task, signal, [url]);
    if (nodeType === 'ai-video') {
      updatePendingTask(nodeId, { videoRecoveryState: 'paused' }, taskId, task.attemptId);
    }
    await maybeAutoReleaseComfyMemory(
      baseUrl,
      useAppStore.getState().config.comfyMemoryPolicy ?? 'smart',
    ).catch(() => {});
    if (await deliverMediaMessageResult(task, [url], signal)) return;
    await applyNodeResult(nodeId, url, label, isCurrent, undefined, task.videoGeneration, task.mediaDownloadAccess, signal);
    signal.throwIfAborted();
    if (nodeType === 'ai-video') completeVideoNodeTask(nodeId, taskId);
    else completeComfyNodeTask(nodeId, taskId);
  } catch (err) {
    // 被删除、取消或新一轮查询替代时，不能清理当前任务或覆盖其界面状态。
    if (signal.aborted) return;
    if (nodeType === 'ai-text' && err instanceof RangeError) {
      resultReceived = true;
      updatePendingTask(nodeId, { comfyRecoveryState: 'save_pending' }, taskId, task.attemptId);
    }
    if (task.mediaContext?.messageId) {
      if (err instanceof PollTaskFailedError) await handleResumeError(task, err, signal);
      else {
        updatePendingTask(nodeId, { comfyRecoveryState: resultReceived ? 'save_pending'
          : err instanceof ComfyOutputUnavailableError ? 'output_unavailable' : 'disconnected' }, taskId, task.attemptId);
        pauseMediaTask(receiptForTask(task), err, resultReceived ? 'delivery_pending' : 'query_interrupted');
      }
      return;
    }
    if (err instanceof ComfyPendingError) {
      // 图片/音频切走后仍需恢复入口；视频另用 canvas_changed 保留本地交付状态。
      if (!(err instanceof CanvasResultStaleError) || nodeType !== 'ai-video') {
        updatePendingTask(nodeId, { comfyRecoveryState: resultReceived ? 'save_pending'
          : err instanceof ComfyOutputUnavailableError ? 'output_unavailable' : 'disconnected',
          comfyQueryHttpStatus: err instanceof ComfyQueryAuthorizationError ? err.status : undefined }, taskId, task.attemptId);
      }
      if (err instanceof ComfyQueryAuthorizationError) {
        pauseMediaTask(receiptForTask(task), err, 'query_interrupted');
        return;
      }
      if (nodeType === 'ai-video' && pauseVideoNodeTask(nodeId, taskId, err, err instanceof CanvasResultStaleError ? 'canvas_changed' : 'query_interrupted')) return;
      if (isCurrent()) useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'error', error: err.message });
    } else {
      await maybeAutoReleaseComfyMemory(
        baseUrl,
        useAppStore.getState().config.comfyMemoryPolicy ?? 'smart',
      ).catch(() => {});
      if (isCurrent()) {
        if (nodeType === 'ai-video' && resultReceived && !(err instanceof PollTaskFailedError)
          && pauseVideoNodeTask(nodeId, taskId, err, 'delivery_pending')) return;
        if (resultReceived && !(err instanceof PollTaskFailedError)) {
          updatePendingTask(nodeId, { comfyRecoveryState: 'save_pending' }, taskId, task.attemptId);
          pauseMediaTask(receiptForTask(task), err, 'delivery_pending');
          return;
        }
        await handleResumeError(task, err);
      }
    }
  } finally {
    endComfyNodeDelivery(nodeId, taskId);
    if (deliveryGuard) completeCanvasDerivation(deliveryGuard);
    cleanupNodePolling(nodeId, signal);
  }
}

/** 仅续查这个节点已提交的 ComfyUI 任务，不重新提交工作流。 */
export async function resumeComfyUINodeTask(nodeId: string): Promise<void> {
  const store = useAppStore.getState();
  if (!store.currentProjectId || !store.nodes.some((node) => node.id === nodeId)) return;
  const task = getPendingTasksForProject(store.currentProjectId).find((item) => (
    item.nodeId === nodeId && item.taskType === 'comfyui' && item.submitted && item.taskId
  ));
  if (!task || abortControllers.has(nodeId) || isComfyNodeDeliveryActive(task.projectId, nodeId)) return;
  store.updateNodeDataTransient(nodeId, { status: 'loading', error: undefined });
  await resumeComfyUI(task);
}

/* ── 通用异步 ── */

async function resumeGeneral(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, taskId, nodeType } = task;
  const providerConfig = resolveProviderTaskConfig(task);
  if (!providerConfig) {
    await handleResumeError(task, new Error('任务恢复失败：缺少 API 配置'));
    return;
  }
  const { apiKey, baseUrl } = providerConfig;
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';
  const resultField =
    nodeType === 'ai-video' ? 'videos' : nodeType === 'ai-audio' ? 'audios' : 'images';

  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);

  try {
    const { url } = await pollTask<Record<string, unknown>, { url: string }>({
      fetchState: async (querySignal) => {
        const pollResp = await corsSafeFetch(`${baseUrl}/tasks/${taskId}?language=zh`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: querySignal,
        });
        if ([408, 504].includes(pollResp.status)) throw new PollTimeoutError();
        if (!pollResp.ok) throw new Error(`HTTP ${pollResp.status}`);
        return (await pollResp.json()) as Record<string, unknown>;
      },
      isComplete: (raw) => {
        const t = (raw.data ?? raw) as Record<string, unknown>;
        if (t.status === 'completed') {
          const resolved = parseMultiPathResponse(
            (t.result ?? raw) as Record<string, unknown>,
            resultField,
          );
          if (resolved) return { url: resolved };
          throw new Error('任务完成但未返回结果');
        }
        return null;
      },
      isFailed: (raw) => {
        const t = (raw.data ?? raw) as Record<string, unknown>;
        return t.status === 'failed' || t.status === 'error' || t.status === 'cancelled'
          ? `任务失败: ${t.status}`
          : null;
      },
      interval: 3000,
      maxDuration: MEDIA_POLL_MAX_DURATION_MS,
      onFetchError: 'throw',
      signal,
    });
    markMediaTaskDeliveryPending(task, signal, [url]);
    if (await deliverMediaMessageResult(task, [url], signal)) return;
    await applyNodeResult(nodeId, url, label, query.isCurrent, undefined, task.videoGeneration, task.mediaDownloadAccess, signal);
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (err) {
    await handleResumeError(task, err, signal);
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

async function resumeCustomProtocol(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, nodeType, providerConfigId, protocolPoll } = task;
  const providerConfig = providerConfigId
    ? useAppStore.getState().config.providers[providerConfigId]
    : undefined;
  const resultUrls = sanitizeMediaResultUrls(task.resultUrls);
  if (!providerConfig || (!protocolPoll && !resultUrls)) {
    await handleResumeError(task, new Error('任务恢复失败：调用协议或连接配置已不存在'));
    return;
  }
  if (resultUrls && !task.mediaDownloadAccess && !(task.mediaContext?.editorTransition && protocolPoll)) {
    await handleResumeError(task, new Error('任务恢复失败：原结果的连接身份已丢失'));
    return;
  }
  const polls = task.protocolPolls?.length ? task.protocolPolls : protocolPoll ? [protocolPoll] : [];
  if (!providerConfig.apiKey && polls.some((poll) => poll.auth?.type !== 'none')) {
    await handleResumeError(task, new Error('任务恢复失败：连接尚未填写 API Key'));
    return;
  }

  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  const nodeData = (node?.data ?? (task.mediaContext?.messageId || task.mediaContext?.editorTransition ? { type: nodeType, label: '' } : undefined)) as BaseNodeData | undefined;
  if (!nodeData) {
    removePendingTask(nodeId);
    return;
  }

  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);
  try {
    // 旧异步记录在恢复时补齐无密钥下载描述，仍绑定原查询地址与连接。
    const mediaDownloadAccess = task.mediaDownloadAccess ?? (protocolPoll && providerConfigId
      ? createMediaDownloadAccess(providerConfigId, protocolPoll.url, protocolPoll.auth) : undefined);
    if (mediaDownloadAccess) {
      task = { ...task, mediaDownloadAccess };
      updatePendingTask(nodeId, { mediaDownloadAccess }, task.taskId, task.attemptId);
    }
    const settled = await settleMediaTaskQueries(polls.map((poll) => (querySignal: AbortSignal) => pollResolvedModelProtocol(
      { ...poll, maxDurationMs: poll.maxDurationMs ?? MEDIA_POLL_MAX_DURATION_MS },
      providerConfig.apiKey || '', querySignal, providerConfig.baseUrl,
      // 原任务只按已保存的查询合同识别，不借用连接现在的模型或自定义协议。
      usesMinimaxResolvedVideoPoll(poll, task.taskId, task.mediaDownloadAccess?.origin)
        ? assertMinimaxQueryResponse : undefined,
    )), signal);
    const uncertain = settled.find((result) => result.status === 'rejected' && !(result.reason instanceof PollTaskFailedError));
    if (uncertain?.status === 'rejected') throw uncertain.reason;
    // 可查询的原任务使用本轮结果，旧缓存不能覆盖刚刷新的签名地址。
    // 同步交付记录没有查询描述，只续存已取得的结果。
    const urls = polls.length > 0
      ? settled.flatMap((result) => result.status === 'fulfilled' ? result.value.urls ?? [] : [])
      : resultUrls ?? [];
    if (urls.length === 0) {
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      throw new Error('媒体模型任务完成但未返回结果 URL');
    }
    assertModelProtocolResult(nodeType === 'ai-video' ? 'video' : nodeType === 'ai-audio' ? 'audio' : 'image', { urls });
    markMediaTaskDeliveryPending(task, signal, urls);
    if (await deliverMediaMessageResult(task, urls, signal)) return;
    const requestedCount = Math.max(1, task.batchCount ?? 1);
    if (nodeType === 'ai-image' && requestedCount > 1) {
      const imageSize = nodeData.imageSize || '2K';
      const aspectRatio = nodeData.aspectRatio || '1:1';
      const dimensions = mapImageDimensions(imageSize, aspectRatio);
      const results = urls.slice(0, requestedCount).map((url) => ({ url, ...dimensions, mediaDownloadAccess, taskReceipt: receiptForTask(task) }));
      const delivered = await applyImageBatchResults({
        nodeId,
        batch: {
          requestedCount: task.expectedImageOutputs ? 1 : requestedCount,
          ...(task.expectedImageOutputs ? { expectedOutputCount: task.expectedImageOutputs } : {}),
          results,
          failedCount: Math.max(0, requestedCount - results.length),
          allTasksSettled: true,
        },
        projectId: task.projectId,
        prompt: nodeData.prompt || '',
        imageSize,
        imageQuality: nodeData.imageQuality,
        imageBackground: nodeData.imageBackground,
        aspectRatio,
        isCurrent: query.isCurrent,
        commitHistory: false,
        signal,
      });
      if (!delivered) { pauseMediaTask(receiptForTask(task), undefined, 'delivery_pending'); return; }
      return;
    } else {
      const url = urls[0];
      if (!url) throw new Error('任务完成但未返回结果 URL');
      await applyNodeResult(nodeId, url, nodeData.label || '', query.isCurrent, undefined, task.videoGeneration, mediaDownloadAccess, signal);
    }
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (error) {
    await handleResumeError(task, error, signal);
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

/* ── 火山方舟 Seedance ── */

async function resumeVolcengine(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, taskId } = task;
  const { findBillingRunByTask, updateBillingRun } = await import('./billing/volcengineBillingService');
  const { quoteVolcengineVideo } = await import('./billing/volcenginePricing');
  const run = await findBillingRunByTask(taskId, task.projectId).catch(() => null);
  const providerConfig = resolveProviderTaskConfig(task, 'volcengine', VOLCENGINE_BASE_URL);
  if (!providerConfig) {
    await updateBillingRun(run, { status: 'unknown', errorMessage: '缺少 API 配置，任务待恢复查询' });
    pauseVideoNodeTask(nodeId, taskId);
    return;
  }
  const { apiKey, baseUrl } = providerConfig;
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);
  let remoteFailed = false;
  let remoteCancelled = false;
  let remoteSucceeded = false;

  try {
    const { url, completionTokens } = await pollVolcengineVideoTask({
      apiKey, baseUrl, taskId, signal, maxDuration: VIDEO_POLL_MAX_DURATION_MS,
      onFailed: (status) => {
        remoteFailed = true;
        remoteCancelled = status === 'cancelled';
      },
    });
    if (run) {
      const input = JSON.parse(run.inputJson) as { durationSeconds?: number; resolution?: string; ratio?: string; referenceType?: string };
      const quote = completionTokens === undefined ? null : quoteVolcengineVideo({
        modelId: run.modelId, durationSeconds: input.durationSeconds ?? -1,
        resolution: input.resolution ?? '720p', ratio: input.ratio ?? '16:9',
        inputVideoSeconds: input.referenceType === 'video-reference' ? 1 : undefined,
        completionTokens,
      });
      await updateBillingRun(run, { status: 'succeeded', finishedAt: Date.now(),
        calculatedMicros: quote?.amountMicros ?? null, amountConfidence: quote?.amountMicros == null ? 'unknown' : 'usage',
        inputJson: JSON.stringify({ ...input, completionTokens: completionTokens ?? null }) });
    }
    remoteSucceeded = true;
    markMediaTaskDeliveryPending(task, signal, [url]);
    if (await deliverMediaMessageResult(task, [url], signal)) return;
    await applyNodeResult(nodeId, url, label, query.isCurrent, undefined, task.videoGeneration, task.mediaDownloadAccess, signal);
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (err) {
    if (!remoteSucceeded) await updateBillingRun(run, {
      status: remoteCancelled ? 'cancelled' : remoteFailed ? 'failed' : 'unknown', finishedAt: Date.now(),
      calculatedMicros: remoteFailed ? 0 : null, amountConfidence: remoteFailed ? 'calculated' : 'unknown',
      errorMessage: err instanceof Error ? err.message : '恢复查询失败',
    });
    if (remoteFailed) {
      await handleResumeError(task, err, signal);
    } else {
      if (isCurrentVideoTask(task, signal)) pauseVideoNodeTask(nodeId, taskId);
    }
  } finally {
    cleanupNodePolling(nodeId, signal);
    query.complete();
  }
}

// ═══════════════════════════════════════════
// 恢复入口
// ═══════════════════════════════════════════

async function queryRunningHubPendingTask(task: PendingTask, connection: import('../types/runninghub').RunningHubConnection,
  kind: import('../types/runninghub').RunningHubMediaKind, signal: AbortSignal, onStatus?: (stage: string) => void) {
  if (task.taskType === 'runninghub-model') {
    const { queryRunningHubModel } = await import('./ai/providers/runninghubMedia');
    return queryRunningHubModel(connection, task.taskIds?.length ? task.taskIds : [task.taskId], kind, signal, onStatus);
  }
  const { queryRunningHubWorkflow } = await import('./ai/providers/runninghubWorkflow');
  return queryRunningHubWorkflow(connection, task.taskId, kind, task.runninghubOutputNodeIds, signal, onStatus);
}

function runningHubMessageIsCurrent(task: PendingTask): boolean {
  const context = task.runninghubMessage;
  const store = useAppStore.getState();
  return !!context && store.currentProjectId === task.projectId && context.projectId === task.projectId
    && store.messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId);
}

/** 项目先加载画布、再加载当前会话；等原消息进入 Store 后才能恢复回填。 */
function scheduleRunningHubMessageRecovery(task: PendingTask, savedOutputs?: import('../types/runninghub').RunningHubOutput[]) {
  runninghubMessageWaiters.get(task.nodeId)?.();
  runninghubMessageWaiters.delete(task.nodeId);
  if (runningHubMessageIsCurrent(task)) { void resumeRunningHubMessageTask(task, savedOutputs); return; }
  if (useAppStore.getState().currentProjectId !== task.projectId) return;
  const lease = registerPendingTaskContextGuard(task);
  if (!lease.isCurrent()) { lease.complete(); return; }
  const stopWaiting = () => { unsubscribe(); lease.complete(); runninghubMessageWaiters.delete(task.nodeId); };
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!lease.isCurrent()) { stopWaiting(); return; }
    if (state.currentProjectId === previous.currentProjectId && state.messages === previous.messages) return;
    if (state.currentProjectId !== task.projectId || !getPendingTasksForProject(task.projectId).some((item) => item.nodeId === task.nodeId && item.taskId === task.taskId)) {
      stopWaiting(); return;
    }
    if (runningHubMessageIsCurrent(task)) {
      stopWaiting(); void resumeRunningHubMessageTask(task, savedOutputs);
    }
  });
  runninghubMessageWaiters.set(task.nodeId, stopWaiting);
}

function applyRunningHubRecoveredMessage(task: PendingTask, outputs: import('../types/runninghub').RunningHubOutput[]) {
  if (!runningHubMessageIsCurrent(task) || !outputs.length) return;
  const context = task.runninghubMessage!;
  const store = useAppStore.getState();
  const previous = store.messages.find((message) => message.id === context.messageId)?.mediaResult;
  const first = outputs[0];
  store.updateMessage(context.messageId, {
    mediaStatus: 'succeeded', mediaError: undefined,
    mediaResult: { id: previous?.id ?? `runninghub-${task.taskId}`, kind: first.kind, deliveryMode: context.deliveryMode,
      url: first.url, sourceUrl: first.sourceUrl ?? first.url, filePath: first.filePath, persistence: first.filePath ? 'saved' : 'skipped',
      prompt: previous?.prompt ?? '', modelId: task.runninghubModelId ?? `runninghubwf/${task.runninghubWorkflowId ?? ''}`, provider: task.taskType === 'runninghub-model' ? 'runninghub' : 'runninghubwf', createdAt: Date.now(), runninghubOutputs: outputs },
    ...(context.deliveryMode !== 'chat' ? { canvasStatus: 'created' as const, canvasNodeId: task.nodeId, canvasError: undefined } : {}),
  });
}

async function resumeRunningHubMessageTask(task: PendingTask, savedOutputs?: import('../types/runninghub').RunningHubOutput[]): Promise<void> {
  const lease = registerPendingTaskContextGuard(task);
  try { if (lease.isCurrent()) await resumeRunningHubMessageWithContext(task, savedOutputs, lease); }
  finally { lease.complete(); }
}

async function resumeRunningHubMessageWithContext(task: PendingTask,
  savedOutputs: import('../types/runninghub').RunningHubOutput[] | undefined,
  lease: ReturnType<typeof registerPendingTaskContextGuard>): Promise<void> {
  if (!lease.isCurrent() || !runningHubMessageIsCurrent(task) || abortControllers.has(task.nodeId)) return;
  const context = task.runninghubMessage!;
  if (!task.taskId) {
    useAppStore.getState().updateMessage(context.messageId, { mediaStatus: 'failed', mediaError: 'RunningHub 提交状态未知，请到平台核对任务，避免重复生成' }); return;
  }
  const { saveRunningHubOutputs, RunningHubTaskFailed } = await import('./ai/providers/runninghubWorkflow');
  const { runningHubConnection } = await import('./workflowExecutionService');
  if (!lease.isCurrent() || !runningHubMessageIsCurrent(task) || abortControllers.has(task.nodeId)) return;
  const signal = registerNodePolling(task.nodeId);
  lease.bindSignal(signal);
  const fresh = () => lease.isCurrent() && !signal.aborted && runningHubMessageIsCurrent(task)
    && getPendingTasksForProject(task.projectId).some((item) => matchesReceipt(item, receiptForTask(task)));
  try {
    if (!fresh()) return;
    const kind = ['ai-image', 'ai-animation', 'ai-panorama'].includes(task.nodeType) ? 'image' : task.nodeType === 'ai-video' ? 'video' : task.nodeType === 'ai-audio' ? 'audio' : undefined;
    if (!kind) throw new Error('RunningHub 任务输出类型无效');
    useAppStore.getState().updateMessage(context.messageId, { mediaStatus: 'generating', mediaError: undefined });
    let saved = savedOutputs;
    if (!saved) {
      const connection = runningHubConnection(useAppStore.getState().config.providers, task.providerConfigId === 'runninghub-model' ? 'runninghub-model' : 'runninghub', task.runninghubSite);
      const outputs = await queryRunningHubPendingTask(task, connection, kind, signal);
      if (!fresh()) return;
      updatePendingTask(task.nodeId, { runninghubRecoveryState: 'save_pending' }, task.taskId);
      saved = await saveRunningHubOutputs(outputs, task.projectId, 'RunningHub 对话产物', fresh);
    }
    if (!fresh()) return;
    applyRunningHubRecoveredMessage(task, saved);
    if (!task.runninghubSubmissionUncertain) removePendingTask(task.nodeId, task.taskId);
  } catch (error) {
    if (fresh()) useAppStore.getState().updateMessage(context.messageId, { mediaStatus: 'failed', mediaError: error instanceof RunningHubTaskFailed ? error.message : `RunningHub 任务 ${task.taskId} 已保留，重新打开项目可继续查询` });
    if (fresh() && error instanceof RunningHubTaskFailed && !task.runninghubSubmissionUncertain) removePendingTask(task.nodeId, task.taskId);
  } finally { cleanupNodePolling(task.nodeId, signal); }
}

async function resumeRunningHubWorkflow(task: PendingTask): Promise<void> {
  const lease = registerPendingTaskContextGuard(task);
  try { if (lease.isCurrent()) await resumeRunningHubWorkflowWithContext(task, lease); }
  finally { lease.complete(); }
}

async function resumeRunningHubWorkflowWithContext(task: PendingTask, lease: ReturnType<typeof registerPendingTaskContextGuard>): Promise<void> {
  const { saveRunningHubOutputs, RunningHubTaskFailed } = await import('./ai/providers/runninghubWorkflow');
  const { runningHubConnection } = await import('./workflowExecutionService');
  const { nodeId, projectId, taskId } = task;
  if (!lease.isCurrent() || !taskId || abortControllers.has(nodeId)) return;
  const signal = registerNodePolling(nodeId);
  lease.bindSignal(signal);
  const guard = registerCanvasDerivation(useAppStore.getState(), nodeId);
  const isCurrent = () => lease.isCurrent() && !signal.aborted && !!guard && isCanvasDerivationFresh(guard, useAppStore.getState())
    && getPendingTasksForProject(projectId).some((item) => matchesReceipt(item, receiptForTask(task)));
  try {
    if (!isCurrent()) return;
    const store = useAppStore.getState();
    const node = store.nodes.find((item) => item.id === nodeId)!;
    const kind = ['ai-image', 'ai-animation', 'ai-panorama'].includes(task.nodeType) ? 'image' : task.nodeType === 'ai-video' ? 'video' : task.nodeType === 'ai-audio' ? 'audio' : undefined;
    if (!kind || getGenerationNodeType(node.data.type) !== task.nodeType || (task.runninghubWorkflowId && node.data.workflowId !== task.runninghubWorkflowId) || (task.runninghubModelId && node.data.model !== task.runninghubModelId)) throw new Error('节点工作流或输出类型已变化，请在平台核对原任务');
    store.updateNodeDataTransient(nodeId, { status: 'loading', error: undefined, runninghubStage: '恢复查询' });
    const connection = runningHubConnection(store.config.providers, task.providerConfigId === 'runninghub-model' ? 'runninghub-model' : 'runninghub', task.runninghubSite);
    const outputs = await queryRunningHubPendingTask(task, connection, kind, signal, (runninghubStage) => {
      if (isCurrent()) useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubStage });
    });
    if (!isCurrent()) return;
    updatePendingTask(nodeId, { runninghubRecoveryState: 'save_pending' }, taskId);
    const saved = await saveRunningHubOutputs(outputs, projectId, node.data.label, isCurrent);
    if (!isCurrent()) return;
    useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubOutputs: saved, runninghubStage: '保存产物' });
    const targetIds = kind === 'image' && task.taskType === 'runninghub-model' ? getBatchTaskNodeIds(task, store.nodes) : [nodeId];
    for (const [index, targetId] of targetIds.entries()) {
      if (!isCurrent()) return;
      const output = saved[index];
      if (!output) { useAppStore.getState().updateNodeDataTransient(targetId, { status: 'error', error: '此批次未返回对应产物，请核对平台任务' }); continue; }
      await applyNodeResult(targetId, output.url, node.data.label, isCurrent, { mediaUrl: output.url, sourceUrl: output.sourceUrl ?? output.url, filePath: output.filePath });
    }
    if (signal.aborted || useAppStore.getState().currentProjectId !== projectId) return;
    useAppStore.getState().updateNodeDataTransient(nodeId, { runninghubStage: '已完成' });
    if (task.runninghubMessage && !runningHubMessageIsCurrent(task)) {
      // 画布先恢复完成时，保留记录直到原对话加载；复用已保存产物而不再次下载。
      scheduleRunningHubMessageRecovery(task, saved);
      return;
    }
    applyRunningHubRecoveredMessage(task, saved);
    if (!task.runninghubSubmissionUncertain) removePendingTask(nodeId, taskId);
  } catch (error) {
    const canReport = isCurrent();
    if (canReport && error instanceof RunningHubTaskFailed && !task.runninghubSubmissionUncertain) removePendingTask(nodeId, taskId, task.attemptId);
    if (canReport) useAppStore.getState().updateNodeDataTransient(nodeId, {
      status: 'error', error: error instanceof Error ? error.message : 'RunningHub 查询失败，任务已保留', runninghubStage: '查询已停止',
    });
  } finally {
    if (guard) completeCanvasDerivation(guard);
    cleanupNodePolling(nodeId, signal);
  }
}

export async function resumeRunningHubNodeTask(nodeId: string): Promise<void> {
  const projectId = useAppStore.getState().currentProjectId;
  const task = projectId ? getPendingTasksForProject(projectId).find((item) => item.nodeId === nodeId && ['runninghub-workflow', 'runninghub-model'].includes(item.taskType)) : undefined;
  if (!task) return;
  if (!task.taskId) throw new Error('提交状态未知，请先在平台查找任务 ID');
  await resumeRunningHubWorkflow(task);
}

function workflowApiMessageIsCurrent(task: PendingTask): boolean {
  const context = task.workflowApiMessage;
  const store = useAppStore.getState();
  return !!context && store.currentProjectId === task.projectId && context.projectId === task.projectId
    && store.messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId);
}

function scheduleWorkflowApiMessageRecovery(task: PendingTask): void {
  workflowApiMessageWaiters.get(task.nodeId)?.();
  workflowApiMessageWaiters.delete(task.nodeId);
  if (workflowApiMessageIsCurrent(task)) { void resumeWorkflowApi(task); return; }
  if (useAppStore.getState().currentProjectId !== task.projectId) return;
  const lease = registerPendingTaskContextGuard(task);
  if (!lease.isCurrent()) { lease.complete(); return; }
  const stopWaiting = () => { unsubscribe(); lease.complete(); workflowApiMessageWaiters.delete(task.nodeId); };
  const unsubscribe = useAppStore.subscribe(() => {
    if (!lease.isCurrent() || useAppStore.getState().currentProjectId !== task.projectId || !getPendingTasksForProject(task.projectId)
      .some((item) => item.nodeId === task.nodeId && item.workflowApi?.attemptId === task.workflowApi?.attemptId)) {
      stopWaiting(); return;
    }
    if (workflowApiMessageIsCurrent(task)) {
      stopWaiting(); void resumeWorkflowApi(task);
    }
  });
  workflowApiMessageWaiters.set(task.nodeId, stopWaiting);
}

async function resumeWorkflowApi(task: PendingTask): Promise<void> {
  const lease = registerPendingTaskContextGuard(task);
  try { if (lease.isCurrent()) await resumeWorkflowApiWithContext(task, lease); }
  finally { lease.complete(); }
}

async function resumeWorkflowApiWithContext(task: PendingTask, lease: ReturnType<typeof registerPendingTaskContextGuard>): Promise<void> {
  if (abortControllers.has(task.nodeId) || useAppStore.getState().currentProjectId !== task.projectId) return;
  if (task.workflowApiMessage && !workflowApiMessageIsCurrent(task)) { scheduleWorkflowApiMessageRecovery(task); return; }
  const adapter: typeof import('./workflowApi/workflowApiAdapter') = await import('./workflowApi/workflowApiAdapter');
  const manifestModule: typeof import('./workflowApi/autodlWorkflowManifest') = await import('./workflowApi/autodlWorkflowManifest');
  const { saveCloudWorkflowOutputs } = await import('./workflowExecutionService');
  if (!lease.isCurrent() || abortControllers.has(task.nodeId) || useAppStore.getState().currentProjectId !== task.projectId) return;
  const signal = registerNodePolling(task.nodeId);
  lease.bindSignal(signal);
  const context = task.workflowApiMessage;
  const messageOnly = !!context && context.deliveryMode === 'chat' && task.nodeId === `workflow-api-message-${context.messageId}`;
  const guard = messageOnly ? null : registerCanvasDerivation(useAppStore.getState(), task.nodeId);
  const isCurrent = () => lease.isCurrent() && !signal.aborted && (messageOnly || (!!guard && isCanvasDerivationFresh(guard, useAppStore.getState())))
    && (!context || workflowApiMessageIsCurrent(task))
    && getPendingTasksForProject(task.projectId).some((item) => matchesReceipt(item, receiptForTask(task))
      && item.taskType === 'workflow-api' && item.workflowApi?.attemptId === task.workflowApi?.attemptId);
  try {
    if (!isCurrent()) return;
    adapter.validateWorkflowApiTaskDescriptor(task.workflowApi);
    const descriptor = task.workflowApi;
    if (!task.submitted || !task.taskId) throw new Error('工作流提交状态未知，请到平台确认任务后再继续，勿重复生成');
    const store = useAppStore.getState();
    const node = store.nodes.find((item) => item.id === task.nodeId);
    const workflow = store.workflows.find((item) => item.id === descriptor.workflowId);
    const expectedType = descriptor.manifest ? `ai-${descriptor.manifest.outputKind}` : 'ai-video';
    if ((!messageOnly && (!node || getGenerationNodeType(node.data.type) !== expectedType || node.data.workflowId !== descriptor.workflowId)) || task.nodeType !== expectedType
      || workflow?.adapterType !== 'workflow-api' || workflow.category !== expectedType) throw new Error('节点工作流或输出类型已变化，请在平台核对原任务');
    manifestModule.validateWorkflowApiManifest(workflow.workflowApi);
    if (workflow.workflowApi.workflowId !== descriptor.remoteWorkflowId || workflow.workflowApi.connectionId !== task.providerConfigId) throw new Error('工作流连接或远端定义已变化，请在平台核对原任务');
    const connection = adapter.workflowApiConnection(task.providerConfigId ? store.config.providers[task.providerConfigId] : undefined, descriptor.manifest ?? workflow.workflowApi);
    if (node) store.updateNodeDataTransient(task.nodeId, { status: 'loading', error: undefined, workflowApiStage: '恢复查询' });
    if (context) store.updateMessage(context.messageId, { mediaStatus: 'generating', mediaError: undefined });
    const outputs = await adapter.queryWorkflowApiTask(connection, task.taskId, descriptor, signal, (workflowApiStage) => {
      if (node && isCurrent()) useAppStore.getState().updateNodeDataTransient(task.nodeId, { workflowApiStage });
    });
    if (!isCurrent()) return;
    updatePendingTask(task.nodeId, { workflowApi: { ...descriptor, state: 'save_pending', ...(descriptor.adapter === 'declarative' ? { outputs } : {}) } }, task.taskId);
    const saved = await saveCloudWorkflowOutputs(outputs, task.projectId, node?.data.label ?? workflow.name, isCurrent, '工作流 API');
    if (!isCurrent()) return;
    if (node) {
      useAppStore.getState().updateNodeDataTransient(task.nodeId, { workflowApiOutputs: saved });
      await applyNodeResult(task.nodeId, saved[0].url, node.data.label, isCurrent, {
        mediaUrl: saved[0].url, sourceUrl: saved[0].sourceUrl ?? saved[0].url, filePath: saved[0].filePath,
      });
    }
    if (!isCurrent()) return;
    if (node) useAppStore.getState().updateNodeDataTransient(task.nodeId, { workflowApiStage: '已完成' });
    if (context) {
      const first = saved[0];
      useAppStore.getState().updateMessage(context.messageId, {
        mediaStatus: 'succeeded', mediaError: undefined,
        mediaResult: { id: `workflow-api-${task.taskId}`, kind: descriptor.manifest?.outputKind ?? 'video', deliveryMode: context.deliveryMode,
          url: first.url, sourceUrl: first.sourceUrl ?? first.url, filePath: first.filePath, persistence: first.filePath ? 'saved' : 'skipped',
          prompt: '', modelId: `workflow-api/${workflow.id}`, provider: 'workflow-api', createdAt: Date.now(), workflowApiOutputs: saved },
        ...(node ? { canvasStatus: 'created', canvasNodeId: node.id, canvasError: undefined } : {}),
      });
    }
    removePendingTask(task.nodeId, task.taskId);
  } catch (error) {
    const canReport = isCurrent();
    if (canReport && error instanceof adapter.WorkflowApiTaskFailed) removePendingTask(task.nodeId, task.taskId);
    if (canReport && !messageOnly) useAppStore.getState().updateNodeDataTransient(task.nodeId, {
      status: 'error', error: error instanceof Error ? error.message : '工作流查询失败，任务已保留', workflowApiStage: '查询已停止',
    });
    if (canReport && context) useAppStore.getState().updateMessage(context.messageId, {
      mediaStatus: 'failed', mediaError: error instanceof Error ? error.message : '工作流查询失败，任务已保留',
    });
  } finally {
    // 过期结果不能回填，但原任务的 loading 必须结束，才能显示继续查询入口。
    const current = useAppStore.getState();
    const node = current.nodes.find((item) => item.id === task.nodeId);
    if (!messageOnly && lease.isCurrent() && !signal.aborted && current.currentProjectId === task.projectId
      && node?.data.status === 'loading' && getGenerationNodeType(node.data.type) === task.nodeType
      && node.data.workflowId === task.workflowApi?.workflowId
      && !isCurrent()
      && getPendingTasksForProject(task.projectId).some((item) => item.nodeId === task.nodeId
        && item.taskType === 'workflow-api' && item.taskId === task.taskId
        && item.workflowApi?.attemptId === task.workflowApi?.attemptId)) {
      current.updateNodeDataTransient(task.nodeId, {
        status: 'error', error: '画布已变化，工作流任务已保留，请继续查询 / 保存', workflowApiStage: '查询已停止',
      });
    }
    if (guard) completeCanvasDerivation(guard);
    cleanupNodePolling(task.nodeId, signal);
  }
}

export async function resumeWorkflowApiNodeTask(nodeId: string): Promise<void> {
  const projectId = useAppStore.getState().currentProjectId;
  const task = projectId ? getPendingTasksForProject(projectId).find((item) => item.nodeId === nodeId && item.taskType === 'workflow-api') : undefined;
  if (task) await resumeWorkflowApi(task);
}

const RESUME_MAP: Record<PendingTask['taskType'], (task: PendingTask, signal?: AbortSignal) => Promise<void>> = {
  apimart: resumeApimart,
  'apimart-flow-music': resumeApimartFlowMusic,
  dreamina: resumeDreamina,
  comfyui: resumeComfyUI,
  general: resumeGeneral,
  'custom-protocol': resumeCustomProtocol,
  volcengine: resumeVolcengine,
  runninghub: resumeRunningHub,
  'runninghub-workflow': resumeRunningHubWorkflow,
  'runninghub-model': resumeRunningHubWorkflow,
  'workflow-api': resumeWorkflowApi,
};

/** 剪辑器主动取回：只续查原任务并返回结果，不调用节点、消息或剪辑工程写入。 */
export async function readVideoEditorTransitionTaskResult(receipt: MediaTaskReceipt, signal?: AbortSignal): Promise<{
  url: string; mediaDownloadAccess?: MediaDownloadAccess;
}> {
  signal?.throwIfAborted();
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task?.mediaContext?.editorTransition || task.nodeType !== 'ai-video'
    || useAppStore.getState().currentProjectId !== receipt.projectId) throw new Error('原转场任务已变化，请返回所属画布后取回');
  if (task.terminalFailure) throw new Error(CONFIRMED_MEDIA_FAILURE_MESSAGE);
  if (!task.submitted || !task.taskId || task.mediaSubmissionUncertain || task.runninghubSubmissionUncertain
    || task.mediaRecoveryState === 'submit_unknown') throw new MediaTaskPausedError(receipt, 'submit_unknown');
  if (isMediaOperationActive(task.projectId, task.nodeId) || abortControllers.has(task.nodeId)
    || runtime.editorTransitionResultSinks.has(task.nodeId)) throw new Error('原转场任务仍在处理，请稍后取回');
  const cached = sanitizeMediaResultUrls(task.resultUrls);
  const canRefreshRemote = task.taskType === 'custom-protocol'
    ? !!task.protocolPoll || !!task.protocolPolls?.length
    : ['volcengine', 'general', 'apimart', 'dreamina', 'runninghub-model'].includes(task.taskType);
  // 用户明确取回时刷新原远端查询，避免签名 URL 过期后永远重复同一失效下载。
  // 没有远端查询合同的同步结果只能继续原文件或原 URL，不能以重生来冒充恢复。
  if (cached?.[0] && !canRefreshRemote) return { url: cached[0], mediaDownloadAccess: task.mediaDownloadAccess };
  let result: { url: string; mediaDownloadAccess?: MediaDownloadAccess } | undefined;
  const sink = { receipt, receive: (resolvedTask: PendingTask, urls: string[]) => {
    if (!urls[0]) throw new Error('原转场任务未返回视频结果');
    result = { url: urls[0], mediaDownloadAccess: resolvedTask.mediaDownloadAccess };
  } };
  const release = registerMediaNodeOperation(task.nodeId);
  runtime.editorTransitionResultSinks.set(task.nodeId, sink);
  try {
    if (task.taskType === 'runninghub-model') {
      const { runningHubConnection } = await import('./workflowExecutionService');
      const connection = runningHubConnection(useAppStore.getState().config.providers, 'runninghub-model', task.runninghubSite);
      const outputs = await queryRunningHubPendingTask(task, connection, 'video', signal ?? new AbortController().signal);
      const urls = outputs.map((output) => output.url);
      markMediaTaskDeliveryPending(task, signal, urls);
      sink.receive(task, urls);
    } else {
      if (!isRecoverableMediaTask(task) || task.taskType === 'comfyui') throw new Error('此转场任务暂不能自动取回，请到原平台核对');
      await RESUME_MAP[task.taskType](task, signal);
    }
    if (!result) throw new Error('原转场任务尚未取回；原回执已保留，请核对平台状态后重试取回');
    return result;
  } finally {
    if (runtime.editorTransitionResultSinks.get(task.nodeId) === sink) runtime.editorTransitionResultSinks.delete(task.nodeId);
    release();
  }
}

function historyDownloadTask(receipt: MediaTaskReceipt): PendingTask {
  if (useAppStore.getState().currentProjectId !== receipt.projectId) throw new Error('项目已切换，请重新操作');
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task || !isHistoryMediaDownloadPending(task)) throw new Error('原下载任务已变化或不可恢复，请前往节点核对');
  return task;
}

/** 历史按钮绑定完整回执，复用原查询/下载出口，不进入生成提交。 */
export async function retryHistoryMediaDownload(receipt: MediaTaskReceipt): Promise<void> {
  historyDownloadTask(receipt);
  const busy = () => videoResumePromises.has(receipt.nodeId) || abortControllers.has(receipt.nodeId)
    || isMediaOperationActive(receipt.projectId, receipt.nodeId);
  if (busy()) return Promise.reject(new Error('原任务仍在处理，请稍后再重新下载'));
  const outcomeKey = JSON.stringify([receipt.projectId, receipt.nodeId]);
  const outcome = { receipt, delivered: false, error: undefined as unknown };
  mediaResumeOutcomes.set(outcomeKey, outcome);
  const promise = Promise.resolve().then(() => {
    const task = historyDownloadTask(receipt);
    if (abortControllers.has(receipt.nodeId) || isMediaOperationActive(receipt.projectId, receipt.nodeId)) throw new Error('原任务仍在处理，请稍后再重新下载');
    return RESUME_MAP[task.taskType](task);
  }).then(() => {
    if (!outcome.delivered) throw new Error('下载尚未完成，请核对原任务后重新下载');
  }).catch((error: unknown) => {
    const task = loadAll().find((item) => matchesReceipt(item, receipt));
    const store = useAppStore.getState();
    if (task && isHistoryMediaDownloadPending(task) && store.currentProjectId === receipt.projectId
      && store.nodes.some((node) => node.id === receipt.nodeId)) store.updateNodeDataTransient(receipt.nodeId, {
      status: 'idle', error: undefined, mediaTaskState: 'delivery_pending',
      ...(task.taskType.startsWith('runninghub') ? { runninghubStage: '生成已完成，待下载' } : {}),
    });
    throw error;
  }).finally(() => {
    if (videoResumePromises.get(receipt.nodeId) === promise) videoResumePromises.delete(receipt.nodeId);
    if (mediaResumeOutcomes.get(outcomeKey) === outcome) mediaResumeOutcomes.delete(outcomeKey);
  });
  videoResumePromises.set(receipt.nodeId, promise);
  return promise;
}

/** 放弃只解除当前已完成任务的本地恢复，不删除文件、不取消上游。 */
export function abandonHistoryMediaDownload(receipt: MediaTaskReceipt): void {
  if (useAppStore.getState().currentProjectId !== receipt.projectId) throw new Error('项目已切换，请重新操作');
  if (!loadAll().some((task) => matchesReceipt(task, receipt))) return;
  historyDownloadTask(receipt);
  if (videoResumePromises.has(receipt.nodeId) || abortControllers.has(receipt.nodeId)
    || isMediaOperationActive(receipt.projectId, receipt.nodeId)) throw new Error('正在重新下载，请等待完成后再放弃');
  discardMediaTask(receipt);
  const store = useAppStore.getState();
  if (store.currentProjectId === receipt.projectId && store.nodes.some((node) => node.id === receipt.nodeId)) {
    store.updateNodeDataTransient(receipt.nodeId, { status: 'idle', error: undefined, runninghubStage: undefined });
  }
}

/** 用户重试只执行已保存任务的查询 / 下载，不走生成提交。 */
export function resumeMediaNodeTask(nodeId: string, externalSignal?: AbortSignal): Promise<void> {
  if (externalSignal?.aborted) return Promise.reject(externalSignal.reason);
  const existing = videoResumePromises.get(nodeId);
  // 旁观已有恢复时只停止自己的等待，不能中断原发起者的查询和保存。
  if (existing) return externalSignal ? withPollRequestDeadline(() => existing, externalSignal, Infinity) : existing;
  const store = useAppStore.getState();
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === store.currentProjectId);
  if (!task || (!isRecoverableMediaTask(task) && !isRecoverableVideoTask(task))
    || (!task.mediaContext?.messageId && !store.nodes.some((node) => node.id === nodeId))) {
    return Promise.reject(new Error('没有可恢复的生成任务'));
  }
  if (task.terminalFailure) return Promise.reject(new Error(CONFIRMED_MEDIA_FAILURE_MESSAGE));
  if (!task.submitted || !task.taskId || task.mediaSubmissionUncertain || task.mediaRecoveryState === 'submit_unknown') {
    return Promise.reject(new MediaTaskPausedError(receiptForTask(task), 'submit_unknown'));
  }
  if (isMediaOperationActive(task.projectId, nodeId)) {
    return Promise.reject(new Error('原生成任务仍在处理或保存结果，请稍后再继续查询'));
  }
  if (abortControllers.has(nodeId)) return Promise.resolve();
  // 保留 paused 标记直到交付成功；在查询中退出应用也不会自动重提或自动续查。
  try {
    updatePendingTask(nodeId, { mediaRecoveryState: task.mediaRecoveryState === 'delivery_pending' ? 'delivery_pending' : 'query_paused',
      ...(task.nodeType === 'ai-video' ? { videoRecoveryState: 'paused' as const } : {}) }, task.taskId, task.attemptId);
    if (store.nodes.some((node) => node.id === nodeId)) store.updateNodeDataTransient(nodeId, {
      status: 'loading', error: undefined, videoTaskState: undefined, mediaTaskState: undefined, mediaTaskStage: 'querying',
      ...(task.videoGenerationStartedAt ? { generationStartedAt: task.videoGenerationStartedAt } : {}) });
  } catch (error) {
    return Promise.reject(error);
  }
  const outcomeKey = JSON.stringify([task.projectId, task.nodeId]);
  const outcome = { receipt: receiptForTask(task), delivered: false, error: undefined as unknown };
  mediaResumeOutcomes.set(outcomeKey, outcome);
  const pauseCancelledTask = () => {
    const pending = loadAll().find((item) => matchesReceipt(item, outcome.receipt));
    if (pending) pauseMediaTask(outcome.receipt, undefined,
      pending.mediaRecoveryState === 'delivery_pending' ? 'delivery_pending' : 'query_interrupted');
  };
  const promise = Promise.resolve().then(() => {
    externalSignal?.throwIfAborted();
    return RESUME_MAP[task.taskType](task, externalSignal);
  }).then(() => {
    externalSignal?.throwIfAborted();
    if (outcome.error) throw outcome.error;
    if (!outcome.delivered && !loadAll().some((item) => matchesReceipt(item, outcome.receipt))) {
      throw new Error('任务已停止，尚未确认结果交付');
    }
  }).finally(() => {
    externalSignal?.removeEventListener('abort', pauseCancelledTask);
    if (videoResumePromises.get(nodeId) === promise) videoResumePromises.delete(nodeId);
    if (mediaResumeOutcomes.get(outcomeKey) === outcome) mediaResumeOutcomes.delete(outcomeKey);
  });
  videoResumePromises.set(nodeId, promise);
  externalSignal?.addEventListener('abort', pauseCancelledTask, { once: true });
  if (externalSignal?.aborted) pauseCancelledTask();
  return promise;
}

export function resumeVideoNodeTask(nodeId: string): Promise<void> { return resumeMediaNodeTask(nodeId); }

function isCancellationErrorMessage(message?: string): boolean {
  return message === '任务已被取消';
}

/**
 * 批量图片只持久化源节点的远端任务记录；同组占位节点必须跟随源任务恢复，
 * 不能在启动扫描时被当成没有任务的孤立 loading 节点。
 */
export function getPendingTaskCoveredNodeIds(
  nodes: ReadonlyArray<{ id: string; data: BaseNodeData }>,
  tasks: PendingTask[],
): Set<string> {
  const coveredNodeIds = new Set(tasks.map((task) => task.nodeId));
  for (const task of tasks) {
    if (
      task.nodeType !== 'ai-image'
      || (task.batchCount ?? 1) <= 1
      || !RESUME_MAP[task.taskType]
    ) continue;

    for (const nodeId of getBatchTaskNodeIds(task, nodes)) coveredNodeIds.add(nodeId);
  }
  return coveredNodeIds;
}

/**
 * 恢复指定项目下所有待续任务。
 * 未暂停的 loading 任务可续查；暂停和提交未知记录保留，等待用户处理。
 * 调用时机：应用初始化（initFromDb）、切换项目（switchProject）。
 */
export async function resumePendingTasks(projectId: string): Promise<void> {
  if (runtime.stoppedProjectIds.has(projectId)) return;
  const store = useAppStore.getState();
  if (store.currentProjectId !== projectId) return;
  const tasks = getPendingTasksForProject(projectId);

  // 批量图片的远端任务只挂在源节点上，同组占位节点也属于该任务的恢复范围。
  const coveredNodes = getPendingTaskCoveredNodeIds(store.nodes, tasks);

  // 缺少可持久化恢复身份也可能是同步请求中断，不能据此断言从未提交。
  // 本进程仍在消费请求或保存结果时，恢复扫描不得将其认作孤立节点。
  const orphanLoadingNodes = store.nodes.filter(
    (n) => (n.data as BaseNodeData).status === 'loading' && !coveredNodes.has(n.id)
      && !isMediaOperationActive(projectId, n.id) && !abortControllers.has(n.id),
  );
  if (orphanLoadingNodes.length > 0) {
    console.warn(
      `[pollManager] 发现 ${orphanLoadingNodes.length} 个缺少任务身份的 loading 节点`,
    );
    for (const node of orphanLoadingNodes) {
      store.updateNodeDataTransient(node.id, {
        status: 'error',
        error: '生成请求状态未知：本机没有可续查的任务 ID，请先到平台确认是否已生成，避免重复提交',
        mediaTaskState: 'submit_unknown', mediaTaskStage: undefined,
      });
    }
  }

  if (tasks.length === 0) return;

  console.log(`[pollManager] 发现 ${tasks.length} 个待续任务，开始恢复...`);

  for (const task of tasks) {
    if (useAppStore.getState().currentProjectId !== projectId) return;
    // 独立转场跟踪 ID 没有对应画布节点，不能按孤儿任务删除，也不自动投递新剪辑工程。
    if (task.mediaContext?.editorTransition) continue;
    if (task.terminalFailure) {
      try { await persistFailedMediaMessage(task); } catch { continue; }
      if (useAppStore.getState().currentProjectId !== projectId) return;
      if (!loadAll().some((item) => matchesReceipt(item, receiptForTask(task)))) continue;
      const nodeIds = failedTaskNodeIds(task);
      for (const node of store.nodes) {
        if (nodeIds.has(node.id)) store.updateNodeDataTransient(node.id, {
          status: 'error', error: CONFIRMED_MEDIA_FAILURE_MESSAGE,
          mediaTaskState: undefined, mediaTaskStage: undefined, videoTaskState: undefined,
        });
      }
      removeFailedMediaTask(receiptForTask(task));
      continue;
    }
    if (isMediaOperationActive(projectId, task.nodeId) || abortControllers.has(task.nodeId)) continue;
    const node = store.nodes.find((n) => n.id === task.nodeId);
    const nodeData = node?.data as BaseNodeData | undefined;
    if (task.taskType === 'workflow-api' && task.workflowApiMessage && task.nodeId === `workflow-api-message-${task.workflowApiMessage.messageId}`) {
      scheduleWorkflowApiMessageRecovery(task); continue;
    }
    if (['runninghub-workflow', 'runninghub-model'].includes(task.taskType) && task.runninghubMessage && task.nodeId === `runninghub-message-${task.runninghubMessage.messageId}`) {
      scheduleRunningHubMessageRecovery(task);
      continue;
    }
    if (isRecoverableMediaTask(task)) {
      if (!task.submitted || !task.taskId || task.mediaSubmissionUncertain) {
        pauseMediaTask(receiptForTask(task), undefined, 'submit_unknown');
        continue;
      }
      if (task.comfyRecoveryState === 'output_unavailable') {
        pauseMediaTask(receiptForTask(task), undefined, 'query_interrupted');
        continue;
      }
      if (task.mediaRecoveryState || task.comfyQueryHttpStatus || task.comfyRecoveryState === 'save_pending'
        || (task.nodeType === 'ai-video' && task.videoRecoveryState === 'paused')) {
        pauseMediaTask(receiptForTask(task), undefined,
          task.mediaRecoveryState === 'delivery_pending' || task.comfyRecoveryState === 'save_pending'
            ? 'delivery_pending' : task.mediaRecoveryReason ?? 'query_interrupted');
        continue;
      }
      if (task.mediaContext?.messageId) {
        // 消息恢复只由用户在所属对话中发起，不能自动写当前打开的消息。
        pauseMediaTask(receiptForTask(task), undefined, 'query_interrupted');
        continue;
      }
    }
    if (!node) {
      // 节点不存在或状态不为 loading，清理过期记录
      removePendingTask(task.nodeId);
      continue;
    }

    if (isRecoverableVideoTask(task) && task.videoRecoveryState === 'paused') {
      if (!abortControllers.has(task.nodeId) && !videoResumePromises.has(task.nodeId)) {
        store.updateNodeDataTransient(task.nodeId, { status: 'idle', error: undefined, videoTaskState: 'paused',
          generationStartedAt: task.videoGenerationStartedAt });
      }
      continue;
    }

    if (task.taskType === 'workflow-api') {
      if (!abortControllers.has(task.nodeId)) void resumeWorkflowApi(task);
      continue;
    }

    if (['runninghub-workflow', 'runninghub-model'].includes(task.taskType)) {
      if (abortControllers.has(task.nodeId)) continue;
      if (!task.taskId || task.runninghubRecoveryState === 'cancel_pending') {
        store.updateNodeDataTransient(task.nodeId, { status: 'error', error: task.taskId ? 'RunningHub 取消尚未确认，请继续查询或再次终止' : 'RunningHub 提交状态未知，请到平台确认任务后补充 ID' });
      } else {
        void resumeRunningHubWorkflow(task);
      }
      continue;
    }

    if (task.taskType === 'comfyui' && task.comfyRecoveryState === 'cancel_pending') {
      store.updateNodeDataTransient(task.nodeId, { status: 'error', error: 'ComfyUI 取消尚未确认，请继续查询或再次终止' });
      continue;
    }

    if (task.taskType === 'comfyui' && task.comfyRecoveryState === 'save_pending') {
      if (!abortControllers.has(task.nodeId) && !isComfyNodeDeliveryActive(task.projectId, task.nodeId)) store.updateNodeDataTransient(task.nodeId, {
        status: 'error', error: 'ComfyUI 已完成，结果保存或回填尚未完成，请继续查询取回原结果',
      });
      continue;
    }

    if (task.taskType !== 'comfyui' && isRecoverableMediaTask(task) && nodeData?.status !== 'loading') {
      pauseMediaTask(receiptForTask(task), undefined, 'query_interrupted');
      continue;
    }
    if (nodeData?.status !== 'loading') {
      if (
        task.submitted
        && task.taskId
        && nodeData?.status === 'error'
        && (isCancellationErrorMessage(nodeData.error) || (task.taskType === 'comfyui' && task.comfyRecoveryState === 'disconnected'))
      ) {
        store.updateNodeDataTransient(task.nodeId, { status: 'loading', error: undefined });
      } else {
        // 节点已成功、失败或被用户改为其他状态，清理过期记录
        removePendingTask(task.nodeId);
        continue;
      }
    }

    // 任务记录存在但未提交到远端（关闭窗口时还没来得及拿到 taskId）
    if (!task.submitted || !task.taskId) {
      updatePendingTask(task.nodeId, { mediaRecoveryState: 'submit_unknown', mediaRecoveryReason: 'submit_unknown' }, task.taskId, task.attemptId);
      store.updateNodeDataTransient(task.nodeId, { status: 'idle', mediaTaskState: 'submit_unknown', mediaTaskStage: undefined,
        error: undefined });
      continue;
    }

    if (abortControllers.has(task.nodeId)) {
      continue;
    }

    const resumeFn = RESUME_MAP[task.taskType];
    if (!resumeFn) {
      console.warn(`[pollManager] 未知任务类型: ${task.taskType}`);
      await handleResumeError(task, new Error('任务恢复失败：未知任务类型'));
      continue;
    }

    // 不 await：多个任务并行恢复
    resumeFn(task).catch((err) => {
      console.error(`[pollManager] 恢复任务失败 (${task.nodeId}):`, err);
    });
  }
}
