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
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { openDetachedChatWindow } from '../../services/chat/chatWindowLifecycle';
import { useAppStore } from '../../store/useAppStore';
import { projectMemoryOwnerId, seriesOwnerId } from '../../store/store.utils';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../services/chat/assistantScope';
import ConversationList from './ConversationList';
import ChatHeader from './ChatHeader';
import ChatMessages, { type ChatScrollRequest } from './ChatMessages';
import ChatInput from './ChatInput';
import TeamExecutionPicker from '../shared/agentTeams/TeamExecutionPicker';
import CreationProfilePicker from '../shared/creationProfiles/CreationProfilePicker';
import type { CreationProfileChoicePreview, CreationProfileOption, CreationProfileSelection } from '../../types/creationProfile';
import type { ExternalAgentDescriptor } from '../../types/externalAgent';
import { creationProfileOptions, resolveCreationTeamProfile } from '../../services/creationProfiles/creationProfileService';
import { readExternalAgentCatalog } from '../../services/chat/externalAgents/externalAgentService';
import McpConnectionPicker from './McpConnectionPicker';
import { getMcpClientOptions } from '../../services/mcp/mcpClientService';
import { MCP_SETTINGS_CONVERSATION_ID, MCP_SETTINGS_SCOPE_ID } from '../../services/mcp/mcpSettingsScope';
import ProjectMemoryPanel from './ProjectMemoryPanel';
import SubAgentPanel from './SubAgentPanel';
import AgentCenterPanel from './AgentCenterPanel';
import AgentTaskCenter from './AgentTaskCenter';
import {
  emitAction as emitWindowAction,
  requestChatMessage,
  emitCloseChatWindow,
  requestTeamArtifactText,
  requestManagedChatOperation,
  type ChatManagedOperation,
  type ChatStateSnapshot,
  type ChatComposerHandoff,
  type ChatAction,
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
import { completeMediaMessageDelivery, getRecoverableMessageTask, retryMediaArtifactPersist, retryMediaMessageTask } from '../../services/ai/generationRuntime';
import { estimateConversationUsage } from '../../services/chat/contextManager';
import {
  getAgentModeToast,
  resolveConversationAgentApproval,
  resumeAgentTaskExecution,
  submitConversationMessage,
} from '../../services/chat/conversationExecutionController';
import {
  createDetachedChatSyncController,
  buildChatModelCatalog,
  executeManagedChatOperation,
} from '../../services/chat/detachedChatSyncController';
import type { AgentApprovalResolution, AgentMode } from '../../types/agent';
import type { AgentTeamProfile, AssistantExecutionSelection, TeamArtifactReference, TeamGraphDefinition } from '../../types/agentTeam';
import { normalizeExecutionSelection, normalizeTeamProfile } from '../../services/chat/teams/teamProfileService';
import { applyTeamResult, reconcileTeamResult, restoreTeamResult } from '../../services/chat/teams/teamResultApplyService';
import { appendTeamInstruction, readTeamTaskArtifact } from '../../services/chat/teams/teamInvocationService';
import type { ChatImageReference, ChatMessage, ChatPanelView } from '../../types/chat';
import {
  listConversationFileGrants,
  revokeFileGrant,
  subscribeFileGrants,
} from '../../services/chat/fileGrantService';
import {
  attachConversationFiles, getChatImagePreviews, getChatImagePreviewVersion, parseChatImageReferences,
  prepareChatImagePreviews, subscribeChatImagePreviews,
} from '../../services/chat/chatImageReferenceService';
import { getAssistantTextModelCandidates } from '../../services/projectSettingsService';
import { useT } from '../../i18n';
import type { PromptSubmitShortcut } from '../../types';
import { normalizePromptSubmitShortcut } from '../../utils/promptSubmitShortcut';
import { sameProjectWindowContext } from '../../services/projectWindowContext';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
// 主窗口与独立窗口均读取窗口运行时已经应用的外观。
const getChatTheme = (): 'dark' | 'light' => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
function subscribeChatTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const DRAFT_SYNC_DEBOUNCE_MS = 300;
const CHAT_PANEL_DEFAULT_WIDTH = 480;
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
  onComposerDraftChange?: (draft: ChatComposerHandoff) => void;
}

const EMPTY_IMAGE_DRAFTS: ChatImageReference[] = [];

