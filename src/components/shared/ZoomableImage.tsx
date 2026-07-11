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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useImageViewportGesture } from '../../hooks/useImageViewportGesture';
import { EASE_OUT_EXPO } from '../../utils/motion';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const FLY_DURATION = 500;

interface ZoomableImageProps {
  src: string;
  alt?: string;
  className?: string;
  onError?: () => void;
  onClose?: () => void;
  originRect?: { left: number; top: number; width: number; height: number };
}

export default function ZoomableImage({ src, alt = '', className = '', onError, onClose, originRect }: ZoomableImageProps) {
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
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [imageLayoutVersion, setImageLayoutVersion] = useState(0);
  const [flightDone, setFlightDone] = useState(!originRect);
  const isFlying = Boolean(originRect && !flightDone);

  // src 变化时重置视图
  useEffect(() => {
    reset();
  }, [src, reset]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const img = imageRef.current;
    if (!originRect || !stage) {
      setFlightDone(true);
      return;
    }

    if (originRect.width <= 0 || originRect.height <= 0) return;

    // 显式计算目标位置（与 CSS max-width:92vw / max-height:92vh / object-fit:contain 对齐）
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    // 悬浮侧边栏模式下 .fullscreen-overlay 有 left:30px，
    // 动画用 fixed 坐标必须对应偏移，否则结束后会向左跳变
    const sidebarIndent =
      document.documentElement.getAttribute('data-sidebar-floating') !== null ? 30 : 0;
    const availW = viewportW - sidebarIndent;
    const maxW = availW * 0.92;
    const maxH = viewportH * 0.92;

    const naturalW = img?.naturalWidth ?? 0;
    const naturalH = img?.naturalHeight ?? 0;

    let targetW: number;
    let targetH: number;

    if (naturalW > 0 && naturalH > 0) {
      const scale = Math.min(1, maxW / naturalW, maxH / naturalH);
      targetW = naturalW * scale;
      targetH = naturalH * scale;
    } else {
      // 图片尚未加载时用 originRect 宽高比作为近似值
      const targetRect = stage.getBoundingClientRect();
      if (targetRect.width <= 0 || targetRect.height <= 0) return;
      targetW = Math.min(targetRect.width, maxW);
      targetH = Math.min(targetRect.height, maxH);
      const fit = Math.min(maxW / targetW, maxH / targetH, 1);
      targetW *= fit;
      targetH *= fit;
    }

    const targetLeft = sidebarIndent + (availW - targetW) / 2;
    const targetTop = (viewportH - targetH) / 2;
    const targetRatio = targetW / targetH;

    // 计算起始大小：保持目标宽高比，不超出 originRect
    let startWidth = originRect.width;
    let startHeight = startWidth / targetRatio;
    if (startHeight > originRect.height) {
      startHeight = originRect.height;
      startWidth = startHeight * targetRatio;
    }
    const startLeft = originRect.left + (originRect.width - startWidth) / 2;
    const startTop = originRect.top + (originRect.height - startHeight) / 2;

    setFlightDone(false);

    // 使用 WAAPI element.animate() 直接从 DOM 驱动动画
    const stageEl = stage;

    // 1) 强制将元素定位到起始位置（DOM 直接写入）
    const restoreDisplay = stageEl.style.display;
    const restorePosition = stageEl.style.position;
    stageEl.style.position = 'fixed';
    stageEl.style.left = `${startLeft}px`;
    stageEl.style.top = `${startTop}px`;
    stageEl.style.width = `${startWidth}px`;
    stageEl.style.height = `${startHeight}px`;
    stageEl.style.filter = 'blur(0px)';
    stageEl.style.transition = 'none';

    // 2) 强制浏览器应用上述样式（reflow）
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    stageEl.offsetHeight;

    // 3) 启动 WAAPI 动画
    const animation = stageEl.animate(
      [
        {
          left: `${startLeft}px`,
          top: `${startTop}px`,
          width: `${startWidth}px`,
          height: `${startHeight}px`,
        },
        {
          left: `${targetLeft}px`,
          top: `${targetTop}px`,
          width: `${targetW}px`,
          height: `${targetH}px`,
        },
      ],
      {
        duration: FLY_DURATION,
        easing: `cubic-bezier(${EASE_OUT_EXPO.join(', ')})`,
        fill: 'forwards' as FillMode,
      },
    );

    animation.onfinish = () => {
      // 动画结束：恢复内联样式，让 CSS class 接管
      stageEl.style.position = restorePosition;
      stageEl.style.left = '';
      stageEl.style.top = '';
      stageEl.style.width = '';
      stageEl.style.height = '';
      stageEl.style.opacity = '';
      stageEl.style.filter = '';
      stageEl.style.transition = '';
      stageEl.style.display = restoreDisplay;
      setFlightDone(true);
    };

    return () => {
      animation.onfinish = null;
      animation.cancel();
      stageEl.style.position = restorePosition;
      stageEl.style.left = '';
      stageEl.style.top = '';
      stageEl.style.width = '';
      stageEl.style.height = '';
      stageEl.style.opacity = '';
      stageEl.style.filter = '';
      stageEl.style.transition = '';
      stageEl.style.display = restoreDisplay;
    };
  }, [originRect, src, imageLayoutVersion]);

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

  const handleClick = useCallback(() => {
    if (scale <= MIN_SCALE) onClose?.();
  }, [scale, onClose]);

  return (
    <div
      ref={containerRef}
      className="zoomable-image-container"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onDoubleClick={handleDoubleClick}
      onClick={handleClick}
    >
      <div
        ref={stageRef}
        className={`zoomable-image-stage${originRect ? ' is-origin-linked' : ''}${isFlying ? ' is-flying' : ''}`}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          className={className}
          draggable={false}
          onLoad={() => setImageLayoutVersion((v) => v + 1)}
          onError={onError}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transition: dragging || gesturing ? 'none' : 'transform 0.18s var(--ease-out-expo, ease-out)',
            willChange: 'transform',
          }}
        />
      </div>

      <div className="zoom-controls" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="zoom-btn" onClick={() => stepZoom(-1)} aria-label="缩小" disabled={scale <= MIN_SCALE}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button className="zoom-percent" onClick={reset} aria-label="复位缩放" data-tooltip="点击复位">
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
