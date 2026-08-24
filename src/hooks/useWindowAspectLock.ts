/**
 * useWindowAspectLock — 拖拽缩放主窗口时把窗口固定成指定宽高比。
 *
 * Tauri / tao 没有原生的比例锁定 API，只能在 resize 结束后纠正一次高度。
 * 用防抖等用户松手再改，避免拖动过程中反复 setSize 打架。
 */
import { useEffect } from 'react';

/** '16:9' → 16/9 */
export function parseAspectRatio(ratio: string | undefined | null): number | null {
  if (!ratio) return null;
  const [w, h] = ratio.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

export function useWindowAspectLock(ratio: number | null): void {
  useEffect(() => {
    if (!ratio) return;

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
            // 最大化 / 全屏时窗口尺寸由系统决定，不纠正
            if (await win.isMaximized() || await win.isFullscreen()) return;
            const size = (await win.innerSize()).toLogical(await win.scaleFactor());
            const width = Math.round(size.width);
            const target = Math.round(width / ratio);
            if (Math.abs(target - Math.round(size.height)) <= 2) return;
            applying = true;
            try {
              await win.setSize(new LogicalSize(width, target));
            } catch (error) {
              console.warn('[窗口比例] 纠正尺寸失败:', error);
            } finally {
              applying = false;
            }
          }, 200);
        });
        if (disposed) off();
        else unlisten = off;
      } catch (error) {
        console.warn('[窗口比例] 锁定失败:', error);
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [ratio]);
}
