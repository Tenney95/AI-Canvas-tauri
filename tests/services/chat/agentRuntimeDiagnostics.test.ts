import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

const streamAssistantReplyMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: streamAssistantReplyMock,
}));

vi.mock('../../../src/services/chat/contextManager', () => ({
  ContextBudgetError: class ContextBudgetError extends Error { readonly code = 'CONTEXT_ERROR'; },
  assembleAgentContext: vi.fn(async () => ({
    messages: [{ role: 'user', content: 'update canvas' }],
    usage: {},
  })),
  estimateModelMessagesTokens: vi.fn(() => 1),
  resolveAssistantContextSpec: vi.fn(() => ({ inputBudget: 100_000 })),
}));

import { runAgentLoop } from '../../../src/services/chat/agentRuntime';
import { fingerprintToolInput } from '../../../src/services/chat/agentCheckpointService';
import {
  clearAgentLifecycleListenersForTests,
  subscribeAgentLifecycle,
} from '../../../src/services/chat/agentLifecycle';
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
} from '../../../src/services/chat/toolRegistry';
import { useAppStore } from '../../../src/store/useAppStore';

const input = { nodeIds: ['node-1'], label: 'updated' };

function createTask(existing = false): AgentTask {
  const now = Date.now();
  return {
    id: 'task-diagnostics',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'autonomous',
    goal: 'update canvas',
    status: 'queued',
    steps: existing ? [{
      id: 'existing-step',
      taskId: 'task-diagnostics',
      index: 0,
      kind: 'tool',
      title: 'Update canvas',
      status: 'succeeded',
      outputSummary: 'updated before restart',
      createdAt: now,
      updatedAt: now,
      toolCall: {
        callId: 'existing-call',
        toolId: 'canvas_write_test',
        effect: 'canvas_write',
        inputFingerprint: fingerprintToolInput('canvas_write_test', input),
        retryCount: 0,
        resultSummary: 'updated before restart',
      },
    }] : [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: { maxModelRounds: 4, maxToolCalls: 4, maxParallelReadTools: 1, maxReadRetries: 3 },
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    activeConversationId: 'conversation-1',
    conversations: [{
      id: 'conversation-1', projectId: 'project-1', title: 'Diagnostics', titleSource: 'auto',
      pinned: false, archived: false, agentMode: 'autonomous', createdAt: 1, updatedAt: 1,
      messageCount: 0,
    }],
    historyIndex: 0,
    canvasRevision: 0,
    agentTasks: [createTask()],
  });
  streamAssistantReplyMock.mockReset();
});

afterEach(() => {
  clearAgentToolRegistryForTests();
  clearAgentLifecycleListenersForTests();
});

function arrangeStream() {
  let round = 0;
  streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
    round += 1;
    onEvent({ type: 'usage', inputTokens: round === 1 ? 10 : 2, outputTokens: round === 1 ? 3 : 1 });
    if (round === 1) {
      onEvent({
        type: 'tool.call.final',
        call: { callId: 'call-1', toolId: 'canvas_write_test', input },
      });
    }
  });
}

describe('agent runtime diagnostics', () => {
  it('records usage, lifecycle events, and a canvas checkpoint', async () => {
    const lifecycleTypes: string[] = [];
    const unsubscribe = subscribeAgentLifecycle((event) => {
      lifecycleTypes.push(event.type);
    });
    arrangeStream();
    registerAgentTool({
      id: 'canvas_write_test',
      title: 'Update canvas',
      description: 'Update canvas',
      effect: 'canvas_write',
      inputSchema: { type: 'object', additionalProperties: true, properties: {} },
      execute: vi.fn(async () => {
        useAppStore.setState({ historyIndex: 1, canvasRevision: 1 });
        return { status: 'success' as const, summary: 'updated', modelContent: 'updated' };
      }),
    });

    await runAgentLoop({
      taskId: 'task-diagnostics',
      systemPrompt: 'system',
      userMessage: 'update canvas',
      signal: new AbortController().signal,
    });

    const task = useAppStore.getState().agentTasks[0];
    expect(task.metrics).toMatchObject({ inputTokens: 12, outputTokens: 4, policyAllowed: 1 });
    expect(task.steps[0].toolCall?.canvasCheckpoint).toEqual({
      historyIndexBefore: 0,
      historyIndexAfter: 1,
      revisionBefore: 0,
      revisionAfter: 1,
    });
    expect(task.events?.map((event) => event.type)).toContain('canvas_checkpoint');
    expect(lifecycleTypes).toEqual(expect.arrayContaining([
      'model.round',
      'policy.decision',
      'tool.execution',
    ]));
    unsubscribe();
  });

  it('does not re-execute an identical succeeded write after resume', async () => {
    useAppStore.setState({ agentTasks: [createTask(true)] });
    arrangeStream();
    const execute = vi.fn();
    registerAgentTool({
      id: 'canvas_write_test',
      title: 'Update canvas',
      description: 'Update canvas',
      effect: 'canvas_write',
      inputSchema: { type: 'object', additionalProperties: true, properties: {} },
      execute,
    });

    await runAgentLoop({
      taskId: 'task-diagnostics',
      systemPrompt: 'system',
      userMessage: 'update canvas',
      signal: new AbortController().signal,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].steps.at(-1)).toMatchObject({
      status: 'succeeded',
      outputSummary: expect.stringContaining('已复用先前成功结果'),
    });
  });
});
