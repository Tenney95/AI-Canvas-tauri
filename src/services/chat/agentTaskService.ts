/**
 * Agent 任务持久化服务。
 *
 * 只保存可序列化的任务快照；AbortController、活动 Promise 等运行时对象不得写入 IndexedDB。
 */
import {
  claimMcpAgentTask,
  deleteAgentTask,
  deleteConversationAgentTasks,
  deleteProjectAgentTasks,
  getAgentTask,
  getConversationAgentTasks,
  getProjectAgentTasks,
  putAgentTask,
  updateTeamRunCAS,
} from '../indexedDbService';
import {
  AGENT_RESTART_PAUSE_STATUSES,
  DEFAULT_AGENT_TASK_BUDGET,
  DEFAULT_AGENT_TASK_METRICS,
  type AgentStep,
  type AgentTask,
  type AgentDispatchRecord,
} from '../../types/agent';
import { clearAgentResults } from './agentResultService';

const taskWrites = new Map<string, Promise<void>>();
const removedTasks = new Set<string>();
const taskScopes = new Map<string, { projectId: string; conversationId: string }>();
const scopeDeletes = new Map<string, Promise<void>>();

function queueTaskWrite<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  const next = (taskWrites.get(taskId) ?? Promise.resolve()).then(operation, operation);
  const settled = next.then(() => undefined, () => undefined);
  taskWrites.set(taskId, settled);
  void settled.finally(() => { if (taskWrites.get(taskId) === settled) taskWrites.delete(taskId); });
  return next;
}

function normalizeTask(task: AgentTask): AgentTask {
  taskScopes.set(task.id, { projectId: task.projectId, conversationId: task.conversationId });
  return {
    ...task,
    steps: task.steps ?? [],
    modelRounds: task.modelRounds ?? 0,
    toolCallCount: task.toolCallCount ?? 0,
    resumeCount: task.resumeCount ?? 0,
    budget: {
      ...DEFAULT_AGENT_TASK_BUDGET,
      ...task.budget,
    },
    skillBindings: Array.isArray(task.skillBindings)
      ? task.skillBindings.map((binding) => ({
        ...binding,
        allowedTools: binding.allowedTools ? [...binding.allowedTools] : undefined,
      }))
      : undefined,
    events: task.events ?? [],
    metrics: {
      ...DEFAULT_AGENT_TASK_METRICS,
      ...task.metrics,
    },
  };
}

function sortNewestFirst(tasks: AgentTask[]): AgentTask[] {
  return tasks.map(normalizeTask).sort((a, b) => b.updatedAt - a.updatedAt);
}

function pauseStepAfterRestart(step: AgentStep, now: number): AgentStep {
  if (step.status !== 'running' && step.status !== 'waiting_approval') {
    return step;
  }

  return {
    ...step,
    status: 'pending',
    updatedAt: now,
    approval: step.approval?.status === 'pending'
      ? { ...step.approval, status: 'expired', resolvedAt: now }
      : step.approval,
  };
}

export async function saveAgentTask(task: AgentTask): Promise<void> {
  const snapshot = structuredClone(normalizeTask(task));
  const barriers = [scopeDeletes.get(`conversation:${task.conversationId}`), scopeDeletes.get(`project:${task.projectId}`)];
  await queueTaskWrite(task.id, async () => {
    await Promise.all(barriers);
    if (removedTasks.has(snapshot.id)) throw new Error('任务已删除，不能保存旧执行结果');
    await putAgentTask(snapshot);
  });
}

export async function claimMcpOperationTask(task: AgentTask) {
  const snapshot = structuredClone(normalizeTask(task));
  const barriers = [scopeDeletes.get(`conversation:${task.conversationId}`), scopeDeletes.get(`project:${task.projectId}`)];
  return queueTaskWrite(task.id, async () => {
    await Promise.all(barriers);
    if (removedTasks.has(task.id)) throw new Error('任务已删除，不能重新占用旧操作');
    return claimMcpAgentTask(snapshot);
  });
}

export async function loadAgentTask(taskId: string): Promise<AgentTask | null> {
  const task = await getAgentTask(taskId);
  return task ? normalizeTask(task) : null;
}

export async function loadProjectAgentTasks(projectId: string): Promise<AgentTask[]> {
  return sortNewestFirst(await getProjectAgentTasks(projectId));
}

export async function removeAgentTask(taskId: string): Promise<void> {
  clearAgentResults({ taskId });
  removedTasks.add(taskId);
  await queueTaskWrite(taskId, () => deleteAgentTask(taskId));
}

