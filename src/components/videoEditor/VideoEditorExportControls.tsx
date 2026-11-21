import { Icon } from '@iconify/react';
import { useCallback } from 'react';
import { useT } from '../../i18n';
import type { VideoEditorSourceProbe } from '../../types/videoEditor';
import type { EditorFailure, ExportDestination } from './videoEditorExport';

/** 把失败详情摊在界面上并支持一键复制——这个窗口开不了 devtools */
export function FailureReport({ failure, fallback, copyDetailsLabel, stackLabel, failedSuffix }: {
  failure: EditorFailure | null;
  fallback: string;
  copyDetailsLabel: string;
  stackLabel: string;
  failedSuffix: string;
}) {
  const t = useT();
  if (!failure) return <span>{fallback}</span>;

  const full = `[${failure.stage}] ${failure.message}\n${failure.detail}`;
  return (
    <div className="video-editor-failure">
      <div className="video-editor-failure-line">
        <strong>{t(failure.stage)}{failedSuffix}</strong>{failure.message}
        <button
          type="button"
          className="video-editor-failure-copy"
          onClick={() => { void navigator.clipboard?.writeText(full).catch(() => {}); }}
        >
          {copyDetailsLabel}
        </button>
      </div>
      {failure.detail && failure.detail !== failure.message && (
        <details className="video-editor-failure-detail">
          <summary>{stackLabel}</summary>
          <pre>{failure.detail}</pre>
        </details>
      )}
    </div>
  );
}

interface ExportControlsProps {
  projectName?: string;
  probe: Pick<VideoEditorSourceProbe, 'width' | 'height'> | null;
  clipCount: number;
  timelineDuration: number;
  ready: boolean;
  exporting: boolean;
  exportingFrame: boolean;
  exportStage: string | null;
  exportProgress: number;
  onCancel: () => void;
  onExport: (destination: ExportDestination) => Promise<void>;
  onExportFrame: () => Promise<void>;
}

export function VideoEditorExportControls({
  projectName, probe, clipCount, timelineDuration, ready, exporting, exportingFrame,
  exportStage, exportProgress, onCancel, onExport, onExportFrame,
}: ExportControlsProps) {
  const t = useT();
  const closeWindow = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }, []);

  const minimizeWindow = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }, []);

  return (
    <header className="video-editor-header" data-tauri-drag-region>
      <h1 className="video-editor-title">{projectName || t('视频编辑器')}</h1>
      {probe && (
        <span className="video-editor-meta">
          {probe.width}×{probe.height} · {clipCount}{t('个片段')} ·{' '}
          {timelineDuration.toFixed(2)}s
        </span>
      )}
      <div className="video-editor-winctrls">
        {exporting ? (
          <>
            <span className="video-editor-progress">
              {exportStage ?? t('导出中')} {Math.round(exportProgress * 100)}%
            </span>
            <button
              type="button"
              className="video-editor-btn"
              onClick={onCancel}
            >
              {t('取消')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="video-editor-btn"
              onClick={() => { void onExportFrame(); }}
              disabled={!ready || clipCount === 0 || exportingFrame}
              title={t('把播放头所在的画面导出为画布图片节点')}
            >
              <Icon icon="lucide:image-down" width={13} height={13} />
              {exportingFrame ? t('导出当前帧…') : t('导出当前帧')}
            </button>
            <button
              type="button"
              className="video-editor-btn"
              onClick={() => { void onExport('local'); }}
              disabled={!ready || clipCount === 0 || exportingFrame}
            >
              <Icon icon="lucide:download" width={13} height={13} />
              {t('导出到本地')}
            </button>
            <button
              type="button"
              className="video-editor-btn primary"
              onClick={() => { void onExport('canvas'); }}
              disabled={!ready || clipCount === 0 || exportingFrame}
            >
              <Icon icon="lucide:upload" width={13} height={13} />
              {t('导出为新节点')}
            </button>
          </>
        )}
        <button
          type="button"
          className="video-editor-winbtn"
          onClick={() => { void minimizeWindow(); }}
          aria-label={t('最小化')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="video-editor-winbtn close"
          onClick={() => { void closeWindow(); }}
          aria-label={t('关闭')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </header>
  );
}
