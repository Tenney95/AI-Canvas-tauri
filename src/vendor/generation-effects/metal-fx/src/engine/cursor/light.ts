/**
 * Cursor light around the nearest metal ring.
 *
 * Both effects depend on the pointer's distance to the nearest ring
 * (either side of the edge, within `reach`):
 *
 *   • spill — a soft glint on the page under the pointer, tinted with the
 *     ring's colour at the outline point nearest the cursor.
 *   • catch — the ring's catch-light faces the pointer (see `updateGlow`'s
 *     cursor mode), so the pointer acts as a light source.
 *
 * Runs only on `(pointer: fine)` devices. Tracking starts when the first
 * instance attaches and stops with the last; the per-frame loop runs only
 * while the pointer is within reach of some ring (plus the fade-out).
 */
import { SHARED, type MetalFxInstance } from '../renderer/core';
import { sampleShaderLumAt, sampleShaderRGBAt } from '../renderer/sampling';
import { tickInstanceGlow } from '../renderer/loop';
import { hsvToRgb, rgbToHsv } from '../color';

export interface CursorLightConfig {
  enabled: boolean;
  /** Distance from the ring's edge, either side, where the pointer is felt (CSS px). */
  reach: number;
  /** Envelope for the whole effect on enter/leave, ms (~95% settled). */
  fadeMs: number;

  /** Glint on the page under the pointer. */
  spill: boolean;
  /** Glint radius, CSS px. */
  spillRadius: number;
  /** Peak opacity with the pointer on the ring (0..1). */
  spillStrength: number;
  /** 0 = centred on the pointer, 1 = centred on the nearest ring point. */
  spillOffset: number;
  /** How much the ring's brightness at that point modulates the glint (0..1). */
  spillLumGain: number;
  /** Saturation multiplier on the sampled tint. */
  spillSaturation: number;
  /** Strength multiplier while the pointer is inside the ring (over content). */
  spillInside: number;
  /** Extra blur on the glint element, CSS px. 0 = gradient only. */
  spillBlur: number;

  /** Ring catch-light follows the pointer. */
  catchLight: boolean;
  /** Hotspot tracking, per-60 Hz-frame lerp (0..1). Lower = lags more. */
  catchFollow: number;
  /** Opacity multiplier on the cursor-driven catch-light. */
  catchGain: number;
}

export const CURSOR_LIGHT_DEFAULTS: Readonly<CursorLightConfig> = Object.freeze({
  enabled: true,
  reach: 56,
  fadeMs: 200,
  spill: false,
  spillRadius: 48,
  spillStrength: 0.55,
  spillOffset: 0.35,
  spillLumGain: 0.7,
  spillSaturation: 1.3,
  spillInside: 0.5,
  spillBlur: 0,
  catchLight: false,
  catchFollow: 0.25,
  catchGain: 1,
});

/** Live values. Read every frame; write via `setCursorLightConfig`. */
export const CURSOR_LIGHT: CursorLightConfig = { ...CURSOR_LIGHT_DEFAULTS };

export function setCursorLightConfig(patch: Partial<CursorLightConfig>): void {
  Object.assign(CURSOR_LIGHT, patch);
  if (!CURSOR_LIGHT.spill && spillEl) hideSpill();
  kick();
}

export function resetCursorLightConfig(): void {
  setCursorLightConfig({ ...CURSOR_LIGHT_DEFAULTS });
}

// ─── Tracking ─────────────────────────────────────────────────────────────

let attached = 0;
let tracking = false;
let raf = 0;
let last = 0;
let px = Number.NaN, py = Number.NaN; // live pointer, NaN when gone
let lpx = 0, lpy = 0;                 // last known, for the fade-out
let uS = 0;                           // smoothed proximity weight (reach)
let near: MetalFxInstance | null = null;
const _near = { d: 0, nx: 0, ny: 0, k: 1, left: 0, top: 0 };
const _pt = { x: 0, y: 0 };
const _sc = { r: 255, g: 255, b: 255 }; // smoothed spill tint

let spillEl: HTMLDivElement | null = null;
let spillBg = '';
let spillSize = -1;
let spillBlur = -1;
let spillShown = false;

/** Reference-counted: MetalFx calls attach on mount, detach on unmount. */
export function attachCursorLight(): void {
  attached++;
  ensureTracking();
}

export function detachCursorLight(): void {
  attached = Math.max(0, attached - 1);
  if (attached === 0) stopTracking();
}

function hasVisibleEffect(): boolean {
  const cfg = CURSOR_LIGHT;
  return cfg.enabled && (cfg.catchLight || cfg.spill);
}

