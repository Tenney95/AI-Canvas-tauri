/**
 * 将 data-tooltip 渲染到 body 下，避免被面板的 overflow 或 clip-path 截断。
 * 保留现有声明式 API，并统一处理四个方向的窗口边界碰撞。
 */
import { useEffect } from 'react';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

const TOOLTIP_GAP = 6;
const VIEWPORT_MARGIN = 8;
const SHOW_DELAY = 800;

function findTooltipTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>('[data-tooltip]')
    : null;
}

function getPreferredPosition(element: HTMLElement): TooltipPosition {
  const position = element.dataset.tooltipPos;
  return position === 'bottom' || position === 'left' || position === 'right'
    ? position
    : 'top';
}

function getOppositePosition(position: TooltipPosition): TooltipPosition {
  switch (position) {
    case 'top': return 'bottom';
    case 'bottom': return 'top';
    case 'left': return 'right';
    case 'right': return 'left';
  }
}

function getAvailableSpace(position: TooltipPosition, targetRect: DOMRect): number {
  switch (position) {
    case 'top': return targetRect.top - VIEWPORT_MARGIN - TOOLTIP_GAP;
    case 'bottom': return window.innerHeight - targetRect.bottom - VIEWPORT_MARGIN - TOOLTIP_GAP;
    case 'left': return targetRect.left - VIEWPORT_MARGIN - TOOLTIP_GAP;
    case 'right': return window.innerWidth - targetRect.right - VIEWPORT_MARGIN - TOOLTIP_GAP;
  }
}

function resolvePosition(
  preferred: TooltipPosition,
  targetRect: DOMRect,
  tooltipRect: DOMRect,
): TooltipPosition {
  const opposite = getOppositePosition(preferred);
  const requiredSpace = preferred === 'top' || preferred === 'bottom'
    ? tooltipRect.height
    : tooltipRect.width;
  const preferredSpace = getAvailableSpace(preferred, targetRect);
  const oppositeSpace = getAvailableSpace(opposite, targetRect);

  return preferredSpace >= requiredSpace || preferredSpace >= oppositeSpace
    ? preferred
    : opposite;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function positionTooltip(tooltip: HTMLDivElement, target: HTMLElement) {
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const position = resolvePosition(
    getPreferredPosition(target),
    targetRect,
    tooltipRect,
  );

  let left: number;
  let top: number;

  if (position === 'top' || position === 'bottom') {
    left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
    top = position === 'top'
      ? targetRect.top - tooltipRect.height - TOOLTIP_GAP
      : targetRect.bottom + TOOLTIP_GAP;
  } else {
    left = position === 'left'
      ? targetRect.left - tooltipRect.width - TOOLTIP_GAP
      : targetRect.right + TOOLTIP_GAP;
    top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
  }

  tooltip.style.left = `${Math.round(clamp(
    left,
    VIEWPORT_MARGIN,
    window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN,
  ))}px`;
  tooltip.style.top = `${Math.round(clamp(
    top,
    VIEWPORT_MARGIN,
    window.innerHeight - tooltipRect.height - VIEWPORT_MARGIN,
  ))}px`;
  tooltip.dataset.position = position;
}

export function useTooltipAutoPlacement() {
  useEffect(() => {
    const tooltip = document.createElement('div');
    tooltip.className = 'app-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tooltip);

    let hoveredTarget: HTMLElement | null = null;
    let focusedTarget: HTMLElement | null = null;
    let activeTarget: HTMLElement | null = null;
    let showTimer: number | null = null;
    const activeTargetObserver = new MutationObserver(() => {
      if (!activeTarget) return;
      const content = activeTarget.dataset.tooltip?.trim();
      if (!content) {
        hideTooltip();
        return;
      }
      tooltip.textContent = content;
      if (tooltip.dataset.open === 'true') positionTooltip(tooltip, activeTarget);
    });

    const clearShowTimer = () => {
      if (showTimer === null) return;
      window.clearTimeout(showTimer);
      showTimer = null;
    };

    function hideTooltip() {
      clearShowTimer();
      tooltip.removeAttribute('data-open');
      tooltip.setAttribute('aria-hidden', 'true');
    }

    const showTooltip = () => {
      showTimer = null;
      if (!activeTarget?.isConnected) {
        hideTooltip();
        return;
      }

      const content = activeTarget.dataset.tooltip?.trim();
      if (!content) {
        hideTooltip();
        return;
      }

      tooltip.textContent = content;
      tooltip.setAttribute('data-open', 'true');
      tooltip.setAttribute('aria-hidden', 'false');
      positionTooltip(tooltip, activeTarget);
    };

    const activateTarget = (nextTarget: HTMLElement | null) => {
      if (nextTarget === activeTarget) return;

      hideTooltip();
      activeTargetObserver.disconnect();
      activeTarget = nextTarget;
      if (!activeTarget) return;

      activeTargetObserver.observe(activeTarget, {
        attributes: true,
        attributeFilter: ['data-tooltip', 'data-tooltip-pos'],
      });
      showTimer = window.setTimeout(showTooltip, SHOW_DELAY);
    };

    const syncActiveTarget = () => {
      activateTarget(hoveredTarget ?? focusedTarget);
    };

    const handlePointerOver = (event: PointerEvent) => {
      hoveredTarget = findTooltipTarget(event.target);
      syncActiveTarget();
    };

    const handlePointerOut = (event: PointerEvent) => {
      const nextTarget = findTooltipTarget(event.relatedTarget);
      if (nextTarget === hoveredTarget) return;
      hoveredTarget = nextTarget;
      syncActiveTarget();
    };

    const handleFocusIn = (event: FocusEvent) => {
      focusedTarget = findTooltipTarget(event.target);
      syncActiveTarget();
    };

    const handleFocusOut = (event: FocusEvent) => {
      focusedTarget = findTooltipTarget(event.relatedTarget);
      syncActiveTarget();
    };

    const refreshActiveTooltip = () => {
      if (!activeTarget?.isConnected) {
        hoveredTarget = null;
        focusedTarget = null;
        activateTarget(null);
        return;
      }
      if (tooltip.dataset.open === 'true') positionTooltip(tooltip, activeTarget);
    };

    document.addEventListener('pointerover', handlePointerOver);
    document.addEventListener('pointerout', handlePointerOut);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('resize', refreshActiveTooltip);
    window.addEventListener('scroll', refreshActiveTooltip, true);

    return () => {
      clearShowTimer();
      activeTargetObserver.disconnect();
      document.removeEventListener('pointerover', handlePointerOver);
      document.removeEventListener('pointerout', handlePointerOut);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('resize', refreshActiveTooltip);
      window.removeEventListener('scroll', refreshActiveTooltip, true);
      tooltip.remove();
    };
  }, []);
}
