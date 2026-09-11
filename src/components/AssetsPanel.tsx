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
} from 'react';
import { Icon } from '@iconify/react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import {
  listProjectFiles,
  listGlobalFiles,
  listExternalFolderFiles,
  addAssetFilesToGlobal,
  pickAssetFolder,
  saveAssetToPermanent,
  deletePermanentFile,
  extractFilesFromNodeData,
  CATEGORY_LABELS,
  type AssetFileEntry,
  type FileCategory,
} from '../services/fileService';
import { getAllAssetMeta, putAssetMeta, deleteAssetMeta } from '../services/indexedDbService';
import { startAssetDrag, prepareDragIcon } from '../utils/assetDrag';
import { ALL_CATEGORIES, CATEGORY_ICONS, shortFolderName } from '../utils/assetFormat';
import AssetThumb from './shared/AssetThumb';
import PopupCloseButton from './shared/PopupCloseButton';
import Select from './shared/Select';
import { springSmooth, fadeFast } from '../utils/motion';
import { countUnreadDramaAssets } from '../store/store.dramaAssets';
import { distributeToColumns } from './assets/waterfallColumns';
import { getNodeTypeConfig } from '../types';
import CanvasNodeCardContent from './assets/CanvasNodeCardContent';
import { useResourceVideoPreview } from '../hooks/useResourceVideoPreview';

const DramaAssetsPanel = lazy(() => import('./DramaAssetsPanel'));

/** 仅磁盘真实文件可拖拽（排除节点引用的 node:// / virtual:// 虚拟路径）*/
function isDraggableEntry(file: AssetFileEntry): boolean {
  return !!file.path && !file.path.startsWith('node://') && !file.path.startsWith('virtual://');
}

