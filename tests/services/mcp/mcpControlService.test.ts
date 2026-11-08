/**
 * mcpControlService — 回归测试：MCP on-demand discovery。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMcpBridgeRequest,
  initMcpControlService,
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
import * as mediaUploads from '../../../src/services/mediaUploadService';
import * as mediaDownloads from '../../../src/services/mediaDownloadService';
import * as directorScenes from '../../../src/services/directorSceneService';
import { createDefaultDirectorScene } from '../../../src/services/directorBlenderRuntimeService';
import { buildDirectorSceneRelativePath } from '../../../src/services/directorSceneSchema';
import { resetDirectorNodeOperationsForTests } from '../../../src/services/directorNodeOperationService';
import type { AgentToolDefinition } from '../../../src/services/chat/toolRegistry';
import type { McpToolCallResult, McpToolCatalogResult } from '../../../src/types/mcp';
import { resolveAgentApproval } from '../../../src/services/chat/agentTaskControl';
import { MCP_SETTINGS_CONVERSATION_ID, MCP_SETTINGS_SCOPE_ID } from '../../../src/services/mcp/mcpSettingsScope';
import * as chatHistory from '../../../src/services/chat/chatHistoryService';
import * as mcpBridge from '../../../src/services/mcp/mcpBridgeService';
import { MCP_CATALOG_MAX_BYTES } from '../../../src/services/mcp/mcpToolCatalog';
import { captureLegacyEpisodeContext, captureLegacyProjectExpectedContext } from '../../../src/services/projectExecutionContext';
import { registerEpisodeEditorSession } from '../../../src/services/episodeEditorSessionService';

const { getChatWindow } = vi.hoisted(() => ({ getChatWindow: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: { getByLabel: getChatWindow } }));

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
  getChatWindow.mockReset();
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-mcp',
    projectLoadStatus: 'ready',
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

function capabilityOverview(description: string): string {
  const endMarker = '工具简介目录结束。';
  const end = description.indexOf(endMarker);
  expect(end).toBeGreaterThanOrEqual(0);
  return description.slice(0, end + endMarker.length);
}

function capabilityEntries(overview: string): Array<{ name: string; title: string; availability: string }> {
  const entries: Array<{ name: string; title: string; availability: string }> = [];
  let availability = '';
  for (const line of overview.split('\n')) {
    const group = /^(当前可发现|需打开项目或满足上下文条件)（\d+ 项）$/.exec(line);
    if (group) { availability = group[1]; continue; }
    if (!availability || !line.includes(' | ') || line.startsWith('name | ')) continue;
    const [name, title] = line.split(' | ');
    entries.push({ name, title, availability });
  }
  return entries;
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
  it('restores the global audit and repairs interrupted tasks once before listening', async () => {
    const repairTasks = vi.fn(async () => ['old-task']);
    const repairMessages = vi.fn(async () => undefined);
    useAppStore.setState({ currentProjectId: null,
      repairInterruptedAgentTasksForProject: repairTasks, repairInterruptedForProject: repairMessages });
    const saved = { id: MCP_SETTINGS_CONVERSATION_ID, projectId: MCP_SETTINGS_SCOPE_ID,
      title: 'MCP 全局模型设置', titleSource: 'user' as const, pinned: true, archived: false, agentMode: 'autonomous' as const,
      createdAt: 1, updatedAt: 2, messageCount: 4 };
    const load = vi.spyOn(chatHistory, 'loadProjectConversations').mockResolvedValue([saved]);
    const unlisten = vi.fn();
    const listen = vi.spyOn(mcpBridge, 'listenForMcpBridgeRequests').mockImplementation(async () => {
      expect(repairTasks).toHaveBeenCalledWith(MCP_SETTINGS_SCOPE_ID);
      expect(useAppStore.getState().conversations).toContainEqual(saved);
      return unlisten;
    });
    const cleanups: Array<() => void> = [];
    try {
      cleanups.push(await initMcpControlService(), await initMcpControlService());
      expect(repairTasks).toHaveBeenCalledOnce();
      expect(repairMessages).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledWith(MCP_SETTINGS_SCOPE_ID);
      expect(useAppStore.getState().currentProjectId).toBeNull();
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      listen.mockRestore(); load.mockRestore();
    }
  });

  it('exposes image uploads only to MCP and omits uploaded bytes from messages and task audit', async () => {
    vi.stubGlobal('window', { __TAURI__: {} });
    const data = Buffer.from('private-image-byte-marker-for-upload-audit').toString('base64');
    const execute = vi.spyOn(mediaUploads, 'executeMediaUpload').mockResolvedValue({ uploadId: 'u1', state: 'cancelled' });
    try {
      const result = await mcpCall('tools_call', { name: 'file_media_upload', arguments: {
        action: 'append', uploadId: 'u1', offset: 0, data, checksum: 'a'.repeat(64),
      } }, 'upload:chunk');
      expect(result.isError).toBe(false);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ conversationId: expect.stringContaining('mcp-control-') }), expect.objectContaining({ data }));
      const state = useAppStore.getState();
      expect(state.agentTasks).toHaveLength(1);
      expect(JSON.stringify([state.messages, state.agentTasks])).not.toContain(data);
      expect(buildAssistantFunctionTools({ taskId: 'chat', projectId: 'project-mcp', conversationId: 'normal-chat', mode: 'autonomous' })
        .some((tool) => tool.function.name === 'file_media_upload')).toBe(false);
    } finally { execute.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('exposes three stable entrypoints, including before a project is loaded', async () => {
    const names = ['tools_search', 'tools_describe', 'tools_call'];
    expect((await listMcpTools()).map((tool) => tool.name)).toEqual(names);
    expect((await listMcpTools()).at(-1)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    useAppStore.setState({ currentProjectId: null });
    expect((await listMcpTools()).map((tool) => tool.name)).toEqual(names);
    expect(await mcpCall('tools_search', {})).toMatchObject({ isError: false });
    expect(useAppStore.getState().agentTasks[0].projectId).toBe(MCP_SETTINGS_SCOPE_ID);
  });

  it('discovers provider settings and project creation and navigation without a project, including full exposure', async () => {
    useAppStore.setState({ currentProjectId: null, configHydrated: true });
    const listed = await listMcpTools('full');
    expect(listed.some((tool) => tool.name === 'provider_config_preview')).toBe(true);
    expect(listed.map((tool) => tool.name)).toEqual(expect.arrayContaining(['project_list', 'project_get', 'project_create', 'project_open', 'project_switch']));
    expect(listed.map((tool) => tool.name)).toEqual(expect.arrayContaining(['tools_search', 'tools_describe', 'tools_call']));
    expect(listed.filter((tool) => !['tools_search', 'tools_describe', 'tools_call'].includes(tool.name))
      .every((tool) => tool.name.startsWith('provider_') || ['project_list', 'project_get', 'project_create', 'project_open', 'project_switch'].includes(tool.name))).toBe(true);
    expect(await mcpCall('tools_describe', { names: ['canvas_query'] })).toMatchObject({ isError: true });
    expect(await mcpCall('tools_describe', { names: ['project_delete'] })).toMatchObject({ isError: true });
    const navigation = catalogResult(await mcpCall('tools_search', { category: 'project', detail: 'schema' }, 'startup-project-search'));
    expect(navigation.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['project_list', 'project_create', 'project_open', 'project_switch']));
  });

  it('shows canvas capabilities in the startup compact overview without granting their search or execution', async () => {
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready' });
    const cached = await listMcpTools('compact');
    const search = cached.find((tool) => tool.name === 'tools_search')!;
    const describe = cached.find((tool) => tool.name === 'tools_describe')!;
    const call = cached.find((tool) => tool.name === 'tools_call')!;
    expect(cached.map((tool) => tool.name)).toEqual(['tools_search', 'tools_describe', 'tools_call']);
    const overview = capabilityOverview(search.description);
    const entries = capabilityEntries(overview);
    expect(entries).toEqual(expect.arrayContaining(['canvas_query', 'canvas_update_nodes'].map((name) =>
      expect.objectContaining({ name, availability: expect.stringContaining('需打开项目') }))));
    expect(overview).not.toMatch(/"inputSchema"\s*:|"properties"\s*:/);
    expect(new TextEncoder().encode(JSON.stringify(overview)).byteLength).toBeLessThanOrEqual(MCP_CATALOG_MAX_BYTES);
    const recoverySteps = [
      'tools_describe({"names":["project_list","project_open"]})',
      'tools_call({"name":"project_list","arguments":{}})',
      'tools_call({"name":"project_open","arguments":{"projectId":"<项目条目的id>"}})',
      'tools_describe({"names":["canvas_query"]})',
      'tools_call({"name":"canvas_query","arguments":{}})',
    ];
    let previousStep = -1;
    for (const step of recoverySteps) {
      const position = overview.indexOf(step);
      expect(position).toBeGreaterThan(previousStep);
      previousStep = position;
    }
    expect(overview).toContain('不要混入');
    expect(overview).toContain('project_get 读取项目资料不等于已打开画布');

    // 项目元数据可读不等于画布已打开，简介也不扩大真实目录白名单。
    expect(await mcpCall('project_get', { projectId: 'project-mcp' }, 'startup-overview-project')).toMatchObject({ isError: false });
    expect(useAppStore.getState().currentProjectId).toBeNull();
    const unavailable = catalogResult(await mcpCall(search.name, { category: 'canvas' }, 'startup-overview-search'));
    expect(unavailable.tools).toEqual([]);
    const mixed = await mcpCall(describe.name, { names: ['project_list', 'project_open', 'canvas_query'] }, 'startup-overview-describe');
    expect(mixed).toMatchObject({ isError: true });
    for (const guidance of ['未打开项目', 'project_list', 'project_open']) {
      expect(unavailable.hint).toContain(guidance);
      expect(mixed.summary).toContain(guidance);
    }
    for (const name of ['canvas_query', 'canvas_update_nodes']) {
      expect(await mcpCall(call.name, { name, arguments: {} }, `startup-overview-${name}`)).toMatchObject({ isError: true });
    }
  });

  it('rediscovers canvas parameters after project_open through the three entrypoints cached on startup', async () => {
    const switchProject = vi.fn(async (id: string) => {
      useAppStore.setState({ currentProjectId: id, projectLoadStatus: 'ready' });
      return id;
    });
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready', switchProject });
    const cached = await listMcpTools('compact');
    const search = cached.find((tool) => tool.name === 'tools_search')!;
    const describe = cached.find((tool) => tool.name === 'tools_describe')!;
    const call = cached.find((tool) => tool.name === 'tools_call')!;

    const navigation = catalogResult(await mcpCall(describe.name, { names: ['project_list', 'project_open'] }, 'cached-compact-navigation'));
    expect(navigation.tools.map((tool) => tool.name)).toEqual(['project_list', 'project_open']);
    expect(navigation.tools.every((tool) => tool.inputSchema?.type === 'object')).toBe(true);
    const listed = await mcpCall(call.name, { name: 'project_list', arguments: {} }, 'cached-compact-list');
    expect(listed.isError).toBe(false);
    const projects = JSON.parse((listed.content[0] as { text: string }).text) as { projects: Array<{ id: string }> };
    const target = projects.projects.find((project) => project.id === 'project-mcp');
    expect(target).toBeDefined();
    expect(useAppStore.getState().currentProjectId).toBeNull();
    expect(await mcpCall(call.name, { name: 'project_open', arguments: { projectId: target!.id } }, 'cached-compact-open'))
      .toMatchObject({ isError: false });
    expect(switchProject).toHaveBeenCalledOnce();
    const found = catalogResult(await mcpCall(search.name, { query: 'canvas_query', detail: 'schema', limit: 1 }, 'cached-compact-search'));
    expect(found.tools[0]).toMatchObject({ name: 'canvas_query', inputSchema: { type: 'object' } });
    const described = catalogResult(await mcpCall(describe.name, { names: ['canvas_query', 'canvas_update_nodes'] }, 'cached-compact-describe'));
    expect(described.tools.map((tool) => tool.name)).toEqual(['canvas_query', 'canvas_update_nodes']);
    expect(described.tools.every((tool) => tool.inputSchema?.type === 'object')).toBe(true);
    expect(useAppStore.getState().agentTasks.at(-1)?.projectId).toBe('project-mcp');
    expect(useAppStore.getState().agentTasks.at(-1)?.toolAllowlist).toBeUndefined();
  });

  it('keeps startup full-mode entrypoints usable for current-project canvas calls without refreshing tools/list', async () => {
    const switchProject = vi.fn(async (id: string) => {
      useAppStore.setState({ currentProjectId: id, projectLoadStatus: 'ready' });
      return id;
    });
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready', switchProject });
    const cached = await listMcpTools('full');
    expect(cached.map((tool) => tool.name)).toEqual(expect.arrayContaining(['tools_search', 'tools_describe', 'tools_call']));
    expect(cached.some((tool) => tool.name === 'canvas_query' || tool.name === 'canvas_update_nodes')).toBe(false);
    const call = cached.find((tool) => tool.name === 'tools_call')!;
    expect(await mcpCall(call.name, { name: 'project_open', arguments: { projectId: 'project-mcp' } }, 'cached-full-open'))
      .toMatchObject({ isError: false });

    const nodes = useAppStore.getState().nodes;
    const execution = await import('../../../src/services/chat/agentToolExecution');
    const execute = vi.spyOn(execution, 'executeRegisteredAgentToolCall').mockImplementation(async ({ taskId, call: proposed }) => {
      const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
      expect(task).toMatchObject({ projectId: 'project-mcp', conversationId: 'mcp-control-project-mcp' });
      expect(task?.toolAllowlist).toBeUndefined();
      return { summary: { callId: proposed.callId, toolId: proposed.toolId, status: 'success' as const, summary: '已转交工具', truncated: false },
        modelContent: '已转交工具' };
    });
    const calls = [
      { name: 'canvas_query', arguments: { detail: true, limit: 1 } },
      { name: 'canvas_update_nodes', arguments: { nodeIds: ['existing-node'], label: '镜头名称', x: 240 } },
    ];
    try {
      for (const input of calls) {
        expect(await mcpCall(call.name, input, `cached-full-${input.name}`)).toMatchObject({ isError: false });
      }
      expect(execute.mock.calls.map(([options]) => ({ name: options.call.toolId, arguments: options.call.input }))).toEqual(calls);
      expect(execute.mock.calls.every(([options]) => options.policyMode === 'autonomous')).toBe(true);
      expect(useAppStore.getState().nodes).toBe(nodes);
    } finally {
      execute.mockRestore();
    }
  });

  it.each([
    { entrypoint: 'direct', currentProjectId: null },
    { entrypoint: 'tools_call', currentProjectId: null },
    { entrypoint: 'tools_call', currentProjectId: 'project-mcp' },
  ])('creates through global audit with $entrypoint and current project $currentProjectId', async ({ entrypoint, currentProjectId }) => {
    const createProject = vi.fn(async (name?: string) => {
      const project = { id: 'startup-created', name: name ?? '自动项目', createdAt: 1, updatedAt: 1,
        dataFolder: 'private-project-folder', snapshot: 'data:image/png;base64,private' };
      useAppStore.setState((state) => ({ projects: [...state.projects, project], currentProjectId: project.id }));
      return project.id;
    });
    useAppStore.setState({ currentProjectId, projectLoadStatus: 'ready', createProject, projectLibraryOpen: true });
    const result = entrypoint === 'direct'
      ? await mcpCall('project_create', { name: '  启动页项目  ' }, 'startup-create')
      : await mcpCall('tools_call', { name: 'project_create', arguments: { name: '  启动页项目  ' } }, 'startup-create');
    expect(result.isError).toBe(false);
    expect(createProject).toHaveBeenCalledOnce();
    expect(createProject).toHaveBeenCalledWith('启动页项目', { signal: expect.any(AbortSignal) });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      id: 'startup-created', name: '启动页项目', currentProjectId: 'startup-created',
    });
    expect(useAppStore.getState().projectLibraryOpen).toBe(false);
    const task = useAppStore.getState().agentTasks[0];
    expect(task).toMatchObject({ projectId: MCP_SETTINGS_SCOPE_ID, conversationId: MCP_SETTINGS_CONVERSATION_ID,
      mode: 'autonomous', status: 'completed' });
    expect(task.steps[0]?.toolCall?.canvasCheckpoint).toBeUndefined();
    expect(JSON.stringify([result, useAppStore.getState().agentTasks, useAppStore.getState().messages]))
      .not.toMatch(/private-project-folder|base64/);
    expect(await mcpCall('canvas_query', {}, 'after-create-query')).toMatchObject({ isError: false });
    expect(useAppStore.getState().agentTasks.at(-1)?.projectId).toBe('startup-created');
  });

  it('lists, opens and switches projects from startup through global audit tasks', async () => {
    const switchProject = vi.fn(async (id: string) => {
      useAppStore.setState({ currentProjectId: id, projectName: id, projectLoadStatus: 'ready' });
      return id;
    });
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready', switchProject, projects: [
      { id: 'project-a', name: '重名项目', createdAt: 1, updatedAt: 1 },
      { id: 'project-b', name: '重名项目', createdAt: 2, updatedAt: 2 },
    ] });
    const first = await mcpCall('tools_call', { name: 'project_list', arguments: {} }, 'startup-list');
    expect(first.isError).toBe(false);
    expect(JSON.parse((first.content[0] as { text: string }).text)).toMatchObject({ currentProjectId: null,
      projects: [{ id: 'project-a', name: '重名项目' }, { id: 'project-b', name: '重名项目' }] });
    const opened = await mcpCall('tools_call', { name: 'project_open', arguments: { projectId: 'project-a' } }, 'startup-open');
    expect(opened.isError).toBe(false);
    const switched = await mcpCall('project_switch', { projectId: 'project-b' }, 'project-switch');
    expect(switched.isError).toBe(false);
    expect(JSON.parse((switched.content[0] as { text: string }).text)).toMatchObject({ previousProjectId: 'project-a', currentProjectId: 'project-b' });
    const repeated = await mcpCall('project_open', { projectId: 'project-b' }, 'project-repeat');
    expect(JSON.parse((repeated.content[0] as { text: string }).text)).toMatchObject({ alreadyOpen: true });
    expect(switchProject).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().agentTasks).toHaveLength(4);
    expect(useAppStore.getState().agentTasks.every((task) => task.projectId === MCP_SETTINGS_SCOPE_ID
      && task.conversationId === MCP_SETTINGS_CONVERSATION_ID && task.status === 'completed')).toBe(true);
    expect((await listMcpTools('full')).some((tool) => tool.name === 'canvas_query')).toBe(true);
    expect(await mcpCall('canvas_query', {}, 'after-open-query')).toMatchObject({ isError: false });
    expect(useAppStore.getState().agentTasks.at(-1)?.projectId).toBe('project-b');
  });

  it('returns project pages above the generic result limit without leaking them into audit', async () => {
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready', projects: Array.from({ length: 100 }, (_, index) => ({
      id: `project-${index}`, name: `project-list-private-marker-${index}` + '名'.repeat(210), createdAt: 1, updatedAt: 2,
      dataFolder: 'secret-folder', snapshot: 'data:image/png;base64,secret',
    })) });
    const result = await mcpCall('project_list', { limit: 100 }, 'large-project-list');
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeGreaterThan(20_000);
    expect(JSON.parse(text)).toMatchObject({ total: 100, returned: 100, hasMore: false });
    expect(text).not.toContain('secret-folder');
    expect(text).not.toContain('base64');
    expect(JSON.stringify([useAppStore.getState().agentTasks, useAppStore.getState().messages])).not.toContain('project-list-private-marker');
  });

  it('reports failed project loads and rejects unavailable navigation parameters', async () => {
    const switchProject = vi.fn(async () => undefined);
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready', switchProject });
    expect(await mcpCall('project_open', { projectId: 'project-mcp' }, 'failed-open')).toMatchObject({ isError: true });
    expect(await mcpCall('project_switch', { projectId: 'missing' }, 'missing-open')).toMatchObject({ isError: true });
    expect(await mcpCall('project_open', { projectId: 'project-mcp', toolAllowlist: ['canvas_query'] }, 'invalid-open'))
      .toMatchObject({ isError: true });
    expect(switchProject).toHaveBeenCalledOnce();
    expect(useAppStore.getState().currentProjectId).toBeNull();
  });

  it('rejects overlapping navigation and preserves cancellation on the original request', async () => {
    let finishSwitch: (() => void) | undefined;
    const switchProject = vi.fn(async () => {
      useAppStore.setState({ switchingProjectName: 'MCP project' });
      await new Promise<void>((resolve) => { finishSwitch = resolve; });
      useAppStore.setState({ switchingProjectName: null });
      return undefined;
    });
    useAppStore.setState({ currentProjectId: null, projectLoadStatus: 'ready', switchProject });
    const pending = mcpCall('tools_call', { name: 'project_open', arguments: { projectId: 'project-mcp' } }, 'pending-project-open');
    try {
      await vi.waitFor(() => expect(switchProject).toHaveBeenCalledOnce());
      expect(await mcpCall('project_switch', { projectId: 'project-mcp' }, 'overlapping-open')).toMatchObject({ isError: true, summary: expect.stringContaining('等待') });
      expect(await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-project-open', method: 'requests/cancel',
        params: { requestId: 'pending-project-open' } })).toEqual({ cancelled: true });
    } finally {
      finishSwitch?.();
      expect(await pending).toMatchObject({ isError: true });
    }
    expect(useAppStore.getState().currentProjectId).toBeNull();
    expect(switchProject).toHaveBeenCalledOnce();
    expect(useAppStore.getState().agentTasks.find((task) => task.steps[0]?.toolCall?.callId === 'pending-project-open')?.status).toBe('stopped');
  });

  it('previews and saves global image settings across project changes through the audited runtime', async () => {
    const saveConfig = vi.fn(async () => undefined);
    useAppStore.setState({ currentProjectId: null, configHydrated: true, saveConfig });
    const preview = await mcpCall('tools_call', { name: 'provider_config_preview', arguments: {
      connectionName: 'Global Images', baseUrl: 'https://gateway.example/v1', models: [{
        modelId: 'global-image', category: 'image', protocolSource: 'declarative',
        imageCapability: { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], supportsBatch: false, supportsImageReference: false },
        executionProtocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/images/generations', body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}' } },
          response: { type: 'json', result: { urlPath: 'data.0.url' } } },
      }],
    } }, 'global-preview');
    expect(preview.isError).toBe(false);
    const text = preview.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    const draftId = /draftId: (provider-draft-[\w-]+)/.exec(text)?.[1];
    expect(draftId).toBeTruthy();
    useAppStore.setState((state) => ({ currentProjectId: 'another-project', projects: [...state.projects,
      { id: 'another-project', name: 'another project', createdAt: 1, updatedAt: 1 }] }));
    expect(await mcpCall('tools_call', { name: 'provider_config_apply', arguments: { draftId } }, 'global-apply')).toMatchObject({ isError: false });
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(useAppStore.getState().config.generalModels?.[0].imageCapability?.resolutions).toEqual(['1K']);
    expect(useAppStore.getState().agentTasks.every((task) => task.projectId === MCP_SETTINGS_SCOPE_ID)).toBe(true);
    expect(useAppStore.getState().currentProjectId).toBe('another-project');
  });

  it('opens the global choice card without a project and accepts the user after switching projects', async () => {
    useAppStore.setState({ currentProjectId: null, chatOpen: false });
    const pending = mcpCall('tools_call', { name: 'provider_models_select', arguments: {
      models: [{ id: 'image', name: 'Image', category: 'image' }],
    } }, 'global-choice');
    try {
      await vi.waitFor(() => expect(useAppStore.getState().agentTasks[0]?.status).toBe('waiting_approval'));
      expect(useAppStore.getState()).toMatchObject({ chatOpen: true, activeConversationId: MCP_SETTINGS_CONVERSATION_ID });
      const approval = useAppStore.getState().agentTasks[0].steps[0].approval!;
      useAppStore.setState({ currentProjectId: 'another-project' });
      expect(resolveAgentApproval(approval.id, { approved: true, inputValues: { selectedModelIds: ['image'] } })).toBe(true);
      expect(await pending).toMatchObject({ isError: false });
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-global-choice', method: 'requests/cancel', params: { requestId: 'global-choice' } });
      await pending;
    }
  });

  it('honors the saved exposure mode and keeps internal assistant tools unchanged', async () => {
    const store = useAppStore.getState();
    store.updateConfig({ mcpToolExposure: 'full' });
    expect((await listMcpTools()).some((tool) => tool.name === 'canvas_query')).toBe(true);
    expect((await listMcpTools()).map((tool) => tool.name)).toEqual(expect.arrayContaining(['tools_search', 'tools_describe', 'tools_call']));
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
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-mcp' }), { value: 'yes' });
    const tasks = useAppStore.getState().agentTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ toolCallCount: 1, status: 'completed', steps: [expect.objectContaining({ toolCall: expect.objectContaining({ toolId: 'mcp_dispatch_probe', effect: 'config_write' }) })] });
    expect(tasks[0].goal).toContain('分发测试');
    expect(tasks[0].goal).not.toContain('tools_call');
  });

  it.each(['project', 'revision', 'project-only'] as const)('rejects a stale %s precondition before creating an execution task', async (change) => {
    const execute = registerDispatchProbe();
    const revision = useAppStore.getState().getCurrentRevision();
    if (change === 'revision') useAppStore.getState().incrementRevision();
    else useAppStore.setState({ currentProjectId: 'other-project' });
    const createTask = vi.spyOn(useAppStore.getState(), 'createAgentTask');
    try {
      const result = await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'must-not-execute' },
        expectedProjectId: 'project-mcp', ...(change !== 'project-only' ? { expectedRevision: revision } : {}),
      }, `stale-context-${change}`);
      expect(result.isError).toBe(true);
      const block = result.content[0];
      if (block.type !== 'text') throw new Error('Expected context conflict text');
      expect(JSON.parse(block.text)).toMatchObject({ errorCode: 'MCP_CONTEXT_CHANGED', retryable: false,
        current: { projectId: useAppStore.getState().currentProjectId, revision: useAppStore.getState().getCurrentRevision() } });
      expect(createTask).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(useAppStore.getState().agentTasks).toHaveLength(0);
      expect(useAppStore.getState().messages).toHaveLength(0);
    } finally {
      createTask.mockRestore();
    }
  });

  it.each([false, true])('forwards matching context metadata separately from real arguments (revision=%s)', async (withRevision) => {
    const execute = registerDispatchProbe();
    const execution = await import('../../../src/services/chat/agentToolExecution');
    const shared = vi.spyOn(execution, 'executeRegisteredAgentToolCall');
    const args = { value: 'business-only' };
    const revision = useAppStore.getState().getCurrentRevision();
    try {
      const result = await mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: args,
        expectedProjectId: 'project-mcp', ...(withRevision ? { expectedRevision: revision } : {}),
      }, `matching-context-${withRevision}`);
      expect(result.isError).toBe(false);
      expect(shared).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        expectedContext: { projectId: 'project-mcp', baseRevision: withRevision ? revision : undefined },
        call: expect.objectContaining({ toolId: 'mcp_dispatch_probe', input: { value: 'business-only' } }),
      }));
      expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: 'project-mcp', baseRevision: revision }), { value: 'business-only' });
      expect(args).toEqual({ value: 'business-only' });
      expect(useAppStore.getState().agentTasks).toHaveLength(1);
      expect(useAppStore.getState().agentTasks[0].status).toBe('completed');
    } finally {
      shared.mockRestore();
    }
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
    useAppStore.setState((state) => ({ currentProjectId: 'other-project', projects: [...state.projects,
      { id: 'other-project', name: 'other project', createdAt: 1, updatedAt: 1 }] }));
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
    useAppStore.setState({ chatOpen: false, chatPanelView: 'tasks', activeConversationId: 'other-chat' });
    const execute = registerDispatchProbe({ effect: 'user_choice' });
    const pending = mcpCall('tools_call', { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } }, 'session:choice');
    try {
      await vi.waitFor(() => expect(useAppStore.getState().agentTasks[0]?.status).toBe('waiting_approval'));
      expect(useAppStore.getState()).toMatchObject({
        chatOpen: true, chatPanelView: 'chat', activeConversationId: 'mcp-control-project-mcp',
      });
      expect(execute).not.toHaveBeenCalled();
      expect(getChatWindow).not.toHaveBeenCalled();
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-choice', method: 'requests/cancel', params: { requestId: 'session:choice' } });
      await pending;
    }
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reveals an existing detached assistant for user_choice without recreating it', async () => {
    const detached = { unminimize: vi.fn().mockResolvedValue(undefined), show: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) };
    getChatWindow.mockResolvedValue(detached);
    useAppStore.setState({ chatOpen: false, chatPanelDetached: true, chatPanelView: 'list' });
    const execute = registerDispatchProbe({ effect: 'user_choice' });
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, 'session:detached-choice');
    try {
      await vi.waitFor(() => expect(detached.setFocus).toHaveBeenCalledOnce());
      expect(getChatWindow).toHaveBeenCalledWith('chat-assistant');
      expect(detached.unminimize).toHaveBeenCalledOnce();
      expect(detached.show).toHaveBeenCalledOnce();
      expect(useAppStore.getState()).toMatchObject({
        chatPanelDetached: true, chatPanelView: 'chat', activeConversationId: 'mcp-control-project-mcp',
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-detached-choice', method: 'requests/cancel', params: { requestId: 'session:detached-choice' } });
      await pending;
    }
  });

  it('falls back to the main panel if the detached assistant is unavailable', async () => {
    getChatWindow.mockResolvedValue(null);
    useAppStore.setState({ chatOpen: false, chatPanelDetached: true });
    registerDispatchProbe({ effect: 'user_choice' });
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, 'session:missing-choice');
    try {
      await vi.waitFor(() => expect(useAppStore.getState().chatPanelDetached).toBe(false));
      expect(useAppStore.getState()).toMatchObject({ chatOpen: true, chatPanelView: 'chat' });
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-missing-choice', method: 'requests/cancel', params: { requestId: 'session:missing-choice' } });
      await pending;
    }
  });

  it('does not focus a detached assistant after the user switches projects', async () => {
    let resolveWindow!: (value: { unminimize: ReturnType<typeof vi.fn> }) => void;
    getChatWindow.mockReturnValue(new Promise((resolve) => { resolveWindow = resolve; }));
    useAppStore.setState({ chatPanelDetached: true });
    registerDispatchProbe({ effect: 'user_choice' });
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, 'session:stale-choice');
    const detached = { unminimize: vi.fn() };
    try {
      await vi.waitFor(() => expect(getChatWindow).toHaveBeenCalledOnce());
      useAppStore.setState({ currentProjectId: 'other-project', activeConversationId: 'other-chat', chatOpen: false });
      resolveWindow(detached);
      await Promise.resolve();
      expect(detached.unminimize).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toMatchObject({ chatOpen: false, activeConversationId: 'other-chat' });
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-stale-choice', method: 'requests/cancel', params: { requestId: 'session:stale-choice' } });
      await pending;
    }
  });

  it('keeps background calls from opening or switching the assistant', async () => {
    useAppStore.setState({ chatOpen: false, chatPanelView: 'tasks', activeConversationId: 'other-chat' });
    registerDispatchProbe({ effect: 'read' });
    expect(await mcpCall('mcp_dispatch_probe', { value: 'ok' })).toMatchObject({ isError: false });
    expect(useAppStore.getState()).toMatchObject({ chatOpen: false, chatPanelView: 'tasks', activeConversationId: 'other-chat' });
    expect(getChatWindow).not.toHaveBeenCalled();
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

  it('cancels during tool registration before a task exists', async () => {
    const execute = registerDispatchProbe();
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, 'cancel-before-registration');
    const rejected = expect(pending).rejects.toThrow('已取消');

    expect(await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'early-cancel',
      method: 'requests/cancel', params: { requestId: 'cancel-before-registration' } })).toEqual({ cancelled: true });

    await rejected;
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('remembers an early cancellation only for its own session and for a bounded time', async () => {
    const execute = registerDispatchProbe();
    const cancelledId = 'cancelled-before-arrival';
    await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-before-arrival',
      method: 'requests/cancel', params: { requestId: cancelledId } });
    await expect(mcpCall('mcp_dispatch_probe', { value: 'ok' }, cancelledId)).rejects.toThrow('已取消');
    expect(execute).not.toHaveBeenCalled();
    expect(await handleMcpBridgeRequest({ sessionId: 'another-session', requestId: cancelledId,
      method: 'tools/call', params: { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } } })).toMatchObject({ isError: false });

    const later = Date.now() + 16 * 60 * 1_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await mcpCall('mcp_dispatch_probe', { value: 'ok' }, cancelledId)).toMatchObject({ isError: false });
    } finally {
      clock.mockRestore();
    }
  });

  it('only accepts native session revocation and keeps a replacement session usable', async () => {
    let receivedSignal: AbortSignal | undefined;
    registerDispatchProbe({ execute: (context) => {
      if (receivedSignal) return Promise.resolve({ status: 'success' as const, summary: '新会话成功', modelContent: '新会话成功' });
      receivedSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
    } });
    const request = { sessionId: 'session-to-revoke', requestId: 'same-request', method: 'tools/call' as const,
      params: { name: 'mcp_dispatch_probe', arguments: { value: 'ok' } } };
    const pending = handleMcpBridgeRequest(request);
    try {
      await vi.waitFor(() => expect(receivedSignal).toBeDefined());
      expect(await handleMcpBridgeRequest({ sessionId: request.sessionId, requestId: 'client-cancel',
        method: 'requests/cancel', params: { scope: 'session' } })).toEqual({ cancelled: false });
      expect(receivedSignal?.aborted).toBe(false);
    } finally {
      await handleMcpBridgeRequest({ sessionId: request.sessionId, requestId: '',
        method: 'requests/cancel', params: { scope: 'session' } });
      await pending;
    }
    expect(receivedSignal?.aborted).toBe(true);
    await expect(handleMcpBridgeRequest({ ...request, requestId: 'late-request' })).rejects.toThrow('已取消');
    expect(await handleMcpBridgeRequest({ ...request, sessionId: 'replacement-session' })).toMatchObject({ isError: false });
  });

  it.each([null, [], { name: 'tools_call', arguments: {} }, { name: 'tools_search', arguments: {} }, { name: 'canvas_query', arguments: [] },
    { name: 'canvas_query', arguments: {}, expectedRevision: 0 }])('rejects invalid or recursive envelopes without starting a task: %j', async (input) => {
    expect(await mcpCall('tools_call', input)).toMatchObject({ isError: true });
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });

  it('measures the catalog reduction and an actual search/describe/call read flow', async () => {
    const schemaMarker = 'overview-schema-private-marker';
    registerDispatchProbe({ id: 'zz_capability_tail_probe', title: '简介末尾能力', description: '末尾完整简介标记',
      inputSchema: { type: 'object', properties: { value: { type: 'string', description: schemaMarker } } } });
    const fullTools = await listMcpTools('full');
    const compactTools = await listMcpTools();
    const full = JSON.stringify({ tools: fullTools });
    const compact = JSON.stringify({ tools: compactTools });
    const overview = capabilityOverview(compactTools.find((tool) => tool.name === 'tools_search')!.description);
    const entries = capabilityEntries(overview);
    expect(entries.map((entry) => entry.name).sort()).toEqual(fullTools
      .filter((tool) => !['tools_search', 'tools_describe', 'tools_call'].includes(tool.name)).map((tool) => tool.name).sort());
    expect(entries.at(-1)).toMatchObject({ name: 'zz_capability_tail_probe', title: '简介末尾能力' });
    expect(overview).not.toContain(schemaMarker);
    expect(overview).not.toMatch(/"inputSchema"\s*:|"properties"\s*:/);
    const search = await mcpCall('tools_search', { query: 'canvas_query', detail: 'schema', limit: 1 }, 'search');
    const selected = catalogResult(search).tools[0];
    expect(selected.name).toBe('canvas_query');
    expect(selected.inputSchema).toBeDefined();
    const result = await mcpCall('tools_call', { name: selected.name, arguments: {} }, 'execute');
    expect(result.isError).toBe(false);
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    expect(bytes(compact)).toBeLessThan(bytes(full));
    expect(bytes(JSON.stringify(overview))).toBeLessThanOrEqual(MCP_CATALOG_MAX_BYTES);
    process.stdout.write(`MCP catalog bytes: ${JSON.stringify({ fullTools: JSON.parse(full).tools.length, full: bytes(full), compact: bytes(compact), search: bytes(JSON.stringify(search)), result: bytes(JSON.stringify(result)) })}\n`);
  });
});

describe('MCP control service', () => {
  it.each(['direct', 'envelope'])('returns complete large canvas details through MCP: %s', async (route) => {
    const prompt = 'private-canvas-detail-marker'.repeat(15).slice(0, 400);
    useAppStore.setState({ nodes: Array.from({ length: 50 }, (_, index) => ({
      id: `detail-${index}`, type: 'ai-text', position: { x: index * 20, y: 0 },
      data: { type: 'ai-text' as const, label: `Detail ${index}`, prompt, output: prompt, status: 'success' as const },
    })) });

    const args = { detail: true, limit: 50 };
    const result = await mcpCall(route === 'direct' ? 'canvas_query' : 'tools_call',
      route === 'direct' ? args : { name: 'canvas_query', arguments: args }, `large-canvas-${route}`);

    expect(result.isError).toBe(false);
    const content = result.content[0];
    if (content.type !== 'text') throw new Error('Expected canvas detail text');
    expect(content.text.length).toBeGreaterThan(20_000);
    const detail = JSON.parse(content.text);
    expect(detail.nodes).toHaveLength(50);
    expect(detail.nodes[49]).toMatchObject({ id: 'detail-49', prompt: { text: prompt, truncated: false } });
    expect(JSON.stringify([useAppStore.getState().messages, useAppStore.getState().agentTasks]))
      .not.toContain('private-canvas-detail-marker');
  });

  it.each([
    { route: 'direct', effect: 'read' as const },
    { route: 'envelope', effect: 'read' as const },
    { route: 'direct', effect: 'file_write' as const },
    { route: 'envelope', effect: 'file_write' as const },
  ])('distinguishes result delivery errors from completed writes: $route / $effect', async ({ route, effect }) => {
    const execute = vi.fn(async () => ({
      status: 'success' as const, summary: 'operation complete', modelContent: 'x'.repeat(600_000),
    }));
    registerAgentTool({ id: 'mcp_large_result_test', title: 'Large result', description: 'Result delivery test', effect,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }, execute });

    const result = await mcpCall(route === 'direct' ? 'mcp_large_result_test' : 'tools_call',
      route === 'direct' ? {} : { name: 'mcp_large_result_test', arguments: {} }, `oversized-${route}-${effect}`);

    expect(result.isError).toBe(effect === 'read');
    const content = result.content[0];
    if (content.type !== 'text') throw new Error('Expected result delivery text');
    expect(JSON.parse(content.text)).toMatchObject({
      code: 'MCP_RESULT_TOO_LARGE', operationStatus: 'success', resultOmitted: true, retryable: false,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(useAppStore.getState().agentTasks.at(-1)).toMatchObject({
      status: 'completed', steps: [expect.objectContaining({ status: 'succeeded' })],
    });
  });

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
    expect(useAppStore.getState().conversations).toHaveLength(0);
    expect(await mcpCall('canvas_query', {}, 'discovery-read')).toMatchObject({ isError: false });
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
      content: [{ type: 'text', text: JSON.stringify({ revision: 3 }) },
        { type: 'text', text: expect.stringContaining('"expectedContext"') }],
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

  it.each([
    ['episode_update_script', { episodeId: 'project-mcp', script: '外部新正文' }],
    ['episode_update_outline', { episodeId: 'project-mcp', outline: '外部新大纲' }],
    ['episode_update_creative_field', { episodeId: 'project-mcp', field: 'task', value: '外部新要点' }],
  ] as const)('%s 的脏稿拒绝经过完整 MCP 执行链后仍是明确失败', async (name, input) => {
    const write = vi.fn(async () => true);
    useAppStore.setState({ projects: [
      { id: 'series-mcp', name: '测试剧集', createdAt: 1, updatedAt: 1 },
      { id: 'project-mcp', parentId: 'series-mcp', name: '测试分集', createdAt: 1, updatedAt: 1 },
    ], updateEpisodeCreative: write, updateEpisodeOutline: write });
    let dirty = true;
    const close = registerEpisodeEditorSession('project-mcp', () => ({ dirty, saving: false }));
    try {
      const result = await mcpCall('tools_call', { schemaVersion: 2, name, arguments: input,
        expectedContext: captureLegacyEpisodeContext(useAppStore.getState(), 'project-mcp') }, `editor-blocked:${name}`);
      expect(result).toMatchObject({ isError: true, summary: expect.stringContaining('未保存') });
      const content = result.content[0];
      if (content.type !== 'text') throw new Error('Expected structured editor conflict');
      expect(JSON.parse(content.text)).toMatchObject({ episodeId: 'project-mcp', errorCode: 'EPISODE_EDITOR_WRITE_BLOCKED', retryable: false });
      expect(write).not.toHaveBeenCalled();
      expect(useAppStore.getState().agentTasks[0]).toMatchObject({ status: 'failed', steps: [
        expect.objectContaining({ status: 'failed', errorCode: 'EPISODE_EDITOR_WRITE_BLOCKED' }),
      ] });
      expect(useAppStore.getState().agentTasks[0].pausedReason).not.toBe('tool_outcome_unknown');
      expect(useAppStore.getState().messages).toContainEqual(expect.objectContaining({
        role: 'assistant', status: 'done', content: expect.stringContaining('未保存'),
      }));
    } finally { dirty = false; close(); }
  });

  it('本集写入开始后抛错仍按结果未知暂停，且不自动重试', async () => {
    const write = vi.fn(async () => { throw new Error('写入结果尚未确认'); });
    useAppStore.setState({ projects: [
      { id: 'series-mcp', name: '测试剧集', createdAt: 1, updatedAt: 1 },
      { id: 'project-mcp', parentId: 'series-mcp', name: '测试分集', createdAt: 1, updatedAt: 1 },
    ], updateEpisodeCreative: write });
    const result = await mcpCall('tools_call', { schemaVersion: 2, name: 'episode_update_script',
      arguments: { episodeId: 'project-mcp', script: '新正文' },
      expectedContext: captureLegacyEpisodeContext(useAppStore.getState(), 'project-mcp') }, 'episode-write-unknown');
    expect(result).toMatchObject({ isError: true, summary: expect.stringContaining('结果未知') });
    expect(useAppStore.getState().agentTasks[0]).toMatchObject({
      status: 'paused', pausedReason: 'tool_outcome_unknown', errorCode: 'TOOL_OUTCOME_UNKNOWN',
    });
    expect(write).toHaveBeenCalledTimes(1);
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
      content: [{ type: 'image', data: 'YWJj', mimeType: 'image/jpeg' },
        { type: 'text', text: expect.stringContaining('"expectedContext"') }],
    });
    expect(JSON.stringify(useAppStore.getState().messages)).not.toContain('YWJj');
    expect(JSON.stringify(useAppStore.getState().agentTasks)).not.toContain('YWJj');
  });

  it.each(['direct', 'envelope'])('returns original file bytes only through transient MCP content: %s', async (route) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const data = Buffer.from('original-media-payload'.repeat(2000)).toString('base64');
    const chunk = { downloadId: 'private-download-handle', nodeId: 'media-node', state: 'open' as const,
      fileName: '原始视频.mp4', mimeType: 'video/mp4', totalBytes: 44_000, chunkBytes: 262144,
      expiresAt: 1_000_000, offset: 0, bytesRead: 44_000, nextOffset: 44_000, eof: true,
      encoding: 'base64' as const, data, checksumAlgorithm: 'sha256' as const, checksum: 'a'.repeat(64) };
    const execute = vi.spyOn(mediaDownloads, 'executeMediaDownload').mockResolvedValue(chunk);
    try {
      expect((await listMcpTools('full')).some((tool) => tool.name === 'file_media_download')).toBe(true);
      const ordinaryTools = buildAssistantFunctionTools({ taskId: 'ordinary', projectId: 'project-mcp',
        conversationId: 'conv-ordinary', mode: 'autonomous' });
      expect(ordinaryTools.some((tool) => tool.function.name === 'file_media_download')).toBe(false);
      const args = { action: 'read', downloadId: chunk.downloadId, offset: 0 };
      const result = await mcpCall(route === 'direct' ? 'file_media_download' : 'tools_call',
        route === 'direct' ? args : { name: 'file_media_download', arguments: args }, `download-${route}`);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-mcp',
        conversationId: 'mcp-control-project-mcp' }), args);
      expect(result).toMatchObject({ isError: false, summary: '已返回原文件字节块' });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(chunk) },
        { type: 'text', text: expect.stringContaining('"expectedContext"') }]);
      const persisted = JSON.stringify([useAppStore.getState().messages, useAppStore.getState().agentTasks]);
      expect(persisted).not.toContain(data);
      expect(persisted).not.toContain(chunk.downloadId);
      expect(persisted).not.toContain(chunk.checksum);
      execute.mockClear();
      const invalid = await mcpCall('file_media_download', { action: 'begin', nodeId: 'media-node', path: '/not-a-node-file' });
      expect(invalid.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    } finally { execute.mockRestore(); vi.unstubAllGlobals(); }
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

describe('MCP versioned execution context', () => {
  it('permits explicit deleted receipt auditing with a fresh global context without creating a scope task', async () => {
    useAppStore.setState({ currentProjectId: null });
    const operations = await import('../../../src/services/mcp/mcpOperationService');
    const read = vi.spyOn(operations, 'getHistoricalMcpOperationReceipt').mockResolvedValueOnce({ operationId: 'original-binding',
      taskId: 'original-task', projectId: 'deleted-canvas', toolId: 'media_generate', status: 'unknown', sequence: 7,
      resultAvailable: false, retryable: false, requiresReadVerification: true, nextAction: '只读核实，勿重投' });
    const result = await mcpCall('tools_call', { schemaVersion: 2, name: 'mcp_operation_get',
      arguments: { operationId: 'original-binding', legacyProjectId: 'deleted-canvas', auditScope: 'deleted-target' },
      expectedContext: captureLegacyProjectExpectedContext(useAppStore.getState(), 'global') }, 'typed:deleted-audit');
    expect(result.isError).not.toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(useAppStore.getState().conversations).toHaveLength(0);
  });

  it('rejects a missing or stale v2 write context before task creation without upgrading the old Canvas ID', async () => {
    const execute = registerDispatchProbe();
    const expectedContext = captureLegacyProjectExpectedContext(useAppStore.getState());
    const missing = await mcpCall('tools_call', { schemaVersion: 2, name: 'mcp_dispatch_probe', arguments: { value: 'ok' } }, 'typed:missing');
    expect(JSON.stringify(missing)).toContain('CONTEXT_REFRESH_REQUIRED');
    useAppStore.getState().incrementRevision();
    const stale = await mcpCall('tools_call', { schemaVersion: 2, name: 'mcp_dispatch_probe', arguments: { value: 'ok' }, expectedContext }, 'typed:stale');
    expect(JSON.stringify(stale)).toContain('CONTEXT_REFRESH_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });

  it('returns a reusable context from a read and preserves its value across another physical connection', async () => {
    registerDispatchProbe({ effect: 'read' });
    const result = await mcpCall('mcp_dispatch_probe', { value: 'read' }, 'typed:read');
    const block = result.content.find((item) => item.type === 'text' && item.text.includes('expectedContext'));
    if (!block || block.type !== 'text') throw new Error('Missing reusable context');
    const { expectedContext } = JSON.parse(block.text);
    const execute = registerDispatchProbe({ id: 'mcp_typed_write' });
    const written = await handleMcpBridgeRequest({ sessionId: 'second-physical-connection', requestId: 'typed:write', method: 'tools/call',
      params: { name: 'tools_call', arguments: { schemaVersion: 2, name: 'mcp_typed_write', arguments: { value: 'write' }, expectedContext } } }) as McpToolCallResult;
    expect(written.isError).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    const task = useAppStore.getState().agentTasks.find((item) => item.goal.includes('分发测试') && item.executionContext);
    expect(task).toMatchObject({ projectId: 'project-mcp', conversationId: 'mcp-control-project-mcp', executionContext: expectedContext });
  });

  it('blocks a target epoch change during asynchronous operation identification without claiming a new key', async () => {
    const execute = registerDispatchProbe({ id: 'canvas_typed_race', effect: 'canvas_write' });
    const expectedContext = captureLegacyProjectExpectedContext(useAppStore.getState());
    const operations = await import('../../../src/services/mcp/mcpOperationService');
    const identify = operations.identifyMcpOperation;
    vi.spyOn(operations, 'identifyMcpOperation').mockImplementationOnce(async (input) => {
      const identity = await identify(input);
      useAppStore.setState({ projects: useAppStore.getState().projects.map((item) => ({ ...item, exchangeEpoch: (item.exchangeEpoch ?? 0) + 1 })) });
      return identity;
    });
    const result = await mcpCall('tools_call', { schemaVersion: 2, name: 'canvas_typed_race', arguments: { value: 'ok' },
      expectedContext, operationKey: 'typed-epoch-race' }, 'typed:epoch-race');
    expect(JSON.stringify(result)).toContain('CONTEXT_REFRESH_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });

  it('rejects a stale new-model context before creating audit scopes or consulting operation storage', async () => {
    const execute = registerDispatchProbe();
    const actual = useAppStore.getState();
    const fixture = { ...captureLegacyProjectExpectedContext(actual), modelGeneration: 1 };
    vi.spyOn(useAppStore, 'getState').mockReturnValue({ ...actual, projectExecutionContext: { ...fixture, runtimeEpoch: 'different-runtime' } } as typeof actual);
    const result = await mcpCall('tools_call', { schemaVersion: 2, name: 'mcp_dispatch_probe', arguments: { value: 'fixture' }, expectedContext: fixture }, 'typed:dormant');
    expect(JSON.stringify(result)).toContain('CONTEXT_REFRESH_REQUIRED');
    expect(execute).not.toHaveBeenCalled();
    expect(actual.agentTasks).toHaveLength(0);
    expect(actual.conversations).toHaveLength(0);
  });

  it('hides Canvas capabilities on a series without a Canvas and rejects paid chat delivery before task creation', async () => {
    useAppStore.setState({ currentProjectId: 'series-owner', projects: [
      { id: 'series-owner', name: 'series', createdAt: 1, updatedAt: 1 },
      { id: 'episode-a', parentId: 'series-owner', name: 'episode', createdAt: 1, updatedAt: 1 },
    ] });
    const execute = registerDispatchProbe({ id: 'media_paid_probe', effect: 'media_generation' });
    const tools = await listMcpTools('full');
    expect(tools.map((item) => item.name)).not.toContain('canvas_query');
    expect(tools.map((item) => item.name)).not.toContain('media_paid_probe');
    const result = await mcpCall('media_paid_probe', { value: 'ok', delivery: 'chat' }, 'typed:no-canvas-media');
    expect(JSON.stringify(result)).toContain('NO_ACTIVE_CANVAS');
    expect(execute).not.toHaveBeenCalled();
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });
});

describe('MCP keyed operation receipts', () => {
  function project(id: string) {
    useAppStore.setState({ currentProjectId: id, projects: [{ id, name: id, createdAt: 1, updatedAt: 1 }] });
  }
  function operation(result: McpToolCallResult) {
    for (const content of [...result.content].reverse()) {
      if (content.type !== 'text') continue;
      try { const parsed = JSON.parse(content.text); if (parsed.operation) return parsed.operation; } catch { /* plain business text */ }
    }
    throw new Error('Missing operation receipt');
  }

  it('reads an explicit historical alias after switching episodes without creating another task or resetting counters', async () => {
    const projects = [
      { id: 'receipt-owner', name: 'owner', createdAt: 1, updatedAt: 1 },
      { id: 'receipt-episode-a', parentId: 'receipt-owner', name: 'a', createdAt: 1, updatedAt: 1 },
      { id: 'receipt-episode-b', parentId: 'receipt-owner', name: 'b', createdAt: 1, updatedAt: 1 },
    ];
    useAppStore.setState({ currentProjectId: 'receipt-episode-a', projects });
    const execute = registerDispatchProbe({ id: 'canvas_historical_once', effect: 'canvas_write' });
    const first = await mcpCall('tools_call', { name: 'canvas_historical_once', arguments: { value: 'ok' }, operationKey: 'historical-once' }, 'historical:first');
    const original = operation(first);
    const tasks = structuredClone(useAppStore.getState().agentTasks);
    const conversations = useAppStore.getState().conversations.map((item) => item.id);
    useAppStore.setState({ currentProjectId: 'receipt-episode-b' });
    const result = await mcpCall('mcp_operation_get', { operationKey: 'historical-once', legacyProjectId: 'receipt-episode-a' }, 'historical:query');
    expect(result.isError).toBe(false);
    expect(operation(result)).toMatchObject({ operationId: original.operationId, taskId: original.taskId,
      projectId: 'receipt-episode-a', sequence: original.sequence, retryable: false });
    expect(useAppStore.getState().agentTasks).toEqual(tasks);
    expect(useAppStore.getState().conversations.map((item) => item.id)).toEqual(conversations);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps a known paid effect on its original receipt when context changes before result delivery', async () => {
    project('receipt-paid-original');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn<AgentToolDefinition['execute']>(async () => {
      await gate;
      return { status: 'success', summary: '原付费操作已明确返回', modelContent: 'private-paid-result' };
    });
    registerDispatchProbe({ id: 'media_paid_delivery_context', effect: 'media_generation', execute });
    const pending = mcpCall('tools_call', { name: 'media_paid_delivery_context', arguments: { value: 'ok' }, operationKey: 'known-paid-result' }, 'paid:original');
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      useAppStore.setState({ currentProjectId: 'receipt-paid-other', canvasRevision: 999 });
    } finally { release(); }
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(operation(result)).toMatchObject({ projectId: 'receipt-paid-original', status: 'succeeded', retryable: false });
    expect(operation(result)).not.toHaveProperty('revisionAfter', 999);
    expect(JSON.stringify(result)).not.toContain('private-paid-result');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('executes a keyed write once and returns its durable receipt after the write changed revision', async () => {
    project('receipt-control-once');
    const execute = vi.fn<AgentToolDefinition['execute']>(async () => {
      useAppStore.getState().incrementRevision();
      return { status: 'success' as const, summary: '写入完成', modelContent: '{"privateBusinessMarker":"original-only-result"}' };
    });
    registerDispatchProbe({ id: 'canvas_receipt_once', effect: 'canvas_write', execute });
    const revision = useAppStore.getState().getCurrentRevision();
    const envelope = { name: 'canvas_receipt_once', arguments: { value: 'value-only-in-arguments' },
      operationKey: 'same-intent', expectedProjectId: 'receipt-control-once', expectedRevision: revision };
    const first = await mcpCall('tools_call', envelope, 'receipt-once:first');
    expect(first.isError).toBe(false);
    expect(first.content[0]).toMatchObject({ type: 'text', text: '{"privateBusinessMarker":"original-only-result"}' });
    const receipt = operation(first);
    expect(receipt).toMatchObject({ status: 'succeeded', retryable: false, resultAvailable: false });
    const replay = await mcpCall('tools_call', envelope, 'receipt-once:replay');
    expect(replay.isError).toBe(false);
    expect(operation(replay)).toMatchObject({ operationId: receipt.operationId, taskId: receipt.taskId, status: 'succeeded' });
    expect(JSON.stringify(replay)).not.toContain('original-only-result');
    const operationApi = await import('../../../src/services/mcp/mcpOperationService');
    const staleLookup = vi.spyOn(operationApi, 'readMcpOperation').mockResolvedValueOnce(null);
    try {
      const racedReplay = await mcpCall('tools_call', envelope, 'receipt-once:raced-replay');
      expect(operation(racedReplay)).toMatchObject({ operationId: receipt.operationId, status: 'succeeded' });
    } finally { staleLookup.mockRestore(); }
    expect(execute).toHaveBeenCalledOnce();
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    expect(JSON.stringify(useAppStore.getState().agentTasks)).not.toContain('original-only-result');
    const query = await mcpCall('mcp_operation_get', { operationId: receipt.operationId }, 'receipt-once:query');
    expect(query.isError).toBe(false);
    expect(operation(query).taskId).toBe(receipt.taskId);
    expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('operationKey');
  });

  it('returns a running receipt for a concurrent duplicate without attaching its cancellation to the owner', async () => {
    project('receipt-control-running');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ownerSignal: AbortSignal | undefined;
    const execute = vi.fn<AgentToolDefinition['execute']>(async (context) => {
      ownerSignal = context.signal;
      await gate;
      return { status: 'success' as const, summary: '已完成', modelContent: '{"done":true}' };
    });
    registerDispatchProbe({ id: 'canvas_receipt_running', effect: 'canvas_write', execute });
    const envelope = { name: 'canvas_receipt_running', arguments: { value: 'ok' }, operationKey: 'in-flight-intent' };
    const owner = mcpCall('tools_call', envelope, 'receipt-running:owner');
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const duplicate = await mcpCall('tools_call', envelope, 'receipt-running:duplicate');
      expect(operation(duplicate).status).toBe('running');
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'receipt-running:cancel-duplicate',
        method: 'requests/cancel', params: { requestId: 'receipt-running:duplicate' } });
      expect(ownerSignal?.aborted).toBe(false);
    } finally { release(); await owner; }
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects mismatched arguments and a different active project without executing or exposing the old receipt', async () => {
    project('receipt-control-conflict');
    const execute = registerDispatchProbe({ id: 'canvas_receipt_conflict', effect: 'canvas_write' });
    const envelope = { name: 'canvas_receipt_conflict', arguments: { value: 'first' }, operationKey: 'fixed-intent',
      expectedProjectId: 'receipt-control-conflict' };
    const first = await mcpCall('tools_call', envelope, 'receipt-conflict:first');
    const changed = await mcpCall('tools_call', { ...envelope, arguments: { value: 'changed' } }, 'receipt-conflict:changed');
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain('MCP_OPERATION_KEY_CONFLICT');
    useAppStore.setState({ currentProjectId: 'another-receipt-project' });
    const otherProject = await mcpCall('tools_call', envelope, 'receipt-conflict:other-project');
    expect(otherProject.isError).toBe(true);
    expect(JSON.stringify(otherProject)).toContain('MCP_CONTEXT_CHANGED');
    expect(JSON.stringify(otherProject)).not.toContain(operation(first).operationId);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails closed when its claim cannot persist and does not support keys on read or config tools', async () => {
    project('receipt-control-claim-failure');
    const execute = registerDispatchProbe({ id: 'canvas_receipt_claim_failure', effect: 'canvas_write' });
    const db = await import('../../../src/services/indexedDbService');
    const claim = vi.spyOn(db, 'claimMcpAgentTask').mockRejectedValueOnce(new Error('simulated operation persistence failure'));
    try {
      const failed = await mcpCall('tools_call', { name: 'canvas_receipt_claim_failure', arguments: { value: 'ok' },
        operationKey: 'must-not-start' }, 'receipt-failure:write');
      expect(failed.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(useAppStore.getState().agentTasks).toEqual([]);
    } finally { claim.mockRestore(); }
    const conflictingClaim = vi.spyOn(db, 'claimMcpAgentTask').mockRejectedValueOnce(new Error('MCP_OPERATION_KEY_CONFLICT'));
    try {
      const conflict = await mcpCall('tools_call', { name: 'canvas_receipt_claim_failure', arguments: { value: 'other' },
        operationKey: 'raced-conflict' }, 'receipt-failure:conflict');
      expect(conflict.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"errorCode":"MCP_OPERATION_KEY_CONFLICT"') });
    } finally { conflictingClaim.mockRestore(); }
    registerDispatchProbe({ id: 'receipt_config_probe', effect: 'config_write' });
    for (const name of ['canvas_query', 'receipt_config_probe']) {
      const result = await mcpCall('tools_call', { name, arguments: name === 'canvas_query' ? {} : { value: 'private-input' },
        operationKey: 'not-for-this-effect' }, `receipt-failure:${name}`);
      expect(result.isError).toBe(true);
    }
    expect(useAppStore.getState().agentTasks).toEqual([]);
  });

  it('keeps the key reserved after deleting its task and exposes only a scoped unknown receipt', async () => {
    project('receipt-control-deleted');
    const execute = registerDispatchProbe({ id: 'canvas_receipt_deleted', effect: 'canvas_write' });
    const envelope = { name: 'canvas_receipt_deleted', arguments: { value: 'ok' }, operationKey: 'deleted-task-intent' };
    const first = await mcpCall('tools_call', envelope, 'receipt-deleted:first');
    const prior = operation(first);
    useAppStore.getState().removeAgentTask(prior.taskId);
    const db = await import('../../../src/services/indexedDbService');
    await db.deleteAgentTask(prior.taskId);
    const replay = await mcpCall('tools_call', envelope, 'receipt-deleted:replay');
    expect(operation(replay)).toMatchObject({ status: 'unknown', resultAvailable: false, retryable: false });
    expect(operation(replay).sequence).toBeGreaterThan(prior.sequence);
    expect(execute).toHaveBeenCalledOnce();
    const query = await mcpCall('mcp_operation_get', { operationKey: envelope.operationKey }, 'receipt-deleted:query');
    expect(operation(query).status).toBe('unknown');
  });
});
