import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { bindStoryboardCellToShot, describeStoryboardGrid } from '../../services/shotlistStoryboardService';
import { useT } from '../../i18n';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import Select from '../shared/Select';

export default function ShotlistStoryboardDialog({ nodeId, rowId, onClose }: { nodeId: string; rowId: string; onClose: () => void }) {
  const t = useT();
  const nodes = useAppStore((state) => state.nodes);
  const boards = nodes.filter((node) => node.type === 'ai-storyboard');
  const [sourceId, setSourceId] = useState(boards[0]?.id ?? '');
  const [cellIndex, setCellIndex] = useState('0');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const source = boards.find((node) => node.id === sourceId);
  const row = nodes.find((node) => node.id === nodeId)?.data.shotlistRows?.find((item) => item.id === rowId);
  const grid = (() => {
    if (!source) return null;
    try { return describeStoryboardGrid(source.data); } catch { return null; }
  })();
  const close = () => { controller.current?.abort(); onClose(); };
  const bind = async () => {
    if (controller.current) return;
    const state = useAppStore.getState();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      await bindStoryboardCellToShot({ projectId: state.currentProjectId ?? '', baseRevision: state.getCurrentRevision(),
        nodeId, rowId, storyboardId: sourceId, cellIndex: Number(cellIndex), replaceExisting: !!row?.frame, signal: abort.signal });
      state.showToast(t('已裁出图片并绑定镜头'));
      onClose();
    } catch (error) {
      if (!abort.signal.aborted) state.showToast(error instanceof Error ? error.message : t('取画面失败'), 'error');
    } finally { controller.current = null; setBusy(false); }
  };
  const empty = source?.data.storyboardExtracted?.[Number(cellIndex)] && !source.data.storyboardOverrides?.[Number(cellIndex)];
  return <ModalOverlay isOpen onClose={close} ariaLabel={t('从宫格取画面')}>
    <div className="ui-card flex max-h-[80vh] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden text-canvas-text">
      <header className="ui-card__header flex items-center gap-2"><h2 className="flex-1 text-sm font-semibold">{t('从宫格取画面')}</h2><PopupCloseButton onClick={close} ariaLabel={t('关闭宫格取画面')} /></header>
      <div className="min-h-0 space-y-3 overflow-y-auto p-4">
        <p className="text-xs leading-6 text-canvas-text-secondary">{t('裁出真实图片并绑定当前镜头，原宫格保持不变。')}</p>
        <Select value={sourceId} onChange={(value) => { setSourceId(value); setCellIndex('0'); }} disabled={busy}
          options={boards.map((node) => ({ value: node.id, label: node.data.label || t('宫格分镜') }))}
          placeholder={t('选择宫格节点')} aria-label={t('选择宫格节点')} fixedMenu />
        {source && grid && <>
          <Select value={cellIndex} onChange={setCellIndex} disabled={busy} aria-label={t('选择宫格位置')} fixedMenu
            options={Array.from({ length: grid.rows * grid.cols }, (_, index) => ({ value: String(index),
              label: t('第 {row} 行，第 {col} 列', { row: Math.floor(index / grid.cols) + 1, col: index % grid.cols + 1 }),
              disabled: !!source.data.storyboardExtracted?.[index] && !source.data.storyboardOverrides?.[index],
            }))} />
          {(source.data.imageUrl || source.data.thumbnailUrl) && <img className="max-h-64 w-full rounded-lg object-contain" src={source.data.imageUrl || source.data.thumbnailUrl} alt={t('宫格原图')} />}
        </>}
        {!boards.length && <p className="text-xs text-canvas-text-muted">{t('当前画布还没有宫格节点')}</p>}
        {source && !grid && <p role="alert" className="text-xs">{t('宫格分割线无效')}</p>}
        {!!row?.frame && <p className="text-xs text-canvas-text-secondary">{t('将替换当前镜头绑定，原画面节点保留。')}</p>}
      </div>
      <footer className="ui-card__footer flex justify-end"><button type="button" className="ui-btn ui-btn--primary" disabled={busy || !row || !grid || !!empty} onClick={() => void bind()}>
        {t(busy ? '正在取画面…' : row?.frame ? '裁片并替换画面' : '裁片并绑定镜头')}
      </button></footer>
    </div>
  </ModalOverlay>;
}
