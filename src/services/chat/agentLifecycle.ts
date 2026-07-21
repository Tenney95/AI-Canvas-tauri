import type {
  AgentExpertRole,
  AgentStepStatus,
  AgentTaskStatus,
} from '../../types/agent';
import type { AgentToolEffect } from './toolRegistry';

export type AgentLifecycleEventInput =
  | {
      type: 'task.status';
      taskId: string;
      projectId: string;
      conversationId: string;
      status: AgentTaskStatus;
    }
  | {
      type: 'model.round';
      taskId: string;
      phase: 'start' | 'end';
      round: number;
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
    }
  | {
      type: 'policy.decision';
      taskId: string;
      toolId: string;
      effect: AgentToolEffect;
      outcome: 'allow' | 'deny' | 'require_approval';
    }
  | {
      type: 'tool.execution';
      taskId: string;
      toolId: string;
      phase: 'start' | 'end';
      status?: AgentStepStatus;
      durationMs?: number;
      errorCode?: string;
    }
  | {
      type: 'approval.resolved';
      taskId: string;
      approvalId: string;
      approved: boolean;
    }
  | {
      type: 'context.compression';
      conversationId: string;
      phase: 'start' | 'end';
      outcome?: 'succeeded' | 'skipped' | 'failed';
      errorCode?: string;
    }
  | {
      type: 'expert.task';
      parentTaskId: string;
      childTaskId: string;
      role: AgentExpertRole;
      phase: 'start' | 'end';
      outcome?: 'completed' | 'failed' | 'stopped';
      errorCode?: string;
    };

export type AgentLifecycleEvent = AgentLifecycleEventInput & {
  id: string;
  timestamp: number;
};

export type AgentLifecycleListener = (
  event: Readonly<AgentLifecycleEvent>,
) => void | Promise<void>;

const listeners = new Set<AgentLifecycleListener>();
let sequence = 0;

function reportListenerFailure(eventType: AgentLifecycleEvent['type']): void {
  console.warn(`[agent.lifecycle] 监听器处理 ${eventType} 失败，已隔离`);
}

export function subscribeAgentLifecycle(listener: AgentLifecycleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 广播只读生命周期快照；监听器失败不会回传到 Runtime 或 Policy。 */
export function emitAgentLifecycleEvent(
  input: AgentLifecycleEventInput,
): AgentLifecycleEvent {
  sequence += 1;
  const event = Object.freeze({
    ...input,
    id: `agent-lifecycle-${Date.now().toString(36)}-${sequence.toString(36)}`,
    timestamp: Date.now(),
  }) as AgentLifecycleEvent;

  for (const listener of [...listeners]) {
    try {
      const result = listener(event);
      if (result && typeof result.then === 'function') {
        void result.catch(() => reportListenerFailure(event.type));
      }
    } catch {
      reportListenerFailure(event.type);
    }
  }
  return event;
}

export function clearAgentLifecycleListenersForTests(): void {
  listeners.clear();
  sequence = 0;
}
