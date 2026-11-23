/** 按原厂商任务与连接续查并交付结果。 */
import { isPollTimeoutError, PollTaskFailedError } from '../../pollTask';
import { pollVolcengineVideoTask } from '../providers/volcengineVideoQuery';
import { useAppStore } from '../../../store/useAppStore';
import { pickImageOutputParameters } from '../imageOutputParameters';
import {
  MediaPersistenceError,
  persistMediaUrlToProjectData,
  type PersistedProjectMedia,
} from '../../fileService';
import { applyImageBatchResults } from '../../imageBatchService';
import { mapImageDimensions } from '../../aiDimensions';
import { pollRunningHubTask, queryLegacyApimartAudioResult } from '../../pollManagerQueries';
import { queryApimartImageResult } from '../apimartImageResult';
import { queryApimartVideoResult } from '../apimartVideoResult';
import { queryCompatibleMediaTask } from '../asyncMediaResult';
import {
  COMFY_AUDIO_OUTPUT_KINDS,
  resolveComfyOutputUrl,
  sanitizeComfyOutputFile,
  type ComfyOutputKind,
  type ComfyOutputs,
} from '../../comfyOutputs';
import {
  ComfyOutputUnavailableError,
  ComfyPendingError,
  ComfyQueryAuthorizationError,
  pollComfyHistory,
  pollComfyTextHistory,
} from '../../comfyPolling';
import { maybeAutoReleaseComfyMemory } from '../../comfyMemory';
import { COMFY_QUERY_TIMEOUT_MS } from '../../comfyQuery';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../canvasDerivationGuard';
import { pollResolvedModelProtocol } from '../modelProtocol';
import { assertMinimaxQueryResponse, usesMinimaxResolvedVideoPoll } from '../providers/minimaxModelManifest';
import { assertImageOutputCount, assertModelProtocolResult } from '../modelCapabilityValidation';
import {
  extractFlowMusicLyrics,
  extractFlowMusicTrack,
  queryApimartMusicTask,
} from '../apimartAudio';
import type { BaseNodeData } from '../../../types';
import type { MediaDownloadAccess } from '../../../types/aiTypes';
import { createMediaDownloadAccess, sanitizeMediaResultUrls } from '../mediaDownloadAccess';
import {
  APIMART_BASE_URL,
  RUNNINGHUB_MODEL_BASE_URL,
  VOLCENGINE_BASE_URL,
} from '../../../constants/api';
import { queryDreaminaResult } from '../../dreaminaResult';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';
import {
  runtime,
  isComfyNodeDeliveryActive,
  beginComfyNodeDelivery,
  endComfyNodeDelivery,
  registerNodePolling,
  cleanupNodePolling,
  type PendingTask,
  VIDEO_POLL_MAX_DURATION_MS,
  MEDIA_POLL_MAX_DURATION_MS,
  receiptForTask,
  matchesReceipt,
  getMediaTaskReceipt,
  isRecoverableMediaTask,
  pauseMediaTask,
  completeMediaNodeTask,
  failedTaskNodeIds,
  removeFailedMediaTask,
  CanvasResultStaleError,
  isRecoverableVideoTask,
  isCurrentVideoTask,
  isCurrentMediaTask,
  guardVideoTaskQuery,
  registerPendingTaskContextGuard,
  pauseVideoNodeTask,
  completeVideoNodeTask,
  completeComfyNodeTask,
  normalizeUrl,
  loadAll,
  saveAll,
  updatePendingTask,
  removePendingTask,
  getPendingTasksForProject,
  getBatchTaskNodeIds,
} from './pendingTaskLedger';

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

// ═══════════════════════════════════════════
// 结果应用（镜像 AINodeDialog 的完成逻辑）
// ═══════════════════════════════════════════

