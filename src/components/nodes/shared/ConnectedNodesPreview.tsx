/**
 * ConnectedNodesPreview — 已连线节点内容缩略图条
 * 显示在 PromptPanel 上方，展示所有 predecessor 节点的输出缩略图，
 * 点击可快速 @提及 对应节点。
 */
import { useMemo, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useAppStore } from '../../../store/useAppStore';
import type { BaseNodeData } from '../../../types';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
/** 本地文件路径 → asset URL（Tauri 端，不会失效），非 Tauri 返回 undefined */
function localAssetUrl(filePath?: string): string | undefined {
  if (!filePath || !IS_TAURI) return undefined;
  try { return convertFileSrc(filePath); } catch { return undefined; }
}

interface ConnectedNodesPreviewProps {
  nodeId?: string;
  onInsertMention?: (mentionStr: string) => void;
}

const OUTPUT_TYPE_ICON: Record<string, string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  text: 'T',
};

export default function ConnectedNodesPreview({ nodeId, onInsertMention }: ConnectedNodesPreviewProps) {
  const { nodes, edges } = useAppStore();

  const connectedNodes = useMemo(() => {
    if (!nodeId) return [];
    const me = nodes.find((n) => n.id === nodeId);
    // 直接入边源 + 共享输入（本节点在分组内时加入分组的入边源）
    const rawSourceIds = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.source));
    if (me?.parentId) {
      edges.filter((e) => e.target === me.parentId).forEach((e) => rawSourceIds.add(e.source));
    }
    // 全部输出：作为源的分组节点展开为其全部子节点；分组节点本身不显示
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
        const outputType = data.imageUrl
          ? 'image'
          : data.videoUrl
          ? 'video'
          : data.audioUrl
          ? 'audio'
          : 'text';
        // 图片节点优先本地文件（线上地址可能失效）；视频用 thumbnailUrl 作海报帧
        const thumbnailUrl = outputType === 'image'
          ? (localAssetUrl(data.filePath as string | undefined) || (data.thumbnailUrl as string) || data.imageUrl || undefined)
          : ((data.thumbnailUrl as string) || data.videoUrl || undefined);
        const textSnippet = outputType === 'text' && data.output
          ? String(data.output).slice(0, 50)
          : undefined;
        return {
          id: n.id,
          label: data.label || '节点',
          displayId: data.displayId,
          outputType,
          thumbnailUrl,
          textSnippet,
          hasOutput: !!data.output,
          nodeType: data.type,
          status: data.status,
        };
      });
  }, [nodeId, nodes, edges]);

  if (connectedNodes.length === 0) return null;

  const handleClick = (nodeId: string, label: string) => {
    onInsertMention?.(`@{${nodeId}:${label}}`);
  };

  // Apple Dock magnification state
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const onHoverStart = useCallback((idx: number) => setHoverIndex(idx), []);
  const onHoverEnd = useCallback(() => setHoverIndex(null), []);

  const MAX_SCALE = 1.22;
  const NEAR_SCALE = 1.10;

  const getDockScale = (index: number): number => {
    if (hoverIndex === null) return 1;
    const distance = Math.abs(index - hoverIndex);
    if (distance === 0) return MAX_SCALE;
    if (distance === 1) return NEAR_SCALE;
    return 1;
  };

  // Apple Dock: items spread apart horizontally when one is magnified
  const getDockX = (index: number): number => {
    if (hoverIndex === null) return 0;
    const delta = index - hoverIndex; // negative = left of hovered, positive = right
    const dist = Math.abs(delta);
    if (dist === 0) return 0;            // hovered item stays centered
    if (dist === 1) return delta * 12;   // adjacent: pushed outward by 12px
    if (dist === 2) return delta * 5;    // two steps: pushed by 5px
    return 0;                             // too far: no effect
  };

  return (
    <div className="connected-nodes-float">
      <div className="connected-nodes-strip">
        {connectedNodes.map((node, idx) => {
          const scale = getDockScale(idx);
          const x = getDockX(idx);
          const isHovered = hoverIndex === idx;
          return (
          <motion.button
            key={node.id}
            type="button"
            className={`connected-node-thumb ${!node.hasOutput ? 'thumb-idle' : ''} thumb-${node.outputType}`}
            data-tooltip={`${node.label}${node.displayId != null ? ` #${node.displayId}` : ''} — 点击引用`}
            onClick={() => handleClick(node.id, node.label)}
            onHoverStart={() => onHoverStart(idx)}
            onHoverEnd={onHoverEnd}
            animate={{
              scale,
              x,
              y: isHovered ? -4 : 0,
              opacity: isHovered ? 1 : 0.55,
              boxShadow: isHovered
                ? `0 6px 20px rgba(99, 102, 241, 0.25), 0 0 0 2px rgba(99, 102, 241, 0.35)`
                : `0 0 0 0px rgba(99, 102, 241, 0)`,
              borderColor: isHovered ? 'rgba(99, 102, 241, 0.6)' : 'rgba(195, 195, 202, 0.33)',
            }}
            whileTap={{ scale: scale * 0.92 }}
            transition={{
              type: 'spring',
              stiffness: 350,
              damping: 20,
              mass: 0.7,
            }}
          >
            {node.outputType === 'image' && node.thumbnailUrl ? (
              <img
                src={node.thumbnailUrl}
                alt={node.label}
                className="thumb-img"
                loading="lazy"
              />
            ) : node.outputType === 'video' && node.thumbnailUrl ? (
              <div className="thumb-video-wrap">
                <img
                  src={node.thumbnailUrl}
                  alt={node.label}
                  className="thumb-img"
                  loading="lazy"
                />
                <span className="thumb-play-icon">▶</span>
              </div>
            ) : node.outputType === 'text' && node.textSnippet ? (
              <span className="thumb-text">{node.textSnippet}</span>
            ) : (
              <span className={`thumb-icon thumb-icon-${node.outputType}`}>
                {OUTPUT_TYPE_ICON[node.outputType] || '?'}
              </span>
            )}
            {node.status === 'loading' && (
              <div className="thumb-loading">
                <span className="thumb-spinner" />
              </div>
            )}
          </motion.button>
        )})}
      </div>
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
        .connected-nodes-strip::-webkit-scrollbar {
          height: 3px;
        }
        .connected-nodes-strip::-webkit-scrollbar-track {
          background: transparent;
        }
        .connected-nodes-strip::-webkit-scrollbar-thumb {
          background: var(--theme-border);
          border-radius: 8px;
        }
        .connected-node-thumb {
          flex-shrink: 0;
          width: 38px;
          height: 38px;
          border-radius: 8px;
          border: 2px solid rgba(195, 195, 202, 0.33);
          background: var(--theme-surface);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          position: relative;
          padding: 0;
        }
        /* Allow global [data-tooltip] to render outside the clipped area */
        .connected-node-thumb[data-tooltip]:hover {
          overflow: visible;
        }
        .thumb-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: 6px;
        }
        .thumb-video-wrap {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .thumb-video-wrap .thumb-img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .thumb-play-icon {
          position: relative;
          z-index: 1;
          font-size: 12px;
          color: rgba(255,255,255,0.9);
          text-shadow: 0 1px 3px var(--black-alpha-50);
          pointer-events: none;
        }
        .thumb-icon {
          font-size: 14px;
          font-weight: 600;
          opacity: 0.5;
        }
        .thumb-icon-image { color: var(--success-text); }
        .thumb-icon-video { color: var(--node-video-light); }
        .thumb-icon-audio { color: var(--node-audio-light); }
        .thumb-icon-text  { color: var(--brand-hover); }
        .thumb-text {
          font-size: 4px;
          line-height: 1.2;
          color: var(--theme-text-secondary);
          padding: 1px;
          display: -webkit-box;
          -webkit-line-clamp: 4;
          -webkit-box-orient: vertical;
          overflow: hidden;
          word-break: break-all;
        }
        .thumb-loading {
          position: absolute;
          inset: 0;
          background: var(--black-alpha-50);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .thumb-spinner {
          width: 12px;
          height: 12px;
          border: 2px solid rgba(255,255,255,0.2);
          border-top-color: #fff;
          border-radius: 50%;
          animation: thumb-spin 0.6s linear infinite;
        }
        @keyframes thumb-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
