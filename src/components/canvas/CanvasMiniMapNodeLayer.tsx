import { useLayoutEffect, useRef } from 'react';
import { useStoreApi, type MiniMapProps, type Node, type ReactFlowState, type Rect } from '@xyflow/react';
import { createFrameCoalescer } from '../../utils/frameCoalescer';

interface MiniMapNodeGeometry {
  getViewportRevision(state: ReactFlowState): object;
  getNodeDimensions(node: Node): Pick<Rect, 'width' | 'height'>;
  nodeHasDimensions(node: Node): boolean;
}

interface CanvasMiniMapNodeLayerProps extends Pick<MiniMapProps, 'nodeColor' | 'nodeStrokeColor' | 'nodeStrokeWidth' | 'nodeBorderRadius'> {
  geometry: MiniMapNodeGeometry;
  width: number;
  height: number;
}

function readNodes(state: ReactFlowState, geometry: MiniMapNodeGeometry) {
  const nodes: Array<{ rect: Rect; node: Node }> = [];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { id } of state.nodes) {
    const internal = state.nodeLookup.get(id);
    if (!internal) continue;
    const { userNode: node, positionAbsolute: { x, y } } = internal.internals;
    if (node.hidden || !geometry.nodeHasDimensions(node)) continue;
    const { width, height } = geometry.getNodeDimensions(node);
    if (width <= 0 || height <= 0 || ![x, y, x + width, y + height].every(Number.isFinite)) continue;
    nodes.push({ rect: { x, y, width, height }, node });
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  return { nodes, left, top, right, bottom };
}

export default function CanvasMiniMapNodeLayer({ geometry, width, height, nodeColor, nodeStrokeColor,
  nodeStrokeWidth = 0, nodeBorderRadius = 0 }: CanvasMiniMapNodeLayerProps) {
  const store = useStoreApi();
  const surfaceRef = useRef<SVGForeignObjectElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const probeRef = useRef<SVGRectElement>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    const probe = probeRef.current;
    const view = canvas?.ownerDocument.defaultView;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas?.getContext('2d') ?? null; } catch { /* Navigation remains available without the bitmap. */ }
    if (!surface || !canvas || !view || !probe || !ctx || typeof ctx.roundRect !== 'function') return;

    const context = ctx;
    const colors = new Map<string, string>();
    let resolution: MediaQueryList | undefined;
    let contextLost = false;
    let revision = geometry.getViewportRevision(store.getState());
    const clear = () => {
      if (canvas.width || canvas.height) canvas.width = canvas.height = 0;
    };
    const resolveColor = (property: 'fill' | 'stroke', value: string) => {
      const key = `${property}:${value}`;
      const cached = colors.get(key);
      if (cached !== undefined) return cached;
      // Resolve the same CSS tokens, including color-mix and custom themes, as the SVG rectangles.
      probe.style.removeProperty(property);
      probe.style.setProperty(property, value);
      const color = view.getComputedStyle(probe).getPropertyValue(property);
      colors.set(key, color);
      return color;
    };
    const draw = () => {
      if (contextLost) return;
      try {
        const { nodes, left, top, right, bottom } = readNodes(store.getState(), geometry);
        if (nodes.length === 0) {
          clear();
          return;
        }

        // Keep a minimap-sized bitmap anchored to the nodes. The native SVG viewBox
        // reprojects it as the main camera moves, even beyond the graph bounds.
        const padding = 1 + nodeStrokeWidth / 2;
        const scale = Math.max((right - left + 2 * padding) / width, (bottom - top + 2 * padding) / height);
        const x = left - (scale * width - (right - left)) / 2;
        const y = top - (scale * height - (bottom - top)) / 2;
        if (![scale, x, y].every(Number.isFinite) || scale <= 0) throw new Error('Invalid minimap bitmap bounds');
        const dpr = view.devicePixelRatio || 1;
        const pixelWidth = Math.ceil(width * dpr);
        const pixelHeight = Math.ceil(height * dpr);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        context.resetTransform();
        context.clearRect(0, 0, pixelWidth, pixelHeight);
        context.setTransform(pixelWidth / width / scale, 0, 0, pixelHeight / height / scale, 0, 0);
        context.lineWidth = nodeStrokeWidth;
        for (const { rect, node } of nodes) {
          const fill = typeof nodeColor === 'function' ? nodeColor(node) : nodeColor;
          const stroke = typeof nodeStrokeColor === 'function' ? nodeStrokeColor(node) : nodeStrokeColor;
          context.beginPath();
          context.roundRect(rect.x - x, rect.y - y, rect.width, rect.height, {
            x: Math.min(nodeBorderRadius, rect.width / 2),
            y: Math.min(nodeBorderRadius, rect.height / 2),
          });
          // Use the native order and composite each translucent node separately.
          const computedFill = resolveColor('fill', String(fill || node.style?.background || node.style?.backgroundColor || ''));
          if (computedFill && computedFill !== 'none') {
            context.fillStyle = computedFill;
            context.fill();
          }
          const computedStroke = resolveColor('stroke', stroke ?? '');
          if (nodeStrokeWidth > 0 && computedStroke && computedStroke !== 'none') {
            context.strokeStyle = computedStroke;
            context.stroke();
          }
        }
        surface.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
      } catch { clear(); }
    };
    const frame = createFrameCoalescer(draw);
    const schedule = () => { if (!contextLost) frame.schedule(undefined); };
    const unsubscribe = store.subscribe((state) => {
      const nextRevision = geometry.getViewportRevision(state);
      if (nextRevision === revision) return;
      revision = nextRevision;
      schedule();
    });
    const appearance = new MutationObserver(() => { colors.clear(); schedule(); });
    appearance.observe(canvas.ownerDocument.documentElement, {
      // The appearance runtime publishes colors through these attributes. Dragging toggles only a class.
      attributes: true, attributeFilter: ['style', 'data-theme', 'data-appearance-id'],
    });
    const watchResolution = () => {
      resolution?.removeEventListener('change', onResolutionChange);
      resolution = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
      resolution.addEventListener('change', onResolutionChange);
    };
    const onResolutionChange = () => { watchResolution(); schedule(); };
    const onContextLost = () => { contextLost = true; frame.cancel(); };
    const onContextRestored = () => { contextLost = false; schedule(); };
    canvas.addEventListener('contextlost', onContextLost);
    canvas.addEventListener('contextrestored', onContextRestored);
    watchResolution();
    draw();
    return () => {
      unsubscribe();
      frame.cancel();
      appearance.disconnect();
      resolution?.removeEventListener('change', onResolutionChange);
      canvas.removeEventListener('contextlost', onContextLost);
      canvas.removeEventListener('contextrestored', onContextRestored);
      clear();
    };
  }, [geometry, height, nodeBorderRadius, nodeColor, nodeStrokeColor, nodeStrokeWidth, store, width]);

  return <>
    <rect ref={probeRef} className="react-flow__minimap-node" display="none" aria-hidden="true" />
    <foreignObject ref={surfaceRef} width={width} height={height} pointerEvents="none" aria-hidden="true">
      <canvas ref={canvasRef} className="block h-full w-full" width={0} height={0} />
    </foreignObject>
  </>;
}
