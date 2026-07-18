/**
 * ResizeHandle — 通用右下角拖拽缩放把手
 *
 * 核心问题：React Flow 的 pane 会在捕获阶段处理 Shift + pointerdown，
 * 比把手自身的 pointerdown 监听更早进入框选逻辑。
 *
 * 解决：为把手添加 React Flow 识别的 nokey 类，让 pane 跳过框选；nodrag / nopan
 * 同时隔离节点拖拽和画布平移。原生监听器继续负责实际缩放。
 */
import { useContext, useEffect, useRef } from 'react';
import { ResizeSnapContext } from '../../../hooks/useNodeSnap';
import { useShiftProportional, useProportionalLock, computeResize } from '../../../hooks/useShiftProportional';

interface ResizeHandleProps {
  nodeId?: string;
  currentWidth: number;
  currentHeight: number;
  minWidth?: number;
  minHeight?: number;
  lockAspectRatio?: boolean;
  onResize: (width: number, height: number) => void;
}

export default function ResizeHandle({
  nodeId,
  currentWidth,
  currentHeight,
  minWidth = 160,
  minHeight = 120,
  lockAspectRatio = false,
  onResize,
}: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const snap = useContext(ResizeSnapContext);
  const shiftHeld = useShiftProportional();
  const { lockRef, reset: resetProportional, lock: lockProportional } = useProportionalLock();

  // 最新值 refs（供原生事件闭包读取，避免闭包过期）
  const latestRef = useRef({ currentWidth, currentHeight, minWidth, minHeight, lockAspectRatio, onResize, nodeId, snap });
  useEffect(() => {
    latestRef.current = { currentWidth, currentHeight, minWidth, minHeight, lockAspectRatio, onResize, nodeId, snap };
  }, [currentHeight, currentWidth, lockAspectRatio, minHeight, minWidth, nodeId, onResize, snap]);

  useEffect(() => {
    const el = handleRef.current;
    if (!el) return;

    const onNativePointerDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation(); // ← 关键：阻止事件冒泡到 React 根节点，React Flow 收不到

      const {
        currentWidth: cw,
        currentHeight: ch,
        minWidth: mw,
        minHeight: mh,
        lockAspectRatio: keepRatio,
        onResize: rs,
        nodeId: nid,
        snap: sp,
      } = latestRef.current;
      isResizing.current = true;
      resizeStart.current = { x: e.clientX, y: e.clientY, w: cw, h: ch };
      resetProportional();
      if (nid) sp?.onResizeStart(nid);

      const handlePointerMove = (ev: PointerEvent) => {
        if (!isResizing.current) return;

        let baseW = resizeStart.current.w;
        let baseH = resizeStart.current.h;
        let dx = ev.clientX - resizeStart.current.x;
        let dy = ev.clientY - resizeStart.current.y;
        let ratio = baseH > 0 ? baseW / baseH : 1;
        let useProportional = keepRatio;

        if (!keepRatio && shiftHeld.current) {
          if (lockRef.current.w === 0) {
            lockProportional(baseW, baseH, resizeStart.current.x, resizeStart.current.y);
          }
          baseW = lockRef.current.w;
          baseH = lockRef.current.h;
          dx = ev.clientX - lockRef.current.x;
          dy = ev.clientY - lockRef.current.y;
          ratio = lockRef.current.ratio;
          useProportional = true;
        } else {
          resetProportional();
        }

        let { width: newWidth, height: newHeight } = computeResize(
          baseW, baseH, dx, dy, ratio, mw, mh, useProportional,
        );

        if (nid && sp && !keepRatio) {
          const snapped = sp.applyResizeSnap(nid, newWidth, newHeight);
          newWidth = Math.max(mw, snapped.width);
          newHeight = Math.max(mh, snapped.height);
        }
        rs(newWidth, newHeight);
      };

      const handlePointerUp = () => {
        isResizing.current = false;
        if (nid) sp?.onResizeStop();
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    };

    // capture:true — 在原生捕获阶段拦截，早于 React 事件代理的冒泡阶段
    el.addEventListener('pointerdown', onNativePointerDown, true);
    return () => el.removeEventListener('pointerdown', onNativePointerDown, true);
  }, [shiftHeld, lockRef, resetProportional, lockProportional]);

  return <div className="node-resize-handle nokey nodrag nopan" ref={handleRef} />;
}
