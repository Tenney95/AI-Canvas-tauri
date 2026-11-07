/**
 * agentTaskService — 回归测试：repairInterruptedAgentTasks。
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../../src/types/agent';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.resetModules();
});

function createInterruptedTask(): AgentTask {
  const now = Date.now() - 1000;
  return {
    id: 'task-interrupted',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    mode: 'collaborative',
    goal: 'update canvas',
    status: 'waiting_approval',
    steps: [{
      id: 'step-1',
      taskId: 'task-interrupted',
      index: 0,
      kind: 'approval',
      title: 'Update canvas',
      status: 'waiting_approval',
      createdAt: now,
      updatedAt: now,
      approval: {
        id: 'approval-1',
        kind: 'canvas_write',
        status: 'pending',
        summary: 'Canvas write requires approval',
        requestedAt: now,
      },
    }],
    modelRounds: 1,
    toolCallCount: 1,
    budget: {
      maxModelRounds: 12,
      maxToolCalls: 24,
      maxParallelReadTools: 3,
      maxReadRetries: 3,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('repairInterruptedAgentTasks', () => {
  it('旧成功dispatch缺原成功步骤时保持已知结论、原ID与累计预算，恢复后拒绝普通继续', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const db = await import('../../../src/services/indexedDbService');
    const { useAppStore } = await import('../../../src/store/useAppStore');
    const { validateTaskResumable } = await import('../../../src/services/chat/agentTaskControl');
    const task = createInterruptedTask(); task.status = 'running'; task.mode = 'autonomous';
    task.modelRounds = 9; task.toolCallCount = 21; task.resumeCount = 4;
    task.steps[0] = { ...task.steps[0], kind: 'tool', status: 'running', approval: undefined,
      toolCall: { callId: 'original-paid-call', toolId: 'media_generate', effect: 'media_generation', retryCount: 0 } };
    task.dispatches = [{ id: 'original-dispatch', stepId: task.steps[0].id, kind: 'tool',
      toolId: 'media_generate', effect: 'media_generation', inputDigest: 'a'.repeat(64),
      phase: 'settled', outcome: 'succeeded', preparedAt: 1, settledAt: 2 }];
    await db.putAgentTask(task);
    await service.repairInterruptedAgentTasks(task.projectId);
    const repaired = await service.loadAgentTask(task.id);
    expect(repaired).toMatchObject({ status: 'paused', modelRounds: 9, toolCallCount: 21, resumeCount: 4,
      steps: [{ id: task.steps[0].id, status: 'pending', toolCall: { callId: 'original-paid-call' } }],
      dispatches: task.dispatches });
    useAppStore.setState({ agentTasks: [repaired!] });
    expect(validateTaskResumable(task.id)).toMatchObject({ ok: false, errorCode: 'AGENT_SUCCESS_STEP_INCOMPLETE' });
    expect(await db.getAgentTask(task.id)).toMatchObject({ modelRounds: 9, toolCallCount: 21, resumeCount: 4, dispatches: task.dispatches });
  });

  it('P4 owner历史聚合按原Canvas alias读取并保留退役回执、排序与原预算，不写回任务', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const db = await import('../../../src/services/indexedDbService');
    const first = { ...createInterruptedTask(), id: 'old-a', projectId: 'A', updatedAt: 1, modelRounds: 5, toolCallCount: 19, resumeCount: 4 };
    const retired = { ...createInterruptedTask(), id: 'old-b', projectId: 'B', updatedAt: 2, modelRounds: 8, toolCallCount: 23 };
    await db.putAgentTask(first); await db.putAgentTask(retired);
    const before = await db.getAgentTask(retired.id);
    const bindings: import('../../../src/types/project').LegacyProjectBinding[] = [
      { namespace: 'legacy-canvas', legacyId: 'A', projectId: 'S', canvasId: 'A', episodeId: 'A', sourceEpoch: 1, storageRootRef: 'root' },
      { namespace: 'legacy-canvas', legacyId: 'B', projectId: 'S', canvasId: 'B', episodeId: 'B', sourceEpoch: 2, storageRootRef: 'root', retired: true },
    ];
    const views = await service.readOwnerLegacyAgentTaskViews('S', bindings);
    expect(views.map((view) => view.record.id)).toEqual(['old-b', 'old-a']);
    expect(views[0].scope).toMatchObject({ state: 'retired', access: 'history-readonly' });
    expect(views[1].record).toMatchObject({ projectId: 'A', modelRounds: 5, toolCallCount: 19, resumeCount: 4 });
    expect(await db.getAgentTask(retired.id)).toEqual(before);
  });
  it('does not turn an interrupted profile preparation into a resumable unbound task', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const db = await import('../../../src/services/indexedDbService');
    const task = createInterruptedTask(); task.id = 'profile-preparing-restart';
    task.status = 'queued'; task.creationProfilePreparation = 'pending';
    await db.putAgentTask(task); await service.repairInterruptedAgentTasks(task.projectId);
    expect(await db.getAgentTask(task.id)).toMatchObject({ status: 'paused', creationProfilePreparation: 'pending' });
  });
  it('distinguishes prepared from dispatched and keeps unknown writes paused', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const db = await import('../../../src/services/indexedDbService');
    const task = createInterruptedTask(); task.id = 'dispatch-restart'; task.status = 'running';
    task.dispatches = [
      { id: 'prepared', kind: 'tool', phase: 'prepared', effect: 'canvas_write', preparedAt: 1 },
      { id: 'sent', kind: 'tool', phase: 'dispatched', effect: 'media_generation', preparedAt: 1, dispatchedAt: 2 },
    ];
    await db.putAgentTask(task); await service.repairInterruptedAgentTasks(task.projectId);
    const saved = await db.getAgentTask(task.id);
    expect(saved?.status).toBe('paused');
    expect(saved?.dispatches?.map((item) => item.phase)).toEqual(['not_started', 'outcome_unknown']);
  });
  it('pauses an interrupted keyed task without discarding or reclaiming its operation identity', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const db = await import('../../../src/services/indexedDbService');
    const base = createInterruptedTask();
    const task: AgentTask = { ...base, conversationId: `mcp-control-${base.projectId}`, mcpOperation: {
      version: 1, bindingId: 'mcp-operation:' + 'b'.repeat(64), projectId: base.projectId,
      keyDigest: 'c'.repeat(64), inputDigest: 'd'.repeat(64), toolId: 'canvas_update_nodes', effect: 'canvas_write',
      phase: 'reserved', sequence: 0, createdAt: 1, updatedAt: 1,
    } };
    await service.claimMcpOperationTask(task);
    await db.updateMcpOperationTask(task.id, { phase: 'running' });
    await service.repairInterruptedAgentTasks(base.projectId);
    const repaired = await service.loadAgentTask(task.id);
    expect(repaired).toMatchObject({ status: 'paused', pausedReason: 'app_restarted',
      mcpOperation: { keyDigest: 'c'.repeat(64), phase: 'running', sequence: 1 } });
    const replay = await service.claimMcpOperationTask({ ...task, id: 'must-not-start-again' });
    expect(replay.claimed).toBe(false);
    expect(replay.task?.id).toBe(task.id);
    expect(replay.task?.status).toBe('paused');
  });

  it('pauses interrupted tasks and expires pending approvals after restart', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    await service.saveAgentTask(createInterruptedTask());

    const repairedIds = await service.repairInterruptedAgentTasks('project-1');
    const repaired = await service.loadAgentTask('task-interrupted');

    expect(repairedIds).toEqual(['task-interrupted']);
    expect(repaired).toMatchObject({
      status: 'paused',
      pausedReason: 'app_restarted',
      steps: [{
        status: 'pending',
        approval: {
          status: 'expired',
          resolvedAt: expect.any(Number),
        },
      }],
    });
  });

  it('leaves terminal tasks unchanged', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const completed = { ...createInterruptedTask(), id: 'task-completed', status: 'completed' as const };
    await service.saveAgentTask(completed);

    expect(await service.repairInterruptedAgentTasks('project-1')).toEqual([]);
    expect(await service.loadAgentTask('task-completed')).toMatchObject({
      status: 'completed',
      steps: [{ status: 'waiting_approval', approval: { status: 'pending' } }],
    });
  });

  it('normalizes diagnostics added after older task records were written', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const legacy = createInterruptedTask();
    delete legacy.events;
    delete legacy.metrics;
    await service.saveAgentTask(legacy);

    expect(await service.loadAgentTask(legacy.id)).toMatchObject({
      events: [],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        modelDurationMs: 0,
        toolDurationMs: 0,
      },
    });
  });

  it('persists explicit Skill bindings while keeping legacy tasks distinguishable', async () => {
    const service = await import('../../../src/services/chat/agentTaskService');
    const bound = {
      ...createInterruptedTask(),
      id: 'task-bound-skill',
      skillBindings: [{
        skillId: 'skill-1',
        name: 'Canvas audit',
        version: '1.0.0',
        content: '# Fixed instructions',
        allowedTools: ['canvas_get_state'],
      }],
    };
    await service.saveAgentTask(bound);
    await service.saveAgentTask({ ...createInterruptedTask(), id: 'task-legacy' });

    expect(await service.loadAgentTask(bound.id)).toMatchObject({
      skillBindings: [{
        skillId: 'skill-1',
        content: '# Fixed instructions',
        allowedTools: ['canvas_get_state'],
      }],
    });
    expect((await service.loadAgentTask('task-legacy'))?.skillBindings).toBeUndefined();
  });
});
