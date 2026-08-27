/**
 * chat/AgentExecutionRationale — Agent 执行依据展示组件。
 * 把 buildAgentExecutionRationale 生成的执行依据条目（分析/决策/动作/观察/控制）按语气
 * 渲染为带图标的可折叠列表，让用户可验证 Agent 每一步「为什么这么做」。
 */
import { useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentTask } from '../../types/agent';
import {
  buildAgentExecutionRationale,
  type AgentRationaleKind,
  type AgentRationaleTone,
} from '../../services/chat/agentExecutionRationale';
import { useT } from '../../i18n';

interface AgentExecutionRationaleProps {
  task: AgentTask;
}

const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'waiting_tool', 'waiting_approval']);

const KIND_ICONS: Record<AgentRationaleKind, string> = {
  analysis: 'mdi:head-cog-outline',
  decision: 'mdi:shield-check-outline',
  action: 'mdi:play-circle-outline',
  observation: 'mdi:clipboard-text-outline',
  control: 'mdi:source-branch',
};

const TONE_CLASSES: Record<AgentRationaleTone, string> = {
  active: 'text-indigo-300 bg-indigo-500/10',
  success: 'text-emerald-400 bg-emerald-500/10',
  warning: 'text-amber-400 bg-amber-500/10',
  error: 'text-red-400 bg-red-500/10',
  muted: 'text-canvas-text-muted bg-canvas-hover/60',
};

export default function AgentExecutionRationale({ task }: AgentExecutionRationaleProps) {
  const t = useT();
  const entries = buildAgentExecutionRationale(task);
  const [expanded, setExpanded] = useState(() => ACTIVE_STATUSES.has(task.status));
  if (entries.length === 0) return null;
  const latest = entries.at(-1);

  return (
    <div className="mt-2 rounded-md border border-canvas-border bg-canvas-card/80">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-canvas-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40"
      >
        <Icon icon="mdi:timeline-text-outline" width="14" className="shrink-0 text-indigo-300/90" />
        <span className="shrink-0 text-[11px] font-medium text-canvas-text-secondary">{t('执行依据')}</span>
        <span className="min-w-0 truncate text-[10px] text-canvas-text-muted">{latest?.title}</span>
        <span className="ml-auto shrink-0 text-[10px] text-canvas-text-muted">{t('{count} 项', { count: entries.length })}</span>
        <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="14" className="shrink-0 text-canvas-text-muted" />
      </button>

      {expanded && (
        <div className="border-t border-canvas-border px-2 py-2">
          <p className="mb-2 flex items-start gap-1.5 text-[10px] leading-4 text-canvas-text-muted">
            <Icon icon="mdi:information-outline" width="12" className="mt-0.5 shrink-0" />
            <span>{t('来自可验证的任务事件，不包含模型隐藏思维。')}</span>
          </p>
          <ol className="space-y-1.5">
            {entries.map((entry) => (
              <li key={entry.id} className="flex gap-2 text-[11px] leading-[17px]">
                <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${TONE_CLASSES[entry.tone]}`}>
                  <Icon icon={KIND_ICONS[entry.kind]} width="12" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="break-words text-canvas-text-secondary">{entry.title}</span>
                    {entry.meta && <span className="text-[10px] tabular-nums text-canvas-text-muted">{entry.meta}</span>}
                  </span>
                  {entry.detail && (
                    <span className="block break-words text-canvas-text-muted">{entry.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
