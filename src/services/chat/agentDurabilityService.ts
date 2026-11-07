/** 持久化成功才允许进入调用；不承诺外部系统恰好执行一次。 */
import { useAppStore } from '../../store/useAppStore';
import type { AgentDispatchRecord, AgentTask } from '../../types/agent';
import { AGENT_TERMINAL_STATUSES } from '../../types/agent';
import { saveAgentTask } from './agentTaskService';
import { assertCreationProfileSnapshot } from '../creationProfiles/creationProfileService';

export class AgentDurabilityError extends Error {
  readonly code = 'AGENT_DURABILITY_FAILED';
  constructor() { super('执行记录无法保存，任务已暂停；请检查存储后核实原操作，不要重复提交'); this.name = 'AgentDurabilityError'; }
}

function taskForDispatch(taskId: string, signal?: AbortSignal): AgentTask {
  signal?.throwIfAborted();
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task || task.status === 'paused' || AGENT_TERMINAL_STATUSES.has(task.status)) {
    throw new DOMException('任务已停止或暂停，不能进入调用', 'AbortError');
  }
  if (task.creationProfilePreparation && task.creationProfilePreparation !== 'ready') {
    throw new Error('组合包准备尚未成功完成，不能调用模型或工具，请重新发起请求');
  }
  assertCreationProfileSnapshot(task.creationProfile);
  return task;
}

function replaceDispatch(taskId: string, record: AgentDispatchRecord): AgentTask {
  const state = useAppStore.getState();
  const task = state.agentTasks.find((item) => item.id === taskId);
  if (!task) throw new DOMException('任务已删除', 'AbortError');
  const previous = task.dispatches ?? [];
  // 未核实记录绝不因容量裁剪而消失；正常终态回执只保留最近 256 项。
  const retained = previous.filter((item) => item.id !== record.id);
  const unmaterialized = new Set(unmaterializedTeamDispatches({ ...task, dispatches: retained }).map((item) => item.id));
  const protectedReceipt = (item: AgentDispatchRecord) => item.phase !== 'settled' || !!item.recovery
    || item.materializationBlocked === true || unmaterialized.has(item.id);
  const completed = retained.filter((item) => !protectedReceipt(item)).slice(-255);
  const unfinished = retained.filter(protectedReceipt);
  if (unfinished.length >= 512) throw new Error('待核实调用记录过多，请先核实任务');
  state.updateAgentTask(taskId, { dispatches: [...completed, ...unfinished, record] });
  return useAppStore.getState().agentTasks.find((item) => item.id === taskId)!;
}

async function persistBarrier(taskId: string, record: AgentDispatchRecord): Promise<void> {
  try { await saveAgentTask(replaceDispatch(taskId, record)); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const state = useAppStore.getState();
    const task = state.agentTasks.find((item) => item.id === taskId);
    if (task && !AGENT_TERMINAL_STATUSES.has(task.status)) state.updateAgentTask(taskId, {
      status: 'paused', pausedReason: 'durability_failed', errorCode: 'AGENT_DURABILITY_FAILED',
      errorMessage: '执行记录无法保存，未启动后续调用；已发出的原操作需先核实',
    });
    throw new AgentDurabilityError();
  }
}

