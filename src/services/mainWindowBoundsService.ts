import type { Monitor, Window } from '@tauri-apps/api/window';

export const MAIN_WINDOW_MIN_WIDTH = 1000;
export const MAIN_WINDOW_MIN_HEIGHT = 700;

export interface MainWindowSize {
  width: number;
  height: number;
}

interface WindowRect extends MainWindowSize {
  x: number;
  y: number;
}

/** 坐标和尺寸统一使用物理像素，保留左侧 Dock、负坐标及多屏偏移。 */
export function fitWindowRectToWorkArea(
  rect: WindowRect,
  workArea: WindowRect,
  ratio: number | null = null,
  fill = false,
): WindowRect {
  let width = fill ? workArea.width : Math.min(rect.width, workArea.width);
  let height = fill ? workArea.height : Math.min(rect.height, workArea.height);
  if (!fill && ratio && Number.isFinite(ratio) && ratio > 0) {
    width = Math.min(width, height * ratio);
    height = width / ratio;
  }
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  return {
    x: Math.round(Math.max(workArea.x, Math.min(rect.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(rect.y, workArea.y + workArea.height - height))),
    width,
    height,
  };
}

export function monitorWorkAreaKey(monitor: Monitor): string {
  const { position, size } = monitor.workArea;
  return [position.x, position.y, size.width, size.height, monitor.scaleFactor].join(':');
}

/** 只用于自有主窗口；原生全屏由系统管理，不按普通桌面的 Dock 留白。 */
export async function applyMainWindowWorkArea(
  win: Window,
  monitor: Monitor,
  options: { size?: MainWindowSize; ratio?: number | null; fill?: boolean; center?: boolean } = {},
): Promise<MainWindowSize> {
  const { LogicalSize, PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/window');
  const [position, size, scaleFactor, fullscreen] = await Promise.all([
    win.outerPosition(), win.innerSize(), win.scaleFactor(), win.isFullscreen(),
  ]);
  if (fullscreen) return size.toLogical(scaleFactor);
  const workArea: WindowRect = {
    ...monitor.workArea.position,
    ...monitor.workArea.size,
  };
  if (![workArea.x, workArea.y, workArea.width, workArea.height, scaleFactor].every(Number.isFinite)
    || workArea.width <= 0 || workArea.height <= 0 || scaleFactor <= 0) {
    throw new Error('当前显示器工作区不可用');
  }
  const ratio = options.ratio && Number.isFinite(options.ratio) && options.ratio > 0
    ? options.ratio : null;
  const minWidth = Math.min(
    MAIN_WINDOW_MIN_WIDTH * scaleFactor, workArea.width,
    ratio && !options.fill ? workArea.height * ratio : Infinity,
  );
  const minHeight = Math.min(
    MAIN_WINDOW_MIN_HEIGHT * scaleFactor, workArea.height,
    ratio && !options.fill ? workArea.width / ratio : Infinity,
  );
  // 比例锁定以当前宽度推导高度；最后统一收敛到工作区，不能再撑到 Dock 后面。
  const width = Math.max(options.size ? options.size.width * scaleFactor : size.width,
    minWidth, ratio ? minHeight * ratio : 0);
  const height = ratio ? width / ratio
    : Math.max(options.size ? options.size.height * scaleFactor : size.height, minHeight);
  const target = fitWindowRectToWorkArea(
    { ...position, width, height }, workArea, ratio, options.fill,
  );
  if (options.center) {
    target.x = Math.round(workArea.x + (workArea.width - target.width) / 2);
    target.y = Math.round(workArea.y + (workArea.height - target.height) / 2);
  }
  // 小屏或较大的 Dock 可能令工作区小于常规最小尺寸；只在当前窗口临时下调。
  await win.setMinSize(new LogicalSize(
    Math.floor(minWidth) / scaleFactor,
    Math.floor(minHeight) / scaleFactor,
  ));
  if (size.width !== target.width || size.height !== target.height) {
    await win.setSize(new PhysicalSize(target.width, target.height));
  }
  if (position.x !== target.x || position.y !== target.y) {
    await win.setPosition(new PhysicalPosition(target.x, target.y));
  }
  return (await win.innerSize()).toLogical(await win.scaleFactor());
}
