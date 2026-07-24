import { useAppStore } from '../../store/useAppStore';
import {
  AGENT_TERMINAL_STATUSES,
  type AgentApprovalResolution,
  type AgentTask,
  type AgentTaskStatus,
} from '../../types/agent';
import { cancelConversationAgentExecutions } from './agentScheduler';
import { appendAgentEvent } from './agentJournal';
import { emitAgentLifecycleEvent } from './agentLifecycle';

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

export function stopAgentTask(taskId: string): AgentTask {
  activeControllers.get(taskId)?.abort();
  return transitionAgentTask(taskId, 'stopped', {
    pausedReason: undefined,
    errorCode: 'AGENT_STOPPED',
  });
}

export function stopConversationAgentTasks(conversationId: string): void {
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
  if (!['paused', 'failed'].includes(task.status)) {
    return { ok: false, errorCode: 'AGENT_RESUME_NOT_RESUMABLE', message: '任务当前状态不支持继续' };
  }
  if (task.parentTaskId) {
    return {
      ok: false,
      errorCode: 'AGENT_EXPERT_CHILD_NOT_RESUMABLE',
      message: '专家子任务不能单独继续，请从上级任务重新规划',
    };
  }
  if (store.currentProjectId !== task.projectId) {
    return {
      ok: false,
      errorCode: 'AGENT_RESUME_PROJECT_NOT_ACTIVE',
      message: '请先切回该任务所属项目再继续',
    };
  }
  const conversation = store.conversations.find((item) => item.id === task.conversationId);
  if (!conversation || conversation.deletedAt) {
    return {
      ok: false,
      errorCode: 'AGENT_RESUME_CONVERSATION_GONE',
      message: '来源对话不存在或已删除，无法继续',
    };
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
  if (
    !task
    || store.activeConversationId !== task.conversationId
    || store.currentProjectId !== task.projectId
  ) {
    return false;
  }
  resolver(resolution);
  return true;
}

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
  });
}

export function requestAgentReplan(taskId: string): AgentTask {
  activeControllers.get(taskId)?.abort();
  return transitionAgentTask(taskId, 'paused', {
    pausedReason: 'replan_requested',
  });
}

export function isAgentTaskRunning(taskId: string): boolean {
  return activeControllers.has(taskId);
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
