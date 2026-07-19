/**
 * CanvasBackground — 根据 config.canvasBackground 渲染对应的画布背景主题
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { CanvasBackground as CanvasBg } from '../../types';

// 懒加载：两个主题背景引入 three / postprocessing（体积大户），仅在选中对应主题时才加载
const SolarSystemBackground = lazy(() => import('./SolarSystemBackground'));
const NebulaBackground = lazy(() => import('./NebulaBackground'));

/** 背景主题配置 */
export const BACKGROUND_OPTIONS: { value: CanvasBg; label: string; preview: string; theme: 'dark' | 'light' }[] = [
  { value: 'default', label: '默认暗色', preview: 'canvas-bg', theme: 'dark' },
  { value: 'solar-system', label: '太阳系', preview: 'solar-system', theme: 'dark' },
  { value: 'nebula', label: '星云', preview: 'nebula', theme: 'dark' },
  { value: 'off-white', label: '米白浅色', preview: 'off-white', theme: 'light' },
  { value: 'frosted-glass', label: '磨砂暖光', preview: 'frosted-glass', theme: 'light' },
  { value: 'custom', label: '自定义图片', preview: 'custom', theme: 'dark' },
  // { value: 'minimal', label: '极简纯黑', preview: 'minimal', theme: 'dark' },
];

function FrostedGlassBackground() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneCount, setPaneCount] = useState(35);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const updateGrid = () => {
      const bounds = root.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;

      const shortestSide = Math.min(bounds.width, bounds.height);
      const gap = Math.min(5, Math.max(3, shortestSide * 0.003));
      const targetSize = Math.min(280, Math.max(180, shortestSide * 0.23));
      const columns = Math.max(1, Math.floor((bounds.width + gap) / (targetSize + gap)));
      const paneSize = (bounds.width - gap * (columns - 1)) / columns;
      const rows = Math.max(1, Math.ceil((bounds.height + gap) / (paneSize + gap)));
      const nextCount = columns * rows;

      root.style.setProperty('--frosted-grid-columns', String(columns));
      setPaneCount((currentCount) => currentCount === nextCount ? currentCount : nextCount);
    };

    const resizeObserver = new ResizeObserver(updateGrid);
    resizeObserver.observe(root);
    updateGrid();

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const initialBounds = root.getBoundingClientRect();
    let currentX = initialBounds.width * 0.58;
    let currentY = initialBounds.height * 0.38;
    let targetX = currentX;
    let targetY = currentY;
    let animationFrame = 0;

    const applyPosition = () => {
      root.style.setProperty('--frosted-orb-x', `${currentX.toFixed(1)}px`);
      root.style.setProperty('--frosted-orb-y', `${currentY.toFixed(1)}px`);
    };

    const animate = () => {
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;
      applyPosition();

      if (Math.abs(targetX - currentX) > 0.2 || Math.abs(targetY - currentY) > 0.2) {
        animationFrame = requestAnimationFrame(animate);
      } else {
        animationFrame = 0;
      }
    };

    const scheduleAnimation = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(animate);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches || coarsePointer.matches) return;
      const bounds = root.getBoundingClientRect();
      const overflowX = bounds.width * 0.1;
      const overflowY = bounds.height * 0.1;
      targetX = Math.min(bounds.width + overflowX, Math.max(-overflowX, event.clientX - bounds.left));
      targetY = Math.min(bounds.height + overflowY, Math.max(-overflowY, event.clientY - bounds.top));
      scheduleAnimation();
    };

    const resetToStaticComposition = () => {
      if (!reducedMotion.matches && !coarsePointer.matches) return;
      const bounds = root.getBoundingClientRect();
      targetX = bounds.width * 0.58;
      targetY = bounds.height * 0.38;
      scheduleAnimation();
    };

    applyPosition();
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    reducedMotion.addEventListener('change', resetToStaticComposition);
    coarsePointer.addEventListener('change', resetToStaticComposition);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      reducedMotion.removeEventListener('change', resetToStaticComposition);
      coarsePointer.removeEventListener('change', resetToStaticComposition);
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div ref={rootRef} className="canvas-bg-frosted" aria-hidden="true">
      <div className="canvas-bg-frosted__orb" />
      <div className="canvas-bg-frosted__grid">
        {Array.from({ length: paneCount }, (_, pane) => (
          <span key={pane} className="canvas-bg-frosted__pane" />
        ))}
      </div>
      <div className="canvas-bg-frosted__grain" />
    </div>
  );
}

export default function CanvasBackground() {
  const canvasBackground = useAppStore((s) => s.config.canvasBackground);
  const customBgUrl = useAppStore((s) => s.config.customBackgroundUrl);
  const customBgOpacity = useAppStore((s) => s.config.customBackgroundOpacity);

  switch (canvasBackground) {
    case 'solar-system':
      return <Suspense fallback={null}><SolarSystemBackground /></Suspense>;
    case 'nebula':
      return <Suspense fallback={null}><NebulaBackground /></Suspense>;
    case 'off-white':
      return <div className="canvas-bg-off-white" />;
    case 'frosted-glass':
      return <FrostedGlassBackground />;
    case 'minimal':
      return <div className="canvas-bg-minimal" />;
    case 'custom':
      if (!customBgUrl) return null;
      return (
        <div
          className="absolute inset-0 z-0"
          style={{
            backgroundImage: `url(${customBgUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            opacity: customBgOpacity ?? 0.3,
          }}
        />
      );
    default:
      return null; // 默认暗色由 app-box 自身的 bg-canvas-bg 提供
  }
}
