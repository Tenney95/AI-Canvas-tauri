import type { AgentMode } from '../../types/agent';
import type { ProposedToolCall, ToolResultSummary } from '../../types/chat';
import {
  validateAgentToolInput,
  type AgentToolSchema,
} from './agentToolSchemas';

export type AgentToolEffect =
  | 'read'
  | 'canvas_write'
  | 'file_write'
  | 'permanent_delete'
  | 'media_generation'
  | 'memory_write'
  | 'config_write';

export interface AgentToolContext {
  taskId: string;
  projectId: string;
  conversationId: string;
  mode: AgentMode;
  /** 任务级工具上限；缺省表示不额外限制，空数组表示无工具。 */
  toolAllowlist?: string[];
  /** 工具提案时的画布修订号；写工具执行前必须复核。 */
  baseRevision?: number;
  signal: AbortSignal;
}

export interface AgentToolExecutionResult {
  status: 'success' | 'error';
  summary: string;
  /** 经过裁剪和脱敏、可以回传给模型的内容。 */
  modelContent: string;
  retryable?: boolean;
  truncated?: boolean;
  errorCode?: string;
}

export interface AgentToolDefinition<TInput = unknown> {
  id: string;
  title: string;
  description: string;
  inputSchema: AgentToolSchema;
  effect: AgentToolEffect;
  isAvailable?: (context: Omit<AgentToolContext, 'signal'>) => boolean;
  authorize?: (
    context: Omit<AgentToolContext, 'signal'>,
    input: TInput,
  ) => { allowed: boolean; reason?: string };
  summarizeInput?: (input: TInput) => string;
  execute: (context: AgentToolContext, input: TInput) => Promise<AgentToolExecutionResult>;
}

export interface AssistantFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: AgentToolSchema;
  };
}

export interface PreparedAgentToolCall {
  definition: AgentToolDefinition;
  input: unknown;
}

export type PrepareAgentToolCallResult =
  | { ok: true; prepared: PreparedAgentToolCall }
  | { ok: false; result: ToolResultSummary };

const registry = new Map<string, AgentToolDefinition>();

export function registerAgentTool<TInput>(definition: AgentToolDefinition<TInput>): () => void {
  if (registry.has(definition.id)) {
    throw new Error(`Agent 工具已注册: ${definition.id}`);
  }
  registry.set(definition.id, definition as AgentToolDefinition);
  return () => {
    if (registry.get(definition.id) === definition) registry.delete(definition.id);
  };
}

export function getAgentTool(toolId: string): AgentToolDefinition | undefined {
  return registry.get(toolId);
}

export function getAvailableAgentTools(
  context: Omit<AgentToolContext, 'signal'>,
): AgentToolDefinition[] {
  return [...registry.values()].filter((definition) => {
    if (context.mode === 'plan' && definition.effect !== 'read') return false;
    if (
      context.toolAllowlist !== undefined
      && !context.toolAllowlist.includes(definition.id)
    ) return false;
    return definition.isAvailable ? definition.isAvailable(context) : true;
  });
}

export function buildAssistantFunctionTools(
  context: Omit<AgentToolContext, 'signal'>,
): AssistantFunctionTool[] {
  return getAvailableAgentTools(context).map((definition) => ({
    type: 'function',
    function: {
      name: definition.id,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  }));
}

export function prepareAgentToolCall(
  call: ProposedToolCall,
  context: Omit<AgentToolContext, 'signal'>,
): PrepareAgentToolCallResult {
  const definition = registry.get(call.toolId);
  const unavailable = !definition
    || (context.mode === 'plan' && definition.effect !== 'read')
    || (
      context.toolAllowlist !== undefined
      && !context.toolAllowlist.includes(call.toolId)
    )
    || (definition.isAvailable && !definition.isAvailable(context));
  if (unavailable) {
    return {
      ok: false,
      result: {
        callId: call.callId,
        toolId: call.toolId,
        status: 'denied',
        summary: `工具不可用或未注册: ${call.toolId}`,
        truncated: false,
      },
    };
  }

  const validation = validateAgentToolInput(definition.inputSchema, call.input);
  if (!validation.valid) {
    return {
      ok: false,
      result: {
        callId: call.callId,
        toolId: call.toolId,
        status: 'error',
        summary: `工具参数无效: ${validation.errors.join('；')}`,
        truncated: false,
      },
    };
  }

  return { ok: true, prepared: { definition, input: call.input } };
}

export function clearAgentToolRegistryForTests(): void {
  registry.clear();
}
