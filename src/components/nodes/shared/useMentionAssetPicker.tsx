import type { useT } from '../../../i18n';
import { Suspense, useState, useCallback, useRef, useEffect, useMemo, useId, type LazyExoticComponent } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, type AppState } from '../../../store/useAppStore';
import { Icon } from '@iconify/react';
import {
  listGlobalFolderContents,
  listExternalFolderContents,
  selectAssetFolderFiles,
  type AssetFileEntry,
  type AssetFolderEntry,
  type AssetFolderSelection,
} from '../../../services/fileService';
import { getAllAssetMeta } from '../../../services/indexedDbService';
import { springSmooth, fadeFast } from '../../../utils/motion';
import { AnimatePresence, motion } from 'framer-motion';
import PopupCloseButton from '../../shared/PopupCloseButton';
import type { MentionPickerItem } from '../../shared/MentionPicker';
import ViewportImage from '../../shared/ViewportImage';
import VideoThumbnail from '../../shared/VideoThumbnail';
import { useDialogFocus } from '../../../hooks/useDialogFocus';
import type { DramaAssetCategory } from '../../../types/dramaAssets';
import type { listGlobalDramaAssets } from '../../../services/dramaAssetPrompt';
import { type resolveDramaMentionItems, resolveGlobalAssetPickerItems } from './mentionEditorSources';

interface MentionAssetPickerOptions {
  t: ReturnType<typeof useT>;
  showMention: boolean;
  setShowMention: (open: boolean) => void;
  resourceSearchExpanded: boolean;
  globalDramaAssetsLoading: boolean;
  globalDramaAssetsError: string | null;
  currentProjectId: string | null;
  globalAssets: ReturnType<typeof listGlobalDramaAssets>;
  isCurrentEditorOwner: () => boolean;
  currentNodeType?: AppState['nodes'][number]['data']['type'];
  focusMentionCursor: () => void;
  disabled: boolean;
  nodeId?: string;
  AssetFolderNavigation: LazyExoticComponent<typeof import('../../assets/AssetFolderNavigation').default>;
}

