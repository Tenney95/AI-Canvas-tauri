import { describe, expect, it } from 'vitest';
import {
  buildEqualSpacingCandidates,
  findBestEqualSpacingSnap,
  type NodeBounds,
} from '../../src/hooks/useNodeSnap';

function createBounds(x: number, y: number, width: number, height: number): NodeBounds {
  return {
    x,
    y,
    width,
    height,
    left: x,
    centerX: x + width / 2,
    right: x + width,
    top: y,
    centerY: y + height / 2,
    bottom: y + height,
  };
}

describe('equal-spacing node snap geometry', () => {
  it('snaps a third vertically aligned node to the existing edge gap', () => {
    const first = createBounds(100, 0, 200, 100);
    const second = createBounds(100, 140, 200, 160);
    const dragged = createBounds(100, 347, 200, 120);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.height, 'vertical');

    const snap = findBestEqualSpacingSnap(dragged, candidates, 'vertical');

    expect(snap?.targetStart).toBe(340);
    expect(snap?.guide.distance).toBe(40);
    expect(snap?.guide.segments).toEqual([
      { start: 100, end: 140 },
      { start: 300, end: 340 },
    ]);
  });

  it('uses edge gaps instead of center distances for differently sized nodes', () => {
    const first = createBounds(0, 50, 100, 80);
    const second = createBounds(140, 50, 200, 80);
    const dragged = createBounds(386, 50, 80, 80);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.width, 'horizontal');

    const snap = findBestEqualSpacingSnap(dragged, candidates, 'horizontal');

    expect(snap?.targetStart).toBe(380);
    expect(snap?.guide.distance).toBe(40);
  });

  it('snaps a node to equal gaps between two outer nodes', () => {
    const first = createBounds(20, 0, 100, 100);
    const second = createBounds(20, 300, 100, 100);
    const dragged = createBounds(20, 166, 100, 80);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.height, 'vertical');

    const snap = findBestEqualSpacingSnap(dragged, candidates, 'vertical');

    expect(snap?.targetStart).toBe(160);
    expect(snap?.guide.distance).toBe(60);
    expect(snap?.guide.segments).toEqual([
      { start: 100, end: 160 },
      { start: 240, end: 300 },
    ]);
  });

  it('does not snap equal gaps when the nodes are not aligned on the cross axis', () => {
    const first = createBounds(0, 0, 100, 100);
    const second = createBounds(0, 140, 100, 100);
    const dragged = createBounds(80, 287, 100, 100);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.height, 'vertical');

    expect(findBestEqualSpacingSnap(dragged, candidates, 'vertical')).toBeNull();
  });

  it('does not use a non-adjacent pair whose gap already contains another node', () => {
    const first = createBounds(0, 0, 100, 100);
    const middle = createBounds(0, 140, 100, 100);
    const last = createBounds(0, 280, 100, 100);
    const dragged = createBounds(0, 566, 100, 100);
    const candidates = buildEqualSpacingCandidates(
      [first, middle, last],
      dragged.height,
      'vertical',
    );

    expect(findBestEqualSpacingSnap(dragged, candidates, 'vertical')).toBeNull();
  });
});
