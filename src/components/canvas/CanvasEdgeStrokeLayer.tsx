/**
 * CanvasEdgeStrokeLayer — 提供画布连线描边层界面与交互。
 */
import { memo, useLayoutEffect, useRef } from 'react';
import type { useStoreApi } from '@xyflow/react';
import type { CanvasSharedEdgeModel } from '../../types/canvasEdges';
import { createCanvasEdgeClipper, type CanvasEdgeClipRect } from '../../utils/canvasEdgeClipping';

type FlowStore = ReturnType<typeof useStoreApi>;
interface StrokeStyle { color: string; width: number; opacity: number }
interface CachedStrokePath {
  source: string;
  clipper: ReturnType<typeof createCanvasEdgeClipper>;
  clipVersion: number;
  renderedSource?: string;
  path: Path2D | null;
  fallback: boolean;
}

const STROKE_GUTTER = 112; // CSS pixels within the existing 128px path clip margin.
const MAX_CACHED_PIXELS = 8 * 1024 * 1024; // An overscanned RGBA backing uses at most 32 MiB.
const MAX_EXTRA_PIXELS = 2 * 1024 * 1024;
const MAX_STROKE_EDGE = 8192;

interface PaintedViewport {
  width: number; height: number; ratio: number;
  x: number; y: number; zoom: number; gutter: number;
}

/** A large or high-DPR window can always use its original, unpadded backing at native resolution. */
function getStrokeGutter(width: number, height: number, ratio: number): number {
  const viewportPixels = Math.ceil(width * ratio) * Math.ceil(height * ratio);
  const budget = Math.min(MAX_CACHED_PIXELS, viewportPixels + MAX_EXTRA_PIXELS);
  for (const gutter of [STROKE_GUTTER, STROKE_GUTTER / 2, STROKE_GUTTER / 4]) {
    const w = Math.ceil((width + 2 * gutter) * ratio);
    const h = Math.ceil((height + 2 * gutter) * ratio);
    if (w <= MAX_STROKE_EDGE && h <= MAX_STROKE_EDGE && w * h <= budget) return gutter;
  }
  return 0;
}

