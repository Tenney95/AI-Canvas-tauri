/**
 * ZoomableImage — 全屏图片缩放/平移查看器
 *
 * 能力：
 *  - 双指捏合缩放（以光标位置为锚点）
 *  - 双指滑动 / 滚轮平移
 *  - 缩放后按住拖拽平移（grab / grabbing）
 *  - 双击在 1x / 2x 间切换（对准光标）
 *  - 底部控制条：缩小 / 百分比（点击复位）/ 放大
 * 复位：scale 回到 1 时自动归位；src 变化时重置。
 */
import { useCallback, useEffect } from 'react';
import { useImageViewportGesture } from '../../hooks/useImageViewportGesture';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

interface ZoomableImageProps {
  src: string;
  alt?: string;
  className?: string;
  onError?: () => void;
}

export default function ZoomableImage({ src, alt = '', className = '', onError }: ZoomableImageProps) {
  const {
    containerRef,
    containerEl,
    scale,
    tx,
    ty,
    dragging,
    gesturing,
    cursor,
    onPointerDown,
    reset,
    zoomTo,
  } = useImageViewportGesture({ minScale: MIN_SCALE, maxScale: MAX_SCALE });

  // src 变化时重置视图
  useEffect(() => {
    reset();
  }, [src, reset]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerEl.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    zoomTo(scale > MIN_SCALE ? MIN_SCALE : 2, cx, cy);
  }, [containerEl, scale, zoomTo]);

  const stepZoom = useCallback((dir: 1 | -1) => {
    zoomTo(scale * (dir > 0 ? 1.4 : 1 / 1.4), 0, 0);
  }, [scale, zoomTo]);

  return (
    <div
      ref={containerRef}
      className="zoomable-image-container"
      style={{ cursor }}
      onPointerDown={onPointerDown}
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
          transition: dragging || gesturing ? 'none' : 'transform 0.18s var(--ease-out-expo, ease-out)',
          willChange: 'transform',
        }}
      />

      <div className="zoom-controls" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
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
