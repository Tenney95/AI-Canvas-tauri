/**
 * Agent Runtime 重型执行入口。
 *
 * 任务控制、同步中止和状态迁移位于 agentTaskControl；本模块只保留需要
 * 模型上下文、工具执行器和多轮循环的按需运行时。
 */
import { useAppStore } from '../../store/useAppStore';
import type { AssistantModelMessage } from '../ai/assistantStream';
import {
  assembleAgentContext,
  ContextBudgetError,
} from './contextManager';
import {
  closeAgentInterjectionBuffer,
  openAgentInterjectionBuffer,
} from './agentInterjection';
import { buildAgentResumeContext } from './agentCheckpointService';
import { clearProviderDocsTask } from './providerDocsGrantService';
import { clearWebAccessTask } from './webAccessGrantService';
import {
  executeAgentRound,
  type AgentRoundCallbacks,
} from './agentRoundExecutor';
import {
  transitionAgentTask,
  waitForAgentApproval,
  type AgentExecutionOutcome,
} from './agentTaskControl';

export * from './agentTaskControl';
export {
  maxAutoRetriesForEffect,
  sanitizePersistentSummary,
} from './agentRoundExecutor';

export type AgentLoopCallbacks = AgentRoundCallbacks;

export interface AgentLoopOptions {
  taskId: string;
  systemPrompt: string;
  userMessage: string;
  signal: AbortSignal;
  callbacks?: AgentLoopCallbacks;
  /** 当前轮已在界面新建的消息 ID（用户消息、助手占位），组装历史时排除 */
  excludeMessageIds?: string[];
}

export async function runAgentLoop({
  taskId,
  systemPrompt,
  userMessage,
  signal,
  callbacks = {},
  excludeMessageIds,
}: AgentLoopOptions): Promise<AgentExecutionOutcome> {
  const initialTask = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!initialTask) throw new Error(`未找到 Agent 任务: ${taskId}`);

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
    const resumeContext = buildAgentResumeContext(initialTask);
    if (resumeContext) {
      messages.splice(Math.min(1, messages.length), 0, {
        role: 'system',
        content: resumeContext,
      });
    }
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

  openAgentInterjectionBuffer(taskId);
  try {
    while (!signal.aborted) {
      const round = await executeAgentRound({
        taskId,
        signal,
        messages,
        fullText,
        totalToolResultChars,
        callbacks,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
      });
      fullText = round.fullText;
      totalToolResultChars = round.totalToolResultChars;
      if (round.outcome !== 'continue') return round.outcome;
    }
    throw new DOMException('Aborted', 'AbortError');
  } finally {
    closeAgentInterjectionBuffer(taskId);
    clearProviderDocsTask(taskId);
    clearWebAccessTask(taskId);
  }
}
