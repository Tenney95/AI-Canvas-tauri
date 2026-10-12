import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPerformanceModeBudget,
  getPerformanceModeEnabled,
  subscribePerformanceMode,
  syncPerformanceModeRuntime,
} from '../../src/services/performanceModeRuntime';

afterEach(() => syncPerformanceModeRuntime(false));

describe('performance mode config projection', () => {
  it('keeps normal budgets and tightens only preview and idle resource work', () => {
    syncPerformanceModeRuntime(false);
    const normal = getPerformanceModeBudget();
    expect(normal.display).toEqual({ maxPreparing: 3, maxPerFrame: 4, workMs: 3, idleMs: 180 });
    expect(normal.imagePreviewMaxEdge).toBe(0);
    expect(normal.mediaRootMargin).toBe('800px 0px');

    syncPerformanceModeRuntime(true);
    const compact = getPerformanceModeBudget();
    expect(getPerformanceModeEnabled()).toBe(true);
    expect(compact.display).toEqual({ maxPreparing: 1, maxPerFrame: 2, workMs: 2, idleMs: 180 });
    expect(compact.imagePreviewMaxEdge).toBe(512);
    expect(compact.imageIdleBytes).toBe(8 * 1024 * 1024);
    expect(compact.videoIdleBytes).toBe(8 * 1024 * 1024);
    // Retain reuse and viewport hysteresis instead of repeatedly decoding boundary resources.
    expect(compact.previewIdleMs).toBe(normal.previewIdleMs);
    expect(compact.mediaUnloadDelayMs).toBe(normal.mediaUnloadDelayMs);
    expect(compact.mediaRootMargin).toBe('160px 0px');
    expect(getPerformanceModeBudget(false)).toBe(normal);
    syncPerformanceModeRuntime(false);
    expect(getPerformanceModeBudget()).toBe(normal);
  });

  it('notifies once per change and allows consumers to remove their subscriptions', () => {
    syncPerformanceModeRuntime(false);
    const changed = vi.fn(() => getPerformanceModeBudget());
    const unsubscribe = subscribePerformanceMode(changed);
    try {
      syncPerformanceModeRuntime(false);
      syncPerformanceModeRuntime(true);
      syncPerformanceModeRuntime(true);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.results[0].value).toBe(getPerformanceModeBudget(true));
      unsubscribe();
      unsubscribe();
      syncPerformanceModeRuntime(false);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('lets an idle consumer stop listening during a mode notification', () => {
    syncPerformanceModeRuntime(false);
    const changed = vi.fn();
    const unsubscribe = subscribePerformanceMode(() => { changed(); unsubscribe(); });
    syncPerformanceModeRuntime(true);
    syncPerformanceModeRuntime(false);
    expect(changed).toHaveBeenCalledOnce();
  });
});
