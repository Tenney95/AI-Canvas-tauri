/**
 * 受限子任务与显式团队任务的执行预算。
 *
 * 普通交互任务不因累计轮次、工具调用、token 或继续次数自动暂停；历史预算字段
 * 保留用于兼容与用量展示。只读子任务和用户显式配置的团队继续遵守各自预算，
 * 由 validateTaskResumable（继续前）和 executeAgentRound（每轮前）共同执行。
 */
import {
  DEFAULT_AGENT_TASK_BUDGET,
  type AgentTask,
  type AgentTaskBudget,
  type AgentTaskLifetimeBudget,
} from '../../types/agent';

export const AGENT_LIFETIME_BUDGET_ERROR_CODE = 'AGENT_LIFETIME_BUDGET_EXHAUSTED';
export const AGENT_LIFETIME_BUDGET_PAUSE_REASON = 'lifetime_budget_exhausted';

export interface AgentLifetimeBudgetStatus {
  exceeded: boolean;
  errorCode?: string;
  message?: string;
}

/** 普通任务及其旧记录不启用自动额度暂停；执行身份由宿主创建任务时确定。 */
export function isAgentTaskBudgetLimited(task: AgentTask): boolean {
  return !!task.parentTaskId || task.executionKind === 'team' || !!task.teamRun;
}

/** 读取任务的终身上限；旧记录缺省字段时回退到默认值。 */
export function resolveAgentLifetimeBudget(
  budget?: Partial<AgentTaskBudget>,
): AgentTaskLifetimeBudget {
  return {
    maxTotalModelRounds: budget?.maxTotalModelRounds ?? DEFAULT_AGENT_TASK_BUDGET.maxTotalModelRounds,
    maxTotalToolCalls: budget?.maxTotalToolCalls ?? DEFAULT_AGENT_TASK_BUDGET.maxTotalToolCalls,
    maxTotalTokens: budget?.maxTotalTokens ?? DEFAULT_AGENT_TASK_BUDGET.maxTotalTokens,
    maxResumes: budget?.maxResumes ?? DEFAULT_AGENT_TASK_BUDGET.maxResumes,
  };
}

/** 任务累计消耗的 token（input + output），跨全部执行段。 */
export function totalAgentTaskTokens(task: AgentTask): number {
  return (task.metrics?.inputTokens ?? 0) + (task.metrics?.outputTokens ?? 0);
}

function exhausted(message: string): AgentLifetimeBudgetStatus {
  return { exceeded: true, errorCode: AGENT_LIFETIME_BUDGET_ERROR_CODE, message };
}

/**
 * 累计用量是否已耗尽终身上限（不含继续次数）。
 * 执行中每轮复核，因此不能把「继续次数」算进来：当前这一段本身就是某次继续的产物。
 */
export function evaluateAgentLifetimeUsage(task: AgentTask): AgentLifetimeBudgetStatus {
  if (!isAgentTaskBudgetLimited(task)) return { exceeded: false };
  const limits = resolveAgentLifetimeBudget(task.budget);
  if (task.modelRounds >= limits.maxTotalModelRounds) {
    return exhausted(`任务累计模型轮次已达上限（${limits.maxTotalModelRounds} 轮），请基于当前结果新建任务`);
  }
  if (task.toolCallCount >= limits.maxTotalToolCalls) {
    return exhausted(`任务累计工具调用已达上限（${limits.maxTotalToolCalls} 次），请基于当前结果新建任务`);
  }
  const tokens = totalAgentTaskTokens(task);
  if (tokens >= limits.maxTotalTokens) {
    return exhausted(`任务累计 token 已达上限（${limits.maxTotalTokens.toLocaleString()}），请基于当前结果新建任务`);
  }
  return { exceeded: false };
}

/** 父任务与其全部子任务共用的 token 预算倍率。 */
export const AGENT_GROUP_TOKEN_MULTIPLIER = 2;

/**
 * 任务组累计用量：父任务与其全部子任务的 token 之和。
 *
 * 子智能体可并行派出多个，各自有独立的单任务预算，只靠单任务上限无法约束总开销，
 * 因此派出新子任务前必须先过这一层。
 */
export function evaluateAgentGroupUsage(
  parentTask: AgentTask,
  childTasks: AgentTask[],
): AgentLifetimeBudgetStatus {
  if (!isAgentTaskBudgetLimited(parentTask)) return { exceeded: false };
  const limits = resolveAgentLifetimeBudget(parentTask.budget);
  const groupLimit = limits.maxTotalTokens * AGENT_GROUP_TOKEN_MULTIPLIER;
  const tokens = totalAgentTaskTokens(parentTask)
    + childTasks.reduce((sum, task) => sum + totalAgentTaskTokens(task), 0);
  if (tokens >= groupLimit) {
    return exhausted(
      `本任务与其子智能体累计 token 已达上限（${groupLimit.toLocaleString()}），请基于当前结果新建任务`,
    );
  }
  return { exceeded: false };
}

/** 继续前的完整校验：累计用量 + 继续次数。 */
export function evaluateAgentResumeBudget(task: AgentTask): AgentLifetimeBudgetStatus {
  if (!isAgentTaskBudgetLimited(task)) return { exceeded: false };
  const usage = evaluateAgentLifetimeUsage(task);
  if (usage.exceeded) return usage;

  const limits = resolveAgentLifetimeBudget(task.budget);
  if ((task.resumeCount ?? 0) >= limits.maxResumes) {
    return exhausted(`任务已继续 ${limits.maxResumes} 次，达到上限，请基于当前结果新建任务`);
  }
  return { exceeded: false };
}

/**
 * 为下一段执行放宽单段额度，并夹在终身上限内。
 * 调用前应已通过 evaluateAgentResumeBudget，否则额度可能无法真正增长。
 */
export function extendAgentSegmentBudget(task: AgentTask): AgentTaskBudget {
  if (!isAgentTaskBudgetLimited(task)) return { ...task.budget };
  const limits = resolveAgentLifetimeBudget(task.budget);
  const budget = { ...task.budget };

  if (task.modelRounds >= budget.maxModelRounds) {
    budget.maxModelRounds = task.modelRounds + DEFAULT_AGENT_TASK_BUDGET.maxModelRounds;
  }
  if (task.toolCallCount >= budget.maxToolCalls) {
    budget.maxToolCalls = task.toolCallCount + DEFAULT_AGENT_TASK_BUDGET.maxToolCalls;
  }
  budget.maxModelRounds = Math.min(budget.maxModelRounds, limits.maxTotalModelRounds);
  budget.maxToolCalls = Math.min(budget.maxToolCalls, limits.maxTotalToolCalls);
  return budget;
}
