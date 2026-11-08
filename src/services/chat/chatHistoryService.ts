/**
 * chatHistoryService — 对话历史持久化服务
 * 封装 IndexedDB 会话与消息的 CRUD，提供缓存分页、垃圾回收和迁移
 */
import {
  putChatConversation,
  getProjectConversations,
  putChatMessageWithSequence,
  getConversationMessages,
  deleteConversationMessages,
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
import { isTransientMediaUrl, persistMediaUrlToProjectData } from '../fileService';
import { normalizeExecutionSelection, normalizeTeamProfile } from './teams/teamProfileService';
import { restoreCreationProfileSelection } from '../creationProfiles/creationProfileManifest';
import { normalizeConversationWorkbenchTarget } from './workbenchConversationScope';
import { safeExchangePath } from '../projectExchangeDomain';
import { configValuesEqual } from '../configPatch';
import { openDB, STORE_CHAT_MESSAGES, STORE_CHAT_CONVERSATIONS, STORE_METADATA } from '../indexedDb/schema';
import type { NativeMediaTaskRecord } from '../indexedDb/nativeMediaTaskRepository';
import { nativeImageBatchResults, nativeImageBatchSettled, nativeImageBatchSummary } from '../nativeImageBatch';
import { nativeMediaLocalOutputs } from '../nativeMediaCollection';

const isNativeArtifact = (artifact: MediaGenerationResult | undefined) => !!artifact
  && /^native-media-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:-[1-9][0-9]{0,5})?$/.test(artifact.id);
const nativeMediaSlotKey = (messageId: string) => `native-media-message-slot:${encodeURIComponent(messageId)}`;

// ============================================
// Type converters
// ============================================

function toConversationRecord(c: ChatConversation): ChatConversationRecord {
  return { ...c, workbenchTarget: normalizeConversationWorkbenchTarget(c.workbenchTarget, c.projectId) };
}

/** persistence 是后加的字段，旧记录按有无 filePath 推断，避免历史消息误报未保存。 */
function fromMediaResultRecord(value: unknown): MediaGenerationResult | undefined {
  if (!value) return undefined;
  const artifact = value as MediaGenerationResult;
  if (artifact.persistence) return artifact;
  return { ...artifact, persistence: artifact.filePath ? 'saved' : 'skipped' };
}

