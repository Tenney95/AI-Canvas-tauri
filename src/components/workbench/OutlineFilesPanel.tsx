/** 大纲文件栏：正文只在编辑会话中传递，文件操作交给主窗口。 */
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { OutlineDocumentAction, OutlineDocumentSummary, OutlineOpenedDocument } from '../../types/outlineDocument';
import { LazyLoadBoundary, LazyLoadFallback } from '../shared/LazyLoadBoundary';

const DocumentPreview = lazy(() => import('./OutlineDocumentPreview'));

function openedDocument(value: unknown): OutlineOpenedDocument | undefined {
  if (!value || typeof value !== 'object' || !('documentId' in value) || !('kind' in value)) return undefined;
  return value as OutlineOpenedDocument;
}

export default function OutlineFilesPanel({ summary, dispatch, ready, active, children, fileListVisible = true, onArticleContainer }: {
  summary: OutlineDocumentSummary;
  dispatch: (action: OutlineDocumentAction) => Promise<unknown>;
  ready: boolean;
  active: boolean;
  children: ReactNode;
  fileListVisible?: boolean;
  onArticleContainer?: (element: HTMLDivElement | null) => void;
}) {
  const t = useT();
  const nameId = useId();
  const [document, setDocument] = useState<OutlineOpenedDocument>();
  const documentRef = useRef(document);
  const [creating, setCreating] = useState<'md' | 'txt'>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editPending, setEditPending] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const editSequence = useRef(0);
  const latestEdit = useRef<Promise<unknown> | null>(null);
  const lifetime = useRef(0);
  const operation = useRef(false);

  useEffect(() => { lifetime.current += 1; return () => { lifetime.current += 1; }; }, []);
  useEffect(() => {
    if (!active || !ready || summary.loaded) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void dispatch({ type: 'outline_list' }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : t('无法读取大纲文件'));
      });
    });
    return () => { cancelled = true; };
  }, [active, ready, summary.loaded, dispatch, t]);
  useEffect(() => {
    if (!active || !ready || !summary.selected || !summary.fileId || document) return;
    let cancelled = false;
    // 展示方式交接后重取当前文件，正文不进入工作台广播摘要。
    queueMicrotask(() => {
      if (cancelled || operation.current) return;
      const version = lifetime.current;
      void dispatch({ type: 'outline_open', id: summary.fileId! }).then((result) => {
        if (cancelled || lifetime.current !== version) return;
        const next = openedDocument(result);
        if (!next) throw new Error(t('文件响应无效，请重新载入'));
        documentRef.current = next;
        setDocument(next);
        editSequence.current = next.kind === 'text' ? next.acceptedSequence : 0;
      }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : t('无法读取大纲文件'));
      });
    });
    return () => { cancelled = true; };
  }, [active, ready, summary.selected, summary.fileId, document, dispatch, t]);

  const adopt = (next: OutlineOpenedDocument) => {
    documentRef.current = next;
    setDocument(next);
    editSequence.current = next.kind === 'text' ? next.acceptedSequence : 0;
    latestEdit.current = null;
    setEditPending(false);
    setDiscardConfirm(false);
  };
  const flush = async () => {
    const current = documentRef.current;
    if (current?.kind !== 'text' || !latestEdit.current) return;
    try { await latestEdit.current; }
    catch {
      const retry = dispatch({ type: 'outline_edit', handoff: { documentId: current.documentId,
        sequence: ++editSequence.current, content: current.content } });
      latestEdit.current = retry;
      await retry;
    }
  };
  const run = async (action: OutlineDocumentAction) => {
    if (operation.current || !ready) return;
    operation.current = true;
    const version = lifetime.current;
    setBusy(true); setError('');
    try {
      if (action.type !== 'outline_reload' || !action.discard) await flush();
      if (lifetime.current !== version) return;
      const result = openedDocument(await dispatch(action));
      if (lifetime.current !== version) return;
      if (result) adopt(result);
      if (action.type === 'outline_create') { setCreating(undefined); setName(''); }
      return true;
    } catch (reason) {
      if (lifetime.current === version) setError(reason instanceof Error ? reason.message : t('文件操作未完成，草稿已保留'));
      return false;
    } finally {
      if (lifetime.current === version) { operation.current = false; setBusy(false); }
    }
  };
  const changeContent = (content: string) => {
    const current = documentRef.current;
    if (current?.kind !== 'text' || current.documentId !== summary.documentId || busy || summary.busy || !ready) return;
    if (content.includes('\0') || new TextEncoder().encode(content).byteLength > 2 * 1024 * 1024) {
      setError(t(content.includes('\0') ? '文本不能包含二进制空字符' : '内容超过 2 MB，无法保存'));
      return;
    }
    const next = { ...current, content };
    documentRef.current = next; setDocument(next); setEditPending(true); setDiscardConfirm(false);
    const sequence = ++editSequence.current;
    const version = lifetime.current;
    const pending = dispatch({ type: 'outline_edit', handoff: { documentId: current.documentId, sequence, content } });
    latestEdit.current = pending;
    void pending.then(() => {
      if (lifetime.current === version && editSequence.current === sequence) setEditPending(false);
    }).catch((reason: unknown) => {
      if (lifetime.current === version && editSequence.current === sequence) {
        setError(reason instanceof Error ? reason.message : t('草稿同步失败，请保留当前页面并重试保存'));
      }
    });
  };
  const working = busy || summary.busy;
  const dirty = summary.dirty || editPending;
  const selected = summary.selected;
  const documentMatches = document?.documentId === summary.documentId;
  const message = error || summary.error;
  const icons = { text: 'lucide:file-text', pdf: 'lucide:file-type-2', presentation: 'lucide:presentation',
    word: 'lucide:file-text', 'legacy-word': 'lucide:file-text' };

  return <div className="flex h-full min-h-80 min-w-0 overflow-hidden" onKeyDown={(event) => {
    if (selected && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation();
      if (documentMatches && document?.kind === 'text') void run({ type: 'outline_save' });
    }
  }}>
    <aside aria-label={t('大纲文件')} className={`${fileListVisible ? 'flex' : 'hidden'} w-40 shrink-0 flex-col border-r border-border-subtle bg-canvas-bg/30 sm:w-44`}>
      <div className="flex items-center gap-1 p-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{t('大纲文件')}</span>
        <button type="button" className="ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm" disabled={!ready || working}
          aria-label={t('刷新文件列表')} title={t('刷新文件列表')} onClick={() => { void run({ type: 'outline_list' }); }}>
          <Icon icon="lucide:refresh-cw" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {(['md', 'txt'] as const).map((extension) => <button key={extension} type="button" className="ui-btn ui-btn--sm"
          disabled={!ready || working} onClick={() => { setCreating(extension); setName(''); }}>
          <Icon icon="lucide:file-plus-2" className="h-3 w-3" />{t('新建 {format}', { format: extension.toUpperCase() })}
        </button>)}
        <button type="button" className="ui-btn ui-btn--sm" disabled={!ready || working}
          onClick={() => { void run({ type: 'outline_import' }); }}>
          <Icon icon="lucide:upload" className="h-3 w-3" />{t('上传文件')}
        </button>
      </div>
      {creating && <form className="space-y-2 border-y border-border-subtle p-2" onSubmit={(event) => {
        event.preventDefault(); void run({ type: 'outline_create', name, extension: creating });
      }}>
        <label className="ui-label" htmlFor={nameId}>{t('文件名')} · .{creating}</label>
        <input id={nameId} className="ui-input w-full" value={name} maxLength={100} disabled={working}
          onChange={(event) => setName(event.target.value)} placeholder={t('例如：故事大纲')} autoFocus />
        <div className="flex gap-1">
          <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!name.trim() || working || !ready}>{t('创建')}</button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={working} onClick={() => setCreating(undefined)}>{t('取消')}</button>
        </div>
      </form>}
      <nav aria-label={t('大纲文档列表')} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        <button type="button" aria-current={!selected ? 'page' : undefined}
          className={`ui-btn ui-btn--sm w-full ${!selected ? 'ui-btn--secondary' : 'ui-btn--ghost'}`}
          disabled={working} onClick={() => { void run({ type: 'outline_select_builtin' }); }}>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Icon icon="lucide:list-tree" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('本集大纲')}</span>
          </span>
        </button>
        {summary.files.map((file) => <button key={file.id} type="button" title={file.fileName}
          aria-current={selected && summary.fileId === file.id ? 'page' : undefined}
          className={`ui-btn ui-btn--sm w-full ${selected && summary.fileId === file.id ? 'ui-btn--secondary' : 'ui-btn--ghost'}`}
          disabled={!ready || working} onClick={() => { void run({ type: 'outline_open', id: file.id }); }}>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Icon icon={icons[file.kind]} className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
            {summary.dirty && summary.fileId === file.id && <span aria-label={t('有未保存修改')} className="shrink-0 text-canvas-text-secondary">●</span>}
          </span>
        </button>)}
        {summary.loaded && summary.files.length === 0 && <p className="p-2 text-[11px] leading-relaxed text-canvas-text-muted">{t('新建大纲文档，或上传参考资料。')}</p>}
      </nav>
      <p className="border-t border-border-subtle p-2 text-[10px] leading-relaxed text-canvas-text-muted">MD · TXT · PDF · PPT/PPTX · Word<br />{t('文件在本剧各集间共享')}</p>
    </aside>
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('大纲文档内容')}>
      {message && <div className="ui-alert ui-alert--danger m-2 shrink-0 text-xs" role="alert">{t(message)}</div>}
      {selected && <>
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-xs">
          <span className="min-w-0 flex-1 truncate" title={summary.fileName}>{summary.fileName}</span>
          {documentMatches && document?.kind === 'text' && <>
            <span className="shrink-0 text-canvas-text-muted">{dirty ? t('有未保存修改') : t('已保存')}</span>
            <button type="button" className="ui-btn ui-btn--sm" disabled={!ready || working}
              onClick={() => { if (dirty) setDiscardConfirm(true); else void run({ type: 'outline_reload' }); }}>{t('重新载入')}</button>
            <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!ready || working || !dirty}
              onClick={() => { void run({ type: 'outline_save' }); }}>{working ? t('保存中…') : t('保存文件')}</button>
          </>}
        </div>
        {discardConfirm && <div className="ui-alert ui-alert--warning m-2 flex flex-wrap items-center gap-2 text-xs" role="alert">
          <span>{t('重新载入会放弃此文件的未保存修改。')}</span>
          <button type="button" className="ui-btn ui-btn--sm" disabled={working} onClick={() => { void run({ type: 'outline_reload', discard: true }); }}>{t('放弃并重新载入')}</button>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setDiscardConfirm(false)}>{t('取消')}</button>
        </div>}
      </>}
      <div ref={onArticleContainer} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (!documentMatches && document ? <div className="grid min-h-48 flex-1 place-items-center p-3 text-center text-xs text-canvas-text-secondary">
          <div><p>{t('选中文件已变化，请重新打开以核对内容。')}</p>
            <button type="button" className="ui-btn ui-btn--sm mt-2" disabled={!ready || working || !summary.fileId}
              onClick={() => { if (summary.fileId) void run({ type: 'outline_open', id: summary.fileId }); }}>{t('重新打开所选文件')}</button>
          </div>
        </div> : document?.kind === 'text' ? <textarea aria-label={document.fileName} className="ui-textarea script-workbench-article-text min-h-0 w-full flex-1 resize-none rounded-none border-0 p-3 font-mono text-[13px] leading-7"
          value={document.content} readOnly={!ready || working} spellCheck={false} onChange={(event) => changeContent(event.target.value)} />
          : document ? <LazyLoadBoundary label={t('文档预览')} resetKey={document.documentId}>
            <Suspense fallback={<LazyLoadFallback label={t('文档预览')} />}>
              <DocumentPreview fileName={document.fileName} kind={document.kind} base64={document.base64} active={active && ready} />
            </Suspense>
          </LazyLoadBoundary> : <div className="grid flex-1 place-items-center p-3 text-xs text-canvas-text-muted" role="status">{t('正在读取文件…')}</div>) : children}
      </div>
    </section>
  </div>;
}
