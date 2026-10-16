import { describe, expect, it } from 'vitest';
import { createCanvasEdgeClipper, type CanvasEdgeClipRect } from '../../src/utils/canvasEdgeClipping';

const rect: CanvasEdgeClipRect = { left: -10, top: -10, right: 10, bottom: 10 };
const numbers = (path: string) => path.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];

describe('canvas edge geometry clipping', () => {
  it('retains exact endpoints, curve commands and shared joins when wholly inside', () => {
    const source = 'M-8,0 L-5,0 Q-3,0 -3,2 C-3,4 3,4 3,2 L8,2';
    const result = createCanvasEdgeClipper(source)?.clip(rect, 0.01);
    expect(result).toBe('M-8,0L-5,0Q-3,0 -3,2C-3,4 3,4 3,2L8,2');
    expect(result?.match(/M/g)).toHaveLength(1);
  });

  it('clips a line crossing the viewport with both endpoints offscreen', () => {
    const clipped = createCanvasEdgeClipper('M-100,0 L100,0')?.clip(rect, 0.01);
    const values = numbers(clipped!);
    expect(values).toHaveLength(4);
    expect(values[0]).toBeCloseTo(-10, 12);
    expect(values[2]).toBeCloseTo(10, 12);
    expect([values[1], values[3]]).toEqual([0, 0]);
    expect(createCanvasEdgeClipper('M100,100 L200,200')?.clip(rect, 0.01)).toBe('');
  });

  it('keeps cubic curvature across the viewport instead of joining offscreen endpoints', () => {
    const result = createCanvasEdgeClipper('M-100,0 C-50,5 50,-5 100,0')?.clip(rect, 0.01);
    expect(result).toBeTruthy();
    expect(result?.match(/C/g)).toHaveLength(1);
    expect(result).not.toContain('L');
    const values = numbers(result!);
    expect(values[0]).toBeLessThanOrEqual(-10);
    expect(values[values.length - 2]).toBeGreaterThanOrEqual(10);
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(11);
  });

  it('rejects the empty space inside a control hull instead of treating bbox overlap as visibility', () => {
    expect(createCanvasEdgeClipper('M-100,100 C-100,-100 100,-100 100,100')?.clip(rect, 0.01)).toBe('');
    expect(createCanvasEdgeClipper('M-100,100 Q0,-100 100,100')?.clip(rect, 0.01)).toContain('Q');
  });

  it('parses actual RF separators, exponents, signed decimals and implicit repeated parameters', () => {
    const result = createCanvasEdgeClipper('M-8e0 .0 -5,0 Q-3 +0 -3 .2e1 -3,4 3,4 C3 3 4 2 5 1')?.clip(rect, 0.01);
    expect(result).toBe('M-8,0L-5,0Q-3,0 -3,2Q-3,4 3,4C3,3 4,2 5,1');
  });

  it.each(['', 'M0 0', 'm0 0 L1 1', 'M0 0 A1 1 0 0 0 1 1', 'M0 0L1', 'M0 0Q1 2 3',
    'M0 0C1 2 3 4 5', 'M0 0LNaN 1', 'M0 0L1e999 0', 'M0 0L1 1z', 'M0 0,,L1 1', 'M0 0L1 1,'])('fails closed for unsupported or malformed input: %s', (source) => {
    expect(createCanvasEdgeClipper(source)).toBeNull();
  });

  it('does not join distinct subpaths even if their endpoints meet', () => {
    expect(createCanvasEdgeClipper('M0 0L1 1M1 1L2 2')?.clip(rect, 0.01)).toBe('M0,0L1,1M1,1L2,2');
  });

  it('repeated clipping does not mutate the original curve or earlier cached geometry', () => {
    const source = 'M-100,0 C-50,5 50,-5 100,0';
    const clipper = createCanvasEdgeClipper(source)!;
    const first = clipper.clip(rect, 0.01);
    expect(clipper.clip({ left: 200, top: 200, right: 210, bottom: 210 }, 0.01)).toBe('');
    expect(clipper.clip(rect, 0.01)).toBe(first);
    expect(clipper.clip({ left: -200, top: -200, right: 200, bottom: 200 }, 0.01)).toBe(source.replace(' C', 'C'));
  });

  it.each([0.1, 0.25, 0.45, 0.85, 1.2, 2, 5])('uses the same exact curve at zoom %s', (zoom) => {
    const result = createCanvasEdgeClipper('M-100000,0 C-50000,5 50000,-5 100000,0')?.clip({
      left: -100 / zoom, top: -100 / zoom, right: 100 / zoom, bottom: 100 / zoom,
    }, 0.5 / zoom);
    expect(result).toBeTruthy();
    expect(result?.match(/C/g)).toHaveLength(1);
    expect(result).not.toContain('L');
    expect(numbers(result!).every(Number.isFinite)).toBe(true);
  });

  it('keeps separate crossings as subpaths and does not accumulate transparent strokes', () => {
    const result = createCanvasEdgeClipper('M-100,0 C300,0 -300,0 100,0')?.clip(rect, 0.01);
    expect(result?.match(/C/g)).toHaveLength(3);
    expect(result?.match(/M/g)).toHaveLength(3);
  });

  it('returns intact-path fallback for invalid rectangles, tolerances and exhausted budgets', () => {
    const clipper = createCanvasEdgeClipper('M-100,0 C-50,5 50,-5 100,0')!;
    expect(clipper.clip({ ...rect, left: 20 }, 0.01)).toBeNull();
    expect(clipper.clip({ ...rect, top: Number.NaN }, 0.01)).toBeNull();
    expect(clipper.clip(rect, 0)).toBeNull();
    expect(clipper.clip(rect, Number.POSITIVE_INFINITY)).toBeNull();
    const many = createCanvasEdgeClipper(Array.from({ length: 100 }, () => 'M-100,0 C-50,5 50,-5 100,0').join(' '))!;
    expect(many.clip(rect, 0.01)).toBeNull();
    expect(clipper.clip({ left: 0, top: 0, right: 0, bottom: 0 }, 1e-100)).toBeNull();
  });
});
