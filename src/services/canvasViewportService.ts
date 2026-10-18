/**
 * 定义画布平移动画事件协议，让浮层和编辑器通过统一事件请求视口位移。
 */
export const CANVAS_PAN_BY_EVENT = 'canvas-pan-by';
export const CANVAS_PAN_DURATION_MS = 280;

export interface CanvasPanProgress {
  deltaX: number;
  deltaY: number;
}

export interface CanvasPanByDetail {
  deltaX: number;
  deltaY: number;
  duration?: number;
  onProgress?: (progress: CanvasPanProgress) => void;
  onComplete?: (progress: CanvasPanProgress) => void;
}

export interface CanvasViewportSnapshot {
  x: number;
  y: number;
  zoom: number;
  visibleBounds: { x: number; y: number; width: number; height: number };
}

export interface CanvasViewportController {
  getSnapshot: () => CanvasViewportSnapshot;
  setViewport: (viewport: { x: number; y: number; zoom: number }, duration?: number) => Promise<void>;
  fitView: (options?: { nodeIds?: string[]; padding?: number; duration?: number }) => Promise<void>;
  rememberViewport?: () => void;
}

let viewportController: CanvasViewportController | null = null;

export function registerCanvasViewportController(controller: CanvasViewportController): () => void {
  viewportController = controller;
  return () => {
    if (viewportController === controller) viewportController = null;
  };
}

export function getCanvasViewportController(): CanvasViewportController | null {
  return viewportController;
}

export function requestCanvasPanBy(detail: CanvasPanByDetail) {
  window.dispatchEvent(new CustomEvent<CanvasPanByDetail>(CANVAS_PAN_BY_EVENT, { detail }));
}
