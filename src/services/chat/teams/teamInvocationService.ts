/** 助手与剧本工作台共用团队发起、排队与恢复入口；主窗口是唯一执行源。 */
import { useAppStore } from '../../../store/useAppStore';
import { seriesOwnerId } from '../../../store/store.utils';
import type { AgentMode, AgentTask } from '../../../types/agent';
import type { AgentTeamProfile, TeamInvocationContext, TeamTemplateId } from '../../../types/agentTeam';
import type { ChatMessage } from '../../../types/chat';
import { GENERAL_ASSISTANT_SCOPE_ID, isGeneralAssistantScope } from '../assistantScope';
import { loadAgentTask, saveAgentTask } from '../agentTaskService';
import { pauseAgentTask, prepareAgentTaskResume, runAgentTask, transitionAgentTask, validateTaskResumable } from '../agentTaskControl';
import { scheduleConversationAgentExecution } from '../agentScheduler';
import { saveConversation } from '../chatHistoryService';
import { extractMentionedNodeIds, sanitizeDomainText } from '../subAgentMaterials';
import { MAX_INTERJECTION_CHARS } from '../agentInterjection';
import { isWorkbenchTeamTaskInScope, readEpisodeWorkspaceScope } from '../../episodeWorkspaceScope';
import { hashTeamText, readTeamArtifactText } from './teamArtifactService';
import { normalizeTeamProfile, TEAM_TEMPLATE_LABELS } from './teamProfileService';
import { amendTeamRun, captureTeamModelFingerprints, executeTeamRun, MAX_TEAM_INPUT_CHARS, prepareTeamRun, waitForTeamRunIdle } from './teamRuntime';
import { captureCreationProfile, intersectCreationTools, resolveCreationTeamProfile } from '../../creationProfiles/creationProfileService';
import { captureExplicitSkillBindings, expandSkillBindings, SKILL_CONTENT_LIMITS } from '../../skillPromptService';
import { assertAgentProjectContext, captureAgentProjectScope } from '../agentProjectContext';

export interface TeamInvocationInput {
  content: string;
  projectId?: string;
  conversationId?: string;
  mode?: AgentMode;
  templateId: TeamTemplateId;
  context?: TeamInvocationContext;
  materials?: string;
  originalText?: string;
  requestId?: string;
  profile?: AgentTeamProfile;
  onProgress?: () => void;
}

export interface TeamInvocationResult {
  taskId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

interface PendingInvocation {
  result: TeamInvocationResult;
  ready: Promise<void>;
  signature: string;
  cancellation: { canceled: boolean };
}

// 主窗口一次 JS 调用即登记请求，覆盖双击和独立窗口重复转发；落盘后以稳定 taskId 复核。
const invocations = new Map<string, PendingInvocation>();

/** 清空消息/移除对话也撤销尚未创建任务的异步准备，不让迟到回调开始付费调用。 */
export function cancelPendingTeamInvocations(conversationId: string): void {
  for (const invocation of invocations.values()) {
    if (invocation.result.conversationId === conversationId) invocation.cancellation.canceled = true;
  }
}

function assertMainWindow(): void {
  const view = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('view');
  if (view && view !== 'main') {
    throw new Error('请通过主窗口发起团队任务');
  }
}

function explicitNodeMaterials(content: string, projectId: string): string {
  const ids = extractMentionedNodeIds(content);
  if (!ids.length) return '';
  const state = useAppStore.getState();
  if (isGeneralAssistantScope(projectId) || state.currentProjectId !== projectId) {
    throw new Error('请先打开被引用节点所属的项目');
  }
  return ids.map((id) => {
    const node = state.nodes.find((item) => item.id === id);
    if (!node) throw new Error('引用节点已不存在，请重新选择材料');
    const data = node.data as Record<string, unknown>;
    const body = [data.output, data.prompt].filter((value): value is string => typeof value === 'string').join('\n\n');
    return `【用户显式引用节点 ${id}】\n${sanitizeDomainText(body)}`;
  }).join('\n\n');
}

function summarizeTask(task: AgentTask): string {
  if (task.status === 'completed') return '团队已完成本轮协作，请在任务详情查看候选、审阅和裁决。候选尚未自动应用。';
  if (task.status === 'paused') return '团队已暂停，已完成成果保留。请查看任务详情中的原因后继续。';
  if (task.status === 'stopped') return '团队任务已停止，已完成成果保留。';
  if (task.status === 'failed') return '团队本轮未完成，已完成成果保留。请在任务详情查看原因。';
  return '团队任务已接受，正在准备或等待执行。';
}

function updateTeamMessage(taskId: string, messageId: string): void {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === taskId);
  const message = state.messages.find((item) => item.id === messageId && item.agentTaskId === taskId);
  if (!task || !message || task.conversationId !== message.conversationId) return;
  const active = ['queued', 'planning', 'running', 'waiting_tool', 'waiting_approval'].includes(task.status);
  state.updateMessage(messageId, {
    content: summarizeTask(task),
    status: active ? task.status === 'queued' ? 'queued' : 'executing' : task.status === 'failed' ? 'error' : 'done',
    finishReason: active ? undefined : task.status === 'failed' ? 'error' : task.status === 'stopped' ? 'canceled' : 'stop',
  });
}

