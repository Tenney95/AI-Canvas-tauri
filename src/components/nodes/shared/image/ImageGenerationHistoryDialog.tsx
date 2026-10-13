/**
 * 展示当前图片节点的生成历史，支持恢复历史结果、查看参数和全屏预览。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Icon } from '@iconify/react';
import type { HistoryRecord } from '../../../../services/indexedDbService';
import { getNodeHistoryEntries } from '../../../../services/indexedDbService';
import { useAppStore } from '../../../../store/useAppStore';
import ModalOverlay from '../../../shared/ModalOverlay';
import PopupCloseButton from '../../../shared/PopupCloseButton';
import FullscreenOverlay from '../../../shared/FullscreenOverlay';
import ZoomableImage from '../../../shared/ZoomableImage';
import ViewportImage from '../../../shared/ViewportImage';
import { useT } from '../../../../i18n';
import { localMediaUrlToPath } from '../../../../utils/mediaUrl';
import {
  cancelCanvasDerivation,
  completeCanvasDerivation,
  isCanvasDerivationFresh,
  registerCanvasDerivation,
  type CanvasDerivationGuard,
} from '../../../../services/canvasDerivationGuard';
import { computeImageNodeDimensions } from './imageUtils';

const hasLocalFile = (entry: HistoryRecord) => !!(entry.filePath || localMediaUrlToPath(entry.mediaUrl) || localMediaUrlToPath(entry.output));

interface ImageGenerationHistoryDialogProps {
  isOpen: boolean;
  nodeId: string;
  onClose: () => void;
}

interface PreviewImage {
  src: string;
  alt: string;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function getRemoteSource(entry: HistoryRecord): string {
  return entry.mediaUrl || entry.output || '';
}

function getInitialSource(entry: HistoryRecord): string {
  if (entry.filePath) {
    try {
      return convertFileSrc(entry.filePath);
    } catch {
      // Web-only mode falls back to the original generation URL.
    }
  }
  return getRemoteSource(entry);
}

function isCurrentImage(entry: HistoryRecord, imageUrl?: string, filePath?: string): boolean {
  const currentPath = filePath || localMediaUrlToPath(imageUrl);
  const historyPath = entry.filePath || localMediaUrlToPath(getRemoteSource(entry));
  if (currentPath && historyPath) {
    const normalize = (path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    return normalize(currentPath) === normalize(historyPath);
  }
  return Boolean(imageUrl && [getInitialSource(entry), entry.mediaUrl, entry.output].includes(imageUrl));
}

function HistoryImage({
  entry,
  onPreview,
}: {
  entry: HistoryRecord;
  onPreview: (preview: PreviewImage) => void;
}) {
  const t = useT();
  const remoteSource = getRemoteSource(entry);
  const [src, setSrc] = useState(() => getInitialSource(entry));
  const [unavailable, setUnavailable] = useState(false);

  const handleError = useCallback(() => {
    if (remoteSource && src !== remoteSource) {
      setSrc(remoteSource);
      return;
    }
    setUnavailable(true);
  }, [remoteSource, src]);

  if (!src || unavailable) {
    return (
      <div className="flex h-36 shrink-0 items-center justify-center bg-canvas-bg text-canvas-text-muted">
        <Icon icon="mdi:image-off-outline" width={24} height={24} aria-hidden="true" />
      </div>
    );
  }

  const alt = entry.prompt.trim() || t('历史生成图片');

  return (
    <button
      type="button"
      className="group relative block h-36 w-full shrink-0 overflow-hidden bg-canvas-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-400/70"
      aria-label={t('放大查看历史图片')}
      onClick={() => onPreview({ src, alt })}
    >
      <ViewportImage
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        rootMargin="360px 0px"
        unloadDelayMs={800}
        className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transform-none"
        onError={handleError}
      />
      <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <Icon icon="mdi:magnify-plus-outline" width={16} height={16} aria-hidden="true" />
      </span>
    </button>
  );
}

export default function ImageGenerationHistoryDialog({
  isOpen,
  nodeId,
  onClose,
}: ImageGenerationHistoryDialogProps) {
  const t = useT();
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const currentImageUrl = useAppStore((state) => {
    const data = state.nodes.find((node) => node.id === nodeId)?.data;
    return data?.imageUrl || data?.thumbnailUrl;
  });
  const currentFilePath = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.filePath);
  const nodeLoading = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.status === 'loading');
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [recordsProjectId, setRecordsProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadRevision, setLoadRevision] = useState(0);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const applyingGuard = useRef<CanvasDerivationGuard | null>(null);

  const cancelApplication = useCallback(() => {
    if (applyingGuard.current) cancelCanvasDerivation(applyingGuard.current);
    applyingGuard.current = null;
    setApplyingId(null);
  }, []);

  useEffect(() => cancelApplication, [cancelApplication, currentProjectId, isOpen, nodeId]);

  const handleApply = async (entry: HistoryRecord) => {
    const store = useAppStore.getState();
    const node = store.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'ai-image');
    if (applyingGuard.current || deleting || !isOpen || !currentProjectId
      || recordsProjectId !== currentProjectId || store.currentProjectId !== currentProjectId
      || entry.projectId !== currentProjectId || entry.nodeId !== nodeId
      || !node || node.data.status === 'loading'
      || isCurrentImage(entry, node.data.imageUrl || node.data.thumbnailUrl, node.data.filePath)) return;
    const guard = registerCanvasDerivation(store, nodeId);
    if (!guard) return;
    applyingGuard.current = guard;
    setApplyingId(entry.id);
    try {
      const initialSource = getInitialSource(entry);
      let imageUrl = initialSource;
      let dimensions = await computeImageNodeDimensions(imageUrl);
      if (!isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      const fallbackSource = getRemoteSource(entry);
      if ((!dimensions.imageWidth || !dimensions.imageHeight) && fallbackSource && fallbackSource !== imageUrl) {
        imageUrl = fallbackSource;
        dimensions = await computeImageNodeDimensions(imageUrl);
      }
      const liveStore = useAppStore.getState();
      if (!isCanvasDerivationFresh(guard, liveStore)) return;
      if (!dimensions.imageWidth || !dimensions.imageHeight) throw new Error(t('图片加载失败'));
      const liveNode = liveStore.nodes.find((candidate) => candidate.id === nodeId);
      if (!liveNode || liveNode.type !== 'ai-image' || liveNode.data.status === 'loading') return;
      const filePath = localMediaUrlToPath(imageUrl) || (imageUrl === initialSource ? entry.filePath : undefined);
      liveStore.updateNodeData(nodeId, {
        imageUrl,
        thumbnailUrl: imageUrl,
        filePath,
        fileName: filePath?.replace(/\\/g, '/').split('/').pop(),
        output: entry.output || imageUrl,
        sourceUrl: entry.output || imageUrl,
        status: 'success',
        error: undefined,
        artifactId: undefined,
        mattingMask: undefined,
        annotation: undefined,
        annotationLayer: undefined,
        imageWidth: dimensions.imageWidth,
        imageHeight: dimensions.imageHeight,
        nodeHeight: Math.max(120, Math.round(((liveNode.data.nodeWidth ?? 280) - 4)
          * dimensions.imageHeight / dimensions.imageWidth) + 4),
        mediaVersion: (liveNode.data.mediaVersion ?? 0) + 1,
      });
      liveStore.showToast(t('已应用，可撤销'));
    } catch {
      if (isCanvasDerivationFresh(guard, useAppStore.getState())) store.showToast(t('图片加载失败'), 'error');
    } finally {
      completeCanvasDerivation(guard);
      if (applyingGuard.current === guard) {
        applyingGuard.current = null;
        setApplyingId(null);
      }
    }
  };

  const handleDelete = async (entry: HistoryRecord, withFile: boolean) => {
    if (deleting || applyingGuard.current || !currentProjectId || recordsProjectId !== currentProjectId) return;
    const store = useAppStore.getState();
    if (store.currentProjectId !== currentProjectId) return;
    setDeleting(true);
    try {
      if (withFile) await store.deleteHistoryEntryFile(currentProjectId, entry.id);
      else await store.deleteHistoryEntry(nodeId, entry.id);
      setRecords((current) => current.filter((record) => record.id !== entry.id));
      setDeleteTarget(null);
      store.showToast(t(withFile && hasLocalFile(entry) ? '文件及历史记录已清理' : '历史记录已删除'));
    } catch (error) {
      store.showToast(error instanceof Error ? error.message : t('删除失败，请重试'), 'error');
    } finally { setDeleting(false); }
  };

  useEffect(() => {
    if (!isOpen || !currentProjectId) return;
    let active = true;

    void Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError('');
      try {
        const nextRecords = await getNodeHistoryEntries(currentProjectId, nodeId);
        if (active) {
          setRecords(nextRecords);
          setRecordsProjectId(currentProjectId);
        }
      } catch {
        if (active) {
          setRecords([]);
          setRecordsProjectId(currentProjectId);
          setError(t('生成历史加载失败'));
        }
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [currentProjectId, isOpen, loadRevision, nodeId, t]);

  const imageRecords = useMemo(() => (
    recordsProjectId === currentProjectId
      ? records.filter((entry) => (
          entry.nodeType === 'ai-image'
          && entry.nodeId === nodeId
          && entry.projectId === currentProjectId
          && entry.status === 'success'
          && Boolean(entry.filePath || entry.mediaUrl || entry.output)
        ))
      : []
  ), [currentProjectId, nodeId, records, recordsProjectId]);

  const handleClose = useCallback(() => {
    cancelApplication();
    setPreview(null);
    onClose();
  }, [cancelApplication, onClose]);

  return createPortal(
    <>
      {preview === null && <ModalOverlay
        isOpen={isOpen}
        onClose={handleClose}
        ariaLabel={t('图片生成历史')}
        className="max-h-[82vh] w-[min(94vw,880px)] rounded-2xl border-canvas-border bg-canvas-surface"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-canvas-border px-2.5 py-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-green-500/10 text-green-400">
            <Icon icon="mdi:history" width={18} height={18} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-canvas-text">{t('生成历史')}</h2>
            <p className="text-[11px] text-canvas-text-muted">
              {loading ? t('正在加载...') : t('{count} 张图片', { count: imageRecords.length })}
            </p>
          </div>
          <PopupCloseButton onClick={handleClose} />
        </div>

        <div className="ui-scroll min-h-0 flex-1 p-3">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-xs text-canvas-text-muted">
              <Icon icon="mdi:loading" width={18} height={18} className="animate-spin" aria-hidden="true" />
              <span>{t('正在加载生成历史')}</span>
            </div>
          ) : error ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-canvas-text-muted">
              <Icon icon="mdi:alert-circle-outline" width={28} height={28} aria-hidden="true" />
              <p className="text-xs">{error}</p>
              <button
                type="button"
                className="rounded-md border border-canvas-border px-3 py-1.5 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-hover hover:text-canvas-text"
                onClick={() => setLoadRevision((revision) => revision + 1)}
              >
                {t('重试')}
              </button>
            </div>
          ) : imageRecords.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-canvas-text-muted">
              <Icon icon="mdi:image-multiple-outline" width={32} height={32} aria-hidden="true" />
              <p className="text-xs">{t('这个节点还没有生成过图片')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {imageRecords.map((entry) => {
                const current = isCurrentImage(entry, currentImageUrl, currentFilePath);
                return (
                  <article
                    key={entry.id}
                    className={`ui-card h-80 min-w-0${current ? ' is-selected' : ''}`}
                  >
                    <HistoryImage entry={entry} onPreview={setPreview} />
                    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
                      <div className="flex min-w-0 shrink-0 items-center gap-2 text-[11px]">
                        <span className="ui-badge min-w-0 truncate" title={[entry.provider, entry.model].filter(Boolean).join(' / ')}>
                          <span className="truncate">{[entry.provider, entry.model].filter(Boolean).join(' / ') || t('未记录模型')}</span>
                        </span>
                        <time className="ml-auto shrink-0 text-canvas-text-muted" dateTime={new Date(entry.timestamp).toISOString()}>
                          {DATE_FORMATTER.format(entry.timestamp)}
                        </time>
                      </div>
                      <p className="ui-scroll min-h-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 text-canvas-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canvas-border"
                        tabIndex={0} role="region" aria-label={t('提示词')}>
                        {entry.prompt.trim() || t('未记录提示词')}
                      </p>
                      {deleteTarget === entry.id ? (
                        <div className="shrink-0 space-y-2 text-xs text-canvas-text-secondary">
                          <p>{t(hasLocalFile(entry)
                            ? '本地文件将移入系统回收站，并删除本条历史；文件已丢失时仅清理记录。'
                            : '此记录只有媒体链接，删除记录不会删除服务器上的文件。')}</p>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" disabled={deleting || applyingId !== null}
                              onClick={() => void handleDelete(entry, true)}>{t(deleting ? '正在删除…' : hasLocalFile(entry) ? '确认删除文件' : '确认删除记录')}</button>
                            <button type="button" className="ui-btn ui-btn--sm" disabled={deleting || applyingId !== null}
                              onClick={() => void handleDelete(entry, false)}>{t('仅删除记录')}</button>
                            <button type="button" className="ui-btn ui-btn--sm" disabled={deleting}
                              onClick={() => setDeleteTarget(null)}>{t('取消')}</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <button type="button" className={`ui-btn ui-btn--sm${current ? ' is-active' : ' ui-btn--primary'}`}
                            disabled={current || deleting || applyingId !== null || nodeLoading}
                            onClick={() => void handleApply(entry)}>
                            <Icon icon={applyingId === entry.id ? 'mdi:loading' : current ? 'mdi:check' : 'mdi:image-check-outline'}
                              width={14} aria-hidden="true" className={applyingId === entry.id ? 'animate-spin' : undefined} />
                            {t(current ? '当前使用' : applyingId === entry.id ? '处理中…' : '应用')}
                          </button>
                          <button type="button" className="ui-btn ui-btn--sm ui-btn--danger" disabled={deleting || applyingId !== null}
                            onClick={() => setDeleteTarget(entry.id)}>
                            <Icon icon="mdi:trash-can-outline" width={14} aria-hidden="true" />
                            {t(hasLocalFile(entry) ? '删除文件及记录' : '删除记录')}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </ModalOverlay>}

      {preview && (
        <FullscreenOverlay
          isOpen={isOpen}
          onClose={() => setPreview(null)}
          hidePanel
          className="fullscreen-overlay--image-preview"
        >
          <ZoomableImage
            src={preview.src}
            alt={preview.alt}
            className="fullscreen-img-view"
            onClose={() => setPreview(null)}
            onError={() => setPreview(null)}
          />
        </FullscreenOverlay>
      )}
    </>,
    document.body,
  );
}
