/** 原画布就绪时优先交付本机缓存，再按持久回执续取可核验的原任务。 */
import { useAppStore } from '../store/useAppStore';
import type { CanvasContext } from '../types/project';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { ACTIVE_NATIVE_MEDIA_STATES, claimNativeMediaRecovery, listNativeMediaTasks,
  readAvailableNativeMediaTask } from './indexedDb/nativeMediaTaskRepository';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { nativeImageBatchSettled } from './nativeImageBatch';
import { readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { readNativeMediaRecoverySummary } from './nativeMediaRecoverySummary';

const deliveries = new Map<string, Promise<boolean>>();
const autoDeliveryStates = [...ACTIVE_NATIVE_MEDIA_STATES, 'failed'] as const;
type BoundQuery = (record: NativeMediaTaskRecord, context: CanvasContext, signal: AbortSignal) => Promise<boolean>;
type ShowPausedProtocol = (record: NativeMediaTaskRecord, context: CanvasContext, saving: boolean) => void;
interface DeliveryQueue { repeat: boolean; nodes: Set<string> | null; allowOriginalCccTaskQuery: boolean; queryProtocol?: BoundQuery; promise: Promise<void> }
const queues = new Map<string, DeliveryQueue>();
export interface NativeMediaAutoDeliveryOptions {
  nodeId?: string;
  isNodeBusy?: (canvasId: string, nodeId: string) => boolean;
  allowOriginalCccTaskQuery?: boolean;
  queryProtocol?: BoundQuery;
  showPausedProtocol?: ShowPausedProtocol;
}
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

/** 仅由具有原凭据证明的版本化查询合同进入自动网络恢复。 */
function hasBoundProtocolTask(record: NativeMediaTaskRecord): boolean {
  return record.status === 'submitted' && record.submissionKind === 'async' && !!record.remoteTaskId
    && record.recovery?.kind === 'general-protocol' && !!record.recovery.serverId && !!record.recovery.credentialProof
    && record.recovery.serverId !== 'general-async-v1' && !record.apimartImageBatch && record.providerConfigId !== 'comfyui'
    && record.origin?.deliveryMode !== 'chat';
}
/** 已停止的本机等待只投影状态；不据此改写远端结论、查询或重新提交。 */
export async function projectNativeMediaStoppedState(operationId: string, context: CanvasContext,
  options: Pick<NativeMediaAutoDeliveryOptions, 'isNodeBusy' | 'showPausedProtocol'> & { isCurrent?: () => boolean } = {}): Promise<boolean> {
  current(context);
  const record = await readAvailableNativeMediaTask(context.projectId, context.canvasId, operationId);
  current(context);
  if (!record || !sameCanvas(record, context) || record.origin?.deliveryMode === 'chat'
    || options.isNodeBusy?.(record.canvasId, record.nodeId)
    || options.isCurrent?.() === false) return false;
  const target = useAppStore.getState().nodes.find((node) => node.id === record.nodeId);
  if (!target) return false;
  const known = record.status === 'submitted' && !!record.remoteTaskId && record.recovery?.kind === 'general-protocol'
    && (!!options.showPausedProtocol || !hasBoundProtocolTask(record));
  const canShowRecovery = known && hasBoundProtocolTask(record) && !!options.showPausedProtocol;
  if (target.data.status !== 'loading' && !(canShowRecovery && target.data.status === 'idle')) return false;
  const failed = record.status === 'failed';
  if (!failed && !known && (!['prepared', 'outcome-unknown'].includes(record.status) || record.remoteTaskId || completeLocalSet(record))) return false;
  if (!failed && !known) {
    const recovery = await readNativeMediaRecoverySummary(record);
    current(context);
    if (recovery.canResume || recovery.cachedOnly || recovery.resultCount || recovery.taskCount) return false;
  }
  // 仅清除失效等待，不交付产物；输入或参考已改不能让旧计时继续，交付路径仍须核验输入指纹。
  // 异步读取期间可能产生后续尝试；最终写回前再次核对原回执和节点运行所有权。
  const actual = await readAvailableNativeMediaTask(context.projectId, context.canvasId, operationId);
  current(context);
  if (!actual || actual.revision !== record.revision || actual.lease !== record.lease || actual.status !== record.status
    || options.isNodeBusy?.(actual.canvasId, actual.nodeId)
    || options.isCurrent?.() === false) return false;
  const state = useAppStore.getState(), node = state.nodes.find((item) => item.id === actual.nodeId);
  if (!node || node.type !== target.type || node.data !== target.data) return false;
  if (canShowRecovery) {
    options.showPausedProtocol?.(actual, context, completeLocalSet(actual));
    return true;
  }
  state.updateNodeDataTransient(actual.nodeId, { status: 'error',
    error: failed ? '原媒体任务已失败，可修改后重新生成。' : known ? '原任务已保留，旧回执缺少可验证的查询身份，请到对应平台核对。'
      : '提交结果未确认，已停止等待；请先到服务商核对，原任务已保留，应用不会自动重新生成。',
    mediaTaskState: failed || known ? undefined : 'submit_unknown', mediaTaskStage: undefined, videoTaskState: undefined });
  return true;
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

/** 默认只消费本机文件；远端查询必须由原画布协调器明确启用。 */
export function deliverNativeMediaCachedResult(operationId: string, context: CanvasContext, signal?: AbortSignal,
  isNodeBusy?: (canvasId: string, nodeId: string) => boolean, query?: 'ccc' | 'protocol-auto'): Promise<boolean> {
  const key = `${context.projectId}/${context.canvasId}/${context.runtimeEpoch}/${operationId}`;
  const existing = deliveries.get(key); if (existing) return existing;
  const externalSignal = signal, controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) controller.abort();
  signal = controller.signal;
  let unsubscribe = () => {};
  let committing: { artifactId: string; relativePath: string; rootRef?: string } | undefined;
  const work = (async () => {
    current(context, signal);
    let record = await readAvailableNativeMediaTask(context.projectId, context.canvasId, operationId, { signal });
    current(context, signal);
    if (!record || !sameCanvas(record, context) || !ACTIVE_NATIVE_MEDIA_STATES.includes(record.status)) return false;
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
      if (!useAppStore.getState().nodes.some((node) => node.id === targetId)) return false;
      const { assertNativeVideoSubmissionInput } = await import('./nativeVideoSubmission');
      current(context, signal);
      await assertNativeVideoSubmissionInput(record, context);
      current(context, signal);
    }
    if (record.status === 'outcome-unknown' || !completeLocalSet(record)) {
      const { retainNativeBuiltinImageCachedOutputs, retainNativeBuiltinImageOriginalTaskOutputs } = await import('./nativeBuiltinImageTask');
      let retained = await retainNativeBuiltinImageCachedOutputs(record, signal);
      current(context, signal);
      if (!retained && query === 'ccc') retained = await retainNativeBuiltinImageOriginalTaskOutputs(record, signal);
      current(context, signal);
      if (!retained && query === 'protocol-auto' && hasBoundProtocolTask(record)) {
        const { resumeNativeVolcengineTask } = await import('./nativeVolcengineRecovery');
        current(context, signal);
        useAppStore.getState().updateNodeDataTransient(record.nodeId, { status: 'loading', error: undefined,
          mediaTaskState: undefined, mediaTaskStage: 'querying', videoTaskState: undefined });
        await resumeNativeVolcengineTask(operationId, signal, {
          expectedSubmission: { lease: record.lease, revision: record.revision },
          // 画布就绪队列串行，短查避免生成中的任务长时间占住后续本机交付。
          maxQueryDurationMs: 15_000,
          beforeCanvasCommit: (ready, relativePath) => {
            committing = { artifactId: `native-media-${ready.operationId}`, relativePath, rootRef: ready.resultRootRef };
          },
        });
        return true;
      }
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
    existing.queryProtocol ??= options.queryProtocol;
    if (!options.nodeId) existing.nodes = null; else existing.nodes?.add(options.nodeId);
    return existing.promise;
  }
  const queue: DeliveryQueue = { repeat: false, nodes: options.nodeId ? new Set([options.nodeId]) : null,
    allowOriginalCccTaskQuery: options.allowOriginalCccTaskQuery === true, queryProtocol: options.queryProtocol, promise: Promise.resolve() };
  const controller = new AbortController();
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  const attemptedProtocols = new Set<string>();
  const projectStopped = (record: NativeMediaTaskRecord) => {
    const status = useAppStore.getState().nodes.find((node) => node.id === record.nodeId)?.data.status;
    return status === 'loading' || status === 'idle' && hasBoundProtocolTask(record)
      ? projectNativeMediaStoppedState(record.operationId, context, options).catch(() => false) : Promise.resolve(false);
  };
  queue.promise = (async () => {
    do {
      queue.repeat = false;
      const nodes = queue.nodes; queue.nodes = new Set();
      current(context, controller.signal);
      const records = await listNativeMediaTasks(context.projectId, { canvasId, statuses: autoDeliveryStates,
        nodeIds: nodes ?? undefined, signal: controller.signal });
      const originalQueries: NativeMediaTaskRecord[] = [];
      for (const record of records) {
        current(context, controller.signal);
        if (!sameCanvas(record, context) || nodes && !nodes.has(record.nodeId)
          || options.isNodeBusy?.(canvasId, record.nodeId)) continue;
        if (!ACTIVE_NATIVE_MEDIA_STATES.includes(record.status)) {
          if (record.status === 'failed') await projectStopped(record);
          continue;
        }
        // 优先全部本机缓存，慢的服务商查询不能挡住同画布已有结果。
        const delivered = await deliverNativeMediaCachedResult(record.operationId, context, controller.signal, options.isNodeBusy).catch(() => false);
        if (delivered) continue;
        if (record.recovery?.kind === 'general-protocol') {
          // 在同画布的其他查询结束前，已知任务也提供手动续查入口。
          await projectStopped(record);
          if (queue.queryProtocol && hasBoundProtocolTask(record) && !attemptedProtocols.has(record.operationId)) originalQueries.push(record);
        } else if (queue.allowOriginalCccTaskQuery && record.status === 'submitted' && record.remoteTaskId) originalQueries.push(record);
        else await projectStopped(record);
      }
      for (const [ordinal, query] of originalQueries.entries()) {
        current(context, controller.signal);
        if (queue.repeat) {
          // 先处理新就绪缓存，再继续未查询的原任务；不能被另一节点的释放事件丢掉。
          for (const remaining of originalQueries.slice(ordinal)) queue.nodes?.add(remaining.nodeId);
          break;
        }
        if (query.recovery?.kind === 'general-protocol') {
          if (options.isNodeBusy?.(canvasId, query.nodeId)) continue;
          attemptedProtocols.add(query.operationId);
          await queue.queryProtocol?.(query, context, controller.signal).catch(() => false);
        } else await deliverNativeMediaCachedResult(query.operationId, context, controller.signal, options.isNodeBusy, 'ccc').catch(() => false);
        await projectStopped(query);
      }
    } while (queue.repeat && !controller.signal.aborted);
  })().finally(() => { unsubscribe(); controller.abort(); if (queues.get(key) === queue) queues.delete(key); });
  queues.set(key, queue); return queue.promise;
}
