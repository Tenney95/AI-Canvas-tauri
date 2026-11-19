import { memo, useLayoutEffect, useRef } from 'react';
import type { useStoreApi } from '@xyflow/react';
import type { CanvasNodeLodRuntime } from '../../services/canvasNodeLodRuntime';
import { getPerformanceModeBudget, subscribePerformanceMode } from '../../services/performanceModeRuntime';
import { createFrameCoalescer } from '../../utils/frameCoalescer';
import { CANVAS_NODE_Z_INDEX } from '../../utils/canvasElementLayering';
import { acquireCachedCanvasImagePreview, acquireCanvasImagePreview } from '../nodes/shared/image/canvasImagePreviewCache';
import { acquireCanvasVideoPoster } from '../nodes/shared/video/canvasVideoPreviewCache';
import type { FarNodeGpuCard, FarNodeWebGpu } from './canvasFarNodeWebGpu';

export interface CanvasFarNodeCard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source: string;
  image: boolean;
}

interface Props {
  cards: readonly CanvasFarNodeCard[];
  store: ReturnType<typeof useStoreApi>;
  projectId: string | null;
  runtime: CanvasNodeLodRuntime;
  webGpuRequested: boolean;
  onUnavailable(): void;
  onPreviewError(source: string, image: boolean): void;
}

interface Preview {
  controller: AbortController;
  cancel?: () => void;
  release?: () => void;
  image?: HTMLImageElement;
  ready: boolean;
  lastUsed: number;
}

interface CardStyle { background: string; stroke: string; radius: number }

interface BitmapWindow {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cssWidth: number;
  cssHeight: number;
  zoom: number;
  ratio: number;
}

const BITMAP_GUTTER = 288;
const BITMAP_REDRAW_MARGIN = 44;
const BITMAP_MAX_EDGE = 4096;
const GPU_INIT_TIMEOUT_MS = 8000;
const BITMAP_CLASS = 'pointer-events-none absolute left-0 top-0 origin-top-left';

function setCardStyle(ctx: CanvasRenderingContext2D, style: CardStyle) {
  ctx.fillStyle = style.background;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1;
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  card: Pick<CanvasFarNodeCard, 'x' | 'y' | 'width' | 'height'>,
  style: CardStyle,
  image?: HTMLImageElement,
) {
  const { x, y, width, height } = card;
  const radius = Math.min(style.radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
  if (width > 1 && height > 1) {
    // The DOM preview uses a one-world-pixel inset shadow below the image.
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, Math.max(0, radius - 0.5));
    ctx.stroke();
  }
  if (!image) return;
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const imageWidth = image.naturalWidth * scale;
  const imageHeight = image.naturalHeight * scale;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.clip();
  ctx.drawImage(image, x + (width - imageWidth) / 2, y + (height - imageHeight) / 2, imageWidth, imageHeight);
  ctx.restore();
}

