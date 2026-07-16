/**
 * ChatMessages — 消息列表区
 *
 * 渲染所有消息 + 空状态提示，自动滚动到底部。
 */
import { useEffect, useRef, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { ChatMessage } from '../../types/chat';
import type { AgentTask } from '../../types/agent';
import MessageBubble from './MessageBubble';
import EmptyChatState from './EmptyChatState';
import type { AgentTaskControls } from './AgentTaskTimeline';

interface ChatMessagesProps {
  messages: ChatMessage[];
  agentTasks?: AgentTask[];
  showEmptyState: boolean;
  /** 独立窗口初始化标记 */
  detachedInitialized: boolean;
  onNewConversation: () => void;
  onShowList: () => void;
  onAddMediaToCanvas?: (messageId: string) => void;
  agentControls?: AgentTaskControls;
}

export default function ChatMessages({
  messages,
  agentTasks = [],
  showEmptyState,
  detachedInitialized,
  onNewConversation,
  onShowList,
  onAddMediaToCanvas,
  agentControls,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div className="chat-panel-messages flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4">
      {showEmptyState && detachedInitialized && (
        <EmptyChatState onNew={onNewConversation} onList={onShowList} />
      )}

      {!showEmptyState && messages.length === 0 && detachedInitialized && (
        <div className="chat-panel-start-hint flex flex-col items-center justify-center h-full text-center px-4">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/15 flex items-center justify-center mb-4">
            <Icon icon="mdi:chat-processing-outline" width="28" height="28" className="text-indigo-400" />
          </div>
          <p className="text-sm text-canvas-text-secondary mb-1">开始对话</p>
          <p className="text-xs text-canvas-text-muted">
            用自然语言操作画布，AI 助手帮你完成
          </p>
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          agentTask={agentTasks.find((task) => task.id === msg.agentTaskId)}
          onAddToCanvas={onAddMediaToCanvas}
          agentControls={agentControls}
        />
      ))}

      <div ref={messagesEndRef} />
    </div>
  );
}
