/**
 * conversationExecutionController — 编排消息提交、任务续跑与会话审批。
 */
import { sanitizeDomainText } from './subAgentMaterials';
import { subscribeAgentLifecycle } from './agentLifecycle';
/**
 * 对话提交与恢复的统一控制层，按会话模式分派普通回复、Agent 任务和显式媒体生成。
 * 组件只调用本模块，不直接拼接运行时、调度器或审批流程。
 */
import { completeMediaMessageDelivery, deliverMediaMessageGroup, isMediaDeliveryGroup, MEDIA_PERSIST_FAILED_MESSAGE, runMediaGeneration } from '../ai/generationRuntime';
import { getPendingTasksForProject, isMediaTaskPausedError } from '../pollManager';
import { completeCanvasDerivation } from '../canvasDerivationGuard';
import { completeRunningHubNodeTask } from '../ai/providers/runninghubWorkflow';
import { persistMessage } from './chatHistoryService';
import { workflowExecution } from '../workflowExecutionService';
import { completeWorkflowApiNodeTask } from '../workflowApi/workflowApiAdapter';
import {
  buildAssistantSystemPrompt,
  resolveAssistantModel,
} from '../ai/assistantStream';
import {
  runAssistantPipeline,
  runStreamingPipeline,
} from './assistantService';
import {
  prepareAgentTaskResume,
  resolveAgentApproval,
  runAgentLoop,
  runAgentTask,
  stopAgentTask,
  validateTaskResumable,
  type AgentResumeValidation,
} from './agentRuntime';
import { enqueueAgentInterjection, MAX_INTERJECTION_CHARS } from './agentInterjection';
import {
  getActiveConversationAgentTaskId,
  scheduleConversationAgentExecution,
  type AgentScheduleResult,
} from './agentScheduler';
import { getAvailableAgentTools } from './toolRegistry';
import { ensureAgentToolsRegistered } from './tools';
import {
  captureExplicitSkillBindings,
  expandSkillBindings,
  expandSkillReferences,
  resolveReferencedSkills,
  resolveSkillBindingToolAllowlist,
  SKILL_CONTENT_LIMITS,
} from '../skillPromptService';
import { useAppStore } from '../../store/useAppStore';
import { formatChatImageReference, parseChatImageReferences, MAX_CHAT_IMAGES } from './chatImageReferenceService';
import { GENERAL_ASSISTANT_SCOPE_ID, isGeneralAssistantScope, resolveAssistantToolAllowlist } from './assistantScope';
import type { ChatMessage } from '../../types/chat';
import {
  type AgentApprovalResolution,
  type AgentMode,
} from '../../types/agent';
import { extendAgentSegmentBudget } from './agentBudgetService';
import type { AssistantExecutionSelection } from '../../types/agentTeam';
import { normalizeExecutionSelection } from './teams/teamProfileService';
import { appendTeamInstruction, resumeTeamInvocation, submitTeamInvocation } from './teams/teamInvocationService';
import { captureCreationProfile, intersectCreationTools } from '../creationProfiles/creationProfileService';
import { beginAgentDispatch, settleAgentDispatch } from './agentDurabilityService';
import type { MediaGenerationIntent } from '../../types/media';
import {
  failMediaPlaceholderLifecycle,
  MEDIA_PLACEHOLDER_STALE_ERROR,
  registerMediaPlaceholderLifecycle,
  settleMediaPlaceholderLifecycle,
  type MediaPlaceholderLifecycle,
} from './mediaPlaceholderLifecycle';

const STREAMING_UI_FLUSH_INTERVAL_MS = 50;

interface StreamingMessageBuffer {
  append: (delta: string) => void;
  appendReasoning: (delta: string) => void;
  flush: () => void;
  cancel: () => void;
}

export interface SubmitConversationMessageOptions {
  executionSelection?: AssistantExecutionSelection;
  requestId?: string;
  content: string;
  imageFileNames?: string[];
  conversationId: string;
  projectId?: string;
  mode?: AgentMode;
  dispatchMode?: 'queue' | 'interject';
  onProgress?: () => void;
}

export type SubmitConversationMessageResult =
  | { status: 'ignored' }
  | { status: 'interjected'; taskId: string }
  | {
      status: 'started';
      userMessageId: string;
      assistantMessageId: string;
      taskId?: string;
    };

interface StartAgentMessageExecutionOptions {
  text: string;
  projectId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  mode: AgentMode;
  onProgress?: () => void;
}

function createMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function createStreamingMessageBuffer(
  messageId: string,
  onProgress?: () => void,
): StreamingMessageBuffer {
  let pendingText = '';
  let reasoning = '';
  let reasoningDirty = false;
  let closed = false;
  const original = useAppStore.getState().messages.find((item) => item.id === messageId);
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPending = () => {
    flushTimer = null;
    if (closed || (!pendingText && !reasoningDirty)) return;
    const delta = pendingText;
    pendingText = '';
    const store = useAppStore.getState();
    const message = store.messages.find((item) => item.id === messageId);
    if (!message || message.conversationId !== original?.conversationId || message.agentTaskId !== original?.agentTaskId) return;
    store.updateMessageTransient(messageId, {
      content: (message.content || '') + delta,
      ...(reasoningDirty ? { reasoning: sanitizeDomainText(reasoning).replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]*/gi, '[已脱敏密钥]'), reasoningTruncated: reasoning.length >= 12000 } : {}),
      status: 'streaming',
      activity: delta ? 'responding' : 'planning',
    });
    reasoningDirty = false;
    onProgress?.();
  };

  const clearFlushTimer = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  return {
    append: (delta) => {
      if (closed || !delta) return;
      pendingText += delta;
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, STREAMING_UI_FLUSH_INTERVAL_MS);
      }
    },
    appendReasoning: (delta) => {
      if (closed || !delta) return;
      reasoning = (reasoning + delta).slice(0, 12000);
      reasoningDirty = true;
      if (!flushTimer) flushTimer = setTimeout(flushPending, STREAMING_UI_FLUSH_INTERVAL_MS);
    },
    flush: () => {
      clearFlushTimer();
      flushPending();
    },
    cancel: () => {
      clearFlushTimer();
      pendingText = '';
      reasoningDirty = false;
      closed = true;
    },
  };
}

export function getAgentModeToast(mode: AgentMode): string {
  if (mode === 'plan') return '已切换到 Plan 模式：仅分析与规划，不执行任何写操作';
  if (mode === 'autonomous') {
    return '已切换到 C 自主模式：所有工具按固定权限边界自动执行，不等待人工确认';
  }
  return '已切换到 B 协作模式：画布写操作将先预览确认';
}

export function resolveConversationAgentApproval(
  approvalId: string,
  resolution: AgentApprovalResolution,
): boolean {
  if (!resolveAgentApproval(approvalId, resolution)) return false;

  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) =>
    item.steps.some((step) => step.approval?.id === approvalId),
  );
  if (!task) return true;
  const step = task.steps.find((item) => item.approval?.id === approvalId);
  const message = store.messages.find((item) => item.agentTaskId === task.id);
  if (!message || !step) return true;
  const placeholder = `等待确认：${step.title}`;
  store.updateMessage(message.id, {
    content: message.content === placeholder ? '' : message.content,
    status: 'executing',
  });
  return true;
}

