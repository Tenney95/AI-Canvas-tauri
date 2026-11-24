/** 工作流正常自动交付与重启恢复；只有隔离数据库、网络／文件替身。 */
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { CanvasContext } from '../../src/types/project';
import type { ComfyOutputs } from '../../src/services/comfyOutputs';
import type { NativeMediaSubmissionPreparation } from '../../src/types/media';
const driver = vi.hoisted(() => ({ state: {} as Record<string, unknown>, listeners: new Set<() => void>(), persist: vi.fn(),
  read: vi.fn(), capture: vi.fn(), query: vi.fn(), memoryFetch: vi.fn(), project: vi.fn(), beginPreparation: vi.fn(),
  preparations: [] as Array<NativeMediaSubmissionPreparation & { release: ReturnType<typeof vi.fn> }> }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => driver.state,
  subscribe: (listener: () => void) => { driver.listeners.add(listener); return () => driver.listeners.delete(listener); } } }));
vi.mock('../../src/services/fileService', async (original) => ({ ...await original<typeof import('../../src/services/fileService')>(), persistMediaUrlToProjectData: driver.persist }));
vi.mock('../../src/services/nativeVideoSubmission', () => ({ isNativeVideoSubmissionGuard: (guard: unknown) => typeof guard === 'function',
  captureNativeVideoSubmissionBaseline: async (_context: unknown, _nodeId: unknown, _image: unknown, _scheme: unknown,
    options?: { preparation?: NativeMediaSubmissionPreparation }) => {
    options?.preparation?.assertCurrent(); return { inputFingerprint: 'a'.repeat(64), canvasRevision: options?.preparation?.canvasRevision ?? 0 };
  }, assertNativeVideoSubmissionInput: async () => {} }));
vi.mock('../../src/services/nativeMediaLocalResult', () => ({ readNativeMediaLocalResult: driver.read, captureNativeMediaLocalResult: driver.capture }));
vi.mock('../../src/services/nativeMediaMessages', () => ({ projectNativeMediaMessages: driver.project }));
vi.mock('../../src/services/comfyPolling', async (original) => ({
  ...await original<typeof import('../../src/services/comfyPolling')>(), pollComfyHistory: driver.query, comfyFetch: driver.memoryFetch,
}));

import { createNativeProject, readNativeProjectCapture, saveNativeProjectView } from '../../src/services/indexedDb/nativeProjectRepository';
import { claimNativeMediaRecovery, prepareNativeMediaTask, listNativeMediaTasks } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import { bindNativeMediaOrigin } from '../../src/services/nativeMediaOrigin';
import { createNativeWorkflowReceipt, readNativeWorkflowReceipt, beginNativeWorkflowSubmission, retainNativeWorkflowSubmission,
  retainNativeWorkflowTaskOutputs, DYNAMIC_COMFY_WORKFLOW_MODEL_REF, isNativeWorkflowReceiptFor, validateNativeWorkflowReceipt } from '../../src/services/nativeWorkflowRepository';
import { nativeWorkflowDigest, nativeComfyOutputFiles, submitNativeWorkflowTask, resumeNativeWorkflowTask, isNativeWorkflowExecution } from '../../src/services/nativeWorkflowTasks';
import { registerNativeVideoSubmissionGuard } from '../../src/services/nativeVideoSubmissionGuard';

