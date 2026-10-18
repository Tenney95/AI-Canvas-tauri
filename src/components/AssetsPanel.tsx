/**
 * AssetsPanel 资产管理面板 — 浏览项目文件 + 全局资产库（永久），支持：
 *  · 添加本地文件（拷贝到全局 {baseDataDir}/file）/ 文件夹（递归引用，不拷贝）
 *  · 搜索（名称 + 标签）、分类与标签筛选
 *  · 手动为文件打标签（持久化到 IndexedDB assetMeta）
 * 性能：useDeferredValue 搜索 + useMemo 过滤 + 增量渲染（IntersectionObserver）+ 图片懒加载，
 *       并移除了大列表下昂贵的逐项 layout 动画。
 */
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
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../store/useAppStore';
import { listTopLevelProjects, listEpisodes, seriesOwnerId } from '../store/store.utils';
import {
  listProjectFiles,
  listGlobalFolderContents,
  listExternalFolderContents,
  selectAssetFolderFiles,
  createAssetSubfolder,
  resolveAssetFolderDirectory,
  copyAssetFolder,
  importAssetFilesToFolder,
  addAssetFilesToGlobal,
  pickAssetFolder,
  saveAssetToPermanent,
  deletePermanentFile,
  revealFileInFolder,
  isTauriEnv,
  extractFilesFromNodeData,
  CATEGORY_LABELS,
  type AssetFileEntry,
  type FileCategory,
  type AssetFolderEntry,
  type AssetFolderSelection,
} from '../services/fileService';
import { copyFile, copyText, readClipboardFolders } from '../services/clipboardService';
import { loadAssetImageDetails } from '../services/assetImageDetails';
import { loadAssetVideoHistory } from '../services/assetVideoDetails';
import { getAllAssetMeta, putAssetMeta, deleteAssetMeta, imageHistoryReferenceKey } from '../services/indexedDbService';
import { startAssetDrag, prepareDragIcon } from '../utils/assetDrag';
import { isExternalDropCaptured, setExternalDropCaptured } from '../utils/dropCapture';
import { nativeDropClientPosition } from '../utils/nativeDropPosition';
import { ALL_CATEGORIES, CATEGORY_ICONS, shortFolderName } from '../utils/assetFormat';
import AssetThumb from './shared/AssetThumb';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';
import Tabs, { type TabItem } from './shared/Tabs';
import { springSmooth, fadeFast } from '../utils/motion';
import { countUnreadDramaAssets } from '../store/store.dramaAssets';
import { distributeToColumns } from './assets/waterfallColumns';
import { getNodeTypeConfig } from '../types';
import CanvasNodeCardContent from './assets/CanvasNodeCardContent';
import AssetFolderNavigation from './assets/AssetFolderNavigation';
import AssetImagePreview from './assets/AssetImagePreview';
import AssetFileContextMenu from './assets/AssetFileContextMenu';
import { useResourceVideoPreview } from '../hooks/useResourceVideoPreview';
import type { AssetImageBatchEntry } from '../types/assetImage';

const AssetTextPreview = lazy(() => import('./assets/AssetTextPreview'));
const DramaAssetsPanel = lazy(() => import('./DramaAssetsPanel'));
const VolcengineAssetLibraryPanel = lazy(() => import('./volcengine/VolcengineAssetLibraryPanel'));
const AssetImageBatchReverseDialog = lazy(() => import('./assets/AssetImageBatchReverseDialog'));

/** 仅磁盘真实文件可拖拽（排除节点引用的 node:// / virtual:// 虚拟路径）*/
function isDraggableEntry(file: AssetFileEntry): boolean {
  return !!file.path && !file.path.startsWith('node://') && !file.path.startsWith('virtual://');
}

function isLocalAssetFile(file: AssetFileEntry): boolean {
  return isDraggableEntry(file) && file.availability !== 'offline'
    && (!/^[a-z][\w+.-]*:/i.test(file.path) || /^[a-z]:[\\/]/i.test(file.path));
}

type FileTabKey = 'project' | 'permanent';
type TabKey = FileTabKey | 'drama' | 'ark' | 'nodes';

/** 单页渲染数量（增量加载步长）— 限制 DOM 规模 */
const PAGE_SIZE = 48;
/** 标签筛选行最多展示的标签数 */
const MAX_TAG_CHIPS = 24;
const MIN_WATERFALL_COLUMNS = 2;
const MAX_WATERFALL_COLUMNS = 6;
const DEFAULT_WATERFALL_COLUMNS = 3;

function normalizeWaterfallColumns(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WATERFALL_COLUMNS;
  return Math.min(MAX_WATERFALL_COLUMNS, Math.max(MIN_WATERFALL_COLUMNS, Math.round(value)));
}

function assetKey(file: AssetFileEntry): string {
  return file.assetId ?? file.path;
}

const backdropVariants = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: { opacity: 1, scale: 1, y: 0, transition: springSmooth },
  exit: { opacity: 0, scale: 0.95, y: 20, transition: fadeFast },
};

