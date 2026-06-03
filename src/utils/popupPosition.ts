/**
 * popupPosition — 弹出框/选择框/下拉菜单位置自动调整工具
 *
 * 当弹出元素超出屏幕边界时，自动翻转方向或偏移位置，确保始终可见。
 */

const DEFAULT_PADDING = 8;

export interface ViewportEdge {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * 获取当前可用视口区域
 * 通常使用 window.innerWidth / innerHeight，但可传入自定义值用于测试
 */
export function getViewport(): ViewportEdge {
  return {
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    left: 0,
  };
}

/**
 * 计算 fixed 定位的弹出元素位置，确保不超出屏幕边界
 *
 * @param desiredX - 期望的 left 坐标
 * @param desiredY - 期望的 top 坐标
 * @param popupWidth - 弹出元素估算宽度
 * @param popupHeight - 弹出元素估算高度
 * @param padding - 距屏幕边缘的最小间距，默认 8px
 * @returns 调整后的 { left, top } 坐标
 */
export function calcFixedPosition(
  desiredX: number,
  desiredY: number,
  popupWidth: number,
  popupHeight: number,
  padding: number = DEFAULT_PADDING,
): { left: number; top: number } {
  const vp = getViewport();

  let left = desiredX;
  let top = desiredY;

  // 右边界溢出 → 向左偏移
  if (left + popupWidth > vp.right - padding) {
    left = vp.right - popupWidth - padding;
  }
  // 左边界溢出 → 靠左对齐
  if (left < vp.left + padding) {
    left = vp.left + padding;
  }

  // 底部溢出 → 向上偏移
  if (top + popupHeight > vp.bottom - padding) {
    top = vp.bottom - popupHeight - padding;
  }
  // 顶部溢出 → 向下偏移
  if (top < vp.top + padding) {
    top = vp.top + padding;
  }

  return { left, top };
}

/**
 * 计算子菜单的弹出方向和位置
 *
 * @param parentMenuRect - 父级菜单当前的 DOMRect（相对视口）
 * @param submenuWidth - 子菜单估算宽度
 * @param submenuHeight - 子菜单估算高度
 * @param preferredDirection - 优先方向 'right' | 'left'
 * @param padding - 距屏幕边缘的最小间距，默认 8px
 * @returns { left, top, direction } — direction 指示实际方向
 */
export function calcSubmenuPosition(
  parentMenuRect: DOMRect,
  submenuWidth: number,
  submenuHeight: number,
  preferredDirection: 'right' | 'left' = 'right',
  padding: number = DEFAULT_PADDING,
): { left: number; top: number; direction: 'left' | 'right' } {
  const vp = getViewport();
  const spacing = 4;

  // 先尝试优先方向
  let direction = preferredDirection;
  let left: number;
  let top = parentMenuRect.top + spacing;

  if (preferredDirection === 'right') {
    left = parentMenuRect.right + spacing;
    // 右侧空间不足 → 翻转到左侧
    if (left + submenuWidth > vp.right - padding) {
      direction = 'left';
      left = parentMenuRect.left - submenuWidth - spacing;
      // 左侧也不够 → 靠左贴边
      if (left < vp.left + padding) {
        left = vp.left + padding;
      }
    }
  } else {
    left = parentMenuRect.left - submenuWidth - spacing;
    // 左侧空间不足 → 翻转到右侧
    if (left < vp.left + padding) {
      direction = 'right';
      left = parentMenuRect.right + spacing;
      // 右侧也不够 → 靠右贴边
      if (left + submenuWidth > vp.right - padding) {
        left = vp.right - submenuWidth - padding;
      }
    }
  }

  // 底部边界检查
  if (top + submenuHeight > vp.bottom - padding) {
    top = Math.max(vp.top + padding, parentMenuRect.bottom - submenuHeight);
  }

  // 顶部边界检查
  if (top < vp.top + padding) {
    top = vp.top + padding;
  }

  return { left, top, direction };
}

/**
 * 计算弹出框相对于触发元素的弹出方向及 CSS 属性
 *
 * 适用于 `position: absolute` 的下拉面板（如 ModelSelector）
 *
 * @param triggerRect - 触发按钮的 DOMRect
 * @param popupWidth - 弹出面板估算宽度
 * @param popupHeight - 弹出面板估算高度
 * @param preferredDirection - 优先方向 'up' | 'down'，默认 'down'
 * @param padding - 距屏幕边缘的最小间距，默认 8px
 * @returns CSS 属性对象 { left, top?, bottom? } 和实际方向
 */
export function calcDropdownPosition(
  triggerRect: DOMRect,
  popupWidth: number,
  popupHeight: number,
  preferredDirection: 'up' | 'down' = 'down',
  padding: number = DEFAULT_PADDING,
): React.CSSProperties & { actualDirection: 'up' | 'down' } {
  const vp = getViewport();
  const spacing = 4;

  // 水平方向：保持与触发元素左对齐，必要时向左偏移
  let left = triggerRect.left;
  if (left + popupWidth > vp.right - padding) {
    left = Math.max(vp.left + padding, vp.right - popupWidth - padding);
  }

  // 检查上下空间
  const spaceBelow = vp.bottom - triggerRect.bottom - spacing;
  const spaceAbove = triggerRect.top - vp.top - spacing;

  let actualDirection = preferredDirection;

  if (preferredDirection === 'down') {
    if (spaceBelow < popupHeight && spaceAbove >= popupHeight) {
      actualDirection = 'up';
    }
  } else {
    if (spaceAbove < popupHeight && spaceBelow >= popupHeight) {
      actualDirection = 'down';
    }
  }

  const style: React.CSSProperties = {
    left,
    position: 'absolute',
    zIndex: 100,
  };

  if (actualDirection === 'up') {
    style.bottom = triggerRect.height + spacing;
  } else {
    style.top = `calc(100% + ${spacing}px)`;
  }

  // 如果两个方向都不够，就选空间更大的方向
  if (actualDirection === 'down' && spaceBelow < popupHeight && spaceAbove > spaceBelow) {
    actualDirection = 'up';
    delete style.top;
    style.bottom = triggerRect.height + spacing;
    // 限制最大高度
    (style as Record<string, unknown>).maxHeight = `${spaceAbove - padding * 2}px`;
  }
  if (actualDirection === 'up' && spaceAbove < popupHeight && spaceBelow > spaceAbove) {
    actualDirection = 'down';
    delete style.bottom;
    style.top = `calc(100% + ${spacing}px)`;
    (style as Record<string, unknown>).maxHeight = `${spaceBelow - spacing - padding * 2}px`;
  }

  return { ...style, actualDirection };
}

/**
 * 计算 tooltip 的弹出方向（CSS only 的 tooltip 无法动态调整，此函数用于 JS 控制的 tooltip）
 *
 * @param triggerRect - 触发元素的 DOMRect
 * @param tooltipWidth - tooltip 估算宽度
 * @param tooltipHeight - tooltip 估算高度
 * @param padding - 距屏幕边缘的最小间距，默认 8px
 * @returns CSS 属性对象
 */
export function calcTooltipPosition(
  triggerRect: DOMRect,
  tooltipWidth: number,
  tooltipHeight: number,
  padding: number = DEFAULT_PADDING,
): React.CSSProperties {
  const vp = getViewport();
  const spacing = 8;

  // 优先显示在上方
  const aboveSpace = triggerRect.top - vp.top - spacing;
  const belowSpace = vp.bottom - triggerRect.bottom - spacing;

  let top: number;

  if (aboveSpace >= tooltipHeight + spacing) {
    // 上方空间足够
    top = triggerRect.top - tooltipHeight - spacing;
  } else if (belowSpace >= tooltipHeight + spacing) {
    // 上方不够，放到下方
    top = triggerRect.bottom + spacing;
  } else {
    // 两边都不够，选空间更大的一边
    if (aboveSpace > belowSpace) {
      top = Math.max(vp.top + padding, triggerRect.top - tooltipHeight - spacing);
    } else {
      top = triggerRect.bottom + spacing;
    }
  }

  // 水平居中，但不可超出屏幕
  let left = triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2;
  if (left < vp.left + padding) {
    left = vp.left + padding;
  }
  if (left + tooltipWidth > vp.right - padding) {
    left = vp.right - tooltipWidth - padding;
  }

  return {
    position: 'fixed',
    left,
    top,
    zIndex: 100,
  };
}
