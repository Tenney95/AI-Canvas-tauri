import { lazy, memo, Suspense, useId, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentTask } from '../../../types/agent';
import type { TeamArtifactReference, TeamGraphDefinition, TeamStageRun } from '../../../types/agentTeam';
import { TEAM_ROLE_LABELS, TEAM_TEMPLATE_LABELS } from '../../../services/chat/teams/teamProfileService';
import { validateTeamGraph } from '../../../services/chat/teams/teamGraphService';
import { useT } from '../../../i18n';
import TeamResultReview from './TeamResultReview';
import ModalOverlay from '../ModalOverlay';

const TeamGraphEditor = lazy(() => import('./TeamGraphEditor'));

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
  onEditGraph?: (graph: TeamGraphDefinition, expected: { revision: number; boardRevision: number }) => Promise<void>;
  onResolveDispatch?: (dispatchId: string, decision: 'verified_completed' | 'abandoned') => void | Promise<void>;
  compact?: boolean;
}

const STAGE_LABELS: Record<TeamStageRun['status'], string> = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败' };
const TASK_LABELS: Record<AgentTask['status'], string> = {
  queued: '排队中', planning: '规划中', running: '执行中', waiting_tool: '调用工具', waiting_approval: '等待确认',
  paused: '已暂停', completed: '已完成', failed: '失败', stopped: '已停止',
};

