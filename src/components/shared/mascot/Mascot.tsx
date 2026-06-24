/**
 * Mascot — Three.js 吉祥物
 *
 * 一个柔和明暗过渡的圆球，会自然眨眼，眼睛跟随鼠标方向，
 * 鼠标悬浮在球体上时整体高亮。
 *
 * 请求模型时（loading=true）整体淡出、缩小，自然过渡为「LOADING」文字碎裂动画；
 * 完成后再平滑还原为圆球。
 *
 * 用法：放进任意有尺寸的容器即可（组件会铺满父级）。
 *   <div style={{ width: 480, height: 480 }}>
 *     <Mascot loading={isLoading} />
 *   </div>
 */
import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { createLoadingText, type LoadingText } from './loadingText';
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  HemisphereLight,
  DirectionalLight,
  AmbientLight,
  Group,
  MeshStandardMaterial,
  Color,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  DoubleSide,
  ShapeGeometry,
  Shape,
  Vector2,
  Raycaster,
  MathUtils,
  Timer,
} from 'three';

/* ── 可调参数 ── */
const SPHERE_RADIUS = 1;
const EYE_MAX_ANGLE = 0.42; // 眼睛跟随鼠标的最大偏转（弧度）
const HEAD_MAX_ANGLE = 0.12; // 头部跟随鼠标的轻微转动
const FOLLOW_LERP = 0.12; // 跟随平滑系数
const BLINK_MIN = 2.2; // 两次眨眼最小间隔（秒）
const BLINK_MAX = 5.5; // 两次眨眼最大间隔（秒）
const BLINK_DURATION = 0.13; // 单次眨眼时长（秒）

/** 生成竖直胶囊（圆角矩形）形状，用作眼睛 */
function makeEyeShape(width: number, height: number): Shape {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(w, h * 0.6);
  const shape = new Shape();
  shape.moveTo(-w, -h + r);
  shape.lineTo(-w, h - r);
  shape.quadraticCurveTo(-w, h, -w + r, h);
  shape.lineTo(w - r, h);
  shape.quadraticCurveTo(w, h, w, h - r);
  shape.lineTo(w, -h + r);
  shape.quadraticCurveTo(w, -h, w - r, -h);
  shape.lineTo(-w + r, -h);
  shape.quadraticCurveTo(-w, -h, -w, -h + r);
  return shape;
}

interface MascotProps {
  /** 请求模型中 → 切换为 LOADING 碎裂动画 */
  loading?: boolean;
}

