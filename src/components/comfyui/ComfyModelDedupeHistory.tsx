import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import { listComfyModelDedupeHistory } from '../../services/comfyModelDedupeService';
import type { ComfyModelDedupeHistory } from '../../types/comfyModelDedupe';
import { formatSize } from '../../utils/assetFormat';
import ModalOverlay from '../shared/ModalOverlay';

export default function ComfyModelDedupeHistoryDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [history, setHistory] = useState<ComfyModelDedupeHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const alive = useRef(true);
  const load = useCallback(() => listComfyModelDedupeHistory()
    .then((next) => {
      if (alive.current) { setHistory(next); setError(''); }
    }).catch((failure: unknown) => {
      if (alive.current) setError(String(failure));
    }).finally(() => { if (alive.current) setLoading(false); }), []);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);
  const statuses = {
    completed: t('已完成'), partial: t('部分完成'), failed: t('失败'), interrupted: t('中断，需核对'),
    pending: t('未处理'), processing: t('处理中，需核对'), needsRecovery: t('需要恢复'),
  };

  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('模型替换历史')} className="flex max-h-[85vh] w-[calc(100%_-_24px)] max-w-5xl flex-col bg-canvas-surface" zIndex={260}>
    <div className="ui-row ui-row--between shrink-0 border-b border-canvas-border p-3">
      <h2 className="text-sm font-semibold">{t('模型替换历史')}</h2>
      <div className="ui-row"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={loading} onClick={() => { setLoading(true); void load(); }}><Icon icon="lucide:refresh-cw" width={14} />{t('刷新')}</button><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('关闭')} onClick={onClose}><Icon icon="lucide:x" width={16} /></button></div>
    </div>
    <div className="ui-scroll min-h-0 flex-1 p-3 space-y-3">
      <p className="ui-hint">{t('保留最近 100 次操作。这里记录当时的保留路径、替换路径和结果，供参照；不代表文件目前仍存在，也不提供自动回滚。中断操作请使用模型去重页的恢复入口。')}</p>
      {loading && <p className="ui-hint" role="status">{t('正在读取历史…')}</p>}
      {error && <p className="ui-alert ui-alert--danger" role="alert">{error}</p>}
      {!!history?.warnings.length && <ul className="ui-alert ui-alert--warning flex-col text-xs">{history.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {!loading && !history?.entries.length && !error && <p className="ui-empty">{t('暂无替换历史；后续单组和全部替换都会记录。')}</p>}
      {history?.entries.map((entry) => <details key={entry.id} className="ui-card p-3 text-xs" onToggle={(event) => {
        const open = event.currentTarget.open;
        setExpanded((current) => { const next = new Set(current); if (open) next.add(entry.id); else next.delete(entry.id); return next; });
      }}>
        <summary className="cursor-pointer space-y-1">
          <span className="font-medium">{new Date(entry.createdAt).toLocaleString()} · {entry.rootLabel} · {statuses[entry.status]}</span>
          <p className="ui-hint">{t('成功 {completed} · 失败 {failed} · 未处理 {unprocessed} · 释放 {size}', { completed: entry.completed, failed: entry.failed, unprocessed: entry.unprocessed, size: formatSize(entry.reclaimedBytes) })}</p>
        </summary>
        {expanded.has(entry.id) && <div className="mt-3 space-y-2">
          {entry.items.map((item, index) => <div key={index} className="rounded-lg border border-canvas-border p-2 space-y-1">
            <p>{statuses[item.status]} · {item.linkType === 'hardlink' ? t('硬链接') : t('软链接')} · {formatSize(item.size)}</p>
            <p className="break-all font-mono select-text">{t('保留：')}{item.keeperRelativePath}</p>
            <p className="break-all font-mono select-text">{t('替换：')}{item.targetRelativePath}</p>
            <p className="ui-hint break-all select-text">{t('内容摘要：')}{item.hash}</p>
            {item.message && <p className="ui-hint">{item.message}</p>}
          </div>)}
        </div>}
      </details>)}
    </div>
  </ModalOverlay>;
}
