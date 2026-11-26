/**
 * Perimeter geometry for the Canvas glow overlay. Sample rounded rectangles
 * and circles to place the halo and its catch-light.
 */
import { PERIM_SAMPLES } from '../perfConfig';

import { GLOW } from './config';

export { PERIM_SAMPLES };

export interface GlowOptions {
  width: number;
  height: number;
  cornerRadius: number;
  kind: 'pill' | 'circle';
  /** Scales glow distances such as stroke widths, blur and fade radius.
   *  Use 2 for a 2× layout so the glow grows with the host element. */
  scale?: number;
  /**
   * Point mode (custom-mask instances). `samplePoints` are box-local CSS-px
   * positions inside the mask where luminance is sampled and the hotspot can
   * sit; `maskDataUrl` is the mask rendered white-on-transparent, used to clip
   * the glow to the glyphs instead of the ring band.
   */
  samplePoints?: Pt[];
  maskDataUrl?: string;
}
export interface Pt { x: number; y: number }
export interface PerimSample extends Pt { arc: number }

export function rrPerim(w: number, h: number, r: number): number {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  return 2 * Math.max(0, w - 2 * rr) + 2 * Math.max(0, h - 2 * rr) + 2 * Math.PI * rr;
}

export function shapePerim(w: number, h: number, r: number, kind: 'pill' | 'circle'): number {
  if (kind === 'circle') return 2 * Math.PI * Math.max(0, Math.min(r, Math.min(w, h) / 2));
  return rrPerim(w, h, r);
}

export function sampleAtArc(s: number, w: number, h: number, r: number, inset: number, outward: number, kind: 'pill' | 'circle', out?: Pt): Pt {
  const o = out || { x: 0, y: 0 };
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (kind === 'circle') {
    const perim = 2 * Math.PI * rr;
    if (perim <= 0.0001) { o.x = w * 0.5; o.y = h * 0.5; return o; }
    s = ((s % perim) + perim) % perim;
    const theta = -Math.PI / 2 + (s / perim) * Math.PI * 2;
    const rad = Math.max(0, rr - inset + outward);
    o.x = w * 0.5 + rad * Math.cos(theta);
    o.y = h * 0.5 + rad * Math.sin(theta);
    return o;
  }
  const topLen = Math.max(0, w - 2 * rr), sideLen = Math.max(0, h - 2 * rr);
  const arcLen = (Math.PI * rr) / 2;
  const perim = 2 * (topLen + sideLen) + 4 * arcLen;
  s = ((s % perim) + perim) % perim;
  const rad = Math.max(0, rr - inset + outward);
  let d = s;
  if (d < topLen) { o.x = rr + d; o.y = inset - outward; return o; }
  d -= topLen;
  if (d < arcLen) {
    const theta = -Math.PI / 2 + (arcLen > 0 ? d / arcLen : 0) * (Math.PI / 2);
    o.x = (w - rr) + rad * Math.cos(theta); o.y = rr + rad * Math.sin(theta); return o;
  }
  d -= arcLen;
  if (d < sideLen) { o.x = w - inset + outward; o.y = rr + d; return o; }
  d -= sideLen;
  if (d < arcLen) {
    const theta = (arcLen > 0 ? d / arcLen : 0) * (Math.PI / 2);
    o.x = (w - rr) + rad * Math.cos(theta); o.y = (h - rr) + rad * Math.sin(theta); return o;
  }
  d -= arcLen;
  if (d < topLen) { o.x = w - rr - d; o.y = h - inset + outward; return o; }
  d -= topLen;
  if (d < arcLen) {
    const theta = Math.PI / 2 + (arcLen > 0 ? d / arcLen : 0) * (Math.PI / 2);
    o.x = rr + rad * Math.cos(theta); o.y = (h - rr) + rad * Math.sin(theta); return o;
  }
  d -= arcLen;
  if (d < sideLen) { o.x = inset - outward; o.y = h - rr - d; return o; }
  d -= sideLen;
  const theta = Math.PI + (arcLen > 0 ? d / arcLen : 0) * (Math.PI / 2);
  o.x = rr + rad * Math.cos(theta); o.y = rr + rad * Math.sin(theta);
  return o;
}

