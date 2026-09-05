import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

const streamAssistantReplyMock = vi.hoisted(() => vi.fn());
const assembleAgentContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/ai/assistantStream', () => ({
  streamAssistantReply: streamAssistantReplyMock,
}));

vi.mock('../../../src/services/chat/contextManager', () => ({
  ContextBudgetError: class ContextBudgetError extends Error { readonly code = 'CONTEXT_ERROR'; },
  assembleAgentContext: assembleAgentContextMock,
  estimateModelMessagesTokens: vi.fn(() => 1),
  resolveAssistantContextSpec: vi.fn(() => ({ inputBudget: 100_000 })),
}));

import { runAgentLoop } from '../../../src/services/chat/agentRuntime';
import { fingerprintToolInput } from '../../../src/services/chat/agentCheckpointService';
import { enqueueAgentInterjection } from '../../../src/services/chat/agentInterjection';
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
  assembleAgentContextMock.mockReset();
  assembleAgentContextMock.mockResolvedValue({
    messages: [{ role: 'user', content: 'update canvas' }],
    usage: {},
  });
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

function restoreCheckpointTask() {
  const restoredTask = createTask(true);
  restoredTask.resumeCount = 1;
  restoredTask.steps[0].toolCall!.canvasCheckpoint = {
    historyIndexBefore: 0, historyIndexAfter: 1, revisionBefore: 0, revisionAfter: 1,
  };
  useAppStore.setState({ agentTasks: [restoredTask], historyIndex: 1, canvasRevision: 1 });
  return restoredTask;
}

describe('agent runtime diagnostics', () => {
  it('marks older conversation requests as context outside the current task boundary', async () => {
    assembleAgentContextMock.mockResolvedValue({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: '帮我规划一个科幻短片' },
        { role: 'assistant', content: '我先为你创建短片节点' },
        { role: 'user', content: '只配置 RightAPI 厂商' },
      ],
      usage: {},
    });
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: 'usage', inputTokens: 4, outputTokens: 1 });
    });

    await runAgentLoop({
      taskId: 'task-diagnostics',
      systemPrompt: 'system',
      userMessage: '只配置 RightAPI 厂商',
      signal: new AbortController().signal,
    });

    const messages = streamAssistantReplyMock.mock.calls[0]?.[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: '只配置 RightAPI 厂商' });
    expect(messages.at(-2)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('是本任务的唯一执行目标'),
    });
    expect(messages.at(-2)?.content).toContain('不得回头执行历史中的其他请求');
    expect(messages.at(-3)).toEqual({ role: 'assistant', content: '我先为你创建短片节点' });
  });

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
    restoreCheckpointTask();
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

  it.each(['unchanged', 'changed', 'interjected', 'legacy'] as const)('validates checkpoint recovery after a read-only round: %s', async (scenario) => {
    const restoredTask = restoreCheckpointTask();
    if (scenario === 'legacy') {
      const legacyStep = { ...restoredTask.steps[0], toolCall: { ...restoredTask.steps[0].toolCall!, canvasCheckpoint: undefined } };
      useAppStore.getState().updateAgentTask(restoredTask.id, { steps: [legacyStep] });
    }
    registerAgentTool({
      id: 'resume_read', title: 'Read', description: 'Read', effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        if (scenario === 'changed') useAppStore.getState().incrementRevision();
        if (scenario === 'interjected') enqueueAgentInterjection('task-diagnostics', '请再次执行这项修改');
        return { status: 'success', summary: 'read', modelContent: 'read' };
      },
    });
    const execute = vi.fn(async () => {
      useAppStore.getState().incrementRevision();
      return { status: 'success' as const, summary: 'new write', modelContent: 'new write' };
    });
    registerAgentTool({
      id: 'canvas_write_test', title: 'Write', description: 'Write', effect: 'canvas_write',
      inputSchema: { type: 'object', additionalProperties: true, properties: {} }, execute,
    });
    let round = 0;
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      round += 1;
      if (round === 1) onEvent({ type: 'tool.call.final', call: { callId: 'resume-read', toolId: 'resume_read', input: {} } });
      if (round === 2) onEvent({ type: 'tool.call.final', call: { callId: 'resume-write', toolId: 'canvas_write_test', input } });
    });
    await runAgentLoop({
      taskId: 'task-diagnostics', systemPrompt: 'system', userMessage: 'update canvas', signal: new AbortController().signal,
    });
    expect(execute).toHaveBeenCalledTimes(scenario === 'unchanged' ? 0 : 1);
    expect(useAppStore.getState().agentTasks[0].steps.at(-1)?.status).toBe('succeeded');
  });

  it('does not add newly completed operations to the resumed-step replay candidates', async () => {
    restoreCheckpointTask();
    const execute = vi.fn(async () => {
      useAppStore.getState().incrementRevision();
      return { status: 'success' as const, summary: 'new write', modelContent: 'new write' };
    });
    registerAgentTool({
      id: 'canvas_write_test', title: 'Write', description: 'Write', effect: 'canvas_write',
      inputSchema: { type: 'object', additionalProperties: true, properties: {} }, execute,
    });
    let round = 0;
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      round += 1;
      if (round <= 2) onEvent({ type: 'tool.call.final', call: {
        callId: `new-write-${round}`, toolId: 'canvas_write_test', input: { nodeIds: ['node-1'], dx: 40 },
      } });
    });
    await runAgentLoop({
      taskId: 'task-diagnostics', systemPrompt: 'system', userMessage: 'update canvas', signal: new AbortController().signal,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('checks replay eligibility after the preceding write in the same round has executed', async () => {
    restoreCheckpointTask();
    const execute = vi.fn(async () => {
      useAppStore.getState().incrementRevision();
      return { status: 'success' as const, summary: 'write', modelContent: 'write' };
    });
    registerAgentTool({
      id: 'canvas_write_test', title: 'Write', description: 'Write', effect: 'canvas_write',
      inputSchema: { type: 'object', additionalProperties: true, properties: {} }, execute,
    });
    let round = 0;
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      round += 1;
      if (round !== 1) return;
      onEvent({ type: 'tool.call.final', call: { callId: 'change-first', toolId: 'canvas_write_test', input: { ...input, label: 'different' } } });
      onEvent({ type: 'tool.call.final', call: { callId: 'restore-second', toolId: 'canvas_write_test', input } });
    });
    await runAgentLoop({
      taskId: 'task-diagnostics', systemPrompt: 'system', userMessage: 'update canvas', signal: new AbortController().signal,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
