/** 固定图片接口与 Dreamina 的原任务回执；真实提交不重试，完整产物先冻结后交付。 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import type { MediaDownloadAccess } from '../types/aiTypes';
import type { NativeMediaLocalOutput, MediaKind } from '../types/media';
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { captureNativeVideoSubmissionBaseline, assertNativeVideoSubmissionInput, isNativeVideoSubmissionGuard } from './nativeVideoSubmission';
import { assertNativeMediaPrepared, assertNativeMediaResultRetention, prepareNativeMediaTask, claimNativeMediaRecovery, failNativeMediaTask,
  listNativeMediaTasks, recordNativeMediaSubmission, validateNativeMediaTaskRecord, normalizeNativeMediaProviderBase, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { EXCHANGE, REVISIONS, increment, openNativeProjectDatabase, transact, type NativeProjectOptions } from './indexedDb/nativeProjectRepository';
import { retainNativeMediaOutputs } from './indexedDb/nativeMediaCollectionRepository';
import { validateNativeMediaLocalOutputs } from './nativeMediaCollection';
import { captureNativeMediaLocalResult, readNativeMediaLocalResult } from './nativeMediaLocalResult';
import { persistMediaUrlToProjectData } from './fileService';
import { configValuesEqual } from './configPatch';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { sha256BytesHex } from './mediaDataUrl';
import { getHttpResponseError } from './ai/httpUtils';
import { pollResolvedModelProtocol } from './ai/modelProtocol';
import { createMediaDownloadAccess } from './ai/mediaDownloadAccess';
import { pollTask, PollTaskFailedError } from './pollTask';
import { isSafeNativeProtocolTaskId } from './nativeProtocolContext';

export type NativeBuiltinImageMode = 'standard' | 'protocol' | 'volcengine' | 'ccc' | 'dreamina';
const PREFIX = 'builtin-image-task:';
type Binding = Pick<NativeMediaTaskRecord, 'operationId' | 'ownerProjectId' | 'canvasId' | 'episodeId' | 'projectEpoch' | 'canvasEpoch' | 'nodeId' | 'category' | 'targetNodeType' | 'resultRootRef' | 'providerConfigId' | 'providerBase' | 'recovery'>;
interface Receipt { projectId: string; kind: 'native-builtin-image-v1'; binding: Binding; mode: NativeBuiltinImageMode;
  state: 'prepared' | 'unknown' | 'submitted' | 'inline' | 'failed'; revision: number;
  tasks: Array<{ taskId: string; state: 'submitted' | 'completed' | 'failed'; outputs?: NativeMediaLocalOutput[] }>;
  inlineOutputs?: NativeMediaLocalOutput[] }
const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const fail = (): never => { throw new Error('原图片任务或回执租约已变化，已保存文件保留，不会重新生成'); };
const taskId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const binding = (row: NativeMediaTaskRecord): Binding => ({ operationId: row.operationId, ownerProjectId: row.ownerProjectId, canvasId: row.canvasId,
  episodeId: row.episodeId, projectEpoch: row.projectEpoch, canvasEpoch: row.canvasEpoch, nodeId: row.nodeId,
  category: row.category, targetNodeType: row.targetNodeType, resultRootRef: row.resultRootRef, providerConfigId: row.providerConfigId, providerBase: row.providerBase, recovery: row.recovery });
function validate(receipt: Receipt, main: NativeMediaTaskRecord): Receipt {
  if (!receipt || receipt.kind !== 'native-builtin-image-v1' || receipt.projectId !== PREFIX + main.operationId
    || !configValuesEqual(receipt.binding, binding(main)) || !['standard', 'protocol', 'volcengine', 'ccc', 'dreamina'].includes(receipt.mode)
    || !['prepared', 'unknown', 'submitted', 'inline', 'failed'].includes(receipt.state) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 0
    || !Array.isArray(receipt.tasks) || receipt.tasks.length > 128
    || new Set(receipt.tasks.map((task) => task.taskId)).size !== receipt.tasks.length
    || receipt.tasks.some((task) => !task || !taskId(task.taskId) || !['submitted', 'completed', 'failed'].includes(task.state)
      || Object.keys(task).some((key) => !['taskId', 'state', 'outputs'].includes(key))
      || (task.state === 'completed' ? !task.outputs : task.outputs !== undefined))
    || Object.keys(receipt).some((key) => !['projectId', 'kind', 'binding', 'mode', 'state', 'revision', 'tasks', 'inlineOutputs'].includes(key))) return fail();
  for (const task of receipt.tasks) if (task.outputs) validateNativeMediaLocalOutputs(task.outputs);
  if (receipt.inlineOutputs) validateNativeMediaLocalOutputs(receipt.inlineOutputs);
  return receipt;
}
async function mutate(main: NativeMediaTaskRecord, work: (row: NativeMediaTaskRecord, receipt: Receipt) => void,
  options: NativeProjectOptions = {}): Promise<{ record: NativeMediaTaskRecord; receipt: Receipt }> {
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const store = tx.objectStore(EXCHANGE), current = await req(store.get(main.projectId)) as NativeMediaTaskRecord | undefined;
    if (!current || validateNativeMediaTaskRecord(current).lease !== main.lease) return fail();
    const raw = await req(store.get(PREFIX + main.operationId)) as Receipt | undefined; if (!raw) return fail();
    const receipt = validate(raw, current);
    work(current, receipt); current.revision = increment(current.revision); current.updatedAt = Date.now(); receipt.revision = increment(receipt.revision);
    validateNativeMediaTaskRecord(current); validate(receipt, current);
    const revision = await req(tx.objectStore(REVISIONS).get(main.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
    if (!revision && current.status !== 'reviewed' || revision && (revision.projectId !== main.ownerProjectId || !Number.isSafeInteger(revision.changeRevision) || revision.changeRevision < 0)) return fail();
    await Promise.all([req(store.put(current)), req(store.put(receipt)), ...(revision
      ? [req(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: increment(revision.changeRevision) }))] : [])]);
    return { record: current, receipt };
  }, [EXCHANGE, REVISIONS], true); } finally { db.close(); }
}
async function createReceipt(main: NativeMediaTaskRecord, mode: NativeBuiltinImageMode): Promise<void> {
  const db = await openNativeProjectDatabase(false, {}); if (!db) return fail();
  try { await transact(db, 'readwrite', {}, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const current = await req(tx.objectStore(EXCHANGE).get(main.projectId)) as NativeMediaTaskRecord | undefined;
    if (!current || validateNativeMediaTaskRecord(current).lease !== main.lease || current.status !== 'prepared') return fail();
    await req(tx.objectStore(EXCHANGE).add(validate({ projectId: PREFIX + main.operationId, kind: 'native-builtin-image-v1', binding: binding(main),
      mode, state: 'prepared', revision: 0, tasks: [] }, current)));
  }, [EXCHANGE], true); } finally { db.close(); }
}
async function readPair(projectId: string, operationId: string): Promise<{ record: NativeMediaTaskRecord; receipt: Receipt }> {
  const db = await openNativeProjectDatabase(false, {}); if (!db) return fail();
  try { return await transact(db, 'readonly', {}, async (tx) => {
    const main = await req(tx.objectStore(EXCHANGE).get(`media-task:${operationId}`)) as NativeMediaTaskRecord | undefined;
    const receipt = await req(tx.objectStore(EXCHANGE).get(PREFIX + operationId)) as Receipt | undefined;
    if (!main || !receipt || validateNativeMediaTaskRecord(main).ownerProjectId !== projectId) return fail();
    return { record: main, receipt: validate(receipt, main) };
  }, [EXCHANGE]); } finally { db.close(); }
}
export const nativeBuiltinImageDigest = (mode: NativeBuiltinImageMode, modelId: string) =>
  sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(['native-builtin-original-result-v1', mode, modelId])));
export const DREAMINA_NATIVE_BASE = 'http://dreamina.local';
const pending = (operationId: string, cause?: unknown, detail?: string): Error => {
  const error = new Error(`原媒体操作 ${operationId} 已保留，请继续原回执；提交未知不会重新生成。${detail ?? ''}`,
    cause === undefined ? undefined : { cause });
  error.name = 'NativeMediaTaskPending'; return error;
};
function delivered(operationId: string): never { const error = new Error('原媒体完整产物已保存并交付'); error.name = 'NativeMediaTaskDelivered'; Object.assign(error, { nativeOperationId: operationId }); throw error; }
async function saveOutputs(record: NativeMediaTaskRecord, urls: readonly string[], access?: MediaDownloadAccess): Promise<NativeMediaLocalOutput[]> {
  if (!urls.length || urls.length > 128 || urls.some((url) => typeof url !== 'string' || !url)) throw new Error('原作业未返回完整的有界产物集合');
  const outputs: NativeMediaLocalOutput[] = [];
  for (const url of urls) {
    const saved = await persistMediaUrlToProjectData(url, record.canvasId, `ai-${record.category}`, '原媒体产物', { mediaDownloadAccess: access });
    if (!saved.filePath) throw new Error('原媒体产物尚未完整保存');
    outputs.push({ ...await captureNativeMediaLocalResult(record.canvasId, saved.filePath), category: record.category });
  }
  return outputs;
}

export async function runNativeBuiltinImageTask(input: { nodeId?: string; mode: NativeBuiltinImageMode; modelId: string; modelRef?: string;
  connectionId: string; baseUrl: string; category?: 'image' | 'video'; expectedCount?: number; requestMaterial: unknown; signal?: AbortSignal;
  secrets?: readonly string[];
  beforeSubmit?: () => void | Promise<void>; mediaDownloadAccess?: MediaDownloadAccess;
  execute: (beforePost: () => Promise<void>, received: (taskIds: string[]) => Promise<void>) => Promise<{ urls?: string[]; taskIds?: string[] }> }): Promise<never> {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1 || !input.nodeId || !isNativeVideoSubmissionGuard(input.beforeSubmit)) throw new Error('原生媒体缺少实际提交守卫');
  const originalSecrets = [...(input.secrets ?? []), useAppStore.getState().config.providers[input.connectionId]?.apiKey ?? ''].filter(Boolean);
  await input.beforeSubmit?.(); input.signal?.throwIfAborted();
  const baseline = await captureNativeVideoSubmissionBaseline(context, input.nodeId, undefined, 'media-input-v3', { preparedReferences: true });
  const digest = await nativeBuiltinImageDigest(input.mode, input.modelId);
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: input.nodeId,
    providerConfigId: input.connectionId, providerBase: input.baseUrl, category: input.category ?? 'image',
    submissionKind: ['ccc', 'dreamina'].includes(input.mode) ? 'async' : 'sync', modelRef: input.modelRef ?? `${input.connectionId}/${input.modelId}`,
    fingerprintScheme: 'media-input-v3', requestFingerprint: await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken(input.requestMaterial))),
    protocolDigest: digest, inputFingerprint: baseline.inputFingerprint, sourceCanvasRevision: baseline.canvasRevision,
    recovery: { kind: input.category === 'video' ? 'builtin-video' : 'builtin-image', modelId: input.modelId, digest,
      ...(input.mode === 'dreamina' ? { serverId: 'dreamina-cli-v1' } : {}), ...(input.expectedCount ? { expectedCount: input.expectedCount } : {}) } });
  try { await createReceipt(record, input.mode); }
  catch (error) {
    await recordNativeMediaSubmission(record.operationId, record.lease, { notStarted: true }).catch(() => undefined);
    throw new Error(`原媒体操作 ${record.operationId} 未开始提交，回执已保留。`, { cause: error });
  }
  let sent = false;
  const received = async (ids: string[]) => {
    const taskIds = [...new Set(ids)];
    if (!taskIds.length || taskIds.length > 128 || taskIds.some((id) => !taskId(id)
      || !isSafeNativeProtocolTaskId(id, [...originalSecrets, useAppStore.getState().config.providers[input.connectionId]?.apiKey ?? '']))) return fail();
    ({ record } = await mutate(record, (main, receipt) => {
      if (receipt.tasks.length) { if (!configValuesEqual(receipt.tasks.map((task) => task.taskId), taskIds)) return fail(); return; }
      if (!['prepared', 'outcome-unknown', 'reviewed'].includes(main.status) || !['unknown', 'prepared'].includes(receipt.state)
        || !['ccc', 'dreamina'].includes(receipt.mode)) return fail();
      receipt.tasks = taskIds.map((id) => ({ taskId: id, state: 'submitted' })); receipt.state = 'submitted';
      main.remoteTaskId = taskIds[0]; main.submissionKind = 'async'; if (main.status !== 'reviewed') main.status = 'submitted';
    }));
  };
  try {
    const result = await input.execute(async () => {
      input.signal?.throwIfAborted(); await input.beforeSubmit?.(); await assertNativeMediaPrepared(record);
      await assertNativeVideoSubmissionInput(record, context);
      ({ record } = await mutate(record, (main, receipt) => { if (main.status !== 'prepared' || receipt.state !== 'prepared') return fail(); receipt.state = 'unknown'; }));
      await input.beforeSubmit?.(); await assertNativeVideoSubmissionInput(record, context); input.signal?.throwIfAborted(); sent = true;
    }, received);
    if (!sent) throw new Error('媒体适配器没有经过真实提交守卫，未接收该结果');
    if (result.taskIds?.length) {
      if (!record.remoteTaskId) await received(result.taskIds);
    } else {
      if (!result.urls?.length) throw new Error('原接口没有返回可确认的任务 ID 或完整结果');
      if (input.mode !== 'ccc') await assertNativeMediaResultRetention(record);
      const outputs = await saveOutputs(record, result.urls, input.mediaDownloadAccess);
      ({ record } = await mutate(record, (_main, receipt) => { receipt.inlineOutputs = outputs; receipt.state = 'inline'; }));
      record = await retainNativeMediaOutputs(record, outputs, input.mode === 'ccc' ? { inlineSubmission: true } : {});
    }
    if (input.signal?.aborted || !isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) {
      throw pending(record.operationId, new Error('原画布上下文或取消信号在交付前已变化'));
    }
    await resumeNativeBuiltinImageTask(record.operationId, input.signal);
    const completed = await readPair(record.ownerProjectId, record.operationId);
    if (completed.record.status === 'delivered') return delivered(record.operationId);
    throw pending(record.operationId, new Error('本机交付结束后回执仍未结算'));
  } catch (error) {
    if (error instanceof Error && ['NativeMediaTaskDelivered', 'NativeMediaTaskPending'].includes(error.name)) throw error;
    const terminal = await readPair(record.ownerProjectId, record.operationId).catch(() => undefined);
    if (terminal?.record.status === 'delivered') return delivered(record.operationId);
    if (terminal?.record.status === 'failed') throw error;
    ({ record } = await mutate(record, (main, receipt) => {
      if (main.status !== 'prepared' || main.remoteTaskId || main.localResults) return;
      const certain = !sent || getHttpResponseError(error)?.definitiveFailure === true;
      main.status = certain ? 'failed' : 'outcome-unknown'; receipt.state = certain ? 'failed' : 'unknown';
    }).catch(() => ({ record })));
    if (record.status === 'failed') throw error;
    const retained = !!(terminal?.receipt.inlineOutputs?.length || terminal?.record.localResults?.length || record.localResults?.length);
    throw pending(record.operationId, error, retained
      ? ' 产物已保存，请在「设置 → 恢复项目操作」输入此 ID 并点击「继续取回原媒体产物」回填节点。'
      : undefined);
  }
}

export async function resumeNativeBuiltinImageTask(operationId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) throw new Error('请打开原媒体画布');
  const externalSignal = signal, controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) controller.abort();
  signal = controller.signal;
  const unsubscribe = useAppStore.subscribe(() => { if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) controller.abort(); });
  try {
  let { record, receipt } = await readPair(context.projectId, operationId);
  if (record.canvasId !== context.canvasId || record.projectEpoch !== context.projectEpoch || record.canvasEpoch !== context.canvasEpoch || record.episodeId !== context.episodeId) return fail();
  if (record.status === 'delivered') { const { projectNativeMediaMessages } = await import('./nativeMediaMessages'); await projectNativeMediaMessages(); return; }
  if (!record.localResults && receipt.inlineOutputs) record = await retainNativeMediaOutputs(record, receipt.inlineOutputs, { inlineSubmission: true });
  if (!record.localResults) {
    if (!receipt.tasks.length) throw new Error('原同步调用没有已保存产物或原任务 ID，请核对原平台，不会重新生成');
    if (!record.recovery?.modelId || record.recovery.digest !== await nativeBuiltinImageDigest(receipt.mode, record.recovery.modelId)
      || record.protocolDigest !== record.recovery.digest || receipt.mode === 'dreamina' && record.providerBase !== DREAMINA_NATIVE_BASE) throw new Error('原媒体查询合同已变化，未向服务商发送任务 ID');
    record = await claimNativeMediaRecovery(operationId, context);
    const assertCurrent = () => { signal?.throwIfAborted(); if (!isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false })) throw new Error('原画布已切换，回执和产物保留'); };
    for (const original of receipt.tasks) {
      if (original.state === 'failed') continue;
      if (original.outputs) { for (const file of original.outputs) await readNativeMediaLocalResult(record.canvasId, file); continue; }
      assertCurrent();
      let urls: string[];
      try {
        if (receipt.mode === 'dreamina') {
          urls = await pollTask<{ status: string; outputs: Array<{ url: string; localPath: string }>; failReason: string }, string[]>({
            fetchState: () => invoke('dreamina_query_result', { submitId: original.taskId }),
            isComplete: (value) => value.status === 'success' && value.outputs.length ? value.outputs.map((file) => file.localPath ? convertFileSrc(file.localPath) : file.url) : null,
            isFailed: (value) => value.status === 'failed' ? '即梦已确认原任务失败' : null,
            interval: 3000, maxDuration: 60 * 60 * 1000, signal, onFetchError: 'throw',
          });
        } else if (receipt.mode === 'ccc') {
          const provider = useAppStore.getState().config.providers[record.providerConfigId];
          let baseUrl = provider?.baseUrl?.trim() || '';
          if (!baseUrl) { const { getProviderDefinition } = await import('./ai/providerCatalogService'); baseUrl = getProviderDefinition(record.providerConfigId, provider)?.defaultBaseUrl || ''; }
          if (!provider?.apiKey || normalizeNativeMediaProviderBase(baseUrl) !== record.providerBase) throw new Error('原 CCC 连接已变化，请恢复原连接后查询');
          const result = await pollResolvedModelProtocol({ method: 'GET', url: `${record.providerBase}/tasks/${encodeURIComponent(original.taskId)}`,
            auth: { type: 'bearer' }, statusPath: 'data.status', successValues: ['completed'], failureValues: ['failed'],
            resultUrlPath: 'data.result.images.*.url', intervalMs: 3000, maxDurationMs: 60 * 60 * 1000 }, provider.apiKey, signal, record.providerBase);
          if (!result.urls?.length) throw new Error('原 CCC 任务没有返回完整结果'); urls = result.urls;
        } else return fail();
      } catch (error) {
        if (!(error instanceof PollTaskFailedError)) throw error;
        ({ record, receipt } = await mutate(record, (_main, row) => { const task = row.tasks.find((item) => item.taskId === original.taskId); if (!task || task.state !== 'submitted') return fail(); task.state = 'failed'; })); continue;
      }
      assertCurrent();
      const access = receipt.mode === 'ccc' ? createMediaDownloadAccess(record.providerConfigId, record.providerBase, { type: 'bearer' }) : undefined;
      const outputs = await saveOutputs(record, urls, access);
      ({ record, receipt } = await mutate(record, (_main, row) => { const task = row.tasks.find((item) => item.taskId === original.taskId); if (!task || task.state !== 'submitted') return fail(); task.state = 'completed'; task.outputs = outputs; }));
    }
    const outputs = receipt.tasks.flatMap((task) => task.outputs ?? []);
    if (!outputs.length) { await failNativeMediaTask(record); throw new Error('原任务均已确认失败，回执保留'); }
    record = await retainNativeMediaOutputs(record, outputs, { completion: { taskCount: receipt.tasks.length,
      failedTasks: receipt.tasks.filter((task) => task.state === 'failed').length } });
  }
  const { resumeNativeVolcengineTask } = await import('./nativeVolcengineRecovery');
  await resumeNativeVolcengineTask(operationId, signal);
  } finally { unsubscribe(); externalSignal?.removeEventListener('abort', abort); controller.abort(); }
}

export async function listNativeBuiltinImageRetainedOutputs(projectId: string): Promise<Array<{ operationId: string; canvasId: string; relativePath: string; category: MediaKind; ordinal: number }>> {
  const records = await listNativeMediaTasks(projectId), result: Array<{ operationId: string; canvasId: string; relativePath: string; category: MediaKind; ordinal: number }> = [];
  for (const main of records.filter((row) => !row.apimartImageBatch && (row.recovery?.kind === 'builtin-image' || row.recovery?.serverId === 'dreamina-cli-v1'))) {
    const receipt = await readStoredReceipt(main); if (!receipt) continue;
    const outputs = receipt.inlineOutputs ?? receipt.tasks.flatMap((task) => task.outputs ?? []);
    outputs.forEach((file, ordinal) => result.push({ operationId: main.operationId, canvasId: main.canvasId, relativePath: file.relativePath, category: file.category, ordinal }));
  }
  return result;
}

async function readStoredReceipt(record: NativeMediaTaskRecord): Promise<Receipt | undefined> {
  const db = await openNativeProjectDatabase(false, {}); if (!db) return fail();
  try { return await transact(db, 'readonly', {}, async (tx) => {
    const row = await req(tx.objectStore(EXCHANGE).get(PREFIX + record.operationId)) as Receipt | undefined;
    if (!row && ['prepared', 'failed'].includes(record.status) && !record.remoteTaskId && !record.localResults) return undefined;
    if (!row) return fail(); return validate(row, record);
  }, [EXCHANGE]); } finally { db.close(); }
}
export async function readNativeBuiltinImageSummary(record: NativeMediaTaskRecord) {
  const recovery = record.recovery;
  if (record.apimartImageBatch || !recovery || recovery.kind !== 'builtin-image' && recovery.serverId !== 'dreamina-cli-v1') return undefined;
  const receipt = await readStoredReceipt(record);
  const tasks = receipt?.tasks ?? [], outputs = receipt?.inlineOutputs ?? tasks.flatMap((task) => task.outputs ?? []);
  const failedTasks = tasks.filter((task) => task.state === 'failed').length;
  const failedSubmissions = receipt?.state === 'failed' ? 1 : 0, unknownSubmissions = receipt?.state === 'unknown' ? 1 : 0;
  const notStartedSubmissions = !receipt || receipt.state === 'prepared' ? 1 : 0;
  const expectedCount = recovery.expectedCount ?? 1, resultCount = record.localResults?.length ?? outputs.length;
  return { kind: 'builtin-image' as const, taskCount: tasks.length, failedTasks, failedSubmissions, unknownSubmissions, notStartedSubmissions,
    expectedCount, resultCount, lateTaskCount: 0, pendingTasks: tasks.filter((task) => task.state === 'submitted').length,
    cachedOnly: !!record.localResults || !!receipt?.inlineOutputs || tasks.length > 0 && tasks.every((task) => task.state !== 'submitted') && resultCount > 0,
    partial: failedTasks > 0 || failedSubmissions > 0 || unknownSubmissions > 0 || notStartedSubmissions > 0 || resultCount < expectedCount };
}
