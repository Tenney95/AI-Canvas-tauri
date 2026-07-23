/**
 * chatHistoryService — 对话历史持久化服务
 * 封装 IndexedDB 会话与消息的 CRUD，提供缓存分页、垃圾回收和迁移
 */
import {
  putChatConversation,
  getProjectConversations,
  getTrashConversations,
  putChatMessageWithSequence,
  getConversationMessages,
  deleteConversationMessages,
  permanentlyDeleteConversation,
  type ChatConversationRecord,
  type ChatMessageRecord,
} from '../indexedDbService';
import type {
  ChatConversation,
  ChatMessage,
  ChatMessageStatus,
  CommandIntent,
  CommandResult,
} from '../../types/chat';
import type {
  CanvasMaterializationStatus,
  MediaGenerationResult,
  MediaGenerationStatus,
} from '../../types/media';

// ============================================
// Type converters
// ============================================

function toConversationRecord(c: ChatConversation): ChatConversationRecord {
  return { ...c };
}

function fromConversationRecord(r: ChatConversationRecord): ChatConversation {
  return {
    ...r,
    agentMode: r.agentMode ?? 'collaborative',
  };
}

function toMessageRecord(
  m: ChatMessage,
  projectId: string,
  conversationId: string,
  sequence: number,
): ChatMessageRecord {
  return {
    id: m.id,
    projectId,
    conversationId,
    sequence,
    role: m.role,
    content: m.content,
    status: m.status,
    requestId: m.requestId,
    agentTaskId: m.agentTaskId,
    modelId: m.modelId,
    createdAt: m.timestamp,
    updatedAt: Date.now(),
    finishReason: m.finishReason,
    commands: m.commands,
    executionResults: m.executionResults,
    mediaStatus: m.mediaStatus,
    mediaError: m.mediaError,
    mediaResult: m.mediaResult,
    canvasStatus: m.canvasStatus,
    canvasNodeId: m.canvasNodeId,
    canvasError: m.canvasError,
    sources: m.sources,
  };
}

function fromMessageRecord(r: ChatMessageRecord): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversationId,
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content,
    timestamp: r.createdAt,
    status: r.status as ChatMessageStatus,
    requestId: r.requestId,
    agentTaskId: r.agentTaskId,
    modelId: r.modelId,
    finishReason: r.finishReason as ChatMessage['finishReason'],
    commands: r.commands as CommandIntent[] | undefined,
    executionResults: r.executionResults as CommandResult[] | undefined,
    mediaStatus: r.mediaStatus as MediaGenerationStatus | undefined,
    mediaError: r.mediaError,
    mediaResult: r.mediaResult as MediaGenerationResult | undefined,
    canvasStatus: r.canvasStatus as CanvasMaterializationStatus | undefined,
    canvasNodeId: r.canvasNodeId,
    canvasError: r.canvasError,
    sources: r.sources as ChatMessage['sources'],
  };
}

// ============================================
// Conversation API
// ============================================

/** 保存 / 更新会话 */
export async function saveConversation(conversation: ChatConversation): Promise<void> {
  await putChatConversation(toConversationRecord(conversation));
}

/** 获取项目的全部会话（不含回收站） */
export async function loadProjectConversations(projectId: string): Promise<ChatConversation[]> {
  const records = await getProjectConversations(projectId);
  return records
    .map(fromConversationRecord)
    .sort((a, b) => {
      // 置顶优先
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // 按 updatedAt 降序
      return b.updatedAt - a.updatedAt;
    });
}

/** 获取回收站会话 */
export async function loadTrashConversations(projectId: string): Promise<ChatConversation[]> {
  const records = await getTrashConversations(projectId);
  return records.map(fromConversationRecord).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 软删除：移入回收站 */
export async function softDeleteConversation(
  conversation: ChatConversation,
): Promise<ChatConversation> {
  const updated: ChatConversation = {
    ...conversation,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveConversation(updated);
  return updated;
}

/** 恢复：从回收站恢复 */
export async function restoreConversation(
  conversation: ChatConversation,
): Promise<ChatConversation> {
  const updated: ChatConversation = {
    ...conversation,
    deletedAt: undefined,
    updatedAt: Date.now(),
  };
  await saveConversation(updated);
  return updated;
}

/** 永久删除会话及其全部消息 */
export async function hardDeleteConversation(convId: string): Promise<void> {
  await permanentlyDeleteConversation(convId);
}

// ============================================
// Message API
// ============================================

/**
 * 保存单条消息到 IndexedDB。
 * sequence 在写入事务内分配：已存在的消息保留原序号（更新不重排），
 * 新消息取当前最大序号 +1（并发落盘不重复）。
 */
export async function persistMessage(
  message: ChatMessage,
  projectId: string,
  conversationId: string,
): Promise<void> {
  await putChatMessageWithSequence(toMessageRecord(message, projectId, conversationId, 0));
}

/** 按分页加载消息（倒序：最新的先返回） */
export async function loadMessages(
  conversationId: string,
  offset: number = 0,
  limit: number = 50,
): Promise<{ messages: ChatMessage[]; total: number }> {
  const result = await getConversationMessages(conversationId, offset, limit);
  return {
    messages: result.messages.map(fromMessageRecord).reverse(), // 反转回正序
    total: result.total,
  };
}

/** 清空指定会话的全部消息 */
export async function clearConversationMessages(conversationId: string): Promise<void> {
  await deleteConversationMessages(conversationId);
}

// ============================================
// 修复遗留 streaming 消息
// ============================================

/**
 * 启动时将遗留的 streaming / parsing / executing 消息恢复为 interrupted。
 * 返回修复的会话 ID 列表。
 */
export async function repairInterruptedMessages(
  projectId: string,
): Promise<string[]> {
  const conversations = await loadProjectConversations(projectId);
  const affectedConvIds: string[] = [];

  for (const conv of conversations) {
    let repaired = false;
    const { messages } = await loadMessages(conv.id, 0, 50);
    for (const msg of messages) {
      if (
        msg.status === 'streaming' ||
        msg.status === 'parsing' ||
        msg.status === 'executing' ||
        msg.status === 'queued'
      ) {
        const updated: ChatMessage = {
          ...msg,
          status: 'interrupted',
          finishReason: 'error',
        };
        await persistMessage(updated, projectId, conv.id);
        repaired = true;
      }
    }
    if (repaired) affectedConvIds.push(conv.id);
  }

  return affectedConvIds;
}