async function normalizeMessageMediaRecord(record: ChatMessageRecord): Promise<ChatMessageRecord> {
  const artifact = fromMediaResultRecord(record.mediaResult);
  if (isNativeArtifact(artifact)) {
    // 新库回执由原画布/消息守卫在内存投影；普通消息库只保留受控相对引用。
    let relative = '';
    try { if (artifact!.sourceUrl) relative = safeExchangePath(artifact!.sourceUrl); } catch { /* 不把绝对地址或未知引用落盘。 */ }
    if (artifact!.url === relative && artifact!.sourceUrl === relative && !artifact!.filePath) return record;
    return { ...record, mediaResult: { ...artifact!, url: relative, sourceUrl: relative, filePath: undefined } };
  }
  if (!artifact || (!isTransientMediaUrl(artifact.url) && !isTransientMediaUrl(artifact.sourceUrl))) {
    return record;
  }

  const source = isTransientMediaUrl(artifact.sourceUrl) ? artifact.sourceUrl : artifact.url;
  try {
    const persisted = await persistMediaUrlToProjectData(
      source!,
      record.projectId,
      `ai-${artifact.kind}`,
      `对话${artifact.kind}-${artifact.id}`,
    );
    return {
      ...record,
      mediaResult: {
        ...artifact,
        url: persisted.mediaUrl,
        sourceUrl: persisted.sourceUrl,
        filePath: persisted.filePath,
        persistence: 'saved',
        persistError: undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '内嵌媒体未能迁移到项目目录';
    console.warn('[对话历史] 内嵌媒体迁移失败，已清除持久化正文', {
      projectId: record.projectId,
      messageId: record.id,
      error,
    });
    return {
      ...record,
      mediaResult: {
        ...artifact,
        url: isTransientMediaUrl(artifact.url) ? '' : artifact.url,
        sourceUrl: isTransientMediaUrl(artifact.sourceUrl) ? undefined : artifact.sourceUrl,
        persistence: 'failed',
        persistError: message,
      },
    };
  }
}

function fromConversationRecord(r: ChatConversationRecord): ChatConversation {
  return {
    ...r,
    workbenchTarget: normalizeConversationWorkbenchTarget(r.workbenchTarget, r.projectId),
    agentMode: r.agentMode ?? 'collaborative',
    executionSelection: normalizeExecutionSelection(r.executionSelection),
    creationProfile: restoreCreationProfileSelection(r.creationProfile),
    creationProfileRevision: Number.isSafeInteger(r.creationProfileRevision) && (r.creationProfileRevision ?? -1) >= 0 ? r.creationProfileRevision : 0,
    teamProfileOverride: r.teamProfileOverride ? normalizeTeamProfile(r.teamProfileOverride) : undefined,
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
    mediaResult: fromMediaResultRecord(r.mediaResult),
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
  const record = await normalizeMessageMediaRecord(toMessageRecord(message, projectId, conversationId, 0));
  await persistMessageRecord(record);
}

/** 规范化写回只更新仍存在的同一份媒体字段，保留并发更新的正文及消息元数据。 */
async function persistMessageRecord(record: ChatMessageRecord, normalizedFrom?: ChatMessageRecord): Promise<void> {
  const { projectId, conversationId } = record;
  // 前缀只选择持久化实现；投递授权仍由新库原回执、持久scope和文件校验决定。
  if (isNativeArtifact(record.mediaResult as MediaGenerationResult | undefined) || /^(?:p2|c2)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(projectId)) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_CHAT_MESSAGES, STORE_METADATA], 'readwrite', { durability: 'strict' });
      if (tx.durability !== 'strict') { tx.abort(); reject(new Error('原生消息需要耐久存储')); return; }
      const messages = tx.objectStore(STORE_CHAT_MESSAGES), metadata = tx.objectStore(STORE_METADATA);
      const read = <T>(request: IDBRequest<T>) => new Promise<T>((done, fail) => { request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
      let failure: unknown;
      const work = async () => {
        const [previous, slot] = await Promise.all([read(messages.get(record.id)) as Promise<ChatMessageRecord | undefined>,
          read(metadata.get(nativeMediaSlotKey(record.id))) as Promise<{ kind?: string; state?: string; projectId?: string; conversationId?: string; artifactId?: string } | undefined>]);
        if (slot && (slot.kind !== 'native-media-message-slot-v1' || slot.projectId !== projectId || slot.conversationId !== conversationId
          || !['committed', 'suppressed'].includes(slot.state ?? ''))) throw new Error('原生媒体消息槽归属冲突');
        // 投影收据确认过的消息被删除后，任何迟到快照都不能重新创建。
        if (slot?.state === 'suppressed' || !previous && (normalizedFrom || slot || isNativeArtifact(record.mediaResult as MediaGenerationResult | undefined))) return;
        if (normalizedFrom && previous && !configValuesEqual(previous.mediaResult, normalizedFrom.mediaResult)) return;
        let next = normalizedFrom && previous ? { ...previous, mediaResult: record.mediaResult } : { ...previous, ...record };
        if (previous) {
          if (previous.projectId !== projectId || previous.conversationId !== conversationId || !Number.isSafeInteger(previous.sequence) || previous.sequence < 0
            || !Number.isSafeInteger(previous.updatedAt) || previous.updatedAt < 0) throw new Error('原生消息持久归属冲突');
          const oldArtifact = previous.mediaResult as MediaGenerationResult | undefined;
          const incomingArtifact = record.mediaResult as MediaGenerationResult | undefined;
          if (slot && (!oldArtifact || oldArtifact.id !== slot.artifactId)) return;
          if ((slot || isNativeArtifact(oldArtifact)) && !incomingArtifact) {
            next = { ...next, mediaResult: previous.mediaResult, mediaStatus: previous.mediaStatus, mediaError: previous.mediaError,
              canvasStatus: previous.canvasStatus, canvasNodeId: previous.canvasNodeId, canvasError: previous.canvasError };
          } else if (slot && incomingArtifact?.id !== slot.artifactId) throw new Error('原生媒体消息槽已被占用');
          next.sequence = previous.sequence; next.createdAt = previous.createdAt;
          const stable = (row: ChatMessageRecord) => { const { sequence: _sequence, updatedAt: _updatedAt, ...value } = row; return value; };
          if (configValuesEqual(stable(previous), stable(next))) return;
          next.updatedAt = Math.max(previous.updatedAt, next.updatedAt);
        } else {
          const cursor = await read(messages.index('conversationId_sequence').openKeyCursor(IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]), 'prev'));
          next.sequence = cursor ? (cursor.key as [string, number])[1] + 1 : 0;
          if (!Number.isSafeInteger(next.sequence)) throw new Error('原生消息序号超出范围');
        }
        messages.put(next);
      };
      void work().catch((error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } });
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('原生消息持久化失败'));
    });
    return;
  }
  await putChatMessageWithSequence(record);
}