export default function ChatPanel({
  detached = false,
  detachedSnapshot,
  detachedInitialized = true,
  detachedHeaderActions,
  onComposerDraftChange,
}: ChatPanelProps = {}) {
  const windowFrame = detachedSnapshot?.windowFrame;
  const emitAction = useCallback((action: ChatAction) => emitWindowAction(action, windowFrame), [windowFrame]);
  const latestWindowFrame = useRef(windowFrame);
  useLayoutEffect(() => { latestWindowFrame.current = windowFrame; }, [windowFrame]);
  const t = useT();
  const reduceMotion = useReducedMotion();
  const {
    chatOpen,
    chatPanelDetached,
    chatComposerDraft,
    chatComposerDrafts,
    chatComposerLiveDraft,
    chatPanelView,
    closeChat,
    clearChatComposerDraft,
    setChatPanelDetached,
    activeConversationId,
    conversations,
    messages,
    agentTasks,
    agentTaskFocus,
    currentProjectId,
    projects,
    createConversation,
    setActiveConversation,
    updateConversation,
    loadConversationMessages,
    showToast,
    assistantModelId,
    generalModels,
    config,
    configHydrated,
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
      chatComposerDrafts: s.chatComposerDrafts,
      chatComposerLiveDraft: s.chatComposerLiveDraft,
      chatPanelView: s.chatPanelView,
      closeChat: s.closeChat,
      clearChatComposerDraft: s.clearChatComposerDraft,
      setChatPanelDetached: s.setChatPanelDetached,
      activeConversationId: s.activeConversationId,
      conversations: s.conversations,
      messages: s.messages,
      agentTasks: s.agentTasks,
      agentTaskFocus: s.agentTaskFocus,
      currentProjectId: s.currentProjectId,
      projects: s.projects,
      createConversation: s.createConversation,
      setActiveConversation: s.setActiveConversation,
      updateConversation: s.updateConversation,
      loadConversationMessages: s.loadConversationMessages,
      showToast: s.showToast,
      assistantModelId: s.config.assistantModelId,
      generalModels: s.config.generalModels ?? [],
      config: s.config,
      configHydrated: s.configHydrated,
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
  const conversationScopeId = currentProjectId ? seriesOwnerId(projects, currentProjectId) : GENERAL_ASSISTANT_SCOPE_ID;
  const effectiveActiveConversationId = detached ? (detachedSnapshot?.activeConversationId ?? null)
    : activeConversationId !== MCP_SETTINGS_CONVERSATION_ID
      && !conversations.some((conversation) => conversation.id === activeConversationId && conversation.projectId === conversationScopeId)
      ? null : activeConversationId;
  const effectiveMessages = useMemo(
    () => detached ? (detachedSnapshot?.messages ?? []) : messages,
    [detached, detachedSnapshot?.messages, messages],
  );
  const effectiveAgentTasks = useMemo(
    () => detached ? (detachedSnapshot?.agentTasks ?? []) : agentTasks,
    [detached, detachedSnapshot?.agentTasks, agentTasks],
  );
  const effectiveAgentTaskFocus = detached ? detachedSnapshot?.agentTaskFocus : agentTaskFocus;
  const effectiveProjectId = detached ? (detachedSnapshot?.projectId ?? null) : currentProjectId;
  const chatScopeId = effectiveProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
  const effectiveActiveConversation = effectiveConversations.find(
    (conversation) => conversation.id === effectiveActiveConversationId,
  );
  const workbenchTarget = effectiveActiveConversation?.workbenchTarget;
  const modelProjectId = workbenchTarget?.episodeId ?? chatScopeId;
  const effectiveProjectName = detached ? detachedSnapshot?.projectName : projects.find((item) => item.id === currentProjectId)?.name;
  useEffect(() => {
    if (!detached && currentProjectId === null) {
      void useAppStore.getState().loadConversationsForProject(GENERAL_ASSISTANT_SCOPE_ID);
    }
  }, [detached, currentProjectId]);
  const currentProject = projects.find((item) => item.id === currentProjectId);
  const modelProject = projects.find((item) => item.id === modelProjectId);
  const projectAssistantModelId = getAssistantTextModelCandidates(
    modelProject?.settings,
    assistantModelId,
  )[0];
  const effectiveAssistantModelId = detached
    ? detachedSnapshot?.assistantModelId
    : projectAssistantModelId;
  const effectiveGeneralModels = useMemo(
    () => detached ? (detachedSnapshot?.generalModels ?? []) : generalModels,
    [detached, detachedSnapshot?.generalModels, generalModels],
  );
  const appearanceMode = useSyncExternalStore(subscribeChatTheme, getChatTheme, getChatTheme);
  const effectiveSubmitShortcut = normalizePromptSubmitShortcut(detached ? detachedSnapshot?.promptSubmitShortcut : config.promptSubmitShortcut);
  const submitShortcutSettingsDisabled = detached ? detachedSnapshot?.promptSubmitShortcut === undefined : !configHydrated;
  const handleSubmitShortcutChange = useCallback((shortcut: PromptSubmitShortcut) => {
    if (detached) {
      void emitAction({ type: 'set_prompt_submit_shortcut', shortcut });
      return;
    }
    if (!configHydrated) return;
    updateConfig({ promptSubmitShortcut: shortcut });
    void saveConfig({ silent: true }).catch(() => {});
  }, [configHydrated, detached, saveConfig, updateConfig, emitAction]);
  const localModelCatalog = useMemo(() => buildChatModelCatalog({ config, workflows }), [config, workflows]);
  const effectiveAssistantModelGroups = detached
    ? (detachedSnapshot?.assistantModelGroups ?? [])
    : localModelCatalog.assistantModelGroups;
  const mediaModelOptions = useMemo(() => detached
    ? (detachedSnapshot?.mediaModelOptions ?? [])
    : localModelCatalog.mediaModelOptions, [detached, detachedSnapshot?.mediaModelOptions, localModelCatalog.mediaModelOptions]);
  const effectiveMediaModelAvailability = useMemo(() => detached
    ? (detachedSnapshot?.mediaModelAvailability ?? {})
    : (localModelCatalog.mediaModelAvailability ?? {}), [detached, detachedSnapshot?.mediaModelAvailability, localModelCatalog.mediaModelAvailability]);
  const settingsConversation = effectiveActiveConversationId === MCP_SETTINGS_CONVERSATION_ID;
  const [inputValue, setInputValue] = useState('');
  const [externalCatalog, setExternalCatalog] = useState<ExternalAgentDescriptor[]>(() => readExternalAgentCatalog());
  const localCreationProfiles = useMemo(() => config.creationProfiles ? creationProfileOptions() : [], [config.creationProfiles]);
  const effectiveCreationProfiles = detached ? detachedSnapshot?.creationProfiles ?? [] : localCreationProfiles;
  const effectiveExternalAgents = detached ? detachedSnapshot?.externalAgents ?? [] : externalCatalog;
  const runManaged = useCallback(<T,>(operation: ChatManagedOperation, draft?: string): Promise<T> => {
    const targetConversation = 'taskId' in operation
      ? effectiveAgentTasks.find((task) => task.id === operation.taskId)?.conversationId ?? effectiveActiveConversationId ?? undefined
      : effectiveActiveConversationId ?? undefined;
    return detached ? requestManagedChatOperation<T>(chatScopeId, targetConversation, operation, draft, windowFrame)
      : executeManagedChatOperation(operation, chatScopeId, targetConversation, draft) as Promise<T>;
  }, [chatScopeId, detached, effectiveActiveConversationId, effectiveAgentTasks, windowFrame]);
  const handleCreationPreview = useCallback((profile: CreationProfileOption) => runManaged<CreationProfileChoicePreview>({ kind: 'preview_creation_profile', profile }), [runManaged]);
  const handleCreationChange = useCallback(async (selection: CreationProfileSelection | undefined) => {
    await runManaged({ kind: 'apply_creation_profile', selection: selection ?? null }, inputValue);
  }, [runManaged, inputValue]);
  const handleBranchMessage = useCallback(async (messageId: string) => {
    await runManaged({ kind: 'branch_conversation', messageId });
  }, [runManaged]);
  const refreshExternalAgents = useCallback(async () => {
    setExternalCatalog(await runManaged<ExternalAgentDescriptor[]>({ kind: 'refresh_external_agents' }));
  }, [runManaged]);
  const mcpOptions = detached ? detachedSnapshot?.mcpClientOptions ?? [] : getMcpClientOptions(config.mcpClientConnections ?? []);
  const handleMcpToggle = (serverId: string, enabled: boolean) => {
    if (detached) {
      void emitAction({ type: 'set_mcp_connection', conversationId: effectiveActiveConversationId ?? undefined, scopeId: chatScopeId, serverId, enabled, draft: inputValue });
      return;
    }
    const state = useAppStore.getState();
    const conversationId = effectiveActiveConversationId ?? state.createConversation(chatScopeId);
    if (!effectiveActiveConversationId) state.setChatComposerLiveDraft(inputValue, conversationId);
    state.setConversationMcpServer(conversationId, serverId, enabled);
  };
  const handleMcpSettings = () => {
    if (detached) void emitAction({ type: 'open_mcp_client_settings' });
    else useAppStore.getState().setSettingsOpen(true, 'mcp');
  };
  const effectiveAgentMode = effectiveActiveConversation?.agentMode ?? 'collaborative';
  const effectiveExecutionSelection = useMemo(() => normalizeExecutionSelection(effectiveActiveConversation?.executionSelection),
    [effectiveActiveConversation?.executionSelection]);
  const effectiveTeamProfile = useMemo(() => {
    if (detached) return normalizeTeamProfile(detachedSnapshot?.agentTeamProfile);
    if (effectiveActiveConversation?.creationProfile && !config.creationProfiles?.some((profile) => profile.id === effectiveActiveConversation?.creationProfile?.id
      && profile.version === effectiveActiveConversation?.creationProfile?.version)) return normalizeTeamProfile(config.agentTeamProfile);
    try { return resolveCreationTeamProfile(effectiveActiveConversation?.creationProfile, effectiveActiveConversation?.teamProfileOverride); }
    catch { return normalizeTeamProfile(config.agentTeamProfile); }
  }, [config.agentTeamProfile, config.creationProfiles, detached, detachedSnapshot?.agentTeamProfile,
    effectiveActiveConversation]);
  const isEpisodeProject = detached ? detachedSnapshot?.isEpisodeProject === true : !!currentProject?.parentId;
  const teamContextHint = isEpisodeProject && effectiveExecutionSelection.kind === 'team'
    ? effectiveExecutionSelection.templateId === 'outline'
      ? t('将读取当前分集已保存的大纲、正文和创作要点，生成绑定本集大纲的候选；应用后才写回。请先保存工作台修改。')
      : effectiveExecutionSelection.templateId === 'script'
        ? t('将读取当前分集已保存的大纲、正文和创作要点，生成绑定本集正文的候选；应用后才写回。请先保存工作台修改。')
        : effectiveExecutionSelection.templateId === 'review'
          ? t('将读取当前分集已保存的大纲、正文和创作要点联合审稿，只生成报告。请先保存工作台修改。')
          : undefined
    : undefined;
  const handleExecutionSelectionChange = useCallback((selection: AssistantExecutionSelection) => {
    if (workbenchTarget) return;
    if (detached) {
      void emitAction({ type: 'set_execution_selection', conversationId: effectiveActiveConversationId ?? undefined,
        scopeId: chatScopeId, selection, draft: inputValue });
      return;
    }
    const state = useAppStore.getState();
    const conversationId = effectiveActiveConversationId ?? state.createConversation(chatScopeId);
    if (!effectiveActiveConversationId) state.setChatComposerLiveDraft(inputValue, conversationId);
    state.updateConversation(conversationId, { executionSelection: normalizeExecutionSelection(selection) });
  }, [chatScopeId, detached, effectiveActiveConversationId, inputValue, workbenchTarget, emitAction]);
  const handleTeamProfileChange = useCallback(async (profile: AgentTeamProfile) => {
    await runManaged({ kind: 'save_team_profile', profile: normalizeTeamProfile(profile) });
  }, [runManaged]);
  const hasActiveConversationTask = effectiveAgentTasks.some(
    (task) => task.conversationId === effectiveActiveConversationId
      && ['planning', 'running', 'waiting_tool', 'waiting_approval'].includes(task.status),
  );

  const imageDrafts = useAppStore((state) => state.chatImageDrafts);
  const effectiveImageDrafts = detached ? (detachedSnapshot?.imageDrafts ?? EMPTY_IMAGE_DRAFTS)
    : effectiveActiveConversationId ? imageDrafts[effectiveActiveConversationId] ?? EMPTY_IMAGE_DRAFTS : EMPTY_IMAGE_DRAFTS;
  const conversationMessages = useMemo(
    () => effectiveActiveConversationId
      ? effectiveMessages.filter((message) => message.conversationId === effectiveActiveConversationId)
      : [],
    [effectiveMessages, effectiveActiveConversationId],
  );
  const [getMessageImageFiles] = useState(() => {
    const cache = new WeakMap<ChatMessage, { content: string; fileNames: string[] }>();
    return (message: ChatMessage) => {
      const previous = cache.get(message);
      if (previous?.content === message.content) return previous.fileNames;
      const fileNames = parseChatImageReferences(message.content).map((image) => image.fileName);
      cache.set(message, { content: message.content, fileNames });
      return fileNames;
    };
  });
  const historyImageFileNames = useMemo(
    () => conversationMessages.flatMap(getMessageImageFiles),
    [conversationMessages, getMessageImageFiles],
  );
  const draftImageFileNames = useMemo(
    () => parseChatImageReferences(inputValue).map((image) => image.fileName),
    [inputValue],
  );
  const imagePreviewVersion = useSyncExternalStore(subscribeChatImagePreviews, getChatImagePreviewVersion, getChatImagePreviewVersion);
  const imageFileKey = JSON.stringify([...new Set([
    ...historyImageFileNames,
    ...draftImageFileNames,
    ...effectiveImageDrafts.map((image) => image.fileName),
  ])]);
  useEffect(() => {
    if (!detached) void prepareChatImagePreviews(chatScopeId, JSON.parse(imageFileKey) as string[]);
  }, [detached, chatScopeId, imageFileKey]);
  const imagePreviewUrls = useMemo(() => {
    if (detached) return detachedSnapshot?.imagePreviewUrls;
    return imagePreviewVersion === 0 ? {} : getChatImagePreviews(chatScopeId, JSON.parse(imageFileKey) as string[]);
  }, [detached, detachedSnapshot?.imagePreviewUrls, chatScopeId, imageFileKey, imagePreviewVersion]);
  const pendingDraftsRef = useRef(new Map<string | null, string>());
  const pendingDraftFramesRef = useRef(new Map<string | null, typeof windowFrame>());
  const pendingSendsRef = useRef(new Set<string>());
  const pendingConversationDraftRef = useRef<string | null>(null);
  const effectivePanelView = detached ? detachedSnapshot?.panelView ?? 'chat' : chatPanelView;
  const viewMode = effectivePanelView === 'list' ? 'list' : 'chat';
  const showTaskCenter = effectivePanelView === 'tasks';
  const setPanelView = useCallback((view: ChatPanelView) => {
    if (detached) void emitAction({ type: 'set_panel_view', view });
    else useAppStore.getState().setChatPanelView(view);
  }, [detached, emitAction]);
  const setViewMode = setPanelView;
  const setShowTaskCenter = useCallback((show: boolean) => setPanelView(show ? 'tasks' : 'chat'), [setPanelView]);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(false);
  const [showAgentCenter, setShowAgentCenter] = useState(false);
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
    effectiveProjectId ? projectMemoryOwnerId(s.projects, effectiveProjectId) : null
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

  // 主窗口直接保存草稿，独立窗口合并输入后再发 IPC；关窗时另带最后一次编辑兜底。
  const draftSyncRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    value: ChatComposerHandoff | null;
  }>({ timer: null, value: null });

  const flushDraftSync = useCallback(() => {
    const pending = draftSyncRef.current;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.value == null) return;
    const value = pending.value;
    pending.value = null;
    if (detached) void emitWindowAction({ type: 'set_composer_draft', ...value }, value.windowFrame);
    else useAppStore.getState().setChatComposerLiveDraft(value.draft, value.conversationId);
  }, [detached]);

  const queueDraftSync = useCallback((value: string) => {
    const pending = draftSyncRef.current;
    if (!detached) {
      useAppStore.getState().setChatComposerLiveDraft(value, effectiveActiveConversationId);
      return;
    }
    if (pending.value && pending.value.conversationId !== effectiveActiveConversationId) flushDraftSync();
    pending.value = { draft: value, conversationId: effectiveActiveConversationId, windowFrame: windowFrame ?? undefined };
    if (pending.timer) return;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      flushDraftSync();
    }, DRAFT_SYNC_DEBOUNCE_MS);
  }, [detached, effectiveActiveConversationId, flushDraftSync, windowFrame]);

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
    if (detached) {
      pendingDraftsRef.current.set(effectiveActiveConversationId, value);
      pendingDraftFramesRef.current.set(effectiveActiveConversationId, windowFrame);
    }
    queueDraftSync(value);
    onComposerDraftChange?.({ draft: value, conversationId: effectiveActiveConversationId, windowFrame: windowFrame ?? undefined });
  }, [detached, effectiveActiveConversationId, onComposerDraftChange, queueDraftSync, windowFrame]);

  const canonicalDraft = effectiveActiveConversationId
    ? (detached ? detachedSnapshot?.composerDrafts : chatComposerDrafts)?.[effectiveActiveConversationId] ?? ''
    : detached ? detachedSnapshot?.composerDraft ?? '' : activeConversationId ? '' : chatComposerLiveDraft;
  const ownsComposer = detached ? detachedInitialized : !chatPanelDetached;
  useEffect(() => {
    if (!ownsComposer) return;
    const conversationId = effectiveActiveConversationId;
    const pending = pendingDraftsRef.current.get(conversationId);
    // 旧快照可能晚于本地输入到达；直到主窗口回传最新值，先保留正在编辑的内容。
    if (pending !== undefined && pending !== canonicalDraft) {
      const frame = requestAnimationFrame(() => {
        setInputValue(pendingDraftsRef.current.get(conversationId) ?? canonicalDraft);
      });
      return () => cancelAnimationFrame(frame);
    }
    pendingDraftsRef.current.delete(conversationId);
    pendingDraftFramesRef.current.delete(conversationId);
    const frame = requestAnimationFrame(() => {
      if (pendingDraftsRef.current.has(conversationId)) return;
      if (conversationId && pendingConversationDraftRef.current != null) {
        const draft = pendingConversationDraftRef.current;
        pendingConversationDraftRef.current = null;
        updateInputDraft(draft);
      } else {
        setInputValue(canonicalDraft);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [canonicalDraft, effectiveActiveConversationId, effectiveImageDrafts, ownsComposer, updateInputDraft]);

  const handleTextModelChange = useCallback((modelId?: string) => {
    if (workbenchTarget) return;
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
  }, [currentProject, detached, saveConfig, updateConfig, updateProjectSettings, workbenchTarget, emitAction]);

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
    emitAction,
  ]);

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
  }, [
    effectiveActiveConversationId,
    effectiveAssistantModelId,
    effectiveGeneralModels,
    effectiveActiveConversation?.contextSummary,
    conversationMessages,
  ]);

  // ── 会话操作 ──
  const handleNewConversation = useCallback(() => {
    if (detached) {
      void emitAction({ type: 'create_conversation', projectId: chatScopeId });
    } else {
      createConversation(chatScopeId);
    }
    setViewMode('chat');
  }, [detached, chatScopeId, createConversation, setViewMode, emitAction]);

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
    [detached, setActiveConversation, loadConversationMessages, setViewMode, emitAction],
  );

  const handleShowList = useCallback(() => setViewMode('list'), [setViewMode]);

  const handleExampleClick = useCallback((text: string) => {
    if (!effectiveActiveConversationId) {
      pendingConversationDraftRef.current = text;
      handleNewConversation();
      setInputValue(text);
      return;
    }
    updateInputDraft(text);
  }, [effectiveActiveConversationId, handleNewConversation, updateInputDraft]);

  useEffect(() => {
    if (detached || chatPanelDetached || !chatComposerDraft) return;
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
    chatPanelDetached,
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
    if (!message) return;
    const projectId = store.currentProjectId;
    try {
      if (getRecoverableMessageTask(messageId, projectId)) {
        await retryMediaMessageTask(messageId);
        if (!getRecoverableMessageTask(messageId, projectId)) store.showToast(t('产物已保存到项目'));
        return;
      }
      if (!message.mediaResult) return;
      const artifact = await retryMediaArtifactPersist(
        message.mediaResult,
        projectId,
      );
      const currentStore = useAppStore.getState();
      if (currentStore.currentProjectId !== projectId
        || !currentStore.messages.some((item) => item.id === messageId && item.conversationId === message.conversationId
          && item.mediaResult?.id === message.mediaResult?.id)) return;
      currentStore.updateMessage(messageId, { mediaResult: artifact });
      let canvasReady = true;
      if (message.canvasNodeId) {
        canvasReady = currentStore.settleMediaPlaceholder(message.canvasNodeId, artifact);
      }
      await completeMediaMessageDelivery(messageId, artifact, canvasReady);
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
  }, [detached, showToast, t, emitAction]);

  const [scrollRequest, setScrollRequest] = useState<ChatScrollRequest | null>(null);
  const requestLatestMessages = useCallback((conversationId: string | null) => {
    if (!conversationId) return;
    setScrollRequest((previous) => ({ conversationId, sequence: (previous?.sequence ?? 0) + 1 }));
  }, []);

  const agentControls = useMemo(() => ({
    onResolveApproval: handleResolveApproval,
    mediaModelOptions,
    mediaModelAvailability: effectiveMediaModelAvailability,
    onReadTeamArtifact: async (taskId: string, artifact: TeamArtifactReference) => {
      if (detached) return requestTeamArtifactText(taskId, artifact.id, windowFrame);
      return readTeamTaskArtifact(taskId, artifact.id);
    },
    onApplyTeamResult: async (taskId: string) => {
      if (detached) { await runManaged({ kind: 'team_result', taskId, action: 'apply' }); return; }
      await applyTeamResult(taskId);
    },
    onRestoreTeamResult: async (taskId: string) => {
      if (detached) { await runManaged({ kind: 'team_result', taskId, action: 'restore' }); return; }
      await restoreTeamResult(taskId);
    },
    onReconcileTeamResult: async (taskId: string) => {
      if (detached) { showToast(await runManaged<string>({ kind: 'team_result', taskId, action: 'reconcile' }), 'info'); return; }
      const message = await reconcileTeamResult(taskId);
      showToast(message, 'info');
    },
    onAmendTeamTask: async (taskId: string, instruction: string) => {
      if (detached) { await runManaged({ kind: 'amend_team_task', taskId, instruction }); return; }
      await appendTeamInstruction(taskId, instruction);
    },
    onEditTeamGraph: async (taskId: string, graph: TeamGraphDefinition, expected: { revision: number; boardRevision: number }) => {
      await runManaged({ kind: 'edit_team_graph', taskId, graph, expected });
    },
    onResolveDispatch: async (taskId: string, dispatchId: string, decision: 'verified_completed' | 'abandoned') => {
      await runManaged({ kind: 'resolve_dispatch', taskId, dispatchId, decision });
    },
    onPause: (taskId: string) => {
      if (detached) { void emitAction({ type: 'pause_agent_task', taskId }); return; }
      cancelScheduledAgentExecution(taskId);
      pauseAgentTask(taskId);
      showToast(t('已暂停任务'), 'info');
    },
    onResume: (taskId: string) => {
      if (detached) { void emitAction({ type: 'resume_agent_task', taskId }); return; }
      const result = resumeAgentTaskExecution(taskId);
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
      const result = resumeAgentTaskExecution(taskId);
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
    runManaged,
    effectiveMediaModelAvailability,
    handleResolveApproval,
    mediaModelOptions,
    showToast,
    t,
    emitAction,
    windowFrame,
  ]);

  const handleAuthorizeLocalFiles = useCallback(() => {
    if (detached) {
      void emitAction({
        type: 'authorize_local_files',
        conversationId: effectiveActiveConversationId ?? undefined,
        draft: inputValue,
      });
      return;
    }
    const conversationId = effectiveActiveConversationId ?? createConversation(chatScopeId);
    if (!effectiveActiveConversationId && inputValue) {
      useAppStore.getState().setChatComposerLiveDraft(inputValue, conversationId);
    }
    void attachConversationFiles(conversationId)
      .then((created) => {
        showToast(
          t('已添加 {images} 张参考图，授权 {texts} 个文本文件', { images: created.images, texts: created.texts })
            + (created.failed ? t('；部分图片未添加，请检查格式、大小或数量上限') : ''),
          'info',
        );
      })
      .catch((error) => showToast(
        error instanceof Error ? error.message : t('文件授权失败'),
        'error',
      ));
  }, [detached, effectiveActiveConversationId, createConversation, chatScopeId, inputValue, showToast, t, emitAction]);

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
  }, [detached, effectiveActiveConversationId, emitAction]);

  const handleRemoveImage = useCallback((fileName: string) => {
    if (!effectiveActiveConversationId) return;
    if (detached) void emitAction({ type: 'remove_image_attachment', conversationId: effectiveActiveConversationId, fileName });
    else useAppStore.getState().removeChatImageDrafts(effectiveActiveConversationId, [fileName]);
  }, [detached, effectiveActiveConversationId, emitAction]);

  // ── 发送消息 ──
  const sendMessageText = useCallback((content: string, dispatchMode: 'queue' | 'interject' = 'queue', includePendingImages = true) => {
    const text = content.trim();
    const imageFileNames = includePendingImages ? effectiveImageDrafts.map((image) => image.fileName) : [];
    if ((!text && !imageFileNames.length) || settingsConversation) return;
    const requestId = effectiveExecutionSelection.kind === 'team' ? crypto.randomUUID() : undefined;

    if (detached) {
      if (pendingDraftsRef.current.has(effectiveActiveConversationId)
        && !sameProjectWindowContext(pendingDraftFramesRef.current.get(effectiveActiveConversationId)?.context, windowFrame?.context)) {
        showToast(t('项目已变化，草稿仍保留，请核对原目标后重新编辑或复制'), 'error'); return;
      }
      const target = windowFrame?.context.target;
      const sendKey = JSON.stringify([windowFrame?.sessionId, target?.runtimeEpoch, target?.kind,
        target && target.kind !== 'global' ? [target.projectId, target.projectEpoch] : null,
        target?.kind === 'episode' ? [target.episodeId, target.episodeRevision] : null,
        windowFrame?.context.canvas?.canvasId, windowFrame?.context.canvas?.canvasEpoch,
        effectiveActiveConversationId, content, imageFileNames, dispatchMode]);
      if (pendingSendsRef.current.has(sendKey)) return;
      pendingSendsRef.current.add(sendKey);
      const pending = draftSyncRef.current;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      pending.value = null;
      void requestChatMessage({
        type: 'send_message',
        content: text,
        imageFileNames,
        conversationId: effectiveActiveConversationId ?? undefined,
        dispatchMode,
        executionSelection: effectiveExecutionSelection,
        requestId,
      }, windowFrame).then((accepted) => {
        if (!accepted || latestWindowFrame.current?.sessionId !== windowFrame?.sessionId
          || latestWindowFrame.current?.conversationId !== windowFrame?.conversationId
          || !sameProjectWindowContext(latestWindowFrame.current?.context, windowFrame?.context)
          || pendingDraftsRef.current.get(effectiveActiveConversationId) !== content) return;
        updateInputDraft('');
      }).finally(() => { pendingSendsRef.current.delete(sendKey); });
      requestLatestMessages(effectiveActiveConversationId);
      return;
    }

    const conversationId = effectiveActiveConversationId ?? createConversation(chatScopeId);
    const submitted = submitConversationMessage({
      content: text,
      imageFileNames,
      projectId: chatScopeId,
      conversationId,
      mode: effectiveAgentMode,
      dispatchMode,
      executionSelection: effectiveExecutionSelection,
      requestId,
    });
    if (submitted.status === 'ignored') return;
    updateInputDraft('');
    requestLatestMessages(conversationId);
  }, [
    detached,
    effectiveActiveConversationId,
    effectiveAgentMode,
    effectiveExecutionSelection,
    chatScopeId,
    createConversation,
    effectiveImageDrafts,
    settingsConversation,
    requestLatestMessages,
    updateInputDraft,
    windowFrame,
    showToast,
    t,
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
    sendMessageText(content, 'queue', false);
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
  }, [detached, showToast, t, emitAction]);

  const handleNodeHover = useCallback((nodeId: string | null) => {
    if (detached) {
      void emitAction({ type: 'set_hovered_node', nodeId });
      return;
    }
    useAppStore.getState().setHoveredMentionNodeId(nodeId);
  }, [detached, emitAction]);

  const handleSkillUsed = useCallback((skillId: string) => {
    const operation = detached
      ? emitAction({ type: 'mark_skill_used', skillId })
      : useAppStore.getState().markSkillUsed(skillId);
    void operation.catch(() => showToast(t('最近 Skill 使用记录保存失败'), 'error'));
  }, [detached, emitAction, showToast, t]);

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
        setChatPanelDetached(false);
      } catch (error) { showToast(error instanceof Error ? error.message : t('独立窗口尚未确认草稿交接'), 'error'); }
    } else {
      // 必须先置位：独立窗口一加载就会来要快照，而同步器在 detached 为假时会把请求丢掉
      flushDraftSync();
      try {
        await openDetachedChatWindow();
      } catch (e) {
        const detail = e instanceof Error ? e.message : '';
        showToast(`${t('打开独立窗口失败')}${detail ? `：${detail}` : ''}`, 'error');
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
              projectName={effectiveProjectName ?? t('通用对话')}
              agentMode={effectiveAgentMode}
              onAgentModeChange={handleAgentModeChange}
              agentModeDisabled={!effectiveActiveConversationId || settingsConversation}
              executionControls={viewMode === 'chat' && !showTaskCenter && !settingsConversation ? (
                <TeamExecutionPicker
                  value={effectiveExecutionSelection}
                  onChange={handleExecutionSelectionChange}
                  profile={effectiveTeamProfile}
                  onProfileChange={handleTeamProfileChange}
                  modelGroups={effectiveAssistantModelGroups}
                  generalModels={effectiveGeneralModels}
                  theme={appearanceMode}
                  controls="execution"
                  externalAgents={effectiveExternalAgents}
                  onRefreshExternalAgents={refreshExternalAgents}
                  disabled={!!workbenchTarget}
                  compact
                />
              ) : undefined}
              mcpConnectionPicker={viewMode === 'chat' && !showTaskCenter && !settingsConversation ? (
                <McpConnectionPicker
                  options={mcpOptions}
                  selected={effectiveActiveConversation?.mcpServerIds ?? []}
                  onToggle={handleMcpToggle}
                  onSettings={handleMcpSettings}
                />
              ) : undefined}
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
                  tasks={effectiveAgentTasks.filter((task) => task.projectId === chatScopeId || task.projectId === MCP_SETTINGS_SCOPE_ID
                    || (task.id === effectiveAgentTaskFocus?.taskId && task.conversationId === effectiveActiveConversationId))}
                  conversations={effectiveConversations}
                  onClose={() => setShowTaskCenter(false)}
                  {...agentControls}
                  focusRequest={effectiveAgentTaskFocus}
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
                    hasCanvas={!!effectiveProjectId}
                    messages={conversationMessages}
                    conversationId={effectiveActiveConversationId}
                    scrollRequest={scrollRequest}
                    imagePreviewUrls={imagePreviewUrls}
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
                    onBranchMessage={handleBranchMessage}
                    onNodeActivate={handleNodeActivate}
                    onNodeHover={handleNodeHover}
                    onModelActivate={handleModelActivate}
                    agentControls={agentControls}
                  />

                  {/* Input area */}
                  {!settingsConversation && (
                    <ChatInput
                      assistantModelId={effectiveAssistantModelId}
                      onAssistantModelChange={handleTextModelChange}
                      assistantModelDisabled={!!workbenchTarget}
                      assistantModelHint={workbenchTarget ? t('模型沿用目标分集设置；如需修改，请切到该分集的项目设置。') : undefined}
                      assistantModelGroups={effectiveAssistantModelGroups}
                      executionSelection={effectiveExecutionSelection}
                      teamConfiguration={<div className="flex min-w-0 flex-wrap items-center gap-2">
                        {!workbenchTarget && <CreationProfilePicker profiles={effectiveCreationProfiles} selection={effectiveActiveConversation?.creationProfile}
                          projectId={chatScopeId} disabled={!detachedInitialized || hasActiveConversationTask}
                          onPreview={handleCreationPreview} onChange={handleCreationChange} />}
                        {effectiveExecutionSelection.kind === 'team' ? (
                        <TeamExecutionPicker
                          value={effectiveExecutionSelection}
                          onChange={handleExecutionSelectionChange}
                          profile={effectiveTeamProfile}
                          onProfileChange={handleTeamProfileChange}
                          modelGroups={effectiveAssistantModelGroups}
                          generalModels={effectiveGeneralModels}
                          theme={appearanceMode}
                          controls="configuration"
                          compact
                          externalAgents={effectiveExternalAgents}
                          onRefreshExternalAgents={refreshExternalAgents}
                        />
                      ) : null}</div>}
                      teamContextHint={teamContextHint}
                      appearanceMode={appearanceMode}
                      mediaModels={effectiveGeneralModels}
                      mediaModelOptions={mediaModelOptions}
                      mediaModelAvailability={effectiveMediaModelAvailability}
                      inputValue={inputValue}
                      onInputChange={updateInputDraft}
                      onSend={handleSend}
                      submitShortcut={effectiveSubmitShortcut}
                      onSubmitShortcutChange={handleSubmitShortcutChange}
                      shortcutSettingsDisabled={submitShortcutSettingsDisabled}
                      hasActiveTask={hasActiveConversationTask}
                      onInterject={handleInterject}
                      localFileGrants={effectiveLocalFileGrants}
                      imageDrafts={effectiveImageDrafts}
                      imagePreviewUrls={imagePreviewUrls}
                      onRemoveImage={handleRemoveImage}
                      onAuthorizeLocalFiles={handleAuthorizeLocalFiles}
                      onRevokeLocalFile={handleRevokeLocalFile}
                      contextUsage={contextUsage}
                      allowSkillUpload={!detached}
                      skillOptions={detached ? (detachedSnapshot?.skillOptions ?? []) : undefined}
                      onSkillUsed={handleSkillUsed}
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
