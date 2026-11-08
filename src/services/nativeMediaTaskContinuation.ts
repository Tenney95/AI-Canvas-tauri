/** 正常生成也沿原回执继续查询／交付；中断只保留原操作，不要求用户每次手动恢复。 */
import { listNativeMediaTasks, type NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';

export async function continueNativeMediaTask(record: NativeMediaTaskRecord, signal?: AbortSignal): Promise<never> {
  let failure: unknown;
  try { const { resumeNativeVolcengineTask } = await import('./nativeVolcengineRecovery'); await resumeNativeVolcengineTask(record.operationId, signal); }
  catch (error) { failure = error; }
  const current = (await listNativeMediaTasks(record.ownerProjectId)).find((row) => row.operationId === record.operationId);
  if (current?.status === 'failed') {
    const error = new Error('服务商已确认原媒体任务失败，回执已保留', failure ? { cause: failure } : undefined);
    error.name = 'NativeMediaTaskFailed'; throw error;
  }
  const delivered = current?.status === 'delivered';
  const error = new Error(delivered ? `原媒体已保存并交付（${record.operationId}）` : `原媒体操作已保留（${record.operationId}），请续查原任务，不要重新生成。`,
    failure ? { cause: failure } : undefined);
  error.name = delivered ? 'NativeMediaTaskDelivered' : 'NativeMediaTaskPending';
  Object.assign(error, { nativeOperationId: record.operationId }); throw error;
}
