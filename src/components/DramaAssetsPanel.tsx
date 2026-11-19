/**
 * DramaAssetsPanel — 项目级短剧资产库（人物 / 场景 / 道具）
 * 资产管理：本地上传 / 查看 / 编辑 / 删除 / 绑图 / 资产包导入导出。
 * 生图在画布图像节点完成：@ 资产（无图=简介，有图=参考图）+ slash 人设参考等。
 */
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { Download } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { t as translate, useT } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import type { DramaAsset, DramaAssetCategory, DramaAssetKind, DramaAssetWriteOptions } from '../types/dramaAssets';
import { DRAMA_ASSET_CATEGORY_LABEL, MAX_DRAMA_REFERENCE_IMAGES, normalizeDramaVisualAsset } from '../types/dramaAssets';
import { findDramaAssetByKind, formatDramaAssetTextBrief } from '../services/dramaAssetPrompt';
import { confirmAction } from '../services/confirmDialog';
import ViewportImage from './shared/ViewportImage';
import Select from './shared/Select';
import { uploadSourceFileToProject, isTauriEnv } from '../services/fileService';
import { generateId, seriesOwnerId } from '../store/store.utils';
import { normalizeAssetKey } from '../services/dramaAssetExtract';
import { cropImageStyle } from './character/characterReferencePresentation';
import { exportProjectDramaAssets, importProjectDramaAssets } from '../services/dramaAssetTransferService';
import type { DramaAssetIdentity } from '../services/dramaAssetTransferFormat';
import { dramaAssetIdentityKey, getDramaAssetCategory, matchesDramaAssetCategory } from '../services/dramaAssetSearch';
import { copyDramaAssetSelection } from '../services/dramaAssetBatchCopy';
import { useDramaAssetList } from '../hooks/useDramaAssetList';
import { useDramaAssetImportDialog } from '../hooks/useDramaAssetImportDialog';
import DramaAssetListControls from './assets/DramaAssetListControls';

const AssetUsageDialog = lazy(() => import('./assets/AssetUsageDialog'));
const DramaVisualReferencesDialog = lazy(() => import('./assets/DramaVisualReferencesDialog'));

const KIND_TABS: Array<{ key: DramaAssetCategory | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'character', label: '人物' },
  { key: 'scene', label: '场景' },
  { key: 'prop', label: '道具' },
  { key: 'weapon', label: '武器' },
];

const IMPORTANCE_LABEL: Record<string, string> = {
  main: '主要',
  supporting: '次要',
  minor: '零星',
};

function assetExtraLine(asset: DramaAsset): string {
  if (asset.kind === 'character') {
    return [asset.identity, asset.personality].filter(Boolean).join(' · ');
  }
  if (asset.kind === 'scene') {
    return [asset.placeType, asset.timeOfDay, asset.atmosphere].filter(Boolean).join(' · ');
  }
  return [asset.ownerName, asset.category, asset.significance].filter(Boolean).join(' · ');
}

function resolveThumb(
  asset: DramaAsset,
  nodes: Array<{ id: string; data: Record<string, unknown> }>,
): string | undefined {
  if (asset.imageNodeId) {
    const n = nodes.find((x) => x.id === asset.imageNodeId);
    const url =
      (n?.data?.imageUrl as string | undefined)
      || (n?.data?.thumbnailUrl as string | undefined);
    if (url) return url;
  }
  return asset.imageUrl;
}

interface DramaAssetEditFields {
  name: string;
  summary: string;
  visualNotes: string;
  storyRole: string;
  propType?: 'weapon';
}

function assetEditFields(asset: DramaAsset): DramaAssetEditFields {
  return { name: asset.name.trim(), summary: asset.summary?.trim() ?? '', visualNotes: asset.visualNotes?.trim() ?? '',
    storyRole: asset.storyRole?.trim() ?? '', ...(asset.kind === 'prop' ? { propType: asset.propType } : {}) };
}

