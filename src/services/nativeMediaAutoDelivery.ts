/** 原画布就绪时优先交付本机缓存；显式入口仅可续取已确认的原 CCC 图片任务。 */
import { useAppStore } from '../store/useAppStore';
import type { CanvasContext } from '../types/project';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { claimNativeMediaRecovery, isNativeMediaTaskSuperseded, listNativeMediaTasks } from './indexedDb/nativeMediaTaskRepository';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { nativeImageBatchSettled } from './nativeImageBatch';
import { readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { localMediaUrlToPath } from '../utils/mediaUrl';

const deliveries = new Map<string, Promise<boolean>>();
interface DeliveryQueue { repeat: boolean; nodes: Set<string> | null; allowOriginalCccTaskQuery: boolean; promise: Promise<void> }
const queues = new Map<string, DeliveryQueue>();
export interface NativeMediaAutoDeliveryOptions { nodeId?: string; isNodeBusy?: (canvasId: string, nodeId: string) => boolean; allowOriginalCccTaskQuery?: boolean }
function sameCanvas(record: NativeMediaTaskRecord, context: CanvasContext): boolean {
  return record.ownerProjectId === context.projectId && record.canvasId === context.canvasId && record.episodeId === context.episodeId
    && record.projectEpoch === context.projectEpoch && record.canvasEpoch === context.canvasEpoch;
}
function current(context: CanvasContext, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已变化，本机产物保留');
}
function completeLocalSet(record: NativeMediaTaskRecord): boolean {
  return !!record.localResults?.length || record.submissionKind === 'sync' && !!record.localResult
    || !!record.apimartImageBatch && nativeImageBatchSettled(record.apimartImageBatch) && nativeMediaLocalOutputs(record).length > 0;
}
const productFields = ['imageUrl', 'videoUrl', 'audioUrl', 'output', 'sourceUrl', 'thumbnailUrl', 'relativePath', 'filePath', 'assetId', 'artifactId', 'storageRootRef', 'mattingMask', 'annotation', 'annotationLayer'] as const;
/** success 产物属于用户当前选择；只有本回执同一原文件才可视为已展示的同一结果。 */
async function protectedSuccess(record: NativeMediaTaskRecord): Promise<boolean> {
  if (record.origin?.deliveryMode === 'chat') return false;
  const data = useAppStore.getState().nodes.find((node) => node.id === record.nodeId)?.data;
  if (!data || data.status !== 'success' || ![data.imageUrl, data.videoUrl, data.audioUrl, data.output, data.filePath].some((value) => typeof value === 'string' && value)) return false;
  if (data.artifactId !== `native-media-${record.operationId}` || !completeLocalSet(record)
    || data.relativePath !== record.resultRelativePath) return true;
  const { getProjectDataDir, getRelativeAssetPath } = await import('./fileService');
  const root = await getProjectDataDir(record.canvasId); if (!root) return true;
  return ['imageUrl', 'videoUrl', 'audioUrl', 'output', 'sourceUrl', 'thumbnailUrl', 'filePath'].some((field) => {
    const value = data[field as keyof typeof data];
    if (typeof value !== 'string' || !value) return false;
    const path = localMediaUrlToPath(value) ?? (field === 'filePath' ? value : undefined);
    return (path ? getRelativeAssetPath(path, root) : value) !== record.resultRelativePath;
  });
}

/** 默认只消费本机文件；原画布协调器可显式续取已确认的原 CCC 任务。 */
export function deliverNativeMediaCachedResult(operationId: string, context: CanvasContext, signal?: AbortSignal,
  isNodeBusy?: (canvasId: string, nodeId: string) => boolean, allowOriginalCccTaskQuery = false): Promise<boolean> {
  const key = `${context.projectId}/${context.canvasId}/${context.runtimeEpoch}/${operationId}`;
  const existing = deliveries.get(key); if (existing) return existing;
  const externalSignal = signal, controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) controller.abort();
  signal = controller.signal;
  let unsubscribe = () => {};
  let committing: { artifactId: string; relativePath: string; rootRef?: string } | undefined;
  const work = (async () => {
    current(context, signal);
    const records = await listNativeMediaTasks(context.projectId);
    let record = records.find((row) => row.operationId === operationId);
    current(context, signal);
    if (!record || !sameCanvas(record, context) || !['prepared', 'submitted', 'outcome-unknown'].includes(record.status)) return false;
    if (isNativeMediaTaskSuperseded(record, records)) return false;
    if (isNodeBusy?.(record.canvasId, record.nodeId)) return false;
    const targetId = record.nodeId, target = useAppStore.getState().nodes.find((node) => node.id === targetId);
    const products = target ? productFields.map((field) => target.data[field]) : undefined;
    const chatOnly = record.origin?.deliveryMode === 'chat';
    unsubscribe = useAppStore.subscribe(() => {
      const state = useAppStore.getState(), live = state.nodes.find((node) => node.id === targetId);
      if (!isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) { controller.abort(); return; }
      if (!chatOnly && (!live || !target || live.type !== target.type || productFields.some((field, ordinal) => live.data[field] !== products?.[ordinal]))) {
        // Store在IDB complete内同步发布的本op原文件是本次成功，不作为用户替换而取消。
        if (committing && live?.data.status === 'success' && live.data.artifactId === committing.artifactId
          && live.data.relativePath === committing.relativePath && (!committing.rootRef || live.data.storageRootRef === committing.rootRef)) {
          unsubscribe(); unsubscribe = () => {}; return;
        }
        controller.abort();
      }
    });
    if (await protectedSuccess(record)) return false;
    current(context, signal);
    if (record.origin?.deliveryMode !== 'chat') {
      if (!useAppStore.getState().nodes.some((node) => node.id === record.nodeId)) return false;
      const { assertNativeVideoSubmissionInput } = await import('./nativeVideoSubmission');
      current(context, signal);
      await assertNativeVideoSubmissionInput(record, context);
      current(context, signal);
    }
    if (record.status === 'outcome-unknown' || !completeLocalSet(record)) {
      const { retainNativeBuiltinImageCachedOutputs, retainNativeBuiltinImageOriginalTaskOutputs } = await import('./nativeBuiltinImageTask');
      let retained = await retainNativeBuiltinImageCachedOutputs(record, signal);
      current(context, signal);
      if (!retained && allowOriginalCccTaskQuery) retained = await retainNativeBuiltinImageOriginalTaskOutputs(record, signal);
      current(context, signal);
      if (!retained) return false; record = retained;
    }
    if (record.status !== 'submitted' || !completeLocalSet(record)) return false;
    const files = nativeMediaLocalOutputs(record);
    for (const file of files) { current(context, signal); await readNativeMediaLocalResult(record.canvasId, file); }
    current(context, signal);
    if (isNodeBusy?.(record.canvasId, record.nodeId)) return false;
    if (record.origin?.deliveryMode !== 'chat' && !useAppStore.getState().nodes.some((node) => node.id === record.nodeId)) return false;
    const claimed = await claimNativeMediaRecovery(record.operationId, context, { signal,
      expectedSubmission: { lease: record.lease, revision: record.revision } });
    current(context, signal);
    if (isNodeBusy?.(claimed.canvasId, claimed.nodeId)) return false;
    if (claimed.origin?.deliveryMode === 'chat') {
      const { commitNativeMediaMessageDelivery } = await import('./nativeMediaDelivery');
      current(context, signal);
      await commitNativeMediaMessageDelivery(claimed, files[0].relativePath, { signal });
    } else {
      committing = { artifactId: `native-media-${claimed.operationId}`, relativePath: files[0].relativePath, rootRef: claimed.resultRootRef };
      await useAppStore.getState().commitNativeMediaResult(claimed, files[0].relativePath, context, signal);
    }
    // 聊天视图投影失败不把已经提交的原回执误报为未交付。
    try { const { projectNativeMediaMessages } = await import('./nativeMediaMessages'); await projectNativeMediaMessages(); }
    catch { /* 完成回执和画布已提交，后续打开原对话再水化展示。 */ }
    return true;
  })().finally(() => {
    unsubscribe(); externalSignal?.removeEventListener('abort', abort); controller.abort();
    if (deliveries.get(key) === work) deliveries.delete(key);
  });
  deliveries.set(key, work); return work;
}

