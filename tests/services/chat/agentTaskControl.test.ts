import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTask, AgentTaskStatus } from '../../../src/types/agent';
import {
  runAgentTask,
  stopConversationAgentTasks,
  stopProjectAgentTasks,
} from '../../../src/services/chat/agentTaskControl';
import {
  getConversationAgentQueueTaskIds,
  resetAgentSchedulerForTests,
  scheduleConversationAgentExecution,
} from '../../../src/services/chat/agentScheduler';
import { useAppStore } from '../../../src/store/useAppStore';

function createTask(
  id: string,
  projectId: string,
  conversationId: string,
  status: AgentTaskStatus = 'queued',
): AgentTask {
  return {
    id,
    projectId,
    conversationId,
    userMessageId: `message-${id}`,
    mode: 'autonomous',
    goal: `goal-${id}`,
    status,
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 12,
      maxToolCalls: 24,
      maxParallelReadTools: 3,
      maxReadRetries: 3,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  resetAgentSchedulerForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
  resetAgentSchedulerForTests();
});

describe('agent task control', () => {
  it('synchronously aborts active work and clears queued work for a deleted conversation', async () => {
    const conversationId = 'conversation-target';
    useAppStore.setState({
      agentTasks: [
        createTask('task-active', 'project-1', conversationId),
        createTask('task-queued', 'project-1', conversationId),
      ],
    });

    let activeSignal: AbortSignal | undefined;
    const running = runAgentTask('task-active', async (signal) => {
      activeSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return 'paused';
    });

    let releaseScheduledExecution: (() => void) | undefined;
    scheduleConversationAgentExecution({
      taskId: 'task-active',
      conversationId,
      run: () => new Promise<void>((resolve) => {
        releaseScheduledExecution = resolve;
      }),
    });
    scheduleConversationAgentExecution({
      taskId: 'task-queued',
      conversationId,
      run: async () => undefined,
    });

    expect(getConversationAgentQueueTaskIds(conversationId)).toEqual(['task-queued']);

    stopConversationAgentTasks(conversationId);

    expect(activeSignal?.aborted).toBe(true);
    expect(getConversationAgentQueueTaskIds(conversationId)).toEqual([]);
    expect(useAppStore.getState().agentTasks.map((task) => [task.id, task.status])).toEqual([
      ['task-active', 'stopped'],
      ['task-queued', 'stopped'],
    ]);

    releaseScheduledExecution?.();
    await running;
  });

  it('stops only non-terminal tasks in the deleted project', () => {
    useAppStore.setState({
      agentTasks: [
        createTask('target-running', 'project-target', 'conversation-a', 'running'),
        createTask('target-completed', 'project-target', 'conversation-b', 'completed'),
        createTask('other-queued', 'project-other', 'conversation-c'),
      ],
    });

    stopProjectAgentTasks('project-target');

    expect(useAppStore.getState().agentTasks.map((task) => [task.id, task.status])).toEqual([
      ['target-running', 'stopped'],
      ['target-completed', 'completed'],
      ['other-queued', 'queued'],
    ]);
  });
});
