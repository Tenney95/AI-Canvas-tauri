import { describe, expect, it } from 'vitest';
import type { CanvasSharedEdgeModel } from '../../src/types/canvasEdges';
import { canvasEdgePointer, createCanvasEdgePicker } from '../../src/utils/canvasEdgePicking';

function edge(id: string, path: string, overrides: Partial<CanvasSharedEdgeModel> = {}): CanvasSharedEdgeModel {
  return { kind: 'shared', edge: { id, source: 'a', target: 'b' },
    props: { interactionWidth: 20 } as CanvasSharedEdgeModel['props'],
    path: [path, 0, 0, 0, 0], zIndex: 0, interactive: true, selectable: true, focusable: true, ...overrides };
}

describe('nearest canvas edge picking', () => {
  it.each([0.1, 0.25, 0.45, 0.85, 1.2, 5])('picks the visible line rather than the last wide stroke at zoom %s', (zoom) => {
    const near = edge('near', 'M0,0L500,300', { interactive: false });
    const far = edge('far', 'M0,8L500,308', { zIndex: 100 });
    const matrix = { a: zoom, b: 0, c: 0, d: zoom, e: 310, f: -140 };
    const pointer = canvasEdgePointer({ x: 310 + 250 * zoom, y: -140 + 150 * zoom }, matrix)!;
    expect(pointer.point.x).toBeCloseTo(250);
    expect(pointer.point.y).toBeCloseTo(150);
    expect(createCanvasEdgePicker()([near, far], pointer.point, pointer.zoom)?.edge.id).toBe('near');
  });

  it('distinguishes dense cubic curves using the actual curve rather than endpoint chords', () => {
    const near = edge('near', 'M0,0C0,100 100,100 100,0');
    const far = edge('far', 'M0,6C0,106 100,106 100,6');
    expect(createCanvasEdgePicker()([near, far], { x: 50, y: 75 }, 1)?.edge.id).toBe('near');
  });

  it('handles rounded orthogonal bends and very long offscreen segments', () => {
    const bend = edge('bend', 'M0,0L20,0Q30,0 30,10L30,100');
    const long = edge('long', 'M-100000,8L100000,8');
    expect(createCanvasEdgePicker()([bend, long], { x: 27.5, y: 2.5 }, 1)?.edge.id).toBe('bend');
    expect(createCanvasEdgePicker()([long], { x: 0, y: 8 }, 5)?.edge.id).toBe('long');
  });

  it('uses z order and then paint order only at coincident paths', () => {
    const raised = edge('raised', 'M0,0L100,0', { zIndex: 100 });
    const later = edge('later', 'M0,0L100,0');
    const pick = createCanvasEdgePicker();
    expect(pick([raised, later], { x: 50, y: 0 }, 1)?.edge.id).toBe('raised');
    expect(pick([later, edge('last', 'M0,0L100,0')], { x: 50, y: 0 }, 1)?.edge.id).toBe('last');
  });

  it('invalidates changed paths, removes deleted candidates and respects interaction width', () => {
    const model = edge('a', 'M0,0L100,0');
    const pick = createCanvasEdgePicker();
    expect(pick([model], { x: 50, y: 0 }, 1)).toBe(model);
    const moved = edge('a', 'M0,100L100,100');
    expect(pick([moved], { x: 50, y: 0 }, 1)).toBeUndefined();
    expect(pick([], { x: 50, y: 100 }, 1)).toBeUndefined();
    const narrow = edge('narrow', 'M0,0L100,0', { props: { interactionWidth: 2 } as CanvasSharedEdgeModel['props'] });
    expect(pick([narrow], { x: 50, y: 3 }, 1)).toBeUndefined();
    expect(pick([edge('invalid', 'M0,0A10,10 0 0 1 100,0')], { x: 50, y: 0 }, 1)).toBeUndefined();
  });

  it('rejects invalid viewport coordinates and keeps nonselectable line identity', () => {
    const matrix = { a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 };
    expect(canvasEdgePointer({ x: 1, y: 1 }, { ...matrix, d: 0 })).toBeNull();
    expect(canvasEdgePointer({ x: NaN, y: 1 }, matrix)).toBeNull();
    expect(canvasEdgePointer({ x: 1, y: 1 }, { ...matrix, e: NaN })).toBeNull();
    const fixed = edge('fixed', 'M0,0L100,0', { selectable: false });
    expect(createCanvasEdgePicker()([fixed], { x: 50, y: 0 }, 1)).toBe(fixed);
  });
});
