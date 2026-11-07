/**
 * directorTools — 回归测试：director MCP tools。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools,
  prepareAgentToolCall, type AgentToolContext, type AgentToolExecutionResult,
} from '../../../src/services/chat/toolRegistry';
import { evaluateAgentToolPolicy } from '../../../src/services/chat/policyEngine';
import { registerDirectorAgentTools } from '../../../src/services/chat/tools/directorTools';
import {
  cancelDirectorOperation, DirectorOperationError, getDirectorNodeState, getDirectorOperation,
  setDirectorNodeRuntime, startDirectorNodeOperation,
} from '../../../src/services/directorNodeOperationService';
import type { DirectorOperationSnapshot } from '../../../src/types/directorOperation';
import type { McpToolCallResult } from '../../../src/types/mcp';
import { createDefaultPrevisScene } from '../../../src/services/directorPrevisSchema';
import { readVerifiedProjectFile, writeImmutableProjectFile } from '../../../src/services/fs/projectFiles';
import { generateText } from '../../../src/services/ai/generateText';
import { handleMcpBridgeRequest, listMcpTools } from '../../../src/services/mcp/mcpControlService';
import { resetAgentToolsRegistrationForTests } from '../../../src/services/chat/tools';

vi.mock('../../../src/services/directorNodeOperationService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/directorNodeOperationService')>(),
  cancelDirectorOperation: vi.fn(), getDirectorNodeState: vi.fn(), getDirectorOperation: vi.fn(),
  setDirectorNodeRuntime: vi.fn(), startDirectorNodeOperation: vi.fn(),
}));
vi.mock('../../../src/services/ai/generateText', () => ({ generateText: vi.fn() }));
vi.mock('../../../src/services/fs/projectFiles', async (original) => ({
  ...await original<typeof import('../../../src/services/fs/projectFiles')>(),
  readVerifiedProjectFile: vi.fn(), writeImmutableProjectFile: vi.fn(),
}));

const context = (patch: Partial<AgentToolContext> = {}): AgentToolContext => ({
  projectId: 'project-a', conversationId: 'mcp-control-project-a', taskId: 'task-a',
  mode: 'autonomous', baseRevision: 0, signal: new AbortController().signal, ...patch,
});
const snapshot: DirectorOperationSnapshot = {
  operationId: 'operation-1', projectId: 'project-a', nodeId: 'director-1', instanceId: 'instance-1',
  jobId: 'job-1', operation: 'open-editor', sceneSource: 'director-scene', state: 'running', createdAt: 1, updatedAt: 2,
  scene: { sceneId: 'scene-1', revision: 1, sha256: 'a'.repeat(64) },
};
let unregisters: Array<() => void> = [];

beforeEach(() => {
  vi.resetAllMocks();
  resetAgentToolsRegistrationForTests();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-a', projectLoadStatus: 'ready',
    projects: [{ id: 'project-a', name: '项目一', createdAt: 1, updatedAt: 1 }, { id: 'project-b', name: '项目二', createdAt: 1, updatedAt: 1 }] });
  unregisters = registerDirectorAgentTools();
  vi.mocked(startDirectorNodeOperation).mockResolvedValue(snapshot);
  vi.mocked(getDirectorOperation).mockReturnValue(snapshot);
  vi.mocked(cancelDirectorOperation).mockReturnValue({ ...snapshot, state: 'cancelling' });
  vi.mocked(writeImmutableProjectFile).mockImplementation(async ({ reference }) => ({ ...reference, created: true }));
});
afterEach(() => {
  resetAgentToolsRegistrationForTests();
  unregisters.forEach((unregister) => unregister()); clearAgentToolRegistryForTests();
});

describe('director MCP tools', () => {
  it('discovers Blender and previs tools without a persisted task and excludes the ordinary assistant', () => {
    const ids = getAvailableAgentTools(context({ taskId: 'mcp-tool-discovery' })).map((tool) => tool.id);
    expect(ids).toEqual(expect.arrayContaining([
      'director_get_state', 'director_set_runtime', 'director_open_blender', 'director_render_frame',
      'director_render_video', 'director_get_operation', 'director_cancel_operation',
      'director_get_previs_schema', 'director_get_previs_scene', 'director_set_previs_scene',
    ]));
    expect(ids).toHaveLength(10);
    expect(useAppStore.getState().agentTasks).toHaveLength(0);
    expect(getAvailableAgentTools(context({ conversationId: 'normal-chat' }))).toHaveLength(0);
    expect(getAvailableAgentTools(context({ conversationId: 'mcp-control-wrong-project' }))).toHaveLength(0);
  });

  it.each(['python', 'code', 'path', 'executable', 'argv', 'outputDir'])('rejects extra %s input locally', (key) => {
    const result = prepareAgentToolCall({ callId: 'call-1', toolId: 'director_open_blender',
      input: { nodeId: 'director-1', [key]: 'untrusted' } }, context());
    expect(result.ok).toBe(false);
    expect(startDirectorNodeOperation).not.toHaveBeenCalled();
  });

  it('preserves Plan, B and C policy behavior for the actual write and media effects', () => {
    for (const id of ['director_set_runtime', 'director_open_blender', 'director_render_frame', 'director_render_video', 'director_cancel_operation', 'director_set_previs_scene']) {
      const tool = getAgentTool(id)!;
      expect(evaluateAgentToolPolicy(tool, { nodeId: 'director-1' }, context({ mode: 'plan' })).outcome).toBe('deny');
      expect(evaluateAgentToolPolicy(tool, { nodeId: 'director-1' }, context({ mode: 'collaborative' })).outcome).toBe('require_approval');
      expect(evaluateAgentToolPolicy(tool, { nodeId: 'director-1' }, context()).outcome).toBe('allow');
    }
    expect(getAgentTool('director_open_blender')!.effect).toBe('file_write');
    expect(getAgentTool('director_render_video')!.effect).toBe('media_generation');
    expect(getAvailableAgentTools(context({ mode: 'plan' })).map((tool) => tool.id))
      .toEqual(['director_get_state', 'director_get_previs_schema', 'director_get_previs_scene', 'director_get_operation']);
  });

  it('returns an accepted operation immediately and passes ownership, revision and cancellation context', async () => {
    const ctx = context();
    const result = await getAgentTool('director_open_blender')!.execute(ctx, { nodeId: 'director-1' });
    expect(result.status).toBe('success');
    expect(result.summary).toContain('已受理');
    expect(JSON.parse(result.modelContent).operation).toEqual(snapshot);
    expect(startDirectorNodeOperation).toHaveBeenCalledWith(
      { nodeId: 'director-1', operation: 'open-editor', frame: undefined, sceneSource: undefined },
      { source: 'mcp', projectId: 'project-a', conversationId: 'mcp-control-project-a', taskId: 'task-a' },
      { baseRevision: 0, signal: ctx.signal },
    );
  });

  it('passes the requested frame and rejects fractions or render options outside the fixed schema', async () => {
    const tool = getAgentTool('director_render_frame')!;
    await tool.execute(context(), { nodeId: 'director-1', frame: 24 });
    expect(vi.mocked(startDirectorNodeOperation).mock.calls[0][0]).toMatchObject({ operation: 'render-frame', frame: 24 });
    for (const input of [{ nodeId: 'director-1', frame: 1.5 }, { nodeId: 'director-1', frame: -1 }, { nodeId: 'director-1', frame: 10_000_001 }, { nodeId: 'director-1', script: 'untrusted' }]) {
      expect((await tool.execute(context(), input)).errorCode).toBe('DIRECTOR_INVALID_INPUT');
    }
    expect(startDirectorNodeOperation).toHaveBeenCalledOnce();
  });

  it.each(['director_open_blender', 'director_render_frame', 'director_render_video'])('passes only supported scene sources for %s', async (id) => {
    const tool = getAgentTool(id)!;
    for (const sceneSource of ['saved-blender', 'director-scene']) {
      expect((await tool.execute(context(), { nodeId: 'director-1', sceneSource })).status).toBe('success');
      expect(vi.mocked(startDirectorNodeOperation).mock.lastCall?.[0]).toMatchObject({ sceneSource });
    }
    expect((await tool.execute(context(), { nodeId: 'director-1', sceneSource: 'custom-python' })).errorCode).toBe('DIRECTOR_INVALID_INPUT');
    expect(startDirectorNodeOperation).toHaveBeenCalledTimes(2);
  });

  it('supports frame zero and a saved-scene current-frame request', async () => {
    const tool = getAgentTool('director_render_frame')!;
    await tool.execute(context(), { nodeId: 'director-1', sceneSource: 'saved-blender', frame: 0 });
    await tool.execute(context(), { nodeId: 'director-1', sceneSource: 'saved-blender' });
    expect(vi.mocked(startDirectorNodeOperation).mock.calls.map(([input]) => input.frame)).toEqual([0, undefined]);
  });

  it('reads and cancels an existing operation through the shared service without re-running generation', async () => {
    const read = await getAgentTool('director_get_operation')!.execute(context({ taskId: 'query-2' }), { operationId: 'operation-1' });
    expect(JSON.parse(read.modelContent).operation.state).toBe('running');
    const cancelled = await getAgentTool('director_cancel_operation')!.execute(context(), { operationId: 'operation-1' });
    expect(JSON.parse(cancelled.modelContent).operation.state).toBe('cancelling');
    expect(cancelDirectorOperation).toHaveBeenCalledOnce();
    expect(startDirectorNodeOperation).not.toHaveBeenCalled();
  });

  it('updates runtime through the shared Store operation and reads through the shared state service', async () => {
    const runtime = await getAgentTool('director_set_runtime')!.execute(context(), { nodeId: 'director-1', runtimeKind: 'blender' });
    expect(runtime.status).toBe('success');
    expect(setDirectorNodeRuntime).toHaveBeenCalledWith('director-1', 'blender', expect.objectContaining({ source: 'mcp' }), 0);
    await getAgentTool('director_get_state')!.execute(context(), { nodeId: 'director-1' });
    expect(getDirectorNodeState).toHaveBeenCalledWith('director-1', expect.objectContaining({ projectId: 'project-a' }));
  });

  it.each(['project', 'revision', 'conversation', 'abort'] as const)('rejects changed %s context before shared service invocation', async (changed) => {
    const ctx = context();
    if (changed === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
    if (changed === 'revision') useAppStore.getState().incrementRevision();
    if (changed === 'conversation') ctx.conversationId = 'normal-chat';
    if (changed === 'abort') ctx.signal = AbortSignal.abort();
    expect((await getAgentTool('director_open_blender')!.execute(ctx, { nodeId: 'director-1' })).status).toBe('error');
    expect(startDirectorNodeOperation).not.toHaveBeenCalled();
  });

  it('returns setup-required without enabling a hidden installation dialog or retry', async () => {
    vi.mocked(startDirectorNodeOperation).mockRejectedValue(new DirectorOperationError('DIRECTOR_SETUP_REQUIRED'));
    const result = await getAgentTool('director_open_blender')!.execute(context(), { nodeId: 'director-1' });
    expect(result).toMatchObject({ errorCode: 'DIRECTOR_SETUP_REQUIRED', retryable: false });
    expect(vi.mocked(startDirectorNodeOperation).mock.calls[0][2]).not.toHaveProperty('allowSetup');
  });

  it('keeps native paths and secrets out of tool errors', async () => {
    vi.mocked(startDirectorNodeOperation).mockRejectedValue(new Error('C:\\private\\secrets token=private-value'));
    const result = await getAgentTool('director_open_blender')!.execute(context(), { nodeId: 'director-1' });
    expect(result).toMatchObject({ status: 'error', errorCode: 'DIRECTOR_OPERATION_FAILED', retryable: false });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|token=|C:/);
  });
});

const previsNodeId = 'director-previs';
function previsResultData(result: AgentToolExecutionResult) {
  const content = result.mcpContent?.[0];
  return JSON.parse(content?.type === 'text' ? content.text : result.modelContent);
}
const previsData = () => useAppStore.getState().nodes.find((node) => node.id === previsNodeId)!.data;
const freshContext = () => context({ baseRevision: useAppStore.getState().getCurrentRevision() });
const writePrevis = (scene = createDefaultPrevisScene(), ctx = freshContext()) =>
  getAgentTool('director_set_previs_scene')!.execute(ctx, { nodeId: previsNodeId, sceneJson: JSON.stringify(scene) });

describe('Three.js previs MCP tools', () => {
  beforeEach(() => {
    useAppStore.setState({ nodes: [{ id: previsNodeId, type: 'ai-director', position: { x: 0, y: 0 },
      data: { type: 'ai-director', label: '导演台', directorRuntimeKind: 'ai-threejs', directorInstanceId: 'instance-previs' } }] });
  });

  it('returns a full generation example and a usable create/switch/write workflow without calling a model', async () => {
    const result = await getAgentTool('director_get_previs_schema')!.execute(context(), {});
    const contract = JSON.parse(result.modelContent);
    expect(result.status).toBe('success');
    expect(contract).toMatchObject({ runtimeKind: 'ai-threejs', schemaVersion: 1, maxBytes: 512 * 1024 });
    expect(contract.instructions).toContain(JSON.stringify(createDefaultPrevisScene()));
    expect(contract.steps.join(' ')).toMatch(/canvas_create_nodes.*director_set_runtime.*director_set_previs_scene/);
    expect(generateText).not.toHaveBeenCalled();
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
  });

  it('reports an unsaved scene as null and does not load the UI example as persisted data', async () => {
    const result = await getAgentTool('director_get_previs_scene')!.execute(context(), { nodeId: previsNodeId });
    expect(result.status).toBe('success');
    expect(previsResultData(result).scene).toBeNull();
    expect(readVerifiedProjectFile).not.toHaveBeenCalled();
  });

  it('persists externally generated data with history, reads the saved contract, and supports undo/redo', async () => {
    const scene = { ...createDefaultPrevisScene(), title: 'MCP 电影跟拍' };
    const result = await writePrevis(scene);
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toMatchObject({ nodeId: previsNodeId, title: scene.title, duration: 8, objectCount: 3 });
    const write = vi.mocked(writeImmutableProjectFile).mock.calls[0][0];
    expect(write.projectId).toBe('project-a');
    expect(JSON.parse(new TextDecoder().decode(write.data))).toEqual(scene);
    expect(previsData().directorPrevisScene).toEqual({ kind: 'project-file', ...write.reference });
    expect(useAppStore.getState().history).toHaveLength(1);
    vi.mocked(readVerifiedProjectFile).mockResolvedValue(write.data);
    const read = await getAgentTool('director_get_previs_scene')!.execute(freshContext(), { nodeId: previsNodeId });
    expect(previsResultData(read).scene).toEqual(scene);
    expect(readVerifiedProjectFile).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-a', reference: write.reference }));
    expect(await useAppStore.getState().undo()).toBe(true);
    expect(previsData().directorPrevisScene).toBeUndefined();
    expect(await useAppStore.getState().redo()).toBe(true);
    expect(previsData().directorPrevisScene).toEqual({ kind: 'project-file', ...write.reference });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON, external code/assets, broken camera timing and oversized UTF-8 before writing', async () => {
    const scene = createDefaultPrevisScene();
    const invalid = [
      'new THREE.Scene()', JSON.stringify({ ...scene, script: 'untrusted' }),
      JSON.stringify({ ...scene, objects: [{ ...scene.objects[0], url: 'https://example.com/model.glb' }] }),
      JSON.stringify({ ...scene, camera: { keyframes: [scene.camera.keyframes[0], scene.camera.keyframes[0]] } }),
      JSON.stringify({ ...scene, duration: 61 }), '中'.repeat(175000),
    ];
    for (const sceneJson of invalid) {
      const result = await getAgentTool('director_set_previs_scene')!.execute(context(), { nodeId: previsNodeId, sceneJson });
      expect(result).toMatchObject({ status: 'error', errorCode: 'DIRECTOR_INVALID_INPUT', retryable: false });
      expect(result.summary).toContain('director_get_previs_schema');
    }
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
    expect(previsData().directorPrevisScene).toBeUndefined();
    expect(useAppStore.getState().history).toHaveLength(0);
  });

  it('requires an actual director node and reports the correct previs runtime rather than Blender', async () => {
    const tool = getAgentTool('director_set_previs_scene')!;
    expect((await tool.execute(context(), { nodeId: 'missing', sceneJson: '{}' })).errorCode).toBe('DIRECTOR_NOT_FOUND');
    useAppStore.getState().updateNodeDataTransient(previsNodeId, { directorRuntimeKind: 'blender' });
    const result = await writePrevis();
    expect(result).toMatchObject({ status: 'error', errorCode: 'DIRECTOR_RUNTIME_REQUIRED' });
    expect(result.summary).toContain('ai-threejs');
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
  });

  it.each(['project', 'revision', 'conversation', 'abort'] as const)('rejects changed %s context before saving', async (changed) => {
    const ctx = context();
    if (changed === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
    if (changed === 'revision') useAppStore.getState().incrementRevision();
    if (changed === 'conversation') ctx.conversationId = 'normal-chat';
    if (changed === 'abort') { const controller = new AbortController(); controller.abort(); ctx.signal = controller.signal; }
    const result = await writePrevis(createDefaultPrevisScene(), ctx);
    expect(result.errorCode).toBe(changed === 'abort' ? 'DIRECTOR_CANCELLED' : 'DIRECTOR_CONTEXT_CHANGED');
    expect(writeImmutableProjectFile).not.toHaveBeenCalled();
  });

  it.each(['project', 'revision', 'runtime', 'instance', 'removed', 'reference', 'cancel'] as const)(
    'does not publish a reference after %s changes during a disk write', async (changed) => {
      const controller = new AbortController();
      vi.mocked(writeImmutableProjectFile).mockImplementation(async ({ reference }) => {
        const state = useAppStore.getState();
        if (changed === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
        if (changed === 'revision') state.incrementRevision();
        if (changed === 'runtime') state.updateNodeDataTransient(previsNodeId, { directorRuntimeKind: 'blender' });
        if (changed === 'instance') state.updateNodeDataTransient(previsNodeId, { directorInstanceId: 'replacement' });
        if (changed === 'removed') useAppStore.setState({ nodes: [] });
        if (changed === 'reference') state.updateNodeDataTransient(previsNodeId, { directorPrevisScene: {
          kind: 'project-file', sha256: 'b'.repeat(64), relativePath: `director/previs/${'b'.repeat(64)}.json`, bytes: 100,
        } });
        if (changed === 'cancel') controller.abort();
        return { ...reference, created: true };
      });
      const result = await writePrevis(createDefaultPrevisScene(), context({ signal: controller.signal }));
      expect(result).toMatchObject({ status: 'error', retryable: false,
        errorCode: changed === 'cancel' ? 'DIRECTOR_CANCELLED' : 'DIRECTOR_CONTEXT_CHANGED' });
      const data = useAppStore.getState().nodes.find((node) => node.id === previsNodeId)?.data;
      expect(data?.directorPrevisScene?.sha256).toBe(changed === 'reference' ? 'b'.repeat(64) : undefined);
      expect(useAppStore.getState().history).toHaveLength(0);
    },
  );

  it('keeps the previous scene after storage failure and hides private diagnostics', async () => {
    await writePrevis();
    const previous = previsData().directorPrevisScene;
    vi.mocked(writeImmutableProjectFile).mockRejectedValue(new Error('C:\\private\\secrets token=private-value'));
    const result = await writePrevis({ ...createDefaultPrevisScene(), title: '新场景' });
    expect(result).toMatchObject({ status: 'error', errorCode: 'DIRECTOR_OPERATION_FAILED', retryable: false });
    expect(result.summary).toContain('上一场景保留');
    expect(JSON.stringify(result)).not.toMatch(/private|secret|token=|Blender/);
    expect(previsData().directorPrevisScene).toEqual(previous);
  });

  it.each(['project', 'scene', 'instance'] as const)('rejects a late scene read after %s changes', async (changed) => {
    await writePrevis();
    const bytes = vi.mocked(writeImmutableProjectFile).mock.calls[0][0].data;
    vi.mocked(readVerifiedProjectFile).mockImplementation(async () => {
      if (changed === 'project') useAppStore.setState({ currentProjectId: 'project-b' });
      if (changed === 'scene') useAppStore.getState().updateNodeDataTransient(previsNodeId, { directorPrevisScene: undefined });
      if (changed === 'instance') useAppStore.getState().updateNodeDataTransient(previsNodeId, { directorInstanceId: 'replacement' });
      return bytes;
    });
    const read = await getAgentTool('director_get_previs_scene')!.execute(freshContext(), { nodeId: previsNodeId });
    expect(read.errorCode).toBe('DIRECTOR_CONTEXT_CHANGED');
    expect(read.modelContent).not.toContain('走廊跟拍预演');
  });

  it('discovers, creates, switches, writes and reads via the real MCP dispatcher without app model calls or approvals', async () => {
    unregisters.forEach((unregister) => unregister()); unregisters = [];
    useAppStore.setState({ nodes: [] });
    const actual = await vi.importActual<typeof import('../../../src/services/directorNodeOperationService')>(
      '../../../src/services/directorNodeOperationService');
    vi.mocked(setDirectorNodeRuntime).mockImplementation(actual.setDirectorNodeRuntime);
    const tools = await listMcpTools('full');
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'director_get_previs_schema', 'director_get_previs_scene', 'director_set_previs_scene',
    ]));
    const call = async (name: string, args: unknown) => {
      const result = await handleMcpBridgeRequest({ sessionId: 'previs-session', requestId: `previs-${name}`,
        method: 'tools/call', params: { name, arguments: args } }) as McpToolCallResult;
      expect(result.isError).toBe(false);
      const content = result.content[0];
      if (content.type !== 'text') throw new Error('Expected MCP text result');
      return JSON.parse(content.text);
    };
    const search = await call('tools_search', { query: 'threejs', detail: 'schema' });
    expect(search.tools.map((tool: { name: string }) => tool.name)).toContain('director_set_previs_scene');
    const contract = await call('director_get_previs_schema', {});
    expect(contract.instructions).toContain(JSON.stringify(createDefaultPrevisScene()));
    const created = await call('canvas_create_nodes', { nodes: [{ type: 'ai-director', label: 'MCP 镜头预演' }] });
    const nodeId = useAppStore.getState().nodes[0].id;
    expect(JSON.stringify(created)).toContain(nodeId);
    await call('director_set_runtime', { nodeId, runtimeKind: 'ai-threejs' });
    const example = createDefaultPrevisScene();
    const scene = { ...example, title: 'external-scene-marker-for-audit', objects: Array.from({ length: 128 }, (_, index) => ({
      ...example.objects[0], id: `prop-${index}`, name: 'space-model-detail'.repeat(5),
    })) };
    expect(JSON.stringify(scene).length).toBeGreaterThan(20_000);
    await call('director_set_previs_scene', { nodeId, sceneJson: JSON.stringify(scene) });
    const bytes = vi.mocked(writeImmutableProjectFile).mock.calls[0][0].data;
    vi.mocked(readVerifiedProjectFile).mockResolvedValue(bytes);
    const read = await call('director_get_previs_scene', { nodeId });
    expect(read.scene).toEqual(scene);
    const state = useAppStore.getState();
    expect(state.nodes[0].data.directorRuntimeKind).toBe('ai-threejs');
    expect(state.nodes[0].data.directorPrevisScene).toMatchObject({ kind: 'project-file' });
    expect(state.agentTasks.every((task) => task.status === 'completed')).toBe(true);
    expect(state.agentTasks.flatMap((task) => task.steps).some((step) => step.approval)).toBe(false);
    expect(JSON.stringify([state.messages, state.agentTasks])).not.toContain(scene.title);
    expect(generateText).not.toHaveBeenCalled();
  });
});
