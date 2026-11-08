/** 付费提交前让原对话和消息实际耐久落盘；完成产物仍以新库回执为权威。 */
import type { CanvasContext } from '../types/project';
import type { NativeMediaOrigin } from '../types/media';
import { useAppStore } from '../store/useAppStore';
import { isProjectExpectedContextCurrent } from './projectExecutionContext';
import { persistMessage, saveConversation } from './chat/chatHistoryService';
import { openDB, STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES } from './indexedDb/schema';

export async function persistNativeMediaOrigin(context: CanvasContext, origin: NativeMediaOrigin): Promise<void> {
  const state = useAppStore.getState();
  const conversation = state.conversations.find((entry) => entry.id === origin.conversationId && !entry.deletedAt);
  const message = state.messages.find((entry) => entry.id === origin.messageId && entry.conversationId === origin.conversationId
    && entry.role === 'assistant' && (!origin.agentTaskId || entry.agentTaskId === origin.agentTaskId));
  if (!conversation || !message || ![context.projectId, context.canvasId].includes(conversation.projectId)
    || !isProjectExpectedContextCurrent(context, state, { checkCanvasRevision: false })) throw new Error('原媒体对话或消息归属无法核对，未提交请求');
  if (message.mediaResult) throw new Error('此消息已有媒体产物，请从新消息发起生成，未提交请求');
  if (origin.agentTaskId) {
    const task = state.agentTasks.find((entry) => entry.id === origin.agentTaskId && entry.conversationId === origin.conversationId);
    const scope = task?.executionContext ?? task?.projectScope;
    if (!task || ![context.canvasId, context.projectId].includes(task.projectId)
      || scope && (scope.kind !== 'canvas' || scope.projectId !== context.projectId || scope.canvasId !== context.canvasId
        || scope.projectEpoch !== context.projectEpoch || scope.canvasEpoch !== context.canvasEpoch)) throw new Error('原媒体任务归属无法核对，未提交请求');
  }
  const db = await openDB();
  const existing = await new Promise<{ conversation: unknown; message: unknown }>((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES], 'readonly');
    const first = tx.objectStore(STORE_CHAT_CONVERSATIONS).get(origin.conversationId), second = tx.objectStore(STORE_CHAT_MESSAGES).get(origin.messageId);
    tx.oncomplete = () => resolve({ conversation: first.result, message: second.result });
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('原媒体消息无法读取，未提交请求'));
  });
  const stored = existing.message as { mediaResult?: unknown; projectId?: string; conversationId?: string } | undefined;
  if (stored?.mediaResult) throw new Error('此消息的媒体槽已被占用，请从新消息发起生成，未提交请求');
  if (stored && (stored.projectId !== conversation.projectId || stored.conversationId !== conversation.id)) throw new Error('原消息持久归属不一致，未提交请求');
  if (!existing.conversation) await saveConversation(conversation);
  if (!existing.message) await persistMessage(message, conversation.projectId, conversation.id);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_CHAT_CONVERSATIONS, STORE_CHAT_MESSAGES], 'readwrite', { durability: 'strict' });
    if (tx.durability !== 'strict') { tx.abort(); reject(new Error('原媒体消息需要耐久存储，未提交请求')); return; }
    const conversations = tx.objectStore(STORE_CHAT_CONVERSATIONS), messages = tx.objectStore(STORE_CHAT_MESSAGES);
    const first = conversations.get(origin.conversationId), second = messages.get(origin.messageId);
    let pending = 2;
    const check = () => {
      if (--pending) return;
      const storedConversation = first.result, storedMessage = second.result;
      if (!storedConversation || storedConversation.deletedAt || storedConversation.id !== origin.conversationId
        || storedConversation.projectId !== conversation.projectId || !storedMessage || storedMessage.id !== origin.messageId
        || storedMessage.role !== 'assistant' || storedMessage.projectId !== conversation.projectId
        || storedMessage.conversationId !== origin.conversationId
        || storedMessage.mediaResult
        || origin.agentTaskId && storedMessage.agentTaskId !== origin.agentTaskId) { tx.abort(); return; }
      // 保留库中最新正文和序号，只把已核实的同一身份刷入strict耐久事务。
      conversations.put(storedConversation); messages.put(storedMessage);
    };
    first.onsuccess = check; second.onsuccess = check;
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('原媒体消息耐久证明失败，未提交请求'));
  });
  const latest = useAppStore.getState();
  if (!isProjectExpectedContextCurrent(context, latest, { checkCanvasRevision: false })
    || !latest.conversations.some((entry) => entry.id === conversation.id && entry.projectId === conversation.projectId && !entry.deletedAt)
    || !latest.messages.some((entry) => entry.id === message.id && entry.conversationId === conversation.id
      && !entry.mediaResult && (!origin.agentTaskId || entry.agentTaskId === origin.agentTaskId))) throw new Error('原媒体对话在保存期间变化，未提交请求');
}
