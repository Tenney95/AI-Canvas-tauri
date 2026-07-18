/**
 * ChatMessages — 消息列表区
 *
 * 渲染所有消息 + 空状态提示，自动滚动到底部。
 */
import { useEffect, useMemo, useRef, useState, useCallback, type UIEvent } from 'react';
import { Icon } from '@iconify/react';
import { useReducedMotion } from 'framer-motion';
import type { ChatMessage } from '../../types/chat';
import type { AgentTask } from '../../types/agent';
import MessageBubble from './MessageBubble';
import EmptyChatState from './EmptyChatState';
import type { AgentTaskControls } from './AgentTaskTimeline';
import type { ChatReferenceHandlers } from './ChatReferenceText';

interface ChatMessagesProps extends ChatReferenceHandlers {
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
  onEditMessage?: (content: string) => void;
  onRegenerateMessage?: (content: string) => void;
}

const START_EXAMPLES = ['现在有几个失败节点？', '选中 3 号节点', '删除失败节点'];
const EMPTY_AGENT_TASKS: AgentTask[] = [];

export default function ChatMessages({
  messages,
  agentTasks = EMPTY_AGENT_TASKS,
  showEmptyState,
  detachedInitialized,
  onNewConversation,
  onShowList,
  onAddMediaToCanvas,
  agentControls,
  onExampleClick,
  onEditMessage,
  onRegenerateMessage,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
}: ChatMessagesProps) {
  const reduceMotion = useReducedMotion();
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const previousMessagesRef = useRef<ChatMessage[]>([]);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const agentTaskById = useMemo(
    () => new Map(agentTasks.map((task) => [task.id, task])),
    [agentTasks],
  );
  const regeneratePrompts = useMemo(() => {
    const prompts = new Map<string, string>();
    let latestUserContent = '';
    for (const message of messages) {
      if (message.role === 'user') latestUserContent = message.content;
      else if (message.role === 'assistant' && latestUserContent) prompts.set(message.id, latestUserContent);
    }
    return prompts;
  }, [messages]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextIsNearBottom = distanceFromBottom < 80;
    isNearBottomRef.current = nextIsNearBottom;
    setIsNearBottom(nextIsNearBottom);
    if (nextIsNearBottom) setUnreadCount(0);
  }, []);

  useEffect(() => {
    const previousMessages = previousMessagesRef.current;
    previousMessagesRef.current = messages;

    if (isNearBottomRef.current) {
      setUnreadCount(0);
      const frameId = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ block: 'end' });
      });
      return () => cancelAnimationFrame(frameId);
    }

    const previousIds = new Set(previousMessages.map((message) => message.id));
    const newAssistantMessages = messages.filter(
      (message) => message.role !== 'user' && !previousIds.has(message.id),
    ).length;
    const previousLast = previousMessages[previousMessages.length - 1];
    const currentLast = messages[messages.length - 1];
    const streamedWhileAway = !!currentLast
      && currentLast.role === 'assistant'
      && currentLast.id === previousLast?.id
      && currentLast.content !== previousLast.content;
    if (newAssistantMessages > 0 || streamedWhileAway) {
      setUnreadCount((count) => newAssistantMessages > 0
        ? count + newAssistantMessages
        : Math.max(1, count));
    }
    return undefined;
  }, [messages]);

  const scrollToLatest = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    setUnreadCount(0);
  }, [reduceMotion]);

  useEffect(() => () => {
    onNodeHover?.(null);
  }, [onNodeHover]);

  return (
    <div className="chat-panel-messages-shell relative flex-1 min-h-0">
      <div
        ref={messagesRef}
        onScroll={handleScroll}
        className="chat-panel-messages h-full min-h-0 overflow-y-auto px-3.5 py-3 flex flex-col gap-3"
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

        {messages.map((msg) => {
          const regeneratePrompt = regeneratePrompts.get(msg.id);
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              agentTask={msg.agentTaskId ? agentTaskById.get(msg.agentTaskId) : undefined}
              onAddToCanvas={onAddMediaToCanvas}
              onEditMessage={onEditMessage}
              regeneratePrompt={regeneratePrompt}
              onRegenerate={onRegenerateMessage}
              onNodeActivate={onNodeActivate}
              onNodeHover={onNodeHover}
              onModelActivate={onModelActivate}
              agentControls={agentControls}
            />
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {!isNearBottom && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label={unreadCount > 0 ? `回到最新消息，${unreadCount} 条未读` : '回到最新消息'}
          className="absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-canvas-border bg-canvas-surface/95 px-3 text-[11px] font-medium text-canvas-text-secondary shadow-lg shadow-black/25 backdrop-blur-md transition-[border-color,color,transform] hover:border-indigo-400/45 hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 active:translate-y-px"
        >
          <Icon icon="mdi:arrow-down" width="14" />
          <span>最新消息</span>
          {unreadCount > 0 && (
            <span className="min-w-4 rounded-full bg-indigo-400/20 px-1 text-center text-[10px] tabular-nums text-indigo-200">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
