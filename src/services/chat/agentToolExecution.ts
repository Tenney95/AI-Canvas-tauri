/**
 * 执行已注册的 Agent 工具调用，串联参数校验、Policy 决策、审批、指标和生命周期事件。
 */
import { useAppStore } from '../../store/useAppStore';
import type {
  AgentMode,
  AgentApprovalResolution,
  AgentStep,
  AgentTask,
  AgentTaskStatus,
} from '../../types/agent';
import type { ProposedToolCall, ToolResultSummary } from '../../types/chat';
import type { ExecutedToolCall } from './agentRoundExecutor';
import { appendAgentEvent } from './agentJournal';
import { evaluateAgentToolPolicy } from './policyEngine';
import { assertAgentProjectContext, captureAgentProjectScope } from './agentProjectContext';
import { parseProjectExpectedContext } from '../projectExecutionContext';
import {
  prepareAgentToolCall,
  type AgentToolContext,
} from './toolRegistry';

export interface RegisteredAgentToolCallOptions {
  taskId: string;
  call: ProposedToolCall;
  signal: AbortSignal;
  transitionTask: (
    taskId: string,
    nextStatus: AgentTaskStatus,
    partial?: Partial<AgentTask>,
  ) => AgentTask;
  waitForApproval: (
    approvalId: string,
    signal: AbortSignal,
  ) => Promise<AgentApprovalResolution>;
  /** 仅供可信本地编排层覆盖 Policy 模式；工具输入无法设置该值。 */
  policyMode?: AgentMode;
  /** 外部编排器上次读取的前置条件，不能在动态加载期间改成当前新版本。 */
  expectedContext?: Pick<AgentToolContext, 'projectId' | 'baseRevision' | 'executionContext'>;
  onApprovalRequired?: (step: AgentStep) => void;
}

function deniedResult(call: ProposedToolCall, summary: string): ToolResultSummary {
  return {
    callId: call.callId,
    toolId: call.toolId,
    status: 'denied',
    summary,
    truncated: false,
  };
}

/**
 * 执行一个已经由外部编排器提出的 Registry 工具调用。
 * 重型 round executor 只在实际调用时动态加载，避免 MCP 监听初始化把模型运行时拉回启动 chunk。
 */
export async function executeRegisteredAgentToolCall({
  taskId,
  call,
  signal,
  transitionTask,
  waitForApproval,
  policyMode,
  expectedContext,
  onApprovalRequired,
}: RegisteredAgentToolCallOptions): Promise<ExecutedToolCall> {
  // 动态加载前同步捕获caller条件，不能把加载期间的切换当成新请求目标。
  const suppliedContext = expectedContext ? { ...expectedContext,
    ...(expectedContext.executionContext ? { executionContext: parseProjectExpectedContext(expectedContext.executionContext) } : {}) } : undefined;
  const beforeLoad = useAppStore.getState();
  const beforeTask = beforeLoad.agentTasks.find((task) => task.id === taskId);
  const originalScope = beforeTask?.projectScope ?? (beforeTask ? captureAgentProjectScope(beforeLoad, beforeTask) : undefined);
  const round = await import('./agentRoundExecutor');
  round.assertAgentTaskActive(taskId, signal);
  const initialTask = round.getTask(taskId);
  const currentState = useAppStore.getState();
  if (!beforeTask || beforeTask.projectId !== initialTask.projectId || beforeTask.conversationId !== initialTask.conversationId) {
    throw new Error('CONTEXT_REFRESH_REQUIRED');
  }
  if (suppliedContext && (currentState.currentProjectId !== suppliedContext.projectId
    || (suppliedContext.baseRevision !== undefined && currentState.getCurrentRevision() !== suppliedContext.baseRevision))) {
    const summary = '读取后项目或画布版本已变化，未执行工具；请重新读取后规划，不要自动重投写入';
    return {
      summary: { ...deniedResult(call, summary), errorCode: 'TOOL_CONTEXT_CHANGED' },
      modelContent: JSON.stringify({ errorCode: 'TOOL_CONTEXT_CHANGED', summary, retryable: false }),
    };
  }
  const readCurrentMode = () => round.resolveAgentExecutionMode(round.getTask(taskId), policyMode);
  const context: AgentToolContext = {
    taskId,
    projectId: initialTask.projectId,
    conversationId: initialTask.conversationId,
    mode: readCurrentMode(),
    toolAllowlist: initialTask.toolAllowlist,
    executionContext: suppliedContext?.executionContext ?? initialTask.executionContext,
    projectScope: originalScope,
    baseRevision: suppliedContext?.baseRevision ?? currentState.getCurrentRevision(),
    signal,
  };
  assertAgentProjectContext(currentState, context);

  round.updateTaskSnapshot(taskId, (current) => ({
    ...current,
    toolCallCount: current.toolCallCount + 1,
  }));
  appendAgentEvent(taskId, 'tool_proposed', {
    toolId: call.toolId,
    callId: call.callId,
  });

  const preparedResult = prepareAgentToolCall(call, context);
  if (!preparedResult.ok) {
    return {
      summary: preparedResult.result,
      modelContent: preparedResult.result.summary,
    };
  }

  const approvalInput = round.prepareApprovalInput(
    preparedResult.prepared,
    initialTask.goal,
    readCurrentMode(),
  );
  let prepared = approvalInput.prepared;
  let resolvedCall = call;
  context.mode = readCurrentMode();
  const policy = evaluateAgentToolPolicy(
    prepared.definition,
    prepared.input,
    context,
  );
  round.recordToolPolicyDecision(taskId, call, prepared.definition.effect, policy);
  if (policy.outcome === 'deny') {
    const denied = deniedResult(call, policy.reason);
    return { summary: denied, modelContent: denied.summary };
  }
  const step = round.createAgentToolStep(taskId, call, prepared, context, policy, approvalInput.inputRequest);
  round.appendStep(taskId, step);

  if (policy.outcome === 'require_approval') {
    transitionTask(taskId, 'waiting_approval');
    onApprovalRequired?.(step);
    const approvalId = step.approval!.id;
    const resolution = await waitForApproval(approvalId, signal);
    round.assertAgentTaskActive(taskId, signal);
    context.mode = readCurrentMode();
    const selection = round.resolveApprovalSelection(call, prepared, approvalInput.inputRequest, resolution, context);
    const approvalError = selection.error;
    resolvedCall = selection.call;
    prepared = selection.prepared;
    round.updateAgentToolApprovalStep(taskId, call, step.id, approvalId, resolution, selection, context);
    transitionTask(taskId, 'running');
    if (!resolution.approved) {
      const denied = deniedResult(call, '用户拒绝了本次操作');
      return { summary: denied, modelContent: denied.summary };
    }
    if (approvalError) {
      return { summary: approvalError, modelContent: approvalError.summary };
    }
  }

  return round.executePreparedToolCall(
    taskId,
    resolvedCall,
    prepared,
    context,
    step,
    policyMode,
  );
}
