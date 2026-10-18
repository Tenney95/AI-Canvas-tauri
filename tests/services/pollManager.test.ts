import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import {
  getPendingTaskCoveredNodeIds,
  getPendingTasksForProject,
  resumePendingTasks,
  savePendingTask,
  pauseVideoNodeTaskOnTimeout,
  prepareVideoNodeGeneration,
  resumeVideoNodeTask,
  type PendingTask,
} from '../../src/services/pollManager';
import { PollTimeoutError, PollTaskFailedError } from '../../src/services/pollTask';
import { useAppStore } from '../../src/store/useAppStore';
import * as fileService from '../../src/services/fileService';

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1' });
});

describe('pending generation task recovery', () => {
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
    savePendingTask({ nodeId: 'source-node', projectId: 'project-1', nodeType: type, provider: 'general',
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
    expect(persist).toHaveBeenCalledWith(url, 'project-1', generationType, '原始素材');
    expect(history).toHaveBeenCalledWith('source-node', expect.objectContaining({ nodeType: generationType, mediaUrl: localUrl }));
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
    await resumeVideoNodeTask(task.nodeId);
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', url: 'old-video.mp4' }))));
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
    finish(new Response(JSON.stringify({ status: 'completed', url: 'old-video.mp4' })));
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
    expect(persistMedia).toHaveBeenCalledWith('data:video/mp4;base64,AQID', 'project-1', 'ai-video', 'Video');
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
      .toEqual(['batch-source']);
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
      error: '任务未完成提交，请重新点击生成',
    });
  });

  it('marks every loading node in a failed recovered batch as an error', async () => {
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
        .toEqual(['error', 'error']);
    });
    expect(useAppStore.getState().nodes[1].data.error).toBe('任务恢复失败：缺少 API 配置');
  });

  it('removes stale pending records for nodes that already finished', async () => {
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

    expect(getPendingTasksForProject('project-1')).toEqual([]);
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
