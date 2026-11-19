import { useAppStore } from '../../store/useAppStore';
import { resolveConversationProjectScope } from './conversationProjectScope';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import { forkChatConversationAtMessage } from '../indexedDbService';
import { isGeneralAssistantScope } from './assistantScope';
import { sanitizeDomainText } from './subAgentMaterials';

export function sanitizeConversationBranchText(text: string): string {
  return sanitizeDomainText(text)
    .replace(/@image\{[^}\r\n]*\}/g, '[历史参考图，需重新上传]')
    .replace(/@file\{[^}\r\n]*\}/g, '[历史文件，需重新授权]')
    .replace(/\bgrant-[A-Za-z0-9_-]+\b/g, '[历史文件授权已失效]');
}

/** 仅持久化资料，不修改源会话、启动模型、重放命令或继承材料授权。 */
export async function createConversationBranch(input: {
  projectId: string; conversationId: string; messageId: string; title?: string;
}): Promise<{ conversation: ChatConversation; messages: ChatMessage[] }> {
  const state = useAppStore.getState();
  const source = state.conversations.find((item) => item.id === input.conversationId);
  const scope = state.currentProjectId ? resolveConversationProjectScope(state.projects, state.currentProjectId) : null;
  if (!source || source.deletedAt || source.projectId !== input.projectId
    || (!isGeneralAssistantScope(source.projectId) && !scope?.projectIds.has(source.projectId))) throw new Error('只能对当前项目中的有效对话创建分支');
  const result = await forkChatConversationAtMessage({ ...input, newConversationId: `conv-${crypto.randomUUID()}`,
    ...(scope?.nativeProjectId && scope.ownerId !== source.projectId && scope.projectIds.has(source.projectId)
      ? { newProjectId: scope.ownerId } : {}),
    sanitize: sanitizeConversationBranchText });
  return { conversation: result.conversation,
    messages: result.messages.map<ChatMessage>((message) => ({ id: message.id, conversationId: message.conversationId,
      role: message.role, content: message.content, timestamp: message.createdAt, status: 'done',
      ...(message.role === 'assistant' ? { finishReason: 'stop' as const } : {}) })) };
}
