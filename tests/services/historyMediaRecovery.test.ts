import { describe, expect, it } from 'vitest';
import type { OutputHistoryEntry } from '../../src/types';
import type { PendingTask } from '../../src/services/pollManager';
import { historyMediaTaskReceipt, isHistoryMediaDownloadFailure, isHistoryMediaDownloadPending,
  isUnresolvedHistoryDownload, sameHistoryMediaTask } from '../../src/services/historyMediaRecovery';

const task: PendingTask = { projectId: 'p', nodeId: 'n', taskId: '123', attemptId: 'attempt', submitted: true,
  provider: 'runninghubwf', nodeType: 'ai-image', taskType: 'runninghub-workflow', runninghubRecoveryState: 'save_pending' };

describe('输出历史的原任务下载身份', () => {
  it('只认已生成且身份确定的待保存任务，不把提交未知、取消和终态失败变成可下载', () => {
    expect(isHistoryMediaDownloadPending(task)).toBe(true);
    for (const patch of [{ taskId: '' }, { submitted: false }, { terminalFailure: true as const },
      { mediaSubmissionUncertain: true }, { runninghubSubmissionUncertain: true },
      { runninghubRecoveryState: 'cancel_pending' as const }, { runninghubRecoveryState: 'submit_unknown' as const },
      { runninghubRecoveryState: 'disconnected' as const }]) expect(isHistoryMediaDownloadPending({ ...task, ...patch })).toBe(false);
    expect(isHistoryMediaDownloadPending({ ...task, taskType: 'comfyui', runninghubRecoveryState: undefined, comfyRecoveryState: 'save_pending' })).toBe(true);
    expect(isHistoryMediaDownloadPending({ ...task, taskType: 'general', runninghubRecoveryState: undefined, mediaRecoveryState: 'delivery_pending' })).toBe(true);
  });
  it('回执只有身份；项目、节点、任务和尝试任一变化都不能操作原历史的下载', () => {
    const receipt = historyMediaTaskReceipt({ ...task, resultUrls: ['https://cdn.test/temporary?signature=private'] });
    expect(Object.keys(receipt).sort()).toEqual(['attemptId', 'nodeId', 'projectId', 'taskId']);
    expect(sameHistoryMediaTask(receipt, receipt)).toBe(true);
    for (const key of ['projectId', 'nodeId', 'taskId', 'attemptId'] as const) expect(sameHistoryMediaTask(receipt, { ...receipt, [key]: 'other' })).toBe(false);
    expect(sameHistoryMediaTask(undefined, receipt)).toBe(false);
  });
  it('区分保存失败和生成失败；旧记录只提示，不能凭文案重建回执', () => {
    const failure = new Error('生成媒体未能写入项目目录：下载媒体失败');
    expect(isHistoryMediaDownloadFailure(failure)).toBe(true);
    expect(isHistoryMediaDownloadFailure(new Error('模型拒绝请求'))).toBe(false);
    const entry = { status: 'error', error: failure.message } as OutputHistoryEntry;
    expect(isUnresolvedHistoryDownload(entry)).toBe(true); expect(entry.recoveryTask).toBeUndefined();
    expect(isUnresolvedHistoryDownload({ ...entry, error: '模型拒绝请求' })).toBe(false);
    expect(isUnresolvedHistoryDownload({ ...entry, status: 'abandoned' })).toBe(false);
  });
});
