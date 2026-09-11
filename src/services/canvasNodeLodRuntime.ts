/** 画布会话内的显示调度；不修改节点、历史或持久化状态。 */
export const CANVAS_NODE_LOD = { enter: 0.16, exit: 0.25, restorePerFrame: 4, idleMs: 180 } as const;

interface Clock {
  now: () => number;
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  delay: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelDelay: (id: ReturnType<typeof setTimeout>) => void;
}
interface Entry {
  id: string;
  full: boolean;
  x: number;
  y: number;
  listeners: Set<() => void>;
  pins: Set<symbol>;
}

export function createCanvasNodeLodRuntime(initialZoom = 1, clock: Clock = {
  now: () => performance.now(),
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  delay: (callback, ms) => setTimeout(callback, ms),
  cancelDelay: (id) => clearTimeout(id),
}) {
  let far = initialZoom < CANVAS_NODE_LOD.enter;
  let progressive = far;
  let active = true;
  let interacting = false;
  let quietUntil = 0;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let center = { x: 0, y: 0 };
  const entries = new Map<string, Entry>();
  const pending = new Set<Entry>();
  let ordered: Entry[] = [];
  let cursor = 0;
  let dirty = false;

  function stop() {
    if (frame !== undefined) clock.cancelFrame(frame);
    if (timer !== undefined) clock.cancelDelay(timer);
    frame = undefined;
    timer = undefined;
  }
  function publish(entry: Entry, full: boolean) {
    if (entry.full === full) return;
    entry.full = full;
    [...entry.listeners].forEach((listener) => listener());
  }
  function schedule() {
    if (!active || far || interacting || pending.size === 0 || frame !== undefined || timer !== undefined) return;
    const wait = quietUntil - clock.now();
    if (wait > 0) {
      timer = clock.delay(() => { timer = undefined; schedule(); }, wait);
    } else {
      frame = clock.frame(pump);
    }
  }
  function pump() {
    frame = undefined;
    if (!active || far || interacting || clock.now() < quietUntil) { schedule(); return; }
    if (dirty) {
      ordered = [...pending].sort((a, b) => (
        ((a.x - center.x) ** 2 + (a.y - center.y) ** 2) - ((b.x - center.x) ** 2 + (b.y - center.y) ** 2)
      ));
      cursor = 0;
      dirty = false;
    }
    let restored = 0;
    while (active && !far && !interacting && cursor < ordered.length && restored < CANVAS_NODE_LOD.restorePerFrame) {
      const entry = ordered[cursor++];
      if (!pending.delete(entry) || entries.get(entry.id) !== entry) continue;
      publish(entry, true);
      restored++;
    }
    if (pending.size === 0) { ordered = []; cursor = 0; }
    schedule();
  }
  function queue(entry: Entry) {
    if (entry.full || pending.has(entry)) return;
    pending.add(entry);
    dirty = true;
    schedule();
  }
  function ensure(id: string): Entry {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, full: !progressive, x: 0, y: 0, listeners: new Set(), pins: new Set() };
      entries.set(id, entry);
      if (!far) queue(entry);
    }
    return entry;
  }
  function release(entry: Entry) {
    if (entry.listeners.size || entry.pins.size) return;
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
    pending.delete(entry);
    if (pending.size === 0) { stop(); ordered = []; cursor = 0; }
  }

  return {
    getSnapshot: (id: string) => entries.get(id)?.full ?? !progressive,
    subscribe(id: string, listener: () => void) {
      const entry = ensure(id);
      entry.listeners.add(listener);
      return () => { entry.listeners.delete(listener); release(entry); };
    },
    pin(id: string) {
      const entry = ensure(id);
      const token = Symbol();
      entry.pins.add(token);
      pending.delete(entry);
      publish(entry, true);
      return () => {
        entry.pins.delete(token);
        if (far && entry.pins.size === 0) publish(entry, false);
        release(entry);
      };
    },
    position(id: string, x: number, y: number) {
      const entry = entries.get(id);
      if (!entry || (entry.x === x && entry.y === y)) return;
      entry.x = x;
      entry.y = y;
      if (pending.has(entry)) dirty = true;
    },
    viewport(zoom: number, centerX = 0, centerY = 0) {
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      center = { x: centerX, y: centerY };
      const next = far ? zoom < CANVAS_NODE_LOD.exit : zoom < CANVAS_NODE_LOD.enter;
      if (next === far) return;
      far = next;
      progressive = true;
      stop();
      pending.clear();
      ordered = [];
      cursor = 0;
      for (const entry of entries.values()) {
        if (far) { if (!entry.pins.size) publish(entry, false); }
        else queue(entry);
      }
    },
    interaction(value: boolean) {
      if (interacting === value) return;
      interacting = value;
      stop();
      if (!value) { quietUntil = clock.now() + CANVAS_NODE_LOD.idleMs; dirty = true; schedule(); }
    },
    activate() { active = true; schedule(); },
    deactivate() { active = false; stop(); },
  };
}

export type CanvasNodeLodRuntime = ReturnType<typeof createCanvasNodeLodRuntime>;
