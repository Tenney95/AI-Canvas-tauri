/**
 * ConnectedNodesPreview — 已连线节点内容缩略图条
 * 显示在 PromptPanel 上方，展示所有 predecessor 节点的输出缩略图，
 * 点击可快速 @提及 对应节点。
 *
 * 宫格分镜节点特殊处理：缩略图条中只显示一张主图，hover 后在上方弹出按宫格
 * 位置排列的各格 Sprite 缩略图网格，点击某格引用对应格子。
 */
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/useAppStore';
import type { BaseNodeData, StoryboardCellOverride } from '../../../types';
import { useT } from '../../../i18n';
import FullscreenOverlay from '../../shared/FullscreenOverlay';
import {
  calculateDockOffset,
  createConnectedPreviewLongPressController,
} from './connectedNodesPreviewInteractions';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
function localAssetUrl(filePath?: string): string | undefined {
  if (!filePath || !IS_TAURI) return undefined;
  try { return convertFileSrc(filePath); } catch { return undefined; }
}

interface ConnectedNodesPreviewProps {
  nodeId?: string;
  onInsertMention?: (mentionStr: string) => void;
  hoverEmphasis?: 'default' | 'expanded';
}

const OUTPUT_TYPE_ICON: Record<string, string> = {
  image: '🖼', video: '🎬', audio: '🎵', text: 'T', shotlist: '▦',
};

/** 单格 Sprite 信息：用于 hover 弹出的宫格网格渲染 */
interface SbCellItem {
  idx: number;
  r: number; c: number;
  label: string;
  mentionId: string;
  /** 单元格 Sprite 背景样式（使用主图 + background-position/background-size 定位） */
  bgStyle: React.CSSProperties;
  /** 若有覆盖图，直接用它（不参与 Sprite） */
  overrideUrl?: string;
}

interface FullscreenPreviewItem {
  id: string;
  label: string;
  displayId?: number;
  outputType: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  previewText?: string;
}

