/**
 * OutputHistoryPanel — AI 输出历史记录底部抽屉面板
 * 从屏幕底部抬起，统一查看所有节点的生成历史
 *
 * 固定面板（config.outputHistoryPinned，写入配置、重启保留）：
 * - 固定后不再铺遮罩，面板缩成右下角小窗（避开底部工具栏），画布可继续交互；
 * - 固定时内容精简：无搜索框、无清空/导出页脚，记录变成单行摘要，
 *   保留「查看节点」按钮，点击按钮或整行都只定位节点、不关闭面板，悬停行尾可删除；
 * - 固定状态下 Esc 只收起面板，不关闭；未固定时点击遮罩或 Esc 直接关闭；
 * - 无论是否固定，都可以用标题栏的折叠按钮手动收起 / 展开面板主体。
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import type { OutputHistoryEntry } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import AnimatedButton from './shared/AnimatedButton';
import PopupCloseButton from './shared/PopupCloseButton';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauriEnv, saveAgentTextOutput } from '../services/fileService';

const EASE = [0.16, 1, 0.3, 1] as const;
type FilterType = 'all' | 'ai-text' | 'ai-image' | 'ai-video' | 'ai-audio';

const FILTER_OPTIONS: { key: FilterType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'ai-text', label: '文本' },
  { key: 'ai-image', label: '图像' },
  { key: 'ai-video', label: '视频' },
  { key: 'ai-audio', label: '音频' },
];



function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  const nowDate = new Date();
  if (d.getFullYear() === nowDate.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

/** Thumbnail with local-first fallback: tries convertFileSrc(filePath), falls back to online mediaUrl */
function HistoryThumbnail({
  mediaUrl,
  filePath,
  className = 'w-12 h-12',
}: {
  mediaUrl?: string;
  filePath?: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string>(() => {
    if (filePath) {
      try { return convertFileSrc(filePath); } catch { /* fall through */ }
    }
    return mediaUrl || '';
  });
  const [errored, setErrored] = useState(false);

  const handleError = useCallback(() => {
    if (!errored && mediaUrl && src !== mediaUrl) {
      setSrc(mediaUrl);
      setErrored(true);
    } else {
      // Both sources failed — hide element via parent
      setErrored(true);
    }
  }, [errored, mediaUrl, src]);

  if (!src) return null;

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className} rounded object-cover shrink-0`}
      onError={handleError}
      style={errored && src === mediaUrl ? { display: 'none' } : undefined}
    />
  );
}

/**
 * CompactHistoryRow — 固定面板右下角小窗里的精简记录行：
 * 一行缩略图 + 模型/时间 + 一行提示词，点击整行即定位节点，悬停出现删除。
 */
function CompactHistoryRow({
  entry,
  exists,
  onLocate,
  onDelete,
}: {
  entry: OutputHistoryEntry;
  exists: boolean;
  onLocate: (entry: OutputHistoryEntry) => void;
  onDelete: (entry: OutputHistoryEntry) => void;
}) {
  const typeCfg = NODE_TYPE_CONFIG[entry.nodeType];
  const isError = entry.status === 'error';
  const hasThumb = entry.nodeType === 'ai-image' && !isError && Boolean(entry.mediaUrl || entry.filePath);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onLocate(entry)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onLocate(entry);
        }
      }}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg border bg-canvas-surface/60 px-2.5 py-2 transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 ${
                    isError ? 'border-red-500/20' : 'border-canvas-border hover:border-canvas-border/80'
                  }`}
    >
      {hasThumb ? (
        <HistoryThumbnail mediaUrl={entry.mediaUrl} filePath={entry.filePath} className="w-9 h-9" />
      ) : (
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded ${
            typeCfg ? `${typeCfg.color} ${typeCfg.bg}` : 'text-canvas-text-muted bg-canvas-hover'
          }`}
        >
          <Icon icon={typeCfg?.icon || 'mdi:help-circle-outline'} width="16" height="16" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[10px] text-canvas-text-muted">
            {entry.provider}/{entry.model}
          </span>
          {isError && <span className="shrink-0 text-[10px] font-medium text-red-400">失败</span>}
          <span className="ml-auto shrink-0 text-[10px] text-canvas-text-muted tabular-nums">
            {formatRelativeTime(entry.timestamp)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] leading-4 text-canvas-text-secondary">
          {isError ? entry.error : entry.prompt || entry.output}
        </p>
        <span
          className={`mt-0.5 block truncate text-left text-[10px] ${
            exists ? 'text-indigo-400' : 'text-canvas-text-muted line-through'
          }`}
        >
          {exists ? `#${entry.nodeLabel}` : '节点已删除'}
        </span>
      </div>
      <button
        type="button"
        aria-label="查看节点"
        data-tooltip="查看节点"
        className="shrink-0 self-start rounded px-1.5 py-0.5 text-[10px] text-indigo-400
                   transition-colors hover:bg-indigo-500/10 hover:text-indigo-300"
        onClick={(e) => {
          e.stopPropagation();
          onLocate(entry);
        }}
      >
        查看节点
      </button>
      <button
        type="button"
        aria-label="删除"
        data-tooltip="删除"
        className="shrink-0 self-start rounded p-1 text-canvas-text-muted opacity-0 transition-[opacity,color,background-color]
                   hover:bg-red-500/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(entry);
        }}
      >
        <Icon icon="mdi:delete-outline" width="14" height="14" aria-hidden="true" />
      </button>
    </div>
  );
}

