/**
 * ChatPanel — 对话助手主面板
 *
 * 独立悬浮在窗口右侧的 AI 对话面板。
 * - 双栏布局：会话列表 + 消息区域
 * - 底部输入框
 * - 右侧关闭按钮 + 独立窗口按钮（P0-A.1 仅预留 UI）
 * - 使用 framer-motion 控制打开/关闭动画
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import ConversationList from './ConversationList';
import {
  initMainWindowListener,
  emitSyncState,
  emitCloseChatWindow,
  type ChatAction,
} from '../../services/chat/chatWindowService';
import type { ChatMessage } from '../../types/chat';
import AnimatedButton from '../shared/AnimatedButton';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function ChatPanel() {
  const {
    chatOpen,
    chatPanelDetached,
    closeChat,
    setChatPanelDetached,
    activeConversationId,
    conversations,
    messages,
    currentProjectId,
    createConversation,
    setActiveConversation,
    addMessage,
    enqueueMessage,
    dequeueMessage,
    showToast,
  } = useAppStore(
    useShallow((s) => ({
      chatOpen: s.chatOpen,
      chatPanelDetached: s.chatPanelDetached,
      closeChat: s.closeChat,
      setChatPanelDetached: s.setChatPanelDetached,
      activeConversationId: s.activeConversationId,
      conversations: s.conversations,
      messages: s.messages,
      currentProjectId: s.currentProjectId,
      createConversation: s.createConversation,
      setActiveConversation: s.setActiveConversation,
      addMessage: s.addMessage,
      enqueueMessage: s.enqueueMessage,
      dequeueMessage: s.dequeueMessage,
      showToast: s.showToast,
    })),
  );

  const [inputValue, setInputValue] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'chat'>('chat');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  useEffect(() => {
    if (viewMode === 'chat') scrollToBottom();
  }, [messages, viewMode, scrollToBottom]);

  // 消息过滤：只显示当前活动会话的消息
  const conversationMessages = activeConversationId
    ? messages.filter((m) => {
        // P0-A.1: messages 暂不携带 conversationId，过滤逻辑加在 addMessage 时
        return true;
      })
    : [];

  const handleNewConversation = useCallback(() => {
    if (!currentProjectId) return;
    createConversation(currentProjectId);
    setViewMode('chat');
  }, [currentProjectId, createConversation]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversation(id);
      setViewMode('chat');
    },
    [setActiveConversation],
  );

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || !activeConversationId) return;

    // 创建用户消息
    const userMsg: ChatMessage = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'done',
    };
    addMessage(userMsg);
    setInputValue('');

    // 入队等待处理（P0-A.2 实现实际 AI 调用）
    enqueueMessage(text);

    // P0-A.1 占位响应
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      content: '欢迎来到 AI Canvas 对话助手！\n\n当前为基础骨架版本，AI 对话能力将在下一阶段接入。您可以在此查看会话管理和消息界面。',
      timestamp: Date.now(),
      status: 'done',
    };
    setTimeout(() => addMessage(assistantMsg), 500);

    scrollToBottom();
  }, [
    inputValue,
    activeConversationId,
    addMessage,
    enqueueMessage,
    scrollToBottom,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // ── 独立窗口通信：监听来自独立窗口的 action ──
  useEffect(() => {
    if (!isTauri) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      cleanup = await initMainWindowListener(
        // onAction: 处理来自独立窗口的用户操作
        (action: ChatAction) => {
          const store = useAppStore.getState();

          switch (action.type) {
            case 'send_message': {
              // 同一会话内添加用户消息
              if (action.conversationId !== store.activeConversationId) {
                store.setActiveConversation(action.conversationId);
              }
              const userMsg: ChatMessage = {
                id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                role: 'user',
                content: action.content,
                timestamp: Date.now(),
                status: 'done',
              };
              store.addMessage(userMsg);
              store.enqueueMessage(action.content);

              // 占位响应
              const assistantMsg: ChatMessage = {
                id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                role: 'assistant',
                content: '欢迎来到 AI Canvas 对话助手！\n\n当前为基础骨架版本，AI 对话能力将在下一阶段接入。',
                timestamp: Date.now(),
                status: 'done',
              };
              setTimeout(() => store.addMessage(assistantMsg), 500);
              break;
            }

            case 'switch_conversation':
              store.setActiveConversation(action.conversationId);
              break;

            case 'create_conversation':
              store.createConversation(action.projectId, action.title);
              break;

            case 'rename_conversation':
              store.updateConversation(action.conversationId, {
                title: action.title,
                titleSource: 'user',
              });
              break;

            case 'toggle_pin': {
              const conv = store.conversations.find((c) => c.id === action.conversationId);
              if (conv) {
                store.updateConversation(action.conversationId, { pinned: !conv.pinned });
              }
              break;
            }

            case 'archive_conversation':
              store.updateConversation(action.conversationId, { archived: true });
              break;

            case 'delete_conversation':
              store.updateConversation(action.conversationId, { deletedAt: Date.now() });
              store.removeConversation(action.conversationId);
              break;

            case 'request_sync':
              // 独立窗口请求同步 — 由下面的 sync useEffect 处理
              break;
          }

          // 每次 action 处理后同步状态到独立窗口
          syncToChatWindow();
        },
        // onDetachClosed: 独立窗口关闭回调
        () => {
          useAppStore.getState().setChatPanelDetached(false);
          useAppStore.getState().openChat();
        },
      );
    })();

    return () => { cleanup?.(); };
  }, []);

  // 状态变更时同步到独立窗口
  const syncToChatWindow = useCallback(() => {
    if (!isTauri) return;
    const s = useAppStore.getState();
    if (!s.chatPanelDetached) return;

    const project = s.projects.find((p) => p.id === s.currentProjectId);
    emitSyncState({
      conversations: s.conversations,
      activeConversationId: s.activeConversationId,
      messages: s.messages,
      projectId: s.currentProjectId,
      projectName: project?.name,
    });
  }, []);

  // 当 chatPanelDetached 变为 true 时发送初始同步
  useEffect(() => {
    if (chatPanelDetached) {
      syncToChatWindow();
    }
  }, [chatPanelDetached, syncToChatWindow]);

  // 当消息/会话变化且处于分离模式时同步
  useEffect(() => {
    if (chatPanelDetached) {
      syncToChatWindow();
    }
  }, [messages, conversations, activeConversationId, chatPanelDetached, syncToChatWindow]);

  // ── 分离 / 附着按钮 ──
  const handleDetachToggle = useCallback(async () => {
    if (!isTauri) {
      showToast('独立窗口功能需要 Tauri 环境', 'info');
      return;
    }

    if (chatPanelDetached) {
      // 当前已分离 → 收回内嵌
      try {
        await emitCloseChatWindow();
        await invoke('close_chat_window');
      } catch { /* ignore */ }
      setChatPanelDetached(false);
    } else {
      // 当前内嵌 → 打开独立窗口
      try {
        await invoke('open_chat_window');
        setChatPanelDetached(true);
        // 延迟发送初始同步（等独立窗口渲染完成）
        setTimeout(() => syncToChatWindow(), 500);
      } catch (e) {
        console.error('[ChatPanel] failed to open chat window:', e);
        showToast('打开独立窗口失败', 'error');
      }
    }
  }, [chatPanelDetached, setChatPanelDetached, showToast, syncToChatWindow]);

  // 空状态：无活动会话
  const showEmptyState = !activeConversationId && viewMode === 'chat';

  return (
    <AnimatePresence>
      {chatOpen && !chatPanelDetached && (
          <motion.aside
            className="chat-panel fixed z-50 flex flex-col"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-canvas-border flex-shrink-0">
              <div className="flex items-center gap-2">
                {viewMode === 'chat' && activeConversationId && (
                  <button
                    type="button"
                    className="flex items-center justify-center w-6 h-6 rounded-md text-canvas-text-muted
                               hover:text-canvas-text hover:bg-canvas-hover transition-colors"
                    onClick={() => setViewMode('list')}
                  >
                    <Icon icon="mdi:menu" width="16" height="16" />
                  </button>
                )}
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                    <Icon icon="mdi:robot-outline" width="16" height="16" className="text-indigo-400" />
                  </div>
                  <span className="text-sm font-medium text-canvas-text">
                    AI 助手
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 font-medium uppercase">
                    Beta
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {/* 独立窗口按钮 */}
                <button
                  type="button"
                  className="flex items-center justify-center w-7 h-7 rounded-md text-canvas-text-muted
                             hover:text-canvas-text hover:bg-canvas-hover transition-colors"
                  onClick={handleDetachToggle}
                  data-tooltip={chatPanelDetached ? '收回内嵌' : '独立窗口'}
                >
                  <Icon icon={chatPanelDetached ? 'mdi:dock-left' : 'mdi:dock-window'} width="16" height="16" />
                </button>


                {/* 关闭按钮 */}
                <button
                  type="button"
                  className="flex items-center justify-center w-7 h-7 rounded-md text-canvas-text-muted
                             hover:text-canvas-text hover:bg-canvas-hover transition-colors"
                  onClick={closeChat}
                >
                  <Icon icon="mdi:close" width="16" height="16" />
                </button>
              </div>
            </div>

            {/* Body: dual-pane layout */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
              {/* Conversation list pane */}
              {viewMode === 'list' && (
                <motion.div
                  initial={{ x: -20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  className="flex-shrink-0 w-full border-r border-canvas-border overflow-hidden"
                >
                  <ConversationList
                    onSelect={handleSelectConversation}
                    onNew={handleNewConversation}
                  />
                </motion.div>
              )}

              {/* Chat pane */}
              {viewMode === 'chat' && (
                <motion.div
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  className="flex-1 flex flex-col min-h-0 min-w-0"
                >
                  {/* Messages */}
                  <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4">
                    {showEmptyState && (
                      <EmptyChatState onNew={handleNewConversation} onList={() => setViewMode('list')} />
                    )}

                    {!showEmptyState && conversationMessages.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-center px-4">
                        <div className="w-16 h-16 rounded-2xl bg-indigo-500/15 flex items-center justify-center mb-4">
                          <Icon icon="mdi:chat-processing-outline" width="28" height="28" className="text-indigo-400" />
                        </div>
                        <p className="text-sm text-canvas-text-secondary mb-1">开始对话</p>
                        <p className="text-xs text-canvas-text-muted">
                          用自然语言操作画布，AI 助手帮你完成
                        </p>
                      </div>
                    )}

                    {conversationMessages.map((msg) => (
                      <MessageBubble key={msg.id} message={msg} />
                    ))}

                    <div ref={messagesEndRef} />
                  </div>

                  {/* Input area */}
                  {!showEmptyState && (
                    <div className="flex-shrink-0 px-4 py-3 border-t border-canvas-border">
                      <div className="flex items-end gap-2 bg-canvas-bg border border-canvas-border rounded-xl
                                      focus-within:border-canvas-text-secondary transition-colors px-3 py-2">
                        <textarea
                          ref={inputRef}
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
                          rows={1}
                          className="flex-1 resize-none bg-transparent text-sm text-canvas-text
                                     placeholder:text-canvas-text-muted outline-none
                                     min-h-[24px] max-h-[120px] py-1"
                        />
                        <AnimatedButton
                          scale={1.05}
                          disabled={!inputValue.trim()}
                          className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors
                                      ${inputValue.trim()
                                        ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                                        : 'bg-canvas-hover text-canvas-text-muted cursor-not-allowed'
                                      }`}
                          onClick={handleSend}
                        >
                          <Icon icon="mdi:send" width="16" height="16" />
                        </AnimatedButton>
                      </div>

                      {/* Disclaimer */}
                      <p className="text-[10px] text-canvas-text-muted mt-2 text-center px-4">
                        AI 助手仅理解画布操作指令，不会执行未授权的修改。
                      </p>
                    </div>
                  )}
                </motion.div>
              )}
            </div>
          </motion.aside>
      )}
    </AnimatePresence>
  );
}

/* ============================================
   Message bubble
   ============================================ */
function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-canvas-text-muted bg-canvas-hover px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {/* Assistant avatar */}
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center mr-2 mt-0.5">
          <Icon icon="mdi:robot-outline" width="14" height="14" className="text-indigo-400" />
        </div>
      )}

      <div
        className={`max-w-[80%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed
                    ${isUser
                      ? 'bg-indigo-500/20 text-canvas-text rounded-br-md'
                      : 'bg-canvas-hover text-canvas-text rounded-bl-md'
                    }`}
      >
        <div className="whitespace-pre-wrap break-words">{message.content}</div>

        {/* Status indicator */}
        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-3 bg-indigo-400 animate-pulse ml-1 align-middle rounded-sm" />
        )}
        {message.status === 'error' && (
          <div className="flex items-center gap-1 mt-1 text-[11px] text-red-400">
            <Icon icon="mdi:alert-circle" width="12" height="12" />
            响应失败
          </div>
        )}
        {message.status === 'interrupted' && (
          <div className="flex items-center gap-1 mt-1 text-[11px] text-amber-400">
            <Icon icon="mdi:alert-outline" width="12" height="12" />
            响应中断
          </div>
        )}
      </div>

      {/* User avatar */}
      {isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-canvas-hover flex items-center justify-center ml-2 mt-0.5">
          <Icon icon="mdi:account" width="14" height="14" className="text-canvas-text-secondary" />
        </div>
      )}
    </div>
  );
}

/* ============================================
   Empty chat state
   ============================================ */
function EmptyChatState({
  onNew,
  onList,
}: {
  onNew: () => void;
  onList: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-20 h-20 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-5">
        <Icon icon="mdi:robot-happy-outline" width="36" height="36" className="text-indigo-400" />
      </div>
      <h3 className="text-base font-semibold text-canvas-text mb-2">画布 AI 助手</h3>
      <p className="text-sm text-canvas-text-secondary mb-6 max-w-[260px]">
        用自然语言读取和操作画布。查询状态、定位节点、批量管理，一个对话框完成。
      </p>
      <div className="flex flex-col gap-2 w-48">
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-400 transition-colors"
          onClick={onNew}
        >
          <Icon icon="mdi:plus" width="16" height="16" />
          新建对话
        </AnimatedButton>
        <AnimatedButton
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl
                     bg-canvas-hover text-canvas-text-secondary text-sm hover:text-canvas-text
                     hover:bg-canvas-border transition-colors"
          onClick={onList}
        >
          <Icon icon="mdi:history" width="16" height="16" />
          历史记录
        </AnimatedButton>
      </div>

      {/* Example prompts */}
      <div className="mt-8 space-y-2 w-56">
        <p className="text-[11px] text-canvas-text-muted mb-2">试试这些：</p>
        {[
          '现在有几个失败节点？',
          '选中 3 号节点',
          '删除失败节点',
        ].map((example) => (
          <div
            key={example}
            className="px-3 py-2 text-xs text-canvas-text-secondary bg-canvas-bg border border-canvas-border
                       rounded-lg hover:border-canvas-text-secondary hover:text-canvas-text
                       transition-colors cursor-pointer"
          >
            {example}
          </div>
        ))}
      </div>
    </div>
  );
}
