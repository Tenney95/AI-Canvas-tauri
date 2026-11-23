/** 待续任务的原始回执、运行资格、原生画布恢复和本地存储。 */
import { isPollTimeoutError } from '../../pollTask';
import { derivedNodePlacement, generateId, getNextDisplayId } from '../../../store/store.utils';
import { useAppStore } from '../../../store/useAppStore';
import { pickImageOutputParameters } from '../imageOutputParameters';
import { MediaPersistenceError, type MediaPersistenceFailureKind } from '../../fileService';
import { imageBatchArtifactId } from '../../imageBatchService';
import { sanitizeComfyOutputFile, type ComfyOutputFile } from '../../comfyOutputs';
import {
  ComfyPendingError,
  ComfyQueryAuthorizationError,
  getComfyQueryAuthorizationMessage,
} from '../../comfyPolling';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../canvasDerivationGuard';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from '../../projectExecutionContext';
import { isImageOutputCountRange, isSafeMediaParameterText, MEDIA_PARAMETER_TEXT_FIELDS } from '../modelCapabilityValidation';
import type { BaseNodeData, NodeType } from '../../../types';
import type { CanvasContext } from '../../../types/project';
import type { NativeMediaTaskRecord } from '../../indexedDb/nativeMediaTaskRepository';
import type { ImageOutputCountRange, MediaDownloadAccess, MediaTaskContext, MediaTaskReceipt, ResolvedModelProtocolPoll } from '../../../types/aiTypes';
import { sanitizeMediaDownloadAccess, sanitizeMediaResultUrls } from '../mediaDownloadAccess';
import { getHttpResponseError } from '../httpUtils';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';
import { isHistoryMediaDownloadPending } from '../../historyMediaRecovery';

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
    nativeWorkflowNodeRuns: new Map<string, { controller?: AbortController; settled?: Promise<void>; cancelling?: boolean }>(),
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
  runtime.nativeWorkflowNodeRuns ??= new Map();
  runtime.mediaTaskSnapshot ??= createMediaTaskSnapshotState();
  runtime.pollingProjects ??= new Map();
  runtime.stoppedProjectIds ??= new Set();
  runtime.editorTransitionResultSinks ??= new Map();
  // 依赖重新求值时不保证先触发 dispose，首次载入就要保留引用。
  if (hotData) hotData.pollManagerRuntime = runtime;
  return runtime;
}

export let runtime: ReturnType<typeof createPollManagerRuntime>;

/** 沿用原 pollManager 入口的热更新数据，旧请求的回调与新入口共享同一份回执和控制器。 */
export function bindPollManagerRuntime(hotData?: Parameters<typeof createOrReusePollManagerRuntime>[0]): void {
  runtime = createOrReusePollManagerRuntime(hotData);
}

/** 逻辑删除后只撤销本进程运行资格；不loadAll、不删除/重写付费或unknown回执。 */
export function stopPollingForDeletedProjects(projectIds: readonly string[]): void {
  const ids = new Set(projectIds);
  for (const id of ids) runtime.stoppedProjectIds.add(id);
  const nodes = new Set<string>();
  for (const [nodeId, projectId] of runtime.pollingProjects) if (ids.has(projectId)) nodes.add(nodeId);
  for (const [nodeId, context] of runtime.mediaTaskContexts) if (ids.has(context.projectId)) nodes.add(nodeId);
  const state = useAppStore.getState();
  if (state.currentProjectId && ids.has(state.currentProjectId)) for (const node of state.nodes) nodes.add(node.id);
  for (const [key, operations] of runtime.activeMediaOperations) {
    const identity: unknown = JSON.parse(key);
    if (Array.isArray(identity) && ids.has(identity[0] as string)) {
      operations.clear(); runtime.activeMediaOperations.delete(key); runtime.latestMediaOperationOwners.delete(key);
    }
  }
  for (const nodeId of nodes) {
    // 导入/复制可沿用nodeId，当前controller的项目归属优先，不能取消另一项目同名节点。
    const owner = runtime.pollingProjects.get(nodeId);
    if (owner && ids.has(owner)) abortNodePolling(nodeId);
  }
  let changed = false;
  for (const [key, delivery] of runtime.activeComfyDeliveries) if (ids.has(delivery.projectId)) {
    runtime.activeComfyDeliveries.delete(key); changed = true;
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
    runtime.mediaTaskListeners.forEach((listener) => listener());
  }).finally(() => { snapshot.refresh = undefined; });
  return snapshot.refresh;
}

export function subscribeMediaTasks(listener: () => void): () => void {
  const firstSubscriber = runtime.mediaTaskListeners.size === 0;
  runtime.mediaTaskListeners.add(listener);
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
    runtime.mediaTaskListeners.delete(listener);
    const storageListener = runtime.mediaTaskSnapshot.storageListener;
    if (runtime.mediaTaskListeners.size === 0 && storageListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', storageListener);
      runtime.mediaTaskSnapshot.storageListener = undefined;
    }
  };
}

const notifyComfyDeliveries = () => runtime.comfyDeliveryListeners.forEach((listener) => listener());

export function subscribeComfyDeliveries(listener: () => void): () => void {
  runtime.comfyDeliveryListeners.add(listener);
  return () => { runtime.comfyDeliveryListeners.delete(listener); };
}

export function isComfyNodeDeliveryActive(projectId: string | null, nodeId: string | undefined): boolean {
  return [...runtime.activeComfyDeliveries.values()].some((item) => item.projectId === projectId && item.nodeId === nodeId);
}

