import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import type { AgentTeamRun } from '../../../src/types/agentTeam';

const fixture = vi.hoisted(() => ({ tasks: [] as AgentTask[], save: vi.fn() }));
vi.mock('../../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({
  agentTasks: fixture.tasks,
  updateAgentTask: (id: string, patch: Partial<AgentTask>) => { Object.assign(fixture.tasks.find((task) => task.id === id)!, patch); },
}) } }));
vi.mock('../../../src/services/chat/agentTaskService', () => ({ saveAgentTask: fixture.save }));
import { beginAgentDispatch, settleAgentDispatch, resolveAgentDispatchOutcome, unmaterializedTeamDispatches, AgentDurabilityError } from '../../../src/services/chat/agentDurabilityService';
import { unmaterializedToolDispatches } from '../../../src/services/chat/agentCheckpointService';

beforeEach(() => {
  fixture.tasks = [{ id: 'dispatch-task', projectId: 'project', conversationId: 'conv', userMessageId: 'message',
    mode: 'autonomous', goal: '任务', status: 'running', steps: [], modelRounds: 0, toolCallCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 1 }];
  fixture.save.mockReset().mockResolvedValue(undefined);
});

describe('Agent 执行持久化屏障', () => {
  it('工具结论与原成功步骤在同一快照落盘，进程中断后仍保留身份与预算', async () => {
    const task = fixture.tasks[0];
    task.modelRounds = 7; task.toolCallCount = 19; task.resumeCount = 3;
    const step = { id: 'paid-step', taskId: task.id, index: 0, kind: 'tool' as const, title: '生成',
      status: 'running' as const, createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'original-call', toolId: 'media_generate', effect: 'media_generation' as const,
        retryCount: 0, inputFingerprint: 'original-fingerprint' } };
    task.steps = [step];
    const record = await beginAgentDispatch({ taskId: task.id, kind: 'tool', stepId: step.id,
      toolId: step.toolCall.toolId, effect: step.toolCall.effect, inputDigest: 'a'.repeat(64) });
    fixture.save.mockClear();
    let persisted: AgentTask | undefined;
    fixture.save.mockImplementation(async (snapshot: AgentTask) => { persisted = structuredClone(snapshot); });
    await settleAgentDispatch(task.id, record, 'succeeded', { toolStep: {
      id: step.id, status: 'succeeded', outputSummary: '生成已完成',
      toolCall: { ...step.toolCall, resultSummary: '生成已完成', finishedAt: 2 },
    } });
    expect(fixture.save).toHaveBeenCalledOnce();
    expect(persisted).toMatchObject({ modelRounds: 7, toolCallCount: 19, resumeCount: 3,
      steps: [{ id: step.id, status: 'succeeded', outputSummary: '生成已完成',
        toolCall: { callId: 'original-call', inputFingerprint: 'original-fingerprint', finishedAt: 2 } }],
      dispatches: [{ id: record.id, phase: 'settled', outcome: 'succeeded' }],
    });
    expect(unmaterializedToolDispatches(persisted!)).toEqual([]);
  });

  it.each(['running', 'pending', 'missing'] as const)('旧成功回执的%s步骤不可按同摘要重投且不会降为未知', async (state) => {
    const task = fixture.tasks[0];
    task.modelRounds = 6; task.toolCallCount = 20; task.resumeCount = 2;
    task.steps = state === 'missing' ? [] : [{ id: 'old-step', taskId: task.id, index: 0, kind: 'tool',
      title: '生成', status: state, createdAt: 1, updatedAt: 1,
      toolCall: { callId: 'old-call', toolId: 'media_generate', effect: 'media_generation', retryCount: 0 } }];
    const record = { id: 'old-dispatch', kind: 'tool' as const, stepId: 'old-step', toolId: 'media_generate',
      effect: 'media_generation' as const, inputDigest: 'a'.repeat(64), phase: 'settled' as const,
      outcome: 'succeeded' as const, preparedAt: 1, settledAt: 2 };
    task.dispatches = [record];
    await expect(beginAgentDispatch({ taskId: task.id, kind: 'tool', toolId: record.toolId,
      effect: record.effect, inputDigest: record.inputDigest })).rejects.toThrow('普通继续不会重投');
    await settleAgentDispatch(task.id, record, 'unknown');
    expect(task.dispatches).toEqual([record]);
    expect(task).toMatchObject({ modelRounds: 6, toolCallCount: 20, resumeCount: 2 });
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('裁剪终态回执时保留旧成功但缺原步骤的写入证明，只读工具仍可调用', async () => {
    const task = fixture.tasks[0];
    task.dispatches = [{ id: 'missing-tool-step', kind: 'tool', stepId: 'missing', toolId: 'media_generate',
      effect: 'media_generation', phase: 'settled', outcome: 'succeeded', preparedAt: 1 },
      ...Array.from({ length: 256 }, (_, index) => ({ id: `settled-${index}`, kind: 'model' as const,
        phase: 'settled' as const, outcome: 'succeeded' as const, preparedAt: index + 2 }))];
    await beginAgentDispatch({ taskId: task.id, kind: 'tool', toolId: 'media_generate', effect: 'read' });
    expect(task.dispatches?.find((item) => item.id === 'missing-tool-step')).toMatchObject({ outcome: 'succeeded' });
  });

  it.each(['call', 'tool', 'outcome'] as const)('不把不匹配的%s步骤补进已结算成功回执', async (mismatch) => {
    const task = fixture.tasks[0];
    const toolCall = { callId: 'original-call', toolId: 'media_generate', effect: 'media_generation' as const, retryCount: 0 };
    task.steps = [{ id: 'original-step', taskId: task.id, index: 0, kind: 'tool', title: '生成',
      status: 'pending', createdAt: 1, updatedAt: 1, toolCall }];
    const record = { id: 'settled-tool', kind: 'tool' as const, phase: 'settled' as const, outcome: 'succeeded' as const,
      stepId: 'original-step', toolId: toolCall.toolId, effect: toolCall.effect, preparedAt: 1, settledAt: 2 };
    task.dispatches = [record];
    await expect(settleAgentDispatch(task.id, record, 'succeeded', { toolStep: {
      id: 'original-step', status: mismatch === 'outcome' ? 'failed' : 'succeeded', outputSummary: '完成',
      toolCall: { ...toolCall, ...(mismatch === 'call' ? { callId: 'other-call' } : {}),
        ...(mismatch === 'tool' ? { toolId: 'other-tool' } : {}) },
    } })).rejects.toThrow('不匹配');
    expect(task.dispatches).toEqual([record]);
    expect(task.steps[0].status).toBe('pending');
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('已结算成功只能补原步骤，不反转原outcome或settledAt', async () => {
    const task = fixture.tasks[0];
    const toolCall = { callId: 'original-call', toolId: 'media_generate', effect: 'media_generation' as const, retryCount: 0 };
    task.steps = [{ id: 'original-step', taskId: task.id, index: 0, kind: 'tool', title: '生成',
      status: 'pending', createdAt: 1, updatedAt: 1, toolCall }];
    const record = { id: 'settled-tool', kind: 'tool' as const, phase: 'settled' as const, outcome: 'succeeded' as const,
      stepId: 'original-step', toolId: toolCall.toolId, effect: toolCall.effect, preparedAt: 1, settledAt: 2 };
    task.dispatches = [record];
    await settleAgentDispatch(task.id, record, 'failed', { toolStep: {
      id: 'original-step', status: 'succeeded', outputSummary: '完成', toolCall: { ...toolCall, resultSummary: '完成' },
    } });
    expect(task.dispatches).toEqual([record]);
    expect(task.steps[0]).toMatchObject({ status: 'succeeded', toolCall: { callId: 'original-call' } });
  });

  it('P4 已明确完成但没有可接纳产物的团队阶段保留原回执，普通继续不能重新付费', async () => {
    const task = fixture.tasks[0];
    task.teamRun = { revision: 1, stages: [], artifacts: [] } as unknown as AgentTeamRun;
    task.dispatches = [{ id: 'known-completed', kind: 'team-model', stepId: 'draft', runRevision: 1,
      phase: 'settled', outcome: 'succeeded', preparedAt: 1, settledAt: 2 }];
    expect(unmaterializedTeamDispatches(task).map((item) => item.id)).toEqual(['known-completed']);
    await expect(beginAgentDispatch({ taskId: task.id, kind: 'team-model', stepId: 'draft', runRevision: 1 }))
      .rejects.toThrow('普通继续不会重投');
    expect(fixture.save).not.toHaveBeenCalled();
  });
  it('P4 终态容量裁剪仍保留materializationBlocked证明', async () => {
    const task = fixture.tasks[0];
    task.dispatches = [{ id: 'blocked', kind: 'team-model', phase: 'settled', outcome: 'failed', preparedAt: 1, materializationBlocked: true },
      ...Array.from({ length: 256 }, (_, index) => ({ id: `done-${index}`, kind: 'model' as const, phase: 'settled' as const, outcome: 'succeeded' as const, preparedAt: index + 2 }))];
    await beginAgentDispatch({ taskId: task.id, kind: 'model' });
    expect(task.dispatches?.find((item) => item.id === 'blocked')).toMatchObject({ materializationBlocked: true, outcome: 'failed' });
  });
  it('P4 终态只单调补记产物阻断，不改原outcome/settledAt或预算', async () => {
    const record = await beginAgentDispatch({ taskId: 'dispatch-task', kind: 'team-model', stepId: 'draft' });
    await settleAgentDispatch('dispatch-task', record, 'succeeded');
    const settled = structuredClone(fixture.tasks[0].dispatches![0]);
    await settleAgentDispatch('dispatch-task', record, 'failed', { materializationBlocked: true });
    expect(fixture.tasks[0].dispatches![0]).toEqual({ ...settled, materializationBlocked: true });
    expect(fixture.tasks[0].modelRounds).toBe(0);
  });
  it('cannot dispatch a profile task whose preparation is still pending or failed', async () => {
    for (const preparation of ['pending', 'failed'] as const) {
      fixture.tasks[0].creationProfilePreparation = preparation;
      await expect(beginAgentDispatch({ taskId: 'dispatch-task', kind: 'model' })).rejects.toThrow('准备尚未成功');
    }
    expect(fixture.save).not.toHaveBeenCalled();
  });
  it('先保存 prepared 和 dispatched，再允许执行，完成后另行保存 settled', async () => {
    const phases: string[] = [];
    fixture.save.mockImplementation(async (task: AgentTask) => { phases.push(task.dispatches!.at(-1)!.phase); });
    const record = await beginAgentDispatch({ taskId: 'dispatch-task', kind: 'tool', toolId: 'canvas_write', effect: 'canvas_write' });
    expect(phases).toEqual(['prepared', 'dispatched']);
    await settleAgentDispatch('dispatch-task', record, 'succeeded');
    expect(phases).toEqual(['prepared', 'dispatched', 'settled']);
  });

  it('保存失败暂停任务，不能进入 dispatch', async () => {
    fixture.save.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(beginAgentDispatch({ taskId: 'dispatch-task', kind: 'model' })).rejects.toBeInstanceOf(AgentDurabilityError);
    expect(fixture.tasks[0].status).toBe('paused');
    expect(fixture.tasks[0].dispatches![0].phase).toBe('prepared');
  });

  it('等待保存期间撤权时记录未开始，调用方不会拿到可执行回执', async () => {
    await expect(beginAgentDispatch({ taskId: 'dispatch-task', kind: 'tool',
      revalidate: () => { throw new Error('授权已撤销'); } })).rejects.toThrow('授权已撤销');
    expect(fixture.tasks[0].dispatches![0].phase).toBe('not_started');
  });

  it('未知写入核实后仍保留防重复提交墓碑', async () => {
    const input = { taskId: 'dispatch-task', kind: 'tool' as const, toolId: 'media_generate', effect: 'media_generation' as const, inputDigest: 'a'.repeat(64) };
    const record = await beginAgentDispatch(input);
    await settleAgentDispatch(input.taskId, record, 'unknown');
    await expect(beginAgentDispatch(input)).rejects.toThrow('结果未知');
    await expect(resolveAgentDispatchOutcome(input.taskId, record.id, 'abandoned')).rejects.toThrow('暂停');
    fixture.tasks[0].status = 'paused';
    await resolveAgentDispatchOutcome(input.taskId, record.id, 'abandoned');
    expect(fixture.tasks[0].dispatches![0].recovery?.decision).toBe('abandoned');
    fixture.tasks[0].status = 'running';
    await expect(beginAgentDispatch(input)).rejects.toThrow('结果未知');
  });

  it('核实团队调用不会制造成果；同版本普通继续不能重投，新要求版本才可新调用', async () => {
    const task = fixture.tasks[0];
    task.teamRun = { revision: 1, stages: [{ id: 'draft', status: 'pending' }], artifacts: [] } as unknown as AgentTeamRun;
    const input = { taskId: task.id, kind: 'team-model' as const, stepId: 'draft', runRevision: 1 };
    const record = await beginAgentDispatch(input); await settleAgentDispatch(task.id, record, 'unknown');
    task.status = 'paused'; await resolveAgentDispatchOutcome(task.id, record.id, 'verified_completed'); task.status = 'running';
    await expect(beginAgentDispatch(input)).rejects.toThrow('没有可恢复成果');
    task.teamRun.revision = 2;
    await expect(beginAgentDispatch({ ...input, runRevision: 2 })).resolves.toMatchObject({ phase: 'dispatched', runRevision: 2 });
    expect(task.dispatches?.find((item) => item.id === record.id)?.phase).toBe('outcome_unknown');
  });
});
