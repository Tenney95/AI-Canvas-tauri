import type { Viewport } from '@xyflow/react';
import type { AppConfig } from '../types';
import { getCanvasLockedZoom, normalizeCanvasZoom } from '../utils/canvasViewportPreferences';

export interface SavedCanvasViewport extends Viewport {
  width: number;
  height: number;
}

const STORAGE_PREFIX = 'ai-canvas.viewport.v1:';

function isSavedViewport(value: unknown): value is SavedCanvasViewport {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SavedCanvasViewport>;
  return [record.x, record.y, record.zoom, record.width, record.height]
    .every((item) => typeof item === 'number' && Number.isFinite(item))
    && record.zoom! > 0 && record.width! > 0 && record.height! > 0;
}

/** 本机每张画布的浏览位置，不进入项目文件、共享资产或撤销历史。 */
export function readCanvasViewport(projectId: string | null): SavedCanvasViewport | null {
  if (!projectId) return null;
  try {
    const raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${projectId}`);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isSavedViewport(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveCanvasViewport(projectId: string, viewport: SavedCanvasViewport): void {
  if (!projectId || !isSavedViewport(viewport)) return;
  try {
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(viewport));
  } catch {
    // 位置偏好不可写不阻断画布操作或项目保存。
  }
}

/** 窗口尺寸或缩放约束变化后，仍保持上次浏览的画布中心。 */
export function restoreCanvasViewport(
  saved: SavedCanvasViewport,
  size: { width: number; height: number },
  config: Pick<AppConfig, 'canvasViewportMode' | 'canvasViewportZoom' | 'canvasViewportMinZoom' | 'canvasViewportMaxZoom'>,
): Viewport {
  const zoom = getCanvasLockedZoom(config) ?? normalizeCanvasZoom(saved.zoom, config);
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : saved.width;
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : saved.height;
  return {
    x: width / 2 - (saved.width / 2 - saved.x) / saved.zoom * zoom,
    y: height / 2 - (saved.height / 2 - saved.y) / saved.zoom * zoom,
    zoom,
  };
}
