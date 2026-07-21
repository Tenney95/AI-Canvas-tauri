import { Icon } from '@iconify/react';
import { createPortal } from 'react-dom';
import ModalOverlay from '../shared/ModalOverlay';

export type DirectorDeskDialogPhase = 'prompt' | 'downloading' | 'error';

interface DirectorDeskDownloadDialogProps {
  phase: DirectorDeskDialogPhase;
  version: string;
  progress: number;
  stageText: string;
  error: string | null;
  cancelling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

export default function DirectorDeskDownloadDialog({
  phase,
  version,
  progress,
  stageText,
  error,
  cancelling,
  onConfirm,
  onCancel,
  onRetry,
}: DirectorDeskDownloadDialogProps) {
  const isDownloading = phase === 'downloading';

  return createPortal(
    <ModalOverlay
      isOpen
      onClose={isDownloading ? () => {} : onCancel}
      ariaLabel="下载 3D 导演台"
      className="w-[min(420px,calc(100vw-32px))]"
      closeOnBackdrop={!isDownloading}
      motionPreset="quick"
    >
      <div className="p-5">
        <div className="mb-4 flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-violet-500/15 text-violet-400">
            <Icon icon="mdi:video-3d" width="22" height="22" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-canvas-text">
              {phase === 'error' ? '3D 导演台下载失败' : '下载 3D 导演台'}
            </h2>
            <p className="mt-1 text-xs leading-5 text-canvas-text-secondary">
              {phase === 'prompt'
                ? `首次使用需要下载 v${version} 运行资源，下载约 54 MB，安装后约占 82 MB。`
                : phase === 'error'
                  ? error
                  : stageText}
            </p>
          </div>
        </div>

        {isDownloading && (
          <div className="mb-4" role="status" aria-live="polite">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-canvas-text-muted">
              <span>{stageText}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-canvas-hover">
              <div
                className="h-full rounded-full bg-violet-500 transition-[width] duration-200"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg bg-canvas-hover px-3 py-2 text-xs text-canvas-text-secondary transition-colors hover:bg-canvas-border disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onCancel}
            disabled={cancelling}
          >
            {isDownloading ? (cancelling ? '正在取消...' : '取消下载') : '取消'}
          </button>
          {phase === 'prompt' && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500"
              onClick={onConfirm}
            >
              <Icon icon="lucide:download" width="14" height="14" />
              下载并打开
            </button>
          )}
          {phase === 'error' && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500"
              onClick={onRetry}
            >
              <Icon icon="lucide:rotate-cw" width="14" height="14" />
              重试
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>,
    document.body,
  );
}
