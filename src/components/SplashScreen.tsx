/**
 * SplashScreen — Hatom 风格黑白光影开屏
 * 黑暗虚空 → 中心光点爆发 → Logo 浮现 → 消散
 */
import { useEffect, useRef } from 'react';
import gsap from 'gsap';

interface SplashScreenProps {
  onComplete: () => void;
}

/* ============================================
   Logo 线条版
   ============================================ */
function LogoOutline() {
  return (
    <svg
      width="80" height="80"
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', position: 'relative', zIndex: 2 }}
    >
      <path
        data-logo-squircle
        d="M512,4 C898,4 1020,122 1020,512 C1020,902 898,1020 512,1020 C126,1020 4,902 4,512 C4,122 126,4 512,4Z"
        fill="rgba(255,255,255,0.015)"
        stroke="white"
        strokeOpacity="0.25"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <g transform="translate(512, 512) scale(1.35)">
        <path
          data-logo-sparkle
          d="M0,-260 C15,-120 120,-15 260,0 C120,15 15,120 0,260 C-15,120 -120,15 -260,0 C-120,-15 -15,-120 0,-260Z"
          stroke="white"
          strokeOpacity="0.7"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          data-logo-core
          cx="0" cy="0" r="42"
          stroke="white"
          strokeOpacity="0"
          strokeWidth="2"
        />
      </g>
    </svg>
  );
}

const PARTICLES = [
  { x: -148, y: -92, size: 1 },
  { x: -104, y: 126, size: 1.5 },
  { x: -72, y: -142, size: 1 },
  { x: -38, y: 96, size: 1 },
  { x: 22, y: -118, size: 1.5 },
  { x: 54, y: 136, size: 1 },
  { x: 92, y: -76, size: 1 },
  { x: 132, y: 84, size: 1.5 },
  { x: 158, y: -18, size: 1 },
  { x: -164, y: 28, size: 1 },
] as const;