export function scheduleTeamTaskExecution(taskId: string, messageId: string, onProgress?: () => void): void {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task?.teamRun || task.executionKind !== 'team') throw new Error('团队输入快照尚未准备完成');
  const scheduled = scheduleConversationAgentExecution({
    taskId, conversationId: task.conversationId,
    run: async () => {
      const current = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
      if (!current || current.status !== 'queued') return;
      useAppStore.getState().updateMessage(messageId, { status: 'executing' });
      await runAgentTask(taskId, (signal) => executeTeamRun(taskId, signal));
      updateTeamMessage(taskId, messageId);
      onProgress?.();
    },
    onError: () => {
      const state = useAppStore.getState();
      const current = state.agentTasks.find((item) => item.id === taskId);
      if (current && !['paused', 'stopped', 'completed'].includes(current.status)) {
        if (current.status === 'queued') transitionAgentTask(taskId, 'planning');
        transitionAgentTask(taskId, 'failed', { errorCode: 'TEAM_SCHEDULE_FAILED', errorMessage: '团队执行未完成，请查看保留的成果后继续' });
      }
      updateTeamMessage(taskId, messageId);
      onProgress?.();
    },
  });
  if (scheduled.state === 'queued') useAppStore.getState().updateMessage(messageId, { status: 'queued' });
}

