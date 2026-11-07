/**
 * SeriesSourceBrowser — 提供剧集原文与章节浏览界面与交互。
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { seriesOwnerId } from '../store/store.utils';
import type { SeriesSourcePart, SeriesSourceReference, SeriesSourceSnapshot } from '../types/seriesSource';
import { buildSeriesChapterPrompt, findSeriesChapters, readSeriesChapter, readSeriesSource } from '../services/seriesSourceService';
import { useT } from '../i18n';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';

/** 独立工作台只通过主窗口按需读取材料、准备助手草稿；正文不进入窗口长期快照。 */
export interface SeriesSourceBrowserRemote {
  contextKey: string;
  ready: boolean;
  readSource: (part: SeriesSourcePart, signal: AbortSignal) => Promise<SeriesSourceSnapshot>;
  prepareChapter: (reference: SeriesSourceReference) => Promise<void>;
}

export default function SeriesSourceBrowser({ initialPart = 'original', fixedPart, embedded = false, onClose, beforeAssistant, remote }: {
  initialPart?: SeriesSourcePart;
  fixedPart?: SeriesSourcePart;
  embedded?: boolean;
  onClose?: () => void;
  beforeAssistant?: () => Promise<boolean>;
  remote?: SeriesSourceBrowserRemote;
}) {
  const t = useT();
  const projectId = useAppStore((state) => remote ? null : state.currentProjectId);
  const localReady = useAppStore((state) => !remote && state.projectLoadStatus === 'ready');
  const ready = remote?.ready ?? localReady;
  const series = useAppStore((state) => remote ? undefined : state.projects.find((item) => item.id === seriesOwnerId(state.projects, state.currentProjectId ?? '')));
  const [selectedPart, setPart] = useState<SeriesSourcePart>(initialPart);
  const part = fixedPart ?? selectedPart;
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; source?: SeriesSourceSnapshot; error?: string }>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0);
  const [shown, setShown] = useState(50);
  const [preparing, setPreparing] = useState(false);
  const [actionError, setActionError] = useState('');
  const key = JSON.stringify([remote?.contextKey ?? projectId, ready, part, part === 'original' ? series?.series?.originalWork : series?.series?.script, reload]);
  const source = loaded?.key === key ? loaded.source : undefined;
  const error = loaded?.key === key ? loaded.error : undefined;
  const chapters = useMemo(() => source ? findSeriesChapters(source, query) : [], [source, query]);
  const chapter = chapters.find((item) => item.id === selected) ?? chapters[0];
  const safeOffset = chapter ? Math.min(offset, Math.max(0, chapter.end - chapter.start - 1)) : 0;
  const page = source && chapter ? readSeriesChapter(source, { seriesId: source.seriesId, part: source.part, version: source.version, chapterId: chapter.id }, safeOffset, 2000) : undefined;

  useEffect(() => {
    if ((!remote && !projectId) || !ready) return;
    const controller = new AbortController();
    const read = remote ? remote.readSource(part, controller.signal) : readSeriesSource(projectId!, part, controller.signal);
    void read.then(
      (value) => { if (!controller.signal.aborted) setLoaded({ key, source: value }); },
      (reason: unknown) => { if (!controller.signal.aborted) setLoaded({ key, error: reason instanceof Error ? reason.message : t('读取材料失败') }); },
    );
    return () => controller.abort();
  }, [projectId, ready, part, key, remote, t]);

  const prepare = async () => {
    if (!source || !chapter || preparing) return;
    setPreparing(true);
    setActionError('');
    try {
      if (beforeAssistant && !await beforeAssistant()) return;
      if (remote) {
        await remote.prepareChapter({ seriesId: source.seriesId, part: source.part, version: source.version, chapterId: chapter.id });
        onClose?.();
        return;
      }
      const draft = buildSeriesChapterPrompt(source, chapter.id);
      const state = useAppStore.getState();
      if (state.currentProjectId !== source.projectId || state.projectLoadStatus !== 'ready') throw new Error(t('项目已切换，请重新选择章节'));
      state.openChatWithDraft(draft);
      onClose?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('读取材料失败');
      if (remote) setActionError(message);
      else useAppStore.getState().showToast(message, 'error');
    } finally { setPreparing(false); }
  };

  const content = (
    <div className={embedded
      ? 'flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-canvas-text'
      : 'ui-card flex h-[min(80vh,720px)] w-[min(960px,calc(100vw-32px))] flex-col overflow-hidden text-canvas-text'}>
      {!embedded && <header className="ui-card__header flex shrink-0 items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('章节浏览')}</h2>
        <PopupCloseButton onClick={() => onClose?.()} ariaLabel={t('关闭章节浏览')} />
      </header>}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border p-3">
        {fixedPart ? <span className="ui-label">{t(fixedPart === 'original' ? '原著' : '全剧剧本')}</span>
          : <Select value={part} onChange={(value) => { setPart(value); setSelected(''); setOffset(0); }}
            aria-label={t('素材来源')} options={[{ value: 'original', label: t('原著') }, { value: 'script', label: t('全剧剧本') }]} />}
        <input className="ui-input min-w-40 flex-1" value={query} maxLength={120}
          aria-label={t('搜索章节或正文')} placeholder={t('搜索章节或正文')}
          onChange={(event) => { setQuery(event.target.value); setOffset(0); setShown(50); }} />
        <button type="button" className="ui-btn ui-btn--sm" onClick={() => { setReload((value) => value + 1); setOffset(0); }}>{t('重新读取')}</button>
      </div>
      {actionError && <p role="alert" className="px-3 py-2 text-xs text-danger-light">{actionError}</p>}
      {error ? <p role="alert" className="p-4 text-sm text-canvas-text-secondary">{error}</p> : !source ?
        <p role="status" className="p-4 text-sm text-canvas-text-muted">{t('正在读取章节…')}</p> :
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)] sm:grid-cols-[220px_minmax(0,1fr)] sm:grid-rows-1">
          <nav aria-label={t('章节目录')} className="min-h-0 overflow-y-auto border-b border-canvas-border p-2 sm:border-b-0 sm:border-r">
            <p className="p-2 text-xs text-canvas-text-muted">{t('找到 {count} 个章节', { count: chapters.length })}</p>
            {chapters.slice(0, shown).map((item) => <button key={item.id} type="button"
              className={`ui-btn mb-1 w-full justify-start text-left ${chapter?.id === item.id ? 'ui-btn--primary' : 'ui-btn--ghost'}`}
              aria-current={chapter?.id === item.id ? 'true' : undefined}
              onClick={() => {
                setSelected(item.id);
                const match = source.text.slice(item.start, item.end).toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
                setOffset(query.trim() && match >= 0 ? Math.max(0, match - 100) : 0);
              }}><span className="truncate">{item.ordinal}. {item.title === '全文' || item.title === '开篇' ? t(item.title) : item.title}</span></button>)}
            {shown < chapters.length && <button type="button" className="ui-btn w-full" onClick={() => setShown((value) => value + 50)}>{t('更多章节')}</button>}
          </nav>
          <section className="flex min-h-0 min-w-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words p-4 text-sm leading-7">{page?.text || t('没有匹配的章节')}</div>
            <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-canvas-border p-3">
              <span className="mr-auto text-xs text-canvas-text-muted">{page ? `${page.offset + 1}–${page.offset + page.text.length} / ${page.totalCharacters}` : ''}</span>
              <button type="button" className="ui-btn ui-btn--sm" disabled={!page || page.offset === 0} onClick={() => setOffset(Math.max(0, safeOffset - 2000))}>{t('上一段')}</button>
              <button type="button" className="ui-btn ui-btn--sm" disabled={page?.nextOffset == null} onClick={() => setOffset(page?.nextOffset ?? 0)}>{t('下一段')}</button>
              <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!chapter || preparing} onClick={() => { void prepare(); }}>{t('让助手分析本章')}</button>
            </footer>
          </section>
        </div>}
    </div>
  );
  return embedded ? content : <ModalOverlay isOpen onClose={() => onClose?.()} ariaLabel={t('章节浏览')}>{content}</ModalOverlay>;
}
