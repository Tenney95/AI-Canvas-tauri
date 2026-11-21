import { describe, expect, it, vi } from 'vitest';
import {
  getPendingTasksForProject,
  canResumeMediaTask,
  resumePendingTasks,
  savePendingTask,
  bindMediaTaskContext,
  completeMediaNodeTask,
  discardMediaTask,
  removeFailedMediaTask,
  getMediaTaskReceipt,
  pauseMediaTask,
  prepareMediaNodeGeneration,
  registerMediaMessageRecoveryHandler,
  registerMediaNodeOperation,
  registerNodePolling,
  cleanupNodePolling,
  resumeMediaNodeTask,
  settleMediaTaskQueries,
  updatePendingTask,
  type PendingTask,
} from '../../../src/services/pollManager';
import { pollTask, PollTaskFailedError } from '../../../src/services/pollTask';
import { useAppStore } from '../../../src/store/useAppStore';
import type { ImageOutputParameters, ResolvedModelProtocolPoll } from '../../../src/types/aiTypes';
import * as fileService from '../../../src/services/fileService';
import * as comfyPolling from '../../../src/services/comfyPolling';
import * as indexedDbService from '../../../src/services/indexedDbService';
import { createH3QuickAdaptTemplate } from '../../../src/services/ai/h3ModelCapabilities';
import { resolveModelExecutionProfile } from '../../../src/services/ai/modelProtocol';
import { resolvePoll } from '../../../src/services/ai/modelProtocolPoll';

function saveMinimaxRecoveryTask(overrides: Partial<ResolvedModelProtocolPoll> = {}) {
  const baseUrl = 'https://api.minimax.cn';
  const taskId = 'original-minimax-task';
  const profile = createH3QuickAdaptTemplate('h3-standard', 'minimax').executionProfile;
  const protocol = resolveModelExecutionProfile(profile)!;
  const protocolPoll = { ...resolvePoll(baseUrl, protocol.poll!, protocol.auth, { submit: { task_id: taskId } }),
    intervalMs: 1, retry: { maxRetries: 0 }, ...overrides };
  useAppStore.setState((state) => ({ nodes: [{ id: 'minimax-recovery', type: 'ai-video', position: { x: 0, y: 0 },
    data: { type: 'ai-video', label: 'MiniMax 视频', status: 'idle' } }], config: { ...state.config, providers: {
    // 原任务的查询身份不随用户后来改名、切换厂商类型或修改模型协议而改变。
    'original-minimax': { name: '已改名的连接', catalogId: 'custom-openai', baseUrl, apiKey: 'rotated-original-key' },
    'other-minimax': { name: 'MiniMax', catalogId: 'minimax', baseUrl, apiKey: 'other-key' },
  } } }));
  return savePendingTask({ nodeId: 'minimax-recovery', projectId: 'project-1', nodeType: 'ai-video', provider: 'general',
    providerConfigId: 'original-minimax', taskType: 'custom-protocol', submitted: true, taskId, protocolPoll,
    mediaDownloadAccess: { providerConfigId: 'original-minimax', origin: baseUrl, auth: { type: 'bearer' } } });
}