export function beginComfyNodeDelivery(nodeId: string, taskId: string | undefined): void {
  if (!taskId) return;
  const task = loadAll().find((item) => item.nodeId === nodeId && item.taskType === 'comfyui' && item.taskId === taskId);
  if (!task) return;
  const key = JSON.stringify([task.projectId, nodeId, taskId]);
  if (runtime.activeComfyDeliveries.has(key)) return;
  runtime.activeComfyDeliveries.set(key, { projectId: task.projectId, nodeId, taskId });
  notifyComfyDeliveries();
}

export function endComfyNodeDelivery(nodeId: string, taskId: string): void {
  let changed = false;
  for (const [key, item] of runtime.activeComfyDeliveries) {
    if (item.nodeId === nodeId && item.taskId === taskId) { runtime.activeComfyDeliveries.delete(key); changed = true; }
  }
  if (changed) notifyComfyDeliveries();
}

function abortNodePolling(nodeId: string): void {
  const controller = runtime.abortControllers.get(nodeId);
  if (controller) {
    controller.abort();
    runtime.abortControllers.delete(nodeId);
  }
}

/**
 * 登记节点的本地轮询。父信号已取消时保留现有轮询，替换轮询时保留待续回执。
 * 将返回的信号传给查询，并用同一信号核对归属和清理登记。
 */
export function registerNodePolling(nodeId: string, parentSignal?: AbortSignal): AbortSignal {
  // 已经停止的调用不能先中断别人的轮询，再登记一轮新的查询。
  parentSignal?.throwIfAborted();
  const projectId = runtime.mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  if (projectId && runtime.stoppedProjectIds.has(projectId)) throw new DOMException('项目已删除，本地查询已停止', 'AbortError');
  abortNodePolling(nodeId); // 先取消旧轮询，但保留 pending task 以支持恢复
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  runtime.abortControllers.set(nodeId, { signal, abort: (reason?: unknown) => controller.abort(reason) });
  if (projectId) runtime.pollingProjects.set(nodeId, projectId);
  return signal;
}

/** 按信号身份核对当前登记，父信号取消后仍可用来判断续查回执的归属。 */
export function isNodePollingCurrent(nodeId: string, expectedSignal: AbortSignal): boolean {
  return runtime.abortControllers.get(nodeId)?.signal === expectedSignal;
}

/** 取消节点的轮询（节点被删除时调用，同时清理 pending task） */
export function cancelNodePolling(nodeId: string, preservePending = false): void {
  abortNodePolling(nodeId);
  // 同时清理 localStorage 中的待续任务记录
  if (!preservePending) removePendingTask(nodeId);
}

