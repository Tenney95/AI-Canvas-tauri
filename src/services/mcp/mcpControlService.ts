/**
 * mcpControlService — 将 MCP 请求映射到主窗口工具、策略与审计任务。
 */
import { clearSkillReadTask } from '../chat/skillReadService';
import { clearSkillCatalogTask } from '../chat/skillCatalog';
import { t } from '../../i18n';
/**
 * MCP 前端控制层，将本地 bridge 请求映射到受 Policy 约束的 Agent 工具和专用审计任务。
 */
import { useAppStore } from '../../store/useAppStore';
import type { CreateAgentTaskInput } from '../../store/store.agent';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import type { AgentStep, AgentTask, McpOperationIdentity, McpOperationReceipt } from '../../types/agent';
import type { ProjectExpectedContext } from '../../types/project';
import { captureLegacyEpisodeContext, captureLegacyProjectExpectedContext, isProjectExpectedContextCurrent } from '../projectExecutionContext';
import { validateAgentToolInput } from '../chat/agentToolSchemas';
import { getMcpProjectContextRequirement, isMcpProjectContextCompatible } from './mcpProjectContext';
import type {
  McpBridgeRequestEvent,
  McpToolCallResult,
  McpToolDescriptor,
  McpToolExposure,
  McpToolCallEnvelope,
} from '../../types/mcp';
import {
  runAgentTask,
  stopAgentTask,
  transitionAgentTask,
  waitForAgentApproval,
} from '../chat/agentTaskControl';
import {
  getAgentTool,
  getAvailableAgentTools,
} from '../chat/toolRegistry';
import {
  listenForMcpBridgeRequests,
  respondToMcpBridge,
} from './mcpBridgeService';
import {
  buildMcpToolOverview,
  decodeMcpToolCallEnvelope,
  getConfiguredMcpToolExposure,
  isMcpDiscoveryTool,
  MCP_CALL_DESCRIPTOR,
  MCP_CALL_TOOL_NAME,
  MCP_DISCOVERY_TOOL_NAMES,
  toMcpToolDescriptor,
} from './mcpToolCatalog';

import {
  isMcpGlobalTool,
  isMcpSettingsContext,
  isMcpSettingsTool,
  MCP_GLOBAL_TOOL_NAMES,
  MCP_PROJECT_NAVIGATION_TOOL_NAMES,
  MCP_SETTINGS_CONVERSATION_ID,
  MCP_SETTINGS_SCOPE_ID,
  MCP_SETTINGS_TOOL_NAMES,
} from './mcpSettingsScope';
import {
  claimMcpOperation, finishMcpOperation, getHistoricalMcpOperationReceipt, identifyMcpOperation, readMcpOperation, startMcpOperation,
} from './mcpOperationService';

const MCP_CONVERSATION_TITLE = 'MCP 控制';
const MCP_EXECUTION_MODE = 'autonomous' as const;

/**
 * 工具发现时没有真实 AgentTask，只能给一个占位 ID。
 *
 * 因此工具的 isAvailable 不得依赖 context.taskId 去查任务：发现阶段查不到任务，
 * 会让该工具从 MCP 列表里静默消失。需要任务上下文的判断请放在 authorize 里。
 */
export const MCP_TOOL_DISCOVERY_TASK_ID = 'mcp-tool-discovery';

interface ActiveMcpRequest {
  sessionId: string;
  taskId?: string;
  cancelled: boolean;
}

const activeRequestTasks = new Map<string, ActiveMcpRequest>();
// 取消可能先于工具注册/原请求到达；在途记录独立保留标记，墓碑只覆盖迟到请求。
const cancellationTtlMs = 15 * 60 * 1_000;
const cancelledRequests = new Map<string, number>();
const cancelledSessions = new Map<string, number>();
const maxCancelledRequests = 512;
const maxCancelledSessions = 64;
let settingsAuditInitialization: Promise<void> | undefined;

function requestKey(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId]);
}

function pruneCancellations(entries: Map<string, number>): void {
  const now = Date.now();
  for (const [key, expiresAt] of entries) {
    if (expiresAt <= now) entries.delete(key);
  }
}

