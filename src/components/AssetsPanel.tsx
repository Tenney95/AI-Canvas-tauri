/**
 * AssetsPanel 资产管理面板 — 浏览项目文件 + 永久保存的文件，支持分类筛选与文件操作
 * 使用 framer-motion 驱动面板、卡片、Toast 的进出场动画
 */
import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../store/useAppStore';
import {
  listProjectFiles,
  listPermanentFiles,
  saveAssetToPermanent,
  deletePermanentFile,
  extractFilesFromNodeData,
  CATEGORY_LABELS,
  type AssetFileEntry,
  type FileCategory,
} from '../services/fileService';

type TabKey = 'project' | 'permanent';

const ALL_CATEGORIES: FileCategory[] = ['image', 'video', 'audio', 'text', 'other'];

const CATEGORY_ICONS: Record<FileCategory, string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  text: '📄',
  other: '📁',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ============================================
   Framer-motion animation variants
   ============================================ */

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 350, damping: 30 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 20,
    transition: { duration: 0.15, ease: 'easeIn' as const },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.97 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      delay: i * 0.03,
      duration: 0.25,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  }),
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.12, ease: 'easeIn' as const },
  },
};

const toastVariants = {
  hidden: { opacity: 0, y: 12, scale: 0.92 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 400, damping: 25 } },
  exit: { opacity: 0, y: -8, scale: 0.92, transition: { duration: 0.15, ease: 'easeIn' as const } },
};

