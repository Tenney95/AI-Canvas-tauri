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

const STATUS_META: Record<AgentStepStatus, { icon: string; label: string; className: string; spin?: boolean }> = {
  pending: { icon: 'mdi:clock-outline', label: '等待', className: 'text-slate-400' },
  running: { icon: 'mdi:loading', label: '执行中', className: 'text-emerald-400', spin: true },
  waiting_approval: { icon: 'mdi:shield-alert-outline', label: '待确认', className: 'text-amber-400' },
  succeeded: { icon: 'mdi:check-circle-outline', label: '完成', className: 'text-emerald-400' },
  failed: { icon: 'mdi:alert-circle-outline', label: '失败', className: 'text-red-400' },
  skipped: { icon: 'mdi:debug-step-over', label: '跳过', className: 'text-slate-400' },
  stopped: { icon: 'mdi:stop-circle-outline', label: '停止', className: 'text-slate-400' },
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
    <div className="flex gap-2 py-1.5">
      <Icon
        icon={meta.icon}
        width="14"
        className={`mt-0.5 shrink-0 ${meta.className} ${meta.spin ? 'animate-spin' : ''}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-medium text-canvas-text truncate">{step.title}</span>
          <span className={`shrink-0 ${meta.className}`}>· {meta.label}</span>
          {retryCount > 0 && (
            <span className="shrink-0 text-canvas-text-muted">· 重试 {retryCount}</span>
          )}
          {duration && (
            <span className="shrink-0 text-canvas-text-muted">· {duration}</span>
          )}
        </div>
        {step.toolCall?.inputSummary && (
          <p className="mt-0.5 text-[10px] leading-4 text-canvas-text-muted break-words">
            {step.toolCall.inputSummary}
          </p>
        )}
        {detail && detail !== step.toolCall?.inputSummary && (
          <p className={`mt-0.5 text-[10px] leading-4 break-words ${step.status === 'failed' ? 'text-red-400/80' : 'text-canvas-text-secondary'}`}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
