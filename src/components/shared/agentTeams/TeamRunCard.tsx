import { memo, useId, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentTask } from '../../../types/agent';
import type { TeamArtifactReference, TeamStageRun } from '../../../types/agentTeam';
import { TEAM_TEMPLATE_LABELS } from '../../../services/chat/teams/teamProfileService';
import { useT } from '../../../i18n';
import TeamResultReview from './TeamResultReview';

export interface TeamRunCardProps {
  task: AgentTask;
  onPause?: (taskId: string) => void;
  onResume?: (taskId: string) => void;
  onStop?: (taskId: string) => void;
  onView?: (taskId: string) => void;
  onReadArtifact?: (taskId: string, artifact: TeamArtifactReference) => Promise<string>;
  onApply?: (taskId: string) => void | Promise<void>;
  onRestore?: (taskId: string) => void | Promise<void>;
  onReconcile?: (taskId: string) => void | Promise<void>;
  onAmend?: (taskId: string, instruction: string) => void | Promise<void>;
  compact?: boolean;
}

const STAGE_LABELS: Record<TeamStageRun['status'], string> = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败' };
const TASK_LABELS: Record<AgentTask['status'], string> = {
  queued: '排队中', planning: '规划中', running: '执行中', waiting_tool: '调用工具', waiting_approval: '等待确认',
  paused: '已暂停', completed: '已完成', failed: '失败', stopped: '已停止',
};
const PAUSE_REASON_LABELS: Record<string, string> = {
  user_paused: '你已暂停',
  app_restarted: '应用重启后暂停',
  team_amending: '正在更新团队要求',
  team_requirements_updated: '团队要求已更新，可继续原任务',
  team_needs_attention: '团队需要你检查问题或补充要求',
};

function TeamAmendForm({ taskId, onAmend }: { taskId: string; onAmend: NonNullable<TeamRunCardProps['onAmend']> }) {
  const t = useT();
  const inputId = useId();
  const [instruction, setInstruction] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const submit = async () => {
    const text = instruction.trim();
    if (inFlight.current || !text || text.length > 6000) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try { await onAmend(taskId, text); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('追加团队要求失败')); }
    finally { inFlight.current = false; setPending(false); }
  };
  return (
    <form className="space-y-2 border-t border-canvas-border pt-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor={inputId} className="ui-label">{t('补充要求')}</label>
      <textarea id={inputId} className="ui-input min-h-20 w-full resize-y" rows={3} maxLength={6000} value={instruction} disabled={pending}
        placeholder={t('补充你的取舍或修改要求，继续原团队任务。')} onChange={(event) => setInstruction(event.target.value)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] tabular-nums text-canvas-text-muted">{instruction.length}/6000</span>
        <button type="submit" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={pending || !instruction.trim()}>{pending ? t('正在追加要求…') : t('补充要求后继续')}</button>
      </div>
      <p className="text-[10px] text-canvas-text-muted">{t('沿用原任务和已有成果，受影响的阶段将重新执行，调用仍计入原预算。')}</p>
      {error && <p role="alert" className="break-words text-danger-light">{error}</p>}
    </form>
  );
}

function TeamRunCard({ task, onPause, onResume, onStop, onView, onReadArtifact, onApply, onRestore, onReconcile, onAmend, compact = false }: TeamRunCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(!compact);
  const [reviewOpen, setReviewOpen] = useState(false);
  const run = task.teamRun;
  if (!run) return null;
  const active = ['queued', 'planning', 'running', 'waiting_tool'].includes(task.status);
  const hasArtifacts = run.artifacts.some((artifact) => artifact.kind !== 'input');
  const completedCount = run.stages.filter((stage) => stage.status === 'completed').length;

  return (
    <section className="my-2 min-w-0 space-y-2 rounded-lg border border-canvas-border bg-canvas-card p-2 text-xs" aria-label={t('多模型团队任务')}>
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <Icon icon="mdi:account-group-outline" width="17" className="shrink-0 text-brand-light" />
        <span className="min-w-0 flex-1 truncate font-medium text-canvas-text">{t(TEAM_TEMPLATE_LABELS[run.templateId])}</span>
        <span className="shrink-0 text-canvas-text-secondary">{t(TASK_LABELS[task.status])}</span>
        <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="16" className="shrink-0 text-canvas-text-muted" />
      </button>
      {run.target && <p className="truncate text-canvas-text-muted" title={run.target.label}>{run.target.label}</p>}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-canvas-text-muted">
        <span>{t('阶段 {done}/{total}', { done: completedCount, total: run.stages.length })}</span>
        <span>{t('调用 {used}/{max}', { used: run.callsUsed, max: run.profile.maxCalls })}</span>
        <span>{run.usageKnown ? `${((run.inputTokens ?? 0) + (run.outputTokens ?? 0)).toLocaleString()} token`
          : run.usageReportedCalls > 0 ? t('部分调用用量未知') : t('实际用量待核对')}</span>
        <span>{t('费用以服务商账单为准')}</span>
      </p>
      {expanded && <ol className="space-y-1">
        {run.stages.map((stage) => <li key={stage.id} className="rounded border border-canvas-border p-2">
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-canvas-text">{t(stage.title)}</span>
            <span className={stage.status === 'failed' ? 'text-danger-light' : 'text-canvas-text-secondary'}>{t(STAGE_LABELS[stage.status])}</span></div>
          <p className="mt-1 truncate text-[11px] text-canvas-text-muted" title={stage.modelId}>{stage.modelId}</p>
          {stage.errorMessage && <p className="mt-1 break-words text-[11px] text-danger-light">{stage.errorMessage}</p>}
        </li>)}
      </ol>}
      {(task.errorMessage || task.pausedReason) && <p role="status" className="break-words text-warning-light">{task.errorMessage
        || t(PAUSE_REASON_LABELS[task.pausedReason ?? ''] ?? '团队已暂停，请检查任务后继续')}</p>}
      <p className="text-[11px] text-canvas-text-secondary">{run.application && !['applied', 'restored'].includes(run.application.status) ? t('保存结果待核对') : run.application?.status === 'applied' ? t('已应用、已保存') : run.application?.status === 'restored' ? t('已恢复原稿') : t('候选成果，尚未应用')}</p>
      <div className="flex flex-wrap gap-1">
        {active && onPause && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onPause(task.id)}>{t('暂停')}</button>}
        {['paused', 'failed'].includes(task.status) && onResume && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={() => onResume(task.id)}>{t('继续')}</button>}
        {(active || task.status === 'paused' || task.status === 'waiting_approval') && onStop && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onStop(task.id)}>{t('停止')}</button>}
        {hasArtifacts && onReadArtifact && task.status !== 'waiting_approval' && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={() => setReviewOpen(true)}>{t('查看成果与审稿')}</button>}
        {onView && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onView(task.id)}>{t('在助手查看')}</button>}
      </div>
      {['paused', 'failed'].includes(task.status) && !run.application && onAmend
        && <TeamAmendForm key={`${task.id}:${run.revision}`} taskId={task.id} onAmend={onAmend} />}
      {onReadArtifact && <TeamResultReview task={task} isOpen={reviewOpen && task.status !== 'waiting_approval'} onClose={() => setReviewOpen(false)}
        onReadArtifact={onReadArtifact} onApply={onApply} onRestore={onRestore} onReconcile={onReconcile} />}
    </section>
  );
}

export default memo(TeamRunCard);
