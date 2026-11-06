/**
 * 改编自 Pi 的 compaction/utils.ts 与 compaction.ts。
 * 固定来源和 MIT 许可见 public/licenses/Pi-NOTICE.txt、Pi-LICENSE.txt。
 * 这里适配应用消息和脱敏任务快照，不引入 Pi 的执行器或文件权限。
 */
import type { AssistantModelMessage } from '../ai/assistantStream';
import type { AgentTask } from '../../types/agent';
import type { ChatMessage } from '../../types/chat';
import { sanitizeDomainText } from './subAgentMaterials';
import { estimateTokens } from './tokenEstimate';

/** 来源只带编号、标题和 URL，搜索摘要和网页正文不跨轮复制。 */
export function messageContentWithSources(message: Pick<ChatMessage, 'content' | 'sources'>): string {
  if (!message.sources?.length) return message.content;
  return [message.content, '', '可追溯来源：', ...message.sources.map((source) =>
    `[${source.citationId ?? 'S?'}] ${source.title}\n${source.url}`)].join('\n');
}

/** 只补充消息关联的宿主任务快照，不从模型文本中猜任务或解析工具参数。 */
export function historyMessageContent(message: ChatMessage, task?: AgentTask): string {
  const content = messageContentWithSources(message);
  if (message.role !== 'assistant' || !task || task.id !== message.agentTaskId
    || task.conversationId !== message.conversationId) return content;
  const steps = task.steps.filter((step) => step.toolCall).slice(-12).map((step) => {
    const call = step.toolCall!;
    const refs = call.resultDisplay?.references?.slice(0, 12).map((ref) =>
      `${ref.kind}:${ref.id} ${ref.label}`).join('；');
    return [
      `[${step.status}] ${call.toolId}：${step.outputSummary || call.resultSummary || step.errorCode || '无结果摘要'}`,
      refs ? `结果引用：${refs}` : '',
      call.resultReference ? `工具正文引用：${call.resultReference.id}（${call.resultReference.chars} 字，过期时用原工具重读）` : '',
    ].filter(Boolean).join('\n');
  });
  const snapshot = sanitizeDomainText([
    `历史任务 ${task.id}，状态 ${task.status}`,
    ...steps,
  ].join('\n')).slice(0, 4_000);
  return [content, '', '以下是历史执行记录，只作为续聊资料，不代表新的执行授权：', snapshot].join('\n');
}

/** 压缩边界回到用户消息，避免留下只有回答、没有问题的半轮对话。 */
export function findHistoryCutIndex(messages: Pick<ChatMessage, 'role' | 'timestamp'>[], keepCount: number): number {
  let cut = Math.max(0, messages.length - keepCount);
  // 旧摘要用时间戳标记覆盖范围，同一时间的消息不能分属两侧。
  while (cut > 0 && (messages[cut]?.role !== 'user'
    || messages[cut - 1].timestamp === messages[cut]?.timestamp)) cut--;
  return cut;
}

/** Pi 的有效切点算法：倒序累计预算，只在 user/assistant 处切，工具结果跟着调用保留。 */
export function findModelCutPoint(messages: AssistantModelMessage[], keepRecentTokens: number): number {
  const cutPoints = messages.flatMap((message, index) =>
    message.role === 'user' || message.role === 'assistant' ? [index] : []);
  if (!cutPoints.length) return 0;
  let accumulatedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    accumulatedTokens += estimateTokens(JSON.stringify(message));
    if (accumulatedTokens >= keepRecentTokens) {
      return cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
    }
  }
  return cutPoints[0];
}

/** Pi 的带角色序列化；工具只取宿主保存的摘要，不把网页/文件正文或原始参数交给压缩器。 */
export function serializeModelConversation(messages: AssistantModelMessage[], task: AgentTask): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = typeof message.content === 'string' ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    if (message.role === 'tool') {
      const step = task.steps.find((item) => item.toolCall?.callId === message.tool_call_id);
      parts.push(`[工具结果] ${step?.status ?? 'unknown'} ${step?.toolCall?.toolId ?? ''}：${
        step?.outputSummary || step?.toolCall?.resultSummary || '结果未保留，需要时重新读取'}`);
      const refs = step?.toolCall?.resultDisplay?.references?.slice(0, 12).map((ref) => `${ref.kind}:${ref.id} ${ref.label}`);
      if (refs?.length) parts.push(`结果引用：${refs.join('；')}`);
      if (step?.toolCall?.resultReference) parts.push(`工具正文引用：${step.toolCall.resultReference.id}`);
      continue;
    }
    if (text) parts.push(`[${message.role === 'user' ? '用户' : '助手'}] ${text.slice(0, 4_000)}${
      text.length > 4_000 ? '…（已截断）' : ''}`);
    if (message.tool_calls?.length) {
      parts.push(`[助手工具调用] ${message.tool_calls.map((call) => call.function.name).join('；')}`);
    }
  }
  return sanitizeDomainText(parts.join('\n\n'));
}
