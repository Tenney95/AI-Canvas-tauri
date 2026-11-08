/** 全部使用隔离 fake IndexedDB 与文件读回替身，不操作用户数据。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import { createNativeProject, readNativeProjectCapture } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, claimNativeMediaRecovery, reviewNativeMediaTask, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { createNativeWorkflowReceipt, beginNativeWorkflowSubmission, retainNativeWorkflowSubmission, readNativeWorkflowReceipt,
  sealNativeWorkflowSubmissions, retainNativeWorkflowTaskOutputs, listNativeWorkflowRetainedOutputs, nativeWorkflowSummary,
  retainNativeWorkflowSyncOutputs } from '../../src/services/nativeWorkflowRepository';
import { retainNativeMediaOutputs } from '../../src/services/indexedDb/nativeMediaCollectionRepository';

const files = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: files.read }));
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange); files.read.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());
const output = (letter: string) => ({ relativePath: `media/${letter.repeat(64)}.png`, bytes: 12, sha256: letter.repeat(64), category: 'image' as const });
async function fixture(count = 2, sync = false) {
  const aggregate = await createNativeProject({ name: '隔离工作流' }, { factory });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'session-1', projectId: aggregate.project.id,
    canvasId: aggregate.canvas!.id, episodeId: null, projectEpoch: aggregate.project.epoch, canvasEpoch: aggregate.canvas!.epoch, canvasRevision: 0 };
  const descriptor = { adapter: 'runninghub-model' as const, connectionId: 'runninghub-model', providerBase: 'https://service.example', modelId: 'known-model', category: 'image' as const, digest: 'a'.repeat(64) };
  const record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'original-node', providerConfigId: descriptor.connectionId,
    providerBase: descriptor.providerBase, category: 'image', submissionKind: sync ? 'sync' : 'async', fingerprintScheme: 'media-input-v3',
    protocolDigest: descriptor.digest, requestFingerprint: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64), sourceCanvasRevision: 0,
    modelRef: 'workflow/known-model', recovery: { kind: 'workflow', modelId: descriptor.modelId, digest: descriptor.digest } }, { factory });
  const receipt = await createNativeWorkflowReceipt(record, descriptor, count, { factory });
  return { record, receipt, context };
}

it('每个POST先耐久写未知，原ID和所有额外候选都保留，部分失败不冒充完整成功', async () => {
  let { record, receipt, context } = await fixture();
  const before = (await readNativeProjectCapture(context.projectId, { factory }))!.changeRevision;
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[0].id, { factory }));
  expect(record.status).toBe('outcome-unknown');
  await expect(claimNativeMediaRecovery(record.operationId, context, { factory })).rejects.toThrow();
  ({ record, receipt } = await retainNativeWorkflowSubmission(record, receipt.submissions[0].id, { taskId: 'task-1' }, { factory }));
  expect(record.status).toBe('prepared');
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[1].id, { factory }));
  ({ record, receipt } = await retainNativeWorkflowSubmission(record, receipt.submissions[1].id, { failed: true }, { factory }));
  expect(record.status).toBe('submitted');
  record = await claimNativeMediaRecovery(record.operationId, { ...context, runtimeEpoch: 'after-restart' }, { factory });
  ({ record, receipt } = await retainNativeWorkflowTaskOutputs(record, 'task-1', { outputs: [output('d'), output('e'), output('f')] }, { factory }));
  expect(nativeWorkflowSummary(receipt)).toMatchObject({ resultCount: 3, failedSubmissions: 1, partial: true });
  expect(await listNativeWorkflowRetainedOutputs(context.projectId, { factory })).toHaveLength(3);
  const retained = await retainNativeMediaOutputs(record, receipt.tasks[0].outputs!, { factory });
  expect(retained.localResults).toHaveLength(3);
  expect((await readNativeProjectCapture(context.projectId, { factory }))!.changeRevision).toBeGreaterThan(before);
});

it('未知槽位不自动续查；用户核对后仅认原ID，新租约拒绝旧窗口写结果', async () => {
  let { record, receipt, context } = await fixture();
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[0].id, { factory }));
  ({ record, receipt } = await retainNativeWorkflowSubmission(record, receipt.submissions[0].id, { taskId: 'original-task' }, { factory }));
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[1].id, { factory }));
  const old = record;
  await reviewNativeMediaTask(record.operationId, context, { factory });
  record = (await listNativeMediaTasks(context.projectId, { factory }))[0];
  ({ record, receipt } = await sealNativeWorkflowSubmissions(record, context, { factory }));
  expect(receipt.uncertainAcknowledged).toBe(true);
  record = await claimNativeMediaRecovery(record.operationId, context, { factory });
  await expect(retainNativeWorkflowTaskOutputs(old, 'original-task', { outputs: [output('a')] }, { factory })).rejects.toThrow('租约');
  const late = await retainNativeWorkflowSubmission(old, receipt.submissions[1].id, { taskId: 'late-task' }, { factory });
  expect(late.receipt.lateTaskIds).toEqual([{ submissionId: receipt.submissions[1].id, taskId: 'late-task' }]);
  expect(late.receipt.tasks.map((task) => task.taskId)).toEqual(['original-task']);
});

it('重启将可证明未发送的槽位标记未开始，不补发；跨集上下文不能取得回执', async () => {
  let { record, receipt, context } = await fixture();
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[0].id, { factory }));
  ({ record, receipt } = await retainNativeWorkflowSubmission(record, receipt.submissions[0].id, { taskId: 'known-task' }, { factory }));
  await expect(sealNativeWorkflowSubmissions(record, { ...context, canvasId: `c2-${crypto.randomUUID()}` }, { factory })).rejects.toThrow();
  ({ record, receipt } = await sealNativeWorkflowSubmissions(record, context, { factory }));
  expect(receipt.submissions[1].state).toBe('not-started'); expect(record.remoteTaskId).toBe('known-task');
  expect(nativeWorkflowSummary(receipt).partial).toBe(true);
});

it('同步响应只保留真实本机集合，无伪造taskId；丢失文件不能写完成收据', async () => {
  let { record, receipt, context } = await fixture(1, true);
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[0].id, { factory }));
  files.read.mockRejectedValueOnce(new Error('missing original bytes'));
  await expect(retainNativeWorkflowSyncOutputs(record, receipt.submissions[0].id, [output('a')], { factory })).rejects.toThrow('missing');
  expect((await readNativeWorkflowReceipt(record.operationId, { factory }))!.syncOutputs).toBeUndefined();
  ({ record, receipt } = await retainNativeWorkflowSyncOutputs(record, receipt.submissions[0].id, [output('a'), output('b')], { factory }));
  expect(receipt.tasks).toEqual([]); expect(record.remoteTaskId).toBeUndefined();
  record = await retainNativeMediaOutputs(record, receipt.syncOutputs!, { factory });
  expect((await claimNativeMediaRecovery(record.operationId, { ...context, runtimeEpoch: 'restart' }, { factory })).localResults).toHaveLength(2);
});
