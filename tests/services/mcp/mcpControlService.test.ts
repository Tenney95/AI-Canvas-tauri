import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMcpBridgeRequest,
  listMcpTools,
} from '../../../src/services/mcp/mcpControlService';
import {
  clearAgentToolRegistryForTests,
  buildAssistantFunctionTools,
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
import * as directorRuntime from '../../../src/services/directorRuntimeRegistry';
import * as directorScenes from '../../../src/services/directorSceneService';
import { createDefaultDirectorScene } from '../../../src/services/directorBlenderRuntimeService';
import { buildDirectorSceneRelativePath } from '../../../src/services/directorSceneSchema';
import { resetDirectorNodeOperationsForTests } from '../../../src/services/directorNodeOperationService';
import type { AgentToolDefinition } from '../../../src/services/chat/toolRegistry';
import type { McpToolCallResult, McpToolCatalogResult } from '../../../src/types/mcp';

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

function mcpCall(name: string, args: unknown, requestId = 'catalog:call') {
  return handleMcpBridgeRequest({
    sessionId: 'catalog-session', requestId, method: 'tools/call', params: { name, arguments: args },
  }) as Promise<McpToolCallResult>;
}

function catalogResult(result: McpToolCallResult): McpToolCatalogResult {
  expect(result.isError).toBe(false);
  const content = result.content[0];
  if (content.type !== 'text') throw new Error('Expected catalog text');
  return JSON.parse(content.text) as McpToolCatalogResult;
}

function registerDispatchProbe(partial: Partial<AgentToolDefinition> = {}) {
  const execute = vi.fn(async () => ({ status: 'success' as const, summary: '测试成功', modelContent: '{"done":true}' }));
  registerAgentTool({
    id: 'mcp_dispatch_probe', title: '分发测试', description: '测试统一执行链', effect: 'config_write',
    inputSchema: { type: 'object', required: ['value'], additionalProperties: false,
      properties: { value: { type: 'string' } } },
    execute, ...partial,
  });
  return execute;
}

describe('MCP on-demand discovery', () => {
  it('exposes three stable entrypoints, including before a project is loaded', async () => {
    const names = ['tools_search', 'tools_describe', 'tools_call'];
    expect((await listMcpTools()).map((tool) => tool.name)).toEqual(names);
    expect((await listMcpTools()).at(-1)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    useAppStore.setState({ currentProjectId: null });
    expect((await listMcpTools()).map((tool) => tool.name)).toEqual(names);
    expect(await mcpCall('tools_search', {})).toMatchObject({ isError: true });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });

  it('honors the saved exposure mode and keeps internal assistant tools unchanged', async () => {
    const store = useAppStore.getState();
    store.updateConfig({ mcpToolExposure: 'full' });
    expect((await listMcpTools()).some((tool) => tool.name === 'canvas_query')).toBe(true);
    expect((await listMcpTools()).some((tool) => tool.name === 'tools_search')).toBe(false);
    store.updateConfig({ mcpToolExposure: 'compact' });
    const listed = await handleMcpBridgeRequest({ sessionId: 's', requestId: 'list', method: 'tools/list', params: { exposure: 'full' } }) as { tools: unknown[] };
    expect(listed.tools).toHaveLength(3);
    expect(buildAssistantFunctionTools({ taskId: 'chat-task', projectId: 'project-mcp', conversationId: 'normal-chat', mode: 'autonomous' })
      .some((tool) => tool.function.name.startsWith('tools_'))).toBe(false);
  });

  it('persists the exposure mode through the existing config save/load actions', async () => {
    useAppStore.setState({ configHydrated: true });
    useAppStore.getState().updateConfig({ mcpToolExposure: 'full' });
    await useAppStore.getState().saveConfig({ silent: true, throwOnError: true });
    useAppStore.getState().updateConfig({ mcpToolExposure: 'compact' });
    await useAppStore.getState().loadConfig();
    expect(useAppStore.getState().config.mcpToolExposure).toBe('full');
    expect((await listMcpTools()).some((tool) => tool.name === 'canvas_query')).toBe(true);
  });

  it.each([
    ['查询画布', 'canvas_query'], ['项目', 'project_list'], ['图片生成', 'media_generate'],
    ['blender', 'director_get_state'], ['技能', 'skill_search'], ['插件窗口', 'plugin_window_get_state'],
    ['厂商配置', 'provider_config_preview'],
  ])('finds real registered tools for %s', async (query, name) => {
    const result = catalogResult(await mcpCall('tools_search', { query, limit: 8 }));
    expect(result.tools.map((tool) => tool.name)).toContain(name);
    expect(result.tools.every((tool) => !tool.inputSchema)).toBe(true);
  });

  it('keeps schemas longer than the generic result limit complete and transient', async () => {
    const longDescription = 'schema-marker-' + 'x'.repeat(22_000);
    registerDispatchProbe({ inputSchema: { type: 'object', properties: { value: { type: 'string', description: longDescription } } } });
    const detail = catalogResult(await mcpCall('tools_describe', { names: ['mcp_dispatch_probe'] }));
    expect(detail.tools[0].inputSchema?.properties?.value.description).toBe(longDescription);
    expect(JSON.stringify(useAppStore.getState().messages)).not.toContain('schema-marker-');
    expect(JSON.stringify(useAppStore.getState().agentTasks)).not.toContain('schema-marker-');
  });

  it('reports a schema budget error instead of silently slicing the result', async () => {
    registerDispatchProbe({ description: 'x'.repeat(70_000) });
    expect(await mcpCall('tools_describe', { names: ['mcp_dispatch_probe'] })).toMatchObject({ isError: true, summary: expect.stringContaining('预算') });
  });

  it('dispatches under the original effect and records only the real tool task', async () => {
    const execute = registerDispatchProbe();
    const result = await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'yes' } });
    expect(result).toMatchObject({ isError: false });
    expect(execute).toHaveBeenCalledOnce();
    const tasks = useAppStore.getState().agentTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ toolCallCount: 1, status: 'completed', steps: [expect.objectContaining({ toolCall: expect.objectContaining({ toolId: 'mcp_dispatch_probe', effect: 'config_write' }) })] });
    expect(tasks[0].goal).toContain('分发测试');
    expect(tasks[0].goal).not.toContain('tools_call');
  });

  it('applies the target schema and current authorization after earlier discovery', async () => {
    let allowed = true;
    const execute = registerDispatchProbe({ authorize: () => ({ allowed, reason: '授权已撤销' }) });
    catalogResult(await mcpCall('tools_describe', { names: ['mcp_dispatch_probe'] }, 'describe'));
    expect(await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 123 } }, 'bad-input')).toMatchObject({ isError: true });
    allowed = false;
    expect(await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } }, 'revoked')).toMatchObject({ isError: true, summary: expect.stringContaining('授权已撤销') });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown targets and tools that became unavailable', async () => {
    let available = true;
    const execute = registerDispatchProbe({ isAvailable: () => available });
    catalogResult(await mcpCall('tools_describe', { names: ['mcp_dispatch_probe'] }, 'describe'));
    available = false;
    expect(await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } }, 'unavailable')).toMatchObject({ isError: true });
    expect(await mcpCall('tools_call', { name: 'unknown_mcp_probe', arguments: {} }, 'unknown')).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks the active project instead of reusing an earlier catalog context', async () => {
    const execute = registerDispatchProbe({ authorize: (context) => ({ allowed: context.projectId === 'project-mcp', reason: '项目不匹配' }) });
    catalogResult(await mcpCall('tools_describe', { names: ['mcp_dispatch_probe'] }, 'describe'));
    useAppStore.setState({ currentProjectId: 'other-project' });
    expect(await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } })).toMatchObject({ isError: true, summary: '项目不匹配' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['canvas_write', 'media_generation'] as const)('does not retry a failed %s call', async (effect) => {
    const execute = vi.fn(async () => ({ status: 'error' as const, retryable: true, summary: '调用失败', modelContent: '调用失败' }));
    registerDispatchProbe({ effect, execute });
    expect(await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } })).toMatchObject({ isError: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps user_choice waiting and cancels it through the original request ID', async () => {
    const execute = registerDispatchProbe({ effect: 'user_choice' });
    const pending = mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } }, 'session:choice');
    try {
      await vi.waitFor(() => expect(useAppStore.getState().agentTasks[0]?.status).toBe('waiting_approval'));
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-choice', method: 'requests/cancel', params: { requestId: 'session:choice' } });
      await pending;
    }
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards cancellation to an executing target', async () => {
    let receivedSignal: AbortSignal | undefined;
    registerDispatchProbe({ execute: (context) => {
      receivedSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
    } });
    const pending = mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } }, 'session:running');
    try {
      await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-running', method: 'requests/cancel', params: { requestId: 'session:running' } });
      await pending;
    }
    expect(receivedSignal?.aborted).toBe(true);
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
  });

  it.each([null, [], { name: 'tools_call', arguments: {} }, { name: 'tools_search', arguments: {} }, { name: 'canvas_query', arguments: [] }])('rejects invalid or recursive envelopes without starting a task: %j', async (input) => {
    expect(await mcpCall('tools_call', input)).toMatchObject({ isError: true });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });

  it('measures the catalog reduction and an actual search/describe/call read flow', async () => {
    const full = JSON.stringify({ tools: await listMcpTools('full') });
    const compact = JSON.stringify({ tools: await listMcpTools() });
    const search = await mcpCall('tools_search', { query: 'canvas_query', detail: 'schema', limit: 1 }, 'search');
    const selected = catalogResult(search).tools[0];
    expect(selected.name).toBe('canvas_query');
    expect(selected.inputSchema).toBeDefined();
    const result = await mcpCall('tools_call', { name: selected.name, arguments: {} }, 'execute');
    expect(result.isError).toBe(false);
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    expect(bytes(compact)).toBeLessThan(bytes(full) * 0.2);
    expect(bytes(compact + JSON.stringify(search))).toBeLessThan(bytes(full));
    process.stdout.write(`MCP catalog bytes: ${JSON.stringify({ fullTools: JSON.parse(full).tools.length, full: bytes(full), compact: bytes(compact), search: bytes(JSON.stringify(search)), result: bytes(JSON.stringify(result)) })}\n`);
  });
});

