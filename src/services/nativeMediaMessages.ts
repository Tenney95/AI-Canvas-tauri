/** 新库回执是权威；跨分集只水化已经保存的原消息。 */
import { lstat } from '@tauri-apps/plugin-fs';
import { useAppStore } from '../store/useAppStore';
import { captureLegacyCanvasContext, captureLegacyProjectExpectedContext, isProjectExpectedContextCurrent } from './projectExecutionContext';
import { readNativeMediaMessageTasks } from './indexedDb/nativeMediaTaskRepository';
import { getProjectDataDir, joinPath } from './fileService';
import { getAssetUrlFromPath } from './fs/core';
import { nativeMediaLocalOutputs } from './nativeMediaCollection';
import { createNativeMediaDisplayResolver, isNativeMediaResultArtifact } from './nativeMediaDisplay';
import { isRegisteredNativeConversationAlias } from './chat/conversationProjectScope';
import type { ChatMessage } from '../types/chat';

export async function projectNativeMediaMessages(conversationId?: string): Promise<void> {
  const initial = useAppStore.getState();
  const canvas = captureLegacyCanvasContext(initial);
  const context = canvas ?? captureLegacyProjectContext(initial);
  if (!context || context.modelGeneration !== 1) return;
  const isCurrent = () => isProjectExpectedContextCurrent(context, useAppStore.getState(), { checkCanvasRevision: false });
  const ownsConversation = (id: string, originalCanvasId: string) => useAppStore.getState().conversations.some((conversation) =>
    conversation.id === id && !conversation.deletedAt && (conversation.projectId === context.projectId
      || conversation.projectId === originalCanvasId || isRegisteredNativeConversationAlias(context.projectId, conversation.projectId)));
  const loaded = initial.messages.filter((message) => message.role === 'assistant'
    && (!conversationId || message.conversationId === conversationId)
    && (message.archiveMedia ? conversationId !== undefined || message.archiveMediaUrl === undefined
      : message.mediaResult ? isNativeMediaResultArtifact(message.mediaResult.id) : !!canvas));
  const { records, project } = await readNativeMediaMessageTasks(context.projectId, canvas?.canvasId ?? null,
    loaded.map((message) => ({ conversationId: message.conversationId, messageId: message.id, artifactId: message.mediaResult?.id,
      ...(message.archiveMedia ? { archiveOnly: true } : {}) })));
  if (!isCurrent()) return;
  const loadedIds = new Set(loaded.map((message) => message.id));
  const display = project && createNativeMediaDisplayResolver(project);
  const archived = loaded.filter((message) => message.archiveMedia && ownsConversation(message.conversationId, ''));
  if (archived.length && display) {
    for (let offset = 0; offset < archived.length && isCurrent(); offset += 4) {
      const urls = new Map(await Promise.all(archived.slice(offset, offset + 4).map(async (message) => {
        const binding = message.archiveMedia!;
        const url = await display.archive(binding.storageRootRef, binding).then((file) => file.url, () => null);
        return [message.id, { binding, url }] as const;
      })));
      if (!isCurrent()) return;
      const state = useAppStore.getState();
      if (state.messages.some((message) => {
        const value = urls.get(message.id);
        return value && message.archiveMedia === value.binding && message.archiveMediaUrl !== value.url && ownsConversation(message.conversationId, '');
      })) state.setMessages(state.messages.map((message) => {
        const value = urls.get(message.id);
        return value && message.archiveMedia === value.binding && ownsConversation(message.conversationId, '')
          ? { ...message, archiveMediaUrl: value.url } : message;
      }));
    }
  }
  let primaryRoot: Promise<string | null> | undefined;
  const getRoot = (rootRef: string | undefined) => rootRef && rootRef !== project?.storageRootRef
    ? display?.directory(rootRef) : (primaryRoot ??= getProjectDataDir(context.projectId));

  // 目录与文件元数据只在当前加载中复用；此前已交付的文件不会逐个重算摘要。
  const directories = new Map<string, Promise<boolean>>();
  const files = new Map<string, ReturnType<typeof lstat>>();
  const statFile = (path: string) => {
    const pending = files.get(path) ?? lstat(path);
    files.set(path, pending);
    return pending;
  };
  const localUrl = async (rootRef: string | undefined, relativePath: string, bytes?: number) => {
    try {
      let directory = await getRoot(rootRef);
      if (!directory) return;
      const segments = relativePath.split('/');
      for (const segment of segments.slice(0, -1)) {
        directory = joinPath(directory, segment);
        const path = directory;
        const safe = directories.get(path) ?? lstat(path).then((info) => info.isDirectory && !info.isSymlink);
        directories.set(path, safe);
        if (!await safe) return;
      }
      const path = joinPath(directory, segments.at(-1)!);
      const info = await statFile(path);
      if (!info.isFile || info.isSymlink || bytes !== undefined && info.size !== bytes) return;
      return await getAssetUrlFromPath(path);
    } catch { /* 原文件缺失、失效或不可访问；其余产物仍可展示。 */ }
  };

  let changedHistory = false;
  for (const record of records) {
    if (!isCurrent()) return;
    const { origin, resultRelativePath } = record;
    if (!origin || !resultRelativePath || !ownsConversation(origin.conversationId, record.canvasId)
      || conversationId && origin.conversationId !== conversationId) continue;
    const matchesOrigin = (message: ChatMessage) => message.role === 'assistant'
      && message.conversationId === origin.conversationId && message.agentTaskId === origin.agentTaskId;
    const isOriginalRoot = (message: ChatMessage) => message.id === origin.messageId && matchesOrigin(message);
    const resultId = `native-media-${record.operationId}`;
    const matchesArtifact = (message: ChatMessage, id: string, source: string) => matchesOrigin(message)
      && message.mediaResult?.id === id && message.mediaResult.sourceUrl === source;
    const canFirstProject = canvas && record.canvasId === canvas.canvasId && record.projectEpoch === canvas.projectEpoch
      && record.canvasEpoch === canvas.canvasEpoch && record.episodeId === canvas.episodeId;

    try {
      if (record.apimartImageBatch || record.localResults) {
        const { loadNativeMediaMessageProjection, projectNativeMediaMessageBatch } = await import('./chat/chatHistoryService');
        const outputs = nativeMediaLocalOutputs(record);
        const filesByArtifact = new Map(outputs.map((file, ordinal) => [ordinal ? `${resultId}-${ordinal}` : resultId, file]));
        const committed = await loadNativeMediaMessageProjection(record, loadedIds);
        let projected: { messages: ChatMessage[]; created: boolean; batchNote?: string };
        if (committed) projected = { messages: committed, created: false };
        else {
          const state = useAppStore.getState();
          if (!canFirstProject || !isCurrent() || !state.messages.some(isOriginalRoot)) continue;
          const nodeIds = [...filesByArtifact.keys()].map((id, ordinal) => origin.deliveryMode === 'chat' ? undefined
            : ordinal === 0 ? record.nodeId : state.nodes.find((node) => node.data.artifactId === id)?.id);
          projected = await projectNativeMediaMessageBatch(record, nodeIds, isCurrent);
          changedHistory ||= projected.created;
        }
        const resolved = await Promise.all(projected.messages.map(async (message) => {
          const artifact = message.mediaResult;
          const file = artifact && filesByArtifact.get(artifact.id);
          return [message, file && await localUrl(record.resultRootRef, file.relativePath, file.bytes)] as const;
        }));
        const current = useAppStore.getState();
        if (!isCurrent()) return;
        if (!ownsConversation(origin.conversationId, record.canvasId)
          || projected.created && !current.messages.some(isOriginalRoot)) continue;
        const byId = new Map(current.messages.map((message) => [message.id, message]));
        const updates = new Map<string, ChatMessage>(), appended: ChatMessage[] = [];
        for (const [durable, url] of resolved) {
          const artifact = durable.mediaResult;
          const existing = byId.get(durable.id);
          if (!artifact || !artifact.sourceUrl) continue;
          if (!projected.created) {
            if (url && existing?.mediaStatus === 'succeeded' && matchesArtifact(existing, artifact.id, artifact.sourceUrl) && existing.mediaResult!.url !== url) {
              updates.set(existing.id, { ...existing, mediaResult: { ...existing.mediaResult!, url } });
            }
            continue;
          }
          if (existing && (!matchesOrigin(existing) || existing.mediaResult && existing.mediaResult.id !== artifact.id)) continue;
          const next: ChatMessage = { ...(existing ?? durable), mediaStatus: durable.mediaStatus, mediaError: durable.mediaError,
            ...(existing && projected.batchNote && !existing.content.includes(projected.batchNote)
              ? { content: `${existing.content}${existing.content ? '\n\n' : ''}${projected.batchNote}` } : {}),
            canvasStatus: durable.canvasStatus, canvasNodeId: durable.canvasNodeId, canvasError: durable.canvasError,
            mediaResult: { ...artifact, url: url ?? artifact.url } };
          if (existing) updates.set(next.id, next); else appended.push(next);
        }
        if (updates.size || appended.length) current.setMessages([...current.messages.map((message) => updates.get(message.id) ?? message), ...appended]
          .sort((left, right) => left.timestamp - right.timestamp));
        if (appended.length) current.setConversations(current.conversations.map((conversation) => conversation.id === origin.conversationId
          ? { ...conversation, messageCount: conversation.messageCount + appended.length } : conversation));
        continue;
      }

      const original = useAppStore.getState().messages.find(isOriginalRoot);
      if (!original || (canFirstProject ? original.mediaResult && original.mediaResult.id !== resultId
        : !matchesArtifact(original, resultId, resultRelativePath))) continue;
      const alreadyProjected = original.mediaStatus === 'succeeded' && matchesArtifact(original, resultId, resultRelativePath);
      const url = !alreadyProjected && record.localResult && project && display
        ? (await display(record.resultRootRef ?? project.storageRootRef, record.localResult)).url
        : await localUrl(record.resultRootRef, resultRelativePath, record.localResult?.bytes);
      if (!isCurrent()) return;
      if (!url || !ownsConversation(origin.conversationId, record.canvasId)) continue;
      const state = useAppStore.getState();
      const message = state.messages.find(isOriginalRoot);
      if (!message) continue;
      if (message.mediaStatus === 'succeeded' && matchesArtifact(message, resultId, resultRelativePath)) {
        if (message.mediaResult!.url !== url) state.setMessages(state.messages.map((entry) => entry === message
          ? { ...entry, mediaResult: { ...message.mediaResult!, url } } : entry));
      } else if (canFirstProject && (!message.mediaResult || message.mediaResult.id === resultId)) {
        state.updateMessage(message.id, { mediaStatus: 'succeeded', mediaError: undefined,
          canvasStatus: origin.deliveryMode === 'chat' ? 'none' : 'created',
          canvasNodeId: origin.deliveryMode === 'chat' ? undefined : record.nodeId, canvasError: undefined,
          mediaResult: { id: resultId, kind: record.category, deliveryMode: origin.deliveryMode, url, sourceUrl: resultRelativePath,
            persistence: 'saved', prompt: '', modelId: origin.modelId ?? record.providerConfigId,
            provider: record.providerConfigId, createdAt: record.createdAt } });
        changedHistory = true;
      }
    } catch { /* 单条历史回执不能阻断同一会话其余媒体。 */ }
  }
  const current = useAppStore.getState();
  if (current.historyPanelOpen && (!conversationId || changedHistory) && isCurrent()) await current.loadHistoryFromDb();
}

function captureLegacyProjectContext(state: ReturnType<typeof useAppStore.getState>) {
  try {
    const context = captureLegacyProjectExpectedContext(state, 'project');
    return context.kind === 'project' ? context : null;
  }
  catch { return null; }
}
