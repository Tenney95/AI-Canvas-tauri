import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import {
  clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools,
  prepareAgentToolCall, type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { evaluateAgentToolPolicy } from '../../../src/services/chat/policyEngine';
import { registerDirectorAgentTools } from '../../../src/services/chat/tools/directorTools';
import {
  cancelDirectorOperation, DirectorOperationError, getDirectorNodeState, getDirectorOperation,
  setDirectorNodeRuntime, startDirectorNodeOperation,
} from '../../../src/services/directorNodeOperationService';
import type { DirectorOperationSnapshot } from '../../../src/types/directorOperation';

vi.mock('../../../src/services/directorNodeOperationService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/directorNodeOperationService')>(),
  cancelDirectorOperation: vi.fn(), getDirectorNodeState: vi.fn(), getDirectorOperation: vi.fn(),
  setDirectorNodeRuntime: vi.fn(), startDirectorNodeOperation: vi.fn(),
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
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-a' });
  unregisters = registerDirectorAgentTools();
  vi.mocked(startDirectorNodeOperation).mockResolvedValue(snapshot);
  vi.mocked(getDirectorOperation).mockReturnValue(snapshot);
  vi.mocked(cancelDirectorOperation).mockReturnValue({ ...snapshot, state: 'cancelling' });
});
afterEach(() => { unregisters.forEach((unregister) => unregister()); clearAgentToolRegistryForTests(); });

describe('director MCP tools', () => {
  it('discovers all seven tools without a persisted task and excludes the ordinary assistant', () => {
    const ids = getAvailableAgentTools(context({ taskId: 'mcp-tool-discovery' })).map((tool) => tool.id);
    expect(ids).toEqual(expect.arrayContaining([
      'director_get_state', 'director_set_runtime', 'director_open_blender', 'director_render_frame',
      'director_render_video', 'director_get_operation', 'director_cancel_operation',
    ]));
    expect(ids).toHaveLength(7);
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
    for (const id of ['director_set_runtime', 'director_open_blender', 'director_render_frame', 'director_render_video', 'director_cancel_operation']) {
      const tool = getAgentTool(id)!;
      expect(evaluateAgentToolPolicy(tool, { nodeId: 'director-1' }, context({ mode: 'plan' })).outcome).toBe('deny');
      expect(evaluateAgentToolPolicy(tool, { nodeId: 'director-1' }, context({ mode: 'collaborative' })).outcome).toBe('require_approval');
      expect(evaluateAgentToolPolicy(tool, { nodeId: 'director-1' }, context()).outcome).toBe('allow');
    }
    expect(getAgentTool('director_open_blender')!.effect).toBe('file_write');
    expect(getAgentTool('director_render_video')!.effect).toBe('media_generation');
    expect(getAvailableAgentTools(context({ mode: 'plan' })).map((tool) => tool.id))
      .toEqual(['director_get_state', 'director_get_operation']);
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