export default function Mascot({ loading = false }: MascotProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 把最新 loading 放进 ref，供常驻渲染循环读取（避免重建场景）
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    /* ── 场景 / 相机 / 渲染器 ── */
    const scene = new Scene();

    const camera = new PerspectiveCamera(35, width / height, 0.1, 100);
    camera.position.set(0, 0, 5);

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    /* ── 灯光：半球光给出柔和的上亮下暗过渡，方向光给出高光 ── */
    const hemiLight = new HemisphereLight(0xffffff, 0x202028, 1.05);
    scene.add(hemiLight);

    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-1.4, 2.2, 2.5);
    scene.add(keyLight);

    const ambient = new AmbientLight(0xffffff, 0.18);
    scene.add(ambient);

    /* ── 头部组（整体可轻微转动）── */
    const head = new Group();
    scene.add(head);

    /* ── 球体：哑光白，roughness 高，得到平滑明暗过渡 ── */
    const sphereMat = new MeshStandardMaterial({
      color: 0xe9eaee,
      roughness: 0.62,
      metalness: 0.0,
      emissive: new Color(0x8a93ff),
      emissiveIntensity: 0, // 悬浮时提升
      transparent: true, // 切换 LOADING 时淡出
    });
    const sphere = new Mesh(
      new SphereGeometry(SPHERE_RADIUS, 96, 96),
      sphereMat,
    );
    head.add(sphere);

    /* ── 眼睛组：绕球心转动 → 眼睛在球面上滑动 = 看向鼠标 ── */
    const eyeGroup = new Group();
    head.add(eyeGroup);

    const eyeMat = new MeshBasicMaterial({
      color: 0x1a1a1f,
      side: DoubleSide,
      transparent: true,
    });
    const eyeGeo = new ShapeGeometry(makeEyeShape(0.16, 0.34));

    const eyes: Mesh[] = [];
    for (const sign of [-1, 1]) {
      const eye = new Mesh(eyeGeo, eyeMat);
      eye.position.set(sign * 0.22, 0.04, SPHERE_RADIUS * 1.01);
      eyeGroup.add(eye);
      eyes.push(eye);
    }

    /* ── 鼠标 / 悬浮状态 ──
     * 监听整个窗口：眼睛始终看向光标。look 为相对吉祥物中心的方向 [-1,1]，
     * 以半个窗口尺寸为参考归一化，光标越靠近屏幕边缘越接近最大眼动幅度。 */
    const look = new Vector2(0, 0); // 全局视线方向（目标）
    const localPointer = new Vector2(0, 0); // 画布内 NDC，仅用于悬浮检测
    let hovering = false;

    const raycaster = new Raycaster();

    const handlePointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();

      // 悬浮检测：光标在画布内才可能命中球体
      localPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      localPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(localPointer, camera);
      hovering = raycaster.intersectObject(sphere, false).length > 0;

      // 全局视线：相对吉祥物中心的方向，归一化并夹紧
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const refX = Math.max(window.innerWidth * 0.5, 1);
      const refY = Math.max(window.innerHeight * 0.5, 1);
      look.x = MathUtils.clamp((e.clientX - cx) / refX, -1, 1);
      look.y = MathUtils.clamp(-(e.clientY - cy) / refY, -1, 1);
    };
    const handleWindowLeave = () => {
      look.set(0, 0); // 光标离开窗口 → 视线回正
      hovering = false;
    };
    window.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerleave', handleWindowLeave);
    window.addEventListener('blur', handleWindowLeave);

    /* ── 眨眼调度 ── */
    let blink = 1; // 1 = 睁开, 0 = 闭合
    let nextBlinkAt = BLINK_MIN;
    let blinkStart = -1;

    const scheduleBlink = (now: number) => {
      nextBlinkAt = now + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
    };

    /* ── LOADING 形态状态 ── */
    let loadText: LoadingText | null = null;
    let creatingLoad = false;
    const loadObj = { val: 0 }; // 0 = 圆球, 1 = LOADING 碎裂，gsap 驱动缓动过渡
    let loadTween: gsap.core.Tween | null = null;
    let prevLoadTarget = 0;
    let hoverScale = 1;
    // gsap 时间线（与参考一致：4s easeInOut yoyo，progress 0→0.6，rotation 0→2π）
    let tl: gsap.core.Timeline | null = null;
    const anim = { progress: 0, ry: 0 };

    /* ── 渲染循环 ── */
    const clock = new Timer();
    let raf = 0;

    const render = () => {
      raf = requestAnimationFrame(render);
      clock.update(); // Timer 必须每帧 update，否则 getElapsed 恒为 0
      const t = clock.getElapsed();

      // 目标偏转：始终看向光标（look 已归一化并夹紧）
      const px = look.x;
      const py = look.y;

      eyeGroup.rotation.y = MathUtils.lerp(
        eyeGroup.rotation.y,
        px * EYE_MAX_ANGLE,
        FOLLOW_LERP,
      );
      eyeGroup.rotation.x = MathUtils.lerp(
        eyeGroup.rotation.x,
        -py * EYE_MAX_ANGLE,
        FOLLOW_LERP,
      );
      head.rotation.y = MathUtils.lerp(
        head.rotation.y,
        px * HEAD_MAX_ANGLE,
        FOLLOW_LERP,
      );
      head.rotation.x = MathUtils.lerp(
        head.rotation.x,
        -py * HEAD_MAX_ANGLE,
        FOLLOW_LERP,
      );

      // 轻微呼吸浮动
      head.position.y = Math.sin(t * 1.1) * 0.04;

      // 眨眼
      if (blinkStart < 0 && t >= nextBlinkAt) blinkStart = t;
      if (blinkStart >= 0) {
        const k = (t - blinkStart) / BLINK_DURATION; // 0→1→2
        blink = k < 1 ? 1 - k : Math.min(k - 1, 1); // 下闭上睁，三角波
        if (k >= 2) {
          blink = 1;
          blinkStart = -1;
          scheduleBlink(t);
        }
      }
      for (const eye of eyes) eye.scale.y = Math.max(blink, 0.06);

      // 悬浮高亮：球体发光 + 灯光增强，平滑过渡
      const targetEmissive = hovering ? 0.32 : 0;
      sphereMat.emissiveIntensity = MathUtils.lerp(
        sphereMat.emissiveIntensity,
        targetEmissive,
        0.1,
      );
      keyLight.intensity = MathUtils.lerp(
        keyLight.intensity,
        hovering ? 1.9 : 1.4,
        0.1,
      );
      hoverScale = MathUtils.lerp(hoverScale, hovering ? 1.04 : 1, 0.1);

      /* ── LOADING 形态：圆球 ⇄ 文字碎裂 平滑过渡 ── */
      const wantLoad = loadingRef.current;
      if (wantLoad && !loadText && !creatingLoad) {
        creatingLoad = true;
        createLoadingText()
          .then((lt) => {
            loadText = lt;
            lt.mesh.visible = false;
            scene.add(lt.mesh);
            // 参考时间线：progress 0→0.6 与 rotation 0→2π，4s easeInOut，yoyo 无限循环
            tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5, yoyo: true });
            tl.fromTo(anim, { progress: 0 }, { progress: 0.6, duration: 4, ease: 'power1.inOut' }, 0);
            tl.fromTo(anim, { ry: 0 }, { ry: Math.PI * 2, duration: 4, ease: 'power1.inOut' }, 0);
            creatingLoad = false;
          })
          .catch(() => { creatingLoad = false; });
      }
      // gsap 驱动 loadAmount 缓动过渡：进入 0.5s，退出 0.9s，节奏自然
      const loadTarget = wantLoad && loadText ? 1 : 0;
      if (loadTarget !== prevLoadTarget) {
        prevLoadTarget = loadTarget;
        loadTween?.kill();
        loadTween = gsap.to(loadObj, {
          val: loadTarget,
          duration: loadTarget === 1 ? 0.5 : 0.9,
          ease: loadTarget === 1 ? 'power3.inOut' : 'power2.out',
        });
      }
      const loadAmount = loadObj.val;

      // 头部随 loadAmount 淡出 + 缩小
      sphereMat.opacity = 1 - loadAmount;
      eyeMat.opacity = 1 - loadAmount;
      head.visible = loadAmount < 0.995;
      head.scale.setScalar(hoverScale * (1 - loadAmount * 0.5));

      // LOADING 网格：由 gsap 时间线驱动 uTime + 自转
      if (loadText) {
        const lt = loadText;
        const show = loadAmount > 0.002;
        lt.mesh.visible = show;
        lt.material.opacity = loadAmount;
        if (show) {
          tl?.play();
          lt.setUTime(lt.animationDuration * anim.progress);
          lt.mesh.rotation.y = anim.ry;
        } else {
          tl?.pause();
        }
      }

      renderer.render(scene, camera);
    };
    render();

    /* ── 尺寸响应 ── */
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    /* ── 清理 ── */
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handleWindowLeave);
      window.removeEventListener('blur', handleWindowLeave);
      sphere.geometry.dispose();
      sphereMat.dispose();
      eyeGeo.dispose();
      eyeMat.dispose();
      tl?.kill();
      loadTween?.kill();
      if (loadText) {
        scene.remove(loadText.mesh);
        loadText.dispose();
      }
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', cursor: 'pointer' }}
    />
  );
}
