/**
 * AssetsPanel 资产管理面板 — 浏览项目文件 + 永久保存的文件，支持分类筛选与文件操作
 */
import { useState, useEffect, useCallback } from 'react';
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
    <>
      {/* Backdrop */}
      <div
        className="assets-panel-backdrop"
        onMouseDown={handleClose}
      />

      {/* Panel */}
      <div className="assets-panel" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="assets-panel-header">
          <h2 className="assets-panel-title">资产管理</h2>
          <button
            type="button"
            className="assets-panel-close"
            onClick={handleClose}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="assets-tabs">
          <button
            type="button"
            className={`assets-tab ${activeTab === 'project' ? 'active' : ''}`}
            onClick={() => switchTab('project')}
          >
            项目文件
            <span className="assets-tab-count">{projectFiles.length}</span>
          </button>
          <button
            type="button"
            className={`assets-tab ${activeTab === 'permanent' ? 'active' : ''}`}
            onClick={() => switchTab('permanent')}
          >
            永久保存
            <span className="assets-tab-count">{permanentFiles.length}</span>
          </button>
        </div>

        {/* Category filters */}
        <div className="assets-category-row">
          <button
            type="button"
            className={`assets-cat-chip ${activeCategory === null ? 'active' : ''}`}
            onClick={() => setActiveCategory(null)}
          >
            全部
            <span className="assets-cat-count">{files.length}</span>
          </button>
          {ALL_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`assets-cat-chip ${activeCategory === cat ? 'active' : ''}`}
              disabled={categoryCounts[cat] === 0}
              onClick={() => setActiveCategory(cat)}
            >
              {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
              <span className="assets-cat-count">{categoryCounts[cat]}</span>
            </button>
          ))}
        </div>

        {/* File list */}
        <div className="assets-file-list">
          {loading ? (
            <div className="assets-empty">
              <div className="assets-spinner" />
              <span>加载中...</span>
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="assets-empty">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <span>
                {activeTab === 'project' ? '暂无项目文件' : '暂无永久保存的文件'}
              </span>
            </div>
          ) : (
            filteredFiles.map((file) => (
              <div key={file.path} className="assets-file-item">
                {/* Thumbnail / icon */}
                <div className="assets-file-thumb">
                  {file.assetUrl ? (
                    <img src={file.assetUrl} alt={file.name} className="assets-file-img" />
                  ) : (
                    <span className="assets-file-icon">{CATEGORY_ICONS[file.category]}</span>
                  )}
                </div>
                {/* Info */}
                <div className="assets-file-info">
                  <span className="assets-file-name" title={file.name}>{file.name}</span>
                  <span className="assets-file-meta">
                    <span className={`assets-file-cat-tag cat-${file.category}`}>
                      {CATEGORY_LABELS[file.category]}
                    </span>
                    {formatSize(file.size)}
                  </span>
                </div>
                {/* Actions */}
                <div className="assets-file-actions">
                  {activeTab === 'project' ? (
                    <button
                      type="button"
                      className="assets-action-btn assets-action-save"
                      data-tooltip="永久保存"
                      onClick={() => handleSavePermanent(file)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                      </svg>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="assets-action-btn assets-action-delete"
                      data-tooltip="删除"
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
            ))
          )}
        </div>

        {/* Toast */}
        {toastMsg && (
          <div className="assets-toast">{toastMsg}</div>
        )}
      </div>
    </>
  );
}
