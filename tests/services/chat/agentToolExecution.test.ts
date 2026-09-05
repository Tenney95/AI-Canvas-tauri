import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentApprovalResolution, AgentMode, AgentTask } from '../../../src/types/agent';
import {
  executeRegisteredAgentToolCall,
} from '../../../src/services/chat/agentToolExecution';
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
  type AgentToolDefinition,
} from '../../../src/services/chat/toolRegistry';
import {
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

function registerBoundaryTool(overrides: Partial<AgentToolDefinition> = {}) {
  const execute = vi.fn(async () => ({ status: 'success' as const, summary: 'done', modelContent: 'done' }));
  registerAgentTool({
    id: 'boundary_test', title: 'Boundary test', description: 'Boundary test', effect: 'canvas_write',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute,
    ...overrides,
  });
  return execute;
}

function executeBoundaryTool(options: {
  signal?: AbortSignal;
  policyMode?: AgentMode;
  waitForApproval?: () => Promise<AgentApprovalResolution>;
} = {}) {
  return executeRegisteredAgentToolCall({
    taskId: 'mcp-task-1',
    call: { callId: 'boundary-call', toolId: 'boundary_test', input: {} },
    signal: options.signal ?? new AbortController().signal,
    policyMode: options.policyMode,
    transitionTask: transitionAgentTask,
    waitForApproval: options.waitForApproval ?? vi.fn(async () => ({ approved: true })),
  });
}

function setBoundaryMode(mode: AgentMode) {
  useAppStore.getState().updateConversation('mcp-control-project-1', { agentMode: mode });
}

describe('shared Agent tool execution for MCP', () => {
  it.each(['paused', 'stopped', 'completed', 'failed'] as const)('rejects a %s task before invoking a tool', async (status) => {
    const execute = registerBoundaryTool();
    useAppStore.getState().updateAgentTask('mcp-task-1', { status });
    await expect(executeBoundaryTool()).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].status).toBe(status);
  });

  it('does not resume or execute a stopped task when an old approval resolves', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('collaborative');
    transitionAgentTask('mcp-task-1', 'planning');
    const controller = new AbortController();
    await expect(executeBoundaryTool({
      signal: controller.signal,
      waitForApproval: async () => {
        controller.abort();
        transitionAgentTask('mcp-task-1', 'stopped');
        return { approved: true };
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
  });

  it('rejects a previously approved write after switching to Plan', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('collaborative');
    transitionAgentTask('mcp-task-1', 'planning');
    const result = await executeBoundaryTool({ waitForApproval: async () => {
      setBoundaryMode('plan');
      return { approved: true };
    } });
    expect(result.summary.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks project identity even when the new project has the same revision', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('collaborative');
    transitionAgentTask('mcp-task-1', 'planning');
    const result = await executeBoundaryTool({ waitForApproval: async () => {
      useAppStore.setState({ currentProjectId: 'project-2' });
      return { approved: true };
    } });
    expect(result.summary.status).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains the trusted autonomous MCP override independently of conversation mode', async () => {
    const execute = registerBoundaryTool();
    setBoundaryMode('plan');
    const waitForApproval = vi.fn();
    const result = await executeBoundaryTool({ policyMode: 'autonomous', waitForApproval });
    expect(result.summary.status).toBe('success');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'autonomous' }), {});
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  it('does not bypass a user-choice approval with the MCP override', async () => {
    const execute = registerBoundaryTool({ effect: 'user_choice' });
    setBoundaryMode('plan');
    transitionAgentTask('mcp-task-1', 'planning');
    const waitForApproval = vi.fn(async () => ({ approved: true }));
    const result = await executeBoundaryTool({ policyMode: 'autonomous', waitForApproval });
    expect(result.summary.status).toBe('success');
    expect(waitForApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rechecks read authorization before an automatic retry', async () => {
    let authorized = true;
    const execute = vi.fn(async () => {
      authorized = false;
      return { status: 'error' as const, retryable: true, summary: 'temporary error', modelContent: 'temporary error' };
    });
    registerBoundaryTool({ effect: 'read', authorize: () => ({ allowed: authorized }), execute });
    const result = await executeBoundaryTool();
    expect(result.summary.status).toBe('denied');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not retry a read after its signal is cancelled', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort();
      return { status: 'error' as const, retryable: true, summary: 'interrupted', modelContent: 'interrupted' };
    });
    registerBoundaryTool({ effect: 'read', execute });
    await expect(executeBoundaryTool({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: 'autonomous', policyMode: undefined, expectedModel: 'default-model', approvals: 0 },
    { mode: 'plan', policyMode: 'autonomous', expectedModel: 'default-model', approvals: 0 },
    { mode: 'collaborative', policyMode: undefined, expectedModel: 'chosen-model', approvals: 1 },
  ] as const)('prepares media using effective mode: $mode / $policyMode', async ({ mode, policyMode, expectedModel, approvals }) => {
    setBoundaryMode(mode);
    transitionAgentTask('mcp-task-1', 'planning');
    const execute = vi.fn(async () => ({ status: 'success' as const, summary: 'generated', modelContent: 'generated' }));
    registerAgentTool<{ kind: string; prompt: string; modelRef?: string }>({
      id: 'media_generate', title: 'Media test', description: 'Media test', effect: 'media_generation',
      inputSchema: {
        type: 'object', required: ['kind', 'prompt'], additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['image'] }, prompt: { type: 'string' }, modelRef: { type: 'string' } },
      },
      resolveInput: (input) => ({ ...input, modelRef: input.modelRef ?? 'default-model' }),
      execute,
    });
    const waitForApproval = vi.fn(async () => ({ approved: true, inputValues: { modelRef: 'chosen-model' } }));
    const result = await executeRegisteredAgentToolCall({
      taskId: 'mcp-task-1',
      call: { callId: 'media-call', toolId: 'media_generate', input: { kind: 'image', prompt: 'a cat' } },
      signal: new AbortController().signal,
      policyMode,
      transitionTask: transitionAgentTask,
      waitForApproval,
    });
    expect(result.summary.status).toBe('success');
    expect(waitForApproval).toHaveBeenCalledTimes(approvals);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: policyMode ?? mode }), expect.objectContaining({ modelRef: expectedModel }));
  });

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

  it('persists sanitized structured input and result displays', async () => {
    registerAgentTool<{ query: string }>({
      id: 'mcp_display_test',
      title: 'Display test',
      description: 'Display test',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1 } },
      },
      buildInputDisplay: (input) => ({
        fields: [{ label: '查询', value: input.query }],
      }),
      execute: async () => ({
        status: 'success',
        summary: 'read complete',
        modelContent: 'read complete',
        display: { fields: [{ label: '命中', value: 3 }] },
      }),
    });

    const task = await runAgentTask('mcp-task-1', async (signal) => {
      await executeRegisteredAgentToolCall({
        taskId: 'mcp-task-1',
        call: {
          callId: 'call-display',
          toolId: 'mcp_display_test',
          input: { query: 'C:\\Users\\tester\\secret.txt token-abcdefghijkl' },
        },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      return 'completed';
    });

    expect(task.steps[0].toolCall).toMatchObject({
      inputDisplay: {
        fields: [{ label: '查询', value: '[本地路径]' }],
      },
      resultDisplay: {
        fields: [{ label: '命中', value: 3 }],
      },
    });
  });

  it('executes a protected tool without approval in autonomous mode', async () => {
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
      });
      expect(result.summary.status).toBe('success');
      return 'completed';
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(task.steps[0]).toMatchObject({
      kind: 'tool',
      status: 'succeeded',
      toolCall: { effect: 'file_write' },
    });
    expect(task.steps[0].approval).toBeUndefined();
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
