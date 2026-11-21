/**
 * pollManager — 回归测试：polling runtime hot reload identity。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import {
  getPendingTaskCoveredNodeIds,
  getNativeMediaNodeRecovery,
  getPendingTasksForProject,
  readPendingMediaTaskViews,
  registerPendingTaskContextGuard,
  getMediaTaskSnapshot,
  hasPendingMessageMediaTask,
  initializeMediaTaskSnapshot,
  subscribeMediaTasks,
  createOrReusePollManagerRuntime,
  resumePendingTasks,
  savePendingTask,
  pauseVideoNodeTaskOnTimeout,
  prepareVideoNodeGeneration,
  resumeVideoNodeTask,
  bindMediaTaskContext,
  completeMediaNodeTask,
  removeFailedMediaTask,
  getMediaTaskReceipt,
  pauseMediaTask,
  registerMediaNodeOperation,
  registerNodePolling,
  cleanupNodePolling,
  stopPollingForDeletedProjects,
  removePendingTask,
  resumeMediaNodeTask,
  resumeNativeMediaFromNode,
  resumeRunningHubNodeTask,
  readVideoEditorTransitionTaskResult,
  updatePendingTask,
  type PendingTask,
} from '../../src/services/pollManager';
import { PollTimeoutError, PollTaskFailedError } from '../../src/services/pollTask';
import { useAppStore } from '../../src/store/useAppStore';
import type { CanvasContext } from '../../src/types/project';
import type { NativeMediaTaskRecord } from '../../src/services/indexedDb/nativeMediaTaskRepository';
import * as fileService from '../../src/services/fileService';
import * as tauriCore from '@tauri-apps/api/core';
import { registerRuntimeIdentityTests } from './pollManager/runtimeIdentity';
import { registerGenerationDeliveryTests } from './pollManager/generationTaskDelivery';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: vi.fn(),
}));

beforeEach(async () => {
  const native = await vi.importActual<typeof import('@tauri-apps/api/core')>('@tauri-apps/api/core');
  vi.mocked(tauriCore.invoke).mockReset().mockImplementation(native.invoke);
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1', projectLoadStatus: 'ready',
    projects: [{ id: 'project-1', name: 'project', createdAt: 1, updatedAt: 1 }] });
});

describe('新画布异步任务提交边界', () => {
  it.each(['apimart', 'apimart-flow-music', 'dreamina', 'volcengine', 'runninghub-workflow', 'runninghub-model', 'workflow-api'] as const)(
    '%s 提交前失败关闭，保留已有旧任务', (taskType) => {
      savePendingTask({ projectId: 'old-project', nodeId: 'old-node', nodeType: 'ai-image', provider: 'apimart',
        taskId: 'paid-old-task', taskType: 'apimart', submitted: true });
      const old = localStorage.getItem('ai_canvas_pending_tasks');
      useAppStore.setState({ projectExecutionContext: { kind: 'canvas', schemaVersion: 2, modelGeneration: 1,
        projectId: 'p', projectEpoch: 1, canvasId: 'project-1', canvasEpoch: 1, canvasRevision: 0, episodeId: null, runtimeEpoch: 'run' } });
      expect(() => savePendingTask({ projectId: 'project-1', nodeId: 'new-node', nodeType: 'ai-image', provider: taskType,
        taskId: '', taskType, submitted: false })).toThrow('未提交请求');
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(old);
      // 前台切到新画布不改变旧项目后台请求的存储语义。
      expect(() => savePendingTask({ projectId: 'old-project', nodeId: 'old-background', nodeType: 'ai-image', provider: taskType,
        taskId: '', taskType, submitted: false })).not.toThrow();
      expect(() => savePendingTask({ projectId: 'project-1', nodeId: 'comfy-text', nodeType: 'ai-text', provider: 'comfyui',
        taskId: '', taskType: 'comfyui', submitted: false })).not.toThrow();
    },
  );

  it('打开原画布时为非工作流的原任务恢复查询入口，并禁止续查发起未开始的阶段', async () => {
    const context: CanvasContext = { kind: 'canvas', schemaVersion: 2, modelGeneration: 1, projectId: 'p2-fixture',
      projectEpoch: 1, canvasId: 'project-1', canvasEpoch: 1, canvasRevision: 0, episodeId: null, runtimeEpoch: 'original-run' };
    const receipt: NativeMediaTaskRecord = { projectId: 'media-task:test-operation', kind: 'native-media-task-v1', operationId: 'test-operation',
      ownerProjectId: context.projectId, canvasId: context.canvasId, canvasEpoch: 1, projectEpoch: 1, episodeId: null, nodeId: 'video',
      category: 'video', inputFingerprint: 'a'.repeat(64), providerConfigId: 'volcengine', providerBase: 'https://example.test', status: 'submitted',
      sourceCanvasRevision: 0, remoteTaskId: 'remote-id', lease: 'lease', revision: 1, createdAt: 1, updatedAt: 1 };
    useAppStore.setState({ projectExecutionContext: context, nodes: [{ id: 'video', type: 'ai-video', position: { x: 0, y: 0 },
      data: { label: '视频', type: 'ai-video', status: 'loading' } }] });
    const repository = await import('../../src/services/indexedDb/nativeMediaTaskRepository');
    const dispatcher = await import('../../src/services/nativeVolcengineRecovery');
    const auto = await import('../../src/services/nativeMediaAutoDelivery');
    const list = vi.spyOn(repository, 'listNativeMediaTasks').mockResolvedValue([receipt]);
    const inspect = vi.spyOn(repository, 'readAvailableNativeMediaTask').mockResolvedValue(receipt);
    const autoDeliver = vi.spyOn(auto, 'resumeNativeMediaLocalResults').mockResolvedValue(undefined);
    const resume = vi.spyOn(dispatcher, 'resumeNativeVolcengineTask').mockImplementation(async () => {
      receipt.status = 'delivered';
      useAppStore.getState().updateNodeDataTransient('video', { status: 'success' });
    });
    try {
      await resumePendingTasks('project-1');
      expect(useAppStore.getState().nodes[0].data).toMatchObject({ mediaTaskState: 'paused', status: 'idle' });
      expect(getNativeMediaNodeRecovery('video')).toBe(receipt.operationId);
      expect(resume).not.toHaveBeenCalled();
      await expect(resumeNativeMediaFromNode('other-node', receipt.operationId)).rejects.toThrow('原媒体任务已变化');
      useAppStore.setState({ projectExecutionContext: { ...context, runtimeEpoch: 'other-run' } });
      await expect(resumeNativeMediaFromNode('video', receipt.operationId)).rejects.toThrow('原媒体任务已变化');
      useAppStore.setState({ projectExecutionContext: context });
      await resumeNativeMediaFromNode('video', receipt.operationId);
      expect(resume).toHaveBeenCalledExactlyOnceWith(receipt.operationId, expect.any(AbortSignal), { allowUnstartedStage: false });
      expect(getNativeMediaNodeRecovery('video')).toBeUndefined();
    } finally {
      list.mockRestore(); inspect.mockRestore(); resume.mockRestore(); autoDeliver.mockRestore();
    }
  });
});

describe('independent editor transition recovery', () => {
  it('keeps submitted and confirmed-failed transition identities so old window events cannot become new generation requests', async () => {
    const unbind = bindMediaTaskContext('terminal-editor-tracking', { projectId: 'project-1',
      editorTransition: { requestId: 'failed-original-request', anchorNodeId: 'anchor' } });
    const receipt = savePendingTask({ nodeId: 'terminal-editor-tracking', projectId: 'project-1', nodeType: 'ai-video',
      provider: 'volcengine', taskType: 'volcengine', taskId: 'original-failed-remote-task', submitted: true });
    unbind();
    removePendingTask(receipt.nodeId, receipt.taskId, receipt.attemptId);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject(receipt);
    removeFailedMediaTask(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ ...receipt, terminalFailure: true });
    await resumePendingTasks('project-1');
    await expect(readVideoEditorTransitionTaskResult(receipt)).rejects.toThrow('服务商已明确拒绝');
    expect(getPendingTasksForProject('project-1')[0].attemptId).toBe(receipt.attemptId);
    expect(useAppStore.getState().nodes).toEqual([]);
  });

  it('keeps a missing-anchor transition receipt across startup scanning and sanitizes its local reference', async () => {
    const unbind = bindMediaTaskContext('editor-tracking', { projectId: 'project-1',
      editorTransition: { requestId: 'original-request', anchorNodeId: 'removed-anchor', fileName: 'C:\\private\\result.mp4' } });
    const receipt = savePendingTask({ nodeId: 'editor-tracking', projectId: 'project-1', nodeType: 'ai-video',
      provider: 'general', providerConfigId: 'original', taskType: 'custom-protocol', taskId: 'paid-remote-task', submitted: true,
      resultUrls: ['https://cdn.example/paid-result.mp4'], mediaRecoveryState: 'delivery_pending' });
    unbind();
    await resumePendingTasks('project-1');
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ ...receipt,
      mediaContext: { editorTransition: { requestId: 'original-request', anchorNodeId: 'removed-anchor' } } });
    expect(JSON.stringify(getPendingTasksForProject('project-1'))).not.toContain('private');
    expect(useAppStore.getState().nodes).toEqual([]);
    completeMediaNodeTask(receipt);
    expect(getMediaTaskSnapshot()[0].mediaContext?.editorTransition).toMatchObject({ delivered: true });
    // 已主动取回仍保留入口身份：Store 自动保存前崩溃后可再次显式取回。
    expect(getPendingTasksForProject('project-1')[0].taskId).toBe(receipt.taskId);
  });

  it('refreshes an expired URL using the saved remote protocol without writing a canvas, message, or new generation request', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      original: { name: '测试连接', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const unbind = bindMediaTaskContext('editor-readonly', { projectId: 'project-1',
      editorTransition: { requestId: 'original-request', anchorNodeId: 'anchor' } });
    const receipt = savePendingTask({ nodeId: 'editor-readonly', projectId: 'project-1', nodeType: 'ai-video',
      provider: 'general', providerConfigId: 'original', taskType: 'custom-protocol', taskId: 'paid-task', submitted: true,
      resultUrls: ['https://cdn.example/expired.mp4'], mediaRecoveryState: 'delivery_pending',
      mediaDownloadAccess: { providerConfigId: 'original', origin: 'https://gateway.example', auth: { type: 'bearer' } },
      protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/paid-task', statusPath: 'status',
        successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url', intervalMs: 1 } });
    unbind();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/original.mp4' })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData');
    try {
      await expect(readVideoEditorTransitionTaskResult(receipt)).resolves.toMatchObject({ url: 'https://cdn.example/original.mp4' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
      expect(persist).not.toHaveBeenCalled();
      expect(useAppStore.getState().nodes).toEqual([]);
      expect(useAppStore.getState().messages).toEqual([]);
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ ...receipt,
        resultUrls: ['https://cdn.example/original.mp4'], mediaRecoveryState: 'delivery_pending' });
    } finally { persist.mockRestore(); vi.unstubAllGlobals(); }
  });
});

describe('pending task read compatibility and runtime context', () => {
  it('projects old identities without normalizing or writing the original paid/unknown queue', () => {
    const raw = JSON.stringify([{ projectId: 'project-1', nodeId: 'old-node', taskId: 'already-submitted',
      nodeType: 'ai-image', taskType: 'apimart', provider: 'apimart', submitted: true,
      apiKey: 'legacy-private-key', resultUrls: ['https://private.example/output'], videoGeneration: { prompt: 'private-prompt' } },
    { projectId: 'project-1', nodeId: 'unknown-node', nodeType: 'ai-video', taskType: 'general',
      provider: 'general', mediaSubmissionUncertain: true }]);
    localStorage.setItem('ai_canvas_pending_tasks', raw);
    const write = vi.spyOn(localStorage, 'setItem');
    try {
      const result = readPendingMediaTaskViews(['project-1']);
      expect(result).toMatchObject({ status: 'ok', tasks: [{ nodeId: 'old-node', taskId: 'already-submitted' },
        { nodeId: 'unknown-node', taskId: '', stage: 'submit_unknown', canResume: false }] });
      expect(JSON.stringify(result)).not.toMatch(/private|apiKey|resultUrls|videoGeneration/);
      expect(write).not.toHaveBeenCalled();
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
    } finally { write.mockRestore(); }
  });

  it.each(['{invalid-json', '{}', '[{"projectId":"project-1","taskType":"future-provider"}]'])('keeps unsupported source %s and reports a read error rather than an empty success', (raw) => {
    localStorage.setItem('ai_canvas_pending_tasks', raw);
    const write = vi.spyOn(localStorage, 'setItem');
    try {
      expect(readPendingMediaTaskViews(['project-1'])).toEqual({ status: 'invalid', errorCode: 'MEDIA_PENDING_SOURCE_INVALID' });
      expect(write).not.toHaveBeenCalled();
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
      expect(() => getPendingTasksForProject('project-1')).toThrow('原待恢复任务源');
      expect(() => savePendingTask({ projectId: 'project-1', nodeId: 'new-node', taskId: 'new-task', nodeType: 'ai-image',
        provider: 'apimart', taskType: 'apimart', submitted: true })).toThrow('原待恢复任务源');
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
    } finally { write.mockRestore(); }
  });

  it.each(['version', 'schemaVersion', 'modelGeneration', 'expectedContext', 'executionContext', 'projectScope'])('does not interpret future execution field %s as a legacy recovery grant', (field) => {
    const raw = JSON.stringify([{ projectId: 'project-1', nodeId: 'future-node', taskId: 'paid-task', nodeType: 'ai-video',
      taskType: 'general', provider: 'general', submitted: true, [field]: 2 }]);
    localStorage.setItem('ai_canvas_pending_tasks', raw);
    expect(readPendingMediaTaskViews(['project-1'])).toEqual({ status: 'invalid', errorCode: 'MEDIA_PENDING_SOURCE_INVALID' });
    expect(() => getPendingTasksForProject('project-1')).toThrow('原待恢复任务源');
    expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
  });

  it.each(['switch', 'epoch'] as const)('invalidates original query/message callbacks on %s without editing their receipt', (change) => {
    const task = { projectId: 'project-1', nodeId: 'lease-node' };
    const raw = '["original-unknown-receipt"]';
    localStorage.setItem('ai_canvas_pending_tasks', raw);
    const signal = registerNodePolling(task.nodeId);
    const lease = registerPendingTaskContextGuard(task, signal);
    try {
      expect(lease.isCurrent()).toBe(true);
      useAppStore.getState().incrementRevision();
      expect(lease.isCurrent()).toBe(true); // 仅消息交付不因同画布编辑改绑；画布写仍有派生revision守卫。
      useAppStore.setState(change === 'switch' ? { currentProjectId: 'other-canvas' }
        : { projects: useAppStore.getState().projects.map((item) => ({ ...item, exchangeEpoch: 1 })) });
      expect(signal.aborted).toBe(true);
      useAppStore.setState({ currentProjectId: 'project-1', projects: [{ id: 'project-1', name: 'project', createdAt: 1, updatedAt: 1 }] });
      expect(lease.isCurrent()).toBe(false);
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
    } finally { lease.complete(); cleanupNodePolling(task.nodeId, signal); }
  });

  it.each(['switch', 'epoch'] as const)('keeps an original RunningHub result out of a replacement Canvas after %s', async (change) => {
    const runninghub = await import('../../src/services/ai/providers/runninghubWorkflow');
    const execution = await import('../../src/services/workflowExecutionService');
    let release: ((outputs: Awaited<ReturnType<typeof runninghub.queryRunningHubWorkflow>>) => void) | undefined;
    const query = vi.spyOn(runninghub, 'queryRunningHubWorkflow').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const save = vi.spyOn(runninghub, 'saveRunningHubOutputs');
    const connection = vi.spyOn(execution, 'runningHubConnection').mockReturnValue({ apiKey: 'fixture-key', baseUrl: 'https://runninghub.example' });
    const nodeId = `pending-context-${change}`;
    useAppStore.setState({ nodes: [{ id: nodeId, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'original', status: 'loading' } }] });
    savePendingTask({ projectId: 'project-1', nodeId, taskId: 'original-paid-task', nodeType: 'ai-image', provider: 'runninghubwf',
      taskType: 'runninghub-workflow', submitted: true });
    const raw = localStorage.getItem('ai_canvas_pending_tasks');
    const pending = resumeRunningHubNodeTask(nodeId);
    try {
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      const signal = query.mock.calls[0][4];
      useAppStore.setState({ ...(change === 'switch' ? { currentProjectId: 'another-canvas' }
        : { projects: useAppStore.getState().projects.map((item) => ({ ...item, exchangeEpoch: 1 })) }),
        nodes: [{ id: nodeId, type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'replacement', output: 'replacement-result' } }] });
      release!([{ url: 'https://private.example/original-paid-output', kind: 'image' }]);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(save).not.toHaveBeenCalled();
      expect(useAppStore.getState().nodes[0].data.output).toBe('replacement-result');
      expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
    } finally {
      release?.([]); await pending;
      query.mockRestore(); save.mockRestore(); connection.mockRestore();
    }
  });
});

it('逻辑删除只撤销对应运行租约和查询，保留原始付费/unknown队列，不影响另一项目', () => {
  const deletedId = 'deleted-preserve-receipts';
  const otherId = 'retained-polling-project';
  const task: PendingTask = { projectId: deletedId, nodeId: 'deleted-polling-node', nodeType: 'ai-video',
    provider: 'apimart', taskType: 'apimart', taskId: 'already-paid', attemptId: 'attempt-one', submitted: true };
  const raw = JSON.stringify([task, { ...task, nodeId: 'unknown-node', taskId: undefined,
    submitted: false, mediaSubmissionUncertain: true, mediaRecoveryState: 'submit_unknown' }]);
  localStorage.setItem('ai_canvas_pending_tasks', raw);
  const unbind = bindMediaTaskContext(task.nodeId, { projectId: deletedId });
  const unbindOther = bindMediaTaskContext('other-polling-node', { projectId: otherId });
  const operation = registerMediaNodeOperation(task.nodeId, true);
  const otherOperation = registerMediaNodeOperation('other-polling-node', true);
  const signal = registerNodePolling(task.nodeId);
  const otherSignal = registerNodePolling('other-polling-node');
  const read = vi.spyOn(localStorage, 'getItem');
  const write = vi.spyOn(localStorage, 'setItem');
  try {
    stopPollingForDeletedProjects([deletedId]);
    expect(signal.aborted).toBe(true); expect(otherSignal.aborted).toBe(false);
    expect(operation.isCurrent()).toBe(false); expect(otherOperation.isCurrent()).toBe(true);
    const receipt = { projectId: deletedId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId };
    pauseMediaTask(receipt); completeMediaNodeTask(receipt); removePendingTask(task.nodeId, task.taskId, task.attemptId);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem('ai_canvas_pending_tasks')).toBe(raw);
    expect(() => registerNodePolling(task.nodeId)).toThrow();
  } finally {
    cleanupNodePolling(task.nodeId); cleanupNodePolling('other-polling-node');
    operation(); otherOperation(); unbind(); unbindOther();
    read.mockRestore(); write.mockRestore();
  }
});

it('删除当前画布不会取消另一项目同名nodeId的轮询', () => {
  const projectId = 'deleted-colliding-node-project';
  const nodeId = 'same-id-across-projects';
  useAppStore.setState({ currentProjectId: projectId,
    nodes: [{ id: nodeId, type: 'ai-video', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: '同名节点' } }] });
  const unbind = bindMediaTaskContext(nodeId, { projectId: 'retained-colliding-node-project' });
  const signal = registerNodePolling(nodeId);
  const operation = registerMediaNodeOperation(nodeId, true);
  try {
    stopPollingForDeletedProjects([projectId]);
    expect(signal.aborted).toBe(false); expect(operation.isCurrent()).toBe(true);
  } finally { cleanupNodePolling(nodeId); operation(); unbind(); }
});

describe('media task display snapshot', () => {
  const storageKey = 'ai_canvas_pending_tasks';
  const task: PendingTask = { projectId: 'project-1', nodeId: 'display-node', nodeType: 'ai-image',
    provider: 'apimart', taskType: 'apimart', taskId: 'display-task', attemptId: 'display-attempt', submitted: true,
    mediaContext: { projectId: 'project-1', conversationId: 'conversation-1', messageId: 'display-message' } };

  it('coalesces initialization, migrates once and keeps pure frozen snapshots free of execution material', async () => {
    localStorage.setItem(storageKey, JSON.stringify([{ ...task, apiKey: 'legacy-private-key',
      resultUrls: ['https://cdn.example/private-output.png'], protocolPoll: { url: 'https://private-query.example' },
      expectedImageOutputs: 2, imageOutputNodeIds: ['original-node'], mediaContext: { ...task.mediaContext,
        parameters: { prompt: 'private-prompt', seed: 7 } } }]));
    const read = vi.spyOn(localStorage, 'getItem');
    const write = vi.spyOn(localStorage, 'setItem');
    const before = getMediaTaskSnapshot();
    expect(getMediaTaskSnapshot()).toBe(before);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const initialization = initializeMediaTaskSnapshot();
    const unsubscribe = subscribeMediaTasks(vi.fn());
    try {
      expect(initializeMediaTaskSnapshot()).toBe(initialization);
      await initialization;
      expect(read).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      const snapshot = getMediaTaskSnapshot();
      expect(snapshot[0]).toMatchObject({ projectId: task.projectId, nodeId: task.nodeId,
        taskId: task.taskId, attemptId: task.attemptId, mediaContext: { conversationId: 'conversation-1', messageId: 'display-message' } });
      expect(hasPendingMessageMediaTask('project-1', 'conversation-1', 'display-message')).toBe(true);
      expect(hasPendingMessageMediaTask('other-project', 'conversation-1', 'display-message')).toBe(false);
      expect(JSON.stringify(snapshot)).not.toMatch(/private|protocolPoll|mediaDownloadAccess|parameters|apiKey|resultUrls/);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot[0])).toBe(true);
      expect(Object.isFrozen(snapshot[0].mediaContext)).toBe(true);
      expect(snapshot[0].imageOutputNodeIds).toEqual(['original-node']);
      expect(Object.isFrozen(snapshot[0].imageOutputNodeIds)).toBe(true);
      read.mockClear(); write.mockClear();
      expect(getMediaTaskSnapshot()).toBe(snapshot);
      expect(getMediaTaskSnapshot()[0]).toBe(snapshot[0]);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it.each([undefined, ''])('keeps the legacy wildcard conversation identity %j', (conversationId) => {
    savePendingTask({ ...task, mediaContext: { ...task.mediaContext!, conversationId } });
    expect(hasPendingMessageMediaTask('project-1', 'conversation-1', 'display-message')).toBe(true);
    expect(hasPendingMessageMediaTask('project-1', 'other-conversation', 'display-message')).toBe(true);
    expect(hasPendingMessageMediaTask('project-1', 'conversation-1', 'other-message')).toBe(false);
  });

  it('preserves task reference for unrelated saves and updates the uncertain/paused display identity', () => {
    const receipt = savePendingTask(task);
    const snapshot = getMediaTaskSnapshot();
    updatePendingTask(task.nodeId, { resultUrls: ['https://cdn.example/refreshed.png'] }, receipt.taskId, receipt.attemptId);
    expect(getMediaTaskSnapshot()).toBe(snapshot);
    updatePendingTask(task.nodeId, { submitted: false, mediaSubmissionUncertain: true,
      mediaRecoveryState: 'submit_unknown' }, receipt.taskId, receipt.attemptId);
    expect(getMediaTaskSnapshot()[0]).toMatchObject({ ...receipt, submitted: false,
      mediaSubmissionUncertain: true, mediaRecoveryState: 'submit_unknown', historyDownloadPending: false });
    updatePendingTask(task.nodeId, { submitted: true, mediaSubmissionUncertain: false,
      mediaRecoveryState: 'query_paused' }, receipt.taskId, receipt.attemptId);
    expect(getMediaTaskSnapshot()[0]).toMatchObject({ ...receipt, submitted: true, mediaRecoveryState: 'query_paused' });
  });

  it.each<Partial<PendingTask>>([
    {}, { terminalFailure: true }, { mediaSubmissionUncertain: true }, { runninghubSubmissionUncertain: true },
    { runninghubRecoveryState: 'cancel_pending' }, { comfyRecoveryState: 'cancel_pending' },
  ])('uses the existing history eligibility guard for %j', (patch) => {
    savePendingTask({ ...task, mediaRecoveryState: 'delivery_pending', ...patch });
    expect(getMediaTaskSnapshot()[0].historyDownloadPending).toBe(Object.keys(patch).length === 0);
  });

  it('refreshes across storage events and a later subscription after clear without making getters read storage', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const detach = vi.spyOn(events, 'removeEventListener');
    savePendingTask(task);
    const unsubscribe = subscribeMediaTasks(vi.fn());
    await initializeMediaTaskSnapshot();
    localStorage.clear();
    events.dispatchEvent(Object.assign(new Event('storage'), { key: null, storageArea: localStorage }));
    await initializeMediaTaskSnapshot();
    expect(getMediaTaskSnapshot()).toEqual([]);
    expect(hasPendingMessageMediaTask('project-1', 'conversation-1', 'display-message')).toBe(false);
    unsubscribe();
    expect(detach).toHaveBeenCalledWith('storage', expect.any(Function));
    localStorage.setItem(storageKey, JSON.stringify([{ ...task, attemptId: 'second-attempt' }]));
    const read = vi.spyOn(localStorage, 'getItem');
    expect(getMediaTaskSnapshot()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const stop = subscribeMediaTasks(vi.fn());
    try {
      await initializeMediaTaskSnapshot();
      expect(getMediaTaskSnapshot()[0].attemptId).toBe('second-attempt');
      expect(read).toHaveBeenCalledOnce();
    } finally { stop(); }
  });

  it('keeps execution reads authoritative without notifying subscribers inside a display read', async () => {
    savePendingTask(task);
    const notify = vi.fn();
    const unsubscribe = subscribeMediaTasks(notify);
    try {
      await initializeMediaTaskSnapshot();
      notify.mockClear();
      const previous = getMediaTaskSnapshot()[0];
      localStorage.setItem(storageKey, JSON.stringify([{ ...task, attemptId: 'new-authoritative-attempt' }]));
      expect(getMediaTaskSnapshot()[0]).toBe(previous);
      expect(getPendingTasksForProject(task.projectId)[0].attemptId).toBe('new-authoritative-attempt');
      expect(getMediaTaskSnapshot()[0].attemptId).toBe('new-authoritative-attempt');
      expect(notify).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('reuses snapshot state across HMR and initializes it on an older runtime without losing listeners', () => {
    const hotData = {};
    const old = createOrReusePollManagerRuntime(hotData);
    const snapshot = old.mediaTaskSnapshot;
    const listener = vi.fn();
    old.mediaTaskListeners.add(listener);
    expect(createOrReusePollManagerRuntime(hotData).mediaTaskSnapshot).toBe(snapshot);
    Reflect.deleteProperty(old, 'mediaTaskSnapshot');
    const refreshed = createOrReusePollManagerRuntime(hotData);
    expect(refreshed).toBe(old);
    expect(refreshed.mediaTaskSnapshot.tasks).toEqual([]);
    expect(refreshed.mediaTaskListeners.has(listener)).toBe(true);
  });
});

describe('polling runtime hot reload identity', () => {
  registerRuntimeIdentityTests();
});

describe('pending generation task recovery', () => {
  registerGenerationDeliveryTests();

  function pausedVideo() {
    useAppStore.setState((state) => ({
      config: { ...state.config, providers: { ...state.config.providers,
        'slow-provider': { name: 'Slow provider', apiKey: 'current-key', baseUrl: 'https://gateway.example/v1' } } },
      nodes: [{ id: 'slow-node', type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: 'Slow video', prompt: 'original prompt', model: 'original-model',
          provider: 'general', status: 'loading' } satisfies BaseNodeData }],
    }));
    const task: PendingTask = { nodeId: 'slow-node', projectId: 'project-1', nodeType: 'ai-video',
      provider: 'general', providerConfigId: 'slow-provider', taskId: 'remote-video', taskType: 'custom-protocol', submitted: true,
      protocolPoll: { method: 'GET', url: 'https://gateway.example/v1/videos/remote-video', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url', maxAttempts: 1 } };
    savePendingTask(task);
    pauseVideoNodeTaskOnTimeout(task.nodeId, new PollTimeoutError(), task.taskId);
    return task;
  }

  it('keeps an existing controller when a stopped caller tries to register another query', () => {
    const original = registerNodePolling('registered-query');
    const controller = new AbortController();
    controller.abort();
    expect(() => registerNodePolling('registered-query', controller.signal)).toThrow();
    expect(original.aborted).toBe(false);
    expect(cleanupNodePolling('registered-query', original)).toBe(true);

    const active = new AbortController();
    const combined = registerNodePolling('registered-query', active.signal);
    active.abort();
    expect(combined.aborted).toBe(true);
    expect(cleanupNodePolling('registered-query', combined)).toBe(true);
  });

  it.each(['before-call', 'before-registration'] as const)('does not query when stopped %s', async (timing) => {
    const task = pausedVideo();
    const receipt = getMediaTaskReceipt(task.nodeId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    if (timing === 'before-call') controller.abort();
    const pending = resumeMediaNodeTask(task.nodeId, controller.signal);
    if (timing === 'before-registration') controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getMediaTaskReceipt(task.nodeId)).toEqual(receipt);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused' });
  });

  it('stops a query and ignores a late response while allowing the original task to be resumed again', async () => {
    const task = pausedVideo();
    const receipt = getMediaTaskReceipt(task.nodeId);
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_source: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({
      mediaUrl: 'asset://video.mp4', sourceUrl: 'https://cdn.example/video.mp4' });
    const pending = resumeMediaNodeTask(task.nodeId, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    finish(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/late.mp4' })));
    expect(persist).not.toHaveBeenCalled();
    expect(getMediaTaskReceipt(task.nodeId)).toEqual(receipt);
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/video.mp4' })));
    await resumeMediaNodeTask(task.nodeId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://video.mp4');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it.each([1, 2])('does not publish a late save for a stopped recovery with %i output(s)', async (count) => {
    const task = pausedVideo();
    if (count > 1) {
      const source = useAppStore.getState().nodes[0];
      useAppStore.setState({ nodes: [
        { ...source, type: 'ai-image', data: { ...source.data, type: 'ai-image', batchGroupId: 'recovery-batch' } },
        { id: 'batch-sibling', type: 'ai-image', position: { x: 300, y: 0 },
          data: { type: 'ai-image', label: 'Sibling', status: 'loading', batchGroupId: 'recovery-batch' } },
      ] });
      savePendingTask({ ...task, nodeType: 'ai-image', batchCount: count, mediaRecoveryState: 'query_paused' });
    }
    const receipt = getMediaTaskReceipt(task.nodeId);
    const urls = Array.from({ length: count }, (_, index) => `https://cdn.example/result-${index}.png`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: urls }))));
    const finish: Array<() => void> = [];
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockImplementation((url) => new Promise((resolve) => {
      finish.push(() => resolve({ mediaUrl: 'asset://late-result', sourceUrl: url }));
    }));
    const history = vi.spyOn(useAppStore.getState(), 'recordOutputHistory');
    const controller = new AbortController();
    const pending = resumeMediaNodeTask(task.nodeId, controller.signal);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(count));
    controller.abort();
    expect(getPendingTasksForProject('project-1')[0].mediaRecoveryState).toBe('delivery_pending');
    finish.forEach((resolve) => resolve());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getMediaTaskReceipt(task.nodeId)).toEqual(receipt);
    expect(useAppStore.getState().nodes).toHaveLength(count);
    expect(useAppStore.getState().nodes.every((node) => !node.data.imageUrl && !node.data.videoUrl)).toBe(true);
    expect(history).not.toHaveBeenCalled();
  });

  it.each(['apimart-flow-music', 'dreamina'] as const)('does not let a cancelled %s save alter or unregister a newer query', async (taskType) => {
    const original = pausedVideo();
    const nodeType = taskType === 'dreamina' ? 'ai-image' : 'ai-audio';
    useAppStore.setState((state) => ({ nodes: state.nodes.map((node) => ({
      ...node, type: nodeType, data: { ...node.data, type: nodeType },
    })) }));
    const receipt = savePendingTask({ ...original, nodeType, taskType, audioTaskStage: 'music',
      mediaRecoveryState: 'query_paused' });
    const url = 'https://cdn.example/original-result';
    if (taskType === 'dreamina') {
      vi.mocked(tauriCore.invoke).mockResolvedValue({ status: 'success', failReason: '', outputs: [{ url, localPath: '' }] });
    } else {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        status: 'completed', result: { music: [{ audio_url: url }] },
      }))));
    }
    let finish!: () => void;
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ mediaUrl: 'asset://old-result', sourceUrl: url });
    }));
    const controller = new AbortController();
    const pending = resumeMediaNodeTask(original.nodeId, controller.signal);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    controller.abort();
    const replacement = registerNodePolling(original.nodeId);
    useAppStore.getState().updateNodeDataTransient(original.nodeId, { status: 'loading', mediaTaskState: undefined });
    finish();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    expect(getMediaTaskReceipt(original.nodeId)).toEqual(receipt);
    expect(replacement.aborted).toBe(false);
    expect(cleanupNodePolling(original.nodeId, replacement)).toBe(true);
  });

  it('only stops the joining caller while an existing recovery continues with its own signal', async () => {
    const task = pausedVideo();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_source: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({
      mediaUrl: 'asset://video.mp4', sourceUrl: 'https://cdn.example/video.mp4' });
    const original = resumeMediaNodeTask(task.nodeId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const joining = resumeMediaNodeTask(task.nodeId, controller.signal);
    controller.abort();
    await expect(joining).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
    finish(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/video.mp4' })));
    await original;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes[0].data.videoUrl).toBe('asset://video.mp4');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it.each(['inline-result', 'download'] as const)('retains the original task when a resumed %s has the wrong media MIME', async (kind) => {
    const task = pausedVideo();
    const receipt = getMediaTaskReceipt(task.nodeId)!;
    if (kind === 'download') updatePendingTask(task.nodeId, { protocolPoll: { ...task.protocolPoll!,
      resultMimeType: 'video/mp4', resultDownload: { url: 'https://gateway.example/v1/videos/remote-video/content' },
    } }, task.taskId, receipt.attemptId);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed',
      url: 'data:audio/wav;base64,UklGRg==',
    }), { headers: { 'Content-Type': 'application/json' } }));
    if (kind === 'download') fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'download unavailable' }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData');
    const history = vi.spyOn(useAppStore.getState(), 'recordOutputHistory');
    await resumeMediaNodeTask(task.nodeId);
    expect(getMediaTaskReceipt(task.nodeId)).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: task.taskId,
      attemptId: receipt.attemptId, mediaRecoveryState: 'query_paused' });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused' });
    expect(persist).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(kind === 'download' ? 2 : 1);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('keeps a paused task through project reload without querying or recording an error', async () => {
    pausedVideo();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await resumePendingTasks('project-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: 'remote-video', videoRecoveryState: 'paused' });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', error: undefined });
  });

  it('queries an existing task once for repeated retry clicks and saves its result locally', async () => {
    pausedVideo();
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({
      mediaUrl: 'asset://video.mp4', sourceUrl: 'https://cdn.example/video.mp4' });
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const first = resumeVideoNodeTask('slow-node');
    const duplicate = resumeVideoNodeTask('slow-node');
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    finish(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/video.mp4' })));
    await first;
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/v1/videos/remote-video',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer current-key' } }));
    expect(persist).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: 'asset://video.mp4', videoTaskState: undefined });
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('returns to paused when retry times out and also retains completed tasks whose local save fails', async () => {
    pausedVideo();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'queued' })));
    vi.stubGlobal('fetch', fetchMock);
    await resumeVideoNodeTask('slow-node');
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', error: undefined });
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/video.mp4' })));
    vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockRejectedValue(new Error('disk unavailable'));
    await resumeVideoNodeTask('slow-node');
    expect(getPendingTasksForProject('project-1')[0].taskId).toBe('remote-video');
    expect(useAppStore.getState().nodes[0].data.videoTaskState).toBe('paused');
  });

  it('shows actual remote failure even if its message mentions a timeout', async () => {
    const task = pausedVideo();
    expect(pauseVideoNodeTaskOnTimeout(task.nodeId, new PollTaskFailedError('upstream timeout'), task.taskId)).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'failed' }))));
    await expect(resumeVideoNodeTask(task.nodeId)).rejects.toBeInstanceOf(PollTaskFailedError);
    expect(useAppStore.getState().nodes[0].data.status).toBe('error');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('moves an old task to a recovery node with original inputs before a fresh generation', async () => {
    pausedVideo();
    useAppStore.getState().updateNodeDataTransient('slow-node', { prompt: 'new prompt', model: 'new-model', videoUrl: 'new-video.mp4' });
    prepareVideoNodeGeneration('slow-node');
    const state = useAppStore.getState();
    const recovery = state.nodes.find((node) => node.id !== 'slow-node')!;
    expect(recovery.data).toMatchObject({ prompt: 'original prompt', model: 'original-model', videoTaskState: 'paused' });
    expect(recovery.data.videoUrl).toBeUndefined();
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ nodeId: recovery.id, taskId: 'remote-video' });
    vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({ mediaUrl: 'old-video.mp4', sourceUrl: 'old-video.mp4' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/old-video.mp4' }))));
    await resumeVideoNodeTask(recovery.id);
    expect(useAppStore.getState().nodes.find((node) => node.id === 'slow-node')?.data.videoUrl).toBe('new-video.mp4');
    expect(useAppStore.getState().nodes.find((node) => node.id === recovery.id)?.data.videoUrl).toBe('old-video.mp4');
    expect(JSON.stringify(getPendingTasksForProject('project-1'))).not.toContain('current-key');
  });

  it('does not write a query result into a different project after switching', async () => {
    pausedVideo();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData');
    vi.stubGlobal('fetch', fetchMock);
    const pending = resumeVideoNodeTask('slow-node');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    useAppStore.setState({ currentProjectId: 'project-2', nodes: [] });
    finish(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/old-video.mp4' })));
    await pending;
    expect(persist).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
  });

  it('keeps the original task association when creating its recovery node fails', () => {
    pausedVideo();
    vi.spyOn(useAppStore.getState(), 'addNodesTransient').mockImplementationOnce(() => {
      throw new Error('canvas write unavailable');
    });
    expect(() => prepareVideoNodeGeneration('slow-node')).toThrow('canvas write unavailable');
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ nodeId: 'slow-node', taskId: 'remote-video', videoRecoveryState: 'paused' });
    expect(useAppStore.getState().nodes).toHaveLength(1);
    expect(useAppStore.getState().nodes[0].data.videoTaskState).toBe('paused');
  });

  it('does not convert submission timeouts without a task ID into resumable polling', () => {
    const task = pausedVideo();
    expect(pauseVideoNodeTaskOnTimeout(task.nodeId, new PollTimeoutError())).toBeUndefined();
    expect(pauseVideoNodeTaskOnTimeout(task.nodeId, new PollTimeoutError(), 'newer-task')).toBeUndefined();
  });

  it('resumes binary result downloads without submitting another generation', async () => {
    const persistMedia = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({
      mediaUrl: 'asset://recovered-video.mp4', sourceUrl: 'asset://recovered-video.mp4',
    });
    useAppStore.setState((state) => ({
      config: { ...state.config, providers: { ...state.config.providers,
        'custom-video': { name: 'Video', apiKey: 'current-provider-key',
          baseUrl: 'https://gateway.example/v1', catalogId: 'custom-openai' },
      } },
      nodes: [{ id: 'download-node', type: 'ai-video', position: { x: 0, y: 0 },
        data: { label: 'Video', type: 'ai-video', status: 'loading', prompt: 'test' } satisfies BaseNodeData }],
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' }), {
      headers: { 'Content-Type': 'application/json' },
    })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'video/mp4' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    savePendingTask({
      nodeId: 'download-node', projectId: 'project-1', nodeType: 'ai-video', provider: 'general',
      providerConfigId: 'custom-video', taskId: 'video-1', taskType: 'custom-protocol', submitted: true,
      protocolPoll: {
        method: 'GET', url: 'https://gateway.example/v1/videos/video-1',
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], intervalMs: 3000,
        resultDownload: { url: 'https://gateway.example/v1/videos/video-1/content', headers: { Accept: 'video/mp4' } },
        resultMimeType: 'video/mp4',
      },
    });
    await resumePendingTasks('project-1');
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0].data).toMatchObject({
        status: 'success', videoUrl: 'asset://recovered-video.mp4',
      });
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    }, { timeout: 4000 }); // 历史记录异步落入 IndexedDB 后才允许确认并清空待续队列。
    expect(persistMedia).toHaveBeenCalledWith('data:video/mp4;base64,AQID', 'project-1', 'ai-video', 'Video', {
      mediaDownloadAccess: { providerConfigId: 'custom-video', origin: 'https://gateway.example' },
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('https://gateway.example/v1/videos/video-1/content',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'video/mp4', Authorization: 'Bearer current-provider-key' } }));
  });

  it('keeps loading placeholders covered by a resumable image batch task', () => {
    const nodes = [
      {
        id: 'batch-source',
        data: {
          label: 'Batch source',
          type: 'ai-image',
          status: 'loading',
          batchGroupId: 'image-batch-1',
        } satisfies BaseNodeData,
      },
      {
        id: 'batch-placeholder',
        data: {
          label: 'Batch result 2',
          type: 'ai-image',
          status: 'loading',
          batchGroupId: 'image-batch-1',
        } satisfies BaseNodeData,
      },
    ];
    const task = {
      nodeId: 'batch-source',
      projectId: 'project-1',
      nodeType: 'ai-image',
      provider: 'apimart',
      taskId: 'remote-batch-task',
      taskType: 'apimart',
      batchCount: 2,
      submitted: true,
    } as const;

    expect([...getPendingTaskCoveredNodeIds(nodes, [task])]).toEqual([
      'batch-source',
      'batch-placeholder',
    ]);
    expect([...getPendingTaskCoveredNodeIds(nodes, [{ ...task, submitted: false }])])
      .toEqual(['batch-source', 'batch-placeholder']);
  });

  it('marks loading nodes without a pending task as recoverable errors', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'orphan-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Orphan image',
          type: 'ai-image',
          status: 'loading',
        } satisfies BaseNodeData,
      }],
    });

    await resumePendingTasks('project-1');

    expect(useAppStore.getState().nodes[0].data).toMatchObject({
      status: 'error',
      error: '生成请求状态未知：本机没有可续查的任务 ID，请先到平台确认是否已生成，避免重复提交',
      mediaTaskState: 'submit_unknown',
    });
  });

  it('pauses every batch placeholder when connection configuration is missing without losing its remote task', async () => {
    useAppStore.setState({
      nodes: [
        {
          id: 'batch-source',
          type: 'ai-image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Batch source',
            type: 'ai-image',
            status: 'loading',
            batchGroupId: 'image-batch-1',
          } satisfies BaseNodeData,
        },
        {
          id: 'batch-placeholder',
          type: 'ai-image',
          position: { x: 320, y: 0 },
          data: {
            label: 'Batch result 2',
            type: 'ai-image',
            status: 'loading',
            batchGroupId: 'image-batch-1',
          } satisfies BaseNodeData,
        },
      ],
    });
    savePendingTask({
      nodeId: 'batch-source',
      projectId: 'project-1',
      nodeType: 'ai-image',
      provider: 'general',
      providerConfigId: 'missing-provider',
      taskId: 'remote-batch-task',
      taskType: 'general',
      batchCount: 2,
      submitted: true,
    });

    await resumePendingTasks('project-1');
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes.map((node) => node.data.status))
        .toEqual(['idle', 'idle']);
    });
    expect(useAppStore.getState().nodes[1].data.mediaTaskState).toBe('paused');
    expect(getPendingTasksForProject('project-1')[0].taskId).toBe('remote-batch-task');
  });

  it('retains an unacknowledged task even when its node already displays a result', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'finished-node',
        type: 'ai-image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Finished image',
          type: 'ai-image',
          status: 'success',
        } satisfies BaseNodeData,
      }],
    });
    savePendingTask({
      nodeId: 'finished-node',
      projectId: 'project-1',
      nodeType: 'ai-image',
      provider: 'apimart',
      taskId: 'remote-task',
      taskType: 'apimart',
      submitted: true,
    });

    await resumePendingTasks('project-1');

    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: 'remote-task', mediaRecoveryState: 'query_paused' });
  });

  it('keeps pending task records isolated by project', () => {
    savePendingTask({
      nodeId: 'node-1',
      projectId: 'project-1',
      nodeType: 'ai-video',
      provider: 'general',
      taskId: 'task-1',
      taskType: 'general',
      submitted: true,
    });
    savePendingTask({
      nodeId: 'node-2',
      projectId: 'project-2',
      nodeType: 'ai-video',
      provider: 'general',
      taskId: 'task-2',
      taskType: 'general',
      submitted: true,
    });

    expect(getPendingTasksForProject('project-1').map((task) => task.nodeId)).toEqual(['node-1']);
    expect(getPendingTasksForProject('project-2').map((task) => task.nodeId)).toEqual(['node-2']);
  });

  it('scrubs credentials and provider URLs from legacy pending task records', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          apimart: {
            name: 'APIMart',
            apiKey: 'rotated-secret',
            baseUrl: 'https://current.example/v1',
          },
        },
      },
    }));
    localStorage.setItem('ai_canvas_pending_tasks', JSON.stringify([{
      nodeId: 'legacy-node',
      projectId: 'project-1',
      nodeType: 'ai-video',
      provider: 'apimart',
      taskId: 'task-legacy',
      taskType: 'apimart',
      apiKey: 'stale-secret',
      baseUrl: 'https://stale.example/v1',
      submitted: true,
    }]));

    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({
      nodeId: 'legacy-node',
      providerConfigId: 'apimart',
    });
    const persisted = localStorage.getItem('ai_canvas_pending_tasks') || '';
    expect(persisted).not.toContain('stale-secret');
    expect(persisted).not.toContain('stale.example');
    expect(persisted).not.toContain('apiKey');
  });

  it('never borrows another group’s download identity for synchronous delivery', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      original: { name: '原连接', baseUrl: 'https://gateway.example/v1', apiKey: 'a-fixture' },
      other: { name: '其他组', baseUrl: 'https://gateway.example/v1', apiKey: 'b-fixture' },
    } }, nodes: [{ id: 'identity-node', type: 'ai-image', position: { x: 0, y: 0 },
      data: { label: '图片', type: 'ai-image', status: 'idle' } satisfies BaseNodeData }] }));
    savePendingTask({ nodeId: 'identity-node', projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'original', taskId: 'result-local', taskType: 'custom-protocol', submitted: true,
      resultUrls: ['https://gateway.example/result.png'], mediaRecoveryState: 'delivery_pending',
      mediaDownloadAccess: { providerConfigId: 'other', origin: 'https://gateway.example', auth: { type: 'bearer' } } });
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData');
    await resumeMediaNodeTask('identity-node');
    expect(persist).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ providerConfigId: 'original' });
    expect(getPendingTasksForProject('project-1')[0].mediaDownloadAccess).toBeUndefined();
  });

  it('resumes the original Relay group task using that connection’s current key', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      'relay-a': { name: 'A', catalogId: 'relayonapi', relayonGroup: 'image', apiKey: 'old-a-key', baseUrl: 'https://relayonapi.com/v1' },
      'relay-b': { name: 'B', catalogId: 'relayonapi', relayonGroup: 'default', apiKey: 'current-b-key', baseUrl: 'https://relayonapi.com/v1' },
    } }, nodes: [{ id: 'relay-node', type: 'ai-video', position: { x: 0, y: 0 }, data: {
      label: 'Video', type: 'ai-video', status: 'loading', prompt: 'scene',
    } satisfies BaseNodeData }] }));
    savePendingTask({ nodeId: 'relay-node', projectId: 'project-1', nodeType: 'ai-video', provider: 'general',
      providerConfigId: 'relay-a', taskId: 'original-relay-task', taskType: 'custom-protocol', submitted: true,
      protocolPoll: { method: 'GET', url: 'https://relayonapi.com/v1/videos/original-relay-task',
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url', intervalMs: 3000 } });
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'relay-a': { ...state.config.providers['relay-a'], apiKey: 'rotated-a-key' },
    } } }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/video.mp4' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await resumePendingTasks('project-1');
    await vi.waitFor(() => expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success' }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://relayonapi.com/v1/videos/original-relay-task',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer rotated-a-key' }) }));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('old-a-key');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('current-b-key');
  });

  it('resumes declarative protocol tasks with credentials from the provider connection', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'custom-agnes': {
            name: 'Agnes',
            apiKey: 'provider-secret',
            baseUrl: 'https://apihub.agnes-ai.com/v1',
            catalogId: 'custom-openai',
          },
        },
      },
      nodes: [{
        id: 'agnes-video-node',
        type: 'ai-video',
        position: { x: 0, y: 0 },
        data: {
          label: 'Agnes video',
          type: 'ai-video',
          status: 'loading',
          prompt: 'A cinematic cat',
        } satisfies BaseNodeData,
      }],
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed',
      progress: 100,
      url: 'https://cdn.example/agnes.mp4',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    savePendingTask({
      nodeId: 'agnes-video-node',
      projectId: 'project-1',
      nodeType: 'ai-video',
      provider: 'general',
      providerConfigId: 'custom-agnes',
      taskId: 'video-1',
      taskType: 'custom-protocol',
      submitted: true,
      protocolPoll: {
        method: 'GET',
        url: 'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
        statusPath: 'status',
        successValues: ['completed'],
        failureValues: ['failed', 'error'],
        resultUrlPath: 'url',
        errorPath: 'error',
        progressPath: 'progress',
        intervalMs: 3000,
      },
    });

    await resumePendingTasks('project-1');

    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0].data).toMatchObject({
        status: 'success',
        videoUrl: 'https://cdn.example/agnes.mp4',
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://apihub.agnes-ai.com/agnesapi?video_id=video-1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer provider-secret' }),
      }),
    );
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });
});
