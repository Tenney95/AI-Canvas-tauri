import { MarkerType, type Edge } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { CanvasSharedEdgeModel } from '../../src/types/canvasEdges';
import { canUseCanvasEdgeStroke } from '../../src/utils/canvasEdgePath';

function model(edge: Partial<Edge> = {}): CanvasSharedEdgeModel {
  return { edge: { id: 'ab', source: 'a', target: 'b', ...edge } } as CanvasSharedEdgeModel;
}

describe('Canvas edge stroke compatibility', () => {
  it('accepts ordinary and selected strokes using the existing appearance rules', () => {
    expect(canUseCanvasEdgeStroke(model())).toBe(true);
    expect(canUseCanvasEdgeStroke(model({ selected: true }))).toBe(true);
    expect(canUseCanvasEdgeStroke(model({ label: '' }))).toBe(true);
    expect(canUseCanvasEdgeStroke(model({ style: { stroke: 'var(--canvas-edge)', strokeWidth: 1.5 } }))).toBe(true);
  });

  it.each<Partial<Edge>>([
    { markerStart: 'start' },
    { markerEnd: { type: MarkerType.ArrowClosed } },
    { label: 'caption' },
    { label: 0 },
    { animated: true },
    { className: 'custom-edge' },
    { style: { opacity: 0.5 } },
    { style: { strokeDasharray: '4 2' } },
    { style: { strokeLinecap: 'round' } },
    { style: { filter: 'url(#glow)' } },
    { style: { mixBlendMode: 'multiply' } },
  ])('preserves SVG rendering for unsupported edge features: %j', (edge) => {
    expect(canUseCanvasEdgeStroke(model(edge))).toBe(false);
  });
});
