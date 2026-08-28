import { describe, expect, it } from 'vitest';
import {
  fitMainWindowAspectRatio,
  normalizeMainWindowSize,
  parseAspectRatio,
} from '../../src/hooks/useMainWindowSize';

describe('useMainWindowSize helpers', () => {
  it('parses valid ratios and rejects invalid ratios', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('0:9')).toBeNull();
    expect(parseAspectRatio(undefined)).toBeNull();
  });

  it('rejects transient sizes below the main window minimum', () => {
    expect(normalizeMainWindowSize({ width: 999, height: 700 })).toBeNull();
    expect(normalizeMainWindowSize({ width: 1000, height: 699 })).toBeNull();
    expect(normalizeMainWindowSize({ width: Number.NaN, height: 900 })).toBeNull();
  });

  it('rounds and accepts usable logical sizes', () => {
    expect(normalizeMainWindowSize({ width: 1420.4, height: 900.4 })).toEqual({
      width: 1420,
      height: 900,
    });
  });

  it('keeps a locked ratio without dropping below the minimum height', () => {
    expect(fitMainWindowAspectRatio(1000, 16 / 9)).toEqual({ width: 1244, height: 700 });
    expect(fitMainWindowAspectRatio(1600, 16 / 9)).toEqual({ width: 1600, height: 900 });
  });
});
