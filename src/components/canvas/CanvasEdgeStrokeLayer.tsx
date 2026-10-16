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

function containsClip(outer: CanvasEdgeClipRect, inner: CanvasEdgeClipRect): boolean {
  return outer.left <= inner.left && outer.top <= inner.top
    && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

/**
 * Viewport-sized backing store, inside the existing z/order segment.
 * The inverse CSS matrix cancels the parent viewport; the context draws world
 * coordinates. Between redraws, the parent can still transform the old bitmap.
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

    const readStyle = (path: SVGPathElement): StrokeStyle => {
      const computed = view.getComputedStyle(path);
      return { color: computed.stroke, width: Number.parseFloat(computed.strokeWidth),
        opacity: Number.parseFloat(computed.opacity) };
    };
    const draw = () => {
      frame = null;
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
        const pixelWidth = Math.ceil(width * ratio);
        const pixelHeight = Math.ceil(height * ratio);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.style.transform = `matrix(${1 / zoom},0,0,${1 / zoom},${-x / zoom},${-y / zoom})`;
        styles ??= [readStyle(normal), readStyle(selected)];
        const miterMargin = Math.max(...styles.map((style) => Number.isFinite(style.width) ? style.width * 2 : 0));
        const visible = { left: -x / zoom, top: -y / zoom,
          right: (width - x) / zoom, bottom: (height - y) / zoom };
        const guard = 16 / zoom + miterMargin;
        const guarded = { left: visible.left - guard, top: visible.top - guard,
          right: visible.right + guard, bottom: visible.bottom + guard };
        // Cache a small overscan window for pan, but recrop when zoom would
        // magnify it beyond a bounded screen extent. No percentage-based LOD.
        if (!clipBounds || !containsClip(clipBounds, guarded)
          || (clipBounds.right - clipBounds.left) * zoom > (width + 256) * 1.5
          || (clipBounds.bottom - clipBounds.top) * zoom > (height + 256) * 1.5) {
          const margin = 128 / zoom + miterMargin;
          clipBounds = { left: visible.left - margin, top: visible.top - margin,
            right: visible.right + margin, bottom: visible.bottom + margin };
          clipVersion++;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pixelWidth, pixelHeight);
        ctx.setTransform(zoom * ratio, 0, 0, zoom * ratio, x * ratio, y * ratio);
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
            const clipped = cached.clipper?.clip(clipBounds, 0.5 / (zoom * ratio)) ?? null;
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
      } catch {
        failed = true;
        onUnavailable();
      }
    };
    const schedule = () => {
      if (!disposed && !failed && frame === null) frame = view.requestAnimationFrame(draw);
    };
    updateRef.current = () => {
      const ids = new Set(modelsRef.current.map((model) => model.edge.id));
      for (const id of paths.keys()) if (!ids.has(id)) paths.delete(id);
      schedule();
    };
    const unsubscribe = store.subscribe((state) => {
      const key = `${state.transform.join(',')},${state.width},${state.height}`;
      if (key !== previousViewport) { previousViewport = key; schedule(); }
    });
    const viewportObserver = new MutationObserver(schedule);
    viewportObserver.observe(viewport, { attributes: true, attributeFilter: ['style'] });
    const appearanceObserver = new MutationObserver(() => { styles = null; schedule(); });
    appearanceObserver.observe(canvas.ownerDocument.documentElement, {
      attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-appearance-id'],
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
    modelsRef.current = models;
    updateRef.current?.();
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
