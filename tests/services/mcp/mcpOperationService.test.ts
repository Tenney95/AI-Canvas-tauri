/** 真实 IndexedDB 事务验证 MCP 操作绑定和安全回执，不启动应用或付费工作。 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAgentTaskInput } from '../../../src/store/store.agent';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

async function setup(projectId = 'project-operation') {
  const { useAppStore } = await import('../../../src/store/useAppStore');
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: projectId });
  const api = await import('../../../src/services/mcp/mcpOperationService');
  const db = await import('../../../src/services/indexedDbService');
  const input: CreateAgentTaskInput = { projectId, conversationId: `mcp-control-${projectId}`,
    userMessageId: 'user-operation', mode: 'autonomous', goal: '安全操作摘要' };
  const identity = await api.identifyMcpOperation({ projectId, toolId: 'canvas_update_nodes', effect: 'canvas_write',
    arguments: { nodeIds: ['node-operation'], prompt: 'raw-prompt-do-not-persist' }, operationKey: 'opaque-key-do-not-persist' });
  return { useAppStore, api, db, input, identity, projectId };
}

describe('MCP operation durable claims', () => {
  it('atomically claims one task for concurrent same-key calls and never stores the key or arguments', async () => {
    const { api, db, useAppStore, input, identity, projectId } = await setup();
    const reordered = await api.identifyMcpOperation({ projectId, toolId: 'canvas_update_nodes', effect: 'canvas_write',
      arguments: { prompt: 'raw-prompt-do-not-persist', nodeIds: ['node-operation'] }, operationKey: 'opaque-key-do-not-persist' });
    expect(reordered).toEqual(identity);
    const claims = await Promise.all([
      api.claimMcpOperation(identity, input), api.claimMcpOperation(reordered, { ...input, userMessageId: 'other-message' }),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.receipt.taskId)).size).toBe(1);
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
    const tasks = await db.getProjectAgentTasks(projectId);
    const binding = await db.getMcpOperationBinding(identity.bindingId);
    const persisted = JSON.stringify({ tasks, binding });
    expect(tasks).toHaveLength(1);
    expect(persisted).not.toContain('opaque-key-do-not-persist');
    expect(persisted).not.toContain('raw-prompt-do-not-persist');
    expect(binding).toMatchObject({ taskId: tasks[0].id, lastSequence: 0 });
  });

  it('does not publish a task or binding when the durable claim fails', async () => {
    const { api, db, useAppStore, input, identity } = await setup();
    vi.spyOn(db, 'claimMcpAgentTask').mockRejectedValueOnce(new Error('simulated claim failure'));
    await expect(api.claimMcpOperation(identity, input)).rejects.toThrow('simulated claim failure');
    expect(useAppStore.getState().agentTasks).toEqual([]);
    expect(await db.getMcpOperationBinding(identity.bindingId)).toBeNull();
  });

  it('rolls back the binding when adding its task fails in the same transaction', async () => {
    const { api, db, useAppStore, input, identity, projectId } = await setup();
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.spyOn(Math, 'random').mockReturnValue(0.125);
    await api.claimMcpOperation(identity, input);
    const other = await api.identifyMcpOperation({ projectId, toolId: 'canvas_update_nodes', effect: 'canvas_write',
      arguments: {}, operationKey: 'another-reservation' });
    await expect(api.claimMcpOperation(other, input)).rejects.toBeTruthy();
    expect(await db.getMcpOperationBinding(other.bindingId)).toBeNull();
    expect(await db.getMcpOperationBinding(identity.bindingId)).not.toBeNull();
    expect(useAppStore.getState().agentTasks).toHaveLength(1);
  });

  it('rejects reused keys with a different tool or business input', async () => {
    const { api, db, input, identity, projectId } = await setup();
    await api.claimMcpOperation(identity, input);
    for (const change of [{ toolId: 'canvas_run_nodes' }, { arguments: { nodeIds: ['different'] } }]) {
      const changed = await api.identifyMcpOperation({ projectId, toolId: 'canvas_update_nodes', effect: 'canvas_write',
        arguments: { nodeIds: ['node-operation'], prompt: 'raw-prompt-do-not-persist' },
        operationKey: 'opaque-key-do-not-persist', ...change });
      await expect(api.readMcpOperation(changed)).rejects.toThrow('MCP_OPERATION_KEY_CONFLICT');
      await expect(api.claimMcpOperation(changed, input)).rejects.toThrow('MCP_OPERATION_KEY_CONFLICT');
    }
    expect(await db.getProjectAgentTasks(projectId)).toHaveLength(1);
  });

  it('rejects other effects before persistence and keeps long project IDs out of operation IDs', async () => {
    const { api, db, input, identity, projectId } = await setup('project-' + 'x'.repeat(172));
    expect(identity.bindingId).toHaveLength('mcp-operation:'.length + 64);
    const claim = await api.claimMcpOperation(identity, input);
    expect(await api.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId }))
      .toMatchObject({ taskId: claim.receipt.taskId });
    await expect(api.identifyMcpOperation({ projectId, toolId: 'provider_config_apply', effect: 'config_write',
      arguments: { authorization: 'private-value' }, operationKey: 'config-key' })).rejects.toThrow('仅用于');
    expect(await db.getProjectAgentTasks(projectId)).toHaveLength(1);
  });

  it('preserves terminal receipts and their sequence despite late progress or stale ordinary task saves', async () => {
    const { api, db, input, identity, projectId } = await setup();
    const claim = await api.claimMcpOperation(identity, input);
    const taskId = claim.receipt.taskId;
    const initial = (await db.getAgentTask(taskId))!;
    await api.startMcpOperation(taskId);
    const completed = await api.finishMcpOperation(taskId, { status: 'success', summary: 'must-not-persist-raw-summary' });
    await api.recordMcpOperationProgress(taskId, { phase: 'running', items: [{ nodeId: 'node-operation', status: 'started' }] });
    await db.putAgentTask({ ...initial, status: 'queued' });
    const receipt = await api.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId });
    expect(receipt).toMatchObject({ status: 'succeeded', sequence: completed!.sequence, resultAvailable: false, retryable: false });
    expect(JSON.stringify(await db.getAgentTask(taskId))).not.toContain('must-not-persist-raw-summary');
  });

  it.each(['task', 'conversation', 'permanent-conversation', 'project-tasks'])('retains a monotonically numbered key tombstone after %s deletion', async (kind) => {
    const { api, db, input, identity, projectId } = await setup();
    const claim = await api.claimMcpOperation(identity, input);
    const stale = (await db.getAgentTask(claim.receipt.taskId))!;
    await api.startMcpOperation(claim.receipt.taskId);
    const before = (await api.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId }))!;
    if (kind === 'task') await db.deleteAgentTask(claim.receipt.taskId);
    else if (kind === 'conversation') await db.deleteConversationAgentTasks(input.conversationId);
    else if (kind === 'permanent-conversation') await db.permanentlyDeleteConversation(input.conversationId);
    else await db.deleteProjectAgentTasks(projectId);
    await db.putAgentTask(stale);
    expect(await db.getAgentTask(claim.receipt.taskId)).toBeNull();
    const replay = await api.claimMcpOperation(identity, input);
    expect(replay.claimed).toBe(false);
    expect(replay.task).toBeNull();
    expect(replay.receipt).toMatchObject({ status: 'unknown', resultAvailable: false, retryable: false });
    expect(replay.receipt.sequence).toBeGreaterThan(before.sequence);
  });

  it('reports unknown after a process restart and never reclaims a pending operation', async () => {
    const { api, input, identity, projectId } = await setup();
    const claim = await api.claimMcpOperation(identity, input);
    await api.startMcpOperation(claim.receipt.taskId);
    vi.resetModules();
    const { useAppStore } = await import('../../../src/store/useAppStore');
    useAppStore.setState({ currentProjectId: projectId });
    const restarted = await import('../../../src/services/mcp/mcpOperationService');
    const receipt = await restarted.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId });
    expect(receipt).toMatchObject({ status: 'unknown', retryable: false, resultAvailable: false, requiresReadVerification: true });
    expect((await restarted.claimMcpOperation(identity, input)).claimed).toBe(false);
  });

  it('leaves a durable failed reservation when the project changes after claiming, without starting work', async () => {
    const { api, db, useAppStore, input, identity, projectId } = await setup();
    await expect(api.claimMcpOperation(identity, input, () => {
      useAppStore.setState({ currentProjectId: 'other-project' });
      throw new Error('context changed');
    })).rejects.toThrow('context changed');
    useAppStore.setState({ currentProjectId: projectId });
    expect(await api.readMcpOperation(identity)).toMatchObject({ status: 'failed', errorCode: 'MCP_CONTEXT_CHANGED' });
    expect(await db.getProjectAgentTasks(projectId)).toHaveLength(1);
  });

  it('skips the revision callback when a same-project concurrent claim already owns the key', async () => {
    const { api, input, identity } = await setup();
    const owner = await api.claimMcpOperation(identity, input);
    const staleRevision = vi.fn(() => { throw new Error('revision advanced by owner'); });
    const replay = await api.claimMcpOperation(identity, input, staleRevision);
    expect(replay.claimed).toBe(false);
    expect(replay.receipt.taskId).toBe(owner.receipt.taskId);
    expect(staleRevision).not.toHaveBeenCalled();
  });

  it('keeps operations scoped to the active project and rejects ambiguous lookup inputs', async () => {
    const { api, useAppStore, input, identity, projectId } = await setup();
    const claim = await api.claimMcpOperation(identity, input);
    useAppStore.setState({ currentProjectId: 'other-project' });
    await expect(api.readMcpOperation(identity)).rejects.toThrow('当前项目');
    await expect(api.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId })).rejects.toThrow('当前项目');
    useAppStore.setState({ currentProjectId: projectId });
    await expect(api.getMcpOperationReceipt(projectId, {})).rejects.toThrow('之一');
    await expect(api.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId, operationKey: 'another' })).rejects.toThrow('之一');
  });

  it('finishes safely after its task was removed and ordinary Agent progress remains a no-op', async () => {
    const { api, db, useAppStore, input, identity, projectId } = await setup();
    const claim = await api.claimMcpOperation(identity, input);
    await api.startMcpOperation(claim.receipt.taskId);
    // 模拟 Store 已移除、删除事务尚未完成，持久层仍有 running 记录。
    useAppStore.setState({ agentTasks: [] });
    expect(await api.finishMcpOperation(claim.receipt.taskId, { status: 'error' })).toBeNull();
    expect(await api.getMcpOperationReceipt(projectId, { operationId: claim.receipt.operationId })).toMatchObject({ status: 'unknown' });
    const update = vi.spyOn(db, 'updateMcpOperationTask');
    await api.recordMcpOperationProgress('ordinary-task', { phase: 'running' });
    expect(update).not.toHaveBeenCalled();
  });
});
