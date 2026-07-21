import { useAppStore } from '../../store/useAppStore';
import {
  DEFAULT_AGENT_TASK_METRICS,
  type AgentEvent,
  type AgentEventData,
  type AgentEventType,
  type AgentTaskMetrics,
} from '../../types/agent';

export const MAX_AGENT_EVENTS = 200;

const ALLOWED_EVENT_DATA_KEYS = new Set<keyof AgentEventData>([
  'status',
  'toolId',
  'callId',
  'effect',
  'decision',
  'approved',
  'errorCode',
  'inputTokens',
  'outputTokens',
  'durationMs',
  'retryCount',
  'revisionBefore',
  'revisionAfter',
  'historyIndexBefore',
  'historyIndexAfter',
  'interjectionId',
]);

function sanitizeString(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, '[local-path]')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '[local-path]')
    .slice(0, 128);
}

export function sanitizeAgentEventData(data?: AgentEventData): AgentEventData | undefined {
  if (!data) return undefined;
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(data)) {
    const key = rawKey as keyof AgentEventData;
    if (!ALLOWED_EVENT_DATA_KEYS.has(key)) continue;
    if (typeof rawValue === 'string') sanitized[key] = sanitizeString(rawValue);
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) sanitized[key] = rawValue;
    else if (typeof rawValue === 'boolean') sanitized[key] = rawValue;
  }
  return Object.keys(sanitized).length > 0 ? sanitized as AgentEventData : undefined;
}

export function appendAgentEvent(
  taskId: string,
  type: AgentEventType,
  data?: AgentEventData,
): AgentEvent | null {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) return null;
  const previous = task.events ?? [];
  const sequence = (previous.at(-1)?.sequence ?? -1) + 1;
  const event: AgentEvent = {
    id: `${taskId}-event-${sequence}`,
    taskId,
    sequence,
    type,
    timestamp: Date.now(),
    data: sanitizeAgentEventData(data),
  };
  store.upsertAgentTask({
    ...task,
    events: [...previous, event].slice(-MAX_AGENT_EVENTS),
    updatedAt: Date.now(),
  });
  return event;
}

export function addAgentTaskMetrics(
  taskId: string,
  delta: Partial<AgentTaskMetrics>,
): AgentTaskMetrics | null {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) return null;
  const current = { ...DEFAULT_AGENT_TASK_METRICS, ...task.metrics };
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_AGENT_TASK_METRICS) as Array<keyof AgentTaskMetrics>) {
    const value = delta[key];
    if (typeof value === 'number' && Number.isFinite(value)) next[key] += Math.max(0, value);
  }
  store.upsertAgentTask({ ...task, metrics: next, updatedAt: Date.now() });
  return next;
}
