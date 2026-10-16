export interface CanvasEdgeClipRect { left: number; top: number; right: number; bottom: number }

interface Point { x: number; y: number }
interface Curve {
  points: Point[];
  bounds: CanvasEdgeClipRect;
  children?: [Curve, Curve];
}
interface Segment { command: 'L' | 'Q' | 'C'; curve: Curve; subpath: number }
type Interval = [number, number];
const PARAMS = { M: 2, L: 2, Q: 4, C: 6 } as const;
const CACHE_DEPTH = 8;
const MAX_DEPTH = 24;
const QUERY_BUDGET = 1024;

function makeCurve(points: Point[]): Curve {
  return { points, bounds: {
    left: Math.min(...points.map((point) => point.x)), top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)), bottom: Math.max(...points.map((point) => point.y)),
  } };
}

/** de Casteljau preserves the exact curve, including its endpoint tangents. */
function split(points: Point[], t: number): [Point[], Point[]] {
  let row = points;
  const left = [row[0]];
  const right = [row[row.length - 1]];
  while (row.length > 1) {
    row = row.slice(1).map((point, index) => ({
      x: row[index].x * (1 - t) + point.x * t,
      y: row[index].y * (1 - t) + point.y * t,
    }));
    left.push(row[0]);
    right.unshift(row[row.length - 1]);
  }
  return [left, right];
}

function subcurve(points: Point[], from: number, to: number): Point[] {
  const prefix = to === 1 ? points : split(points, to)[0];
  return from === 0 ? prefix : split(prefix, from / to)[1];
}

function outside(a: CanvasEdgeClipRect, b: CanvasEdgeClipRect): boolean {
  return a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom;
}

function inside(a: CanvasEdgeClipRect, b: CanvasEdgeClipRect): boolean {
  return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
}

function validRect(rect: CanvasEdgeClipRect): boolean {
  return [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.left <= rect.right && rect.top <= rect.bottom;
}

/** Strictly parse only the absolute commands emitted by React Flow's geometry helpers. */
function parse(source: string): Segment[] | null {
  if (source.length > 65_536) return null;
  const tokens: (string | number)[] = [];
  const pattern = /[MLQC]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    const gap = source.slice(end, match.index);
    const command = /^[MLQC]$/.test(match[0]);
    if (!/^[\s,]*$/.test(gap) || (gap.includes(',')
      && (command || typeof tokens[tokens.length - 1] !== 'number' || gap.split(',').length !== 2))) return null;
    const value = command ? match[0] : Number(match[0]);
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    tokens.push(value);
    end = match.index + match[0].length;
  }
  if (!/^\s*$/.test(source.slice(end)) || tokens[0] !== 'M') return null;
  const segments: Segment[] = [];
  let index = 0;
  let command: keyof typeof PARAMS = 'M';
  let current: Point | undefined;
  let subpath = 0;
  while (index < tokens.length) {
    if (typeof tokens[index] === 'string') command = tokens[index++] as keyof typeof PARAMS;
    const count = PARAMS[command];
    const values = tokens.slice(index, index + count);
    if (values.length !== count || values.some((value) => typeof value !== 'number')) return null;
    const points: Point[] = [];
    for (let offset = 0; offset < count; offset += 2) {
      points.push({ x: values[offset] as number, y: values[offset + 1] as number });
    }
    if (command === 'M') {
      subpath += 1;
      command = 'L';
    } else {
      if (!current || segments.length >= 256) return null;
      segments.push({ command, curve: makeCurve([current, ...points]), subpath });
    }
    current = points[points.length - 1];
    index += count;
  }
  return segments.length ? segments : null;
}

function lineInterval(points: Point[], rect: CanvasEdgeClipRect): Interval | null {
  const [start, end] = points;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let from = 0;
  let to = 1;
  const boundaries = [[-dx, start.x - rect.left], [dx, rect.right - start.x],
    [-dy, start.y - rect.top], [dy, rect.bottom - start.y]];
  for (const [direction, distance] of boundaries) {
    if (!Number.isFinite(direction) || !Number.isFinite(distance)) return null;
    if (direction === 0) { if (distance < 0) return [1, 0]; }
    else if (direction < 0) from = Math.max(from, distance / direction);
    else to = Math.min(to, distance / direction);
  }
  return [from, to];
}

/**
 * Clips centerlines conservatively; callers expand rect for stroke width/caps.
 * '' means offscreen, null requests an intact-path fallback. No zoom changes shape.
 */
export function createCanvasEdgeClipper(source: string): {
  clip(rect: CanvasEdgeClipRect, tolerance: number): string | null;
} | null {
  const segments = parse(source);
  if (!segments) return null;
  return {
    clip(rect, tolerance) {
      if (!validRect(rect) || !Number.isFinite(tolerance) || tolerance <= 0) return null;
      let budget = QUERY_BUDGET;
      let result = '';
      let previous: { subpath: number; point: Point } | undefined;
      for (const segment of segments) {
        const intervals: Interval[] = [];
        const accept = (from: number, to: number) => {
          const last = intervals[intervals.length - 1];
          if (last && last[1] === from) last[1] = to;
          else intervals.push([from, to]);
        };
        const visit = (curve: Curve, from: number, to: number, depth: number): boolean => {
          if (--budget < 0) return false;
          const bounds = curve.bounds;
          if (outside(bounds, rect)) return true;
          if (inside(bounds, rect)
            || Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) <= tolerance) {
            accept(from, to);
            return true;
          }
          if (depth >= MAX_DEPTH) return false;
          const children = curve.children ?? split(curve.points, 0.5).map(makeCurve) as [Curve, Curve];
          if (depth < CACHE_DEPTH) curve.children = children;
          const middle = (from + to) / 2;
          return visit(children[0], from, middle, depth + 1) && visit(children[1], middle, to, depth + 1);
        };
        if (segment.command === 'L') {
          if (--budget < 0) return null;
          const interval = lineInterval(segment.curve.points, rect);
          if (!interval) return null;
          if (interval[0] <= interval[1]) accept(...interval);
        } else if (!visit(segment.curve, 0, 1, 0)) return null;
        for (const [from, to] of intervals) {
          const points = subcurve(segment.curve.points, from, to);
          const start = points[0];
          if (!previous || previous.subpath !== segment.subpath
            || previous.point.x !== start.x || previous.point.y !== start.y) result += `M${start.x},${start.y}`;
          result += `${segment.command}${points.slice(1).map((point) => `${point.x},${point.y}`).join(' ')}`;
          previous = { subpath: segment.subpath, point: points[points.length - 1] };
        }
      }
      return result;
    },
  };
}
