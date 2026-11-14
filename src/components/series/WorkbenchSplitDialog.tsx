import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import { estimateSeriesSplitDuration, estimateSeriesSplitEpisodeCount, SPLIT_DRAFT_LIMITS } from '../../services/seriesCreativeService';
import type { SeriesSplitMaterialIndex } from '../../services/seriesSourceService';
import type { SeriesSourcePart } from '../../types/seriesSource';
import type { ScriptWorkbenchDispatch, ScriptWorkbenchSnapshot } from '../../types/scriptWorkbench';
import ModalOverlay from '../shared/ModalOverlay';
import NumberStepper from '../shared/NumberStepper';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';

export default function WorkbenchSplitDialog({ snapshot, dispatch, onClose }: {
  snapshot: ScriptWorkbenchSnapshot;
  dispatch: ScriptWorkbenchDispatch;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const limits = SPLIT_DRAFT_LIMITS;
  const { series, contextReady, splitSkills } = snapshot;
  const [part, setPart] = useState(snapshot.splitSource);
  const [range, setRange] = useState<'all' | 'chapters'>('all');
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(50);
  const [reload, setReload] = useState(0);
  const [sizing, setSizing] = useState<'auto' | 'fixed'>('auto');
  const [duration, setDuration] = useState(limits.defaultEpisodeDurationSec);
  const [count, setCount] = useState(limits.defaultEpisodeCount);
  const [pace, setPace] = useState(limits.defaultCharactersPerMinute);
  const [total, setTotal] = useState('');
  const [skillId, setSkillId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; index?: SeriesSplitMaterialIndex; error?: string }>();
  const sourceAvailable = part === 'script' ? !!series?.hasScript : !!series?.hasOriginal;
  const sourceStamp = part === 'script' ? series?.updatedAt : series?.originalAddedAt;
  const materialKey = JSON.stringify([series?.id, series?.exchangeEpoch, sourceStamp, snapshot.canvasProjectId, part, reload]);
  const material = loaded?.key === materialKey ? loaded.index : undefined;
  const materialError = loaded?.key === materialKey ? loaded.error : undefined;
  const selectionKey = material ? JSON.stringify([material.seriesId, material.part, material.version]) : '';
  const selectedIds = selection?.key === selectionKey ? selection.ids : undefined;
  const chapters = useMemo(() => material?.chapters.filter((chapter) => chapter.characterCount > 0) ?? [], [material]);
  const selectedChapters = useMemo(() => selectedIds ? chapters.filter((chapter) => selectedIds.has(chapter.id)) : [], [chapters, selectedIds]);
  const visibleChapters = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? chapters.filter((chapter) => `${chapter.ordinal} ${chapter.title}`.toLocaleLowerCase().includes(term)) : chapters;
  }, [chapters, query]);
  const characterCount = range === 'all' ? material?.characterCount ?? 0
    : selectedChapters.reduce((sum, chapter) => sum + chapter.characterCount, 0);
  const totalOverride = total.trim() ? Number(total) : undefined;
  const invalidTotal = totalOverride !== undefined && (!/^\d+$/.test(total.trim()) || !Number.isSafeInteger(totalOverride) || totalOverride < 1);
  const estimatedDuration = invalidTotal ? 0 : totalOverride ?? estimateSeriesSplitDuration(characterCount, pace);
  const estimatedCount = estimateSeriesSplitEpisodeCount(estimatedDuration, duration);
  const selectedSkill = splitSkills?.find((skill) => skill.id === skillId);
  const dirty = snapshot.isDirty || snapshot.originalWriting?.dirty;
  const controlsDisabled = busy || !contextReady;
  const canSubmit = contextReady && sourceAvailable && material && characterCount > 0
    && (!skillId || selectedSkill) && !dirty && !snapshot.editorWriteLocked && !snapshot.isSaving
    && !snapshot.originalWriting?.loading && !snapshot.originalWriting?.saving && !snapshot.originalWriting?.generating
    && (sizing === 'fixed' || (!invalidTotal && estimatedCount >= limits.minEpisodeCount && estimatedCount <= limits.maxEpisodeCount));

  useEffect(() => {
    if (!contextReady || !sourceAvailable) return;
    let active = true;
    void dispatch({ type: 'read_split_material', part }).then(
      (result) => { if (active) setLoaded({ key: materialKey, index: result as SeriesSplitMaterialIndex }); },
      (error: unknown) => {
        if (active) setLoaded({ key: materialKey, error: error instanceof Error ? error.message : t('读取材料失败') });
      },
    );
    return () => { active = false; };
  }, [contextReady, dispatch, materialKey, part, sourceAvailable, t]);

  const close = () => { if (!busyRef.current) onClose(); };
  const refresh = () => {
    setSelection(undefined);
    setActionError('');
    setShown(50);
    setReload((value) => value + 1);
  };
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError('');
    try { await action(); }
    catch (error) { setActionError(error instanceof Error ? error.message : t('工作台操作未完成')); }
    finally { busyRef.current = false; setBusy(false); }
  };

  return <ModalOverlay isOpen onClose={close} ariaLabel={t('AI 拆分草案')} zIndex={340}
    className="ui-dialog-surface max-h-[calc(100vh-24px)] w-[min(640px,calc(100vw-24px))]">
    <header className="ui-card__header shrink-0">
      <Icon icon="lucide:wand-sparkles" className="h-4 w-4 shrink-0 text-brand" />
      <h2 className="ui-card__title min-w-0 flex-1">{t('AI 拆分草案')}</h2>
      <PopupCloseButton onClick={close} disabled={busy} ariaLabel={t('关闭')} />
    </header>
    <div className="ui-card__body ui-scroll min-h-0 space-y-4 overflow-y-auto">
      <fieldset disabled={controlsDisabled} className="min-w-0 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${id}-source`}>{t('拆分素材')}</label>
            <Select<SeriesSourcePart> id={`${id}-source`} value={part} disabled={controlsDisabled} onChange={(value) => {
              setPart(value);
              setQuery('');
              refresh();
            }} options={[{ value: 'original', label: t('原著') }, { value: 'script', label: t('全剧剧本') }]} />
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${id}-range`}>{t('拆分范围')}</label>
            <Select<'all' | 'chapters'> id={`${id}-range`} value={range} disabled={controlsDisabled} onChange={setRange}
              options={[{ value: 'all', label: t('全部内容') }, { value: 'chapters', label: t('指定章节') }]} />
          </div>
        </div>
        {!sourceAvailable && <p className="ui-hint" role="status">{t('请先添加所选素材，再生成拆分草案。')}</p>}
        {contextReady && sourceAvailable && !material && !materialError && <p className="ui-hint" role="status">{t('正在读取章节…')}</p>}
        {materialError && <p className="ui-error" role="alert">{materialError}</p>}
        {material && !material.characterCount && <p className="ui-hint" role="status">{t('未找到可拆分的正文')}</p>}
        {sourceAvailable && (material || materialError) && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {range === 'chapters' && material && <>
                <input className="ui-input min-w-32 flex-1" value={query} maxLength={120}
                  aria-label={t('章节目录')} placeholder={t('章节目录')}
                  onChange={(event) => { setQuery(event.target.value); setShown(50); }} />
                <output className="ui-hint">{t('已选 {count} 章', { count: selectedChapters.length })}</output>
              </>}
              <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={refresh}>{t('重新读取')}</button>
            </div>
            {range === 'chapters' && material && <div aria-label={t('章节目录')} role="group"
              className="ui-scroll max-h-44 space-y-1 overflow-y-auto rounded-lg border border-canvas-border p-2">
              {visibleChapters.slice(0, shown).map((chapter) => (
                <label key={chapter.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-canvas-hover">
                  <input type="checkbox" className="ui-checkbox shrink-0" checked={selectedIds?.has(chapter.id) ?? false}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelection((previous) => {
                        const next = new Set(previous?.key === selectionKey ? previous.ids : undefined);
                        if (checked) next.add(chapter.id);
                        else next.delete(chapter.id);
                        return { key: selectionKey, ids: next };
                      });
                    }} />
                  <span className="min-w-0 break-words text-xs">{chapter.ordinal}. {chapter.title === '全文' || chapter.title === '开篇' ? t(chapter.title) : chapter.title}</span>
                </label>
              ))}
              {!visibleChapters.length && <p className="ui-hint p-2">{t('没有匹配的章节')}</p>}
              {visibleChapters.length > shown && <button type="button" className="ui-btn ui-btn--sm w-full"
                onClick={() => setShown((value) => value + 50)}>{t('更多章节')}</button>}
            </div>}
          </div>
        )}
      </fieldset>

      <fieldset disabled={controlsDisabled} className="min-w-0 space-y-3 border-t border-canvas-border pt-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${id}-sizing`}>{t('集数设置')}</label>
            <Select<'auto' | 'fixed'> id={`${id}-sizing`} value={sizing} disabled={controlsDisabled} onChange={setSizing}
              options={[{ value: 'auto', label: t('按时长推算') }, { value: 'fixed', label: t('手动指定集数') }]} />
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${id}-duration`}>{t('单集秒数')}</label>
            <NumberStepper id={`${id}-duration`} value={duration} onChange={setDuration} disabled={controlsDisabled}
              min={limits.minEpisodeDurationSec} max={limits.maxEpisodeDurationSec} />
          </div>
          {sizing === 'fixed' ? <div className="ui-field">
            <label className="ui-label" htmlFor={`${id}-count`}>{t('目标总集数')}</label>
            <NumberStepper id={`${id}-count`} value={count} onChange={setCount} disabled={controlsDisabled}
              min={limits.minEpisodeCount} max={limits.maxEpisodeCount} />
          </div> : <>
            <label className="ui-field">
              <span className="ui-label">{t('预计总时长（秒，可选）')}</span>
              <input className={`ui-input${invalidTotal ? ' is-invalid' : ''}`} inputMode="numeric" maxLength={12} value={total}
                aria-invalid={invalidTotal} onChange={(event) => setTotal(event.target.value)} />
              <span className="ui-hint">{t('留空则按所选内容的字数估算')}</span>
            </label>
            {totalOverride === undefined && <div className="ui-field">
              <label className="ui-label" htmlFor={`${id}-pace`}>{t('改编速度（字／分钟）')}</label>
              <NumberStepper id={`${id}-pace`} value={pace} onChange={setPace} disabled={controlsDisabled}
                min={limits.minCharactersPerMinute} max={limits.maxCharactersPerMinute} />
            </div>}
          </>}
        </div>
        {sizing === 'auto' && invalidTotal && <p className="ui-error" role="alert">{t('请填写有效的预计总时长')}</p>}
        {sizing === 'auto' && !invalidTotal && characterCount > 0 && <>
          <output className="block rounded-lg bg-canvas-card p-2 text-sm font-medium tabular-nums text-canvas-text">
            {t('预计 {seconds} 秒 · {count} 集', { seconds: estimatedDuration, count: estimatedCount })}
          </output>
          {estimatedCount > limits.maxEpisodeCount && <p className="ui-error" role="alert">
            {t('推算超过 {max} 集，请缩小章节范围、增加单集时长或手动指定集数。', { max: limits.maxEpisodeCount })}
          </p>}
        </>}
      </fieldset>

      <fieldset disabled={controlsDisabled} className="min-w-0 space-y-3 border-t border-canvas-border pt-3">
        <div className="ui-field">
          <label className="ui-label" htmlFor={`${id}-skill`}>{t('拆分 Skill')}</label>
          <div className="flex flex-wrap gap-2">
            <Select id={`${id}-skill`} className="min-w-40 flex-1" value={skillId} disabled={controlsDisabled} onChange={setSkillId}
              options={[{ value: '', label: t('不使用 Skill') },
                ...(splitSkills ?? []).map((skill) => ({ value: skill.id, label: skill.name }))]} />
            <button type="button" className="ui-btn ui-btn--secondary" onClick={() => void run(async () => {
              const imported = await dispatch({ type: 'split_skill_import' });
              if (typeof imported === 'string') setSkillId(imported);
            })}>{t('导入 Skill')}</button>
          </div>
          {selectedSkill?.description && <p className="ui-hint break-words">{selectedSkill.description}</p>}
          {skillId && !selectedSkill && <p className="ui-error" role="alert">
            {t('所选 Skill 无法用于拆分，请选择可读取剧集素材的 Skill')}
          </p>}
        </div>
        <label className="ui-field">
          <span className="ui-label">{t('本次拆分要求（可选）')}</span>
          <textarea className="ui-textarea" rows={2} maxLength={limits.maxNotesCharacters} value={notes}
            placeholder={t('拆分要求，例如优先保留主线、强化结尾钩子')} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </fieldset>
    </div>
    <footer className="ui-card__footer shrink-0 flex-wrap">
      <div className="min-w-0 grow space-y-1">
        {!contextReady && <p className="ui-hint" role="status">{t('画布已离开本剧集，请先回到原剧集处理工作台修改')}</p>}
        {dirty && <p className="ui-hint" role="status">{t('请先保存工作台中的修改，再准备拆分草案。')}</p>}
        {range === 'chapters' && chapters.length > 0 && !selectedChapters.length && <p className="ui-hint">{t('请选择至少一章')}</p>}
        {actionError && <p className="ui-error break-words" role="alert">{actionError}</p>}
      </div>
      <div className="ui-card__footer-actions">
        <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={close}>{t('取消')}</button>
        <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !canSubmit}
          onClick={() => void run(async () => {
            if (!canSubmit || !material) return;
            await dispatch({ type: 'split_draft', settings: {
              part, version: material.version, chapterIds: range === 'chapters' ? selectedChapters.map((chapter) => chapter.id) : undefined,
              episodeDurationSec: duration,
              sizing: sizing === 'fixed' ? { kind: 'fixed', count } : { kind: 'auto', charactersPerMinute: pace, totalDurationSec: totalOverride },
              skillId: skillId || undefined, notes,
            } });
          })}>
          <Icon icon="lucide:message-square-text" className="h-3.5 w-3.5" />
          {t('前往对话')}
        </button>
      </div>
    </footer>
  </ModalOverlay>;
}
