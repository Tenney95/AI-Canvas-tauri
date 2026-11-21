/**
 * AssetsPanel 资产管理面板 — 浏览项目文件 + 全局资产库（永久），支持：
 *  · 添加本地文件（拷贝到全局 {baseDataDir}/file）/ 文件夹（递归引用，不拷贝）
 *  · 搜索（名称 + 标签）、分类与标签筛选
 *  · 手动为文件打标签（持久化到 IndexedDB assetMeta）
 * 性能：useDeferredValue 搜索 + useMemo 过滤 + 增量渲染（IntersectionObserver）+ 图片懒加载，
 *       并移除了大列表下昂贵的逐项 layout 动画。
 */
import { t as translate, useT } from '../i18n';

import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useDeferredValue,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { Cloud, Link2, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { listTopLevelProjects, listEpisodes, projectMemoryOwnerId, seriesOwnerId } from '../store/store.utils';
import type { NativeProjectViewItem } from '../store/nativeProjectView';
import {
  selectAssetFolderFiles,
  deletePermanentFile,
  revealFileInFolder,
  isTauriEnv,
  CATEGORY_LABELS,
  type AssetFileEntry,
  type FileCategory,
  type AssetFolderSelection,
} from '../services/fileService';
import { copyFile, copyText } from '../services/clipboardService';
import { loadAssetImageDetails } from '../services/assetImageDetails';
import { loadAssetVideoHistory } from '../services/assetVideoDetails';
import { getAssetLastUsedTimes } from '../services/indexedDbService';
import { prepareDragIcon } from '../utils/assetDrag';
import { ALL_CATEGORIES, CATEGORY_ICONS, shortFolderName } from '../utils/assetFormat';
import { sortAssetFiles } from '../utils/assetSort';
import { assetKey, useAssetFileInventory, useAssetFilterRow, type FileTabKey, type TabKey } from './assets/useAssetFileInventory';
import { isDraggableEntry, isLocalAssetFile, useAssetFolderActions } from './assets/useAssetFolderActions';
import AssetThumb from './shared/AssetThumb';
import PanelResizeHandle from './shared/PanelResizeHandle';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';
import Tabs, { type TabItem } from './shared/Tabs';
import { springSmooth, fadeFast } from '../utils/motion';
import { countUnreadDramaAssets } from '../store/store.dramaAssets';
import { distributeToColumns } from './assets/waterfallColumns';
import { getNodeTypeConfig, type AssetSortBy, type AssetSortOrder } from '../types';
import CanvasNodeCardContent from './assets/CanvasNodeCardContent';
import AssetFolderNavigation from './assets/AssetFolderNavigation';
import AssetImagePreview from './assets/AssetImagePreview';
import AssetFileContextMenu from './assets/AssetFileContextMenu';
import { useResourceVideoPreview } from '../hooks/useResourceVideoPreview';
import type { AssetImageBatchEntry } from '../types/assetImage';
import type { DramaAssetCategory, DramaAssetKind } from '../types/dramaAssets';
import { matchesDramaAssetCategory } from '../services/dramaAssetSearch';
import type { AssetRepairTarget } from '../services/fs/assetRepair';

const AssetTextPreview = lazy(() => import('./assets/AssetTextPreview'));
const DramaAssetsPanel = lazy(() => import('./DramaAssetsPanel'));
const VolcengineAssetLibraryPanel = lazy(() => import('./volcengine/VolcengineAssetLibraryPanel'));
const RefModAssetsPanel = lazy(() => import('./assets/RefModAssetsPanel'));
const AssetImageBatchReverseDialog = lazy(() => import('./assets/AssetImageBatchReverseDialog'));
const GlobalCreativeAssetsPanel = lazy(() => import('./assets/GlobalCreativeAssetsPanel'));
const GlobalCreativeAssetFileDialog = lazy(() => import('./assets/GlobalCreativeAssetsPanel').then((module) => ({ default: module.GlobalCreativeAssetFileDialog })));
const AssetRepairDialog = lazy(() => import('./assets/AssetRepairDialog'));
const SharedProjectBindingDialog = lazy(() => import('./assets/SharedProjectBindingDialog'));
const WsagentSharedImagesDialog = lazy(() => import('./assets/WsagentSharedImagesDialog'));

/** 单页渲染数量（增量加载步长）— 限制 DOM 规模 */
const PAGE_SIZE = 48;
/** 标签筛选行最多展示的标签数 */
const MAX_TAG_CHIPS = 24;
const MIN_WATERFALL_COLUMNS = 2;
const MAX_WATERFALL_COLUMNS = 6;
const DEFAULT_WATERFALL_COLUMNS = 3;
const ASSETS_DRAWER_MIN_WIDTH = 320;
const ASSETS_DRAWER_MAX_WIDTH = 720;
const FILE_SORT_OPTIONS: { value: AssetSortBy; label: string }[] = [
  { value: 'name', label: '名称' },
  { value: 'createdAt', label: '创建时间' },
  { value: 'modifiedAt', label: '修改时间' },
  { value: 'size', label: '文件大小' },
  { value: 'usedAt', label: '最近使用' },
];

function normalizeWaterfallColumns(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WATERFALL_COLUMNS;
  return Math.min(MAX_WATERFALL_COLUMNS, Math.max(MIN_WATERFALL_COLUMNS, Math.round(value)));
}

const backdropVariants = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: { opacity: 1, scale: 1, y: 0, transition: springSmooth },
  exit: { opacity: 0, scale: 0.95, y: 20, transition: fadeFast },
};

