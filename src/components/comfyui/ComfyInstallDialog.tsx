import { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import { formatSize } from '../../utils/assetFormat';
import { cancelComfyInstall, chooseComfyInstallTarget, getComfyInstallInfo, installComfyPortable } from '../../services/comfyInstallService';
import type { ComfyInstallInfo, ComfyInstallProgress, ComfyInstallResult, ComfyInstallTarget } from '../../types/comfyInstall';
import DownloadProgress from '../shared/DownloadProgress';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

const STAGES: Record<ComfyInstallProgress['stage'], string> = {
  connecting: '正在连接下载源…', downloading: '正在下载官方安装包…',
  verifying: '正在校验官方 SHA-256…', extracting: '正在解压 Python 和 ComfyUI 环境…',
  checking: '正在检测 Python、PyTorch 和前端依赖…', committing: '正在保存安装目录和启动设置…',
};
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Props {
  onClose: () => void;
  onInstalled: (path: string) => Promise<void>;
  onLaunch: () => void;
}

export default function ComfyInstallDialog({ onClose, onInstalled, onLaunch }: Props) {
  const t = useT();
  const [info, setInfo] = useState<ComfyInstallInfo | null>(null);
  const [variantId, setVariantId] = useState('');
  const [folderName, setFolderName] = useState('ComfyUI');
  const [target, setTarget] = useState<ComfyInstallTarget | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ComfyInstallProgress | null>(null);
  const [result, setResult] = useState<ComfyInstallResult | null>(null);
  const [autoStart, setAutoStart] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const selectingRef = useRef(false);
  const targetIdRef = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    alive.current = true;
    void getComfyInstallInfo().then((next) => {
      if (!active) return;
      setInfo(next); setVariantId(next.variants[0]?.id ?? ''); setError('');
    }, (cause: unknown) => { if (active) setError(reason(cause)); });
    return () => {
      active = false;
      alive.current = false;
      if (targetIdRef.current) void cancelComfyInstall(targetIdRef.current).catch(() => {});
    };
  }, [reload]);
  const close = () => {
    if (busyRef.current || selectingRef.current) return;
    void cancelComfyInstall(targetIdRef.current).catch(() => {});
    onClose();
  };
  const choose = async () => {
    if (busyRef.current || selectingRef.current) return;
    selectingRef.current = true;
    setSelecting(true); setError('');
    try {
      const next = await chooseComfyInstallTarget(folderName.trim());
      if (next) {
        if (alive.current) { setTarget(next); targetIdRef.current = next.targetId; }
        else void cancelComfyInstall(next.targetId).catch(() => {});
      }
    } catch (cause) { if (alive.current) setError(reason(cause)); }
    finally { selectingRef.current = false; if (alive.current) setSelecting(false); }
  };
  const install = async () => {
    if (busyRef.current || selectingRef.current || !target || !variantId) return;
    busyRef.current = true;
    setBusy(true); setCancelling(false); setError(''); setProgress(null);
    try {
      const installed = await installComfyPortable(target.targetId, variantId, (next) => { if (alive.current) setProgress(next); });
      if (!alive.current) return;
      setResult(installed);
      await onInstalled(installed.path);
      if (!alive.current) return;
      if (autoStart && !installed.warning) {
        busyRef.current = false;
        setBusy(false);
        onLaunch();
      }
    } catch (cause) {
      if (alive.current) { setError(reason(cause)); setTarget(null); }
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setCancelling(false); }
    }
  };
  const cancel = async () => {
    setCancelling(true);
    try { await cancelComfyInstall(targetIdRef.current); }
    catch (cause) { if (alive.current) { setError(reason(cause)); setCancelling(false); } }
  };
  const variant = info?.variants.find((entry) => entry.id === variantId);
  const phase = progress ? t(STAGES[progress.stage]) : t('准备安装…');
  const byteProgress = progress && ['downloading', 'verifying', 'extracting'].includes(progress.stage);

  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={!busy && !selecting}
    ariaLabel={t('安装官方 ComfyUI')} zIndex={280}
    className="flex max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-xl flex-col bg-canvas-surface">
    <header className="ui-row ui-row--between shrink-0 border-b border-canvas-border p-3">
      <div className="ui-row"><Icon icon="lucide:package-plus" width={18} /><h2 className="text-sm font-semibold">{t('安装官方 ComfyUI')}</h2>{info && <span className="ui-badge ui-badge--outline">{info.version}</span>}</div>
      <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" disabled={busy || selecting} aria-label={t('关闭')} onClick={close}><Icon icon="lucide:x" width={16} /></button>
    </header>
    <div className="min-h-0 flex-1 space-y-3 p-3 ui-scroll">
      {error && <div className="ui-alert ui-alert--danger" role="alert"><p className="ui-alert__body break-words">{error}</p>{!info && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setReload((value) => value + 1)}>{t('重试')}</button>}</div>}
      {!info && !error && <p className="ui-hint" role="status">{t('正在读取官方安装选项…')}</p>}
      {info && !info.supported && <div className="ui-alert ui-alert--info">{t('一键安装支持 Windows x64 / ARM64。其他系统请按 ComfyUI 官方文档安装，再通过“更换”选择安装目录。')}</div>}
      {info?.supported && !result && <>
        <div className="ui-alert ui-alert--info"><Icon icon="lucide:info" width={16} className="ui-alert__icon" /><p className="ui-alert__body">{t('下载 GitHub 官方便携版，包含 ComfyUI、独立 Python、PyTorch 和前端依赖。不会修改系统 Python 或覆盖已有安装。')}</p></div>
        <div className="ui-field"><label className="ui-label" htmlFor="comfy-install-variant">{t('运行环境')}</label>
          <Select id="comfy-install-variant" fixedMenu value={variantId} disabled={busy || selecting} onChange={setVariantId}
            options={info.variants.map((entry) => ({ value: entry.id, label: t(entry.label) }))} />
          <p className="ui-hint">{variant ? t('预计下载 {size}，解压还需要额外磁盘空间。', { size: formatSize(variant.bytes) }) : ''}</p>
        </div>
        <div className="ui-field"><label className="ui-label" htmlFor="comfy-install-name">{t('新建文件夹名称')}</label>
          <input id="comfy-install-name" className="ui-input ui-input--sm" value={folderName} maxLength={120} disabled={busy || selecting}
            onChange={(event) => { setFolderName(event.target.value); setTarget(null); }} />
        </div>
        <div className="ui-field"><span className="ui-label">{t('安装位置')}</span><div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1 rounded-md border border-canvas-border bg-canvas-bg p-2 font-mono text-xs text-canvas-text-secondary break-all select-text">{target?.displayPath || t('选择位置后将在其下新建上述文件夹')}</div>
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" disabled={busy || selecting || !folderName.trim()} onClick={() => void choose()}><Icon icon="lucide:folder-open" width={14} />{selecting ? t('选择中…') : t('选择位置')}</button>
        </div></div>
        <label className="ui-row text-xs"><input className="accent-brand" type="checkbox" checked={autoStart} disabled={busy} onChange={(event) => setAutoStart(event.target.checked)} />{t('安装完成后启动 ComfyUI')}</label>
        <p className="ui-hint">{t('优先从 GitHub 下载；连接或读取超时后自动切换国内加速源，并校验相同的官方 SHA-256。显卡需有兼容驱动，模型和第三方插件按需安装。')}</p>
      </>}
      {busy && <div className="ui-card space-y-2 p-3" role="status">
        <p className="ui-row text-xs"><Icon icon="lucide:loader-circle" width={14} className="animate-spin" />{cancelling ? t('正在取消并清理临时文件…') : phase}</p>
        {progress && <p className="ui-hint">{progress.source === 'mirror' ? t('当前下载源：国内加速（GitHub 连接或读取失败后切换）') : t('当前下载源：GitHub 官方')}</p>}
        {byteProgress && progress && <DownloadProgress label={phase} downloadedBytes={progress.completed} totalBytes={progress.total ?? undefined} />}
        <p className="ui-hint">{t('安装期间请保持应用开启；取消后原有安装与选择会保留。')}</p>
      </div>}
      {result && <div className="space-y-3"><div className="ui-alert ui-alert--success">{t('官方 ComfyUI 已安装，目录已记住。')}</div>
        <p className="text-xs font-mono break-all select-text">{result.path}</p>
        {result.warning && <div className="ui-alert ui-alert--warning">{result.warning}</div>}
      </div>}
    </div>
    <footer className="ui-row justify-end shrink-0 border-t border-canvas-border p-3">
      {busy ? <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={cancelling || progress?.stage === 'committing'} onClick={() => void cancel()}>{cancelling ? t('正在取消…') : t('取消安装')}</button>
        : result ? <><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={close}>{t('完成')}</button><button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!!error} onClick={onLaunch}><Icon icon="lucide:play" width={14} />{t('启动 ComfyUI')}</button></>
          : <><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={selecting} onClick={close}>{t('取消')}</button><button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!info?.supported || !variant || !target || selecting} onClick={() => void install()}><Icon icon="lucide:download" width={14} />{t('开始安装')}</button></>}
    </footer>
  </ModalOverlay>;
}