export default function AssetsPanel() {
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
    unreadDramaAssetCount,
    dramaAssetCount,
    canvasNodeCount,
    currentProjectId,
    projects,
    baseDataDir,
    assetFolders,
    assetWaterfallColumns,
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
        unreadDramaAssetCount: countUnreadDramaAssets(s.dramaAssets),
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
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
      })),
    );

  const [activeTab, setActiveTab] = useState<FileTabKey>('project');
  const [arkLibraryOpen, setArkLibraryOpen] = useState(false);
  const [nodeListOpen, setNodeListOpen] = useState(false);
  const visibleTab: TabKey = dramaAssetsPanelOpen ? 'drama' : nodeListOpen ? 'nodes' : arkLibraryOpen ? 'ark' : activeTab;
  const isNodeList = visibleTab === 'nodes';
  // 只在节点页订阅标识和内容；移动节点不改变 data，避免位置更新重绘整个资产面板。
  const canvasNodeIds = useAppStore(useShallow((s) => assetsPanelOpen && isNodeList ? s.nodes.map((node) => node.id) : []));
  const canvasNodeData = useAppStore(useShallow((s) => assetsPanelOpen && isNodeList ? s.nodes.map((node) => node.data) : []));
  // 项目文件 Tab 查看的项目；null 表示「跟随当前项目」（关闭时复位，故每次打开默认当前项目）
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectedOwnerId = selectedProjectId ?? currentProjectId;
  const viewProjectId = selectedOwnerId ? seriesOwnerId(projects, selectedOwnerId) : null;
  const viewProjectIds = useMemo(() => viewProjectId
    ? [viewProjectId, ...listEpisodes(projects, viewProjectId).map((project) => project.id)] : [], [projects, viewProjectId]);
  const [projectFileOwners, setProjectFileOwners] = useState(new Map<string, string>());
  const projectIdForFile = useCallback((file: AssetFileEntry) => activeTab === 'project'
    ? projectFileOwners.get(file.path) ?? selectedProjectId ?? currentProjectId ?? undefined
    : undefined, [activeTab, projectFileOwners, selectedProjectId, currentProjectId]);
  const [activeCategory, setActiveCategory] = useState<FileCategory | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [nodeSearch, setNodeSearch] = useState('');
  const deferredNodeSearch = useDeferredValue(nodeSearch);
  const isDrawer = assetsPanelMode === 'drawer';
  const isPage = assetsPanelMode === 'page';
  const waterfallColumns = isDrawer ? DEFAULT_WATERFALL_COLUMNS : normalizeWaterfallColumns(assetWaterfallColumns);

  const [projectFiles, setProjectFiles] = useState<AssetFileEntry[]>([]);
  const [permanentFiles, setPermanentFiles] = useState<AssetFileEntry[]>([]);
  const [externalFolders, setExternalFolders] = useState<AssetFolderEntry[]>([]);
  const [globalRootPath, setGlobalRootPath] = useState<string | null>(null);
  const [folderProgress, setFolderProgress] = useState<string | null>(null);
  const folderOperationRef = useRef<AbortController | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<AssetFolderSelection | null>(null);
  const internalFolderDragRef = useRef<AssetFileEntry | null>(null);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [folderSelection, setFolderSelection] = useState<AssetFolderSelection>({ kind: 'all' });
  const [textPreview, setTextPreview] = useState<{ file: AssetFileEntry; scope: string } | null>(null);
  const [imagePreview, setImagePreview] = useState<{ path: string; scope: string } | null>(null);
  const [batchReverse, setBatchReverse] = useState<{ scope: string; entries: AssetImageBatchEntry[] } | null>(null);
  const closeBatchReverse = useCallback(() => setBatchReverse(null), []);
  const [fileMenu, setFileMenu] = useState<{ file: AssetFileEntry; scope: string; projectId?: string; x: number; y: number; confirmDelete?: boolean } | null>(null);
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
  const deletedFilePathsRef = useRef(new Set<string>());
  const closeFileMenu = useCallback(() => {
    fileOperationRef.current?.abort();
    setFileMenu(null);
  }, []);
  const closeImagePreview = useCallback(() => setImagePreview(null), []);
  const [folderScanTruncated, setFolderScanTruncated] = useState(false);
  // 标签 Map（path -> tags），作为标签的唯一真相源，编辑时只更新它，避免重新读盘
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});
  const [arkAssetCount, setArkAssetCount] = useState(0);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [filterRowExpanded, setFilterRowExpanded] = useState(false);
  const [filterRowOverflow, setFilterRowOverflow] = useState(false);
  const [visibleFilterItemCount, setVisibleFilterItemCount] = useState(Number.POSITIVE_INFINITY);
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const filterListRef = useRef<HTMLDivElement | null>(null);
  const loadRequestRef = useRef(0);
  const projectFilesScopeRef = useRef<string | null>(null);

  // 同一组件在两种展示方式之间复用；每次从画布打开时跟随当前项目。
  const presentation = assetsPanelOpen ? assetsPanelMode : null;
  const [previousPresentation, setPreviousPresentation] = useState(presentation);
  const [motionMode, setMotionMode] = useState(assetsPanelMode);
  if (presentation !== previousPresentation) {
    setPreviousPresentation(presentation);
    setImagePreview(null);
    setFileMenu(null);
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

  const folders = useMemo(() => assetFolders ?? [], [assetFolders]);
  const [previousRequest, setPreviousRequest] = useState<typeof assetsPanelRequest>(null);
  if (assetsPanelRequest !== previousRequest) {
    setPreviousRequest(assetsPanelRequest);
    if (assetsPanelOpen && assetsPanelRequest) {
      setActiveTab(assetsPanelRequest.tab);
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

  // 载入标签元数据 → Map
  const loadTags = useCallback(async () => {
    try {
      const metas = await getAllAssetMeta();
      const map: Record<string, string[]> = {};
      for (const m of metas) if (m.tags?.length) map[m.assetId] = m.tags;
      setTagMap(map);
    } catch { /* ignore */ }
  }, [setTagMap]);

  // 载入文件列表（按 Tab 聚合）
  const loadFiles = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const isCurrentRequest = () => requestId === loadRequestRef.current
      && useAppStore.getState().assetsPanelOpen
      && currentProjectId === useAppStore.getState().currentProjectId
      && baseDataDir === useAppStore.getState().config.baseDataDir;
    setLoading(true);
    setLoadError(null);
    try {
      if (activeTab === 'project') {
        const scope = JSON.stringify([baseDataDir, viewProjectIds]);
        if (projectFilesScopeRef.current !== scope) {
          projectFilesScopeRef.current = scope;
          setProjectFiles([]);
          setProjectFileOwners(new Map());
        }
        if (!viewProjectIds.length) { setProjectFiles([]); setProjectFileOwners(new Map()); return; }
        const owners = new Map<string, string>();
        const diskEntries = new Map<string, AssetFileEntry>();
        let failedProjects = 0;
        // 父项目后读取分集，重叠目录中的文件沿用具体分集的身份和历史归属。
        for (const projectId of viewProjectIds) {
          let entries: AssetFileEntry[] | null = null;
          // 单个目录/索引读取失败不丢弃整部剧；短暂故障仅自动重读一次。
          for (let attempt = 0; attempt < 2; attempt++) {
            try { entries = await listProjectFiles(projectId); }
            catch {
              if (!isCurrentRequest()) return;
              if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            if (!isCurrentRequest()) return;
            if (entries !== null) break;
          }
          if (entries === null) failedProjects++;
          for (const file of entries ?? []) {
            diskEntries.set(imageHistoryReferenceKey(file.path) ?? file.path, file);
            owners.set(file.path, projectId);
          }
        }
        const diskFiles = Array.from(diskEntries.values());
        if (!isCurrentRequest()) return;
        // 原生返回反斜杠路径，目录扫描使用正斜杠；旧节点还可能带 Windows 长路径前缀。
        // 与提示词关联复用同一比较键，已有磁盘条目优先，不追加大小为 0 的节点副本。
        const known = new Set(diskFiles.map((f) => imageHistoryReferenceKey(f.path) ?? f.path));
        for (const file of diskFiles) deletedFilePathsRef.current.delete(file.path);
        const nodeEntries: AssetFileEntry[] = [];
        // 仅当查看的是「当前项目」时，才并入画布上尚未落盘的节点文件
        // （store.nodes 始终是当前项目的画布，其他项目无法从内存取节点）
        if (currentProjectId && viewProjectIds.includes(currentProjectId)) {
          for (const node of useAppStore.getState().nodes) {
            const entry = extractFilesFromNodeData(node.data as Record<string, unknown>);
            if (!entry) continue;
            const key = imageHistoryReferenceKey(entry.path) ?? entry.path;
            if (!known.has(key) && !deletedFilePathsRef.current.has(entry.path)) {
              nodeEntries.push(entry);
              known.add(key);
              owners.set(entry.path, currentProjectId);
            }
          }
        }
        if (failedProjects < viewProjectIds.length || nodeEntries.length) {
          setProjectFileOwners(owners);
          setProjectFiles([...diskFiles, ...nodeEntries]);
        }
        if (failedProjects) setLoadError('项目文件读取未完成，已保留可用资源，请重试。');
      } else {
        // 永久 = 全局 file 目录 + 登记的外部文件夹（递归）
        const [globalContents, contents] = await Promise.all([
          listGlobalFolderContents(),
          listExternalFolderContents(folders),
        ]);
        if (!isCurrentRequest()) return;
        const seen = new Set<string>();
        const merged: AssetFileEntry[] = [];
        for (const f of [...globalContents.files, ...contents.files]) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          merged.push(f);
        }
        setPermanentFiles(merged);
        const allFolders = Array.from(new Map([...globalContents.folders, ...contents.folders]
          .map((folder) => [JSON.stringify([folder.rootPath, folder.relativePath]), folder])).values());
        setGlobalRootPath(globalContents.rootPath);
        setExternalFolders(allFolders);
        setFolderScanTruncated(contents.truncated || globalContents.truncated);
        setFolderSelection((selection) => selection.kind === 'folder'
          && !allFolders.some((folder) => folder.rootPath === selection.rootPath && folder.relativePath === selection.relativePath)
          ? { kind: 'all' } : selection);
      }
    } catch {
      if (isCurrentRequest()) setLoadError('资源读取失败，请重试。');
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [activeTab, currentProjectId, baseDataDir, viewProjectIds, folders]);

  useEffect(() => {
    if (assetsPanelOpen) {
      // 异步读取外部文件和 IndexedDB 标签；setState 发生在 Promise 完成后。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadFiles().then(loadTags);
      void prepareDragIcon();
    }
    return () => { loadRequestRef.current += 1; };
  }, [assetsPanelOpen, loadFiles, loadTags]);

  useEffect(() => () => { folderOperationRef.current?.abort(); }, [assetsPanelOpen, activeTab, currentProjectId]);

  const handleCreateSubfolder = async (selection: AssetFolderSelection, name: string) => {
    if (folderOperationRef.current) throw new Error('请等待当前目录操作完成');
    const controller = new AbortController();
    folderOperationRef.current = controller; setBusy(true);
    try {
      await createAssetSubfolder(selection, useAppStore.getState().config.assetFolders ?? [], name);
      if (!controller.signal.aborted) { await loadFiles(); toast('文件夹已创建'); }
    } finally {
      if (folderOperationRef.current === controller) { folderOperationRef.current = null; setBusy(false); }
    }
  };

  const handleFolderClipboard = async (selection: AssetFolderSelection, operation: 'copy' | 'paste') => {
    if (folderOperationRef.current) return;
    const controller = new AbortController();
    folderOperationRef.current = controller; setBusy(true);
    try {
      const directory = await resolveAssetFolderDirectory(selection, useAppStore.getState().config.assetFolders ?? []);
      if (controller.signal.aborted) return;
      if (operation === 'copy') {
        if (!(await copyFile(directory))) throw new Error('复制失败，请检查目录权限和系统剪贴板');
        if (!controller.signal.aborted) toast('文件夹已复制，可在这里或系统中粘贴');
      } else {
        const sources = await readClipboardFolders();
        for (const [index, source] of sources.entries()) {
          if (controller.signal.aborted) throw new Error('复制已取消；已复制内容保留在目标目录');
          setFolderProgress(`正在粘贴文件夹 ${index + 1}/${sources.length}…`);
          await copyAssetFolder(source, directory, { signal: controller.signal, onProgress: ({ transferredBytes, totalBytes }) => {
            if (!controller.signal.aborted) setFolderProgress(`正在粘贴文件夹 ${index + 1}/${sources.length} · ${totalBytes ? Math.min(100, Math.round(transferredBytes / totalBytes * 100)) : 100}%`);
          } });
        }
        if (!controller.signal.aborted) toast(`已粘贴 ${sources.length} 个文件夹`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '目录操作失败，请检查权限';
      if (useAppStore.getState().assetsPanelOpen) toast(controller.signal.aborted ? '复制已取消；已复制内容保留在目标目录' : message);
    } finally {
      if (folderOperationRef.current === controller) {
        folderOperationRef.current = null; setBusy(false); setFolderProgress(null);
      }
      if (operation === 'paste' && useAppStore.getState().assetsPanelOpen && useAppStore.getState().currentProjectId === currentProjectId) await loadFiles();
    }
  };

  useEffect(() => {
    if (!assetsPanelOpen || visibleTab !== 'drama') return;
    if (unreadDramaAssetCount > 0 || useAppStore.getState().dramaAssets.lastViewedAt === undefined) {
      markDramaAssetsViewed();
    }
  }, [assetsPanelOpen, markDramaAssetsViewed, unreadDramaAssetCount, visibleTab]);

  const handleClose = useCallback(() => {
    setImagePreview(null);
    setBatchReverse(null);
    setSelectedProjectId(null); // 复位项目选择，下次打开默认当前项目
    setFilterRowExpanded(false);
    setAssetsPanelOpen(false);
  }, [setAssetsPanelOpen]);

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

  const dragMonitorRef = useRef<(() => void) | null>(null);
  const pointerDragStopRef = useRef<(() => void) | null>(null);
  const suppressDragClickRef = useRef(0);
  const releaseDropCaptureRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    dragMonitorRef.current?.();
    pointerDragStopRef.current?.();
    if (isDrawer) releaseDropCaptureRef.current?.();
    internalFolderDragRef.current = null;
    clearTimeout(dragEndTimerRef.current);
  }, [assetsPanelOpen, assetsPanelMode, currentProjectId, isDrawer]);
  useEffect(() => {
    if (!assetsPanelOpen || isDrawer) return;
    // 整页或弹窗覆盖画布时，不允许窗口级 drop 在背后创建节点。
    // 尊重先前已存在的独占状态；拖出弹窗时提前释放，露出的画布可接收落点。
    const previouslyCaptured = isExternalDropCaptured();
    setExternalDropCaptured(true);
    const release = () => {
      if (releaseDropCaptureRef.current !== release) return;
      releaseDropCaptureRef.current = null;
      setExternalDropCaptured(previouslyCaptured);
    };
    releaseDropCaptureRef.current = release;
    return release;
  }, [assetsPanelOpen, isDrawer]);

  const folderTargetAt = useCallback((x: number, y: number): AssetFolderSelection | null => {
    if (!assetsPanelOpen || activeTab !== 'permanent' || visibleTab !== 'permanent' || folderOperationRef.current) return null;
    const encoded = document.elementFromPoint?.(x, y)?.closest('[data-asset-folder-target]')?.getAttribute('data-asset-folder-target');
    if (!encoded) return null;
    try {
      const target: AssetFolderSelection = JSON.parse(encoded);
      if (target.kind === 'global') return globalRootPath ? target : null;
      if (target.kind === 'folder' && externalFolders.some((folder) => folder.availability === 'online'
        && folder.rootPath === target.rootPath && folder.relativePath === target.relativePath)) return target;
    } catch { /* 非目录落点不接收文件。 */ }
    return null;
  }, [assetsPanelOpen, activeTab, visibleTab, globalRootPath, externalFolders]);

  const highlightFolder = useCallback((target: AssetFolderSelection | null) => {
    setFolderDropTarget((previous) => JSON.stringify(previous) === JSON.stringify(target) ? previous : target);
  }, []);

  const receiveFolderDrop = useCallback(async (selection: AssetFolderSelection, paths: string[], internal: AssetFileEntry | null) => {
    if (folderOperationRef.current) return;
    dismissHover(); highlightFolder(null);
    const controller = new AbortController();
    folderOperationRef.current = controller; setBusy(true);
    const moving = internal?.category === 'image' && (internal.source === 'global' || internal.source === 'folder');
    setFolderProgress(moving ? '正在移动图片…' : `正在导入 ${paths.length} 个文件…`);
    try {
      const options = { signal: controller.signal, onProgress: ({ transferredBytes, totalBytes }: { transferredBytes: number; totalBytes: number | null }) => {
        if (!controller.signal.aborted) setFolderProgress(`${moving ? '正在移动' : '正在导入'} · ${totalBytes ? Math.min(100, Math.round(transferredBytes / totalBytes * 100)) : 100}%`);
      } };
      if (moving) {
        const result = await useAppStore.getState().moveGlobalAssetToFolder(internal, selection, options);
        toast(result.moved ? '图片已移动到文件夹' : '图片已在此文件夹内');
      } else {
        const count = await importAssetFilesToFolder(paths, selection, useAppStore.getState().config.assetFolders ?? [], options);
        toast(`已导入 ${count} 个文件，外部原文件保留`);
      }
    } catch {
      if (useAppStore.getState().assetsPanelOpen) toast(controller.signal.aborted
        ? '操作已取消，原文件和已完成的副本均保留' : '操作未完成，原文件已保留；请检查目录权限或文件是否已变化');
    } finally {
      if (folderOperationRef.current === controller) { folderOperationRef.current = null; setBusy(false); setFolderProgress(null); }
      if (useAppStore.getState().assetsPanelOpen && useAppStore.getState().currentProjectId === currentProjectId) await loadFiles().then(loadTags);
    }
  }, [dismissHover, highlightFolder, currentProjectId, loadFiles, loadTags, toast]);

  // 原生插件拖拽与系统外部拖入使用不同事件通道；同时监听并去重。
  const nativeFolderHandlersRef = useRef({ folderTargetAt, highlightFolder, receiveFolderDrop });
  useEffect(() => { nativeFolderHandlersRef.current = { folderTargetAt, highlightFolder, receiveFolderDrop }; }, [folderTargetAt, highlightFolder, receiveFolderDrop]);
  useEffect(() => {
    if (!assetsPanelOpen || activeTab !== 'permanent' || visibleTab !== 'permanent' || !isTauriEnv()) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    let lastDrop = { signature: '', time: 0 };
    let drawerCapture: boolean | null = null;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseDrawer = () => {
      if (drawerCapture !== null) { setExternalDropCaptured(drawerCapture); drawerCapture = null; }
    };
    const handle = (payload: { type: string; paths?: string[]; position?: { x: number; y: number } }) => {
      if (disposed) return;
      const handlers = nativeFolderHandlersRef.current;
      if (payload.type === 'leave') { handlers.highlightFolder(null); releaseDrawer(); return; }
      const point = payload.position ? nativeDropClientPosition(payload.position) : null;
      const target = point ? handlers.folderTargetAt(point.x, point.y) : null;
      handlers.highlightFolder(target);
      if (isDrawer && target && drawerCapture === null) {
        drawerCapture = isExternalDropCaptured(); setExternalDropCaptured(true);
      }
      if (payload.type !== 'drop') { if (!target) releaseDrawer(); return; }
      // 留到本次事件分发结束，避免背后的画布也消费此落点。
      clearTimeout(releaseTimer); releaseTimer = setTimeout(releaseDrawer, 0);
      if (!target || !payload.paths?.length) return;
      const signature = JSON.stringify([target, payload.paths]);
      if (lastDrop.signature === signature && Date.now() - lastDrop.time < 400) return;
      lastDrop = { signature, time: Date.now() };
      const internal = internalFolderDragRef.current;
      const same = (path: string) => {
        const normalized = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
        return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
      };
      const movingFile = internal && payload.paths.length === 1 && same(internal.path) === same(payload.paths[0]) ? internal : null;
      internalFolderDragRef.current = null;
      void handlers.receiveFolderDrop(target, payload.paths, movingFile);
    };
    void (async () => {
      try {
        const [{ getCurrentWebview }, { listen }] = await Promise.all([import('@tauri-apps/api/webview'), import('@tauri-apps/api/event')]);
        if (disposed) return;
        const first = await getCurrentWebview().onDragDropEvent(({ payload }) => handle(payload));
        if (disposed) { first(); return; } unlisten.push(first);
        // 同进程插件也可能只投递到窗口通道；悬停和离开必须与 drop 一起补齐。
        for (const type of ['enter', 'over', 'drop', 'leave'] as const) {
          const stop = await listen<{ paths?: string[]; position?: { x: number; y: number } }>(`tauri://drag-${type}`, ({ payload }) => handle({ ...payload, type }));
          if (disposed) { stop(); return; } unlisten.push(stop);
        }
      } catch { /* 浏览器预览不具备系统拖放能力。 */ }
    })();
    return () => { disposed = true; unlisten.forEach((stop) => stop()); clearTimeout(releaseTimer); releaseDrawer(); nativeFolderHandlersRef.current.highlightFolder(null); };
  }, [assetsPanelOpen, activeTab, visibleTab, isDrawer]);

  // 原生拖拽不会持续发送 DOM dragover；所有展示模式用系统坐标检测目录，弹窗额外检测越界。
  // startAssetDrag 仍在 dragstart 中同步调用，避免丢失鼠标手势。
  const handleCardDragStart = useCallback((file: AssetFileEntry, e: DragEvent) => {
    dismissHover();
    if (!isDraggableEntry(file)) return;
    e.preventDefault();
    dragMonitorRef.current?.();
    clearTimeout(dragEndTimerRef.current);
    if (isDrawer) releaseDropCaptureRef.current?.();
    const folderDrag = activeTab === 'permanent' && isLocalAssetFile(file);
    internalFolderDragRef.current = folderDrag ? file : null;
    if (folderDrag && isDrawer) {
      // 同进程原生拖拽可能没有 over 事件；从开始就阻止画布抢先消费目录落点。
      const previouslyCaptured = isExternalDropCaptured();
      setExternalDropCaptured(true);
      const release = () => {
        if (releaseDropCaptureRef.current !== release) return;
        releaseDropCaptureRef.current = null; setExternalDropCaptured(previouslyCaptured);
      };
      releaseDropCaptureRef.current = release;
    }
    if (!folderDrag && (isPage || isDrawer || !currentProjectId)) {
      startAssetDrag(file, undefined, e.currentTarget as Element);
      if (isDrawer) setAssetsPanelOpen(false);
      return;
    }
    // 整页布局没有 .assets-panel 类，沿用三种布局共有的容器标记。
    const bounds = e.currentTarget?.closest('[data-resource-video-boundary]')?.getBoundingClientRect();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (dragMonitorRef.current === stop) dragMonitorRef.current = null;
      highlightFolder(null);
    };
    dragMonitorRef.current = stop;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      void (async () => {
        try {
          const nativeWindow = getCurrentWindow();
          const [origin, scale] = await Promise.all([nativeWindow.innerPosition(), nativeWindow.scaleFactor()]);
          if (!Number.isFinite(scale) || scale <= 0) { stop(); return; }
          const checkPosition = async () => {
            if (stopped) return;
            try {
              const point = await cursorPosition();
              if (stopped) return;
              const state = useAppStore.getState();
              if (!state.assetsPanelOpen || state.assetsPanelMode !== assetsPanelMode || state.currentProjectId !== currentProjectId) { stop(); return; }
              const x = (point.x - origin.x) / scale;
              const y = (point.y - origin.y) / scale;
              if (!Number.isFinite(x) || !Number.isFinite(y)) { stop(); return; }
              highlightFolder(nativeFolderHandlersRef.current.folderTargetAt(x, y));
              if (!isPage && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) {
                stop(); releaseDropCaptureRef.current?.(); setAssetsPanelOpen(false); return;
              }
              timer = setTimeout(() => { void checkPosition(); }, 50);
            } catch { stop(); }
          };
          await checkPosition();
        } catch { stop(); }
      })();
    }
    startAssetDrag(file, () => {
      stop();
      // 同一进程的 drop 可能晚于原生结束回调；短暂保留来源以区分移动与复制。
      dragEndTimerRef.current = setTimeout(() => {
        internalFolderDragRef.current = null;
        if (isDrawer) releaseDropCaptureRef.current?.();
      }, 400);
    }, e.currentTarget as Element);
  }, [currentProjectId, isDrawer, isPage, assetsPanelMode, activeTab, highlightFolder, setAssetsPanelOpen, dismissHover]);

  // Windows 原生 DoDragDrop 会占用窗口事件循环，库内反馈不能依赖拖拽期间的 IPC。
  // 保持 Pointer Events 到目录落点；越过面板边界时才同步交给系统文件拖拽。
  const handleCardPointerDown = useCallback((file: AssetFileEntry, event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeTab !== 'permanent' || file.category !== 'image' || !isLocalAssetFile(file)
      || folderOperationRef.current || event.button !== 0 || event.pointerType !== 'mouse') return;
    const control = (event.target as HTMLElement).closest('button, input, textarea, select, a');
    if (control && !control.classList.contains('asset-image-preview-trigger')) return;
    const card = event.currentTarget;
    const bounds = card.closest('[data-resource-video-boundary]')?.getBoundingClientRect();
    if (!bounds || !card.setPointerCapture) return;
    pointerDragStopRef.current?.();
    event.preventDefault();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let stopped = false;
    let ghost: HTMLImageElement | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', stop);
      window.removeEventListener('keydown', key, true);
      card.removeEventListener('lostpointercapture', stop);
      if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
      ghost?.remove();
      highlightFolder(null);
      if (pointerDragStopRef.current === stop) pointerDragStopRef.current = null;
    };
    const move = (e: PointerEvent) => {
      if (stopped || e.pointerId !== pointerId) return;
      if (!(e.buttons & 1)) { stop(); return; }
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      if (!dragging) {
        dragging = true; card.setPointerCapture(pointerId); dismissHover();
        if (file.assetUrl) {
          ghost = document.createElement('img');
          ghost.src = file.assetUrl; ghost.alt = '';
          ghost.setAttribute('aria-hidden', 'true');
          ghost.className = 'pointer-events-none fixed left-0 top-0 z-[320] h-20 w-20 rounded-lg object-contain opacity-80 shadow-lg';
          document.body.appendChild(ghost);
        }
      }
      e.preventDefault();
      suppressDragClickRef.current = Date.now() + 400;
      if (ghost) ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      highlightFolder(nativeFolderHandlersRef.current.folderTargetAt(e.clientX, e.clientY));
      if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
        stop();
        handleCardDragStart(file, { currentTarget: card, preventDefault: () => e.preventDefault() } as DragEvent<HTMLDivElement>);
        if (!isPage) { releaseDropCaptureRef.current?.(); setAssetsPanelOpen(false); }
      }
    };
    const up = (e: PointerEvent) => {
      if (stopped || e.pointerId !== pointerId) return;
      const target = dragging ? nativeFolderHandlersRef.current.folderTargetAt(e.clientX, e.clientY) : null;
      if (dragging) { e.preventDefault(); suppressDragClickRef.current = Date.now() + 400; }
      stop();
      if (target) void nativeFolderHandlersRef.current.receiveFolderDrop(target, [file.path], file);
    };
    const cancel = (e: PointerEvent) => { if (e.pointerId === pointerId) stop(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation(); stop();
    };
    pointerDragStopRef.current = stop;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', stop);
    window.addEventListener('keydown', key, true);
    card.addEventListener('lostpointercapture', stop);
  }, [activeTab, dismissHover, handleCardDragStart, highlightFolder, isPage, setAssetsPanelOpen]);

  // Esc 关闭
  useEffect(() => {
    if (!assetsPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || batchReverse) return;
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
  const folderLabel = folderSelection.kind === 'all' ? '全部资产' : folderSelection.kind === 'global' ? '导入文件'
    : `${shortFolderName(folderSelection.rootPath)}${folderSelection.relativePath ? ` / ${folderSelection.relativePath.replace(/\//g, ' / ')}` : ''}`;
  const handleSelectFolder = useCallback((selection: AssetFolderSelection) => {
    setFolderSelection(selection);
    setActiveCategory(null);
    setActiveTag(null);
    setEditingPath(null);
    setFilterRowExpanded(false);
    setVisibleCount(PAGE_SIZE);
  }, []);

  // 合并标签（useMemo，标签变化时不动文件数组）
  const files = useMemo(
    () => rawFiles.map((f) => (tagMap[assetKey(f)] ? { ...f, tags: tagMap[assetKey(f)] } : f)),
    [rawFiles, tagMap],
  );

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

  const measureFilterRowOverflow = useCallback(() => {
    const row = filterRowRef.current;
    const list = filterListRef.current;
    if (!row || !list) return;

    const rowStyle = window.getComputedStyle(row);
    const availableWidth = row.clientWidth
      - (Number.parseFloat(rowStyle.paddingLeft) || 0)
      - (Number.parseFloat(rowStyle.paddingRight) || 0);
    const rowGap = Number.parseFloat(rowStyle.columnGap) || 0;
    const listGap = Number.parseFloat(window.getComputedStyle(list).columnGap) || 0;
    const items = Array.from(list.children) as HTMLElement[];
    const itemWidths = items.map((item) => {
      const itemStyle = window.getComputedStyle(item);
      return item.getBoundingClientRect().width
        + (Number.parseFloat(itemStyle.marginLeft) || 0)
        + (Number.parseFloat(itemStyle.marginRight) || 0);
    });
    const contentWidth = itemWidths.reduce((total, width) => total + width, 0)
      + Math.max(0, items.length - 1) * listGap;
    const hasOverflow = contentWidth > availableWidth + 1;

    setFilterRowOverflow(hasOverflow);
    if (!hasOverflow) {
      setVisibleFilterItemCount(items.length);
      setFilterRowExpanded(false);
      return;
    }
    if (filterRowExpanded) {
      setVisibleFilterItemCount(items.length);
      return;
    }

    const collapsedWidth = availableWidth - 28 - rowGap;
    let usedWidth = 0;
    let visibleCount = 0;
    for (const width of itemWidths) {
      const nextWidth = usedWidth + (visibleCount > 0 ? listGap : 0) + width;
      if (nextWidth > collapsedWidth) break;
      usedWidth = nextWidth;
      visibleCount++;
    }
    if (items[visibleCount - 1]?.hasAttribute('data-filter-separator')) visibleCount--;
    setVisibleFilterItemCount(visibleCount);
  }, [filterRowExpanded]);

  useEffect(() => {
    if (!assetsPanelOpen || visibleTab === 'drama' || visibleTab === 'nodes') return;
    const row = filterRowRef.current;
    if (!row) return;

    const frame = window.requestAnimationFrame(measureFilterRowOverflow);
    const resizeObserver = new ResizeObserver(measureFilterRowOverflow);
    resizeObserver.observe(row);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [assetsPanelOpen, categoryCounts, measureFilterRowOverflow, tagList, visibleTab]);

  // 过滤（分类 + 标签 + 搜索）
  const filteredFiles = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return files.filter((f) => {
      if (activeCategory && f.category !== activeCategory) return false;
      if (activeTag && !(f.tags ?? []).includes(activeTag)) return false;
      if (q) {
        const inName = f.name.toLowerCase().includes(q);
        const inTags = (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    });
  }, [files, activeCategory, activeTag, deferredSearch]);

  const visibleFiles = useMemo(() => filteredFiles.slice(0, visibleCount), [filteredFiles, visibleCount]);
  const previewScope = JSON.stringify([currentProjectId, selectedProjectId, activeTab, folderSelection, assetsPanelMode, visibleTab]);
  const batchImages = useMemo(() => [...new Map(filteredFiles.filter((file) => file.category === 'image'
    && !!file.assetUrl && isLocalAssetFile(file)).map((file) => [assetKey(file), file])).values()], [filteredFiles]);
  if (batchReverse && (!assetsPanelOpen || batchReverse.scope !== previewScope)) setBatchReverse(null);
  const hoverScope = JSON.stringify([assetsPanelOpen, previewScope, search, activeCategory, activeTag]);
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
          const text = !prompt ? '暂无提示词' : prompt.length > 240 ? `${prompt.slice(0, 240)}…（点击查看完整提示词）` : prompt;
          setHoverDetails({ key, scope: hoverScope, text });
        } catch {
          if (isCurrent()) setHoverDetails({ key, scope: hoverScope, text: '读取失败，请重试' });
        }
      })();
    }, 400);
    hoverRequestRef.current = { controller, timer };
  };
  const cardTooltip = (file: AssetFileEntry): string | undefined => {
    const current = hoverDetails?.key === assetKey(file) && hoverDetails.scope === hoverScope ? hoverDetails : null;
    if (current?.text === '') return undefined;
    return `${cardDragHint(file)}\n提示词：${current?.text ?? '正在读取…'}\n标签：\n${file.tags?.length ? file.tags.join('、') : '暂无标签'}`;
  };
  const cardDragHint = (file: AssetFileEntry): string => {
    const dragHint = !isDraggableEntry(file) || file.availability === 'offline' ? '此素材暂不支持拖拽'
      : isPage || !currentProjectId ? '可拖拽到其他窗口或应用；'
        : isDrawer ? '拖拽到画布可添加节点；' : '拖出弹窗到画布可添加节点；';
    const folderHint = activeTab === 'permanent' && file.category === 'image' && isLocalAssetFile(file)
      && (file.source === 'global' || file.source === 'folder') ? '拖到左侧文件夹可移动。' : '';
    return [folderHint, dragHint].filter(Boolean).join('\n');
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
    JSON.stringify([assetsPanelOpen, assetsPanelMode, currentProjectId, visibleTab, selectedProjectId, folderSelection, search, nodeSearch, activeCategory, activeTag]),
    isNodeList ? filteredNodes.map((node) => node.id) : visibleFiles.map(assetKey),
  );
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

  // ── 添加文件 / 文件夹 ──
  const handleAddFiles = useCallback(async () => {
    setAddMenuOpen(false);
    setBusy(true);
    try {
      const n = await addAssetFilesToGlobal();
      if (n > 0) { toast(`已添加 ${n} 个文件`); if (activeTab === 'permanent') await loadFiles(); }
    } catch { toast('添加失败'); } finally { setBusy(false); }
  }, [activeTab, loadFiles, toast]);

  const handleAddFolder = useCallback(async () => {
    setAddMenuOpen(false);
    setBusy(true);
    try {
      const path = await pickAssetFolder();
      if (path && !folders.includes(path)) {
        updateConfig({ assetFolders: [...folders, path] });
        await saveConfig();
        toast(`已添加文件夹: ${shortFolderName(path)}`);
      }
    } catch { toast('添加失败'); } finally { setBusy(false); }
  }, [folders, updateConfig, saveConfig, toast]);

  const handleRemoveFolder = useCallback(async (path: string) => {
    updateConfig({ assetFolders: folders.filter((f) => f !== path) });
    try { await saveConfig(); } catch { return; }
    if (folderSelection.kind === 'folder' && folderSelection.rootPath === path) handleSelectFolder({ kind: 'all' });
    // config.assetFolders 的变更触发 loadFiles，避免用旧目录清单再次覆盖新结果。
  }, [folders, updateConfig, saveConfig, folderSelection, handleSelectFolder]);

  // ── 全局资产 / 删除 ──
  const handleSavePermanent = useCallback(async (file: AssetFileEntry) => {
    const dest = await saveAssetToPermanent(file);
    toast(dest ? `已保存: ${file.name}` : '保存失败');
    if (dest && activeTab === 'permanent') await loadFiles();
  }, [activeTab, loadFiles, toast]);

  // ── 标签编辑（手动）──
  const persistTags = useCallback(async (assetId: string, path: string, tags: string[]) => {
    setTagMap((prev) => {
      const next = { ...prev };
      if (tags.length) next[assetId] = tags; else delete next[assetId];
      return next;
    });
    try {
      if (tags.length) await putAssetMeta({ assetId, path, tags, taggedBy: 'manual', updatedAt: Date.now() });
      else await deleteAssetMeta(assetId);
    } catch { /* ignore */ }
  }, [setTagMap]);

  const addTag = useCallback((file: AssetFileEntry, raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    const key = assetKey(file);
    const cur = tagMap[key] ?? [];
    if (cur.includes(tag)) return;
    persistTags(key, file.path, [...cur, tag]);
  }, [tagMap, persistTags]);

  const removeTag = useCallback((file: AssetFileEntry, tag: string) => {
    const key = assetKey(file);
    persistTags(key, file.path, (tagMap[key] ?? []).filter((t) => t !== tag));
  }, [tagMap, persistTags]);

  const switchTab = useCallback((tab: TabKey) => {
    setNodeListOpen(tab === 'nodes');
    if (tab === 'drama') {
      setDramaAssetsPanelOpen(true);
      setArkLibraryOpen(false);
    } else if (tab === 'ark') {
      setArkLibraryOpen(true);
      setDramaAssetsPanelOpen(false);
    } else {
      if (tab !== 'nodes') setActiveTab(tab);
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
          <div className={isPage ? 'absolute inset-0 z-40' : `assets-panel-wrapper${isDrawer ? ' assets-panel-wrapper--drawer' : ''}`}>
            <motion.div
              data-resource-video-boundary
              className={isPage ? 'assets-library-page flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas-bg pb-3' : `assets-panel${isDrawer ? ' assets-panel--drawer' : ''}`}
              role={isPage ? 'main' : isDrawer ? 'region' : 'dialog'}
              aria-label={isPage ? '资源库' : isDrawer ? '资产库快捷面板' : '资产管理'}
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
              {/* Header */}
              <div data-tauri-drag-region={isPage ? true : undefined} className={isPage ? `relative flex h-11 shrink-0 items-center gap-3 pr-3 ${macWindowControls ? 'pl-28' : 'pl-3'}` : 'assets-panel-header px-2.5 py-2'}>
                {isPage && <button type="button" autoFocus className="ui-btn ui-btn--ghost ui-btn--sm" onClick={handleClose}>
                  <Icon icon="mdi:arrow-left" width="16" aria-hidden="true" /> 返回启动页
                </button>}
                <h2 className="assets-panel-title">
                  {isPage ? '资源库' : isDrawer ? '资产库' : '资产管理'}
                  {!isDrawer && !isPage && <span className="assets-panel-subtitle">
                    {visibleTab === 'drama' ? '管理人物、场景和道具简介与绑图' : visibleTab === 'ark' ? '管理火山方舟虚拟人像素材' : isNodeList ? '查看当前画布中的全部节点' : '拖拽卡片到画布即可添加节点'}
                  </span>}
                </h2>
                {isDrawer ? (
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={handleClose} aria-label="收起资产库">
                    收起 <kbd>Tab</kbd>
                  </button>
                ) : !isPage && <PopupCloseButton onClick={handleClose} />}
              </div>

              {/* Tabs */}
              <div className="assets-tabs">
                <Tabs<TabKey>
                  items={[
                    { value: 'project', label: '项目文件', count: projectFiles.length },
                    { value: 'permanent', label: '全局资产', count: permanentFiles.length },
                    { value: 'drama', label: '创作资产', count: dramaAssetCount },
                    { value: 'ark', label: '方舟素材库', count: arkAssetCount },
                    { value: 'nodes', label: '节点列表', count: canvasNodeCount },
                  ] satisfies TabItem<TabKey>[]}
                  value={visibleTab}
                  onChange={switchTab}
                  size={isDrawer ? 'sm' : 'md'}
                  aria-label="资产类型"
                />

                {/* Toolbar: 搜索 + 添加 */}
              {visibleTab !== 'drama' && visibleTab !== 'ark' ? <div className="assets-toolbar ml-auto">
                {visibleTab === 'project' && (
                  <Select
                    className="assets-project-select-wrap"
                    triggerClassName="assets-project-select"
                    value={viewProjectId ?? ''}
                    onChange={(value) => setSelectedProjectId(value || null)}
                    options={listTopLevelProjects(projects).map((p) => ({
                      value: p.id,
                      label: currentProjectId && p.id === seriesOwnerId(projects, currentProjectId) ? `${p.name}（当前）` : p.name,
                    }))}
                  />
                )}
                <div className="assets-search ui-input-group">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    className="ui-input ui-input--sm"
                    type="text" placeholder={isNodeList ? '搜索节点名称、类型或编号…' : '搜索名称或标签…'}
                    value={isNodeList ? nodeSearch : search}
                    onChange={(e) => { (isNodeList ? setNodeSearch : setSearch)(e.target.value); setVisibleCount(PAGE_SIZE); }}
                  />
                  {(isNodeList ? nodeSearch : search) && (
                    <button type="button" className="assets-search-clear" onClick={() => { (isNodeList ? setNodeSearch : setSearch)(''); setVisibleCount(PAGE_SIZE); }} aria-label="清空">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
                {!isDrawer && !isNodeList && <div className="assets-column-stepper" role="group" aria-label="瀑布流列数">
                  <Icon icon="lucide:columns-3" className="assets-column-stepper-icon" aria-hidden="true" />
                  <button
                    type="button"
                    className="ui-icon-btn ui-icon-btn--sm"
                    aria-label="减少瀑布流列数"
                    disabled={waterfallColumns <= MIN_WATERFALL_COLUMNS}
                    onClick={() => adjustWaterfallColumns(-1)}
                  >
                    <Icon icon="lucide:minus" aria-hidden="true" />
                  </button>
                  <output aria-label={`当前 ${waterfallColumns} 列`}>{waterfallColumns}</output>
                  <button
                    type="button"
                    className="ui-icon-btn ui-icon-btn--sm"
                    aria-label="增加瀑布流列数"
                    disabled={waterfallColumns >= MAX_WATERFALL_COLUMNS}
                    onClick={() => adjustWaterfallColumns(1)}
                  >
                    <Icon icon="lucide:plus" aria-hidden="true" />
                  </button>
                </div>}
                {(visibleTab === 'project' || visibleTab === 'permanent') && <button type="button" className="ui-btn ui-btn--sm shrink-0"
                  disabled={!isTauriEnv() || !batchImages.length || busy || loading} title="批量反推当前筛选图片的提示词和标签"
                  onClick={() => {
                    dismissHover(); setAddMenuOpen(false); setFileMenu(null);
                    setBatchReverse({ scope: previewScope, entries: batchImages.map((file) => ({ file: { ...file }, projectId: projectIdForFile(file) })) });
                  }}><Icon icon="lucide:sparkles" aria-hidden="true" />批量反推</button>}
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
                      添加
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
                          <button type="button" onClick={handleAddFiles}>📄 添加文件</button>
                          <button type="button" onClick={handleAddFolder}>📁 添加文件夹</button>
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
                      <span>{nodeSearch.trim() ? '没有匹配的节点' : '当前画布暂无节点'}</span>
                    </div>
                  ) : (
                    <>
                      <ul className="assets-node-grid" aria-label="当前画布节点">
                        {filteredNodes.slice(0, visibleCount).map((node) => (
                          <li key={node.id} data-node-id={node.id} className="ui-card assets-node-card min-w-0 p-3">
                            <div className="flex items-center gap-2">
                              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ${node.config.color} ${node.config.bg}`}>
                                <Icon icon={node.config.icon} width="18" height="18" aria-hidden="true" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium text-canvas-text" title={node.label}>{node.label}</p>
                                <p className="truncate text-[11px] text-canvas-text-muted">
                                  {node.displayId !== undefined && <span>#{node.displayId} · </span>}{node.config.label}
                                </p>
                              </div>
                              <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0"
                                aria-label={`查看节点 ${node.label}`} onClick={() => handleLocateNode(node.id)}>
                                查看节点
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
                          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>加载更多节点</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : visibleTab === 'drama' ? (
                <Suspense
                  fallback={(
                    <div className="flex flex-1 items-center justify-center text-xs text-canvas-text-muted">
                      正在加载短剧资产...
                    </div>
                  )}
                >
                  <DramaAssetsPanel compact={isDrawer} />
                </Suspense>
              ) : visibleTab === 'ark' ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs text-canvas-text-muted">正在加载方舟素材库...</div>}>
                  <VolcengineAssetLibraryPanel
                    compact={isDrawer}
                    onCountChange={setArkAssetCount}
                    onOpenProviderSettings={() => useAppStore.getState().openApiKeySettings('volcengine')}
                  />
                </Suspense>
              ) : (
                <div className="assets-file-browser">
                  {activeTab === 'permanent' && (
                    <AssetFolderNavigation
                      folders={externalFolders} selection={folderSelection} totalCount={permanentFiles.length}
                      globalCount={permanentFiles.filter((file) => file.source === 'global').length}
                      compact={isDrawer} loading={loading || busy} onSelect={handleSelectFolder} globalRootPath={globalRootPath}
                      onCreate={handleCreateSubfolder}
                      dropTarget={folderDropTarget}
                      onCopy={(selection) => { void handleFolderClipboard(selection, 'copy'); }}
                      onPaste={(selection) => { void handleFolderClipboard(selection, 'paste'); }}
                      onRemove={(rootPath) => { void handleRemoveFolder(rootPath); }}
                    />
                  )}
                  <div className="assets-file-content">
                    {folderProgress && <div role="status" className="flex items-center gap-2 p-2 text-xs text-canvas-text-secondary">
                      <Icon icon="lucide:loader-circle" className="animate-spin" aria-hidden="true" /><span className="flex-1">{folderProgress}</span>
                      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => folderOperationRef.current?.abort()}>取消操作</button>
                    </div>}
                    {activeTab === 'permanent' && (
                      <div className="flex shrink-0 items-center gap-2 px-3 pt-2 text-xs text-canvas-text-secondary">
                        <span className="min-w-0 flex-1 truncate" title={folderLabel}>{folderLabel}</span>
                        <span className="shrink-0 text-canvas-text-muted">{files.length} 个文件</span>
                      </div>
                    )}
                    {activeTab === 'permanent' && folderScanTruncated && (
                      <p role="status" className="px-3 pt-2 text-xs text-canvas-text-muted">已达到扫描上限，当前仅显示已扫描的目录和文件。可单独添加子文件夹继续浏览。</p>
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
                    全部<span className="assets-cat-count">{files.length}</span>
                  </button>
                  {listedCategories.map((cat, index) => (
                    <button
                      key={cat} type="button"
                      className={`assets-cat-chip ${activeCategory === cat ? 'active' : ''} ${filterRowExpanded || index + 1 < visibleFilterItemCount ? '' : 'assets-filter-item-hidden'}`}
                      onClick={() => { setActiveCategory(cat); setVisibleCount(PAGE_SIZE); }}
                    >
                      {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
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
                    aria-label={filterRowExpanded ? '收起标签' : '展开更多标签'}
                    title={filterRowExpanded ? '收起标签' : '更多标签'}
                    onClick={() => setFilterRowExpanded((expanded) => !expanded)}
                  >
                    <Icon icon={filterRowExpanded ? 'lucide:chevron-up' : 'lucide:ellipsis'} aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* 文件瀑布流 */}
              <div className="assets-file-scroll-shell">
                <div className="assets-file-scroll" key={activeTab === 'permanent' ? JSON.stringify(folderSelection) : 'project'}>
                  {!loading && loadError && (
                    <div className="ui-alert ui-alert--warning m-2" role="alert">
                      <span className="min-w-0 flex-1">{loadError}</span>
                      <button type="button" className="ui-btn ui-btn--secondary shrink-0"
                        onClick={() => { void loadFiles().then(loadTags); }}>重试加载</button>
                    </div>
                  )}
                  <div className="assets-file-waterfall" data-columns={waterfallColumns}>
                    {loading ? (
                      <div className="assets-empty">
                        <motion.div className="assets-spinner" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.6, ease: 'linear' }} />
                        <span>加载中...</span>
                      </div>
                    ) : filteredFiles.length === 0 && !loadError ? (
                      <div className="assets-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" /><line x1="9" y1="15" x2="15" y2="15" />
                        </svg>
                        <span>{activeTab === 'permanent' && selectedFolder?.availability === 'offline' ? '文件夹无法访问，请检查位置或权限'
                          : activeTab === 'permanent' && selectedFolder?.availability === 'unscanned' ? '此文件夹尚未扫描，可单独添加此目录继续浏览'
                          : search || activeCategory || activeTag ? '没有匹配的文件' : activeTab === 'project' ? '暂无项目文件'
                            : selectedFolder ? externalFolders.some((folder) => folder.rootPath === selectedFolder.rootPath
                              && folder.parentRelativePath === selectedFolder.relativePath)
                              ? '此文件夹没有本层文件，请选择子文件夹浏览' : '此文件夹为空'
                              : '暂无文件，点击「添加」导入'}</span>
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
                          <div ref={sentinelRef} className="assets-load-sentinel">加载更多…</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
                  </div>
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
                    {toastMsg}
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
  };
  return <>{presentationPanel}
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
        x={fileMenu.x} y={fileMenu.y} confirmDelete={fileMenu.confirmDelete}
        canFileActions={isLocalAssetFile(fileMenu.file) && isTauriEnv()}
        canCopyPrompt={fileMenu.file.category === 'image' || fileMenu.file.category === 'video'}
        onCopy={() => performFileAction('copy')} onCopyPrompt={() => performFileAction('prompt')}
        onReveal={() => performFileAction('reveal')} onDelete={() => performFileAction('delete')} onClose={closeFileMenu} />}
    {assetsPanelOpen && textPreview?.scope === previewScope && <Suspense fallback={<p role="status">正在打开文档…</p>}>
      <AssetTextPreview key={textPreview.scope} file={textPreview.file} projectId={projectIdForFile(textPreview.file)}
        onClose={() => setTextPreview(null)} onSaved={(next) => {
          const replace = (entries: AssetFileEntry[]) => entries.map((entry) => entry.path === next.path ? { ...entry, size: next.size } : entry);
          setProjectFiles(replace); setPermanentFiles(replace);
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
        badge={file.source === 'folder' ? '外部' : undefined}
      >
        <CardActions isProject={isProject} onSave={onSave} onDelete={onDelete} onToggleEdit={onToggleEdit} />
      </AssetThumb>

      {(tags.length > 0 || editing) && (
        <div className={`assets-card-tags${editing ? '' : ' assets-card-tags--collapsed'}`}>
          {tags.map((t) => (
            <span key={t} className="assets-card-tag">
              {t}
              {editing && <button type="button" onClick={() => onRemoveTag(t)} aria-label="移除标签">×</button>}
            </span>
          ))}
          {editing && (
            <input
              className="assets-tag-input" autoFocus value={tagDraft}
              placeholder="加标签…"
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
