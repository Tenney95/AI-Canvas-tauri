import { beforeEach, describe, expect, it } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import {
  getPendingTasksForProject,
  resumePendingTasks,
  savePendingTask,
} from '../../src/services/pollManager';
import { useAppStore } from '../../src/store/useAppStore';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1' });
});

describe('pending generation task recovery', () => {
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
});
