import { expect, it, vi } from 'vitest';
import {
  getPendingTasksForProject,
  createOrReusePollManagerRuntime,
  resumePendingTasks,
  savePendingTask,
  discardMediaTask,
  getMediaTaskReceipt,
  pauseMediaTask,
  isMediaTaskPausedError,
  MediaTaskPausedError,
  prepareMediaNodeGeneration,
  registerMediaNodeOperation,
  resumeMediaNodeTask,
} from '../../../src/services/pollManager';
import { useAppStore } from '../../../src/store/useAppStore';
import { HttpResponseError } from '../../../src/services/ai/httpUtils';
import { executeGeneralAsyncTask } from '../../../src/services/ai/apimartGen';
import { generateDreaminaVideo } from '../../../src/services/dreaminaService';
import * as fileService from '../../../src/services/fileService';
import * as tauriCore from '@tauri-apps/api/core';

export function registerRuntimeIdentityTests() {
  it('ComfyUI 提交未知跨重启保留防重，只有明确确认才能解除', async () => {
    useAppStore.setState({ nodes: [{ id: 'uncertain', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '图片', status: 'idle' } }] });
    const receipt = savePendingTask({ nodeId: 'uncertain', projectId: 'project-1', nodeType: 'ai-image',
      provider: 'comfyui', taskId: '', taskType: 'comfyui', submitted: false,
      baseUrl: 'http://127.0.0.1:8188', mediaSubmissionUncertain: true });
    expect(pauseMediaTask(receipt, undefined, 'submit_unknown')).toBeInstanceOf(MediaTaskPausedError);
    await resumePendingTasks('project-1');
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ ...receipt, mediaRecoveryState: 'submit_unknown' });
    expect(useAppStore.getState().nodes[0].data.mediaTaskState).toBe('submit_unknown');
    expect(() => prepareMediaNodeGeneration('uncertain')).toThrow('提交状态未知');
    discardMediaTask({ ...receipt, attemptId: 'stale-attempt' });
    expect(getPendingTasksForProject('project-1')).toHaveLength(1);
    discardMediaTask(receipt);
    expect(getPendingTasksForProject('project-1')).toHaveLength(0);
  });

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

  it.each(['timeout', 'network', 'disk_space', 'permission', 'missing_key', 'connection_changed'] as const)(
    'retains only the safe %s delivery failure category', (failureKind) => {
      const messages = {
        timeout: '媒体下载读取超时 private-url', network: '媒体下载连接失败 private-url',
        disk_space: '目标磁盘空间不足 private-path', permission: 'permission denied private-path',
        missing_key: '原媒体连接尚未填写 API Key，请补填后继续保存',
        connection_changed: '原媒体连接或接口地址已变化，请检查原连接配置',
      };
      const receipt = savePendingTask({ nodeId: 'save-failed', projectId: 'project-1', nodeType: 'ai-image',
        provider: 'general', taskId: 'original-task', taskType: 'custom-protocol', submitted: true });
      pauseMediaTask(receipt, new fileService.MediaPersistenceError(messages[failureKind]), 'delivery_pending');
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId: 'original-task',
        mediaRecoveryState: 'delivery_pending', mediaFailureDiagnostic: { kind: 'persistence', failureKind } });
      expect(localStorage.getItem('ai_canvas_pending_tasks')).not.toContain('private');
    },
  );

  it('uses a newly queried URL instead of a cached expired URL and keeps download cancellation', async () => {
    const mediaDownloadAccess = { providerConfigId: 'refresh-origin', origin: 'https://gateway.example', auth: { type: 'bearer' as const } };
    useAppStore.setState((state) => ({ nodes: [{ id: 'refresh-url', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: '原任务', status: 'idle' } }], config: { ...state.config, providers: {
      'refresh-origin': { name: 'Original', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' },
    } } }));
    savePendingTask({ nodeId: 'refresh-url', projectId: 'project-1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', providerConfigId: 'refresh-origin', taskId: 'original-task', submitted: true,
      resultUrls: ['https://cdn.example/expired.png'], mediaDownloadAccess, mediaRecoveryState: 'delivery_pending',
      protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/original-task', statusPath: 'status',
        successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url', intervalMs: 1 } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/fresh.png' })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData').mockResolvedValue({ mediaUrl: 'asset://saved', sourceUrl: 'asset://saved' });
    await resumeMediaNodeTask('refresh-url');
    expect(persist).toHaveBeenCalledWith('https://cdn.example/fresh.png', 'project-1', 'ai-image', '原任务',
      expect.objectContaining({ mediaDownloadAccess, signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('retains an APIMart task with a visible download failure and can save it on the next query', async () => {
    useAppStore.setState((state) => ({ nodes: [{ id: 'apimart-retry', type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: 'APIMart 图片', status: 'idle' } }], config: { ...state.config, providers: {
      apimart: { name: 'APIMart', apiKey: 'fixture-key', baseUrl: 'https://api.apimart.ai/v1' },
    } } }));
    const receipt = savePendingTask({ nodeId: 'apimart-retry', projectId: 'project-1', nodeType: 'ai-image', provider: 'apimart',
      providerConfigId: 'apimart', taskType: 'apimart', taskId: 'original-task', submitted: true });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: {
      status: 'completed', result: { images: [{ url: ['https://upload.apimart.ai/result.png'] }] },
    } })));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData')
      .mockRejectedValueOnce(new fileService.MediaPersistenceError('媒体下载响应等待超时'))
      .mockResolvedValueOnce({ mediaUrl: 'asset://saved', sourceUrl: 'asset://saved' });
    await resumeMediaNodeTask('apimart-retry');
    expect(getMediaTaskReceipt('apimart-retry')).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ mediaRecoveryState: 'delivery_pending',
      mediaFailureDiagnostic: { kind: 'persistence', failureKind: 'timeout' } });
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'idle', mediaTaskState: 'delivery_pending' });
    await resumeMediaNodeTask('apimart-retry');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][4]).toMatchObject({ signal: expect.any(AbortSignal), mediaDownloadAccess: {
      providerConfigId: 'apimart', origin: 'https://api.apimart.ai', auth: { type: 'bearer' },
    } });
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://api.apimart.ai/v1/tasks/original-task?language=zh')).toBe(true);
    expect(getPendingTasksForProject('project-1')).toEqual([]);
    expect(useAppStore.getState().nodes[0].data.status).toBe('success');
  });

  it.each(['apimart', 'general'] as const)('recovers a %s video using only the original task ID and fresh signed URLs', async (provider) => {
    const nodeId = 'video-retry';
    const taskId = 'original-video-to-recover';
    const providerConfigId = provider === 'apimart' ? 'apimart' : 'original';
    const baseUrl = 'https://gateway.example/v1';
    const firstUrl = 'https://cdn.example/video.mp4?signature=a,b&nonce=first';
    const retryUrl = 'https://cdn.example/video.mp4?signature=c,d&nonce=retry';
    useAppStore.setState((state) => ({ nodes: [{ id: nodeId, type: 'ai-video', position: { x: 0, y: 0 },
      data: { type: 'ai-video', label: '原视频', status: 'idle' } }], config: { ...state.config, providers: {
      ...state.config.providers, [providerConfigId]: { name: '原连接', apiKey: 'fixture-key', baseUrl },
    } } }));
    const receipt = savePendingTask({ nodeId, projectId: 'project-1', nodeType: 'ai-video', provider,
      providerConfigId, taskType: provider, taskId, submitted: true, mediaRecoveryState: 'query_paused' });
    const fetchMock = vi.fn();
    for (const url of [firstUrl, retryUrl]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        data: { status: 'completed', result: { videos: [{ url: [url] }] } },
      })));
    }
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData')
      .mockRejectedValueOnce(new fileService.MediaPersistenceError('媒体下载响应等待超时'))
      .mockResolvedValueOnce({ mediaUrl: 'asset://recovered-video', sourceUrl: retryUrl });
    vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockResolvedValue(undefined);

    await resumeMediaNodeTask(nodeId);
    expect(getMediaTaskReceipt(nodeId)).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId, mediaRecoveryState: 'delivery_pending' });
    await resumeMediaNodeTask(nodeId);

    expect(persist.mock.calls.map(([url, projectId, kind]) => [url, projectId, kind])).toEqual([
      [firstUrl, 'project-1', 'ai-video'],
      [retryUrl, 'project-1', 'ai-video'],
    ]);
    expect(fetchMock.mock.calls.map(([request, init]) => [String(request), init?.method ?? 'GET', init?.headers])).toEqual(
      Array.from({ length: 2 }, () => [`${baseUrl}/tasks/${taskId}?language=zh`, 'GET', { Authorization: 'Bearer fixture-key' }]),
    );
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: 'asset://recovered-video' });
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('keeps a live original-task query when a canceled generation targets the same node', async () => {
    const nodeId = 'video-resume-before-canceled-generation';
    const taskId = 'original-video-still-running';
    const baseUrl = 'https://gateway.example/v1';
    const url = 'https://cdn.example/original.mp4';
    useAppStore.setState((state) => ({
      nodes: [{ id: nodeId, type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: '原视频', status: 'idle' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        original: { name: '原连接', apiKey: 'fixture-key', baseUrl },
      } },
    }));
    const receipt = savePendingTask({ nodeId, projectId: 'project-1', nodeType: 'ai-video', provider: 'general',
      providerConfigId: 'original', taskType: 'general', taskId, submitted: true, mediaRecoveryState: 'query_paused' });
    let finishQuery: (response: Response) => void = () => {};
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      Promise.reject(new Error('检测到额外的请求')))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishQuery = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData')
      .mockResolvedValue({ mediaUrl: 'asset://original-video', sourceUrl: url });
    vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockResolvedValue(undefined);
    const originalCaller = new AbortController();
    const originalQuery = resumeMediaNodeTask(nodeId, originalCaller.signal);
    const originalSettlement = Promise.allSettled([originalQuery]);

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const querySignal = fetchMock.mock.calls[0][1]?.signal;
      expect(querySignal?.aborted).toBe(false);

      const caller = new AbortController();
      const reason = new DOMException('调用已经取消', 'AbortError');
      caller.abort(reason);
      await expect(executeGeneralAsyncTask(
        'fixture-key', baseUrl, 'new-model', '新一轮生成', 'videos', 'original', nodeId, caller.signal,
      )).rejects.toBe(reason);

      expect(querySignal?.aborted).toBe(false);
      expect(getMediaTaskReceipt(nodeId)).toEqual(receipt);
      expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method ?? 'GET']))
        .toEqual([[`${baseUrl}/tasks/${taskId}?language=zh`, 'GET']]);
    } finally {
      if (fetchMock.mock.calls.length === 0) originalCaller.abort();
      finishQuery(Response.json({ data: { status: 'completed', result: { videos: [{ url }] } } }));
      await originalSettlement;
    }

    await expect(originalQuery).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
    expect(getMediaTaskReceipt(nodeId)).toBeUndefined();
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: 'asset://original-video' });
  });

  it('keeps a newer Dreamina receipt when an older query is canceled for the same task ID', async () => {
    const nodeId = 'dreamina-stale-query';
    const taskId = 'dreamina-original-submit-id';
    const result = { status: 'success', failReason: '', outputs: [{ url: 'https://cdn.example/original.mp4', localPath: '' }] };
    let finishQuery: (response: typeof result) => void = () => {};
    const invoke = vi.mocked(tauriCore.invoke)
      .mockResolvedValueOnce({ submitId: taskId })
      .mockImplementationOnce(() => new Promise<typeof result>((resolve) => { finishQuery = resolve; }));
    const caller = new AbortController();
    const originalQuery = generateDreaminaVideo({
      nodeId, model: 'dreamina/seedance2.5', prompt: '生成视频', references: [],
    }, caller.signal);
    const originalSettlement = Promise.allSettled([originalQuery]);

    try {
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('dreamina_query_result', { submitId: taskId }));
      const original = getMediaTaskReceipt(nodeId);
      expect(original).toMatchObject({ taskId });
      const replacement = savePendingTask({ nodeId, projectId: 'project-1', nodeType: 'ai-video', provider: 'dreamina',
        taskType: 'dreamina', taskId, submitted: true, mediaRecoveryState: 'query_paused' });
      expect(replacement.attemptId).not.toBe(original?.attemptId);

      caller.abort();
      await expect(originalQuery).rejects.toMatchObject({ name: 'AbortError' });
      expect(getMediaTaskReceipt(nodeId)).toEqual(replacement);
      expect(invoke.mock.calls.map(([command]) => command)).toEqual(['dreamina_generate', 'dreamina_query_result']);
    } finally {
      caller.abort();
      finishQuery(result);
      await originalSettlement;
    }
  });

  it.each([
    ['apimart', 'audios'],
    ['apimart', 'images'],
    ['general', 'audios'],
  ] as const)('recovers a %s audio receipt with a %s result using only the original ID', async (provider, field) => {
    const nodeId = 'audio-retry';
    const taskId = 'original-audio-to-recover';
    const providerConfigId = provider === 'apimart' ? 'apimart' : 'original-audio';
    const baseUrl = 'https://audio-gateway.example/v1';
    const firstUrl = 'https://cdn.example/track.mp3?signature=a,b&nonce=first';
    const retryUrl = 'https://cdn.example/track.mp3?signature=c,d&nonce=retry';
    useAppStore.setState((state) => ({ nodes: [{ id: nodeId, type: 'ai-audio', position: { x: 0, y: 0 },
      data: { type: 'ai-audio', label: '原音频', status: 'idle' } }], config: { ...state.config, providers: {
      ...state.config.providers, [providerConfigId]: { name: '原连接', apiKey: 'fixture-key', baseUrl },
    } } }));
    const receipt = savePendingTask({ nodeId, projectId: 'project-1', nodeType: 'ai-audio', provider,
      providerConfigId, taskType: provider, taskId, submitted: true, mediaRecoveryState: 'query_paused' });
    const fetchMock = vi.fn();
    for (const url of [firstUrl, retryUrl]) {
      fetchMock.mockResolvedValueOnce(Response.json({
        data: { status: 'completed', result: { [field]: [{ url: [url, 'https://cdn.example/another.mp3'] }] } },
      }));
    }
    vi.stubGlobal('fetch', fetchMock);
    const persist = vi.spyOn(fileService, 'persistMediaUrlToProjectData')
      .mockRejectedValueOnce(new fileService.MediaPersistenceError('媒体下载响应等待超时'))
      .mockResolvedValueOnce({ mediaUrl: 'asset://recovered-audio.mp3', sourceUrl: retryUrl });
    vi.spyOn(useAppStore.getState(), 'recordOutputHistory').mockResolvedValue(undefined);

    await resumeMediaNodeTask(nodeId);
    expect(getMediaTaskReceipt(nodeId)).toEqual(receipt);
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject({ taskId, mediaRecoveryState: 'delivery_pending' });
    await resumeMediaNodeTask(nodeId);

    expect(persist.mock.calls.map(([url, projectId, kind]) => [url, projectId, kind])).toEqual([
      [firstUrl, 'project-1', 'ai-audio'],
      [retryUrl, 'project-1', 'ai-audio'],
    ]);
    expect(fetchMock.mock.calls.map(([request, init]) => [String(request), init?.method ?? 'GET', init?.headers])).toEqual(
      Array.from({ length: 2 }, () => [`${baseUrl}/tasks/${taskId}?language=zh`, 'GET', { Authorization: 'Bearer fixture-key' }]),
    );
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', audioUrl: 'asset://recovered-audio.mp3' });
    expect(getPendingTasksForProject('project-1')).toEqual([]);
  });

  it('does not restore saving ownership to an older operation after a newer one finishes', () => {
    const older = registerMediaNodeOperation('parallel-image', true);
    const newer = registerMediaNodeOperation('parallel-image', true);
    expect(older.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);
    newer();
    expect(older.isCurrent()).toBe(false);
    older();
    const next = registerMediaNodeOperation('parallel-image', true);
    expect(next.isCurrent()).toBe(true);
    next();
    expect(next.isCurrent()).toBe(false);
  });

  it('does not let nested protocol tracking supersede its generation owner', () => {
    const generation = registerMediaNodeOperation('nested-image', true);
    const protocol = registerMediaNodeOperation('nested-image');
    expect(generation.isCurrent()).toBe(true);
    protocol();
    expect(generation.isCurrent()).toBe(true);
    const newerGeneration = registerMediaNodeOperation('nested-image', true);
    expect(generation.isCurrent()).toBe(false);
    newerGeneration();
    expect(generation.isCurrent()).toBe(false);
    generation();
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
}
