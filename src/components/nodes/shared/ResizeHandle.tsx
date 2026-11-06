/**
 * ResizeHandle — 通用缩放把手：四角 + 四边共 8 个方向，Shift 锁定比例
 *
 * 核心问题：React Flow 的 pane 会在捕获阶段处理 Shift + pointerdown，
 * 比把手自身的 pointerdown 监听更早进入框选逻辑。
 *
 * 解决：为把手添加 React Flow 识别的 nokey 类，让 pane 跳过框选；nodrag / nopan
 * 同时隔离节点拖拽和画布平移。原生监听器继续负责实际缩放。
 *
 * 左/上方向缩放时节点位置要反向移动（对边保持不动），故这里同时写位置。
 */
import { useContext, useEffect, useRef } from 'react';
import { ResizeSnapContext, type ResizeDirection } from '../../../hooks/useNodeSnap';
import { useProportionalLock, computeResize } from '../../../hooks/useShiftProportional';
import { useNodeLocked } from '../../../hooks/useNodeLocked';
import { useAppStore } from '../../../store/useAppStore';
import { createFrameCoalescer } from '../../../utils/frameCoalescer';
import { getCanvasNodeById } from '../../../utils/canvasRenderProjection';

/** 8 个把手方向：x/y 为 -1 表示该轴的左/上边在动，1 表示右/下边在动，0 表示该轴不变 */
const HANDLE_DIRECTIONS: { name: string; x: -1 | 0 | 1; y: -1 | 0 | 1 }[] = [
  { name: 'nw', x: -1, y: -1 },
  { name: 'n', x: 0, y: -1 },
  { name: 'ne', x: 1, y: -1 },
  { name: 'w', x: -1, y: 0 },
  { name: 'e', x: 1, y: 0 },
  { name: 'sw', x: -1, y: 1 },
  { name: 's', x: 0, y: 1 },
  { name: 'se', x: 1, y: 1 },
];

interface ResizeHandleProps {
  nodeId?: string;
  currentWidth: number;
  currentHeight: number;
  minWidth?: number;
  minHeight?: number;
  lockAspectRatio?: boolean;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  onResize: (width: number, height: number) => void;
}