function ensureTracking(): void {
  if (tracking || attached === 0 || typeof document === 'undefined') return;
  if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: fine)').matches) return;
  tracking = true;
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  document.addEventListener('pointercancel', onLeave);
  document.addEventListener('visibilitychange', onLeave);
  window.addEventListener('blur', onLeave);
}

function stopTracking(): void {
  if (!tracking) return;
  tracking = false;
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerleave', onLeave);
  document.removeEventListener('pointercancel', onLeave);
  document.removeEventListener('visibilitychange', onLeave);
  window.removeEventListener('blur', onLeave);
  if (raf !== 0) { cancelAnimationFrame(raf); raf = 0; }
  if (near) { near.cursorLight = null; near = null; }
  uS = 0;
  if (spillEl) { spillEl.remove(); spillEl = null; spillBg = ''; spillSize = -1; spillBlur = -1; spillShown = false; }
}

function onMove(e: PointerEvent): void {
  px = lpx = e.clientX;
  py = lpy = e.clientY;
  kick();
}

function onLeave(): void {
  px = py = Number.NaN;
  if (document.hidden) {
    if (raf !== 0) { cancelAnimationFrame(raf); raf = 0; }
    hideSpill();
    return;
  }
  kick();
}

function kick(): void {
  // 没有可显示的功能就不空转；已有光效仍走完退出时的淡出。
  if (!tracking || raf !== 0 || document.hidden || (!hasVisibleEffect() && !near)) return;
  last = performance.now();
  raf = requestAnimationFrame(step);
}

// ─── Geometry ─────────────────────────────────────────────────────────────

/**
 * Signed distance from a box-local point to the ring's outer outline
 * (positive outside), writing the nearest outline point to `out`.
 */
function nearestOutlinePoint(
  lx: number, ly: number, W: number, H: number, R: number, kind: 'pill' | 'circle', out: { x: number; y: number }
): number {
  const rr = kind === 'circle' ? Math.min(W, H) / 2 : Math.max(0, Math.min(R, Math.min(W, H) / 2));
  const cx = W / 2, cy = H / 2;
  const hx = Math.max(0, W / 2 - rr), hy = Math.max(0, H / 2 - rr);
  const qx = Math.max(-hx, Math.min(hx, lx - cx));
  const qy = Math.max(-hy, Math.min(hy, ly - cy));
  const dx = lx - cx - qx, dy = ly - cy - qy;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    out.x = cx + qx + (dx / len) * rr;
    out.y = cy + qy + (dy / len) * rr;
    return len - rr;
  }
  // Inside the straight-edged core: nearest side.
  const dl = lx, dr = W - lx, dt = ly, db = H - ly;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) { out.x = 0; out.y = ly; }
  else if (m === dr) { out.x = W; out.y = ly; }
  else if (m === dt) { out.x = lx; out.y = 0; }
  else { out.x = lx; out.y = H; }
  return -m;
}

// ─── Frame ────────────────────────────────────────────────────────────────

function ensureSpill(): HTMLDivElement {
  if (spillEl) return spillEl;
  const el = document.createElement('div');
  el.className = 'metal-fx-cursor-spill';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483000;border-radius:50%;' +
    'mix-blend-mode:plus-lighter;will-change:transform,opacity;opacity:0;display:none';
  document.body.appendChild(el);
  spillEl = el;
  return el;
}

function hideSpill(): void {
  if (!spillEl || !spillShown) return;
  spillEl.style.display = 'none';
  spillEl.style.opacity = '0';
  spillShown = false;
}

function step(now: number): void {
  raf = 0;
  if (!tracking || document.hidden) return;
  try {
    stepInner(now);
  } catch (err) {
    hideSpill();
    if (near) { near.cursorLight = null; near = null; }
    if (typeof console !== 'undefined') console.warn('metal-fx: cursor light disabled after error', err);
  }
}