export function DramaAssetCard({
  asset,
  thumb,
  imageNodes,
  editing,
  onToggleEdit,
  onDelete,
  onSaveFields,
  onBindImage,
  onUnbindImage,
  onCopyBrief,
  onUploadImage,
  uploading,
  onOpen,
  onManageVoice,
  onManageActions,
  onCopyToScope,
  copyToScopeLabel,
  onExport,
  selecting = false,
  selected = false,
  onToggleSelect,
  onViewUsage,
  onManageImages,
  manageUploadedImage = false,
  creating = false,
}: {
  asset: DramaAsset;
  thumb?: string;
  imageNodes: Array<{ id: string; label: string }>;
  editing: boolean;
  onToggleEdit: () => void;
  onDelete: () => void;
  onSaveFields: (patch: DramaAssetEditFields, displayed: DramaAssetEditFields) => void;
  onBindImage: (nodeId: string) => void;
  onUnbindImage?: () => void;
  onCopyBrief: () => void;
  onUploadImage: () => void;
  uploading: boolean;
  onOpen?: () => void;
  onManageVoice?: () => void;
  onManageActions?: () => void;
  onCopyToScope?: () => void;
  copyToScopeLabel?: string;
  onExport?: () => void;
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onViewUsage?: () => void;
  onManageImages?: () => void;
  manageUploadedImage?: boolean;
  creating?: boolean;
}) {
  const t = useT();
  const selectionId = useId();
  const [name, setName] = useState(asset.name);
  const [summary, setSummary] = useState(asset.summary);
  const [visualNotes, setVisualNotes] = useState(asset.visualNotes);
  const [storyRole, setStoryRole] = useState(asset.storyRole ?? '');
  const [propCategory, setPropCategory] = useState<'prop' | 'weapon'>(getDramaAssetCategory(asset) === 'weapon' ? 'weapon' : 'prop');
  const editingBaseline = useRef(asset);
  const [bindOpen, setBindOpen] = useState(false);
  const avatarReference = asset.kind === 'character'
    ? asset.referenceImages?.find((reference) => reference.id === asset.avatarReferenceImageId)
      ?? asset.referenceImages?.find((reference) => reference.id === asset.primaryReferenceImageId)
      ?? asset.referenceImages?.[0]
    : undefined;
  const displayThumb = avatarReference?.imageUrl || thumb;
  const hasUploadedImage = Boolean(asset.imageUrl && !asset.imageNodeId);
  const avatarCrop = asset.kind === 'character' && avatarReference?.imageUrl
    && avatarReference.id === asset.avatarReferenceImageId
    ? asset.avatarCrop
    : undefined;

  const handleToggleEdit = useCallback(() => {
    if (!editing) {
      editingBaseline.current = asset;
      setName(asset.name);
      setSummary(asset.summary);
      setVisualNotes(asset.visualNotes);
      setStoryRole(asset.storyRole ?? '');
      setPropCategory(getDramaAssetCategory(asset) === 'weapon' ? 'weapon' : 'prop');
    }
    onToggleEdit();
  }, [asset, editing, onToggleEdit]);

  return (
    <div
      className={`drama-asset-card ui-card relative isolate min-w-0 p-3 hover:border-indigo-500/30 transition-colors${selected ? ' ring-2 ring-brand' : ''}`}
      data-asset-kind={asset.kind}
      data-asset-id={asset.id}
    >
      {onOpen && !editing ? (
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
          aria-label={t('打开{kind}：{name}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[getDramaAssetCategory(asset)]), name: asset.name })}
          onClick={onOpen}
        />
      ) : null}
      {selecting && onToggleSelect && <div className="relative z-20 mb-2 flex items-center gap-2">
        <input id={selectionId} type="checkbox" className="ui-checkbox" checked={selected}
          disabled={uploading} onChange={onToggleSelect} />
        <label htmlFor={selectionId}>{t('选择资产「{name}」', { name: asset.name })}</label>
      </div>}
      <div className="drama-asset-card-layout">
        {/* Thumb */}
        <div className={`drama-asset-thumbnail w-20 rounded-lg overflow-hidden shrink-0 bg-canvas-hover border border-canvas-border flex items-center justify-center${asset.kind === 'character' ? ' character-avatar drama-asset-thumbnail--character' : ' h-20'}`}>
          {displayThumb ? (
            <ViewportImage
              src={displayThumb}
              alt=""
              className={asset.kind === 'character'
                ? `drama-asset-thumbnail-image${avatarCrop ? ' is-cropped' : ''}`
                : 'drama-asset-thumbnail-image w-full h-full object-cover'}
              style={cropImageStyle(avatarCrop)}
              draggable={false}
            />
          ) : (
            <span className="drama-asset-thumbnail-placeholder text-[12px] text-canvas-text-muted">
              {t(DRAMA_ASSET_CATEGORY_LABEL[getDramaAssetCategory(asset)])[0]}
            </span>
          )}
        </div>

        <div className="drama-asset-card-body flex-1 min-w-0">
          <div className="drama-asset-meta flex items-center gap-1.5 flex-wrap">
            <span className="w-full text-[13px] font-semibold text-canvas-text truncate">{asset.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-hover text-canvas-text-muted shrink-0">
              {t(DRAMA_ASSET_CATEGORY_LABEL[getDramaAssetCategory(asset)])}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-hover text-canvas-text-muted shrink-0">
              {IMPORTANCE_LABEL[asset.importance] ? t(IMPORTANCE_LABEL[asset.importance]) : asset.importance}
            </span>
            {displayThumb ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 shrink-0">
                {t('已绑图')}
              </span>
            ) : null}
          </div>

          {!editing && (
            <>
              {asset.summary ? (
                <p className="drama-asset-summary mt-1 text-[12px] text-canvas-text-secondary leading-relaxed line-clamp-2">
                  {asset.summary}
                </p>
              ) : null}
              {asset.visualNotes ? (
                <p className="drama-asset-visual-notes mt-0.5 text-[11px] text-canvas-text-muted leading-relaxed line-clamp-2">
                  {t('外形：{notes}', { notes: asset.visualNotes })}
                </p>
              ) : null}
              {assetExtraLine(asset) ? (
                <p className="drama-asset-extra mt-0.5 text-[11px] text-canvas-text-muted/80 line-clamp-1">
                  {assetExtraLine(asset)}
                </p>
              ) : null}
            </>
          )}

          {editing && (
            <div className="drama-asset-editor mt-2 space-y-1.5">
              <input
                value={name}
                disabled={uploading}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('名称')}
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50"
              />
              <textarea
                value={summary}
                disabled={uploading}
                onChange={(e) => setSummary(e.target.value)}
                placeholder={t('简介')}
                rows={2}
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50 resize-none"
              />
              <textarea
                value={visualNotes}
                disabled={uploading}
                onChange={(e) => setVisualNotes(e.target.value)}
                placeholder={t('外形/视觉要点')}
                rows={2}
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50 resize-none"
              />
              <input
                value={storyRole}
                disabled={uploading}
                onChange={(e) => setStoryRole(e.target.value)}
                placeholder={t('剧情功能（可选）')}
                className="w-full px-2 py-1 rounded-lg bg-canvas-bg border border-canvas-border text-[12px] text-canvas-text focus:outline-none focus:border-indigo-500/50"
              />
              {asset.kind === 'prop' && <label className="ui-field">
                <span className="ui-label">{t('资产分类')}</span>
                <Select value={propCategory} size="sm" fixedMenu disabled={uploading}
                  onChange={(value) => setPropCategory(value === 'weapon' ? 'weapon' : 'prop')}
                  options={[{ value: 'prop', label: t('道具') }, { value: 'weapon', label: t('武器') }]} />
              </label>}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30"
                  disabled={uploading || !name.trim()}
                  onClick={() =>
                    onSaveFields({
                      name: name.trim() || asset.name,
                      summary: summary.trim(),
                      visualNotes: visualNotes.trim(),
                      storyRole: storyRole.trim(),
                      ...(asset.kind === 'prop' ? { propType: propCategory === 'weapon' ? 'weapon' as const : undefined } : {}),
                    }, assetEditFields(editingBaseline.current))
                  }
                >
                  {t('保存')}
                </button>
                <button
                  type="button"
                  className="px-2.5 py-1 rounded-lg text-[11px] text-canvas-text-muted hover:bg-canvas-hover"
                  disabled={uploading}
                  onClick={onToggleEdit}
                >
                  {t('取消')}
                </button>
              </div>
            </div>
          )}

          {/* Bind image picker */}
          {bindOpen && (
            <div className={`drama-asset-bind-picker mt-2 p-2 rounded-lg border border-canvas-border bg-canvas-surface/80 max-h-32 overflow-y-auto space-y-1${onOpen && !editing ? ' relative z-20' : ''}`}>
              {imageNodes.length === 0 ? (
                <p className="text-[11px] text-canvas-text-muted px-1">{t('画布上暂无图像节点')}</p>
              ) : (
                imageNodes.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="w-full text-left px-2 py-1 rounded text-[11px] text-canvas-text hover:bg-canvas-hover truncate"
                    onClick={() => {
                      onBindImage(n.id);
                      setBindOpen(false);
                    }}
                  >
                    {n.label}
                  </button>
                ))
              )}
              <button
                type="button"
                className="text-[11px] text-canvas-text-muted hover:text-canvas-text px-1"
                onClick={() => setBindOpen(false)}
              >
                {t('关闭')}
              </button>
            </div>
          )}
        </div>

        {/* Actions — 仅管理，生图请在画布图像节点 @ + slash */}
        {!creating && <div className={`drama-asset-actions flex flex-wrap items-center gap-1${onOpen && !editing ? ' relative z-20' : ''}`}>
          <button
            type="button"
            className="drama-asset-action-copy ui-btn ui-btn--ghost ui-btn--sm"
            onClick={onCopyBrief}
            title={t('复制本条简介（可粘到图像节点 prompt）')}
          >
            {t('复制简介')}
          </button>
          <button
            type="button"
            className="drama-asset-action-edit ui-btn ui-btn--ghost ui-btn--sm"
            onClick={handleToggleEdit}
          >
            {t(editing ? '收起' : '编辑')}
          </button>
          {(!hasUploadedImage || manageUploadedImage) && (
            <>
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={uploading} onClick={onUploadImage}>
                {t('上传图片')}
              </button>
              {asset.imageNodeId || asset.imageUrl ? (
                onUnbindImage && <button
                  type="button"
                  className="drama-asset-action-unbind ui-btn ui-btn--ghost ui-btn--sm"
                  onClick={onUnbindImage}
                >
                  {t('解绑图')}
                </button>
              ) : (
                <button
                  type="button"
                  className="drama-asset-action-bind ui-btn ui-btn--ghost ui-btn--sm"
                  onClick={() => setBindOpen((v) => !v)}
                >
                  {t('绑图')}
                </button>
              )}
            </>
          )}
          {onManageVoice && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onManageVoice}>
            {t('声音')}{asset.kind === 'character' && asset.voiceClips?.length ? ` ${asset.voiceClips.length}` : ''}
          </button>}
          {onManageActions && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onManageActions}>
            {t('动作')}{asset.kind === 'character' && asset.actions?.length ? ` ${asset.actions.length}` : ''}
          </button>}
          {onManageImages && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={uploading} onClick={onManageImages}>
            {t('参考图')}{asset.referenceImages?.length ? ` ${asset.referenceImages.length}` : ''}
          </button>}
          {onViewUsage && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={uploading} onClick={onViewUsage}>{t('使用位置')}</button>}
          {onCopyToScope && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onCopyToScope}>
            {copyToScopeLabel}
          </button>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onExport && <button
              type="button"
              className="drama-asset-action-export ui-btn ui-btn--ghost ui-btn--sm"
              disabled={uploading}
              onClick={onExport}
              aria-label={t('导出资产「{name}」', { name: asset.name })}
              title={t('导出当前资产及其绑定媒体')}
            >
              <Download size={16} aria-hidden="true" />
            </button>}
            <button
              type="button"
              className="drama-asset-action-delete ui-btn ui-btn--ghost ui-btn--sm text-red-400/80 hover:bg-red-500/10"
              onClick={onDelete}
              aria-label={t('删除{name}', { name: asset.name })}
              title={t('删除{name}', { name: asset.name })}
            >
              <Icon icon="lucide:trash-2" width="16" height="16" aria-hidden="true" />
            </button>
          </div>
        </div>}
      </div>
    </div>
  );
}

