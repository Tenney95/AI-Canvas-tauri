/**
 * AgentStepCard — Agent 单个步骤（P3-E1）。
 *
 * 展示工具调用的输入摘要、结果或错误、重试次数和耗时。
 * 状态用图标 + 文字表达，不只依赖颜色。不展示模型隐藏推理过程。
 */
import { Icon } from '@iconify/react';
import type { AgentStep, AgentStepStatus } from '../../types/agent';

interface AgentStepCardProps {
  step: AgentStep;
}

const STATUS_META: Record<AgentStepStatus, { icon: string; label: string; className: string; iconBg: string; spin?: boolean }> = {
  pending: { icon: 'mdi:clock-outline', label: '等待', className: 'text-canvas-text-muted', iconBg: 'bg-canvas-hover/60' },
  running: { icon: 'mdi:loading', label: '执行中', className: 'text-indigo-400', iconBg: 'bg-indigo-500/10', spin: true },
  waiting_approval: { icon: 'mdi:shield-alert-outline', label: '待确认', className: 'text-amber-400', iconBg: 'bg-amber-500/10' },
  succeeded: { icon: 'mdi:check', label: '完成', className: 'text-emerald-400', iconBg: 'bg-emerald-500/10' },
  failed: { icon: 'mdi:alert-outline', label: '失败', className: 'text-red-400', iconBg: 'bg-red-500/10' },
  skipped: { icon: 'mdi:debug-step-over', label: '跳过', className: 'text-canvas-text-muted', iconBg: 'bg-canvas-hover/60' },
  stopped: { icon: 'mdi:stop', label: '停止', className: 'text-canvas-text-muted', iconBg: 'bg-canvas-hover/60' },
};

function formatDuration(step: AgentStep): string | null {
  const start = step.toolCall?.startedAt ?? step.createdAt;
  const end = step.toolCall?.finishedAt;
  if (!end || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function AgentStepCard({ step }: AgentStepCardProps) {
  const meta = STATUS_META[step.status];
  const duration = formatDuration(step);
  const retryCount = step.toolCall?.retryCount ?? 0;
  const detail = step.errorMessage || step.outputSummary || step.toolCall?.resultSummary;

  return (
    <div className="flex gap-2 rounded-md px-0.5 py-1.5 transition-colors hover:bg-canvas-hover/25">
      <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${meta.iconBg}`}>
        <Icon
          icon={meta.icon}
          width="12"
          className={`${meta.className} ${meta.spin ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-[17px]">
          <span className="truncate text-[12px] text-canvas-text-secondary">{step.title}</span>
          <span className={`shrink-0 text-[10px] ${meta.className}`}>{meta.label}</span>
          {retryCount > 0 && (
            <span className="shrink-0 text-[10px] text-canvas-text-muted">· 重试 {retryCount}</span>
          )}
          {duration && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-canvas-text-muted">{duration}</span>
          )}
        </div>
        {step.toolCall?.inputSummary && (
          <p className="break-words text-[11px] leading-[17px] text-canvas-text-muted">
            {step.toolCall.inputSummary}
          </p>
        )}
        {detail && detail !== step.toolCall?.inputSummary && (
          <p className={`break-words text-[11px] leading-[17px] ${step.status === 'failed' ? 'text-red-400/85' : 'text-canvas-text-secondary'}`}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
