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
import type {
  AgentPackageInstallation,
  AgentPackageSkill,
} from '../../../src/types/agentPackage';

function packageSkill(partial: Partial<AgentPackageSkill> = {}): AgentPackageSkill {
  return {
    id: 'ap-skill-mcp-runtime',
    name: '短剧节奏设计',
    description: '用于设计开场钩子',
    fileName: 'SKILL.md',
    content: '# 短剧节奏\n先检查核心冲突。',
    sourceType: 'agent-package',
    createdAt: 1,
    installationId: 'agent-package-mcp',
    packageId: 'legacy.mcp-demo',
    packageName: 'AI短剧知识库',
    packageVersion: '0.0.0-legacy',
    packageContentHash: 'a'.repeat(64),
    sourceId: 'opaque-source-mcp',
    entryPath: 'skills/drama/SKILL.md',
    skillRoot: 'skills/drama',
    contentHash: 'b'.repeat(64),
    branch: 'shared',
    packageUserInvocable: true,
    packageAutoInvoke: false,
    mcpSkillReadEnabled: true,
    readOnly: true,
    ...partial,
  };
}

function packageInstallation(
  skill: AgentPackageSkill,
  partial: Partial<AgentPackageInstallation> = {},
): AgentPackageInstallation {
  return {
    id: skill.installationId,
    packageId: skill.packageId,
    manifest: {
      schemaVersion: 1,
      id: skill.packageId,
      name: skill.packageName,
      version: skill.packageVersion,
      entrypoints: { instructions: 'AGENTS.md' },
      supportedScopes: ['global'],
      supportedSurfaces: ['assistant', 'mcp'],
      routing: {
        userInvocable: skill.packageUserInvocable,
        autoInvoke: skill.packageAutoInvoke,
      },
    },
    source: {
      sourceId: skill.sourceId,
      sourceType: 'folder',
      displayName: skill.packageName,
    },
    entrypoints: [skill.entryPath],
    skillCount: 1,
    fileCount: 1,
    totalBytes: skill.content.length,
    warnings: [],
    health: 'ready',
    contentHash: skill.packageContentHash,
    enabled: true,
    mcpSkillReadEnabled: skill.mcpSkillReadEnabled,
    installedAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

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
    expect(tools.some((tool) => tool.name === 'project_list')).toBe(true);
    expect(tools.some((tool) => tool.name === 'project_delete')).toBe(true);
    // 通用 Skill 只读工具必须保持稳定发现；客户端通常会缓存首次 tools/list。
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'skill_search',
      'skill_load',
      'skill_read_file',
      'skill_list',
      'skill_get',
    ]));
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    expect(useAppStore.getState().conversations).toContainEqual(
      expect.objectContaining({
        id: 'mcp-control-project-mcp',
        title: 'MCP 控制',
        agentMode: 'autonomous',
      }),
    );
  });

  it('向 MCP 暴露全部当前可用的 Registry 工具', async () => {
    const tools = await listMcpTools();
    expect(tools.some((tool) => tool.name === 'agent_run_sub_agent')).toBe(true);
    expect(tools.some((tool) => tool.name === 'canvas_query')).toBe(true);
  });

  it('不继承内置助手模式，受保护工具也无须审批', async () => {
    await listMcpTools();
    useAppStore.getState().updateConversation('mcp-control-project-mcp', {
      agentMode: 'collaborative',
    });
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      summary: '配置已写入',
      modelContent: '配置已写入',
    }));
    registerAgentTool({
      id: 'mcp_control_config_write_test',
      title: '测试配置写入',
      description: '验证 MCP 最大权限上下文',
      effect: 'config_write',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute,
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-1',
      requestId: 'session-1:req-protected',
      method: 'tools/call',
      params: {
        name: 'mcp_control_config_write_test',
        arguments: {},
      },
    }) as { isError: boolean; summary: string };

    expect(result).toMatchObject({ isError: false, summary: '配置已写入' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().agentTasks.at(-1)).toMatchObject({
      mode: 'autonomous',
      steps: [expect.objectContaining({ kind: 'tool', status: 'succeeded' })],
    });
  });

  it('某个工具的 isAvailable 抛错时不影响其余工具的发现', async () => {
    registerAgentTool({
      id: 'broken_probe',
      title: '异常探针',
      description: '用于验证发现阶段的容错',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      isAvailable: () => { throw new Error('isAvailable 故障'); },
      execute: async () => ({ status: 'success', summary: '', modelContent: '' }),
    });
    const tools = await listMcpTools();
    expect(tools.some((tool) => tool.name === 'broken_probe')).toBe(false);
    expect(tools.some((tool) => tool.name === 'canvas_query')).toBe(true);
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

  it('通过统一执行链读取已授权智能体包 Skill，且不暴露原生定位字段', async () => {
    const skill = packageSkill();
    useAppStore.setState({
      agentPackages: [packageInstallation(skill)],
      agentPackageSkills: [skill],
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-package-skill',
      requestId: 'session-package-skill:load',
      method: 'tools/call',
      params: {
        name: 'skill_load',
        arguments: { skillId: skill.id },
      },
    }) as { isError: boolean; content: Array<{ type: 'text'; text: string }> };

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('先检查核心冲突。');
    expect(result.content[0].text).toContain('不可信');
    expect(JSON.stringify(result)).not.toContain(skill.sourceId);
    expect(JSON.stringify(result)).not.toContain(skill.entryPath);
  });

  it('直接 tools/call 也不能绕过智能体包 MCP 只读授权', async () => {
    const privateSkill = packageSkill({
      id: 'ap-skill-mcp-private',
      name: '未授权 Skill',
      description: '不应被 MCP 读取',
      content: 'private-package-content',
      installationId: 'agent-package-private',
      packageId: 'legacy.private',
      packageName: '私有知识库',
      packageContentHash: 'c'.repeat(64),
      sourceId: 'opaque-source-private',
      entryPath: 'skills/private/SKILL.md',
      skillRoot: 'skills/private',
      contentHash: 'd'.repeat(64),
      mcpSkillReadEnabled: false,
    });
    useAppStore.setState({
      agentPackages: [packageInstallation(privateSkill)],
      agentPackageSkills: [privateSkill],
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-package-private',
      requestId: 'session-package-private:load',
      method: 'tools/call',
      params: {
        name: 'skill_load',
        arguments: { skillId: 'ap-skill-mcp-private' },
      },
    }) as { isError: boolean; content: Array<{ type: 'text'; text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-package-content');
    expect(JSON.stringify(result)).not.toContain('opaque-source-private');
  });

  it('直接 tools/call 在授权关闭后立即拒绝仍未刷新的旧 Skill 快照', async () => {
    const staleSkill = packageSkill({ id: 'ap-skill-mcp-stale' });
    useAppStore.setState({
      agentPackages: [packageInstallation(staleSkill, { mcpSkillReadEnabled: false })],
      agentPackageSkills: [staleSkill],
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-package-stale',
      requestId: 'session-package-stale:load',
      method: 'tools/call',
      params: {
        name: 'skill_load',
        arguments: { skillId: staleSkill.id },
      },
    }) as { isError: boolean; content: Array<{ type: 'text'; text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('先检查核心冲突。');
    expect(JSON.stringify(result)).not.toContain(staleSkill.sourceId);
  });

  it('keeps a structured tool failure distinct from a failed response', async () => {
    registerAgentTool({
      id: 'mcp_control_structured_error_test',
      title: '测试结构化失败',
      description: '验证工具失败与响应失败使用不同状态',
      effect: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: async () => ({
        status: 'error',
        summary: '已运行 0/1 个节点',
        modelContent: JSON.stringify({
          results: [{ nodeId: 'node-1', status: 'failed', message: '余额不足' }],
        }),
      }),
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-error',
      requestId: 'session-error:call-1',
      method: 'tools/call',
      params: { name: 'mcp_control_structured_error_test', arguments: {} },
    });

    expect(result).toMatchObject({
      isError: true,
      summary: '已运行 0/1 个节点',
    });
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({
      status: 'failed',
      resultSummary: '已运行 0/1 个节点',
      steps: [expect.objectContaining({ status: 'failed' })],
    });
    expect(useAppStore.getState().messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: '已运行 0/1 个节点',
      status: 'done',
      agentTaskId: expect.any(String),
    }));
  });

  it('returns transient image content without persisting its base64 payload', async () => {
    registerAgentTool({
      id: 'mcp_control_image_test',
      title: '测试图像',
      description: '测试 MCP 图像结果',
      effect: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: async () => ({
        status: 'success',
        summary: '图像已生成',
        modelContent: '{"width":640,"height":360}',
        mcpContent: [{ type: 'image' as const, data: 'YWJj', mimeType: 'image/jpeg' as const }],
      }),
    });

    const result = await handleMcpBridgeRequest({
      sessionId: 'session-image',
      requestId: 'session-image:call-1',
      method: 'tools/call',
      params: { name: 'mcp_control_image_test', arguments: {} },
    });

    expect(result).toEqual({
      isError: false,
      summary: '图像已生成',
      content: [{ type: 'image', data: 'YWJj', mimeType: 'image/jpeg' }],
    });
    expect(JSON.stringify(useAppStore.getState().messages)).not.toContain('YWJj');
    expect(JSON.stringify(useAppStore.getState().agentTasks)).not.toContain('YWJj');
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
