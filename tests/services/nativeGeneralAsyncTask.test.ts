/** 通用无profile合同保留原ID／所有候选；HTTP、IO及最终视图投递均为隔离替身。 */
import { createHash, webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import { createNativeProject, saveNativeCanvas } from '../../src/services/indexedDb/nativeProjectRepository';
import { listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';

const driver = vi.hoisted(() => ({ context: undefined as CanvasContext | undefined, state: {} as Record<string, unknown>, revision: 0,
  fetch: vi.fn(), save: vi.fn(), capture: vi.fn(), deliver: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state, subscribe: () => () => {} } }));
vi.mock('../../src/services/projectExecutionContext', async (original) => ({
  ...await original<typeof import('../../src/services/projectExecutionContext')>(), captureLegacyCanvasContext: () => driver.context,
  isProjectExpectedContextCurrent: (context: CanvasContext) => context.canvasId === driver.context?.canvasId && context.runtimeEpoch === driver.context?.runtimeEpoch,
}));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: () => true,
  captureNativeVideoSubmissionBaseline: async () => ({ inputFingerprint: 'a'.repeat(64), canvasRevision: driver.revision }),
  assertNativeVideoSubmissionInput: async () => {},
}));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: driver.fetch }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: driver.save }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: async () => {}, captureNativeMediaLocalResult: driver.capture }));
vi.mock('../../src/services/nativeVolcengineRecovery', () => ({ resumeNativeVolcengineTask: driver.deliver }));

