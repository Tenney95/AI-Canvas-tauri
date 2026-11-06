/**
 * 管理 AgentTask 状态机、运行时取消控制器和审批 Promise，统一约束任务状态迁移。
 */
import { isMcpSettingsToolContext } from '../mcp/mcpSettingsScope';
import { isGeneralAssistantScope, isGeneralAssistantToolContext } from './assistantScope';
import { useAppStore } from '../../store/useAppStore';
import { isWorkbenchTeamTaskInScope } from '../episodeWorkspaceScope';
import {
  AGENT_TERMINAL_STATUSES,
  type AgentApprovalResolution,
  type AgentReplanReason,
  type AgentTask,
  type AgentTaskStatus,
} from '../../types/agent';
import { evaluateAgentResumeBudget } from './agentBudgetService';
import {
  cancelConversationAgentExecutions,
  isAgentExecutionScheduled,
} from './agentScheduler';
import { appendAgentEvent } from './agentJournal';
import { emitAgentLifecycleEvent } from './agentLifecycle';
import { unmaterializedTeamDispatches, unresolvedAgentDispatches } from './agentDurabilityService';
import { assertCreationProfileSnapshot } from '../creationProfiles/creationProfileService';
import { clearAgentResults } from './agentResultService';

export type AgentExecutionOutcome =
  | 'completed'
  | 'failed'
  | 'paused'
  | 'waiting_approval';
export type AgentTaskExecutor = (signal: AbortSignal) => Promise<AgentExecutionOutcome>;

const activeControllers = new Map<string, AbortController>();
const pendingApprovalResolvers = new Map<
  string,
  (resolution: AgentApprovalResolution) => void
>();

function getTask(taskId: string): AgentTask {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`未找到 Agent 任务: ${taskId}`);
  return task;
}

const ALLOWED_TRANSITIONS: Record<AgentTaskStatus, ReadonlySet<AgentTaskStatus>> = {
  queued: new Set(['planning', 'paused', 'stopped']),
  planning: new Set([
    'running',
    'waiting_tool',
    'waiting_approval',
    'paused',
    'completed',
    'failed',
    'stopped',
  ]),
  running: new Set([
    'planning',
    'waiting_tool',
    'waiting_approval',
    'paused',
    'completed',
    'failed',
    'stopped',
  ]),
  waiting_tool: new Set(['running', 'planning', 'paused', 'failed', 'stopped']),
  waiting_approval: new Set(['running', 'planning', 'paused', 'failed', 'stopped']),
  paused: new Set(['queued', 'planning', 'stopped']),
  completed: new Set(),
  failed: new Set(['queued', 'planning', 'stopped']),
  stopped: new Set(['queued']),
};

export class InvalidAgentTaskTransitionError extends Error {
  readonly code = 'AGENT_INVALID_TRANSITION';

  constructor(from: AgentTaskStatus, to: AgentTaskStatus) {
    super(`不允许 Agent 任务从 ${from} 迁移到 ${to}`);
    this.name = 'InvalidAgentTaskTransitionError';
  }
}

export function transitionAgentTask(
  taskId: string,
  nextStatus: AgentTaskStatus,
  partial: Partial<AgentTask> = {},
): AgentTask {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`未找到 Agent 任务: ${taskId}`);
  }
  if (task.status !== nextStatus && !ALLOWED_TRANSITIONS[task.status].has(nextStatus)) {
    throw new InvalidAgentTaskTransitionError(task.status, nextStatus);
  }

  const now = Date.now();
  const nextTask: AgentTask = {
    ...task,
    ...partial,
    id: task.id,
    status: nextStatus,
    updatedAt: now,
    startedAt: partial.startedAt ?? task.startedAt ?? (
      nextStatus === 'planning' ? now : undefined
    ),
    completedAt: nextStatus === 'completed' ? now : partial.completedAt ?? task.completedAt,
  };
  store.upsertAgentTask(nextTask);
  if (task.status !== nextStatus) {
    appendAgentEvent(taskId, 'task_status', { status: nextStatus });
    emitAgentLifecycleEvent({
      type: 'task.status',
      taskId,
      projectId: nextTask.projectId,
      conversationId: nextTask.conversationId,
      status: nextStatus,
    });
  }
  return nextTask;
}

