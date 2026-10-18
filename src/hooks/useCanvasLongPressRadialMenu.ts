/**
 * useCanvasLongPressRadialMenu — 画布长按手势控制器。
 * 追踪指针按下 / 移动 / 抬起，判定长按（超过延迟且位移在阈值内）后触发环形快捷菜单，
 * 并在拖动改键、取消或组件卸载时清理状态。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export const CANVAS_LONG_PRESS_DELAY_MS = 480;
export const CANVAS_LONG_PRESS_INDICATOR_DELAY_MS = 180;
export const CANVAS_LONG_PRESS_MOVE_THRESHOLD_PX = 8;

export interface CanvasRadialMenuPosition {
  x: number;
  y: number;
}

interface LongPressPointerEvent {
  button: number;
  isPrimary: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
}

interface CanvasLongPressController {
  pointerDown: (event: LongPressPointerEvent) => boolean;
  pointerMove: (event: Pick<LongPressPointerEvent, 'pointerId' | 'clientX' | 'clientY'>) => void;
  pointerEnd: (pointerId: number) => void;
  cancel: () => void;
  dispose: () => void;
}

export function hasExceededLongPressMoveThreshold(
  start: CanvasRadialMenuPosition,
  current: CanvasRadialMenuPosition,
  threshold = CANVAS_LONG_PRESS_MOVE_THRESHOLD_PX,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > threshold;
}

export function createCanvasLongPressController(
  onTrigger: (position: CanvasRadialMenuPosition) => void,
  delay = CANVAS_LONG_PRESS_DELAY_MS,
  onPendingChange?: (position: CanvasRadialMenuPosition | null) => void,
): CanvasLongPressController {
  let triggerTimer: ReturnType<typeof setTimeout> | null = null;
  let indicatorTimer: ReturnType<typeof setTimeout> | null = null;
  let active: (CanvasRadialMenuPosition & { pointerId: number }) | null = null;

  const cancel = () => {
    const hadPendingPress = triggerTimer !== null || indicatorTimer !== null || active !== null;
    if (triggerTimer !== null) clearTimeout(triggerTimer);
    if (indicatorTimer !== null) clearTimeout(indicatorTimer);
    triggerTimer = null;
    indicatorTimer = null;
    active = null;
    if (hadPendingPress) onPendingChange?.(null);
  };

  return {
    pointerDown: (event) => {
      cancel();
      if (event.button !== 0 || !event.isPrimary) return false;
      active = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      indicatorTimer = setTimeout(() => {
        indicatorTimer = null;
        if (!active) return;
        onPendingChange?.({ x: active.x, y: active.y });
      }, Math.min(CANVAS_LONG_PRESS_INDICATOR_DELAY_MS, delay));
      triggerTimer = setTimeout(() => {
        if (!active) return;
        const position = { x: active.x, y: active.y };
        triggerTimer = null;
        if (indicatorTimer !== null) clearTimeout(indicatorTimer);
        indicatorTimer = null;
        active = null;
        onPendingChange?.(null);
        onTrigger(position);
      }, delay);
      return true;
    },
    pointerMove: (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      if (hasExceededLongPressMoveThreshold(active, { x: event.clientX, y: event.clientY })) {
        cancel();
      }
    },
    pointerEnd: (pointerId) => {
      if (active?.pointerId === pointerId) cancel();
    },
    cancel,
    dispose: cancel,
  };
}

function isBlankCanvasTarget(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  if (!root.contains(target)) return false;
  if (target.closest('[data-canvas-radial-menu], .react-flow__node, .react-flow__edge, .react-flow__controls')) {
    return false;
  }
  return target.classList.contains('react-flow__pane') || target.closest('.react-flow__pane') !== null;
}

export function useCanvasLongPressRadialMenu(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  isEdgeAtPoint?: (point: CanvasRadialMenuPosition) => boolean,
) {
  const [position, setPosition] = useState<CanvasRadialMenuPosition | null>(null);
  const [holdPosition, setHoldPosition] = useState<CanvasRadialMenuPosition | null>(null);
  const suppressContextMenuUntilRef = useRef(0);
  const close = useCallback(() => setPosition(null), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return undefined;

    const controller = createCanvasLongPressController((nextPosition) => {
      suppressContextMenuUntilRef.current = performance.now() + 1_000;
      window.getSelection()?.removeAllRanges();
      setPosition(nextPosition);
    }, CANVAS_LONG_PRESS_DELAY_MS, setHoldPosition);
    const onPointerDown = (event: PointerEvent) => {
      controller.cancel();
      if (event.button !== 0 || !event.isPrimary || !isBlankCanvasTarget(event.target, root)) return;
      // Bitmap lines target the pane; exclude them before either long-press timer starts.
      if (isEdgeAtPoint?.({ x: event.clientX, y: event.clientY })) return;
      setPosition(null);
      controller.pointerDown(event);
    };
    const onPointerMove = (event: PointerEvent) => controller.pointerMove(event);
    const onPointerEnd = (event: PointerEvent) => controller.pointerEnd(event.pointerId);
    const onContextMenu = (event: MouseEvent) => {
      if (performance.now() >= suppressContextMenuUntilRef.current) return;
      if (!isBlankCanvasTarget(event.target, root)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    root.addEventListener('pointerdown', onPointerDown, true);
    root.addEventListener('pointermove', onPointerMove, true);
    root.addEventListener('pointerup', onPointerEnd, true);
    root.addEventListener('pointercancel', onPointerEnd, true);
    root.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', controller.cancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      controller.dispose();
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('pointermove', onPointerMove, true);
      root.removeEventListener('pointerup', onPointerEnd, true);
      root.removeEventListener('pointercancel', onPointerEnd, true);
      root.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', controller.cancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [close, enabled, isEdgeAtPoint, rootRef]);

  return { position, holdPosition, close };
}
