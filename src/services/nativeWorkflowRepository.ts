/** 工作流子提交与原任务的耐久收据。只保留身份、摘要和本机产物，不保留生成请求或媒体地址。 */
import type { CanvasContext } from '../types/project';
import type { NativeMediaLocalOutput, MediaKind } from '../types/media';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { validateNativeMediaTaskRecord, normalizeNativeMediaProviderBase } from './indexedDb/nativeMediaTaskRepository';
import { assertNoPendingNativeSharedSync, EXCHANGE, ROOTS, CANVASES, EPISODES, REVISIONS, TRANSFER, openNativeProjectDatabase,
  readCanvasTarget, transact, increment, type NativeProjectOptions } from './indexedDb/nativeProjectRepository';
import { validateNativeMediaLocalOutputs } from './nativeMediaCollection';
import { configValuesEqual } from './configPatch';
import { validateNativeProtocolContext } from './nativeModelProtocolTask';

export type NativeWorkflowAdapter = 'runninghub-workflow' | 'runninghub-model' | 'workflow-api' | 'comfyui';
export interface NativeWorkflowDescriptor {
  adapter: NativeWorkflowAdapter; connectionId: string; providerBase: string; category: MediaKind; digest: string;
  workflowId?: string; modelId?: string; serverId?: string; outputNodeIds?: string[];
}
export interface NativeWorkflowTask {
  taskId: string; state: 'submitted' | 'failed' | 'completed'; outputs?: NativeMediaLocalOutput[];
  recoveryContext?: Record<string, unknown>;
}
export interface NativeWorkflowReceipt {
  projectId: string; kind: 'native-workflow-v1'; operationId: string; ownerProjectId: string; canvasId: string;
  episodeId: string | null; projectEpoch: number; canvasEpoch: number; nodeId: string; descriptor: NativeWorkflowDescriptor;
  submissions: Array<{ id: string; state: 'prepared' | 'unknown' | 'submitted' | 'completed' | 'failed' | 'not-started'; taskIds: string[] }>;
  tasks: NativeWorkflowTask[]; revision: number; uncertainAcknowledged?: true;
  syncOutputs?: NativeMediaLocalOutput[];
  lateTaskIds?: Array<{ submissionId: string; taskId: string }>;
}
const PREFIX = 'workflow-task:';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const fail = (): never => { throw new Error('原工作流回执或租约已变化，已保存材料保留，不会重新提交生成'); };
const req = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function fields(value: unknown, allowed: readonly string[]): boolean {
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

export function validateNativeWorkflowReceipt(value: NativeWorkflowReceipt): NativeWorkflowReceipt {
  if (!fields(value, ['projectId', 'kind', 'operationId', 'ownerProjectId', 'canvasId', 'episodeId', 'projectEpoch', 'canvasEpoch', 'nodeId', 'descriptor',
    'submissions', 'tasks', 'revision', 'uncertainAcknowledged', 'lateTaskIds', 'syncOutputs'])) return fail();
  const descriptor = value?.descriptor;
  if (!value || value.kind !== 'native-workflow-v1' || !UUID.test(value.operationId) || value.projectId !== PREFIX + value.operationId
    || !bounded(value.ownerProjectId) || !bounded(value.canvasId) || !bounded(value.nodeId) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.projectEpoch) || value.projectEpoch < 0 || !Number.isSafeInteger(value.canvasEpoch) || value.canvasEpoch < 0
    || !(value.episodeId === null || bounded(value.episodeId)) || value.uncertainAcknowledged !== undefined && value.uncertainAcknowledged !== true
    || !fields(descriptor, ['adapter', 'connectionId', 'providerBase', 'category', 'digest', 'workflowId', 'modelId', 'serverId', 'outputNodeIds'])
    || !['runninghub-workflow', 'runninghub-model', 'workflow-api', 'comfyui'].includes(descriptor.adapter)
    || !bounded(descriptor.connectionId) || normalizeNativeMediaProviderBase(descriptor.providerBase) !== descriptor.providerBase
    || !['image', 'video', 'audio'].includes(descriptor.category) || !/^[a-f0-9]{64}$/.test(descriptor.digest)
    || [descriptor.workflowId, descriptor.modelId, descriptor.serverId].some((item) => item !== undefined && !bounded(item))
    || descriptor.outputNodeIds !== undefined && (!Array.isArray(descriptor.outputNodeIds) || descriptor.outputNodeIds.length > 128 || descriptor.outputNodeIds.some((item) => !bounded(item)))
    || !Array.isArray(value.submissions) || !value.submissions.length || value.submissions.length > 32 || !Array.isArray(value.tasks) || value.tasks.length > 128) return fail();
  const ids = new Set<string>(), taskIds: string[] = [];
  for (const slot of value.submissions) {
    if (!fields(slot, ['id', 'state', 'taskIds']) || !UUID.test(slot.id) || ids.has(slot.id) || !['prepared', 'unknown', 'submitted', 'completed', 'failed', 'not-started'].includes(slot.state)
      || !Array.isArray(slot.taskIds) || slot.taskIds.length > 128 || (slot.state === 'submitted' ? !slot.taskIds.length : !!slot.taskIds.length)) return fail();
    ids.add(slot.id);
    for (const id of slot.taskIds) { if (!bounded(id)) return fail(); if (!taskIds.includes(id)) taskIds.push(id); }
  }
  if (value.tasks.length !== taskIds.length || value.tasks.some((task, index) => !fields(task, ['taskId', 'state', 'outputs', 'recoveryContext']) || task.taskId !== taskIds[index]
    || !['submitted', 'completed', 'failed'].includes(task.state) || task.state !== 'completed' && task.outputs !== undefined)) return fail();
  for (const task of value.tasks) if (task.state === 'completed') validateNativeMediaLocalOutputs(task.outputs!);
  for (const task of value.tasks) if (task.recoveryContext) validateNativeProtocolContext(task.recoveryContext);
  if (value.syncOutputs) validateNativeMediaLocalOutputs(value.syncOutputs);
  if (value.lateTaskIds !== undefined && (!Array.isArray(value.lateTaskIds) || value.lateTaskIds.length > 128 || value.lateTaskIds.some((item) =>
    !fields(item, ['submissionId', 'taskId']) || !UUID.test(item.submissionId) || !bounded(item.taskId)
      || !value.submissions.some((slot) => slot.id === item.submissionId)))) return fail();
  if (value.tasks.reduce((count, task) => count + (task.outputs?.length ?? 0), 0) > 128) return fail();
  return value;
}
function belongs(receipt: NativeWorkflowReceipt, main: NativeMediaTaskRecord): boolean {
  return receipt.operationId === main.operationId && receipt.ownerProjectId === main.ownerProjectId && receipt.canvasId === main.canvasId
    && receipt.episodeId === main.episodeId && receipt.projectEpoch === main.projectEpoch && receipt.canvasEpoch === main.canvasEpoch
    && receipt.nodeId === main.nodeId && receipt.descriptor.digest === main.recovery?.digest && main.recovery?.kind === 'workflow'
    && receipt.descriptor.connectionId === main.providerConfigId && receipt.descriptor.providerBase === main.providerBase
    && receipt.descriptor.category === main.category && receipt.descriptor.workflowId === main.recovery.workflowId
    && receipt.descriptor.modelId === main.recovery.modelId && receipt.descriptor.serverId === main.recovery.serverId;
}
export async function createNativeWorkflowReceipt(main: NativeMediaTaskRecord, descriptor: NativeWorkflowDescriptor, count: number,
  options: NativeProjectOptions = {}): Promise<NativeWorkflowReceipt> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) return fail();
  const receipt = validateNativeWorkflowReceipt({ projectId: PREFIX + main.operationId, kind: 'native-workflow-v1', operationId: main.operationId,
    ownerProjectId: main.ownerProjectId, canvasId: main.canvasId, episodeId: main.episodeId, projectEpoch: main.projectEpoch, canvasEpoch: main.canvasEpoch,
    nodeId: main.nodeId, descriptor: structuredClone(descriptor), submissions: Array.from({ length: count }, () => ({ id: crypto.randomUUID(), state: 'prepared', taskIds: [] })), tasks: [], revision: 0 });
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const row = await req(tx.objectStore(EXCHANGE).get(main.projectId)) as NativeMediaTaskRecord | undefined;
    if (!row || row.lease !== main.lease || row.revision !== main.revision || row.status !== 'prepared' || !belongs(receipt, row)) return fail();
    const revision = await req(tx.objectStore(REVISIONS).get(main.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
    if (!revision) return fail();
    await Promise.all([req(tx.objectStore(EXCHANGE).add(receipt)), req(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: increment(revision.changeRevision) }))]); return receipt;
  }, [EXCHANGE, REVISIONS], true); } finally { db.close(); }
}
export async function readNativeWorkflowReceipt(operationId: string, options: NativeProjectOptions = {}): Promise<NativeWorkflowReceipt | undefined> {
  if (!UUID.test(operationId)) return fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return;
  try { return await transact(db, 'readonly', options, async (tx) => {
    const value = await req(tx.objectStore(EXCHANGE).get(PREFIX + operationId)) as NativeWorkflowReceipt | undefined;
    return value && validateNativeWorkflowReceipt(value);
  }, [EXCHANGE]); } finally { db.close(); }
}
export function nativeWorkflowSummary(receipt: NativeWorkflowReceipt) {
  validateNativeWorkflowReceipt(receipt);
  const failedTasks = receipt.tasks.filter((task) => task.state === 'failed').length;
  const failedSubmissions = receipt.submissions.filter((slot) => slot.state === 'failed').length;
  const unknownSubmissions = receipt.submissions.filter((slot) => slot.state === 'unknown').length;
  const notStartedSubmissions = receipt.submissions.filter((slot) => ['prepared', 'not-started'].includes(slot.state)).length;
  const resultCount = (receipt.syncOutputs?.length ?? 0) + receipt.tasks.reduce((count, task) => count + (task.outputs?.length ?? 0), 0);
  return { submissionCount: receipt.submissions.length, expectedCount: receipt.submissions.length, taskCount: receipt.tasks.length, completedTasks: receipt.tasks.filter((task) => task.state === 'completed').length, resultCount,
    failedTasks, failedSubmissions, unknownSubmissions, notStartedSubmissions, lateTaskCount: receipt.lateTaskIds?.length ?? 0,
    uncertainAcknowledged: receipt.uncertainAcknowledged === true,
    partial: failedTasks > 0 || failedSubmissions > 0 || unknownSubmissions > 0 || notStartedSubmissions > 0 };
}
export async function readNativeWorkflowSummary(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}) {
  if (record.recovery?.kind !== 'workflow') return undefined;
  const receipt = await readNativeWorkflowReceipt(record.operationId, options);
  if (!receipt || !belongs(receipt, record)) return fail();
  return nativeWorkflowSummary(receipt);
}
async function change(main: NativeMediaTaskRecord, mutate: (receipt: NativeWorkflowReceipt, current: NativeMediaTaskRecord, tx: IDBTransaction) => Promise<void> | void,
  options: NativeProjectOptions = {}, late = false): Promise<{ record: NativeMediaTaskRecord; receipt: NativeWorkflowReceipt }> {
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const store = tx.objectStore(EXCHANGE);
    const [row, value] = await Promise.all([req(store.get(main.projectId)) as Promise<NativeMediaTaskRecord | undefined>,
      req(store.get(PREFIX + main.operationId)) as Promise<NativeWorkflowReceipt | undefined>]);
    if (!row || !value) return fail();
    const current = validateNativeMediaTaskRecord(row), receipt = validateNativeWorkflowReceipt(value);
    if (!belongs(receipt, current) || !late && (current.lease !== main.lease || current.revision !== main.revision)) return fail();
    await mutate(receipt, current, tx);
    receipt.revision = increment(receipt.revision); current.revision = increment(current.revision); current.updatedAt = Date.now();
    validateNativeWorkflowReceipt(receipt); validateNativeMediaTaskRecord(current);
    const revision = await req(tx.objectStore(REVISIONS).get(current.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
    if (!revision && !late) return fail();
    await Promise.all([req(store.put(receipt)), req(store.put(current)), ...(revision
      ? [req(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: increment(revision.changeRevision) }))] : [])]); return { record: current, receipt };
  }, [EXCHANGE, ROOTS, CANVASES, EPISODES, REVISIONS, TRANSFER], true); } finally { db.close(); }
}
function parentStatus(receipt: NativeWorkflowReceipt): NativeMediaTaskRecord['status'] {
  if (receipt.submissions.some((slot) => slot.state === 'unknown') && !receipt.uncertainAcknowledged) return 'outcome-unknown';
  if (receipt.submissions.some((slot) => slot.state === 'prepared')) return 'prepared';
  if (receipt.syncOutputs) return 'outcome-unknown'; // 同步集合由公共retainer原子授予submitted。
  if (!receipt.tasks.length || receipt.tasks.every((task) => task.state === 'failed')) return 'failed';
  return 'submitted';
}
export function beginNativeWorkflowSubmission(main: NativeMediaTaskRecord, slotId: string, options: NativeProjectOptions = {}) {
  return change(main, async (receipt, current, tx) => {
    if (!['prepared', 'submitted'].includes(current.status)) return fail();
    await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
    const { project, canvas } = await readCanvasTarget(tx, current.ownerProjectId, current.canvasId);
    if (project.epoch !== current.projectEpoch || canvas.epoch !== current.canvasEpoch || canvas.episodeId !== current.episodeId) return fail();
    const slot = receipt.submissions.find((item) => item.id === slotId);
    if (!slot || slot.state !== 'prepared' || receipt.submissions.some((item) => item.state === 'unknown')) return fail();
    slot.state = 'unknown'; current.status = 'outcome-unknown';
  }, options);
}
export function retainNativeWorkflowSubmission(main: NativeMediaTaskRecord, slotId: string,
  result: { taskId: string; recoveryContext?: Record<string, unknown> } | { failed: true } | { notStarted: true }, options: NativeProjectOptions = {}) {
  return change(main, (receipt, current) => {
    const slot = receipt.submissions.find((item) => item.id === slotId); if (!slot || !main.recovery || !UUID.test(slotId)) return fail();
    if ('taskId' in result) {
      if (!bounded(result.taskId)) return fail();
      if (current.status === 'delivered' || current.lease !== main.lease) {
        if (slot.state === 'submitted' && slot.taskIds.includes(result.taskId)) return;
        if (slot.state !== 'unknown') return fail();
        if (!receipt.lateTaskIds?.some((item) => item.submissionId === slotId && item.taskId === result.taskId)) receipt.lateTaskIds = [...(receipt.lateTaskIds ?? []), { submissionId: slotId, taskId: result.taskId }];
        return;
      }
      if (slot.state === 'submitted') { if (!configValuesEqual(slot.taskIds, [result.taskId])) return fail(); return; }
      if (slot.state !== 'unknown') return fail();
      slot.state = 'submitted'; slot.taskIds = [result.taskId];
      const previous = new Map(receipt.tasks.map((task) => [task.taskId, task]));
      receipt.tasks = [...new Set(receipt.submissions.flatMap((item) => item.taskIds))].map((taskId) => previous.get(taskId)
        ?? { taskId, state: 'submitted', ...(result.recoveryContext ? { recoveryContext: structuredClone(result.recoveryContext) } : {}) });
      current.remoteTaskId ??= receipt.tasks[0].taskId;
    } else {
      if (current.lease !== main.lease || !['prepared', 'unknown'].includes(slot.state)) return fail();
      slot.state = 'failed' in result ? 'failed' : 'not-started';
    }
    if (!['reviewed', 'delivered'].includes(current.status)) current.status = parentStatus(receipt);
  }, options, 'taskId' in result);
}
export function sealNativeWorkflowSubmissions(main: NativeMediaTaskRecord, context: CanvasContext, options: NativeProjectOptions = {}) {
  return change(main, async (receipt, current, tx) => {
    if (current.canvasId !== context.canvasId || current.ownerProjectId !== context.projectId || current.projectEpoch !== context.projectEpoch
      || current.canvasEpoch !== context.canvasEpoch || current.episodeId !== context.episodeId || current.status === 'delivered') return fail();
    for (const slot of receipt.submissions) if (slot.state === 'prepared') slot.state = 'not-started';
    if (current.status === 'reviewed') {
      receipt.uncertainAcknowledged = true;
      if (receipt.syncOutputs) {
        const rows = await req(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound('media-task:', 'media-task:\uffff'))) as NativeMediaTaskRecord[];
        if (rows.length > 100_000 || rows.map(validateNativeMediaTaskRecord).some((row) => row.operationId !== current.operationId
          && row.ownerProjectId === current.ownerProjectId && row.canvasId === current.canvasId
          && (row.nodeId === current.nodeId || !!current.origin && row.origin?.messageId === current.origin.messageId
            && row.origin.conversationId === current.origin.conversationId))) return fail();
        current.status = 'outcome-unknown'; // 仅恢复已存在的原同步文件；后续公共retainer仍验证文件与持久scope。
      }
    }
    else current.status = parentStatus(receipt);
  }, options);
}
export async function retainNativeWorkflowTaskOutputs(main: NativeMediaTaskRecord, taskId: string,
  result: { outputs: NativeMediaLocalOutput[] } | { failed: true }, options: NativeProjectOptions = {}) {
  if ('outputs' in result) {
    validateNativeMediaLocalOutputs(result.outputs);
    const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
    for (const output of result.outputs) await readNativeMediaLocalResult(main.canvasId, output);
  }
  return change(main, (receipt, current) => {
    if (current.status !== 'submitted') return fail();
    const task = receipt.tasks.find((item) => item.taskId === taskId); if (!task) return fail();
    if (task.state !== 'submitted') {
      if ('outputs' in result ? task.state !== 'completed' || !configValuesEqual(task.outputs, result.outputs) : task.state !== 'failed') return fail();
      return;
    }
    if ('outputs' in result) { validateNativeMediaLocalOutputs(result.outputs); task.outputs = structuredClone(result.outputs); task.state = 'completed'; }
    else task.state = 'failed';
    current.status = parentStatus(receipt);
  }, options);
}
export async function retainNativeWorkflowSyncOutputs(main: NativeMediaTaskRecord, slotId: string, outputs: NativeMediaLocalOutput[], options: NativeProjectOptions = {}) {
  validateNativeMediaLocalOutputs(outputs);
  const { readNativeMediaLocalResult } = await import('./nativeMediaLocalResult');
  for (const output of outputs) await readNativeMediaLocalResult(main.canvasId, output);
  return change(main, (receipt, current) => {
    if (current.submissionKind !== 'sync' || !['outcome-unknown', 'reviewed'].includes(current.status)) return fail();
    const slot = receipt.submissions.find((item) => item.id === slotId);
    if (!slot || !['unknown', 'completed'].includes(slot.state)) return fail();
    validateNativeMediaLocalOutputs(outputs);
    if (receipt.syncOutputs && !configValuesEqual(receipt.syncOutputs, outputs)) return fail();
    receipt.syncOutputs = structuredClone(outputs); slot.state = 'completed';
  }, options, true);
}
export async function listNativeWorkflowRetainedOutputs(projectId: string, options: NativeProjectOptions = {}) {
  const db = await openNativeProjectDatabase(false, options); if (!db) return [];
  try { return await transact(db, 'readonly', options, async (tx) => {
    const rows = await req(tx.objectStore(EXCHANGE).getAll(IDBKeyRange.bound(PREFIX, PREFIX + '\uffff'))) as NativeWorkflowReceipt[];
    if (rows.length > 100_000) return fail();
    return rows.map(validateNativeWorkflowReceipt).filter((row) => row.ownerProjectId === projectId).flatMap((row) =>
      [...(row.syncOutputs ?? []), ...row.tasks.flatMap((task) => task.outputs ?? [])].map((output, ordinal) => ({ ...output,
        operationId: row.operationId, canvasId: row.canvasId, ordinal })));
  }, [EXCHANGE]); } finally { db.close(); }
}
