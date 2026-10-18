import { createContext, useLayoutEffect, useMemo, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { useStoreApi } from '@xyflow/react';

interface PaneEdgeHandler {
  handle(event: MouseEvent<HTMLElement>, action: 'click' | 'doubleClick'): boolean;
  hitTest(point: { x: number; y: number }): boolean;
}

export const CanvasEdgePanePointerContext = createContext<RefObject<PaneEdgeHandler | null> | null>(null);

interface PaneGesture {
  pointerId: number;
  pane: Element;
  x: number;
  y: number;
  transform: readonly number[];
  moved: boolean;
}

function isPane(target: EventTarget | null): target is Element {
  return target instanceof Element && target.classList.contains('react-flow__pane');
}

/** Bitmap edges have no DOM hit path when both endpoints are unmounted. */
export function useCanvasEdgePanePointer(enabled: boolean) {
  const store = useStoreApi();
  const bridge = useRef<PaneEdgeHandler | null>(null);
  const gesture = useRef<PaneGesture | null>(null);
  const handled = useRef<PaneGesture | null>(null);
  useLayoutEffect(() => {
    gesture.current = handled.current = null;
    return () => { gesture.current = handled.current = null; };
  }, [enabled]);

  const handlers = useMemo(() => {
    const available = (pendingMouseUp = false) => {
      const state = store.getState();
      return enabled && state.elementsSelectable && (pendingMouseUp || !state.paneDragging)
        && !state.userSelectionActive && !state.connection.inProgress;
    };
    const cancel = () => { gesture.current = null; };
    const moved = (start: PaneGesture, event: MouseEvent<HTMLElement>) =>
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 1;
    return {
      onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
        cancel();
        handled.current = null;
        if (!event.isPrimary || event.button !== 0 || !isPane(event.target) || !available()) return;
        gesture.current = { pointerId: event.pointerId, pane: event.target,
          x: event.clientX, y: event.clientY, transform: [...store.getState().transform], moved: false };
      },
      onPointerMoveCapture(event: PointerEvent<HTMLDivElement>) {
        const start = gesture.current;
        if (start && event.pointerId === start.pointerId && moved(start, event)) start.moved = true;
      },
      onPointerUpCapture(event: PointerEvent<HTMLDivElement>) {
        const start = gesture.current;
        cancel();
        if (!start || !event.isPrimary || event.button !== 0 || event.pointerId !== start.pointerId
          || event.target !== start.pane || start.moved || moved(start, event) || !available(true)
          || start.transform.some((value, i) => value !== store.getState().transform[i])) return;
        // Classic mode marks even a stationary mousedown as paneDragging until mouseup.
        if (!bridge.current?.handle(event, 'click')) return;
        // Pane otherwise clears selection during pointerup, before the DOM click.
        store.setState({ userSelectionActive: false, userSelectionRect: null });
        if (start.pane.hasPointerCapture(event.pointerId)) start.pane.releasePointerCapture(event.pointerId);
        handled.current = start;
        event.preventDefault();
        event.stopPropagation();
      },
      onClickCapture(event: MouseEvent<HTMLDivElement>) {
        const start = handled.current;
        handled.current = null;
        if (!start || event.detail === 0 || event.target !== start.pane || moved(start, event)) return;
        // The follow-up click must not run Pane.resetSelectedElements a second time.
        event.preventDefault();
        event.stopPropagation();
      },
      onDoubleClickCapture(event: MouseEvent<HTMLDivElement>) {
        if (!isPane(event.target) || !available() || !bridge.current?.handle(event, 'doubleClick')) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onPointerCancelCapture: cancel,
      onPointerLeave: cancel,
      onWheelCapture: cancel,
    };
  }, [enabled, store]);
  const isEdgeAtPoint = useMemo(() => (point: { x: number; y: number }) =>
    enabled && bridge.current?.hitTest(point) === true, [enabled]);
  return { bridge, handlers, isEdgeAtPoint };
}
