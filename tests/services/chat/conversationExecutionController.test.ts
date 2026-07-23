import { beforeEach, describe, expect, it, vi } from 'vitest';

const schedulerMocks = vi.hoisted(() => ({
  activeTaskId: undefined as string | undefined,
  schedule: vi.fn(() => ({ state: 'running' as const })),
}));

const interjectionMocks = vi.hoisted(() => ({
  enqueue: vi.fn(() => true),
}));

vi.mock('../../../src/services/chat/agentScheduler', () => ({
  getActiveConversationAgentTaskId: () => schedulerMocks.activeTaskId,
  scheduleConversationAgentExecution: schedulerMocks.schedule,
}));

vi.mock('../../../src/services/chat/agentInterjection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/chat/agentInterjection')>(),
  enqueueAgentInterjection: interjectionMocks.enqueue,
}));

vi.mock('../../../src/services/chat/tools', () => ({
  ensureAgentToolsRegistered: vi.fn(),
}));

import { submitConversationMessage } from '../../../src/services/chat/conversationExecutionController';
import { useAppStore } from '../../../src/store/useAppStore';

function arrangeConversation(): void {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Controller test',
      titleSource: 'auto',
      pinned: false,
      archived: false,
      agentMode: 'collaborative',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
    messages: [],
    agentTasks: [],
  });
}

beforeEach(() => {
  arrangeConversation();
  schedulerMocks.activeTaskId = undefined;
  schedulerMocks.schedule.mockReset();
  schedulerMocks.schedule.mockReturnValue({ state: 'running' });
  interjectionMocks.enqueue.mockReset();
  interjectionMocks.enqueue.mockReturnValue(true);
});

describe('conversation execution controller', () => {
  it('creates the message pair and schedules one Agent task', () => {
    const result = submitConversationMessage({
      content: '  update the canvas  ',
      conversationId: 'conversation-1',
    });

    expect(result.status).toBe('started');
    const state = useAppStore.getState();
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))).toEqual([
      { role: 'user', content: 'update the canvas' },
      { role: 'assistant', content: '' },
    ]);
    expect(state.agentTasks).toHaveLength(1);
    expect(state.messages[1].agentTaskId).toBe(state.agentTasks[0].id);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(expect.objectContaining({
      taskId: state.agentTasks[0].id,
      conversationId: 'conversation-1',
    }));
  });

  it('records an interjection without creating another assistant task', () => {
    schedulerMocks.activeTaskId = 'task-active';

    const result = submitConversationMessage({
      content: 'also use the selected nodes',
      conversationId: 'conversation-1',
      dispatchMode: 'interject',
    });

    expect(result).toEqual({ status: 'interjected', taskId: 'task-active' });
    expect(useAppStore.getState().messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'also use the selected nodes',
        agentTaskId: 'task-active',
      }),
    ]);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});
