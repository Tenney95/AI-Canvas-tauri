/** 工作流正常自动交付与重启恢复；只有隔离数据库、网络／文件替身。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { ComfyOutputs } from '../../src/services/comfyOutputs';
const driver = vi.hoisted(() => ({ state: {} as Record<string, unknown>, listeners: new Set<() => void>(), persist: vi.fn(),
  read: vi.fn(), capture: vi.fn(), query: vi.fn(), project: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state,
  subscribe: (listener: () => void) => { driver.listeners.add(listener); return () => driver.listeners.delete(listener); } } }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: driver.persist }));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: (guard: unknown) => typeof guard === 'function',
  captureNativeVideoSubmissionBaseline: async () => ({ inputFingerprint: 'a'.repeat(64), canvasRevision: 0 }), assertNativeVideoSubmissionInput: async () => {} }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: driver.read, captureNativeMediaLocalResult: driver.capture }));
vi.mock('../../src/services/nativeMediaMessages', () => ({ projectNativeMediaMessages: driver.project }));
vi.mock('../../src/services/comfyPolling', () => ({ pollComfyHistory: driver.query, comfyFetch: vi.fn() }));

import { createNativeProject } from '../../src/services/indexedDb/nativeProjectRepository';
import { prepareNativeMediaTask, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { bindNativeMediaOrigin } from '../../src/services/nativeMediaOrigin';
import { createNativeWorkflowReceipt, beginNativeWorkflowSubmission, retainNativeWorkflowSubmission, retainNativeWorkflowTaskOutputs } from '../../src/services/nativeWorkflowRepository';
import { nativeWorkflowDigest, nativeComfyOutputs, submitNativeWorkflowTask, resumeNativeWorkflowTask, isNativeWorkflowExecution } from '../../src/services/nativeWorkflowTasks';

const base = 'http://127.0.0.1:8188';
const output = (letter: string) => ({ relativePath: `media/${letter.repeat(64)}.png`, bytes: 12, sha256: letter.repeat(64), category: 'image' as const });
let releases: Array<() => void>;
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto); releases = [];
  driver.listeners.clear(); driver.read.mockReset().mockResolvedValue(undefined); driver.project.mockReset().mockResolvedValue(undefined);
  driver.capture.mockReset().mockImplementation(async (_canvas: string, path: string) => output(path.includes('b') ? 'b' : 'a'));
  driver.persist.mockReset().mockImplementation(async (url: string) => ({ filePath: url.includes('b.png') ? 'b' : 'a' }));
  driver.query.mockReset().mockImplementation(async (_base: string, _taskId: string, _message: string, extract: (outputs: ComfyOutputs) => unknown) =>
    extract({ save: { images: [{ filename: 'a.png', type: 'output' }, { filename: 'b.png', type: 'output' }] } }));
});
afterEach(() => { for (const release of releases) release(); vi.unstubAllGlobals(); });
async function fixture() {
  const aggregate = await createNativeProject({ name: '合成工作流恢复' });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'first-runtime', projectId: aggregate.project.id,
    canvasId: aggregate.canvas!.id, episodeId: null, projectEpoch: aggregate.project.epoch, canvasEpoch: aggregate.canvas!.epoch, canvasRevision: 0 };
  const workflow = { id: 'workflow-fixture', name: '合成图片', category: 'ai-image', adapterType: 'comfyui', fileContent: '{}' };
  driver.state = { currentProjectId: context.canvasId, projectExecutionContext: context, projectLoadStatus: 'ready', nodes: [], edges: [],
    workflows: [workflow], config: { comfyUIUrl: base, providers: {} }, projects: [] };
  const nodeId = `media-message-${crypto.randomUUID()}`;
  releases.push(bindNativeMediaOrigin(context.canvasId, nodeId, { conversationId: 'original-conversation', messageId: 'original-message', deliveryMode: 'chat' },
    { material: 'original-input', assertCurrent: () => {} }));
  const descriptor = { adapter: 'comfyui' as const, connectionId: 'comfyui', providerBase: base, category: 'image' as const, workflowId: workflow.id,
    digest: await nativeWorkflowDigest(['comfyui-native-media-v1', workflow.id, workflow.fileContent, undefined, 'image']) };
  return { context, nodeId, descriptor };
}
it('正常提交后自动查询全部候选并交付原对话，不要求再点恢复且只提交一次', async () => {
  const { context, nodeId, descriptor } = await fixture();
  const submit = vi.fn(async () => ({ taskId: 'original-prompt' }));
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: { prompt: 'only hashed' }, beforeSubmit: () => {}, submit }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  expect(submit).toHaveBeenCalledTimes(1); expect(driver.query).toHaveBeenCalledTimes(1);
  const record = (await listNativeMediaTasks(context.projectId))[0];
  expect(record).toMatchObject({ status: 'delivered', remoteTaskId: 'original-prompt', origin: { messageId: 'original-message' } });
  expect(record.localResults).toEqual([output('a'), output('b')]);
});
it('任务候选已保存后重启可在原workflow和凭据均移除时离线交付，不重复POST或查询', async () => {
  const { context, nodeId, descriptor } = await fixture();
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId, providerConfigId: 'comfyui', providerBase: base,
    category: 'image', fingerprintScheme: 'media-input-v3', requestFingerprint: 'b'.repeat(64), protocolDigest: descriptor.digest,
    inputFingerprint: 'a'.repeat(64), modelRef: 'workflow/workflow-fixture', sourceCanvasRevision: 0,
    recovery: { kind: 'workflow', workflowId: descriptor.workflowId, digest: descriptor.digest } });
  let receipt = await createNativeWorkflowReceipt(record, descriptor, 1);
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[0].id));
  ({ record, receipt } = await retainNativeWorkflowSubmission(record, receipt.submissions[0].id, { taskId: 'persisted-original-prompt' }));
  ({ record } = await retainNativeWorkflowTaskOutputs(record, 'persisted-original-prompt', { outputs: [output('a'), output('b')] }));
  driver.state = { ...driver.state, workflows: [], config: { providers: {} }, projectExecutionContext: { ...context, runtimeEpoch: 'restarted-runtime' } };
  await resumeNativeWorkflowTask(record.operationId);
  expect(driver.query).not.toHaveBeenCalled(); expect(driver.persist).not.toHaveBeenCalled();
  expect((await listNativeMediaTasks(context.projectId))[0]).toMatchObject({ status: 'delivered', localResults: [output('a'), output('b')] });
});
it('响应丢失保留未知提交，恢复不能再次POST或盲查；切到另一集不能交付', async () => {
  const { context, nodeId, descriptor } = await fixture();
  const submit = vi.fn(async () => { throw new Error('connection lost'); });
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: () => {}, submit })).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const record = (await listNativeMediaTasks(context.projectId))[0]; expect(record.status).toBe('outcome-unknown');
  await expect(resumeNativeWorkflowTask(record.operationId)).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  driver.state = { ...driver.state, currentProjectId: `c2-${crypto.randomUUID()}`, projectExecutionContext: { ...context, canvasId: `c2-${crypto.randomUUID()}` } };
  await expect(resumeNativeWorkflowTask(record.operationId)).rejects.toThrow();
  expect(submit).toHaveBeenCalledTimes(1); expect(driver.query).not.toHaveBeenCalled(); expect(driver.persist).not.toHaveBeenCalled();
});
it('Comfy正式输出收齐多候选，视频不接收预览PNG，输出路径必须通过共同校验', () => {
  const outputs = { preview: { images: [{ filename: 'preview.png', type: 'temp' }] }, save: { images: [
    { filename: 'frame-a.png', type: 'output' }, { filename: 'frame-b.png', type: 'output' }, { filename: '../outside.png', type: 'output' },
    { filename: 'movie.mp4', type: 'output' }] } };
  expect(nativeComfyOutputs(base, outputs, 'image')).toHaveLength(2);
  expect(nativeComfyOutputs(base, outputs, 'video')).toEqual([{ kind: 'video', url: `${base}/view?filename=movie.mp4&type=output` }]);
});

it('引用准备后切到旧项目，原native守卫仍要求新仓储失败关闭，不降级成旧请求', async () => {
  const { context, nodeId, descriptor } = await fixture();
  driver.state = { ...driver.state, projectExecutionContext: { ...context, modelGeneration: 0 } };
  const guard = () => {}, submit = vi.fn(async () => ({ taskId: 'must-not-submit' }));
  expect(isNativeWorkflowExecution(guard)).toBe(true);
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: guard, submit })).rejects.toThrow('守卫');
  expect(submit).not.toHaveBeenCalled(); expect(driver.query).not.toHaveBeenCalled();
});
