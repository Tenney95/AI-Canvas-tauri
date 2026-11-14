/** 原文写作视图：文件、模型和草稿权威均由工作台宿主管理。 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { useT } from '../i18n';
import { indexSeriesChapters } from '../services/seriesSourceService';
import type { OriginalWritingAction, OriginalWritingDocument, OriginalWritingSummary } from '../types/originalWriting';
import NumberStepper from './shared/NumberStepper';
import Select from './shared/Select';

interface OriginalWritingEditorProps {
  summary: OriginalWritingSummary;
  dispatch: (action: OriginalWritingAction) => Promise<unknown>;
  ready: boolean;
  active: boolean;
  toolsContainer?: HTMLElement | null;
}

function writingDocument(value: unknown): OriginalWritingDocument {
  const document = value as Partial<OriginalWritingDocument> | null;
  if (!document || typeof document.documentId !== 'string' || typeof document.content !== 'string'
    || typeof document.revision !== 'number' || typeof document.acceptedSequence !== 'number') {
    throw new Error('原文响应无效，请重新载入');
  }
  return document as OriginalWritingDocument;
}

export default function OriginalWritingEditor({ summary, dispatch, ready, active, toolsContainer }: OriginalWritingEditorProps) {
  const t = useT();
  const instructionId = useId();
  const targetId = useId();
  const statusId = useId();
  const [document, setDocument] = useState<OriginalWritingDocument | null>(null);
  const [range, setRange] = useState<{ start: number; end: number; title: string } | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [instruction, setInstruction] = useState('');
  const [targetCount, setTargetCount] = useState(0);
  const [focused, setFocused] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [editPending, setEditPending] = useState(false);
  const [openAttempt, setOpenAttempt] = useState(0);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const currentDocument = useRef(document);
  const currentRange = useRef(range);
  const sequence = useRef(0);
  const lifetime = useRef(0);
  const busyOperation = useRef<string | null>(null);
  const request = useRef(0);
  const latestEdit = useRef<Promise<unknown> | null>(null);

  useEffect(() => { lifetime.current += 1; return () => { lifetime.current += 1; }; }, []);
  useEffect(() => {
    if (!ready || !active || currentDocument.current) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void dispatch({ type: 'original_open' }).then((result) => {
      if (cancelled) return;
      const next = writingDocument(result);
      sequence.current = next.acceptedSequence;
      latestEdit.current = null;
      currentDocument.current = next;
      setDocument(next);
      currentRange.current = null;
      setRange(null);
      setSelection({ start: next.content.length, end: next.content.length });
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : t('无法打开原文'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ready, active, dispatch, openAttempt, t]);
  useEffect(() => {
    if (!loading && currentDocument.current) {
      const end = currentRange.current ? currentRange.current.end - currentRange.current.start : currentDocument.current.content.length;
      sourceInput.current?.setSelectionRange(end, end);
    }
  }, [document?.documentId, loading]);

  const chapters = useMemo(() => indexSeriesChapters(document?.content ?? ''), [document?.content]);
  const content = document?.content ?? '';
  const visibleContent = range ? content.slice(range.start, range.end) : content;
  const chapterTitle = range ? chapters.find((chapter) => chapter.start === range.start)?.title ?? range.title : undefined;
  const count = visibleContent.replace(/\s/g, '').length;
  const wholeCount = content.replace(/\s/g, '').length;
  const unavailable = !ready || loading || summary.loading || !document;
  const working = !!busy || summary.saving || summary.generating;
  const candidate = document?.candidate;
  const candidateStale = !!candidate && (candidate.revision !== document?.revision || editPending);
  const isNew = summary.documentId === document?.documentId
    ? summary.isNew ?? document?.isNew ?? false : document?.isNew ?? false;
  const fileName = summary.documentId === document?.documentId
    ? summary.fileName ?? document?.fileName : document?.fileName;
  const dirty = summary.dirty || editPending;
  const message = error || summary.error;

  const adoptDocument = (next: OriginalWritingDocument, replaceIdentity = false) => {
    const current = currentDocument.current;
    if (current && !replaceIdentity && (next.documentId !== current.documentId || next.acceptedSequence < sequence.current || next.revision < current.revision)) return;
    sequence.current = replaceIdentity ? next.acceptedSequence : Math.max(sequence.current, next.acceptedSequence);
    if (replaceIdentity) { latestEdit.current = null; setEditPending(false); }
    if (current?.content !== next.content) {
      currentRange.current = null;
      setRange(null);
      setSelection({ start: next.content.length, end: next.content.length });
      requestAnimationFrame(() => sourceInput.current?.setSelectionRange(next.content.length, next.content.length));
    }
    currentDocument.current = next;
    setDocument(next);
  };

  const run = async (action: OriginalWritingAction, operation: string) => {
    if (unavailable && action.type !== 'original_cancel' && action.type !== 'original_discard_candidate') return;
    const capturedLifetime = lifetime.current;
    const capturedDocumentId = currentDocument.current?.documentId;
    const startSequence = sequence.current;
    const requestId = ++request.current;
    busyOperation.current = operation;
    setBusy(operation);
    setError('');
    try {
      if (action.type !== 'original_reload' && action.type !== 'original_cancel') {
        try { await latestEdit.current; }
        catch {
          const current = currentDocument.current;
          if (!current || lifetime.current !== capturedLifetime || current.documentId !== capturedDocumentId) return;
          const retrySequence = ++sequence.current;
          const retry = dispatch({ type: 'original_edit', handoff: { documentId: current.documentId, sequence: retrySequence, content: current.content } });
          latestEdit.current = retry;
          adoptDocument(writingDocument(await retry));
          setEditPending(false);
        }
      }
      if (lifetime.current !== capturedLifetime || currentDocument.current?.documentId !== capturedDocumentId) return;
      if (action.type === 'original_generate' && sequence.current !== startSequence) throw new Error(t('原文已变化，请重新选择写作范围'));
      const capturedSequence = sequence.current;
      const result = await dispatch(action.type === 'original_generate' ? { ...action, expectedSequence: capturedSequence } : action);
      if (lifetime.current !== capturedLifetime || currentDocument.current?.documentId !== capturedDocumentId) return;
      if (action.type !== 'original_cancel') {
        const next = writingDocument(result);
        if (action.type === 'original_reload') adoptDocument(next, true);
        else if (sequence.current === capturedSequence) adoptDocument(next);
        else if (action.type === 'original_generate' || action.type === 'original_discard_candidate') {
          const current = currentDocument.current;
          if (current) { const merged = { ...current, candidate: next.candidate }; currentDocument.current = merged; setDocument(merged); }
        }
      }
      setReloadConfirm(false);
    } catch (reason) {
      if (lifetime.current === capturedLifetime) setError(reason instanceof Error ? reason.message : t('操作未完成，草稿已保留'));
    } finally {
      if (lifetime.current === capturedLifetime && request.current === requestId) { busyOperation.current = null; setBusy(null); }
    }
  };

  const changeContent = (next: string) => {
    const current = currentDocument.current;
    if (!current || unavailable || ['save', 'reload', 'apply'].includes(busyOperation.current ?? '')) return;
    const selected = currentRange.current;
    const start = selected?.start ?? 0;
    const end = selected?.end ?? current.content.length;
    const nextContent = current.content.slice(0, start) + next + current.content.slice(end);
    if (nextContent === current.content) return;
    const nextSequence = ++sequence.current;
    const nextDocument = { ...current, content: nextContent };
    currentDocument.current = nextDocument;
    setDocument(nextDocument);
    if (selected) {
      const nextRange = { ...selected, end: start + next.length };
      currentRange.current = nextRange;
      setRange(nextRange);
    }
    setSelection({ start: start + (sourceInput.current?.selectionStart ?? next.length), end: start + (sourceInput.current?.selectionEnd ?? next.length) });
    setReloadConfirm(false);
    setEditPending(true);
    const capturedLifetime = lifetime.current;
    const pending = dispatch({ type: 'original_edit', handoff: { documentId: current.documentId, sequence: nextSequence, content: nextContent } });
    latestEdit.current = pending;
    void pending.then((result) => {
      if (lifetime.current !== capturedLifetime || sequence.current !== nextSequence || currentDocument.current?.documentId !== current.documentId) return;
      adoptDocument(writingDocument(result));
      setEditPending(false);
    }).catch((reason: unknown) => {
      if (lifetime.current !== capturedLifetime || sequence.current !== nextSequence) return;
      setError(reason instanceof Error ? reason.message : t('草稿同步失败，请保留当前页面并重试保存'));
    });
  };

  const chooseChapter = (index: number) => {
    const chapter = chapters[index];
    const nextRange = chapter ? { start: chapter.start, end: chapter.end, title: chapter.title } : null;
    currentRange.current = nextRange;
    setRange(nextRange);
    const cursor = nextRange?.end ?? content.length;
    setSelection({ start: cursor, end: cursor });
    requestAnimationFrame(() => sourceInput.current?.setSelectionRange(nextRange ? nextRange.end - nextRange.start : content.length, nextRange ? nextRange.end - nextRange.start : content.length));
    setReloadConfirm(false);
  };
  const generate = (mode: 'continue' | 'polish') => {
    const start = Math.max(0, Math.min(content.length, selection.start));
    const end = Math.max(start, Math.min(content.length, selection.end));
    const scope = mode === 'polish' && start === end ? { start: range?.start ?? 0, end: range?.end ?? content.length } : { start: mode === 'continue' ? end : start, end };
    void run({ type: 'original_generate', mode, ...scope, instruction: instruction.trim(), expectedSequence: sequence.current }, 'generate');
  };
  const writingTools = focused ? <p className="p-2 text-xs leading-relaxed text-canvas-text-secondary" role="status">{t('专注写作已开启。点击编辑区顶部的「退出专注」返回写作工具。')}</p> : <>
    <div className="ui-card m-2 shrink-0">
      <div className="ui-card__header"><Icon icon="lucide:pen-line" className="shrink-0" /><h3 className="ui-card__title">{content.trim() ? t('写作助手') : t('从零起稿')}</h3></div>
      <div className="ui-card__body flex flex-col gap-2">
        <div className="ui-field">
          <label htmlFor={targetId} className="ui-label">{t('目标字数')}</label>
          <div className="flex items-center gap-2">
            <NumberStepper id={targetId} value={targetCount} onChange={setTargetCount} min={0} max={1000000}
              step={100} unit={t('字')} size="sm" className="ui-stepper--block min-w-0 flex-1" />
            {targetCount > 0 && <span className="ui-hint shrink-0 tabular-nums">
              {Math.min(100, Math.floor(count / targetCount * 100))}%
            </span>}
          </div>
        </div>
        <label htmlFor={instructionId} className="text-xs font-medium text-canvas-text-secondary">{t('写作要求')}</label>
        <textarea id={instructionId} className="ui-textarea min-w-0 resize-y" rows={3} maxLength={2000}
          placeholder={content.trim() ? t('例如：保持人物语气，补充动作与细节') : t('写下题材、人物和开场情境，例如：雨夜，一位快递员收到来自未来的包裹。')}
          value={instruction} onChange={(event) => setInstruction(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={unavailable || working || !!candidate || (!content.trim() && !instruction.trim())} onClick={() => generate('continue')}><Icon icon="lucide:sparkles" />{content.trim() ? t('从光标续写') : t('按要求起笔')}</button>
          <button type="button" className="ui-btn ui-btn--sm" disabled={unavailable || working || !!candidate || !visibleContent.trim()} onClick={() => generate('polish')}>{selection.end > selection.start ? t('润色选中片段') : range ? t('润色当前章节') : t('润色全文')}</button>
          {(summary.generating || busy === 'generate') && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => void run({ type: 'original_cancel' }, 'cancel')}>{t('停止生成')}</button>}
        </div>
        <p className="break-words text-xs leading-relaxed text-canvas-text-muted">{!content.trim() ? t('可以直接在编辑区写作，也可以填写要求后生成开篇。候选采用后进入草稿，首次保存会创建原文文件。') : selection.end > selection.start ? t('已选中 {count} 字，润色仅替换此片段。', { count: selection.end - selection.start }) : t('续写插入光标处，润色作用于当前章节或全文。生成后先预览，再决定是否采用。')}</p>
      </div>
    </div>
    {candidate && <div className="ui-card m-2 max-h-64 shrink-0" aria-label={t('AI 写作候选')}>
      <div className="ui-card__header shrink-0 flex-wrap">
        <span className="ui-card__title">{candidate.mode === 'continue' ? t('续写候选') : t('润色候选')}</span>
        <span className="ui-card__desc break-words">{candidateStale ? t('正文已修改，请重新生成') : t('采用后进入草稿，保存后写入原文')}</span>
        <div className="ui-card__header-actions flex-wrap">
          <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={working} onClick={() => void run({ type: 'original_discard_candidate' }, 'discard')}>{t('放弃')}</button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={working || candidateStale} onClick={() => void run({ type: 'original_apply', candidateId: candidate.id }, 'apply')}>{t('采用到原文草稿')}</button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-sans text-sm leading-relaxed text-canvas-text">{candidate.text}</pre>
    </div>}
  </>;

  return <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={t('原文写作')}>
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border p-2">
      <Icon icon="lucide:book-open-text" className="shrink-0 text-canvas-text-secondary" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-canvas-text" title={fileName ?? summary.fileName}>{fileName ?? summary.fileName ?? t('原文写作')}</span>
      <span className={`ui-badge ${dirty || isNew ? 'ui-badge--warning' : ''}`}>{!document ? t('未载入') : isNew ? t('未保存的新原文') : dirty ? t('未保存') : t('已保存')}</span>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-pressed={focused} onClick={() => setFocused(!focused)}>
        <Icon icon={focused ? 'lucide:minimize-2' : 'lucide:maximize-2'} />{focused ? t('退出专注') : t('专注写作')}
      </button>
      <button type="button" className="ui-btn ui-btn--sm" disabled={unavailable || working} onClick={() => dirty || candidate ? setReloadConfirm(!reloadConfirm) : void run({ type: 'original_reload' }, 'reload')}>
        <Icon icon="lucide:refresh-cw" />{t('重新载入')}
      </button>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={unavailable || working} onClick={() => void run({ type: 'original_save' }, 'save')}>
        <Icon icon={summary.saving || busy === 'save' ? 'lucide:loader-circle' : 'lucide:save'} />{summary.saving || busy === 'save' ? t('保存中…') : t('保存原文')}
      </button>
    </header>
    {reloadConfirm && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border bg-canvas-card p-2 text-xs text-canvas-text-secondary" role="alert">
      <span className="flex-1">{t('重新载入会丢弃尚未保存的编辑和写作候选。')}</span>
      <button type="button" className="ui-btn ui-btn--sm" onClick={() => setReloadConfirm(false)}>{t('继续编辑')}</button>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" onClick={() => void run({ type: 'original_reload', discard: true }, 'reload')}>{t('丢弃编辑并载入')}</button>
    </div>}
    {message && <div className="flex shrink-0 items-start gap-2 border-b border-canvas-border p-2 text-xs text-canvas-text-secondary" role="alert">
      <Icon icon="lucide:circle-alert" className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{message}</span>
    </div>}
    {toolsContainer && active ? createPortal(writingTools, toolsContainer) : writingTools}
    <div className="flex min-h-0 min-w-0 flex-1">
      {!focused && <nav className="hidden w-44 shrink-0 flex-col overflow-hidden border-r border-canvas-border lg:flex" aria-label={t('原文章节目录')}>
        <div className="flex shrink-0 items-center justify-between p-2 text-xs text-canvas-text-secondary"><span>{t('章节目录')}</span><span>{chapters.length}</span></div>
        <div className="min-h-0 overflow-y-auto p-2 pt-0">
          <button type="button" className={`ui-btn ui-btn--sm ui-btn--ghost mb-1 w-full justify-start${!range ? ' is-active' : ''}`} aria-current={!range ? 'true' : undefined} onClick={() => chooseChapter(-1)}>{t('整篇原文')}</button>
          {chapters.map((chapter, index) => <button key={chapter.id} type="button" className={`ui-btn ui-btn--sm ui-btn--ghost mb-1 w-full justify-start${range?.start === chapter.start ? ' is-active' : ''}`}
            title={chapter.title} aria-current={range?.start === chapter.start ? 'true' : undefined} onClick={() => chooseChapter(index)}><span className="truncate">{chapter.title}</span></button>)}
          {!chapters.length && <p className="p-2 text-xs leading-relaxed text-canvas-text-muted">{t('写下章节标题后，目录会自动更新。')}</p>}
        </div>
      </nav>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-xs text-canvas-text-secondary">
          <Select size="sm" className={`min-w-0 max-w-52${focused ? ' hidden' : ' lg:hidden'}`} aria-label={t('选择原文章节')}
            value={range ? String(chapters.findIndex((chapter) => chapter.start === range.start)) : '-1'}
            onChange={(value) => chooseChapter(Number(value))}
            options={[{ value: '-1', label: t('整篇原文') }, ...chapters.map((chapter, index) => ({ value: String(index), label: chapter.title }))]} />
          <span className="min-w-0 flex-1 truncate">{chapterTitle ?? t('整篇原文')} · {t('{count} 字', { count })}{range && ` / ${t('全文 {count} 字', { count: wholeCount })}`}</span>
        </div>
        {!document ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-sm text-canvas-text-secondary" role="status">
          <Icon icon={loading || summary.loading ? 'lucide:loader-circle' : 'lucide:book-open'} />{loading || summary.loading ? t('正在载入原文…') : message ? t('原文暂不可用，请重新打开') : t('等待工作台就绪…')}
          {ready && !loading && !summary.loading && <button type="button" className="ui-btn ui-btn--sm" onClick={() => setOpenAttempt((attempt) => attempt + 1)}>{t('重试打开')}</button>}
        </div> : <>
          <textarea key={`${document.documentId}:${range?.start ?? 'all'}`} ref={sourceInput}
            className="ui-textarea min-h-0 flex-1 resize-none p-3 font-sans text-base leading-loose"
            aria-label={range ? t('编辑原文章节：{title}', { title: chapterTitle ?? range.title }) : t('编辑整篇原文')}
            aria-describedby={statusId} value={visibleContent} spellCheck
            readOnly={!ready || summary.saving || busy === 'save' || busy === 'reload' || busy === 'apply'}
            placeholder={t('从这里开始写作。使用「第一章 标题」组织章节。')}
            onChange={(event) => changeContent(event.target.value)}
            onSelect={(event) => {
              const offset = currentRange.current?.start ?? 0;
              setSelection({ start: offset + event.currentTarget.selectionStart, end: offset + event.currentTarget.selectionEnd });
            }}
            onKeyDown={(event) => {
              if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault(); event.stopPropagation();
                if (!working) void run({ type: 'original_save' }, 'save');
              }
            }} />
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 pt-2 text-xs text-canvas-text-secondary">
            <span>{t('{characters} 字符 · {lines} 行', { characters: visibleContent.length.toLocaleString(), lines: visibleContent.split('\n').length.toLocaleString() })}</span>
            <span id={statusId} role="status">{summary.saving || busy === 'save' ? t('正在保存…') : isNew ? t('新原文草稿 · Ctrl+S 创建并保存') : dirty ? t('草稿未保存 · Ctrl+S 保存原文') : t('已保存 · Ctrl+S 保存原文')}</span>
          </footer>
        </>}
      </div>
    </div>
  </section>;
}
