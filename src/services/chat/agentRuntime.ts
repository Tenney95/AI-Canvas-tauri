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
import { clearSkillCatalogTask } from './skillCatalog';
import { clearProviderModelCatalogsForTask } from './providerModelCatalogService';
import {
  executeAgentRound,
  type AgentRoundCallbacks,
} from './agentRoundExecutor';
import {
  consumeAgentReplanRequest,
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

const CURRENT_TASK_BOUNDARY = [
  '当前 AgentTask 边界：紧随本消息之后的最后一条 user 消息是本任务的唯一执行目标。',
  '此前的 user 请求和 assistant 承诺只能作为背景，不得当作待执行工作；只有当前目标明确引用时才能继续它们。',
  '当前目标完成后应结束任务，不得回头执行历史中的其他请求。',
].join('');

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
      // 重新规划要求已写入本次请求上下文，清除后下一次普通「继续」不再重复要求重规划
      consumeAgentReplanRequest(taskId);
    }
    const currentUserIndex = messages.map((message) => message.role).lastIndexOf('user');
    messages.splice(currentUserIndex >= 0 ? currentUserIndex : messages.length, 0, {
      role: 'system',
      content: CURRENT_TASK_BOUNDARY,
    });
  } catch (error) {
    clearProviderDocsTask(taskId);
    clearWebAccessTask(taskId);
    clearProviderModelCatalogsForTask(taskId);
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
    clearSkillCatalogTask(taskId);
    clearProviderModelCatalogsForTask(taskId);
  }
}
