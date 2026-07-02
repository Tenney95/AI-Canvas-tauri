/**
 * AssetSearchWindow — 独立「资源搜索」窗口（由 Alt+Space / Ctrl+Space 唤起）
 *
 * 跨项目 / 全局资产库 / 外部文件夹聚合所有文件，支持按文件名 + 标签搜索，
 * 并可按来源（项目 / 文件夹）和分类筛选。运行在独立的 Tauri WebviewWindow 中，
 * 不依赖主窗口的 zustand store，直接复用 fileService / IndexedDB（同源共享）。
 */
import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue, type DragEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  loadConfig,
  saveConfig,
  loadProjectsList,
  listProjectFiles,
  listGlobalFiles,
  listExternalFolderFiles,
  registerProjectFolders,
  setBaseDataDir,
  revealFileInFolder,
  addAssetFilesToGlobal,
  pickAssetFolder,
  CATEGORY_LABELS,
  type AssetFileEntry,
  type FileCategory,
} from '../services/fileService';
import { getAllAssetMeta } from '../services/indexedDbService';
import { startAssetDrag, prepareDragIcon } from '../utils/assetDrag';
import { ALL_CATEGORIES, CATEGORY_ICONS, shortFolderName } from '../utils/assetFormat';
import { springSmooth, fadeFast } from '../utils/motion';
import AssetThumb from './shared/AssetThumb';
import type { AppConfig } from '../types';

/** 单页渲染数量（增量加载步长）*/
const PAGE_SIZE = 60;

interface SearchEntry extends AssetFileEntry {
  projectId?: string;
  projectName?: string;
}

/** 来源筛选项 */
interface SourceOption {
  key: string;        // 'all' | `project:<id>` | 'global' | `folder:<root>`
  label: string;
  group?: string;     // optgroup 分组标题
}