function stepInner(now: number): void {
  const cfg = CURSOR_LIGHT;
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;

  // Nearest ring within reach.
  let best: MetalFxInstance | null = null;
  let u = 0;
  if (hasVisibleEffect() && SHARED && !Number.isNaN(px)) {
    let bestAbs = Number.POSITIVE_INFINITY;
    const reach = Math.max(1, cfg.reach);
    for (const inst of SHARED.instances) {
      // Paused instances retain the painted ring for light sampling.
      if (!inst.visible || !inst.canvas.isConnected) continue;
      const r = inst.canvas.getBoundingClientRect();
      if (r.width <= 0) continue;
      const o = inst.overscan;
      const k = r.width / (inst.cssWidth + 2 * o);
      const left = r.left + o * k, top = r.top + o * k;
      const rk = reach * k;
      if (px < left - rk || px > left + inst.cssWidth * k + rk || py < top - rk || py > top + inst.cssHeight * k + rk) continue;
      const lx = (px - left) / k, ly = (py - top) / k;
      const d = nearestOutlinePoint(lx, ly, inst.cssWidth, inst.cssHeight, inst.cornerRadius, inst.kind, _pt);
      const ad = Math.abs(d);
      if (ad <= reach && ad < bestAbs) {
        bestAbs = ad; best = inst;
        _near.d = d; _near.nx = _pt.x; _near.ny = _pt.y; _near.k = k; _near.left = left; _near.top = top;
      }
    }
    if (best) {
      const t = 1 - bestAbs / reach;
      u = t * t * (3 - 2 * t);
      if (best.mask) {
        // Centre the light over the text and keep its unmasked source for reflections.
        _near.nx = best.cssWidth / 2; _near.ny = best.cssHeight / 2;
        best.wantRaw = true;
      }
    }
  }

  // Envelope on the proximity weight — no pops on enter/leave/jump.
  const a = 1 - Math.exp(-(dt * 1000) / (Math.max(1, cfg.fadeMs) / 3));
  uS += (u - uS) * a;

  if (best && best !== near) {
    if (near) { near.cursorLight = null; tickInstanceGlow(near, now); }
    near = best;
  }
  if (!best && uS < 0.002) {
    uS = 0;
    if (near) { near.cursorLight = null; tickInstanceGlow(near, now); near = null; }
    hideSpill();
    return;
  }
  if (!near) return;

  // Update the ring's catch-light at pointer rate.
  if (cfg.catchLight) {
    const cl = near.cursorLight ?? (near.cursorLight = { x: 0, y: 0, w: 0 });
    cl.x = _near.nx; cl.y = _near.ny; cl.w = uS;
  } else if (near.cursorLight) {
    near.cursorLight = null;
  }
  tickInstanceGlow(near, now);

  // Draw the glint under the pointer.
  if (cfg.spill) {
    const el = ensureSpill();
    const rgb = sampleShaderRGBAt(near, _near.nx, _near.ny, 2);
    const lum = sampleShaderLumAt(near, _near.nx, _near.ny, 3);
    const peak = Math.max(rgb.r, rgb.g, rgb.b) || 1;
    const hsv = rgbToHsv((rgb.r * 255) / peak, (rgb.g * 255) / peak, (rgb.b * 255) / peak);
    const [cr, cg, cb] = hsvToRgb(hsv[0], Math.min(1, hsv[1] * cfg.spillSaturation), 1);
    _sc.r += (cr - _sc.r) * 0.15; _sc.g += (cg - _sc.g) * 0.15; _sc.b += (cb - _sc.b) * 0.15;
    // Quantise so the gradient string (and its repaint) only changes on a
    // visible step.
    const qr = Math.round(_sc.r / 6) * 6, qg = Math.round(_sc.g / 6) * 6, qb = Math.round(_sc.b / 6) * 6;
    const bg = `radial-gradient(closest-side, rgba(${qr},${qg},${qb},1) 0%, rgba(${qr},${qg},${qb},0.35) 45%, rgba(${qr},${qg},${qb},0) 100%)`;
    if (bg !== spillBg) { spillBg = bg; el.style.background = bg; }

    const R = Math.max(1, cfg.spillRadius * _near.k);
    if (R !== spillSize) { spillSize = R; el.style.width = `${(2 * R).toFixed(1)}px`; el.style.height = `${(2 * R).toFixed(1)}px`; }
    if (cfg.spillBlur !== spillBlur) { spillBlur = cfg.spillBlur; el.style.filter = cfg.spillBlur > 0 ? `blur(${cfg.spillBlur}px)` : ''; }

    const rx = _near.left + _near.nx * _near.k, ry = _near.top + _near.ny * _near.k;
    const sx = lpx + (rx - lpx) * cfg.spillOffset, sy = lpy + (ry - lpy) * cfg.spillOffset;
    el.style.transform = `translate3d(${(sx - R).toFixed(2)}px,${(sy - R).toFixed(2)}px,0)`;

    const lf = Math.min(1, Math.max(0, lum / 0.3));
    const lumMix = 1 - cfg.spillLumGain + cfg.spillLumGain * lf;
    const insideMul = _near.d < 0 ? cfg.spillInside : 1;
    const op = Math.max(0, Math.min(1, cfg.spillStrength * uS * lumMix * insideMul));
    if (!spillShown) { el.style.display = ''; spillShown = true; }
    el.style.opacity = op.toFixed(3);
  } else {
    hideSpill();
  }

  raf = requestAnimationFrame(step);
}
