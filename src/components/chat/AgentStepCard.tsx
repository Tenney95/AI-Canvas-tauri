/**
 * AgentStepCard — Agent 单个步骤（P3-E1）。
 *
 * 展示工具调用的输入摘要、结果或错误、重试次数和耗时。
 * 状态用图标 + 文字表达，不只依赖颜色。不展示模型隐藏推理过程。
 */
import { useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentStep, AgentStepStatus } from '../../types/agent';
import AgentToolDetails from './AgentToolDetails';
import { AssistantActivityMark } from './AssistantActivity';
import { useT } from '../../i18n';

interface AgentStepCardProps {
  step: AgentStep;
  animateActivity?: boolean;
}

const STATUS_META: Record<AgentStepStatus, { icon: string; label: string; className: string; iconBg: string; spin?: boolean }> = {
  pending: { icon: 'mdi:clock-outline', label: '等待', className: 'text-canvas-text-muted', iconBg: 'bg-canvas-hover/60' },
  running: { icon: 'mdi:loading', label: '执行中', className: 'text-canvas-text-secondary', iconBg: 'bg-canvas-hover/60', spin: true },
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

export default function AgentStepCard({ step, animateActivity = true }: AgentStepCardProps) {
  const t = useT();
  const meta = STATUS_META[step.status];
  const duration = formatDuration(step);
  const retryCount = step.toolCall?.retryCount ?? 0;
  const detail = step.errorMessage || step.outputSummary || step.toolCall?.resultSummary;
  const compact = step.status === 'succeeded' || step.status === 'skipped';
  const disclosureScope = `${step.id}\u0000${step.status}`;
  const [disclosure, setDisclosure] = useState({ scope: disclosureScope, expanded: !compact });
  if (disclosure.scope !== disclosureScope) setDisclosure({ scope: disclosureScope, expanded: !compact });
  const expanded = disclosure.scope === disclosureScope ? disclosure.expanded : !compact;

  return (
    <div className="agent-step-card flex gap-2 rounded-md px-0.5 py-1.5 transition-colors hover:bg-canvas-hover/25">
      <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${meta.iconBg}`}>
        {meta.spin ? (
          <AssistantActivityMark active={animateActivity} />
        ) : (
          <Icon icon={meta.icon} width="12" className={meta.className} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setDisclosure({ scope: disclosureScope, expanded: !expanded })}
          className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--block min-w-0 justify-start text-left"
        >
          <span className="truncate text-[12px] text-canvas-text-secondary">{step.title}</span>
          <span className={`shrink-0 text-[10px] ${meta.className}`}>{t(meta.label)}</span>
          {retryCount > 0 && (
            <span className="shrink-0 text-[10px] text-canvas-text-muted">· {t('重试 {count}', { count: retryCount })}</span>
          )}
          {duration && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-canvas-text-muted">{duration}</span>
          )}
          <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="13"
            className={`shrink-0 text-canvas-text-muted ${duration ? '' : 'ml-auto'}`} aria-hidden="true" />
        </button>
        {expanded && (
          <>
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
            <AgentToolDetails
              input={step.toolCall?.inputDisplay}
              result={step.toolCall?.resultDisplay}
            />
          </>
        )}
      </div>
    </div>
  );
}
