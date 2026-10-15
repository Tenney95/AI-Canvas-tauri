import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import {
  applyComfyModelDeduplication, applyComfyModelDeduplicationBatch, cancelComfyModelScan, chooseComfyModelScanRoot, listComfyModelDedupeRecoveries,
  recoverComfyModelDedupe, scanComfyDuplicateModels,
} from '../../services/comfyModelDedupeService';
import type {
  ComfyModelDedupeBatchRequest, ComfyModelDedupeGroupSelection, ComfyModelDedupeProgress, ComfyModelDedupeRecovery, ComfyModelDedupeRequest,
  ComfyModelDedupeResult, ComfyModelDedupeScan, ComfyModelScanRoot, ComfyModelScanRootKind, ComfyModelScanScope,
} from '../../types/comfyModelDedupe';
import { formatSize } from '../../utils/assetFormat';
import { defaultComfyModelSelection, selectedComfyModelGroups } from '../../utils/comfyModelDedupeSelection';
import Select from '../shared/Select';
import ComfyModelDedupeGroup from './ComfyModelDedupeGroup';
import ComfyModelDedupeActions from './ComfyModelDedupeActions';
import ComfyModelDedupeHistoryDialog from './ComfyModelDedupeHistory';

interface Props {
  busy: boolean;
  run: (label: string, operation: () => Promise<string>) => Promise<boolean>;
}

