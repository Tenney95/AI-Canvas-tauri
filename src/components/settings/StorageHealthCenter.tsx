/** 存储健康中心：先说明占用和清理范围，再提供逐项核对后的清理入口。 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { isTauriEnv, revealFileInFolder } from '../../services/fileService';
import {
  scanStorageHealth, prepareTrashCleanup, clearTrashDir, deleteOrphanFile, deleteDuplicateFile, collectNodeFilePaths, collectStorageLiveFilePaths, StorageHealthScanError,
  type StorageHealthReport, type TrashInfo, type OrphanFileInfo, type DuplicateFileGroup, type CleanupResult,
} from '../../services/fs/storageHealth';
import { estimateBrowserStorage, formatBytes, STORAGE_PRESSURE_RATIO, type StorageEstimate } from '../../services/storageQuota';
import { useT } from '../../i18n';
import AssetRepairDialog from '../assets/AssetRepairDialog';
import type { AssetRepairTarget } from '../../services/fs/assetRepair';
import ModalOverlay from '../shared/ModalOverlay';
import Tabs from '../shared/Tabs';

type Section = 'overview' | 'trash' | 'orphans' | 'duplicates' | 'offline';
type CleanupSelection = (
  | { kind: 'trash'; entries: TrashInfo[] }
  | { kind: 'orphans'; entries: OrphanFileInfo[] }
  | { kind: 'duplicates'; entries: DuplicateFileGroup['files']; groupKey: string }
);
type CleanupRequest = CleanupSelection & { projectId: string | null };

const CATEGORY_COLORS: Record<string, string> = {
  '图片': 'var(--node-image)', '视频': 'var(--node-video)', '音频': 'var(--node-audio)',
  '文本': 'var(--node-text)', '其他': 'var(--theme-text-muted)', '回收站': 'var(--warning)',
};
const PROJECT_COLORS = [
  'var(--brand)', 'var(--node-panorama)', 'var(--node-image)', 'var(--node-audio)',
  'var(--node-markdown)', 'var(--info)',
];
const SCAN_REASON_LABELS: Record<StorageHealthScanError['reason'], string> = {
  permission: '访问被拒绝', missing: '文件或目录已不存在', symlink: '符号链接未纳入扫描',
  changed: '文件在扫描时发生变化', unavailable: '读取暂不可用',
  'native-protected': '此项目有待续操作或引用尚未核验，已保留其素材，其他项目仍可清理。',
};

function formatPercent(value: number) {
  if (value <= 0) return '0%';
  if (value < 0.1) return '<0.1%';
  if (value < 1) return `${value.toFixed(1)}%`;
  if (value < 100 && value > 99.9) return '>99.9%';
  return `${Number(value.toFixed(1))}%`;
}

function DonutChart({ segments, total }: {
  segments: { label: string; value: number; color: string }[]; total: number;
}) {
  const t = useT();
  const circumference = 2 * Math.PI * 42;
  let offset = 0;
  const slices = [];
  for (const segment of segments) {
    if (segment.value <= 0) continue;
    const length = total > 0 ? segment.value / total * circumference : 0;
    slices.push({ ...segment, length, offset });
    offset += length;
  }
  return <div className="flex flex-wrap items-center gap-3">
    <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={t('项目文件占用构成')} className="shrink-0">
      <circle cx="56" cy="56" r="42" fill="none" stroke="var(--theme-hover)" strokeWidth="14" />
      {slices.map((slice) => <circle key={slice.label} cx="56" cy="56" r="42" fill="none" stroke={slice.color}
        strokeWidth="14" strokeDasharray={`${slice.length} ${circumference}`} strokeDashoffset={-slice.offset}
        transform="rotate(-90 56 56)">
        <title>{`${t(slice.label)} · ${formatBytes(slice.value)} · ${formatPercent(total > 0 ? slice.value / total * 100 : 0)}`}</title>
      </circle>)}
      <text x="56" y="60" textAnchor="middle" fill="var(--theme-text)" fontSize="12" fontWeight="500">
        {total > 0 ? t('占用构成') : t('暂无文件')}
      </text>
    </svg>
    <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
      {slices.map((slice) => <li key={slice.label} className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: slice.color }} />
        <span className="text-canvas-text-secondary">{t(slice.label)}</span>
        <span className="ml-auto tabular-nums text-canvas-text">{formatBytes(slice.value)}</span>
      </li>)}
      {slices.length === 0 && <li className="text-canvas-text-muted">{t('尚无可统计的文件')}</li>}
    </ul>
  </div>;
}

function StackedBar({ projects }: { projects: StorageHealthReport['projects'] }) {
  const t = useT();
  const total = projects.reduce((sum, project) => sum + project.fileSize, 0);
  const items = projects.map((project, index) => ({ ...project, color: PROJECT_COLORS[index % PROJECT_COLORS.length] }))
    .sort((a, b) => b.fileSize - a.fileSize);
  return <div className="space-y-2">
    <div className="flex h-3 overflow-hidden rounded-full bg-canvas-hover" role="img" aria-label={t('各项目素材占用比例')}>
      {items.filter((item) => item.fileSize > 0).map((item) => <div key={item.projectId} className="h-full shrink-0"
        style={{ width: `${item.fileSize / total * 100}%`, backgroundColor: item.color }}
        title={`${item.projectName} · ${formatBytes(item.fileSize)} · ${formatPercent(item.fileSize / total * 100)}`} />)}
    </div>
    <ul className="space-y-2">
      {items.map((item) => <li key={item.projectId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
        <span className="min-w-0 flex-1 truncate text-canvas-text" title={item.projectName}>{item.projectName}</span>
        <span className="tabular-nums text-canvas-text-secondary">{formatPercent(total > 0 ? item.fileSize / total * 100 : 0)}</span>
        <span className="w-24 text-right tabular-nums text-canvas-text">{formatBytes(item.fileSize)}</span>
        {!!item.sharedWith?.length && <span className="basis-full pl-4 text-[11px] text-canvas-text-muted">
          {t('与 {names} 共用目录，文件仅计一次', { names: item.sharedWith.join('、') })}
        </span>}
      </li>)}
    </ul>
  </div>;
}

async function collectLiveReferences(projectId = useAppStore.getState().currentProjectId): Promise<Set<string>> {
  const state = useAppStore.getState();
  if (state.currentProjectId !== projectId) {
    throw new Error('当前项目的实时文件引用无法确认，请重新扫描');
  }
  const paths = await collectStorageLiveFilePaths(projectId, { nodes: state.nodes, history: state.history, messages: state.messages, dramaAssets: state.dramaAssets,
    globalCharacters: state.globalCharacters, globalScenes: state.globalScenes, globalProps: state.globalProps });
  const current = useAppStore.getState();
  if (current.currentProjectId !== projectId || current.nodes !== state.nodes || current.history !== state.history
    || current.messages !== state.messages || current.dramaAssets !== state.dramaAssets
    || current.globalCharacters !== state.globalCharacters || current.globalScenes !== state.globalScenes
    || current.globalProps !== state.globalProps) throw new Error('当前项目的实时文件引用已变化，请重新扫描');
  return paths;
}

export default function StorageHealthCenter() {
  const t = useT();
  const { showToast } = useAppStore(useShallow((state) => ({ showToast: state.showToast })));
  const desktop = isTauriEnv();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<{
    cancelled: boolean; references: boolean; reason: StorageHealthScanError['reason'];
  } | null>(null);
  const [report, setReport] = useState<StorageHealthReport | null>(null);
  const [browserStorage, setBrowserStorage] = useState<StorageEstimate | null>(null);
  const [activeSection, setActiveSection] = useState<Section>('overview');
  const [repairTarget, setRepairTarget] = useState<AssetRepairTarget | null>(null);
  const [pendingCleanup, setPendingCleanup] = useState<CleanupRequest | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<(CleanupResult & { failedNames: string[] }) | null>(null);
  const mounted = useRef(true);
  const scanLock = useRef(false);
  const cleanupLock = useRef(false);
  const scanRun = useRef(0);
  const scanController = useRef<AbortController | null>(null);
  const cleanupController = useRef<AbortController | null>(null);

  const handleScan = useCallback(async () => {
    if (scanLock.current) return;
    scanLock.current = true;
    const run = ++scanRun.current;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanError(null);
    try {
      const projectId = useAppStore.getState().currentProjectId;
      const folders = (useAppStore.getState().config.assetFolders ?? []).map((path) => ({
        path, label: path.replace(/\\/g, '/').split('/').pop() || '外部文件夹',
      }));
      const [, result] = await Promise.all([
        estimateBrowserStorage().then((quota) => {
          if (mounted.current && run === scanRun.current) setBrowserStorage(quota);
        }),
        desktop ? scanStorageHealth(useAppStore.getState().projects, () => collectLiveReferences(projectId), folders, { signal: controller.signal }) : null,
      ]);
      if (!mounted.current || run !== scanRun.current) return;
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (useAppStore.getState().currentProjectId !== projectId) throw new Error('项目已切换');
      setReport(result);
    } catch (error) {
      if (mounted.current && run === scanRun.current) {
        setReport(null);
        const known = error instanceof StorageHealthScanError;
        const reason = known ? error.reason : 'unavailable';
        setScanError({ cancelled: controller.signal.aborted, references: known && error.area === 'references', reason });
        if (!controller.signal.aborted) console.warn('[storage-health] scan failed', { area: known ? error.area : 'scan', reason });
      }
    } finally {
      if (mounted.current && run === scanRun.current) {
        scanLock.current = false;
        scanController.current = null;
        setScanning(false);
      }
    }
  }, [desktop]);

  useEffect(() => {
    mounted.current = true;
    void handleScan();
    return () => {
      mounted.current = false;
      scanLock.current = false;
      scanController.current?.abort();
      cleanupController.current?.abort();
    };
  }, [handleScan]);

  const requestCleanup = async (request: CleanupSelection) => {
    if (scanLock.current || cleanupLock.current || !report?.complete || !request.entries.length) return;
    const projectId = useAppStore.getState().currentProjectId;
    if (request.kind !== 'trash') { setPendingCleanup({ ...request, projectId }); return; }
    scanLock.current = true;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    try {
      const fresh = await scanStorageHealth(useAppStore.getState().projects, () => collectLiveReferences(projectId), [], {
        includeDuplicates: false, signal: controller.signal,
      });
      if (!fresh.complete || !mounted.current || useAppStore.getState().currentProjectId !== projectId) throw new Error('引用未能确认');
      for (const entry of request.entries) for (const selected of entry.files.filter((file) => !file.referenced && file.size > 0)) {
        const current = fresh.trashes.find((trash) => trash.trashDir === entry.trashDir)?.files.find((file) => file.path === selected.path);
        if (!current || current.referenced || current.size !== selected.size) throw new Error('回收站文件已变化');
      }
      const prepared = await prepareTrashCleanup(request.entries, controller.signal);
      if (!mounted.current || controller.signal.aborted || useAppStore.getState().currentProjectId !== projectId) return;
      setPendingCleanup({ kind: 'trash', entries: prepared, projectId });
    } catch {
      if (mounted.current && !controller.signal.aborted) showToast(t('无法确认回收站文件，请重新扫描'), 'error');
    } finally {
      scanLock.current = false;
      scanController.current = null;
      if (mounted.current) setScanning(false);
    }
  };

  const applyCleanup = async () => {
    if (!pendingCleanup || cleanupLock.current || scanLock.current) return;
    if (useAppStore.getState().currentProjectId !== pendingCleanup.projectId) {
      setPendingCleanup(null);
      showToast(t('项目已切换，请重新扫描后再清理'), 'error');
      return;
    }
    cleanupLock.current = true;
    const controller = new AbortController();
    cleanupController.current = controller;
    setCleaning(true);
    setCleanupResult(null);
    const result: CleanupResult & { failedNames: string[] } = { deletedCount: 0, failedCount: 0, reclaimedSize: 0, failedNames: [] };
    const request = pendingCleanup;
    // 确认窗口打开后引用仍可能变化，每个文件真正删除前都再核对一次。
    let verifiedSize = 0;
    const verifyUnreferenced = async (path: string) => {
      if (!mounted.current || useAppStore.getState().currentProjectId !== request.projectId) return false;
      const fresh = await scanStorageHealth(useAppStore.getState().projects, () => collectLiveReferences(request.projectId), [], {
        includeDuplicates: request.kind === 'duplicates', signal: controller.signal,
      });
      if (!fresh.complete) return false;
      const key = [...collectNodeFilePaths([{ data: { filePath: path } }])][0];
      const live = await collectLiveReferences(request.projectId);
      const orphan = fresh.orphans.find((file) => file.path === path);
      const expected = request.kind === 'trash' ? undefined : request.entries.find((file) => file.path === path);
      const duplicateEligible = request.kind !== 'duplicates'
        || fresh.duplicates.some((group) => group.key === request.groupKey
          && group.files.some((file) => file.path === path && file.canDelete));
      verifiedSize = orphan?.size ?? 0;
      return mounted.current && useAppStore.getState().currentProjectId === request.projectId
        && !live.has(key) && !!orphan && orphan.size === expected?.size && duplicateEligible;
    };
    try {
      for (const entry of request.entries) {
        const name = 'name' in entry ? entry.name : entry.projectName;
        if (!mounted.current || useAppStore.getState().currentProjectId !== request.projectId) {
          result.failedCount += 'fileCount' in entry ? entry.reclaimableCount : 1;
          result.failedNames.push(name);
          continue;
        }
        try {
          if (request.kind === 'trash' && 'trashDir' in entry) {
            const fresh = await scanStorageHealth(useAppStore.getState().projects, () => collectLiveReferences(request.projectId), [], {
              includeDuplicates: false, signal: controller.signal,
            });
            if (!fresh.complete || !fresh.trashes.some((trash) => trash.trashDir === entry.trashDir)) {
              result.failedCount += Math.max(1, entry.reclaimableCount);
              result.failedNames.push(name);
              continue;
            }
            const confirmedFiles = entry.files.filter((file): file is { path: string; size: number; referenced: boolean; digest: string } =>
              !file.referenced && typeof file.digest === 'string');
            const cleared = await clearTrashDir(entry.trashDir, async (path, size) => {
              if (!mounted.current || useAppStore.getState().currentProjectId !== request.projectId) return false;
              const freshCheck = await scanStorageHealth(useAppStore.getState().projects, () => collectLiveReferences(request.projectId), [], {
                includeDuplicates: false, signal: controller.signal,
              });
              if (!freshCheck.complete) return false;
              const current = freshCheck.trashes.find((trash) => trash.trashDir === entry.trashDir)?.files.find((file) => file.path === path);
              const live = await collectLiveReferences(request.projectId);
              const key = [...collectNodeFilePaths([{ data: { filePath: path } }])][0];
              if (!key) return false;
              const referencedLive = live.has(key) || [...live].some((reference) => reference.endsWith('/') && key.startsWith(reference));
              return mounted.current && useAppStore.getState().currentProjectId === request.projectId
                && !!current && !current.referenced && current.size === size && !referencedLive;
            }, confirmedFiles, controller.signal);
            result.deletedCount += cleared.deletedCount;
            result.failedCount += cleared.failedCount;
            result.reclaimedSize += cleared.reclaimedSize;
            if (cleared.failedCount) result.failedNames.push(name);
          } else if ('path' in entry) {
            const removed = request.kind === 'duplicates'
              ? await deleteDuplicateFile(entry.path, verifyUnreferenced)
              : await deleteOrphanFile(entry.path, verifyUnreferenced);
            if (removed) { result.deletedCount++; result.reclaimedSize += verifiedSize; }
            else { result.failedCount++; result.failedNames.push(name); }
          }
        } catch {
          result.failedCount += 'fileCount' in entry ? Math.max(1, entry.reclaimableCount) : 1;
          result.failedNames.push(name);
        }
      }
    } finally {
      cleanupLock.current = false;
      cleanupController.current = null;
      if (mounted.current) {
        setCleaning(false);
        setPendingCleanup(null);
        setCleanupResult(result);
        showToast(t('已清理 {count} 个文件，未清理 {failed} 项', { count: result.deletedCount, failed: result.failedCount }), result.failedCount ? 'error' : 'success');
        await handleScan();
      }
    }
  };

  const overview = useMemo(() => {
    if (!report) return null;
    const categories = new Map<string, number>();
    for (const project of report.projects) {
      for (const [category, info] of Object.entries(project.categories)) categories.set(category, (categories.get(category) ?? 0) + info.size);
    }
    if (report.trashSize > 0) categories.set('回收站', report.trashSize);
    return [...categories].map(([label, value]) => ({ label, value, color: CATEGORY_COLORS[label] ?? 'var(--theme-text-muted)' }))
      .sort((a, b) => b.value - a.value);
  }, [report]);
  const busy = scanning || cleaning;
  const canClean = !!report?.complete && !busy;
  const quotaRatio = Math.max(0, Math.min(1, browserStorage?.ratio ?? 0));
  const pressured = quotaRatio >= STORAGE_PRESSURE_RATIO;
  const cleanupEntries = pendingCleanup?.entries.map((entry) => ({
    key: 'path' in entry ? entry.path : entry.trashDir,
    name: 'name' in entry ? entry.name : t('项目回收站'),
    projectName: entry.projectName,
    size: 'size' in entry ? entry.size : entry.reclaimableSize,
    count: 'fileCount' in entry ? entry.reclaimableCount : 1,
  })) ?? [];
  const cleanupCount = cleanupEntries.reduce((sum, entry) => sum + entry.count, 0);
  const cleanupSize = cleanupEntries.reduce((sum, entry) => sum + entry.size, 0);

  return <div className="space-y-3" aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-canvas-text">{t('存储健康中心')}</h3>
        <p className="ui-hint mt-1">{t('查看项目素材与回收站，清理前会重新核对文件引用')}</p>
        {report && <p className="ui-hint mt-1">{t('上次扫描：{time}', { time: new Date(report.scannedAt).toLocaleString() })}</p>}
      </div>
      <div className="flex items-center gap-2">
        {scanning && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => scanController.current?.abort()}>{t('取消扫描')}</button>}
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || !!pendingCleanup} onClick={() => void handleScan()}>
          {scanning ? t('扫描中…') : t('重新扫描')}
        </button>
      </div>
    </div>

    {!desktop && <p className="ui-alert ui-alert--info">{t('Web 演示仅展示应用数据配额；项目文件扫描与清理请在桌面端使用。')}</p>}
    {scanError && <p role="alert" className={`ui-alert ${scanError.cancelled ? 'ui-alert--info' : 'ui-alert--danger'}`}>
      {scanError.cancelled ? t('扫描已取消，尚未完成核对。重新扫描后可查看清理建议。')
        : scanError.references
          ? t('项目引用读取未完成（{reason}），暂不提供清理操作。请重新扫描。', { reason: t(SCAN_REASON_LABELS[scanError.reason]) })
          : t('扫描未完成（{reason}），暂不提供清理操作。请重新扫描。', { reason: t(SCAN_REASON_LABELS[scanError.reason]) })}
    </p>}
    {report && report.issues.length > 0 && <div role="status" className={`ui-alert ${report.complete ? 'ui-alert--info' : 'ui-alert--warning'}`}>
      <div className="ui-alert__body">
        <p>{t(report.complete
          ? '部分项目的素材暂受保护，其他已核验的未引用文件仍可清理。'
          : '部分文件或目录未能检查，下方仅展示已读取的占用。完整扫描前暂不提供清理操作。')}</p>
        <details className="mt-1">
          <summary className="cursor-pointer">{t('查看扫描提示（{count}）', { count: report.issues.length })}</summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
            {report.issues.map((issue, index) => <li key={index} className="break-words">
              {issue.projectName} · {t(issue.area === 'trash' ? '回收站' : issue.area === 'duplicates' ? '重复文件核对' : '项目文件')}
              {issue.name ? ` / ${issue.name}` : ''} · {t(SCAN_REASON_LABELS[issue.reason])}
            </li>)}
          </ul>
        </details>
      </div>
    </div>}
    {scanning && <p role="status" className="ui-hint">{t('正在核对项目引用与文件内容，文件较多时可能需要一些时间…')}</p>}
    {cleanupResult && <div role="status" className={`ui-alert ${cleanupResult.failedCount ? 'ui-alert--warning' : 'ui-alert--success'}`}>
      <div className="ui-alert__body">
        <p>{t('已清理 {count} 个文件，释放 {size}；未清理 {failed} 项', {
          count: cleanupResult.deletedCount, size: formatBytes(cleanupResult.reclaimedSize), failed: cleanupResult.failedCount,
        })}</p>
        {cleanupResult.failedNames.length > 0 && <details className="mt-1">
          <summary className="cursor-pointer">{t('查看未清理项')}</summary>
          <p className="mt-1 text-xs">{t('文件可能仍被引用、已发生变化或无法访问；请重新扫描后核对。')}</p>
          <ul className="mt-1 max-h-32 overflow-y-auto text-xs">
            {cleanupResult.failedNames.map((name, index) => <li key={index} className="break-words">{name}</li>)}
          </ul>
        </details>}
      </div>
    </div>}

    {report && overview && <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="ui-stat">
          <span className="ui-stat__label">{report.complete ? t('项目文件占用') : t('已读取文件占用')}</span>
          <span className="ui-stat__value">{formatBytes(report.totalSize)}</span>
          <span className="ui-hint mt-1">{t(report.complete ? '素材 {files} · 回收站 {trash}' : '已读取素材 {files} · 已读取回收站 {trash}', {
            files: formatBytes(report.projectSize), trash: formatBytes(report.trashSize),
          })}</span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat__label">{t('预计可释放')}</span>
          <span className="ui-stat__value">{report.complete ? formatBytes(report.reclaimableSize) : t('待完整扫描')}</span>
          <span className="ui-hint mt-1">{report.complete ? t('未引用文件与回收站中未引用的文件；重复文件不重复计入') : t('未扫描项不视为零占用或无引用')}</span>
        </div>
      </div>
      <p className="ui-hint">{t('{projects} 个项目 · {files} 个文件；共享目录按文件去重', {
        projects: report.projects.length,
        files: report.projects.reduce((sum, project) => sum + project.fileCount, 0) + report.trashes.reduce((sum, trash) => sum + trash.fileCount, 0),
      })}</p>
      {report.projects.some((project) => project.dataModel === 'native') && <p className="ui-hint">
        {t('新项目可清理已核验的未引用原件；不可变媒体、导入副本、回收站和目录元数据继续保留。')}
      </p>}

      <div className="space-y-3">
        <Tabs<Section> size="sm" value={activeSection} onChange={setActiveSection} aria-label={t('存储检查分类')} items={[
          { value: 'overview', label: t('概览') },
          { value: 'trash', label: t('回收站'), count: report.complete ? report.trashes.reduce((sum, trash) => sum + trash.fileCount, 0) : undefined },
          { value: 'orphans', label: t('未引用文件'), count: report.complete ? report.orphans.length : undefined },
          { value: 'duplicates', label: t('重复文件'), count: report.complete ? report.duplicates.length : undefined },
          { value: 'offline', label: t('不可用目录'), count: report.offlineFolders.length },
        ]} />
        {activeSection === 'overview' && <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="ui-card p-3">
              <h4 className="text-xs font-medium text-canvas-text mb-2">{t('占用构成')}</h4>
              <DonutChart segments={overview} total={report.totalSize} />
            </section>
            <section className="ui-card p-3">
              <h4 className="text-xs font-medium text-canvas-text mb-3">{t('各项目素材占用')}</h4>
              {report.projects.length ? <StackedBar projects={report.projects} /> : <p className="ui-hint">{t('暂无项目')}</p>}
            </section>
          </div>
          <p className="ui-hint">{t('统计不含应用数据库、本地模型和外部素材目录。未引用文件仍需人工核对用途后清理。')}</p>
        </div>}

        {activeSection === 'trash' && <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="ui-hint">{t('回收站 {size}；清理未引用文件后无法通过应用恢复', { size: formatBytes(report.trashSize) })}</p>
            <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!canClean || !report.trashes.some((trash) => trash.reclaimableCount > 0)}
              onClick={() => void requestCleanup({ kind: 'trash', entries: report.trashes.filter((trash) => trash.reclaimableCount > 0) })}>{t('清理全部未引用文件')}</button>
          </div>
          {report.trashes.length === 0 && <p className="ui-hint py-3">{report.complete ? t('回收站为空') : t('已读取范围内暂无回收站文件')}</p>}
          {report.trashes.map((trash) => <div key={trash.trashDir} className="ui-card p-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-canvas-text">{trash.projectName}</p>
                <p className="ui-hint mt-1">{t('{count} 个文件 · {size}', { count: trash.fileCount, size: formatBytes(trash.trashSize) })}</p>
                <p className="ui-hint mt-1">{t('可清理 {count} 个 · {size}；被引用、空文件或无法核对的文件会保留', { count: trash.reclaimableCount, size: formatBytes(trash.reclaimableSize) })}</p>
              </div>
              <button type="button" className="ui-btn ui-btn--danger ui-btn--sm shrink-0" disabled={!canClean || trash.reclaimableCount === 0}
                onClick={() => void requestCleanup({ kind: 'trash', entries: [trash] })}>{t('清理未引用文件')}</button>
            </div>
          </div>)}
        </section>}

        {activeSection === 'orphans' && <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="ui-hint">{t('未发现应用内引用，不代表文件没有其他用途；删除前请核对。')}</p>
            <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!canClean || !report.orphans.length}
              onClick={() => void requestCleanup({ kind: 'orphans', entries: report.orphans })}>{t('清理全部未引用文件')}</button>
          </div>
          {report.orphans.length === 0 && <p className="ui-hint py-3">{report.complete ? t('未发现可清理的未引用文件') : t('完整扫描后才能确认未引用文件')}</p>}
          <ul className="space-y-2">
            {report.orphans.map((file) => <li key={file.path} className="ui-card p-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-canvas-text" title={file.path}>{file.name}</p>
                  <p className="ui-hint mt-1 truncate">{file.projectName} · {formatBytes(file.size)}</p>
                </div>
                <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" disabled={busy || !desktop}
                  aria-label={t('打开 {name} 所在位置', { name: file.name })}
                  onClick={() => {
                    void revealFileInFolder(file.path).catch(() => {
                      showToast(t('打开文件所在位置失败，请确认文件仍存在且可访问'), 'error');
                    });
                  }}>{t('打开所在位置')}</button>
                <button type="button" className="ui-btn ui-btn--danger ui-btn--sm shrink-0" disabled={!canClean}
                  onClick={() => void requestCleanup({ kind: 'orphans', entries: [file] })}>{t('删除')}</button>
              </div>
            </li>)}
          </ul>
        </section>}

        {activeSection === 'duplicates' && <section className="space-y-2">
          <p className="ui-hint">{t('以下文件已核对内容摘要。仍被引用的副本受保护；可删除项已包含在未引用文件中。')}</p>
          {report.duplicates.length === 0 && <p className="ui-hint py-3">{report.complete ? t('未发现内容相同的重复文件') : t('已核对范围内暂无重复文件')}</p>}
          {report.duplicates.map((group) => <div key={group.key} className="ui-card p-3 gap-2">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <h4 className="min-w-0 truncate text-xs font-medium text-canvas-text" title={group.files[0]?.name}>{group.files[0]?.name}</h4>
              <span className="ui-badge ui-badge--outline">{t('{count} 份 · 可删除 {size}', { count: group.files.length, size: formatBytes(group.reclaimableSize) })}</span>
            </div>
            <ul className="space-y-2">
              {group.files.map((file) => <li key={file.path} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-canvas-text-secondary" title={file.path}>{file.projectName} / {file.name}</span>
                <span className={`ui-badge ${file.referenced ? 'ui-badge--info' : 'ui-badge--outline'}`}>
                  {file.referenced ? t('仍被引用') : file.canDelete ? t('未引用') : t('保留副本')}
                </span>
                <span className="tabular-nums text-canvas-text-secondary">{formatBytes(file.size)}</span>
                {file.canDelete && <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!canClean}
                  onClick={() => void requestCleanup({ kind: 'duplicates', entries: [file], groupKey: group.key })}>{t('删除')}</button>}
              </li>)}
            </ul>
          </div>)}
        </section>}

        {activeSection === 'offline' && <section className="space-y-2">
          <p className="ui-hint">{t('仅检查设置中登记的外部素材目录；文件级失效请使用下方检查入口。')}</p>
          {report.offlineFolders.length === 0 && <p className="ui-hint py-3">{t('未发现不可用的外部目录')}</p>}
          {report.offlineFolders.map((folder) => <div key={folder.path} className="ui-card p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-canvas-text" title={folder.path}>{folder.label}</span>
              <span className="ui-badge ui-badge--warning">{t('不可用')}</span>
              <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0" disabled={busy}
                onClick={() => setRepairTarget({ kind: 'folder', path: folder.path, name: folder.label })}>{t('重新定位')}</button>
            </div>
          </div>)}
        </section>}
      </div>
    </>}

    <section className="ui-card p-3 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-medium text-canvas-text">{t('失效素材与目录')}</h4>
          <p className="ui-hint mt-1">{scanning ? t('正在检查外部目录…') : scanError ? t('目录检查未完成') : !desktop ? t('需在桌面端检查')
            : report ? t('不可用外部目录：{count} 个', { count: report.offlineFolders.length }) : t('尚未检查')}</p>
        </div>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || !desktop}
          onClick={() => setRepairTarget({ kind: 'all' })}>{t('检查并修复素材')}</button>
      </div>
      <p className="ui-hint">{t('文件级失效需单独检查；可查看缺失记录，并选择文件或目录重新定位。')}</p>
    </section>

    {browserStorage && browserStorage.quota > 0 && <details className="ui-card p-3" open={pressured ? true : undefined}>
      <summary className="cursor-pointer text-xs font-medium text-canvas-text">
        {t('应用数据配额')} · {formatBytes(browserStorage.usage)} / {formatBytes(browserStorage.quota)}（{formatPercent(quotaRatio * 100)}）
      </summary>
      <div className="mt-3 space-y-2">
        <div role="progressbar" aria-label={t('应用数据配额使用率')} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={quotaRatio * 100} aria-valuetext={formatPercent(quotaRatio * 100)} className="h-2 overflow-hidden rounded-full bg-canvas-hover">
          <div className={`h-full rounded-full ${pressured ? 'bg-warning' : 'bg-brand'}`} style={{ width: `${quotaRatio * 100}%` }} />
        </div>
        <p className="ui-hint">{t('这是浏览器内核管理的应用数据配额，包含项目与对话等数据，不是磁盘总容量；上方素材清理不直接释放这部分配额。')}</p>
        {pressured && <p role="alert" className="ui-alert ui-alert--warning">{t('应用数据配额即将用尽，自动保存可能失败。请先导出备份，再删除不再需要的旧项目或对话。')}</p>}
      </div>
    </details>}

    {repairTarget && <AssetRepairDialog target={repairTarget} onClose={() => setRepairTarget(null)} onRepaired={() => { void handleScan(); }} />}
    {pendingCleanup && <ModalOverlay isOpen onClose={() => { if (!cleaning) setPendingCleanup(null); }} closeOnBackdrop={!cleaning}
      ariaLabel={t('确认永久清理')} zIndex={400} className="ui-dialog-surface w-[min(560px,calc(100vw-24px))] max-h-[80vh]">
      <header className="ui-card__header shrink-0">
        <div>
          <h3 className="ui-card__title">{t('确认永久清理')}</h3>
          <p className="ui-card__desc">{t('{count} 个文件 · 预计释放 {size}', { count: cleanupCount, size: formatBytes(cleanupSize) })}</p>
        </div>
      </header>
      <div className="ui-card__body ui-scroll min-h-0 space-y-3">
        <p className="ui-alert ui-alert--warning">{pendingCleanup.kind === 'trash'
          ? t('未引用文件将永久删除，仍被引用、发生变化或未能确认的文件会保留。请确认不再需要这些文件。')
          : t('文件将从磁盘永久删除，不进入回收站。执行前会再次核对引用，仍被引用或无法确认的文件会保留。')}</p>
        <ul className="space-y-2">
          {cleanupEntries.map((entry) => <li key={entry.key} className="ui-card p-2">
            <p className="break-words text-xs text-canvas-text">{entry.name}</p>
            <p className="ui-hint mt-1 break-words">{entry.projectName} · {formatBytes(entry.size)}
              {pendingCleanup.kind === 'trash' ? ` · ${t('{count} 个文件', { count: entry.count })}` : ''}</p>
            <p className="ui-hint mt-1 break-all">{entry.key}</p>
          </li>)}
        </ul>
      </div>
      <footer className="ui-card__footer shrink-0">
        <div className="ui-card__footer-actions">
          <button type="button" className="ui-btn ui-btn--ghost" disabled={cleaning} onClick={() => setPendingCleanup(null)}>{t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--danger" disabled={cleaning} onClick={() => void applyCleanup()}>
            {cleaning ? t('正在清理…') : t('确认永久删除')}
          </button>
        </div>
      </footer>
    </ModalOverlay>}
  </div>;
}