export default function OutputHistoryPanel() {
  const {
    outputHistoryRecords,
    historyTotalCount,
    historyHasMore,
    historyLoading,
    historyProjectId,
    currentProjectId,
    historyPanelOpen,
    setHistoryPanelOpen,
    loadHistoryFromDb,
    loadMoreHistoryFromDb,
    getHistoryForExport,
    deleteHistoryEntry,
    clearAllHistory,
    showToast,
    historyPinned,
    updateConfig,
    saveConfig,
  } = useAppStore(
    useShallow((s) => ({
      outputHistoryRecords: s.outputHistoryRecords,
      historyTotalCount: s.historyTotalCount,
      historyHasMore: s.historyHasMore,
      historyLoading: s.historyLoading,
      historyProjectId: s.historyProjectId,
      currentProjectId: s.currentProjectId,
      historyPanelOpen: s.historyPanelOpen,
      setHistoryPanelOpen: s.setHistoryPanelOpen,
      loadHistoryFromDb: s.loadHistoryFromDb,
      loadMoreHistoryFromDb: s.loadMoreHistoryFromDb,
      getHistoryForExport: s.getHistoryForExport,
      deleteHistoryEntry: s.deleteHistoryEntry,
      clearAllHistory: s.clearAllHistory,
      showToast: s.showToast,
      historyPinned: !!s.config.outputHistoryPinned,
      updateConfig: s.updateConfig,
      saveConfig: s.saveConfig,
    })),
  );

  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  /** 手动收起：只保留标题栏，方便固定时连续跳节点又不挡画布 */
  const [collapsed, setCollapsed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const togglePinned = useCallback(() => {
    updateConfig({ outputHistoryPinned: !historyPinned });
    void saveConfig({ silent: true });
  }, [historyPinned, saveConfig, updateConfig]);

  // Escape：固定时只收起面板主体，未固定时直接关闭
  useEffect(() => {
    if (!historyPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (historyPinned) {
        setCollapsed(true);
        return;
      }
      setHistoryPanelOpen(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [historyPanelOpen, historyPinned, setHistoryPanelOpen]);

  // Focus search on open
  useEffect(() => {
    if (historyPanelOpen && !collapsed) {
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [collapsed, historyPanelOpen]);

  const historyQuery = useMemo(() => ({
    nodeType: filter === 'all' ? undefined : filter,
    search: search.trim() || undefined,
  }), [filter, search]);

  useEffect(() => {
    if (!historyPanelOpen) return;
    const timer = window.setTimeout(() => {
      void loadHistoryFromDb(historyQuery);
      listRef.current?.scrollTo({ top: 0 });
    }, search.trim() ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [currentProjectId, historyPanelOpen, historyQuery, loadHistoryFromDb, search]);

  // Filter + search
  const filteredEntries = useMemo(() => {
    let list = historyProjectId === currentProjectId ? outputHistoryRecords : [];
    if (filter !== 'all') {
      list = list.filter((e) => e.nodeType === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (e) =>
          e.prompt.toLowerCase().includes(q) ||
          e.output.toLowerCase().includes(q) ||
          e.model.toLowerCase().includes(q) ||
          e.nodeLabel.toLowerCase().includes(q),
      );
    }
    return list;
  }, [currentProjectId, filter, historyProjectId, outputHistoryRecords, search]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!historyPanelOpen || !historyHasMore || historyLoading || !sentinel) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      void loadMoreHistoryFromDb(historyQuery);
    }, {
      root: listRef.current,
      rootMargin: '300px 0px',
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyHasMore, historyLoading, historyPanelOpen, historyQuery, loadMoreHistoryFromDb]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDeleteEntry = useCallback(
    (entry: OutputHistoryEntry) => {
      deleteHistoryEntry(entry.nodeId, entry.id);
    },
    [deleteHistoryEntry],
  );

  const handleClearAll = useCallback(() => {
    clearAllHistory();
    setConfirmClear(false);
    showToast('已清空全部历史记录');
  }, [clearAllHistory, showToast]);

  const handleLocateNode = useCallback(
    (entry: OutputHistoryEntry) => {
      const node = useAppStore.getState().nodes.find((n) => n.id === entry.nodeId);
      if (!node) {
        showToast('节点已不存在', 'error');
        return;
      }
      // Dispatch event for canvas to fit view to node（带一次放大回弹脉冲）
      const focusNode = () => {
        window.dispatchEvent(
          new CustomEvent('canvas-focus-node', {
            detail: { nodeId: entry.nodeId, pulse: true },
          }),
        );
      };
      // 固定面板时不关闭，方便连续查看多条记录对应的节点
      if (historyPinned) {
        focusNode();
        return;
      }
      setHistoryPanelOpen(false);
      setTimeout(focusNode, 300);
    },
    [historyPinned, setHistoryPanelOpen, showToast],
  );

  const handleCopy = useCallback(
    async (entry: OutputHistoryEntry) => {
      try {
        await navigator.clipboard.writeText(entry.output);
        showToast('已复制输出内容');
      } catch {
        showToast('复制失败', 'error');
      }
    },
    [showToast],
  );

  const handleExport = useCallback(async () => {
    try {
      const entries = await getHistoryForExport(historyQuery);
      const data = entries.map((e) => ({
        time: new Date(e.timestamp).toISOString(),
        node: e.nodeLabel,
        type: e.nodeType,
        model: `${e.provider}/${e.model}`,
        status: e.status,
        prompt: e.prompt,
        output: e.output,
        error: e.error,
      }));
      const json = JSON.stringify(data, null, 2);
      const fileName = `ai-output-history-${new Date().toISOString().slice(0, 10)}.json`;
      // Tauri 里 <a download> 不会弹保存对话框，文件悄悄落到「下载」目录，得走原生对话框
      if (isTauriEnv()) {
        const saved = await saveAgentTextOutput(json, fileName, '导出历史记录');
        if (!saved) return; // 用户取消
        showToast(`已导出历史记录到 ${saved.fileName}`);
        return;
      }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      showToast('已导出历史记录');
    } catch {
      showToast('导出历史记录失败', 'error');
    }
  }, [getHistoryForExport, historyQuery, showToast]);

  // Check if node still exists
  const nodeExists = useCallback(
    (nodeId: string) => useAppStore.getState().nodes.some((n) => n.id === nodeId),
    [],
  );

  return (
    <AnimatePresence>
      {historyPanelOpen && (
        <>
          {/* Backdrop — 固定面板时不铺遮罩，画布继续可交互 */}
          {!historyPinned && (
            <motion.div
              data-tauri-drag-region
              className="fixed inset-0 z-[240] bg-black/50 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setHistoryPanelOpen(false)}
            />
          )}

          {/* Bottom Sheet — 固定时缩成右下角小窗（避开底部工具栏），否则保持底部抽屉 */}
          <motion.div
            className={`z-[250] flex flex-col glass-panel shadow-2xl overflow-hidden ${
              historyPinned
                ? 'fixed bottom-14 right-3 w-[360px] max-h-[min(60vh,520px)] border rounded-2xl'
                : 'fixed inset-x-0 bottom-0 mx-auto w-full max-w-[720px] max-h-[75vh] border border-b-0 rounded-t-2xl'
            }`}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.3, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`flex items-center justify-between px-3 py-2 shrink-0 ${collapsed ? '' : 'border-b border-canvas-border'}`}>
              <div className="flex items-center gap-2.5">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-canvas-text-secondary">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <h2 className="text-sm font-semibold text-canvas-text">输出历史</h2>
                <span className="text-[11px] text-canvas-text-muted">共 {historyTotalCount} 条</span>
              </div>
              <div className="flex items-center gap-1.5">
                {/* 固定面板：跳转节点不再关闭面板 */}
                <label
                  className="flex items-center gap-1.5 cursor-pointer select-none"
                  data-tooltip={historyPinned ? '取消固定' : '固定后面板常驻，跳转节点不关闭'}
                >
                  <span className={`text-[11px] transition-colors ${historyPinned ? 'text-indigo-400' : 'text-canvas-text-muted'}`}>
                    固定面板
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={historyPinned}
                    aria-label="固定面板"
                    className="ui-switch"
                    onClick={togglePinned}
                  />
                </label>
                {/* 手动收起 / 展开 */}
                <AnimatedButton
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-canvas-text-muted
                             hover:bg-canvas-hover hover:text-canvas-text transition-colors"
                  aria-label={collapsed ? '展开面板' : '收起面板'}
                  aria-expanded={!collapsed}
                  data-tooltip={collapsed ? '展开' : '收起'}
                  onClick={() => setCollapsed((value) => !value)}
                >
                  <Icon icon={collapsed ? 'mdi:chevron-up' : 'mdi:chevron-down'} width="18" aria-hidden="true" />
                </AnimatedButton>
                <PopupCloseButton onClick={() => setHistoryPanelOpen(false)} />
              </div>
            </div>

            {/* 主体：可手动收起，收起后只保留标题栏 */}
            <motion.div
              className={`flex min-h-0 flex-col overflow-hidden ${collapsed ? 'pointer-events-none' : ''}`}
              initial={false}
              animate={{ height: collapsed ? 0 : 'auto' }}
              transition={{ duration: 0.24, ease: EASE }}
              aria-hidden={collapsed}
            >
            {/* Filter tabs + Search */}
            <div className="flex items-center gap-2 px-3 pt-3 pb-3 shrink-0">
              {FILTER_OPTIONS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`px-3 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0 ${
                    filter === key
                      ? 'bg-indigo-500/20 text-indigo-400'
                      : 'text-canvas-text-muted hover:text-canvas-text-secondary hover:bg-canvas-hover'
                  }`}
                  onClick={() => {
                    setFilter(key);
                    listRef.current?.scrollTo({ top: 0 });
                  }}
                >
                  {label}
                </button>
              ))}
              {/* 固定小窗里不放搜索框，保持精简 */}
              {!historyPinned && (
              <div className="relative w-[200px] ml-auto">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-canvas-text-muted"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    listRef.current?.scrollTo({ top: 0 });
                  }}
                  placeholder="搜索提示词、输出内容或模型..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-canvas-bg border border-canvas-border
                             text-[12px] text-canvas-text placeholder:text-canvas-text-muted
                             focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
                {search && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-canvas-text-muted hover:text-canvas-text"
                    onClick={() => {
                      setSearch('');
                      listRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
              )}
            </div>

            {/* Entry list */}
            <div ref={listRef} className="flex-1 overflow-y-auto px-3 pb-3">
              {filteredEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-canvas-text-muted">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <p className="text-[12px]">
                    {historyLoading
                      ? '正在加载历史记录...'
                      : historyTotalCount === 0
                        ? '暂无生成记录，开始第一次生成后会自动记录'
                        : '没有匹配的记录'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredEntries.map((entry) => {
                    // 固定小窗里用精简行：点击整行定位节点
                    if (historyPinned) {
                      return (
                        <CompactHistoryRow
                          key={entry.id}
                          entry={entry}
                          exists={nodeExists(entry.nodeId)}
                          onLocate={handleLocateNode}
                          onDelete={handleDeleteEntry}
                        />
                      );
                    }
                    const isExpanded = expandedIds.has(entry.id);
                    const exists = nodeExists(entry.nodeId);
                    const isText = entry.nodeType === 'ai-text';
                    const isImage = entry.nodeType === 'ai-image';
                    const isError = entry.status === 'error';
                    const typeCfg = NODE_TYPE_CONFIG[entry.nodeType];

                    return (
                      <motion.div
                        key={entry.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2 }}
                        className={`rounded-lg border bg-canvas-surface/60 transition-colors ${
                          isError
                            ? 'border-red-500/20'
                            : 'border-canvas-border hover:border-canvas-border/80'
                        }`}
                      >
                        {/* Top: meta row */}
                        <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
                          {/* Type badge */}
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              typeCfg ? `${typeCfg.color} ${typeCfg.bg}` : 'text-canvas-text-muted bg-canvas-hover'
                            }`}
                          >
                            <Icon icon={typeCfg?.icon || 'mdi:help-circle-outline'} width="12" height="12" />
                          </span>

                          {/* Model */}
                          <span className="text-[10px] text-canvas-text-muted bg-canvas-hover px-1.5 py-0.5 rounded">
                            {entry.provider}/{entry.model}
                          </span>

                          {/* Status */}
                          <span
                            className={`text-[10px] font-medium ${
                              isError ? 'text-red-400' : 'text-green-400'
                            }`}
                          >
                            {isError ? '❌ 失败' : '✅ 成功'}
                          </span>

                          <div className="flex-1" />

                          {/* Node link */}
                          <button
                            type="button"
                            disabled={!exists}
                            onClick={() => handleLocateNode(entry)}
                            className={`text-[10px] transition-colors ${
                              exists
                                ? 'text-indigo-400 hover:text-indigo-300 cursor-pointer'
                                : 'text-canvas-text-muted line-through cursor-default'
                            }`}
                          >
                            {exists ? `#${entry.nodeLabel}` : '节点已删除'}
                          </button>

                          {/* Time */}
                          <span className="text-[10px] text-canvas-text-muted tabular-nums">
                            {formatRelativeTime(entry.timestamp)}
                          </span>
                        </div>

                        {/* Prompt */}
                        <div className="px-3.5 pb-1.5">
                          <button
                            type="button"
                            className="w-full text-left text-[11px] text-canvas-text-secondary leading-relaxed hover:text-canvas-text transition-colors"
                            onClick={() => toggleExpand(entry.id)}
                          >
                            <span className="text-canvas-text-muted">提示词：</span>
                            {isExpanded ? entry.prompt : truncate(entry.prompt, 80)}
                          </button>
                        </div>

                        {/* Output preview */}
                        {!isError && (
                          <div className="px-3.5 pb-2">
                            {isText ? (
                              <div className="rounded-lg bg-canvas-bg/60 px-3 py-2 max-h-24 overflow-y-auto text-[11px] text-canvas-text-secondary leading-relaxed">
                                <span>{truncate(entry.output, 150)}</span>
                              </div>
                            ) : (
                              <div className={`rounded-lg bg-canvas-bg/60 p-2 ${isImage && entry.mediaUrl ? 'flex items-start gap-2.5' : 'space-y-1.5'}`}>
                                {/* Image thumbnail — local file first, online URL fallback */}
                                {isImage && (entry.mediaUrl || entry.filePath) && (
                                  <HistoryThumbnail
                                    mediaUrl={entry.mediaUrl}
                                    filePath={entry.filePath}
                                  />
                                )}
                                <div className="min-w-0 space-y-1">
                                  {/* Online URL */}
                                  {entry.mediaUrl && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] text-canvas-text-muted shrink-0">线上：</span>
                                      <span className="text-[10px] text-canvas-text-secondary truncate">{entry.mediaUrl}</span>
                                      <button
                                        type="button"
                                        className="shrink-0 w-4 h-4 rounded text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover flex items-center justify-center transition-colors"
                                        onClick={() => {
                                          navigator.clipboard.writeText(entry.mediaUrl!).then(
                                            () => showToast('已复制线上地址'),
                                            () => showToast('复制失败', 'error'),
                                          );
                                        }}
                                      >
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                      </button>
                                    </div>
                                  )}
                                  {/* Local file path */}
                                  {entry.filePath && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] text-canvas-text-muted shrink-0">本地：</span>
                                      <span className="text-[10px] text-canvas-text-secondary truncate font-mono">{entry.filePath}</span>
                                      <button
                                        type="button"
                                        className="shrink-0 w-4 h-4 rounded text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover flex items-center justify-center transition-colors"
                                        onClick={() => {
                                          navigator.clipboard.writeText(entry.filePath!).then(
                                            () => showToast('已复制本地路径'),
                                            () => showToast('复制失败', 'error'),
                                          );
                                        }}
                                      >
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                      </button>
                                    </div>
                                  )}
                                  {/* Fallback: output text */}
                                  {!entry.mediaUrl && !entry.filePath && (
                                    <span className="text-[10px] text-canvas-text-muted">
                                      {entry.output || '无预览'}
                                    </span>
                                  )}
                                  {/* Params */}
                                  {entry.params && (
                                    <span className="text-[10px] text-canvas-text-muted">
                                      {String(entry.params.imageSize || '')} {String(entry.params.aspectRatio || '')}
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Error message */}
                        {isError && entry.error && (
                          <div className="px-3.5 pb-2">
                            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-1.5 text-[11px] text-red-400">
                              {entry.error}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-1 px-3.5 pb-3">
                          {!isError && isText && (
                            <AnimatedButton
                              className="text-[10px] px-2 py-1 rounded-md text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover transition-colors"
                              onClick={() => handleCopy(entry)}
                            >
                              复制输出
                            </AnimatedButton>
                          )}
                          {!isError && (
                            <AnimatedButton
                              className="text-[10px] px-2 py-1 rounded-md text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover transition-colors"
                              onClick={() => handleLocateNode(entry)}
                            >
                              查看节点
                            </AnimatedButton>
                          )}
                          <div className="flex-1" />
                          <AnimatedButton
                            className="text-[10px] px-2 py-1 rounded-md text-canvas-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            onClick={() => handleDeleteEntry(entry)}
                          >
                            删除
                          </AnimatedButton>
                        </div>
                      </motion.div>
                    );
                  })}
                  {historyHasMore && (
                    <div ref={sentinelRef} className="h-1 w-full" aria-hidden="true" />
                  )}
                </div>
              )}
            </div>

            {/* Footer — 固定小窗不放清空/导出 */}
            {!historyPinned && historyTotalCount > 0 && (
              <div className="flex items-center justify-between px-3 py-3 border-t border-canvas-border shrink-0 bg-canvas-surface/80">
                {confirmClear ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-canvas-text-secondary">确认清空全部历史？</span>
                    <AnimatedButton
                      className="text-[11px] px-2.5 py-1 rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                      onClick={handleClearAll}
                    >
                      确认清空
                    </AnimatedButton>
                    <AnimatedButton
                      className="text-[11px] px-2.5 py-1 rounded-md text-canvas-text-muted hover:text-canvas-text hover:bg-canvas-hover transition-colors"
                      onClick={() => setConfirmClear(false)}
                    >
                      取消
                    </AnimatedButton>
                  </div>
                ) : (
                  <AnimatedButton
                    className="text-[11px] px-2.5 py-1 rounded-md text-canvas-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    onClick={() => setConfirmClear(true)}
                  >
                    清空全部历史
                  </AnimatedButton>
                )}
                <AnimatedButton
                  className="text-[11px] px-2.5 py-1 rounded-md text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10 transition-colors"
                  onClick={handleExport}
                  disabled={filteredEntries.length === 0}
                >
                  导出 JSON
                </AnimatedButton>
              </div>
            )}
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