export default function ComfyModelDedupe({ busy, run }: Props) {
  const t = useT();
  const [scope, setScope] = useState<ComfyModelScanScope>('modelsAndPlugins');
  const [roots, setRoots] = useState<Partial<Record<ComfyModelScanRootKind, ComfyModelScanRoot>>>({});
  const [scan, setScan] = useState<ComfyModelDedupeScan | null>(null);
  const [selections, setSelections] = useState<Record<string, ComfyModelDedupeGroupSelection>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [progress, setProgress] = useState<ComfyModelDedupeProgress | null>(null);
  const [recoveries, setRecoveries] = useState<ComfyModelDedupeRecovery[]>([]);
  const [checkingRecoveries, setCheckingRecoveries] = useState(true);
  const [recoveryError, setRecoveryError] = useState('');
  const [result, setResult] = useState<ComfyModelDedupeResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(20);
  const alive = useRef(true);
  const scanRunning = useRef(false);
  const cancelRequested = useRef(false);
  const externalScope = scope === 'folder' || scope === 'disk' ? scope : null;
  const scanRoot = externalScope ? roots[externalScope] : undefined;

  const refreshRecoveries = useCallback(() => listComfyModelDedupeRecoveries()
    .then((next) => {
      if (alive.current) { setRecoveries(next); setRecoveryError(''); }
    }).catch((error: unknown) => {
      if (alive.current) setRecoveryError(String(error));
    }).finally(() => { if (alive.current) setCheckingRecoveries(false); }), []);

  useEffect(() => {
    alive.current = true;
    void refreshRecoveries();
    return () => {
      alive.current = false;
      if (scanRunning.current) void cancelComfyModelScan().catch(() => {});
    };
  }, [refreshRecoveries]);

  const changeScope = (value: ComfyModelScanScope) => void run(t('切换扫描范围'), async () => {
    await cancelComfyModelScan();
    if (alive.current) { setScope(value); setScan(null); setResult(null); setSearch(''); }
    return '';
  });

  const chooseRoot = () => {
    if (!externalScope) return;
    void run(externalScope === 'disk' ? t('选择磁盘') : t('选择文件夹'), async () => {
      const selected = await chooseComfyModelScanRoot(externalScope);
      if (selected && alive.current) {
        setRoots((current) => ({ ...current, [selected.kind]: selected }));
        setScan(null); setResult(null); setSearch('');
        setCheckingRecoveries(true);
        await refreshRecoveries();
      }
      return '';
    });
  };

  const startScan = () => void run(t('扫描重复模型'), async () => {
    if (externalScope && !scanRoot) throw new Error(t('请先选择需要扫描的磁盘或文件夹'));
    scanRunning.current = true;
    cancelRequested.current = false;
    setScanning(true); setStopping(false); setProgress(null); setScan(null); setResult(null); setLimit(20);
    try {
      const next = await scanComfyDuplicateModels(scope, (value) => {
        if (alive.current && !cancelRequested.current) setProgress(value);
      }, scanRoot?.rootId);
      if (alive.current && !cancelRequested.current) {
        setScan(next);
        setSelections(Object.fromEntries(next.groups.map((group) => [group.id, defaultComfyModelSelection(group)])));
      }
      return cancelRequested.current ? t('扫描已取消，未修改模型文件') : '';
    } catch (error) {
      if (cancelRequested.current) return t('扫描已取消，未修改模型文件');
      if (alive.current) { setScanning(false); setProgress(null); }
      setCheckingRecoveries(true);
      await refreshRecoveries();
      throw error;
    } finally {
      scanRunning.current = false;
      if (alive.current) { setScanning(false); setStopping(false); setProgress(null); }
    }
  });

  const stopScan = async () => {
    cancelRequested.current = true;
    setStopping(true);
    try { await cancelComfyModelScan(); } catch (error) {
      if (alive.current) { setStopping(false); setRecoveryError(String(error)); }
    }
  };

  const apply = (request: ComfyModelDedupeRequest) => void run(t('复核并替换模型链接'), async () => {
    setScan(null); setResult(null);
    try {
      const next = await applyComfyModelDeduplication(request);
      if (alive.current) setResult(next);
      return next.failed || next.unprocessed || next.warnings.length ? '' : next.message;
    } finally { setCheckingRecoveries(true); await refreshRecoveries(); }
  });

  const applyAll = (request: ComfyModelDedupeBatchRequest) => void run(t('复核并替换全部模型链接'), async () => {
    setScan(null); setResult(null); setSelections({});
    try {
      const next = await applyComfyModelDeduplicationBatch(request);
      if (alive.current) setResult(next);
      return next.failed || next.unprocessed || next.warnings.length ? '' : next.message;
    } finally { setCheckingRecoveries(true); await refreshRecoveries(); }
  });

  const recover = (id: string) => void run(t('恢复中断的模型操作'), async () => {
    setScan(null); setResult(null);
    try {
      const next = await recoverComfyModelDedupe(id);
      if (alive.current) setResult(next);
      return next.message;
    } finally { setCheckingRecoveries(true); await refreshRecoveries(); }
  });

  const filteredGroups = scan?.groups.filter((group) => group.files.some((file) => file.relativePath.toLowerCase().includes(search.trim().toLowerCase()))) ?? [];
  const reclaimable = scan?.groups.reduce((sum, group) => sum + group.reclaimableBytes, 0) ?? 0;
  const selectedGroups = selectedComfyModelGroups(scan?.groups ?? [], selections);
  const progressText = progress?.stage === 'collecting' ? t('收集模型文件') : t('校验完整文件内容');

  return <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="ui-card shrink-0 p-3 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select<ComfyModelScanScope> value={scope} size="sm" fixedMenu disabled={busy || checkingRecoveries} onChange={changeScope} aria-label={t('模型扫描范围')} className="w-64 max-w-full"
          options={[{ value: 'modelsAndPlugins', label: t('模型目录 + 插件内模型') }, { value: 'models', label: t('仅模型目录') }, { value: 'disk', label: t('整个磁盘') }, { value: 'folder', label: t('指定文件夹') }]} />
        {externalScope && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || checkingRecoveries} onClick={chooseRoot}><Icon icon={externalScope === 'disk' ? 'lucide:hard-drive' : 'lucide:folder-open'} width={14} />{externalScope === 'disk' ? t('选择磁盘根目录') : t('选择文件夹')}</button>}
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || checkingRecoveries || !!recoveries.length || !!recoveryError || (!!externalScope && !scanRoot)} onClick={startScan}><Icon icon="lucide:scan-search" width={14} />{t('扫描重复模型')}</button>
        {scanning && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={stopping} onClick={() => void stopScan()}>{stopping ? t('正在停止…') : t('取消扫描')}</button>}
        {scan && <span className="ui-hint ml-auto">{scan.engine}</span>}
      </div>
      {checkingRecoveries && <p className="ui-hint ui-row" role="status"><Icon icon="lucide:loader-circle" width={14} className="animate-spin" />{t('正在检查恢复记录，大范围目录可能需要一些时间…')}</p>}
      {externalScope && <p className="ui-hint break-all"><span>{t('扫描根目录：')}</span><span className="font-mono select-text">{scanRoot?.displayPath ?? (externalScope === 'disk' ? t('请选择磁盘根目录，如 D:\\') : t('请选择需要扫描的文件夹'))}</span></p>}
      <p className="ui-hint">{t('扫描所选范围内大于等于 1 MB 的模型文件；跳过链接、系统、环境和应用私有目录。按完整内容分组，文件名不同也能识别；扫描不会修改文件。')}</p>
      <p className="ui-hint">{t('不同名称会保留各自原路径和扩展名。硬链接只适用于同一磁盘；软链接需要系统权限，且保留副本不能随意移动。')}</p>
      {externalScope && <p className="ui-hint">{t('磁盘扫描可能耗时较长，可随时取消。外部目录若有中断记录，重新打开窗口后选择原磁盘或文件夹即可恢复。')}</p>}
    </div>

    {scanning && <div className="ui-card shrink-0 p-3 gap-2" role="status" aria-live="polite">
      <div className="ui-row ui-row--between text-xs"><span>{stopping ? t('正在停止扫描…') : progressText}</span>{progress && <span className="tabular-nums">{progress.unit === 'bytes' ? formatSize(progress.completed) : t('{count} 个文件', { count: progress.completed })}{progress.total ? ` / ${progress.unit === 'bytes' ? formatSize(progress.total) : progress.total}` : ''}</span>}</div>
      {!!progress?.total && <progress className="h-1.5 w-full accent-brand" value={progress.completed} max={Math.max(progress.total, progress.completed)} aria-label={progressText} />}
    </div>}

    {recoveryError && <div className="ui-alert ui-alert--danger shrink-0" role="alert"><div className="ui-alert__body"><p>{recoveryError}</p><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm mt-2" disabled={busy || checkingRecoveries} onClick={() => { setCheckingRecoveries(true); void refreshRecoveries(); }}>{t('重新读取恢复记录')}</button></div></div>}
    {!!recoveries.length && <div className="ui-alert ui-alert--warning shrink-0"><div className="ui-alert__body w-full space-y-2">
      <p>{t('发现上次未完成的模型替换，请先恢复原文件，再重新扫描。')}</p>
      <ul className="ui-scroll max-h-32 space-y-2">{recoveries.map((item) => <li key={item.id} className="flex items-center gap-2"><div className="min-w-0 flex-1 break-all font-mono text-xs select-text"><p className="text-canvas-text-secondary">{item.rootLabel}</p><p>{item.relativePath}</p></div><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" disabled={busy || checkingRecoveries} onClick={() => recover(item.id)}>{t('恢复原文件')}</button></li>)}</ul>
    </div></div>}

    {result && <div className="ui-card shrink-0 p-3 gap-2" role={result.failed || result.warnings.length ? 'alert' : 'status'}>
      <p className="text-xs">{t('成功 {completed} · 失败 {failed} · 未处理 {unprocessed} · 释放 {size}', { completed: result.completed, failed: result.failed, unprocessed: result.unprocessed, size: formatSize(result.reclaimedBytes) })}</p>
      <p className="ui-hint">{t('处理后请重新扫描；重新启动 ComfyUI 后，从各插件原路径验证模型加载。')}</p>
      {result.historyId && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm self-start" disabled={busy || checkingRecoveries} onClick={() => setHistoryOpen(true)}>{t('查看替换历史')}</button>}
      {!!result.warnings.length && <ul className="ui-scroll max-h-28 space-y-1 text-xs text-canvas-text-secondary">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </div>}

    {scan && <div className="ui-row ui-row--between shrink-0 flex-wrap">
      <p className="text-xs">{t('{count} 组重复，最多可释放 {size}', { count: scan.groups.length, size: formatSize(reclaimable) })}<span className="ui-hint ml-2">{t('已扫描 {count} 项，跳过 {skipped} 项', { count: scan.scannedFiles, skipped: scan.skippedFiles })}{search.trim() && ` · ${t('匹配 {count} 组', { count: filteredGroups.length })}`}</span></p>
      <input type="search" className="ui-input ui-input--sm w-72 max-w-full" aria-label={t('筛选重复模型路径')} placeholder={t('搜索文件名或路径…')} value={search} onChange={(event) => { setSearch(event.target.value); setLimit(20); }} />
    </div>}
    <ComfyModelDedupeActions scan={scan} groups={selectedGroups} busy={busy || checkingRecoveries} onApply={applyAll} onOpenHistory={() => setHistoryOpen(true)} />

    <div role="region" aria-label={t('重复模型扫描结果')} tabIndex={0} className="ui-scroll min-h-0 min-w-0 flex-1 space-y-3 rounded-lg focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand">
      {filteredGroups.slice(0, limit).map((group) => <ComfyModelDedupeGroup key={`${scan?.scanId}-${group.id}`} group={group} scanId={scan?.scanId ?? ''} busy={busy || checkingRecoveries} selection={selections[group.id] ?? defaultComfyModelSelection(group)} onSelectionChange={(selection) => setSelections((current) => ({ ...current, [group.id]: selection }))} onApply={apply} />)}
      {filteredGroups.length > limit && <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setLimit((value) => value + 20)}>{t('加载更多')}</button>}
      {!scanning && !filteredGroups.length && <div className="ui-empty"><Icon icon={scan ? 'lucide:check-check' : 'lucide:files'} width={28} className="ui-empty__icon" /><p className="ui-empty__title">{scan ? (scan.groups.length ? t('没有匹配的路径') : t('未发现可去重的模型副本')) : t('扫描后选择需要合并的模型副本')}</p><p className="ui-empty__desc">{t('已共享的硬链接不重复计算空间。同名不同内容、不同量化和不同格式的文件不会仅因名称相似而合并。')}</p></div>}
    </div>
    {historyOpen && <ComfyModelDedupeHistoryDialog onClose={() => setHistoryOpen(false)} />}
  </section>;
}
