export const CANVAS_FAR_NODE_MODE_KEY = 'canvas-far-layer-benchmark';
export const CANVAS_FAR_NODE_MODE_EVENT = 'ai-canvas:far-layer-benchmark';

// Developer opt-in for one WebView. Keep the device's native touch report intact.
let mouseOnly = false;

export const isCanvasFarNodeMouseOnly = () => mouseOnly;

export function canvasFarNodeRequiresNativeTouch() {
  return navigator.maxTouchPoints > 0 && !mouseOnly;
}

export function setCanvasFarNodeMouseOnly(enabled: boolean) {
  if (!import.meta.env.DEV || mouseOnly === enabled) return;
  mouseOnly = enabled;
  window.dispatchEvent(new Event(CANVAS_FAR_NODE_MODE_EVENT));
}
