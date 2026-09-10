/**
 * 小地图节点统计 — 悬浮小地图时在上方浮层里统计画布各类型节点数量与总数量。
 * 统计口径与 React Flow 实际渲染的节点一致（已剔除隐藏节点），与小地图显示的内容同步。
 */
import { useMemo, useState } from 'react';
import { MiniMap, useStore, type Node as RFNode } from '@xyflow/react';
import { useT } from '../../i18n';
import { getNodeTypeConfig } from '../../types';

const MINIMAP_STYLE = {
  width: 180,
  height: 120,
  border: '1px solid var(--theme-border)',
  borderRadius: '8px',
};

const minimapNodeColor = (node: RFNode) => {
  switch (node.type) {
    case 'ai-text':
    case 'source-text':
    case 'comment': return 'color-mix(in srgb, var(--node-text-light) 50%, transparent)';
    case 'ai-image':
    case 'source-image':
    case 'ai-storyboard': return 'color-mix(in srgb, var(--node-image-light) 50%, transparent)';
    case 'ai-video':
    case 'source-video': return 'color-mix(in srgb, var(--node-video-light) 50%, transparent)';
    case 'ai-audio':
    case 'source-audio': return 'color-mix(in srgb, var(--node-audio-light) 50%, transparent)';
    case 'ai-animation': return 'color-mix(in srgb, var(--brand) 50%, transparent)';
    case 'ai-panorama': return 'color-mix(in srgb, var(--node-panorama) 50%, transparent)';
    case 'ai-markdown': return 'color-mix(in srgb, var(--node-markdown-light) 50%, transparent)';
    case 'ai-director': return 'color-mix(in srgb, #a78bfa 50%, transparent)';
    case 'ai-shotlist': return 'color-mix(in srgb, #fbbf24 50%, transparent)';
    case 'canvas-note': return 'color-mix(in srgb, var(--brand-light) 55%, transparent)';
    case 'group': return '#4b556380';
    default: return '#6b728080';
  }
};

/** 统计行的固定展示顺序：生成类 → 源素材类 → 容器与笔记；未列出的类型排在末尾 */
const STATS_ORDER = [
  'ai-text',
  'ai-image',
  'ai-video',
  'ai-audio',
  'ai-animation',
  'ai-panorama',
  'ai-markdown',
  'ai-storyboard',
  'ai-shotlist',
  'ai-director',
  'plugin-node',
  'source-text',
  'source-image',
  'source-video',
  'source-audio',
  'canvas-note',
  'comment',
  'group',
];

/** NODE_TYPE_CONFIG 之外的类型名 */
const EXTRA_NODE_LABELS: Record<string, string> = {
  'source-text': '源文本',
  'source-image': '源图像',
  'source-video': '源视频',
  'source-audio': '源音频',
  group: '分组',
};

/** 圆点配色，与 minimapNodeColor 的语义色保持一致 */
const DOT_CLASS: Record<string, string> = {
  'ai-text': 'is-text',
  'source-text': 'is-text',
  'ai-image': 'is-image',
  'source-image': 'is-image',
  'ai-storyboard': 'is-image',
  'ai-video': 'is-video',
  'source-video': 'is-video',
  'ai-audio': 'is-audio',
  'source-audio': 'is-audio',
  'ai-animation': 'is-animation',
  'ai-panorama': 'is-panorama',
  'ai-markdown': 'is-markdown',
  'ai-director': 'is-director',
  'ai-shotlist': 'is-shotlist',
  'plugin-node': 'is-plugin',
  'canvas-note': 'is-note',
  group: 'is-group',
};

interface NodeStatsRow {
  key: string;
  label: string;
  count: number;
  dotClass: string;
}

function getNodeTypeLabel(type: string): string {
  return EXTRA_NODE_LABELS[type] ?? getNodeTypeConfig(type).label;
}

export default function MiniMapNodeStats() {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  // 直接读 React Flow 内部节点，保证统计与小地图渲染的是同一批节点
  const flowNodes = useStore((s) => s.nodes);

  const rows = useMemo<NodeStatsRow[]>(() => {
    const counts = new Map<string, number>();
    for (const node of flowNodes) {
      const type = node.type ?? '';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const known = STATS_ORDER.filter((type) => counts.has(type));
    const unknown = [...counts.keys()]
      .filter((type) => !STATS_ORDER.includes(type))
      .sort((a, b) => a.localeCompare(b));
    return [...known, ...unknown].map((type) => ({
      key: type,
      label: getNodeTypeLabel(type),
      count: counts.get(type) ?? 0,
      dotClass: DOT_CLASS[type] ?? 'is-default',
    }));
  }, [flowNodes]);

  const total = flowNodes.length;

  return (
    <div
      className="minimap-stats-zone"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        // 置空后 React Flow 不再注入默认 <title>Mini Map</title>，避免悬浮时的原生文字气泡
        ariaLabel=""
        nodeColor={minimapNodeColor}
        nodeStrokeColor="var(--theme-border)"
        nodeStrokeWidth={1.5}
        nodeBorderRadius={35}
        bgColor="var(--theme-surface)"
        maskColor="var(--minimap-mask)"
        maskStrokeColor="var(--brand)"
        maskStrokeWidth={2}
        style={MINIMAP_STYLE}
      />
      {hovered && (
        <div className="minimap-stats-card" role="tooltip">
          <div className="minimap-stats-card__title">{t('画布节点统计')}</div>
          {rows.length === 0 ? (
            <div className="minimap-stats-card__empty">{t('画布暂无节点')}</div>
          ) : (
            <ul className="minimap-stats-card__list">
              {rows.map((row) => (
                <li key={row.key} className="minimap-stats-card__row">
                  <span className={`minimap-stats-card__dot ${row.dotClass}`} />
                  <span className="minimap-stats-card__label">{t(row.label)}</span>
                  <span className="minimap-stats-card__count">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="minimap-stats-card__total">
            <span>{t('总计')}</span>
            <span className="minimap-stats-card__count">{total}</span>
          </div>
        </div>
      )}
    </div>
  );
}