const base = 'http://127.0.0.1:8188';
const output = (letter: string) => ({ relativePath: `media/${letter.repeat(64)}.png`, bytes: 12, sha256: letter.repeat(64), category: 'image' as const });
let releases: Array<() => void>;
function preparation(context: CanvasContext, canvasRevision = 0) {
  let released = false;
  const lease = { context, canvasRevision, release: vi.fn(() => { released = true; }), assertCurrent: () => {
    if (released || driver.state.currentProjectId !== context.canvasId) throw new Error('原准备窗口已释放或画布变化');
  } };
  driver.preparations.push(lease); return lease;
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto); releases = [];
  driver.listeners.clear(); driver.read.mockReset().mockResolvedValue(undefined); driver.project.mockReset().mockResolvedValue(undefined);
  driver.memoryFetch.mockReset();
  driver.preparations = []; driver.beginPreparation.mockReset().mockImplementation(async (context: CanvasContext) => preparation(context));
  driver.capture.mockReset().mockImplementation(async (_canvas: string, path: string) => output(path.includes('b') ? 'b' : 'a'));
  driver.persist.mockReset().mockImplementation(async (url: string) => ({ filePath: url.includes('b.png') ? 'b' : 'a' }));
  driver.query.mockReset().mockImplementation(async (_base: string, _taskId: string, _message: string, extract: (outputs: ComfyOutputs) => unknown) =>
    extract({ save: { images: [{ filename: 'a.png', type: 'output' }, { filename: 'b.png', type: 'output' }] } }));
});
afterEach(() => { for (const release of releases) release(); vi.unstubAllGlobals(); });
async function fixture(category: 'image' | 'video' | 'audio' = 'image') {
  const aggregate = await createNativeProject({ name: '合成工作流恢复' });
  const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, runtimeEpoch: 'first-runtime', projectId: aggregate.project.id,
    canvasId: aggregate.canvas!.id, episodeId: null, projectEpoch: aggregate.project.epoch, canvasEpoch: aggregate.canvas!.epoch, canvasRevision: 0 };
  const workflow = { id: 'workflow-fixture', name: '测试工作流', category: `ai-${category}`, adapterType: 'comfyui', fileContent: '{}' };
  driver.state = { currentProjectId: context.canvasId, projectExecutionContext: context, projectLoadStatus: 'ready', nodes: [], edges: [],
    workflows: [workflow], config: { comfyUIUrl: base, providers: {} }, projects: [], beginNativeMediaSubmissionPreparation: driver.beginPreparation };
  const nodeId = `media-message-${crypto.randomUUID()}`;
  releases.push(bindNativeMediaOrigin(context.canvasId, nodeId, { conversationId: 'original-conversation', messageId: 'original-message', deliveryMode: 'chat' },
    { material: 'original-input', assertCurrent: () => {} }));
  const descriptor = { adapter: 'comfyui' as const, connectionId: 'comfyui', providerBase: base, category, workflowId: workflow.id,
    digest: await nativeWorkflowDigest(['comfyui-native-media-v1', workflow.id, workflow.fileContent, undefined, category]) };
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
it.each([undefined, 'default'])('动态 ComfyUI 续查绑定原服务器 %s，恢复时只取首个同类产物', async (serverId) => {
  const { context, nodeId } = await fixture();
  const otherBase = 'http://127.0.0.1:8189';
  const config = { providers: {}, comfyUIUrl: serverId ? otherBase : base,
    comfyServers: serverId ? [{ id: serverId, name: '指定服务器', url: base }] : [] };
  driver.state = { ...driver.state, workflows: [], config };
  driver.query.mockRejectedValueOnce(new Error('首次查询断开'));
  const requestMaterial = { prompt: { sample: '不落盘的临时工作流' } };
  const descriptor = { dynamic: true as const, adapter: 'comfyui' as const, connectionId: 'comfyui', providerBase: base,
    category: 'image' as const, serverId, digest: await nativeWorkflowDigest(requestMaterial) };
  const submit = vi.fn(async () => ({ taskId: 'original-dynamic-prompt' }));
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial, beforeSubmit: () => {}, submit }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  const receipt = (await readNativeWorkflowReceipt(record.operationId))!;
  expect(record).toMatchObject({ status: 'submitted', modelRef: DYNAMIC_COMFY_WORKFLOW_MODEL_REF, remoteTaskId: 'original-dynamic-prompt' });
  expect(receipt.descriptor).toEqual(descriptor);
  expect(JSON.stringify([record, receipt])).not.toContain('不落盘的临时工作流');
  expect(isNativeWorkflowReceiptFor(receipt, { ...record, modelRef: 'workflow/saved' })).toBe(false);
  expect(() => validateNativeWorkflowReceipt({ ...receipt, descriptor: { ...descriptor, workflowId: 'saved' } })).toThrow();

  driver.state = { ...driver.state, projectExecutionContext: { ...context, runtimeEpoch: 'restarted-runtime' },
    config: serverId ? { ...config, comfyUIUrl: base, comfyServers: [] } : { ...config, comfyUIUrl: otherBase } };
  await expect(resumeNativeWorkflowTask(record.operationId)).rejects.toThrow();
  expect(driver.query).toHaveBeenCalledTimes(1);
  driver.state.config = config;
  await resumeNativeWorkflowTask(record.operationId);
  expect(driver.query).toHaveBeenLastCalledWith(base, 'original-dynamic-prompt', expect.any(String), expect.any(Function), expect.any(AbortSignal));
  expect((await listNativeMediaTasks(context.projectId))[0]).toMatchObject({ status: 'delivered', localResults: [output('a')] });
  expect(submit).toHaveBeenCalledOnce();
});
it('新项目 ComfyUI 视频在落盘前切换保存中，保存失败且 history 清空仍可续取原视频', async () => {
  const { context, descriptor } = await fixture();
  const nodeId = 'video-node', promptId = 'original-video-prompt';
  const video = { id: nodeId, type: 'ai-video', data: { status: 'loading', mediaTaskStage: undefined as string | undefined } };
  const progress: Partial<Record<string, { projectId: string; requestId: string; promptId: string }>> = {
    [nodeId]: { projectId: context.canvasId, requestId: 'original-progress', promptId },
  };
  const clearProgress = vi.fn(() => { delete progress[nodeId]; });
  const commit = vi.fn(async () => {});
  const workflow = { id: descriptor.workflowId, category: 'ai-video', adapterType: 'comfyui', fileContent: '{}' };
  const videoDescriptor = { ...descriptor, category: 'video' as const,
    digest: await nativeWorkflowDigest(['comfyui-native-media-v1', workflow.id, workflow.fileContent, undefined, 'video']) };
  driver.state = { ...driver.state, nodes: [video], workflows: [workflow], comfyNodeProgress: progress, clearComfyNodeProgress: clearProgress,
    updateNodeDataTransient: (_id: string, patch: { mediaTaskStage: string }) => { Object.assign(video.data, patch); }, commitNativeMediaResult: commit };
  driver.query.mockImplementation(async (_base: string, taskId: string, _message: string, extract: (outputs: ComfyOutputs) => unknown) => {
    expect(taskId).toBe(promptId);
    expect(video.data.mediaTaskStage).toBeUndefined();
    return extract({ save: { videos: [{ filename: 'movie.mp4', type: 'output' }] } });
  });
  const file = { ...output('a'), relativePath: `media/${'a'.repeat(64)}.mp4`, category: 'video' as const };
  driver.capture.mockResolvedValue(file);
  driver.persist.mockImplementation(async (url: string) => {
    expect(url).toBe(`${base}/view?filename=movie.mp4&type=output`);
    expect(video.data.mediaTaskStage).toBe('saving');
    expect(progress[nodeId]).toBeUndefined();
    return { filePath: file.relativePath };
  }).mockImplementationOnce(async () => {
    expect(video.data.mediaTaskStage).toBe('saving');
    throw new Error('fixture: save directory temporarily unavailable');
  });
  const submit = vi.fn(async () => ({ taskId: promptId }));
  await expect(submitNativeWorkflowTask({ nodeId, descriptor: videoDescriptor, requestMaterial: {}, beforeSubmit: () => {}, submit }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(record).toMatchObject({ status: 'submitted', remoteTaskId: promptId });
  expect(commit).not.toHaveBeenCalled();
  expect(clearProgress).toHaveBeenCalledExactlyOnceWith(nodeId, 'original-progress');

  driver.query.mockRejectedValue(new Error('history 已清空'));
  video.data.mediaTaskStage = undefined;
  await resumeNativeWorkflowTask(record.operationId);
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ operationId: record.operationId }), file.relativePath,
    context, expect.any(AbortSignal));
  expect(driver.query).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledOnce();
});
it.each([['image', 'images', 'png'], ['video', 'videos', 'mp4'], ['audio', 'audio', 'wav']] as const)(
  '新项目 %s 确认远端产物后按设置释放本机显存，释放响应不阻塞交付', async (category, key, extension) => {
    const { context, nodeId, descriptor } = await fixture(category);
    driver.state.config = { providers: {}, comfyUIUrl: base, comfyMemoryPolicy: 'unload-models' };
    driver.query.mockImplementationOnce(async (_base: string, _id: string, _message: string, extract: (outputs: ComfyOutputs) => unknown) =>
      extract({ save: { [key]: [{ filename: `output.${extension}`, type: 'output' }] } }));
    driver.capture.mockResolvedValue({ ...output('a'), category, relativePath: `media/${'a'.repeat(64)}.${extension}` });
    let finishRelease!: (response: Response) => void;
    driver.memoryFetch.mockResolvedValueOnce(Response.json({ queue_running: [], queue_pending: [] }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finishRelease = resolve; }));
    try {
      await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: () => {},
        submit: async () => ({ taskId: 'original-prompt' }) })).rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
      expect((await listNativeMediaTasks(context.projectId))[0].status).toBe('delivered');
      expect(driver.memoryFetch.mock.calls.map(([url]) => url)).toEqual([`${base}/queue`, `${base}/free`]);
      expect(driver.memoryFetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ unload_models: true, free_memory: false }) });
    } finally { finishRelease(new Response()); }
  },
);
it.each(['execution_error', 'execution_interrupted', 'http-error'] as const)(
  '按原 history 的 %s 判断是否释放显存', async (event) => {
    const { context, nodeId, descriptor } = await fixture();
    driver.state.config = { providers: {}, comfyUIUrl: base, comfyMemoryPolicy: 'free-memory' };
    const { pollComfyHistory } = await vi.importActual<typeof import('../../src/services/comfyPolling')>('../../src/services/comfyPolling');
    driver.query.mockImplementationOnce(pollComfyHistory);
    const transport = await import('../../src/services/ai/httpTransport');
    const request = vi.spyOn(transport, 'corsSafeFetch').mockResolvedValueOnce(event === 'http-error' ? new Response(null, { status: 401 })
      : Response.json({ original: { status: { status_str: 'error', messages: [[event, { exception_message: 'fixture' }]] } } }));
    driver.memoryFetch.mockResolvedValueOnce(Response.json({ queue_running: [], queue_pending: [] })).mockResolvedValueOnce(new Response());
    try {
      await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: () => {},
        submit: async () => ({ taskId: 'original' }) })).rejects.toThrow();
      expect(request.mock.calls[0][0]).toBe(`${base}/history/original`);
      expect((await listNativeMediaTasks(context.projectId))[0].status).toBe(event === 'http-error' ? 'submitted' : 'failed');
      expect(driver.memoryFetch.mock.calls.map(([url]) => url)).toEqual(event === 'execution_error' ? [`${base}/queue`, `${base}/free`] : []);
    } finally { request.mockRestore(); }
  },
);
it('首次下载前已登记全部安全文件描述，重启后只从原 ComfyUI 地址续取同一候选集合', async () => {
  const { context, nodeId, descriptor } = await fixture();
  const config = { providers: {}, comfyUIUrl: base, comfyMemoryPolicy: 'free-memory' };
  driver.state.config = config;
  driver.memoryFetch.mockResolvedValueOnce(Response.json({ queue_running: [], queue_pending: [] }))
    .mockRejectedValueOnce(new Error('释放显存失败'));
  const originalFiles = [{ filename: 'a.png', subfolder: '生成图', type: 'output' }, { filename: 'b.png', type: 'output' }];
  const historyFiles = [{ ...originalFiles[0], url: 'ignored' }, originalFiles[1], { filename: '../outside.png', type: 'output' }];
  driver.query.mockImplementationOnce(async (_base: string, _taskId: string, _message: string, extract: (outputs: ComfyOutputs) => unknown) =>
    extract({ save: { images: historyFiles } }));
  const atFirstDownload = vi.fn();
  driver.persist.mockImplementationOnce(async () => {
    const [record] = await listNativeMediaTasks(context.projectId);
    atFirstDownload((await readNativeWorkflowReceipt(record.operationId))?.tasks);
    throw new Error('下载中断');
  });
  const submit = vi.fn(async () => ({ taskId: 'original-prompt' }));
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: () => {}, submit }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect(atFirstDownload).toHaveBeenCalledExactlyOnceWith([{ taskId: 'original-prompt', state: 'submitted', comfyOutputFiles: originalFiles }]);
  driver.query.mockRejectedValue(new Error('history 已清空'));
  driver.state = { ...driver.state, config: { comfyUIUrl: 'http://127.0.0.1:8189', providers: {} },
    projectExecutionContext: { ...context, runtimeEpoch: 'restarted-runtime' } };
  await expect(resumeNativeWorkflowTask(record.operationId)).rejects.toThrow('原 ComfyUI 工作流或服务已变化');
  expect(driver.persist).toHaveBeenCalledTimes(1);
  driver.state.config = config;
  await resumeNativeWorkflowTask(record.operationId);
  expect(driver.persist.mock.calls.slice(1).map(([url]) => url)).toEqual([
    `${base}/view?filename=a.png&subfolder=${encodeURIComponent('生成图')}&type=output`, `${base}/view?filename=b.png&type=output`]);
  expect((await listNativeMediaTasks(context.projectId))[0]).toMatchObject({ status: 'delivered', localResults: [output('a'), output('b')] });
  expect(driver.query).toHaveBeenCalledOnce();
  expect(driver.memoryFetch.mock.calls.map(([url]) => url)).toEqual([`${base}/queue`, `${base}/free`]);
  expect(submit).toHaveBeenCalledOnce();
});
it('history 返回时租约已被接管，过期任务不能写入文件描述或开始下载', async () => {
  const { context, nodeId, descriptor } = await fixture();
  driver.state.config = { providers: {}, comfyUIUrl: base, comfyMemoryPolicy: 'free-memory' };
  driver.query.mockImplementationOnce(async (_base: string, _id: string, _message: string, extract: (outputs: ComfyOutputs) => unknown) => {
    const [record] = await listNativeMediaTasks(context.projectId);
    await claimNativeMediaRecovery(record.operationId, { ...context, runtimeEpoch: 'new-runtime' });
    return extract({ save: { images: [{ filename: 'old.png', type: 'output' }] } });
  });
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: () => {},
    submit: async () => ({ taskId: 'original-prompt' }) })).rejects.toMatchObject({ name: 'NativeMediaTaskPending' });
  const [record] = await listNativeMediaTasks(context.projectId);
  expect((await readNativeWorkflowReceipt(record.operationId))?.tasks).toEqual([{ taskId: 'original-prompt', state: 'submitted' }]);
  expect(driver.persist).not.toHaveBeenCalled();
  expect(driver.memoryFetch).not.toHaveBeenCalled();
});
it('任务候选已保存后重启可在原workflow和凭据均移除时离线交付，不重复POST或查询', async () => {
  const { context, nodeId, descriptor } = await fixture();
  let record = await prepareNativeMediaTask({ context, operationId: crypto.randomUUID(), nodeId, providerConfigId: 'comfyui', providerBase: base,
    category: 'image', fingerprintScheme: 'media-input-v3', requestFingerprint: 'b'.repeat(64), protocolDigest: descriptor.digest,
    inputFingerprint: 'a'.repeat(64), modelRef: 'workflow/workflow-fixture', sourceCanvasRevision: 0,
    recovery: { kind: 'workflow', workflowId: descriptor.workflowId, digest: descriptor.digest } });
  let receipt = await createNativeWorkflowReceipt(record, descriptor, 1);
  ({ record, receipt } = await beginNativeWorkflowSubmission(record, receipt.submissions[0].id));
  ({ record } = await retainNativeWorkflowSubmission(record, receipt.submissions[0].id, { taskId: 'persisted-original-prompt' }));
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
  expect(nativeComfyOutputFiles(outputs, 'image')).toHaveLength(2);
  expect(nativeComfyOutputFiles(outputs, 'video')).toEqual([{ filename: 'movie.mp4', type: 'output' }]);
});

