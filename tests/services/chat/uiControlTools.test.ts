import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentToolRegistryForTests,
  getAvailableAgentTools,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { registerUiControlAgentTools } from '../../../src/services/chat/tools/uiControlTools';
import { useAppStore } from '../../../src/store/useAppStore';
import type { InstalledPlugin } from '../../../src/types/plugin';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';

const pluginWindows = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), states: vi.fn(), unavailable: vi.fn() }));
vi.mock('../../../src/services/plugins/pluginUiWindowService', () => ({
  openPluginUiWindow: pluginWindows.open,
  closePluginUiWindow: pluginWindows.close,
  getPluginUiWindowStates: pluginWindows.states,
  pluginUiWindowUnavailableReason: pluginWindows.unavailable,
}));

vi.mock('../../../src/services/mcp/mcpUiRuntimeService', () => ({
  captureAppWindow: vi.fn(async () => ({
    data: 'YWJj',
    mimeType: 'image/jpeg',
    width: 640,
    height: 360,
  })),
  focusAppWindow: vi.fn(async () => undefined),
  getAppWindowState: vi.fn(async (label: string) => ({ label, visible: true })),
  listAppWindows: vi.fn(async () => [{ label: 'main', visible: true }]),
  setAppWindowBounds: vi.fn(async () => undefined),
}));

function context(conversationId = 'mcp-control-project-1'): AgentToolContext {
  return {
    taskId: 'task-ui',
    projectId: 'project-1',
    conversationId,
    mode: 'autonomous',
    baseRevision: 0,
    signal: new AbortController().signal,
  };
}

let unregisters: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  pluginWindows.unavailable.mockReturnValue('尚待隔离验收');
  pluginWindows.open.mockResolvedValue({ sessionId: 'secret-session', identity: { sourceDigest: 'private-digest' } });
  pluginWindows.states.mockReturnValue([]);
  pluginWindows.close.mockResolvedValue({ found: false, revoked: false, closeCommandAccepted: false, pendingOpen: false });
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    projects: [{ id: 'project-1', name: '项目', createdAt: 1, updatedAt: 1 }],
  });
  unregisters = registerUiControlAgentTools();
});

afterEach(() => {
  vi.unstubAllEnvs();
  unregisters.forEach((unregister) => unregister());
  clearAgentToolRegistryForTests();
});

describe('MCP UI control tools', () => {
  it('registers the complete UI, window, viewport and screenshot set as MCP-only', () => {
    const expected = {
      ui_get_layout: 'read',
      ui_get_interaction_state: 'read',
      ui_set_layout: 'config_write',
      plugin_window_get_state: 'read',
      plugin_window_open: 'config_write',
      plugin_window_close: 'config_write',
      window_list: 'read',
      window_get_state: 'read',
      window_focus: 'config_write',
      window_set_bounds: 'config_write',
      canvas_get_viewport: 'read',
      canvas_set_viewport: 'canvas_write',
      canvas_fit_view: 'canvas_write',
      ui_capture_window: 'read',
    } as const;

    for (const [id, effect] of Object.entries(expected)) {
      expect(getAgentTool(id)).toMatchObject({ effect });
      expect(getAgentTool(id)?.inputSchema.additionalProperties).toBe(false);
      expect(getAvailableAgentTools(context('conversation-1')).some((tool) => tool.id === id)).toBe(false);
    }

    expect(getAvailableAgentTools(context('conversation-1')).some((tool) => tool.id === 'ui_get_layout')).toBe(false);
    expect(getAvailableAgentTools(context()).some((tool) => tool.id === 'ui_get_layout')).toBe(true);
  });

  it('reads and changes structured panel layout without exposing pending credential ids', async () => {
    useAppStore.setState({ pendingApiKeyConnectionId: 'private-connection' });
    const changed = await getAgentTool('ui_set_layout')!.execute(context(), {
      panel: 'settings',
      settingsTab: 'mcp',
      minimapVisible: false,
    });
    const read = await getAgentTool('ui_get_layout')!.execute(context(), {});

    expect(changed.status).toBe('success');
    expect(useAppStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsInitialTab: 'mcp',
      minimapVisible: false,
    });
    expect(read.modelContent).not.toContain('private-connection');
    expect(JSON.parse(read.modelContent)).toMatchObject({
      panels: { settings: true },
      settingsTab: 'mcp',
      minimapVisible: false,
    });
  });

  it('returns a transient MCP image without putting base64 in model content', async () => {
    const result = await getAgentTool('ui_capture_window')!.execute(context(), {
      target: 'main',
      maxWidth: 640,
      quality: 0.7,
      redactSensitive: true,
    });

    expect(result.status).toBe('success');
    expect(result.modelContent).not.toContain('YWJj');
    expect(result.mcpContent).toEqual([{ type: 'image', data: 'YWJj', mimeType: 'image/jpeg' }]);
  });
});