function CosmicParticles() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {PARTICLES.map((particle, index) => (
        <div
          key={index}
          data-cosmic-particle
          className="absolute rounded-full"
          style={{
            width: particle.size,
            height: particle.size,
            background: 'rgba(255,255,255,0.3)',
            opacity: 0,
            left: '50%',
            top: '50%',
            transform: `translate(${particle.x}px, ${particle.y}px)`,
          }}
        />
      ))}
    </div>
  );
}

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCompleteRef = useRef(onComplete);
  const logoWrapRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const titleInnerRef = useRef<HTMLSpanElement>(null);
  const coreLightRef = useRef<HTMLDivElement>(null);
  const lightSweepRef = useRef<HTMLDivElement>(null);
  const vignetteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let skip = () => {};
    const ctx = gsap.context(() => {
      const sparklePath = logoWrapRef.current?.querySelector('[data-logo-sparkle]') as SVGPathElement | null;
      const squirclePath = logoWrapRef.current?.querySelector('[data-logo-squircle]') as SVGPathElement | null;
      const coreCircle = logoWrapRef.current?.querySelector('[data-logo-core]') as SVGCircleElement | null;
      const cosmicParticles = container.querySelectorAll('[data-cosmic-particle]');
      let timeline: gsap.core.Timeline | null = null;
      let finishing = false;

      const finish = (duration = 0.2) => {
        if (finishing) return;
        finishing = true;
        timeline?.kill();
        gsap.to(container, {
          opacity: 0,
          duration,
          ease: 'power2.inOut',
          overwrite: true,
          onComplete: () => onCompleteRef.current(),
        });
      };

      skip = () => finish(0.1);

      gsap.set([logoWrapRef.current, titleRef.current], { opacity: 0, scale: 0.88 });
      gsap.set(titleRef.current, { y: 6 });
      gsap.set(container, { opacity: 1 });
      gsap.set(lightSweepRef.current, { left: '-100%', opacity: 0 });
      gsap.set(coreLightRef.current, { opacity: 0, scale: 0 });
      if (sparklePath) gsap.set(sparklePath, { strokeOpacity: 0 });
      if (squirclePath) gsap.set(squirclePath, { strokeOpacity: 0 });
      if (coreCircle) gsap.set(coreCircle, { strokeOpacity: 0 });

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        gsap.set([logoWrapRef.current, titleRef.current], { opacity: 1, scale: 1, y: 0 });
        gsap.set(coreLightRef.current, { opacity: 0.18, scale: 0.5 });
        if (sparklePath) gsap.set(sparklePath, { strokeOpacity: 0.7 });
        if (squirclePath) gsap.set(squirclePath, { strokeOpacity: 0.25 });
        if (coreCircle) gsap.set(coreCircle, { strokeOpacity: 0.4 });
        gsap.delayedCall(0.08, () => finish(0.12));
        return;
      }

      timeline = gsap.timeline({ onComplete: () => finish() });

      timeline
        .to(cosmicParticles, {
          opacity: 0.32,
          duration: 0.16,
          stagger: 0.008,
          ease: 'power2.out',
        }, 0)
        .to(vignetteRef.current, {
          opacity: 1,
          duration: 0.14,
          ease: 'power2.out',
        }, 0)
        .to(coreLightRef.current, {
          opacity: 1,
          scale: 1,
          duration: 0.18,
          ease: 'power3.out',
        }, 0.07)
        .to(logoWrapRef.current, {
          opacity: 1,
          scale: 1,
          duration: 0.24,
          ease: 'power3.out',
        }, 0.16)
        .to(coreLightRef.current, {
          opacity: 0.28,
          scale: 0.5,
          duration: 0.18,
          ease: 'power2.inOut',
        }, 0.22);

      if (squirclePath) {
        timeline.to(squirclePath, {
          strokeOpacity: 0.25,
          duration: 0.18,
          ease: 'power2.out',
        }, 0.2);
      }
      if (sparklePath) {
        timeline.to(sparklePath, {
          strokeOpacity: 0.7,
          duration: 0.2,
          ease: 'power2.out',
        }, 0.24);
      }
      if (coreCircle) {
        timeline.to(coreCircle, {
          strokeOpacity: 0.45,
          duration: 0.16,
          ease: 'power2.out',
        }, 0.28);
      }

      timeline
        .to(logoWrapRef.current, {
          boxShadow: '0 0 72px rgba(255,255,255,0.10), 0 0 140px rgba(255,255,255,0.035)',
          duration: 0.22,
          ease: 'power2.out',
        }, 0.22)
        .to(titleRef.current, {
          opacity: 1,
          scale: 1,
          y: 0,
          duration: 0.2,
          ease: 'power3.out',
        }, 0.36)
        .to(lightSweepRef.current, {
          opacity: 1,
          left: '100%',
          duration: 0.28,
          ease: 'power2.inOut',
        }, 0.46)
        .to(titleInnerRef.current, {
          textShadow: '0 0 12px rgba(255,255,255,0.14), 0 0 24px rgba(255,255,255,0.04)',
          duration: 0.12,
          ease: 'power2.out',
        }, 0.5)
        .to(titleInnerRef.current, {
          textShadow: '0 1px 6px rgba(255,255,255,0.06), 0 2px 14px rgba(255,255,255,0.03)',
          duration: 0.16,
          ease: 'power2.inOut',
        }, 0.62)
        .to(lightSweepRef.current, {
          opacity: 0,
          duration: 0.1,
          ease: 'power2.in',
        }, 0.7)
        .to(logoWrapRef.current, {
          boxShadow: '0 0 56px rgba(255,255,255,0.07), 0 0 110px rgba(255,255,255,0.025)',
          duration: 0.2,
          ease: 'power2.inOut',
        }, 0.62)
        .to(cosmicParticles, {
          opacity: 0,
          duration: 0.18,
          ease: 'power2.in',
        }, 0.68)
        .to({}, { duration: 0.08 });
    }, container);

    const completionTimeout = window.setTimeout(() => skip(), 1400);
    window.addEventListener('keydown', skip);
    container.addEventListener('pointerdown', skip);

    return () => {
      window.clearTimeout(completionTimeout);
      window.removeEventListener('keydown', skip);
      container.removeEventListener('pointerdown', skip);
      ctx.revert();
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      ref={containerRef}
      role="status"
      aria-label="AI Canvas 正在启动"
      className="fixed inset-0 z-[9999] select-none overflow-hidden flex items-center justify-center bg-black rounded-[16px]"
    >
      {/* 宇宙微尘 */}
      <CosmicParticles />

      {/* 暗角光 */}
      <div
        ref={vignetteRef}
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at 50% 50%, rgba(255,255,255,0.018) 0%, transparent 60%)',
          opacity: 0,
        }}
      />

      {/* 中心光点 — 像 Hatom 蛋体发出的强光 */}
      <div
        ref={coreLightRef}
        className="absolute pointer-events-none"
        style={{
          width: 120,
          height: 120,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.04) 30%, transparent 70%)',
          opacity: 0,
          transform: 'scale(0)',
          top: '50%',
          left: '50%',
          marginLeft: -60,
          marginTop: -60,
        }}
      />

      {/* 中心内容 */}
      <div className="relative flex flex-col items-center gap-8">
        {/* Logo */}
        <div
          ref={logoWrapRef}
          className="relative w-20 h-20 flex items-center justify-center"
          style={{ transformOrigin: 'center center', opacity: 0, borderRadius: 30, overflow: 'hidden' }}
        >
          <LogoOutline />
        </div>

        {/* 应用名 */}
        <div
          ref={titleRef}
          className="relative overflow-hidden"
          style={{ opacity: 0 }}
        >
          <div
            ref={lightSweepRef}
            className="absolute top-0 h-full w-1/2 pointer-events-none"
            style={{
              background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 60%, transparent 100%)',
              opacity: 0,
            }}
          />
          <span
            ref={titleInnerRef}
            className="block text-xl font-light tracking-[0.25em] uppercase"
            style={{
              color: 'rgba(255,255,255,0.7)',
              letterSpacing: '0.3em',
            }}
          >
            AI Canvas
          </span>
        </div>
      </div>
    </div>
  );
}
