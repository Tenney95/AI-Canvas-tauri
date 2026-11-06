import { memo, useMemo } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { CanvasProject } from '../../types';
import type { StoryGraphSelection, StoryGraphViewNode } from '../../types/storyGraph';
import { STORY_GRAPH_NODE_LABELS, STORY_GRAPH_CERTAINTY_LABELS } from '../../services/storyGraphService';

interface StoryGraphTimelineProps {
  nodes: StoryGraphViewNode[];
  episodes: Array<Pick<CanvasProject, 'id' | 'name' | 'episodeNo'>>;
  selected?: StoryGraphSelection | null;
  onSelect: (selection: StoryGraphSelection) => void;
}

function StoryGraphTimeline({ nodes, episodes, selected, onSelect }: StoryGraphTimelineProps) {
  const t = useT();
  const ordered = useMemo(() => {
    const episodeOrder = new Map(episodes.map((episode, index) => [episode.id, episode.episodeNo ?? index]));
    const order = (node: StoryGraphViewNode) => Math.min(...node.episodeIds.map((id) => episodeOrder.get(id) ?? Infinity), Infinity);
    return nodes.filter((node) => node.kind === 'event' || node.kind === 'foreshadow')
      .sort((left, right) => order(left) - order(right) || (left.storyOrder ?? Infinity) - (right.storyOrder ?? Infinity) || left.label.localeCompare(right.label));
  }, [nodes, episodes]);
  const names = new Map(episodes.map((episode) => [episode.id, episode.name]));
  return <div className="story-graph-timeline" aria-label={t('故事时间线')}>
    <p className="ui-hint mb-3">{t('按分集和叙事顺序排列；故事内时间单独记录。')}</p>
    {ordered.length === 0 ? <div className="story-graph-empty"><Icon icon="lucide:route" width="24" /><p>{t('还没有事件或伏笔记录')}</p></div>
      : <ol className="space-y-2">{ordered.map((node) => <li key={node.id}>
        <button type="button" className={`ui-card ui-card--interactive story-graph-timeline__item story-graph-kind-${node.kind}${selected?.kind === 'node' && selected.id === node.id ? ' is-selected' : ''}`}
          onClick={() => onSelect({ kind: 'node', id: node.id })}>
          <span className="story-graph-timeline__dot" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2"><strong className="break-words text-xs">{node.label}</strong>
              <span className="ui-badge">{t(STORY_GRAPH_NODE_LABELS[node.kind])}</span>
              <span className="ui-hint">{t(STORY_GRAPH_CERTAINTY_LABELS[node.certainty])}</span></span>
            <span className="mt-1 block text-[11px] text-canvas-text-secondary">{node.episodeIds.length ? node.episodeIds.map((id) => names.get(id) ?? t('来源分集已移除')).join(' · ') : t('未指定分集')}
              {node.storyOrder !== undefined ? ` · ${t('叙事顺序 {order}', { order: node.storyOrder })}` : ''}</span>
            {node.storyTime && <span className="mt-1 block break-words text-[11px] text-canvas-text-secondary">{t('故事内时间')}：{node.storyTime}</span>}
            {node.description && <span className="mt-1 block break-words text-[11px] text-canvas-text-muted">{node.description}</span>}
          </span>
        </button>
      </li>)}</ol>}
  </div>;
}

export default memo(StoryGraphTimeline);
