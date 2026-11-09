/** 只使用隔离的 fake IndexedDB，不读取用户数据；测试源码待用户运行。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeProject, deleteNativeProject, saveNativeCanvas, readNativeProjectCapture, openNativeProjectDatabase, TRANSFER } from '../../src/services/indexedDb/nativeProjectRepository';
import { claimNativeMediaRecovery, isNativeMediaLeaseCurrent, listNativeMediaTasks, prepareNativeMediaTask,
  recordNativeMediaSubmission, retainNativeMediaLocalResult, assertNativeMediaResultRetention, assertNativeMediaPrepared,
  reviewNativeMediaTask, failNativeMediaTask } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { commitNativeMediaDelivery, commitNativeMediaMessageDelivery } from '../../src/services/nativeMediaDelivery';
import { bindNativeMediaOrigin } from '../../src/services/nativeMediaOrigin';
import type { CanvasContext } from '../../src/types/project';
const localFiles = vi.hoisted(() => ({ read: vi.fn(async () => {}), capture: vi.fn() }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: localFiles.read, captureNativeMediaLocalResult: localFiles.capture }));

let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); localFiles.read.mockReset(); localFiles.read.mockResolvedValue(undefined);
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
afterEach(() => { vi.unstubAllGlobals(); });

async function fixture() {
  const root = await createNativeProject({ name: '隔离媒体项目' }, { factory });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'runtime-1',
    projectId: root.project.id, projectEpoch: root.project.epoch, canvasId: root.canvas!.id, canvasEpoch: root.canvas!.epoch,
    canvasRevision: root.canvas!.revision, episodeId: null };
  return context;
}

describe('新画布媒体回执账本', () => {
  it('共享同步停写不丢弃已返回的同步产物，但仍阻止实际画布和消息交付', async () => {
    const context = await fixture(), nodeId = `media-message-${crypto.randomUUID()}`;
    const release = bindNativeMediaOrigin(context.canvasId, nodeId, { conversationId: 'original', messageId: 'result', deliveryMode: 'chat' });
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId, category: 'image',
      providerConfigId: 'provider', providerBase: 'https://example.test', modelRef: 'general/model', protocolDigest: 'c'.repeat(64),
      submissionKind: 'sync', fingerprintScheme: 'media-input-v2', requestFingerprint: 'b'.repeat(64), inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0 }, { factory });
    release();
    const before = await readNativeProjectCapture(context.projectId, { factory });
    const db = await openNativeProjectDatabase(false, { factory });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction(TRANSFER, 'readwrite', { durability: 'strict' });
        tx.objectStore(TRANSFER).put({ id: 'shared-freeze', operationId: 'shared-freeze', projectId: context.projectId,
          kind: 'native-shared-sync', phase: 'prepared' });
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      });
    } finally { db!.close(); }
    await expect(assertNativeMediaPrepared(prepared, { factory })).rejects.toThrow('shared-sync-pending');
    await expect(assertNativeMediaResultRetention(prepared, { factory })).resolves.toBeUndefined();
    const sha256 = 'd'.repeat(64), localResult = { relativePath: `media/${sha256}.png`, bytes: 10, sha256 };
    const retained = await retainNativeMediaLocalResult(prepared, localResult, { factory });
    expect(retained.localResult).toEqual(localResult);
    const after = await readNativeProjectCapture(context.projectId, { factory });
    expect(after!.aggregate).toEqual(before!.aggregate);
    expect(after!.changeRevision).toBe(before!.changeRevision + 1);
    await expect(claimNativeMediaRecovery(prepared.operationId, context, { factory })).rejects.toThrow('shared-sync-pending');
    await expect(commitNativeMediaMessageDelivery(retained, localResult.relativePath, { factory })).rejects.toThrow('shared-sync-pending');
  });
  it('同步回执没有远端taskId；本机文件已耐久保留后重启只交付原文件', async () => {
    const context = await fixture(), nodeId = `media-message-${crypto.randomUUID()}`;
    const release = bindNativeMediaOrigin(context.canvasId, nodeId, { conversationId: 'original-conversation', messageId: 'sync-message', deliveryMode: 'chat' });
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId, category: 'image',
      providerConfigId: 'provider', providerBase: 'https://example.test', modelRef: 'general/model', protocolDigest: 'c'.repeat(64),
      submissionKind: 'sync', fingerprintScheme: 'media-input-v2', requestFingerprint: 'b'.repeat(64), inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0 }, { factory });
    release();
    await expect(recordNativeMediaSubmission(prepared.operationId, prepared.lease, { taskId: 'must-not-fake-remote' }, { factory })).rejects.toThrow('伪造');
    const sha256 = 'd'.repeat(64), localResult = { relativePath: `media/${sha256}.png`, bytes: 10, sha256 };
    await retainNativeMediaLocalResult(prepared, localResult, { factory });
    await reviewNativeMediaTask(prepared.operationId, context, { factory });
    const resumed = await claimNativeMediaRecovery(prepared.operationId, { ...context, runtimeEpoch: 'after-restart' }, { factory });
    expect(resumed.remoteTaskId).toBeUndefined();
    expect(resumed.localResult).toEqual(localResult);
    localFiles.read.mockRejectedValueOnce(new Error('file digest mismatch'));
    await expect(commitNativeMediaMessageDelivery(resumed, localResult.relativePath, { factory })).rejects.toThrow('digest');
    expect((await listNativeMediaTasks(context.projectId, { factory }))[0].status).toBe('submitted');
    const delivered = await commitNativeMediaMessageDelivery(resumed, localResult.relativePath, { factory });
    expect(delivered).toMatchObject({ status: 'delivered', submissionKind: 'sync', resultRelativePath: localResult.relativePath });
    expect(delivered.remoteTaskId).toBeUndefined();
    expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0].nodes).toEqual([]);
  });
  it('新图片和音频任务必须显式v2；原视频缺省算法保持兼容', async () => {
    const context = await fixture();
    const base = { context, operationId: crypto.randomUUID(), nodeId: 'node', providerConfigId: 'provider',
      providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0 };
    await expect(prepareNativeMediaTask({ ...base, category: 'audio' }, { factory })).rejects.toThrow('版本化');
    const audio = await prepareNativeMediaTask({ ...base, category: 'audio', fingerprintScheme: 'media-input-v2',
      requestFingerprint: 'b'.repeat(64), modelRef: 'general/model', protocolDigest: 'c'.repeat(64) }, { factory });
    expect(audio).toMatchObject({ category: 'audio', fingerprintScheme: 'media-input-v2', requestFingerprint: 'b'.repeat(64) });
    const originalVideo = await prepareNativeMediaTask({ ...base, operationId: crypto.randomUUID(), nodeId: 'old-video', category: 'video' }, { factory });
    expect(originalVideo.fingerprintScheme).toBeUndefined();
  });
  it('v2音频按原category条件投递，不能把视频字段写进音频节点', async () => {
    const context = await fixture();
    const saved = await saveNativeCanvas({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch,
      canvasId: context.canvasId, episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
      document: { nodes: [{ id: 'audio', data: { type: 'ai-audio', prompt: '原输入' } }], edges: [], groups: [] } }, { factory });
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'audio', category: 'audio',
      providerConfigId: 'provider', providerBase: 'https://example.test', modelRef: 'general/model', protocolDigest: 'c'.repeat(64),
      fingerprintScheme: 'media-input-v2', requestFingerprint: 'b'.repeat(64), inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: saved.revision }, { factory });
    const submitted = await recordNativeMediaSubmission(prepared.operationId, prepared.lease, { taskId: 'original-audio' }, { factory });
    const wrong = { nodes: [{ id: 'audio', data: { type: 'ai-audio', prompt: '原输入', videoUrl: 'media/result.wav', relativePath: 'media/result.wav' } }], edges: [], groups: [] };
    await expect(commitNativeMediaDelivery({ record: submitted, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document: wrong }, { factory })).rejects.toThrow('类型');
    const correct = { ...wrong, nodes: [{ id: 'audio', data: { type: 'ai-audio', prompt: '原输入', audioUrl: 'media/result.wav', relativePath: 'media/result.wav' } }] };
    const delivered = await commitNativeMediaDelivery({ record: submitted, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document: correct }, { factory });
    expect(delivered.record).toMatchObject({ status: 'delivered', category: 'audio', resultRelativePath: 'media/result.wav' });
  });
  it('对话专用任务跨重启保留原消息身份，完成回执与文件身份同事务提交且不创建隐藏节点', async () => {
    const context = await fixture(), nodeId = `media-message-${crypto.randomUUID()}`;
    const origin = { conversationId: 'original-conversation', messageId: 'original-message', agentTaskId: 'original-agent', deliveryMode: 'chat' as const };
    const unbind = bindNativeMediaOrigin(context.canvasId, nodeId, origin);
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId,
      providerConfigId: 'volcengine', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory });
    unbind();
    const replacementId = `media-message-${crypto.randomUUID()}`;
    const releaseReplacement = bindNativeMediaOrigin(context.canvasId, replacementId, origin);
    try {
      await expect(prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: replacementId,
        providerConfigId: 'volcengine', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory })).rejects.toThrow('已有未结算');
    } finally { releaseReplacement(); }
    await recordNativeMediaSubmission(prepared.operationId, prepared.lease, { taskId: 'original-remote-id' }, { factory });
    const resumed = await claimNativeMediaRecovery(prepared.operationId, { ...context, runtimeEpoch: 'runtime-after-restart' }, { factory });
    expect(resumed.origin).toEqual(origin);
    const delivered = await commitNativeMediaMessageDelivery(resumed, 'media/result.mp4', { factory });
    expect(delivered).toMatchObject({ status: 'delivered', resultRelativePath: 'media/result.mp4', remoteTaskId: 'original-remote-id' });
    expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0].nodes).toEqual([]);
    expect(await commitNativeMediaMessageDelivery(resumed, 'media/result.mp4', { factory })).toEqual(delivered);
    await expect(commitNativeMediaMessageDelivery(resumed, 'media/other.mp4', { factory })).rejects.toThrow();
  });
  it('GRSAI 任务冻结查询协议摘要，缺失或非法摘要不建立付费占位', async () => {
    const context = await fixture();
    const input = { context, operationId: crypto.randomUUID(), nodeId: 'grsai-node', providerConfigId: 'grsai',
      providerBase: 'https://example.test/v1', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' as const };
    await expect(prepareNativeMediaTask(input, { factory })).rejects.toThrow();
    const record = await prepareNativeMediaTask({ ...input, protocolDigest: 'c'.repeat(64) }, { factory });
    expect(record.protocolDigest).toBe('c'.repeat(64));
  });
  it('远端回执可跨运行时原身份续查；新租约撤销旧租约，不可重复提交', async () => {
    const context = await fixture(), operationId = crypto.randomUUID();
    const prepared = await prepareNativeMediaTask({ context, operationId, nodeId: 'node-1', providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory });
    await expect(prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node-1', providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory })).rejects.toThrow('已有未结算');
    const submitted = await recordNativeMediaSubmission(operationId, prepared.lease, { taskId: 'remote-1' }, { factory });
    const resumed = await claimNativeMediaRecovery(operationId, { ...context, runtimeEpoch: 'runtime-2' }, { factory });
    expect(resumed.remoteTaskId).toBe('remote-1');
    expect(await isNativeMediaLeaseCurrent(submitted, { factory })).toBe(false);
    expect(await isNativeMediaLeaseCurrent(resumed, { factory })).toBe(true);
    expect((await listNativeMediaTasks(context.projectId, { factory }))[0].remoteTaskId).toBe('remote-1');
    await expect(claimNativeMediaRecovery(operationId, { ...context, canvasEpoch: context.canvasEpoch + 1 }, { factory })).rejects.toThrow('原画布身份');
  });
  it('用户核对未知提交后仅解除本机防重，并保留随后到达的远端 ID', async () => {
    const context = await fixture();
    const task = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node',
      providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory });
    await reviewNativeMediaTask(task.operationId, context, { factory });
    const late = await recordNativeMediaSubmission(task.operationId, task.lease, { taskId: 'late-id' }, { factory });
    expect(late).toMatchObject({ status: 'reviewed', remoteTaskId: 'late-id' });
    await expect(prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node',
      providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory })).resolves.toMatchObject({ status: 'prepared' });
    await expect(claimNativeMediaRecovery(task.operationId, context, { factory })).rejects.toThrow('已有后续任务');
  });
  it('确认远端失败后保留 ID 并解除本机防重', async () => {
    const context = await fixture();
    const task = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node',
      providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory });
    const submitted = await recordNativeMediaSubmission(task.operationId, task.lease, { taskId: 'remote-id' }, { factory });
    await failNativeMediaTask(submitted, { factory });
    expect((await listNativeMediaTasks(context.projectId, { factory }))[0]).toMatchObject({ status: 'failed', remoteTaskId: 'remote-id' });
  });
  it('用户核对后可结束已提交任务跟踪，保留原 ID 且不能越过后续任务恢复', async () => {
    const context = await fixture();
    const task = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'deleted-node',
      providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory });
    const submitted = await recordNativeMediaSubmission(task.operationId, task.lease, { taskId: 'original-remote-id' }, { factory });
    await reviewNativeMediaTask(task.operationId, context, { factory });
    expect((await listNativeMediaTasks(context.projectId, { factory }))[0]).toMatchObject({ status: 'reviewed', remoteTaskId: 'original-remote-id' });
    expect(await isNativeMediaLeaseCurrent(submitted, { factory })).toBe(false);
    await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'deleted-node',
      providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'b'.repeat(64), sourceCanvasRevision: 0, category: 'video' }, { factory });
    await expect(claimNativeMediaRecovery(task.operationId, context, { factory })).rejects.toThrow('已有后续任务');
  });
  it('持久化图片字节身份，仅接受保存画布中的原图片连线', async () => {
    const context = await fixture(), sha256 = 'b'.repeat(64);
    const saved = await saveNativeCanvas({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch,
      canvasId: context.canvasId, episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
      document: { nodes: [{ id: 'video', data: { type: 'ai-video' } }, { id: 'image', data: { type: 'source-image', relativePath: `media/${sha256}.png` } }],
        edges: [{ id: 'edge', source: 'image', target: 'video' }], groups: [] } }, { factory });
    const imageReference = { sourceNodeId: 'image', relativePath: `media/${sha256}.png`, sha256, bytes: 100, mimeType: 'image/png' as const };
    const base = { context, nodeId: 'video', providerConfigId: 'volcengine', providerBase: 'https://example.test',
      inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: saved.revision, category: 'video' as const };
    await expect(prepareNativeMediaTask({ ...base, operationId: crypto.randomUUID(), imageReference: { ...imageReference, sourceNodeId: 'wrong' } }, { factory })).rejects.toThrow();
    const row = await prepareNativeMediaTask({ ...base, operationId: crypto.randomUUID(), imageReference }, { factory });
    expect(row.imageReference).toEqual(imageReference);
  });
  it('结果和任务回执同事务写入，旧租约及其他节点改动被拒绝', async () => {
    const context = await fixture();
    const initial = await saveNativeCanvas({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch,
      canvasId: context.canvasId, episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
      document: { nodes: [{ id: 'node-1', data: { type: 'ai-video', status: 'idle' } },
        { id: 'node-2', data: { type: 'ai-text', text: '原文' } }], edges: [], groups: [] } }, { factory });
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node-1',
      providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: initial.revision, category: 'video' }, { factory });
    const submitted = await recordNativeMediaSubmission(prepared.operationId, prepared.lease, { taskId: 'remote-1' }, { factory });
    const resumed = await claimNativeMediaRecovery(submitted.operationId, { ...context, runtimeEpoch: 'runtime-2' }, { factory });
    const document = { nodes: [{ id: 'node-1', data: { type: 'ai-video', status: 'success', videoUrl: 'video.mp4', relativePath: 'video.mp4' } },
      { id: 'node-2', data: { type: 'ai-text', text: '原文' } }], edges: [], groups: [] };
    await expect(commitNativeMediaDelivery({ record: submitted, expectedCanvasRevision: initial.revision, expectedAssetsRevision: 0, document }, { factory })).rejects.toThrow();
    const wrong = { ...document, nodes: [document.nodes[0], { id: 'node-2', data: { type: 'ai-text', text: '不应覆盖' } }] };
    await expect(commitNativeMediaDelivery({ record: resumed, expectedCanvasRevision: initial.revision, expectedAssetsRevision: 0, document: wrong }, { factory })).rejects.toThrow();
    const result = await commitNativeMediaDelivery({ record: resumed, expectedCanvasRevision: initial.revision, expectedAssetsRevision: 0, document }, { factory });
    expect(result).toMatchObject({ canvasRevision: initial.revision + 1, alreadyCommitted: false, record: { status: 'delivered' } });
    expect(await commitNativeMediaDelivery({ record: resumed, expectedCanvasRevision: initial.revision, expectedAssetsRevision: 0, document }, { factory }))
      .toMatchObject({ alreadyCommitted: true });
    expect((await readNativeProjectCapture(context.projectId, { factory }))!.aggregate.canvases[0].nodes).toEqual(document.nodes);
  });
  it('未知提交和待续任务不阻止整作品删除，原回执与迟到 ID 保留且不能写回已删除画布', async () => {
    const context = await fixture();
    const saved = await saveNativeCanvas({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch,
      canvasId: context.canvasId, episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
      document: { nodes: ['node-1', 'node-2'].map((id) => ({ id, data: { type: 'ai-video' } })), edges: [], groups: [] } }, { factory });
    const first = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node-1', providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: saved.revision, category: 'video' }, { factory });
    const unknown = await recordNativeMediaSubmission(first.operationId, first.lease, { unknown: true }, { factory });
    await expect(claimNativeMediaRecovery(first.operationId, context, { factory })).rejects.toThrow();
    const second = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'node-2', providerConfigId: 'provider', providerBase: 'https://example.test', inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: saved.revision, category: 'video' }, { factory });
    const before = (await readNativeProjectCapture(context.projectId, { factory }))!;
    const deletion = { projectId: context.projectId, expectedProjectEpoch: context.projectEpoch, expectedChangeRevision: before.changeRevision };
    await expect(deleteNativeProject({ ...deletion, expectedChangeRevision: before.changeRevision + 1 }, { factory })).rejects.toThrow('project-version-conflict');
    expect(await readNativeProjectCapture(context.projectId, { factory })).toEqual(before);
    await deleteNativeProject(deletion, { factory });
    expect(await readNativeProjectCapture(context.projectId, { factory })).toBeNull();
    const retained = await listNativeMediaTasks(context.projectId, { factory });
    expect(retained).toHaveLength(2);
    expect(retained).toEqual(expect.arrayContaining([unknown, second]));
    await expect(assertNativeMediaPrepared(second, { factory })).rejects.toThrow('原媒体任务或画布已变化');
    const received = await recordNativeMediaSubmission(second.operationId, second.lease, { taskId: 'late-remote-id' }, { factory });
    expect(received.remoteTaskId).toBe('late-remote-id');
    expect(await isNativeMediaLeaseCurrent(received, { factory })).toBe(false);
    await expect(claimNativeMediaRecovery(second.operationId, context, { factory })).rejects.toThrow('原画布身份');
    const document = { nodes: [{ id: 'node-1', data: { type: 'ai-video' } },
      { id: 'node-2', data: { type: 'ai-video', videoUrl: 'media/result.mp4', relativePath: 'media/result.mp4' } }], edges: [], groups: [] };
    await expect(commitNativeMediaDelivery({ record: received, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document }, { factory })).rejects.toThrow('canvas-not-in-project');
    await expect(createNativeProject({ name: '不能复用已删除身份', projectId: context.projectId, canvasId: context.canvasId }, { factory })).rejects.toThrow('retired-identity');
    expect((await listNativeMediaTasks(context.projectId, { factory })).find((row) => row.operationId === second.operationId)).toEqual(received);
  });
  it('完整本机图片尚未回填时也可删除作品，保留产物摘要且重启不能恢复到已删除画布', async () => {
    const context = await fixture();
    const saved = await saveNativeCanvas({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch,
      canvasId: context.canvasId, episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: 0,
      document: { nodes: [{ id: 'image', data: { type: 'ai-image' } }], edges: [], groups: [] } }, { factory });
    const prepared = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId: 'image', category: 'image',
      providerConfigId: 'provider', providerBase: 'https://example.test', modelRef: 'general/model', protocolDigest: 'c'.repeat(64),
      submissionKind: 'sync', fingerprintScheme: 'media-input-v2', requestFingerprint: 'b'.repeat(64),
      inputFingerprint: 'a'.repeat(64), sourceCanvasRevision: saved.revision }, { factory });
    const localResult = { relativePath: `media/${'d'.repeat(64)}.png`, bytes: 10, sha256: 'd'.repeat(64) };
    const ready = await retainNativeMediaLocalResult(prepared, localResult, { factory });
    const before = (await readNativeProjectCapture(context.projectId, { factory }))!;
    expect(await isNativeMediaLeaseCurrent(ready, { factory })).toBe(true);
    await deleteNativeProject({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch, expectedChangeRevision: before.changeRevision }, { factory });
    expect(await readNativeProjectCapture(context.projectId, { factory })).toBeNull();
    expect(await listNativeMediaTasks(context.projectId, { factory })).toEqual([ready]);
    expect(await isNativeMediaLeaseCurrent(ready, { factory })).toBe(false);
    await expect(claimNativeMediaRecovery(ready.operationId, { ...context, runtimeEpoch: 'restart' }, { factory })).rejects.toThrow('原画布身份');
    const document = { nodes: [{ id: 'image', data: { type: 'ai-image', imageUrl: localResult.relativePath, relativePath: localResult.relativePath } }], edges: [], groups: [] };
    await expect(commitNativeMediaDelivery({ record: ready, expectedCanvasRevision: saved.revision, expectedAssetsRevision: 0, document }, { factory })).rejects.toThrow('canvas-not-in-project');
    expect(await listNativeMediaTasks(context.projectId, { factory })).toEqual([ready]);
  });
});
