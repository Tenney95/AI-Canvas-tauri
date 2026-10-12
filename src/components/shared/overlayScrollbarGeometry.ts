/**
 * 覆盖式滚动条的屏幕坐标计算。
 * 完整轨道与可视裁剪分别计算，祖先滚动不能改变子容器的轨道比例。
 */
export const TRACK_INSET = 4;
const MIN_THUMB_SIZE = 36;
const CLIPPING_OVERFLOW = /^(auto|scroll|overlay|hidden|clip)$/;
const PAINT_CONTAINMENT = /\b(paint|strict|content)\b/;

export interface ScrollViewportBounds {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

export interface ScrollThumbGeometry {
  length: number;
  /** 从完整目标可视区起点算起，已包含轨道内边距。 */
  offset: number;
  maxScroll: number;
  maxTravel: number;
}

function createBounds(left: number, top: number, right: number, bottom: number): ScrollViewportBounds {
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { bottom: top + height, height, left, right: left + width, top, width };
}

/** 读取完整 client box，保持真实边缘位置；这里不按窗口或祖先裁剪。 */
export function getScrollViewportBounds(target: HTMLElement): ScrollViewportBounds {
  const rect = target.getBoundingClientRect();
  const scaleX = target.offsetWidth > 0 ? rect.width / target.offsetWidth : 1;
  const scaleY = target.offsetHeight > 0 ? rect.height / target.offsetHeight : 1;
  const left = rect.left + target.clientLeft * scaleX;
  const top = rect.top + target.clientTop * scaleY;
  return createBounds(
    left,
    top,
    left + target.clientWidth * scaleX,
    top + target.clientHeight * scaleY,
  );
}

/**
 * 返回窗口和祖先共同允许显示的区域，不修改完整轨道的 viewport。
 * overflow 按轴裁剪；paint containment 同时裁剪两轴。
 */
export function getScrollClipBounds(
  target: HTMLElement,
  viewport: ScrollViewportBounds,
): ScrollViewportBounds {
  let left = Math.max(0, viewport.left);
  let top = Math.max(0, viewport.top);
  let right = Math.min(window.innerWidth, viewport.right);
  let bottom = Math.min(window.innerHeight, viewport.bottom);
  let ancestor = target.parentElement;

  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    const containsPaint = PAINT_CONTAINMENT.test(style.contain);
    const clipsHorizontal = containsPaint || CLIPPING_OVERFLOW.test(style.overflowX);
    const clipsVertical = containsPaint || CLIPPING_OVERFLOW.test(style.overflowY);

    if (clipsHorizontal || clipsVertical) {
      const bounds = getScrollViewportBounds(ancestor);
      if (clipsHorizontal) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (clipsVertical) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    ancestor = ancestor.parentElement;
  }

  return createBounds(left, top, right, bottom);
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * 轨道、拇指和移动距离均使用屏幕像素，滚动量沿用 DOM 的内容坐标。
 * offset 已包含 TRACK_INSET；短轨道缩小最小拇指，保留可拖动的行程。
 */
export function getScrollThumbGeometry(
  viewportLength: number,
  clientLength: number,
  scrollLength: number,
  scrollPosition: number,
  crossAxisGap: number,
): ScrollThumbGeometry {
  const viewportSize = nonNegativeFinite(viewportLength);
  const clientSize = nonNegativeFinite(clientLength);
  const scrollSize = Math.max(clientSize, nonNegativeFinite(scrollLength));
  const inset = Math.min(TRACK_INSET, viewportSize / 2);
  const trackLength = Math.max(0, viewportSize - inset * 2 - nonNegativeFinite(crossAxisGap));
  const visibleRatio = scrollSize > 0 ? clientSize / scrollSize : 1;
  const minimumLength = Math.min(MIN_THUMB_SIZE, trackLength / 2);
  const length = Math.min(trackLength, Math.max(minimumLength, trackLength * visibleRatio));
  const maxScroll = Math.max(0, scrollSize - clientSize);
  const maxTravel = Math.max(0, trackLength - length);
  const position = Math.min(maxScroll, nonNegativeFinite(scrollPosition));
  const offset = inset + (maxScroll > 0 ? maxTravel * (position / maxScroll) : 0);

  return { length, offset, maxScroll, maxTravel };
}
