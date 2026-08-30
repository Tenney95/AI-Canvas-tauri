/**
 * ChatMessages — 消息列表区
 *
 * 渲染所有消息 + 空状态提示，自动滚动到底部。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type UIEvent } from 'react';
import { Icon } from '@iconify/react';
import { useReducedMotion } from 'framer-motion';
import type { ChatMessage } from '../../types/chat';
import type { AgentTask } from '../../types/agent';
import MessageBubble from './MessageBubble';
import EmptyChatState from './EmptyChatState';
import type { AgentTaskControls } from './AgentTaskTimeline';
import type { ChatReferenceHandlers } from './ChatReferenceText';
import { useT } from '../../i18n';

interface ChatMessagesProps extends ChatReferenceHandlers {
  messages: ChatMessage[];
  agentTasks?: AgentTask[];
  showEmptyState: boolean;
  /** 独立窗口初始化标记 */
  detachedInitialized: boolean;
  onNewConversation: () => void;
  onShowList: () => void;
  onOpenAgents?: () => void;
  onAddMediaToCanvas?: (messageId: string) => void;
  onRetryMediaSave?: (messageId: string) => Promise<void>;
  agentControls?: AgentTaskControls;
  /** 点击示例提示 → 填入输入框 */
  onExampleClick?: (text: string) => void;
  onEditMessage?: (content: string) => void;
  onRegenerateMessage?: (content: string) => void;
}

const START_EXAMPLES = ['现在有几个失败节点？', '选中 3 号节点', '删除失败节点'];
const EMPTY_AGENT_TASKS: AgentTask[] = [];
const INITIAL_MESSAGE_BATCH = 80;
const MESSAGE_BATCH_SIZE = 60;

interface ChatScrollState {
  conversationId: string;
  isNearBottom: boolean;
  unreadCount: number;
}

interface ChatRenderWindow {
  conversationId: string;
  limit: number;
  messageCount: number;
}

function mapChatMessageRows<T>(
  messages: ChatMessage[],
  renderRow: (message: ChatMessage, regeneratePrompt?: string) => T,
  initialUserContent = '',
): T[] {
  const rows: T[] = [];
  let latestUserContent = initialUserContent;

  for (const message of messages) {
    if (message.role === 'user') {
      latestUserContent = message.content;
      rows.push(renderRow(message));
      continue;
    }

    const regeneratePrompt = message.role === 'assistant' && latestUserContent
      ? latestUserContent
      : undefined;
    rows.push(renderRow(message, regeneratePrompt));
  }

  return rows;
}

