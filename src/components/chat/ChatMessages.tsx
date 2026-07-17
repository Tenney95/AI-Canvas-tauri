/**
 * ChatMessages — 消息列表区
 *
 * 渲染所有消息 + 空状态提示，自动滚动到底部。
 */
import { useEffect, useRef, useCallback, type UIEvent } from 'react';
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
  /** 点击示例提示 → 填入输入框 */
  onExampleClick?: (text: string) => void;
}

const START_EXAMPLES = ['现在有几个失败节点？', '选中 3 号节点', '删除失败节点'];

export default function ChatMessages({
  messages,
  agentTasks = [],
  showEmptyState,
  detachedInitialized,
  onNewConversation,
  onShowList,
  onAddMediaToCanvas,
  agentControls,
  onExampleClick,
}: ChatMessagesProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
  }, []);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const frameId = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(frameId);
  }, [messages]);

  return (
    <div
      ref={messagesRef}
      onScroll={handleScroll}
      className="chat-panel-messages flex-1 min-h-0 overflow-y-auto px-3.5 py-3 flex flex-col gap-3"
    >
      {showEmptyState && detachedInitialized && (
        <EmptyChatState
          onNew={onNewConversation}
          onList={onShowList}
          onExample={onExampleClick}
        />
      )}

      {!showEmptyState && messages.length === 0 && detachedInitialized && (
        <div className="chat-panel-start-hint flex flex-col items-center justify-center h-full text-center px-4">
          <div className="w-11 h-11 rounded-xl bg-indigo-500/12 flex items-center justify-center mb-3">
            <Icon icon="mdi:chat-processing-outline" width="20" height="20" className="text-indigo-400" />
          </div>
          <p className="text-[13px] text-canvas-text-secondary mb-0.5">开始对话</p>
          <p className="text-[11px] text-canvas-text-muted mb-4">
            用自然语言操作画布，AI 助手帮你完成
          </p>
          {onExampleClick && (
            <div className="flex flex-wrap justify-center gap-1.5 max-w-[260px]">
              {START_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => onExampleClick(example)}
                  className="rounded-full border border-canvas-border px-2.5 py-1 text-[11px] text-canvas-text-secondary
                             hover:border-indigo-400/50 hover:text-canvas-text transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
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