/** 参数仅用于计算身份摘要，原始参数永不存入回执。 */
export async function digestAgentDispatchInput(toolId: string, input: unknown): Promise<string> {
  const canonical = (value: unknown, depth = 0): unknown => {
    if (depth > 32) throw new Error('调用参数层级过深');
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) =>
      [key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
    return value;
  };
  const bytes = new TextEncoder().encode(JSON.stringify([toolId, canonical(input)]));
  if (bytes.byteLength > 1024 * 1024) throw new Error('调用参数超过身份摘要预算');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function unresolvedAgentDispatches(task: AgentTask): AgentDispatchRecord[] {
  return (task.dispatches ?? []).filter((record) => !record.recovery
    && (record.phase === 'outcome_unknown' || record.phase === 'dispatched'));
}

/** 核实决定不凭空生成成果；同一要求版本的无产物阶段不能在普通继续时重发。 */
export function unmaterializedTeamDispatches(task: AgentTask): AgentDispatchRecord[] {
  if (!task.teamRun) return [];
  const run = task.teamRun;
  return (task.dispatches ?? []).filter((record) => record.kind === 'team-model'
    && (record.runRevision ?? 1) === run.revision
    && (record.phase === 'outcome_unknown' || record.phase === 'dispatched'
      || record.phase === 'settled' && record.outcome === 'succeeded' || record.materializationBlocked === true || !!record.recovery)
    && !run.stages.some((stage) => stage.id === record.stepId && stage.status === 'completed'
      && run.artifacts.some((artifact) => artifact.id === stage.artifactId && artifact.stageId === stage.id)));
}

export async function beginAgentDispatch(input: {
  taskId: string; id?: string; kind: AgentDispatchRecord['kind']; toolId?: string; stepId?: string;
  runRevision?: number;
  effect?: AgentDispatchRecord['effect']; inputDigest?: string; signal?: AbortSignal;
  revalidate?: () => void;
}): Promise<AgentDispatchRecord> {
  const task = taskForDispatch(input.taskId, input.signal);
  if (input.kind === 'team-model' && unmaterializedTeamDispatches(task).some((record) => record.stepId === input.stepId)) {
    throw new Error('原团队阶段没有可恢复成果，请明确补充新要求或新建任务，普通继续不会重投');
  }
  if (input.effect && input.effect !== 'read' && (task.dispatches ?? []).some((record) =>
    record.kind === 'tool' && record.effect !== 'read' && record.toolId === input.toolId
    && (record.phase === 'outcome_unknown' || record.phase === 'dispatched' || !!record.recovery)
    && (!record.inputDigest || record.inputDigest === input.inputDigest))) {
    throw new Error('存在结果未知的同一写入，须先核实原操作，不能重复提交');
  }
  const record: AgentDispatchRecord = {
    id: input.id ?? crypto.randomUUID(), kind: input.kind, phase: 'prepared', preparedAt: Date.now(),
    ...(input.toolId ? { toolId: input.toolId } : {}), ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.runRevision !== undefined ? { runRevision: input.runRevision } : {}),
    ...(input.effect ? { effect: input.effect } : {}), ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
  };
  await persistBarrier(input.taskId, record);
  const dispatched: AgentDispatchRecord = { ...record, phase: 'dispatched', dispatchedAt: Date.now() };
  try {
    taskForDispatch(input.taskId, input.signal); input.revalidate?.();
    await persistBarrier(input.taskId, dispatched);
    taskForDispatch(input.taskId, input.signal); input.revalidate?.();
  } catch (error) {
    if (!(error instanceof AgentDurabilityError)) await persistBarrier(input.taskId, { ...record, phase: 'not_started' });
    throw error;
  }
  return dispatched;
}

export async function settleAgentDispatch(
  taskId: string, record: AgentDispatchRecord, outcome: 'succeeded' | 'failed' | 'unknown',
  options: { materializationBlocked?: boolean } = {},
): Promise<void> {
  const current = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!current) throw new DOMException('任务已删除', 'AbortError');
  const stored = current.dispatches?.find((item) => item.id === record.id);
  if (!stored) return;
  if (stored.phase === 'settled') {
    if (options.materializationBlocked === true && stored.materializationBlocked !== true) {
      await persistBarrier(taskId, { ...stored, materializationBlocked: true });
    }
    return;
  }
  await persistBarrier(taskId, {
    ...stored, phase: outcome === 'unknown' ? 'outcome_unknown' : 'settled', settledAt: Date.now(),
    ...(options.materializationBlocked === true ? { materializationBlocked: true as const } : {}),
    ...(outcome !== 'unknown' ? { outcome } : {}),
  });
}

/** 仅用户在宿主界面核实后调用。模型/MCP 工具没有该写入口。 */
export async function resolveAgentDispatchOutcome(
  taskId: string, dispatchId: string, decision: 'verified_completed' | 'abandoned',
): Promise<void> {
  if (decision !== 'verified_completed' && decision !== 'abandoned') throw new Error('核实决定无效');
  const task = useAppStore.getState().agentTasks.find((item) => item.id === taskId);
  if (!task || !['paused', 'failed', 'stopped'].includes(task.status)) throw new Error('请先暂停任务再核实原操作');
  const record = task.dispatches?.find((item) => item.id === dispatchId);
  if (!record || !unresolvedAgentDispatches(task).includes(record)) throw new Error('该调用没有待核实结果');
  await persistBarrier(taskId, { ...record, recovery: { decision, decidedAt: Date.now() } });
}
