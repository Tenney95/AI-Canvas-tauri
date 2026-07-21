export interface ConversationAgentExecution {
  taskId: string;
  conversationId: string;
  run: () => Promise<void>;
  onStart?: () => void;
  onError?: (error: unknown) => void;
}

export interface AgentScheduleResult {
  state: 'started' | 'queued';
  position: number;
}

interface ConversationQueueState {
  activeTaskId?: string;
  pending: ConversationAgentExecution[];
}

const queues = new Map<string, ConversationQueueState>();

function getOrCreateState(conversationId: string): ConversationQueueState {
  const existing = queues.get(conversationId);
  if (existing) return existing;
  const created: ConversationQueueState = { pending: [] };
  queues.set(conversationId, created);
  return created;
}

function startExecution(
  state: ConversationQueueState,
  execution: ConversationAgentExecution,
): void {
  state.activeTaskId = execution.taskId;
  execution.onStart?.();
  void Promise.resolve()
    .then(execution.run)
    .catch((error) => execution.onError?.(error))
    .finally(() => {
      if (queues.get(execution.conversationId) !== state) return;
      if (state.activeTaskId !== execution.taskId) return;
      state.activeTaskId = undefined;
      const next = state.pending.shift();
      if (next) {
        startExecution(state, next);
      } else {
        queues.delete(execution.conversationId);
      }
    });
}

export function scheduleConversationAgentExecution(
  execution: ConversationAgentExecution,
): AgentScheduleResult {
  const state = getOrCreateState(execution.conversationId);
  if (!state.activeTaskId) {
    startExecution(state, execution);
    return { state: 'started', position: 0 };
  }
  state.pending.push(execution);
  return { state: 'queued', position: state.pending.length };
}

export function cancelScheduledAgentExecution(taskId: string): boolean {
  for (const [conversationId, state] of queues) {
    const index = state.pending.findIndex((item) => item.taskId === taskId);
    if (index < 0) continue;
    state.pending.splice(index, 1);
    if (!state.activeTaskId && state.pending.length === 0) queues.delete(conversationId);
    return true;
  }
  return false;
}

export function cancelConversationAgentExecutions(conversationId: string): string[] {
  const state = queues.get(conversationId);
  if (!state) return [];
  const canceled = state.pending.map((item) => item.taskId);
  state.pending = [];
  if (!state.activeTaskId) queues.delete(conversationId);
  return canceled;
}

export function getActiveConversationAgentTaskId(conversationId: string): string | undefined {
  return queues.get(conversationId)?.activeTaskId;
}

export function getConversationAgentQueueTaskIds(conversationId: string): string[] {
  return queues.get(conversationId)?.pending.map((item) => item.taskId) ?? [];
}

export function resetAgentSchedulerForTests(): void {
  queues.clear();
}
