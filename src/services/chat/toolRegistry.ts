/**
 * Agent 工具的注册、可用性过滤与本地 schema 校验中心；实际权限仍由 Policy Engine 决定。
 */
import type { AgentMode, AgentToolDisplaySnapshot } from '../../types/agent';
import type { ProposedToolCall, ToolResultSummary, WebSource } from '../../types/chat';
import type { McpContent } from '../../types/mcp';
import {
  validateAgentToolInput,
  type AgentToolSchema,
} from './agentToolSchemas';

export type AgentToolEffect =
  | 'read'
  /** 不改任何东西，但必须由用户作答；任何模式下都会弹卡片等待，不会自动执行 */
  | 'user_choice'
  | 'canvas_write'
  | 'file_write'
  | 'permanent_delete'
  | 'media_generation'
  | 'memory_write'
  | 'config_write'
  | 'asset_write';

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
  sources?: WebSource[];
  /** 面向用户的脱敏结果详情；不得包含本地路径、密钥或完整媒体 URL。 */
  display?: AgentToolDisplaySnapshot;
  /** 仅由 MCP 控制层返回的瞬时富内容；不得进入模型上下文、消息或任务持久化。 */
  mcpContent?: McpContent[];
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
  /** 构建审批和时间线使用的脱敏参数详情；异常时执行器会退化为摘要。 */
  buildInputDisplay?: (
    input: TInput,
    context: Omit<AgentToolContext, 'signal'>,
  ) => AgentToolDisplaySnapshot;
  /** 在策略与审批前把项目默认值解析进输入，形成执行期间不可变的有效参数。 */
  resolveInput?: (
    input: TInput,
    context: Omit<AgentToolContext, 'signal'>,
  ) => TInput;
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

/** 注册编排专用：取当前已注册工具 ID 的快照。 */
export function snapshotAgentToolIds(): Set<string> {
  return new Set(registry.keys());
}

/**
 * 注册编排专用：按 ID 移除工具。
 *
 * 仅供失败回滚使用：某个注册函数在中途抛错时，它内部已注册但尚未返回注销函数的
 * 工具无法通过注销回调回收，只能按注册前快照的差异集合兜底清理。
 */
export function removeAgentToolsById(toolIds: Iterable<string>): void {
  for (const toolId of toolIds) registry.delete(toolId);
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
    if (!definition.isAvailable) return true;
    try {
      return definition.isAvailable(context);
    } catch (error) {
      // 单个工具的可用性判断出错不应拖垮整份列表（例如 MCP 工具发现没有真实任务上下文）。
      console.error(`[AgentToolRegistry] isAvailable failed for ${definition.id}:`, error);
      return false;
    }
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

  let resolvedInput: unknown;
  try {
    resolvedInput = definition.resolveInput
      ? definition.resolveInput(call.input, context)
      : call.input;
  } catch (error) {
    return {
      ok: false,
      result: {
        callId: call.callId,
        toolId: call.toolId,
        status: 'error',
        summary: `工具参数解析失败: ${error instanceof Error ? error.message : '未知错误'}`,
        truncated: false,
      },
    };
  }
  const resolvedValidation = validateAgentToolInput(definition.inputSchema, resolvedInput);
  if (!resolvedValidation.valid) {
    return {
      ok: false,
      result: {
        callId: call.callId,
        toolId: call.toolId,
        status: 'error',
        summary: `工具有效参数无效: ${resolvedValidation.errors.join('；')}`,
        truncated: false,
      },
    };
  }

  return { ok: true, prepared: { definition, input: resolvedInput } };
}

export function clearAgentToolRegistryForTests(): void {
  registry.clear();
}
