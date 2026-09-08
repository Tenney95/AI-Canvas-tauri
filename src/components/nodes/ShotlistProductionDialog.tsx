import { useId, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { MAX_SHOTLIST_PRODUCTION_BATCH, prepareShotlistProduction } from '../../services/shotlistProductionService';
import type { ShotlistProductionKind } from '../../types/shotlist';
import { useT } from '../../i18n';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

export default function ShotlistProductionDialog({ nodeId, rowId, onClose }: { nodeId: string; rowId?: string; onClose: () => void }) {
  const t = useT();
  const prefix = useId();
  const rows = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.shotlistRows);
  const [selection, setSelection] = useState(rowId ? [rowId] : []);
  const selected = selection.filter((id) => rows?.some((row) => row.id === id));
  const prepare = (kind: ShotlistProductionKind) => {
    const state = useAppStore.getState();
    try {
      const results = prepareShotlistProduction({ projectId: state.currentProjectId ?? '', baseRevision: state.getCurrentRevision() }, nodeId, selected, kind);
      window.dispatchEvent(new CustomEvent('canvas-focus-nodes', { detail: { nodeIds: results.map((item) => item.nodeId) } }));
      state.showToast(t('已创建或定位制作节点，请核对内容后生成'));
      onClose();
    } catch (error) { state.showToast(error instanceof Error ? error.message : t('准备制作节点失败'), 'error'); }
  };
  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('镜头制作准备')}>
    <div className="ui-card flex max-h-[80vh] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden text-canvas-text">
      <header className="ui-card__header flex items-center gap-2"><h2 className="flex-1 text-sm font-semibold">{t('镜头制作准备')}</h2><PopupCloseButton onClick={onClose} ariaLabel={t('关闭制作准备')} /></header>
      <div className="min-h-0 overflow-y-auto p-4">
        <p className="mb-3 text-xs leading-6 text-canvas-text-secondary">{t('每次最多选择 12 镜。仅准备节点，已有同类节点会被定位，内容不会覆盖。')}</p>
        <div className="grid gap-2 sm:grid-cols-2">{rows?.map((row) => <div key={row.id} className="ui-card min-w-0 p-2 text-xs">
          <input id={`${prefix}-${row.id}`} className="ui-checkbox" type="checkbox" checked={selected.includes(row.id)}
            disabled={!selected.includes(row.id) && selected.length >= MAX_SHOTLIST_PRODUCTION_BATCH}
            onChange={(event) => setSelection((current) => event.target.checked ? [...new Set([...current, row.id])] : current.filter((id) => id !== row.id))} />
          <label htmlFor={`${prefix}-${row.id}`} className="flex min-w-0 gap-2"><span>{t('镜头 {number}', { number: row.shotNo })}</span><span className="truncate text-canvas-text-secondary">{row.content || row.dialogue || '—'}</span></label>
        </div>)}</div>
        <p className="mt-3 text-xs leading-6 text-canvas-text-muted">{t('配音需有对白，生成前选择语音模型和音色。视频沿用参考画面；导演台附带镜头说明，不会自动打开。')}</p>
      </div>
      <footer className="ui-card__footer flex flex-wrap justify-end gap-2">
        <button className="ui-btn" disabled={!selected.length} onClick={() => prepare('voiceover')}>{t('配音节点')}</button>
        <button className="ui-btn" disabled={!selected.length} onClick={() => prepare('video')}>{t('视频节点')}</button>
        <button className="ui-btn" disabled={!selected.length} onClick={() => prepare('director')}>{t('导演台节点')}</button>
      </footer>
    </div>
  </ModalOverlay>;
}
