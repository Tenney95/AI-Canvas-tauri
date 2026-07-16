/**
 * ChatPanel — 对话助手主面板
 *
 * 独立悬浮在窗口右侧的 AI 对话面板。
 * - 双栏布局：会话列表 + 消息区域
 * - 底部输入框 + 对话模型选择器 + @媒体模型引用
 * - 右侧关闭按钮 + 独立窗口按钮
 * - 使用 framer-motion 控制打开/关闭动画
 *
 * 子组件：
 * - ChatHeader.tsx          Header 栏
 * - ChatMessages.tsx        消息列表区
 * - ChatInput.tsx           输入区 + 模型选择器
 * - MessageBubble.tsx       单条消息气泡
 * - EmptyChatState.tsx      空会话状态
 * - ChatModelSelector.tsx   模型选择器
 */
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import ConversationList from './ConversationList';
import ChatHeader from './ChatHeader';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
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
import {
  buildAssistantSystemPrompt,
  resolveAssistantModel,
} from '../../services/ai/assistantStream';
import { runMediaGeneration } from '../../services/ai/generationRuntime';
import {
  resolveAgentApproval,
  runAgentLoop,
  runAgentTask,
} from '../../services/chat/agentRuntime';
import { getAvailableAgentTools } from '../../services/chat/toolRegistry';
import { ensureAgentToolsRegistered } from '../../services/chat/tools';
import type { ChatMessage } from '../../types/chat';
import type { AgentMode } from '../../types/agent';
import type { MediaGenerationIntent } from '../../types/media';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

interface ChatPanelProps {
  detached?: boolean;
  detachedSnapshot?: ChatStateSnapshot;
  detachedInitialized?: boolean;
  detachedHeaderActions?: ReactNode;
}

