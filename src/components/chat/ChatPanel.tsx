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
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store/useAppStore';
import { seriesOwnerId } from '../../store/store.utils';
import ConversationList from './ConversationList';
import ChatHeader from './ChatHeader';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import ProjectMemoryPanel from './ProjectMemoryPanel';
import SubAgentPanel from './SubAgentPanel';
import AgentCenterPanel from './AgentCenterPanel';
import AgentTaskCenter from './AgentTaskCenter';
import {
  emitAction,
  emitCloseChatWindow,
  type ChatStateSnapshot,
} from '../../services/chat/chatWindowService';
import {
  pauseAgentTask,
  stopAgentTask,
  skipAgentStep,
  requestAgentReplan,
} from '../../services/chat/agentRuntime';
import {
  cancelScheduledAgentExecution,
} from '../../services/chat/agentScheduler';
import { rewindAgentTaskCanvas } from '../../services/chat/agentRewindService';
import { retryMediaArtifactPersist } from '../../services/ai/generationRuntime';
import { estimateConversationUsage } from '../../services/chat/contextManager';
import {
  getAgentModeToast,
  resolveConversationAgentApproval,
  resumeAgentTaskExecution,
  submitConversationMessage,
} from '../../services/chat/conversationExecutionController';
import {
  createDetachedChatSyncController,
  getMediaModelAvailability,
} from '../../services/chat/detachedChatSyncController';
import type { AgentApprovalResolution, AgentMode } from '../../types/agent';
import {
  getMediaModelOptions,
} from '../nodes/shared/defaultModels';
import {
  authorizeConversationFiles,
  listConversationFileGrants,
  revokeFileGrant,
  subscribeFileGrants,
} from '../../services/chat/fileGrantService';
import { getAssistantTextModelCandidates } from '../../services/projectSettingsService';
import { useT } from '../../i18n';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const DRAFT_SYNC_DEBOUNCE_MS = 300;
const CHAT_PANEL_DEFAULT_WIDTH = 400;
const CHAT_PANEL_MIN_WIDTH = 320;
const CHAT_PANEL_MAX_WIDTH = 720;
const CHAT_PANEL_VIEWPORT_GUTTER = 64;

