import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fitMainWindowAspectRatio,
  normalizeMainWindowSize,
  parseAspectRatio,
  createWindowSizeSaveScheduler,
} from '../../src/hooks/useMainWindowSize';

afterEach(() => vi.useRealTimers());

describe('window size save flushing', () => {
  it('flushes a pending resize before its debounce delay', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const scheduler = createWindowSizeSaveScheduler(save);
    scheduler.schedule();
    expect(save).not.toHaveBeenCalled();
    await scheduler.flush();
    expect(save).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledOnce();
    scheduler.dispose();
  });
  it('waits for an in-flight resize and a later queued resize', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const save = vi.fn<() => Promise<void>>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const scheduler = createWindowSizeSaveScheduler(save);
    scheduler.schedule();
    const first = scheduler.flush();
    scheduler.schedule();
    const closing = scheduler.flush();
    finish(); await first; await closing;
    expect(save).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('retains a failed resize for a later explicit retry', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(undefined);
    const scheduler = createWindowSizeSaveScheduler(save);
    scheduler.schedule();
    await expect(scheduler.flush()).rejects.toThrow('read failed');
    expect(save).toHaveBeenCalledOnce();
    await scheduler.flush();
    expect(save).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
});

describe('useMainWindowSize helpers', () => {
  it('parses valid ratios and rejects invalid ratios', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('0:9')).toBeNull();
    expect(parseAspectRatio(undefined)).toBeNull();
  });

  it('rejects transient sizes below the main window minimum', () => {
    expect(normalizeMainWindowSize({ width: 999, height: 700 })).toBeNull();
    expect(normalizeMainWindowSize({ width: 1000, height: 699 })).toBeNull();
    expect(normalizeMainWindowSize({ width: Number.NaN, height: 900 })).toBeNull();
  });

  it('rounds and accepts usable logical sizes', () => {
    expect(normalizeMainWindowSize({ width: 1420.4, height: 900.4 })).toEqual({
      width: 1420,
      height: 900,
    });
  });

  it('keeps a locked ratio without dropping below the minimum height', () => {
    expect(fitMainWindowAspectRatio(1000, 16 / 9)).toEqual({ width: 1244, height: 700 });
    expect(fitMainWindowAspectRatio(1600, 16 / 9)).toEqual({ width: 1600, height: 900 });
  });
});
