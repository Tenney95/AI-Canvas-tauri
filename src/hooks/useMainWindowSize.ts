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

/** '16:9' → 16/9 */
export function parseAspectRatio(ratio: string | undefined | null): number | null {
  if (!ratio) return null;
  const [w, h] = ratio.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

export function useMainWindowSize(lockedRatio: number | null): void {
  const savedSize = useAppStore((s) => s.config.windowSize);
  // 配置是异步读出来的，等它到位后只恢复一次，之后用户怎么拖都不再干预
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current || !savedSize) return;
    const { width, height } = savedSize;
    if (!(width > 0 && height > 0)) return;
    restored.current = true;

    void (async () => {
      try {
        const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        if (await win.isMaximized() || await win.isFullscreen()) return;
        await win.setSize(new LogicalSize(width, height));
      } catch (error) {
        console.warn('[窗口尺寸] 恢复失败:', error);
      }
    })();
  }, [savedSize]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    // 自己发起的 setSize 也会触发 onResized，靠这个标记避免自激
    let applying = false;

    void (async () => {
      try {
        const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const off = await win.onResized(() => {
          if (applying) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(async () => {
            try {
              // 最大化 / 全屏时窗口尺寸由系统决定，既不纠正也不记忆
              if (await win.isMaximized() || await win.isFullscreen()) return;
              const size = (await win.innerSize()).toLogical(await win.scaleFactor());
              const width = Math.round(size.width);
              let height = Math.round(size.height);

              if (lockedRatio) {
                const target = Math.round(width / lockedRatio);
                if (Math.abs(target - height) > 2) {
                  applying = true;
                  try {
                    await win.setSize(new LogicalSize(width, target));
                    height = target;
                  } finally {
                    applying = false;
                  }
                }
              }

              const store = useAppStore.getState();
              const prev = store.config.windowSize;
              if (prev?.width === width && prev?.height === height) return;
              store.updateConfig({ windowSize: { width, height } });
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
  }, [lockedRatio]);
}
