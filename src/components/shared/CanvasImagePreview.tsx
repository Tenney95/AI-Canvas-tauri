import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useReferencedImageRevisions, withPreviewRevision } from '../../hooks/useReferencedImageWatcher';
import { useT } from '../../i18n';
import ZoomableImage from './ZoomableImage';

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
  const images = useMemo(() => nodes
    .filter((node) => (node.type === 'ai-image' || node.type === 'source-image')
      && !node.data.hiddenByCharacterLibrary
      && !!(node.data.imageUrl || node.data.thumbnailUrl))
    .sort((a, b) => (a.data.displayId ?? Number.MAX_SAFE_INTEGER)
      - (b.data.displayId ?? Number.MAX_SAFE_INTEGER)), [nodes]);
  const index = images.findIndex((node) => node.id === activeId);
  const activeNode = images[index];
  const revisionFor = useReferencedImageRevisions([activeNode?.data.filePath]);
  const displaySrc = activeId === nodeId ? src : withPreviewRevision(
    activeNode?.data.imageUrl || activeNode?.data.thumbnailUrl,
    revisionFor(activeNode?.data.filePath),
  );
  const isCurrentProject = projectId === openingProjectId;
  const previous = images[index - 1];
  const next = index >= 0 ? images[index + 1] : undefined;

  const navigate = useCallback((direction: -1 | 1) => {
    setActiveId((currentId) => {
      const currentIndex = images.findIndex((node) => node.id === currentId);
      return currentIndex < 0 ? currentId : images[currentIndex + direction]?.id ?? currentId;
    });
    setFailedSrc(undefined);
  }, [images]);

  useEffect(() => {
    if (!isCurrentProject || !activeNode) onClose();
  }, [isCurrentProject, activeNode, onClose]);

  useEffect(() => {
    if (!isCurrentProject || !activeNode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
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

  return (
    <>
      {failedSrc === displaySrc ? (
        <div className="flex h-screen flex-col items-center justify-center gap-3 text-canvas-text-muted">
          <span className="text-sm">{t('图片加载失败')}</span>
          <button className="ui-btn ui-btn--secondary" onClick={() => setFailedSrc(undefined)}>
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
        />
      )}
      <div className="pointer-events-none fixed inset-x-16 top-4 z-10 text-center text-sm text-canvas-text" aria-live="polite">
        <span className="inline-block max-w-full truncate rounded-lg bg-canvas-surface px-3 py-1.5">
          {activeNode.data.displayId != null ? `#${activeNode.data.displayId} · ` : ''}
          {activeNode.data.label} · {index + 1} / {images.length}
        </span>
      </div>
      <div
        className="pointer-events-none fixed inset-x-3 top-1/2 z-10 flex -translate-y-1/2 justify-between sm:inset-x-6"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="ui-btn ui-btn--secondary ui-btn--lg pointer-events-auto disabled:opacity-30"
          aria-label={t('上一张')}
          title={`${t('上一张')} (↑ / ←)`}
          disabled={!previous}
          onClick={() => navigate(-1)}
        >
          <ChevronLeft size={24} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn--secondary ui-btn--lg pointer-events-auto disabled:opacity-30"
          aria-label={t('下一张')}
          title={`${t('下一张')} (↓ / →)`}
          disabled={!next}
          onClick={() => navigate(1)}
        >
          <ChevronRight size={24} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
