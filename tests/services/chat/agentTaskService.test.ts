import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

function createInterruptedTask(): AgentTask {
  const now = Date.now() - 1000;
  return {
    id: 'task-interrupted',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'collaborative',
    goal: 'update canvas',
    status: 'waiting_approval',
    steps: [{
      id: 'step-1',
      taskId: 'task-interrupted',
      index: 0,
      kind: 'approval',
      title: 'Update canvas',
      status: 'waiting_approval',
      createdAt: now,
      updatedAt: now,
      approval: {
        id: 'approval-1',
        kind: 'canvas_write',
        status: 'pending',
        summary: 'Canvas write requires approval',
        requestedAt: now,
      },
    }],
    modelRounds: 1,
    toolCallCount: 1,
    budget: {
      maxModelRounds: 12,
      maxToolCalls: 24,
      maxParallelReadTools: 3,
      maxReadRetries: 3,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('repairInterruptedAgentTasks', () => {
  it('pauses interrupted tasks and expires pending approvals after restart', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    await service.saveAgentTask(createInterruptedTask());

    const repairedIds = await service.repairInterruptedAgentTasks('project-1');
    const repaired = await service.loadAgentTask('task-interrupted');

    expect(repairedIds).toEqual(['task-interrupted']);
    expect(repaired).toMatchObject({
      status: 'paused',
      pausedReason: 'app_restarted',
      steps: [{
        status: 'pending',
        approval: {
          status: 'expired',
          resolvedAt: expect.any(Number),
        },
      }],
    });
  });

  it('leaves terminal tasks unchanged', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const completed = { ...createInterruptedTask(), id: 'task-completed', status: 'completed' as const };
    await service.saveAgentTask(completed);

    expect(await service.repairInterruptedAgentTasks('project-1')).toEqual([]);
    expect(await service.loadAgentTask('task-completed')).toMatchObject({
      status: 'completed',
      steps: [{ status: 'waiting_approval', approval: { status: 'pending' } }],
    });
  });
});