/** 轮询结束时传入登记返回的信号清理本轮，避免旧请求移除后续登记。 */
export function cleanupNodePolling(nodeId: string, expectedSignal?: AbortSignal, notifyNativeDelivery = true): boolean {
  if (expectedSignal && !isNodePollingCurrent(nodeId, expectedSignal)) return false;
  const projectId = runtime.pollingProjects.get(nodeId);
  abortControllers.delete(nodeId);
  runtime.pollingProjects.delete(nodeId);
  if (projectId && notifyNativeDelivery) void resumeNativeMediaLocalDelivery(projectId, nodeId).catch(() => undefined);
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
  taskType: 'apimart' | 'apimart-flow-music' | 'dreamina' | 'muse' | 'comfyui' | 'general' | 'custom-protocol' | 'volcengine' | 'runninghub' | 'runninghub-workflow' | 'workflow-api' | 'runninghub-model';
  runninghubModelId?: string;
  runninghubSubmissionUncertain?: boolean;
  workflowApi?: import('../../../types/workflowApi').WorkflowApiTaskDescriptor;
  workflowApiMessage?: import('../../../types/workflowApi').CloudWorkflowTaskContext;
  runninghubRecoveryState?: 'disconnected' | 'cancel_pending' | 'submit_unknown' | 'save_pending';
  /** 新任务固定原站点以供续查/取消，不保存密钥；旧记录缺省沿用当前选择。 */
  runninghubSite?: import('../../../types/runninghub').RunningHubSiteId;
  runninghubOutputNodeIds?: string[];
  runninghubWorkflowId?: string;
  runninghubMessage?: import('../../../types/runninghub').RunningHubTaskContext;
  /** Flow Music 当前远端任务阶段。 */
  audioTaskStage?: 'lyrics' | 'music';
  /** 本地 ComfyUI 恢复轮询用地址；厂商地址统一从 providerConfigId 解析。 */
  baseUrl?: string;
  /** 批量图片任务期望回填的结果数量；旧记录缺省为 1。 */
  batchCount?: number;
  /** 单个远端作业固定返回多候选时的交付数量；不随当前连接配置变化。 */
  expectedImageOutputs?: number;
  imageOutputCountRange?: ImageOutputCountRange;
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
  | 'mediaSubmissionUncertain' | 'expectedImageOutputs' | 'imageOutputCountRange' | 'terminalFailure'>> {
  readonly mediaContext?: Readonly<Pick<MediaTaskContext, 'conversationId' | 'messageId' | 'editorTransition'>>;
  readonly imageOutputNodeIds?: readonly string[];
  readonly taskType?: PendingTask['taskType'];
  readonly historyDownloadPending: boolean;
}

// ═══════════════════════════════════════════
// localStorage 持久化
// ═══════════════════════════════════════════

const STORAGE_KEY = 'ai_canvas_pending_tasks';

const LEGACY_PENDING_TASK_TYPES = new Set(['apimart', 'apimart-flow-music', 'dreamina', 'muse', 'comfyui', 'general', 'custom-protocol',
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
    runtime.pausedErrors.add(this);
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
  return error instanceof Error && runtime.pausedErrors.has(error);
}

/** 只保存有限的媒体选项，避免恢复记录混入提示词、路径或任意对象。 */
function sanitizeMediaParameters(value: MediaTaskContext['parameters']): MediaTaskContext['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: NonNullable<MediaTaskContext['parameters']> = {};
  for (const key of MEDIA_PARAMETER_TEXT_FIELDS) {
    const item = value[key];
    if (!isSafeMediaParameterText(item, key)) continue;
    if (key === 'imageOutputFormat') {
      if (item === 'png' || item === 'gif' || item === 'svg') result[key] = item;
    } else result[key] = item;
  }
  if (result.imageOutputFormat === 'gif') {
    // 恢复记录只保留有界白名单；不补生成默认值，也不把GIF选项带到其他格式。
    const output = pickImageOutputParameters(value);
    for (const [key, min, max, step] of [
      ['imageFrameCount', 2, 16, 1], ['imageFrameDurationMs', 20, 655350, 10],
    ] as const) {
      const item = output[key];
      if (typeof item === 'number' && Number.isSafeInteger(item) && item >= min && item <= max
        && (item - min) % step === 0) result[key] = item;
    }
    if (typeof output.imageTransparent === 'boolean') result.imageTransparent = output.imageTransparent;
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
  runtime.mediaTaskContexts.set(trackingId, safe);
  if (observer) runtime.mediaTaskObservers.set(trackingId, observer);
  else runtime.mediaTaskObservers.delete(trackingId);
  return () => {
    if (runtime.mediaTaskContexts.get(trackingId) === safe) {
      runtime.mediaTaskContexts.delete(trackingId);
      if (runtime.mediaTaskObservers.get(trackingId) === observer) runtime.mediaTaskObservers.delete(trackingId);
    }
  };
}

/** 运行中转场的真实锚点，仅供 Provider 提交前守卫；不作为任务的跟踪 ID。 */
export function getVideoEditorTransitionAnchor(trackingId: string | undefined): string | undefined {
  return trackingId ? runtime.mediaTaskContexts.get(trackingId)?.editorTransition?.anchorNodeId : undefined;
}

export function isVideoEditorTransitionTaskActive(projectId: string, trackingId: string): boolean {
  return isMediaOperationActive(projectId, trackingId) || runtime.abortControllers.has(trackingId)
    || runtime.editorTransitionResultSinks.has(trackingId);
}

function notifyMediaReceipt(task: PendingTask): void {
  if (runtime.mediaTaskContexts.get(task.nodeId)?.projectId === task.projectId) {
    runtime.mediaTaskObservers.get(task.nodeId)?.(receiptForTask(task));
  }
}

export function registerMediaMessageRecoveryHandler(handler: MediaMessageRecoveryHandler): () => void {
  runtime.mediaMessageRecoveryHandler = handler;
  return () => { if (runtime.mediaMessageRecoveryHandler === handler) runtime.mediaMessageRecoveryHandler = undefined; };
}

/** 覆盖同步等待和交付阶段；不把运行时租约写入持久化。 */
export function registerMediaNodeOperation(nodeId: string, ownsGeneration = false): (() => void) & { isCurrent: () => boolean } {
  const projectId = runtime.mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  if (projectId && runtime.stoppedProjectIds.has(projectId)) throw new DOMException('项目已删除，本地交付已停止', 'AbortError');
  const key = JSON.stringify([projectId, nodeId]);
  const token = Symbol();
  const operations = runtime.activeMediaOperations.get(key) ?? new Set<symbol>();
  operations.add(token);
  runtime.activeMediaOperations.set(key, operations);
  // 声明式执行器等内层也会登记活跃状态，只有外层生成入口领取运行所有权。
  if (ownsGeneration) runtime.latestMediaOperationOwners.set(key, token);
  const release = () => {
    operations.delete(token);
    if (operations.size === 0 && runtime.activeMediaOperations.get(key) === operations) {
      runtime.activeMediaOperations.delete(key);
      runtime.latestMediaOperationOwners.delete(key);
      if (projectId) void resumeNativeMediaLocalDelivery(projectId, nodeId).finally(() => {
        // 切回画布时旧查询可能尚在释放，回查该节点以补齐启动扫描跳过的原回执。
        const context = captureLegacyCanvasContext(useAppStore.getState());
        if (context?.modelGeneration === 1 && context.canvasId === projectId && !getNativeMediaNodeRecovery(nodeId)) {
          return restoreNativeMediaNodeRecoveries(context, nodeId);
        }
      }).catch(() => undefined);
    }
  };
  // 新尝试结束也不让旧尝试重新取得保存资格；运行时身份不进入持久化。
  return Object.assign(release, { isCurrent: () => operations.has(token)
    && (!ownsGeneration || runtime.latestMediaOperationOwners.get(key) === token) });
}

export function isMediaOperationActive(projectId: string, nodeId: string): boolean {
  return runtime.activeMediaOperations.has(JSON.stringify([projectId, nodeId]));
}

/** 打开原画布可以续查一次。节点释放事件只投影暂停状态，防止错误触发无限重查。 */
export async function resumeNativeMediaLocalDelivery(canvasId: string, nodeId?: string): Promise<void> {
  if (runtime.stoppedProjectIds.has(canvasId)) return;
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1 || context.canvasId !== canvasId) return;
  const { resumeNativeMediaLocalResults } = await import('../../nativeMediaAutoDelivery');
  await resumeNativeMediaLocalResults(canvasId, { nodeId, allowOriginalCccTaskQuery: true,
    isNodeBusy: isNativeMediaDeliveryBusy, queryProtocol: nodeId ? undefined : queryNativeProtocolReceipt,
    showPausedProtocol: (record, expected, saving) =>
      showNativeMediaNodeRecovery(expected, record.nodeId, record.operationId, saving ? 'delivery_pending' : 'paused') });
}

function isNativeMediaDeliveryBusy(canvasId: string, nodeId: string): boolean {
  return isMediaOperationActive(canvasId, nodeId) || isNativeMediaNodeBusy(canvasId, nodeId)
    || runtime.pollingProjects.get(nodeId) === canvasId && abortControllers.has(nodeId);
}

async function queryNativeProtocolReceipt(record: NativeMediaTaskRecord, context: CanvasContext, parentSignal: AbortSignal): Promise<boolean> {
  const { nodeId, operationId } = record;
  parentSignal.throwIfAborted();
  if (isNativeMediaDeliveryBusy(context.canvasId, nodeId)
    || !isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) return false;
  const signal = registerNodePolling(nodeId, parentSignal);
  try {
    const { deliverNativeMediaCachedResult } = await import('../../nativeMediaAutoDelivery');
    const delivered = await deliverNativeMediaCachedResult(operationId, context, signal, undefined, 'protocol-auto');
    if (delivered) clearNativeMediaNodeRecovery(context, nodeId, operationId);
    return delivered;
  } catch (error) {
    if (!signal.aborted) {
      const { readAvailableNativeMediaTask } = await import('../../indexedDb/nativeMediaTaskRepository');
      const current = await readAvailableNativeMediaTask(context.projectId, context.canvasId, operationId, { signal }).catch(() => undefined);
      if (!signal.aborted && current?.status === 'failed') clearNativeMediaNodeRecovery(context, nodeId, operationId);
    }
    throw error;
  } finally {
    cleanupNodePolling(nodeId, signal, false);
  }
}

// 只投影当前画布的提示；恢复时仍以原生账本和原任务租约为准。
let nativeMediaNodeRecovery: { context: CanvasContext; operations: Map<string, string> } | undefined;

export function isNativeMediaNodeBusy(canvasId: string, nodeId: string): boolean {
  return runtime.nativeWorkflowNodeRuns.has(JSON.stringify([canvasId, nodeId]));
}

export function trackNativeMediaNodeRun(canvasId: string, nodeId: string, controller?: AbortController): () => void {
  const key = JSON.stringify([canvasId, nodeId]);
  if (runtime.nativeWorkflowNodeRuns.has(key)) throw new Error('原媒体任务正在处理');
  let finish!: () => void;
  const run = { controller, settled: new Promise<void>((resolve) => { finish = resolve; }), cancelling: false };
  runtime.nativeWorkflowNodeRuns.set(key, run);
  return () => {
    if (!run.cancelling && runtime.nativeWorkflowNodeRuns.get(key) === run) runtime.nativeWorkflowNodeRuns.delete(key);
    finish();
  };
}

export async function cancelNativeWorkflowOnNode(context: CanvasContext, nodeId: string) {
  if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) return;
  const operationId = getNativeMediaNodeRecovery(nodeId);
  const key = JSON.stringify([context.canvasId, nodeId]);
  const run = runtime.nativeWorkflowNodeRuns.get(key) ?? { controller: undefined, settled: undefined, cancelling: false };
  if (run.cancelling) throw new Error('原工作流任务正在取消');
  run.cancelling = true;
  runtime.nativeWorkflowNodeRuns.set(key, run);
  try {
    run.controller?.abort();
    cancelNodePolling(nodeId, true);
    // 等本轮生成或续查写完回执，再核对远端终态。
    await run.settled;
    if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) return;
    const { cancelNativeWorkflowNodeTask } = await import('../../nativeWorkflowTasks');
    return await cancelNativeWorkflowNodeTask(context, nodeId, operationId);
  } finally {
    runtime.nativeWorkflowNodeRuns.delete(key);
  }
}

