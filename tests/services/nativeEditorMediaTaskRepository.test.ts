/** 转场使用独立 fake IndexedDB；不调用模型和原生文件端口。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { VideoEditorProjectRecord } from '../../src/types/videoEditor';
import { createNativeProject, readNativeProjectCapture } from '../../src/services/indexedDb/nativeProjectRepository';
import { readNativeVideoEditorProject, writeNativeVideoEditorProject } from '../../src/services/indexedDb/nativeVideoEditorRepository';
import { assertNativeEditorMediaPrepared, claimNativeEditorMediaTask, commitNativeEditorMediaResult,
  listNativeEditorMediaTasks, prepareNativeEditorMediaTask, recordNativeEditorMediaSubmission } from '../../src/services/indexedDb/nativeEditorMediaTaskRepository';
import { retainNativeEditorMediaOutput, reviewNativeEditorMediaTask } from '../../src/services/indexedDb/nativeEditorMediaTaskRepository';
import { retainNativeEditorMediaOutputs, listNativeEditorMediaArtifactsForProject } from '../../src/services/indexedDb/nativeEditorMediaTaskRepository';
const content = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: content.read }));

const projectId = 'p2-11111111-1111-4111-8111-111111111111', canvasId = 'c2-22222222-2222-4222-8222-222222222222';
const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId, projectEpoch: 1,
  canvasId, canvasEpoch: 1, episodeId: null, canvasRevision: 0, runtimeEpoch: 'current-process' };
const original = (): VideoEditorProjectRecord => ({ id: `${canvasId}::node`, projectId: canvasId, nodeId: 'node', schemaVersion: 1,
  name: '剪辑', createdAt: 1, updatedAt: 1, tracks: [{ id: 'track', name: '主轨', kind: 'video', clips: ['first', 'second'].map((id, index) => ({
    id, kind: 'video', fileName: `${id}.mp4`, relativePath: `media/${id}.mp4`, timelineStart: index, sourceIn: 0, sourceOut: 1 })) }] });
let factory: IDBFactory;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); factory = new IDBFactory();
  content.read.mockReset().mockResolvedValue(undefined);
  await createNativeProject({ projectId, canvasId, name: '作品' }, { factory });
  await writeNativeVideoEditorProject(original(), context, { expected: null }, { factory });
});
afterEach(() => vi.unstubAllGlobals());
const prepare = (requestId = 'request') => prepareNativeEditorMediaTask({ context, requestId, anchorNodeId: 'node', beforeClipId: 'second',
  modelRef: 'general/model', providerConfigId: 'connection', providerBase: 'https://provider.example/v1', protocolDigest: 'a'.repeat(64) }, { factory });

it('冷重启只领取原任务，工程与完成回执同事务提交；重复交付不再插入片段', async () => {
  const prepared = await prepare();
  await assertNativeEditorMediaPrepared(context, prepared, { factory });
  await recordNativeEditorMediaSubmission(prepared, { taskId: 'original-task' }, { factory });
  const restarted = { ...context, runtimeEpoch: 'new-process' };
  let row = await claimNativeEditorMediaTask(restarted, prepared.operationId, { factory });
  row = await retainNativeEditorMediaOutput(restarted, row, 'media/result.mp4', 2, { factory });
  const before = (await readNativeProjectCapture(projectId, { factory }))!.changeRevision;
  await commitNativeEditorMediaResult(restarted, row, 'media/result.mp4', { factory });
  await commitNativeEditorMediaResult(restarted, row, 'media/result.mp4', { factory });
  const editor = await readNativeVideoEditorProject(original().id, restarted, { factory });
  expect(editor?.automationRevision).toBe(1);
  expect(editor?.tracks[0].clips.map((clip) => clip.id)).toEqual(['first', `ai-transition-${row.operationId}`, 'second']);
  expect(editor?.tracks[0].clips[1]).toMatchObject({ relativePath: 'media/result.mp4', sourceOut: 2 });
  expect(editor?.tracks[0].clips[2].timelineStart).toBe(3);
  expect((await readNativeProjectCapture(projectId, { factory }))!.changeRevision).toBe(before + 1);
  expect(await listNativeEditorMediaTasks(restarted, 'node', { factory })).toEqual([expect.objectContaining({ status: 'delivered', remoteTaskId: 'original-task' })]);
});

it('提交未知不能自动续查或新建第二次请求，保留原操作', async () => {
  const row = await prepare();
  await recordNativeEditorMediaSubmission(row, { unknown: true }, { factory });
  await expect(claimNativeEditorMediaTask(context, row.operationId, { factory })).rejects.toThrow('不能自动续查');
  await expect(prepare('another')).rejects.toThrow('未结算');
  expect(await listNativeEditorMediaTasks(context, 'node', { factory })).toEqual([expect.objectContaining({ status: 'outcome-unknown' })]);
});

it('另一轮领取撤销旧投递；工程已编辑时原付费结果不覆盖新内容', async () => {
  const initial = await prepare();
  await recordNativeEditorMediaSubmission(initial, { taskId: 'original-task' }, { factory });
  const old = await claimNativeEditorMediaTask(context, initial.operationId, { factory });
  let latest = await claimNativeEditorMediaTask(context, initial.operationId, { factory });
  await expect(commitNativeEditorMediaResult(context, old, 'media/result.mp4', { factory })).rejects.toThrow('租约');
  latest = await retainNativeEditorMediaOutput(context, latest, 'media/result.mp4', 2, { factory });
  await writeNativeVideoEditorProject({ ...original(), name: '后续编辑', updatedAt: 2 }, context, { expected: original() }, { factory });
  await expect(commitNativeEditorMediaResult(context, latest, 'media/result.mp4', { factory })).rejects.toThrow('工程已变化');
  expect((await readNativeVideoEditorProject(original().id, context, { factory }))?.name).toBe('后续编辑');
  expect((await listNativeEditorMediaTasks(context, 'node', { factory }))[0].status).toBe('submitted');
  expect((await listNativeEditorMediaTasks(context, 'node', { factory }))[0].resultPath).toBe('media/result.mp4');
});

it('用户结束未知任务跟踪仍保存迟到的原任务 ID，不重新取得投递权', async () => {
  const row = await prepare();
  await recordNativeEditorMediaSubmission(row, { unknown: true }, { factory });
  await reviewNativeEditorMediaTask(context, row.operationId, { factory });
  await recordNativeEditorMediaSubmission(row, { taskId: 'late-original-id' }, { factory });
  const records = await listNativeEditorMediaTasks(context, 'node', { factory });
  expect(records[0]).toMatchObject({ status: 'reviewed', remoteTaskId: 'late-original-id' });
  await expect(claimNativeEditorMediaTask(context, row.operationId, { factory })).rejects.toThrow('不能自动续查');
  expect((await prepare('new-request')).operationId).not.toBe(row.operationId);
});

it('锚点不存在时仍可列出本画布全部原任务并核对终止，未获得恢复投递权', async () => {
  const row = await prepare();
  await recordNativeEditorMediaSubmission(row, { taskId: 'original-task' }, { factory });
  // 账本读取与结束跟踪不依赖锚点仍存在；工程回写仍有原工程与租约的独立核验。
  const all = await listNativeEditorMediaTasks(context, undefined, { factory });
  expect(all.map((task) => task.operationId)).toEqual([row.operationId]);
  await reviewNativeEditorMediaTask(context, row.operationId, { factory });
  expect((await listNativeEditorMediaTasks(context, undefined, { factory }))[0]).toMatchObject({ status: 'reviewed', remoteTaskId: 'original-task' });
  await expect(claimNativeEditorMediaTask(context, row.operationId, { factory })).rejects.toThrow('不能自动续查');
  expect(await readNativeVideoEditorProject(original().id, context, { factory })).toEqual(original());
});

it('其他集和原代际均不能领取或投递，路径逃逸也被拒绝', async () => {
  const initial = await prepare();
  await recordNativeEditorMediaSubmission(initial, { taskId: 'original-task' }, { factory });
  const claimed = await claimNativeEditorMediaTask(context, initial.operationId, { factory });
  await expect(claimNativeEditorMediaTask({ ...context, canvasEpoch: 2 }, initial.operationId, { factory })).rejects.toThrow('代际');
  await expect(commitNativeEditorMediaResult(context, claimed, '../result.mp4', { factory })).rejects.toThrow();
  expect(await readNativeVideoEditorProject(original().id, context, { factory })).toEqual(original());
});

it('同步转场无远端ID先保存完整候选，冷重启只投递缓存并归档所有文件', async () => {
  let row = await prepareNativeEditorMediaTask({ context, requestId: 'sync', anchorNodeId: 'node', beforeClipId: 'second',
    modelRef: 'general/sync', providerConfigId: 'connection', providerBase: 'https://provider.example/v1',
    protocolDigest: 'b'.repeat(64), submissionKind: 'sync' }, { factory });
  row = await recordNativeEditorMediaSubmission(row, { unknown: true }, { factory });
  const outputs = ['c', 'd'].map((character) => ({ relativePath: `media/${character.repeat(64)}.mp4`, bytes: 42,
    sha256: character.repeat(64), category: 'video' as const }));
  row = await retainNativeEditorMediaOutputs(row, outputs, { factory });
  expect(row).toMatchObject({ status: 'submitted', submissionKind: 'sync', localResults: outputs });
  expect(row.remoteTaskId).toBeUndefined();
  expect(content.read.mock.calls.map((call) => call[1])).toEqual(outputs);
  const restarted = { ...context, runtimeEpoch: 'restart' };
  row = await claimNativeEditorMediaTask(restarted, row.operationId, { factory });
  row = await retainNativeEditorMediaOutput(restarted, row, outputs[0].relativePath, 2.5, { factory });
  await commitNativeEditorMediaResult(restarted, row, outputs[0].relativePath, { factory });
  expect((await readNativeVideoEditorProject(original().id, restarted, { factory }))?.tracks[0].clips[1]).toMatchObject({ sourceOut: 2.5 });
  expect((await listNativeEditorMediaArtifactsForProject(projectId, { factory })).map((item) => item.path)).toEqual(outputs.map((file) => file.relativePath));
});

it('原异步ID和安全查询投影同事务冻结，不能替换响应依赖字段', async () => {
  const prepared = await prepare();
  const pollContext = { submit: { task: { id: 'original-task', region: 'cn-1' } } };
  const row = await recordNativeEditorMediaSubmission(prepared, { taskId: 'original-task', pollContext }, { factory });
  expect((await claimNativeEditorMediaTask(context, row.operationId, { factory })).pollContext).toEqual(pollContext);
  await expect(recordNativeEditorMediaSubmission(row, { taskId: 'original-task', pollContext: { submit: { task: { id: 'original-task', region: 'other' } } } }, { factory })).rejects.toThrow('已变化');
  await expect(recordNativeEditorMediaSubmission(row, { taskId: 'original-task', pollContext: { apiKey: 'not-persistable' } }, { factory })).rejects.toThrow();
  expect((await listNativeEditorMediaTasks(context, 'node', { factory }))[0].pollContext).toEqual(pollContext);
});

it('停写确认在同一耐久事务复核原工程，编辑后不进入提交未知', async () => {
  const row = await prepare();
  await writeNativeVideoEditorProject({ ...original(), name: '修改后', updatedAt: 3 }, context, { expected: original() }, { factory });
  await expect(recordNativeEditorMediaSubmission(row, { unknown: true }, { factory })).rejects.toThrow('工程已变化');
  expect((await listNativeEditorMediaTasks(context, 'node', { factory }))[0].status).toBe('prepared');
});

it('任一候选文件核验失败不发布不完整集合，原ID仍可继续查询', async () => {
  let row = await prepare(); row = await recordNativeEditorMediaSubmission(row, { taskId: 'original-task' }, { factory });
  const files = ['e', 'f'].map((character) => ({ relativePath: `media/${character.repeat(64)}.mp4`, bytes: 42,
    sha256: character.repeat(64), category: 'video' as const }));
  content.read.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('missing'));
  await expect(retainNativeEditorMediaOutputs(row, files, { factory })).rejects.toThrow('missing');
  const current = await claimNativeEditorMediaTask(context, row.operationId, { factory });
  expect(current.localResults).toBeUndefined(); expect(current.remoteTaskId).toBe('original-task');
});

it('多原ID和全部成功候选及部分失败统计耐久保留，不能把部分成功改写为全成功', async () => {
  let row = await prepare();
  row = await recordNativeEditorMediaSubmission(row, { taskId: 'first', pollContext: { submit: { data: [{ task_id: 'first' }] }, taskIds: ['first', 'second', 'third'] } }, { factory });
  const files = ['a', 'b'].map((character) => ({ relativePath: `media/${character.repeat(64)}.mp4`, bytes: 42,
    sha256: character.repeat(64), category: 'video' as const }));
  row = await retainNativeEditorMediaOutputs(row, files, { factory, completion: { taskCount: 3, failedTasks: 1 } });
  const restarted = await claimNativeEditorMediaTask({ ...context, runtimeEpoch: 'restart' }, row.operationId, { factory });
  expect(restarted.pollContext?.taskIds).toEqual(['first', 'second', 'third']);
  expect(restarted.completion).toEqual({ taskCount: 3, failedTasks: 1 });
  expect(restarted.localResults).toEqual(files);
  await expect(retainNativeEditorMediaOutputs(restarted, files, { factory, completion: { taskCount: 3, failedTasks: 0 } })).rejects.toThrow('冻结');
});
