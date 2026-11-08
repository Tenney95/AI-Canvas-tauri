/** 新库完成回执是权威；旧对话只按原消息身份幂等投影，不修改任务预算和调度历史。 */
import { exists } from '@tauri-apps/plugin-fs';
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { listNativeMediaTasks } from './indexedDb/nativeMediaTaskRepository';
import { getProjectDataDir, joinPath } from './fileService';
import { getAssetUrlFromPath } from './fs/core';
import { nativeImageBatchResults } from './nativeImageBatch';
import type { ChatMessage } from '../types/chat';

export async function projectNativeMediaMessages(conversationId?: string): Promise<void> {
  const context = captureLegacyCanvasContext(useAppStore.getState());
  if (!context || context.modelGeneration !== 1) return;
  const records = await listNativeMediaTasks(context.projectId);
  for (const record of records) {
    const origin = record.origin;
    if (!origin || record.canvasId !== context.canvasId || record.projectEpoch !== context.projectEpoch
      || record.canvasEpoch !== context.canvasEpoch || record.episodeId !== context.episodeId
      || record.status !== 'delivered' || !record.resultRelativePath
      || conversationId && origin.conversationId !== conversationId) continue;
    if (record.apimartImageBatch) {
      const files = nativeImageBatchResults(record);
      const artifactIds = files.map((_, ordinal) => `native-media-${record.operationId}${ordinal ? `-${ordinal}` : ''}`);
      const initial = useAppStore.getState();
      if (!initial.messages.some((message) => message.conversationId === origin.conversationId
        && (message.id === origin.messageId || !!message.mediaResult && artifactIds.includes(message.mediaResult.id)))) continue;
      const nodeIds = artifactIds.map((id, ordinal) => origin.deliveryMode === 'chat' ? undefined
        : ordinal === 0 ? record.nodeId : initial.nodes.find((node) => node.data.artifactId === id)?.id);
      const { projectNativeMediaMessageBatch } = await import('./chat/chatHistoryService');
      const projected = await projectNativeMediaMessageBatch(record, nodeIds,
        () => isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false }));
      const root = await getProjectDataDir(record.canvasId);
      if (!root) continue;
      const urls = new Map(await Promise.all(files.map(async (file, ordinal) =>
        [artifactIds[ordinal], await getAssetUrlFromPath(joinPath(root, file.relativePath))] as const)));
      const current = useAppStore.getState();
      if (!isProjectExpectedContextCurrent(context, current, { checkCanvasRevision: false })) return;
      if (projected.created && !current.messages.some((message) => message.id === origin.messageId && message.conversationId === origin.conversationId
        && (!origin.agentTaskId || message.agentTaskId === origin.agentTaskId))) continue;
      const updates = new Map<string, ChatMessage>(), appended: ChatMessage[] = [];
      for (const durable of projected.messages) {
        const artifact = durable.mediaResult;
        if (!artifact || !urls.has(artifact.id)) continue;
        const existing = current.messages.find((message) => message.id === durable.id);
        if (existing && (existing.conversationId !== origin.conversationId
          || existing.mediaResult && existing.mediaResult.id !== artifact.id
          || !projected.created && existing.mediaResult?.id !== artifact.id)) continue;
        // 收据重试只水化仍在当前分页中的消息；缺失项可能已删除，不能补回。
        if (!existing && !projected.created) continue;
        const next: ChatMessage = { ...(existing ?? durable), mediaStatus: durable.mediaStatus, mediaError: durable.mediaError,
          ...(existing && projected.created && projected.batchNote && !existing.content.includes(projected.batchNote)
            ? { content: `${existing.content}${existing.content ? '\n\n' : ''}${projected.batchNote}` } : {}),
          canvasStatus: durable.canvasStatus, canvasNodeId: durable.canvasNodeId, canvasError: durable.canvasError,
          mediaResult: { ...artifact, url: urls.get(artifact.id)!, sourceUrl: artifact.sourceUrl } };
        if (existing) updates.set(next.id, next); else appended.push(next);
      }
      // 已由strict事务持久化；这里只经Store Action更新视图，避免异步旧快照重建被删除的候选。
      if (updates.size || appended.length) current.setMessages([...current.messages.map((message) => updates.get(message.id) ?? message), ...appended]
        .sort((left, right) => left.timestamp - right.timestamp));
      if (appended.length) current.setConversations(current.conversations.map((conversation) => conversation.id === origin.conversationId
        ? { ...conversation, messageCount: conversation.messageCount + appended.length } : conversation));
      continue;
    }
    const root = await getProjectDataDir(record.canvasId);
    if (!root) continue;
    const path = joinPath(root, record.resultRelativePath);
    if (!await exists(path)) continue;
    const url = await getAssetUrlFromPath(path);
    const state = useAppStore.getState();
    if (!isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) return;
    const message = state.messages.find((entry) => entry.id === origin.messageId && entry.conversationId === origin.conversationId
      && (!origin.agentTaskId || entry.agentTaskId === origin.agentTaskId));
    const resultId = `native-media-${record.operationId}`;
    if (!message || message.mediaResult && message.mediaResult.id !== resultId) continue;
    if (message.mediaResult?.id === resultId && message.mediaStatus === 'succeeded'
      && message.mediaResult.url === url && message.mediaResult.sourceUrl === record.resultRelativePath) continue;
    state.updateMessage(message.id, { mediaStatus: 'succeeded', mediaError: undefined,
      canvasStatus: origin.deliveryMode === 'chat' ? 'none' : 'created',
      canvasNodeId: origin.deliveryMode === 'chat' ? undefined : record.nodeId, canvasError: undefined,
      mediaResult: { id: resultId, kind: record.category, deliveryMode: origin.deliveryMode, url, sourceUrl: record.resultRelativePath,
        persistence: 'saved', prompt: '', modelId: origin.modelId ?? record.providerConfigId,
        provider: record.providerConfigId, createdAt: record.createdAt } });
  }
}
