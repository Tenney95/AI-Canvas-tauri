/** MCP 操作身份与安全回执；完整参数和业务结果只驻留原请求，不进入持久化。 */
import { useAppStore } from '../../store/useAppStore';
import type { CreateAgentTaskInput } from '../../store/store.agent';
import type {
  AgentTask, McpOperationBinding, McpOperationIdentity, McpOperationReceipt,
  McpOperationRecord, McpOperationUpdate,
} from '../../types/agent';
import { getAgentTask, getMcpOperationBinding, updateMcpOperationTask } from '../indexedDbService';
import { openDB, STORE_METADATA } from '../indexedDb/schema';
import { isProjectExpectedContextCurrent } from '../projectExecutionContext';

const activeOperations = new Set<string>();
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

function assertProject(projectId: string): void {
  if (useAppStore.getState().currentProjectId !== projectId) throw new Error('MCP 操作只允许当前项目，请重新读取项目状态');
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('MCP 操作参数嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item, depth + 1)]));
  }
  throw new Error('MCP 操作参数必须是 JSON 数据');
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  if (bytes.byteLength > 1024 * 1024) throw new Error('MCP 操作参数超过摘要预算');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function keyIdentity(projectId: string, operationKey: string) {
  if (!KEY.test(operationKey)) throw new Error('operationKey 需为 1–128 位字母、数字或 . _ : -，同一意图重复调用必须保留原 key');
  const keyDigest = await digest(operationKey);
  const bindingId = `mcp-operation:${await digest([projectId, keyDigest])}`;
  return { keyDigest, bindingId };
}

export async function identifyMcpOperation(input: {
  projectId: string; toolId: string; effect: string; arguments: unknown; operationKey: string;
}): Promise<McpOperationIdentity> {
  assertProject(input.projectId);
  if (input.effect !== 'canvas_write' && input.effect !== 'media_generation') {
    throw new Error('operationKey 仅用于当前项目的 canvas_write 或 media_generation 工具');
  }
  const [{ keyDigest, bindingId }, inputDigest] = await Promise.all([
    keyIdentity(input.projectId, input.operationKey), digest({ toolId: input.toolId, arguments: input.arguments }),
  ]);
  assertProject(input.projectId);
  return { bindingId, projectId: input.projectId, keyDigest, inputDigest, toolId: input.toolId, effect: input.effect };
}

function assertBinding(identity: McpOperationIdentity, binding: McpOperationBinding): void {
  if (identity.bindingId !== binding.bindingId || identity.projectId !== binding.projectId
    || identity.keyDigest !== binding.keyDigest || identity.inputDigest !== binding.inputDigest
    || identity.toolId !== binding.toolId || identity.effect !== binding.effect) throw new Error('MCP_OPERATION_KEY_CONFLICT');
}

function receipt(binding: McpOperationBinding, task: AgentTask | null): McpOperationReceipt {
  if (task && (task.id !== binding.taskId || task.projectId !== binding.projectId
    || task.conversationId !== `mcp-control-${binding.projectId}`)) throw new Error('MCP 操作任务身份不一致，请只读核实');
  const operation = task?.mcpOperation;
  if (operation) assertBinding(operation, binding);
  const live = task && useAppStore.getState().agentTasks.find((item) => item.id === task.id);
  const liveStatus = live?.status ?? task?.status;
  const running = task && activeOperations.has(task.id) && liveStatus !== 'paused' && liveStatus !== 'stopped';
  let status: McpOperationReceipt['status'] = !operation || binding.taskDeletedAt ? 'unknown'
    : operation.phase === 'reserved' ? (running ? 'not_started' : 'unknown')
      : operation.phase === 'running' ? (running ? 'running' : 'unknown') : operation.phase;
  const items = operation?.items?.map((item) => !running && item.status === 'started' ? { ...item, status: 'unknown' as const } : item);
  if (status === 'unknown' && items?.some((item) => item.status === 'succeeded')) status = 'partial';
  const requiresReadVerification = ['partial', 'failed', 'unknown'].includes(status)
    || operation?.persistence === 'failed' || operation?.persistence === 'skipped';
  return {
    operationId: binding.id, taskId: binding.taskId, projectId: binding.projectId, toolId: binding.toolId,
    status, sequence: Math.max(operation?.sequence ?? 0, binding.lastSequence ?? 0), resultAvailable: false, retryable: false,
    requiresReadVerification,
    nextAction: status === 'running' || status === 'not_started' ? '等待后用 mcp_operation_get 查询原操作，不要重复提交；started 仅表示本地开始调用，不证明服务商已受理'
      : status === 'succeeded' ? '原任务已记录成功；完整正文不持久化，请用对应只读工具核对结果'
        : '先用只读工具核对已完成项和原媒体任务；有可恢复任务时沿用 media_pending_tasks/media_resume_task，不要用新 key 重投',
    ...(items ? { items } : {}),
    ...(operation?.mediaStage ? { mediaStage: operation.mediaStage } : {}),
    ...(operation?.canvasNodeId ? { canvasNodeId: operation.canvasNodeId } : {}),
    ...(operation?.messageId ? { messageId: operation.messageId } : {}),
    ...(operation?.artifactId ? { artifactId: operation.artifactId } : {}),
    ...(operation?.persistence ? { persistence: operation.persistence } : {}),
    ...(operation?.errorCode ? { errorCode: operation.errorCode } : {}),
    ...(operation?.revisionAfter !== undefined ? { revisionAfter: operation.revisionAfter } : {}),
  };
}

export async function readMcpOperation(identity: McpOperationIdentity): Promise<McpOperationReceipt | null> {
  assertProject(identity.projectId);
  const binding = await getMcpOperationBinding(identity.bindingId);
  if (!binding) { assertProject(identity.projectId); return null; }
  assertBinding(identity, binding);
  const task = binding.taskDeletedAt ? null : await getAgentTask(binding.taskId);
  assertProject(identity.projectId);
  return receipt(binding, task);
}

export async function claimMcpOperation(identity: McpOperationIdentity, input: CreateAgentTaskInput, assertFresh?: () => void) {
  assertProject(identity.projectId);
  if (input.projectId !== identity.projectId || input.conversationId !== `mcp-control-${identity.projectId}`) {
    throw new Error('MCP 操作会话不属于当前项目');
  }
  const now = Date.now();
  const operation: McpOperationRecord = { ...identity, version: 1, phase: 'reserved', sequence: 0, createdAt: now, updatedAt: now };
  const result = await useAppStore.getState().claimMcpAgentTask(input, operation);
  if (result.claimed && result.task) activeOperations.add(result.task.id);
  try {
    assertProject(identity.projectId);
    // 调用方在摘要后已校验前置条件；只有新所有者复核异步claim期间的变化。
    // 并发输家只能读原回执；原所有者可能已推进 revision，不能据此拒绝同项目原 key。
    if (result.claimed) assertFresh?.();
  } catch (error) {
    // 绑定保留，不能在失败后删除 key 重新执行；该所有者尚未启动业务工具。
    if (result.claimed && result.task) {
      activeOperations.delete(result.task.id);
      const saved = await updateMcpOperationTask(result.task.id, { phase: 'failed', errorCode: 'MCP_CONTEXT_CHANGED' });
      if (saved?.mcpOperation) useAppStore.getState().applyPersistedMcpOperation(result.task.id, saved.mcpOperation);
      const { stopAgentTask } = await import('../chat/agentTaskControl');
      const pending = useAppStore.getState().agentTasks.find((task) => task.id === result.task!.id);
      if (pending && !['completed', 'failed', 'stopped'].includes(pending.status)) stopAgentTask(pending.id);
    }
    throw error;
  }
  return { ...result, receipt: receipt(result.binding, result.task) };
}

function safeUpdate(changes: McpOperationUpdate): McpOperationUpdate {
  const next: McpOperationUpdate = {};
  if (changes.phase !== undefined) next.phase = changes.phase;
  if (changes.mediaStage !== undefined) {
    if (!['preparing', 'started', 'generated', 'delivered'].includes(changes.mediaStage)) throw new Error('MCP 媒体阶段无效');
    next.mediaStage = changes.mediaStage;
  }
  if (changes.items !== undefined) {
    if (changes.items.length > 50 || changes.items.some((item) => !SAFE_ID.test(item.nodeId)
      || !['not_started', 'started', 'succeeded', 'failed', 'unknown'].includes(item.status))) throw new Error('MCP 操作条目无效');
    next.items = changes.items.map((item) => ({ nodeId: item.nodeId, status: item.status,
      ...(item.errorCode && SAFE_CODE.test(item.errorCode) ? { errorCode: item.errorCode } : {}) }));
  }
  for (const key of ['canvasNodeId', 'messageId', 'artifactId'] as const) {
    const value = changes[key];
    if (value !== undefined) {
      if (!SAFE_ID.test(value)) throw new Error('MCP 操作引用身份无效');
      next[key] = value;
    }
  }
  if (changes.persistence !== undefined) next.persistence = changes.persistence;
  if (changes.errorCode && SAFE_CODE.test(changes.errorCode)) next.errorCode = changes.errorCode;
  if (changes.revisionAfter !== undefined && Number.isSafeInteger(changes.revisionAfter) && changes.revisionAfter >= 0) next.revisionAfter = changes.revisionAfter;
  return next;
}

/** 普通 Agent 没有 operationKey 时完全不接触持久化。 */
export async function recordMcpOperationProgress(taskId: string, changes: McpOperationUpdate): Promise<void> {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task?.mcpOperation) {
    if (activeOperations.has(taskId)) throw new Error('MCP 操作任务已移除，停止后续提交并请只读核实');
    return;
  }
  const saved = await updateMcpOperationTask(taskId, safeUpdate(changes));
  if (saved?.mcpOperation) useAppStore.getState().applyPersistedMcpOperation(taskId, saved.mcpOperation);
  else throw new Error('MCP 操作回执已不可用，请只读核实');
}

