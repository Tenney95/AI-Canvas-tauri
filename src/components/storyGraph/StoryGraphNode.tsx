import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { StoryGraphCertainty, StoryGraphNodeKind, StoryGraphPresentation } from '../../types/storyGraph';
import { STORY_GRAPH_NODE_LABELS, STORY_GRAPH_CERTAINTY_LABELS } from '../../services/storyGraphService';

export type StoryGraphFlowNode = Node<{
  label: string;
  kind: StoryGraphNodeKind;
  certainty: StoryGraphCertainty;
  evidenceCount: number;
  dimmed: boolean;
  presentation?: StoryGraphPresentation;
}, 'story-record'>;

const ICONS: Record<StoryGraphNodeKind, string> = {
  character: 'lucide:user-round', event: 'lucide:zap', foreshadow: 'lucide:bookmark',
  setting: 'lucide:book-open', location: 'lucide:map-pin', prop: 'lucide:box', organization: 'lucide:users-round',
};

function StoryGraphNode({ data, selected, isConnectable }: NodeProps<StoryGraphFlowNode>) {
  const t = useT();
  const dots = data.presentation === 'dots';
  const description = `${data.label} · ${t(STORY_GRAPH_NODE_LABELS[data.kind])} · ${t(STORY_GRAPH_CERTAINTY_LABELS[data.certainty])}`;
  const dotDescription = `${description} · ${t('{count} 条原文证据', { count: data.evidenceCount })}`;
  return <div className={`story-graph-node${dots ? ' story-graph-node--dots' : ''} story-graph-kind-${data.kind}${selected ? ' is-selected' : ''}${data.dimmed ? ' is-dimmed' : ''}`}
    title={dots ? dotDescription : description}>
    {dots ? <>
      <span className="story-graph-node__dot" role="img" aria-label={dotDescription} />
      <span className="story-graph-node__dot-label" aria-hidden="true">{data.label}</span>
      <span className="story-graph-node__ports">
        <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
        <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
      </span>
    </> : <>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <span className="story-graph-node__icon" aria-hidden="true"><Icon icon={ICONS[data.kind]} width="16" /></span>
      <span className="story-graph-node__body">
        <span className="story-graph-node__label">{data.label}</span>
        <span className="story-graph-node__meta">{t(STORY_GRAPH_NODE_LABELS[data.kind])} · {t(STORY_GRAPH_CERTAINTY_LABELS[data.certainty])}</span>
      </span>
      {data.evidenceCount > 0 && <span className="story-graph-node__evidence" aria-label={t('{count} 条原文证据', { count: data.evidenceCount })}>
        <Icon icon="lucide:quote" width="11" /><span>{data.evidenceCount}</span>
      </span>}
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </>}
  </div>;
}

export default memo(StoryGraphNode);
