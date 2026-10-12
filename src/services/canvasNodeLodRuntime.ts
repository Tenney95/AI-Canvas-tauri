import { CANVAS_DISPLAY_BUDGET, createCanvasDisplayScheduler, type CanvasDisplayClock } from './canvasDisplayScheduler';
import { getPerformanceModeBudget } from './performanceModeRuntime';

/** 画布会话内的显示调度；不修改节点、历史或持久化状态。 */
export const CANVAS_NODE_LOD = {
  enter: 0.16, exit: 0.25, restorePerFrame: CANVAS_DISPLAY_BUDGET.maxPerFrame, idleMs: CANVAS_DISPLAY_BUDGET.idleMs,
} as const;
const PERFORMANCE_NODE_LOD = { enter: 0.55, exit: 0.65 } as const;
interface Entry {
  id: string;
  full: boolean;
  x: number;
  y: number;
  listeners: Set<() => void>;
  pins: Set<symbol>;
  cancel?: () => void;
}

export function createCanvasNodeLodRuntime(initialZoom = 1, clock?: CanvasDisplayClock, performanceMode = false) {
  const display = createCanvasDisplayScheduler(clock, getPerformanceModeBudget(performanceMode).display);
  let thresholds = performanceMode ? PERFORMANCE_NODE_LOD : CANVAS_NODE_LOD;
  let latestZoom = initialZoom;
  let far = initialZoom < thresholds.enter;
  // 低配置设备初次进入近景也经显示预算恢复，不一次挂载所有完整媒体组件。
  let progressive = far || performanceMode;
  let interacting = false;
  let center = { x: 0, y: 0 };
  const entries = new Map<string, Entry>();
  function publish(entry: Entry, full: boolean) {
    if (entry.full === full) return;
    entry.full = full;
    [...entry.listeners].forEach((listener) => listener());
  }
  function priority(id?: string) {
    const entry = id ? entries.get(id) : undefined;
    return entry ? (entry.x - center.x) ** 2 + (entry.y - center.y) ** 2 : 0;
  }
  function queue(entry: Entry) {
    entry.cancel?.();
    entry.cancel = undefined;
    if (entry.full === (!far || entry.pins.size > 0)) return;
    entry.cancel = display.enqueue(entry, () => {
      entry.cancel = undefined;
      if (entries.get(entry.id) === entry) publish(entry, !far || entry.pins.size > 0);
    }, () => priority(entry.id));
  }
  function ensure(id: string): Entry {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, full: !progressive && !interacting, x: 0, y: 0, listeners: new Set(), pins: new Set() };
      entries.set(id, entry);
      if (!far) queue(entry);
    }
    return entry;
  }
  function release(entry: Entry) {
    if (entry.listeners.size || entry.pins.size) return;
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
    entry.cancel?.();
  }
  function updateFar(next: boolean) {
    if (next === far) return;
    far = next;
    progressive = true;
    for (const entry of entries.values()) queue(entry);
  }

  return {
    enqueueDisplay: (key: object, commit: () => void, nodeId?: string, delayMs = 0) => (
      display.enqueue(key, commit, () => priority(nodeId), delayMs)
    ),
    prepareDisplay: (key: object, prepare: () => Promise<void>, nodeId?: string, delayMs = 0) => (
      display.prepare(key, prepare, () => priority(nodeId), delayMs)
    ),
    getSnapshot: (id: string) => entries.get(id)?.full ?? (!progressive && !interacting),
    subscribe(id: string, listener: () => void) {
      const entry = ensure(id);
      entry.listeners.add(listener);
      return () => { entry.listeners.delete(listener); release(entry); };
    },
    pin(id: string) {
      const entry = ensure(id);
      const token = Symbol();
      entry.pins.add(token);
      entry.cancel?.();
      entry.cancel = undefined;
      publish(entry, true);
      return () => {
        entry.pins.delete(token);
        queue(entry);
        release(entry);
      };
    },
    position(id: string, x: number, y: number) {
      const entry = entries.get(id);
      if (!entry || (entry.x === x && entry.y === y)) return;
      entry.x = x;
      entry.y = y;
    },
    viewport(zoom: number, centerX = 0, centerY = 0) {
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      latestZoom = zoom;
      center = { x: centerX, y: centerY };
      updateFar(far ? zoom < thresholds.exit : zoom < thresholds.enter);
    },
    setPerformanceMode(enabled: boolean) {
      display.setBudget(getPerformanceModeBudget(enabled).display);
      const next = enabled ? PERFORMANCE_NODE_LOD : CANVAS_NODE_LOD;
      if (thresholds === next) return;
      thresholds = next;
      if (enabled) progressive = true;
      // 模式切换按新模式的入口阈值重新判断，不继承另一模式的滞回区间。
      updateFar(latestZoom < thresholds.enter);
    },
    interaction(value: boolean) {
      if (interacting === value) return;
      interacting = value;
      display.interaction(value);
    },
    activate: display.activate,
    deactivate: display.deactivate,
  };
}

export type CanvasNodeLodRuntime = ReturnType<typeof createCanvasNodeLodRuntime>;
