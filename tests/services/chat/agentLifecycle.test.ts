import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentLifecycleListenersForTests,
  emitAgentLifecycleEvent,
  subscribeAgentLifecycle,
} from '../../../src/services/chat/agentLifecycle';

afterEach(() => {
  clearAgentLifecycleListenersForTests();
  vi.restoreAllMocks();
});

describe('agentLifecycle', () => {
  it('emits typed immutable events and supports unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentLifecycle(listener);
    const event = emitAgentLifecycleEvent({
      type: 'task.status',
      taskId: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      status: 'running',
    });

    expect(listener).toHaveBeenCalledWith(event);
    expect(event.id).toMatch(/^agent-lifecycle-/);
    expect(event.timestamp).toBeGreaterThan(0);
    expect(Object.isFrozen(event)).toBe(true);

    unsubscribe();
    emitAgentLifecycleEvent({
      type: 'task.status',
      taskId: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      status: 'completed',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates synchronous and asynchronous listener failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const healthy = vi.fn();
    subscribeAgentLifecycle(() => {
      throw new Error('sync listener failed');
    });
    subscribeAgentLifecycle(async () => {
      throw new Error('async listener failed');
    });
    subscribeAgentLifecycle(healthy);

    expect(() => emitAgentLifecycleEvent({
      type: 'model.round',
      taskId: 'task-1',
      phase: 'start',
      round: 1,
    })).not.toThrow();
    await Promise.resolve();

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
