/** canvas_run_nodes — MCP/Agent 取消与生成输入租约的委派边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../src/types';
import type { GenerationLease, GenerationResult } from '../../../src/services/generationService';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';
import * as operationProgress from '../../../src/services/mcp/mcpOperationService';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask, type McpOperationUpdate } from '../../../src/types/agent';

const generate = vi.hoisted(() => vi.fn<(
  nodeId: string, overridePrompt?: string, postProcess?: unknown, passData?: BaseNodeData, lease?: GenerationLease,
) => Promise<GenerationResult>>());
vi.mock('../../../src/services/generationService', () => ({ executeGeneration: generate }));

function node(id: string): Node<BaseNodeData> {
  return { id, type: 'ai-image', position: { x: 0, y: 0 }, data: {
    type: 'ai-image', label: id, prompt: `生成 ${id}`, status: 'idle',
  } };
}

function context(signal: AbortSignal): AgentToolContext {
  return { taskId: 'mcp-task', projectId: 'p', conversationId: 'mcp-control-p', mode: 'autonomous',
    baseRevision: useAppStore.getState().getCurrentRevision(), signal };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  generate.mockReset().mockResolvedValue({ success: true });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p', projectLoadStatus: 'ready', nodes: [node('first'), node('second')], edges: [],
    showToast: vi.fn(), recordOutputHistory: vi.fn() });
  registerCanvasAgentTools();
});
afterEach(() => vi.restoreAllMocks());

function keyedTask() {
  const task: AgentTask = { id: 'mcp-task', projectId: 'p', conversationId: 'mcp-control-p', userMessageId: 'request-message',
    mode: 'autonomous', goal: '运行节点', status: 'running', steps: [], modelRounds: 0, toolCallCount: 1,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 1,
    mcpOperation: { version: 1, bindingId: 'operation-binding', projectId: 'p', keyDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
      toolId: 'canvas_run_nodes', effect: 'media_generation', phase: 'running', sequence: 1, createdAt: 1, updatedAt: 1 } };
  useAppStore.setState({ agentTasks: [task] });
  return vi.spyOn(operationProgress, 'recordMcpOperationProgress').mockImplementation(async (taskId, change) => {
    const current = useAppStore.getState().agentTasks.find((item) => item.id === taskId)!;
    useAppStore.getState().applyPersistedMcpOperation(taskId, { ...current.mcpOperation!, ...change,
      sequence: current.mcpOperation!.sequence + 1, updatedAt: Date.now() });
  });
}

describe('keyed canvas_run_nodes progress', () => {
  it('retains completed, interrupted and unstarted nodes after cancellation without submitting the rest', async () => {
    const progress = keyedTask();
    useAppStore.setState((state) => ({ nodes: [...state.nodes, node('third')] }));
    const controller = new AbortController();
    const second = deferred<GenerationResult>();
    generate.mockImplementation(async (nodeId) => nodeId === 'second' ? second.promise : { success: true });
    const pending = getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first', 'second', 'third'] });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    controller.abort();
    second.resolve({ success: false, message: '本地跟踪已停止' });
    const result = await pending;
    expect(result).toMatchObject({ status: 'error', errorCode: 'CANVAS_RUN_INTERRUPTED' });
    expect(JSON.parse(result.modelContent).items).toEqual([
      { nodeId: 'first', status: 'succeeded' },
      { nodeId: 'second', status: 'unknown', errorCode: 'CANVAS_NODE_RESULT_UNCONFIRMED' },
      { nodeId: 'third', status: 'not_started' },
    ]);
    expect(progress).toHaveBeenLastCalledWith('mcp-task', expect.objectContaining({ phase: 'partial' }));
    expect(useAppStore.getState().agentTasks[0].mcpOperation?.items).toEqual(JSON.parse(result.modelContent).items);
    expect(generate.mock.calls.map(([nodeId]) => nodeId)).toEqual(['first', 'second']);
  });

  it.each(['persist-failed', 'prompt-changed'] as const)('does not call a node after its started journal %s', async (change) => {
    const progress = keyedTask();
    progress.mockImplementation(async (_taskId, update) => {
      if (!update.items?.some((item) => item.status === 'started')) return;
      if (change === 'persist-failed') throw new Error('receipt unavailable');
      useAppStore.getState().updateNodeDataTransient('first', { prompt: 'new-user-draft' });
    });
    const result = await getAgentTool('canvas_run_nodes')!.execute(context(new AbortController().signal), { nodeIds: ['first', 'second'] });
    expect(result).toMatchObject({ status: 'error', errorCode: 'CANVAS_RUN_INTERRUPTED' });
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.parse(result.modelContent).items).toEqual([
      { nodeId: 'first', status: 'failed', errorCode: 'CANVAS_NODE_NOT_STARTED' }, { nodeId: 'second', status: 'not_started' },
    ]);
  });

  it('stops after a completed node when journaling its result fails, preserving the local completed result', async () => {
    const progress = keyedTask();
    const mirror = progress.getMockImplementation()!;
    let failed = false;
    progress.mockImplementation(async (taskId, update: McpOperationUpdate) => {
      if (!failed && update.items?.[0]?.status === 'succeeded') { failed = true; throw new Error('receipt unavailable'); }
      await mirror(taskId, update);
    });
    const result = await getAgentTool('canvas_run_nodes')!.execute(context(new AbortController().signal), { nodeIds: ['first', 'second'] });
    expect(result).toMatchObject({ status: 'error', errorCode: 'CANVAS_RUN_INTERRUPTED' });
    expect(JSON.parse(result.modelContent).items).toEqual([{ nodeId: 'first', status: 'succeeded' }, { nodeId: 'second', status: 'not_started' }]);
    expect(useAppStore.getState().agentTasks[0].mcpOperation?.revisionAfter).toBe(JSON.parse(result.modelContent).revision);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('keeps the old project identity and omits the new project revision after switching projects', async () => {
    keyedTask();
    const response = deferred<GenerationResult>();
    generate.mockReturnValueOnce(response.promise);
    const pending = getAgentTool('canvas_run_nodes')!.execute(context(new AbortController().signal), { nodeIds: ['first', 'second'] });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    useAppStore.setState({ currentProjectId: 'other-project', canvasRevision: 999 });
    response.resolve({ success: false });
    const result = await pending;
    expect(JSON.parse(result.modelContent)).toMatchObject({ projectId: 'p' });
    expect(JSON.parse(result.modelContent)).not.toHaveProperty('revision');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('reports an invalidated paid lease as unknown even when the signal remains active and no recovery task exists', async () => {
    keyedTask();
    const controller = new AbortController();
    generate.mockImplementation(async (nodeId, _prompt, _process, _data, lease) => {
      useAppStore.getState().updateNodeDataTransient(nodeId, { prompt: 'new-user-draft' });
      try { await lease!.assertFresh(); } catch { /* delegate reports its cancelled execution */ }
      return { success: false, message: '任务已取消' };
    });
    const result = await getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first', 'second'] });
    expect(controller.signal.aborted).toBe(false);
    expect(JSON.parse(result.modelContent).items).toEqual([
      { nodeId: 'first', status: 'unknown', errorCode: 'CANVAS_NODE_RESULT_UNCONFIRMED' }, { nodeId: 'second', status: 'not_started' },
    ]);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('records the completed result revision before a post-result journal wait can be cancelled', async () => {
    const progress = keyedTask();
    const mirror = progress.getMockImplementation()!;
    const controller = new AbortController();
    const initialRevision = useAppStore.getState().getCurrentRevision();
    progress.mockImplementation(async (taskId, update) => {
      if (update.items?.[0]?.status === 'succeeded' && update.phase === undefined) {
        expect(useAppStore.getState().getCurrentRevision()).toBe(initialRevision + 1);
        expect(update.revisionAfter).toBe(initialRevision + 1);
        controller.abort();
      }
      await mirror(taskId, update);
    });
    const result = await getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first', 'second'] });
    expect(result).toMatchObject({ status: 'error', errorCode: 'CANVAS_RUN_INTERRUPTED' });
    expect(JSON.parse(result.modelContent)).toMatchObject({ revision: initialRevision + 1,
      items: [{ nodeId: 'first', status: 'succeeded' }, { nodeId: 'second', status: 'not_started' }] });
    expect(useAppStore.getState().agentTasks[0].mcpOperation?.revisionAfter).toBe(initialRevision + 1);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('does not journal ordinary no-key Agent generation', async () => {
    const progress = vi.spyOn(operationProgress, 'recordMcpOperationProgress');
    expect((await getAgentTool('canvas_run_nodes')!.execute(context(new AbortController().signal), { nodeIds: ['first', 'second'] })).status).toBe('success');
    expect(progress).not.toHaveBeenCalled();
  });
});