/** 一次追加所有候选并保存不可变投影收据；重试不重建已经被用户删除的消息。 */
export async function projectNativeMediaMessageBatch(record: NativeMediaTaskRecord,
  canvasNodeIds: readonly (string | undefined)[], isCurrent: () => boolean): Promise<{ created: boolean; messages: ChatMessage[]; batchNote?: string }> {
  const origin = record.origin;
  if (!origin || record.status !== 'delivered' || !record.apimartImageBatch && !record.localResults
    || record.apimartImageBatch && !nativeImageBatchSettled(record.apimartImageBatch)
    || !/^[a-f0-9]{64}$/.test(record.deliveryDigest ?? '')) throw new Error('原媒体作业尚未完成，未投影消息');
  const { listNativeMediaTasks } = await import('../indexedDb/nativeMediaTaskRepository');
  const current = (await listNativeMediaTasks(record.ownerProjectId)).find((row) => row.operationId === record.operationId);
  if (!current || !configValuesEqual(current, record)) throw new Error('原图片批次回执已变化，未投影消息');
  // 既有APIMart收据不追加category字段，保留其不可变binding字节语义。
  const files = record.apimartImageBatch ? nativeImageBatchResults(record) : nativeMediaLocalOutputs(record);
  const categories = nativeMediaLocalOutputs(record).map((file) => file.category);
  const summary = nativeImageBatchSummary(record);
  if (record.apimartImageBatch && !summary) throw new Error('原图片批次缺少完整统计，未投影消息');
  // 后补的lateTaskCount仅用于回执列表；它不能改变已经冻结的候选消息或投影收据。
  const partialDelivery = summary && (summary.failedTasks > 0 || summary.failedSubmissions > 0 || summary.unknownSubmissions > 0 || summary.notStartedSubmissions > 0 || summary.candidateCount < summary.requestedCount);
  let partialNote = partialDelivery && summary ? `原批次部分完成：已保存 ${summary.candidateCount} 个候选，失败任务 ${summary.failedTasks} 个，失败提交 ${summary.failedSubmissions} 个，待核对提交 ${summary.unknownSubmissions} 个，未开始提交 ${summary.notStartedSubmissions} 个。` : '';
  if (!record.apimartImageBatch) {
    const workflow = record.recovery?.kind === 'workflow' && !record.completion ? await (await import('../nativeWorkflowRepository')).readNativeWorkflowSummary(record) : undefined;
    const failedTasks = record.completion?.failedTasks ?? workflow?.failedTasks ?? 0;
    const failedSubmissions = record.completion?.failedSubmissions ?? workflow?.failedSubmissions ?? 0;
    const unknownSubmissions = record.completion?.unknownSubmissions ?? workflow?.unknownSubmissions ?? 0;
    const notStartedSubmissions = record.completion?.notStartedSubmissions ?? workflow?.notStartedSubmissions ?? 0;
    const missing = Math.max(0, (record.recovery?.expectedCount ?? 0) - categories.filter((category) => category === record.category).length);
    if (failedTasks || failedSubmissions || unknownSubmissions || notStartedSubmissions || missing) {
      partialNote = `原媒体作业部分完成：已保存 ${files.length} 个产物，失败任务 ${failedTasks} 个，失败提交 ${failedSubmissions} 个，待核对提交 ${unknownSubmissions} 个，未开始提交 ${notStartedSubmissions} 个，缺少预期产物 ${missing} 个。`;
    }
  }
  const outputLabel = record.apimartImageBatch ? '候选图片' : '媒体产物';
  if (!files.length || files.length !== canvasNodeIds.length) throw new Error('图片候选集合不完整，未投影消息');
  const { readNativeMediaLocalResult } = await import('../nativeMediaLocalResult');
  for (const file of files) { await readNativeMediaLocalResult(record.canvasId, file); if (!isCurrent()) throw new Error('原画布已切换，图片回执保留'); }
  const outputs = files.map((file, ordinal) => ({ ...file,
    artifactId: `native-media-${record.operationId}${ordinal ? `-${ordinal}` : ''}`,
    messageId: ordinal ? `media-output-native-media-${record.operationId}-${ordinal}` : origin.messageId,
  }));
  const binding = { operationId: record.operationId, ownerProjectId: record.ownerProjectId, canvasId: record.canvasId,
    episodeId: record.episodeId, projectEpoch: record.projectEpoch, canvasEpoch: record.canvasEpoch,
    origin, deliveryDigest: record.deliveryDigest, outputs };
  const receiptId = `native-media-message-projection:${record.operationId}`;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_MESSAGES, STORE_CHAT_CONVERSATIONS, STORE_METADATA], 'readwrite', { durability: 'strict' });
    if (tx.durability !== 'strict') { tx.abort(); reject(new Error('图片消息需要耐久投影事务')); return; }
    const messages = tx.objectStore(STORE_CHAT_MESSAGES), conversations = tx.objectStore(STORE_CHAT_CONVERSATIONS), metadata = tx.objectStore(STORE_METADATA);
    const read = <T>(request: IDBRequest<T>) => new Promise<T>((done, fail) => { request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
    let result: { created: boolean; messages: ChatMessage[]; batchNote?: string } | undefined, failure: unknown;
    const work = async () => {
      const [receipt, conversation, stored] = await Promise.all([
        read(metadata.get(receiptId)) as Promise<{ binding?: unknown; state?: string; ownerId?: string } | undefined>,
        read(conversations.get(origin.conversationId)) as Promise<ChatConversationRecord | undefined>,
        Promise.all(outputs.map((output) => read(messages.get(output.messageId)) as Promise<ChatMessageRecord | undefined>)),
      ]);
      if (!isCurrent()) throw new Error('原画布已切换，图片回执保留');
      const belongs = (row: ChatMessageRecord | undefined, ordinal: number) => !!row && row.id === outputs[ordinal].messageId
        && row.conversationId === origin.conversationId && row.projectId === conversation?.projectId
        && row.agentTaskId === origin.agentTaskId && (row.mediaResult as MediaGenerationResult | undefined)?.id === outputs[ordinal].artifactId;
      if (receipt) {
        if (!configValuesEqual(receipt.binding, binding) || !['committed', 'suppressed'].includes(receipt.state ?? '')) throw new Error('图片消息投影收据冲突');
        if (!conversation || conversation.deletedAt || ![record.ownerProjectId, record.canvasId].includes(conversation.projectId)
          || receipt.state === 'suppressed') return { created: false, messages: [] };
        if (receipt.ownerId !== conversation.projectId) throw new Error('原候选会话归属已变化');
        // 缺失记录表示用户删除；只水化仍存在的精确原消息，不补建。
        return { created: false, messages: stored.filter((row, ordinal): row is ChatMessageRecord => belongs(row, ordinal)).map(fromMessageRecord) };
      }
      const root = stored[0];
      if (!conversation || conversation.deletedAt || !root) {
        for (const output of outputs) metadata.add({ id: nativeMediaSlotKey(output.messageId), kind: 'native-media-message-slot-v1',
          state: 'suppressed', operationId: record.operationId, artifactId: output.artifactId,
          projectId: conversation?.projectId ?? record.ownerProjectId, conversationId: origin.conversationId });
        metadata.add({ id: receiptId, kind: 'native-media-message-projection-v1', binding, state: 'suppressed', createdAt: Date.now() });
        return { created: false, messages: [] };
      }
      if (![record.ownerProjectId, record.canvasId].includes(conversation.projectId) || root.projectId !== conversation.projectId
        || root.conversationId !== origin.conversationId || root.id !== origin.messageId || root.role !== 'assistant'
        || !Number.isSafeInteger(conversation.updatedAt) || conversation.updatedAt < 0
        || !Number.isSafeInteger(root.sequence) || root.sequence < 0 || !Number.isSafeInteger(root.updatedAt) || root.updatedAt < 0
        || root.agentTaskId !== origin.agentTaskId
        || root.mediaResult && (root.mediaResult as MediaGenerationResult).id !== outputs[0].artifactId
        || stored.slice(1).some(Boolean)) throw new Error('原图片消息槽或候选消息身份被占用，未覆盖');
      const range = IDBKeyRange.bound([origin.conversationId, 0], [origin.conversationId, Infinity]);
      const [cursor, count] = await Promise.all([read(messages.index('conversationId_sequence').openKeyCursor(range, 'prev')),
        read(messages.index('conversationId_sequence').count(range))]);
      let sequence = cursor ? (cursor.key as [string, number])[1] : -1;
      const projected: ChatMessageRecord[] = [];
      for (const [ordinal, output] of outputs.entries()) {
        if (!Number.isSafeInteger(sequence + 1) || !Number.isSafeInteger(record.updatedAt + ordinal)) throw new Error('图片消息序号超出范围');
        const canvasNodeId = origin.deliveryMode === 'chat' ? undefined : canvasNodeIds[ordinal];
        const patch = { mediaStatus: 'succeeded' as const, mediaError: undefined,
          canvasStatus: origin.deliveryMode === 'chat' ? 'none' as const : canvasNodeId ? 'created' as const : 'failed' as const,
          canvasNodeId, canvasError: origin.deliveryMode !== 'chat' && !canvasNodeId ? '原候选画布节点不可用，图片文件已保留' : undefined,
          mediaResult: { id: output.artifactId, kind: categories[ordinal], deliveryMode: origin.deliveryMode,
            url: output.relativePath, sourceUrl: output.relativePath, persistence: 'saved' as const, prompt: '',
            modelId: origin.modelId ?? record.providerConfigId, provider: record.providerConfigId, createdAt: record.updatedAt } };
        const next: ChatMessageRecord = ordinal ? { id: output.messageId, projectId: conversation.projectId, conversationId: origin.conversationId,
          sequence: ++sequence, role: 'assistant', content: `${outputLabel} ${ordinal + 1}/${outputs.length}${partialNote ? `\n\n${partialNote}` : ''}`, status: 'done',
          createdAt: record.updatedAt + ordinal, updatedAt: record.updatedAt, agentTaskId: origin.agentTaskId, ...patch }
          : { ...root, ...patch, ...(partialNote ? { content: `${root.content}${root.content ? '\n\n' : ''}${partialNote}` } : {}), updatedAt: Math.max(root.updatedAt, record.updatedAt) };
        if (ordinal) messages.add(next); else messages.put(next);
        metadata.add({ id: nativeMediaSlotKey(output.messageId), kind: 'native-media-message-slot-v1', state: 'committed',
          operationId: record.operationId, artifactId: output.artifactId, projectId: conversation.projectId, conversationId: origin.conversationId });
        projected.push(next);
      }
      const lastAt = record.updatedAt + outputs.length - 1;
      conversations.put({ ...conversation, messageCount: count + outputs.length - 1,
        updatedAt: Math.max(conversation.updatedAt, lastAt), lastMessageAt: Math.max(conversation.lastMessageAt ?? 0, lastAt),
        ...((conversation.lastMessageAt ?? 0) <= lastAt && outputs.length > 1 ? { lastMessagePreview: `${outputLabel} ${outputs.length}/${outputs.length}` } : {}) });
      metadata.add({ id: receiptId, kind: 'native-media-message-projection-v1', binding, ownerId: conversation.projectId, state: 'committed', createdAt: Date.now() });
      return { created: true, messages: projected.map(fromMessageRecord), ...(partialNote ? { batchNote: partialNote } : {}) };
    };
    void work().then((value) => { result = value; }, (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } });
    tx.oncomplete = () => result ? resolve(result) : reject(failure ?? new Error('图片消息投影失败'));
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('图片消息投影事务失败'));
  });
}

/** 按分页加载消息（倒序：最新的先返回） */
export async function loadMessages(
  conversationId: string,
  offset: number = 0,
  limit: number = 50,
): Promise<{ messages: ChatMessage[]; total: number }> {
  const result = await getConversationMessages(conversationId, offset, limit);
  const records = await Promise.all(result.messages.map(normalizeMessageMediaRecord));
  await Promise.all(records.map((record, index) => (
    record === result.messages[index] ? Promise.resolve() : persistMessageRecord(record, result.messages[index])
  )));
  return {
    messages: records.map(fromMessageRecord).reverse(), // 反转回正序
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
