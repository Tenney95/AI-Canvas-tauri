import { useCallback, useEffect, useMemo, useState } from 'react';
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

function HistoryImage({
  entry,
  onPreview,
}: {
  entry: HistoryRecord;
  onPreview: (preview: PreviewImage) => void;
}) {
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
      <div className="flex aspect-[4/3] items-center justify-center bg-canvas-bg text-canvas-text-muted">
        <Icon icon="mdi:image-off-outline" width={24} height={24} aria-hidden="true" />
      </div>
    );
  }

  const alt = entry.prompt.trim() || '历史生成图片';

  return (
    <button
      type="button"
      className="group relative block aspect-[4/3] w-full overflow-hidden bg-canvas-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-400/70"
      aria-label="放大查看历史图片"
      onClick={() => onPreview({ src, alt })}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transform-none"
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
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [recordsProjectId, setRecordsProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadRevision, setLoadRevision] = useState(0);
  const [preview, setPreview] = useState<PreviewImage | null>(null);

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
          setError('生成历史加载失败');
        }
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [currentProjectId, isOpen, loadRevision, nodeId]);

  const imageRecords = useMemo(() => (
    recordsProjectId === currentProjectId
      ? records.filter((entry) => (
          entry.nodeType === 'ai-image'
          && entry.status === 'success'
          && Boolean(entry.filePath || entry.mediaUrl || entry.output)
        ))
      : []
  ), [currentProjectId, records, recordsProjectId]);

  const handleClose = useCallback(() => {
    setPreview(null);
    onClose();
  }, [onClose]);

  return createPortal(
    <>
      <ModalOverlay
        isOpen={isOpen && preview === null}
        onClose={handleClose}
        ariaLabel="图片生成历史"
        className="max-h-[82vh] w-[min(94vw,880px)] rounded-lg border-canvas-border bg-canvas-surface"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-canvas-border px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-green-500/10 text-green-400">
            <Icon icon="mdi:history" width={18} height={18} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-canvas-text">生成历史</h2>
            <p className="text-[11px] text-canvas-text-muted">
              {loading ? '正在加载...' : `${imageRecords.length} 张图片`}
            </p>
          </div>
          <PopupCloseButton onClick={handleClose} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-xs text-canvas-text-muted">
              <Icon icon="mdi:loading" width={18} height={18} className="animate-spin" aria-hidden="true" />
              <span>正在加载生成历史</span>
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
                重试
              </button>
            </div>
          ) : imageRecords.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-canvas-text-muted">
              <Icon icon="mdi:image-multiple-outline" width={32} height={32} aria-hidden="true" />
              <p className="text-xs">这个节点还没有生成过图片</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {imageRecords.map((entry) => (
                <article
                  key={entry.id}
                  className="overflow-hidden rounded-lg border border-canvas-border bg-canvas-card"
                >
                  <HistoryImage entry={entry} onPreview={setPreview} />
                  <div className="space-y-2.5 p-3">
                    <div className="flex min-w-0 items-center gap-2 text-[11px]">
                      <span className="min-w-0 truncate rounded bg-canvas-hover px-2 py-1 text-canvas-text-secondary">
                        {[entry.provider, entry.model].filter(Boolean).join(' / ') || '未记录模型'}
                      </span>
                      <time className="ml-auto shrink-0 text-canvas-text-muted" dateTime={new Date(entry.timestamp).toISOString()}>
                        {DATE_FORMATTER.format(entry.timestamp)}
                      </time>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-5 text-canvas-text-secondary">
                      {entry.prompt.trim() || '未记录提示词'}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </ModalOverlay>

      {preview && (
        <FullscreenOverlay
          isOpen={isOpen}
          onClose={() => setPreview(null)}
          hidePanel
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