type FileTabKey = 'project' | 'permanent';
type TabKey = FileTabKey | 'drama' | 'nodes';

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
  const {
    assetsPanelOpen,
    assetsPanelMode,
    setAssetsPanelOpen,
    dramaAssetsPanelOpen,
    setDramaAssetsPanelOpen,
    markDramaAssetsViewed,
    unreadDramaAssetCount,
    dramaAssetCount,
    canvasNodeCount,
    currentProjectId,
    projects,
    assetFolders,
    assetWaterfallColumns,
    updateConfig,
    saveConfig,
  } =
    useAppStore(
      useShallow((s) => ({
        assetsPanelOpen: s.assetsPanelOpen,
        assetsPanelMode: s.assetsPanelMode,
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
        assetFolders: s.config.assetFolders,
        assetWaterfallColumns: s.config.assetWaterfallColumns,
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
      })),
    );

  const [activeTab, setActiveTab] = useState<FileTabKey>('project');
  const [nodeListOpen, setNodeListOpen] = useState(false);
  const visibleTab: TabKey = dramaAssetsPanelOpen ? 'drama' : nodeListOpen ? 'nodes' : activeTab;
  const isNodeList = visibleTab === 'nodes';
  // 只在节点页订阅标识和内容；移动节点不改变 data，避免位置更新重绘整个资产面板。
  const canvasNodeIds = useAppStore(useShallow((s) => assetsPanelOpen && isNodeList ? s.nodes.map((node) => node.id) : []));
  const canvasNodeData = useAppStore(useShallow((s) => assetsPanelOpen && isNodeList ? s.nodes.map((node) => node.data) : []));
  // 项目文件 Tab 查看的项目；null 表示「跟随当前项目」（关闭时复位，故每次打开默认当前项目）
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<FileCategory | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [nodeSearch, setNodeSearch] = useState('');
  const deferredNodeSearch = useDeferredValue(nodeSearch);
  const isDrawer = assetsPanelMode === 'drawer';
  const waterfallColumns = isDrawer ? DEFAULT_WATERFALL_COLUMNS : normalizeWaterfallColumns(assetWaterfallColumns);

  const [projectFiles, setProjectFiles] = useState<AssetFileEntry[]>([]);
  const [permanentFiles, setPermanentFiles] = useState<AssetFileEntry[]>([]);
  // 标签 Map（path -> tags），作为标签的唯一真相源，编辑时只更新它，避免重新读盘
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});

  const [loading, setLoading] = useState(false);
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

  // 同一组件在两种展示方式之间复用；每次从画布打开时跟随当前项目。
  const presentation = assetsPanelOpen ? assetsPanelMode : null;
  const [previousPresentation, setPreviousPresentation] = useState(presentation);
  const [motionMode, setMotionMode] = useState(assetsPanelMode);
  if (presentation !== previousPresentation) {
    setPreviousPresentation(presentation);
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
  }, []);

  // 载入文件列表（按 Tab 聚合）
  const loadFiles = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const isCurrentRequest = () => requestId === loadRequestRef.current
      && currentProjectId === useAppStore.getState().currentProjectId;
    setLoading(true);
    try {
      if (activeTab === 'project') {
        const viewProjectId = selectedProjectId ?? currentProjectId;
        if (!viewProjectId) { setProjectFiles([]); return; }
        const diskFiles = await listProjectFiles(viewProjectId);
        if (!isCurrentRequest()) return;
        const known = new Set(diskFiles.map((f) => f.path));
        const nodeEntries: AssetFileEntry[] = [];
        // 仅当查看的是「当前项目」时，才并入画布上尚未落盘的节点文件
        // （store.nodes 始终是当前项目的画布，其他项目无法从内存取节点）
        if (viewProjectId === currentProjectId) {
          for (const node of useAppStore.getState().nodes) {
            const entry = extractFilesFromNodeData(node.data as Record<string, unknown>);
            if (entry && !known.has(entry.path)) { nodeEntries.push(entry); known.add(entry.path); }
          }
        }
        setProjectFiles([...diskFiles, ...nodeEntries]);
      } else {
        // 永久 = 全局 file 目录 + 登记的外部文件夹（递归）
        const [globalFiles, folderFiles] = await Promise.all([
          listGlobalFiles(),
          listExternalFolderFiles(folders),
        ]);
        if (!isCurrentRequest()) return;
        const seen = new Set<string>();
        const merged: AssetFileEntry[] = [];
        for (const f of [...globalFiles, ...folderFiles]) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          merged.push(f);
        }
        setPermanentFiles(merged);
      }
    } catch { /* ignore */ } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [activeTab, currentProjectId, selectedProjectId, folders]);

  useEffect(() => {
    if (assetsPanelOpen) {
      // 异步读取外部文件和 IndexedDB 标签；setState 发生在 Promise 完成后。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadFiles().then(loadTags);
      void prepareDragIcon();
    }
    return () => { loadRequestRef.current += 1; };
  }, [assetsPanelOpen, loadFiles, loadTags]);

  useEffect(() => {
    if (!assetsPanelOpen || visibleTab !== 'drama') return;
    if (unreadDramaAssetCount > 0 || useAppStore.getState().dramaAssets.lastViewedAt === undefined) {
      markDramaAssetsViewed();
    }
  }, [assetsPanelOpen, markDramaAssetsViewed, unreadDramaAssetCount, visibleTab]);

  const handleClose = useCallback(() => {
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

  // 拖拽文件到画布：dragstart 内同步发起原生拖拽，并立即隐藏弹窗露出画布
  const handleCardDragStart = useCallback((file: AssetFileEntry, e: DragEvent) => {
    if (!isDraggableEntry(file)) return;
    e.preventDefault();
    startAssetDrag(file);
    setAssetsPanelOpen(false);
  }, [setAssetsPanelOpen]);

  // Esc 关闭
  useEffect(() => {
    if (!assetsPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // 抽屉之上的确认框/选择器先消费 Esc，避免连带关闭资产库。
      if (isDrawer && document.querySelector('[aria-modal="true"], [role="listbox"], dialog[open]')) return;
      handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [assetsPanelOpen, handleClose, isDrawer]);

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
  const rawFiles = activeTab === 'project' ? projectFiles : permanentFiles;

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
    JSON.stringify([assetsPanelOpen, assetsPanelMode, currentProjectId, visibleTab, selectedProjectId, search, nodeSearch, activeCategory, activeTag]),
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
  }, [totalResultCount, visibleCount, visibleTab]);

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
        if (activeTab === 'permanent') await loadFiles();
      }
    } catch { toast('添加失败'); } finally { setBusy(false); }
  }, [folders, updateConfig, saveConfig, activeTab, loadFiles, toast]);

  const handleRemoveFolder = useCallback(async (path: string) => {
    updateConfig({ assetFolders: folders.filter((f) => f !== path) });
    try { await saveConfig(); } catch { return; }
    if (activeTab === 'permanent') await loadFiles();
  }, [folders, updateConfig, saveConfig, activeTab, loadFiles]);

  // ── 全局资产 / 删除 ──
  const handleSavePermanent = useCallback(async (file: AssetFileEntry) => {
    const dest = await saveAssetToPermanent(file);
    toast(dest ? `已保存: ${file.name}` : '保存失败');
    if (dest && activeTab === 'permanent') await loadFiles();
  }, [activeTab, loadFiles, toast]);

  const handleDeletePermanent = useCallback(async (file: AssetFileEntry) => {
    await deletePermanentFile(file.path);
    setPermanentFiles((prev) => prev.filter((f) => f.path !== file.path));
    toast(`已删除: ${file.name}`);
  }, [toast]);

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
  }, []);

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
    } else {
      if (tab !== 'nodes') setActiveTab(tab);
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
          {!isDrawer && <motion.div
            data-tauri-drag-region
            className="assets-panel-backdrop"
            variants={backdropVariants}
            initial="hidden" animate="visible" exit="hidden"
            transition={{ duration: 0.2 }}
            onClick={handleClose}
          />}
          <div className={`assets-panel-wrapper${isDrawer ? ' assets-panel-wrapper--drawer' : ''}`}>
            <motion.div
              data-resource-video-boundary
              className={`assets-panel${isDrawer ? ' assets-panel--drawer' : ''}`}
              role={isDrawer ? 'region' : 'dialog'}
              aria-label={isDrawer ? '资产库快捷面板' : '资产管理'}
              aria-modal={isDrawer ? undefined : true}
              variants={isDrawer ? {
                hidden: { opacity: 0, x: reduceMotion ? 0 : '-100%' },
                visible: { opacity: 1, x: 0, transition: drawerTransition },
                exit: { opacity: 0, x: reduceMotion ? 0 : '-100%', transition: drawerTransition },
              } : panelVariants}
              initial="hidden" animate="visible" exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="assets-panel-header">
                <h2 className="assets-panel-title">
                  {isDrawer ? '资产库' : '资产管理'}
                  {!isDrawer && <span className="assets-panel-subtitle">
                    {visibleTab === 'drama' ? '管理人物、场景和道具简介与绑图' : isNodeList ? '查看当前画布中的全部节点' : '拖拽卡片到画布即可添加节点'}
                  </span>}
                </h2>
                {isDrawer ? (
                  <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={handleClose} aria-label="收起资产库">
                    收起 <kbd>Tab</kbd>
                  </button>
                ) : <PopupCloseButton onClick={handleClose} />}
              </div>

              {/* Tabs */}
              <div className="assets-tabs">
                {(['project', 'permanent', 'drama', 'nodes'] as TabKey[]).map((tab) => (
                  <motion.button
                    key={tab} type="button"
                    className={`assets-tab ${visibleTab === tab ? 'active' : ''}`}
                    onClick={() => switchTab(tab)}
                    whileHover={{ scale: visibleTab === tab ? 1 : 1.03 }} whileTap={{ scale: 0.97 }}
                  >
                    {tab === 'project' ? '项目文件' : tab === 'permanent' ? '全局资产' : tab === 'drama' ? '创作资产' : '节点列表'}
                    <span className="assets-tab-count">
                      {tab === 'project' ? projectFiles.length : tab === 'permanent' ? permanentFiles.length : tab === 'drama' ? dramaAssetCount : canvasNodeCount}
                    </span>
                  </motion.button>
                ))}

                {/* Toolbar: 搜索 + 添加 */}
              {visibleTab !== 'drama' ? <div className="assets-toolbar ml-auto">
                {visibleTab === 'project' && (
                  <Select
                    className="assets-project-select-wrap"
                    triggerClassName="assets-project-select"
                    value={selectedProjectId ?? currentProjectId ?? ''}
                    onChange={(value) => setSelectedProjectId(value || null)}
                    options={projects.map((p) => ({
                      value: p.id,
                      label: p.id === currentProjectId ? `${p.name}（当前）` : p.name,
                    }))}
                  />
                )}
                <div className="assets-search">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
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
                    aria-label="减少瀑布流列数"
                    disabled={waterfallColumns <= MIN_WATERFALL_COLUMNS}
                    onClick={() => adjustWaterfallColumns(-1)}
                  >
                    <Icon icon="lucide:minus" aria-hidden="true" />
                  </button>
                  <output aria-label={`当前 ${waterfallColumns} 列`}>{waterfallColumns}</output>
                  <button
                    type="button"
                    aria-label="增加瀑布流列数"
                    disabled={waterfallColumns >= MAX_WATERFALL_COLUMNS}
                    onClick={() => adjustWaterfallColumns(1)}
                  >
                    <Icon icon="lucide:plus" aria-hidden="true" />
                  </button>
                </div>}
                {visibleTab === 'permanent' && (
                  <div className="assets-add-wrap" ref={addWrapRef}>
                    <motion.button
                      type="button" className="assets-add-btn" disabled={busy}
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
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pt-2">
                  {filteredNodes.length === 0 ? (
                    <div className="assets-empty">
                      <Icon icon="lucide:workflow" width="32" height="32" aria-hidden="true" />
                      <span>{nodeSearch.trim() ? '没有匹配的节点' : '当前画布暂无节点'}</span>
                    </div>
                  ) : (
                    <>
                      <ul className="flex flex-col gap-1.5" aria-label="当前画布节点">
                        {filteredNodes.slice(0, visibleCount).map((node) => (
                          <li key={node.id} data-node-id={node.id} className="ui-card assets-node-card p-2">
                            <div className="flex items-center gap-2">
                              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded ${node.config.color} ${node.config.bg}`}>
                                <Icon icon={node.config.icon} width="18" height="18" aria-hidden="true" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs text-canvas-text" title={node.label}>{node.label}</p>
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
              ) : (
                <>
              {/* 已添加的外部文件夹 */}
              {activeTab === 'permanent' && folders.length > 0 && (
                <div className="assets-folder-row">
                  {folders.map((f) => (
                    <span key={f} className="assets-folder-chip">
                      📁 {shortFolderName(f)}
                      <button type="button" onClick={() => handleRemoveFolder(f)} aria-label="移除">×</button>
                    </span>
                  ))}
                </div>
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
                <div className="assets-file-scroll">
                  <div className="assets-file-waterfall" data-columns={waterfallColumns}>
                    {loading ? (
                      <div className="assets-empty">
                        <motion.div className="assets-spinner" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.6, ease: 'linear' }} />
                        <span>加载中...</span>
                      </div>
                    ) : filteredFiles.length === 0 ? (
                      <div className="assets-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" /><line x1="9" y1="15" x2="15" y2="15" />
                        </svg>
                        <span>{search || activeCategory || activeTag ? '没有匹配的文件' : activeTab === 'project' ? '暂无项目文件' : '暂无文件，点击「添加」导入'}</span>
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
                                  onDragStart={(e) => handleCardDragStart(file, e)}
                                  editing={editingPath === assetKey(file)}
                                  tagDraft={editingPath === assetKey(file) ? tagDraft : ''}
                                  onToggleEdit={() => { const key = assetKey(file); setEditingPath((p) => (p === key ? null : key)); setTagDraft(''); }}
                                  onTagDraftChange={setTagDraft}
                                  onAddTag={(t) => { addTag(file, t); setTagDraft(''); }}
                                  onRemoveTag={(t) => removeTag(file, t)}
                                  onSave={() => handleSavePermanent(file)}
                                  onDelete={() => handleDeletePermanent(file)}
                                  videoExpanded={videoPreview.expandedId === assetKey(file)}
                                  onVideoExpandedChange={(expanded) => videoPreview.setExpanded(expanded ? assetKey(file) : null)}
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
                </>
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
  return motionMode === 'drawer'
    ? <MotionConfig reducedMotion="user" transition={drawerTransition}>{panel}</MotionConfig>
    : panel;
}

/* ============================================
   单个资产卡片（轻量，无 layout 动画）
   ============================================ */
interface AssetCardProps {
  file: AssetFileEntry;
  isProject: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  editing: boolean;
  tagDraft: string;
  onToggleEdit: () => void;
  onTagDraftChange: (v: string) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onSave: () => void;
  onDelete: () => void;
  videoExpanded?: boolean;
  onVideoExpandedChange?: (expanded: boolean) => void;
}

function AssetCard({
  file, isProject, draggable, onDragStart, editing, tagDraft,
  onToggleEdit, onTagDraftChange, onAddTag, onRemoveTag, onSave, onDelete,
  videoExpanded = false, onVideoExpandedChange,
}: AssetCardProps) {
  const tags = file.tags ?? [];
  return (
    <div
      className={`assets-waterfall-card anim-card-in${videoExpanded ? ' has-expanded-video' : ''}`}
      draggable={draggable && !videoExpanded}
      onDragStart={onDragStart}
    >
      <AssetThumb
        assetUrl={file.assetUrl}
        filePath={file.path}
        videoExpanded={videoExpanded}
        onVideoExpandedChange={onVideoExpandedChange}
        name={file.name}
        category={file.category}
        size={file.size}
        badge={file.source === 'folder' ? '外部' : undefined}
      >
        <CardActions isProject={isProject} onSave={onSave} onDelete={onDelete} onToggleEdit={onToggleEdit} />
      </AssetThumb>

      {(tags.length > 0 || editing) && (
        <div className="assets-card-tags">
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
      {!isProject && <div className="assets-card-name">{file.name}</div>}
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
