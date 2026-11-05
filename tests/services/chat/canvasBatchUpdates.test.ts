/** 每个节点使用不同补丁的整批预检、单次画布提交与文本文件保存边界。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../../src/types';
import type { AssetTextSnapshot } from '../../../src/services/fileService';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerCanvasAgentTools } from '../../../src/services/chat/tools/canvasTools';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import { clearAgentToolRegistryForTests, getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';
import { getCanvasNodeHash } from '../../../src/services/chat/canvasNodeVersion';
import * as mcpOperations from '../../../src/services/mcp/mcpOperationService';
import type { AgentTask, McpOperationUpdate } from '../../../src/types/agent';

const files = vi.hoisted(() => ({ desktop: false, read: vi.fn(), save: vi.fn() }));
vi.mock('../../../src/services/generationService', () => ({ executeGeneration: vi.fn() }));
vi.mock('../../../src/services/globalDramaAssetService', () => ({ loadGlobalDramaAssetCards: vi.fn(async () => []) }));
vi.mock('../../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../../src/services/fileService')>(),
  isTauriEnv: () => files.desktop, readAssetTextFile: files.read, saveAssetTextFile: files.save,
}));

function node(id: string, data: Partial<BaseNodeData> = {}, position = { x: 0, y: 0 }): Node<BaseNodeData> {
  return { id, type: data.type ?? 'ai-video', position,
    data: { type: data.type ?? 'ai-video', label: id, status: 'idle', ...data } };
}

function context(): AgentToolContext {
  return { taskId: 'batch-task', projectId: 'p1', conversationId: 'mcp-control-p1', mode: 'autonomous',
    baseRevision: useAppStore.getState().getCurrentRevision(), signal: new AbortController().signal };
}

function snapshot(content: string): AssetTextSnapshot {
  return { content, digest: `digest:${content}`, size: content.length, modified: null, bom: false, newline: 'LF' };
}

function textNodes(samePath = false) {
  files.desktop = true;
  useAppStore.setState({ nodes: [
    node('a', { type: 'ai-markdown', output: '原文甲', filePath: '/project/a.md' }),
    node('b', { type: 'source-text', output: samePath ? '原文甲' : '原文乙', filePath: samePath ? '/project/a.md' : '/project/b.txt' }),
  ] });
  files.read.mockImplementation(async (path: string) => snapshot(path.endsWith('a.md') ? '原文甲' : '原文乙'));
}

function installKeyedTask() {
  const task: AgentTask = {
    id: 'batch-task', projectId: 'p1', conversationId: 'mcp-control-p1', userMessageId: 'receipt-user',
    mode: 'autonomous', goal: '安全批量编辑摘要', status: 'running', steps: [], modelRounds: 0, toolCallCount: 0,
    budget: { maxModelRounds: 1, maxToolCalls: 1, maxParallelReadTools: 1, maxReadRetries: 0 }, createdAt: 1, updatedAt: 1,
    mcpOperation: { version: 1, bindingId: 'receipt-binding', projectId: 'p1', keyDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
      toolId: 'canvas_update_nodes', effect: 'canvas_write', phase: 'running', sequence: 0, createdAt: 1, updatedAt: 1 },
  };
  useAppStore.setState({ agentTasks: [task] });
}

/** 此文件只控制日志的等待/失败；真实持久化与同 key 去重由 MCP service 集成测试覆盖。 */
function mirrorOperationProgress(taskId: string, changes: McpOperationUpdate) {
  const operation = useAppStore.getState().agentTasks.find((task) => task.id === taskId)?.mcpOperation;
  if (!operation) throw new Error('Expected keyed test task');
  useAppStore.getState().applyPersistedMcpOperation(taskId, { ...operation, ...changes,
    ...(changes.items ? { items: changes.items.map((item) => ({ ...item })) } : {}),
    sequence: operation.sequence + 1, updatedAt: operation.updatedAt + 1 });
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearAgentToolRegistryForTests();
  files.desktop = false;
  files.read.mockReset();
  files.save.mockReset().mockImplementation(async (_path: string, _baseline: AssetTextSnapshot, content: string) => snapshot(content));
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', projectLoadStatus: 'ready', showToast: vi.fn(), nodes: [
    node('a', { prompt: '甲旧词', nodeWidth: 320, nodeHeight: 320, seedanceRatio: '1:1' }),
    node('b', { type: 'ai-image', prompt: '乙原文' }, { x: 400, y: 50 }),
  ], edges: [] });
  registerCanvasAgentTools();
});