it('引用准备后切到旧项目，原native守卫仍要求新仓储失败关闭，不降级成旧请求', async () => {
  const { context, nodeId, descriptor } = await fixture();
  driver.state = { ...driver.state, projectExecutionContext: { ...context, modelGeneration: 0 } };
  const guard = registerNativeVideoSubmissionGuard(() => {}), submit = vi.fn(async () => ({ taskId: 'must-not-submit' }));
  expect(isNativeWorkflowExecution(guard)).toBe(true);
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: guard, submit })).rejects.toThrow('守卫');
  expect(submit).not.toHaveBeenCalled(); expect(driver.query).not.toHaveBeenCalled();
});

it('两个POST分别短准备，网络期间同正文自动保存可推进版本且不改原sourceRevision', async () => {
  const { context, nodeId, descriptor } = await fixture();
  const save = async () => {
    const capture = (await readNativeProjectCapture(context.projectId))!, canvas = capture.aggregate.canvases[0];
    return saveNativeProjectView({ projectId: context.projectId, expectedProjectEpoch: context.projectEpoch, canvasId: context.canvasId,
      episodeId: null, expectedCanvasEpoch: context.canvasEpoch, expectedCanvasRevision: canvas.revision,
      document: { nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups } });
  };
  driver.beginPreparation.mockImplementation(async () => preparation(context, (await save()).canvas.revision));
  const submit = vi.fn(async (index: number) => {
    expect(driver.preparations[index].release).toHaveBeenCalledOnce();
    await save(); // 已释放的网络等待窗口可正常自动保存。
    return { taskId: `original-task-${index}` };
  });
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, count: 2, requestMaterial: {}, beforeSubmit: () => {}, submit }))
    .rejects.toMatchObject({ name: 'NativeMediaTaskDelivered' });
  expect(submit).toHaveBeenCalledTimes(2); expect(driver.beginPreparation).toHaveBeenCalledTimes(2);
  expect(driver.preparations.map((lease) => lease.canvasRevision)).toEqual([1, 3]);
  expect((await listNativeMediaTasks(context.projectId))[0]).toMatchObject({ sourceCanvasRevision: 1, status: 'delivered' });
});

it('准备后的guard或sidecar失败均释放短窗口，未发送的主回执不遗留prepared', async () => {
  const { context, nodeId, descriptor } = await fixture();
  const submit = vi.fn(async () => ({ taskId: 'never-submitted' }));
  const guard = vi.fn(() => { if (driver.preparations.length) throw new Error('原输入已变化'); });
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, requestMaterial: {}, beforeSubmit: guard, submit })).rejects.toThrow('原输入已变化');
  expect(driver.preparations[0].release).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  expect((await listNativeMediaTasks(context.projectId))[0].status).toBe('failed');
  await expect(submitNativeWorkflowTask({ nodeId, descriptor, count: 0, requestMaterial: {}, beforeSubmit: () => {}, submit })).rejects.toThrow();
  expect(driver.preparations[1].release).toHaveBeenCalledOnce();
  expect((await listNativeMediaTasks(context.projectId)).every((row) => row.status === 'failed')).toBe(true);
});
