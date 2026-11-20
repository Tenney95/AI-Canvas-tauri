/**
 * CanvasImagePreview — 提供画布图片预览界面与交互。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getNodeHistoryEntries, type HistoryRecord } from '../../services/indexedDbService';
import { useAppStore } from '../../store/useAppStore';
import { useReferencedImageRevisions, withPreviewRevision } from '../../hooks/useReferencedImageWatcher';
import { useT } from '../../i18n';
import ZoomableImage from './ZoomableImage';
import ViewportImage from './ViewportImage';
import ImageComparison from './ImageComparison';

function historySource(record: HistoryRecord): string {
  if (record.filePath) {
    try { return convertFileSrc(record.filePath); } catch { /* Web 环境使用原始地址。 */ }
  }
  return record.mediaUrl || record.output || '';
}

function HistoryThumbnail({ record, projectId }: { record: HistoryRecord; projectId: string | null }) {
  const [source, setSource] = useState(() => historySource(record));
  const fallback = record.mediaUrl || record.output;
  return <ViewportImage src={source} previewMaxEdge={256} projectId={projectId} alt="" className="h-20 w-full object-contain"
    onError={() => { if (fallback && source !== fallback) setSource(fallback); }} />;
}

/** 仅在全屏预览期间订阅画布；浏览位置不改变节点选择、数据或历史。 */
export default function CanvasImagePreview({ nodeId, openingProjectId, src, onClose }: {
  nodeId: string;
  openingProjectId: string | null;
  src?: string;
  onClose: () => void;
}) {
  const t = useT();
  const nodes = useAppStore((state) => state.nodes);
  const projectId = useAppStore((state) => state.currentProjectId);
  const [activeId, setActiveId] = useState(nodeId);
  const [failedSrc, setFailedSrc] = useState<string>();
  const [comparison, setComparison] = useState<{ kind: 'node' | 'history'; id: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<'node' | 'history'>('node');
  const [mode, setMode] = useState<'slider' | 'side-by-side'>('slider');
  const [history, setHistory] = useState<{ nodeId: string; records: HistoryRecord[]; error?: boolean }>();
  const images = useMemo(() => nodes
    .filter((node) => (node.type === 'ai-image' || node.type === 'source-image')
      && !node.data.hiddenByCharacterLibrary
      && !!(node.data.imageUrl || node.data.thumbnailUrl))
    .sort((a, b) => (a.data.displayId ?? Number.MAX_SAFE_INTEGER)
      - (b.data.displayId ?? Number.MAX_SAFE_INTEGER)), [nodes]);
  const index = images.findIndex((node) => node.id === activeId);
  const activeNode = images[index];
  const revisionFor = useReferencedImageRevisions(images.map((node) => node.data.filePath));
  const displaySrc = activeId === nodeId ? src : withPreviewRevision(
    activeNode?.data.imageUrl || activeNode?.data.thumbnailUrl,
    revisionFor(activeNode?.data.filePath),
  );
  const isCurrentProject = projectId === openingProjectId;
  const previous = images[index - 1];
  const next = index >= 0 ? images[index + 1] : undefined;
  const historyRecords = history?.nodeId === activeId ? history.records : [];
  const selectedNode = comparison?.kind === 'node' ? images.find((node) => node.id === comparison.id) : undefined;
  const selectedHistory = comparison?.kind === 'history' ? historyRecords.find((record) => record.id === comparison.id) : undefined;
  const comparisonSrc = selectedNode ? withPreviewRevision(
    selectedNode.data.imageUrl || selectedNode.data.thumbnailUrl, revisionFor(selectedNode.data.filePath),
  ) : selectedHistory ? historySource(selectedHistory) : undefined;
  const comparisonFallback = selectedHistory?.mediaUrl || selectedHistory?.output || undefined;

  useEffect(() => {
    if (!pickerOpen || sourceKind !== 'history' || !projectId) return;
    let active = true;
    void getNodeHistoryEntries(projectId, activeId).then((records) => {
      if (active) setHistory({ nodeId: activeId, records: records.filter((record) => record.projectId === projectId
        && record.nodeId === activeId && record.nodeType === 'ai-image' && record.status === 'success'
        && Boolean(record.filePath || record.mediaUrl || record.output)) });
    }, () => { if (active) setHistory({ nodeId: activeId, records: [], error: true }); });
    return () => { active = false; };
  }, [pickerOpen, sourceKind, projectId, activeId]);

  const navigate = useCallback((direction: -1 | 1) => {
    setActiveId((currentId) => {
      const currentIndex = images.findIndex((node) => node.id === currentId);
      return currentIndex < 0 ? currentId : images[currentIndex + direction]?.id ?? currentId;
    });
    setFailedSrc(undefined);
    setComparison(null);
    setPickerOpen(false);
  }, [images]);

  useEffect(() => {
    if (!isCurrentProject || !activeNode) onClose();
  }, [isCurrentProject, activeNode, onClose]);

  useEffect(() => {
    if (!isCurrentProject || !activeNode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.target instanceof HTMLElement && event.target.closest('button, input, select, [role=slider]')) return;
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : null;
      if (direction === null) return;
      // 在画布捕获监听器之前消费方向键，避免移动背景节点或滚动页面。
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate(direction);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isCurrentProject, activeNode, navigate]);

  if (!isCurrentProject || !activeNode || !displaySrc) return null;

  const comparisonControls = <div className="flex max-w-full flex-wrap items-center justify-center gap-1 border-r border-canvas-border pr-2">
    <button type="button" className="ui-btn ui-btn--link ui-btn--sm whitespace-nowrap" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}>
      {comparison ? t('更换对比图片') : t('对比图片')}
    </button>
    {comparison && <>
      <div className="ui-segmented" aria-label={t('对比方式')}>
        <button type="button" className={`ui-segmented__item whitespace-nowrap${mode === 'slider' ? ' is-active' : ''}`} aria-pressed={mode === 'slider'} onClick={() => setMode('slider')}>{t('滑动对比')}</button>
        <button type="button" className={`ui-segmented__item whitespace-nowrap${mode === 'side-by-side' ? ' is-active' : ''}`} aria-pressed={mode === 'side-by-side'} onClick={() => setMode('side-by-side')}>{t('左右对比')}</button>
      </div>
      <button type="button" className="ui-btn ui-btn--sm whitespace-nowrap" onClick={() => { setComparison(null); setPickerOpen(false); }}>{t('退出对比')}</button>
    </>}
  </div>;

  return (
    <>
      {comparisonSrc ? (
        <ImageComparison leftSrc={displaySrc} rightSrc={comparisonSrc} rightFallbackSrc={comparisonFallback}
          projectId={projectId} mode={mode} controlsPrefix={comparisonControls} />
      ) : failedSrc === displaySrc ? (
        <div data-tauri-drag-region className="flex h-screen flex-col items-center justify-center gap-3 text-white/70">
          <span className="text-sm">{t('图片加载失败')}</span>
          <div className="zoom-controls image-comparison-toolbar">{comparisonControls}</div>
          <button
            type="button"
            className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm text-white transition-colors hover:bg-white/20"
            onClick={() => setFailedSrc(undefined)}
          >
            {t('重新加载')}
          </button>
        </div>
      ) : (
        <ZoomableImage
          key={activeId}
          src={displaySrc}
          alt={activeNode.data.label || t('预览')}
          className="fullscreen-img-view"
          onClose={onClose}
          onError={() => setFailedSrc(displaySrc)}
          controlsPrefix={comparisonControls}
        />
      )}
      {comparisonSrc ? (
        <div className="pointer-events-none fixed inset-x-4 top-4 z-10 grid grid-cols-2 gap-4 text-center text-sm text-white/90 sm:inset-x-12" aria-live="polite">
          <span className="min-w-0 truncate font-medium drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]" title={`${t('当前图片')} · ${activeNode.data.label || t('图片')}`}>
            {t('当前图片')} · {activeNode.data.displayId != null ? `#${activeNode.data.displayId} · ` : ''}{activeNode.data.label || t('图片')}
          </span>
          <span className="min-w-0 truncate font-medium drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]" title={selectedNode?.data.label || (selectedHistory ? new Date(selectedHistory.timestamp).toLocaleString() : '')}>
            {t('对照图片')} · {selectedNode
              ? `${selectedNode.data.displayId != null ? `#${selectedNode.data.displayId} · ` : ''}${selectedNode.data.label || t('图片')}`
              : selectedHistory ? `${t('生成历史')} · ${new Date(selectedHistory.timestamp).toLocaleString()}` : ''}
          </span>
        </div>
      ) : (
        <div className="pointer-events-none fixed inset-x-16 top-4 z-10 text-center text-sm" aria-live="polite">
          <span className="inline-block max-w-full truncate font-medium text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
            {activeNode.data.displayId != null ? `#${activeNode.data.displayId} · ` : ''}
            {activeNode.data.label} · {index + 1} / {images.length}
          </span>
        </div>
      )}
      {pickerOpen && <div className="fixed bottom-32 left-1/2 z-20 sm:bottom-24 w-[min(90vw,360px)] -translate-x-1/2" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <div className="flex max-h-[min(65vh,480px)] w-[min(90vw,360px)] flex-col rounded-lg border border-canvas-border bg-canvas-surface p-2 text-canvas-text shadow-xl">
          <div className="ui-segmented shrink-0" aria-label={t('图片来源')}>
            <button type="button" className={`ui-segmented__item${sourceKind === 'node' ? ' is-active' : ''}`} aria-pressed={sourceKind === 'node'} onClick={() => setSourceKind('node')}>{t('其他节点')}</button>
            <button type="button" className={`ui-segmented__item${sourceKind === 'history' ? ' is-active' : ''}`} aria-pressed={sourceKind === 'history'} onClick={() => setSourceKind('history')}>{t('生成历史')}</button>
          </div>
          <div className="ui-scroll mt-2 min-h-0 overflow-y-auto">
            {sourceKind === 'node' ? (
              images.filter((node) => node.id !== activeId).length ? <div className="grid grid-cols-3 gap-2">
                {images.filter((node) => node.id !== activeId).map((node) => <button key={node.id} type="button" className="overflow-hidden rounded border border-canvas-border bg-canvas-card text-left hover:bg-canvas-hover focus-visible:outline focus-visible:outline-2" onClick={() => { setComparison({ kind: 'node', id: node.id }); setPickerOpen(false); }}>
                  <ViewportImage src={withPreviewRevision(node.data.imageUrl || node.data.thumbnailUrl, revisionFor(node.data.filePath))} previewMaxEdge={256} projectId={projectId} alt="" className="h-20 w-full object-contain" />
                  <span className="block truncate p-1 text-xs">{node.data.displayId != null ? `#${node.data.displayId} · ` : ''}{node.data.label || t('图片')}</span>
                </button>)}
              </div> : <p className="p-3 text-sm text-canvas-text-muted">{t('没有其他图片节点')}</p>
            ) : history?.nodeId !== activeId ? <p className="p-3 text-sm text-canvas-text-muted">{t('正在加载...')}</p>
              : history.error ? <p className="p-3 text-sm text-canvas-text-muted">{t('生成历史加载失败')}</p>
              : historyRecords.length ? <div className="grid grid-cols-3 gap-2">
                {historyRecords.map((record) => <button key={record.id} type="button" className="overflow-hidden rounded border border-canvas-border bg-canvas-card text-left hover:bg-canvas-hover focus-visible:outline focus-visible:outline-2" onClick={() => { setComparison({ kind: 'history', id: record.id }); setPickerOpen(false); }}>
                  <HistoryThumbnail record={record} projectId={projectId} />
                  <span className="block truncate p-1 text-xs">{new Date(record.timestamp).toLocaleString()}</span>
                </button>)}
              </div> : <p className="p-3 text-sm text-canvas-text-muted">{t('暂无生成历史')}</p>}
          </div>
        </div>
      </div>}
      {!comparisonSrc && <div
        className="pointer-events-none fixed inset-x-3 top-1/2 z-10 flex -translate-y-1/2 justify-between sm:inset-x-6"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border-0 bg-transparent text-white/75 drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] transition-all hover:bg-white/10 hover:text-white active:scale-95 active:bg-white/20 disabled:pointer-events-none disabled:opacity-20"
          aria-label={t('上一张')}
          title={`${t('上一张')} (↑ / ←)`}
          disabled={!previous}
          onClick={() => navigate(-1)}
        >
          <ChevronLeft size={28} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border-0 bg-transparent text-white/75 drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] transition-all hover:bg-white/10 hover:text-white active:scale-95 active:bg-white/20 disabled:pointer-events-none disabled:opacity-20"
          aria-label={t('下一张')}
          title={`${t('下一张')} (↓ / →)`}
          disabled={!next}
          onClick={() => navigate(1)}
        >
          <ChevronRight size={28} aria-hidden="true" />
        </button>
      </div>}
    </>
  );
}
