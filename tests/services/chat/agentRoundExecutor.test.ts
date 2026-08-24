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
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
} from '../../../src/services/chat/toolRegistry';
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
  clearAgentToolRegistryForTests();
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

  it('persists the same structured displays for model-proposed tools', async () => {
    registerAgentTool<{ nodeId: string }>({
      id: 'round_display_test',
      title: 'Round display',
      description: 'Round display',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['nodeId'],
        additionalProperties: false,
        properties: { nodeId: { type: 'string', minLength: 1 } },
      },
      buildInputDisplay: (input) => ({
        fields: [{ label: '节点', value: input.nodeId }],
      }),
      execute: async () => ({
        status: 'success',
        summary: 'done',
        modelContent: 'done',
        display: { fields: [{ label: '状态', value: '完成' }] },
      }),
    });
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      onEvent({
        type: 'tool.call.final',
        call: {
          callId: 'call-round-display',
          toolId: 'round_display_test',
          input: { nodeId: 'node-1' },
        },
      });
    });

    const result = await executeAgentRound({
      taskId: 'task-round',
      signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'update canvas' }],
      fullText: '',
      totalToolResultChars: 0,
      callbacks: {},
      transitionTask: transitionAgentTask,
      waitForApproval: vi.fn(),
    });

    expect(result.outcome).toBe('continue');
    expect(useAppStore.getState().agentTasks[0].steps[0].toolCall).toMatchObject({
      inputDisplay: { fields: [{ label: '节点', value: 'node-1' }] },
      resultDisplay: { fields: [{ label: '状态', value: '完成' }] },
    });
  });

  it('advances the write baseline so later writes in one round are not self-invalidated', async () => {
    const seen: Array<{ base?: number; current: number }> = [];
    registerAgentTool<{ index: number }>({
      id: 'round_write_test',
      title: 'Round write',
      description: 'Round write',
      effect: 'canvas_write',
      inputSchema: {
        type: 'object',
        required: ['index'],
        additionalProperties: false,
        properties: { index: { type: 'integer' } },
      },
      execute: async (context) => {
        seen.push({
          base: context.baseRevision,
          current: useAppStore.getState().getCurrentRevision(),
        });
        useAppStore.getState().incrementRevision();
        return { status: 'success', summary: 'done', modelContent: 'done' };
      },
    });
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      onEvent({
        type: 'tool.call.final',
        call: { callId: 'call-write-1', toolId: 'round_write_test', input: { index: 1 } },
      });
      onEvent({
        type: 'tool.call.final',
        call: { callId: 'call-write-2', toolId: 'round_write_test', input: { index: 2 } },
      });
    });

    await executeAgentRound({
      taskId: 'task-round',
      signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'update canvas' }],
      fullText: '',
      totalToolResultChars: 0,
      callbacks: {},
      transitionTask: transitionAgentTask,
      waitForApproval: vi.fn(async () => ({ decision: 'approved' as const })),
    });

    expect(seen).toHaveLength(2);
    for (const entry of seen) expect(entry.base).toBe(entry.current);
    expect(seen[1].current).toBe(seen[0].current + 1);
  });
});
