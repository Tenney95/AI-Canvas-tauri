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

  it('returns configured built-in, custom and workflow models without private config', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          apimart: {
            name: 'APIMart',
            apiKey: 'secret-api-key',
            baseUrl: 'https://private.example.com/v1',
            selectedModels: [{
              id: 'gpt-image-2',
              name: 'GPT Image 2',
              category: 'image',
              provider: 'apimart',
            }, {
              id: 'doubao-seedance-2.0-fast',
              name: '豆包视频 2.0 Fast',
              category: 'video',
              provider: 'apimart',
            }],
          },
          'custom-text': {
            name: 'Custom Text',
            apiKey: 'custom-secret',
            baseUrl: 'https://custom.private.example.com/v1',
          },
        },
        generalModels: [{
          id: 'custom-text-model',
          name: 'Custom Writer',
          modelId: 'writer-v1',
          category: 'text',
          providerConfigId: 'custom-text',
        }],
      },
      workflows: [{
        id: 'workflow-video',
        name: 'LTX23-单图生视频流',
        category: 'ai-video',
        fileName: 'private-workflow.json',
        fileContent: '{"private":true}',
        ioNodes: [{ nodeId: '1', title: 'Input Image', type: 'image' }],
        createdAt: 1,
      }],
    }));

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-models',
      requestId: 'session-models:call-1',
      method: 'tools/call',
      params: { name: 'app_get_state', arguments: {} },
    });

    const response = result as {
      isError: boolean;
      content: Array<{ type: 'text'; text: string }>;
    };
    expect(response.isError).toBe(false);
    const state = JSON.parse(response.content[0].text) as {
      models: Array<Record<string, unknown>>;
      workflows: Array<Record<string, unknown>>;
    };
    expect(state.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'apimart/gpt-image-2',
        category: 'image',
        provider: 'apimart',
      }),
      expect.objectContaining({
        id: 'apimart/doubao-seedance-2.0-fast',
        category: 'video',
        provider: 'apimart',
      }),
      expect.objectContaining({
        id: 'general/custom-text-model',
        category: 'text',
        provider: 'general',
      }),
    ]));
    expect(state.workflows).toEqual([{
      id: 'workflow-video',
      name: 'LTX23-单图生视频流',
      category: 'ai-video',
      ioNodeCount: 1,
    }]);
    expect(response.content[0].text).not.toContain('secret-api-key');
    expect(response.content[0].text).not.toContain('private.example.com');
    expect(response.content[0].text).not.toContain('private-workflow.json');
    expect(response.content[0].text).not.toContain('{"private":true}');
  });

  it('connects the right output handle to the left input handle', async () => {
    const createResult = await handleMcpBridgeRequest({
      sessionId: 'session-connect',
      requestId: 'session-connect:create',
      method: 'tools/call',
      params: {
        name: 'canvas_create_nodes',
        arguments: {
          nodes: [{ type: 'ai-text', label: 'Script' }, {
            type: 'ai-image',
            label: 'Storyboard',
          }],
        },
      },
    }) as { content: Array<{ type: 'text'; text: string }> };
    const created = JSON.parse(createResult.content[0].text) as {
      nodes: Array<{ id: string }>;
    };

    await handleMcpBridgeRequest({
      sessionId: 'session-connect',
      requestId: 'session-connect:connect',
      method: 'tools/call',
      params: {
        name: 'canvas_connect_nodes',
        arguments: {
          sourceId: created.nodes[0].id,
          targetId: created.nodes[1].id,
        },
      },
    });

    expect(useAppStore.getState().edges).toContainEqual(expect.objectContaining({
      source: created.nodes[0].id,
      target: created.nodes[1].id,
      sourceHandle: 'right',
      targetHandle: 'left',
    }));
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
