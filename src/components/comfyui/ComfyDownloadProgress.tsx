import { useT } from '../../i18n';
import type { ComfyDownloadProgress as Progress } from '../../types/comfyManagement';
import DownloadProgress from '../shared/DownloadProgress';

const LABELS = {
  connecting: '正在连接仓库…',
  counting: '正在统计对象…',
  compressing: '正在压缩对象…',
  receiving: '正在下载对象…',
  resolving: '正在处理对象…',
  catalog: '正在下载插件目录…',
  applying: '正在应用更新…',
} as const;

export default function ComfyDownloadProgress({ progress }: { progress: Progress }) {
  const t = useT();
  const label = t(LABELS[progress.stage]);
  if (progress.unit === 'bytes') return <DownloadProgress
    label={label} downloadedBytes={progress.completed} totalBytes={progress.total ?? undefined}
  />;
  const total = progress.total && progress.total > 0 ? progress.total : undefined;
  const percent = total === undefined ? undefined : Math.min(100, progress.completed / total * 100);
  return <div className="space-y-2 text-xs text-canvas-text-secondary">
    <div className="flex flex-wrap justify-between gap-2"><span>{label}</span>
      {percent !== undefined && <span className="tabular-nums">{Math.floor(percent)}% · {progress.completed} / {total} {t('个对象')}</span>}
    </div>
    <div className={`ui-progress${percent === undefined ? ' ui-progress--indeterminate' : ''}`}
      role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="ui-progress__bar" style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </div>
  </div>;
}