export default function AssetsPanel() {
  useT();
  const reduceMotion = useReducedMotion();
  const macWindowControls = isTauriEnv() && typeof navigator !== 'undefined'
    && /Macintosh|Mac OS X/.test(navigator.userAgent);
  const {
    assetsPanelOpen,
    assetsPanelMode,
    assetsPanelRequest,
    markAssetUsed,
    setAssetsPanelOpen,
    dramaAssetsPanelOpen,
    setDramaAssetsPanelOpen,
    markDramaAssetsViewed,
    dramaAssetsForCount,
    dramaAssetCount,
    canvasNodeCount,
    currentProjectId,
    projects,
    baseDataDir,
    assetFolders,
    assetWaterfallColumns,
    assetSortBy,
    assetSortOrder,
    recentAssetsRevision,
    updateConfig,
    saveConfig,
  } =
    useAppStore(
      useShallow((s) => ({
        assetsPanelOpen: s.assetsPanelOpen,
        assetsPanelMode: s.assetsPanelMode,
        assetsPanelRequest: s.assetsPanelRequest,
        markAssetUsed: s.markAssetUsed,
        setAssetsPanelOpen: s.setAssetsPanelOpen,
        dramaAssetsPanelOpen: s.dramaAssetsPanelOpen,
        setDramaAssetsPanelOpen: s.setDramaAssetsPanelOpen,
        markDramaAssetsViewed: s.markDramaAssetsViewed,
        dramaAssetsForCount: s.assetsPanelOpen ? s.dramaAssets : undefined,
        dramaAssetCount:
          s.dramaAssets.characters.length
          + s.dramaAssets.scenes.length
          + s.dramaAssets.props.length,
        canvasNodeCount: s.nodes.length,
        currentProjectId: s.currentProjectId,
        projects: s.projects,
        baseDataDir: s.config.baseDataDir,
        assetFolders: s.config.assetFolders,
        assetWaterfallColumns: s.config.assetWaterfallColumns,
        assetSortBy: s.config.assetSortBy,
        assetSortOrder: s.config.assetSortOrder,
        recentAssetsRevision: s.recentAssetsRevision,
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
      })),
    );

  const unreadDramaAssetCount = useMemo(() => dramaAssetsForCount ? countUnreadDramaAssets(dramaAssetsForCount) : 0, [dramaAssetsForCount]);

  const [activeTab, setActiveTab] = useState<FileTabKey>('project');
  const [globalCreativeKind, setGlobalCreativeKind] = useState<DramaAssetCategory | null>(null);
  const [creativeFile, setCreativeFile] = useState<{ file: AssetFileEntry; kind: DramaAssetKind; scope: string } | null>(null);
  const { globalCharacterCount, globalSceneCount, globalPropsForCount } = useAppStore(useShallow((state) => ({
    globalCharacterCount: state.assetsPanelOpen ? state.globalCharacters?.length ?? 0 : 0,
    globalSceneCount: state.assetsPanelOpen ? state.globalScenes?.length ?? 0 : 0,
    globalPropsForCount: state.assetsPanelOpen ? state.globalProps : undefined,
  })));
  const creativeCounts = useMemo(() => ({
    character: globalCharacterCount, scene: globalSceneCount,
    prop: globalPropsForCount?.filter((asset) => matchesDramaAssetCategory(asset, 'prop')).length ?? 0,
    weapon: globalPropsForCount?.filter((asset) => matchesDramaAssetCategory(asset, 'weapon')).length ?? 0,
  }), [globalCharacterCount, globalSceneCount, globalPropsForCount]);
  const loadGlobalDramaAssets = useAppStore((state) => state.loadGlobalDramaAssets);
  const [arkLibraryOpen, setArkLibraryOpen] = useState(false);
  const [refmodLibraryOpen, setRefmodLibraryOpen] = useState(false);
  const [refmodCount, setRefmodCount] = useState(0);
  const [nodeListOpen, setNodeListOpen] = useState(false);
  const visibleTab: TabKey = dramaAssetsPanelOpen ? 'drama' : nodeListOpen ? 'nodes' : arkLibraryOpen ? 'ark' : refmodLibraryOpen ? 'refmods' : activeTab;
  const isGlobalCreative = visibleTab === 'permanent' && globalCreativeKind !== null;
  const isFileTab = visibleTab === 'project' || visibleTab === 'permanent';
  const isNodeList = visibleTab === 'nodes';
  // 只在节点页订阅标识和内容；移动节点不改变 data，避免位置更新重绘整个资产面板。
  const canvasNodeIds = useAppStore(useShallow((s) => assetsPanelOpen && isNodeList ? s.nodes.map((node) => node.id) : []));
  const canvasNodeData = useAppStore(useShallow((s) => assetsPanelOpen && isNodeList ? s.nodes.map((node) => node.data) : []));
  // 项目文件 Tab 查看的项目；null 表示「跟随当前项目」（关闭时复位，故每次打开默认当前项目）
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectedOwnerId = selectedProjectId ?? currentProjectId;
  const viewProjectId = selectedOwnerId ? seriesOwnerId(projects, selectedOwnerId) : null;
  const currentOwnerId = currentProjectId ? seriesOwnerId(projects, currentProjectId) : null;
  const sharingOwnerId = currentProjectId ? projectMemoryOwnerId(projects, currentProjectId) : null;
  const sharingProjectReady = useAppStore((state) => state.projectInitialized && state.projectLoadStatus === 'ready');
  const canManageProjectSharing = sharingProjectReady && !!currentOwnerId && currentOwnerId === viewProjectId
    && (visibleTab === 'project' || visibleTab === 'drama');
  const [sharingOwner, setSharingOwner] = useState<{ id: string; name: string; sync?: boolean } | null>(null);
  const [wsagentOwner, setWsagentOwner] = useState<string>();
  // 视图离开时撤销弹窗，返回旧视图也不能重新打开已取消的操作。
  if (sharingOwner && (!assetsPanelOpen || !canManageProjectSharing || sharingOwner.id !== sharingOwnerId)) setSharingOwner(null);
  if (wsagentOwner && (!assetsPanelOpen || !canManageProjectSharing || wsagentOwner !== sharingOwnerId)) setWsagentOwner(undefined);
  const viewProjectIds = useAppStore(useShallow((state) => viewProjectId
    ? [viewProjectId, ...listEpisodes(state.projects, viewProjectId).map((project) => project.id)] : []));
  const nativeFileOwner = (projects.find((project) => project.id === viewProjectId) as Partial<NativeProjectViewItem> | undefined)
    ?.nativeView?.projectId;
  const folders = useMemo(() => assetFolders ?? [], [assetFolders]);
  const {
    setProjectFileOwners, projectIdForFile, projectFiles, setProjectFiles, permanentFiles,
    setPermanentFiles, externalFolders, globalRootPath, folderSelection, setFolderSelection,
    deletedFilePathsRef, folderScanTruncated, tagMap, setTagMap, loading, loadError, loadControllerRef,
    loadRequestRef, loadTags, loadFiles, addTag, removeTag,
  } = useAssetFileInventory({
    activeTab, currentProjectId, selectedProjectId, baseDataDir, viewProjectIds, nativeFileOwner,
    folders,
  });
  const [activeCategory, setActiveCategory] = useState<FileCategory | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [nodeSearch, setNodeSearch] = useState('');
  const deferredNodeSearch = useDeferredValue(nodeSearch);
  const isDrawer = assetsPanelMode === 'drawer';
  const isPage = assetsPanelMode === 'page';
  // 抽屉退场后会卸载 DOM，组件内保留宽度供同一会话重开。
  const drawerWrapperRef = useRef<HTMLDivElement | null>(null);
  const drawerWidthRef = useRef('');
  const setDrawerWrapper = useCallback((wrapper: HTMLDivElement | null) => {
    drawerWrapperRef.current = wrapper;
    if (wrapper) wrapper.style.width = drawerWidthRef.current;
  }, []);
  const resizeDrawer = useCallback((width: number) => {
    // 用现有侧栏偏移和窗口边距限宽，拖动时无需重渲染资产列表。
    drawerWidthRef.current = `min(${Math.round(width)}px, calc(100vw - var(--assets-drawer-left) - 12px))`;
    if (drawerWrapperRef.current) drawerWrapperRef.current.style.width = drawerWidthRef.current;
  }, []);
  const waterfallColumns = isDrawer ? DEFAULT_WATERFALL_COLUMNS : normalizeWaterfallColumns(assetWaterfallColumns);
  const sortBy: AssetSortBy = assetSortBy === 'createdAt' || assetSortBy === 'modifiedAt' || assetSortBy === 'size' || assetSortBy === 'usedAt'
    ? assetSortBy : 'name';
  const sortOrder: AssetSortOrder = assetSortOrder === 'desc' ? 'desc' : 'asc';
  const [assetUsage, setAssetUsage] = useState<ReadonlyMap<string, number>>(() => new Map());

  const folderOperationRef = useRef<AbortController | null>(null);
  const [textPreview, setTextPreview] = useState<{ file: AssetFileEntry; scope: string } | null>(null);
  const [imagePreview, setImagePreview] = useState<{ path: string; scope: string } | null>(null);
  const [batchReverse, setBatchReverse] = useState<{ scope: string; entries: AssetImageBatchEntry[] } | null>(null);
  const closeBatchReverse = useCallback(() => setBatchReverse(null), []);
  const [fileMenu, setFileMenu] = useState<{ file: AssetFileEntry; scope: string; projectId?: string; x: number; y: number; confirmDelete?: boolean } | null>(null);
  const [repairTarget, setRepairTarget] = useState<AssetRepairTarget | null>(null);
  const fileOperationRef = useRef<AbortController | null>(null);
  const fileScopeRef = useRef<string | null>(null);
  const [hoverDetails, setHoverDetails] = useState<{ key: string; scope: string; text: string } | null>(null);
  const hoverRequestRef = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelHoverRead = useCallback(() => {
    if (!hoverRequestRef.current) return;
    clearTimeout(hoverRequestRef.current.timer);
    hoverRequestRef.current.controller.abort();
    hoverRequestRef.current = null;
  }, []);
  const clearHover = useCallback(() => {
    cancelHoverRead();
    setHoverDetails(null);
  }, [cancelHoverRead]);
  const dismissHover = useCallback(() => {
    cancelHoverRead();
    setHoverDetails((previous) => previous ? { ...previous, text: '' } : null);
  }, [cancelHoverRead]);
  // 删除不改画布节点；防止刷新时将节点中残留的旧路径重新补入列表。
  const closeFileMenu = useCallback(() => {
    fileOperationRef.current?.abort();
    setFileMenu(null);
  }, []);
  const closeImagePreview = useCallback(() => setImagePreview(null), []);
  // 标签 Map（path -> tags），作为标签的唯一真相源，编辑时只更新它，避免重新读盘
  const [arkAssetCount, setArkAssetCount] = useState(0);

  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [filterRowExpanded, setFilterRowExpanded] = useState(false);

  // 同一组件在两种展示方式之间复用；每次从画布打开时跟随当前项目。
  const presentation = assetsPanelOpen ? assetsPanelMode : null;
  const [previousPresentation, setPreviousPresentation] = useState(presentation);
  const [motionMode, setMotionMode] = useState(assetsPanelMode);
  if (presentation !== previousPresentation) {
    setPreviousPresentation(presentation);
    setImagePreview(null);
    setFileMenu(null);
    setCreativeFile(null);
    if (presentation) setMotionMode(presentation);
    if (presentation === 'drawer') {
      setActiveTab('project');
      setNodeListOpen(false);
      setNodeSearch('');
      setSelectedProjectId(null);
      setSearch('');
      setActiveCategory(null);
      setActiveTag(null);
      setVisibleCount(PAGE_SIZE);
      setFilterRowExpanded(false);
      setEditingPath(null);
      setAddMenuOpen(false);
    }
  }

  const [previousRequest, setPreviousRequest] = useState<typeof assetsPanelRequest>(null);
  if (assetsPanelRequest !== previousRequest) {
    setPreviousRequest(assetsPanelRequest);
    if (assetsPanelOpen && assetsPanelRequest) {
      if (assetsPanelRequest.tab !== 'refmods') setActiveTab(assetsPanelRequest.tab);
      setRefmodLibraryOpen(assetsPanelRequest.tab === 'refmods');
      setSelectedProjectId(assetsPanelRequest.projectId ?? null);
      setFolderSelection(assetsPanelRequest.folder ?? { kind: 'all' });
      setArkLibraryOpen(false);
      setNodeListOpen(false);
      setSearch('');
      setActiveCategory(null);
      setActiveTag(null);
      setVisibleCount(PAGE_SIZE);
    }
  }

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  }, []);

  const adjustWaterfallColumns = useCallback((delta: number) => {
    const current = normalizeWaterfallColumns(useAppStore.getState().config.assetWaterfallColumns);
    const next = normalizeWaterfallColumns(current + delta);
    if (next === current) return;
    updateConfig({ assetWaterfallColumns: next });
    void saveConfig({ silent: true }).catch(() => toast('列数设置保存失败'));
  }, [saveConfig, toast, updateConfig]);

  useEffect(() => {
    if (assetsPanelOpen && isFileTab) {
      // 异步读取外部文件和 IndexedDB 标签；setState 发生在 Promise 完成后。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadFiles().then(loadTags);
      void prepareDragIcon();
    }
    return () => {
      loadRequestRef.current += 1;
      loadControllerRef.current?.abort();
    };
  }, [assetsPanelOpen, isFileTab, loadFiles, loadTags, loadControllerRef, loadRequestRef]);

  useEffect(() => () => { folderOperationRef.current?.abort(); }, [assetsPanelOpen, activeTab, currentProjectId]);

  useEffect(() => {
    if (assetsPanelOpen && visibleTab === 'permanent') void loadGlobalDramaAssets().catch(() => {});
  }, [assetsPanelOpen, visibleTab, loadGlobalDramaAssets]);

  useEffect(() => {
    if (!assetsPanelOpen || visibleTab !== 'drama') return;
    if (unreadDramaAssetCount > 0 || useAppStore.getState().dramaAssets.lastViewedAt === undefined) {
      markDramaAssetsViewed();
    }
  }, [assetsPanelOpen, markDramaAssetsViewed, unreadDramaAssetCount, visibleTab]);

  const handleClose = useCallback(() => {
    setRepairTarget(null);
    setCreativeFile(null);
    setImagePreview(null);
    setBatchReverse(null);
    setSelectedProjectId(null); // 复位项目选择，下次打开默认当前项目
    setFilterRowExpanded(false);
    setAssetsPanelOpen(false);
  }, [setAssetsPanelOpen, setRepairTarget]);

  const handleLocateNode = useCallback((nodeId: string) => {
    const focusNode = () => {
      const state = useAppStore.getState();
      if (state.currentProjectId !== currentProjectId) return;
      if (!state.nodes.some((node) => node.id === nodeId)) {
        toast('节点已不存在');
        return;
      }
      // 与历史记录共用画布定位与放大回弹；左侧面板保留，方便连续查看。
      window.dispatchEvent(new CustomEvent('canvas-focus-node', { detail: { nodeId, pulse: true } }));
    };
    if (isDrawer) {
      focusNode();
    } else {
      handleClose();
      setTimeout(focusNode, 300);
    }
  }, [currentProjectId, handleClose, isDrawer, toast]);

  const handleSelectFolder = useCallback((selection: AssetFolderSelection) => {
    setGlobalCreativeKind(null);
    setFolderSelection(selection);
    setActiveCategory(null);
    setActiveTag(null);
    setEditingPath(null);
    setFilterRowExpanded(false);
    setVisibleCount(PAGE_SIZE);
  }, [setFolderSelection]);

  const {
    folderProgress, folderDropTarget, handleCreateSubfolder, handleOpenFolder, handleFolderClipboard,
    pointerDragStopRef, suppressDragClickRef, handleCardDragStart, handleCardPointerDown, handleAddFiles,
    handleAddFolder, handleRemoveFolder, handleSavePermanent,
  } = useAssetFolderActions({
    assetsPanelOpen, assetsPanelMode, setAssetsPanelOpen, currentProjectId, updateConfig, saveConfig,
    activeTab, globalCreativeKind, visibleTab, isDrawer, isPage, externalFolders, globalRootPath,
    folderSelection, folderOperationRef, dismissHover, setBusy, setAddMenuOpen, folders, toast,
    loadFiles, loadTags, handleClose, handleSelectFolder,
  });

  // Esc 关闭
  useEffect(() => {
    if (!assetsPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || batchReverse) return;
      const state = useAppStore.getState();
      if (state.characterLibraryRequest?.origin === 'assets'
        && (state.characterLibraryOpen || state.characterActionLibraryOpen)) return;
      if (pointerDragStopRef.current) {
        e.preventDefault(); pointerDragStopRef.current(); return;
      }
      // 抽屉或整页之上的确认框/选择器先消费 Esc，避免连带关闭资产库。
      if ((isDrawer || isPage) && document.querySelector('[aria-modal="true"], [role="listbox"], dialog[open]')) return;
      handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [assetsPanelOpen, handleClose, isDrawer, isPage, batchReverse]);

  // 点击外部关闭「添加」菜单
  const addWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target as Node)) setAddMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [addMenuOpen]);

  // 原始文件（按 Tab）
  const rawFiles = useMemo(() => activeTab === 'project' ? projectFiles : selectAssetFolderFiles(permanentFiles, folderSelection),
    [activeTab, projectFiles, permanentFiles, folderSelection]);
  const selectedFolder = folderSelection.kind === 'folder' ? externalFolders.find((folder) =>
    folder.rootPath === folderSelection.rootPath && folder.relativePath === folderSelection.relativePath) : undefined;
  const folderLabel = folderSelection.kind === 'all' ? translate('全部资产') : folderSelection.kind === 'global' ? translate('导入文件')
    : `${shortFolderName(folderSelection.rootPath)}${folderSelection.relativePath ? ` / ${folderSelection.relativePath.replace(/\//g, ' / ')}` : ''}`;

  // 合并标签（useMemo，标签变化时不动文件数组）
  const files = useMemo(
    () => rawFiles.map((f) => (tagMap[assetKey(f)] ? { ...f, tags: tagMap[assetKey(f)] } : f)),
    [rawFiles, tagMap],
  );
  const usageAssetIds = useMemo(() => files.flatMap((file) => file.assetId ? [file.assetId] : []), [files]);

  // 分类计数
  const categoryCounts = useMemo(() => {
    const c: Record<FileCategory, number> = { image: 0, video: 0, audio: 0, text: 0, other: 0 };
    for (const f of files) c[f.category]++;
    return c;
  }, [files]);

  // 标签计数（用于筛选 chip）
  const tagList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of files) for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TAG_CHIPS);
  }, [files]);

  const listedCategories = useMemo(
    () => ALL_CATEGORIES.filter((category) => categoryCounts[category] > 0),
    [categoryCounts],
  );

  const { filterRowOverflow, visibleFilterItemCount, filterRowRef, filterListRef } = useAssetFilterRow({
    assetsPanelOpen, visibleTab, categoryCounts, tagList, filterRowExpanded, setFilterRowExpanded,
  });

  // 先筛选、整体排序，再分页和分列，避免只重排已加载的卡片。
  const filteredFiles = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return sortAssetFiles(files.filter((f) => {
      if (activeCategory && f.category !== activeCategory) return false;
      if (activeTag && !(f.tags ?? []).includes(activeTag)) return false;
      if (q) {
        const inName = f.name.toLowerCase().includes(q);
        const inTags = (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    }), sortBy, sortOrder, assetUsage, activeCategory === null);
  }, [files, activeCategory, activeTag, deferredSearch, sortBy, sortOrder, assetUsage]);

  const visibleFiles = useMemo(() => filteredFiles.slice(0, visibleCount), [filteredFiles, visibleCount]);
  const previewScope = JSON.stringify([currentProjectId, selectedProjectId, activeTab, folderSelection, assetsPanelMode, visibleTab]);
  const batchImages = useMemo(() => [...new Map(filteredFiles.filter((file) => file.category === 'image'
    && !!file.assetUrl && isLocalAssetFile(file)).map((file) => [assetKey(file), file])).values()], [filteredFiles]);
  if (batchReverse && (!assetsPanelOpen || batchReverse.scope !== previewScope)) setBatchReverse(null);
  const hoverScope = JSON.stringify([assetsPanelOpen, previewScope, search, activeCategory, activeTag, sortBy, sortOrder]);
  useEffect(() => cancelHoverRead, [hoverScope, cancelHoverRead]);
  const startHover = (file: AssetFileEntry) => {
    if (hoverRequestRef.current && hoverDetails?.key === assetKey(file) && hoverDetails.scope === hoverScope) return;
    cancelHoverRead();
    const key = assetKey(file);
    if (file.availability === 'offline' || !isDraggableEntry(file) || !['image', 'video'].includes(file.category)) {
      setHoverDetails({ key, scope: hoverScope, text: '暂无提示词' });
      return;
    }
    setHoverDetails({ key, scope: hoverScope, text: '正在读取…' });
    const controller = new AbortController();
    const projectId = projectIdForFile(file);
    // 仅为实际停留的卡片读取，快速扫过不查询历史或磁盘；移开和切换上下文时撤销。
    const timer = setTimeout(() => {
      void (async () => {
        const isCurrent = () => hoverRequestRef.current?.controller === controller && !controller.signal.aborted
          && useAppStore.getState().assetsPanelOpen && useAppStore.getState().currentProjectId === currentProjectId;
        try {
          const details = file.category === 'image' ? await loadAssetImageDetails(file, projectId, controller.signal) : null;
          const history = file.category === 'video'
            ? await loadAssetVideoHistory(file.path, file.assetUrl, projectId, controller.signal) : details?.history;
          if (!isCurrent()) return;
          // 用户主动清空的提示词不能回退到历史；长文本只截取预览，完整内容仍在详情中。
          const prompt = (details?.record?.prompt ?? history?.prompt ?? '').replace(/\s+/g, ' ').trim();
          const text = !prompt ? translate('暂无提示词') : prompt.length > 240 ? translate('{prompt}…（点击查看完整提示词）', { prompt: prompt.slice(0, 240) }) : prompt;
          setHoverDetails({ key, scope: hoverScope, text });
        } catch {
          if (isCurrent()) setHoverDetails({ key, scope: hoverScope, text: translate('读取失败，请重试') });
        }
      })();
    }, 400);
    hoverRequestRef.current = { controller, timer };
  };
  const cardTooltip = (file: AssetFileEntry): string | undefined => {
    const current = hoverDetails?.key === assetKey(file) && hoverDetails.scope === hoverScope ? hoverDetails : null;
    if (current?.text === '') return undefined;
    return translate('{hint}\n提示词：{prompt}\n标签：\n{tags}', { hint: cardDragHint(file), prompt: current ? current.text : translate('正在读取…'), tags: file.tags?.length ? file.tags.join(', ') : translate('暂无标签') });
  };
  const cardDragHint = (file: AssetFileEntry): string => {
    const dragHint = !isDraggableEntry(file) || file.availability === 'offline' ? '此素材暂不支持拖拽'
      : isPage || !currentProjectId ? '可拖拽到其他窗口或应用；'
        : isDrawer ? '拖拽到画布可添加节点；' : '拖出弹窗到画布可添加节点；';
    const folderHint = activeTab === 'permanent' && file.category === 'image' && isLocalAssetFile(file)
      && (file.source === 'global' || file.source === 'folder') ? '拖到左侧文件夹可移动。' : '';
    return [folderHint, dragHint].filter(Boolean).map((hint) => translate(hint)).join('\n');
  };
  useEffect(() => {
    fileScopeRef.current = assetsPanelOpen ? previewScope : null;
    return () => { fileScopeRef.current = null; fileOperationRef.current?.abort(); };
  }, [assetsPanelOpen, previewScope]);

  const openFileMenu = (file: AssetFileEntry, x: number, y: number, confirmDelete = false) => {
    dismissHover();
    fileOperationRef.current?.abort();
    setFileMenu({ file, scope: previewScope, x, y, confirmDelete,
      projectId: projectIdForFile(file) });
  };
  const handleFileContextMenu = (file: AssetFileEntry, event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    openFileMenu(file, event.clientX, event.clientY);
  };
  const handleFileMenuKey = (file: AssetFileEntry, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    if ((event.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    openFileMenu(file, rect.left + 12, rect.top + 12);
  };

  const performFileAction = async (action: 'copy' | 'prompt' | 'reveal' | 'delete') => {
    const target = fileMenu;
    if (!target || fileScopeRef.current !== target.scope) return;
    fileOperationRef.current?.abort();
    const controller = new AbortController();
    fileOperationRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && fileScopeRef.current === target.scope
      && useAppStore.getState().assetsPanelOpen && useAppStore.getState().currentProjectId === currentProjectId;
    try {
      if (!isCurrent()) return;
      if (action === 'prompt') {
        toast('正在读取提示词…');
        const details = target.file.category === 'image'
          ? await loadAssetImageDetails(target.file, target.projectId, controller.signal) : null;
        const history = target.file.category === 'video'
          ? await loadAssetVideoHistory(target.file.path, target.file.assetUrl, target.projectId, controller.signal) : details?.history;
        if (!isCurrent()) return;
        const prompt = details?.record?.prompt ?? history?.prompt ?? '';
        if (!prompt.trim()) { toast('此资产暂无提示词'); return; }
        if (!(await copyText(prompt))) throw new Error('clipboard');
        if (isCurrent()) toast('提示词已复制');
      } else {
        if (!isLocalAssetFile(target.file) || !isTauriEnv()) throw new Error('unavailable');
        if (action === 'copy') {
          if (!(await copyFile(target.file.path))) throw new Error('clipboard');
          if (isCurrent()) toast('文件已复制，可在系统中粘贴');
        } else if (action === 'reveal') {
          await revealFileInFolder(target.file.path);
        } else {
          await deletePermanentFile(target.file.path);
          deletedFilePathsRef.current.add(target.file.path);
          if (!isCurrent()) return;
          setProjectFiles((prev) => prev.filter((file) => file.path !== target.file.path));
          setPermanentFiles((prev) => prev.filter((file) => file.path !== target.file.path));
          await loadFiles();
          if (isCurrent()) toast('文件已移入系统回收站');
        }
      }
    } catch {
      if (!isCurrent()) return;
      if (action === 'delete') throw new Error('删除失败');
      toast(action === 'copy' ? '复制失败，请检查文件和系统剪贴板'
        : action === 'prompt' ? '提示词读取或复制失败，请重试' : '打开目录失败，请检查文件位置和权限');
    } finally {
      if (fileOperationRef.current === controller) fileOperationRef.current = null;
    }
  };
  const imageFiles = useMemo(() => filteredFiles.filter((file) => file.category === 'image' && !!file.assetUrl), [filteredFiles]);
  const openImagePreview = (file: AssetFileEntry) => {
    setTextPreview(null);
    dismissHover();
    videoPreview.setExpanded(null);
    setImagePreview({ path: file.path, scope: previewScope });
    void markAssetUsed(file);
  };

  const filteredNodes = useMemo(() => {
    const query = deferredNodeSearch.trim().toLowerCase();
    return canvasNodeIds.map((id, index) => {
      const data = canvasNodeData[index];
      const config = getNodeTypeConfig(data.type);
      const label = data.label?.trim() || data.fileName?.trim() || config.label;
      return { id, label, displayId: data.displayId, config, data };
    }).filter((node) => !query || [node.label, node.config.label, node.id, node.displayId === undefined ? '' : `#${node.displayId}`]
      .some((value) => value.toLowerCase().includes(query)));
  }, [canvasNodeData, canvasNodeIds, deferredNodeSearch]);
  const videoPreview = useResourceVideoPreview(
    JSON.stringify([assetsPanelOpen, assetsPanelMode, currentProjectId, visibleTab, selectedProjectId, folderSelection, search, nodeSearch, activeCategory, activeTag, sortBy, sortOrder]),
    isNodeList ? filteredNodes.map((node) => node.id) : visibleFiles.map(assetKey),
  );
  const filePreviewActive = videoPreview.expandedId !== null
    || imagePreview?.scope === previewScope || textPreview?.scope === previewScope;
  useEffect(() => {
    // 打开预览会记录使用时间；等关闭后再重排，避免卡片移列卸载刚打开的播放器。
    if (!assetsPanelOpen || !isFileTab || isGlobalCreative || sortBy !== 'usedAt' || loading || filePreviewActive) return;
    let current = true;
    void getAssetLastUsedTimes(usageAssetIds).then((usage) => {
      if (current) setAssetUsage(usage);
    }).catch(() => {
      if (current) { setAssetUsage(new Map()); toast('最近使用记录读取失败'); }
    });
    return () => { current = false; };
  }, [assetsPanelOpen, isFileTab, isGlobalCreative, sortBy, loading, filePreviewActive, usageAssetIds, recentAssetsRevision, toast]);
  const changeFileSort = (nextBy: AssetSortBy, nextOrder: AssetSortOrder) => {
    clearHover();
    closeFileMenu();
    setVisibleCount(PAGE_SIZE);
    setImagePreview(null);
    setTextPreview(null);
    videoPreview.setExpanded(null);
    updateConfig({ assetSortBy: nextBy, assetSortOrder: nextOrder });
    void saveConfig({ silent: true }).catch(() => toast('排序设置保存失败'));
  };
  const totalResultCount = isNodeList ? filteredNodes.length : filteredFiles.length;

  // 无限滚动哨兵
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((c) => (c < totalResultCount ? c + PAGE_SIZE : c));
      }
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [totalResultCount, visibleCount, visibleTab, folderSelection]);

  const switchTab = useCallback((tab: TabKey) => {
    setNodeListOpen(tab === 'nodes');
    setRefmodLibraryOpen(tab === 'refmods');
    if (tab === 'drama') {
      setDramaAssetsPanelOpen(true);
      setArkLibraryOpen(false);
    } else if (tab === 'ark') {
      setArkLibraryOpen(true);
      setDramaAssetsPanelOpen(false);
    } else {
      if (tab === 'project' || tab === 'permanent') setActiveTab(tab);
      setArkLibraryOpen(false);
      setDramaAssetsPanelOpen(false);
    }
    setActiveCategory(null);
    setActiveTag(null);
    setEditingPath(null);
    setVisibleCount(PAGE_SIZE);
  }, [setDramaAssetsPanelOpen]);

  // 与右侧助手面板保持相同的弹簧节奏，左侧抽屉镜像进退方向。
  const drawerTransition = reduceMotion
    ? { duration: 0.12 }
    : { type: 'spring' as const, visualDuration: 0.35, bounce: 0 };
  // 关闭时保留 AnimatePresence，让面板完成退场后再卸载。
  const panel = (
    <AnimatePresence>
      {assetsPanelOpen && (
        <>
          {!isDrawer && !isPage && <motion.div
            data-tauri-drag-region
            className="assets-panel-backdrop"
            variants={backdropVariants}
            initial="hidden" animate="visible" exit="hidden"
            transition={{ duration: 0.2 }}
            onClick={handleClose}
          />}
          <div
            ref={isDrawer ? setDrawerWrapper : undefined}
            className={isPage ? 'absolute inset-0 z-40' : `assets-panel-wrapper${isDrawer ? ' assets-panel-wrapper--drawer' : ''}`}
          >
            <motion.div
              data-resource-video-boundary
              className={isPage ? 'assets-library-page flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas-bg pb-3' : `assets-panel glass-panel ui-dialog-surface${isDrawer ? ' assets-panel--drawer pr-2' : ''}`}
              role={isPage ? 'main' : isDrawer ? 'region' : 'dialog'}
              aria-label={isPage ? translate('资源库') : isDrawer ? translate('资产库快捷面板') : translate('资产管理')}
              aria-modal={isDrawer || isPage ? undefined : true}
              variants={isPage ? {
                hidden: { opacity: 0 },
                visible: { opacity: 1, transition: { duration: 0.12 } },
                exit: { opacity: 0, transition: { duration: 0 } },
              } : isDrawer ? {
                hidden: { opacity: 0, x: reduceMotion ? 0 : '-100%' },
                visible: { opacity: 1, x: 0, transition: drawerTransition },
                exit: { opacity: 0, x: reduceMotion ? 0 : '-100%', transition: drawerTransition },
              } : panelVariants}
              initial="hidden" animate="visible" exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
              {isDrawer && (
                <PanelResizeHandle
                  edge="right"
                  minWidth={ASSETS_DRAWER_MIN_WIDTH}
                  maxWidth={ASSETS_DRAWER_MAX_WIDTH}
                  onResize={resizeDrawer}
                />
              )}
              {/* Header */}
              <div data-tauri-drag-region={isPage ? true : undefined} className={isPage ? `relative flex h-11 shrink-0 items-center gap-3 pr-3 ${macWindowControls ? 'pl-28' : 'pl-3'}` : 'assets-panel-header px-2.5 py-2'}>
                {isPage && <button type="button" autoFocus className="ui-btn ui-btn--ghost ui-btn--sm" onClick={handleClose}>
                  <Icon icon="mdi:arrow-left" width="16" aria-hidden="true" /> {translate("返回启动页")}
                </button>}
                <h2 className={`assets-panel-title${isDrawer ? ' shrink-0 whitespace-nowrap' : ''}`}>
                  {isPage ? translate('资源库') : isDrawer ? translate('资产库') : translate('资产管理')}
                  {!isDrawer && !isPage && <span className="assets-panel-subtitle">
                    {visibleTab === 'drama' ? translate('管理人物、场景和道具简介与绑图') : visibleTab === 'ark' ? translate('管理火山方舟虚拟人像素材') : visibleTab === 'refmods' ? translate('引用 ComfyUI 中的 H3 角色参考包') : isNodeList ? translate('查看当前画布中的全部节点') : translate('拖拽卡片到画布即可添加节点')}
                  </span>}
                </h2>
                {canManageProjectSharing && <div className={`ml-auto flex shrink-0 items-center ${isDrawer ? 'gap-0' : 'gap-1'}`}>
                  <button type="button" className={isDrawer ? 'ui-icon-btn ui-icon-btn--ghost ui-icon-btn--sm' : 'ui-btn ui-btn--ghost ui-btn--sm'} disabled={!isTauriEnv()}
                    aria-label={translate('WSAGENT 共享图片')} title={translate('WSAGENT 共享图片')} onClick={() => {
                    if (sharingOwnerId) setWsagentOwner(sharingOwnerId);
                  }}><Link2 size={14} aria-hidden="true" />{!isDrawer && translate('WSAGENT 共享图片')}</button>
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={!isTauriEnv()} onClick={() => {
                    if (sharingOwnerId) setSharingOwner({ id: sharingOwnerId, name: projects.find((project) => project.id === currentOwnerId)?.name ?? '' });
                  }}><Cloud size={14} aria-hidden="true" />{translate('项目共享')}</button>
                  <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!isTauriEnv()} onClick={() => {
                    if (sharingOwnerId) setSharingOwner({ id: sharingOwnerId, name: projects.find((project) => project.id === currentOwnerId)?.name ?? '', sync: true });
                  }}><RefreshCw size={14} aria-hidden="true" />{translate('立即同步')}</button>
                </div>}
                {isDrawer ? (
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={handleClose} aria-label={translate("收起资产库")}>
                    {translate("收起")} <kbd>Tab</kbd>
                  </button>
                ) : !isPage && <PopupCloseButton onClick={handleClose} />}
              </div>

              {/* Tabs */}
              <div className="assets-tabs">
                <Tabs<TabKey>
                  items={[
                    { value: 'project', label: translate('项目文件'), count: projectFiles.length },
                    { value: 'permanent', label: translate('全局资产'), count: permanentFiles.length },
                    { value: 'drama', label: translate('创作资产'), count: dramaAssetCount },
                    { value: 'ark', label: translate('方舟素材库'), count: arkAssetCount },
                    { value: 'refmods', label: translate('ComfyUI 角色'), count: refmodCount },
                    { value: 'nodes', label: translate('节点列表'), count: canvasNodeCount },
                  ] satisfies TabItem<TabKey>[]}
                  value={visibleTab}
                  onChange={switchTab}
                  size={isDrawer ? 'sm' : 'md'}
                  aria-label={translate("资产类型")}
                />

                {/* Toolbar: 搜索 + 添加 */}
              {visibleTab !== 'drama' && visibleTab !== 'ark' && visibleTab !== 'refmods' && !isGlobalCreative ? <div className="assets-toolbar ml-auto">
                {visibleTab === 'project' && (
                  <Select
                    className="assets-project-select-wrap"
                    triggerClassName="assets-project-select"
                    value={viewProjectId ?? ''}
                    onChange={(value) => setSelectedProjectId(value || null)}
                    options={listTopLevelProjects(projects).map((p) => ({
                      value: p.id,
                      label: currentProjectId && p.id === seriesOwnerId(projects, currentProjectId) ? translate('{name}（当前）', { name: p.name }) : p.name,
                    }))}
                  />
                )}
                <div className="assets-search ui-input-group">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    className="ui-input ui-input--sm"
                    type="text" placeholder={isNodeList ? translate('搜索节点名称、类型或编号…') : translate('搜索名称或标签…')}
                    value={isNodeList ? nodeSearch : search}
                    onChange={(e) => { (isNodeList ? setNodeSearch : setSearch)(e.target.value); setVisibleCount(PAGE_SIZE); }}
                  />
                  {(isNodeList ? nodeSearch : search) && (
                    <button type="button" className="assets-search-clear" onClick={() => { (isNodeList ? setNodeSearch : setSearch)(''); setVisibleCount(PAGE_SIZE); }} aria-label={translate("清空")}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
                {!isDrawer && !isNodeList && <div className="assets-column-stepper" role="group" aria-label={translate("瀑布流列数")}>
                  <Icon icon="lucide:columns-3" className="assets-column-stepper-icon" aria-hidden="true" />
                  <button
                    type="button"
                    className="ui-icon-btn ui-icon-btn--sm"
                    aria-label={translate("减少瀑布流列数")}
                    disabled={waterfallColumns <= MIN_WATERFALL_COLUMNS}
                    onClick={() => adjustWaterfallColumns(-1)}
                  >
                    <Icon icon="lucide:minus" aria-hidden="true" />
                  </button>
                  <output aria-label={translate('当前 {count} 列', { count: waterfallColumns })}>{waterfallColumns}</output>
                  <button
                    type="button"
                    className="ui-icon-btn ui-icon-btn--sm"
                    aria-label={translate("增加瀑布流列数")}
                    disabled={waterfallColumns >= MAX_WATERFALL_COLUMNS}
                    onClick={() => adjustWaterfallColumns(1)}
                  >
                    <Icon icon="lucide:plus" aria-hidden="true" />
                  </button>
                </div>}
                {!isDrawer && (visibleTab === 'project' || visibleTab === 'permanent') && <button type="button" className="ui-btn ui-btn--sm shrink-0"
                  disabled={!isTauriEnv() || !batchImages.length || busy || loading} title={translate("批量反推当前筛选图片的提示词和标签")}
                  onClick={() => {
                    dismissHover(); setAddMenuOpen(false); setFileMenu(null);
                    setBatchReverse({ scope: previewScope, entries: batchImages.map((file) => ({ file: { ...file }, projectId: projectIdForFile(file) })) });
                  }}><Icon icon="lucide:sparkles" aria-hidden="true" />{translate("批量反推")}</button>}
                {visibleTab === 'permanent' && (
                  <div className="assets-add-wrap" ref={addWrapRef}>
                    <motion.button
                      type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy}
                      onClick={() => setAddMenuOpen((v) => !v)}
                      whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      {translate("添加")}
                    </motion.button>
                    <AnimatePresence>
                      {addMenuOpen && (
                        <motion.div
                          className="assets-add-menu"
                          initial={{ opacity: 0, y: -6, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -6, scale: 0.96, transition: fadeFast }}
                          transition={springSmooth}
                        >
                          <button type="button" onClick={handleAddFiles}>{translate("📄 添加文件")}</button>
                          <button type="button" onClick={handleAddFolder}>{translate("📁 添加文件夹")}</button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div> : null}
              </div>

              {isNodeList ? (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                  {filteredNodes.length === 0 ? (
                    <div className="assets-empty">
                      <Icon icon="lucide:workflow" width="32" height="32" aria-hidden="true" />
                      <span>{nodeSearch.trim() ? translate('没有匹配的节点') : translate('当前画布暂无节点')}</span>
                    </div>
                  ) : (
                    <>
                      <ul className="assets-node-grid" aria-label={translate("当前画布节点")}>
                        {filteredNodes.slice(0, visibleCount).map((node) => (
                          <li key={node.id} data-node-id={node.id} className="ui-card assets-node-card min-w-0 p-3">
                            <div className="flex items-center gap-2">
                              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ${node.config.color} ${node.config.bg}`}>
                                <Icon icon={node.config.icon} width="18" height="18" aria-hidden="true" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium text-canvas-text" title={node.label}>{node.label}</p>
                                <p className="truncate text-[11px] text-canvas-text-muted">
                                  {node.displayId !== undefined && <span>#{node.displayId} · </span>}{translate(node.config.label)}
                                </p>
                              </div>
                              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0"
                                aria-label={translate('查看节点 {name}', { name: node.label })} onClick={() => handleLocateNode(node.id)}>
                                {translate("查看节点")}
                              </button>
                            </div>
                            <CanvasNodeCardContent nodeId={node.id} data={node.data} projectId={currentProjectId} connectable={isDrawer}
                              videoPresentation={isDrawer ? 'inline' : 'fullscreen'}
                              videoExpanded={videoPreview.expandedId === node.id}
                              onVideoExpandedChange={(expanded) => videoPreview.setExpanded(expanded ? node.id : null)} />
                          </li>
                        ))}
                      </ul>
                      {visibleCount < filteredNodes.length && (
                        <div ref={sentinelRef} className="assets-load-sentinel">
                          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>{translate("加载更多节点")}</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : visibleTab === 'drama' ? (
                <Suspense
                  fallback={(
                    <div className="flex flex-1 items-center justify-center text-xs text-canvas-text-muted">
                      {translate("正在加载短剧资产...")}
                    </div>
                  )}
                >
                  <DramaAssetsPanel compact={isDrawer} />
                </Suspense>
              ) : visibleTab === 'ark' ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs text-canvas-text-muted">{translate("正在加载方舟素材库...")}</div>}>
                  <VolcengineAssetLibraryPanel
                    compact={isDrawer}
                    onCountChange={setArkAssetCount}
                    onOpenProviderSettings={() => useAppStore.getState().openApiKeySettings('volcengine')}
                  />
                </Suspense>
              ) : visibleTab === 'refmods' ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs text-canvas-text-muted">{translate("正在加载角色参考包...")}</div>}>
                  <RefModAssetsPanel compact={isDrawer} onCountChange={setRefmodCount} />
                </Suspense>
              ) : (
                <div className="assets-file-browser">
                  {activeTab === 'permanent' && (
                    <AssetFolderNavigation
                      folders={externalFolders} selection={folderSelection} totalCount={permanentFiles.length}
                      globalCount={permanentFiles.filter((file) => file.source === 'global').length}
                      compact={isDrawer} loading={loading || busy} onSelect={handleSelectFolder} globalRootPath={globalRootPath}
                      onCreate={handleCreateSubfolder}
                      onOpen={(selection) => { void handleOpenFolder(selection); }}
                      dropTarget={folderDropTarget}
                      onCopy={(selection) => { void handleFolderClipboard(selection, 'copy'); }}
                      onPaste={(selection) => { void handleFolderClipboard(selection, 'paste'); }}
                      onRemove={(rootPath) => { void handleRemoveFolder(rootPath); }}
                      onRepair={(rootPath) => setRepairTarget({ kind: 'folder', path: rootPath, name: shortFolderName(rootPath) })}
                      creativeKind={globalCreativeKind} creativeCounts={creativeCounts}
                      onSelectCreative={(kind) => {
                        setGlobalCreativeKind(kind); setFileMenu(null); setImagePreview(null); setTextPreview(null); dismissHover();
                      }}
                    />
                  )}
                  {isGlobalCreative && globalCreativeKind ? <Suspense fallback={<p role="status" className="p-3 text-xs text-canvas-text-muted">{translate("正在打开全局创作资产…")}</p>}>
                    <GlobalCreativeAssetsPanel key={globalCreativeKind} kind={globalCreativeKind} compact={isDrawer} />
                  </Suspense> : <div className="assets-file-content">
                    {folderProgress && <div role="status" className="flex items-center gap-2 p-2 text-xs text-canvas-text-secondary">
                      <Icon icon="lucide:loader-circle" className="animate-spin" aria-hidden="true" /><span className="flex-1">{translate(folderProgress)}</span>
                      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => folderOperationRef.current?.abort()}>{translate("取消操作")}</button>
                    </div>}
                    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2 text-xs text-canvas-text-secondary">
                      <span className="min-w-0 truncate" title={activeTab === 'permanent' ? folderLabel : translate('项目文件')}>
                        {activeTab === 'permanent' ? folderLabel : translate('项目文件')}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading || !isTauriEnv()}
                          onClick={() => setRepairTarget({ kind: 'all' })}>{translate('修复失效素材')}</button>
                        <Select<AssetSortBy> value={sortBy} options={FILE_SORT_OPTIONS.map((option) => ({ ...option, label: translate(option.label) }))} size="sm" className="w-[86px]"
                          aria-label={translate("排序方式")} onChange={(value) => changeFileSort(value, value === 'usedAt' ? 'desc' : sortOrder)} />
                        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm"
                          aria-label={sortOrder === 'asc' ? translate('切换为降序') : translate('切换为升序')}
                          title={sortOrder === 'asc' ? translate('当前升序，点击切换为降序') : translate('当前降序，点击切换为升序')}
                          onClick={() => changeFileSort(sortBy, sortOrder === 'asc' ? 'desc' : 'asc')}>
                          <Icon icon={sortOrder === 'asc' ? 'lucide:arrow-up-narrow-wide' : 'lucide:arrow-down-wide-narrow'} width={14} aria-hidden="true" />
                          {sortOrder === 'asc' ? translate('升序') : translate('降序')}
                        </button>
                      </div>
                      <span className="ml-auto shrink-0 text-canvas-text-muted">{translate('{count} 个文件', { count: files.length })}</span>
                    </div>
                    {activeTab === 'permanent' && folderScanTruncated && (
                      <p role="status" className="px-3 pt-2 text-xs text-canvas-text-muted">{translate("已达到扫描上限，当前仅显示已扫描的目录和文件。可单独添加子文件夹继续浏览。")}</p>
                    )}

              {/* 分类 + 标签筛选 */}
              <div
                ref={filterRowRef}
                className={`assets-category-row ${filterRowExpanded ? 'expanded' : ''}`}
              >
                <div ref={filterListRef} id="assets-filter-list" className="assets-category-list">
                  <button
                    type="button"
                    className={`assets-cat-chip ${activeCategory === null ? 'active' : ''} ${filterRowExpanded || visibleFilterItemCount > 0 ? '' : 'assets-filter-item-hidden'}`}
                    onClick={() => { setActiveCategory(null); setVisibleCount(PAGE_SIZE); }}
                  >
                    {translate("全部")}<span className="assets-cat-count">{files.length}</span>
                  </button>
                  {listedCategories.map((cat, index) => (
                    <button
                      key={cat} type="button"
                      className={`assets-cat-chip ${activeCategory === cat ? 'active' : ''} ${filterRowExpanded || index + 1 < visibleFilterItemCount ? '' : 'assets-filter-item-hidden'}`}
                      onClick={() => { setActiveCategory(cat); setVisibleCount(PAGE_SIZE); }}
                    >
                      {CATEGORY_ICONS[cat]} {translate(CATEGORY_LABELS[cat])}
                      <span className="assets-cat-count">{categoryCounts[cat]}</span>
                    </button>
                  ))}
                  {tagList.length > 0 && (
                    <span
                      data-filter-separator
                      className={`assets-chip-sep ${filterRowExpanded || listedCategories.length + 1 < visibleFilterItemCount ? '' : 'assets-filter-item-hidden'}`}
                    />
                  )}
                  {tagList.map(([tag, count], index) => (
                    <button
                      key={tag} type="button"
                      className={`assets-cat-chip assets-tag-chip ${activeTag === tag ? 'active' : ''} ${filterRowExpanded || listedCategories.length + index + 2 < visibleFilterItemCount ? '' : 'assets-filter-item-hidden'}`}
                      onClick={() => { setActiveTag((t) => (t === tag ? null : tag)); setVisibleCount(PAGE_SIZE); }}
                    >
                      #{tag}<span className="assets-cat-count">{count}</span>
                    </button>
                  ))}
                </div>
                {filterRowOverflow && (
                  <button
                    type="button"
                    className="assets-filter-more"
                    aria-controls="assets-filter-list"
                    aria-expanded={filterRowExpanded}
                    aria-label={filterRowExpanded ? translate('收起标签') : translate('展开更多标签')}
                    title={filterRowExpanded ? translate('收起标签') : translate('更多标签')}
                    onClick={() => setFilterRowExpanded((expanded) => !expanded)}
                  >
                    <Icon icon={filterRowExpanded ? 'lucide:chevron-up' : 'lucide:ellipsis'} aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* 文件瀑布流 */}
              <div className="assets-file-scroll-shell">
                <div className="assets-file-scroll" key={JSON.stringify([activeTab, activeTab === 'permanent' ? folderSelection : null, sortBy, sortOrder])}>
                  {!loading && loadError && (
                    <div className="ui-alert ui-alert--warning m-2" role="alert">
                      <span className="min-w-0 flex-1 break-words">
                        {translate(loadError.message)}
                        {loadError.failures?.map((failure) => (
                          <span key={failure.projectId} className="block">
                            {translate('{name}：{reason}', {
                              name: projects.find((project) => project.id === failure.projectId)?.name ?? translate('项目'),
                              reason: translate(failure.reason),
                            })}
                          </span>
                        ))}
                      </span>
                      <button type="button" className="ui-btn ui-btn--secondary shrink-0"
                        onClick={() => { void loadFiles().then(loadTags); }}>{translate("重试加载")}</button>
                    </div>
                  )}
                  <div className="assets-file-waterfall" data-columns={waterfallColumns}>
                    {loading && filteredFiles.length === 0 ? (
                      <div className="assets-empty">
                        <motion.div className="assets-spinner" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.6, ease: 'linear' }} />
                        <span>{translate("加载中...")}</span>
                      </div>
                    ) : filteredFiles.length === 0 && !loadError ? (
                      <div className="assets-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" /><line x1="9" y1="15" x2="15" y2="15" />
                        </svg>
                        <span>{activeTab === 'permanent' && selectedFolder?.availability === 'offline' ? translate('文件夹无法访问，请检查位置或权限')
                          : activeTab === 'permanent' && selectedFolder?.availability === 'unscanned' ? translate('此文件夹尚未扫描，可单独添加此目录继续浏览')
                          : search || activeCategory || activeTag ? translate('没有匹配的文件') : activeTab === 'project' ? translate('暂无项目文件')
                            : selectedFolder ? externalFolders.some((folder) => folder.rootPath === selectedFolder.rootPath
                              && folder.parentRelativePath === selectedFolder.relativePath)
                              ? translate('此文件夹没有本层文件，请选择子文件夹浏览') : translate('此文件夹为空')
                              : translate('暂无文件，点击「添加」导入')}</span>
                      </div>
                    ) : (
                      <>
                        <div className="assets-waterfall-cols">
                          {distributeToColumns(visibleFiles, waterfallColumns).map((column, columnIndex) => (
                            <div className="assets-waterfall-col" key={columnIndex}>
                              {column.map((file) => (
                                <AssetCard
                                  key={assetKey(file)}
                                  file={file}
                                  isProject={activeTab === 'project'}
                                  draggable={isDraggableEntry(file)}
                                  tooltip={cardTooltip(file)}
                                  tooltipHint={cardDragHint(file)}
                                  onHover={() => startHover(file)}
                                  onHoverEnd={clearHover}
                                  onDragStart={(e) => handleCardDragStart(file, e)}
                                  onPointerDown={(e) => handleCardPointerDown(file, e)}
                                  onClickCapture={(e) => {
                                    if (Date.now() < suppressDragClickRef.current) { e.preventDefault(); e.stopPropagation(); }
                                  }}
                                  editing={editingPath === assetKey(file)}
                                  tagDraft={editingPath === assetKey(file) ? tagDraft : ''}
                                  onToggleEdit={() => { dismissHover(); const key = assetKey(file); setEditingPath((p) => (p === key ? null : key)); setTagDraft(''); }}
                                  onTagDraftChange={setTagDraft}
                                  onAddTag={(t) => { addTag(file, t); setTagDraft(''); }}
                                  onRemoveTag={(t) => removeTag(file, t)}
                                  onSave={() => handleSavePermanent(file)}
                                  onDelete={() => {
                                    if (isLocalAssetFile(file) && isTauriEnv()) openFileMenu(file, 0, 0, true);
                                    else toast('此文件无法使用系统回收站');
                                  }}
                                  onContextMenu={(event) => handleFileContextMenu(file, event)}
                                  onMenuKeyDown={(event) => handleFileMenuKey(file, event)}
                                  videoExpanded={videoPreview.expandedId === assetKey(file)}
                                  videoPresentation={isDrawer ? 'inline' : 'fullscreen'}
                                  videoProjectId={projectIdForFile(file)}
                                  onVideoExpandedChange={(expanded) => {
                                    dismissHover();
                                    videoPreview.setExpanded(expanded ? assetKey(file) : null);
                                    if (expanded) void markAssetUsed(file);
                                  }}
                                  onImagePreview={file.category === 'image' ? () => openImagePreview(file) : undefined}
                                  onTextPreview={file.category === 'text' ? () => {
                                    dismissHover(); videoPreview.setExpanded(null); setImagePreview(null);
                                    setTextPreview({ file: { ...file }, scope: previewScope }); void markAssetUsed(file);
                                  } : undefined}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                        {visibleCount < filteredFiles.length && (
                          <div ref={sentinelRef} className="assets-load-sentinel">{translate("加载更多…")}</div>
                        )}
                        {loading && <div className="assets-load-sentinel" role="status" aria-live="polite">{translate("正在继续加载资源…")}</div>}
                      </>
                    )}
                  </div>
                </div>
              </div>
                  </div>}
                </div>
              )}

              {/* Toast */}
              <AnimatePresence>
                {toastMsg && (
                  <motion.div
                    className="assets-toast"
                    initial={{ opacity: 0, y: 12, scale: 0.92 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.92, transition: fadeFast }}
                    transition={springSmooth}
                  >
                    {translate(toastMsg)}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );

  // 关闭 Action 会重置展示模式；保留上次打开的动效宿主，避免退场被中断。
  // 局部覆盖性能模式，仍尊重系统减少动态效果设置。
  const presentationPanel = motionMode === 'page' ? panel : motionMode === 'drawer'
    ? <MotionConfig reducedMotion="user" transition={drawerTransition}>{panel}</MotionConfig>
    : createPortal(panel, document.body);
  const handleAssetRenamed = (previous: AssetFileEntry, next: AssetFileEntry) => {
    if (fileScopeRef.current !== previewScope || !useAppStore.getState().assetsPanelOpen
      || useAppStore.getState().currentProjectId !== currentProjectId) return;
    const replace = (entries: AssetFileEntry[]) => entries.map((entry) => entry.path === previous.path ? next : entry);
    setProjectFiles(replace); setPermanentFiles(replace);
    setProjectFileOwners((current) => {
      const owner = current.get(previous.path);
      if (!owner) return current;
      const updated = new Map(current); updated.delete(previous.path); updated.set(next.path, owner); return updated;
    });
    setTagMap((current) => {
      const tags = current[assetKey(previous)];
      if (!tags || assetKey(previous) === assetKey(next)) return current;
      const updated = { ...current }; delete updated[assetKey(previous)]; updated[assetKey(next)] = tags; return updated;
    });
    // 增量扫描快照仍可能持有旧路径；重新扫描以取消后续旧批次。
    if (loadControllerRef.current) void loadFiles().then(loadTags);
  };
  return <>{presentationPanel}
    {assetsPanelOpen && wsagentOwner && canManageProjectSharing && wsagentOwner === sharingOwnerId && <Suspense fallback={null}>
      <WsagentSharedImagesDialog key={wsagentOwner} ownerId={wsagentOwner}
        ownerName={projects.find((project) => project.id === currentOwnerId)?.name ?? ''} onClose={() => setWsagentOwner(undefined)} />
    </Suspense>}
    {assetsPanelOpen && sharingOwner && canManageProjectSharing && sharingOwner.id === sharingOwnerId && <Suspense fallback={null}>
      <SharedProjectBindingDialog key={sharingOwner.id} localOwnerId={sharingOwner.id} ownerName={sharingOwner.name} autoPreview={sharingOwner.sync} onClose={() => setSharingOwner(null)} />
    </Suspense>}
    {assetsPanelOpen && batchReverse?.scope === previewScope && <Suspense fallback={null}>
      <AssetImageBatchReverseDialog entries={batchReverse.entries} onClose={closeBatchReverse}
        onSaved={(file, tags) => {
          setTagMap((current) => ({ ...current, [assetKey(file)]: tags }));
          const update = (entries: AssetFileEntry[]) => entries.map((entry) => entry.path === file.path ? { ...entry, assetId: file.assetId, tags } : entry);
          setProjectFiles(update); setPermanentFiles(update);
        }} />
    </Suspense>}
    {assetsPanelOpen && fileMenu?.scope === previewScope &&
      <AssetFileContextMenu key={`${fileMenu.scope}:${fileMenu.file.path}:${fileMenu.confirmDelete}`} name={fileMenu.file.name}
        usageTarget={{ kind: 'file', assetId: fileMenu.file.assetId, path: fileMenu.file.path, name: fileMenu.file.name }}
        onRepair={fileMenu.file.assetId && isTauriEnv() ? () => setRepairTarget({ kind: 'file', assetId: fileMenu.file.assetId, path: fileMenu.file.path, name: fileMenu.file.name }) : undefined}
        x={fileMenu.x} y={fileMenu.y} confirmDelete={fileMenu.confirmDelete}
        canFileActions={isLocalAssetFile(fileMenu.file) && isTauriEnv()}
        canCopyPrompt={fileMenu.file.category === 'image' || fileMenu.file.category === 'video'}
        onCopy={() => performFileAction('copy')} onCopyPrompt={() => performFileAction('prompt')}
        onPublishShared={activeTab === 'project' && canManageProjectSharing && sharingOwnerId && isTauriEnv()
          && fileMenu.file.category === 'image' && fileMenu.file.availability !== 'offline' && isLocalAssetFile(fileMenu.file) ? async () => {
            const fileProjectId = projectIdForFile(fileMenu.file);
            if (!fileProjectId || fileScopeRef.current !== fileMenu.scope) throw new Error('项目文件范围已切换');
            const { publishWsagentProjectFile } = await import('../services/wsagentSharedImages');
            if (fileScopeRef.current !== fileMenu.scope) throw new Error('项目文件范围已切换');
            await publishWsagentProjectFile(sharingOwnerId, fileProjectId, fileMenu.file.path, fileMenu.file.name);
            toast(translate('图片已发布到 WSAGENT 共享库'));
          } : undefined}
        onCreateCreativeAsset={fileMenu.file.category === 'image' && fileMenu.file.availability !== 'offline' ? async (kind) => {
          const target = fileMenu;
          fileOperationRef.current?.abort();
          const controller = new AbortController(); fileOperationRef.current = controller;
          await loadGlobalDramaAssets();
          if (controller.signal.aborted || fileScopeRef.current !== target.scope
            || !useAppStore.getState().assetsPanelOpen || useAppStore.getState().currentProjectId !== currentProjectId) return;
          setCreativeFile({ file: { ...target.file }, kind, scope: target.scope });
        } : undefined}
        onReveal={() => performFileAction('reveal')} onDelete={() => performFileAction('delete')} onClose={closeFileMenu} />}
    {assetsPanelOpen && repairTarget && <Suspense fallback={<p role="status">{translate('正在读取失效素材…')}</p>}>
      <AssetRepairDialog target={repairTarget} onClose={() => setRepairTarget(null)} onRepaired={() => { void loadFiles().then(loadTags); }} />
    </Suspense>}
    {assetsPanelOpen && creativeFile?.scope === previewScope && <Suspense fallback={<p role="status">{translate("正在打开创作资产…")}</p>}>
      <GlobalCreativeAssetFileDialog key={`${creativeFile.kind}:${creativeFile.file.assetId ?? creativeFile.file.path}`} file={creativeFile.file} kind={creativeFile.kind}
        onClose={() => setCreativeFile(null)} onSaved={(category) => {
          switchTab('permanent'); setGlobalCreativeKind(category); setCreativeFile(null); toast('已添加到全局创作资产');
        }} />
    </Suspense>}
    {assetsPanelOpen && textPreview?.scope === previewScope && <Suspense fallback={<p role="status">{translate("正在打开文档…")}</p>}>
      <AssetTextPreview key={textPreview.scope} file={textPreview.file} projectId={projectIdForFile(textPreview.file)}
        onClose={() => setTextPreview(null)} onSaved={(next) => {
          if (fileScopeRef.current !== previewScope || !useAppStore.getState().assetsPanelOpen
            || useAppStore.getState().currentProjectId !== currentProjectId) return;
          const replace = (entries: AssetFileEntry[]) => entries.map((entry) => entry.path === next.path
            ? { ...entry, size: next.size, modifiedAt: next.modifiedAt } : entry);
          setProjectFiles(replace); setPermanentFiles(replace);
          if (loadControllerRef.current) void loadFiles().then(loadTags);
        }} onRenamed={(previous, next) => {
          handleAssetRenamed(previous, next);
          setTextPreview((current) => current?.file.path === previous.path ? { ...current, file: next } : current);
        }} />
    </Suspense>}
    {assetsPanelOpen && imagePreview?.scope === previewScope &&
      <AssetImagePreview key={`${imagePreview.scope}:${imagePreview.path}`} files={imageFiles} initialPath={imagePreview.path}
        projectIdForFile={projectIdForFile} onTagsSaved={(file, tags) => setTagMap((current) => ({ ...current, [assetKey(file)]: tags }))}
        onRenamed={handleAssetRenamed}
        onClose={closeImagePreview} />}
  </>;
}

/* ============================================
   单个资产卡片（轻量，无 layout 动画）
   ============================================ */
interface AssetCardProps {
  file: AssetFileEntry;
  isProject: boolean;
  draggable?: boolean;
  tooltip?: string;
  tooltipHint?: string;
  onHover: () => void;
  onHoverEnd: () => void;
  onDragStart?: (e: DragEvent) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onClickCapture?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  editing: boolean;
  tagDraft: string;
  onToggleEdit: () => void;
  onTagDraftChange: (v: string) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  videoExpanded?: boolean;
  videoPresentation?: 'inline' | 'fullscreen';
  videoProjectId?: string;
  onVideoExpandedChange?: (expanded: boolean) => void;
  onImagePreview?: () => void;
  onTextPreview?: () => void;
}

function AssetCard({
  file, isProject, draggable, tooltip, tooltipHint, onHover, onHoverEnd, onDragStart, onPointerDown, onClickCapture, editing, tagDraft,
  onToggleEdit, onTagDraftChange, onAddTag, onRemoveTag, onSave, onDelete, onContextMenu, onMenuKeyDown,
  videoExpanded = false, videoPresentation, videoProjectId, onVideoExpandedChange, onImagePreview, onTextPreview,
}: AssetCardProps) {
  useT();
  const tags = file.tags ?? [];
  return (
    <div
      className={`assets-waterfall-card anim-card-in${videoExpanded ? ' has-expanded-video' : ''}`}
      draggable={draggable && !videoExpanded}
      onDragStart={onDragStart}
      onPointerDown={editing ? undefined : onPointerDown}
      onClickCapture={onClickCapture}
      data-tooltip={videoExpanded || editing ? undefined : tooltip}
      data-tooltip-hint={videoExpanded || editing ? undefined : tooltipHint}
      data-tooltip-pos="bottom"
      data-tooltip-anchor="pointer"
      onMouseEnter={videoExpanded || editing ? undefined : () => { void prepareDragIcon(file); onHover(); }}
      onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) onHoverEnd(); }}
      onFocus={(event) => { if (!videoExpanded && !editing && !event.currentTarget.contains(event.relatedTarget)) onHover(); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) onHoverEnd(); }}
      tabIndex={0}
      aria-label={file.name}
      aria-haspopup="menu"
      onContextMenu={onContextMenu}
      onKeyDown={onMenuKeyDown}
    >
      <AssetThumb
        assetUrl={file.assetUrl}
        filePath={file.path}
        videoExpanded={videoExpanded}
        videoPresentation={videoPresentation}
        videoProjectId={videoProjectId}
        onVideoExpandedChange={onVideoExpandedChange}
        name={file.name}
        category={file.category}
        size={file.size}
        onImagePreview={onImagePreview}
        onTextPreview={onTextPreview}
        showNativeTooltip={false}
        badge={file.source === 'folder' ? translate('外部') : undefined}
      >
        <CardActions isProject={isProject} onSave={onSave} onDelete={onDelete} onToggleEdit={onToggleEdit} />
      </AssetThumb>

      {(tags.length > 0 || editing) && (
        <div className={`assets-card-tags${editing ? '' : ' assets-card-tags--collapsed'}`}>
          {tags.map((t) => (
            <span key={t} className="assets-card-tag">
              {t}
              {editing && <button type="button" onClick={() => onRemoveTag(t)} aria-label={translate("移除标签")}>×</button>}
            </span>
          ))}
          {editing && (
            <input
              className="assets-tag-input" autoFocus value={tagDraft}
              placeholder={translate("加标签…")}
              onChange={(e) => onTagDraftChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAddTag(tagDraft); } }}
              onBlur={() => { if (tagDraft.trim()) onAddTag(tagDraft); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CardActions({ isProject, onSave, onDelete, onToggleEdit }: {
  isProject: boolean; onSave: () => void; onDelete: () => void; onToggleEdit: () => void;
}) {
  useT();
  return (
    <div className="assets-card-actions">
      <button type="button" className="assets-card-action-btn" onClick={onToggleEdit}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      </button>
      {isProject ? (
        <button type="button" className="assets-card-action-btn" onClick={onSave}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      ) : (
        <button type="button" className="assets-card-action-btn assets-card-delete" onClick={onDelete}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}
    </div>
  );
}
