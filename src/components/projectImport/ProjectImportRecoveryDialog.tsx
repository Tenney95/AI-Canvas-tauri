/** 归档更新恢复点；恢复前再次确认，并保留当前状态作为新的恢复点。 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { listProjectImportRecoveries } from '../../services/indexedDb/projectImportRepository';
import { listNativeContentRecoveryPoints } from '../../services/indexedDb/nativeProjectRepository';
import type { NativeProjectViewItem } from '../../store/nativeProjectView';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import { useT } from '../../i18n';

export default function ProjectImportRecoveryDialog({ ownerId, onClose }: { ownerId: string; onClose: () => void }) {
  const t = useT(), restore = useAppStore((state) => state.restoreProjectImport);
  const project = useAppStore((state) => state.projects.find((item) => item.id === ownerId));
  const binding = project && 'nativeView' in project ? (project as NativeProjectViewItem).nativeView : undefined;
  const [rows, setRows] = useState<Array<{ id: string; createdAt: number; label: string; episodeCount: number }>>([]), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [operationId, setOperationId] = useState(''), [operationStatus, setOperationStatus] = useState('');
  useEffect(() => {
    let active = true;
    const load = binding ? listNativeContentRecoveryPoints(binding.projectId).then((items) => items.map((item) => ({
      id: item.operationId, createdAt: item.createdAt, label: '更新前', episodeCount: item.aggregate.episodes.length })))
      : listProjectImportRecoveries(ownerId).then((items) => items.map((item) => ({ id: item.id,
        createdAt: item.createdAt, label: item.label, episodeCount: item.records.length - 1 })));
    void load.then((result) => { if (active) setRows(result); }, (cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : t('读取恢复点失败'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ownerId, binding?.projectId, t]);
  const runRestore = async () => { if (!selected) return; setBusy(true); setError('');
    try { await restore(ownerId, selected); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : t('恢复失败')); }
    finally { setBusy(false); } };
  const checkOperation = async () => {
    if (!binding || !operationId.trim()) return;
    setBusy(true); setOperationStatus('');
    try {
      const id = operationId.trim().replace(/^recovery-/, '');
      const result = await listNativeContentRecoveryPoints(binding.projectId);
      const point = result.find((item) => item.operationId === `recovery-${id}`);
      setOperationStatus(point ? t('已找到该操作的提交回执和更新前恢复点，可以选择恢复。') : t('未找到该操作的提交回执；请重新打开项目核对，勿直接重复操作。'));
      setRows(result.map((item) => ({ id: item.operationId, createdAt: item.createdAt, label: '更新前', episodeCount: item.aggregate.episodes.length })));
    } catch (cause) { setOperationStatus(cause instanceof Error ? cause.message : t('查询操作失败')); }
    finally { setBusy(false); }
  };
  return <ModalOverlay isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel={t('项目导入恢复点')} zIndex={350} closeOnBackdrop={!busy}
    className="ui-dialog-surface flex max-h-[calc(100dvh-24px)] w-[min(560px,calc(100vw-24px))] flex-col">
    <header className="flex items-center justify-between border-b border-canvas-border p-3"><h2 className="text-sm font-semibold text-canvas-text">{t('项目导入恢复点')}</h2><PopupCloseButton disabled={busy} onClick={onClose} /></header>
    <div className="space-y-3 overflow-y-auto p-3 text-xs text-canvas-text-secondary" aria-busy={busy || loading}>
      <p>{t(binding ? '恢复会替换项目正文、画布、分集和剪辑工程；当前状态会另存独立备份，聊天、任务、预算和记忆保留。早期没有独立备份的恢复点只支持无素材、结构不变的恢复。' : '恢复会替换整部剧的画布、分集、设置与创作资产。当前状态会另存恢复点，聊天和记忆保留。')}</p>
      {binding && <div className="flex flex-wrap items-center gap-2"><input className="ui-input min-w-0 flex-1" aria-label={t('原操作 ID')} value={operationId} onChange={(event) => setOperationId(event.target.value)} placeholder={t('输入原操作 ID 查询提交结果')} />
        <button type="button" className="ui-btn ui-btn--secondary" disabled={busy || !operationId.trim()} onClick={() => void checkOperation()}>{t('查询操作')}</button></div>}
      {operationStatus && <p role="status">{operationStatus}</p>}
      {loading ? <p role="status">{t('正在读取…')}</p> : !rows.length ? <p>{t('此项目尚无导入恢复点')}</p> : rows.map((row) => <label key={row.id} className="ui-card flex items-center gap-2 p-3">
        <input type="radio" name="project-import-recovery" disabled={busy} checked={selected === row.id} onChange={() => setSelected(row.id)} />
        <span>{new Date(row.createdAt).toLocaleString()} · {t(row.label)} · {row.episodeCount} {t('个分集')}{binding ? ` · ${row.id}` : ''}</span></label>)}
      {selected && <p className="ui-alert">{t('确认将当前项目恢复为所选时间点？')}</p>}
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
    </div>
    <footer className="flex justify-end gap-2 border-t border-canvas-border p-3"><button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={onClose}>{t('取消')}</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !selected} onClick={() => void runRestore()}>{t(busy ? '正在恢复…' : '确认恢复')}</button></footer>
  </ModalOverlay>;
}
