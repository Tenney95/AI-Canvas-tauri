/**
 * AgentTaskTimeline — Agent 任务时间线与后台控制（P3-E1）。
 *
 * 展示任务目标、状态、进度、可折叠步骤列表、待确认审批和控制操作
 * （暂停 / 继续 / 跳过 / 重新规划 / 停止）。
 * 只展示计划、工具调用、结果和错误摘要，不展示模型隐藏推理过程。
 * 控制均为可键盘操作的按钮，状态用图标 + 文字表达。
 */
import { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import {
  AGENT_TERMINAL_STATUSES,
  type AgentApprovalResolution,
  type AgentStep,
  type AgentTask,
  type AgentTaskStatus,
} from '../../types/agent';
import { getAgentRecoveryHint } from '../../services/chat/agentErrorCodes';
import AgentStepCard from './AgentStepCard';
import AgentApprovalCard from './AgentApprovalCard';
import type { MediaModelOption } from '../nodes/shared/defaultModels';

export interface AgentTaskControls {
  onResolveApproval: (approvalId: string, resolution: AgentApprovalResolution) => void;
  mediaModelOptions: MediaModelOption[];
  mediaModelAvailability: Record<string, boolean>;
  onPause: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onStop: (taskId: string) => void;
  onSkip: (taskId: string, stepId: string) => void;
  onReplan: (taskId: string) => void;
  onRewind: (taskId: string) => void;
}

interface AgentTaskTimelineProps extends AgentTaskControls {
  task: AgentTask;
}

const STATUS_META: Record<AgentTaskStatus, { label: string; icon: string; className: string; spin?: boolean }> = {
  queued: { label: '排队中', icon: 'mdi:clock-outline', className: 'text-slate-400' },
  planning: { label: '规划中', icon: 'mdi:loading', className: 'text-violet-400', spin: true },
  running: { label: '执行中', icon: 'mdi:loading', className: 'text-emerald-400', spin: true },
  waiting_tool: { label: '调用工具', icon: 'mdi:loading', className: 'text-sky-400', spin: true },
  waiting_approval: { label: '等待确认', icon: 'mdi:shield-alert-outline', className: 'text-amber-400' },
  paused: { label: '已暂停', icon: 'mdi:pause-circle-outline', className: 'text-slate-400' },
  completed: { label: '已完成', icon: 'mdi:check-circle-outline', className: 'text-emerald-400' },
  failed: { label: '失败', icon: 'mdi:alert-circle-outline', className: 'text-red-400' },
  stopped: { label: '已停止', icon: 'mdi:stop-circle-outline', className: 'text-slate-400' },
};

const PAUSE_REASON_LABELS: Record<string, string> = {
  user_paused: '你已暂停',
  model_round_budget_exhausted: '已达模型轮次上限',
  tool_call_budget_exhausted: '已达工具调用上限',
  tool_result_budget_exhausted: '工具结果已达上限',
  context_budget_exhausted: '上下文接近模型上限',
  context_compression_failed: '上下文压缩失败',
  step_skipped_replan_required: '已跳过步骤，需重新规划',
  replan_requested: '已请求重新规划',
  app_restarted: '应用重启后暂停',
};

const ACTIVE_STATUSES: AgentTaskStatus[] = ['queued', 'planning', 'running', 'waiting_tool', 'waiting_approval'];

const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  web_search: '正在搜索网页',
  web_extract: '正在浏览网页',
  file_list_grants: '正在查看已授权文件',
  file_read_text: '正在读取文件',
  provider_docs_read: '正在读取接口文档',
};

function findActiveStep(task: AgentTask): AgentStep | undefined {
  const selected = task.currentStepId
    ? task.steps.find((step) => step.id === task.currentStepId)
    : undefined;
  if (selected && ['pending', 'running', 'waiting_approval'].includes(selected.status)) {
    return selected;
  }
  for (let index = task.steps.length - 1; index >= 0; index -= 1) {
    const step = task.steps[index];
    if (['pending', 'running', 'waiting_approval'].includes(step.status)) return step;
  }
  return undefined;
}

