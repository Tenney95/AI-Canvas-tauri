import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { useIsPresent } from 'framer-motion';

interface PanelResizeHandleProps {
  edge: 'left' | 'right';
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
}

interface ResizeGesture {
  handle: HTMLDivElement;
  pointerId: number;
  startX: number;
  startWidth: number;
}

/** 放在面板内侧边缘，使用面板的实际宽度作为拖动起点。 */
export default function PanelResizeHandle({ edge, minWidth, maxWidth, onResize }: PanelResizeHandleProps) {
  const isPresent = useIsPresent();
  const gestureRef = useRef<ResizeGesture | null>(null);

  const stopResize = useCallback(function stopResize() {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    window.removeEventListener('blur', stopResize);
    document.body.classList.remove('chat-panel-resizing');
    if (gesture.handle.hasPointerCapture(gesture.pointerId)) {
      gesture.handle.releasePointerCapture(gesture.pointerId);
    }
  }, []);

  useEffect(() => {
    if (!isPresent) stopResize();
    return stopResize;
  }, [isPresent, stopResize]);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPresent || event.button !== 0 || document.body.classList.contains('chat-panel-resizing')) return;
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    if (!panel) return;

    handle.setPointerCapture(event.pointerId);
    gestureRef.current = {
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width,
    };
    window.addEventListener('blur', stopResize);
    document.body.classList.add('chat-panel-resizing');
    event.preventDefault();
    event.stopPropagation();
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const delta = event.clientX - gesture.startX;
    const width = gesture.startWidth + (edge === 'right' ? delta : -delta);
    onResize(Math.min(maxWidth, Math.max(minWidth, width)));
  };

  const finishPointerResize = (event: PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) stopResize();
  };

  return (
    <div
      aria-hidden="true"
      className="chat-panel-resize-handle"
      style={edge === 'right' ? { left: 'auto', right: 0, transform: 'scaleX(-1)' } : undefined}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={finishPointerResize}
      onPointerCancel={finishPointerResize}
      onLostPointerCapture={finishPointerResize}
    />
  );
}