function acceptInvocation(input: TeamInvocationInput): PendingInvocation {
  assertMainWindow();
  const state = useAppStore.getState();
  const content = input.content.trim();
  if (!content || content.length > 30000) throw new Error('请输入团队目标，目标文字最多 30000 字符');
  if (!Object.hasOwn(TEAM_TEMPLATE_LABELS, input.templateId)) throw new Error('团队模板无效');
  const requestId = input.requestId ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) throw new Error('团队发起请求身份无效');
  const projectId = input.projectId ?? state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
  const context = structuredClone(input.context ?? { source: 'assistant' as const });
  const workbenchScope = context.source === 'script-workbench' && context.target?.episodeId === projectId
    ? readEpisodeWorkspaceScope(state, projectId) : null;
  if (!isGeneralAssistantScope(projectId) && (!state.projects.some((item) => item.id === projectId)
    || (state.currentProjectId !== projectId && !workbenchScope) || state.projectLoadStatus !== 'ready')) {
    throw new Error('请先打开团队任务所属项目');
  }
  const ownerId = seriesOwnerId(state.projects, projectId);
  let conversation = state.conversations.find((item) => item.id === input.conversationId && !item.deletedAt);
  if (input.conversationId && (!conversation || conversation.projectId !== ownerId || !conversation.id.startsWith('conv-'))) {
    throw new Error('来源对话与任务项目不一致');
  }
  if (context.target && (isGeneralAssistantScope(projectId) || context.target.episodeId !== projectId
    || context.target.seriesId !== ownerId || (workbenchScope && context.target.seriesId !== workbenchScope.owner.id))) {
    throw new Error('团队成果目标与当前分集不一致');
  }
  const projectScope = captureAgentProjectScope(state, { projectId,
    ...(context.target ? { teamRun: { target: context.target } } : {}) });
  const assertCurrent = () => assertAgentProjectContext(useAppStore.getState(), { projectId, projectScope }, { checkRevision: false });
  assertCurrent();
  if (!conversation) conversation = state.conversations.find((item) => item.id === state.activeConversationId
    && item.projectId === ownerId && !item.deletedAt && item.id.startsWith('conv-'));
  const creationOwner = context.source === 'script-workbench'
    ? state.projects.find((item) => item.id === projectId && !!item.parentId) : conversation;
  const creationSelection = creationOwner?.creationProfile ? structuredClone(creationOwner.creationProfile) : undefined;
  const profile = normalizeTeamProfile(structuredClone(input.profile
    ?? resolveCreationTeamProfile(creationSelection, creationOwner?.teamProfileOverride)));
  const materials = input.materials ?? explicitNodeMaterials(content, projectId);
  if (content.length + materials.length > MAX_TEAM_INPUT_CHARS) throw new Error('团队目标与材料超过总上限，请按场景或章节拆分，不会截断原稿');
  const signature = JSON.stringify({ projectId, conversationId: input.conversationId, content,
    profile, creationSelection, templateId: input.templateId, context, materials, originalText: input.originalText, mode: input.mode });
  const previous = invocations.get(requestId);
  if (previous) {
    if (previous.signature !== signature) throw new Error('同一请求身份不能用于不同的团队任务');
    return previous;
  }
  if (!conversation) {
    const active = state.conversations.find((item) => item.id === state.activeConversationId && item.projectId === ownerId
      && !item.deletedAt && item.id.startsWith('conv-'));
    const conversationId = active?.id ?? state.createConversation(projectId, '团队创作');
    conversation = useAppStore.getState().conversations.find((item) => item.id === conversationId)!;
  }
  const mode = input.mode ?? (context.source === 'script-workbench' ? 'collaborative' : conversation.agentMode);
  const taskId = `team-${requestId}`;
  const result: TeamInvocationResult = { taskId, conversationId: conversation.id,
    userMessageId: `msg-${requestId}-user`, assistantMessageId: `msg-${requestId}-team` };
  const now = Date.now();
  const addMessage = (message: ChatMessage) => {
    if (!useAppStore.getState().messages.some((item) => item.id === message.id)) useAppStore.getState().addMessage(message);
  };
  addMessage({ id: result.userMessageId, conversationId: conversation.id, role: 'user', content, timestamp: now, status: 'done' });
  addMessage({ id: result.assistantMessageId, conversationId: conversation.id, role: 'assistant',
    content: '正在准备团队任务快照。', timestamp: now + 1, status: 'queued', agentTaskId: taskId });
  const frozen = { ...input, content, projectId, context, profile, materials, mode, conversationId: conversation.id };
  const cancellation = { canceled: false };
  const sourceAvailable = () => {
    if (cancellation.canceled) return false;
    assertCurrent();
    return useAppStore.getState().conversations.some((item) => item.id === frozen.conversationId && !item.deletedAt && item.projectId === ownerId);
  };
  const ready = (async () => {
    const creation = await captureCreationProfile(creationSelection, projectId);
    if (!sourceAvailable()) return;
    const explicitSkills = captureExplicitSkillBindings(content, [...state.userSkills, ...state.agentPackageSkills]);
    const skillBindings = [...new Map([...explicitSkills, ...creation.skillBindings].map((binding) => [binding.skillId, binding])).values()];
    if (skillBindings.length > SKILL_CONTENT_LIMITS.maxExplicitBindings
      || skillBindings.reduce((size, binding) => size + binding.content.length, 0) > SKILL_CONTENT_LIMITS.expansionTotalChars) throw new Error('团队 Skill 总量超出上限，请减少本次引用或组合包选择');
    const fingerprintsPromise = captureTeamModelFingerprints(projectId, profile, input.templateId)
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    let runContext = context;
    let runMaterials = materials;
    let originalText = frozen.originalText;
    const episode = state.projects.find((item) => item.id === projectId && !!item.parentId);
    if (!context.target && context.source === 'assistant' && input.templateId !== 'general' && episode) {
      const { captureEpisodeTeamContext } = await import('./teamResultApplyService');
      const captured = await captureEpisodeTeamContext(projectId, input.templateId === 'outline' ? 'outline' : 'script');
      runContext = { ...captured.context, source: 'assistant' };
      runMaterials = [captured.materials, materials].filter(Boolean).join('\n\n');
      originalText = captured.originalText;
    }
    if (skillBindings.length) runMaterials = [runMaterials, expandSkillBindings(content, skillBindings)].filter(Boolean).join('\n\n');
    if (content.length + runMaterials.length > MAX_TEAM_INPUT_CHARS) throw new Error('材料超过团队总上限，请按场景拆分任务');
    const digest = await hashTeamText(JSON.stringify({ signature, context: runContext, materials: runMaterials, originalText }));
    const existing = useAppStore.getState().agentTasks.find((item) => item.id === taskId) ?? await loadAgentTask(taskId);
    if (!sourceAvailable()) return;
    if (existing) {
      // 已接受的请求只返回原状态，重启或断线后的同 key 不自动重新调用模型。
      if (existing.projectId !== projectId || existing.conversationId !== conversation!.id
        || existing.executionKind !== 'team' || existing.teamRequestDigest !== digest) {
        throw new Error('团队请求已绑定其他内容，请核对原任务');
      }
      useAppStore.getState().upsertAgentTask(existing);
      await fingerprintsPromise;
      updateTeamMessage(taskId, result.assistantMessageId);
      return;
    }
    const captured = await fingerprintsPromise;
    if (!sourceAvailable()) return;
    if ('error' in captured) throw captured.error;
    const modelFingerprints = captured.value;
    const currentConversation = useAppStore.getState().conversations.find((item) => item.id === frozen.conversationId && !item.deletedAt);
    if (!currentConversation || currentConversation.projectId !== ownerId) throw new Error('来源对话已移除');
    await saveConversation(currentConversation);
    if (!sourceAvailable()) return;
    const task = useAppStore.getState().createAgentTask({ taskId, executionKind: 'team', teamRequestDigest: digest,
      projectId, conversationId: frozen.conversationId, userMessageId: result.userMessageId,
      mode, goal: sanitizeDomainText(content).slice(0, 160),
      budget: { maxModelRounds: profile.maxCalls, maxTotalModelRounds: profile.maxCalls,
        maxTotalTokens: profile.maxTotalTokens, maxParallelReadTools: 2 },
      toolAllowlist: intersectCreationTools(['agent_team_apply_result', 'agent_team_restore_result'], creation.snapshot?.toolAllowlist),
      creationProfile: creation.snapshot, skillBindings,
    });
    await saveAgentTask(task);
    const teamRun = await prepareTeamRun({ taskId, projectId, conversationId: frozen.conversationId,
      prompt: content, profile, templateId: frozen.templateId, context: runContext, materials: runMaterials,
      originalText, modelFingerprints, assertCurrent,
    });
    const current = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
    if (!current) return;
    assertCurrent();
    const preparedScope = captureAgentProjectScope(useAppStore.getState(), { ...current, teamRun });
    assertAgentProjectContext(useAppStore.getState(), { ...current, projectScope: preparedScope }, { checkRevision: false });
    useAppStore.getState().updateAgentTask(taskId, { teamRun, projectScope: preparedScope });
    await saveAgentTask(useAppStore.getState().agentTasks.find((item) => item.id === taskId)!);
    if (!sourceAvailable() || useAppStore.getState().agentTasks.find((item) => item.id === taskId)?.status !== 'queued') return;
    scheduleTeamTaskExecution(taskId, result.assistantMessageId, frozen.onProgress);
  })();
  const accepted = { result, ready, signature, cancellation };
  invocations.set(requestId, accepted);
  // 防止长时间运行的桌面进程积累调用材料；持久 taskId 仍是后续核对依据。
  void ready.finally(() => { if (invocations.get(requestId) === accepted) invocations.delete(requestId); }).catch(() => {});
  return accepted;
}