function getActivityLabel(task: AgentTask, step?: AgentStep): string {
  if (task.status === 'waiting_approval' || step?.status === 'waiting_approval') {
    return step ? `等待确认：${step.title}` : '等待用户确认';
  }
  if (step?.status === 'pending') return `准备${step.title}`;
  if (step?.status === 'running') {
    return TOOL_ACTIVITY_LABELS[step.toolCall?.toolId ?? ''] ?? `正在${step.title}`;
  }
  if (task.status === 'queued') return '正在等待执行';
  if (task.status === 'planning') {
    return task.steps.some((item) => item.status === 'succeeded')
      ? '正在分析工具结果'
      : '正在分析请求';
  }
  if (task.status === 'waiting_tool') return '正在调用工具';
  if (task.status === 'running') return '正在整理结果';
  return STATUS_META[task.status].label;
}

function getActivityStartedAt(task: AgentTask, step?: AgentStep): number {
  if (step?.toolCall?.startedAt) return step.toolCall.startedAt;
  const eventType = task.status === 'planning' ? 'model_round_start' : 'tool_start';
  for (let index = (task.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = task.events?.[index];
    if (event?.type === eventType) return event.timestamp;
  }
  return task.startedAt ?? task.createdAt;
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds % 60}s`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

interface ControlButtonProps {
  icon: string;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'primary' | 'danger';
}

function ControlButton({ icon, label, onClick, tone = 'default' }: ControlButtonProps) {
  const toneClass = tone === 'primary'
    ? 'text-indigo-300 hover:bg-indigo-500/15'
    : tone === 'danger'
      ? 'text-red-400 hover:bg-red-500/10'
      : 'text-canvas-text-secondary hover:bg-canvas-hover hover:text-canvas-text';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${toneClass}`}
    >
      <Icon icon={icon} width="14" />
      {label}
    </button>
  );
}

