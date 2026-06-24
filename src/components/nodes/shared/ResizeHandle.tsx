/**
 * ResizeHandle — 通用右下角拖拽缩放把手
 * 使用 PointerEvent 捕获阶段拦截，防止 React Flow 抢占事件
 */
import { useCallback, useContext, useRef } from 'react';
import { ResizeSnapContext } from '../../../hooks/useNodeSnap';

interface ResizeHandleProps {
  /** 节点 id —— 用于缩放吸附对齐（不传则禁用吸附） */
  nodeId?: string;
  currentWidth: number;
  currentHeight: number;
  minWidth?: number;
  minHeight?: number;
  onResize: (width: number, height: number) => void;
}

export default function ResizeHandle({
  nodeId,
  currentWidth,
  currentHeight,
  minWidth = 160,
  minHeight = 120,
  onResize,
}: ResizeHandleProps) {
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const snap = useContext(ResizeSnapContext);

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
      if (nodeId) snap?.onResizeStart(nodeId);

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;
        const dx = ev.clientX - resizeStart.current.x;
        const dy = ev.clientY - resizeStart.current.y;
        let newWidth = Math.max(minWidth, resizeStart.current.w + dx);
        let newHeight = Math.max(minHeight, resizeStart.current.h + dy);
        // 缩放吸附：若右/下边对齐了其他节点的边/中线则对齐并画引导线
        if (nodeId && snap) {
          const snapped = snap.applyResizeSnap(nodeId, newWidth, newHeight);
          newWidth = Math.max(minWidth, snapped.width);
          newHeight = Math.max(minHeight, snapped.height);
        }
        onResize(newWidth, newHeight);
      };

      const handlePointerUp = () => {
        isResizing.current = false;
        if (nodeId) snap?.onResizeStop();
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
    [nodeId, snap, currentWidth, currentHeight, minWidth, minHeight, onResize],
  );

  return (
    <div className="node-resize-handle" onPointerDownCapture={handlePointerDown} />
  );
}
