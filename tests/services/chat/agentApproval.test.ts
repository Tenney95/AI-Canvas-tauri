import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';
import type { McpBridgeRequestEvent } from '../../../src/types/mcp';

const streamAssistantReplyMock = vi.hoisted(() => vi.fn());
// Each fixture registers the real provider tool explicitly; no unrelated tool initialization.
vi.mock('../../../src/services/chat/tools', () => ({ ensureAgentToolsRegistered: vi.fn() }));

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
import { registerProviderConfigAgentTools } from '../../../src/services/chat/tools/providerConfigTools';
import { getAgentTool } from '../../../src/services/chat/toolRegistry';
import { clearProviderModelCatalogsForTests, createProviderModelCatalog } from '../../../src/services/chat/providerModelCatalogService';
import { handleMcpBridgeRequest } from '../../../src/services/mcp/mcpControlService';

function createTask(): AgentTask {
  const now = Date.now();
  return {
    id: 'task-approval',
    projectId: 'project-approval',
    conversationId: 'conversation-approval',
    userMessageId: 'message-1',
    mode: 'collaborative',
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
      agentMode: 'collaborative',
    }],
    agentTasks: [createTask()],
  });
  streamAssistantReplyMock.mockReset();
});

afterEach(() => {
  clearProviderModelCatalogsForTests();
  vi.restoreAllMocks();
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
  const choices = [{ id: 'one', name: 'One', category: 'text' as const }, { id: 'two', name: 'Two', category: 'image' as const }];
  it.each(['collaborative', 'autonomous', 'plan'] as const)('keeps provider selection as a user choice in %s', async (mode) => {
    registerProviderConfigAgentTools();
    useAppStore.getState().updateConversation('conversation-approval', { agentMode: mode });
    const execute = vi.spyOn(getAgentTool('provider_models_select')!, 'execute');
    let rounds = 0;
    streamAssistantReplyMock.mockImplementation(async ({ onEvent }) => {
      if (rounds++ === 0) onEvent({ type: 'tool.call.final', call: {
        callId: 'provider', toolId: 'provider_models_select', input: { models: choices, selectedIds: ['one'] },
      } });
    });
    let pendingId: string | undefined;
    let finished = false;
    const run = runAgentLoop({ taskId: 'task-approval', systemPrompt: 'system', userMessage: 'select models',
      signal: new AbortController().signal, callbacks: { onApprovalRequired: (step) => {
        expect(step.approval?.kind).toBe('user_choice');
        expect(step.approval?.inputRequest?.kind).toBe('provider_models');
        pendingId = step.approval!.id;
      } } }).then((result) => { finished = true; return result; });
    if (mode === 'plan') {
      await run;
      expect(pendingId).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(pendingId).toBeDefined());
      expect(finished).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(resolveAgentApproval(pendingId!, { approved: true, inputValues: { selectedModelIds: ['two'] } })).toBe(true);
      await run;
      expect(execute).toHaveBeenCalledWith(expect.anything(), { models: choices, selectedIds: ['two'] });
    }
  });

  it.each(['approve', 'reject', 'cancel'] as const)('waits for real user approval through the MCP bridge: %s', async (action) => {
    registerProviderConfigAgentTools();
    const scope = { projectId: 'project-approval', conversationId: 'mcp-control-project-approval', taskId: 'catalog-loader' };
    const catalog = createProviderModelCatalog(scope, choices);
    const execute = vi.spyOn(getAgentTool('provider_models_select')!, 'execute');
    const request: McpBridgeRequestEvent = { sessionId: 'test-session', requestId: `provider-${action}`, method: 'tools/call',
      params: { name: 'provider_models_select', arguments: { catalogId: catalog.catalogId, selectedIds: ['one'] } } };
    let finished = false;
    const run = handleMcpBridgeRequest(request).then((result) => { finished = true; return result; });
    const pending = () => useAppStore.getState().agentTasks.find((task) => task.conversationId === scope.conversationId && task.status === 'waiting_approval');
    await vi.waitFor(() => expect(pending()).toBeDefined());
    const approval = pending()!.steps[0].approval!;
    expect(approval.inputRequest?.kind).toBe('provider_models');
    expect(finished).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    // The bridge exposes no resolution method; spoofed MCP attempts cannot release the wait.
    await expect(handleMcpBridgeRequest({ ...request, method: 'approval/resolve' as McpBridgeRequestEvent['method'],
      params: { approvalId: approval.id, approved: true, selectedModelIds: ['one'] } })).rejects.toThrow('不支持');
    expect(finished).toBe(false);
    expect(resolveAgentApproval(approval.id, { approved: true, inputValues: { selectedModelIds: ['one'] } })).toBe(false);
    useAppStore.setState({ activeConversationId: scope.conversationId });
    if (action === 'cancel') {
      expect(await handleMcpBridgeRequest({ ...request, method: 'requests/cancel', params: { requestId: request.requestId } })).toEqual({ cancelled: true });
    } else {
      expect(resolveAgentApproval(approval.id, { approved: action === 'approve', inputValues: { selectedModelIds: ['two'] } })).toBe(true);
    }
    const result = await run;
    expect(result).toMatchObject({ isError: action !== 'approve' });
    if (action === 'approve') expect(execute).toHaveBeenCalledWith(expect.anything(), { catalogId: catalog.catalogId, selectedIds: ['two'] });
    else expect(execute).not.toHaveBeenCalled();
    expect(resolveAgentApproval(approval.id, { approved: true })).toBe(false);
  });
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
