import { describe, expect, it } from 'vitest';
import { visibleShotlistEditorWindow } from '../../src/components/nodes/useShotlistEditorWindow';

describe('shotlist editor window', () => {
  // Actual row heights can differ with wrapped cells and column widths.
  const heights = [54, 72, 59, 61, 80, 54, 90, 64, 54, 54, 72, 60, 54, 54, 54, 61];
  const table = (scale: number) => {
    let bottom = -17;
    return heights.map((height) => {
      const top = bottom;
      bottom += height * scale;
      return { top, bottom };
    });
  };

  it.each([0.23, 1, 1.5])('includes partially visible rows and two adjacent rows at scale %s', (scale) => {
    const rows = table(scale);
    const viewport = { top: rows[5].bottom - 1, bottom: rows[9].top + 1 };
    expect(visibleShotlistEditorWindow(rows.length, viewport, (index) => rows[index])).toEqual({ first: 3, end: 12 });
  });

  it('clips the buffer at either end and does not read out-of-range rows', () => {
    const rows = table(1);
    expect(visibleShotlistEditorWindow(rows.length, { top: rows[0].top, bottom: rows[1].bottom }, (i) => rows[i]))
      .toEqual({ first: 0, end: 4 });
    expect(visibleShotlistEditorWindow(rows.length, { top: rows[15].top, bottom: rows[15].bottom }, (i) => rows[i]))
      .toEqual({ first: 13, end: 16 });
    expect(visibleShotlistEditorWindow(0, { top: 0, bottom: 400 }, () => { throw new Error('empty'); }))
      .toEqual({ first: 0, end: 0 });
  });
});