export function submitConversationMessage({
  content,
  imageFileNames = [],
  conversationId,
  projectId,
  mode,
  dispatchMode = 'queue',
  executionSelection,
  requestId,
  onProgress,
}: SubmitConversationMessageOptions): SubmitConversationMessageResult {
  const store = useAppStore.getState();
  const pending = store.chatImageDrafts[conversationId] ?? [];
  const images = pending.filter((image) => imageFileNames.includes(image.fileName));
  if (imageFileNames.some((fileName) => !images.some((image) => image.fileName === fileName))) {
    store.showToast('参考图已移除或不属于当前对话，请重新检查附件', 'error');
    return { status: 'ignored' };
  }
  const text = [content.trim(), ...images.map(formatChatImageReference)].filter(Boolean).join('\n');
  if (!text || !conversationId) return { status: 'ignored' };
  if (new Set(parseChatImageReferences(text).map((image) => image.fileName)).size > MAX_CHAT_IMAGES) {
    store.showToast(`每条消息最多添加 ${MAX_CHAT_IMAGES} 张参考图`, 'error');
    return { status: 'ignored' };
  }
  if (dispatchMode === 'interject' && parseChatImageReferences(text).length > 0 && text.length > MAX_INTERJECTION_CHARS) {
    store.showToast('文字与参考图引用超过当前任务追加上限，请缩短文字或使用排队发送', 'error');
    return { status: 'ignored' };
  }
  const activeTaskId = dispatchMode === 'interject' ? getActiveConversationAgentTaskId(conversationId) : undefined;
  if (activeTaskId && store.agentTasks.some((task) => task.id === activeTaskId && task.executionKind === 'team')
    && parseChatImageReferences(text).length > 0) {
    store.showToast('团队首期仅处理文字材料，追加要求前请先移除参考图', 'error');
    return { status: 'ignored' };
  }

  const interjectedTaskId = dispatchMode === 'interject'
    ? tryInterjectConversationMessage(conversationId, text)
    : undefined;
  if (interjectedTaskId) {
    store.removeChatImageDrafts(conversationId, images.map((image) => image.fileName));
    onProgress?.();
    return { status: 'interjected', taskId: interjectedTaskId };
  }

  const conversation = store.conversations.find((item) => item.id === conversationId);
  // 窗口快照可能晚于项目切换；通用会话绝不能因此继承新画布权限。
  const executionProjectId = isGeneralAssistantScope(conversation?.projectId)
    ? GENERAL_ASSISTANT_SCOPE_ID : projectId ?? conversation?.projectId ?? store.currentProjectId ?? '';
  const selection = normalizeExecutionSelection(executionSelection ?? conversation?.executionSelection);
  if (selection.kind === 'team') {
    if (images.length || parseChatImageReferences(text).length) {
      store.showToast('团队首期仅处理文字材料，请先移除参考图，或切回单模型', 'error');
      return { status: 'ignored' };
    }
    try {
      const result = submitTeamInvocation({ content: text, projectId: executionProjectId, conversationId,
        mode: mode ?? conversation?.agentMode ?? 'collaborative', templateId: selection.templateId,
        requestId, context: { source: 'assistant' }, onProgress });
      store.removeChatImageDrafts(conversationId, images.map((image) => image.fileName));
      onProgress?.();
      return { status: 'started', ...result };
    } catch (error) {
      store.showToast(sanitizeDomainText(error instanceof Error ? error.message : '团队未能发起').slice(0, 300), 'error');
      return { status: 'ignored' };
    }
  }
  const userMessage: ChatMessage = {
    id: createMessageId(),
    conversationId,
    role: 'user',
    content: text,
    timestamp: Date.now(),
    status: 'done',
  };
  store.addMessage(userMessage);
  store.removeChatImageDrafts(conversationId, images.map((image) => image.fileName));

  const assistantMessage: ChatMessage = {
    id: createMessageId(),
    conversationId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: resolveAssistantModel(executionProjectId) ? 'streaming' : 'parsing',
  };
  store.addMessage(assistantMessage);

  const taskId = startAgentMessageExecution({
    text,
    projectId: executionProjectId,
    conversationId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    mode: mode ?? conversation?.agentMode ?? 'collaborative',
    onProgress,
  });
  onProgress?.();

  return {
    status: 'started',
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    taskId,
  };
}