export default function ChatMessages({
  messages,
  agentTasks = EMPTY_AGENT_TASKS,
  showEmptyState,
  detachedInitialized,
  onNewConversation,
  onShowList,
  onOpenAgents,
  onAddMediaToCanvas,
  onRetryMediaSave,
  agentControls,
  onExampleClick,
  onEditMessage,
  onRegenerateMessage,
  onNodeActivate,
  onNodeHover,
  onModelActivate,
}: ChatMessagesProps) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const conversationId = messages[0]?.conversationId ?? '';
  const messagesRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const activeConversationRef = useRef(conversationId);
  const previousMessagesRef = useRef<{ conversationId: string; messages: ChatMessage[] }>({
    conversationId,
    messages: [],
  });
  const pendingOlderScrollRef = useRef<{
    conversationId: string;
    height: number;
    top: number;
  } | null>(null);
  const [scrollState, setScrollState] = useState<ChatScrollState>({
    conversationId,
    isNearBottom: true,
    unreadCount: 0,
  });
  const [renderWindow, setRenderWindow] = useState<ChatRenderWindow>({
    conversationId,
    limit: INITIAL_MESSAGE_BATCH,
    messageCount: messages.length,
  });
  const isNearBottom = scrollState.conversationId === conversationId
    ? scrollState.isNearBottom
    : true;
  const unreadCount = scrollState.conversationId === conversationId
    ? scrollState.unreadCount
    : 0;
  const baseRenderLimit = renderWindow.conversationId === conversationId
    ? renderWindow.limit
    : INITIAL_MESSAGE_BATCH;
  // 用户停留在历史位置时，新消息应扩展窗口末尾，不能把当前窗口顶部挤掉。
  const appendedWhileAway = renderWindow.conversationId === conversationId && !isNearBottom
    ? Math.max(0, messages.length - renderWindow.messageCount)
    : 0;
  const renderLimit = Math.min(messages.length, baseRenderLimit + appendedWhileAway);
  const visibleStartIndex = Math.max(0, messages.length - renderLimit);
  const visibleMessages = useMemo(
    () => visibleStartIndex === 0 ? messages : messages.slice(visibleStartIndex),
    [messages, visibleStartIndex],
  );
  const precedingUserContent = useMemo(() => {
    for (let index = visibleStartIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') return messages[index].content;
    }
    return '';
  }, [messages, visibleStartIndex]);
  const hiddenMessageCount = visibleStartIndex;
  const agentTaskById = useMemo(
    () => new Map(agentTasks.map((task) => [task.id, task])),
    [agentTasks],
  );
  const messageRows = useMemo(
    () => mapChatMessageRows(visibleMessages, (message, regeneratePrompt) => (
      <MessageBubble
        key={message.id}
        message={message}
        agentTask={message.agentTaskId ? agentTaskById.get(message.agentTaskId) : undefined}
        onAddToCanvas={onAddMediaToCanvas}
        onRetryMediaSave={onRetryMediaSave}
        onEditMessage={onEditMessage}
        regeneratePrompt={regeneratePrompt}
        onRegenerate={onRegenerateMessage}
        onNodeActivate={onNodeActivate}
        onNodeHover={onNodeHover}
        onModelActivate={onModelActivate}
        agentControls={agentControls}
      />
    ), precedingUserContent),
    [
      agentControls,
      agentTaskById,
      precedingUserContent,
      onAddMediaToCanvas,
      onRetryMediaSave,
      onEditMessage,
      onModelActivate,
      onNodeActivate,
      onNodeHover,
      onRegenerateMessage,
      visibleMessages,
    ],
  );

  const loadOlderMessages = useCallback(() => {
    const container = messagesRef.current;
    if (container) {
      pendingOlderScrollRef.current = {
        conversationId,
        height: container.scrollHeight,
        top: container.scrollTop,
      };
    }
    setRenderWindow((current) => ({
      conversationId,
      limit: Math.min(
        messages.length,
        (current.conversationId === conversationId ? renderLimit : INITIAL_MESSAGE_BATCH)
        + MESSAGE_BATCH_SIZE,
      ),
      messageCount: messages.length,
    }));
  }, [conversationId, messages.length, renderLimit]);

  useLayoutEffect(() => {
    if (activeConversationRef.current !== conversationId) {
      activeConversationRef.current = conversationId;
      isNearBottomRef.current = true;
      previousMessagesRef.current = { conversationId, messages };
      pendingOlderScrollRef.current = null;
      setScrollState({ conversationId, isNearBottom: true, unreadCount: 0 });
      setRenderWindow({
        conversationId,
        limit: INITIAL_MESSAGE_BATCH,
        messageCount: messages.length,
      });
      const container = messagesRef.current;
      if (container) container.scrollTop = container.scrollHeight;
      return;
    }
    if (renderWindow.conversationId !== conversationId) {
      pendingOlderScrollRef.current = null;
      return;
    }
    const pending = pendingOlderScrollRef.current;
    const container = messagesRef.current;
    if (!pending || pending.conversationId !== conversationId || !container) return;
    container.scrollTop = pending.top + (container.scrollHeight - pending.height);
    pendingOlderScrollRef.current = null;
  }, [conversationId, messages, renderLimit, renderWindow.conversationId]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextIsNearBottom = distanceFromBottom < 80;
    const wasNearBottom = isNearBottomRef.current;
    isNearBottomRef.current = nextIsNearBottom;
    setScrollState((current) => ({
      conversationId,
      isNearBottom: nextIsNearBottom,
      unreadCount: nextIsNearBottom
        ? 0
        : current.conversationId === conversationId ? current.unreadCount : 0,
    }));
    if (wasNearBottom !== nextIsNearBottom) {
      setRenderWindow({
        conversationId,
        limit: nextIsNearBottom ? INITIAL_MESSAGE_BATCH : renderLimit,
        messageCount: messages.length,
      });
    }
  }, [conversationId, messages.length, renderLimit]);

  const jumpToLatest = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    const previousScrollBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = container.scrollHeight;
    container.style.scrollBehavior = previousScrollBehavior;
  }, []);

  useEffect(() => {
    const previousSnapshot = previousMessagesRef.current;
    const previousMessages = previousSnapshot.conversationId === conversationId
      ? previousSnapshot.messages
      : [];
    previousMessagesRef.current = { conversationId, messages };

    if (isNearBottomRef.current) {
      jumpToLatest();
      const frameId = requestAnimationFrame(() => {
        jumpToLatest();
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
      setScrollState((current) => {
        const currentUnread = current.conversationId === conversationId
          ? current.unreadCount
          : 0;
        return {
          conversationId,
          isNearBottom: false,
          unreadCount: newAssistantMessages > 0
            ? currentUnread + newAssistantMessages
            : Math.max(1, currentUnread),
        };
      });
    }
    return undefined;
  }, [conversationId, jumpToLatest, messages]);

  const scrollToLatest = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    isNearBottomRef.current = true;
    setScrollState({ conversationId, isNearBottom: true, unreadCount: 0 });
    setRenderWindow({
      conversationId,
      limit: INITIAL_MESSAGE_BATCH,
      messageCount: messages.length,
    });
    requestAnimationFrame(jumpToLatest);
  }, [conversationId, jumpToLatest, messages.length, reduceMotion]);

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
            onOpenAgents={onOpenAgents}
            onExample={onExampleClick}
          />
        )}

        {!showEmptyState && messages.length === 0 && detachedInitialized && (
          <div className="chat-panel-start-hint flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/12 flex items-center justify-center mb-3">
              <Icon icon="mdi:chat-processing-outline" width="20" height="20" className="text-indigo-400" />
            </div>
            <p className="text-[13px] text-canvas-text-secondary mb-0.5">{t('开始对话')}</p>
            <p className="text-[11px] text-canvas-text-muted mb-4">
              {t('用自然语言操作画布，AI 助手帮你完成')}
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
                    {t(example)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {hiddenMessageCount > 0 && (
          <button
            type="button"
            onClick={loadOlderMessages}
            className="mx-auto min-h-8 rounded-md border border-canvas-border px-3 py-1 text-[11px] text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
          >
            {t('加载更早消息（还有 {count} 条）', { count: hiddenMessageCount })}
          </button>
        )}

        {messageRows}

        <div />
      </div>

      {!isNearBottom && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label={unreadCount > 0 ? t('回到最新消息，{count} 条未读', { count: unreadCount }) : t('回到最新消息')}
          className="absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-canvas-border bg-canvas-surface/95 px-3 text-[11px] font-medium text-canvas-text-secondary shadow-lg shadow-black/25 backdrop-blur-md transition-[border-color,color,transform] hover:border-indigo-400/45 hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 active:translate-y-px"
        >
          <Icon icon="mdi:arrow-down" width="14" />
          <span>{t('最新消息')}</span>
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
