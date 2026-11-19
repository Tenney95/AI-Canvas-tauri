/** 归档更新恢复点；恢复前再次确认，并保留当前状态作为新的恢复点。 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { listProjectImportRecoveries } from '../../services/indexedDb/projectImportRepository';
import { listNativeContentRecoveryPoints, listNativeProjectPendingTransfers,
  type NativeProjectPendingTransfer } from '../../services/indexedDb/nativeProjectRepository';
import type { NativeProjectViewItem } from '../../store/nativeProjectView';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import { useT } from '../../i18n';

type RecoveryRow = { id: string; createdAt: number; label: string; episodeCount: number };

function loadRecoveryRows(ownerId: string, nativeProjectId?: string): Promise<RecoveryRow[]> {
  if (nativeProjectId) return listNativeContentRecoveryPoints(nativeProjectId).then((items) => items.map((item) => ({
    id: item.operationId, createdAt: item.createdAt, label: '更新前', episodeCount: item.aggregate.episodes.length,
  })));
  return listProjectImportRecoveries(ownerId).then((items) => items.map((item) => ({
    id: item.id, createdAt: item.createdAt, label: item.label, episodeCount: item.records.length - 1,
  })));
}

export default function ProjectImportRecoveryDialog({ ownerId, onClose }: { ownerId: string; onClose: () => void }) {
  const t = useT(), restore = useAppStore((state) => state.restoreProjectImport);
  const settle = useAppStore((state) => state.settleProjectTransfer);
  const project = useAppStore((state) => state.projects.find((item) => item.id === ownerId));
  const binding = project && 'nativeView' in project ? (project as NativeProjectViewItem).nativeView : undefined;
  // 恢复可能替换原画布 ID，已打开的窗口仍指向同一作品。
  const [nativeProjectId] = useState(binding?.projectId);
  const [rows, setRows] = useState<RecoveryRow[]>([]), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [operationId, setOperationId] = useState(''), [operationStatus, setOperationStatus] = useState('');
  const [pending, setPending] = useState<NativeProjectPendingTransfer[]>([]);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      loadRecoveryRows(ownerId, nativeProjectId),
      nativeProjectId ? listNativeProjectPendingTransfers(nativeProjectId) : Promise.resolve([]),
    ]).then(([points, operations]) => {
      if (!active) return;
      setRows(points.status === 'fulfilled' ? points.value : []);
      setPending(operations.status === 'fulfilled' ? operations.value : []);
      setReadError(points.status === 'rejected' ? t('读取恢复点失败')
        : operations.status === 'rejected' ? t('读取待处理操作失败') : '');
      setLoading(false);
    });
    return () => { active = false; };
  }, [ownerId, nativeProjectId, t]);
  const runRestore = async () => { if (!selected) return; setBusy(true); setError('');
    try { await restore(nativeProjectId ?? ownerId, selected); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : t('恢复失败')); }
    finally { setBusy(false); } };
  const reloadNative = async () => {
    if (!nativeProjectId) return;
    const [points, operations] = await Promise.allSettled([
      loadRecoveryRows(ownerId, nativeProjectId), listNativeProjectPendingTransfers(nativeProjectId),
    ]);
    if (points.status === 'fulfilled') {
      setRows(points.value);
      setSelected((id) => points.value.some((point) => point.id === id) ? id : '');
    }
    if (operations.status === 'fulfilled') setPending(operations.value);
    setReadError(points.status === 'rejected' ? t('读取恢复点失败')
      : operations.status === 'rejected' ? t('读取待处理操作失败') : '');
    return { points, operations };
  };
  const checkOperation = async () => {
    if (!nativeProjectId || !operationId.trim()) return;
    setBusy(true); setOperationStatus('');
    try {
      const id = operationId.trim().replace(/^recovery-/, '');
      const result = await reloadNative();
      setOperationStatus(result?.operations.status === 'fulfilled' && result.operations.value.some((item) => item.operationId === id) ? t('已找到原操作，可在待处理操作中继续核对。')
        : result?.points.status === 'fulfilled' && result.points.value.some((item) => item.id === `recovery-${id}`) ? t('已找到该操作的更新前恢复点，可以选择恢复。')
          : result?.operations.status === 'rejected' || result?.points.status === 'rejected' ? t('查询操作失败')
          : t('未找到该操作的提交回执或未完成记录。'));
    } catch (cause) { setOperationStatus(cause instanceof Error ? cause.message : t('查询操作失败')); }
    finally { setBusy(false); }
  };
  const settleOperation = async (operation: NativeProjectPendingTransfer, action: 'continue' | 'abandon') => {
    if (busy) return;
    setBusy(true); setError(''); setOperationStatus('');
    try {
      await settle(nativeProjectId ?? ownerId, operation.operationId, action);
      setPending((items) => items.filter((item) => item.operationId !== operation.operationId));
      setOperationStatus(t(action === 'continue' ? '原操作已处理完成。' : '原操作已结束，已写入的文件仍保留。'));
      await reloadNative();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('处理原操作失败')); }
    finally { setBusy(false); }
  };
  return <ModalOverlay isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel={t('项目导入恢复点')} zIndex={350} closeOnBackdrop={!busy}
    className="ui-dialog-surface flex max-h-[calc(100dvh-24px)] w-[min(560px,calc(100vw-24px))] flex-col">
    <header className="flex items-center justify-between border-b border-canvas-border p-3"><h2 className="text-sm font-semibold text-canvas-text">{t('项目导入恢复点')}</h2><PopupCloseButton disabled={busy} onClick={onClose} /></header>
    <div className="space-y-3 overflow-y-auto p-3 text-xs text-canvas-text-secondary" aria-busy={busy || loading}>
      <p>{t(nativeProjectId ? '恢复会替换项目正文、画布、分集和剪辑工程；当前状态会另存独立备份，聊天、任务、预算和记忆保留。早期没有独立备份的恢复点只支持无素材、结构不变的恢复。' : '恢复会替换整部剧的画布、分集、设置与创作资产。当前状态会另存恢复点，聊天和记忆保留。')}</p>
      {nativeProjectId && <div className="flex flex-wrap items-center gap-2"><input className="ui-input min-w-0 flex-1" aria-label={t('原操作 ID')} value={operationId} onChange={(event) => setOperationId(event.target.value)} placeholder={t('输入原操作 ID 查询提交结果')} />
        <button type="button" className="ui-btn ui-btn--secondary" disabled={busy || loading || !operationId.trim()} onClick={() => void checkOperation()}>{t('查询操作')}</button></div>}
      {pending.length > 0 && <section aria-label={t('待处理操作')} className="space-y-2">
        <h3 className="font-medium text-canvas-text">{t('待处理操作')}</h3>
        {pending.map((operation) => <div key={operation.operationId} className="ui-card space-y-2 p-2">
          <p>{t(operation.kind === 'export' ? '导出' : operation.kind === 'update' ? '导入更新' : '恢复项目')}
            {operation.phase === 'db_committed' && ` · ${t('数据已提交，待收尾')}`}</p>
          <p className="break-all">{new Date(operation.updatedAt).toLocaleString()} · {operation.operationId}</p>
          <div className="flex flex-wrap gap-2">
            {(operation.kind !== 'export' || operation.phase !== 'prepared') && <button type="button" className="ui-btn ui-btn--secondary" disabled={busy}
              onClick={() => void settleOperation(operation, 'continue')}>{t(operation.kind === 'export' ? '核验原导出' : '继续原操作')}</button>}
            {operation.phase !== 'db_committed' && <button type="button" className="ui-btn ui-btn--secondary" disabled={busy}
              onClick={() => void settleOperation(operation, 'abandon')}>{t(operation.kind === 'export' ? '结束导出登记' : '撤销未提交操作')}</button>}
          </div>
        </div>)}
        {pending.some((operation) => operation.kind === 'export') && <p>{t('结束导出登记会解除项目阻塞，保留原导出文件和回执。')}</p>}
      </section>}
      {operationStatus && <p role="status">{operationStatus}</p>}
      {loading ? <p role="status">{t('正在读取…')}</p> : !rows.length && !readError ? <p>{t('此项目尚无导入恢复点')}</p> : rows.map((row) => <label key={row.id} className="ui-card flex items-center gap-2 p-3">
        <input type="radio" name="project-import-recovery" disabled={busy} checked={selected === row.id} onChange={() => setSelected(row.id)} />
        <span>{new Date(row.createdAt).toLocaleString()} · {t(row.label)} · {row.episodeCount} {t('个分集')}{nativeProjectId ? ` · ${row.id}` : ''}</span></label>)}
      {selected && <p className="ui-alert">{t('确认将当前项目恢复为所选时间点？')}</p>}
      {readError && <p role="alert" className="ui-alert ui-alert--danger">{readError}</p>}
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
    </div>
    <footer className="flex justify-end gap-2 border-t border-canvas-border p-3"><button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={onClose}>{t('取消')}</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy || loading || !!readError || !selected || pending.length > 0} onClick={() => void runRestore()}>{t(busy ? '正在处理…' : '确认恢复')}</button></footer>
  </ModalOverlay>;
}