function startAgentMessageExecution({
  text,
  projectId,
  conversationId,
  userMessageId,
  assistantMessageId,
  mode,
  onProgress,
}: StartAgentMessageExecutionOptions): string | undefined {
  const store = useAppStore.getState();
  let taskId: string | undefined;

  try {
    ensureAgentToolsRegistered();
    const runtimeSkills = [...store.userSkills, ...store.agentPackageSkills];
    const referencedSkills = resolveReferencedSkills(text, runtimeSkills);
    if (referencedSkills.length > SKILL_CONTENT_LIMITS.maxExplicitBindings) {
      throw new Error(`单个任务最多注入 ${SKILL_CONTENT_LIMITS.maxExplicitBindings} 个 Skill`);
    }
    const skillBindings = captureExplicitSkillBindings(text, runtimeSkills);
    const selectedCreation = store.conversations.find((entry) => entry.id === conversationId)?.creationProfile;
    const creationSelection = selectedCreation ? structuredClone(selectedCreation) : undefined;
    const task = store.createAgentTask({
      projectId,
      conversationId,
      userMessageId,
      mode,
      goal: text,
      toolAllowlist: resolveAssistantToolAllowlist(projectId, resolveSkillBindingToolAllowlist(skillBindings)),
      skillBindings,
      creationProfilePreparation: creationSelection ? 'pending' : undefined,
    });
    taskId = task.id;
    store.updateMessage(assistantMessageId, { agentTaskId: task.id });
    if (creationSelection) {
      // 准备期间只登记 queued；真正模型调用必须等待能力预检及不可变快照。
      void captureCreationProfile(structuredClone(creationSelection), projectId).then((captured) => {
        const current = useAppStore.getState();
        const pending = current.agentTasks.find((entry) => entry.id === task.id);
        if (!pending || !['queued', 'paused'].includes(pending.status)) return;
        if (!current.conversations.some((entry) => entry.id === conversationId && !entry.deletedAt)
          || (!isGeneralAssistantScope(projectId) && current.currentProjectId !== projectId)) throw new Error('组合包准备期间项目或会话已变化');
        const bindings = [...new Map([...skillBindings, ...captured.skillBindings].map((binding) => [binding.skillId, binding])).values()];
        if (bindings.length > SKILL_CONTENT_LIMITS.maxExplicitBindings
          || bindings.reduce((total, binding) => total + binding.content.length, 0) > SKILL_CONTENT_LIMITS.expansionTotalChars) throw new Error('组合包与本次引用的 Skill 总量超出上限，请减少选择');
        const allowed = intersectCreationTools(resolveSkillBindingToolAllowlist(skillBindings), resolveSkillBindingToolAllowlist(captured.skillBindings));
        current.updateAgentTask(task.id, { creationProfile: captured.snapshot, creationProfilePreparation: 'ready', skillBindings: bindings,
          toolAllowlist: resolveAssistantToolAllowlist(projectId, intersectCreationTools(allowed, captured.snapshot?.toolAllowlist)) });
        if (pending.status === 'queued') scheduleAgentTaskExecution(task.id, assistantMessageId, onProgress);
      }).catch((error: unknown) => {
        const current = useAppStore.getState();
        const pending = current.agentTasks.find((entry) => entry.id === task.id);
        if (!pending || !['queued', 'paused'].includes(pending.status)) return;
        if (pending.status === 'queued') stopAgentTask(task.id);
        current.updateAgentTask(task.id, { creationProfilePreparation: 'failed', errorCode: 'CREATION_PROFILE_PREPARATION_FAILED', errorMessage: sanitizeDomainText(error instanceof Error ? error.message : '组合包准备失败').slice(0, 300) });
        current.updateMessage(assistantMessageId, { content: sanitizeDomainText(error instanceof Error ? error.message : '组合包准备失败').slice(0, 300), status: 'error', finishReason: 'error' });
        onProgress?.();
      });
    } else scheduleAgentTaskExecution(task.id, assistantMessageId, onProgress);
    return task.id;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    if (taskId) {
      try {
        stopAgentTask(taskId);
        store.updateAgentTask(taskId, {
          errorCode: 'AGENT_START_FAILED',
          errorMessage,
        });
      } catch (stopError) {
        console.error('[AgentBootstrap] failed to stop incomplete task:', stopError);
      }
    }
    store.updateMessage(assistantMessageId, {
      content: `处理失败: ${errorMessage}`,
      status: 'error',
      finishReason: 'error',
    });
    onProgress?.();
    console.error('[AgentBootstrap] failed to start chat task:', error);
    return undefined;
  }
}

function scheduleAgentTaskExecution(
  taskId: string,
  assistantMessageId: string,
  onProgress?: () => void,
  resume = false,
): AgentScheduleResult | undefined {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task) return undefined;
  const scheduled = scheduleConversationAgentExecution({
    taskId,
    conversationId: task.conversationId,
    onStart: () => {
      const store = useAppStore.getState();
      if (resume) prepareAgentTaskResume(taskId);
      const message = store.messages.find((item) => item.id === assistantMessageId);
      if (message && message.status === 'queued') {
        store.updateMessage(assistantMessageId, {
          status: resolveAssistantModel(task.projectId) ? 'streaming' : 'parsing',
        });
      }
    },
    run: () => driveAgentTask(taskId, assistantMessageId, onProgress),
    onError: (error) => {
      console.error('[AgentScheduler] failed to execute chat task:', error);
    },
  });
  if (scheduled.state !== 'started') {
    useAppStore.getState().updateMessage(assistantMessageId, { status: 'queued' });
  }
  return scheduled;
}

