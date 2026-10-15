import { memo, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { ComfyRuntimeLine, ComfyRuntimeSnapshot, ComfyRuntimeStatus } from '../../types/comfyRuntime';

const STATUS_LABELS: Record<ComfyRuntimeStatus, string> = {
  idle: '未启动', starting: '正在启动', running: '端口已响应',
  exited: '已停止', failed: '启动或运行失败', external: '外部服务或启动器',
};
const STATUS_CLASSES: Record<ComfyRuntimeStatus, string> = {
  idle: 'ui-badge--outline', starting: 'ui-badge--info', running: 'ui-badge--success',
  exited: 'ui-badge--outline', failed: 'ui-badge--danger', external: 'ui-badge--warning',
};
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function lineClass(line: ComfyRuntimeLine): string {
  if (/\b(error|exception|traceback)\b|\bimport failed\b/i.test(line.text)) return 'text-danger-light';
  if (/\b(warning|warn)\b/i.test(line.text)) return 'text-warning-light';
  return line.stream === 'system' ? 'text-info-light' : 'text-canvas-text';
}

const OutputLine = memo(function OutputLine({ line }: { line: ComfyRuntimeLine }) {
  return <div className="flex items-start gap-2">
    <time className="shrink-0 text-canvas-text-muted tabular-nums" dateTime={new Date(line.timestamp).toISOString()}>{TIME_FORMAT.format(line.timestamp)}</time>
    <span className="w-12 shrink-0 text-canvas-text-muted">{line.stream === 'stdout' ? 'STDOUT' : line.stream === 'stderr' ? 'STDERR' : 'SYS'}</span>
    <span className={`min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${lineClass(line)}`}>{line.text || '\u00a0'}</span>
  </div>;
});

interface Props {
  runtime: ComfyRuntimeSnapshot | null;
  error: string;
  busy: boolean;
  onRetry: () => void;
  onClear: () => void;
  onStop: (runId: string) => void;
}

export default function ComfyRuntimeConsole({ runtime, error, busy, onRetry, onClear, onStop }: Props) {
  const t = useT();
  const [following, setFollowing] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const status = runtime?.status ?? 'idle';
  const canStop = !!runtime?.runId && (status === 'starting' || status === 'running');
  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [following, runtime?.lines]);

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" aria-label={t('ComfyUI 运行控制台')}>
    <div className="ui-row ui-row--between shrink-0">
      <div className="ui-row min-w-0">
        <h2 className="text-sm font-semibold">{t('运行输出')}</h2>
        <span className={`ui-badge ${STATUS_CLASSES[status]}`} role="status"><span className="ui-badge__dot" />{t(STATUS_LABELS[status])}</span>
        {!!runtime && <span className="font-mono text-xs text-canvas-text-muted">127.0.0.1:{runtime.port}</span>}
        {runtime?.exitCode != null && <span className="ui-hint">{t('退出码：{code}', { code: runtime.exitCode })}</span>}
      </div>
      <div className="ui-row">
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" aria-pressed={following} onClick={() => setFollowing((value) => !value)}><Icon icon={following ? 'lucide:arrow-down-to-line' : 'lucide:pause'} width={14} />{following ? t('自动跟随') : t('已暂停跟随')}</button>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!runtime?.lines.length} title={t('仅清空当前显示，重新打开窗口可读取保留的最近输出')} onClick={onClear}><Icon icon="lucide:eraser" width={14} />{t('清空显示')}</button>
        <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={busy || !canStop} onClick={() => { if (runtime?.runId) onStop(runtime.runId); }}><Icon icon="lucide:square" width={14} />{t('停止服务')}</button>
      </div>
    </div>
    {error && <div className="ui-alert ui-alert--danger shrink-0" role="alert"><p className="ui-alert__body break-words">{error}</p><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={onRetry}>{t('重试')}</button></div>}
    {runtime?.message && <p className="ui-hint shrink-0" role="status">{runtime.message}</p>}
    {runtime?.truncated && <p className="ui-hint shrink-0">{t('仅保留最近的输出，较早内容已省略。')}</p>}
    <div ref={viewport} role="region" aria-label={t('ComfyUI 命令行输出')} tabIndex={0}
      className="min-h-0 min-w-0 flex-1 rounded-lg border border-canvas-border bg-canvas-bg p-3 ui-scroll ui-scroll--both select-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand"
      onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
      }}>
      {runtime?.lines.length ? <div className="font-mono text-xs leading-relaxed">{runtime.lines.map((line) => <OutputLine key={`${runtime.runId}:${line.sequence}`} line={line} />)}</div> : <div className="ui-empty h-full"><Icon icon="lucide:terminal" width={28} className="ui-empty__icon" /><p className="ui-empty__title">{runtime ? t('暂无运行输出') : t('正在读取运行状态…')}</p><p className="ui-empty__desc">{status === 'external' ? t('外部启动的服务无法读取其已有终端输出。') : t('点击右上角“启动 ComfyUI”，在这里查看启动和运行过程。')}</p></div>}
    </div>
    <p className="ui-hint shrink-0">{t('输出仅在内存中保留；关闭此窗口不停止服务。退出整个应用会停止由本应用直接启动的服务。')}</p>
  </section>;
}
