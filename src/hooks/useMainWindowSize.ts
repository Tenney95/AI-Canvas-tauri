/**
 * useMainWindowSize — 主窗口尺寸的记忆与比例锁定。
 *
 * - 记忆：拖拽缩放结束后把逻辑尺寸写进配置，下次启动恢复（最大化 / 全屏时不记也不恢复）。
 * - 锁定：Tauri / tao 没有原生的比例锁定 API，只能在 resize 结束后纠正一次高度。
 *
 * Mac 同时按当前屏幕工作区避让 Dock；所有尺寸写入共用防抖队列，避免拖动时打架。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { isSettingsClosing, registerSettingsProducer } from '../services/configPersistenceQueue';
import {
  applyMainWindowWorkArea,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  monitorWorkAreaKey,
  type MainWindowSize,
} from '../services/mainWindowBoundsService';

export { MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT } from '../services/mainWindowBoundsService';
export type { MainWindowSize } from '../services/mainWindowBoundsService';

/** 防抖任务可在关闭前立即执行，并等待已经开始的异步保存。 */
export function createWindowSizeSaveScheduler(save: () => Promise<void>, delay = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let disposed = false;
  let running: Promise<void> | null = null;
  const flush = async (): Promise<void> => {
    clearTimeout(timer); timer = undefined;
    while (running) await running;
    if (!pending || disposed) return;
    pending = false;
    const operation = save();
    running = operation;
    try { await operation; }
    catch (error) { pending = true; throw error; }
    finally { if (running === operation) running = null; }
    if (pending) await flush();
  };
  return {
    schedule: () => {
      if (disposed || isSettingsClosing()) return;
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush().catch(() => {}); }, delay);
    },
    flush,
    dispose: () => { disposed = true; clearTimeout(timer); },
  };
}

/** 过滤启动、退出或 DPI 切换时系统可能短暂上报的异常尺寸。 */
export function normalizeMainWindowSize(size: MainWindowSize): MainWindowSize | null {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MAIN_WINDOW_MIN_WIDTH || height < MAIN_WINDOW_MIN_HEIGHT) return null;
  return { width, height };
}

/** 保持比例时也要满足主窗口最小尺寸，避免把未实际生效的小高度写进配置。 */
export function fitMainWindowAspectRatio(width: number, ratio: number): MainWindowSize {
  const safeWidth = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.round(width));
  const heightFromWidth = Math.round(safeWidth / ratio);
  if (heightFromWidth >= MAIN_WINDOW_MIN_HEIGHT) {
    return { width: safeWidth, height: heightFromWidth };
  }
  return {
    width: Math.max(MAIN_WINDOW_MIN_WIDTH, Math.round(MAIN_WINDOW_MIN_HEIGHT * ratio)),
    height: MAIN_WINDOW_MIN_HEIGHT,
  };
}

