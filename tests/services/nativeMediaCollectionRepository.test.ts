/** 隔离 fake IndexedDB 与固定字节核验替身；不访问真实项目或模型。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { NativeMediaLocalOutput } from '../../src/types/media';
import { createNativeProject, readNativeProjectCapture, saveNativeCanvas } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, claimNativeMediaRecovery, listNativeMediaTasks, recordNativeMediaSubmission } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { retainNativeMediaOutputs } from '../../src/services/indexedDb/nativeMediaCollectionRepository';
import { buildNativeMediaCollectionCanvas } from '../../src/services/nativeMediaCollectionCanvas';
import { commitNativeMediaDelivery } from '../../src/services/nativeMediaDelivery';
import { nativeMediaLocalOutputs, validateNativeMediaLocalOutputs } from '../../src/services/nativeMediaCollection';

const files = vi.hoisted(() => ({ read: vi.fn(async () => {}) }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: files.read }));
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  files.read.mockReset(); files.read.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());
const output = (letter: string, category: NativeMediaLocalOutput['category']): NativeMediaLocalOutput => ({
  relativePath: `media/${letter.repeat(64)}.${category === 'image' ? 'png' : category === 'audio' ? 'mp3' : 'mp4'}`,
  sha256: letter.repeat(64), bytes: 10, category,
});
async function fixture(sync: boolean, category: NativeMediaLocalOutput['category'] = 'audio', sourceType = `ai-${category}`) {
  const root = await createNativeProject({ name: '隔离完整媒体作业' }, { factory });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'original', projectId: root.project.id,
    projectEpoch: root.project.epoch, canvasId: root.canvas!.id, canvasEpoch: root.canvas!.epoch, canvasRevision: 0, episodeId: null };
  const canvas = await saveNativeCanvas({ projectId: context.projectId, canvasId: context.canvasId, episodeId: null,
    expectedProjectEpoch: context.projectEpoch, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
    document: { nodes: [{ id: 'source', type: sourceType, position: { x: 0, y: 0 }, data: { type: sourceType, displayId: 1,
      prompt: '原输入', status: 'loading', animationFrames: 8, animationAction: 'idle', characterLibraryLinks: [{ characterId: 'original-role' }] } }], edges: [], groups: [] } }, { factory });
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'source', providerConfigId: 'provider', providerBase: 'https://fixture.example',
    category, submissionKind: sync ? 'sync' : 'async', fingerprintScheme: 'media-input-v2', modelRef: 'workflow/frozen',
    protocolDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64), sourceCanvasRevision: canvas.revision,
    recovery: { kind: 'workflow', workflowId: 'frozen', digest: 'a'.repeat(64) } }, { factory });
  if (!sync) record = await recordNativeMediaSubmission(record.operationId, record.lease, { taskId: 'original-task' }, { factory });
  return { context, canvas, record };
}

it('同步完整混合产物先耐久保留，重启无远端ID仍可按原集合原子交付', async () => {
  const { context, canvas, record } = await fixture(true);
  const outputs = [output('a', 'audio'), output('b', 'image'), output('c', 'video')];
  const retained = await retainNativeMediaOutputs(record, outputs, { factory });
  expect(retained).toMatchObject({ status: 'submitted', resultRelativePath: outputs[0].relativePath });
  expect(retained.remoteTaskId).toBeUndefined(); expect(nativeMediaLocalOutputs(retained)).toEqual(outputs);
  const resumed = await claimNativeMediaRecovery(record.operationId, { ...context, runtimeEpoch: 'after-restart' }, { factory });
  const body = buildNativeMediaCollectionCanvas(canvas, resumed);
  expect(body.nodes).toHaveLength(3);
  expect((body.nodes[1] as { data: Record<string, unknown> }).data).toMatchObject({ type: 'source-image', imageUrl: outputs[1].relativePath });
  expect((body.nodes[1] as { data: Record<string, unknown> }).data.characterLibraryLinks).toBeUndefined();
  await expect(commitNativeMediaDelivery({ record: resumed, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0,
    document: { ...body, nodes: body.nodes.slice(0, 2) } }, { factory })).rejects.toThrow('完整');
  expect((await listNativeMediaTasks(context.projectId, { factory }))[0].status).toBe('submitted');
  const delivered = await commitNativeMediaDelivery({ record: resumed, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0, document: body }, { factory });
  expect(delivered.record.status).toBe('delivered');
  expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0].nodes).toHaveLength(3);
});

it('任何产物字节失败都不发布部分集合，原异步ID保留且不能替换冻结结果', async () => {
  const { context, record } = await fixture(false);
  const outputs = [output('d', 'audio'), output('e', 'audio')];
  files.read.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second output changed'));
  await expect(retainNativeMediaOutputs(record, outputs, { factory })).rejects.toThrow('second');
  expect((await listNativeMediaTasks(context.projectId, { factory }))[0]).toMatchObject({ status: 'submitted', remoteTaskId: 'original-task' });
  expect((await listNativeMediaTasks(context.projectId, { factory }))[0].localResults).toBeUndefined();
  const retained = await retainNativeMediaOutputs(record, outputs, { factory, completion: { taskCount: 2, failedTasks: 1 } });
  await expect(retainNativeMediaOutputs(retained, outputs, { factory, completion: { taskCount: 2, failedTasks: 0 } })).rejects.toThrow();
  await expect(retainNativeMediaOutputs(retained, [output('f', 'audio')], { factory })).rejects.toThrow();
  await claimNativeMediaRecovery(record.operationId, context, { factory });
  await expect(retainNativeMediaOutputs(retained, outputs, { factory })).rejects.toThrow('租约');
});

it('异步合同返回inline全集合时只在同原意图无远端ID下原子转本机交付，不伪造任务', async () => {
  const { context, record } = await fixture(true);
  // 以真实异步prepared合同另建节点，不把一个同步原任务改造成异步请求。
  const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'inline-node', providerConfigId: 'provider',
    providerBase: 'https://fixture.example', category: 'audio', submissionKind: 'async', fingerprintScheme: 'media-input-v2', modelRef: 'general/frozen',
    protocolDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), inputFingerprint: 'c'.repeat(64), sourceCanvasRevision: record.sourceCanvasRevision,
    recovery: { kind: 'general-protocol', digest: 'a'.repeat(64) } }, { factory });
  const unknown = await recordNativeMediaSubmission(prepared.operationId, prepared.lease, { unknown: true }, { factory });
  const retained = await retainNativeMediaOutputs(unknown, [output('c', 'audio')], { factory, inlineSubmission: true });
  expect(retained).toMatchObject({ submissionKind: 'sync', status: 'submitted' }); expect(retained.remoteTaskId).toBeUndefined();
  expect((await claimNativeMediaRecovery(prepared.operationId, { ...context, runtimeEpoch: 'restarted' }, { factory })).localResults).toHaveLength(1);
});

it('动画主节点身份来自已保存画布并保留帧表语义，额外结果不冒充动画工程', async () => {
  const { canvas, record } = await fixture(true, 'image', 'ai-animation');
  expect(record.targetNodeType).toBe('ai-animation');
  const retained = await retainNativeMediaOutputs(record, [output('a', 'image'), output('b', 'image')], { factory });
  const body = buildNativeMediaCollectionCanvas(canvas, retained);
  expect((body.nodes[0] as { data: Record<string, unknown> }).data).toMatchObject({ type: 'ai-animation', animationSheet: { frameCount: 8, action: 'idle' } });
  expect((body.nodes[1] as { data: Record<string, unknown> }).data.type).toBe('ai-image');
});

it('作品主根产物不继承导入节点或画布的旧子根，旧回执也依权威主根投递', async () => {
  const { canvas, record } = await fixture(true, 'image');
  const retained = await retainNativeMediaOutputs(record, [output('a', 'image'), output('b', 'image')], { factory });
  const child = `r2-${crypto.randomUUID()}`, primary = record.resultRootRef!;
  const node = canvas.nodes[0] as { data: Record<string, unknown> };
  const imported = { ...canvas, storageRootRef: child, nodes: [{ ...node, data: { ...node.data, storageRootRef: child } }] };
  const projected = buildNativeMediaCollectionCanvas(imported, retained, primary);
  expect(projected.nodes.every((item) => (item as { data: Record<string, unknown> }).data.storageRootRef === primary)).toBe(true);
  expect(() => buildNativeMediaCollectionCanvas(imported, retained, child)).toThrow('主根');
  const oldReceipt = { ...retained }; delete oldReceipt.resultRootRef;
  const oldProjected = buildNativeMediaCollectionCanvas(imported, oldReceipt, primary);
  expect((oldProjected.nodes[0] as { data: Record<string, unknown> }).data.storageRootRef).toBe(primary);
});

it('集合只接受受控摘要文件和已知字段，拒绝地址、任意路径及访问器', () => {
  expect(() => validateNativeMediaLocalOutputs([{ ...output('a', 'audio'), relativePath: 'https://fixture.example/track.mp3' }])).toThrow();
  expect(() => validateNativeMediaLocalOutputs([{ ...output('a', 'audio'), relativePath: 'imports/unknown/file.mp3' }])).toThrow();
  const accessor = { ...output('a', 'audio') }; Object.defineProperty(accessor, 'bytes', { get: () => { throw new Error('getter must not run'); } });
  expect(() => validateNativeMediaLocalOutputs([accessor])).toThrow('受控文件');
});