/** 事件驱动、同画布串行；Store普通更新不会触发扫描，忙节点只等真实释放事件再试。 */
export function resumeNativeMediaLocalResults(canvasId: string, options: NativeMediaAutoDeliveryOptions = {}): Promise<void> {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1 || context.canvasId !== canvasId) return Promise.resolve();
  const key = `${context.projectId}/${canvasId}/${context.runtimeEpoch}`;
  const existing = queues.get(key);
  if (existing) {
    existing.repeat = true;
    existing.allowOriginalCccTaskQuery ||= options.allowOriginalCccTaskQuery === true;
    if (!options.nodeId) existing.nodes = null; else existing.nodes?.add(options.nodeId);
    return existing.promise;
  }
  const queue: DeliveryQueue = { repeat: false, nodes: options.nodeId ? new Set([options.nodeId]) : null,
    allowOriginalCccTaskQuery: options.allowOriginalCccTaskQuery === true, promise: Promise.resolve() };
  const controller = new AbortController();
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  queue.promise = (async () => {
    do {
      queue.repeat = false;
      const nodes = queue.nodes; queue.nodes = new Set();
      current(context, controller.signal);
      const records = await listNativeMediaTasks(context.projectId);
      const originalQueries: Array<{ operationId: string; nodeId: string }> = [];
      for (const record of records) {
        current(context, controller.signal);
        if (!sameCanvas(record, context) || !['prepared', 'submitted', 'outcome-unknown'].includes(record.status) || nodes && !nodes.has(record.nodeId)
          || options.isNodeBusy?.(canvasId, record.nodeId)) continue;
        // 优先全部本机缓存，慢的服务商查询不能挡住同画布已有结果。
        const delivered = await deliverNativeMediaCachedResult(record.operationId, context, controller.signal, options.isNodeBusy).catch(() => false);
        if (!delivered && queue.allowOriginalCccTaskQuery && record.status === 'submitted' && record.remoteTaskId) originalQueries.push({ operationId: record.operationId, nodeId: record.nodeId });
      }
      for (const [ordinal, query] of originalQueries.entries()) {
        current(context, controller.signal);
        if (queue.repeat) {
          // 先处理新就绪缓存，再继续未查询的原任务；不能被另一节点的释放事件丢掉。
          for (const remaining of originalQueries.slice(ordinal)) queue.nodes?.add(remaining.nodeId);
          break;
        }
        await deliverNativeMediaCachedResult(query.operationId, context, controller.signal, options.isNodeBusy, true).catch(() => false);
      }
    } while (queue.repeat && !controller.signal.aborted);
  })().finally(() => { unsubscribe(); controller.abort(); if (queues.get(key) === queue) queues.delete(key); });
  queues.set(key, queue); return queue.promise;
}
