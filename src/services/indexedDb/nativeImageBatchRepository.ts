/** APIMart每个POST和每个原任务候选集合的耐久收据，不重新提交未知请求。 */
import type { NativeApimartImageBatch, NativeMediaLocalResult } from '../../types/media';
import { validateNativeMediaTaskRecord, type NativeMediaTaskRecord } from './nativeMediaTaskRepository';
import { nativeImageBatchResults, nativeImageBatchSettled } from '../nativeImageBatch';
import { configValuesEqual } from '../configPatch';
import { EXCHANGE, ROOTS, CANVASES, REVISIONS, TRANSFER, assertNoPendingNativeSharedSync, openNativeProjectDatabase, transact, type NativeProjectOptions } from './nativeProjectRepository';
import type { CanvasDocument, ProjectRecord } from '../../types/project';
const req = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const fail = (): never => { throw new Error('原图片批次或提交租约已变化，回执保留'); };
function parentStatus(batch: NativeApimartImageBatch): NativeMediaTaskRecord['status'] {
  if (batch.submissions.some((submission) => submission.state === 'unknown') && !batch.uncertainAcknowledged) return 'outcome-unknown';
  if (batch.submissions.some((submission) => submission.state === 'prepared')) return 'prepared';
  if (!batch.tasks.length || nativeImageBatchSettled(batch) && !batch.tasks.some((task) => task.state === 'completed')) return 'failed';
  return 'submitted';
}
async function change(record: NativeMediaTaskRecord, mutate: (current: NativeMediaTaskRecord) => void,
  options: NativeProjectOptions = {}, begin = false, allowDeliveredReceipt = false): Promise<NativeMediaTaskRecord> {
  const original = validateNativeMediaTaskRecord(structuredClone(record));
  if (!original.apimartImageBatch) return fail();
  const db = await openNativeProjectDatabase(false, options); if (!db) return fail();
  try { return await transact(db, 'readwrite', options, async (tx) => {
    if (tx.durability !== 'strict') return fail();
    const store = tx.objectStore(EXCHANGE), row = await req(store.get(original.projectId)) as NativeMediaTaskRecord | undefined;
    if (!row) return fail();
    const current = validateNativeMediaTaskRecord(row);
    if (!current.apimartImageBatch || current.operationId !== original.operationId || current.status === 'delivered' && !allowDeliveredReceipt || current.revision >= Number.MAX_SAFE_INTEGER) return fail();
    if (begin) {
      if (current.lease !== original.lease || current.revision !== original.revision || current.status !== 'prepared') return fail();
      await assertNoPendingNativeSharedSync(tx, current.ownerProjectId);
      const [project, canvas] = await Promise.all([req(tx.objectStore(ROOTS).get(current.ownerProjectId)) as Promise<ProjectRecord | undefined>,
        req(tx.objectStore(CANVASES).get(current.canvasId)) as Promise<CanvasDocument | undefined>]);
      if (!project || !canvas || project.epoch !== current.projectEpoch || canvas.epoch !== current.canvasEpoch
        || canvas.projectId !== current.ownerProjectId || canvas.episodeId !== current.episodeId) return fail();
    }
    const wasReviewed = current.status === 'reviewed';
    const wasDelivered = current.status === 'delivered';
    mutate(current);
    current.remoteTaskId = current.apimartImageBatch.tasks[0]?.taskId;
    current.status = wasDelivered ? 'delivered' : wasReviewed ? 'reviewed' : parentStatus(current.apimartImageBatch);
    current.revision++; current.updatedAt = Date.now(); validateNativeMediaTaskRecord(current);
    const revision = await req(tx.objectStore(REVISIONS).get(current.ownerProjectId)) as { projectId: string; changeRevision: number } | undefined;
    if (revision && (!Number.isSafeInteger(revision.changeRevision) || revision.changeRevision >= Number.MAX_SAFE_INTEGER) || begin && !revision) return fail();
    await req(store.put(current));
    if (revision) await req(tx.objectStore(REVISIONS).put({ ...revision, changeRevision: revision.changeRevision + 1 }));
    return current;
  }, [ROOTS, CANVASES, REVISIONS, TRANSFER, EXCHANGE], true); } finally { db.close(); }
}
/** 写前记录不确定状态后才能执行相应POST；重启后此槽位绝不重新发送。 */
export function beginNativeImageBatchSubmission(record: NativeMediaTaskRecord, submissionId: string, options: NativeProjectOptions = {}) {
  return change(record, (current) => {
    const submission = current.apimartImageBatch!.submissions.find((item) => item.id === submissionId);
    if (!submission || submission.state !== 'prepared') return fail();
    submission.state = 'unknown';
  }, options, true);
}
/** 子提交身份是原POST凭据；租约切换后仍允许记录迟到的原ID，但不能替换或重投。 */
export function retainNativeImageBatchSubmission(record: NativeMediaTaskRecord, submissionId: string,
  outcome: { taskIds: string[] } | { notStarted: true } | { failed: true }, options: NativeProjectOptions = {}) {
  return change(record, (current) => {
    const submission = current.apimartImageBatch!.submissions.find((item) => item.id === submissionId);
    if (!submission || !record.apimartImageBatch?.submissions.some((item) => item.id === submissionId)) return fail();
    if ('taskIds' in outcome) {
      const ids = [...new Set(outcome.taskIds)];
      if (!ids.length || ids.some((id) => !/^[A-Za-z0-9_-]{1,160}$/.test(id)) || ids.length > 128) return fail();
      if (current.status === 'delivered' && submission.state === 'unknown') {
        const old = current.lateImageTaskIds?.find((entry) => entry.submissionId === submissionId);
        if (old && !configValuesEqual(old.taskIds, ids)) return fail();
        if (!old) current.lateImageTaskIds = [...(current.lateImageTaskIds ?? []), { submissionId, taskIds: ids }];
        return; // 已交付候选的ordinal不改变；迟到ID只保留供独立核对，不跨任务追加写回。
      }
      if (submission.state === 'submitted') { if (!configValuesEqual(submission.taskIds, ids)) return fail(); return; }
      if (submission.state !== 'unknown') return fail();
      submission.state = 'submitted'; submission.taskIds = ids;
      const previous = new Map(current.apimartImageBatch!.tasks.map((task) => [task.taskId, task]));
      const allIds = [...new Set(current.apimartImageBatch!.submissions.flatMap((item) => item.taskIds))];
      current.apimartImageBatch!.tasks = allIds.map((taskId) => previous.get(taskId) ?? { taskId, state: 'submitted' as const });
    } else {
      if (current.status === 'delivered') return;
      if (!['prepared', 'unknown'].includes(submission.state)) return fail();
      submission.state = 'notStarted' in outcome ? 'not-started' : 'failed';
    }
  }, options, false, true);
}
export function sealNativeImageBatchSubmissions(record: NativeMediaTaskRecord, options: NativeProjectOptions = {}) {
  return change(record, (current) => { for (const submission of current.apimartImageBatch!.submissions) if (submission.state === 'prepared') submission.state = 'not-started'; }, options);
}
/** 每个task完整下载后一次提交候选集合；中断只重查该原task，不发生成POST。 */
export async function retainNativeImageBatchTask(record: NativeMediaTaskRecord, taskId: string,
  outcome: { results: NativeMediaLocalResult[] } | { failed: true }, options: NativeProjectOptions = {}) {
  if ('results' in outcome) {
    const { readNativeMediaLocalResult } = await import('../nativeMediaLocalResult');
    for (const result of outcome.results) await readNativeMediaLocalResult(record.canvasId, result);
  }
  return change(record, (current) => {
    if (current.lease !== record.lease || current.revision !== record.revision || current.status !== 'submitted') return fail();
    const task = current.apimartImageBatch!.tasks.find((item) => item.taskId === taskId);
    if (!task) return fail();
    if (task.state !== 'submitted') {
      if ('results' in outcome ? task.state !== 'completed' || !configValuesEqual(task.results, outcome.results) : task.state !== 'failed') return fail();
      return;
    }
    task.state = 'results' in outcome ? 'completed' : 'failed';
    if ('results' in outcome) task.results = structuredClone(outcome.results);
    // 通过总量验证与账本同事务发布；不得截断服务商实际返回的候选。
    nativeImageBatchResults(current);
  }, options);
}
