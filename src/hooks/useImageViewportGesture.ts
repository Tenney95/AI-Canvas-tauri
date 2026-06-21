/**
 * useImageViewportGesture — 图像查看/编辑器共用的缩放与平移手势。
 * macOS：双指捏合（ctrl + wheel）缩放，双指滑动平移。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

const DEFAULT_PINCH_SENSITIVITY = 0.01;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface UseImageViewportGestureOptions {
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  enablePointerPan?: boolean;
  enableWheelPan?: boolean;
  pinchSensitivity?: number;
}

export function useImageViewportGesture({
  initialScale,
  minScale = 1,
  maxScale = 8,
  enablePointerPan = true,
  enableWheelPan = true,
  pinchSensitivity = DEFAULT_PINCH_SENSITIVITY,
}: UseImageViewportGestureOptions = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const defaultScale = clamp(initialScale ?? minScale, minScale, maxScale);
  const panScale = defaultScale;
  const [scale, setScale] = useState(defaultScale);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [gesturing, setGesturing] = useState(false);
  const scaleRef = useRef(scale);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const gestureEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const reset = useCallback(() => {
    setScale(defaultScale);
    setTx(0);
    setTy(0);
  }, [defaultScale]);

  const zoomTo = useCallback((nextScale: number, cx = 0, cy = 0) => {
    setScale((prev) => {
      const next = clamp(nextScale, minScale, maxScale);
      if (next === minScale) {
        setTx(0);
        setTy(0);
        return next;
      }
      const ratio = next / prev;
      setTx((previous) => cx - ratio * (cx - previous));
      setTy((previous) => cy - ratio * (cy - previous));
      return next;
    });
  }, [maxScale, minScale]);

  const markGesturing = useCallback(() => {
    setGesturing(true);
    if (gestureEndTimer.current) clearTimeout(gestureEndTimer.current);
    gestureEndTimer.current = setTimeout(() => setGesturing(false), 120);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.ctrlKey) {
        if (!enableWheelPan || scaleRef.current <= panScale) return;
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
        markGesturing();
        setTx((previous) => previous - event.deltaX * unit);
        setTy((previous) => previous - event.deltaY * unit);
        return;
      }

      const rect = element.getBoundingClientRect();
      const cx = event.clientX - rect.left - rect.width / 2;
      const cy = event.clientY - rect.top - rect.height / 2;
      markGesturing();
      const factor = Math.exp(-event.deltaY * pinchSensitivity);
      setScale((previous) => {
        const next = clamp(previous * factor, minScale, maxScale);
        if (next === minScale) {
          setTx(0);
          setTy(0);
          return next;
        }
        const ratio = next / previous;
        setTx((current) => cx - ratio * (cx - current));
        setTy((current) => cy - ratio * (cy - current));
        return next;
      });
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      if (gestureEndTimer.current) clearTimeout(gestureEndTimer.current);
    };
  }, [enableWheelPan, markGesturing, maxScale, minScale, panScale, pinchSensitivity]);

  const onMouseDown = useCallback((event: ReactMouseEvent) => {
    if (!enablePointerPan || scaleRef.current <= panScale) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
    dragStart.current = { x: event.clientX, y: event.clientY, tx, ty };
  }, [enablePointerPan, panScale, tx, ty]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      setTx(start.tx + event.clientX - start.x);
      setTy(start.ty + event.clientY - start.y);
    };
    const onUp = () => {
      setDragging(false);
      dragStart.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  return {
    containerRef,
    scale,
    tx,
    ty,
    dragging,
    gesturing,
    cursor: scale > panScale ? (dragging ? 'grabbing' : 'grab') : 'default',
    onMouseDown,
    reset,
    zoomTo,
  };
}
