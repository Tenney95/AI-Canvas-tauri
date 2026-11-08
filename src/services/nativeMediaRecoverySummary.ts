/** 恢复入口只公开阶段和数量；不传播文件、URL、请求、歌词、凭据或运行时对象。 */
import type { NativeMediaTaskRecord } from './indexedDb/nativeMediaTaskRepository';
import type { NativeApimartMusicState } from './indexedDb/nativeApimartMusicRepository';
import type { NativeEditorMediaTask } from './indexedDb/nativeEditorMediaTaskRepository';
import { nativeImageBatchSummary, nativeImageBatchSettled } from './nativeImageBatch';

interface RecoveryCounts {
  resultCount?: number; candidateCount?: number; expectedCount?: number; requestedCount?: number; taskCount?: number;
  completedTasks?: number; failedTasks?: number; failedSubmissions?: number; unknownSubmissions?: number;
  notStartedSubmissions?: number; lateTaskCount?: number; partial?: boolean; cachedOnly?: boolean;
  uncertainAcknowledged?: boolean;
}
export interface NativeMediaRecoveryDetails {
  workflow?: RecoveryCounts; image?: RecoveryCounts; music?: Pick<NativeApimartMusicState, 'lyrics' | 'music'>;
  inspectionIncomplete?: boolean;
}
export interface NativeMediaRecoverySummary {
  kind: 'single' | 'image-batch' | 'workflow' | 'builtin-image' | 'audio-stages';
  resultCount: number; expectedCount: number; taskCount: number; failedTasks: number; failedSubmissions: number;
  unknownSubmissions: number; notStartedSubmissions: number; lateTaskCount: number; partial: boolean;
  canResume: boolean; canContinueGenerationStage: boolean; needsReview: boolean; reviewable: boolean; cachedOnly: boolean;
  recoveryAction: 'project_completed_result' | 'deliver_local_results' | 'query_original_tasks' | 'continue_original_generation_stage' | 'manual_review_only';
  currentStage?: 'lyrics' | 'music'; stageStates?: { lyrics: string; music: string }; maySubmitUnstartedStage: boolean;
  inspectionIncomplete?: true;
}
const count = (value: number | undefined, fallback = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

/** 剪辑回执不投影为画布媒体任务；仅复用安全数量与展示合同。 */
export function describeNativeEditorRecovery(record: Pick<NativeEditorMediaTask, 'status' | 'localResults' | 'resultPath' | 'remoteTaskId' | 'completion'>): NativeMediaRecoverySummary {
  const resultCount = record.localResults?.length ?? (record.resultPath ? 1 : 0);
  const taskCount = count(record.completion?.taskCount, record.remoteTaskId ? 1 : 0);
  const failedTasks = count(record.completion?.failedTasks, record.status === 'failed' ? 1 : 0);
  const unknownSubmissions = ['prepared', 'outcome-unknown'].includes(record.status) && !record.remoteTaskId && !resultCount ? 1 : 0;
  const canResume = record.status === 'submitted' && (!!record.remoteTaskId || resultCount > 0);
  return { kind: 'single', resultCount, taskCount, expectedCount: taskCount || 1, failedTasks, failedSubmissions: 0,
    unknownSubmissions, notStartedSubmissions: 0, lateTaskCount: 0, partial: failedTasks > 0 || resultCount > 0 && resultCount < taskCount,
    canResume, canContinueGenerationStage: false, needsReview: unknownSubmissions > 0,
    reviewable: ['prepared', 'submitted', 'outcome-unknown'].includes(record.status), cachedOnly: resultCount > 0,
    recoveryAction: record.status === 'delivered' ? 'project_completed_result' : canResume ? resultCount ? 'deliver_local_results' : 'query_original_tasks' : 'manual_review_only',
    maySubmitUnstartedStage: false };
}

export function describeNativeMediaRecovery(record: NativeMediaTaskRecord, details: NativeMediaRecoveryDetails = {}): NativeMediaRecoverySummary {
  const batch = nativeImageBatchSummary(record);
  const localCount = record.localResults?.length ?? (record.localResult ? 1 : 0);
  const summary: NativeMediaRecoverySummary = {
    kind: batch ? 'image-batch' : details.workflow ? 'workflow' : details.image ? 'builtin-image' : details.music ? 'audio-stages' : 'single',
    resultCount: localCount, expectedCount: count(record.recovery?.expectedCount, 1), taskCount: count(record.completion?.taskCount, record.remoteTaskId ? 1 : 0),
    failedTasks: count(record.completion?.failedTasks, record.status === 'failed' ? 1 : 0), failedSubmissions: count(record.completion?.failedSubmissions),
    unknownSubmissions: count(record.completion?.unknownSubmissions, ['prepared', 'outcome-unknown'].includes(record.status) && !localCount ? 1 : 0),
    notStartedSubmissions: count(record.completion?.notStartedSubmissions), lateTaskCount: 0, partial: false, canResume: false, canContinueGenerationStage: false, needsReview: false,
    reviewable: ['prepared', 'submitted', 'outcome-unknown'].includes(record.status), cachedOnly: localCount > 0,
    recoveryAction: 'manual_review_only', maySubmitUnstartedStage: false,
  };
  const counters: RecoveryCounts | undefined = batch ? { ...batch, resultCount: batch.candidateCount, expectedCount: batch.requestedCount } : details.workflow ?? details.image;
  if (counters) {
    summary.resultCount = localCount || count(counters.resultCount ?? counters.candidateCount);
    summary.expectedCount = count(counters.expectedCount ?? counters.requestedCount, summary.expectedCount);
    for (const key of ['taskCount', 'failedTasks', 'failedSubmissions', 'unknownSubmissions', 'notStartedSubmissions', 'lateTaskCount'] as const) summary[key] = count(counters[key]);
    summary.cachedOnly ||= !!counters.cachedOnly;
    if (batch && record.apimartImageBatch) summary.cachedOnly ||= nativeImageBatchSettled(record.apimartImageBatch) && batch.candidateCount > 0;
    if (details.workflow) summary.cachedOnly ||= summary.resultCount > 0 && summary.taskCount > 0
      && count(counters.completedTasks) + summary.failedTasks === summary.taskCount
      && (!summary.unknownSubmissions || record.status === 'reviewed' || counters.uncertainAcknowledged === true);
  }
  const supported = !!record.recovery || !!record.modelRef || ['volcengine', 'apimart', 'grsai', 'comfyui'].includes(record.providerConfigId);
  const versioned = record.category === 'video' || ['media-input-v2', 'media-input-v3'].includes(record.fingerprintScheme ?? '');
  const existing = ['submitted', 'reviewed'].includes(record.status) && !!record.remoteTaskId;
  summary.canResume = supported && versioned && (record.status === 'delivered' ? !!record.origin
    : record.status !== 'failed' && (summary.cachedOnly || existing
      || record.status === 'prepared' && !!record.remoteTaskId && (!!record.apimartImageBatch || record.recovery?.kind === 'workflow') && !summary.unknownSubmissions));
  if (details.music) {
    const stages = [details.music.lyrics, details.music.music];
    summary.currentStage = ['completed', 'not-needed'].includes(details.music.lyrics.state) ? 'music' : 'lyrics';
    summary.stageStates = { lyrics: details.music.lyrics.state, music: details.music.music.state };
    summary.taskCount = stages.filter((stage) => !!stage.taskId).length;
    summary.failedTasks = stages.filter((stage) => stage.state === 'failed' && !!stage.taskId).length;
    summary.failedSubmissions = stages.filter((stage) => stage.state === 'failed' && !stage.taskId).length;
    summary.unknownSubmissions = stages.filter((stage) => stage.state === 'unknown').length;
    summary.notStartedSubmissions = stages.filter((stage) => ['prepared', 'not-started'].includes(stage.state)).length;
    summary.maySubmitUnstartedStage = summary.notStartedSubmissions > 0 && !localCount && record.status !== 'reviewed' && record.status !== 'delivered';
    const terminal = record.status === 'failed' || summary.failedTasks > 0 || summary.failedSubmissions > 0;
    const finalStageKnown = ['submitted', 'completed'].includes(details.music.music.state) && !!details.music.music.taskId;
    const canContinue = record.status === 'delivered' ? !!record.origin : summary.cachedOnly || (record.status === 'reviewed' ? finalStageKnown : true);
    summary.canResume = supported && versioned && !terminal && !summary.unknownSubmissions
      && canContinue;
  } else summary.maySubmitUnstartedStage = false;
  // 未知子提交要先由用户核对；工作流/图片的 reviewed 仅授予原task集合的显式续取。
  const acknowledged = record.status === 'reviewed' || record.status === 'delivered'
    || record.apimartImageBatch?.uncertainAcknowledged === true || details.workflow?.uncertainAcknowledged === true;
  if (summary.unknownSubmissions && !acknowledged && !localCount) summary.canResume = false;
  if (summary.maySubmitUnstartedStage) {
    summary.canContinueGenerationStage = summary.canResume && !summary.unknownSubmissions && record.status !== 'reviewed';
    summary.canResume = false;
  }
  summary.needsReview = summary.unknownSubmissions > 0;
  summary.partial = counters?.partial === true || summary.failedTasks > 0 || summary.failedSubmissions > 0 || summary.unknownSubmissions > 0 || summary.lateTaskCount > 0
    || summary.resultCount > 0 && summary.resultCount < summary.expectedCount
    || record.status === 'delivered' && summary.notStartedSubmissions > 0;
  if (details.inspectionIncomplete) {
    // main 中的完整耐久产物集合已是独立交付凭据；sidecar 损坏不要求联网或重发。
    summary.inspectionIncomplete = true; summary.canResume &&= localCount > 0; summary.needsReview = true;
    summary.canContinueGenerationStage = false;
    summary.maySubmitUnstartedStage = false;
  }
  summary.recoveryAction = record.status === 'delivered' ? 'project_completed_result'
    : summary.canContinueGenerationStage ? 'continue_original_generation_stage'
    : summary.canResume ? summary.cachedOnly ? 'deliver_local_results' : 'query_original_tasks' : 'manual_review_only';
  return summary;
}

export async function readNativeMediaRecoverySummary(record: NativeMediaTaskRecord): Promise<NativeMediaRecoverySummary> {
  try {
    if (record.apimartImageBatch) return describeNativeMediaRecovery(record);
    if (record.recovery?.kind === 'workflow') {
      const { readNativeWorkflowSummary } = await import('./nativeWorkflowRepository');
      return describeNativeMediaRecovery(record, { workflow: await readNativeWorkflowSummary(record) });
    }
    if (record.recovery?.kind === 'builtin-image' || record.recovery?.serverId === 'dreamina-cli-v1') {
      const { readNativeBuiltinImageSummary } = await import('./nativeBuiltinImageTask');
      return describeNativeMediaRecovery(record, { image: await readNativeBuiltinImageSummary(record) });
    }
    if (record.recovery?.kind === 'builtin-audio' && record.submissionKind !== 'sync') {
      const { readNativeApimartMusicState } = await import('./indexedDb/nativeApimartMusicRepository');
      return describeNativeMediaRecovery(record, { music: await readNativeApimartMusicState(record) });
    }
    return describeNativeMediaRecovery(record);
  } catch {
    return describeNativeMediaRecovery(record, { inspectionIncomplete: true });
  }
}
