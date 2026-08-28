/**
 * useMainWindowSize — 主窗口尺寸的记忆与比例锁定。
 *
 * - 记忆：拖拽缩放结束后把逻辑尺寸写进配置，下次启动恢复（最大化 / 全屏时不记也不恢复）。
 * - 锁定：Tauri / tao 没有原生的比例锁定 API，只能在 resize 结束后纠正一次高度。
 *
 * 两件事共用一个 onResized 监听，防抖等用户松手再动，避免拖动过程中反复 setSize 打架。
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

export const MAIN_WINDOW_MIN_WIDTH = 1000;
export const MAIN_WINDOW_MIN_HEIGHT = 700;

export interface MainWindowSize {
  width: number;
  height: number;
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
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    // 自己发起的 setSize 也会触发 onResized，靠这个标记避免自激
    let applying = false;

    void (async () => {
      try {
        const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();

        // 必须先恢复再监听，避免恢复动作或启动期系统事件反过来污染持久化尺寸。
        if (!restored.current) {
          restored.current = true;
          const savedSize = normalizeMainWindowSize(useAppStore.getState().config.windowSize ?? {
            width: 0,
            height: 0,
          });
          if (savedSize && !(await win.isMaximized()) && !(await win.isFullscreen())) {
            await win.setSize(new LogicalSize(savedSize.width, savedSize.height));
          }
        }
        if (disposed) return;

        const off = await win.onResized(() => {
          if (applying) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(async () => {
            try {
              // 最大化 / 全屏时窗口尺寸由系统决定，既不纠正也不记忆
              if (await win.isMaximized() || await win.isFullscreen()) return;
              const size = (await win.innerSize()).toLogical(await win.scaleFactor());
              let actualSize = normalizeMainWindowSize(size);
              if (!actualSize) return;

              if (lockedRatio) {
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

              const store = useAppStore.getState();
              const prev = store.config.windowSize;
              if (prev?.width === actualSize.width && prev?.height === actualSize.height) return;
              store.updateConfig({ windowSize: actualSize });
              void store.saveConfig();
            } catch (error) {
              console.warn('[窗口尺寸] 记忆或纠正失败:', error);
            }
          }, 300);
        });
        if (disposed) off();
        else unlisten = off;
      } catch (error) {
        console.warn('[窗口尺寸] 监听失败:', error);
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [configHydrated, lockedRatio]);
}
