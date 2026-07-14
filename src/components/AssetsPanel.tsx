/**
 * AssetsPanel 资产管理面板 — 浏览项目文件 + 全局资产库（永久），支持：
 *  · 添加本地文件（拷贝到全局 {baseDataDir}/file）/ 文件夹（递归引用，不拷贝）
 *  · 搜索（名称 + 标签）、分类与标签筛选
 *  · 手动为文件打标签（持久化到 IndexedDB assetMeta）
 * 性能：useDeferredValue 搜索 + useMemo 过滤 + 增量渲染（IntersectionObserver）+ 图片懒加载，
 *       并移除了大列表下昂贵的逐项 layout 动画。
 */
import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue, type DragEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
import { springSmooth, fadeFast } from '../utils/motion';

/** 仅磁盘真实文件可拖拽（排除节点引用的 node:// / virtual:// 虚拟路径）*/
function isDraggableEntry(file: AssetFileEntry): boolean {
  return !!file.path && !file.path.startsWith('node://') && !file.path.startsWith('virtual://');
}

type TabKey = 'project' | 'permanent';

/** 单页渲染数量（增量加载步长）— 限制 DOM 规模 */
const PAGE_SIZE = 48;
/** 标签筛选行最多展示的标签数 */
const MAX_TAG_CHIPS = 24;

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
  const { assetsPanelOpen, setAssetsPanelOpen, currentProjectId, projects, assetFolders, updateConfig, saveConfig } =
    useAppStore(
      useShallow((s) => ({
        assetsPanelOpen: s.assetsPanelOpen,
        setAssetsPanelOpen: s.setAssetsPanelOpen,
        currentProjectId: s.currentProjectId,
        projects: s.projects,
        assetFolders: s.config.assetFolders,
        updateConfig: s.updateConfig,
        saveConfig: s.saveConfig,
      })),
    );

  const [activeTab, setActiveTab] = useState<TabKey>('project');
  // 项目文件 Tab 查看的项目；null 表示「跟随当前项目」（关闭时复位，故每次打开默认当前项目）
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<FileCategory | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

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

  const folders = useMemo(() => assetFolders ?? [], [assetFolders]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  }, []);

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
    setLoading(true);
    try {
      if (activeTab === 'project') {
        const viewProjectId = selectedProjectId ?? currentProjectId;
        if (!viewProjectId) { setProjectFiles([]); return; }
        const diskFiles = await listProjectFiles(viewProjectId);
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
      setLoading(false);
    }
  }, [activeTab, currentProjectId, selectedProjectId, folders]);

  useEffect(() => {
    if (assetsPanelOpen) {
      // 异步读取外部文件和 IndexedDB 标签；setState 发生在 Promise 完成后。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadFiles().then(loadTags);
      void prepareDragIcon();
    }
  }, [assetsPanelOpen, loadFiles, loadTags]);

  const handleClose = useCallback(() => {
    setSelectedProjectId(null); // 复位项目选择，下次打开默认当前项目
    setAssetsPanelOpen(false);
  }, [setAssetsPanelOpen]);

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
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [assetsPanelOpen, handleClose]);

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

  // 无限滚动哨兵
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((c) => (c < filteredFiles.length ? c + PAGE_SIZE : c));
      }
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [filteredFiles.length, visibleFiles.length]);

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
    await saveConfig();
    if (activeTab === 'permanent') await loadFiles();
  }, [folders, updateConfig, saveConfig, activeTab, loadFiles]);

  // ── 永久保存 / 删除 ──
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
    setActiveTab(tab);
    setActiveCategory(null);
    setActiveTag(null);
    setEditingPath(null);
    setVisibleCount(PAGE_SIZE);
  }, []);

  if (!assetsPanelOpen) return null;

  return (
    <AnimatePresence>
      {assetsPanelOpen && (
        <>
          <motion.div
            className="assets-panel-backdrop"
            variants={backdropVariants}
            initial="hidden" animate="visible" exit="hidden"
            transition={{ duration: 0.2 }}
            onClick={handleClose}
          />
          <div className="assets-panel-wrapper">
            <motion.div
              className="assets-panel"
              variants={panelVariants}
              initial="hidden" animate="visible" exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="assets-panel-header">
                <h2 className="assets-panel-title">资产管理<span className="assets-panel-subtitle">拖拽卡片到画布即可添加节点</span></h2>
                <motion.button
                  type="button" className="assets-panel-close" onClick={handleClose} aria-label="关闭"
                  whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </motion.button>
              </div>

              {/* Tabs */}
              <div className="assets-tabs">
                {(['project', 'permanent'] as TabKey[]).map((tab) => (
                  <motion.button
                    key={tab} type="button"
                    className={`assets-tab ${activeTab === tab ? 'active' : ''}`}
                    onClick={() => switchTab(tab)}
                    whileHover={{ scale: activeTab === tab ? 1 : 1.03 }} whileTap={{ scale: 0.97 }}
                  >
                    {tab === 'project' ? '项目文件' : '永久保存'}
                    <span className="assets-tab-count">{tab === 'project' ? projectFiles.length : permanentFiles.length}</span>
                  </motion.button>
                ))}

                {/* Toolbar: 搜索 + 添加 */}
              <div className="assets-toolbar ml-auto">
                {activeTab === 'project' && (
                  <select
                    className="assets-project-select"
                    value={selectedProjectId ?? currentProjectId ?? ''}
                    onChange={(e) => setSelectedProjectId(e.target.value || null)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id === currentProjectId ? `${p.name}（当前）` : p.name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="assets-search">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text" placeholder="搜索名称或标签…"
                    value={search} onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
                  />
                  {search && (
                    <button type="button" className="assets-search-clear" onClick={() => { setSearch(''); setVisibleCount(PAGE_SIZE); }} aria-label="清空">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
                {activeTab === 'permanent' && (
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
              </div>
              </div>

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
              <div className="assets-category-row">
                <button
                  type="button" className={`assets-cat-chip ${activeCategory === null ? 'active' : ''}`}
                  onClick={() => { setActiveCategory(null); setVisibleCount(PAGE_SIZE); }}
                >
                  全部<span className="assets-cat-count">{files.length}</span>
                </button>
                {ALL_CATEGORIES.filter((cat) => categoryCounts[cat] > 0).map((cat) => (
                  <button
                    key={cat} type="button"
                    className={`assets-cat-chip ${activeCategory === cat ? 'active' : ''}`}
                    onClick={() => { setActiveCategory(cat); setVisibleCount(PAGE_SIZE); }}
                  >
                    {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                    <span className="assets-cat-count">{categoryCounts[cat]}</span>
                  </button>
                ))}
                {tagList.length > 0 && <span className="assets-chip-sep" />}
                {tagList.map(([tag, count]) => (
                  <button
                    key={tag} type="button"
                    className={`assets-cat-chip assets-tag-chip ${activeTag === tag ? 'active' : ''}`}
                    onClick={() => { setActiveTag((t) => (t === tag ? null : tag)); setVisibleCount(PAGE_SIZE); }}
                  >
                    #{tag}<span className="assets-cat-count">{count}</span>
                  </button>
                ))}
              </div>

              {/* 文件瀑布流 */}
              <div className="assets-file-waterfall">
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
                    {visibleFiles.map((file) => (
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
                      />
                    ))}
                    {visibleCount < filteredFiles.length && (
                      <div ref={sentinelRef} className="assets-load-sentinel">加载更多…</div>
                    )}
                  </>
                )}
              </div>

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
}

function AssetCard({
  file, isProject, draggable, onDragStart, editing, tagDraft,
  onToggleEdit, onTagDraftChange, onAddTag, onRemoveTag, onSave, onDelete,
}: AssetCardProps) {
  const tags = file.tags ?? [];
  return (
    <div
      className="assets-waterfall-card anim-card-in"
      draggable={draggable}
      onDragStart={onDragStart}
    >
      <AssetThumb
        assetUrl={file.assetUrl}
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