async function applyNodeResult(
  nodeId: string,
  resultUrl: string,
  nodeLabel: string,
  isCurrent?: () => boolean,
  savedOutput?: PersistedProjectMedia,
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
  let persisted: PersistedProjectMedia;
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
    if (persisted.width !== undefined) updateData.imageWidth = persisted.width;
    if (persisted.height !== undefined) updateData.imageHeight = persisted.height;
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
    ...(nodeType === 'ai-image' ? { params: { imageSize: data.imageSize, imageQuality: data.imageQuality,
      imageBackground: data.imageBackground, aspectRatio: data.aspectRatio, ...pickImageOutputParameters(data) } } : {}),
  }, false, historyReceipt);
  const historyOutcome = currentProjectId ? runtime.mediaResumeOutcomes.get(JSON.stringify([currentProjectId, nodeId])) : undefined;
  if (historyReceipt && historyOutcome && historyOutcome.receipt.taskId === historyReceipt.taskId
    && historyOutcome.receipt.attemptId === historyReceipt.attemptId) historyOutcome.delivered = true;
  store.showToast(`${nodeLabel} 生成已完成`);
}

export async function handleResumeError(
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
    const outcome = runtime.mediaResumeOutcomes.get(JSON.stringify([task.projectId, task.nodeId]));
    if (outcome && matchesReceipt(task, outcome.receipt)) outcome.error = err;
  }
  if (isRecoverableMediaTask(task) && !(err instanceof PollTaskFailedError)) {
    // 被更新一轮查询替代的旧回调不得更改正在查询的状态。
    if (signal?.aborted && runtime.abortControllers.get(task.nodeId)?.signal !== signal) return;
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
    const { ensureMediaMessageRecoveryHandler } = await import('../generationRuntime');
    ensureMediaMessageRecoveryHandler();
  }
  if (!runtime.mediaMessageRecoveryHandler) throw new Error('对话任务恢复入口尚未就绪，任务已保留');
  signal?.throwIfAborted();
  await runtime.mediaMessageRecoveryHandler(task, urls, signal);
  return true;
}

