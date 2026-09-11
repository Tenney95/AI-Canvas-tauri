import { acquireCanvasImagePreview } from './canvasImagePreviewCache';

export interface DisplayQueue {
  enqueue: (key: object, commit: () => void, delayMs?: number) => () => void;
  prepare: (key: object, work: () => Promise<void>, delayMs?: number) => () => void;
}
export interface DisplayImageLease { src: string; release: () => void }
const TIERS = [256, 512, 1024, 0] as const;

/** 上下行各留 10% 余量；原图也是显示档位，不能绕开调度。 */
export function canvasImageTier(screenEdge: number, previous?: number): number {
  const raw = !Number.isFinite(screenEdge) || screenEdge <= 0 || screenEdge > 1024
    ? 0 : screenEdge <= 256 ? 256 : screenEdge <= 512 ? 512 : 1024;
  if (previous === undefined || !Number.isFinite(screenEdge) || screenEdge <= 0) return raw;
  const before = TIERS.indexOf(previous as typeof TIERS[number]);
  const after = TIERS.indexOf(raw as typeof TIERS[number]);
  if (before < 0) return raw;
  if (after > before && screenEdge <= previous * 1.1) return previous;
  if (after < before && screenEdge >= TIERS[before - 1] * 0.9) return previous;
  return raw;
}

function decodeImage(src: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const image = new Image();
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      image.onload = image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); }
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Image preparation timed out')), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    image.decoding = 'async';
    image.onload = () => {
      if (typeof image.decode === 'function') void image.decode().then(() => finish(), finish);
      else finish();
    };
    image.onerror = () => finish(new Error('Image preparation failed'));
    image.src = src;
  });
}

export async function prepareCanvasImage(source: string, edge: number, signal: AbortSignal, projectId?: string | null): Promise<DisplayImageLease> {
  const lease = edge > 0 ? await acquireCanvasImagePreview(source, edge, signal, projectId).catch(() => null) : null;
  try {
    signal.throwIfAborted();
    await decodeImage(lease?.src ?? source, signal);
    return lease ?? { src: source, release: () => {} };
  } catch {
    lease?.release();
    signal.throwIfAborted();
    // 原图失败仍交由真实 img 的 onError 展示原节点错误，保留其重试入口。
    if (lease) {
      try { await decodeImage(source, signal); } catch { signal.throwIfAborted(); }
    }
    return { src: source, release: () => {} };
  }
}

/** viewport 更新只改目标，只有队列提交才更新 React 显示。 */
export function createCanvasImageDisplay(options: {
  source: string;
  projectId?: string | null;
  queue: DisplayQueue;
  publish: (lease: DisplayImageLease) => void;
  prepare?: typeof prepareCanvasImage;
}) {
  const prepareKey = {};
  const displayKey = {};
  const held = new Set<DisplayImageLease>();
  let disposed = false;
  let target: number | undefined;
  let displayed: { edge: number; lease: DisplayImageLease } | undefined;
  let abort: (() => void) | undefined;
  let generation = 0;

  function request(edge: number, force = false) {
    if (disposed || (!force && target === edge)) return;
    target = edge;
    abort?.();
    const version = ++generation;
    if (!force && displayed?.edge === edge) return;
    const controller = new AbortController();
    let prepared: DisplayImageLease | undefined;
    let transferred = false;
    let cancelDisplay: (() => void) | undefined;
    const stale = () => disposed || controller.signal.aborted || version !== generation;
    const before = displayed ? TIERS.indexOf(displayed.edge as typeof TIERS[number]) : -1;
    const after = TIERS.indexOf(edge as typeof TIERS[number]);
    const delay = displayed ? (before - after >= 2 ? 1000 : 180) : 0;
    const cancelPrepare = options.queue.prepare(prepareKey, async () => {
      if (stale()) return;
      try {
        const result = await (options.prepare ?? prepareCanvasImage)(options.source, edge, controller.signal, options.projectId);
        if (stale()) { result.release(); return; }
        let released = false;
        const lease = { src: result.src, release: () => {
          if (released) return;
          released = true;
          result.release();
          controller.abort();
        } };
        prepared = lease;
        cancelDisplay = options.queue.enqueue(displayKey, () => {
          if (stale()) return;
          prepared = undefined;
          transferred = true;
          held.add(lease);
          displayed = { edge, lease };
          options.publish(lease);
        });
      } catch { /* 取消或过期的准备任务不改变现有显示。 */ }
    }, delay);
    abort = () => {
      if (!transferred) controller.abort();
      cancelPrepare();
      cancelDisplay?.();
      prepared?.release();
      prepared = undefined;
    };
  }

  return {
    viewport(zoom: number, width: number, height: number, pixelRatio: number) {
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      request(canvasImageTier(Math.max(width, height) * zoom * pixelRatio, target));
    },
    original() { request(0, true); },
    committed(lease: DisplayImageLease) {
      // React 提交新 src 后才归还旧租约，跳过中间显示状态也不会泄漏。
      for (const previous of held) {
        if (previous !== lease && previous !== displayed?.lease) { previous.release(); held.delete(previous); }
      }
    },
    dispose() {
      disposed = true;
      abort?.();
      for (const lease of held) lease.release();
      held.clear();
    },
  };
}
