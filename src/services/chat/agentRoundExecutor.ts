import { useAppStore } from '../../store/useAppStore';
import {
  streamAssistantReply,
  type AssistantModelMessage,
} from '../ai/assistantStream';
import type {
  AgentApprovalInputRequest,
  AgentApprovalResolution,
  AgentStep,
  AgentTask,
  AgentTaskBudget,
  AgentTaskStatus,
} from '../../types/agent';
import type {
  AssistantStreamEvent,
  ProposedToolCall,
  ToolResultSummary,
} from '../../types/chat';
import {
  buildAssistantFunctionTools,
  prepareAgentToolCall,
  type AgentToolContext,
  type AgentToolEffect,
  type PreparedAgentToolCall,
} from './toolRegistry';
import { evaluateAgentToolPolicy } from './policyEngine';
import {
  estimateModelMessagesTokens,
  resolveAssistantContextSpec,
} from './contextManager';
import { drainAgentInterjections } from './agentInterjection';
import { addAgentTaskMetrics, appendAgentEvent } from './agentJournal';
import {
  findSucceededDuplicateWrite,
  fingerprintToolInput,
} from './agentCheckpointService';
import { emitAgentLifecycleEvent } from './agentLifecycle';

export interface AgentRoundCallbacks {
  onTextDelta?: (delta: string) => void;
  onComplete?: (fullText: string) => void;
  onToolResult?: (result: ToolResultSummary) => void;
  onApprovalRequired?: (step: AgentStep) => void;
  onError?: (error: string) => void;
}

export interface AgentRoundOptions {
  taskId: string;
  signal: AbortSignal;
  messages: AssistantModelMessage[];
  fullText: string;
  totalToolResultChars: number;
  callbacks?: AgentRoundCallbacks;
  transitionTask: (
    taskId: string,
    nextStatus: AgentTaskStatus,
    partial?: Partial<AgentTask>,
  ) => AgentTask;
  waitForApproval: (
    approvalId: string,
    signal: AbortSignal,
  ) => Promise<AgentApprovalResolution>;
}

export interface AgentRoundResult {
  outcome: 'continue' | 'completed' | 'paused';
  fullText: string;
  totalToolResultChars: number;
}

export interface ExecutedToolCall {
  summary: ToolResultSummary;
  modelContent: string;
}

export function getTask(taskId: string): AgentTask {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`未找到 Agent 任务: ${taskId}`);
  return task;
}

export function updateTaskSnapshot(
  taskId: string,
  updater: (task: AgentTask) => AgentTask,
): AgentTask {
  const next = updater(getTask(taskId));
  useAppStore.getState().upsertAgentTask({ ...next, id: taskId, updatedAt: Date.now() });
  return next;
}

export function appendStep(taskId: string, step: AgentStep): AgentStep {
  updateTaskSnapshot(taskId, (task) => ({
    ...task,
    steps: [...task.steps, step],
    currentStepId: step.id,
  }));
  return step;
}

export function updateStep(
  taskId: string,
  stepId: string,
  partial: Partial<AgentStep>,
): AgentStep | undefined {
  let changed: AgentStep | undefined;
  updateTaskSnapshot(taskId, (task) => ({
    ...task,
    steps: task.steps.map((step) => {
      if (step.id !== stepId) return step;
      changed = { ...step, ...partial, id: step.id, updatedAt: Date.now() };
      return changed;
    }),
  }));
  return changed;
}

