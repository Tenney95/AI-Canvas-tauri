/**
 * pollManager — 回归测试：polling runtime hot reload identity。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import {
  getPendingTaskCoveredNodeIds,
  getPendingTasksForProject,
  createOrReusePollManagerRuntime,
  canResumeMediaTask,
  resumePendingTasks,
  savePendingTask,
  pauseVideoNodeTaskOnTimeout,
  prepareVideoNodeGeneration,
  resumeVideoNodeTask,
  bindMediaTaskContext,
  completeMediaNodeTask,
  discardMediaTask,
  removeFailedMediaTask,
  getMediaTaskReceipt,
  pauseMediaTask,
  isMediaTaskPausedError,
  MediaTaskPausedError,
  prepareMediaNodeGeneration,
  registerMediaMessageRecoveryHandler,
  registerMediaNodeOperation,
  registerNodePolling,
  cleanupNodePolling,
  resumeMediaNodeTask,
  settleMediaTaskQueries,
  updatePendingTask,
  type PendingTask,
} from '../../src/services/pollManager';
import { pollTask, PollTimeoutError, PollTaskFailedError } from '../../src/services/pollTask';
import { useAppStore } from '../../src/store/useAppStore';
import { HttpResponseError } from '../../src/services/ai/httpUtils';
import * as fileService from '../../src/services/fileService';
import * as comfyPolling from '../../src/services/comfyPolling';
import * as tauriCore from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: vi.fn(),
}));

beforeEach(async () => {
  const native = await vi.importActual<typeof import('@tauri-apps/api/core')>('@tauri-apps/api/core');
  vi.mocked(tauriCore.invoke).mockReset().mockImplementation(native.invoke);
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1' });
});

describe('polling runtime hot reload identity', () => {
  it.each([504, 502, 429])('persists only safe HTTP %i metadata for unknown submissions', (status) => {
    useAppStore.setState({ nodes: [{ id: 'uncertain', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '图片', status: 'loading' } }] });
    const receipt = savePendingTask({ nodeId: 'uncertain', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', providerConfigId: 'original', taskId: '', taskType: 'custom-protocol', submitted: false });
    const error = new Error('wrapper containing private material', { cause: new HttpResponseError(status, 'private-key-and-response') });
    pauseMediaTask(receipt, error, 'submit_unknown');
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ mediaRecoveryState: 'submit_unknown',
      mediaFailureDiagnostic: { kind: 'http', httpStatus: status } });
    const stored = localStorage.getItem('ai_canvas_pending_tasks')!;
    expect(stored).not.toContain('private');
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ mediaTaskState: 'submit_unknown', error: undefined });
  });

  it('keeps known tasks recoverable when polling is rejected and retains the safe reason', () => {
    const receipt = savePendingTask({ nodeId: 'query', projectId: 'project-1', nodeType: 'ai-video',
      provider: 'general', providerConfigId: 'original', taskId: 'original-task', taskType: 'custom-protocol', submitted: true });
    pauseMediaTask(receipt, new HttpResponseError(401, 'sensitive API response', true), 'query_interrupted');
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: 'original-task',
      mediaRecoveryState: 'query_paused', mediaFailureDiagnostic: { kind: 'http', httpStatus: 401 } });
  });

  it('sanitizes forged diagnostics and retains only bounded network/timeout categories', () => {
    localStorage.setItem('ai_canvas_pending_tasks', JSON.stringify([{ nodeId: 'network', projectId: 'project-1',
      nodeType: 'ai-image', provider: 'general', taskId: '', taskType: 'custom-protocol', submitted: false,
      mediaFailureDiagnostic: { kind: 'network', raw: 'secret-key', httpStatus: 'secret-key' } }]));
    expect(getPendingTasksForProject('project-1')[0].mediaFailureDiagnostic).toEqual({ kind: 'network' });
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('secret-key');
  });

  it('keeps controllers, promises and mutable recovery state together without waiting for dispose', async () => {
    const hotData = {};
    const oldRuntime = createOrReusePollManagerRuntime(hotData);
    const controller = new AbortController();
    const receipt = { projectId: 'project-1', nodeId: 'hot-node', taskId: 'original-task', attemptId: 'original-attempt' };
    const error = new MediaTaskPausedError(receipt, 'query_interrupted');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    oldRuntime.abortControllers.set(receipt.nodeId, controller);
    oldRuntime.videoResumePromises.set(receipt.nodeId, pending);
    oldRuntime.mediaResumeOutcomes.set('outcome', { receipt, delivered: false });
    oldRuntime.mediaTaskContexts.set(receipt.nodeId, { projectId: receipt.projectId, messageId: 'original-message' });
    oldRuntime.mediaTaskObservers.set(receipt.nodeId, vi.fn());
    oldRuntime.activeMediaOperations.set('lease', new Set([Symbol()]));
    const listener = vi.fn();
    oldRuntime.mediaTaskListeners.add(listener);
    oldRuntime.runninghubMessageWaiters.set('runninghub', vi.fn());
    oldRuntime.workflowApiMessageWaiters.set('workflow-api', vi.fn());
    oldRuntime.activeComfyDeliveries.set('delivery', { projectId: receipt.projectId, nodeId: receipt.nodeId, taskId: receipt.taskId });
    oldRuntime.comfyDeliveryListeners.add(listener);
    oldRuntime.pausedErrors.add(error);
    const oldHandler = vi.fn(async () => {});
    oldRuntime.mediaMessageRecoveryHandler = oldHandler;

    const refreshed = createOrReusePollManagerRuntime(hotData);
    expect(refreshed).toBe(oldRuntime);
    expect(refreshed.videoResumePromises.get(receipt.nodeId)).toBe(pending);
    expect(refreshed.pausedErrors.has(error)).toBe(true);
    const replacementHandler = vi.fn(async () => {});
    refreshed.mediaMessageRecoveryHandler = replacementHandler;
    expect(oldRuntime.mediaMessageRecoveryHandler).toBe(replacementHandler);
    refreshed.abortControllers.get(receipt.nodeId)?.abort();
    expect(controller.signal.aborted).toBe(true);
    oldRuntime.mediaTaskListeners.forEach((notify) => notify());
    expect(listener).toHaveBeenCalledOnce();
    oldRuntime.activeMediaOperations.delete('lease');
    expect(refreshed.activeMediaOperations.size).toBe(0);
    finish();
    await refreshed.videoResumePromises.get(receipt.nodeId);
    expect(localStorage.length).toBe(0);
  });

  it('isolates cold runtimes and only recognizes actual pause errors', () => {
    const left = createOrReusePollManagerRuntime();
    const right = createOrReusePollManagerRuntime();
    left.activeMediaOperations.set('private', new Set([Symbol()]));
    left.mediaTaskListeners.add(vi.fn());
    expect(right.activeMediaOperations.size).toBe(0);
    expect(right.mediaTaskListeners.size).toBe(0);
    const receipt = { projectId: 'project-1', nodeId: 'paused', taskId: 'original' };
    expect(isMediaTaskPausedError(new MediaTaskPausedError(receipt, 'query_timeout'))).toBe(true);
    expect(isMediaTaskPausedError(Object.assign(new Error('not a paused task'), { name: 'MediaTaskPausedError', taskReceipt: receipt }))).toBe(false);
  });
});

describe('pending generation task recovery', () => {
  it('clears confirmed failures by exact receipt without clearing a newer attempt', () => {
    useAppStore.setState({ nodes: [{ id: 'rejected', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '图片', status: 'loading', mediaTaskState: 'submit_unknown' } }] });
    const task = { nodeId: 'rejected', projectId: 'project-1', nodeType: 'ai-image' as const,
      provider: 'general', taskId: '', taskType: 'custom-protocol' as const, submitted: false };
    const oldReceipt = savePendingTask(task);
    const currentReceipt = savePendingTask(task);
    removeFailedMediaTask(oldReceipt);
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
    removeFailedMediaTask(currentReceipt);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBeUndefined();
  });

  it('projects a background confirmed failure as an error after returning without querying or changing the other project', async () => {
    const originalNode = { id: 'same-node', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image' as const, label: '原项目图片', status: 'loading' as const } };
    useAppStore.setState({ nodes: [originalNode] });
    const original = savePendingTask({ nodeId: originalNode.id, projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', taskId: '', taskType: 'custom-protocol', submitted: false });
    useAppStore.setState({ currentProjectId: 'project-2', nodes: [{ ...originalNode,
      data: { ...originalNode.data, label: '其他项目图片' } }] });
    const other = savePendingTask({ nodeId: originalNode.id, projectId: 'project-2', nodeType: 'ai-image',
      provider: 'general', taskId: 'other-task', taskType: 'custom-protocol', submitted: true });
    removeFailedMediaTask(original);
    const failed = getPendingTasksForProject('project-1')[0];
    expect(failed).toMatchObject({ terminalFailure: true });
    expect(canResumeMediaTask(failed)).toBe(false);
    expect(pauseMediaTask(original, new Error('late cleanup'), 'submit_unknown')).toBeUndefined();
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    expect(getPendingTasksForProject('project-2')[0].attemptId).toBe(other.attemptId);
    useAppStore.setState({ currentProjectId: 'project-1', nodes: [originalNode] });
    await resumePendingTasks('project-1');
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'error',
      error: '生成失败：服务商已明确拒绝请求或任务已失败', mediaTaskState: undefined });
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(getPendingTasksForProject('project-2')[0].attemptId).toBe(other.attemptId);
  });

  it.each([false, true])('persists a background failed message before clearing its terminal record (loaded=%s)', async (loaded) => {
    const db = await import('../../src/services/indexedDbService');
    const history = await import('../../src/services/chat/chatHistoryService');
    const stored = { id: 'failed-message', projectId: 'project-1', conversationId: 'original-conversation',
      role: 'assistant' as const, content: '', status: 'done', sequence: 0, createdAt: 1, updatedAt: 1, mediaStatus: 'generating' };
    const read = vi.spyOn(db, 'getConversationMessages').mockResolvedValue({ messages: [stored], total: 1 });
    const put = vi.spyOn(db, 'putChatMessage').mockResolvedValue();
    const persist = vi.spyOn(history, 'persistMessage').mockResolvedValue();
    try {
      const receipt = savePendingTask({ nodeId: 'media-message-failed', projectId: 'project-1', nodeType: 'ai-image',
        provider: 'general', taskId: '', taskType: 'custom-protocol', submitted: false,
        mediaContext: { projectId: 'project-1', conversationId: stored.conversationId, messageId: stored.id, deliveryMode: 'message' } });
      useAppStore.setState({ currentProjectId: 'project-2' });
      removeFailedMediaTask(receipt);
      useAppStore.setState({ currentProjectId: 'project-1', messages: loaded ? [{ id: stored.id, conversationId: stored.conversationId,
        role: 'assistant', content: '', status: 'done', timestamp: 1, mediaStatus: 'generating' }] : [] });
      await expect(resumeMediaNodeTask(receipt.nodeId)).rejects.toThrow('生成失败');
      await resumePendingTasks('project-1');
      const patch = { mediaStatus: 'failed', mediaError: '生成失败：服务商已明确拒绝请求或任务已失败' };
      if (loaded) {
        expect(persist).toHaveBeenCalledWith(expect.objectContaining(patch), 'project-1', stored.conversationId);
        expect(useAppStore.getState().messages[0]).toMatchObject(patch);
        expect(put).not.toHaveBeenCalled();
      } else expect(put).toHaveBeenCalledWith(expect.objectContaining({ ...stored, ...patch, updatedAt: expect.any(Number) }));
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } finally { read.mockRestore(); put.mockRestore(); persist.mockRestore(); }
  });

  it('retains a confirmed failure if the original message cannot be persisted', async () => {
    const db = await import('../../src/services/indexedDbService');
    const read = vi.spyOn(db, 'getConversationMessages').mockRejectedValue(new Error('storage unavailable'));
    try {
      const receipt = savePendingTask({ nodeId: 'unsaved-message-failure', projectId: 'project-1', nodeType: 'ai-image',
        provider: 'general', taskId: '', taskType: 'custom-protocol', submitted: false,
        mediaContext: { projectId: 'project-1', conversationId: 'original', messageId: 'failed', deliveryMode: 'message' } });
      useAppStore.setState({ currentProjectId: 'project-2' });
      removeFailedMediaTask(receipt);
      useAppStore.setState({ currentProjectId: 'project-1' });
      await resumePendingTasks('project-1');
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ ...receipt, terminalFailure: true });
      await expect(resumeMediaNodeTask(receipt.nodeId)).rejects.toThrow('生成失败');
    } finally { read.mockRestore(); }
  });

  it('persists a confirmed failure after changing only the conversation within the same project', async () => {
    const db = await import('../../src/services/indexedDbService');
    const stored = { id: 'background-message', projectId: 'project-1', conversationId: 'previous-conversation',
      role: 'assistant' as const, content: '', status: 'done', sequence: 0, createdAt: 1, updatedAt: 1, mediaStatus: 'generating' };
    const read = vi.spyOn(db, 'getConversationMessages').mockResolvedValue({ messages: [stored], total: 1 });
    const put = vi.spyOn(db, 'putChatMessage').mockResolvedValue();
    try {
      const receipt = savePendingTask({ nodeId: 'media-message-background', projectId: 'project-1', nodeType: 'ai-image',
        provider: 'general', taskId: '', taskType: 'custom-protocol', submitted: false,
        mediaContext: { projectId: 'project-1', conversationId: stored.conversationId, messageId: stored.id, deliveryMode: 'message' } });
      removeFailedMediaTask(receipt);
      await vi.waitFor(() => expect(getPendingTasksForProject('project-1')).toEqual([]));
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id, projectId: 'project-1',
        conversationId: stored.conversationId, mediaStatus: 'failed' }));
      expect(useAppStore.getState().messages).toEqual([]);
    } finally { read.mockRestore(); put.mockRestore(); }
  });

  it('keeps independently generating siblings when the current batch query returns a terminal failure', async () => {
    const nodes = ['failed-query-source', 'independent-query-child'].map((id) => ({ id, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image' as const, label: id, status: 'loading' as const, batchGroupId: 'query-batch' } }));
    useAppStore.setState((state) => ({ nodes, config: { ...state.config,
      providers: { recovery: { name: 'Fixture', apiKey: 'fixture', baseUrl: 'https://gateway.example' } } } }));
    const source = savePendingTask({ nodeId: nodes[0].id, projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'recovery', taskId: 'failed-task', taskType: 'custom-protocol', submitted: true, batchCount: 2,
      protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/failed-task', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    const child = savePendingTask({ nodeId: nodes[1].id, projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      taskId: 'new-task', taskType: 'custom-protocol', submitted: true });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'failed' })));
    vi.stubGlobal('fetch', fetch);
    await expect(resumeMediaNodeTask(source.nodeId)).rejects.toBeInstanceOf(PollTaskFailedError);
    expect(useAppStore.getState().nodes[0].data.status).toBe('error');
    expect(useAppStore.getState().nodes[1].data.status).toBe('loading');
    expect(getPendingTasksForProject('project-1')).toEqual([expect.objectContaining(child)]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not project an old batch failure over a sibling that has its own task or live operation', async () => {
    const nodes = ['batch-source', 'independent-child', 'active-child'].map((id) => ({ id, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image' as const, label: id, status: 'loading' as const, batchGroupId: 'batch' } }));
    useAppStore.setState({ nodes });
    const source = savePendingTask({ nodeId: nodes[0].id, projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      taskId: '', taskType: 'custom-protocol', submitted: false, batchCount: 3 });
    useAppStore.setState({ currentProjectId: 'project-2' });
    removeFailedMediaTask(source);
    useAppStore.setState({ currentProjectId: 'project-1' });
    const child = savePendingTask({ nodeId: nodes[1].id, projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      taskId: 'independent-task', taskType: 'custom-protocol', submitted: true, mediaRecoveryState: 'query_paused' });
    const release = registerMediaNodeOperation(nodes[2].id);
    try {
      await resumePendingTasks('project-1');
      const result = useAppStore.getState().nodes;
      expect(result[0].data.status).toBe('error');
      expect(result[1].data.mediaTaskState).toBe('paused');
      expect(result[2].data.status).toBe('loading');
      expect(getPendingTasksForProject('project-1')).toEqual([expect.objectContaining(child)]);
    } finally { release(); }
  });

  it('stops sibling queries after a non-terminal batch failure while retaining explicit failure semantics', async () => {
    let siblingSignal!: AbortSignal;
    const results = await settleMediaTaskQueries<string>([
      async () => { throw new TypeError('query disconnected'); },
      async (signal) => {
        siblingSignal = signal;
        return await pollTask({ signal, fetchState: async () => await new Promise<null>(() => {}), isComplete: () => 'unused' });
      },
    ]);
    expect(siblingSignal.aborted).toBe(true);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    let remainingAborted = true;
    const terminal = await settleMediaTaskQueries<string>([
      async () => { throw new PollTaskFailedError('remote failure'); },
      async (signal) => { remainingAborted = signal.aborted; return 'completed sibling'; },
    ]);
    expect(remainingAborted).toBe(false);
    expect(terminal[1]).toEqual({ status: 'fulfilled', value: 'completed sibling' });
  });
  it('does not mark a live synchronous operation as an orphan during a recovery scan', async () => {
    useAppStore.setState({ nodes: [{ id: 'live-sync', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'Live image', status: 'loading' } }] });
    const releaseOuter = registerMediaNodeOperation('live-sync');
    const releaseInner = registerMediaNodeOperation('live-sync');
    releaseInner();
    await resumePendingTasks('project-1');
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    await resumePendingTasks('another-project');
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    releaseOuter();
    await resumePendingTasks('project-1');
    expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBe('submit_unknown');
  });

  it.each([false, true])('does not pause or duplicate a live async submission during recovery scanning (has ID: %s)', async (submitted) => {
    const nodeId = 'live-async';
    useAppStore.setState((state) => ({ nodes: [{ id: nodeId, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'Live image', status: 'loading' } }],
    config: { ...state.config, providers: { ...state.config.providers,
      recovery: { name: 'Recovery', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const receipt = savePendingTask({ nodeId, projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'recovery', taskType: 'custom-protocol', submitted, taskId: submitted ? 'original-task' : '',
      protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/original-task', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    const release = registerMediaNodeOperation(nodeId);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/original.png' })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({
      mediaUrl: 'asset://original.png', sourceUrl: 'https://cdn.example/original.png',
    });
    try {
      await resumePendingTasks('project-1');
      expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'loading' });
      expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBeUndefined();
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: receipt.taskId, submitted });
      expect(getPendingTasksForProject('project-1')[0].mediaRecoveryState).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { release(); }

    await resumePendingTasks('project-1');
    if (submitted) {
      await vi.waitFor(() => expect(useAppStore.getState().nodes[0].data.status).toBe('success'));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]).toMatchObject(['https://gateway.example/tasks/original-task', { method: 'GET' }]);
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown' });
      await expect(resumeMediaNodeTask(nodeId)).rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: receipt });
    }
  });

  it('keeps a registered query visible to recovery scanning until its matching cleanup runs', async () => {
    useAppStore.setState({ nodes: [{ id: 'controller-only', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'Controller image', status: 'loading' } }] });
    const oldSignal = registerNodePolling('controller-only');
    const currentSignal = registerNodePolling('controller-only');
    expect(oldSignal.aborted).toBe(true);
    expect(cleanupNodePolling('controller-only', oldSignal)).toBe(false);
    await resumePendingTasks('project-1');
    expect(useAppStore.getState().nodes[0].data.status).toBe('loading');
    expect(cleanupNodePolling('controller-only', currentSignal)).toBe(true);
    await resumePendingTasks('project-1');
    expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBe('submit_unknown');
  });

  it('requires the original attempt receipt to pause, discard, or acknowledge a task', () => {
    const task: PendingTask = { nodeId: 'receipt-node', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', taskType: 'general', submitted: true, taskId: 'same-remote-id' };
    const oldReceipt = savePendingTask(task);
    const freshReceipt = savePendingTask(task);
    expect(freshReceipt.attemptId).not.toBe(oldReceipt.attemptId);
    expect(pauseMediaTask(oldReceipt)).toBeUndefined();
    completeMediaNodeTask(oldReceipt);
    discardMediaTask(oldReceipt);
    expect(getMediaTaskReceipt('receipt-node')).toEqual(freshReceipt);
    completeMediaNodeTask(freshReceipt);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('observes the captured submit receipt without serializing callbacks or affecting another project with the same node ID', () => {
    const oldObserver = vi.fn();
    const releaseOld = bindMediaTaskContext('shared-node', { projectId: 'project-1', messageId: 'old-message' }, oldObserver);
    const observer = vi.fn();
    const release = bindMediaTaskContext('shared-node', { projectId: 'project-1', messageId: 'original-message' }, observer);
    releaseOld();
    const receipt = savePendingTask({ nodeId: 'shared-node', projectId: 'project-2', nodeType: 'ai-video',
      provider: 'comfyui', taskType: 'comfyui', submitted: false, taskId: '' });
    const accepted = updatePendingTask(receipt.nodeId, { submitted: true, taskId: 'original-prompt' }, '', receipt.attemptId)!;
    expect(observer.mock.calls.map(([value]) => value.taskId)).toEqual(['', 'original-prompt']);
    release();
    savePendingTask({ nodeId: 'shared-node', projectId: 'project-2', nodeType: 'ai-image',
      provider: 'general', taskType: 'general', submitted: true, taskId: 'other-project-task' });
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
    completeMediaNodeTask(accepted);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(getPendingTasksForProject('project-2')[0].taskId).toBe('other-project-task');
    expect(observer).toHaveBeenCalledTimes(2);
    expect(oldObserver).not.toHaveBeenCalled();
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('observer');
  });

  it('原任务仅持久化允许的媒体参数，保留 false、空背景及负数自动时长', () => {
    const parameters = { aspectRatio: '9:16', resolution: '720p', duration: -1, videoFps: 24,
      generateAudio: false, imageBackground: '', imageQuality: 'high', prompt: '不应保存', apiKey: 'secret' };
    const release = bindMediaTaskContext('media-parameters', { projectId: 'project-1', messageId: 'message', parameters });
    savePendingTask({ projectId: 'project-1', nodeId: 'media-parameters', nodeType: 'ai-video', provider: 'general',
      taskType: 'general', taskId: 'original-task', submitted: true });
    release();
    const saved = getPendingTasksForProject('project-1')[0];
    expect(saved.mediaContext?.parameters).toEqual({ aspectRatio: '9:16', resolution: '720p', duration: -1,
      videoFps: 24, generateAudio: false, imageBackground: '', imageQuality: 'high' });
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('secret');
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('不应保存');
  });

  it('显式空参数快照与旧任务无快照区分，敏感参数从恢复记录中剔除', () => {
    const release = bindMediaTaskContext('empty-parameters', { projectId: 'project-1', parameters: {} });
    savePendingTask({ projectId: 'project-1', nodeId: 'empty-parameters', nodeType: 'ai-video', provider: 'general',
      taskType: 'general', taskId: 'empty-task', submitted: true });
    release();
    const unsafe = { aspectRatio: 'https://private.example/file', resolution: 'C:\\private\\file',
      imageQuality: 'sk-example-secret', imageBackground: 'Bearer example-secret', generateAudio: false };
    const releaseUnsafe = bindMediaTaskContext('unsafe-parameters', { projectId: 'project-1', parameters: unsafe });
    savePendingTask({ projectId: 'project-1', nodeId: 'unsafe-parameters', nodeType: 'ai-video', provider: 'general',
      taskType: 'general', taskId: 'unsafe-task', submitted: true });
    releaseUnsafe();
    const tasks = getPendingTasksForProject('project-1');
    expect(tasks.find((task) => task.nodeId === 'empty-parameters')?.mediaContext?.parameters).toEqual({});
    expect(tasks.find((task) => task.nodeId === 'unsafe-parameters')?.mediaContext?.parameters).toEqual({ generateAudio: false });
    const saved = localStorage.getItem('ai_canvas_pending_tasks')!;
    for (const value of [unsafe.aspectRatio, unsafe.resolution, unsafe.imageQuality, unsafe.imageBackground]) expect(saved).not.toContain(value);
  });

  it('keeps an unknown submission without allowing a resume request or completion acknowledgement', async () => {
    const receipt = savePendingTask({ nodeId: 'unknown-node', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', taskType: 'general', submitted: false, taskId: '' });
    useAppStore.setState({ nodes: [{ id: 'unknown-node', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'Unknown image', status: 'loading' } }] });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await resumePendingTasks('project-1');
    await expect(resumeMediaNodeTask('unknown-node')).rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: receipt });
    completeMediaNodeTask(receipt);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ submitted: false, mediaRecoveryState: 'submit_unknown' });
    discardMediaTask(receipt);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('binds message-only tasks to their originating project and delivers through the registered handler', async () => {
    const releaseContext = bindMediaTaskContext('media-message-original', { projectId: 'project-1',
      conversationId: 'original-conversation', messageId: 'original-message', deliveryMode: 'message', modelId: 'image-model' });
    const receipt = savePendingTask({ nodeId: 'media-message-original', projectId: 'incorrect-current-project',
      nodeType: 'ai-image', provider: 'general', providerConfigId: 'message-provider', taskType: 'custom-protocol', submitted: true,
      taskId: 'message-task', protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/message-task', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    releaseContext();
    expect(receipt.projectId).toBe('project-1');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'message-provider': { name: 'Message provider', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/image.png' })));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async (task: PendingTask, urls: string[]) => {
      expect(task.mediaContext).toMatchObject({ conversationId: 'original-conversation', messageId: 'original-message' });
      expect(urls).toEqual(['https://cdn.example/image.png']);
      expect(getPendingTasksForProject('project-1')).toHaveLength(1);
      completeMediaNodeTask(receipt);
    });
    const oldHandler = vi.fn(async () => {});
    const unregisterOld = registerMediaMessageRecoveryHandler(oldHandler);
    const unregister = registerMediaMessageRecoveryHandler(handler);
    unregisterOld();
    try {
      await resumePendingTasks('project-1');
      expect(handler).not.toHaveBeenCalled();
      await resumeMediaNodeTask('media-message-original');
      expect(handler).toHaveBeenCalledOnce();
      expect(oldHandler).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(useAppStore.getState().nodes).toEqual([]);
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } finally { unregister(); }
  });

  it.each([false, true])('recovers an auth:none task without a key, including batch polling (%s)', async (batch) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      public: { name: 'Public', apiKey: '', baseUrl: 'https://gateway.example' } } } }));
    const poll = { method: 'GET' as const, url: 'https://gateway.example/tasks/public', auth: { type: 'none' as const },
      intervalMs: 1, statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' };
    const receipt = savePendingTask({ nodeId: 'public-message', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', providerConfigId: 'public', taskType: 'custom-protocol', submitted: true, taskId: 'public-task',
      mediaContext: { projectId: 'project-1', conversationId: 'conversation', messageId: 'message', deliveryMode: 'message' },
      protocolPoll: poll, ...(batch ? { protocolPolls: [poll, { ...poll, url: `${poll.url}-second` }] } : {}) });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', url: 'https://cdn.example/public.png',
    })));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => { completeMediaNodeTask(receipt); });
    const unregister = registerMediaMessageRecoveryHandler(handler);
    try {
      await resumeMediaNodeTask(receipt.nodeId);
      expect(fetchMock).toHaveBeenCalledTimes(batch ? 2 : 1);
      for (const [, init] of fetchMock.mock.calls) expect(init.headers).not.toHaveProperty('Authorization');
      expect(handler).toHaveBeenCalledOnce();
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } finally { unregister(); }
  });

  it.each([
    undefined, { type: 'bearer' }, { type: 'header', name: 'X-Api-Key' }, { type: 'query', name: 'api_key' },
  ] as const)('keeps a keyless task when any batch poll needs authentication (%j)', async (auth) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      protected: { name: 'Protected', apiKey: '', baseUrl: 'https://gateway.example' } } } }));
    const poll = { method: 'GET' as const, url: 'https://gateway.example/tasks/protected', auth: { type: 'none' as const },
      intervalMs: 1, statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' };
    const receipt = savePendingTask({ nodeId: 'protected-message', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', providerConfigId: 'protected', taskType: 'custom-protocol', submitted: true, taskId: 'protected-task',
      mediaContext: { projectId: 'project-1', messageId: 'message', deliveryMode: 'message' },
      protocolPoll: poll, protocolPolls: [poll, { ...poll, auth }] });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await resumeMediaNodeTask(receipt.nodeId);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getMediaTaskReceipt(receipt.nodeId)).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0].mediaRecoveryState).toBe('query_paused');
  });

  it('refuses manual recovery until the original delivery operation releases its lease', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      delivery: { name: 'Delivery', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const receipt = savePendingTask({ nodeId: 'original-delivery', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'general', providerConfigId: 'delivery', taskType: 'custom-protocol', submitted: true, taskId: 'delivery-task',
      mediaRecoveryState: 'delivery_pending',
      mediaContext: { projectId: 'project-1', messageId: 'message', deliveryMode: 'message' },
      protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/delivery', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    const release = registerMediaNodeOperation(receipt.nodeId);
    const original = getPendingTasksForProject('project-1')[0];
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', url: 'https://cdn.example/original.png',
    })));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => { completeMediaNodeTask(receipt); });
    const unregister = registerMediaMessageRecoveryHandler(handler);
    try {
      expect(canResumeMediaTask(original)).toBe(false);
      await expect(resumeMediaNodeTask(receipt.nodeId)).rejects.toThrow('仍在处理或保存');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('project-1')).toEqual([original]);
      release();
      expect(canResumeMediaTask(original)).toBe(true);
      await resumeMediaNodeTask(receipt.nodeId);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } finally { release(); unregister(); }
  });

  it('keeps the old image batch targets when its source starts a new single-image generation', async () => {
    useAppStore.setState((state) => ({ nodes: [
      { id: 'batch-source', type: 'ai-image', position: { x: 0, y: 0 }, data: {
        type: 'ai-image', label: 'Batch', status: 'idle', batchCount: 1, batchGroupId: 'old-batch' } },
      { id: 'batch-second', type: 'ai-image', position: { x: 320, y: 0 }, data: {
        type: 'ai-image', label: 'Batch 2', status: 'idle', batchGroupId: 'old-batch' } },
    ], config: { ...state.config, providers: { ...state.config.providers,
      recovery: { name: 'Recovery', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    savePendingTask({ nodeId: 'batch-source', projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'recovery', taskType: 'custom-protocol', taskId: 'old-task', submitted: true,
      batchCount: 2, mediaRecoveryState: 'query_paused', protocolPoll: {
        method: 'GET', url: 'https://gateway.example/tasks/old-task', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'urls.*' } });
    prepareMediaNodeGeneration('batch-source');
    const recovery = getPendingTasksForProject('project-1')[0];
    expect(useAppStore.getState().nodes.find((node) => node.id === 'batch-source')?.data.batchGroupId).toBeUndefined();
    expect(useAppStore.getState().nodes.find((node) => node.id === recovery.nodeId)?.data.batchGroupId).toBe('old-batch');
    useAppStore.getState().updateNodeDataTransient('batch-source', { status: 'success', imageUrl: 'asset://new-single-image' });
    const urls = ['https://cdn.example/old-one.png', 'https://cdn.example/old-two.png'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', urls }))));
    vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockImplementation(async (url) => ({
      mediaUrl: url === urls[0] ? 'asset://old-one' : 'asset://old-two', sourceUrl: url,
    }));
    vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockResolvedValue(undefined);
    await resumeMediaNodeTask(recovery.nodeId);
    const nodes = useAppStore.getState().nodes;
    expect(nodes.find((node) => node.id === recovery.nodeId)?.data.imageUrl).toBe('asset://old-one');
    expect(nodes.find((node) => node.id === 'batch-second')?.data.imageUrl).toBe('asset://old-two');
    expect(nodes.find((node) => node.id === 'batch-source')?.data.imageUrl).toBe('asset://new-single-image');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('installs message delivery on demand when a recovered canvas node is resumed first', async () => {
    useAppStore.setState((state) => ({ nodes: [{ id: 'message-node', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'Message image', status: 'idle' } }],
    config: { ...state.config, providers: { ...state.config.providers,
      recovery: { name: 'Recovery', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const receipt = savePendingTask({ nodeId: 'message-node', projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'recovery', taskType: 'custom-protocol', taskId: 'original-message-task', submitted: true,
      mediaContext: { projectId: 'project-1', conversationId: 'original-conversation', messageId: 'original-message',
        deliveryMode: 'node+message', canvasNodeId: 'message-node' }, protocolPoll: {
        method: 'GET', url: 'https://gateway.example/tasks/original-message-task', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/original-result.png' }))));
    const runtime = await import('../../src/services/ai/generationRuntime');
    const handler = vi.fn(async () => { completeMediaNodeTask(receipt); });
    let unregister: (() => void) | undefined;
    const ensure = vi.spyOn(runtime, 'ensureMediaMessageRecoveryHandler').mockImplementation(() => {
      unregister = registerMediaMessageRecoveryHandler(handler);
    });
    try {
      await resumeMediaNodeTask('message-node');
      expect(ensure).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } finally { unregister?.(); ensure.mockRestore(); }
  });

  it('preserves a paused video start time when restoring its node state', async () => {
    useAppStore.setState({ nodes: [{ id: 'paused-video', type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: 'Video', status: 'loading' } }] });
    savePendingTask({ nodeId: 'paused-video', projectId: 'project-1', nodeType: 'ai-video', provider: 'general',
      taskType: 'general', taskId: 'video-task', submitted: true, mediaRecoveryState: 'query_paused',
      videoGenerationStartedAt: 123456 });
    await resumePendingTasks('project-1');
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', videoTaskState: 'paused', generationStartedAt: 123456 });
  });

  it('continues legacy disconnected ComfyUI image recovery after reopening its project', async () => {
    useAppStore.setState({ nodes: [{ id: 'legacy-comfy', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'Comfy image', status: 'error', error: 'ComfyUI connection interrupted' } }] });
    savePendingTask({ nodeId: 'legacy-comfy', projectId: 'project-1', nodeType: 'ai-image', provider: 'comfyui',
      taskType: 'comfyui', baseUrl: 'http://comfy.example:8188', taskId: 'old-prompt', submitted: true, comfyRecoveryState: 'disconnected' });
    vi.spyOn(comfyPolling, 'pollComfyHistory').mockResolvedValue({ url: 'http://comfy.example:8188/result.png' });
    vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({ mediaUrl: 'asset://comfy-result', sourceUrl: 'http://comfy.example:8188/result.png' });
    await resumePendingTasks('project-1');
    await vi.waitFor(() => expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', imageUrl: 'asset://comfy-result' }));
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it.each(['ai-image', 'ai-audio'] as const)('keeps %s tasks after local saving fails and only re-queries the original ID', async (nodeType) => {
    useAppStore.setState((state) => ({ nodes: [{ id: 'save-media', type: nodeType, position: { x: 0, y: 0 },
      data: { type: nodeType, label: 'Media save', status: 'loading' } }], config: { ...state.config, providers: {
      ...state.config.providers, saved: { name: 'Saved provider', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const receipt = savePendingTask({ nodeId: 'save-media', projectId: 'project-1', nodeType, provider: 'general',
      providerConfigId: 'saved', taskType: 'custom-protocol', submitted: true, taskId: 'already-completed', protocolPoll: {
        method: 'GET', url: 'https://gateway.example/tasks/already-completed', intervalMs: 1, statusPath: 'status',
        successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/result' })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ mediaUrl: 'asset://saved-result', sourceUrl: 'https://cdn.example/result' });
    await resumeMediaNodeTask('save-media');
    expect(getMediaTaskReceipt('save-media')).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0].mediaRecoveryState).toBe('delivery_pending');
    await resumeMediaNodeTask('save-media');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it.each(['ai-image', 'ai-video'] as const)('continues saving returned synchronous %s URLs without a new submission or query', async (nodeType) => {
    const resultUrl = `https://relayonapi.com/v1/results/original-${nodeType}`;
    const mediaDownloadAccess = { providerConfigId: 'relay-original', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    useAppStore.setState((state) => ({ nodes: [{ id: 'returned-result', type: nodeType, position: { x: 0, y: 0 },
      data: { type: nodeType, label: 'Returned result', status: 'loading' } }], config: { ...state.config, providers: {
      'relay-original': { name: 'Original', apiKey: 'previous-key', baseUrl: 'https://relayonapi.com/v1' },
      'relay-other': { name: 'Other group', apiKey: 'other-key', baseUrl: 'https://relayonapi.com/v1' },
    } } }));
    const receipt = savePendingTask({ nodeId: 'returned-result', projectId: 'project-1', nodeType, provider: 'general',
      providerConfigId: 'relay-original', taskType: 'custom-protocol', submitted: true, taskId: 'returned-sync-result',
      resultUrls: [resultUrl], mediaDownloadAccess, mediaRecoveryState: 'delivery_pending' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const requests: unknown[] = [];
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockImplementation(async (url, _projectId, _kind, _label, options) => {
      const { resolveMediaDownloadRequest } = await import('../../src/services/ai/mediaDownloadAccess');
      requests.push(await resolveMediaDownloadRequest(url, options?.mediaDownloadAccess));
      if (requests.length === 1) throw new Error('download disconnected');
      return { mediaUrl: 'asset://saved-result', sourceUrl: url };
    });
    await resumeMediaNodeTask('returned-result');
    expect(getMediaTaskReceipt('returned-result')).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ resultUrls: [resultUrl], mediaDownloadAccess,
      mediaRecoveryState: 'delivery_pending' });
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('previous-key');
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('other-key');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'relay-original': { ...state.config.providers['relay-original'], apiKey: 'rotated-original-key' },
    } } }));
    await resumeMediaNodeTask('returned-result');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      { url: resultUrl, downloadAccess: { origin: mediaDownloadAccess.origin, headers: { Authorization: 'Bearer previous-key' } } },
      { url: resultUrl, downloadAccess: { origin: mediaDownloadAccess.origin, headers: { Authorization: 'Bearer rotated-original-key' } } },
    ]);
    expect(JSON.stringify(requests)).not.toContain('other-key');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
  });

  it('recovers a message-only ComfyUI result without creating a node or clearing a failed message delivery', async () => {
    const release = bindMediaTaskContext('media-message-comfy', { projectId: 'project-1',
      conversationId: 'comfy-conversation', messageId: 'comfy-message', deliveryMode: 'message' });
    const receipt = savePendingTask({ nodeId: 'media-message-comfy', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'comfyui', taskType: 'comfyui', taskId: 'original-comfy-prompt', submitted: true, baseUrl: 'http://comfy.example:8188' });
    release();
    const poll = vi.spyOn(comfyPolling, 'pollComfyHistory').mockResolvedValue({ url: 'http://comfy.example:8188/view?filename=image.png' });
    const handler = vi.fn().mockRejectedValueOnce(new Error('message save failed')).mockImplementationOnce(async () => {
      completeMediaNodeTask(receipt);
    });
    const unregister = registerMediaMessageRecoveryHandler(handler);
    try {
      await resumePendingTasks('project-1');
      await resumeMediaNodeTask('media-message-comfy');
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: 'original-comfy-prompt',
        comfyRecoveryState: 'save_pending', mediaRecoveryState: 'delivery_pending' });
      await resumeMediaNodeTask('media-message-comfy');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(poll.mock.calls.every(([, promptId]) => promptId === 'original-comfy-prompt')).toBe(true);
      expect(useAppStore.getState().nodes).toEqual([]);
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    } finally { unregister(); }
  });

  it('rejects a message-only remote video failure even after the terminal task record is cleared', async () => {
    const release = bindMediaTaskContext('failed-message-video', { projectId: 'project-1',
      conversationId: 'original-conversation', messageId: 'original-message', deliveryMode: 'message' });
    savePendingTask({ nodeId: 'failed-message-video', projectId: 'project-1', nodeType: 'ai-video', provider: 'general',
      providerConfigId: 'failed-message-provider', taskType: 'custom-protocol', taskId: 'failed-task', submitted: true,
      protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/failed-task', intervalMs: 1, statusPath: 'status',
        successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    release();
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'failed-message-provider': { name: 'Failed message provider', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'failed' }))));
    await expect(resumeMediaNodeTask('failed-message-video')).rejects.toBeInstanceOf(PollTaskFailedError);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes).toEqual([]);
  });

  it.each([
    { type: 'source-image', generationType: 'ai-image', field: 'imageUrl', extension: 'png' },
    { type: 'source-video', generationType: 'ai-video', field: 'videoUrl', extension: 'mp4' },
    { type: 'source-audio', generationType: 'ai-audio', field: 'audioUrl', extension: 'mp3' },
  ] as const)('recovers $type into its own media field without changing its canvas type', async ({ type, generationType, field, extension }) => {
    const url = `https://cdn.example/result.${extension}`;
    const localUrl = `asset://result.${extension}`;
    useAppStore.setState((state) => ({
      config: { ...state.config, providers: { ...state.config.providers,
        'source-provider': { name: '源节点模型', apiKey: 'test-key', baseUrl: 'https://gateway.example/v1', catalogId: 'custom-openai' } } },
      nodes: [{ id: 'source-node', type, position: { x: 12, y: 34 },
        data: { type, role: 'source', label: '原始素材', status: 'loading', assetId: 'asset-1', prompt: '生成' } }],
    }));
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({ mediaUrl: localUrl, sourceUrl: url });
    const history = vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url })));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = savePendingTask({ nodeId: 'source-node', projectId: 'project-1', nodeType: type, provider: 'general',
      providerConfigId: 'source-provider', taskId: 'existing-task', taskType: 'custom-protocol', submitted: true,
      protocolPoll: { method: 'GET', url: 'https://gateway.example/v1/tasks/existing-task', intervalMs: 1,
        statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    expect(getPendingTasksForProject('project-1')[0].nodeType).toBe(generationType);
    await resumePendingTasks('project-1');
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0]).toMatchObject({ id: 'source-node', type, position: { x: 12, y: 34 },
        data: { type, role: 'source', assetId: 'asset-1', status: 'success', [field]: localUrl } });
      expect(getPendingTasksForProject('project-1')).toEqual([]);
    });
    expect(persist).toHaveBeenCalledWith(url, 'project-1', generationType, '原始素材', {
      mediaDownloadAccess: { providerConfigId: 'source-provider', origin: 'https://gateway.example' },
    });
    expect(history).toHaveBeenCalledWith('source-node', expect.objectContaining({ nodeType: generationType, mediaUrl: localUrl }), false, receipt);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads legacy source-video task records as video tasks while retaining their remote identity', () => {
    localStorage.setItem('ai_canvas_pending_tasks', JSON.stringify([{ nodeId: 'legacy-video', projectId: 'project-1',
      nodeType: 'source-video', provider: 'general', providerConfigId: 'original-provider', taskId: 'original-task',
      taskType: 'custom-protocol', submitted: true, videoRecoveryState: 'paused' }]));
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ nodeId: 'legacy-video', nodeType: 'ai-video',
      providerConfigId: 'original-provider', taskId: 'original-task', videoRecoveryState: 'paused' });
  });

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
    await vi.waitFor(() => expect(useAppStore.getState().nodes[0].data).toMatchObject({
      status: 'success', videoUrl: 'asset://recovered-video.mp4',
    }));
    expect(persistMedia).toHaveBeenCalledWith('data:video/mp4;base64,AQID', 'project-1', 'ai-video', 'Video', {
      mediaDownloadAccess: { providerConfigId: 'custom-video', origin: 'https://gateway.example' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('https://gateway.example/v1/videos/video-1/content',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'video/mp4', Authorization: 'Bearer current-provider-key' } }));
    expect(getPendingTasksForProject('project-1')).toEqual([]);
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
