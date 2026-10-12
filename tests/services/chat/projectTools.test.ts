import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProjectAgentTools } from '../../../src/services/chat/tools/projectTools';
import {
  clearAgentToolRegistryForTests,
  getAvailableAgentTools,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { useAppStore } from '../../../src/store/useAppStore';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import {
  MCP_GLOBAL_TOOL_NAMES,
  MCP_SETTINGS_CONVERSATION_ID,
  MCP_SETTINGS_SCOPE_ID,
} from '../../../src/services/mcp/mcpSettingsScope';

function context(): AgentToolContext {
  return {
    taskId: 'task-project-tools',
    projectId: 'project-1',
    conversationId: 'mcp-control-project-1',
    mode: 'autonomous',
    baseRevision: 3,
    signal: new AbortController().signal,
  };
}

let unregisters: Array<() => void> = [];

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projectLoadStatus: 'ready',
    projects: [{
      id: 'project-1',
      name: '主项目',
      createdAt: 1,
      updatedAt: 2,
      dataFolder: 'private-folder',
      snapshot: 'data:image/png;base64,private',
      settings: {
        visualStyle: {
          styleId: 'cinematic',
          styleName: '电影感',
          prompt: 'cinematic light',
          locked: true,
          styleReference: {
            filePath: 'C:\\private\\style.png',
            imageUrl: 'asset://private-style',
            fileName: 'style.png',
          },
        },
        promptSuffixes: { image: '保持角色一致' },
      },
    }, {
      id: 'episode-1',
      name: '第 1 集',
      createdAt: 3,
      updatedAt: 4,
      parentId: 'project-1',
      episodeNo: 1,
      episodeOutline: '不可在项目列表中泄露的正文',
    }],
  });
  unregisters = registerProjectAgentTools();
});

afterEach(() => {
  unregisters.forEach((unregister) => unregister());
  clearAgentToolRegistryForTests();
});

