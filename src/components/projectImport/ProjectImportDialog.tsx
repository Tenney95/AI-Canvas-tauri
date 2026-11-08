/** 只读项目包比较；不挂载画布节点、插件或生成控件。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../../store/useAppStore';
import { closePreparedProjectImport, projectImportMediaPreview, type PreparedProjectImport, type ProjectImportPreview } from '../../services/projectImportService';
import { resolveProjectMerge, type ProjectMergeChange, type ProjectMergeSide } from '../../services/projectMergeService';
import { resolveProjectMergeV2 } from '../../services/projectMergeV2Service';
import { NATIVE_EDITOR_CHOICE_KEY } from '../../services/videoEditorArchive';
import type { ProjectExchangeValue } from '../../types/projectExchange';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';
import { useT } from '../../i18n';

const labels: Record<ProjectMergeChange['kind'], string> = { project: '项目与分集', node: '画布节点', edge: '连线', group: '分组',
  character: '人物', scene: '场景', prop: '道具', referenceImage: '参考图', voiceClip: '声音', action: '动作', actionMedia: '动作素材',
  shot: '镜头行', file: '素材文件', imageMetadata: '图片信息' };
function Value({ value, media }: { value: ProjectExchangeValue | undefined; media?: { url: string; kind: string } | null }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const text = value === undefined ? t('（不存在 / 已删除）') : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <div className="space-y-2">
    {media?.kind === 'image' && <img src={media.url} alt={t('素材预览')} loading="lazy" decoding="async" className="max-h-40 w-full rounded bg-canvas-bg object-contain" />}
    {media?.kind === 'video' && <video src={media.url} controls preload="none" className="max-h-40 w-full rounded bg-canvas-bg" />}
    {media?.kind === 'audio' && <audio src={media.url} controls preload="none" className="w-full" />}
    <pre className="max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded border border-canvas-border bg-canvas-bg p-2 text-xs leading-5 text-canvas-text">{expanded ? text : text.slice(0, 8000)}</pre>
    {text.length > 8000 && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => setExpanded(!expanded)}>{t(expanded ? '收起全文' : '显示全文')}</button>}
  </div>;
}
export default function ProjectImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const t = useT(), projects = useAppStore((state) => state.projects);
  const prepare = useAppStore((state) => state.prepareProjectImport), compare = useAppStore((state) => state.previewProjectImport);
  const apply = useAppStore((state) => state.importProject);
  const [session, setSession] = useState<PreparedProjectImport | null>(null), sessionRef = useRef<PreparedProjectImport | null>(null);
  const [baseline, setBaseline] = useState<PreparedProjectImport | null>(null), baselineRef = useRef<PreparedProjectImport | null>(null);
  const pendingCleanup = useRef(new Set<PreparedProjectImport>());
  const [baseConfirmed, setBaseConfirmed] = useState(false);
  const [mode, setMode] = useState<'new' | 'update'>('new'), [targetId, setTargetId] = useState('');
  const [preview, setPreview] = useState<ProjectImportPreview | null>(null), [choices, setChoices] = useState<Record<string, ProjectMergeSide>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [appendChat, setAppendChat] = useState(false), [appendMemories, setAppendMemories] = useState(false);
  const transfer = useRef<{ id?: string; controller: AbortController } | null>(null);
  const [progress, setProgress] = useState<number | null>(null), [canCancel, setCanCancel] = useState(false);
  const [independent, setIndependent] = useState(false), [conflictsOnly, setConflictsOnly] = useState(true), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const candidates = projects.filter((project) => !project.parentId && (session?.manifest.formatVersion !== 4 || 'nativeView' in project));
  useEffect(() => {
    let active = true, unlisten: (() => void) | undefined;
    void listen<{ taskId: string; transferredBytes: number; totalBytes: number }>('file-transfer-progress', (event) => {
      if (active && event.payload.taskId === transfer.current?.id && event.payload.totalBytes > 0) setProgress(Math.min(100, Math.round(event.payload.transferredBytes * 100 / event.payload.totalBytes)));
    }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => undefined);
    return () => { active = false; unlisten?.(); };
  }, []);
  const filtered = useMemo(() => preview?.plan.changes.filter((change) => (!conflictsOnly || change.conflict)
    && `${change.label} ${change.field} ${labels[change.kind]}`.toLowerCase().includes(query.toLowerCase())) ?? [], [preview, conflictsOnly, query]);
  const conflicts = preview?.plan.changes.filter((change) => change.conflict) ?? [];
  const editorChoiceRequired = !!preview?.nativeUpdate?.editorChoiceRequired;
  const unresolved = conflicts.filter((change) => !choices[change.id]).length
    + (editorChoiceRequired && !choices[NATIVE_EDITOR_CHOICE_KEY] ? 1 : 0);
  const dependencyError = useMemo(() => {
    if (!preview || unresolved || preview.plan.alreadyApplied) return '';
    try { if (preview.nativeUpdate) resolveProjectMergeV2(preview.nativeUpdate.plan, choices); else resolveProjectMerge(preview.plan, choices); return ''; } catch (cause) { return cause instanceof Error ? cause.message : t('合并依赖不完整'); }
  }, [preview, choices, unresolved, t]);
  const cleanupSession = async (prepared: PreparedProjectImport) => {
    pendingCleanup.current.add(prepared);
    await closePreparedProjectImport(prepared);
    pendingCleanup.current.delete(prepared);
  };
  const retryCleanup = async () => {
    for (const prepared of [...pendingCleanup.current]) await cleanupSession(prepared);
  };
  const close = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await retryCleanup();
      if (sessionRef.current) await cleanupSession(sessionRef.current);
      if (baselineRef.current) await cleanupSession(baselineRef.current);
      sessionRef.current = null; baselineRef.current = null; onClose();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('清理暂存素材失败，请重试')); setBusy(false); }
  };
  const chooseFile = async () => {
    setBusy(true); setError('');
    let next: PreparedProjectImport | null = null;
    try {
      await retryCleanup();
      next = await prepare(); if (!next) return;
      if (sessionRef.current) await cleanupSession(sessionRef.current);
      if (baselineRef.current) await cleanupSession(baselineRef.current);
      baselineRef.current = null; setBaseline(null); setBaseConfirmed(false);
      sessionRef.current = next; setSession(next); setPreview(null); setChoices({});
      if (next.manifest.formatVersion === 4) setMode('new');
      next = null;
    } catch (cause) {
      if (next) await cleanupSession(next).catch(() => undefined);
      setError(pendingCleanup.current.size ? t('清理暂存素材失败，请重试关闭或重新选择项目包') : cause instanceof Error ? cause.message : t('读取项目包失败'));
    } finally { setBusy(false); }
  };
  const runCompare = async () => {
    if (!session || !targetId) return; setBusy(true); setError(''); setPreview(null); setChoices({});
    try { const result = await compare(session, targetId, baseConfirmed ? baseline ?? undefined : undefined); setPreview(result); setPage(0); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('对比失败')); } finally { setBusy(false); }
  };
  const chooseBaseline = async () => {
    setBusy(true); setError('');
    let next: PreparedProjectImport | null = null;
    try {
      await retryCleanup();
      next = await prepare(); if (!next) return;
      if (next.manifest.formatVersion === 4) throw new Error(t('新结构项目包暂不能作为旧项目更新的共同版本'));
      if (baselineRef.current) await cleanupSession(baselineRef.current);
      baselineRef.current = next; setBaseline(next); setBaseConfirmed(false); setPreview(null);
      next = null;
    } catch (cause) {
      if (next) await cleanupSession(next).catch(() => undefined);
      setError(pendingCleanup.current.size ? t('清理暂存素材失败，请重试关闭或重新选择项目包') : cause instanceof Error ? cause.message : t('读取原始包失败'));
    } finally { setBusy(false); }
  };
  const runApply = async () => {
    if (!session) return; setBusy(true); setError('');
    const controller = new AbortController(); transfer.current = { controller }; setCanCancel(false); setProgress(null);
    try {
      await retryCleanup();
      const id = await apply(session, mode === 'update' ? preview : null, choices, { appendChat, appendMemories, independent,
        signal: controller.signal, onTransfer: (id) => { transfer.current = { id, controller }; setCanCancel(true); setProgress(0); } });
      if (!id) throw new Error(t('项目导入未完成'));
      // 数据库已提交；暂存清理失败不能误报为项目导入失败。
      await closePreparedProjectImport(session).catch(() => useAppStore.getState().showToast('项目已导入，暂存目录清理失败，可在存储健康中检查', 'info'));
      if (baselineRef.current) await closePreparedProjectImport(baselineRef.current).catch(() => undefined);
      sessionRef.current = null; baselineRef.current = null; onImported();
    } catch (cause) { setError(controller.signal.aborted ? t('已取消导入，原项目未改变') : cause instanceof Error ? cause.message : t('导入失败')); }
    finally { transfer.current = null; setCanCancel(false); setBusy(false); }
  };
  return <ModalOverlay isOpen onClose={() => void close()} ariaLabel={t('导入与更新项目')} zIndex={350} closeOnBackdrop={!busy}
    className="ui-dialog-surface flex max-h-[calc(100dvh-24px)] w-[min(1000px,calc(100vw-24px))] flex-col text-canvas-text">
    <header className="flex items-center justify-between border-b border-canvas-border p-3">
      <h2 className="text-sm font-semibold">{t('导入与更新项目')}</h2><PopupCloseButton onClick={() => void close()} disabled={busy} />
    </header>
    <div className="min-h-0 space-y-3 overflow-y-auto p-3" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={() => void chooseFile()}>{t(session ? '重新选择项目包' : '选择项目包')}</button>
        {session && <span className="min-w-0 break-all text-xs text-canvas-text-secondary">{session.manifest.projectName} · {session.manifest.episodeCount ?? Math.max(0, session.records.length - 1)} {t('个分集')} · {session.assets.length} {t('个素材')} · v{session.manifest.formatVersion}</span>}
      </div>
      {session && <>
        <fieldset disabled={busy} className="flex flex-wrap gap-3 text-sm"><legend className="sr-only">{t('导入方式')}</legend>
          <label className="flex items-center gap-2"><input type="radio" name="project-import-mode" checked={mode === 'new'} onChange={() => { setMode('new'); setPreview(null); }} />{t('导入为新项目')}</label>
          <label className="flex items-center gap-2"><input type="radio" name="project-import-mode" checked={mode === 'update'} onChange={() => setMode('update')} />{t('更新已有项目')}</label>
        </fieldset>
        {session.manifest.formatVersion === 4 && mode === 'update' && <p className="text-xs text-canvas-text-secondary">{t('更新前会核对共同来源并保存恢复点；素材、分集和剪辑工程的冲突需要明确选择。')}</p>}
        {session.nativeSourceError && mode === 'new' && <p role="alert" className="ui-alert ui-alert--danger text-xs">{t(session.nativeSourceError)}</p>}
        {mode === 'new' ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={independent} disabled={busy} onChange={(event) => setIndependent(event.target.checked)} />{t('作为独立副本，开始新的协作来源')}</label>
          : <div className="flex flex-wrap items-center gap-2"><Select aria-label={t('要更新的项目')} value={targetId} disabled={busy} onChange={(value) => { setTargetId(value); setPreview(null); setChoices({}); }} className="min-w-0 flex-1">
            <option value="">{t('请选择目标项目或整部剧')}</option>{candidates.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.id.slice(0, 8)}</option>)}
          </Select><button type="button" className="ui-btn ui-btn--secondary" disabled={busy || !targetId} onClick={() => void runCompare()}>{t(preview ? '重新对比' : '对比改动')}</button></div>}
        {session.manifest.formatVersion !== 4 && !session.bundle && <div className="space-y-2"><p className="ui-alert text-xs">{t('旧项目包没有可靠共同版本。更新时每项差异都需要人工选择；请仔细核对分集与删除项。')}</p>
          {mode === 'update' && <><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => void chooseBaseline()}>{t('补充最初交接的项目包')}</button>
            {baseline && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={baseConfirmed} disabled={busy} onChange={(event) => { setBaseConfirmed(event.target.checked); setPreview(null); }} />
              <span>{baseline.manifest.projectName} · {t('我确认这是双方开始修改前的共同版本；选择错误会影响自动合并和删除判断。')}</span></label>}</>}
        </div>}
        {preview && mode === 'update' && <>
          {editorChoiceRequired && <fieldset disabled={busy} className="ui-card space-y-2 p-3 text-xs">
            <legend className="font-medium text-canvas-text">{t('选择剪辑工程版本')}</legend>
            <p className="text-canvas-text-secondary">{t('剪辑工程没有可核验的共同版本。请选择保留本机全部工程，或替换为项目包中的全部工程；更新前的工程会保存到恢复点；被删除画布的本机工程会作为历史保留。')}</p>
            <label className="flex items-center gap-2"><input type="radio" name="native-editor-update-choice"
              checked={choices[NATIVE_EDITOR_CHOICE_KEY] === 'local'} onChange={() => setChoices((current) => ({ ...current, [NATIVE_EDITOR_CHOICE_KEY]: 'local' }))} />
              {t('保留本机剪辑工程')} · {preview.nativeUpdate?.expected.editorRecords?.length ?? 0}</label>
            <label className="flex items-center gap-2"><input type="radio" name="native-editor-update-choice"
              checked={choices[NATIVE_EDITOR_CHOICE_KEY] === 'incoming'} onChange={() => setChoices((current) => ({ ...current, [NATIVE_EDITOR_CHOICE_KEY]: 'incoming' }))} />
              {t('使用项目包剪辑工程')} · {preview.nativeUpdate?.source.payload.videoEditor?.records.length ?? 0}</label>
          </fieldset>}
          <p className="text-xs text-canvas-text-secondary" role="status">{preview.plan.alreadyApplied ? t('该版本已处理；重复导入不会覆盖之后的本机修改。')
            : t('可自动合并 {auto} 项，冲突 {conflicts} 项，尚有 {remaining} 项未选择', { auto: preview.plan.changes.length - conflicts.length, conflicts: conflicts.length + (editorChoiceRequired ? 1 : 0), remaining: unresolved })}
            {preview.baseStatus === 'externalConfirmed' ? ` · ${t('使用已确认的原始交接包作为共同版本')}` : preview.baseStatus !== 'found' && !preview.plan.alreadyApplied && ` · ${t('共同版本不可用，采用人工对照')}`}</p>
          {!preview.plan.alreadyApplied && <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={conflictsOnly} onChange={(event) => { setConflictsOnly(event.target.checked); setPage(0); }} />{t('只看冲突')}</label>
              <input aria-label={t('筛选改动')} className="ui-input min-w-0 flex-1" placeholder={t('搜索名称、字段或类型')} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
              {(['local', 'incoming'] as const).map((side) => <button type="button" key={side} className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || !filtered.length}
                onClick={() => setChoices((current) => ({ ...current, ...Object.fromEntries(filtered.map((change) => [change.id, side])) }))}>{t(side === 'local' ? '筛选内保留我的（{count}）' : '筛选内采用对方（{count}）', { count: filtered.length })}</button>)}
            </div>
            <div className="space-y-2">{filtered.slice(page * 30, page * 30 + 30).map((change) => <article key={change.id} className="ui-card p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-all text-xs font-semibold">{t(labels[change.kind])} · {change.label} · {change.field}</h3>
                <span className="text-xs text-canvas-text-muted">{change.conflict ? t('冲突') : t('自动合并，可调整')}</span></div>
              <div className="grid gap-2 sm:grid-cols-2">{(['local', 'incoming'] as const).map((side) => <div key={side} className="min-w-0 space-y-2">
                <Value value={change[side]} media={projectImportMediaPreview(session, preview, side, change[side])} /><button type="button" disabled={busy} className={`ui-btn ui-btn--sm ${(choices[change.id] ?? change.automatic) === side ? 'ui-btn--primary' : 'ui-btn--secondary'}`}
                  aria-pressed={(choices[change.id] ?? change.automatic) === side} onClick={() => setChoices((current) => ({ ...current, [change.id]: side }))}>{t(side === 'local' ? '保留我的' : '采用对方的')}</button>
              </div>)}</div><details className="mt-2 text-xs text-canvas-text-secondary"><summary>{t('查看共同版本')}</summary><Value value={change.base} /></details>
            </article>)}{!filtered.length && <p className="p-3 text-xs text-canvas-text-muted">{t('当前筛选没有改动')}</p>}</div>
            {filtered.length > 30 && <nav className="flex items-center justify-end gap-2" aria-label={t('改动分页')}><button className="ui-btn ui-btn--sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('上一页')}</button>
              <span className="text-xs">{page + 1} / {Math.ceil(filtered.length / 30)}</span><button className="ui-btn ui-btn--sm" disabled={(page + 1) * 30 >= filtered.length} onClick={() => setPage(page + 1)}>{t('下一页')}</button></nav>}
          </>}
        </>}
        <fieldset disabled={busy} className="flex flex-wrap gap-3 text-xs"><legend className="mb-2 text-canvas-text-secondary">{t('可选追加')}</legend>
          <label className="flex items-center gap-2"><input type="checkbox" checked={appendChat} onChange={(event) => setAppendChat(event.target.checked)} />{t('聊天记录')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={appendMemories} onChange={(event) => setAppendMemories(event.target.checked)} />{t('项目记忆')}</label>
        </fieldset>
        {mode === 'update' && <p className="text-xs text-canvas-text-secondary">{t(preview?.nativeUpdate ? '应用前保存恢复点；新项目更新暂不支持追加聊天或项目记忆。' : '应用后保留原项目及其目录，保存更新前恢复点。素材发布到新目录，原文件不覆盖。')}</p>}
      </>}
      {(error || dependencyError) && <p role="alert" className="ui-alert ui-alert--danger whitespace-pre-wrap text-xs">{error || `${dependencyError}。${t('请取消“只看冲突”，调整关联节点、分组、连线或素材的选择。')}`}</p>}
    </div>
    <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-canvas-border p-3">
      {busy && <span role="status" className="mr-auto text-xs text-canvas-text-secondary">{t('正在处理，请稍候…')}{progress === null ? '' : ` ${progress}%`}</span>}
      {busy && canCancel && <button type="button" className="ui-btn ui-btn--secondary" onClick={() => {
        const current = transfer.current; current?.controller.abort(); setCanCancel(false);
        if (current?.id) void invoke('cancel_file_transfer', { taskId: current.id }).catch(() => undefined);
      }}>{t('取消导入')}</button>}
      <button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={() => void close()}>{t('取消')}</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !session || mode === 'new' && !session.nativeSource || mode === 'update' && (!preview || unresolved > 0 || !!dependencyError || preview.plan.alreadyApplied)} onClick={() => void runApply()}>{t(mode === 'update' ? '应用更新' : '导入为新项目')}</button>
    </footer>
  </ModalOverlay>;
}
