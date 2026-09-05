/**
 * 执行 Agent 的单个模型轮次，串联上下文、流式响应、工具提案与执行结果。
 * 任务预算、审批等待和步骤快照在此轮次边界内统一更新。
 */
import { useAppStore } from '../../store/useAppStore';
import { getPreparedProviderCatalogApproval, MAX_PROVIDER_MODEL_SELECTION, validateProviderModelSelection } from './providerModelCatalogService';
import {
  streamAssistantReply,
  type AssistantModelMessage,
} from '../ai/assistantStream';
import type {
  AgentMode,
  AgentApprovalInputRequest,
  ProviderModelChoice,
  AgentApprovalResolution,
  AgentStep,
  AgentTask,
  AgentTaskBudget,
  AgentTaskStatus,
  AgentToolDisplaySnapshot,
  AgentToolDisplayValue,
} from '../../types/agent';
import { AGENT_TERMINAL_STATUSES } from '../../types/agent';
import type {
  AssistantStreamEvent,
  ProposedToolCall,
  ToolResultSummary,
} from '../../types/chat';
import type { McpContent } from '../../types/mcp';
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
import {
  AGENT_LIFETIME_BUDGET_PAUSE_REASON,
  evaluateAgentLifetimeUsage,
} from './agentBudgetService';
import { drainAgentInterjections } from './agentInterjection';
import { addAgentTaskMetrics, appendAgentEvent } from './agentJournal';
import {
  findSucceededDuplicateWrite,
  fingerprintToolInput,
} from './agentCheckpointService';
import { emitAgentLifecycleEvent } from './agentLifecycle';

// 每次 runAgentLoop 都创建自己的 messages 数组；恢复候选跨只读轮次保留，
// 不包含当前执行段新完成的步骤，也不写入 Store/IndexedDB。数组释放后自动回收。
const checkpointReplayCandidates = new WeakMap<AssistantModelMessage[], Set<string>>();

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
  mcpContent?: McpContent[];
  /** 仅供串行编排使用；固定在工具返回时，不吸收后续回调造成的画布变化。 */
  canvasRevisionAfter?: number;
}

function isAgentExecutionInactive(taskId: string, signal: AbortSignal): boolean {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  return signal.aborted || !task || task.status === 'paused' || AGENT_TERMINAL_STATUSES.has(task.status);
}

export function assertAgentTaskActive(taskId: string, signal: AbortSignal): void {
  if (isAgentExecutionInactive(taskId, signal)) {
    throw new DOMException('Agent 任务已取消或不再运行', 'AbortError');
  }
}