async function removeScopeTasks(
  key: string,
  matches: (scope: { projectId: string; conversationId: string }) => boolean,
  readTasks: () => Promise<AgentTask[]>,
  remove: () => Promise<void>,
): Promise<void> {
  const previous = scopeDeletes.get(key);
  const oldIds = [...taskScopes].filter(([, scope]) => matches(scope)).map(([id]) => id);
  for (const id of oldIds) removedTasks.add(id);
  const oldWrites = oldIds.map((id) => taskWrites.get(id));
  const deletion = (async () => {
    // 只等待调用时的旧写入。后来创建的新 task 会等本次删除，不能反过来等它。
    await Promise.all([previous, ...oldWrites]);
    for (const task of await readTasks()) removedTasks.add(task.id);
    await remove();
  })();
  scopeDeletes.set(key, deletion);
  try { await deletion; }
  finally { if (scopeDeletes.get(key) === deletion) scopeDeletes.delete(key); }
}

export async function removeConversationAgentTasks(conversationId: string): Promise<void> {
  clearAgentResults({ conversationId });
  await removeScopeTasks(`conversation:${conversationId}`, (scope) => scope.conversationId === conversationId,
    () => getConversationAgentTasks(conversationId), () => deleteConversationAgentTasks(conversationId));
}

export async function removeProjectAgentTasks(projectId: string): Promise<void> {
  clearAgentResults({ projectId });
  await removeScopeTasks(`project:${projectId}`, (scope) => scope.projectId === projectId,
    () => getProjectAgentTasks(projectId), () => deleteProjectAgentTasks(projectId));
}

/**
 * 应用启动后不自动续跑旧任务。
 * 所有非终态任务改为 paused，活动步骤回到 pending，旧审批失效并等待重新校验。
 */
export async function repairInterruptedAgentTasks(projectId: string): Promise<string[]> {
  const tasks = await getProjectAgentTasks(projectId);
  const repairedIds: string[] = [];

  await Promise.all(tasks.map(async (rawTask) => {
    const task = normalizeTask(rawTask);
    if (!AGENT_RESTART_PAUSE_STATUSES.has(task.status)
      && !task.dispatches?.some((item) => item.phase === 'prepared' || item.phase === 'dispatched')) return;

    const now = Date.now();
    const dispatches = (task.dispatches ?? []).map<AgentDispatchRecord>((item) => item.phase === 'prepared'
      ? { ...item, phase: 'not_started' } : item.phase === 'dispatched' ? { ...item, phase: 'outcome_unknown' } : item);
    // 旧快照没有精确执行边界，运行中的写入不能被推断为尚未开始。
    for (const step of task.steps) {
      if (step.status !== 'running' || !step.toolCall || step.toolCall.effect === 'read'
        || dispatches.some((item) => item.stepId === step.id)) continue;
      dispatches.push({ id: `legacy-${step.id}`, kind: 'tool', phase: 'outcome_unknown',
        stepId: step.id, toolId: step.toolCall.toolId, effect: step.toolCall.effect,
        preparedAt: step.toolCall.startedAt ?? step.createdAt });
    }
    const teamRun = task.teamRun ? structuredClone(task.teamRun) : undefined;
    if (teamRun && Array.isArray(teamRun.stages)) {
      for (const stage of teamRun.stages) {
        if (stage.status === 'running' && !dispatches.some((item) => item.stepId === stage.id)) {
          dispatches.push({ id: `legacy-team-${stage.id}-${stage.attempts}`, kind: 'team-model',
            stepId: stage.id, runRevision: teamRun.revision, phase: 'outcome_unknown', preparedAt: stage.startedAt ?? now });
        }
      }
      teamRun.stages = teamRun.stages.map((stage) => stage.status === 'running'
        ? { ...stage, status: 'pending', errorMessage: '应用已重启，当前阶段待用户确认后继续' } : stage);
      const unreported = [teamRun.callsUsed, teamRun.usageReportedCalls, teamRun.unknownUsageCalls].every(Number.isSafeInteger)
        ? Math.max(0, teamRun.callsUsed - teamRun.usageReportedCalls - teamRun.unknownUsageCalls) : 0;
      teamRun.unknownUsageCalls += unreported;
      if (unreported) teamRun.usageKnown = false;
    }
    const repaired: AgentTask = {
      ...task,
      status: 'paused',
      steps: task.steps.map((step) => pauseStepAfterRestart(step, now)),
      dispatches,
      updatedAt: now,
      pausedReason: 'app_restarted',
      ...(teamRun ? { teamRun } : {}),
    };
    if (teamRun?.version === 2) {
      const persisted = await updateTeamRunCAS(task.id,
        { revision: task.teamRun!.revision, boardRevision: task.teamRun!.boardRevision ?? 0 },
        () => ({ ...teamRun, boardRevision: (teamRun.boardRevision ?? 0) + 1 }));
      repaired.teamRun = persisted.teamRun;
    }
    await saveAgentTask(repaired);
    repairedIds.push(repaired.id);
  }));

  return repairedIds;
}
