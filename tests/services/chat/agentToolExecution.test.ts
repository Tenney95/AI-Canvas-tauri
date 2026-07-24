import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';
import {
  executeRegisteredAgentToolCall,
} from '../../../src/services/chat/agentToolExecution';
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
} from '../../../src/services/chat/toolRegistry';
import {
  resolveAgentApproval,
  runAgentTask,
  transitionAgentTask,
  waitForAgentApproval,
} from '../../../src/services/chat/agentTaskControl';
import { useAppStore } from '../../../src/store/useAppStore';

function createTask(): AgentTask {
  return {
    id: 'mcp-task-1',
    projectId: 'project-1',
    conversationId: 'mcp-control-project-1',
    userMessageId: 'message-1',
    mode: 'autonomous',
    goal: 'MCP 请求：测试工具',
    status: 'queued',
    steps: [],
    modelRounds: 0,
    toolCallCount: 0,
    budget: {
      maxModelRounds: 1,
      maxToolCalls: 1,
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
    activeConversationId: 'mcp-control-project-1',
    conversations: [{
      id: 'mcp-control-project-1',
      projectId: 'project-1',
      title: 'MCP 控制',
      titleSource: 'user',
      pinned: true,
      archived: false,
      agentMode: 'autonomous',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }],
    agentTasks: [createTask()],
  });
});

afterEach(() => {
  clearAgentToolRegistryForTests();
});

describe('shared Agent tool execution for MCP', () => {
  it('validates and executes a read tool with an audited step', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'read complete',
      modelContent: 'read complete',
    }));
    registerAgentTool({
      id: 'mcp_read_test',
      title: 'Read test',
      description: 'Read test',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1 } },
      },
      execute,
    });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: { callId: 'call-1', toolId: 'mcp_read_test', input: { query: 'nodes' } },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      expect(result.summary.status).toBe('success');
      return 'completed';
    });

    expect(task.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.steps[0]).toMatchObject({
      kind: 'tool',
      status: 'succeeded',
      toolCall: { toolId: 'mcp_read_test', resultSummary: 'read complete' },
    });
  });

  it('waits for the existing application approval before a protected tool', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'write complete',
      modelContent: 'write complete',
    }));
    registerAgentTool({
      id: 'mcp_write_test',
      title: 'Write test',
      description: 'Write test',
      effect: 'file_write',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute,
    });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: { callId: 'call-2', toolId: 'mcp_write_test', input: {} },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
        onApprovalRequired: (step) => queueMicrotask(() => {
          resolveAgentApproval(step.approval!.id, { approved: true });
        }),
      });
      expect(result.summary.status).toBe('success');
      return 'completed';
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.steps[0]).toMatchObject({
      kind: 'approval',
      status: 'succeeded',
      approval: { status: 'approved' },
    });
  });

  it('rejects invalid input before tool execution', async () => {
    const execute = vi.fn();
    registerAgentTool({
      id: 'mcp_schema_test',
      title: 'Schema test',
      description: 'Schema test',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'string' } },
      },
      execute,
    });

    await runAgentTask('mcp-task-1', async (signal) => {
      const result = await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: { callId: 'call-3', toolId: 'mcp_schema_test', input: {} },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      expect(result.summary.status).toBe('error');
      return 'failed';
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