export function getNativeMediaNodeRecovery(nodeId: string, state = useAppStore.getState()): string | undefined {
  const recovery = nativeMediaNodeRecovery;
  if (recovery && isProjectExpectedContextCurrent(recovery.context, state, { checkCanvasRevision: false })) {
    return recovery.operations.get(nodeId);
  }
}

export function clearNativeMediaNodeRecovery(context: CanvasContext, nodeId: string, operationId?: string): void {
  if (nativeMediaNodeRecovery && isProjectExpectedContextCurrent(context, nativeMediaNodeRecovery.context, { checkCanvasRevision: false })
    && (operationId === undefined || nativeMediaNodeRecovery.operations.get(nodeId) === operationId)) {
    nativeMediaNodeRecovery.operations.delete(nodeId);
  }
}

type NativeMediaNodeState = NonNullable<BaseNodeData['mediaTaskState']>;

function showNativeMediaNodeRecovery(context: CanvasContext, nodeId: string, operationId: string, state: NativeMediaNodeState): void {
  const store = useAppStore.getState();
  if (!isProjectExpectedContextCurrent(context, store, { checkCanvasRevision: false })) return;
  const node = store.nodes.find((item) => item.id === nodeId);
  if (!node || node.data.role === 'source') return;
  if (!nativeMediaNodeRecovery || !isProjectExpectedContextCurrent(nativeMediaNodeRecovery.context, context, { checkCanvasRevision: false })) {
    nativeMediaNodeRecovery = { context, operations: new Map() };
  }
  nativeMediaNodeRecovery.operations.set(nodeId, operationId);
  store.updateNodeDataTransient(nodeId, { status: node.data.status === 'success' ? 'success' : 'idle', error: undefined,
    mediaTaskState: state, mediaTaskStage: undefined });
}

async function inspectNativeMediaNodeRecovery(context: CanvasContext, nodeId: string, operationId: string, signal?: AbortSignal) {
  const { ACTIVE_NATIVE_MEDIA_STATES, readAvailableNativeMediaTask } = await import('../../indexedDb/nativeMediaTaskRepository');
  const record = await readAvailableNativeMediaTask(context.projectId, context.canvasId, operationId, { signal });
  if (!record || record.nodeId !== nodeId || record.origin?.deliveryMode === 'chat' || record.episodeId !== context.episodeId
    || record.projectEpoch !== context.projectEpoch || record.canvasEpoch !== context.canvasEpoch
    || !ACTIVE_NATIVE_MEDIA_STATES.includes(record.status)) return;
  return { record, state: await describeNativeMediaNodeRecovery(record) };
}