export function registerGenerationDeliveryTests() {
  it('retains a prepared Muse UUID for query-only recovery without claiming it was sent', () => {
    const task: PendingTask = { nodeId: 'muse-node', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'muse', providerConfigId: 'muse', taskId: 'ac655c56-b537-4c04-8913-fd150fc0e92a', taskType: 'muse',
      submitted: false, mediaSubmissionUncertain: true, mediaRecoveryState: 'submit_unknown' };
    const receipt = savePendingTask(task);
    pauseMediaTask(receipt, undefined, 'submit_unknown');
    const retained = getPendingTasksForProject('project-1')[0];
    expect(retained).toMatchObject({ taskId: task.taskId, submitted: false, mediaRecoveryState: 'query_paused' });
    expect(canResumeMediaTask(retained)).toBe(true);
    expect(canResumeMediaTask({ ...retained, taskId: '' })).toBe(false);
    expect(canResumeMediaTask({ ...retained, taskId: 'invalid-task' })).toBe(false);
    expect(canResumeMediaTask({ ...retained, taskType: 'custom-protocol', provider: 'general' })).toBe(false);
  });

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
    const db = await import('../../../src/services/indexedDbService');
    const history = await import('../../../src/services/chat/chatHistoryService');
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
    const db = await import('../../../src/services/indexedDbService');
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
    const db = await import('../../../src/services/indexedDbService');
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

  describe('GIF 原任务恢复参数', () => {
    const valid: ImageOutputParameters = { imageOutputFormat: 'gif', imageFrameCount: 9,
      imageFrameDurationMs: 200, imageTransparent: false };

    function capture(parameters: ImageOutputParameters): PendingTask {
      const release = bindMediaTaskContext('gif-parameters', { projectId: 'project-1', parameters });
      try {
        savePendingTask({ projectId: 'project-1', nodeId: 'gif-parameters', nodeType: 'ai-image', provider: 'general',
          taskType: 'general', taskId: 'original-gif-task', submitted: true });
      } finally { release(); }
      return getPendingTasksForProject('project-1')[0];
    }

    it('解绑后从持久化记录读回帧数、帧时长及 false，并保留合法上下限', () => {
      for (const [imageFrameCount, imageFrameDurationMs, imageTransparent] of [[2, 20, false], [16, 655350, true], [9, 200, false]] as const) {
        const parameters = { ...valid, imageFrameCount, imageFrameDurationMs, imageTransparent };
        expect(capture(parameters).mediaContext?.parameters).toEqual(parameters);
        const [stored] = JSON.parse(localStorage.getItem('ai_canvas_pending_tasks')!);
        expect(stored.mediaContext.parameters).toEqual(parameters);
      }
    });

    it('恢复读取拒绝超界、非整数、错误步进及文本值，只保留其他合法参数', () => {
      const task = capture(valid);
      for (const [field, invalid] of [
        ['imageFrameCount', 1], ['imageFrameCount', 17], ['imageFrameCount', 2.5], ['imageFrameCount', '9'],
        ['imageFrameCount', Number.NaN], ['imageFrameDurationMs', 10], ['imageFrameDurationMs', 655360],
        ['imageFrameDurationMs', 25], ['imageFrameDurationMs', Number.POSITIVE_INFINITY], ['imageFrameDurationMs', '200'],
        ['imageTransparent', 'false'], ['imageTransparent', 0],
      ] as const) {
        localStorage.setItem('ai_canvas_pending_tasks', JSON.stringify([{ ...task,
          mediaContext: { ...task.mediaContext, parameters: { ...valid, [field]: invalid } } }]));
        const expected = { ...valid };
        delete expected[field];
        expect(getPendingTasksForProject('project-1')[0].mediaContext?.parameters).toEqual(expected);
      }
    });

    it('PNG、SVG 及未声明格式不持久化 GIF 专属参数，也不补默认值', () => {
      for (const imageOutputFormat of ['png', 'svg', undefined] as const) {
        expect(capture({ ...valid, imageOutputFormat }).mediaContext?.parameters)
          .toEqual(imageOutputFormat ? { imageOutputFormat } : {});
      }
      expect(capture({ imageOutputFormat: 'gif' }).mediaContext?.parameters).toEqual({ imageOutputFormat: 'gif' });
    });
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
    const runtime = await import('../../../src/services/ai/generationRuntime');
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

  it.each([1004, 1000])('keeps the original MiniMax task on business query error %i and resumes without submitting again', async (code) => {
    const receipt = saveMinimaxRecoveryTask();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ base_resp: { status_code: code, status_msg: 'private-query-detail' },
        task: { status: 'succeeded', content: { url: 'https://cdn.example/unconfirmed.mp4' } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' },
        task: { status: 'succeeded', content: { url: 'https://cdn.example/original.mp4' } } })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData')
      .mockResolvedValue({ mediaUrl: 'asset://minimax-video.mp4', sourceUrl: 'https://cdn.example/original.mp4' });

    await resumeMediaNodeTask(receipt.nodeId);
    expect(persist).not.toHaveBeenCalled();
    expect(getMediaTaskReceipt(receipt.nodeId)).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: receipt.taskId, mediaRecoveryState: 'query_paused' });
    expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('private-query-detail');

    await resumeMediaNodeTask(receipt.nodeId);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0][0]).toBe('https://cdn.example/original.mp4');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`https://api.minimax.cn/v2/query/video_generation/${receipt.taskId}`);
      expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer rotated-original-key' } });
    }
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('other-key');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: 'asset://minimax-video.mp4' });
  });

  it.each(['failed', 'cancelled'])('treats confirmed MiniMax task %s as terminal even with a nonzero business code', async (status) => {
    const receipt = saveMinimaxRecoveryTask();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      base_resp: { status_code: 1004, status_msg: 'business rejection' },
      task: { status, error: { message: 'original task failed' } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData');

    await expect(resumeMediaNodeTask(receipt.nodeId)).rejects.toThrow('模型任务失败：original task failed');
    expect(persist).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'error', error: '模型任务失败：original task failed' });
  });

  it('does not apply the MiniMax business validator to a customized saved query contract', async () => {
    const receipt = saveMinimaxRecoveryTask({ resultUrlPath: 'custom.download' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      base_resp: { status_code: 1004, status_msg: 'custom diagnostic' },
      task: { status: 'succeeded' }, custom: { download: 'https://cdn.example/custom.mp4' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData')
      .mockResolvedValue({ mediaUrl: 'asset://custom-video.mp4', sourceUrl: 'https://cdn.example/custom.mp4' });

    await resumeMediaNodeTask(receipt.nodeId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0][0]).toBe('https://cdn.example/custom.mp4');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
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
      const { resolveMediaDownloadRequest } = await import('../../../src/services/ai/mediaDownloadAccess');
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

  it.each([false, true])('resumes only missing fixed candidates from the original receipt after partial save (reattach=%s)', async (reattach) => {
    const { imageBatchArtifactId } = await import('../../../src/services/imageBatchService');
    const resultUrls = [1, 2, 3, 4].map((index) => `https://relayonapi.com/results/mj-${index}.png`);
    const mediaDownloadAccess = { providerConfigId: 'mj-origin', origin: 'https://relayonapi.com', auth: { type: 'bearer' as const } };
    useAppStore.setState((state) => ({ nodes: [{ id: 'mj-source', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'MJ 候选', status: 'loading', model: 'mj', provider: 'general' } }],
    config: { ...state.config, providers: { 'mj-origin': { name: 'MJ original', apiKey: 'fixture-key', baseUrl: 'https://relayonapi.com/v1' } } } }));
    const receipt = savePendingTask({ nodeId: 'mj-source', projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'mj-origin', taskType: 'custom-protocol', taskId: 'mj-original', submitted: true,
      batchCount: 4, expectedImageOutputs: 4, resultUrls, mediaDownloadAccess, mediaRecoveryState: 'delivery_pending' });
    const history: indexedDbService.HistoryRecord[] = [];
    const readHistory = vi.spyOn(indexedDbService, 'getNodeHistoryEntries')
      .mockImplementation(async (_projectId, nodeId) => history.filter((entry) => entry.nodeId === nodeId));
    const record = vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockImplementation(async (nodeId, entry) => {
      history.push({ ...entry, nodeId, id: `history-${history.length}`, projectId: 'project-1' });
    });
    let fail = true;
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockImplementation(async (url) => {
      if (fail && url === resultUrls[1]) throw new fileService.MediaPersistenceError('目标磁盘空间不足');
      return { mediaUrl: `asset://saved/${url.split('/').pop()}`, sourceUrl: url, filePath: `saved/${url.split('/').pop()}` };
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await resumeMediaNodeTask('mj-source');
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ ...receipt, expectedImageOutputs: 4,
        resultUrls, mediaRecoveryState: 'delivery_pending' });
      expect(JSON.parse(localStorage.getItem('ai_canvas_pending_tasks')!)[0].expectedImageOutputs).toBe(4);
      expect(useAppStore.getState().nodes).toHaveLength(4);
      expect(history).toHaveLength(3);
      let recoveryNodeId = 'mj-source';
      if (reattach) {
        prepareMediaNodeGeneration('mj-source');
        const firstRecoveryId = getPendingTasksForProject('project-1')[0].nodeId;
        expect(getPendingTasksForProject('project-1')[0].imageOutputNodeIds).toEqual(['mj-source']);
        // 再次移转同一原任务也必须保留所有已明确绑定的旧节点身份。
        prepareMediaNodeGeneration(firstRecoveryId);
        const moved = getPendingTasksForProject('project-1')[0];
        recoveryNodeId = moved.nodeId;
        expect(moved.imageOutputNodeIds).toEqual(['mj-source', firstRecoveryId]);
        expect(imageBatchArtifactId(moved, 0)).toBe(imageBatchArtifactId(receipt, 0));
        useAppStore.getState().updateNodeDataTransient('mj-source', { status: 'success', imageUrl: 'asset://new-job' });
      }
      const retainedIds = useAppStore.getState().nodes.filter((node) => [2, 3].some((index) =>
        node.data.artifactId === imageBatchArtifactId(receipt, index))).map((node) => node.id);
      fail = false;
      persist.mockClear();
      await resumeMediaNodeTask(recoveryNodeId);
      expect(persist).toHaveBeenCalledOnce();
      expect(persist.mock.calls[0][0]).toBe(resultUrls[1]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('project-1')).toEqual([]);
      const nodes = useAppStore.getState().nodes;
      expect(nodes).toHaveLength(reattach ? 6 : 4);
      expect(retainedIds.every((id) => nodes.some((node) => node.id === id && node.data.status === 'success'))).toBe(true);
      expect(nodes.filter((node) => [0, 1, 2, 3].some((index) => node.data.artifactId === imageBatchArtifactId(receipt, index)))).toHaveLength(4);
      expect(new Set(history.map((entry) => `${entry.nodeId}:${entry.params?.imageOutputId}`)).size).toBe(history.length);
      if (reattach) expect(nodes.find((node) => node.id === 'mj-source')?.data.imageUrl).toBe('asset://new-job');
    } finally { persist.mockRestore(); record.mockRestore(); readHistory.mockRestore(); }
  });

  it('keeps a fixed four-candidate receipt when a completed task has only delivered three URLs', async () => {
    useAppStore.setState((state) => ({ nodes: [{ id: 'short-mj', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'MJ short', status: 'loading' } }], config: { ...state.config,
      providers: { 'mj-origin': { name: 'MJ original', apiKey: 'fixture-key', baseUrl: 'https://relayonapi.com/v1' } } } }));
    savePendingTask({ nodeId: 'short-mj', projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'mj-origin', taskType: 'custom-protocol', taskId: 'mj-short', submitted: true,
      batchCount: 4, expectedImageOutputs: 4, resultUrls: [1, 2, 3].map((index) => `https://relayonapi.com/${index}.png`),
      mediaDownloadAccess: { providerConfigId: 'mj-origin', origin: 'https://relayonapi.com', auth: { type: 'bearer' } },
      mediaRecoveryState: 'delivery_pending' });
    const readHistory = vi.spyOn(indexedDbService, 'getNodeHistoryEntries').mockResolvedValue([]);
    const record = vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockResolvedValue(undefined);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockImplementation(async (url) => ({ mediaUrl: url, sourceUrl: url }));
    try {
      await resumeMediaNodeTask('short-mj');
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: 'mj-short', expectedImageOutputs: 4,
        mediaRecoveryState: 'delivery_pending' });
      expect(useAppStore.getState().nodes).toHaveLength(4);
      expect(useAppStore.getState().nodes.filter((node) => node.data.imageUrl)).toHaveLength(3);
      expect(record).toHaveBeenCalledTimes(3);
    } finally { persist.mockRestore(); record.mockRestore(); readHistory.mockRestore(); }
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
      signal: expect.any(AbortSignal),
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
}
