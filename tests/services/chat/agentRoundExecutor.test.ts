import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

const streamAssistantReplyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: streamAssistantReplyMock,
}));

vi.mock('../../../src/services/chat/contextManager', () => ({
  ContextBudgetError: class ContextBudgetError extends Error {
    readonly code = 'CONTEXT_ERROR';
  },
  assembleAgentContext: vi.fn(async () => ({
    messages: [{ role: 'user', content: 'update canvas' }],
    usage: {},
  })),
  estimateModelMessagesTokens: vi.fn(() => 1),
  resolveAssistantContextSpec: vi.fn(() => ({ inputBudget: 100_000 })),
}));

import { executeAgentRound } from '../../../src/services/chat/agentRoundExecutor';
import { transitionAgentTask } from '../../../src/services/chat/agentRuntime';
import { useAppStore } from '../../../src/store/useAppStore';

function createTask(): AgentTask {
  return {
    id: 'task-round',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'autonomous',
    goal: 'update canvas',
    status: 'queued',
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 4,
      maxToolCalls: 4,
      maxParallelReadTools: 1,
      maxReadRetries: 3,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Round test',
      titleSource: 'auto',
      pinned: false,
      archived: false,
      agentMode: 'autonomous',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
    agentTasks: [createTask()],
  });
  streamAssistantReplyMock.mockReset();
});

describe('agent round executor', () => {
  it('runs one model round and returns a terminal response without owning the loop', async () => {
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'text.delta', delta: 'round complete' });
      onEvent({ type: 'usage', inputTokens: 7, outputTokens: 3 });
    });
    const onComplete = vi.fn();

    const result = await executeAgentRound({
      taskId: 'task-round',
      signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'update canvas' }],
      fullText: '',
      totalToolResultChars: 0,
      callbacks: { onComplete },
      transitionTask: transitionAgentTask,
      waitForApproval: vi.fn(),
    });

    expect(result).toEqual({
      outcome: 'completed',
      fullText: 'round complete',
      totalToolResultChars: 0,
    });
    expect(onComplete).toHaveBeenCalledWith('round complete');
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({
      status: 'planning',
      modelRounds: 1,
      metrics: { inputTokens: 7, outputTokens: 3 },
    });
  });
});
