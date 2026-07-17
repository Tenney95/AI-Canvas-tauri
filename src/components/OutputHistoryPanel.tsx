/**
 * OutputHistoryPanel — AI 输出历史记录底部抽屉面板
 * 从屏幕底部抬起，统一查看所有节点的生成历史
 */
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import type { OutputHistoryEntry } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import AnimatedButton from './shared/AnimatedButton';
import { convertFileSrc } from '@tauri-apps/api/core';

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
function HistoryThumbnail({ mediaUrl, filePath }: { mediaUrl?: string; filePath?: string }) {
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
      className="w-12 h-12 rounded object-cover shrink-0"
      onError={handleError}
      style={errored && src === mediaUrl ? { display: 'none' } : undefined}
    />
  );
}

export default function OutputHistoryPanel() {
  const {
    outputHistoryRecords,
    historyPanelOpen,
    setHistoryPanelOpen,
    deleteHistoryEntry,
    clearAllHistory,
    showToast,
  } = useAppStore(
    useShallow((s) => ({
      outputHistoryRecords: s.outputHistoryRecords,
      historyPanelOpen: s.historyPanelOpen,
      setHistoryPanelOpen: s.setHistoryPanelOpen,
      deleteHistoryEntry: s.deleteHistoryEntry,
      clearAllHistory: s.clearAllHistory,
      showToast: s.showToast,
    })),
  );

  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Escape to close
  useEffect(() => {
    if (!historyPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHistoryPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [historyPanelOpen, setHistoryPanelOpen]);

  // Focus search on open
  useEffect(() => {
    if (historyPanelOpen) {
      setTimeout(() => searchRef.current?.focus(), 100);
    }
  }, [historyPanelOpen]);

  // History entries stored independently from nodes — deleting a node won't lose records
  const allEntries = useMemo(() => {
    return [...outputHistoryRecords].sort((a, b) => b.timestamp - a.timestamp);
  }, [outputHistoryRecords]);

  // Filter + search
  const filteredEntries = useMemo(() => {
    let list = allEntries;
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
  }, [allEntries, filter, search]);

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
      setHistoryPanelOpen(false);
      // Dispatch event for canvas to fit view to node
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('canvas-focus-node', {
            detail: { nodeId: entry.nodeId },
          }),
        );
      }, 300);
    },
    [setHistoryPanelOpen, showToast],
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

  const handleExport = useCallback(() => {
    const data = filteredEntries.map((e) => ({
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
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-output-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出历史记录');
  }, [filteredEntries, showToast]);

  // Check if node still exists
  const nodeExists = useCallback(
    (nodeId: string) => useAppStore.getState().nodes.some((n) => n.id === nodeId),
    [],
  );

  return (
    <AnimatePresence>
      {historyPanelOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-[240] bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setHistoryPanelOpen(false)}
          />

          {/* Bottom Sheet */}
          <motion.div
            className="fixed inset-x-0 bottom-0 z-[250] mx-auto w-full max-w-[720px] max-h-[75vh] flex flex-col
                       glass-panel border border-b-0 rounded-t-2xl shadow-2xl overflow-hidden"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.3, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-canvas-border shrink-0">
              <div className="flex items-center gap-2.5">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-canvas-text-secondary">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <h2 className="text-sm font-semibold text-canvas-text">输出历史</h2>
                <span className="text-[11px] text-canvas-text-muted">共 {allEntries.length} 条</span>
              </div>
              <button
                type="button"
                className="w-7 h-7 rounded-lg hover:bg-canvas-hover flex items-center justify-center text-canvas-text-secondary hover:text-canvas-text transition-colors"
                onClick={() => setHistoryPanelOpen(false)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

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
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
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
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索提示词、输出内容或模型..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-canvas-bg border border-canvas-border
                             text-[12px] text-canvas-text placeholder:text-canvas-text-muted
                             focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
                {search && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-canvas-text-muted hover:text-canvas-text"
                    onClick={() => setSearch('')}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Entry list */}
            <div className="flex-1 overflow-y-auto px-3 pb-3">
              {filteredEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-canvas-text-muted">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <p className="text-[12px]">
                    {allEntries.length === 0 ? '暂无生成记录，开始第一次生成后会自动记录' : '没有匹配的记录'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredEntries.map((entry) => {
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
                        className={`rounded-xl border bg-canvas-surface/60 transition-colors ${
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
                </div>
              )}
            </div>

            {/* Footer */}
            {allEntries.length > 0 && (
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
        </>
      )}
    </AnimatePresence>
  );
}
