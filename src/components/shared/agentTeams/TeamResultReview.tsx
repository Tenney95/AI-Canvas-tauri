import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AgentTask } from '../../../types/agent';
import type { TeamArtifactReference } from '../../../types/agentTeam';
import { TEAM_ROLE_LABELS } from '../../../services/chat/teams/teamProfileService';
import { useT } from '../../../i18n';
import ModalOverlay from '../ModalOverlay';
import Select from '../Select';

export interface TeamResultReviewProps {
  task: AgentTask;
  isOpen: boolean;
  onClose: () => void;
  onReadArtifact: (taskId: string, artifact: TeamArtifactReference) => Promise<string>;
  onApply?: (taskId: string) => void | Promise<void>;
  onRestore?: (taskId: string) => void | Promise<void>;
  onReconcile?: (taskId: string) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function TeamArtifactContent({ text, kind }: { text: string; kind: TeamArtifactReference['kind'] }) {
  const t = useT();
  const report = useMemo(() => {
    if (kind !== 'review' && kind !== 'decision') return null;
    try { const value: unknown = JSON.parse(text); return isRecord(value) ? value : null; }
    catch { return null; }
  }, [kind, text]);
  if (kind === 'review' && report && Array.isArray(report.findings)) return (
    <div className="space-y-2">
      {report.findings.length === 0 && <p className="text-canvas-text-muted">{t('本轮未提出具体问题，仍需人工验收。')}</p>}
      {report.findings.filter(isRecord).map((finding, index) => <article key={typeof finding.id === 'string' ? finding.id : index} className="space-y-1 rounded-lg border border-canvas-border bg-canvas-card p-2">
        <div className="flex flex-wrap items-start gap-2"><span className="min-w-0 flex-1 font-medium">{typeof finding.location === 'string' ? finding.location : t('未注明位置')}</span>
          <span className="shrink-0 text-warning-light">{finding.severity === 'critical' ? t('严重问题') : finding.severity === 'major' ? t('主要问题') : t('改进建议')}</span></div>
        {typeof finding.id === 'string' && <p className="text-[10px] text-canvas-text-muted">{finding.id}</p>}
        {([
          ['evidence', '原文依据'], ['constraint', '约束依据'], ['suggestion', '修改建议'],
        ] as const).map(([key, label]) => typeof finding[key] === 'string' && <p key={key} className="whitespace-pre-wrap break-words text-xs leading-relaxed"><span className="text-canvas-text-muted">{t(label)}：</span>{finding[key] as string}</p>)}
      </article>)}
    </div>
  );
  if (kind === 'decision' && report && Array.isArray(report.decisions)) return (
    <div className="space-y-2">
      {typeof report.summary === 'string' && <p className="whitespace-pre-wrap break-words leading-relaxed">{report.summary}</p>}
      {report.decisions.filter(isRecord).map((decision, index) => <article key={index} className="space-y-1 rounded-lg border border-canvas-border bg-canvas-card p-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-words text-canvas-text-muted">{typeof decision.findingId === 'string' ? decision.findingId : ''}</span>
          <span className="font-medium">{decision.action === 'accept' ? t('采纳') : decision.action === 'reject' ? t('驳回') : t('待澄清')}</span></div>
        {typeof decision.reason === 'string' && <p className="whitespace-pre-wrap break-words leading-relaxed">{decision.reason}</p>}
      </article>)}
    </div>
  );
  return <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">{text}</pre>;
}

export default function TeamResultReview({ task, isOpen, onClose, onReadArtifact, onApply, onRestore, onReconcile }: TeamResultReviewProps) {
  const t = useT();
  const run = task.teamRun;
  const [artifactId, setArtifactId] = useState('');
  const [loaded, setLoaded] = useState({ key: '', text: '', original: '', error: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resultArtifactId = run?.resultArtifactId;
  const selected = run?.artifacts.find((artifact) => artifact.id === artifactId)
    ?? run?.artifacts.find((artifact) => artifact.id === resultArtifactId)
    ?? run?.artifacts.filter((artifact) => artifact.kind !== 'input').at(-1);
  const originalArtifactId = run?.application?.originalArtifactId;
  const originalRef = run?.artifacts.find((artifact) => artifact.id === originalArtifactId)
    ?? run?.artifacts.find((artifact) => artifact.kind === 'original');
  const loadKey = `${task.id}:${selected?.id ?? ''}:${selected?.sha256 ?? ''}:${originalRef?.id ?? ''}:${originalRef?.sha256 ?? ''}`;
  const hasOriginal = !!originalRef && originalRef.id !== selected?.id;
  const loading = !!selected && loaded.key !== loadKey;
  const text = loaded.key === loadKey ? loaded.text : '';
  const original = loaded.key === loadKey ? loaded.original : '';
  const loadError = loaded.key === loadKey ? loaded.error : '';

  useEffect(() => {
    if (!isOpen || !selected || loaded.key === loadKey) return;
    let current = true;
    const load = async () => {
      try {
        const [content, previous] = await Promise.all([
          onReadArtifact(task.id, selected),
          originalRef && originalRef.id !== selected.id ? onReadArtifact(task.id, originalRef) : Promise.resolve(''),
        ]);
        if (current) setLoaded({ key: loadKey, text: content, original: previous, error: '' });
      } catch (reason) {
        if (current) setLoaded({ key: loadKey, text: '', original: '', error: reason instanceof Error ? reason.message : t('读取团队成果失败') });
      }
    };
    void load();
    return () => { current = false; };
  }, [isOpen, loaded.key, loadKey, onReadArtifact, originalRef, selected, t, task.id]);

  if (!run) return null;
  const applied = run.application?.status === 'applied';
  const selectedStage = run.stages.find((stage) => stage.id === selected?.stageId);
  const hasUnknownDispatch = task.dispatches?.some((record) => !record.recovery && ['outcome_unknown', 'dispatched'].includes(record.phase)) ?? false;
  const pendingApplication = !!run.application && !['applied', 'restored'].includes(run.application.status);
  const canApply = !!onApply && !!run.target && !!run.resultArtifactId && run.templateId !== 'review'
    && selected?.id === run.resultArtifactId && task.status === 'completed' && task.mode !== 'plan' && !applied && !pendingApplication && !hasUnknownDispatch;
  const mutate = async (action: (taskId: string) => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await action(task.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('应用团队成果失败')); }
    finally { setBusy(false); }
  };

  return (
    <ModalOverlay isOpen={isOpen} onClose={() => { if (!busy) onClose(); }} ariaLabel={t('团队成果与审稿')}
      className="mx-2 max-h-[90vh] w-full max-w-5xl" zIndex={320}>
      <header className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
        <Icon icon="mdi:file-document-multiple-outline" width="18" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('团队成果与审稿')}</h2>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={busy} onClick={onClose} aria-label={t('关闭')}><Icon icon="mdi:close" width="18" /></button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="min-w-0 max-w-full flex-1" aria-label={t('查看团队产物')} value={selected?.id ?? ''}
            disabled={loading || busy} onChange={setArtifactId}
            options={run.artifacts.filter((artifact) => artifact.kind !== 'input')
              .map((artifact) => ({ value: artifact.id, label: t(artifact.label) }))} />
          <span className="text-canvas-text-secondary">{pendingApplication ? t('保存结果待核对') : applied ? t('已应用、已保存') : run.application?.status === 'restored' ? t('已恢复原稿') : t('候选成果，尚未应用')}</span>
        </div>
        {run.target && <p className="break-words text-canvas-text-muted">{t('原目标：{name}', { name: run.target.label })}</p>}
        {run.version === 2 && <p className="text-canvas-text-muted">{t('任务图版本 {version}', { version: run.boardRevision ?? 0 })}</p>}
        {selectedStage && <p className="break-words text-canvas-text-secondary">{t('负责人：{role}', { role: t(TEAM_ROLE_LABELS[selectedStage.roleId]) })}
          {' · '}{selectedStage.executionTarget?.kind === 'external-agent' ? 'Codex App Server · ' : ''}{selectedStage.modelId}</p>}
        {loading ? <p role="status" className="p-3 text-canvas-text-muted">{t('正在读取团队成果…')}</p> : selected ? (
          <div className={`grid min-w-0 gap-3 ${hasOriginal ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
            {hasOriginal && <section className="min-w-0 space-y-1"><h3 className="font-medium text-canvas-text-secondary">{t('应用前原稿')}</h3>
              <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-canvas-border bg-canvas-card p-3 font-sans text-xs leading-relaxed">{original || t('（空白原稿）')}</pre>
            </section>}
            <section className="min-w-0 space-y-1"><h3 className="font-medium text-canvas-text-secondary">{t(selected.label)}</h3>
              <div className="max-h-[55vh] overflow-auto rounded-lg border border-canvas-border bg-canvas-card p-3"><TeamArtifactContent text={text} kind={selected.kind} /></div>
            </section>
          </div>
        ) : <p className="text-canvas-text-muted">{t('当前阶段尚无可查看的成果。')}</p>}
        {task.mode === 'plan' && <p className="text-canvas-text-muted">{t('规划模式只查看成果，不应用到项目。')}</p>}
        {hasUnknownDispatch && <p role="status" className="ui-alert ui-alert--warning">{t('原调用结果待核实，请先在任务卡核对，再决定是否应用候选。')}</p>}
        {pendingApplication && <p role="status" className="text-warning-light">{t('上次保存的状态尚未确认，请先比较原稿与目标内容，不要重复应用。')}</p>}
        {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 text-danger-light"><span className="break-words">{loadError}</span>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => setLoaded({ key: '', text: '', original: '', error: '' })}>{t('重试读取')}</button>
        </div>}
        {error && <p role="alert" className="break-words text-danger-light">{error}</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-canvas-border p-3">
        {pendingApplication && onReconcile && <button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={() => { void mutate(onReconcile); }}>{t('核对保存状态')}</button>}
        {applied && onRestore && task.mode !== 'plan' && <button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={() => { void mutate(onRestore); }}>{t('恢复应用前原稿')}</button>}
        {canApply && <button type="button" className="ui-btn ui-btn--primary" disabled={busy || loading || !!loadError} onClick={() => { if (onApply) void mutate(onApply); }}>{t('应用到原位置')}</button>}
        <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={onClose}>{t('关闭')}</button>
      </footer>
    </ModalOverlay>
  );
}