export function createStepId(taskId: string, index: number): string {
  return `${taskId}-step-${index}-${Math.random().toString(36).slice(2, 6)}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/**
 * 持久化摘要脱敏：移除密钥、凭据和本地绝对路径，并截断长度。
 * 导出供安全断言复用，保证密钥/路径不会进入任务摘要或日志。
 */
export function sanitizePersistentSummary(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[已脱敏密钥]')
    .replace(/\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, '[已脱敏凭据]')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, '[本地路径]')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '[本地路径]')
    .slice(0, 1_000);
}

/**
 * 一个工具调用允许的自动重试次数。
 * 只有只读工具在瞬时错误时重试；付费媒体、画布写入、文件写入和永久删除永不自动重试。
 */
export function maxAutoRetriesForEffect(
  effect: AgentToolEffect,
  budget: AgentTaskBudget,
): number {
  return effect === 'read' ? budget.maxReadRetries : 0;
}

export async function executePreparedToolCall(
  taskId: string,
  call: ProposedToolCall,
  prepared: PreparedAgentToolCall,
  context: AgentToolContext,
  step: AgentStep,
): Promise<ExecutedToolCall> {
  const startedAt = Date.now();
  // 执行前统一重验：审批等待与并发读取期间用户可能切换项目或撤销授权。
  // revision 相同不能证明项目相同，故此处再次确认项目与工具授权后才真正执行，
  // 避免文件导入 / 媒体回填 / 画布命令把结果写进已切换的当前项目。
  const authorization = prepared.definition.authorize?.(context, prepared.input);
  const reverifyReason = useAppStore.getState().currentProjectId !== context.projectId
    ? '目标项目已切换，已取消该工具执行'
    : authorization && !authorization.allowed
      ? authorization.reason || '当前会话没有执行该工具的授权'
      : undefined;
  if (reverifyReason) {
    const message = sanitizePersistentSummary(reverifyReason);
    updateStep(taskId, step.id, {
      status: 'failed',
      errorCode: 'AGENT_TOOL_REVERIFY_FAILED',
      errorMessage: message,
      toolCall: {
        ...step.toolCall!,
        finishedAt: Date.now(),
        errorCode: 'AGENT_TOOL_REVERIFY_FAILED',
        resultSummary: message,
      },
    });
    appendAgentEvent(taskId, 'tool_end', {
      toolId: call.toolId,
      callId: call.callId,
      effect: prepared.definition.effect,
      status: 'failed',
      errorCode: 'AGENT_TOOL_REVERIFY_FAILED',
      durationMs: Date.now() - startedAt,
      retryCount: 0,
    });
    return {
      summary: {
        callId: call.callId,
        toolId: call.toolId,
        status: 'denied',
        summary: message,
        truncated: false,
      },
      modelContent: message,
    };
  }
  const checkpointBefore = prepared.definition.effect === 'canvas_write'
    ? {
        historyIndex: useAppStore.getState().historyIndex,
        revision: useAppStore.getState().getCurrentRevision(),
      }
    : undefined;
  appendAgentEvent(taskId, 'tool_start', {
    toolId: call.toolId,
    callId: call.callId,
    effect: prepared.definition.effect,
  });
  emitAgentLifecycleEvent({
    type: 'tool.execution',
    taskId,
    toolId: call.toolId,
    phase: 'start',
  });
  const maxRetries = maxAutoRetriesForEffect(
    prepared.definition.effect,
    getTask(taskId).budget,
  );
  let retryCount = 0;

  while (true) {
    try {
      const result = await prepared.definition.execute(context, prepared.input);
      if (result.status === 'error' && result.retryable && retryCount < maxRetries) {
        retryCount += 1;
        addAgentTaskMetrics(taskId, { retryCount: 1 });
        updateStep(taskId, step.id, {
          toolCall: {
            ...step.toolCall!,
            retryCount,
            errorCode: result.errorCode,
            resultSummary: sanitizePersistentSummary(result.summary),
          },
        });
        await abortableDelay(250 * (2 ** (retryCount - 1)), context.signal);
        continue;
      }

      const status = result.status === 'success' ? 'succeeded' : 'failed';
      const persistentSummary = sanitizePersistentSummary(result.summary);
      const checkpointAfter = checkpointBefore && result.status === 'success'
        ? {
            historyIndex: useAppStore.getState().historyIndex,
            revision: useAppStore.getState().getCurrentRevision(),
          }
        : undefined;
      const canvasCheckpoint = checkpointBefore && checkpointAfter
        && (
          checkpointBefore.historyIndex !== checkpointAfter.historyIndex
          || checkpointBefore.revision !== checkpointAfter.revision
        )
        ? {
            historyIndexBefore: checkpointBefore.historyIndex,
            historyIndexAfter: checkpointAfter.historyIndex,
            revisionBefore: checkpointBefore.revision,
            revisionAfter: checkpointAfter.revision,
          }
        : undefined;
      const currentToolCall = getTask(taskId).steps.find((item) => item.id === step.id)?.toolCall
        ?? step.toolCall!;
      updateStep(taskId, step.id, {
        status,
        outputSummary: persistentSummary,
        errorCode: result.errorCode,
        toolCall: {
          ...currentToolCall,
          retryCount,
          finishedAt: Date.now(),
          resultSummary: persistentSummary,
          errorCode: result.errorCode,
          canvasCheckpoint,
        },
      });
      const durationMs = Date.now() - startedAt;
      addAgentTaskMetrics(taskId, { toolDurationMs: durationMs });
      appendAgentEvent(taskId, 'tool_end', {
        toolId: call.toolId,
        callId: call.callId,
        effect: prepared.definition.effect,
        status,
        errorCode: result.errorCode,
        durationMs,
        retryCount,
      });
      emitAgentLifecycleEvent({
        type: 'tool.execution',
        taskId,
        toolId: call.toolId,
        phase: 'end',
        status,
        durationMs,
        errorCode: result.errorCode,
      });
      if (canvasCheckpoint) {
        appendAgentEvent(taskId, 'canvas_checkpoint', {
          toolId: call.toolId,
          callId: call.callId,
          ...canvasCheckpoint,
        });
      }
      const modelContentLimit = 20_000;
      const modelContent = result.modelContent.slice(0, modelContentLimit);
      return {
        summary: {
          callId: call.callId,
          toolId: call.toolId,
          status: result.status,
          summary: persistentSummary,
          truncated: (result.truncated ?? false) || result.modelContent.length > modelContentLimit,
          sources: result.sources,
        },
        modelContent,
      };
    } catch (error) {
      if (context.signal.aborted) {
        emitAgentLifecycleEvent({
          type: 'tool.execution',
          taskId,
          toolId: call.toolId,
          phase: 'end',
          status: 'stopped',
          durationMs: Date.now() - startedAt,
          errorCode: 'AGENT_STOPPED',
        });
        throw error;
      }
      if (prepared.definition.effect === 'read' && retryCount < maxRetries) {
        retryCount += 1;
        addAgentTaskMetrics(taskId, { retryCount: 1 });
        const retryMessage = sanitizePersistentSummary(
          error instanceof Error ? error.message : '只读工具执行失败',
        );
        updateStep(taskId, step.id, {
          toolCall: {
            ...step.toolCall!,
            retryCount,
            errorCode: 'AGENT_TOOL_EXCEPTION',
            resultSummary: retryMessage,
          },
        });
        await abortableDelay(250 * (2 ** (retryCount - 1)), context.signal);
        continue;
      }

      const message = sanitizePersistentSummary(
        error instanceof Error ? error.message : '工具执行失败',
      );
      updateStep(taskId, step.id, {
        status: 'failed',
        errorCode: 'AGENT_TOOL_EXCEPTION',
        errorMessage: message,
        toolCall: {
          ...step.toolCall!,
          retryCount,
          finishedAt: Date.now(),
          errorCode: 'AGENT_TOOL_EXCEPTION',
          resultSummary: message,
        },
      });
      const durationMs = Date.now() - startedAt;
      addAgentTaskMetrics(taskId, { toolDurationMs: durationMs });
      appendAgentEvent(taskId, 'tool_end', {
        toolId: call.toolId,
        callId: call.callId,
        effect: prepared.definition.effect,
        status: 'failed',
        errorCode: 'AGENT_TOOL_EXCEPTION',
        durationMs,
        retryCount,
      });
      emitAgentLifecycleEvent({
        type: 'tool.execution',
        taskId,
        toolId: call.toolId,
        phase: 'end',
        status: 'failed',
        durationMs,
        errorCode: 'AGENT_TOOL_EXCEPTION',
      });
      return {
        summary: {
          callId: call.callId,
          toolId: call.toolId,
          status: 'error',
          summary: message,
          truncated: false,
        },
        modelContent: message,
      };
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

export function prepareApprovalInput(
  prepared: PreparedAgentToolCall,
  taskGoal: string,
): {
  prepared: PreparedAgentToolCall;
  inputRequest?: AgentApprovalInputRequest;
} {
  if (
    prepared.definition.id !== 'media_generate'
    || prepared.definition.effect !== 'media_generation'
  ) {
    return { prepared };
  }

  const input = prepared.input as Record<string, unknown>;
  const mentionedModelRef = /@model\{([^|}\s]+)/i.exec(taskGoal)?.[1]?.trim();
  if (mentionedModelRef) {
    return {
      prepared: input.modelRef
        ? prepared
        : {
            ...prepared,
            input: { ...input, modelRef: mentionedModelRef },
          },
    };
  }
  const mediaKind = input.kind;
  if (mediaKind !== 'image' && mediaKind !== 'video' && mediaKind !== 'audio') {
    return { prepared };
  }

  const inputWithoutModel = { ...input };
  delete inputWithoutModel.modelRef;
  return {
    prepared: { ...prepared, input: inputWithoutModel },
    inputRequest: {
      kind: 'media_model',
      mediaKind,
    },
  };
}

export async function executeAgentRound({
  taskId,
  signal,
  messages,
  fullText,
  totalToolResultChars,
  callbacks = {},
  transitionTask,
  waitForApproval,
}: AgentRoundOptions): Promise<AgentRoundResult> {
  const initialTask = getTask(taskId);
  const contextBase = {
    taskId,
    projectId: initialTask.projectId,
    conversationId: initialTask.conversationId,
    mode: initialTask.mode,
    toolAllowlist: initialTask.toolAllowlist,
  };

  const task = getTask(taskId);
  // 模型流式返回和逐个工具审批都可能耗时较久，其间用户可能下调模式；
  // 每次策略判定前重新读取当前会话模式，确保降级（如切到 B / Plan）立即生效。
  const readCurrentMode = () => useAppStore.getState().conversations.find(
    (conversation) => conversation.id === task.conversationId,
  )?.agentMode ?? task.mode;
  const roundContext = {
    ...contextBase,
    mode: readCurrentMode(),
    baseRevision: useAppStore.getState().getCurrentRevision(),
  };
  const interjections = drainAgentInterjections(taskId);
  for (const interjection of interjections) {
    addAgentTaskMetrics(taskId, { interjectionCount: 1 });
    appendAgentEvent(taskId, 'interjection_applied', {
      interjectionId: interjection.id,
    });
    messages.push({
      role: 'user',
      content: [
        '用户在任务执行期间补充了以下要求。请结合当前进度处理，不要重复已经成功的写操作：',
        interjection.text,
      ].join('\n'),
    });
  }
  if (task.modelRounds >= task.budget.maxModelRounds) {
    transitionTask(taskId, 'paused', { pausedReason: 'model_round_budget_exhausted' });
    callbacks.onError?.('已达到模型规划轮次上限，任务已暂停');
    return { outcome: 'paused', fullText, totalToolResultChars };
  }

  // 每轮请求前按当前模型上限复核（工具 Observation 会持续增大上下文；模型可能中途切换）
  const contextSpec = resolveAssistantContextSpec();
  if (estimateModelMessagesTokens(messages) > contextSpec.inputBudget) {
    transitionTask(taskId, 'paused', {
      pausedReason: 'context_budget_exhausted',
      errorCode: 'CONTEXT_BUDGET_EXHAUSTED',
    });
    callbacks.onError?.('任务上下文已接近模型上限，任务已暂停');
    return { outcome: 'paused', fullText, totalToolResultChars };
  }

  transitionTask(taskId, 'planning');
  updateTaskSnapshot(taskId, (current) => ({
    ...current,
    modelRounds: current.modelRounds + 1,
  }));

  const proposedCalls: ProposedToolCall[] = [];
  let roundText = '';
  const tools = buildAssistantFunctionTools(roundContext);
  const modelStartedAt = Date.now();
  let roundInputTokens = 0;
  let roundOutputTokens = 0;
  appendAgentEvent(taskId, 'model_round_start');
  emitAgentLifecycleEvent({
    type: 'model.round',
    taskId,
    phase: 'start',
    round: task.modelRounds + 1,
  });
  try {
    await streamAssistantReply({
      systemPrompt: '',
      userMessage: '',
      messages,
      tools,
      signal,
      onEvent: (event: AssistantStreamEvent) => {
        if (event.type === 'text.delta') {
          roundText += event.delta;
          fullText += event.delta;
          callbacks.onTextDelta?.(event.delta);
        } else if (event.type === 'tool.call.final') {
          proposedCalls.push(event.call);
        } else if (event.type === 'error') {
          callbacks.onError?.(event.message);
        } else if (event.type === 'usage') {
          roundInputTokens += event.inputTokens ?? 0;
          roundOutputTokens += event.outputTokens ?? 0;
        }
      },
    });
  } finally {
    const durationMs = Date.now() - modelStartedAt;
    addAgentTaskMetrics(taskId, {
      inputTokens: roundInputTokens,
      outputTokens: roundOutputTokens,
      modelDurationMs: durationMs,
    });
    appendAgentEvent(taskId, 'model_round_end', {
      inputTokens: roundInputTokens,
      outputTokens: roundOutputTokens,
      durationMs,
    });
    emitAgentLifecycleEvent({
      type: 'model.round',
      taskId,
      phase: 'end',
      round: task.modelRounds + 1,
      inputTokens: roundInputTokens,
      outputTokens: roundOutputTokens,
      durationMs,
    });
  }

  if (proposedCalls.length === 0) {
    callbacks.onComplete?.(fullText);
    return { outcome: 'completed', fullText, totalToolResultChars };
  }

  const currentTask = getTask(taskId);
  if (currentTask.toolCallCount + proposedCalls.length > currentTask.budget.maxToolCalls) {
    transitionTask(taskId, 'paused', { pausedReason: 'tool_call_budget_exhausted' });
    callbacks.onError?.('已达到工具调用上限，任务已暂停');
    return { outcome: 'paused', fullText, totalToolResultChars };
  }
  updateTaskSnapshot(taskId, (current) => ({
    ...current,
    toolCallCount: current.toolCallCount + proposedCalls.length,
  }));

  messages.push({
    role: 'assistant',
    content: roundText,
    tool_calls: proposedCalls.map((call) => ({
      id: call.callId,
      type: 'function',
      function: {
        name: call.toolId,
        arguments: JSON.stringify(call.input),
      },
    })),
  });

  const results = new Map<string, ExecutedToolCall>();
  const allowedCalls: Array<{
    call: ProposedToolCall;
    prepared: PreparedAgentToolCall;
    step: AgentStep;
    context: AgentToolContext;
  }> = [];

  for (const call of proposedCalls) {
    // 逐个工具判定前刷新模式：前一个工具的审批等待期间用户下调模式也应生效。
    roundContext.mode = readCurrentMode();
    appendAgentEvent(taskId, 'tool_proposed', {
      toolId: call.toolId,
      callId: call.callId,
    });
    const preparedResult = prepareAgentToolCall(call, roundContext);
    if (!preparedResult.ok) {
      results.set(call.callId, {
        summary: preparedResult.result,
        modelContent: preparedResult.result.summary,
      });
      callbacks.onToolResult?.(preparedResult.result);
      continue;
    }

    const approvalInput = prepareApprovalInput(
      preparedResult.prepared,
      getTask(taskId).goal,
    );
    let prepared = approvalInput.prepared;
    let resolvedCall = call;
    const policy = evaluateAgentToolPolicy(
      prepared.definition,
      prepared.input,
      roundContext,
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
      const denied: ToolResultSummary = {
        callId: call.callId,
        toolId: call.toolId,
        status: 'denied',
        summary: policy.reason,
        truncated: false,
      };
      results.set(call.callId, { summary: denied, modelContent: policy.reason });
      callbacks.onToolResult?.(denied);
      continue;
    }
    addAgentTaskMetrics(taskId, {
      policyAllowed: policy.outcome === 'allow' ? 1 : 0,
      approvalCount: policy.outcome === 'require_approval' ? 1 : 0,
    });

    const now = Date.now();
    const stepIndex = getTask(taskId).steps.length;
    const stepId = createStepId(taskId, stepIndex);
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
        inputSummary: sanitizePersistentSummary(
          prepared.definition.summarizeInput
            ? prepared.definition.summarizeInput(
                prepared.input,
              )
            : '参数已通过本地 schema 校验',
        ).slice(0, 500),
        retryCount: 0,
        startedAt: now,
        effect: prepared.definition.effect,
        inputFingerprint: fingerprintToolInput(call.toolId, prepared.input),
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
    appendStep(taskId, step);

    if (policy.outcome === 'require_approval') {
      transitionTask(taskId, 'waiting_approval');
      callbacks.onApprovalRequired?.(step);
      const approvalId = step.approval!.id;
      const resolution = await waitForApproval(approvalId, signal);
      let approvalError: ToolResultSummary | undefined;
      const selectedModelRef = resolution.inputValues?.modelRef?.trim();
      if (resolution.approved && approvalInput.inputRequest) {
        if (!selectedModelRef) {
          approvalError = {
            callId: call.callId,
            toolId: call.toolId,
            status: 'denied',
            summary: '确认生成前必须选择一个可用模型',
            truncated: false,
          };
        } else {
          resolvedCall = {
            ...call,
            input: {
              ...(prepared.input as Record<string, unknown>),
              modelRef: selectedModelRef,
            },
          };
          const selectedPreparedResult = prepareAgentToolCall(resolvedCall, roundContext);
          if (!selectedPreparedResult.ok) {
            approvalError = selectedPreparedResult.result;
          } else {
            const authorization = selectedPreparedResult.prepared.definition.authorize?.(
              roundContext,
              selectedPreparedResult.prepared.input,
            );
            if (authorization && !authorization.allowed) {
              approvalError = {
                callId: call.callId,
                toolId: call.toolId,
                status: 'denied',
                summary: authorization.reason || '所选模型当前不可用',
                truncated: false,
              };
            } else {
              prepared = selectedPreparedResult.prepared;
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
      updateTaskSnapshot(taskId, (current) => ({
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
                    inputSummary: sanitizePersistentSummary(
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
                      ? {
                          ...item.approval.inputRequest,
                          selectedModelRef,
                        }
                      : undefined,
                  }
                : undefined,
            }
          : item),
      }));
      if (!resolution.approved) {
        const denied: ToolResultSummary = {
          callId: call.callId,
          toolId: call.toolId,
          status: 'denied',
          summary: '用户拒绝了本次操作',
          truncated: false,
        };
        results.set(call.callId, {
          summary: denied,
          modelContent: denied.summary,
        });
        callbacks.onToolResult?.(denied);
        transitionTask(taskId, 'running');
        continue;
      }
      if (approvalError) {
        results.set(call.callId, {
          summary: approvalError,
          modelContent: approvalError.summary,
        });
        callbacks.onToolResult?.(approvalError);
        transitionTask(taskId, 'running');
        continue;
      }
      transitionTask(taskId, 'running');
    }

    const inputFingerprint = fingerprintToolInput(call.toolId, prepared.input);
    updateStep(taskId, step.id, {
      toolCall: {
        ...(getTask(taskId).steps.find((item) => item.id === step.id)?.toolCall ?? step.toolCall!),
        inputFingerprint,
      },
    });
    const duplicate = prepared.definition.effect !== 'read'
      ? findSucceededDuplicateWrite(getTask(taskId), call.toolId, inputFingerprint, step.id)
      : undefined;
    if (duplicate) {
      const summary = duplicate.outputSummary
        || duplicate.toolCall?.resultSummary
        || '该写操作已成功执行';
      const reused: ToolResultSummary = {
        callId: call.callId,
        toolId: call.toolId,
        status: 'success',
        summary: `已复用先前成功结果：${summary}`,
        truncated: false,
      };
      updateStep(taskId, step.id, {
        status: 'succeeded',
        outputSummary: reused.summary,
        toolCall: {
          ...(getTask(taskId).steps.find((item) => item.id === step.id)?.toolCall ?? step.toolCall!),
          finishedAt: Date.now(),
          resultSummary: reused.summary,
        },
      });
      results.set(call.callId, { summary: reused, modelContent: reused.summary });
      callbacks.onToolResult?.(reused);
      continue;
    }

    allowedCalls.push({
      call: resolvedCall,
      prepared,
      step,
      context: { ...roundContext, signal },
    });
  }

  const readCalls = allowedCalls.filter((item) => item.prepared.definition.effect === 'read');
  const writeCalls = allowedCalls.filter((item) => item.prepared.definition.effect !== 'read');
  if (allowedCalls.length > 0) transitionTask(taskId, 'waiting_tool');
  await runWithConcurrency(
    readCalls,
    getTask(taskId).budget.maxParallelReadTools,
    async (item) => {
      const result = await executePreparedToolCall(
        taskId,
        item.call,
        item.prepared,
        item.context,
        item.step,
      );
      results.set(item.call.callId, result);
      callbacks.onToolResult?.(result.summary);
    },
  );
  for (const item of writeCalls) {
    const result = await executePreparedToolCall(
      taskId,
      item.call,
      item.prepared,
      item.context,
      item.step,
    );
    results.set(item.call.callId, result);
    callbacks.onToolResult?.(result.summary);
  }

  for (const call of proposedCalls) {
    const result = results.get(call.callId);
    if (!result) continue;
    const remainingToolResultChars = 200_000 - totalToolResultChars;
    if (remainingToolResultChars <= 0) {
      transitionTask(taskId, 'paused', { pausedReason: 'tool_result_budget_exhausted' });
      callbacks.onError?.('工具结果上下文已达到 200 KB 上限，任务已暂停');
      return { outcome: 'paused', fullText, totalToolResultChars };
    }
    const modelContent = result.modelContent.slice(0, remainingToolResultChars);
    totalToolResultChars += modelContent.length;
    messages.push({
      role: 'tool',
      tool_call_id: call.callId,
      content: JSON.stringify({
        status: result.summary.status,
        summary: result.summary.summary,
        result: modelContent,
        truncated: result.summary.truncated || modelContent.length < result.modelContent.length,
      }),
    });
  }

  return { outcome: 'continue', fullText, totalToolResultChars };
}
