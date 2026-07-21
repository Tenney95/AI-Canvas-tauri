import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelScheduledAgentExecution,
  getActiveConversationAgentTaskId,
  getConversationAgentQueueTaskIds,
  resetAgentSchedulerForTests,
  scheduleConversationAgentExecution,
} from '../../../src/services/chat/agentScheduler';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => resetAgentSchedulerForTests());

describe('conversation agent scheduler', () => {
  it('serializes tasks in the same conversation', async () => {
    const first = deferred();
    const order: string[] = [];
    scheduleConversationAgentExecution({
      taskId: 'task-1',
      conversationId: 'conversation-1',
      onStart: () => order.push('start-1'),
      run: () => first.promise.then(() => { order.push('end-1'); }),
    });
    const result = scheduleConversationAgentExecution({
      taskId: 'task-2',
      conversationId: 'conversation-1',
      onStart: () => order.push('start-2'),
      run: async () => { order.push('end-2'); },
    });

    expect(result).toEqual({ state: 'queued', position: 1 });
    expect(order).toEqual(['start-1']);
    expect(getConversationAgentQueueTaskIds('conversation-1')).toEqual(['task-2']);

    first.resolve();
    await vi.waitFor(() => expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']));
  });

  it('allows different conversations to run concurrently', () => {
    const first = deferred();
    const second = deferred();
    scheduleConversationAgentExecution({
      taskId: 'task-1', conversationId: 'conversation-1', run: () => first.promise,
    });
    scheduleConversationAgentExecution({
      taskId: 'task-2', conversationId: 'conversation-2', run: () => second.promise,
    });

    expect(getActiveConversationAgentTaskId('conversation-1')).toBe('task-1');
    expect(getActiveConversationAgentTaskId('conversation-2')).toBe('task-2');
    first.resolve();
    second.resolve();
  });

  it('removes a queued task without disturbing the active task', () => {
    const first = deferred();
    scheduleConversationAgentExecution({
      taskId: 'task-1', conversationId: 'conversation-1', run: () => first.promise,
    });
    scheduleConversationAgentExecution({
      taskId: 'task-2', conversationId: 'conversation-1', run: vi.fn(),
    });

    expect(cancelScheduledAgentExecution('task-2')).toBe(true);
    expect(getConversationAgentQueueTaskIds('conversation-1')).toEqual([]);
    expect(getActiveConversationAgentTaskId('conversation-1')).toBe('task-1');
    first.resolve();
  });
});