export function markMediaTaskDeliveryPending(task: PendingTask, signal?: AbortSignal, urls?: string[]): void {
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
    const settled = await settleMediaTaskQueries(taskIds.map((taskId) => (batchSignal: AbortSignal) => {
      if (nodeType === 'ai-video') {
        return queryApimartVideoResult(apiKey, baseUrl, taskId, {
          maxDuration: MEDIA_POLL_MAX_DURATION_MS, signal: batchSignal, allowPartial: true, firstVideoOnly: true,
          failureMessage: (status) => `任务失败: ${status}`,
        });
      }
      if (nodeType === 'ai-audio') {
        return queryLegacyApimartAudioResult(apiKey, baseUrl, taskId, MEDIA_POLL_MAX_DURATION_MS, batchSignal);
      }
      return queryApimartImageResult(apiKey, baseUrl, taskId, {
        interval: 3000, maxDuration: MEDIA_POLL_MAX_DURATION_MS, signal: batchSignal,
      });
    }), signal);
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
    const original = await queryApimartMusicTask(apiKey, baseUrl, taskId, {
      signal, maxDuration: MEDIA_POLL_MAX_DURATION_MS,
      failureMessage: (state) => `APIMart 音乐任务失败: ${state.status}`,
    });
    if (stage === 'lyrics') {
      const generated = extractFlowMusicLyrics(original);
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

    const result = extractFlowMusicTrack(original);
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

async function resumeDreamina(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, taskId } = task;
  const node = useAppStore.getState().nodes.find((n) => n.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';

  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);

  try {
    const [url] = await queryDreaminaResult(taskId, { signal, firstOnly: true });
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

/* ── Muse ── */

async function resumeMuse(task: PendingTask, parentSignal?: AbortSignal): Promise<void> {
  const { nodeId, taskId } = task;
  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  const label = (node?.data as BaseNodeData | undefined)?.label || '';
  const signal = registerNodePolling(nodeId, parentSignal);
  const query = guardVideoTaskQuery(task, signal);
  try {
    if (!query.isCurrent()) throw new CanvasResultStaleError();
    const { queryMuseTask } = await import('../../museService');
    signal.throwIfAborted();
    const url = await queryMuseTask(taskId, task.nodeType === 'ai-video' ? 'video' : 'image', signal);
    // 原任务确实返回成品，才能补记送达；prepared/ready/unknown 不会走到这里。
    updatePendingTask(nodeId, { submitted: true, mediaSubmissionUncertain: false }, taskId, task.attemptId);
    // 原生私有产物可按原任务重取；不把媒体 Data URL 写入恢复队列。
    markMediaTaskDeliveryPending(task, signal);
    if (await deliverMediaMessageResult(task, [url], signal)) return;
    await applyNodeResult(nodeId, url, label, query.isCurrent, undefined, task.videoGeneration, undefined, signal);
    signal.throwIfAborted();
    completeMediaNodeTask(receiptForTask(task));
  } catch (error) {
    await handleResumeError(task, error, signal);
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

  const kinds: readonly ComfyOutputKind[] =
    nodeType === 'ai-video' ? ['video']
      : nodeType === 'ai-audio' ? COMFY_AUDIO_OUTPUT_KINDS
        : ['image'];
  const extract = (outputs: ComfyOutputs) => resolveComfyOutputUrl(baseUrl, outputs, kinds);
  let resultReceived = false;
  const autoRelease = () => maybeAutoReleaseComfyMemory(baseUrl, useAppStore.getState().config.comfyMemoryPolicy ?? 'smart',
    nodeType === 'ai-video' ? AbortSignal.timeout(COMFY_QUERY_TIMEOUT_MS) : undefined).catch(() => {});

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
      const { getNodeHistoryEntries } = await import('../../indexedDbService');
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
    if (nodeType === 'ai-video') void autoRelease();
    else await autoRelease();
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
    if (nodeType === 'ai-video' && resultReceived) {
      // 保留已识别的视频，即使画布版本已变，也只结束这个原任务自己的等待状态。
      pauseVideoNodeTask(nodeId, taskId, err, err instanceof CanvasResultStaleError ? 'canvas_changed' : 'delivery_pending', receiptForTask(task));
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
      if (nodeType === 'ai-video') void autoRelease();
      else await autoRelease();
      if (nodeType === 'ai-video' ? isCurrentMediaTask(task, signal) : isCurrent()) {
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
  if (!task || runtime.abortControllers.has(nodeId) || isComfyNodeDeliveryActive(task.projectId, nodeId)) return;
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
    const [url] = await queryCompatibleMediaTask(apiKey, baseUrl, taskId, resultField, {
      maxDuration: MEDIA_POLL_MAX_DURATION_MS, signal, allowPartial: true, firstOnly: resultField === 'audios',
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
    const settled = await settleMediaTaskQueries(polls.map((poll, index) => (querySignal: AbortSignal) => pollResolvedModelProtocol(
      { ...poll, maxDurationMs: poll.maxDurationMs ?? MEDIA_POLL_MAX_DURATION_MS },
      providerConfig.apiKey || '', querySignal, providerConfig.baseUrl,
      // 原任务只按已保存的查询合同识别，不借用连接现在的模型或自定义协议。
      usesMinimaxResolvedVideoPoll(poll, task.taskId, task.mediaDownloadAccess?.origin)
        ? assertMinimaxQueryResponse : undefined,
      undefined,
      polls.length === 1 ? task.taskId : task.taskIds?.[index] ?? '',
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
    if (task.imageOutputCountRange) {
      assertImageOutputCount(task.imageOutputCountRange, urls.length);
      if (task.expectedImageOutputs !== undefined && task.expectedImageOutputs !== urls.length) {
        throw new Error('原图片候选数量已变化，请核对原任务');
      }
      task = { ...task, expectedImageOutputs: urls.length };
      updatePendingTask(task.nodeId, { expectedImageOutputs: urls.length }, task.taskId, task.attemptId);
    }
    if (await deliverMediaMessageResult(task, urls, signal)) return;
    const requestedCount = Math.max(1, task.expectedImageOutputs ?? task.batchCount ?? 1);
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
        ...pickImageOutputParameters(nodeData),
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
  const { findBillingRunByTask, updateBillingRun } = await import('../../billing/volcengineBillingService');
  const { quoteVolcengineVideo } = await import('../../billing/volcenginePricing');
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

export async function queryRunningHubPendingTask(task: PendingTask, connection: import('../../../types/runninghub').RunningHubConnection,
  kind: import('../../../types/runninghub').RunningHubMediaKind, signal: AbortSignal, onStatus?: (stage: string) => void) {
  if (task.taskType === 'runninghub-model') {
    const { queryRunningHubModel } = await import('../providers/runninghubMedia');
    return queryRunningHubModel(connection, task.taskIds?.length ? task.taskIds : [task.taskId], kind, signal, onStatus);
  }
  const { queryRunningHubWorkflow } = await import('../providers/runninghubWorkflow');
  return queryRunningHubWorkflow(connection, task.taskId, kind, task.runninghubOutputNodeIds, signal, onStatus);
}

function runningHubMessageIsCurrent(task: PendingTask): boolean {
  const context = task.runninghubMessage;
  const store = useAppStore.getState();
  return !!context && store.currentProjectId === task.projectId && context.projectId === task.projectId
    && store.messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId);
}

/** 项目先加载画布、再加载当前会话；等原消息进入 Store 后才能恢复回填。 */
export function scheduleRunningHubMessageRecovery(task: PendingTask, savedOutputs?: import('../../../types/runninghub').RunningHubOutput[]) {
  runtime.runninghubMessageWaiters.get(task.nodeId)?.();
  runtime.runninghubMessageWaiters.delete(task.nodeId);
  if (runningHubMessageIsCurrent(task)) { void resumeRunningHubMessageTask(task, savedOutputs); return; }
  if (useAppStore.getState().currentProjectId !== task.projectId) return;
  const lease = registerPendingTaskContextGuard(task);
  if (!lease.isCurrent()) { lease.complete(); return; }
  const stopWaiting = () => { unsubscribe(); lease.complete(); runtime.runninghubMessageWaiters.delete(task.nodeId); };
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
  runtime.runninghubMessageWaiters.set(task.nodeId, stopWaiting);
}

function applyRunningHubRecoveredMessage(task: PendingTask, outputs: import('../../../types/runninghub').RunningHubOutput[]) {
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

async function resumeRunningHubMessageTask(task: PendingTask, savedOutputs?: import('../../../types/runninghub').RunningHubOutput[]): Promise<void> {
  const lease = registerPendingTaskContextGuard(task);
  try { if (lease.isCurrent()) await resumeRunningHubMessageWithContext(task, savedOutputs, lease); }
  finally { lease.complete(); }
}

async function resumeRunningHubMessageWithContext(task: PendingTask,
  savedOutputs: import('../../../types/runninghub').RunningHubOutput[] | undefined,
  lease: ReturnType<typeof registerPendingTaskContextGuard>): Promise<void> {
  if (!lease.isCurrent() || !runningHubMessageIsCurrent(task) || runtime.abortControllers.has(task.nodeId)) return;
  const context = task.runninghubMessage!;
  if (!task.taskId) {
    useAppStore.getState().updateMessage(context.messageId, { mediaStatus: 'failed', mediaError: 'RunningHub 提交状态未知，请到平台核对任务，避免重复生成' }); return;
  }
  const { saveRunningHubOutputs, RunningHubTaskFailed } = await import('../providers/runninghubWorkflow');
  const { runningHubConnection } = await import('../../workflowExecutionService');
  if (!lease.isCurrent() || !runningHubMessageIsCurrent(task) || runtime.abortControllers.has(task.nodeId)) return;
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

export async function resumeRunningHubWorkflow(task: PendingTask, externalSignal?: AbortSignal): Promise<void> {
  const lease = registerPendingTaskContextGuard(task, externalSignal);
  try { if (lease.isCurrent()) await resumeRunningHubWorkflowWithContext(task, lease, externalSignal); }
  finally { lease.complete(); }
}

async function resumeRunningHubWorkflowWithContext(task: PendingTask, lease: ReturnType<typeof registerPendingTaskContextGuard>,
  externalSignal?: AbortSignal): Promise<void> {
  const { saveRunningHubOutputs, RunningHubTaskFailed } = await import('../providers/runninghubWorkflow');
  const { runningHubConnection } = await import('../../workflowExecutionService');
  const { nodeId, projectId, taskId } = task;
  if (!lease.isCurrent() || !taskId || runtime.abortControllers.has(nodeId)) return;
  const signal = registerNodePolling(nodeId, externalSignal);
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
    if (!task.runninghubSubmissionUncertain) completeMediaNodeTask(receiptForTask(task));
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

export function scheduleWorkflowApiMessageRecovery(task: PendingTask): void {
  runtime.workflowApiMessageWaiters.get(task.nodeId)?.();
  runtime.workflowApiMessageWaiters.delete(task.nodeId);
  if (workflowApiMessageIsCurrent(task)) { void resumeWorkflowApi(task); return; }
  if (useAppStore.getState().currentProjectId !== task.projectId) return;
  const lease = registerPendingTaskContextGuard(task);
  if (!lease.isCurrent()) { lease.complete(); return; }
  const stopWaiting = () => { unsubscribe(); lease.complete(); runtime.workflowApiMessageWaiters.delete(task.nodeId); };
  const unsubscribe = useAppStore.subscribe(() => {
    if (!lease.isCurrent() || useAppStore.getState().currentProjectId !== task.projectId || !getPendingTasksForProject(task.projectId)
      .some((item) => item.nodeId === task.nodeId && item.workflowApi?.attemptId === task.workflowApi?.attemptId)) {
      stopWaiting(); return;
    }
    if (workflowApiMessageIsCurrent(task)) {
      stopWaiting(); void resumeWorkflowApi(task);
    }
  });
  runtime.workflowApiMessageWaiters.set(task.nodeId, stopWaiting);
}

export async function resumeWorkflowApi(task: PendingTask, externalSignal?: AbortSignal): Promise<void> {
  const lease = registerPendingTaskContextGuard(task, externalSignal);
  try { if (lease.isCurrent()) await resumeWorkflowApiWithContext(task, lease, externalSignal); }
  finally { lease.complete(); }
}

async function resumeWorkflowApiWithContext(task: PendingTask, lease: ReturnType<typeof registerPendingTaskContextGuard>,
  externalSignal?: AbortSignal): Promise<void> {
  if (runtime.abortControllers.has(task.nodeId) || useAppStore.getState().currentProjectId !== task.projectId) return;
  if (task.workflowApiMessage && !workflowApiMessageIsCurrent(task)) { scheduleWorkflowApiMessageRecovery(task); return; }
  const adapter: typeof import('../../workflowApi/workflowApiAdapter') = await import('../../workflowApi/workflowApiAdapter');
  const manifestModule: typeof import('../../workflowApi/autodlWorkflowManifest') = await import('../../workflowApi/autodlWorkflowManifest');
  const { saveCloudWorkflowOutputs } = await import('../../workflowExecutionService');
  if (!lease.isCurrent() || runtime.abortControllers.has(task.nodeId) || useAppStore.getState().currentProjectId !== task.projectId) return;
  const signal = registerNodePolling(task.nodeId, externalSignal);
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
    completeMediaNodeTask(receiptForTask(task));
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

export const RESUME_MAP: Record<PendingTask['taskType'], (task: PendingTask, signal?: AbortSignal) => Promise<void>> = {
  apimart: resumeApimart,
  'apimart-flow-music': resumeApimartFlowMusic,
  dreamina: resumeDreamina,
  muse: resumeMuse,
  comfyui: resumeComfyUI,
  general: resumeGeneral,
  'custom-protocol': resumeCustomProtocol,
  volcengine: resumeVolcengine,
  runninghub: resumeRunningHub,
  'runninghub-workflow': resumeRunningHubWorkflow,
  'runninghub-model': resumeRunningHubWorkflow,
  'workflow-api': resumeWorkflowApi,
};
