/**
 * aiAppTools — 回归测试：AI application Agent and MCP tools。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import type { AgentMode, AgentTask } from '../../../src/types/agent';
import type { AiAppDefinition, AiAppReference } from '../../../src/types/aiApp';
import {
  clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools, prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { evaluateAgentToolPolicy } from '../../../src/services/chat/policyEngine';
import { registerAiAppAgentTools } from '../../../src/services/chat/tools/aiAppTools';
import { resetAgentToolsRegistrationForTests } from '../../../src/services/chat/tools';
import { executeRegisteredAgentToolCall } from '../../../src/services/chat/agentToolExecution';
import { transitionAgentTask } from '../../../src/services/chat/agentTaskControl';
import {
  createAiAppNode, describeAiApp, getAiAppNode, loadAiAppDefinition, saveAiAppState, updateAiAppNode,
} from '../../../src/services/aiApps/aiAppService';
import { runAiAppAction } from '../../../src/services/aiApps/aiAppRuntime';
import { listMcpTools } from '../../../src/services/mcp/mcpControlService';
import { describeMcpToolCatalog, searchMcpToolCatalog } from '../../../src/services/mcp/mcpToolCatalog';

vi.mock('../../../src/services/aiApps/aiAppService', async (original) => ({
  ...await original<typeof import('../../../src/services/aiApps/aiAppService')>(),
  createAiAppNode: vi.fn(), describeAiApp: vi.fn(), getAiAppNode: vi.fn(),
  loadAiAppDefinition: vi.fn(), saveAiAppState: vi.fn(), updateAiAppNode: vi.fn(),
}));
vi.mock('../../../src/services/aiApps/aiAppRuntime', () => ({ runAiAppAction: vi.fn(), validateAiAppCandidate: vi.fn() }));

const definition: AiAppDefinition = {
  version: 1, title: '素材检查台', description: '检查绑定素材', html: '<button id="scan">检查</button>', css: '',
  code: 'app.registerAction("scan", (input, app) => ({ count: app.inputs.length }));',
  actions: [{ id: 'scan', title: '检查', inputSchema: { type: 'object', additionalProperties: false } }],
};
const app: AiAppReference = {
  version: 1, instanceId: 'app-1', title: definition.title, description: definition.description,
  definition: { relativePath: `ai-apps/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), bytes: 500 },
  revision: 7, actions: definition.actions, inputNodeIds: ['input-1'], savedState: { keyword: '已保存' }, savedResult: { count: 2 },
};
const effects = {
  canvas_app_get_sdk: 'read', canvas_app_create: 'canvas_write', canvas_app_get: 'read',
  canvas_app_update: 'canvas_write', canvas_app_run: 'read', canvas_app_save_state: 'canvas_write',
} as const;
type ToolId = keyof typeof effects;
const inputs: Record<ToolId, Record<string, unknown>> = {
  canvas_app_get_sdk: {}, canvas_app_create: { definition, inputNodeIds: ['input-1'], initialStateJson: '{"keyword":"初始"}' },
  canvas_app_get: { nodeId: 'app-1' }, canvas_app_update: { nodeId: 'app-1', expectedRevision: 7, definition },
  canvas_app_run: { nodeId: 'app-1', actionId: 'scan', input: {} },
  canvas_app_save_state: { nodeId: 'app-1', expectedRevision: 7, stateJson: '{"keyword":"新的"}', resultJson: '{"count":3}' },
};
const context = (patch: Partial<AgentToolContext> = {}): AgentToolContext => ({
  taskId: 'task-1', projectId: 'project-a', conversationId: 'normal-chat', mode: 'autonomous',
  baseRevision: useAppStore.getState().getCurrentRevision(), signal: new AbortController().signal, ...patch,
});
let unregisters: Array<() => void> = [];

beforeEach(() => {
  vi.resetAllMocks();
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-a', projectLoadStatus: 'ready',
    projects: [{ id: 'project-a', name: '测试项目', createdAt: 1, updatedAt: 1 }] });
  unregisters = registerAiAppAgentTools();
  vi.mocked(createAiAppNode).mockResolvedValue('app-1');
  vi.mocked(getAiAppNode).mockImplementation(() => ({
    node: { id: 'app-1', type: 'ai-app', position: { x: 0, y: 0 }, data: { type: 'ai-app', label: app.title, aiApp: structuredClone(app) } },
    app: structuredClone(app), projectId: 'project-a',
  }));
  vi.mocked(describeAiApp).mockImplementation(() => ({
    nodeId: 'app-1', title: app.title, description: app.description, revision: app.revision,
    actions: app.actions, inputNodeIds: app.inputNodeIds, savedState: app.savedState, savedResult: app.savedResult ?? null,
  }));
  vi.mocked(loadAiAppDefinition).mockResolvedValue(definition);
  vi.mocked(updateAiAppNode).mockResolvedValue(undefined);
  vi.mocked(runAiAppAction).mockResolvedValue({ count: 3 });
});

afterEach(() => {
  unregisters.forEach((unregister) => unregister());
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
});

describe('AI application Agent and MCP tools', () => {
  it('registers six tools with accurate effects and exposes them without task-dependent availability', () => {
    const ctx = context({ taskId: 'mcp-tool-discovery', conversationId: 'mcp-control-project-a' });
    const tools = getAvailableAgentTools(ctx);
    expect(tools).toHaveLength(6);
    expect(Object.fromEntries(tools.map((tool) => [tool.id, tool.effect]))).toEqual(effects);
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    const first = searchMcpToolCatalog(ctx, { query: 'canvas_app_', limit: 3, detail: 'schema' });
    expect(first.hasMore).toBe(true);
    const second = searchMcpToolCatalog(ctx, { query: 'canvas_app_', limit: 3, offset: first.nextOffset, detail: 'schema' });
    expect([...first.tools, ...second.tools].map((tool) => tool.name).sort()).toEqual(Object.keys(effects).sort());
    expect(describeMcpToolCatalog(ctx, { names: ['canvas_app_create', 'canvas_app_run', 'canvas_app_save_state'] }).tools.map((tool) => tool.effect)).toEqual(['canvas_write', 'read', 'canvas_write']);
    expect(getAvailableAgentTools(context({ toolAllowlist: ['canvas_app_run'] })).map((tool) => tool.id)).toEqual(['canvas_app_run']);
  });

  it('is included by the actual MCP full discovery registration path', async () => {
    unregisters.forEach((unregister) => unregister());
    unregisters = [];
    const discovered = (await listMcpTools('full')).filter((tool) => tool.name.startsWith('canvas_app_'));
    expect(discovered.map((tool) => tool.name).sort()).toEqual(Object.keys(effects).sort());
    expect(discovered.find((tool) => tool.name === 'canvas_app_create')?.inputSchema.required).toContain('definition');
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
  });

  it('keeps Plan, B, C and MCP policy decisions in the existing matrix', () => {
    for (const [id, effect] of Object.entries(effects)) {
      const tool = getAgentTool(id)!;
      expect(evaluateAgentToolPolicy(tool, inputs[id as ToolId], context({ mode: 'plan' })).outcome).toBe(effect === 'read' ? 'allow' : 'deny');
      expect(evaluateAgentToolPolicy(tool, inputs[id as ToolId], context({ mode: 'collaborative' })).outcome).toBe(effect === 'read' ? 'allow' : 'require_approval');
      expect(evaluateAgentToolPolicy(tool, inputs[id as ToolId], context()).outcome).toBe('allow');
      expect(evaluateAgentToolPolicy(tool, inputs[id as ToolId], context({ conversationId: 'mcp-control-project-a' })).outcome).toBe('allow');
    }
    expect(getAvailableAgentTools(context({ mode: 'plan' })).map((tool) => tool.id)).toEqual(['canvas_app_get_sdk', 'canvas_app_get', 'canvas_app_run']);
  });

  it('validates local schemas and rejects attempts to pass execution privileges', () => {
    for (const id of Object.keys(effects) as ToolId[]) {
      expect(prepareAgentToolCall({ callId: 'valid', toolId: id, input: inputs[id] }, context()).ok).toBe(true);
      expect(prepareAgentToolCall({ callId: 'injected', toolId: id, input: { ...inputs[id], policyMode: 'autonomous' } }, context()).ok).toBe(false);
      expect(evaluateAgentToolPolicy(getAgentTool(id)!, inputs[id], context({ projectId: 'wrong-project' })).outcome).toBe('deny');
    }
    expect(prepareAgentToolCall({ callId: 'invalid', toolId: 'canvas_app_update', input: { nodeId: 'app-1', expectedRevision: 0, definition } }, context()).ok).toBe(false);
  });

  it('delegates create, update and explicit save to shared write services with ownership and revision', async () => {
    const ctx = context();
    expect((await getAgentTool('canvas_app_create')!.execute(ctx, inputs.canvas_app_create)).status).toBe('success');
    expect(createAiAppNode).toHaveBeenCalledWith({ definition, inputNodeIds: ['input-1'], state: { keyword: '初始' }, position: { x: 300, y: 300 } }, ctx);
    expect((await getAgentTool('canvas_app_update')!.execute(ctx, inputs.canvas_app_update)).status).toBe('success');
    expect(updateAiAppNode).toHaveBeenCalledWith('app-1', inputs.canvas_app_update, ctx);
    expect((await getAgentTool('canvas_app_save_state')!.execute(ctx, inputs.canvas_app_save_state)).status).toBe('success');
    expect(saveAiAppState).toHaveBeenCalledWith('app-1', { keyword: '新的' }, { count: 3 }, 7, ctx);
    expect(createAiAppNode).toHaveBeenCalledOnce();
    expect(updateAiAppNode).toHaveBeenCalledOnce();
    expect(saveAiAppState).toHaveBeenCalledOnce();
    expect(runAiAppAction).not.toHaveBeenCalled();
  });

  it('does not update an old application revision or an empty update', async () => {
    expect((await getAgentTool('canvas_app_update')!.execute(context(), { ...inputs.canvas_app_update, expectedRevision: 6 })).status).toBe('error');
    expect((await getAgentTool('canvas_app_update')!.execute(context(), { nodeId: 'app-1', expectedRevision: 7 })).status).toBe('error');
    expect(updateAiAppNode).not.toHaveBeenCalled();
  });

  it('keeps SDK, get and run read-only and does not persist temporary results', async () => {
    const before = useAppStore.getState();
    const revisionBefore = before.getCurrentRevision();
    const ctx = context({ mode: 'plan' });
    const sdk = await getAgentTool('canvas_app_get_sdk')!.execute(ctx, {});
    expect(JSON.parse(sdk.modelContent)).toMatchObject({ version: 1, limits: { actionMs: 10_000 } });
    const plain = await getAgentTool('canvas_app_get')!.execute(ctx, inputs.canvas_app_get);
    expect(JSON.parse(plain.modelContent)).not.toHaveProperty('definition');
    expect(loadAiAppDefinition).not.toHaveBeenCalled();
    const detailed = await getAgentTool('canvas_app_get')!.execute(ctx, { nodeId: 'app-1', includeDefinition: true });
    expect(JSON.parse(detailed.modelContent).definition).toEqual(definition);
    const result = await getAgentTool('canvas_app_run')!.execute(ctx, { nodeId: 'app-1', actionId: 'scan' });
    expect(JSON.parse(result.modelContent)).toEqual({ count: 3 });
    expect(runAiAppAction).toHaveBeenCalledWith('app-1', 'scan', {}, ctx);
    expect(createAiAppNode).not.toHaveBeenCalled();
    expect(updateAiAppNode).not.toHaveBeenCalled();
    expect(saveAiAppState).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes).toBe(before.nodes);
    expect(useAppStore.getState().history).toBe(before.history);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revisionBefore);
  });

  it('rechecks the application revision after asynchronous definition loading', async () => {
    const original = vi.mocked(getAiAppNode).getMockImplementation()!;
    vi.mocked(loadAiAppDefinition).mockImplementationOnce(async () => {
      vi.mocked(getAiAppNode).mockImplementation(() => {
        const value = original('app-1');
        return { ...value, app: { ...value.app, revision: 8 } };
      });
      return definition;
    });
    const result = await getAgentTool('canvas_app_get')!.execute(context(), { nodeId: 'app-1', includeDefinition: true });
    expect(result).toMatchObject({ status: 'error', retryable: false });
    expect(result.modelContent).not.toContain('registerAction');
  });

  it.each(['canvas_app_create', 'canvas_app_update', 'canvas_app_save_state', 'canvas_app_run'] as const)(
    'never auto-retries a failure from %s through the real registered tool executor', async (id) => {
      const failure = new Error('/private/local-file token-secret source-code');
      const operation = id === 'canvas_app_create' ? vi.mocked(createAiAppNode)
        : id === 'canvas_app_update' ? vi.mocked(updateAiAppNode)
          : id === 'canvas_app_save_state' ? vi.mocked(saveAiAppState) : vi.mocked(runAiAppAction);
      operation.mockImplementation(() => { throw failure; });
      const task: AgentTask = {
        id: 'task-1', projectId: 'project-a', conversationId: 'mcp-control-project-a', userMessageId: 'message-1',
        mode: 'autonomous', goal: '检查应用工具失败边界', status: 'running', steps: [], modelRounds: 0, toolCallCount: 0,
        budget: { maxModelRounds: 1, maxToolCalls: 6, maxParallelReadTools: 1, maxReadRetries: 3 }, createdAt: 1, updatedAt: 1,
      };
      useAppStore.setState({ agentTasks: [task] });
      const wait = vi.fn(async () => ({ approved: true }));
      const result = await executeRegisteredAgentToolCall({
        taskId: task.id, call: { callId: 'failure-call', toolId: id, input: inputs[id] },
        signal: new AbortController().signal, transitionTask: transitionAgentTask, waitForApproval: wait,
        policyMode: 'autonomous' satisfies AgentMode,
      });
      expect(result.summary.status).toBe('error');
      expect(operation).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      expect(useAppStore.getState().agentTasks[0].steps[0].toolCall?.retryCount).toBe(0);
      expect(result.modelContent).not.toContain('/private/');
      expect(result.modelContent).not.toContain('token-secret');
      expect(result.modelContent).not.toContain('source-code');
    },
  );
});
