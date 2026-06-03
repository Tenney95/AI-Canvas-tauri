/**
 * ResizeHandle — 通用右下角拖拽缩放把手
 * 使用 PointerEvent 捕获阶段拦截，防止 React Flow 抢占事件
 */
import { useCallback, useRef } from 'react';

interface ResizeHandleProps {
  currentWidth: number;
  currentHeight: number;
  minWidth?: number;
  minHeight?: number;
  onResize: (width: number, height: number) => void;
}

export default function ResizeHandle({
  currentWidth,
  currentHeight,
  minWidth = 160,
  minHeight = 120,
  onResize,
}: ResizeHandleProps) {
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing.current = true;
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: currentWidth,
        h: currentHeight,
      };

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;
        const dx = ev.clientX - resizeStart.current.x;
        const dy = ev.clientY - resizeStart.current.y;
        const newWidth = Math.max(minWidth, resizeStart.current.w + dx);
        const newHeight = Math.max(minHeight, resizeStart.current.h + dy);
        onResize(newWidth, newHeight);
      };

      const handlePointerUp = () => {
        isResizing.current = false;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [currentWidth, currentHeight, minWidth, minHeight, onResize],
  );

  return (
    <div className="node-resize-handle" onPointerDownCapture={handlePointerDown} />
  );
}
