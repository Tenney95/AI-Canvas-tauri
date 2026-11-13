/** 正常生成也沿原回执继续查询／交付；中断只保留原操作，不要求用户每次手动恢复。 */
import { listNativeMediaTasks, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';

/** 操作身份留给内部回执，用户无需复制 ID 或进入设置才能显示本机结果。 */
export function createNativeMediaPendingError(record: NativeMediaTaskRecord, cause?: unknown): Error {
  const localResultAvailable = !!(record.localResults?.length || record.localResult);
  const error = new Error(localResultAvailable
    ? record.origin?.deliveryMode === 'chat' ? '媒体已保存，返回原对话后会自动继续显示。' : '媒体已保存，返回原画布后会自动继续显示。'
    : '媒体任务已保留，暂未取得可安全显示的结果。', cause === undefined ? undefined : { cause });
  error.name = 'NativeMediaTaskPending';
  Object.assign(error, { nativeOperationId: record.operationId, localResultAvailable,
    remoteTaskKnown: record.status === 'submitted' && !!record.remoteTaskId });
  return error;
}

export async function continueNativeMediaTask(record: NativeMediaTaskRecord, signal?: AbortSignal): Promise<never> {
  let failure: unknown;
  try { const { resumeNativeVolcengineTask } = await import('./nativeVolcengineRecovery'); await resumeNativeVolcengineTask(record.operationId, signal); }
  catch (error) { failure = error; }
  const current = (await listNativeMediaTasks(record.ownerProjectId)).find((row) => row.operationId === record.operationId);
  if (current?.status === 'failed') {
    const error = new Error('服务商已确认原媒体任务失败，回执已保留', failure ? { cause: failure } : undefined);
    error.name = 'NativeMediaTaskFailed'; throw error;
  }
  if (current?.status !== 'delivered') throw createNativeMediaPendingError(current ?? record, failure);
  const error = new Error('媒体已保存并完成显示。');
  error.name = 'NativeMediaTaskDelivered';
  Object.assign(error, { nativeOperationId: record.operationId }); throw error;
}
