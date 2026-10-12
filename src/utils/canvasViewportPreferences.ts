import type { FitViewOptions } from '@xyflow/react';
import type { AppConfig, CanvasViewportMode } from '../types';

export const MIN_CANVAS_ZOOM = 0.1;
export const MAX_CANVAS_ZOOM = 5;
export const CANVAS_ZOOM_PRESETS = [10, 25, 35, 50, 75, 100, 150, 200, 300, 500];

type CanvasZoomRangeConfig = Pick<AppConfig, 'canvasViewportMinZoom' | 'canvasViewportMaxZoom'>;
type CanvasViewportConfig = CanvasZoomRangeConfig & Pick<AppConfig, 'canvasViewportMode' | 'canvasViewportZoom'>;

export function normalizeCanvasViewportMode(mode: unknown): CanvasViewportMode {
  return mode === 'manual' || mode === 'locked' ? mode : 'auto';
}

function clampAbsoluteZoom(zoom: unknown, fallback: number): number {
  return typeof zoom === 'number' && Number.isFinite(zoom)
    ? Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, zoom))
    : fallback;
}

/** 设置以整数百分比保存；缺失值沿用旧范围，异常顺序安全回落为有序范围。 */
export function getCanvasZoomRange(config: CanvasZoomRangeConfig) {
  const first = Math.round(clampAbsoluteZoom(config.canvasViewportMinZoom, MIN_CANVAS_ZOOM) * 100) / 100;
  const second = Math.round(clampAbsoluteZoom(config.canvasViewportMaxZoom, MAX_CANVAS_ZOOM) * 100) / 100;
  return { minZoom: Math.min(first, second), maxZoom: Math.max(first, second) };
}

export function normalizeCanvasZoom(zoom: unknown, config: CanvasZoomRangeConfig = {}): number {
  const { minZoom, maxZoom } = getCanvasZoomRange(config);
  return Math.min(maxZoom, Math.max(minZoom, clampAbsoluteZoom(zoom, 1)));
}

/** 预设只包含范围内的比例，同时保留自定义范围的两个端点。 */
export function getCanvasZoomPresets(config: CanvasZoomRangeConfig): number[] {
  const { minZoom, maxZoom } = getCanvasZoomRange(config);
  const minPercent = Math.round(minZoom * 100);
  const maxPercent = Math.round(maxZoom * 100);
  return [...new Set([minPercent, ...CANVAS_ZOOM_PRESETS.filter((percent) => percent >= minPercent && percent <= maxPercent), maxPercent])]
    .sort((a, b) => a - b);
}

export function getCanvasLockedZoom(config: CanvasViewportConfig): number | null {
  return normalizeCanvasViewportMode(config.canvasViewportMode) === 'locked'
    ? normalizeCanvasZoom(config.canvasViewportZoom, config) : null;
}

/** 所有定位入口都尊重锁定；项目首次显示还要恢复手动比例。 */
export function getCanvasFitViewOptions(
  config: CanvasViewportConfig,
  options: FitViewOptions = {},
  restorePreference = false,
): FitViewOptions {
  const mode = normalizeCanvasViewportMode(config.canvasViewportMode);
  if (mode === 'locked' || (restorePreference && mode === 'manual')) {
    const zoom = normalizeCanvasZoom(config.canvasViewportZoom, config);
    // smooth 镜头平移会在途中缩放，即使首尾比例一致；锁定时必须线性插值。
    return { ...options, minZoom: zoom, maxZoom: zoom, interpolate: 'linear' };
  }
  const { minZoom: rangeMinZoom } = getCanvasZoomRange(config);
  const minZoom = normalizeCanvasZoom(options.minZoom ?? rangeMinZoom, config);
  const maxZoom = Math.max(minZoom, normalizeCanvasZoom(options.maxZoom ?? 1, config));
  // 线性镜头位移避免 smooth 插值在途中缩小到自定义范围之外。
  return { ...options, minZoom, maxZoom, interpolate: 'linear' };
}