async function describeNativeMediaNodeRecovery(record: NativeMediaTaskRecord): Promise<NativeMediaNodeState> {
  const { readNativeMediaRecoverySummary } = await import('../../nativeMediaRecoverySummary');
  const recovery = await readNativeMediaRecoverySummary(record);
  if (!recovery.canResume) return 'submit_unknown';
  return recovery.cachedOnly ? 'delivery_pending' : 'paused';
}

/** 以耐久回执及其阶段状态决定节点操作。 */
export async function refreshNativeMediaNodeRecovery(context: CanvasContext, nodeId: string, operationId: string,
  isCurrent: () => boolean = () => true): Promise<NativeMediaNodeState | undefined> {
  const current = await inspectNativeMediaNodeRecovery(context, nodeId, operationId);
  if (!current || !isCurrent() || !isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) return;
  showNativeMediaNodeRecovery(context, nodeId, operationId, current.state);
  return current.state;
}

async function restoreNativeMediaNodeRecoveries(context: CanvasContext, nodeId?: string): Promise<void> {
  const { ACTIVE_NATIVE_MEDIA_STATES, listNativeMediaTasks } = await import('../../indexedDb/nativeMediaTaskRepository');
  const records = await listNativeMediaTasks(context.projectId, { canvasId: context.canvasId, statuses: ACTIVE_NATIVE_MEDIA_STATES,
    ...(nodeId ? { nodeIds: new Set([nodeId]) } : {}) });
  const canvasCurrent = () => isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false });
  for (const record of records) {
    if (!canvasCurrent()) return;
    const canRestore = () => !isNativeMediaDeliveryBusy(context.canvasId, record.nodeId)
      && !getNativeMediaNodeRecovery(record.nodeId);
    if (record.origin?.deliveryMode === 'chat' || !canRestore()
      || !useAppStore.getState().nodes.some((node) => node.id === record.nodeId && node.data.role !== 'source')) continue;
    await refreshNativeMediaNodeRecovery(context, record.nodeId, record.operationId, canRestore).catch(() => undefined);
  }
}

function nativeMediaNodeActionTarget(nodeId: string, operationId: string) {
  const store = useAppStore.getState(), context = captureLegacyCanvasContext(store);
  const node = store.nodes.find((item) => item.id === nodeId);
  const isCurrent = () => {
    const state = useAppStore.getState();
    return !!context && isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })
      && getNativeMediaNodeRecovery(nodeId, state) === operationId
      && state.nodes.some((item) => item.id === nodeId && item.data.role !== 'source');
  };
  if (!context || !node || !isCurrent() || isNativeMediaDeliveryBusy(context.canvasId, nodeId)) {
    throw new Error('原媒体任务已变化或正在处理');
  }
  return { context, node, isCurrent };
}

export async function reviewNativeMediaFromNode(nodeId: string, operationId: string): Promise<void> {
  const { context, node, isCurrent } = nativeMediaNodeActionTarget(nodeId, operationId);
  if (node.data.mediaTaskState !== 'submit_unknown') throw new Error('原媒体任务已变化，请重新核对');
  const controller = new AbortController();
  const finish = trackNativeMediaNodeRun(context.canvasId, nodeId, controller);
  const unsubscribe = useAppStore.subscribe(() => { if (!isCurrent()) controller.abort(); });
  try {
    const current = await inspectNativeMediaNodeRecovery(context, nodeId, operationId, controller.signal);
    if (!current || !isCurrent()) throw new Error('原媒体任务已变化，请重新核对');
    if (current.state !== 'submit_unknown') {
      showNativeMediaNodeRecovery(context, nodeId, operationId, current.state);
      throw new Error('原媒体任务已变化，请重新核对');
    }
    const { reviewNativeMediaTask } = await import('../../indexedDb/nativeMediaTaskRepository');
    if (!isCurrent()) throw new Error('原媒体任务已变化，请重新核对');
    try { await reviewNativeMediaTask(operationId, context, { expected: current.record, signal: controller.signal }); }
    catch (error) {
      if (isCurrent()) await refreshNativeMediaNodeRecovery(context, nodeId, operationId, isCurrent).catch(() => undefined);
      throw error;
    }
    if (!isCurrent()) return;
    clearNativeMediaNodeRecovery(context, nodeId, operationId);
    useAppStore.getState().updateNodeDataTransient(nodeId, { mediaTaskState: undefined, mediaTaskStage: undefined,
      videoTaskState: undefined, error: undefined });
  } finally {
    unsubscribe();
    finish();
  }
}

