/**
 * Mascot — Three.js 吉祥物
 *
 * 一个柔和明暗过渡的圆球，会自然眨眼，眼睛跟随鼠标方向，
 * 鼠标悬浮在球体上时整体高亮。
 *
 * 用法：放进任意有尺寸的容器即可（组件会铺满父级）。
 *   <div style={{ width: 480, height: 480 }}>
 *     <Mascot />
 *   </div>
 */
import { useEffect, useRef } from 'react';
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
  Clock,
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

export default function Mascot() {
  const containerRef = useRef<HTMLDivElement>(null);

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

    /* ── 渲染循环 ── */
    const clock = new Clock();
    let raf = 0;

    const render = () => {
      raf = requestAnimationFrame(render);
      const dt = clock.getDelta();
      const t = clock.elapsedTime;

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
      const targetScale = hovering ? 1.04 : 1;
      const s = MathUtils.lerp(head.scale.x, targetScale, 0.1);
      head.scale.setScalar(s);

      // dt 当前仅用于触发时钟前进，避免 lint 未使用告警
      void dt;

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