describe('异构节点批量更新', () => {
  it.each(['journal-failed', 'user-edit'] as const)('started 回执等待发生 %s 时整批未开始，不写半批', async (failure) => {
    installKeyedTask();
    let intercepted = false;
    vi.spyOn(mcpOperations, 'recordMcpOperationProgress').mockImplementation(async (taskId, changes) => {
      if (!intercepted && changes.items?.every((item) => item.status === 'started')) {
        intercepted = true;
        if (failure === 'journal-failed') throw new Error('private journal failure');
        mirrorOperationProgress(taskId, changes);
        await Promise.resolve();
        useAppStore.getState().updateNodeDataTransient('a', { prompt: '用户最新稿，未增加 revision' });
      } else mirrorOperationProgress(taskId, changes);
    });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { prompt: '模型甲稿' } }, { nodeId: 'b', patch: { prompt: '模型乙稿' } },
    ] });
    expect(intercepted).toBe(true);
    expect(result).toMatchObject({ status: 'error', errorCode: 'CANVAS_UPDATE_NOT_STARTED', retryable: false });
    expect(JSON.parse(result.modelContent)).toMatchObject({ retryable: false, items: [
      { nodeId: 'a', status: 'failed', errorCode: 'CANVAS_UPDATE_NOT_STARTED' },
      { nodeId: 'b', status: 'failed', errorCode: 'CANVAS_UPDATE_NOT_STARTED' },
    ] });
    expect(useAppStore.getState().nodes.map((item) => item.data.prompt))
      .toEqual([failure === 'user-edit' ? '用户最新稿，未增加 revision' : '甲旧词', '乙原文']);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(commit).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
  });

  it('keyed 文件保存部分失败后保留各项回执与不同草稿，画布只提交一次', async () => {
    textNodes();
    installKeyedTask();
    vi.spyOn(mcpOperations, 'recordMcpOperationProgress').mockImplementation(async (taskId, changes) => {
      mirrorOperationProgress(taskId, changes);
    });
    let phaseDuringSecondSave: string | undefined;
    files.save.mockImplementation(async (path: string, _baseline: AssetTextSnapshot, content: string) => {
      if (path.endsWith('a.md')) throw new Error('/private/file 未保存');
      phaseDuringSecondSave = useAppStore.getState().agentTasks[0].mcpOperation?.phase;
      return snapshot(content);
    });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲新稿' } }, { nodeId: 'b', patch: { content: '乙新稿' } },
    ] });
    const items = [{ nodeId: 'a', status: 'failed', errorCode: 'CANVAS_APPLIED_FILE_SAVE_FAILED' },
      { nodeId: 'b', status: 'succeeded' }];
    expect(result).toMatchObject({ status: 'error', errorCode: 'TEXT_FILE_SAVE_INCOMPLETE', retryable: false });
    expect(JSON.parse(result.modelContent)).toMatchObject({ items, receiptUnconfirmed: false, retryable: false });
    expect(useAppStore.getState().agentTasks[0].mcpOperation).toMatchObject({ phase: 'partial', revisionAfter: revision + 1, items });
    expect(useAppStore.getState().nodes.map((item) => item.data.output)).toEqual(['甲新稿', '乙新稿']);
    expect(files.save).toHaveBeenCalledTimes(2);
    expect(phaseDuringSecondSave).toBe('running');
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(result.summary + result.modelContent).not.toContain('/private/');
  });

  it('第一份文件及其成功回执已保存后日志中断，保留原结果并停止后续文件而不重投', async () => {
    textNodes();
    installKeyedTask();
    let interrupted = false;
    vi.spyOn(mcpOperations, 'recordMcpOperationProgress').mockImplementation(async (taskId, changes) => {
      const operation = useAppStore.getState().agentTasks.find((task) => task.id === taskId)?.mcpOperation;
      const firstSaved = operation?.items?.some((item) => item.nodeId === 'a' && item.status === 'succeeded');
      if (!interrupted && firstSaved && changes.items?.some((item) => item.nodeId === 'b' && item.status === 'started')) {
        interrupted = true;
        throw new Error('journal interrupted before second file');
      }
      mirrorOperationProgress(taskId, changes);
    });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲已保存稿' } }, { nodeId: 'b', patch: { content: '乙待保存稿' } },
    ] });
    expect(interrupted).toBe(true);
    expect(result).toMatchObject({ status: 'error', errorCode: 'MCP_OPERATION_PROGRESS_UNCONFIRMED', retryable: false });
    const items = [{ nodeId: 'a', status: 'succeeded' },
      { nodeId: 'b', status: 'unknown', errorCode: 'CANVAS_APPLIED_FILE_UNCONFIRMED' }];
    expect(JSON.parse(result.modelContent)).toMatchObject({ receiptUnconfirmed: true, retryable: false, items });
    expect(useAppStore.getState().agentTasks[0].mcpOperation).toMatchObject({ phase: 'partial', revisionAfter: revision + 1, items });
    expect(files.save).toHaveBeenCalledExactlyOnceWith('/project/a.md', expect.anything(), '甲已保存稿', expect.any(AbortSignal));
    expect(useAppStore.getState().nodes.map((item) => item.data.output)).toEqual(['甲已保存稿', '乙待保存稿']);
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
  });

  it('画布提交后的回执等待只推进 revision 时停止文件保存，保留草稿及未确认回执', async () => {
    textNodes();
    installKeyedTask();
    let changedRevision = false;
    vi.spyOn(mcpOperations, 'recordMcpOperationProgress').mockImplementation(async (taskId, changes) => {
      mirrorOperationProgress(taskId, changes);
      if (!changedRevision && changes.revisionAfter !== undefined) {
        changedRevision = true;
        await Promise.resolve();
        useAppStore.getState().incrementRevision();
      }
    });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲保留草稿' } }, { nodeId: 'b', patch: { content: '乙保留草稿' } },
    ] });
    const items = [{ nodeId: 'a', status: 'unknown', errorCode: 'CANVAS_APPLIED_FILE_UNCONFIRMED' },
      { nodeId: 'b', status: 'unknown', errorCode: 'CANVAS_APPLIED_FILE_UNCONFIRMED' }];
    expect(changedRevision).toBe(true);
    expect(result).toMatchObject({ status: 'error', errorCode: 'MCP_OPERATION_PROGRESS_UNCONFIRMED', retryable: false });
    expect(JSON.parse(result.modelContent)).toMatchObject({ revision: revision + 1, receiptUnconfirmed: true, retryable: false, items });
    expect(useAppStore.getState().agentTasks[0].mcpOperation).toMatchObject({ phase: 'partial', revisionAfter: revision + 1, items });
    expect(useAppStore.getState().nodes.map((item) => [item.data.output, item.data.filePath])).toEqual([
      ['甲保留草稿', '/project/a.md'], ['乙保留草稿', '/project/b.txt'],
    ]);
    expect(files.save).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 2);
  });

  it('每个补丁独立校验指纹，第二项未增 revision 的改名使整批拒绝，刷新后可一次提交', async () => {
    const state = useAppStore.getState();
    const firstHash = await getCanvasNodeHash(state.nodes[0], 'p1');
    const secondHash = await getCanvasNodeHash(state.nodes[1], 'p1');
    const revision = state.getCurrentRevision();
    useAppStore.getState().updateNodeDataTransient('b', { label: '用户新名称' });
    const before = useAppStore.getState().nodes;
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const update = getAgentTool('canvas_update_nodes')!;
    const stale = await update.execute(context(), { updates: [
      { nodeId: 'a', patch: { expectedNodeHash: firstHash, label: '模型名称' } },
      { nodeId: 'b', patch: { expectedNodeHash: secondHash, prompt: '模型提示词' } },
    ] });
    expect(stale).toMatchObject({ status: 'error', retryable: false, errorCode: 'NODE_CONTEXT_CHANGED' });
    expect(useAppStore.getState().nodes).toBe(before);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(commit).not.toHaveBeenCalled();
    const currentHash = await getCanvasNodeHash(before[1], 'p1');
    const result = await update.execute(context(), { updates: [
      { nodeId: 'a', patch: { expectedNodeHash: firstHash, label: '模型名称' } },
      { nodeId: 'b', patch: { expectedNodeHash: currentHash, prompt: '模型提示词' } },
    ] });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0].data.label).toBe('模型名称');
    expect(useAppStore.getState().nodes[1].data).toMatchObject({ label: '用户新名称', prompt: '模型提示词' });
    expect(useAppStore.getState().nodes.every((item) => !Object.hasOwn(item.data, 'expectedNodeHash'))).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
  });

  it('分别修改提示词、媒体参数和位置，只提交一次历史与 revision', async () => {
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { label: '镜头甲', promptEdit: { oldText: '旧词', newText: '新词' }, videoDuration: 4.2, aspectRatio: '16:9', x: 120, y: 200 } },
      { nodeId: 'b', patch: { label: '参考乙', prompt: '另一段提示词', aspectRatio: '1:1', batchCount: 2, dx: -15, dy: 10 } },
    ] });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes[0]).toMatchObject({ position: { x: 120, y: 200 },
      data: { label: '镜头甲', prompt: '甲新词', seedanceDuration: 5, seedanceRatio: '16:9', nodeWidth: 320, nodeHeight: 180 } });
    expect(useAppStore.getState().nodes[1]).toMatchObject({ position: { x: 385, y: 60 },
      data: { label: '参考乙', prompt: '另一段提示词', aspectRatio: '1:1', batchCount: 2 } });
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
    expect(JSON.parse(result.modelContent)).toMatchObject({ affectedNodeIds: ['a', 'b'], revision: revision + 1 });
  });

  it('拒绝顶层筛选或补丁混传、重复或不存在的节点以及空补丁，整批不改画布', async () => {
    const update = getAgentTool('canvas_update_nodes')!;
    const valid = { nodeId: 'a', patch: { prompt: '不应写入' } };
    for (const input of [
      { updates: [valid], nodeIds: ['a'] }, { updates: [valid], prompt: '顶层提示词' },
      { updates: [valid, valid] }, { updates: [valid, { nodeId: 'missing', patch: { label: '不存在' } }] },
      { updates: [valid, { nodeId: 'b', patch: {} }] },
    ]) {
      const state = useAppStore.getState();
      const revision = state.getCurrentRevision();
      const commit = vi.spyOn(state, 'commitToHistory');
      try {
        expect((await update.execute(context(), input)).status).toBe('error');
        expect(useAppStore.getState().nodes).toBe(state.nodes);
        expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
        expect(commit).not.toHaveBeenCalled();
      } finally { commit.mockRestore(); }
    }
  });

  it('第二项媒体参数、模型或片段原文无效时，第一项也不写入', async () => {
    const update = getAgentTool('canvas_update_nodes')!;
    for (const patch of [{ videoDuration: 3 }, { model: 'general/not-configured' },
      { promptEdit: { oldText: '不存在的原文', newText: '新词' } }]) {
      const state = useAppStore.getState();
      const revision = state.getCurrentRevision();
      const result = await update.execute(context(), { updates: [
        { nodeId: 'a', patch: { prompt: '第一项也不能提前写' } }, { nodeId: 'b', patch },
      ] });
      expect(result.status).toBe('error');
      expect(useAppStore.getState().nodes).toBe(state.nodes);
      expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    }
  });

  it('复用普通补丁 schema，拒绝超量、任意 data、文件路径和特殊修复操作', () => {
    const schema = getAgentTool('canvas_update_nodes')!.inputSchema;
    const valid = { nodeId: 'a', patch: { promptEdit: { oldText: '旧词', newText: '新词' } } };
    expect(validateAgentToolInput(schema, { updates: [valid] }).valid).toBe(true);
    expect(validateAgentToolInput(schema, { updates: [] }).valid).toBe(false);
    expect(validateAgentToolInput(schema, { updates: Array.from({ length: 51 }, () => valid) }).valid).toBe(false);
    for (const patch of [{ data: { prompt: '任意数据' } }, { filePath: '/private/file' }, { repairMissingCloudOutputs: true },
      { removeMissingDramaMentionIds: ['missing'] }, { nodeIds: ['a'], prompt: '重定向' }]) {
      expect(validateAgentToolInput(schema, { updates: [{ nodeId: 'a', patch }] }).valid).toBe(false);
    }
  });

  it.each(['conflict', 'read_failed'] as const)('文件基线 %s 时全部准备失败，画布与文件都不写', async (failure) => {
    textNodes();
    files.read.mockImplementation(async (path: string) => {
      if (path.endsWith('b.txt')) {
        if (failure === 'read_failed') throw new Error('/private/secret-file 读取失败');
        return snapshot('外部已改稿');
      }
      return snapshot('原文甲');
    });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲新稿' } }, { nodeId: 'b', patch: { content: '乙新稿' } },
    ] });
    expect(result).toMatchObject({ status: 'error', retryable: false });
    expect(result.summary + result.modelContent).not.toContain('/private/');
    expect(useAppStore.getState().nodes).toBe(state.nodes);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(commit).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
  });

  it('同一文件的不同正文在提交前拒绝，不默认为后项已保存', async () => {
    textNodes(true);
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲稿' } }, { nodeId: 'b', patch: { content: '不同乙稿' } },
    ] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(state.nodes);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(files.save).not.toHaveBeenCalled();
  });

  it.each(['c:/project/a.md', '\\\\?\\C:\\Project\\a.md'])('同文件 Windows 别名 %s 的不同正文也整批拒绝', async (alias) => {
    files.desktop = true;
    useAppStore.setState({ nodes: [
      node('a', { type: 'ai-text', output: '原文', filePath: 'C:\\Project\\a.md' }),
      node('b', { type: 'source-text', output: '原文', filePath: alias }),
    ] });
    const state = useAppStore.getState();
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲稿' } }, { nodeId: 'b', patch: { content: '乙稿' } },
    ] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes).toBe(state.nodes);
    expect(files.save).not.toHaveBeenCalled();
  });

  it.each([undefined, 'c:/project/a.md', '\\\\?\\C:\\Project\\a.md'])('同一文件相同正文只保存一次（别名 %s），并逐节点报告', async (alias) => {
    textNodes(true);
    if (alias) {
      useAppStore.setState({ nodes: [
        node('a', { type: 'ai-text', output: '原文甲', filePath: 'C:\\Project\\a.md' }),
        node('b', { type: 'source-text', output: '原文甲', filePath: alias }),
      ] });
    }
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '共同新稿' } }, { nodeId: 'b', patch: { content: '共同新稿' } },
    ] });
    expect(result.status).toBe('success');
    expect(files.save).toHaveBeenCalledExactlyOnceWith(alias ? 'C:\\Project\\a.md' : '/project/a.md', expect.anything(), '共同新稿', expect.any(AbortSignal));
    expect(useAppStore.getState().nodes.map((item) => item.data.output)).toEqual(['共同新稿', '共同新稿']);
    expect(JSON.parse(result.modelContent).textFilePersistence).toMatchObject({ savedCount: 2, failedCount: 0,
      results: [{ nodeId: 'a', status: 'saved' }, { nodeId: 'b', status: 'saved' }] });
  });

  it('所有基线先预读且画布一次提交，随后保存部分失败保留全部不同草稿', async () => {
    textNodes();
    files.read.mockImplementation(async (path: string) => {
      expect(useAppStore.getState().nodes.map((item) => item.data.output)).toEqual(['原文甲', '原文乙']);
      return snapshot(path.endsWith('a.md') ? '原文甲' : '原文乙');
    });
    files.save.mockImplementation(async (path: string, _baseline: AssetTextSnapshot, content: string) => {
      expect(files.read).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().nodes.map((item) => item.data.output)).toEqual(['甲新稿', '乙新稿']);
      if (path.endsWith('b.txt')) throw new Error('/private/sensitive-file 写入失败');
      return snapshot(content);
    });
    const state = useAppStore.getState();
    const revision = state.getCurrentRevision();
    const commit = vi.spyOn(state, 'commitToHistory');
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { content: '甲新稿' } }, { nodeId: 'b', patch: { content: '乙新稿' } },
    ] });
    expect(result).toMatchObject({ status: 'error', retryable: false, errorCode: 'TEXT_FILE_SAVE_INCOMPLETE' });
    expect(JSON.parse(result.modelContent).textFilePersistence).toMatchObject({ savedCount: 1, failedCount: 1,
      results: [{ nodeId: 'a', status: 'saved' }, { nodeId: 'b', status: 'save_failed' }] });
    expect(result.summary + result.modelContent).not.toMatch(/\/private\/|\/project\//);
    expect(useAppStore.getState().nodes.map((item) => item.data.output)).toEqual(['甲新稿', '乙新稿']);
    expect(files.save).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
  });

  it('预读文件期间另一目标被用户继续编辑时整批停止，保留用户的新稿', async () => {
    files.desktop = true;
    useAppStore.setState({ nodes: [node('a', { prompt: '原提示词' }),
      node('b', { type: 'ai-text', output: '旧正文', filePath: '/project/b.txt' })] });
    let finishRead!: (value: AssetTextSnapshot) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    files.read.mockImplementationOnce(() => new Promise<AssetTextSnapshot>((resolve) => {
      finishRead = resolve;
      markStarted();
    }));
    const revision = useAppStore.getState().getCurrentRevision();
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const pending = getAgentTool('canvas_update_nodes')!.execute(context(), { updates: [
      { nodeId: 'a', patch: { promptEdit: { oldText: '原提示词', newText: '模型新稿' } } },
      { nodeId: 'b', patch: { content: '模型新正文' } },
    ] });
    await started;
    useAppStore.getState().updateNodeDataTransient('a', { prompt: '用户继续编辑' });
    finishRead(snapshot('旧正文'));
    await expect(pending).rejects.toThrow('目标节点已变化');
    expect(useAppStore.getState().nodes.map((item) => item.data.prompt ?? item.data.output)).toEqual(['用户继续编辑', '旧正文']);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(commit).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
  });

  it('带指纹的标量在文件预读后再核对位置，阻止摘要计算后的手动移动被覆盖', async () => {
    textNodes();
    const expectedNodeHash = await getCanvasNodeHash(useAppStore.getState().nodes[0], 'p1');
    let finishRead!: (value: AssetTextSnapshot) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    files.read.mockImplementationOnce(() => new Promise<AssetTextSnapshot>((resolve) => {
      finishRead = resolve;
      markStarted();
    }));
    const revision = useAppStore.getState().getCurrentRevision();
    const commit = vi.spyOn(useAppStore.getState(), 'commitToHistory');
    const pending = getAgentTool('canvas_update_nodes')!.execute(context(), {
      nodeIds: ['a'], expectedNodeHash, content: '模型新正文', x: 100, y: 200,
    });
    await started;
    useAppStore.getState().updateNodePositionTransient('a', { x: 30, y: 40 });
    finishRead(snapshot('原文甲'));
    await expect(pending).rejects.toThrow('目标节点已变化');
    expect(useAppStore.getState().nodes[0]).toMatchObject({ position: { x: 30, y: 40 }, data: { output: '原文甲' } });
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision);
    expect(commit).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
  });

  it('旧顶层单补丁仍可一次更新多个节点', async () => {
    const revision = useAppStore.getState().getCurrentRevision();
    const result = await getAgentTool('canvas_update_nodes')!.execute(context(), { nodeIds: ['a', 'b'], label: '共享名称' });
    expect(result.status).toBe('success');
    expect(useAppStore.getState().nodes.map((item) => item.data.label)).toEqual(['共享名称', '共享名称']);
    expect(useAppStore.getState().getCurrentRevision()).toBe(revision + 1);
  });
});