export function resumeAgentTaskExecution(
  taskId: string,
  onProgress?: () => void,
): AgentResumeValidation {
  const validation = validateTaskResumable(taskId);
  if (!validation.ok) return validation;

  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId)!;
  if (task.executionKind === 'team') {
    try { resumeTeamInvocation(taskId); onProgress?.(); return { ok: true }; }
    catch (error) { return { ok: false, errorCode: 'TEAM_RESUME_FAILED',
      message: sanitizeDomainText(error instanceof Error ? error.message : '团队无法继续').slice(0, 300) }; }
  }
  const message = store.messages.find(
    (item) => item.agentTaskId === taskId && item.role === 'assistant',
  );
  if (!message) {
    return {
      ok: false,
      errorCode: 'AGENT_RESUME_NO_MESSAGE',
      message: '找不到对应的助手消息，无法继续',
    };
  }

  // 单段额度放宽后仍夹在终身上限内；继续次数计入 maxResumes（validateTaskResumable 已校验）
  store.updateAgentTask(taskId, {
    budget: extendAgentSegmentBudget(task),
    resumeCount: (task.resumeCount ?? 0) + 1,
  });
  const scheduled = scheduleAgentTaskExecution(taskId, message.id, onProgress, true);
  // 排队等待期间就切到 queued：状态若停在 paused，界面会继续显示「继续」按钮引诱重复点击
  if (scheduled?.state === 'queued') prepareAgentTaskResume(taskId);
  return { ok: true };
}

/** 兼容的旧 pipeline 也必须先落盘；异常保守留为未知，不能换路径重投。 */
async function withLegacyDispatch<T>(taskId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const record = await beginAgentDispatch({ taskId, kind: 'model', signal });
  try {
    const result = await run();
    await settleAgentDispatch(taskId, record, 'succeeded');
    return result;
  } catch (error) {
    await settleAgentDispatch(taskId, record, 'unknown');
    const state = useAppStore.getState();
    const task = state.agentTasks.find((entry) => entry.id === taskId);
    if (task && !['paused', 'stopped', 'completed'].includes(task.status)) state.updateAgentTask(taskId, {
      status: 'paused', pausedReason: 'dispatch_outcome_unknown', errorCode: 'AGENT_DISPATCH_OUTCOME_UNKNOWN',
      errorMessage: '原调用结果未知，请先核实；不会自动改走其他执行路径',
    });
    throw error;
  }
}