export async function runAgentTask(
  taskId: string,
  executor: AgentTaskExecutor,
): Promise<AgentTask> {
  const previous = activeControllers.get(taskId);
  previous?.abort();

  const controller = new AbortController();
  activeControllers.set(taskId, controller);

  try {
    transitionAgentTask(taskId, 'planning', {
      pausedReason: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
    transitionAgentTask(taskId, 'running');

    const outcome = await executor(controller.signal);
    const current = useAppStore.getState().agentTasks.find((task) => task.id === taskId);
    if (!current) {
      throw new Error(`Agent 任务在执行期间被删除: ${taskId}`);
    }
    if (activeControllers.get(taskId) !== controller) return current;
    if (current.status === 'paused' || current.status === 'stopped') return current;

    return transitionAgentTask(taskId, outcome, outcome === 'failed'
      ? { errorCode: 'AGENT_EXECUTION_FAILED' }
      : {});
  } catch (error) {
    const current = useAppStore.getState().agentTasks.find((task) => task.id === taskId);
    if (!current) throw error;
    if (activeControllers.get(taskId) !== controller) return current;
    if (current.status === 'paused' || current.status === 'stopped') return current;

    const aborted = controller.signal.aborted;
    return transitionAgentTask(taskId, aborted ? 'stopped' : 'failed', {
      errorCode: aborted ? 'AGENT_STOPPED' : 'AGENT_RUNTIME_ERROR',
      errorMessage: error instanceof Error ? error.message : 'Agent 任务执行失败',
    });
  } finally {
    if (activeControllers.get(taskId) === controller) {
      activeControllers.delete(taskId);
    }
  }
}

export function pauseAgentTask(taskId: string, reason = 'user_paused'): AgentTask {
  activeControllers.get(taskId)?.abort();
  return transitionAgentTask(taskId, 'paused', { pausedReason: reason });
}

/** 显式应用已有团队成果；不放宽普通已完成任务的状态机或重新调用模型。 */
export function prepareTeamTaskApplication(taskId: string): AgentTask {
  const task = getTask(taskId);
  if (task.executionKind !== 'team' || !task.teamRun?.resultArtifactId) {
    throw new Error('该任务没有可应用的团队成果');
  }
  if (activeControllers.has(taskId) || isAgentExecutionScheduled(taskId)
    || !['completed', 'failed', 'stopped', 'paused'].includes(task.status)) {
    throw new Error('任务仍在执行，请等待当前操作完成');
  }
  if (task.status !== 'completed') {
    return transitionAgentTask(taskId, 'queued', {
      pausedReason: undefined, errorCode: undefined, errorMessage: undefined,
    });
  }
  const next: AgentTask = {
    ...task, status: 'queued', updatedAt: Date.now(), completedAt: undefined,
    pausedReason: undefined, errorCode: undefined, errorMessage: undefined,
  };
  useAppStore.getState().upsertAgentTask(next);
  appendAgentEvent(taskId, 'task_status', { status: 'queued' });
  emitAgentLifecycleEvent({ type: 'task.status', taskId, projectId: task.projectId,
    conversationId: task.conversationId, status: 'queued' });
  return next;
}

export function stopAgentTask(taskId: string): AgentTask {
  clearAgentResults({ taskId });
  activeControllers.get(taskId)?.abort();
  return transitionAgentTask(taskId, 'stopped', {
    pausedReason: undefined,
    errorCode: 'AGENT_STOPPED',
  });
}

export function stopConversationAgentTasks(conversationId: string): void {
  clearAgentResults({ conversationId });
  cancelConversationAgentExecutions(conversationId);
  const tasks = useAppStore.getState().agentTasks.filter(
    (task) => task.conversationId === conversationId
      && !AGENT_TERMINAL_STATUSES.has(task.status),
  );
  for (const task of tasks) {
    activeControllers.get(task.id)?.abort();
    try {
      transitionAgentTask(task.id, 'stopped', {
        pausedReason: undefined,
        errorCode: 'AGENT_STOPPED',
      });
    } catch {
      /* 非法迁移（如已终态）忽略 */
    }
  }
}

export function stopProjectAgentTasks(projectId: string): void {
  clearAgentResults({ projectId });
  const tasks = useAppStore.getState().agentTasks.filter(
    (task) => task.projectId === projectId
      && !AGENT_TERMINAL_STATUSES.has(task.status),
  );
  for (const conversationId of new Set(tasks.map((task) => task.conversationId))) {
    cancelConversationAgentExecutions(conversationId);
  }
  for (const task of tasks) {
    activeControllers.get(task.id)?.abort();
    try {
      transitionAgentTask(task.id, 'stopped', {
        pausedReason: undefined,
        errorCode: 'AGENT_STOPPED',
      });
    } catch {
      /* 非法迁移（如已终态）忽略 */
    }
  }
}

export interface AgentResumeValidation {
  ok: boolean;
  errorCode?: string;
  message?: string;
}

export function validateTaskResumable(taskId: string): AgentResumeValidation {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) {
    return { ok: false, errorCode: 'AGENT_RESUME_TASK_NOT_FOUND', message: '任务不存在' };
  }
  // 先于状态判断：会话内有任务在跑时，恢复的任务会排队等待且状态仍是 paused，
  // 此时重复点击既会重复入队，也会白白消耗 resumeCount 与终身预算。
  if (isAgentExecutionScheduled(taskId)) {
    return {
      ok: false,
      errorCode: 'AGENT_RESUME_ALREADY_SCHEDULED',
      message: '任务已在执行队列中，请等待当前任务完成',
    };
  }
  if (!['paused', 'failed'].includes(task.status)) {
    return { ok: false, errorCode: 'AGENT_RESUME_NOT_RESUMABLE', message: '任务当前状态不支持继续' };
  }
  if (task.creationProfilePreparation && task.creationProfilePreparation !== 'ready') {
    return { ok: false, errorCode: 'CREATION_PROFILE_NOT_PREPARED',
      message: '组合包准备尚未成功完成，请等待准备完成或重新发起请求，不能跳过准备直接继续' };
  }
  try { assertCreationProfileSnapshot(task.creationProfile); }
  catch (error) { return { ok: false, errorCode: 'CREATION_PROFILE_BINDING_CHANGED',
    message: error instanceof Error ? error.message : '组合包绑定的能力已变化，请重新选择后发起任务' }; }
  if (unresolvedAgentDispatches(task).some((item) => item.effect !== 'read')) {
    return { ok: false, errorCode: 'AGENT_OUTCOME_REQUIRES_VERIFICATION',
      message: '存在已进入调用但结果未知的操作，请先核实原操作；继续不会自动重投' };
  }
  if (unmaterializedTeamDispatches(task).length) return { ok: false, errorCode: 'TEAM_UNKNOWN_RESULT_NO_ARTIFACT',
    message: '原团队调用已核实但没有可恢复成果，请补充新要求或新建任务；普通继续不会重投' };
  if (task.parentTaskId) {
    return {
      ok: false,
      errorCode: 'AGENT_EXPERT_CHILD_NOT_RESUMABLE',
      message: '专家子任务不能单独继续，请从上级任务重新规划',
    };
  }
  if (store.currentProjectId !== task.projectId && !isGeneralAssistantScope(task.projectId)
    && !isWorkbenchTeamTaskInScope(store, task)) {
    return {
      ok: false,
      errorCode: 'AGENT_RESUME_PROJECT_NOT_ACTIVE',
      message: '请先切回该任务所属项目再继续',
    };
  }
  const conversation = store.conversations.find((item) => item.id === task.conversationId);
  if (!conversation || conversation.deletedAt
    || (isGeneralAssistantScope(task.projectId) && conversation.projectId !== task.projectId)
    || (task.teamRun?.source === 'script-workbench' && conversation.projectId !== task.teamRun.target?.seriesId)) {
    return {
      ok: false,
      errorCode: 'AGENT_RESUME_CONVERSATION_GONE',
      message: '来源对话不存在或已删除，无法继续',
    };
  }
  const lifetime = evaluateAgentResumeBudget(task);
  if (lifetime.exceeded) {
    return { ok: false, errorCode: lifetime.errorCode, message: lifetime.message };
  }
  return { ok: true };
}

export function resolveAgentApproval(
  approvalId: string,
  resolution: AgentApprovalResolution,
): boolean {
  const resolver = pendingApprovalResolvers.get(approvalId);
  if (!resolver) return false;
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) =>
    item.steps.some((step) => step.approval?.id === approvalId),
  );
  const step = task?.steps.find((item) => item.approval?.id === approvalId);
  const generalApproval = !!task && isGeneralAssistantToolContext(task, step?.toolCall?.toolId ?? '')
    && store.conversations.some((conversation) => conversation.id === task.conversationId
      && conversation.projectId === task.projectId && !conversation.deletedAt);
  const workbenchApproval = !!task && isWorkbenchTeamTaskInScope(store, task, step?.toolCall?.toolId ?? '')
    && store.conversations.some((conversation) => conversation.id === task.conversationId
      && conversation.projectId === task.teamRun?.target?.seriesId && !conversation.deletedAt);
  if (
    !task
    || store.activeConversationId !== task.conversationId
    || (store.currentProjectId !== task.projectId
      && !generalApproval
      && !workbenchApproval
      && !task.steps.some((step) => step.approval?.id === approvalId
        && step.approval.kind === 'user_choice'
        && isMcpSettingsToolContext(task, step.toolCall?.toolId ?? '')))
  ) {
    return false;
  }
  resolver(resolution);
  return true;
}