describe('project tools registration', () => {
  it('registers all project operations with accurate effects and closed schemas', () => {
    const expected = {
      project_list: 'read',
      project_get: 'read',
      project_create: 'canvas_write',
      project_rename: 'canvas_write',
      project_open: 'canvas_write',
      project_switch: 'canvas_write',
      project_update_settings: 'config_write',
      project_save: 'file_write',
      project_delete: 'permanent_delete',
    } as const;

    for (const [id, effect] of Object.entries(expected)) {
      const definition = getAgentTool(id);
      expect(definition?.effect).toBe(effect);
      expect(definition?.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('exposes project management only to the dedicated MCP conversation', () => {
    const internalTools = getAvailableAgentTools({
      ...context(),
      conversationId: 'conversation-1',
    });
    const mcpTools = getAvailableAgentTools({
      ...context(),
      conversationId: 'mcp-control-project-1',
    });

    expect(internalTools.some((tool) => tool.id === 'project_switch')).toBe(false);
    expect(internalTools.some((tool) => tool.id === 'project_delete')).toBe(false);
    expect(mcpTools.some((tool) => tool.id === 'project_switch')).toBe(true);
    expect(mcpTools.some((tool) => tool.id === 'project_delete')).toBe(true);
  });

  it('rejects local style-reference paths and arbitrary project setting fields', () => {
    const schema = getAgentTool('project_update_settings')!.inputSchema;

    expect(validateAgentToolInput(schema, {
      settings: {
        visualStyle: {
          styleReference: { filePath: 'C:\\private\\style.png' },
        },
      },
    })).toMatchObject({ valid: false });
    expect(validateAgentToolInput(schema, {
      settings: { unknownSetting: true },
    })).toMatchObject({ valid: false });
  });

  it('allows only closed global navigation tools without an active project', () => {
    useAppStore.setState({ currentProjectId: null });
    const global = { ...context(), projectId: MCP_SETTINGS_SCOPE_ID,
      conversationId: MCP_SETTINGS_CONVERSATION_ID, toolAllowlist: [...MCP_GLOBAL_TOOL_NAMES] };
    for (const id of ['project_list', 'project_get', 'project_open', 'project_switch']) {
      expect(getAgentTool(id)!.authorize!(global, { projectId: 'project-1' }).allowed).toBe(true);
      expect(getAgentTool(id)!.authorize!({ ...global, conversationId: 'mcp-control-forged' }, {}).allowed).toBe(false);
      expect(getAgentTool(id)!.authorize!({ ...global, toolAllowlist: [...global.toolAllowlist, 'project_delete'] }, {}).allowed).toBe(false);
    }
    expect(getAvailableAgentTools(global).map((tool) => tool.id)).toEqual([
      'project_list', 'project_get', 'project_open', 'project_switch',
    ]);
    expect(getAgentTool('project_delete')!.authorize!(global, {}).allowed).toBe(false);
  });

  it('returns complete pages and distinguishes startup loading from an empty list', async () => {
    const first = await getAgentTool('project_list')!.execute(context(), { limit: 1 });
    expect(JSON.parse(first.modelContent)).toMatchObject({ total: 2, returned: 1, hasMore: true, nextOffset: 1 });
    const last = await getAgentTool('project_list')!.execute(context(), { limit: 1, offset: 1 });
    expect(JSON.parse(last.modelContent)).toMatchObject({ returned: 1, hasMore: false, projects: [{ id: 'episode-1' }] });
    useAppStore.setState({ currentProjectId: null, projects: [], projectLoadStatus: 'loading' });
    expect(await getAgentTool('project_list')!.execute(context(), {})).toMatchObject({ errorCode: 'PROJECT_LIST_LOADING' });
    useAppStore.setState({ projectLoadStatus: 'error' });
    expect(await getAgentTool('project_list')!.execute(context(), {})).toMatchObject({ errorCode: 'PROJECT_LIST_UNAVAILABLE' });
    useAppStore.setState({ projectLoadStatus: 'ready' });
    expect(JSON.parse((await getAgentTool('project_list')!.execute(context(), {})).modelContent)).toMatchObject({ projects: [], total: 0 });
  });

  it('lists and reads projects without paths, snapshots or asset bodies', async () => {
    const list = await getAgentTool('project_list')!.execute(context(), {});
    const detail = await getAgentTool('project_get')!.execute(context(), {
      projectId: 'project-1',
    });

    expect(list.status).toBe('success');
    expect(JSON.parse(list.modelContent)).toEqual(expect.objectContaining({
      currentProjectId: 'project-1',
      projects: expect.arrayContaining([
        expect.objectContaining({ id: 'project-1', name: '主项目', current: true }),
        expect.objectContaining({ id: 'episode-1', parentId: 'project-1', episodeNo: 1 }),
      ]),
    }));
    expect(detail.status).toBe('success');
    expect(JSON.parse(detail.modelContent)).toMatchObject({
      id: 'project-1',
      settings: {
        visualStyle: {
          styleId: 'cinematic',
          styleName: '电影感',
          prompt: 'cinematic light',
          locked: true,
        },
        promptSuffixes: { image: '保持角色一致' },
      },
    });
    for (const content of [list.modelContent, detail.modelContent]) {
      expect(content).not.toContain('private-folder');
      expect(content).not.toContain('base64');
      expect(content).not.toContain('C:\\private');
      expect(content).not.toContain('asset://private-style');
      expect(content).not.toContain('不可在项目列表中泄露的正文');
    }
  });
});

describe('project write tools', () => {
  it('creates, renames and switches projects through existing Store actions', async () => {
    const createProject = vi.fn(async (name?: string) => {
      const project = { id: 'project-2', name: name ?? '新项目', createdAt: 5, updatedAt: 5 };
      useAppStore.setState((state) => ({ projects: [...state.projects, project] }));
      return project.id;
    });
    const renameProject = vi.fn(async (id: string, name: string) => {
      useAppStore.setState((state) => ({
        projects: state.projects.map((project) => project.id === id
          ? { ...project, name }
          : project),
      }));
      return true;
    });
    const switchProject = vi.fn(async (id: string) => {
      useAppStore.setState({ currentProjectId: id });
      return id;
    });
    useAppStore.setState({ createProject, renameProject, switchProject });

    const created = await getAgentTool('project_create')!.execute(context(), { name: '第二项目' });
    const renamed = await getAgentTool('project_rename')!.execute(context(), {
      projectId: 'project-2',
      name: '重命名项目',
    });
    const switched = await getAgentTool('project_switch')!.execute(context(), {
      projectId: 'project-2',
    });

    expect(created.status).toBe('success');
    expect(renameProject).toHaveBeenCalledWith('project-2', '重命名项目');
    expect(renamed.status).toBe('success');
    expect(switchProject).toHaveBeenCalledWith('project-2', { captureSnapshot: false, signal: expect.any(AbortSignal) });
    expect(switched.status).toBe('success');
    expect(useAppStore.getState().currentProjectId).toBe('project-2');
  });

  it.each(['project_open', 'project_switch'])('opens a series first episode from startup with %s', async (id) => {
    const switchProject = vi.fn(async (target: string) => {
      useAppStore.setState({ currentProjectId: target, projectLoadStatus: 'ready' });
      return target;
    });
    useAppStore.setState({ currentProjectId: null, projectLibraryOpen: true, switchProject });
    const result = await getAgentTool(id)!.execute(context(), { projectId: 'project-1' });
    expect(result.status).toBe('success');
    expect(switchProject).toHaveBeenCalledWith('episode-1', expect.objectContaining({ captureSnapshot: false }));
    expect(JSON.parse(result.modelContent)).toMatchObject({ requestedProjectId: 'project-1', previousProjectId: null,
      currentProjectId: 'episode-1', alreadyOpen: false, project: { id: 'episode-1', parentId: 'project-1' } });
    expect(useAppStore.getState().projectLibraryOpen).toBe(false);
  });

  it('keeps the current episode and unsaved canvas when reopening the current series', async () => {
    const switchProject = vi.fn(async () => undefined);
    useAppStore.setState({ currentProjectId: 'episode-1', switchProject });
    const result = await getAgentTool('project_open')!.execute(context(), { projectId: 'project-1' });
    expect(JSON.parse(result.modelContent)).toMatchObject({ currentProjectId: 'episode-1', alreadyOpen: true });
    expect(switchProject).not.toHaveBeenCalled();
    const list = JSON.parse((await getAgentTool('project_list')!.execute(context(), {})).modelContent);
    expect(list.projects[0]).toMatchObject({ id: 'project-1', current: false, opened: true, openTargetId: 'episode-1' });
  });

  it('reports failed or superseded loads instead of success and leaves the project library open', async () => {
    const switchProject = vi.fn(async () => undefined);
    useAppStore.setState({ currentProjectId: null, switchProject, projectLibraryOpen: true });
    expect(await getAgentTool('project_open')!.execute(context(), { projectId: 'project-1' }))
      .toMatchObject({ status: 'error', errorCode: 'PROJECT_OPEN_FAILED', retryable: false });
    switchProject.mockImplementation(async () => { useAppStore.setState({ currentProjectId: 'another-project' }); return undefined; });
    expect(await getAgentTool('project_switch')!.execute(context(), { projectId: 'project-1' }))
      .toMatchObject({ status: 'error', errorCode: 'PROJECT_OPEN_FAILED' });
    expect(useAppStore.getState().projectLibraryOpen).toBe(true);
  });

  it('rejects missing targets, busy navigation and cancelled requests without switching', async () => {
    const switchProject = vi.fn(async () => undefined);
    useAppStore.setState({ switchProject });
    const open = getAgentTool('project_open')!;
    expect(await open.execute(context(), { projectId: 'missing' })).toMatchObject({ errorCode: 'PROJECT_NOT_FOUND' });
    useAppStore.setState({ switchingProjectName: 'Other project' });
    expect(await open.execute(context(), { projectId: 'project-1' })).toMatchObject({ errorCode: 'PROJECT_NAVIGATION_BUSY' });
    const controller = new AbortController(); controller.abort();
    expect(await open.execute({ ...context(), signal: controller.signal }, { projectId: 'project-1' }))
      .toMatchObject({ errorCode: 'PROJECT_OPEN_CANCELLED' });
    expect(switchProject).not.toHaveBeenCalled();
  });

  it('rejects an all-whitespace project name before calling the Store', async () => {
    const createProject = vi.fn(async () => 'should-not-run');
    useAppStore.setState({ createProject });

    const result = await getAgentTool('project_create')!.execute(context(), { name: '   ' });

    expect(result).toMatchObject({
      status: 'error',
      errorCode: 'PROJECT_NAME_REQUIRED',
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('deep-merges safe project settings and preserves private style reference state', async () => {
    const updateProjectSettings = vi.fn(async () => true);
    useAppStore.setState({ updateProjectSettings });

    const result = await getAgentTool('project_update_settings')!.execute(context(), {
      settings: {
        visualStyle: { locked: false },
        promptSuffixes: { video: '保持镜头运动连贯' },
        defaultModels: { image: 'apimart/gpt-image-2' },
        generation: { imageAspectRatio: '16:9', videoDuration: 8 },
      },
    });

    expect(result.status).toBe('success');
    expect(updateProjectSettings).toHaveBeenCalledWith({
      visualStyle: expect.objectContaining({
        styleId: 'cinematic',
        locked: false,
        styleReference: expect.objectContaining({ filePath: 'C:\\private\\style.png' }),
      }),
      promptSuffixes: {
        image: '保持角色一致',
        video: '保持镜头运动连贯',
      },
      defaultModels: { image: 'apimart/gpt-image-2' },
      generation: { imageAspectRatio: '16:9', videoDuration: 8 },
    });
  });

  it('saves the current project and permanently deletes an existing target', async () => {
    const saveCurrentProject = vi.fn(async () => 'project-1');
    const deleteProject = vi.fn(async (id: string) => {
      useAppStore.setState((state) => ({
        projects: state.projects.filter((project) => project.id !== id),
      }));
    });
    useAppStore.setState({ saveCurrentProject, deleteProject });

    const saved = await getAgentTool('project_save')!.execute(context(), {});
    const deleted = await getAgentTool('project_delete')!.execute(context(), {
      projectId: 'episode-1',
    });

    expect(saved.status).toBe('success');
    expect(saveCurrentProject).toHaveBeenCalledTimes(1);
    expect(deleted.status).toBe('success');
    expect(deleteProject).toHaveBeenCalledWith('episode-1');
    expect(useAppStore.getState().projects.some((project) => project.id === 'episode-1')).toBe(false);
  });
});
