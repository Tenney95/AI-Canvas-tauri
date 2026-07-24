import { useAppStore } from '../../store/useAppStore';
import type {
  AgentApprovalResolution,
  AgentStep,
  AgentTask,
  AgentTaskStatus,
} from '../../types/agent';
import type { ProposedToolCall, ToolResultSummary } from '../../types/chat';
import type { ExecutedToolCall } from './agentRoundExecutor';
import { addAgentTaskMetrics, appendAgentEvent } from './agentJournal';
import { emitAgentLifecycleEvent } from './agentLifecycle';
import { evaluateAgentToolPolicy } from './policyEngine';
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
  onApprovalRequired,
}: RegisteredAgentToolCallOptions): Promise<ExecutedToolCall> {
  const round = await import('./agentRoundExecutor');
  const initialTask = round.getTask(taskId);
  const readCurrentMode = () => useAppStore.getState().conversations.find(
    (conversation) => conversation.id === initialTask.conversationId,
  )?.agentMode ?? initialTask.mode;
  const context: AgentToolContext = {
    taskId,
    projectId: initialTask.projectId,
    conversationId: initialTask.conversationId,
    mode: readCurrentMode(),
    toolAllowlist: initialTask.toolAllowlist,
    baseRevision: useAppStore.getState().getCurrentRevision(),
    signal,
  };

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
  );
  let prepared = approvalInput.prepared;
  let resolvedCall = call;
  context.mode = readCurrentMode();
  const policy = evaluateAgentToolPolicy(
    prepared.definition,
    prepared.input,
    context,
  );
  appendAgentEvent(taskId, 'policy_decision', {
    toolId: call.toolId,
    callId: call.callId,
    effect: prepared.definition.effect,
    decision: policy.outcome === 'require_approval' ? 'require_approval' : policy.outcome,
  });
  emitAgentLifecycleEvent({
    type: 'policy.decision',
    taskId,
    toolId: call.toolId,
    effect: prepared.definition.effect,
    outcome: policy.outcome,
  });
  if (policy.outcome === 'deny') {
    addAgentTaskMetrics(taskId, { policyDenied: 1 });
    const denied = deniedResult(call, policy.reason);
    return { summary: denied, modelContent: denied.summary };
  }
  addAgentTaskMetrics(taskId, {
    policyAllowed: policy.outcome === 'allow' ? 1 : 0,
    approvalCount: policy.outcome === 'require_approval' ? 1 : 0,
  });

  const now = Date.now();
  const stepIndex = round.getTask(taskId).steps.length;
  const stepId = round.createStepId(taskId, stepIndex);
  const step: AgentStep = {
    id: stepId,
    taskId,
    index: stepIndex,
    kind: policy.outcome === 'require_approval' ? 'approval' : 'tool',
    title: prepared.definition.title,
    status: policy.outcome === 'require_approval' ? 'waiting_approval' : 'running',
    createdAt: now,
    updatedAt: now,
    toolCall: {
      callId: call.callId,
      toolId: call.toolId,
      inputSummary: round.sanitizePersistentSummary(
        prepared.definition.summarizeInput
          ? prepared.definition.summarizeInput(prepared.input)
          : '参数已通过本地 schema 校验',
      ).slice(0, 500),
      retryCount: 0,
      startedAt: now,
      effect: prepared.definition.effect,
    },
    ...(policy.outcome === 'require_approval'
      ? {
          approval: {
            id: `${stepId}-approval`,
            kind: policy.approvalKind,
            status: 'pending' as const,
            summary: policy.reason,
            requestedAt: now,
            inputRequest: approvalInput.inputRequest,
          },
        }
      : {}),
  };
  round.appendStep(taskId, step);

  if (policy.outcome === 'require_approval') {
    transitionTask(taskId, 'waiting_approval');
    onApprovalRequired?.(step);
    const approvalId = step.approval!.id;
    const resolution = await waitForApproval(approvalId, signal);
    let approvalError: ToolResultSummary | undefined;
    const selectedModelRef = resolution.inputValues?.modelRef?.trim();
    if (resolution.approved && approvalInput.inputRequest) {
      if (!selectedModelRef) {
        approvalError = deniedResult(call, '确认生成前必须选择一个可用模型');
      } else {
        resolvedCall = {
          ...call,
          input: {
            ...(prepared.input as Record<string, unknown>),
            modelRef: selectedModelRef,
          },
        };
        const selected = prepareAgentToolCall(resolvedCall, context);
        if (!selected.ok) {
          approvalError = selected.result;
        } else {
          const authorization = selected.prepared.definition.authorize?.(
            context,
            selected.prepared.input,
          );
          if (authorization && !authorization.allowed) {
            approvalError = deniedResult(
              call,
              authorization.reason || '所选模型当前不可用',
            );
          } else {
            prepared = selected.prepared;
          }
        }
      }
    }
    const canExecute = resolution.approved && !approvalError;
    appendAgentEvent(taskId, 'approval_resolved', {
      toolId: call.toolId,
      callId: call.callId,
      approved: resolution.approved,
    });
    emitAgentLifecycleEvent({
      type: 'approval.resolved',
      taskId,
      approvalId,
      approved: resolution.approved,
    });
    const resolvedAt = Date.now();
    round.updateTaskSnapshot(taskId, (current) => ({
      ...current,
      steps: current.steps.map((item) => item.id === step.id
        ? {
            ...item,
            status: canExecute ? 'running' : resolution.approved ? 'failed' : 'skipped',
            updatedAt: resolvedAt,
            errorCode: approvalError ? 'AGENT_APPROVAL_INPUT_INVALID' : item.errorCode,
            errorMessage: approvalError?.summary,
            toolCall: canExecute && item.toolCall
              ? {
                  ...item.toolCall,
                  inputSummary: round.sanitizePersistentSummary(
                    prepared.definition.summarizeInput
                      ? prepared.definition.summarizeInput(prepared.input)
                      : item.toolCall.inputSummary || '参数已通过本地 schema 校验',
                  ).slice(0, 500),
                }
              : item.toolCall,
            approval: item.approval
              ? {
                  ...item.approval,
                  status: resolution.approved ? 'approved' : 'rejected',
                  resolvedAt,
                  inputRequest: item.approval.inputRequest
                    ? { ...item.approval.inputRequest, selectedModelRef }
                    : undefined,
                }
              : undefined,
          }
        : item),
    }));
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
  );
}
