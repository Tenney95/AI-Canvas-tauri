import React, { useEffect, useRef } from "react";

interface GooeyBtnProps {
  className?: string;
  /** HSL hue，跟随 Handle 类型色：text=234, image=142, video=217, audio=30 */
  hue?: number;
}

const GooeyBtn = ({ className, hue }: GooeyBtnProps) => {
  const btnRef = useRef(null);

  useEffect(() => {
    const btn = btnRef.current;

    const moveBg = (e) => {
      const rect = btn.getBoundingClientRect();
      const x = ((e.clientX - rect.x) / rect.width) * 100;
      const y = ((e.clientY - rect.y) / rect.height) * 100;
      btn.style.setProperty("--x", x);
      btn.style.setProperty("--y", y);
    };

    btn.addEventListener("pointermove", moveBg);
    return () => btn.removeEventListener("pointermove", moveBg);
  }, []);

  return (
    <div className={`gooey-btn-wrapper ${className ?? ''}`}>
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="goo">
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

    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: transparent;
    border: none;
    position: relative;
    cursor: pointer;
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
    filter: blur(8px) url(#goo) drop-shadow(0 2px 4px rgba(0,0,0,0.2));
    
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