export default function AssetSearchWindow() {
  const [files, setFiles] = useState<SearchEntry[]>([]);
  const [tagMap, setTagMap] = useState<Record<string, string[]>>({});
  const [sources, setSources] = useState<SourceOption[]>([{ key: 'all', label: '全部来源' }]);

  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [activeSource, setActiveSource] = useState('all');
  const [activeCategory, setActiveCategory] = useState<FileCategory | null>(null);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // ── 加载：配置 → 项目/文件夹 → 聚合所有文件 + 标签 ──
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = (await loadConfig()) as AppConfig | null;
      // 主题（独立窗口需自行应用 data-theme）
      document.documentElement.setAttribute('data-theme', cfg?.theme === 'light' ? 'light' : 'dark');
      // 同步用户自定义数据根目录到 fileService
      setBaseDataDir(cfg?.baseDataDir);

      const projects = await loadProjectsList();
      registerProjectFolders(projects);          // 让 getProjectDataDir 解析「项目名-短ID」目录
      const folders = cfg?.assetFolders ?? [];

      // 聚合：每个项目目录 + 全局 file 目录 + 外部文件夹
      const [perProject, globalFiles, folderFiles] = await Promise.all([
        Promise.all(
          projects.map(async (p) => {
            const list = await listProjectFiles(p.id);
            return list.map<SearchEntry>((f) => ({
              ...f, source: 'project', projectId: p.id, projectName: p.name,
            }));
          }),
        ),
        listGlobalFiles(),
        listExternalFolderFiles(folders),
      ]);

      // 去重（按绝对路径）
      const seen = new Set<string>();
      const merged: SearchEntry[] = [];
      for (const f of [...perProject.flat(), ...globalFiles, ...folderFiles]) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        merged.push(f);
      }
      setFiles(merged);

      // 来源下拉项
      const opts: SourceOption[] = [{ key: 'all', label: '全部来源' }];
      for (const p of projects) opts.push({ key: `project:${p.id}`, label: p.name, group: '项目' });
      if (globalFiles.length > 0) opts.push({ key: 'global', label: '全局资产库', group: '其他' });
      for (const root of folders) opts.push({ key: `folder:${root}`, label: shortFolderName(root), group: '文件夹' });
      setSources(opts);

      // 标签
      try {
        const metas = await getAllAssetMeta();
        const map: Record<string, string[]> = {};
        for (const m of metas) if (m.tags?.length) map[m.path] = m.tags;
        setTagMap(map);
      } catch { /* ignore */ }
    } catch (err) {
      console.error('[AssetSearchWindow] 加载失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = '资源搜索';
    void prepareDragIcon(); // 预创建拖拽占位图，确保 dragstart 时可同步发起原生拖拽
    // 挂载时拉取数据（异步内部 setState，属合理的副作用数据获取）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, [loadAll]);

  // ── 添加文件 / 文件夹 ──
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const addWrapRef = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭「添加」菜单
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target as Node)) setAddMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [addMenuOpen]);

  const handleAddFiles = useCallback(async () => {
    setAddMenuOpen(false);
    setBusy(true);
    try {
      const n = await addAssetFilesToGlobal();
      if (n > 0) await loadAll();
    } catch (err) { console.error('[AssetSearchWindow] 添加文件失败:', err); }
    finally { setBusy(false); }
  }, [loadAll]);

  const handleAddFolder = useCallback(async () => {
    setAddMenuOpen(false);
    setBusy(true);
    try {
      const path = await pickAssetFolder();
      if (path) {
        const cfg = (await loadConfig()) as AppConfig | null;
        const folders = cfg?.assetFolders ?? [];
        if (!folders.includes(path)) {
          await saveConfig({ ...cfg, assetFolders: [...folders, path] });
          await loadAll();
        }
      }
    } catch (err) { console.error('[AssetSearchWindow] 添加文件夹失败:', err); }
    finally { setBusy(false); }
  }, [loadAll]);

  // 合并标签
  const taggedFiles = useMemo(
    () => files.map((f) => (tagMap[f.path] ? { ...f, tags: tagMap[f.path] } : f)),
    [files, tagMap],
  );

  // 来源筛选
  const sourceFiltered = useMemo(() => {
    if (activeSource === 'all') return taggedFiles;
    if (activeSource === 'global') return taggedFiles.filter((f) => f.source === 'global');
    if (activeSource.startsWith('project:')) {
      const id = activeSource.slice('project:'.length);
      return taggedFiles.filter((f) => f.source === 'project' && f.projectId === id);
    }
    if (activeSource.startsWith('folder:')) {
      const root = activeSource.slice('folder:'.length);
      return taggedFiles.filter((f) => f.source === 'folder' && f.folderRoot === root);
    }
    return taggedFiles;
  }, [taggedFiles, activeSource]);

  // 分类计数（基于来源筛选后的集合）
  const categoryCounts = useMemo(() => {
    const c: Record<FileCategory, number> = { image: 0, video: 0, audio: 0, text: 0, other: 0 };
    for (const f of sourceFiltered) c[f.category]++;
    return c;
  }, [sourceFiltered]);

  // 分类 + 搜索（名称 / 标签）
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return sourceFiltered.filter((f) => {
      if (activeCategory && f.category !== activeCategory) return false;
      if (q) {
        const inName = f.name.toLowerCase().includes(q);
        const inTags = (f.tags ?? []).some((t) => t.toLowerCase().includes(q));
        if (!inName && !inTags) return false;
      }
      return true;
    });
  }, [sourceFiltered, activeCategory, deferredSearch]);

  // 筛选条件变化时重置增量渲染计数（回到顶部）
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [activeSource, activeCategory, deferredSearch]);

  const visibleFiles = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  // 无限滚动哨兵
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        setVisibleCount((c) => (c < filtered.length ? c + PAGE_SIZE : c));
      }
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length, visibleFiles.length]);

  const handleReveal = useCallback((path: string) => {
    revealFileInFolder(path).catch(() => {});
  }, []);

  // 自绘标题栏：窗口控制（无系统边框）
  const minimizeWin = useCallback(() => {
    import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().minimize()).catch(() => {});
  }, []);
  const closeWin = useCallback(() => {
    import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().close()).catch(() => {});
  }, []);

  // 分组后的来源下拉
  const groupedSources = useMemo(() => {
    const flat = sources.filter((s) => !s.group);
    const groups = new Map<string, SourceOption[]>();
    for (const s of sources) {
      if (!s.group) continue;
      const arr = groups.get(s.group) ?? [];
      arr.push(s);
      groups.set(s.group, arr);
    }
    return { flat, groups: [...groups.entries()] };
  }, [sources]);

  return (
    <div className="asset-search-root">
      <div className="asset-search-header" data-tauri-drag-region>
        <h1 className="asset-search-title">资源搜索</h1>
        <span className="asset-search-total">{filtered.length} / {files.length}</span>
        <div className="asset-search-winctrls">
          <button type="button" className="asset-search-refresh" onClick={loadAll} disabled={loading} title="刷新">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button type="button" className="asset-search-winbtn" onClick={minimizeWin} aria-label="最小化" title="最小化">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="5" width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button type="button" className="asset-search-winbtn close" onClick={closeWin} aria-label="关闭" title="关闭">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </div>

      <div className="asset-search-toolbar">
        <div className="assets-search asset-search-input">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text" placeholder="搜索文件名或标签…" autoFocus
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="assets-search-clear" onClick={() => setSearch('')} aria-label="清空">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <select
          className="assets-project-select"
          value={activeSource}
          onChange={(e) => setActiveSource(e.target.value)}
          title="按项目 / 文件夹筛选"
        >
          {groupedSources.flat.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
          {groupedSources.groups.map(([group, opts]) => (
            <optgroup key={group} label={group}>
              {opts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </optgroup>
          ))}
        </select>

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
      </div>

      <div className="assets-category-row asset-search-cats">
        <button
          type="button" className={`assets-cat-chip ${activeCategory === null ? 'active' : ''}`}
          onClick={() => setActiveCategory(null)}
        >
          全部<span className="assets-cat-count">{sourceFiltered.length}</span>
        </button>
        {ALL_CATEGORIES.filter((cat) => categoryCounts[cat] > 0).map((cat) => (
          <button
            key={cat} type="button"
            className={`assets-cat-chip ${activeCategory === cat ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat)}
          >
            {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
            <span className="assets-cat-count">{categoryCounts[cat]}</span>
          </button>
        ))}
      </div>

      <div className="asset-search-scroll">
        {loading ? (
          <div className="assets-empty">
            <div className="assets-spinner asset-search-spinner" />
            <span>加载中…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="assets-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>{search || activeCategory || activeSource !== 'all' ? '没有匹配的文件' : '暂无文件'}</span>
          </div>
        ) : (
          <>
            <div className="asset-search-masonry">
              {visibleFiles.map((file) => (
                <SearchCard
                  key={file.path}
                  file={file}
                  onReveal={() => handleReveal(file.path)}
                  onDragStart={(e) => { e.preventDefault(); startAssetDrag(file); }}
                />
              ))}
            </div>
            {visibleCount < filtered.length && (
              <div ref={sentinelRef} className="assets-load-sentinel">加载更多…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── 单个搜索结果卡片 ── */
function SearchCard({ file, onReveal, onDragStart }: {
  file: SearchEntry;
  onReveal: () => void;
  onDragStart: (e: DragEvent) => void;
}) {
  const tags = file.tags ?? [];
  const sourceLabel = file.source === 'project'
    ? (file.projectName || '项目')
    : file.source === 'folder'
      ? shortFolderName(file.folderRoot || '')
      : '全局';
  return (
    <div className="assets-waterfall-card anim-card-in" draggable onDragStart={onDragStart} title="拖拽到主窗口画布以添加节点">
      <AssetThumb assetUrl={file.assetUrl} name={file.name} category={file.category} size={file.size} badge={sourceLabel}>
        <div className="assets-card-actions">
          <button type="button" className="assets-card-action-btn" title="在文件夹中显示" onClick={onReveal}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
        </div>
      </AssetThumb>
      {tags.length > 0 && (
        <div className="assets-card-tags">
          {tags.map((t) => <span key={t} className="assets-card-tag">{t}</span>)}
        </div>
      )}
      <div className="assets-card-name" title={file.name}>{file.name}</div>
    </div>
  );
}
