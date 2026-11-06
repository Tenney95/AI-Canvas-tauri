/**
 * EpisodeAssetPanel — 提供本集角色与道具清单界面与交互。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { DramaAsset } from '../../types/dramaAssets';
import {
  emptyEpisodeAssetRoster, episodeScriptFingerprint, EPISODE_ASSET_LIMITS,
  type EpisodeAssetEntry, type EpisodeAssetKind,
  type EpisodeAssetPanelSnapshot, type EpisodeAssetPanelAction, type EpisodeAssetPanelActionResult,
} from '../../types/episodeAssets';
export type { EpisodeAssetPanelSnapshot, EpisodeAssetPanelAction, EpisodeAssetPanelActionResult } from '../../types/episodeAssets';
import {
  buildEpisodeAssetPanelSnapshot, executeEpisodeAssetPanelAction,
} from '../../services/episodeAssetService';
import { resolveDramaAssetImageRef } from '../../services/dramaAssetPrompt';
import ViewportImage from '../shared/ViewportImage';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import AssetExtractionPreviewDialog from './AssetExtractionPreviewDialog';
import EpisodeAssetPicker from './EpisodeAssetPicker';

interface EpisodeAssetPanelProps {
  episodeId: string;
  kind: EpisodeAssetKind;
  onBeforeExtract: () => Promise<boolean>;
  remoteHost?: {
    snapshot: EpisodeAssetPanelSnapshot;
    dispatchAction: (action: EpisodeAssetPanelAction) => Promise<EpisodeAssetPanelActionResult>;
  };
}

const nameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

function EntryEditor({ entry, busy, onSave, onClose }: {
  entry: EpisodeAssetEntry;
  busy: boolean;
  onSave: (entry: EpisodeAssetEntry) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [draft, setDraft] = useState(entry);
  const [aliases, setAliases] = useState(entry.aliases?.join('、') ?? '');
  const [appearances, setAppearances] = useState(entry.appearances?.join('\n') ?? '');
  const [error, setError] = useState('');
  const patch = (field: 'name' | 'summary' | 'visualNotes' | 'notes' | 'identity' | 'ownerName' | 'evidence', value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };
  const split = (value: string) => value.split(/[\n、,，;；]+/).map((part) => part.trim()).filter(Boolean);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !draft.name.trim()) return;
    setError('');
    try {
      await onSave({ ...draft, name: draft.name.trim(), aliases: split(aliases), appearances: split(appearances), updatedAt: Date.now() });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('保存本集条目失败'));
    }
  };
  const close = () => { if (!busy) onClose(); };
  return (
    <ModalOverlay isOpen onClose={close} ariaLabel={t('编辑本集条目')} zIndex={320}
      className="ui-dialog-surface w-[min(640px,calc(100vw-24px))] max-h-[85vh]">
      <div className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('编辑本集条目')}</h2>
        <PopupCloseButton disabled={busy} onClick={close} />
      </div>
      <form id={formId} className="min-h-0 space-y-3 overflow-y-auto p-3" onSubmit={(event) => { void submit(event); }}>
        <p className="text-xs text-canvas-text-muted">{t('本集信息单独保存，不会覆盖资产库中的通用设定。')}</p>
        <label className="ui-field"><span className="ui-label">{t('名称')}</span>
          <input className="ui-input ui-input--sm" autoFocus required maxLength={EPISODE_ASSET_LIMITS.name} disabled={busy}
            value={draft.name} onChange={(event) => patch('name', event.target.value)} />
        </label>
        {entry.kind === 'character' ? <>
          <label className="ui-field"><span className="ui-label">{t('别名')}</span>
            <input className="ui-input ui-input--sm" disabled={busy} value={aliases} maxLength={2000}
              onChange={(event) => setAliases(event.target.value)} placeholder={t('多个别名用顿号分隔')} />
          </label>
          <label className="ui-field"><span className="ui-label">{t('本集身份')}</span>
            <input className="ui-input ui-input--sm" disabled={busy} value={draft.identity ?? ''} maxLength={EPISODE_ASSET_LIMITS.identity}
              onChange={(event) => patch('identity', event.target.value)} />
          </label>
        </> : <label className="ui-field"><span className="ui-label">{t('所属人物')}</span>
          <input className="ui-input ui-input--sm" disabled={busy} value={draft.ownerName ?? ''} maxLength={EPISODE_ASSET_LIMITS.name}
            onChange={(event) => patch('ownerName', event.target.value)} />
        </label>}
        {([
          ['summary', '本集说明', EPISODE_ASSET_LIMITS.summary],
          ['visualNotes', '本集外观要点', EPISODE_ASSET_LIMITS.visualNotes],
          ['notes', '本集备注', EPISODE_ASSET_LIMITS.notes],
          ['evidence', '剧本依据', EPISODE_ASSET_LIMITS.evidence],
        ] as const).map(([field, label, maxLength]) => <label key={field} className="ui-field">
          <span className="ui-label">{t(label)}</span>
          <textarea className="ui-textarea min-h-20 resize-y" rows={2} maxLength={maxLength} disabled={busy}
            value={draft[field] ?? ''} onChange={(event) => patch(field, event.target.value)} />
        </label>)}
        <label className="ui-field"><span className="ui-label">{t('出现场次')}</span>
          <textarea className="ui-textarea min-h-20 resize-y" rows={2} disabled={busy} value={appearances}
            onChange={(event) => setAppearances(event.target.value)} placeholder={t('每行一个场次或位置')} maxLength={8000} />
        </label>
        {error && <p role="alert" className="ui-error break-words">{error}</p>}
      </form>
      <div className="flex shrink-0 justify-end gap-2 border-t border-canvas-border p-3">
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={close}>{t('取消')}</button>
        <button type="submit" form={formId} className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !draft.name.trim()}>
          {busy ? t('正在保存…') : t('保存本集条目')}
        </button>
      </div>
    </ModalOverlay>
  );
}

export default function EpisodeAssetPanel(props: EpisodeAssetPanelProps) {
  return props.remoteHost ? <EpisodeAssetPanelView {...props} host={props.remoteHost} /> : <LocalEpisodeAssetPanel {...props} />;
}

function LocalEpisodeAssetPanel(props: EpisodeAssetPanelProps) {
  const source = useAppStore(useShallow((state) => ({
    projects: state.projects, currentProjectId: state.currentProjectId, projectLoadStatus: state.projectLoadStatus,
    isCreatingProject: state.isCreatingProject, isReturningToStartPage: state.isReturningToStartPage,
    switchingProjectName: state.switchingProjectName, dramaAssets: state.dramaAssets, nodes: state.nodes,
    globalCharacters: state.globalCharacters, globalProps: state.globalProps,
  })));
  const snapshot = useMemo(() => buildEpisodeAssetPanelSnapshot(source, props.episodeId), [props.episodeId, source]);
  const dispatchAction = useCallback((action: EpisodeAssetPanelAction) => executeEpisodeAssetPanelAction(props.episodeId, props.kind, action),
    [props.episodeId, props.kind]);
  return <EpisodeAssetPanelView {...props} host={{ snapshot, dispatchAction }} />;
}

/** 内嵌与独立窗口共用纯快照视图；模型与保存只经过宿主 dispatcher。 */
function EpisodeAssetPanelView({ episodeId, kind, onBeforeExtract, host }: EpisodeAssetPanelProps & {
  host: NonNullable<EpisodeAssetPanelProps['remoteHost']>;
}) {
  const t = useT();
  const checkboxId = useId();
  const { episode, library, nodes } = host.snapshot;
  const snapshotRef = useRef(host.snapshot);
  useLayoutEffect(() => { snapshotRef.current = host.snapshot; }, [host.snapshot]);
  const roster = episode?.episodeAssetRoster ?? emptyEpisodeAssetRoster();
  const entries = kind === 'character' ? roster.characters : roster.props;
  const assets = kind === 'character' ? library.characters : library.props;
  const assetsById = useMemo(() => new Map<string, DramaAsset>(assets.map((asset) => [asset.id, asset] as const)), [assets]);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ entry: EpisodeAssetEntry; revision: number }>();
  const [picker, setPicker] = useState<{ entryId?: string; revision: number }>();
  const [preview, setPreview] = useState<{ items: EpisodeAssetEntry[]; revision: number; fingerprint: string }>();
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const ready = host.snapshot.ready && episode?.id === episodeId;
  const term = query.trim().toLocaleLowerCase();
  const filtered = entries.filter((entry) => !term || `${entry.name}\n${entry.summary}\n${entry.notes}\n${entry.aliases?.join(' ') ?? ''}`.toLocaleLowerCase().includes(term));
  const selected = entries.filter((entry) => selectedIds.has(entry.id));
  const promotable = selected.filter((entry) => !entry.boundDramaAssetId);
  const allSelected = filtered.length > 0 && filtered.every((entry) => selectedIds.has(entry.id));
  const sourceFingerprint = roster.sourceFingerprints?.[kind];
  const stale = Boolean(sourceFingerprint && sourceFingerprint !== episodeScriptFingerprint(episode?.episodeScript ?? ''));
  const assertVisible = () => {
    if (!aliveRef.current || !snapshotRef.current.ready || snapshotRef.current.episode?.id !== episodeId) throw new Error(t('项目已切换'));
  };
  const perform = async (action: () => Promise<void>, propagate = false) => {
    if (busyRef.current || !ready) {
      if (propagate) throw new Error(t('项目尚未就绪或正在保存，请稍后重试'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      assertVisible();
      await action();
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : t('更新本集清单失败'));
      if (propagate) throw cause;
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };
  const extract = () => perform(async () => {
    if (!await onBeforeExtract()) return;
    assertVisible();
    const result = await host.dispatchAction({ type: 'extract' });
    assertVisible();
    if (result.type !== 'candidates') throw new Error(t('提取来源已变化，请重新提取'));
    setPreview({ items: result.items, revision: result.revision, fingerprint: result.fingerprint });
  });
  const beginAdd = () => {
    const now = Date.now();
    setEditing({ revision: roster.revision, entry: {
      id: `episode-${crypto.randomUUID()}`, kind, name: '', summary: '', visualNotes: '', notes: '', createdAt: now, updatedAt: now,
    } });
  };
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="ui-input-group min-w-0 flex-1">
          <span className="ui-input-affix"><Icon icon="lucide:search" className="h-3.5 w-3.5" /></span>
          <input className="ui-input ui-input--sm" type="search" value={query} disabled={busy}
            onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索名称、简介…')} aria-label={t('搜索本集清单')} />
        </div>
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !ready} onClick={() => { void extract(); }}>
          <Icon icon={busy ? 'lucide:loader-circle' : 'lucide:sparkles'} className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />{t('AI 提取')}
        </button>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || !ready} onClick={beginAdd}>
          <Icon icon="lucide:plus" className="h-3.5 w-3.5" />{t('手动新增')}
        </button>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !ready}
          onClick={() => setPicker({ revision: roster.revision })}>{t('从资产库添加')}</button>
      </div>
      <p className="text-xs text-canvas-text-muted">{t('提取和编辑仅保存到本集；确认加入资产库后才创建正式资产。')}</p>
      {stale && <p role="status" className="ui-hint">{t('本集剧本已变化，可重新提取并核对；现有清单与绑定保持不变。')}</p>}
      {error && <p role="alert" className="ui-error break-words">{error}</p>}
      {entries.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !filtered.length}
          onClick={() => setSelectedIds((previous) => {
            const next = new Set(previous);
            for (const entry of filtered) { if (allSelected) next.delete(entry.id); else next.add(entry.id); }
            return next;
          })}>{allSelected ? t('取消全选') : t('选择当前结果')}</button>
        <span className="text-canvas-text-muted">{t('已选择 {count} 项', { count: selected.length })}</span>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm ml-auto" disabled={busy || !ready || !promotable.length}
          onClick={() => { void perform(async () => {
            await host.dispatchAction({ type: 'promote', entryIds: promotable.map((entry) => entry.id) });
            assertVisible();
            setSelectedIds(new Set());
          }); }}>{t('所选加入资产库')}</button>
      </div>}
      <div className="space-y-2" aria-busy={busy}>
        {filtered.map((entry) => {
          const bound = entry.boundDramaAssetId ? assetsById.get(entry.boundDramaAssetId) : undefined;
          const thumb = bound ? resolveDramaAssetImageRef(bound, nodes)?.imageUrl : undefined;
          const hasSameName = !entry.boundDramaAssetId && assets.some((asset) => nameKey(asset.name) === nameKey(entry.name));
          return <article key={entry.id} className={`ui-card p-3 ${selectedIds.has(entry.id) ? 'is-selected' : ''}`}>
            <div className="flex items-start gap-2">
              <span className="relative mt-1 shrink-0">
                <input id={`${checkboxId}-${entry.id}`} type="checkbox" checked={selectedIds.has(entry.id)} disabled={busy}
                  className="ui-checkbox" onChange={() => setSelectedIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                    return next;
                  })} />
                <label htmlFor={`${checkboxId}-${entry.id}`}><span className="sr-only">{t('选择{name}', { name: entry.name })}</span></label>
              </span>
              <span className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-canvas-border bg-canvas-surface">
                {thumb ? <ViewportImage src={thumb} alt="" className="h-full w-full object-cover" />
                  : <Icon icon={kind === 'character' ? 'lucide:user-round' : 'lucide:box'} className="h-5 w-5 text-canvas-text-muted" />}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="break-words text-sm font-semibold">{entry.name}</h3>
                <p className="whitespace-pre-wrap break-words text-xs text-canvas-text-secondary">{entry.summary || t('尚未填写本集说明')}</p>
                {entry.visualNotes && <p className="whitespace-pre-wrap break-words text-xs text-canvas-text-muted">{entry.visualNotes}</p>}
                {entry.appearances?.length ? <p className="break-words text-xs text-canvas-text-muted">{t('出现场次')}：{entry.appearances.join('、')}</p> : null}
                {entry.notes && <p className="whitespace-pre-wrap break-words text-xs text-canvas-text-muted">{t('本集备注')}：{entry.notes}</p>}
                {entry.evidence && <details className="text-xs text-canvas-text-muted"><summary className="cursor-pointer">{t('剧本依据')}</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words">{entry.evidence}</p>
                </details>}
                <p className={`break-words text-xs ${entry.boundDramaAssetId && !bound ? 'text-canvas-text-secondary' : 'text-canvas-text-muted'}`}>
                  {bound ? t('已绑定：{name}', { name: bound.name }) : entry.boundDramaAssetId ? t('绑定已失效，请重新选择资产') : t('尚未绑定资产')}
                </p>
                {hasSameName && <p className="text-xs text-canvas-text-muted">{t('资产库有同名条目，可选择绑定已有资产。')}</p>}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-canvas-border pt-2">
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !ready}
                onClick={() => setEditing({ entry, revision: roster.revision })}>{t('编辑本集信息')}</button>
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !ready}
                onClick={() => setPicker({ entryId: entry.id, revision: roster.revision })}>{entry.boundDramaAssetId ? t('更换绑定') : t('绑定已有资产')}</button>
              {entry.boundDramaAssetId ? <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !ready}
                onClick={() => { void perform(async () => { await host.dispatchAction({ type: 'bind', entryId: entry.id,
                  targetId: null, scope: 'project', expectedRevision: roster.revision }); }); }}>{t('解除绑定')}</button>
                : <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !ready}
                  onClick={() => { void perform(async () => {
                    await host.dispatchAction({ type: 'promote', entryIds: [entry.id] });
                    assertVisible();
                  }); }}>{t('加入资产库')}</button>}
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ml-auto" disabled={busy || !ready}
                onClick={() => { void perform(async () => { await host.dispatchAction({ type: 'remove-entry', entryId: entry.id,
                  expectedRevision: roster.revision }); }); }}>{t('移出本集')}</button>
            </div>
          </article>;
        })}
        {!filtered.length && <div role="status" className="ui-card items-center gap-2 p-3 text-center text-xs text-canvas-text-muted">
          <Icon icon={kind === 'character' ? 'lucide:users-round' : 'lucide:package-open'} className="h-6 w-6" />
          <p>{entries.length ? t('没有匹配的本集条目') : t(kind === 'character' ? '本集还没有角色清单' : '本集还没有道具清单')}</p>
          {!entries.length && <p>{t('可以从剧本 AI 提取、手动新增，或选择资产库中的已有条目。')}</p>}
        </div>}
      </div>
      {editing && <EntryEditor key={editing.entry.id} entry={editing.entry} busy={busy} onClose={() => setEditing(undefined)}
        onSave={(entry) => perform(async () => { await host.dispatchAction({ type: 'save-entry', entry, expectedRevision: editing.revision }); }, true)} />}
      {picker && <EpisodeAssetPicker kind={kind} initialQuery={entries.find((entry) => entry.id === picker.entryId)?.name}
        snapshot={host.snapshot} onLoadGlobal={async () => { await host.dispatchAction({ type: 'load-global' }); }}
        onClose={() => setPicker(undefined)} onSelect={(assetId, scope) => perform(async () => {
        await host.dispatchAction(picker.entryId
          ? { type: 'bind', entryId: picker.entryId, targetId: assetId, scope, expectedRevision: picker.revision }
          : { type: 'add-library', targetId: assetId, scope, expectedRevision: picker.revision });
      }, true)} />}
      {preview && <AssetExtractionPreviewDialog title={t(kind === 'character' ? '核对本集角色提取结果' : '核对本集道具提取结果')}
        items={preview.items} existingItems={entries} confirmLabel={t('加入本集清单')} onClose={() => setPreview(undefined)}
        onConfirm={(ids) => perform(async () => {
          const latestEpisode = snapshotRef.current.episode;
          if (preview.fingerprint !== episodeScriptFingerprint(latestEpisode?.episodeScript ?? '')) throw new Error(t('本集剧本已变化，请重新提取'));
          await host.dispatchAction({ type: 'merge-candidates', candidateIds: ids,
            expectedRevision: preview.revision, fingerprint: preview.fingerprint });
        }, true)} />}
    </div>
  );
}
