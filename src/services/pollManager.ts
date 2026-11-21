/**
 * pollManager — 待续任务管理器
 *
 * 记录正在轮询的异步任务到 localStorage，支持：
 * - 切换项目后恢复轮询
 * - 关闭应用后重新打开继续轮询
 *
 * 存储结构按 projectId 隔离，每个节点或消息跟踪 ID 最多一条待续记录。
 */
import { withPollRequestDeadline } from './pollTask';
import { useAppStore } from '../store/useAppStore';
import type { BaseNodeData } from '../types';
import type { MediaDownloadAccess, MediaTaskReceipt } from '../types/aiTypes';
import { sanitizeMediaResultUrls } from './ai/mediaDownloadAccess';
import { isHistoryMediaDownloadPending } from './historyMediaRecovery';
import {
  runtime,
  isComfyNodeDeliveryActive,
  type PendingTask,
  MediaTaskPausedError,
  registerMediaNodeOperation,
  isMediaOperationActive,
  resumeNativeMediaWhenReady,
  receiptForTask,
  matchesReceipt,
  isRecoverableMediaTask,
  hasMuseQueryIdentity,
  pauseMediaTask,
  discardMediaTask,
  CONFIRMED_MEDIA_FAILURE_MESSAGE,
  failedTaskNodeIds,
  persistFailedMediaMessage,
  removeFailedMediaTask,
  isRecoverableVideoTask,
  loadAll,
  updatePendingTask,
  removePendingTask,
  getPendingTasksForProject,
  getBatchTaskNodeIds,
  bindPollManagerRuntime,
} from './ai/polling/pendingTaskLedger';
import {
  handleResumeError,
  markMediaTaskDeliveryPending,
  queryRunningHubPendingTask,
  scheduleRunningHubMessageRecovery,
  resumeRunningHubWorkflow,
  scheduleWorkflowApiMessageRecovery,
  resumeWorkflowApi,
  RESUME_MAP,
} from './ai/polling/providerTaskRecovery';
export {
  createOrReusePollManagerRuntime,
  stopPollingForDeletedProjects,
  getMediaTaskSnapshot,
  hasPendingMessageMediaTask,
  initializeMediaTaskSnapshot,
  subscribeMediaTasks,
  subscribeComfyDeliveries,
  isComfyNodeDeliveryActive,
  beginComfyNodeDelivery,
  registerNodePolling,
  isNodePollingCurrent,
  cancelNodePolling,
  cleanupNodePolling,
  type PendingTask,
  type MediaTaskSnapshot,
  PendingMediaTaskSourceError,
  VIDEO_POLL_MAX_DURATION_MS,
  MEDIA_POLL_MAX_DURATION_MS,
  VideoPollingPausedError,
  type MediaTaskPauseReason,
  MediaTaskPausedError,
  isMediaTaskPausedError,
  bindMediaTaskContext,
  getVideoEditorTransitionAnchor,
  isVideoEditorTransitionTaskActive,
  registerMediaMessageRecoveryHandler,
  registerMediaNodeOperation,
  resumeNativeMediaLocalDelivery,
  isNativeMediaNodeBusy,
  trackNativeMediaNodeRun,
  cancelNativeWorkflowOnNode,
  getNativeMediaNodeRecovery,
  clearNativeMediaNodeRecovery,
  refreshNativeMediaNodeRecovery,
  reviewNativeMediaFromNode,
  resumeNativeMediaFromNode,
  getMediaTaskReceipt,
  hasMuseQueryIdentity,
  pauseMediaTask,
  pauseMediaNodeTask,
  completeMediaNodeTask,
  discardMediaTask,
  removeFailedMediaTask,
  canResumeMediaTask,
  captureVideoTaskGeneration,
  registerPendingTaskContextGuard,
  pauseVideoNodeTask,
  pauseVideoNodeTaskOnTimeout,
  completeVideoNodeTask,
  completeComfyNodeTask,
  pauseComfyNodeDelivery,
  prepareVideoNodeGeneration,
  prepareMediaNodeGeneration,
  type PendingMediaTaskReadView,
  type PendingMediaTaskReadResult,
  readPendingMediaTaskViews,
  savePendingTask,
  updatePendingTask,
  removePendingTask,
  clearProjectTasks,
  getPendingTasksForProject,
} from './ai/polling/pendingTaskLedger';
export {
  settleMediaTaskQueries,
  resumeComfyUINodeTask,
  resumeRunningHubNodeTask,
  resumeWorkflowApiNodeTask,
} from './ai/polling/providerTaskRecovery';

bindPollManagerRuntime(import.meta.hot?.data);