export default function AgentTaskTimeline({
  task,
  onResolveApproval,
  mediaModelOptions,
  mediaModelAvailability,
  onPause,
  onResume,
  onStop,
  onSkip,
  onReplan,
  onRewind,
}: AgentTaskTimelineProps) {
  const isTerminal = AGENT_TERMINAL_STATUSES.has(task.status);
  const isExpertTask = !!task.parentTaskId;
  const [expanded, setExpanded] = useState(!isTerminal);

  const meta = STATUS_META[task.status];
  const isActive = ACTIVE_STATUSES.includes(task.status);
  const activeStep = findActiveStep(task);
  const activityLabel = getActivityLabel(task, activeStep);
  const activityDetail = activeStep?.toolCall?.inputSummary ?? activeStep?.approval?.summary;
  const activityStartedAt = getActivityStartedAt(task, activeStep);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive || task.status === 'waiting_approval') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStep?.id, activeStep?.status, isActive, task.status]);
  const doneSteps = task.steps.filter((step) =>
    ['succeeded', 'failed', 'skipped', 'stopped'].includes(step.status),
  ).length;
  const pendingApprovalStep = task.steps.find((step) => step.approval?.status === 'pending');
  const recoveryHint = (task.status === 'paused' || task.status === 'failed')
    ? getAgentRecoveryHint(task.errorCode)
    : undefined;
  const hasCanvasCheckpoint = task.steps.some((step) =>
    step.status === 'succeeded' && !!step.toolCall?.canvasCheckpoint);
  const metrics = task.metrics;
  const totalTokens = metrics ? metrics.inputTokens + metrics.outputTokens : 0;
  const taskDuration = task.startedAt
    ? Math.max(0, (task.completedAt ?? task.updatedAt) - task.startedAt)
    : 0;
  const terminalLabel = task.status === 'completed' ? '运行记录' : meta.label;

  return (
    <div className="agent-task-timeline mt-2 max-w-full py-0.5">
      {/* 当前活动：只展示可验证的任务和工具状态，不展示模型隐藏推理。 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-0.5 text-left transition-colors hover:bg-canvas-hover/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
      >
        <Icon
          icon={meta.icon}
          width="14"
          className={`shrink-0 ${isActive ? 'text-canvas-text-muted' : meta.className} ${meta.spin ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
        <span className="min-w-0 truncate text-[12px] font-medium text-canvas-text-secondary">
          {isActive ? activityLabel : terminalLabel}
        </span>
        {isActive && task.status !== 'waiting_approval' && (
          <span className="shrink-0 text-[10px] tabular-nums text-canvas-text-muted">
            {formatElapsed(activityStartedAt, now)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-canvas-text-muted">
          {task.steps.length > 0 && (
            <span>{isTerminal ? task.steps.length : `${doneSteps}/${task.steps.length}`} 步</span>
          )}
          {!isActive && taskDuration > 0 && <span>· {formatDuration(taskDuration)}</span>}
          <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="15" />
        </span>
      </button>

      {isActive && activityDetail && (
        <p className="break-words pl-5 text-[11px] leading-[17px] text-canvas-text-muted">
          {activityDetail}
        </p>
      )}

      {expanded && metrics && (metrics.inputTokens > 0 || metrics.outputTokens > 0 || metrics.policyDenied > 0 || metrics.retryCount > 0) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-5 text-[10px] tabular-nums text-canvas-text-muted">
          {totalTokens > 0 && <span>{totalTokens.toLocaleString()} token</span>}
          {metrics.policyDenied > 0 && <span>{metrics.policyDenied} 次拒绝</span>}
          {metrics.retryCount > 0 && <span>{metrics.retryCount} 次重试</span>}
        </div>
      )}

      {task.status === 'paused' && task.pausedReason && (
        <p className="mt-1.5 text-[11px] leading-[17px] text-amber-300/90">
          {PAUSE_REASON_LABELS[task.pausedReason] ?? task.pausedReason}
        </p>
      )}
      {task.status === 'failed' && task.errorMessage && (
        <p className="mt-1.5 break-words text-[11px] leading-[17px] text-red-400/90">{task.errorMessage}</p>
      )}
      {recoveryHint && (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-[17px] text-canvas-text-muted">
          <Icon icon="mdi:lightbulb-on-outline" width="13" className="mt-0.5 shrink-0 text-amber-400/80" />
          <span className="break-words">{recoveryHint.hint}</span>
        </p>
      )}

      {expanded && (
        <>
          {task.steps.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {task.steps.map((step) => (
                <AgentStepCard key={step.id} step={step} />
              ))}
            </div>
          )}

          {pendingApprovalStep && (
            <AgentApprovalCard
              key={pendingApprovalStep.approval?.id}
              step={pendingApprovalStep}
              mediaModelOptions={mediaModelOptions}
              mediaModelAvailability={mediaModelAvailability}
              onResolve={onResolveApproval}
            />
          )}

          {/* 控制操作 */}
          {!isTerminal && !isExpertTask && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-canvas-border/60 pt-2">
              {isActive && task.status !== 'waiting_approval' && (
                <ControlButton icon="mdi:pause" label="暂停" onClick={() => onPause(task.id)} />
              )}
              {task.status === 'paused' && (
                <ControlButton icon="mdi:play" label="继续" tone="primary" onClick={() => onResume(task.id)} />
              )}
              {pendingApprovalStep && (
                <ControlButton
                  icon="mdi:debug-step-over"
                  label="跳过此步"
                  onClick={() => onSkip(task.id, pendingApprovalStep.id)}
                />
              )}
              <ControlButton icon="mdi:refresh" label="重新规划" onClick={() => onReplan(task.id)} />
              <ControlButton icon="mdi:stop" label="停止" tone="danger" onClick={() => onStop(task.id)} />
            </div>
          )}

          {task.status === 'failed' && !isExpertTask && (
            <div className="mt-2.5 flex items-center gap-1 border-t border-canvas-border/60 pt-2">
              <ControlButton icon="mdi:play" label="继续" tone="primary" onClick={() => onResume(task.id)} />
            </div>
          )}
          {!isExpertTask && !isActive && hasCanvasCheckpoint && (
            <div className="mt-2.5 flex items-center gap-1 border-t border-canvas-border/60 pt-2">
              <ControlButton
                icon="mdi:backup-restore"
                label="回退任务画布修改"
                onClick={() => onRewind(task.id)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
