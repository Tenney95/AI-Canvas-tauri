/**
 * Agent 任务持久化服务。
 *
 * 只保存可序列化的任务快照；AbortController、活动 Promise 等运行时对象不得写入 IndexedDB。
 */
import {
  deleteAgentTask,
  deleteConversationAgentTasks,
  deleteProjectAgentTasks,
  getAgentTask,
  getConversationAgentTasks,
  getProjectAgentTasks,
  putAgentTask,
} from '../indexedDbService';
import {
  AGENT_RESTART_PAUSE_STATUSES,
  DEFAULT_AGENT_TASK_BUDGET,
  DEFAULT_AGENT_TASK_METRICS,
  type AgentStep,
  type AgentTask,
} from '../../types/agent';

function normalizeTask(task: AgentTask): AgentTask {
  return {
    ...task,
    steps: task.steps ?? [],
    modelRounds: task.modelRounds ?? 0,
    toolCallCount: task.toolCallCount ?? 0,
    budget: {
      ...DEFAULT_AGENT_TASK_BUDGET,
      ...task.budget,
    },
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
  await putAgentTask(normalizeTask(task));
}

export async function loadAgentTask(taskId: string): Promise<AgentTask | null> {
  const task = await getAgentTask(taskId);
  return task ? normalizeTask(task) : null;
}

export async function loadProjectAgentTasks(projectId: string): Promise<AgentTask[]> {
  return sortNewestFirst(await getProjectAgentTasks(projectId));
}

export async function loadConversationAgentTasks(conversationId: string): Promise<AgentTask[]> {
  return sortNewestFirst(await getConversationAgentTasks(conversationId));
}

export async function removeAgentTask(taskId: string): Promise<void> {
  await deleteAgentTask(taskId);
}

export async function removeConversationAgentTasks(conversationId: string): Promise<void> {
  await deleteConversationAgentTasks(conversationId);
}

export async function removeProjectAgentTasks(projectId: string): Promise<void> {
  await deleteProjectAgentTasks(projectId);
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
    if (!AGENT_RESTART_PAUSE_STATUSES.has(task.status)) return;

    const now = Date.now();
    const repaired: AgentTask = {
      ...task,
      status: 'paused',
      steps: task.steps.map((step) => pauseStepAfterRestart(step, now)),
      updatedAt: now,
      pausedReason: 'app_restarted',
    };
    await putAgentTask(repaired);
    repairedIds.push(repaired.id);
  }));

  return repairedIds;
}