function driveAgentTask(
  taskId: string,
  assistantMessageId: string,
  onProgress?: () => void,
): Promise<void> {
  const store = useAppStore.getState();
  ensureAgentToolsRegistered();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) return Promise.resolve();
  const { projectId, conversationId, userMessageId, goal: text } = task;
  const mode = store.conversations.find((item) => item.id === conversationId)?.agentMode
    ?? task.mode;

  return runAgentTask(taskId, async (signal) => {
    let failed = false;

    if (resolveAssistantModel(projectId)) {
      const streamingMessage = createStreamingMessageBuffer(assistantMessageId, onProgress);
      useAppStore.getState().updateMessageTransient(assistantMessageId, { reasoning: undefined, reasoningTruncated: undefined, responseError: undefined, activity: 'connecting', activityStartedAt: Date.now() });
      const unsubscribe = subscribeAgentLifecycle((event) => {
        if (signal.aborted) return;
        if (event.type === 'context.compression' && event.conversationId === conversationId && (!event.taskId || event.taskId === taskId)) {
          useAppStore.getState().updateMessageTransient(assistantMessageId, { activity: event.phase === 'start' ? 'compressing' : 'planning', activityStartedAt: event.timestamp });
        } else if (event.type === 'model.round' && event.taskId === taskId && event.phase === 'start') {
          useAppStore.getState().updateMessageTransient(assistantMessageId, { activity: 'planning', activityStartedAt: event.timestamp });
        }
      });
      try {
        const availableTools = getAvailableAgentTools({
          taskId,
          projectId,
          conversationId,
          mode,
          toolAllowlist: task.toolAllowlist,
        });
        if (
          availableTools.length > 0
          || isGeneralAssistantScope(projectId)
          || mode === 'plan'
          || task.toolAllowlist !== undefined
          || !!task.creationProfile
        ) {
          const outcome = await runAgentLoop({
            taskId,
            systemPrompt: buildAssistantSystemPrompt({
              agentTools: true,
              includeToolGuidance: false,
              projectId,
              includeCanvasContext: task.creationProfile?.contextPolicyRef !== 'explicit-materials'
                && useAppStore.getState().currentProjectId === projectId,
            }),
            userMessage: task.skillBindings === undefined
              ? expandSkillReferences(text, [...store.userSkills, ...store.agentPackageSkills])
              : expandSkillBindings(text, task.skillBindings),
            excludeMessageIds: [userMessageId, assistantMessageId],
            signal,
            callbacks: {
              onTextDelta: streamingMessage.append,
          onReasoningDelta: streamingMessage.appendReasoning,
              onComplete: (fullText) => {
                streamingMessage.flush();
                streamingMessage.cancel();
                useAppStore.getState().updateMessage(assistantMessageId, {
                  content: fullText,
                  status: 'done',
                });
                onProgress?.();
              },
              onApprovalRequired: (step) => {
                streamingMessage.flush();
                const currentStore = useAppStore.getState();
                const message = currentStore.messages.find(
                  (item) => item.id === assistantMessageId,
                );
                currentStore.updateMessage(assistantMessageId, {
                  content: message?.content || `等待确认：${step.title}`,
                  status: 'preview',
                });
              },
              onToolResult: (result) => {
                if (!result.sources?.length) return;
                const currentStore = useAppStore.getState();
                const message = currentStore.messages.find(
                  (item) => item.id === assistantMessageId,
                );
                const sources = [...(message?.sources ?? [])];
                for (const source of result.sources) {
                  if (!sources.some((item) => item.url === source.url)) sources.push(source);
                }
                currentStore.updateMessage(assistantMessageId, { sources });
                onProgress?.();
              },
              onError: (error) => {
                if (signal.aborted) return;
                streamingMessage.flush();
                streamingMessage.cancel();
                failed = true;
                useAppStore.getState().updateMessage(assistantMessageId, {
                  content: useAppStore.getState().messages.find((item) => item.id === assistantMessageId)?.content || `处理失败: ${error}`,
              responseError: sanitizeDomainText(error).slice(0, 1000),
                  status: useAppStore.getState().agentTasks.find((item) => item.id === taskId)?.status === 'paused' ? 'interrupted' : 'error',
                  finishReason: 'error',
                });
              },
            },
          });
          if (outcome === 'paused' && useAppStore.getState().agentTasks.find(
            (item) => item.id === taskId,
          )?.pausedReason === 'model_output_truncated') {
            streamingMessage.flush();
            streamingMessage.cancel();
            const current = useAppStore.getState().messages.find((item) => item.id === assistantMessageId);
            useAppStore.getState().updateMessage(assistantMessageId, {
              content: current?.content || '模型回复达到输出上限，本轮工具提案未执行，可继续任务。',
              status: 'partial',
              finishReason: 'length',
            });
            onProgress?.();
          }
          return outcome;
        }

        await withLegacyDispatch(taskId, signal, async () => { await runStreamingPipeline(text, conversationId, {
          onTextDelta: streamingMessage.append,
          onReasoningDelta: streamingMessage.appendReasoning,
          onComplete: (fullText, results) => {
            streamingMessage.flush();
            streamingMessage.cancel();
            useAppStore.getState().updateMessage(assistantMessageId, {
              content: fullText,
              status: 'done',
              executionResults: results.length > 0 ? results : undefined,
            });
            onProgress?.();
          },
          onError: (error) => {
            if (signal.aborted) return;
            streamingMessage.flush();
            streamingMessage.cancel();
            failed = true;
            useAppStore.getState().updateMessage(assistantMessageId, {
              content: useAppStore.getState().messages.find((item) => item.id === assistantMessageId)?.content || `处理失败: ${error}`,
              responseError: sanitizeDomainText(error).slice(0, 1000),
              status: 'error',
              finishReason: 'error',
            });
          },
          onMediaIntent: (intent) => {
            void triggerMediaGeneration(assistantMessageId, intent);
          },
          signal,
        }, projectId); if (failed) throw new Error('旧对话执行未能返回完整结果'); });
        return failed ? 'failed' : 'completed';
      } finally {
        streamingMessage.flush();
        streamingMessage.cancel();
        unsubscribe();
        const currentStore = useAppStore.getState();
        const currentMessage = currentStore.messages.find((item) => item.id === assistantMessageId);
        const currentTask = currentStore.agentTasks.find((item) => item.id === taskId);
        if (currentMessage?.status === 'streaming' && (signal.aborted || currentTask?.status === 'paused')) {
          currentStore.updateMessage(assistantMessageId, {
            status: currentTask?.status === 'stopped' ? 'canceled' : 'interrupted',
            finishReason: signal.aborted ? 'canceled' : currentMessage.finishReason,
          });
        }
        useAppStore.getState().updateMessageTransient(assistantMessageId, { activity: undefined, activityStartedAt: undefined });
      }
    }

    if (isGeneralAssistantScope(projectId) || mode === 'plan' || task.toolAllowlist !== undefined || task.creationProfile) {
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: isGeneralAssistantScope(projectId)
          ? '未选择可用的对话文本模型，本次请求尚未处理。请在输入框下方选择已配置的文本模型后重试。'
          : mode === 'plan'
          ? 'Plan 模式需要配置文本模型后才能生成分析与规划；未执行任何写操作。'
          : '该 Skill 声明了工具限制，需要配置文本模型后才能安全执行；未执行任何操作。',
        status: 'error',
        finishReason: 'error',
      });
      onProgress?.();
      return 'failed';
    }

    try {
      const result = await withLegacyDispatch(taskId, signal, async () => {
        const response = await runAssistantPipeline(text, conversationId, projectId);
        if (response.errorCode) throw new Error(response.reply);
        return response;
      });
      if (result.errorCode) throw new Error(result.reply);
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: result.reply,
        status: 'done',
        executionResults: result.commandResults.length > 0 ? result.commandResults : undefined,
      });
      onProgress?.();
      return 'completed';
    } catch (error) {
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: `处理失败: ${error instanceof Error ? error.message : '未知错误'}`,
        status: 'error',
        finishReason: 'error',
      });
      return useAppStore.getState().agentTasks.find((item) => item.id === taskId)?.status === 'paused' ? 'paused' : 'failed';
    }
  }).then(() => undefined).catch((error) => {
    console.error('[AgentRuntime] failed to execute chat task:', error);
  });
}