interface ChatPanelResizeGesture {
  pointerId: number;
  startX: number;
  startWidth: number;
}

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
  const t = useT();
  const reduceMotion = useReducedMotion();
  const {
    chatOpen,
    chatPanelDetached,
    chatComposerDraft,
    closeChat,
    clearChatComposerDraft,
    setChatPanelDetached,
    activeConversationId,
    conversations,
    messages,
    agentTasks,
    currentProjectId,
    projects,
    createConversation,
    setActiveConversation,
    updateConversation,
    loadConversationMessages,
    showToast,
    assistantModelId,
    generalModels,
    providers,
    dreaminaLoggedIn,
    workflows,
    updateConfig,
    saveConfig,
    updateProjectSettings,
    projectMemories,
    updateProjectMemory,
    removeProjectMemory,
  } = useAppStore(
    useShallow((s) => ({
      chatOpen: s.chatOpen,
      chatPanelDetached: s.chatPanelDetached,
      chatComposerDraft: s.chatComposerDraft,
      closeChat: s.closeChat,
      clearChatComposerDraft: s.clearChatComposerDraft,
      setChatPanelDetached: s.setChatPanelDetached,
      activeConversationId: s.activeConversationId,
      conversations: s.conversations,
      messages: s.messages,
      agentTasks: s.agentTasks,
      currentProjectId: s.currentProjectId,
      projects: s.projects,
      createConversation: s.createConversation,
      setActiveConversation: s.setActiveConversation,
      updateConversation: s.updateConversation,
      loadConversationMessages: s.loadConversationMessages,
      showToast: s.showToast,
      assistantModelId: s.config.assistantModelId,
      generalModels: s.config.generalModels ?? [],
      providers: s.config.providers,
      dreaminaLoggedIn: !!s.config.dreaminaAuth?.loggedIn,
      workflows: s.workflows,
      updateConfig: s.updateConfig,
      saveConfig: s.saveConfig,
      updateProjectSettings: s.updateProjectSettings,
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
  const currentProject = projects.find((item) => item.id === currentProjectId);
  const projectAssistantModelId = getAssistantTextModelCandidates(
    currentProject?.settings,
    assistantModelId,
  )[0];
  const effectiveAssistantModelId = detached
    ? detachedSnapshot?.assistantModelId
    : projectAssistantModelId;
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
        // 独立窗口拿不到工作流正文，ComfyUI 工作流只在主窗口列出
        detached ? [] : workflows,
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
      workflows,
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
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(false);
  const [showAgentCenter, setShowAgentCenter] = useState(false);
  const [showTaskCenter, setShowTaskCenter] = useState(false);
  const chatPanelRef = useRef<HTMLElement | null>(null);
  const preferredChatPanelWidthRef = useRef(CHAT_PANEL_DEFAULT_WIDTH);
  const chatPanelWidthInitializedRef = useRef(false);
  const chatPanelResizeGestureRef = useRef<ChatPanelResizeGesture | null>(null);

  const applyDockedChatPanelWidth = useCallback((preferredWidth: number) => {
    const shell = chatPanelRef.current?.closest<HTMLElement>('.app-shell');
    if (!shell) return;

    const viewportMaxWidth = Math.max(0, window.innerWidth - CHAT_PANEL_VIEWPORT_GUTTER);
    const minWidth = Math.min(CHAT_PANEL_MIN_WIDTH, viewportMaxWidth);
    const maxWidth = Math.max(minWidth, Math.min(CHAT_PANEL_MAX_WIDTH, viewportMaxWidth));
    const width = Math.min(maxWidth, Math.max(minWidth, preferredWidth));
    shell.style.setProperty('--chat-panel-width', `${Math.round(width)}px`);
  }, []);

  useEffect(() => {
    if (detached || !chatOpen || chatPanelDetached) return;
    const panel = chatPanelRef.current;
    if (!panel) return;

    const renderedWidth = panel.getBoundingClientRect().width;
    if (!chatPanelWidthInitializedRef.current
      && Number.isFinite(renderedWidth)
      && renderedWidth > 0) {
      preferredChatPanelWidthRef.current = Math.min(
        CHAT_PANEL_MAX_WIDTH,
        Math.max(CHAT_PANEL_MIN_WIDTH, renderedWidth),
      );
      chatPanelWidthInitializedRef.current = true;
    }

    const syncWidthToViewport = () => {
      applyDockedChatPanelWidth(preferredChatPanelWidthRef.current);
    };
    syncWidthToViewport();
    window.addEventListener('resize', syncWidthToViewport);
    return () => window.removeEventListener('resize', syncWidthToViewport);
  }, [applyDockedChatPanelWidth, chatOpen, chatPanelDetached, detached]);

  useEffect(() => () => {
    chatPanelResizeGestureRef.current = null;
    document.body.classList.remove('chat-panel-resizing');
  }, []);

  const handleChatPanelResizePointerDown = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (detached || event.button !== 0) return;
    const panel = chatPanelRef.current;
    if (!panel) return;

    chatPanelResizeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('chat-panel-resizing');
    event.preventDefault();
  }, [detached]);

  const handleChatPanelResizePointerMove = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const gesture = chatPanelResizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const preferredWidth = Math.min(
      CHAT_PANEL_MAX_WIDTH,
      Math.max(
        CHAT_PANEL_MIN_WIDTH,
        gesture.startWidth + gesture.startX - event.clientX,
      ),
    );
    preferredChatPanelWidthRef.current = preferredWidth;
    applyDockedChatPanelWidth(preferredWidth);
  }, [applyDockedChatPanelWidth]);

  const handleChatPanelResizePointerEnd = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const gesture = chatPanelResizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    chatPanelResizeGestureRef.current = null;
    document.body.classList.remove('chat-panel-resizing');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  // 记忆挂在剧集项目上，分集画布要按归属项目取
  const memoryOwnerId = useAppStore((s) => (
    effectiveProjectId ? seriesOwnerId(s.projects, effectiveProjectId) : null
  ));
  const currentProjectMemories = memoryOwnerId
    ? projectMemories.filter((memory) => memory.projectId === memoryOwnerId)
    : [];
  const [, setFileGrantVersion] = useState(0);
  useEffect(() => subscribeFileGrants(
    () => setFileGrantVersion((version) => version + 1),
  ), []);
  const effectiveLocalFileGrants = detached
    ? (detachedSnapshot?.localFileGrants ?? [])
    : effectiveActiveConversationId
      ? listConversationFileGrants(effectiveActiveConversationId)
      : [];

  // 草稿只在切换窗口时用得上，逐键写 Store / 发 IPC 是白扔的开销，防抖到停手后再同步一次
  const draftSyncRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    value: string | null;
  }>({ timer: null, value: null });

  const flushDraftSync = useCallback(() => {
    const pending = draftSyncRef.current;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.value == null) return;
    const value = pending.value;
    pending.value = null;
    if (detached) void emitAction({ type: 'set_composer_draft', draft: value });
    else useAppStore.getState().setChatComposerLiveDraft(value);
  }, [detached]);

  const queueDraftSync = useCallback((value: string) => {
    const pending = draftSyncRef.current;
    pending.value = value;
    if (pending.timer) return;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      flushDraftSync();
    }, DRAFT_SYNC_DEBOUNCE_MS);
  }, [flushDraftSync]);

  // 关窗时 React 的清理未必来得及跑，beforeunload 兜住独立窗口这一侧
  useEffect(() => {
    window.addEventListener('beforeunload', flushDraftSync);
    return () => {
      window.removeEventListener('beforeunload', flushDraftSync);
      flushDraftSync();
    };
  }, [flushDraftSync]);

  const updateInputDraft = useCallback((value: string) => {
    setInputValue(value);
    queueDraftSync(value);
    if (!effectiveActiveConversationId) return;
    if (value) conversationDraftsRef.current.set(effectiveActiveConversationId, value);
    else conversationDraftsRef.current.delete(effectiveActiveConversationId);
  }, [effectiveActiveConversationId, queueDraftSync]);

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

  // 面板接管时把对方留下的草稿灌一次（独立窗口首帧 / 收回内嵌），之后各自本地编辑
  const draftHandoffRef = useRef(false);
  useEffect(() => {
    const owning = detached ? detachedInitialized : !chatPanelDetached;
    if (!owning) {
      draftHandoffRef.current = false;
      return;
    }
    if (draftHandoffRef.current) return;
    draftHandoffRef.current = true;
    const draft = detached
      ? (detachedSnapshot?.composerDraft ?? '')
      : useAppStore.getState().chatComposerLiveDraft;
    if (!draft) return;
    // 灌草稿是一次性跨面板同步，放到下一帧异步执行，避免在 effect 内同步 setState 引发级联渲染
    const frame = requestAnimationFrame(() => updateInputDraft(draft));
    return () => cancelAnimationFrame(frame);
  }, [
    chatPanelDetached,
    detached,
    detachedInitialized,
    detachedSnapshot?.composerDraft,
    updateInputDraft,
  ]);

  const handleTextModelChange = useCallback((modelId?: string) => {
    if (detached) {
      void emitAction({ type: 'select_model', modelId, category: 'text' });
    } else if (currentProject) {
      void updateProjectSettings({
        ...currentProject.settings,
        defaultModels: {
          ...currentProject.settings?.defaultModels,
          text: modelId,
        },
      });
    } else {
      updateConfig({ assistantModelId: modelId });
      void saveConfig({ silent: true });
    }
  }, [currentProject, detached, saveConfig, updateConfig, updateProjectSettings]);

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
    const effectiveGeneralModelId = effectiveAssistantModelId?.replace(/^general\//, '');
    const model = effectiveGeneralModels.find(
      (item) => item.id === effectiveGeneralModelId && item.category === 'text',
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

  useEffect(() => {
    if (detached || !chatComposerDraft || !effectiveProjectId) return;
    let focusFrame = 0;
    const draftFrame = requestAnimationFrame(() => {
      handleExampleClick(chatComposerDraft);
      clearChatComposerDraft();
      focusFrame = requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('chat-focus-composer'));
      });
    });
    return () => {
      cancelAnimationFrame(draftFrame);
      if (focusFrame) cancelAnimationFrame(focusFrame);
    };
  }, [
    chatComposerDraft,
    clearChatComposerDraft,
    detached,
    effectiveProjectId,
    handleExampleClick,
  ]);

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
      store.showToast(t('已添加到画布'));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('添加节点失败');
      store.updateMessage(messageId, { canvasStatus: 'failed', canvasError: errorMessage });
      store.showToast(errorMessage, 'error');
    }
  }, [detached, t]);

  /** 落盘失败的产物重新下载保存，成功后同步刷新已派生的画布节点。 */
  const handleRetryMediaSave = useCallback(async (messageId: string) => {
    if (detached) return;
    const store = useAppStore.getState();
    const message = store.messages.find((item) => item.id === messageId);
    if (!message?.mediaResult) return;

    try {
      const artifact = await retryMediaArtifactPersist(
        message.mediaResult,
        store.currentProjectId,
      );
      const currentStore = useAppStore.getState();
      currentStore.updateMessage(messageId, { mediaResult: artifact });
      if (message.canvasNodeId) {
        currentStore.settleMediaPlaceholder(message.canvasNodeId, artifact);
      }
      currentStore.showToast(t('产物已保存到项目'));
    } catch (error) {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : t('保存失败'),
        'error',
      );
    }
  }, [detached, t]);

  const handleResolveApproval = useCallback((
    approvalId: string,
    resolution: AgentApprovalResolution,
  ) => {
    if (detached) {
      void emitAction({ type: 'resolve_agent_approval', approvalId, resolution });
      return;
    }
    if (!resolveConversationAgentApproval(approvalId, resolution)) {
      showToast(t('该确认已过期，请重新发起操作'), 'info');
    }
  }, [detached, showToast, t]);

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
      showToast(t('已暂停任务'), 'info');
    },
    onResume: (taskId: string) => {
      if (detached) { void emitAction({ type: 'resume_agent_task', taskId }); return; }
      const result = resumeAgentTaskExecution(taskId, scrollToBottom);
      showToast(result.ok ? t('已继续任务') : (result.message ?? t('无法继续该任务')), result.ok ? 'info' : 'error');
    },
    onStop: (taskId: string) => {
      if (detached) { void emitAction({ type: 'stop_agent_task', taskId }); return; }
      cancelScheduledAgentExecution(taskId);
      stopAgentTask(taskId);
      showToast(t('已停止任务'), 'info');
    },
    onSkip: (taskId: string, stepId: string) => {
      if (detached) { void emitAction({ type: 'skip_agent_step', taskId, stepId }); return; }
      try {
        skipAgentStep(taskId, stepId);
        showToast(t('已跳过当前步骤，可继续或重新规划'), 'info');
      } catch {
        showToast(t('该步骤已无法跳过'), 'error');
      }
    },
    onReplan: (taskId: string) => {
      if (detached) { void emitAction({ type: 'replan_agent_task', taskId }); return; }
      try {
        // 先撤掉排队中的旧执行项，否则重新规划后它仍会被出队执行一次
        cancelScheduledAgentExecution(taskId);
        requestAgentReplan(taskId);
      } catch {
        showToast(t('该任务当前状态无法重新规划'), 'error');
        return;
      }
      const result = resumeAgentTaskExecution(taskId, scrollToBottom);
      showToast(
        result.ok ? t('正在重新规划任务') : (result.message ?? t('无法重新规划该任务')),
        result.ok ? 'info' : 'error',
      );
    },
    onRewind: (taskId: string) => {
      if (detached) { void emitAction({ type: 'rewind_agent_task', taskId }); return; }
      void rewindAgentTaskCanvas(taskId).then((result) => {
        showToast(result.ok ? t('已回退该任务的画布修改') : (result.message ?? t('无法回退任务')), result.ok ? 'info' : 'error');
      });
    },
  }), [
    detached,
    effectiveMediaModelAvailability,
    handleResolveApproval,
    mediaModelOptions,
    showToast,
    scrollToBottom,
    t,
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
          created.length > 0 ? t('已授权 {count} 个文件', { count: created.length }) : t('未新增文件授权'),
          'info',
        );
      })
      .catch((error) => showToast(
        error instanceof Error ? error.message : t('文件授权失败'),
        'error',
      ));
  }, [detached, effectiveActiveConversationId, showToast, t]);

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

    submitConversationMessage({
      content: text,
      projectId: effectiveProjectId ?? '',
      conversationId: effectiveActiveConversationId,
      mode: effectiveAgentMode,
      dispatchMode,
      onProgress: scrollToBottom,
    });
    updateInputDraft('');
    scrollToBottom();
  }, [
    detached,
    effectiveActiveConversationId,
    effectiveAgentMode,
    effectiveProjectId,
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
      showToast(t('引用的节点已不存在'), 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId } }));
  }, [detached, showToast, t]);

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

  useEffect(() => {
    if (detached) return;
    const controller = createDetachedChatSyncController();
    void controller.start();
    return () => controller.dispose();
  }, [detached]);

  // ── 分离 / 附着 ──
  const handleDetachToggle = useCallback(async () => {
    if (!isTauri) {
      showToast(t('独立窗口功能需要 Tauri 环境'), 'info');
      return;
    }

    if (chatPanelDetached) {
      try {
        await emitCloseChatWindow();
        await invoke('close_chat_window');
      } catch { /* ignore */ }
      setChatPanelDetached(false);
    } else {
      // 必须先置位：独立窗口一加载就会来要快照，而同步器在 detached 为假时会把请求丢掉
      flushDraftSync();
      setChatPanelDetached(true);
      try {
        await invoke('open_chat_window');
      } catch (e) {
        setChatPanelDetached(false);
        console.error('[ChatPanel] failed to open chat window:', e);
        showToast(t('打开独立窗口失败'), 'error');
      }
    }
  }, [chatPanelDetached, flushDraftSync, setChatPanelDetached, showToast, t]);

  // ── 空状态判断 ──
  const showEmptyState = !effectiveActiveConversationId && viewMode === 'chat';

  // ── 渲染 ──
  return (
    <AnimatePresence>
      {(detached || (chatOpen && !chatPanelDetached)) && (
          <motion.aside
            ref={chatPanelRef}
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
            {!detached && (
              <div
                aria-hidden="true"
                className="chat-panel-resize-handle"
                onPointerDown={handleChatPanelResizePointerDown}
                onPointerMove={handleChatPanelResizePointerMove}
                onPointerUp={handleChatPanelResizePointerEnd}
                onPointerCancel={handleChatPanelResizePointerEnd}
                onLostPointerCapture={handleChatPanelResizePointerEnd}
              />
            )}
            {/* Header */}
            <ChatHeader
              detached={detached}
              chatPanelDetached={chatPanelDetached}
              projectName={effectiveProjectName}
              agentMode={effectiveAgentMode}
              onAgentModeChange={handleAgentModeChange}
              agentModeDisabled={!effectiveActiveConversationId}
              onOpenMemory={!detached && effectiveProjectId
                ? () => {
                    setShowAgentCenter(false);
                    setShowSubAgentPanel(false);
                    setShowMemoryPanel(true);
                  }
                : undefined}
              onOpenSubAgents={detached ? undefined : () => {
                setShowAgentCenter(false);
                setShowMemoryPanel(false);
                setShowSubAgentPanel(true);
              }}
              onOpenAgents={detached ? undefined : () => {
                setShowMemoryPanel(false);
                setShowSubAgentPanel(false);
                setShowTaskCenter(false);
                setShowAgentCenter(true);
              }}
              onOpenTasks={() => {
                setShowAgentCenter(false);
                setShowMemoryPanel(false);
                setShowSubAgentPanel(false);
                setShowTaskCenter(true);
              }}
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
                    onOpenAgents={detached ? undefined : () => setShowAgentCenter(true)}
                    onExampleClick={handleExampleClick}
                    onAddMediaToCanvas={detached ? undefined : handleAddMediaToCanvas}
                    onRetryMediaSave={detached ? undefined : handleRetryMediaSave}
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
                      allowSkillUpload={!detached}
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

            {/* 子智能体配置面板（主窗口） */}
            {showSubAgentPanel && !detached && (
              <SubAgentPanel onClose={() => setShowSubAgentPanel(false)} />
            )}

            {showAgentCenter && !detached && (
              <AgentCenterPanel allowInstall onClose={() => setShowAgentCenter(false)} />
            )}
          </motion.aside>
      )}
    </AnimatePresence>
  );
}
