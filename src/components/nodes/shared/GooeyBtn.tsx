/**
 * 为节点连接点提供带语义色的黏性悬停反馈，不承载连接或 Store 业务逻辑。
 */
import React, { useEffect, useId, useRef } from "react";
import { useStore, type ReactFlowState } from '@xyflow/react';

interface GooeyBtnProps {
  className?: string;
  /** HSL hue，跟随 Handle 类型色：text=234, image=142, video=217, audio=30 */
  hue?: number;
}

const selectZoom = (state: ReactFlowState) => state.transform[2];

const GooeyBtn = ({ className, hue }: GooeyBtnProps) => {
const btnRef = useRef<HTMLButtonElement>(null);
const filterId = `goo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
// 反向补偿系数：放大画布（zoom>1）时取 1/zoom，按钮视觉保持 100%；
// 缩小画布（zoom<1）时钳制为 1，按钮随画布一起缩小，最大不超过 100%
const zoom = useStore(selectZoom);
const invZoom = Math.min(1, 1 / zoom);

  useEffect(() => {
    const btn = btnRef.current;
    if (!btn) return;

    const moveBg = (e: PointerEvent) => {
      const rect = btn.getBoundingClientRect();
      const x = Math.min(Math.max(((e.clientX - rect.left) / rect.width) * 100, 0), 100);
      const y = Math.min(Math.max(((e.clientY - rect.top) / rect.height) * 100, 0), 100);
      btn.style.setProperty("--x", String(x));
      btn.style.setProperty("--y", String(y));
    };

    btn.addEventListener("pointermove", moveBg);
    return () => btn.removeEventListener("pointermove", moveBg);
  }, []);

  return (
    <div
      className={`gooey-btn-wrapper ${className ?? ''}`}
      style={{ '--gooey-inv-zoom': invZoom } as React.CSSProperties}
    >
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter
          id={filterId}
          x="-120%"
          y="-120%"
          width="340%"
          height="340%"
          colorInterpolationFilters="sRGB"
        >
          <feComponentTransfer>
            <feFuncA type="discrete" tableValues="0 1" />
          </feComponentTransfer>
          <feGaussianBlur stdDeviation="5" />
          <feComponentTransfer>
            <feFuncA type="table" tableValues="-5 11" />
          </feComponentTransfer>
        </filter>
      </svg>

      <button
        ref={btnRef}
        className="gooey-btn"
        style={{ '--hue': `${hue ?? 170}deg` } as React.CSSProperties}
      />

{/* 注入 CSS 样式 */}
<style>{`
  .gooey-btn {
    --x: 50; --y: 50; --a: 0%;
    --button: hsl(var(--hue), 66%, 66%);

    display: block; /* 避免 inline-block 基线空隙撑高 wrapper，导致按钮整体偏上 */
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: transparent;
    border: none;
    position: relative;
    cursor: var(--cursor-pointer, pointer);
    transition: scale 0.5s ease;
    isolation: isolate;
  }

  .gooey-btn:hover {
   --a: 100%; scale: 1.1;
   cursor: none;
  }

  .gooey-btn::before {
    content: "";
    position: absolute;
    inset: -10px; 
    border-radius: 50%;
    filter: blur(8px) url(#${filterId}) drop-shadow(0 2px 4px rgba(0,0,0,0.2));
    
    background-image:
      linear-gradient(0deg, var(--button), var(--button)),
      radial-gradient(
        30% 90% at calc(var(--x) * 1%) calc(var(--y) * 1%),
        hsla(var(--hue), 77%, 77%, var(--a)) 0%,
        transparent 80%
      );
    
    background-clip: content-box, border-box;
    padding: 18px; 
    z-index: -1;
  }
`}</style>
    </div>
  );
};

export default GooeyBtn;