describe('canvas_run_nodes 生成租约', () => {
  it('把取消信号传给正在运行的节点，并停止提交后续节点', async () => {
    const controller = new AbortController();
    const response = deferred<GenerationResult>();
    generate.mockReturnValueOnce(response.promise);
    const pending = getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first', 'second'] });
    const settled = pending.catch(() => undefined);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const lease = generate.mock.calls[0][4];
    expect(lease?.signal).toBe(controller.signal);
    controller.abort();
    expect(lease?.signal?.aborted).toBe(true);
    response.resolve({ success: false, message: '任务已取消' });
    await settled;
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(['project', 'prompt', 'model', 'workflowInputs'] as const)('%s 变化使原节点租约失效', async (change) => {
    const controller = new AbortController();
    const response = deferred<GenerationResult>();
    generate.mockReturnValueOnce(response.promise);
    const pending = getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first'] });
    const settled = pending.catch(() => undefined);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const lease = generate.mock.calls[0][4];
    expect(lease).toBeDefined();
    if (change === 'project') useAppStore.setState({ currentProjectId: 'other' });
    else useAppStore.setState((state) => ({ nodes: state.nodes.map((entry) => entry.id !== 'first' ? entry : {
      ...entry, data: { ...entry.data, [change]: change === 'workflowInputs' ? { prompt: '新输入' } : '新输入' },
    }) }));
    await expect(Promise.resolve().then(() => lease!.assertFresh())).rejects.toThrow();
    response.resolve({ success: false, message: '任务已取消' });
    await settled;
  });

  it('生成的状态更新及前一个节点自身增加 revision 不使后续节点租约失效', async () => {
    const controller = new AbortController();
    generate.mockImplementation(async (nodeId, _prompt, _postProcess, _data, lease) => {
      expect(lease).toBeDefined();
      await lease!.assertFresh();
      useAppStore.getState().updateNodeDataTransient(nodeId, { status: 'loading', mediaTaskStage: 'querying' });
      await lease!.assertFresh();
      useAppStore.getState().updateNodeDataTransient(nodeId, { imageUrl: `saved-${nodeId}.png`, status: 'success' });
      return { success: true };
    });
    const result = await getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first', 'second'] });
    expect(generate.mock.calls.map(([nodeId]) => nodeId)).toEqual(['first', 'second']);
    expect(JSON.parse(result.modelContent).results.map((entry: { status: string }) => entry.status)).toEqual(['success', 'success']);
  });

  it('等待期间后续节点的原始输入变化时不提交该节点', async () => {
    const controller = new AbortController();
    const response = deferred<GenerationResult>();
    generate.mockReturnValueOnce(response.promise);
    const pending = getAgentTool('canvas_run_nodes')!.execute(context(controller.signal), { nodeIds: ['first', 'second'] });
    const settled = pending.catch(() => undefined);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    useAppStore.getState().updateNodeDataTransient('second', { prompt: '改为新任务' });
    response.resolve({ success: true });
    await settled;
    expect(generate).toHaveBeenCalledOnce();
  });
});
