import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

const streamAssistantReplyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: streamAssistantReplyMock,
}));

vi.mock('../../../src/services/chat/contextManager', () => ({
  ContextBudgetError: class ContextBudgetError extends Error {
    readonly code = 'CONTEXT_BUDGET_EXCEEDED';
  },
  assembleAgentContext: vi.fn(async () => ({
    messages: [{ role: 'user', content: 'write a file' }],
    usage: {},
  })),
  estimateModelMessagesTokens: vi.fn(() => 1),
  resolveAssistantContextSpec: vi.fn(() => ({ inputBudget: 100_000 })),
}));

import {
  resolveAgentApproval,
  runAgentLoop,
} from '../../../src/services/chat/agentRuntime';
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
  type AgentToolDefinition,
} from '../../../src/services/chat/toolRegistry';
import { useAppStore } from '../../../src/store/useAppStore';

function createTask(): AgentTask {
  const now = Date.now();
  return {
    id: 'task-approval',
    projectId: 'project-approval',
    conversationId: 'conversation-approval',
    userMessageId: 'message-1',
    mode: 'autonomous',
    goal: 'write a file',
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
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-approval',
    activeConversationId: 'conversation-approval',
    conversations: [{
      id: 'conversation-approval',
      projectId: 'project-approval',
      title: 'Approval test',
      titleSource: 'auto',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      archived: false,
      messageCount: 0,
      agentMode: 'autonomous',
    }],
    agentTasks: [createTask()],
  });
  streamAssistantReplyMock.mockReset();
});

afterEach(() => {
  clearAgentToolRegistryForTests();
});

function arrangeToolCall(execute: AgentToolDefinition['execute']) {
  let round = 0;
  streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
    round += 1;
    if (round === 1) {
      onEvent({
        type: 'tool.call.final',
        call: {
          callId: 'call-write',
          toolId: 'file_write_test',
          input: { content: 'hello' },
        },
      });
    }
  });
  registerAgentTool({
    id: 'file_write_test',
    title: 'Write file',
    description: 'Write file',
    effect: 'file_write',
    inputSchema: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: { content: { type: 'string', minLength: 1 } },
    },
    execute,
  });
}

describe('Agent approval lifecycle', () => {
  it('executes a protected tool only after approval', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'saved',
      modelContent: 'saved',
    }));
    arrangeToolCall(execute);

    const outcome = await runAgentLoop({
      taskId: 'task-approval',
      systemPrompt: 'system',
      userMessage: 'write a file',
      signal: new AbortController().signal,
      callbacks: {
        onApprovalRequired: (step) => {
          queueMicrotask(() => {
            resolveAgentApproval(step.approval!.id, { approved: true });
          });
        },
      },
    });

    expect(outcome).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentTasks[0].steps[0]).toMatchObject({
      status: 'succeeded',
      approval: { status: 'approved' },
    });
  });

  it('does not execute a protected tool after rejection', async () => {
    const execute = vi.fn();
    arrangeToolCall(execute);

    const outcome = await runAgentLoop({
      taskId: 'task-approval',
      systemPrompt: 'system',
      userMessage: 'write a file',
      signal: new AbortController().signal,
      callbacks: {
        onApprovalRequired: (step) => {
          queueMicrotask(() => {
            resolveAgentApproval(step.approval!.id, { approved: false });
          });
        },
      },
    });

    expect(outcome).toBe('completed');
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].steps[0]).toMatchObject({
      status: 'skipped',
      approval: { status: 'rejected' },
    });
  });

  it('does not execute when the approval wait is aborted', async () => {
    const execute = vi.fn();
    arrangeToolCall(execute);
    const controller = new AbortController();

    const result = runAgentLoop({
      taskId: 'task-approval',
      systemPrompt: 'system',
      userMessage: 'write a file',
      signal: controller.signal,
      callbacks: {
        onApprovalRequired: () => queueMicrotask(() => controller.abort()),
      },
    });

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
  });
});