export default function ConnectedNodesPreview({
  nodeId,
  onInsertMention,
  hoverEmphasis = 'default',
}: ConnectedNodesPreviewProps) {
  const t = useT();
  // 只订阅画布数据：对话框打开期间的聊天流式、轮询进度等无关变更不再触发重渲染
  const { nodes, edges } = useAppStore(
    useShallow((s) => ({ nodes: s.nodes, edges: s.edges })),
  );
  const hoveredMentionNodeId = useAppStore((s) => s.hoveredMentionNodeId);
  const [fullscreenPreview, setFullscreenPreview] = useState<FullscreenPreviewItem | null>(null);
  const [suppressClickNodeId, setSuppressClickNodeId] = useState<string | null>(null);

  // ── 宫格弹出浮层状态 ──
  const [sbPopupId, setSbPopupId] = useState<string | null>(null);
  const [sbThumbRect, setSbThumbRect] = useState<DOMRect | null>(null);
  const sbCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPopupDelayed = useCallback(() => {
    sbCloseTimer.current = setTimeout(() => setSbPopupId(null), 120);
  }, [setSbPopupId]);
  const cancelCloseTimer = useCallback(() => {
    if (sbCloseTimer.current) { clearTimeout(sbCloseTimer.current); sbCloseTimer.current = null; }
  }, []);
  useEffect(() => () => { if (sbCloseTimer.current) clearTimeout(sbCloseTimer.current); }, []);

  const connectedNodes = useMemo(() => {
    if (!nodeId) return [];
    const me = nodes.find((n) => n.id === nodeId);
    const rawSourceIds = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.source));
    if (me?.parentId) {
      edges.filter((e) => e.target === me.parentId).forEach((e) => rawSourceIds.add(e.source));
    }
    const sourceIds = new Set<string>();
    for (const sid of rawSourceIds) {
      const sn = nodes.find((n) => n.id === sid);
      if (sn?.type === 'group') {
        nodes.filter((n) => n.parentId === sid).forEach((c) => sourceIds.add(c.id));
      } else {
        sourceIds.add(sid);
      }
    }
    return nodes
      .filter((n) => n.id !== nodeId && n.type !== 'group' && sourceIds.has(n.id))
      .map((n) => {
        const data = n.data as BaseNodeData;
        // 分镜表没有 output/媒体，落到 text 分支就只剩一个「T」，和文本节点分不开
        const isShotlist = data.type === 'ai-shotlist';
        const shotCount = isShotlist ? ((data.shotlistRows as unknown[] | undefined)?.length ?? 0) : 0;
        const isDirector = data.type === 'ai-director' || n.type === 'ai-director';
        const directorThumb = isDirector
          ? ((data.imageUrl as string | undefined)
            || (Array.isArray(data.directorCaptureUrls) ? (data.directorCaptureUrls as string[])[0] : undefined))
          : undefined;
        const outputType = isShotlist
          ? 'shotlist'
          : (data.imageUrl || directorThumb)
          ? 'image' : data.videoUrl ? 'video' : data.audioUrl ? 'audio' : 'text';
        const thumbnailUrl = outputType === 'image'
          ? (localAssetUrl(data.filePath as string | undefined) || (data.thumbnailUrl as string) || data.imageUrl || directorThumb || undefined)
          : outputType === 'video'
          ? ((data.thumbnailUrl as string) || undefined) : undefined;
        const previewText = data.output ? String(data.output) : undefined;
        const textSnippet = outputType === 'text' && previewText
          ? previewText.slice(0, 50) : undefined;
        const mediaUrl = outputType === 'image'
          ? (localAssetUrl(data.filePath as string | undefined) || data.imageUrl || directorThumb || thumbnailUrl)
          : outputType === 'video'
            ? (data.videoUrl as string | undefined)
            : outputType === 'audio'
              ? (data.audioUrl as string | undefined)
              : undefined;

        // 宫格分镜：收集各格 Sprite 信息
        let sbCells: SbCellItem[] | undefined;
        let sbCols: number | undefined;
        let sbRows: number | undefined;
        if (data.type === 'ai-storyboard') {
          const cols = Math.max(1, (data.storyboardCols as number) || 3);
          const rows = Math.max(1, (data.storyboardRows as number) || 3);
          sbCols = cols; sbRows = rows;
          const extracted = (data.storyboardExtracted as boolean[] | undefined) ?? [];
          const overrides = (data.storyboardOverrides as (StoryboardCellOverride | null)[] | undefined) ?? [];
          const isCustomGrid = ((data.storyboardRowPositions as number[] | undefined)?.length || 0) > 0
            || ((data.storyboardColPositions as number[] | undefined)?.length || 0) > 0;
          const hRanges = isCustomGrid ? [0, ...((data.storyboardRowPositions as number[]) ?? []), 100] : [];
          const vRanges = isCustomGrid ? [0, ...((data.storyboardColPositions as number[]) ?? []), 100] : [];

          sbCells = [];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const idx = r * cols + c;
              if (extracted[idx] && !overrides[idx]) continue;
              const override = overrides[idx];

              // Sprite 背景定位：以 background-size 放大到只显示该格区域，再用百分比偏移对齐
              let bgStyle: React.CSSProperties = {};
              if (!override) {
                const leftPct = isCustomGrid ? vRanges[c] : (c / cols) * 100;
                const topPct = isCustomGrid ? hRanges[r] : (r / rows) * 100;
                const cellW = isCustomGrid ? vRanges[c + 1] - vRanges[c] : (100 / cols);
                const cellH = isCustomGrid ? hRanges[r + 1] - hRanges[r] : (100 / rows);
                bgStyle = {
                  backgroundSize: `${(100 / cellW) * 100}% ${(100 / cellH) * 100}%`,
                  backgroundPosition: `${leftPct * 100 / (100 - cellW)}% ${topPct * 100 / (100 - cellH)}%`,
                };
              }

              sbCells.push({
                idx, r, c,
                label: t('第{row}行{col}列', { row: r + 1, col: c + 1 }),
                mentionId: `${n.id}/cell/${idx}`,
                bgStyle,
                overrideUrl: override?.url,
              });
            }
          }
        }

        return {
          id: n.id,
          label: data.label || t('节点'),
          displayId: data.displayId,
          outputType,
          thumbnailUrl,
          textSnippet,
          previewText,
          mediaUrl,
          shotCount,
          hasOutput: isShotlist ? shotCount > 0 : !!data.output,
          nodeType: data.type,
          status: data.status,
          sbCells,
          sbCols,
          sbRows,
        };
      });
  }, [nodeId, nodes, edges, t]);

  // ── Dock 动效状态 ──
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const onHoverStart = useCallback((idx: number) => setHoverIndex(idx), []);
  const onHoverEnd = useCallback(() => setHoverIndex(null), []);
  const [longPressController] = useState(() => (
    createConnectedPreviewLongPressController<FullscreenPreviewItem>((item) => {
      setSuppressClickNodeId(item.id);
      setHoverIndex(null);
      setFullscreenPreview(item);
    })
  ));
  useEffect(() => () => longPressController.dispose(), [longPressController]);

  if (connectedNodes.length === 0) return null;

  const handleClick = (nodeId: string, label: string) => {
    onInsertMention?.(`@{${nodeId}:${label}}`);
  };

  const externalIndex = hoveredMentionNodeId
    ? connectedNodes.findIndex((n) => n.id === hoveredMentionNodeId || n.sbCells?.some((c) => c.mentionId === hoveredMentionNodeId))
    : -1;
  const effectiveHover = hoverIndex !== null ? hoverIndex : (externalIndex >= 0 ? externalIndex : null);

  const isExpandedEmphasis = hoverEmphasis === 'expanded';
  const maxScale = isExpandedEmphasis ? 2.5 : 1.22;
  const nearScale = isExpandedEmphasis ? 1.16 : 1.10;
  const getDockScale = (index: number): number => {
    if (hoverIndex === null) return 1;
    const d = Math.abs(index - hoverIndex);
    if (d === 0) return maxScale; if (d === 1) return nearScale; return 1;
  };
  const getDockX = (index: number): number => {
    if (hoverIndex === null) return 0;
    if (isExpandedEmphasis) {
      return calculateDockOffset(index, hoverIndex, maxScale, nearScale);
    }
    const delta = index - hoverIndex;
    const d = Math.abs(delta);
    if (d === 0) return 0; if (d === 1) return delta * 12; if (d === 2) return delta * 5; return 0;
  };

  return (
    <div className="connected-nodes-float">
      <div className="connected-nodes-strip">
        {connectedNodes.map((node, idx) => {
          const scale = getDockScale(idx);
          const x = getDockX(idx);
          const isHovered = effectiveHover === idx;
          const isStoryboard = node.nodeType === 'ai-storyboard';
          const isShotlist = node.nodeType === 'ai-shotlist';
          const canFullscreen = Boolean(node.mediaUrl || node.thumbnailUrl || node.previewText);
          const tooltipLabel = `${node.label}${node.displayId != null ? ` #${node.displayId}` : ''}`;
          const tooltipAction = canFullscreen
            ? `${t('点击引用')} · ${t('长按全屏显示')}`
            : t('点击引用');

          return (
          <motion.button
            key={node.id}
            type="button"
            className={`connected-node-thumb ${!node.hasOutput ? 'thumb-idle' : ''} thumb-${node.outputType}${isStoryboard ? ' thumb-storyboard' : ''}${isShotlist ? ' thumb-shotlist' : ''}${isExpandedEmphasis ? ' origin-bottom' : ''}`}
            data-tooltip={`${tooltipLabel} — ${tooltipAction}`}
            data-tooltip-label={`${tooltipLabel} —`}
            data-tooltip-action={tooltipAction}
            onClick={() => {
              if (suppressClickNodeId === node.id) {
                setSuppressClickNodeId(null);
                return;
              }
              handleClick(node.id, node.label);
            }}
            onHoverStart={() => onHoverStart(idx)}
            onHoverEnd={onHoverEnd}
            onPointerDown={(event) => {
              if (!canFullscreen) return;
              if (longPressController.start(node, event)) {
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            }}
            onPointerMove={(event) => longPressController.move(event)}
            onPointerUp={(event) => {
              longPressController.end(event.pointerId);
              window.setTimeout(() => {
                setSuppressClickNodeId((current) => current === node.id ? null : current);
              }, 0);
            }}
            onPointerCancel={(event) => longPressController.end(event.pointerId)}
            onLostPointerCapture={longPressController.cancel}
            onContextMenu={(event) => { if (canFullscreen) event.preventDefault(); }}
            onMouseEnter={(e) => { if (isStoryboard) { cancelCloseTimer(); setSbPopupId(node.id); setSbThumbRect(e.currentTarget.getBoundingClientRect()); } }}
            onMouseLeave={() => { if (isStoryboard) clearPopupDelayed(); }}
            animate={{
              scale, x, y: isHovered && !isExpandedEmphasis ? -4 : 0,
              opacity: isHovered ? 1 : 0.85,
              boxShadow: isHovered ? `0 6px 20px rgba(99,102,241,0.25), 0 0 0 2px rgba(99,102,241,0.35)` : `0 0 0 0px rgba(99,102,241,0)`,
              borderColor: isHovered ? 'rgba(99,102,241,0.6)' : 'rgba(195,195,202,0.33)',
            }}
            whileTap={{ scale: scale * 0.92 }}
            transition={{ type: 'spring', stiffness: 350, damping: 20, mass: 0.7 }}
          >
            {/* 缩略图内容 */}
            {node.outputType === 'image' && node.thumbnailUrl ? (
              <img src={node.thumbnailUrl} alt={node.label} className="thumb-img" loading="lazy" />
            ) : node.outputType === 'video' && node.thumbnailUrl ? (
              <div className="thumb-video-wrap">
                <img src={node.thumbnailUrl} alt={node.label} className="thumb-img" loading="lazy" />
                <span className="thumb-play-icon">▶</span>
              </div>
            ) : node.outputType === 'text' && node.textSnippet ? (
              <span className="thumb-text">{node.textSnippet}</span>
            ) : (
              <span className={`thumb-icon thumb-icon-${node.outputType}`}>{OUTPUT_TYPE_ICON[node.outputType] || '?'}</span>
            )}

            {/* 宫格分镜角标 */}
            {isStoryboard && node.sbCells && (
              <span className="thumb-sb-badge">{node.sbCells.length}</span>
            )}

            {/* 分镜表角标：镜头数 */}
            {isShotlist && node.shotCount > 0 && (
              <span className="thumb-shot-badge">{node.shotCount}</span>
            )}

            {node.status === 'loading' && (
              <div className="thumb-loading"><span className="thumb-spinner" /></div>
            )}
          </motion.button>
        )})}
      </div>

      {/* 宫格弹出浮层 — Portal 到 body */}
      {createPortal(
        <AnimatePresence>
          {sbPopupId !== null && (() => {
            const sbNode = connectedNodes.find((n) => n.id === sbPopupId);
            if (!sbNode?.sbCells) return null;
            const rect = sbThumbRect;
            // 外层 div 负责定位（translate 不受 framer-motion 干扰），内层 motion.div 只管动效
            const anchorStyle: React.CSSProperties = rect
              ? { left: `${rect.left + rect.width / 2}px`, top: `${rect.top - 8}px`, transform: 'translate(-50%, -100%)' }
              : { bottom: 72, left: '50%', transform: 'translateX(-50%)' };

            return (
              <div className="sb-cell-anchor" style={anchorStyle} onMouseEnter={cancelCloseTimer} onMouseLeave={() => { setSbPopupId(null); }}>
                <motion.div
                  key={`sb-popup-${sbPopupId}`}
                  className="sb-cell-popup"
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.96 }}
                  transition={{ duration: 0.18 }}
                >
                <div className="sb-cell-grid" style={{ gridTemplateColumns: `repeat(${sbNode.sbCols}, 1fr)` }}>
                  {sbNode.sbCells.map((cell) => (
                    <button
                      key={cell.idx}
                      type="button"
                      className="sb-cell-item"
                      title={`${sbNode.label} · ${cell.label}`}
                      onClick={(e) => { e.stopPropagation(); handleClick(cell.mentionId, `${sbNode.label} · ${cell.label}`); }}
                    >
                      {cell.overrideUrl ? (
                        <img src={cell.overrideUrl} alt={cell.label} className="sb-cell-img" />
                      ) : sbNode.thumbnailUrl ? (
                        <div
                          className="sb-cell-sprite"
                          style={{
                            backgroundImage: `url(${sbNode.thumbnailUrl})`,
                            ...cell.bgStyle,
                          }}
                        />
                      ) : (
                        <span className="sb-cell-placeholder">{cell.r + 1},{cell.c + 1}</span>
                      )}
                      <span className="sb-cell-label">{cell.label}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
              </div>
            );
          })()}
        </AnimatePresence>,
        document.body,
      )}

      <FullscreenOverlay
        isOpen={fullscreenPreview !== null}
        onClose={() => setFullscreenPreview(null)}
        hidePanel
        title={fullscreenPreview?.label}
      >
        {fullscreenPreview && (
          <div
            className="fixed inset-0 flex flex-col items-center justify-center gap-4 px-10 py-12"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-2xl">
              {fullscreenPreview.outputType === 'image' && (fullscreenPreview.mediaUrl || fullscreenPreview.thumbnailUrl) ? (
                <img
                  src={fullscreenPreview.mediaUrl || fullscreenPreview.thumbnailUrl}
                  alt={fullscreenPreview.label}
                  className="max-h-full max-w-full select-none rounded-2xl object-contain shadow-2xl"
                  draggable={false}
                />
              ) : fullscreenPreview.outputType === 'video' && fullscreenPreview.mediaUrl ? (
                <video
                  src={fullscreenPreview.mediaUrl}
                  className="max-h-full max-w-full rounded-2xl bg-black shadow-2xl"
                  controls
                  autoPlay
                />
              ) : fullscreenPreview.outputType === 'audio' && fullscreenPreview.mediaUrl ? (
                <div className="flex w-full max-w-xl flex-col items-center gap-5 rounded-2xl border border-canvas-border bg-canvas-surface/90 p-8 shadow-2xl backdrop-blur-xl">
                  <span className="text-5xl" aria-hidden="true">🎵</span>
                  <audio src={fullscreenPreview.mediaUrl} className="w-full" controls autoPlay />
                </div>
              ) : fullscreenPreview.outputType === 'video' && fullscreenPreview.thumbnailUrl ? (
                <img
                  src={fullscreenPreview.thumbnailUrl}
                  alt={fullscreenPreview.label}
                  className="max-h-full max-w-full select-none rounded-2xl object-contain shadow-2xl"
                  draggable={false}
                />
              ) : (
                <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-canvas-border bg-canvas-surface/90 p-6 text-sm leading-7 text-canvas-text shadow-2xl backdrop-blur-xl">
                  {fullscreenPreview.previewText || t('暂无可预览内容')}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-center gap-2">
              <span className="max-w-[70vw] truncate text-xs text-white/70">
                {fullscreenPreview.label}{fullscreenPreview.displayId != null ? ` #${fullscreenPreview.displayId}` : ''}
              </span>
              <button
                type="button"
                className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-500 px-5 text-sm font-medium text-white shadow-lg transition-[transform,background-color] duration-150 ease-out hover:bg-indigo-400 active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                onClick={() => {
                  handleClick(fullscreenPreview.id, fullscreenPreview.label);
                  setFullscreenPreview(null);
                }}
              >
                {t('单击引用')}
              </button>
            </div>
          </div>
        )}
      </FullscreenOverlay>

      <style>{`
        .connected-nodes-float {
          position: relative;
          width: 540px;
          max-width: calc(100vw - 32px);
          background: transparent;
          padding: 0 14px;
        }
        .connected-nodes-strip {
          display: flex;
          gap: 6px;
          scrollbar-width: thin;
          scrollbar-color: var(--theme-border) transparent;
        }
        .connected-nodes-strip::-webkit-scrollbar { height: 3px; }
        .connected-nodes-strip::-webkit-scrollbar-track { background: transparent; }
        .connected-nodes-strip::-webkit-scrollbar-thumb { background: var(--theme-border); border-radius: 8px; }
        .connected-node-thumb {
          flex-shrink: 0;
          width: 38px; height: 38px;
          border-radius: 8px;
          border: 2px solid rgba(195,195,202,0.33);
          background: var(--theme-surface);
          cursor: var(--cursor-pointer, pointer);
          display: flex; align-items: center; justify-content: center;
          overflow: hidden; position: relative; padding: 0;
        }
        .connected-node-thumb[data-tooltip]:hover { overflow: visible; }
        .connected-node-thumb.thumb-storyboard { border-color: rgba(244,114,182,0.45); }
        /* 分镜表：沿用节点自身的琥珀色，和文本节点区分开 */
        .connected-node-thumb.thumb-shotlist {
          border-color: rgba(251,191,36,0.5);
          background: rgba(251,191,36,0.08);
        }
        .thumb-img {
          width: 100%; height: 100%; object-fit: cover; border-radius: 6px;
        }
        .thumb-video-wrap {
          position: relative; width: 100%; height: 100%;
          display: flex; align-items: center; justify-content: center;
        }
        .thumb-video-wrap .thumb-img { position: absolute; inset: 0; width: 100%; height: 100%; }
        .thumb-play-icon {
          position: relative; z-index: 1; font-size: 12px;
          color: rgba(255,255,255,0.9); text-shadow: 0 1px 3px var(--black-alpha-50); pointer-events: none;
        }
        .thumb-icon { font-size: 14px; font-weight: 600; opacity: 0.5; }
        .thumb-icon-image { color: var(--success-text); }
        .thumb-icon-video { color: var(--node-video-light); }
        .thumb-icon-audio { color: var(--node-audio-light); }
        .thumb-icon-text  { color: var(--brand-hover); }
        .thumb-icon-shotlist { color: #fbbf24; opacity: 0.9; font-size: 16px; }
        .thumb-text {
          font-size: 4px; line-height: 1.2; color: var(--theme-text-secondary);
          padding: 1px; display: -webkit-box;
          -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all;
        }
        .thumb-loading {
          position: absolute; inset: 0;
          background: var(--black-alpha-50);
          display: flex; align-items: center; justify-content: center;
        }
        .thumb-spinner {
          width: 12px; height: 12px;
          border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff;
          border-radius: 50%; animation: thumb-spin 0.6s linear infinite;
        }
        @keyframes thumb-spin { to { transform: rotate(360deg); } }

        /* ── 宫格角标 ── */
        .thumb-sb-badge {
          position: absolute; bottom: -1px; right: -1px;
          min-width: 16px; height: 16px; padding: 0 4px;
          font-size: 10px; font-weight: 600; line-height: 16px;
          color: #fff; background: #db2777; border-radius: 6px 0 6px 0;
          z-index: 2;
        }

        /* ── 分镜表角标 ── */
        .thumb-shot-badge {
          position: absolute; bottom: -1px; right: -1px;
          min-width: 16px; height: 16px; padding: 0 4px;
          font-size: 10px; font-weight: 600; line-height: 16px;
          color: #1c1300; background: #fbbf24; border-radius: 6px 0 6px 0;
          z-index: 2;
        }

        /* ── 宫格弹出浮层 ── */
        .sb-cell-anchor {
          position: fixed;
          z-index: 9999;
        }
        .sb-cell-popup {
          max-width: calc(100vw - 24px);
          background: var(--theme-card);
          border: 1px solid var(--theme-border);
          border-radius: 12px;
          padding: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(244,114,182,0.2);
        }
        .sb-cell-grid {
          display: grid;
          gap: 5px;
        }
        .sb-cell-item {
          position: relative;
          width: 54px; height: 54px;
          border-radius: 6px;
          border: 1.5px solid rgba(195,195,202,0.28);
          overflow: hidden;
          cursor: var(--cursor-pointer, pointer);
          background: var(--theme-surface);
          padding: 0;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .sb-cell-item:hover {
          border-color: rgba(244,114,182,0.6);
          box-shadow: 0 0 12px rgba(244,114,182,0.2);
        }
        .sb-cell-img {
          width: 100%; height: 100%; object-fit: cover; border-radius: 4px;
        }
        .sb-cell-sprite {
          width: 100%; height: 100%;
          background-repeat: no-repeat;
          border-radius: 4px;
        }
        .sb-cell-placeholder {
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: var(--theme-text-muted);
          width: 100%; height: 100%;
        }
        .sb-cell-label {
          position: absolute; bottom: 2px; left: 2px;
          font-size: 9px; line-height: 13px; padding: 0 4px;
          color: rgba(255,255,255,0.85);
          background: rgba(0,0,0,0.55);
          border-radius: 3px;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
