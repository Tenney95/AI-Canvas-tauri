/** APIMart图片批次只保存原回执及完整本机候选，不保存提示词、凭据或远端URL。 */
import type { NativeApimartImageBatch, NativeMediaLocalResult } from '../types/media';
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { safeExchangePath } from './projectExchangeDomain';
import { isNativeMediaContentPath } from './nativeMediaContentPath';
export const APIMART_IMAGE_BATCH_PROTOCOL = 'apimart-image-batch-v1';
export const MAX_NATIVE_IMAGE_BATCH_RESULTS = 128;
export function validNativeImageBatchFile(file: NativeMediaLocalResult): boolean {
  return !!file && Object.keys(file).every((key) => ['relativePath', 'bytes', 'sha256'].includes(key))
    && Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)
    && safeExchangePath(file.relativePath) === file.relativePath && isNativeMediaContentPath(file.relativePath, file.sha256);
}
export function validateNativeImageBatch(batch: NativeApimartImageBatch): void {
  const bad = () => { throw new Error('图片批次回执损坏，不能自动继续或重投'); };
  if (!batch || batch.version !== 1 || !Number.isSafeInteger(batch.requestedCount) || batch.requestedCount < 1 || batch.requestedCount > 32
    || Object.keys(batch).some((key) => !['version', 'requestedCount', 'submissions', 'tasks', 'uncertainAcknowledged'].includes(key))
    || batch.uncertainAcknowledged !== undefined && batch.uncertainAcknowledged !== true
    || !Array.isArray(batch.submissions) || !batch.submissions.length || batch.submissions.length > 32 || !Array.isArray(batch.tasks) || batch.tasks.length > 128) return bad();
  const tokens = new Set<string>(), remoteIds: string[] = [];
  for (const submission of batch.submissions) {
    if (!submission || Object.keys(submission).some((key) => !['id', 'state', 'taskIds'].includes(key))
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(submission.id) || tokens.has(submission.id)
      || !['prepared', 'unknown', 'submitted', 'not-started', 'failed'].includes(submission.state)
      || !Array.isArray(submission.taskIds) || submission.taskIds.length > 128
      || (submission.state === 'submitted' ? !submission.taskIds.length : !!submission.taskIds.length)) return bad();
    tokens.add(submission.id);
    for (const id of submission.taskIds) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return bad();
      if (!remoteIds.includes(id)) remoteIds.push(id);
    }
  }
  if (remoteIds.length !== batch.tasks.length || batch.tasks.some((task, index) => !task || task.taskId !== remoteIds[index]
    || Object.keys(task).some((key) => !['taskId', 'state', 'results'].includes(key)) || !['submitted', 'completed', 'failed'].includes(task.state)
    || (task.state === 'completed' ? !Array.isArray(task.results) || !task.results.length || task.results.length > MAX_NATIVE_IMAGE_BATCH_RESULTS
      || task.results.some((file) => !validNativeImageBatchFile(file)) : task.results !== undefined))) return bad();
  if (batch.tasks.reduce((total, task) => total + (task.results?.length ?? 0), 0) > MAX_NATIVE_IMAGE_BATCH_RESULTS) return bad();
}
export function nativeImageBatchResults(record: Pick<NativeMediaTaskRecord, 'apimartImageBatch'>): NativeMediaLocalResult[] {
  if (!record.apimartImageBatch) return [];
  validateNativeImageBatch(record.apimartImageBatch);
  return record.apimartImageBatch.tasks.flatMap((task) => task.results ?? []).map((file) => ({ ...file }));
}
export function nativeImageBatchSettled(batch: NativeApimartImageBatch): boolean {
  validateNativeImageBatch(batch);
  return batch.tasks.length > 0 && batch.tasks.every((task) => task.state !== 'submitted')
    && batch.submissions.every((submission) => ['submitted', 'failed', 'not-started'].includes(submission.state)
      || submission.state === 'unknown' && batch.uncertainAcknowledged === true);
}
export function nativeImageBatchSummary(record: Pick<NativeMediaTaskRecord, 'apimartImageBatch' | 'lateImageTaskIds'>) {
  const batch = record.apimartImageBatch;
  if (!batch) return undefined;
  validateNativeImageBatch(batch);
  const candidateCount = nativeImageBatchResults(record).length;
  const failedTasks = batch.tasks.filter((task) => task.state === 'failed').length;
  const failedSubmissions = batch.submissions.filter((submission) => submission.state === 'failed').length;
  const unknownSubmissions = batch.submissions.filter((submission) => submission.state === 'unknown').length;
  const notStartedSubmissions = batch.submissions.filter((submission) => ['prepared', 'not-started'].includes(submission.state)).length;
  const lateTaskCount = record.lateImageTaskIds?.reduce((total, entry) => total + entry.taskIds.length, 0) ?? 0;
  return { requestedCount: batch.requestedCount, candidateCount, taskCount: batch.tasks.length, failedTasks, failedSubmissions, unknownSubmissions, notStartedSubmissions,
    lateTaskCount, partial: failedTasks > 0 || failedSubmissions > 0 || unknownSubmissions > 0 || notStartedSubmissions > 0 || lateTaskCount > 0 || candidateCount < batch.requestedCount };
}