export function useMentionAssetPicker({
  t, showMention, setShowMention, resourceSearchExpanded, globalDramaAssetsLoading,
  globalDramaAssetsError, currentProjectId, globalAssets, isCurrentEditorOwner, currentNodeType,
  focusMentionCursor, disabled, nodeId, AssetFolderNavigation,
}: MentionAssetPickerOptions) {
  // ── 资产引用弹窗 ──
  const assetFolders = useAppStore((s) => s.config.assetFolders);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [assetList, setAssetList] = useState<AssetFileEntry[]>([]);
  const [assetFolderEntries, setAssetFolderEntries] = useState<AssetFolderEntry[]>([]);
  const [assetGlobalRootPath, setAssetGlobalRootPath] = useState<string | null>(null);
  const [assetFolderSelection, setAssetFolderSelection] = useState<AssetFolderSelection>({ kind: 'all' });
  const [assetCreativeKind, setAssetCreativeKind] = useState<DramaAssetCategory | null>(null);
  const assetPickerDialogRef = useRef<HTMLDivElement>(null);
  const [assetTagMap, setAssetTagMap] = useState<Record<string, string[]>>({});
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetLoadError, setAssetLoadError] = useState(false);
  const [assetScanTruncated, setAssetScanTruncated] = useState(false);
  const [assetLoadRevision, setAssetLoadRevision] = useState(0);
  const [assetSearch, setAssetSearch] = useState('');
  const [activeAssetTag, setActiveAssetTag] = useState<string | null>(null);
  const [assetTagsExpanded, setAssetTagsExpanded] = useState(false);
  const [assetTagsOverflow, setAssetTagsOverflow] = useState(false);
  const [visibleAssetTagCount, setVisibleAssetTagCount] = useState(Number.POSITIVE_INFINITY);
  const assetTagRowRef = useRef<HTMLDivElement>(null);
  const assetTagListRef = useRef<HTMLDivElement>(null);
  const assetTagListId = useId();
  const assetSentinelRef = useRef<HTMLDivElement | null>(null);

  // ── 打开资产弹窗（保持 @ 处的光标范围，关闭 @ 菜单）──
  const openAssetPicker = useCallback(() => {
    focusMentionCursor();
    setShowMention(false);
    setShowAssetPicker(true);
    setAssetSearch('');
    setAssetFolderSelection({ kind: 'all' });
    setAssetCreativeKind(null);
    setActiveAssetTag(null);
    setAssetTagsExpanded(false);
  }, [focusMentionCursor, setShowMention]);

  const closeAssetPicker = useCallback(() => {
    setShowAssetPicker(false);
    focusMentionCursor();
  }, [focusMentionCursor]);
  useDialogFocus(showAssetPicker && !disabled, assetPickerDialogRef, closeAssetPicker, { zIndex: 10050 });

  // 只在搜索/资产弹窗打开时读取目录；键入关键词只过滤本轮缓存。
  const shouldLoadAssets = showAssetPicker || (showMention && resourceSearchExpanded);
  const assetLoadRequest = useMemo(() => shouldLoadAssets
    ? { assetFolders, assetLoadRevision, currentProjectId, nodeId } : null,
  [shouldLoadAssets, assetFolders, assetLoadRevision, currentProjectId, nodeId]);
  const [activeAssetLoad, setActiveAssetLoad] = useState<typeof assetLoadRequest>(null);
  if (assetLoadRequest && assetLoadRequest !== activeAssetLoad) {
    setActiveAssetLoad(assetLoadRequest);
    setAssetList([]);
    setAssetFolderEntries([]);
    setAssetGlobalRootPath(null);
    setAssetTagMap({});
    setAssetLoading(true);
    setAssetLoadError(false);
    setAssetScanTruncated(false);
  }
  useEffect(() => {
    if (!assetLoadRequest) return;
    const { assetFolders, currentProjectId } = assetLoadRequest;
    let alive = true;
    const controller = new AbortController();
    void Promise.allSettled([listGlobalFolderContents({ signal: controller.signal }), listExternalFolderContents(assetFolders ?? [], { maxFilesPerFolder: 3000, signal: controller.signal }), getAllAssetMeta()])
      .then(([globalResult, folderResult, metaResult]) => {
        if (!alive || useAppStore.getState().currentProjectId !== currentProjectId) return;
        const globalFiles = globalResult.status === 'fulfilled' ? globalResult.value.files : [];
        const folderFiles = folderResult.status === 'fulfilled' ? folderResult.value.files : [];
        const metas = metaResult.status === 'fulfilled' ? metaResult.value : [];
        const seen = new Set<string>();
        const merged: AssetFileEntry[] = [];
        for (const f of [...globalFiles, ...folderFiles]) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          merged.push(f);
        }
        const tagMap: Record<string, string[]> = {};
        for (const m of metas) if (m.tags?.length) tagMap[m.assetId] = m.tags;
        setAssetList(merged);
        const folders = [...(globalResult.status === 'fulfilled' ? globalResult.value.folders : []),
          ...(folderResult.status === 'fulfilled' ? folderResult.value.folders : [])];
        const uniqueFolders = Array.from(new Map(folders.map((folder) => [JSON.stringify([folder.rootPath, folder.relativePath]), folder])).values());
        setAssetFolderEntries(uniqueFolders);
        setAssetFolderSelection((selection) => selection.kind === 'folder'
          && !uniqueFolders.some((folder) => folder.rootPath === selection.rootPath && folder.relativePath === selection.relativePath)
          ? { kind: 'all' } : selection);
        setAssetGlobalRootPath(globalResult.status === 'fulfilled' ? globalResult.value.rootPath : null);
        setAssetTagMap(tagMap);
        setAssetLoadError(globalResult.status === 'rejected' || folderResult.status === 'rejected'
          || (globalResult.status === 'fulfilled' && globalResult.value.folders.some((folder) => folder.availability === 'offline'))
          || (folderResult.status === 'fulfilled' && folderResult.value.folders.some((folder) => folder.availability === 'offline')));
        setAssetScanTruncated((globalResult.status === 'fulfilled' && globalResult.value.truncated)
          || (folderResult.status === 'fulfilled' && folderResult.value.truncated));
      })
      .catch(() => { if (alive && useAppStore.getState().currentProjectId === currentProjectId) setAssetLoadError(true); })
      .finally(() => { if (alive && useAppStore.getState().currentProjectId === currentProjectId) setAssetLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [assetLoadRequest]);

  // 标签合并 + 派生标签 chip
  const taggedAssets = useMemo(
    () => assetList.map((f) => {
      const key = f.assetId ?? f.path;
      return assetTagMap[key] ? { ...f, tags: assetTagMap[key] } : f;
    }),
    [assetList, assetTagMap],
  );
  const folderAssets = useMemo(() => selectAssetFolderFiles(taggedAssets, assetFolderSelection), [taggedAssets, assetFolderSelection]);
  const globalPickerItems = useMemo(() => showAssetPicker ? resolveGlobalAssetPickerItems(globalAssets, null, '', currentNodeType) : [],
    [showAssetPicker, globalAssets, currentNodeType]);
  const creativePickerItems = useMemo(() => showAssetPicker && assetCreativeKind ? resolveGlobalAssetPickerItems(globalAssets, assetCreativeKind, assetSearch, currentNodeType) : [],
    [showAssetPicker, globalAssets, assetCreativeKind, assetSearch, currentNodeType]);
  const creativePickerCounts = useMemo(() => ({
    character: globalPickerItems.filter((item) => item.category === 'character').length,
    scene: globalPickerItems.filter((item) => item.category === 'scene').length,
    prop: globalPickerItems.filter((item) => item.category === 'prop').length,
    weapon: globalPickerItems.filter((item) => item.category === 'weapon').length,
  }), [globalPickerItems]);
  const assetTagList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of folderAssets) for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  }, [folderAssets]);

  // 沿用资产库的完整单排标签与“更多”折叠方式，缩放动画中用布局宽度测量。
  useEffect(() => {
    if (!showAssetPicker || disabled || assetCreativeKind) return;
    const row = assetTagRowRef.current;
    const list = assetTagListRef.current;
    if (!row || !list) return;
    const measure = () => {
      const rowStyle = window.getComputedStyle(row);
      const availableWidth = row.clientWidth - (parseFloat(rowStyle.paddingLeft) || 0) - (parseFloat(rowStyle.paddingRight) || 0);
      const rowGap = parseFloat(rowStyle.columnGap) || 0;
      const listGap = parseFloat(window.getComputedStyle(list).columnGap) || 0;
      const widths = Array.from(list.children, (item) => (item as HTMLElement).offsetWidth);
      const contentWidth = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * listGap;
      const overflow = contentWidth > availableWidth + 1;
      setAssetTagsOverflow(overflow);
      if (!overflow) {
        setVisibleAssetTagCount(widths.length);
        setAssetTagsExpanded(false);
        return;
      }
      let usedWidth = 0;
      let visibleCount = 0;
      for (const width of widths) {
        const nextWidth = usedWidth + (visibleCount > 0 ? listGap : 0) + width;
        if (nextWidth > availableWidth - 28 - rowGap) break;
        usedWidth = nextWidth;
        visibleCount++;
      }
      setVisibleAssetTagCount(visibleCount);
    };
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [showAssetPicker, disabled, assetCreativeKind, assetTagList, assetTagsExpanded]);

  const filteredAssets = useMemo(() => {
    const q = assetSearch.trim().toLowerCase();
    return folderAssets.filter((f) => {
      if (activeAssetTag && !(f.tags ?? []).includes(activeAssetTag)) return false;
      if (q) {
        const inName = f.name.toLowerCase().includes(q);
        const inTags = (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    });
  }, [folderAssets, assetSearch, activeAssetTag]);

  const assetFilters = useMemo(() => ({ assetSearch, activeAssetTag, showAssetPicker, assetFolderSelection, assetCreativeKind }),
    [assetSearch, activeAssetTag, showAssetPicker, assetFolderSelection, assetCreativeKind]);
  const [assetPage, setAssetPage] = useState<{ filters: typeof assetFilters; visible: number }>();
  const assetVisible = assetPage?.filters === assetFilters ? assetPage.visible : 40;
  const visibleAssets = useMemo(() => filteredAssets.slice(0, assetVisible), [filteredAssets, assetVisible]);
  const visibleCreativePickerItems = useMemo(() => creativePickerItems.slice(0, assetVisible), [creativePickerItems, assetVisible]);
  const assetPickerResultCount = assetCreativeKind ? creativePickerItems.length : filteredAssets.length;
  useEffect(() => {
    // 搜索可先预读资产；弹窗真正显示列表后才有哨兵，开关和加载状态也需重新绑定。
    if (!showAssetPicker || disabled || (assetCreativeKind ? globalDramaAssetsLoading : assetLoading)) return;
    const el = assetSentinelRef.current;
    if (!el) return;
    const root = el.closest('.asset-picker-grid') as HTMLElement | null;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setAssetPage((page) => {
          const visible = page?.filters === assetFilters ? page.visible : 40;
          return visible < assetPickerResultCount ? { filters: assetFilters, visible: visible + 40 } : page;
        });
      }
    }, { root, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [showAssetPicker, disabled, assetLoading, globalDramaAssetsLoading, assetCreativeKind, assetFilters, assetPickerResultCount, assetVisible]);

  const resetAssetSelection = useCallback(() => {
    setAssetList([]);
    setAssetFolderEntries([]);
    setAssetGlobalRootPath(null);
    setAssetFolderSelection({ kind: 'all' });
    setAssetCreativeKind(null);
    setAssetTagMap({});
  }, []);

  const renderAssetPicker = (
    buildDramaPickerItem: (item: ReturnType<typeof resolveDramaMentionItems>[number]) => MentionPickerItem,
    handleSelectAsset: (file: AssetFileEntry) => void,
  ) => createPortal(
    <AnimatePresence>
      {showAssetPicker && !disabled && (
        <motion.div
          data-tauri-drag-region
          data-mention-picker-open=""
          className="asset-picker-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onMouseDown={closeAssetPicker}
        >
          <motion.div
            ref={assetPickerDialogRef}
            className="asset-picker"
            role="dialog"
            aria-modal="true"
            aria-label={t('选择全局资产')}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12, transition: fadeFast }}
            transition={springSmooth}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="asset-picker-header">
              <div className="asset-picker-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text" placeholder={assetCreativeKind ? t('搜索名称、简介…') : t('搜索名称或标签…')} aria-label={t('搜索全局资产')}
                  value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)}
                />
              </div>
              <PopupCloseButton onClick={closeAssetPicker} />
            </div>


            <div className="asset-picker-body">
              <div className="asset-picker-sidebar">
                <Suspense fallback={<p role="status" className="p-3 text-xs text-canvas-text-muted">{t('正在打开分类…')}</p>}>
                <AssetFolderNavigation
                  readOnly compact={false} folders={assetFolderEntries} selection={assetFolderSelection}
                  totalCount={assetList.length} globalCount={selectAssetFolderFiles(assetList, { kind: 'global' }).length}
                  globalRootPath={assetGlobalRootPath} loading={assetLoading}
                  creativeKind={assetCreativeKind} creativeCounts={creativePickerCounts}
                  onSelect={(selection) => {
                    setAssetCreativeKind(null); setAssetFolderSelection(selection); setActiveAssetTag(null); setAssetTagsExpanded(false);
                  }}
                  onSelectCreative={(kind) => {
                    setAssetCreativeKind(kind); setActiveAssetTag(null); setAssetTagsExpanded(false);
                  }}
                />
                </Suspense>
              </div>
              <div className="asset-picker-content">
            {!assetCreativeKind && (assetLoadError || assetScanTruncated) && <div role="status" className="flex flex-wrap items-center gap-2 p-2 text-xs text-canvas-text-secondary">
              <span>{assetLoadError ? t('部分目录读取失败') : t('目录文件较多，当前仅显示已扫描的文件')}</span>
              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={assetLoading} onClick={() => setAssetLoadRevision((revision) => revision + 1)}>{t('重新读取')}</button>
            </div>}
            {/* 标签筛选 */}
            {!assetCreativeKind && assetTagList.length > 0 && (
              <div ref={assetTagRowRef} className={`asset-picker-tags${assetTagsExpanded ? ' expanded' : ''}`}>
                <div ref={assetTagListRef} id={assetTagListId} className="assets-category-list">
                  <button
                    type="button"
                    className={`asset-picker-tag ${activeAssetTag === null ? 'active' : ''} ${assetTagsExpanded || visibleAssetTagCount > 0 ? '' : 'assets-filter-item-hidden'}`}
                    aria-pressed={activeAssetTag === null}
                    onClick={() => setActiveAssetTag(null)}
                  >{t('全部')}</button>
                  {assetTagList.map(([tag, count], index) => (
                    <button
                      key={tag}
                      type="button"
                      className={`asset-picker-tag ${activeAssetTag === tag ? 'active' : ''} ${assetTagsExpanded || index + 1 < visibleAssetTagCount ? '' : 'assets-filter-item-hidden'}`}
                      aria-pressed={activeAssetTag === tag}
                      title={tag}
                      onClick={() => setActiveAssetTag((t) => (t === tag ? null : tag))}
                    ><span className="asset-picker-tag-label">#{tag}</span><span className="asset-picker-tag-count">{count}</span></button>
                  ))}
                </div>
                {assetTagsOverflow && (
                  <button type="button" className="assets-filter-more" aria-controls={assetTagListId}
                    aria-expanded={assetTagsExpanded} aria-label={assetTagsExpanded ? t('收起标签') : t('展开更多标签')}
                    title={assetTagsExpanded ? t('收起标签') : t('更多标签')} onClick={() => setAssetTagsExpanded((expanded) => !expanded)}>
                    <Icon icon={assetTagsExpanded ? 'lucide:chevron-up' : 'lucide:ellipsis'} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            <div key={assetCreativeKind ?? JSON.stringify(assetFolderSelection)} className="asset-picker-grid">
              {assetCreativeKind ? (
                globalDramaAssetsLoading ? <div role="status" className="asset-picker-empty">{t('正在加载创作资产…')}</div>
                  : globalDramaAssetsError ? <div role="alert" className="asset-picker-empty">
                    <p>{t('创作资产加载失败，请重试')}</p>
                    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => {
                      void useAppStore.getState().loadGlobalDramaAssets().catch(() => {});
                    }}>{t('重试加载')}</button>
                  </div>
                    : creativePickerItems.length === 0 ? <div className="asset-picker-empty">{assetSearch ? t('没有匹配的创作资产') : t('暂无可引用的创作资产')}</div>
                      : visibleCreativePickerItems.map((item) => {
                        const candidate = buildDramaPickerItem(item);
                        return <button key={candidate.key} type="button" className="asset-picker-card" disabled={candidate.disabled}
                          data-tooltip={candidate.title ?? candidate.label} onClick={() => {
                            if (!isCurrentEditorOwner()) return;
                            setShowAssetPicker(false);
                            setShowMention(true);
                            candidate.onSelect();
                          }}>
                          {candidate.thumbnailUrl ? <ViewportImage src={candidate.thumbnailUrl} alt="" />
                            : <span className="asset-picker-card-icon"><Icon icon={candidate.icon ?? 'lucide:image'} aria-hidden="true" /></span>}
                          <span className="asset-picker-card-name">{candidate.label}{candidate.badge ? ` · ${candidate.badge}` : ''}</span>
                        </button>;
                      })
              ) : assetLoading ? (
                <div className="asset-picker-empty">{t('加载中…')}</div>
              ) : filteredAssets.length === 0 ? (
                <div className="asset-picker-empty">{assetSearch || activeAssetTag ? t('没有匹配的文件') : t('暂无文件')}</div>
              ) : (
                <>
                  {visibleAssets.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      className="asset-picker-card"
                      data-tooltip={file.name}
                      onClick={() => handleSelectAsset(file)}
                    >
                      {file.category === 'video' ? (
                        <VideoThumbnail src={file.assetUrl} filePath={file.path} name={file.name} alt={file.name}
                          className="aspect-square w-full object-cover" />
                      ) : file.assetUrl ? (
                        <ViewportImage src={file.assetUrl} alt={file.name} />
                      ) : (
                        <span className="asset-picker-card-icon">
                          {file.category === 'audio' ? '🎵' : file.category === 'text' ? '📄' : '📁'}
                        </span>
                      )}
                      <span className="asset-picker-card-name">{file.name}</span>
                    </button>
                  ))}
                </>
              )}
              {assetVisible < assetPickerResultCount && (
                <div ref={assetSentinelRef} className="asset-picker-sentinel">{t('加载更多…')}</div>
              )}
            </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );

  return {
    showAssetPicker, setShowAssetPicker, resetAssetSelection, assetLoading, assetLoadError,
    assetScanTruncated, setAssetLoadRevision, openAssetPicker, taggedAssets, renderAssetPicker,
  };
}
