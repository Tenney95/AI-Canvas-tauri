import { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { useT } from '../../i18n';
import { documentPreviewError, loadDocumentPreview, type DocumentPreviewKind, type DocumentPreviewResource } from '../../services/documentPreviewService';

interface OutlineDocumentPreviewProps {
  fileName: string;
  kind: DocumentPreviewKind;
  base64: string;
  active: boolean;
}

export default function OutlineDocumentPreview({ fileName, kind, base64, active }: OutlineDocumentPreviewProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<{ source: string; resource: DocumentPreviewResource } | null>(null);
  const [error, setError] = useState<{ source: string; message: string } | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [canvasWidth, setCanvasWidth] = useState<number>();
  const [image, setImage] = useState<{ source: string; page: number; url: string } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [input, setInput] = useState({ base64, kind, active });
  if (input.base64 !== base64 || input.kind !== kind || input.active !== active) {
    setInput({ base64, kind, active });
    setLoaded(null); setError(null); setImage(null); setCanvasWidth(undefined); setRendering(false);
  }
  const canvas = useRef<HTMLCanvasElement>(null);
  const resource = active && loaded?.source === base64 ? loaded.resource : null;
  const currentPage = resource ? Math.min(page, resource.pageCount) : 1;
  const currentError = error?.source === base64 ? error.message : '';

  useEffect(() => {
    if (!active || kind === 'legacy-word') return;
    const controller = new AbortController();
    let preview: DocumentPreviewResource | undefined;
    let pdfTask: PDFDocumentLoadingTask | undefined;
    void loadDocumentPreview(kind, base64, controller.signal, (task) => { pdfTask = task; }).then((next) => {
      if (controller.signal.aborted) { next.dispose(); return; }
      preview = next;
      setLoaded({ source: base64, resource: next }); setError(null); setPage(1); setZoom(1);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError({ source: base64, message: documentPreviewError(reason) });
    });
    return () => {
      controller.abort(); preview?.dispose();
      if (!preview) void pdfTask?.destroy().catch(() => {});
    };
  }, [active, kind, base64]);

  useEffect(() => {
    if (!resource || resource.kind === 'word') return;
    const controller = new AbortController();
    let renderTask: RenderTask | undefined;
    let imageUrl: string | undefined;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setRendering(true); setError(null);
      if (resource.kind === 'presentation') {
        imageUrl = await resource.renderPage(currentPage, controller.signal);
        if (controller.signal.aborted) { URL.revokeObjectURL(imageUrl); return; }
        setImage({ source: base64, page: currentPage, url: imageUrl });
        return;
      }
      const surface = canvas.current;
      if (!surface) return;
      const pdfPage = await resource.document.getPage(currentPage);
      controller.signal.throwIfAborted();
      const original = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(zoom * Math.min(window.devicePixelRatio || 1, 2), 4096 / Math.max(original.width, original.height),
        Math.sqrt(12_000_000 / (original.width * original.height)));
      const viewport = pdfPage.getViewport({ scale });
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 1 || viewport.height < 1) throw new Error('invalid-page');
      surface.width = Math.ceil(viewport.width); surface.height = Math.ceil(viewport.height);
      setCanvasWidth(Math.ceil(original.width * zoom));
      renderTask = pdfPage.render({ canvas: surface, viewport, annotationMode: 0 });
      try { await renderTask.promise; }
      finally { pdfPage.cleanup(); }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError({ source: base64, message: documentPreviewError(reason) });
    }).finally(() => { if (!controller.signal.aborted) setRendering(false); });
    return () => { controller.abort(); renderTask?.cancel(); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [resource, currentPage, zoom, base64]);

  if (kind === 'legacy-word') return <div className="grid h-full min-h-64 place-items-center p-3 text-center text-sm text-canvas-text-secondary">
    <p>{t('旧版 .doc 文件已保留，请用 Word 或 WPS 另存为 .docx 或 PDF 后上传预览。')}</p>
  </div>;

  return <section className="flex h-full min-h-0 flex-col" aria-label={t('文档预览')}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle p-2">
      <span className="min-w-0 flex-1 truncate text-xs text-canvas-text-secondary" title={fileName}>{fileName}</span>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={t('上一页')}
        disabled={!resource || currentPage <= 1 || rendering} onClick={() => setPage(currentPage - 1)}><Icon icon="lucide:chevron-left" className="h-4 w-4" /></button>
      <span className="text-xs tabular-nums text-canvas-text-muted" aria-live="polite">{resource ? `${currentPage} / ${resource.pageCount}` : '—'}</span>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={t('下一页')}
        disabled={!resource || currentPage >= resource.pageCount || rendering} onClick={() => setPage(currentPage + 1)}><Icon icon="lucide:chevron-right" className="h-4 w-4" /></button>
      {resource?.kind === 'pdf' && <>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={t('缩小')} disabled={zoom <= 0.5 || rendering}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><Icon icon="lucide:minus" className="h-3.5 w-3.5" /></button>
        <span className="text-xs tabular-nums text-canvas-text-muted">{Math.round(zoom * 100)}%</span>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label={t('放大')} disabled={zoom >= 2 || rendering}
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}><Icon icon="lucide:plus" className="h-3.5 w-3.5" /></button>
      </>}
      <span className="text-[11px] text-canvas-text-muted">{t('只读预览')}</span>
    </div>
    {currentError && <p role="alert" className="shrink-0 border-b border-border-subtle p-3 text-xs text-canvas-text-secondary">{t(currentError)}</p>}
    <div className="relative min-h-0 flex-1 overflow-auto bg-canvas-bg p-3" aria-busy={!resource || rendering}>
      {!resource && !currentError && <div role="status" className="grid h-full min-h-48 place-items-center text-xs text-canvas-text-muted">{t('正在加载预览…')}</div>}
      {resource?.kind === 'pdf' && <canvas ref={canvas} className="mx-auto block h-auto" style={{ width: canvasWidth }} aria-label={t('第 {page} 页', { page: currentPage })} />}
      {resource?.kind === 'presentation' && image?.source === base64 && image.page === currentPage
        && <img className="mx-auto block h-auto max-w-full" src={image.url} alt={t('第 {page} 页', { page: currentPage })} draggable={false} />}
      {resource?.kind === 'word' && <iframe sandbox="" referrerPolicy="no-referrer" className="h-full min-h-96 w-full border-0"
        title={t('第 {page} 页', { page: currentPage })} srcDoc={resource.pages[currentPage - 1]} />}
    </div>
  </section>;
}
