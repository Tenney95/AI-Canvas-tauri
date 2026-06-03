/**
 * SplashScreen — Hatom 风格黑白光影开屏
 * 黑暗虚空 → 中心光点爆发 → Logo 浮现 → 消散
 */
import { useEffect, useRef, useMemo } from 'react';
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

/* ============================================
   Cosmic Particles — 漂浮的宇宙微尘
   ============================================ */
function CosmicParticles() {
  const particles = useMemo(() => {
    return Array.from({ length: 24 }, (_, i) => ({
      id: i,
      size: 1 + Math.random() * 2,
      x: (Math.random() - 0.5) * 360,
      y: (Math.random() - 0.5) * 360,
      delay: Math.random() * 3,
      duration: 3 + Math.random() * 5,
    }));
  }, []);

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {particles.map((p) => (
        <div
          key={p.id}
          data-cosmic-particle
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            background: 'rgba(255,255,255,0.3)',
            opacity: 0,
            left: '50%',
            top: '50%',
            transform: `translate(${p.x}px, ${p.y}px)`,
          }}
        />
      ))}
    </div>
  );
}

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const logoWrapRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const titleInnerRef = useRef<HTMLSpanElement>(null);
  const coreLightRef = useRef<HTMLDivElement>(null);
  const lightSweepRef = useRef<HTMLDivElement>(null);
  const vignetteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const sparklePath = logoWrapRef.current?.querySelector('[data-logo-sparkle]') as SVGPathElement | null;
      const squirclePath = logoWrapRef.current?.querySelector('[data-logo-squircle]') as SVGPathElement | null;
      const coreCircle = logoWrapRef.current?.querySelector('[data-logo-core]') as SVGCircleElement | null;
      const cosmicParticles = document.querySelectorAll('[data-cosmic-particle]');
      // ── 初始状态 ──
      gsap.set([logoWrapRef.current, titleRef.current], { opacity: 0, scale: 0.8 });
      gsap.set(containerRef.current, { opacity: 1 });
      gsap.set(lightSweepRef.current, { left: '-100%', opacity: 0 });
      gsap.set(coreLightRef.current, { opacity: 0, scale: 0 });
      if (sparklePath) gsap.set(sparklePath, { strokeOpacity: 0 });
      if (squirclePath) gsap.set(squirclePath, { strokeOpacity: 0 });
      if (coreCircle) gsap.set(coreCircle, { strokeOpacity: 0 });

      const tl = gsap.timeline({
        onComplete: () => {
          gsap.to(containerRef.current, {
            opacity: 0,
            duration: 0.7,
            ease: 'power2.in',
            onComplete,
          });
        },
      });

      // ═══════════════════════════════════════
      // Phase 1: Void — 宇宙微尘浮现
      // ═══════════════════════════════════════
      tl.to(cosmicParticles, {
        opacity: 0.5,
        duration: 0.25,
        stagger: 0.015,
        ease: 'power2.out',
      });

      // ═══════════════════════════════════════
      // Phase 2: Ignition — 中心光点亮起
      // ═══════════════════════════════════════
      tl.to(vignetteRef.current, {
        opacity: 1,
        duration: 0.15,
        ease: 'power2.out',
      }, '-=0.1');

      tl.to(coreLightRef.current, {
        opacity: 1,
        scale: 1,
        duration: 0.2,
        ease: 'power2.out',
      }, '-=0.08');

      // 光点脉动一下后稳定
      tl.to(coreLightRef.current, {
        scale: 0.7,
        duration: 0.1,
        ease: 'power2.inOut',
      });
      tl.to(coreLightRef.current, {
        scale: 1,
        duration: 0.12,
        ease: 'power2.out',
      });

      // ═══════════════════════════════════════
      // Phase 3: Emergence — Logo 从光中浮现
      // ═══════════════════════════════════════
      // Logo 出现 — 带弹性
      tl.to(logoWrapRef.current, {
        opacity: 1,
        scale: 1,
        duration: 0.25,
        ease: 'back.out(1.7)',
      }, '-=0.1');

      // Squircle 描边渐现
      if (squirclePath) {
        tl.to(squirclePath, {
          strokeOpacity: 0.25,
          duration: 0.15,
          ease: 'power2.out',
        }, '-=0.15');
      }

      // Sparkle 描边渐现
      if (sparklePath) {
        tl.to(sparklePath, {
          strokeOpacity: 0.7,
          duration: 0.18,
          ease: 'power2.out',
        }, '-=0.1');
      }

      // 中心圆描边
      if (coreCircle) {
        tl.to(coreCircle, {
          strokeOpacity: 0.5,
          duration: 0.12,
          ease: 'power2.out',
        }, '-=0.08');
      }

      // Logo 环光
      tl.to(logoWrapRef.current, {
        boxShadow: '0 0 80px rgba(255,255,255,0.10), 0 0 160px rgba(255,255,255,0.04)',
        duration: 0.18,
        ease: 'power2.out',
      }, '-=0.15');

      // 中心光弱化
      tl.to(coreLightRef.current, {
        opacity: 0.3,
        scale: 0.5,
        duration: 0.2,
        ease: 'power2.in',
      }, '-=0.2');

      // ═══════════════════════════════════════
      // Phase 4: Title — 标题浮现
      // ═══════════════════════════════════════
      tl.to(titleRef.current, {
        opacity: 1,
        duration: 0.25,
        ease: 'power2.out',
      }, '-=0.1');

      // 光条从文字背后滑过
      tl.to({}, { duration: 0.08 });
      tl.to(lightSweepRef.current, {
        opacity: 1,
        left: '100%',
        duration: 0.3,
        ease: 'power2.inOut',
      });
      tl.to(titleInnerRef.current, {
        textShadow: '-2px 0 10px rgba(255,255,255,0.12), -6px 0 20px rgba(255,255,255,0.04)',
        duration: 0.08,
        ease: 'power2.out',
      }, '-=0.22');
      tl.to(titleInnerRef.current, {
        textShadow: '0 0 12px rgba(255,255,255,0.15), 0 0 28px rgba(255,255,255,0.05)',
        duration: 0.08,
        ease: 'none',
      });
      tl.to(titleInnerRef.current, {
        textShadow: '2px 0 10px rgba(255,255,255,0.12), 6px 0 20px rgba(255,255,255,0.04)',
        duration: 0.08,
        ease: 'power2.in',
      });
      tl.to(lightSweepRef.current, {
        opacity: 0,
        duration: 0.1,
        ease: 'power2.in',
      });
      tl.to(titleInnerRef.current, {
        textShadow: '0 1px 6px rgba(255,255,255,0.06), 0 2px 14px rgba(255,255,255,0.03)',
        duration: 0.12,
        ease: 'power2.out',
      }, '-=0.04');

      // ═══════════════════════════════════════
      // Phase 5: Breathe — 呼吸
      // ═══════════════════════════════════════
      tl.to({}, { duration: 0.15 });

      // Logo 环光呼吸
      tl.to(logoWrapRef.current, {
        boxShadow: '0 0 90px rgba(255,255,255,0.12), 0 0 180px rgba(255,255,255,0.05)',
        duration: 0.4,
        ease: 'sine.inOut',
      });
      tl.to(logoWrapRef.current, {
        boxShadow: '0 0 60px rgba(255,255,255,0.08), 0 0 120px rgba(255,255,255,0.03)',
        duration: 0.4,
        ease: 'sine.inOut',
      });

      // 标题投影微呼吸
      tl.to(titleInnerRef.current, {
        textShadow: '0 -1px 8px rgba(255,255,255,0.08), 0 -2px 16px rgba(255,255,255,0.03)',
        duration: 0.4,
        ease: 'sine.inOut',
      }, '-=0.75');
      tl.to(titleInnerRef.current, {
        textShadow: '0 1px 6px rgba(255,255,255,0.06), 0 2px 14px rgba(255,255,255,0.03)',
        duration: 0.4,
        ease: 'sine.inOut',
      });

      // 中心微光呼吸
      tl.to(coreLightRef.current, {
        opacity: 0.4,
        scale: 0.6,
        duration: 0.4,
        ease: 'sine.inOut',
      }, '-=0.75');
      tl.to(coreLightRef.current, {
        opacity: 0.25,
        scale: 0.45,
        duration: 0.4,
        ease: 'sine.inOut',
      });

      // ═══════════════════════════════════════
      // Phase 6: Exit — 消散
      // ═══════════════════════════════════════
      tl.to({}, { duration: 0.1 });

      tl.to(cosmicParticles, {
        opacity: 0,
        duration: 0.2,
        ease: 'power2.in',
      });
    });

    return () => ctx.revert();
  }, [onComplete]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] select-none overflow-hidden flex items-center justify-center bg-black rounded-[16px]"
      style={{ background: '#000000', opacity: 1 }}
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