export async function resumeNativeMediaFromNode(nodeId: string, operationId: string): Promise<void> {
  const { context, node, isCurrent } = nativeMediaNodeActionTarget(nodeId, operationId);
  if (node.data.mediaTaskState === 'submit_unknown') throw new Error('原媒体任务需要核对');
  const store = useAppStore.getState();
  const wasSaving = node.data.mediaTaskState === 'delivery_pending';
  const controller = new AbortController();
  const release = registerMediaNodeOperation(nodeId, true);
  const signal = registerNodePolling(nodeId, controller.signal);
  const finish = trackNativeMediaNodeRun(context.canvasId, nodeId, controller);
  const unsubscribe = useAppStore.subscribe(() => { if (!isCurrent()) controller.abort(); });
  try {
    const original = await inspectNativeMediaNodeRecovery(context, nodeId, operationId, signal);
    if (!original || !isCurrent() || original.state === 'submit_unknown') throw new Error('原媒体任务已变化，请重新核对');
    store.updateNodeDataTransient(nodeId, { status: 'loading', mediaTaskState: undefined, mediaTaskStage: 'querying' });
    const { resumeNativeVolcengineTask } = await import('../../nativeVolcengineRecovery');
    signal.throwIfAborted();
    await resumeNativeVolcengineTask(operationId, signal, { allowUnstartedStage: false });
    const current = useAppStore.getState();
    if (release.isCurrent() && isCurrent()) {
      clearNativeMediaNodeRecovery(context, nodeId, operationId);
      if (current.nodes.find((item) => item.id === nodeId)?.data.status === 'loading') {
        current.updateNodeDataTransient(nodeId, { status: node.data.status, mediaTaskStage: undefined });
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    const { listNativeMediaTasks } = await import('../../indexedDb/nativeMediaTaskRepository');
    const records = await listNativeMediaTasks(context.projectId, { canvasId: context.canvasId, operationId }).catch(() => undefined);
    if (release.isCurrent() && isCurrent()) {
      const current = useAppStore.getState();
      const live = current.nodes.find((item) => item.id === nodeId);
      const record = records?.find((item) => item.operationId === operationId);
      if (signal.aborted) return;
      if (records && (!record || ['failed', 'delivered', 'reviewed'].includes(record.status))) {
        clearNativeMediaNodeRecovery(context, nodeId, operationId);
        if (live?.data.status === 'loading') current.updateNodeDataTransient(nodeId, {
          status: record?.status === 'failed' ? 'error' : node.data.status, mediaTaskStage: undefined,
        });
      } else {
        const state = record ? await describeNativeMediaNodeRecovery(record) : wasSaving ? 'delivery_pending' : 'paused';
        if (!signal.aborted && release.isCurrent() && isCurrent()) showNativeMediaNodeRecovery(context, nodeId, operationId, state);
      }
    }
    throw error;
  } finally {
    unsubscribe();
    cleanupNodePolling(nodeId, signal);
    release();
    finish();
  }
}

const nativeCanvasReadiness = new Map<string, Promise<void>>();

/** 只订阅本次画布权威身份及忙标记，不按每次 Store 更新重扫账本。 */
export function resumeNativeMediaWhenReady(context: CanvasContext): Promise<void> {
  const key = `${context.projectId}/${context.canvasId}/${context.runtimeEpoch}`;
  const existing = nativeCanvasReadiness.get(key); if (existing) return existing;
  const work = new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const inspect = () => {
      const state = useAppStore.getState(), actual = state.projectExecutionContext;
      if (!actual || state.currentProjectId !== context.canvasId
        || !isProjectExpectedContextCurrent(context, actual, { checkCanvasRevision: false })) { unsubscribe(); resolve(); return; }
      if (!isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) return;
      unsubscribe();
      void resumeNativeMediaLocalDelivery(context.canvasId).finally(() => restoreNativeMediaNodeRecoveries(context)).then(resolve, reject);
    };
    unsubscribe = useAppStore.subscribe(inspect); inspect();
  }).finally(() => { if (nativeCanvasReadiness.get(key) === work) nativeCanvasReadiness.delete(key); });
  nativeCanvasReadiness.set(key, work); return work;
}

export function receiptForTask(task: PendingTask): MediaTaskReceipt {
  return { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId };
}

export function matchesReceipt(task: PendingTask, receipt: MediaTaskReceipt): boolean {
  return task.projectId === receipt.projectId && task.nodeId === receipt.nodeId
    && task.taskId === receipt.taskId && task.attemptId === receipt.attemptId;
}

export function getMediaTaskReceipt(nodeId: string, expectedTaskId?: string): MediaTaskReceipt | undefined {
  const projectId = runtime.mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === projectId
    && (expectedTaskId === undefined || item.taskId === expectedTaskId));
  return task ? receiptForTask(task) : undefined;
}

export function isRecoverableMediaTask(task: PendingTask): boolean {
  if (task.mediaContext?.editorTransition && task.taskType === 'runninghub-model') return true;
  if (task.taskType === 'comfyui') return task.comfyRecoveryState !== 'cancel_pending'
    && ((task.submitted && !!task.taskId) || task.mediaSubmissionUncertain === true || task.mediaRecoveryState === 'submit_unknown');
  return ['ai-image', 'ai-video', 'ai-audio', 'ai-panorama', 'ai-animation'].includes(task.nodeType)
    && ['custom-protocol', 'general', 'apimart', 'apimart-flow-music', 'volcengine', 'dreamina', 'muse'].includes(task.taskType);
}

/** Muse 的本机耐久任务可仅读续查；有 ID 不表示已经点击发送。 */
export function hasMuseQueryIdentity(task: { taskType?: string; taskId: string }): boolean {
  return task.taskType === 'muse'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.taskId);
}

/** 按原回执保存待续状态，区分提交未知、待查询与待保存。 */
export function pauseMediaTask(receipt: MediaTaskReceipt, error?: unknown,
  reason: MediaTaskPauseReason = 'query_interrupted'): MediaTaskPausedError | undefined {
  if (runtime.stoppedProjectIds.has(receipt.projectId)) return undefined;
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task || task.terminalFailure || !isRecoverableMediaTask(task)) return undefined;
  const unknown = !hasMuseQueryIdentity(task) && (task.mediaSubmissionUncertain || task.runninghubSubmissionUncertain
    || !task.submitted || !task.taskId || reason === 'submit_unknown');
  const resolvedReason = unknown ? 'submit_unknown' : reason === 'submit_unknown' ? 'query_interrupted' : reason;
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
  const outcome = runtime.mediaResumeOutcomes.get(JSON.stringify([task.projectId, task.nodeId]));
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
  const outcome = runtime.mediaResumeOutcomes.get(JSON.stringify([receipt.projectId, receipt.nodeId]));
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

