/**
 * ZoomableImage — 全屏图片缩放/平移查看器
 *
 * 能力：
 *  - 滚轮缩放（以光标位置为锚点）
 *  - 缩放后按住拖拽平移（grab / grabbing）
 *  - 双击在 1x / 2x 间切换（对准光标）
 *  - 底部控制条：缩小 / 百分比（点击复位）/ 放大
 * 复位：scale 回到 1 时自动归位；src 变化时重置。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

interface ZoomableImageProps {
  src: string;
  alt?: string;
  className?: string;
  onError?: () => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function ZoomableImage({ src, alt = '', className = '', onError }: ZoomableImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);

  // 拖拽起点（鼠标位置 + 当时的平移量）
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // src 变化时重置视图
  useEffect(() => {
    reset();
  }, [src, reset]);

  /** 以容器中心为原点，将 scale 调整到 nextScale，并保持 (cx, cy)（相对中心的像素坐标）下的图像点不动 */
  const zoomTo = useCallback((nextScale: number, cx: number, cy: number) => {
    setScale((prev) => {
      const ns = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      if (ns === MIN_SCALE) {
        setTx(0);
        setTy(0);
        return ns;
      }
      const ratio = ns / prev;
      setTx((ptx) => cx - ratio * (cx - ptx));
      setTy((pty) => cy - ratio * (cy - pty));
      return ns;
    });
  }, []);

  // 滚轮缩放（非被动监听，便于 preventDefault 阻止页面滚动）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setScale((prev) => {
        const ns = clamp(prev * factor, MIN_SCALE, MAX_SCALE);
        if (ns === MIN_SCALE) {
          setTx(0);
          setTy(0);
          return ns;
        }
        const ratio = ns / prev;
        setTx((ptx) => cx - ratio * (cx - ptx));
        setTy((pty) => cy - ratio * (cy - pty));
        return ns;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale <= MIN_SCALE) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, tx, ty };
  }, [scale, tx, ty]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = dragStart.current;
      if (!s) return;
      setTx(s.tx + (e.clientX - s.x));
      setTy(s.ty + (e.clientY - s.y));
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

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    zoomTo(scale > MIN_SCALE ? MIN_SCALE : 2, cx, cy);
  }, [scale, zoomTo]);

  const stepZoom = useCallback((dir: 1 | -1) => {
    zoomTo(scale * (dir > 0 ? 1.4 : 1 / 1.4), 0, 0);
  }, [scale, zoomTo]);

  const cursor = scale > MIN_SCALE ? (dragging ? 'grabbing' : 'grab') : 'default';

  return (
    <div
      ref={containerRef}
      className="zoomable-image-container"
      style={{ cursor }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      <img
        src={src}
        alt={alt}
        className={className}
        draggable={false}
        onError={onError}
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transition: dragging ? 'none' : 'transform 0.18s var(--ease-out-expo, ease-out)',
          willChange: 'transform',
        }}
      />

      <div className="zoom-controls" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="zoom-btn" onClick={() => stepZoom(-1)} aria-label="缩小" disabled={scale <= MIN_SCALE}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button className="zoom-percent" onClick={reset} aria-label="复位缩放" title="点击复位">
          {Math.round(scale * 100)}%
        </button>
        <button className="zoom-btn" onClick={() => stepZoom(1)} aria-label="放大" disabled={scale >= MAX_SCALE}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
