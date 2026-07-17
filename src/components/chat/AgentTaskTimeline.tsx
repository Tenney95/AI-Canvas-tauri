/**
 * AgentTaskTimeline — Agent 任务时间线与后台控制（P3-E1）。
 *
 * 展示任务目标、状态、进度、可折叠步骤列表、待确认审批和控制操作
 * （暂停 / 继续 / 跳过 / 重新规划 / 停止）。
 * 只展示计划、工具调用、结果和错误摘要，不展示模型隐藏推理过程。
 * 控制均为可键盘操作的按钮，状态用图标 + 文字表达。
 */
import { useState } from 'react';
import { Icon } from '@iconify/react';
import { AGENT_TERMINAL_STATUSES, type AgentTask, type AgentTaskStatus } from '../../types/agent';
import { getAgentRecoveryHint } from '../../services/chat/agentErrorCodes';
import AgentStepCard from './AgentStepCard';
import AgentApprovalCard from './AgentApprovalCard';

export interface AgentTaskControls {
  onResolveApproval: (approvalId: string, approved: boolean) => void;
  onPause: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onStop: (taskId: string) => void;
  onSkip: (taskId: string, stepId: string) => void;
  onReplan: (taskId: string) => void;
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
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${toneClass}`}
    >
      <Icon icon={icon} width="13" />
      {label}
    </button>
  );
}

export default function AgentTaskTimeline({
  task,
  onResolveApproval,
  onPause,
  onResume,
  onStop,
  onSkip,
  onReplan,
}: AgentTaskTimelineProps) {
  const isTerminal = AGENT_TERMINAL_STATUSES.has(task.status);
  const [expanded, setExpanded] = useState(!isTerminal);

  const meta = STATUS_META[task.status];
  const isActive = ACTIVE_STATUSES.includes(task.status);
  const doneSteps = task.steps.filter((step) =>
    ['succeeded', 'failed', 'skipped', 'stopped'].includes(step.status),
  ).length;
  const pendingApprovalStep = task.steps.find((step) => step.approval?.status === 'pending');
  const recoveryHint = (task.status === 'paused' || task.status === 'failed')
    ? getAgentRecoveryHint(task.errorCode)
    : undefined;

  return (
    <div className="agent-task-timeline mt-2 rounded-lg border border-canvas-border bg-canvas-bg/50 p-2.5">
      {/* Header：状态 + 进度 + 折叠 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40 rounded"
      >
        <Icon
          icon={meta.icon}
          width="15"
          className={`shrink-0 ${meta.className} ${meta.spin ? 'animate-spin' : ''}`}
        />
        <span className={`text-xs font-medium ${meta.className}`}>{meta.label}</span>
        {task.steps.length > 0 && (
          <span className="text-[10px] text-canvas-text-muted">
            {doneSteps}/{task.steps.length} 步
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-canvas-text-muted">
          <span>轮 {task.modelRounds}/{task.budget.maxModelRounds}</span>
          <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="16" />
        </span>
      </button>

      {task.status === 'paused' && task.pausedReason && (
        <p className="mt-1.5 text-[10px] text-amber-300/90">
          {PAUSE_REASON_LABELS[task.pausedReason] ?? task.pausedReason}
        </p>
      )}
      {task.status === 'failed' && task.errorMessage && (
        <p className="mt-1.5 text-[10px] text-red-400/90 break-words">{task.errorMessage}</p>
      )}
      {recoveryHint && (
        <p className="mt-1 flex items-start gap-1 text-[10px] text-canvas-text-muted">
          <Icon icon="mdi:lightbulb-on-outline" width="12" className="mt-0.5 shrink-0 text-amber-400/80" />
          <span className="break-words">{recoveryHint.hint}</span>
        </p>
      )}

      {expanded && (
        <>
          {task.steps.length > 0 && (
            <div className="mt-2 divide-y divide-canvas-border/60 border-t border-canvas-border/60 pt-1">
              {task.steps.map((step) => (
                <AgentStepCard key={step.id} step={step} />
              ))}
            </div>
          )}

          {pendingApprovalStep && (
            <AgentApprovalCard step={pendingApprovalStep} onResolve={onResolveApproval} />
          )}

          {/* 控制操作 */}
          {!isTerminal && (
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

          {task.status === 'failed' && (
            <div className="mt-2.5 flex items-center gap-1 border-t border-canvas-border/60 pt-2">
              <ControlButton icon="mdi:play" label="继续" tone="primary" onClick={() => onResume(task.id)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
