import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TASK_BUDGET, type AgentTask } from '../../../src/types/agent';
import type { AgentTeamRun } from '../../../src/types/agentTeam';

const fixture = vi.hoisted(() => ({ tasks: [] as AgentTask[], save: vi.fn() }));
vi.mock('../../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({
  agentTasks: fixture.tasks,
  updateAgentTask: (id: string, patch: Partial<AgentTask>) => { Object.assign(fixture.tasks.find((task) => task.id === id)!, patch); },
}) } }));
vi.mock('../../../src/services/chat/agentTaskService', () => ({ saveAgentTask: fixture.save }));
import { beginAgentDispatch, settleAgentDispatch, resolveAgentDispatchOutcome, AgentDurabilityError } from '../../../src/services/chat/agentDurabilityService';

beforeEach(() => {
  fixture.tasks = [{ id: 'dispatch-task', projectId: 'project', conversationId: 'conv', userMessageId: 'message',
    mode: 'autonomous', goal: '任务', status: 'running', steps: [], modelRounds: 0, toolCallCount: 0,
    budget: { ...DEFAULT_AGENT_TASK_BUDGET }, createdAt: 1, updatedAt: 1 }];
  fixture.save.mockReset().mockResolvedValue(undefined);
});

describe('Agent 执行持久化屏障', () => {
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
