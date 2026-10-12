/**
 * 将经过白名单裁剪的 Agent Journal 与脱敏步骤摘要转换为用户可验证的执行依据。
 * 本模块不读取或推断模型隐藏思维链，也不接受模型提供的权限理由。
 */
import type {
  AgentApprovalKind,
  AgentEvent,
  AgentEventData,
  AgentStep,
  AgentTask,
} from '../../types/agent';

export type AgentRationaleKind = 'analysis' | 'decision' | 'action' | 'observation' | 'control';
export type AgentRationaleTone = 'active' | 'success' | 'warning' | 'error' | 'muted';

export interface AgentExecutionRationaleEntry {
  id: string;
  kind: AgentRationaleKind;
  tone: AgentRationaleTone;
  title: string;
  detail?: string;
  meta?: string;
  timestamp: number;
}

export const MAX_AGENT_RATIONALE_ENTRIES = 16;

const TASK_STATUS_LABELS = {
  waiting_approval: '任务正在等待用户确认',
  paused: '任务已暂停',
  completed: '任务已完成',
  failed: '任务执行失败',
  stopped: '任务已停止',
} as const;

function findStep(task: AgentTask, event: AgentEvent): AgentStep | undefined {
  const callId = event.data?.callId;
  if (!callId) return undefined;
  return task.steps.find((step) => step.toolCall?.callId === callId);
}

function toolTitle(task: AgentTask, event: AgentEvent): string {
  return findStep(task, event)?.title || event.data?.toolId || '工具操作';
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function toolMeta(event: AgentEvent): string | undefined {
  const parts: string[] = [];
  const duration = formatDuration(event.data?.durationMs);
  if (duration) parts.push(duration);
  if ((event.data?.retryCount ?? 0) > 0) parts.push(`重试 ${event.data?.retryCount} 次`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function policyDetail(
  decision: AgentEventData['decision'],
  effect: AgentApprovalKind | 'read' | undefined,
): string {
  if (decision === 'deny') return '本地权限策略拒绝了本次操作。';
  if (decision === 'require_approval') {
    switch (effect) {
      case 'canvas_write': return '画布修改需要根据当前协作模式由用户确认。';
      case 'media_generation': return '当前协作模式下，付费媒体生成需要用户确认。';
      case 'file_write': return '当前协作模式下，本地文件写入需要用户确认。';
      case 'permanent_delete': return '永久删除始终需要用户二次确认。';
      case 'memory_write': return '项目记忆必须由用户确认后保存。';
      case 'config_write': return '厂商配置写入必须由用户确认。';
      case 'asset_write': return '资产库写入必须由用户确认。';
      default: return '此操作执行前需要用户确认。';
    }
  }
  if (effect === 'read') return '只读操作符合当前权限，可自动执行。';
  if (effect === 'canvas_write') return '本地策略允许当前模式执行本次画布修改。';
  return '本地权限策略允许执行本次操作。';
}

function eventToEntry(
  task: AgentTask,
  event: AgentEvent,
  modelRound: number,
): AgentExecutionRationaleEntry | null {
  const step = findStep(task, event);
  const title = toolTitle(task, event);
  const base = { id: event.id, timestamp: event.timestamp };

  switch (event.type) {
    case 'task_queued':
      return { ...base, kind: 'control', tone: 'muted', title: '任务已进入执行队列' };
    case 'model_round_start':
      return {
        ...base,
        kind: 'analysis',
        tone: 'active',
        title: `第 ${modelRound} 轮：分析任务`,
        detail: '结合任务目标和已有观察，选择下一步可验证操作。',
      };
    case 'model_round_end':
      return {
        ...base,
        kind: 'analysis',
        tone: 'muted',
        title: `第 ${modelRound} 轮：分析完成`,
        meta: toolMeta(event),
      };
    case 'interjection_applied':
      return { ...base, kind: 'control', tone: 'active', title: '已纳入用户补充要求' };
    case 'tool_proposed':
      return {
        ...base,
        kind: 'action',
        tone: 'active',
        title: `提出工具：${title}`,
        detail: step?.toolCall?.inputSummary,
      };
    case 'policy_decision': {
      const decision = event.data?.decision;
      const prefix = decision === 'deny' ? '已阻止' : decision === 'require_approval' ? '等待确认' : '允许执行';
      return {
        ...base,
        kind: 'decision',
        tone: decision === 'deny' ? 'error' : decision === 'require_approval' ? 'warning' : 'success',
        title: `${prefix}：${title}`,
        detail: policyDetail(decision, event.data?.effect),
      };
    }
    case 'approval_resolved':
      return {
        ...base,
        kind: 'decision',
        tone: event.data?.approved ? 'success' : 'warning',
        title: event.data?.approved ? '用户已批准操作' : '用户未批准操作',
      };
    case 'tool_start':
      return {
        ...base,
        kind: 'action',
        tone: 'active',
        title: `开始执行：${title}`,
        detail: step?.toolCall?.inputSummary,
      };
    case 'tool_end': {
      const succeeded = event.data?.status === 'succeeded';
      return {
        ...base,
        kind: 'observation',
        tone: succeeded ? 'success' : 'error',
        title: succeeded ? `执行完成：${title}` : `执行失败：${title}`,
        detail: step?.outputSummary || step?.toolCall?.resultSummary || step?.errorMessage,
        meta: toolMeta(event),
      };
    }
    case 'canvas_checkpoint':
      return {
        ...base,
        kind: 'control',
        tone: 'success',
        title: '已记录画布回退点',
        detail: '本次画布修改可从任务时间线回退。',
      };
    case 'canvas_rewind':
      return { ...base, kind: 'control', tone: 'success', title: '已回退任务画布修改' };
    case 'task_status': {
      const status = event.data?.status;
      if (!status || !(status in TASK_STATUS_LABELS)) return null;
      const tone = status === 'failed'
        ? 'error'
        : status === 'waiting_approval' || status === 'paused'
          ? 'warning'
          : status === 'completed'
            ? 'success'
            : 'muted';
      return {
        ...base,
        kind: 'control',
        tone,
        title: TASK_STATUS_LABELS[status as keyof typeof TASK_STATUS_LABELS],
      };
    }
    default:
      return null;
  }
}

export function buildAgentExecutionRationale(task: AgentTask): AgentExecutionRationaleEntry[] {
  const events = task.events ?? [];
  const retainedRoundStarts = events.filter((event) => event.type === 'model_round_start').length;
  // Journal 达到 200 条上限后可能只保留后半段，从任务累计轮次反推当前片段的起始编号。
  let modelRound = Math.max(0, task.modelRounds - retainedRoundStarts);
  const entries: AgentExecutionRationaleEntry[] = [];
  for (const event of events) {
    if (event.type === 'model_round_start') modelRound += 1;
    const entry = eventToEntry(task, event, Math.max(modelRound, 1));
    if (entry) entries.push(entry);
  }
  return entries.slice(-MAX_AGENT_RATIONALE_ENTRIES);
}
