import { memo, useId } from 'react';
import { EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import type { StoryGraphEdgeKind, StoryGraphPresentation } from '../../types/storyGraph';

export type StoryGraphFlowEdge = Edge<{
  label: string;
  kind: StoryGraphEdgeKind;
  directed: boolean;
  showLabel: boolean;
  dimmed: boolean;
  parallelIndex: number;
  parallelCount: number;
  presentation?: StoryGraphPresentation;
}, 'story-relation'>;

/** 独立 path 类避免继承主画布连线的全局强覆盖。 */
function StoryGraphEdge({ id, data, sourceX, sourceY, targetX, targetY, source, target, selected }: EdgeProps<StoryGraphFlowEdge>) {
  const arrowId = `story-arrow-${useId().replaceAll(':', '')}`;
  const dots = data?.presentation === 'dots';
  const dx = targetX - sourceX, dy = targetY - sourceY;
  const length = Math.max(1, Math.hypot(dx, dy));
  const offset = ((data?.parallelIndex ?? 0) - ((data?.parallelCount ?? 1) - 1) / 2) * 34;
  const middleX = (sourceX + targetX) / 2 - dy / length * offset;
  const middleY = (sourceY + targetY) / 2 + dx / length * offset;
  const loop = source === target;
  const loopHeight = 92 + (data?.parallelIndex ?? 0) * 28;
  const path = loop
    ? `M ${sourceX},${sourceY} C ${sourceX + 72},${sourceY - loopHeight} ${targetX - 72},${targetY - loopHeight} ${targetX},${targetY}`
    : `M ${sourceX},${sourceY} Q ${middleX},${middleY} ${targetX},${targetY}`;
  const labelX = loop ? (sourceX + targetX) / 2 : (sourceX + 2 * middleX + targetX) / 4;
  const labelY = loop ? Math.min(sourceY, targetY) - loopHeight * 0.75 : (sourceY + 2 * middleY + targetY) / 4;
  const edgeClass = `story-graph-edge${dots ? ' story-graph-edge--dots' : ''} story-graph-relation-${data?.kind ?? 'related'}${selected ? ' is-selected' : ''}${data?.dimmed ? ' is-dimmed' : ''}`;
  return <g className={edgeClass}>
    <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={dots ? 5 : 6} markerHeight={dots ? 5 : 6} orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" className="story-graph-edge__arrow" />
    </marker></defs>
    <path id={id} d={path} className="story-graph-edge__path" markerEnd={data?.directed ? `url(#${arrowId})` : undefined} />
    <path d={path} className="story-graph-edge__hit" aria-hidden="true" />
    {data?.showLabel && <EdgeLabelRenderer>
      <span className={`story-graph-edge__label${dots ? ' story-graph-edge__label--dots' : ''} nodrag nopan${selected ? ' is-selected' : ''}${data.dimmed ? ' is-dimmed' : ''}`}
        style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }} title={data.label}>{data.label}</span>
    </EdgeLabelRenderer>}
  </g>;
}

export default memo(StoryGraphEdge);
