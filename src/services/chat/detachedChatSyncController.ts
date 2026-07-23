import { useAppStore } from '../../store/useAppStore';
import type { ApiProviderConfig, GeneralModelConfig } from '../../types';
import type { AgentTask } from '../../types/agent';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import {
  getMediaModelOptions,
  type MediaModelOption,
} from '../../components/nodes/shared/defaultModels';
import {
  cancelScheduledAgentExecution,
} from './agentScheduler';
import {
  pauseAgentTask,
  requestAgentReplan,
  skipAgentStep,
  stopAgentTask,
} from './agentRuntime';
import { rewindAgentTaskCanvas } from './agentRewindService';
import {
  getAgentModeToast,
  resolveConversationAgentApproval,
  resumeAgentTaskExecution,
  submitConversationMessage,
} from './conversationExecutionController';
import {
  authorizeConversationFiles,
  clearConversationFileGrants,
  listConversationFileGrants,
  revokeFileGrant,
  subscribeFileGrants,
} from './fileGrantService';
import {
  createChatStatePatch,
  emitSyncState,
  hasChatStatePatchChanges,
  initMainWindowListener,
  type ChatAction,
  type ChatStateSnapshot,
  type ChatStateSync,
} from './chatWindowService';

const DEFAULT_SYNC_INTERVAL_MS = 150;
const MAX_SYNC_RETRY_DELAY_MS = 5_000;
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

type AppState = ReturnType<typeof useAppStore.getState>;

export interface DetachedChatSyncController {
  start: () => Promise<void>;
  dispose: () => void;
  sync: (immediate?: boolean, forceSnapshot?: boolean) => void;
}

interface DetachedChatSyncControllerOptions {
  enabled?: boolean;
  syncIntervalMs?: number;
  emitSync?: (sync: ChatStateSync) => Promise<void>;
  initListener?: (
    onAction: (action: ChatAction) => void,
    onDetachClosed: () => void,
  ) => Promise<() => void>;
  now?: () => number;
}