export default function AssetsPanel() {
  const assetsPanelOpen = useAppStore((s) => s.assetsPanelOpen);
  const setAssetsPanelOpen = useAppStore((s) => s.setAssetsPanelOpen);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const nodes = useAppStore((s) => s.nodes);

  const [activeTab, setActiveTab] = useState<TabKey>('project');
  const [activeCategory, setActiveCategory] = useState<FileCategory | null>(null);
  const [projectFiles, setProjectFiles] = useState<AssetFileEntry[]>([]);
  const [permanentFiles, setPermanentFiles] = useState<AssetFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Load files
  const loadFiles = useCallback(async () => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      if (activeTab === 'project') {
        // 1. Get files from disk listing
        const diskFiles = await listProjectFiles(currentProjectId);
        const knownPaths = new Set(diskFiles.map((f) => f.path));

        // 2. Scan every node for file references directly from node data (sync, no stat)
        const nodeEntries: AssetFileEntry[] = [];
        for (const node of nodes) {
          const entry = extractFilesFromNodeData(
            node.data as Record<string, unknown>,
          );
          if (entry && !knownPaths.has(entry.path)) {
            nodeEntries.push(entry);
            knownPaths.add(entry.path);
          }
        }

        // 3. Merge
        setProjectFiles([...diskFiles, ...nodeEntries]);
      } else {
        const files = await listPermanentFiles(currentProjectId);
        setPermanentFiles(files);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [currentProjectId, activeTab, nodes]);

  useEffect(() => {
    if (assetsPanelOpen) {
      loadFiles();
    }
  }, [assetsPanelOpen, loadFiles]);

  // Close on Escape
  useEffect(() => {
    if (!assetsPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAssetsPanelOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [assetsPanelOpen, setAssetsPanelOpen]);

  const handleClose = useCallback(() => {
    setAssetsPanelOpen(false);
  }, [setAssetsPanelOpen]);

  // Save to permanent
  const handleSavePermanent = useCallback(
    async (file: AssetFileEntry) => {
      if (!currentProjectId) return;
      const destPath = await saveAssetToPermanent(file, currentProjectId);
      if (destPath) {
        setToastMsg(`已保存: ${file.name}`);
        if (activeTab === 'permanent') {
          const files = await listPermanentFiles(currentProjectId);
          setPermanentFiles(files);
        }
      } else {
        setToastMsg('保存失败');
      }
      setTimeout(() => setToastMsg(null), 2000);
    },
    [currentProjectId, activeTab],
  );

  // Delete permanent file
  const handleDeletePermanent = useCallback(
    async (file: AssetFileEntry) => {
      await deletePermanentFile(file.path);
      setPermanentFiles((prev) => prev.filter((f) => f.path !== file.path));
      setToastMsg(`已删除: ${file.name}`);
      setTimeout(() => setToastMsg(null), 2000);
    },
    [],
  );

  // Switch tab
  const switchTab = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab);
      setActiveCategory(null);
    },
    [],
  );

  if (!assetsPanelOpen) return null;

  const files = activeTab === 'project' ? projectFiles : permanentFiles;
  const filteredFiles = activeCategory
    ? files.filter((f) => f.category === activeCategory)
    : files;

  // Count by category
  const categoryCounts: Record<FileCategory, number> = {
    image: 0, video: 0, audio: 0, text: 0, other: 0,
  };
  files.forEach((f) => { categoryCounts[f.category]++; });

  return (
    <AnimatePresence>
      {assetsPanelOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="assets-panel-backdrop"
            variants={backdropVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{ duration: 0.2 }}
            onClick={handleClose}
          />

          {/* Centering wrapper — avoids framer-motion transform clashing with CSS translate(-50%,-50%) */}
          <div className="assets-panel-wrapper">
            <motion.div
              className="assets-panel"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
            >
            {/* Header */}
            <div className="assets-panel-header">
              <h2 className="assets-panel-title">资产管理</h2>
              <motion.button
                type="button"
                className="assets-panel-close"
                onClick={handleClose}
                aria-label="关闭"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </motion.button>
            </div>

            {/* Tabs */}
            <div className="assets-tabs">
              {(['project', 'permanent'] as TabKey[]).map((tab) => (
                <motion.button
                  key={tab}
                  type="button"
                  className={`assets-tab ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => switchTab(tab)}
                  whileHover={{ scale: activeTab === tab ? 1 : 1.03 }}
                  whileTap={{ scale: 0.97 }}
                >
                  {tab === 'project' ? '项目文件' : '永久保存'}
                  <span className="assets-tab-count">
                    {tab === 'project' ? projectFiles.length : permanentFiles.length}
                  </span>
                </motion.button>
              ))}
            </div>

            {/* Category filters */}
            <div className="assets-category-row">
              <motion.button
                type="button"
                className={`assets-cat-chip ${activeCategory === null ? 'active' : ''}`}
                onClick={() => setActiveCategory(null)}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
              >
                全部
                <span className="assets-cat-count">{files.length}</span>
              </motion.button>
              {ALL_CATEGORIES.filter((cat) => categoryCounts[cat] > 0).map((cat) => (
                <motion.button
                  key={cat}
                  type="button"
                  className={`assets-cat-chip ${activeCategory === cat ? 'active' : ''}`}
                  onClick={() => setActiveCategory(cat)}
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                >
                  {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                  <span className="assets-cat-count">{categoryCounts[cat]}</span>
                </motion.button>
              ))}
            </div>

            {/* File waterfall */}
            <div className="assets-file-waterfall">
              {loading ? (
                <div className="assets-empty">
                  <motion.div
                    className="assets-spinner"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 0.6, ease: 'linear' }}
                  />
                  <span>加载中...</span>
                </div>
              ) : filteredFiles.length === 0 ? (
                <motion.div
                  className="assets-empty"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                  <span>
                    {activeTab === 'project' ? '暂无项目文件' : '暂无永久保存的文件'}
                  </span>
                </motion.div>
              ) : (
                <AnimatePresence mode="popLayout">
                  {filteredFiles.map((file, i) => (
                    <motion.div
                      key={file.path}
                      className="assets-waterfall-card"
                      variants={cardVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      custom={i % 12}
                      layout
                    >
                      {/* Thumbnail area */}
                      {file.assetUrl ? (
                        <div className="assets-card-img-wrap">
                          <img src={file.assetUrl} alt={file.name} className="assets-card-img" />
                          <span className="assets-card-size">{formatSize(file.size)}</span>
                          <div className="assets-card-actions">
                            {activeTab === 'project' ? (
                              <button
                                type="button"
                                className="assets-card-action-btn"
                                title="永久保存"
                                onClick={() => handleSavePermanent(file)}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                                </svg>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="assets-card-action-btn assets-card-delete"
                                title="删除"
                                onClick={() => handleDeletePermanent(file)}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="assets-card-icon-wrap">
                          <span className="assets-card-icon">{CATEGORY_ICONS[file.category]}</span>
                          <span className="assets-card-size">{formatSize(file.size)}</span>
                          <div className="assets-card-actions">
                            {activeTab === 'project' ? (
                              <button
                                type="button"
                                className="assets-card-action-btn"
                                title="永久保存"
                                onClick={() => handleSavePermanent(file)}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                                </svg>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="assets-card-action-btn assets-card-delete"
                                title="删除"
                                onClick={() => handleDeletePermanent(file)}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
            </div>

            {/* Toast */}
            <AnimatePresence>
              {toastMsg && (
                <motion.div
                  className="assets-toast"
                  variants={toastVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {toastMsg}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          </div>{/* /assets-panel-wrapper */}
        </>
      )}
    </AnimatePresence>
  );
}
