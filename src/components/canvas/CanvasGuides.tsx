import { Background, BackgroundVariant, useReactFlow, useViewport } from '@xyflow/react';
import type { SnapLine } from '../../hooks/useNodeSnap';

// ── Snap lines overlay ──
type SpacingSnapLine = Extract<SnapLine, { kind: 'spacing' }>;

function formatSpacingDistance(distance: number): string {
  return Number.isInteger(distance) ? String(distance) : distance.toFixed(1);
}

function SpacingGuideMarks({ line, index }: { line: SpacingSnapLine; index: number }) {
  const label = formatSpacingDistance(line.distance);
  return (
    <g key={`spacing-${line.type}-${index}`}>
      {line.segments.map((segment, segmentIndex) => {
        const middle = (segment.start + segment.end) / 2;
        return line.type === 'horizontal' ? (
          <g key={`horizontal-gap-${segmentIndex}`}>
            <line
              x1={segment.start}
              y1={line.crossPosition}
              x2={segment.end}
              y2={line.crossPosition}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={segment.start}
              y1={line.crossPosition - 4}
              x2={segment.start}
              y2={line.crossPosition + 4}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={segment.end}
              y1={line.crossPosition - 4}
              x2={segment.end}
              y2={line.crossPosition + 4}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={middle}
              y={line.crossPosition - 6}
              fill="var(--brand)"
              stroke="var(--theme-bg)"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={11}
              fontWeight={600}
              textAnchor="middle"
            >
              {label}
            </text>
          </g>
        ) : (
          <g key={`vertical-gap-${segmentIndex}`}>
            <line
              x1={line.crossPosition}
              y1={segment.start}
              x2={line.crossPosition}
              y2={segment.end}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={line.crossPosition - 4}
              y1={segment.start}
              x2={line.crossPosition + 4}
              y2={segment.start}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={line.crossPosition - 4}
              y1={segment.end}
              x2={line.crossPosition + 4}
              y2={segment.end}
              stroke="var(--brand)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={line.crossPosition - 6}
              y={middle}
              fill="var(--brand)"
              stroke="var(--theme-bg)"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={11}
              fontWeight={600}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function SnapLinesOverlay({ lines }: { lines: SnapLine[] }) {
  const { x, y, zoom } = useViewport();
  if (lines.length === 0) return null;
  return (
    <div
      className="pointer-events-none"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 999,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
    >
      <svg
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          overflow: 'visible',
        }}
      >
        {lines.map((line, i) => {
          if (line.kind === 'spacing') {
            return <SpacingGuideMarks key={`spacing-${line.type}-${i}`} line={line} index={i} />;
          }
          return line.type === 'horizontal' ? (
            <line
              key={`h-${i}`}
              x1={-99999}
              y1={line.position}
              x2={99999}
              y2={line.position}
              stroke="var(--brand)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
          ) : (
            <line
              key={`v-${i}`}
              x1={line.position}
              y1={-99999}
              x2={line.position}
              y2={99999}
              stroke="var(--brand)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.7}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function CanvasGrid({ color }: { color: string }) {
  const { zoom } = useViewport();
  // 以常用的约 50% 视图为基准，避免固定画布间距缩小后在屏幕上过密。
  const gap = zoom < 0.38 ? 80 : zoom < 0.62 ? 40 : zoom < 0.85 ? 30 : 20;
  return <Background variant={BackgroundVariant.Dots} gap={gap} size={1} color={color} />;
}

export function ConnectionDropPreview({
  sources,
  position,
  direction,
}: {
  sources: { x: number; y: number }[];
  position: { x: number; y: number };
  direction: 'input' | 'output';
}) {
  const flow = useReactFlow();
  useViewport();
  const sign = direction === 'input' ? -1 : 1;

  return (
    <svg className="canvas-selection-connect-preview" aria-hidden="true">
      {sources.map((source, index) => {
        const start = flow.flowToScreenPosition(source);
        const bend = Math.max(36, Math.abs(position.x - start.x) / 2);
        return (
          <path
            key={index}
            d={`M ${start.x} ${start.y} C ${start.x + sign * bend} ${start.y}, ${position.x - sign * bend} ${position.y}, ${position.x} ${position.y}`}
          />
        );
      })}
    </svg>
  );
}
