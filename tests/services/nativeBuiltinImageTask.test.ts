/** 原图片合同闭环：真实隔离IDB回执/交付，网络、文件和界面守卫替身。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { BaseNodeData } from '../../src/types';
import type { NativeMediaSubmissionPreparation } from '../../src/types/media';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';
type FixtureState = { currentProjectId: string; projectExecutionContext: CanvasContext; nodes: unknown[]; messages: unknown[]; config: { providers: Record<string, { apiKey?: string; baseUrl?: string }> };
  beginNativeMediaSubmissionPreparation: (context: CanvasContext) => Promise<NativeMediaSubmissionPreparation>;
  updateNodeDataTransient: (nodeId: string, data: Partial<BaseNodeData>) => void;
  commitNativeMediaResult: (record: NativeMediaTaskRecord, path: string, context: CanvasContext, signal?: AbortSignal) => Promise<void> };
const io = vi.hoisted(() => ({ context: null as unknown as CanvasContext, state: null as unknown as FixtureState,
  listeners: new Set<() => void>(), query: vi.fn(), invoke: vi.fn(), dispatcher: vi.fn(), fetch: vi.fn(), files: new Map<string, string>(),
  polling: new AbortController(), legacySave: vi.fn(), legacyRemove: vi.fn(), assertInput: vi.fn(), readLocal: vi.fn(), captureLocal: vi.fn(),
  canvasRevision: 1, preparationReleased: vi.fn(), updateTransient: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => io.state,
  subscribe: (listener: () => void) => { io.listeners.add(listener); return () => { io.listeners.delete(listener); }; } } }));
vi.mock('../../src/services/projectExecutionContext', () => ({ captureLegacyCanvasContext: () => io.context,
  isProjectExpectedContextCurrent: (context: CanvasContext) => context.canvasId === io.context.canvasId && context.runtimeEpoch === io.context.runtimeEpoch }));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: () => true,
  captureNativeVideoSubmissionBaseline: async () => ({ inputFingerprint: 'a'.repeat(64), canvasRevision: io.canvasRevision }), assertNativeVideoSubmissionInput: io.assertInput }));
vi.mock('../../src/services/ai/modelProtocol', async (original) => ({ ...await original<typeof import('../../src/services/ai/modelProtocol')>(), pollResolvedModelProtocol: io.query }));
vi.mock('../../src/services/ai/httpTransport', () => ({ logAiRequest: vi.fn(), corsSafeFetch: io.fetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke, convertFileSrc: (path: string) => `asset://local/${path}` }));
vi.mock('../../src/services/pollManager', () => ({ savePendingTask: io.legacySave, updatePendingTask: vi.fn(), removePendingTask: io.legacyRemove,
  registerNodePolling: () => io.polling.signal, cleanupNodePolling: vi.fn(), getVideoEditorTransitionAnchor: () => undefined,
  resumeNativeMediaLocalDelivery: vi.fn(async () => {}) }));
vi.mock('../../src/services/fileService', () => ({ persistMediaUrlToProjectData: async (url: string) => {
  if (!io.files.has(url)) io.files.set(url, `media/${String.fromCharCode(97 + io.files.size).repeat(64)}.png`);
  return { filePath: io.files.get(url)! }; } }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: io.readLocal,
  captureNativeMediaLocalResult: io.captureLocal }));
vi.mock('../../src/services/nativeVolcengineRecovery', () => ({ resumeNativeVolcengineTask: io.dispatcher }));
import { createNativeProject, saveNativeCanvas, readNativeProjectCapture, EXCHANGE, openNativeProjectDatabase, transact } from '../../src/services/indexedDb/nativeProjectRepository';
import { claimNativeMediaRecovery, listNativeMediaTasks, prepareNativeMediaTask, recordNativeMediaSubmission, reviewNativeMediaTask } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { retainNativeMediaOutputs } from '../../src/services/indexedDb/nativeMediaCollectionRepository';
import { commitNativeMediaDelivery } from '../../src/services/nativeMediaDelivery';
import { buildNativeMediaCollectionCanvas } from '../../src/services/nativeMediaCollectionCanvas';
import { runNativeBuiltinImageTask, resumeNativeBuiltinImageTask } from '../../src/services/nativeBuiltinImageTask';
import { generateDreaminaImage } from '../../src/services/dreaminaService';
import { PollTaskFailedError } from '../../src/services/pollTask';
import { generateImageStandardBatch } from '../../src/services/ai/providers/standardImage';
import { resumeNativeMediaLocalResults } from '../../src/services/nativeMediaAutoDelivery';

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
  io.listeners.clear(); io.files.clear(); io.query.mockReset(); io.invoke.mockReset(); io.dispatcher.mockReset(); io.fetch.mockReset();
  io.assertInput.mockReset().mockResolvedValue(undefined); io.readLocal.mockReset().mockResolvedValue(undefined);
  io.captureLocal.mockReset().mockImplementation(async (_canvas: string, path: string) => ({ relativePath: path, bytes: 10, sha256: path.slice(6, 70) }));
  io.legacySave.mockClear(); io.legacyRemove.mockClear(); io.polling = new AbortController();
  io.canvasRevision = 1; io.preparationReleased.mockClear(); io.updateTransient.mockReset();
  const root = await createNativeProject({ name: '隔离图片合同' });
  io.context = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'fixture-runtime', projectId: root.project.id,
    projectEpoch: root.project.epoch, canvasId: root.canvas!.id, canvasEpoch: root.canvas!.epoch, canvasRevision: 1, episodeId: null };
  const nodes = [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', prompt: '原输入' } }];
  await saveNativeCanvas({ projectId: root.project.id, canvasId: root.canvas!.id, episodeId: null, expectedProjectEpoch: root.project.epoch,
    expectedCanvasEpoch: root.canvas!.epoch, expectedCanvasRevision: 0, document: { nodes, edges: [], groups: [] } });
  io.state = { currentProjectId: io.context.canvasId, projectExecutionContext: io.context, nodes, messages: [],
    config: { providers: { fixture: { apiKey: 'fixture-test-only', baseUrl: 'https://fixture.example' } } },
    updateNodeDataTransient: io.updateTransient,
    beginNativeMediaSubmissionPreparation: async (context) => {
      let released = false;
      const assertCurrent = () => {
        if (released || context.projectId !== io.context.projectId || context.canvasId !== io.context.canvasId
          || context.projectEpoch !== io.context.projectEpoch || context.canvasEpoch !== io.context.canvasEpoch
          || context.episodeId !== io.context.episodeId || context.runtimeEpoch !== io.context.runtimeEpoch) throw new Error('原画布准备租约已变化');
      };
      assertCurrent();
      const current = (await readNativeProjectCapture(context.projectId))!.aggregate.canvases.find((canvas) => canvas.id === context.canvasId)!;
      const saved = await saveNativeCanvas({ projectId: context.projectId, canvasId: context.canvasId, episodeId: context.episodeId,
        expectedProjectEpoch: context.projectEpoch, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: current.revision,
        document: { nodes: io.state.nodes, edges: current.edges, groups: current.groups } });
      assertCurrent(); io.canvasRevision = saved.revision;
      return { context, canvasRevision: saved.revision, assertCurrent,
        release: () => { if (!released) { released = true; io.preparationReleased(); } } };
    },
    commitNativeMediaResult: async (record) => {
      const capture = await readNativeProjectCapture(io.context.projectId), canvas = capture!.aggregate.canvases[0];
      await commitNativeMediaDelivery({ record, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0,
        document: buildNativeMediaCollectionCanvas(canvas, record) });
    } };
  io.updateTransient.mockImplementation((nodeId: string, data: Partial<BaseNodeData>) => {
    io.state.nodes = io.state.nodes.map((node) => {
      const current = node as { id: string; data: BaseNodeData };
      return current.id === nodeId ? { ...current, data: { ...current.data, ...data } } : node;
    });
  });
  io.dispatcher.mockImplementation(async (operationId: string) => {
    const record = await claimNativeMediaRecovery(operationId, io.context);
    const capture = await readNativeProjectCapture(io.context.projectId), canvas = capture!.aggregate.canvases[0];
    await commitNativeMediaDelivery({ record, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0,
      document: buildNativeMediaCollectionCanvas(canvas, record) });
  });
});
afterEach(() => vi.unstubAllGlobals());
const standard = (execute: Parameters<typeof runNativeBuiltinImageTask>[0]['execute']) => runNativeBuiltinImageTask({ nodeId: 'source',
  mode: 'standard', modelId: 'image-model', connectionId: 'fixture', baseUrl: 'https://fixture.example', requestMaterial: ['frozen-input'], beforeSubmit: async () => {}, execute });

async function cccFreezeFailure(nodeId = 'source', taskIds = ['original-ccc-task']) {
  let posts = 0;
  io.query.mockResolvedValue({ urls: ['https://fixture.example/returned-image'] });
  io.captureLocal.mockRejectedValueOnce(new Error('原生冻结路径校验失败'));
  await expect(runNativeBuiltinImageTask({ nodeId, mode: 'ccc', modelId: 'ccc-model', connectionId: 'fixture',
    baseUrl: 'https://fixture.example', requestMaterial: ['frozen-input'], beforeSubmit: async () => {}, execute: async (beforePost) => {
      await beforePost(); posts++; return { taskIds };
    } })).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const record = (await listNativeMediaTasks(io.context.projectId)).find((row) => row.nodeId === nodeId)!;
  expect(record).toMatchObject({ status: 'submitted', remoteTaskId: taskIds[0] });
  expect(record.localResults).toBeUndefined(); expect(io.files.size).toBe(1);
  io.query.mockClear(); io.dispatcher.mockClear();
  return { record, posts };
}

it('已下载但冻结失败的原CCC任务自动只GET取回，统一投递且不新建或重发生成', async () => {
  const { record, posts } = await cccFreezeFailure();
  await resumeNativeMediaLocalResults(io.context.canvasId);
  expect(io.query).not.toHaveBeenCalled();
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(posts).toBe(1); expect(io.query).toHaveBeenCalledOnce();
  expect(io.query).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET',
    url: 'https://fixture.example/tasks/original-ccc-task', maxAttempts: 1, maxDurationMs: 15_000 }), expect.any(String), expect.any(AbortSignal), 'https://fixture.example');
  expect(await listNativeMediaTasks(io.context.projectId)).toEqual([expect.objectContaining({ operationId: record.operationId, status: 'delivered' })]);
  expect(io.dispatcher).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});

it('原CCC单次续取仍未完成时保留原submitted，下一次画布事件可以继续同一原ID', async () => {
  const { record } = await cccFreezeFailure();
  io.query.mockRejectedValueOnce(new Error('原任务仍在等待'));
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect((await listNativeMediaTasks(io.context.projectId))[0]).toMatchObject({ operationId: record.operationId, status: 'submitted' });
  expect(io.query).toHaveBeenCalledOnce(); io.query.mockClear();
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(io.query).toHaveBeenCalledOnce(); expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe('delivered');
});

it('原CCC查询等待期间切集会取消回填，保留原任务且不覆盖当前画布', async () => {
  const { record } = await cccFreezeFailure(); const original = io.context;
  const commit = vi.fn(io.state.commitNativeMediaResult); io.state.commitNativeMediaResult = commit;
  io.query.mockImplementationOnce(async () => {
    io.context = { ...original, canvasId: `c2-${crypto.randomUUID()}`, runtimeEpoch: 'other-canvas' };
    io.state.projectExecutionContext = io.context; io.state.currentProjectId = io.context.canvasId;
    io.listeners.forEach((listener) => listener()); return { urls: ['https://fixture.example/late-image'] };
  });
  await resumeNativeMediaLocalResults(original.canvasId, { allowOriginalCccTaskQuery: true }).catch(() => undefined);
  expect(commit).not.toHaveBeenCalled();
  expect((await listNativeMediaTasks(original.projectId))[0]).toMatchObject({ operationId: record.operationId, status: 'submitted' });
  expect(io.query).toHaveBeenCalledOnce(); expect(io.fetch).not.toHaveBeenCalled();
});

it('让新就绪节点优先后仍续取其余原CCC任务，不丢掉已排队的查询', async () => {
  await cccFreezeFailure();
  io.state.nodes = [...io.state.nodes, { id: 'second', type: 'ai-image', position: { x: 400, y: 0 }, data: { type: 'ai-image', prompt: '第二个原输入' } }];
  await cccFreezeFailure('second', ['second-ccc-task']);
  let notified = false;
  io.query.mockImplementation(async () => {
    if (!notified) {
      notified = true;
      void resumeNativeMediaLocalResults(io.context.canvasId, { nodeId: 'another-ready-node', allowOriginalCccTaskQuery: true }).catch(() => undefined);
    }
    return { urls: ['https://fixture.example/returned-image'] };
  });
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(io.query).toHaveBeenCalledTimes(2);
  expect((await listNativeMediaTasks(io.context.projectId)).map((record) => record.status)).toEqual(['delivered', 'delivered']);
  expect(io.fetch).not.toHaveBeenCalled();
});

it('结束跟踪后保留已返回文件，但不继续GET多任务集合的下一项或回填', async () => {
  const { record } = await cccFreezeFailure('source', ['original-ccc-task', 'later-ccc-task']);
  const commit = vi.fn(io.state.commitNativeMediaResult); io.state.commitNativeMediaResult = commit;
  io.query.mockImplementationOnce(async () => {
    await reviewNativeMediaTask(record.operationId, io.context);
    return { urls: ['https://fixture.example/late-returned-image'] };
  });
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(commit).not.toHaveBeenCalled(); expect(io.query).toHaveBeenCalledOnce();
  expect((await listNativeMediaTasks(io.context.projectId))[0]).toMatchObject({ operationId: record.operationId, status: 'reviewed' });
  expect(io.files.has('https://fixture.example/late-returned-image')).toBe(true); expect(io.fetch).not.toHaveBeenCalled();
});

async function oldInlineUnknown(keepInline: boolean) {
  io.dispatcher.mockRejectedValue(new Error('原视图暂不可提交'));
  io.state.commitNativeMediaResult = vi.fn(async () => { throw new Error('原视图暂不可提交'); });
  await expect(standard(async (beforePost) => { await beforePost(); return { urls: ['https://fixture.example/original'] }; }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const current = (await listNativeMediaTasks(io.context.projectId))[0];
  const db = await openNativeProjectDatabase(false, {}); if (!db) throw new Error('fixture database missing');
  const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
  });
  try { await transact(db, 'readwrite', {}, async (tx) => {
    const store = tx.objectStore(EXCHANGE);
    const sidecar = await request(store.get(`builtin-image-task:${current.operationId}`));
    await request(store.put({ ...current, status: 'outcome-unknown', localResults: undefined, resultRelativePath: undefined }));
    await request(store.put({ ...sidecar, state: 'unknown', ...(keepInline ? {} : { inlineOutputs: undefined }) }));
  }, [EXCHANGE], true); } finally { db.close(); }
  io.context = { ...io.context, runtimeEpoch: 'after-restart' }; io.state.projectExecutionContext = io.context;
  io.state.config.providers = {};
  io.query.mockClear(); io.invoke.mockClear(); io.fetch.mockClear(); io.readLocal.mockClear();
  const commit = vi.fn(async (record: NativeMediaTaskRecord) => {
    const capture = await readNativeProjectCapture(io.context.projectId), canvas = capture!.aggregate.canvases[0];
    await commitNativeMediaDelivery({ record, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0,
      document: buildNativeMediaCollectionCanvas(canvas, record) });
  });
  io.state.commitNativeMediaResult = commit;
  return { record: current, commit };
}

it('旧catch误降unknown但私有inline字节完整时，重启后离线自动回填，不查询或重发', async () => {
  const { record, commit } = await oldInlineUnknown(true);
  await resumeNativeMediaLocalResults(io.context.canvasId);
  expect(commit).toHaveBeenCalledOnce(); expect(io.readLocal).toHaveBeenCalled();
  expect((await listNativeMediaTasks(io.context.projectId))[0]).toMatchObject({ operationId: record.operationId, status: 'delivered' });
  expect(io.query).not.toHaveBeenCalled(); expect(io.invoke).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it('retain的SHA核验故障不把已知inline降成提交未知，原字节恢复后仅本机回填', async () => {
  let posts = 0; io.readLocal.mockRejectedValue(new Error('原文件暂不可读'));
  await expect(standard(async (beforePost) => { await beforePost(); posts++; return { urls: ['https://fixture.example/retained'] }; }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending', localResultAvailable: true });
  expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe('prepared');
  io.readLocal.mockResolvedValue(undefined);
  await resumeNativeMediaLocalResults(io.context.canvasId);
  expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe('delivered'); expect(posts).toBe(1);
  expect(io.query).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it('待回填节点手动选历史图后重开，原输入相同也保留用户success图且不提升旧inline', async () => {
  const { commit } = await oldInlineUnknown(true);
  const node = io.state.nodes[0] as { data: Record<string, unknown> };
  node.data = { ...node.data, status: 'success', imageUrl: 'https://fixture.example/history', output: 'https://fixture.example/history', artifactId: undefined };
  const before = (await listNativeMediaTasks(io.context.projectId))[0];
  await resumeNativeMediaLocalResults(io.context.canvasId);
  expect(commit).not.toHaveBeenCalled(); expect(io.readLocal).not.toHaveBeenCalled();
  expect(node.data.imageUrl).toBe('https://fixture.example/history'); expect((await listNativeMediaTasks(io.context.projectId))[0]).toEqual(before);
});
it('SHA等待期间用户选历史图会撤销自动回填，loading到paused不会自行撤销', async () => {
  const { commit } = await oldInlineUnknown(true);
  const node = io.state.nodes[0] as { data: Record<string, unknown> };
  node.data = { ...node.data, status: 'loading', imageUrl: 'https://fixture.example/previous' };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  io.readLocal.mockImplementation(async () => { enter(); await gate; });
  const restoring = resumeNativeMediaLocalResults(io.context.canvasId); await entered;
  node.data = { ...node.data, status: 'idle', mediaTaskState: 'paused' }; io.listeners.forEach((listener) => listener());
  node.data = { ...node.data, status: 'success', imageUrl: 'https://fixture.example/history', output: 'https://fixture.example/history', artifactId: undefined };
  io.listeners.forEach((listener) => listener()); release(); await restoring.catch(() => undefined);
  expect(commit).not.toHaveBeenCalled(); expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe('outcome-unknown');
});
it.each(['mattingMask', 'annotation', 'annotationLayer'] as const)('SHA等待期间用户保存%s会撤销自动回填并保留编辑', async (field) => {
  const { commit } = await oldInlineUnknown(true);
  const node = io.state.nodes[0] as { data: Record<string, unknown> };
  node.data = { ...node.data, status: 'loading', imageUrl: 'https://fixture.example/previous' };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  io.readLocal.mockImplementation(async () => { enter(); await gate; });
  const restoring = resumeNativeMediaLocalResults(io.context.canvasId); await entered;
  const edit = { fixture: 'new-layer' };
  node.data = { ...node.data, [field]: edit }; io.listeners.forEach((listener) => listener());
  release(); await restoring.catch(() => undefined);
  expect(commit).not.toHaveBeenCalled(); expect(node.data[field]).toBe(edit);
  expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe('outcome-unknown');
  expect(io.query).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it('磁盘虽有文件但unknown没有完整私有inline回执时不猜测结果，也不取得交付租约', async () => {
  const { commit } = await oldInlineUnknown(false);
  const before = (await listNativeMediaTasks(io.context.projectId))[0];
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(commit).not.toHaveBeenCalled(); expect(io.readLocal).not.toHaveBeenCalled();
  expect((await listNativeMediaTasks(io.context.projectId))[0]).toEqual(before);
  expect(io.query).not.toHaveBeenCalled(); expect(io.invoke).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each(['input', 'sha'] as const)('已有inline缓存的%s证据变化时不提升unknown、不回填', async (changed) => {
  const { commit } = await oldInlineUnknown(true);
  const before = (await listNativeMediaTasks(io.context.projectId))[0];
  if (changed === 'input') io.assertInput.mockRejectedValue(new Error('原输入已变化'));
  else io.readLocal.mockRejectedValue(new Error('原字节摘要已变化'));
  await resumeNativeMediaLocalResults(io.context.canvasId);
  expect(commit).not.toHaveBeenCalled(); expect((await listNativeMediaTasks(io.context.projectId))[0]).toEqual(before);
  expect(io.query).not.toHaveBeenCalled(); expect(io.invoke).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it('忙节点不抢原租约；真实释放事件再次请求后只交付一次完整缓存', async () => {
  const { commit } = await oldInlineUnknown(true);
  const busy = vi.fn(() => true);
  await resumeNativeMediaLocalResults(io.context.canvasId, { nodeId: 'source', isNodeBusy: busy });
  expect(commit).not.toHaveBeenCalled(); busy.mockReturnValue(false);
  await Promise.all([resumeNativeMediaLocalResults(io.context.canvasId, { nodeId: 'source', isNodeBusy: busy }),
    resumeNativeMediaLocalResults(io.context.canvasId, { nodeId: 'source', isNodeBusy: busy })]);
  expect(commit).toHaveBeenCalledOnce(); expect(io.query).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each(['failed', 'delivered'] as const)('较新同输入尝试已%s时，旧submitted缓存不能领取租约或覆盖后继', async (status) => {
  const { record, commit } = await oldInlineUnknown(true);
  const writeOld = async (row: NativeMediaTaskRecord) => {
    const db = await openNativeProjectDatabase(false, {}); if (!db) throw new Error('fixture database missing');
    try { await transact(db, 'readwrite', {}, async (tx) => {
      const request = tx.objectStore(EXCHANGE).put(row);
      await new Promise<void>((resolve, reject) => { request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }, [EXCHANGE], true); } finally { db.close(); }
  };
  const reviewed = { ...record, status: 'reviewed' as const, revision: record.revision + 1 };
  await writeOld(reviewed);
  const previous = (await readNativeProjectCapture(io.context.projectId))!.aggregate.canvases[0];
  const saved = await saveNativeCanvas({ projectId: io.context.projectId, canvasId: io.context.canvasId, episodeId: null,
    expectedProjectEpoch: io.context.projectEpoch, expectedCanvasEpoch: io.context.canvasEpoch,
    expectedCanvasRevision: previous.revision, document: { nodes: previous.nodes, edges: previous.edges, groups: previous.groups } });
  let next = await prepareNativeMediaTask({ context: io.context, operationId: crypto.randomUUID(), nodeId: record.nodeId,
    category: 'image', submissionKind: 'sync', providerConfigId: record.providerConfigId, providerBase: record.providerBase,
    inputFingerprint: record.inputFingerprint, sourceCanvasRevision: saved.revision, fingerprintScheme: record.fingerprintScheme,
    modelRef: record.modelRef, protocolDigest: record.protocolDigest, requestFingerprint: record.requestFingerprint, recovery: record.recovery });
  expect(next.sourceCanvasRevision).toBeGreaterThan(record.sourceCanvasRevision);
  if (status === 'failed') await recordNativeMediaSubmission(next.operationId, next.lease, { notStarted: true });
  else {
    next = await retainNativeMediaOutputs(next, record.localResults!);
    const canvas = (await readNativeProjectCapture(io.context.projectId))!.aggregate.canvases[0];
    await commitNativeMediaDelivery({ record: next, expectedCanvasRevision: canvas.revision, expectedAssetsRevision: 0,
      document: buildNativeMediaCollectionCanvas(canvas, next) });
  }
  // 兼容历史旧恢复入口曾把较早记录重新标submitted的状态，新的事务门禁必须拒绝它。
  const stale = { ...reviewed, status: 'submitted' as const, revision: reviewed.revision + 1 }; await writeOld(stale);
  await resumeNativeMediaLocalResults(io.context.canvasId);
  expect(commit).not.toHaveBeenCalled();
  await expect(claimNativeMediaRecovery(stale.operationId, io.context)).rejects.toThrow('后续尝试');
  expect(io.query).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each(['reviewed', 'failed'] as const)('已%s的原任务即使仍有私有完整inline也不自动恢复', async (status) => {
  const { record, commit } = await oldInlineUnknown(true);
  const db = await openNativeProjectDatabase(false, {}); if (!db) throw new Error('fixture database missing');
  try { await transact(db, 'readwrite', {}, async (tx) => {
    const request = tx.objectStore(EXCHANGE).get(record.projectId);
    const current = await new Promise<NativeMediaTaskRecord>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as NativeMediaTaskRecord); request.onerror = () => reject(request.error);
    });
    const write = tx.objectStore(EXCHANGE).put({ ...current, status });
    await new Promise<void>((resolve, reject) => { write.onsuccess = () => resolve(); write.onerror = () => reject(write.error); });
  }, [EXCHANGE], true); } finally { db.close(); }
  io.readLocal.mockClear(); await resumeNativeMediaLocalResults(io.context.canvasId);
  expect(commit).not.toHaveBeenCalled(); expect(io.readLocal).not.toHaveBeenCalled();
  expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe(status);
});
it('本机SHA核验等待时切集或换运行代次，旧inline不提升、不跨集投影', async () => {
  const { commit } = await oldInlineUnknown(true), original = io.context;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  io.readLocal.mockImplementation(async () => { enter(); await gate; });
  const restoring = resumeNativeMediaLocalResults(original.canvasId);
  await entered;
  io.context = { ...original, canvasId: `c2-${crypto.randomUUID()}`, runtimeEpoch: 'other-canvas' };
  io.state.currentProjectId = io.context.canvasId; io.state.projectExecutionContext = io.context;
  io.listeners.forEach((listener) => listener()); release(); await restoring.catch(() => undefined);
  expect(commit).not.toHaveBeenCalled(); expect((await listNativeMediaTasks(original.projectId))[0].status).toBe('outcome-unknown');
  expect(io.query).not.toHaveBeenCalled(); expect(io.invoke).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});

it('原生入口准备后切到旧项目仍保留原提交租约，不回退旧路径发POST', async () => {
  io.context = { ...io.context, modelGeneration: 0 }; io.state.projectExecutionContext = io.context;
  await expect(generateImageStandardBatch({ apiKey: 'fixture-test-only', baseUrl: 'https://fixture.example', modelName: 'image-model',
    prompt: '原输入', dimensions: { width: 1024, height: 1024 }, nodeId: 'source', providerConfigId: 'fixture', beforeSubmit: async () => {} }, 1))
    .rejects.toThrow('原生媒体');
  expect(io.fetch).not.toHaveBeenCalled(); expect(io.legacySave).not.toHaveBeenCalled();
});

it('CCC明确内容拒绝结算failed后，用户以相同输入再次生成取得新版本且只发送一次新POST', async () => {
  const message = 'Non posso generare questa immagine per motivi di sicurezza.';
  const params = { apiKey: 'fixture-test-only', baseUrl: 'https://fixture.example', modelName: 'image-model', prompt: '原输入',
    dimensions: { width: 1024, height: 1024 }, nodeId: 'source', providerConfigId: 'fixture', asyncTaskProvider: 'cccapi' as const,
    beforeSubmit: async () => {} };
  io.fetch.mockImplementationOnce(async () => {
    expect(io.preparationReleased).toHaveBeenCalledTimes(1);
    return new Response(JSON.stringify({ data: [{ error: { code: 'content_policy_violation', message } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await expect(generateImageStandardBatch(params, 1)).rejects.toMatchObject({ message, definitiveFailure: true });
  const [failed] = await listNativeMediaTasks(io.context.projectId);
  expect(failed.status).toBe('failed'); expect(io.fetch).toHaveBeenCalledOnce();
  io.fetch.mockImplementationOnce(async () => {
    expect(io.preparationReleased).toHaveBeenCalledTimes(2);
    return new Response(JSON.stringify({ data: [{ url: 'https://fixture.example/manual-retry' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await expect(generateImageStandardBatch(params, 1)).rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  const records = await listNativeMediaTasks(io.context.projectId), delivered = records.find((record) => record.status === 'delivered')!;
  expect(records).toHaveLength(2); expect(records.find((record) => record.operationId === failed.operationId)?.status).toBe('failed');
  expect(delivered.sourceCanvasRevision).toBeGreaterThan(failed.sourceCanvasRevision);
  expect(delivered.inputFingerprint).toBe(failed.inputFingerprint); expect(io.fetch).toHaveBeenCalledTimes(2);
  expect(io.query).not.toHaveBeenCalled(); expect(io.legacySave).not.toHaveBeenCalled();
});

it('CCC原任务一次查询确认失败后停止自动续查，保留失败回执且不重新提交', async () => {
  let submissions = 0;
  const protocol = await vi.importActual<typeof import('../../src/services/ai/modelProtocol')>('../../src/services/ai/modelProtocol');
  io.query.mockImplementation(protocol.pollResolvedModelProtocol);
  io.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'failed', error: { message: '服务商已确认任务失败' } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await expect(runNativeBuiltinImageTask({ nodeId: 'source', mode: 'ccc', modelId: 'ccc-model', connectionId: 'fixture',
    baseUrl: 'https://fixture.example', requestMaterial: ['frozen-input'], beforeSubmit: async () => {},
    execute: async (beforePost) => { await beforePost(); submissions++; return { taskIds: ['original-failed-task'] }; },
  })).rejects.toThrow('原任务均已确认失败');
  const [record] = await listNativeMediaTasks(io.context.projectId);
  expect(record).toMatchObject({ status: 'failed', remoteTaskId: 'original-failed-task' });
  expect(io.query).toHaveBeenCalledOnce();
  expect(io.query).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET',
    url: 'https://fixture.example/tasks/original-failed-task' }), expect.any(String), expect.any(AbortSignal), 'https://fixture.example');
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(submissions).toBe(1); expect(io.query).toHaveBeenCalledOnce(); expect(io.dispatcher).not.toHaveBeenCalled();
  expect(io.fetch).toHaveBeenCalledExactlyOnceWith('https://fixture.example/tasks/original-failed-task', expect.objectContaining({ method: 'GET' }));
  expect((await listNativeMediaTasks(io.context.projectId))[0]).toMatchObject({ operationId: record.operationId, status: 'failed' });
});

it('CCC提交结果未知且没有原任务ID或本机产物时，原画布恢复事件不发GET或重新提交', async () => {
  let submissions = 0;
  await expect(runNativeBuiltinImageTask({ nodeId: 'source', mode: 'ccc', modelId: 'ccc-model', connectionId: 'fixture',
    baseUrl: 'https://fixture.example', requestMaterial: ['frozen-input'], beforeSubmit: async () => {},
    execute: async (beforePost) => { await beforePost(); submissions++; throw new TypeError('连接在提交后中断'); },
  })).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(io.context.projectId);
  expect(record.status).toBe('outcome-unknown'); expect(record.remoteTaskId).toBeUndefined(); expect(record.localResults).toBeUndefined();
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  await resumeNativeMediaLocalResults(io.context.canvasId, { allowOriginalCccTaskQuery: true });
  expect(submissions).toBe(1); expect(io.query).not.toHaveBeenCalled(); expect(io.dispatcher).not.toHaveBeenCalled();
  expect((await listNativeMediaTasks(io.context.projectId))[0]).toMatchObject({ operationId: record.operationId, status: 'outcome-unknown' });
});

it.each(['guard', 'cancel'] as const)('真实POST前%s失败结算未发出回执并释放准备租约', async (failure) => {
  let guards = 0, posts = 0;
  const controller = new AbortController();
  await expect(runNativeBuiltinImageTask({ nodeId: 'source', mode: 'standard', modelId: 'image-model', connectionId: 'fixture',
    baseUrl: 'https://fixture.example', requestMaterial: ['frozen-input'], signal: controller.signal,
    beforeSubmit: async () => { if (++guards === 2 && failure === 'guard') throw new Error('原输入已变化'); },
    execute: async (beforePost) => { if (failure === 'cancel') controller.abort(); await beforePost(); posts++; return { urls: ['https://fixture.example/unreachable'] }; },
  })).rejects.toThrow();
  expect(posts).toBe(0); expect(io.preparationReleased).toHaveBeenCalledOnce();
  expect((await listNativeMediaTasks(io.context.projectId))[0].status).toBe('failed');
});

it('单POST实际返回全部候选后才报完成，不按请求数量截断、不补隐式POST', async () => {
  let posts = 0;
  await expect(standard(async (beforePost) => { await beforePost(); posts++; return { urls: ['https://fixture.example/a', 'https://fixture.example/b'] }; }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  expect(posts).toBe(1);
  const record = (await listNativeMediaTasks(io.context.projectId))[0];
  expect(record.status).toBe('delivered'); expect(record.localResults).toHaveLength(2); expect(record.remoteTaskId).toBeUndefined();
  expect((await readNativeProjectCapture(io.context.projectId))!.aggregate.canvases[0].nodes).toHaveLength(2);
});

it('付费返回后切集只保留原本机集合，重开原集不需要API Key或再次POST', async () => {
  const original = io.context; let posts = 0;
  await expect(standard(async (beforePost) => {
    await beforePost(); posts++; io.context = { ...original, canvasId: `c2-${crypto.randomUUID()}` };
    io.listeners.forEach((listener) => listener()); return { urls: ['https://fixture.example/a', 'https://fixture.example/b'] };
  })).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const retained = (await listNativeMediaTasks(original.projectId))[0]; expect(retained.localResults).toHaveLength(2); expect(retained.status).toBe('submitted');
  io.context = { ...original, runtimeEpoch: 'after-restart' }; io.state.projectExecutionContext = io.context;
  io.state.config.providers = {};
  await resumeNativeBuiltinImageTask(retained.operationId);
  expect(posts).toBe(1); expect((await listNativeMediaTasks(original.projectId))[0].status).toBe('delivered');
});

it('CCC全部原task结算，已确认失败不掩盖其余任务的多个候选', async () => {
  io.query.mockResolvedValueOnce({ urls: ['https://fixture.example/a', 'https://fixture.example/b'] }).mockRejectedValueOnce(new PollTaskFailedError('confirmed failure'));
  await expect(runNativeBuiltinImageTask({ nodeId: 'source', mode: 'ccc', modelId: 'ccc-model', connectionId: 'fixture', baseUrl: 'https://fixture.example',
    expectedCount: 1, requestMaterial: ['input'], beforeSubmit: async () => {}, execute: async (beforePost) => { await beforePost(); return { taskIds: ['task-one', 'task-two'] }; } }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  const record = (await listNativeMediaTasks(io.context.projectId))[0];
  expect(record.localResults).toHaveLength(2); expect(record.completion).toEqual({ taskCount: 2, failedTasks: 1 });
  expect(io.query).toHaveBeenCalledTimes(2);
});
it('服务商回显当前Key作为taskID时只保留未知意图，不把凭据写入回执', async () => {
  await expect(runNativeBuiltinImageTask({ nodeId: 'source', mode: 'ccc', modelId: 'ccc-model', connectionId: 'fixture', baseUrl: 'https://fixture.example',
    requestMaterial: ['input'], beforeSubmit: async () => {}, execute: async (beforePost) => { await beforePost(); return { taskIds: ['fixture-test-only'] }; } }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const record = (await listNativeMediaTasks(io.context.projectId))[0];
  expect(record.status).toBe('outcome-unknown'); expect(record.remoteTaskId).toBeUndefined();
  expect(JSON.stringify(record)).not.toContain('fixture-test-only'); expect(io.query).not.toHaveBeenCalled();
});

it('Dreamina等待取消后仍保存迟到submitId，重启仅query全部outputs，旧pending队列不变', async () => {
  let resolve!: (value: { submitId: string }) => void;
  const delayed = new Promise<{ submitId: string }>((done) => { resolve = done; });
  io.invoke.mockImplementation(async (command: string) => command === 'dreamina_generate' ? delayed
    : { status: 'success', outputs: [{ url: 'https://fixture.example/a', localPath: '' }, { url: 'https://fixture.example/b', localPath: '' }], failReason: '' });
  const controller = new AbortController();
  const operation = generateDreaminaImage({ nodeId: 'source', model: 'dreamina/4.0', prompt: '原输入', imageUrls: [], beforeSubmit: async () => {} }, controller.signal);
  await vi.waitFor(() => expect(io.invoke).toHaveBeenCalledWith('dreamina_generate', expect.any(Object)));
  const pending = expect(operation).rejects.toMatchObject({ name: 'NativeMediaTaskPending' }); controller.abort(); await pending;
  resolve({ submitId: 'original-cli-task' });
  await vi.waitFor(async () => expect((await listNativeMediaTasks(io.context.projectId))[0].remoteTaskId).toBe('original-cli-task'));
  const record: NativeMediaTaskRecord = (await listNativeMediaTasks(io.context.projectId))[0];
  io.context = { ...io.context, runtimeEpoch: 'after-restart' }; io.state.projectExecutionContext = io.context;
  await resumeNativeBuiltinImageTask(record.operationId);
  expect((await listNativeMediaTasks(io.context.projectId))[0].localResults).toHaveLength(2);
  expect(io.invoke.mock.calls.filter(([command]) => command === 'dreamina_generate')).toHaveLength(1);
  expect(io.legacySave).not.toHaveBeenCalled(); expect(io.legacyRemove).not.toHaveBeenCalled();
});