describe('MCP control service', () => {
  it('discovers available Registry tools with their local schemas', async () => {
    const tools = await listMcpTools('full');
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
      'director_get_state',
      'director_set_runtime',
      'director_open_blender',
      'director_render_frame',
      'director_render_video',
      'director_get_operation',
      'director_cancel_operation',
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
    const tools = await listMcpTools('full');
    expect(tools.some((tool) => tool.name === 'agent_run_sub_agent')).toBe(true);
    expect(tools.some((tool) => tool.name === 'canvas_query')).toBe(true);
  });

  it('不继承内置助手模式，受保护工具也无须审批', async () => {
    await listMcpTools('full');
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
    const tools = await listMcpTools('full');
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

  it('returns a director job before Blender exits and accepts subsequent MCP queries and cancellation', async () => {
    const scene = createDefaultDirectorScene('director-mcp');
    const sceneReference = {
      schemaVersion: 1 as const, sceneId: scene.sceneId, revision: scene.revision,
      sha256: 'a'.repeat(64), bytes: 512,
      relativePath: buildDirectorSceneRelativePath(scene.sceneId, scene.revision, 'a'.repeat(64)),
    };
    useAppStore.setState({ nodes: [{ id: 'director-mcp', type: 'ai-director', position: { x: 0, y: 0 },
      data: { label: 'MCP 导演台', type: 'ai-director', directorRuntimeKind: 'blender', directorScene: sceneReference, status: 'idle' } }] });
    const availability = vi.spyOn(directorRuntime, 'getDirectorRuntimeAvailability').mockResolvedValue({ state: 'ready' });
    const load = vi.spyOn(directorScenes, 'loadDirectorScene').mockResolvedValue(scene);
    let rejectEditor!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectEditor = reject; });
    let nativeSignal: AbortSignal | undefined;
    const open = vi.spyOn(directorRuntime, 'openDirectorRuntime').mockImplementation((_kind, request) => {
      nativeSignal = request.blender!.signal;
      request.blender!.onStatus!({ jobId: 'native-job-mcp', operation: 'open-editor', state: 'running',
        sceneId: scene.sceneId, sceneRevision: scene.revision, createdAtMs: 1, updatedAtMs: 2 });
      return pending;
    });
    let sequence = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await handleMcpBridgeRequest({ sessionId: 'director-session',
        requestId: `director-session:${sequence++}`, method: 'tools/call', params: { name, arguments: args } }) as {
        isError: boolean; content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(false);
      return JSON.parse(result.content[0].text) as {
        operation: { operationId: string; state: string; jobId: string };
      };
    };
    try {
      const started = await call('director_open_blender', { nodeId: 'director-mcp' });
      expect(started.operation).toMatchObject({ state: 'running', jobId: 'native-job-mcp' });
      expect(useAppStore.getState().agentTasks.at(-1)?.resultSummary).toContain('已受理');
      expect(nativeSignal?.aborted).toBe(false);
      const queried = await call('director_get_operation', { operationId: started.operation.operationId });
      expect(queried.operation.state).toBe('running');
      const cancelled = await call('director_cancel_operation', { operationId: started.operation.operationId });
      expect(cancelled.operation.state).toBe('cancelling');
      expect(nativeSignal?.aborted).toBe(true);
      rejectEditor(new DOMException('Aborted', 'AbortError'));
      await vi.waitFor(async () => {
        expect((await call('director_get_operation', { operationId: started.operation.operationId })).operation.state).toBe('cancelled');
      });
      expect(open).toHaveBeenCalledOnce();
    } finally {
      rejectEditor(new DOMException('Aborted', 'AbortError'));
      resetDirectorNodeOperationsForTests();
      open.mockRestore(); load.mockRestore(); availability.mockRestore();
    }
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

  it.each(['direct', 'envelope'])('returns transient image content without persisting its base64 payload: %s', async (route) => {
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
      params: route === 'direct'
        ? { name: 'mcp_control_image_test', arguments: {} }
        : { name: 'tools_call', arguments: { name: 'mcp_control_image_test', arguments: {} } },
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