export async function startMcpOperation(taskId: string): Promise<void> {
  await recordMcpOperationProgress(taskId, { phase: 'running' });
}

export async function finishMcpOperation(taskId: string, outcome: {
  status: 'success' | 'error'; summary?: string; errorCode?: string; knownNoEffect?: boolean;
}): Promise<McpOperationReceipt | null> {
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task?.mcpOperation) { activeOperations.delete(taskId); return null; }
  const operation = task.mcpOperation;
  const state = useAppStore.getState();
  const taskContext = task.executionContext ?? task.projectScope;
  const canReadRevision = state.currentProjectId === task.projectId && (!taskContext
    || isProjectExpectedContextCurrent(taskContext, state, { checkCanvasRevision: false, checkRuntimeEpoch: false }));
  const partial = operation.persistence === 'failed' || operation.items?.some((item) => item.status === 'succeeded')
    && operation.items.some((item) => item.status !== 'succeeded')
    || outcome.status === 'success' && operation.items?.some((item) => item.status !== 'succeeded')
    || operation.revisionAfter !== undefined && operation.items?.some((item) => item.status !== 'succeeded')
    || outcome.status === 'success' && operation.mediaStage !== undefined && operation.mediaStage !== 'delivered';
  const phase = partial ? 'partial' : outcome.status === 'success' ? 'succeeded'
    : outcome.knownNoEffect ? 'failed' : 'unknown';
  try {
    await recordMcpOperationProgress(taskId, { phase, errorCode: outcome.errorCode,
      ...(outcome.status === 'success' && operation.revisionAfter === undefined
        && canReadRevision ? { revisionAfter: state.getCurrentRevision() } : {}) });
  } finally { activeOperations.delete(taskId); }
  // 这是原已授权调用的结算，只读回原binding；切集不能掩盖已明确返回的付费事实。
  // 通用查询、lookup和claim仍保持各自active/same-owner/删除审计门禁。
  const binding = await getMcpOperationBinding(operation.bindingId);
  if (!binding) throw new Error('MCP 原操作绑定已不可读，请只读核实');
  assertBinding(operation, binding);
  const savedTask = binding.taskDeletedAt ? null : await getAgentTask(binding.taskId);
  return receipt(binding, savedTask);
}

