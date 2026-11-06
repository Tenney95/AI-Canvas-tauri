/**
 * EpisodeAssetPicker — 提供本集资产选择界面与交互。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { EpisodeAssetKind, EpisodeAssetPickerSnapshot } from '../../types/episodeAssets';
export type { EpisodeAssetPickerSnapshot } from '../../types/episodeAssets';
import { resolveDramaAssetImageRef } from '../../services/dramaAssetPrompt';
import MentionPicker, { type MentionPickerItem } from '../shared/MentionPicker';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

interface EpisodeAssetPickerProps {
  kind: EpisodeAssetKind;
  initialQuery?: string;
  onSelect: (assetId: string, scope: 'project' | 'global') => Promise<void>;
  onClose: () => void;
  snapshot?: EpisodeAssetPickerSnapshot;
  onLoadGlobal?: () => Promise<void>;
}

export default function EpisodeAssetPicker(props: EpisodeAssetPickerProps) {
  return props.snapshot
    ? <EpisodeAssetPickerView {...props} snapshot={props.snapshot} />
    : <LocalEpisodeAssetPicker {...props} />;
}

function LocalEpisodeAssetPicker(props: EpisodeAssetPickerProps) {
  const data = useAppStore(useShallow((state) => ({
    library: state.dramaAssets, globalCharacters: state.globalCharacters, globalProps: state.globalProps,
    nodes: state.nodes, loadGlobalCharacters: state.loadGlobalCharacters, loadGlobalDramaAssets: state.loadGlobalDramaAssets,
  })));
  return <EpisodeAssetPickerView {...props} snapshot={data}
    onLoadGlobal={() => props.kind === 'character' ? data.loadGlobalCharacters() : data.loadGlobalDramaAssets()} />;
}

/** 选择业务卡片，与视频输入选择不同：无图片的角色、道具也可以绑定。 */
function EpisodeAssetPickerView({ kind, initialQuery = '', onSelect, onClose, snapshot, onLoadGlobal }:
  EpisodeAssetPickerProps & { snapshot: EpisodeAssetPickerSnapshot }) {
  const t = useT();
  const listId = useId();
  const { library, globalCharacters, globalProps, nodes } = snapshot;
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const loadRequestRef = useRef(0);
  const [highlightedKey, setHighlightedKey] = useState<string>();
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const loadGlobal = async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setLoadError('');
    try {
      if (!onLoadGlobal) throw new Error(t('加载资产失败，请重试'));
      await onLoadGlobal();
    } catch (cause) {
      if (aliveRef.current && loadRequestRef.current === request) setLoadError(cause instanceof Error ? cause.message : t('加载资产失败，请重试'));
    } finally {
      if (aliveRef.current && loadRequestRef.current === request) setLoading(false);
    }
  };
  const loadingCurrent = scope === 'global' && loading;
  const visibleError = error || (scope === 'global' ? loadError : '');

  const source = scope === 'global' ? kind === 'character' ? globalCharacters : globalProps
    : kind === 'character' ? library.characters : library.props;
  const term = query.trim().toLocaleLowerCase();
  const assets = source.filter((asset) => !term || `${asset.name}\n${asset.summary}\n${asset.kind === 'character' ? asset.aliases?.join(' ') ?? '' : asset.ownerName ?? ''}`.toLocaleLowerCase().includes(term));
  const select = async (assetId: string) => {
    if (busyRef.current || loadingCurrent) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onSelect(assetId, scope);
      if (aliveRef.current) onClose();
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : t('绑定资产失败'));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };
  const items: MentionPickerItem[] = assets.map((asset, index) => ({
    key: asset.id, domId: `${listId}-${index}`, label: asset.name, title: `${asset.name}\n${asset.summary}`,
    thumbnailUrl: resolveDramaAssetImageRef(asset, scope === 'project' ? nodes : [])?.imageUrl,
    icon: kind === 'character' ? 'lucide:user-round' : 'lucide:box', disabled: busy || loadingCurrent,
    onSelect: () => { void select(asset.id); },
  }));
  const activeKey = items.find((item) => item.key === highlightedKey)?.key ?? items[0]?.key;
  const close = () => { if (!busyRef.current) onClose(); };
  const changeScope = (id: string) => {
    if (busyRef.current || (id !== 'project' && id !== 'global')) return;
    setScope(id);
    setHighlightedKey(undefined);
    setError('');
    if (id === 'global' && scope !== 'global') void loadGlobal();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busyRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const element = event.target instanceof Element ? event.target : null;
    const tab = element?.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
      const index = tabs.indexOf(tab as HTMLElement);
      const next = (index + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) + tabs.length) % tabs.length;
      changeScope(next === 0 ? 'project' : 'global');
      tabs[next]?.focus();
      return;
    }
    const option = element?.closest('[role="option"]');
    if (!option) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      items.find((item) => item.domId === option.id)?.onSelect();
    } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index = items.findIndex((item) => item.domId === option.id);
      const next = (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + items.length) % items.length;
      const item = items[next];
      if (item) { setHighlightedKey(item.key); document.getElementById(item.domId!)?.focus(); }
    }
  };
  return (
    <ModalOverlay isOpen onClose={close} ariaLabel={t(kind === 'character' ? '选择本集角色资产' : '选择本集道具资产')}
      zIndex={320} className="ui-dialog-surface w-[min(640px,calc(100vw-24px))] max-h-[80vh]">
      <div className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t(kind === 'character' ? '选择本集角色资产' : '选择本集道具资产')}</h2>
        <PopupCloseButton disabled={busy} onClick={close} />
      </div>
      <div className="min-h-0 overflow-y-auto p-3" onKeyDown={keyDown} onClick={(event) => {
        if (event.detail !== 0 || !(event.target instanceof Element) || busyRef.current) return;
        const option = event.target.closest('[role="option"]');
        if (option) items.find((item) => item.domId === option.id)?.onSelect();
        const tab = event.target.closest('[role="tab"]');
        if (tab) {
          const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
          changeScope(tabs.indexOf(tab) === 0 ? 'project' : 'global');
        }
      }}>
        <div className="ui-input-group mb-2">
          <span className="ui-input-affix"><Icon icon="lucide:search" className="h-3.5 w-3.5" /></span>
          <input className="ui-input ui-input--sm" type="search" value={query} disabled={busy}
            onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索名称、简介…')} aria-label={t('搜索资产')} />
        </div>
        <MentionPicker tabs={[{ id: 'project', label: t('本项目资产') }, { id: 'global', label: t('全局资产') }]}
          activeTab={scope} onTabChange={changeScope} items={items} listId={listId} activeKey={activeKey}
          onItemHover={setHighlightedKey} ariaLabel={t('选择资产')}
          emptyText={loadingCurrent ? t('正在加载资产…') : term ? t('没有匹配的资产') : t('当前分类还没有资产')}
          footer={<span className="text-xs text-canvas-text-muted">{scope === 'global'
            ? t('选择后复制到本剧并绑定，包含已有参考图、声音和动作。')
            : t('选择已有资产建立关联，无图片的条目也可以选择。')}</span>} />
        {busy && <p role="status" className="mt-2 flex items-center gap-1 text-xs text-canvas-text-muted">
          <Icon icon="lucide:loader-circle" className="h-3.5 w-3.5 animate-spin" />{scope === 'global' ? t('正在复制并绑定…') : t('正在绑定…')}
        </p>}
        {visibleError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2">
          <p className="ui-error min-w-0 flex-1 break-words">{visibleError}</p>
          {scope === 'global' && !busy && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { void loadGlobal(); }}>{t('重试')}</button>}
        </div>}
      </div>
    </ModalOverlay>
  );
}