function reportStartFailure(result: TeamInvocationResult, error: unknown): void {
  const state = useAppStore.getState();
  const text = sanitizeDomainText(error instanceof Error ? error.message : '团队任务未能开始').slice(0, 300);
  const task = state.agentTasks.find((item) => item.id === result.taskId);
  if (task?.status === 'queued') {
    // 启动准备失败也通过合法状态机，不把仍在排队的任务直接伪装为执行完成。
    transitionAgentTask(task.id, 'planning');
    transitionAgentTask(task.id, 'failed', { errorCode: 'TEAM_PREPARE_FAILED', errorMessage: text });
  }
  const message = state.messages.find((item) => item.id === result.assistantMessageId);
  if (message) state.updateMessage(message.id, { content: `团队未能开始：${text}`, status: 'error', finishReason: 'error' });
  state.showToast(text, 'error');
}

/** 同步返回消息与任务身份，文件准备完成后才进入模型队列。 */
export function submitTeamInvocation(input: TeamInvocationInput): TeamInvocationResult {
  const accepted = acceptInvocation(input);
  void accepted.ready.catch((error) => { if (!accepted.cancellation.canceled) reportStartFailure(accepted.result, error); });
  return accepted.result;
}

/** 工作台等待输入快照真实保存，返回并不代表模型任务已完成。 */
export async function startTeamInvocation(input: TeamInvocationInput): Promise<TeamInvocationResult> {
  const accepted = acceptInvocation(input);
  try { await accepted.ready; return accepted.result; }
  catch (error) {
    if (accepted.cancellation.canceled) return accepted.result;
    reportStartFailure(accepted.result, error); throw error;
  }
}