export async function getMcpOperationReceipt(projectId: string, input: { operationKey?: string; operationId?: string }): Promise<McpOperationReceipt | null> {
  assertProject(projectId);
  if (Boolean(input.operationKey) === Boolean(input.operationId)) throw new Error('请仅提供 operationKey 或 operationId 之一');
  const bindingId = input.operationId ?? (await keyIdentity(projectId, input.operationKey!)).bindingId;
  const binding = await getMcpOperationBinding(bindingId);
  if (!binding || binding.projectId !== projectId) { assertProject(projectId); return null; }
  const task = binding.taskDeletedAt ? null : await getAgentTask(binding.taskId);
  assertProject(projectId);
  return receipt(binding, task);
}

export interface HistoricalMcpOperationQuery {
  /** 历史Canvas alias，绝不能替换为整剧owner或当前分集。 */
  legacyProjectId: string;
  operationKey?: string;
  operationId?: string;
  auditScope?: 'deleted-target';
}

/** 只读历史回执入口。没有任务创建、key重新占位或媒体续投能力。 */
export async function getHistoricalMcpOperationReceipt(input: HistoricalMcpOperationQuery): Promise<McpOperationReceipt | null> {
  const projectId = input.legacyProjectId;
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 180
    || [...projectId].some((character) => character.charCodeAt(0) < 32) || Boolean(input.operationKey) === Boolean(input.operationId)
    || input.auditScope !== undefined && input.auditScope !== 'deleted-target') throw new Error('历史回执查询条件无效');
  const initial = useAppStore.getState();
  const target = initial.projects.find((item) => item.id === projectId);
  const active = initial.projects.find((item) => item.id === initial.currentProjectId);
  const owner = target && initial.projects.find((item) => item.id === (target.parentId ?? target.id));
  const sameOwner = Boolean(target && active && owner && !owner.parentId
    && owner.id === (active.parentId ?? active.id));
  const signature = () => {
    const state = useAppStore.getState();
    const current = state.projects.find((item) => item.id === state.currentProjectId);
    const original = state.projects.find((item) => item.id === projectId);
    const currentOwner = current?.parentId ? state.projects.find((item) => item.id === current.parentId) : current;
    const originalOwner = original?.parentId ? state.projects.find((item) => item.id === original.parentId) : original;
    return JSON.stringify([state.currentProjectId, current?.parentId, current?.exchangeEpoch,
      original?.id, original?.parentId, original?.exchangeEpoch, currentOwner?.exchangeEpoch, originalOwner?.exchangeEpoch]);
  };
  const initialSignature = signature();
  const assertReadScope = () => {
    if (signature() !== initialSignature) throw new Error('CONTEXT_REFRESH_REQUIRED');
  };
  if (!sameOwner) {
    if (target || input.auditScope !== 'deleted-target') throw new Error('历史回执只允许同剧旧画布或显式已删除目标审计');
    const database = await openDB();
    const tombstone = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_METADATA, 'readonly');
      const request = transaction.objectStore(STORE_METADATA).get(`project-deleted:${projectId}`);
      request.onerror = () => reject(new Error('删除审计标记不可读'));
      request.onsuccess = () => resolve(request.result);
    });
    if (!tombstone || typeof tombstone !== 'object' || !('retainedAudit' in tombstone)
      || tombstone.retainedAudit !== true) throw new Error('没有保留审计的删除标记，不能读取其他项目回执');
    assertReadScope();
  }
  const bindingId = input.operationId ?? (await keyIdentity(projectId, input.operationKey!)).bindingId;
  assertReadScope();
  const binding = await getMcpOperationBinding(bindingId);
  assertReadScope();
  if (!binding || binding.projectId !== projectId) return null;
  const task = binding.taskDeletedAt ? null : await getAgentTask(binding.taskId);
  assertReadScope();
  return { ...receipt(binding, task), nextAction: !sameOwner
    ? '目标已删除，此回执仅供只读审计；保留原key与任务身份，不恢复任务、不创建scope、不重投'
    : '原旧画布回执仅供只读核实；需要进一步操作时先切回原画布并重新读取上下文，不把原key或任务改绑到当前分集' };
}
