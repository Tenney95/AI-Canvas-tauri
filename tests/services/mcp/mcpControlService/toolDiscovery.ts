import { describe, expect, it, vi } from 'vitest';
import { getLocale, setLocale, t } from '../../../../src/i18n';
import { handleMcpBridgeRequest, initMcpControlService, listMcpTools } from '../../../../src/services/mcp/mcpControlService';
import { buildAssistantFunctionTools } from '../../../../src/services/chat/toolRegistry';
import { useAppStore } from '../../../../src/store/useAppStore';
import * as mediaUploads from '../../../../src/services/mediaUploadService';
import type { McpToolCallResult, McpToolCatalogResult } from '../../../../src/types/mcp';
import { resolveAgentApproval } from '../../../../src/services/chat/agentTaskControl';
import { MCP_SETTINGS_CONVERSATION_ID, MCP_SETTINGS_SCOPE_ID } from '../../../../src/services/mcp/mcpSettingsScope';
import * as chatHistory from '../../../../src/services/chat/chatHistoryService';
import * as mcpBridge from '../../../../src/services/mcp/mcpBridgeService';
import { MCP_CATALOG_MAX_BYTES } from '../../../../src/services/mcp/mcpToolCatalog';
import type { DiscoveryFixture } from '../mcpControlService.test';

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

export function registerToolDiscoveryTests({ mcpCall, openDetachedChatWindow, registerDispatchProbe }: DiscoveryFixture) {
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
    const execution = await import('../../../../src/services/chat/agentToolExecution');
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
    const execution = await import('../../../../src/services/chat/agentToolExecution');
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
      expect(openDetachedChatWindow).not.toHaveBeenCalled();
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-choice', method: 'requests/cancel', params: { requestId: 'session:choice' } });
      await pending;
    }
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    expect(useAppStore.getState().agentTasks[0].status).toBe('stopped');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reveals the detached assistant for user_choice through the shared lifecycle', async () => {
    useAppStore.setState({ chatOpen: false, chatPanelDetached: true, chatPanelView: 'list' });
    const execute = registerDispatchProbe({ effect: 'user_choice' });
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, 'session:detached-choice');
    try {
      await vi.waitFor(() => expect(openDetachedChatWindow).toHaveBeenCalledOnce());
      expect(useAppStore.getState()).toMatchObject({
        chatPanelDetached: true, chatPanelView: 'chat', activeConversationId: 'mcp-control-project-mcp',
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-detached-choice', method: 'requests/cancel', params: { requestId: 'session:detached-choice' } });
      await pending;
    }
  });

  it.each(['zh-CN', 'en-US'] as const)('preserves the live detached assistant when the shared focus attempt fails (%s)', async (locale) => {
    const previousLocale = getLocale();
    setLocale(locale);
    openDetachedChatWindow.mockRejectedValueOnce(new Error('focus failed while the original window remains alive'));
    const showToast = vi.fn();
    useAppStore.setState({ chatOpen: false, chatPanelDetached: true, showToast });
    const execute = registerDispatchProbe({ effect: 'user_choice' });
    const requestId = `session:missing-choice:${locale}`;
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, requestId);
    try {
      await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(t('打开独立窗口失败'), 'error'));
      expect(openDetachedChatWindow).toHaveBeenCalledOnce();
      expect(useAppStore.getState()).toMatchObject({ chatPanelDetached: true, chatOpen: true, chatPanelView: 'chat' });
      expect(useAppStore.getState().agentTasks[0]?.status).toBe('waiting_approval');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      setLocale(previousLocale);
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: `cancel-missing-choice:${locale}`, method: 'requests/cancel', params: { requestId } });
      await pending;
    }
  });

  it('does not start the shared detached lifecycle after the user switches projects', async () => {
    useAppStore.setState({ chatPanelDetached: true });
    registerDispatchProbe({ effect: 'user_choice' });
    let switched = false;
    const stopWatching = useAppStore.subscribe((state) => {
      if (switched || !state.chatOpen || state.activeConversationId !== 'mcp-control-project-mcp'
        || !state.agentTasks.some((task) => task.status === 'waiting_approval')) return;
      switched = true;
      useAppStore.setState({ currentProjectId: 'other-project', activeConversationId: 'other-chat', chatOpen: false });
    });
    const pending = mcpCall('mcp_dispatch_probe', { value: 'ok' }, 'session:stale-choice');
    try {
      await vi.waitFor(() => expect(switched).toBe(true));
      await Promise.resolve();
      expect(openDetachedChatWindow).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toMatchObject({ chatOpen: false, activeConversationId: 'other-chat' });
    } finally {
      stopWatching();
      await handleMcpBridgeRequest({ sessionId: 'catalog-session', requestId: 'cancel-stale-choice', method: 'requests/cancel', params: { requestId: 'session:stale-choice' } });
      await pending;
    }
  });

  it('keeps background calls from opening or switching the assistant', async () => {
    useAppStore.setState({ chatOpen: false, chatPanelView: 'tasks', activeConversationId: 'other-chat' });
    registerDispatchProbe({ effect: 'read' });
    expect(await mcpCall('mcp_dispatch_probe', { value: 'ok' })).toMatchObject({ isError: false });
    expect(useAppStore.getState()).toMatchObject({ chatOpen: false, chatPanelView: 'tasks', activeConversationId: 'other-chat' });
    expect(openDetachedChatWindow).not.toHaveBeenCalled();
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
}
