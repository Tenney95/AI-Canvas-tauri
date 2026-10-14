import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { useAppStore } from '../../store/useAppStore';
import { isTauriEnv } from '../../services/fs/core';
import {
  clearBillingRuns, exportBillingRuns, previewBillingClear, queryBillingRuns,
  getBillingStoragePath, setBillingStoragePath,
  BILLING_STORAGE_CHANGED_EVENT,
  type BillingFilter, type BillingPage, type BillingRun,
} from '../../services/billing/volcengineBillingService';
import { formatCny } from '../../services/billing/volcenginePricing';
import Select from '../shared/Select';
import PopupCloseButton from '../shared/PopupCloseButton';

const PAGE_SIZE = 30;
const emptyPage: BillingPage = { items: [], total: 0, estimatedMicros: 0, calculatedMicros: 0 };
const statusLabels: Record<BillingRun['status'], string> = {
  submitting: '提交中', running: '运行中', succeeded: '成功',
  failed: '失败', cancelled: '已取消', unknown: '待核对',
};

function parseDetails(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export default function VolcengineBillingSettings() {
  const projects = useAppStore((state) => state.projects);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const customStorageDirectory = useAppStore((state) => state.config.volcengineBillingPath?.trim());
  const [view, setView] = useState<'records' | 'clear'>('records');
  const [filter, setFilter] = useState<BillingFilter>(() => ({ appProjectId: currentProjectId || undefined,
    from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() }));
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BillingPage>(emptyPage);
  const [preview, setPreview] = useState<BillingPage | null>(null);
  const [detail, setDetail] = useState<BillingRun | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [includePrompts, setIncludePrompts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storagePath, setStoragePath] = useState('');
  const requestId = useRef(0);
  const detailInputs = detail ? parseDetails(detail.inputJson) : {};
  const detailPrice = detail ? parseDetails(detail.priceJson) : {};

  const refresh = useCallback(async () => {
    if (!isTauriEnv()) return;
    const currentRequest = ++requestId.current;
    setBusy(true); setError('');
    try {
      const [next, nextPreview, nextStoragePath] = await Promise.all([
        queryBillingRuns(filter, page, PAGE_SIZE), previewBillingClear(filter), getBillingStoragePath(),
      ]);
      if (requestId.current === currentRequest) { setData(next); setPreview(nextPreview); setStoragePath(nextStoragePath); }
    } catch (cause) { if (requestId.current === currentRequest) setError(cause instanceof Error ? cause.message : '读取费用记录失败'); }
    finally { if (requestId.current === currentRequest) setBusy(false); }
  }, [filter, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const onStorageChanged = () => { void refresh(); };
    window.addEventListener(BILLING_STORAGE_CHANGED_EVENT, onStorageChanged);
    return () => window.removeEventListener(BILLING_STORAGE_CHANGED_EVENT, onStorageChanged);
  }, [refresh]);

  const changeFilter = (patch: Partial<BillingFilter>) => {
    setPage(1); setConfirmation(''); setFilter((previous) => ({ ...previous, ...patch }));
  };

  const exportExcel = async () => {
    setBusy(true); setError('');
    try {
      const target = await save({ defaultPath: '火山方舟用量记录.xlsx', filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] });
      if (!target) return;
      const bytes = await exportBillingRuns(filter, includePrompts);
      await writeFile(target, new Uint8Array(bytes));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { setBusy(false); }
  };

  const clear = async () => {
    if (!preview?.total || confirmation !== `删除 ${preview.total} 条记录`) return;
    setBusy(true); setError('');
    try {
      await clearBillingRuns(filter, preview.total);
      setConfirmation(''); setPage(1); setDetail(null);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '清理失败'); }
    finally { setBusy(false); }
  };

  const chooseStorageDirectory = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择火山方舟账本目录' });
      if (!selected || typeof selected !== 'string') return;
      setBusy(true); setError('');
      const nextPath = await setBillingStoragePath(selected);
      const state = useAppStore.getState();
      state.updateConfig({ volcengineBillingPath: selected });
      await state.saveConfig({ silent: true, throwOnError: true });
      setStoragePath(nextPath);
      await refresh();
      state.showToast('火山方舟账本存储位置已更新');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账本目录切换失败');
    } finally { setBusy(false); }
  };

  if (!isTauriEnv()) return <div className="ui-empty"><p>火山方舟用量记录仅在桌面版可用</p></div>;

  return <div className="relative flex min-h-0 flex-1 flex-col text-canvas-text">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-canvas-border px-5 py-3">
      <div className="flex items-center gap-1" role="tablist" aria-label="用量记录视图">
        <button type="button" role="tab" aria-selected={view === 'records'} className={`ui-btn ui-btn--sm ${view === 'records' ? 'ui-btn--primary' : 'ui-btn--ghost'}`} onClick={() => setView('records')}>记录查询</button>
        <button type="button" role="tab" aria-selected={view === 'clear'} className={`ui-btn ui-btn--sm ${view === 'clear' ? 'ui-btn--primary' : 'ui-btn--ghost'}`} onClick={() => setView('clear')}>清理记录</button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-canvas-text-muted">本地估算，实际扣费以方舟账单为准</span>
        <button type="button" className="ui-icon-btn ui-icon-btn--sm" title="刷新记录" aria-label="刷新记录" onClick={() => void refresh()} disabled={busy}><Icon icon="lucide:refresh-cw" /></button>
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-canvas-border bg-canvas-card px-5 py-2.5 text-xs">
      <div className="min-w-0"><span className="text-canvas-text-secondary">账本存储位置：</span><span className="break-all font-mono font-medium text-canvas-text">{storagePath || '加载中…'}</span><p className="ui-hint mt-1">{customStorageDirectory ? '使用单独设置的账本目录' : '默认跟随“文件与应用”中的保存根目录，存放在 billing 文件夹'}</p></div>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary shrink-0" disabled={busy} onClick={() => void chooseStorageDirectory()}><Icon icon="lucide:folder-cog" />更换目录</button>
    </div>

    <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-2 border-b border-canvas-border px-5 py-3 sm:grid-cols-3 lg:grid-cols-6">
      <label className="ui-field min-w-0"><span className="ui-label">本地项目</span><Select value={filter.appProjectId || ''} onChange={(value) => changeFilter({ appProjectId: value || undefined })} options={[{ value: '', label: '全部项目' }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} fixedMenu /></label>
      <label className="ui-field min-w-0"><span className="ui-label">模型类型</span><Select value={filter.modelType || ''} onChange={(value) => changeFilter({ modelType: value ? value as 'image' | 'video' : undefined })} options={[{ value: '', label: '全部类型' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }]} fixedMenu /></label>
      <label className="ui-field min-w-0"><span className="ui-label">运行状态</span><Select value={filter.status || ''} onChange={(value) => changeFilter({ status: value ? value as BillingRun['status'] : undefined })} options={[{ value: '', label: '全部状态' }, { value: 'submitting', label: '提交中' }, { value: 'running', label: '运行中' }, { value: 'succeeded', label: '成功' }, { value: 'failed', label: '失败' }, { value: 'cancelled', label: '已取消' }, { value: 'unknown', label: '待核对' }]} fixedMenu /></label>
      <label className="ui-field min-w-0"><span className="ui-label">模型 ID</span><input className="ui-input" value={filter.modelId || ''} placeholder="完整模型 ID" onChange={(event) => changeFilter({ modelId: event.target.value || undefined })} /></label>
      <label className="ui-field min-w-0"><span className="ui-label">开始日期</span><input type="date" className="ui-input" value={filter.from ? new Date(filter.from).toLocaleDateString('sv-SE') : ''} onChange={(event) => changeFilter({ from: event.target.value ? new Date(`${event.target.value}T00:00:00`).getTime() : undefined })} /></label>
      <label className="ui-field min-w-0"><span className="ui-label">结束日期</span><input type="date" className="ui-input" value={filter.to ? new Date(filter.to - 1).toLocaleDateString('sv-SE') : ''} onChange={(event) => changeFilter({ to: event.target.value ? new Date(`${event.target.value}T00:00:00`).getTime() + 86_400_000 : undefined })} /></label>
    </div>

    {error && <div className="ui-alert ui-alert--danger mx-5 mt-3" role="alert">{error}</div>}
    {view === 'records' ? <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">{data.total} 条记录</span>
          <span>预计 <strong className="font-semibold">{formatCny(data.estimatedMicros)}</strong></span>
          <span>已核算 <strong className="font-semibold">{formatCny(data.calculatedMicros)}</strong></span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={includePrompts} onChange={(event) => setIncludePrompts(event.target.checked)} />导出完整提示词</label>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={busy || data.total === 0} onClick={() => void exportExcel()}><Icon icon="lucide:download" />导出 Excel</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-y border-canvas-border" aria-busy={busy}>
        <table className="w-full min-w-[820px] text-left text-xs">
          <thead className="sticky top-0 z-[1] bg-canvas-surface text-canvas-text-secondary"><tr>{['提交时间', '本地项目', '节点', '类型', '模型', '状态', '预计', '核算', '详情'].map((label) => <th key={label} scope="col" className="whitespace-nowrap px-3 py-2.5 font-medium">{label}</th>)}</tr></thead>
          <tbody>{data.items.map((run) => <tr key={run.id} className="border-t border-canvas-border hover:bg-canvas-hover">
            <td className="whitespace-nowrap px-3 py-2.5">{new Date(run.submittedAt).toLocaleString()}</td>
            <td className="max-w-32 truncate px-3" title={run.appProjectName}>{run.appProjectName}</td>
            <td className="max-w-28 truncate px-3" title={run.nodeLabel}>{run.nodeLabel}</td>
            <td className="px-3">{run.modelType === 'image' ? '图片' : '视频'}</td>
            <td className="max-w-40 truncate px-3" title={run.modelId}>{run.modelId}</td>
            <td className="whitespace-nowrap px-3">{statusLabels[run.status]}</td>
            <td className="whitespace-nowrap px-3">{formatCny(run.estimatedMicros)}</td>
            <td className="whitespace-nowrap px-3">{run.calculatedMicros === null ? '待核对' : formatCny(run.calculatedMicros)}</td>
            <td className="px-3"><button type="button" className="ui-icon-btn ui-icon-btn--sm" title="查看详情" aria-label={`查看 ${run.nodeLabel} 的详情`} onClick={() => setDetail(run)}><Icon icon="lucide:info" /></button></td>
          </tr>)}</tbody>
        </table>
        {!busy && data.items.length === 0 && <p className="p-8 text-center text-sm text-canvas-text-muted">暂无匹配的记录</p>}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 px-5 py-3 text-xs text-canvas-text-secondary">
        <span>每页 {PAGE_SIZE} 条</span>
        <div className="flex items-center gap-2"><span>第 {page} / {Math.max(1, Math.ceil(data.total / PAGE_SIZE))} 页</span><button type="button" className="ui-btn ui-btn--sm" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>上一页</button><button type="button" className="ui-btn ui-btn--sm" disabled={page * PAGE_SIZE >= data.total || busy} onClick={() => setPage(page + 1)}>下一页</button></div>
      </div>
    </> : <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <section className="max-w-2xl space-y-5">
        <div className="ui-alert ui-alert--warning"><Icon icon="lucide:triangle-alert" />只清理当前筛选范围内已结束的记录。运行中及待核对任务不会删除；云端账单和媒体文件不受影响。</div>
        <div className="space-y-1"><h3 className="text-sm font-semibold">清理范围</h3><p className="text-sm">可清理 {preview?.total ?? 0} 条记录，预计费用合计 {formatCny(preview?.estimatedMicros)}</p></div>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" disabled={busy || !preview?.total} onClick={() => void exportExcel()}><Icon icon="lucide:download" />先导出备份</button>
        <label className="ui-field max-w-sm"><span className="ui-label">输入“删除 {preview?.total ?? 0} 条记录”以确认</span><input className="ui-input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={busy || !preview?.total || confirmation !== `删除 ${preview.total} 条记录`} onClick={() => void clear()}><Icon icon="lucide:trash-2" />永久清理</button>
      </section>
    </div>}

    {detail && <div className="absolute inset-0 z-10 flex justify-end bg-black/40" role="presentation" onClick={() => setDetail(null)}>
      <aside className="flex h-full w-[min(94vw,32rem)] flex-col border-l border-canvas-border bg-canvas-surface shadow-xl" role="dialog" aria-label="费用记录详情" onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-canvas-border px-5 py-3"><h3 className="text-sm font-semibold">调用详情</h3><PopupCloseButton ariaLabel="关闭详情" onClick={() => setDetail(null)} /></div>
        <div className="min-h-0 flex-1 overflow-auto p-5"><dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-3 break-all text-xs"><dt className="text-canvas-text-secondary">本地项目</dt><dd>{detail.appProjectName}</dd><dt className="text-canvas-text-secondary">节点</dt><dd>{detail.nodeLabel}</dd><dt className="text-canvas-text-secondary">模型</dt><dd>{detail.modelId}</dd><dt className="text-canvas-text-secondary">提交时间</dt><dd>{new Date(detail.submittedAt).toLocaleString()}</dd><dt className="text-canvas-text-secondary">状态</dt><dd>{statusLabels[detail.status]}</dd><dt className="text-canvas-text-secondary">预计费用</dt><dd>{formatCny(detail.estimatedMicros)}</dd><dt className="text-canvas-text-secondary">核算费用</dt><dd>{detail.calculatedMicros === null ? '待核对' : formatCny(detail.calculatedMicros)}</dd>{[
          ['参考类型', detailInputs.referenceType], ['参考数量', detailInputs.referenceCount],
          ['时长（秒）', detailInputs.durationSeconds], ['画幅', detailInputs.ratio ?? detailInputs.aspectRatio],
          ['清晰度', detailInputs.resolution ?? detailInputs.imageSize], ['输出尺寸', detailInputs.width && detailInputs.height ? `${detailInputs.width} × ${detailInputs.height}` : undefined],
          ['帧率', detailInputs.fps], ['输入图片数', detailInputs.inputImageCount],
          ['输出图片数', detailInputs.outputCountRequested], ['输出 Token', detailInputs.completionTokens],
          ['价格依据', detailPrice.rule], ['估价说明', detailPrice.reason],
        ].filter((item) => item[1] !== undefined && item[1] !== null).map(([label, value]) => <Fragment key={String(label)}><dt className="text-canvas-text-secondary">{String(label)}</dt><dd>{String(value)}</dd></Fragment>)}<dt className="text-canvas-text-secondary">运行 ID</dt><dd>{detail.id}</dd>{detail.taskId && <><dt className="text-canvas-text-secondary">任务 ID</dt><dd>{detail.taskId}</dd></>}{detail.errorMessage && <><dt className="text-canvas-text-secondary">错误</dt><dd>{detail.errorMessage}</dd></>}</dl><details className="mt-5 border-t border-canvas-border pt-4 text-xs"><summary className="cursor-pointer">提示词</summary><p className="mt-3 whitespace-pre-wrap break-words">{detail.prompt}</p></details></div>
      </aside>
    </div>}
  </div>;
}