function tryInterjectConversationMessage(
  conversationId: string,
  content: string,
): string | undefined {
  const taskId = getActiveConversationAgentTaskId(conversationId);
  const team = useAppStore.getState().agentTasks.find((item) => item.id === taskId && item.executionKind === 'team');
  if (team) {
    if (!content.trim() || content.length > MAX_INTERJECTION_CHARS) return undefined;
    useAppStore.getState().addMessage({ id: createMessageId(), conversationId, role: 'user', content,
      timestamp: Date.now(), status: 'done', agentTaskId: team.id });
    void appendTeamInstruction(team.id, content).catch((error: unknown) => {
      useAppStore.getState().showToast(sanitizeDomainText(error instanceof Error ? error.message : '追加要求未能应用').slice(0, 300), 'error');
    });
    return team.id;
  }
  if (!taskId || !enqueueAgentInterjection(taskId, content)) return undefined;
  useAppStore.getState().addMessage({
    id: createMessageId(),
    conversationId,
    role: 'user',
    content,
    timestamp: Date.now(),
    status: 'done',
    agentTaskId: taskId,
  });
  return taskId;
}

export async function triggerMediaGeneration(
  messageId: string,
  intent: MediaGenerationIntent,
): Promise<void> {
  const store = useAppStore.getState();
  const projectId = store.currentProjectId;
  const originMessage = store.messages.find((message) => message.id === messageId);
  const apiWorkflow = store.workflows.find((workflow) => workflow.adapterType === 'workflow-api' && `workflow-api/${workflow.id}` === intent.modelRef);
  const taskContext = projectId && originMessage ? {
    projectId, conversationId: originMessage.conversationId, messageId, deliveryMode: intent.deliveryMode,
  } : undefined;
  const isCurrentApiMessage = () => useAppStore.getState().currentProjectId === projectId
    && useAppStore.getState().messages.some((message) => message.id === messageId && message.conversationId === originMessage?.conversationId);
  const needsCanvas = intent.deliveryMode === 'canvas' || intent.deliveryMode === 'both';
  let targetNodeId: string | undefined;
  let placeholderLifecycle: MediaPlaceholderLifecycle | null = null;

  if (needsCanvas) {
    targetNodeId = store.createMediaPlaceholder(intent);
    if (apiWorkflow) store.updateNodeDataTransient(targetNodeId, { ...workflowExecution(apiWorkflow), workflowInputs: intent.workflowInputs });
    placeholderLifecycle = registerMediaPlaceholderLifecycle(targetNodeId);
  }
  const mediaLabel = intent.kind === 'image'
    ? '图片'
    : intent.kind === 'video'
      ? '视频'
      : '音频';
  store.updateMessage(messageId, {
    mediaStatus: 'queued',
    mediaError: undefined,
    canvasStatus: needsCanvas ? 'pending' : 'none',
    canvasNodeId: targetNodeId,
    canvasError: undefined,
  });
  try {
    store.updateMessage(messageId, { mediaStatus: 'generating' });
    const result = await runMediaGeneration(intent, projectId, undefined, targetNodeId, taskContext);
    if (!isCurrentApiMessage()) return;
    if (isMediaDeliveryGroup(result)) {
      try {
        const delivered = await deliverMediaMessageGroup(messageId, result, { targetNodeId,
          guard: placeholderLifecycle?.guard, isCurrent: isCurrentApiMessage,
          allowCanvas: !targetNodeId || Boolean(placeholderLifecycle) });
        if (targetNodeId && delivered.canvasReady) useAppStore.getState().incrementRevision();
        if (!delivered.complete) store.showToast('候选图片已生成，部分保存或回填尚未完成，可继续取回原结果', 'info');
      } finally {
        if (placeholderLifecycle) completeCanvasDerivation(placeholderLifecycle.guard);
      }
      return;
    }
    const nodeCreated = placeholderLifecycle
      ? settleMediaPlaceholderLifecycle(placeholderLifecycle, result)
      : targetNodeId ? useAppStore.getState().settleMediaPlaceholder(targetNodeId, result) : false;
    store.updateMessage(messageId, {
      mediaResult: result,
      mediaStatus: 'succeeded',
      mediaError: undefined,
      canvasStatus: targetNodeId ? (nodeCreated ? 'created' : 'failed') : 'none',
      canvasNodeId: targetNodeId,
      canvasError: targetNodeId && !nodeCreated ? MEDIA_PLACEHOLDER_STALE_ERROR : undefined,
    });
    await completeMediaMessageDelivery(messageId, result, !targetNodeId || nodeCreated);
    if (projectId && ['runninghub', 'runninghubwf'].includes(result.provider)
      && result.persistence !== 'failed' && (!targetNodeId || nodeCreated)) {
      const trackingId = targetNodeId ?? `runninghub-message-${messageId}`;
      const originalTask = getPendingTasksForProject(projectId).find((task) => task.nodeId === trackingId
        && task.runninghubMessage?.messageId === messageId);
      const deliveredMessage = useAppStore.getState().messages.find((message) => message.id === messageId
        && message.mediaResult?.id === result.id);
      if (originalTask && deliveredMessage) {
        await persistMessage(deliveredMessage, projectId, deliveredMessage.conversationId);
        if (isCurrentApiMessage()
          && useAppStore.getState().messages.some((message) => message.id === messageId && message.mediaResult?.id === result.id)
          && getPendingTasksForProject(projectId).some((task) => task.nodeId === trackingId
            && task.taskId === originalTask.taskId && task.attemptId === originalTask.attemptId)) {
          completeRunningHubNodeTask(trackingId);
        }
      }
    }
    if (result.workflowApiTaskId && (!targetNodeId || nodeCreated)) completeWorkflowApiNodeTask(targetNodeId ?? `workflow-api-message-${messageId}`, result.workflowApiTaskId);
    // 生成成功不代表已可靠保存，落盘失败必须让用户知道并能重试
    if (result.persistence === 'failed') {
      store.showToast(
        `${mediaLabel}已生成，但未保存到项目：${result.persistError || MEDIA_PERSIST_FAILED_MESSAGE}`,
        'error',
      );
    }
  } catch (error) {
    if (!isCurrentApiMessage()) return;
    const recoverable = isMediaTaskPausedError(error);
    const submissionUnknown = recoverable && 'reason' in error && error.reason === 'submit_unknown';
    const message = error instanceof Error ? error.message : '未知错误';
    if (placeholderLifecycle && recoverable) completeCanvasDerivation(placeholderLifecycle.guard);
    else if (placeholderLifecycle) failMediaPlaceholderLifecycle(placeholderLifecycle, message);
    else if (targetNodeId) useAppStore.getState().failMediaPlaceholder(targetNodeId, message);
    store.updateMessage(messageId, {
      mediaStatus: submissionUnknown ? 'submit_unknown' : recoverable ? 'paused' : 'failed',
      mediaError: message,
      canvasStatus: targetNodeId ? 'failed' : 'none',
      canvasNodeId: targetNodeId,
      canvasError: targetNodeId ? message : undefined,
    });
    store.showToast(recoverable ? `${mediaLabel}任务已保留，可继续查询原任务` : `${mediaLabel}生成失败: ${message}`, recoverable ? 'info' : 'error');
  }
}
