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
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import ConversationList from './ConversationList';
import ChatHeader from './ChatHeader';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ProjectMemoryPanel from './ProjectMemoryPanel';
import AgentTaskCenter from './AgentTaskCenter';
import {
  initMainWindowListener,
  emitAction,
  emitSyncState,
  emitCloseChatWindow,
  createChatStatePatch,
  hasChatStatePatchChanges,
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
  pauseAgentTask,
  stopAgentTask,
  skipAgentStep,
  requestAgentReplan,
  prepareAgentTaskResume,
  validateTaskResumable,
  type AgentResumeValidation,
} from '../../services/chat/agentRuntime';
import {
  cancelScheduledAgentExecution,
  getActiveConversationAgentTaskId,
  scheduleConversationAgentExecution,
} from '../../services/chat/agentScheduler';
import { enqueueAgentInterjection } from '../../services/chat/agentInterjection';
import { rewindAgentTaskCanvas } from '../../services/chat/agentRewindService';
import { getAvailableAgentTools } from '../../services/chat/toolRegistry';
import { ensureAgentToolsRegistered } from '../../services/chat/tools';
import { estimateConversationUsage } from '../../services/chat/contextManager';
import {
  expandSkillReferences,
  resolveSkillToolAllowlist,
} from '../../services/skillPromptService';
import type { ChatMessage } from '../../types/chat';
import {
  DEFAULT_AGENT_TASK_BUDGET,
  type AgentApprovalResolution,
  type AgentMode,
} from '../../types/agent';
import type { ApiProviderConfig, GeneralModelConfig } from '../../types';
import type { MediaGenerationIntent } from '../../types/media';
import {
  getMediaModelOptions,
  type MediaModelOption,
} from '../nodes/shared/defaultModels';
import {
  authorizeConversationFiles,
  clearConversationFileGrants,
  listConversationFileGrants,
  revokeFileGrant,
  subscribeFileGrants,
} from '../../services/chat/fileGrantService';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const STREAMING_UI_FLUSH_INTERVAL_MS = 50;
const DETACHED_CHAT_SYNC_INTERVAL_MS = 150;

interface StreamingMessageBuffer {
  append: (delta: string) => void;
  flush: () => void;
  cancel: () => void;
}

function createStreamingMessageBuffer(
  messageId: string,
  onProgress?: () => void,
): StreamingMessageBuffer {
  let pendingText = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPending = () => {
    flushTimer = null;
    if (!pendingText) return;
    const delta = pendingText;
    pendingText = '';
    const store = useAppStore.getState();
    const message = store.messages.find((item) => item.id === messageId);
    if (!message) return;
    store.updateMessageTransient(messageId, {
      content: (message.content || '') + delta,
      status: 'streaming',
    });
    onProgress?.();
  };

  const clearFlushTimer = () => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  return {
    append: (delta) => {
      if (!delta) return;
      pendingText += delta;
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, STREAMING_UI_FLUSH_INTERVAL_MS);
      }
    },
    flush: () => {
      clearFlushTimer();
      flushPending();
    },
    cancel: () => {
      clearFlushTimer();
      pendingText = '';
    },
  };
}

function getMediaModelAvailability(
  options: MediaModelOption[],
  generalModels: GeneralModelConfig[],
  providers: Record<string, ApiProviderConfig>,
  dreaminaLoggedIn: boolean,
): Record<string, boolean> {
  return Object.fromEntries(options.map((option) => {
    if (option.provider === 'general') {
      const generalModel = generalModels.find(
        (model) => `general/${model.id}` === option.value,
      );
      return [option.value, !!generalModel?.openaiUrl && !!generalModel.modelId];
    }
    if (option.provider === 'dreamina') {
      return [option.value, dreaminaLoggedIn];
    }
    const providerConfigId = option.groupId === 'runninghub'
      ? 'runninghub-model'
      : option.groupId;
    return [option.value, !!providers[providerConfigId]?.apiKey];
  }));
}

function sanitizeGeneralModels(models: GeneralModelConfig[]): GeneralModelConfig[] {
  return models.map((model) => ({ ...model, apiKey: '' }));
}