export const CONFIRMED_MEDIA_FAILURE_MESSAGE = '生成失败：服务商已明确拒绝请求或任务已失败';

/** 同组占位节点若已开始独立生成，不再归旧批次终态所有。 */
export function failedTaskNodeIds(task: PendingTask): Set<string> {
  const store = useAppStore.getState();
  const tasks = loadAll();
  return new Set([...getBatchTaskNodeIds(task, store.nodes), task.mediaContext?.canvasNodeId ?? task.nodeId]
    .filter((nodeId) => nodeId === task.nodeId || (!isMediaOperationActive(task.projectId, nodeId)
      && !tasks.some((other) => other.projectId === task.projectId && other.nodeId === nodeId && !matchesReceipt(other, receiptForTask(task))))));
}

/** 后台失败只更新原消息；未落盘时保留终态记录，不能丢失其唯一交付身份。 */
export async function persistFailedMediaMessage(task: PendingTask): Promise<void> {
  const context = task.mediaContext ?? task.runninghubMessage;
  if (!context?.messageId || !context.conversationId) return;
  const patch = { mediaStatus: 'failed' as const, mediaError: CONFIRMED_MEDIA_FAILURE_MESSAGE };
  const { getConversationMessages, putChatMessage } = await import('../../indexedDbService');
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
        const { persistMessage } = await import('../../chat/chatHistoryService');
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

export class CanvasResultStaleError extends ComfyPendingError {
  constructor() { super('画布已变化，任务结果已保留，请继续查询'); }
}

export function isRecoverableVideoTask(task: PendingTask): boolean {
  return task.nodeType === 'ai-video' && task.submitted && !!task.taskId
    && !(task.taskType === 'comfyui' && task.comfyRecoveryState === 'cancel_pending')
    && RECOVERABLE_VIDEO_TASK_TYPES.includes(task.taskType);
}

export function canResumeMediaTask(task: PendingTask): boolean {
  return (isRecoverableMediaTask(task) || isRecoverableVideoTask(task))
    && !task.terminalFailure && (hasMuseQueryIdentity(task)
      || task.submitted && !!task.taskId && !task.mediaSubmissionUncertain && task.mediaRecoveryState !== 'submit_unknown')
    && (runtime.videoResumePromises.has(task.nodeId) || !isMediaOperationActive(task.projectId, task.nodeId));
}

export function captureVideoTaskGeneration(nodeId?: string): PendingTask['videoGeneration'] {
  const data = useAppStore.getState().nodes.find((node) => node.id === nodeId)?.data;
  if (!data) return undefined;
  const { prompt, model, provider, seedanceResolution, seedanceRatio, seedanceDuration,
    generateAudio, videoResolution, videoFrames, videoFps } = data;
  return { prompt, model, provider, seedanceResolution, seedanceRatio, seedanceDuration,
    generateAudio, videoResolution, videoFrames, videoFps };
}

export function isCurrentVideoTask(task: PendingTask, signal?: AbortSignal): boolean {
  const store = useAppStore.getState();
  return !signal?.aborted && store.currentProjectId === task.projectId
    && store.nodes.some((node) => node.id === task.nodeId)
    && loadAll().some((item) => item.nodeId === task.nodeId && item.projectId === task.projectId && item.taskId === task.taskId);
}

export function isCurrentMediaTask(task: PendingTask, signal?: AbortSignal): boolean {
  const store = useAppStore.getState();
  return !signal?.aborted && store.currentProjectId === task.projectId
    && loadAll().some((item) => matchesReceipt(item, receiptForTask(task)))
    && (!!task.mediaContext?.messageId || !!task.mediaContext?.editorTransition || store.nodes.some((node) => node.id === task.nodeId));
}

export function guardVideoTaskQuery(task: PendingTask, signal: AbortSignal) {
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
      const controller = runtime.abortControllers.get(task.nodeId);
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
export function pauseVideoNodeTask(nodeId: string, expectedTaskId?: string, error?: unknown,
  reason?: keyof typeof VIDEO_PAUSE_MESSAGES, expectedReceipt?: MediaTaskReceipt): VideoPollingPausedError | undefined {
  const task = loadAll().find((item) => item.nodeId === nodeId && (!expectedReceipt || matchesReceipt(item, expectedReceipt)));
  if (!task || !isRecoverableVideoTask(task) || (expectedTaskId !== undefined && task.taskId !== expectedTaskId)) return undefined;
  const comfyQueryHttpStatus = task.taskType === 'comfyui'
    ? error instanceof ComfyQueryAuthorizationError ? error.status : task.comfyQueryHttpStatus : undefined;
  const deliveryPending = reason === 'delivery_pending' || (reason === 'canvas_changed'
    && task.taskType === 'comfyui' && task.comfyRecoveryState === 'save_pending' && !!task.comfyOutputFile);
  updatePendingTask(nodeId, {
    videoRecoveryState: 'paused',
    videoRecoveryMessage: error instanceof MediaPersistenceError ? error.message : reason ? VIDEO_PAUSE_MESSAGES[reason] : undefined,
    mediaRecoveryState: deliveryPending ? 'delivery_pending' : 'query_paused',
    mediaRecoveryReason: reason ?? 'query_interrupted',
    comfyQueryHttpStatus,
  }, task.taskId, task.attemptId);
  if (isCurrentVideoTask(task)) {
    useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'idle', error: undefined, videoTaskState: 'paused',
      mediaTaskState: deliveryPending ? 'delivery_pending' : 'paused', mediaTaskStage: undefined,
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
  if (!source || runtime.abortControllers.has(nodeId) || runtime.videoResumePromises.has(nodeId)) throw new Error('视频任务正在查询，请等待查询结束');
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
  if (store.currentProjectId && isNativeMediaNodeBusy(store.currentProjectId, nodeId)) throw new Error('原媒体任务正在处理');
  const nativeRecoveryState = getNativeMediaNodeRecovery(nodeId, store)
    && store.nodes.find((node) => node.id === nodeId)?.data.mediaTaskState;
  if (nativeRecoveryState === 'submit_unknown') throw new Error('提交状态未知，请到对应平台核对；应用不会自动重新生成。');
  if (nativeRecoveryState === 'paused' || nativeRecoveryState === 'delivery_pending') throw new Error('查询已暂停，任务已保留');
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === store.currentProjectId);
  if (!task) return;
  if (task.terminalFailure) { removeFailedMediaTask(receiptForTask(task)); return; }
  if (!isRecoverableMediaTask(task)) return;
  if (!task.taskId || !task.submitted || task.mediaSubmissionUncertain || task.mediaRecoveryState === 'submit_unknown') {
    throw new MediaTaskPausedError(receiptForTask(task), 'submit_unknown');
  }
  if (task.nodeType === 'ai-video') { prepareVideoNodeGeneration(nodeId); return; }
  if (!task.mediaRecoveryState) throw new Error('该节点仍有未交付的生成任务，请先继续查询');
  if (runtime.abortControllers.has(nodeId) || runtime.videoResumePromises.has(nodeId)) throw new Error('任务正在查询，请等待查询结束');
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

export function normalizeUrl(value?: string): string {
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
    imageOutputNodeIds, imageOutputCountRange, ...safeTask } = task;
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
    ...(isImageOutputCountRange(imageOutputCountRange) ? { imageOutputCountRange } : {}),
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
      taskType: task.taskType,
      mediaSubmissionUncertain: task.mediaSubmissionUncertain, expectedImageOutputs: task.expectedImageOutputs,
      ...(task.imageOutputCountRange ? { imageOutputCountRange: Object.freeze({ ...task.imageOutputCountRange }) } : {}),
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

export function loadAll(): PendingTask[] {
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
          ?? (hasMuseQueryIdentity(task) ? 'query_paused' : !task.submitted || !task.taskId ? 'submit_unknown' : 'querying'),
        ...(validId(task.mediaContext?.messageId) ? { messageId: task.mediaContext.messageId } : {}),
        ...(validId(task.mediaContext?.conversationId) ? { conversationId: task.mediaContext.conversationId } : {}),
        canResume: Boolean(canResumeMediaTask(task)) };
    });
    return { status: 'ok', tasks };
  } catch { return { status: 'invalid', errorCode: 'MEDIA_PENDING_SOURCE_INVALID' }; }
}

