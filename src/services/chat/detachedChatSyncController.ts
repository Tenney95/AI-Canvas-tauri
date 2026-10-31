/**
 * 连接独立对话窗口与主窗口 Store，生成只读快照并把窗口操作路由回唯一写入源。
 */
import type { Node } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import { seriesOwnerId } from '../../store/store.utils';
import { GENERAL_ASSISTANT_SCOPE_ID } from './assistantScope';
import { getMcpClientOptions } from '../mcp/mcpClientService';
import { MCP_SETTINGS_CONVERSATION_ID } from '../mcp/mcpSettingsScope';
import type {
  ApiProviderConfig,
  BaseNodeData,
  GeneralModelConfig,
} from '../../types';
import type { AgentTask } from '../../types/agent';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import {
  getConfiguredModelGroups,
  getGeneralModelGroups,
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
  type ChatComposerHandoff,
} from './chatWindowService';
import { getAssistantTextModelCandidates } from '../projectSettingsService';
import { projectSkillPickerOptions } from './skillCatalog';
import { normalizePromptSubmitShortcut, PROMPT_SUBMIT_SHORTCUT_OPTIONS } from '../../utils/promptSubmitShortcut';
import {
  attachConversationFiles, getChatImagePreviews, parseChatImageReferences,
  prepareChatImagePreviews, subscribeChatImagePreviews,
} from './chatImageReferenceService';
import { cancelMainReferencePreview, handleDetachedReferencePreviewAction } from './chatReferencePreviewService';

const DEFAULT_SYNC_INTERVAL_MS = 150;
const MAX_SYNC_RETRY_DELAY_MS = 5_000;
const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
// 同一空输入区连续勾选连接时，复用第一次创建且仍活动的会话，等待快照到达。
let pendingMcpSelection: { scopeId: string; conversationId: string } | null = null;

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
    onDetachClosed: (draft?: ChatComposerHandoff) => void,
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
  configHydrated: boolean;
  chatPanelDetached: boolean;
  nodes: AppState['nodes'];
  dramaAssets: AppState['dramaAssets'];
  userSkills: AppState['userSkills'];
  agentPackageSkills: AppState['agentPackageSkills'];
  chatComposerLiveDraft: string;
  chatComposerDrafts: AppState['chatComposerDrafts'];
  chatImageDrafts: AppState['chatImageDrafts'];
  chatPanelView: AppState['chatPanelView'];
  workflows: AppState['workflows'];
}

let cachedAgentTaskSource: AppState['agentTasks'] | null = null;
let cachedAgentTaskProjection: AgentTask[] = [];
let cachedAgentTaskSourceById = new Map<string, AgentTask>();
let cachedAgentTaskProjectionById = new Map<string, AgentTask>();

/**
 * 独立窗口只展示任务进度与已注入 Skill 名称，不需要任务恢复所依赖的 Skill 正文和包审计路径。
 * 相同任务对象沿用上一次投影，避免其他任务更新时整条时间线被补丁层判定为变化。
 */
export function projectChatAgentTasks(tasks: AppState['agentTasks']): AgentTask[] {
  if (tasks === cachedAgentTaskSource) return cachedAgentTaskProjection;

  let changed = tasks.length !== cachedAgentTaskProjection.length;
  const nextSourceById = new Map<string, AgentTask>();
  const nextProjectionById = new Map<string, AgentTask>();
  const next = tasks.map((task, index) => {
    const previousProjection = cachedAgentTaskProjectionById.get(task.id);
    const projected = cachedAgentTaskSourceById.get(task.id) === task && previousProjection
      ? previousProjection
      : task.skillBindings?.length
        ? {
            ...task,
            skillBindings: task.skillBindings.map((binding) => ({
              skillId: binding.skillId,
              name: binding.name,
              version: binding.version,
              content: '',
              allowedTools: binding.allowedTools ? [...binding.allowedTools] : undefined,
            })),
          }
        : task;
    if (projected !== cachedAgentTaskProjection[index]) changed = true;
    nextSourceById.set(task.id, task);
    nextProjectionById.set(task.id, projected);
    return projected;
  });

  cachedAgentTaskSource = tasks;
  cachedAgentTaskSourceById = nextSourceById;
  cachedAgentTaskProjectionById = nextProjectionById;
  if (!changed) return cachedAgentTaskProjection;
  cachedAgentTaskProjection = next;
  return cachedAgentTaskProjection;
}