function buildDetachedChatSnapshot(
  state: ReturnType<typeof useAppStore.getState>,
): ChatStateSnapshot {
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  return {
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    messages: state.messages,
    agentTasks: state.agentTasks,
    projectId: state.currentProjectId,
    projectName: project?.name,
    generalModels: sanitizeGeneralModels(state.config.generalModels ?? []),
    assistantModelId: state.config.assistantModelId,
    assistantImageModelId: state.config.assistantImageModelId,
    assistantVideoModelId: state.config.assistantVideoModelId,
    mediaModelAvailability: getMediaModelAvailability(
      getMediaModelOptions(state.config.generalModels ?? [], state.config),
      state.config.generalModels ?? [],
      state.config.providers,
      !!state.config.dreaminaAuth?.loggedIn,
    ),
    localFileGrants: state.activeConversationId
      ? listConversationFileGrants(state.activeConversationId)
      : [],
  };
}

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
  const reduceMotion = useReducedMotion();
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
    currentProjectName,
    createConversation,
    setActiveConversation,
    updateConversation,
    addMessage,
    loadConversationMessages,
    showToast,
    assistantModelId,
    assistantImageModelId,
    assistantVideoModelId,
    generalModels,
    providers,
    dreaminaLoggedIn,
    updateConfig,
    saveConfig,
    projectMemories,
    updateProjectMemory,
    removeProjectMemory,
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
      currentProjectName: s.projects.find((project) => project.id === s.currentProjectId)?.name,
      createConversation: s.createConversation,
      setActiveConversation: s.setActiveConversation,
      updateConversation: s.updateConversation,
      addMessage: s.addMessage,
      loadConversationMessages: s.loadConversationMessages,
      showToast: s.showToast,
      assistantModelId: s.config.assistantModelId,
      assistantImageModelId: s.config.assistantImageModelId,
      assistantVideoModelId: s.config.assistantVideoModelId,
      generalModels: s.config.generalModels ?? [],
      providers: s.config.providers,
      dreaminaLoggedIn: !!s.config.dreaminaAuth?.loggedIn,
      updateConfig: s.updateConfig,
      saveConfig: s.saveConfig,
      projectMemories: s.projectMemories,
      updateProjectMemory: s.updateProjectMemory,
      removeProjectMemory: s.removeProjectMemory,
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
  const effectiveGeneralModels = useMemo(
    () => detached ? (detachedSnapshot?.generalModels ?? []) : generalModels,
    [detached, detachedSnapshot?.generalModels, generalModels],
  );
  const mediaCatalogConfig = useMemo(() => ({
    providers,
    dreaminaAuth: { loggedIn: dreaminaLoggedIn },
  }), [dreaminaLoggedIn, providers]);
  const mediaModelOptions = useMemo(
    () => {
      const options = getMediaModelOptions(
        effectiveGeneralModels,
        detached ? undefined : mediaCatalogConfig,
      );
      if (!detached) return options;
      const availability = detachedSnapshot?.mediaModelAvailability;
      if (!availability) return [];
      return options.filter((option) => Object.prototype.hasOwnProperty.call(
        availability,
        option.value,
      ));
    },
    [
      detached,
      detachedSnapshot?.mediaModelAvailability,
      effectiveGeneralModels,
      mediaCatalogConfig,
    ],
  );
  const localMediaModelAvailability = useMemo(
    () => getMediaModelAvailability(
      mediaModelOptions,
      generalModels,
      providers,
      dreaminaLoggedIn,
    ),
    [dreaminaLoggedIn, generalModels, mediaModelOptions, providers],
  );
  const effectiveMediaModelAvailability = useMemo(
    () => detached
      ? (detachedSnapshot?.mediaModelAvailability ?? {})
      : localMediaModelAvailability,
    [detached, detachedSnapshot?.mediaModelAvailability, localMediaModelAvailability],
  );
  const effectiveActiveConversation = effectiveConversations.find(
    (conversation) => conversation.id === effectiveActiveConversationId,
  );
  const effectiveAgentMode = effectiveActiveConversation?.agentMode ?? 'collaborative';
  const hasActiveConversationTask = effectiveAgentTasks.some(
    (task) => task.conversationId === effectiveActiveConversationId
      && ['planning', 'running', 'waiting_tool', 'waiting_approval'].includes(task.status),
  );

  const [inputValue, setInputValue] = useState('');
  const conversationDraftsRef = useRef(new Map<string, string>());
  const pendingConversationDraftRef = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'chat'>('chat');
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showTaskCenter, setShowTaskCenter] = useState(false);
  const currentProjectMemories = effectiveProjectId
    ? projectMemories.filter((memory) => memory.projectId === effectiveProjectId)
    : [];
  const [fileGrantVersion, setFileGrantVersion] = useState(0);
  useEffect(() => subscribeFileGrants(
    () => setFileGrantVersion((version) => version + 1),
  ), []);
  const effectiveLocalFileGrants = detached
    ? (detachedSnapshot?.localFileGrants ?? [])
    : effectiveActiveConversationId
      ? listConversationFileGrants(effectiveActiveConversationId)
      : [];

  const updateInputDraft = useCallback((value: string) => {
    setInputValue(value);
    if (!effectiveActiveConversationId) return;
    if (value) conversationDraftsRef.current.set(effectiveActiveConversationId, value);
    else conversationDraftsRef.current.delete(effectiveActiveConversationId);
  }, [effectiveActiveConversationId]);

  useEffect(() => {
    if (effectiveActiveConversationId && pendingConversationDraftRef.current != null) {
      const pendingDraft = pendingConversationDraftRef.current;
      pendingConversationDraftRef.current = null;
      conversationDraftsRef.current.set(effectiveActiveConversationId, pendingDraft);
      setInputValue(pendingDraft);
      return;
    }
    setInputValue(effectiveActiveConversationId
      ? (conversationDraftsRef.current.get(effectiveActiveConversationId) ?? '')
      : '');
  }, [effectiveActiveConversationId]);

  const handleTextModelChange = useCallback((modelId?: string) => {
    if (detached) {
      void emitAction({ type: 'select_model', modelId, category: 'text' });
    } else {
      updateConfig({ assistantModelId: modelId });
      void saveConfig({ silent: true });
    }
  }, [detached, saveConfig, updateConfig]);

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
    showToast(getAgentModeToast(mode), 'info');
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

  // ── 上下文占用（估算），模型切换后按新上限重新计算 ──
  const contextUsage = useMemo(() => {
    if (!effectiveActiveConversationId) return null;
    const model = effectiveGeneralModels.find(
      (item) => item.id === effectiveAssistantModelId && item.category === 'text',
    ) ?? null;
    return estimateConversationUsage(
      conversationMessages,
      effectiveActiveConversation?.contextSummary,
      model,
    );
    // conversationMessages 每次渲染都是新数组，依赖其来源 effectiveMessages
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effectiveActiveConversationId,
    effectiveAssistantModelId,
    effectiveGeneralModels,
    effectiveActiveConversation?.contextSummary,
    effectiveMessages,
  ]);

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

  const handleExampleClick = useCallback((text: string) => {
    if (!effectiveActiveConversationId && effectiveProjectId) {
      pendingConversationDraftRef.current = text;
      handleNewConversation();
      setInputValue(text);
      return;
    }
    updateInputDraft(text);
  }, [effectiveActiveConversationId, effectiveProjectId, handleNewConversation, updateInputDraft]);

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

  const handleResolveApproval = useCallback((
    approvalId: string,
    resolution: AgentApprovalResolution,
  ) => {
    if (detached) {
      void emitAction({ type: 'resolve_agent_approval', approvalId, resolution });
      return;
    }
    if (!resolveAgentApproval(approvalId, resolution)) {
      showToast('该确认已过期，请重新发起操作', 'info');
      return;
    }
    markApprovalMessageExecuting(approvalId);
  }, [detached, showToast]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      document.querySelector('.chat-panel-messages')?.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  const agentControls = useMemo(() => ({
    onResolveApproval: handleResolveApproval,
    mediaModelOptions,
    mediaModelAvailability: effectiveMediaModelAvailability,
    onPause: (taskId: string) => {
      if (detached) { void emitAction({ type: 'pause_agent_task', taskId }); return; }
      cancelScheduledAgentExecution(taskId);
      pauseAgentTask(taskId);
      showToast('已暂停任务', 'info');
    },
    onResume: (taskId: string) => {
      if (detached) { void emitAction({ type: 'resume_agent_task', taskId }); return; }
      const result = resumeAgentTaskExecution(taskId, scrollToBottom);
      showToast(result.ok ? '已继续任务' : (result.message ?? '无法继续该任务'), result.ok ? 'info' : 'error');
    },
    onStop: (taskId: string) => {
      if (detached) { void emitAction({ type: 'stop_agent_task', taskId }); return; }
      cancelScheduledAgentExecution(taskId);
      stopAgentTask(taskId);
      showToast('已停止任务', 'info');
    },
    onSkip: (taskId: string, stepId: string) => {
      if (detached) { void emitAction({ type: 'skip_agent_step', taskId, stepId }); return; }
      try {
        skipAgentStep(taskId, stepId);
        showToast('已跳过当前步骤，可继续或重新规划', 'info');
      } catch {
        showToast('该步骤已无法跳过', 'error');
      }
    },
    onReplan: (taskId: string) => {
      if (detached) { void emitAction({ type: 'replan_agent_task', taskId }); return; }
      requestAgentReplan(taskId);
      resumeAgentTaskExecution(taskId, scrollToBottom);
      showToast('正在重新规划任务', 'info');
    },
    onRewind: (taskId: string) => {
      if (detached) { void emitAction({ type: 'rewind_agent_task', taskId }); return; }
      void rewindAgentTaskCanvas(taskId).then((result) => {
        showToast(result.ok ? '已回退该任务的画布修改' : (result.message ?? '无法回退任务'), result.ok ? 'info' : 'error');
      });
    },
  }), [
    detached,
    effectiveMediaModelAvailability,
    handleResolveApproval,
    mediaModelOptions,
    showToast,
    scrollToBottom,
  ]);

  const handleAuthorizeLocalFiles = useCallback(() => {
    if (!effectiveActiveConversationId) return;
    if (detached) {
      void emitAction({
        type: 'authorize_local_files',
        conversationId: effectiveActiveConversationId,
      });
      return;
    }
    void authorizeConversationFiles(effectiveActiveConversationId)
      .then((created) => {
        showToast(
          created.length > 0 ? `已授权 ${created.length} 个文件` : '未新增文件授权',
          'info',
        );
      })
      .catch((error) => showToast(
        error instanceof Error ? error.message : '文件授权失败',
        'error',
      ));
  }, [detached, effectiveActiveConversationId, showToast]);

  const handleRevokeLocalFile = useCallback((grantId: string) => {
    if (!effectiveActiveConversationId) return;
    if (detached) {
      void emitAction({
        type: 'revoke_local_file',
        conversationId: effectiveActiveConversationId,
        grantId,
      });
      return;
    }
    revokeFileGrant(effectiveActiveConversationId, grantId);
  }, [detached, effectiveActiveConversationId]);

  // ── 发送消息 ──
  const sendMessageText = useCallback((content: string, dispatchMode: 'queue' | 'interject' = 'queue') => {
    const text = content.trim();
    if (!text || !effectiveActiveConversationId) return;

    if (detached) {
      void emitAction({
        type: 'send_message',
        content: text,
        conversationId: effectiveActiveConversationId,
        dispatchMode,
      });
      updateInputDraft('');
      return;
    }

    if (
      dispatchMode === 'interject'
      && tryInterjectConversationMessage(effectiveActiveConversationId, text)
    ) {
      updateInputDraft('');
      scrollToBottom();
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
    updateInputDraft('');

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
    detached,
    effectiveActiveConversationId,
    effectiveAgentMode,
    effectiveProjectId,
    addMessage,
    scrollToBottom,
    updateInputDraft,
  ]);

  const handleSend = useCallback(() => {
    sendMessageText(inputValue);
  }, [inputValue, sendMessageText]);

  const handleInterject = useCallback(() => {
    sendMessageText(inputValue, 'interject');
  }, [inputValue, sendMessageText]);

  const handleEditMessage = useCallback((content: string) => {
    updateInputDraft(content);
    window.dispatchEvent(new CustomEvent('chat-focus-composer'));
  }, [updateInputDraft]);

  const handleRegenerateMessage = useCallback((content: string) => {
    sendMessageText(content);
  }, [sendMessageText]);

  const handleNodeActivate = useCallback((nodeId: string) => {
    if (detached) {
      void emitAction({ type: 'focus_node', nodeId });
      return;
    }
    const nodeExists = useAppStore.getState().nodes.some((node) => node.id === nodeId);
    if (!nodeExists) {
      showToast('引用的节点已不存在', 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } }));
  }, [detached, showToast]);

  const handleNodeHover = useCallback((nodeId: string | null) => {
    if (detached) {
      void emitAction({ type: 'set_hovered_node', nodeId });
      return;
    }
    useAppStore.getState().setHoveredMentionNodeId(nodeId);
  }, [detached]);

  const handleModelActivate = useCallback((modelId: string) => {
    window.dispatchEvent(new CustomEvent('chat-open-reference-menu', {
      detail: { kind: 'model', modelId },
    }));
  }, []);

  // ── 状态同步到独立窗口：限频 + 单飞 + 最新状态合并 ──
  const chatSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatSyncInFlightRef = useRef(false);
  const chatSyncPendingRef = useRef(false);
  const chatSyncImmediateRef = useRef(false);
  const chatSyncDisposedRef = useRef(false);
  const chatSyncLastStartedAtRef = useRef(0);
  const chatSyncLastSnapshotRef = useRef<ChatStateSnapshot | null>(null);
  const chatSyncRevisionRef = useRef(0);
  const chatSyncForceSnapshotRef = useRef(false);

  const emitLatestChatWindowSnapshot = useCallback(async function emitLatestSnapshot() {
    chatSyncTimerRef.current = null;
    if (chatSyncDisposedRef.current || chatSyncInFlightRef.current || !chatSyncPendingRef.current) return;

    const state = useAppStore.getState();
    if (!state.chatPanelDetached) {
      chatSyncPendingRef.current = false;
      chatSyncImmediateRef.current = false;
      return;
    }

    chatSyncPendingRef.current = false;
    chatSyncImmediateRef.current = false;
    chatSyncInFlightRef.current = true;
    chatSyncLastStartedAtRef.current = performance.now();

    try {
      const nextSnapshot = buildDetachedChatSnapshot(state);
      const previousSnapshot = chatSyncLastSnapshotRef.current;
      const forceSnapshot = chatSyncForceSnapshotRef.current || !previousSnapshot;

      if (!forceSnapshot) {
        const patch = createChatStatePatch(previousSnapshot, nextSnapshot);
        chatSyncLastSnapshotRef.current = nextSnapshot;
        if (!hasChatStatePatchChanges(patch)) return;

        const baseRevision = chatSyncRevisionRef.current;
        const revision = baseRevision + 1;
        chatSyncRevisionRef.current = revision;
        await emitSyncState({ type: 'patch', baseRevision, revision, patch });
        return;
      }

      chatSyncForceSnapshotRef.current = false;
      chatSyncLastSnapshotRef.current = nextSnapshot;
      const revision = chatSyncRevisionRef.current + 1;
      chatSyncRevisionRef.current = revision;
      await emitSyncState({ type: 'snapshot', revision, snapshot: nextSnapshot });
    } finally {
      chatSyncInFlightRef.current = false;
      if (!chatSyncDisposedRef.current && chatSyncPendingRef.current) {
        const elapsed = performance.now() - chatSyncLastStartedAtRef.current;
        const delay = chatSyncImmediateRef.current
          ? 0
          : Math.max(0, DETACHED_CHAT_SYNC_INTERVAL_MS - elapsed);
        chatSyncTimerRef.current = setTimeout(() => {
          void emitLatestSnapshot();
        }, delay);
      }
    }
  }, []);

  const syncToChatWindow = useCallback((immediate = false, forceSnapshot = false) => {
    if (!isTauri) return;
    const state = useAppStore.getState();
    if (!state.chatPanelDetached) return;

    chatSyncPendingRef.current = true;
    if (immediate) chatSyncImmediateRef.current = true;
    if (forceSnapshot) chatSyncForceSnapshotRef.current = true;

    if (chatSyncTimerRef.current) {
      if (!immediate) return;
      clearTimeout(chatSyncTimerRef.current);
      chatSyncTimerRef.current = null;
    }
    if (chatSyncInFlightRef.current) return;

    const elapsed = performance.now() - chatSyncLastStartedAtRef.current;
    const delay = immediate ? 0 : Math.max(0, DETACHED_CHAT_SYNC_INTERVAL_MS - elapsed);
    if (delay === 0) {
      void emitLatestChatWindowSnapshot();
      return;
    }
    chatSyncTimerRef.current = setTimeout(() => {
      void emitLatestChatWindowSnapshot();
    }, delay);
  }, [emitLatestChatWindowSnapshot]);

  useEffect(() => {
    chatSyncDisposedRef.current = false;
    return () => {
      chatSyncDisposedRef.current = true;
      chatSyncPendingRef.current = false;
      chatSyncImmediateRef.current = false;
      chatSyncForceSnapshotRef.current = false;
      chatSyncLastSnapshotRef.current = null;
      chatSyncRevisionRef.current = 0;
      if (chatSyncTimerRef.current) clearTimeout(chatSyncTimerRef.current);
      chatSyncTimerRef.current = null;
    };
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
              if (
                action.dispatchMode === 'interject'
                && tryInterjectConversationMessage(action.conversationId, action.content)
              ) {
                break;
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
              clearConversationFileGrants(action.conversationId);
              store.updateConversation(action.conversationId, { deletedAt: Date.now() });
              store.removeConversation(action.conversationId);
              break;

            case 'authorize_local_files':
              void authorizeConversationFiles(action.conversationId)
                .then((created) => {
                  store.showToast(
                    created.length > 0 ? `已授权 ${created.length} 个文件` : '未新增文件授权',
                    'info',
                  );
                })
                .catch((error) => store.showToast(
                  error instanceof Error ? error.message : '文件授权失败',
                  'error',
                ));
              break;

            case 'revoke_local_file':
              revokeFileGrant(action.conversationId, action.grantId);
              break;

            case 'set_agent_mode':
              store.updateConversation(action.conversationId, { agentMode: action.mode });
              store.showToast(getAgentModeToast(action.mode), 'info');
              break;

            case 'resolve_agent_approval':
              if (!resolveAgentApproval(action.approvalId, action.resolution)) {
                store.showToast('该确认已过期，请重新发起操作', 'info');
                break;
              }
              markApprovalMessageExecuting(action.approvalId);
              break;

            case 'pause_agent_task':
              cancelScheduledAgentExecution(action.taskId);
              pauseAgentTask(action.taskId);
              break;

            case 'resume_agent_task': {
              const result = resumeAgentTaskExecution(action.taskId);
              if (!result.ok) store.showToast(result.message ?? '无法继续该任务', 'error');
              break;
            }

            case 'stop_agent_task':
              cancelScheduledAgentExecution(action.taskId);
              stopAgentTask(action.taskId);
              break;

            case 'skip_agent_step':
              try {
                skipAgentStep(action.taskId, action.stepId);
              } catch {
                store.showToast('该步骤已无法跳过', 'error');
              }
              break;

            case 'replan_agent_task':
              requestAgentReplan(action.taskId);
              resumeAgentTaskExecution(action.taskId);
              break;

            case 'rewind_agent_task':
              void rewindAgentTaskCanvas(action.taskId).then((result) => {
                store.showToast(result.ok ? '已回退该任务的画布修改' : (result.message ?? '无法回退任务'), result.ok ? 'info' : 'error');
              });
              break;

            case 'select_model': {
              const cfg: Record<string, string | undefined> = {};
              const c = action.category || 'text';
              if (c === 'image') cfg.assistantImageModelId = action.modelId;
              else if (c === 'video') cfg.assistantVideoModelId = action.modelId;
              else cfg.assistantModelId = action.modelId;
              store.updateConfig(cfg);
              void store.saveConfig({ silent: true });
              break;
            }

            case 'focus_node': {
              const nodeExists = store.nodes.some((node) => node.id === action.nodeId);
              if (!nodeExists) {
                store.showToast('引用的节点已不存在', 'error');
                break;
              }
              window.dispatchEvent(new CustomEvent('canvas-focus-node', {
                detail: { nodeId: action.nodeId },
              }));
              break;
            }

            case 'set_hovered_node':
              store.setHoveredMentionNodeId(action.nodeId);
              break;

            case 'request_sync':
              syncToChatWindow(true, true);
              break;
          }
        },
        () => {
          const store = useAppStore.getState();
          store.setHoveredMentionNodeId(null);
          store.setChatPanelDetached(false);
          store.openChat();
        },
      );
    })();

    return () => { cleanup?.(); };
  }, [detached, syncToChatWindow]);

  const chatWindowWasDetachedRef = useRef(false);
  useEffect(() => {
    const wasDetached = chatWindowWasDetachedRef.current;
    chatWindowWasDetachedRef.current = !detached && chatPanelDetached;
    if (!detached && chatPanelDetached) {
      syncToChatWindow(!wasDetached, !wasDetached);
      return;
    }
    chatSyncPendingRef.current = false;
    chatSyncImmediateRef.current = false;
    chatSyncForceSnapshotRef.current = false;
    chatSyncLastSnapshotRef.current = null;
    chatSyncRevisionRef.current = 0;
    if (chatSyncTimerRef.current) clearTimeout(chatSyncTimerRef.current);
    chatSyncTimerRef.current = null;
  }, [
    detached,
    messages,
    conversations,
    agentTasks,
    activeConversationId,
    chatPanelDetached,
    currentProjectId,
    currentProjectName,
    generalModels,
    providers,
    dreaminaLoggedIn,
    assistantModelId,
    assistantImageModelId,
    assistantVideoModelId,
    fileGrantVersion,
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
      } catch (e) {
        console.error('[ChatPanel] failed to open chat window:', e);
        showToast('打开独立窗口失败', 'error');
      }
    }
  }, [chatPanelDetached, setChatPanelDetached, showToast]);

  // ── 空状态判断 ──
  const showEmptyState = !effectiveActiveConversationId && viewMode === 'chat';

  // ── 渲染 ──
  return (
    <AnimatePresence>
      {(detached || (chatOpen && !chatPanelDetached)) && (
          <motion.aside
            className={`chat-panel-root ${detached
              ? 'chat-panel-detached h-screen w-screen flex flex-col overflow-hidden rounded-[16px] border border-canvas-border bg-[var(--glass-panel-bg)] text-canvas-text backdrop-blur-2xl'
              : 'chat-panel fixed z-50 flex flex-col'}`}
            initial={detached
              ? false
              : reduceMotion
                ? { opacity: 0 }
                : { x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={detached
              ? undefined
              : reduceMotion
                ? { opacity: 0 }
                : { x: '100%', opacity: 0 }}
            transition={reduceMotion
              ? { duration: 0.12 }
              : { type: 'spring', visualDuration: 0.35, bounce: 0 }}
          >
            {/* Header */}
            <ChatHeader
              detached={detached}
              chatPanelDetached={chatPanelDetached}
              projectName={effectiveProjectName}
              agentMode={effectiveAgentMode}
              onAgentModeChange={handleAgentModeChange}
              agentModeDisabled={!effectiveActiveConversationId}
              onOpenMemory={!detached && effectiveProjectId
                ? () => setShowMemoryPanel(true)
                : undefined}
              onOpenTasks={() => setShowTaskCenter(true)}
              activeTaskCount={effectiveAgentTasks.filter((task) =>
                !['completed', 'failed', 'stopped'].includes(task.status)).length}
              showBackButton={viewMode === 'chat' && !!effectiveActiveConversationId}
              onBack={handleShowList}
              onDetachToggle={handleDetachToggle}
              onClose={closeChat}
              detachedHeaderActions={detachedHeaderActions}
            />

            {/* Body: dual-pane layout */}
            <div className="chat-panel-body flex flex-1 min-h-0">
              {showTaskCenter ? (
                <AgentTaskCenter
                  tasks={effectiveAgentTasks.filter((task) => task.projectId === effectiveProjectId)}
                  conversations={effectiveConversations}
                  onClose={() => setShowTaskCenter(false)}
                  {...agentControls}
                />
              ) : (
                <>
              {/* Conversation list pane */}
              {viewMode === 'list' && (
                <motion.div
                  initial={reduceMotion ? { opacity: 0 } : { x: -12, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={reduceMotion
                    ? { duration: 0.12 }
                    : { type: 'spring', visualDuration: 0.24, bounce: 0 }}
                  className="chat-panel-conversation-list flex-shrink-0 w-full overflow-hidden"
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
                  initial={reduceMotion ? { opacity: 0 } : { x: 12, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={reduceMotion
                    ? { duration: 0.12 }
                    : { type: 'spring', visualDuration: 0.24, bounce: 0 }}
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
                    onExampleClick={handleExampleClick}
                    onAddMediaToCanvas={detached ? undefined : handleAddMediaToCanvas}
                    onEditMessage={handleEditMessage}
                    onRegenerateMessage={handleRegenerateMessage}
                    onNodeActivate={handleNodeActivate}
                    onNodeHover={handleNodeHover}
                    onModelActivate={handleModelActivate}
                    agentControls={agentControls}
                  />

                  {/* Input area */}
                  {!showEmptyState && (
                    <ChatInput
                      assistantModelId={effectiveAssistantModelId}
                      onAssistantModelChange={handleTextModelChange}
                      mediaModels={effectiveGeneralModels}
                      mediaModelOptions={mediaModelOptions}
                      mediaModelAvailability={effectiveMediaModelAvailability}
                      inputValue={inputValue}
                      onInputChange={updateInputDraft}
                      onSend={handleSend}
                      hasActiveTask={hasActiveConversationTask}
                      onInterject={handleInterject}
                      localFileGrants={effectiveLocalFileGrants}
                      onAuthorizeLocalFiles={handleAuthorizeLocalFiles}
                      onRevokeLocalFile={handleRevokeLocalFile}
                      contextUsage={contextUsage}
                    />
                  )}
                </motion.div>
              )}
                </>
              )}
            </div>

            {/* 项目记忆管理面板（主窗口） */}
            {showMemoryPanel && !detached && (
              <ProjectMemoryPanel
                memories={currentProjectMemories}
                onUpdate={updateProjectMemory}
                onDelete={removeProjectMemory}
                onClose={() => setShowMemoryPanel(false)}
              />
            )}
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

function getAgentModeToast(mode: AgentMode): string {
  if (mode === 'plan') return '已切换到 Plan 模式：仅分析与规划，不执行任何写操作';
  if (mode === 'autonomous') {
    return '已切换到 C 自主模式：画布操作可自动执行，付费媒体和文件写入仍需确认';
  }
  return '已切换到 B 协作模式：画布写操作将先预览确认';
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
  let taskId: string | undefined;

  try {
    ensureAgentToolsRegistered();
    const task = store.createAgentTask({
      projectId,
      conversationId,
      userMessageId,
      mode,
      goal: text,
      toolAllowlist: resolveSkillToolAllowlist(text, store.userSkills),
    });
    taskId = task.id;
    store.updateMessage(assistantMessageId, { agentTaskId: task.id });
    scheduleAgentTaskExecution(task.id, assistantMessageId, onProgress);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    if (taskId) {
      try {
        stopAgentTask(taskId);
        store.updateAgentTask(taskId, {
          errorCode: 'AGENT_START_FAILED',
          errorMessage,
        });
      } catch (stopError) {
        console.error('[AgentBootstrap] failed to stop incomplete task:', stopError);
      }
    }
    store.updateMessage(assistantMessageId, {
      content: `处理失败: ${errorMessage}`,
      status: 'error',
      finishReason: 'error',
    });
    onProgress?.();
    console.error('[AgentBootstrap] failed to start chat task:', error);
  }
}

function scheduleAgentTaskExecution(
  taskId: string,
  assistantMessageId: string,
  onProgress?: () => void,
  resume = false,
): void {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task) return;
  const scheduled = scheduleConversationAgentExecution({
    taskId,
    conversationId: task.conversationId,
    onStart: () => {
      const store = useAppStore.getState();
      if (resume) prepareAgentTaskResume(taskId);
      const message = store.messages.find((item) => item.id === assistantMessageId);
      if (message && message.status === 'queued') {
        store.updateMessage(assistantMessageId, {
          status: resolveAssistantModel() ? 'streaming' : 'parsing',
        });
      }
    },
    run: () => driveAgentTask(taskId, assistantMessageId, onProgress),
    onError: (error) => {
      console.error('[AgentScheduler] failed to execute chat task:', error);
    },
  });
  if (scheduled.state === 'queued') {
    useAppStore.getState().updateMessage(assistantMessageId, { status: 'queued' });
  }
}

/**
 * 继续执行一个暂停或失败的 Agent 任务（P3-E2）。
 *
 * 继续前重新校验项目、会话和任务状态；预算已耗尽时按默认额度追加。
 * 画布 revision 由写工具在每轮执行前按当前值复核，避免恢复后重复副作用。
 */
function resumeAgentTaskExecution(taskId: string, onProgress?: () => void): AgentResumeValidation {
  const validation = validateTaskResumable(taskId);
  if (!validation.ok) return validation;

  const store = useAppStore.getState();
  const task = store.agentTasks.find((item) => item.id === taskId)!;
  const message = store.messages.find(
    (item) => item.agentTaskId === taskId && item.role === 'assistant',
  );
  if (!message) {
    return { ok: false, errorCode: 'AGENT_RESUME_NO_MESSAGE', message: '找不到对应的助手消息，无法继续' };
  }

  const nextBudget = { ...task.budget };
  if (task.modelRounds >= task.budget.maxModelRounds) {
    nextBudget.maxModelRounds = task.modelRounds + DEFAULT_AGENT_TASK_BUDGET.maxModelRounds;
  }
  if (task.toolCallCount >= task.budget.maxToolCalls) {
    nextBudget.maxToolCalls = task.toolCallCount + DEFAULT_AGENT_TASK_BUDGET.maxToolCalls;
  }
  store.updateAgentTask(taskId, { budget: nextBudget });
  scheduleAgentTaskExecution(taskId, message.id, onProgress, true);
  return { ok: true };
}

/**
 * 驱动指定任务的多轮循环。start 与 resume 共用；所有输入从任务快照读取，
 * 因此关闭面板、切换会话后仍可继续，且不依赖发起时的闭包。
 */
function driveAgentTask(
  taskId: string,
  assistantMessageId: string,
  onProgress?: () => void,
): Promise<void> {
  const store = useAppStore.getState();
  ensureAgentToolsRegistered();
  const task = store.agentTasks.find((item) => item.id === taskId);
  if (!task) return Promise.resolve();
  const { projectId, conversationId, userMessageId, goal: text } = task;
  const mode = store.conversations.find((c) => c.id === conversationId)?.agentMode ?? task.mode;

  return runAgentTask(taskId, async (signal) => {
    let failed = false;

    if (resolveAssistantModel()) {
      const streamingMessage = createStreamingMessageBuffer(assistantMessageId, onProgress);
      const availableTools = getAvailableAgentTools({
        taskId,
        projectId,
        conversationId,
        mode,
        toolAllowlist: task.toolAllowlist,
      });
      if (
        availableTools.length > 0
        || mode === 'plan'
        || task.toolAllowlist !== undefined
      ) {
        return runAgentLoop({
          taskId,
          systemPrompt: buildAssistantSystemPrompt({ agentTools: true }),
          userMessage: expandSkillReferences(text, store.userSkills),
          excludeMessageIds: [userMessageId, assistantMessageId],
          signal,
          callbacks: {
            onTextDelta: streamingMessage.append,
            onComplete: (fullText) => {
              streamingMessage.cancel();
              useAppStore.getState().updateMessage(assistantMessageId, {
                content: fullText,
                status: 'done',
              });
              onProgress?.();
            },
            onApprovalRequired: (step) => {
              streamingMessage.flush();
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
              const message = currentStore.messages.find((item) => item.id === assistantMessageId);
              const sources = [...(message?.sources ?? [])];
              for (const source of result.sources) {
                if (!sources.some((item) => item.url === source.url)) sources.push(source);
              }
              currentStore.updateMessage(assistantMessageId, { sources });
              onProgress?.();
            },
            onError: (error) => {
              streamingMessage.cancel();
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
        onTextDelta: streamingMessage.append,
        onComplete: (fullText, results) => {
          streamingMessage.cancel();
          useAppStore.getState().updateMessage(assistantMessageId, {
            content: fullText,
            status: 'done',
            executionResults: results.length > 0 ? results : undefined,
          });
          onProgress?.();
        },
        onError: (error) => {
          streamingMessage.cancel();
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

    if (mode === 'plan' || task.toolAllowlist !== undefined) {
      useAppStore.getState().updateMessage(assistantMessageId, {
        content: mode === 'plan'
          ? 'Plan 模式需要配置文本模型后才能生成分析与规划；未执行任何写操作。'
          : '该 Skill 声明了工具限制，需要配置文本模型后才能安全执行；未执行任何操作。',
        status: 'done',
      });
      onProgress?.();
      return 'completed';
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
  }).then(() => undefined).catch((error) => {
    console.error('[AgentRuntime] failed to execute chat task:', error);
  });
}

function tryInterjectConversationMessage(conversationId: string, content: string): boolean {
  const taskId = getActiveConversationAgentTaskId(conversationId);
  if (!taskId || !enqueueAgentInterjection(taskId, content)) return false;
  useAppStore.getState().addMessage({
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    conversationId,
    role: 'user',
    content,
    timestamp: Date.now(),
    status: 'done',
    agentTaskId: taskId,
  });
  return true;
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