/**
 * Inverse of `sampleAtArc` at inset 0: the arc-length position on the outline
 * nearest a box-local point. Points off the outline project onto it.
 */
export function arcAtPoint(x: number, y: number, w: number, h: number, r: number, kind: 'pill' | 'circle'): number {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (kind === 'circle') {
    const perim = 2 * Math.PI * rr;
    if (perim <= 0.0001) return 0;
    const theta = Math.atan2(y - h / 2, x - w / 2);
    const s = ((theta + Math.PI / 2) / (2 * Math.PI)) * perim;
    return ((s % perim) + perim) % perim;
  }
  const topLen = Math.max(0, w - 2 * rr), sideLen = Math.max(0, h - 2 * rr);
  const arcLen = (Math.PI * rr) / 2, Q = Math.PI / 2;
  const s1 = topLen, s2 = s1 + arcLen, s3 = s2 + sideLen, s4 = s3 + arcLen, s5 = s4 + topLen, s6 = s5 + arcLen, s7 = s6 + sideLen;
  const inX = x >= rr && x <= w - rr, inY = y >= rr && y <= h - rr;
  if (inX && inY) {
    const dl = x, dr = w - x, dt = y, db = h - y, m = Math.min(dl, dr, dt, db);
    if (m === dt) return x - rr;
    if (m === dr) return s2 + (y - rr);
    if (m === db) return s4 + (w - rr - x);
    return s6 + (h - rr - y);
  }
  if (inX) return y < h / 2 ? x - rr : s4 + (w - rr - x);
  if (inY) return x > w / 2 ? s2 + (y - rr) : s6 + (h - rr - y);
  if (x > w / 2 && y < h / 2) { const t = Math.atan2(y - rr, x - (w - rr)); return s1 + ((t + Q) / Q) * arcLen; }
  if (x > w / 2) { const t = Math.atan2(y - (h - rr), x - (w - rr)); return s3 + (t / Q) * arcLen; }
  if (y > h / 2) { const t = Math.atan2(y - (h - rr), x - rr); return s5 + ((t - Q) / Q) * arcLen; }
  const t = Math.atan2(y - rr, x - rr);
  return s7 + ((t + Math.PI) / Q) * arcLen;
}

const _ta: Pt = { x: 0, y: 0 };
const _tb: Pt = { x: 0, y: 0 };

export function tangentAngleAtArc(s: number, w: number, h: number, r: number, inset: number, kind: 'pill' | 'circle'): number {
  const eps = 0.1;
  sampleAtArc(s - eps, w, h, r, inset, 0, kind, _ta);
  sampleAtArc(s + eps, w, h, r, inset, 0, kind, _tb);
  return Math.atan2(_tb.y - _ta.y, _tb.x - _ta.x);
}

export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function buildPerimTable(opts: GlowOptions): PerimSample[] {
  if (opts.samplePoints && opts.samplePoints.length > 0) {
    // Point mode: `arc` is just the index — relocation logic works on
    // indices, and positioning bypasses arc math entirely.
    return opts.samplePoints.map((p, i) => ({ x: p.x, y: p.y, arc: i }));
  }
  const perim = shapePerim(opts.width, opts.height, opts.cornerRadius, opts.kind);
  const insetS = GLOW.inset * (opts.scale ?? 1);
  const table: PerimSample[] = [];
  for (let i = 0; i < PERIM_SAMPLES; i++) {
    const arc = (i / PERIM_SAMPLES) * perim;
    const pt = sampleAtArc(arc, opts.width, opts.height, opts.cornerRadius, insetS, 0, opts.kind);
    table.push({ x: pt.x, y: pt.y, arc });
  }
  return table;
}