export function getMediaModelAvailability(
  options: MediaModelOption[],
  generalModels: GeneralModelConfig[],
  providers: Record<string, ApiProviderConfig>,
  dreaminaLoggedIn: boolean,
): Record<string, boolean> {
  return Object.fromEntries(options.map((option) => {
    // ponytail: 工作流没有 API Key 可查，服务地址缺失由生成入口报错，这里只管「可选」
    if (option.workflowId && option.provider === 'workflow-api') {
      const manifest = useAppStore.getState().workflows.find((workflow) => workflow.id === option.workflowId)?.workflowApi;
      const connection = providers[option.providerConfigId ?? ''];
      return [option.value, !!connection?.baseUrl && (!!connection.apiKey || (manifest?.version === 2 && manifest.protocol.auth?.type === 'none'))];
    }
    if (option.workflowId) return [option.value, option.provider !== 'runninghubwf' || !!providers[option.providerConfigId ?? 'runninghub']?.apiKey];
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

const ORIGIN = { x: 0, y: 0 };
let cachedNodeSource: AppState['nodes'] | null = null;
let cachedNodeProjection: Node<BaseNodeData>[] = [];
let cachedNodeById = new Map<string, Node<BaseNodeData>>();

function sameProjection(
  previous: Node<BaseNodeData> | undefined,
  node: AppState['nodes'][number],
): previous is Node<BaseNodeData> {
  return !!previous
    && previous.type === node.type
    && previous.data.label === node.data.label
    && previous.data.type === node.data.type
    && previous.data.displayId === node.data.displayId
    && previous.data.imageUrl === node.data.imageUrl
    && previous.data.videoUrl === node.data.videoUrl
    && previous.data.thumbnailUrl === node.data.thumbnailUrl;
}

/**
 * 独立窗口只用节点做 @ 引用与缩略图，视频沿用已有可播放 URL，不传文件路径或正文。
 * 拖动画布每帧都会换一个 nodes 数组，但投影字段没变 —— 逐字段比过之后原样返回
 * 上一次的数组，让补丁层的 Object.is 直接短路，省掉整棵树的 JSON 比较。
 */
export function projectChatNodes(nodes: AppState['nodes']): Node<BaseNodeData>[] {
  if (nodes === cachedNodeSource) return cachedNodeProjection;
  cachedNodeSource = nodes;

  let changed = nodes.length !== cachedNodeProjection.length;
  const nextById = new Map<string, Node<BaseNodeData>>();
  const next = nodes.map((node, index) => {
    const previous = cachedNodeById.get(node.id);
    const projected = sameProjection(previous, node)
      ? previous
      : {
          id: node.id,
          type: node.type,
          position: ORIGIN,
          data: {
            label: node.data.label,
            type: node.data.type,
            displayId: node.data.displayId,
            imageUrl: node.data.imageUrl,
            videoUrl: node.data.videoUrl,
            thumbnailUrl: node.data.thumbnailUrl,
          },
        };
    if (projected !== cachedNodeProjection[index]) changed = true;
    nextById.set(node.id, projected);
    return projected;
  });

  if (!changed) return cachedNodeProjection;
  cachedNodeProjection = next;
  cachedNodeById = nextById;
  return cachedNodeProjection;
}

let cachedModelConfig: AppState['config'] | null = null;
let cachedWorkflows: AppState['workflows'] | null = null;
let cachedModelCatalog: Pick<ChatStateSnapshot, 'assistantModelGroups' | 'mediaModelOptions' | 'mediaModelAvailability'>;

/** 两种窗口共用同一份目录；只投影选项，不把连接凭据或工作流正文交给独立窗口。 */
export function buildChatModelCatalog(state: Pick<AppState, 'config' | 'workflows'>) {
  const { config, workflows } = state;
  if (config === cachedModelConfig && workflows === cachedWorkflows) return cachedModelCatalog;
  const models = config.generalModels ?? [];
  const mediaModelOptions = getMediaModelOptions(models, config, workflows);
  cachedModelCatalog = {
    assistantModelGroups: [
      ...getConfiguredModelGroups(config, 'ai-text'),
      ...getGeneralModelGroups(models, config, 'ai-text'),
    ],
    mediaModelOptions,
    mediaModelAvailability: getMediaModelAvailability(mediaModelOptions, models, config.providers, !!config.dreaminaAuth?.loggedIn),
  };
  cachedModelConfig = config;
  cachedWorkflows = workflows;
  return cachedModelCatalog;
}

const messageImageFileNames = new WeakMap<ChatMessage, string[]>();
let cachedImageMessages: ChatMessage[] | undefined;
let cachedImageConversation: string | null | undefined;
let cachedConversationImages: string[] = [];
let cachedImageDraft = '';
let cachedDraftImages: string[] = [];
let cachedConversations: ChatConversation[] | undefined;
let cachedConversationOwner: string | undefined;
let cachedScopedConversations: ChatConversation[] = [];

function conversationImageFileNames(messages: ChatMessage[], conversationId: string | null): string[] {
  if (messages === cachedImageMessages && conversationId === cachedImageConversation) return cachedConversationImages;
  const names: string[] = [];
  for (const message of messages) {
    if (message.conversationId !== conversationId) continue;
    let files = messageImageFileNames.get(message);
    if (!files) {
      files = parseChatImageReferences(message.content).map((image) => image.fileName);
      messageImageFileNames.set(message, files);
    }
    names.push(...files);
  }
  cachedImageMessages = messages;
  cachedImageConversation = conversationId;
  cachedConversationImages = names;
  return names;
}

export function buildDetachedChatSnapshot(state: AppState): ChatStateSnapshot {
  const chatScopeId = state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
  const ownerId = seriesOwnerId(state.projects, chatScopeId);
  if (state.conversations !== cachedConversations || ownerId !== cachedConversationOwner) {
    cachedScopedConversations = state.conversations.filter((conversation) => conversation.projectId === ownerId
      || conversation.id === MCP_SETTINGS_CONVERSATION_ID);
    cachedConversations = state.conversations;
    cachedConversationOwner = ownerId;
  }
  const conversations = cachedScopedConversations;
  const activeConversationId = conversations.some((conversation) => conversation.id === state.activeConversationId)
    ? state.activeConversationId : null;
  const composerDraft = activeConversationId ? state.chatComposerDrafts[activeConversationId] ?? ''
    : state.activeConversationId ? '' : state.chatComposerLiveDraft;
  const imageDrafts = activeConversationId ? state.chatImageDrafts[activeConversationId] ?? [] : [];
  if (composerDraft !== cachedImageDraft) {
    cachedImageDraft = composerDraft;
    cachedDraftImages = parseChatImageReferences(composerDraft).map((image) => image.fileName);
  }
  const imageFileNames = [...new Set([
    ...imageDrafts.map((image) => image.fileName),
    ...conversationImageFileNames(state.messages, activeConversationId),
    ...cachedDraftImages,
  ])];
  void prepareChatImagePreviews(chatScopeId, imageFileNames);
  const project = state.projects.find((item) => item.id === state.currentProjectId);
  return {
    conversations,
    activeConversationId,
    messages: state.messages,
    agentTasks: projectChatAgentTasks(state.agentTasks),
    projectId: state.currentProjectId,
    projectName: project?.name,
    generalModels: state.config.generalModels ?? [],
    ...buildChatModelCatalog(state),
    assistantModelId: getAssistantTextModelCandidates(
      project?.settings,
      state.config.assistantModelId,
    )[0],
    assistantImageModelId: state.config.assistantImageModelId,
    assistantVideoModelId: state.config.assistantVideoModelId,
    localFileGrants: activeConversationId
      ? listConversationFileGrants(activeConversationId)
      : [],
    imageDrafts,
    imagePreviewUrls: getChatImagePreviews(chatScopeId, imageFileNames),
    nodes: projectChatNodes(state.nodes),
    dramaAssets: state.dramaAssets,
    skillOptions: projectSkillPickerOptions(state.userSkills, state.agentPackageSkills),
    mcpClientOptions: getMcpClientOptions(state.config.mcpClientConnections ?? []),
    composerDraft,
    composerDrafts: state.chatComposerDrafts,
    panelView: state.chatPanelView,
    promptSubmitShortcut: state.configHydrated ? normalizePromptSubmitShortcut(state.config.promptSubmitShortcut) : undefined,
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
    || current.config !== previous.config
    || current.configHydrated !== previous.configHydrated
    || current.nodes !== previous.nodes
    || current.dramaAssets !== previous.dramaAssets
    || current.userSkills !== previous.userSkills
    || current.agentPackageSkills !== previous.agentPackageSkills
    || current.chatComposerLiveDraft !== previous.chatComposerLiveDraft
    || current.chatComposerDrafts !== previous.chatComposerDrafts
    || current.chatImageDrafts !== previous.chatImageDrafts
    || current.chatPanelView !== previous.chatPanelView
    || current.workflows !== previous.workflows;
}

export function handleDetachedChatAction(
  action: ChatAction,
  requestSync: (immediate?: boolean, forceSnapshot?: boolean) => void,
): void {
  const store = useAppStore.getState();

  switch (action.type) {
    case 'preview_reference':
    case 'cancel_reference_preview':
      handleDetachedReferencePreviewAction(action);
      break;
    case 'open_mcp_client_settings':
      store.setSettingsOpen(true, 'mcp');
      if (isTauri) void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const main = getCurrentWindow();
        await main.show();
        await main.unminimize();
        await main.setFocus();
      }).catch(() => store.showToast('请在主窗口设置中管理 MCP 连接', 'info'));
      break;
    case 'set_mcp_connection': {
      const scopeId = store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
      if (action.scopeId !== scopeId) break;
      if (!store.config.mcpClientConnections?.some((item) => item.id === action.serverId && item.enabled)) break;
      if (action.conversationId && action.conversationId !== store.activeConversationId) break;
      const current = store.conversations.find((item) => item.id === store.activeConversationId && !item.deletedAt
        && item.projectId === seriesOwnerId(store.projects, scopeId));
      if (!action.conversationId && current && (pendingMcpSelection?.scopeId !== scopeId || pendingMcpSelection.conversationId !== current.id)) break;
      const created = !action.conversationId && !current;
      const conversationId = action.conversationId ?? current?.id ?? store.createConversation(scopeId);
      if (created) pendingMcpSelection = { scopeId, conversationId };
      const conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId && !item.deletedAt);
      if (conversation?.projectId !== seriesOwnerId(store.projects, scopeId)) break;
      if (created && action.draft !== undefined) store.setChatComposerLiveDraft(action.draft, conversationId);
      store.setConversationMcpServer(conversationId, action.serverId, action.enabled);
      requestSync(true);
      break;
    }
    case 'send_message': {
      if (!action.content.trim() && !action.imageFileNames?.length) break;
      if (action.conversationId && !store.conversations.some((item) => item.id === action.conversationId && !item.deletedAt)) break;
      const conversationId = action.conversationId
        ?? store.createConversation(store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
      if (conversationId !== store.activeConversationId) {
        store.setActiveConversation(conversationId);
      }
      const conversation = store.conversations.find(
        (item) => item.id === conversationId,
      );
      const submitted = submitConversationMessage({
        content: action.content,
        ...(action.imageFileNames !== undefined ? { imageFileNames: action.imageFileNames } : {}),
        projectId: store.currentProjectId && conversation?.projectId === seriesOwnerId(store.projects, store.currentProjectId)
          ? store.currentProjectId : conversation?.projectId ?? store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID,
        conversationId,
        mode: conversation?.agentMode ?? 'collaborative',
        dispatchMode: action.dispatchMode,
      });
      if (action.imageFileNames?.length) {
        store.setChatComposerLiveDraft(submitted?.status === 'ignored' ? action.content : '', conversationId);
        requestSync(true);
      }
      break;
    }

    case 'switch_conversation':
      store.setActiveConversation(action.conversationId);
      void store.loadConversationMessages(action.conversationId);
      break;

    case 'create_conversation':
      if (action.projectId === (store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID)) {
        store.createConversation(action.projectId, action.title);
      }
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

    case 'authorize_local_files': {
      const draft = action.draft ?? store.chatComposerLiveDraft;
      const conversationId = action.conversationId
        ?? store.createConversation(store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
      if (!action.conversationId && draft) store.setChatComposerLiveDraft(draft, conversationId);
      void attachConversationFiles(conversationId)
        .then((created) => {
          store.showToast(
            `已添加 ${created.images} 张参考图，授权 ${created.texts} 个文本文件${created.failed ? '；部分图片未添加，请检查格式、大小或数量上限' : ''}`,
            'info',
          );
        })
        .catch((error) => store.showToast(
          error instanceof Error ? error.message : '文件授权失败',
          'error',
        ));
      break;
    }

    case 'remove_image_attachment':
      store.removeChatImageDrafts(action.conversationId, [action.fileName]);
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

    case 'replan_agent_task': {
      try {
        // 先撤掉排队中的旧执行项，否则重新规划后它仍会被出队执行一次
        cancelScheduledAgentExecution(action.taskId);
        requestAgentReplan(action.taskId);
      } catch {
        store.showToast('该任务当前状态无法重新规划', 'error');
        break;
      }
      const result = resumeAgentTaskExecution(action.taskId);
      if (!result.ok) store.showToast(result.message ?? '无法重新规划该任务', 'error');
      break;
    }

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
      else {
        const project = store.projects.find((item) => item.id === store.currentProjectId);
        if (project) {
          void store.updateProjectSettings({
            ...project.settings,
            defaultModels: {
              ...project.settings?.defaultModels,
              text: action.modelId,
            },
          });
          break;
        }
        config.assistantModelId = action.modelId;
      }
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

    case 'set_composer_draft':
      store.setChatComposerLiveDraft(action.draft, action.conversationId);
      break;

    case 'set_panel_view':
      store.setChatPanelView(action.view);
      break;

    case 'set_prompt_submit_shortcut':
      if (!store.configHydrated || !PROMPT_SUBMIT_SHORTCUT_OPTIONS.some((option) => option.value === action.shortcut)) break;
      store.updateConfig({ promptSubmitShortcut: action.shortcut });
      void store.saveConfig({ silent: true }).catch(() => {});
      requestSync(true);
      break;

    case 'dock_window':
      if (action.composerDraft) store.setChatComposerLiveDraft(action.composerDraft.draft, action.composerDraft.conversationId);
      store.setHoveredMentionNodeId(null);
      store.setChatPanelDetached(false);
      store.openChat();
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
  let generation = 0;
  let cleanupListener: (() => void) | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let unsubscribeFileGrants: (() => void) | undefined;
  let unsubscribeImagePreviews: (() => void) | undefined;

  const resetSyncState = () => {
    generation += 1;
    // 已发出的旧帧可能还在路上，重新打开窗口时不能复用它的版本号。
    if (inFlight) revision += 1;
    pending = false;
    immediatePending = false;
    forceSnapshotPending = false;
    lastSnapshot = null;
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
    const startedGeneration = generation;

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
        if (disposed || generation !== startedGeneration) return;
        lastSnapshot = nextSnapshot;
        revision = nextRevision;
        consecutiveFailures = 0;
        return;
      }

      const nextRevision = revision + 1;
      forceSnapshotPending = false;
      await emitSync({ type: 'snapshot', revision: nextRevision, snapshot: nextSnapshot });
      if (disposed || generation !== startedGeneration) return;
      lastSnapshot = nextSnapshot;
      revision = nextRevision;
      consecutiveFailures = 0;
    } catch (error) {
      if (disposed || generation !== startedGeneration) return;
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
    unsubscribeImagePreviews = subscribeChatImagePreviews(() => sync());

    const listenerCleanup = await initListener(
      (action) => handleDetachedChatAction(action, sync),
      (draft) => {
        cancelMainReferencePreview();
        const store = useAppStore.getState();
        if (draft) store.setChatComposerLiveDraft(draft.draft, draft.conversationId);
        store.setHoveredMentionNodeId(null);
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
    cancelMainReferencePreview();
    resetSyncState();
    unsubscribeStore?.();
    unsubscribeStore = undefined;
    unsubscribeFileGrants?.();
    unsubscribeFileGrants = undefined;
    unsubscribeImagePreviews?.();
    unsubscribeImagePreviews = undefined;
    cleanupListener?.();
    cleanupListener = undefined;
  };

  return { start, dispose, sync };
}
