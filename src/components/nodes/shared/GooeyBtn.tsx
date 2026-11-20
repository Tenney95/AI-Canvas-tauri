/**
 * 为节点连接点提供带语义色的黏性悬停反馈，不承载连接或 Store 业务逻辑。
 */
import React, { createContext, useContext, useId, type ReactNode } from 'react';

interface GooeyBtnProps {
  className?: string;
  /** HSL hue，跟随 Handle 类型色：text=234, image=142, video=217, audio=30 */
  hue?: number;
  ariaLabel?: string;
  title?: string;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
}

const FilterContext = createContext<string | null>(null);

function useFilterId() {
  return `goo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function FilterDefinition({ id }: { id: string }) {
  return (
    <svg width="0" height="0" className="pointer-events-none absolute" aria-hidden="true" focusable="false">
      <filter id={id} x="-120%" y="-120%" width="340%" height="340%" colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncA type="discrete" tableValues="0 1" />
        </feComponentTransfer>
        <feGaussianBlur stdDeviation="5" />
        <feComponentTransfer>
          <feFuncA type="table" tableValues="-5 11" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

/** 滤镜参数与节点无关，定义随画布存活，节点进出视口时只挂载自己的按钮。 */
export function CanvasHandleFilter({ children }: { children: ReactNode }) {
  const id = useFilterId();
  return (
    <FilterContext.Provider value={id}>
      <FilterDefinition id={id} />
      {children}
    </FilterContext.Provider>
  );
}

function moveBackground(event: React.PointerEvent<HTMLButtonElement>) {
  const button = event.currentTarget;
  const rect = button.getBoundingClientRect();
  const x = Math.min(Math.max(((event.clientX - rect.left) / rect.width) * 100, 0), 100);
  const y = Math.min(Math.max(((event.clientY - rect.top) / rect.height) * 100, 0), 100);
  button.style.setProperty('--x', String(x));
  button.style.setProperty('--y', String(y));
}

const GooeyBtn = ({ className, hue, ariaLabel, title, onPointerDown }: GooeyBtnProps) => {
  const shared = useContext(FilterContext);
  const local = useFilterId();
  const filterId = shared ?? local;
  return (
    <div className={`gooey-btn-wrapper ${className ?? ''}`}>
      {shared === null && <FilterDefinition id={local} />}
      <button
        type="button"
        className="gooey-btn"
        aria-label={ariaLabel}
        title={title}
        onPointerMove={moveBackground}
        onPointerDown={onPointerDown}
        style={{
          '--hue': `${hue ?? 170}deg`,
          '--gooey-filter': `url(#${filterId})`,
        } as React.CSSProperties}
      />
    </div>
  );
};

export default GooeyBtn;
