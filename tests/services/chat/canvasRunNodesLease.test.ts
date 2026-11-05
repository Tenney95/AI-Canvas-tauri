/** canvas_run_nodes — MCP/Agent 取消与生成输入租约的委派边界。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../src/types';
import type { GenerationLease, GenerationResult } from '../../../src/services/generationService';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';

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
