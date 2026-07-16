/**
 * Agent Runtime 骨架。
 *
 * P3-A2 只负责任务状态和中止控制；多轮规划、工具预算和审批将在 P3-B 接入。
 */
import { useAppStore } from '../../store/useAppStore';
import {
  streamAssistantReply,
  type AssistantModelMessage,
} from '../ai/assistantStream';
import type {
  AgentStep,
  AgentTask,
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
  type PreparedAgentToolCall,
} from './toolRegistry';
import { evaluateAgentToolPolicy } from './policyEngine';
import {
  assembleAgentContext,
  estimateModelMessagesTokens,
  resolveAssistantContextSpec,
  ContextBudgetError,
} from './contextManager';

export type AgentExecutionOutcome =
  | 'completed'
  | 'failed'
  | 'paused'
  | 'waiting_approval';
export type AgentTaskExecutor = (signal: AbortSignal) => Promise<AgentExecutionOutcome>;

const activeControllers = new Map<string, AbortController>();
const pendingApprovalResolvers = new Map<string, (approved: boolean) => void>();

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
    if (current.status === 'paused' || current.status === 'stopped') return current;

    return transitionAgentTask(taskId, outcome, outcome === 'failed'
      ? { errorCode: 'AGENT_EXECUTION_FAILED' }
      : {});
  } catch (error) {
    const current = useAppStore.getState().agentTasks.find((task) => task.id === taskId);
    if (!current) throw error;
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

export function resolveAgentApproval(approvalId: string, approved: boolean): boolean {
  const resolver = pendingApprovalResolvers.get(approvalId);
  if (!resolver) return false;
  resolver(approved);
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

export interface AgentLoopCallbacks {
  onTextDelta?: (delta: string) => void;
  onComplete?: (fullText: string) => void;
  onToolResult?: (result: ToolResultSummary) => void;
  onApprovalRequired?: (step: AgentStep) => void;
  onError?: (error: string) => void;
}

export interface AgentLoopOptions {
  taskId: string;
  systemPrompt: string;
  userMessage: string;
  signal: AbortSignal;
  callbacks?: AgentLoopCallbacks;
  /** 当前轮已在界面新建的消息 ID（用户消息、助手占位），组装历史时排除 */
  excludeMessageIds?: string[];
}

interface ExecutedToolCall {
  summary: ToolResultSummary;
  modelContent: string;
}

function getTask(taskId: string): AgentTask {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`未找到 Agent 任务: ${taskId}`);
  return task;
}

function updateTaskSnapshot(
  taskId: string,
  updater: (task: AgentTask) => AgentTask,
): AgentTask {
  const next = updater(getTask(taskId));
  useAppStore.getState().upsertAgentTask({ ...next, id: taskId, updatedAt: Date.now() });
  return next;
}

function appendStep(taskId: string, step: AgentStep): AgentStep {
  updateTaskSnapshot(taskId, (task) => ({
    ...task,
    steps: [...task.steps, step],
    currentStepId: step.id,
  }));
  return step;
}

function updateStep(
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

function createStepId(taskId: string, index: number): string {
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

function sanitizePersistentSummary(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[已脱敏密钥]')
    .replace(/\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, '[已脱敏凭据]')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, '[本地路径]')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '[本地路径]')
    .slice(0, 1_000);
}

async function executePreparedToolCall(
  taskId: string,
  call: ProposedToolCall,
  prepared: PreparedAgentToolCall,
  context: AgentToolContext,
  step: AgentStep,
): Promise<ExecutedToolCall> {
  const maxRetries = prepared.definition.effect === 'read'
    ? getTask(taskId).budget.maxReadRetries
    : 0;
  let retryCount = 0;

  while (true) {
    try {
      const result = await prepared.definition.execute(context, prepared.input);
      if (result.status === 'error' && result.retryable && retryCount < maxRetries) {
        retryCount += 1;
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
      updateStep(taskId, step.id, {
        status,
        outputSummary: persistentSummary,
        errorCode: result.errorCode,
        toolCall: {
          ...step.toolCall!,
          retryCount,
          finishedAt: Date.now(),
          resultSummary: persistentSummary,
          errorCode: result.errorCode,
        },
      });
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
      if (context.signal.aborted) throw error;
      if (prepared.definition.effect === 'read' && retryCount < maxRetries) {
        retryCount += 1;
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
      return {
        summary: {
          callId: call.callId,
          toolId: call.toolId,
          status: 'error',
          summary: message,
          truncated: false,
          sources: undefined,
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

function waitForAgentApproval(
  approvalId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', handleAbort);
      pendingApprovalResolvers.delete(approvalId);
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    pendingApprovalResolvers.set(approvalId, (approved) => {
      cleanup();
      resolve(approved);
    });
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
  });
}

/**
 * 多轮“模型 → 工具 → Observation → 模型”循环。
 *
 * P3-B1 提供通用循环；具体画布和媒体工具在 P3-B2 注册。
 */
export async function runAgentLoop({
  taskId,
  systemPrompt,
  userMessage,
  signal,
  callbacks = {},
  excludeMessageIds,
}: AgentLoopOptions): Promise<AgentExecutionOutcome> {
  const initialTask = getTask(taskId);
  const contextBase = {
    taskId,
    projectId: initialTask.projectId,
    conversationId: initialTask.conversationId,
    mode: initialTask.mode,
  };

  // 按当前模型上下文预算组装历史；接近上限时自动压缩，压缩失败不发送超限请求
  let messages: AssistantModelMessage[];
  try {
    const assembled = await assembleAgentContext({
      conversationId: initialTask.conversationId,
      projectId: initialTask.projectId,
      systemPrompt,
      userMessage,
      excludeMessageIds,
      signal,
    });
    messages = assembled.messages;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ContextBudgetError) {
      transitionAgentTask(taskId, 'paused', {
        pausedReason: 'context_compression_failed',
        errorCode: error.code,
      });
      callbacks.onError?.(error.message);
      return 'paused';
    }
    throw error;
  }
  let fullText = '';
  let totalToolResultChars = 0;

  while (!signal.aborted) {
    const task = getTask(taskId);
    const currentMode = useAppStore.getState().conversations.find(
      (conversation) => conversation.id === task.conversationId,
    )?.agentMode ?? task.mode;
    const roundContext = {
      ...contextBase,
      mode: currentMode,
      baseRevision: useAppStore.getState().getCurrentRevision(),
    };
    if (task.modelRounds >= task.budget.maxModelRounds) {
      transitionAgentTask(taskId, 'paused', { pausedReason: 'model_round_budget_exhausted' });
      callbacks.onError?.('已达到模型规划轮次上限，任务已暂停');
      return 'paused';
    }

    // 每轮请求前按当前模型上限复核（工具 Observation 会持续增大上下文；模型可能中途切换）
    const contextSpec = resolveAssistantContextSpec();
    if (estimateModelMessagesTokens(messages) > contextSpec.inputBudget) {
      transitionAgentTask(taskId, 'paused', {
        pausedReason: 'context_budget_exhausted',
        errorCode: 'CONTEXT_BUDGET_EXHAUSTED',
      });
      callbacks.onError?.('任务上下文已接近模型上限，任务已暂停');
      return 'paused';
    }

    transitionAgentTask(taskId, 'planning');
    updateTaskSnapshot(taskId, (current) => ({
      ...current,
      modelRounds: current.modelRounds + 1,
    }));

    const proposedCalls: ProposedToolCall[] = [];
    let roundText = '';
    const tools = buildAssistantFunctionTools(roundContext);
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
        }
      },
    });

    if (proposedCalls.length === 0) {
      callbacks.onComplete?.(fullText);
      return 'completed';
    }

    const currentTask = getTask(taskId);
    if (currentTask.toolCallCount + proposedCalls.length > currentTask.budget.maxToolCalls) {
      transitionAgentTask(taskId, 'paused', { pausedReason: 'tool_call_budget_exhausted' });
      callbacks.onError?.('已达到工具调用上限，任务已暂停');
      return 'paused';
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
      const preparedResult = prepareAgentToolCall(call, roundContext);
      if (!preparedResult.ok) {
        results.set(call.callId, {
          summary: preparedResult.result,
          modelContent: preparedResult.result.summary,
        });
        callbacks.onToolResult?.(preparedResult.result);
        continue;
      }

      const policy = evaluateAgentToolPolicy(
        preparedResult.prepared.definition,
        preparedResult.prepared.input,
        roundContext,
      );
      if (policy.outcome === 'deny') {
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

      const now = Date.now();
      const stepIndex = getTask(taskId).steps.length;
      const stepId = createStepId(taskId, stepIndex);
      const step: AgentStep = {
        id: stepId,
        taskId,
        index: stepIndex,
        kind: policy.outcome === 'require_approval' ? 'approval' : 'tool',
        title: preparedResult.prepared.definition.title,
        status: policy.outcome === 'require_approval' ? 'waiting_approval' : 'running',
        createdAt: now,
        updatedAt: now,
        toolCall: {
          callId: call.callId,
          toolId: call.toolId,
          inputSummary: sanitizePersistentSummary(
            preparedResult.prepared.definition.summarizeInput
              ? preparedResult.prepared.definition.summarizeInput(
                  preparedResult.prepared.input,
                )
              : '参数已通过本地 schema 校验',
          ).slice(0, 500),
          retryCount: 0,
          startedAt: now,
        },
        ...(policy.outcome === 'require_approval'
          ? {
              approval: {
                id: `${stepId}-approval`,
                kind: policy.approvalKind,
                status: 'pending' as const,
                summary: policy.reason,
                requestedAt: now,
              },
            }
          : {}),
      };
      appendStep(taskId, step);

      if (policy.outcome === 'require_approval') {
        transitionAgentTask(taskId, 'waiting_approval');
        callbacks.onApprovalRequired?.(step);
        const approvalId = step.approval!.id;
        const approved = await waitForAgentApproval(approvalId, signal);
        const resolvedAt = Date.now();
        updateTaskSnapshot(taskId, (current) => ({
          ...current,
          steps: current.steps.map((item) => item.id === step.id
            ? {
                ...item,
                status: approved ? 'running' : 'skipped',
                updatedAt: resolvedAt,
                approval: item.approval
                  ? {
                      ...item.approval,
                      status: approved ? 'approved' : 'rejected',
                      resolvedAt,
                    }
                  : undefined,
              }
            : item),
        }));
        if (!approved) {
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
          transitionAgentTask(taskId, 'running');
          continue;
        }
        transitionAgentTask(taskId, 'running');
      }

      allowedCalls.push({
        call,
        prepared: preparedResult.prepared,
        step,
        context: { ...roundContext, signal },
      });
    }

    const readCalls = allowedCalls.filter((item) => item.prepared.definition.effect === 'read');
    const writeCalls = allowedCalls.filter((item) => item.prepared.definition.effect !== 'read');
    if (allowedCalls.length > 0) transitionAgentTask(taskId, 'waiting_tool');
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
        transitionAgentTask(taskId, 'paused', { pausedReason: 'tool_result_budget_exhausted' });
        callbacks.onError?.('工具结果上下文已达到 200 KB 上限，任务已暂停');
        return 'paused';
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
  }

  throw new DOMException('Aborted', 'AbortError');
}
