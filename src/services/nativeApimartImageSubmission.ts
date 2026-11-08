/** APIMart图片每个POST先写前意图；完成后只续查原任务集合。 */
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import { prepareNativeMediaTask, assertNativeMediaPrepared, listNativeMediaTasks } from './indexedDb/nativeMediaTaskRepository';
import { beginNativeImageBatchSubmission, retainNativeImageBatchSubmission, sealNativeImageBatchSubmissions } from './indexedDb/nativeImageBatchRepository';
import { captureNativeVideoSubmissionBaseline, assertNativeVideoSubmissionInput, isNativeVideoSubmissionGuard } from './nativeVideoSubmission';
import { captureLegacyCanvasContext } from './projectExecutionContext';
import { useAppStore } from '../store/useAppStore';
import { sha256BytesHex } from './mediaDataUrl';
import { projectModelSourceToken } from './projectModelComparisonMaterial';
import { getHttpResponseError } from './ai/httpUtils';
import { APIMART_IMAGE_BATCH_PROTOCOL } from './nativeImageBatch';

export async function submitNativeApimartImageBatch(input: { baseUrl: string; model: string; requestedCount: number;
  nodeId?: string; imageUrls: readonly string[]; bodies: readonly Record<string, unknown>[]; requestHeaders?: Record<string, string>;
  signal?: AbortSignal; beforeSubmit?: () => void | Promise<void>;
  submit: (body: Record<string, unknown>, signal: AbortSignal | undefined, submissionId: string) => Promise<string[]> }): Promise<never> {
  if (!input.nodeId || !isNativeVideoSubmissionGuard(input.beforeSubmit) || input.imageUrls.length) throw new Error('新项目图片批次只接受原入口冻结的无引用输入，未提交请求');
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1 || !input.bodies.length || input.bodies.length > 32) throw new Error('图片批次缺少原画布身份');
  const bodies = structuredClone(input.bodies);
  await input.beforeSubmit?.(); input.signal?.throwIfAborted();
  const baseline = await captureNativeVideoSubmissionBaseline(context, input.nodeId, undefined, 'media-input-v2');
  const protocolDigest = await sha256BytesHex(new TextEncoder().encode(APIMART_IMAGE_BATCH_PROTOCOL));
  const requestFingerprint = await sha256BytesHex(new TextEncoder().encode(projectModelSourceToken([input.model, bodies, input.requestHeaders])));
  let record: NativeMediaTaskRecord = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: input.nodeId,
    providerConfigId: 'apimart', providerBase: input.baseUrl, category: 'image', submissionKind: 'async',
    modelRef: `apimart/${input.model.replace(/^apimart\//, '')}`, protocolDigest, requestFingerprint, fingerprintScheme: 'media-input-v2',
    inputFingerprint: baseline.inputFingerprint, sourceCanvasRevision: baseline.canvasRevision,
    apimartImageBatch: { version: 1, requestedCount: input.requestedCount,
      submissions: bodies.map(() => ({ id: crypto.randomUUID(), state: 'prepared', taskIds: [] })), tasks: [] } });
  let firstError: unknown;
  for (const [index, body] of bodies.entries()) {
    const submissionId = record.apimartImageBatch!.submissions[index].id;
    let requestSent = false;
    try {
      input.signal?.throwIfAborted(); await input.beforeSubmit?.();
      await assertNativeVideoSubmissionInput(record, context); await assertNativeMediaPrepared(record);
      record = await beginNativeImageBatchSubmission(record, submissionId);
      input.signal?.throwIfAborted(); await input.beforeSubmit?.(); await assertNativeVideoSubmissionInput(record, context);
      input.signal?.throwIfAborted(); requestSent = true;
      const taskIds = await input.submit(body, input.signal, submissionId);
      record = await retainNativeImageBatchSubmission(record, submissionId, { taskIds });
    } catch (error) {
      firstError = error;
      if (!requestSent || getHttpResponseError(error)?.definitiveFailure === true) {
        record = await retainNativeImageBatchSubmission(record, submissionId, requestSent ? { failed: true } : { notStarted: true }).catch(() => record);
      }
      break;
    }
  }
  record = await sealNativeImageBatchSubmissions(record).catch(() => record);
  if (!record.apimartImageBatch?.tasks.length && record.status === 'failed') throw firstError ?? new Error('图片批次未提交成功，原回执保留');
  if (record.status === 'submitted') {
    let recoveryError: unknown;
    try { const { resumeNativeApimartImageBatch } = await import('./nativeApimartImageRecovery'); await resumeNativeApimartImageBatch(record.operationId, input.signal); }
    catch (error) { recoveryError = error; }
    let settled: NativeMediaTaskRecord | undefined;
    try { settled = (await listNativeMediaTasks(record.ownerProjectId)).find((row) => row.operationId === record.operationId); }
    catch (error) { recoveryError ??= error; }
    if (settled?.status === 'delivered') {
      const delivered = new Error(`原图片候选已完整保存并交付（${record.operationId}）`);
      delivered.name = 'NativeMediaTaskDelivered'; Object.assign(delivered, { nativeOperationId: record.operationId }); throw delivered;
    }
    if (settled?.status === 'failed') throw recoveryError ?? new Error('原图片任务均已确认失败，原回执保留');
    firstError = recoveryError ?? firstError;
  }
  const pending = new Error(`图片批次原操作 ${record.operationId} 已保留，请在存储健康继续查询全部原任务；未知提交不会自动重投。`);
  if (firstError instanceof Error) pending.message += ` ${firstError.message}`;
  pending.name = 'NativeMediaTaskPending'; Object.assign(pending, { nativeOperationId: record.operationId }); throw pending;
}
