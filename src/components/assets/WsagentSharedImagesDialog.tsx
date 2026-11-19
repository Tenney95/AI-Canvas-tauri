import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import {
  insertWsagentImage, listWsagentSharedImages, observeWsagentBinding, previewWsagentImage,
} from '../../services/wsagentSharedImages';
import type { WsagentSharedPage } from '../../types/wsagentShared';
import { formatSize } from '../../utils/assetFormat';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import WsagentConnectControl from './WsagentConnectControl';

export default function WsagentSharedImagesDialog({ ownerId, ownerName, onClose }: {
  ownerId: string; ownerName: string; onClose: () => void;
}) {
  const t = useT();
  const [page, setPage] = useState<WsagentSharedPage>();
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState<{ id: string; dataUrl: string }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<AbortController>(null);

  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try { await action(controller.signal); }
    catch (cause) {
      if (!controller.signal.aborted) setError(typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '共享图片操作失败');
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }, []);

  const refresh = useCallback((nextOffset = 0) => run(async (signal) => {
    const nextPage = await listWsagentSharedImages(ownerId, nextOffset);
    if (signal.aborted) return;
    setPage(nextPage);
    setOffset(nextOffset);
  }), [ownerId, run]);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    return () => { mounted = false; active.current?.abort(); active.current = null; };
  }, [refresh]);

  // 首屏自动更新已发布素材。翻页、预览和插入继续使用当前页面快照。
  useEffect(() => {
    if (offset !== 0) return;
    let live = true;
    let reading = false;
    const update = async () => {
      if (document.hidden || reading || active.current) return;
      reading = true;
      try {
        const next = await listWsagentSharedImages(ownerId);
        if (live && !active.current) setPage((current) => (
          current && current.nextOffset === next.nextOffset && current.assets.length === next.assets.length
          && current.assets.every((asset, index) => asset.id === next.assets[index].id) ? current : next
        ));
      } catch { /* 用户可通过刷新重试并查看错误。 */ }
      finally { reading = false; }
    };
    const unsubscribe = observeWsagentBinding(ownerId, () => { void update(); });
    const timer = window.setInterval(() => { void update(); }, 5000);
    return () => { live = false; window.clearInterval(timer); unsubscribe(); };
  }, [offset, ownerId]);

  const close = () => { active.current?.abort(); onClose(); };
  const toast = (message: string) => useAppStore.getState().showToast(message);
  const previewAsset = page?.assets.find((asset) => asset.id === preview?.id);

  return <ModalOverlay isOpen onClose={close} ariaLabel={t('WSAGENT 共享图片')} zIndex={320}
    closeOnBackdrop={false} className="mx-3 max-h-[85vh] w-full max-w-2xl ui-dialog-surface">
    <header className="ui-card__header shrink-0">
      <div className="min-w-0 flex-1"><h3 className="ui-card__title">{t('WSAGENT 共享图片')}</h3>
        <p className="ui-card__desc break-words">{ownerName}</p></div>
      <div className="ui-card__header-actions"><PopupCloseButton onClick={close} /></div>
    </header>
    <div className="ui-card__body min-h-0 space-y-3 overflow-y-auto">
      <section className="rounded-lg border border-canvas-border p-2" aria-label={t('项目配对')}>
        <WsagentConnectControl scopeOwner={ownerId} allowDisconnect />
      </section>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-canvas-text">{t('已发布图片')}</h4>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={14} aria-hidden="true" />{t('刷新')}
        </button>
      </div>
      {error && <p className="ui-alert ui-alert--danger" role="alert">{error}</p>}
      {!page && busy && <p className="text-xs text-canvas-text-secondary" role="status">{t('正在读取共享图片…')}</p>}
      {page?.assets.length === 0 && <p className="text-xs text-canvas-text-secondary">{t('还没有共享图片。可从项目图片的右键菜单或互联节点发布。')}</p>}
      {previewAsset && preview && <figure className="space-y-2 rounded-lg border border-canvas-border p-2">
        <img className="mx-auto max-h-52 max-w-full object-contain" src={preview.dataUrl} alt={previewAsset.name} />
        <figcaption className="break-words text-center text-xs text-canvas-text-secondary">{previewAsset.name}</figcaption>
      </figure>}
      {!!page?.assets.length && <ul className="space-y-1">
        {page.assets.map((asset) => <li key={asset.id} className="flex flex-wrap items-center gap-2 rounded-md border border-canvas-border p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-canvas-text" title={asset.name}>{asset.name}</p>
            <p className="text-xs text-canvas-text-secondary">{asset.source === 'canvas' ? 'AI Canvas' : 'WSAGENT'} · {formatSize(asset.bytes)}</p>
          </div>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => void run(async (signal) => {
            if (preview?.id === asset.id) { setPreview(undefined); return; }
            const { dataUrl } = await previewWsagentImage(ownerId, asset.id);
            if (!signal.aborted) setPreview({ id: asset.id, dataUrl });
          })}>{t(preview?.id === asset.id ? '收起预览' : '预览')}</button>
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => void run(async (signal) => {
            await insertWsagentImage(ownerId, asset.id, signal, useAppStore.getState().getCurrentRevision());
            if (!signal.aborted) { toast(t('共享图片已插入画布')); onClose(); }
          })}>{t('插入画布')}</button>
        </li>)}
      </ul>}
      {(offset > 0 || page?.nextOffset != null) && <nav className="flex justify-end gap-2" aria-label={t('共享图片分页')}>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || offset === 0}
          onClick={() => void refresh(Math.max(0, offset - 80))}>{t('上一页')}</button>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || page?.nextOffset == null}
          onClick={() => page?.nextOffset != null && void refresh(page.nextOffset)}>{t('下一页')}</button>
      </nav>}
    </div>
  </ModalOverlay>;
}