export function saveAll(tasks: PendingTask[]): void {
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
  runtime.mediaTaskListeners.forEach((listener) => listener());
  let changed = false;
  for (const [key, active] of runtime.activeComfyDeliveries) {
    if (!tasks.some((task) => task.projectId === active.projectId && task.nodeId === active.nodeId && task.taskId === active.taskId)) {
      runtime.activeComfyDeliveries.delete(key); changed = true;
    }
  }
  if (changed) notifyComfyDeliveries();
}

/** 保存一条待续任务（同一 nodeId 会覆盖旧记录） */
export function savePendingTask(task: PendingTask): MediaTaskReceipt {
  const mediaContext = task.mediaContext ?? runtime.mediaTaskContexts.get(task.nodeId);
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
  const knownAsync = ['apimart', 'apimart-flow-music', 'dreamina', 'muse', 'volcengine',
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
  const projectId = runtime.mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
  const idx = tasks.findIndex((task) => task.nodeId === nodeId
    && (expectedAttemptId !== undefined ? task.attemptId === expectedAttemptId
      : candidates.length === 1 || task.projectId === projectId));
  if (idx === -1) return;
  if (expectedTaskId !== undefined && tasks[idx].taskId !== expectedTaskId) return;
  if (expectedAttemptId !== undefined && tasks[idx].attemptId !== expectedAttemptId) return;
  const previous = tasks[idx];
  tasks[idx] = { ...previous, ...patch, nodeId: previous.nodeId, projectId: previous.projectId, attemptId: previous.attemptId };
  const outcome = runtime.mediaResumeOutcomes.get(JSON.stringify([previous.projectId, previous.nodeId]));
  if (outcome && matchesReceipt(previous, outcome.receipt)) outcome.receipt = receiptForTask(tasks[idx]);
  saveAll(tasks);
  notifyMediaReceipt(tasks[idx]);
  return receiptForTask(tasks[idx]);
}

/** 移除一条待续任务（轮询完成/失败/取消时调用） */
export function removePendingTask(nodeId: string, expectedTaskId?: string, expectedAttemptId?: string): void {
  const pollingProjectId = runtime.mediaTaskContexts.get(nodeId)?.projectId ?? runtime.pollingProjects.get(nodeId)
    ?? useAppStore.getState().currentProjectId;
  if (pollingProjectId && runtime.stoppedProjectIds.has(pollingProjectId)) return;
  const tasks = loadAll();
  const candidates = tasks.filter((task) => task.nodeId === nodeId);
  const contextProjectId = runtime.mediaTaskContexts.get(nodeId)?.projectId ?? useAppStore.getState().currentProjectId;
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
  runtime.runninghubMessageWaiters.get(nodeId)?.();
  runtime.runninghubMessageWaiters.delete(nodeId);
  runtime.workflowApiMessageWaiters.get(nodeId)?.();
  runtime.workflowApiMessageWaiters.delete(nodeId);
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

export function getBatchTaskNodeIds(
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