export function resumeTeamInvocation(taskId: string): void {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === taskId);
  if (task?.executionKind !== 'team' || !task.teamRun) throw new Error('团队准备未完成，缺少可恢复输入快照');
  const validation = validateTaskResumable(taskId);
  if (!validation.ok) throw new Error(validation.message ?? '团队当前不能继续');
  const message = state.messages.find((item) => item.agentTaskId === taskId && item.role === 'assistant');
  if (!message) throw new Error('来源消息未加载，请先打开原对话');
  state.updateAgentTask(taskId, { resumeCount: (task.resumeCount ?? 0) + 1 });
  prepareAgentTaskResume(taskId);
  scheduleTeamTaskExecution(taskId, message.id);
}

/** 先结束只读角色调用，再在稳定边界保存新要求；总调用预算与已有成果不重置。 */
export async function appendTeamInstruction(taskId: string, instruction: string): Promise<void> {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > MAX_INTERJECTION_CHARS) {
    throw new Error(`补充要求需为 1–${MAX_INTERJECTION_CHARS} 字符`);
  }
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId && item.executionKind === 'team');
  if (!task?.teamRun) throw new Error('团队尚在准备，请稍后追加要求');
  if (['planning', 'running', 'waiting_tool'].includes(task.status)) pauseAgentTask(taskId, 'team_amending');
  await waitForTeamRunIdle(taskId);
  await amendTeamRun(taskId, instruction);
  resumeTeamInvocation(taskId);
}

/** 只打开原任务；不会把它再塞回输入框或重新发起模型调用。 */
export async function openAgentTaskInAssistant(taskId: string): Promise<void> {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === taskId);
  if (!task) throw new Error('任务不存在');
  const owner = seriesOwnerId(state.projects, state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID);
  const conversation = state.conversations.find((item) => item.id === task.conversationId && item.projectId === owner && !item.deletedAt);
  if (!conversation) throw new Error('请先回到任务所属项目再查看');
  state.setActiveConversation(task.conversationId);
  await state.loadConversationMessages(task.conversationId);
  const latest = useAppStore.getState();
  if (seriesOwnerId(latest.projects, latest.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID) !== owner
    || latest.activeConversationId !== task.conversationId
    || !latest.conversations.some((item) => item.id === conversation.id && !item.deletedAt)
    || !latest.agentTasks.some((item) => item.id === taskId)) return;
  latest.focusAgentTask(taskId);
  latest.setChatPanelView(task.executionKind === 'team' ? 'tasks' : 'chat');
  if (latest.chatPanelDetached) {
    const { openDetachedChatWindow } = await import('../chatWindowLifecycle');
    await openDetachedChatWindow();
  } else {
    useAppStore.getState().openChat();
    if (typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const mainWindow = getCurrentWindow();
      await mainWindow.show().catch(() => {});
      await mainWindow.unminimize().catch(() => {});
      await mainWindow.setFocus().catch(() => {});
    }
  }
}

export const openTeamTaskInAssistant = openAgentTaskInAssistant;

/** 对外只接受任务/产物 ID，不接受窗口提交的路径、摘要或任意文件引用。 */
export async function readTeamTaskArtifact(taskId: string, artifactId: string): Promise<string> {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === taskId && item.executionKind === 'team');
  const scope = state.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID;
  const conversation = state.conversations.find((item) => item.id === task?.conversationId && !item.deletedAt);
  if (!task?.teamRun || !conversation || conversation.projectId !== seriesOwnerId(state.projects, scope)) {
    throw new Error('任务不属于当前项目范围');
  }
  const artifact = task.teamRun.artifacts.find((item) => item.id === artifactId);
  if (!artifact || artifact.kind === 'input') throw new Error('该产物不可在任务详情中读取');
  const text = await readTeamArtifactText(task.projectId, artifact);
  const current = useAppStore.getState();
  const latestTask = current.agentTasks.find((item) => item.id === taskId && item.teamRun?.id === task.teamRun!.id);
  if (((current.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID) !== scope
      && (!latestTask || !isWorkbenchTeamTaskInScope(current, latestTask)))
    || !latestTask?.teamRun?.artifacts.some((item) => item.id === artifact.id && item.sha256 === artifact.sha256)
    || !current.conversations.some((item) => item.id === conversation.id && !item.deletedAt
      && item.projectId === seriesOwnerId(current.projects, current.currentProjectId ?? GENERAL_ASSISTANT_SCOPE_ID))) {
    throw new Error('项目或任务已经变化，请重新查看成果');
  }
  return text;
}