export default function ResizeHandle({
  nodeId,
  currentWidth,
  currentHeight,
  minWidth = 160,
  minHeight = 120,
  lockAspectRatio = false,
  onResizeStart,
  onResizeEnd,
  onResize,
}: ResizeHandleProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const stopResizeRef = useRef<() => void>(() => undefined);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, left: 0, top: 0 });
  const snap = useContext(ResizeSnapContext);
  const { lockRef, reset: resetProportional, lock: lockProportional } = useProportionalLock();
  // 节点被锁定时不渲染把手：锁定既禁止拖拽移动，也禁止缩放改变大小
  const isNodeLocked = useNodeLocked(nodeId);

  // 最新值 refs（供原生事件闭包读取，避免闭包过期）
  const latestRef = useRef({ currentWidth, currentHeight, minWidth, minHeight, lockAspectRatio, onResizeStart, onResizeEnd, onResize, nodeId, snap, resetProportional, lockProportional });
  useEffect(() => {
    latestRef.current = { currentWidth, currentHeight, minWidth, minHeight, lockAspectRatio, onResizeStart, onResizeEnd, onResize, nodeId, snap, resetProportional, lockProportional };
  }, [currentHeight, currentWidth, lockAspectRatio, minHeight, minWidth, nodeId, onResize, onResizeEnd, onResizeStart, resetProportional, lockProportional, snap]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onNativePointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || isResizing.current || useAppStore.getState().currentProjectId !== currentProjectId) return;
      const handle = (e.target as HTMLElement | null)?.closest<HTMLElement>('.node-resize-handle');
      if (!handle || !root.contains(handle)) return;
      const dirX = Number(handle.dataset.dirX ?? 1) as -1 | 0 | 1;
      const dirY = Number(handle.dataset.dirY ?? 1) as -1 | 0 | 1;
      const direction: ResizeDirection = { x: dirX, y: dirY };
      const axis = dirX === 0 ? 'y' : dirY === 0 ? 'x' : 'both';

      e.preventDefault();
      e.stopPropagation(); // ← 关键：阻止事件冒泡到 React 根节点，React Flow 收不到

      const {
        currentWidth: cw,
        currentHeight: ch,
        minWidth: mw,
        minHeight: mh,
        lockAspectRatio: keepRatio,
        onResizeStart: startResize,
        onResizeEnd: endResize,
        onResize: rs,
        nodeId: nid,
        snap: sp,
        resetProportional: resetLock,
        lockProportional: lockRatio,
      } = latestRef.current;
      const ownerProjectId = currentProjectId;
      const startNode = nid ? getCanvasNodeById(useAppStore.getState().nodes, nid) : undefined;
      if (nid && (!startNode || startNode.draggable === false)) return;
      isResizing.current = true;
      handle.classList.add('is-resizing');
      // 左/上缩放要以起始位置为基准反推新位置，避免逐帧累加漂移
      const startPos = startNode?.position;
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: cw,
        h: ch,
        left: startPos?.x ?? 0,
        top: startPos?.y ?? 0,
      };
      resetLock();
      if (nid) sp?.onResizeStart(nid);

      let historyCommitted = false;
      let lastWidth = cw;
      let lastHeight = ch;

      const isCurrent = () => {
        const state = useAppStore.getState();
        const node = nid ? getCanvasNodeById(state.nodes, nid) : undefined;
        return state.currentProjectId === ownerProjectId
          && (!nid || (!!node && node.draggable !== false && node.parentId === startNode?.parentId));
      };
      const applyPointer = (ev: { clientX: number; clientY: number; shift: boolean }) => {
        if (!isResizing.current) return;
        if (!isCurrent()) { finishResize(); return; }

        let baseW = resizeStart.current.w;
        let baseH = resizeStart.current.h;
        let dx = (ev.clientX - resizeStart.current.x) * dirX;
        let dy = (ev.clientY - resizeStart.current.y) * dirY;
        let ratio = baseH > 0 ? baseW / baseH : 1;
        let useProportional = keepRatio;

        if (!keepRatio && ev.shift) {
          if (lockRef.current.w === 0) {
            lockRatio(baseW, baseH, resizeStart.current.x, resizeStart.current.y);
          }
          baseW = lockRef.current.w;
          baseH = lockRef.current.h;
          dx = (ev.clientX - lockRef.current.x) * dirX;
          dy = (ev.clientY - lockRef.current.y) * dirY;
          ratio = lockRef.current.ratio;
          useProportional = true;
        } else {
          resetLock();
        }

        let { width: newWidth, height: newHeight } = computeResize(
          baseW, baseH, dx, dy, ratio, mw, mh, useProportional, axis,
        );

        if (nid && sp && !keepRatio) {
          const snapped = sp.applyResizeSnap(nid, newWidth, newHeight, direction);
          newWidth = Math.max(mw, snapped.width);
          newHeight = Math.max(mh, snapped.height);
        }

        if (newWidth === lastWidth && newHeight === lastHeight) return;
        if (!historyCommitted) {
          startResize?.();
          historyCommitted = true;
          if (!isCurrent()) { finishResize(); return; }
        }
        lastWidth = newWidth;
        lastHeight = newHeight;
        rs(newWidth, newHeight);

        // 左/上边在动 → 对边固定：位置补偿掉尺寸变化
        if (nid && (dirX === -1 || dirY === -1) && startPos && isCurrent()) {
          useAppStore.getState().updateNodePositionTransient(nid, {
            x: dirX === -1 ? resizeStart.current.left + (resizeStart.current.w - newWidth) : startPos.x,
            y: dirY === -1 ? resizeStart.current.top + (resizeStart.current.h - newHeight) : startPos.y,
          });
        }
      };

      const preview = createFrameCoalescer(applyPointer);
      const handlePointerMove = (ev: PointerEvent) => {
        if (ev.pointerId === e.pointerId) preview.schedule({ clientX: ev.clientX, clientY: ev.clientY, shift: ev.shiftKey });
      };
      const handlePointerUp = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        preview.cancel();
        if (historyCommitted || ev.clientX !== resizeStart.current.x || ev.clientY !== resizeStart.current.y) {
          applyPointer({ clientX: ev.clientX, clientY: ev.clientY, shift: ev.shiftKey });
        }
        finishResize();
      };
      const handlePointerCancel = (ev: PointerEvent) => {
        if (ev.pointerId === e.pointerId) finishResize();
      };
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      const finishResize = () => {
        if (!isResizing.current) return;
        isResizing.current = false;
        stopResizeRef.current = () => undefined;
        preview.cancel();
        handle.classList.remove('is-resizing');
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerCancel);
        handle.removeEventListener('lostpointercapture', handlePointerCancel);
        window.removeEventListener('blur', finishResize);
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        resetLock();
        if (historyCommitted && isCurrent()) endResize?.();
        if (nid) sp?.onResizeStop();
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };
      stopResizeRef.current = finishResize;
      document.body.style.cursor = getComputedStyle(handle).cursor;
      document.body.style.userSelect = 'none';
      handle.setPointerCapture(e.pointerId);
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerCancel);
      handle.addEventListener('lostpointercapture', handlePointerCancel);
      window.addEventListener('blur', finishResize);
    };

    // capture:true — 在原生捕获阶段拦截，早于 React 事件代理的冒泡阶段
    root.addEventListener('pointerdown', onNativePointerDown, true);
    return () => {
      root.removeEventListener('pointerdown', onNativePointerDown, true);
      stopResizeRef.current();
    };
  }, [currentProjectId, nodeId, lockRef, isNodeLocked]);

  if (isNodeLocked) return null;

  return (
    <div className="node-resize-handles" ref={rootRef}>
      {HANDLE_DIRECTIONS.map(({ name, x, y }) => (
        <div
          key={name}
          className={`node-resize-handle node-resize-handle--${name} nokey nodrag nopan`}
          data-dir-x={x}
          data-dir-y={y}
        />
      ))}
    </div>
  );
}
