import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import {
  getPendingTaskCoveredNodeIds,
  getPendingTasksForProject,
  resumePendingTasks,
  savePendingTask,
} from '../../src/services/pollManager';
import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1' });
});

describe('pending generation task recovery', () => {
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
