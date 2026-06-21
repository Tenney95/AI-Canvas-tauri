/**
 * useImageViewportGesture — 图像查看/编辑器共用的缩放与平移手势。
 * - macOS：双指捏合（ctrl + wheel）缩放，双指滑动平移。
 * - Windows/Linux：滚轮缩放（无 ctrl 也缩放）。
 *
 * 注意：wheel 监听通过「回调 ref」在元素挂载/卸载时即时绑定/解绑，
 * 以兼容容器延后挂载的场景（如 CropEditor：组件常驻、但容器在弹层打开后才进 DOM）。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const DEFAULT_PINCH_SENSITIVITY = 0.01;
/** 鼠标滚轮缩放灵敏度（鼠标单格 deltaY≈±100，远大于 trackpad 捏合，需更温和）*/
const WHEEL_ZOOM_SENSITIVITY = 0.001;

/** mac 上区分「捏合缩放(ctrl+wheel)」与「双指平移(wheel)」；非 mac 滚轮一律缩放 */
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface UseImageViewportGestureOptions {
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  enablePointerPan?: boolean;
  enableWheelPan?: boolean;
  pinchSensitivity?: number;
  /** 哪些鼠标键触发拖拽平移：0=左键 1=滚轮键 2=右键。默认 [0] */
  panButtons?: number[];
}

export function useImageViewportGesture({
  initialScale,
  minScale = 1,
  maxScale = 8,
  enablePointerPan = true,
  enableWheelPan = true,
  pinchSensitivity = DEFAULT_PINCH_SENSITIVITY,
  panButtons = [0],
}: UseImageViewportGestureOptions = {}) {
  const containerEl = useRef<HTMLDivElement | null>(null);
  const defaultScale = clamp(initialScale ?? minScale, minScale, maxScale);
  const panScale = defaultScale;
  const [scale, setScale] = useState(defaultScale);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [gesturing, setGesturing] = useState(false);
  const scaleRef = useRef(scale);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number; pointerId: number } | null>(null);
  const gestureEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 把最新配置放进 ref，让稳定的处理器读取，避免反复重绑监听
  const cfgRef = useRef({ minScale, maxScale, panScale, enableWheelPan, pinchSensitivity, panButtons });
  cfgRef.current = { minScale, maxScale, panScale, enableWheelPan, pinchSensitivity, panButtons };

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
      const cfg = cfgRef.current;
      const next = clamp(nextScale, cfg.minScale, cfg.maxScale);
      if (next <= cfg.panScale) {
        setTx(0);
        setTy(0);
        return next;
      }
      const ratio = next / prev;
      setTx((previous) => cx - ratio * (cx - previous));
      setTy((previous) => cy - ratio * (cy - previous));
      return next;
    });
  }, []);

  const markGesturing = useCallback(() => {
    setGesturing(true);
    if (gestureEndTimer.current) clearTimeout(gestureEndTimer.current);
    gestureEndTimer.current = setTimeout(() => setGesturing(false), 120);
  }, []);

  // wheel 处理器：缩放（捏合 / 非 mac 滚轮）或平移（mac 双指滑动）
  const attachWheel = useCallback(
    (element: HTMLDivElement) => {
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const cfg = cfgRef.current;
        // 缩放条件：ctrl+wheel（mac 捏合 / 任意平台 ctrl+滚轮），或非 mac 的普通滚轮
        const wantZoom = event.ctrlKey || !IS_MAC;

        if (!wantZoom) {
          // mac 双指滑动平移（仅放大后生效）
          if (!cfg.enableWheelPan || scaleRef.current <= cfg.panScale) return;
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
        // 归一化滚动量（行/页换算为像素）
        let dy = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
        else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= 100;
        // 捏合(ctrl)：trackpad delta 小，用较高灵敏度；鼠标滚轮：限幅 + 温和灵敏度
        const factor = event.ctrlKey
          ? Math.exp(-clamp(dy, -40, 40) * cfg.pinchSensitivity)
          : Math.exp(-clamp(dy, -120, 120) * WHEEL_ZOOM_SENSITIVITY);
        setScale((previous) => {
          const next = clamp(previous * factor, cfg.minScale, cfg.maxScale);
          if (next <= cfg.panScale) {
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
      return () => element.removeEventListener('wheel', onWheel);
    },
    [markGesturing],
  );

  // 回调 ref：元素挂载即绑定 wheel，卸载即解绑（兼容容器延后挂载）
  const wheelCleanup = useRef<(() => void) | null>(null);
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (wheelCleanup.current) {
        wheelCleanup.current();
        wheelCleanup.current = null;
      }
      containerEl.current = node;
      if (node) wheelCleanup.current = attachWheel(node);
    },
    [attachWheel],
  );

  useEffect(() => {
    return () => {
      if (wheelCleanup.current) wheelCleanup.current();
      if (gestureEndTimer.current) clearTimeout(gestureEndTimer.current);
    };
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!enablePointerPan || scaleRef.current <= panScale) return;
      if (!cfgRef.current.panButtons.includes(event.button)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(true);
      dragStart.current = { x: event.clientX, y: event.clientY, tx, ty, pointerId: event.pointerId };
    },
    [enablePointerPan, panScale, tx, ty],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const start = dragStart.current;
      if (!start || event.pointerId !== start.pointerId) return;
      setTx(start.tx + event.clientX - start.x);
      setTy(start.ty + event.clientY - start.y);
    };
    const onUp = (event: PointerEvent) => {
      const start = dragStart.current;
      if (start && event.pointerId !== start.pointerId) return;
      setDragging(false);
      dragStart.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  return {
    containerRef,
    containerEl,
    scale,
    tx,
    ty,
    dragging,
    gesturing,
    cursor: scale > panScale ? (dragging ? 'grabbing' : 'grab') : 'default',
    onPointerDown,
    reset,
    zoomTo,
  };
}
