/**
 * GlobalCreativeAssetsPanel — 提供全局创作资产界面与交互。
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Plus, Search, Upload } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t, useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { generateId } from '../../store/store.utils';
import type { DramaAsset, DramaAssetCategory, DramaAssetKind, DramaAssetWriteOptions, DramaCharacter } from '../../types/dramaAssets';
import { DRAMA_ASSET_CATEGORY_LABEL, MAX_DRAMA_REFERENCE_IMAGES, normalizeDramaVisualAsset } from '../../types/dramaAssets';
import { normalizeAssetKey } from '../../services/dramaAssetExtract';
import { formatDramaAssetTextBrief } from '../../services/dramaAssetPrompt';
import { getAssetUrlFromPath, isTauriEnv, uploadSourceFileToProject, type AssetFileEntry } from '../../services/fileService';
import { exportGlobalDramaAssets, importGlobalDramaAssets } from '../../services/dramaAssetTransferService';
import type { DramaAssetIdentity } from '../../services/dramaAssetTransferFormat';
import { dramaAssetIdentityKey, getDramaAssetCategory, matchesDramaAssetCategory } from '../../services/dramaAssetSearch';
import { copyDramaAssetSelection } from '../../services/dramaAssetBatchCopy';
import { useDramaAssetList } from '../../hooks/useDramaAssetList';
import { useDramaAssetImportDialog } from '../../hooks/useDramaAssetImportDialog';
import DramaAssetListControls from './DramaAssetListControls';
import { DramaAssetCard } from '../DramaAssetsPanel';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

const CharacterAssetDialog = lazy(() => import('../CharacterAssetDialog'));
const AssetUsageDialog = lazy(() => import('./AssetUsageDialog'));
const DramaVisualReferencesDialog = lazy(() => import('./DramaVisualReferencesDialog'));

function globalAssets(kind: DramaAssetKind): DramaAsset[] {
  const state = useAppStore.getState();
  return kind === 'character' ? state.globalCharacters : kind === 'scene' ? state.globalScenes : state.globalProps;
}

function newAsset(category: DramaAssetCategory, name: string): DramaAsset {
  const kind: DramaAssetKind = category === 'weapon' ? 'prop' : category;
  const now = Date.now();
  const base = {
    id: `${kind}-${generateId()}`, name, key: normalizeAssetKey(name), summary: '', visualNotes: '',
    importance: 'supporting' as const, confirmed: true, createdAt: now, updatedAt: now, source: 'manual' as const,
  };
  if (kind === 'character') return { ...base, kind, identity: '' };
  if (kind === 'scene') return { ...base, kind };
  return { ...base, kind, propType: category === 'weapon' ? 'weapon' : undefined };
}

/** 场景与道具使用创作资产卡片；人物继续打开已有角色编辑器。 */
function GlobalAssetEditor({ asset, creating, onClose }: { asset: DramaAsset; creating: boolean; onClose: () => void }) {
  useT();
  const [name, setName] = useState(asset.name);
  const [summary, setSummary] = useState(asset.summary);
  const [visualNotes, setVisualNotes] = useState(asset.visualNotes);
  const [storyRole, setStoryRole] = useState(asset.storyRole ?? '');
  const [propCategory, setPropCategory] = useState<'prop' | 'weapon'>(getDramaAssetCategory(asset) === 'weapon' ? 'weapon' : 'prop');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => { if (!pending.current) onClose(); };
  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={!saving} ariaLabel={t('编辑全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[getDramaAssetCategory(asset)]) })}
    className="ui-dialog-surface w-[min(480px,calc(100vw-24px))] p-3 gap-3">
    <h3 className="text-sm font-semibold text-canvas-text">{creating ? t('新增全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[getDramaAssetCategory(asset)]) }) : t('编辑全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[getDramaAssetCategory(asset)]) })}</h3>
    <form className="flex flex-col gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (pending.current || !name.trim()) return;
      pending.current = true; setSaving(true); setError('');
      const request = new AbortController(); controller.current = request;
      const latest = globalAssets(asset.kind).find((item) => item.id === asset.id);
      if (!creating && !latest) {
        pending.current = false; setSaving(false); setError('资产已删除，请关闭后重新选择'); return;
      }
      void useAppStore.getState().saveGlobalDramaAsset({
        ...(latest ?? asset), name: name.trim(), key: normalizeAssetKey(name), summary: summary.trim(),
        visualNotes: visualNotes.trim(), storyRole: storyRole.trim() || undefined, updatedAt: Date.now(),
        ...(asset.kind === 'prop' ? { propType: propCategory === 'weapon' ? 'weapon' as const : undefined } : {}),
      }, { signal: request.signal }).then((saved) => {
        if (!request.signal.aborted) { if (saved) onClose(); else setError('保存失败，修改仍保留，请重试'); }
      }).catch(() => { if (!request.signal.aborted) setError('保存失败，修改仍保留，请重试'); })
        .finally(() => { pending.current = false; if (!request.signal.aborted) setSaving(false); });
    }}>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">{t("名称")}
        <input autoFocus className="ui-input" value={name} disabled={saving} required onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">{t("简介")}
        <textarea className="ui-textarea" rows={3} value={summary} disabled={saving} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">{t("外形 / 视觉要点")}
        <textarea className="ui-textarea" rows={3} value={visualNotes} disabled={saving} onChange={(event) => setVisualNotes(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">{t("剧情功能（可选）")}
        <input className="ui-input" value={storyRole} disabled={saving} onChange={(event) => setStoryRole(event.target.value)} />
      </label>
      {asset.kind === 'prop' && <label className="ui-field">
        <span className="ui-label">{t('资产分类')}</span>
        <Select value={propCategory} size="sm" disabled={saving} fixedMenu
          onChange={(value) => setPropCategory(value === 'weapon' ? 'weapon' : 'prop')}
          options={[{ value: 'prop', label: t('道具') }, { value: 'weapon', label: t('武器') }]} />
      </label>}
      {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="ui-btn ui-btn--ghost" disabled={saving} onClick={close}>{t("取消")}</button>
        <button type="submit" className="ui-btn ui-btn--primary" disabled={saving || !name.trim()}>{saving ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </ModalOverlay>;
}

/** 从文件创建或追加创作资产；文件身份与人物身份独立，不移动原文件。 */
export function GlobalCreativeAssetFileDialog({ file, kind, onClose, onSaved }: {
  file: AssetFileEntry; kind: DramaAssetKind; onClose: () => void; onSaved: (category: DramaAssetCategory) => void;
}) {
  useT();
  const sourceCards = useAppStore(useShallow((state) => kind === 'character' ? state.globalCharacters
    : kind === 'scene' ? state.globalScenes : state.globalProps));
  const [category, setCategory] = useState<DramaAssetCategory>(kind);
  const cards = sourceCards.filter((asset) => matchesDramaAssetCategory(asset, category));
  const [targetId, setTargetId] = useState('');
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => { if (!pending.current) onClose(); };
  const save = async () => {
    if (pending.current || (!targetId && !name.trim())) return;
    pending.current = true; setSaving(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      if (!file.assetId || file.availability === 'offline') throw new Error('素材不可用，请刷新文件列表后重试');
      const url = file.assetUrl || await getAssetUrlFromPath(file.path);
      if (request.signal.aborted) return;
      const existing = targetId ? globalAssets(kind).find((item) => item.id === targetId) : undefined;
      if (targetId && !existing) throw new Error('目标资产已删除，请重新选择');
      if (existing && !matchesDramaAssetCategory(existing, category)) throw new Error(t('资产已变化，请重新选择'));
      let asset = existing ?? newAsset(category, name.trim());
      if (asset.kind === 'character') {
        const referenceId = `reference-${generateId()}`;
        const references = asset.referenceImages ?? [];
        const reference = references.find((item) => item.assetId === file.assetId);
        asset = { ...asset, referenceImages: reference ? references : [...references, {
          id: referenceId, kind: 'primary', assetId: file.assetId, imageUrl: url, prompt: '',
          createdAt: Date.now(), updatedAt: Date.now(),
        }], primaryReferenceImageId: asset.primaryReferenceImageId ?? reference?.id ?? referenceId };
      } else {
        const normalized = normalizeDramaVisualAsset(asset);
        const reference = normalized.referenceImages?.find((item) => item.assetId === file.assetId);
        if (!reference && (normalized.referenceImages?.length ?? 0) >= MAX_DRAMA_REFERENCE_IMAGES) throw new Error(t('每个场景或道具最多保存 {count} 张参考图', { count: MAX_DRAMA_REFERENCE_IMAGES }));
        const referenceId = reference?.id ?? `reference-${generateId()}`;
        asset = { ...normalized, imageAssetId: file.assetId, imageUrl: url, imageNodeId: undefined,
          referenceImages: reference ? normalized.referenceImages : [...(normalized.referenceImages ?? []), {
            id: referenceId, label: file.name.replace(/\.[^.]+$/, ''), prompt: '', assetId: file.assetId,
            imageUrl: url, createdAt: Date.now(), updatedAt: Date.now(),
          }], primaryReferenceImageId: referenceId };
      }
      if (!await useAppStore.getState().saveGlobalDramaAsset(asset, { signal: request.signal })) throw new Error('保存失败，文件和原资产仍保留，请重试');
      if (!request.signal.aborted) onSaved(getDramaAssetCategory(asset));
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '添加失败，请重试');
    } finally { pending.current = false; if (!request.signal.aborted) setSaving(false); }
  };
  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={!saving} ariaLabel={t('添加到全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[category]) })}
    className="ui-dialog-surface w-[min(440px,calc(100vw-24px))] p-3 gap-3">
    <h3 className="text-sm font-semibold text-canvas-text">{t('添加到全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[category]) })}</h3>
    <p className="truncate text-xs text-canvas-text-secondary" title={file.name}>{file.name}</p>
    {kind === 'prop' && <label className="ui-field">
      <span className="ui-label">{t('资产分类')}</span>
      <Select value={category} size="sm" disabled={saving} fixedMenu onChange={(value) => { setCategory(value === 'weapon' ? 'weapon' : 'prop'); setTargetId(''); }}
        options={[{ value: 'prop', label: t('道具') }, { value: 'weapon', label: t('武器') }]} />
    </label>}
    <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">{t("添加方式")}
      <Select value={targetId} disabled={saving} fixedMenu onChange={setTargetId}
        options={[{ value: '', label: t('新建{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[category]) }) }, ...cards.map((asset) => ({ value: asset.id, label: t('添加到 {name}', { name: asset.name }) }))]} />
    </label>
    {!targetId && <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">{t("名称")}
      <input autoFocus className="ui-input" value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
    </label>}
    {targetId && kind !== 'character' && <p className="ui-hint">{t('将添加为参考图并设为主图，原参考图和文件均保留。')}</p>}
    {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="ui-btn ui-btn--ghost" disabled={saving} onClick={close}>{t("取消")}</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={saving || (!targetId && !name.trim())} onClick={() => void save()}>
        {saving ? t('添加中…') : t('添加')}
      </button>
    </div>
  </ModalOverlay>;
}

export default function GlobalCreativeAssetsPanel({ kind, compact }: { kind: DramaAssetCategory; compact: boolean }) {
  useT();
  const { characters, scenes, props, loading, loadError, nodes, currentProjectId, load, save, remove, bind, openCharacters, showToast } = useAppStore(useShallow((state) => ({
    characters: state.globalCharacters, scenes: state.globalScenes, props: state.globalProps,
    loading: state.globalDramaAssetsLoading, loadError: state.globalDramaAssetsError, nodes: state.nodes,
    currentProjectId: state.currentProjectId, load: state.loadGlobalDramaAssets, save: state.saveGlobalDramaAsset,
    remove: state.deleteGlobalDramaAsset, bind: state.bindGlobalDramaAssetImage,
    openCharacters: state.setCharacterLibraryOpen, showToast: state.showToast,
  })));
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ asset: DramaAsset; creating: boolean } | null>(null);
  const [operationKind, setOperationKind] = useState<'manage' | 'upload' | 'import' | 'export' | 'copy' | null>(null);
  const [lastImported, setLastImported] = useState<DramaAssetIdentity[]>([]);
  const [onlyImported, setOnlyImported] = useState(false);
  const [usage, setUsage] = useState<{ asset: DramaAsset; deleting: boolean } | null>(null);
  const [galleryAsset, setGalleryAsset] = useState<DramaAsset | null>(null);
  const { chooseAssets, dialog: importDialog } = useDramaAssetImportDialog();
  const [operationProgress, setOperationProgress] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const [savingAssets, setSavingAssets] = useState(false);
  const operation = useRef<{ controller: AbortController; saving: boolean } | null>(null);
  const mounted = useRef(true);
  const busy = operationKind !== null;
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (!state.assetsPanelOpen) operation.current?.controller.abort();
    });
    return () => { mounted.current = false; operation.current?.controller.abort(); unsubscribe(); };
  }, [kind]);
  const source = useMemo(() => (kind === 'character' ? characters : kind === 'scene' ? scenes : props)
    .filter((asset) => matchesDramaAssetCategory(asset, kind)), [characters, scenes, props, kind]);
  const sourceItems = useMemo(() => {
    if (!onlyImported) return source;
    const keys = new Set(lastImported.map(dramaAssetIdentityKey));
    return [...characters, ...scenes, ...props].filter((asset) => keys.has(dramaAssetIdentityKey(asset)));
  }, [source, onlyImported, lastImported, characters, scenes, props]);
  const list = useDramaAssetList(sourceItems, search, `global:${kind}:${onlyImported}`);
  const selecting = !compact && list.selecting;
  const { items } = list;
  const usageTarget = useMemo(() => usage ? { kind: 'creative' as const, scope: 'global' as const,
    assetKind: usage.asset.kind, assetId: usage.asset.id, name: usage.asset.name } : null, [usage]);
  const imageNodes = useMemo(() => nodes.filter((node) => ['ai-image', 'source-image', 'ai-panorama', 'ai-storyboard'].includes(node.type ?? '')
    && Boolean(node.data.imageUrl || node.data.thumbnailUrl)).map((node) => ({ id: node.id, label: node.data.label || node.data.fileName || node.id })), [nodes]);
  const run = async (
    actionKind: 'manage' | 'upload' | 'import' | 'export' | 'copy',
    action: (options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => Promise<void>,
  ) => {
    if (operation.current || !mounted.current || !useAppStore.getState().assetsPanelOpen) return;
    const request = { controller: new AbortController(), saving: false };
    operation.current = request; setOperationKind(actionKind); setCancelRequested(false); setSavingAssets(false);
    setOperationProgress(actionKind === 'manage' ? '' : t(actionKind === 'upload' ? '正在上传素材' : actionKind === 'import' ? '正在导入创作资产' : actionKind === 'copy' ? '正在复制资产' : '正在导出创作资产'));
    const assertCurrent = () => {
      if (operation.current !== request || request.controller.signal.aborted || !mounted.current || !useAppStore.getState().assetsPanelOpen) {
        request.controller.abort();
        throw new Error(t('资产操作已取消'));
      }
    };
    try {
      assertCurrent();
      await action({ signal: request.controller.signal, assertCurrent, onProgress: (text) => {
        request.saving = text === t('正在保存资产');
        if (mounted.current && !request.controller.signal.aborted) { setSavingAssets(request.saving); setOperationProgress(text); }
      } });
    } catch (reason) {
      if (!request.controller.signal.aborted || request.saving) showToast(reason instanceof Error ? reason.message : t('操作失败，请重试'), 'error');
    } finally {
      if (operation.current === request) {
        operation.current = null;
        if (mounted.current) { setOperationKind(null); setOperationProgress(''); setCancelRequested(false); setSavingAssets(false); }
      }
    }
  };
  const transfer = (actionKind: 'import' | 'export', selectedAsset?: DramaAsset, subset?: readonly DramaAsset[]) => run(actionKind, async (options) => {
    const allAssets = [...globalAssets('character'), ...globalAssets('scene'), ...globalAssets('prop')];
    const assets = selectedAsset || subset ? allAssets : allAssets.filter((asset) => matchesDramaAssetCategory(asset, kind));
    const selected = selectedAsset ? assets.find((asset) => asset.kind === selectedAsset.kind && asset.id === selectedAsset.id) : undefined;
    if (selectedAsset && !selected) throw new Error(t('资产已删除，请重新选择'));
    const selectedKeys = subset ? new Set(subset.map(dramaAssetIdentityKey)) : null;
    const exportAssets = selected ? [selected] : selectedKeys ? assets.filter((asset) => selectedKeys.has(dramaAssetIdentityKey(asset))) : assets;
    if (selectedKeys && exportAssets.length !== selectedKeys.size) throw new Error(t('资产已删除，请重新选择'));
    const result = actionKind === 'export' ? await exportGlobalDramaAssets({
      libraryName: t('全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[kind]) }),
      ...(selected ? { assetName: selected.name } : {}), assets: exportAssets, allAssets,
    }, options) : await importGlobalDramaAssets({ existingAssets: allAssets, commit: async (assets) => {
      options.assertCurrent?.();
      await useAppStore.getState().importGlobalDramaAssets(assets, options);
    } }, { ...options, chooseAssets });
    if (!result || options.signal?.aborted) return;
    options.assertCurrent?.();
    if (actionKind === 'import') { setLastImported(result.assets); setOnlyImported(false); }
    showToast(t(actionKind === 'export' ? '已导出 {count} 项全局创作资产，包含 {mediaCount} 份媒体' : '已导入 {count} 项全局创作资产，包含 {mediaCount} 份媒体', {
      count: result.assetCount, mediaCount: result.mediaCount,
    }), 'success');
  });
  const upload = (asset?: DramaAsset) => run('upload', async (options) => {
    if (asset && asset.kind !== 'character' && (normalizeDramaVisualAsset(asset).referenceImages?.length ?? 0) >= MAX_DRAMA_REFERENCE_IMAGES) {
      throw new Error(t('每个场景或道具最多保存 {count} 张参考图', { count: MAX_DRAMA_REFERENCE_IMAGES }));
    }
    const selected = await uploadSourceFileToProject('.png,.jpg,.jpeg,.webp,.gif,.bmp', null);
    if (!selected) return;
    options.assertCurrent?.();
    const latest = asset ? globalAssets(asset.kind).find((item) => item.id === asset.id) : newAsset(kind, selected.fileName.replace(/\.[^.]+$/, ''));
    if (!latest) return;
    if (latest.kind === 'character') {
      const referenceId = `reference-${generateId()}`;
      if (!await save({ ...latest, referenceImages: [...(latest.referenceImages ?? []), {
        id: referenceId, kind: 'primary', imageUrl: selected.dataUrl, prompt: '', createdAt: Date.now(), updatedAt: Date.now(),
      }], primaryReferenceImageId: latest.primaryReferenceImageId ?? referenceId }, options)) return;
    } else {
      const referenceId = `reference-${generateId()}`;
      const visual = normalizeDramaVisualAsset(latest);
      if ((visual.referenceImages?.length ?? 0) >= MAX_DRAMA_REFERENCE_IMAGES) throw new Error(t('每个场景或道具最多保存 {count} 张参考图', { count: MAX_DRAMA_REFERENCE_IMAGES }));
      if (!await save({ ...latest, imageUrl: selected.dataUrl, imageAssetId: undefined, imageRelativePath: undefined, imageNodeId: undefined,
        referenceImages: [...(visual.referenceImages ?? []), { id: referenceId, label: selected.fileName.replace(/\.[^.]+$/, ''), prompt: '',
          imageUrl: selected.dataUrl, createdAt: Date.now(), updatedAt: Date.now() }], primaryReferenceImageId: referenceId }, options)) return;
    }
    if (!options.signal?.aborted) { options.assertCurrent?.(); showToast(t('已添加到全局创作资产')); }
  });
  const handleCopyToProject = (assets: readonly DramaAsset[]) => run('copy', async (options) => {
    const count = await copyDramaAssetSelection('global', assets, options);
    if (!options.signal?.aborted) { options.assertCurrent?.(); showToast(t('已复制 {count} 项资产', { count }), 'success'); }
  });
  return <div className={`flex min-h-0 min-w-0 flex-1 flex-col${compact ? ' drama-assets--compact' : ''}`}>
    <div className="flex min-w-0 flex-wrap items-center gap-2 p-3">
      <h3 className="shrink-0 text-sm font-medium text-canvas-text">{onlyImported ? t('本次导入') : t('全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[kind]) })} <span className="text-canvas-text-muted">{sourceItems.length}</span></h3>
      <DramaAssetListControls inline sortBy={list.sortBy} sortOrder={list.sortOrder} onSort={list.changeSort}
        selecting={selecting} onSelecting={compact ? undefined : list.toggleSelecting} selectedCount={list.selected.length} visibleCount={items.length}
        onSelectAll={list.selectAll} onExport={() => void transfer('export', undefined, list.selected)}
        onCopy={currentProjectId && currentProjectId !== 'default' ? () => void handleCopyToProject(list.selected) : undefined}
        copyLabel={t('复制到本项目')} busy={busy || loading || Boolean(loadError)} canExport={isTauriEnv()} />
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <label className="ui-input-group w-48 max-w-full">
          <Search size={14} aria-hidden="true" className="pointer-events-none ml-2 shrink-0 self-center text-canvas-text-muted" />
          <input className="ui-input ui-input--sm select-text" aria-label={t('搜索全局创作资产')} placeholder={t('搜索名称、简介、别名…')}
            value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        {!compact && (
          <>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading || Boolean(loadError)} onClick={() => void upload()}>
              <Upload size={14} aria-hidden="true" />{t('上传图片')}
            </button>
            <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || loading || Boolean(loadError)} onClick={() => setEditing({ asset: newAsset(kind, ''), creating: true })}>
              <Plus size={14} aria-hidden="true" />{t('新增{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[kind]) })}
            </button>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading || Boolean(loadError) || !isTauriEnv()}
              aria-label={t('导入全局创作资产')} title={t('追加导入全局创作资产，按人物、场景、道具、武器分类保存')} onClick={() => void transfer('import')}>
              <Upload size={14} aria-hidden="true" />{t('导入')}
            </button>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading || Boolean(loadError) || !source.length || !isTauriEnv()}
              aria-label={t('导出全部全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[kind]) })} title={t('导出当前分类的全部全局资产及媒体，不受搜索影响')} onClick={() => void transfer('export')}>
              <Download size={14} aria-hidden="true" />{t('导出')}
            </button>
          </>
        )}
      </div>
    </div>
    {lastImported.length > 0 && <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-canvas-text-secondary">
      <span>{t('本次导入 {count} 项资产', { count: lastImported.length })}</span>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => {
        setSearch(''); setOnlyImported((value) => !value); list.clearSelection();
      }}>{t(onlyImported ? '显示全部资产' : '查看本次导入')}</button>
    </div>}
    {operationProgress && <div role="status" className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-canvas-text-secondary">
      <span className="min-w-0 flex-1 break-words">{operationProgress}</span>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" aria-label={t('取消资产操作')}
        disabled={savingAssets || cancelRequested} onClick={() => {
          const request = operation.current;
          if (!request || request.saving) return;
          request.controller.abort(); setCancelRequested(true); setOperationProgress(t('已请求取消，等待当前文件操作结束…'));
        }}>{t('取消')}</button>
    </div>}
    {loading ? <p role="status" className="p-3 text-xs text-canvas-text-muted">{t('正在加载全局创作资产…')}</p>
      : loadError ? <div role="alert" className="p-3"><p className="ui-alert ui-alert--danger">{t(loadError)}</p>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm mt-2" onClick={() => { void load().catch(() => {}); }}>{t('重试加载')}</button></div>
        : <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3${items.length ? ' drama-assets-grid' : ''}`}
          inert={operationKind === 'import' || undefined} aria-busy={operationKind === 'import' || undefined}>
          {items.length === 0 ? <div role="status" className="flex flex-col items-center gap-2 p-3 text-xs text-canvas-text-muted">
            <p>{search ? t('没有匹配的资产') : t('暂无全局{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[kind]) })}</p>
            {!compact && <p>{t('可新建资产、上传图片、导入资产包，或从文件右键菜单添加；保存后可跨项目使用。')}</p>}
          </div> : items.map((asset) => <DramaAssetCard key={asset.id} asset={asset} thumb={asset.imageUrl}
            imageNodes={imageNodes} editing={false} uploading={busy} manageUploadedImage browseOnly={compact}
            selecting={selecting} selected={selecting && list.selectedKeys.has(dramaAssetIdentityKey(asset))} onToggleSelect={() => list.toggle(asset)}
            onOpen={selecting ? () => list.toggle(asset) : asset.kind === 'character' ? () => openCharacters(true, { scope: 'global', characterId: asset.id, origin: 'assets' }) : undefined}
            onViewUsage={() => setUsage({ asset, deleting: false })}
            onManageImages={asset.kind !== 'character' ? () => setGalleryAsset(asset) : undefined}
            onToggleEdit={() => setEditing({ asset, creating: false })}
            onSaveFields={() => {}}
            onDelete={() => setUsage({ asset, deleting: true })}
            onBindImage={(nodeId) => void run('manage', async (options) => { if (await bind(asset.kind, asset.id, nodeId, options) && !options.signal?.aborted) showToast(t('已绑定全局资产图片')); })}
            onUploadImage={() => void upload(asset)}
            onExport={isTauriEnv() ? () => void transfer('export', asset) : undefined}
            onCopyBrief={() => { void navigator.clipboard.writeText(formatDramaAssetTextBrief(asset)).then(() => showToast('简介已复制')).catch(() => showToast('复制失败', 'error')); }}
            onManageVoice={asset.kind === 'character' ? () => openCharacters(true, { scope: 'global', characterId: asset.id, section: 'voice', origin: 'assets' }) : undefined}
            onManageActions={asset.kind === 'character' ? () => openCharacters(true, { scope: 'global', characterId: asset.id, section: 'action', origin: 'assets' }) : undefined}
            onCopyToScope={currentProjectId && currentProjectId !== 'default' ? () => void handleCopyToProject([asset]) : undefined} copyToScopeLabel={t("复制到本项目")} />)}
        </div>}
    {editing && (editing.asset.kind === 'character' ? <Suspense fallback={<p role="status" className="p-3 text-xs text-canvas-text-muted">{t("正在打开角色编辑器…")}</p>}>
      <CharacterAssetDialog key={editing.asset.id} isOpen scope="global" character={editing.creating ? null : editing.asset as DramaCharacter}
        onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
    </Suspense> : <GlobalAssetEditor key={editing.asset.id} asset={editing.asset} creating={editing.creating} onClose={() => setEditing(null)} />)}
    {importDialog}
    {usage && usageTarget && <Suspense fallback={null}><AssetUsageDialog target={usageTarget} onClose={() => setUsage(null)}
      onConfirmDelete={usage.deleting ? async () => {
        if (!mounted.current || !useAppStore.getState().assetsPanelOpen) throw new Error(t('资产操作已取消'));
        if (globalAssets(usage.asset.kind).find((asset) => asset.id === usage.asset.id) !== usage.asset) throw new Error(t('资产已变化，请重新选择'));
        if (!await remove(usage.asset.kind, usage.asset.id)) throw new Error(t('删除失败，请重试'));
        setUsage(null);
      } : undefined} /></Suspense>}
    {galleryAsset && galleryAsset.kind !== 'character' && <Suspense fallback={null}>
      <DramaVisualReferencesDialog key={dramaAssetIdentityKey(galleryAsset)} scope="global" asset={galleryAsset} onClose={() => setGalleryAsset(null)} />
    </Suspense>}
  </div>;
}
