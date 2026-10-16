import { describe, expect, it } from 'vitest';
import { fitWindowRectToWorkArea } from '../../src/services/mainWindowBoundsService';

describe('main window work area', () => {
  const screen = { x: 0, y: 0, width: 1440, height: 900 };

  it.each([
    ['bottom Dock', { x: 0, y: 25, width: 1440, height: 795 }],
    ['left Dock', { x: 80, y: 25, width: 1360, height: 875 }],
    ['right Dock', { x: 0, y: 25, width: 1360, height: 875 }],
    ['auto-hidden Dock', { x: 0, y: 25, width: 1440, height: 873 }],
  ] as const)('fits a maximized window to the system area with %s', (_name, workArea) => {
    expect(fitWindowRectToWorkArea(screen, workArea, 16 / 9, true)).toEqual(workArea);
  });

  it('uses the new work area when the Dock moves or auto-hide changes', () => {
    const bottom = { x: 0, y: 25, width: 1440, height: 795 };
    const left = { x: 80, y: 25, width: 1360, height: 875 };
    const hidden = { x: 0, y: 25, width: 1440, height: 873 };
    const moved = fitWindowRectToWorkArea(bottom, left, null, true);
    expect(moved).toEqual(left);
    expect(fitWindowRectToWorkArea(moved, hidden, null, true)).toEqual(hidden);
  });

  it('keeps a restored window inside a Retina screen at negative desktop coordinates', () => {
    const workArea = { x: -2720, y: -1740, width: 2720, height: 1600 };
    expect(fitWindowRectToWorkArea(
      { x: -2880, y: -1800, width: 3200, height: 1800 }, workArea,
    )).toEqual(workArea);
  });

  it('shrinks a locked ratio to fit a work area below the usual minimum height', () => {
    const workArea = { x: 80, y: 25, width: 1200, height: 620 };
    const actual = fitWindowRectToWorkArea(
      { x: 0, y: 0, width: 1600, height: 900 }, workArea, 16 / 9,
    );
    expect(actual).toEqual({ x: 80, y: 25, width: 1102, height: 620 });
    expect(Math.abs(actual.width / actual.height - 16 / 9)).toBeLessThan(0.002);
  });

  it('keeps an ordinary window unchanged when it already fits', () => {
    const rect = { x: 200, y: 80, width: 1000, height: 700 };
    expect(fitWindowRectToWorkArea(rect, screen)).toEqual(rect);
  });
});
