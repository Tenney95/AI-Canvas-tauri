import type { CanvasEdgeModel, CanvasSharedEdgeModel } from '../types/canvasEdges';
import { createCanvasEdgeClipper } from './canvasEdgeClipping';

type Point = { x: number; y: number };
type ScreenMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };

/** The committed SVG matrix includes the viewport, container offset and page scale. */
export function canvasEdgePointer(point: Point, matrix: ScreenMatrix) {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const zoom = Math.hypot(matrix.a, matrix.b);
  if (![point.x, point.y, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f,
    determinant, zoom].every(Number.isFinite)
    || determinant === 0 || zoom <= 0) return null;
  const x = point.x - matrix.e;
  const y = point.y - matrix.f;
  return { point: { x: (matrix.d * x - matrix.c * y) / determinant,
    y: (matrix.a * y - matrix.b * x) / determinant }, zoom };
}

/** Wide SVG strokes only nominate candidates; distance chooses the visible line. */
export function createCanvasEdgePicker() {
  let cachedModels: readonly CanvasEdgeModel[] | undefined;
  const paths = new Map<string, { source: string; geometry: ReturnType<typeof createCanvasEdgeClipper> }>();
  return (models: readonly CanvasEdgeModel[], point: Point, zoom: number): CanvasSharedEdgeModel | undefined => {
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    if (models !== cachedModels) {
      const ids = new Set(models.filter((model) => model.kind === 'shared').map((model) => model.edge.id));
      for (const id of paths.keys()) if (!ids.has(id)) paths.delete(id);
      cachedModels = models;
    }
    let picked: CanvasSharedEdgeModel | undefined;
    let nearest = Infinity;
    for (const model of models) {
      if (model.kind !== 'shared') continue;
      const source = model.path[0];
      let cached = paths.get(model.edge.id);
      if (!cached || cached.source !== source) {
        cached = { source, geometry: createCanvasEdgeClipper(source) };
        paths.set(model.edge.id, cached);
      }
      const radius = (model.props.interactionWidth ?? 20) / 2;
      const distance = cached.geometry?.distance(point, Math.min(radius, nearest + 0.1 / zoom), 0.1 / zoom);
      if (distance == null || distance > nearest) continue;
      // At an exact overlap retain paint order, including elevated selected edges.
      if (distance === nearest && picked && model.zIndex < picked.zIndex) continue;
      nearest = distance;
      picked = model;
    }
    return picked;
  };
}
