/**
 * 为节点连接点提供带语义色的黏性悬停反馈，不承载连接或 Store 业务逻辑。
 */
import React, { useEffect, useId, useRef } from 'react';

interface GooeyBtnProps {
  className?: string;
  /** HSL hue，跟随 Handle 类型色：text=234, image=142, video=217, audio=30 */
  hue?: number;
}

const GooeyBtn = ({ className, hue }: GooeyBtnProps) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const filterId = `goo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // 缩放补偿从 Canvas 根节点继承，避免每个连接按钮订阅视口并在缩放时重渲染。

  useEffect(() => {
    const btn = btnRef.current;
    if (!btn) return;

    const moveBg = (e: PointerEvent) => {
      const rect = btn.getBoundingClientRect();
      const x = Math.min(Math.max(((e.clientX - rect.left) / rect.width) * 100, 0), 100);
      const y = Math.min(Math.max(((e.clientY - rect.top) / rect.height) * 100, 0), 100);
      btn.style.setProperty('--x', String(x));
      btn.style.setProperty('--y', String(y));
    };

    btn.addEventListener('pointermove', moveBg);
    return () => btn.removeEventListener('pointermove', moveBg);
  }, []);

  return (
    <div
      className={`gooey-btn-wrapper ${className ?? ''}`}
    >
      <svg width="0" height="0" style={{ position: 'absolute' }}>
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
        style={{
          '--hue': `${hue ?? 170}deg`,
          '--gooey-filter': `url(#${filterId})`,
        } as React.CSSProperties}
      />
    </div>
  );
};

export default GooeyBtn;
