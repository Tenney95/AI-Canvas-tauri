import type { AgentMode } from '../../types/agent';
import type {
  AgentToolDefinition,
  AgentToolEffect,
} from './toolRegistry';

export type AgentPolicyDecision =
  | { outcome: 'allow'; reason: string }
  | {
      outcome: 'require_approval';
      reason: string;
      approvalKind: Exclude<AgentToolEffect, 'read'>;
    }
  | { outcome: 'deny'; reason: string; errorCode: string };

export interface AgentPolicyContext {
  mode: AgentMode;
  projectId: string;
  conversationId: string;
  taskId: string;
  baseRevision?: number;
}

export function evaluateAgentToolPolicy(
  definition: AgentToolDefinition,
  input: unknown,
  context: AgentPolicyContext,
): AgentPolicyDecision {
  const authorization = definition.authorize?.(context, input);
  if (authorization && !authorization.allowed) {
    return {
      outcome: 'deny',
      reason: authorization.reason || '当前会话没有执行该工具的授权',
      errorCode: 'AGENT_TOOL_UNAUTHORIZED',
    };
  }

  switch (definition.effect) {
    case 'read':
      return { outcome: 'allow', reason: '只读工具可自动执行' };
    case 'canvas_write':
      return context.mode === 'autonomous'
        ? { outcome: 'allow', reason: 'C 自主模式允许自动执行画布写操作' }
        : {
            outcome: 'require_approval',
            reason: 'B 协作模式的画布写操作需要确认',
            approvalKind: 'canvas_write',
          };
    case 'file_write':
      return {
        outcome: 'require_approval',
        reason: '本地文件写入始终需要确认',
        approvalKind: 'file_write',
      };
    case 'permanent_delete':
      return {
        outcome: 'require_approval',
        reason: '永久删除始终需要二次确认',
        approvalKind: 'permanent_delete',
      };
    case 'media_generation':
      return {
        outcome: 'require_approval',
        reason: '付费媒体生成和重新生成每次都需要确认',
        approvalKind: 'media_generation',
      };
    case 'memory_write':
      return {
        outcome: 'require_approval',
        reason: '项目记忆必须由用户确认后保存',
        approvalKind: 'memory_write',
      };
  }
}
