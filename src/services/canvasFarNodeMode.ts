import { isTauri } from '@tauri-apps/api/core';

export const CANVAS_FAR_NODE_MODE_KEY = 'canvas-far-layer-benchmark';
export const CANVAS_FAR_NODE_MODE_EVENT = 'ai-canvas:far-layer-benchmark';
export type CanvasFarNodeMode = 'dom' | 'unlinked' | 'canvas' | 'webgpu' | 'near';
export const CANVAS_NEAR_MEDIA_MAX_ZOOM = 1;

export function canUseCanvasFarNodeLayer(): boolean {
  return isTauri() && typeof DOMMatrixReadOnly !== 'undefined' && typeof PointerEvent !== 'undefined'
    && (import.meta.env.DEV || /^(Win|Mac)/i.test(navigator.platform));
}

export function readCanvasFarNodeMode(): CanvasFarNodeMode {
  if (import.meta.env.DEV) {
    try {
      const mode = sessionStorage.getItem(CANVAS_FAR_NODE_MODE_KEY);
      if (mode === 'dom' || mode === 'unlinked' || mode === 'webgpu' || mode === 'near') return mode;
    } catch { /* The canvas also works without session storage. */ }
  }
  return 'canvas';
}

export function subscribeCanvasFarNodeMode(listener: () => void): () => void {
  if (!import.meta.env.DEV) return () => {};
  window.addEventListener(CANVAS_FAR_NODE_MODE_EVENT, listener);
  return () => window.removeEventListener(CANVAS_FAR_NODE_MODE_EVENT, listener);
}
