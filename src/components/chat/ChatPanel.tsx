/**
 * ChatPanel — 对话助手主面板
 *
 * 独立悬浮在窗口右侧的 AI 对话面板。
 * - 双栏布局：会话列表 + 消息区域
 * - 底部输入框
 * - 右侧关闭按钮 + 独立窗口按钮（P0-A.1 仅预留 UI）
 * - 使用 framer-motion 控制打开/关闭动画
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import ConversationList from './ConversationList';
import {
  initMainWindowListener,
  emitAction,
  emitSyncState,
  emitCloseChatWindow,
  type ChatAction,
  type ChatStateSnapshot,
} from '../../services/chat/chatWindowService';
import {
  runAssistantPipeline,
  runStreamingPipeline,
} from '../../services/chat/assistantService';
import { resolveAssistantModel } from '../../services/ai/assistantStream';
import type { ChatMessage } from '../../types/chat';
import type { GeneralModelConfig } from '../../types';
import AnimatedButton from '../shared/AnimatedButton';
import MascotAvatar from './MascotAvatar';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

interface ChatPanelProps {
  detached?: boolean;
  detachedSnapshot?: ChatStateSnapshot;
  detachedInitialized?: boolean;
  detachedHeaderActions?: ReactNode;
}

export default function ChatPanel({
  detached = false,
  detachedSnapshot,
  detachedInitialized = true,
  detachedHeaderActions,
}: ChatPanelProps = {}) {
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
    updateMessage,
    loadConversationMessages,
    showToast,
    generalModels,
    assistantModelId,
    updateConfig,
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
      updateMessage: s.updateMessage,
      loadConversationMessages: s.loadConversationMessages,
      showToast: s.showToast,
      generalModels: s.config.generalModels,
      assistantModelId: s.config.assistantModelId,
      updateConfig: s.updateConfig,
    })),
  );

  const effectiveConversations = detached ? (detachedSnapshot?.conversations ?? []) : conversations;
  const effectiveActiveConversationId = detached ? (detachedSnapshot?.activeConversationId ?? null) : activeConversationId;
  const effectiveMessages = detached ? (detachedSnapshot?.messages ?? []) : messages;
  const effectiveProjectId = detached ? (detachedSnapshot?.projectId ?? null) : currentProjectId;
  const effectiveProjectName = detached ? detachedSnapshot?.projectName : undefined;
  const effectiveGeneralModels = detached ? (detachedSnapshot?.generalModels ?? []) : generalModels;
  const effectiveAssistantModelId = detached ? detachedSnapshot?.assistantModelId : assistantModelId;

  const [inputValue, setInputValue] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'chat'>('chat');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ left: 0, top: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);

  // 文本类通用模型
  const textModels = (effectiveGeneralModels || []).filter((m) => m.category === 'text');
  const currentAssistantModel = textModels.find((m) => m.id === effectiveAssistantModelId);

  const handleAssistantModelChange = useCallback((modelId?: string) => {
    if (detached) {
      void emitAction({ type: 'select_model', modelId });
    } else {
      updateConfig({ assistantModelId: modelId });
    }
    setModelDropdownOpen(false);
  }, [detached, updateConfig]);

  // 点击外部关闭模型选择器（portal 下需同时检查 trigger 和 dropdown）
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = modelTriggerRef.current?.contains(target);
      const inDropdown = document.querySelector('.chat-model-dropdown-portal')?.contains(target);
      if (!inTrigger && !inDropdown) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelDropdownOpen]);

  // 自动滚动到底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  useEffect(() => {
    if (viewMode === 'chat') scrollToBottom();
  }, [effectiveMessages, viewMode, scrollToBottom]);

  // 消息过滤：只显示当前活动会话的消息
  const conversationMessages = effectiveActiveConversationId
    ? effectiveMessages.filter((m) => m.conversationId === effectiveActiveConversationId)
    : [];

  const handleNewConversation = useCallback(() => {
    if (!effectiveProjectId) return;
    if (detached) {
      void emitAction({ type: 'create_conversation', projectId: effectiveProjectId });
    } else {
      createConversation(effectiveProjectId);
    }
    setViewMode('chat');
  }, [detached, effectiveProjectId, createConversation]);

  const handleSelectConversation = useCallback(
    (id: string) => {
      if (detached) {
        void emitAction({ type: 'switch_conversation', conversationId: id });
      } else {
        setActiveConversation(id);
        loadConversationMessages(id);
      }
      setViewMode('chat');
    },
    [detached, setActiveConversation, loadConversationMessages],
  );

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || !effectiveActiveConversationId) return;

    if (detached) {
      void emitAction({
        type: 'send_message',
        content: text,
        conversationId: effectiveActiveConversationId,
      });
      setInputValue('');
      return;
    }

    // 创建用户消息
    const userMsg: ChatMessage = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      conversationId: effectiveActiveConversationId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      status: 'done',
    };
    addMessage(userMsg);
    setInputValue('');

    // 创建助手消息（初始状态 parsing）
    const assistantMsgId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // 判断是否有 LLM 模型配置
    const hasModel = !!resolveAssistantModel();

    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      conversationId: effectiveActiveConversationId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: hasModel ? 'streaming' : 'parsing',
    };
    addMessage(assistantMsg);

    if (hasModel) {
      // 流式路径
      runStreamingPipeline(text, effectiveActiveConversationId, {
        onTextDelta: (delta) => {
          // 增量更新消息内容
          const store = useAppStore.getState();
          const msg = store.messages.find((m) => m.id === assistantMsgId);
          if (msg) {
            store.updateMessage(assistantMsgId, {
              content: (msg.content || '') + delta,
              status: 'streaming',
            });
          }
          scrollToBottom();
        },
        onComplete: (fullText, results) => {
          updateMessage(assistantMsgId, {
            content: fullText,
            status: results.length > 0 ? 'done' : 'done',
            executionResults: results.length > 0 ? results : undefined,
          });
          scrollToBottom();
        },
        onError: (error) => {
          updateMessage(assistantMsgId, {
            content: `处理失败: ${error}`,
            status: 'error',
            finishReason: 'error',
          });
        },
      });
    } else {
      // 本地规则路径
      runAssistantPipeline(text, effectiveActiveConversationId)
        .then((result) => {
          updateMessage(assistantMsgId, {
            content: result.reply,
            status: result.commandExecuted ? 'done' : 'done',
            executionResults: result.commandResults.length > 0 ? result.commandResults : undefined,
          });
        })
        .catch((err) => {
          updateMessage(assistantMsgId, {
            content: `处理失败: ${err instanceof Error ? err.message : '未知错误'}`,
            status: 'error',
            finishReason: 'error',
          });
        });
    }

    scrollToBottom();
  }, [
    inputValue,
    detached,
    effectiveActiveConversationId,
    addMessage,
    updateMessage,
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
    if (!isTauri || detached) return;

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
                conversationId: action.conversationId,
                role: 'user',
                content: action.content,
                timestamp: Date.now(),
                status: 'done',
              };
              store.addMessage(userMsg);

              // 创建助手消息
              const amId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
              const hasModel = !!resolveAssistantModel();
              const am: ChatMessage = {
                id: amId,
                conversationId: action.conversationId,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                status: hasModel ? 'streaming' : 'parsing',
              };
              store.addMessage(am);

              if (hasModel) {
                runStreamingPipeline(action.content, action.conversationId, {
                  onTextDelta: (delta) => {
                    const s = useAppStore.getState();
                    const m = s.messages.find((mm) => mm.id === amId);
                    if (m) {
                      s.updateMessage(amId, {
                        content: (m.content || '') + delta,
                        status: 'streaming',
                      });
                    }
                  },
                  onComplete: (fullText, results) => {
                    store.updateMessage(amId, {
                      content: fullText,
                      status: 'done',
                      executionResults: results.length > 0 ? results : undefined,
                    });
                  },
                  onError: (error) => {
                    store.updateMessage(amId, {
                      content: `处理失败: ${error}`,
                      status: 'error',
                      finishReason: 'error',
                    });
                  },
                });
              } else {
                runAssistantPipeline(action.content, action.conversationId)
                  .then((result) => {
                    store.updateMessage(amId, {
                      content: result.reply,
                      status: 'done',
                      executionResults: result.commandResults.length > 0 ? result.commandResults : undefined,
                    });
                  })
                  .catch((err) => {
                    store.updateMessage(amId, {
                      content: `处理失败: ${err instanceof Error ? err.message : '未知错误'}`,
                      status: 'error',
                      finishReason: 'error',
                    });
                  });
              }
              break;
            }

            case 'switch_conversation':
              store.setActiveConversation(action.conversationId);
              void store.loadConversationMessages(action.conversationId);
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

            case 'select_model':
              store.updateConfig({ assistantModelId: action.modelId });
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
  }, [detached]);

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
      generalModels: s.config.generalModels ?? [],
      assistantModelId: s.config.assistantModelId,
    });
  }, []);

  // 当 chatPanelDetached 变为 true 时发送初始同步
  useEffect(() => {
    if (!detached && chatPanelDetached) {
      syncToChatWindow();
    }
  }, [detached, chatPanelDetached, syncToChatWindow]);

  // 当消息/会话变化且处于分离模式时同步
  useEffect(() => {
    if (!detached && chatPanelDetached) {
      syncToChatWindow();
    }
  }, [detached, messages, conversations, activeConversationId, chatPanelDetached, syncToChatWindow]);

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
  const showEmptyState = !effectiveActiveConversationId && viewMode === 'chat';

  return (
    <AnimatePresence>
      {(detached || (chatOpen && !chatPanelDetached)) && (
          <motion.aside
            className={detached
              ? 'h-screen w-screen flex flex-col bg-canvas-bg text-canvas-text overflow-hidden'
              : 'chat-panel fixed z-50 flex flex-col'}
            initial={detached ? false : { x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={detached ? undefined : { x: '100%', opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Header */}
            <div
              data-tauri-drag-region={detached ? true : undefined}
              className="flex items-center justify-between px-4 py-3 border-b border-canvas-border flex-shrink-0 select-none"
            >
              <div className="flex items-center gap-2">
                {viewMode === 'chat' && effectiveActiveConversationId && (
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
                  <MascotAvatar size={28} className="shrink-0" />
                  <span className="text-sm font-medium text-canvas-text">
                    AI 助手
                  </span>
                  {detached && effectiveProjectName && (
                    <span className="text-[11px] text-canvas-text-muted truncate max-w-[120px]">
                      — {effectiveProjectName}
                    </span>
                  )}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 font-medium uppercase">
                    Beta
                  </span>
                </div>
              </div>

              {detached ? detachedHeaderActions : (
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
              )}
            </div>

            {/* Body: dual-pane layout */}
            <div className="flex flex-1 min-h-0">
              {/* Conversation list pane */}
              {viewMode === 'list' && (
                <motion.div
                  initial={{ x: -20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  className="flex-shrink-0 w-full border-r border-canvas-border overflow-hidden"
                >
                  <ConversationList
                    {...(detached ? {
                      conversations: effectiveConversations,
                      activeConversationId: effectiveActiveConversationId,
                      projectId: effectiveProjectId ?? undefined,
                      onRenameConversation: (id: string, title: string) => {
                        void emitAction({ type: 'rename_conversation', conversationId: id, title });
                      },
                      onTogglePin: (id: string) => {
                        void emitAction({ type: 'toggle_pin', conversationId: id });
                      },
                      onArchiveConversation: (id: string) => {
                        void emitAction({ type: 'archive_conversation', conversationId: id });
                      },
                      onDeleteConversation: (id: string) => {
                        void emitAction({ type: 'delete_conversation', conversationId: id });
                      },
                    } : {})}
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
                    {showEmptyState && detachedInitialized && (
                      <EmptyChatState onNew={handleNewConversation} onList={() => setViewMode('list')} />
                    )}

                    {!showEmptyState && conversationMessages.length === 0 && detachedInitialized && (
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
                    <div className="flex-shrink-0 px-3 pt-2 pb-1">
                      <div className="flex flex-col bg-canvas-card border border-canvas-border rounded-[14px]
                                      focus-within:border-canvas-text-secondary transition-colors px-4 pt-4 pb-3 shadow-lg">
                        <textarea
                          ref={inputRef}
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder="输入消息，描述你想对画布进行的修改"
                          rows={1}
                          className="w-full resize-none bg-transparent text-[15px] leading-6 text-canvas-text
                                     placeholder:text-canvas-text-muted outline-none
                                     min-h-[64px] max-h-[160px]"
                        />

                        <div className="mt-2 flex items-center justify-between gap-3">
                          {/* ── 模型选择器 ── */}
                          <div className="chat-model-selector min-w-0" ref={modelDropdownRef}>
                          <button
                            ref={modelTriggerRef}
                            type="button"
                            className={`chat-model-trigger ${currentAssistantModel ? 'has-model' : ''}`}
                            onClick={() => {
                              if (!modelDropdownOpen && modelTriggerRef.current) {
                                const rect = modelTriggerRef.current.getBoundingClientRect();
                                setDropdownPos({
                                  left: rect.left + rect.width / 2,
                                  top: rect.top,
                                });
                              }
                              setModelDropdownOpen((v) => !v);
                            }}
                            title={currentAssistantModel ? currentAssistantModel.name : '选择助手模型'}
                          >
                            {currentAssistantModel ? (
                              <>
                                <span
                                  className="text-model-icon-mini"
                                  data-badge={getModelBadge(currentAssistantModel)}
                                >
                                  {getModelBadge(currentAssistantModel)}
                                </span>
                                <span className="chat-model-label">{currentAssistantModel.name}</span>
                              </>
                            ) : (
                              <>
                                <Icon icon="mdi:brain" width="14" height="14" className="text-canvas-text-muted" />
                                <span className="chat-model-label text-canvas-text-muted">本地规则</span>
                              </>
                            )}
                            <Icon
                              icon="mdi:chevron-down"
                              width="12"
                              height="12"
                              className={`caret ${modelDropdownOpen ? 'rotate-180' : ''}`}
                            />
                          </button>

                          {modelDropdownOpen &&
                            createPortal(
                              <div
                                className="chat-model-dropdown-anchor"
                                style={{
                                  position: 'fixed',
                                  left: `${dropdownPos.left}px`,
                                  top: `${dropdownPos.top}px`,
                                  transform: 'translate(-50%, -100%) translateY(-8px)',
                                }}
                              >
                                <div className="model-dropdown chat-model-dropdown-portal">
                                {/* 本地规则引擎（不使用 LLM） */}
                                <button
                                  type="button"
                                  className={`model-item ${!effectiveAssistantModelId ? 'active' : ''}`}
                                  onClick={() => handleAssistantModelChange(undefined)}
                                >
                                  <div className="model-item-info">
                                    <div className="model-item-name">本地规则引擎</div>
                                    <div className="model-item-desc">仅识别画布命令，不调用 LLM</div>
                                  </div>
                                {!effectiveAssistantModelId && (
                                    <Icon icon="mdi:check" width="14" height="14" className="model-item-check" />
                                  )}
                                </button>

                                {textModels.length > 0 && (
                                  <div className="model-group">
                                    <div className="model-group-header" style={{ pointerEvents: 'none' }}>
                                      <span className="model-group-name">文本模型</span>
                                    </div>
                                    <div className="model-group-items" style={{ padding: '2px 0 4px 4px' }}>
                                      {textModels.map((m) => (
                                        <button
                                          key={m.id}
                                          type="button"
                                          className={`model-item ${m.id === effectiveAssistantModelId ? 'active' : ''}`}
                                          onClick={() => handleAssistantModelChange(m.id)}
                                        >
                                          <span className="text-model-icon-mini" data-badge={getModelBadge(m)}>
                                            {getModelBadge(m)}
                                          </span>
                                          <div className="model-item-info">
                                            <div className="model-item-name">{m.name}</div>
                                            <div className="model-item-desc">{m.modelId}</div>
                                          </div>
                                          {m.id === effectiveAssistantModelId && (
                                            <Icon icon="mdi:check" width="14" height="14" className="model-item-check" />
                                          )}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {textModels.length === 0 && (
                                  <div className="model-wf-empty">
                                    暂无文本模型，请在设置中添加
                                  </div>
                                )}
                              </div>
                              </div>,
                              document.body,
                            )}
                          </div>

                          <AnimatedButton
                            scale={1.05}
                            disabled={!inputValue.trim()}
                            aria-label="发送消息"
                            className={`flex shrink-0 items-center justify-center w-10 h-10 rounded-full transition-colors
                                        ${inputValue.trim()
                                          ? 'bg-canvas-text text-canvas-bg hover:opacity-90'
                                          : 'bg-canvas-hover text-canvas-text-muted cursor-not-allowed'
                                        }`}
                            onClick={handleSend}
                          >
                            <Icon icon="mdi:arrow-up" width="20" height="20" />
                          </AnimatedButton>
                        </div>
                      </div>

                      {/* Disclaimer */}
                      <p className="text-[10px] text-canvas-text-muted mt-1 text-center px-4">
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
   Helpers
   ============================================ */

/** 从模型名称提取 2 字符徽章 */
function getModelBadge(m: GeneralModelConfig): string {
  const name = (m.name || m.modelId || '').toUpperCase().replace(/\s/g, '');
  // 匹配已知品牌
  const brands: Record<string, string> = {
    OPENAI: 'OA', GPT: 'OA', CHATGPT: 'OA',
    CLAUDE: 'AM', ANTHROPIC: 'AM',
    DEEPSEEK: 'DS',
    QWEN: 'QW', TONGYI: 'TY',
    GEMINI: 'GR', GOOGLE: 'GR',
    MISTRAL: 'M',
    LLAMA: 'MA', META: 'MA',
    GROK: 'GK',
    MINIMAX: 'MX',
    STEP: 'SP',
    ERNIE: 'ER', WENXIN: 'ER',
    GLM: 'GL', CHATGLM: 'GL', ZHIPU: 'ZP',
    KIMI: 'KM', MOONSHOT: 'KM',
    BAICHUAN: 'BC',
    YI: 'YI', LINGYI: 'LY',
    HUNYUAN: 'HY',
    SPARK: 'SK',
  };
  for (const [key, badge] of Object.entries(brands)) {
    if (name.includes(key)) return badge;
  }
  // 取前两个大写字母/数字
  const alnum = name.replace(/[^A-Z0-9]/g, '');
  return alnum.slice(0, 2) || 'AI';
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
        <MascotAvatar size={28} className="shrink-0 mr-2 mt-0.5" />
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
      <MascotAvatar size={72} className="mb-5" />
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