function markApprovalMessageExecuting(approvalId: string): void {
  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) =>
    item.steps.some((step) => step.approval?.id === approvalId),
  );
  if (!task) return;
  const step = task.steps.find((item) => item.approval?.id === approvalId);
  const message = store.messages.find((item) => item.agentTaskId === task.id);
  if (!message || !step) return;
  const placeholder = `等待确认：${step.title}`;
  store.updateMessage(message.id, {
    content: message.content === placeholder ? '' : message.content,
    status: 'executing',
  });
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
    agentTasks,
    currentProjectId,
    createConversation,
    setActiveConversation,
    updateConversation,
    addMessage,
    loadConversationMessages,
    showToast,
    assistantModelId,
    generalModels,
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
      agentTasks: s.agentTasks,
      currentProjectId: s.currentProjectId,
      createConversation: s.createConversation,
      setActiveConversation: s.setActiveConversation,
      updateConversation: s.updateConversation,
      addMessage: s.addMessage,
      loadConversationMessages: s.loadConversationMessages,
      showToast: s.showToast,
      assistantModelId: s.config.assistantModelId,
      generalModels: s.config.generalModels ?? [],
      updateConfig: s.updateConfig,
    })),
  );

  // ── detached 模式数据 ──
  const effectiveConversations = detached ? (detachedSnapshot?.conversations ?? []) : conversations;
  const effectiveActiveConversationId = detached ? (detachedSnapshot?.activeConversationId ?? null) : activeConversationId;
  const effectiveMessages = detached ? (detachedSnapshot?.messages ?? []) : messages;
  const effectiveAgentTasks = detached ? (detachedSnapshot?.agentTasks ?? []) : agentTasks;
  const effectiveProjectId = detached ? (detachedSnapshot?.projectId ?? null) : currentProjectId;
  const effectiveProjectName = detached ? detachedSnapshot?.projectName : undefined;
  const effectiveAssistantModelId = detached ? detachedSnapshot?.assistantModelId : assistantModelId;
  const effectiveGeneralModels = detached ? (detachedSnapshot?.generalModels ?? []) : generalModels;
  const effectiveActiveConversation = effectiveConversations.find(
    (conversation) => conversation.id === effectiveActiveConversationId,
  );
  const effectiveAgentMode = effectiveActiveConversation?.agentMode ?? 'collaborative';

  const [inputValue, setInputValue] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'chat'>('chat');

  const handleTextModelChange = useCallback((modelId?: string) => {
    if (detached) {
      void emitAction({ type: 'select_model', modelId, category: 'text' });
    } else {
      updateConfig({ assistantModelId: modelId });
    }
  }, [detached, updateConfig]);

  const handleAgentModeChange = useCallback((mode: AgentMode) => {
    if (!effectiveActiveConversationId || mode === effectiveAgentMode) return;
    if (detached) {
      void emitAction({
        type: 'set_agent_mode',
        conversationId: effectiveActiveConversationId,
        mode,
      });
      return;
    }
    updateConversation(effectiveActiveConversationId, { agentMode: mode });
    showToast(
      mode === 'autonomous'
        ? '已切换到 C 自主模式：画布操作可自动执行，付费媒体和文件写入仍需确认'
        : '已切换到 B 协作模式：画布写操作将先预览确认',
      'info',
    );
  }, [
    detached,
    effectiveActiveConversationId,
    effectiveAgentMode,
    showToast,
    updateConversation,
  ]);

  // ── 消息过滤 ──
  const conversationMessages = effectiveActiveConversationId
    ? effectiveMessages.filter((m) => m.conversationId === effectiveActiveConversationId)
    : [];

  // ── 会话操作 ──
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

  const handleShowList = useCallback(() => setViewMode('list'), []);

  const handleAddMediaToCanvas = useCallback((messageId: string) => {
    if (detached) return;
    const store = useAppStore.getState();
    const message = store.messages.find((item) => item.id === messageId);
    if (!message?.mediaResult) return;

    store.updateMessage(messageId, { canvasStatus: 'pending', canvasError: undefined });
    try {
      const nodeId = store.materializeMediaArtifact(message.mediaResult);
      store.updateMessage(messageId, {
        canvasStatus: 'created',
        canvasNodeId: nodeId,
        canvasError: undefined,
      });
      store.showToast('已添加到画布');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '添加节点失败';
      store.updateMessage(messageId, { canvasStatus: 'failed', canvasError: errorMessage });
      store.showToast(errorMessage, 'error');
    }
  }, [detached]);

  const handleResolveApproval = useCallback((approvalId: string, approved: boolean) => {
    if (detached) {
      void emitAction({ type: 'resolve_agent_approval', approvalId, approved });
      return;
    }
    markApprovalMessageExecuting(approvalId);
    if (!resolveAgentApproval(approvalId, approved)) {
      showToast('该确认已过期，请重新发起操作', 'info');
    }
  }, [detached, showToast]);

  // ── 发送消息 ──
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

    // 创建助手消息
    const assistantMsgId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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

    const scrollToBottom = () => {
      setTimeout(() => {
        document.querySelector('.chat-panel-messages')?.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    };

    startAgentMessageExecution({
      text,
      projectId: effectiveProjectId ?? '',
      conversationId: effectiveActiveConversationId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsgId,
      mode: effectiveAgentMode,
      onProgress: scrollToBottom,
    });

    scrollToBottom();
  }, [
    inputValue,
    detached,
    effectiveActiveConversationId,
    effectiveAgentMode,
    effectiveProjectId,
    addMessage,
  ]);

  // ── 状态同步到独立窗口 ──
  const syncToChatWindow = useCallback(() => {
    if (!isTauri) return;
    const s = useAppStore.getState();
    if (!s.chatPanelDetached) return;

    const project = s.projects.find((p) => p.id === s.currentProjectId);
    emitSyncState({
      conversations: s.conversations,
      activeConversationId: s.activeConversationId,
      messages: s.messages,
      agentTasks: s.agentTasks,
      projectId: s.currentProjectId,
      projectName: project?.name,
      generalModels: s.config.generalModels ?? [],
      assistantModelId: s.config.assistantModelId,
      assistantImageModelId: s.config.assistantImageModelId,
      assistantVideoModelId: s.config.assistantVideoModelId,
    });
  }, []);

  // ── 独立窗口通信 ──
  useEffect(() => {
    if (!isTauri || detached) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      cleanup = await initMainWindowListener(
        (action: ChatAction) => {
          const store = useAppStore.getState();

          switch (action.type) {
            case 'send_message': {
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

              const conversation = store.conversations.find(
                (item) => item.id === action.conversationId,
              );
              startAgentMessageExecution({
                text: action.content,
                projectId: conversation?.projectId ?? store.currentProjectId ?? '',
                conversationId: action.conversationId,
                userMessageId: userMsg.id,
                assistantMessageId: amId,
                mode: conversation?.agentMode ?? 'collaborative',
              });
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

            case 'set_agent_mode':
              store.updateConversation(action.conversationId, { agentMode: action.mode });
              store.showToast(
                action.mode === 'autonomous'
                  ? '已切换到 C 自主模式：画布操作可自动执行，付费媒体和文件写入仍需确认'
                  : '已切换到 B 协作模式：画布写操作将先预览确认',
                'info',
              );
              break;

            case 'resolve_agent_approval':
              markApprovalMessageExecuting(action.approvalId);
              if (!resolveAgentApproval(action.approvalId, action.approved)) {
                store.showToast('该确认已过期，请重新发起操作', 'info');
              }
              break;

            case 'select_model': {
              const cfg: Record<string, string | undefined> = {};
              const c = action.category || 'text';
              if (c === 'image') cfg.assistantImageModelId = action.modelId;
              else if (c === 'video') cfg.assistantVideoModelId = action.modelId;
              else cfg.assistantModelId = action.modelId;
              store.updateConfig(cfg);
              break;
            }

            case 'request_sync':
              break;
          }

          syncToChatWindow();
        },
        () => {
          useAppStore.getState().setChatPanelDetached(false);
          useAppStore.getState().openChat();
        },
      );
    })();

    return () => { cleanup?.(); };
  }, [detached, syncToChatWindow]);

  useEffect(() => {
    if (!detached && chatPanelDetached) {
      syncToChatWindow();
    }
  }, [detached, chatPanelDetached, syncToChatWindow]);

  useEffect(() => {
    if (!detached && chatPanelDetached) {
      syncToChatWindow();
    }
  }, [
    detached,
    messages,
    conversations,
    agentTasks,
    activeConversationId,
    chatPanelDetached,
    syncToChatWindow,
  ]);

  // ── 分离 / 附着 ──
  const handleDetachToggle = useCallback(async () => {
    if (!isTauri) {
      showToast('独立窗口功能需要 Tauri 环境', 'info');
      return;
    }

    if (chatPanelDetached) {
      try {
        await emitCloseChatWindow();
        await invoke('close_chat_window');
      } catch { /* ignore */ }
      setChatPanelDetached(false);
    } else {
      try {
        await invoke('open_chat_window');
        setChatPanelDetached(true);
        setTimeout(() => syncToChatWindow(), 500);
      } catch (e) {
        console.error('[ChatPanel] failed to open chat window:', e);
        showToast('打开独立窗口失败', 'error');
      }
    }
  }, [chatPanelDetached, setChatPanelDetached, showToast, syncToChatWindow]);

  // ── 空状态判断 ──
  const showEmptyState = !effectiveActiveConversationId && viewMode === 'chat';

  // ── 渲染 ──
  return (
    <AnimatePresence>
      {(detached || (chatOpen && !chatPanelDetached)) && (
          <motion.aside
            className={`chat-panel-root ${detached
              ? 'h-screen w-screen flex flex-col bg-canvas-bg text-canvas-text overflow-hidden'
              : 'chat-panel fixed z-50 flex flex-col'}`}
            initial={detached ? false : { x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={detached ? undefined : { x: '100%', opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Header */}
            <ChatHeader
              detached={detached}
              chatPanelDetached={chatPanelDetached}
              projectName={effectiveProjectName}
              agentMode={effectiveAgentMode}
              onAgentModeChange={handleAgentModeChange}
              agentModeDisabled={!effectiveActiveConversationId}
              showBackButton={viewMode === 'chat' && !!effectiveActiveConversationId}
              onBack={handleShowList}
              onDetachToggle={handleDetachToggle}
              onClose={closeChat}
              detachedHeaderActions={detachedHeaderActions}
            />

            {/* Body: dual-pane layout */}
            <div className="chat-panel-body flex flex-1 min-h-0">
              {/* Conversation list pane */}
              {viewMode === 'list' && (
                <motion.div
                  initial={{ x: -20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  className="chat-panel-conversation-list flex-shrink-0 w-full border-r border-canvas-border overflow-hidden"
                >
                  <ConversationList
                    {...(detached ? {
                      conversations: effectiveConversations,
                      activeConversationId: effectiveActiveConversationId,
                      agentTasks: effectiveAgentTasks,
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
                  className="chat-panel-chat-area flex-1 flex flex-col min-h-0 min-w-0"
                >
                  {/* Messages */}
                  <ChatMessages
                    messages={conversationMessages}
                    agentTasks={effectiveAgentTasks}
                    showEmptyState={showEmptyState}
                    detachedInitialized={detachedInitialized}
                    onNewConversation={handleNewConversation}
                    onShowList={handleShowList}
                    onAddMediaToCanvas={detached ? undefined : handleAddMediaToCanvas}
                    onResolveApproval={handleResolveApproval}
                  />

                  {/* Input area */}
                  {!showEmptyState && (
                    <ChatInput
                      assistantModelId={effectiveAssistantModelId}
                      onAssistantModelChange={handleTextModelChange}
                      mediaModels={effectiveGeneralModels}
                      inputValue={inputValue}
                      onInputChange={setInputValue}
                      onSend={handleSend}
                    />
                  )}
                </motion.div>
              )}
            </div>
          </motion.aside>
      )}
    </AnimatePresence>
  );
}

interface StartAgentMessageExecutionOptions {
  text: string;
  projectId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  mode: AgentMode;
  onProgress?: () => void;
}

function startAgentMessageExecution({
  text,
  projectId,
  conversationId,
  userMessageId,
  assistantMessageId,
  mode,
  onProgress,
}: StartAgentMessageExecutionOptions): void {
  const store = useAppStore.getState();
  ensureAgentToolsRegistered();
  const task = store.createAgentTask({
    projectId,
    conversationId,
    userMessageId,
    mode,
    goal: text,
  });
  store.updateMessage(assistantMessageId, { agentTaskId: task.id });

  void runAgentTask(task.id, async (signal) => {
    let failed = false;

    if (resolveAssistantModel()) {
      const availableTools = getAvailableAgentTools({
        taskId: task.id,
        projectId,
        conversationId,
        mode,
      });
      if (availableTools.length > 0) {
        return runAgentLoop({
          taskId: task.id,
          systemPrompt: buildAssistantSystemPrompt({ agentTools: true }),
          userMessage: text,
          signal,
          callbacks: {
            onTextDelta: (delta) => {
              const currentStore = useAppStore.getState();
              const message = currentStore.messages.find(
                (item) => item.id === assistantMessageId,
              );
              if (message) {
                currentStore.updateMessage(assistantMessageId, {
                  content: (message.content || '') + delta,
                  status: 'streaming',
                });
              }
              onProgress?.();
            },
            onComplete: (fullText) => {
              useAppStore.getState().updateMessage(assistantMessageId, {
                content: fullText,
                status: 'done',
              });
              onProgress?.();
            },
            onApprovalRequired: (step) => {
              const currentStore = useAppStore.getState();
              const message = currentStore.messages.find(
                (item) => item.id === assistantMessageId,
              );
              currentStore.updateMessage(assistantMessageId, {
                content: message?.content || `等待确认：${step.title}`,
                status: 'preview',
              });
            },
            onToolResult: (result) => {
              if (!result.sources?.length) return;
              const currentStore = useAppStore.getState();
              const message = currentStore.messages.find(
                (item) => item.id === assistantMessageId,
              );
              const sources = [...(message?.sources ?? [])];
              for (const source of result.sources) {
                if (!sources.some((item) => item.url === source.url)) sources.push(source);
              }
              currentStore.updateMessage(assistantMessageId, { sources });
              onProgress?.();
            },
            onError: (error) => {
              failed = true;
              useAppStore.getState().updateMessage(assistantMessageId, {
                content: `处理失败: ${error}`,
                status: 'error',
                finishReason: 'error',
              });
            },
          },
        });
      }

      await runStreamingPipeline(text, conversationId, {
        onTextDelta: (delta) => {
          const currentStore = useAppStore.getState();
          const message = currentStore.messages.find((item) => item.id === assistantMessageId);
          if (message) {
            currentStore.updateMessage(assistantMessageId, {
              content: (message.content || '') + delta,
              status: 'streaming',
            });
          }
          onProgress?.();
        },
        onComplete: (fullText, results) => {
          useAppStore.getState().updateMessage(assistantMessageId, {
            content: fullText,
            status: 'done',
            executionResults: results.length > 0 ? results : undefined,
          });
          onProgress?.();
        },
        onError: (error) => {
          failed = true;
          useAppStore.getState().updateMessage(assistantMessageId, {
            content: `处理失败: ${error}`,
            status: 'error',
            finishReason: 'error',
          });
        },
        onMediaIntent: (intent) => {
          void triggerMediaGeneration(assistantMessageId, intent);
        },
        signal,
      });
      return failed ? 'failed' : 'completed';
    }

    try {
      const result = await runAssistantPipeline(text, conversationId);
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: result.reply,
        status: 'done',
        executionResults: result.commandResults.length > 0 ? result.commandResults : undefined,
      });
      onProgress?.();
      return 'completed';
    } catch (error) {
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: `处理失败: ${error instanceof Error ? error.message : '未知错误'}`,
        status: 'error',
        finishReason: 'error',
      });
      return 'failed';
    }
  }).catch((error) => {
    console.error('[AgentRuntime] failed to execute chat task:', error);
  });
}

async function triggerMediaGeneration(
  messageId: string,
  intent: MediaGenerationIntent,
) {
  const store = useAppStore.getState();
  const needsCanvas = intent.deliveryMode === 'canvas' || intent.deliveryMode === 'both';
  let targetNodeId: string | undefined;

  if (needsCanvas) targetNodeId = store.createMediaPlaceholder(intent);
  store.updateMessage(messageId, {
    mediaStatus: 'queued',
    mediaError: undefined,
    canvasStatus: needsCanvas ? 'pending' : 'none',
    canvasNodeId: targetNodeId,
    canvasError: undefined,
  });
  try {
    store.updateMessage(messageId, { mediaStatus: 'generating' });
    const result = await runMediaGeneration(intent, store.currentProjectId);
    const nodeCreated = targetNodeId
      ? store.settleMediaPlaceholder(targetNodeId, result)
      : false;
    store.updateMessage(messageId, {
      mediaResult: result,
      mediaStatus: 'succeeded',
      mediaError: undefined,
      canvasStatus: targetNodeId ? (nodeCreated ? 'created' : 'failed') : 'none',
      canvasNodeId: targetNodeId,
      canvasError: targetNodeId && !nodeCreated ? '生成期间占位节点已被删除' : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    if (targetNodeId) store.failMediaPlaceholder(targetNodeId, message);
    store.updateMessage(messageId, {
      mediaStatus: 'failed',
      mediaError: message,
      canvasStatus: targetNodeId ? 'failed' : 'none',
      canvasNodeId: targetNodeId,
      canvasError: targetNodeId ? message : undefined,
    });
    const mediaLabel = intent.kind === 'image' ? '图片' : intent.kind === 'video' ? '视频' : '音频';
    store.showToast(`${mediaLabel}生成失败: ${message}`, 'error');
  }
}