const pluginInput = { nodeId: 'video-1', pluginId: 'com.example.review', toolId: 'review' };
const fixturePlugin = (): InstalledPlugin => ({
  id: pluginInput.pluginId, enabled: true, source: 'private-source', sourceDigest: 'a'.repeat(64), revisionDigest: 'b'.repeat(64),
  installedAt: 1, updatedAt: 1,
  manifest: {
    apiVersion: 1, id: pluginInput.pluginId, name: '测试拉片', version: '1.0.0', category: 'utility', runtime: 'javascript',
    entry: 'main.js', permissions: ['ui.custom'],
    ui: { entry: 'ui.js', integrity: `sha256-${'c'.repeat(64)}`, exports: { review: 'ReviewMount' } },
    contributes: { nodeTools: [{ id: 'review', title: '拉片', nodeTypes: ['source-video'], placements: ['node-toolbar'], inputFields: [],
      dialog: { fields: [{ id: 'count', label: '数量', type: 'number', defaultValue: 8 }], ui: 'review', presentation: 'window' },
      output: { mode: 'update-current', fields: [] },
    }] },
  },
});

describe('MCP plugin window tools', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', true);
    useAppStore.setState({ installedPlugins: [fixturePlugin()],
      nodes: [{ id: pluginInput.nodeId, type: 'source-video', position: { x: 0, y: 0 }, data: { type: 'source-video', label: '视频' } }],
    });
    pluginWindows.states.mockReturnValue([{ projectId: 'project-1', ...pluginInput, phase: 'open', contextResponded: false, requestCount: 0, pendingRequests: 0 }]);
  });

  it('opens only the manifest-owned UI alias and returns metadata without the native binding', async () => {
    const result = await getAgentTool('plugin_window_open')!.execute(context(), { ...pluginInput, parameters: { count: 4 } });
    expect(result.status).toBe('success');
    expect(pluginWindows.open).toHaveBeenCalledWith(expect.objectContaining({
      plugin: useAppStore.getState().installedPlugins[0], tool: expect.objectContaining({ id: 'review' }),
      nodeId: 'video-1', exportName: 'review', parameters: { count: 4 }, signal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(result.modelContent)).toMatchObject({ window: { phase: 'open', contextResponded: false } });
    for (const hidden of ['secret-session', 'private-digest', 'private-source', 'parameters']) expect(result.modelContent).not.toContain(hidden);
  });

  it('reads installed window tool metadata without changing state or leaking sources', async () => {
    const result = await getAgentTool('plugin_window_get_state')!.execute(context(), { nodeId: 'video-1' });
    expect(JSON.parse(result.modelContent)).toMatchObject({ userEntryAvailable: false, developmentAcceptance: true,
      tools: [{ pluginId: pluginInput.pluginId, toolId: 'review', enabled: true }], windows: [{ contextResponded: false }],
    });
    expect(result.modelContent).not.toContain('private-source');
    expect(pluginWindows.open).not.toHaveBeenCalled();
    expect(pluginWindows.close).not.toHaveBeenCalled();
  });

  it.each(['plugin_window_open', 'plugin_window_get_state', 'plugin_window_close'])(
    'rechecks MCP origin, project and cancellation when executing %s', async (id) => {
      const tool = getAgentTool(id)!;
      expect(tool.authorize?.(context('conversation-user'), pluginInput)?.allowed).toBe(false);
      expect((await tool.execute(context('conversation-user'), pluginInput)).errorCode).toBe('PLUGIN_WINDOW_CONTEXT_INVALID');
      const cancelled = context();
      cancelled.signal = AbortSignal.abort();
      expect((await tool.execute(cancelled, pluginInput)).errorCode).toBe('PLUGIN_WINDOW_CONTEXT_INVALID');
      useAppStore.setState({ currentProjectId: 'project-2' });
      expect((await tool.execute(context(), pluginInput)).errorCode).toBe('PLUGIN_WINDOW_CONTEXT_INVALID');
      expect(pluginWindows.open).not.toHaveBeenCalled();
      expect(pluginWindows.close).not.toHaveBeenCalled();
    },
  );

  it('keeps an unaccepted production build closed even when the caller supplies a bypass flag', async () => {
    vi.stubEnv('DEV', false);
    expect((await getAgentTool('plugin_window_open')!.execute(context(), { ...pluginInput, developmentAcceptance: true })).errorCode)
      .toBe('PLUGIN_WINDOW_NOT_ACCEPTED');
    expect(pluginWindows.open).not.toHaveBeenCalled();
  });

  it('uses the normal release gate after acceptance without a development override', async () => {
    vi.stubEnv('DEV', false);
    pluginWindows.unavailable.mockReturnValue(null);
    expect((await getAgentTool('plugin_window_open')!.execute(context(), pluginInput)).status).toBe('success');
    expect(pluginWindows.open).toHaveBeenCalledOnce();
  });

  it.each(['source', 'url', 'label', 'sessionId', 'binding', 'exportName', 'invoke', 'developmentAcceptance'])(
    'rejects the undeclared native-control field %s at the Registry schema boundary', (field) => {
      const schema = getAgentTool('plugin_window_open')!.inputSchema;
      expect(validateAgentToolInput(schema, { ...pluginInput, [field]: 'forged' }).valid).toBe(false);
    },
  );

  it('rejects disabled plugins, missing tools, wrong nodes and non-window UI declarations', async () => {
    const open = getAgentTool('plugin_window_open')!;
    expect((await open.execute(context(), { ...pluginInput, pluginId: 'unknown' })).errorCode).toBe('PLUGIN_WINDOW_PLUGIN_UNAVAILABLE');
    expect((await open.execute(context(), { ...pluginInput, toolId: 'unknown' })).errorCode).toBe('PLUGIN_WINDOW_TARGET_INVALID');
    expect((await open.execute(context(), { ...pluginInput, nodeId: 'unknown' })).errorCode).toBe('PLUGIN_WINDOW_TARGET_INVALID');
    const disabled = fixturePlugin();
    disabled.enabled = false;
    useAppStore.setState({ installedPlugins: [disabled] });
    expect((await open.execute(context(), pluginInput)).errorCode).toBe('PLUGIN_WINDOW_PLUGIN_UNAVAILABLE');
    const modal = fixturePlugin();
    modal.manifest.contributes.nodeTools[0].dialog!.presentation = 'modal';
    useAppStore.setState({ installedPlugins: [modal] });
    expect((await open.execute(context(), pluginInput)).errorCode).toBe('PLUGIN_WINDOW_UI_INVALID');
    expect(pluginWindows.open).not.toHaveBeenCalled();
  });

  it.each<{ parameters: unknown }>([
    { parameters: { text: 'x'.repeat(16 * 1024) } },
    { parameters: { list: Array<number>(65).fill(0) } },
    { parameters: { constructor: {} } },
    { parameters: { nested: { value: () => {} } } },
  ])(
    'rejects oversized or non-JSON parameters', async ({ parameters }) => {
      expect((await getAgentTool('plugin_window_open')!.execute(context(), { ...pluginInput, parameters })).errorCode)
        .toBe('PLUGIN_WINDOW_PARAMETERS_INVALID');
      expect(pluginWindows.open).not.toHaveBeenCalled();
    },
  );

  it('does not expose native errors or a stale-project window result', async () => {
    const open = getAgentTool('plugin_window_open')!;
    pluginWindows.open.mockRejectedValueOnce(new Error('sensitive-private-directory'));
    expect((await open.execute(context(), pluginInput)).modelContent).not.toContain('sensitive-private-directory');
    pluginWindows.open.mockImplementationOnce(async () => { useAppStore.setState({ currentProjectId: 'project-2' }); });
    expect((await open.execute(context(), pluginInput)).errorCode).toBe('PLUGIN_WINDOW_CONTEXT_INVALID');
  });

  it('closes by current-project target and does not claim physical closure', async () => {
    pluginWindows.close.mockResolvedValueOnce({ found: true, revoked: true, closeCommandAccepted: false, pendingOpen: false });
    const result = await getAgentTool('plugin_window_close')!.execute(context(), pluginInput);
    expect(pluginWindows.close).toHaveBeenCalledWith('project-1', 'video-1', pluginInput.pluginId, 'review');
    expect(JSON.parse(result.modelContent)).toMatchObject({ revoked: true, closeCommandAccepted: false });
    expect(result.modelContent).not.toContain('sessionId');
  });
});
