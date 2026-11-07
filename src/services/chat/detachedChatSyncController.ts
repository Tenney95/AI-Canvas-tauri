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
  emitTeamArtifactResponse,
  emitManagedChatResponse,
  emitChatSendResponse,
  hasChatStatePatchChanges,
  initMainWindowListener,
  type ChatAction,
  type ChatStateSnapshot,
  type ChatStateSync,
  type ChatComposerHandoff,
  type ChatManagedOperation,
  type ChatManagedResponse,
} from './chatWindowService';
import { getAssistantTextModelCandidates } from '../projectSettingsService';
import { projectSkillPickerOptions } from './skillCatalog';
import { normalizePromptSubmitShortcut, PROMPT_SUBMIT_SHORTCUT_OPTIONS } from '../../utils/promptSubmitShortcut';
import {
  attachConversationFiles, getChatImagePreviews, parseChatImageReferences,
  prepareChatImagePreviews, subscribeChatImagePreviews,
} from './chatImageReferenceService';
import { cancelMainReferencePreview, handleDetachedReferencePreviewAction } from './chatReferencePreviewService';
import { normalizeExecutionSelection, normalizeTeamProfile } from './teams/teamProfileService';
import { appendTeamInstruction, readTeamTaskArtifact } from './teams/teamInvocationService';
import { creationProfileOptions, previewCreationProfileOption, captureCreationProfile, resolveCreationTeamProfile } from '../creationProfiles/creationProfileService';
import { getExternalAgentCatalog, readExternalAgentCatalog } from './externalAgents/externalAgentService';
import { editTeamGraph } from './teams/teamRuntime';
import { resolveAgentDispatchOutcome } from './agentDurabilityService';
import { saveConversation } from './chatHistoryService';
import { sanitizeDomainText } from './subAgentMaterials';
import { configValuesEqual } from '../configPatch';
import { captureProjectWindowContext, isProjectWindowContextCurrent } from '../projectWindowContext';
import type { ProjectWindowFrame } from '../../types/projectWindow';

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
  agentTaskFocus: AppState['agentTaskFocus'];
  conversations: ChatConversation[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  agentTasks: AgentTask[];
  currentProjectId: string | null;
  projectLoadStatus: AppState['projectLoadStatus'];
  switchingProjectName: string | null;
  isCreatingProject: boolean;
  isReturningToStartPage: boolean;
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
  const selectedConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  let effectiveTeamProfile = state.config.agentTeamProfile ? normalizeTeamProfile(state.config.agentTeamProfile) : undefined;
  if (selectedConversation?.creationProfile || selectedConversation?.teamProfileOverride) {
    try { effectiveTeamProfile = resolveCreationTeamProfile(selectedConversation.creationProfile, selectedConversation.teamProfileOverride); }
    catch { /* 失效组合包由任务启动预检拒绝；展示仍保留可用配置。 */ }
  }
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
  const modelProject = selectedConversation?.workbenchTarget
    ? state.projects.find((item) => item.id === selectedConversation.workbenchTarget?.episodeId) : project;
  return {
    conversations,
    activeConversationId,
    messages: state.messages,
    agentTasks: projectChatAgentTasks(state.agentTasks),
    agentTaskFocus: state.agentTaskFocus,
    projectId: state.currentProjectId,
    projectName: project?.name,
    isEpisodeProject: !!project?.parentId,
    generalModels: state.config.generalModels ?? [],
    ...buildChatModelCatalog(state),
    assistantModelId: getAssistantTextModelCandidates(
      modelProject?.settings,
      state.config.assistantModelId,
    )[0],
    agentTeamProfile: effectiveTeamProfile,
    creationProfiles: creationProfileOptions(),
    externalAgents: readExternalAgentCatalog(),
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
    || current.agentTaskFocus !== previous.agentTaskFocus
    || current.conversations !== previous.conversations
    || current.activeConversationId !== previous.activeConversationId
    || current.messages !== previous.messages
    || current.agentTasks !== previous.agentTasks
    || current.currentProjectId !== previous.currentProjectId
    || current.projectLoadStatus !== previous.projectLoadStatus
    || current.switchingProjectName !== previous.switchingProjectName
    || current.isCreatingProject !== previous.isCreatingProject
    || current.isReturningToStartPage !== previous.isReturningToStartPage
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

/** 唯一宿主用户操作入口；子窗只传固定声明，不直接访问原生能力。 */
export async function executeManagedChatOperation(operation: ChatManagedOperation, scopeId: string,
  conversationId?: string, draft?: string, assertCurrent?: () => void): Promise<unknown> {
  const allowedKeys: Record<ChatManagedOperation['kind'], readonly string[]> = {
    preview_creation_profile: ['kind', 'profile'], apply_creation_profile: ['kind', 'selection'], save_team_profile: ['kind', 'profile'],
    refresh_external_agents: ['kind'], edit_team_graph: ['kind', 'taskId', 'graph', 'expected'],
    resolve_dispatch: ['kind', 'taskId', 'dispatchId', 'decision'], branch_conversation: ['kind', 'messageId'],
    team_result: ['kind', 'taskId', 'action'], amend_team_task: ['kind', 'taskId', 'instruction'],
  };
  if (!operation || typeof operation !== 'object' || !Object.hasOwn(allowedKeys, operation.kind)
    || Object.keys(operation).some((key) => !allowedKeys[operation.kind].includes(key))
    || typeof scopeId !== 'string' || scopeId.length > 160
    || (conversationId !== undefined && (typeof conversationId !== 'string' || conversationId.length > 160))
    || (draft !== undefined && (typeof draft !== 'string' || draft.length > 120000))) throw new Error('窗口操作参数无效');
  if (operation.kind === 'resolve_dispatch' && !['verified_completed', 'abandoned'].includes(operation.decision)) throw new Error('请选择明确的调用核实结果');
  if (operation.kind === 'team_result' && !['apply', 'restore', 'reconcile'].includes(operation.action)) throw new Error('团队成果操作无效');
  if (operation.kind === 'amend_team_task' && (typeof operation.instruction !== 'string' || operation.instruction.length > 4000)) throw new Error('补充要求超过上限');
  const assertScope = () => {
    assertCurrent?.();
    const state = useAppStore.getState();
    if ((state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID) !== scopeId) throw new Error('项目已变化，请刷新后重试');
    const owner = seriesOwnerId(state.projects, scopeId);
    const conversation = conversationId ? state.conversations.find((item) => item.id === conversationId && !item.deletedAt && item.projectId === owner) : undefined;
    if (conversationId && (!conversation || conversation.id === MCP_SETTINGS_CONVERSATION_ID)) throw new Error('会话已变化，请重新选择');
    return { state, conversation, owner };
  };
  const initial = assertScope();
  if (initial.conversation?.workbenchTarget
    && ['preview_creation_profile', 'apply_creation_profile', 'save_team_profile'].includes(operation.kind)) {
    throw new Error('请在剧本工作台调整本集创作组合配置');
  }
  if (operation.kind === 'refresh_external_agents') return getExternalAgentCatalog();
  if (operation.kind === 'preview_creation_profile') {
    const preview = await previewCreationProfileOption(operation.profile, scopeId);
    assertScope();
    return { ...preview, profile: { id: preview.profile.id, version: preview.profile.version, name: preview.profile.name } };
  }
  if (operation.kind === 'apply_creation_profile') {
    await captureCreationProfile(operation.selection ?? undefined, scopeId);
    let { state, conversation } = assertScope();
    if (!conversation) {
      if (state.activeConversationId !== initial.state.activeConversationId) throw new Error('会话已变化，请重新选择组合包');
      const id = state.createConversation(scopeId);
      state = useAppStore.getState(); conversation = state.conversations.find((item) => item.id === id);
      if (!conversation) throw new Error('会话尚未准备完成');
      await saveConversation(conversation);
      assertScope();
      if (draft !== undefined) state.setChatComposerLiveDraft(draft, id);
    }
    await useAppStore.getState().setConversationCreationProfile(conversation.id, operation.selection ?? undefined);
    return { conversationId: conversation.id };
  }
  if (operation.kind === 'save_team_profile') {
    const profile = normalizeTeamProfile(operation.profile);
    if (initial.conversation?.creationProfile) {
      await initial.state.setConversationCreationProfile(initial.conversation.id, initial.conversation.creationProfile,
        { teamProfileOverride: profile, executionSelection: initial.conversation.executionSelection });
    } else {
      const previous = initial.state.config.agentTeamProfile;
      initial.state.updateConfig({ agentTeamProfile: profile });
      try { await useAppStore.getState().saveConfig({ silent: true, throwOnError: true }); }
      catch (error) {
        if (configValuesEqual(useAppStore.getState().config.agentTeamProfile, profile)) useAppStore.getState().updateConfig({ agentTeamProfile: previous });
        throw error;
      }
    }
    return true;
  }
  if (operation.kind === 'branch_conversation') {
    if (!initial.conversation) throw new Error('请先选择来源会话');
    return initial.state.branchConversation(initial.conversation.id, operation.messageId);
  }
  const task = initial.state.agentTasks.find((entry) => entry.id === operation.taskId);
  const ownerConversation = initial.state.conversations.find((entry) => entry.id === task?.conversationId && !entry.deletedAt && entry.projectId === initial.owner);
  if (!task || !ownerConversation || (conversationId && task.conversationId !== conversationId)) throw new Error('任务不属于当前会话范围');
  switch (operation.kind) {
    case 'edit_team_graph': return editTeamGraph(task.id, operation.graph, operation.expected);
    case 'resolve_dispatch': return resolveAgentDispatchOutcome(task.id, operation.dispatchId, operation.decision);
    case 'amend_team_task': return appendTeamInstruction(task.id, operation.instruction);
    case 'team_result': {
      const service = await import('./teams/teamResultApplyService');
      assertScope();
      if (operation.action === 'apply') return service.applyTeamResult(task.id);
      if (operation.action === 'restore') return service.restoreTeamResult(task.id);
      return service.reconcileTeamResult(task.id);
    }
  }
}

const MANAGED_KINDS = new Set(['preview_creation_profile', 'apply_creation_profile', 'save_team_profile', 'refresh_external_agents',
  'edit_team_graph', 'resolve_dispatch', 'branch_conversation', 'team_result', 'amend_team_task']);
const managedRequests = new Map<string, { signature: string; result: Promise<ChatManagedResponse>; completed: boolean }>();

export function handleDetachedChatAction(
  action: ChatAction,
  requestSync: (immediate?: boolean, forceSnapshot?: boolean) => void,
  assertCurrent?: () => void,
): void {
  const store = useAppStore.getState();

  switch (action.type) {
    case 'managed_request': {
      if (!/^[A-Za-z0-9_-]{8,120}$/u.test(action.requestId) || !action.operation || !MANAGED_KINDS.has(action.operation.kind)) break;
      void (async () => {
        const encoded = new TextEncoder().encode(JSON.stringify(action));
        if (encoded.length > 128 * 1024) throw new Error('窗口请求超过上限');
        const digest = await crypto.subtle.digest('SHA-256', encoded);
        const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        assertCurrent?.();
        let accepted = managedRequests.get(action.requestId);
        if (accepted && accepted.signature !== signature) throw new Error('请求身份已变化');
        if (!accepted) {
          if (managedRequests.size >= 128) for (const [id, record] of managedRequests) { if (record.completed) { managedRequests.delete(id); break; } }
          if (managedRequests.size >= 128) throw new Error('主窗口正在处理过多请求');
          const result = executeManagedChatOperation(action.operation, action.scopeId, action.conversationId, action.draft, assertCurrent)
            .then((value): ChatManagedResponse => ({ requestId: action.requestId, scopeId: action.scopeId, conversationId: action.conversationId, value }),
              (error: unknown): ChatManagedResponse => ({ requestId: action.requestId, scopeId: action.scopeId, conversationId: action.conversationId,
                error: sanitizeDomainText(error instanceof Error ? error.message : '操作未完成').slice(0, 300) }));
          accepted = { signature, result, completed: false }; managedRequests.set(action.requestId, accepted);
          void result.finally(() => { const record = managedRequests.get(action.requestId); if (record) record.completed = true; });
        }
        const response = await accepted.result;
        requestSync(true);
        await emitManagedChatResponse(response);
      })().catch(() => emitManagedChatResponse({ requestId: action.requestId, scopeId: action.scopeId, conversationId: action.conversationId,
        error: '窗口操作未确认，请核对最新状态；未自动重试' }).catch(() => undefined));
      break;
    }
    case 'set_team_profile':
      store.updateConfig({ agentTeamProfile: normalizeTeamProfile(action.profile) });
      void store.saveConfig({ silent: true, throwOnError: true }).catch(() => store.showToast('团队配置未能保存，请重试', 'error'));
      requestSync(true);
      break;
    case 'set_execution_selection': {
      const scopeId = store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
      if (action.scopeId !== scopeId || (action.conversationId && action.conversationId !== store.activeConversationId)) break;
      const owner = seriesOwnerId(store.projects, scopeId);
      const current = store.conversations.find((item) => item.id === store.activeConversationId && item.projectId === owner && !item.deletedAt);
      const conversationId = action.conversationId ?? current?.id ?? store.createConversation(scopeId);
      const conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId && !item.deletedAt);
      if (conversation?.projectId !== owner || !conversation.id.startsWith('conv-') || conversation.workbenchTarget) break;
      store.updateConversation(conversationId, { executionSelection: normalizeExecutionSelection(action.selection) });
      if (!action.conversationId && action.draft !== undefined) store.setChatComposerLiveDraft(action.draft, conversationId);
      requestSync(true);
      break;
    }
    case 'read_team_artifact': {
      if (typeof action.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(action.requestId)) break;
      void readTeamTaskArtifact(action.taskId, action.artifactId)
        .then((text) => emitTeamArtifactResponse({ requestId: action.requestId, taskId: action.taskId,
          artifactId: action.artifactId, ...(text.length <= 120000 ? { text } : { error: '产物超过窗口预览上限，请在主窗口查看' }) }))
        .catch(() => emitTeamArtifactResponse({ requestId: action.requestId, taskId: action.taskId,
          artifactId: action.artifactId, error: '无法读取原任务产物，请检查项目与成果版本后重试' }).catch(() => {}));
      break;
    }
    case 'apply_team_result':
    case 'restore_team_result':
    case 'reconcile_team_result':
    case 'amend_team_task': {
      const scopeId = store.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
      const task = store.agentTasks.find((item) => item.id === action.taskId && item.executionKind === 'team');
      const conversation = store.conversations.find((item) => item.id === task?.conversationId && !item.deletedAt);
      if (!task || !conversation || conversation.projectId !== seriesOwnerId(store.projects, scopeId)) break;
      if (action.type === 'amend_team_task') {
        void appendTeamInstruction(action.taskId, action.instruction)
          .catch((error: unknown) => store.showToast(error instanceof Error ? error.message.slice(0, 300) : '补充要求未能应用', 'error'))
          .finally(() => requestSync(true));
        break;
      }
      void import('./teams/teamResultApplyService').then(async (service) => {
        assertCurrent?.();
        if (action.type === 'apply_team_result') await service.applyTeamResult(action.taskId);
        else if (action.type === 'restore_team_result') await service.restoreTeamResult(action.taskId);
        else store.showToast(await service.reconcileTeamResult(action.taskId), 'info');
      }).catch((error: unknown) => store.showToast(error instanceof Error ? error.message.slice(0, 300) : '团队成果操作未完成，请核对原任务', 'error'))
        .finally(() => requestSync(true));
      break;
    }
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
      if ((!action.content.trim() && !action.imageFileNames?.length)
        || (action.conversationId && !store.conversations.some((item) => item.id === action.conversationId && !item.deletedAt))) {
        void emitChatSendResponse(action.requestId, false).catch(() => {}); break;
      }
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
        executionSelection: action.executionSelection,
        requestId: action.requestId,
      });
      if (submitted?.status !== 'ignored') {
        store.setChatComposerLiveDraft('', conversationId);
        requestSync(true);
      }
      void emitChatSendResponse(action.requestId, submitted?.status !== 'ignored').catch(() => {});
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
        if (store.conversations.some((conversation) => conversation.id === store.activeConversationId
          && !conversation.deletedAt && conversation.workbenchTarget)) break;
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

    case 'close_window':
    case 'dock_window':
      if (action.composerDraft) store.setChatComposerLiveDraft(action.composerDraft.draft, action.composerDraft.conversationId);
      store.setHoveredMentionNodeId(null);
      void emitChatSendResponse(action.requestId, true).catch(() => {});
      if (action.type === 'dock_window') { store.setChatPanelDetached(false); store.openChat(); }
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
  let sessionId = crypto.randomUUID();
  let acceptedSequence = 0;
  const frames = new Map<number, ProjectWindowFrame>();
  let cleanupListener: (() => void) | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let unsubscribeFileGrants: (() => void) | undefined;
  let unsubscribeImagePreviews: (() => void) | undefined;

  const resetSyncState = () => {
    generation += 1;
    sessionId = crypto.randomUUID();
    acceptedSequence = 0;
    frames.clear();
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
      const conversation = state.conversations.find((item) => item.id === nextSnapshot.activeConversationId);
      const context = captureProjectWindowContext(state, conversation?.workbenchTarget?.episodeId);
      const nextFrame: ProjectWindowFrame | null = context ? { schemaVersion: 2, sessionId,
        revision: revision + 1, context, conversationId: nextSnapshot.activeConversationId } : null;
      nextSnapshot.windowFrame = nextFrame;
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
        if (nextFrame) frames.set(nextRevision, nextFrame);
        if (frames.size > 64) frames.delete(frames.keys().next().value!);
        await emitSync({ type: 'patch', baseRevision, revision: nextRevision, patch });
        if (disposed || generation !== startedGeneration) return;
        lastSnapshot = nextSnapshot;
        revision = nextRevision;
        consecutiveFailures = 0;
        return;
      }

      const nextRevision = revision + 1;
      forceSnapshotPending = false;
      if (nextFrame) frames.set(nextRevision, nextFrame);
      if (frames.size > 64) frames.delete(frames.keys().next().value!);
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
      const projectChanged = state.currentProjectId !== previous.currentProjectId;
      const contextReadinessChanged = state.projectLoadStatus !== previous.projectLoadStatus
        || state.switchingProjectName !== previous.switchingProjectName
        || state.isCreatingProject !== previous.isCreatingProject || state.isReturningToStartPage !== previous.isReturningToStartPage;
      sync(justDetached || projectChanged || contextReadinessChanged, justDetached || projectChanged || contextReadinessChanged);
    });
    unsubscribeFileGrants = subscribeFileGrants(() => sync());
    unsubscribeImagePreviews = subscribeChatImagePreviews(() => sync());

    const listenerCleanup = await initListener(
      (action) => {
        if (action?.type === 'request_sync') { sync(true, true); return; }
        const frame = action?.windowFrame;
        const published = frame && frames.get(frame.revision);
        const state = useAppStore.getState();
        const activeOwner = seriesOwnerId(state.projects, state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
        const activeConversationId = state.conversations.find((item) => item.id === state.activeConversationId
          && (item.projectId === activeOwner || item.id === MCP_SETTINGS_CONVERSATION_ID))?.id ?? null;
        const valid = frame?.schemaVersion === 2 && frame.sessionId === sessionId
          && !!published && JSON.stringify(frame) === JSON.stringify(published)
          && Number.isSafeInteger(action.sequence) && action.sequence! > acceptedSequence
          && frame.conversationId === activeConversationId
          && isProjectWindowContextCurrent(frame.context, state);
        if (!valid || !frame) {
          // 拒绝旧/过期协议，不把旧输入或任务动作补绑到当前项目。
          if (action?.type === 'managed_request') void emitManagedChatResponse({ requestId: action.requestId,
            scopeId: action.scopeId, conversationId: action.conversationId,
            error: '窗口上下文已变化，请刷新后核对；草稿仍保留，未自动重试' }).catch(() => {});
          if (action?.type === 'read_team_artifact') void emitTeamArtifactResponse({ requestId: action.requestId,
            taskId: action.taskId, artifactId: action.artifactId, error: '窗口上下文已变化，请重新打开原任务' }).catch(() => {});
          if (['send_message', 'dock_window', 'close_window'].includes(action?.type)) void emitChatSendResponse('requestId' in action ? action.requestId : undefined, false).catch(() => {});
          sync(true, true);
          return;
        }
        acceptedSequence = action.sequence!;
        const ownerId = frame.context.target.kind === 'global' ? GENERAL_ASSISTANT_SCOPE_ID : frame.context.target.projectId;
        if ('conversationId' in action && action.conversationId
          && !state.conversations.some((item) => item.id === action.conversationId && !item.deletedAt
            && (item.projectId === ownerId || item.id === MCP_SETTINGS_CONVERSATION_ID))) { sync(true, true); return; }
        if ('taskId' in action) {
          const task = state.agentTasks.find((item) => item.id === action.taskId);
          const conversation = state.conversations.find((item) => item.id === task?.conversationId && !item.deletedAt);
          if (!task || !conversation || conversation.projectId !== ownerId) { sync(true, true); return; }
        }
        if ((action.type === 'dock_window' || action.type === 'close_window') && action.composerDraft
          && (action.composerDraft.conversationId !== frame.conversationId
            || JSON.stringify(action.composerDraft.windowFrame) !== JSON.stringify(frame))) {
          void emitChatSendResponse(action.requestId, false).catch(() => {}); sync(true, true); return;
        }
        const assertCurrent = () => {
          if (!isProjectWindowContextCurrent(frame.context, useAppStore.getState())) throw new Error('窗口上下文已变化，已停止原操作');
        };
        handleDetachedChatAction(action, sync, assertCurrent);
      },
      (draft) => {
        cancelMainReferencePreview();
        const store = useAppStore.getState();
        if (draft?.windowFrame?.sessionId === sessionId
          && JSON.stringify(frames.get(draft.windowFrame.revision)) === JSON.stringify(draft.windowFrame)
          && draft.conversationId === draft.windowFrame.conversationId
          && isProjectWindowContextCurrent(draft.windowFrame.context, store)) {
          const conversation = draft.conversationId && store.conversations.find((item) => item.id === draft.conversationId && !item.deletedAt);
          if (!draft.conversationId || conversation) store.setChatComposerLiveDraft(draft.draft, draft.conversationId);
        }
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
