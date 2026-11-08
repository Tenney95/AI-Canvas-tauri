/** 合成图片多POST/多task/多候选回执，只使用独立fake IndexedDB。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import { createNativeProject, saveNativeCanvas, readNativeProjectCapture } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, claimNativeMediaRecovery, listNativeMediaTasks, reviewNativeMediaTask } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { beginNativeImageBatchSubmission, retainNativeImageBatchSubmission, retainNativeImageBatchTask } from '../../src/services/indexedDb/nativeImageBatchRepository';
import { buildNativeImageBatchCanvas } from '../../src/services/nativeImageBatchCanvas';
import { nativeImageBatchResults, nativeImageBatchSummary } from '../../src/services/nativeImageBatch';
import { commitNativeMediaDelivery } from '../../src/services/nativeMediaDelivery';
const files = vi.hoisted(() => ({ read: vi.fn(async () => {}) }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: files.read }));
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange); files.read.mockReset(); files.read.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());
const file = (letter: string) => ({ relativePath: `media/${letter.repeat(64)}.png`, bytes: 3, sha256: letter.repeat(64) });

async function fixture() {
  const root = await createNativeProject({ name: '原图片批次' }, { factory });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'original', projectId: root.project.id,
    projectEpoch: root.project.epoch, canvasId: root.canvas!.id, canvasEpoch: root.canvas!.epoch, canvasRevision: 0, episodeId: null };
  const saved = await saveNativeCanvas({ projectId: context.projectId, canvasId: context.canvasId, episodeId: null,
    expectedProjectEpoch: context.projectEpoch, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
    document: { nodes: [{ id: 'image', type: 'ai-image', position: { x: 20, y: 30 }, data: { type: 'ai-image', label: '原图', model: 'model', provider: 'apimart',
      prompt: '原输入', batchCount: 2, displayId: 10, dramaAssetId: 'source-role', characterLibraryLinks: [{ characterId: 'role' }], hiddenByCharacterLibrary: true,
      taskReceipt: { taskId: 'old' }, filePath: 'old.png', status: 'loading' } },
    { id: 'untouched', position: { x: 0, y: 0 }, data: { type: 'ai-text', displayId: 15, prompt: '不要改变' } }], edges: [], groups: [] } }, { factory });
  const record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'image', providerConfigId: 'apimart', providerBase: 'https://apimart.example/v1',
    category: 'image', modelRef: 'apimart/model', protocolDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64),
    fingerprintScheme: 'media-input-v2', submissionKind: 'async', sourceCanvasRevision: saved.revision,
    apimartImageBatch: { version: 1, requestedCount: 2, submissions: [0, 1].map(() => ({ id: crypto.randomUUID(), state: 'prepared' as const, taskIds: [] })), tasks: [] } }, { factory });
  return { context, record, saved };
}

it('所有原POST先有意图、所有原taskID与额外候选均保留；完整集合与画布单次原子交付', async () => {
  const { context, saved, record: initial } = await fixture();
  let record = await beginNativeImageBatchSubmission(initial, initial.apimartImageBatch!.submissions[0].id, { factory });
  expect(record.status).toBe('outcome-unknown');
  await expect(claimNativeMediaRecovery(record.operationId, context, { factory })).rejects.toThrow();
  record = await retainNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[0].id, { taskIds: ['task-a', 'task-b'] }, { factory });
  record = await beginNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[1].id, { factory });
  record = await retainNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[1].id, { taskIds: ['task-c'] }, { factory });
  record = await claimNativeMediaRecovery(record.operationId, { ...context, runtimeEpoch: 'after-restart' }, { factory });
  record = await retainNativeImageBatchTask(record, 'task-a', { results: [file('a'), file('b')] }, { factory });
  record = await retainNativeImageBatchTask(record, 'task-b', { failed: true }, { factory });
  record = await retainNativeImageBatchTask(record, 'task-c', { results: [file('c')] }, { factory });
  expect(nativeImageBatchResults(record)).toHaveLength(3);
  expect(nativeImageBatchSummary(record)).toMatchObject({ requestedCount: 2, candidateCount: 3, failedTasks: 1, partial: true });
  const body = buildNativeImageBatchCanvas(saved, record);
  const extra = body.nodes.slice(saved.nodes.length) as Array<{ data: Record<string, unknown> }>;
  expect(extra.map((node) => node.data.displayId)).toEqual([16, 17]);
  expect(extra.every((node) => !node.data.dramaAssetId && !node.data.characterLibraryLinks && !node.data.hiddenByCharacterLibrary && !node.data.taskReceipt && !node.data.filePath)).toBe(true);
  await expect(commitNativeMediaDelivery({ record, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0,
    document: { ...body, nodes: body.nodes.slice(0, -1) } }, { factory })).rejects.toThrow('完整');
  expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0].nodes).toEqual(saved.nodes);
  const delivered = await commitNativeMediaDelivery({ record, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document: body }, { factory });
  expect(delivered.record.status).toBe('delivered'); expect(delivered.changeRevision).toBeGreaterThan(0);
  expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0].nodes).toHaveLength(saved.nodes.length + 2);
  expect((await commitNativeMediaDelivery({ record, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document: body }, { factory })).alreadyCommitted).toBe(true);
});

it('用户核对unknown后只交付已知候选；后到原ID另行保留，不改已交付ordinal或写入后续画布', async () => {
  const { context, saved, record: initial } = await fixture();
  let record = await beginNativeImageBatchSubmission(initial, initial.apimartImageBatch!.submissions[0].id, { factory });
  record = await retainNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[0].id, { taskIds: ['known-task'] }, { factory });
  const waiting = await beginNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[1].id, { factory });
  await reviewNativeMediaTask(waiting.operationId, context, { factory });
  record = await claimNativeMediaRecovery(waiting.operationId, context, { factory });
  record = await retainNativeImageBatchTask(record, 'known-task', { results: [file('d')] }, { factory });
  const body = buildNativeImageBatchCanvas(saved, record);
  await commitNativeMediaDelivery({ record, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document: body }, { factory });
  const before = await readNativeProjectCapture(context.projectId, { factory });
  const late = await retainNativeImageBatchSubmission(waiting, waiting.apimartImageBatch!.submissions[1].id, { taskIds: ['late-paid-task'] }, { factory });
  expect(late.status).toBe('delivered'); expect(late.lateImageTaskIds?.[0].taskIds).toEqual(['late-paid-task']);
  expect(nativeImageBatchResults(late)).toEqual([file('d')]);
  expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate).toEqual(before!.aggregate);
  expect((await listNativeMediaTasks(context.projectId, { factory }))[0].lateImageTaskIds).toEqual(late.lateImageTaskIds);
});

it('首个task多返回候选仍不能掩盖后续POST明确失败；未发送槽位与明确失败分开保存', async () => {
  const { record: initial } = await fixture();
  let record = await beginNativeImageBatchSubmission(initial, initial.apimartImageBatch!.submissions[0].id, { factory });
  record = await retainNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[0].id, { taskIds: ['many-images'] }, { factory });
  record = await beginNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[1].id, { factory });
  record = await retainNativeImageBatchSubmission(record, record.apimartImageBatch!.submissions[1].id, { failed: true }, { factory });
  record = await retainNativeImageBatchTask(record, 'many-images', { results: [file('a'), file('b'), file('c')] }, { factory });
  expect(nativeImageBatchSummary(record)).toMatchObject({ requestedCount: 2, candidateCount: 3, failedTasks: 0,
    failedSubmissions: 1, notStartedSubmissions: 0, partial: true });
  const unsent = await fixture();
  const stopped = await retainNativeImageBatchSubmission(unsent.record, unsent.record.apimartImageBatch!.submissions[0].id, { notStarted: true }, { factory });
  expect(stopped.apimartImageBatch!.submissions[0].state).toBe('not-started');
});
