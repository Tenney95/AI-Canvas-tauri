/** 恢复展示只读数量和阶段；既有视频 v1、媒体 v2 与新 v3 分别兼容。 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { describeNativeEditorRecovery, describeNativeMediaRecovery, readNativeMediaRecoverySummary } from '../../src/services/nativeMediaRecoverySummary';
const readers = vi.hoisted(() => ({ image: vi.fn(), workflow: vi.fn(), music: vi.fn() }));
vi.mock('../../src/services/nativeBuiltinImageTask', () => ({ readNativeBuiltinImageSummary: readers.image }));
vi.mock('../../src/services/nativeWorkflowRepository', () => ({ readNativeWorkflowSummary: readers.workflow }));
vi.mock('../../src/services/indexedDb/nativeApimartMusicRepository', () => ({ readNativeApimartMusicState: readers.music }));
beforeEach(() => { readers.image.mockReset(); readers.workflow.mockReset(); readers.music.mockReset(); });
const uuid = '11111111-1111-4111-8111-111111111111';
const file = { relativePath: `media/${'a'.repeat(64)}.png`, bytes: 12, sha256: 'a'.repeat(64), category: 'image' as const };
function record(patch: Partial<NativeMediaTaskRecord> = {}): NativeMediaTaskRecord {
  return { projectId: `media-task:${uuid}`, kind: 'native-media-task-v1', operationId: uuid, ownerProjectId: `p2-${uuid}`,
    canvasId: `c2-${uuid}`, episodeId: null, projectEpoch: 1, canvasEpoch: 1, sourceCanvasRevision: 0, nodeId: 'original-node',
    inputFingerprint: 'b'.repeat(64), fingerprintScheme: 'media-input-v3', requestFingerprint: 'c'.repeat(64),
    providerConfigId: 'original-provider', providerBase: 'https://private.example', modelRef: 'general/original-model', protocolDigest: 'd'.repeat(64),
    category: 'image', status: 'submitted', remoteTaskId: 'original-task', lease: uuid, revision: 0, createdAt: 1, updatedAt: 1, ...patch };
}
it('v3完整缓存可离线交付，同时保留原计划和冻结部分失败计数，摘要不含路径或站点', () => {
  const summary = describeNativeMediaRecovery(record({ localResults: [file, file], resultRelativePath: file.relativePath,
    recovery: { kind: 'general-protocol', expectedCount: 4 }, completion: { taskCount: 2, failedTasks: 1, failedSubmissions: 1, unknownSubmissions: 2, notStartedSubmissions: 3 } }));
  expect(summary).toMatchObject({ resultCount: 2, expectedCount: 4, canResume: true, cachedOnly: true, partial: true,
    failedTasks: 1, failedSubmissions: 1, unknownSubmissions: 2, notStartedSubmissions: 3, recoveryAction: 'deliver_local_results' });
  const text = JSON.stringify(summary);
  expect(text).not.toContain('media/'); expect(text).not.toContain('https://'); expect(text).not.toContain(file.sha256); expect(text).not.toContain('providerBase');
});
it('多POST prepared已有原ID时可seal余槽续取，已核对unknown不阻断后续缓存恢复', () => {
  const original = record({ status: 'prepared', recovery: { kind: 'workflow', workflowId: 'workflow' } });
  expect(describeNativeMediaRecovery(original, { workflow: { taskCount: 1, completedTasks: 1, resultCount: 3, notStartedSubmissions: 1, partial: true } }))
    .toMatchObject({ kind: 'workflow', canResume: true, cachedOnly: true, partial: true });
  const known = { taskCount: 1, completedTasks: 1, resultCount: 3, unknownSubmissions: 1, uncertainAcknowledged: true };
  expect(describeNativeMediaRecovery({ ...original, status: 'submitted' }, { workflow: known })).toMatchObject({ canResume: true, cachedOnly: true, partial: true });
  expect(describeNativeMediaRecovery({ ...original, status: 'outcome-unknown' }, { workflow: { ...known, uncertainAcknowledged: false } }))
    .toMatchObject({ canResume: false, needsReview: true });
});
it('APIMart专用批次即使有builtin-image标识，也不读取另一类sidecar', async () => {
  const batch = record({ providerConfigId: 'apimart', recovery: { kind: 'builtin-image' }, apimartImageBatch: { version: 1, requestedCount: 1,
    submissions: [{ id: uuid, state: 'submitted', taskIds: ['original-task'] }], tasks: [{ taskId: 'original-task', state: 'completed', results: [{ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 }] }] } });
  expect(await readNativeMediaRecoverySummary(batch)).toMatchObject({ kind: 'image-batch', resultCount: 1, cachedOnly: true, canResume: true });
  expect(readers.image).not.toHaveBeenCalled();
});
it('歌词已提交而音乐未发是正常阶段，纯查询不承担下一次付费提交', () => {
  const original = record({ category: 'audio', status: 'prepared', remoteTaskId: undefined, recovery: { kind: 'builtin-audio', modelId: 'flowmusic' } });
  const music = { lyrics: { submissionId: uuid, state: 'submitted' as const, taskId: 'original-lyrics' },
    music: { submissionId: uuid, state: 'prepared' as const } };
  const summary = describeNativeMediaRecovery(original, { music });
  expect(summary).toMatchObject({ kind: 'audio-stages', currentStage: 'lyrics', unknownSubmissions: 0, needsReview: false,
    canResume: false, canContinueGenerationStage: true, maySubmitUnstartedStage: true, recoveryAction: 'continue_original_generation_stage' });
  expect(describeNativeMediaRecovery({ ...original, status: 'reviewed' }, { music })).toMatchObject({ canResume: false, canContinueGenerationStage: false });
});
it('已提交音乐阶段可按原ID恢复；unknown不授予继续生成权，结束跟踪后不首发后续阶段', () => {
  const original = record({ category: 'audio', status: 'reviewed', recovery: { kind: 'builtin-audio' } });
  const music = { lyrics: { submissionId: uuid, state: 'not-needed' as const }, music: { submissionId: uuid, state: 'submitted' as const, taskId: 'original-music' } };
  expect(describeNativeMediaRecovery(original, { music })).toMatchObject({ canResume: true, canContinueGenerationStage: false, maySubmitUnstartedStage: false });
  expect(describeNativeMediaRecovery({ ...original, status: 'outcome-unknown' }, { music: { ...music, music: { submissionId: uuid, state: 'unknown' } } }))
    .toMatchObject({ canResume: false, canContinueGenerationStage: false, needsReview: true, unknownSubmissions: 1 });
});
it('Dreamina视频识别共享sidecar；恢复证据缺失时明确只供核对，不假报可恢复', async () => {
  const original = record({ category: 'video', recovery: { kind: 'builtin-video', serverId: 'dreamina-cli-v1' } });
  readers.image.mockResolvedValue({ taskCount: 1, resultCount: 2, expectedCount: 2, cachedOnly: true });
  expect(await readNativeMediaRecoverySummary(original)).toMatchObject({ kind: 'builtin-image', resultCount: 2, cachedOnly: true, canResume: true });
  readers.image.mockRejectedValue(new Error('opaque private path must not leak'));
  const blocked = await readNativeMediaRecoverySummary(original);
  expect(blocked).toMatchObject({ inspectionIncomplete: true, canResume: false, needsReview: true });
  expect(JSON.stringify(blocked)).not.toContain('opaque');
  expect(await readNativeMediaRecoverySummary({ ...original, localResults: [file] }))
    .toMatchObject({ inspectionIncomplete: true, canResume: true, cachedOnly: true, recoveryAction: 'deliver_local_results' });
});
it('剪辑完成保留原任务总数和失败数量，多产物不能掩盖另一个原任务失败', () => {
  const summary = describeNativeEditorRecovery({ status: 'delivered', remoteTaskId: 'original-task', localResults: [file, file],
    completion: { taskCount: 2, failedTasks: 1 } });
  expect(summary).toMatchObject({ resultCount: 2, taskCount: 2, expectedCount: 2, failedTasks: 1, partial: true,
    canResume: false, canContinueGenerationStage: false, recoveryAction: 'project_completed_result' });
  expect(JSON.stringify(summary)).not.toContain('original-task'); expect(JSON.stringify(summary)).not.toContain(file.relativePath);
});