import { executeNativeGeneralAsyncTask, resumeNativeGeneralAsyncTask, nativeGeneralTaskIds, nativeGeneralTaskUrls } from '../../src/services/nativeGeneralAsyncTask';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto);
  driver.fetch.mockReset(); driver.deliver.mockReset().mockResolvedValue(undefined);
  driver.save.mockReset().mockImplementation(async (url: string) => ({ filePath: `/isolated/${createHash('sha256').update(url).digest('hex')}.wav`, assetUrl: 'asset://synthetic' }));
  driver.capture.mockReset().mockImplementation(async (_canvasId: string, path: string) => {
    const sha256 = path.split('/').at(-1)!.replace(/\.wav$/, ''); return { relativePath: `media/${sha256}.wav`, sha256, bytes: 10 };
  });
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const root = await createNativeProject({ name: '通用音频隔离项目' });
  const canvas = await saveNativeCanvas({ projectId: root.project.id, canvasId: root.canvas!.id, episodeId: null,
    expectedProjectEpoch: root.project.epoch, expectedCanvasEpoch: root.canvas!.epoch, expectedCanvasRevision: 0,
    document: { nodes: [{ id: 'audio', type: 'ai-audio', position: { x: 0, y: 0 }, data: { type: 'ai-audio', model: 'general/model', prompt: '合成输入' } }], edges: [], groups: [] } });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId: root.project.id, canvasId: canvas.id,
    projectEpoch: root.project.epoch, canvasEpoch: canvas.epoch, canvasRevision: canvas.revision, episodeId: null, runtimeEpoch: 'initial-view' };
  driver.context = context; driver.revision = canvas.revision;
  driver.state = { currentProjectId: canvas.id, projectExecutionContext: context, nodes: canvas.nodes,
    config: { providers: { custom: { apiKey: 'synthetic-key', baseUrl: 'https://general.example/v1' } },
      generalModels: [{ id: 'model', name: '合成音频', modelId: 'remote-audio', category: 'audio', providerConfigId: 'custom' }] } };
  return { context, input: { apiKey: 'synthetic-key', baseUrl: 'https://general.example/v1', modelName: 'remote-audio', prompt: '合成输入',
    resultField: 'audios' as const, providerConfigId: 'custom', nodeId: 'audio', modelRef: 'general/model', beforeSubmit: async () => {} } };
}
it('完整解析多个原ID与每项多个URL，不能悄悄省略无效候选', () => {
  expect(nativeGeneralTaskIds({ data: [{ task_id: 'original-a' }, { task_id: 'original-b' }], task_id: 'original-a' })).toEqual(['original-a', 'original-b']);
  expect(nativeGeneralTaskUrls({ result: { audios: [{ url: ['https://cdn.example/a.wav', 'https://cdn.example/b.wav'] }, { url: 'https://cdn.example/c.wav' }] } }, 'audios')).toHaveLength(3);
  expect(nativeGeneralTaskUrls({ data: [{ url: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] }, { b64_json: 'AQID' }] }, 'images')).toHaveLength(3);
  expect(() => nativeGeneralTaskUrls({ audios: [{ url: 'https://cdn.example/a.wav' }, {}] }, 'audios')).toThrow('候选');
});
it('正常提交在POST前已有未知意图，所有原task和候选保存后自动投递', async () => {
  const { context, input } = await fixture();
  driver.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      expect((await listNativeMediaTasks(context.projectId))[0].status).toBe('outcome-unknown');
      return Response.json({ data: [{ task_id: 'task-a' }, { task_id: 'task-b' }] });
    }
    return Response.json({ data: { status: 'completed', result: { audios: [{ url: `${url.includes('task-a') ? 'https://cdn.example/a' : 'https://cdn.example/b'}.wav` }] } } });
  });
  await expect(executeNativeGeneralAsyncTask(input)).rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(record.pollContext).toEqual({ taskIds: ['task-a', 'task-b'] }); expect(record.localResults).toHaveLength(2);
  expect(record.completion).toEqual({ taskCount: 2, failedTasks: 0 }); expect(driver.deliver).toHaveBeenCalledWith(record.operationId, expect.any(AbortSignal));
  expect(driver.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('一个原任务失败时仍保存其余全部已确认候选，并单独冻结失败计数', async () => {
  const { context, input } = await fixture();
  driver.fetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ data: [{ task_id: 'task-good' }, { task_id: 'task-bad' }] })
    : url.includes('task-bad') ? Response.json({ status: 'failed' }) : Response.json({ status: 'completed', result: { audios: [{ url: ['https://cdn.example/a.wav', 'https://cdn.example/b.wav'] }] } }));
  await expect(executeNativeGeneralAsyncTask(input)).rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(record.localResults).toHaveLength(2); expect(record.completion).toEqual({ taskCount: 2, failedTasks: 1 });
  expect(record.pollContext).toEqual({ taskIds: ['task-good', 'task-bad'] });
});
it('inline同步响应切集后先保存原根，重启无Key仅交付缓存且不伪造远端ID', async () => {
  const { context, input } = await fixture();
  driver.fetch.mockImplementation(async () => { driver.context = { ...context, runtimeEpoch: 'switched-view' };
    return Response.json({ data: [{ url: 'https://cdn.example/a.wav' }, { url: 'https://cdn.example/b.wav' }] }); });
  await expect(executeNativeGeneralAsyncTask(input)).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(record.submissionKind).toBe('sync'); expect(record.remoteTaskId).toBeUndefined(); expect(record.localResults).toHaveLength(2);
  expect(driver.deliver).not.toHaveBeenCalled();
  driver.context = { ...context, runtimeEpoch: 'after-restart' }; driver.state.config = { providers: {}, generalModels: [] };
  await resumeNativeGeneralAsyncTask(record.operationId);
  expect(driver.deliver).toHaveBeenCalledWith(record.operationId, undefined); expect(driver.fetch).toHaveBeenCalledOnce();
});
it('提交结果未知时保留原操作，续接不会重新POST', async () => {
  const { context, input } = await fixture(); driver.fetch.mockRejectedValue(new Error('network unavailable'));
  await expect(executeNativeGeneralAsyncTask(input)).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId); expect(record.status).toBe('outcome-unknown');
  await expect(resumeNativeGeneralAsyncTask(record.operationId)).rejects.toThrow('未知'); expect(driver.fetch).toHaveBeenCalledOnce();
});
