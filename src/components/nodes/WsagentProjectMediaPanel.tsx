import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check, Film, Image as ImageIcon } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import {
  insertWsagentProjectMedia, previewWsagentProjectMedia, readWsagentProjectMedia,
} from '../../services/wsagentProjectMedia';
import { getWsagentSharedStatus, observeWsagentBinding } from '../../services/wsagentSharedImages';
import type {
  WsagentProjectMediaFilter, WsagentProjectMediaItem, WsagentProjectMediaPage, WsagentProjectMediaSelections,
} from '../../types/wsagentShared';
import Tabs from '../shared/Tabs';

const kinds = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
] as const;

interface PanelProps {
  ownerId: string;
  nodeId: string;
  selections?: WsagentProjectMediaSelections;
}

export default function WsagentProjectMediaPanel(props: PanelProps) {
  const { ownerId } = props;
  const [peer, setPeer] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let changed = false;
    const dispose = observeWsagentBinding(ownerId, (status) => {
      changed = true;
      setPeer(status.peerProjectId);
    });
    void getWsagentSharedStatus(ownerId).then((status) => {
      if (current && !changed) setPeer(status.peerProjectId);
    }).catch(() => { /* 连接控件显示状态错误。 */ });
    return () => { current = false; dispose(); };
  }, [ownerId]);

  return peer && <PairedMedia key={peer} {...props} />;
}

function PairedMedia({ ownerId, nodeId, selections }: PanelProps) {
  const t = useT();
  const [filter, setFilter] = useState<WsagentProjectMediaFilter>('all');
  const [offsets, setOffsets] = useState([0]);
  const [pendingId, setPendingId] = useState<string>();
  const task = useRef<AbortController>(null);
  const offset = offsets.at(-1) ?? 0;
  useEffect(() => () => { task.current?.abort(); }, []);

  const select = (asset: WsagentProjectMediaItem) => {
    const state = useAppStore.getState();
    const current = state.nodes.find((node) => node.id === nodeId)?.data.wsagentMediaSelection;
    if (current?.[asset.kind]?.assetId === asset.id) return;
    state.updateNodeData(nodeId, { wsagentMediaSelection: {
      ...current, [asset.kind]: { assetId: asset.id, name: asset.name },
    } });
  };

  const take = async (asset: WsagentProjectMediaItem) => {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    setPendingId(asset.id);
    try {
      await insertWsagentProjectMedia(ownerId, asset, nodeId, controller.signal);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        const message = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : t('WSAGENT 素材获取失败');
        useAppStore.getState().showToast(message, 'error');
      }
    } finally {
      task.current = null;
      if (!controller.signal.aborted) setPendingId(undefined);
    }
  };

  return <section className="ui-stack" aria-label={t('WSAGENT 项目素材')}>
    <hr className="ui-divider" />
    <div className="ui-row ui-row--baseline ui-row--between">
      <span className="ui-subtitle">{t('项目素材')}</span>
      <span className="ui-hint">{t('选择素材后从右侧拉线')}</span>
    </div>
    <Tabs<WsagentProjectMediaFilter> items={kinds.map(({ value, label }) => ({ value, label: t(label) }))}
      size="sm" aria-label={t('素材类型')} value={filter} onChange={(next) => { setFilter(next); setOffsets([0]); }} />
    <MediaPage key={`${filter}:${offset}`} ownerId={ownerId} filter={filter} offset={offset} selections={selections}
      pendingId={pendingId} onSelect={select} onTake={(asset) => void take(asset)}
      onPrevious={() => setOffsets((current) => current.slice(0, -1))}
      onNext={(next) => setOffsets((current) => [...current, next])} />
  </section>;
}

function MediaPage({ ownerId, filter, offset, selections, pendingId, onSelect, onTake, onPrevious, onNext }: {
  ownerId: string;
  filter: WsagentProjectMediaFilter;
  offset: number;
  selections?: WsagentProjectMediaSelections;
  pendingId?: string;
  onSelect: (asset: WsagentProjectMediaItem) => void;
  onTake: (asset: WsagentProjectMediaItem) => void;
  onPrevious: () => void;
  onNext: (offset: number) => void;
}) {
  const t = useT();
  const [page, setPage] = useState<WsagentProjectMediaPage>();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let current = true;
    let pending = false;
    const refresh = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const next = await readWsagentProjectMedia(ownerId, filter, offset);
        if (current) { setPage(next); setOffline(false); }
      } catch {
        if (current) setOffline(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = offset === 0 ? window.setInterval(() => void refresh(), 4000) : undefined;
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [ownerId, filter, offset]);

  return <>
    {offline ? <p role="status" className="ui-alert ui-alert--warning">{t('暂时无法读取素材，请确认 WSAGENT 已打开')}</p>
      : !page ? <p role="status" className="ui-row ui-row--tight ui-hint">
        <span className="ui-spinner" aria-hidden="true" />{t('正在读取素材…')}
      </p> : page.assets.length === 0 && <p role="status" className="ui-hint">{t('暂无素材')}</p>}
    {!!page?.assets.length && <ul className="ui-list ui-scroll nowheel max-h-44">
      {page.assets.map((asset) => {
        const selected = selections?.[asset.kind]?.assetId === asset.id;
        return <li key={asset.id} className={`ui-list__item min-w-0${selected ? ' is-active' : ''}`}>
          <button type="button" aria-pressed={selected} title={t('选为输出 · {name}', { name: asset.name })}
            className="ui-btn ui-btn--ghost ui-btn--sm min-w-0 flex-1"
            onClick={() => onSelect(asset)} disabled={offline}>
            <MediaThumbnail ownerId={ownerId} asset={asset} />
            <span className="min-w-0 flex-1 truncate text-left">{asset.name}</span>
            {selected && <Check size={12} className="shrink-0" aria-hidden="true" />}
          </button>
          <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm shrink-0"
            disabled={offline || !!pendingId} onClick={() => onTake(asset)} title={asset.name}>
            {t(pendingId === asset.id ? '取用中…' : '取到画布')}
          </button>
        </li>;
      })}
    </ul>}
    {(offset > 0 || page?.nextOffset != null) && <div className="ui-row ui-row--tight justify-end">
      {offset > 0 && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onPrevious}>{t('上一页')}</button>}
      {page?.nextOffset != null && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm"
        onClick={() => { if (page.nextOffset != null) onNext(page.nextOffset); }}>{t('下一页')}</button>}
    </div>}
  </>;
}

function MediaThumbnail({ ownerId, asset }: { ownerId: string; asset: WsagentProjectMediaItem }) {
  const host = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<string>();
  const { id, kind } = asset;
  useEffect(() => {
    if (kind === 'audio' || !host.current) return;
    let current = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      void previewWsagentProjectMedia(ownerId, id).then((url) => {
        if (current) setPreview(url);
      }).catch(() => { /* 图片或视频可以只有原件。 */ });
    });
    observer.observe(host.current);
    return () => { current = false; observer.disconnect(); };
  }, [id, kind, ownerId]);
  const Icon = kind === 'video' ? Film : kind === 'audio' ? AudioLines : ImageIcon;
  return <span ref={host} className="flex h-5 w-6 shrink-0 items-center justify-center overflow-hidden rounded bg-canvas-surface text-canvas-text-muted" aria-hidden="true">
    {preview ? <img src={preview} alt="" className="h-full w-full object-cover" /> : <Icon size={13} />}
  </span>;
}
