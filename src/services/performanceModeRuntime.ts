/** 既有配置的窗口级运行时投影；不持久化、不依赖 Store 或媒体服务。 */
export interface CanvasDisplayBudget {
  readonly maxPreparing: number;
  readonly maxPerFrame: number;
  readonly workMs: number;
  readonly idleMs: number;
}

const MEBIBYTE = 1024 * 1024;
const NORMAL_BUDGET = {
  display: { maxPreparing: 3, maxPerFrame: 4, workMs: 3, idleMs: 180 },
  imagePreviewMaxEdge: 0,
  imageIdleBytes: 32 * MEBIBYTE,
  imageIdleEntries: 128,
  videoIdleBytes: 32 * MEBIBYTE,
  videoIdleEntries: 64,
  previewIdleMs: 30_000,
  mediaRootMargin: '800px 0px',
  mediaUnloadDelayMs: 2_000,
} as const;
const PERFORMANCE_BUDGET = {
  display: { maxPreparing: 1, maxPerFrame: 2, workMs: 2, idleMs: 180 },
  imagePreviewMaxEdge: 512,
  imageIdleBytes: 8 * MEBIBYTE,
  imageIdleEntries: 32,
  videoIdleBytes: 8 * MEBIBYTE,
  videoIdleEntries: 16,
  previewIdleMs: 30_000,
  mediaRootMargin: '160px 0px',
  mediaUnloadDelayMs: 2_000,
} as const;

let enabled = false;
const listeners = new Set<() => void>();

export function getPerformanceModeEnabled(): boolean { return enabled; }

export function getPerformanceModeBudget(performanceMode = enabled) {
  return performanceMode ? PERFORMANCE_BUDGET : NORMAL_BUDGET;
}

export function subscribePerformanceMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 仅由配置同步调用；消费者在切换时收紧空闲资源，不回收正在使用的租约。 */
export function syncPerformanceModeRuntime(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  for (const listener of [...listeners]) listener();
}
