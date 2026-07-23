import { runMediaGeneration } from '../ai/generationRuntime';
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
import { enqueueAgentInterjection } from './agentInterjection';
import {
  getActiveConversationAgentTaskId,
  scheduleConversationAgentExecution,
} from './agentScheduler';
import { getAvailableAgentTools } from './toolRegistry';
import { ensureAgentToolsRegistered } from './tools';
import {
  expandSkillReferences,
  resolveSkillToolAllowlist,
} from '../skillPromptService';
import { useAppStore } from '../../store/useAppStore';
import type { ChatMessage } from '../../types/chat';
import {
  DEFAULT_AGENT_TASK_BUDGET,
  type AgentApprovalResolution,
  type AgentMode,
} from '../../types/agent';
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
  flush: () => void;
  cancel: () => void;
}

export interface SubmitConversationMessageOptions {
  content: string;
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
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPending = () => {
    flushTimer = null;
    if (!pendingText) return;
    const delta = pendingText;
    pendingText = '';
    const store = useAppStore.getState();
    const message = store.messages.find((item) => item.id === messageId);
    if (!message) return;
    store.updateMessageTransient(messageId, {
      content: (message.content || '') + delta,
      status: 'streaming',
    });
    onProgress?.();
  };

  const clearFlushTimer = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  return {
    append: (delta) => {
      if (!delta) return;
      pendingText += delta;
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, STREAMING_UI_FLUSH_INTERVAL_MS);
      }
    },
    flush: () => {
      clearFlushTimer();
      flushPending();
    },
    cancel: () => {
      clearFlushTimer();
      pendingText = '';
    },
  };
}