function containsClip(outer: CanvasEdgeClipRect, inner: CanvasEdgeClipRect): boolean {
  return outer.left <= inner.left && outer.top <= inner.top
    && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

function sameStroke(a: CanvasSharedEdgeModel, b: CanvasSharedEdgeModel): boolean {
  return a === b || (a.path === b.path && a.edge.id === b.edge.id
    && a.edge.selected === b.edge.selected && a.edge.style === b.edge.style);
}

/**
 * Anchor the overscanned bitmap in the same world coordinates as the SVG hit
 * paths. The parent viewport translates both during a pan without restroking.
 */
export default memo(function CanvasEdgeStrokeLayer({ models, store, zIndex, onUnavailable }: {
  models: readonly CanvasSharedEdgeModel[];
  store: FlowStore;
  zIndex: number;
  onUnavailable(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const normalRef = useRef<SVGPathElement>(null);
  const selectedRef = useRef<SVGPathElement>(null);
  const modelsRef = useRef(models);
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const normal = normalRef.current;
    const selected = selectedRef.current;
    const viewport = canvas?.closest<HTMLElement>('.react-flow__viewport');
    const view = canvas?.ownerDocument.defaultView;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas?.getContext('2d') ?? null; } catch { /* Fall back to SVG below. */ }
    if (!canvas || !normal || !selected || !viewport || !view || !context) {
      onUnavailable();
      return;
    }
    const ctx = context;
    const paths = new Map<string, CachedStrokePath>();
    let frame: number | null = null;
    let disposed = false;
    let failed = false;
    let styles: [StrokeStyle, StrokeStyle] | null = null;
    let media: MediaQueryList | undefined;
    let previousViewport = '';
    let clipBounds: CanvasEdgeClipRect | undefined;
    let clipVersion = 0;
    let clipScale = 0;
    let painted: PaintedViewport | undefined;
    let modelsChanged = true;
    let rasterCount = 0;

    const readStyle = (path: SVGPathElement): StrokeStyle => {
      const computed = view.getComputedStyle(path);
      return { color: computed.stroke, width: Number.parseFloat(computed.strokeWidth),
        opacity: Number.parseFloat(computed.opacity) };
    };
    const draw = (fromViewportMutation = false) => {
      if (disposed || failed) return;
      try {
        const { width, height } = store.getState();
        if (width <= 0 || height <= 0) return;
        // Read React Flow's committed transform, not a newer uncommitted Store
        // publication, so the bitmap and inverse matrix always agree.
        const matrix = new DOMMatrixReadOnly(viewport.style.transform || undefined);
        const { a: zoom, e: x, f: y } = matrix;
        if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== zoom
          || ![zoom, x, y, width, height].every(Number.isFinite) || zoom <= 0) {
          throw new Error('Unsupported canvas viewport transform');
        }
        const ratio = view.devicePixelRatio || 1;
        if (painted && !modelsChanged && styles && painted.width === width && painted.height === height
          && painted.ratio === ratio && painted.zoom === zoom) {
          // Recenter shortly before exhausting coverage so the next pan frame has room.
          const displacement = Math.max(Math.abs(x - painted.x), Math.abs(y - painted.y));
          if (displacement <= Math.max(0, painted.gutter - 16)) return;
          if (fromViewportMutation && displacement <= painted.gutter) { schedule(); return; }
        }
        const gutter = getStrokeGutter(width, height, ratio);
        const cssWidth = width + 2 * gutter;
        const cssHeight = height + 2 * gutter;
        const pixelWidth = Math.ceil(cssWidth * ratio);
        const pixelHeight = Math.ceil(cssHeight * ratio);
        // Shrink first when switching from a tall window to a wide one.
        if (canvas.height > pixelHeight) canvas.height = pixelHeight;
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.style.transform = `matrix(${1 / zoom},0,0,${1 / zoom},${-(x + gutter) / zoom},${-(y + gutter) / zoom})`;
        styles ??= [readStyle(normal), readStyle(selected)];
        const miterMargin = Math.max(...styles.map((style) => Number.isFinite(style.width) ? style.width * 2 : 0));
        const visible = { left: -x / zoom, top: -y / zoom,
          right: (width - x) / zoom, bottom: (height - y) / zoom };
        const guard = (gutter + 16) / zoom + miterMargin;
        const guarded = { left: visible.left - guard, top: visible.top - guard,
          right: visible.right + guard, bottom: visible.bottom + guard };
        // Cache a small overscan window for pan, but recrop when zoom would
        // magnify it beyond a bounded screen extent. No percentage-based LOD.
        if (!clipBounds || zoom * ratio > clipScale || (painted && painted.ratio !== ratio) || !containsClip(clipBounds, guarded)
          || (clipBounds.right - clipBounds.left) * zoom > (width + 256) * 1.5
          || (clipBounds.bottom - clipBounds.top) * zoom > (height + 256) * 1.5) {
          const margin = 128 / zoom + miterMargin;
          clipBounds = { left: visible.left - margin, top: visible.top - margin,
            right: visible.right + margin, bottom: visible.bottom + margin };
          // A clipped curve stays within half a physical pixel throughout this scale band.
          clipScale = 2 ** Math.ceil(Math.log2(zoom * ratio));
          clipVersion++;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pixelWidth, pixelHeight);
        const scaleX = pixelWidth / cssWidth;
        const scaleY = pixelHeight / cssHeight;
        ctx.setTransform(zoom * scaleX, 0, 0, zoom * scaleY, (x + gutter) * scaleX, (y + gutter) * scaleY);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 4;
        let drawn = 0;
        let culled = 0;
        let fallbacks = 0;
        for (const model of modelsRef.current) {
          const source = model.path[0];
          let cached = paths.get(model.edge.id);
          if (!cached || cached.source !== source) {
            cached = { source, clipper: createCanvasEdgeClipper(source), clipVersion: -1, path: null, fallback: false };
            paths.set(model.edge.id, cached);
          }
          const style = styles[model.edge.selected ? 1 : 0];
          if (!style.color || style.color === 'none' || !(style.width > 0) || style.opacity === 0) continue;
          if (cached.clipVersion !== clipVersion) {
            const clipped = cached.clipper?.clip(clipBounds, 0.5 / clipScale) ?? null;
            cached.fallback = clipped === null;
            const renderedSource = clipped ?? source;
            if (cached.renderedSource !== renderedSource) {
              cached.path = renderedSource ? new Path2D(renderedSource) : null;
              cached.renderedSource = renderedSource;
            }
            cached.clipVersion = clipVersion;
          }
          if (!cached.path) { culled++; continue; }
          if (cached.fallback) fallbacks++;
          ctx.strokeStyle = style.color;
          ctx.lineWidth = style.width;
          ctx.globalAlpha = Number.isFinite(style.opacity) ? style.opacity : 1;
          // Keep source-over order, including overlap of translucent edges.
          // Combining paths into one stroke would change their appearance.
          ctx.stroke(cached.path);
          drawn++;
        }
        // Aggregate, content-free diagnostics for checking the active backend.
        canvas.dataset.edgeDrawn = String(drawn);
        canvas.dataset.edgeCulled = String(culled);
        canvas.dataset.edgeClipFallbacks = String(fallbacks);
        canvas.dataset.edgeRasterCount = String(++rasterCount);
        painted = { width, height, ratio, x, y, zoom, gutter };
        modelsChanged = false;
      } catch {
        failed = true;
        onUnavailable();
      }
    };
    const schedule = () => {
      if (!disposed && !failed && frame === null) frame = view.requestAnimationFrame(() => {
        frame = null;
        draw();
      });
    };
    updateRef.current = () => {
      modelsChanged = true;
      const ids = new Set(modelsRef.current.map((model) => model.edge.id));
      for (const id of paths.keys()) if (!ids.has(id)) paths.delete(id);
      schedule();
    };
    const unsubscribe = store.subscribe((state) => {
      const key = `${state.transform.join(',')},${state.width},${state.height}`;
      if (key !== previousViewport) { previousViewport = key; schedule(); }
    });
    // A large jump may commit inside a rAF. Restore missing coverage before this paint.
    const viewportObserver = new MutationObserver(() => draw(true));
    viewportObserver.observe(viewport, { attributes: true, attributeFilter: ['style'] });
    const appearanceObserver = new MutationObserver(() => { styles = null; schedule(); });
    appearanceObserver.observe(canvas.ownerDocument.documentElement, {
      attributes: true, attributeFilter: ['style', 'data-theme', 'data-appearance-id'],
    });
    const watchPixelRatio = () => {
      media?.removeEventListener('change', watchPixelRatio);
      media = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
      media.addEventListener('change', watchPixelRatio);
      schedule();
    };
    const contextLost = () => { failed = true; onUnavailable(); };
    canvas.addEventListener('contextlost', contextLost);
    view.addEventListener('resize', schedule);
    draw();
    watchPixelRatio();
    return () => {
      disposed = true;
      unsubscribe();
      viewportObserver.disconnect();
      appearanceObserver.disconnect();
      media?.removeEventListener('change', watchPixelRatio);
      canvas.removeEventListener('contextlost', contextLost);
      view.removeEventListener('resize', schedule);
      if (frame !== null) view.cancelAnimationFrame(frame);
      updateRef.current = null;
      paths.clear();
      canvas.width = canvas.height = 0;
    };
  }, [store, onUnavailable]);

  useLayoutEffect(() => {
    const previous = modelsRef.current;
    modelsRef.current = models;
    // Endpoint wrappers crossing the viewport can change SVG interaction flags only.
    if (previous.length !== models.length || models.some((model, index) => !sameStroke(model, previous[index]))) {
      updateRef.current?.();
    }
  }, [models]);

  return <>
    <canvas ref={canvasRef} className="canvas-edge-stroke-layer" style={{ zIndex }}
      data-canvas-edge-stroke-layer="viewport" aria-hidden="true" />
    <svg className="canvas-edge-stroke-probe" aria-hidden="true">
      <g className="react-flow__edge"><path ref={normalRef} d="M0 0L1 0" className="react-flow__edge-path" /></g>
      <g className="react-flow__edge selected"><path ref={selectedRef} d="M0 0L1 0" className="react-flow__edge-path" /></g>
    </svg>
  </>;
});
