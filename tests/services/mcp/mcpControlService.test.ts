import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMcpBridgeRequest,
  listMcpTools,
} from '../../../src/services/mcp/mcpControlService';
import {
  clearAgentToolRegistryForTests,
  registerAgentTool,
} from '../../../src/services/chat/toolRegistry';
import {
  ensureAgentToolsRegistered,
  resetAgentToolsRegistrationForTests,
} from '../../../src/services/chat/tools';
import { useAppStore } from '../../../src/store/useAppStore';

beforeEach(() => {
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-mcp',
    projects: [{
      id: 'project-mcp',
      name: 'MCP project',
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  ensureAgentToolsRegistered();
});

afterEach(() => {
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
});

describe('MCP control service', () => {
  it('discovers available Registry tools with their local schemas', async () => {
    const tools = await listMcpTools();
    expect(tools.some((tool) => tool.name === 'canvas_query')).toBe(true);
    expect(tools.some((tool) => tool.name === 'app_get_state')).toBe(true);
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    expect(useAppStore.getState().conversations).toContainEqual(
      expect.objectContaining({
        id: 'mcp-control-project-mcp',
        title: 'MCP 控制',
        agentMode: 'autonomous',
      }),
    );
  });

  it('creates an audited task and returns tool model content', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: '状态读取完成',
      modelContent: JSON.stringify({ revision: 3 }),
    }));
    registerAgentTool({
      id: 'mcp_control_read_test',
      title: '测试读取',
      description: '测试读取',
      effect: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute,
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-1',
      requestId: 'session-1:call-1',
      method: 'tools/call',
      params: { name: 'mcp_control_read_test', arguments: {} },
    });

    expect(result).toEqual({
      isError: false,
      summary: '状态读取完成',
      content: [{ type: 'text', text: JSON.stringify({ revision: 3 }) }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({
      conversationId: 'mcp-control-project-mcp',
      status: 'completed',
      steps: [expect.objectContaining({ status: 'succeeded' })],
    });
    expect(useAppStore.getState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('MCP 请求') }),
      expect.objectContaining({ role: 'assistant', status: 'done', agentTaskId: expect.any(String) }),
    ]));
  });

  it('does not create a task when no project is active', async () => {
    useAppStore.setState({ currentProjectId: null });
    const result = await handleMcpBridgeRequest({
      sessionId: 'session-1',
      requestId: 'session-1:call-2',
      method: 'tools/call',
      params: { name: 'canvas_query', arguments: {} },
    });
    expect(result).toMatchObject({ isError: true });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });
});
