import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { seriesOwnerId } from '../store/store.utils';
import type { SeriesSourcePart, SeriesSourceSnapshot } from '../types/seriesSource';
import { buildSeriesChapterPrompt, findSeriesChapters, readSeriesChapter, readSeriesSource } from '../services/seriesSourceService';
import { useT } from '../i18n';
import ModalOverlay from './shared/ModalOverlay';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';

export default function SeriesSourceBrowser({ initialPart = 'original', onClose, beforeAssistant }: {
  initialPart?: SeriesSourcePart;
  onClose: () => void;
  beforeAssistant?: () => Promise<boolean>;
}) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const ready = useAppStore((state) => state.projectLoadStatus === 'ready');
  const series = useAppStore((state) => state.projects.find((item) => item.id === seriesOwnerId(state.projects, state.currentProjectId ?? '')));
  const [part, setPart] = useState<SeriesSourcePart>(initialPart);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; source?: SeriesSourceSnapshot; error?: string }>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0);
  const [shown, setShown] = useState(50);
  const [preparing, setPreparing] = useState(false);
  const key = JSON.stringify([projectId, ready, part, part === 'original' ? series?.series?.originalWork : series?.series?.script, reload]);
  const source = loaded?.key === key ? loaded.source : undefined;
  const error = loaded?.key === key ? loaded.error : undefined;
  const chapters = useMemo(() => source ? findSeriesChapters(source, query) : [], [source, query]);
  const chapter = chapters.find((item) => item.id === selected) ?? chapters[0];
  const safeOffset = chapter ? Math.min(offset, Math.max(0, chapter.end - chapter.start - 1)) : 0;
  const page = source && chapter ? readSeriesChapter(source, { seriesId: source.seriesId, part: source.part, version: source.version, chapterId: chapter.id }, safeOffset, 2000) : undefined;

  useEffect(() => {
    if (!projectId || !ready) return;
    const controller = new AbortController();
    void readSeriesSource(projectId, part, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setLoaded({ key, source: value }); },
      (reason: unknown) => { if (!controller.signal.aborted) setLoaded({ key, error: reason instanceof Error ? reason.message : t('读取材料失败') }); },
    );
    return () => controller.abort();
  }, [projectId, ready, part, key, t]);

  const prepare = async () => {
    if (!source || !chapter || preparing) return;
    setPreparing(true);
    try {
      const draft = buildSeriesChapterPrompt(source, chapter.id);
      if (beforeAssistant && !await beforeAssistant()) return;
      const state = useAppStore.getState();
      if (state.currentProjectId !== source.projectId || state.projectLoadStatus !== 'ready') throw new Error(t('项目已切换，请重新选择章节'));
      state.openChatWithDraft(draft);
      onClose();
    } catch (reason) {
      useAppStore.getState().showToast(reason instanceof Error ? reason.message : t('读取材料失败'), 'error');
    } finally { setPreparing(false); }
  };

  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('章节浏览')}>
    <div className="ui-card flex h-[min(80vh,720px)] w-[min(960px,calc(100vw-32px))] flex-col overflow-hidden text-canvas-text">
      <header className="ui-card__header flex shrink-0 items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('章节浏览')}</h2>
        <PopupCloseButton onClick={onClose} ariaLabel={t('关闭章节浏览')} />
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border p-3">
        <Select value={part} onChange={(value) => { setPart(value); setSelected(''); setOffset(0); }}
          aria-label={t('素材来源')} options={[{ value: 'original', label: t('原著') }, { value: 'script', label: t('全剧剧本') }]} />
        <input className="ui-input min-w-40 flex-1" value={query} maxLength={120}
          aria-label={t('搜索章节或正文')} placeholder={t('搜索章节或正文')}
          onChange={(event) => { setQuery(event.target.value); setOffset(0); setShown(50); }} />
        <button type="button" className="ui-btn ui-btn--sm" onClick={() => { setReload((value) => value + 1); setOffset(0); }}>{t('重新读取')}</button>
      </div>
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
  </ModalOverlay>;
}