function rememberCancellation(entries: Map<string, number>, key: string, limit: number): void {
  pruneCancellations(entries);
  entries.delete(key);
  entries.set(key, Date.now() + cancellationTtlMs);
  while (entries.size > limit) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

function assertMcpRequestActive(request: McpBridgeRequestEvent, active: ActiveMcpRequest): void {
  pruneCancellations(cancelledRequests);
  pruneCancellations(cancelledSessions);
  if (active.cancelled || cancelledRequests.has(requestKey(request.sessionId, request.requestId))
    || cancelledSessions.has(request.sessionId)) {
    active.cancelled = true;
    throw new Error('MCP 请求已取消；已提交的操作仍需核对实际状态。');
  }
}

function cancelActiveRequest(active: ActiveMcpRequest): void {
  active.cancelled = true;
  if (!active.taskId) return;
  const task = useAppStore.getState().agentTasks.find((item) => item.id === active.taskId);
  // 取消只中止尚在运行/等待的阶段，不把已完成的外部副作用改写成已撤销。
  if (!task || ['completed', 'failed', 'stopped'].includes(task.status)) return;
  stopAgentTask(active.taskId);
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeAuditSummary(value: string): string {
  return value
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[已脱敏密钥]')
    .replace(/\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, '[已脱敏凭据]')
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, '[本地路径]')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '[本地路径]')
    .slice(0, 500);
}

async function ensureToolsRegistered(): Promise<void> {
  const { ensureAgentToolsRegistered } = await import('../chat/tools');
  ensureAgentToolsRegistered();
}