export function getAgentModeToast(mode: AgentMode): string {
  if (mode === 'plan') return '已切换到 Plan 模式：仅分析与规划，不执行任何写操作';
  if (mode === 'autonomous') {
    return '已切换到 C 自主模式：画布操作可自动执行，付费媒体和文件写入仍需确认';
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
  conversationId,
  projectId,
  mode,
  dispatchMode = 'queue',
  onProgress,
}: SubmitConversationMessageOptions): SubmitConversationMessageResult {
  const text = content.trim();
  if (!text || !conversationId) return { status: 'ignored' };

  const interjectedTaskId = dispatchMode === 'interject'
    ? tryInterjectConversationMessage(conversationId, text)
    : undefined;
  if (interjectedTaskId) {
    onProgress?.();
    return { status: 'interjected', taskId: interjectedTaskId };
  }

  const store = useAppStore.getState();
  const conversation = store.conversations.find((item) => item.id === conversationId);
  const userMessage: ChatMessage = {
    id: createMessageId(),
    conversationId,
    role: 'user',
    content: text,
    timestamp: Date.now(),
    status: 'done',
  };
  store.addMessage(userMessage);

  const assistantMessage: ChatMessage = {
    id: createMessageId(),
    conversationId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    status: resolveAssistantModel() ? 'streaming' : 'parsing',
  };
  store.addMessage(assistantMessage);

  const taskId = startAgentMessageExecution({
    text,
    projectId: projectId ?? conversation?.projectId ?? store.currentProjectId ?? '',
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
    const task = store.createAgentTask({
      projectId,
      conversationId,
      userMessageId,
      mode,
      goal: text,
      toolAllowlist: resolveSkillToolAllowlist(text, store.userSkills),
    });
    taskId = task.id;
    store.updateMessage(assistantMessageId, { agentTaskId: task.id });
    scheduleAgentTaskExecution(task.id, assistantMessageId, onProgress);
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
): void {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task) return;
  const scheduled = scheduleConversationAgentExecution({
    taskId,
    conversationId: task.conversationId,
    onStart: () => {
      const store = useAppStore.getState();
      if (resume) prepareAgentTaskResume(taskId);
      const message = store.messages.find((item) => item.id === assistantMessageId);
      if (message && message.status === 'queued') {
        store.updateMessage(assistantMessageId, {
          status: resolveAssistantModel() ? 'streaming' : 'parsing',
        });
      }
    },
    run: () => driveAgentTask(taskId, assistantMessageId, onProgress),
    onError: (error) => {
      console.error('[AgentScheduler] failed to execute chat task:', error);
    },
  });
  if (scheduled.state === 'queued') {
    useAppStore.getState().updateMessage(assistantMessageId, { status: 'queued' });
  }
}

export function resumeAgentTaskExecution(
  taskId: string,
  onProgress?: () => void,
): AgentResumeValidation {
  const validation = validateTaskResumable(taskId);
  if (!validation.ok) return validation;

  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId)!;
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

  const nextBudget = { ...task.budget };
  if (task.modelRounds >= task.budget.maxModelRounds) {
    nextBudget.maxModelRounds = task.modelRounds + DEFAULT_AGENT_TASK_BUDGET.maxModelRounds;
  }
  if (task.toolCallCount >= task.budget.maxToolCalls) {
    nextBudget.maxToolCalls = task.toolCallCount + DEFAULT_AGENT_TASK_BUDGET.maxToolCalls;
  }
  store.updateAgentTask(taskId, { budget: nextBudget });
  scheduleAgentTaskExecution(taskId, message.id, onProgress, true);
  return { ok: true };
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

    if (resolveAssistantModel()) {
      const streamingMessage = createStreamingMessageBuffer(assistantMessageId, onProgress);
      const availableTools = getAvailableAgentTools({
        taskId,
        projectId,
        conversationId,
        mode,
        toolAllowlist: task.toolAllowlist,
      });
      if (
        availableTools.length > 0
        || mode === 'plan'
        || task.toolAllowlist !== undefined
      ) {
        return runAgentLoop({
          taskId,
          systemPrompt: buildAssistantSystemPrompt({ agentTools: true }),
          userMessage: expandSkillReferences(text, store.userSkills),
          excludeMessageIds: [userMessageId, assistantMessageId],
          signal,
          callbacks: {
            onTextDelta: streamingMessage.append,
            onComplete: (fullText) => {
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
              streamingMessage.cancel();
              failed = true;
              useAppStore.getState().updateMessage(assistantMessageId, {
                content: `处理失败: ${error}`,
                status: 'error',
                finishReason: 'error',
              });
            },
          },
        });
      }

      await runStreamingPipeline(text, conversationId, {
        onTextDelta: streamingMessage.append,
        onComplete: (fullText, results) => {
          streamingMessage.cancel();
          useAppStore.getState().updateMessage(assistantMessageId, {
            content: fullText,
            status: 'done',
            executionResults: results.length > 0 ? results : undefined,
          });
          onProgress?.();
        },
        onError: (error) => {
          streamingMessage.cancel();
          failed = true;
          useAppStore.getState().updateMessage(assistantMessageId, {
            content: `处理失败: ${error}`,
            status: 'error',
            finishReason: 'error',
          });
        },
        onMediaIntent: (intent) => {
          void triggerMediaGeneration(assistantMessageId, intent);
        },
        signal,
      });
      return failed ? 'failed' : 'completed';
    }

    if (mode === 'plan' || task.toolAllowlist !== undefined) {
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: mode === 'plan'
          ? 'Plan 模式需要配置文本模型后才能生成分析与规划；未执行任何写操作。'
          : '该 Skill 声明了工具限制，需要配置文本模型后才能安全执行；未执行任何操作。',
        status: 'done',
      });
      onProgress?.();
      return 'completed';
    }

    try {
      const result = await runAssistantPipeline(text, conversationId);
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
      return 'failed';
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

async function triggerMediaGeneration(
  messageId: string,
  intent: MediaGenerationIntent,
): Promise<void> {
  const store = useAppStore.getState();
  const needsCanvas = intent.deliveryMode === 'canvas' || intent.deliveryMode === 'both';
  let targetNodeId: string | undefined;
  let placeholderLifecycle: MediaPlaceholderLifecycle | null = null;

  if (needsCanvas) {
    targetNodeId = store.createMediaPlaceholder(intent);
    placeholderLifecycle = registerMediaPlaceholderLifecycle(targetNodeId);
  }
  store.updateMessage(messageId, {
    mediaStatus: 'queued',
    mediaError: undefined,
    canvasStatus: needsCanvas ? 'pending' : 'none',
    canvasNodeId: targetNodeId,
    canvasError: undefined,
  });
  try {
    store.updateMessage(messageId, { mediaStatus: 'generating' });
    const result = await runMediaGeneration(intent, store.currentProjectId);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    if (placeholderLifecycle) failMediaPlaceholderLifecycle(placeholderLifecycle, message);
    else if (targetNodeId) useAppStore.getState().failMediaPlaceholder(targetNodeId, message);
    store.updateMessage(messageId, {
      mediaStatus: 'failed',
      mediaError: message,
      canvasStatus: targetNodeId ? 'failed' : 'none',
      canvasNodeId: targetNodeId,
      canvasError: targetNodeId ? message : undefined,
    });
    const mediaLabel = intent.kind === 'image'
      ? '图片'
      : intent.kind === 'video'
        ? '视频'
        : '音频';
    store.showToast(`${mediaLabel}生成失败: ${message}`, 'error');
  }
}
