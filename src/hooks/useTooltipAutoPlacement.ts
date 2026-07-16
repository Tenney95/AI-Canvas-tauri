/**
 * 为默认显示在上方的 data-tooltip 提供窗口边界兜底：
 * 当上方空间不足时临时翻转到触发元素下方。
 */
import { useEffect } from 'react';

const TOOLTIP_HEIGHT = 28;
const TOOLTIP_GAP = 6;
const VIEWPORT_MARGIN = 8;
const AUTO_POSITION_ATTRIBUTE = 'data-tooltip-auto-pos';

function isTopTooltip(element: HTMLElement) {
  const position = element.dataset.tooltipPos;
  return !position || position === 'top';
}

function updatePlacement(element: HTMLElement) {
  if (!isTopTooltip(element)) {
    element.removeAttribute(AUTO_POSITION_ATTRIBUTE);
    return;
  }

  const wouldOverflowTop = element.getBoundingClientRect().top
    < TOOLTIP_HEIGHT + TOOLTIP_GAP + VIEWPORT_MARGIN;

  if (wouldOverflowTop) {
    element.setAttribute(AUTO_POSITION_ATTRIBUTE, 'bottom');
  } else {
    element.removeAttribute(AUTO_POSITION_ATTRIBUTE);
  }
}

function findTooltipTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>('[data-tooltip]')
    : null;
}

export function useTooltipAutoPlacement() {
  useEffect(() => {
    let activeTooltip: HTMLElement | null = null;

    const handlePointerOver = (event: PointerEvent) => {
      const nextTooltip = findTooltipTarget(event.target);
      if (!nextTooltip || nextTooltip === activeTooltip) return;

      activeTooltip?.removeAttribute(AUTO_POSITION_ATTRIBUTE);
      activeTooltip = nextTooltip;
      updatePlacement(nextTooltip);
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (!activeTooltip) return;
      const nextTooltip = findTooltipTarget(event.relatedTarget);
      if (nextTooltip === activeTooltip) return;

      activeTooltip.removeAttribute(AUTO_POSITION_ATTRIBUTE);
      activeTooltip = null;
    };

    const refreshActiveTooltip = () => {
      if (activeTooltip?.isConnected) {
        updatePlacement(activeTooltip);
      } else {
        activeTooltip = null;
      }
    };

    document.addEventListener('pointerover', handlePointerOver);
    document.addEventListener('pointerout', handlePointerOut);
    window.addEventListener('resize', refreshActiveTooltip);
    window.addEventListener('scroll', refreshActiveTooltip, true);

    return () => {
      activeTooltip?.removeAttribute(AUTO_POSITION_ATTRIBUTE);
      document.removeEventListener('pointerover', handlePointerOver);
      document.removeEventListener('pointerout', handlePointerOut);
      window.removeEventListener('resize', refreshActiveTooltip);
      window.removeEventListener('scroll', refreshActiveTooltip, true);
    };
  }, []);
}