/** The viewport moves and scales one reusable world-space bitmap between rasterizations. */
export default memo(function CanvasFarNodeBitmap({
  cards, store, projectId, runtime, webGpuRequested, onUnavailable, onPreviewError,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef(cards);
  const redrawRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const gpuCanvas = gpuCanvasRef.current;
    const probe = probeRef.current;
    const viewport = canvas?.closest<HTMLElement>('.react-flow__viewport');
    const view = canvas?.ownerDocument.defaultView;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas?.getContext('2d') ?? null; } catch { /* Restore DOM below. */ }
    if (!canvas || !probe || !viewport || !view || !context || typeof context.roundRect !== 'function') {
      onUnavailable();
      return;
    }

    const ctx = context;
    const previews = new Map<string, Preview>();
    const wanted = new Set<string>();
    let style: CardStyle | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let resolution: MediaQueryList | undefined;
    let stopped = false;
    let bitmap: BitmapWindow | undefined;
    let dirty = true;
    let rasterCount = 0;
    let projectedCards: typeof cards | undefined;
    let keyedCards: Array<{ card: CanvasFarNodeCard; key: string }> = [];
    const gpuAbort = new AbortController();
    let gpu: FarNodeWebGpu | undefined;
    let gpuTimeout: number | undefined;
    let gpuStatus = 'off';
    let gpuReason = '';
    let presentedCanvas = canvas;

    const reportGpuStatus = () => {
      if (presentedCanvas.dataset.webgpuStatus !== gpuStatus) presentedCanvas.dataset.webgpuStatus = gpuStatus;
      if (gpuReason) {
        if (presentedCanvas.dataset.webgpuReason !== gpuReason) presentedCanvas.dataset.webgpuReason = gpuReason;
      } else if (presentedCanvas.dataset.webgpuReason !== undefined) {
        delete presentedCanvas.dataset.webgpuReason;
      }
    };

    const present = (target: HTMLCanvasElement) => {
      if (target !== presentedCanvas) {
        presentedCanvas.hidden = true;
        delete presentedCanvas.dataset.canvasFarLayer;
        presentedCanvas = target;
        target.hidden = false;
        target.dataset.canvasFarLayer = 'viewport';
      }
      const backend = target === canvas ? 'canvas2d' : 'webgpu';
      if (target.dataset.canvasFarBackend !== backend) target.dataset.canvasFarBackend = backend;
      reportGpuStatus();
    };

    const useCanvas2d = (reason: string) => {
      if (stopped || gpuAbort.signal.aborted) return;
      gpuAbort.abort();
      view.clearTimeout(gpuTimeout);
      gpu?.destroy();
      gpu = undefined;
      gpuStatus = 'failed';
      gpuReason = reason;
      reportGpuStatus();
      dirty = true;
      schedule();
    };

    const disposePreview = (key: string, entry: Preview) => {
      previews.delete(key);
      entry.cancel?.();
      entry.controller.abort();
      entry.image?.removeAttribute('src');
      entry.release?.();
    };

    const pruneIdle = (now: number) => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
      const budget = getPerformanceModeBudget();
      const idle: Array<{ key: string; entry: Preview; bytes: number }> = [];
      let idleBytes = 0;
      for (const [key, entry] of previews) {
        if (wanted.has(key)) continue;
        if (!entry.ready || now - entry.lastUsed >= budget.previewIdleMs) {
          disposePreview(key, entry);
          continue;
        }
        const bytes = (entry.image?.naturalWidth ?? 0) * (entry.image?.naturalHeight ?? 0) * 4;
        idle.push({ key, entry, bytes });
        idleBytes += bytes;
      }
      if (!idle.length) return;
      idle.sort((a, b) => a.entry.lastUsed - b.entry.lastUsed);
      const maxEntries = budget.imageIdleEntries + budget.videoIdleEntries;
      const maxBytes = budget.imageIdleBytes + budget.videoIdleBytes;
      let index = 0;
      while (index < idle.length && (idle.length - index > maxEntries || idleBytes > maxBytes)) {
        const { key, entry, bytes } = idle[index++];
        disposePreview(key, entry);
        idleBytes -= bytes;
      }
      if (idle[index]) {
        idleTimer = setTimeout(() => pruneIdle(Date.now()), Math.max(1, idle[index].entry.lastUsed + budget.previewIdleMs - now));
      }
    };

    const requestPreview = (key: string, card: CanvasFarNodeCard, now: number): Preview => {
      const previous = previews.get(key);
      if (previous) {
        previous.lastUsed = now;
        return previous;
      }
      const entry: Preview = { controller: new AbortController(), ready: false, lastUsed: now };
      previews.set(key, entry);
      const { signal } = entry.controller;
      entry.cancel = runtime.prepareDisplay(entry, async () => {
        try {
          const lease = card.image
            ? acquireCachedCanvasImagePreview(card.source, 256, signal, projectId)
              ?? await acquireCanvasImagePreview(card.source, 256, signal, projectId)
            : await acquireCanvasVideoPoster(card.source, signal);
          if (stopped || signal.aborted) { lease?.release(); return; }
          if (!lease) throw new Error('Preview is unavailable');
          entry.release = lease.release;
          const image = canvas.ownerDocument.createElement('img');
          entry.image = image;
          image.decoding = 'async';
          image.src = lease.src;
          await image.decode();
          if (stopped || signal.aborted) return;
          if (!image.naturalWidth || !image.naturalHeight) throw new Error('Preview has no image content');
          entry.ready = true;
          dirty = true;
          schedule();
        } catch {
          if (stopped || signal.aborted) return;
          disposePreview(key, entry);
          if (cardsRef.current.some((candidate) => candidate.source === card.source && candidate.image === card.image)) {
            onPreviewError(card.source, card.image);
          }
        }
      }, card.id);
      return entry;
    };

    const draw = () => {
      if (stopped) return;
      try {
        const { width, height } = store.getState();
        if (!(width > 0 && height > 0)) return;
        // This inline transform belongs to the committed tree, even if the Store is a frame ahead.
        const transform = viewport.style.transform;
        const matrix = new DOMMatrixReadOnly(transform || undefined);
        const { a: zoom, e: x, f: y } = matrix;
        if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== zoom
          || ![zoom, x, y, width, height].every(Number.isFinite) || zoom <= 0) {
          throw new Error('Unsupported canvas viewport transform');
        }
        const ratio = view.devicePixelRatio || 1;
        const left = -x / zoom, top = -y / zoom;
        const right = (width - x) / zoom, bottom = (height - y) / zoom;
        const guard = BITMAP_REDRAW_MARGIN / zoom;
        const covered = bitmap && bitmap.ratio === ratio && zoom >= bitmap.zoom * 0.6 && zoom <= bitmap.zoom * 1.55
          && left - guard >= bitmap.left && top - guard >= bitmap.top
          && right + guard <= bitmap.right && bottom + guard <= bitmap.bottom;
        if (covered && !dirty && projectedCards === cardsRef.current) return;

        if (!bitmap || !covered) {
          const gutter = BITMAP_GUTTER / zoom;
          bitmap = {
            left: left - gutter, top: top - gutter,
            right: right + gutter, bottom: bottom + gutter,
            cssWidth: width + 2 * BITMAP_GUTTER, cssHeight: height + 2 * BITMAP_GUTTER,
            zoom, ratio,
          };
          for (const target of [canvas, gpuCanvas]) {
            if (!target) continue;
            target.style.width = `${bitmap.cssWidth}px`;
            target.style.height = `${bitmap.cssHeight}px`;
            target.style.transform = `translate(${bitmap.left}px,${bitmap.top}px) scale(${1 / bitmap.zoom})`;
          }
        }
        const raster = bitmap;
        const renderRatio = Math.min(ratio, BITMAP_MAX_EDGE / Math.max(raster.cssWidth, raster.cssHeight));
        const pixelWidth = Math.min(BITMAP_MAX_EDGE, Math.ceil(raster.cssWidth * renderRatio));
        const pixelHeight = Math.min(BITMAP_MAX_EDGE, Math.ceil(raster.cssHeight * renderRatio));
        if (!style) {
          const computed = view.getComputedStyle(probe);
          style = {
            background: computed.backgroundColor,
            stroke: computed.getPropertyValue('--canvas-edge').trim(),
            radius: Math.max(0, Number.parseFloat(computed.borderTopLeftRadius) || 0),
          };
        }
        const cardStyle = style;
        const scaleX = raster.zoom * pixelWidth / raster.cssWidth;
        const scaleY = raster.zoom * pixelHeight / raster.cssHeight;
        const gpuCards: FarNodeGpuCard[] | null = gpu && gpuCanvas ? [] : null;
        if (!gpuCards) {
          if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
          if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, pixelWidth, pixelHeight);
          ctx.setTransform(scaleX, 0, 0, scaleY, -raster.left * scaleX, -raster.top * scaleY);
          setCardStyle(ctx, cardStyle);
        }

        if (projectedCards !== cardsRef.current) {
          projectedCards = cardsRef.current;
          keyedCards = projectedCards.map((card) => ({ card, key: `${card.image ? 'image' : 'video'}:${card.source}` }));
        }
        const now = Date.now();
        let rendered = 0, ready = 0;
        wanted.clear();
        for (const { card, key } of keyedCards) {
          const cardRight = card.x + card.width, cardBottom = card.y + card.height;
          if (cardRight <= raster.left || card.x >= raster.right
            || cardBottom <= raster.top || card.y >= raster.bottom) continue;
          wanted.add(key);
          const entry = requestPreview(key, card, now);
          const image = entry.ready ? entry.image : undefined;
          if (gpuCards) gpuCards.push({ ...card, textureKey: key, image });
          else drawCard(ctx, card, cardStyle, image);
          rendered++;
          if (entry.ready) ready++;
        }
        pruneIdle(now);
        if (gpuCards && gpu && gpuCanvas) {
          const candidate = gpu;
          try {
            candidate.draw({
              width: pixelWidth, height: pixelHeight, left: raster.left, top: raster.top,
              scaleX, scaleY, styleToken: cardStyle, cards: gpuCards,
            }, (tile, item) => {
              setCardStyle(tile, cardStyle);
              drawCard(tile, { ...item, x: 0, y: 0 }, cardStyle, item.image);
            });
          } catch {
            useCanvas2d('gpu-render');
            return;
          }
          if (gpu !== candidate) return;
          gpuStatus = 'active';
          present(gpuCanvas);
          if (canvas.width || canvas.height) canvas.width = canvas.height = 0;
        } else {
          present(canvas);
        }
        const renderedCount = String(rendered);
        const readyCount = String(ready);
        if (presentedCanvas.dataset.renderedNodeCount !== renderedCount) {
          presentedCanvas.dataset.renderedNodeCount = renderedCount;
          presentedCanvas.dataset.previewTargetCount = renderedCount;
        }
        if (presentedCanvas.dataset.previewReadyCount !== readyCount) presentedCanvas.dataset.previewReadyCount = readyCount;
        presentedCanvas.dataset.bitmapRasterCount = String(++rasterCount);
        dirty = false;
      } catch { fail(); }
    };
    const frame = createFrameCoalescer(draw);
    const schedule = () => { if (!stopped) frame.schedule(undefined); };
    const fail = () => {
      if (stopped) return;
      stopped = true;
      frame.cancel();
      onUnavailable();
    };
    redrawRef.current = schedule;
    const unsubscribe = store.subscribe((current, previous) => {
      if (current.width !== previous.width || current.height !== previous.height) schedule();
    });
    const viewportObserver = new MutationObserver(schedule);
    viewportObserver.observe(viewport, { attributes: true, attributeFilter: ['style'] });
    const appearanceObserver = new MutationObserver(() => { style = null; dirty = true; schedule(); });
    appearanceObserver.observe(canvas.ownerDocument.documentElement, {
      attributes: true, attributeFilter: ['style', 'data-theme', 'data-appearance-id'],
    });
    const unsubscribeMode = subscribePerformanceMode(() => { pruneIdle(Date.now()); schedule(); });
    const watchResolution = () => {
      resolution?.removeEventListener('change', watchResolution);
      resolution = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
      resolution.addEventListener('change', watchResolution);
      schedule();
    };
    watchResolution();
    view.addEventListener('resize', schedule);
    canvas.addEventListener('contextlost', fail);
    if (import.meta.env.DEV && gpuCanvas && webGpuRequested) {
      if (!/^win/i.test(view.navigator.platform || '')) {
        gpuStatus = 'unsupported';
        gpuReason = 'windows-only';
      } else if (!('gpu' in view.navigator)) {
        gpuStatus = 'unsupported';
        gpuReason = 'webgpu-unavailable';
      } else {
        gpuStatus = 'initializing';
        gpuTimeout = view.setTimeout(() => useCanvas2d('gpu-init-timeout'), GPU_INIT_TIMEOUT_MS);
        void import('./canvasFarNodeWebGpu')
          .then(({ createFarNodeWebGpu }) =>
            createFarNodeWebGpu(gpuCanvas, gpuAbort.signal, () => useCanvas2d('gpu-device-error')))
          .then((backend) => {
            view.clearTimeout(gpuTimeout);
            if (stopped || gpuAbort.signal.aborted) { backend.destroy(); return; }
            gpu = backend;
            dirty = true;
            schedule();
          }, () => useCanvas2d('gpu-init'));
      }
    }
    reportGpuStatus();
    draw();
    return () => {
      stopped = true;
      gpuAbort.abort();
      view.clearTimeout(gpuTimeout);
      gpu?.destroy();
      // The fallback element is reused after a backend switch.
      canvas.hidden = false;
      canvas.dataset.canvasFarLayer = 'viewport';
      redrawRef.current = null;
      frame.cancel();
      unsubscribe();
      unsubscribeMode();
      viewportObserver.disconnect();
      appearanceObserver.disconnect();
      resolution?.removeEventListener('change', watchResolution);
      view.removeEventListener('resize', schedule);
      canvas.removeEventListener('contextlost', fail);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      for (const [key, entry] of previews) disposePreview(key, entry);
      canvas.width = canvas.height = 0;
      if (gpuCanvas) {
        gpuCanvas.width = gpuCanvas.height = 0;
        gpuCanvas.hidden = true;
        delete gpuCanvas.dataset.canvasFarLayer;
      }
    };
  }, [onPreviewError, onUnavailable, projectId, runtime, store, webGpuRequested]);

  useLayoutEffect(() => {
    cardsRef.current = cards;
    redrawRef.current?.();
  }, [cards]);

  return <>
    <canvas ref={canvasRef} className={BITMAP_CLASS}
      style={{ zIndex: CANVAS_NODE_Z_INDEX }} width={0} height={0} data-canvas-far-layer="viewport"
      data-canvas-far-backend="canvas2d" aria-hidden="true" />
    {import.meta.env.DEV && webGpuRequested && <canvas ref={gpuCanvasRef} className={BITMAP_CLASS}
      style={{ zIndex: CANVAS_NODE_Z_INDEX }} width={0} height={0} hidden aria-hidden="true" />}
    <div ref={probeRef} className="canvas-node-lod-preview hidden" aria-hidden="true" />
  </>;
});