function TeamGraphEditDialog({ task, onClose, onSave }: {
  task: AgentTask;
  onClose: () => void;
  onSave: NonNullable<TeamRunCardProps['onEditGraph']>;
}) {
  const t = useT();
  const run = task.teamRun!;
  const [graph, setGraph] = useState(() => structuredClone(run.graph!));
  const [expected] = useState(() => ({ revision: run.revision, boardRevision: run.boardRevision ?? 0 }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const stale = run.revision !== expected.revision || (run.boardRevision ?? 0) !== expected.boardRevision
    || !['paused', 'failed'].includes(task.status) || !!run.application || run.stages.some((stage) => stage.status === 'running')
    || task.dispatches?.some((record) => !record.recovery && ['outcome_unknown', 'dispatched'].includes(record.phase));
  const save = async () => {
    if (inFlight.current || stale) return;
    inFlight.current = true; setPending(true); setError('');
    try {
      const checked = validateTeamGraph(graph);
      if (checked.nodes.length > run.profile.maxCalls) throw new Error(t('调用预算不能少于任务数量'));
      await onSave(checked, expected); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('保存团队任务图失败')); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <ModalOverlay isOpen onClose={() => { if (!pending) onClose(); }} ariaLabel={t('编辑团队任务图')}
    className="mx-2 w-full max-w-3xl max-h-[85vh]" zIndex={320}>
    <header className="flex items-center gap-2 border-b border-canvas-border p-3">
      <h2 className="flex-1 text-sm font-semibold">{t('编辑团队任务图')}</h2>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={pending} onClick={onClose} aria-label={t('关闭')}><Icon icon="mdi:close" width="18" /></button>
    </header>
    <div className="min-h-0 overflow-y-auto p-3 space-y-3 text-xs">
      <p className="text-canvas-text-muted">{t('改图保留已有成果与调用预算，受影响的任务及下游将重新排队。')}</p>
      <Suspense fallback={<p role="status">{t('正在加载任务图…')}</p>}><TeamGraphEditor value={graph} onChange={setGraph} disabled={pending || !!stale} /></Suspense>
      {stale && <p role="status" className="ui-alert ui-alert--warning">{t('任务状态或版本已变化，请关闭后重新打开任务图。')}</p>}
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
    </div>
    <footer className="flex justify-end gap-2 border-t border-canvas-border p-3">
      <button type="button" className="ui-btn ui-btn--ghost" disabled={pending} onClick={onClose}>{t('取消')}</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={pending || !!stale} onClick={() => void save()}>{pending ? t('保存中…') : t('保存任务图')}</button>
    </footer>
  </ModalOverlay>;
}
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

function TeamRunCard({ task, onPause, onResume, onStop, onView, onReadArtifact, onApply, onRestore, onReconcile, onAmend, onEditGraph, onResolveDispatch, compact = false }: TeamRunCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(!compact);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState('');
  const resolutionInFlight = useRef(false);
  const run = task.teamRun;
  if (!run) return null;
  const active = ['queued', 'planning', 'running', 'waiting_tool'].includes(task.status);
  const hasArtifacts = run.artifacts.some((artifact) => artifact.kind !== 'input');
  const completedCount = run.stages.filter((stage) => stage.status === 'completed').length;
  const unknownDispatches = (task.dispatches ?? []).filter((record) => !record.recovery
    && (record.phase === 'outcome_unknown' || (!active && record.phase === 'dispatched')));
  const idle = ['paused', 'failed', 'stopped'].includes(task.status) && run.stages.every((stage) => stage.status !== 'running');
  const canEditGraph = !!onEditGraph && run.version === 2 && !!run.graph && idle && task.status !== 'stopped' && !run.application && !unknownDispatches.length;
  const resolveDispatch = async (dispatchId: string, decision: 'verified_completed' | 'abandoned') => {
    if (!onResolveDispatch || resolutionInFlight.current || !idle) return;
    resolutionInFlight.current = true;
    setResolving(dispatchId); setDispatchError('');
    try { await onResolveDispatch(dispatchId, decision); }
    catch (reason) { setDispatchError(reason instanceof Error ? reason.message : t('核实原调用失败')); }
    finally { resolutionInFlight.current = false; setResolving(null); }
  };

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
        {run.version === 2 && <span>{t('任务图版本 {version}', { version: run.boardRevision ?? 0 })}</span>}
        <span>{run.usageKnown ? `${((run.inputTokens ?? 0) + (run.outputTokens ?? 0)).toLocaleString()} token`
          : run.usageReportedCalls > 0 ? t('部分调用用量未知') : t('实际用量待核对')}</span>
        <span>{t('费用以服务商账单为准')}</span>
      </p>
      {expanded && <ol className="space-y-1">
        {run.stages.map((stage) => {
          const definition = run.graph?.nodes.find((node) => node.id === stage.id);
          const blocked = definition?.dependsOn.filter((id) => !run.stages.some((entry) => entry.id === id && entry.status === 'completed' && entry.artifactId)) ?? [];
          return <li key={stage.id} className="ui-card p-2">
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-canvas-text">{t(stage.title)}</span>
            <span className={stage.status === 'failed' ? 'text-danger-light' : 'text-canvas-text-secondary'}>{t(STAGE_LABELS[stage.status])}</span></div>
          <p className="mt-1 break-words text-[11px] text-canvas-text-muted">{t('负责人：{role}', { role: t(TEAM_ROLE_LABELS[stage.roleId]) })}
            {' · '}{stage.executionTarget?.kind === 'external-agent' ? 'Codex App Server · ' : ''}{stage.modelId}</p>
          {blocked.length > 0 && stage.status !== 'completed' && <p className="mt-1 break-words text-[11px] text-warning-light">{t('等待依赖：{names}', {
            names: blocked.map((id) => run.stages.find((entry) => entry.id === id)?.title ?? id).join('、'),
          })}</p>}
          {stage.errorMessage && <p className="mt-1 break-words text-[11px] text-danger-light">{stage.errorMessage}</p>}
        </li>; })}
      </ol>}
      {(task.errorMessage || task.pausedReason) && <p role="status" className="break-words text-warning-light">{task.errorMessage
        || t(PAUSE_REASON_LABELS[task.pausedReason ?? ''] ?? '团队已暂停，请检查任务后继续')}</p>}
      <p className="text-[11px] text-canvas-text-secondary">{run.application && !['applied', 'restored'].includes(run.application.status) ? t('保存结果待核对') : run.application?.status === 'applied' ? t('已应用、已保存') : run.application?.status === 'restored' ? t('已恢复原稿') : t('候选成果，尚未应用')}</p>
      <div className="flex flex-wrap gap-1">
        {active && onPause && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onPause(task.id)}>{t('暂停')}</button>}
        {['paused', 'failed'].includes(task.status) && onResume && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={unknownDispatches.length > 0 || !!resolving} onClick={() => onResume(task.id)}>{t('继续')}</button>}
        {(active || task.status === 'paused' || task.status === 'waiting_approval') && onStop && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onStop(task.id)}>{t('停止')}</button>}
        {hasArtifacts && onReadArtifact && task.status !== 'waiting_approval' && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={() => setReviewOpen(true)}>{t('查看成果与审稿')}</button>}
        {onView && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => onView(task.id)}>{t('在助手查看')}</button>}
        {canEditGraph && <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={() => setGraphOpen(true)}>{t('编辑任务图')}</button>}
      </div>
      {!!unknownDispatches.length && <section className="ui-alert ui-alert--warning space-y-2" aria-label={t('原调用结果待核实')}>
        <p>{t('原调用结果待核实，请先查看服务商记录或已有成果，不能直接重投。')}</p>
        <p className="text-[11px]">{t('放弃原调用不代表未执行，也不会重新提交；已核实完成不会自动补回缺失成果。')}</p>
        {unknownDispatches.map((record) => <div key={record.id} className="space-y-1">
          <p className="break-words text-xs">{run.stages.find((stage) => stage.id === record.stepId)?.title ?? t('原调用')}</p>
          {onResolveDispatch && <div className="flex flex-wrap gap-1">
            <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={!idle || !!resolving} onClick={() => void resolveDispatch(record.id, 'verified_completed')}>{t('已核实完成')}</button>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={!idle || !!resolving} onClick={() => void resolveDispatch(record.id, 'abandoned')}>{t('放弃原调用，不重新提交')}</button>
          </div>}
        </div>)}
        {dispatchError && <p role="alert" className="break-words text-danger-light">{dispatchError}</p>}
      </section>}
      {['paused', 'failed'].includes(task.status) && !run.application && !unknownDispatches.length && onAmend
        && <TeamAmendForm key={`${task.id}:${run.revision}`} taskId={task.id} onAmend={onAmend} />}
      {onReadArtifact && <TeamResultReview task={task} isOpen={reviewOpen && task.status !== 'waiting_approval'} onClose={() => setReviewOpen(false)}
        onReadArtifact={onReadArtifact} onApply={onApply} onRestore={onRestore} onReconcile={onReconcile} />}
      {graphOpen && onEditGraph && run.version === 2 && run.graph && <TeamGraphEditDialog key={task.id} task={task} onClose={() => setGraphOpen(false)} onSave={onEditGraph} />}
    </section>
  );
}

export default memo(TeamRunCard);