/** '16:9' → 16/9 */
export function parseAspectRatio(ratio: string | undefined | null): number | null {
  if (!ratio) return null;
  const [w, h] = ratio.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

export function useMainWindowSize(lockedRatio: number | null): void {
  const configHydrated = useAppStore((s) => s.configHydrated);
  // 配置加载后只恢复一次；比例设置变化只重建监听，不重复恢复。
  const restored = useRef(false);

  useEffect(() => {
    if (!configHydrated) return;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    let workAreaTimer: ReturnType<typeof setInterval> | undefined;
    let scheduler: ReturnType<typeof createWindowSizeSaveScheduler> | undefined;
    let unregisterProducer: (() => void) | undefined;
    // 自己发起的 setSize 也会触发 onResized，靠这个标记避免自激
    let applying = false;
    const isMacOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
    let workAreaKey = '';
    let wasMaximized = false;

    void (async () => {
      try {
        const { getCurrentWindow, LogicalSize, currentMonitor } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        wasMaximized = await win.isMaximized();
        const initialMonitor = isMacOS ? await currentMonitor() : null;
        if (disposed) return;
        if (initialMonitor) workAreaKey = monitorWorkAreaKey(initialMonitor);

        // 必须先恢复再监听，避免恢复动作或启动期系统事件反过来污染持久化尺寸。
        if (!restored.current) {
          restored.current = true;
          const savedSize = normalizeMainWindowSize(useAppStore.getState().config.windowSize ?? {
            width: 0,
            height: 0,
          });
          if (!(await win.isFullscreen())) {
            if (initialMonitor) {
              await applyMainWindowWorkArea(win, initialMonitor, {
                size: wasMaximized ? undefined : savedSize ?? undefined,
                fill: wasMaximized,
              });
            } else if (savedSize && !wasMaximized) {
              await win.setSize(new LogicalSize(savedSize.width, savedSize.height));
            }
          }
        }
        if (disposed) return;

        scheduler = createWindowSizeSaveScheduler(async () => {
            try {
              const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
              if (fullscreen) return;
              const monitor = isMacOS ? await currentMonitor() : null;
              if (disposed) return;
              const nextWorkAreaKey = monitor ? monitorWorkAreaKey(monitor) : '';
              // Dock 改变后 AppKit 的 isMaximized 可能因旧尺寸不再等于 visibleFrame 而返回 false。
              const keepMaximized = maximized || (wasMaximized && nextWorkAreaKey !== workAreaKey);
              if (maximized && !monitor) return;
              const size = (await win.innerSize()).toLogical(await win.scaleFactor());
              let actualSize = normalizeMainWindowSize(size);

              if (monitor) {
                applying = true;
                try {
                  const applied = await applyMainWindowWorkArea(win, monitor, {
                    ratio: lockedRatio,
                    fill: keepMaximized,
                  });
                  actualSize = normalizeMainWindowSize(applied);
                } finally {
                  applying = false;
                }
                wasMaximized = keepMaximized || await win.isMaximized();
                workAreaKey = nextWorkAreaKey;
                // 最大化与小屏临时尺寸不覆盖用户记忆的常规窗口尺寸。
                if (wasMaximized) return;
              } else if (lockedRatio && actualSize) {
                const target = fitMainWindowAspectRatio(actualSize.width, lockedRatio);
                if (
                  Math.abs(target.width - actualSize.width) > 2
                  || Math.abs(target.height - actualSize.height) > 2
                ) {
                  applying = true;
                  try {
                    await win.setSize(new LogicalSize(target.width, target.height));
                    const applied = (await win.innerSize()).toLogical(await win.scaleFactor());
                    actualSize = normalizeMainWindowSize(applied);
                  } finally {
                    applying = false;
                  }
                  if (!actualSize) return;
                }
              }
              if (!actualSize) return;

              const store = useAppStore.getState();
              if (disposed) return;
              const prev = store.config.windowSize;
              if (prev?.width === actualSize.width && prev?.height === actualSize.height) return;
              store.updateConfig({ windowSize: actualSize });
              await store.saveConfig({ silent: true });
            } catch (error) {
              console.warn('[窗口尺寸] 记忆或纠正失败');
              throw error;
            }
        });
        unregisterProducer = registerSettingsProducer(scheduler.flush);
        const schedule = () => {
          if (applying || disposed || isSettingsClosing()) return;
          scheduler?.schedule();
        };
        const listen = async (subscription: Promise<() => void>) => {
          const off = await subscription;
          if (disposed) off();
          else unlisteners.push(off);
        };
        await listen(win.onResized(schedule));
        if (isMacOS && !disposed) {
          await listen(win.onScaleChanged(schedule));
          let focused = await win.isFocused();
          await listen(win.onFocusChanged(({ payload }) => {
            focused = payload;
            if (focused) schedule();
          }));
          if (disposed) return;
          let checking = false;
          // 系统 Dock 设置变化不一定发窗口 resize；只在前台低频读取系统工作区。
          workAreaTimer = setInterval(() => {
            if (!focused || checking || disposed || applying || isSettingsClosing()) return;
            checking = true;
            void Promise.all([currentMonitor(), win.isFullscreen()]).then(([monitor, fullscreen]) => {
              if (!fullscreen && monitor && monitorWorkAreaKey(monitor) !== workAreaKey) schedule();
            }).catch(() => {}).finally(() => { checking = false; });
          }, 1500);
        }
      } catch (error) {
        console.warn('[窗口尺寸] 监听失败:', error);
      }
    })();

    return () => {
      disposed = true;
      scheduler?.dispose();
      unregisterProducer?.();
      clearInterval(workAreaTimer);
      unlisteners.forEach((off) => off());
    };
  }, [configHydrated, lockedRatio]);
}