export default function DramaAssetsPanel({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const {
    dramaAssets,
    nodes,
    deleteDramaAsset,
    updateDramaAssetFields,
    clearDramaAssetsByKind,
    bindDramaAssetImage,
    setCharacterLibraryOpen,
    showToast,
  } = useAppStore(
    useShallow((s) => ({
      dramaAssets: s.dramaAssets,
      nodes: s.nodes,
      deleteDramaAsset: s.deleteDramaAsset,
      updateDramaAssetFields: s.updateDramaAssetFields,
      clearDramaAssetsByKind: s.clearDramaAssetsByKind,
      bindDramaAssetImage: s.bindDramaAssetImage,
      setCharacterLibraryOpen: s.setCharacterLibraryOpen,
      showToast: s.showToast,
    })),
  );

  const [tab, setTab] = useState<DramaAssetCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [uploadKind, setUploadKind] = useState<DramaAssetCategory>('character');
  const [creatingAsset, setCreatingAsset] = useState<DramaAsset | null>(null);
  const [operationKind, setOperationKind] = useState<'upload' | 'import' | 'export' | 'copy' | 'save' | null>(null);
  const [lastImported, setLastImported] = useState<DramaAssetIdentity[]>([]);
  const [onlyImported, setOnlyImported] = useState(false);
  const [usage, setUsage] = useState<{ asset: DramaAsset; deleting: boolean } | null>(null);
  const [clearAssets, setClearAssets] = useState<DramaAsset[] | null>(null);
  const [galleryAsset, setGalleryAsset] = useState<DramaAsset | null>(null);
  const { chooseAssets, dialog: importDialog } = useDramaAssetImportDialog();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [previousProjectId, setPreviousProjectId] = useState(projectId);
  if (previousProjectId !== projectId) {
    setPreviousProjectId(projectId); setLastImported([]); setOnlyImported(false); setUsage(null); setClearAssets(null); setGalleryAsset(null); setEditingId(null); setCreatingAsset(null);
  }
  const usageTarget = useMemo(() => usage && projectId ? { kind: 'creative' as const, scope: 'project' as const,
    assetKind: usage.asset.kind, assetId: usage.asset.id, name: usage.asset.name,
    ownerId: seriesOwnerId(useAppStore.getState().projects, projectId) } : null, [usage, projectId]);
  const clearTargets = useMemo(() => clearAssets && projectId ? clearAssets.map((asset) => ({
    kind: 'creative' as const, scope: 'project' as const, assetKind: asset.kind, assetId: asset.id, name: asset.name,
    ownerId: seriesOwnerId(useAppStore.getState().projects, projectId),
  })) : null, [clearAssets, projectId]);
  const [operationProgress, setOperationProgress] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const [savingAssets, setSavingAssets] = useState(false);
  const operationRef = useRef<{
    controller: AbortController; projectId?: string; ownerId?: string; saving: boolean;
  } | null>(null);
  const mounted = useRef(true);
  const busy = operationKind !== null;
  const uploading = operationKind === 'upload';
  const unbindPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAppStore.subscribe((state) => {
      const operation = operationRef.current;
      if (operation && (!state.assetsPanelOpen || !state.dramaAssetsPanelOpen
        || (operation.projectId && (state.currentProjectId !== operation.projectId
          || seriesOwnerId(state.projects, operation.projectId) !== operation.ownerId)))) {
        operation.controller.abort();
      }
    });
    return () => {
      mounted.current = false;
      operationRef.current?.controller.abort();
      unsubscribe();
    };
  }, []);

  const runOperation = async (
    kind: 'upload' | 'import' | 'export' | 'copy' | 'save',
    task: (projectId: string, ownerId: string, options: DramaAssetWriteOptions & { onProgress: (text: string) => void }) => Promise<void>,
  ) => {
    const initial = useAppStore.getState();
    if (operationRef.current || !initial.assetsPanelOpen || !initial.dramaAssetsPanelOpen) return;
    const operation = { controller: new AbortController(), projectId: initial.currentProjectId ?? undefined,
      ownerId: initial.currentProjectId ? seriesOwnerId(initial.projects, initial.currentProjectId) : undefined, saving: false };
    operationRef.current = operation;
    setOperationKind(kind);
    setCancelRequested(false);
    setSavingAssets(false);
    setOperationProgress(t(kind === 'upload' ? '正在上传素材' : kind === 'import' ? '正在导入创作资产' : kind === 'copy' ? '正在复制资产' : kind === 'save' ? '正在保存资产' : '正在导出创作资产'));
    const assertCurrent = () => {
      const current = useAppStore.getState();
      if (operationRef.current !== operation || operation.controller.signal.aborted || !mounted.current || !current.assetsPanelOpen || !current.dramaAssetsPanelOpen
        || (operation.projectId && (current.currentProjectId !== operation.projectId
          || seriesOwnerId(current.projects, operation.projectId) !== operation.ownerId))) {
        operation.controller.abort();
        throw new Error(t('资产操作已取消'));
      }
    };
    try {
      assertCurrent();
      const projectId = initial.currentProjectId || await initial.saveCurrentProjectSilent();
      assertCurrent();
      if (!projectId || useAppStore.getState().currentProjectId !== projectId) throw new Error(t('请先保存项目，再管理创作资产'));
      operation.projectId = projectId;
      const ownerId = seriesOwnerId(useAppStore.getState().projects, projectId);
      operation.ownerId = ownerId;
      assertCurrent();
      await task(projectId, ownerId, {
        signal: operation.controller.signal, assertCurrent,
        onProgress: (text) => {
          operation.saving = text === translate('正在保存资产');
          if (mounted.current && !operation.controller.signal.aborted) {
            setSavingAssets(operation.saving);
            setOperationProgress(text);
          }
        },
      });
    } catch (error) {
      if (!operation.controller.signal.aborted || operation.saving) {
        showToast(error instanceof Error ? error.message : t('资产操作失败，请重试'), 'error');
      }
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        if (mounted.current) {
          setOperationKind(null);
          setOperationProgress('');
          setCancelRequested(false);
          setSavingAssets(false);
        }
      }
    }
  };

  const handleTransfer = (kind: 'import' | 'export', selectedAsset?: DramaAsset, subset?: readonly DramaAsset[]) => runOperation(kind, async (projectId, ownerId, options) => {
    const current = useAppStore.getState();
    const assets = [...current.dramaAssets.characters, ...current.dramaAssets.scenes, ...current.dramaAssets.props];
    const selected = selectedAsset ? assets.find((asset) => asset.kind === selectedAsset.kind && asset.id === selectedAsset.id) : undefined;
    if (selectedAsset && !selected) throw new Error(t('资产已删除，请重新选择'));
    const selectedKeys = subset ? new Set(subset.map(dramaAssetIdentityKey)) : null;
    const exportAssets = selected ? [selected] : selectedKeys ? assets.filter((asset) => selectedKeys.has(dramaAssetIdentityKey(asset))) : assets;
    if (selectedKeys && exportAssets.length !== selectedKeys.size) throw new Error(t('资产已删除，请重新选择'));
    const result = kind === 'export' ? await exportProjectDramaAssets({
      projectId, ownerId, projectName: current.projects.find((project) => project.id === ownerId)?.name || t('创作资产'),
      ...(selected ? { assetName: selected.name } : {}),
      assets: exportAssets, allAssets: assets, nodes: current.nodes,
    }, options) : await importProjectDramaAssets({ projectId, ownerId, existingAssets: assets, commit: async (assets) => {
      options.assertCurrent?.();
      await useAppStore.getState().importDramaAssets(assets, options);
    } }, { ...options, chooseAssets });
    if (!result || options.signal?.aborted) return;
    options.assertCurrent?.();
    if (kind === 'import') { setLastImported(result.assets); setOnlyImported(false); }
    showToast(t(kind === 'export' ? translate('已导出 {count} 项创作资产，包含 {mediaCount} 份媒体') : translate('已导入 {count} 项创作资产，包含 {mediaCount} 份媒体'), {
      count: result.assetCount, mediaCount: result.mediaCount,
    }), 'success');
  });

  const copyToGlobal = (assets: readonly DramaAsset[]) => runOperation('copy', async (_projectId, _ownerId, options) => {
    const count = await copyDramaAssetSelection('project', assets, options);
    options.assertCurrent?.();
    showToast(t('已复制 {count} 项资产', { count }), 'success');
  });

  const handleUnbindImage = async (asset: DramaAsset) => {
    if (unbindPending.current) return;
    const initial = useAppStore.getState();
    const target = findDramaAssetByKind(initial.dramaAssets, asset.kind, asset.id);
    if (!target) return;
    unbindPending.current = true;
    try {
      const message = asset.kind === 'character'
        ? translate('确定解绑「{name}」的全部参考图并清除头像设置？声音、动作、画布节点和原图片文件会保留。', { name: target.name })
        : translate('确定解绑「{name}」的图片？画布节点和原图片文件会保留。', { name: target.name });
      if (!await confirmAction(message, { title: translate('解绑图片'), okLabel: translate('确认解绑'), cancelLabel: translate('取消') })) return;
      const latest = useAppStore.getState();
      if (latest.currentProjectId !== initial.currentProjectId
        || !latest.assetsPanelOpen || !latest.dramaAssetsPanelOpen
        || findDramaAssetByKind(latest.dramaAssets, asset.kind, asset.id) !== target) {
        showToast('项目、资产或页面已变化，请重新确认解绑', 'info');
        return;
      }
      latest.unbindDramaAssetImage(asset.kind, asset.id);
      showToast('已解绑');
    } catch {
      showToast('解绑失败，请重试', 'error');
    } finally {
      unbindPending.current = false;
    }
  };

  const handleUpload = (category: DramaAssetCategory, assetId?: string) => runOperation('upload', async (_projectId, ownerId, options) => {
      const kind: DramaAssetKind = category === 'weapon' ? 'prop' : category;
      const before = findDramaAssetByKind(useAppStore.getState().dramaAssets, kind, assetId ?? '');
      if (before && before.kind !== 'character' && (normalizeDramaVisualAsset(before).referenceImages?.length ?? 0) >= MAX_DRAMA_REFERENCE_IMAGES) {
        throw new Error(t('每个场景或道具最多保存 {count} 张参考图', { count: MAX_DRAMA_REFERENCE_IMAGES }));
      }
      const uploaded = await uploadSourceFileToProject('.png,.jpg,.jpeg,.webp,.gif,.bmp', ownerId, 'Library');
      options.assertCurrent?.();
      if (!uploaded) return;
      const latest = useAppStore.getState();
      const library = latest.dramaAssets;
      const existing = [...library.characters, ...library.scenes, ...library.props]
        .find((asset) => asset.kind === kind && asset.id === assetId);
      if (assetId && !existing) {
        showToast('资产已删除，上传素材未绑定', 'info');
        return;
      }
      const now = Date.now();
      const base = existing ?? {
        id: `${kind}-${generateId()}`,
        name: uploaded.fileName.replace(/\.[^.]+$/, '') || uploaded.fileName,
        key: normalizeAssetKey(uploaded.fileName.replace(/\.[^.]+$/, '') || uploaded.fileName),
        summary: '', visualNotes: '', importance: 'supporting' as const,
        confirmed: true, createdAt: now, updatedAt: now, source: 'manual' as const,
      };
      const asset = { ...base, kind, ...(kind === 'prop' && !existing ? { propType: category === 'weapon' ? 'weapon' as const : undefined } : {}), imageNodeId: undefined, imageUrl: uploaded.dataUrl, filePath: uploaded.filePath,
        assetId: undefined, relativePath: undefined, imageAssetId: undefined, imageRelativePath: undefined, updatedAt: now };
      if (kind === 'character') {
        const referenceId = `reference-${generateId()}`;
        const character = existing?.kind === 'character' ? existing : undefined;
        const saved = await latest.saveCharacterCard('project', {
          ...asset, kind: 'character', identity: character?.identity ?? '',
          referenceImages: [...(character?.referenceImages ?? []), {
            id: referenceId, kind: 'primary', imageUrl: uploaded.dataUrl, prompt: '',
            relativePath: uploaded.filePath?.split(/[\\/]/).slice(-2).join('/'),
            createdAt: now, updatedAt: now,
          }],
          primaryReferenceImageId: referenceId,
          avatarReferenceImageId: undefined, avatarCrop: undefined,
        }, options);
        options.assertCurrent?.();
        if (!saved) throw new Error(translate('角色素材保存失败'));
      } else {
        const referenceId = `reference-${generateId()}`;
        const visual = existing && existing.kind !== 'character' ? normalizeDramaVisualAsset(existing) : undefined;
        if ((visual?.referenceImages?.length ?? 0) >= MAX_DRAMA_REFERENCE_IMAGES) throw new Error(t('每个场景或道具最多保存 {count} 张参考图', { count: MAX_DRAMA_REFERENCE_IMAGES }));
        const saved = await latest.saveDramaVisualAsset('project', {
          ...asset, kind, referenceImages: [...(visual?.referenceImages ?? []), {
            id: referenceId, label: uploaded.fileName.replace(/\.[^.]+$/, ''), prompt: '',
            imageUrl: uploaded.dataUrl, filePath: uploaded.filePath, createdAt: now, updatedAt: now,
          }], primaryReferenceImageId: referenceId,
        }, options);
        if (!saved) throw new Error(t('参考图保存失败，素材文件已保留，请重试'));
      }
      showToast(isTauriEnv() ? translate('素材已保存到 Library') : translate('素材已添加；浏览器模式不支持本地目录保存'));
  });

  const imageNodes = useMemo(
    () =>
      nodes
        .filter((n) => {
          const t = n.data?.type as string;
          return (
            t === 'ai-image'
            || t === 'source-image'
            || t === 'ai-panorama'
            || t === 'ai-storyboard'
          );
        })
        .map((n) => ({
          id: n.id,
          label: `${(n.data?.label as string) || '图像'} #${n.data?.displayId ?? ''}`,
        })),
    [nodes],
  );

  const totals = useMemo(
    () => ({
      character: dramaAssets.characters.length,
      scene: dramaAssets.scenes.length,
      prop: dramaAssets.props.filter((asset) => matchesDramaAssetCategory(asset, 'prop')).length,
      weapon: dramaAssets.props.filter((asset) => matchesDramaAssetCategory(asset, 'weapon')).length,
      all:
        dramaAssets.characters.length +
        dramaAssets.scenes.length +
        dramaAssets.props.length,
    }),
    [dramaAssets],
  );

  const sourceItems = useMemo(() => {
    let list: DramaAsset[] = [];
    if (tab === 'all' || tab === 'character') list = list.concat(dramaAssets.characters);
    if (tab === 'all' || tab === 'scene') list = list.concat(dramaAssets.scenes);
    if (tab === 'all') list = list.concat(dramaAssets.props);
    else if (tab === 'prop' || tab === 'weapon') list = list.concat(dramaAssets.props.filter((asset) => matchesDramaAssetCategory(asset, tab)));

    if (onlyImported) {
      const keys = new Set(lastImported.map(dramaAssetIdentityKey));
      list = list.filter((asset) => keys.has(dramaAssetIdentityKey(asset)));
    }
    return list;
  }, [dramaAssets, tab, onlyImported, lastImported]);
  const list = useDramaAssetList(sourceItems, search, `${projectId}:${tab}:${onlyImported}`);
  const { items } = list;

  const lastExtractLabel = useMemo(() => {
    const le = dramaAssets.lastExtract;
    if (!le) return null;
    const kinds = le.kinds.map((k) => t(DRAMA_ASSET_CATEGORY_LABEL[k])).join('、');
    const extractedAt = new Date(le.at);
    const time = `${extractedAt.getMonth() + 1}/${extractedAt.getDate()} ${String(extractedAt.getHours()).padStart(2, '0')}:${String(extractedAt.getMinutes()).padStart(2, '0')}`;
    return t('最近提取：{kinds} · {time}', { kinds, time });
  }, [dramaAssets.lastExtract, t]);

  const handleClearTab = useCallback(() => {
    if (tab === 'all') return;
    const library = useAppStore.getState().dramaAssets;
    setClearAssets([...library.characters, ...library.scenes, ...library.props].filter((asset) => matchesDramaAssetCategory(asset, tab)));
  }, [tab]);

  const beginCreate = () => {
    const category = tab === 'all' ? uploadKind : tab;
    if (category === 'character') { setCharacterLibraryOpen(true, { scope: 'project', origin: 'assets' }); return; }
    const kind = category === 'weapon' ? 'prop' : category;
    const now = Date.now();
    const base = { id: `${kind}-${generateId()}`, name: '', key: '', summary: '', visualNotes: '',
      importance: 'supporting' as const, confirmed: true, source: 'manual' as const, createdAt: now, updatedAt: now };
    setCreatingAsset(kind === 'scene' ? { ...base, kind } : { ...base, kind, propType: category === 'weapon' ? 'weapon' : undefined });
  };

  const copyBrief = useCallback(
    async (asset: DramaAsset) => {
      const text = formatDramaAssetTextBrief(asset);
      try {
        await navigator.clipboard.writeText(text);
        showToast('简介已复制');
      } catch {
        showToast('复制失败', 'error');
      }
    },
    [showToast],
  );

  return (
    <div className={`flex min-h-0 flex-1 flex-col${compact ? ' drama-assets--compact' : ''}`}>
      <div className="drama-assets-toolbar flex flex-wrap items-center gap-2 px-3 pt-3 pb-2 shrink-0">
        <label className="drama-assets-search ui-input-group w-48 max-w-full shrink-0">
          <span className="sr-only">{t('搜索创作资产')}</span>
          <Icon
            icon="mdi:magnify"
            width="14"
            height="14"
            aria-hidden="true"
            className="pointer-events-none ml-2 shrink-0 self-center text-canvas-text-muted"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('搜索名称、简介、别名…')}
            className="ui-input ui-input--sm select-text"
          />
        </label>
              {KIND_TABS.map(({ key, label }) => {
                const count = key === 'all' ? totals.all : totals[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`ui-btn ui-btn--ghost ui-btn--sm shrink-0${tab === key ? ' is-active' : ''}`}
                    aria-pressed={tab === key}
                    disabled={busy || creatingAsset !== null}
                    onClick={() => setTab(key)}
                  >
                    {t(label)}
                    {count > 0 ? ` ${count}` : ''}
                  </button>
                );
              })}
              {lastExtractLabel ? (
                <span className="ml-1 hidden min-w-0 truncate text-[10px] text-canvas-text-muted/70 md:block">
                  {lastExtractLabel}
                </span>
              ) : null}
              {(tab === 'all' || tab === 'character') ? (
                <button
                  type="button"
                  className="ui-btn ui-btn--ghost ui-btn--sm ml-auto shrink-0"
                  disabled={busy}
                  onClick={() => setCharacterLibraryOpen(true, { scope: 'project', origin: 'assets' })}
                >
                  {t('打开角色库')}
                </button>
              ) : null}
      <div className={`flex items-center gap-2 shrink-0 ${tab === 'all' || tab === 'character' ? '' : 'ml-auto'}`}>
        {tab === 'all' && (
          <Select aria-label={t('上传资产类型')} className="w-auto" size="sm" value={uploadKind} disabled={busy || creatingAsset !== null} fixedMenu
            onChange={(selectedOptionValue) => setUploadKind(selectedOptionValue as DramaAssetCategory)}>
            {KIND_TABS.filter((item) => item.key !== 'all').map((item) => (
              <option key={item.key} value={item.key}>{t(item.label)}</option>
            ))}
          </Select>
        )}
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || creatingAsset !== null}
          onClick={() => void handleUpload(tab === 'all' ? uploadKind : tab)}>
          <Icon icon="lucide:upload" width={14} aria-hidden="true" />
          {uploading ? t('上传中…') : t('上传{kind}图片', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[tab === 'all' ? uploadKind : tab]) })}
        </button>
        <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || creatingAsset !== null} onClick={beginCreate}>
          <Icon icon="lucide:plus" width={14} aria-hidden="true" />{t('新增{kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[tab === 'all' ? uploadKind : tab]) })}
        </button>
      </div>

              <div className="flex shrink-0 items-center gap-1">
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !isTauriEnv()}
                  aria-label={t('导入创作资产')} title={t('导入 .aicassets 创作资产包，追加到当前项目')}
                  onClick={() => void handleTransfer('import')}>
                  <Icon icon="lucide:import" width={14} aria-hidden="true" />{t('导入')}
                </button>
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !totals.all || !isTauriEnv()}
                  aria-label={t('导出创作资产')} title={t('导出当前项目的全部创作资产及媒体，不受分类或搜索影响')}
                  onClick={() => void handleTransfer('export')}>
                  <Download size={14} aria-hidden="true" />{t('导出')}
                </button>
              </div>
      </div>

      <DramaAssetListControls sortBy={list.sortBy} sortOrder={list.sortOrder} onSort={list.changeSort}
        selecting={list.selecting} onSelecting={list.toggleSelecting} selectedCount={list.selected.length} visibleCount={items.length}
        onSelectAll={list.selectAll} onExport={() => void handleTransfer('export', undefined, list.selected)}
        onCopy={() => void copyToGlobal(list.selected)} copyLabel={t('复制到全局')} busy={busy} canExport={isTauriEnv()} />
      {lastImported.length > 0 && <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-canvas-text-secondary">
        <span>{t('本次导入 {count} 项资产', { count: lastImported.length })}</span>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => {
          setSearch(''); setTab('all'); setOnlyImported((value) => !value); list.clearSelection();
        }}>{t(onlyImported ? '显示全部资产' : '查看本次导入')}</button>
      </div>}

      {busy && <div role="status" aria-live="polite" className="flex items-center gap-2 px-3 pb-2 text-xs text-canvas-text-secondary">
        <Icon icon="lucide:loader-circle" width={14} className="shrink-0 animate-spin" aria-hidden="true" />
        <span className="min-w-0 flex-1">{operationProgress}</span>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('取消资产操作')}
          disabled={cancelRequested || savingAssets}
          title={t('取消会阻止后续操作，当前文件操作结束后退出')}
          onClick={() => {
            const operation = operationRef.current;
            if (!operation || operation.saving) return;
            operation.controller.abort();
            setCancelRequested(true);
            setOperationProgress(t('已请求取消，等待当前文件操作结束…'));
          }}>{t(cancelRequested ? '取消中…' : '取消')}</button>
      </div>}

      {tab !== 'all' && totals[tab] > 0 ? (
        <div className="flex justify-end px-3 pb-1 shrink-0">
                <button
                  type="button"
                  className="text-[11px] text-canvas-text-muted hover:text-red-400 transition-colors"
                  disabled={operationKind === 'import'}
                  onClick={handleClearTab}
                >
                  {t('清空本类')}
                </button>
        </div>
      ) : null}

      <div className={`flex-1 overflow-y-auto px-3 pb-4${items.length > 0 || creatingAsset ? ' drama-assets-grid' : ''}`}
        inert={operationKind === 'import' || undefined} aria-busy={operationKind === 'import' || undefined}>
              {creatingAsset && <DramaAssetCard key={creatingAsset.id} asset={creatingAsset} creating editing imageNodes={[]}
                uploading={busy} onToggleEdit={() => { if (!busy) setCreatingAsset(null); }} onDelete={() => setCreatingAsset(null)}
                onBindImage={() => {}} onCopyBrief={() => {}} onUploadImage={() => {}}
                onSaveFields={(patch) => { void runOperation('save', async (_projectId, _ownerId, options) => {
                  if (creatingAsset.kind === 'character') return;
                  options.onProgress(t('正在保存资产'));
                  const saved = await useAppStore.getState().saveDramaVisualAsset('project', {
                    ...creatingAsset, ...patch, storyRole: patch.storyRole || undefined, key: normalizeAssetKey(patch.name), updatedAt: Date.now(),
                  }, options);
                  options.assertCurrent?.();
                  if (!saved) throw new Error(t('保存失败，修改仍保留，请重试'));
                  setCreatingAsset(null); showToast(t('已保存'));
                }); }} />}
              {items.length === 0 && !creatingAsset ? (
                <div className="flex flex-col items-center justify-center py-10 text-canvas-text-muted">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="mb-3 opacity-40"
                  >
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <p className="text-[13px] mb-1">
                    {t(search ? '无匹配资产' : '暂无短剧资产')}
                  </p>
                  <div className="text-[11px] text-center max-w-[340px] leading-relaxed opacity-90 space-y-1.5">
                    <p className="font-medium text-canvas-text-secondary">{t('可本地上传图片，也可管理简介与绑图')}</p>
                    <p>{t('1. 文本节点')} <code className="px-1 rounded bg-canvas-hover">/</code> {t('→ 提取人物/场景/道具')}</p>
                    <p>{t('2. 图像节点提示词中')} <code className="px-1 rounded bg-canvas-hover">@</code> {t('选资产（无图=简介）')}</p>
                    <p>{t('3. 再')} <code className="px-1 rounded bg-canvas-hover">/</code> {t('使用人设参考等生成资产图')}</p>
                    <p>{t('4. 生成后可在此「绑图」，之后 @ 即为参考图')}</p>
                  </div>
                </div>
              ) : (
                items.map((asset) => (
                  <DramaAssetCard
                    key={`${asset.kind}:${asset.id}`}
                    asset={asset}
                    thumb={resolveThumb(asset, nodes as Array<{ id: string; data: Record<string, unknown> }>)}
                    imageNodes={imageNodes}
                    editing={editingId === dramaAssetIdentityKey(asset)}
                    selecting={list.selecting} selected={list.selectedKeys.has(dramaAssetIdentityKey(asset))}
                    onToggleSelect={() => list.toggle(asset)}
                    onOpen={list.selecting ? () => list.toggle(asset) : asset.kind === 'character' ? () => setCharacterLibraryOpen(true, { scope: 'project', characterId: asset.id, origin: 'assets' }) : undefined}
                    onViewUsage={() => setUsage({ asset, deleting: false })}
                    onManageImages={asset.kind !== 'character' ? () => setGalleryAsset(asset) : undefined}
                    onToggleEdit={() =>
                      setEditingId((cur) => (cur === dramaAssetIdentityKey(asset) ? null : dramaAssetIdentityKey(asset)))
                    }
                    onDelete={() => setUsage({ asset, deleting: true })}
                    onSaveFields={(patch, displayed) => {
                      const state = useAppStore.getState();
                      const live = state.currentProjectId === projectId && state.projectLoadStatus === 'ready'
                        ? findDramaAssetByKind(state.dramaAssets, asset.kind, asset.id) : undefined;
                      if (!live) { showToast(t('资产已变化，请重新选择'), 'error'); return; }
                      const current = assetEditFields(live);
                      const fields = ['name', 'summary', 'visualNotes', 'storyRole', 'propType'] as const;
                      if (fields.some((key) => patch[key] !== displayed[key]
                        && current[key] !== displayed[key] && current[key] !== patch[key])) {
                        // 同一字段并发变更时保留输入，避免整卡保存覆盖刚同步的内容。
                        showToast(t('资产已变化，请重新选择'), 'error');
                        return;
                      }
                      const choose = <K extends keyof DramaAssetEditFields,>(key: K) =>
                        patch[key] === displayed[key] ? current[key] : patch[key];
                      const saved = updateDramaAssetFields(live.kind, live.id, {
                        name: choose('name'),
                        summary: choose('summary'),
                        visualNotes: choose('visualNotes'),
                        storyRole: choose('storyRole') || undefined,
                        ...(live.kind === 'prop' ? { propType: choose('propType') } : {}),
                      });
                      if (!saved) return;
                      setEditingId(null);
                      showToast('已保存');
                    }}
                    onBindImage={(nodeId) => {
                      bindDramaAssetImage(asset.kind, asset.id, nodeId);
                      showToast(t('已绑定图像节点'));
                    }}
                    onUnbindImage={() => void handleUnbindImage(asset)}
                    onCopyBrief={() => void copyBrief(asset)}
                    onCopyToScope={() => void copyToGlobal([asset])}
                    copyToScopeLabel={t('复制到全局')}
                    uploading={busy}
                    onExport={isTauriEnv() ? () => void handleTransfer('export', asset) : undefined}
                    onUploadImage={() => void handleUpload(asset.kind, asset.id)}
                  />
                ))
              )}
      </div>
      {importDialog}
      {usage && usageTarget && projectId && <Suspense fallback={null}><AssetUsageDialog target={usageTarget}
        onClose={() => setUsage(null)} onConfirmDelete={usage.deleting ? async () => {
          if (useAppStore.getState().currentProjectId !== projectId) throw new Error(t('项目已切换'));
          if (findDramaAssetByKind(useAppStore.getState().dramaAssets, usage.asset.kind, usage.asset.id) !== usage.asset) throw new Error(t('资产已变化，请重新选择'));
          deleteDramaAsset(usage.asset.kind, usage.asset.id);
          if (!await useAppStore.getState().saveCurrentProjectSilent()) throw new Error(t('删除保存失败，请重试'));
          setUsage(null);
        } : undefined} /></Suspense>}
      {galleryAsset && galleryAsset.kind !== 'character' && <Suspense fallback={null}>
        <DramaVisualReferencesDialog key={dramaAssetIdentityKey(galleryAsset)} scope="project" asset={galleryAsset} onClose={() => setGalleryAsset(null)} />
      </Suspense>}
      {clearAssets && clearTargets && clearAssets.length > 0 && projectId && <Suspense fallback={null}>
        <AssetUsageDialog targets={clearTargets} onClose={() => setClearAssets(null)} onConfirmDelete={async () => {
          const current = useAppStore.getState();
          if (current.currentProjectId !== projectId) throw new Error(t('项目已切换'));
          const category = getDramaAssetCategory(clearAssets[0]);
          const existing = [...current.dramaAssets.characters, ...current.dramaAssets.scenes, ...current.dramaAssets.props].filter((asset) => matchesDramaAssetCategory(asset, category));
          if (existing.length !== clearAssets.length || clearAssets.some((asset) => !existing.includes(asset))) throw new Error(t('资产已变化，请重新选择'));
          clearDramaAssetsByKind(category);
          if (!await useAppStore.getState().saveCurrentProjectSilent()) throw new Error(t('删除保存失败，请重试'));
          setClearAssets(null);
        }} />
      </Suspense>}
    </div>
  );
}