/**
 * 清掉上一段执行留下的暂停/错误痕迹。
 * 注意不要清除 replanRequest：它要一直留到 Runtime 把重新规划要求写进模型上下文为止。
 */
export function prepareAgentTaskResume(taskId: string): AgentTask {
  return transitionAgentTask(taskId, 'queued', {
    pausedReason: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    completedAt: undefined,
  });
}

export function skipAgentStep(taskId: string, stepId: string): AgentTask {
  const task = getTask(taskId);
  const step = task.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`未找到 Agent 步骤: ${stepId}`);
  if (!['pending', 'waiting_approval'].includes(step.status)) {
    throw new Error(`当前步骤状态不允许跳过: ${step.status}`);
  }

  const now = Date.now();
  activeControllers.get(taskId)?.abort();
  const steps = task.steps.map((item) => item.id === stepId
    ? {
        ...item,
        status: 'skipped' as const,
        updatedAt: now,
        approval: item.approval?.status === 'pending'
          ? { ...item.approval, status: 'rejected' as const, resolvedAt: now }
          : item.approval,
      }
    : item);
  return transitionAgentTask(taskId, 'paused', {
    steps,
    currentStepId: stepId,
    pausedReason: 'step_skipped_replan_required',
    replanRequest: { requestedAt: now, reason: 'step_skipped' },
  });
}

export function requestAgentReplan(
  taskId: string,
  reason: AgentReplanReason = 'user_requested',
): AgentTask {
  activeControllers.get(taskId)?.abort();
  return transitionAgentTask(taskId, 'paused', {
    pausedReason: 'replan_requested',
    replanRequest: { requestedAt: Date.now(), reason },
  });
}

/**
 * 取出并清除待消费的重新规划请求。
 * 由 Runtime 在把指令写进模型上下文后调用，避免下一次普通「继续」重复要求重新规划。
 */
export function consumeAgentReplanRequest(taskId: string): void {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task?.replanRequest) return;
  store.updateAgentTask(taskId, { replanRequest: undefined });
}

export function waitForAgentApproval(
  approvalId: string,
  signal: AbortSignal,
): Promise<AgentApprovalResolution> {
  return new Promise<AgentApprovalResolution>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', handleAbort);
      pendingApprovalResolvers.delete(approvalId);
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    pendingApprovalResolvers.set(approvalId, (resolution) => {
      cleanup();
      resolve(resolution);
    });
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}