/** 剪辑器主动取回：只续查原任务并返回结果，不调用节点、消息或剪辑工程写入。 */
export async function readVideoEditorTransitionTaskResult(receipt: MediaTaskReceipt, signal?: AbortSignal): Promise<{
  url: string; mediaDownloadAccess?: MediaDownloadAccess;
}> {
  signal?.throwIfAborted();
  const task = loadAll().find((item) => matchesReceipt(item, receipt));
  if (!task?.mediaContext?.editorTransition || task.nodeType !== 'ai-video'
    || useAppStore.getState().currentProjectId !== receipt.projectId) throw new Error('原转场任务已变化，请返回所属画布后取回');
  if (task.terminalFailure) throw new Error(CONFIRMED_MEDIA_FAILURE_MESSAGE);
  if (!hasMuseQueryIdentity(task) && (!task.submitted || !task.taskId || task.mediaSubmissionUncertain || task.runninghubSubmissionUncertain
    || task.mediaRecoveryState === 'submit_unknown')) throw new MediaTaskPausedError(receipt, 'submit_unknown');
  if (isMediaOperationActive(task.projectId, task.nodeId) || runtime.abortControllers.has(task.nodeId)
    || runtime.editorTransitionResultSinks.has(task.nodeId)) throw new Error('原转场任务仍在处理，请稍后取回');
  const cached = sanitizeMediaResultUrls(task.resultUrls);
  const canRefreshRemote = task.taskType === 'custom-protocol'
    ? !!task.protocolPoll || !!task.protocolPolls?.length
    : ['volcengine', 'general', 'apimart', 'dreamina', 'muse', 'runninghub-model'].includes(task.taskType);
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
export async function retryHistoryMediaDownload(receipt: MediaTaskReceipt, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  historyDownloadTask(receipt);
  const busy = () => runtime.videoResumePromises.has(receipt.nodeId) || runtime.abortControllers.has(receipt.nodeId)
    || isMediaOperationActive(receipt.projectId, receipt.nodeId);
  if (busy()) return Promise.reject(new Error('原任务仍在处理，请稍后再重新下载'));
  const outcomeKey = JSON.stringify([receipt.projectId, receipt.nodeId]);
  const outcome = { receipt, delivered: false, error: undefined as unknown };
  runtime.mediaResumeOutcomes.set(outcomeKey, outcome);
  const promise = Promise.resolve().then(() => {
    signal?.throwIfAborted();
    const task = historyDownloadTask(receipt);
    if (runtime.abortControllers.has(receipt.nodeId) || isMediaOperationActive(receipt.projectId, receipt.nodeId)) throw new Error('原任务仍在处理，请稍后再重新下载');
    return RESUME_MAP[task.taskType](task, signal);
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
    if (runtime.videoResumePromises.get(receipt.nodeId) === promise) runtime.videoResumePromises.delete(receipt.nodeId);
    if (runtime.mediaResumeOutcomes.get(outcomeKey) === outcome) runtime.mediaResumeOutcomes.delete(outcomeKey);
  });
  runtime.videoResumePromises.set(receipt.nodeId, promise);
  return promise;
}

/** 放弃只解除当前已完成任务的本地恢复，不删除文件、不取消上游。 */
export function abandonHistoryMediaDownload(receipt: MediaTaskReceipt): void {
  if (useAppStore.getState().currentProjectId !== receipt.projectId) throw new Error('项目已切换，请重新操作');
  if (!loadAll().some((task) => matchesReceipt(task, receipt))) return;
  historyDownloadTask(receipt);
  if (runtime.videoResumePromises.has(receipt.nodeId) || runtime.abortControllers.has(receipt.nodeId)
    || isMediaOperationActive(receipt.projectId, receipt.nodeId)) throw new Error('正在重新下载，请等待完成后再放弃');
  discardMediaTask(receipt);
  const store = useAppStore.getState();
  if (store.currentProjectId === receipt.projectId && store.nodes.some((node) => node.id === receipt.nodeId)) {
    store.updateNodeDataTransient(receipt.nodeId, { status: 'idle', error: undefined, runninghubStage: undefined });
  }
}

/**
 * 按现有回执续查原任务或重新下载。已有续查时，旁观者的信号仅取消自己的等待。
 * 发起新生成使用 executeGeneration。
 */
export function resumeMediaNodeTask(nodeId: string, externalSignal?: AbortSignal, expected?: MediaTaskReceipt): Promise<void> {
  if (externalSignal?.aborted) return Promise.reject(externalSignal.reason);
  const existing = runtime.videoResumePromises.get(nodeId);
  // 旁观已有恢复时只停止自己的等待，不能中断原发起者的查询和保存。
  if (existing) {
    if (expected) return Promise.reject(new Error('原任务仍在处理，请稍后再重新下载'));
    return externalSignal ? withPollRequestDeadline(() => existing, externalSignal, Infinity) : existing;
  }
  const store = useAppStore.getState();
  const task = loadAll().find((item) => item.nodeId === nodeId && item.projectId === store.currentProjectId);
  if (!task || (expected && !matchesReceipt(task, expected))
    || (!isRecoverableMediaTask(task) && !isRecoverableVideoTask(task)
      && !(expected && ['workflow-api', 'runninghub-workflow', 'runninghub-model'].includes(task.taskType)))
    || (!task.mediaContext?.messageId && !store.nodes.some((node) => node.id === nodeId))) {
    return Promise.reject(new Error('没有可恢复的生成任务'));
  }
  if (task.terminalFailure) return Promise.reject(new Error(CONFIRMED_MEDIA_FAILURE_MESSAGE));
  if (!hasMuseQueryIdentity(task) && (!task.submitted || !task.taskId || task.mediaSubmissionUncertain
    || task.mediaRecoveryState === 'submit_unknown' || (expected && (task.runninghubSubmissionUncertain
      || task.runninghubRecoveryState === 'submit_unknown' || task.workflowApi?.state === 'submit_unknown')))) {
    return Promise.reject(new MediaTaskPausedError(receiptForTask(task), 'submit_unknown'));
  }
  if (isMediaOperationActive(task.projectId, nodeId)) {
    return Promise.reject(new Error('原生成任务仍在处理或保存结果，请稍后再继续查询'));
  }
  if (runtime.abortControllers.has(nodeId)) {
    return expected ? Promise.reject(new Error('原任务仍在处理，请稍后再重新下载')) : Promise.resolve();
  }
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
  runtime.mediaResumeOutcomes.set(outcomeKey, outcome);
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
    if (expected && !outcome.delivered) throw new Error('原任务尚未交付，原回执已保留');
    if (!outcome.delivered && !loadAll().some((item) => matchesReceipt(item, outcome.receipt))) {
      throw new Error('任务已停止，尚未确认结果交付');
    }
  }).finally(() => {
    externalSignal?.removeEventListener('abort', pauseCancelledTask);
    if (runtime.videoResumePromises.get(nodeId) === promise) runtime.videoResumePromises.delete(nodeId);
    if (runtime.mediaResumeOutcomes.get(outcomeKey) === outcome) runtime.mediaResumeOutcomes.delete(outcomeKey);
  });
  runtime.videoResumePromises.set(nodeId, promise);
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
  const native = store.projectExecutionContext;
  if (native?.kind === 'canvas' && native.modelGeneration === 1 && native.canvasId === projectId) {
    await resumeNativeMediaWhenReady(native); return;
  }
  // 新结构的临时停写态不能落到旧队列孤儿扫描，避免误报“没有任务身份”。
  if ((store.projects.find((project) => project.id === projectId) as { nativeView?: unknown } | undefined)?.nativeView) return;
  const tasks = getPendingTasksForProject(projectId);

  // 批量图片的远端任务只挂在源节点上，同组占位节点也属于该任务的恢复范围。
  const coveredNodes = getPendingTaskCoveredNodeIds(store.nodes, tasks);

  // 缺少可持久化恢复身份也可能是同步请求中断，不能据此断言从未提交。
  // 本进程仍在消费请求或保存结果时，恢复扫描不得将其认作孤立节点。
  const orphanLoadingNodes = store.nodes.filter(
    (n) => (n.data as BaseNodeData).status === 'loading' && !coveredNodes.has(n.id)
      && !isMediaOperationActive(projectId, n.id) && !runtime.abortControllers.has(n.id),
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
    if (isMediaOperationActive(projectId, task.nodeId) || runtime.abortControllers.has(task.nodeId)) continue;
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
      if (!runtime.abortControllers.has(task.nodeId) && !runtime.videoResumePromises.has(task.nodeId)) {
        store.updateNodeDataTransient(task.nodeId, { status: 'idle', error: undefined, videoTaskState: 'paused',
          generationStartedAt: task.videoGenerationStartedAt });
      }
      continue;
    }

    if (task.taskType === 'workflow-api') {
      if (!runtime.abortControllers.has(task.nodeId)) void resumeWorkflowApi(task);
      continue;
    }

    if (['runninghub-workflow', 'runninghub-model'].includes(task.taskType)) {
      if (runtime.abortControllers.has(task.nodeId)) continue;
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
      if (!runtime.abortControllers.has(task.nodeId) && !isComfyNodeDeliveryActive(task.projectId, task.nodeId)) store.updateNodeDataTransient(task.nodeId, {
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

    if (runtime.abortControllers.has(task.nodeId)) {
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
