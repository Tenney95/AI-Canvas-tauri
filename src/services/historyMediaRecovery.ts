/** 输出历史只关联已生成的原任务；恢复不从错误文本或媒体地址重建请求。 */
import type { OutputHistoryEntry } from '../types';
import type { MediaTaskReceipt } from '../types/aiTypes';
import type { PendingTask } from './pollManager';

export function sameHistoryMediaTask(a: MediaTaskReceipt | undefined, b: MediaTaskReceipt | undefined): boolean {
  return !!a && !!b && a.projectId === b.projectId && a.nodeId === b.nodeId
    && a.taskId === b.taskId && a.attemptId === b.attemptId;
}

export function historyMediaTaskReceipt(task: PendingTask): MediaTaskReceipt {
  return { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId };
}

export function isHistoryMediaDownloadPending(task: PendingTask): boolean {
  return task.submitted && !!task.taskId && !task.terminalFailure && !task.mediaSubmissionUncertain
    && !task.runninghubSubmissionUncertain && task.runninghubRecoveryState !== 'cancel_pending'
    && task.runninghubRecoveryState !== 'submit_unknown'
    && task.comfyRecoveryState !== 'cancel_pending' && task.workflowApi?.state !== 'submit_unknown'
    && task.mediaRecoveryState !== 'submit_unknown' && (task.runninghubRecoveryState === 'save_pending'
      || task.comfyRecoveryState === 'save_pending' || task.workflowApi?.state === 'save_pending'
      || task.mediaRecoveryState === 'delivery_pending');
}

/** 旧失败记录没有回执时只能提示去原节点处理，不能按模型名猜测任务。 */
export function isHistoryMediaDownloadFailure(error: unknown): boolean {
  return error instanceof Error && (error.name === 'MediaPersistenceError'
    || error.message.startsWith('生成媒体未能写入项目目录：'));
}

export function isUnresolvedHistoryDownload(entry: OutputHistoryEntry): boolean {
  return entry.status === 'download_pending' || (entry.status === 'error'
    && !!entry.error?.startsWith('生成媒体未能写入项目目录：'));
}