export function ensureMcpControlConversation(
  projectId: string,
): ChatConversation {
  const store = useAppStore.getState();
  const id = `mcp-control-${projectId}`;
  const existing = store.conversations.find((conversation) => conversation.id === id);
  if (existing) {
    if (existing.archived || existing.deletedAt || existing.agentMode !== MCP_EXECUTION_MODE) {
      const updated = {
        archived: false,
        deletedAt: undefined,
        agentMode: MCP_EXECUTION_MODE,
      };
      store.updateConversation(id, updated);
      return { ...existing, ...updated };
    }
    return existing;
  }
  const now = Date.now();
  const conversation: ChatConversation = {
    id,
    projectId,
    title: projectId === MCP_SETTINGS_SCOPE_ID ? 'MCP 全局控制' : MCP_CONVERSATION_TITLE,
    titleSource: 'user',
    pinned: true,
    archived: false,
    agentMode: MCP_EXECUTION_MODE,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  store.addConversation(conversation);
  return conversation;
}

function getCurrentMcpContext(toolName?: string): {
  projectId: string;
  conversation: ChatConversation;
  toolAllowlist?: string[];
} | null {
  const activeProject = useAppStore.getState().currentProjectId;
  const globalControl = !activeProject
    ? !toolName || isMcpGlobalTool(toolName)
    : Boolean(toolName && isMcpGlobalTool(toolName) && !isMcpDiscoveryTool(toolName));
  if (!activeProject && !globalControl) return null;
  const projectId = globalControl ? MCP_SETTINGS_SCOPE_ID : activeProject!;
  const toolAllowlist = !toolName || isMcpDiscoveryTool(toolName)
    ? MCP_GLOBAL_TOOL_NAMES
    : isMcpSettingsTool(toolName) ? MCP_SETTINGS_TOOL_NAMES : MCP_PROJECT_NAVIGATION_TOOL_NAMES;
  return {
    projectId,
    conversation: ensureMcpControlConversation(projectId),
    ...(globalControl ? { toolAllowlist: [...toolAllowlist] } : {}),
  };
}

export async function listMcpTools(
  exposure: McpToolExposure = getConfiguredMcpToolExposure(useAppStore.getState().config.mcpToolExposure),
): Promise<McpToolDescriptor[]> {
  await ensureToolsRegistered();
  const store = useAppStore.getState();
  const projectId = store.currentProjectId ?? MCP_SETTINGS_SCOPE_ID;
  const discoveryContext = {
    taskId: MCP_TOOL_DISCOVERY_TASK_ID,
    projectId,
    conversationId: `mcp-control-${projectId}`,
    mode: MCP_EXECUTION_MODE,
    baseRevision: store.getCurrentRevision(),
    projectScope: captureLegacyProjectExpectedContext(store),
    ...(!store.currentProjectId ? { toolAllowlist: [...MCP_GLOBAL_TOOL_NAMES] } : {}),
  };
  // 两种模式都保留稳定入口，客户端缓存启动页目录后仍能重新发现当前项目能力。
  const discovery: McpToolDescriptor[] = [
    ...MCP_DISCOVERY_TOOL_NAMES.map((name) => {
      const definition = getAgentTool(name);
      if (!definition) throw new Error('MCP 发现工具未注册');
      const descriptor = toMcpToolDescriptor(definition);
      return {
        ...descriptor,
        ...(exposure === 'compact' && name === 'tools_search'
          ? { description: `${buildMcpToolOverview(discoveryContext)}\n\n${descriptor.description}` } : {}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      };
    }),
    MCP_CALL_DESCRIPTOR,
  ];
  if (exposure === 'compact') return discovery;
  // 发现没有业务调用，不创建任何持久化审计域；fixture也不能污染正式DB。
  const tools = getAvailableAgentTools(discoveryContext).filter((definition) => !isMcpDiscoveryTool(definition.id)
    && (getMcpProjectContextRequirement(definition) !== 'canvas' || discoveryContext.projectScope.kind === 'canvas'))
    .map(toMcpToolDescriptor);
  return [...discovery, ...tools];
}

function addAuditMessage(message: ChatMessage): void {
  useAppStore.getState().addMessage(message);
}

function revealMcpUserChoice(projectId: string, conversationId: string, step: AgentStep): void {
  const store = useAppStore.getState();
  const settingsChoice = projectId === MCP_SETTINGS_SCOPE_ID && conversationId === `mcp-control-${MCP_SETTINGS_SCOPE_ID}`
    && store.agentTasks.some((task) => task.id === step.taskId && isMcpSettingsContext(task));
  if (step.approval?.kind !== 'user_choice' || (!settingsChoice && store.currentProjectId !== projectId)) return;

  store.setActiveConversation(conversationId);
  store.setChatPanelView('chat');
  store.openChat();
  if (!store.chatPanelDetached) return;

  const isCurrentChoice = () => {
    const current = useAppStore.getState();
    return (settingsChoice || current.currentProjectId === projectId)
      && current.activeConversationId === conversationId
      && current.agentTasks.some((task) => task.id === step.taskId
        && task.status === 'waiting_approval'
        && task.steps.some((item) => item.id === step.id && item.approval?.status === 'pending'));
  };
  // 共享生命周期核对真实窗口与回退方式，焦点失败不能同时显示内嵌助手。
  void (async () => {
    if (!isCurrentChoice()) return;
    const { openDetachedChatWindow } = await import('../chat/chatWindowLifecycle');
    if (!isCurrentChoice() || !useAppStore.getState().chatPanelDetached) return;
    await openDetachedChatWindow();
  })().catch(() => {
    if (!isCurrentChoice()) return;
    useAppStore.getState().showToast(t('打开独立窗口失败'), 'error');
  });
}

async function callMcpTool(
  request: McpBridgeRequestEvent,
  active: ActiveMcpRequest,
  expectation?: Pick<McpToolCallEnvelope, 'schemaVersion' | 'expectedContext' | 'expectedProjectId' | 'expectedRevision' | 'operationKey'>,
): Promise<McpToolCallResult> {
  await ensureToolsRegistered();
  assertMcpRequestActive(request, active);
  const expectedProjectId = expectation?.expectedProjectId;
  const expectedRevision = expectation?.expectedRevision;
  const operationKey = expectation?.operationKey;
  const expectedContext = expectation?.expectedContext;
  const name = typeof request.params.name === 'string' ? request.params.name : '';
  const input: Record<string, unknown> = request.params.arguments && typeof request.params.arguments === 'object'
    ? request.params.arguments as Record<string, unknown> : {};
  const definition = getAgentTool(name);
  const historicalReceiptRead = name === 'mcp_operation_get' && Object.hasOwn(input, 'legacyProjectId');
  const typed = expectation?.schemaVersion === 2;
  const protocolError = (errorCode: string, summary: string): McpToolCallResult => ({
    isError: true, summary, content: [{ type: 'text', text: JSON.stringify({ errorCode, summary, retryable: false }) }],
  });
  const legacyState = useAppStore.getState();
  if (expectedProjectId !== undefined && legacyState.currentProjectId !== expectedProjectId
    || operationKey === undefined && expectedRevision !== undefined && legacyState.getCurrentRevision() !== expectedRevision) {
    const summary = '读取后旧画布身份或版本已变化，请重新读取并判断原意图';
    return { isError: true, summary, content: [{ type: 'text', text: JSON.stringify({ errorCode: 'MCP_CONTEXT_CHANGED',
      summary, retryable: false, current: { projectId: legacyState.currentProjectId, revision: legacyState.getCurrentRevision() } }) }] };
  }
  let readContext: ProjectExpectedContext;
  try { readContext = captureLegacyProjectExpectedContext(useAppStore.getState()); }
  catch { return protocolError('CONTEXT_REFRESH_REQUIRED', '当前项目上下文尚未就绪，请重新读取后判断原请求'); }
  if (isMcpGlobalTool(name) && !isMcpDiscoveryTool(name)) {
    readContext = captureLegacyProjectExpectedContext(useAppStore.getState(), 'global');
  } else if (name === 'episode_read' && typeof input.episodeId === 'string') {
    readContext = captureLegacyEpisodeContext(useAppStore.getState(), input.episodeId) ?? readContext;
  }
  if (typed && definition?.effect !== 'read' && !expectedContext) {
    return protocolError('CONTEXT_REFRESH_REQUIRED', '新版变更必须携带先前读取的expectedContext，请重新读取并判断原意图');
  }
  // 工具旧协议接收画布别名；类型化分集上下文使用独立 episodeId，仅在同一活动作品内解析别名。
  const typedInput = expectedContext?.kind === 'episode' && typeof input.episodeId === 'string'
    && captureLegacyEpisodeContext(useAppStore.getState(), input.episodeId)?.episodeId === expectedContext.episodeId
    ? { ...input, episodeId: expectedContext.episodeId } : input;
  if (expectedContext && definition && !historicalReceiptRead && !isMcpProjectContextCompatible(definition, expectedContext, typedInput)) {
    return protocolError('CONTEXT_REFRESH_REQUIRED', '上下文种类或目标与工具不匹配，请重新读取目标上下文');
  }
  if (definition && getMcpProjectContextRequirement(definition) === 'canvas' && readContext.kind !== 'canvas') {
    return protocolError('NO_ACTIVE_CANVAS', '当前没有活动画布，不能提交画布或付费媒体操作');
  }
  const contextChanged = (includeRevision = true) => {
    const state = useAppStore.getState();
    return (expectedContext !== undefined && !isProjectExpectedContextCurrent(expectedContext, state, { checkCanvasRevision: includeRevision }))
      || (readContext.kind !== 'global' && readContext.modelGeneration > 0
        && !isProjectExpectedContextCurrent(readContext, state, { checkCanvasRevision: includeRevision }))
      || (expectedProjectId !== undefined && state.currentProjectId !== expectedProjectId)
      || (includeRevision && expectedRevision !== undefined && state.getCurrentRevision() !== expectedRevision);
  };
  const contextError = (): McpToolCallResult => {
    const readState = useAppStore.getState();
    const summary = '读取后项目或画布版本已变化，未继续执行旧请求；请重新读取后规划，不要自动重投写入';
    return {
      isError: true, summary,
      content: [{ type: 'text', text: JSON.stringify({
        errorCode: typed ? 'CONTEXT_REFRESH_REQUIRED' : 'MCP_CONTEXT_CHANGED', summary, retryable: false,
        current: { projectId: readState.currentProjectId, revision: readState.getCurrentRevision() },
      }) }],
    };
  };
  // 已存在的同项目操作只是读取回执；原写入已推进 revision，不能因此阻止核实旧 key。
  if (contextChanged(operationKey === undefined && !historicalReceiptRead)) return contextError();
  // 显式历史查询只读原alias的binding/task，不为被删目标或另一个分集制造新的scope任务。
  if (historicalReceiptRead) {
    if (!definition || !validateAgentToolInput(definition.inputSchema, input).valid || operationKey !== undefined) {
      return protocolError('MCP_OPERATION_QUERY_FAILED', '历史操作查询参数无效');
    }
    try {
      const operation = await getHistoricalMcpOperationReceipt(input as unknown as Parameters<typeof getHistoricalMcpOperationReceipt>[0]);
      assertMcpRequestActive(request, active);
      if (contextChanged(false)) return contextError();
      return operation ? { isError: false, summary: `原操作状态：${operation.status}`, content: [{ type: 'text', text: JSON.stringify({ readOnlyAudit: true, operation }) }] }
        : protocolError('MCP_OPERATION_NOT_FOUND', '没有找到原回执；这不证明原付费操作未提交，请先只读核实，勿重投');
    } catch { return protocolError('MCP_OPERATION_QUERY_FAILED', '历史操作回执读取失败，请核对同剧旧画布身份或显式删除审计范围'); }
  }
  const current = getCurrentMcpContext(name);
  if (!current) {
    return {
      isError: true,
      summary: '该工具需要打开项目；请用 project_create 创建项目，或用 project_list 读取列表后通过 project_open 或 project_switch 打开项目。启动页也可管理厂商和模型设置。',
      content: [{ type: 'text', text: '该工具需要打开项目；请用 project_create 创建项目，或用 project_list 读取列表后通过 project_open 或 project_switch 打开项目。启动页也可管理厂商和模型设置。' }],
    };
  }
  let operationIdentity: McpOperationIdentity | undefined;
  const replay = (operation: McpOperationReceipt): McpToolCallResult => ({
    isError: ['partial', 'failed', 'unknown'].includes(operation.status),
    summary: `已读取原操作回执：${operation.status}；没有再次执行工具`,
    content: [{ type: 'text', text: JSON.stringify({ replayed: true, operation }) }],
  });
  if (operationKey !== undefined) {
    try {
      if (!definition || current.projectId === MCP_SETTINGS_SCOPE_ID) throw new Error('operationKey 仅支持当前项目的画布写入和媒体生成');
      operationIdentity = await identifyMcpOperation({ projectId: current.projectId, toolId: name,
        effect: definition.effect, arguments: input, operationKey });
      assertMcpRequestActive(request, active);
      if (contextChanged(false)) return contextError();
      const prior = await readMcpOperation(operationIdentity);
      assertMcpRequestActive(request, active);
      if (contextChanged(false)) return contextError();
      if (prior) return replay(prior);
    } catch (error) {
      const summary = error instanceof Error ? error.message : 'MCP 操作身份无法确认，未执行工具';
      return { isError: true, summary, content: [{ type: 'text', text: JSON.stringify({
        errorCode: summary === 'MCP_OPERATION_KEY_CONFLICT' ? summary : 'MCP_OPERATION_NOT_STARTED', summary, retryable: false,
      }) }] };
    }
  }
  if (contextChanged()) {
    // 原owner可能在首次lookup后已完成写入；旧revision不能遮住此时已存在的原key。
    if (operationIdentity && !contextChanged(false)) {
      try {
        const prior = await readMcpOperation(operationIdentity);
        assertMcpRequestActive(request, active);
        if (contextChanged(false)) return contextError();
        if (prior) return replay(prior);
      } catch (error) {
        const summary = error instanceof Error ? error.message : 'MCP 操作身份无法确认，未执行工具';
        return { isError: true, summary, content: [{ type: 'text', text: JSON.stringify({
          errorCode: summary === 'MCP_OPERATION_KEY_CONFLICT' ? summary : 'MCP_OPERATION_NOT_STARTED', summary, retryable: false,
        }) }] };
      }
    }
    return contextError();
  }
  const title = (definition?.title ?? name) || '未知工具';
  let inputSummary = '参数将在本地 schema 校验';
  if (definition?.summarizeInput) {
    try {
      inputSummary = definition.summarizeInput(input);
    } catch {
      inputSummary = '参数摘要生成失败，将由本地 schema 校验';
    }
  }
  inputSummary = sanitizeAuditSummary(inputSummary);

  const store = useAppStore.getState();
  const now = Date.now();
  const userMessageId = createId('mcp-user');
  const assistantMessageId = createId('mcp-assistant');
  const taskInput: CreateAgentTaskInput = {
    projectId: current.projectId,
    conversationId: current.conversation.id,
    userMessageId,
    mode: MCP_EXECUTION_MODE,
    ...(expectedContext ? { executionContext: structuredClone(expectedContext) }
      : typed ? { executionContext: structuredClone(readContext) } : {}),
    goal: `MCP 请求：${title}。${inputSummary}`,
    toolAllowlist: current.toolAllowlist,
    budget: {
      maxModelRounds: 1,
      maxToolCalls: 1,
      maxParallelReadTools: 1,
    },
  };
  let task: AgentTask;
  if (operationIdentity) {
    try {
      const claim = await claimMcpOperation(operationIdentity, taskInput, () => {
        assertMcpRequestActive(request, active);
        if (contextChanged() || useAppStore.getState().currentProjectId !== current.projectId) throw new Error(typed ? 'CONTEXT_REFRESH_REQUIRED' : 'MCP_CONTEXT_CHANGED');
      });
      if (!claim.claimed) return replay(claim.receipt);
      if (!claim.task) throw new Error('MCP 操作占位没有任务，不能执行');
      task = claim.task;
    } catch (error) {
      const summary = error instanceof Error ? error.message : 'MCP 操作占位未持久化，未开始执行';
      if (typed && (summary === 'CONTEXT_REFRESH_REQUIRED' || contextChanged())) return contextError();
      return { isError: true, summary, content: [{ type: 'text', text: JSON.stringify({
        errorCode: summary === 'MCP_OPERATION_KEY_CONFLICT' ? summary : 'MCP_OPERATION_CLAIM_FAILED', summary, retryable: false,
      }) }] };
    }
  } else task = store.createAgentTask(taskInput);
  addAuditMessage({ id: userMessageId, conversationId: current.conversation.id, role: 'user',
    content: `MCP 请求：${title}\n${inputSummary}`, timestamp: now, status: 'done' });
  addAuditMessage({
    id: assistantMessageId,
    conversationId: current.conversation.id,
    role: 'assistant',
    content: `正在执行 MCP 工具“${title}”。`,
    timestamp: now + 1,
    status: 'executing',
    agentTaskId: task.id,
  });
  active.taskId = task.id;

  let executionResult: Awaited<ReturnType<
    typeof import('../chat/agentToolExecution')['executeRegisteredAgentToolCall']
  >> | undefined;
  try {
    const finalTask = await runAgentTask(task.id, async (signal) => {
      const { executeRegisteredAgentToolCall } = await import('../chat/agentToolExecution');
      assertMcpRequestActive(request, active);
      if (contextChanged()) throw new Error(typed ? 'CONTEXT_REFRESH_REQUIRED' : 'MCP_CONTEXT_CHANGED');
      if (operationIdentity) {
        if (contextChanged() || useAppStore.getState().currentProjectId !== current.projectId) throw new Error(typed ? 'CONTEXT_REFRESH_REQUIRED' : 'MCP_CONTEXT_CHANGED');
        await startMcpOperation(task.id);
        assertMcpRequestActive(request, active);
        if (contextChanged() || useAppStore.getState().currentProjectId !== current.projectId) throw new Error(typed ? 'CONTEXT_REFRESH_REQUIRED' : 'MCP_CONTEXT_CHANGED');
      }
      executionResult = await executeRegisteredAgentToolCall({
        taskId: task.id,
        call: {
          callId: request.requestId,
          toolId: name,
          input,
        },
        signal,
        transitionTask: transitionAgentTask,
        waitForApproval: waitForAgentApproval,
        policyMode: MCP_EXECUTION_MODE,
        ...(expectedProjectId !== undefined || operationIdentity ? {
          expectedContext: { projectId: expectedProjectId ?? operationIdentity!.projectId, baseRevision: expectedRevision },
        } : {}),
        onApprovalRequired: (step) => revealMcpUserChoice(current.projectId, current.conversation.id, step),
      });
      return executionResult.summary.status === 'success' ? 'completed' : 'failed';
    });
    const summary = executionResult?.summary.summary
      ?? finalTask.errorMessage
      ?? 'MCP 工具调用未返回结果';
    const isError = executionResult?.summary.status !== 'success' || executionResult?.mcpResultError === true;
    // 工具业务失败仍是一次成功送达的结构化 MCP 响应：任务和步骤保留 failed，
    // 但审计消息不应再误报为网络/模型“响应失败”。只有执行链没有产出结果时才标 error。
    const responseReceived = executionResult !== undefined;
    useAppStore.getState().updateAgentTask(task.id, { resultSummary: summary });
    useAppStore.getState().updateMessage(assistantMessageId, {
      content: summary,
      status: responseReceived ? 'done' : 'error',
    });
    let operation: McpOperationReceipt | null = null;
    if (operationIdentity) {
      try {
        operation = await finishMcpOperation(task.id, { status: (executionResult?.effectOutcome ?? executionResult?.summary.status) === 'success' ? 'success' : 'error',
          knownNoEffect: executionResult?.summary.status === 'denied', errorCode: executionResult?.summary.errorCode });
      } catch {
        // 业务可能已经成功，保存回执失败也不能重投；尽量返回已持久化的旧状态。
        operation = await readMcpOperation(operationIdentity).catch(() => null);
      }
    }
    const refreshRequired = typed && (executionResult?.summary.errorCode === 'CONTEXT_REFRESH_REQUIRED'
      || !executionResult && (finalTask.errorMessage === 'CONTEXT_REFRESH_REQUIRED' || contextChanged(false)));
    const resultContent = refreshRequired
      ? [{ type: 'text' as const, text: JSON.stringify({ errorCode: 'CONTEXT_REFRESH_REQUIRED', summary: '执行上下文已变化，请先核对原操作并重新读取，勿自动重投', retryable: false }) }]
      : executionResult?.mcpContent?.length ? executionResult.mcpContent
        : [{ type: 'text' as const, text: executionResult?.modelContent ?? summary }];
    // 只读结果的上下文属于开始读取的同一快照，不能附上切换后的新上下文误导下一次写入。
    const readStillCurrent = definition?.effect !== 'read' || isProjectExpectedContextCurrent(readContext, useAppStore.getState());
    if (!readStillCurrent && !operationIdentity) return protocolError('CONTEXT_REFRESH_REQUIRED', '读取期间项目上下文已变化，请重新读取后判断原意图');
    const content = definition?.effect === 'read' && !isError
      ? [...resultContent, { type: 'text' as const, text: JSON.stringify({ expectedContext: readContext }) }] : resultContent;
    return {
      isError,
      summary,
      content: operation ? [...content, { type: 'text', text: JSON.stringify({ operation }) }]
        : operationIdentity ? [...content, { type: 'text', text: JSON.stringify({ operation: {
          operationId: operationIdentity.bindingId, taskId: task.id, status: 'unknown', resultAvailable: false,
          retryable: false, requiresReadVerification: true, nextAction: '回执暂不可读，先只读核实；不要用新 key 重投',
        } }) }] : content,
    };
  } catch (error) {
    if (!operationIdentity) throw error;
    const operation = await finishMcpOperation(task.id, { status: 'error', errorCode: 'MCP_OPERATION_INTERRUPTED' })
      .catch(() => readMcpOperation(operationIdentity!)).catch(() => null);
    return { isError: true, summary: '原操作结果未完整确认，请读取操作回执，勿重投', content: [{ type: 'text',
      text: JSON.stringify({ errorCode: 'MCP_OPERATION_INTERRUPTED', retryable: false,
        operation: operation ?? { operationId: operationIdentity.bindingId, taskId: task.id, status: 'unknown', retryable: false } }) }] };
  } finally {
    clearSkillReadTask(task.id);
    clearSkillCatalogTask(task.id);
  }
}

function cancelMcpRequest(request: McpBridgeRequestEvent): { cancelled: boolean } {
  // 空 ID 仅由原生发出单向生命周期通知；客户端入口拒绝空 ID，不能借 scope 撤销其他连接。
  if (request.requestId === '' && request.params.scope === 'session') {
    rememberCancellation(cancelledSessions, request.sessionId, maxCancelledSessions);
    for (const active of activeRequestTasks.values()) {
      if (active.sessionId !== request.sessionId) continue;
      try {
        cancelActiveRequest(active);
      } catch {
        // 单个任务的终态竞态不能阻止同会话的其他请求收到撤销。
      }
    }
    return { cancelled: true };
  }
  // bridge 已把目标 ID 换成同一连接内的请求键，这里按键直接取消。
  const target = typeof request.params.requestId === 'string'
    ? request.params.requestId
    : '';
  if (!target || target.length > 512) return { cancelled: false };
  const key = requestKey(request.sessionId, target);
  rememberCancellation(cancelledRequests, key, maxCancelledRequests);
  const active = activeRequestTasks.get(key);
  if (!active) return { cancelled: false };
  try {
    cancelActiveRequest(active);
    return { cancelled: true };
  } catch {
    return { cancelled: false };
  }
}

export async function handleMcpBridgeRequest(
  request: McpBridgeRequestEvent,
): Promise<unknown> {
  switch (request.method) {
    case 'tools/list':
      return { tools: await listMcpTools() };
    case 'tools/call': {
      const key = requestKey(request.sessionId, request.requestId);
      if (activeRequestTasks.has(key)) throw new Error('MCP 请求 ID 重复');
      const active: ActiveMcpRequest = { sessionId: request.sessionId, cancelled: false };
      activeRequestTasks.set(key, active);
      try {
        assertMcpRequestActive(request, active);
        if (request.params.name === MCP_CALL_TOOL_NAME) {
          let envelope;
          try {
            envelope = decodeMcpToolCallEnvelope(request.params.arguments);
          } catch (error) {
            const summary = error instanceof Error ? error.message : 'MCP 调用信封无效';
            const input = request.params.arguments;
            const versioned = input && typeof input === 'object' && ('schemaVersion' in input || 'expectedContext' in input);
            return { isError: true, summary, content: [{ type: 'text', text: versioned
              ? JSON.stringify({ errorCode: 'CONTEXT_REFRESH_REQUIRED', summary: '新版上下文无效，请重新读取并判断原请求', retryable: false }) : summary }] };
          }
          // 只解包一次，保留原 requestId 的取消关联。校验、effect 和审计均属于真实工具。
          return await callMcpTool({ ...request, params: { name: envelope.name, arguments: envelope.arguments } }, active, envelope);
        }
        if (['schemaVersion', 'expectedContext', 'expectedProjectId', 'expectedRevision', 'operationKey'].some((key) => Object.hasOwn(request.params, key))) {
          return { isError: true, summary: '上下文条件必须放入tools_call信封', content: [{ type: 'text', text: JSON.stringify({
            errorCode: 'CONTEXT_REFRESH_REQUIRED', summary: '请保留原上下文条件并通过tools_call信封提交', retryable: false,
          }) }] };
        }
        return await callMcpTool(request, active);
      } finally {
        activeRequestTasks.delete(key);
      }
    }
    case 'requests/cancel':
      return cancelMcpRequest(request);
    default:
      throw new Error('不支持的 MCP bridge 方法');
  }
}

export async function initMcpControlService(): Promise<() => void> {
  // 全局审计域不在 CanvasProject 清单中，启动时单独复用既有中断修复。
  // 同一应用会话只修复一次，监听器重挂载不能暂停正在运行的请求。
  settingsAuditInitialization ??= (async () => {
    const store = useAppStore.getState();
    await store.repairInterruptedAgentTasksForProject(MCP_SETTINGS_SCOPE_ID);
    await store.repairInterruptedForProject(MCP_SETTINGS_SCOPE_ID);
    const { loadProjectConversations } = await import('../chat/chatHistoryService');
    const saved = await loadProjectConversations(MCP_SETTINGS_SCOPE_ID).catch(() => []);
    const conversation = saved.find((item) => item.id === MCP_SETTINGS_CONVERSATION_ID);
    if (conversation && !useAppStore.getState().conversations.some((item) => item.id === conversation.id)) {
      const current = useAppStore.getState();
      current.setConversations([...current.conversations, conversation]);
    }
  })();
  await settingsAuditInitialization;
  const unlisten = await listenForMcpBridgeRequests(async (request) => {
    try {
      const result = await handleMcpBridgeRequest(request);
      // 原生生命周期通知不登记 pending，也不需要回传响应。
      if (request.method === 'requests/cancel' && request.requestId === '') return;
      await respondToMcpBridge({
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      await respondToMcpBridge({
        sessionId: request.sessionId,
        requestId: request.requestId,
        ok: false,
        error: sanitizeAuditSummary(
          error instanceof Error ? error.message : 'AI Canvas MCP 请求失败',
        ),
      }).catch(() => {});
    }
  });
  return () => {
    unlisten();
    for (const active of activeRequestTasks.values()) {
      try {
        cancelActiveRequest(active);
      } catch {
        // 任务可能已经结束。
      }
    }
    activeRequestTasks.clear();
    cancelledRequests.clear();
    cancelledSessions.clear();
  };
}