interface DetachedSnapshotSource {
  conversations: ChatConversation[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  agentTasks: AgentTask[];
  currentProjectId: string | null;
  projects: AppState['projects'];
  config: AppState['config'];
  chatPanelDetached: boolean;
}

export function getMediaModelAvailability(
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
      const provider = generalModel ? providers[generalModel.providerConfigId] : undefined;
      return [option.value, !!provider?.baseUrl && !!generalModel?.modelId];
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

export function buildDetachedChatSnapshot(state: AppState): ChatStateSnapshot {
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  return {
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    messages: state.messages,
    agentTasks: state.agentTasks,
    projectId: state.currentProjectId,
    projectName: project?.name,
    generalModels: state.config.generalModels ?? [],
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

function detachedSnapshotSourceChanged(
  current: DetachedSnapshotSource,
  previous: DetachedSnapshotSource,
): boolean {
  return current.chatPanelDetached !== previous.chatPanelDetached
    || current.conversations !== previous.conversations
    || current.activeConversationId !== previous.activeConversationId
    || current.messages !== previous.messages
    || current.agentTasks !== previous.agentTasks
    || current.currentProjectId !== previous.currentProjectId
    || current.projects !== previous.projects
    || current.config !== previous.config;
}

export function handleDetachedChatAction(
  action: ChatAction,
  requestSync: (immediate?: boolean, forceSnapshot?: boolean) => void,
): void {
  const store = useAppStore.getState();

  switch (action.type) {
    case 'send_message': {
      if (action.conversationId !== store.activeConversationId) {
        store.setActiveConversation(action.conversationId);
      }
      const conversation = store.conversations.find(
        (item) => item.id === action.conversationId,
      );
      submitConversationMessage({
        content: action.content,
        projectId: conversation?.projectId ?? store.currentProjectId ?? '',
        conversationId: action.conversationId,
        mode: conversation?.agentMode ?? 'collaborative',
        dispatchMode: action.dispatchMode,
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
      const conversation = store.conversations.find(
        (item) => item.id === action.conversationId,
      );
      if (conversation) {
        store.updateConversation(action.conversationId, { pinned: !conversation.pinned });
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
      if (!resolveConversationAgentApproval(action.approvalId, action.resolution)) {
        store.showToast('该确认已过期，请重新发起操作', 'info');
      }
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
        store.showToast(
          result.ok ? '已回退该任务的画布修改' : (result.message ?? '无法回退任务'),
          result.ok ? 'info' : 'error',
        );
      });
      break;

    case 'select_model': {
      const config: Record<string, string | undefined> = {};
      const category = action.category || 'text';
      if (category === 'image') config.assistantImageModelId = action.modelId;
      else if (category === 'video') config.assistantVideoModelId = action.modelId;
      else config.assistantModelId = action.modelId;
      store.updateConfig(config);
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
      requestSync(true, true);
      break;

    case 'confirm_commands':
    case 'cancel_commands':
      break;
  }
}

export function createDetachedChatSyncController(
  options: DetachedChatSyncControllerOptions = {},
): DetachedChatSyncController {
  const enabled = options.enabled ?? isTauri;
  const syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const emitSync = options.emitSync ?? emitSyncState;
  const initListener = options.initListener ?? initMainWindowListener;
  const now = options.now ?? (() => performance.now());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pending = false;
  let immediatePending = false;
  let disposed = false;
  let lastStartedAt = 0;
  let lastSnapshot: ChatStateSnapshot | null = null;
  let revision = 0;
  let forceSnapshotPending = false;
  let consecutiveFailures = 0;
  let cleanupListener: (() => void) | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let unsubscribeFileGrants: (() => void) | undefined;

  const resetSyncState = () => {
    pending = false;
    immediatePending = false;
    forceSnapshotPending = false;
    lastSnapshot = null;
    revision = 0;
    consecutiveFailures = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const emitLatestSnapshot = async (): Promise<void> => {
    timer = null;
    if (disposed || inFlight || !pending) return;

    const state = useAppStore.getState();
    if (!state.chatPanelDetached) {
      resetSyncState();
      return;
    }

    pending = false;
    immediatePending = false;
    inFlight = true;
    lastStartedAt = now();

    try {
      const nextSnapshot = buildDetachedChatSnapshot(state);
      const previousSnapshot = lastSnapshot;
      const forceSnapshot = forceSnapshotPending || !previousSnapshot;

      if (!forceSnapshot) {
        const patch = createChatStatePatch(previousSnapshot, nextSnapshot);
        if (!hasChatStatePatchChanges(patch)) {
          lastSnapshot = nextSnapshot;
          consecutiveFailures = 0;
          return;
        }

        const baseRevision = revision;
        const nextRevision = revision + 1;
        await emitSync({ type: 'patch', baseRevision, revision: nextRevision, patch });
        lastSnapshot = nextSnapshot;
        revision = nextRevision;
        consecutiveFailures = 0;
        return;
      }

      const nextRevision = revision + 1;
      forceSnapshotPending = false;
      await emitSync({ type: 'snapshot', revision: nextRevision, snapshot: nextSnapshot });
      lastSnapshot = nextSnapshot;
      revision = nextRevision;
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      pending = true;
      forceSnapshotPending = true;
      console.warn('[chatWindow] failed to sync detached window state:', error);
    } finally {
      inFlight = false;
      if (!disposed && pending) {
        const elapsed = now() - lastStartedAt;
        const retryDelay = consecutiveFailures > 0
          ? Math.min(
              MAX_SYNC_RETRY_DELAY_MS,
              Math.max(1, syncIntervalMs) * (2 ** Math.min(consecutiveFailures - 1, 5)),
            )
          : 0;
        const delay = retryDelay > 0
          ? retryDelay
          : immediatePending ? 0 : Math.max(0, syncIntervalMs - elapsed);
        timer = setTimeout(() => {
          void emitLatestSnapshot();
        }, delay);
      }
    }
  };

  const sync = (immediate = false, forceSnapshot = false): void => {
    if (!enabled || disposed) return;
    if (!useAppStore.getState().chatPanelDetached) {
      resetSyncState();
      return;
    }

    pending = true;
    if (immediate) immediatePending = true;
    if (forceSnapshot) forceSnapshotPending = true;

    if (timer) {
      if (!immediate) return;
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) return;

    const elapsed = now() - lastStartedAt;
    const delay = immediate ? 0 : Math.max(0, syncIntervalMs - elapsed);
    if (delay === 0) {
      void emitLatestSnapshot();
      return;
    }
    timer = setTimeout(() => {
      void emitLatestSnapshot();
    }, delay);
  };

  const start = async (): Promise<void> => {
    if (!enabled || disposed || unsubscribeStore) return;

    unsubscribeStore = useAppStore.subscribe((state, previous) => {
      if (!state.chatPanelDetached) {
        if (previous.chatPanelDetached) resetSyncState();
        return;
      }
      if (!detachedSnapshotSourceChanged(state, previous)) return;
      const justDetached = !previous.chatPanelDetached;
      sync(justDetached, justDetached);
    });
    unsubscribeFileGrants = subscribeFileGrants(() => sync());

    const listenerCleanup = await initListener(
      (action) => handleDetachedChatAction(action, sync),
      () => {
        const store = useAppStore.getState();
        store.setHoveredMentionNodeId(null);
        store.setChatPanelDetached(false);
        store.openChat();
      },
    );
    if (disposed) {
      listenerCleanup();
      return;
    }
    cleanupListener = listenerCleanup;

    if (useAppStore.getState().chatPanelDetached) sync(true, true);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    resetSyncState();
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    unsubscribeFileGrants?.();
    unsubscribeFileGrants = undefined;
    cleanupListener?.();
    cleanupListener = undefined;
  };

  return { start, dispose, sync };
}
