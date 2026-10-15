import { useT } from '../../i18n';
import { formatSize } from '../../utils/assetFormat';

interface DownloadProgressProps {
  downloadedBytes: number;
  totalBytes?: number;
  label?: string;
  className?: string;
}

export default function DownloadProgress({
  downloadedBytes, totalBytes, label, className = '',
}: DownloadProgressProps) {
  const t = useT();
  const downloaded = Number.isFinite(downloadedBytes) ? Math.max(0, downloadedBytes) : 0;
  const total = totalBytes !== undefined && Number.isFinite(totalBytes) && totalBytes > 0 && totalBytes >= downloaded
    ? totalBytes : undefined;
  const percent = total !== undefined ? Math.min(100, downloaded / total * 100) : undefined;
  const progressText = percent === undefined ? t('总大小未知') : `${Math.floor(percent)}%`;
  const sizeText = total === undefined
    ? t('已下载 {size}', { size: formatSize(downloaded) })
    : `${formatSize(downloaded)} / ${formatSize(total)}`;

  return <div className={`min-w-0 space-y-2 text-xs ${className}`}>
    <div className="flex min-w-0 items-center justify-between gap-2 text-canvas-text-secondary">
      <span className="min-w-0 truncate">{label || t('正在下载…')}</span>
      <span className="shrink-0 tabular-nums">{progressText}</span>
    </div>
    <div
      className={`ui-progress${percent === undefined ? ' ui-progress--indeterminate' : ''}`}
      role="progressbar"
      aria-label={label || t('下载进度')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${progressText}，${sizeText}`}
    >
      <div className="ui-progress__bar" style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>
    <p className="text-canvas-text-muted tabular-nums">{sizeText}</p>
  </div>;
}
