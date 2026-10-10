/**
 * ConnectedNodesPreview — 已连线节点内容缩略图条
 * 紧凑提示词对话框使用左上角圆弧扇形，其他宿主保留内联缩略图条，
 * 点击可快速 @提及 对应节点。
 *
 * 宫格分镜节点特殊处理：缩略图条中只显示一张主图，hover 后在上方弹出按宫格
 * 位置排列的各格 Sprite 缩略图网格，点击某格引用对应格子。
 */
import { useMemo, useState, useCallback, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import closeCircleIcon from '../../../assets/close-circle.svg';
import { useAppStore } from '../../../store/useAppStore';
import type { BaseNodeData, StoryboardCellOverride } from '../../../types';
import { useT } from '../../../i18n';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import FullscreenOverlay from '../../shared/FullscreenOverlay';
import {
  calculateDockOffset,
  calculateReferenceFan,
  CONNECTED_PREVIEW_THUMB_SIZE,
  createConnectedPreviewLongPressController,
  getConnectedPreviewEdgeIds,
} from './connectedNodesPreviewInteractions';

const IMAGE_HOVER_PREVIEW_DELAY_MS = 500;
const REFERENCE_ARC_CENTER_RATIO = 36 / 44;

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
function localAssetUrl(filePath?: string): string | undefined {
  if (!filePath || !IS_TAURI) return undefined;
  try { return convertFileSrc(filePath); } catch { return undefined; }
}

interface ConnectedNodesPreviewProps {
  nodeId?: string;
  onInsertMention?: (mentionStr: string) => void;
  hoverEmphasis?: 'default' | 'expanded';
  presentation?: 'strip' | 'corner';
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
  presentation = 'strip',
}: ConnectedNodesPreviewProps) {
  const t = useT();
  const isCorner = presentation === 'corner';
  const fanId = useId();
  const arcMaterialClipId = `${fanId}-arc-material`;
  const arcHighlightId = `${fanId}-arc-highlight`;
  const arcRefractionId = `${fanId}-arc-refraction`;
  const fanRootRef = useRef<HTMLDivElement>(null);
  const fanTriggerRef = useRef<HTMLButtonElement>(null);
  const fanArcRef = useRef<SVGSVGElement>(null);
  const fanCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fanOpen, setFanOpen] = useState(false);
  const [fanLayout, setFanLayout] = useState(() => calculateReferenceFan({ x: 0, y: 0 }, { width: 320, height: 640 }, 0));
  // 只订阅画布数据：对话框打开期间的聊天流式、轮询进度等无关变更不再触发重渲染
  const { nodes, edges } = useAppStore(
    useShallow((s) => ({ nodes: s.nodes, edges: s.edges })),
  );
  const hoveredMentionNodeId = useAppStore((s) => s.hoveredMentionNodeId);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const [fullscreenPreview, setFullscreenPreview] = useState<FullscreenPreviewItem | null>(null);
  const [suppressClickNodeId, setSuppressClickNodeId] = useState<string | null>(null);
  const closeFullscreenPreview = useCallback(() => {
    setFullscreenPreview(null);
    setSuppressClickNodeId(null);
  }, []);

  // ── 宫格弹出浮层状态 ──
  const [sbPopupId, setSbPopupId] = useState<string | null>(null);
  const [sbThumbRect, setSbThumbRect] = useState<DOMRect | null>(null);
  const sbCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredImageElement = useRef<HTMLElement | null>(null);
  const [imageHoverPreview, setImageHoverPreview] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);

  const clearImageHoverPreview = useCallback(() => {
    if (imageHoverTimer.current !== null) clearTimeout(imageHoverTimer.current);
    imageHoverTimer.current = null;
    hoveredImageElement.current = null;
    setImageHoverPreview(null);
  }, []);

  const startImageHoverPreview = useCallback((element: HTMLElement, id: string) => {
    clearImageHoverPreview();
    hoveredImageElement.current = element;
    imageHoverTimer.current = setTimeout(() => {
      imageHoverTimer.current = null;
      if (hoveredImageElement.current !== element || !element.isConnected) return;
      setImageHoverPreview({ id, rect: element.getBoundingClientRect() });
    }, IMAGE_HOVER_PREVIEW_DELAY_MS);
  }, [clearImageHoverPreview]);

  useEffect(() => () => {
    if (imageHoverTimer.current !== null) clearTimeout(imageHoverTimer.current);
  }, []);

  const clearPopupDelayed = useCallback(() => {
    sbCloseTimer.current = setTimeout(() => setSbPopupId(null), 120);
  }, [setSbPopupId]);
  const cancelCloseTimer = useCallback(() => {
    if (sbCloseTimer.current) { clearTimeout(sbCloseTimer.current); sbCloseTimer.current = null; }
  }, []);
  useEffect(() => () => { if (sbCloseTimer.current) clearTimeout(sbCloseTimer.current); }, []);

  const connectedNodes = useMemo(() => {
    if (!nodeId) return [];
    const edgeIdsBySource = getConnectedPreviewEdgeIds(nodes, edges, nodeId);
    return nodes
      .filter((n) => n.id !== nodeId && n.type !== 'group' && edgeIdsBySource.has(n.id))
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
          edgeIds: edgeIdsBySource.get(n.id) ?? [],
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

  const updateFanLayout = useCallback(() => {
    const rect = fanTriggerRef.current?.getBoundingClientRect();
    const arcRect = fanArcRef.current?.getBoundingClientRect();
    if (!rect || !arcRect) return;
    const anchor = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    setFanLayout(calculateReferenceFan(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      connectedNodes.length,
      {
        x: arcRect.left + arcRect.width * REFERENCE_ARC_CENTER_RATIO - anchor.x,
        y: arcRect.top + arcRect.height * REFERENCE_ARC_CENTER_RATIO - anchor.y,
      },
    ));
  }, [connectedNodes.length]);
  const cancelFanClose = useCallback(() => {
    if (fanCloseTimer.current !== null) clearTimeout(fanCloseTimer.current);
    fanCloseTimer.current = null;
  }, []);
  const closeFan = useCallback(() => {
    cancelFanClose();
    setFanOpen(false);
    setHoverIndex(null);
    clearImageHoverPreview();
    cancelCloseTimer();
    setSbPopupId(null);
    longPressController.cancel();
  }, [cancelFanClose, clearImageHoverPreview, cancelCloseTimer, longPressController]);
  const openFan = () => {
    cancelFanClose();
    updateFanLayout();
    setFanOpen(true);
  };
  const delayFanClose = useCallback(() => {
    cancelFanClose();
    if (fanRootRef.current?.querySelector(':focus-visible')) return;
    fanCloseTimer.current = setTimeout(closeFan, 220);
  }, [cancelFanClose, closeFan]);
  useEffect(() => () => cancelFanClose(), [cancelFanClose]);
  useEffect(() => {
    if (!isCorner || !fanOpen) return;
    updateFanLayout();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || fullscreenPreview) return;
      event.preventDefault();
      event.stopPropagation();
      fanTriggerRef.current?.focus();
      closeFan();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (fanRootRef.current?.contains(target) || target?.closest('.sb-cell-anchor, .fullscreen-overlay')) return;
      closeFan();
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', updateFanLayout);
    window.addEventListener('scroll', closeFan, true);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', updateFanLayout);
      window.removeEventListener('scroll', closeFan, true);
    };
  }, [isCorner, fanOpen, fullscreenPreview, closeFan, updateFanLayout]);

  const handleClick = useCallback((nodeId: string, label: string) => {
    onInsertMention?.(`@{${nodeId}:${label}}`);
    if (isCorner) closeFan();
  }, [onInsertMention, isCorner, closeFan]);
  const handleStoryboardEnter = useCallback(() => {
    cancelCloseTimer();
    cancelFanClose();
  }, [cancelCloseTimer, cancelFanClose]);
  const handleStoryboardLeave = useCallback(() => {
    setSbPopupId(null);
    if (isCorner) delayFanClose();
  }, [isCorner, delayFanClose]);
  const handleStoryboardClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const { mentionId, mentionLabel } = event.currentTarget.dataset;
    if (mentionId && mentionLabel) handleClick(mentionId, mentionLabel);
  }, [handleClick]);

  if (connectedNodes.length === 0) return null;

  const handleDisconnect = (edgeIds: string[]) => {
    const state = useAppStore.getState();
    if (state.currentProjectId !== currentProjectId || !nodeId) return;
    const liveEdgeIds = new Set(state.edges.map((edge) => edge.id));
    const removals = edgeIds.filter((id) => liveEdgeIds.has(id)).map((id) => ({
      type: 'remove' as const,
      id,
    }));
    if (removals.length > 0) state.onEdgesChange(removals);
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
    <div
      ref={fanRootRef}
      className={`connected-nodes-float${isCorner ? ' connected-reference-corner' : ''}${fanOpen ? ' is-open' : ''}`}
      data-reference-preview-open={isCorner && fanOpen ? '' : undefined}
      onMouseEnter={isCorner ? () => { if (window.matchMedia('(hover: hover)').matches) openFan(); } : undefined}
      onMouseLeave={isCorner ? delayFanClose : undefined}
      onFocusCapture={isCorner ? (event) => { if (event.target.matches(':focus-visible')) openFan(); } : undefined}
      onBlurCapture={isCorner ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) delayFanClose();
      } : undefined}
    >
      {isCorner && (
        <button
          ref={fanTriggerRef}
          type="button"
          className="connected-reference-arc"
          aria-label={t('引用素材')}
          aria-expanded={fanOpen}
          aria-controls={fanId}
          onClick={openFan}
        >
          <span className="connected-reference-arc-material" style={{ clipPath: `url(#${arcMaterialClipId})` }} aria-hidden="true" />
          <svg ref={fanArcRef} className="connected-reference-arc-shape" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
            <defs>
              {/* 32px 视口中的 8px 厚度圆头弧面，跨度 95°，用于裁切玻璃背景。 */}
              <clipPath id={arcMaterialClipId} clipPathUnits="objectBoundingBox">
                <path d="M 2.0324 37.4831 A 34 34 0 0 1 37.4831 2.0324 A 5.5 5.5 0 0 1 37.0032 13.0219 A 23 23 0 0 0 13.0219 37.0032 A 5.5 5.5 0 0 1 2.0324 37.4831 Z" transform={`scale(${1 / 44})`} />
              </clipPath>
              <linearGradient id={arcHighlightId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="44" y2="44">
                <stop className="connected-reference-arc-highlight" offset="0%" stopOpacity="0" />
                <stop className="connected-reference-arc-highlight" offset="26%" />
                <stop className="connected-reference-arc-highlight" offset="58%" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={arcRefractionId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="44" y2="44">
                <stop className="connected-reference-arc-refraction" offset="29%" stopOpacity="0" />
                <stop className="connected-reference-arc-refraction" offset="43%" />
                <stop className="connected-reference-arc-refraction" offset="62%" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path className="connected-reference-arc-reflection" d="M 2.8441 37.4476 A 33.1875 33.1875 0 0 1 37.4476 2.8441" stroke={`url(#${arcHighlightId})`} />
            <path className="connected-reference-arc-reflection" d="M 12.2102 37.0387 A 23.8125 23.8125 0 0 1 37.0387 12.2102" stroke={`url(#${arcRefractionId})`} />
          </svg>
        </button>
      )}
      {fullscreenPreview === null && (
        <div id={fanId} className={`connected-nodes-strip${isCorner ? ' connected-reference-fan' : ''}`} aria-hidden={isCorner && !fanOpen ? true : undefined}>
        {connectedNodes.map((node, idx) => {
          const scale = isCorner ? 1 : getDockScale(idx);
          const x = getDockX(idx);
          const isHovered = effectiveHover === idx;
          const isStoryboard = node.nodeType === 'ai-storyboard';
          const isShotlist = node.nodeType === 'ai-shotlist';
          const canFullscreen = Boolean(node.mediaUrl || node.thumbnailUrl || node.previewText);
          const tooltipLabel = `${node.label}${node.displayId != null ? ` #${node.displayId}` : ''}`;
          const tooltipAction = canFullscreen
            ? `${t('点击引用')} · ${t('长按全屏显示')}`
            : t('点击引用');
          const Thumb = isCorner ? 'div' : motion.div;
          const position = fanLayout.items[idx];

          return (
          <Thumb
            key={node.id}
            className={`connected-node-thumb ${!node.hasOutput ? 'thumb-idle' : ''} thumb-${node.outputType}${isStoryboard ? ' thumb-storyboard' : ''}${isShotlist ? ' thumb-shotlist' : ''}${isExpandedEmphasis ? ' origin-bottom' : ''}${isCorner ? ' connected-reference-fan-card' : ''}${isHovered ? ' is-highlighted' : ''}`}
            style={isCorner && position ? { '--fan-x': `${position.x}px`, '--fan-y': `${position.y}px`, '--fan-rotation': `${position.rotate}deg` } as React.CSSProperties : undefined}
            onMouseEnter={(e) => {
              onHoverStart(idx);
              if (isStoryboard && node.sbCells) {
                cancelCloseTimer();
                setSbPopupId(node.id);
                setSbThumbRect(e.currentTarget.getBoundingClientRect());
              } else if (node.outputType === 'image' && node.thumbnailUrl) {
                startImageHoverPreview(e.currentTarget, node.id);
              }
            }}
            onMouseLeave={() => {
              onHoverEnd();
              clearImageHoverPreview();
              if (isStoryboard) clearPopupDelayed();
            }}
            {...(!isCorner ? { animate: {
              scale, x, y: isHovered && !isExpandedEmphasis ? -4 : 0,
              opacity: isHovered ? 1 : 0.85,
              boxShadow: isHovered ? `0 6px 20px rgba(99,102,241,0.25), 0 0 0 2px rgba(99,102,241,0.35)` : `0 0 0 0px rgba(99,102,241,0)`,
              borderColor: isHovered ? 'rgba(99,102,241,0.6)' : 'rgba(195,195,202,0.33)',
            }, whileTap: { scale: scale * 0.92 }, transition: { type: 'spring' as const, stiffness: 350, damping: 20, mass: 0.7 } } : {})}
          >
            <button
              type="button"
              className="connected-node-action"
              tabIndex={isCorner && !fanOpen ? -1 : undefined}
              onFocus={(event) => {
                if (!isCorner || !event.currentTarget.matches(':focus-visible')) return;
                onHoverStart(idx);
                if (isStoryboard && node.sbCells) {
                  cancelCloseTimer();
                  setSbPopupId(node.id);
                  setSbThumbRect(event.currentTarget.getBoundingClientRect());
                }
              }}
              data-tooltip={node.outputType === 'image' && node.thumbnailUrl && !node.sbCells ? undefined : `${tooltipLabel} — ${tooltipAction}`}
              data-tooltip-label={node.outputType === 'image' && node.thumbnailUrl && !node.sbCells ? undefined : `${tooltipLabel} —`}
              data-tooltip-action={node.outputType === 'image' && node.thumbnailUrl && !node.sbCells ? undefined : tooltipAction}
              aria-label={`${tooltipLabel} — ${tooltipAction}`}
              onClick={() => {
                if (suppressClickNodeId === node.id) {
                  setSuppressClickNodeId(null);
                  return;
                }
                handleClick(node.id, node.label);
              }}
              onPointerDown={(event) => {
                clearImageHoverPreview();
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
            </button>
            <motion.button
              type="button"
              className="connected-node-disconnect"
              tabIndex={isCorner && !fanOpen ? -1 : undefined}
              aria-label={`${t('断开上游连线')}：${node.label}`}
              animate={{ scale: 1 / scale }}
              transition={{ type: 'spring', stiffness: 350, damping: 20, mass: 0.7 }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearImageHoverPreview();
                cancelCloseTimer();
                setSbPopupId(null);
                handleDisconnect(node.edgeIds);
              }}
            >
              <img src={closeCircleIcon} alt="" aria-hidden="true" />
            </motion.button>
          </Thumb>
        )})}
        </div>
      )}

      {createPortal(
        <AnimatePresence>
          {fullscreenPreview === null && imageHoverPreview && (() => {
            const previewNode = connectedNodes.find((node) => node.id === imageHoverPreview.id);
            if (!previewNode?.thumbnailUrl) return null;
            const { rect } = imageHoverPreview;
            const width = Math.max(32, Math.min(264, window.innerWidth - 24, rect.top - 20));
            const center = Math.min(
              Math.max(rect.left + rect.width / 2, width / 2 + 12),
              window.innerWidth - width / 2 - 12,
            );
            return (
              <div
                className="connected-image-preview-anchor"
                style={{ left: center, top: rect.top - 8, width, height: width }}
              >
                <motion.div
                  key={previewNode.id}
                  className="connected-image-preview"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.15 }}
                >
                  <img
                    src={previewNode.mediaUrl || previewNode.thumbnailUrl}
                    alt={previewNode.label}
                  />
                </motion.div>
              </div>
            );
          })()}
        </AnimatePresence>,
        document.body,
      )}

      {/* 宫格弹出浮层 — Portal 到 body */}
      {createPortal(
        <AnimatePresence>
          {fullscreenPreview === null && sbPopupId !== null && (() => {
            const sbNode = connectedNodes.find((n) => n.id === sbPopupId);
            if (!sbNode?.sbCells) return null;
            const rect = sbThumbRect;
            // 外层 div 负责定位（translate 不受 framer-motion 干扰），内层 motion.div 只管动效
            const popupWidth = Math.min((sbNode.sbCols ?? 3) * 59 + 17, window.innerWidth - 24);
            const popupCols = sbNode.sbCols ?? 3;
            const popupRows = sbNode.sbRows ?? 3;
            const popupCellSize = (popupWidth - 22 - (popupCols - 1) * 5) / popupCols;
            const popupHeight = popupCellSize * popupRows + (popupRows - 1) * 5 + 22;
            const cornerPosition = rect && isCorner ? calcAnchoredPosition(rect, popupWidth, popupHeight, 8, 12) : null;
            const anchorStyle: React.CSSProperties = rect
              ? cornerPosition ? { left: cornerPosition.left, top: cornerPosition.top }
                : { left: `${rect.left + rect.width / 2}px`, top: `${rect.top - 8}px`, transform: 'translate(-50%, -100%)' }
              : { bottom: 72, left: '50%', transform: 'translateX(-50%)' };

            return (
              <div className="sb-cell-anchor" style={anchorStyle} onMouseEnter={handleStoryboardEnter} onMouseLeave={handleStoryboardLeave}>
                <motion.div
                  key={`sb-popup-${sbPopupId}`}
                  className={`sb-cell-popup${isCorner ? ' connected-reference-storyboard' : ''}`}
                  style={isCorner ? { width: popupWidth } : undefined}
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
                      data-mention-id={cell.mentionId}
                      data-mention-label={`${sbNode.label} · ${cell.label}`}
                      onClick={handleStoryboardClick}
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
        onClose={closeFullscreenPreview}
        hidePanel
        title={fullscreenPreview?.label}
        className="fullscreen-overlay--image-preview"
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
                  closeFullscreenPreview();
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
          width: ${CONNECTED_PREVIEW_THUMB_SIZE}px; height: ${CONNECTED_PREVIEW_THUMB_SIZE}px;
          border-radius: 8px;
          border: 2px solid rgba(195,195,202,0.33);
          background: var(--theme-surface);
          overflow: hidden; position: relative; padding: 0;
        }
        .connected-node-action {
          display: flex; align-items: center; justify-content: center;
          width: 100%; height: 100%; padding: 0; border: 0;
          background: transparent;
          cursor: var(--cursor-pointer, pointer);
        }
        .connected-node-disconnect {
          position: absolute; top: 1px; right: 1px; z-index: 3;
          display: flex; align-items: center; justify-content: center;
          width: 20px; height: 20px; padding: 0;
          border: 0; border-radius: 4px;
          background: transparent;
          cursor: var(--cursor-pointer, pointer);
          opacity: 0; pointer-events: none;
          transform-origin: top right;
        }
        .connected-node-thumb:hover .connected-node-disconnect,
        .connected-node-thumb:focus-within .connected-node-disconnect {
          opacity: 1; pointer-events: auto;
        }
        .connected-node-disconnect img { width: 18px; height: 18px; display: block; }
        .connected-node-thumb.thumb-storyboard { border-color: rgba(244,114,182,0.45); }
        /* 分镜表：沿用节点自身的琥珀色，和文本节点区分开 */
        .connected-node-thumb.thumb-shotlist {
          border-color: rgba(251,191,36,0.5);
          background: rgba(251,191,36,0.08);
        }
        .thumb-img {
          width: 100%; height: 100%; object-fit: cover; border-radius: 6px;
        }
        .connected-image-preview-anchor {
          position: fixed;
          z-index: 10050;
          transform: translate(-50%, -100%);
          pointer-events: none;
        }
        .connected-image-preview {
          width: 100%; height: 100%;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 8px 24px var(--black-alpha-50);
        }
        .connected-image-preview img {
          display: block;
          width: 100%; height: 100%; object-fit: cover;
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
