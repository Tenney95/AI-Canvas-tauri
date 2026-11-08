/** 原图片合同闭环：真实隔离IDB回执/交付，网络、文件和界面守卫替身。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';
type FixtureState = { currentProjectId: string; projectExecutionContext: CanvasContext; nodes: unknown[]; messages: unknown[]; config: { providers: Record<string, { apiKey?: string; baseUrl?: string }> } };
const io = vi.hoisted(() => ({ context: null as unknown as CanvasContext, state: null as unknown as FixtureState,
  listeners: new Set<() => void>(), query: vi.fn(), invoke: vi.fn(), dispatcher: vi.fn(), fetch: vi.fn(), files: new Map<string, string>(),
  polling: new AbortController(), legacySave: vi.fn(), legacyRemove: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => io.state,
  subscribe: (listener: () => void) => { io.listeners.add(listener); return () => { io.listeners.delete(listener); }; } } }));
vi.mock('../../src/services/projectExecutionContext', () => ({ captureLegacyCanvasContext: () => io.context,
  isProjectExpectedContextCurrent: (context: CanvasContext) => context.canvasId === io.context.canvasId && context.runtimeEpoch === io.context.runtimeEpoch }));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: () => true,
  captureNativeVideoSubmissionBaseline: async () => ({ inputFingerprint: 'a'.repeat(64), canvasRevision: 1 }), assertNativeVideoSubmissionInput: vi.fn(async () => {}) }));
vi.mock('../../src/services/ai/modelProtocol', async (original) => ({ ...await original<typeof import('../../src/services/ai/modelProtocol')>(), pollResolvedModelProtocol: io.query }));
vi.mock('../../src/services/ai/httpTransport', () => ({ logAiRequest: vi.fn(), corsSafeFetch: io.fetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke, convertFileSrc: (path: string) => `asset://local/${path}` }));
vi.mock('../../src/services/pollManager', () => ({ savePendingTask: io.legacySave, updatePendingTask: vi.fn(), removePendingTask: io.legacyRemove,
  registerNodePolling: () => io.polling.signal, cleanupNodePolling: vi.fn(), getVideoEditorTransitionAnchor: () => undefined }));
vi.mock('../../src/services/fileService', () => ({ persistMediaUrlToProjectData: async (url: string) => {
  if (!io.files.has(url)) io.files.set(url, `media/${String.fromCharCode(97 + io.files.size).repeat(64)}.png`);
  return { filePath: io.files.get(url)! }; } }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: vi.fn(async () => {}),
  captureNativeMediaLocalResult: async (_canvas: string, path: string) => ({ relativePath: path, bytes: 10, sha256: path.slice(6, 70) }) }));
vi.mock('../../src/services/nativeVolcengineRecovery', () => ({ resumeNativeVolcengineTask: io.dispatcher }));
import { createNativeProject, saveNativeCanvas, readNativeProjectCapture } from '../../src/services/indexedDb/nativeProjectRepository';
import { claimNativeMediaRecovery, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { commitNativeMediaDelivery } from '../../src/services/nativeMediaDelivery';
import { buildNativeMediaCollectionCanvas } from '../../src/services/nativeMediaCollectionCanvas';
import { runNativeBuiltinImageTask, resumeNativeBuiltinImageTask } from '../../src/services/nativeBuiltinImageTask';
import { generateDreaminaImage } from '../../src/services/dreaminaService';
import { PollTaskFailedError } from '../../src/services/pollTask';
import { generateImageStandardBatch } from '../../src/services/ai/providers/standardImage';

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
  io.listeners.clear(); io.files.clear(); io.query.mockReset(); io.invoke.mockReset(); io.dispatcher.mockReset(); io.fetch.mockReset();
  io.legacySave.mockClear(); io.legacyRemove.mockClear(); io.polling = new AbortController();
  const root = await createNativeProject({ name: '隔离图片合同' });
  io.context = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'fixture-runtime', projectId: root.project.id,
    projectEpoch: root.project.epoch, canvasId: root.canvas!.id, canvasEpoch: root.canvas!.epoch, canvasRevision: 1, episodeId: null };
  const nodes = [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', prompt: '原输入' } }];
  await saveNativeCanvas({ projectId: root.project.id, canvasId: root.canvas!.id, episodeId: null, expectedProjectEpoch: root.project.epoch,
    expectedCanvasEpoch: root.canvas!.epoch, expectedCanvasRevision: 0, document: { nodes, edges: [], groups: [] } });
  io.state = { currentProjectId: io.context.canvasId, projectExecutionContext: io.context, nodes, messages: [],
    config: { providers: { fixture: { apiKey: 'fixture-test-only', baseUrl: 'https://fixture.example' } } } };
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

it('原生入口准备后切到旧项目仍保留原提交租约，不回退旧路径发POST', async () => {
  io.context = { ...io.context, modelGeneration: 0 }; io.state.projectExecutionContext = io.context;
  await expect(generateImageStandardBatch({ apiKey: 'fixture-test-only', baseUrl: 'https://fixture.example', modelName: 'image-model',
    prompt: '原输入', dimensions: { width: 1024, height: 1024 }, nodeId: 'source', providerConfigId: 'fixture', beforeSubmit: async () => {} }, 1))
    .rejects.toThrow('原生媒体');
  expect(io.fetch).not.toHaveBeenCalled(); expect(io.legacySave).not.toHaveBeenCalled();
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