/** policyMode 只由受信的本地调用入口传入，不能来自工具参数。 */
export function resolveAgentExecutionMode(task: AgentTask, policyMode?: AgentMode): AgentMode {
  return policyMode ?? useAppStore.getState().conversations.find(
    (conversation) => conversation.id === task.conversationId,
  )?.agentMode ?? task.mode;
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

function sanitizeDisplayValue(value: AgentToolDisplayValue): AgentToolDisplayValue {
  return typeof value === 'string' ? sanitizePersistentSummary(value) : value;
}

/** 对工具提供的展示快照做统一脱敏和数量收敛。 */
export function sanitizeToolDisplay(
  display: AgentToolDisplaySnapshot | undefined,
): AgentToolDisplaySnapshot | undefined {
  if (!display) return undefined;
  const sanitized: AgentToolDisplaySnapshot = {
    fields: display.fields?.slice(0, 24).map((field) => ({
      label: sanitizePersistentSummary(field.label).slice(0, 80),
      value: sanitizeDisplayValue(field.value),
      source: field.source,
    })),
    references: display.references?.slice(0, 20).map((reference) => ({
      kind: reference.kind,
      id: sanitizePersistentSummary(reference.id).slice(0, 160),
      label: sanitizePersistentSummary(reference.label).slice(0, 160),
      mediaKind: reference.mediaKind,
    })),
    entities: display.entities?.slice(0, 20).map((entity) => ({
      id: entity.id ? sanitizePersistentSummary(entity.id).slice(0, 160) : undefined,
      title: sanitizePersistentSummary(entity.title).slice(0, 160),
      subtitle: entity.subtitle
        ? sanitizePersistentSummary(entity.subtitle).slice(0, 240)
        : undefined,
      preview: entity.preview
        ? sanitizePersistentSummary(entity.preview).slice(0, 1_000)
        : undefined,
      fields: entity.fields?.slice(0, 16).map((field) => ({
        label: sanitizePersistentSummary(field.label).slice(0, 80),
        value: sanitizeDisplayValue(field.value),
        source: field.source,
      })),
    })),
    changes: display.changes?.slice(0, 80).map((change) => ({
      targetId: sanitizePersistentSummary(change.targetId).slice(0, 160),
      targetLabel: change.targetLabel
        ? sanitizePersistentSummary(change.targetLabel).slice(0, 160)
        : undefined,
      field: sanitizePersistentSummary(change.field).slice(0, 80),
      before: change.before === undefined ? undefined : sanitizeDisplayValue(change.before),
      after: change.after === undefined ? undefined : sanitizeDisplayValue(change.after),
    })),
    note: display.note ? sanitizePersistentSummary(display.note) : undefined,
  };
  if (!sanitized.fields?.length) delete sanitized.fields;
  if (!sanitized.references?.length) delete sanitized.references;
  if (!sanitized.entities?.length) delete sanitized.entities;
  if (!sanitized.changes?.length) delete sanitized.changes;
  if (!sanitized.note) delete sanitized.note;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function buildToolInputDisplay(
  prepared: PreparedAgentToolCall,
  context: Omit<AgentToolContext, 'signal'>,
): AgentToolDisplaySnapshot | undefined {
  if (!prepared.definition.buildInputDisplay) return undefined;
  try {
    return sanitizeToolDisplay(prepared.definition.buildInputDisplay(
      prepared.input,
      context,
    ));
  } catch (error) {
    console.warn('[AgentToolDisplay] 参数详情构建失败:', error);
    return undefined;
  }
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

function rejectPreparedToolCall(
  taskId: string,
  call: ProposedToolCall,
  prepared: PreparedAgentToolCall,
  step: AgentStep,
  errorCode: string,
  reason: string,
  startedAt = Date.now(),
  retryCount = 0,
): ExecutedToolCall {
  const message = sanitizePersistentSummary(reason);
  const currentStep = getTask(taskId).steps.find((item) => item.id === step.id) ?? step;
  updateStep(taskId, step.id, {
    status: 'failed',
    errorCode,
    errorMessage: message,
    toolCall: {
      ...currentStep.toolCall!,
      finishedAt: Date.now(),
      retryCount,
      errorCode,
      resultSummary: message,
    },
  });
  appendAgentEvent(taskId, 'tool_end', {
    toolId: call.toolId,
    callId: call.callId,
    effect: prepared.definition.effect,
    status: 'failed',
    errorCode,
    durationMs: Date.now() - startedAt,
    retryCount,
  });
  emitAgentLifecycleEvent({
    type: 'tool.execution',
    taskId,
    toolId: call.toolId,
    phase: 'end',
    status: 'failed',
    durationMs: Date.now() - startedAt,
    errorCode,
  });
  return {
    summary: { callId: call.callId, toolId: call.toolId, status: 'denied', summary: message, truncated: false },
    modelContent: message,
  };
}

export async function executePreparedToolCall(
  taskId: string,
  call: ProposedToolCall,
  prepared: PreparedAgentToolCall,
  context: AgentToolContext,
  step: AgentStep,
  policyMode?: AgentMode,
  checkpointReplayStepIds?: ReadonlySet<string>,
): Promise<ExecutedToolCall> {
  assertAgentTaskActive(taskId, context.signal);
  const startedAt = Date.now();
  const maxRetries = maxAutoRetriesForEffect(
    prepared.definition.effect,
    getTask(taskId).budget,
  );
  let retryCount = 0;
  let checkpointBefore: { historyIndex: number; revision: number } | undefined;

  while (true) {
    // 审批等待、前序读取和重试退避期间，停止/降级/撤权都必须即时生效。
    assertAgentTaskActive(taskId, context.signal);
    const currentTask = getTask(taskId);
    const executionContext = { ...context, mode: resolveAgentExecutionMode(currentTask, policyMode) };
    const policy = evaluateAgentToolPolicy(prepared.definition, prepared.input, executionContext);
    const currentStep = currentTask.steps.find((item) => item.id === step.id);
    const reverifyReason = useAppStore.getState().currentProjectId !== context.projectId
      ? '目标项目已切换，已取消该工具执行'
      : policy.outcome === 'deny'
        ? policy.reason
        : policy.outcome === 'require_approval' && currentStep?.approval?.status !== 'approved'
          ? '当前模式要求用户确认，请重新提出该操作'
          : undefined;
    if (reverifyReason) {
      return rejectPreparedToolCall(taskId, call, prepared, step, 'AGENT_TOOL_REVERIFY_FAILED', reverifyReason, startedAt, retryCount);
    }
    // 复用也必须等到实际执行边界才判断，不能在同轮前序写入尚未执行时提前认定成功。
    if (retryCount === 0 && prepared.definition.effect !== 'read') {
      const inputFingerprint = fingerprintToolInput(call.toolId, prepared.input);
      updateStep(taskId, step.id, {
        toolCall: { ...(currentStep?.toolCall ?? step.toolCall!), inputFingerprint },
      });
      const state = useAppStore.getState();
      const duplicate = findSucceededDuplicateWrite(getTask(taskId), call.toolId, inputFingerprint, {
        callId: call.callId,
        excludeStepId: step.id,
        projectId: state.currentProjectId,
        historyIndex: state.historyIndex,
        revision: state.getCurrentRevision(),
        checkpointReplayStepIds,
      });
      if (duplicate) {
        const summary = `已复用先前成功结果：${sanitizePersistentSummary(
          duplicate.outputSummary || duplicate.toolCall?.resultSummary || '该请求已成功执行',
        )}`;
        updateStep(taskId, step.id, {
          status: 'succeeded',
          outputSummary: summary,
          toolCall: {
            ...(currentStep?.toolCall ?? step.toolCall!),
            inputFingerprint,
            finishedAt: Date.now(),
            resultSummary: summary,
            resultDisplay: sanitizeToolDisplay(duplicate.toolCall?.resultDisplay),
          },
        });
        return {
          summary: { callId: call.callId, toolId: call.toolId, status: 'success', summary, truncated: false },
          modelContent: summary,
        };
      }
    }
    if (retryCount === 0) {
      checkpointBefore = prepared.definition.effect === 'canvas_write'
        ? { historyIndex: useAppStore.getState().historyIndex, revision: useAppStore.getState().getCurrentRevision() }
        : undefined;
      appendAgentEvent(taskId, 'tool_start', { toolId: call.toolId, callId: call.callId, effect: prepared.definition.effect });
      emitAgentLifecycleEvent({ type: 'tool.execution', taskId, toolId: call.toolId, phase: 'start' });
    }
    try {
      assertAgentTaskActive(taskId, context.signal);
      const result = await prepared.definition.execute(executionContext, prepared.input);
      const revisionAfterExecution = useAppStore.getState().getCurrentRevision();
      const historyIndexAfterExecution = useAppStore.getState().historyIndex;
      if (result.status === 'error' && result.retryable && retryCount < maxRetries) {
        assertAgentTaskActive(taskId, context.signal);
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
            historyIndex: historyIndexAfterExecution,
            revision: revisionAfterExecution,
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
          resultDisplay: sanitizeToolDisplay(result.display),
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
        mcpContent: result.mcpContent,
        canvasRevisionAfter: result.status === 'success'
          && (prepared.definition.effect === 'canvas_write' || prepared.definition.effect === 'media_generation')
          ? revisionAfterExecution
          : undefined,
      };
    } catch (error) {
      if (isAgentExecutionInactive(taskId, context.signal)) {
        emitAgentLifecycleEvent({
          type: 'tool.execution',
          taskId,
          toolId: call.toolId,
          phase: 'end',
          status: 'stopped',
          durationMs: Date.now() - startedAt,
          errorCode: 'AGENT_STOPPED',
        });
        throw new DOMException('Agent 任务已取消或不再运行', 'AbortError');
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
  mode: AgentMode = 'collaborative',
): {
  prepared: PreparedAgentToolCall;
  inputRequest?: AgentApprovalInputRequest;
} {
  // 中转站接入：把候选模型交给审批卡渲染成勾选列表，选择结果随确认回传
  if (prepared.definition.id === 'provider_models_select') {
    const catalogRequest = getPreparedProviderCatalogApproval(prepared.input);
    if (catalogRequest) return { prepared, inputRequest: catalogRequest };
    const options = (prepared.input as { models?: ProviderModelChoice[] }).models ?? [];
    return options.length > 0
      ? { prepared, inputRequest: { kind: 'provider_models', options: structuredClone(options), maxSelection: MAX_PROVIDER_MODEL_SELECTION } }
      : { prepared };
  }

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

  // C/MCP 无审批卡：保留 Registry 已解析的默认/自动路由模型，继续交给 Policy 校验。
  if (mode === 'autonomous') return { prepared };

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

/** Shared by model rounds and single-tool/MCP execution; only user-returned fields are injected. */
export function resolveApprovalSelection(
  call: ProposedToolCall,
  prepared: PreparedAgentToolCall,
  inputRequest: AgentApprovalInputRequest | undefined,
  resolution: AgentApprovalResolution,
  context: Omit<AgentToolContext, 'signal'>,
): { call: ProposedToolCall; prepared: PreparedAgentToolCall; inputRequest?: AgentApprovalInputRequest; error?: ToolResultSummary } {
  const original = { call, prepared, inputRequest };
  const deny = (summary: string) => ({ ...original, error: {
    callId: call.callId, toolId: call.toolId, status: 'denied' as const,
    summary: sanitizePersistentSummary(summary), truncated: false,
  } });
  if (!resolution.approved || !inputRequest) return original;
  if (context.mode === 'plan') {
    const policy = evaluateAgentToolPolicy(prepared.definition, prepared.input, context);
    if (policy.outcome === 'deny') return deny(policy.reason);
  }
  let selectedInput: Record<string, unknown>;
  let request = inputRequest;
  try {
    if (inputRequest.kind === 'provider_models') {
      const ids = resolution.inputValues?.selectedModelIds;
      if (resolution.inputValues?.modelRef !== undefined) return deny('厂商模型勾选不能使用媒体 modelRef');
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return deny('厂商模型选择必须是模型 ID 数组');
      if (inputRequest.catalog && inputRequest.catalog.expiresAt <= Date.now()) return deny('模型目录已失效，请重新读取目录');
      if (ids.length > (inputRequest.maxSelection ?? MAX_PROVIDER_MODEL_SELECTION)) return deny('选择数量超过本次审批上限');
      validateProviderModelSelection(inputRequest.options, ids);
      selectedInput = { ...(prepared.input as Record<string, unknown>), selectedIds: [...ids] };
    } else if (inputRequest.kind === 'media_model') {
      if (resolution.inputValues?.selectedModelIds !== undefined) return deny('媒体模型选择不能使用厂商模型 ID 列表');
      const value = resolution.inputValues?.modelRef;
      if (typeof value !== 'string' || !value.trim()) return deny('确认生成前必须选择一个可用模型');
      const modelRef = value.trim();
      selectedInput = { ...(prepared.input as Record<string, unknown>), modelRef };
      request = { ...inputRequest, selectedModelRef: modelRef };
    } else {
      return deny('不支持的审批输入类型，请重新提出操作');
    }
    const resolvedCall = { ...call, input: selectedInput };
    // Registry re-resolves catalog leases/defaults and validates the resulting local schema.
    const selected = prepareAgentToolCall(resolvedCall, context);
    if (!selected.ok) return deny(selected.result.summary);
    if (selected.prepared.definition !== prepared.definition) return deny('工具定义已变化，请重新提出操作并确认');
    const authorization = selected.prepared.definition.authorize?.(context, selected.prepared.input);
    if (authorization && !authorization.allowed) return deny(authorization.reason || '所选模型当前不可用');
    return { call: resolvedCall, prepared: selected.prepared, inputRequest: request };
  } catch (error) {
    return deny(error instanceof Error ? error.message : '审批选择校验失败');
  }
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
  assertAgentTaskActive(taskId, signal);
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
  const readCurrentMode = () => resolveAgentExecutionMode(getTask(taskId));
  const roundContext = {
    ...contextBase,
    mode: readCurrentMode(),
    baseRevision: useAppStore.getState().getCurrentRevision(),
  };
  const interjections = drainAgentInterjections(taskId);
  let checkpointReplayStepIds = checkpointReplayCandidates.get(messages);
  if (!checkpointReplayStepIds) {
    checkpointReplayStepIds = new Set((task.resumeCount ?? 0) > 0
      ? task.steps.filter((step) => step.status === 'succeeded').map((step) => step.id)
      : []);
    checkpointReplayCandidates.set(messages, checkpointReplayStepIds);
  }
  // 用户的新补充要求不属于恢复重放；此执行段后续轮次也不能继续按旧参数复用。
  if (interjections.length > 0) checkpointReplayStepIds.clear();
  for (const interjection of interjections) {
    addAgentTaskMetrics(taskId, { interjectionCount: 1 });
    appendAgentEvent(taskId, 'interjection_applied', {
      interjectionId: interjection.id,
    });
    messages.push({
      role: 'user',
      content: [
        '用户在任务执行期间补充了以下要求。请结合当前进度处理，不要重放已成功的同一请求；新的修改或重新生成按当前要求执行：',
        interjection.text,
      ].join('\n'),
    });
  }

  // 终身上限先于单段预算判定：累计 token 没有单段计数器，只能在这里逐轮复核
  const lifetime = evaluateAgentLifetimeUsage(task);
  if (lifetime.exceeded) {
    transitionTask(taskId, 'paused', {
      pausedReason: AGENT_LIFETIME_BUDGET_PAUSE_REASON,
      errorCode: lifetime.errorCode,
    });
    callbacks.onError?.(lifetime.message ?? '任务已达终身预算上限，任务已暂停');
    return { outcome: 'paused', fullText, totalToolResultChars };
  }

  if (task.modelRounds >= task.budget.maxModelRounds) {
    transitionTask(taskId, 'paused', { pausedReason: 'model_round_budget_exhausted' });
    callbacks.onError?.('已达到模型规划轮次上限，任务已暂停');
    return { outcome: 'paused', fullText, totalToolResultChars };
  }

  // 每轮请求前按当前模型上限复核（工具 Observation 会持续增大上下文；模型可能中途切换）
  const contextSpec = resolveAssistantContextSpec(task.projectId);
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
      projectId: task.projectId,
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

  assertAgentTaskActive(taskId, signal);
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
    assertAgentTaskActive(taskId, signal);
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
      roundContext.mode,
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
        inputDisplay: buildToolInputDisplay(prepared, roundContext),
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
      assertAgentTaskActive(taskId, signal);
      roundContext.mode = resolveAgentExecutionMode(getTask(taskId));
      const selection = resolveApprovalSelection(call, prepared, approvalInput.inputRequest, resolution, roundContext);
      const approvalError = selection.error;
      resolvedCall = selection.call;
      prepared = selection.prepared;
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
                    inputDisplay: buildToolInputDisplay(prepared, roundContext),
                  }
                : item.toolCall,
              approval: item.approval
                ? {
                    ...item.approval,
                    status: resolution.approved ? 'approved' : 'rejected',
                    resolvedAt,
                    inputRequest: selection.inputRequest,
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

    allowedCalls.push({
      call: resolvedCall,
      prepared,
      step,
      context: { ...roundContext, signal },
    });
  }

  const readCalls = allowedCalls.filter((item) => item.prepared.definition.effect === 'read');
  const writeCalls = allowedCalls.filter((item) => item.prepared.definition.effect !== 'read');
  assertAgentTaskActive(taskId, signal);
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
  // 只接纳成功画布工具在返回时固定的版本；失败或外部变更后整批剩余写入失效。
  let writeBaseRevision = roundContext.baseRevision;
  let writeBatchFailed = false;
  for (const item of writeCalls) {
    assertAgentTaskActive(taskId, signal);
    const revisionChanged = useAppStore.getState().getCurrentRevision() !== writeBaseRevision;
    const result = writeBatchFailed || revisionChanged
      ? rejectPreparedToolCall(
          taskId, item.call, item.prepared, item.step,
          revisionChanged ? 'AGENT_CANVAS_REVISION_CHANGED' : 'AGENT_WRITE_BATCH_ABORTED',
          revisionChanged
            ? '画布已变更，本轮剩余写操作已取消，请先重新读取画布再规划'
            : '本轮前序写操作未成功，剩余写操作已取消，请根据实际结果重新规划',
        )
      : await executePreparedToolCall(
          taskId,
          item.call,
          item.prepared,
          { ...item.context, baseRevision: writeBaseRevision },
          item.step,
          undefined,
          checkpointReplayStepIds,
        );
    if (result.summary.status === 'success') {
      writeBaseRevision = result.canvasRevisionAfter ?? writeBaseRevision;
    } else {
      writeBatchFailed = true;
    }
    results.set(item.call.callId, result);
    callbacks.onToolResult?.(result.summary);
  }

  assertAgentTaskActive(taskId, signal);
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
